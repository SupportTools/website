---
title: "Linux I/O Scheduler Tuning: NVMe vs HDD, fio Benchmarking, and Kubernetes Storage Optimization"
date: 2028-06-01T00:00:00-05:00
draft: false
tags: ["Linux", "I/O Scheduler", "Storage", "NVMe", "fio", "Kubernetes", "Performance"]
categories: ["Linux", "System Administration", "Storage", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux I/O scheduler selection for NVMe and HDD: comparing mq-deadline, kyber, none, and BFQ schedulers with fio benchmarks and Kubernetes storage performance optimization techniques."
more_link: "yes"
url: "/linux-io-scheduler-storage-tuning-guide/"
---

The Linux I/O scheduler determines how kernel I/O requests are ordered and dispatched to storage devices. Selecting the wrong scheduler for your storage hardware can halve throughput or triple latency. With the proliferation of NVMe SSDs in Kubernetes node configurations, the traditional advice of "use CFQ/BFQ for rotational drives" has been largely superseded — but the interaction between I/O scheduler, queue depth, and workload characteristics still requires careful tuning. This guide covers the modern Linux multi-queue block layer schedulers, measurement methodology with `fio`, and node-level tuning for Kubernetes storage workloads.

<!--more-->

## Linux Multi-Queue Block Layer Architecture

The modern Linux block layer (blk-mq, introduced in 3.13) uses a two-level queue architecture:

```
Application I/O
      ↓
Software Queues (per-CPU)
      ↓
I/O Scheduler (operates on software queues)
      ↓
Hardware Dispatch Queues (mapped to NVMe queues or HBA queues)
      ↓
Storage Device
```

This replaces the legacy single-queue architecture that was the bottleneck for NVMe devices capable of millions of IOPS.

### Available Schedulers

```bash
# List available schedulers for a device
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq
# The bracketed entry is the current scheduler

# For a SATA SSD
cat /sys/block/sda/queue/scheduler
# [mq-deadline] none kyber bfq
```

| Scheduler | Best For | Notes |
|-----------|----------|-------|
| `none` | NVMe SSDs with HW queues | Zero overhead, device handles ordering |
| `mq-deadline` | SATA SSDs, mixed workloads | Deadline-driven fairness, low overhead |
| `kyber` | NVMe with latency targets | Token-bucket per I/O priority class |
| `bfq` | HDDs, desktop/shared systems | Full fair queuing, high CPU overhead |

## Checking Current Configuration

```bash
# Complete storage hardware inventory
lsblk -d -o NAME,TYPE,ROTA,SCHED,SIZE,MODEL,TRAN
# NAME  TYPE ROTA SCHED       SIZE MODEL             TRAN
# sda   disk    1 bfq         2T   ST2000LM015-2E81  sata   ← HDD
# nvme0 disk    0 none      960G   Samsung MZ-V8P1T0 nvme   ← NVMe
# nvme1 disk    0 none      960G   Samsung MZ-V8P1T0 nvme   ← NVMe

# ROTA=1 means rotational (HDD), ROTA=0 means non-rotational (SSD/NVMe)

# Queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# 1023

# Number of hardware queues
cat /sys/block/nvme0n1/mq/count
# 16  ← this NVMe device has 16 hardware submission queues

# Current queue statistics
cat /proc/diskstats | awk '$3=="nvme0n1"'
# 259 0 nvme0n1 reads_completed reads_merged sectors_read time_reading ...

# Real-time I/O stats
iostat -x nvme0n1 1
```

## I/O Scheduler Deep Dive

### `none` (Passthrough)

The `none` scheduler performs no I/O reordering — requests go directly to the device's hardware dispatch queue. This is the correct choice for NVMe devices that have their own internal hardware schedulers and support multiple parallel queues.

```bash
# Set none scheduler on NVMe device
echo none > /sys/block/nvme0n1/queue/scheduler

# Verify
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# There are no tunable parameters for the none scheduler
# The device's hardware queue depth is the only relevant parameter
cat /sys/block/nvme0n1/queue/nr_requests
```

**When to use**: Any NVMe device, enterprise SSDs with internal wear-leveling, devices with IOPS >100k.

### `mq-deadline`

`mq-deadline` is a modernized version of the classic `deadline` scheduler. It maintains separate read and write queues and ensures no I/O request waits longer than a configurable deadline. It performs merge optimization to combine adjacent requests.

```bash
echo mq-deadline > /sys/block/sda/queue/scheduler

# Tunable parameters
ls /sys/block/sda/queue/iosched/
# async_depth  fifo_batch  front_merges  read_expire  write_expire  writes_starved

# Read deadline (milliseconds, default: 500ms)
cat /sys/block/sda/queue/iosched/read_expire
echo 250 > /sys/block/sda/queue/iosched/read_expire

# Write deadline (default: 5000ms)
echo 3000 > /sys/block/sda/queue/iosched/write_expire

# How many reads to allow before letting a write through
# (prevents write starvation)
cat /sys/block/sda/queue/iosched/writes_starved
echo 3 > /sys/block/sda/queue/iosched/writes_starved

# Batch size for deadline expiration processing
echo 16 > /sys/block/sda/queue/iosched/fifo_batch
```

**When to use**: SATA SSDs, mixed read/write OLTP workloads, environments where write latency must be bounded.

### `kyber`

Kyber uses a token-bucket algorithm with separate queues for reads and syncs. It targets configurable latency goals by throttling I/O that would cause queue saturation.

```bash
echo kyber > /sys/block/nvme0n1/queue/scheduler

# Kyber latency targets (nanoseconds)
cat /sys/block/nvme0n1/queue/iosched/read_lat_nsec
# 2000000  (2ms default)
echo 500000 > /sys/block/nvme0n1/queue/iosched/read_lat_nsec  # Target 500µs

cat /sys/block/nvme0n1/queue/iosched/write_lat_nsec
# 10000000  (10ms default)
echo 2000000 > /sys/block/nvme0n1/queue/iosched/write_lat_nsec
```

**When to use**: NVMe devices in latency-sensitive workloads where you want the scheduler to enforce latency targets. Less effective than `none` for pure throughput.

### `bfq` (Budget Fair Queuing)

BFQ assigns budgets (in number of sectors) to processes and ensures proportional share of disk bandwidth. It's designed for interactive desktop workloads and HDDs where physical seek optimization matters.

```bash
echo bfq > /sys/block/sda/queue/scheduler

# BFQ parameters
ls /sys/block/sda/queue/iosched/
# back_seek_max  back_seek_penalty  fifo_expire_async  fifo_expire_sync
# low_latency  max_budget  slice_idle  strict_guarantees  timeout_sync

# Slice idle: time to wait for more I/O from the same process
# Increase for spinning disks to improve seek patterns
echo 8 > /sys/block/sda/queue/iosched/slice_idle  # 8ms for HDDs

# Enable low latency mode for mixed read/write
echo 1 > /sys/block/sda/queue/iosched/low_latency

# BFQ weight for a specific process (cgroup integration)
# Set via cgroups blkio controller:
# echo "8:0 300" > /sys/fs/cgroup/blkio/my-service/blkio.bfq.weight_device
```

**When to use**: HDDs, when I/O fairness between competing processes matters, desktop systems with interactive applications.

## Benchmarking with fio

`fio` is the definitive Linux I/O benchmark tool. Proper benchmarking requires understanding which access pattern matches your workload.

### Install fio

```bash
# RHEL/CentOS
dnf install fio -y

# Debian/Ubuntu
apt-get install fio -y

# Version check
fio --version
# fio-3.35
```

### Sequential Read Throughput

```bash
# Test sequential read throughput (simulates large file reads, backup restore)
fio \
  --name=seq-read \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=read \
  --bs=1M \
  --direct=1 \
  --size=10G \
  --filename=/dev/nvme0n1 \
  --runtime=60 \
  --time_based \
  --output-format=json \
  --output=seq-read-results.json

# Quick readable output
fio --name=seq-read --ioengine=libaio --iodepth=32 --rw=read \
  --bs=1M --direct=1 --size=10G --filename=/dev/nvme0n1 --runtime=30 \
  --time_based 2>&1 | grep -E "READ:|WRITE:"
```

### Random 4K IOPS (Most Important for Databases)

```bash
# Random read IOPS — critical for database random reads, Kubernetes etcd
fio \
  --name=rand-read-4k \
  --ioengine=libaio \
  --iodepth=64 \
  --rw=randread \
  --bs=4k \
  --direct=1 \
  --size=10G \
  --filename=/dev/nvme0n1 \
  --runtime=60 \
  --time_based \
  --numjobs=4 \
  --group_reporting

# Mixed read/write (simulates database checkpoint)
fio \
  --name=mixed-rw-4k \
  --ioengine=libaio \
  --iodepth=64 \
  --rw=randrw \
  --rwmixread=70 \
  --bs=4k \
  --direct=1 \
  --size=10G \
  --filename=/dev/nvme0n1 \
  --runtime=60 \
  --time_based \
  --numjobs=4 \
  --group_reporting
```

### Latency Profile

```bash
# Measure I/O latency distribution — critical for identifying tail latency
fio \
  --name=latency-profile \
  --ioengine=libaio \
  --iodepth=1 \
  --rw=randread \
  --bs=4k \
  --direct=1 \
  --size=10G \
  --filename=/dev/nvme0n1 \
  --runtime=60 \
  --time_based \
  --lat_percentiles=1 \
  --percentile_list=50:90:95:99:99.9:99.99

# Expected NVMe output:
# clat percentiles (usec):
#   |  1.00th=[   70],  5.00th=[   81],
#   | 10.00th=[   87], 20.00th=[   95],
#   | 30.00th=[  100], 40.00th=[  106],
#   | 50.00th=[  113], 60.00th=[  120],
#   | 70.00th=[  130], 80.00th=[  143],
#   | 90.00th=[  167], 95.00th=[  190],
#   | 99.00th=[  258], 99.50th=[  302],
#   | 99.90th=[  445], 99.95th=[  644],
#   | 99.99th=[ 1172]
```

### Scheduler Comparison Script

```bash
#!/bin/bash
# compare-schedulers.sh

DEVICE="${1:-/dev/nvme0n1}"
ROTA=$(cat /sys/block/$(basename $DEVICE)/queue/rotational)
SCHEDULERS="none mq-deadline kyber"
[[ "$ROTA" == "1" ]] && SCHEDULERS="mq-deadline bfq"

results=()

for SCHEDULER in $SCHEDULERS; do
    echo "Testing scheduler: $SCHEDULER"
    echo "$SCHEDULER" > /sys/block/$(basename $DEVICE)/queue/scheduler

    IOPS=$(fio \
        --name=rand-read \
        --ioengine=libaio \
        --iodepth=32 \
        --rw=randread \
        --bs=4k \
        --direct=1 \
        --size=4G \
        --filename="$DEVICE" \
        --runtime=30 \
        --time_based \
        --output-format=json \
        2>/dev/null | \
        python3 -c "
import json, sys
d = json.load(sys.stdin)
j = d['jobs'][0]['read']
print(f'{j[\"iops_mean\"]:.0f} iops, {j[\"lat_ns\"][\"mean\"]/1000:.1f}us mean lat')
")
    results+=("$SCHEDULER: $IOPS")
    echo "  $SCHEDULER: $IOPS"
done

echo ""
echo "=== Summary ==="
printf '%s\n' "${results[@]}"
```

### fio Job File for Kubernetes etcd Workload

```ini
# etcd-benchmark.fio
[global]
ioengine=libaio
direct=1
iodepth=64
bs=4k
filename=/dev/nvme0n1
runtime=300
time_based=1
group_reporting=1
lat_percentiles=1

[etcd-reads]
rw=randread
size=4G
numjobs=4

[etcd-writes]
rw=randwrite
size=4G
numjobs=2
fsync=1  # etcd uses fsync for durability
```

## Queue Depth Tuning

Queue depth (nr_requests) affects throughput vs. latency trade-off:

```bash
# Current queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# 1023

# Lower for latency-sensitive workloads
echo 32 > /sys/block/nvme0n1/queue/nr_requests

# Measure impact
fio --name=qd-test --ioengine=libaio --iodepth=32 --rw=randread \
  --bs=4k --direct=1 --size=4G --filename=/dev/nvme0n1 --runtime=10 \
  --time_based 2>&1 | grep "iops"

# For NVMe with high IOPS, higher depth may improve throughput
echo 512 > /sys/block/nvme0n1/queue/nr_requests
```

## Persistent Configuration with udev

Runtime changes via sysfs are reset on reboot. Use udev rules for persistence:

```bash
# /etc/udev/rules.d/60-io-scheduler.rules

# NVMe SSDs: use none scheduler (no reordering)
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/rotational}=="0", \
  ATTR{queue/scheduler}="none", \
  ATTR{queue/nr_requests}="256"

# SATA SSDs: use mq-deadline with tuned parameters
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", \
  ATTR{queue/scheduler}="mq-deadline", \
  ATTR{queue/iosched/read_expire}="250", \
  ATTR{queue/iosched/write_expire}="3000", \
  ATTR{queue/nr_requests}="128"

# HDDs: use bfq with seek optimization
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", \
  ATTR{queue/scheduler}="bfq", \
  ATTR{queue/iosched/slice_idle}="8", \
  ATTR{queue/nr_requests}="64"
```

```bash
# Apply udev rules without rebooting
udevadm control --reload-rules
udevadm trigger --type=devices --action=change --subsystem-match=block

# Verify
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq
```

## Kubernetes Storage Optimization

### StorageClass with I/O Configuration

```yaml
# storageclass-high-iops.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: high-iops-nvme
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: io2
  iopsPerGB: "50"
  throughput: "500"
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
---
# For databases needing fsync performance
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: database-storage
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: io2Block
  iopsPerGB: "64"  # Maximum for io2 Block Express
```

### Node-Level Tuning via DaemonSet

```yaml
# io-tuner-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: io-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: io-tuner
  template:
    metadata:
      labels:
        app: io-tuner
    spec:
      hostPID: true
      hostIPC: true
      tolerations:
        - operator: Exists
          effect: NoSchedule
      initContainers:
        - name: io-tuner
          image: alpine:3.19
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              set -eu
              # Tune all NVMe devices
              for dev in /sys/block/nvme*n1; do
                echo "Tuning $dev"
                echo none > "$dev/queue/scheduler" || true
                echo 256 > "$dev/queue/nr_requests" || true
                echo 2048 > "$dev/queue/read_ahead_kb" || true
                # Disable write cache protection for performance
                # Only safe if using battery-backed RAID or cloud EBS
                echo 0 > "$dev/queue/write_cache" || true
              done

              # Tune SATA SSDs
              for dev in /sys/block/sd*; do
                ROTA=$(cat "$dev/queue/rotational" 2>/dev/null || echo "1")
                if [ "$ROTA" = "0" ]; then
                  echo "Tuning SATA SSD $dev"
                  echo mq-deadline > "$dev/queue/scheduler" || true
                  echo 250 > "$dev/queue/iosched/read_expire" || true
                fi
              done

              # Kernel I/O parameters
              # Dirty page writeback tuning
              sysctl -w vm.dirty_ratio=10
              sysctl -w vm.dirty_background_ratio=5
              sysctl -w vm.dirty_writeback_centisecs=500
              sysctl -w vm.dirty_expire_centisecs=3000

              echo "I/O tuning complete"
          volumeMounts:
            - name: sys
              mountPath: /sys
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
      volumes:
        - name: sys
          hostPath:
            path: /sys
```

### etcd-Specific Tuning

etcd is heavily sensitive to storage latency. Configuration recommendations:

```bash
# On etcd nodes, verify storage performance
# etcd requires <10ms write latency for stable operation
fio \
  --name=etcd-check \
  --ioengine=libaio \
  --iodepth=1 \
  --rw=randwrite \
  --bs=4k \
  --direct=1 \
  --size=1G \
  --filename=/var/lib/etcd-test \
  --runtime=60 \
  --time_based \
  --fsync=1 \
  --lat_percentiles=1 2>&1 | grep -E "clat|sync"

# Expected output on NVMe with fsync:
# sync lat (usec): min=  71, max= 2345, avg=  234.56, stdev= 156.78
# lat percentiles (usec):
#   | 99.00th=[  608], 99.90th=[ 1237], 99.99th=[ 2278]

# If p99 > 10ms, investigate:
# 1. I/O scheduler (use none or mq-deadline for SSDs)
# 2. Write-back cache disabled on RAID controller
# 3. VM CPU steal time (cloud instance sizing)
# 4. noatime mount option

# /etc/fstab entry for etcd partition
# /dev/nvme0n1p1 /var/lib/etcd xfs defaults,noatime,nodiratime 0 0
```

### Monitoring I/O Performance

```bash
# Real-time I/O monitoring
iostat -xz nvme0n1 1

# Key metrics to watch:
# %util: Percentage of time device is busy (>80% = saturated)
# await: Average I/O wait time (ms)
# r_await/w_await: Separate read/write wait times
# avgqu-sz: Average queue depth

# Kubernetes-level I/O monitoring
kubectl exec -n monitoring prometheus-0 -- \
  curl -sg 'http://localhost:9090/api/v1/query?query=node_disk_io_time_seconds_total' | \
  jq '.data.result[] | {disk: .metric.device, value: .value[1]}'

# PromQL for disk saturation
# node_disk_io_time_seconds_total (rate) > 0.9 is saturation warning
```

## Choosing the Right Scheduler

```bash
#!/bin/bash
# recommend-scheduler.sh
DEVICE="${1:-/dev/nvme0n1}"
BLOCK=$(basename "$DEVICE")
ROTA=$(cat /sys/block/$BLOCK/queue/rotational)
TRANSPORT=$(cat /sys/block/$BLOCK/../transport 2>/dev/null || echo unknown)

echo "Device: $DEVICE"
echo "Rotational: $ROTA"
echo "Transport: $TRANSPORT"
echo ""

if [[ "$TRANSPORT" == "nvme" ]]; then
    echo "Recommendation: none"
    echo "Rationale: NVMe device with internal hardware queuing."
    echo "  The none scheduler eliminates kernel overhead and lets the"
    echo "  NVMe controller manage request ordering via its internal queues."
elif [[ "$ROTA" == "0" ]]; then
    echo "Recommendation: mq-deadline"
    echo "Rationale: SATA SSD — benefits from deadline-based ordering"
    echo "  to bound write latency and prevent write starvation."
else
    echo "Recommendation: bfq"
    echo "Rationale: HDD — benefits from BFQ's seek cost optimization"
    echo "  and process fairness. If CPU is constrained, use mq-deadline."
fi
```

## Summary

Linux I/O scheduler selection has a measurable impact on storage performance:

- NVMe devices with multiple hardware queues consistently perform best with `none` — adding a software scheduler adds latency without benefit
- SATA SSDs benefit from `mq-deadline` which bounds write latency and prevents starvation; tune `read_expire` to 250ms for OLTP workloads
- HDDs require `bfq` or `mq-deadline` for seek cost optimization; `bfq` is preferable when process-level fairness matters
- Use fio with `direct=1` and representative access patterns to measure real-world impact before deploying scheduler changes to production
- Apply changes persistently via udev rules and verify they survive device reinitialization during hot-plug or reboot
- For Kubernetes etcd nodes, target p99 fsync latency below 10ms — anything above indicates scheduler misconfiguration, write cache issues, or undersized storage
