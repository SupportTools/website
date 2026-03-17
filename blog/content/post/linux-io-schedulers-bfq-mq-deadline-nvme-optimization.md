---
title: "Linux IO Schedulers: BFQ, mq-deadline, and NVMe Optimization"
date: 2031-01-18T00:00:00-05:00
draft: false
tags: ["Linux", "IO", "Storage", "NVMe", "Performance", "Kernel", "Kubernetes", "io_uring"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux IO schedulers covering block layer architecture, BFQ vs mq-deadline vs none schedulers, NVMe queue depth configuration, io_uring for async I/O, scheduler selection for different storage types, and Kubernetes storage class I/O tuning."
more_link: "yes"
url: "/linux-io-schedulers-bfq-mq-deadline-nvme-optimization/"
---

The Linux block I/O layer sits between filesystems and block device drivers, and the scheduler within that layer has a significant impact on both throughput and latency. With modern NVMe drives that can handle thousands of concurrent operations, the question is no longer just which scheduler to use but whether to use a scheduler at all. Understanding when BFQ provides quality-of-service guarantees, when mq-deadline minimizes latency for databases, and when the `none` scheduler maximizes NVMe throughput guides storage tuning decisions that can dramatically improve application performance.

<!--more-->

# Linux IO Schedulers: BFQ, mq-deadline, and NVMe Optimization

## Section 1: Linux Block Layer Architecture

### The Multiqueue Block Layer (blk-mq)

Linux introduced the multiqueue block layer (blk-mq) in kernel 3.13, replacing the single-queue design that predated NVMe. blk-mq maps software queues to hardware dispatch queues:

```
Application
    |
    v
VFS (Virtual Filesystem)
    |
    v
Filesystem (ext4, xfs, btrfs)
    |
    v
Page Cache
    |
    v
Block Device Layer (blk-mq)
    |
    ├── Software Queue (per-CPU)
    │       |
    │       v
    │   IO Scheduler (BFQ, mq-deadline, none)
    │       |
    │       v
    ├── Hardware Dispatch Queue 1 ──► NVMe Queue 1
    ├── Hardware Dispatch Queue 2 ──► NVMe Queue 2
    ├── Hardware Dispatch Queue N ──► NVMe Queue N
    |
    v
NVMe Controller (hardware)
```

### Viewing Block Device Queues

```bash
# List all block devices and their queue depths
lsblk -d -o NAME,SCHED,RQ-SIZE,RA

# Detailed device information
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline bfq
# (brackets = currently active scheduler)

# Hardware queue count
ls /sys/block/nvme0n1/mq/
# 0  1  2  3  4  5  6  7  (8 hardware queues)

# Queue depth per hardware queue
cat /sys/block/nvme0n1/queue/nr_requests
# 64 (default, can be increased for NVMe)

# Maximum sector size
cat /sys/block/nvme0n1/queue/max_sectors_kb

# Physical block size (affects optimal I/O alignment)
cat /sys/block/nvme0n1/queue/physical_block_size

# Read-ahead size in KB
cat /sys/block/nvme0n1/queue/read_ahead_kb
```

## Section 2: IO Scheduler Profiles

### none / noop - No Scheduling

The `none` scheduler (called `noop` in older kernels) merges adjacent I/O requests but performs no reordering:

```bash
# Set scheduler to none
echo none > /sys/block/nvme0n1/queue/scheduler

# When to use none:
# - NVMe SSDs with hardware queue depths > 32
# - Storage arrays with their own internal scheduling
# - Virtual disks backed by fast storage (cloud VMs)
# - When latency variance is more important than throughput

# Performance characteristics:
# - Lowest CPU overhead
# - Lowest scheduling latency overhead
# - No fairness guarantees
# - Best for: NVMe, RAM-based storage, cloud SSDs
```

### mq-deadline - Latency-Bounded Scheduling

`mq-deadline` ensures that no I/O request waits longer than a configurable deadline:

```bash
# Set scheduler to mq-deadline
echo mq-deadline > /sys/block/sda/queue/scheduler

# View and tune parameters
cat /sys/block/sda/queue/iosched/read_expire
# 500 (milliseconds - default 500ms for reads)
cat /sys/block/sda/queue/iosched/write_expire
# 5000 (milliseconds - default 5000ms for writes)
cat /sys/block/sda/queue/iosched/writes_starved
# 2 (allow 2 read batches before forcing a write batch)
cat /sys/block/sda/queue/iosched/front_merges
# 1 (allow front merges for sequential reads)

# Tune for database workloads (reduce read deadline for lower read latency)
echo 100 > /sys/block/sda/queue/iosched/read_expire
echo 1000 > /sys/block/sda/queue/iosched/write_expire

# For SSD: reduce write starvation limit (SSDs don't benefit from write batching)
echo 1 > /sys/block/sda/queue/iosched/writes_starved

# When to use mq-deadline:
# - HDD-backed storage (prevents write starvation)
# - SSD but not NVMe (provides deadline guarantees without overhead)
# - Database workloads requiring bounded read latency
# - Mixed read/write workloads on spinning media
```

### BFQ - Budget Fair Queueing

BFQ (Budget Fair Queueing) provides proportional-share I/O scheduling with quality-of-service guarantees. Each process or control group gets a fair share of I/O bandwidth:

```bash
# Set scheduler to BFQ
echo bfq > /sys/block/sda/queue/scheduler

# BFQ parameters
cat /sys/block/sda/queue/iosched/slice_idle
# 8 (ms idle before switching to another queue)
cat /sys/block/sda/queue/iosched/max_budget
# 0 (0 = auto, limits budget per slice)
cat /sys/block/sda/queue/iosched/low_latency
# 1 (prioritize interactive workloads)

# Enable strict policy for stronger guarantees
echo 1 > /sys/block/sda/queue/iosched/strict_guarantees

# BFQ cgroup integration - set weights
cat /sys/fs/cgroup/blkio/blkio.bfq.weight
# 500 (default weight, range 1-1000)

# Set weight for specific cgroup
echo 800 > /sys/fs/cgroup/blkio/high-priority/blkio.bfq.weight
echo 200 > /sys/fs/cgroup/blkio/background/blkio.bfq.weight

# When to use BFQ:
# - HDD for desktop/server with mixed workloads needing fairness
# - Multi-tenant systems needing I/O isolation between users
# - Latency-sensitive interactive applications alongside batch I/O
# - Kubernetes nodes running I/O-intensive mixed workloads
```

### Scheduler Comparison Summary

```
Scheduler   | CPU Overhead | Latency | Fairness | Best For
------------|-------------|---------|----------|----------------------------------
none        | Minimal     | Lowest  | None     | NVMe, fast SSDs, cloud VMs
mq-deadline | Low         | Bounded | Limited  | HDD, SATA SSD, databases
bfq         | Medium      | Good    | Yes      | Mixed workloads, multi-tenant
```

## Section 3: NVMe Queue Depth Configuration

NVMe drives support massively parallel I/O. Getting the queue configuration right is critical for throughput.

```bash
# Check NVMe queue count (should match CPU core count or drive capability)
ls /sys/block/nvme0n1/mq/
# Shows one directory per hardware queue

# NVMe namespace queue size (should be set to drive's rated IOQ depth)
cat /sys/block/nvme0n1/queue/nr_requests
# 64 (default, often too low for high-throughput workloads)

# Increase queue depth for NVMe
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# For workloads with many concurrent small I/Os (OLTP database)
echo 2048 > /sys/block/nvme0n1/queue/nr_requests

# Check current queue utilization
cat /proc/diskstats | awk '{print $3, "in_flight:", $9}' | grep nvme

# NVMe-specific queue configuration
nvme id-ctrl /dev/nvme0 | grep -E "mdts|sqes|cqes"
# mdts: maximum data transfer size
# sqes: submission queue entry size
# cqes: completion queue entry size

# Check NVMe firmware queue depth
nvme id-ns /dev/nvme0n1 | grep nlbaf
```

### NVMe Namespace Queue Depth vs IO Depth

```bash
# fio benchmark to find optimal queue depth
fio \
    --name=nvme-queue-test \
    --ioengine=libaio \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --iodepth=1 \
    --numjobs=1 \
    --runtime=30s \
    --filename=/dev/nvme0n1 \
    --output-format=json+

# Test different queue depths: 1, 4, 8, 16, 32, 64, 128, 256
for depth in 1 4 8 16 32 64 128 256; do
    echo "Testing iodepth=${depth}"
    fio \
        --name=test-${depth} \
        --ioengine=io_uring \
        --direct=1 \
        --rw=randread \
        --bs=4k \
        --iodepth=${depth} \
        --numjobs=4 \
        --runtime=10s \
        --filename=/dev/nvme0n1 \
        --output-format=terse \
        | awk -F';' '{print "iodepth='$depth' IOPS="$8" BW="$7" lat_p99="$29}'
done
```

## Section 4: io_uring for High-Performance Async I/O

io_uring (introduced in Linux 5.1) provides a unified, kernel-resident ring buffer interface for async I/O, eliminating syscall overhead for high-throughput workloads.

```bash
# Verify io_uring is supported
cat /proc/kallsyms | grep io_uring_setup
# Non-empty output: supported

# Check io_uring capabilities
cat /sys/module/io_uring/parameters/io_uring_max_entries
```

### io_uring in Go with uring

While Go's standard library uses goroutines and the netpoller for async I/O (which is excellent for networking), storage-intensive applications can benefit from io_uring through CGO or by using libraries like `iceber/go-iouring`:

```go
// Example using iceber/go-iouring
package main

import (
	"fmt"
	"os"

	iouring "github.com/iceber/iouring-go"
)

func ioUringReadExample() error {
	// Create io_uring instance with 256 entries
	ring, err := iouring.New(256)
	if err != nil {
		return fmt.Errorf("create io_uring: %w", err)
	}
	defer ring.Close()

	// Open file
	f, err := os.Open("/data/large-file.bin")
	if err != nil {
		return err
	}
	defer f.Close()

	// Prepare multiple read requests
	bufSize := 4096
	bufs := make([][]byte, 16)
	requests := make([]iouring.PrepRequest, 16)

	for i := range bufs {
		bufs[i] = make([]byte, bufSize)
		offset := int64(i) * int64(bufSize)
		requests[i] = iouring.Pread(f, bufs[i], uint64(offset))
	}

	// Submit all requests at once
	results, err := ring.SubmitRequests(requests, nil)
	if err != nil {
		return fmt.Errorf("submit requests: %w", err)
	}

	// Collect results
	for result := range results {
		if err := result.Err(); err != nil {
			return fmt.Errorf("io operation failed: %w", err)
		}
		fmt.Printf("read %d bytes\n", result.ReturnValue0())
	}

	return nil
}
```

### io_uring with fio Benchmarking

```bash
# Benchmark libaio vs io_uring for random 4K reads
# libaio baseline
fio \
    --name=libaio-baseline \
    --ioengine=libaio \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --iodepth=64 \
    --numjobs=4 \
    --runtime=30s \
    --filename=/dev/nvme0n1

# io_uring
fio \
    --name=io-uring \
    --ioengine=io_uring \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --iodepth=64 \
    --numjobs=4 \
    --sqthread_poll=1 \  # io_uring kernel polling thread
    --runtime=30s \
    --filename=/dev/nvme0n1

# Expected: io_uring with sqthread_poll achieves lower latency
# and higher IOPS than libaio on fast NVMe due to eliminated
# syscall overhead in the polling path
```

## Section 5: Filesystem-Level I/O Tuning

### Mount Options Impact on I/O

```bash
# ext4 performance mount options
mount -o noatime,nodiratime,data=writeback,barrier=0 /dev/nvme0n1p1 /data
# noatime: don't update access time (eliminates write on every read)
# nodiratime: don't update dir access time
# data=writeback: don't journal data (only metadata), improves write throughput
# barrier=0: disable write barriers (UNSAFE without battery-backed cache)

# XFS performance mount options
mount -o noatime,nodiratime,largeio,inode64,allocsize=64m /dev/nvme0n1p1 /data
# largeio: prefer large I/O sizes
# inode64: allow inode numbers > 32-bit (important for large filesystems)
# allocsize=64m: pre-allocate in 64MB chunks (reduces fragmentation for streaming)

# For databases (PostgreSQL, MySQL): use direct I/O through O_DIRECT
# These databases manage their own page cache, so OS page cache is redundant
# Configure in the database, not at the mount level

# Check current mount options
findmnt -o TARGET,OPTIONS /data
```

### Filesystem Benchmarking

```bash
# Benchmark filesystem with fio (write then read)
fio \
    --name=fs-write \
    --ioengine=psync \
    --rw=write \
    --bs=1M \
    --numjobs=4 \
    --size=4G \
    --filename=/data/testfile \
    --fallocate=none \
    --end_fsync=1

fio \
    --name=fs-read \
    --ioengine=psync \
    --rw=read \
    --bs=1M \
    --numjobs=4 \
    --filename=/data/testfile \
    --runtime=30s

# Random 4K operations (typical database pattern)
fio \
    --name=random-4k \
    --ioengine=libaio \
    --direct=1 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4k \
    --iodepth=64 \
    --numjobs=8 \
    --size=8G \
    --filename=/data/testfile \
    --runtime=60s \
    --group_reporting
```

## Section 6: cgroup blkio/io.weight for Kubernetes Storage QoS

Kubernetes 1.25+ uses cgroup v2 and can apply I/O weight via the `io.weight` controller:

```yaml
# Kubernetes ResourceQuota doesn't directly control blkio weight,
# but nodes with cgroup v2 can be configured via device plugins
# or node-level configuration.

# For direct cgroup v2 configuration:
# /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/io.weight
# echo "default 500" > io.weight  # 500 = half weight of 1000
# echo "8:0 800" > io.weight      # override for specific device (major:minor)
```

```bash
# Check device major:minor numbers
ls -la /dev/nvme0n1
# brw-rw---- 1 root disk 259, 0 Jan 18 10:00 /dev/nvme0n1
# major=259, minor=0

# Set high I/O weight for database cgroup
echo "259:0 800" > /sys/fs/cgroup/kubepods/guaranteed/pod<uid>/io.weight

# Set low I/O weight for batch processing cgroup
echo "259:0 100" > /sys/fs/cgroup/kubepods/burstable/pod<batchuid>/io.weight
```

### StorageClass Configuration for I/O Optimization

```yaml
# StorageClass with XFS and optimized mount options for databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nvme-database
provisioner: ebs.csi.aws.com  # or your CSI driver
parameters:
  type: io2
  iops: "10000"
  throughput: "1000"
  fsType: xfs
  blockExpress: "true"  # io2 Block Express for higher IOPS
mountOptions:
  - noatime
  - nodiratime
  - largeio
  - inode64
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
---
# StorageClass for sequential streaming workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nvme-streaming
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  throughput: "1000"
  fsType: ext4
mountOptions:
  - noatime
  - nodiratime
  - data=ordered
  - barrier=1
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

## Section 7: I/O Scheduler Selection Script

```bash
#!/bin/bash
# set-io-scheduler.sh - Automatically select optimal I/O scheduler per device
set -euo pipefail

configure_device() {
    local device=$1
    local devname=$(basename $device)

    # Detect device type
    local rotational=$(cat /sys/block/${devname}/queue/rotational 2>/dev/null || echo "0")

    if [ "$rotational" = "1" ]; then
        # HDD: use BFQ for fairness
        SCHEDULER="bfq"
        NR_REQUESTS="128"
        READ_AHEAD_KB="2048"
        echo "${devname}: HDD detected, applying BFQ scheduler"
    else
        # SSD/NVMe: determine by queue count
        QUEUE_COUNT=$(ls /sys/block/${devname}/mq/ 2>/dev/null | wc -l)

        if [ "$QUEUE_COUNT" -gt "4" ]; then
            # NVMe or high-queue SSD: use none
            SCHEDULER="none"
            NR_REQUESTS="1024"
            READ_AHEAD_KB="128"
            echo "${devname}: NVMe/multi-queue SSD detected, applying none scheduler"
        else
            # Regular SSD: use mq-deadline
            SCHEDULER="mq-deadline"
            NR_REQUESTS="256"
            READ_AHEAD_KB="256"
            echo "${devname}: SATA SSD detected, applying mq-deadline scheduler"
        fi
    fi

    # Apply scheduler
    echo "${SCHEDULER}" > /sys/block/${devname}/queue/scheduler
    echo "${NR_REQUESTS}" > /sys/block/${devname}/queue/nr_requests
    echo "${READ_AHEAD_KB}" > /sys/block/${devname}/queue/read_ahead_kb

    # Disable add_random for SSDs (avoid polluting /dev/random with I/O events)
    if [ "$rotational" = "0" ]; then
        echo 0 > /sys/block/${devname}/queue/add_random
    fi

    echo "${devname}: scheduler=${SCHEDULER} nr_requests=${NR_REQUESTS} read_ahead_kb=${READ_AHEAD_KB}"
}

echo "=== I/O Scheduler Configuration ==="
for device in /sys/block/*/; do
    devname=$(basename $device)
    # Skip loop devices and device mapper
    if echo "$devname" | grep -qE "^(loop|dm|ram|zram)"; then
        continue
    fi
    configure_device "/dev/${devname}"
done
echo "=== Configuration Complete ==="
```

### Persistent Configuration with udev Rules

```bash
# /etc/udev/rules.d/60-io-schedulers.rules

# NVMe: none scheduler, high queue depth
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="none", ATTR{queue/nr_requests}="1024"

# SATA SSD: mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline", ATTR{queue/nr_requests}="256"

# HDD: BFQ
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq", ATTR{queue/nr_requests}="128"

# Apply rules
udevadm control --reload-rules
udevadm trigger
```

## Section 8: Kubernetes Storage I/O Monitoring

```bash
# Install node exporter with diskstats collector (enabled by default)
# Prometheus metrics:
# node_disk_reads_completed_total
# node_disk_writes_completed_total
# node_disk_read_bytes_total
# node_disk_write_bytes_total
# node_disk_io_time_seconds_total  (time spent doing I/O)
# node_disk_io_time_weighted_seconds_total  (queue depth * time = indicator of saturation)
```

```promql
# Disk utilization (% of time disk is busy)
rate(node_disk_io_time_seconds_total[5m]) * 100

# Disk read/write IOPS
rate(node_disk_reads_completed_total[5m])
rate(node_disk_writes_completed_total[5m])

# Disk throughput (MB/s)
rate(node_disk_read_bytes_total[5m]) / 1024 / 1024
rate(node_disk_write_bytes_total[5m]) / 1024 / 1024

# Average I/O queue depth (higher = more concurrent I/O or saturation)
rate(node_disk_io_time_weighted_seconds_total[5m])

# Alert: disk utilization above 80%
rate(node_disk_io_time_seconds_total[5m]) > 0.80
```

### Kubernetes Pod-Level I/O Monitoring

```bash
# cgroup v2 I/O stats per container
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/io.stat
# 259:0 rbytes=1073741824 wbytes=536870912 rios=262144 wios=131072 dbytes=0 dios=0

# Prometheus: container_fs_reads_bytes_total, container_fs_writes_bytes_total
# These metrics come from cAdvisor which reads cgroup io.stat
```

## Section 9: Database Storage Tuning

### PostgreSQL with NVMe

```bash
# PostgreSQL I/O optimization for NVMe storage
# /etc/postgresql/16/main/postgresql.conf

# Increase random_page_cost for NVMe (almost sequential access)
# Default 4.0 assumes HDD, NVMe is closer to sequential
random_page_cost = 1.1

# Effective cache size: total RAM + NVMe SSD cache capacity
effective_cache_size = 64GB  # Tune to available RAM

# Checkpoint tuning: spread writes over longer period
checkpoint_completion_target = 0.9
max_wal_size = 4GB
min_wal_size = 1GB

# I/O concurrency: number of concurrent I/O operations
# For NVMe: set to sqrt(queue_depth * 2)
effective_io_concurrency = 200  # NVMe can handle many concurrent ops
maintenance_io_concurrency = 100

# Direct I/O via pgdirect or wal_sync_method
wal_sync_method = fdatasync  # fsync | fdatasync | open_sync | open_datasync
```

### MySQL/InnoDB with NVMe

```ini
# /etc/mysql/mysql.conf.d/mysqld.cnf

# I/O capacity: max I/O operations per second for background work
innodb_io_capacity = 10000          # For NVMe (default 200 is for HDD)
innodb_io_capacity_max = 40000      # Peak I/O capacity

# Read/write threads
innodb_read_io_threads = 16         # Increase for NVMe
innodb_write_io_threads = 16

# Use O_DIRECT to bypass OS page cache for data files
# (InnoDB has its own buffer pool)
innodb_flush_method = O_DIRECT

# For NVMe with many hardware queues
innodb_use_native_aio = ON
```

The choice of I/O scheduler, queue depth, and storage configuration together determine whether your storage subsystem becomes a bottleneck. The principle is straightforward: match the scheduler to the storage hardware characteristics, give NVMe the deep queues it needs, and monitor the metrics that reveal when the storage layer is saturated before it becomes a production incident.
