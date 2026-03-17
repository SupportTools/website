---
title: "Linux ZFS on Linux: Advanced Pool Management and Dataset Optimization"
date: 2031-03-23T00:00:00-05:00
draft: false
tags: ["ZFS", "Linux", "Storage", "Kubernetes", "CSI", "Performance", "Backup"]
categories:
- Linux
- Storage
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to ZFS pool creation with RAIDZ2 and mirror redundancy, dataset hierarchy design, compression and deduplication tuning, ARC cache optimization, ZFS send/receive replication, and the OpenEBS ZFS CSI driver for Kubernetes."
more_link: "yes"
url: "/linux-zfs-advanced-pool-management-dataset-optimization/"
---

ZFS is the most feature-complete filesystem available on Linux, combining storage pooling, integrated RAID, copy-on-write snapshots, data integrity verification, and replication into a single coherent system. For production storage workloads — whether bare-metal databases, NFS servers, or Kubernetes persistent volumes — ZFS eliminates entire categories of storage corruption and operational complexity that affect traditional filesystems.

This guide covers the operational depth required for production ZFS deployments: pool topology selection for different failure models, dataset hierarchy design that scales, compression and dedup cost-benefit analysis, ARC tuning for workload-specific read patterns, ZFS send/receive for disaster recovery, and the OpenEBS ZFS CSI driver that brings ZFS capabilities to Kubernetes PersistentVolumes.

<!--more-->

# Linux ZFS on Linux: Advanced Pool Management and Dataset Optimization

## Section 1: Installation and Prerequisites

### Installing ZFS on Linux

```bash
# Ubuntu/Debian
apt-get install -y zfsutils-linux zfs-dkms

# RHEL/Rocky Linux 8+
dnf install -y epel-release
dnf install -y https://zfsonlinux.org/epel/zfs-release-2-3$(rpm --eval "%{dist}").noarch.rpm
dnf install -y zfs

# Load the ZFS kernel module
modprobe zfs

# Verify installation
zfs version
# Output: zfs-2.2.2-1
#         zfs-kmod-2.2.2-1

# Enable ZFS services
systemctl enable --now zfs-import-cache
systemctl enable --now zfs-import-scan
systemctl enable --now zfs-mount
systemctl enable --now zfs-share
systemctl enable --now zfs-zed  # ZFS Event Daemon for monitoring

# Check available block devices for pool creation
lsblk -d -o NAME,SIZE,MODEL,ROTA,TRAN
```

### Disk Preparation Best Practices

```bash
# Check disk health before adding to pool
smartctl -a /dev/sdb
smartctl -a /dev/sdc

# Get device serial numbers for reliable identification
for dev in /dev/sd{b..i}; do
  echo "${dev}: $(smartctl -i ${dev} | grep 'Serial Number' | awk '{print $3}')"
done

# Use disk identifiers instead of /dev/sdX (which can change on reboot)
ls -la /dev/disk/by-id/ | grep -v part

# Example identifiers:
# /dev/disk/by-id/wwn-0x5000c500abcd1234 -> ../../sdb
# /dev/disk/by-id/scsi-35000c500abcd1234 -> ../../sdb

# Check disk sector size (important for alignment)
fdisk -l /dev/sdb | grep "Sector size"
# 512B vs 4K sectors affect ashift setting
```

## Section 2: Pool Creation with Redundancy Topologies

### RAIDZ2 (Equivalent to RAID-6)

RAIDZ2 tolerates 2 disk failures per VDEV. Recommended for high-capacity HDDs where rebuild times are long:

```bash
# 6-disk RAIDZ2 using disk IDs
zpool create \
  -o ashift=12 \
  -O atime=off \
  -O compression=lz4 \
  -O xattr=sa \
  -O dnodesize=auto \
  -O normalization=formD \
  datapool raidz2 \
  /dev/disk/by-id/wwn-0x5000c500abcd1234 \
  /dev/disk/by-id/wwn-0x5000c500abcd1235 \
  /dev/disk/by-id/wwn-0x5000c500abcd1236 \
  /dev/disk/by-id/wwn-0x5000c500abcd1237 \
  /dev/disk/by-id/wwn-0x5000c500abcd1238 \
  /dev/disk/by-id/wwn-0x5000c500abcd1239

# Verify pool creation
zpool status datapool
zpool list datapool
```

Key parameters explained:

- `ashift=12`: Forces 4K sector alignment (2^12=4096). Use `ashift=9` only for true 512-byte sector disks. Wrong ashift is NOT fixable without pool recreation.
- `atime=off`: Disables access time updates, reducing write amplification significantly.
- `xattr=sa`: Stores extended attributes in the inode (System Attribute), much faster than the default separate file approach.
- `dnodesize=auto`: Allows ZFS to allocate larger dnodes when needed for extended attributes.

### Mirror VDEV Configuration

For SSDs and NVMe where rebuild speed is fast and write performance is critical:

```bash
# 3-way mirror (tolerates 2 disk failures in the mirror)
zpool create \
  -o ashift=12 \
  -O atime=off \
  -O compression=lz4 \
  -O xattr=sa \
  flashpool mirror \
  /dev/disk/by-id/nvme-Samsung_SSD_980_PRO_2TB_S69ENX0R001234 \
  /dev/disk/by-id/nvme-Samsung_SSD_980_PRO_2TB_S69ENX0R001235 \
  /dev/disk/by-id/nvme-Samsung_SSD_980_PRO_2TB_S69ENX0R001236

# Two-stripe mirrors (4 disks, 2x2 mirror layout)
# Better write performance than a single 4-disk mirror
zpool create \
  -o ashift=12 \
  -O atime=off \
  -O compression=lz4 \
  dbpool \
  mirror \
  /dev/disk/by-id/nvme-disk-0 \
  /dev/disk/by-id/nvme-disk-1 \
  mirror \
  /dev/disk/by-id/nvme-disk-2 \
  /dev/disk/by-id/nvme-disk-3
```

### Adding Dedicated Cache and Log Devices

```bash
# Add L2ARC cache (NVMe for read caching of large pools)
zpool add datapool cache \
  /dev/disk/by-id/nvme-cache-device

# Add ZIL SLOG (separate NVMe for synchronous write acceleration)
# Only useful for synchronous-heavy workloads (NFS, databases with fsync)
zpool add datapool log mirror \
  /dev/disk/by-id/nvme-log-device-0 \
  /dev/disk/by-id/nvme-log-device-1

# Add hot spare
zpool add datapool spare \
  /dev/disk/by-id/wwn-0x5000c500spare1234

# Verify final pool layout
zpool status -v datapool
```

### RAIDZ3 for Maximum Fault Tolerance

```bash
# RAIDZ3 (tolerates 3 failures) - for extreme availability requirements
# Minimum 7 disks, optimal with 11, 15, etc. (multiples of 4 + 3)
zpool create \
  -o ashift=12 \
  -O atime=off \
  -O compression=lz4 \
  archivepool raidz3 \
  /dev/disk/by-id/wwn-disk-{0..10}
```

## Section 3: Dataset Hierarchy Design

### Hierarchical Dataset Organization

ZFS datasets inherit properties from parent datasets. A well-designed hierarchy allows you to set compression, quotas, and encryption at the appropriate level:

```bash
# Create the dataset hierarchy
# Top-level: per-application datasets
zfs create -o mountpoint=/data datapool/production

# Database datasets (enable sync for durability)
zfs create \
  -o mountpoint=/data/postgres \
  -o recordsize=8K \
  -o logbias=latency \
  -o primarycache=metadata \
  datapool/production/postgres

zfs create \
  -o mountpoint=/data/mysql \
  -o recordsize=16K \
  -o logbias=latency \
  datapool/production/mysql

# Large object/file storage (tune for sequential)
zfs create \
  -o mountpoint=/data/objects \
  -o recordsize=128K \
  -o compression=zstd-3 \
  -o logbias=throughput \
  datapool/production/objects

# VM disk images (large record size for sequential I/O)
zfs create \
  -o mountpoint=/data/vm-disks \
  -o recordsize=64K \
  -o primarycache=metadata \
  datapool/production/vm-disks

# Backup dataset (max compression, sync optional)
zfs create \
  -o mountpoint=/data/backups \
  -o compression=zstd-9 \
  -o sync=disabled \
  datapool/production/backups

# Set quotas and reservations
zfs set quota=2T datapool/production/postgres
zfs set reservation=500G datapool/production/postgres
```

### Dataset Property Reference

```bash
# View all properties for a dataset
zfs get all datapool/production/postgres

# Critical properties for database workloads
zfs set recordsize=8K datapool/production/postgres    # Match DB page size
zfs set logbias=latency datapool/production/postgres  # Optimize for sync writes
zfs set primarycache=metadata datapool/production/postgres  # Don't cache data (DB manages it)
zfs set secondarycache=none datapool/production/postgres    # Disable L2ARC for DB data

# Critical properties for sequential workloads
zfs set recordsize=128K datapool/production/objects
zfs set logbias=throughput datapool/production/objects
zfs set primarycache=all datapool/production/objects

# Verify inheritance
zfs get -r compression datapool/production
# Shows which datasets inherit compression from parent
```

### Encryption Configuration

```bash
# Create an encrypted dataset (ZFS native encryption)
zfs create \
  -o encryption=aes-256-gcm \
  -o keyformat=passphrase \
  -o keylocation=prompt \
  datapool/production/encrypted

# Or use a key file (for automated mount)
dd if=/dev/urandom bs=32 count=1 of=/etc/zfs/keys/production.key
chmod 400 /etc/zfs/keys/production.key

zfs create \
  -o encryption=aes-256-gcm \
  -o keyformat=raw \
  -o keylocation=file:///etc/zfs/keys/production.key \
  datapool/production/encrypted

# Load keys on boot
cat > /etc/zfs/zfs-load-key.service << 'EOF'
[Unit]
Description=Load ZFS encryption keys
DefaultDependencies=no
Before=zfs-mount.service
After=zfs-import.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/zfs load-key -a

[Install]
WantedBy=zfs-mount.service
EOF

systemctl enable zfs-load-key.service
```

## Section 4: Compression and Deduplication Tuning

### Compression Algorithm Comparison

```bash
#!/bin/bash
# compression-benchmark.sh
# Benchmark different ZFS compression algorithms on your actual data

TEST_DATASET="datapool/compression-test"
TEST_FILE="/tmp/test-data-100mb"

# Generate representative test data
head -c 100M /dev/urandom > /tmp/random-data
cp /var/log/syslog /tmp/log-data

for ALGO in off lz4 gzip-1 gzip-6 gzip-9 zstd-1 zstd-3 zstd-9 zstd-19; do
  zfs create -o compression="${ALGO}" "${TEST_DATASET}/${ALGO}" 2>/dev/null || true
  mount_point=$(zfs get -H -o value mountpoint "${TEST_DATASET}/${ALGO}")

  # Write test
  WRITE_START=$(date +%s%N)
  cp /tmp/log-data "${mount_point}/log-data"
  WRITE_END=$(date +%s%N)
  WRITE_MS=$(( (WRITE_END - WRITE_START) / 1000000 ))

  # Get compression ratio
  RATIO=$(zfs get -H -o value compressratio "${TEST_DATASET}/${ALGO}")

  echo "Algorithm: ${ALGO}"
  echo "  Write time: ${WRITE_MS}ms"
  echo "  Compression ratio: ${RATIO}"
  echo ""
done
```

Production recommendations:

```bash
# Default for general workloads: LZ4 (fast, good ratio)
zfs set compression=lz4 datapool/production

# For log data, backups, cold storage: zstd-3 (excellent ratio, reasonable CPU)
zfs set compression=zstd-3 datapool/production/backups
zfs set compression=zstd-3 datapool/production/logs

# For already-compressed data (media, ZIP, already-encrypted): off
zfs set compression=off datapool/production/media

# For maximum compression of archival data: zstd-9 or zstd-19
# zstd-19 is very CPU-intensive, only for offline archival
zfs set compression=zstd-9 datapool/archive
```

### Deduplication: When to Use It

Deduplication computes a hash of every block and stores only unique blocks. It requires significant RAM for the dedup table (DDT): typically 1-5GB of RAM per 1TB of deduplicated data.

```bash
# Check if dedup makes sense for your data
# First, estimate dedup ratio without enabling it
zdb -S datapool/production 2>/dev/null | tail -20
# Look for: "estimated savings:" line

# Monitor DDT size and memory impact
zpool status -D datapool

# Enable dedup ONLY if:
# 1. You have sufficient RAM (DDT must fit in ARC)
# 2. Dedup ratio > 2x (otherwise not worth it)
# 3. Storage cost savings justify CPU overhead

# Enable dedup with checksum verification
zfs set dedup=on datapool/production/vm-disks

# More CPU efficient: use only checksum (no byte comparison)
zfs set dedup=sha256 datapool/production/vm-disks

# Check current DDT statistics
zdb -D datapool
```

When not to use dedup:
- Data is already compressed (PDFs, media, archives)
- Less than 2x dedup ratio
- Insufficient RAM for DDT (causes DDT to page to disk = major performance degradation)
- Random/unique data (logs, metrics, telemetry)

## Section 5: ARC Cache Sizing and Tuning

### Understanding the ARC

The Adaptive Replacement Cache (ARC) is ZFS's in-memory read cache. Unlike the Linux page cache, it's managed by ZFS and resizes based on pressure from the OS. The ARC uses both recently-used (MRU) and frequently-used (MFU) lists.

```bash
# Check current ARC statistics
arc_summary

# Or use arcstat for real-time monitoring
arcstat 2

# Key metrics to watch:
# - ARC Hit Rate (target: >90% for read-heavy workloads)
# - ARC Miss Rate (should be low)
# - L2ARC hits (if L2ARC is configured)
# - Data evictions (indicates ARC pressure)

# View ARC configuration
cat /proc/spl/kstat/zfs/arcstats | grep -E "^(c |c_min|c_max|size|hits|misses)"
```

### Setting ARC Size Limits

```bash
# By default, ZFS can use up to 50% of RAM
# For a dedicated storage server, increase this significantly

# Check current limits
cat /sys/module/zfs/parameters/zfs_arc_max
cat /sys/module/zfs/parameters/zfs_arc_min

# Set ARC maximum to 80% of RAM (for storage server with 128GB RAM)
# = 128 * 0.8 * 1073741824 = ~110GB
echo "109951162777" > /sys/module/zfs/parameters/zfs_arc_max

# Make persistent
cat >> /etc/modprobe.d/zfs.conf << 'EOF'
# Set ARC max to 110GB (80% of 128GB)
options zfs zfs_arc_max=109951162777
# Set ARC min to 32GB (prevent starvation)
options zfs zfs_arc_min=34359738368
EOF

# For systems running databases alongside ZFS:
# Leave more RAM for the database buffer pool
# Set ARC max to 25-30% of RAM
echo "34359738368" > /sys/module/zfs/parameters/zfs_arc_max  # 32GB

# Update initramfs to apply on boot
update-initramfs -u
```

### Workload-Specific ARC Tuning

```bash
# Disable prefetch for random I/O workloads (databases)
echo "1" > /sys/module/zfs/parameters/zfs_prefetch_disable

# Increase max prefetch streams for sequential workloads
echo "32" > /sys/module/zfs/parameters/zfetch_max_streams

# Tune metadata caching
# For workloads with many small files (inode-heavy)
echo "50" > /sys/module/zfs/parameters/zfs_arc_meta_limit_percent

# Make all tuning persistent
cat >> /etc/modprobe.d/zfs.conf << 'EOF'
# Disable prefetch for database workloads
options zfs zfs_prefetch_disable=1
# Cap metadata ARC at 50%
options zfs zfs_arc_meta_limit_percent=50
EOF
```

### Monitoring ARC Performance

```bash
#!/bin/bash
# arc-monitor.sh
# Continuous ARC monitoring with alerting

while true; do
  STATS=$(cat /proc/spl/kstat/zfs/arcstats)

  HITS=$(echo "${STATS}" | awk '/^hits /{print $3}')
  MISSES=$(echo "${STATS}" | awk '/^misses /{print $3}')
  SIZE=$(echo "${STATS}" | awk '/^size /{print $3}')
  C_MAX=$(echo "${STATS}" | awk '/^c_max /{print $3}')

  TOTAL=$((HITS + MISSES))
  if [[ ${TOTAL} -gt 0 ]]; then
    HIT_RATE=$(echo "scale=2; ${HITS} * 100 / ${TOTAL}" | bc)
  else
    HIT_RATE=0
  fi

  SIZE_GB=$(echo "scale=2; ${SIZE} / 1073741824" | bc)
  MAX_GB=$(echo "scale=2; ${C_MAX} / 1073741824" | bc)

  echo "$(date '+%Y-%m-%d %H:%M:%S') ARC: ${SIZE_GB}GB/${MAX_GB}GB | Hit Rate: ${HIT_RATE}%"

  # Alert if hit rate drops below 90%
  HIT_INT=$(echo "${HIT_RATE}" | cut -d. -f1)
  if [[ ${HIT_INT} -lt 90 ]]; then
    echo "WARNING: ARC hit rate is ${HIT_RATE}%, consider increasing ARC size"
  fi

  sleep 10
done
```

## Section 6: Snapshots and Clone Operations

### Snapshot Management

```bash
# Create a snapshot
zfs snapshot datapool/production/postgres@2031-03-23-02:00

# Recursive snapshot (all child datasets)
zfs snapshot -r datapool/production@2031-03-23-daily

# List snapshots
zfs list -t snapshot -r datapool/production

# Show snapshot space usage
zfs list -t snapshot -o name,used,referenced,written \
  -r datapool/production | sort -k2 -h

# Rollback to snapshot (DESTRUCTIVE - removes all changes since snapshot)
zfs rollback datapool/production/postgres@2031-03-23-02:00

# Create a clone from a snapshot
zfs clone \
  datapool/production/postgres@2031-03-23-02:00 \
  datapool/restore/postgres-clone

# Promote a clone to a full dataset
zfs promote datapool/restore/postgres-clone
```

### Automated Snapshot Policies

```bash
# Install sanoid for automated snapshot management
apt-get install -y sanoid

# Configure sanoid
cat > /etc/sanoid/sanoid.conf << 'EOF'
[datapool/production/postgres]
  use_template = production_db
  recursive = yes

[datapool/production/mysql]
  use_template = production_db
  recursive = yes

[datapool/production/backups]
  use_template = backups
  recursive = yes

[template_production_db]
  frequently = 0
  hourly = 24
  daily = 7
  weekly = 4
  monthly = 6
  autosnap = yes
  autoprune = yes

[template_backups]
  frequently = 0
  hourly = 0
  daily = 30
  weekly = 8
  monthly = 12
  autosnap = yes
  autoprune = yes
EOF

# Enable and start sanoid
systemctl enable --now sanoid.timer

# Verify snapshots
zfs list -t snapshot -r datapool/production | grep sanoid
```

## Section 7: ZFS Send/Receive for Replication

### Incremental Replication

```bash
# Initial full send to remote system
# On source:
zfs snapshot datapool/production@initial-replication-$(date +%Y%m%d)

# Pipe through SSH (use compression for WAN)
zfs send -R datapool/production@initial-replication-20310323 | \
  ssh -c aes128-gcm@openssh.com \
  backup-server \
  "zfs receive -F backuppool/production"

# Incremental send (only changes since last snapshot)
# Create new snapshot
zfs snapshot datapool/production@incremental-$(date +%Y%m%d)

# Send only the delta
zfs send -R \
  -I datapool/production@initial-replication-20310323 \
  datapool/production@incremental-20310324 | \
  ssh -c aes128-gcm@openssh.com \
  backup-server \
  "zfs receive -F backuppool/production"
```

### Automated Replication with Syncoid

```bash
# Install syncoid (part of sanoid package)
apt-get install -y sanoid  # syncoid is included

# Basic replication
syncoid datapool/production backup-server:backuppool/production

# Replication with bandwidth limit
syncoid \
  --bwlimit 50m \
  --no-sync-snap \
  datapool/production \
  backup-server:backuppool/production

# Recursive replication of all child datasets
syncoid \
  --recursive \
  datapool/production \
  backup-server:backuppool/production

# Cron job for automated replication
cat > /etc/cron.d/zfs-replication << 'EOF'
# Replicate production data every 4 hours
0 */4 * * * root /usr/sbin/syncoid \
  --no-sync-snap \
  --recursive \
  datapool/production \
  backup-server:backuppool/production \
  >> /var/log/zfs-replication.log 2>&1
EOF
```

### Estimating Replication Transfer Size

```bash
# Estimate size of incremental send before executing
zfs send -nPv \
  -I datapool/production@snapshot-before \
  datapool/production@snapshot-after \
  2>&1 | grep "total estimated size"

# Full send estimate
zfs send -nPv -R datapool/production@snapshot 2>&1 | tail -5
```

## Section 8: Pool Maintenance and Health Monitoring

### Scrub and Resilver Management

```bash
# Start a scrub (reads all data and verifies checksums)
zpool scrub datapool

# Monitor scrub progress
zpool status datapool

# Schedule monthly scrubs
cat > /etc/cron.d/zfs-scrub << 'EOF'
# Monthly scrub on first Sunday at 2 AM
0 2 * * 0 [ $(date +\%e) -le 7 ] && root /usr/sbin/zpool scrub datapool
EOF

# Check last scrub results
zpool history datapool | grep scrub | tail -5
```

### Pool Expansion Procedures

```bash
# Add a new VDEV to expand pool capacity
# (adds a new RAIDZ2 group, NOT expanding existing VDEV)
zpool add datapool raidz2 \
  /dev/disk/by-id/wwn-new-disk-{0..5}

# For mirror pools: replace disk with larger disk, then expand
# Step 1: Replace a disk in the mirror
zpool replace datapool \
  /dev/disk/by-id/wwn-old-disk-0 \
  /dev/disk/by-id/wwn-larger-disk-0

# Wait for resilver to complete
watch zpool status datapool

# Step 2: After replacing ALL disks, expand to use larger capacity
zpool online -e datapool \
  /dev/disk/by-id/wwn-larger-disk-0
```

### ZED (ZFS Event Daemon) Configuration

```bash
# Configure ZED for email and Slack alerts
cat > /etc/zfs/zed.d/zed.rc << 'EOF'
# Email on pool failures
ZED_EMAIL_ADDR="storage-alerts@company.com"
ZED_EMAIL_PROG="/usr/bin/mail"
ZED_EMAIL_OPTS="-s '@subject@' @address@"

# Send email on these events
ZED_NOTIFY_VERBOSE=0
ZED_NOTIFY_DATA=0

# Scrub interval (seconds)
ZED_SCRUB_INTERVAL=2592000  # 30 days
EOF

systemctl restart zfs-zed
```

## Section 9: Kubernetes CSI Driver for ZFS

### OpenEBS ZFS CSI Driver Installation

The OpenEBS ZFS CSI driver allows Kubernetes workloads to consume ZFS datasets as PersistentVolumes:

```bash
# Install the ZFS CSI driver
kubectl apply -f https://openebs.github.io/zfs-localpv/deploy/zfs-operator.yaml

# Verify installation
kubectl get pods -n kube-system | grep zfs
# Expected: openebs-zfs-controller and openebs-zfs-node DaemonSet
```

### Configuring ZFS StorageClass

```yaml
# zfs-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: zfs-nvme-database
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: zfs.csi.openebs.io
parameters:
  # Pool name on the node
  poolname: "flashpool"
  # Dataset filesystem type
  fstype: "zfs"
  # ZFS dataset properties
  recordsize: "8k"
  compression: "lz4"
  dedup: "off"
  sync: "always"
  # Volume type: dataset (zvol for block device, dataset for filesystem)
  voltype: "dataset"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
---
# StorageClass for block device volumes (zvols)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: zfs-zvol-postgresql
provisioner: zfs.csi.openebs.io
parameters:
  poolname: "dbpool"
  fstype: "ext4"
  voltype: "zvol"
  volblocksize: "8k"
  compression: "lz4"
  dedup: "off"
  thinprovision: "yes"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### Using ZFS PVCs in Applications

```yaml
# postgres-statefulset-zfs.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  serviceName: postgresql
  replicas: 1
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: POSTGRES_DB
              value: production
            - name: POSTGRES_USER
              value: admin
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "8"
              memory: 16Gi
  volumeClaimTemplates:
    - metadata:
        name: postgres-data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: zfs-zvol-postgresql
        resources:
          requests:
            storage: 200Gi
```

### ZFS CSI Snapshot Integration

```yaml
# zfs-volumesnapshotclass.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: zfs-snapshotclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: zfs.csi.openebs.io
deletionPolicy: Delete
---
# Take a snapshot of a ZFS-backed PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-20310323
  namespace: databases
spec:
  volumeSnapshotClassName: zfs-snapshotclass
  source:
    persistentVolumeClaimName: postgres-data-postgresql-0
```

```bash
# Verify snapshot was created
kubectl get volumesnapshot -n databases
kubectl get volumesnapshotcontent

# On the node, verify ZFS snapshot
zfs list -t snapshot | grep kubernetes
# flashpool/pvc-abcd1234@snapshot-xyz...
```

### ZFS Backup Integration for Kubernetes Volumes

```bash
#!/bin/bash
# k8s-zfs-backup.sh
# Back up all ZFS-backed Kubernetes PVCs using ZFS send

BACKUP_SERVER="backup-server.internal.company.com"
BACKUP_POOL="backuppool"
ZFS_POOL="flashpool"
NAMESPACE="databases"

# Get all ZFS PVs in the namespace
PVCS=$(kubectl get pvc -n "${NAMESPACE}" \
  -o jsonpath='{range .items[*]}{.spec.volumeName}{"\n"}{end}')

for PVC_VOLUME in ${PVCS}; do
  # Find the ZFS dataset for this PV
  ZFS_DATASET="${ZFS_POOL}/$(kubectl get pv "${PVC_VOLUME}" \
    -o jsonpath='{.spec.csi.volumeHandle}')"

  echo "Backing up ZFS dataset: ${ZFS_DATASET}"

  # Create timestamped snapshot
  SNAPSHOT="${ZFS_DATASET}@backup-$(date +%Y%m%d-%H%M%S)"
  zfs snapshot "${SNAPSHOT}"

  # Replicate to backup server
  syncoid \
    --no-sync-snap \
    "${ZFS_DATASET}" \
    "${BACKUP_SERVER}:${BACKUP_POOL}/${PVC_VOLUME}"

  echo "Completed backup for ${PVC_VOLUME}"
done
```

## Section 10: Performance Benchmarking

```bash
#!/bin/bash
# zfs-benchmark.sh
# Comprehensive ZFS performance test

DATASET="datapool/benchmark-test"
MOUNT_POINT="/mnt/zfs-bench"

zfs create -o mountpoint="${MOUNT_POINT}" "${DATASET}"

echo "=== Sequential Write Performance ==="
fio --name=seq-write \
  --directory="${MOUNT_POINT}" \
  --rw=write \
  --bs=128k \
  --numjobs=4 \
  --size=10G \
  --time_based \
  --runtime=60 \
  --ioengine=sync \
  --direct=1 \
  --group_reporting

echo "=== Sequential Read Performance ==="
fio --name=seq-read \
  --directory="${MOUNT_POINT}" \
  --rw=read \
  --bs=128k \
  --numjobs=4 \
  --size=10G \
  --time_based \
  --runtime=60 \
  --ioengine=sync \
  --direct=1 \
  --group_reporting

echo "=== Random 4K Read (simulating database) ==="
fio --name=rand-read-4k \
  --directory="${MOUNT_POINT}" \
  --rw=randread \
  --bs=4k \
  --numjobs=8 \
  --size=10G \
  --time_based \
  --runtime=60 \
  --ioengine=sync \
  --direct=1 \
  --group_reporting

# Cleanup
zfs destroy "${DATASET}"
```

## Conclusion

ZFS on Linux is production-ready and provides capabilities unavailable in any other Linux filesystem: atomic transactions, end-to-end checksumming, copy-on-write snapshots, and integrated replication. The key to effective ZFS deployment is correct pool topology selection for your failure model, proper `ashift` setting at pool creation (not fixable later), dataset hierarchy design that leverages property inheritance, and ARC sizing appropriate to your workload's read pattern.

For Kubernetes environments, the OpenEBS ZFS CSI driver bridges ZFS's operational advantages directly to the PersistentVolume lifecycle, enabling database workloads to benefit from instant snapshots, compression-in-flight, and ZFS send/receive-based backup without any application changes.
