---
title: "Linux Dirty Page Writeback: Tuning vm.dirty_ratio for Databases"
date: 2029-09-01T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Kernel", "Databases", "PostgreSQL", "MySQL", "vm.dirty_ratio", "I/O"]
categories: ["Linux", "Performance", "Databases"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux dirty page writeback mechanics covering the pdflush/flusher thread architecture, vm.dirty_ratio vs vm.dirty_background_ratio, write amplification effects, and database-specific kernel tuning for PostgreSQL and MySQL."
more_link: "yes"
url: "/linux-dirty-page-writeback-tuning-vm-dirty-ratio-databases/"
---

Database servers exhibit I/O latency spikes that look random but follow a predictable pattern: writes are fast for a while, then suddenly pause for hundreds of milliseconds. In most cases this is the Linux page cache flushing dirty pages to disk — a behavior that is entirely tunable but requires understanding the kernel writeback subsystem. This guide explains the dirty page lifecycle and provides concrete tuning recipes for PostgreSQL, MySQL, and MongoDB on SSDs.

<!--more-->

# Linux Dirty Page Writeback: Tuning vm.dirty_ratio for Databases

## Section 1: The Dirty Page Lifecycle

Linux does not write data to disk immediately when a process writes to a file. Instead, the written data is marked as "dirty" in the page cache — a region of physical RAM that caches file content. Dirty pages are flushed to disk by kernel threads at regular intervals or when memory pressure reaches configured thresholds.

### Why This Matters for Databases

For most applications, background writeback is invisible. For databases, it directly impacts write latency because:

1. **Threshold flushing causes write stalls**: When dirty pages accumulate to `vm.dirty_ratio` percent of system RAM, the process that triggered the write is forced to wait while the kernel flushes pages. This appears as a sudden write latency spike.

2. **Background threshold matters**: `vm.dirty_background_ratio` controls when background flushing starts. If this is set too high, dirty pages accumulate until they approach `vm.dirty_ratio`, causing large flush bursts instead of gradual trickle writes.

3. **Write amplification**: Frequent small flushes can reduce the effectiveness of I/O merging in the block layer, increasing actual I/O operations vs. logical writes.

### Dirty Page State Machine

```
Application write()
        |
        v
   [Page Cache]
   page state: Clean
        |
        v (first write)
   page state: Dirty
        |
        +---> [background_ratio threshold] --> pdflush/flusher threads write async
        |
        +---> [dirty_ratio threshold] --> process blocked, kernel flushes sync
        |
        v (flush completes)
   page state: Clean
```

## Section 2: Kernel Writeback Architecture

### The Flusher Thread Pool

Modern Linux uses per-device flusher threads (replacing the older pdflush design). Each block device gets a dedicated `kworker` thread for writeback:

```bash
# List writeback kernel threads
ps aux | grep kworker | grep flush
# Output:
# root      123  0.0  0.0  0  0 ?  I 00:00:00 [kworker/u8:1-flush-8:16]
# root      124  0.0  0.0  0  0 ?  I 00:00:00 [kworker/u8:2-flush-8:32]

# Check writeback statistics in real time
cat /proc/vmstat | grep dirty
# nr_dirty 12847          <- Currently dirty pages
# nr_writeback 0          <- Pages being written back right now
# nr_writeback_temp 0
# nr_dirty_threshold 204800  <- dirty_ratio threshold in pages
# nr_dirty_background_threshold 102400  <- background_ratio threshold in pages

# Watch writeback activity
watch -n 1 'cat /proc/vmstat | grep -E "dirty|writeback"'
```

### Writeback Configuration Parameters

```bash
# View current dirty page settings
sysctl -a | grep vm.dirty

# The six critical parameters:
# vm.dirty_background_ratio      (default: 10)
# vm.dirty_background_bytes      (default: 0 - use ratio)
# vm.dirty_ratio                 (default: 20)
# vm.dirty_bytes                 (default: 0 - use ratio)
# vm.dirty_writeback_centisecs   (default: 500 = 5 seconds)
# vm.dirty_expire_centisecs      (default: 3000 = 30 seconds)
```

| Parameter | Description | Default |
|---|---|---|
| `vm.dirty_background_ratio` | % of RAM at which background flush starts | 10% |
| `vm.dirty_background_bytes` | Absolute byte threshold for background flush (overrides ratio) | 0 |
| `vm.dirty_ratio` | % of RAM at which process write blocks | 20% |
| `vm.dirty_bytes` | Absolute byte threshold for process blocking (overrides ratio) | 0 |
| `vm.dirty_writeback_centisecs` | How often flusher threads wake up (centiseconds) | 500 (5s) |
| `vm.dirty_expire_centisecs` | How old dirty pages must be before they are flushed | 3000 (30s) |

## Section 3: The Problem with Default Settings

### Default Settings on a 256 GiB Database Server

On a server with 256 GiB of RAM:
- `vm.dirty_ratio = 20` means dirty pages can accumulate to **51.2 GiB** before any process is blocked
- `vm.dirty_background_ratio = 10` means background flushing only starts at **25.6 GiB** of dirty data

For a PostgreSQL server writing to a `fast-ssd` (e.g., 3 GiB/s sustained write throughput), 51.2 GiB represents about **17 seconds** of accumulated writes. When the threshold is hit, the flush is a massive burst that completely saturates I/O for seconds — a catastrophic event for any latency-sensitive workload.

```bash
# Check how much RAM your dirty_ratio actually represents
python3 -c "
import subprocess
mem_kb = int([l for l in open('/proc/meminfo').readlines()
              if l.startswith('MemTotal')][0].split()[1])
mem_gb = mem_kb / 1024 / 1024
ratio = 20  # Default vm.dirty_ratio
bg_ratio = 10  # Default vm.dirty_background_ratio
print(f'Total RAM: {mem_gb:.1f} GiB')
print(f'dirty_ratio threshold: {mem_gb * ratio / 100:.1f} GiB ({ratio}%)')
print(f'dirty_background_ratio threshold: {mem_gb * bg_ratio / 100:.1f} GiB ({bg_ratio}%)')
"
```

### Observing Write Stalls

```bash
# Check if dirty page flushing is causing write latency spikes
# Using iostat
iostat -x 1 | awk '/^Device/ || /sd|nvme/ {print strftime("%H:%M:%S"), $0}'

# Look for: high %util (near 100%) combined with high w_await (write latency ms)

# Using vmstat
vmstat 1 | awk '{print strftime("%H:%M:%S"), $0}'
# Look for: bo (blocks out) spikes - large numbers indicate flush bursts

# Using /proc/diskstats for detailed I/O accounting
cat /proc/diskstats | awk '{print $3, $8, $12}' | sort -k2 -n | tail -5
# Column 3: device name
# Column 8: write I/Os completed
# Column 12: write time (ms)

# Using blktrace for microsecond-level I/O analysis
sudo blktrace -d /dev/nvme0n1 -o - | blkparse -i - | grep -E "Q|C" | head -100
```

## Section 4: Tuning for Database Workloads

### The Key Principle: Use Absolute Bytes, Not Ratios

On systems with large RAM, `vm.dirty_bytes` and `vm.dirty_background_bytes` provide predictable behavior regardless of RAM size. Set these based on your storage system's throughput, not as a percentage of RAM.

**Target formula**: Set `dirty_background_bytes` to approximately 2-5 seconds of your storage's write throughput. Set `dirty_bytes` to approximately 10-15 seconds of write throughput.

```bash
# Measure your NVMe's sustained write throughput
fio --name=write_throughput_test \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=write \
    --bs=1M \
    --numjobs=4 \
    --size=10G \
    --runtime=30 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --direct=1 \
    --group_reporting

# Example output: WRITE: bw=2500MiB/s, iops=2500
# Storage throughput: 2.5 GiB/s sustained
```

### PostgreSQL Tuning Recipe

PostgreSQL uses `fsync()` and explicit `checkpoint` operations to control durability. The interaction between PostgreSQL's checkpoint system and Linux's dirty page writeback is subtle.

```bash
# PostgreSQL on NVMe SSD (2.5 GiB/s write throughput)
# Background flush target: 2 seconds of writes = 5 GiB
# Process block threshold: 10 seconds of writes = 25 GiB

cat > /etc/sysctl.d/60-postgresql-writeback.conf << 'EOF'
# Dirty page writeback tuning for PostgreSQL on NVMe SSD
# System: 256 GiB RAM, NVMe SSD with ~2.5 GiB/s write throughput

# Background flush starts at 5 GiB of dirty data
vm.dirty_background_bytes = 5368709120

# Process write stall at 25 GiB of dirty data
vm.dirty_bytes = 26843545600

# Use absolute bytes settings - disable ratio settings
# (when _bytes is set, the corresponding _ratio is ignored)
# vm.dirty_background_ratio = 10   # Ignored when _bytes is set
# vm.dirty_ratio = 20               # Ignored when _bytes is set

# Wake up flusher threads every 1 second (default 5s is too slow for databases)
vm.dirty_writeback_centisecs = 100

# Flush dirty pages that are older than 10 seconds (default 30s is too long)
vm.dirty_expire_centisecs = 1000

# Disable transparent hugepages for PostgreSQL (reduces latency jitter)
# Set in /sys/kernel/mm/transparent_hugepage/enabled instead
EOF

sysctl -p /etc/sysctl.d/60-postgresql-writeback.conf
```

```ini
# postgresql.conf additions for writeback-tuned systems
# File: /etc/postgresql/16/main/postgresql.conf

# Checkpoint settings - allow PostgreSQL to spread its own I/O
checkpoint_completion_target = 0.9    # Spread writes over 90% of checkpoint interval
max_wal_size = 4GB                    # Larger WAL = less frequent checkpoints
min_wal_size = 1GB
checkpoint_timeout = 15min            # Maximum time between checkpoints

# bgwriter settings - reduce dirty page bursts from PostgreSQL side
bgwriter_delay = 100ms                # Run every 100ms (default 200ms)
bgwriter_lru_maxpages = 200           # Write up to 200 pages per round
bgwriter_lru_multiplier = 10.0        # Aggressively write LRU dirty pages

# Shared memory settings
shared_buffers = 64GB                 # 25% of RAM - PostgreSQL manages its own page cache
effective_cache_size = 192GB          # For query planning - 75% of RAM

# I/O settings
random_page_cost = 1.1                # NVMe: random I/O is close to sequential
effective_io_concurrency = 200        # NVMe can handle high concurrency
maintenance_work_mem = 2GB            # For VACUUM, CREATE INDEX
```

### MySQL/InnoDB Tuning Recipe

InnoDB's buffer pool interacts with the OS page cache differently from PostgreSQL's shared_buffers. InnoDB writes to disk through the buffer pool, and dirty pages in the buffer pool interact with Linux dirty pages.

```bash
# MySQL/InnoDB on NVMe SSD
cat > /etc/sysctl.d/60-mysql-writeback.conf << 'EOF'
# Dirty page writeback for MySQL InnoDB on NVMe
# More aggressive background flush than PostgreSQL
# because InnoDB has its own adaptive flushing

# Background flush at 2 GiB (more aggressive - InnoDB does its own flushing)
vm.dirty_background_bytes = 2147483648

# Process block at 10 GiB
vm.dirty_bytes = 10737418240

# Faster writeback wakeup
vm.dirty_writeback_centisecs = 100
vm.dirty_expire_centisecs = 500

# Swappiness: 1 avoids swapping under memory pressure
# (0 completely disables, 1 allows only emergency swap)
vm.swappiness = 1
EOF

sysctl -p /etc/sysctl.d/60-mysql-writeback.conf
```

```ini
# /etc/mysql/mysql.conf.d/innodb-writeback.cnf
[mysqld]
# InnoDB buffer pool - typically 70-80% of RAM
innodb_buffer_pool_size = 196G

# Number of buffer pool instances (1 per 1 GiB of buffer pool, max 64)
innodb_buffer_pool_instances = 64

# Adaptive flushing - helps avoid burst I/O from the kernel writeback threshold
innodb_adaptive_flushing = ON
innodb_adaptive_flushing_lwm = 10  # Start adaptive flushing at 10% dirty pages

# InnoDB flush method: O_DIRECT bypasses OS page cache for data files
# This means InnoDB dirty pages don't interact with vm.dirty_ratio at all
innodb_flush_method = O_DIRECT

# Redo log size
innodb_redo_log_capacity = 8G

# I/O capacity settings - calibrate to NVMe throughput
innodb_io_capacity = 10000      # Background IOPS budget
innodb_io_capacity_max = 40000  # Burst IOPS budget

# Flush neighbors: disable for SSD (it's designed for spinning disk)
innodb_flush_neighbors = 0

# Page cleaner threads
innodb_page_cleaners = 8  # Match innodb_buffer_pool_instances up to 64

# Checkpoint age at which dirty page flushing becomes more aggressive
innodb_max_dirty_pages_pct = 90    # Allow up to 90% dirty pages in buffer pool
innodb_max_dirty_pages_pct_lwm = 10 # Start background flushing at 10%
```

### MongoDB Tuning Recipe

MongoDB's WiredTiger storage engine has its own cache and checkpoint mechanism.

```bash
# MongoDB WiredTiger on NVMe
cat > /etc/sysctl.d/60-mongodb-writeback.conf << 'EOF'
# Dirty page writeback for MongoDB WiredTiger on NVMe

# Background flush at 4 GiB
vm.dirty_background_bytes = 4294967296

# Process block at 16 GiB
vm.dirty_bytes = 17179869184

# Standard writeback timing
vm.dirty_writeback_centisecs = 100
vm.dirty_expire_centisecs = 1000

# NUMA: disable zone reclaim for MongoDB
vm.zone_reclaim_mode = 0

# Reduce swappiness
vm.swappiness = 1
EOF

sysctl -p /etc/sysctl.d/60-mongodb-writeback.conf
```

## Section 5: Measuring the Impact

### Before/After Comparison with fio

```bash
# Simulate database write pattern: 4K random writes sustained
# Run this BEFORE applying tuning, then AFTER, and compare p99 latency

fio --name=db_write_pattern \
    --ioengine=libaio \
    --iodepth=64 \
    --rw=randwrite \
    --bs=4k \
    --numjobs=8 \
    --size=50G \
    --runtime=120 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --direct=1 \
    --group_reporting \
    --percentile_list=50,90,95,99,99.9,99.99

# Key metrics to compare:
# WRITE: bw=XXX MiB/s, iops=XXX
#   lat (usec): min=X, max=X, avg=X, stdev=X
#   clat percentiles (usec):
#    |  50.00th=[  XXX], 90.00th=[  XXX], 95.00th=[  XXX],
#    |  99.00th=[  XXX], 99.90th=[  XXXX], 99.99th=[ XXXXX]
```

### Real-Time Monitoring

```bash
# Monitor dirty page behavior during a load test
# Terminal 1: watch dirty pages
watch -n 0.5 'awk "/MemTotal/{total=\$2} /Dirty/{dirty=\$2} END{
  printf \"Dirty: %d MiB (%.1f%% of %d GiB)\n\",
  dirty/1024, dirty/total*100, total/1024/1024}" /proc/meminfo'

# Terminal 2: watch writeback activity
watch -n 0.5 'awk "/nr_dirty/{d=\$2} /nr_writeback/{w=\$2} END{
  printf \"Dirty: %d pages | Writing back: %d pages\n\", d, w}" /proc/vmstat'

# Terminal 3: watch I/O latency distribution
iostat -x 1 | awk '
  /Device/ {header=1; next}
  header && /nvme|sd/ {
    printf "%s: r_await=%.1fms w_await=%.1fms %%util=%.0f%%\n",
    $1, $6, $7, $16
  }'

# Terminal 4: watch for write stalls in kernel log
dmesg -w | grep -i "writeback\|flush\|blk_update_request"
```

### Prometheus Metrics for Dirty Page Monitoring

```yaml
# node-exporter already exposes dirty page metrics
# Add these Prometheus alerting rules:

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: dirty-page-writeback-alerts
  namespace: monitoring
spec:
  groups:
    - name: linux.writeback
      rules:
        - alert: DirtyPagesHighRatio
          expr: |
            node_memory_Dirty_bytes / node_memory_MemTotal_bytes > 0.15
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High dirty page ratio on {{ $labels.instance }}"
            description: "{{ $value | humanizePercentage }} of RAM is dirty on {{ $labels.instance }}. Potential write stall approaching."

        - alert: WritebackActive
          expr: |
            node_memory_Writeback_bytes > 1073741824
          for: 1m
          labels:
            severity: info
          annotations:
            summary: "Large writeback in progress on {{ $labels.instance }}"
            description: "{{ $value | humanize1024 }}B being written back to disk"

        - alert: DiskWriteLatencySpike
          expr: |
            rate(node_disk_write_time_seconds_total[1m])
            / rate(node_disk_writes_completed_total[1m]) > 0.050
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High write latency on {{ $labels.instance }}:{{ $labels.device }}"
            description: "Average write latency {{ $value | humanizeDuration }} on {{ $labels.device }}"
```

## Section 6: Write Amplification Analysis

Write amplification occurs when the kernel writes more data to disk than applications actually wrote. For databases, understanding write amplification from dirty page writeback is critical for SSD longevity and IOPS budgeting.

```bash
# Measure write amplification
# 1. Start with clean state
echo 3 > /proc/sys/vm/drop_caches

# 2. Record initial disk write bytes
DISK_WRITES_BEFORE=$(cat /sys/block/nvme0n1/stat | awk '{print $7}')
APP_WRITES_BEFORE=$(cat /proc/$(pgrep -o postgres)/io | grep write_bytes | awk '{print $2}')

# 3. Run workload for 60 seconds
# ... (run database load test here) ...
sleep 60

# 4. Measure final state
DISK_WRITES_AFTER=$(cat /sys/block/nvme0n1/stat | awk '{print $7}')
APP_WRITES_AFTER=$(cat /proc/$(pgrep -o postgres)/io | grep write_bytes | awk '{print $2}')

# 5. Calculate write amplification
python3 -c "
disk_writes = (${DISK_WRITES_AFTER} - ${DISK_WRITES_BEFORE}) * 512  # 512 bytes per sector
app_writes = ${APP_WRITES_AFTER} - ${APP_WRITES_BEFORE}
print(f'Application writes: {app_writes / 1024**2:.1f} MiB')
print(f'Disk writes:        {disk_writes / 1024**2:.1f} MiB')
print(f'Write amplification: {disk_writes / app_writes:.2f}x')
"
```

## Section 7: Kubernetes-Specific Considerations

When running databases in Kubernetes, dirty page settings apply to the node — not the container. This creates shared-state problems when multiple database pods run on the same node.

```yaml
# Kubernetes DaemonSet to apply database-optimized sysctl settings
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: database-node-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: database-node-tuner
  template:
    metadata:
      labels:
        app: database-node-tuner
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      nodeSelector:
        workload-type: database
      initContainers:
        - name: sysctl-tuner
          image: busybox:latest
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              # Dirty page tuning for database nodes
              sysctl -w vm.dirty_background_bytes=5368709120
              sysctl -w vm.dirty_bytes=26843545600
              sysctl -w vm.dirty_writeback_centisecs=100
              sysctl -w vm.dirty_expire_centisecs=1000
              sysctl -w vm.swappiness=1
              sysctl -w vm.zone_reclaim_mode=0
              # Disable transparent hugepages
              echo never > /sys/kernel/mm/transparent_hugepage/enabled
              echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
              echo "Node tuning applied successfully"
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            limits:
              cpu: "1m"
              memory: "4Mi"
```

### Using Pod-Level sysctl for Isolated Databases

For Kubernetes 1.27+, certain safe sysctls can be set per-pod. The dirty page parameters are NOT pod-level sysctls (they affect the entire node), but these are pod-safe:

```yaml
# StatefulSet for PostgreSQL with pod-level sysctl where supported
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: database
spec:
  serviceName: postgresql
  replicas: 1
  template:
    spec:
      securityContext:
        # These are the sysctls allowed per-pod (safe namespaced sysctls)
        sysctls:
          - name: net.core.somaxconn
            value: "1024"
          - name: net.ipv4.tcp_fin_timeout
            value: "30"
          # Note: vm.dirty_* are NOT namespaced - they affect the whole node
          # Must use node-level DaemonSet or node configuration for dirty page tuning
      containers:
        - name: postgresql
          image: postgres:16-alpine
          resources:
            requests:
              cpu: "4"
              memory: "32Gi"
            limits:
              cpu: "8"
              memory: "64Gi"
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-nvme
        resources:
          requests:
            storage: 2Ti
```

## Section 8: Production Tuning Reference

### Quick Reference by Workload Type

```bash
# ============================================================
# Small SSD (< 1 TiB, consumer NVMe ~500 MiB/s write)
# ============================================================
vm.dirty_background_bytes = 1073741824    # 1 GiB
vm.dirty_bytes = 4294967296              # 4 GiB
vm.dirty_writeback_centisecs = 200
vm.dirty_expire_centisecs = 1000

# ============================================================
# Enterprise NVMe (2-4 GiB/s write, typical database server)
# ============================================================
vm.dirty_background_bytes = 5368709120   # 5 GiB
vm.dirty_bytes = 26843545600             # 25 GiB
vm.dirty_writeback_centisecs = 100
vm.dirty_expire_centisecs = 1000

# ============================================================
# NVMe RAID / All-Flash Array (> 10 GiB/s write)
# ============================================================
vm.dirty_background_bytes = 10737418240  # 10 GiB
vm.dirty_bytes = 53687091200             # 50 GiB
vm.dirty_writeback_centisecs = 100
vm.dirty_expire_centisecs = 500

# ============================================================
# Spinning HDD (100-200 MiB/s write)
# ============================================================
vm.dirty_background_bytes = 268435456    # 256 MiB
vm.dirty_bytes = 1073741824              # 1 GiB
vm.dirty_writeback_centisecs = 500
vm.dirty_expire_centisecs = 3000
```

### Persistent Configuration

```bash
# Create database-node sysctl configuration
cat > /etc/sysctl.d/90-database-writeback.conf << 'SYSCTL'
# Database node dirty page writeback tuning
# Applied by: https://support.tools/linux-dirty-page-writeback-tuning-vm-dirty-ratio-databases/
# Last updated: 2029-09-01
# Storage: Enterprise NVMe (2.5 GiB/s sustained write)

vm.dirty_background_bytes = 5368709120
vm.dirty_bytes = 26843545600
vm.dirty_writeback_centisecs = 100
vm.dirty_expire_centisecs = 1000
vm.swappiness = 1
vm.zone_reclaim_mode = 0
SYSCTL

# Apply immediately
sysctl --system

# Verify settings took effect
sysctl vm.dirty_background_bytes vm.dirty_bytes vm.dirty_writeback_centisecs
```

## Conclusion

The default Linux dirty page writeback settings — 10% background, 20% process stall — were designed for desktop workloads where large RAM buffers improve interactive performance. For database servers with hundreds of GiB of RAM, these defaults allow tens of gigabytes of dirty data to accumulate before any flushing occurs, creating inevitable write stall events that manifest as latency spikes at p99 and above.

The fix is straightforward: use absolute byte values (`vm.dirty_bytes` and `vm.dirty_background_bytes`) calibrated to your storage system's throughput, combined with more frequent flusher thread wakeups (`vm.dirty_writeback_centisecs = 100`). For PostgreSQL, also configure checkpoint and bgwriter settings to spread I/O smoothly. For MySQL InnoDB with `innodb_flush_method = O_DIRECT`, the dirty page settings have minimal impact on data file writes since InnoDB bypasses the page cache entirely — but still affect WAL writes which use buffered I/O.

Always measure before and after: run a p99 write latency benchmark with fio using your actual workload's I/O pattern, apply the tuning, and measure again. The improvement in worst-case write latency is typically dramatic — often 10-100x reduction in p99.9 latency.
