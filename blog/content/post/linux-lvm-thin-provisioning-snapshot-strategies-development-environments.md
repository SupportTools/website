---
title: "Linux LVM Thin Provisioning: Snapshot Strategies for Development Environments"
date: 2031-02-24T00:00:00-05:00
draft: false
tags: ["Linux", "LVM", "Storage", "Thin Provisioning", "Snapshots", "DevOps", "Docker"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to LVM thin provisioning covering thin pool creation, volume management, snapshot workflows, auto-extend configuration, Docker devicemapper integration, and clone-based test environment automation."
more_link: "yes"
url: "/linux-lvm-thin-provisioning-snapshot-strategies-development-environments/"
---

LVM thin provisioning enables storage virtualization at the block layer: volumes appear large but consume only the space actually written. Combined with thin snapshots — which share unchanged blocks with their origin — thin provisioning makes it practical to create dozens of full environment clones in seconds rather than copying gigabytes of data.

This guide covers the complete LVM thin stack from pool creation through production-grade snapshot workflows for database cloning, test environment management, and Docker/Podman storage backends.

<!--more-->

# Linux LVM Thin Provisioning: Snapshot Strategies for Development Environments

## Section 1: LVM Architecture Review

LVM organizes storage in three layers:

```
Physical Volumes (PV)  — raw disks or partitions
    ↓
Volume Groups (VG)     — pool of PV storage
    ↓
Logical Volumes (LV)   — virtual block devices carved from VG
```

Thin provisioning adds a fourth component:

```
Volume Group
    └── Thin Pool LV          — actual storage reservation
            ├── Thin Volume 1 — virtual volume (uses pool blocks)
            ├── Thin Volume 2
            └── Thin Snapshot — point-in-time copy (shares blocks with origin)
```

### Key Concepts

- **Thin pool**: A logical volume that stores all data blocks for thin volumes and their metadata.
- **Thin volume**: A logical volume backed by the thin pool. Allocates blocks on write.
- **Thin snapshot**: A zero-cost copy of a thin volume. Initially shares all blocks; diverges only as either volume is written.
- **Over-provisioning**: Total virtual size of all thin volumes can exceed the physical pool size. Works as long as actual usage stays within pool capacity.

## Section 2: Creating a Thin Pool

### Prepare Physical Storage

```bash
# List available block devices
lsblk
# NAME   MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS
# sda      8:0    0   500G  0 disk
# sdb      8:16   0   1.0T  0 disk  <- use for LVM thin pool
# sdc      8:32   0   1.0T  0 disk  <- second drive for VG

# Create physical volumes
pvcreate /dev/sdb /dev/sdc

# Verify PVs
pvs
# PV         VG  Fmt  Attr PSize   PFree
# /dev/sdb       lvm2 ---   1.00t  1.00t
# /dev/sdc       lvm2 ---   1.00t  1.00t

# Create a volume group named 'storage'
vgcreate storage /dev/sdb /dev/sdc

# Verify VG
vgs
# VG      #PV #LV #SN Attr   VSize VFree
# storage   2   0   0 wz--n- 1.99t 1.99t
```

### Create the Thin Pool

```bash
# Method 1: Single command — create thin pool with 80% of VG
# -L sets the data size, --chunksize sets the minimum allocation unit
lvcreate \
  --type thin-pool \
  --name thinpool \
  --size 1600G \
  --chunksize 512k \
  --poolmetadatasize 16G \
  storage

# Method 2: Manual — create separate data and metadata volumes
# Step 1: Create data LV
lvcreate -L 1600G -n thinpool_data storage

# Step 2: Create metadata LV (1% of data, minimum 2 MB)
lvcreate -L 16G -n thinpool_meta storage

# Step 3: Convert to thin pool
lvconvert \
  --type thin-pool \
  --poolmetadata storage/thinpool_meta \
  storage/thinpool_data

# Rename to clean name
lvrename storage/thinpool_data storage/thinpool

# Verify the thin pool
lvs -a -o name,size,pool_lv,origin,data_percent,metadata_percent storage
# LV              LSize   Pool     Orign Data% Meta%
# thinpool        1.56t                   0.00  0.10
# [thinpool_tmeta]  16.00g                0.10
# [thinpool_tdata]  1.56t

# Detailed pool info
lvdisplay storage/thinpool
# --- Logical volume ---
# LV Name                storage/thinpool
# LV Status              available
# LV Size                1.56 TiB
# Allocated pool data    0.00%
# Allocated metadata     0.10%
# Current LE             419430
# Segments               1
# Allocation             inherit
# Read ahead sectors     auto
```

### Thin Pool Metadata Sizing

```bash
# Rule of thumb: metadata = 1% of data, or use the formula:
# metadata_bytes = data_bytes / chunk_size * 48 bytes

# For 1600 GB pool with 512KB chunk size:
python3 -c "
data_bytes = 1600 * 1024**3
chunk_size = 512 * 1024
metadata_bytes = (data_bytes / chunk_size) * 48
print(f'Minimum metadata: {metadata_bytes / 1024**3:.2f} GB')
"
# Minimum metadata: 0.14 GB (but use at least 2-4 GB for safety)
# For heavy snapshot workloads with many thin volumes, use 16 GB
```

## Section 3: Creating Thin Volumes

```bash
# Create a 500 GB thin volume (backed by the thinpool)
lvcreate \
  --type thin \
  --thinpool storage/thinpool \
  --virtualsize 500G \
  --name data \
  storage

# Create a 1 TB thin volume (will fail when pool fills up, not when created)
lvcreate \
  --type thin \
  --thinpool storage/thinpool \
  --virtualsize 1T \
  --name archive \
  storage

# Check volumes
lvs storage
# LV       VG      Attr       LSize   Pool     Origin Data%  Meta%
# archive  storage Vwi-a-tz-- 1.00t   thinpool        0.00   0.00
# data     storage Vwi-a-tz-- 500.00g thinpool        0.00   0.00
# thinpool storage twi-aotz-- 1.56t                   0.00   0.10

# The volume appears as a block device
ls -la /dev/storage/data
# lrwxrwxrwx 1 root root 7 Jan 1 00:00 /dev/storage/data -> ../dm-3

# Create a filesystem
mkfs.xfs /dev/storage/data

# Mount it
mkdir -p /mnt/data
mount /dev/storage/data /mnt/data

# Check actual disk usage (notice: 500 GB virtual, ~20 MB actual)
df -h /mnt/data
# Filesystem              Size  Used Avail Use% Mounted on
# /dev/mapper/storage-data 500G  3.6G  497G   1% /mnt/data

# Pool still shows minimal usage
lvs -o name,size,data_percent storage/thinpool
# LV       LSize   Data%
# thinpool  1.56t   0.72   (filesystem overhead for XFS metadata)
```

## Section 4: Thin Snapshots — Zero-Copy Cloning

Thin snapshots are the primary advantage of thin provisioning. A snapshot shares all existing blocks with the origin; blocks diverge only when either is written.

```bash
# Create a snapshot of /dev/storage/data
# Snapshots of thin volumes are themselves thin — zero copy-on-write overhead

# 1. (Recommended) Freeze the filesystem before snapshotting for consistency
fsfreeze --freeze /mnt/data

# 2. Create the snapshot
lvcreate \
  --snapshot \
  --name data-snap-$(date +%Y%m%d-%H%M%S) \
  storage/data

# 3. Unfreeze immediately
fsfreeze --unfreeze /mnt/data

# Snapshot is created instantly regardless of volume size!
# Check the snapshot
lvs -o name,size,pool_lv,origin,data_percent storage
# LV                          LSize   Pool     Origin Data% Meta%
# data                        500.00g thinpool        3.45
# data-snap-20310224-120000   500.00g thinpool data    0.00
# thinpool                      1.56t                  3.45  0.10

# Note: snapshot Data% is 0.00 — it shares all blocks with the origin
# New writes to 'data' or the snapshot cause divergence and consume space
```

### Mounting Snapshots Read-Only

```bash
# Mount the snapshot (read-only for integrity)
mkdir -p /mnt/data-snap
mount -o ro /dev/storage/data-snap-20310224-120000 /mnt/data-snap

# Access the point-in-time consistent copy
ls /mnt/data-snap/

# Use for backup, analysis, or restore operations
rsync -av /mnt/data-snap/ /backup/data-20310224/
```

### Creating a Writeable Clone

For test environments, you want a fully independent writeable copy:

```bash
# Create a writeable snapshot (thin snapshot is always thin — not a full copy)
lvcreate \
  --snapshot \
  --name data-clone-team-alpha \
  storage/data

# Mount the clone writeable
mkdir -p /mnt/clone-alpha
mount /dev/storage/data-clone-team-alpha /mnt/clone-alpha

# Team alpha can now write to their clone independently
# Their writes only consume space proportional to what they change

# Initial state: clone shares 100% of blocks with origin
# After team alpha modifies 10 GB of data: clone uses ~10 GB of pool space
lvs -o name,data_percent storage
# data                     3.45   <- original
# data-clone-team-alpha    3.45   <- same initially
# [after writes]
# data-clone-team-alpha    5.12   <- diverged by ~10 GB
```

## Section 5: Database Clone Workflow

The canonical use case: clone a production database for development and testing.

```bash
#!/bin/bash
# clone-database.sh — create a fresh database clone in seconds

set -euo pipefail

VG="storage"
THIN_POOL="thinpool"
SOURCE_LV="postgres-production"
CLONE_PREFIX="postgres-clone"
MOUNT_BASE="/mnt/postgres-clones"

usage() {
    echo "Usage: $0 <clone-name>"
    echo "Example: $0 team-payments"
    exit 1
}

[ $? -ge 1 ] && [ -n "${1:-}" ] || usage
CLONE_NAME="${1}"
CLONE_LV="${CLONE_PREFIX}-${CLONE_NAME}"
CLONE_MOUNT="${MOUNT_BASE}/${CLONE_NAME}"

echo "Creating clone: ${CLONE_LV}"

# Check if source LV exists
if ! lvs "${VG}/${SOURCE_LV}" &>/dev/null; then
    echo "ERROR: Source LV ${VG}/${SOURCE_LV} not found"
    exit 1
fi

# Check if clone already exists
if lvs "${VG}/${CLONE_LV}" &>/dev/null; then
    echo "ERROR: Clone ${CLONE_LV} already exists. Remove it first."
    exit 1
fi

# Get the PostgreSQL data directory mount point
SOURCE_MOUNT=$(findmnt -n -o TARGET --source "/dev/${VG}/${SOURCE_LV}" 2>/dev/null || echo "/mnt/postgres-production")

# Step 1: Put PostgreSQL in backup mode for consistent snapshot
if systemctl is-active postgresql &>/dev/null; then
    echo "Starting PostgreSQL backup mode..."
    psql -U postgres -c "SELECT pg_start_backup('clone-${CLONE_NAME}', true);" 2>/dev/null || true
fi

# Step 2: Freeze the filesystem
echo "Freezing filesystem..."
fsfreeze --freeze "${SOURCE_MOUNT}"

# Step 3: Create the thin snapshot (instant)
echo "Creating thin snapshot..."
lvcreate --snapshot --name "${CLONE_LV}" "${VG}/${SOURCE_LV}"
SNAPSHOT_CREATED_AT=$(date +%Y-%m-%dT%H:%M:%S)

# Step 4: Unfreeze immediately
echo "Unfreezing filesystem..."
fsfreeze --unfreeze "${SOURCE_MOUNT}"

# Step 5: End backup mode
if systemctl is-active postgresql &>/dev/null; then
    psql -U postgres -c "SELECT pg_stop_backup();" 2>/dev/null || true
fi

# Step 6: Mount the clone
echo "Mounting clone..."
mkdir -p "${CLONE_MOUNT}"
mount /dev/"${VG}/${CLONE_LV}" "${CLONE_MOUNT}"

# Step 7: Update PostgreSQL configuration for the clone
# Change port, data directory identifier, etc.
PG_DATA="${CLONE_MOUNT}/postgresql"  # adjust path to your setup
if [ -f "${PG_DATA}/postgresql.conf" ]; then
    # Generate new port for this clone
    BASE_PORT=5432
    CLONE_NUMBER=$(echo "${CLONE_NAME}" | cksum | awk '{print $1 % 1000}')
    CLONE_PORT=$((BASE_PORT + 100 + CLONE_NUMBER))

    # Update configuration
    sed -i "s/^port = .*/port = ${CLONE_PORT}/" "${PG_DATA}/postgresql.conf"
    sed -i "s/^data_directory = .*/data_directory = '${PG_DATA}'/" "${PG_DATA}/postgresql.conf" 2>/dev/null || true

    echo "Clone will run on port: ${CLONE_PORT}"
fi

# Step 8: Record clone metadata
cat > "${CLONE_MOUNT}/.clone-info" <<EOF
clone_name=${CLONE_NAME}
source_lv=${SOURCE_LV}
created_at=${SNAPSHOT_CREATED_AT}
created_by=$(whoami)
EOF

echo "Clone created successfully!"
echo "  LV:     /dev/${VG}/${CLONE_LV}"
echo "  Mount:  ${CLONE_MOUNT}"
echo "  Status: $(lvs --noheadings -o data_percent ${VG}/${CLONE_LV} | tr -d ' ')% used"
echo ""
echo "To start the clone:"
echo "  systemctl start postgresql@${CLONE_NAME}"
echo ""
echo "To remove the clone:"
echo "  $0 --remove ${CLONE_NAME}"
```

### Bulk Clone Creation for CI/CD

```bash
#!/bin/bash
# provision-test-environments.sh — create N test environments in parallel

set -euo pipefail

NUM_ENVIRONMENTS=10
VG="storage"
SOURCE_LV="postgres-test-baseline"
CLONE_PREFIX="postgres-ci"

echo "Provisioning ${NUM_ENVIRONMENTS} test environments..."
START=$(date +%s)

# Create snapshot baseline (we snapshot from this, not production)
# This ensures all test clones share the same baseline blocks
BASELINE_SNAP="${SOURCE_LV}-baseline-$(date +%Y%m%d)"
if ! lvs "${VG}/${BASELINE_SNAP}" &>/dev/null; then
    echo "Creating baseline snapshot..."
    fsfreeze --freeze "/mnt/${SOURCE_LV}" 2>/dev/null || true
    lvcreate --snapshot --name "${BASELINE_SNAP}" "${VG}/${SOURCE_LV}"
    fsfreeze --unfreeze "/mnt/${SOURCE_LV}" 2>/dev/null || true
fi

# Create N clones from the baseline in parallel
for i in $(seq 1 ${NUM_ENVIRONMENTS}); do
    (
        CLONE_NAME="${CLONE_PREFIX}-${i}"
        lvcreate --snapshot \
            --name "${CLONE_NAME}" \
            "${VG}/${BASELINE_SNAP}" 2>/dev/null
        mkdir -p "/mnt/${CLONE_NAME}"
        mount "/dev/${VG}/${CLONE_NAME}" "/mnt/${CLONE_NAME}"
        echo "  [✓] Environment ${i} ready at /mnt/${CLONE_NAME}"
    ) &
done

wait

END=$(date +%s)
echo ""
echo "All ${NUM_ENVIRONMENTS} environments provisioned in $((END - START)) seconds"
echo "Pool usage after provisioning:"
lvs -o name,size,data_percent "${VG}/${BASELINE_SNAP}" "${VG}/${SOURCE_LV}"
```

## Section 6: Thin Pool Monitoring and Auto-Extend

A full thin pool is catastrophic — writes fail with I/O errors. Monitoring and auto-extension are mandatory in production.

### Manual Monitoring

```bash
# Check pool usage
lvs -o name,lv_size,data_percent,metadata_percent storage/thinpool
# LV       LSize   Data%  Meta%
# thinpool  1.56t  72.40  1.24

# More detailed
lvdisplay --maps storage/thinpool | grep -E "percent|size|Alloc"

# Alert threshold check
DATA_PCT=$(lvs --noheadings -o data_percent storage/thinpool | tr -d ' ')
META_PCT=$(lvs --noheadings -o metadata_percent storage/thinpool | tr -d ' ')

python3 -c "
data = $DATA_PCT
meta = $META_PCT
if data > 80:
    print(f'WARNING: Thin pool data {data:.1f}% full — consider extending')
if meta > 80:
    print(f'WARNING: Thin pool metadata {meta:.1f}% full — extend immediately')
if data > 95 or meta > 95:
    print('CRITICAL: Thin pool nearly full — immediate action required')
"
```

### Configuring LVM Auto-Extend (lvm2-monitor)

LVM includes a monitoring daemon that can automatically extend thin pools:

```bash
# Edit LVM configuration
vim /etc/lvm/lvm.conf

# Find or add the thin_pool_autoextend_threshold and thin_pool_autoextend_percent settings
# under the activation section:
```

```
# /etc/lvm/lvm.conf (relevant section)
activation {
    # Automatically extend thin pool when data usage exceeds threshold
    # Set to 70 to extend at 70% full
    thin_pool_autoextend_threshold = 70

    # Extend by this percentage of current size
    # At 1600 GB pool, 20% = 320 GB extension
    thin_pool_autoextend_percent = 20
}
```

```bash
# Enable and start the LVM monitoring service
systemctl enable lvm2-monitor
systemctl start lvm2-monitor

# Verify auto-extend is active
systemctl status lvm2-monitor

# Test by simulating a threshold crossing:
# (Don't actually do this in production — it's for verification)
# lvchange --activate y --setautoextend 70 storage/thinpool

# Check journald for auto-extend events
journalctl -u lvm2-monitor -f
# Jan 01 12:00:00 server lvm[1234]: Thin pool storage/thinpool extended by 20%
```

### Manual Pool Extension

```bash
# Extend the thin pool data area by 200 GB
lvextend -L +200G storage/thinpool

# Verify extension
lvs storage/thinpool
# LV       VG      LSize   Data%
# thinpool storage  1.75t  64.00  <- same data, more capacity

# Extend pool metadata separately if needed
# Metadata fills much slower than data but also needs attention
lvextend --poolmetadatasize +4G storage/thinpool

# Alternative: extend by adding a new PV to the VG first
pvcreate /dev/sdd
vgextend storage /dev/sdd
lvextend -L +500G storage/thinpool
```

### Prometheus Alerting for Thin Pools

```bash
#!/bin/bash
# lvm-exporter.sh — simple exporter for LVM thin pool metrics

while true; do
    # Output Prometheus text format to a file read by node_exporter
    OUTPUT="/var/lib/node_exporter/textfile/lvm_thin.prom"

    {
        echo "# HELP lvm_thin_pool_data_percent Thin pool data utilization percentage"
        echo "# TYPE lvm_thin_pool_data_percent gauge"
        echo "# HELP lvm_thin_pool_meta_percent Thin pool metadata utilization percentage"
        echo "# TYPE lvm_thin_pool_meta_percent gauge"

        lvs --noheadings -o vg_name,lv_name,lv_attr,data_percent,metadata_percent 2>/dev/null | \
        while read vg lv attr data meta; do
            # Only process thin pools (attr contains 't')
            if [[ "$attr" == *t* ]]; then
                echo "lvm_thin_pool_data_percent{vg=\"${vg}\",lv=\"${lv}\"} ${data:-0}"
                echo "lvm_thin_pool_meta_percent{vg=\"${vg}\",lv=\"${lv}\"} ${meta:-0}"
            fi
        done

        echo "# HELP lvm_thin_volume_data_percent Thin volume data utilization"
        echo "# TYPE lvm_thin_volume_data_percent gauge"
        lvs --noheadings -o vg_name,lv_name,pool_lv,data_percent 2>/dev/null | \
        while read vg lv pool data; do
            if [ -n "$pool" ]; then
                echo "lvm_thin_volume_data_percent{vg=\"${vg}\",lv=\"${lv}\",pool=\"${pool}\"} ${data:-0}"
            fi
        done
    } > "$OUTPUT.tmp"
    mv "$OUTPUT.tmp" "$OUTPUT"

    sleep 30
done
```

```yaml
# Prometheus alerting rules for LVM thin pools
groups:
  - name: lvm_thin_pool
    rules:
      - alert: LVMThinPoolDataHigh
        expr: lvm_thin_pool_data_percent > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "LVM thin pool {{ $labels.vg }}/{{ $labels.lv }} is {{ $value }}% full"
          description: "Consider extending the thin pool or removing snapshots"

      - alert: LVMThinPoolDataCritical
        expr: lvm_thin_pool_data_percent > 90
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "LVM thin pool {{ $labels.vg }}/{{ $labels.lv }} CRITICAL at {{ $value }}%"
          description: "Immediate action required — extend pool or free space"

      - alert: LVMThinPoolMetaHigh
        expr: lvm_thin_pool_meta_percent > 70
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "LVM thin pool metadata {{ $labels.vg }}/{{ $labels.lv }} is {{ $value }}% full"
```

## Section 7: Merging Snapshots

When you want to roll back a volume to a snapshot state:

```bash
# Unmount the volume
umount /mnt/data

# Deactivate the logical volume
lvchange --activate n storage/data

# Merge the snapshot back into the origin
# This replaces the origin with the snapshot's state
lvconvert --merge storage/data-snap-20310224-120000

# Reactivate and mount
lvchange --activate y storage/data
mount /dev/storage/data /mnt/data

# The merge is complete when the snapshot LV disappears
lvs storage  # snapshot LV is gone
```

**Note**: Merging is destructive to current origin state. Always verify the snapshot is what you want before merging.

## Section 8: Docker/Podman with devicemapper Thin Pool

Docker and Podman can use an LVM thin pool as their storage backend via the `devicemapper` driver. This provides per-container thin volumes:

### Configure Docker with devicemapper

```bash
# Create a dedicated thin pool for Docker
lvcreate \
  --type thin-pool \
  --name dockerpool \
  --size 200G \
  --chunksize 512k \
  --poolmetadatasize 4G \
  storage

# Configure Docker daemon
cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "devicemapper",
  "storage-opts": [
    "dm.thinpooldev=/dev/mapper/storage-dockerpool",
    "dm.use_deferred_removal=true",
    "dm.use_deferred_deletion=true",
    "dm.fs=xfs",
    "dm.basesize=20G",
    "dm.min_free_space=10%"
  ],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}
EOF

# Restart Docker
systemctl restart docker

# Verify devicemapper is active
docker info | grep -A 10 "Storage Driver"
# Storage Driver: devicemapper
#  Pool Name: storage-dockerpool
#  Data file:
#  Metadata file:
#  Data Space Used: 3.12 GB
#  Data Space Total: 200.0 GB
```

### Monitor Docker Thin Pool

```bash
# Check Docker's view of pool usage
docker system df -v

# Check LVM's view
lvs -o name,size,data_percent storage/dockerpool

# Clean up unused Docker resources to free pool space
docker system prune -f
docker volume prune -f

# Extend the Docker pool if needed
lvextend -L +100G storage/dockerpool
```

## Section 9: Snapshot-Based Backup Workflow

```bash
#!/bin/bash
# backup-with-snapshot.sh — consistent backup using thin snapshot

set -euo pipefail

VG="storage"
SOURCE_LV="$1"
BACKUP_DEST="$2"
SNAP_NAME="${SOURCE_LV}-backup-$(date +%Y%m%d-%H%M%S)"

if [ -z "$SOURCE_LV" ] || [ -z "$BACKUP_DEST" ]; then
    echo "Usage: $0 <lv-name> <backup-destination>"
    exit 1
fi

SOURCE_MOUNT=$(findmnt -n -o TARGET "/dev/${VG}/${SOURCE_LV}")
SNAP_MOUNT="/mnt/backup-snap-$$"

echo "=== Snapshot Backup: ${SOURCE_LV} ==="
echo "Destination: ${BACKUP_DEST}"

# Create consistent snapshot
echo "1. Creating snapshot..."
fsfreeze --freeze "${SOURCE_MOUNT}"
lvcreate --snapshot --name "${SNAP_NAME}" "${VG}/${SOURCE_LV}"
fsfreeze --unfreeze "${SOURCE_MOUNT}"
echo "   Snapshot: /dev/${VG}/${SNAP_NAME}"

# Mount snapshot
echo "2. Mounting snapshot..."
mkdir -p "${SNAP_MOUNT}"
mount -o ro "/dev/${VG}/${SNAP_NAME}" "${SNAP_MOUNT}"

# Run backup from snapshot (doesn't impact production I/O)
echo "3. Running backup..."
START=$(date +%s)

rsync \
  --archive \
  --sparse \
  --hard-links \
  --numeric-ids \
  --delete \
  --stats \
  "${SNAP_MOUNT}/" \
  "${BACKUP_DEST}/" \
  2>&1 | tee "/var/log/backup-${SOURCE_LV}-$(date +%Y%m%d).log"

END=$(date +%s)
echo "   Completed in $((END - START)) seconds"

# Cleanup
echo "4. Cleaning up..."
umount "${SNAP_MOUNT}"
rmdir "${SNAP_MOUNT}"
lvremove -f "${VG}/${SNAP_NAME}"

echo "=== Backup complete ==="
```

## Section 10: Test Environment Lifecycle Management

```bash
#!/bin/bash
# env-manager.sh — manage thin-provisioned test environments

set -euo pipefail

VG="storage"
POOL="thinpool"
BASELINE="app-baseline"
ENV_PREFIX="testenv"
MOUNT_BASE="/mnt/testenvs"

cmd_create() {
    local name="$1"
    local lv="${ENV_PREFIX}-${name}"

    if lvs "${VG}/${lv}" &>/dev/null; then
        echo "ERROR: Environment ${name} already exists"
        return 1
    fi

    echo "Creating environment: ${name}"
    lvcreate --snapshot --name "${lv}" "${VG}/${BASELINE}"
    mkdir -p "${MOUNT_BASE}/${name}"
    mount "/dev/${VG}/${lv}" "${MOUNT_BASE}/${name}"
    echo "Environment ready: ${MOUNT_BASE}/${name}"

    lvs -o name,size,data_percent "${VG}/${lv}"
}

cmd_list() {
    echo "=== Test Environments ==="
    printf "%-30s %-12s %-10s %-20s\n" "NAME" "SIZE" "USED%" "MOUNT"
    lvs --noheadings -o lv_name,lv_size,data_percent "${VG}" | \
    while read lv size pct; do
        if [[ "$lv" == ${ENV_PREFIX}-* ]]; then
            name="${lv#${ENV_PREFIX}-}"
            mount=$(findmnt -n -o TARGET "/dev/${VG}/${lv}" 2>/dev/null || echo "-")
            printf "%-30s %-12s %-10s %-20s\n" "$name" "$size" "$pct" "$mount"
        fi
    done
}

cmd_destroy() {
    local name="$1"
    local lv="${ENV_PREFIX}-${name}"

    if ! lvs "${VG}/${lv}" &>/dev/null; then
        echo "ERROR: Environment ${name} does not exist"
        return 1
    fi

    echo "Destroying environment: ${name}"

    # Unmount if mounted
    local mount="${MOUNT_BASE}/${name}"
    if mountpoint -q "${mount}" 2>/dev/null; then
        umount "${mount}"
        rmdir "${mount}"
    fi

    # Remove LV
    lvremove -f "${VG}/${lv}"
    echo "Environment ${name} destroyed"
}

cmd_reset() {
    local name="$1"
    cmd_destroy "$name"
    cmd_create "$name"
}

cmd_pool_status() {
    echo "=== Thin Pool Status ==="
    lvs -o name,lv_size,data_percent,metadata_percent "${VG}/${POOL}"
    echo ""
    echo "=== Environment Storage Usage ==="
    lvs --noheadings -o lv_name,lv_size,data_percent "${VG}" | \
    grep "^  ${ENV_PREFIX}" | \
    sort -k3 -n -r | head -10
}

case "${1:-help}" in
    create)  cmd_create "${2:?Usage: $0 create <name>}" ;;
    list)    cmd_list ;;
    destroy) cmd_destroy "${2:?Usage: $0 destroy <name>}" ;;
    reset)   cmd_reset "${2:?Usage: $0 reset <name>}" ;;
    status)  cmd_pool_status ;;
    *)       echo "Usage: $0 {create|list|destroy|reset|status} [name]" ;;
esac
```

## Summary

LVM thin provisioning transforms storage management for development and test environments. The key operational points:

- **Thin pools** over-provision storage; thin volumes and snapshots share unchanged blocks.
- **Thin snapshots** are instant and zero-cost initially — a 500 GB volume can be snapshotted in milliseconds.
- **Writeable clones** created from snapshots diverge only at the blocks that are written, making them ideal for per-developer or per-test database environments.
- **Auto-extend** via `lvm2-monitor` prevents pool full scenarios — configure 70% threshold with 20% extension.
- **Monitoring** pool fill percentage is critical; a full thin pool causes I/O errors, not graceful quota exhaustion.
- For Docker environments using the devicemapper storage driver, the same LVM thin pool infrastructure supports per-container thin volumes.
- The snapshot-then-backup workflow decouples backup I/O from production I/O — snapshot in milliseconds, backup from the frozen copy without impacting application performance.
