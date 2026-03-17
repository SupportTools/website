---
title: "Linux Disk Encryption: LUKS2, Clevis/Tang for Network Unlocking, and Key Management"
date: 2030-03-02T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "LUKS2", "Disk Encryption", "Clevis", "Tang", "NBDE", "TPM2"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement enterprise disk encryption with LUKS2 and Argon2id, automate disk unlocking with TPM2 and Clevis/Tang NBDE, and integrate network-bound disk encryption with Kubernetes Sealed Secrets."
more_link: "yes"
url: "/linux-disk-encryption-luks2-clevis-tang-nbde/"
---

Data-at-rest encryption protects against one specific threat: an attacker who obtains physical access to storage media. Without encryption, pulling a drive from a server and reading it in a different machine is trivial. With LUKS2 properly configured, that same drive reveals nothing without the key. But there is a fundamental tension in disk encryption: the key must be available at boot time to unlock the drive, yet it must not be stored where an attacker with physical access can find it.

This guide covers LUKS2 configuration with modern cryptographic parameters, TPM2-based unlocking that ties decryption to measured boot state, and Network-Bound Disk Encryption (NBDE) with Clevis/Tang — the approach used by Red Hat, Fedora, and RHEL to eliminate manual passphrase entry while maintaining strong security guarantees.

<!--more-->

## LUKS2 Overview and Improvements over LUKS1

LUKS2 (Linux Unified Key Setup version 2) introduces:

- **JSON-based header**: The metadata area stores configuration in JSON, making it more extensible and parseable
- **Argon2id key derivation**: Replaces PBKDF2 with memory-hard Argon2id, making brute-force attacks enormously more expensive
- **Multiple header copies**: Two header copies provide redundancy
- **Keyslots are independent**: Each keyslot has its own PBKDF parameters
- **Integrity protection**: Integration with dm-integrity for block-level integrity checking

## Creating a LUKS2 Volume

### Benchmark First

Always benchmark before choosing parameters:

```bash
# Benchmark Argon2id parameters for this hardware
# Determines how much memory and iterations to use for 1-second derive time
cryptsetup benchmark

# Sample output:
# PBKDF2-sha1       1022117 iterations per second for 256-bit key
# PBKDF2-sha256      889390 iterations per second for 256-bit key
# Argon2i        6 iterations, memory 1048576, threads 4 for 256-bit key
# Argon2id       5 iterations, memory 1048576, threads 4 for 256-bit key

# Test specific parameters
cryptsetup benchmark --pbkdf=argon2id
```

### Formatting a LUKS2 Volume

```bash
# Format with production-grade parameters
# --type luks2: use LUKS2 format
# --cipher aes-xts-plain64: AES-XTS with 64-bit sector IV
# --key-size 512: 512 bits (256 per XTS half)
# --hash sha512: hash for key derivation
# --pbkdf argon2id: use Argon2id for KDF
# --pbkdf-memory 1048576: 1GB memory for KDF (increase brute-force cost)
# --pbkdf-parallel 4: parallelism for KDF
# --pbkdf-force-iterations 4: minimum iterations
# --sector-size 4096: match SSD sector size for performance

cryptsetup luksFormat \
    --type luks2 \
    --cipher aes-xts-plain64 \
    --key-size 512 \
    --hash sha512 \
    --pbkdf argon2id \
    --pbkdf-memory 1048576 \
    --pbkdf-parallel 4 \
    --pbkdf-force-iterations 4 \
    --sector-size 4096 \
    --label "data-vol-1" \
    /dev/sdb

# Interactive passphrase entry:
# WARNING: Device /dev/sdb already contains a 'ext4' signature.
# Are you sure? (Type uppercase yes): YES
# Enter passphrase for /dev/sdb: [passphrase]
# Verify passphrase: [passphrase]
```

### Opening and Using the Volume

```bash
# Open (unlock) the volume
cryptsetup luksOpen /dev/sdb data-vol-1

# Creates /dev/mapper/data-vol-1

# Format the plaintext device
mkfs.xfs -L data-vol-1 /dev/mapper/data-vol-1

# Mount it
mkdir -p /data/vol1
mount /dev/mapper/data-vol-1 /data/vol1

# Close (lock) the volume
umount /data/vol1
cryptsetup luksClose data-vol-1
```

### Inspecting LUKS2 Headers

```bash
# Show LUKS2 header details
cryptsetup luksDump /dev/sdb

# Sample output:
# LUKS header information
# Version:        2
# Epoch:          3
# Metadata area:  16384 [bytes]
# Keyslots area:  16744448 [bytes]
# UUID:           a7c3a9f1-...
# Label:          data-vol-1
# Subsystem:      (no subsystem)
# Flags:          (no flags)
#
# Data segments:
#   0: crypt
#         offset: 16777216 [bytes]
#         length: (whole device)
#         cipher: aes-xts-plain64
#         sector: 4096 [bytes]
#
# Keyslots:
#   0: luks2
#         Key:        512 bits
#         Priority:   normal
#         Cipher:     aes-xts-plain64
#         Cipher key: 512 bits
#         PBKDF:      argon2id
#         Time cost:  4
#         Memory:     1048576
#         Threads:    4
#         Salt:       ...
#         AF stripes: 4000
#         AF hash:    sha512
#         Area offset:32768 [bytes]
#         Area length:258048 [bytes]
#         Digest ID:  0
```

## TPM2-Based Disk Unlocking

A TPM2 chip can seal the LUKS key to a set of PCR (Platform Configuration Register) measurements. The key is only released if the system boots in the expected state — any tampering with firmware, bootloader, or kernel will change PCR values and prevent unlocking.

### Setting Up TPM2 Auto-Unlock

```bash
# Install clevis and TPM2 tools
# RHEL/Fedora:
dnf install clevis clevis-luks clevis-dracut clevis-tpm2

# Ubuntu/Debian:
apt-get install clevis-luks clevis-tpm2 clevis-dracut

# Verify TPM2 is available
ls /dev/tpm* /dev/tpmrm*
tpm2_pcrlist

# PCR values to seal against:
# PCR0: UEFI firmware code
# PCR1: UEFI firmware data and NVRAM
# PCR2: Option ROM code
# PCR4: MBR code (GPT/UEFI: UEFI boot manager)
# PCR5: MBR data (GPT/UEFI: UEFI boot manager data)
# PCR7: Secure Boot state
# PCR8: Grub configuration (when measured)
# PCR9: Grub kernel/initrd

# Bind LUKS volume to TPM2
# -s tpm2: use TPM2 binding
# '{"pcr_bank":"sha256","pcr_ids":"1,7"}': seal to PCR 1 (firmware data) and 7 (Secure Boot)
clevis luks bind -d /dev/sdb tpm2 '{"pcr_bank":"sha256","pcr_ids":"1,7"}'

# Enter existing LUKS passphrase when prompted
# This adds a new keyslot bound to the TPM2

# Verify binding
clevis luks list -d /dev/sdb
# 1: tpm2 '{"hash":"sha256","key":"ecc","pcr_bank":"sha256","pcr_ids":"1,7"}'
```

### PCR Selection Strategy

```bash
# Show current PCR values
tpm2_pcrread sha256:0,1,2,3,4,5,6,7,8,9

# Strategy for server environments:
# PCR 1 (UEFI data): Catches changes to firmware configuration
# PCR 7 (Secure Boot): Catches Secure Boot state changes
# PCR 9 (Kernel/initrd): Catches kernel updates

# Strategy for workstations:
# PCR 1,4,7: More stable, won't break on minor firmware updates

# IMPORTANT: Including PCR 4 or 9 means disk auto-unlock will FAIL after kernel updates
# You'll need to update the TPM binding after each kernel update:
# clevis luks regen -d /dev/sdb -s 1

# To update PCR binding after kernel update:
dracut -f
# Reboot into new kernel
# After verifying boot works:
clevis luks regen -d /dev/sdb -s 1
```

### Enabling Auto-Unlock in initramfs

```bash
# Regenerate initramfs with clevis support
# RHEL/Fedora:
dracut -f

# Ubuntu (with clevis-dracut):
update-initramfs -u

# Update /etc/crypttab to use clevis:
# <name>  <device>     none  luks,_netdev,x-systemd.device-timeout=90s
cat /etc/crypttab
# data-vol-1  /dev/sdb  none  luks,_netdev

# The 'none' means use initramfs dracut scripts (clevis will handle it)
```

## Network-Bound Disk Encryption (NBDE) with Clevis/Tang

Tang is a server that provides key escrow for disk encryption without storing any secrets. The cryptographic protocol ensures:
- Tang never sees the client's LUKS key
- The disk only unlocks when the Tang server is reachable
- If the machine is removed from the network (stolen), it cannot unlock
- Tang stores only a public key, so compromising Tang doesn't expose any client keys

### Setting Up the Tang Server

```bash
# Install Tang server
dnf install tang

# Or on Ubuntu:
apt-get install tang

# Start Tang service
systemctl enable tangd.socket --now

# Verify Tang is running
systemctl status tangd.socket
# The socket listens on port 7500 by default

# Tang key storage location
ls /var/db/tang/
# *.jwk files: Tang signing and exchange keys

# Rotate Tang keys (periodically recommended)
tang-show-keys 7500
# Generates advertisement showing public key thumbprints

# Add firewall rule if needed
firewall-cmd --permanent --add-port=7500/tcp
firewall-cmd --reload
```

### Configuring Tang with TLS

For production, Tang should be behind a TLS-terminating proxy:

```nginx
# /etc/nginx/conf.d/tang.conf
server {
    listen 443 ssl;
    server_name tang.internal.example.com;

    ssl_certificate /etc/pki/tls/certs/tang.crt;
    ssl_certificate_key /etc/pki/tls/private/tang.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305;

    location / {
        proxy_pass http://127.0.0.1:7500;
        proxy_set_header Host $host;
    }
}
```

### Binding a LUKS Volume to Tang

```bash
# On the client machine:
# Test Tang connectivity first
curl -s http://tang.internal.example.com:7500/adv | python3 -m json.tool

# Bind LUKS to Tang
clevis luks bind -d /dev/sdb tang \
    '{"url":"http://tang.internal.example.com:7500"}'

# Thumbprint verification prompt - match against tang-show-keys output on Tang server
# The thumbprint ensures you're talking to the right Tang server

# Verify binding
clevis luks list -d /dev/sdb
# 2: tang '{"adv":{"keys":[...]}, "url":"http://tang.internal.example.com:7500"}'

# Update initramfs
dracut -f
```

### Multi-Tang Configuration for High Availability

NBDE supports Shamir's Secret Sharing (SSS) to require multiple Tang servers or combine Tang with TPM2:

```bash
# Require EITHER Tang server OR TPM2 (OR logic)
# If the machine is on-network: Tang unlocks it
# If the machine is off-network but in known state: TPM2 unlocks it
clevis luks bind -d /dev/sdb sss \
    '{"t":1,"pins":{"tpm2":{"pcr_ids":"7"},"tang":{"url":"http://tang1.example.com:7500"}}}'

# Require BOTH Tang server 1 AND Tang server 2 (AND logic, t=2)
# Disk only unlocks if both Tang servers are reachable
clevis luks bind -d /dev/sdb sss \
    '{"t":2,"pins":{"tang":[{"url":"http://tang1.example.com:7500"},{"url":"http://tang2.example.com:7500"}]}}'

# Require Tang server 1 OR Tang server 2 (OR logic, t=1)
# Disk unlocks if either Tang server is available
clevis luks bind -d /dev/sdb sss \
    '{"t":1,"pins":{"tang":[{"url":"http://tang1.example.com:7500"},{"url":"http://tang2.example.com:7500"}]}}'
```

### Clevis/Tang in Kubernetes

In a Kubernetes environment, NBDE protects node disks while allowing automatic boot when nodes are part of the cluster. The Tang server should be deployed as a Kubernetes service:

```yaml
# tang-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tang-server
  namespace: security
spec:
  replicas: 3  # High availability
  selector:
    matchLabels:
      app: tang-server
  template:
    metadata:
      labels:
        app: tang-server
    spec:
      # Tang must run on control plane nodes that boot before worker nodes
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: tang
          image: registry.access.redhat.com/ubi9/tang:latest
          ports:
            - containerPort: 7500
              name: tang
          volumeMounts:
            - name: tang-keys
              mountPath: /var/db/tang
              readOnly: false
          readinessProbe:
            httpGet:
              path: /adv
              port: 7500
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /adv
              port: 7500
            initialDelaySeconds: 10
            periodSeconds: 30
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
      volumes:
        - name: tang-keys
          persistentVolumeClaim:
            claimName: tang-keys-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: tang-server
  namespace: security
spec:
  selector:
    app: tang-server
  ports:
    - port: 7500
      targetPort: 7500
      name: tang
  # Use NodePort or LoadBalancer for access from nodes during boot
  type: LoadBalancer
---
# tang-keys PVC - use local storage on control plane nodes
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tang-keys-pvc
  namespace: security
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path
  resources:
    requests:
      storage: 1Gi
```

### Integration with Sealed Secrets for Key Backup

While NBDE handles automatic unlocking, you need a recovery path if Tang is unavailable. Combine NBDE with Kubernetes Sealed Secrets for encrypted key backup:

```bash
# Install kubeseal
KUBESEAL_VERSION=0.24.5
curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
tar -xzf kubeseal-*.tar.gz kubeseal
install -m 755 kubeseal /usr/local/bin/kubeseal

# Create recovery key backup workflow:

#!/bin/bash
# backup-luks-recovery-key.sh
# Run on each node to back up the recovery key to Kubernetes

DEVICE=$1
NODE=$(hostname)

# Export LUKS key (from existing keyslot - requires current passphrase)
# In practice, this is done at provisioning time
RECOVERY_KEY=$(cryptsetup luksDump $DEVICE | grep -A5 "Keyslots:" | head -20)

# Create a Kubernetes secret with the recovery key
kubectl create secret generic "luks-recovery-${NODE}" \
    --namespace=security \
    --from-literal=passphrase="${RECOVERY_PASSPHRASE}" \
    --from-literal=device="${DEVICE}" \
    --from-literal=node="${NODE}" \
    --dry-run=client \
    -o yaml | \
kubeseal \
    --controller-name=sealed-secrets \
    --controller-namespace=kube-system \
    --format=yaml > "sealed-luks-recovery-${NODE}.yaml"

# Apply to cluster
kubectl apply -f "sealed-luks-recovery-${NODE}.yaml"
echo "Recovery key backed up to Sealed Secret: luks-recovery-${NODE}"
```

```yaml
# Example sealed secret structure (after sealing)
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: luks-recovery-worker-01
  namespace: security
spec:
  encryptedData:
    passphrase: AgBJjOz8... # Encrypted passphrase, only decryptable by sealed-secrets controller
    device: AgCXm9Yk...
    node: AgDn8Pz1...
```

## LUKS Key Management Operations

### Adding Emergency Recovery Keys

```bash
# Add a separate recovery keyslot with passphrase
# Used if Tang server is permanently unavailable
cryptsetup luksAddKey /dev/sdb --key-slot 7 \
    --pbkdf argon2id \
    --pbkdf-memory 1048576

# Enter existing passphrase, then enter new recovery passphrase

# Store the recovery passphrase securely:
# - HashiCorp Vault
# - AWS Secrets Manager
# - Kubernetes Sealed Secrets (as shown above)

# List all keyslots
cryptsetup luksDump /dev/sdb | grep -A5 "Keyslots:"

# Remove a keyslot (e.g., after key rotation)
cryptsetup luksKillSlot /dev/sdb 3
```

### Key Rotation

```bash
# Rotate the master encryption key (changes the actual key used for disk encryption)
# This does NOT require re-encrypting the entire disk
# It only re-encrypts the master key, not the data

# Step 1: Add new passphrase in a temporary keyslot
cryptsetup luksAddKey /dev/sdb --key-slot 5

# Step 2: Reencrypt just the LUKS header (not the data)
cryptsetup-reencrypt --resilience=journal /dev/sdb

# For rotating the Tang binding:
# On Tang server: rotate keys
# On client: rebind
clevis luks regen -d /dev/sdb -s 2  # Regenerate keyslot 2 (Tang binding)
```

### LUKS Header Backup and Restore

```bash
# Backup LUKS header (critical for recovery)
cryptsetup luksHeaderBackup /dev/sdb --header-backup-file /backup/luks-header-sdb.bin

# Encrypt the backup with GPG for secure storage
gpg --symmetric --cipher-algo AES256 /backup/luks-header-sdb.bin
# Produces: /backup/luks-header-sdb.bin.gpg
# Store this in a separate, secure location

# Restore header (use only if header is corrupted)
cryptsetup luksHeaderRestore /dev/sdb --header-backup-file /backup/luks-header-sdb.bin
```

## In-Place Encryption of Existing Partitions

```bash
# LUKS2 supports online re-encryption of existing partitions
# This encrypts an unencrypted partition without data loss

# Step 1: Ensure partition has enough free space at the end (LUKS header needs ~16MB)
# Shrink filesystem slightly if needed
e2fsck -f /dev/sdb1
resize2fs /dev/sdb1 $(( $(blockdev --getsz /dev/sdb1) - 32768 ))s

# Step 2: Start online encryption
cryptsetup reencrypt \
    --encrypt \
    --resilience journal \
    --reduce-device-size 32s \
    /dev/sdb1

# This will ask for a passphrase for the new LUKS volume
# Encryption proceeds in the background
# System can continue operating

# Step 3: Check progress
cryptsetup reencrypt --resume /dev/sdb1

# Step 4: After completion, update /etc/crypttab
echo "data-part1  /dev/sdb1  none  luks" >> /etc/crypttab

# Step 5: Add Clevis/Tang binding
clevis luks bind -d /dev/sdb1 tang '{"url":"http://tang.example.com:7500"}'
```

## Monitoring and Alerting

```bash
# Check LUKS volume status
cryptsetup status data-vol-1
# /dev/mapper/data-vol-1 is active.
#   type:    LUKS2
#   cipher:  aes-xts-plain64
#   keysize: 512 bits
#   key location: dm-crypt
#   device:  /dev/sdb
#   sector size:  4096
#   offset:  32768 sectors
#   size:    488369152 sectors
#   mode:    read/write

# Monitor for failed unlock attempts
journalctl -f -u systemd-cryptsetup@data-vol-1
```

```yaml
# Prometheus alert for encrypted volume not mounted
# prometheus-rules.yaml
groups:
  - name: disk-encryption
    rules:
      - alert: EncryptedVolumeNotMounted
        expr: |
          node_filesystem_avail_bytes{mountpoint="/data/vol1"} == 0
          OR absent(node_filesystem_avail_bytes{mountpoint="/data/vol1"})
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Encrypted volume /data/vol1 is not mounted on {{ $labels.instance }}"
          description: "The encrypted volume may have failed to unlock. Check Tang server connectivity and TPM2 state."

      - alert: TangServerUnreachable
        expr: probe_success{job="tang-health-check"} == 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Tang server is unreachable"
          description: "Nodes may not be able to boot and unlock encrypted disks."
```

## Key Takeaways

Enterprise disk encryption with LUKS2, TPM2, and Clevis/Tang provides:

1. **LUKS2 with Argon2id raises the brute-force bar significantly**: The memory-hard KDF makes password-based attacks orders of magnitude more expensive than LUKS1 with PBKDF2. Use at least 1GB memory cost in production.
2. **TPM2 seals keys to measured boot state**: If firmware, bootloader, or kernel is modified, the TPM will refuse to release the key. This catches physical tampering and boot-time attacks.
3. **Tang NBDE eliminates passphrases without reducing security**: The server never sees the key; the protocol is a secure exchange of public key components. An attacker who steals both the disk and the Tang server still cannot decrypt the data (Tang stores only a public key).
4. **SSS composition allows flexible policies**: Require one of N Tang servers, or Tang AND TPM2, or any other combination using threshold secret sharing.
5. **Header backup is mandatory**: LUKS header corruption means permanent data loss. Encrypt the backup with GPG and store it in a separate location (Vault, Sealed Secrets, HSM).
6. **Kubernetes requires Tang on control plane nodes**: Worker node disks that unlock via Tang need Tang to be running before the worker boots. Deploying Tang as a Kubernetes service on control-plane nodes solves the chicken-and-egg problem.
