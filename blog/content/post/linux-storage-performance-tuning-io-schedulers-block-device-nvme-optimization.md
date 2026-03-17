---
title: "Linux Storage Performance Tuning: I/O Schedulers, Block Device Queues, and NVMe Optimization"
date: 2031-07-23T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "Performance", "NVMe", "I/O Scheduler", "Tuning"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux storage performance tuning covering I/O scheduler selection, block device queue parameters, NVMe namespace configuration, and production tuning strategies for database and high-IOPS workloads."
more_link: "yes"
url: "/linux-storage-performance-tuning-io-schedulers-block-device-nvme-optimization/"
---

Storage I/O is frequently the bottleneck in production systems, yet the Linux kernel exposes dozens of tunable parameters that most operators never touch. The default configuration is a compromise intended to work acceptably across a wide range of hardware and workload types — but an NVMe SSD running a PostgreSQL database has dramatically different optimization requirements than a spinning disk serving a media file cache. This guide provides a systematic approach to identifying the right tuning parameters for your workload and hardware.

<!--more-->

# Linux Storage Performance Tuning: I/O Schedulers, Block Device Queues, and NVMe Optimization

## Understanding the Linux Storage Stack

Before tuning, understand what you're tuning:

```
Application (PostgreSQL, etc.)
      │ syscall (read/write/fsync)
      ▼
VFS Layer (file system abstraction)
      │
      ▼
File System (ext4 / xfs / btrfs)
      │ block I/O requests
      ▼
Page Cache (deferred writes, read-ahead)
      │
      ▼
Block Layer
  ├── I/O Scheduler (mq-deadline / none / bfq / kyber)
  ├── Request Queue (queue depth, merging)
  └── Multi-Queue (blk-mq) framework
      │
      ▼
Device Driver (NVMe / SCSI / SATA)
      │
      ▼
Physical Hardware
```

Each layer has tuning opportunities. The biggest wins typically come from:
1. Choosing the right I/O scheduler for your hardware
2. Tuning queue depth and request merging
3. NVMe-specific optimizations (namespaces, power state, polling)
4. File system mount options and alignment
5. Read-ahead and dirty page writeback policy

## Gathering Baseline Metrics

Never tune without a baseline. Use these tools:

```bash
# Overall I/O statistics (1-second snapshots)
iostat -xz 1

# Sample output for NVMe:
# Device            r/s     rkB/s   rrqm/s  %rrqm  r_await rareq-sz  w/s     wkB/s   wrqm/s  %wrqm  w_await wareq-sz  d/s   dkB/s   drqm/s %drqm  d_await  dareq-sz  aqu-sz  %util
# nvme0n1        2847.00 364416.00     0.00   0.00    0.09   128.00  3921.00 502208.00     0.00   0.00    0.15   128.00  0.00    0.00     0.00   0.00     0.00      0.00    0.96  85.50

# Latency distribution (requires blktrace/blkparse or eBPF)
biolatency -D 1 10  # From bcc-tools

# Queue depth utilization
cat /sys/block/nvme0n1/queue/nr_requests

# Current I/O scheduler
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# Identify hardware type
lsblk -d -o name,rota,type,size,model
# ROTA=0 means SSD/NVMe, ROTA=1 means spinning disk
```

### fio Benchmark Suite

Before any tuning, run a representative fio benchmark:

```bash
# Install fio
apt-get install fio  # Debian/Ubuntu
dnf install fio      # RHEL/Fedora

# Random read IOPS (database-like workload)
fio --name=randread \
    --ioengine=libaio \
    --iodepth=64 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=4G \
    --numjobs=4 \
    --runtime=60 \
    --group_reporting \
    --filename=/dev/nvme0n1

# Sequential read throughput (streaming workload)
fio --name=seqread \
    --ioengine=libaio \
    --iodepth=8 \
    --rw=read \
    --bs=128k \
    --direct=1 \
    --size=4G \
    --numjobs=1 \
    --runtime=60 \
    --group_reporting \
    --filename=/dev/nvme0n1

# Mixed 70/30 read/write (realistic database)
fio --name=mixed \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4k \
    --direct=1 \
    --size=4G \
    --numjobs=4 \
    --runtime=60 \
    --group_reporting \
    --filename=/dev/nvme0n1
```

## I/O Schedulers

Linux 5.x uses the multi-queue block layer (blk-mq) exclusively. Available schedulers:

### none (No-op)

Best for: NVMe SSDs with hardware queues, cloud storage with low-latency underlying storage.

```
How it works: Requests go directly to the hardware queue with no software reordering.
When to use: When the device's internal firmware handles scheduling better than the kernel.
When to avoid: Slow devices where software merging provides significant benefit.
```

### mq-deadline

Best for: SSDs in general, mixed read/write workloads, any device where latency guarantees matter.

```
How it works: Maintains read and write deadline queues. Requests approaching their deadline
are promoted to prevent starvation. Attempts to merge adjacent requests before submission.
When to use: Most SSD workloads. The default for most SSDs on modern kernels.
When to avoid: Pure NVMe workloads where hardware queues are superior (use none).
```

### bfq (Budget Fair Queuing)

Best for: Multi-application workloads on desktop/laptop systems where interactive I/O should not be starved by batch workloads.

```
How it works: Tracks per-process I/O budgets and provides fair scheduling between applications.
Significantly reduces latency for interactive applications when competing with heavy I/O.
When to use: Desktop systems, CI/CD systems with mixed workloads, containers sharing a disk.
When to avoid: Dedicated database servers where you want maximum throughput for one workload.
Performance overhead: ~5-15% throughput reduction vs mq-deadline on pure throughput tests.
```

### kyber

Best for: High-speed NVMe arrays where latency targets need to be specified explicitly.

```
How it works: Token-bucket rate limiter with separate target latencies for read and sync writes.
When to use: When you have hard latency requirements and NVMe hardware that can meet them.
```

### Choosing and Setting the Scheduler

```bash
# Check current scheduler for all block devices
for dev in /sys/block/*/queue/scheduler; do
    echo "$(basename $(dirname $(dirname $dev))): $(cat $dev)"
done

# Set scheduler for a specific device
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
echo none > /sys/block/nvme0n2/queue/scheduler  # Raw NVMe, no scheduler

# Persistent via udev rule
cat > /etc/udev/rules.d/60-io-scheduler.rules <<'EOF'
# NVMe drives: no scheduler (let hardware handle it)
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"

# SATA SSDs: mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"

# HDDs: mq-deadline with read-ahead tuning
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
EOF

udevadm control --reload-rules
udevadm trigger --type=devices --action=change
```

### mq-deadline Tuning Parameters

```bash
# Read and write deadline in milliseconds
# Default: read_expire=500ms, write_expire=5000ms
echo 200 > /sys/block/sda/queue/iosched/read_expire
echo 1000 > /sys/block/sda/queue/iosched/write_expire

# Number of requests to batch process before switching from writes to reads
echo 8 > /sys/block/sda/queue/iosched/writes_starved

# Front merging: merge requests at the front of the queue
echo 1 > /sys/block/sda/queue/iosched/front_merges

# Fifo batch: number of requests to serve from FIFO queue in one go
echo 16 > /sys/block/sda/queue/iosched/fifo_batch
```

## Block Device Queue Tuning

### Queue Depth (nr_requests)

```bash
# View current queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# 2048 (default for NVMe)

cat /sys/block/sda/queue/nr_requests
# 128 (default for SATA)

# NVMe queue depth is typically hardware-limited and high by default.
# For HDDs, tuning nr_requests above physical seek capability provides no benefit.

# For SSD-backed databases with high concurrency:
echo 512 > /sys/block/nvme0n1/queue/nr_requests

# For spinning disks with sequential workloads:
echo 32 > /sys/block/sda/queue/nr_requests
```

### I/O Merging

```bash
# View merge statistics
cat /sys/block/nvme0n1/queue/nomerges
# 0 = all merges enabled (default)
# 1 = only same-process merges
# 2 = no merges

# For workloads with highly random I/O (e.g., databases with O_DIRECT),
# merging adds overhead without benefit — disable it:
echo 2 > /sys/block/nvme0n1/queue/nomerges

# For sequential workloads (streaming, video), merging is beneficial:
echo 0 > /sys/block/nvme0n1/queue/nomerges
```

### Maximum Segment Size and Queue Limits

```bash
# View limits
cat /sys/block/nvme0n1/queue/max_sectors_kb
# 2048

cat /sys/block/nvme0n1/queue/max_hw_sectors_kb
# 2147483647 (NVMe hardware limit)

# For high-throughput sequential workloads, increase max_sectors_kb
# up to max_hw_sectors_kb:
echo 1024 > /sys/block/nvme0n1/queue/max_sectors_kb

# View and tune logical block size
cat /sys/block/nvme0n1/queue/logical_block_size
# 512

cat /sys/block/nvme0n1/queue/physical_block_size
# 512
```

## NVMe-Specific Optimizations

### NVMe Queue Configuration

NVMe devices support multiple hardware submission/completion queues. The kernel maps CPU cores to queues:

```bash
# Check how many hardware queues the NVMe device supports
cat /sys/block/nvme0n1/device/num_queues
# 32

# Check current queue configuration
ls /sys/class/nvme/nvme0/
# Check interrupt affinity
cat /proc/interrupts | grep nvme

# Verify multi-queue is in use
cat /sys/block/nvme0n1/queue/nr_hw_queues
# Should equal num CPUs or num_queues, whichever is smaller
```

### NVMe Power State (Latency Hint)

NVMe devices have power states that affect latency. In production, prevent power state transitions:

```bash
# Check current power management policy
cat /sys/block/nvme0n1/device/power/control
# auto (may cause latency spikes on first access after idle)

# Disable runtime power management (prevents latency spikes)
echo performance > /sys/block/nvme0n1/device/power/control

# Or more specifically for NVMe power state
# Check available power states
nvme id-ctrl /dev/nvme0 | grep -A20 "ps "

# Set minimum operational power state to avoid power gating
# (0 = highest performance, higher = more power saving)
nvme set-feature /dev/nvme0 -f 2 -v 0  # Feature 2 = Power Management
```

### NVMe Namespace Optimization

NVMe supports multiple namespaces on a single controller. Use separate namespaces for isolation:

```bash
# List existing namespaces
nvme list-ns /dev/nvme0

# Create a new namespace (requires controller to support namespace management)
nvme create-ns /dev/nvme0 \
  --nsze=<size-in-sectors> \
  --ncap=<capacity-in-sectors> \
  --flbas=0 \
  --dps=0

# Attach namespace to controller
nvme attach-ns /dev/nvme0 -n <ns-id> -c <ctrl-id>
```

### NVMe I/O Polling (Busy-Wait)

For ultra-low latency workloads, NVMe supports I/O completion polling instead of interrupts:

```bash
# Check if polling is available
cat /sys/block/nvme0n1/queue/io_poll
# 0 = disabled, 1 = enabled

# Enable polling (only beneficial for very low queue depths and ultra-low latency)
echo 1 > /sys/block/nvme0n1/queue/io_poll

# Set polling delay (0 = immediate, higher = yield more)
echo 0 > /sys/block/nvme0n1/queue/io_poll_delay

# Note: polling consumes a CPU core spinning on completions.
# Only use when the workload can afford a dedicated CPU for I/O.
```

### SPDK (Storage Performance Development Kit)

For maximum NVMe performance, SPDK bypasses the kernel entirely using userspace drivers. This is an advanced topic for dedicated storage appliances or high-frequency databases:

```bash
# Install SPDK (abbreviated - see full SPDK documentation)
git clone https://github.com/spdk/spdk.git
cd spdk && scripts/pkgdep.sh
./configure --with-rdma
make

# Bind NVMe device to userspace driver
scripts/setup.sh
```

## Read-Ahead Tuning

The kernel prefetches data beyond what was requested. Appropriate for streaming, harmful for random access:

```bash
# View current read-ahead (in KB)
blockdev --getra /dev/nvme0n1
# 512 (256 pages * 2KB = 512KB default)

# For database workloads with random access patterns: disable read-ahead
blockdev --setra 0 /dev/nvme0n1

# For streaming workloads: increase read-ahead aggressively
blockdev --setra 16384 /dev/nvme0n1  # 8MB

# For general mixed workloads: moderate value
blockdev --setra 2048 /dev/nvme0n1  # 1MB

# Persistent via udev rule
cat >> /etc/udev/rules.d/60-io-scheduler.rules <<'EOF'
# Databases: no read-ahead
ACTION=="add|change", KERNEL=="nvme0n1", RUN+="/sbin/blockdev --setra 0 /dev/nvme0n1"
EOF
```

## Dirty Page Writeback Tuning

The kernel's writeback daemon controls when dirty pages are flushed to disk. Incorrect tuning causes write bursts:

```bash
# Current dirty page settings
sysctl vm.dirty_ratio
# 20  -- start writing when 20% of RAM is dirty (emergency flush)

sysctl vm.dirty_background_ratio
# 10  -- start background writeback at 10% of RAM

sysctl vm.dirty_writeback_centisecs
# 500  -- background flusher runs every 5 seconds

sysctl vm.dirty_expire_centisecs
# 3000  -- dirty pages older than 30s are eligible for writeback

# For database servers with lots of RAM:
# Reduce ratios to prevent large write bursts
sysctl -w vm.dirty_ratio=5
sysctl -w vm.dirty_background_ratio=2

# For write-intensive workloads (Kafka log segments, etc.):
# Use absolute byte limits instead of percentage
sysctl -w vm.dirty_bytes=536870912           # 512MB emergency threshold
sysctl -w vm.dirty_background_bytes=134217728 # 128MB background threshold

# More frequent flushing (reduces burst size)
sysctl -w vm.dirty_writeback_centisecs=100   # Every 1 second
sysctl -w vm.dirty_expire_centisecs=1000     # Expire after 10 seconds

# Persist via /etc/sysctl.d/
cat > /etc/sysctl.d/60-storage-tuning.conf <<'EOF'
# Storage performance tuning
vm.dirty_bytes = 536870912
vm.dirty_background_bytes = 134217728
vm.dirty_writeback_centisecs = 100
vm.dirty_expire_centisecs = 1000
vm.swappiness = 1
EOF

sysctl -p /etc/sysctl.d/60-storage-tuning.conf
```

## File System Optimization

### XFS for High-Performance Workloads

XFS is generally preferred for high-throughput workloads on modern Linux systems:

```bash
# Create XFS with optimal settings for NVMe
# -f: force overwrite
# -s size=4096: 4K sector size
# -d su=128k,sw=1: stripe unit 128K, stripe width 1 (no RAID)
# -l su=128k: log stripe unit
mkfs.xfs \
  -f \
  -s size=4096 \
  -d su=131072,sw=1 \
  -l su=131072 \
  /dev/nvme0n1p1

# Mount with performance options
mount -o noatime,nodiratime,logbufs=8,logbsize=256k,largeio,inode64 \
  /dev/nvme0n1p1 /data

# /etc/fstab entry:
# /dev/nvme0n1p1 /data xfs noatime,nodiratime,logbufs=8,logbsize=256k,largeio,inode64 0 2
```

### ext4 Tuning

```bash
# Create ext4 with 4K block size and lazy inode tables
mkfs.ext4 \
  -b 4096 \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  -O extent,uninit_bg,dir_index,has_journal \
  /dev/sda1

# Mount with performance options
mount -o noatime,data=writeback,barrier=0,nobh \
  /dev/sda1 /data

# Note: barrier=0 disables write barriers — only safe with BBU or
# when data corruption on power loss is acceptable (e.g., ephemeral storage)
```

### PostgreSQL-Specific Alignment

For PostgreSQL, align the file system to match the database page size:

```bash
# PostgreSQL default page size is 8KB
# XFS optimal configuration:
mkfs.xfs \
  -f \
  -b size=8192 \  # Match PostgreSQL page size
  -s size=512 \
  /dev/nvme0n1p1

# Verify alignment
parted /dev/nvme0n1 align-check optimal 1
```

## NUMA Awareness

On multi-socket systems, ensure storage I/O processing happens on the same NUMA node as the device:

```bash
# Check NUMA topology for NVMe devices
lstopo --no-io
cat /sys/block/nvme0n1/device/numa_node
# 0 = NUMA node 0

# Set IRQ affinity to keep NVMe interrupts on the same NUMA node
# Find the IRQ for nvme0
grep nvme /proc/interrupts | awk '{print $1}' | tr -d ':'

# Pin IRQs to CPUs on NUMA node 0 (CPUs 0-15 in this example)
for irq in $(grep nvme0 /proc/interrupts | awk '{print $1}' | tr -d ':'); do
    echo "0000ffff" > /proc/irq/${irq}/smp_affinity  # CPUs 0-15
done

# Use numactl to bind database processes to the same NUMA node
numactl --cpunodebind=0 --membind=0 postgres -D /data/postgresql
```

## CPU Frequency Governor

Storage latency is also affected by CPU clock speed — idle CPUs in power-saving states add latency:

```bash
# View current governor
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# Set to performance for latency-sensitive workloads
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Or use cpupower
cpupower frequency-set -g performance

# Disable CPU C-states (deep sleep) for ultra-low latency
# C0 = active, C1 = halt, C2+ = deeper sleep states
for cpu_state in /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq; do
    cpu=$(echo $cpu_state | sed 's|/cpufreq/cpuinfo_max_freq||')
    echo 1 > ${cpu}/cpuidle/state2/disable  # Disable C2
    echo 1 > ${cpu}/cpuidle/state3/disable  # Disable C3
done
```

## Persistent Tuning with systemd

Create a systemd service to apply tuning on boot:

```bash
# /usr/local/bin/tune-storage.sh
cat > /usr/local/bin/tune-storage.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail

logger "Applying storage performance tuning"

# I/O scheduler
for nvme in /sys/block/nvme*; do
    echo none > ${nvme}/queue/scheduler
    echo 2 > ${nvme}/queue/nomerges
    echo 0 > ${nvme}/device/power/control 2>/dev/null || true
done

for ssd in $(lsblk -dno NAME,ROTA | awk '$2==0 && $1!~/nvme/ {print $1}'); do
    echo mq-deadline > /sys/block/${ssd}/queue/scheduler
    echo 1 > /sys/block/${ssd}/queue/nomerges
done

# Queue depths
for nvme in /sys/block/nvme*; do
    echo 1024 > ${nvme}/queue/nr_requests
    echo 1024 > ${nvme}/queue/max_sectors_kb
done

# Read-ahead (disabled for databases)
for nvme in /sys/block/nvme*; do
    blockdev --setra 0 /dev/${nvme##*/}
done

# NVMe performance power state
for nvme_dev in /dev/nvme*; do
    [ -c "${nvme_dev}" ] || continue
    nvme set-feature ${nvme_dev} -f 2 -v 0 2>/dev/null || true
done

logger "Storage performance tuning applied"
SCRIPT

chmod +x /usr/local/bin/tune-storage.sh

# /etc/systemd/system/storage-tuning.service
cat > /etc/systemd/system/storage-tuning.service <<'UNIT'
[Unit]
Description=Storage Performance Tuning
After=local-fs.target
DefaultDependencies=no

[Service]
Type=oneshot
ExecStart=/usr/local/bin/tune-storage.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable storage-tuning.service
```

## Production Tuning Profiles

### Profile: PostgreSQL on NVMe

```bash
# Scheduler
echo none > /sys/block/nvme0n1/queue/scheduler
# Queue
echo 256 > /sys/block/nvme0n1/queue/nr_requests
# No merging (O_DIRECT writes)
echo 2 > /sys/block/nvme0n1/queue/nomerges
# No read-ahead
blockdev --setra 0 /dev/nvme0n1
# Power state
echo performance > /sys/block/nvme0n1/device/power/control
# Dirty pages
sysctl -w vm.dirty_bytes=536870912
sysctl -w vm.dirty_background_bytes=134217728
```

### Profile: Kafka on NVMe (Sequential Append)

```bash
# Scheduler
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
# Merging enabled (sequential appends benefit from merging)
echo 0 > /sys/block/nvme0n1/queue/nomerges
# Generous read-ahead for consumer replay
blockdev --setra 8192 /dev/nvme0n1
# Larger dirty page threshold (write-heavy batch workload)
sysctl -w vm.dirty_bytes=2147483648    # 2GB
sysctl -w vm.dirty_background_bytes=1073741824  # 1GB
sysctl -w vm.dirty_writeback_centisecs=500
```

### Profile: Object Storage (HDD Array)

```bash
# Scheduler with read prioritization
echo mq-deadline > /sys/block/sda/queue/scheduler
echo 200 > /sys/block/sda/queue/iosched/read_expire
echo 2000 > /sys/block/sda/queue/iosched/write_expire
# Queue depth matching physical seek parallelism
echo 64 > /sys/block/sda/queue/nr_requests
# Generous read-ahead for sequential streaming
blockdev --setra 4096 /dev/sda
```

## Monitoring with Prometheus

```yaml
# node-exporter will expose most disk metrics automatically
# Additional custom alerts:

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: storage-performance-alerts
  namespace: monitoring
spec:
  groups:
    - name: storage
      rules:
        - alert: HighDiskIOUtilization
          expr: |
            rate(node_disk_io_time_seconds_total[5m]) > 0.9
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High disk I/O utilization on {{ $labels.device }}"
            description: "Device {{ $labels.device }} on {{ $labels.instance }} is {{ $value | humanizePercentage }} utilized."

        - alert: HighDiskReadLatency
          expr: |
            rate(node_disk_read_time_seconds_total[5m])
            / rate(node_disk_reads_completed_total[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High read latency on {{ $labels.device }}"
            description: "Average read latency is {{ $value | humanizeDuration }}."

        - alert: HighDiskWriteLatency
          expr: |
            rate(node_disk_write_time_seconds_total[5m])
            / rate(node_disk_writes_completed_total[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High write latency on {{ $labels.device }}"

        - alert: LargeIOQueue
          expr: |
            node_disk_io_now > 100
          for: 2m
          labels:
            severity: info
          annotations:
            summary: "Large I/O queue on {{ $labels.device }}"
```

## Summary

Linux storage performance tuning requires matching the optimization profile to both the hardware capabilities and the workload characteristics:

- **NVMe drives** benefit from the `none` scheduler, disabled merging for random I/O, and polling for ultra-low latency — but the hardware queues are already sophisticated enough that software overhead is the main enemy
- **SSDs and cloud volumes** benefit from `mq-deadline` with tuned read/write expire times
- **Spinning disks** have fundamentally different access patterns; seek time optimization matters more than queue depth
- **Dirty page writeback** tuning prevents write bursts that cause latency spikes — absolute byte limits are more predictable than percentage-based limits on large-memory systems
- **NUMA affinity** is critical on multi-socket systems where cross-socket memory access adds latency to every I/O operation

Always benchmark with fio before and after each change, and monitor production metrics to verify that lab benchmarks translate to real-world improvements.
