---
title: "Linux Storage Performance: fio Benchmarking and NVMe Optimization"
date: 2029-11-02T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "NVMe", "fio", "Performance", "Benchmarking", "iostat", "io_uring"]
categories: ["Linux", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to storage performance benchmarking with fio: job file construction, IOPS/throughput/latency benchmarks, queue depth optimization for NVMe, NVMe-specific kernel tuning, and interpreting iostat output for production diagnosis."
more_link: "yes"
url: "/linux-storage-performance-fio-benchmarking-nvme-optimization/"
---

Storage performance analysis is one of the most consequential skills for database administrators, infrastructure engineers, and anyone operating stateful workloads. `fio` (Flexible I/O Tester) is the definitive tool for measuring what your storage system can actually deliver versus what the vendor spec sheet claims. This guide covers systematic fio job file construction, interpreting results across the latency/IOPS/throughput dimensions, NVMe-specific tuning, and using `iostat` to diagnose production storage bottlenecks.

<!--more-->

# Linux Storage Performance: fio Benchmarking and NVMe Optimization

## Section 1: Storage Performance Fundamentals

Before benchmarking, understand what you are measuring:

**IOPS (I/O Operations Per Second)**: Number of read or write operations. Constrained by seek time on spinning disks, queue depth management on NVMe, and software overhead. Relevant for databases with many small random reads.

**Throughput (MB/s)**: Bytes transferred per second. Constrained by bus bandwidth and sequential access patterns. Relevant for video streaming, backup, and large sequential workloads.

**Latency (µs/ms)**: Time for a single I/O to complete. Constrained by physical seek time, queue depth, and software stack overhead. Critical for interactive database queries and real-time applications.

**Queue Depth (iodepth)**: How many I/Os are in-flight simultaneously. NVMe SSDs can handle 64-4096 outstanding I/Os per queue; spinning disks typically max at 4-32.

### Storage Stack Layers

```
Application (write syscall)
  └── VFS (Virtual File System)
        └── File System (ext4, xfs, btrfs)
              └── Block Layer
                    ├── I/O Scheduler (mq-deadline, kyber, none)
                    └── Device Driver (nvme, sd, virtio-blk)
                          └── Physical Storage
```

Each layer adds latency. `fio` can bypass layers to isolate bottlenecks:
- `ioengine=sync`: Uses read()/write() syscalls (full stack)
- `ioengine=libaio`: Async I/O (bypasses some VFS overhead)
- `ioengine=io_uring`: Linux 5.1+ high-performance async I/O
- `ioengine=io_uring,hipri`: Polling mode (bypasses interrupt overhead, highest performance, high CPU)

## Section 2: fio Job File Structure

fio uses INI-style job files. Understanding the structure is key to reproducible benchmarks:

```ini
# /etc/fio/jobs/nvme-characterization.fio
# Complete NVMe characterization suite

[global]
# The device under test
filename=/dev/nvme0n1

# Direct I/O bypasses page cache for accurate disk measurement
direct=1

# I/O engine: io_uring for modern Linux (5.1+)
# Fallback: libaio
ioengine=io_uring

# Runtime per test
runtime=60

# Write fio output to file
output-format=json+

# Steady-state detection: don't report until I/O is stable
steadystate=iops:0.5%
steadystate_duration=10

[randread-4k-q1]
description=4K random read, queue depth 1 (latency-sensitive baseline)
rw=randread
bs=4k
iodepth=1
numjobs=1

[randread-4k-q32]
description=4K random read, queue depth 32 (IOPS test)
rw=randread
bs=4k
iodepth=32
numjobs=8
group_reporting=1

[randwrite-4k-q32]
description=4K random write, queue depth 32
rw=randwrite
bs=4k
iodepth=32
numjobs=8
group_reporting=1

[seqread-128k]
description=128K sequential read (throughput test)
rw=read
bs=128k
iodepth=16
numjobs=4
group_reporting=1

[seqwrite-128k]
description=128K sequential write (throughput test)
rw=write
bs=128k
iodepth=16
numjobs=4
group_reporting=1

[mixed-7030]
description=70/30 mixed read/write, 4K random
rw=randrw
rwmixread=70
bs=4k
iodepth=64
numjobs=8
group_reporting=1
```

### Running fio

```bash
# Single job
fio --name=randread-4k \
    --filename=/dev/nvme0n1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --ioengine=io_uring \
    --iodepth=32 \
    --numjobs=4 \
    --runtime=60 \
    --group_reporting \
    --output-format=json+ \
    --output=results.json

# Job file
fio /etc/fio/jobs/nvme-characterization.fio 2>&1 | tee results.txt

# Preview without running
fio --parse-only /etc/fio/jobs/nvme-characterization.fio
```

## Section 3: Reading fio Output

```
randread-4k-q32: (groupid=0, jobs=8): err= 0: pid=12345: Mon Jan  1 00:00:00 2029
  read: IOPS=412.3k, BW=1610MiB/s (1688MB/s)(96.6GiB/60010msec)
    slat (nsec): min=1100, max=193768, avg=2254.61, stdev=1847.27
    clat (usec): min=10, max=35543, avg=617.37, stdev=1248.85
     lat (usec): min=11, max=35545, avg=619.63, stdev=1248.85
    clat percentiles (usec):
     |  1.00th=[   14],  5.00th=[   16], 10.00th=[   18], 20.00th=[   23],
     | 30.00th=[   29], 40.00th=[   37], 50.00th=[   52], 60.00th=[  104],
     | 70.00th=[  412], 80.00th=[ 1418], 90.00th=[ 2900], 95.00th=[ 3752],
     | 99.00th=[ 6456], 99.50th=[ 7898], 99.90th=[12649], 99.99th=[21627]
  cpu          : usr=6.92%, sys=11.03%, ctx=25012347, majf=0, minf=8
  IO depths    : 1=0.1%, 2=0.1%, 4=0.1%, 8=0.1%, 16=0.1%, 32=100.0%, >=64=0.0%
     submit    : 0=0.0%, 4=100.0%, 8=0.0%, 16=0.0%, 32=0.0%, 64=0.0%, >=64=0.0%
     complete  : 0=0.0%, 4=100.0%, 8=0.0%, 16=0.0%, 32=0.0%, 64=0.0%, >=64=0.0%
     issued rwts: total=24740576,0,0,0 short=0,0,0,0 dropped=0,0,0,0
     latency   : target=0, window=0, percentile=100.00%, depth=32
```

**Interpreting key fields:**

- `IOPS=412.3k`: 412,300 4K reads/second
- `slat (submission latency)`: Time to submit I/O to kernel. Should be <10µs for io_uring
- `clat (completion latency)`: Time from kernel submission to completion. This is the disk latency
- `lat (total latency)`: slat + clat. What the application waits
- **p50=52µs, p99=6.5ms**: Median latency is excellent; tail latency has high variance — common with NVMe SSDs under load
- `IO depths`: Almost all at 32 — good, we're fully utilizing the queue depth
- `ctx=25012347`: High context switches — consider using polling mode for lower latency

## Section 4: Benchmarking Profiles for Different Workloads

### Database OLTP Profile (PostgreSQL, MySQL)

```ini
# /etc/fio/jobs/db-oltp.fio
[global]
filename=/dev/nvme0n1
direct=1
ioengine=io_uring
runtime=120
group_reporting=1
randrepeat=0  # Don't repeat random sequence (more realistic)
norandommap=1  # Skip tracking per-block writes

[db-oltp-read]
description=Database OLTP read pattern
rw=randread
bs=8k      # Typical PostgreSQL/InnoDB page size
iodepth=16
numjobs=4

[db-oltp-write]
description=Database OLTP write pattern
rw=randwrite
bs=8k
iodepth=4   # Databases typically have lower write concurrency
numjobs=2

[db-wal]
description=WAL/Redo log write (sequential, fsync-heavy)
rw=write
bs=8k
iodepth=1   # WAL is typically sequential and low-depth
numjobs=1
fdatasync=1  # Simulate fsync per write
```

### Kafka/Streaming Profile (Sequential Writes)

```ini
# /etc/fio/jobs/kafka.fio
[global]
filename=/dev/nvme0n1
direct=1
ioengine=io_uring
runtime=120

[kafka-producer]
description=Kafka producer pattern: large sequential writes
rw=write
bs=1m
iodepth=8
numjobs=4
group_reporting=1

[kafka-consumer]
description=Kafka consumer pattern: large sequential reads
rw=read
bs=1m
iodepth=8
numjobs=4
group_reporting=1
```

### Kubernetes etcd Profile

etcd is extremely latency-sensitive. WAL writes must complete in <10ms:

```ini
# /etc/fio/jobs/etcd.fio
[global]
# Use a file within an xfs filesystem
filename=/var/lib/etcd/fio-test
size=2G
direct=1
ioengine=io_uring
runtime=60

[etcd-wal]
description=etcd WAL simulation: small sequential writes with fsync
rw=write
bs=2300   # etcd WAL record size
iodepth=1
numjobs=1
fdatasync=1

[etcd-data]
description=etcd data writes
rw=randwrite
bs=2300
iodepth=4
numjobs=2
group_reporting=1
```

A healthy NVMe for etcd should show `fdatasync` latency <1ms at p99.

## Section 5: Queue Depth Optimization

Queue depth (iodepth) dramatically affects performance. Finding the optimal value requires testing:

```bash
#!/bin/bash
# scripts/queue-depth-sweep.sh
# Tests NVMe performance across queue depths

DEV="${1:-/dev/nvme0n1}"
OUTPUT_DIR="./qd-sweep-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

for QD in 1 2 4 8 16 32 64 128 256; do
    echo "Testing queue depth $QD..."
    fio \
        --name=randread-qd${QD} \
        --filename="$DEV" \
        --rw=randread \
        --bs=4k \
        --direct=1 \
        --ioengine=io_uring \
        --iodepth=${QD} \
        --numjobs=1 \
        --runtime=30 \
        --output-format=json \
        --output="${OUTPUT_DIR}/qd${QD}.json"
done

# Extract and plot IOPS vs latency
echo "QD,IOPS,p50_lat_us,p99_lat_us,p9999_lat_us"
for QD in 1 2 4 8 16 32 64 128 256; do
    python3 -c "
import json, sys
with open('${OUTPUT_DIR}/qd${QD}.json') as f:
    data = json.load(f)
job = data['jobs'][0]['read']
iops = job['iops']
p50 = job['clat_ns']['percentile']['50.000000'] / 1000
p99 = job['clat_ns']['percentile']['99.000000'] / 1000
p9999 = job['clat_ns']['percentile']['99.990000'] / 1000
print(f'${QD},{iops:.0f},{p50:.1f},{p99:.1f},{p9999:.1f}')
"
done
```

Typical NVMe results (Samsung 980 Pro 1TB):

```
QD,IOPS,p50_lat_us,p99_lat_us,p9999_lat_us
1,42000,23.1,52.4,178.0
2,84000,23.5,59.1,195.0
4,165000,24.1,75.6,234.0
8,320000,24.9,89.3,412.0
16,540000,29.4,155.2,1240.0
32,680000,46.1,298.5,3840.0
64,720000,88.2,562.0,7890.0
128,730000,174.0,1024.0,14200.0
256,731000,348.0,2048.0,28600.0
```

The sweet spot is QD=32: near-peak IOPS with manageable p99 latency. Beyond QD=64, IOPS plateaus while latency grows rapidly.

## Section 6: NVMe-Specific Kernel Tuning

### I/O Scheduler Selection

NVMe devices work best with specific schedulers:

```bash
# Check current scheduler
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber

# NVMe recommendations:
# none: Best for high-performance NVMe (no scheduler overhead)
# mq-deadline: For mixed workloads that need latency guarantees
# kyber: Budget latency targets (good for SSDs)

# Set none for high-performance NVMe
echo none > /sys/block/nvme0n1/queue/scheduler

# Make persistent
cat > /etc/udev/rules.d/60-nvme-scheduler.rules << 'EOF'
# Disable I/O scheduler for NVMe devices
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"
# Use mq-deadline for SATA SSDs
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
# Use bfq for spinning disks
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
EOF

udevadm control --reload-rules
udevadm trigger --type=devices --action=change
```

### Queue Depth Parameters

```bash
# NVMe hardware queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# 1023

# Increase for high-throughput workloads
echo 2048 > /sys/block/nvme0n1/queue/nr_requests

# Read-ahead: reduce for random I/O (databases)
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb

# For sequential workloads (streaming), increase read-ahead
echo 4096 > /sys/block/nvme0n1/queue/read_ahead_kb

# Add write-same support check
cat /sys/block/nvme0n1/queue/write_same_max_bytes

# Enable persistent memory for NVMe (if supported)
cat /sys/block/nvme0n1/queue/write_zeroes_max_bytes
```

### io_uring Configuration

```bash
# Check io_uring is available
ls /proc/*/fdinfo/ 2>/dev/null | head -5

# Kernel parameters for io_uring performance
# Set maximum locked memory for io_uring buffers
# Add to /etc/security/limits.conf:
# * hard memlock unlimited
# * soft memlock unlimited

# Or set for the database user:
echo "postgres hard memlock unlimited" >> /etc/security/limits.conf
echo "postgres soft memlock unlimited" >> /etc/security/limits.conf

# Verify
ulimit -l  # Should show unlimited after re-login
```

### Filesystem Tuning for NVMe

```bash
# Format with optimal parameters for NVMe
mkfs.xfs \
    -f \
    -d agcount=8 \          # Allocation groups (match CPU cores)
    -l size=256m,lazy-count=1 \  # Large log for write-heavy workloads
    -s size=4096 \           # 4K sector size
    /dev/nvme0n1

# Mount with NVMe-optimized options
mount -o \
    noatime,nodiratime,\    # Skip access time updates
    nobarrier,\             # Skip barriers (safe for NVMe with battery-backed cache)
    allocsize=64m,\         # Large preallocation for streaming
    logbsize=256k \         # Large log buffer
    /dev/nvme0n1 /data

# /etc/fstab entry
/dev/nvme0n1  /data  xfs  noatime,nodiratime,logbsize=256k,allocsize=64m  0 2
```

**For etcd (latency-critical):**

```bash
# etcd requires reliable fsync — no nobarrier
mkfs.xfs -f /dev/nvme1n1

mount -o \
    noatime,nodiratime \   # Only skip access time, keep barriers
    /dev/nvme1n1 /var/lib/etcd
```

## Section 7: iostat Interpretation

`iostat` is the primary tool for production storage monitoring:

```bash
# Real-time monitoring, 1-second intervals
iostat -x -m 1

# Output:
# Device  r/s    w/s   rMB/s  wMB/s  avgrq-sz avgqu-sz await r_await w_await svctm %util
# nvme0n1 45231  8234  176.68  32.16    8.64    26.3   0.52   0.41    0.89   0.01  50.3
```

**Key fields explained:**

| Field | Meaning | Warning Threshold |
|-------|---------|-------------------|
| `r/s`, `w/s` | Read/write operations per second | Device-specific |
| `rMB/s`, `wMB/s` | Throughput | Near device max = saturated |
| `avgrq-sz` | Average request size in sectors (512B) | Low = random, High = sequential |
| `avgqu-sz` | Average queue depth | >device optimal QD = bottleneck |
| `await` | Average I/O time (ms) | >10ms for NVMe = investigate |
| `r_await`, `w_await` | Read/write latency separately | >5ms for NVMe reads = investigate |
| `svctm` | Service time (deprecated, ignore) | N/A |
| `%util` | Device utilization | >80% = approaching saturation |

### Diagnosing Storage Bottlenecks

```bash
#!/bin/bash
# scripts/storage-diagnosis.sh
# Quick storage health check

echo "=== NVMe Device Status ==="
nvme list

echo ""
echo "=== I/O Pressure ==="
cat /proc/pressure/io
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
# "full" > 0 means processes were blocked waiting for I/O

echo ""
echo "=== Current I/O Stats (5 samples) ==="
iostat -x -m 1 5 | grep -v "^$" | tail -30

echo ""
echo "=== Processes with High I/O ==="
iotop -b -n 3 -d 1 | head -20

echo ""
echo "=== NVMe Error Counts ==="
for nvme in /dev/nvme*n*; do
    echo "--- $nvme ---"
    nvme smart-log "$nvme" 2>/dev/null | grep -E "(error|warning|media|percentage)"
done

echo ""
echo "=== Block Device Queue Stats ==="
for dev in $(ls /sys/block/ | grep nvme); do
    echo "--- $dev ---"
    echo "  scheduler: $(cat /sys/block/$dev/queue/scheduler)"
    echo "  nr_requests: $(cat /sys/block/$dev/queue/nr_requests)"
    echo "  read_ahead_kb: $(cat /sys/block/$dev/queue/read_ahead_kb)"
    echo "  queue_depth: $(cat /sys/block/$dev/device/queue_depth 2>/dev/null || echo N/A)"
done
```

### Production Monitoring with Prometheus

```yaml
# node-exporter automatically exports key storage metrics:
# node_disk_reads_completed_total
# node_disk_writes_completed_total
# node_disk_read_bytes_total
# node_disk_written_bytes_total
# node_disk_io_time_seconds_total
# node_disk_read_time_seconds_total

# Useful Prometheus queries:
groups:
  - name: storage
    rules:
      - alert: DiskIOHigh
        expr: |
          rate(node_disk_io_time_seconds_total{device=~"nvme.*"}[5m]) > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NVMe {{ $labels.device }} is over 90% utilized"

      - alert: DiskWriteLatencyHigh
        expr: |
          rate(node_disk_write_time_seconds_total{device=~"nvme.*"}[5m]) /
          rate(node_disk_writes_completed_total{device=~"nvme.*"}[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NVMe write latency > 10ms"

      - alert: DiskReadLatencyHigh
        expr: |
          rate(node_disk_read_time_seconds_total{device=~"nvme.*"}[5m]) /
          rate(node_disk_reads_completed_total{device=~"nvme.*"}[5m]) > 0.005
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "NVMe read latency > 5ms — database queries may be affected"
```

## Section 8: NVMe Namespace and Multi-Queue Verification

```bash
# List NVMe devices
nvme list
# Node            SN                   Model                    Namespace Usage                      Format           FW Rev
# /dev/nvme0n1    S4DYNX0N123456       Samsung SSD 980 PRO 1TB  1         1.00  TB / 1.00  TB    512   B +  0 B   5B2QGXA7

# View NVMe device capabilities
nvme id-ctrl /dev/nvme0 | grep -E "(SQES|CQES|NN|ONCS|VWCI|sqe|cqe)"

# Check Multi-Queue (blk-mq) configuration
cat /sys/block/nvme0n1/mq/*/nr_tags 2>/dev/null | head -5
# Number of tags per hardware queue

# Count hardware queues
ls /sys/block/nvme0n1/mq/ | wc -l
# Should equal number of CPU cores (up to NVMe max queues)

# View queue to CPU affinity
cat /sys/block/nvme0n1/mq/*/cpu_list

# NVMe SMART health
nvme smart-log /dev/nvme0n1
# Critical Warning:                  0x00
# Temperature:                        35 Celsius
# Available Spare:                    100%
# Available Spare Threshold:          10%
# Percentage Used:                    0%
# Data Units Read:                    1,234,567 [632 GB]
# Data Units Written:                 9,876,543 [5.05 TB]
# Host Read Commands:                 45,678,901
# Host Write Commands:                12,345,678
# Controller Busy Time:               12,345
# Power Cycles:                       42
# Power On Hours:                     1,234
# Unsafe Shutdowns:                   5
# Media and Data Integrity Errors:    0  <-- Should be 0
# Error Information Log Entries:      0  <-- Should be 0
```

## Section 9: Benchmarking Cloud Storage

Cloud storage (EBS, Azure Managed Disks, GCE Persistent Disk) requires different testing approaches:

```ini
# /etc/fio/jobs/ebs-io2.fio
# For AWS EBS io2 with 64,000 IOPS provisioned

[global]
filename=/dev/xvdb
direct=1
ioengine=io_uring
runtime=120
group_reporting=1

[ebs-randread-peak]
description=Peak IOPS test for provisioned io2
rw=randread
bs=16k        # EBS measures IOPS in 16KB units
iodepth=256   # EBS requires high queue depth to reach provisioned IOPS
numjobs=16

[ebs-throughput]
description=Peak throughput (EBS bandwidth limit)
rw=read
bs=256k       # Large blocks for throughput
iodepth=64
numjobs=4
```

**Cloud storage caveats:**
- EBS `gp3` defaults to 3,000 IOPS and 125 MB/s — must be provisioned for more
- `io2 Block Express` can reach 256,000 IOPS — requires high queue depth (iodepth=256+)
- Network-attached storage (EFS, Azure Files) has much higher latency than local NVMe
- Always benchmark with the same instance size you'll use in production

## Conclusion

Storage performance benchmarking with fio is both a science and an art. The key to useful benchmarks is matching the workload pattern (block size, access pattern, queue depth, read/write ratio) to your actual application's I/O characteristics. A database OLTP workload is nothing like a streaming media server, and an NVMe SSD tuned for one performs differently for the other.

Key takeaways:
- Use `direct=1` for accurate disk benchmarks (bypasses page cache)
- `io_uring` outperforms `libaio` on Linux 5.10+ — always use it for NVMe
- Queue depth sweet spot for modern NVMe is typically 32-64 for mixed workloads
- Set scheduler to `none` for dedicated NVMe devices, `mq-deadline` for shared use
- Monitor `%util` and `await` in production; `%util` near 100% means your storage is saturated
- Use `nvme smart-log` to detect media errors and excessive wear early
- Cloud EBS requires high queue depth (iodepth=256+) to reach provisioned IOPS
