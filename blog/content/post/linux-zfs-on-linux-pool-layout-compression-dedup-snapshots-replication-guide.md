---
title: "Linux ZFS on Linux: Pool Layout, Compression, Deduplication Trade-offs, Snapshots, and Send/Receive Replication"
date: 2031-11-23T00:00:00-05:00
draft: false
tags: ["Linux", "ZFS", "Storage", "ZFS on Linux", "OpenZFS", "Snapshots", "Replication", "Data Management"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to ZFS on Linux (OpenZFS): designing pool layouts for performance and redundancy, configuring compression and evaluating deduplication trade-offs, managing snapshots efficiently, and implementing zfs send/receive for cross-host replication and backup pipelines."
more_link: "yes"
url: "/linux-zfs-on-linux-pool-layout-compression-dedup-snapshots-replication-guide/"
---

ZFS is not just a filesystem — it is a complete storage platform that combines volume management, RAID, data integrity verification, compression, snapshots, and replication into a single coherent system. While Linux ext4 and XFS are excellent for most workloads, ZFS becomes the correct choice when you need: atomic snapshots for backups without downtime, end-to-end checksumming to detect silent corruption, efficient send/receive replication between hosts, or inline compression to maximize storage density.

This guide covers OpenZFS on Linux production deployment: pool design decisions, compression configuration, the honest cost of deduplication, efficient snapshot management, and building robust replication pipelines with `zfs send/receive`.

<!--more-->

# Linux ZFS on Linux: Production Storage Guide

## Installation

```bash
# Ubuntu/Debian (ZFS is in the kernel for Ubuntu 20.04+)
apt-get install zfsutils-linux

# RHEL/Rocky/AlmaLinux
dnf install epel-release
dnf install zfs

# Load module
modprobe zfs

# Verify
zfs version
# zfs-2.2.x-...
# zfs-kmod-2.2.x-...

# Enable auto-mounting on boot
systemctl enable zfs-mount zfs-import-cache zfs-share
```

## Pool Design

### VDEV Types and When to Use Each

A pool is composed of one or more VDEVs (Virtual Devices):

| VDEV Type | Redundancy | Write Performance | Read Performance | Usage |
|---|---|---|---|---|
| stripe | None | Best | Best | Scratch data, ephemeral |
| mirror | N-1 disks | Good | Excellent (parallel reads) | OS, databases, low-disk-count |
| raidz1 | 1 disk | Moderate | Good | General purpose, 4-6 disks |
| raidz2 | 2 disks | Moderate | Good | Production data, 6-8 disks |
| raidz3 | 3 disks | Lower | Good | Archive, critical data, 8+ disks |
| dRAID | 1-3 disks | Moderate | Good | Large pools (20+ disks) |

**RAIDZ vs Mirror Decision Rule**:
- < 6 disks: Use mirrors (better performance, simpler)
- 6-12 disks: RAIDZ2 is usually optimal
- 12+ disks: Multiple RAIDZ2 VDEVs or dRAID

### Mirror Pool (Recommended for Most Deployments)

```bash
# Create a mirror pool with 2 NVMe drives
# zpool create options:
# -o ashift=12  : 4K sector size (required for modern SSDs/NVMe)
# -O compression=lz4 : Enable compression on all datasets
# -O atime=off  : Disable access time updates (performance)
# -O xattr=sa   : Store extended attributes in inodes (performance)
# -m /data      : Mount point
zpool create \
  -o ashift=12 \
  -O compression=lz4 \
  -O atime=off \
  -O xattr=sa \
  -O dnodesize=auto \
  -O normalization=formD \
  data mirror \
  /dev/disk/by-id/nvme-Samsung_SSD_980_PRO_1TB_XXXXXXX1 \
  /dev/disk/by-id/nvme-Samsung_SSD_980_PRO_1TB_XXXXXXX2

# Always use disk-by-id paths, never /dev/sdX (which can change)
```

### RAIDZ2 Pool with Hot Spares

```bash
# 8-disk RAIDZ2 with 1 hot spare
zpool create \
  -o ashift=12 \
  -o autoreplace=on \
  -O compression=lz4 \
  -O atime=off \
  -O xattr=sa \
  -m /storage \
  tank raidz2 \
  /dev/disk/by-id/wwn-0x5000c5002d3f1234 \
  /dev/disk/by-id/wwn-0x5000c5002d3f1235 \
  /dev/disk/by-id/wwn-0x5000c5002d3f1236 \
  /dev/disk/by-id/wwn-0x5000c5002d3f1237 \
  /dev/disk/by-id/wwn-0x5000c5002d3f1238 \
  /dev/disk/by-id/wwn-0x5000c5002d3f1239 \
  /dev/disk/by-id/wwn-0x5000c5002d3f123a \
  /dev/disk/by-id/wwn-0x5000c5002d3f123b \
  spare /dev/disk/by-id/wwn-0x5000c5002d3f123c

# Verify pool creation
zpool status tank
```

### Adding a Cache (L2ARC) and Log (ZIL/SLOG)

```bash
# Add NVMe for ZIL/SLOG (synchronous write acceleration)
# Use a mirror for redundancy — losing SLOG causes last ~5s of writes to be lost
zpool add tank log mirror \
  /dev/disk/by-id/nvme-Samsung_MZ1L21T9HALS_SLOG1 \
  /dev/disk/by-id/nvme-Samsung_MZ1L21T9HALS_SLOG2

# Add NVMe for L2ARC (read cache)
# L2ARC is not redundant — losing it means cache misses, not data loss
zpool add tank cache \
  /dev/disk/by-id/nvme-Samsung_MZ1L21T9HALS_CACHE1

zpool status tank
# Should show: logs, cache sections
```

### ashift: Critical Setting That Cannot Be Changed

`ashift` specifies the sector size as a power of 2: `ashift=12` = 2^12 = 4096 bytes.

```bash
# Check physical sector size of a disk
blockdev --getpbsz /dev/sda
# 4096

# Get ashift from pool
zpool get ashift tank
# tank  ashift  12  default

# WARNING: If you create a pool with ashift=9 (512 bytes) on a 4K native disk,
# every write is 8x less efficient due to read-modify-write operations.
# You CANNOT change ashift after pool creation without destroying the pool.
```

## Dataset Hierarchy

Organize data into datasets for independent management of properties:

```bash
# Create dataset hierarchy
zfs create tank/data
zfs create tank/data/databases
zfs create tank/data/databases/postgres
zfs create tank/data/databases/mysql
zfs create tank/data/backups
zfs create tank/data/logs

# Each dataset inherits parent properties but can override them
# Override compression for logs (highly compressible)
zfs set compression=zstd-3 tank/data/logs

# Disable compression for databases (already compressed by PostgreSQL/MySQL)
zfs set compression=off tank/data/databases/postgres
zfs set compression=off tank/data/databases/mysql

# Set quotas
zfs set quota=1T tank/data/databases
zfs set refquota=500G tank/data/databases/postgres

# Set reservations (guaranteed space)
zfs set reservation=100G tank/data/databases/postgres

# List datasets
zfs list -r tank
```

## Compression

ZFS compression works at the ARC (adaptive replacement cache) level — compressed data is cached, not raw data. This means compression often improves performance by increasing effective cache size.

### Compression Algorithm Selection

```bash
# LZ4 (default recommendation):
# - Fastest compression/decompression
# - ~1.5-2.5x compression ratio for typical data
# - Negligible CPU overhead
zfs set compression=lz4 tank/data

# ZSTD-3 (good balance for archival/logs):
# - Better compression ratio than LZ4 (2-4x typical)
# - Moderate CPU cost
# - ZSTD-1 through ZSTD-19 available (higher = more compression, more CPU)
zfs set compression=zstd-3 tank/data/logs

# ZSTD-9 (for archival data):
# - Very good compression (3-6x for text/JSON)
# - Higher CPU cost on write
# - Reads decompress fast regardless of level
zfs set compression=zstd-9 tank/data/backups

# OFF (for pre-compressed data):
# - Video files, JPEG/PNG images, already-compressed databases (pg with pgzip)
# - Compression adds CPU overhead with no benefit
zfs set compression=off tank/data/media

# Verify compression ratio
zfs get compressratio tank/data
# tank/data  compressratio  2.41x  -
```

### Checking Compression Effectiveness

```bash
# Per-dataset compression stats
zfs list -o name,used,compressratio,logicalused tank -r

# Per-dataset compression savings
zfs get all tank/data/logs | grep -E 'compress|logicalused|used'
# logicalused: size without compression
# used: actual space consumed
# savings = logicalused - used
```

## Deduplication: The Honest Assessment

ZFS deduplication is one of the most misunderstood features. In most cases, **it should NOT be enabled** in production.

### How ZFS Deduplication Works

ZFS dedup maintains a Deduplication Table (DDT) in memory. For every block written, it computes a hash (SHA-256 by default) and looks it up in the DDT. If the block already exists, it creates a reference instead of writing a new copy.

### The Memory Cost

The DDT requires approximately 320 bytes of RAM per unique block. For a 128KB default record size:
- 1TB of unique data = ~8M blocks = ~2.5GB of DDT RAM
- 10TB of unique data = ~80M blocks = ~25GB of DDT RAM

If the DDT does not fit in RAM, it spills to disk, causing catastrophic performance degradation.

```bash
# Check current DDT size and memory usage
zpool status -D tank

# Calculate if dedup is feasible
# Rule of thumb: you need 1GB RAM per 1TB of stored data minimum
# Recommended: 5GB RAM per 1TB for comfortable headroom

zdb -D tank
# dedup: DDT entries N, size M on disk, M in core
```

### When Deduplication Is Worth It

Deduplication is worth considering when:
1. You can quantify the expected dedup ratio is > 2x before enabling
2. You have sufficient RAM for the DDT to stay in memory
3. The data is truly duplicate (VM images, backup system with many identical backups)

```bash
# Test dedup ratio WITHOUT enabling it (dry run)
# This shows what ratio you would get if you enabled dedup
zdb -S tank
# Estimated dedup ratio: 1.04x (probably not worth it)
```

### Alternatives to Deduplication

- **ZSTD-9 compression**: Gets 3-6x space savings on compressible data with zero memory overhead
- **Snapshot-based dedup**: `zfs send` with `-Di` for incremental replication (automatic dedup between snapshots)
- **Application-level dedup**: Borg Backup, Restic, BorgBase use content-addressed storage

## Snapshot Management

Snapshots are instant (they are just ZFS metadata), zero-copy until data diverges, and can be created/destroyed without downtime.

### Basic Snapshot Operations

```bash
# Create a snapshot
zfs snapshot tank/data/databases/postgres@2031-11-23

# List snapshots
zfs list -t snapshot -r tank/data/databases/postgres
# NAME                                              USED  AVAIL     REFER  MOUNTPOINT
# tank/data/databases/postgres@2031-11-23         1.2G      -     450G  -

# Access snapshot data (read-only)
ls /tank/data/databases/postgres/.zfs/snapshot/2031-11-23/

# Rollback to snapshot (DESTRUCTIVE: discards all writes since snapshot)
zfs rollback tank/data/databases/postgres@2031-11-23

# Clone snapshot to writable dataset
zfs clone tank/data/databases/postgres@2031-11-23 \
  tank/data/databases/postgres-clone

# Promote clone (makes clone the primary, original becomes dependent)
zfs promote tank/data/databases/postgres-clone

# Destroy snapshot
zfs destroy tank/data/databases/postgres@2031-11-23
```

### Automated Snapshot Rotation with Sanoid

```bash
apt-get install sanoid

# /etc/sanoid/sanoid.conf
```

```ini
# /etc/sanoid/sanoid.conf

[tank/data/databases]
  use_template = production
  recursive = yes

[tank/data/logs]
  use_template = logs
  recursive = yes

[tank/data/backups]
  use_template = archive
  recursive = yes

[template_production]
  frequently = 0
  hourly = 24       # Keep 24 hourly snapshots
  daily = 30        # Keep 30 daily snapshots
  monthly = 12      # Keep 12 monthly snapshots
  yearly = 2        # Keep 2 yearly snapshots
  autosnap = yes
  autoprune = yes

[template_logs]
  frequently = 4    # Every 15 minutes
  hourly = 48
  daily = 14
  monthly = 3
  yearly = 0
  autosnap = yes
  autoprune = yes

[template_archive]
  hourly = 0
  daily = 90
  monthly = 24
  yearly = 5
  autosnap = yes
  autoprune = yes
```

```bash
# Enable sanoid timer
systemctl enable sanoid.timer
systemctl start sanoid.timer

# Manual run
sanoid --cron --verbose

# List managed snapshots
sanoid --list
```

### Consistent Application Snapshots

For database consistency, pause writes before snapshotting:

```bash
#!/bin/bash
# consistent-snapshot.sh

DATASET="tank/data/databases/postgres"
SNAPSHOT_NAME="${DATASET}@$(date +%Y-%m-%dT%H%M%S)"
PG_HOST="localhost"
PG_USER="postgres"

# 1. Start backup mode (pauses WAL rotation, marks consistent point)
psql -h "$PG_HOST" -U "$PG_USER" -c "SELECT pg_start_backup('zfs-snapshot', fast := true);"

# 2. Create ZFS snapshot (instant, zero downtime)
zfs snapshot "$SNAPSHOT_NAME"

# 3. End backup mode
psql -h "$PG_HOST" -U "$PG_USER" -c "SELECT pg_stop_backup();"

echo "Snapshot created: $SNAPSHOT_NAME"
```

## ZFS Send/Receive Replication

`zfs send` serializes the difference between two snapshots into a byte stream. `zfs receive` deserializes it on the destination. This is the foundation for ZFS replication and backup.

### Initial Replication (Full Send)

```bash
# Send full snapshot to remote host
# -v: verbose progress
# -R: replicate recursively (all child datasets)
# -p: preserve properties
zfs send -vR tank/data@2031-11-23 | \
  ssh backup-host zfs receive -vF backup/data

# With compression (reduces network bandwidth)
zfs send -R tank/data@2031-11-23 | \
  pigz -c | \
  ssh backup-host "pigz -dc | zfs receive -vF backup/data"

# With mbuffer for network reliability (buffers against socket stalls)
zfs send -R tank/data@2031-11-23 | \
  mbuffer -s 128k -m 1G | \
  ssh backup-host "mbuffer -s 128k -m 1G | zfs receive -vF backup/data"
```

### Incremental Replication

```bash
# After initial send, replicate only changes
# -i: send incremental from previous snapshot
# Create new snapshot
zfs snapshot tank/data@2031-11-24

# Send incremental (only data changed between 2031-11-23 and 2031-11-24)
zfs send -vi tank/data@2031-11-23 tank/data@2031-11-24 | \
  ssh backup-host zfs receive -vF backup/data

# -I: send all intermediate snapshots (includes @2031-11-23-T12 etc.)
# Useful if you missed an incremental and have multiple new snapshots
zfs send -vRI tank/data@2031-11-23 tank/data@2031-11-24 | \
  ssh backup-host zfs receive -vF backup/data
```

### Resumable Sends (for Large Datasets)

```bash
# Enable resumable transfers (handles network interruptions)
# -s: generate resume token on failure

# Start transfer (will fail halfway for demonstration)
zfs send -vRs tank/data@2031-11-23 | \
  ssh backup-host zfs receive -vs backup/data

# If interrupted, get resume token from destination
RESUME_TOKEN=$(ssh backup-host zfs get receive_resume_token backup/data -Ho value)

# Resume from where we left off
zfs send -t "$RESUME_TOKEN" | \
  ssh backup-host zfs receive -vs backup/data
```

### Automated Replication with Syncoid

```bash
# /etc/cron.d/syncoid-replication
```

```bash
# Run every hour
0 * * * * root /usr/sbin/syncoid \
  --no-privilege-elevation \
  --compress=pigz \
  --mbuffer-size=1G \
  --recursive \
  tank/data/databases \
  backup-host:backup/databases

# Run every 6 hours for logs
0 */6 * * * root /usr/sbin/syncoid \
  --no-privilege-elevation \
  --compress=zstd \
  --recursive \
  tank/data/logs \
  offsite-host:archive/logs
```

### Encrypted Replication

```bash
# Create encrypted dataset
zfs create \
  -o encryption=on \
  -o keyformat=passphrase \
  -o keylocation=prompt \
  tank/secure-data

# Load key
zfs load-key tank/secure-data

# Replicate encrypted raw (preserves encryption, no decryption in transit)
# -w: send raw (encrypted) data — destination does not need the key
zfs send -vRw tank/secure-data@2031-11-23 | \
  ssh backup-host zfs receive -vF backup/secure-data

# On destination: cannot access without the key
# This means your backup host never sees plaintext data
```

## Monitoring and Maintenance

### Pool Health Monitoring

```bash
# Overall pool status
zpool status -v

# Scrub: verify all data against checksums
zpool scrub tank

# Show scrub progress
zpool status tank | grep scan

# Schedule weekly scrubs
echo "0 2 * * 0 root /sbin/zpool scrub tank" > /etc/cron.d/zfs-scrub

# Check for errors
zpool status tank | grep -E "DEGRADED|FAULTED|REMOVED|errors"
```

### Prometheus Monitoring with zfs-exporter

```bash
# Install zfs-exporter
docker run -d \
  --name zfs-exporter \
  --privileged \
  -p 9134:9134 \
  -v /proc:/proc \
  prom/node-exporter \
  --collector.zfs

# Or use dedicated zfs-exporter
go install github.com/pdf/zfs-exporter@latest
```

```yaml
# Prometheus alerts for ZFS
groups:
- name: zfs
  rules:
  - alert: ZFSPoolDegraded
    expr: node_zfs_zpool_state{state!="online"} > 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "ZFS pool {{ $labels.pool }} is degraded"

  - alert: ZFSHighDatasetUsage
    expr: |
      (node_zfs_dataset_used_bytes / node_zfs_dataset_avail_bytes) > 0.85
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "ZFS dataset {{ $labels.dataset }} is over 85% full"

  - alert: ZFSChecksumErrors
    expr: rate(node_zfs_vdev_checksum_errors[1h]) > 0
    for: 0m
    labels:
      severity: warning
    annotations:
      summary: "ZFS checksum errors detected on pool {{ $labels.pool }}"
      description: "This may indicate hardware failure or bit rot"
```

### Pool Tuning

```bash
# Tune ARC (Adaptive Replacement Cache) size
# Default: up to 1/2 of RAM
# For dedicated storage servers, allow up to 75% of RAM
echo $(($(grep MemTotal /proc/meminfo | awk '{print $2}') * 1024 * 3 / 4)) > \
  /sys/module/zfs/parameters/zfs_arc_max

# Make ARC tuning persistent
echo "options zfs zfs_arc_max=$(($(grep MemTotal /proc/meminfo | awk '{print $2}') * 1024 * 3 / 4))" \
  > /etc/modprobe.d/zfs.conf

# Prefetch (disable for random I/O workloads like databases)
echo 1 > /sys/module/zfs/parameters/zfs_prefetch_disable

# Record size: set per-dataset based on workload
# Databases: 8K-16K (matches database page size)
zfs set recordsize=8K tank/data/databases/postgres
# Large files: 1MB (maximum throughput)
zfs set recordsize=1M tank/data/media
# Default (128K) is fine for most workloads

# Show current pool properties
zpool get all tank | grep -E "ashift|autoreplace|autoexpand|feature"
```

## Summary

ZFS on Linux provides storage capabilities that are genuinely difficult to replicate with other solutions: atomic point-in-time snapshots that take milliseconds regardless of dataset size, end-to-end checksumming that detects and corrects silent corruption, and efficient incremental replication via `zfs send/receive` that forms the backbone of many production backup systems. Compression with LZ4 or ZSTD should be enabled by default — it almost always improves both performance (more effective cache) and capacity. Deduplication, by contrast, should be avoided unless you can verify the DDT fits in RAM and the actual dedup ratio justifies the cost. With Sanoid for automated snapshot management and Syncoid for replication, the operational overhead is manageable even at scale.
