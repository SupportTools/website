---
title: "Linux Filesystem Encryption: LUKS, dm-crypt, and fscrypt for Kubernetes Volumes"
date: 2029-01-31T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "LUKS", "Kubernetes", "Encryption", "Storage"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linux filesystem encryption using LUKS2, dm-crypt, and fscrypt, including Kubernetes volume encryption patterns, key management integration, and operational procedures for production environments."
more_link: "yes"
url: "/linux-filesystem-encryption-luks-dmcrypt-fscrypt-kubernetes/"
---

Encryption at rest is a baseline requirement for enterprise production systems handling regulated data. Linux provides three encryption mechanisms that cover different scenarios: LUKS2/dm-crypt for full block device encryption, fscrypt for per-directory file-level encryption, and eCryptFS for per-user home directory encryption. Each has distinct performance profiles, key management models, and integration paths with Kubernetes persistent volumes.

This guide covers LUKS2 configuration for Kubernetes worker node data volumes, dm-crypt integration with HashiCorp Vault for automated key management, and fscrypt for application-level directory encryption — all production patterns with observable operational procedures.

<!--more-->

## Encryption Layer Comparison

Linux encryption operates at three distinct layers, each with trade-offs:

| Layer | Mechanism | Granularity | Key Management | Performance |
|---|---|---|---|---|
| Block device | LUKS2/dm-crypt | Full disk | Kernel keyring / LUKS header | 1-5% overhead (AES-NI) |
| Filesystem | fscrypt | Directory | Kernel keyring per directory | 1-8% overhead |
| File | eCryptFS | File | PAM / user key | 10-30% overhead |
| Application | OpenSSL/Go crypto | Record | Application manages | Variable |

For Kubernetes workloads, block device encryption (LUKS2) provides the strongest data-at-rest protection with the least application-level complexity. fscrypt suits scenarios where different directories need different encryption keys — for example, isolating different tenant data on a shared node.

## LUKS2 Block Device Encryption

LUKS2 (Linux Unified Key Setup version 2) is the current standard for full disk encryption on Linux. It stores encryption metadata in a JSON-based header at the beginning of the device, supports Argon2id for key derivation, and can hold up to 32 keyslots simultaneously.

### Installing and Configuring LUKS2

```bash
# Install cryptsetup (RHEL/Rocky/AlmaLinux)
dnf install -y cryptsetup cryptsetup-libs

# Install on Ubuntu/Debian
apt-get install -y cryptsetup

# Verify LUKS2 support and AES-NI hardware acceleration
cryptsetup --version
cat /proc/cpuinfo | grep -o 'aes\|avx\|avx2' | sort -u

# Check if kernel module is loaded
lsmod | grep dm_crypt

# Benchmark different cipher modes on this hardware
cryptsetup benchmark
# Output shows MB/s for each cipher — AES-XTS 512b typically hits 1-8 GB/s on modern hardware

# Format a new block device as LUKS2
# WARNING: This destroys all data on /dev/nvme1n1
cryptsetup luksFormat \
  --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha256 \
  --pbkdf argon2id \
  --pbkdf-memory 65536 \
  --pbkdf-parallel 4 \
  --iter-time 2000 \
  --label "k8s-data-01" \
  /dev/nvme1n1

# Verify LUKS2 header
cryptsetup luksDump /dev/nvme1n1
# Shows: Version, cipher, UUID, keyslots

# Open (map) the device
cryptsetup open /dev/nvme1n1 k8s-data-01
# Creates /dev/mapper/k8s-data-01

# Format with XFS (preferred for Kubernetes workloads)
mkfs.xfs -f \
  -L "k8s-data-01" \
  -n ftype=1 \
  /dev/mapper/k8s-data-01

# Mount with optimal options
mkdir -p /var/lib/kubelet/data
mount -o noatime,nodiratime,pquota /dev/mapper/k8s-data-01 /var/lib/kubelet/data

# Persist in /etc/crypttab and /etc/fstab
echo "k8s-data-01 /dev/nvme1n1 none luks,discard,no-read-workqueue,no-write-workqueue" >> /etc/crypttab
echo "/dev/mapper/k8s-data-01 /var/lib/kubelet/data xfs noatime,nodiratime,pquota 0 0" >> /etc/fstab
```

### Key Management: Adding and Removing Keyslots

```bash
# Add a backup key to keyslot 1 (keyslot 0 holds the initial passphrase)
cryptsetup luksAddKey \
  --key-slot 1 \
  --pbkdf argon2id \
  /dev/nvme1n1

# List all keyslots
cryptsetup luksDump /dev/nvme1n1 | grep -A3 "Keyslots"

# Add a key file (for automated unlock — store key file securely)
dd if=/dev/urandom bs=512 count=4 of=/etc/luks/k8s-data-01.key
chmod 400 /etc/luks/k8s-data-01.key

cryptsetup luksAddKey \
  --key-slot 2 \
  /dev/nvme1n1 /etc/luks/k8s-data-01.key

# Verify key file works
cryptsetup luksDump /dev/nvme1n1 --key-file /etc/luks/k8s-data-01.key

# Revoke a keyslot (e.g., after passphrase rotation)
cryptsetup luksKillSlot /dev/nvme1n1 0

# Rotate the key file
dd if=/dev/urandom bs=512 count=4 of=/etc/luks/k8s-data-01.new.key
chmod 400 /etc/luks/k8s-data-01.new.key

cryptsetup luksChangeKey \
  --key-slot 2 \
  --key-file /etc/luks/k8s-data-01.key \
  /dev/nvme1n1 \
  /etc/luks/k8s-data-01.new.key

mv /etc/luks/k8s-data-01.new.key /etc/luks/k8s-data-01.key

# Backup LUKS header (critical — header damage = data loss)
cryptsetup luksHeaderBackup /dev/nvme1n1 \
  --header-backup-file /secure-backup/k8s-data-01-luks-header.img
```

### Automated Unlock via HashiCorp Vault

In a Kubernetes cluster, requiring human intervention to unlock encrypted volumes at every node boot is operationally impractical. The clevis/tang pattern or Vault Agent provides automated, network-bound unlock.

```bash
# Install clevis for network-bound disk encryption (NBDE)
dnf install -y clevis clevis-luks clevis-dracut

# Bind the LUKS device to a Tang server
# Tang server should be deployed in a highly available configuration
clevis luks bind -d /dev/nvme1n1 tang '{"url":"https://tang.platform.internal","thp":"abc123def456"}'

# During systemd-cryptsetup, Tang provides the key automatically
# No human intervention required if Tang is reachable

# Verify binding
clevis luks list -d /dev/nvme1n1

# For Vault-based key management, use Vault Agent with a startup script
cat > /etc/luks/vault-unlock.sh << 'EOF'
#!/bin/bash
set -euo pipefail

DEVICE="/dev/nvme1n1"
MAPPER_NAME="k8s-data-01"
VAULT_ADDR="https://vault.platform.internal:8200"
VAULT_PATH="secret/data/k8s/luks/${HOSTNAME}"
ROLE_ID_FILE="/etc/vault/role-id"
SECRET_ID_FILE="/etc/vault/secret-id"

# Authenticate with Vault via AppRole
VAULT_TOKEN=$(curl -sf \
  --request POST \
  --data "{\"role_id\":\"$(cat $ROLE_ID_FILE)\",\"secret_id\":\"$(cat $SECRET_ID_FILE)\"}" \
  "${VAULT_ADDR}/v1/auth/approle/login" | jq -r '.auth.client_token')

# Retrieve key
LUKS_KEY=$(curl -sf \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/${VAULT_PATH}" | jq -r '.data.data.key')

# Unlock device
echo -n "${LUKS_KEY}" | cryptsetup open "${DEVICE}" "${MAPPER_NAME}" --key-file=-

# Clear key from memory
unset LUKS_KEY VAULT_TOKEN
EOF
chmod 700 /etc/luks/vault-unlock.sh
```

## dm-crypt Performance Tuning

The default dm-crypt configuration suits general workloads but leaves performance on the table for high-throughput storage. NVMe drives capable of 5 GB/s sustained reads can see dm-crypt throughput drop to 2-3 GB/s without tuning.

```bash
# Check current device configuration
dmsetup table k8s-data-01
# Shows: 0 <sectors> crypt aes-xts-plain64 <key> 0 <device> 0 1 allow_discards

# Close and reopen with performance flags
cryptsetup close k8s-data-01

cryptsetup open \
  --type luks2 \
  --allow-discards \
  --perf-no_read_workqueue \
  --perf-no_write_workqueue \
  --perf-submit_from_crypt_cpus \
  /dev/nvme1n1 k8s-data-01

# Verify flags applied
dmsetup table k8s-data-01
# Should show: no_read_workqueue no_write_workqueue submit_from_crypt_cpus

# Test throughput (compare vs raw device)
# Raw NVMe
fio --name=raw --filename=/dev/nvme1n1 --rw=read --bs=128k --size=4G --numjobs=4 \
  --iodepth=32 --direct=1 --group_reporting

# Encrypted
fio --name=enc --filename=/dev/mapper/k8s-data-01 --rw=read --bs=128k --size=4G \
  --numjobs=4 --iodepth=32 --direct=1 --group_reporting

# Set I/O scheduler for NVMe (none/mq-deadline)
echo none > /sys/block/nvme1n1/queue/scheduler

# Check AES-NI acceleration is active
cryptsetup status k8s-data-01 | grep -i "cipher\|key\|flags"
```

## fscrypt for Per-Directory Encryption

fscrypt provides kernel-level, per-directory encryption on ext4, f2fs, and btrfs filesystems. Unlike LUKS which encrypts the entire block device, fscrypt encrypts individual directories with independent keys — suitable for multi-tenant workloads where different application namespaces should have cryptographically isolated data.

```bash
# Enable fscrypt on an ext4 filesystem
tune2fs -O encrypt /dev/mapper/k8s-app-data
# Note: Cannot undo this operation

# Or on XFS — XFS does not support fscrypt natively
# For XFS, LUKS2 block-level encryption is the correct approach

# Mount with appropriate options
mount -o defaults /dev/mapper/k8s-app-data /data/apps

# Install fscrypt userspace tool
dnf install -y fscrypt
fscrypt setup /data/apps

# Create a protector (key derivation policy)
fscrypt metadata create protector /data/apps
# Select key source: custom passphrase or raw key

# Encrypt a directory
mkdir -p /data/apps/tenant-acme
fscrypt encrypt /data/apps/tenant-acme --source=custom_passphrase --name=tenant-acme-key

# Lock the directory (keys removed from kernel keyring)
fscrypt lock /data/apps/tenant-acme

# Unlock with passphrase
fscrypt unlock /data/apps/tenant-acme

# Check encryption status
fscrypt status /data/apps/tenant-acme

# List all encrypted directories on the filesystem
fscrypt status /data/apps

# Use a raw key file (for automated workflows)
dd if=/dev/urandom bs=64 count=1 of=/secure/tenant-acme.key
fscrypt encrypt /data/apps/tenant-acme \
  --source=raw_key \
  --key=/secure/tenant-acme.key \
  --name=tenant-acme-raw
```

## Kubernetes Integration: Encrypted Persistent Volumes

Kubernetes does not natively manage LUKS encryption, but the encryption layer can be implemented transparently through the storage class and node preparation.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: encrypted-local-storage
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: encrypted-pv-payments-01
  labels:
    app: payments-processor
    encryption: luks2
    node: worker-us-east-1a-03
spec:
  capacity:
    storage: 200Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: encrypted-local-storage
  local:
    path: /var/lib/kubelet/data/payments-01
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - worker-us-east-1a-03
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: payments-processor-data
  namespace: payments
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 200Gi
  storageClassName: encrypted-local-storage
  selector:
    matchLabels:
      app: payments-processor
      encryption: luks2
```

### CSI Driver with Encryption Support

The csi-driver-lvm project with LUKS support provides dynamic provisioning of encrypted volumes.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: lvm-csi-config
  namespace: kube-system
data:
  config.yaml: |
    vgname: "csi-vg"
    devices:
      - /dev/nvme1n1
    thin:
      enabled: true
      thinpool: csi-thinpool
    encryption:
      enabled: true
      type: luks2
      cipher: aes-xts-plain64
      keySize: 512
      # Key provider: vault or static
      keyProvider: vault
      vault:
        address: https://vault.platform.internal:8200
        authPath: auth/kubernetes
        role: csi-driver-lvm
        secretPath: secret/data/csi/luks-keys
```

### DaemonSet for Encrypted Volume Initialization

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: luks-initializer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: luks-initializer
  template:
    metadata:
      labels:
        app: luks-initializer
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      initContainers:
        - name: unlock-volumes
          image: registry.company.com/platform/luks-unlock:1.2.0
          securityContext:
            privileged: true
          env:
            - name: VAULT_ADDR
              value: https://vault.platform.internal:8200
            - name: VAULT_ROLE
              value: luks-initializer
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: dev
              mountPath: /dev
            - name: sys
              mountPath: /sys
            - name: host-proc
              mountPath: /proc
          command:
            - /scripts/unlock-all-devices.sh
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 8Mi
      volumes:
        - name: dev
          hostPath:
            path: /dev
        - name: sys
          hostPath:
            path: /sys
        - name: host-proc
          hostPath:
            path: /proc
```

## Monitoring Encrypted Volumes

Production encrypted volumes require monitoring for device mapper status, key availability, and I/O performance degradation.

```bash
# Check all encrypted devices
dmsetup status --target crypt

# Prometheus metrics via node_exporter (device mapper metrics)
# node_device_mapper_* metrics include per-device IO stats

# Script: Alert if LUKS device is not open
cat > /usr/local/bin/check-luks-status.sh << 'EOF'
#!/bin/bash
set -euo pipefail

EXPECTED_DEVICES=("k8s-data-01" "k8s-data-02" "k8s-logs-01")
FAILED=0

for dev in "${EXPECTED_DEVICES[@]}"; do
  if ! dmsetup status "${dev}" &>/dev/null; then
    echo "CRITICAL: LUKS device ${dev} is NOT open"
    FAILED=$((FAILED + 1))
  else
    STATUS=$(dmsetup status "${dev}" | awk '{print $4}')
    if [ "${STATUS}" != "crypt" ]; then
      echo "WARNING: Device ${dev} has unexpected type: ${STATUS}"
      FAILED=$((FAILED + 1))
    fi
  fi
done

if [ $FAILED -gt 0 ]; then
  exit 2
fi

echo "OK: All ${#EXPECTED_DEVICES[@]} encrypted devices are open"
exit 0
EOF
chmod +x /usr/local/bin/check-luks-status.sh

# Measure overhead with iostat
iostat -xz 1 -d nvme1n1 dm-0 &
# Compare throughput on raw device (nvme1n1) vs encrypted (dm-0)
```

## Disaster Recovery: Header Backup and Recovery

```bash
# Restore LUKS header from backup (when header corruption occurs)
# WARNING: Only do this if the device truly has a corrupted header
# and you have a verified backup

cryptsetup luksHeaderRestore /dev/nvme1n1 \
  --header-backup-file /secure-backup/k8s-data-01-luks-header.img

# Verify header was restored correctly
cryptsetup luksDump /dev/nvme1n1

# Test that the device can be unlocked after restore
cryptsetup open --test-passphrase /dev/nvme1n1

# If the data partition table is corrupted but LUKS header is intact
# Access through offset
cryptsetup open \
  --offset 2048 \
  /dev/nvme1n1 k8s-data-01-recovery

# Perform filesystem recovery check
xfs_repair /dev/mapper/k8s-data-01-recovery

# Mount in read-only mode first when recovering
mount -o ro,noatime /dev/mapper/k8s-data-01 /mnt/recovery
ls -la /mnt/recovery/
# Verify data integrity before mounting read-write
```

## Performance Baseline

After configuring encrypted volumes, establish a performance baseline to detect future degradation.

```bash
# Comprehensive storage benchmark (run after LUKS setup)
fio --name=randwrite \
  --filename=/var/lib/kubelet/data/fio-test \
  --rw=randwrite \
  --bs=4k \
  --size=8G \
  --numjobs=8 \
  --iodepth=32 \
  --direct=1 \
  --group_reporting \
  --output-format=json \
  --output=/var/log/storage-baseline-$(date +%Y%m%d).json

# Compare against target thresholds
# NVMe + LUKS2 + AES-NI expected: 250K+ IOPS 4K random write
# If below 200K, investigate: AES-NI disabled, wrong scheduler, no_write_workqueue not set

# Store baseline in monitoring system
cat /var/log/storage-baseline-$(date +%Y%m%d).json | \
  jq '.jobs[0].write | {iops: .iops, bw_bytes: .bw_bytes, lat_ns: .lat_ns.mean}'
```

The patterns described here — LUKS2 for block device encryption, fscrypt for directory isolation, Vault integration for key management, and DaemonSet-based automated unlock — provide a complete production encryption stack for Kubernetes environments handling regulated data under PCI DSS, HIPAA, or SOC 2 Type II requirements.
