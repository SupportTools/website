---
title: "Linux Disk I/O Tracing: blktrace, biolatency, and Storage Performance Analysis"
date: 2030-09-24T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Storage", "blktrace", "eBPF", "bpftrace", "I/O Analysis"]
categories:
- Linux
- Performance
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive I/O tracing guide covering blktrace and blkparse for block layer request analysis, BCC/bpftrace biolatency tool, iolatency histograms, queue depth analysis, identifying storage bottlenecks in Kubernetes pods, and correlating I/O performance with application latency."
more_link: "yes"
url: "/linux-disk-io-tracing-blktrace-biolatency-storage-performance-analysis/"
---

Storage performance problems are among the hardest to diagnose in production. A database experiencing latency spikes, a log shipper falling behind, a Kubernetes pod with write-back pressure — all of these can trace back to the block layer, where the operating system negotiates between application I/O requests and physical storage. The Linux kernel provides a rich set of tracing facilities that expose exactly what is happening at every stage of an I/O request's journey, from the application write() call to the disk completion interrupt. This guide covers the full tracing stack: from blktrace at the block layer to eBPF-based tools that attribute latency to specific processes and pods.

<!--more-->

## The Linux I/O Stack

Before tracing, understanding the layers helps interpret what the tools report:

```
Application (write/read syscall)
    │
    ▼
VFS (Virtual Filesystem Layer)
    │
    ▼
Filesystem (ext4, xfs, btrfs)
    │
    ▼
Page Cache / Buffer Cache
    │
    ▼
Block Layer (I/O scheduler, merge/sort)
    │
    ▼
Device Driver (NVMe, SCSI, virtio-blk)
    │
    ▼
Physical Device (SSD, HDD, EBS volume)
```

Each layer adds latency. `blktrace` instruments the block layer (below the filesystem). eBPF tools like `biolatency` can instrument at the block layer or even higher to measure per-process latency.

## blktrace: Block Layer Event Tracing

`blktrace` captures every I/O event at the Linux block layer using the kernel's tracing infrastructure. It records events including:

- `Q`: Request queued (by the filesystem or application)
- `G`: Get request (I/O scheduler assigns a request structure)
- `I`: Inserted into the I/O scheduler queue
- `D`: Dispatched to the device driver
- `C`: Completed (driver acknowledged completion)
- `M`: Back-merged with an existing request
- `F`: Front-merged with an existing request
- `S`: Slept waiting for a request structure

### Installation

```bash
# Debian/Ubuntu
apt-get install blktrace

# RHEL/CentOS/Fedora
dnf install blktrace

# Verify kernel support
grep -r BLK_DEV_IO_TRACE /boot/config-$(uname -r) 2>/dev/null || \
  cat /proc/config.gz 2>/dev/null | zcat | grep BLK_DEV_IO_TRACE
# Should show: CONFIG_BLK_DEV_IO_TRACE=y
```

### Basic blktrace Usage

```bash
# Trace I/O on /dev/sda for 10 seconds, writing to ./blktrace-output
blktrace -d /dev/sda -w 10 -o blktrace-output

# This creates per-CPU trace files:
# blktrace-output.blktrace.0
# blktrace-output.blktrace.1
# ... (one per CPU)

# Parse the binary output
blkparse -i blktrace-output

# Example output:
#   8,0    0        1     0.000000000   416  Q  WS 1234567 + 8 [kworker/u8:4]
#   8,0    0        2     0.000001234   416  G  WS 1234567 + 8 [kworker/u8:4]
#   8,0    0        3     0.000002891   416  I  WS 1234567 + 8 [kworker/u8:4]
#   8,0    0        4     0.000004567   416  D  WS 1234567 + 8 [kworker/u8:4]
#   8,0    0        5     0.002345678     0  C  WS 1234567 + 8 [0]
#
# Columns: major,minor  cpu  seq  timestamp  PID  action  RWBS  LBA + size  [comm]
# RWBS flags: R=Read W=Write S=Sync D=Discard
```

### blkparse Output Interpretation

```bash
# Parse with statistics summary
blkparse -i blktrace-output -d blktrace-combined.bin

# Generate per-process I/O statistics
blkparse -i blktrace-output -f "%M %m %p %a %c\n" | \
  awk '{ops[$5]++; bytes[$5]+=$4} END {for (proc in ops) print proc, ops[proc], bytes[proc]}' | \
  sort -k2 -rn | head -20

# Calculate completion latency (Q to C time)
blkparse -i blktrace-output -f "%S %a\n" | \
  awk '
    /Q / { queue_time[$1] = $0 }
    /C / { if ($1 in queue_time) { split(queue_time[$1], a, " "); print $0, "latency:", $2-a[2] } }
  '
```

### btt: Block Trace Tail Analysis

`btt` (block trace tail) is a companion tool that produces latency breakdown statistics:

```bash
# Convert traces to single binary file first
blkparse -i blktrace-output -d blktrace-combined.bin -q

# Run btt analysis
btt -i blktrace-combined.bin

# Sample output:
# ==================== All Devices ====================
#
# ALL           MIN      AVG      MAX   N
# -----------  -------  -------  -----  ---
# Q2Q          0.000001 0.010234 1.2345 12345  (time between queue events)
# Q2G          0.000001 0.000234 0.0123 12345  (queue to get request)
# G2I          0.000001 0.000123 0.0045 12345  (get to insert in scheduler)
# I2D          0.000001 0.002345 0.1234 12345  (insert to dispatch - scheduler time)
# D2C          0.000100 0.002100 0.2100 12345  (dispatch to complete - device time)
# Q2C          0.000100 0.004802 0.3345 12345  (total request latency)
```

The most important latency stages:
- **I2D** (Insert to Dispatch): Time spent in the I/O scheduler. High values indicate scheduling overhead or intentional batching.
- **D2C** (Dispatch to Complete): Physical device latency. This is the actual storage hardware response time.

## bpftrace and BCC biolatency

eBPF-based tools provide much lower overhead than blktrace and enable per-process attribution without root-level device tracing.

### biolatency from BCC

```bash
# Install BCC tools
apt-get install bpfcc-tools linux-headers-$(uname -r)
# or
dnf install bcc-tools kernel-devel

# Show block I/O latency histogram, updating every 1 second
/usr/share/bcc/tools/biolatency -d /dev/sda 1

# Sample output:
# Tracing block device I/O... Hit Ctrl-C to end.
#
# usecs               : count     distribution
#     0 -> 1          : 0        |                                        |
#     2 -> 3          : 0        |                                        |
#     4 -> 7          : 0        |                                        |
#     8 -> 15         : 2        |                                        |
#    16 -> 31         : 45       |**                                      |
#    32 -> 63         : 234      |**********                              |
#    64 -> 127        : 891      |*************************************   |
#   128 -> 255        : 954      |****************************************|
#   256 -> 511        : 456      |*******************                     |
#   512 -> 1023       : 89       |***                                     |
#  1024 -> 2047       : 34       |*                                       |
#  2048 -> 4095       : 12       |                                        |
#  4096 -> 8191       : 3        |                                        |
#  8192 -> 16383      : 1        |                                        |

# Show latency per disk and per flag (reads vs writes)
/usr/share/bcc/tools/biolatency -F

# Show latency with queue time included
/usr/share/bcc/tools/biolatency -Q

# Per-disk latency across all devices
/usr/share/bcc/tools/biolatency -D
```

### bpftrace biolatency Script

For more control, use bpftrace directly:

```bash
# /usr/share/bpftrace/tools/biolatency.bt or write inline:

bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_rq_complete {
    $start = @start[args->dev, args->sector];
    if ($start != 0) {
        $lat_us = (nsecs - $start) / 1000;
        @latency_us = hist($lat_us);
        delete(@start[args->dev, args->sector]);
    }
}

END {
    clear(@start);
}'
```

### Per-Process I/O Latency

```bash
# biotop: show I/O by process in top-style display
/usr/share/bcc/tools/biotop 1

# Sample output:
# Tracing... Output every 1 secs. Hit Ctrl-C to end
#
# 10:23:45 loadavg: 1.23 0.98 0.87 3/456 7890
#
#  PID    COMM             D MAJ MIN DISK       I/O  Kbytes  AVGms
#  1234   postgres         R 253   0 xvda       234  45678   0.45
#  5678   mysqld           W 253   0 xvda       123  23456   0.89
#  9012   elasticsearch    R 253   0 xvda        89  12345   1.23
```

```bash
# Per-process I/O with latency histogram using bpftrace
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
    @comm[args->dev, args->sector] = comm;
}

tracepoint:block:block_rq_complete {
    $key = (args->dev, args->sector);
    $start = @start[$key];
    if ($start != 0) {
        $lat_us = (nsecs - $start) / 1000;
        @latency_by_comm[@comm[$key]] = hist($lat_us);
        delete(@start[$key]);
        delete(@comm[$key]);
    }
}

END {
    clear(@start);
    clear(@comm);
}'
```

## Queue Depth Analysis

Queue depth is critical for storage performance. Too shallow means underutilization; too deep causes latency spikes.

### Measuring Queue Depth with iostat

```bash
# iostat with extended statistics, 1-second interval
iostat -xz 1

# Key columns:
# r/s, w/s: reads and writes per second
# rkB/s, wkB/s: read/write throughput
# avgrq-sz: average request size (sectors)
# avgqu-sz: average queue depth (requests in flight)
# await: average I/O latency (ms) - includes queue time
# r_await, w_await: separate read/write latency
# %util: device utilization percentage

# Example healthy NVMe output:
# Device   r/s   w/s  rkB/s  wkB/s avgrq-sz avgqu-sz await r_await w_await %util
# nvme0n1  234   567  45678  89012    256.0      4.2   1.2    0.8     1.4    65.2

# Example saturated HDD:
# Device   r/s   w/s  rkB/s  wkB/s avgrq-sz avgqu-sz await r_await w_await %util
# sda       45    23   1234   5678     128.0     32.5  98.7   78.4   112.3   99.8
# avgqu-sz > 1 and %util near 100 = saturated
```

### Queue Depth via blktrace

```bash
# Measure instantaneous queue depth over time
bpftrace -e '
tracepoint:block:block_rq_insert { @depth = count(); }
tracepoint:block:block_rq_complete { @depth = count() - 1; }

interval:ms:100 {
    printf("%lld %lld\n", elapsed / 1000000, @depth);
    @depth = 0;
}'
```

### Optimal Queue Depth for Different Storage Types

```bash
# Check current queue depth setting
cat /sys/block/sda/queue/nr_requests     # Scheduler queue depth
cat /sys/block/nvme0n1/queue/nr_requests

# For NVMe SSDs, check hardware queue depth
cat /sys/block/nvme0n1/queue/max_hw_sectors_kb
nvme list  # Shows device details including queue depth

# Tune for high-throughput NVMe workloads
echo 256 > /sys/block/nvme0n1/queue/nr_requests

# For persistent tuning, use udev rules:
cat > /etc/udev/rules.d/71-block-scheduler.rules << 'EOF'
# NVMe - use none scheduler and deep queues
ACTION=="add|change", KERNEL=="nvme*", ATTR{queue/scheduler}="none", ATTR{queue/nr_requests}="256"

# SSDs - use mq-deadline, moderate queue depth
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline", ATTR{queue/nr_requests}="128"

# HDDs - use bfq for fair scheduling
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
EOF

udevadm control --reload-rules && udevadm trigger --type=devices --action=change
```

## I/O Scheduler Analysis

The I/O scheduler affects latency characteristics significantly.

### Comparing Schedulers

```bash
# Available schedulers
cat /sys/block/sda/queue/scheduler
# [none] mq-deadline kyber bfq

# none: No reordering, pass directly to device queue. Best for NVMe (hardware handles queuing)
# mq-deadline: Time-based deadline scheduling. Good for databases on SSD
# kyber: Low-latency scheduler using token buckets. Good for mixed workloads
# bfq: Budget Fair Queuing. Best for HDDs and shared storage in VMs

# Benchmark scheduler impact
for sched in none mq-deadline bfq; do
    echo "Testing $sched scheduler..."
    echo $sched > /sys/block/sda/queue/scheduler
    fio --name=test \
        --ioengine=libaio \
        --iodepth=32 \
        --rw=randread \
        --bs=4k \
        --direct=1 \
        --size=1G \
        --runtime=30 \
        --filename=/dev/sda \
        --output-format=json | \
        jq '.jobs[0].read | {iops: .iops, lat_mean_us: .lat_ns.mean/1000, lat_p99_us: .lat_ns.percentile."99.000000"/1000}'
done
```

## Identifying Storage Bottlenecks in Kubernetes Pods

### Tracing Pod-Level I/O

Container I/O is transparent to block layer tracing, but attributing block I/O to specific containers requires the container PID namespace:

```bash
# Find PIDs for a specific pod
NAMESPACE=production
POD=my-app-pod-abc123
CONTAINER=my-app

# Get container PID
CONTAINER_PID=$(kubectl exec -n $NAMESPACE $POD -c $CONTAINER -- sh -c 'echo $$')
echo "Container PID: $CONTAINER_PID"

# Get all PIDs in the same PID namespace
HOST_PID=$(cat /proc/$(docker inspect --format='{{.State.Pid}}' \
  $(crictl ps --name $CONTAINER --quiet | head -1))/status | grep NSpid | awk '{print $3}')

echo "Host PID: $HOST_PID"

# Trace I/O for this specific PID and its children
bpftrace -e "
tracepoint:syscalls:sys_enter_write /pid == $HOST_PID/ {
    @writes[comm] = count();
    @write_bytes[comm] = sum(args->count);
}

tracepoint:syscalls:sys_enter_read /pid == $HOST_PID/ {
    @reads[comm] = count();
    @read_bytes[comm] = sum(args->count);
}

interval:s:5 {
    printf(\"\n=== I/O stats for PID $HOST_PID ===\n\");
    print(@writes);
    print(@write_bytes);
    print(@reads);
    print(@read_bytes);
    clear(@writes); clear(@write_bytes);
    clear(@reads); clear(@read_bytes);
}"
```

### Using cgroups for Container I/O Accounting

```bash
# Find the cgroup for a pod
POD_UID=$(kubectl get pod my-app-pod-abc123 -n production -o jsonpath='{.metadata.uid}')
CGROUP_PATH="/sys/fs/cgroup/blkio/kubepods/pod${POD_UID}/"

# Read I/O statistics from cgroup blkio controller
cat ${CGROUP_PATH}/blkio.throttle.io_service_bytes
# Example output:
# 253:0 Read 1234567890
# 253:0 Write 9876543210
# Total 11111111100

# Per-operation statistics
cat ${CGROUP_PATH}/blkio.throttle.io_serviced
# 253:0 Read 12345
# 253:0 Write 67890

# Monitor I/O in real-time
watch -n 1 "cat ${CGROUP_PATH}/blkio.throttle.io_service_bytes"
```

### fio Benchmarking Within Pods

```yaml
# Pod spec for fio benchmarking
apiVersion: v1
kind: Pod
metadata:
  name: fio-benchmark
  namespace: testing
spec:
  containers:
    - name: fio
      image: nixery.dev/fio
      command: ["/bin/sh", "-c"]
      args:
        - |
          # 4K random read - tests IOPS capability
          fio --name=randread-4k \
              --ioengine=libaio \
              --iodepth=32 \
              --rw=randread \
              --bs=4k \
              --direct=1 \
              --size=2G \
              --runtime=60 \
              --filename=/mnt/test/fio-test \
              --output-format=json > /results/randread-4k.json

          # Sequential write - tests throughput
          fio --name=seqwrite-1m \
              --ioengine=libaio \
              --iodepth=8 \
              --rw=write \
              --bs=1m \
              --direct=1 \
              --size=2G \
              --runtime=60 \
              --filename=/mnt/test/fio-test \
              --output-format=json > /results/seqwrite-1m.json

          # Mixed 70/30 read/write - typical database workload
          fio --name=mixed-db \
              --ioengine=libaio \
              --iodepth=16 \
              --rw=randrw \
              --rwmixread=70 \
              --bs=8k \
              --direct=1 \
              --size=2G \
              --runtime=60 \
              --filename=/mnt/test/fio-test \
              --output-format=json > /results/mixed-db.json
      volumeMounts:
        - name: test-volume
          mountPath: /mnt/test
        - name: results
          mountPath: /results
  volumes:
    - name: test-volume
      persistentVolumeClaim:
        claimName: fio-test-pvc
    - name: results
      emptyDir: {}
  restartPolicy: Never
```

## Correlating I/O Performance with Application Latency

### The USE Method for I/O

The USE (Utilization, Saturation, Errors) method applied to block I/O:

```bash
# Utilization: % of time device is busy
# -> iostat %util column
iostat -x 1 | awk 'NR>3 {print $1, $NF}' | grep "nvme\|sd[a-z]"

# Saturation: queue depth > 1 or significant await time
# -> iostat avgqu-sz and await columns
iostat -x 1 | awk 'NR>3 {print $1, $9, $10}' | grep "nvme\|sd[a-z]"
# Fields: device avgqu-sz await

# Errors: I/O errors from kernel
dmesg -T | grep -E "I/O error|sector error|SCSI error|nvme error"

# Extended error statistics from smartmontools
smartctl -a /dev/sda | grep -E "Reallocated|Pending|Uncorrectable|Error"
```

### Application-Correlated Tracing

```bash
# Correlate application request latency with I/O events using bpftrace
# This script traces both application-level function calls and I/O completions

bpftrace -e '
BEGIN {
    printf("Tracing I/O correlated with postgres queries...\n");
}

/* Trace Postgres query start */
uprobe:/usr/bin/postgres:exec_simple_query {
    @query_start[tid] = nsecs;
    @query_io_count[tid] = 0;
    @query_io_bytes[tid] = 0;
}

/* Track I/O issued during query */
tracepoint:block:block_rq_issue /pid == $1/ {
    if (@query_start[tid] != 0) {
        @query_io_count[tid]++;
        @query_io_bytes[tid] += args->nr_sector * 512;
    }
}

/* Trace Postgres query end */
uretprobe:/usr/bin/postgres:exec_simple_query {
    $start = @query_start[tid];
    if ($start != 0) {
        $lat_ms = (nsecs - $start) / 1000000;
        $io_count = @query_io_count[tid];
        $io_bytes = @query_io_bytes[tid];
        if ($lat_ms > 10) {  /* Only show queries > 10ms */
            printf("query_lat_ms=%d io_count=%d io_bytes=%d\n",
                   $lat_ms, $io_count, $io_bytes);
        }
        delete(@query_start[tid]);
        delete(@query_io_count[tid]);
        delete(@query_io_bytes[tid]);
    }
}
' $(pgrep -x postgres | head -1)
```

## Storage Throughput Analysis with vmstat and sar

```bash
# vmstat with block I/O columns (bi=blocks in, bo=blocks out)
vmstat 1 10
# procs  memory       swap       io      system      cpu
#  r  b   swpd   free   buff  cache    si  so    bi    bo   in   cs  us sy id wa st
#  2  1      0 2048000 123456 4567890    0   0  1234  5678  890 2345   5  3 87  5  0
# wa column = % time CPU waiting for I/O - high value indicates I/O bottleneck

# sar -d for device statistics over time
sar -d 1 60 > io-stats.txt

# Parse sar output for high-latency intervals
awk '/nvme|sda/ && $10 > 5 {print $0}' io-stats.txt  # await > 5ms

# iowait trend over 24 hours from sar logs
sar -u -f /var/log/sa/sa$(date +%d) | awk 'NF>=9 {print $1, $9}' | grep -v CPU
```

## Filesystem-Level I/O Tracing

### ext4 Tracepoints

```bash
# Trace ext4 write operations
bpftrace -e '
tracepoint:ext4:ext4_sync_file_enter {
    @[comm] = count();
}
tracepoint:ext4:ext4_sync_file_exit {
    @sync_lat = hist(args->ret);
}
interval:s:10 {
    print(@);
    print(@sync_lat);
    clear(@);
    clear(@sync_lat);
}'

# Trace page cache hit rate
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache { @add++ }
tracepoint:filemap:mm_filemap_delete_from_page_cache { @del++ }
kprobe:generic_file_read_iter {
    @reads++
}

interval:s:5 {
    printf("cache_add=%d cache_del=%d reads=%d\n", @add, @del, @reads);
    clear(@add); clear(@del); clear(@reads);
}'
```

### XFS I/O Tracing

```bash
# XFS provides xfs_io and dedicated tracepoints
# Check XFS metadata operations
bpftrace -e '
tracepoint:xfs:xfs_file_read_iter {
    @read_bytes = hist(args->count);
}
tracepoint:xfs:xfs_file_write_iter {
    @write_bytes = hist(args->count);
}
interval:s:10 {
    printf("=== XFS I/O size distribution ===\n");
    print(@read_bytes);
    print(@write_bytes);
    clear(@read_bytes);
    clear(@write_bytes);
}'

# XFS statistics from /proc
cat /proc/fs/xfs/stat | awk '
/^extent_alloc/ { print "Extent allocs:", $2, "Extent frees:", $3 }
/^abt/ { print "Alloc btree lookups:", $2 }
/^blk_map/ { print "Block reads:", $2, "Block writes:", $4 }
'
```

## I/O Latency Outlier Detection

Production I/O problems often manifest as tail latency spikes, not average latency degradation.

```bash
# Detect I/O operations exceeding threshold (10ms = 10000 usec)
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
    @comm_at_issue[args->dev, args->sector] = comm;
}

tracepoint:block:block_rq_complete {
    $start = @start[args->dev, args->sector];
    if ($start != 0) {
        $lat_us = (nsecs - $start) / 1000;
        if ($lat_us > 10000) {  /* 10ms threshold */
            printf("SLOW I/O: dev=%d:%d lat_us=%d comm=%s flags=%s\n",
                   args->dev >> 20, args->dev & 0xfffff,
                   $lat_us,
                   @comm_at_issue[args->dev, args->sector],
                   args->rwbs);
        }
        @latency_hist = hist($lat_us);
        delete(@start[args->dev, args->sector]);
        delete(@comm_at_issue[args->dev, args->sector]);
    }
}

END {
    clear(@start);
    clear(@comm_at_issue);
}'
```

### Write-Back Pressure Detection

Kernel write-back pressure causes processes to stall when dirty page ratio exceeds thresholds:

```bash
# Monitor dirty page ratio
while true; do
    DIRTY=$(cat /proc/meminfo | grep "^Dirty:" | awk '{print $2}')
    WRITEBACK=$(cat /proc/meminfo | grep "^Writeback:" | awk '{print $2}')
    TOTAL=$(cat /proc/meminfo | grep "^MemTotal:" | awk '{print $2}')
    DIRTY_PCT=$(echo "scale=2; $DIRTY * 100 / $TOTAL" | bc)
    echo "$(date): Dirty=${DIRTY}kB (${DIRTY_PCT}%), Writeback=${WRITEBACK}kB"
    sleep 1
done

# Check write-back tuning parameters
sysctl vm.dirty_ratio           # Max dirty ratio before processes are throttled
sysctl vm.dirty_background_ratio # Ratio at which background flusher starts
sysctl vm.dirty_expire_centisecs # Age before dirty pages are flushed
sysctl vm.dirty_writeback_centisecs # Flusher wakeup interval

# For databases or latency-sensitive workloads, reduce dirty ratios:
# (Test values - adjust based on workload)
sysctl -w vm.dirty_ratio=20
sysctl -w vm.dirty_background_ratio=5
```

## EBS Performance Analysis on AWS

Kubernetes clusters on AWS commonly use EBS volumes. EBS adds a network hop between the instance and storage.

```bash
# Check EBS volume type and IOPS provisioning
aws ec2 describe-volumes \
  --volume-ids $(aws ec2 describe-instances \
    --instance-id $(curl -s http://169.254.169.254/latest/meta-data/instance-id) \
    --query 'Reservations[].Instances[].BlockDeviceMappings[].Ebs.VolumeId' \
    --output text) \
  --query 'Volumes[].[VolumeId,VolumeType,Iops,Throughput,Size]' \
  --output table

# Monitor EBS metrics in CloudWatch
aws cloudwatch get-metric-statistics \
  --namespace AWS/EBS \
  --metric-name VolumeReadOps \
  --dimensions Name=VolumeId,Value=vol-0123456789abcdef0 \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 \
  --statistics Sum

# Check if EBS burst bucket is depleted (gp2 volumes)
aws cloudwatch get-metric-statistics \
  --namespace AWS/EBS \
  --metric-name BurstBalance \
  --dimensions Name=VolumeId,Value=vol-0123456789abcdef0 \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 \
  --statistics Average \
  --query 'Datapoints[?Average < `20`]' # Alert if burst balance < 20%
```

## Practical Diagnostic Workflow

When investigating a storage performance complaint, follow this sequence:

```bash
# Step 1: Identify which device and workload type
iostat -xz 1 5 | grep -v "^$"
# Look for: high %util, high await, or specific device with issues

# Step 2: Determine if it's read or write dominated
iostat -xz 1 5 | awk 'NF>10 {print $1, "r:", $4, "w:", $5, "r_await:", $11, "w_await:", $12}'

# Step 3: Check queue depth
iostat -xz 1 5 | awk 'NF>10 {print $1, "avgqu:", $9, "util:", $NF}'

# Step 4: Identify top I/O processes
/usr/share/bcc/tools/biotop 5 1

# Step 5: Check latency histogram
/usr/share/bcc/tools/biolatency -d /dev/nvme0n1 5 1

# Step 6: For outlier detection, use blktrace
blktrace -d /dev/nvme0n1 -w 30 -o /tmp/trace
blkparse -i /tmp/trace | awk '$6=="C" {
    # Calculate latency from Q to C events
    print $0
}' | tail -50

# Step 7: Correlate with application metrics
# Check application-level metrics at the same time window
# Look for correlation between I/O spikes and response time increases
```

## Production Tuning Reference

```bash
# /etc/sysctl.d/99-storage-tuning.conf

# Write-back tuning for database servers
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 500
vm.dirty_writeback_centisecs = 100

# Readahead - set to 0 for random I/O workloads (databases)
# blockdev --setra 0 /dev/nvme0n1
# Or persistent via udev:
# SUBSYSTEM=="block", ACTION=="add", KERNEL=="nvme*n*", RUN+="/sbin/blockdev --setra 0 /dev/%k"

# For sequential I/O workloads (log streaming, backups):
# blockdev --setra 4096 /dev/sda  # 4096 * 512 bytes = 2MB readahead

# Disable merging for NVMe (hardware handles this better)
echo 0 > /sys/block/nvme0n1/queue/nomerges  # 0=all, 1=simple, 2=none
# Or: echo 2 > /sys/block/nvme0n1/queue/nomerges  # Disable merge for latency

# Increase maximum I/O size for bulk workloads
echo 256 > /sys/block/nvme0n1/queue/max_sectors_kb
```

Effective storage performance analysis starts with the right tool for the right layer. `iostat` for quick utilization checks, `biolatency` for latency distribution profiles, `blktrace`/`btt` for detailed scheduler behavior, and bpftrace scripts for application-correlated root cause analysis. The combination covers the full spectrum from quick triage to deep-dive investigation.
