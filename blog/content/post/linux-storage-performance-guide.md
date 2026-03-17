---
title: "Linux Storage Performance: I/O Schedulers, Caching, and NVMe Optimization"
date: 2027-09-20T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "Performance", "NVMe"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive Linux storage performance guide covering I/O schedulers, fio benchmarking methodology, bcache/dm-cache tiered storage, NVMe queue depth tuning, and RAID configuration for containers."
more_link: "yes"
url: "/linux-storage-performance-guide/"
---

Storage performance is frequently the last bottleneck identified in containerized environments after network and CPU have been optimized. Linux provides a comprehensive set of I/O scheduler policies, block device tunables, kernel page-cache controls, and tiered storage mechanisms that together determine whether a Kafka broker saturates its NVMe drives or a PostgreSQL primary exhibits write amplification. This guide provides a systematic approach to Linux storage performance tuning with production benchmarking methodology.

<!--more-->

## I/O Scheduler Architecture

### Block Layer Position

The Linux multi-queue block layer (blk-mq) processes I/O requests through hardware dispatch queues mapped to CPU cores. The I/O scheduler sits between the block layer and driver submission queue, reordering and merging requests for efficiency:

```
Application
  syscalls: read/write
VFS / Page Cache
  bio submission
Block Layer (blk-mq)
  I/O Scheduler: mq-deadline / kyber / bfq / none
Hardware Dispatch Queue (per-CPU)
  NVMe/SCSI Driver
Physical Device
```

### Checking and Setting I/O Schedulers

```bash
# List available schedulers per device
cat /sys/block/sda/queue/scheduler
# [mq-deadline] kyber bfq none

cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline

# Set schedulers
echo mq-deadline > /sys/block/sda/queue/scheduler
echo none > /sys/block/nvme0n1/queue/scheduler

# Persist via udev
cat > /etc/udev/rules.d/60-io-scheduler.rules << 'EOF'
# NVMe — no scheduler (device manages internal queues)
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/scheduler}="none"

# SSD SATA — mq-deadline for predictable latency
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="0", \
    ATTR{queue/scheduler}="mq-deadline"

# HDD — bfq for process-level fairness
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="1", \
    ATTR{queue/scheduler}="bfq"
EOF

udevadm trigger --subsystem-match=block --action=change

for dev in $(lsblk -dno NAME | grep -v loop); do
    echo "$dev: $(cat /sys/block/$dev/queue/scheduler 2>/dev/null)"
done
```

### mq-deadline Parameters

```bash
# Read deadline (ms) — default 500ms
echo 500 > /sys/block/sda/queue/iosched/read_expire

# Write deadline (ms) — default 5000ms
echo 5000 > /sys/block/sda/queue/iosched/write_expire

# Write batches before read dispatch
echo 16 > /sys/block/sda/queue/iosched/fifo_batch

# Max write starvation before read priority
echo 2 > /sys/block/sda/queue/iosched/writes_starved
```

### kyber Parameters (Low-Latency NVMe)

```bash
# Target read latency (ns) — default 2ms
echo 2000000 > /sys/block/nvme0n1/queue/iosched/read_lat_nsec

# Target write latency — default 10ms
echo 10000000 > /sys/block/nvme0n1/queue/iosched/write_lat_nsec
```

### bfq Parameters (Per-Process Fairness)

```bash
# Idle slice for sequential processes (ms)
echo 8 > /sys/block/sda/queue/iosched/slice_idle

# Enable low-latency mode
echo 1 > /sys/block/sda/queue/iosched/low_latency

# Maximum budget in sectors (0 = auto)
echo 0 > /sys/block/sda/queue/iosched/max_budget
```

## Block Device Tuning

### Queue Depth and Merging

```bash
# Check and set queue depth
cat /sys/block/nvme0n1/queue/nr_requests   # typically 1023 or 2047

echo 2047 > /sys/block/nvme0n1/queue/nr_requests
echo 32   > /sys/block/sda/queue/nr_requests   # SATA SSD NCQ depth

# Read-ahead: maximize for sequential, disable for random
echo 8192 > /sys/block/nvme0n1/queue/read_ahead_kb   # 8MB
echo 0    > /sys/block/nvme0n1/queue/read_ahead_kb   # disable

# Request merging: disable for NVMe, enable for HDD
echo 2 > /sys/block/nvme0n1/queue/nomerges   # disable all
echo 0 > /sys/block/sda/queue/nomerges       # allow all
```

### NVMe-Specific Tuning

```bash
# Device inventory
nvme list
nvme list-subsys

# SMART health
nvme smart-log /dev/nvme0 | grep -E "percentage_used|unsafe_shutdowns|media_errors"

# Error log
nvme error-log /dev/nvme0

# Disable APST (Autonomous Power State Transitions) for latency
nvme set-feature /dev/nvme0 -f 0x0c -v 0

# Enable NVMe multipath (kernel 5.0+)
echo "options nvme_core multipath=Y" > /etc/modprobe.d/nvme-multipath.conf

# udev persistent NVMe settings
cat > /etc/udev/rules.d/61-nvme-tuning.rules << 'EOF'
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/nr_requests}="2047", \
    ATTR{queue/read_ahead_kb}="0", \
    ATTR{queue/nomerges}="2"
EOF
```

## fio Benchmarking Methodology

### Baseline Tests

```bash
# Install fio
apt-get install -y fio
dnf install -y fio

# 1. Sequential read throughput (always use direct=1 to bypass page cache)
fio --name=seq-read \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=read \
    --bs=1M \
    --direct=1 \
    --size=16G \
    --filename=/dev/nvme0n1 \
    --numjobs=4 \
    --group_reporting \
    --runtime=60 \
    --time_based

# 2. Random 4K read IOPS (NVMe ceiling)
fio --name=rand-read-4k \
    --ioengine=libaio \
    --iodepth=64 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=16G \
    --filename=/dev/nvme0n1 \
    --numjobs=8 \
    --group_reporting \
    --runtime=60 \
    --time_based

# 3. Mixed random 70/30 read/write (OLTP profile)
fio --name=mixed-rw \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4k \
    --direct=1 \
    --size=16G \
    --filename=/dev/nvme0n1 \
    --numjobs=4 \
    --group_reporting \
    --runtime=60 \
    --time_based

# 4. Sync write latency (PostgreSQL, etcd, Kafka)
fio --name=sync-write \
    --ioengine=sync \
    --rw=randwrite \
    --bs=4k \
    --direct=1 \
    --sync=1 \
    --size=4G \
    --filename=/dev/nvme0n1 \
    --numjobs=1 \
    --runtime=60 \
    --time_based \
    --percentile_list=50:90:99:99.9:99.99
```

### Kubernetes PVC Benchmark

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: fio-benchmark
  namespace: default
spec:
  template:
    spec:
      containers:
      - name: fio
        image: ljishen/fio:latest
        args:
        - --name=pvc-test
        - --ioengine=libaio
        - --iodepth=16
        - --rw=randrw
        - --rwmixread=70
        - --bs=4k
        - --size=4G
        - --filename=/data/testfile
        - --numjobs=4
        - --runtime=60
        - --time_based
        - --group_reporting
        - --output-format=json
        volumeMounts:
        - mountPath: /data
          name: test-volume
      volumes:
      - name: test-volume
        persistentVolumeClaim:
          claimName: benchmark-pvc
      restartPolicy: Never
```

### Parsing fio JSON Output

```python
#!/usr/bin/env python3
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

for job in data['jobs']:
    r = job['read']
    w = job['write']
    print(f"\n=== {job['jobname']} ===")
    if r['iops'] > 0:
        pct = r['lat_ns'].get('percentile', {})
        print(f"Read  IOPS: {r['iops']:.0f}  BW: {r['bw']/1024:.1f} MiB/s")
        print(f"Read  P50: {pct.get('50.000000',0)/1000:.1f}us  "
              f"P99: {pct.get('99.000000',0)/1000:.1f}us  "
              f"P99.9: {pct.get('99.900000',0)/1000:.1f}us")
    if w['iops'] > 0:
        pct = w['lat_ns'].get('percentile', {})
        print(f"Write IOPS: {w['iops']:.0f}  BW: {w['bw']/1024:.1f} MiB/s")
        print(f"Write P99: {pct.get('99.000000',0)/1000:.1f}us")
```

## tmpfs and ramfs for Ephemeral Data

```bash
# Mount tmpfs for ephemeral container scratch space
mount -t tmpfs -o size=4G,mode=1777,noatime tmpfs /tmp

# /etc/fstab entries
cat >> /etc/fstab << 'EOF'
tmpfs  /tmp      tmpfs  defaults,size=4G,mode=1777,noatime    0 0
tmpfs  /run/shm  tmpfs  defaults,size=2G,nodev,nosuid,noexec  0 0
EOF

# Kubernetes memory-backed emptyDir
volumes:
- name: scratch
  emptyDir:
    medium: Memory
    sizeLimit: 2Gi

df -h -t tmpfs
```

### Huge Pages for Memory-Mapped Storage

```bash
# Reserve 2MB huge pages for JVM or DPDK
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Reserve 1GB huge pages
echo 8 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Persist in kernel cmdline
# hugepagesz=1G hugepages=8

mkdir -p /dev/hugepages
mount -t hugetlbfs -o pagesize=1G hugetlbfs /dev/hugepages

cat /proc/meminfo | grep HugePages
```

## Tiered Storage: bcache and dm-cache

### bcache Configuration

```bash
apt-get install -y bcache-tools

# Prepare devices (DESTRUCTIVE — erases all data)
wipefs -a /dev/sdb
wipefs -a /dev/nvme0n1p1

make-bcache -B /dev/sdb             # HDD backing device
make-bcache -C /dev/nvme0n1p1       # SSD cache device

CSET_UUID=$(bcache-super-show /dev/nvme0n1p1 | grep cset.uuid | awk '{print $2}')
echo "$CSET_UUID" > /sys/block/bcache0/bcache/attach

cat /sys/block/bcache0/bcache/state

# Set writeback mode (cache writes, flush periodically)
echo writeback > /sys/block/bcache0/bcache/cache_mode

# Bypass cache for large sequential I/O (512KB)
echo 512 > /sys/block/bcache0/bcache/sequential_cutoff

# Monitor hit ratio
cat /sys/block/bcache0/bcache/stats_total/cache_hit_ratio

mkfs.ext4 -m 0 /dev/bcache0
mount /dev/bcache0 /mnt/cached
```

### dm-cache via LVM

```bash
pvcreate /dev/nvme0n1p2   # NVMe cache PV
pvcreate /dev/sdb         # HDD data PV
vgcreate vg-tiered /dev/nvme0n1p2 /dev/sdb

# Create origin on HDD
lvcreate -L 500G -n data vg-tiered /dev/sdb

# Create cache on NVMe
lvcreate -L 50G  -n cache_data vg-tiered /dev/nvme0n1p2
lvcreate -L 500M -n cache_meta vg-tiered /dev/nvme0n1p2

# Build cache pool
lvconvert --type cache-pool \
    --poolmetadata vg-tiered/cache_meta \
    vg-tiered/cache_data

# Attach to origin
lvconvert --type cache \
    --cachepool vg-tiered/cache_data \
    vg-tiered/data

# Monitor cache performance
lvs -a -o name,size,cachereadmisses,cachewritemisses,cacheusedblocks \
    vg-tiered/data

lvchange --cachemode writeback vg-tiered/data
```

## Software RAID for Container Hosts

### RAID 10 with mdadm

```bash
# RAID 10 (4 devices) — optimal for database containers
mdadm --create /dev/md0 \
    --level=10 \
    --raid-devices=4 \
    --chunk=64 \
    /dev/sdb /dev/sdc /dev/sdd /dev/sde

watch -n5 cat /proc/mdstat

mdadm --detail --scan >> /etc/mdadm/mdadm.conf
update-initramfs -u   # Debian/Ubuntu
dracut -f             # RHEL

# Stripe cache size
echo 32768 > /sys/block/md0/md/stripe_cache_size

# Sync speed limits (protect production I/O during rebuild)
echo 10000  > /proc/sys/dev/raid/speed_limit_min
echo 200000 > /proc/sys/dev/raid/speed_limit_max

# Filesystem aligned to RAID geometry
# stride = chunk_kb / block_size = 64K / 4K = 16
# stripe-width = stride * data_disks = 16 * 2 = 32 (RAID-10 2+2)
mkfs.ext4 -m 0 -E stride=16,stripe-width=32 /dev/md0

mdadm --detail /dev/md0 | grep -E "State|Active|Failed|Spare"
cat /proc/mdstat
```

### RAID Failure and Recovery

```bash
# Remove failed drive
mdadm --fail /dev/md0 /dev/sdb
mdadm --remove /dev/md0 /dev/sdb

# Add replacement
mdadm --add /dev/md0 /dev/sdf
watch -n5 cat /proc/mdstat

# Email alerting
cat >> /etc/mdadm/mdadm.conf << 'EOF'
MAILADDR alerts@example.internal
EOF

systemctl enable --now mdmonitor
```

## Page Cache Management

### vmtouch — Cache Residency Control

```bash
apt-get install -y vmtouch

# Show cache percentage for a directory
vmtouch -v /var/lib/postgresql/15/main/base/

# Lock WAL directory in cache (prevent eviction)
vmtouch -l /var/lib/postgresql/15/main/pg_wal/

# Evict cold data from cache
vmtouch -e /tmp/old-export-file

# Prefetch before a known-access window
vmtouch -t /var/lib/postgresql/15/main/pg_wal/
```

### sysctl Page Cache Tuning

```bash
# /etc/sysctl.d/12-pagecache.conf

# Reduce vfs_cache_pressure to retain dentry/inode caches
vm.vfs_cache_pressure = 50

# Dirty page writeback
vm.dirty_background_ratio = 5
vm.dirty_ratio = 15
vm.dirty_expire_centisecs = 500
vm.dirty_writeback_centisecs = 100
```

## iostat and blktrace Analysis

### Real-Time Monitoring

```bash
# Extended iostat output
iostat -x -m 1 5

# Key fields:
# r/s, w/s       requests per second
# rMB/s, wMB/s   throughput
# r_await        average read latency (ms, includes queue time)
# w_await        average write latency (ms)
# aqu-sz         average queue depth (>1 = saturation for HDD)
# %util          100% = saturated for HDD (not meaningful for NVMe)

# Per-process I/O
iotop -b -n 3 -d 1 -o

# blktrace — per-request tracing
blktrace -d /dev/nvme0n1 -o /tmp/nvme-trace &
sleep 10 && kill %1

blkparse -i /tmp/nvme-trace.blktrace.0 | head -50
btt -i /tmp/nvme-trace.blktrace.0 | head -30

# Key btt metrics:
# Q2C = total I/O latency (application-visible)
# D2C = device service time
# Q2D = scheduler queue time (Q2C minus D2C)
```

### Slow I/O Detection with bpftrace

```
#!/usr/bin/env bpftrace

tracepoint:block:block_rq_issue
{
    @s[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_rq_complete
/@s[args->dev, args->sector]/
{
    $lat_us = (nsecs - @s[args->dev, args->sector]) / 1000;
    if ($lat_us > 10000) {
        printf("SLOW IO dev=%d sector=%llu lat=%d us op=%s\n",
               args->dev, args->sector, $lat_us, args->rwbs);
    }
    @io_lat_us = hist($lat_us);
    delete(@s[args->dev, args->sector]);
}

END { print(@io_lat_us); }
```

## Troubleshooting I/O Issues

```bash
# Device errors in kernel log
dmesg -T | grep -iE "error|reset|abort|failed|timeout" \
    | grep -iE "nvme|sd[a-z]|ata"

# NVMe error log
nvme error-log /dev/nvme0

# Hung task timeout (I/O stall)
dmesg -T | grep -E "hung_task_timeout|INFO: task.*blocked"

# Filesystem consistency check
xfs_repair -n /dev/md0   # XFS dry-run
e2fsck -n /dev/sdb       # ext4 dry-run

# Large directory in overlay
du -sh /var/lib/docker/overlay2/ 2>/dev/null | sort -rh | head -10

# Disk full
df -h
```

## Summary

Linux storage performance optimization requires understanding the full I/O path from application call to device completion. I/O scheduler selection forms the foundation: none for NVMe, mq-deadline for SATA SSD, bfq for HDD. Block device queue depth, read-ahead, and merge policies tune the interface between scheduler and hardware. Systematic fio benchmarking with direct I/O, appropriate queue depth, and P99 latency percentiles provides actionable data rather than peak-IOPS figures that obscure tail latency. Tiered storage with bcache or dm-cache extends NVMe performance economics to capacity workloads. Software RAID with carefully chosen chunk sizes and filesystem alignment delivers both redundancy and striped throughput for database containers. The combination of iostat, blktrace, and bpftrace provides visibility at every layer when latency spikes or throughput anomalies require investigation.
