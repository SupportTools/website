---
title: "Linux Filesystem Encryption: fscrypt for Per-Directory Encryption"
date: 2031-05-31T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "fscrypt", "Encryption", "LUKS", "Kubernetes", "PAM"]
categories:
- Linux
- Security
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to fscrypt per-directory filesystem encryption on Linux, covering policy and key management, ext4 and F2FS support, PAM integration, Kubernetes CSI drivers for encrypted volumes, and auditing encrypted file access."
more_link: "yes"
url: "/linux-fscrypt-per-directory-filesystem-encryption-guide/"
---

LUKS provides block-level encryption that protects entire disks or partitions. But there are many scenarios where you want finer-grained control: encrypting individual user home directories on a shared system, protecting specific application data directories, or enabling key rotation for subsets of data without decrypting the entire volume. fscrypt is the Linux kernel's per-directory encryption framework that enables precisely this. This guide covers the complete operational picture from kernel support through production deployment.

<!--more-->

# Linux Filesystem Encryption: fscrypt for Per-Directory Encryption

## Section 1: fscrypt Architecture

fscrypt is built into the Linux kernel (4.1+) and provides transparent encryption at the filesystem layer. Unlike LUKS which encrypts at the block device level, fscrypt encrypts individual files and directory entries based on encryption policies applied to directories.

### Key Concepts

**Master Key**: A 64-byte key material that is the root of the encryption hierarchy for a directory tree. Multiple directories can share a master key.

**Encryption Policy**: A per-directory policy that specifies which master key to use and what encryption modes to apply to file contents and filenames.

**Key Descriptor / Key Identifier**: A unique identifier for a master key. Keys added to the kernel keyring are identified by this descriptor.

**Protector**: An object that protects the master key. Protectors can be login passphrases, raw keys, or TPM-backed keys.

### fscrypt vs LUKS Comparison

| Feature | fscrypt | LUKS |
|---|---|---|
| Encryption granularity | Per-directory | Per-block-device |
| Key isolation | Per-directory key | Single key for volume |
| Overhead | ~5-15% for small files | ~2-5% (hardware AES) |
| Metadata encryption | Optional (filenames) | Yes (all metadata) |
| Multi-user isolation | Native | Requires multiple partitions |
| Hot key rotation | Directory-level | Full re-encryption |
| Kernel requirement | 4.1+ | Any |
| Filesystem support | ext4, F2FS, UBIFS | Any block device |
| Cryptographic modes | AES-256-XTS, AES-128-XTS, Adiantum | AES-XTS (typical) |

### When to Choose fscrypt Over LUKS

Choose fscrypt when:
- You need per-user encryption on a shared filesystem
- You want to encrypt application data directories independently
- You need different encryption keys for different tenants on the same volume
- You want to revoke access for a specific user without affecting others
- Your storage is NVMe with hardware AES acceleration (fscrypt passes through to the same hardware)

Choose LUKS when:
- You need to encrypt all data including filesystem metadata
- You want protection against physical theft of a full disk
- You need pre-boot authentication
- Filesystem-level encryption is not sufficient for your threat model

## Section 2: Filesystem Support

### ext4

ext4 has supported fscrypt since kernel 4.1. You must format with the `encrypt` feature enabled or add it to an existing filesystem:

```bash
# Format new ext4 with encryption support
mkfs.ext4 -O encrypt /dev/sdb1

# Add encryption feature to existing ext4
# WARNING: requires e2fsck first and may require newer e2fsprogs
tune2fs -O encrypt /dev/sdb1

# Verify the feature is enabled
tune2fs -l /dev/sdb1 | grep features
# Should show: encrypt in the filesystem features list

# Mount normally - fscrypt works transparently
mount /dev/sdb1 /data
```

### F2FS

F2FS (Flash-Friendly File System) is the recommended filesystem for fscrypt on flash storage due to its encryption-aware design:

```bash
# Format F2FS with encryption support (enabled by default in recent versions)
mkfs.f2fs -O encrypt /dev/mmcblk0p1

# Verify
fsck.f2fs -l /dev/mmcblk0p1 | grep encrypt

# Mount
mount -t f2fs /dev/mmcblk0p1 /data
```

## Section 3: Installing and Configuring fscrypt Tooling

The `fscrypt` userspace tool from Google provides the primary interface for managing policies and keys:

```bash
# Debian/Ubuntu
apt-get install fscrypt libpam-fscrypt

# RHEL/CentOS/Fedora
dnf install fscrypt pam_fscrypt

# Build from source (latest version)
git clone https://github.com/google/fscrypt
cd fscrypt
make
sudo make install

# Verify installation
fscrypt --version
```

### Initialize fscrypt on a Filesystem

```bash
# Initialize fscrypt metadata on the filesystem
# This creates /.fscrypt directory with protector and policy databases
fscrypt setup /data

# Or initialize the global config (run once per system)
sudo fscrypt setup

# Check status
fscrypt status
```

### Global Configuration

```json
// /etc/fscrypt.conf
{
    "source": "custom_passphrase",
    "hash_costs": {
        "time": 100,
        "memory": 131072,
        "parallelism": 4
    },
    "options": {
        "padding": "32",
        "contents": "AES_256_XTS",
        "filenames": "AES_256_CTS",
        "policy_version": "2"
    }
}
```

## Section 4: Key Management and Policy Operations

### Creating an Encrypted Directory

```bash
# Create the target directory
mkdir -p /data/tenant-alice/documents

# Encrypt the directory with a new passphrase protector
fscrypt encrypt /data/tenant-alice/documents \
    --source=custom_passphrase \
    --name="alice-docs-key"
# Enter and confirm passphrase when prompted

# Verify encryption policy is applied
fscrypt status /data/tenant-alice/documents
# Output:
# "/data/tenant-alice/documents": encrypted
#   Policy: abc123def456...
#   Unlocked: Yes
#   Protected with: custom_passphrase protector "alice-docs-key"

# Check kernel keyring
keyctl show @s
```

### Locking and Unlocking Directories

```bash
# Lock the directory (remove key from kernel keyring)
fscrypt lock /data/tenant-alice/documents

# After locking, files appear encrypted
ls /data/tenant-alice/documents
# Output: gFPBIvCGnrUCPFkQiWzRkXRtMC8HGVL3  (encrypted filename)
cat /data/tenant-alice/documents/gFPBIvCGnrUCPFkQiWzRkXRtMC8HGVL3
# Error: required key not available

# Unlock with passphrase
fscrypt unlock /data/tenant-alice/documents
# Enter passphrase when prompted

# Now files are accessible
ls /data/tenant-alice/documents
# Output: report.pdf  invoice.xlsx  contract.docx
```

### Managing Protectors

```bash
# List all protectors on a filesystem
fscrypt status /data

# Add a second protector (e.g., recovery key) to a policy
fscrypt metadata create protector /data \
    --source=raw_key \
    --name="alice-recovery"
# Enter raw key (64 hex bytes)

# Add the protector to an existing policy
fscrypt metadata add-protector-to-policy \
    --protector=/data:protector-id \
    --policy=/data:policy-id

# Remove a protector from a policy
fscrypt metadata remove-protector-from-policy \
    --protector=/data:protector-id \
    --policy=/data:policy-id

# Destroy a protector (makes data permanently inaccessible if it's the only protector)
fscrypt metadata destroy --protector=/data:protector-id
```

### Using Raw Keys for Service Accounts

For automated systems, raw keys stored securely (e.g., in HashiCorp Vault) are preferable to passphrases:

```bash
# Generate a 64-byte random key
RAW_KEY=$(openssl rand -hex 64)

# Create a protector using a raw key
echo "$RAW_KEY" | fscrypt metadata create protector /data \
    --source=raw_key \
    --name="service-account-key" \
    --key=stdin

# Encrypt a directory using this protector
fscrypt encrypt /data/app-secrets \
    --protector=/data:$(fscrypt status /data | grep "service-account-key" | awk '{print $1}')

# Unlock from a script (pipe key from stdin)
echo "$RAW_KEY" | fscrypt unlock /data/app-secrets --key=stdin
```

## Section 5: PAM Integration for Login-Based Encryption

The `pam_fscrypt` module unlocks encrypted home directories on login, providing seamless user experience:

### PAM Configuration

```bash
# /etc/pam.d/common-auth (Debian/Ubuntu)
auth    required    pam_unix.so
auth    optional    pam_fscrypt.so

# /etc/pam.d/common-session
session    required    pam_unix.so
session    optional    pam_fscrypt.so

# /etc/pam.d/common-password
password    required    pam_unix.so
password    optional    pam_fscrypt.so  # Updates key when password changes
```

### Creating PAM-Protected Home Directories

```bash
# Create user
useradd -m -s /bin/bash alice

# Migrate home directory to encrypted storage
# First, encrypt the home directory
fscrypt encrypt /home/alice --source=pam_passphrase --user=alice
# alice's login password is now used to protect the encryption key

# Test: lock and unlock
sudo -u alice fscrypt lock /home/alice
# Home directory is now inaccessible (filenames encrypted)

# Login as alice - pam_fscrypt automatically unlocks
su - alice
# Home directory is unlocked

# Verify
fscrypt status /home/alice
# Should show: Unlocked: Yes
```

### PAM Integration Script for Provisioning

```bash
#!/bin/bash
# setup-encrypted-home.sh
# Sets up an encrypted home directory for a new user

set -euo pipefail

USERNAME="$1"
if [ -z "$USERNAME" ]; then
    echo "Usage: $0 <username>"
    exit 1
fi

# Create user if not exists
if ! id "$USERNAME" &>/dev/null; then
    useradd -m -s /bin/bash "$USERNAME"
fi

HOME_DIR="/home/$USERNAME"

# Ensure filesystem has fscrypt support
if ! fscrypt status "$HOME_DIR" 2>/dev/null | grep -q "encrypted"; then
    # Move existing home contents
    TEMP_DIR=$(mktemp -d)
    cp -a "$HOME_DIR/." "$TEMP_DIR/"

    # Encrypt the directory
    fscrypt encrypt "$HOME_DIR" \
        --source=pam_passphrase \
        --user="$USERNAME" \
        --skip-unlock

    # Restore contents (requires unlock first)
    echo "Encryption set up. User must log in to unlock and restore files."
    echo "Temporary backup at: $TEMP_DIR"
fi

echo "Encrypted home directory configured for $USERNAME"
```

## Section 6: Encryption Modes and Security Properties

### Available Encryption Modes

fscrypt supports several encryption modes for file contents and filenames:

```bash
# AES-256-XTS (recommended for contents on hardware with AES acceleration)
# AES-128-XTS (faster on some hardware)
# Adiantum (for hardware without AES acceleration, e.g., ARM Cortex-A53)

# AES-256-CTS-CBC (filename encryption)
# AES-128-CBC-ESSIV (legacy, not recommended)
# AES-256-HCTR2 (latest, provides best security + speed)
```

### Policy Version 2

fscrypt policy version 2 (kernel 5.4+) provides stronger security guarantees:

```bash
# Check kernel support for policy version 2
cat /sys/fs/ext4/$(basename $(findmnt -n -o SOURCE /))/crypto/policy_version

# Create with policy version 2 explicitly
fscrypt encrypt /data/secure-dir \
    --source=custom_passphrase \
    --name="policy-v2-key" \
    --options=policy_version=2
```

Policy version 2 improvements:
- Stronger key derivation (HKDF-SHA512 instead of AES-ECB)
- Prevents key reuse across policies
- Better protection against ciphertext correlation attacks

## Section 7: Kubernetes CSI Driver for Encrypted Volumes

For Kubernetes workloads, a CSI (Container Storage Interface) driver can provision fscrypt-encrypted volumes:

### Custom CSI Driver Overview

A production CSI driver for fscrypt requires three operations:
1. `CreateVolume`: Format an ext4 filesystem with encryption support
2. `NodeStageVolume`: Unlock the directory using a key from a Secret
3. `NodeUnstageVolume`: Lock the directory

```go
// csi/driver.go - Key portions of a fscrypt CSI driver
package main

import (
    "context"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"

    "github.com/container-storage-interface/spec/lib/go/csi"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type FscryptNodeServer struct {
    nodeID  string
    dataDir string
}

func (ns *FscryptNodeServer) NodeStageVolume(
    ctx context.Context,
    req *csi.NodeStageVolumeRequest,
) (*csi.NodeStageVolumeResponse, error) {

    volumeID := req.GetVolumeId()
    stagingPath := req.GetStagingTargetPath()
    secrets := req.GetSecrets()

    // Retrieve the raw key from the CSI secrets
    rawKey, ok := secrets["encryption-key"]
    if !ok {
        return nil, status.Error(codes.InvalidArgument, "encryption-key not provided in secrets")
    }

    // Create staging directory
    if err := os.MkdirAll(stagingPath, 0700); err != nil {
        return nil, status.Errorf(codes.Internal, "failed to create staging path: %v", err)
    }

    // Mount the block device
    devicePath := req.GetVolumeContext()["devicePath"]
    if err := mountDevice(devicePath, stagingPath); err != nil {
        return nil, status.Errorf(codes.Internal, "mount failed: %v", err)
    }

    // Set up fscrypt on the filesystem if needed
    fscryptDir := filepath.Join(stagingPath, ".fscrypt")
    if _, err := os.Stat(fscryptDir); os.IsNotExist(err) {
        cmd := exec.CommandContext(ctx, "fscrypt", "setup", stagingPath, "--force")
        if out, err := cmd.CombinedOutput(); err != nil {
            return nil, status.Errorf(codes.Internal, "fscrypt setup failed: %s: %v", out, err)
        }
    }

    // Create data directory
    dataDir := filepath.Join(stagingPath, "data")
    if err := os.MkdirAll(dataDir, 0700); err != nil {
        return nil, status.Errorf(codes.Internal, "failed to create data dir: %v", err)
    }

    // Encrypt the data directory with the provided key
    // Check if already encrypted
    cmd := exec.CommandContext(ctx, "fscrypt", "status", dataDir)
    if err := cmd.Run(); err != nil {
        // Not encrypted, encrypt it
        unlockCmd := exec.CommandContext(ctx, "fscrypt", "encrypt", dataDir,
            "--source=raw_key",
            "--name="+volumeID,
        )
        unlockCmd.Stdin = strings.NewReader(rawKey)
        if out, err := unlockCmd.CombinedOutput(); err != nil {
            return nil, status.Errorf(codes.Internal, "fscrypt encrypt failed: %s: %v", out, err)
        }
    } else {
        // Already encrypted, just unlock it
        unlockCmd := exec.CommandContext(ctx, "fscrypt", "unlock", dataDir)
        unlockCmd.Stdin = strings.NewReader(rawKey)
        if out, err := unlockCmd.CombinedOutput(); err != nil {
            return nil, status.Errorf(codes.Internal, "fscrypt unlock failed: %s: %v", out, err)
        }
    }

    return &csi.NodeStageVolumeResponse{}, nil
}

func (ns *FscryptNodeServer) NodeUnstageVolume(
    ctx context.Context,
    req *csi.NodeUnstageVolumeRequest,
) (*csi.NodeUnstageVolumeResponse, error) {

    stagingPath := req.GetStagingTargetPath()
    dataDir := filepath.Join(stagingPath, "data")

    // Lock the encrypted directory
    cmd := exec.CommandContext(ctx, "fscrypt", "lock", dataDir)
    if out, err := cmd.CombinedOutput(); err != nil {
        return nil, status.Errorf(codes.Internal, "fscrypt lock failed: %s: %v", out, err)
    }

    // Unmount
    if err := exec.CommandContext(ctx, "umount", stagingPath).Run(); err != nil {
        return nil, status.Errorf(codes.Internal, "umount failed: %v", err)
    }

    return &csi.NodeUnstageVolumeResponse{}, nil
}

func mountDevice(device, target string) error {
    cmd := exec.Command("mount", "-t", "ext4", device, target)
    if out, err := cmd.CombinedOutput(); err != nil {
        return fmt.Errorf("mount %s to %s failed: %s: %w", device, target, out, err)
    }
    return nil
}
```

### Kubernetes Secret for Encryption Key

```yaml
# fscrypt-key-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: fscrypt-volume-key
  namespace: secure-workloads
type: Opaque
stringData:
  # In production, this would be fetched from Vault or AWS KMS
  # The key must be 64 hex-encoded bytes
  encryption-key: "<64-byte-hex-encoded-raw-key-from-vault>"
```

### StorageClass and PVC

```yaml
# storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fscrypt-encrypted
provisioner: fscrypt.csi.example.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

```yaml
# pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: secure-data
  namespace: secure-workloads
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fscrypt-encrypted
  resources:
    requests:
      storage: 10Gi
```

```yaml
# pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
  namespace: secure-workloads
spec:
  containers:
    - name: app
      image: myapp:latest
      volumeMounts:
        - name: secure-data
          mountPath: /data
  volumes:
    - name: secure-data
      persistentVolumeClaim:
        claimName: secure-data
  # CSI secret reference for key injection
  # (implementation-specific to CSI driver)
```

## Section 8: Key Rotation

Key rotation with fscrypt is more granular than with LUKS. You can rotate the key for a specific directory without re-encrypting the entire volume, but you must re-encrypt all files in the directory tree:

```bash
# Key rotation procedure for a fscrypt-protected directory

ENCRYPTED_DIR=/data/tenant-alice/documents

# Step 1: Create a temporary unencrypted directory
TEMP_DIR=$(mktemp -d)

# Step 2: Copy all files out (they decrypt to temp storage)
rsync -a --remove-source-files "$ENCRYPTED_DIR/" "$TEMP_DIR/"

# Step 3: Lock the directory
fscrypt lock "$ENCRYPTED_DIR"

# Step 4: Destroy the old policy and protector
# Get policy and protector IDs
fscrypt status "$ENCRYPTED_DIR"
OLD_PROTECTOR_ID=$(fscrypt status /data | grep "alice-docs-key" | awk '{print $1}')

# Step 5: Re-encrypt with a new key
fscrypt encrypt "$ENCRYPTED_DIR" \
    --source=custom_passphrase \
    --name="alice-docs-key-v2"

# Step 6: Copy files back in (they will be encrypted with the new key)
rsync -a "$TEMP_DIR/" "$ENCRYPTED_DIR/"
rm -rf "$TEMP_DIR"

# Step 7: Remove old protector
fscrypt metadata destroy --protector=/data:"$OLD_PROTECTOR_ID"

echo "Key rotation complete"
```

### Automated Key Rotation Script

```bash
#!/bin/bash
# rotate-fscrypt-key.sh
# Rotates the encryption key for a fscrypt directory using Vault

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
VAULT_TOKEN="${VAULT_TOKEN}"
SECRET_PATH="$1"  # e.g., secret/data/fscrypt/tenant-alice
ENCRYPTED_DIR="$2"

# Fetch new key from Vault
NEW_KEY=$(vault kv get -field=key "$SECRET_PATH")

# Get old key (for unlocking)
OLD_KEY=$(vault kv get -field=old_key "$SECRET_PATH")

# Unlock with old key
echo "$OLD_KEY" | fscrypt unlock "$ENCRYPTED_DIR" --key=stdin

# Stage files
TEMP_DIR=$(mktemp -d)
rsync -a --remove-source-files "$ENCRYPTED_DIR/" "$TEMP_DIR/"

# Re-encrypt with new key
PROTECTOR_NAME="$(basename $ENCRYPTED_DIR)-$(date +%Y%m%d)"
echo "$NEW_KEY" | fscrypt encrypt "$ENCRYPTED_DIR" \
    --source=raw_key \
    --name="$PROTECTOR_NAME" \
    --key=stdin

# Restore files
rsync -a "$TEMP_DIR/" "$ENCRYPTED_DIR/"
rm -rf "$TEMP_DIR"

echo "Key rotation complete for $ENCRYPTED_DIR"
```

## Section 9: Auditing Encrypted File Access

Monitoring access to encrypted directories requires combining filesystem audit rules with fscrypt's key management:

### auditd Configuration

```bash
# Add audit rules for fscrypt key operations
# Monitor keyctl syscalls (used by fscrypt to add/remove keys)
auditctl -a always,exit -F arch=b64 -S keyctl -k fscrypt_key_ops

# Monitor access to fscrypt policy files
auditctl -w /data/.fscrypt -p rwxa -k fscrypt_policy

# Monitor directory access
auditctl -w /data/tenant-alice -p rwxa -k alice_data_access

# Persist rules
cat >> /etc/audit/rules.d/fscrypt.rules << 'EOF'
-a always,exit -F arch=b64 -S keyctl -k fscrypt_key_ops
-w /data/.fscrypt -p rwxa -k fscrypt_policy
EOF
service auditd reload
```

### Monitoring fscrypt Lock/Unlock Events

```bash
# Watch for fscrypt unlock attempts (successful key additions)
ausearch -k fscrypt_key_ops -ts recent | aureport -i

# Parse auditd logs for fscrypt events
journalctl -k | grep -i fscrypt

# Monitor with auditd in real time
tail -f /var/log/audit/audit.log | grep fscrypt
```

### Custom Audit Logging with inotify

```go
// audit/fscrypt_monitor.go
package audit

import (
    "context"
    "fmt"
    "log/slog"

    "github.com/fsnotify/fsnotify"
)

type FscryptAuditMonitor struct {
    watcher *fsnotify.Watcher
    logger  *slog.Logger
}

func NewFscryptAuditMonitor(logger *slog.Logger) (*FscryptAuditMonitor, error) {
    w, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, fmt.Errorf("failed to create watcher: %w", err)
    }
    return &FscryptAuditMonitor{watcher: w, logger: logger}, nil
}

func (m *FscryptAuditMonitor) WatchDirectory(dir string) error {
    return m.watcher.Add(dir)
}

func (m *FscryptAuditMonitor) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            m.watcher.Close()
            return
        case event, ok := <-m.watcher.Events:
            if !ok {
                return
            }
            m.logger.Info("fscrypt directory event",
                "operation", event.Op.String(),
                "path", event.Name,
            )
        case err, ok := <-m.watcher.Errors:
            if !ok {
                return
            }
            m.logger.Error("fscrypt watcher error", "error", err)
        }
    }
}
```

## Section 10: Verifying Encryption is Active

It is critical to verify that files are actually encrypted before relying on fscrypt for security:

```bash
# Verify encryption policy on a directory
fscrypt status /data/tenant-alice/documents
# Should show: encrypted, Policy: <id>, Unlocked: Yes/No

# Verify at the filesystem level using getfattr
getfattr -n encryption.policy /data/tenant-alice/documents/
# Should return: encryption.policy=<policy-id-hex>

# Lock the directory and verify files are unreadable
fscrypt lock /data/tenant-alice/documents
cat /data/tenant-alice/documents/report.pdf
# Expected: Operation not permitted (required key not available)

# List directory - filenames should be encrypted
ls /data/tenant-alice/documents
# Output: random-looking names like gFPBIvCGnrUCPFkQiWzRkXRtMC8H

# Check kernel keyring for encryption keys
keyctl show @s | grep fscrypt
# Should show no fscrypt keys when locked

# Unlock and verify access restored
fscrypt unlock /data/tenant-alice/documents
ls /data/tenant-alice/documents
# Output: report.pdf invoice.xlsx contract.docx (readable filenames)
```

### Automated Encryption Verification Script

```bash
#!/bin/bash
# verify-fscrypt.sh
# Verifies fscrypt encryption is properly configured

set -euo pipefail

DIR="$1"

# Check fscrypt status
if ! fscrypt status "$DIR" 2>&1 | grep -q "encrypted"; then
    echo "FAIL: $DIR is not encrypted"
    exit 1
fi

echo "PASS: $DIR has fscrypt encryption policy applied"

# Verify kernel has the key loaded (directory should be unlocked)
if fscrypt status "$DIR" | grep -q "Unlocked: Yes"; then
    echo "INFO: $DIR is currently unlocked (key in kernel keyring)"
else
    echo "INFO: $DIR is currently locked (key not in kernel keyring)"
fi

# Check encryption mode
fscrypt status "$DIR" | grep -E "Contents|Filenames" || true

echo "Verification complete for $DIR"
```

## Section 11: Performance Benchmarking

Understanding fscrypt performance overhead helps with capacity planning:

```bash
# Benchmark file operations with and without fscrypt

# Baseline: unencrypted
mkdir -p /data/benchmark-plain
time dd if=/dev/urandom of=/data/benchmark-plain/test.bin bs=1M count=1000 conv=fdatasync

# fscrypt encrypted
mkdir -p /data/benchmark-encrypted
fscrypt encrypt /data/benchmark-encrypted --source=custom_passphrase --name=bench-key
time dd if=/dev/urandom of=/data/benchmark-encrypted/test.bin bs=1M count=1000 conv=fdatasync

# Compare read performance
time dd if=/data/benchmark-plain/test.bin of=/dev/null bs=1M
time dd if=/data/benchmark-encrypted/test.bin of=/dev/null bs=1M

# More comprehensive benchmark with fio
fio --name=fscrypt-randread \
    --directory=/data/benchmark-encrypted \
    --rw=randread \
    --bs=4k \
    --size=1G \
    --numjobs=4 \
    --iodepth=32 \
    --runtime=60 \
    --group_reporting

# Typical results on modern hardware with AES-NI:
# Sequential write: 2-5% overhead
# Random 4K read: 5-15% overhead (key derivation per file open)
# Large sequential read: <2% overhead
```

## Section 12: Troubleshooting

### Common Issues and Solutions

**Error: "Required key not available"**
```bash
# Directory is locked. Unlock it:
fscrypt unlock /path/to/encrypted/dir

# If you've lost the key, data is unrecoverable
# Verify you have the correct key protector:
fscrypt status /mountpoint
```

**Error: "Filesystem does not support encryption"**
```bash
# Check that the filesystem has the encrypt feature
tune2fs -l /dev/sdXN | grep features
# If missing, add it (requires unmount):
tune2fs -O encrypt /dev/sdXN

# For F2FS, check:
fsck.f2fs -l /dev/sdXN | grep encrypt
```

**Error: "fscrypt setup: filesystem not supported"**
```bash
# Verify kernel version
uname -r  # Need 4.1+ for ext4, 4.2+ for F2FS

# Check kernel config
grep CONFIG_FS_ENCRYPTION /boot/config-$(uname -r)
# Should be: CONFIG_FS_ENCRYPTION=y
```

**PAM unlock not working after password change**
```bash
# Re-link the protector with new password hash
# pam_fscrypt should handle this, but manual steps if needed:
fscrypt metadata change-passphrase --protector=/home:protector-id

# Check PAM configuration
grep fscrypt /etc/pam.d/common-session
grep fscrypt /etc/pam.d/common-password
```

## Conclusion

fscrypt provides an efficient, kernel-integrated solution for per-directory encryption that complements rather than competes with LUKS block-level encryption. Its integration with the Linux keyring, PAM authentication system, and audit framework makes it suitable for multi-tenant systems, application data protection, and cloud-native workloads. For Kubernetes deployments, a custom CSI driver wrapping fscrypt enables encrypted persistent volumes with key injection from existing secret management infrastructure. The key operational discipline is rigorous key management: always maintain multiple protectors for important directories, use Vault or a hardware KMS for production keys, and regularly verify that encryption policies are applied and enforced.
