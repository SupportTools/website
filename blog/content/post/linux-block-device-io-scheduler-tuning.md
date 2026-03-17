---
title: "Linux Block Device I/O Scheduler Tuning: none, mq-deadline, bfq"
date: 2029-06-03T00:00:00-05:00
draft: false
tags: ["Linux", "I/O Scheduler", "Performance", "NVMe", "SSD", "Block Device", "Kernel"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux block device I/O scheduler selection and tuning: comparing none, mq-deadline, and bfq schedulers, queue depth tuning for rotational vs SSD/NVMe devices, blktrace analysis, and fio benchmarking for production workloads."
more_link: "yes"
url: "/linux-block-device-io-scheduler-tuning/"
---

The Linux block I/O layer sits between the filesystem and the hardware driver. Its primary job is to decide the order in which I/O requests reach the disk — a decision that dramatically affects throughput, latency, and fairness. Modern NVMe SSDs with 64+ parallel queues need almost no scheduler intervention, while HDDs and some shared cloud block devices benefit significantly from intelligent request merging and deadline guarantees. This guide covers the three schedulers available in the multi-queue block layer: `none`, `mq-deadline`, and `bfq`, with practical tuning recommendations and benchmark methodology.

<!--more-->

# Linux Block Device I/O Scheduler Tuning: none, mq-deadline, bfq

## The Block Layer Architecture

Linux's block I/O layer has undergone significant changes since kernel 3.13, when the multi-queue (blk-mq) architecture replaced the single-queue legacy layer. All modern kernels (5.x+) use blk-mq exclusively. The scheduler sits above the hardware dispatch queues and reorders requests before submission.

```
Application
    |
VFS (Virtual File System)
    |
Page Cache
    |
Block Layer (bio submission)
    |
I/O Scheduler (mq-deadline, bfq, none)
    |
Device Driver Dispatch Queues (hardware queues)
    |
NVMe / SCSI / SATA Controller
    |
Physical Storage
```

The number of hardware dispatch queues determines how much parallelism the scheduler can exploit:
- NVMe SSD: 1-128 hardware queues (typically matches CPU count)
- SATA SSD: 1-32 hardware queues
- SATA HDD: 1-2 hardware queues
- virtio-blk (cloud VMs): 1-8 hardware queues

## The Three Multi-Queue Schedulers

### none (no-op)

The `none` scheduler is not actually a no-op — it is a passthrough that submits requests to the hardware in the order they arrive, with request merging at the plug/unplug level. It provides:

- Lowest overhead: no sorting, minimal CPU usage
- Best for devices with their own internal queue management (NVMe)
- Highest throughput for purely sequential workloads
- No fairness guarantees between processes
- No latency guarantees

Best suited for: NVMe SSDs in single-tenant environments, high-performance databases, workloads where the storage device's own queue management is sufficient.

### mq-deadline

The `mq-deadline` scheduler adds two features over `none`:

1. **Deadline enforcement**: Requests older than the deadline threshold are promoted to the front of the queue, preventing starvation
2. **Request sorting**: Read requests are sorted by sector address to improve seek locality (primarily useful for HDDs)

Parameters:
- `read_expire` (default 500ms): deadline for read requests
- `write_expire` (default 5000ms): deadline for write requests
- `writes_starved` (default 2): number of read batches before allowing write batches
- `front_merges` (default 1): enable front merges for adjacent sequential requests

Best suited for: SSDs in multi-tenant environments where latency fairness matters, HDDs, cloud block devices with high baseline latency.

### bfq (Budget Fair Queueing)

BFQ is the most sophisticated scheduler. It assigns each process a "budget" of I/O sectors to service, proportional to its weight. When a process exhausts its budget, another process gets a turn. This provides:

- Per-process I/O bandwidth proportionality
- Latency guarantees for interactive and latency-sensitive processes
- Configurable weights via cgroups
- Overhead: higher CPU usage, lower peak throughput

Parameters:
- `slice_idle` (default 8ms): time to wait for a process's next I/O before serving another
- `max_budget` (default auto): maximum sectors per process timeslice
- `low_latency` (default 1): prioritize latency for interactive applications
- `timeout_sync` (default 125ms): I/O budget timeout for sync processes
- `timeout_async` (default 250ms): I/O budget timeout for async processes
- `strict_guarantees` (default 0): enable strict bandwidth guarantees (higher overhead)

Best suited for: desktop systems, systems with mixed workloads where interactive responsiveness matters, HDDs, multi-tenant databases with I/O QoS requirements.

## Checking and Setting the Current Scheduler

```bash
# Check the current scheduler for all block devices
for dev in /sys/block/*/queue/scheduler; do
    echo "$dev: $(cat $dev)"
done

# Example output:
# /sys/block/nvme0n1/queue/scheduler: none [mq-deadline] bfq
# /sys/block/sda/queue/scheduler: [mq-deadline] none bfq
# The scheduler in brackets is currently active

# Set scheduler for a specific device (takes effect immediately)
echo mq-deadline > /sys/block/sda/queue/scheduler
echo none > /sys/block/nvme0n1/queue/scheduler
echo bfq > /sys/block/sdb/queue/scheduler

# Verify
cat /sys/block/sda/queue/scheduler
# [mq-deadline] none bfq

# Check what schedulers are compiled in
cat /sys/block/sda/queue/scheduler
# Lists available schedulers in brackets/parentheses

# Kernel modules for schedulers (if not compiled in)
modprobe bfq
modprobe mq-deadline
```

### Making Scheduler Changes Persistent

```bash
# Method 1: udev rules (recommended for device-specific settings)
# /etc/udev/rules.d/60-scheduler.rules

# NVMe devices — use none
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"

# SATA SSDs — use mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", \
  ATTR{queue/scheduler}="mq-deadline"

# HDDs — use bfq for desktops, mq-deadline for servers
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", \
  ATTR{queue/scheduler}="bfq"

# Apply without reboot
udevadm control --reload-rules
udevadm trigger --type=devices --attr-match=subsystem=block

# Method 2: systemd-udev with device model matching
# /etc/udev/rules.d/61-scheduler-model.rules
ACTION=="add|change", KERNEL=="sd[a-z]", \
  ATTR{device/model}=="Samsung SSD*", \
  ATTR{queue/scheduler}="mq-deadline"

# Method 3: kernel command line (applies to all block devices at boot)
# In /etc/default/grub:
GRUB_CMDLINE_LINUX="elevator=mq-deadline"
# Then: update-grub (Debian/Ubuntu) or grub2-mkconfig (RHEL/Fedora)
```

## Queue Depth Tuning

Queue depth (also called `nr_requests`) controls how many I/O requests can be outstanding at once. Higher queue depth increases throughput for high-latency devices but increases latency variance.

```bash
# Check current queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# NVMe default: 1023 or 2047

cat /sys/block/sda/queue/nr_requests
# HDD default: 128

# Check hardware queue count
cat /sys/block/nvme0n1/queue/nr_hw_queues
# NVMe: typically 16-32 (one per CPU or per NVMe queue)
cat /sys/block/sda/queue/nr_hw_queues
# HDD: 1

# Tune queue depth for database workload (NVMe)
echo 256 > /sys/block/nvme0n1/queue/nr_requests

# For HDDs with mq-deadline, lower queue depth reduces latency tail
echo 32 > /sys/block/sda/queue/nr_requests

# Check read-ahead (prefetch) setting
cat /sys/block/sda/queue/read_ahead_kb
# Default: 128 KB

# For databases with random I/O: reduce read-ahead
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb
echo 16 > /sys/block/sda/queue/read_ahead_kb

# For sequential workloads (backup, streaming): increase read-ahead
echo 4096 > /sys/block/sda/queue/read_ahead_kb
```

### NVMe-Specific Tuning

```bash
# NVMe queue depth per hardware queue
# Modern NVMe supports up to 64K commands per queue
cat /sys/block/nvme0n1/queue/nr_requests

# Check NVMe controller queue count
cat /sys/class/nvme/nvme0/queue_count

# For NVMe with PCIe 4.0 or 5.0, increase queue depth
echo 4096 > /sys/block/nvme0n1/queue/nr_requests

# NVMe power management — disable power saving for servers
cat /sys/class/nvme/nvme0/power_state
# 0 = full power, higher = power saving modes
echo 0 > /sys/class/nvme/nvme0/power_state

# Latency performance hint (kernel 5.x+)
# 0 = no hint, 1 = low latency
cat /sys/block/nvme0n1/queue/io_poll
echo 1 > /sys/block/nvme0n1/queue/io_poll  # polling mode for ultra-low latency

# io_poll_delay: microseconds between polls (0 = spin constantly)
echo 0 > /sys/block/nvme0n1/queue/io_poll_delay
```

### mq-deadline Parameter Tuning

```bash
# View all mq-deadline parameters for a device
ls /sys/block/sda/queue/iosched/
# deadline_expire  fifo_batch  front_merges  read_expire  write_expire  writes_starved

# Read these values
cat /sys/block/sda/queue/iosched/read_expire   # default: 500 (ms)
cat /sys/block/sda/queue/iosched/write_expire  # default: 5000 (ms)
cat /sys/block/sda/queue/iosched/writes_starved # default: 2
cat /sys/block/sda/queue/iosched/fifo_batch    # default: 16

# Tune for database read latency (reduce read expire to 100ms)
echo 100 > /sys/block/sda/queue/iosched/read_expire
echo 1000 > /sys/block/sda/queue/iosched/write_expire
echo 4 > /sys/block/sda/queue/iosched/fifo_batch

# Tune for backup/bulk write throughput (increase write batch size)
echo 500 > /sys/block/sda/queue/iosched/read_expire
echo 10000 > /sys/block/sda/queue/iosched/write_expire
echo 1 > /sys/block/sda/queue/iosched/writes_starved
echo 64 > /sys/block/sda/queue/iosched/fifo_batch
```

### BFQ Parameter Tuning

```bash
# View all BFQ parameters
ls /sys/block/sda/queue/iosched/
# back_seek_max  back_seek_penalty  fifo_expire_async  fifo_expire_sync
# low_latency  max_budget  slice_idle  strict_guarantees  timeout_async  timeout_sync

cat /sys/block/sda/queue/iosched/slice_idle    # default: 8 (ms)
cat /sys/block/sda/queue/iosched/low_latency   # default: 1 (enabled)
cat /sys/block/sda/queue/iosched/max_budget    # default: auto (-1)

# Tune BFQ for database (disable low_latency for throughput)
echo 0 > /sys/block/sda/queue/iosched/low_latency
echo 0 > /sys/block/sda/queue/iosched/slice_idle  # no idling

# Tune BFQ for desktop/interactive (enable low_latency)
echo 1 > /sys/block/sda/queue/iosched/low_latency
echo 8 > /sys/block/sda/queue/iosched/slice_idle

# BFQ with cgroup I/O weight
# Set I/O weight for a cgroup (100 = default, range 1-1000)
echo "8:0 200" > /sys/fs/cgroup/blkio/high-priority/blkio.bfq.weight_device
echo "100" > /sys/fs/cgroup/blkio/low-priority/blkio.bfq.weight
```

## blktrace Analysis

`blktrace` captures kernel block I/O events and `blkparse` analyzes them. This is the most powerful tool for understanding actual I/O patterns.

```bash
# Capture I/O trace for 10 seconds
blktrace -d /dev/sda -o trace -w 10

# Parse the trace
blkparse -i trace -o trace.txt

# The output shows each I/O event with:
# Device  CPU  Sequence  Timestamp  PID  Action  RWBS  Sector+Size  Process
# 8,0     0    1         0.000000   123  Q       R     12345+8      postgres

# Action codes:
# Q: I/O request queued
# G: I/O request get (allocated)
# I: I/O request inserted into the queue
# D: I/O dispatched to driver
# C: I/O completed
# M: I/O merge with an existing request

# Calculate latency statistics
blkparse -i trace -q -f "%T %n %a %D %d %C\n" 2>/dev/null | \
  awk '
    $3=="D" { dispatch[$4]=$1 }
    $3=="C" { if (dispatch[$4]) { lat=($1-dispatch[$4])*1000; print lat; delete dispatch[$4] } }
  ' | sort -n | \
  awk '
    BEGIN { n=0; sum=0 }
    { a[n++]=$1; sum+=$1 }
    END {
      printf "count: %d\n", n
      printf "avg: %.3f ms\n", sum/n
      printf "p50: %.3f ms\n", a[int(n*0.50)]
      printf "p95: %.3f ms\n", a[int(n*0.95)]
      printf "p99: %.3f ms\n", a[int(n*0.99)]
      printf "p999: %.3f ms\n", a[int(n*0.999)]
    }
  '

# btt: I/O time breakdown analysis
blkparse -i trace -o /dev/null
btt -i trace.blktrace.0
# Shows Q2C (queue to completion), D2C (dispatch to completion), Q2D (queue to dispatch)
# Q2D = scheduler overhead
# D2C = device service time
# Q2C = total latency

# Visualize I/O patterns with iowatcher
iowatcher -t trace -o io-report.html
```

### blktrace One-Liner Examples

```bash
# Real-time I/O event stream (requires root)
blktrace -d /dev/nvme0n1 -o - | blkparse -i -

# Find which processes are generating most I/O
blktrace -d /dev/sda -o trace -w 30
blkparse -i trace -q -f "%C\n" | sort | uniq -c | sort -rn | head -20

# Measure average I/O size
blkparse -i trace -q -f "%n\n" 2>/dev/null | \
  awk '{sum+=$1; n++} END {printf "avg I/O size: %d bytes\n", sum/n*512}'

# Check read vs write ratio
blkparse -i trace -q -f "%a %n\n" 2>/dev/null | \
  awk '
    $1=="D" { reads++ }
    $1=="W" { writes++ }
    END { printf "reads: %d, writes: %d, ratio: %.1f%%\n", reads, writes, reads/(reads+writes)*100 }
  '

# Find sequential vs random I/O ratio
blkparse -i trace -q -f "%S\n" 2>/dev/null | sort -n > sectors.txt
awk 'NR>1 {diff=$1-prev; if(diff<0) diff=-diff; print diff} {prev=$1}' sectors.txt | \
  awk '{if($1<=8) seq++; else rand++} END {printf "sequential: %d, random: %d\n", seq, rand}'
```

## fio Benchmarking

`fio` (Flexible I/O Tester) is the standard tool for measuring block device performance under controlled conditions.

### Basic Scheduler Comparison

```bash
#!/bin/bash
# scheduler-bench.sh — compare schedulers for different workloads

DEVICE="/dev/nvme0n1"
RESULTS_DIR="/tmp/scheduler-bench"
mkdir -p "$RESULTS_DIR"

SCHEDULERS=("none" "mq-deadline" "bfq")
WORKLOADS=("randread" "randwrite" "seqread" "seqwrite" "randrw")

for scheduler in "${SCHEDULERS[@]}"; do
    echo "Setting scheduler: $scheduler"
    echo "$scheduler" > /sys/block/$(basename $DEVICE)/queue/scheduler

    for workload in "${WORKLOADS[@]}"; do
        echo "Testing: $scheduler + $workload"
        fio \
            --name="${scheduler}-${workload}" \
            --filename="${DEVICE}" \
            --direct=1 \
            --bs=4k \
            --ioengine=libaio \
            --iodepth=32 \
            --rw="${workload}" \
            --rwmixread=70 \
            --size=10G \
            --runtime=60 \
            --time_based \
            --output-format=json \
            --output="${RESULTS_DIR}/${scheduler}-${workload}.json" \
            2>/dev/null

        # Extract key metrics
        iops=$(jq '.jobs[0].read.iops + .jobs[0].write.iops' \
            "${RESULTS_DIR}/${scheduler}-${workload}.json")
        p99_lat=$(jq '.jobs[0].read.clat_ns.percentile."99.000000" //
            .jobs[0].write.clat_ns.percentile."99.000000"' \
            "${RESULTS_DIR}/${scheduler}-${workload}.json")
        printf "%-12s %-12s IOPS: %-8.0f p99: %.2f ms\n" \
            "$scheduler" "$workload" "$iops" "$(echo "scale=3; $p99_lat/1000000" | bc)"
    done
done
```

### Database Workload Simulation

```ini
# db-mixed.fio — simulate OLTP database I/O pattern
[global]
ioengine=libaio
direct=1
runtime=120
time_based=1
filename=/dev/nvme0n1
group_reporting=1

# Simulate PostgreSQL random reads (select queries)
[pg-reads]
rw=randread
bs=8k
iodepth=64
numjobs=4
rate_iops=5000

# Simulate PostgreSQL sequential writes (WAL)
[pg-wal]
rw=write
bs=64k
iodepth=4
numjobs=1
offset=50G

# Simulate checkpoint writes (bulk page writes)
[pg-checkpoint]
rw=randwrite
bs=8k
iodepth=32
numjobs=2
thinktime=100ms
```

```bash
# Run the database simulation
fio db-mixed.fio --output=results.json --output-format=json

# Parse results
jq '.jobs[] | {name: .jobname, iops: (.read.iops + .write.iops),
  lat_p99: ((.read.clat_ns.percentile."99.000000" // 0) +
            (.write.clat_ns.percentile."99.000000" // 0)) / 1000000}' results.json
```

### Latency Percentile Comparison Script

```bash
#!/bin/bash
# latency-test.sh — measure read latency at different queue depths

DEVICE="/dev/nvme0n1"
SCHEDULER=$1  # Pass as argument

echo "$SCHEDULER" > /sys/block/$(basename $DEVICE)/queue/scheduler
echo "Testing $SCHEDULER scheduler"
echo "QD | p50(µs) | p95(µs) | p99(µs) | p999(µs) | IOPS"
echo "---|---------|---------|---------|----------|-----"

for qd in 1 2 4 8 16 32 64 128; do
    result=$(fio \
        --name=lat-test \
        --filename="$DEVICE" \
        --direct=1 \
        --bs=4k \
        --ioengine=libaio \
        --iodepth="$qd" \
        --rw=randread \
        --size=10G \
        --runtime=30 \
        --time_based \
        --output-format=json \
        2>/dev/null)

    p50=$(echo "$result" | jq '.jobs[0].read.clat_ns.percentile."50.000000"')
    p95=$(echo "$result" | jq '.jobs[0].read.clat_ns.percentile."95.000000"')
    p99=$(echo "$result" | jq '.jobs[0].read.clat_ns.percentile."99.000000"')
    p999=$(echo "$result" | jq '.jobs[0].read.clat_ns.percentile."99.900000"')
    iops=$(echo "$result" | jq '.jobs[0].read.iops')

    printf "%-3d| %-8.0f| %-8.0f| %-8.0f| %-9.0f| %.0f\n" \
        "$qd" \
        "$(echo "scale=0; $p50/1000" | bc)" \
        "$(echo "scale=0; $p95/1000" | bc)" \
        "$(echo "scale=0; $p99/1000" | bc)" \
        "$(echo "scale=0; $p999/1000" | bc)" \
        "$iops"
done
```

### Example fio Output Interpretation

```
# Sample output for NVMe SSD with none scheduler, randread 4K, QD=32:
# read: IOPS=450k, BW=1757MiB/s
#   clat (usec): min=80, max=2456, avg=70.91
#   lat percentiles (usec):
#    | 1.00th=[ 57], | 5.00th=[ 60], | 10.00th=[ 61]
#    | 20.00th=[ 63], | 30.00th=[ 65], | 40.00th=[ 67]
#    | 50.00th=[ 69], | 60.00th=[ 72], | 70.00th=[ 74]
#    | 80.00th=[ 77], | 90.00th=[ 82], | 95.00th=[ 87]
#    | 99.00th=[ 101], | 99.50th=[ 107], | 99.90th=[ 122]
#    | 99.99th=[ 165]
#
# Key metrics:
# - p50 latency: 69µs (typical for NVMe random read at QD=32)
# - p99 latency: 101µs (acceptable for database reads)
# - p999 latency: 122µs (very consistent, low tail latency)
# - IOPS: 450K (near device maximum for sequential random reads)
```

## Scheduler Selection Decision Tree

```
Is the device NVMe with multiple hardware queues (≥8)?
├── YES → Use 'none'
│   └── Exception: shared/multi-tenant NVMe → use 'mq-deadline'
└── NO
    Is it an SSD (rotational=0)?
    ├── YES
    │   Is it a cloud block device (virtio-blk, EBS, GCP PD)?
    │   ├── YES → Use 'mq-deadline' (high base latency benefits from deadline)
    │   └── NO → Use 'mq-deadline' or 'none' (benchmark to determine)
    └── NO (HDD rotational=1)
        Is it a server with database/single-purpose workload?
        ├── YES → Use 'mq-deadline' (simpler, lower overhead)
        └── NO (desktop/mixed interactive workload)
            └── Use 'bfq' (best interactive responsiveness)
```

## Monitoring I/O Scheduler Effectiveness

```bash
# Watch I/O queue depth in real time
watch -n 1 'cat /sys/block/sda/stat | awk "{print \"queue: \" \$9}"'

# iostat extended — key columns for scheduler evaluation
iostat -x 1 -d sda
# avgqu-sz: average queue size (higher = more parallelism but more latency)
# await: average wait time in ms (queue time + service time)
# svctm: service time in ms (just device time, not queue time) — deprecated
# %util: utilization

# Compare queue times under different schedulers using pidstat
pidstat -d 1 5  # per-process I/O stats

# Kernel I/O stats for detailed breakdown
cat /proc/diskstats
# Columns: major minor devname reads_completed reads_merged sectors_read
#          read_time writes_completed writes_merged sectors_written write_time
#          in_flight io_time weighted_io_time

# Calculate average I/O latency from /proc/diskstats
awk '{if($3=="sda") {reads=$4; read_ms=$7; writes=$8; write_ms=$11}
     sleep 1
     reads2=$4; read_ms2=$7; writes2=$8; write_ms2=$11
     printf "read_lat=%.2fms write_lat=%.2fms\n",
       (read_ms2-read_ms)/(reads2-reads+0.001),
       (write_ms2-write_ms)/(writes2-writes+0.001)}' /proc/diskstats
```

## Recommended Settings by Workload

### PostgreSQL / MySQL Database Server

```bash
# /etc/udev/rules.d/62-db-scheduler.rules

# NVMe (primary storage) — maximum throughput
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", \
  ATTR{queue/scheduler}="none", \
  ATTR{queue/nr_requests}="1023", \
  ATTR{queue/read_ahead_kb}="0"

# SATA SSD (WAL / binary logs) — low write latency
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", \
  ATTR{queue/scheduler}="mq-deadline"

# After setting scheduler, tune mq-deadline for DB
# read_expire=100ms for fast query response
# write_expire=2000ms for WAL writes
```

```bash
#!/bin/bash
# db-io-tuning.sh — apply after udev sets the scheduler

for dev in /sys/block/sd*/queue; do
    if [ "$(cat $dev/rotational)" = "0" ]; then
        # SSD with mq-deadline
        echo 100  > "$dev/iosched/read_expire"
        echo 2000 > "$dev/iosched/write_expire"
        echo 4    > "$dev/iosched/fifo_batch"
        echo 0    > "$dev/read_ahead_kb"
    fi
done

for dev in /sys/block/nvme*/queue; do
    # NVMe
    echo none > "$dev/scheduler"
    echo 0    > "$dev/read_ahead_kb"
    echo 1023 > "$dev/nr_requests"
done
```

### Kubernetes Worker Nodes

```bash
# /etc/udev/rules.d/63-k8s-scheduler.rules
# Container workloads need balanced latency and throughput

# NVMe (container storage) — none for maximum IOPS
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", \
  ATTR{queue/scheduler}="none"

# EBS/GCP PD volumes (cloud block devices)
ACTION=="add|change", KERNEL=="xvd[a-z]", \
  ATTR{queue/scheduler}="mq-deadline", \
  ATTR{queue/nr_requests}="256"

ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ENV{ID_VENDOR}=="Amazon", \
  ATTR{queue/scheduler}="mq-deadline"
```

## Summary

Linux block I/O scheduler selection is not one-size-fits-all. NVMe devices with many hardware queues benefit from `none` — the device's internal queue management is already optimal and scheduler overhead only hurts. HDDs and high-latency cloud block devices benefit from `mq-deadline`'s deadline enforcement, which prevents starvation under mixed read/write workloads. `bfq` is the right choice for desktop systems and multi-tenant environments requiring I/O fairness guarantees. Production database servers on NVMe should use `none` with high queue depths and disabled read-ahead; the same servers on SATA SSDs benefit from `mq-deadline` with reduced read expire. Always validate scheduler selection with `fio` benchmarks against your specific workload pattern — synthetic benchmarks often differ from production behavior.
