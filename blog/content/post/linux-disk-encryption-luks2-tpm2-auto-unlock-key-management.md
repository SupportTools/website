---
title: "Linux Disk Encryption: LUKS2 with TPM2 Auto-Unlock and Key Management"
date: 2031-04-08T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Encryption", "LUKS2", "TPM2", "Key Management", "Cryptography"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to LUKS2 disk encryption with TPM2 auto-unlock, clevis/tang network-based unlocking, systemd-cryptenroll, key rotation procedures, and encrypted container image storage."
more_link: "yes"
url: "/linux-disk-encryption-luks2-tpm2-auto-unlock-key-management/"
---

Full disk encryption protects data at rest from physical theft, unauthorized hardware access, and cold boot attacks. LUKS2 with TPM2 binding enables automatic unlocking on trusted hardware—eliminating passphrase prompts while maintaining cryptographic security. This guide covers the complete implementation from initial setup through operational key management.

<!--more-->

# Linux Disk Encryption: LUKS2 with TPM2 Auto-Unlock and Key Management

## LUKS2 vs LUKS1 Header Format

LUKS (Linux Unified Key Setup) version 2 provides significant improvements over LUKS1:

- **JSON-based header**: Human-readable metadata, extensible without breaking compatibility
- **Multiple keyslots**: Up to 32 keyslots (LUKS1 had 8)
- **Keyslot types**: Password, keyfile, FIDO2, TPM2, PKCS11
- **Stronger KDFs**: Argon2id with memory hardening (LUKS1 only supported PBKDF2)
- **Integrity protection**: Optional dm-integrity for authenticated encryption
- **Forward-secure unlocking**: Each keyslot can have independent KDF parameters
- **Online reencryption**: Change encryption without unmounting (kernel 5.11+)

## Section 1: Initial LUKS2 Setup

### Preparing a Device for Encryption

```bash
# Check device before formatting
lsblk /dev/sdb
# NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
# sdb      8:16   0  500G  0 disk

# Securely wipe the device before encryption
# (Optional but recommended for new deployments - reveals less metadata)
# For SSDs, use blkdiscard instead (faster, respects TRIM)
sudo blkdiscard /dev/sdb
# For HDDs:
# sudo dd if=/dev/urandom of=/dev/sdb bs=1M status=progress

# Install required tools
sudo apt-get install -y cryptsetup cryptsetup-initramfs tpm2-tools \
  clevis clevis-luks clevis-tpm2 clevis-systemd
```

### Creating a LUKS2 Volume with Argon2id

```bash
# Format with LUKS2 using Argon2id KDF
# Argon2id parameters: memory-cost, time-cost, parallel (threads)
# Production parameters (adjust based on hardware benchmarks):
sudo cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha256 \
  --pbkdf argon2id \
  --pbkdf-memory 524288 \    # 512 MB of memory
  --pbkdf-time 4000 \        # 4 seconds target
  --pbkdf-parallel 4 \       # 4 threads
  --sector-size 512 \
  --label data-encrypted \
  --batch-mode \
  /dev/sdb

# When prompted, enter the initial passphrase
# This goes into keyslot 0 (the "fallback" passphrase)

# Verify the LUKS2 header
sudo cryptsetup luksDump /dev/sdb
```

Expected output excerpt:
```
LUKS header information
Version:        2
Epoch:          4
Metadata area:  16384 [bytes]
Keyslots area:  16744448 [bytes]
UUID:           a1b2c3d4-e5f6-7890-abcd-ef1234567890
Label:          data-encrypted
Subsystem:      (no subsystem)
Flags:          (no flags)

Data segments:
  0: crypt
        offset: 16777216 [bytes]
        length: (whole device)
        cipher: aes-xts-plain64
        sector: 512 [bytes]

Keyslots:
  0: luks2
        Key:        512 bits
        Priority:   normal
        Cipher:     aes-xts-plain64-sha256
        PBKDF:      argon2id
        Time cost:  4
        Memory:     524288
        Threads:    4
        Salt:       <hex>
        AF stripes: 4000
        AF hash:    sha256
        Area offset:32768 [bytes]
```

### Opening and Using the Encrypted Volume

```bash
# Open (unlock) the device
sudo cryptsetup luksOpen /dev/sdb data-encrypted
# Creates /dev/mapper/data-encrypted

# Create filesystem on the unlocked device
sudo mkfs.ext4 -L data-volume /dev/mapper/data-encrypted

# Mount
sudo mkdir -p /mnt/data
sudo mount /dev/mapper/data-encrypted /mnt/data

# Verify encryption is in use
sudo dmsetup status data-encrypted
# data-encrypted: 0 976773168 crypt aes-xts-plain64 sha256 0 0 /dev/sdb 32768 no_read_workqueue no_write_workqueue
```

### Configuring /etc/crypttab and /etc/fstab

```bash
# /etc/crypttab - tells systemd how to unlock the device at boot
# Format: <name> <source device> <key file> <options>
echo "data-encrypted UUID=$(sudo cryptsetup luksUUID /dev/sdb) none luks,discard" | \
  sudo tee -a /etc/crypttab

# /etc/fstab
echo "/dev/mapper/data-encrypted /mnt/data ext4 defaults,nofail 0 2" | \
  sudo tee -a /etc/fstab
```

## Section 2: TPM2 Auto-Unlock with systemd-cryptenroll

### Understanding TPM2 PCRs

TPM2 Platform Configuration Registers (PCRs) store measurements of the boot process:

| PCR | Contents |
|-----|---------|
| 0 | SRTM (BIOS/UEFI firmware) |
| 1 | BIOS/UEFI configuration |
| 2 | Option ROMs |
| 4 | Boot loader |
| 5 | Boot loader configuration |
| 7 | Secure Boot state |
| 9 | Bootloader kernel image |
| 11 | systemd-measured-boot: boot parameters |
| 12 | systemd-measured-boot: kernel command line |
| 15 | systemd-measured-boot: root filesystem hash |

Binding a LUKS2 keyslot to specific PCRs means the disk can only be unlocked when those PCRs match the expected values (i.e., the system booted with the expected software).

### Enrolling TPM2 with systemd-cryptenroll

```bash
# Check TPM2 is available
ls /dev/tpm* /dev/tpmrm*
# /dev/tpm0  /dev/tpmrm0

# Check TPM2 PCR values
sudo tpm2_pcrread sha256:0,1,2,4,5,7,9,11,12

# Enroll TPM2 key - bind to PCRs for firmware (0), secure boot (7), and kernel (9)
# Adjust PCR selection based on your threat model
sudo systemd-cryptenroll \
  --tpm2-device=auto \
  --tpm2-pcrs=0+7+9 \
  /dev/sdb

# When prompted, enter existing LUKS passphrase to authorize enrollment
# This adds a new keyslot bound to TPM2
sudo cryptsetup luksDump /dev/sdb | grep -A20 "Keyslots:"
# Now shows keyslot 0 (passphrase) and keyslot 1 (TPM2)
```

### Configuring /etc/crypttab for TPM2 Unlocking

```bash
# Update crypttab to try TPM2 unlock before prompting for passphrase
sudo sed -i 's/data-encrypted UUID=.* none luks,discard/data-encrypted UUID=$(sudo cryptsetup luksUUID \/dev\/sdb) none luks,tpm2-device=auto,discard/' /etc/crypttab

# Proper entry:
# data-encrypted UUID=<uuid> - luks,tpm2-device=auto,discard

# Update initramfs to include TPM2 tools
sudo update-initramfs -u -k all

# Test TPM2 unlock (without passphrase prompt)
# Reboot and verify it unlocks automatically
```

### TPM2 Policy with PIN Protection

For additional security, combine TPM2 with a PIN (something you know + something the hardware has):

```bash
# Enroll with TPM2 + PIN
sudo systemd-cryptenroll \
  --tpm2-device=auto \
  --tpm2-pcrs=0+7+9 \
  --tpm2-with-pin=yes \
  /dev/sdb

# User must enter PIN at boot, but it's validated by the TPM
# (different from a passphrase: the PIN is bound to the TPM chip)
```

### Handling PCR Changes After System Updates

When the bootloader or kernel is updated, PCR values change and the TPM2 keyslot becomes invalid:

```bash
# Before updating GRUB or kernel:
# 1. Check current PCR values
sudo tpm2_pcrread sha256:0,7,9

# 2. Predict new PCR values (complex - use systemd-measure for PCR 11+)
sudo systemd-measure calculate \
  --linux=/boot/vmlinuz-new \
  --initrd=/boot/initrd.img-new \
  --pcrs=11+12

# Option A: Re-enroll before rebooting
sudo systemd-cryptenroll \
  --tpm2-device=auto \
  --tpm2-pcrs=0+7+9 \
  --wipe-slot=tpm2 \  # Remove old TPM2 slot first
  /dev/sdb

# Option B: Use predictive PCR (requires systemd 252+)
# Bind to systemd's measured boot PCRs that are updated before reboot
sudo systemd-cryptenroll \
  --tpm2-device=auto \
  --tpm2-pcrs=7+11+12 \
  /dev/sdb

# For systems using GRUB + Secure Boot:
# PCR 7 is stable across kernel updates
# PCR 11 covers the kernel image measurements (updated by bootctl)
```

## Section 3: Clevis and Tang for Network-Based Auto-Unlock

### Tang Architecture

Tang is a server that holds key material. Clevis is the client-side tool that pins a LUKS2 keyslot to a Tang server response. Unlike TPM2, Tang-based unlocking works on VMs and cloud instances without hardware TPMs.

The unlocking protocol uses McEliece / ECIES-style key agreement:
1. At enrollment time, the client generates a key exchange and stores the server's public key in the LUKS2 header
2. At unlock time, the client performs a key exchange with the Tang server
3. The Tang server never sees the actual disk key; the key is derived from the exchange

```bash
# Install Tang server (on a dedicated server, not the encrypted host)
sudo apt-get install -y tang

# Enable and start Tang
sudo systemctl enable --now tangd.socket

# Get Tang server's advertised key thumbprint (needed for client enrollment)
sudo tang-show-keys
# Or:
curl -s http://tang-server.example.com/adv | jose fmt --json=- -g keys -A
```

### Client-Side Clevis Enrollment

```bash
# Install clevis client on the machine being encrypted
sudo apt-get install -y clevis clevis-luks clevis-systemd clevis-tpm2

# Enroll LUKS device with Tang binding
# The 'url' is your Tang server, 'adv' is the thumbprint for server verification
sudo clevis luks bind \
  -d /dev/sdb \
  tang \
  '{"url": "http://tang-server.example.com", "adv": "<tang-thumbprint>"}'

# Enter existing LUKS passphrase when prompted

# Verify the binding
sudo clevis luks list -d /dev/sdb
# 1: tang '{"url":"http://tang-server.example.com","adv":{...}}'

# Test unlock (requires Tang server to be reachable)
sudo clevis luks unlock -d /dev/sdb
```

### High Availability Tang Setup

```bash
# Install Tang on multiple servers for HA
# Client can bind to multiple Tang servers using 'sss' (Shamir's Secret Sharing)

# Bind to 2-of-3 Tang servers (unlock requires any 2 servers to respond)
sudo clevis luks bind \
  -d /dev/sdb \
  sss \
  '{
    "t": 2,
    "pins": {
      "tang": [
        {"url": "http://tang1.example.com", "adv": "<thumbprint1>"},
        {"url": "http://tang2.example.com", "adv": "<thumbprint2>"},
        {"url": "http://tang3.example.com", "adv": "<thumbprint3>"}
      ]
    }
  }'

# Combining Tang with TPM2 (both must succeed)
sudo clevis luks bind \
  -d /dev/sdb \
  sss \
  '{
    "t": 2,
    "pins": {
      "tang": {"url": "http://tang1.example.com", "adv": "<thumbprint>"},
      "tpm2": {"pcr_bank": "sha256", "pcr_ids": "7,9"}
    }
  }'
```

### Configuring Clevis for Boot-Time Unlock

```bash
# Update initramfs to include clevis
sudo dracut -f -v  # On RHEL/Fedora
# or
sudo update-initramfs -u -k all  # On Debian/Ubuntu

# Update /etc/crypttab to use clevis
# Add '_netdev' to ensure Tang server is reachable before unlock attempt
sudo sed -i 's/data-encrypted UUID=.*/data-encrypted UUID=<uuid> none luks,_netdev,discard/' \
  /etc/crypttab

# Enable clevis unlock services
sudo systemctl enable clevis-luks-askpass.path

# Verify at next boot (check journal for clevis messages)
# journalctl -b -u systemd-cryptsetup@data-encrypted
```

## Section 4: Key Management and Rotation

### Understanding LUKS2 Keyslots

LUKS2 supports multiple keyslots independently. Each keyslot contains a different key that unlocks the same master encryption key (MEK):

```
LUKS2 Device
├── Master Encryption Key (MEK) - stored encrypted
├── Keyslot 0: Passphrase (admin recovery)
├── Keyslot 1: TPM2 binding (auto-unlock)
├── Keyslot 2: Tang binding (network unlock)
└── Keyslot 3: Backup passphrase (escrow)
```

### Adding and Removing Keyslots

```bash
# List all keyslots
sudo cryptsetup luksDump /dev/sdb | grep "Keyslots:" -A 50

# Add a new passphrase (for admin access)
sudo cryptsetup luksAddKey \
  --key-slot 3 \
  --pbkdf argon2id \
  --pbkdf-memory 524288 \
  /dev/sdb

# Remove a compromised passphrase
sudo cryptsetup luksKillSlot /dev/sdb 0
# Requires authentication with another valid keyslot

# Remove the TPM2 enrollment (e.g., before hardware decommission)
sudo systemd-cryptenroll --wipe-slot=tpm2 /dev/sdb

# Remove a clevis Tang binding
sudo clevis luks unbind -d /dev/sdb -s 2

# Change passphrase in an existing keyslot
sudo cryptsetup luksChangeKey /dev/sdb
```

### Backup Keyslot for Escrow

```bash
#!/bin/bash
# create-recovery-key.sh

DEVICE="${1}"
if [ -z "${DEVICE}" ]; then
    echo "Usage: $0 <device>"
    exit 1
fi

# Generate a strong random recovery key
RECOVERY_KEY=$(openssl rand -base64 48)

# Add as a new keyslot
echo -n "${RECOVERY_KEY}" | sudo cryptsetup luksAddKey \
  --key-slot 3 \
  --batch-mode \
  --pbkdf argon2id \
  --pbkdf-memory 131072 \
  "${DEVICE}" \
  -

# Store securely - in practice, use Vault, AWS Secrets Manager, etc.
HOSTNAME=$(hostname -f)
DEVICE_UUID=$(sudo cryptsetup luksUUID "${DEVICE}")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Recovery key created:"
echo "  Host:       ${HOSTNAME}"
echo "  Device:     ${DEVICE}"
echo "  UUID:       ${DEVICE_UUID}"
echo "  Created:    ${TIMESTAMP}"
echo "  Key (store securely):"
echo "  ${RECOVERY_KEY}"

# In production: store in Vault
# vault kv put secret/recovery/${HOSTNAME}/${DEVICE_UUID} \
#   key="${RECOVERY_KEY}" \
#   created_at="${TIMESTAMP}" \
#   hostname="${HOSTNAME}"
```

### Key Rotation Procedure

Rotating the master encryption key requires re-encryption:

```bash
# Online re-encryption (kernel 5.11+, no unmounting required)
# This changes the MEK while the filesystem remains mounted

# Step 1: Verify no other re-encryption is in progress
sudo cryptsetup luksDump /dev/sdb | grep "Requirements:"

# Step 2: Start re-encryption (will run in background)
sudo cryptsetup reencrypt \
  --encrypt \
  --resilience checksum \
  /dev/sdb

# Monitor progress
watch -n5 "sudo cryptsetup luksDump /dev/sdb | grep 'Reencrypt'"

# Step 3: After re-encryption, re-enroll all keyslots
# (TPM2 and Tang bindings become invalid after MEK rotation)
sudo systemd-cryptenroll --wipe-slot=tpm2 /dev/sdb
sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=0+7+9 /dev/sdb

sudo clevis luks unbind -d /dev/sdb -s 2
sudo clevis luks bind -d /dev/sdb tang '{"url": "...", "adv": "..."}'
```

### Passphrase Rotation

When rotating the admin recovery passphrase:

```bash
#!/bin/bash
# rotate-luks-passphrase.sh

DEVICE="${1}"
CURRENT_SLOT=0
NEW_SLOT=4  # Temporary slot during rotation

# Add new passphrase to a temporary slot
echo "Enter NEW passphrase for slot ${NEW_SLOT}:"
sudo cryptsetup luksAddKey --key-slot ${NEW_SLOT} "${DEVICE}"

# Remove old passphrase (this asks for any valid key to authenticate)
sudo cryptsetup luksKillSlot "${DEVICE}" ${CURRENT_SLOT}

# Rename the temporary slot to the original position
# (cryptsetup doesn't support renaming; re-add at slot 0)
echo "Re-enter NEW passphrase to move to slot ${CURRENT_SLOT}:"
sudo cryptsetup luksAddKey --key-slot ${CURRENT_SLOT} "${DEVICE}"
sudo cryptsetup luksKillSlot "${DEVICE}" ${NEW_SLOT}

echo "Passphrase rotation complete"
sudo cryptsetup luksDump "${DEVICE}" | grep "Keyslots:" -A 20
```

## Section 5: Header Backup and Disaster Recovery

```bash
# CRITICAL: Backup the LUKS2 header
# If the header is corrupted, all data is permanently lost
sudo cryptsetup luksHeaderBackup \
  /dev/sdb \
  --header-backup-file /secure/backup/sdb-luks-header.bin

# Verify the backup
sudo cryptsetup luksDump --header /secure/backup/sdb-luks-header.bin

# Store in multiple locations:
# - Offline encrypted USB drive
# - Vault KV store
# - S3 with server-side encryption

# Restore header from backup (if device header is corrupted)
sudo cryptsetup luksHeaderRestore \
  /dev/sdb \
  --header-backup-file /secure/backup/sdb-luks-header.bin
```

## Section 6: Encrypted Container Image Storage

Container runtimes store images on disk. For high-security environments, the underlying storage should be encrypted.

### containerd with Encrypted Storage

```bash
# Option A: LUKS2 encrypted partition for containerd root
# Create encrypted device
sudo cryptsetup luksFormat \
  --type luks2 \
  --pbkdf argon2id \
  /dev/sdc

sudo cryptsetup luksOpen /dev/sdc containerd-storage
sudo mkfs.xfs /dev/mapper/containerd-storage

# Mount at containerd's root
sudo mkdir -p /var/lib/containerd
sudo mount /dev/mapper/containerd-storage /var/lib/containerd

# Add to /etc/crypttab
echo "containerd-storage UUID=$(sudo cryptsetup luksUUID /dev/sdc) none luks,tpm2-device=auto,discard" | \
  sudo tee -a /etc/crypttab

# Add to /etc/fstab
echo "/dev/mapper/containerd-storage /var/lib/containerd xfs defaults,nofail 0 2" | \
  sudo tee -a /etc/fstab
```

### dm-crypt Transparent Encryption for Kubernetes Node

For Kubernetes nodes, encrypt the data partition used by kubelet:

```bash
# Encrypted kubelet data directory
sudo cryptsetup luksFormat --type luks2 /dev/sdd
sudo cryptsetup luksOpen /dev/sdd kubelet-data
sudo mkfs.xfs /dev/mapper/kubelet-data
sudo mount /dev/mapper/kubelet-data /var/lib/kubelet

# Encrypt etcd data (for control plane nodes)
sudo cryptsetup luksFormat --type luks2 /dev/sde
sudo cryptsetup luksOpen /dev/sde etcd-data
sudo mkfs.xfs /dev/mapper/etcd-data
sudo mount /dev/mapper/etcd-data /var/lib/etcd
```

### Verifying Encryption at Rest (Compliance Check)

```bash
#!/bin/bash
# check-encryption-compliance.sh
# Verify all relevant devices are encrypted

REQUIRED_ENCRYPTED_MOUNTS=("/var/lib/containerd" "/var/lib/kubelet" "/var/lib/etcd" "/mnt/data")

PASS=true

for mount in "${REQUIRED_ENCRYPTED_MOUNTS[@]}"; do
    # Find the device backing this mount
    DEVICE=$(df -P "${mount}" 2>/dev/null | tail -1 | awk '{print $1}')
    if [ -z "${DEVICE}" ]; then
        echo "WARN: ${mount} is not mounted"
        continue
    fi

    # Check if it's a dm-crypt device
    DM_NAME=$(basename "${DEVICE}")
    if dmsetup info "${DM_NAME}" 2>/dev/null | grep -q "cipher"; then
        echo "OK: ${mount} backed by encrypted device ${DEVICE}"
    else
        # Check if the physical device is LUKS
        PHYS_DEVICE=$(lsblk -no pkname "${DEVICE}" | head -1)
        if sudo cryptsetup isLuks "/dev/${PHYS_DEVICE}" 2>/dev/null; then
            echo "OK: ${mount} on LUKS device /dev/${PHYS_DEVICE}"
        else
            echo "FAIL: ${mount} is NOT encrypted (device: ${DEVICE})"
            PASS=false
        fi
    fi
done

if ${PASS}; then
    echo "COMPLIANCE: All required mounts are encrypted"
    exit 0
else
    echo "COMPLIANCE FAILURE: Some mounts are not encrypted"
    exit 1
fi
```

## Section 7: Monitoring and Alerting

### systemd Watchdog for cryptsetup Services

```bash
# Monitor whether encrypted devices are properly mounted
# /etc/systemd/system/check-encrypted-mounts.service

[Unit]
Description=Check encrypted mount availability
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/check-encryption-compliance.sh
StandardOutput=journal
SyslogIdentifier=encryption-check

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/systemd/system/check-encrypted-mounts.timer
[Unit]
Description=Periodically check encrypted mounts

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target
```

### Prometheus Metrics for Encryption Status

```bash
# Node exporter textfile collector approach
cat > /etc/cron.d/encryption-metrics <<'EOF'
*/5 * * * * root /usr/local/bin/collect-encryption-metrics.sh > \
  /var/lib/node_exporter/textfile_collector/encryption.prom.tmp && \
  mv /var/lib/node_exporter/textfile_collector/encryption.prom.tmp \
     /var/lib/node_exporter/textfile_collector/encryption.prom
EOF

cat > /usr/local/bin/collect-encryption-metrics.sh <<'SCRIPT'
#!/bin/bash
echo "# HELP node_luks_device_status LUKS device status (1=open, 0=closed)"
echo "# TYPE node_luks_device_status gauge"

while IFS= read -r line; do
    NAME=$(echo "${line}" | awk '{print $1}')
    STATUS=$(dmsetup info "${NAME}" 2>/dev/null | grep "State:" | awk '{print $2}')
    if [ "${STATUS}" = "ACTIVE" ]; then
        echo "node_luks_device_status{device=\"${NAME}\"} 1"
    else
        echo "node_luks_device_status{device=\"${NAME}\"} 0"
    fi
done < <(dmsetup ls --target crypt 2>/dev/null | grep -v "No devices found")

# TPM2 health
if tpm2_getcap properties-fixed 2>/dev/null | grep -q "TPM2_PT_MANUFACTURER"; then
    echo "node_tpm2_available 1"
else
    echo "node_tpm2_available 0"
fi
SCRIPT
chmod +x /usr/local/bin/collect-encryption-metrics.sh
```

## Section 8: Security Hardening Considerations

### Protection Against Evil Maid Attacks

An evil maid attack involves someone with physical access modifying the bootloader to capture the encryption key. Mitigations:

1. **Secure Boot**: Prevent unsigned bootloaders from running
2. **Measured Boot**: PCR values change if the bootloader is tampered with
3. **TPM2 PCR 7 binding**: Includes Secure Boot state
4. **Anti-tamper seal**: Physical seal to detect hardware access

```bash
# Verify Secure Boot is enabled
mokutil --sb-state
# SecureBoot enabled

# Verify PCR 7 value matches expected Secure Boot state
sudo tpm2_pcrread sha256:7
```

### Wiping Encryption Keys on Disk Failure/Decommission

```bash
# Securely erase LUKS header and key material before hardware disposal
# This makes all encrypted data permanently irrecoverable

# Method 1: LUKS header erase (fast, cryptographic erasure)
sudo cryptsetup erase /dev/sdb
# Overwrites all keyslots - no key can open the device

# Method 2: Full overwrite (for compliance with certain standards)
sudo shred -vfz -n 3 /dev/sdb

# Method 3: SSD/NVMe secure erase
sudo nvme format /dev/nvme0n1 --ses=1  # Cryptographic erase
```

## Conclusion

LUKS2 with TPM2 binding delivers a production-ready full disk encryption solution that combines strong cryptography with operational convenience: automatic unlocking on trusted hardware, network-based unlocking via Tang/clevis for virtual machines, multiple independent keyslots for different access scenarios, and online re-encryption for key rotation without downtime. The key operational disciplines are maintaining offline header backups, documenting keyslot assignments, scripting TPM2 re-enrollment after kernel updates, and implementing compliance checks that alert when encrypted mounts become unavailable. Combined with Secure Boot and measured boot policies, this stack provides defense-in-depth against physical access threats.
