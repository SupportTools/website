---
title: "Linux I/O Performance: fio Benchmarking, iostat Analysis, and NVMe Tuning"
date: 2028-11-09T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "Performance", "NVMe", "fio"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux I/O performance: designing fio benchmarks for random and sequential workloads, interpreting iostat output, NVMe queue configuration with io_uring, I/O scheduler selection, read-ahead tuning, blkdiscard for SSD maintenance, and storage Prometheus alerts."
more_link: "yes"
url: "/linux-io-performance-fio-iostat-nvme-guide/"
---

Storage performance is often the hidden bottleneck in production systems. A database that appears CPU-bound might actually be I/O-bound at the block device level, with latency accumulating in the device queue. NVMe SSDs can deliver over 1 million IOPS and sub-100 microsecond latency — but only if the Linux I/O stack is configured correctly. Default kernel settings optimized for spinning disks leave NVMe drives running at a fraction of their capability.

This guide covers the complete I/O performance toolkit: fio for benchmark design, iostat for real-time analysis, I/O scheduler selection, NVMe-specific tuning with io_uring, and Prometheus alerting for storage degradation.

<!--more-->

# Linux I/O Performance: fio Benchmarking, iostat Analysis, and NVMe Tuning

## System Information Before Benchmarking

Always document your storage hardware before benchmarking:

```bash
# List block devices with their topology
lsblk -o NAME,SIZE,TYPE,ROTA,SCHED,PHY-SeC,LOG-SeC,MODEL,SERIAL

# ROTA=0 means non-rotational (SSD/NVMe)
# Example output:
# NAME        SIZE TYPE ROTA SCHED      PHY-SeC LOG-SeC MODEL               SERIAL
# nvme0n1   1.8T  disk    0 none           512     512 Samsung SSD 990 Pro  S7GXXXXXXXXX

# NVMe-specific information
nvme list
nvme smart-log /dev/nvme0
nvme id-ctrl /dev/nvme0 | grep -E "(Model|Serial|Firmware|nn |sqes|cqes|acl|aerl|mdts)"

# Check queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# 1023  (default for NVMe)

# Check I/O scheduler
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber  (none is selected, optimal for NVMe)

# Check read-ahead
cat /sys/block/nvme0n1/queue/read_ahead_kb
# 128  (128KB read-ahead; may need tuning for sequential workloads)

# CPU topology (important for NVMe queue affinity)
lscpu | grep -E "(CPU|NUMA|Cache)"
```

## fio: Benchmark Design Principles

fio (Flexible I/O Tester) is the standard Linux block device benchmark. The key is designing jobs that match your production workload — not generic benchmarks that look impressive but don't predict real performance.

### Installation

```bash
apt-get install -y fio      # Debian/Ubuntu
dnf install -y fio          # RHEL/Fedora
```

### Random Read IOPS (Database-Like Workload)

Measures random access latency and IOPS — critical for databases:

```ini
# random-read-iops.fio
[global]
ioengine=io_uring        ; Use io_uring for best NVMe performance (libaio also works)
direct=1                 ; Bypass page cache — measures raw device performance
iodepth=32               ; Outstanding I/Os per job; increase for higher queue saturation
bs=4k                    ; 4K blocks simulate database random reads
rw=randread              ; Random reads
time_based=1             ; Run for a fixed duration
runtime=60               ; 60 seconds
numjobs=4                ; 4 parallel jobs = 4 processes
group_reporting=1        ; Aggregate results across jobs
filename=/dev/nvme0n1    ; Test on the raw device (unmounted)

[random-read-4k]
; No additional options needed — global applies
```

```bash
# Run the benchmark
sudo fio random-read-iops.fio

# Expected output (Samsung 990 Pro):
# read: IOPS=850k, BW=3316MiB/s (3477MB/s)(193GiB/60001msec)
#   lat (usec): min=68, max=1423, avg=150.23, stdev=48.12
#   clat percentiles (usec):
#     | 1.00th=[   90], 5.00th=[  112], 10.00th=[  116],
#     | 50.00th=[  141], 75.00th=[  167], 90.00th=[  204],
#     | 95.00th=[  229], 99.00th=[  306], 99.50th=[  343],
#     | 99.90th=[  424], 99.99th=[  668]
```

### Sequential Write Throughput (Backup/Log-Like Workload)

```ini
# sequential-write-throughput.fio
[global]
ioengine=io_uring
direct=1
iodepth=64               ; Higher depth for sequential writes
bs=128k                  ; Large blocks for sequential throughput
rw=write
time_based=1
runtime=60
numjobs=2
group_reporting=1
filename=/dev/nvme0n1

[seq-write-128k]
```

```bash
sudo fio sequential-write-throughput.fio

# Expected output:
# write: IOPS=28.8k, BW=3600MiB/s (3774MB/s)(211GiB/60001msec)
```

### Mixed Read/Write (OLTP Database)

```ini
# mixed-rw-oltp.fio
[global]
ioengine=io_uring
direct=1
iodepth=16
bs=4k
rw=randrw
rwmixread=70             ; 70% reads, 30% writes (typical OLTP ratio)
time_based=1
runtime=120
numjobs=8
group_reporting=1
filename=/dev/nvme0n1
stonewall                ; Separate test sections

[oltp-4k-rw]

[ramp]                   ; Ramp-up to let the device reach steady state
ramp_time=10
```

### Latency Percentile Sweep

For latency-sensitive workloads, sweep queue depths to find the optimal operating point:

```bash
#!/bin/bash
# latency-sweep.sh — Measure latency at different queue depths

DEVICE=/dev/nvme0n1
RESULTS=/tmp/fio-latency-sweep.csv

echo "queue_depth,read_iops,avg_lat_us,p99_lat_us,p9999_lat_us" > "$RESULTS"

for QD in 1 2 4 8 16 32 64 128; do
    echo "Testing queue depth: $QD"

    OUTPUT=$(fio \
        --name=latency-sweep \
        --ioengine=io_uring \
        --direct=1 \
        --rw=randread \
        --bs=4k \
        --iodepth=$QD \
        --numjobs=1 \
        --runtime=30 \
        --time_based=1 \
        --filename=$DEVICE \
        --lat_percentiles=1 \
        --percentile_list=99:99.99 \
        --output-format=json 2>/dev/null)

    IOPS=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['jobs'][0]['read']['iops'])")
    AVG=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['jobs'][0]['read']['lat_ns']['mean']/1000)")
    P99=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['jobs'][0]['read']['clat_ns']['percentile']['99.000000']/1000)")
    P9999=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['jobs'][0]['read']['clat_ns']['percentile']['99.990000']/1000)")

    echo "$QD,$IOPS,$AVG,$P99,$P9999" >> "$RESULTS"
done

echo "Results saved to $RESULTS"
column -t -s, "$RESULTS"
```

## iostat: Interpreting Device Statistics

`iostat` is the primary tool for observing I/O utilization in real-time:

```bash
# Install sysstat
apt-get install -y sysstat

# Monitor I/O every 2 seconds with extended statistics
iostat -xz 2

# Key fields explained:
# r/s      — Read requests per second
# w/s      — Write requests per second
# rMB/s    — Read throughput in MB/s
# wMB/s    — Write throughput in MB/s
# rrqm/s   — Read requests merged per second (fewer = less sequential access)
# wrqm/s   — Write requests merged per second
# r_await  — Average wait time for read requests (ms) — CRITICAL METRIC
# w_await  — Average wait time for write requests (ms) — CRITICAL METRIC
# aqu-sz   — Average request queue size
# %util    — Device utilization (WARNING: 100% doesn't always mean saturation for SSDs)

# Example output on a busy NVMe:
# Device  r/s   w/s  rMB/s  wMB/s  rrqm/s  wrqm/s  r_await  w_await  aqu-sz  %util
# nvme0n1 85234 12453  332.8   48.6     0.0     8.2     0.35     0.42   32.87  100.00
```

### Interpreting Latency (await)

```
r_await / w_await interpretation for NVMe:
  < 0.1ms   → Excellent — NVMe operating at rated speed
  0.1-1ms   → Good — some queuing but acceptable
  1-10ms    → Degraded — heavy queue saturation or device issues
  > 10ms    → Problematic — likely causing application latency

For spinning disks (HDD):
  < 5ms     → Very good — minimal seeks
  5-20ms    → Normal under light load
  20-50ms   → Heavy contention
  > 50ms    → Severe I/O congestion
```

### Continuous Monitoring Script

```bash
#!/bin/bash
# io-monitor.sh — Monitor I/O metrics with alerting thresholds

DEVICE="${1:-nvme0n1}"
AWAIT_THRESHOLD=5       # Alert if await exceeds 5ms
UTIL_THRESHOLD=90       # Alert if utilization exceeds 90%
INTERVAL=5

echo "Monitoring /dev/$DEVICE — Ctrl+C to stop"
echo "Alerting if r_await or w_await > ${AWAIT_THRESHOLD}ms or util > ${UTIL_THRESHOLD}%"

iostat -xz -d "$DEVICE" "$INTERVAL" | while read line; do
    # Parse the device line
    if echo "$line" | grep -q "^$DEVICE"; then
        AWAIT=$(echo "$line" | awk '{print $10}')
        UTIL=$(echo "$line" | awk '{print $NF}' | tr -d '%')

        # Remove trailing % if present
        UTIL=$(echo "$UTIL" | sed 's/%//')

        TIMESTAMP=$(date '+%H:%M:%S')

        if (( $(echo "$AWAIT > $AWAIT_THRESHOLD" | bc -l) )); then
            echo "[$TIMESTAMP] ALERT: await=${AWAIT}ms exceeds threshold (${AWAIT_THRESHOLD}ms) | $line"
        elif (( $(echo "$UTIL > $UTIL_THRESHOLD" | bc -l) )); then
            echo "[$TIMESTAMP] WARN: util=${UTIL}% exceeds threshold (${UTIL_THRESHOLD}%) | $line"
        else
            echo "[$TIMESTAMP] OK: await=${AWAIT}ms util=${UTIL}%"
        fi
    fi
done
```

## NVMe Queue Configuration

NVMe drives support multiple hardware queues (up to 65,535), each capable of 65,536 outstanding commands. The Linux kernel must be configured to use them effectively:

```bash
# Check current NVMe queue configuration
nvme id-ctrl /dev/nvme0 | grep -E "(nn|sqes|cqes|acl)"
# nn 1        — 1 namespace
# sqes 6      — Max SQ Entry Size = 2^6 = 64 bytes
# cqes 4      — Max CQ Entry Size = 2^4 = 16 bytes

# Check number of queues (I/O submission/completion queue pairs)
ls /sys/block/nvme0n1/mq/
# 0  1  2  3  4  5  6  7  (8 queue pairs, one per CPU or CPUs)

# Check queue depth per hardware queue
cat /sys/block/nvme0n1/mq/0/nr_tags
# 1023

# Total theoretical IOPS capacity:
# queues * depth * (1 / latency_us * 1,000,000)
# 8 * 1023 * (1 / 150 * 1,000,000) = 54.5M IOPS theoretical max
```

### Increasing Queue Depth

```bash
# Increase the queue depth (nr_requests) for high-throughput workloads
# Default 1023 is usually fine for NVMe; some workloads benefit from higher

# Temporary change
echo 2047 > /sys/block/nvme0n1/queue/nr_requests

# Permanent change via udev rule
cat > /etc/udev/rules.d/60-nvme-queue.rules << 'EOF'
# Optimize NVMe queue settings
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/nr_requests}="2047"
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/rq_affinity}="2"
EOF

udevadm control --reload-rules
udevadm trigger --type=devices --action=change
```

## I/O Scheduler Selection

The I/O scheduler determines how the kernel orders and merges I/O requests before sending them to the device:

```bash
# Check available schedulers
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber

# SCHEDULER OPTIONS:
# none      — No reordering. Best for NVMe SSDs and flash.
#             Sends I/Os directly to the device in submission order.
#
# mq-deadline — Deadline-based scheduling with merge logic.
#             Best for HDDs and SATA SSDs where seek time matters.
#             Provides fairness between readers and writers.
#
# kyber     — Latency-focused multi-queue scheduler.
#             Targets specific read and write latency goals.
#             Good for mixed NVMe workloads with latency SLOs.
#
# bfq       — Budget Fair Queuing. Good for desktop/laptop SSDs
#             when you want I/O fairness between multiple processes.
#             Too much overhead for most server workloads.

# Set scheduler for NVMe (none is almost always correct for NVMe)
echo none > /sys/block/nvme0n1/queue/scheduler

# Set mq-deadline for SATA SSDs
echo mq-deadline > /sys/block/sda/queue/scheduler

# Configure mq-deadline latency targets
echo 500 > /sys/block/sda/queue/iosched/read_expire    # 500ms read deadline
echo 5000 > /sys/block/sda/queue/iosched/write_expire  # 5s write deadline
echo 1 > /sys/block/sda/queue/iosched/fifo_batch       # Smaller batches = lower latency

# For Kyber: set target latencies
echo kyber > /sys/block/nvme0n1/queue/scheduler
echo 250 > /sys/block/nvme0n1/queue/iosched/read_lat_nsec    # 250µs target
echo 2500 > /sys/block/nvme0n1/queue/iosched/write_lat_nsec  # 2.5ms target
```

## io_uring vs libaio

io_uring (added in Linux 5.1) is the modern async I/O interface that replaces libaio with dramatically lower system call overhead:

```bash
# Check kernel version (need 5.1+ for io_uring, 5.6+ for full features)
uname -r
# 6.14.0-37-generic  ← Supports io_uring fully

# Verify io_uring support
cat /proc/sys/kernel/io_uring_disabled
# 0  (0 = enabled, 1 = disabled, 2 = disabled for non-root)

# Benchmark comparison: libaio vs io_uring
fio --name=libaio-test \
    --ioengine=libaio \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --iodepth=32 \
    --numjobs=4 \
    --runtime=30 \
    --time_based=1 \
    --filename=/dev/nvme0n1 \
    --group_reporting=1

fio --name=io_uring-test \
    --ioengine=io_uring \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --iodepth=32 \
    --numjobs=4 \
    --runtime=30 \
    --time_based=1 \
    --filename=/dev/nvme0n1 \
    --group_reporting=1

# io_uring typically shows 10-30% higher IOPS at the same queue depth
# due to reduced system call overhead (io_uring batches submission and completion)
```

## Read-Ahead Tuning

Read-ahead prefetches data from the device before it's requested, reducing latency for sequential workloads. But it wastes bandwidth for random workloads:

```bash
# Current read-ahead
blockdev --getra /dev/nvme0n1
# 256  (in 512-byte sectors = 128KB)

# For sequential workloads (database backups, log archival): increase read-ahead
blockdev --setra 4096 /dev/nvme0n1   # 2MB read-ahead

# For random workloads (OLTP database, key-value stores): decrease or disable
blockdev --setra 0 /dev/nvme0n1    # Disable read-ahead
# or
blockdev --setra 8 /dev/nvme0n1    # 4KB read-ahead (minimal)

# Tuning via sysfs (alternative)
echo 2048 > /sys/block/nvme0n1/queue/read_ahead_kb  # 2MB
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb     # Disable

# Permanent read-ahead via udev
cat >> /etc/udev/rules.d/60-nvme-queue.rules << 'EOF'
# Disable read-ahead for database NVMe (random workload)
ACTION=="add|change", KERNEL=="nvme0n1", ATTR{queue/read_ahead_kb}="0"
# Large read-ahead for archive NVMe (sequential workload)
ACTION=="add|change", KERNEL=="nvme1n1", ATTR{queue/read_ahead_kb}="2048"
EOF
```

## blkdiscard: SSD Maintenance

SSDs require periodic TRIM/discard operations to maintain write performance. When files are deleted, the filesystem knows the blocks are free but the SSD does not — until TRIM tells it:

```bash
# Check if the device supports discard
cat /sys/block/nvme0n1/queue/discard_granularity
# 512  (non-zero means discard is supported)

cat /sys/block/nvme0n1/queue/discard_max_bytes
# 2147483136  (2GB max discard size)

# Discard all free blocks on a mounted filesystem
# This sends TRIM commands for all freed space
fstrim -v /

# Discard the entire raw device (WARNING: erases all data — for drive prep only)
blkdiscard /dev/nvme0n1

# Discard a specific range (in bytes)
blkdiscard --offset=0 --length=107374182400 /dev/nvme0n1  # First 100GB

# Enable automatic TRIM via mount options (for ext4/XFS/btrfs)
# Add 'discard' to mount options in /etc/fstab:
# /dev/nvme0n1p1  /data  ext4  defaults,noatime,discard  0 2

# Better alternative: periodic fstrim (less write amplification than continuous discard)
# Enable the fstrim systemd timer
systemctl enable --now fstrim.timer
systemctl status fstrim.timer
# Runs weekly by default; configure in /lib/systemd/system/fstrim.timer
```

## blktrace: Detailed I/O Tracing

When iostat shows high latency but the cause is unclear, blktrace captures every I/O operation:

```bash
# Capture 30 seconds of I/O trace
blktrace -d /dev/nvme0n1 -o /tmp/nvme0n1-trace -w 30

# Analyze the trace
blkparse -i /tmp/nvme0n1-trace.blktrace.* -d /tmp/nvme0n1-parsed.bin -q

# View summary statistics
btt -i /tmp/nvme0n1-parsed.bin | head -50

# Example btt output:
# ==================== All Devices ====================
#             ALL           MIN        AVG        MAX    N
# --------------- ---------- ---------- ---------- --------
# Q2Q               0.000001   0.000012   0.012345   850000
# Q2G               0.000001   0.000002   0.000987   850000
# G2I               0.000000   0.000001   0.000123   850000
# I2D               0.000001   0.000003   0.001234   850000
# D2C               0.000068   0.000151   0.001423   850000  <- Device time (actual disk time)
# Q2C               0.000072   0.000168   0.001567   850000  <- Total latency seen by application

# D2C (device service time) should be < 150µs for healthy NVMe
# Large difference between D2C and Q2C indicates scheduler or queue delay

# Visualize I/O patterns (requires gnuplot)
btt -i /tmp/nvme0n1-parsed.bin -o /tmp/btt-output
```

## Tuning Script: Production NVMe Setup

```bash
#!/bin/bash
# tune-nvme.sh — Production NVMe tuning for database workloads
# Run as root. Applies temporarily; add to /etc/rc.local or udev rules for persistence.

set -euo pipefail

DEVICE="${1:-nvme0n1}"
DEVICE_PATH="/sys/block/$DEVICE"

if [ ! -d "$DEVICE_PATH" ]; then
    echo "ERROR: Device $DEVICE not found"
    exit 1
fi

echo "Tuning $DEVICE for database workloads..."

# 1. I/O Scheduler: none (bypass all queueing, trust the NVMe hardware)
echo none > "$DEVICE_PATH/queue/scheduler"
echo "  Scheduler: none"

# 2. Queue depth: high for maximum parallelism
echo 2047 > "$DEVICE_PATH/queue/nr_requests"
echo "  Queue depth: 2047"

# 3. Disable read-ahead (random access pattern)
echo 0 > "$DEVICE_PATH/queue/read_ahead_kb"
echo "  Read-ahead: 0KB (disabled)"

# 4. NOOP for writeback (no writeback delay for database durability)
echo 0 > "$DEVICE_PATH/queue/write_cache"
# Note: Only available if the drive has a write buffer/cache. Check first:
# cat /sys/block/$DEVICE/queue/write_cache

# 5. Affinity: use all CPU queues (not just the first)
echo 2 > "$DEVICE_PATH/queue/rq_affinity"
echo "  I/O affinity: distributed across all CPUs"

# 6. Disable add_random (NVMe doesn't need to contribute to entropy)
echo 0 > "$DEVICE_PATH/queue/add_random"
echo "  add_random: disabled"

# 7. IO poll (busy-poll for ultra-low latency — use carefully)
# echo 1 > "$DEVICE_PATH/queue/io_poll"  # Only enable for critical low-latency paths

echo ""
echo "Final queue settings for $DEVICE:"
for param in scheduler nr_requests read_ahead_kb rq_affinity add_random; do
    echo "  $param: $(cat "$DEVICE_PATH/queue/$param")"
done
```

## Prometheus Alerts for Storage Performance

```yaml
# storage-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: storage-performance-alerts
  namespace: monitoring
spec:
  groups:
    - name: storage.performance
      interval: 30s
      rules:
        # High I/O await time — indicates I/O bottleneck
        - alert: StorageHighIOAwait
          expr: |
            rate(node_disk_read_time_seconds_total[5m]) /
            rate(node_disk_reads_completed_total[5m]) * 1000 > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High I/O read latency on {{ $labels.device }}"
            description: "Average read latency is {{ $value | humanizeDuration }} on {{ $labels.instance }}/{{ $labels.device }}"

        # High I/O utilization (approaching saturation)
        - alert: StorageHighUtilization
          expr: |
            rate(node_disk_io_time_seconds_total[5m]) > 0.9
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Storage device {{ $labels.device }} near saturation"
            description: "I/O utilization is {{ $value | humanizePercentage }} on {{ $labels.instance }}"

        # Write saturation (critical for databases)
        - alert: StorageWriteLatencyHigh
          expr: |
            rate(node_disk_write_time_seconds_total[5m]) /
            rate(node_disk_writes_completed_total[5m]) * 1000 > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High write latency on {{ $labels.device }}"
            description: "Write latency {{ $value }}ms on {{ $labels.instance }}/{{ $labels.device }}. Databases may experience commit delays."

        # I/O queue depth growing (queue accumulating)
        - alert: StorageQueueDepthHigh
          expr: |
            node_disk_io_now > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High I/O queue depth on {{ $labels.device }}"
            description: "{{ $value }} I/Os currently in-flight on {{ $labels.instance }}/{{ $labels.device }}"

        # Disk filling up fast
        - alert: StorageFillingFast
          expr: |
            predict_linear(node_filesystem_free_bytes[6h], 24 * 3600) < 0
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Filesystem on {{ $labels.mountpoint }} will be full in 24 hours"
            description: "Current free space: {{ $labels.mountpoint }} on {{ $labels.instance }}"

        # NVMe media errors (hardware failure indicator)
        - alert: NVMeMediaErrors
          expr: |
            increase(node_nvme_media_errors_total[1h]) > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "NVMe media errors detected on {{ $labels.device }}"
            description: "{{ $value }} media errors in the last hour on {{ $labels.instance }}. Hardware failure may be imminent."
```

## Summary

Linux I/O performance tuning follows a systematic process:

1. **Benchmark with fio** using job files that match your actual workload — random 4K reads for databases, large sequential writes for backups. Always use `direct=1` to bypass the page cache when measuring raw device performance.

2. **Interpret iostat** by focusing on `r_await` and `w_await` — latency above 1ms for NVMe or 20ms for HDD indicates queue saturation. `%util` at 100% is normal for HDDs indicating saturation but misleading for NVMe which can deliver work from multiple queues simultaneously.

3. **Set the scheduler to `none`** for NVMe SSDs — the hardware queue is better than any software scheduler. Use `mq-deadline` for SATA SSDs and HDDs.

4. **Use io_uring** over libaio — 10-30% fewer CPU cycles for the same IOPS due to batched system calls. Require Linux 5.6+ for production use.

5. **Tune read-ahead** based on access pattern — 0 for random (databases, key-value stores), 2MB+ for sequential (log archival, backup).

6. **Run `fstrim` weekly** via the systemd timer to maintain SSD write performance without the write amplification of continuous TRIM.

7. **Deploy Prometheus storage alerts** to catch degradation before it impacts applications — high await time and NVMe media errors need immediate attention.
