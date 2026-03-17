---
title: "Linux Block Device Encryption: LUKS2 with Argon2id, TPM2 Binding, Clevis/Tang Network Unlock, dm-integrity"
date: 2031-12-03T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "LUKS", "Encryption", "TPM2", "Clevis", "Tang", "dm-crypt", "Block Device"]
categories:
- Linux
- Security
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux block device encryption with LUKS2: Argon2id key derivation, TPM2 binding for secure automated unlock, Clevis/Tang network-based unlock for server farms, and dm-integrity for tamper detection."
more_link: "yes"
url: "/linux-block-device-encryption-luks2-tpm2-clevis-tang-guide/"
---

Linux block device encryption via LUKS2 (Linux Unified Key Setup version 2) has matured into an enterprise-grade solution for data at rest protection. Combined with TPM2 binding for local automated unlock and Clevis/Tang for network-based unlock at scale, it eliminates the traditional trade-off between security and operational convenience. This guide covers the complete stack: LUKS2 format and Argon2id hardening, TPM2 binding with PCR policies, Tang server deployment for server-farm unlock, and dm-integrity for block-level tamper detection.

<!--more-->

# Linux Block Device Encryption: LUKS2, TPM2, and Clevis/Tang

## Architecture Overview

```
Data at Rest Encryption Stack
──────────────────────────────
Application
    |
Filesystem (ext4, XFS, btrfs)
    |
dm-crypt (device mapper encryption layer)
    |
LUKS2 header (key slots, PBKDF config)
    |
Physical block device

Unlock Mechanisms:
├── Interactive passphrase (always available)
├── TPM2 binding (automatic on trusted hardware)
└── Clevis/Tang (automatic via network key server)
```

## Section 1: LUKS2 Format and Configuration

### Why LUKS2 Over LUKS1

LUKS2 improvements over LUKS1:

| Feature | LUKS1 | LUKS2 |
|---------|-------|-------|
| Header size | 592 bytes | 4 MB (resilient) |
| PBKDF | PBKDF2 only | Argon2i, Argon2id, PBKDF2 |
| Key slots | 8 | 32 |
| Header backup | Manual | Automatic secondary header |
| Authenticated encryption | No | Yes (with dm-integrity) |
| Detached header | Limited | Full support |
| Subsystem (metadata) | No | Yes (custom metadata per slot) |

### Creating a LUKS2 Volume with Argon2id

```bash
# Check cryptsetup version (2.1+ for Argon2id support)
cryptsetup --version

# Format with LUKS2 and Argon2id PBKDF
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \           # 512-bit key for XTS mode (2×256-bit)
  --hash sha512 \
  --pbkdf argon2id \
  --pbkdf-memory 1048576 \   # 1GB memory cost
  --pbkdf-parallel 4 \       # 4 parallel threads
  --pbkdf-time 5000 \        # Target 5000ms key derivation time
  --iter-time 5000 \
  --label "data-volume" \
  /dev/sdb

# Verify LUKS2 header
cryptsetup luksDump /dev/sdb
```

Expected output from `luksDump`:

```
LUKS header information
Version:        2
Epoch:          3
Metadata area:  16384 [bytes]
Keyslots area:  16744448 [bytes]
UUID:           a1b2c3d4-e5f6-7890-abcd-ef1234567890
Label:          data-volume
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
        Cipher:     aes-xts-plain64
        Cipher key: 512 bits
        PBKDF:      argon2id
        Hash:       sha512
        Iterations: 4
        Memory:     1048576
        Threads:    4
        Salt:       ab cd ef 01 23 45 67 89 ...
```

### Argon2id Parameter Selection

Argon2id combines Argon2i (data-independent memory access for side-channel resistance) and Argon2d (data-dependent memory access for GPU resistance). The parameters define the work factor:

```
Cost = time × memory × parallelism

For interactive unlocks (boot password prompt):
  --pbkdf-memory 1048576  (1GB) — GPUs can't fit this
  --pbkdf-parallel 4
  --pbkdf-time 2000       (2s) — acceptable boot delay

For offline storage (encrypted backups):
  --pbkdf-memory 4194304  (4GB) — extremely resistant
  --pbkdf-parallel 8
  --pbkdf-time 10000      (10s) — used infrequently
```

### Key Slot Management

```bash
# Add a second passphrase (backup)
cryptsetup luksAddKey /dev/sdb

# Add a key file (for scripts/automated systems)
# IMPORTANT: store the keyfile securely (it decrypts the volume directly)
dd if=/dev/urandom bs=512 count=4 > /etc/luks/data-volume.key
chmod 400 /etc/luks/data-volume.key
cryptsetup luksAddKey /dev/sdb /etc/luks/data-volume.key

# List key slots
cryptsetup luksDump /dev/sdb | grep "^Keyslots" -A50

# Remove a key slot (requires another slot's credentials to proceed)
cryptsetup luksKillSlot /dev/sdb 1   # Remove slot 1

# Kill all passphrases and set only one (when rotating)
cryptsetup luksChangeKey /dev/sdb    # Interactive passphrase change

# Backup LUKS header (CRITICAL — without this, data is unrecoverable if header corrupts)
cryptsetup luksHeaderBackup /dev/sdb \
  --header-backup-file /secure-backup/sdb-luks-header-$(date +%Y%m%d).bin
```

### Opening and Using Encrypted Volumes

```bash
# Open (maps to /dev/mapper/data_encrypted)
cryptsetup luksOpen /dev/sdb data_encrypted

# Or with keyfile
cryptsetup luksOpen /dev/sdb data_encrypted \
  --key-file /etc/luks/data-volume.key

# Format the decrypted device
mkfs.xfs /dev/mapper/data_encrypted

# Mount
mount /dev/mapper/data_encrypted /mnt/data

# Close when done
umount /mnt/data
cryptsetup luksClose data_encrypted

# /etc/crypttab for boot-time automated unlock with keyfile
# Format: <name> <device/UUID> <keyfile> <options>
echo "data_encrypted UUID=$(blkid -s UUID -o value /dev/sdb) /etc/luks/data-volume.key luks,_netdev" >> /etc/crypttab

# /etc/fstab
echo "/dev/mapper/data_encrypted /mnt/data xfs defaults,nofail,_netdev,x-systemd.requires=cryptsetup.target 0 0" >> /etc/fstab

# Update initramfs
update-initramfs -u   # Debian/Ubuntu
dracut --force         # RHEL/Fedora
```

## Section 2: TPM2 Binding with clevis

### How TPM2 Binding Works

The TPM2 (Trusted Platform Module) contains sealed data: the LUKS key is encrypted using the TPM's internal key, and can only be unsealed if the system's PCR (Platform Configuration Register) values match the policy set at binding time.

```
TPM2 Sealing Flow:
┌─────────────────────────────────────────────────────┐
│  1. LUKS passphrase/key                             │
│         |                                           │
│  2. TPM2 seals it against current PCR values        │
│     (PCR7=Secure Boot, PCR14=shim, etc.)            │
│         |                                           │
│  3. Sealed blob stored in LUKS2 key slot            │
│         (as a clevis JSON token)                   │
└─────────────────────────────────────────────────────┘

TPM2 Unsealing Flow (at boot):
┌─────────────────────────────────────────────────────┐
│  1. clevis-dracut reads LUKS token from header      │
│  2. Sends sealed blob to TPM2                       │
│  3. TPM2 checks current PCR values against policy  │
│  4. If match: unseals and returns LUKS key          │
│  5. cryptsetup unlocks volume automatically         │
└─────────────────────────────────────────────────────┘
```

PCR registers capture the boot chain:
- PCR0: BIOS/UEFI firmware
- PCR1: BIOS configuration
- PCR4: MBR/bootloader
- PCR7: Secure Boot state
- PCR8: GRUB config
- PCR9: GRUB command line

### Installing Clevis

```bash
# Debian/Ubuntu
apt-get install -y clevis clevis-tpm2 clevis-luks clevis-dracut

# RHEL/Fedora
dnf install -y clevis clevis-tpm2 clevis-luks clevis-dracut

# Verify TPM2 availability
ls /dev/tpm*
tpm2_getcap properties-fixed | grep TPMVersion
```

### Binding LUKS to TPM2

```bash
# Bind with PCR7 only (Secure Boot state) — least restrictive
clevis luks bind -d /dev/sdb tpm2 '{"pcr_ids":"7"}'

# Bind with PCR7+PCR8+PCR9 — protects against GRUB config tampering
clevis luks bind -d /dev/sdb tpm2 '{"pcr_ids":"7,8,9"}'

# Bind with PCR7 and hash algorithm
clevis luks bind -d /dev/sdb tpm2 '{"pcr_ids":"7","pcr_bank":"sha256"}'

# Verify binding
clevis luks list -d /dev/sdb
# Output:
# 1: tpm2 '{"hash":"sha256","key":"ecc","pcr_bank":"sha256","pcr_ids":"7"}'
```

### Testing TPM2 Unlock Without Reboot

```bash
# Test decrypt (should succeed without passphrase if PCRs match)
clevis luks unlock -d /dev/sdb -n data_encrypted_test

# Check device mapper
ls /dev/mapper/data_encrypted_test

# Close test
cryptsetup luksClose data_encrypted_test
```

### Integrating with initramfs (Boot-Time Unlock)

```bash
# Install clevis dracut module
dracut --force --add clevis

# Verify module is included
lsinitrd | grep clevis

# Test boot
# During next boot, clevis-dracut will attempt TPM2 unlock automatically
# If it fails (e.g., PCRs changed after kernel update), falls back to passphrase prompt
```

### Handling PCR Changes After System Updates

A kernel or bootloader update changes PCR values, invalidating the TPM2 seal. Rebuild the seal after updates:

```bash
#!/bin/bash
# rebind-tpm2-after-update.sh
# Run AFTER a kernel/bootloader update but BEFORE reboot

DEVICE=/dev/sdb
EXISTING_PASSPHRASE=""   # Read from secure input

# Get current token slots
TOKENS=$(clevis luks list -d "$DEVICE" | awk '{print $1}')

# Remove old TPM2 token
for TOKEN in $TOKENS; do
    TYPE=$(clevis luks list -d "$DEVICE" | grep "^$TOKEN:" | awk '{print $2}')
    if [ "$TYPE" = "tpm2" ]; then
        echo "Removing old TPM2 token at slot $TOKEN"
        clevis luks unbind -d "$DEVICE" -s "$TOKEN"
    fi
done

# Re-bind with updated PCRs (will capture new boot chain after this update)
clevis luks bind -d "$DEVICE" tpm2 '{"pcr_ids":"7,8,9","pcr_bank":"sha256"}'

# Regenerate initramfs to include new token
dracut --force

echo "TPM2 binding updated. New boot will unlock automatically."
```

## Section 3: Clevis/Tang Network Unlock

### Tang Architecture

Tang provides a stateless network key server. The Clevis client performs a Diffie-Hellman key exchange with Tang to derive the LUKS key. Tang never stores the key or knows what it's unlocking:

```
Server Side:
  Tang → stores signing + exchange key pairs

Client Side (boot):
  Clevis → ephemeral key pair
  Clevis → fetches Tang's public key
  Clevis → DH key exchange → shared secret → LUKS key
  Volume → unlocked

If Tang is unreachable:
  Clevis → falls back to passphrase (or fails if configured)
```

### Deploying Tang Server

```bash
# Install Tang
apt-get install -y tang

# Or via container (preferred for HA)
docker run -d \
  --name tang \
  -p 7500:7500 \
  -v /etc/tang:/var/db/tang \
  ghcr.io/latchset/tang:latest

# Generate Tang keys (automatic on first start, or manually)
tangd-keygen /var/db/tang

# Verify keys
ls /var/db/tang/
# XXXXXXXXXXXXX.jwk (signing key)
# XXXXXXXXXXXXX.jwk (exchange key)

# Get Tang server thumbprint (clients need this to verify server identity)
tangd-keygen-show /var/db/tang/ | jose jwk thp -i-

# Expose Tang key advertisement endpoint
curl http://tang.example.com:7500/adv
```

### Tang High Availability

```yaml
# Kubernetes deployment for HA Tang
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tang
  namespace: security
spec:
  replicas: 3
  selector:
    matchLabels:
      app: tang
  template:
    metadata:
      labels:
        app: tang
    spec:
      containers:
        - name: tang
          image: ghcr.io/latchset/tang:latest
          ports:
            - containerPort: 7500
          volumeMounts:
            - name: tang-keys
              mountPath: /var/db/tang
              readOnly: true
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          livenessProbe:
            httpGet:
              path: /adv
              port: 7500
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /adv
              port: 7500
            initialDelaySeconds: 2
            periodSeconds: 5
      volumes:
        - name: tang-keys
          secret:
            secretName: tang-keys   # Tang key pairs stored as Kubernetes Secret

---
apiVersion: v1
kind: Service
metadata:
  name: tang
  namespace: security
spec:
  selector:
    app: tang
  ports:
    - port: 7500
      targetPort: 7500
  type: ClusterIP
```

### Binding LUKS to Tang

```bash
# Bind using Tang thumbprint for verification
TANG_THUMBPRINT=$(curl -s http://tang.example.com:7500/adv | \
  jose fmt -j- -Og payload -y -o- | \
  jose jwk thp -i-)

clevis luks bind -d /dev/sdb tang \
  "{\"url\":\"http://tang.example.com:7500\",\"thp\":\"$TANG_THUMBPRINT\"}"

# Verify binding
clevis luks list -d /dev/sdb

# Test unlock (Tang server must be reachable)
clevis luks unlock -d /dev/sdb -n data_tang_test
ls /dev/mapper/data_tang_test
cryptsetup luksClose data_tang_test
```

### Combining TPM2 AND Tang (Shamir Secret Sharing)

Clevis supports `sss` (Shamir Secret Sharing) to require EITHER TPM2 OR Tang for unlock:

```bash
# Unlock if EITHER TPM2 is present AND not tampered, OR Tang is reachable
# threshold=1 means any single method suffices
clevis luks bind -d /dev/sdb sss \
  '{"t":1,"pins":{"tpm2":{"pcr_ids":"7"},"tang":{"url":"http://tang:7500","thp":"THUMBPRINT"}}}'

# For higher security: require BOTH (threshold=2)
clevis luks bind -d /dev/sdb sss \
  '{"t":2,"pins":{"tpm2":{"pcr_ids":"7"},"tang":{"url":"http://tang:7500","thp":"THUMBPRINT"}}}'
```

### Network Unlock Policy for Server Farms

```bash
#!/bin/bash
# server-luks-provision.sh
# Provision LUKS encryption on a new server with Tang network unlock

DEVICE="$1"
TANG_URL="http://tang.security.svc.cluster.local:7500"

# Step 1: Format with strong Argon2id parameters
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha512 \
  --pbkdf argon2id \
  --pbkdf-memory 1048576 \
  --pbkdf-parallel 4 \
  --pbkdf-time 2000 \
  "$DEVICE"

# Step 2: Get Tang thumbprint
TANG_THUMBPRINT=$(curl -sf "${TANG_URL}/adv" | \
  jose fmt -j- -Og payload -y -o- | \
  jose jwk thp -i-)

# Step 3: Bind to Tang (no passphrase required at boot if Tang reachable)
clevis luks bind -d "$DEVICE" tang \
  "{\"url\":\"${TANG_URL}\",\"thp\":\"${TANG_THUMBPRINT}\"}"

# Step 4: Also bind to TPM2 if present (failover)
if [ -e /dev/tpm0 ]; then
    clevis luks bind -d "$DEVICE" tpm2 '{"pcr_ids":"7"}'
fi

# Step 5: Backup LUKS header to secrets vault
VAULT_PATH="infrastructure/luks-headers/$(hostname)/$(basename $DEVICE)"
cryptsetup luksHeaderBackup "$DEVICE" \
  --header-backup-file /tmp/luks-header-backup.bin
vault kv put "$VAULT_PATH" \
  header=@/tmp/luks-header-backup.bin \
  device="$DEVICE" \
  host="$(hostname)" \
  date="$(date -Iseconds)"
shred /tmp/luks-header-backup.bin

# Step 6: Install and configure dracut for network unlock
dracut --force --add clevis

echo "Provisioning complete. Device $DEVICE encrypted with Tang/TPM2 unlock."
```

## Section 4: dm-integrity for Tamper Detection

### What dm-integrity Provides

`dm-integrity` adds block-level integrity checking to every sector. It maintains a checksum for each 512-byte or 4096-byte sector. Any modification—including bitflips, silent corruption, or targeted tampering—is detected.

Combined with dm-crypt, this provides **authenticated encryption** at the block level:

```
dm-integrity + dm-crypt (AEAD mode):
┌─────────────────────────────────────┐
│  Write path:                        │
│  Plaintext → AES-GCM-encrypt        │
│  → ciphertext + MAC tag             │
│  → stored on disk                   │
│                                     │
│  Read path:                         │
│  Ciphertext + tag → AES-GCM-decrypt │
│  → verify MAC tag                   │
│  → return plaintext (or error)      │
└─────────────────────────────────────┘
```

### Setting Up LUKS2 with Integrity

```bash
# LUKS2 with aes-gcm (AEAD: authenticated encryption with associated data)
# Note: requires --integrity=aead
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-gcm-random \    # GCM mode provides authentication
  --key-size 256 \
  --integrity aead \
  --integrity-no-journal \     # Disable integrity journal for better performance
  --sector-size 4096 \         # Match physical sector size for NVMe
  /dev/sdb

# Or: separate dm-integrity layer under dm-crypt (more compatible)
# Step 1: Create dm-integrity device
integritysetup format /dev/sdb
integritysetup open /dev/sdb data_integrity

# Step 2: Create LUKS2 on top of dm-integrity
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  /dev/mapper/data_integrity
```

### Integrity Verification

```bash
# Check integrity errors (silent corruption detection)
integritysetup status data_integrity

# If integrity errors are found, they appear in:
dmesg | grep "integrity" | grep -i "error\|fail"

# Or in kernel journal
journalctl -k | grep dm-integrity
```

## Section 5: Performance Optimization

### Benchmarking Encryption Overhead

```bash
# Benchmark cryptographic primitives
cryptsetup benchmark

# Sample output:
# Tests are approximate using memory only (no storage IO).
# PBKDF2-sha1       1987760 iterations per second for 256-bit key
# PBKDF2-sha512      625060 iterations per second for 256-bit key
# argon2i       7 iterations, 1048576 memory, 4 threads for 256-bit key (  5.1s)
# argon2id      7 iterations, 1048576 memory, 4 threads for 256-bit key (  5.0s)
# #     Algorithm |       Key |      Encryption |      Decryption
#        aes-cbc   128b  1104.9 MiB/s  3613.8 MiB/s
#        aes-cbc   256b   945.5 MiB/s  2752.2 MiB/s
#        aes-xts   256b  1832.3 MiB/s  1867.3 MiB/s
#        aes-xts   512b  1584.9 MiB/s  1632.6 MiB/s

# Test actual disk performance
cryptsetup luksOpen /dev/sdb data_bench
fio --name=seq-write --ioengine=libaio --rw=write --bs=1M \
    --direct=1 --size=4G --filename=/dev/mapper/data_bench
cryptsetup luksClose data_bench
```

### Sector Size Tuning

```bash
# For NVMe drives with 4096-byte physical sectors:
cryptsetup luksFormat \
  --type luks2 \
  --sector-size 4096 \          # Align to NVMe native sector size
  --cipher aes-xts-plain64 \
  /dev/nvme0n1

# Check device's preferred sector size
blockdev --getpbsz /dev/nvme0n1
blockdev --getss /dev/nvme0n1
```

### AES Hardware Acceleration

```bash
# Verify AES-NI is available (essential for performance)
grep aes /proc/cpuinfo | head -3

# Check kernel is using hardware acceleration
dmesg | grep "AES"

# cryptsetup automatically uses AES-NI when available
# Verify with strace or perf
perf stat -e instructions,cycles cryptsetup benchmark
```

## Section 6: Emergency Procedures

### Unlocking with Backup Passphrase When Tang Is Down

```bash
# If Tang server is unreachable and TPM2 seal is broken
# (e.g., hardware replacement):

# Method 1: Use emergency passphrase stored in vault
vault kv get --field=emergency_passphrase infrastructure/luks/$(hostname)/sdb | \
  cryptsetup luksOpen /dev/sdb data_emergency

# Method 2: Restore from header backup
cryptsetup luksHeaderRestore /dev/sdb \
  --header-backup-file /secure-backup/sdb-luks-header-backup.bin

# Then re-bind to Tang
TANG_THUMBPRINT=$(curl -sf "http://tang.example.com:7500/adv" | jose fmt -j- -Og payload -y -o- | jose jwk thp -i-)
clevis luks bind -d /dev/sdb tang "{\"url\":\"http://tang.example.com:7500\",\"thp\":\"$TANG_THUMBPRINT\"}"
```

### Rotating the Tang Key (Emergency Re-Key)

```bash
#!/bin/bash
# rotate-tang-key.sh
# Rotate Tang keys while minimizing disruption

TANG_DB=/var/db/tang
TANG_URL=http://tang.example.com:7500

# Step 1: Generate new keys (don't delete old ones yet)
tangd-keygen "$TANG_DB"

# Step 2: Rebind all clients to new key
# Run on each server that uses this Tang instance:

NEW_THUMBPRINT=$(curl -sf "${TANG_URL}/adv" | \
  jose fmt -j- -Og payload -y -o- | \
  jose jwk thp -i-)

for DEVICE in /dev/sdb /dev/sdc; do
    # Remove old Tang bindings
    for SLOT in $(clevis luks list -d "$DEVICE" | awk '{print $1}' | tr -d ':'); do
        TYPE=$(clevis luks list -d "$DEVICE" | grep "^$SLOT:" | awk '{print $2}')
        if [ "$TYPE" = "tang" ]; then
            clevis luks unbind -d "$DEVICE" -s "$SLOT"
        fi
    done

    # Add new Tang binding
    clevis luks bind -d "$DEVICE" tang \
        "{\"url\":\"${TANG_URL}\",\"thp\":\"${NEW_THUMBPRINT}\"}"
done

# Step 3: After all clients are rebound, disable old Tang keys
# (rename to .bak to retire them without deleting immediately)
for KEY in $(ls "$TANG_DB"/*.jwk); do
    if ! tang-show-keys "$KEY" | grep -q "$(cat /tmp/new-tang-thumbprint)"; then
        mv "$KEY" "${KEY}.bak"
    fi
done

# Step 4: Restart Tang to load new keys
systemctl restart tangd
```

## Section 7: Compliance and Audit

### FIPS 140-2/140-3 Compliance

```bash
# Check if FIPS mode is enabled
cat /proc/sys/crypto/fips_enabled

# Enable FIPS mode (kernel parameter)
# Add to GRUB: fips=1 boot.saltstack.com
# For Ubuntu:
sudo ua enable fips-preview
sudo fips-updates install

# For RHEL:
# Enable FIPS mode
sudo fips-mode-setup --enable
sudo reboot

# After FIPS mode, cryptsetup will only allow FIPS-approved algorithms:
# AES-CBC, AES-XTS (not GCM without FIPS approval), SHA-256, SHA-512
# Argon2id is NOT FIPS approved — use PBKDF2-SHA512 for FIPS compliance
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha512 \
  --pbkdf pbkdf2 \     # FIPS-approved
  --pbkdf-time 5000 \
  /dev/sdb
```

### Audit Logging

```bash
# Enable auditd for dm-crypt operations
cat >> /etc/audit/audit.rules << 'EOF'
# Monitor LUKS/dm-crypt key material operations
-a always,exit -F arch=b64 -S openat,open -F path=/etc/luks -F perm=rw -k luks-key-access
-a always,exit -F arch=b64 -S openat,open -F path=/dev/mapper -F perm=rw -k dm-crypt-access
EOF

auditctl -R /etc/audit/audit.rules
systemctl restart auditd

# Monitor LUKS operations via systemd journal
journalctl -u systemd-cryptsetup@* -f

# Create audit events for LUKS header changes
inotifywait -m -e access,modify,close_write \
  -r /etc/luks/ \
  --format '%T %w %f %e' \
  --timefmt '%Y-%m-%dT%H:%M:%S' \
  >> /var/log/luks-audit.log &
```

## Section 8: Complete Server Provisioning Script

```bash
#!/bin/bash
# full-disk-encryption-provision.sh
# Complete provisioning for a new server with encrypted storage

set -euo pipefail

DEVICE="${1:-/dev/sdb}"
MOUNT_POINT="${2:-/data}"
TANG_URL="${3:-http://tang.security.svc.cluster.local:7500}"
MAPPER_NAME="data_encrypted"

echo "=== Starting LUKS2 Encryption Provisioning ==="
echo "Device: $DEVICE"
echo "Mount point: $MOUNT_POINT"
echo "Tang URL: $TANG_URL"

# Verify device
if ! [ -b "$DEVICE" ]; then
    echo "Error: $DEVICE is not a block device"
    exit 1
fi

# Generate a strong temporary passphrase for initial format
TEMP_PASS=$(openssl rand -base64 64)

echo "--- Formatting with LUKS2 ---"
echo -n "$TEMP_PASS" | cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha512 \
  --pbkdf argon2id \
  --pbkdf-memory 1048576 \
  --pbkdf-parallel 4 \
  --pbkdf-time 2000 \
  --label "$(hostname)-data" \
  "$DEVICE" \
  --batch-mode -

echo "--- Binding to Tang ---"
TANG_THUMBPRINT=$(curl -sf "${TANG_URL}/adv" | \
  jose fmt -j- -Og payload -y -o- | \
  jose jwk thp -i-)

echo -n "$TEMP_PASS" | clevis luks bind \
  -d "$DEVICE" \
  -k - \
  tang "{\"url\":\"${TANG_URL}\",\"thp\":\"${TANG_THUMBPRINT}\"}"

echo "--- Binding to TPM2 (if available) ---"
if [ -e /dev/tpm0 ]; then
    echo -n "$TEMP_PASS" | clevis luks bind \
      -d "$DEVICE" \
      -k - \
      tpm2 '{"pcr_ids":"7","pcr_bank":"sha256"}'
    echo "TPM2 binding added"
else
    echo "No TPM2 found, skipping TPM2 binding"
fi

echo "--- Removing temporary passphrase slot ---"
TEMP_SLOT=$(cryptsetup luksDump "$DEVICE" | grep "^  [0-9]*:" | \
  awk '{print $1}' | head -1 | tr -d ':')

# Verify Tang unlock works before removing passphrase
echo "Testing Tang unlock..."
clevis luks unlock -d "$DEVICE" -n "${MAPPER_NAME}_test"
cryptsetup luksClose "${MAPPER_NAME}_test"

# Remove temporary passphrase (slot 0 is the initial passphrase)
echo -n "$TEMP_PASS" | cryptsetup luksKillSlot "$DEVICE" "$TEMP_SLOT" -

unset TEMP_PASS

echo "--- Creating filesystem ---"
clevis luks unlock -d "$DEVICE" -n "$MAPPER_NAME"
mkfs.xfs -L "data" /dev/mapper/"$MAPPER_NAME"
cryptsetup luksClose "$MAPPER_NAME"

echo "--- Configuring crypttab and fstab ---"
DEVICE_UUID=$(blkid -s UUID -o value "$DEVICE")
echo "$MAPPER_NAME UUID=${DEVICE_UUID} - luks,_netdev,clevis" >> /etc/crypttab
mkdir -p "$MOUNT_POINT"
echo "/dev/mapper/$MAPPER_NAME $MOUNT_POINT xfs defaults,nofail,_netdev,x-systemd.requires=cryptsetup.target 0 0" >> /etc/fstab

echo "--- Updating initramfs ---"
dracut --force --add clevis

echo "--- Backing up LUKS header to Vault ---"
cryptsetup luksHeaderBackup "$DEVICE" --header-backup-file /tmp/luks-header.bin
vault kv put "infrastructure/luks-headers/$(hostname)/$(basename $DEVICE)" \
  header=@/tmp/luks-header.bin \
  device="$DEVICE" \
  uuid="$DEVICE_UUID" \
  provisioned="$(date -Iseconds)" \
  tang_url="$TANG_URL"
shred /tmp/luks-header.bin

echo "=== Provisioning Complete ==="
echo "Device $DEVICE is now encrypted."
echo "Boot will automatically unlock via Tang (${TANG_URL}) or TPM2."
cryptsetup luksDump "$DEVICE" | grep -E "Version|Label|UUID|PBKDF"
```

## Conclusion

Linux block device encryption with LUKS2 provides a complete, standards-compliant foundation for data at rest protection:

1. **LUKS2 with Argon2id** provides state-of-the-art key derivation that resists GPU and ASIC attacks through high memory requirements, replacing the weaker PBKDF2 in LUKS1.

2. **TPM2 binding** via Clevis enables automated unlock tied to the trusted boot chain: PCR values capture firmware, Secure Boot state, bootloader, and kernel, ensuring the key is only released to an unmodified system.

3. **Tang network unlock** provides scalable automated unlock for server farms without requiring a passphrase, maintaining full security (Tang never sees the key) while eliminating boot-time manual intervention.

4. **dm-integrity** adds block-level tamper detection, catching silent corruption that encryption alone cannot detect.

5. **Operational procedures**: header backups to Vault, Tang key rotation scripts, and PCR rebinding after system updates are all essential to avoid locked-out systems in production.

The combination of TPM2 (local) and Tang (network) with Shamir threshold gives the best balance: the volume unlocks automatically in normal operation, but cannot be unsealed if either the hardware is tampered with or the network policy server is unreachable.
