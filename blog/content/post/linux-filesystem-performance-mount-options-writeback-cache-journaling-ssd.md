---
title: "Linux Filesystem Performance: Tuning Mount Options, Writeback Cache, and Journaling for SSDs"
date: 2031-09-14T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "Performance", "SSD", "ext4", "XFS", "NVMe", "Storage", "Tuning"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux filesystem performance tuning for SSDs, covering ext4 and XFS mount options, writeback caching, journaling modes, I/O scheduler configuration, and benchmarking methodology for production workloads."
more_link: "yes"
url: "/linux-filesystem-performance-mount-options-writeback-cache-journaling-ssd/"
---

SSDs fundamentally changed the performance characteristics of Linux filesystems. The optimizations that made sense for spinning disks — sequential I/O coalescing, elevator algorithms, read-ahead tuning — often work against you on NVMe SSDs with 1M+ IOPS and microsecond latencies. Default Linux filesystem configurations are conservative and leave significant performance on the table for workloads that can accept slightly weaker durability guarantees.

This guide covers the full spectrum of ext4 and XFS filesystem tuning: mount options, journaling configuration, writeback cache tuning, I/O scheduler selection, and the benchmarking methodology to measure what actually matters for your workload.

<!--more-->

# Linux Filesystem Performance Tuning for SSDs

## Understanding the Storage Stack

Before tuning, understand what is in the path between your application write and the physical SSD:

```
Application write()
       │
       ▼
[ Page Cache (VFS) ]         ← writeback caching layer
       │
       ▼
[ Filesystem (ext4/XFS) ]    ← journaling, allocation, metadata
       │
       ▼
[ Block Layer (block I/O) ]  ← I/O scheduler, merging
       │
       ▼
[ Device Driver (NVMe) ]     ← queue depth, power management
       │
       ▼
[ NVMe SSD ]                 ← NAND, controller cache, FTL
```

Each layer has tunable parameters. The most impactful are usually the top three.

## Measuring Baseline Performance

Always benchmark before and after tuning. Use `fio` for systematic benchmarking:

```bash
# Install fio
apt-get install fio

# Sequential write (large I/O, storage throughput)
fio --name=seqwrite \
    --rw=write \
    --bs=1M \
    --size=4G \
    --numjobs=1 \
    --runtime=60 \
    --time_based \
    --ioengine=libaio \
    --iodepth=32 \
    --direct=1 \
    --filename=/mnt/test/fio.dat

# Random 4K write (database-like, IOPS-bound)
fio --name=randwrite \
    --rw=randwrite \
    --bs=4K \
    --size=4G \
    --numjobs=4 \
    --runtime=60 \
    --time_based \
    --ioengine=libaio \
    --iodepth=64 \
    --direct=1 \
    --filename=/mnt/test/fio.dat

# Mixed random read/write (OLTP simulation)
fio --name=mixedrw \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4K \
    --size=4G \
    --numjobs=8 \
    --runtime=60 \
    --time_based \
    --ioengine=libaio \
    --iodepth=128 \
    --direct=1 \
    --group_reporting \
    --filename=/mnt/test/fio.dat

# Latency test (fsync-per-write, database WAL simulation)
fio --name=syncwrite \
    --rw=randwrite \
    --bs=4K \
    --size=1G \
    --numjobs=1 \
    --runtime=60 \
    --time_based \
    --ioengine=sync \
    --fsync=1 \
    --filename=/mnt/test/fio.dat
```

Key metrics to record:
- `bw`: Bandwidth (MB/s) - sequential workload performance
- `iops`: I/O operations per second - random workload performance
- `lat`: Latency (p99, p999) - tail latency for interactive workloads

## ext4 Mount Options

### Default vs Production Mount Options

Default ext4 `fstab` entry:

```
/dev/nvme0n1p1 /data ext4 defaults 0 2
```

`defaults` expands to: `rw,suid,dev,exec,auto,nouser,async`

Production-optimized mount options:

```
/dev/nvme0n1p1 /data ext4 noatime,nodiratime,data=ordered,barrier=1,errors=remount-ro,discard 0 2
```

### Mount Option Analysis

**`noatime`** (high impact)

Access time updates are written on every file read. On a busy filesystem, this turns read-only operations into write operations:

```bash
# Without noatime: every read triggers a metadata write
# With noatime: no atime update on reads

# Verify
mount | grep /data
# Expected: noatime

# Test impact
time find /data -name "*.log" 2>/dev/null | wc -l
# Compare with and without noatime on a warm cache
```

**`nodiratime`** (medium impact)

Same as `noatime` but specifically for directory access times. Usually redundant when `noatime` is set, but explicit in some configurations.

**`relatime`** (compromise option)

Updates atime only if the file was modified after the last access time, or if the last access was more than 24 hours ago. This satisfies programs that depend on atime (like mutt email reader) while reducing I/O:

```
/dev/nvme0n1p1 /data ext4 relatime,data=ordered 0 2
```

**`data=` mode** (very high durability impact)

Controls how data is journaled:

```
data=journal   # Safest: both data and metadata journaled
               # Highest write amplification; use for financial transaction logs
               # ~2x slower than writeback for write-heavy workloads

data=ordered   # Default: metadata journaled, data written before metadata commit
               # Good balance: no data corruption on crash, reasonable performance
               # Recommended for most production workloads

data=writeback # Fastest: metadata journaled, data may be written out-of-order
               # Risk: on crash, old data may appear in a file that was extended
               # Suitable for: temp files, caches, read-dominated workloads
               # Do NOT use for databases (they manage their own WAL)
```

```bash
# For a Kafka log directory (append-only, tolerates some data loss on crash)
/dev/nvme1n1 /kafka/logs ext4 noatime,data=writeback,barrier=0 0 2

# For PostgreSQL WAL (durability required)
/dev/nvme0n1 /var/lib/postgresql ext4 noatime,data=ordered,barrier=1 0 2
```

**`barrier=0`** (high performance, lower safety)

Write barriers ensure the journal commit block is flushed before subsequent data. Disabling barriers increases write throughput but risks filesystem corruption if the system loses power mid-write:

```bash
# Only safe when using:
# - A hardware RAID controller with battery-backed write cache
# - Cloud VMs where the hypervisor provides durability guarantees
# - Data that can be reconstructed from scratch (caches)
```

**`commit=N`** (tunable)

How often ext4 commits the journal in seconds (default: 5s). Lower values improve durability but increase write amplification:

```bash
# For a database with its own WAL:
# commit=60 reduces journal overhead (DB provides its own recovery)

# For a filesystem storing files where every fsync() matters:
# commit=1 provides maximum durability at the cost of more journal writes
```

**`discard`** (SSD-specific)

Enables online TRIM. Tells the SSD about freed blocks, maintaining write performance over time:

```bash
# Option 1: Online TRIM via mount option (continuous, low overhead on NVMe)
/dev/nvme0n1p1 /data ext4 noatime,discard 0 2

# Option 2: Periodic TRIM via systemd-fstrim.timer (preferred on SATA SSDs)
systemctl enable fstrim.timer
systemctl start fstrim.timer

# Check TRIM support
hdparm -I /dev/sda | grep TRIM
# or
nvme id-ns /dev/nvme0n1 | grep DLFEAT
```

### Complete Production ext4 Configuration

```bash
# Format with production options
mkfs.ext4 \
    -E lazy_itable_init=0,lazy_journal_init=0 \  # Initialize immediately (slow format, fast first use)
    -L data \
    -m 1 \  # Reserve 1% for root instead of default 5%
    /dev/nvme0n1p1

# /etc/fstab entry for high-throughput workload (Kafka, logging)
LABEL=data /data ext4 noatime,nodiratime,data=writeback,barrier=0,commit=60,discard 0 2

# /etc/fstab entry for database data files
LABEL=pgdata /var/lib/postgresql ext4 noatime,data=ordered,barrier=1,commit=5,discard 0 2

# Apply without reboot
mount -o remount,noatime,data=ordered /data

# Verify active options
findmnt /data
```

## XFS Tuning

XFS is the default filesystem on RHEL/CentOS and is preferred for large files and high-throughput workloads. It has excellent multi-threaded performance.

### XFS Mount Options

```bash
# Format XFS with production options
mkfs.xfs \
    -f \
    -L data \
    -d agcount=32 \  # Allocation groups = number of cores (for parallel allocation)
    -l size=128m,lazy-count=1 \  # Larger journal, lazy superblock counting
    /dev/nvme0n1p1

# /etc/fstab for high-throughput XFS
LABEL=data /data xfs noatime,nodiratime,inode64,logbufs=8,logbsize=256k,allocsize=64m 0 2
```

**XFS-specific options:**

```bash
# inode64: use 64-bit inodes (required for >16TB or >2^32 files)
# logbufs=8: number of log buffers (default 8; increase to 16 for write-heavy)
# logbsize=256k: log buffer size (default 32KB; larger = more batching)
# allocsize=64m: speculative preallocation for streaming writes (reduces fragmentation)
# nobarrier: disable write barriers (same caveats as ext4 barrier=0)
# largeio: hint to prefer larger I/O sizes
# swalloc: alignment for stripe workloads

# For concurrent random writes (databases):
LABEL=pgxfs /var/lib/postgresql xfs noatime,inode64,logbufs=8,logbsize=256k 0 2

# For sequential streaming (video, backups):
LABEL=media /data/media xfs noatime,inode64,allocsize=256m,largeio 0 2
```

### XFS Internal Log vs External Log

Moving the XFS journal to a separate, faster device (like Optane or a dedicated SSD partition) dramatically improves write latency:

```bash
# Create a separate log partition on a dedicated SSD
mkfs.xfs \
    -f \
    -l logdev=/dev/nvme1n1p1,size=512m \
    -d agcount=8 \
    /dev/nvme0n1p1

# Mount with external log
mount -o logdev=/dev/nvme1n1p1 /dev/nvme0n1p1 /data

# In /etc/fstab
LABEL=data /data xfs noatime,inode64 0 2
# Note: external log requires additional mount option; use UUID for the log device
```

## Page Cache and Writeback Tuning

### Understanding Writeback

Linux uses the page cache as a write buffer. When your application writes data, it goes to the page cache and is written to disk asynchronously by the pdflush/writeback mechanism. This dramatically improves write throughput but means unflushed writes are in memory only.

Key sysctl parameters:

```bash
# View current writeback parameters
cat /proc/sys/vm/dirty_ratio          # Default: 20 (% of total memory)
cat /proc/sys/vm/dirty_background_ratio  # Default: 10 (% of total memory)
cat /proc/sys/vm/dirty_expire_centisecs  # Default: 3000 (30 seconds)
cat /proc/sys/vm/dirty_writeback_centisecs  # Default: 500 (5 seconds)
```

### Tuning for Different Workloads

**High-Throughput Streaming Writes (Kafka, log aggregation):**

```bash
# Larger dirty ratio allows more buffering for bursty writes
# This can improve throughput at the cost of recovery time
cat >> /etc/sysctl.d/99-storage.conf << 'EOF'
vm.dirty_ratio = 40
vm.dirty_background_ratio = 20
vm.dirty_expire_centisecs = 6000    # 60 seconds
vm.dirty_writeback_centisecs = 500  # 5 seconds
EOF

sysctl -p /etc/sysctl.d/99-storage.conf
```

**Low-Latency/Database Workloads:**

```bash
# Smaller dirty ratio prevents latency spikes during writeback
# Database manages its own WAL, so we want OS to write data quickly
cat >> /etc/sysctl.d/99-storage.conf << 'EOF'
vm.dirty_ratio = 5
vm.dirty_background_ratio = 2
vm.dirty_expire_centisecs = 1500    # 15 seconds
vm.dirty_writeback_centisecs = 250  # 2.5 seconds
EOF
```

**Memory-Constrained Systems:**

```bash
# Absolute byte values instead of percentages (Linux 3.2+)
# Useful when you have 256GB RAM and don't want 20% = 51GB of dirty data
vm.dirty_bytes = 268435456      # 256MB
vm.dirty_background_bytes = 67108864  # 64MB
```

### Monitoring Page Cache Pressure

```bash
# Real-time view of page cache stats
watch -n 1 cat /proc/meminfo | grep -E "Dirty|Writeback|Cached"

# vmstat for I/O patterns
vmstat 1 10
# Watch the 'si' (swap in) and 'so' (swap out) columns for memory pressure
# Watch 'bi' (blocks in) and 'bo' (blocks out) for I/O rates

# iostat for per-device utilization
iostat -x 1 10
# Key columns: %util (device busy %), await (average wait time ms)
# On NVMe: %util > 80% may not indicate saturation (high queue depth is normal)

# iotop for per-process I/O
iotop -o -b -d 5 | head -20
```

## I/O Scheduler Tuning

### NVMe SSD Scheduler Selection

```bash
# Check current scheduler per block device
cat /sys/block/nvme0n1/queue/scheduler

# NVMe devices: 'none' or 'mq-deadline' are optimal
# 'none': bypass scheduling, all I/O goes directly to NVMe queue
# 'mq-deadline': adds deadline guarantees for fairness, small overhead
# 'bfq': completely fair queuing - good for desktop, bad for servers
# 'kyber': latency target-based, good for mixed workloads

# For NVMe (pure server workload)
echo none > /sys/block/nvme0n1/queue/scheduler

# For SATA SSD
echo mq-deadline > /sys/block/sda/queue/scheduler

# Make persistent via udev rule
cat > /etc/udev/rules.d/60-ioschedulers.rules << 'EOF'
# Set none scheduler for NVMe devices
ACTION=="add|change", KERNEL=="nvme*n*", ATTR{queue/scheduler}="none"

# Set mq-deadline for SATA SSDs
ACTION=="add|change", KERNEL=="sd*", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"

# Set bfq for spinning disks (if any remain)
ACTION=="add|change", KERNEL=="sd*", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
EOF

udevadm control --reload-rules
```

### NVMe Queue Depth Tuning

```bash
# Check NVMe queue configuration
cat /sys/block/nvme0n1/queue/nr_requests  # Default: 1024
cat /sys/block/nvme0n1/queue/nr_hw_queues  # Number of hardware queues

# For high-IOPS random workloads, increase queue depth
echo 2048 > /sys/block/nvme0n1/queue/nr_requests

# Check NVMe submission/completion queues
nvme list
nvme id-ctrl /dev/nvme0 | grep -E "mdts|sqes|cqes"
```

## NVMe Power Management

By default, NVMe drives may enter power-saving states that add milliseconds of latency when woken up. Disable for latency-sensitive production systems:

```bash
# Check current power policy
cat /sys/block/nvme0n1/device/power/autosuspend_delay_ms
cat /sys/class/nvme/nvme0/power/control

# Disable NVMe APST (Autonomous Power State Transitions)
nvme set-feature /dev/nvme0 --feature-id=0x0c --value=0

# Or via kernel parameter (persistent)
# Add to /etc/default/grub GRUB_CMDLINE_LINUX:
# nvme_core.default_ps_max_latency_us=0

# Or disable NVMe device power management via udev
cat > /etc/udev/rules.d/70-nvme-powersave.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="nvme", ATTR{power/control}="on"
EOF
```

## tmpfs for High-Performance Temporary Storage

For applications that need fast scratch space and can tolerate data loss on reboot:

```bash
# Mount tmpfs with explicit size limit
echo "tmpfs /tmp tmpfs noatime,nosuid,nodev,size=8G,mode=1777 0 0" >> /etc/fstab

# For application-specific tmpfs
echo "tmpfs /var/run/myapp tmpfs noatime,uid=1000,gid=1000,size=4G,mode=0700 0 0" >> /etc/fstab

# Use tmpfs for PostgreSQL temporary files
# In postgresql.conf:
# temp_tablespaces = 'tmpfs_tablespace'
# Then in psql:
# CREATE TABLESPACE tmpfs_tablespace LOCATION '/tmp/postgres-temp';
```

## Filesystem Monitoring

### Key Metrics to Monitor

```bash
# Disk utilization and saturation
iostat -x 1
# Critical: await > 10ms for SSD indicates queue saturation or firmware issues
# %util on NVMe: > 80% is normal (NVMe can handle deep queues)

# Filesystem-level metrics
df -h       # Capacity
df -i       # Inode usage (ext4: inode exhaustion causes ENOSPC despite free space)

# Dirty page writeback rate
sar -b 1 10
# Look for write patterns and bwrtn (blocks written per second)

# I/O wait at process level
ps aux | awk '$8 == "D"'  # Processes in uninterruptible sleep (D state = I/O wait)
```

### Prometheus Node Exporter Metrics

```promql
# Disk utilization (0-1 scale)
rate(node_disk_io_time_seconds_total[5m])

# Average I/O latency
rate(node_disk_read_time_seconds_total[5m])
  / rate(node_disk_reads_completed_total[5m])

# Dirty page ratio (approaching vm.dirty_ratio = risk of write stalls)
node_memory_Dirty_bytes / node_memory_MemTotal_bytes

# Filesystem capacity
1 - (node_filesystem_avail_bytes{mountpoint="/data"}
     / node_filesystem_size_bytes{mountpoint="/data"})

# Inode usage
1 - (node_filesystem_files_free{mountpoint="/data"}
     / node_filesystem_files{mountpoint="/data"})
```

Alert thresholds:
```yaml
groups:
  - name: filesystem
    rules:
      - alert: DiskSpaceLow
        expr: (1 - node_filesystem_avail_bytes / node_filesystem_size_bytes) > 0.85
        for: 5m
        annotations:
          summary: "Filesystem {{ $labels.mountpoint }} is {{ $value | humanizePercentage }} full"

      - alert: InodeLow
        expr: (1 - node_filesystem_files_free / node_filesystem_files) > 0.90
        for: 5m
        annotations:
          summary: "Filesystem {{ $labels.mountpoint }} inode usage {{ $value | humanizePercentage }}"

      - alert: HighIOLatency
        expr: |
          rate(node_disk_read_time_seconds_total[5m])
            / rate(node_disk_reads_completed_total[5m]) > 0.020
        for: 10m
        annotations:
          summary: "High disk read latency on {{ $labels.device }}: {{ $value | humanizeDuration }}"
```

## Summary Tuning Checklist

For an NVMe SSD hosting a database workload:

```bash
# /etc/fstab
/dev/nvme0n1p1 /var/lib/postgresql ext4 noatime,data=ordered,barrier=1,discard 0 2

# /etc/sysctl.d/99-storage.conf
vm.dirty_ratio = 5
vm.dirty_background_ratio = 2
vm.dirty_bytes = 268435456
vm.dirty_background_bytes = 67108864

# /etc/udev/rules.d/60-ioschedulers.rules
ACTION=="add|change", KERNEL=="nvme*n*", ATTR{queue/scheduler}="none"

# Format options
mkfs.ext4 -E lazy_itable_init=0,lazy_journal_init=0 -m 1 /dev/nvme0n1p1
```

For an NVMe SSD hosting a Kafka broker or log aggregation system:

```bash
# /etc/fstab
/dev/nvme0n1p1 /kafka/logs ext4 noatime,data=writeback,barrier=0,commit=60,discard 0 2

# /etc/sysctl.d/99-storage.conf
vm.dirty_ratio = 40
vm.dirty_background_ratio = 20
vm.dirty_expire_centisecs = 6000
```

The most impactful single change for most production SSD workloads is `noatime`. After that, the right combination of `data=` mode and barrier configuration depends on your durability requirements. Always measure the effect of changes with `fio` under realistic I/O patterns before applying to production.
