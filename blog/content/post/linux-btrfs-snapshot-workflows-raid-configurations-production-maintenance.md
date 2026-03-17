---
title: "Linux Btrfs: Snapshot Workflows, RAID Configurations, and Production Maintenance"
date: 2030-11-03T00:00:00-05:00
draft: false
tags: ["Linux", "Btrfs", "Filesystem", "Storage", "RAID", "Snapshots", "Backup"]
categories:
- Linux
- Storage
- Systems Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Btrfs guide covering subvolume and snapshot management, Btrfs RAID modes including RAID1 and RAID10, scrub and balance operations, send/receive for incremental backups, Btrfs quotas, and production maintenance workflows."
more_link: "yes"
url: "/linux-btrfs-snapshot-workflows-raid-configurations-production-maintenance/"
---

Btrfs (B-tree filesystem) offers a set of storage capabilities that traditional Linux filesystems cannot match: native copy-on-write snapshots, integrated RAID, subvolume management, and transparent compression. In production environments, these features enable zero-copy backup pipelines, atomic rollback operations, and efficient incremental data replication without additional tooling. This guide covers enterprise-grade Btrfs operations with production-tested configurations and maintenance procedures.

<!--more-->

## Btrfs Architecture Fundamentals

Btrfs organizes all data in a set of B-trees stored on disk. The key structural elements are:

- **Subvolumes**: Independent filesystem namespaces that appear as directories, each with their own inode space. Every Btrfs filesystem has at least one subvolume (the root subvolume, ID 5).
- **Snapshots**: Read-only or read-write subvolumes that share extent data with their source via copy-on-write (CoW). Snapshots consume no space until data diverges from the original.
- **Extents**: Variable-length data blocks tracked in the extent B-tree. CoW means writes go to new extents; old extents are referenced until all subvolumes that share them are modified.
- **Chunks**: Btrfs allocates space in chunks (typically 1GB for data, 256MB for metadata). RAID is implemented at the chunk allocation level.

## Creating and Configuring Btrfs Filesystems

### Single-Device Setup

```bash
# Create a Btrfs filesystem on a single device
mkfs.btrfs -L data-volume /dev/nvme1n1

# With metadata duplication (recommended for single-device production use)
# -m dup: duplicate metadata on separate areas of the disk
mkfs.btrfs -L data-volume -m dup /dev/nvme1n1

# Mount with production-recommended options
# noatime:         skip access time updates (performance improvement)
# compress=zstd:1  transparent compression, level 1 (fastest, ~20% compression ratio)
# space_cache=v2:  improved free space tracking structure
# autodefrag:      background defragmentation for CoW-heavy workloads
mount -o noatime,compress=zstd:1,space_cache=v2 /dev/nvme1n1 /mnt/data

# Persistent mount in /etc/fstab
echo "UUID=$(blkid -s UUID -o value /dev/nvme1n1)  /mnt/data  btrfs  noatime,compress=zstd:1,space_cache=v2,autodefrag  0  0" >> /etc/fstab
```

### RAID Configuration

Btrfs implements RAID at the chunk level. The RAID profile applies separately to data and metadata:

```bash
# RAID1 (mirroring) across two devices
# -d raid1: data mirrored across both devices
# -m raid1: metadata mirrored across both devices
mkfs.btrfs -L production-raid1 \
  -d raid1 \
  -m raid1 \
  /dev/sdb /dev/sdc

# RAID10 across four devices (striped + mirrored)
# Requires at least 4 devices
# -d raid10: data striped and mirrored
# -m raid1c3: metadata replicated on 3 of 4 devices (recommended for RAID10)
mkfs.btrfs -L production-raid10 \
  -d raid10 \
  -m raid1c3 \
  /dev/sdb /dev/sdc /dev/sdd /dev/sde

# RAID5 across three or more devices
# WARNING: Btrfs RAID5/6 has known data loss bugs under power failure
# DO NOT use RAID5/6 in production as of kernel 6.x
# Use Linux MD-RAID or ZFS RAIDZ instead for parity RAID
mkfs.btrfs -L testing-only-raid5 \
  -d raid5 \
  -m raid1c3 \
  /dev/sdb /dev/sdc /dev/sdd

# Adding a device to an existing Btrfs filesystem (online)
btrfs device add /dev/sdd /mnt/data

# Converting single-device filesystem to RAID1 after adding device
btrfs balance start -dconvert=raid1 -mconvert=raid1 /mnt/data

# Removing a device from RAID1 (data redistributed automatically)
btrfs device remove /dev/sdc /mnt/data
```

### RAID Status and Health

```bash
# Show filesystem and device status
btrfs filesystem show /mnt/data

# Expected output for healthy RAID1:
# Label: 'production-raid1'  uuid: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#         Total devices 2 FS bytes used 847.23GiB
#         devid    1 size 1.82TiB used 866.02GiB path /dev/sdb
#         devid    2 size 1.82TiB used 866.02GiB path /dev/sdc

# Show RAID allocation statistics
btrfs filesystem df /mnt/data

# Output:
# Data, RAID1: total=856.00GiB, used=847.23GiB
# System, RAID1: total=32.00MiB, used=144.00KiB
# Metadata, RAID1: total=10.00GiB, used=8.84GiB
# GlobalReserve, single: total=512.00MiB, used=0.00B

# Monitor device stats (error counters)
btrfs device stats /mnt/data
# Output shows per-device error counts:
# [/dev/sdb].write_io_errs    0
# [/dev/sdb].read_io_errs     0
# [/dev/sdb].flush_io_errs    0
# [/dev/sdb].corruption_errs  0
# [/dev/sdb].generation_errs  0
```

## Subvolume Management

### Creating and Organizing Subvolumes

Production Btrfs deployments use a flat subvolume layout for snapshot management:

```bash
# Mount the Btrfs root (subvolume ID 5) for subvolume management
mount -o subvolid=5 /dev/sdb /mnt/btrfs-root

# Create the top-level subvolume structure
# Recommended layout separating data from snapshots
btrfs subvolume create /mnt/btrfs-root/@
btrfs subvolume create /mnt/btrfs-root/@home
btrfs subvolume create /mnt/btrfs-root/@var
btrfs subvolume create /mnt/btrfs-root/@var-log
btrfs subvolume create /mnt/btrfs-root/@snapshots

# List all subvolumes showing IDs and parent relationships
btrfs subvolume list /mnt/btrfs-root

# Expected output:
# ID 256 gen 42 top level 5 path @
# ID 257 gen 38 top level 5 path @home
# ID 258 gen 40 top level 5 path @var
# ID 259 gen 41 top level 5 path @var-log
# ID 260 gen 42 top level 5 path @snapshots

# Mount individual subvolumes via /etc/fstab
# UUID=<filesystem-uuid>  /         btrfs  subvol=@,noatime,compress=zstd:1  0 0
# UUID=<filesystem-uuid>  /home     btrfs  subvol=@home,noatime,compress=zstd:1  0 0
# UUID=<filesystem-uuid>  /var      btrfs  subvol=@var,noatime,compress=zstd:1  0 0
# UUID=<filesystem-uuid>  /var/log  btrfs  subvol=@var-log,noatime,compress=zstd:1  0 0
```

### Nested Subvolumes for Container Storage

```bash
# Create subvolumes for container overlay storage (e.g., containerd)
# Each container gets its own subvolume for snapshot-based layers
btrfs subvolume create /mnt/btrfs-root/@container-images
btrfs subvolume create /mnt/btrfs-root/@container-containers
btrfs subvolume create /mnt/btrfs-root/@container-volumes

# Get subvolume ID for mount
btrfs subvolume show /mnt/btrfs-root/@container-images | grep "Subvolume ID"
# Subvolume ID: 261

# Mount for containerd
mount -o subvol=@container-images /dev/sdb /var/lib/containerd/io.containerd.snapshotter.v1.btrfs
```

## Snapshot Management

### Manual Snapshots

```bash
# Create a read-only snapshot (point-in-time backup)
# -r flag creates a read-only snapshot
SNAP_DATE=$(date +%Y%m%d-%H%M%S)
btrfs subvolume snapshot -r / /mnt/btrfs-root/@snapshots/root-${SNAP_DATE}
btrfs subvolume snapshot -r /home /mnt/btrfs-root/@snapshots/home-${SNAP_DATE}

# Create a read-write snapshot (for testing or rollback staging)
btrfs subvolume snapshot /mnt/btrfs-root/@ /mnt/btrfs-root/@test-snapshot

# List snapshots
btrfs subvolume list -s /mnt/btrfs-root

# Delete a snapshot
btrfs subvolume delete /mnt/btrfs-root/@snapshots/root-20251103-140000

# Delete all snapshots older than 30 days
find /mnt/btrfs-root/@snapshots -maxdepth 1 -type d -mtime +30 | \
  while read snap; do
    echo "Deleting: $snap"
    btrfs subvolume delete "$snap"
  done
```

### Automated Snapshot Script

```bash
#!/bin/bash
# /usr/local/sbin/btrfs-snapshot.sh
# Automated snapshot management with retention policy
# Run via systemd timer or cron

set -euo pipefail

BTRFS_ROOT="/mnt/btrfs-root"
SNAP_DIR="${BTRFS_ROOT}/@snapshots"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="/var/log/btrfs-snapshots.log"

# Retention policy
HOURLY_KEEP=24
DAILY_KEEP=30
WEEKLY_KEEP=12

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

create_snapshot() {
    local source="$1"
    local name="$2"
    local snap_path="${SNAP_DIR}/${name}-${TIMESTAMP}"

    log "Creating snapshot: ${snap_path}"
    btrfs subvolume snapshot -r "${source}" "${snap_path}"

    # Tag with type for retention management
    touch "${snap_path}/.snapshot-type-${name}"
    log "Snapshot created successfully: ${snap_path}"
}

delete_old_snapshots() {
    local prefix="$1"
    local keep="$2"

    local snapshots
    snapshots=$(find "${SNAP_DIR}" -maxdepth 1 -name "${prefix}-*" -type d | sort)
    local count
    count=$(echo "${snapshots}" | grep -c . || true)

    if [ "${count}" -gt "${keep}" ]; then
        local delete_count=$(( count - keep ))
        log "Pruning ${delete_count} old ${prefix} snapshots (keeping ${keep})"
        echo "${snapshots}" | head -n "${delete_count}" | \
          while read -r snap; do
            log "Deleting: ${snap}"
            btrfs subvolume delete "${snap}"
          done
    fi
}

# Determine snapshot type based on time
HOUR=$(date +%H)
DOW=$(date +%u)  # 1=Monday, 7=Sunday

if [ "${HOUR}" = "00" ] && [ "${DOW}" = "7" ]; then
    SNAP_TYPE="weekly"
    KEEP="${WEEKLY_KEEP}"
elif [ "${HOUR}" = "00" ]; then
    SNAP_TYPE="daily"
    KEEP="${DAILY_KEEP}"
else
    SNAP_TYPE="hourly"
    KEEP="${HOURLY_KEEP}"
fi

log "Starting ${SNAP_TYPE} snapshot cycle"

# Create snapshots for each subvolume
create_snapshot "/" "root"
create_snapshot "/home" "home"
create_snapshot "/var" "var"

# Prune old snapshots
delete_old_snapshots "root" "${KEEP}"
delete_old_snapshots "home" "${KEEP}"
delete_old_snapshots "var" "${KEEP}"

# Report space usage after snapshot operations
log "Filesystem usage after snapshots:"
btrfs filesystem df / >> "${LOG_FILE}"

log "Snapshot cycle complete"
```

```ini
# /etc/systemd/system/btrfs-snapshot.service
[Unit]
Description=Btrfs Snapshot Service
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/btrfs-snapshot.sh
StandardOutput=journal
StandardError=journal
```

```ini
# /etc/systemd/system/btrfs-snapshot.timer
[Unit]
Description=Btrfs Snapshot Timer
Requires=btrfs-snapshot.service

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now btrfs-snapshot.timer
```

## Scrub Operations

Btrfs scrub reads all data and metadata, verifying checksums and correcting errors using redundant copies when available (RAID1/RAID10).

```bash
# Start a scrub (runs in the background)
btrfs scrub start /mnt/data

# Start scrub and wait for completion (suitable for scripts)
btrfs scrub start -B /mnt/data

# Check scrub status
btrfs scrub status /mnt/data

# Expected output (clean):
# UUID:             xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Scrub started:    Fri Nov  3 02:00:01 2030
# Status:           finished
# Duration:         0:42:17
# Total to scrub:   847.23GiB
# Rate:             336.49MiB/s
# Error summary:    no errors found

# Expected output (with correctable errors on RAID1):
# Error summary:    corrected=4, unrecoverable=0, no-error

# Cancel a running scrub
btrfs scrub cancel /mnt/data

# Resume a cancelled scrub
btrfs scrub resume /mnt/data

# Systemd timer for monthly scrubs
cat > /etc/systemd/system/btrfs-scrub@.service << 'EOF'
[Unit]
Description=Btrfs Scrub on %i
Documentation=man:btrfs-scrub(8)

[Service]
Type=oneshot
ExecStart=/usr/bin/btrfs scrub start -B %i
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
KillSignal=SIGINT
EOF

cat > /etc/systemd/system/btrfs-scrub@.timer << 'EOF'
[Unit]
Description=Monthly Btrfs Scrub on %i

[Timer]
OnCalendar=monthly
Persistent=true
RandomizedDelaySec=3600

[Install]
WantedBy=timers.target
EOF

# Enable scrub for the root filesystem
systemctl enable --now "btrfs-scrub@$(systemd-escape -p /)"
```

## Balance Operations

The balance operation redistributes data and metadata across all devices and can convert between RAID profiles online.

```bash
# Basic balance — redistribute all data and metadata
# WARNING: This is I/O intensive and may take hours on large filesystems
btrfs balance start /mnt/data

# Balance with usage filter — only process chunks with less than 20% usage
# This is the recommended maintenance balance (much faster)
btrfs balance start -dusage=20 -musage=20 /mnt/data

# Convert metadata from single to RAID1 (after adding a second device)
btrfs balance start -mconvert=raid1 /mnt/data

# Convert data from single to RAID1
btrfs balance start -dconvert=raid1 /mnt/data

# Full conversion from single to RAID1 (combine both)
btrfs balance start \
  -dconvert=raid1 \
  -mconvert=raid1 \
  --bg \
  /mnt/data

# Check balance status
btrfs balance status /mnt/data

# Cancel a running balance
btrfs balance cancel /mnt/data

# Balance paused across reboots — resume
btrfs balance resume /mnt/data

# Useful balance filters:
# -dusage=<percent>: only data chunks below this usage percentage
# -musage=<percent>: only metadata chunks below this usage percentage
# -dlimit=<n>:      process at most n data chunks
# -soft:            allow balance to be interrupted by filesystem operations

# Recommended weekly maintenance balance (gentle, can run during business hours)
btrfs balance start -dusage=75 -musage=75 --bg /mnt/data
```

### When to Run Balance

```bash
# Check for unbalanced allocation (indicator that balance is needed)
btrfs filesystem df /mnt/data

# Warning signs that balance is needed:
# 1. "Data, single" or "Data, RAID1" shows very low used percentage
#    (many allocated but nearly empty chunks)
# 2. "ENOSPC" errors despite df showing available space
#    (metadata allocation exhausted due to fragmentation)
# 3. After adding a device (data not yet spread across new device)

# Autodetect fragmentation requiring balance
btrfs filesystem usage /mnt/data | grep -E "(Data|Metadata|System),"

# If "Unallocated" is low and usage percentage per chunk is low,
# run: btrfs balance start -dusage=50 -musage=50 /mnt/data
```

## Send/Receive for Incremental Backups

Btrfs send/receive is the most efficient incremental backup mechanism for Btrfs. It serializes the delta between two snapshots into a binary stream that can be applied to any Btrfs filesystem.

### Local Incremental Backups

```bash
# Initial full backup
SNAP1="@snapshots/root-20301103-000000"
DEST_SNAP_DIR="/backup/btrfs-snapshots"

# Create read-only snapshot
btrfs subvolume snapshot -r / /mnt/btrfs-root/${SNAP1}

# Send to backup location (initial full send)
btrfs send /mnt/btrfs-root/${SNAP1} | \
  btrfs receive ${DEST_SNAP_DIR}/

# Subsequent incremental backup
SNAP2="@snapshots/root-20301103-010000"
btrfs subvolume snapshot -r / /mnt/btrfs-root/${SNAP2}

# Incremental send: only changes since SNAP1
# -p specifies the parent snapshot for incremental calculation
btrfs send -p /mnt/btrfs-root/${SNAP1} /mnt/btrfs-root/${SNAP2} | \
  btrfs receive ${DEST_SNAP_DIR}/

# The -c flag adds additional clones to improve deduplication
btrfs send \
  -p /mnt/btrfs-root/${SNAP1} \
  -c /mnt/btrfs-root/@snapshots/root-20301101-000000 \
  /mnt/btrfs-root/${SNAP2} | \
  btrfs receive ${DEST_SNAP_DIR}/
```

### Remote Backup via SSH

```bash
#!/bin/bash
# /usr/local/sbin/btrfs-remote-backup.sh
# Incremental Btrfs backup over SSH using send/receive

set -euo pipefail

BTRFS_ROOT="/mnt/btrfs-root"
SNAP_DIR="${BTRFS_ROOT}/@snapshots"
REMOTE_HOST="backup.internal.example.com"
REMOTE_USER="btrfs-backup"
REMOTE_DIR="/backup/btrfs/${HOSTNAME}"
SUBVOL_NAME="root"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
NEW_SNAP="${SNAP_DIR}/${SUBVOL_NAME}-${TIMESTAMP}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Find the most recent successfully replicated snapshot
LAST_SNAP=$(ssh "${REMOTE_USER}@${REMOTE_HOST}" \
  "btrfs subvolume list ${REMOTE_DIR} | grep '${SUBVOL_NAME}-' | tail -1 | awk '{print \$NF}'" 2>/dev/null || true)

# Create new snapshot
log "Creating snapshot: ${NEW_SNAP}"
btrfs subvolume snapshot -r "${BTRFS_ROOT}/@" "${NEW_SNAP}"

if [ -z "${LAST_SNAP}" ]; then
    log "No previous snapshot found — performing full send"
    btrfs send "${NEW_SNAP}" | \
      ssh "${REMOTE_USER}@${REMOTE_HOST}" \
        "btrfs receive ${REMOTE_DIR}/"
else
    PARENT="${SNAP_DIR}/${LAST_SNAP##*/}"
    log "Incremental send from ${PARENT} to ${NEW_SNAP}"
    btrfs send -p "${PARENT}" "${NEW_SNAP}" | \
      ssh "${REMOTE_USER}@${REMOTE_HOST}" \
        "btrfs receive ${REMOTE_DIR}/"
fi

log "Remote backup complete"

# Prune remote snapshots older than 30 days
ssh "${REMOTE_USER}@${REMOTE_HOST}" bash << REMOTE_EOF
  find "${REMOTE_DIR}" -maxdepth 1 -name "${SUBVOL_NAME}-*" -type d \
    -mtime +30 | while read snap; do
    echo "Deleting remote snapshot: \$snap"
    btrfs subvolume delete "\$snap"
  done
REMOTE_EOF
```

### Compressed Send Stream

```bash
# Compress the send stream for bandwidth efficiency
# Use lz4 for fast compression (low CPU overhead)
btrfs send -p ${SNAP1} ${SNAP2} | \
  lz4 -1 | \
  ssh backup-host "lz4 -d | btrfs receive /backup/btrfs/"

# Use zstd for better compression ratio
btrfs send -p ${SNAP1} ${SNAP2} | \
  zstd -1 --stdout | \
  ssh backup-host "zstd -d --stdout | btrfs receive /backup/btrfs/"

# With progress reporting via pv (pipe viewer)
SEND_SIZE=$(btrfs send --no-data -p ${SNAP1} ${SNAP2} 2>/dev/null | wc -c)
btrfs send -p ${SNAP1} ${SNAP2} | \
  pv -s ${SEND_SIZE} -pterab | \
  zstd -1 --stdout | \
  ssh backup-host "zstd -d --stdout | btrfs receive /backup/btrfs/"
```

## Btrfs Quotas

Quotas in Btrfs operate at the subvolume level, tracking and limiting space usage per subvolume.

```bash
# Enable quota tracking on the filesystem
btrfs quota enable /mnt/data

# IMPORTANT: Enabling quotas on a large filesystem with existing data
# triggers a rescan that can take minutes to hours and adds I/O overhead.
# Enable at filesystem creation time for production use.

# Show current quota usage for all subvolumes
btrfs qgroup show /mnt/data

# Example output:
# qgroupid    rfer        excl        max_rfer    max_excl
# --------    ----        ----        --------    --------
# 0/5         -           -           none        none
# 0/256       15.25GiB    12.43GiB    none        none
# 0/257       8.41GiB     8.38GiB     none        none

# Set limits on a subvolume
# Get subvolume ID first
SUBVOL_ID=$(btrfs subvolume show /home | grep "Subvolume ID" | awk '{print $3}')

# Limit referenced space (total, including shared data) to 50GB
btrfs qgroup limit 50G "0/${SUBVOL_ID}" /mnt/data

# Limit exclusive space (data not shared with other subvolumes) to 30GB
btrfs qgroup limit --exclusive 30G "0/${SUBVOL_ID}" /mnt/data

# Show quota for a specific subvolume
btrfs qgroup show -r "0/${SUBVOL_ID}" /mnt/data

# Remove quota limits
btrfs qgroup limit none "0/${SUBVOL_ID}" /mnt/data

# Rescan quota accounting (run after enabling or when counts appear wrong)
btrfs quota rescan /mnt/data

# Check rescan status
btrfs quota rescan --status /mnt/data

# Disable quota tracking
btrfs quota disable /mnt/data
```

### Hierarchical Quotas

```bash
# Create quota groups (qgroups) for multi-tenant storage management
# Level 1 qgroups (0/N) correspond to subvolumes
# Level 2+ qgroups can aggregate multiple subvolumes

# Create a level-1 qgroup manually (for non-subvolume aggregation)
btrfs qgroup create 1/100 /mnt/data

# Assign subvolumes to the aggregate qgroup
btrfs qgroup assign "0/256" "1/100" /mnt/data
btrfs qgroup assign "0/257" "1/100" /mnt/data

# Set limit on the aggregate qgroup (limits total across all member subvolumes)
btrfs qgroup limit 200G "1/100" /mnt/data

# Show the qgroup hierarchy
btrfs qgroup show --sort=qgroupid -p /mnt/data
```

## Production Maintenance Workflows

### Health Check Script

```bash
#!/bin/bash
# /usr/local/sbin/btrfs-health-check.sh
# Automated Btrfs health monitoring

set -euo pipefail

MOUNTPOINTS=("/" "/home" "/var")
ALERT_THRESHOLD_PCT=85  # Alert when filesystem is over 85% full
EXIT_CODE=0

check_filesystem() {
    local mountpoint="$1"
    local device
    device=$(findmnt -n -o SOURCE "${mountpoint}")

    echo "=== Checking ${mountpoint} (${device}) ==="

    # Check device errors
    local dev_stats
    dev_stats=$(btrfs device stats "${mountpoint}" 2>/dev/null)
    if echo "${dev_stats}" | grep -qv " 0$"; then
        echo "WARNING: Non-zero device errors detected:"
        echo "${dev_stats}" | grep -v " 0$"
        EXIT_CODE=1
    fi

    # Check space usage
    local usage_pct
    usage_pct=$(df --output=pcent "${mountpoint}" | tail -1 | tr -d ' %')
    if [ "${usage_pct}" -gt "${ALERT_THRESHOLD_PCT}" ]; then
        echo "WARNING: Filesystem ${mountpoint} is ${usage_pct}% full"
        EXIT_CODE=1
    fi

    # Check metadata usage (separate from data)
    local meta_info
    meta_info=$(btrfs filesystem df "${mountpoint}" | grep "^Metadata")
    local meta_total
    meta_total=$(echo "${meta_info}" | grep -oP 'total=\K[^,]+')
    local meta_used
    meta_used=$(echo "${meta_info}" | grep -oP 'used=\K\S+')
    echo "Metadata: total=${meta_total}, used=${meta_used}"

    # Check for balance necessity (unallocated ratio)
    local unalloc
    unalloc=$(btrfs filesystem usage "${mountpoint}" | \
      grep "Unallocated" | awk '{print $2}')
    echo "Unallocated: ${unalloc}"

    # Check scrub status
    local scrub_stat
    scrub_stat=$(btrfs scrub status "${mountpoint}" 2>/dev/null | \
      grep -E "Status|Error")
    echo "Last scrub: ${scrub_stat}"

    echo ""
}

for mp in "${MOUNTPOINTS[@]}"; do
    if mountpoint -q "${mp}"; then
        check_filesystem "${mp}"
    fi
done

# Report any generation errors across all Btrfs filesystems
for fs in $(btrfs filesystem show 2>/dev/null | grep "^Label" | awk '{print $4}'); do
    GEN_ERRS=$(btrfs device stats UUID="${fs}" 2>/dev/null | \
      grep generation_errs | grep -v " 0" || true)
    if [ -n "${GEN_ERRS}" ]; then
        echo "CRITICAL: Generation errors found in filesystem ${fs}:"
        echo "${GEN_ERRS}"
        EXIT_CODE=2
    fi
done

exit ${EXIT_CODE}
```

### Defragmentation

```bash
# Btrfs autodefrag (mount option) handles incremental defrag automatically
# Manual defrag is needed for pre-existing fragmentation or databases

# Defragment a single file
btrfs filesystem defragment /var/lib/postgres/data/base/16384/pg_internal.init

# Defragment a directory recursively
# -r: recursive
# -v: verbose
# -c: compress after defragment (zstd level 1)
# -l 65536: limit to files larger than 64KB (avoid defragmenting small files)
btrfs filesystem defragment -r -c=zstd:1 -l 65536 /var/lib/postgres/data/

# IMPORTANT: Do NOT defragment subvolume roots — this breaks snapshot sharing
# and causes snapshot contents to be re-materialized, consuming significant space
# Use defrag only on individual files, not filesystem roots

# Check fragmentation extent of a file
btrfs filesystem defragment --check /var/lib/postgres/data/base/16384/1259

# For databases (PostgreSQL), disable autodefrag and use manual defrag during
# maintenance windows only. Autodefrag interferes with WAL performance.
```

### Compression Ratio Analysis

```bash
# Check compression ratio for a path
compsize /var/log/

# Example output:
# Processed 1243 files, 892 regular extents (968 refs), 8 inline.
# Type       Perc     Disk Usage   Uncompressed Referenced
# TOTAL       23%      1.23GiB      5.34GiB      5.71GiB
# none       100%      16.34MiB     16.34MiB     33.23MiB
# zstd        22%      1.21GiB      5.32GiB      5.68GiB

# Enable compression retroactively on existing data
btrfs filesystem defragment -r -c=zstd:1 /var/log/

# Change compression algorithm on already-compressed data
# (requires defragment with new compression flag)
btrfs filesystem defragment -r -c=zstd:3 /path/to/data/
```

## Disaster Recovery

### Recovering from Missing RAID Device

```bash
# Mount degraded RAID1 filesystem with one missing device
# -o degraded allows mounting even with one device missing
mount -o degraded,ro /dev/sdb /mnt/recovery

# Replace failed device after mounting degraded
btrfs device add -f /dev/sdd /mnt/recovery
btrfs device delete missing /mnt/recovery

# Monitor reconstruction balance progress
btrfs balance status /mnt/recovery

# For RAID1 with both devices present but one corrupted:
# The scrub automatically repairs from the good copy
btrfs scrub start -B /mnt/data
btrfs scrub status /mnt/data
```

### Restoring from Snapshot

```bash
# Boot from live media or alternate system

# Mount Btrfs root
mount -o subvolid=5 /dev/sdb /mnt/btrfs-root

# The current (broken) root subvolume
# ID 256 path @

# A known-good snapshot
# ID 312 path @snapshots/root-20301102-000000

# Rename the broken subvolume
btrfs subvolume snapshot /mnt/btrfs-root/@ /mnt/btrfs-root/@broken-$(date +%Y%m%d)

# Delete the broken subvolume
btrfs subvolume delete /mnt/btrfs-root/@

# Create a new writable snapshot from the known-good snapshot
btrfs subvolume snapshot \
  /mnt/btrfs-root/@snapshots/root-20301102-000000 \
  /mnt/btrfs-root/@

# Reboot into the restored system
# No fsck needed — Btrfs self-consistency is maintained by CoW
```

## Summary

Btrfs provides a comprehensive storage feature set for production Linux environments. The key operational areas covered in this guide are:

- **Subvolume design**: Flat subvolume layout with dedicated snapshot directories simplifies backup automation and rollback operations
- **RAID profiles**: RAID1 and RAID10 for production redundancy; RAID5/6 should be avoided due to unresolved reliability issues
- **Snapshot automation**: Systemd timers with hourly/daily/weekly retention tiers via bash scripts
- **Scrub and balance**: Monthly scrubs for data integrity, and periodic low-threshold balance to reclaim fragmented allocation
- **Send/receive pipelines**: Incremental backup streams with optional compression for efficient local and remote replication
- **Quotas**: Subvolume-level and hierarchical quota enforcement for multi-tenant storage
- **Maintenance workflows**: Health check scripting covering device errors, space utilization, and scrub status monitoring
