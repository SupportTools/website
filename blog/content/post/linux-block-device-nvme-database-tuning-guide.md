---
title: "Linux Block Device Tuning: blkio cgroups, I/O Schedulers, and NVMe Optimization for Databases"
date: 2030-05-02T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "NVMe", "I/O Scheduler", "cgroups", "Databases", "Storage"]
categories: ["Linux", "Performance", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Linux block device performance optimization for database workloads covering blkio cgroup v2 io.latency and io.max controllers, I/O scheduler selection (none/mq-deadline/kyber), NVMe namespace and multipath configuration, and systematic fio benchmarking methodology."
more_link: "yes"
url: "/linux-block-device-nvme-database-tuning-guide/"
---

A database workload places uniquely demanding requirements on storage: it generates both sequential scan I/O and random 4K I/O simultaneously, cares deeply about tail latency (the 99th percentile matters more than the average), and must continue serving reads during write storms from bulk ingestion. Most default Linux kernel I/O configurations are tuned for desktop workloads, not for the sub-millisecond random read latency that production databases require.

This guide covers the complete stack from hardware-level NVMe queue configuration down to cgroup I/O throttling, with a systematic benchmarking methodology to validate each change.

<!--more-->

# Linux Block Device Tuning: blkio cgroups, I/O Schedulers, and NVMe Optimization for Databases

## Understanding the Linux I/O Stack

```
Application
    │
    ▼
VFS (Virtual Filesystem Layer)
    │
    ▼
Page Cache
    │
    ▼
File System (ext4, xfs, btrfs)
    │
    ▼
Block Layer
  ├── I/O Scheduler (mq-deadline, kyber, none)
  ├── Request Queue
  └── cgroup blkio controller
    │
    ▼
Device Driver (nvme, scsi)
    │
    ▼
Hardware (NVMe SSD, HDD, RAID)
```

Every tuning decision targets a specific layer. Choosing the wrong I/O scheduler for an NVMe SSD is like enabling RAID write-back cache on hardware that doesn't need it — the overhead exists without the benefit.

## Baseline Benchmarking with fio

Before tuning, establish a reliable baseline. Without measurements, you cannot confirm that a change improved anything.

### fio Installation

```bash
apt-get install -y fio  # Debian/Ubuntu
dnf install -y fio      # RHEL/Rocky
```

### Comprehensive Benchmark Suite

```bash
#!/bin/bash
# benchmark-storage.sh — comprehensive storage benchmark for database workloads

DEVICE=${1:?Usage: $0 <device-path>}  # e.g., /dev/nvme0n1 or /mnt/data
RESULTS_DIR="/tmp/storage-benchmark-$(date +%Y%m%d%H%M)"
mkdir -p "$RESULTS_DIR"

echo "=== Storage Benchmark: $DEVICE ==="
echo "Results: $RESULTS_DIR"

# Function to run fio test and extract key metrics
run_fio() {
    local name=$1
    shift
    local output="${RESULTS_DIR}/${name}.json"
    fio --output-format=json --output="$output" "$@"
    echo "${name}:"
    python3 -c "
import json, sys
with open('$output') as f:
    data = json.load(f)
job = data['jobs'][0]
read = job['read']
write = job['write']
print(f'  Read  IOPS: {read[\"iops\"]:.0f}, Bandwidth: {read[\"bw_bytes\"]/1024/1024:.1f} MB/s, Lat p99: {read[\"lat_ns\"][\"percentile\"][\"99.000000\"]/1000:.1f} us')
print(f'  Write IOPS: {write[\"iops\"]:.0f}, Bandwidth: {write[\"bw_bytes\"]/1024/1024:.1f} MB/s, Lat p99: {write[\"lat_ns\"][\"percentile\"][\"99.000000\"]/1000:.1f} us')
"
}

# 1. Random 4K read (simulates random database page reads)
run_fio "rand-4k-read" \
    --name=rand-4k-read \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --numjobs=4 \
    --runtime=60 \
    --time_based \
    --filename="$DEVICE" \
    --lat_percentiles=1 \
    --clat_percentiles=1

# 2. Random 4K write (simulates WAL writes)
run_fio "rand-4k-write" \
    --name=rand-4k-write \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=randwrite \
    --bs=4k \
    --direct=1 \
    --numjobs=4 \
    --runtime=60 \
    --time_based \
    --filename="$DEVICE" \
    --lat_percentiles=1

# 3. Mixed random 70/30 read/write (realistic OLTP)
run_fio "oltp-mixed" \
    --name=oltp-mixed \
    --ioengine=libaio \
    --iodepth=64 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4k \
    --direct=1 \
    --numjobs=8 \
    --runtime=120 \
    --time_based \
    --filename="$DEVICE" \
    --lat_percentiles=1

# 4. Sequential read (simulates table scans)
run_fio "seq-read" \
    --name=seq-read \
    --ioengine=libaio \
    --iodepth=8 \
    --rw=read \
    --bs=128k \
    --direct=1 \
    --numjobs=2 \
    --runtime=60 \
    --time_based \
    --filename="$DEVICE"

# 5. Latency at low queue depth (critical for OLTP)
run_fio "lat-sensitive-rand-read" \
    --name=lat-sensitive \
    --ioengine=libaio \
    --iodepth=1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --numjobs=1 \
    --runtime=30 \
    --time_based \
    --filename="$DEVICE" \
    --lat_percentiles=1

echo ""
echo "=== Benchmark complete. Results in $RESULTS_DIR ==="
```

### Interpreting fio Results

For an NVMe SSD in a database context, target:

| Metric | Acceptable | Good | Excellent |
|---|---|---|---|
| Random 4K read IOPS (QD=32) | > 100K | > 300K | > 500K |
| Random 4K write IOPS (QD=32) | > 50K | > 150K | > 300K |
| Random 4K read p99 latency (QD=1) | < 500 µs | < 200 µs | < 100 µs |
| Sequential read bandwidth | > 1 GB/s | > 3 GB/s | > 6 GB/s |

## I/O Scheduler Selection

### Checking Current Scheduler

```bash
# Check scheduler for all block devices
for dev in /sys/block/*/queue/scheduler; do
    echo "$dev: $(cat $dev)"
done

# For a specific device
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber
# (brackets indicate active scheduler)
```

### Scheduler Comparison for Database Workloads

**none** (no scheduler / pass-through):
- Passes requests directly to the hardware queue
- No reordering, no merging, no fairness
- Best for NVMe SSDs: the drive's own firmware handles optimization
- Lowest latency, highest throughput for NVMe

**mq-deadline**:
- Multi-queue version of the classic deadline scheduler
- Prevents request starvation by enforcing deadlines
- Good for mixed workloads with HDD or slower SSDs
- Recommended for SATA SSDs and NVMe arrays where fairness matters

**kyber**:
- Token-bucket based fairness
- Separate queues for reads and writes
- Good for latency-sensitive mixed workloads
- Recommended when latency predictability matters more than peak throughput

**bfq** (Budget Fair Queuing):
- Designed for interactive and multimedia desktop workloads
- Too much overhead for database server use

### Setting the Scheduler Permanently

```bash
# Temporary (immediate, survives until reboot)
echo "none" | sudo tee /sys/block/nvme0n1/queue/scheduler

# Permanent via udev rule (recommended)
cat > /etc/udev/rules.d/60-scheduler.rules << 'EOF'
# NVMe devices: use none (pass-through) for lowest latency
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/scheduler}="none"

# SATA SSDs: use mq-deadline for fairness
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"

# HDDs: use mq-deadline with appropriate deadlines
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
EOF

# Reload udev rules
udevadm control --reload-rules
udevadm trigger --subsystem-match=block
```

### mq-deadline Tuning

```bash
# For NVMe SSD behind mq-deadline (if not using none)
DEVICE="nvme0n1"

# Read deadline (microseconds) — reduce for latency-sensitive
echo 50000 | sudo tee /sys/block/$DEVICE/queue/iosched/read_expire

# Write deadline (microseconds)
echo 500000 | sudo tee /sys/block/$DEVICE/queue/iosched/write_expire

# Writes per read dispatch — higher = more reads, lower = more balanced
echo 1 | sudo tee /sys/block/$DEVICE/queue/iosched/writes_starved

# Reduce maximum request batching for lower latency
echo 64 | sudo tee /sys/block/$DEVICE/queue/iosched/fifo_batch
```

## Block Device Queue Parameters

```bash
#!/bin/bash
# tune-nvme.sh — apply NVMe tuning parameters

DEVICE=${1:?Usage: $0 <device> e.g., nvme0n1}
QUEUE_DIR="/sys/block/$DEVICE/queue"

echo "=== Tuning $DEVICE ==="

# Scheduler
echo "none" > "$QUEUE_DIR/scheduler"

# Queue depth: use full hardware queue depth
# NVMe supports 65535; set to a high but practical value
echo 1024 > "$QUEUE_DIR/nr_requests"

# Read-ahead: minimal for random I/O workloads
# Database pages are typically fetched explicitly
echo 256 > "$QUEUE_DIR/read_ahead_kb"  # 256 KB

# Disable add_random: NVMe drives contribute kernel entropy
# pool exhaustion can cause stalls on high-I/O systems
echo 0 > "$QUEUE_DIR/add_random"

# Disable rotational (should already be 0 for NVMe)
echo 0 > "$QUEUE_DIR/rotational"

# I/O polling: for ultra-low latency, enable polling
# (reduces interrupts, increases CPU usage)
# echo 0 > "$QUEUE_DIR/io_poll"   # 0=poll, 1=interrupt-driven
# Only beneficial at very low queue depths with near-zero latency NVMe

# Maximum sectors per request (128 KB = 256 sectors of 512B)
echo 256 > "$QUEUE_DIR/max_sectors_kb"

echo "Current settings:"
echo "  scheduler: $(cat $QUEUE_DIR/scheduler)"
echo "  nr_requests: $(cat $QUEUE_DIR/nr_requests)"
echo "  read_ahead_kb: $(cat $QUEUE_DIR/read_ahead_kb)"
echo "  rotational: $(cat $QUEUE_DIR/rotational)"
```

## cgroup v2 blkio Controls

### Understanding cgroup v2 I/O Controllers

cgroup v2 provides two I/O controllers:
- `io.max`: Hard limits on IOPS and bandwidth
- `io.latency`: Latency-based I/O prioritization (not a hard limit)

### io.max: Hard Bandwidth and IOPS Limits

```bash
# Enable cgroup v2 (modern systems use this by default)
# Verify:
mount | grep cgroup2

# Create cgroup for the database process
CGROUP_PATH="/sys/fs/cgroup/databases"
mkdir -p "$CGROUP_PATH"

# Get device major:minor numbers
ls -la /dev/nvme0n1 | awk '{print $5, $6}' | tr -d ','
# 259 0
# So major:minor = 259:0

MAJOR_MINOR="259:0"

# Set maximum IOPS and bandwidth limits
# Format: "$MAJOR:$MINOR rbps=$BYTES_PER_SEC wbps=$BYTES_PER_SEC riops=$IOPS wiops=$IOPS"

# Limit a noisy neighbor service to 10K IOPS
echo "$MAJOR_MINOR rbps=104857600 wbps=52428800 riops=10000 wiops=5000" \
    > "$CGROUP_PATH/io.max"

# Move a process to the cgroup
echo $PID > "$CGROUP_PATH/cgroup.procs"

# Verify limits
cat "$CGROUP_PATH/io.max"

# Check current I/O statistics
cat "$CGROUP_PATH/io.stat"
```

### io.latency: Quality of Service for Databases

`io.latency` is a priority mechanism rather than a hard limit. It ensures that high-priority cgroups get their I/O served within the specified latency target by throttling lower-priority cgroups when the device is under pressure.

```bash
# Create tiered cgroups
mkdir -p /sys/fs/cgroup/databases
mkdir -p /sys/fs/cgroup/batch-jobs

MAJOR_MINOR="259:0"

# Database gets 10ms latency target (high priority)
echo "$MAJOR_MINOR target=10000" > /sys/fs/cgroup/databases/io.latency

# Batch jobs get 1000ms (low priority — will be throttled when DB needs I/O)
echo "$MAJOR_MINOR target=1000000" > /sys/fs/cgroup/batch-jobs/io.latency

# Move processes to appropriate cgroups
echo $POSTGRES_PID > /sys/fs/cgroup/databases/cgroup.procs
echo $BACKUP_PID > /sys/fs/cgroup/batch-jobs/cgroup.procs
```

### Kubernetes cgroup Configuration for I/O

```yaml
# Pod with I/O weight hint via QoS class
apiVersion: v1
kind: Pod
metadata:
  name: postgres-database
spec:
  containers:
  - name: postgres
    image: postgres:16
    resources:
      requests:
        cpu: "4"
        memory: 16Gi
      limits:
        cpu: "4"
        memory: 16Gi  # Guaranteed QoS class for most stable scheduling
```

For direct blkio weight control in Kubernetes, use the `kubelet` `--cgroup-driver=systemd` configuration and set `blkio.weight` via a DaemonSet:

```bash
# DaemonSet init container to set I/O priority for database pods
# This must run as privileged and with host PID namespace
cat /proc/$(pgrep -n postgres)/cgroup | grep blkio
echo 1000 > /sys/fs/cgroup/blkio/kubepods.slice/.../blkio.weight
```

## NVMe Namespace and Multipath Configuration

### NVMe Namespace Management

```bash
# List NVMe devices and namespaces
nvme list
# Node             SN                   Model          Namespace Usage
# /dev/nvme0n1     BTXXX                Samsung 990 Pro 1         2.00  TB

# Device info
nvme id-ctrl /dev/nvme0

# Namespace info
nvme id-ns /dev/nvme0n1

# Check NVMe queues
ls /sys/block/nvme0n1/mq/
# Shows per-CPU queues

# Check queue depth
cat /sys/block/nvme0n1/device/numa_node
cat /sys/block/nvme0n1/queue/nr_requests
```

### NVMe Multipath (for Enterprise/Datacenter NVMe)

Enterprise NVMe drives exposed over Fabrics (NVMe-oF) or multi-port PCIe may support multiple paths:

```bash
# Check NVMe multipath support
nvme list-subsys

# Enable NVMe multipath in kernel
cat /sys/module/nvme_core/parameters/multipath
# Y = enabled

# If not enabled, add kernel parameter
# Edit /etc/default/grub:
# GRUB_CMDLINE_LINUX="... nvme_core.multipath=Y"
sudo update-grub

# After enabling, check multipath devices
ls /dev/nvme* | head -20
# /dev/nvme0    (controller)
# /dev/nvme0n1  (namespace - multipath device)
# /dev/nvme0c0n1  (per-controller path 0)
# /dev/nvme0c1n1  (per-controller path 1)

# The /dev/nvme0n1 device provides automatic load balancing and failover
nvme list-subsys /dev/nvme0n1
```

### NVMe Power State Management

```bash
# Check power states
nvme id-ctrl /dev/nvme0 -H | grep -A20 "Power State"

# Disable APST (Autonomous Power State Transitions) for consistent latency
# APST can cause latency spikes when the drive wakes from a lower power state
nvme set-feature /dev/nvme0 -f 0x0c -v 0x0 -s

# Verify
nvme get-feature /dev/nvme0 -f 0x0c -H
# feature: Autonomous Power State Transition
# value:   0x00000000

# For Kubernetes, set via udev rule to survive reboots
echo 'ACTION=="add|change", KERNEL=="nvme[0-9]*", RUN+="/usr/bin/nvme set-feature %k -f 0x0c -v 0x0"' \
    > /etc/udev/rules.d/61-nvme-power.rules
```

## Filesystem Mount Options for Databases

```bash
# ext4 optimal mount options for PostgreSQL
# Add to /etc/fstab:
/dev/nvme0n1p1  /var/lib/postgresql  ext4  \
    defaults,noatime,nodiratime,data=writeback,barrier=1,nodelalloc  0 2

# XFS optimal mount options (often better for PostgreSQL)
/dev/nvme0n1p1  /var/lib/postgresql  xfs  \
    defaults,noatime,nodiratime,inode64,allocsize=16m,logbufs=8,logbsize=256k  0 2

# Remount with new options (without reboot)
mount -o remount,noatime,nodiratime /var/lib/postgresql
```

## Kernel Parameters for I/O Performance

```bash
# /etc/sysctl.d/60-io-performance.conf

# VM dirty page handling — critical for database write performance
# Percentage of RAM that can be dirty before writeback starts
vm.dirty_ratio = 5          # Default 20, lower for databases to avoid write storms
vm.dirty_background_ratio = 2  # Default 10, triggers background writeback earlier

# Dirty expire: flush pages older than this (centiseconds)
vm.dirty_expire_centisecs = 1000  # 10 seconds (default 3000)
vm.dirty_writeback_centisecs = 100  # Writeback interval: 1 second (default 500)

# Queue depth for I/O scheduler
vm.nr_requests = 4096  # Global fallback, overridden per-device

# Transparent huge pages: disable for databases (causes latency spikes)
# Set in /sys/kernel/mm/transparent_hugepage/enabled
# echo never > /sys/kernel/mm/transparent_hugepage/enabled
# echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

```bash
# Apply immediately
sysctl -p /etc/sysctl.d/60-io-performance.conf

# Disable THP (persistent via systemd service)
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=mongod.service postgresql.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=basic.target
EOF

systemctl enable --now disable-thp
```

## PostgreSQL-Specific Block Device Tuning

```bash
# PostgreSQL checkpoint and WAL settings that interact with block I/O
# In postgresql.conf:

# WAL synchronization — matches NVMe capabilities
synchronous_commit = on      # Full durability
wal_sync_method = fdatasync  # Best for most Linux setups (matches O_DSYNC behavior)

# Shared buffers — larger reduces I/O, but don't exceed 25% RAM for PostgreSQL
shared_buffers = 8GB         # For 32 GB system

# Effective cache size — helps query planner choose index scans
effective_cache_size = 24GB  # ~75% of RAM

# Random page cost — set lower for SSDs (default 4.0)
random_page_cost = 1.1       # For NVMe
seq_page_cost = 1.0

# Checkpoint settings — larger reduces checkpoint frequency but increases recovery time
checkpoint_completion_target = 0.9
max_wal_size = 4GB
min_wal_size = 512MB
checkpoint_timeout = 15min

# Parallel query — utilize multiple cores
max_parallel_workers_per_gather = 4
max_parallel_workers = 8
```

## Validation After Tuning

```bash
#!/bin/bash
# validate-tuning.sh — compare before/after results

echo "=== Current Block Device Settings ==="

for dev in $(ls /sys/block/ | grep nvme); do
    echo ""
    echo "Device: $dev"
    echo "  Scheduler: $(cat /sys/block/$dev/queue/scheduler)"
    echo "  nr_requests: $(cat /sys/block/$dev/queue/nr_requests)"
    echo "  read_ahead_kb: $(cat /sys/block/$dev/queue/read_ahead_kb)"
    echo "  rotational: $(cat /sys/block/$dev/queue/rotational)"
done

echo ""
echo "=== VM Dirty Settings ==="
sysctl vm.dirty_ratio vm.dirty_background_ratio \
       vm.dirty_expire_centisecs vm.dirty_writeback_centisecs

echo ""
echo "=== THP Status ==="
cat /sys/kernel/mm/transparent_hugepage/enabled

echo ""
echo "=== Running Quick Validation Benchmark ==="
fio --name=validation \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4k \
    --direct=1 \
    --numjobs=4 \
    --runtime=30 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --output-format=normal | tail -30
```

## Key Takeaways

- The `none` I/O scheduler (pass-through) is optimal for NVMe SSDs — the drive's internal firmware does request reordering far more effectively than the kernel, and the scheduler overhead only adds latency.
- `io.latency` in cgroup v2 provides soft QoS guarantees for database processes — it does not cap the database's I/O but throttles co-located batch workloads when the device approaches the latency target.
- Disable Transparent Huge Pages before running any database workload — THP defragmentation causes latency spikes measured in tens of milliseconds, which is catastrophic for p99 OLTP latency.
- Disabling APST on NVMe drives eliminates wake-from-sleep latency spikes; enterprise workloads that require consistent single-digit microsecond latency must disable all autonomous power management.
- `vm.dirty_ratio=5` and `vm.dirty_background_ratio=2` prevent the kernel from accumulating too many dirty pages before starting writeback — the default values of 20/10 allow write storms that cause multi-second I/O stalls.
- Always benchmark before and after any tuning change with a fio workload that matches your actual database access pattern — sequential bandwidth benchmarks are meaningless for OLTP workloads.
- Validate p99 latency at queue depth 1 as well as peak throughput — a change that doubles IOPS but triples p99 latency is counterproductive for interactive database workloads.
