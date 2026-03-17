---
title: "Linux Storage Performance: NVMe Tuning, RAID Configuration, and I/O Scheduler Selection"
date: 2030-06-25T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "NVMe", "RAID", "mdadm", "LVM", "I/O Scheduler", "fio", "Performance"]
categories:
- Linux
- Storage
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise storage tuning: NVMe queue depth optimization, software RAID with mdadm, LVM cache volumes, I/O scheduler selection (none vs mq-deadline vs BFQ), and benchmarking with fio."
more_link: "yes"
url: "/linux-storage-performance-nvme-tuning-raid-io-scheduler/"
---

Storage performance is the hidden bottleneck in the majority of production database and object store deployments. Modern NVMe SSDs are capable of millions of IOPS and sequential throughput exceeding 7 GB/s, but the default Linux configuration leaves much of that performance unrealized. Queue depth settings, I/O scheduler selection, filesystem mount options, RAID stripe alignment, and LVM cache configuration collectively determine whether a storage subsystem approaches its hardware ceiling or delivers a fraction of it.

<!--more-->

## NVMe Architecture and Queue Depth

### How NVMe Queues Work

NVMe devices communicate with the host over PCIe and implement the NVMe specification's queue model: up to 65,535 submission queues paired with 65,535 completion queues, each capable of 65,536 entries. This is a fundamental departure from SATA/SAS devices, which had a single command queue with a maximum depth of 32 (SATA) or 254 (SAS).

The Linux Multi-Queue Block (blk-mq) subsystem maps NVMe queues to CPU cores. Each CPU core (or group of cores, depending on the driver configuration) gets its own hardware dispatch queue, eliminating the global queue lock that limited SATA performance under concurrency.

```bash
# Examine NVMe queue configuration
ls -la /sys/block/nvme0n1/mq/

# Check number of hardware queues
cat /sys/block/nvme0n1/mq/0/cpu_list

# Current queue depth per queue
cat /sys/block/nvme0n1/queue/nr_requests

# Maximum supported queue depth (hardware limit)
cat /sys/block/nvme0n1/queue/max_hw_sectors_kb
```

### Tuning NVMe Queue Depth

The `nr_requests` parameter controls the maximum number of I/O requests that can be in flight per queue:

```bash
# Check current queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# Default: 256 or 1024 depending on kernel version

# Increase for high-concurrency database workloads
echo 4096 > /sys/block/nvme0n1/queue/nr_requests

# Apply to all NVMe devices
for dev in /sys/block/nvme*/queue/nr_requests; do
    echo 4096 > "$dev"
    echo "Set $dev to 4096"
done
```

Make the setting persistent with udev:

```bash
# /etc/udev/rules.d/60-nvme-queue-depth.rules
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/nr_requests}="4096", \
    ATTR{queue/read_ahead_kb}="256"
```

### Read-Ahead Tuning

NVMe random I/O workloads benefit from reduced read-ahead. Sequential workloads need more:

```bash
# For database random I/O (PostgreSQL, MySQL, etc.)
echo 16 > /sys/block/nvme0n1/queue/read_ahead_kb

# For sequential workloads (backup, analytics)
echo 2048 > /sys/block/nvme0n1/queue/read_ahead_kb

# Check current value
blockdev --getra /dev/nvme0n1
# Returns sectors; divide by 2 for KB

# Set via blockdev (takes KB)
blockdev --setra 32 /dev/nvme0n1
```

### NVMe Namespace Parameters

Modern NVMe drives expose namespace-level parameters relevant to performance:

```bash
# Query NVMe identify namespace
nvme id-ns /dev/nvme0n1 | grep -E "nlbaf|lbads|ms|nsze|ncap"

# Check power states and current latency profile
nvme get-feature /dev/nvme0 -f 0x2  # Power Management

# Set to maximum performance state (disable power saving)
nvme set-feature /dev/nvme0 -f 0x2 -v 0
```

## I/O Scheduler Selection

Linux's blk-mq framework supports several schedulers. For NVMe devices, the choice is critical:

### none (No-Op Scheduler)

```bash
# Check available schedulers
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# The scheduler in brackets is active
```

`none` passes I/O directly to the device without reordering. It is optimal for NVMe SSDs because:
- NVMe devices have their own internal command queuing that is more sophisticated than any host-side scheduler
- Reordering by the host adds latency without improving throughput
- The device firmware handles wear leveling and internal queue management

```bash
# Set none scheduler for NVMe
echo none > /sys/block/nvme0n1/queue/scheduler

# Persist with udev
# /etc/udev/rules.d/60-nvme-scheduler.rules
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/scheduler}="none"
```

### mq-deadline

`mq-deadline` is a lightweight multi-queue scheduler that prevents starvation by enforcing deadline expiration. It is appropriate for:
- Mixed read/write workloads on SATA SSDs
- Workloads where latency guarantees matter more than peak throughput
- Storage used by real-time or latency-sensitive processes

```bash
echo mq-deadline > /sys/block/sda/queue/scheduler

# Tune deadline parameters
# read_expire: ms before reads become urgent (default 500ms)
echo 100 > /sys/block/sda/queue/iosched/read_expire

# write_expire: ms before writes become urgent (default 5000ms)
echo 1000 > /sys/block/sda/queue/iosched/write_expire

# writes_starved: how many read batches before forcing a write batch
echo 4 > /sys/block/sda/queue/iosched/writes_starved
```

### BFQ (Budget Fair Queuing)

BFQ is appropriate for storage shared across multiple competing processes, particularly desktop/interactive workloads or Kubernetes nodes where container I/O isolation is needed:

```bash
echo bfq > /sys/block/sda/queue/scheduler

# BFQ provides cgroup-based I/O isolation
# Assign weights in the blkio cgroup hierarchy
echo "8:0 100" > /sys/fs/cgroup/blkio/high-priority-app/blkio.bfq.weight
echo "8:0 10" > /sys/fs/cgroup/blkio/low-priority-app/blkio.bfq.weight
```

### Scheduler Selection Matrix

| Device Type | Workload | Recommended Scheduler |
|---|---|---|
| NVMe SSD | Any | `none` |
| SATA SSD | Database/random | `mq-deadline` |
| SATA SSD | Multi-tenant | `bfq` |
| HDD | Single workload | `mq-deadline` |
| HDD | Multi-tenant | `bfq` |
| HDD | Sequential throughput | `mq-deadline` |

## Software RAID with mdadm

### RAID Level Selection

| Level | Redundancy | Write Penalty | Use Case |
|---|---|---|---|
| RAID 0 | None | 1x | Scratch/temp (no production use) |
| RAID 1 | 1 disk failure | 2x | Boot volumes, metadata |
| RAID 5 | 1 disk failure | 4x | Read-heavy; avoid for write-intensive |
| RAID 6 | 2 disk failures | 6x | Archival; high write penalty |
| RAID 10 | 1 disk per mirror pair | 2x | Databases, high-write production |

### Creating a RAID 10 Array

```bash
# Verify drives are clean
for dev in /dev/nvme{0..3}n1; do
    echo "=== $dev ==="
    mdadm --examine $dev 2>&1 | head -5
done

# Create RAID 10 with 4 NVMe devices
mdadm --create /dev/md0 \
    --level=10 \
    --raid-devices=4 \
    --layout=n2 \
    --chunk=512 \
    /dev/nvme0n1 /dev/nvme1n1 /dev/nvme2n1 /dev/nvme3n1

# Monitor creation progress
watch -n 2 cat /proc/mdstat

# Save configuration
mdadm --detail --scan >> /etc/mdadm/mdadm.conf
update-initramfs -u
```

### Stripe Width and Chunk Size

For RAID 10 with 4 drives (2 mirrors of 2), data is striped across 2 drives:
- Chunk size: the size of data written to each drive before moving to the next
- Stripe width = (number of data drives) * chunk size

```bash
# For databases with 8KB pages (PostgreSQL, MySQL)
# Recommended chunk: 512KB for NVMe, 256KB for SATA SSD
mdadm --create /dev/md0 \
    --level=10 \
    --raid-devices=4 \
    --chunk=512 \
    /dev/nvme0n1 /dev/nvme1n1 /dev/nvme2n1 /dev/nvme3n1

# Verify array details
mdadm --detail /dev/md0
```

### Filesystem Alignment with RAID Stripe

When creating a filesystem on a RAID array, the filesystem must be aligned to the stripe width to avoid read-modify-write cycles:

```bash
# Get RAID stripe information
mdadm --detail /dev/md0 | grep -E "Chunk Size|Raid Devices"
# Chunk Size: 512K
# Raid Devices: 4 (RAID 10 = 2 data drives, so stripe width = 2 * 512K = 1MB)

# For ext4: align to stripe width
# stride = chunk_size / block_size = 512K / 4K = 128
# stripe_width = stride * (data_disks) = 128 * 2 = 256
mkfs.ext4 \
    -b 4096 \
    -E stride=128,stripe_width=256,lazy_itable_init=0,lazy_journal_init=0 \
    /dev/md0

# For XFS: align sunit and swidth
# sunit = chunk_size in 512-byte blocks = 512K / 512 = 1024
# swidth = sunit * data_disks = 1024 * 2 = 2048
mkfs.xfs \
    -b size=4096 \
    -d su=524288,sw=2 \
    /dev/md0

# Verify XFS alignment
xfs_info /dev/md0
```

### RAID Monitoring and Alerting

```bash
# Check array health
cat /proc/mdstat

# Detailed status
mdadm --detail /dev/md0

# Configure email alerts
# /etc/mdadm/mdadm.conf
MAILADDR storage-alerts@company.com
MAILFROM mdadm@host.company.com

# Enable mdmonitor service
systemctl enable --now mdmonitor

# Test alert
mdadm --monitor --scan --test --oneshot

# Check for write errors or read errors on member drives
mdadm --detail /dev/md0 | grep -E "Failed|State|Errors"
```

### Degraded Array Recovery

```bash
# Identify failed drive
mdadm --detail /dev/md0 | grep "faulty"

# Remove failed drive
mdadm /dev/md0 --fail /dev/nvme2n1
mdadm /dev/md0 --remove /dev/nvme2n1

# After physical replacement, add new drive
mdadm /dev/md0 --add /dev/nvme2n1

# Monitor rebuild progress
watch -n 5 cat /proc/mdstat

# Rebuild speed tuning
echo 200000 > /proc/sys/dev/raid/speed_limit_min
echo 1000000 > /proc/sys/dev/raid/speed_limit_max
```

## LVM Configuration and Cache Volumes

### LVM on RAID

```bash
# Create a physical volume on the RAID array
pvcreate /dev/md0

# Create a volume group
vgcreate data-vg /dev/md0

# Create logical volumes
lvcreate -L 100G -n postgres-data data-vg
lvcreate -L 50G -n postgres-wal data-vg
lvcreate -L 20G -n postgres-temp data-vg

# Create filesystem
mkfs.xfs -b size=4096 -d su=524288,sw=2 /dev/data-vg/postgres-data
```

### LVM Cache with NVMe Tiers

LVM cache allows using fast NVMe drives as a cache for slower HDD-based RAID arrays:

```bash
# Scenario: 8x HDD RAID 6 as slow tier, 2x NVMe as cache tier
# Create physical volumes
pvcreate /dev/md0      # HDD RAID 6
pvcreate /dev/nvme0n1  # NVMe cache device 1
pvcreate /dev/nvme1n1  # NVMe cache device 2

# Create volume group with both tiers
vgcreate storage-vg /dev/md0 /dev/nvme0n1 /dev/nvme1n1

# Create the slow origin volume on HDD
lvcreate -L 10T -n data-origin storage-vg /dev/md0

# Create a RAID 1 cache pool on NVMe for redundancy
lvcreate --type raid1 -L 400G -n cache-data storage-vg /dev/nvme0n1 /dev/nvme1n1
lvcreate --type raid1 -L 4G -n cache-meta storage-vg /dev/nvme0n1 /dev/nvme1n1

# Convert data and metadata into a cache pool
lvconvert --type cache-pool \
    --poolmetadata storage-vg/cache-meta \
    storage-vg/cache-data

# Attach cache pool to origin volume
lvconvert --type cache \
    --cachepool storage-vg/cache-data \
    storage-vg/data-origin

# Check cache statistics
lvs -a -o name,size,cachemode,cachepolicy,cachehits,cachemisses \
    storage-vg/data-origin

# dmsetup status shows detailed hit/miss ratio
dmsetup status storage-vg-data--origin
```

### LVM Thin Provisioning for Kubernetes

Thin provisioning enables snapshot-based persistent volume provisioning:

```bash
# Create a thin pool
lvcreate \
    --type thin-pool \
    --size 5T \
    --poolmetadatasize 50G \
    -n k8s-thin-pool \
    data-vg

# Enable zero-out of newly allocated blocks
lvchange --zero y data-vg/k8s-thin-pool

# Enable discards passthrough for SSDs
lvchange --discards passdown data-vg/k8s-thin-pool

# Thin volumes are provisioned on demand
lvcreate \
    --type thin \
    --thin-pool k8s-thin-pool \
    --virtualsize 200G \
    -n pvc-xyz \
    data-vg

# Monitor pool utilization
lvs -o name,size,data_percent,metadata_percent data-vg/k8s-thin-pool
```

## Filesystem Mount Options for Performance

### XFS Production Mount Options

```bash
# /etc/fstab entry for NVMe XFS database volume
/dev/data-vg/postgres-data  /var/lib/postgresql  xfs  \
    defaults,noatime,nodiratime,logbufs=8,logbsize=256k,\
    largeio,inode64,allocsize=2m  0 2

# Key options:
# noatime,nodiratime: disable access time updates (significant for metadata-heavy workloads)
# logbufs=8: number of in-memory log buffers (default 8, max 8)
# logbsize=256k: log buffer size (default 32k, max 256k for better throughput)
# largeio: prefer large I/O sizes for stripe alignment
# inode64: allow inodes to be allocated anywhere in the filesystem
# allocsize=2m: delayed allocation writeout size (2MB for large file workloads)
```

### ext4 Production Mount Options

```bash
/dev/data-vg/data  /data  ext4  \
    defaults,noatime,nodiratime,data=ordered,barrier=1,\
    commit=60,errors=remount-ro  0 2

# Key options:
# data=ordered: metadata journaling with ordered data writes (safe default)
# barrier=1: enforce write barriers (required for data integrity, small perf cost)
# commit=60: journal commit interval in seconds (default 5; increase for write throughput)
```

### tmpfs for Temporary Data

```bash
# Mount a tmpfs for PostgreSQL temp_tablespace
tmpfs  /var/lib/postgresql/temp  tmpfs  \
    size=32G,mode=0750,uid=postgres,gid=postgres  0 0
```

## Benchmarking with fio

### Establishing Baseline Performance

```bash
# Install fio
apt-get install -y fio || yum install -y fio

# Sequential read throughput (128K blocks, queue depth 32)
fio \
    --name=seq-read \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=read \
    --bs=128k \
    --direct=1 \
    --size=10G \
    --runtime=60 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --output-format=json \
    --output=seq-read-baseline.json

# Sequential write throughput
fio \
    --name=seq-write \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=write \
    --bs=128k \
    --direct=1 \
    --size=10G \
    --runtime=60 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --output-format=json \
    --output=seq-write-baseline.json

# Random read IOPS (4K blocks, queue depth 1 - latency focused)
fio \
    --name=rand-read-lat \
    --ioengine=libaio \
    --iodepth=1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=10G \
    --runtime=60 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --output-format=json \
    --output=rand-read-latency.json

# Random read IOPS (4K blocks, queue depth 128 - throughput focused)
fio \
    --name=rand-read-iops \
    --ioengine=libaio \
    --iodepth=128 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=10G \
    --runtime=60 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --output-format=json \
    --output=rand-read-iops.json
```

### Database Workload Simulation

```bash
# PostgreSQL-like mixed workload: 70% random read, 30% random write
fio \
    --name=postgres-sim \
    --ioengine=libaio \
    --iodepth=64 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=8k \
    --direct=1 \
    --size=50G \
    --runtime=300 \
    --time_based \
    --numjobs=4 \
    --group_reporting \
    --filename=/dev/md0 \
    --output-format=json \
    --output=postgres-workload.json

# Extract key metrics from JSON output
jq '
  .jobs[0] |
  {
    read_iops: .read.iops,
    read_bw_MBps: (.read.bw / 1024),
    read_lat_p99_us: .read.clat_ns.percentile."99.000000",
    write_iops: .write.iops,
    write_bw_MBps: (.write.bw / 1024),
    write_lat_p99_us: .write.clat_ns.percentile."99.000000"
  }
' postgres-workload.json
```

### Latency Distribution Analysis

```bash
# Collect latency percentile data
fio \
    --name=lat-dist \
    --ioengine=libaio \
    --iodepth=1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=10G \
    --runtime=120 \
    --time_based \
    --lat_percentiles=1 \
    --percentile_list=50:75:90:95:99:99.9:99.99:99.999 \
    --filename=/dev/nvme0n1 \
    --output-format=json | \
  jq '.jobs[0].read.clat_ns.percentile |
    to_entries[] |
    "\(.key)th percentile: \(.value / 1000) µs"' -r
```

### Comparing Scheduler Performance

```bash
#!/bin/bash
# compare-schedulers.sh
# Compare I/O schedulers on a specific device

DEVICE=${1:-/dev/nvme0n1}
FIO_OPTS="--ioengine=libaio --iodepth=32 --rw=randread --bs=4k --direct=1 --size=5G --runtime=30 --time_based"

for sched in none mq-deadline bfq; do
    # Check if scheduler is available
    if grep -q "$sched" /sys/block/$(basename $DEVICE)/queue/scheduler; then
        echo "$sched" > /sys/block/$(basename $DEVICE)/queue/scheduler
        echo "=== Scheduler: $sched ==="
        fio $FIO_OPTS --name=test-$sched --filename=$DEVICE --output-format=terse | \
            awk -F';' '{printf "IOPS: %s  BW: %s KB/s  lat_p99: %s µs\n", $8, $7, $40}'
    else
        echo "Scheduler $sched not available on $DEVICE"
    fi
done
```

## Kernel Parameters for Storage Performance

```bash
# /etc/sysctl.d/99-storage-performance.conf

# Increase dirty page ratio for write-intensive workloads
# Default: 20% of RAM can be dirty before background writeback
vm.dirty_ratio = 40

# Background writeback starts at this percentage
vm.dirty_background_ratio = 10

# Maximum time a dirty page can stay dirty (in centiseconds)
vm.dirty_expire_centisecs = 3000

# Writeback interval (centiseconds)
vm.dirty_writeback_centisecs = 500

# Disable transparent hugepages for databases (managed separately)
# Set in /sys/kernel/mm/transparent_hugepage/enabled instead

# Swappiness: prefer keeping file cache over swapping
# For dedicated storage servers: 10
# For database servers: 1 or 0
vm.swappiness = 10

# vfs_cache_pressure: tendency to reclaim inode/dentry cache
# Lower values preserve directory entry cache (good for metadata-heavy workloads)
vm.vfs_cache_pressure = 50
```

Apply kernel parameters:

```bash
sysctl -p /etc/sysctl.d/99-storage-performance.conf
```

## NVMe-oF (NVMe over Fabrics)

For disaggregated storage architectures, NVMe-oF extends NVMe semantics over RDMA or TCP networks:

```bash
# Load NVMe-oF TCP target modules
modprobe nvmet
modprobe nvmet-tcp

# Configure a target subsystem
mkdir -p /sys/kernel/config/nvmet/subsystems/test-subsystem
echo 1 > /sys/kernel/config/nvmet/subsystems/test-subsystem/attr_allow_any_host

# Create a namespace
mkdir -p /sys/kernel/config/nvmet/subsystems/test-subsystem/namespaces/1
echo /dev/nvme0n1 > /sys/kernel/config/nvmet/subsystems/test-subsystem/namespaces/1/device_path
echo 1 > /sys/kernel/config/nvmet/subsystems/test-subsystem/namespaces/1/enable

# Configure a port
mkdir -p /sys/kernel/config/nvmet/ports/1
echo "192.168.100.10" > /sys/kernel/config/nvmet/ports/1/addr_traddr
echo tcp > /sys/kernel/config/nvmet/ports/1/addr_trtype
echo 4420 > /sys/kernel/config/nvmet/ports/1/addr_trsvcid
echo ipv4 > /sys/kernel/config/nvmet/ports/1/addr_adrfam

# Connect subsystem to port
ln -s /sys/kernel/config/nvmet/subsystems/test-subsystem \
    /sys/kernel/config/nvmet/ports/1/subsystems/test-subsystem

# On the initiator (client) side
modprobe nvme-tcp
nvme discover -t tcp -a 192.168.100.10 -s 4420
nvme connect -t tcp -a 192.168.100.10 -s 4420 -n test-subsystem
```

## Production Monitoring

### iostat Monitoring

```bash
# Continuous I/O monitoring
iostat -x -m 2 /dev/nvme0n1

# Key metrics:
# r/s, w/s: reads and writes per second (IOPS)
# rMB/s, wMB/s: throughput
# r_await, w_await: average I/O latency (ms)
# aqu-sz: average queue size (high values indicate saturation)
# %util: utilization (for SSDs, >80% may indicate saturation)

# Alert on queue depth exceeding threshold
while true; do
    QSIZE=$(iostat -x 1 1 nvme0n1 | awk '/nvme0n1/ {print $14}')
    if (( $(echo "$QSIZE > 64" | bc -l) )); then
        echo "ALERT: Queue depth $QSIZE exceeds threshold on nvme0n1"
    fi
    sleep 5
done
```

### Prometheus Node Exporter Storage Metrics

```bash
# Key metrics to alert on:
# node_disk_read_bytes_total, node_disk_written_bytes_total
# node_disk_reads_completed_total, node_disk_writes_completed_total
# node_disk_read_time_seconds_total / node_disk_reads_completed_total = avg read latency
# node_disk_io_time_seconds_total: time spent doing I/O (utilization proxy)

# Prometheus alerting rule for high I/O latency
cat > /etc/prometheus/alerts/storage.yml << 'YAML'
groups:
- name: storage
  rules:
  - alert: HighDiskReadLatency
    expr: |
      rate(node_disk_read_time_seconds_total[5m]) /
      rate(node_disk_reads_completed_total[5m]) > 0.010
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High disk read latency on {{ $labels.device }}"
      description: "Read latency {{ $value | humanizeDuration }} exceeds 10ms"

  - alert: DiskSaturation
    expr: rate(node_disk_io_time_seconds_total[5m]) > 0.9
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Disk saturation on {{ $labels.device }}"
      description: "Disk utilization {{ $value | humanizePercentage }}"
YAML
```

## Tuning Summary Checklist

- Set I/O scheduler to `none` for all NVMe devices via udev rules
- Set `nr_requests` to 4096 for NVMe devices under high-concurrency workloads
- Set `read_ahead_kb` to 16 for random I/O (databases) or 2048 for sequential (backups)
- Align RAID chunk size to workload I/O size; use RAID 10 for databases
- Align filesystem `stride` and `stripe_width` to RAID geometry
- Set `vm.dirty_ratio` and `vm.dirty_background_ratio` based on write intensity
- Use LVM cache to tier NVMe in front of HDD arrays
- Benchmark with `fio` before and after each change with consistent workload profiles
- Monitor `r_await`, `w_await`, and `aqu-sz` in production with Prometheus

The combination of correct scheduler selection, queue depth tuning, RAID alignment, and filesystem options can improve observed latency by 40-60% on real workloads compared to default kernel settings on the same hardware.
