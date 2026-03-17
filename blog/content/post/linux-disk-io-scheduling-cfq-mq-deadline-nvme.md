---
title: "Linux Disk IO Scheduling: CFQ, mq-deadline, and NVMe Optimization"
date: 2029-02-07T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Storage", "NVMe", "IO Scheduling", "Kubernetes"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Linux block I/O schedulers covering CFQ, BFQ, mq-deadline, and none scheduling for NVMe devices, with tuning recommendations for Kubernetes workloads, database servers, and high-throughput storage systems."
more_link: "yes"
url: "/linux-disk-io-scheduling-cfq-mq-deadline-nvme/"
---

Linux I/O schedulers sit between the filesystem and the block device driver, deciding the order in which I/O requests reach the hardware. The right scheduler for a single-queue HDD is wrong for a multi-queue NVMe SSD. Kubernetes worker nodes running mixed database and batch workloads have different I/O scheduling needs than dedicated PostgreSQL or Elasticsearch nodes. Misconfigured schedulers manifest as unexplained I/O latency, queue depth saturation, and p99 latency spikes under load.

This guide covers the current Linux I/O scheduler landscape, the transition from single-queue to multi-queue (blk-mq) infrastructure, scheduler selection criteria, tuning parameters, and systematic benchmarking methodology for production validation.

<!--more-->

## I/O Scheduler Architecture

Linux block I/O scheduling has gone through a major architectural transition:

**Legacy single-queue (pre-5.0)**:
- `noop`: FIFO ordering, minimal overhead
- `deadline`: Deadline-based scheduling to prevent starvation
- `cfq` (Completely Fair Queuing): Per-process I/O fairness with time slices

**Multi-queue blk-mq (5.0+, all modern kernels)**:
- `none`: Submit requests directly to hardware queues (NVMe recommended)
- `mq-deadline`: Multi-queue port of deadline, adds request merging
- `bfq` (Budget Fair Queuing): Comprehensive fairness and latency control
- `kyber`: Lightweight, latency-targeted for NVMe

The critical insight: NVMe SSDs have hardware I/O queues (typically 16-128 queues with 1024 depth each). Injecting a software scheduler queue between the application and hardware eliminates the latency advantage of NVMe's native parallelism. For NVMe, `none` (no scheduler) typically outperforms all alternatives.

### Current Scheduler Landscape per Device Type

| Device Type | Recommended Scheduler | Rationale |
|---|---|---|
| NVMe SSD (single-tenant) | `none` | Hardware handles queue management; software overhead hurts |
| NVMe SSD (multi-tenant, latency-sensitive) | `kyber` | Fairness with minimal overhead |
| SATA SSD (general) | `mq-deadline` | Request merging improves sequential performance |
| SATA SSD (database) | `none` | Let the database manage I/O |
| HDD (rotational) | `bfq` or `mq-deadline` | Seek optimization matters; fairness prevents starvation |
| virtio-blk (cloud VM) | `mq-deadline` or `none` | Depends on underlying hypervisor storage |
| NFS / network storage | `none` | Host-side scheduling does not benefit network I/O |

## Identifying Current Configuration

```bash
# List all block devices and their schedulers
for dev in /sys/block/*/queue/scheduler; do
  devname=$(echo $dev | cut -d/ -f4)
  scheduler=$(cat $dev)
  echo "${devname}: ${scheduler}"
done
# Example output:
# nvme0n1: [none] mq-deadline kyber bfq
# sda: mq-deadline [kyber] bfq none
# vda: [mq-deadline] kyber bfq none
# (brackets indicate the active scheduler)

# Detailed block device info
lsblk -o NAME,TYPE,SCHED,ROTATIONAL,DISC-GRAN,LOG-SEC,PHY-SEC,RQ-SIZE,RA

# Check if device is rotational (0=SSD, 1=HDD)
cat /sys/block/nvme0n1/queue/rotational

# Check hardware queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# Typical NVMe: 1024
# Typical HDD: 128

# Check number of hardware queues (blk-mq)
cat /sys/block/nvme0n1/mq/*/nr_tags | wc -l
# NVMe: 16-64 queues typical

# Check current I/O stats
iostat -xz 1 -d nvme0n1
# Key columns: r_await (read latency ms), w_await (write latency ms), %util

# Detailed queue stats via /proc/diskstats
cat /proc/diskstats | awk '$3=="nvme0n1" {print}'
```

## Changing I/O Schedulers

```bash
# Change scheduler at runtime (does not persist across reboot)
echo "mq-deadline" > /sys/block/nvme0n1/queue/scheduler
echo "none" > /sys/block/nvme0n1/queue/scheduler
echo "bfq" > /sys/block/nvme0n1/queue/scheduler

# Verify change
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# Persist via udev rules (survives reboots and disk replacements)
cat > /etc/udev/rules.d/60-io-schedulers.rules << 'EOF'
# NVMe devices: no scheduler (hardware queue management)
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/scheduler}="none"

# SATA SSDs: mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", \
  ATTR{queue/scheduler}="mq-deadline"

# HDDs: bfq for fairness
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", \
  ATTR{queue/scheduler}="bfq"

# virtio-blk in cloud VMs
ACTION=="add|change", KERNEL=="vd[a-z]", ATTR{queue/scheduler}="none"
EOF

# Reload udev rules
udevadm control --reload-rules
udevadm trigger --type=devices --attr-match=subsystem=block

# For RHEL/Rocky: use tuned profiles (preferred on RHEL-based systems)
# List available profiles
tuned-adm list

# Throughput-performance profile sets scheduler automatically
tuned-adm profile throughput-performance

# Check active profile
tuned-adm active

# For database servers: latency-performance
tuned-adm profile latency-performance
```

## Tuning mq-deadline Parameters

```bash
# mq-deadline parameters for a database workload
DEV="/sys/block/nvme0n1/queue"

# Set scheduler to mq-deadline first
echo "mq-deadline" > "${DEV}/scheduler"

# Read expire time: max time a read request can wait before forced dispatch (ms)
# Default: 500ms — lower for latency-sensitive workloads
echo 100 > "${DEV}/iosched/read_expire"

# Write expire time: max time a write request can wait (ms)
# Default: 5000ms (5s) — higher than read to prioritize reads
echo 1000 > "${DEV}/iosched/write_expire"

# Writes starved: number of read batches before dispatching a write batch
# Higher values prioritize reads over writes
echo 4 > "${DEV}/iosched/writes_starved"

# Front merges: enable merging of requests at the front of the queue
# Disable for random I/O workloads (databases) to reduce latency
echo 0 > "${DEV}/iosched/front_merges"

# Fifo batch: number of requests to dispatch in one batch
# Larger batch = higher throughput, lower latency
echo 16 > "${DEV}/iosched/fifo_batch"

# Check all tunable parameters
ls -la "${DEV}/iosched/"
cat "${DEV}/iosched/read_expire"
cat "${DEV}/iosched/write_expire"
```

## Tuning BFQ for Mixed Workloads

BFQ is the scheduler of choice for Kubernetes worker nodes running mixed workloads — it ensures interactive processes and latency-sensitive services are not starved by background batch jobs.

```bash
DEV="/sys/block/sda/queue"
echo "bfq" > "${DEV}/scheduler"

# Timeout for sync (read/interactive) requests (ms)
# Default: 124ms — keep low for interactive responsiveness
echo 100 > "${DEV}/iosched/timeout_sync"

# Timeout for async (write) requests (ms)
# Default: 250ms
echo 500 > "${DEV}/iosched/timeout_async"

# Slice idle: time BFQ waits for more I/O from an entity before switching
# Lower = less idle wait, higher throughput but less fairness
echo 8 > "${DEV}/iosched/slice_idle"

# Group idle: slice_idle used for groups (cgroups)
echo 8 > "${DEV}/iosched/group_idle"

# Low latency mode: prioritizes latency over throughput
# Enable for interactive/latency-sensitive workloads
echo 1 > "${DEV}/iosched/low_latency"

# Weights: set per-cgroup I/O weight using cgroups v2
# BFQ integrates with blkio cgroup controller
# Set higher weight for critical services
echo "100" > /sys/fs/cgroup/system.slice/io.weight
echo "200" > /sys/fs/cgroup/kubepods.slice/burstable.slice/io.weight
echo "500" > /sys/fs/cgroup/kubepods.slice/guaranteed.slice/io.weight
```

## Kubernetes-Specific Tuning

```bash
# Kubernetes workloads on NVMe — optimal baseline configuration
cat > /etc/udev/rules.d/60-kubernetes-io.rules << 'EOF'
# NVMe: no scheduler, maximum queue depth, read-ahead tuned
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
  ATTR{queue/scheduler}="none", \
  ATTR{queue/nr_requests}="2048", \
  ATTR{queue/read_ahead_kb}="128"

# EBS volumes (gp3): mq-deadline with optimized settings
ACTION=="add|change", KERNEL=="xvd*|nvme[0-9]*n[0-9]*", \
  ENV{ID_VENDOR}=="Amazon", \
  ATTR{queue/scheduler}="mq-deadline"

# Local SSDs: none scheduler
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", \
  ATTR{queue/scheduler}="none", \
  ATTR{queue/nr_requests}="1024"
EOF

# Node-level kernel parameters for storage performance
cat >> /etc/sysctl.d/99-storage-tuning.conf << 'EOF'
# Dirty page write-back tuning
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 1500
vm.dirty_writeback_centisecs = 500

# Swap tuning (prefer not to swap on Kubernetes nodes)
vm.swappiness = 1

# I/O read-ahead (pages) — tune per workload
vm.page-cluster = 3
EOF
sysctl -p /etc/sysctl.d/99-storage-tuning.conf
```

## Benchmarking I/O Schedulers

Establishing before/after benchmarks is essential — "better" scheduler depends entirely on the actual workload characteristics.

```bash
# Install fio
dnf install -y fio

# Benchmark script comparing schedulers
cat > /usr/local/bin/io-scheduler-benchmark.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail

DEVICE="${1:-/dev/nvme0n1}"
TESTFILE="${DEVICE}p1"  # Use a partition or filesystem path
OUTPUT_DIR="/var/log/io-benchmarks/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

SCHEDULERS=("none" "mq-deadline" "bfq" "kyber")

run_benchmark() {
  local scheduler="$1"
  local test_name="$2"
  local fio_args=("${@:3}")

  echo "=== Scheduler: ${scheduler} | Test: ${test_name} ==="
  echo "${scheduler}" > "/sys/block/$(basename $DEVICE)/queue/scheduler"
  sleep 1  # Allow scheduler to settle

  fio \
    --name="${test_name}-${scheduler}" \
    --filename="${TESTFILE}" \
    --output="${OUTPUT_DIR}/${test_name}-${scheduler}.json" \
    --output-format=json \
    "${fio_args[@]}"
}

for sched in "${SCHEDULERS[@]}"; do
  # 4K random read (database IOPS test)
  run_benchmark "$sched" "4k-randread" \
    --rw=randread --bs=4k --size=4G --numjobs=4 \
    --iodepth=32 --direct=1 --group_reporting --runtime=60

  # 128K sequential read (throughput test)
  run_benchmark "$sched" "128k-seqread" \
    --rw=read --bs=128k --size=8G --numjobs=4 \
    --iodepth=16 --direct=1 --group_reporting --runtime=60

  # Mixed 70/30 read/write (OLTP simulation)
  run_benchmark "$sched" "mixed-oltp" \
    --rw=randrw --rwmixread=70 --bs=8k --size=4G --numjobs=8 \
    --iodepth=32 --direct=1 --group_reporting --runtime=60
done

# Generate summary
echo ""
echo "=== Benchmark Summary ==="
for test in "4k-randread" "128k-seqread" "mixed-oltp"; do
  echo ""
  echo "--- ${test} ---"
  echo "scheduler | IOPS | BW (MB/s) | p50 lat (ms) | p99 lat (ms)"
  for sched in "${SCHEDULERS[@]}"; do
    result_file="${OUTPUT_DIR}/${test}-${sched}.json"
    if [ -f "$result_file" ]; then
      jq -r "
        .jobs[0] |
        \"${sched} | \" +
        ((.read.iops + .write.iops) | tostring) + \" | \" +
        (((.read.bw + .write.bw) / 1024) | round | tostring) + \" | \" +
        ((.read.lat_ns.percentile[\"50.000000\"] // .write.lat_ns.percentile[\"50.000000\"]) / 1000000 | round | tostring) + \" | \" +
        ((.read.lat_ns.percentile[\"99.000000\"] // .write.lat_ns.percentile[\"99.000000\"]) / 1000000 | round | tostring)
      " "$result_file"
    fi
  done
done
SCRIPT
chmod +x /usr/local/bin/io-scheduler-benchmark.sh
```

### PostgreSQL Workload Benchmark

```bash
# PostgreSQL-specific I/O benchmark simulating pgbench OLTP
fio \
  --name=postgres-oltp \
  --filename=/var/lib/postgresql/16/main/fio-test \
  --rw=randrw \
  --rwmixread=70 \
  --bs=8k \
  --size=10G \
  --numjobs=16 \
  --iodepth=8 \
  --direct=1 \
  --fsync=1 \
  --ioengine=psync \
  --group_reporting \
  --runtime=120 \
  --output-format=json \
  --output=/var/log/postgres-io-baseline.json

# Parse results
jq '{
  read_iops: .jobs[0].read.iops,
  write_iops: .jobs[0].write.iops,
  read_bw_mbs: (.jobs[0].read.bw / 1024 | round),
  write_bw_mbs: (.jobs[0].write.bw / 1024 | round),
  read_lat_p50_ms: (.jobs[0].read.lat_ns.percentile["50.000000"] / 1000000),
  read_lat_p99_ms: (.jobs[0].read.lat_ns.percentile["99.000000"] / 1000000),
  read_lat_p999_ms: (.jobs[0].read.lat_ns.percentile["99.900000"] / 1000000),
  write_lat_p99_ms: (.jobs[0].write.lat_ns.percentile["99.000000"] / 1000000)
}' /var/log/postgres-io-baseline.json
```

## Cloud VM Storage Optimization

```bash
# AWS EBS gp3 optimization
# gp3 provides up to 16,000 IOPS and 1,000 MB/s when properly configured

# Check EBS volume type and provisioned IOPS
aws ec2 describe-volumes \
  --filters "Name=attachment.instance-id,Values=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)" \
  --query 'Volumes[*].{Type:VolumeType,IOPS:Iops,Throughput:Throughput,Size:Size}' \
  --output table

# Modify existing volume to gp3 with maximum provisioned IOPS
aws ec2 modify-volume \
  --volume-id vol-0abc12345def67890 \
  --volume-type gp3 \
  --iops 16000 \
  --throughput 1000

# For NVMe EBS, use nvme namespace to get device mapping
nvme list
# Shows: /dev/nvme0n1 -> vol-0abc12345def67890

# EBS nvme scheduler tuning
for dev in $(ls /dev/nvme*n1 2>/dev/null); do
  devname=$(basename $dev)
  # Use none scheduler for NVMe EBS
  echo "none" > "/sys/block/${devname}/queue/scheduler"
  # Increase queue depth for EBS (supports up to 32 deep per queue)
  echo 256 > "/sys/block/${devname}/queue/nr_requests"
  # Disable rotational hint (EBS is SSD-backed)
  echo 0 > "/sys/block/${devname}/queue/rotational"
  echo "Tuned ${devname}: scheduler=none, nr_requests=256"
done
```

## Monitoring I/O Scheduler Performance

```bash
# Real-time I/O monitoring
iostat -xz 2 -d nvme0n1
# Key metrics:
# r_await: average read request latency (ms) — target <1ms for NVMe
# w_await: average write request latency (ms)
# aqu-sz:  average queue size — >1 means device is busy
# %util:   device utilization — >70% needs investigation

# iotop: process-level I/O usage
iotop -o -P -d 5

# blktrace: kernel-level block I/O tracing (use sparingly — high overhead)
blktrace -d /dev/nvme0n1 -o /tmp/nvme0n1-trace &
# Run workload...
kill %1
blkparse -i /tmp/nvme0n1-trace.blktrace.* -d /tmp/nvme0n1.bin
btt -i /tmp/nvme0n1.bin
# Shows: I/O latency distribution, queue time, device service time

# Prometheus node_exporter disk metrics
# node_disk_read_time_seconds_total
# node_disk_write_time_seconds_total
# node_disk_io_time_seconds_total
# node_disk_reads_completed_total

# Calculate average read latency from prometheus
# (rate(node_disk_read_time_seconds_total[5m]) / rate(node_disk_reads_completed_total[5m])) * 1000
# Result in milliseconds per read operation
```

### Grafana Dashboard Query Examples

```promql
# Average read latency per device (ms)
(
  rate(node_disk_read_time_seconds_total{instance="worker-01:9100"}[5m])
  /
  rate(node_disk_reads_completed_total{instance="worker-01:9100"}[5m])
) * 1000

# I/O queue depth
node_disk_io_now{instance="worker-01:9100"}

# Device utilization percentage
rate(node_disk_io_time_seconds_total{instance="worker-01:9100"}[5m]) * 100

# Alert: NVMe latency exceeding SLA
(
  rate(node_disk_read_time_seconds_total{device="nvme0n1"}[5m])
  /
  rate(node_disk_reads_completed_total{device="nvme0n1"}[5m])
) * 1000 > 2
```

## Production Recommendations Summary

**NVMe SSDs**: Use `none` scheduler. Hardware queue management outperforms any software scheduler. Set `nr_requests=2048`, `read_ahead_kb=128` for sequential workloads, `read_ahead_kb=0` for pure random I/O (databases).

**SATA SSDs**: Use `mq-deadline` with `read_expire=100`, `write_expire=1000`, `front_merges=0` for database workloads. Consider `none` for high-IOPS NVMe-like workloads.

**HDDs**: Use `bfq` with `low_latency=1` for mixed workloads, `mq-deadline` for pure throughput (backup servers, log archival).

**Cloud VMs (EBS, persistent disks)**: Treat as NVMe where possible (`none` scheduler). The hypervisor handles physical device scheduling; adding a second software scheduler layer adds latency without benefit.

**Kubernetes nodes**: Apply settings via udev rules and a node configuration DaemonSet. Avoid relying on default kernel settings — cloud provider AMIs vary widely in their storage defaults, and what's optimal for general-purpose workloads is not optimal for database-heavy Kubernetes nodes.
