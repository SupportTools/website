---
title: "Linux Memory Management: Page Cache, Buffer Cache, and Reclaim Pressure"
date: 2031-02-14T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "Performance", "Page Cache", "Kernel", "Database"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux memory management covering page cache architecture, dirty page writeback tuning, drop_caches usage, memory pressure and kswapd behavior, huge page reclaim, and interaction with database workloads."
more_link: "yes"
url: "/linux-memory-management-page-cache-reclaim-pressure/"
---

Linux memory management is a carefully tuned system where the kernel dynamically balances between serving applications and caching filesystem data. Understanding the page cache, dirty writeback, and memory reclaim pressure allows you to tune systems for optimal database, filesystem, and application performance without guesswork.

<!--more-->

# Linux Memory Management: Page Cache, Buffer Cache, and Reclaim Pressure

## Memory Zones and the Linux Memory Model

Linux divides physical memory into zones. On x86-64, the relevant zones are:

- **ZONE_DMA**: First 16 MB — legacy ISA DMA devices
- **ZONE_DMA32**: First 4 GB — devices with 32-bit DMA limitations
- **ZONE_NORMAL**: Remaining memory — all modern workloads operate here

All memory is measured in pages (4 KB on x86-64 by default). The kernel tracks page state and ownership through the `struct page` structure.

```bash
# View memory zone statistics
cat /proc/zoneinfo | grep -A5 "Node 0, zone  Normal"

# View memory usage summary
cat /proc/meminfo
# MemTotal:       32768000 kB  <- Total physical RAM
# MemFree:         1234567 kB  <- Completely unused pages
# MemAvailable:   15678901 kB  <- Available for applications (free + reclaimable cache)
# Buffers:          345678 kB  <- Buffer cache (block device metadata)
# Cached:         12345678 kB  <- Page cache (file content)
# SwapCached:            0 kB  <- Pages in swap that are also in RAM
# Active:          8765432 kB  <- Recently used pages (harder to reclaim)
# Inactive:        5432109 kB  <- Less recently used (candidates for reclaim)
# Dirty:            234567 kB  <- Modified pages not yet written to disk
# Writeback:           123 kB  <- Pages currently being written to disk
# AnonPages:       3456789 kB  <- Anonymous (heap, stack) pages
# Mapped:           987654 kB  <- Files mapped into process address space
# Shmem:            123456 kB  <- Shared memory (tmpfs, IPC)
# KReclaimable:     456789 kB  <- Kernel memory that can be reclaimed
# Slab:             789012 kB  <- Kernel slab allocator
```

## Section 1: Page Cache Architecture

### How the Page Cache Works

The page cache is a portion of physical memory the kernel uses to cache file data. Every `read()` or `write()` system call goes through the page cache:

1. **Read path**: Kernel checks if the page is in cache. Cache hit: copy data to userspace immediately. Cache miss: read from disk, populate cache, copy to userspace.

2. **Write path**: Data is written to the page cache immediately (the write() returns). The page is marked "dirty." The kernel's writeback system eventually flushes dirty pages to disk asynchronously.

```bash
# Monitor page cache hit rate in real-time with cachestat (bpftrace)
# Tool from BCC (bpf-tools collection)
sudo cachestat 1
# HITS   MISSES  DIRTIES  HITRATIO  BUFFERS_MB  CACHED_MB  RESID_MB
# 12345      23      456     99.81%         567      23456      1234
# 23456      12      234     99.95%         567      23456      1234

# Alternative: use pcstat to check cache status for specific files
# go install github.com/tobert/pcstat@latest
pcstat /var/log/syslog
# |-----------------+----------------+------------+-----------+---------|
# | Name            | Size           | Pages      | Cached    | Percent |
# |-----------------+----------------+------------+-----------+---------|
# | /var/log/syslog | 14627937       | 3570       | 3570      | 100.000 |
# |-----------------+----------------+------------+-----------+---------|

# Check global cache statistics
cat /proc/vmstat | grep -E "pgpg|pswp|cache"
# pgpgin 12345678      <- Pages read into cache from disk
# pgpgout 23456789     <- Pages written from cache to disk
# pswpin 0             <- Pages swapped in (bad if nonzero)
# pswpout 0            <- Pages swapped out (bad if nonzero)
```

### The LRU (Least Recently Used) Lists

The kernel maintains two LRU lists for each zone:
- **Active list**: Pages that have been accessed recently (harder to evict)
- **Inactive list**: Pages that have not been accessed recently (first candidates for eviction)

Pages move between lists as follows:
- New page: added to inactive list
- Page on inactive list accessed again: promoted to active list
- Active list grows too large: tail pages demoted to inactive list
- Memory pressure: inactive list pages are reclaimed (freed or swapped)

```bash
# View LRU list sizes
cat /proc/meminfo | grep -E "Active|Inactive"
# Active(anon):    2345678 kB  <- Anonymous pages recently used
# Inactive(anon):   234567 kB  <- Anonymous pages not recently used
# Active(file):    5678901 kB  <- File-backed pages recently used
# Inactive(file):  4567890 kB  <- File-backed pages not recently used

# The ratio of Active to Inactive(file) indicates whether cache thrashing is occurring
# If Inactive(file) is very small, cache is being heavily reclaimed
```

## Section 2: Dirty Page Writeback Tuning

### Understanding Dirty Page Parameters

When applications write data, the kernel accumulates dirty pages in memory before writing them to disk. The tunable parameters control how aggressively the kernel flushes dirty pages:

```bash
# View current writeback settings
sysctl vm.dirty_ratio vm.dirty_background_ratio vm.dirty_expire_centisecs vm.dirty_writeback_centisecs

# vm.dirty_background_ratio = 10
# Percentage of total memory at which background writeback starts.
# At 10%, if 10% of RAM contains dirty pages, flusher threads start writing.

# vm.dirty_ratio = 20
# Hard limit: percentage of total memory dirty pages may reach.
# At 20%, write() syscalls BLOCK until dirty pages are flushed below this threshold.
# This causes application-visible write stalls.

# vm.dirty_expire_centisecs = 3000
# Age (in centiseconds) at which dirty pages are considered "expired" and must be written.
# Default: 3000 centiseconds = 30 seconds.

# vm.dirty_writeback_centisecs = 500
# How often (in centiseconds) flusher threads wake up to write dirty pages.
# Default: 500 centiseconds = 5 seconds.
```

### Tuning for Different Workloads

```bash
# Configuration for write-heavy workloads (databases, logging systems)
# Goal: start writeback earlier to avoid write stalls

cat /etc/sysctl.d/99-writeback.conf
```

```ini
# Start background writeback at 5% dirty (more aggressive than default 10%)
vm.dirty_background_ratio = 5

# Hard limit at 15% (tighter than default 20% to prevent stalls)
vm.dirty_ratio = 15

# Expire dirty pages after 15 seconds instead of 30 (faster persistence)
vm.dirty_expire_centisecs = 1500

# Wake up flusher threads every 2 seconds instead of 5
vm.dirty_writeback_centisecs = 200
```

```bash
# Configuration for write-burst workloads (batch processing, imports)
# Goal: allow larger write accumulation for better write throughput

cat /etc/sysctl.d/99-writeback-burst.conf
```

```ini
# Allow more dirty pages to accumulate before background writeback
vm.dirty_background_ratio = 20

# Allow up to 40% dirty before stalling (for batch workloads)
vm.dirty_ratio = 40

# Pages expire after 60 seconds
vm.dirty_expire_centisecs = 6000

# Less frequent wakeup (reduces I/O system call overhead)
vm.dirty_writeback_centisecs = 1000
```

```bash
# Apply settings without reboot
sudo sysctl -p /etc/sysctl.d/99-writeback.conf

# Verify
sysctl vm.dirty_background_ratio vm.dirty_ratio
```

### Using Bytes Instead of Ratios (High-Memory Systems)

On systems with large amounts of RAM (256 GB+), percentage-based dirty limits lead to extremely large dirty page counts. Use absolute byte limits instead:

```bash
# On a 256 GB system with 10% dirty_background_ratio:
# 256 GB * 10% = 25.6 GB of dirty pages before background flush starts
# This is too much for most workloads

# Use bytes-based limits instead (mutually exclusive with ratio settings)
cat /etc/sysctl.d/99-writeback-bytes.conf
```

```ini
# Start background writeback when dirty pages exceed 4 GB
vm.dirty_background_bytes = 4294967296

# Hard limit at 8 GB
vm.dirty_bytes = 8589934592

# Note: setting dirty_bytes disables dirty_ratio (and vice versa)
# Setting dirty_background_bytes disables dirty_background_ratio
```

### Monitoring Writeback Activity

```bash
#!/bin/bash
# writeback-monitor.sh - Monitor dirty pages and writeback activity

while true; do
    dirty_kb=$(grep "^Dirty:" /proc/meminfo | awk '{print $2}')
    writeback_kb=$(grep "^Writeback:" /proc/meminfo | awk '{print $2}')
    total_kb=$(grep "^MemTotal:" /proc/meminfo | awk '{print $2}')

    dirty_pct=$(echo "scale=2; $dirty_kb * 100 / $total_kb" | bc)
    dirty_mb=$(echo "scale=1; $dirty_kb / 1024" | bc)
    writeback_mb=$(echo "scale=1; $writeback_kb / 1024" | bc)

    echo "$(date '+%H:%M:%S') Dirty: ${dirty_mb}MB (${dirty_pct}%), Writeback: ${writeback_mb}MB"

    # Check for write stall (dirty approaching dirty_ratio)
    dirty_ratio=$(sysctl -n vm.dirty_ratio)
    stall_threshold=$(echo "scale=0; $total_kb * $dirty_ratio / 100" | bc)
    if [ "$dirty_kb" -gt "$((stall_threshold * 80 / 100))" ]; then
        echo "WARNING: Dirty pages at 80%+ of dirty_ratio threshold — write stalls imminent"
    fi

    sleep 1
done
```

## Section 3: drop_caches — Usage and Implications

### When and How to Use drop_caches

`/proc/sys/vm/drop_caches` is a write-only interface for reclaiming cached memory. It is commonly used for benchmarking (to ensure test starts with empty cache) and for freeing memory in emergency situations.

```bash
# Drop page cache (free cached file data)
sync  # IMPORTANT: always sync before dropping caches to avoid data loss
echo 1 > /proc/sys/vm/drop_caches

# Drop dentries and inodes cache (filesystem metadata)
sync
echo 2 > /proc/sys/vm/drop_caches

# Drop both page cache AND dentries/inodes
sync
echo 3 > /proc/sys/vm/drop_caches

# Verify cache was dropped
free -h
# Before:               total   used    free  shared  buff/cache  available
#                       31Gi    8.2Gi   1.5Gi   512Mi   21.8Gi      21.1Gi
# After echo 3:
#                       31Gi    8.1Gi   22.2Gi  512Mi   0.7Gi       22.9Gi
```

### Important Caveats About drop_caches

```bash
# drop_caches does NOT drop dirty pages — sync first
# Without sync, you might cause data corruption if the system crashes
# while the cache is being rebuilt from a non-flushed state.

# Operational warning: dropping caches on a production system
# causes a "cold cache" effect where the next read operations
# all result in cache misses and go to disk.
# For a heavily cached database, this can cause a 10-100x increase
# in disk I/O for several minutes until the cache warms up.

# When to legitimately use drop_caches:
# 1. Benchmarking (cold start testing)
# 2. Memory pressure emergencies when other options are exhausted
# 3. After large temporary operations that polluted the cache

# When NOT to use drop_caches:
# 1. "To free memory" in production (the OS already does this automatically)
# 2. Thinking it will speed up the system (it will slow it down temporarily)
# 3. As part of regular maintenance (unnecessary and harmful)
```

## Section 4: kswapd and Memory Pressure

### The kswapd Kernel Thread

`kswapd` is the kernel swap daemon responsible for proactively freeing memory to maintain a reserve of free pages. It runs in the background and wakes up when free memory falls below a threshold.

```bash
# Find kswapd threads (one per NUMA node)
ps aux | grep kswapd
# root         74  0.0  0.0      0     0 ?  S    00:00   0:00 [kswapd0]
# root         75  0.0  0.0      0     0 ?  S    00:00   0:00 [kswapd1]  # (on NUMA systems)

# Monitor kswapd CPU usage — high CPU indicates memory pressure
top -p $(pgrep -d',' kswapd)

# Check watermarks that trigger kswapd
cat /proc/zoneinfo | grep -E "pages free|min|low|high"
# pages free     12345
# pages min       4567     <- kswapd wakes at this level
# pages low       6789     <- background reclaim threshold
# pages high      9012     <- kswapd stops reclaiming at this level
```

### Memory Pressure Levels

```
Free memory levels (from highest to lowest):

HIGH watermark    kswapd stops reclaiming (enough free memory)
LOW watermark     kswapd starts background reclaim (warning level)
MIN watermark     Direct reclaim by allocating process (severe pressure)
                  All allocations block until memory is freed
OOM threshold     OOM killer is invoked
```

```bash
# View actual watermark values in bytes
cat /proc/sys/vm/min_free_kbytes
# 67584    <- Default minimum free memory (64 MB)

# Increase the minimum free threshold on high-memory systems
# (reduces OOM risk by keeping more memory available)
echo 524288 > /proc/sys/vm/min_free_kbytes  # 512 MB minimum free

# The low and high watermarks are derived from min_free_kbytes:
# low  = min * 5/4
# high = min * 3/2
```

### Tuning Reclaim Behavior

```bash
# vm.swappiness controls the aggressiveness of swapping out anonymous pages
# versus reclaiming file cache pages.
# 0  = avoid swapping anonymous pages as long as possible
# 60 = default, balanced approach
# 100 = treat anonymous and file pages equally for reclaim

# For database servers (PostgreSQL, MySQL) that manage their own cache:
# Set swappiness low to prevent the database buffer pool from being swapped
echo 10 > /proc/sys/vm/swappiness

# For systems with no databases that rely on page cache:
# Keep default or increase swappiness
echo 60 > /proc/sys/vm/swappiness

# vm.vfs_cache_pressure controls reclaim of dentry/inode cache
# 50  = reclaim dentry/inode cache less aggressively than page cache
# 100 = default, balanced
# 200 = reclaim dentry/inode more aggressively

# For workloads with many small files:
echo 50 > /proc/sys/vm/vfs_cache_pressure

# For workloads that constantly access new files:
echo 200 > /proc/sys/vm/vfs_cache_pressure
```

## Section 5: Huge Page Reclaim

### Transparent Huge Pages

Linux supports 2 MB huge pages in addition to 4 KB standard pages. Transparent Huge Pages (THP) automatically promotes contiguous 4 KB pages to 2 MB huge pages.

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# "always" = THP enabled globally (default on most distributions)
# "madvise" = only for regions marked with MADV_HUGEPAGE
# "never" = THP completely disabled

# Check THP defragmentation mode
cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# Check current THP usage
grep -E "AnonHugePages|HugePages" /proc/meminfo
# AnonHugePages:   2048000 kB   <- Memory in 2MB THP pages
# HugePages_Total:        0     <- Explicit huge pages reserved
# HugePages_Free:         0
# HugePages_Rsvd:         0
# HugePages_Surp:         0
# Hugepagesize:        2048 kB

# Monitor THP operations
cat /proc/vmstat | grep thp
# thp_fault_alloc 12345          <- THP pages allocated for faults
# thp_fault_fallback 234         <- Fell back to 4KB (couldn't get huge page)
# thp_collapse_alloc 456         <- Pages collapsed from 4KB to 2MB
# thp_collapse_alloc_failed 12   <- Collapse failed
# thp_split_page 789             <- Pages split from 2MB back to 4KB (for reclaim)
# thp_zero_page_alloc 345
```

### THP and Memory Reclaim Interaction

```bash
# When memory pressure occurs, the kernel must split 2MB pages back to 4KB
# before reclaiming them. This splitting has overhead.

# For latency-sensitive applications (databases, real-time processing):
# Disable THP to avoid unpredictable splitting latency spikes
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Make this permanent
cat /etc/systemd/system/disable-thp.service
```

```ini
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=mongod.service mysql.service postgresql.service redis.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c "echo never > /sys/kernel/mm/transparent_hugepage/enabled"
ExecStart=/bin/bash -c "echo never > /sys/kernel/mm/transparent_hugepage/defrag"

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable disable-thp
sudo systemctl start disable-thp
```

### Explicit Huge Pages for Databases

```bash
# Reserve huge pages at boot time (for databases that use them explicitly)
# Each page is 2 MB; reserve 4096 pages = 8 GB

# Option 1: /etc/sysctl.conf
vm.nr_hugepages = 4096

# Option 2: /etc/default/grub kernel parameters
# GRUB_CMDLINE_LINUX="hugepages=4096"

# Option 3: runtime (subject to fragmentation if system has been running)
echo 4096 > /proc/sys/vm/nr_hugepages

# Verify allocation
grep HugePages /proc/meminfo
# HugePages_Total:    4096
# HugePages_Free:     4096   <- All available (database hasn't started yet)
# HugePages_Rsvd:        0
# HugePages_Surp:        0

# For PostgreSQL: enable huge page usage
# In postgresql.conf:
# huge_pages = on   (or try, to fall back gracefully if unavailable)

# For MySQL InnoDB: uses huge pages automatically when available
# innodb_buffer_pool_size must be set to benefit from huge pages
```

## Section 6: Database Memory Management Interaction

### PostgreSQL Shared Buffers and Page Cache

PostgreSQL uses shared_buffers as its buffer pool and relies on the OS page cache as a second-level cache:

```bash
# PostgreSQL memory configuration recommendations
cat /etc/postgresql/15/main/postgresql.conf
```

```ini
# shared_buffers: PostgreSQL's private cache
# Recommended: 25% of total RAM
shared_buffers = 8GB          # On a 32 GB system

# effective_cache_size: Hint to the query planner about total available cache
# Set to 75% of RAM (shared_buffers + estimated OS page cache)
effective_cache_size = 24GB

# For systems where PostgreSQL is the only major workload:
# Disable the OS cache double-buffering effect
# by using Direct I/O (PostgreSQL uses checksum verification instead)
# This requires a filesystem that supports O_DIRECT

# wal_buffers: Write-ahead log buffer
wal_buffers = 64MB

# checkpoint_completion_target: Spread checkpoint I/O over this fraction of checkpoint interval
# Higher value = less I/O spike but more constant I/O
checkpoint_completion_target = 0.9

# checkpoint_timeout: Maximum time between checkpoints
# Longer = less frequent checkpoints but slower crash recovery
checkpoint_timeout = 15min
```

```bash
# Monitor PostgreSQL buffer hit rate
psql -c "SELECT
    sum(heap_blks_hit) as heap_hit,
    sum(heap_blks_read) as heap_read,
    round(100.0 * sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) as hit_rate
FROM pg_statio_user_tables;"
# heap_hit | heap_read | hit_rate
# ---------+-----------+---------
# 12345678 |     23456 |    99.81
```

### Redis Memory Management

Redis stores all data in memory and has its own eviction policies that interact with the OS memory manager:

```bash
# Redis memory configuration
redis-cli CONFIG GET maxmemory
redis-cli CONFIG GET maxmemory-policy

# Key Redis memory settings
cat /etc/redis/redis.conf
```

```ini
# Maximum memory Redis can use
maxmemory 4gb

# Eviction policy when maxmemory is reached
# allkeys-lru: evict any key using LRU (good for cache-only usage)
# volatile-lru: evict only keys with TTL set
# allkeys-lfu: evict by least-frequently-used
maxmemory-policy allkeys-lru

# Number of keys to sample for LRU eviction (higher = more accurate but slower)
maxmemory-samples 10

# Memory overcommit — Redis requires this to avoid fork() failures
# Set vm.overcommit_memory = 1 in sysctl.conf
```

```bash
# Required kernel setting for Redis (avoids background save failures)
echo "vm.overcommit_memory = 1" >> /etc/sysctl.conf
sysctl -p

# Disable swap for Redis containers (data in swap = severe latency)
# This is done at the cgroup level for containers
```

### Memory Pressure and OOM Killer

```bash
# The OOM (Out of Memory) killer is invoked when all reclaim attempts fail
# Configure OOM score to protect critical processes

# Protect a critical process from OOM killing (-1000 = never kill, 1000 = always kill first)
echo -1000 > /proc/$(pgrep postgres)/oom_score_adj

# Set OOM score via systemd service
cat /etc/systemd/system/postgresql.service.d/oom-protect.conf
```

```ini
[Service]
OOMScoreAdjust=-1000
```

```bash
# Monitor OOM events
dmesg | grep -i "out of memory"
journalctl -k | grep "Out of memory"

# See recent OOM kills
cat /var/log/kern.log | grep -i "killed process"

# Prevent OOM from killing any process by enabling overcommit
# (dangerous — can deadlock the system if actual OOM occurs)
# echo 2 > /proc/sys/vm/overcommit_memory
# echo 80 > /proc/sys/vm/overcommit_ratio  # Allow up to 80% overcommit
```

## Section 7: Memory Pressure Monitoring

### Real-Time Memory Pressure Tools

```bash
#!/bin/bash
# memory-pressure-monitor.sh - Comprehensive memory pressure monitor

echo "=== Memory Pressure Monitor ==="
echo "Press Ctrl+C to stop"
echo ""

while true; do
    # Read meminfo
    mem_total=$(grep "^MemTotal:" /proc/meminfo | awk '{print $2}')
    mem_free=$(grep "^MemFree:" /proc/meminfo | awk '{print $2}')
    mem_available=$(grep "^MemAvailable:" /proc/meminfo | awk '{print $2}')
    mem_cached=$(grep "^Cached:" /proc/meminfo | awk '{print $2}')
    dirty=$(grep "^Dirty:" /proc/meminfo | awk '{print $2}')
    writeback=$(grep "^Writeback:" /proc/meminfo | awk '{print $2}')
    swap_used=$(grep "^SwapFree:" /proc/meminfo | awk '{print $2}')

    # Calculate percentages
    free_pct=$(( mem_free * 100 / mem_total ))
    avail_pct=$(( mem_available * 100 / mem_total ))
    cached_mb=$(( mem_cached / 1024 ))
    dirty_mb=$(( dirty / 1024 ))
    dirty_ratio=$(sysctl -n vm.dirty_ratio)
    dirty_bg_ratio=$(sysctl -n vm.dirty_background_ratio)
    dirty_threshold=$(( mem_total * dirty_ratio / 100 ))
    dirty_bg_threshold=$(( mem_total * dirty_bg_ratio / 100 ))

    # kswapd activity
    kswapd_cpu=$(ps -p $(pgrep kswapd | head -1) -o %cpu --no-headers 2>/dev/null | tr -d ' ')

    # PSI (Pressure Stall Information) if available
    if [ -f /proc/pressure/memory ]; then
        mem_psi_some=$(grep "some" /proc/pressure/memory | awk -F'=' '{print $2}' | awk '{print $1}')
        mem_psi_full=$(grep "full" /proc/pressure/memory | awk -F'=' '{print $2}' | awk '{print $1}')
        psi_info="PSI some=${mem_psi_some}% full=${mem_psi_full}%"
    else
        psi_info="PSI: not available"
    fi

    # Status line
    timestamp=$(date '+%H:%M:%S')
    echo "${timestamp} | Avail: ${avail_pct}% | Cached: ${cached_mb}MB | Dirty: ${dirty_mb}MB/${dirty_threshold}KB | kswapd: ${kswapd_cpu}% | ${psi_info}"

    # Warnings
    if [ "$avail_pct" -lt 10 ]; then
        echo "  WARNING: Available memory below 10% — consider adding memory or reducing workload"
    fi
    if [ "$dirty" -gt "$dirty_bg_threshold" ]; then
        echo "  INFO: Dirty pages above background threshold — flush in progress"
    fi
    if [ "$dirty" -gt "$((dirty_threshold * 80 / 100))" ]; then
        echo "  WARNING: Dirty pages approaching hard limit — write stalls possible"
    fi
    if [ -n "$kswapd_cpu" ] && [ "$(echo "$kswapd_cpu > 5" | bc)" = "1" ]; then
        echo "  WARNING: kswapd consuming ${kswapd_cpu}% CPU — significant memory pressure"
    fi

    sleep 2
done
```

### PSI (Pressure Stall Information)

Linux 4.20+ provides PSI metrics that measure the fraction of time processes spent stalled waiting for memory:

```bash
# Check if PSI is enabled
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.01 avg300=0.00 total=12345
# full avg10=0.00 avg60=0.00 avg300=0.00 total=5678

# "some" = at least one task was stalled
# "full" = all tasks were stalled (more severe)
# avg10/avg60/avg300 = exponential moving average over 10s/60s/300s

# Prometheus metrics for PSI (requires node_exporter 1.3+)
# node_pressure_memory_waiting_seconds_total
# node_pressure_memory_stalled_seconds_total

# Set up an alert: trigger if 10-second average exceeds 5%
# (5% of time stalled on memory = significant pressure)
```

```yaml
# PrometheusRule for memory pressure alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: memory-pressure-alerts
  namespace: monitoring
spec:
  groups:
    - name: memory
      rules:
        - alert: MemoryPressureHigh
          expr: |
            node_pressure_memory_waiting_seconds_total{} > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Memory pressure detected on {{ $labels.instance }}"
            description: "Memory pressure stall ratio exceeds 5% on {{ $labels.instance }}"

        - alert: MemoryPressureCritical
          expr: |
            node_pressure_memory_stalled_seconds_total{} > 0.1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Critical memory pressure on {{ $labels.instance }}"
            description: "Memory full stall ratio exceeds 10% on {{ $labels.instance }}"
```

## Section 8: Memory Cgroup Integration

### Controlling Page Cache with cgroups v2

Kubernetes uses cgroups v2 to limit container memory, including the page cache:

```bash
# Check cgroup v2 memory limits for a container
CGROUP_PATH=$(cat /proc/$(docker inspect --format '{{.State.Pid}}' mycontainer)/cgroup | grep "^0::" | cut -d: -f3)
cat /sys/fs/cgroup${CGROUP_PATH}/memory.current
# 2147483648  (2 GB current usage)

cat /sys/fs/cgroup${CGROUP_PATH}/memory.max
# 4294967296  (4 GB limit)

# Memory breakdown within the cgroup
cat /sys/fs/cgroup${CGROUP_PATH}/memory.stat | head -20
# anon 1073741824          <- Anonymous memory (heap, stack)
# file 1073741824          <- File cache (page cache)
# kernel 12345678          <- Kernel memory
# pgfault 12345678         <- Total page faults
# pgmajfault 123           <- Major page faults (disk I/O required)
# pgrefill 456789          <- Pages scanned for reclaim
# pgscan 234567            <- Pages scanned during reclaim
# pgsteal 123456           <- Pages reclaimed
# pgactivate 789012        <- Pages moved to active list
```

```yaml
# Kubernetes Pod resource limits with memory pressure behavior
apiVersion: v1
kind: Pod
metadata:
  name: memory-managed-pod
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          memory: "1Gi"    # Soft request — scheduler uses this for placement
        limits:
          memory: "2Gi"    # Hard limit — OOM kill if exceeded
      # Memory QoS class:
      # Guaranteed: requests == limits (best for latency-sensitive apps)
      # Burstable: requests < limits
      # BestEffort: no limits set (evicted first under pressure)
```

## Conclusion

Linux memory management is a sophisticated system where the kernel continuously balances competing demands for memory between applications, the page cache, and kernel structures. The key operational insights are: dirty page ratios should be configured for your write patterns (lower ratios for low-latency, higher for throughput), THP should be disabled for latency-sensitive databases, kswapd CPU consumption is the most reliable early warning of memory pressure, and PSI metrics provide precise measurement of how much applications are actually stalling on memory operations. Understanding these mechanisms allows you to tune production systems confidently rather than applying cargo-cult configurations.
