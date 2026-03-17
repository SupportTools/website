---
title: "Linux Storage I/O Schedulers: mq-deadline, Kyber, BFQ, and blkio cgroup v2 Tuning for NVMe and HDD"
date: 2031-11-17T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "I/O Scheduler", "NVMe", "Performance Tuning", "cgroup v2", "Kernel"]
categories:
- Linux
- Performance Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Linux block I/O schedulers: understanding mq-deadline, Kyber, and BFQ characteristics, tuning for NVMe vs spinning disk workloads, and implementing blkio cgroup v2 for storage QoS in containerized environments."
more_link: "yes"
url: "/linux-storage-io-scheduler-nvme-hdd-blkio-cgroup-v2-tuning-guide/"
---

Storage performance is one of the most misunderstood areas of Linux systems administration. Most teams either ignore the I/O scheduler entirely (accepting kernel defaults) or apply blanket configurations without understanding how workload characteristics interact with the hardware queue depth, access patterns, and latency profile of the underlying storage medium. The result is leaving substantial performance on the table — or worse, introducing latency regressions that are nearly impossible to diagnose after the fact.

This guide covers the Linux multi-queue block layer (blk-mq) architecture, the three production-relevant I/O schedulers (mq-deadline, Kyber, BFQ), how to select and tune them for your specific workload and hardware, and how to use blkio cgroup v2 to enforce storage QoS in multi-tenant environments.

<!--more-->

# Linux Storage I/O Schedulers: Production Tuning Guide

## The Linux Block I/O Stack

Before diving into schedulers, you need a clear mental model of where the I/O scheduler sits in the stack:

```
Application
    |
    | read(2)/write(2)/io_uring
    v
VFS (Virtual File System)
    |
    v
Page Cache
    |
    v
File System (ext4, XFS, ZFS, etc.)
    |
    v
Block Device Layer
    |
    v
I/O Scheduler (mq-deadline / Kyber / BFQ / none)
    |
    v
Block Multi-Queue (blk-mq) dispatch queues
    |
    v
Driver (NVMe, SCSI, SATA, etc.)
    |
    v
Physical Storage
```

### Single-Queue vs Multi-Queue (Legacy vs Modern)

Before kernel 5.0, Linux used a single I/O queue per device, creating a bottleneck on multi-core systems for high-IOPS NVMe drives. The modern `blk-mq` framework maps to the hardware's native queue structure:

```
blk-mq Software Queues (one per CPU or NUMA node)
            |
            v
blk-mq Hardware Queues (one per hardware submission queue)
            |
            v
NVMe Hardware (supports 1-65535 submission queues)
```

For a modern NVMe drive with 32 hardware queues, blk-mq creates 32 software dispatch queues, eliminating the global queue lock entirely.

## I/O Scheduler Overview

Check the current scheduler for a device:

```bash
# For device nvme0n1
cat /sys/block/nvme0n1/queue/scheduler
# Output: [none] mq-deadline kyber bfq
# The active scheduler is in brackets

# For all block devices
for dev in /sys/block/*/queue/scheduler; do
    echo "$(basename $(dirname $(dirname $dev))): $(cat $dev)"
done
```

Available schedulers depend on your kernel build:

```bash
# Check which schedulers are compiled in
grep -E 'CONFIG_IOSCHED' /boot/config-$(uname -r)
```

### none (No-op)

Not truly "no scheduler" — requests are dispatched immediately without reordering or merging. Appropriate only when the hardware layer handles all scheduling (e.g., some NVMe arrays with their own firmware QoS).

### mq-deadline

The default for most NVMe and SATA SSDs. Evolved from the classic deadline scheduler, adapted for blk-mq. Core algorithm: maintains two sorted queues (read and write) ordered by sector address for merge/sort optimization, plus FIFO queues per request type to enforce deadline expiry. Prevents starvation by promoting old requests past their deadline.

**Strengths**: Low overhead, predictable latency, good throughput for sequential workloads, handles mixed read/write well.

**Weaknesses**: No fairness between processes; a high-throughput process can dominate.

### Kyber

Designed specifically for low-latency NVMe and fast SSDs. Uses a token-bucket mechanism with configurable target latencies for reads and synchronous writes. Requests that exceed their latency budget get throttled at the software queue level before reaching hardware.

**Strengths**: Excellent p99 latency control, very low overhead, ideal for latency-sensitive workloads on fast SSDs.

**Weaknesses**: Less effective on slow or high-latency devices, no fairness between processes.

### BFQ (Budget Fair Queuing)

The most sophisticated scheduler. Provides process-level I/O fairness using a budget allocation system — processes are allocated I/O bandwidth proportional to their weight. Supports process groups for cgroup-based QoS. Excellent for mixed workloads where some processes need guaranteed I/O rates.

**Strengths**: Strong fairness guarantees, excellent for desktop/workstation use, cgroup integration, prevents one process from starving others.

**Weaknesses**: Higher CPU overhead (~2-5% on heavy workloads), adds latency vs mq-deadline/Kyber on pure throughput benchmarks.

## Hardware-Specific Recommendations

### NVMe Drives

NVMe drives have microsecond-level command latencies and support dozens of parallel hardware queues. The scheduler's job is minimized:

```bash
# For NVMe: use none or mq-deadline
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler

# Verify
cat /sys/block/nvme0n1/queue/scheduler
# [mq-deadline] kyber bfq none

# Key tuning parameters for mq-deadline on NVMe:
cat /sys/block/nvme0n1/queue/iosched/read_expire
# Default: 500ms - reduce for latency-sensitive workloads
echo 100 > /sys/block/nvme0n1/queue/iosched/read_expire

cat /sys/block/nvme0n1/queue/iosched/write_expire
# Default: 5000ms
echo 1000 > /sys/block/nvme0n1/queue/iosched/write_expire

# Writes per read batch (lower = more responsive reads)
echo 1 > /sys/block/nvme0n1/queue/iosched/writes_starved

# Queue depth - NVMe can handle high depth
cat /sys/block/nvme0n1/queue/nr_requests
echo 1024 > /sys/block/nvme0n1/queue/nr_requests
```

For NVMe with extremely consistent latencies, Kyber is worth testing:

```bash
echo kyber > /sys/block/nvme0n1/queue/scheduler

# Kyber target latency in nanoseconds
# Read target: 2ms
echo 2000000 > /sys/block/nvme0n1/queue/iosched/read_lat_nsec
# Sync write target: 10ms
echo 10000000 > /sys/block/nvme0n1/queue/iosched/write_lat_nsec
```

### SATA SSD

SATA SSDs have more variance in latency than NVMe. mq-deadline is typically the right choice:

```bash
echo mq-deadline > /sys/block/sda/queue/scheduler

# Slightly more conservative deadlines for SATA
echo 200 > /sys/block/sda/queue/iosched/read_expire     # 200ms
echo 3000 > /sys/block/sda/queue/iosched/write_expire   # 3s
echo 2 > /sys/block/sda/queue/iosched/writes_starved

# SATA queue depth (most controllers: 32-64)
echo 64 > /sys/block/sda/queue/nr_requests
```

### Spinning HDD (Mechanical)

HDDs have ~3-10ms seek times. Reordering requests by physical sector position (elevator algorithm) dramatically improves throughput. BFQ is optimal for HDDs with mixed workloads:

```bash
echo bfq > /sys/block/sdb/queue/scheduler

# BFQ tuning for HDD
# Idle window: time to wait for more requests from same process (ms)
echo 8 > /sys/block/sdb/queue/iosched/slice_idle

# Timeout for processes waiting to be served
echo 300 > /sys/block/sdb/queue/iosched/timeout_sync   # 300ms
echo 1500 > /sys/block/sdb/queue/iosched/timeout_async # 1.5s

# Enable back-seeking (allow small backward seeks for sequential optimization)
echo 1 > /sys/block/sdb/queue/iosched/back_seek_penalty

# Low latency mode: prioritize reads over writes
echo 1 > /sys/block/sdb/queue/iosched/low_latency

# Queue depth for HDD (lower is better for HDD with NCQ)
echo 32 > /sys/block/sdb/queue/nr_requests
```

### Enterprise SAS/SCSI Arrays

Storage arrays present a virtual block device. The array's internal controller handles the real scheduling. Use `none` or `mq-deadline` with minimal tuning:

```bash
echo mq-deadline > /sys/block/sdc/queue/scheduler

# Let the array decide - minimal interference
echo 500 > /sys/block/sdc/queue/iosched/read_expire
echo 5000 > /sys/block/sdc/queue/iosched/write_expire

# Match queue depth to array capabilities
echo 256 > /sys/block/sdc/queue/nr_requests
```

## Benchmarking I/O Schedulers

### Using fio for Scheduler Comparison

Create a comprehensive benchmark suite:

```bash
#!/bin/bash
# benchmark-schedulers.sh
DEVICE="/dev/nvme0n1"
SCHEDULERS=("none" "mq-deadline" "kyber" "bfq")
OUTPUT_DIR="/tmp/scheduler-benchmarks"
mkdir -p "$OUTPUT_DIR"

for sched in "${SCHEDULERS[@]}"; do
    echo "=== Testing scheduler: $sched ==="
    echo "$sched" > "/sys/block/$(basename $DEVICE)/queue/scheduler"

    # Random read IOPS (database-like)
    fio --name=randread \
        --filename="$DEVICE" \
        --rw=randread \
        --bs=4k \
        --direct=1 \
        --numjobs=4 \
        --ioengine=libaio \
        --iodepth=32 \
        --runtime=60s \
        --group_reporting \
        --output="$OUTPUT_DIR/${sched}-randread.json" \
        --output-format=json

    # Sequential read throughput
    fio --name=seqread \
        --filename="$DEVICE" \
        --rw=read \
        --bs=1m \
        --direct=1 \
        --numjobs=1 \
        --ioengine=libaio \
        --iodepth=8 \
        --runtime=60s \
        --group_reporting \
        --output="$OUTPUT_DIR/${sched}-seqread.json" \
        --output-format=json

    # Mixed 70/30 read/write (OLTP-like)
    fio --name=mixed \
        --filename="$DEVICE" \
        --rw=randrw \
        --rwmixread=70 \
        --bs=4k \
        --direct=1 \
        --numjobs=8 \
        --ioengine=libaio \
        --iodepth=64 \
        --runtime=60s \
        --group_reporting \
        --output="$OUTPUT_DIR/${sched}-mixed.json" \
        --output-format=json

    # Latency distribution (focus on p99)
    fio --name=latency \
        --filename="$DEVICE" \
        --rw=randread \
        --bs=4k \
        --direct=1 \
        --numjobs=1 \
        --ioengine=libaio \
        --iodepth=1 \
        --runtime=30s \
        --group_reporting \
        --clat_percentiles=1 \
        --percentile_list=50,90,95,99,99.9,99.99 \
        --output="$OUTPUT_DIR/${sched}-latency.json" \
        --output-format=json
done

echo "Benchmarks complete. Results in $OUTPUT_DIR"
```

Parse key metrics from fio JSON output:

```python
#!/usr/bin/env python3
# parse-fio-results.py
import json
import glob
import os

def parse_fio_job(filepath):
    with open(filepath) as f:
        data = json.load(f)

    job = data['jobs'][0]
    read = job.get('read', {})
    write = job.get('write', {})

    return {
        'read_iops': read.get('iops', 0),
        'read_bw_mb': read.get('bw', 0) / 1024,
        'read_lat_mean_us': read.get('lat_ns', {}).get('mean', 0) / 1000,
        'read_lat_p99_us': read.get('clat_ns', {}).get('percentile', {}).get('99.000000', 0) / 1000,
        'write_iops': write.get('iops', 0),
        'write_bw_mb': write.get('bw', 0) / 1024,
    }

schedulers = ['none', 'mq-deadline', 'kyber', 'bfq']
tests = ['randread', 'seqread', 'mixed', 'latency']

print(f"{'Scheduler':<15} {'Test':<12} {'R-IOPS':<10} {'R-BW MB/s':<12} {'Lat p99 us':<12}")
print("-" * 65)

for sched in schedulers:
    for test in tests:
        path = f"/tmp/scheduler-benchmarks/{sched}-{test}.json"
        if os.path.exists(path):
            m = parse_fio_job(path)
            print(f"{sched:<15} {test:<12} {m['read_iops']:<10.0f} {m['read_bw_mb']:<12.1f} {m['read_lat_p99_us']:<12.1f}")
```

## blkio cgroup v2

cgroup v2 replaces the legacy `blkio` controller with `io` (also called the unified hierarchy). This is the correct interface for all modern systems (kernel 5.14+ with systemd 248+).

### Verifying cgroup v2

```bash
# Check if cgroup v2 is enabled
mount | grep cgroup2
# tmpfs on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Verify io controller is enabled
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Check io controller is available
ls /sys/fs/cgroup/io.*
```

### cgroup v2 I/O Interface Files

```bash
# io.weight: relative weight for proportional I/O sharing
# Range: 1-10000, default: 100
cat /sys/fs/cgroup/io.weight
# default 100

# io.max: hard rate limits (IOPS and bandwidth)
cat /sys/fs/cgroup/io.max
# 8:0 rbps=max wbps=max riops=max wiops=max

# io.stat: per-device I/O statistics
cat /sys/fs/cgroup/io.stat
# 8:0 rbytes=... wbytes=... rios=... wios=... dbytes=... dios=...

# io.pressure: PSI (Pressure Stall Information) for I/O
cat /sys/fs/cgroup/io.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### Setting I/O Weights

```bash
# Create a cgroup for a database workload
mkdir -p /sys/fs/cgroup/database

# Set high I/O weight (database gets 4x more I/O than default processes)
echo "default 400" > /sys/fs/cgroup/database/io.weight

# Set lower weight for backup processes
mkdir -p /sys/fs/cgroup/backup
echo "default 25" > /sys/fs/cgroup/backup/io.weight

# Move a process to a cgroup
echo $PID > /sys/fs/cgroup/database/cgroup.procs

# Verify
cat /sys/fs/cgroup/database/io.weight
```

### Setting Hard I/O Rate Limits

```bash
# Find the major:minor numbers for your device
ls -la /dev/nvme0n1
# brw-rw---- 1 root disk 259, 0 ...
# Major: 259, Minor: 0

MAJOR=259
MINOR=0
DEVICE_ID="${MAJOR}:${MINOR}"

# Limit backup cgroup to 100MB/s reads, 50MB/s writes, 10k IOPS
echo "${DEVICE_ID} rbps=104857600 wbps=52428800 riops=10000 wiops=5000" \
    > /sys/fs/cgroup/backup/io.max

# Verify
cat /sys/fs/cgroup/backup/io.max
# 259:0 rbps=104857600 wbps=52428800 riops=10000 wiops=5000

# Remove limits (set to max)
echo "${DEVICE_ID} rbps=max wbps=max riops=max wiops=max" \
    > /sys/fs/cgroup/backup/io.max
```

### systemd Integration

The preferred way to manage cgroup I/O in production is through systemd unit overrides:

```bash
# /etc/systemd/system/postgresql.service.d/io-limits.conf
[Service]
# Weight-based sharing
IOWeight=400

# Hard limits per device
IOReadBandwidthMax=/dev/nvme0n1 2G
IOWriteBandwidthMax=/dev/nvme0n1 1G
IOReadIOPSMax=/dev/nvme0n1 100000
IOWriteIOPSMax=/dev/nvme0n1 50000
```

```bash
# /etc/systemd/system/backup.service.d/io-limits.conf
[Service]
IOWeight=25
IOReadBandwidthMax=/dev/nvme0n1 100M
IOWriteBandwidthMax=/dev/nvme0n1 50M
IOReadIOPSMax=/dev/nvme0n1 5000
IOWriteIOPSMax=/dev/nvme0n1 2500
```

Apply changes:

```bash
systemctl daemon-reload
systemctl restart postgresql
systemctl status postgresql
# Verify: check systemd's cgroup placement
systemctl show postgresql -p ControlGroup
cat /sys/fs/cgroup/system.slice/postgresql.service/io.weight
cat /sys/fs/cgroup/system.slice/postgresql.service/io.max
```

### Kubernetes blkio Configuration

In Kubernetes, I/O limits are set via container resources (requires blkio cgroup v2 and a supported runtime):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: database
  annotations:
    # For containerd with cgroup v2
    io.kubernetes.cri-o/blkio-weight: "400"
spec:
  containers:
  - name: postgres
    image: postgres:16
    resources:
      requests:
        cpu: "2"
        memory: 4Gi
      limits:
        cpu: "4"
        memory: 8Gi
```

For fine-grained I/O limits in Kubernetes, use the Device Plugin approach or configure directly via the runtime's cgroup path:

```bash
# Find the container's cgroup path
CONTAINER_ID=$(crictl ps --name=postgres -q)
CGROUP_PATH=$(crictl inspect $CONTAINER_ID | \
    jq -r '.info.runtimeSpec.linux.cgroupsPath')

# Set I/O limits directly
echo "259:0 rbps=2147483648 wbps=1073741824" \
    > /sys/fs/cgroup/${CGROUP_PATH}/io.max
```

## Persistent Configuration with udev

I/O scheduler changes via `/sys` are lost on reboot. Use udev rules for persistence:

```bash
# /etc/udev/rules.d/60-io-scheduler.rules

# NVMe devices: use mq-deadline
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/iosched/read_expire}="100"
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/iosched/write_expire}="1000"
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/nr_requests}="1024"

# SATA SSD (rotational=0, not nvme)
ACTION=="add|change", KERNEL=="sd[a-z]", \
    ATTR{queue/rotational}=="0", \
    ATTR{queue/scheduler}="mq-deadline"

# HDD (rotational=1)
ACTION=="add|change", KERNEL=="sd[a-z]", \
    ATTR{queue/rotational}=="1", \
    ATTR{queue/scheduler}="bfq"
ACTION=="add|change", KERNEL=="sd[a-z]", \
    ATTR{queue/rotational}=="1", \
    ATTR{queue/iosched/slice_idle}="8"
ACTION=="add|change", KERNEL=="sd[a-z]", \
    ATTR{queue/rotational}=="1", \
    ATTR{queue/iosched/low_latency}="1"
```

Apply immediately:

```bash
udevadm control --reload-rules
udevadm trigger --type=devices --action=change
```

## Monitoring I/O Scheduler Performance

### iostat and iotop

```bash
# Per-device extended statistics (1-second intervals)
iostat -x -d 1 nvme0n1

# Key metrics to watch:
# await: average I/O completion time (ms)
# r_await / w_await: separate read/write latency
# %util: device utilization (saturation indicator)
# svctm: service time (deprecated but sometimes useful)
# aqu-sz: average queue size (> 1 means queueing)

# Process-level I/O
iotop -o -P -d 1
```

### BPF-Based I/O Tracing

```bash
# Requires bpftools / bcc

# I/O latency histogram per device
biolatency -D 10 1

# Trace I/O requests by PID
biotop -C 10

# Identify I/O patterns (sequential vs random)
bitesize  # I/O size distribution

# Trace scheduler queue time specifically
biopattern  # % sequential I/O
```

### Prometheus + node_exporter

```yaml
# node_exporter exposes /proc/diskstats as node_disk_* metrics
# Key Prometheus queries:

# Average I/O completion time (await equivalent)
rate(node_disk_io_time_seconds_total[5m]) /
rate(node_disk_reads_completed_total[5m] + node_disk_writes_completed_total[5m])

# Read IOPS
rate(node_disk_reads_completed_total{device="nvme0n1"}[5m])

# Device utilization
rate(node_disk_io_time_seconds_total{device="nvme0n1"}[5m])

# Queue depth
node_disk_io_now{device="nvme0n1"}

# Alerting on high I/O latency
alert: HighDiskLatency
expr: |
  (
    rate(node_disk_read_time_seconds_total{device=~"nvme.*"}[5m])
    / rate(node_disk_reads_completed_total{device=~"nvme.*"}[5m])
  ) > 0.05
for: 5m
labels:
  severity: warning
annotations:
  summary: "High NVMe read latency (>50ms average)"
```

## Scheduler Selection Quick Reference

| Workload | Device | Recommended Scheduler | Key Tuning |
|---|---|---|---|
| Database (OLTP) | NVMe | mq-deadline | read_expire=100, writes_starved=1 |
| Database (OLTP) | NVMe | kyber | read_lat_nsec=2ms |
| Object store / sequential | NVMe | none or mq-deadline | nr_requests=1024 |
| Mixed workload | NVMe | mq-deadline | Default tuning |
| Desktop / workstation | NVMe | bfq | low_latency=1 |
| Database | SATA SSD | mq-deadline | read_expire=200 |
| Backup / archive | HDD | bfq | slice_idle=8 |
| NAS / file server | HDD | bfq | Low_latency=1 |
| SAN array | Any | mq-deadline | None (array handles it) |
| VM host (KVM/QEMU) | NVMe | mq-deadline | None (pass-through preferred) |

## Summary

The I/O scheduler is not a set-and-forget configuration — it is a dial that must be tuned to your specific combination of workload access patterns, hardware queue capabilities, and latency requirements. For modern NVMe in production databases, mq-deadline with reduced read deadlines consistently outperforms alternatives. For HDDs with mixed or interactive workloads, BFQ's process fairness is worth the CPU overhead. Kyber is the right choice when you have latency SLOs for a specific device and want the kernel to enforce them directly.

The blkio cgroup v2 interface completes the picture by allowing you to enforce storage QoS at the process or container level — critical when a backup job or batch process competes with your primary database for I/O bandwidth. With systemd integration, these limits become first-class deployment configuration alongside CPU and memory constraints.
