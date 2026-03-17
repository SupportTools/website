---
title: "Linux Disk Scheduling and I/O Optimization: blk-mq, Write-Back Caching, and bcache"
date: 2030-05-09T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "I/O", "blk-mq", "bcache", "Performance", "Disk Scheduling"]
categories: ["Linux", "Storage", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux I/O optimization: block multiqueue architecture, I/O scheduler selection and tuning, write-back vs write-through caching, bcache SSD caching for HDDs, dm-cache alternatives, and I/O priority with cgroups v2."
more_link: "yes"
url: "/linux-disk-scheduling-io-optimization-blk-mq-bcache-writeback/"
---

Storage I/O is frequently the bottleneck in database servers, log aggregators, and analytics pipelines. Modern Linux I/O architecture has evolved significantly from the single-queue block layer: multi-queue block I/O (blk-mq) enables per-CPU I/O submission queues, NVMe drives operate at millions of IOPS, and SSD caching layers like bcache and dm-cache can transparently accelerate HDD arrays. Understanding these layers — and the trade-offs between latency, throughput, and data safety — is essential for squeezing maximum performance from storage hardware.

This guide covers the complete Linux I/O stack: blk-mq scheduler selection, write-back caching trade-offs, bcache configuration for HDD+SSD hybrid storage, I/O priority enforcement with cgroups v2, and monitoring the block layer with `iostat`, `blktrace`, and `bpftrace`.

<!--more-->

## The Linux Block I/O Stack

### Architecture Evolution: Single-Queue to blk-mq

```
Traditional Single-Queue (Linux < 3.13):
  Application → VFS → Page Cache → Elevator Queue (single) → Device Driver → Hardware
                                    ↑
                           One lock for all CPUs
                           = contention at >100K IOPS

Multi-Queue blk-mq (Linux >= 3.13, default >= 4.9):
  Application → VFS → Page Cache → SW Queue (per-CPU) → HW Queue (per-device) → Hardware
                                    ↑                     ↑
                           Lock-free per CPU       Mapped to device MSI-X queues
                           = scales to millions of IOPS
```

### Verifying blk-mq Is Active

```bash
# Check if blk-mq is in use for a specific device
cat /sys/block/sda/queue/nr_hw_queues
# > 1: NVMe or blk-mq-capable device with multiple hardware queues
# = 1: Single hardware queue (HDDs, older SATA SSDs)

# List queue depth and scheduler
for dev in /sys/block/sd* /sys/block/nvme*; do
    if [ -d "$dev" ]; then
        devname=$(basename "$dev")
        scheduler=$(cat "$dev/queue/scheduler")
        depth=$(cat "$dev/queue/nr_requests")
        hw_queues=$(cat "$dev/queue/nr_hw_queues" 2>/dev/null || echo "N/A")
        rotational=$(cat "$dev/queue/rotational")
        printf "%-10s scheduler=[%s] depth=%s hw_queues=%s rotational=%s\n" \
            "$devname" "$scheduler" "$depth" "$hw_queues" "$rotational"
    fi
done
```

## I/O Schedulers

### Available Schedulers

```bash
# View current scheduler (brackets indicate active scheduler)
cat /sys/block/sda/queue/scheduler
# Output: [mq-deadline] kyber bfq none

# Available schedulers:
# none       - Pass-through; no reordering; best for NVMe with hardware queuing
# mq-deadline - Time-bounded FIFO; good for database workloads (default for HDDs)
# kyber      - Low-latency two-bucket scheduler; designed for fast NVMe
# bfq        - Budget Fair Queueing; fairness between cgroups (desktop/server mixed)

# Change scheduler (immediate, no reboot)
echo "mq-deadline" > /sys/block/sda/queue/scheduler
echo "none" > /sys/block/nvme0n1/queue/scheduler

# Make permanent via udev rules
cat > /etc/udev/rules.d/60-io-scheduler.rules << 'EOF'
# NVMe drives: pass-through (no scheduler needed, hardware handles queuing)
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/rotational}=="0", \
    ATTR{queue/scheduler}="none"

# SATA SSDs: mq-deadline for low-latency
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="0", \
    ATTR{queue/scheduler}="mq-deadline"

# HDDs: mq-deadline with read priority
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="1", \
    ATTR{queue/scheduler}="mq-deadline"
EOF

udevadm trigger
```

### mq-deadline Tuning

```bash
# mq-deadline parameters for database workloads (e.g., PostgreSQL on HDD RAID)

# Read deadline: max time before a read is guaranteed to be serviced (ms)
# Default: 500ms; for interactive DB: 100ms
echo 100 > /sys/block/sda/queue/iosched/read_expire

# Write deadline: max time before a write is serviced (ms)
# Default: 5000ms; writes can tolerate more delay
echo 2000 > /sys/block/sda/queue/iosched/write_expire

# Batching: serve this many reads in a row before switching to writes
# Higher = better sequential read throughput; lower = more write fairness
echo 16 > /sys/block/sda/queue/iosched/reads_starved

# Front merges: allow merging requests in front of existing requests
# Disabled for write-heavy workloads (overhead not worth it)
echo 0 > /sys/block/sda/queue/iosched/front_merges

# Increase queue depth for HDD RAID arrays
# Allow up to 256 requests per device in the scheduler queue
echo 256 > /sys/block/sda/queue/nr_requests
```

### BFQ for Mixed Workloads

```bash
# BFQ (Budget Fair Queueing) is ideal when multiple workloads share storage
# e.g., background backups competing with database queries

echo "bfq" > /sys/block/sda/queue/scheduler

# BFQ parameters
# Slice idle: time BFQ waits for more I/O from an idle process (ms)
# Increase for sequential workloads; decrease for random
echo 8 > /sys/block/sda/queue/iosched/slice_idle

# Weights can be set per cgroup - see cgroups section below

# BFQ with cgroup I/O weight
# Set the database I/O weight to 1000 (max 1000), backups to 100
mkdir -p /sys/fs/cgroup/database /sys/fs/cgroup/backup
echo "8:0 1000" > /sys/fs/cgroup/database/io.weight  # major:minor weight
echo "8:0 100" > /sys/fs/cgroup/backup/io.weight
```

## Write-Back vs Write-Through Caching

### Understanding the Trade-offs

```
Write-Through (data safety priority):
  Application WRITE → Linux Page Cache → Immediately flushed to disk
  - Every write waits for disk confirmation
  - Data is never lost even on power failure
  - Throughput: limited by disk write speed
  - Latency: each write latency = disk write latency
  - Use case: financial transactions, WAL files, audit logs

Write-Back (performance priority):
  Application WRITE → Linux Page Cache → Returned immediately (disk flush is async)
  - Write completes as soon as page cache acknowledges it
  - Data is at risk between write acknowledgment and disk flush
  - Throughput: can absorb write bursts; coalesces multiple writes
  - Latency: each write latency ≈ memory latency
  - Use case: bulk data loading, temporary data, tolerated-loss metrics
```

### Controlling Write-Back Behavior

```bash
# View current dirty page thresholds
sysctl vm.dirty_ratio vm.dirty_background_ratio vm.dirty_expire_centisecs vm.dirty_writeback_centisecs

# vm.dirty_ratio (default 20):
# % of total memory that can be dirty before processes block to flush
# For write-heavy workloads, increase to allow larger write bursts
# For latency-sensitive workloads, decrease to flush more aggressively

# vm.dirty_background_ratio (default 10):
# % dirty pages that triggers background writeback (pdflush/writeback thread)

# vm.dirty_expire_centisecs (default 3000 = 30 seconds):
# How long a dirty page can sit before it MUST be written
# Decrease for better crash recovery (at cost of more I/O)

# vm.dirty_writeback_centisecs (default 500 = 5 seconds):
# How often the writeback thread runs to check for expired dirty pages

# Configuration for latency-sensitive database (PostgreSQL, MySQL):
# Aggressive flushing to reduce dirty page accumulation
cat > /etc/sysctl.d/99-io-tuning.conf << 'EOF'
# Dirty page ratios: keep dirty data small for consistent latency
vm.dirty_ratio = 10
vm.dirty_background_ratio = 3

# Flush dirty pages after 5 seconds (instead of 30)
vm.dirty_expire_centisecs = 500

# Run writeback every 2 seconds (instead of 5)
vm.dirty_writeback_centisecs = 200

# Increase read-ahead for sequential workloads (in KB)
# Default: 128KB; for large sequential reads (backup, ETL): 4MB
# Set per-device with blockdev command instead
EOF

sysctl -p /etc/sysctl.d/99-io-tuning.conf

# Per-device read-ahead (more targeted than sysctl)
blockdev --setra 8192 /dev/sda   # 4MB read-ahead (8192 * 512 byte sectors)
blockdev --getra /dev/sda         # Verify
```

### Forcing Synchronous I/O

```bash
# For specific files that must be written synchronously:
# O_SYNC: each write call flushes data and metadata to disk before returning
# O_DSYNC: flushes data only (not metadata) - faster than O_SYNC

# PostgreSQL enforces fsync at transaction commit level:
# wal_sync_method = fdatasync  (fastest synchronous WAL method on Linux)
# synchronous_commit = on       (wait for WAL flush before reporting commit)

# MySQL InnoDB:
# innodb_flush_log_at_trx_commit = 1  (flush WAL per transaction)
# innodb_flush_method = O_DIRECT       (bypass page cache for InnoDB data files)

# Mount with sync option (impacts ALL writes - use only for critical filesystems)
mount -o sync /dev/sdb1 /mnt/critical-data

# Or force sync for a specific file descriptor in application code:
# int fd = open("file.dat", O_WRONLY | O_DSYNC);
# All writes to fd are synchronous
```

## bcache: SSD Caching for HDDs

### Architecture

```
bcache Architecture:

  Application
       │
       ▼
  /dev/bcache0  (virtual device, appears as normal block device)
       │
  ┌────┴────────────────────────────────────────┐
  │                   bcache                     │
  │                                             │
  │  Cache Device (/dev/ssd):                   │
  │  - Hot data: recently accessed blocks       │
  │  - Write staging: pending writes to HDD     │
  │                                             │
  │  Backing Device (/dev/hdd):                 │
  │  - Cold data and full dataset               │
  │  - Receives writes after SSD staging        │
  └─────────────────────────────────────────────┘
```

### Setting Up bcache

```bash
# Install bcache utilities
apt-get install bcache-tools

# 1. Prepare the SSD as a cache device
# WARNING: This destroys all data on the device
wipefs -a /dev/sdc
make-bcache -C /dev/sdc   # -C = cache device

# 2. Prepare the HDD as a backing device
wipefs -a /dev/sdb
make-bcache -B /dev/sdb   # -B = backing device

# 3. Get the cache set UUID
CACHE_SET_UUID=$(ls /sys/fs/bcache/)
echo "Cache set UUID: $CACHE_SET_UUID"

# 4. Attach the backing device to the cache set
echo "$CACHE_SET_UUID" > /sys/block/sdb/bcache/attach

# 5. Verify bcache device is created
ls /dev/bcache*
# /dev/bcache0  <- virtual device to use for filesystem

# 6. Create filesystem on bcache device
mkfs.ext4 -F /dev/bcache0

# 7. Mount
mount /dev/bcache0 /mnt/data

# Verify configuration
cat /sys/block/bcache0/bcache/state
# Values: no cache, clean, dirty, inconsistent
```

### bcache Cache Modes

```bash
# Write-back mode (default): writes go to SSD first, then async to HDD
# Best for: general-purpose workloads, databases with write bursts
echo writeback > /sys/block/bcache0/bcache/cache_mode

# Write-through mode: writes go to BOTH SSD and HDD simultaneously
# Best for: read-heavy workloads; ensures no data loss if SSD fails
echo writethrough > /sys/block/bcache0/bcache/cache_mode

# Write-around mode: writes go directly to HDD; only reads are cached
# Best for: streaming writes (backups, log writes) - avoids cache pollution
echo writearound > /sys/block/bcache0/bcache/cache_mode

# None: bcache disabled, direct access to backing device
echo none > /sys/block/bcache0/bcache/cache_mode

# Check current mode
cat /sys/block/bcache0/bcache/cache_mode
```

### bcache Performance Tuning

```bash
# Sequential cutoff: I/O requests larger than this are bypassed to HDD
# Prevents large sequential reads from evicting hot random-access data
# Default: 4MB; increase for workloads with large sequential I/O patterns
echo 16M > /sys/block/bcache0/bcache/sequential_cutoff

# Readahead: enable for workloads with sequential access patterns
echo 1 > /sys/block/bcache0/bcache/readahead

# Cache replacement policy
# lru (default): Least Recently Used - good for random access
# fifo: First In First Out - good for streaming/scan workloads
echo lru > /sys/fs/bcache/$CACHE_SET_UUID/replacement

# Congestion thresholds: when to start writing dirty cache to disk
# dirty_data: trigger writeback when this many bytes dirty in cache
echo 10G > /sys/fs/bcache/$CACHE_SET_UUID/congested_write_threshold_us

# Monitor bcache hit rates
cat /sys/block/bcache0/bcache/stats_day/cache_hit_ratio
cat /sys/block/bcache0/bcache/stats_day/cache_hits
cat /sys/block/bcache0/bcache/stats_day/cache_misses
cat /sys/block/bcache0/bcache/stats_day/cache_bypass_hits
cat /sys/block/bcache0/bcache/stats_day/cache_bypass_misses

# Comprehensive bcache status script
#!/bin/bash
for bcdev in /sys/block/bcache*/bcache; do
    devname=$(echo "$bcdev" | sed 's|/sys/block/||;s|/bcache||')
    echo "=== $devname ==="
    printf "  Mode:      %s\n" "$(cat $bcdev/cache_mode)"
    printf "  State:     %s\n" "$(cat $bcdev/state)"
    printf "  Hit rate:  %s%%\n" "$(cat $bcdev/stats_total/cache_hit_ratio)"
    printf "  Hits:      %s\n" "$(cat $bcdev/stats_total/cache_hits)"
    printf "  Misses:    %s\n" "$(cat $bcdev/stats_total/cache_misses)"
    printf "  Dirty:     %s\n" "$(cat $bcdev/dirty_data 2>/dev/null || echo N/A)"
    echo ""
done
```

### dm-cache Alternative

```bash
# dm-cache is the device-mapper equivalent of bcache
# Advantage: integrates with LVM, standard kernel module
# Disadvantage: less mature, fewer tuning options than bcache

# Create a dm-cache setup using LVM
# Assuming /dev/sdb = HDD, /dev/sdc = SSD

# 1. Create physical volumes
pvcreate /dev/sdb /dev/sdc

# 2. Create volume group spanning both
vgcreate data_vg /dev/sdb /dev/sdc

# 3. Create the origin (HDD) logical volume
lvcreate -n data_lv -l 100%FREE /dev/sdb

# 4. Create cache pool on SSD
lvcreate --type cache-pool -n cache_pool -l 100%FREE /dev/sdc

# 5. Attach cache pool to origin
lvconvert --type cache \
    --cachepool data_vg/cache_pool \
    --cachemode writeback \
    data_vg/data_lv

# 6. Use the cached volume
mkfs.ext4 /dev/data_vg/data_lv
mount /dev/data_vg/data_lv /mnt/data

# Monitor dm-cache statistics
dmsetup status data_vg-data_lv
# Output includes: metadata blocks used, cache blocks used, read hits, write hits
```

## I/O Priority with cgroups v2

### cgroups v2 I/O Weight and Limits

```bash
# Verify cgroups v2 is mounted
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# Enable I/O controller for a cgroup
mkdir -p /sys/fs/cgroup/database
echo "+io" > /sys/fs/cgroup/database/cgroup.subtree_control

# Set I/O weight (1-10000, default 100)
# Get device major:minor numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 ...  <- major=8, minor=0

# Set database cgroup to 10x higher I/O weight than default
echo "8:0 1000" > /sys/fs/cgroup/database/io.weight

# Set maximum read BPS limit for backup cgroup (bytes per second)
mkdir -p /sys/fs/cgroup/backup
echo "8:0 rbps=104857600" > /sys/fs/cgroup/backup/io.max  # 100 MB/s read limit

# Set maximum write IOPS for backup cgroup
echo "8:0 wiops=1000" > /sys/fs/cgroup/backup/io.max       # 1000 IOPS write limit

# Combine multiple limits on one device
echo "8:0 rbps=209715200 wbps=104857600 riops=10000 wiops=5000" > /sys/fs/cgroup/backup/io.max

# Monitor cgroup I/O statistics
cat /sys/fs/cgroup/database/io.stat
# Output: 8:0 rbytes=... wbytes=... rios=... wios=... dbytes=... dios=...
```

### Applying cgroup I/O Limits with systemd

```ini
# /etc/systemd/system/postgresql.service.d/io-limits.conf
[Service]
# I/O weight (1-10000)
IOWeight=800

# Per-device I/O bandwidth limits
# No limits for PostgreSQL - give it full access
# IOReadBandwidthMax=/dev/sda infinity
# IOWriteBandwidthMax=/dev/sda infinity

# Limit PostgreSQL to specific IOPS if needed
# IOReadIOPSMax=/dev/sda 50000
# IOWriteIOPSMax=/dev/sda 20000
```

```ini
# /etc/systemd/system/backup.service.d/io-limits.conf
[Service]
# Low I/O weight for backup (won't preempt database)
IOWeight=50

# Limit backup read bandwidth to 50 MB/s
IOReadBandwidthMax=/dev/sda 52428800

# Limit backup write bandwidth to 25 MB/s (to backup destination)
IOWriteBandwidthMax=/dev/sdb 26214400
```

## Block Layer Monitoring

### iostat Analysis

```bash
# Extended iostat output (most useful columns)
iostat -x -d 1 /dev/sda

# Column interpretation:
# r/s, w/s: reads/writes per second
# rkB/s, wkB/s: throughput in KB/s
# r_await, w_await: average wait time for requests (ms) - KEY METRIC
#   r_await > 10ms on SSD = potential issue
#   r_await > 30ms on HDD = potential issue
# aqu-sz: average queue length (should be close to 1 for optimal)
# %util: % time device was busy - does NOT directly indicate saturation for NVMe

# Monitor all block devices in real time
iostat -x 1 | awk '
/^[A-Za-z]/ && !/Linux/ && !/avg-cpu/ && !/Device/ {
    if ($14 > 5 || $16 > 20) {  # r_await > 5ms or w_await > 20ms
        printf "ALERT: %s r_await=%.1fms w_await=%.1fms util=%.1f%%\n",
            $1, $6, $10, $22
    }
}'
```

### blktrace for Deep I/O Analysis

```bash
# Capture block layer traces for a specific device
blktrace -d /dev/sda -o /tmp/sda_trace &
TRACE_PID=$!
sleep 30
kill $TRACE_PID

# Analyze the trace
blkparse /tmp/sda_trace.blktrace.* -o /tmp/sda_trace.txt

# Summarize I/O patterns
btt -i /tmp/sda_trace.blktrace.* | head -50

# Key metrics from btt output:
# Q2C (Queue to Complete): total I/O latency
# D2C (Dispatch to Complete): time in device driver
# Q2D (Queue to Dispatch): time in scheduler queue

# Find the top I/O offenders by latency
grep 'C' /tmp/sda_trace.txt | \
    awk '{print $5, $7}' | \
    sort -k2 -rn | \
    head -20
```

### bpftrace I/O Latency Histograms

```bash
# Install bpftrace
apt-get install bpftrace

# Histogram of block I/O completion latency
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
}
tracepoint:block:block_rq_complete {
    $lat = (nsecs - @start[args->dev, args->sector]) / 1000;  // convert to microseconds
    delete(@start[args->dev, args->sector]);
    if ($lat > 0) {
        @latency_us = hist($lat);
    }
}
END {
    print(@latency_us);
}' &

sleep 30
kill %1

# Output example:
# @latency_us:
# [1]                3 |                                                    |
# [2, 4)           127 |@@@@                                                |
# [4, 8)          1847 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
# [8, 16)          234 |@@@@@@@                                             |
# [16, 32)          89 |@@                                                  |
# [32, 64)          12 |                                                    |
# [64, 128)          3 |                                                    |
# [128, 256)         1 |                                                    |  <- I/O outliers

# Per-process I/O latency tracking
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector, tid] = nsecs;
    @comm[tid] = comm;
}
tracepoint:block:block_rq_complete {
    $key = (args->dev, args->sector);
    // Find matching tid
    $lat = (nsecs - @start[args->dev, args->sector, tid]) / 1000000;  // ms
    if ($lat > 50) {  // Only report latencies > 50ms
        printf "%-16s PID:%-7d %5dms %s\n",
            @comm[tid], tid, $lat,
            args->rwbs == 1 ? "READ" : "WRITE";
    }
    delete(@start[args->dev, args->sector, tid]);
}
'
```

## Filesystem-Level Optimizations

### Mount Options for Performance

```bash
# ext4 performance mount options
mount -o noatime,nodiratime,data=writeback,barrier=0 /dev/sda1 /data

# Options explained:
# noatime: don't update access time on reads (eliminates a write per read)
# nodiratime: don't update directory access times
# data=writeback: data writes don't need to wait for journal (performance++, safety--)
# barrier=0: disable write barriers (dangerous without UPS/battery-backed cache)

# For XFS (preferred for large files, databases)
mount -o noatime,nodiratime,logbsize=256k,allocsize=4m /dev/sda1 /data
# logbsize: log buffer size (default 32KB, 256KB better for heavy writes)
# allocsize: allocation size hint for large sequential files

# NFS mount options for network storage
mount -o rw,hard,intr,noatime,rsize=1048576,wsize=1048576,timeo=600 \
    nfs-server:/export /mnt/nfs

# /etc/fstab entry for persistent settings
# /dev/sda1 /data ext4 noatime,nodiratime,data=writeback 0 2
```

### Direct I/O: Bypassing Page Cache

```bash
# Applications can bypass the page cache using O_DIRECT
# PostgreSQL uses this for shared_buffers management
# MySQL InnoDB uses innodb_flush_method=O_DIRECT

# Benchmark direct I/O vs buffered I/O
# Using fio (flexible I/O tester)
apt-get install fio

# Buffered random 4KB reads
fio --name=buffered-read \
    --filename=/dev/sda \
    --rw=randread \
    --bs=4k \
    --numjobs=4 \
    --iodepth=32 \
    --runtime=30 \
    --time_based \
    --output-format=terse

# Direct I/O random 4KB reads
fio --name=direct-read \
    --filename=/dev/sda \
    --rw=randread \
    --bs=4k \
    --numjobs=4 \
    --iodepth=32 \
    --direct=1 \          # O_DIRECT flag
    --runtime=30 \
    --time_based \
    --output-format=terse

# Mixed read/write database simulation
fio --name=db-simulation \
    --filename=/mnt/data/test.dat \
    --size=10G \
    --rw=randrw \
    --rwmixread=70 \
    --bs=8k \
    --numjobs=8 \
    --iodepth=64 \
    --direct=1 \
    --ioengine=libaio \
    --group_reporting \
    --runtime=60 \
    --time_based
```

## Production I/O Tuning Playbook

### Complete Tuning Script

```bash
#!/usr/bin/env bash
# io-tune-production.sh - Production I/O tuning for database servers

set -euo pipefail

# Validate we're running as root
[ "$(id -u)" -eq 0 ] || { echo "Must run as root"; exit 1; }

echo "=== Configuring I/O Scheduler for Database Workload ==="

for dev in /sys/block/sd* /sys/block/nvme*; do
    [ -d "$dev" ] || continue
    devname=$(basename "$dev")
    rotational=$(cat "$dev/queue/rotational")

    if [ "$rotational" = "0" ]; then
        # SSD/NVMe
        echo "none" > "$dev/queue/scheduler"
        echo 1024 > "$dev/queue/nr_requests"
        echo 0 > "$dev/queue/add_random"    # Disable random number entropy from I/O
        echo 0 > "$dev/queue/rq_affinity"   # Process completions on any CPU
        printf "  %s (SSD): scheduler=none, depth=1024\n" "$devname"
    else
        # HDD
        echo "mq-deadline" > "$dev/queue/scheduler"
        echo 256 > "$dev/queue/nr_requests"
        echo 100 > "$dev/queue/iosched/read_expire"
        echo 2000 > "$dev/queue/iosched/write_expire"
        echo 0 > "$dev/queue/add_random"
        printf "  %s (HDD): scheduler=mq-deadline, depth=256\n" "$devname"
    fi

    # Disable NCQ for HDD (can help with random I/O on older drives)
    if [ "$rotational" = "1" ]; then
        echo 1 > "$dev/queue/nr_hw_queues" 2>/dev/null || true
    fi
done

echo ""
echo "=== Configuring Virtual Memory for I/O ==="
cat > /etc/sysctl.d/99-io-production.conf << 'EOF'
# Reduce dirty page accumulation for consistent write latency
vm.dirty_ratio = 10
vm.dirty_background_ratio = 3
vm.dirty_expire_centisecs = 500
vm.dirty_writeback_centisecs = 200

# Reduce swappiness to keep working set in RAM
vm.swappiness = 1

# Increase the number of active file handles
fs.file-max = 2097152
EOF
sysctl -p /etc/sysctl.d/99-io-production.conf

echo ""
echo "=== Setting Read-Ahead ==="
for dev in /dev/sd* /dev/nvme*n*; do
    [ -b "$dev" ] || continue
    if [[ "$dev" =~ nvme ]]; then
        blockdev --setra 0 "$dev"    # No read-ahead for random-access NVMe
    else
        blockdev --setra 4096 "$dev" # 2MB read-ahead for HDD
    fi
    printf "  %s: read-ahead = %s sectors\n" "$dev" "$(blockdev --getra "$dev")"
done

echo ""
echo "=== I/O Tuning Complete ==="
echo "Run 'iostat -x 1' to monitor I/O performance"
```

## Key Takeaways

Linux I/O optimization requires understanding the workload characteristics — random vs sequential, read vs write ratio, latency sensitivity vs throughput — and matching the I/O stack configuration to those requirements.

**Scheduler selection is the foundation**: NVMe drives with hardware queuing should use `none` (pass-through) — the hardware scheduler outperforms any kernel scheduler. SATA SSDs and HDDs benefit from `mq-deadline` for database workloads, which bounds I/O wait time and prioritizes reads.

**Write-back caching delivers throughput at the cost of durability**: The Linux page cache write-back mechanism is the primary write acceleration path. Tuning `vm.dirty_ratio` and `vm.dirty_expire_centisecs` controls the trade-off between write burst absorption and crash recovery window. Database applications should use their own fsync discipline (e.g., PostgreSQL WAL flush) rather than relying on OS write-back for correctness guarantees.

**bcache provides a cost-effective hybrid storage tier**: A 200GB NVMe SSD caching a 4TB HDD array can bring the hot-data access pattern to near-NVMe performance at HDD storage costs. The sequential cutoff parameter is critical — without it, large sequential scans will evict hot random-access data from the cache.

**cgroups v2 I/O control is essential for mixed workloads**: Without I/O weight and bandwidth limits, background processes (backups, VACUUM, replication) will compete with application I/O on the same device. Setting explicit weights via systemd `IOWeight` ensures production workloads receive the I/O priority they require.

**Measure before and after every change**: Use `iostat -x 1` to establish baseline metrics (r_await, w_await, %util) before any tuning change, and verify improvement after. The optimal configuration is hardware-specific and cannot be determined from general guidelines alone.
