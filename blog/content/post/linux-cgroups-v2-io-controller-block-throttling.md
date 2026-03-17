---
title: "Linux cgroups v2 IO Controller: Block I/O Throttling and Prioritization"
date: 2029-09-08T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "IO", "Performance", "Containers", "Kernel"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to the Linux cgroups v2 IO controller: configuring io.max for throughput and IOPS throttling, io.weight and io.bfq.weight for proportional scheduling, latency targets, writeback throttling, and container I/O isolation strategies."
more_link: "yes"
url: "/linux-cgroups-v2-io-controller-block-throttling/"
---

Disk I/O contention is one of the most common sources of performance unpredictability in multi-tenant environments. The cgroups v2 IO controller provides precise control over block device access, enabling both hard throttling limits (bytes per second, IOPS) and proportional scheduling through the BFQ scheduler. This post covers the complete IO controller interface: `io.max`, `io.weight`, `io.bfq.weight`, latency targets, writeback throttling, and how to apply these mechanisms for container I/O isolation.

<!--more-->

# Linux cgroups v2 IO Controller: Block I/O Throttling and Prioritization

## cgroups v2 IO Controller Overview

The cgroups v2 IO controller (formerly `blkio` in v1) unifies throttling and weighted proportional scheduling into a single interface. Before using it, verify your kernel and distribution support cgroups v2:

```bash
# Check if cgroups v2 is mounted
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Check kernel version (4.15+ for most IO features, 5.4+ for BFQ weight)
uname -r

# Verify IO controller is enabled
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Check IO controller is available in a specific cgroup
cat /sys/fs/cgroup/system.slice/cgroup.controllers
# cpu io memory pids
```

### Identifying Block Devices

IO controller settings reference devices by major:minor number:

```bash
# List block devices with major:minor
lsblk -o NAME,MAJ:MIN,TYPE,MOUNTPOINT
# NAME   MAJ:MIN TYPE MOUNTPOINT
# sda      8:0   disk
# ├─sda1   8:1   part /boot
# └─sda2   8:2   part /
# nvme0n1 259:0  disk
# └─nvme0n1p1 259:1 part /data

# Get major:minor for a specific device
stat -c "%t %T" /dev/sda
# 8 0    (hex: 0x8, 0x0 -> decimal: 8, 0)

stat -c "%t:%T" /dev/nvme0n1
# 103:0

# Convert from hex to decimal if needed
printf "%d:%d\n" 0x103 0x0
# 259:0
```

## io.max: Hard Throttling Limits

`io.max` enforces hard upper limits on throughput and IOPS. Even if the cgroup's processes could use more bandwidth, the kernel restricts access to the configured maximum.

### io.max Syntax

```
<major>:<minor> [rbps=<bytes>] [wbps=<bytes>] [riops=<iops>] [wiops=<iops>]
```

Each field is optional. `max` means no limit.

```bash
# Navigate to a cgroup (systemd slice example)
cd /sys/fs/cgroup/system.slice/myapp.service

# Limit read bandwidth to 100 MB/s, write to 50 MB/s on /dev/sda
echo "8:0 rbps=104857600 wbps=52428800" > io.max

# Limit to 1000 read IOPS and 500 write IOPS
echo "8:0 riops=1000 wiops=500" > io.max

# Combined: bandwidth and IOPS limits
echo "8:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500" > io.max

# Remove limits for a device (reset to max)
echo "8:0 rbps=max wbps=max riops=max wiops=max" > io.max

# View current io.max settings
cat io.max
# 8:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500
```

### io.max in Practice: Database Isolation

In a scenario with both a database (needing predictable I/O) and batch processing (flexible):

```bash
# Create cgroup hierarchy
mkdir -p /sys/fs/cgroup/database.slice
mkdir -p /sys/fs/cgroup/batch.slice

# Database: guarantee up to 200 MB/s read, 100 MB/s write
echo "8:0 rbps=209715200 wbps=104857600" > \
    /sys/fs/cgroup/database.slice/io.max

# Batch: limit to 50 MB/s read, 30 MB/s write so database is not crowded
echo "8:0 rbps=52428800 wbps=31457280" > \
    /sys/fs/cgroup/batch.slice/io.max

# Verify with fio benchmark
fio --filename=/data/testfile --direct=1 --rw=randread --bs=4k \
    --ioengine=libaio --iodepth=32 --numjobs=4 --runtime=30 \
    --group_reporting --name=test --output-format=terse

# Run inside cgroup and compare
systemd-run --slice=database.slice --scope \
    fio --filename=/data/testfile --direct=1 --rw=randread --bs=4k \
    --ioengine=libaio --iodepth=32 --numjobs=4 --runtime=30 \
    --group_reporting --name=test
```

### Reading io.stat for Monitoring

```bash
# io.stat shows actual usage
cat /sys/fs/cgroup/database.slice/io.stat
# 8:0 rbytes=1234567890 wbytes=567890123 rios=12345 wios=5678 dbytes=0 dios=0
# Fields: rbytes (read), wbytes (write), rios (read ops), wios (write ops)
# dbytes/dios: discard bytes/ops

# Monitor io.stat continuously
watch -n 1 cat /sys/fs/cgroup/database.slice/io.stat

# Parse with awk for per-second rates
# (run twice, take difference)
prev=$(cat /sys/fs/cgroup/database.slice/io.stat)
sleep 1
curr=$(cat /sys/fs/cgroup/database.slice/io.stat)
echo "$prev" | awk -v after="$curr" 'BEGIN{...}'  # Calculate delta
```

## io.weight: Proportional I/O Scheduling

While `io.max` imposes hard ceilings, `io.weight` provides proportional sharing. When multiple cgroups compete for the same device, available bandwidth is distributed proportionally to their weights.

### io.weight Basics

Weight range is 1 to 10000, default is 100.

```bash
# Set default weight for all devices
echo "default 200" > /sys/fs/cgroup/high-priority.slice/io.weight

# Set per-device weight
echo "8:0 500" > /sys/fs/cgroup/high-priority.slice/io.weight

# View current weights
cat /sys/fs/cgroup/high-priority.slice/io.weight
# default 200
# 8:0 500

# Low-priority cgroup
echo "default 50" > /sys/fs/cgroup/low-priority.slice/io.weight
```

With `high-priority.slice` at weight 500 and `low-priority.slice` at weight 50, the high-priority cgroup gets approximately 10x more I/O bandwidth when both are competing.

### Weight Proportional Distribution Example

Three cgroups competing for the same NVMe device:

```
database.slice:    io.weight = 800
application.slice: io.weight = 200
backup.slice:      io.weight = 100

Total weight: 1100
database gets:    800/1100 = 72.7%
application gets: 200/1100 = 18.2%
backup gets:      100/1100 =  9.1%
```

Importantly, if `database.slice` is idle, `application.slice` and `backup.slice` share the unused bandwidth proportionally — no bandwidth is wasted.

## io.bfq.weight: Budget Fair Queueing Weights

BFQ (Budget Fair Queueing) is an I/O scheduler that provides per-process/per-group fairness with low latency. When the BFQ scheduler is active on a device, `io.bfq.weight` controls the weights used by BFQ specifically.

### Verify BFQ is Active

```bash
# Check which scheduler is used for a device
cat /sys/block/sda/queue/scheduler
# [mq-deadline] kyber bfq none

# Check for NVMe
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# Switch to BFQ (requires root)
echo bfq > /sys/block/sda/queue/scheduler

# Verify
cat /sys/block/sda/queue/scheduler
# mq-deadline kyber [bfq] none
```

### io.bfq.weight Configuration

```bash
# Set BFQ weight (separate from io.weight)
echo "default 200" > /sys/fs/cgroup/database.slice/io.bfq.weight
echo "8:0 500" > /sys/fs/cgroup/database.slice/io.bfq.weight

# View BFQ weights
cat /sys/fs/cgroup/database.slice/io.bfq.weight
# default 200
# 8:0 500
```

BFQ provides better latency guarantees than the CFQ/deadline schedulers because it tracks the budget each process or cgroup uses and adjusts scheduling accordingly. Processes that do small, sequential I/O (like interactive applications) receive scheduling priority over bulk I/O workloads, even at the same weight.

### BFQ Weight Classes

BFQ supports three weight classes that override the proportional weights:

```bash
# Weight class is set through the ionice command
# Class 1: Realtime - highest priority
# Class 2: Best-effort - default, uses weight
# Class 3: Idle - only gets I/O when no other cgroup needs it

# For a process inside a cgroup:
ionice -c 1 -n 0 dd if=/dev/sda of=/dev/null bs=1M  # Realtime, highest priority
ionice -c 2 -n 4 backup_script.sh                    # Best-effort, normal weight
ionice -c 3 indexing_job.sh                          # Idle, only when free
```

## io.latency: Latency Targets

The `io.latency` controller allows specifying a target latency. When the cgroup's I/O latency exceeds the target, the kernel throttles competing cgroups to restore the target.

```bash
# Set a 10ms target latency for database operations
echo "8:0 target=10000" > /sys/fs/cgroup/database.slice/io.latency
# target value is in microseconds

# 1ms latency target for latency-sensitive NVMe workload
echo "259:0 target=1000" > /sys/fs/cgroup/realtime.slice/io.latency

# View current latency target
cat /sys/fs/cgroup/database.slice/io.latency
# 8:0 target=10000
```

When `io.latency` is set, the kernel uses a feedback loop: if the cgroup's measured latency exceeds the target, it throttles lower-priority cgroups to free up I/O capacity. This is a "best effort" target, not a hard guarantee.

### Monitoring io.latency Achievement

```bash
# io.stat shows latency metrics when io.latency is configured
cat /sys/fs/cgroup/database.slice/io.stat
# 8:0 rbytes=... wbytes=... rios=... wios=... wait_time_us=... target_latency_us=10000

# Check if latency target is being met using bpftrace
bpftrace -e '
tracepoint:block:block_io_done
{
    @latency_us = hist(nsecs - @start[$1]) / 1000;
}
tracepoint:block:block_bio_queue
{
    @start[$1] = nsecs;
}
interval:s:1
{
    print(@latency_us);
    clear(@latency_us);
}'
```

## Writeback Throttling

Dirty page writeback is a major source of I/O latency spikes. When the kernel flushes dirty pages to disk, it can saturate the I/O subsystem and cause high latency for all other I/O.

### Understanding Writeback in cgroups v2

In cgroups v2, writeback is attributed to the cgroup that dirtied the pages. This means writeback bandwidth counts against the cgroup's `io.max` limit:

```bash
# Dirty ratio controls (system-wide, not per-cgroup)
sysctl vm.dirty_ratio            # Default: 20 (% of RAM)
sysctl vm.dirty_background_ratio # Default: 10 (% of RAM)

# Per-cgroup dirty throttling via memory.high and memory.max
# When a cgroup's memory usage approaches memory.high,
# processes are slowed down proportionally (including writeback)

# Set memory.high to limit dirty page accumulation
echo "2G" > /sys/fs/cgroup/batch.slice/memory.high

# Verify writeback is attributed correctly
cat /sys/fs/cgroup/batch.slice/io.stat
# Shows wbytes which includes writeback
```

### Throttling Writeback with io.max

Since writeback counts against the cgroup's write bandwidth, `io.max wbps` effectively throttles writeback too:

```bash
# Batch backup job: limit write bandwidth including writeback to 20 MB/s
echo "8:0 wbps=20971520" > /sys/fs/cgroup/backup.slice/io.max

# Monitor writeback activity
grep -r . /proc/sys/vm/dirty_* 2>/dev/null

# Watch writeback via /proc/vmstat
watch -n 1 'grep -E "nr_dirty|nr_writeback|pgpgin|pgpgout" /proc/vmstat'
```

### Forcing Synchronous Writeback to Avoid Bursts

For workloads that need predictable I/O (not bursty), use O_SYNC or O_DSYNC to write data directly to disk without buffering:

```go
package main

import (
    "os"
    "syscall"
)

func openSyncFile(path string) (*os.File, error) {
    // O_DSYNC: writes wait until data is on disk (not metadata)
    // This prevents writeback-caused I/O spikes
    fd, err := syscall.Open(path,
        syscall.O_WRONLY|syscall.O_CREATE|syscall.O_DSYNC, 0644)
    if err != nil {
        return nil, err
    }
    return os.NewFile(uintptr(fd), path), nil
}
```

## Container I/O Isolation with cgroups v2

Container runtimes (containerd, Docker with cgroups v2 backend) expose IO controller parameters through their configuration and Kubernetes resource specs.

### Kubernetes Pod I/O Configuration

Kubernetes does not currently expose `io.max` directly in pod specs. However, you can configure it via cgroup v2 parameters through device plugins or by setting it at the node level per workload class.

The practical approach is using systemd slice configuration:

```ini
# /etc/systemd/system/kubepods-burstable.slice.d/io-throttle.conf
[Slice]
# Apply to all burstable pods
IOReadBandwidthMax=/dev/sda 104857600    # 100 MB/s read
IOWriteBandwidthMax=/dev/sda 52428800    # 50 MB/s write
IOWeight=100                             # Default weight
```

```bash
# Apply systemd configuration
systemctl daemon-reload
systemctl restart kubelet

# Verify it took effect
systemctl cat kubepods-burstable.slice
```

### containerd I/O Configuration

containerd supports cgroup v2 IO parameters via its runtime spec:

```json
{
  "linux": {
    "resources": {
      "blockIO": {
        "weight": 100,
        "throttleReadBpsDevice": [
          {
            "major": 8,
            "minor": 0,
            "rate": 104857600
          }
        ],
        "throttleWriteBpsDevice": [
          {
            "major": 8,
            "minor": 0,
            "rate": 52428800
          }
        ],
        "throttleReadIOPSDevice": [
          {
            "major": 8,
            "minor": 0,
            "rate": 1000
          }
        ],
        "throttleWriteIOPSDevice": [
          {
            "major": 8,
            "minor": 0,
            "rate": 500
          }
        ]
      }
    }
  }
}
```

### Direct cgroup v2 Management for Containers

For containers that need precise I/O control and where the runtime doesn't expose the parameters:

```bash
#!/bin/bash
# Script to apply IO limits to a running container

CONTAINER_ID=$1
DEVICE="8:0"  # /dev/sda

# Find the container's cgroup path
CGROUP_PATH=$(docker inspect --format '{{.HostConfig.CgroupParent}}' $CONTAINER_ID)
# Or find it via:
CGROUP_PATH=$(cat /proc/$(docker inspect --format '{{.State.Pid}}' $CONTAINER_ID)/cgroup | \
    grep "0::" | cut -d: -f3)

IO_CGROUP="/sys/fs/cgroup${CGROUP_PATH}"
echo "Container cgroup: $IO_CGROUP"

# Apply limits
echo "${DEVICE} rbps=104857600 wbps=52428800" > "${IO_CGROUP}/io.max"
echo "default 100" > "${IO_CGROUP}/io.weight"

# Verify
echo "io.max:"
cat "${IO_CGROUP}/io.max"
echo "io.weight:"
cat "${IO_CGROUP}/io.weight"
```

## Observability: Monitoring I/O Controller Effectiveness

### eBPF-Based I/O Monitoring

```bash
# Use bcc's biotop to monitor I/O by process
biotop -C 1 10   # 1 second interval, 10 iterations

# Use bpftrace to track I/O latency per cgroup
bpftrace -e '
#include <linux/blkdev.h>
tracepoint:block:block_bio_queue
{
    @start[args->sector] = nsecs;
}
tracepoint:block:block_bio_complete
/@start[args->sector]/
{
    $lat = (nsecs - @start[args->sector]) / 1000000;
    @ms = lhist($lat, 0, 100, 1);
    delete(@start[args->sector]);
}
interval:s:5
{
    print(@ms);
    clear(@ms);
}'
```

### Prometheus Metrics for cgroups v2 I/O

The `node_exporter` exposes cgroups v2 metrics when configured:

```yaml
# node_exporter configuration
# Enable cgroup collector
--collector.cgroups

# Relevant metrics exposed:
# node_cgroup_blkio_io_merged_total
# node_cgroup_blkio_io_queued_total
# node_cgroup_blkio_io_service_bytes_total
# node_cgroup_blkio_io_service_time_total
# node_cgroup_blkio_io_serviced_total
```

Custom monitoring script for io.stat:

```bash
#!/bin/bash
# Expose cgroups v2 io.stat metrics in Prometheus format

METRIC_FILE="/var/lib/node_exporter/cgroup_io.prom"

(
echo "# HELP cgroup_io_read_bytes_total Total read bytes for cgroup"
echo "# TYPE cgroup_io_read_bytes_total counter"

find /sys/fs/cgroup -name "io.stat" 2>/dev/null | while read statfile; do
    cgroup=$(dirname "$statfile" | sed 's|/sys/fs/cgroup||')
    while IFS=' ' read -r device rest; do
        # Parse device major:minor
        major=$(echo "$device" | cut -d: -f1)
        minor=$(echo "$device" | cut -d: -f2)

        rbytes=$(echo "$rest" | grep -oP 'rbytes=\K\d+')
        wbytes=$(echo "$rest" | grep -oP 'wbytes=\K\d+')
        rios=$(echo "$rest" | grep -oP 'rios=\K\d+')
        wios=$(echo "$rest" | grep -oP 'wios=\K\d+')

        cgroup_label=$(echo "$cgroup" | tr '/' '_')
        echo "cgroup_io_read_bytes_total{cgroup=\"${cgroup}\",major=\"${major}\",minor=\"${minor}\"} ${rbytes:-0}"
        echo "cgroup_io_write_bytes_total{cgroup=\"${cgroup}\",major=\"${major}\",minor=\"${minor}\"} ${wbytes:-0}"
        echo "cgroup_io_read_ops_total{cgroup=\"${cgroup}\",major=\"${major}\",minor=\"${minor}\"} ${rios:-0}"
        echo "cgroup_io_write_ops_total{cgroup=\"${cgroup}\",major=\"${major}\",minor=\"${minor}\"} ${wios:-0}"
    done < "$statfile"
done
) > "$METRIC_FILE"
```

## Systemd Integration

systemd natively supports cgroups v2 IO controller parameters in service and slice units:

```ini
# /etc/systemd/system/database.service
[Unit]
Description=Database Service

[Service]
ExecStart=/usr/bin/postgres -D /var/lib/pgsql/data

# I/O settings
IOWeight=500
IOReadBandwidthMax=/dev/sda 200M
IOWriteBandwidthMax=/dev/sda 100M
IOReadIOPSMax=/dev/sda 5000
IOWriteIOPSMax=/dev/sda 2000
IODeviceLatencyTargetSec=/dev/sda 10ms

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/batch-jobs.slice
[Slice]
IOWeight=50
IOReadBandwidthMax=/dev/sda 50M
IOWriteBandwidthMax=/dev/sda 20M
```

```bash
# Apply changes
systemctl daemon-reload
systemctl restart database.service

# Verify IO settings are applied to the cgroup
systemctl show database.service | grep -i io
# IOWeight=500
# IOReadBandwidthMax=/dev/sda 209715200
```

## Troubleshooting IO Controller Issues

### Common Issues

**Issue: io.max limits not enforced**

```bash
# Verify the IO controller is enabled in the cgroup hierarchy
cat /sys/fs/cgroup/cgroup.subtree_control
# Must include "io"

# Enable io controller if missing
echo "+io" > /sys/fs/cgroup/cgroup.subtree_control

# Check parent cgroup also has io enabled
cat /sys/fs/cgroup/system.slice/cgroup.subtree_control
```

**Issue: BFQ weights not working**

```bash
# Verify BFQ is the active scheduler
cat /sys/block/sda/queue/scheduler
# Must show [bfq]

# io.bfq.weight only works with BFQ scheduler
# io.weight works with any scheduler that supports cgroup v2 IO
```

**Issue: High latency despite io.latency setting**

```bash
# io.latency is a best-effort target, not hard guarantee
# Check io.stat for actual vs target
cat /sys/fs/cgroup/myapp.slice/io.stat

# Check for competing cgroups using iostat
iostat -x 1 5 /dev/sda
# Look for high %util (device utilization)

# Reduce competing cgroups' io.max to give headroom
```

## Summary

The cgroups v2 IO controller provides a comprehensive toolkit for I/O isolation:

- `io.max`: Hard limits on read/write bandwidth (bytes/s) and IOPS per device
- `io.weight`: Proportional sharing when multiple cgroups compete; unused bandwidth is redistributed
- `io.bfq.weight`: BFQ-specific weights that improve latency fairness for interactive workloads
- `io.latency`: Feedback-based throttling to protect latency-sensitive cgroups from noisy neighbors
- Writeback throttling happens automatically when `io.max wbps` is set; dirty pages from the cgroup are subject to the same limit
- systemd exposes all these parameters as first-class service/slice directives
- Container runtimes expose a subset through their runtime specs; direct cgroup manipulation fills the gaps
