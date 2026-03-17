---
title: "Linux Filesystem Encryption: dm-crypt, LUKS2, and fscrypt"
date: 2029-11-12T00:00:00-05:00
draft: false
tags: ["Linux", "Encryption", "LUKS2", "dm-crypt", "fscrypt", "Security", "Kubernetes", "Storage"]
categories:
- Linux
- Security
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux filesystem encryption: LUKS2 header format and keyslots, Argon2 KDF, dm-crypt performance optimization, fscrypt for per-directory encryption, and Kubernetes encrypted persistent volumes."
more_link: "yes"
url: "/linux-filesystem-encryption-dm-crypt-luks2-fscrypt/"
---

Encryption at rest is a compliance requirement for most regulated industries and a security best practice for all production systems. Linux provides two complementary approaches: dm-crypt/LUKS2 for full-disk or partition encryption at the block device layer, and fscrypt for per-directory encryption within existing filesystems. This post covers both approaches with production-ready configurations.

<!--more-->

# Linux Filesystem Encryption: dm-crypt, LUKS2, and fscrypt

## Understanding the Encryption Layers

Linux block device encryption sits in the kernel's device mapper framework:

```
Application
    │
Filesystem (ext4, xfs, etc.)
    │
dm-crypt (device mapper layer)
    │  ↑ Transparent encrypt/decrypt on every block
    │
Block Device (/dev/sdb, NVMe, etc.)
    │
Physical Storage
```

fscrypt operates at the filesystem layer:

```
Application
    │
Filesystem (ext4, F2FS with fscrypt support)
    │  ↑ Per-file/directory encryption keys
    │
Block Device (unencrypted at block level)
    │
Physical Storage
```

The key difference: dm-crypt encrypts everything on the device (including file metadata, directory structure, free space); fscrypt encrypts individual files and directories but leaves the directory tree and metadata visible.

## LUKS2 Architecture

LUKS2 (Linux Unified Key Setup version 2) is the metadata format that wraps dm-crypt. It stores:
- Master volume key (encrypted by one or more passphrases/key files)
- Up to 32 keyslots (each can unlock the volume independently)
- JSON-based header with extensible metadata
- PBKDF parameters per keyslot

### LUKS2 Header Format

```
LUKS2 Header:
┌────────────────────────────────────────┐
│ Binary Header (4096 bytes)             │
│  - Magic: "LUKS\xba\xbe"              │
│  - Version: 2                          │
│  - Header size                         │
│  - Sequence number (for redundancy)    │
│  - Label                               │
│  - Checksum algorithm                  │
│  - Salt (64 bytes)                     │
│  - UUID                                │
│  - Subsystem                           │
│  - Header offset                       │
│  - Header checksum                     │
├────────────────────────────────────────┤
│ JSON Metadata Area (variable)          │
│  - keyslots: {0..31}                   │
│    - type: "luks2"                     │
│    - kdf: argon2id params              │
│    - cipher: "aes-xts-plain64"         │
│    - encrypted_key (base64)            │
│  - tokens: {} (for TPM, etc.)          │
│  - segments: {0: data segment}         │
│  - digests: {0: master key digest}     │
│  - config: {}                          │
├────────────────────────────────────────┤
│ Redundant Header Copy (offset 16KB)    │
├────────────────────────────────────────┤
│ Keyslot Area (variable, default 32MB)  │
│  - Encrypted master key material       │
│    for each keyslot                    │
├────────────────────────────────────────┤
│ Data Area                              │
│  - Encrypted volume data               │
└────────────────────────────────────────┘
```

## Creating and Managing LUKS2 Volumes

### Basic LUKS2 Setup

```bash
# Install cryptsetup (modern version with LUKS2 support)
apt-get install -y cryptsetup cryptsetup-initramfs

# Verify LUKS2 support
cryptsetup --version

# Create LUKS2 container with strong defaults
# --type luks2: use LUKS2 format
# --cipher aes-xts-plain64: AES in XTS mode (standard for disk encryption)
# --key-size 512: 512-bit key for XTS = two 256-bit AES keys
# --hash sha512: hash algorithm for PBKDF
# --pbkdf argon2id: Argon2id PBKDF (LUKS2 default, LUKS1 uses PBKDF2)
# --iter-time 2000: target 2 seconds for PBKDF (adjust for your hardware)
cryptsetup luksFormat \
    --type luks2 \
    --cipher aes-xts-plain64 \
    --key-size 512 \
    --hash sha512 \
    --pbkdf argon2id \
    --iter-time 2000 \
    --label "DATA_VOLUME" \
    /dev/sdb

# Open the LUKS volume
cryptsetup luksOpen /dev/sdb encrypted_data

# Creates /dev/mapper/encrypted_data

# Create filesystem on encrypted device
mkfs.xfs /dev/mapper/encrypted_data

# Mount
mkdir -p /mnt/encrypted
mount /dev/mapper/encrypted_data /mnt/encrypted
```

### Argon2 PBKDF Configuration

LUKS2's default Argon2id parameters adapt to hardware speed. Understanding them is important for security/performance tradeoffs:

```bash
# Check current PBKDF parameters for keyslot 0
cryptsetup luksDump /dev/sdb

# Example output for PBKDF section:
# Keyslot 0:
#   Type:       luks2
#   Cipher:     aes-xts-plain64
#   Cipher key: 512 bits
#   PBKDF:      argon2id
#     Time cost:   4
#     Memory:      1048576  (1GB)
#     Threads:     4
#   Salt:       ...

# Override PBKDF parameters for a specific keyslot
# Lower memory for embedded devices, higher for workstations
cryptsetup luksChangeKey \
    --pbkdf argon2id \
    --pbkdf-memory 2097152 \  # 2GB memory
    --pbkdf-parallel 4 \
    --pbkdf-time-cost 8 \
    /dev/sdb

# Or set specific parameters at format time:
cryptsetup luksFormat \
    --type luks2 \
    --pbkdf argon2id \
    --pbkdf-memory 1048576 \    # 1GB
    --pbkdf-parallel 4 \
    --pbkdf-time-cost 4 \
    /dev/sdb
```

### Multiple Keyslots

LUKS2 supports up to 32 keyslots, each independently unlocking the same master key:

```bash
# Add a keyfile as a backup keyslot (slot 1)
# Generate a 4096-byte random keyfile
dd if=/dev/urandom of=/etc/luks/data-keyfile bs=4096 count=1
chmod 400 /etc/luks/data-keyfile

# Add keyfile to LUKS (you'll need to enter the passphrase)
cryptsetup luksAddKey --key-slot 1 /dev/sdb /etc/luks/data-keyfile

# List all active keyslots
cryptsetup luksDump /dev/sdb | grep -A2 "Keyslot"

# Open with keyfile
cryptsetup luksOpen --key-file /etc/luks/data-keyfile /dev/sdb encrypted_data

# Remove a keyslot (need master passphrase or another key)
cryptsetup luksKillSlot /dev/sdb 1

# Check which keyslot a passphrase uses
cryptsetup luksOpen --test-passphrase --verbose /dev/sdb
```

### Automated Mounting with crypttab

```bash
# Get LUKS UUID
cryptsetup luksUUID /dev/sdb
# Output: a1b2c3d4-e5f6-7890-abcd-ef1234567890

# /etc/crypttab format:
# name  device        key-file   options
cat >> /etc/crypttab << 'EOF'
# Full disk encryption with passphrase at boot
encrypted_data  UUID=a1b2c3d4-e5f6-7890-abcd-ef1234567890  none  luks,discard

# With keyfile (for servers that need unattended boot)
encrypted_data2  UUID=b2c3d4e5-f6a7-8901-bcde-f23456789012  /etc/luks/keyfile  luks,discard,noearly

# Options:
# discard: allow TRIM commands (performance on SSD, but leaks metadata)
# noearly: mount after network is available (for network-stored keys)
# keyfile-size=: limit keyfile size read
# keyfile-offset=: skip bytes in keyfile
EOF

# /etc/fstab for the decrypted volume
echo "/dev/mapper/encrypted_data  /mnt/data  xfs  defaults,noatime  0  2" >> /etc/fstab

# Update initramfs
update-initramfs -u -k all
```

## dm-crypt Performance Optimization

### Benchmarking Cipher Performance

```bash
# Benchmark available ciphers
cryptsetup benchmark

# Example output:
# Tests are approximate using memory only (no storage IO).
# PBKDF2-sha1        1347906 iterations per second for 256-bit key
# PBKDF2-sha256      1012345 iterations per second for 256-bit key
# argon2i          7 iterations per second for 256-bit key (256MB memory)
# argon2id         7 iterations per second for 256-bit key (256MB memory)
# #     Algorithm |       Key |      Encryption |      Decryption
#          aes-cbc        128b      2054.0 MiB/s      5821.4 MiB/s
#          aes-cbc        256b      1512.4 MiB/s      4401.8 MiB/s
#          aes-xts        256b      1987.5 MiB/s      1993.5 MiB/s
#          aes-xts        512b      1498.5 MiB/s      1489.0 MiB/s

# Check for hardware AES support (critical for performance)
grep -w aes /proc/cpuinfo

# Check if AES-NI is active
openssl speed -evp aes-256-gcm 2>&1 | tail -3

# With AES-NI: ~3-5 GB/s
# Without AES-NI: ~200-400 MB/s
```

### Tuning dm-crypt for SSD/NVMe

```bash
# Create device with optimal settings for NVMe
cryptsetup luksFormat \
    --type luks2 \
    --cipher aes-xts-plain64 \
    --key-size 512 \
    --sector-size 4096 \    # Match NVMe physical sector size
    --align-payload 2048 \   # Align to 2048 sectors = 1MB boundary
    /dev/nvme0n1p1

# Enable TRIM for SSD (reduces security: reveals which blocks are free)
# Use only if acceptable for your threat model
cryptsetup luksOpen --allow-discards /dev/nvme0n1p1 encrypted_nvme

# Persistent TRIM enablement via crypttab
echo "encrypted_nvme  UUID=xxx  none  luks,discard" >> /etc/crypttab

# Check current queue settings on the mapped device
cat /sys/block/dm-0/queue/rotational   # 0 = non-rotational (SSD)
cat /sys/block/dm-0/queue/scheduler    # scheduler

# Set I/O scheduler for dm-crypt device (none for NVMe)
echo none > /sys/block/dm-0/queue/scheduler
```

### dm-crypt Performance Tuning

```bash
# Increase the number of crypto threads for high-throughput workloads
# The default is 1 per device; increase for parallel I/O

# Check current perf settings
dmsetup table encrypted_data

# Use keysize 256 instead of 512 if you need faster single-thread perf
# (XTS-256 = one 128-bit AES key, faster than XTS-512)
# Note: 256-bit AES is already quantum-resistant beyond practical attacks

# Enable read-ahead on the underlying device
blockdev --setra 4096 /dev/sdb  # 4096 * 512 bytes = 2MB read-ahead

# Check encryption overhead
dd if=/dev/zero of=/tmp/test bs=1G count=1 oflag=direct  # Raw device speed
dd if=/dev/zero of=/dev/mapper/encrypted_data bs=1G count=1 oflag=direct  # Encrypted
```

## fscrypt: Per-Directory Encryption

fscrypt provides encryption at the filesystem level, allowing different directories to be encrypted with different keys. It's used by Android, Chrome OS, and can be used in Linux for multi-user or multi-tenant scenarios.

### fscrypt Architecture

```
/data/
├── user_alice/            # Encrypted with Alice's key
│   ├── documents/
│   └── photos/
├── user_bob/              # Encrypted with Bob's key
│   └── documents/
└── shared/                # Unencrypted (or different key)

Each directory has metadata:
  - Encryption policy (algorithm, key version)
  - Key descriptor (identifies which key to use)
  - Nonce (per-file IV seed)
```

### Setting Up fscrypt

```bash
# Install fscrypt tool
apt-get install -y fscrypt

# Enable fscrypt on the filesystem (ext4 must be version >= 1.43)
# Requires tune2fs to enable the encryption feature
tune2fs -O encrypt /dev/sdb1

# Initialize fscrypt
fscrypt setup
# Creates /etc/fscrypt.conf with default settings

# Setup on a specific filesystem
fscrypt setup /mnt/data

# This creates /mnt/data/.fscrypt/ directory with metadata

# Verify
tune2fs -l /dev/sdb1 | grep features
# Should include: encrypt
```

### Creating Encrypted Directories

```bash
# Create a new encrypted directory
mkdir -p /mnt/data/user_alice
fscrypt encrypt /mnt/data/user_alice

# Choose a protector:
# 1: Your login passphrase
# 2: A new custom passphrase
# 3: Your login passphrase with a keyfile

# Or automate with a specific protector
fscrypt encrypt \
    --source=custom_passphrase \
    --name=alice_key \
    /mnt/data/user_alice

# Verify encryption status
fscrypt status /mnt/data/user_alice
# Should show: Encrypted

# List all encrypted directories
fscrypt status /mnt/data

# Lock directory (remove keys from kernel keyring)
fscrypt lock /mnt/data/user_alice

# Files become inaccessible (filenames appear as random bytes)
ls /mnt/data/user_alice/
# gT5x9mV3oQp1nR2s  (encrypted filename)

# Unlock
fscrypt unlock /mnt/data/user_alice
```

### fscrypt Kernel Interface

For applications that need programmatic fscrypt control:

```bash
# Kernel fscrypt is controlled via ioctl on the directory
# The ioctl interface uses fscrypt_policy_v2 structure

# Key identifiers are 16-byte values derived from the key material
# Keys are loaded into the kernel keyring

# Add a key to the kernel keyring for fscrypt
fscrypt_key_add() {
    local KEY_HEX=$1
    local FSROOT=$2

    # Convert hex to binary and add to filesystem keyring
    printf '%s' "$KEY_HEX" | xxd -r -p | \
        keyctl padd logon "fscrypt:$(echo "$KEY_HEX" | sha256sum | head -c16)" @s
}

# Direct kernel interface via ioctl (requires C code or ioctl tool)
# FS_IOC_ADD_ENCRYPTION_KEY
# FS_IOC_REMOVE_ENCRYPTION_KEY
# FS_IOC_GET_ENCRYPTION_KEY_STATUS
# FS_IOC_SET_ENCRYPTION_POLICY
# FS_IOC_GET_ENCRYPTION_POLICY
```

### Go Implementation for fscrypt Control

```go
package fscrypt

import (
    "crypto/sha256"
    "encoding/binary"
    "encoding/hex"
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// fscryptPolicyV2 corresponds to struct fscrypt_policy_v2
type fscryptPolicyV2 struct {
    Version                   uint8
    ContentsCipher            uint8
    FilenamesCipher           uint8
    Flags                     uint8
    LogDataUnitSize           uint8
    Reserved                  [3]uint8
    MasterKeyIdentifier       [16]byte
}

// fscryptAddKeyArg corresponds to struct fscrypt_add_key_arg
type fscryptAddKeyArg struct {
    KeySpec struct {
        Type       uint32
        Reserved   uint32
        Identifier [16]byte
    }
    AuthPolicySize uint32
    Flags          uint32
    KeySize        uint32
    Reserved       [8]uint32
    Raw            [64]byte
}

const (
    // FS_IOC_SET_ENCRYPTION_POLICY
    fsIocSetEncryptionPolicy = 0x400c6613
    // FS_IOC_ADD_ENCRYPTION_KEY
    fsIocAddEncryptionKey = 0xc0506617
    // FS_IOC_REMOVE_ENCRYPTION_KEY
    fsIocRemoveEncryptionKey = 0xc0106618

    // Cipher suites
    fsEncryptionModeAES256XTS = 1  // For file contents
    fsEncryptionModeAES256CTS = 4  // For filenames

    // Key spec type
    fsKeySpecTypeIdentifier = 2
)

// EncryptDirectory sets an fscrypt policy on a directory
func EncryptDirectory(dirPath string, masterKey []byte) error {
    if len(masterKey) != 64 {
        return fmt.Errorf("fscrypt master key must be 64 bytes")
    }

    // Derive key identifier from master key
    identifier := deriveKeyIdentifier(masterKey)

    // Open directory
    dir, err := os.Open(dirPath)
    if err != nil {
        return fmt.Errorf("opening directory: %w", err)
    }
    defer dir.Close()

    // Set encryption policy
    policy := fscryptPolicyV2{
        Version:             2,
        ContentsCipher:      fsEncryptionModeAES256XTS,
        FilenamesCipher:     fsEncryptionModeAES256CTS,
        Flags:               0x04,  // IV_INO_LBLK_64: more efficient for small files
    }
    copy(policy.MasterKeyIdentifier[:], identifier)

    _, _, errno := syscall.Syscall(
        syscall.SYS_IOCTL,
        dir.Fd(),
        fsIocSetEncryptionPolicy,
        uintptr(unsafe.Pointer(&policy)),
    )
    if errno != 0 {
        return fmt.Errorf("setting encryption policy: %w", errno)
    }

    return nil
}

// AddKey adds a master key to the filesystem keyring
func AddKey(fsRoot string, masterKey []byte) ([16]byte, error) {
    if len(masterKey) > 64 {
        return [16]byte{}, fmt.Errorf("key too large: %d > 64 bytes", len(masterKey))
    }

    fsRoot_dir, err := os.Open(fsRoot)
    if err != nil {
        return [16]byte{}, fmt.Errorf("opening filesystem root: %w", err)
    }
    defer fsRoot_dir.Close()

    var arg fscryptAddKeyArg
    arg.KeySpec.Type = fsKeySpecTypeIdentifier
    arg.KeySize = uint32(len(masterKey))
    copy(arg.Raw[:], masterKey)

    _, _, errno := syscall.Syscall(
        syscall.SYS_IOCTL,
        fsRoot_dir.Fd(),
        fsIocAddEncryptionKey,
        uintptr(unsafe.Pointer(&arg)),
    )
    if errno != 0 {
        return [16]byte{}, fmt.Errorf("adding fscrypt key: %w", errno)
    }

    return arg.KeySpec.Identifier, nil
}

// deriveKeyIdentifier derives the 16-byte key identifier from master key
func deriveKeyIdentifier(masterKey []byte) []byte {
    h := sha256.Sum256(masterKey)
    return h[:16]
}
```

## Kubernetes Encrypted Persistent Volumes

### StorageClass with Encryption

```yaml
# encrypted-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: encrypted-ssd
provisioner: ebs.csi.aws.com  # AWS EBS CSI driver example
parameters:
  type: gp3
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/mrk-xxx"
  throughput: "125"
  iops: "3000"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
---
# For GCP (Google Persistent Disk CSI)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: encrypted-ssd-gke
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  disk-encryption-kms-key: "projects/myproject/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key"
reclaimPolicy: Retain
allowVolumeExpansion: true
---
# For Azure (Azure Disk CSI)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: encrypted-ssd-aks
provisioner: disk.csi.azure.com
parameters:
  skuname: Premium_LRS
  diskEncryptionType: EncryptionAtRestWithCustomerKey
  diskEncryptionSetID: /subscriptions/xxx/resourceGroups/xxx/providers/Microsoft.Compute/diskEncryptionSets/xxx
reclaimPolicy: Retain
allowVolumeExpansion: true
```

### In-Cluster Encryption with LUKS

For bare-metal Kubernetes where CSI-provided encryption isn't available, you can use LUKS at the node level:

```yaml
# DaemonSet to manage LUKS volumes on nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: luks-volume-manager
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: luks-volume-manager
  template:
    metadata:
      labels:
        app: luks-volume-manager
    spec:
      hostPID: true
      nodeSelector:
        storage-node: "true"
      initContainers:
      - name: setup-luks
        image: alpine:latest
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          apk add --no-cache cryptsetup

          # Get key from Kubernetes secret (stored in environment)
          echo "$LUKS_KEY" | cryptsetup luksOpen \
              --key-file - \
              /dev/sdb \
              encrypted-storage \
              || cryptsetup luksFormat \
                  --type luks2 \
                  --batch-mode \
                  --key-file - \
                  /dev/sdb <<< "$LUKS_KEY"

          # Mount if not already mounted
          if ! mountpoint -q /mnt/encrypted; then
              mkdir -p /mnt/encrypted
              mount /dev/mapper/encrypted-storage /mnt/encrypted || \
              (mkfs.xfs /dev/mapper/encrypted-storage && \
               mount /dev/mapper/encrypted-storage /mnt/encrypted)
          fi
        env:
        - name: LUKS_KEY
          valueFrom:
            secretKeyRef:
              name: luks-key
              key: key
        volumeMounts:
        - name: dev
          mountPath: /dev
        - name: encrypted-mount
          mountPath: /mnt/encrypted
      containers:
      - name: keepalive
        image: pause:3.9
      volumes:
      - name: dev
        hostPath:
          path: /dev
      - name: encrypted-mount
        hostPath:
          path: /mnt/encrypted
```

### Kubernetes Secrets Encryption at Rest

Kubernetes etcd can encrypt secrets at the API server level:

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  # AES-GCM (preferred - authenticated encryption)
  - aesgcm:
      keys:
      - name: key1
        secret: <base64-encoded-32-byte-key>

  # AES-CBC (older, still supported)
  # - aescbc:
  #     keys:
  #     - name: key1
  #       secret: <base64-encoded-32-byte-key>

  # KMS provider for HSM/cloud KMS integration
  - kms:
      apiVersion: v2
      name: myKMSPlugin
      endpoint: unix:///var/run/kms.sock
      timeout: 3s

  # Identity (no encryption) - must be last for reading unencrypted secrets
  - identity: {}
```

```bash
# Apply encryption config to kube-apiserver
# Add to /etc/kubernetes/manifests/kube-apiserver.yaml:
# --encryption-provider-config=/etc/kubernetes/encryption-config.yaml

# Rotate existing secrets to encrypt them
kubectl get secrets --all-namespaces -o json | \
    kubectl replace -f -

# Verify a secret is encrypted in etcd
ETCDCTL_API=3 etcdctl get \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
    --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
    /registry/secrets/default/mysecret | xxd | head -5

# Should show: k8s:enc:aesgcm:v1:key1: ... (not plaintext)
```

## Encryption Key Management

### Using a Hardware Security Module (HSM)

```bash
# PKCS#11 integration with cryptsetup for HSM-stored keys
# Install PKCS#11 provider
apt-get install -y opensc

# Create LUKS token using PKCS#11
cryptsetup token add \
    --token-type pkcs11 \
    --token-id 0 \
    /dev/sdb

# Or use Tang for network-based key management (Shamir's Secret Sharing)
# Install Tang server
apt-get install -y tang

# Create LUKS binding to Tang server
clevis luks bind -d /dev/sdb tang '{"url":"http://tang.internal:7500"}'

# Unlock using Tang (requires network access to Tang server)
clevis luks unlock -d /dev/sdb
```

### Clevis: Policy-Based Key Management

```bash
# Install Clevis
apt-get install -y clevis clevis-luks clevis-tpm2

# Bind LUKS to TPM2 (unlock using TPM - no passphrase needed at boot)
clevis luks bind -d /dev/sdb tpm2 '{"pcr_bank":"sha256","pcr_ids":"0,1,7"}'

# Bind to multiple policies (Tang OR TPM2)
clevis luks bind -d /dev/sdb sss '{"t":1,"pins":{"tang":{"url":"http://tang.internal:7500"},"tpm2":{"pcr_bank":"sha256","pcr_ids":"7"}}}'

# List bindings
clevis luks list -d /dev/sdb

# Unbind a policy
clevis luks unbind -d /dev/sdb -s 1

# Test unlock (dry run)
clevis luks unlock -d /dev/sdb -n
```

## Performance Comparison

```bash
#!/bin/bash
# bench-encryption.sh - Benchmark various encryption configurations

echo "=== Raw disk speed ==="
dd if=/dev/zero of=/dev/sdb bs=1G count=5 oflag=direct 2>&1 | tail -1

echo "=== LUKS2 AES-XTS-512 (AES-NI) ==="
cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 \
    --batch-mode --key-file /dev/urandom --keyfile-size 32 /dev/sdb
cryptsetup luksOpen --key-file /dev/urandom --keyfile-size 32 /dev/sdb bench_test
dd if=/dev/zero of=/dev/mapper/bench_test bs=1G count=5 oflag=direct 2>&1 | tail -1
cryptsetup luksClose bench_test

echo "=== LUKS2 ChaCha20 ==="
cryptsetup luksFormat --type luks2 --cipher chacha20-random \
    --batch-mode --key-file /dev/urandom --keyfile-size 32 /dev/sdb
cryptsetup luksOpen --key-file /dev/urandom --keyfile-size 32 /dev/sdb bench_test
dd if=/dev/zero of=/dev/mapper/bench_test bs=1G count=5 oflag=direct 2>&1 | tail -1
cryptsetup luksClose bench_test

echo "=== fscrypt overhead ==="
# Create ext4 with encryption support
mkfs.ext4 -O encrypt /dev/sdc1
mount /dev/sdc1 /mnt/benchmark

# Without encryption
time dd if=/dev/zero of=/mnt/benchmark/test_clear bs=1G count=5 oflag=direct

# With fscrypt
mkdir /mnt/benchmark/encrypted
fscrypt encrypt --quiet /mnt/benchmark/encrypted
time dd if=/dev/zero of=/mnt/benchmark/encrypted/test_enc bs=1G count=5 oflag=direct
```

## Auditing and Monitoring

```bash
# Monitor dm-crypt in use
dmsetup ls --target crypt

# Check LUKS device status
cryptsetup status encrypted_data

# View key slots in use
cryptsetup luksDump /dev/sdb | grep -E "Keyslot|State"

# Check kernel audit log for encryption events
ausearch -k crypto --start today

# Monitor for LUKS header backups (critical for disaster recovery)
# The LUKS header backup contains enough to reconstruct the header
# if it gets corrupted

# Backup LUKS header (do this after any keyslot changes)
cryptsetup luksHeaderBackup /dev/sdb --header-backup-file /secure/backup/sdb-luks-header.bak

# Restore header
cryptsetup luksHeaderRestore /dev/sdb --header-backup-file /secure/backup/sdb-luks-header.bak

# Verify header backup integrity
cryptsetup luksHeaderBackup /dev/sdb --header-backup-file /tmp/verify.bak
diff <(xxd /secure/backup/sdb-luks-header.bak) <(xxd /tmp/verify.bak)
rm /tmp/verify.bak
```

## Summary

Linux encryption at rest is available at two complementary layers:

**dm-crypt/LUKS2** is the right choice when:
- You need full-disk or full-partition encryption
- All data on the device needs the same encryption key
- You need compatibility with standard disk encryption tools
- Performance is critical (native AES-NI hardware acceleration)

**fscrypt** is the right choice when:
- You need per-directory or per-user encryption within one filesystem
- Different directories should use different keys
- You need integration with Android-style multi-user encrypted storage
- You want filesystem metadata to be partially visible

Key operational practices:
- **Argon2id** is the correct PBKDF for LUKS2; tune memory parameter to your threat model (higher = more brute-force resistant)
- Always **back up the LUKS header** immediately after formatting; a corrupt header without a backup means permanent data loss
- Use **multiple keyslots**: one passphrase-protected for manual recovery, one keyfile for automated systems
- For Kubernetes, use **CSI driver encryption** with cloud KMS when available; use the **EncryptionConfiguration** API to encrypt Kubernetes Secrets in etcd
- Enable `discard` (TRIM) for SSD performance, but be aware this reveals which blocks are in use to a disk-level attacker

The combination of dm-crypt at the block layer and Kubernetes EncryptionConfiguration at the application layer provides defense in depth for sensitive workloads.
