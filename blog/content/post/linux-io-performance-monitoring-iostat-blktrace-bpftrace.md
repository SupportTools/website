---
title: "Linux I/O Performance Monitoring with iostat, blktrace, and bpftrace Scripts"
date: 2031-08-12T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "I/O", "iostat", "blktrace", "bpftrace", "eBPF", "Storage"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to Linux I/O performance monitoring and analysis using iostat, blktrace, blkparse, iowatcher, and bpftrace scripts for deep storage subsystem visibility in production environments."
more_link: "yes"
url: "/linux-io-performance-monitoring-iostat-blktrace-bpftrace/"
---

Storage I/O is frequently the bottleneck in database, caching, and logging workloads. Linux provides a rich set of tools ranging from the familiar `iostat` to the deep tracing capabilities of `blktrace` and `bpftrace`. This guide walks through a systematic approach to I/O analysis, from high-level metrics through kernel-level tracing.

<!--more-->

# Linux I/O Performance Monitoring with iostat, blktrace, and bpftrace Scripts

## Overview

Linux I/O performance analysis follows a layered approach:

```
Application Layer        (strace, ltrace)
    ↓
VFS Layer               (opensnoop, filelife)
    ↓
Filesystem Layer        (ext4slower, xfsslower)
    ↓
Block I/O Layer         (biolatency, biosnoop)
    ↓
Device Driver Layer     (blktrace, nvmelatency)
    ↓
Hardware/Device         (smartctl, nvme-cli)
```

Each layer has different tools and provides different visibility. Starting at the top and drilling down is the most efficient approach to identifying storage bottlenecks.

---

## Section 1: iostat Fundamentals

### 1.1 Basic iostat Usage

`iostat` is part of the `sysstat` package and provides device-level I/O statistics:

```bash
# Install sysstat
apt-get install -y sysstat     # Debian/Ubuntu
dnf install -y sysstat         # RHEL/Rocky

# Basic device statistics (1 second interval, 10 samples)
iostat -x 1 10

# Extended statistics with human-readable output
iostat -xh 1

# Per-device statistics with timestamps
iostat -xmt 1

# Specific device only
iostat -x sda nvme0n1 1
```

### 1.2 Understanding iostat Output

```
Device   r/s   rkB/s  rrqm/s  %rrqm  r_await  rareq-sz  w/s   wkB/s  ...  %util
nvme0n1 100.0  4096.0    0.0  0.00    0.15     40.96    50.0  1024.0  ...   8.50
sda       2.0    32.0    0.3 13.04    8.20     16.00     1.0     8.0  ...   0.30
```

Key fields explained:

| Field | Description | Warning Level |
|-------|-------------|---------------|
| `r/s` | Read requests per second | Workload dependent |
| `w/s` | Write requests per second | Workload dependent |
| `rkB/s` | Read throughput (KB/s) | Near device bandwidth |
| `wkB/s` | Write throughput (KB/s) | Near device bandwidth |
| `r_await` | Average read latency (ms) | >1ms NVMe, >20ms SAS |
| `w_await` | Average write latency (ms) | >2ms NVMe, >20ms SAS |
| `rareq-sz` | Average read request size (KB) | Context dependent |
| `wareq-sz` | Average write request size (KB) | Context dependent |
| `%util` | Device utilization | >80% = potential saturation |
| `svctm` | Service time (deprecated) | Ignore |
| `rrqm/s` | Read requests merged per second | High = sequential I/O |
| `wrqm/s` | Write requests merged per second | High = sequential I/O |
| `aqu-sz` | Average queue depth | >1 = queue saturation |

### 1.3 iostat Analysis Script

```bash
#!/bin/bash
# io-analyze.sh - Collect and summarize iostat data
set -euo pipefail

DEVICE="${1:-}"
INTERVAL="${2:-5}"
DURATION="${3:-60}"
SAMPLES=$(( DURATION / INTERVAL ))

if [[ -z "$DEVICE" ]]; then
    echo "Usage: $0 <device> [interval] [duration]"
    echo "Example: $0 nvme0n1 5 60"
    exit 1
fi

OUTPUT_FILE="/tmp/iostat-$(date +%Y%m%d-%H%M%S).txt"
echo "Collecting iostat for /dev/$DEVICE (${DURATION}s at ${INTERVAL}s intervals)"
echo "Output: $OUTPUT_FILE"

# Collect data
iostat -xmt "$INTERVAL" "$SAMPLES" "$DEVICE" | tee "$OUTPUT_FILE"

# Summarize
echo ""
echo "=== Summary ==="
awk -v dev="$DEVICE" '
NR > 3 && $1 == dev {
    count++;
    r_await_sum += $9;
    w_await_sum += $10;
    util_sum += $NF;
    if ($9 > max_r_await) max_r_await = $9;
    if ($10 > max_w_await) max_w_await = $10;
    if ($NF > max_util) max_util = $NF;
}
END {
    if (count > 0) {
        printf "Samples:     %d\n", count;
        printf "Avg r_await: %.2f ms\n", r_await_sum/count;
        printf "Max r_await: %.2f ms\n", max_r_await;
        printf "Avg w_await: %.2f ms\n", w_await_sum/count;
        printf "Max w_await: %.2f ms\n", max_w_await;
        printf "Avg %%util:  %.2f%%\n", util_sum/count;
        printf "Max %%util:  %.2f%%\n", max_util;
    }
}
' "$OUTPUT_FILE"
```

### 1.4 Detecting Saturation

```bash
# Alert when utilization exceeds 80% or latency exceeds thresholds
iostat -x 1 | awk '
/nvme|sd[a-z]/ {
    util = $NF + 0;
    r_await = $9 + 0;
    w_await = $10 + 0;

    if (util > 80)
        printf "WARN: %s utilization %.1f%%\n", $1, util;

    if (r_await > 5)
        printf "WARN: %s read latency %.2fms\n", $1, r_await;

    if (w_await > 10)
        printf "WARN: %s write latency %.2fms\n", $1, w_await;
}
'
```

---

## Section 2: blktrace — Block Layer Tracing

`blktrace` captures every I/O event at the block device layer, providing microsecond-level visibility into the I/O path.

### 2.1 blktrace Installation and Setup

```bash
# Install blktrace
apt-get install -y blktrace     # Debian/Ubuntu
dnf install -y blktrace         # RHEL/Rocky

# Verify debugfs is mounted (required by blktrace)
mount | grep debugfs
# If not mounted:
mount -t debugfs debugfs /sys/kernel/debug

# Quick test
blktrace -d /dev/nvme0n1 -o - | head -20
```

### 2.2 Capturing Block I/O Traces

```bash
# Capture 30 seconds of block I/O for nvme0n1
# Writes binary trace files to current directory
blktrace -d /dev/nvme0n1 -w 30 -o nvme-trace

# This creates files: nvme-trace.blktrace.0, nvme-trace.blktrace.1, etc.
# (one per CPU)
ls -lh nvme-trace.blktrace.*

# For a busy database, the trace files can be large
# Use -r to limit the trace buffer size
blktrace -d /dev/nvme0n1 -w 10 -b 8192 -o db-trace
```

### 2.3 Parsing Traces with blkparse

```bash
# Parse and display trace events
blkparse -i nvme-trace -o nvme-trace.txt

# Show only I/O completions (C events)
blkparse -i nvme-trace -f "%T.%t %p %a %d %P %n\n" | grep " C "

# Summary output only
blkparse -i nvme-trace -q

# Sort by PID to see which processes are doing I/O
blkparse -i nvme-trace -q -S P -o nvme-summary.txt
```

### 2.4 Understanding blktrace Events

```
Timestamp  PID  Action  RWBS  Sector  Size
259,0       0  0 Q  R   8176  8    [kworker]
259,0       0  0 G  R   8176  8    [kworker]
259,0       0  0 I  R   8176  8    [kworker]
259,0       0  0 D  R   8176  8    [kworker]
259,0       0  0 C  R   8176  8    [kworker]
```

Event action codes:

| Code | Action | Description |
|------|--------|-------------|
| `Q` | Queue | I/O request submitted to block layer |
| `G` | Get request | I/O request structure allocated |
| `M` | Merge | Request merged with existing queue entry |
| `S` | Sleep | I/O waiting for request structure |
| `I` | Insert | Inserted into device queue |
| `D` | Driver | Sent to device driver |
| `C` | Complete | I/O completed |
| `X` | Split | Request was split |
| `A` | Remap | Request remapped (e.g., by DM) |

### 2.5 Calculating Latency with btt

`btt` (blktrace time tool) computes latency statistics from trace files:

```bash
# Generate per-device latency breakdown
blkparse -i nvme-trace -q | btt

# Output includes:
# Q to G: time between queue and get-request allocation
# G to I: time in I/O scheduler (waiting for merge)
# I to D: time in driver queue
# D to C: service time (device processing)
# Q to C: total end-to-end latency

# Per-process latency breakdown
blkparse -i nvme-trace -q | btt -P per_process_latency.dat
```

### 2.6 iowatcher Visualization

`iowatcher` converts blktrace data into visual SVG timelines:

```bash
# Install iowatcher
apt-get install -y iowatcher   # Ubuntu (may not be in all distros)
# or build from source: https://github.com/fio-io/iowatcher

# Create an animated GIF of I/O activity
iowatcher -t nvme-trace.blktrace.0 -o nvme-io.svg

# Include throughput and latency graphs
iowatcher \
  --trace nvme-trace.blktrace.0 \
  --output nvme-io.svg \
  --movie nvme-io.mpg
```

---

## Section 3: bpftrace for Deep I/O Analysis

bpftrace provides programmable eBPF-based tracing that can answer questions neither iostat nor blktrace can easily address.

### 3.1 Installation

```bash
# Ubuntu 22.04+
apt-get install -y bpftrace

# RHEL 8+
dnf install -y bpftrace

# Verify
bpftrace --version
# bpftrace v0.20.x

# List available block I/O tracepoints
bpftrace -l 'tracepoint:block:*'
```

### 3.2 Block I/O Latency Histogram

```bash
# biolatency.bt — histogram of block I/O completion latency
bpftrace - << 'EOF'
tracepoint:block:block_rq_issue
{
    @start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
    $lat = nsecs - @start[args->dev, args->sector];
    delete(@start[args->dev, args->sector]);

    if (args->rwbs & 1) {
        @read_lat = hist($lat / 1000);   // microseconds
    } else {
        @write_lat = hist($lat / 1000);
    }
}

interval:s:10
{
    print("=== Read Latency (us) ===");
    print(@read_lat);
    print("=== Write Latency (us) ===");
    print(@write_lat);
    clear(@read_lat);
    clear(@write_lat);
}
EOF
```

### 3.3 Top Processes by I/O

```bash
# top-io-procs.bt — top processes by block I/O count and bytes
bpftrace - << 'EOF'
tracepoint:block:block_rq_issue
{
    @io_count[pid, comm] = count();
    @io_bytes[pid, comm] = sum(args->nr_sector * 512);
}

interval:s:10
{
    printf("\n--- Top I/O by count ---\n");
    print(@io_count, 10);

    printf("\n--- Top I/O by bytes ---\n");
    print(@io_bytes, 10);

    clear(@io_count);
    clear(@io_bytes);
}
EOF
```

### 3.4 Slow I/O Detector

```bash
# slowio.bt — alert on I/O exceeding threshold
# Threshold: 10ms (10000 microseconds)

cat > /usr/local/bin/slowio.bt << 'EOF'
#!/usr/bin/bpftrace

#include <linux/blkdev.h>

BEGIN
{
    @threshold_us = 10000;  // 10ms threshold
    printf("Monitoring for I/O > %d us\n", @threshold_us);
    printf("%-16s %-6s %-12s %-8s %-8s %s\n",
        "COMM", "PID", "DEVICE", "RW", "LAT(us)", "SECTOR");
}

tracepoint:block:block_rq_issue
{
    @start[args->dev, args->sector] = nsecs;
    @comm[args->dev, args->sector] = comm;
    @pid[args->dev, args->sector] = pid;
}

tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
    $lat_us = (nsecs - @start[args->dev, args->sector]) / 1000;
    $rw = args->rwbs & 1 ? "R" : "W";

    if ($lat_us > @threshold_us) {
        printf("%-16s %-6d %-12d %-8s %-8d %d\n",
            @comm[args->dev, args->sector],
            @pid[args->dev, args->sector],
            args->dev,
            $rw,
            $lat_us,
            args->sector
        );
    }

    delete(@start[args->dev, args->sector]);
    delete(@comm[args->dev, args->sector]);
    delete(@pid[args->dev, args->sector]);
}

END
{
    clear(@threshold_us);
    clear(@start);
    clear(@comm);
    clear(@pid);
}
EOF

chmod +x /usr/local/bin/slowio.bt
bpftrace /usr/local/bin/slowio.bt
```

### 3.5 Read/Write Ratio Analysis

```bash
# rwratio.bt — track read/write ratios and sizes per process
bpftrace - << 'EOF'
tracepoint:block:block_rq_issue
{
    if (args->rwbs & 1) {
        @reads[comm] = count();
        @read_bytes[comm] = sum(args->nr_sector * 512);
    } else {
        @writes[comm] = count();
        @write_bytes[comm] = sum(args->nr_sector * 512);
    }
}

interval:s:30
{
    printf("\n=== Block I/O by process (30s window) ===\n");
    printf("%-20s %8s %10s %8s %10s\n",
        "PROCESS", "READS", "READ_MB", "WRITES", "WRITE_MB");

    // Note: bpftrace doesn't support joining maps directly
    // Use separate prints and correlate manually
    print(@reads);
    print(@read_bytes);
    print(@writes);
    print(@write_bytes);

    clear(@reads);
    clear(@read_bytes);
    clear(@writes);
    clear(@write_bytes);
}
EOF
```

### 3.6 Filesystem Latency Tracing

```bash
# ext4-latency.bt — ext4 operation latencies
bpftrace - << 'EOF'
kprobe:ext4_file_read_iter
{
    @read_start[tid] = nsecs;
}

kretprobe:ext4_file_read_iter
/@read_start[tid]/
{
    @ext4_read_lat = hist((nsecs - @read_start[tid]) / 1000);
    delete(@read_start[tid]);
}

kprobe:ext4_file_write_iter
{
    @write_start[tid] = nsecs;
}

kretprobe:ext4_file_write_iter
/@write_start[tid]/
{
    @ext4_write_lat = hist((nsecs - @write_start[tid]) / 1000);
    delete(@write_start[tid]);
}

interval:s:10
{
    printf("=== ext4 read latency (us) ===\n");
    print(@ext4_read_lat);
    printf("=== ext4 write latency (us) ===\n");
    print(@ext4_write_lat);
    clear(@ext4_read_lat);
    clear(@ext4_write_lat);
}
EOF
```

### 3.7 I/O Queue Depth Tracking

```bash
# qdepth.bt — block device queue depth over time
bpftrace - << 'EOF'
tracepoint:block:block_rq_issue
{
    @in_flight[args->dev]++;
}

tracepoint:block:block_rq_complete
{
    @in_flight[args->dev]--;
    @max_depth[args->dev] = max(@in_flight[args->dev]);
}

interval:s:1
{
    printf("--- Queue depths ---\n");
    print(@in_flight);
    printf("--- Max queue depths ---\n");
    print(@max_depth);
    clear(@max_depth);
}
EOF
```

### 3.8 NVMe-Specific Latency Tracing

```bash
# nvme-latency.bt — NVMe command completion latencies
bpftrace - << 'EOF'
tracepoint:nvme:nvme_sq
{
    @nvme_start[args->qid, args->cmdid] = nsecs;
}

tracepoint:nvme:nvme_complete_rq
/@nvme_start[args->qid, args->cmdid]/
{
    $lat_us = (nsecs - @nvme_start[args->qid, args->cmdid]) / 1000;
    @nvme_lat = hist($lat_us);
    delete(@nvme_start[args->qid, args->cmdid]);
}

interval:s:5
{
    printf("=== NVMe latency histogram (us) ===\n");
    print(@nvme_lat);
    clear(@nvme_lat);
}
EOF
```

---

## Section 4: fio — Synthetic Benchmarking

Before analyzing production I/O, establish baseline performance with `fio`:

```bash
# Install fio
apt-get install -y fio

# Sequential read test
fio \
  --name=seq-read \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=read \
  --bs=128k \
  --direct=1 \
  --numjobs=1 \
  --size=4G \
  --filename=/dev/nvme0n1 \
  --output-format=json \
  --output=seq-read-results.json

# Random read IOPS test
fio \
  --name=rand-read-4k \
  --ioengine=libaio \
  --iodepth=128 \
  --rw=randread \
  --bs=4k \
  --direct=1 \
  --numjobs=4 \
  --size=4G \
  --filename=/dev/nvme0n1 \
  --runtime=60 \
  --time_based \
  --group_reporting

# Mixed read/write workload (70/30, typical database)
fio \
  --name=mixed-rw \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=randrw \
  --rwmixread=70 \
  --bs=4k \
  --direct=1 \
  --numjobs=8 \
  --size=4G \
  --filename=/dev/nvme0n1 \
  --runtime=120 \
  --time_based \
  --group_reporting
```

### 4.1 fio Configuration for Database Simulation

```ini
# postgres-workload.fio
[global]
ioengine=libaio
direct=1
buffered=0
norandommap=1
randrepeat=0
time_based=1
runtime=300
group_reporting=1

[data-reads]
filename=/dev/nvme0n1
rw=randread
bs=8k
iodepth=64
numjobs=4
new_group

[data-writes]
filename=/dev/nvme0n1
rw=randwrite
bs=8k
iodepth=16
numjobs=2
new_group

[wal-writes]
filename=/dev/nvme1n1
rw=write
bs=64k
iodepth=4
numjobs=1
fsync=1
new_group
```

```bash
fio postgres-workload.fio --output=postgres-results.json --output-format=json+
```

---

## Section 5: Production Analysis Workflows

### 5.1 High Latency Investigation

```bash
#!/bin/bash
# investigate-high-latency.sh
# Systematic I/O latency investigation

DEVICE="${1:-nvme0n1}"

echo "=== Step 1: Current device statistics ==="
iostat -xh 1 5 "$DEVICE"

echo ""
echo "=== Step 2: Queue depth and scheduler ==="
cat /sys/block/$DEVICE/queue/nr_requests
cat /sys/block/$DEVICE/queue/scheduler

echo ""
echo "=== Step 3: Check for I/O errors ==="
dmesg | grep -i "error\|fail\|timeout" | grep "$DEVICE" | tail -20

echo ""
echo "=== Step 4: Smart status ==="
smartctl -a /dev/$DEVICE 2>/dev/null | grep -E "Reallocated|Pending|Uncorrectable|Power_Cycle|Temperature"

echo ""
echo "=== Step 5: Top I/O processes (bpftrace, 30s) ==="
timeout 30 bpftrace -e '
tracepoint:block:block_rq_complete
{
    @[comm] = count();
}
END { print(@); }
'

echo ""
echo "=== Step 6: Latency histogram (bpftrace, 30s) ==="
timeout 30 bpftrace -e '
tracepoint:block:block_rq_issue { @s[args->dev, args->sector] = nsecs; }
tracepoint:block:block_rq_complete /@s[args->dev, args->sector]/ {
    @lat = hist((nsecs - @s[args->dev, args->sector]) / 1000);
    delete(@s[args->dev, args->sector]);
}
END { print(@lat); }
'
```

### 5.2 I/O Scheduler Tuning

```bash
# Check current scheduler
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# For NVMe: 'none' is typically optimal
echo "none" > /sys/block/nvme0n1/queue/scheduler

# For HDD with mixed workloads: 'bfq' often performs best
echo "bfq" > /sys/block/sda/queue/scheduler

# Increase queue depth for NVMe (default: 64)
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# Read-ahead tuning: increase for sequential workloads
echo 2048 > /sys/block/nvme0n1/queue/read_ahead_kb
# Decrease for random workloads (databases)
echo 128 > /sys/block/nvme0n1/queue/read_ahead_kb

# Make scheduler settings persistent
cat > /etc/udev/rules.d/60-io-scheduler.rules << 'EOF'
# NVMe drives: no scheduler
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/scheduler}="none"
ATTR{queue/nr_requests}="1024"
ATTR{queue/read_ahead_kb}="128"

# SATA/SAS drives: bfq scheduler
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/scheduler}="bfq"
ATTR{queue/nr_requests}="128"
EOF

udevadm control --reload-rules
```

### 5.3 Monitoring with Prometheus and Node Exporter

```yaml
# Prometheus alerting rules for I/O
groups:
  - name: disk-io
    rules:
      - alert: DiskIOLatencyHigh
        expr: |
          rate(node_disk_read_time_seconds_total[5m])
          /
          rate(node_disk_reads_completed_total[5m])
          * 1000 > 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High disk read latency on {{ $labels.device }}"
          description: "Read latency is {{ $value | humanizeDuration }} on {{ $labels.instance }}/{{ $labels.device }}"

      - alert: DiskIOSaturation
        expr: |
          rate(node_disk_io_time_seconds_total[1m]) * 100 > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Disk I/O saturation on {{ $labels.device }}"
          description: "Disk {{ $labels.device }} on {{ $labels.instance }} is {{ $value }}% utilized"

      - alert: DiskIOQueueDepthHigh
        expr: |
          node_disk_io_time_weighted_seconds_total
          /
          node_disk_io_time_seconds_total
          > 8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High I/O queue depth on {{ $labels.device }}"
```

---

## Section 6: cgroups I/O Throttling

For containers and Kubernetes, I/O throttling via cgroups is essential for preventing noisy-neighbor problems:

### 6.1 Direct cgroup I/O Configuration

```bash
# List block devices with their major:minor numbers
ls -la /dev/nvme* | awk '{print $5,$6,$10}' | head

# Set per-cgroup read bandwidth limit (100 MB/s)
# For cgroups v2:
CGROUP_PATH="/sys/fs/cgroup/system.slice/myservice.service"
DEVICE_MAJ_MIN="259:0"  # nvme0n1

echo "$DEVICE_MAJ_MIN rbps=104857600" > "$CGROUP_PATH/io.max"
echo "$DEVICE_MAJ_MIN wbps=104857600" >> "$CGROUP_PATH/io.max"

# Set IOPS limit (1000 read IOPS, 500 write IOPS)
echo "$DEVICE_MAJ_MIN riops=1000 wiops=500" >> "$CGROUP_PATH/io.max"

# Check effective limits
cat "$CGROUP_PATH/io.max"

# Check actual I/O stats per cgroup
cat "$CGROUP_PATH/io.stat"
```

### 6.2 Kubernetes I/O Limits

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: io-constrained-app
spec:
  containers:
    - name: app
      image: yourorg/app:latest
      resources:
        requests:
          ephemeral-storage: "2Gi"
        limits:
          ephemeral-storage: "4Gi"
  # Node-level I/O limits require device plugin or custom scheduler
  # Use BlkioDeviceReadBps/BlkioDeviceWriteBps for fine-grained control
  runtimeClassName: high-io  # Custom RuntimeClass with specific I/O settings
```

---

## Section 7: Complete Monitoring Stack

### 7.1 Automated I/O Report Script

```bash
#!/bin/bash
# io-report.sh — Comprehensive I/O health report

set -euo pipefail

REPORT_FILE="/tmp/io-report-$(date +%Y%m%d-%H%M%S).txt"

{
    echo "==================================================="
    echo "I/O Health Report - $(date)"
    echo "==================================================="

    echo ""
    echo "## System Information"
    uname -r
    lsblk -o NAME,TYPE,SIZE,ROTA,SCHED,MODEL

    echo ""
    echo "## Current I/O Statistics (10s sample)"
    iostat -xh 1 10 | tail -20

    echo ""
    echo "## Block Device Queues"
    for dev in /sys/block/nvme* /sys/block/sd*; do
        [ -d "$dev" ] || continue
        name=$(basename "$dev")
        scheduler=$(cat "$dev/queue/scheduler" 2>/dev/null || echo "N/A")
        depth=$(cat "$dev/queue/nr_requests" 2>/dev/null || echo "N/A")
        ahead=$(cat "$dev/queue/read_ahead_kb" 2>/dev/null || echo "N/A")
        echo "$name: scheduler=$scheduler depth=$depth read_ahead=${ahead}KB"
    done

    echo ""
    echo "## Recent I/O Errors (dmesg)"
    dmesg --since "1 hour ago" | grep -iE "error|fail|timeout|reset" | grep -E "sd[a-z]|nvme" || echo "None"

    echo ""
    echo "## SMART Summary"
    for dev in /dev/nvme*n1 /dev/sd[a-z]; do
        [ -b "$dev" ] || continue
        echo "--- $dev ---"
        smartctl -H "$dev" 2>/dev/null | grep "overall-health" || echo "N/A"
    done

    echo ""
    echo "## Top I/O Processes (30s bpftrace sample)"
    timeout 30 bpftrace -e '
    tracepoint:block:block_rq_issue {
        @rw[comm, pid, args->rwbs & 1 ? "R" : "W"] = count();
        @bytes[comm, pid, args->rwbs & 1 ? "R" : "W"] = sum(args->nr_sector * 512);
    }
    END { print(@bytes); }
    ' 2>/dev/null || echo "bpftrace not available"

} | tee "$REPORT_FILE"

echo ""
echo "Report saved to: $REPORT_FILE"
```

---

## Summary

A systematic approach to Linux I/O performance analysis starts broad and drills down:

1. **iostat** for device-level metrics — identify which devices are saturated and measure overall throughput and latency
2. **blktrace** for block-layer event capture — understand I/O patterns, merging behavior, and request sizing
3. **bpftrace** for deep, targeted investigation — histogram latency, identify top I/O consumers, trace slow requests
4. **fio** for baseline benchmarking — know your device's maximum capability before analyzing production workloads

For production Kubernetes environments, combine node-exporter metrics with custom bpftrace alerts to catch I/O regressions before they impact application SLAs. The scripts in this post can be packaged as DaemonSet sidecars or node-level monitoring agents for continuous I/O visibility.
