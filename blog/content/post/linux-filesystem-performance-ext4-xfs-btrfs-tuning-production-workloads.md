---
title: "Linux Filesystem Performance: ext4, XFS, and Btrfs Tuning for Production Workloads"
date: 2030-07-31T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "ext4", "XFS", "Btrfs", "Performance", "Storage", "Kubernetes"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Filesystem performance guide covering ext4 mount options and tuning, XFS log configuration, Btrfs compression and CoW overhead, fio benchmarking methodology, and choosing filesystems for different Kubernetes storage workloads."
more_link: "yes"
url: "/linux-filesystem-performance-ext4-xfs-btrfs-tuning-production-workloads/"
---

Filesystem selection and tuning is one of the most consequential storage decisions for production systems. ext4, XFS, and Btrfs each make different tradeoffs between sequential throughput, random I/O performance, metadata operations, data integrity, and operational complexity. Understanding how these filesystems work internally — journal modes, extent allocation, copy-on-write semantics — and how to benchmark and tune them for specific workloads is essential for operators managing database storage, container image layers, and persistent volume backends in Kubernetes environments.

<!--more-->

## Filesystem Selection Framework

Before benchmarking or tuning, the workload profile must be understood:

| Workload Type | Primary Requirement | Recommended FS |
|---------------|--------------------|--------------------|
| Relational databases (PostgreSQL, MySQL) | Random I/O, data integrity | XFS or ext4 |
| Logging and append-only writes | Sequential write throughput | XFS |
| Container image storage (overlayfs) | Metadata performance | ext4 or XFS |
| Object storage (Ceph OSD) | Large sequential I/O | XFS |
| Development environments | Snapshotting, compression | Btrfs |
| NVMe SSD workloads | High IOPS, low latency | XFS |
| HDD-backed storage | Sequential throughput | ext4 with delayed allocation |

## ext4 Filesystem Tuning

ext4 is the most widely deployed Linux filesystem. Its behavior is significantly influenced by mount options and creation parameters.

### ext4 Creation Options

```bash
# High-performance ext4 for database storage (SSD-optimized)
mkfs.ext4 \
    -m 0 \               # No reserved blocks (default 5% is wasteful for large volumes)
    -E stride=8,stripe-width=8 \  # RAID alignment: stride=chunk_size/block_size
    -b 4096 \            # Block size (matches page size for optimal mmap)
    -i 8192 \            # Bytes per inode (reduce for many-small-file workloads)
    -J size=1024 \       # 1GB journal for high-write environments
    -L data-vol \        # Label for reliable device identification
    /dev/nvme1n1p1

# For many-small-files workload (log storage, package repos)
mkfs.ext4 \
    -m 1 \
    -i 4096 \            # More inodes (1 inode per 4KB)
    -b 1024 \            # Smaller blocks reduce fragmentation
    -J size=512 \
    /dev/sdb1

# Verify settings
tune2fs -l /dev/nvme1n1p1 | grep -E "Block size|Inode count|Journal size|Reserved block"
```

### ext4 Mount Options

```bash
# /etc/fstab entry for a database volume
/dev/nvme1n1p1  /data/postgres  ext4  defaults,noatime,nodiratime,barrier=1,data=ordered,discard  0 2

# For highest write performance (reduced durability)
/dev/nvme1n1p1  /data/cache  ext4  defaults,noatime,nodiratime,barrier=0,data=writeback  0 2

# For NVMe with large workloads
/dev/nvme1n1p1  /data  ext4  defaults,noatime,nodiratime,barrier=1,data=ordered,lazytime,discard,dax  0 2
```

Key mount options explained:

| Option | Effect | Use Case |
|--------|--------|----------|
| `noatime` | Skip access time updates | Almost all production systems |
| `nodiratime` | Skip directory access time | Implied by `noatime` |
| `barrier=0` | Skip write barriers | Cache-backed storage only |
| `data=writeback` | No journal for data blocks | Max write throughput, less safe |
| `data=ordered` | Default: metadata journaled, data written before commit | Production default |
| `data=journal` | Both data and metadata journaled | Maximum safety, ~50% write penalty |
| `lazytime` | Delay timestamp updates | Low-latency workloads |
| `discard` | TRIM on SSD delete | NVMe/SSD (prefer fstrim cron instead) |
| `dax` | Direct Access for persistent memory | Optane/PMEM only |

### ext4 Tunable Parameters

```bash
# View current ext4 configuration for a mounted filesystem
cat /sys/fs/ext4/nvme1n1p1/max_writeback_mb_per_sec
cat /sys/fs/ext4/nvme1n1p1/delayed_allocation_blocks

# Tune maximum writeback rate (MB/s)
# 0 = unlimited; set to prevent writeback storms
echo 512 > /sys/fs/ext4/nvme1n1p1/max_writeback_mb_per_sec

# Check and tune journal commit interval (seconds)
# Default 5s; reduce for lower data loss window
tune2fs -E commit=2 /dev/nvme1n1p1

# View inode/block usage
df -i /data
dumpe2fs -h /dev/nvme1n1p1 | grep -E "Free blocks|Free inodes|Inode size"

# Tune reserved blocks percentage
tune2fs -m 1 /dev/nvme1n1p1  # Reduce from 5% to 1% on large volumes
```

### ext4 Journal Modes Deep Dive

```bash
# Check current journal mode
tune2fs -l /dev/sdb1 | grep "Default mount options"

# data=ordered (default): ext4's most common mode
# Metadata is journaled; data written to disk before metadata commit
# Prevents metadata-data inconsistency after crash
# ~10-20% write overhead vs writeback mode

# data=journal: full journaling
# Both data and metadata go through the journal
# Maximum crash safety
# ~50% write penalty on writes
# Best for: financial systems, databases with no fsync (let FS handle durability)

# data=writeback: fastest, least safe
# Only metadata journaled; data may appear in files before metadata
# Use only with battery-backed write cache or volatile cache workloads
```

## XFS Filesystem Tuning

XFS was designed from the ground up for large-scale, high-throughput workloads. It is the default filesystem for RHEL 7+ and is preferred for most enterprise database and sequential write workloads.

### XFS Creation Options

```bash
# High-performance XFS for a database on NVMe
mkfs.xfs \
    -f \
    -d su=4m,sw=1 \      # Stripe unit=4MB, stripe width=1 (for single disk)
    -l su=4m,size=2048m \ # Log stripe unit=4MB, log size=2GB
    -b size=4096 \        # Block size
    -i size=512 \         # Inode size (512 bytes for large directory metadata)
    -L pgdata \
    /dev/nvme1n1p1

# For RAID array (10 disks in RAID-6, 512KB stripe):
# chunk_size=512KB, data_disks=8 (10 - 2 parity)
mkfs.xfs \
    -d su=512k,sw=8 \
    -l su=512k,size=1024m \
    /dev/md0

# Verify XFS parameters
xfs_info /dev/nvme1n1p1
```

### XFS Mount Options

```bash
# /etc/fstab for XFS database volume
/dev/nvme1n1p1  /data/postgres  xfs  defaults,noatime,nodiratime,allocsize=512m,logbufs=8,logbsize=256k  0 2

# For highest throughput sequential writes
/dev/nvme1n1p1  /data/logs  xfs  defaults,noatime,nodiratime,nobarrier,allocsize=256m  0 2
```

Key XFS-specific mount options:

| Option | Effect |
|--------|--------|
| `allocsize=N` | Speculative preallocation for appending files (reduces fragmentation) |
| `logbufs=N` | Log buffer count (4-8 for high-write workloads) |
| `logbsize=N` | Log buffer size (64k-256k) |
| `nobarrier` | Skip write barriers (only with battery-backed write cache) |
| `wsync` | Writes only return after data+metadata synced (safe but slow) |
| `inode64` | Allocate inodes anywhere in volume (default on large volumes) |
| `largeio` | Use large I/O requests |

### XFS Log (Journal) Tuning

XFS logs (journals) are a common performance bottleneck for write-intensive workloads:

```bash
# Check current log configuration
xfs_info /data | grep -E "log|bsize"

# Ideal log configuration:
# - Log size: 512MB to 2GB (larger = longer recovery time but fewer flushes)
# - Log on separate device: reduces write contention
# - Log stripe unit: match storage stripe size

# Create XFS with external log on a separate fast device
mkfs.xfs \
    -l logdev=/dev/nvme0n1p1,size=1024m,su=4096 \
    -d file=1 \
    /dev/nvme1n1p1

# Mount with external log
mount -o logdev=/dev/nvme0n1p1 /dev/nvme1n1p1 /data

# Monitor XFS log activity
xfs_db -r /dev/nvme1n1p1 -c "logprint -c" 2>/dev/null | head -20

# View XFS statistics
cat /proc/fs/xfs/stat
# Key fields:
# xs_log_writes: log write operations (high = write-intensive)
# xs_log_blocks: log blocks written
# xs_xbtree_inserts: B-tree inserts (metadata changes)
```

### XFS Defragmentation and Space Reclamation

```bash
# Check filesystem fragmentation
xfs_db -r /dev/nvme1n1p1 -c "frag -d" 2>/dev/null

# Online defragmentation
xfs_fsr /data

# Run TRIM on XFS
fstrim -v /data

# Show space allocation
xfs_bmap -v /data/myfile  # View extent map for a file
xfs_quota -x -c "df" /data  # Show quota/space info
```

## Btrfs Filesystem

Btrfs offers features not available in ext4 or XFS: copy-on-write (CoW), snapshots, subvolumes, inline compression, and RAID management. These features come with performance tradeoffs that must be understood.

### Btrfs Creation and Subvolume Layout

```bash
# Create Btrfs filesystem
mkfs.btrfs \
    -f \
    -L btrfs-data \
    -m single \          # Metadata: single (for single disk)
    -d single \          # Data: single
    /dev/nvme1n1p1

# Mount and create subvolumes
mount /dev/nvme1n1p1 /mnt/btrfs

# Create subvolumes for isolation (separate snapshot domains)
btrfs subvolume create /mnt/btrfs/@         # Root subvolume
btrfs subvolume create /mnt/btrfs/@home     # User data
btrfs subvolume create /mnt/btrfs/@var      # Variable data
btrfs subvolume create /mnt/btrfs/@snapshots

# Mount subvolumes
umount /mnt/btrfs
mount -o subvol=@,compress=zstd:3,noatime /dev/nvme1n1p1 /
mount -o subvol=@home,compress=zstd:3,noatime /dev/nvme1n1p1 /home
mount -o subvol=@var,noatime,nodatacow /dev/nvme1n1p1 /var
```

### Btrfs Compression Tuning

```bash
# Enable compression at mount time
mount -o compress=zstd:3 /dev/nvme1n1p1 /data  # zstd level 3 (balanced)
mount -o compress=lzo /dev/nvme1n1p1 /data       # LZO (fastest, less compression)
mount -o compress=zlib:6 /dev/nvme1n1p1 /data    # zlib (best compression, slowest)
mount -o compress-force=zstd:1 /dev/nvme1n1p1 /data  # Force compression on all files

# Compress existing files
btrfs filesystem defragment -r -czstd /data/

# Check compression ratio
compsize /data/
# Output:
# Processed 15234 files, 8012 regular extents (8012 refs), 0 inline.
# Type       Perc     Disk Usage   Uncompressed Referenced
# TOTAL       58%      3.72GiB      6.41GiB      6.41GiB
# none       100%      1.64GiB      1.64GiB      1.64GiB
# zstd        32%      2.08GiB      6.41GiB      6.41GiB
```

### Btrfs Copy-on-Write Overhead

CoW is Btrfs's defining feature but creates significant overhead for certain workloads:

```bash
# Databases should ALWAYS disable CoW
# CoW causes write amplification: every write creates new extents
# This is catastrophic for databases with random small writes

# Check if CoW is disabled
lsattr /var/lib/postgresql/data | grep -E "^....C"
# 'C' flag = no CoW

# Disable CoW for a directory (must be empty or newly created)
chattr +C /var/lib/postgresql/data
chattr +C /var/lib/mysql

# Disable CoW via mount option for a subvolume
mount -o nodatacow /dev/nvme1n1p1 /var/lib/postgresql

# View chattr flags on a file
lsattr /var/lib/postgresql/data/PG_VERSION

# WARNING: CoW + snapshots = good for backups
# CoW + databases = write amplification disaster
# Use subvolumes: CoW disabled for DB, CoW enabled for snapshot subvolume
```

### Btrfs Snapshots for Backup

```bash
# Create a read-only snapshot (for backup)
btrfs subvolume snapshot -r /data/@ /mnt/btrfs/@snapshots/$(date +%Y%m%d-%H%M%S)

# List snapshots
btrfs subvolume list /mnt/btrfs | grep snapshots

# Send snapshot to another host (incremental backup)
btrfs send /mnt/btrfs/@snapshots/20301201-0000 | \
    btrfs receive /backup/snapshots/

# Incremental send (only changes since last snapshot)
btrfs send -p /mnt/btrfs/@snapshots/20301130-0000 \
    /mnt/btrfs/@snapshots/20301201-0000 | \
    btrfs receive /backup/snapshots/

# Delete old snapshots
btrfs subvolume delete /mnt/btrfs/@snapshots/20301101-0000
```

### Btrfs RAID Performance

```bash
# Create Btrfs RAID1 (mirroring)
mkfs.btrfs -f -m raid1 -d raid1 /dev/sdb /dev/sdc

# Create Btrfs RAID10
mkfs.btrfs -f -m raid10 -d raid10 /dev/sdb /dev/sdc /dev/sdd /dev/sde

# View RAID status
btrfs device stats /data
btrfs filesystem show /data

# Scrub (verify data integrity)
btrfs scrub start /data
btrfs scrub status /data
```

## Benchmarking with fio

`fio` (Flexible I/O Tester) is the standard tool for filesystem and storage benchmarking:

### fio Benchmark Suite

```ini
# /etc/fio/baseline.fio
# Run: fio /etc/fio/baseline.fio --output-format=json --output=results.json

[global]
ioengine=libaio
direct=1
buffered=0
time_based=1
runtime=60s
norandommap=1
group_reporting=1
directory=/mnt/test

[seq-read-throughput]
rw=read
bs=1M
iodepth=32
numjobs=4
stonewall

[seq-write-throughput]
rw=write
bs=1M
iodepth=32
numjobs=4
stonewall

[rand-read-4k-iops]
rw=randread
bs=4k
iodepth=64
numjobs=8
stonewall

[rand-write-4k-iops]
rw=randwrite
bs=4k
iodepth=64
numjobs=8
stonewall

[rand-readwrite-70-30]
rw=randrw
rwmixread=70
bs=4k
iodepth=32
numjobs=8
stonewall

[latency-test]
rw=randread
bs=4k
iodepth=1
numjobs=1
runtime=30s
stonewall
```

Running and analyzing benchmarks:

```bash
# Run benchmark
fio /etc/fio/baseline.fio \
    --output-format=json \
    --output=/tmp/fio-results-$(hostname)-$(date +%Y%m%d).json

# Parse results with jq
jq '.jobs[] | {
    name: .jobname,
    read_iops: .read.iops,
    write_iops: .write.iops,
    read_bw_mb: (.read.bw / 1024),
    write_bw_mb: (.write.bw / 1024),
    read_lat_us: .read.lat_ns.mean / 1000,
    write_lat_us: .write.lat_ns.mean / 1000,
    read_p99_us: .read.clat_ns.percentile["99.000000"] / 1000,
    write_p99_us: .write.clat_ns.percentile["99.000000"] / 1000
}' /tmp/fio-results-*.json

# Database-specific benchmark (PostgreSQL-like workload)
fio \
    --name=pg-random-write \
    --filename=/data/pg-benchmark.dat \
    --ioengine=libaio \
    --direct=1 \
    --size=10G \
    --bs=8k \
    --rw=randwrite \
    --iodepth=16 \
    --numjobs=4 \
    --time_based \
    --runtime=120s \
    --group_reporting \
    --lat_percentiles=1 \
    --percentile_list=50:90:95:99:99.9:99.99

# WAL-like sequential write benchmark
fio \
    --name=wal-write \
    --filename=/data/wal-benchmark.dat \
    --ioengine=libaio \
    --direct=1 \
    --size=2G \
    --bs=8k \
    --rw=write \
    --iodepth=4 \
    --numjobs=1 \
    --fdatasync=1 \
    --time_based \
    --runtime=60s
```

### Comparing Filesystems with fio

```bash
# Create test partitions on the same disk for fair comparison
# (Best done on identical hardware)

FILESYSTEMS=("ext4" "xfs" "btrfs")
MOUNT_POINTS=("/mnt/ext4" "/mnt/xfs" "/mnt/btrfs")
DEVICES=("/dev/sdb1" "/dev/sdb2" "/dev/sdb3")

# Format and mount
mkfs.ext4 -m 0 -E lazy_itable_init=0 ${DEVICES[0]}
mkfs.xfs -f ${DEVICES[1]}
mkfs.btrfs -f ${DEVICES[2]}

mount -o noatime,nodiratime ${DEVICES[0]} ${MOUNT_POINTS[0]}
mount -o noatime,nodiratime ${DEVICES[1]} ${MOUNT_POINTS[1]}
mount -o noatime,nodiratime,compress=lzo ${DEVICES[2]} ${MOUNT_POINTS[2]}

# Run identical fio jobs on each
for i in "${!FILESYSTEMS[@]}"; do
    echo "Testing ${FILESYSTEMS[$i]}..."
    fio \
        --name="4k-randwrite-${FILESYSTEMS[$i]}" \
        --directory="${MOUNT_POINTS[$i]}" \
        --ioengine=libaio \
        --direct=1 \
        --size=8G \
        --bs=4k \
        --rw=randwrite \
        --iodepth=32 \
        --numjobs=4 \
        --time_based \
        --runtime=60s \
        --group_reporting \
        --output="${FILESYSTEMS[$i]}-results.json" \
        --output-format=json
done
```

## Choosing Filesystems for Kubernetes Storage Workloads

### Kubernetes PersistentVolume Backing Filesystems

Different workloads in Kubernetes have distinct storage requirements:

```yaml
# StorageClass definitions for different workload profiles

# High-performance random I/O (databases) - XFS on NVMe
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "16000"
  throughput: "1000"
  fsType: xfs
  blockExpressEnabled: "true"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer

# Logging/analytics workload - XFS or ext4 optimized for sequential writes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: log-storage
provisioner: ebs.csi.aws.com
parameters:
  type: st1    # HDD throughput-optimized
  fsType: xfs
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer

# General purpose - ext4
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  fsType: ext4
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

### Container Runtime Storage Considerations

The container runtime's overlay filesystem performance depends heavily on the underlying filesystem:

```bash
# Check current containerd storage driver
containerd config dump | grep snapshotter

# For containerd with overlayfs on ext4
# ext4 with dir_index feature is required for overlayfs
tune2fs -l /dev/sda1 | grep "dir_index"

# XFS requires ftype=1 for overlayfs (default in modern kernels)
xfs_info / | grep ftype

# Create XFS with ftype=1 explicitly
mkfs.xfs -f -n ftype=1 /dev/sdb

# Verify overlayfs compatibility
cat /proc/filesystems | grep overlay
mount | grep overlay

# Benchmark container image pull performance
time crictl pull nginx:latest
time crictl images  # Measure metadata lookup
```

### Database Storage Optimization

```bash
# PostgreSQL-specific tuning for ext4
# Place tablespace directories on filesystem with appropriate options
mkdir -p /data/pg/tablespace
chown postgres:postgres /data/pg/tablespace

# If using Btrfs, disable CoW for PostgreSQL data
chattr +C /data/pg/tablespace
chattr +C /var/lib/postgresql

# XFS-specific for PostgreSQL
# Set block size and inode size appropriate for PostgreSQL 8k pages
mkfs.xfs -f \
    -b size=4096 \
    -i size=512 \
    -d agcount=32 \   # More allocation groups = better parallelism
    -l size=1024m \
    /dev/nvme1n1p1

# ext4 for MySQL/InnoDB
mkfs.ext4 \
    -m 0 \
    -b 4096 \
    -i 8192 \         # Fewer inodes OK - MySQL uses fewer files
    -J size=512 \
    /dev/nvme1n1p1

# Mount options for MySQL
# /etc/fstab:
/dev/nvme1n1p1  /var/lib/mysql  ext4  defaults,noatime,nodiratime,data=ordered,barrier=1  0 2
```

## Linux I/O Schedulers and Their Interaction with Filesystems

The I/O scheduler interacts with filesystem behavior, particularly for workloads that generate mixed I/O patterns:

```bash
# View available I/O schedulers
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber

# For NVMe SSDs: none (passthrough) is generally best
echo none > /sys/block/nvme0n1/queue/scheduler

# For HDDs: mq-deadline provides fair read latency
echo mq-deadline > /sys/block/sda/queue/scheduler

# Set read-ahead (in 512B sectors)
# For sequential workloads: increase
echo 2048 > /sys/block/sda/queue/read_ahead_kb

# For random I/O workloads: reduce
echo 128 > /sys/block/nvme0n1/queue/read_ahead_kb

# Queue depth
cat /sys/block/nvme0n1/queue/nr_requests
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# Make persistent via udev rule
cat > /etc/udev/rules.d/60-ioscheduler.rules <<'EOF'
# NVMe: no scheduler
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/read_ahead_kb}="128"
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/nr_requests}="1024"

# SSD (non-NVMe): mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/read_ahead_kb}="256"

# HDD
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/read_ahead_kb}="4096"
EOF

udevadm control --reload-rules && udevadm trigger
```

## Monitoring Filesystem Performance

### Key Metrics to Monitor

```bash
# Real-time I/O statistics per device
iostat -xdz 2

# Output fields:
# r/s, w/s: reads/writes per second
# rkB/s, wkB/s: read/write throughput (KB/s)
# await: average I/O wait time (ms)
# %util: device utilization (100% = saturated)
# aqu-sz: average queue size

# Filesystem-level statistics
# ext4 stats
cat /proc/fs/ext4/nvme1n1p1/mb_groups  # Block group statistics

# XFS stats
cat /proc/fs/xfs/stat
# xs_read_calls, xs_write_calls, xs_log_writes, xs_xbtree_inserts

# Btrfs stats
btrfs device stats /data

# Monitor with Prometheus node_exporter
# Key metrics:
# node_disk_read_bytes_total
# node_disk_written_bytes_total
# node_disk_io_time_seconds_total
# node_disk_read_time_seconds_total
# node_disk_write_time_seconds_total
```

### Prometheus Alerting for Filesystem Issues

```yaml
# prometheus-filesystem-rules.yaml
groups:
  - name: filesystem
    rules:
      - alert: FilesystemHighUtilization
        expr: |
          (node_filesystem_size_bytes - node_filesystem_avail_bytes) /
          node_filesystem_size_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Filesystem {{ $labels.mountpoint }} on {{ $labels.instance }} is {{ $value | humanizePercentage }} full"

      - alert: FilesystemAlmostFull
        expr: |
          (node_filesystem_size_bytes - node_filesystem_avail_bytes) /
          node_filesystem_size_bytes > 0.95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Filesystem {{ $labels.mountpoint }} on {{ $labels.instance }} critically full"

      - alert: DiskHighIOUtilization
        expr: |
          rate(node_disk_io_time_seconds_total[5m]) > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Disk {{ $labels.device }} on {{ $labels.instance }} is saturated ({{ $value | humanizePercentage }})"

      - alert: DiskHighReadLatency
        expr: |
          rate(node_disk_read_time_seconds_total[5m]) /
          rate(node_disk_reads_completed_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High read latency on {{ $labels.device }}: {{ $value * 1000 | humanize }}ms average"
```

## Summary

Filesystem selection and tuning is a multi-dimensional optimization problem. ext4 provides stability, broad compatibility, and solid performance for mixed workloads with straightforward tuning knobs. XFS excels at high-throughput workloads — particularly sequential writes and database I/O — with its log-based architecture providing scalable metadata performance. Btrfs delivers unique features (snapshots, compression, subvolumes) that justify its complexity for development environments and backup-capable storage, but requires careful CoW management for database workloads. For Kubernetes environments, matching StorageClass fsType to the actual workload profile — XFS for databases, ext4 for general containers, thoughtful Btrfs for snapshot-backed volumes — combined with appropriate I/O scheduler tuning and fio-validated benchmarks, provides the optimal balance of performance and reliability.
