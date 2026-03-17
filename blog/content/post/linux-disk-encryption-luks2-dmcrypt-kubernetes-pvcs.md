---
title: "Linux Disk Encryption: LUKS2, dm-crypt, and Encrypted Kubernetes PVCs"
date: 2030-09-04T00:00:00-05:00
draft: false
tags: ["Linux", "LUKS", "dm-crypt", "Encryption", "Kubernetes", "Security", "Storage", "PVC"]
categories:
- Linux
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise disk encryption guide covering LUKS2 configuration, dm-crypt performance impact, TPM-backed key enrollment, encrypted PVC support with storage drivers, and managing encryption key rotation for Kubernetes workloads."
more_link: "yes"
url: "/linux-disk-encryption-luks2-dmcrypt-kubernetes-pvcs/"
---

Data-at-rest encryption is a foundational security control required by PCI-DSS, HIPAA, SOC 2 Type II, and most enterprise security frameworks. On Linux, the LUKS2 (Linux Unified Key Setup version 2) format backed by the dm-crypt kernel module provides block-layer encryption that is transparent to the filesystem and applications running above it. When combined with Kubernetes storage drivers that expose encrypted PVC support, the same encryption guarantees extend to containerized workloads without application changes. This guide covers the complete implementation: LUKS2 format internals, dm-crypt performance characteristics, TPM2-backed automated unlocking, CSI driver integration for encrypted PVCs, and the operational procedures for key rotation.

<!--more-->

## LUKS2 Architecture and Format Internals

LUKS2 is the current version of the Linux Unified Key Setup format specification. It stores all metadata in a JSON header at the start of the block device, supports up to 32 key slots (versus 8 in LUKS1), and introduces token-based unlocking mechanisms that enable hardware-backed key management.

### Key Concepts

**Master Key (Volume Key)**: A randomly generated key (typically 256 or 512 bits) used to encrypt the actual data via the cipher specified in the LUKS2 header. This key never leaves the device unencrypted in normal operation.

**Key Slots**: LUKS2 supports up to 32 independently encrypted copies of the master key. Each slot contains the master key encrypted with a different passphrase or hardware token. Any slot can unlock the volume. Slots are independent — revoking one slot does not require re-encrypting data.

**Token Slots**: JSON-encoded metadata associated with key slots that describe how to automatically retrieve the passphrase (e.g., from a TPM2, Clevis/Tang, or a secrets manager).

**Segments**: LUKS2 segments describe the bulk encryption area. The default segment covers the entire device minus the header area.

### LUKS2 vs LUKS1 Comparison

| Feature | LUKS1 | LUKS2 |
|---|---|---|
| Key slots | 8 | 32 |
| Header size | 1 MiB | Configurable (default 16 MiB) |
| Header backup | Manual | Automatic secondary header |
| Token support | No | Yes (TPM2, Clevis, etc.) |
| Integrity | No | Optional (dm-integrity) |
| Memory-hard KDF | PBKDF2 only | PBKDF2 + Argon2id |

## Installing cryptsetup

```bash
# Debian/Ubuntu
apt-get install -y cryptsetup cryptsetup-bin

# RHEL/Rocky/AlmaLinux
dnf install -y cryptsetup

# Verify version (LUKS2 requires >= 2.1)
cryptsetup --version
# cryptsetup 2.7.3
```

## Creating a LUKS2 Encrypted Volume

### Format a Block Device

```bash
# Format /dev/sdb with LUKS2
# --type luks2: use LUKS2 format (default in cryptsetup >= 2.x)
# --cipher: AES-256 in XTS mode (standard for disk encryption)
# --key-size: 512-bit key for AES-256-XTS (XTS uses two 256-bit subkeys)
# --hash: hash for key derivation
# --pbkdf: use Argon2id for passphrase-based key derivation (memory-hard)
# --pbkdf-memory: memory cost for Argon2id in KiB (recommended >= 1 GiB for LUKS headers)
# --iter-time: milliseconds to spend on PBKDF iteration calibration

cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha256 \
  --pbkdf argon2id \
  --pbkdf-memory 1048576 \
  --pbkdf-parallel 4 \
  --iter-time 2000 \
  --label data-volume-01 \
  /dev/sdb
```

This prompts for a passphrase. For automated environments, use a key file:

```bash
# Generate a cryptographically random key file
dd if=/dev/urandom of=/etc/keys/data-volume-01.key bs=512 count=1 iflag=fullblock
chmod 400 /etc/keys/data-volume-01.key

# Format using a key file
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha256 \
  --pbkdf argon2id \
  --pbkdf-memory 1048576 \
  --key-file /etc/keys/data-volume-01.key \
  /dev/sdb
```

### Inspect the LUKS2 Header

```bash
cryptsetup luksDump /dev/sdb
```

```
LUKS header information
Version:       	2
Epoch:         	4
Metadata area: 	16384 [bytes]
Keyslots area: 	16744448 [bytes]
UUID:          	a4b8c2d1-e5f6-7890-abcd-1234567890ab
Label:         	data-volume-01
Subsystem:     	(no subsystem)
Flags:       	(no flags)

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
	Time cost:  5
	Memory:     1048576
	Threads:    4
	Salt:       ...
	AF stripes:  4000
	AF hash:    sha256
	Area offset:32768 [bytes]
	Area length:258048 [bytes]
	Digest ID:  0
Tokens:
Digests:
  0: pbkdf2
	Hash:       sha256
	Iterations: 141672
	Salt:       ...
	Digest:     ...
```

### Open, Format, and Mount

```bash
# Open the LUKS volume (creates /dev/mapper/data-volume-01)
cryptsetup open \
  --type luks2 \
  --key-file /etc/keys/data-volume-01.key \
  /dev/sdb \
  data-volume-01

# Create a filesystem on the decrypted device
mkfs.ext4 -L data-volume-01 /dev/mapper/data-volume-01

# Mount it
mkdir -p /mnt/data
mount /dev/mapper/data-volume-01 /mnt/data
```

### /etc/crypttab for Persistent Configuration

```
# /etc/crypttab
# <name>          <device>   <key-file>                      <options>
data-volume-01    /dev/sdb   /etc/keys/data-volume-01.key    luks,discard,no-read-workqueue,no-write-workqueue
```

```
# /etc/fstab
/dev/mapper/data-volume-01    /mnt/data    ext4    defaults,noatime    0 2
```

## dm-crypt Performance Analysis

Encryption adds CPU overhead for every read and write operation. The impact depends on cipher choice, hardware AES acceleration, and I/O patterns.

### Checking AES-NI Hardware Support

```bash
grep -m1 'aes' /proc/cpuinfo
# flags: ... aes ...

# Verify the kernel is using hardware acceleration
cryptsetup benchmark
```

```
# Tests are approximate using memory only (no storage I/O).
PBKDF2-sha256      3182154 iterations per second for 256-bit key
PBKDF2-sha512      1289435 iterations per second for 256-bit key
Argon2i         4 iterations, 1048576 memory, 4 parallel for 256-bit key ( 2.1s)
Argon2id        4 iterations, 1048576 memory, 4 parallel for 256-bit key ( 2.1s)
#     Algorithm |       Key |      Encryption |      Decryption
        aes-cbc        128b      1241.4 MiB/s      4820.8 MiB/s
    serpent-cbc        128b        96.3 MiB/s       654.8 MiB/s
    twofish-cbc        128b       204.3 MiB/s       367.2 MiB/s
        aes-cbc        256b       975.0 MiB/s      3844.3 MiB/s
    serpent-cbc        256b        96.3 MiB/s       655.0 MiB/s
    twofish-cbc        256b       204.4 MiB/s       367.3 MiB/s
        aes-xts        256b      2399.9 MiB/s      2419.4 MiB/s
    serpent-xts        256b       651.3 MiB/s       643.9 MiB/s
    twofish-xts        256b       322.3 MiB/s       328.2 MiB/s
        aes-xts        512b      1824.8 MiB/s      1834.7 MiB/s
```

AES-XTS with hardware AES-NI achieves multi-GB/s throughput, making the overhead negligible for most workloads on modern CPUs.

### Performance Tuning Options

```bash
# no-read-workqueue and no-write-workqueue: bypass kernel async workqueue
# Reduces latency for storage devices that are not congested
# (beneficial for NVMe SSDs, may hurt for spinning disks)
cryptsetup open \
  --perf-no_read_workqueue \
  --perf-no_write_workqueue \
  --key-file /etc/keys/data-volume-01.key \
  /dev/nvme0n1p2 \
  fast-volume

# Persistent performance flags in /etc/crypttab
# data-volume-01  /dev/nvme0n1p2  /etc/keys/...key  luks,no-read-workqueue,no-write-workqueue,discard
```

### TRIM/discard Support for SSDs

```bash
# Allow TRIM (discard) to pass through to the underlying SSD
# Security consideration: discard leaks information about which blocks are free
# Acceptable tradeoff for most environments; disable for high-security contexts
cryptsetup open \
  --allow-discards \
  --key-file /etc/keys/data-volume-01.key \
  /dev/nvme0n1p2 \
  nvme-volume
```

## TPM2-Backed Automated Unlocking with Clevis

TPM2 (Trusted Platform Module version 2) allows binding LUKS key material to the hardware state of the machine. The volume unlocks automatically only when the TPM attests to the expected system configuration (PCR values), preventing decryption on moved disks.

### Installing Clevis

```bash
# Debian/Ubuntu
apt-get install -y clevis clevis-luks clevis-tpm2 clevis-initramfs

# RHEL/Rocky/AlmaLinux
dnf install -y clevis clevis-luks clevis-tpm2 clevis-dracut
```

### Enrolling a TPM2 Token

```bash
# Bind the LUKS volume to TPM2 PCRs 0, 1, 7
# PCR 0: BIOS/UEFI firmware measurement
# PCR 1: BIOS/UEFI configuration
# PCR 7: Secure Boot state
clevis luks bind \
  -d /dev/sdb \
  tpm2 '{"pcr_bank":"sha256","pcr_ids":"0,1,7"}'
```

This adds a new key slot to the LUKS2 device with a token object describing the TPM2 enrollment. During boot, Clevis retrieves the key from the TPM2 automatically if the PCR values match.

### Verify TPM2 Enrollment

```bash
cryptsetup luksDump /dev/sdb | grep -A5 Tokens
# Tokens:
#   0: clevis
#         Keyslot:  1
```

```bash
# Test that Clevis can unlock without a passphrase
clevis luks unlock -d /dev/sdb -n tpm2-data-vol
```

### PCR Selection for Kubernetes Nodes

For Kubernetes worker nodes, PCR selection requires balancing security against operational flexibility:

| PCR | Measures | Impact on Kubernetes |
|---|---|---|
| 0 | Firmware | Changes on firmware updates (requires re-enrollment) |
| 1 | Firmware config | Changes on BIOS settings changes |
| 7 | Secure Boot state | Changes on Secure Boot key rotation |
| 14 | Shim | Changes on shim updates |

For Kubernetes nodes that receive frequent OS updates but rarely have firmware changes, binding to PCR 7 only (Secure Boot state) provides reasonable security with lower operational friction.

## Encrypted Kubernetes Persistent Volumes

### Approach 1: Host-Level LUKS + StorageClass

The simplest approach is encrypting the underlying block devices on Kubernetes nodes at the OS level. PVCs provisioned on those nodes automatically benefit from the node-level encryption.

```yaml
# StorageClass pointing to pre-encrypted local volumes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-encrypted
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

```yaml
# PersistentVolume pointing to LUKS-opened dm-crypt device
apiVersion: v1
kind: PersistentVolume
metadata:
  name: encrypted-pv-node01-data01
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-encrypted
  local:
    path: /mnt/encrypted/data01
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - node01
```

### Approach 2: CSI Driver with Encryption Support

Several CSI drivers support per-volume encryption, abstracting LUKS management from the node operator.

**Longhorn with Volume Encryption:**

```yaml
# StorageClass enabling Longhorn encryption
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-encrypted
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  dataLocality: "best-effort"
  encrypted: "true"
  # Key provider — uses Kubernetes Secret referenced below
  csi.storage.k8s.io/provisioner-secret-name: longhorn-crypto
  csi.storage.k8s.io/provisioner-secret-namespace: longhorn-system
  csi.storage.k8s.io/node-publish-secret-name: longhorn-crypto
  csi.storage.k8s.io/node-publish-secret-namespace: longhorn-system
  csi.storage.k8s.io/node-stage-secret-name: longhorn-crypto
  csi.storage.k8s.io/node-stage-secret-namespace: longhorn-system
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
```

```yaml
# Encryption key secret for Longhorn
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-crypto
  namespace: longhorn-system
type: Opaque
data:
  CRYPTO_KEY_VALUE: <base64-encoded-private-key>
  CRYPTO_KEY_PROVIDER: secret
  CRYPTO_KEY_CIPHER: aes-xts-plain64
  CRYPTO_KEY_HASH: sha256
  CRYPTO_KEY_SIZE: "256"
  CRYPTO_PBKDF: argon2i
```

```yaml
# PVC using the encrypted StorageClass
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: data
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: longhorn-encrypted
  resources:
    requests:
      storage: 100Gi
```

**OpenEBS with dm-crypt:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-device-encrypted
provisioner: local.csi.openebs.io
parameters:
  openebs.io/cas-type: localpv-device
  blockdeviceselector: "ndm.io/blockdevice-type=blockdevice"
  encryption: "luks"
  encryptionKeySecret: "openebs-luks-key"
  encryptionKeySecretNamespace: "openebs"
```

### Approach 3: Rook/Ceph OSD-Level Encryption

When using Rook/Ceph for storage, enable OSD-level encryption at cluster creation:

```yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  storage:
    useAllNodes: false
    useAllDevices: false
    deviceFilter: "^sd[b-z]"
    config:
      encryptedDevice: "true"   # Enable dm-crypt for all OSDs
    storageClassDeviceSets:
    - name: set1
      count: 3
      portable: false
      tuneDeviceClass: true
      encrypted: true           # Redundant but explicit
      volumeClaimTemplates:
      - metadata:
          name: data
        spec:
          resources:
            requests:
              storage: 2Ti
          storageClassName: local-disk
          volumeMode: Block
          accessModes:
          - ReadWriteOnce
```

Rook/Ceph uses `dmcrypt` internally, managing LUKS key material in a Kubernetes Secret. Each OSD device is individually encrypted with a unique key.

## Key Rotation Procedures

LUKS2's multi-slot architecture makes key rotation safe and non-disruptive — the volume data is never re-encrypted during a key rotation.

### Rotating a Passphrase or Key File

```bash
# Step 1: Add the new key to a fresh slot (volume remains accessible throughout)
cryptsetup luksAddKey \
  --key-file /etc/keys/old-key.key \
  --new-key-file /etc/keys/new-key.key \
  /dev/sdb

# Step 2: Verify the new key unlocks the volume
cryptsetup open \
  --test-passphrase \
  --key-file /etc/keys/new-key.key \
  /dev/sdb
echo "New key verified: $?"

# Step 3: Remove the old key slot
# First, find the old key's slot number
cryptsetup luksDump /dev/sdb | grep -A3 "Keyslots"

# Kill the specific slot (replace 0 with the old slot number)
cryptsetup luksKillSlot \
  --key-file /etc/keys/new-key.key \
  /dev/sdb \
  0

# Step 4: Verify only the new key works
cryptsetup open \
  --test-passphrase \
  --key-file /etc/keys/old-key.key \
  /dev/sdb
# Should return: No key available with this passphrase.
```

### Scripted Key Rotation for Kubernetes Nodes

```bash
#!/bin/bash
# rotate-luks-keys.sh — rotate LUKS keys for all encrypted volumes on a node
set -euo pipefail

KEYS_DIR="/etc/luks-keys"
OLD_KEY_SUFFIX="$(date -d 'yesterday' +%Y%m%d)"
NEW_KEY_SUFFIX="$(date +%Y%m%d)"
CRYPTTAB="/etc/crypttab"

log() {
    echo "[$(date -Iseconds)] $*"
}

rotate_device() {
    local name="$1"
    local device="$2"
    local old_key="${KEYS_DIR}/${name}-${OLD_KEY_SUFFIX}.key"
    local new_key="${KEYS_DIR}/${name}-${NEW_KEY_SUFFIX}.key"
    local current_key="${KEYS_DIR}/${name}.key"

    log "Rotating key for ${name} (${device})"

    # Generate new key
    dd if=/dev/urandom of="${new_key}" bs=512 count=1 iflag=fullblock
    chmod 400 "${new_key}"

    # Add new key
    cryptsetup luksAddKey \
        --key-file "${current_key}" \
        "${device}" \
        "${new_key}"

    # Verify new key
    if ! cryptsetup open --test-passphrase \
         --key-file "${new_key}" "${device}" 2>/dev/null; then
        log "ERROR: New key verification failed for ${name}"
        rm -f "${new_key}"
        return 1
    fi

    # Remove old key (slot containing the current key)
    cryptsetup luksRemoveKey \
        --key-file "${current_key}" \
        "${device}"

    # Atomically replace the current key symlink
    cp "${new_key}" "${current_key}.tmp"
    mv "${current_key}.tmp" "${current_key}"

    log "Key rotation complete for ${name}"
}

# Read crypttab and rotate each device
while IFS=" " read -r name device keyfile options; do
    # Skip comments and empty lines
    [[ "$name" =~ ^# ]] && continue
    [[ -z "$name" ]] && continue

    rotate_device "${name}" "${device}"
done < "${CRYPTTAB}"
```

### Key Rotation for Kubernetes Secrets (CSI Driver)

For CSI drivers that store LUKS keys in Kubernetes Secrets:

```bash
#!/bin/bash
# rotate-csi-luks-secret.sh

NAMESPACE="longhorn-system"
SECRET_NAME="longhorn-crypto"
VOLUME_NAME="postgres-data"

# Step 1: Generate new key
NEW_KEY=$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 -w0)

# Step 2: Get the PV device path (Longhorn-specific)
DEVICE=$(kubectl -n ${NAMESPACE} exec -it longhorn-manager-xxxxx -- \
    longhorn-manager volumes --volume-name ${VOLUME_NAME} get-device-path 2>/dev/null)

# Step 3: Add new key to LUKS header on the volume (requires node access)
# This step is driver-specific — consult your CSI driver documentation

# Step 4: Update the Kubernetes Secret with the new key
kubectl -n ${NAMESPACE} patch secret ${SECRET_NAME} \
    --type='json' \
    -p="[{\"op\": \"replace\", \"path\": \"/data/CRYPTO_KEY_VALUE\", \"value\": \"${NEW_KEY}\"}]"

# Step 5: Remove old key from LUKS header
# (requires the old key — retrieve from secret backup before patching)
```

## Integrity Protection with dm-integrity

LUKS2 optionally enables dm-integrity, which adds per-sector authentication tags to detect data tampering or storage corruption:

```bash
# Format with integrity protection (AEAD mode)
# WARNING: Integrity requires more storage space and adds latency
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-gcm-random \
  --key-size 256 \
  --integrity hmac-sha256 \
  --integrity-no-journal \
  --sector-size 4096 \
  /dev/sdb
```

Note: dm-integrity significantly reduces write performance (2-3x overhead) and is appropriate only for high-security environments where tamper detection is required.

## Security Hardening Checklist

```
LUKS2 Security Hardening Checklist
====================================

[ ] LUKS2 format (not LUKS1) for all new volumes
[ ] aes-xts-plain64 with 512-bit key (AES-256-XTS)
[ ] Argon2id PBKDF (not legacy PBKDF2) for passphrase-based slots
[ ] Minimum pbkdf-memory: 512 MiB (1 GiB recommended)
[ ] TPM2 enrollment for automated unlocking (eliminates passphrase exposure)
[ ] LUKS header backup stored encrypted in a separate secure location
[ ] Key files in /etc/keys with mode 400, owned by root
[ ] crypttab entry with correct key-file path
[ ] discard/TRIM allowed only if operational convenience outweighs info leakage risk
[ ] Key rotation scheduled (minimum annually, quarterly for regulated environments)
[ ] Monitoring: dm-crypt device availability via node_exporter or custom Prometheus metrics
[ ] No LUKS key material in Kubernetes Secrets without encryption at rest (etcd encryption)
[ ] Backup LUKS header before any key operation: cryptsetup luksHeaderBackup
```

## Monitoring dm-crypt Devices

```bash
# Check device status
cryptsetup status data-volume-01

# Monitor kernel dm-crypt statistics
cat /proc/crypto | grep -A4 aes

# Prometheus node_exporter dm device metrics
# node_dm_info, node_dm_reads_total, node_dm_writes_total are available
# for encrypted devices exposed as /dev/dm-N
```

```yaml
# Prometheus alert for missing dm-crypt device
groups:
- name: dm-crypt
  rules:
  - alert: EncryptedVolumeNotMounted
    expr: |
      absent(node_filesystem_avail_bytes{mountpoint="/mnt/data"})
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Encrypted volume /mnt/data is not mounted"
      description: "Node {{ $labels.instance }} is missing the encrypted data volume mount."
```

## Summary

LUKS2 with dm-crypt provides production-grade data-at-rest encryption that integrates natively with Kubernetes storage layers. The key operational principles are: use LUKS2 (never LUKS1) for new deployments, choose AES-XTS-512 with Argon2id for all new volumes, bind to TPM2 for automated node unlocking, leverage CSI drivers that natively support per-volume encryption rather than managing LUKS at the node level, and implement key rotation procedures that exploit LUKS multi-slot architecture to avoid data re-encryption. With proper TPM2 enrollment and CSI integration, encrypted PVCs become operationally transparent — delivering compliance requirements without increasing operational complexity.
