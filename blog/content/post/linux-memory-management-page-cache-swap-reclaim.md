---
title: "Linux Memory Management: Page Cache, Swap, and Reclaim"
date: 2029-04-24T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "Performance", "Kernel", "Page Cache", "Swap", "Tuning"]
categories: ["Linux", "Performance", "Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux memory management for production systems: page cache eviction, LRU lists, swappiness tuning, kswapd reclaim behavior, transparent hugepages, memory compaction, and PSI (Pressure Stall Information) for modern workload monitoring."
more_link: "yes"
url: "/linux-memory-management-page-cache-swap-reclaim/"
---

Linux memory management is a complex, adaptive system designed to maximize utilization while maintaining responsiveness. For production servers running databases, container workloads, and high-throughput services, understanding how the kernel manages memory — and knowing which knobs to turn — is essential for preventing latency spikes, OOM kills, and swap storms. This guide covers the full lifecycle: page cache behavior, LRU aging, reclaim heuristics, swap configuration, transparent hugepages, memory compaction, and the modern PSI framework for detecting memory pressure.

<!--more-->

# Linux Memory Management: Page Cache, Swap, and Reclaim

## Section 1: Memory Architecture Overview

### How Linux Uses Physical Memory

Linux divides physical memory into pages (4KB by default). Each page falls into one of these categories:

```
Physical Memory
├── Kernel memory
│   ├── Kernel code + data (non-reclaimable)
│   ├── kmalloc/vmalloc allocations
│   └── Kernel stacks, page tables
├── User memory (mapped by processes)
│   ├── Anonymous pages (stack, heap — no file backing)
│   └── File-backed pages (mmap'd files, executables)
├── Page cache (file data cached in memory)
│   ├── Active LRU (recently accessed)
│   └── Inactive LRU (candidates for eviction)
├── Slab cache (kernel object caches — dentry, inode, etc.)
└── Free pages
```

### Viewing Memory State

```bash
# Comprehensive memory breakdown
cat /proc/meminfo

# Key fields:
# MemTotal:     Total physical RAM
# MemFree:      Truly unused pages
# MemAvailable: Estimate of available memory for applications
#               (includes reclaimable cache)
# Buffers:      Raw block device cache
# Cached:       Page cache (file data)
# SwapCached:   Swap data also in RAM
# Active:       Recently used, harder to reclaim
# Inactive:     Less recently used, easier to reclaim
# Active(anon):  Active anonymous pages (heap/stack)
# Inactive(anon): Inactive anonymous pages (swap candidates)
# Active(file):  Active file cache
# Inactive(file): Inactive file cache (eviction candidates)
# Dirty:        Pages modified but not yet written to disk
# Writeback:    Pages currently being written to disk
# AnonPages:    Total unmapped anonymous pages
# Mapped:       Pages mapped into process address spaces
# Shmem:        Shared memory pages
# Slab:         In-kernel data structures cache
# SReclaimable: Reclaimable slab (can be freed under pressure)
# SUnreclaim:   Unreclaimable slab

# Quick view
free -h

# Per-process memory usage
ps aux --sort=-%mem | head -20

# smaps for detailed per-mapping breakdown
cat /proc/$(pgrep nginx | head -1)/smaps | head -60
```

## Section 2: The Page Cache

### What the Page Cache Does

When an application reads a file, the kernel copies the data from disk into a page cache entry. Subsequent reads of the same data are served from memory, bypassing disk I/O entirely. When the application writes, data goes to the page cache first (marked dirty) and is asynchronously flushed to disk by the writeback daemon.

```bash
# Clear page cache (production: only for testing)
# WARNING: This causes subsequent disk reads — do not do this on production
echo 1 > /proc/sys/vm/drop_caches  # Drop page cache only
echo 2 > /proc/sys/vm/drop_caches  # Drop slab cache
echo 3 > /proc/sys/vm/drop_caches  # Drop both

# Observe page cache effect on file read performance
time cat /dev/zero | head -c 1G > /tmp/testfile   # First read: cold cache
time cat /tmp/testfile > /dev/null                 # Second read: warm cache
# First: ~3s (disk limited)
# Second: ~0.3s (page cache limited)
```

### Page Cache Writeback Tuning

```bash
# /proc/sys/vm/ parameters for writeback behavior

# Percentage of total memory at which writeback begins (default: 10)
cat /proc/sys/vm/dirty_background_ratio
# 10 → start flushing when dirty pages exceed 10% of RAM

# Absolute threshold (takes precedence over ratio if non-zero)
cat /proc/sys/vm/dirty_background_bytes
# 0 → not set (use ratio)

# Percentage of total memory at which processes are throttled (default: 20)
cat /proc/sys/vm/dirty_ratio
# 20 → throttle writes when dirty pages exceed 20% of RAM

# Absolute threshold (takes precedence over ratio if non-zero)
cat /proc/sys/vm/dirty_bytes
# 0 → not set (use ratio)

# How long a dirty page can remain before forced writeback (default: 1500 = 15s)
cat /proc/sys/vm/dirty_expire_centisecs

# Interval between writeback daemon wakeups (default: 500 = 5s)
cat /proc/sys/vm/dirty_writeback_centisecs
```

**Production tuning for database servers** (reduce dirty write latency):

```bash
# /etc/sysctl.d/60-memory.conf
# For databases: minimize dirty write accumulation to avoid write bursts

# Use absolute values to avoid RAM-size-dependent thresholds
vm.dirty_background_bytes = 67108864   # 64MB: start background writeback early
vm.dirty_bytes = 134217728             # 128MB: max dirty pages before throttling
vm.dirty_expire_centisecs = 500        # 5s: write back older dirty pages sooner
vm.dirty_writeback_centisecs = 100     # 1s: check for dirty pages more frequently

# Apply without reboot
sysctl -p /etc/sysctl.d/60-memory.conf
```

**Production tuning for high-throughput write workloads** (maximize write throughput):

```bash
# Logging servers, data ingestion pipelines
vm.dirty_background_ratio = 5          # Start background flush at 5% of RAM
vm.dirty_ratio = 15                    # Throttle at 15% of RAM
vm.dirty_expire_centisecs = 3000       # Allow 30s before forced writeback
vm.dirty_writeback_centisecs = 500     # Check every 5s
```

## Section 3: LRU Lists and Page Reclaim

### The Two-List LRU Algorithm

Linux maintains four LRU lists for page reclaim:

```
Active Anonymous LRU    ← Recently accessed heap/stack pages
      |
      | (age out on inactivity)
      v
Inactive Anonymous LRU  ← Candidates for swap
      |
      | (write to swap if swappiness > 0)
      v
Swap space on disk

Active File LRU         ← Recently accessed file cache
      |
      | (age out on inactivity)
      v
Inactive File LRU       ← Candidates for eviction
      |
      | (discard if clean, write to disk if dirty)
      v
Page freed
```

The second-chance algorithm prevents thrashing: a page in the inactive list that is accessed again gets promoted back to the active list before reclaim can evict it.

```bash
# View LRU list sizes
grep -E "^(Active|Inactive)" /proc/meminfo

# Active(anon):    2,048,000 kB  ← Recently used heap/stack
# Active(file):    5,120,000 kB  ← Recently accessed files
# Inactive(anon):  1,024,000 kB  ← Swap candidates
# Inactive(file):  4,096,000 kB  ← Eviction candidates
```

### Scanning and Reclaim

When free memory falls below `vm.min_free_kbytes`, the kernel wakes kswapd to reclaim pages. kswapd scans the inactive LRU lists and evicts pages:

```bash
# Zone watermarks that trigger reclaim
cat /proc/zoneinfo | grep -A 6 "Node 0, zone   Normal"
# pages free     1024
# pages min      3276   ← Direct reclaim kicks in (OOM risk if hit)
# pages low      4095   ← kswapd wakes up
# pages high     4914   ← kswapd stops
# pages spanned  2621440

# Set minimum free kilobytes (default: auto-computed from RAM)
cat /proc/sys/vm/min_free_kbytes
# For servers with >8GB RAM, increase to 1GB for smoother reclaim
echo 1048576 > /proc/sys/vm/min_free_kbytes
# In sysctl.conf:
# vm.min_free_kbytes = 1048576
```

### Reclaim Scanning Rate

```bash
# vmscan statistics (reclaim activity)
cat /proc/vmstat | grep -E "pgsteal|pgscan|pgactivate|pgdeactivate|pgrefill"

# pgsteal_kswapd_normal: pages reclaimed by kswapd
# pgsteal_direct_normal: pages reclaimed by direct reclaim (application blocked!)
# pgscan_kswapd_normal: pages scanned by kswapd
# pgscan_direct_normal: pages scanned by direct reclaim

# If pgsteal_direct is high, applications are experiencing reclaim latency
# This manifests as periodic latency spikes in database or service metrics
```

### Detecting Reclaim Pressure

```bash
# Watch reclaim activity in real time
watch -n 1 'cat /proc/vmstat | grep -E "pgsteal|pgscan" | \
  awk "{sum+=$2} END{print sum}" '

# Using perf to profile reclaim
perf stat -e 'kmem:mm_vmscan_*' sleep 10

# sar for historical memory and swap data
sar -r 1 60 | tail -20  # Last 60 samples
```

## Section 4: Swappiness

The `vm.swappiness` parameter (0-200 in modern kernels, 0-100 in older) controls the kernel's preference for swapping anonymous pages versus evicting file cache.

### How swappiness Works

```
swappiness = 100 → Treat anonymous and file pages equally for reclaim
swappiness = 60  → Default: slight preference for file cache eviction
swappiness = 0   → Never swap anonymous pages unless absolutely necessary
swappiness = 200 → Aggressively swap to keep file cache (unusual)
```

The formula determines the relative scanning pressure:

```
anon_prio = swappiness
file_prio = 200 - swappiness  (kernel 5.9+; previously 200 - swappiness)

# Higher priority → more scanning → more reclaim from that pool
```

### swappiness Recommendations by Workload

| Workload | Recommended swappiness | Reason |
|---|---|---|
| Database server (PostgreSQL, MySQL) | 0-10 | DB manages its own buffer pool; swapping kills performance |
| Web application server | 10-30 | Allow some swap for occasional memory spikes |
| General-purpose server | 40-60 | Balanced — default is often fine |
| Desktop/interactive | 10-20 | Avoid latency from swap |
| Container host (cgroup v2) | 60 host, per-cgroup | Configure per workload |
| Memory-mapped file workloads | 1-10 | File pages in RAM preferred |

```bash
# Set swappiness
echo 10 > /proc/sys/vm/swappiness
# Persistent:
# vm.swappiness = 10

# Per-cgroup swappiness (cgroup v2)
echo 10 > /sys/fs/cgroup/mycontainer/memory.swappiness
```

## Section 5: Swap Configuration

### Swap Device vs Swap File

```bash
# Create a swap file (modern Linux supports this with good performance)
fallocate -l 16G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Verify
swapon --show

# Add to /etc/fstab for persistence
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Check swap usage
cat /proc/swaps
free -h
vmstat -s | grep -i swap
```

### ZRAM: Compressed RAM as Swap

ZRAM creates a compressed ramdisk as swap. Compressed anonymous pages go to ZRAM first (much faster than disk swap):

```bash
# Load zram module
modprobe zram

# Create a 4GB compressed swap device
echo 4G > /sys/block/zram0/disksize

# Create zram swap
mkswap /dev/zram0

# Enable with high priority (used before disk swap)
swapon -p 100 /dev/zram0

# Check compression ratio
cat /sys/block/zram0/mm_stat
# orig_data_size  compr_data_size  mem_used_total  ...
# 2147483648      715232512        ...
# 2GB of data compressed to 715MB — 3:1 ratio
```

**Persistent ZRAM configuration (systemd):**

```bash
# /etc/systemd/zram-generator.conf
[zram0]
zram-size = min(ram / 2, 4096)  # Half of RAM, max 4GB
compression-algorithm = lz4     # Fast, good compression
swap-priority = 100
```

### Swap Priority Tuning

```bash
# Multiple swap devices with different priorities
swapon -p 100 /dev/zram0   # ZRAM first (priority 100)
swapon -p 10 /swapfile     # SSD file second (priority 10)
swapon -p 1 /dev/sdb1      # HDD last resort (priority 1)

# Equal priority → striped (parallel) usage
swapon -p 5 /dev/sdb1
swapon -p 5 /dev/sdc1      # Striped for throughput
```

## Section 6: Transparent Hugepages

Transparent Hugepages (THP) allows the kernel to automatically back memory with 2MB pages instead of 4KB pages, reducing TLB pressure for large working sets.

### THP Configuration

```bash
# Check current THP setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# always  = THP for all eligible mappings
# madvise = THP only for mappings explicitly requesting it (MADV_HUGEPAGE)
# never   = THP disabled

# Defrag setting (when should kernel try to create hugepages)
cat /sys/kernel/mm/transparent_hugepage/defrag
# always defer defer+madvise [madvise] never
```

### THP for Different Workloads

```bash
# Workloads that BENEFIT from THP:
# - JVM applications (large heap)
# - In-memory databases (Redis, Memcached)
# - Scientific computing, ML training

# Workloads that SUFFER from THP:
# - Many small allocations (fragmented heap — THP compaction causes latency)
# - Real-time / low-latency services

# Redis recommendation: disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# JVM recommendation: use madvise (application controls THP use)
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
# JVM then calls madvise(MADV_HUGEPAGE) on its heap

# Persistent via /etc/rc.local or systemd service
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Hugepages
After=sysinit.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now disable-thp.service
```

### THP Monitoring

```bash
# THP statistics
grep -i huge /proc/meminfo

# AnonHugePages:   491520 kB  ← Active huge pages in use
# ShmemHugePages:      0 kB
# FileHugePages:       0 kB
# HugePages_Total:     0      ← Static hugepages (HugeTLBfs)
# HugePages_Free:      0
# HugePages_Rsvd:      0
# HugePages_Surp:      0
# Hugepagesize:     2048 kB

# THP compaction activity
grep -E "thp_" /proc/vmstat

# thp_fault_alloc       — hugepages allocated at fault time
# thp_collapse_alloc    — pages collapsed into hugepage
# thp_split_page        — hugepage split into 4KB pages (fragmentation)
# thp_deferred_split_page — lazy split (kernel 4.16+)
```

## Section 7: Memory Compaction

Memory compaction migrates pages to create contiguous regions, enabling hugepage allocation and reducing fragmentation.

### Compaction Trigger and Configuration

```bash
# Compaction statistics
grep -E "compact_" /proc/vmstat

# compact_success: successful compaction operations
# compact_fail: failed attempts (pages couldn't be moved)
# compact_stall: processes blocked waiting for compaction

# Manual compaction trigger (for testing)
echo 1 > /proc/sys/vm/compact_memory

# Proactive compaction (kernel 5.9+)
# 0=disabled, 20=moderate, 100=aggressive
cat /proc/sys/vm/compaction_proactiveness
echo 20 > /proc/sys/vm/compaction_proactiveness
```

### Fragmentation Index

```bash
# View fragmentation per memory zone
cat /proc/buddyinfo
# Node 0, zone   Normal 4 2 3 5 2 3 4 2 1 0 2
# Numbers are free pages in each order (4KB, 8KB, ..., 4MB)
# Low numbers in high orders indicate fragmentation

# Extfrag tracepoint for detailed fragmentation data
trace-cmd record -e mm:mm_compaction_* sleep 5
trace-cmd report
```

## Section 8: PSI (Pressure Stall Information)

PSI provides quantitative metrics for CPU, memory, and I/O pressure — enabling precise alerting on resource contention.

### Reading PSI Metrics

```bash
# Memory pressure
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# IO pressure
cat /proc/pressure/io
# some avg10=1.23 avg60=0.45 avg300=0.12 total=123456789

# CPU pressure
cat /proc/pressure/cpu
# some avg10=5.67 avg60=2.34 avg300=1.12 total=987654321

# Field meanings:
# some: at least one task was stalled (partial stall)
# full: ALL tasks were stalled (complete stall — most severe)
# avg10/avg60/avg300: 10s/60s/5min exponential moving average (percent)
# total: cumulative microseconds of stall time
```

### PSI Thresholds and Alerting

PSI can be used directly as a trigger via cgroup PSI interface:

```bash
# Monitor PSI with cgroup notifications (kernel 5.4+)
# Write trigger: fire when "some" memory stall exceeds 5% for 500ms windows
echo "some 5000 500000" > /sys/fs/cgroup/myapp/memory.pressure

# Read the notification fd and respond (e.g., shed load)
```

### Prometheus PSI Exporter

```yaml
# Prometheus PSI metrics via node_exporter
# node_pressure_memory_stalled_seconds_total{type="some"}
# node_pressure_memory_stalled_seconds_total{type="full"}

# Alert when memory pressure average exceeds 10% for 5 minutes
- alert: MemoryPressureHigh
  expr: |
    rate(node_pressure_memory_stalled_seconds_total{type="full"}[5m]) * 100 > 5
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "High memory pressure on {{ $labels.instance }}"
    description: "Memory full-stall pressure is {{ $value }}%"
```

### PSI-based Memory Reclaim (Kernel 5.4+)

```bash
# Enable PSI-based reclaim via cgroup
# This allows the cgroup to reclaim memory based on PSI signals
# rather than hard OOM kills

# Set memory.high slightly below memory.max to trigger early reclaim
echo $((4 * 1024 * 1024 * 1024)) > /sys/fs/cgroup/myapp/memory.high   # 4GB
echo $((6 * 1024 * 1024 * 1024)) > /sys/fs/cgroup/myapp/memory.max    # 6GB OOM kill
```

## Section 9: OOM Killer Behavior

When the system runs completely out of memory (no free pages, no reclaimable cache, no swap), the OOM killer selects a victim process to kill.

### OOM Score Adjustment

```bash
# Each process has an OOM score (0-1000)
cat /proc/$(pgrep postgres)/oom_score      # Current score
cat /proc/$(pgrep postgres)/oom_score_adj  # Adjustment (-1000 to 1000)

# Protect a critical process from OOM kill
echo -1000 > /proc/$(pgrep postgres)/oom_score_adj  # Exempt from OOM
echo -999  > /proc/$(pgrep mysql)/oom_score_adj     # Very low priority for kill

# Make a process a preferred OOM victim (CI jobs, batch processing)
echo 1000 > /proc/$(pgrep ci-runner)/oom_score_adj

# Persistent: set in systemd unit
[Service]
OOMScoreAdjust=-500
```

### OOM Logging

```bash
# View OOM kill events
dmesg | grep -i "oom\|out of memory\|killed process"

# Example OOM message:
# [1234567.890] Out of memory: Kill process 12345 (postgres) score 800
# or
# [1234567.890] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),
#               cpuset=/,mems_allowed=0,global_oom,task_memcg=/,
#               task=java,pid=1234,uid=1000

# Monitor OOM kills via kernel tracing
bpftrace -e 'tracepoint:oom:mark_victim { printf("OOM kill: pid=%d comm=%s\n", args->pid, comm); }'
```

### Kubernetes OOM Interaction

```yaml
# In Kubernetes, container memory limits trigger cgroup OOM (not system OOM)
# The container is killed and restarted (CrashLoopBackOff)
resources:
  limits:
    memory: "2Gi"  # cgroup will OOM kill at 2GB

# To prevent OOM kills: set Guaranteed QoS class
resources:
  requests:
    memory: "2Gi"  # Request == Limit = Guaranteed
  limits:
    memory: "2Gi"
```

## Section 10: NUMA and Memory Locality

### Checking NUMA Topology

```bash
# Check NUMA node layout
numactl --hardware

# Available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11
# node 0 size: 32276 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23
# node 1 size: 32256 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
# Local access: 10 (relative cost)
# Remote access: 21 (2.1x slower than local)

# NUMA statistics for a process
numastat -p $(pgrep postgres)
# Per-NUMA-node memory allocation breakdown
```

### NUMA Memory Policy

```bash
# Run process bound to NUMA node 0
numactl --cpunodebind=0 --membind=0 postgres

# Interleaved allocation (better for bandwidth-heavy apps)
numactl --interleave=all postgres

# Kubernetes: topology manager for NUMA-aware scheduling
# Feature gate: TopologyManager must be enabled
```

## Section 11: Memory Profiling Tools

### Valgrind / Massif

```bash
# Profile heap memory over time
valgrind --tool=massif --pages-as-heap=yes ./myapp

# Visualize
ms_print massif.out.12345 | head -50

# Or use massif-visualizer GUI
```

### heaptrack (Linux)

```bash
# Record memory allocations
heaptrack ./myapp

# Analyze
heaptrack_print heaptrack.myapp.12345.gz | head -100
```

### eBPF Memory Tracing

```bash
# Trace large allocations
bpftrace -e '
tracepoint:kmem:kmalloc /args->bytes_alloc > 1024*1024/ {
    printf("kmalloc: %d bytes by %s[%d]\n",
        args->bytes_alloc, comm, pid);
    @[kstack] = count();
}
interval:s:10 { exit(); }'

# Monitor page faults
bpftrace -e '
software:page-faults:1 {
    @faults[comm] = count();
}
interval:s:5 {
    print(@faults);
    clear(@faults);
}'
```

## Section 12: Production Memory Tuning Checklist

```bash
#!/bin/bash
# memory-audit.sh — Quick memory health check for production systems

echo "=== Memory Pressure Indicators ==="
grep -E "^(MemTotal|MemFree|MemAvailable|Cached|SwapTotal|SwapFree|Dirty|Writeback|AnonPages)" /proc/meminfo

echo ""
echo "=== PSI Memory Pressure ==="
cat /proc/pressure/memory 2>/dev/null || echo "PSI not available (kernel < 4.20)"

echo ""
echo "=== Swap Activity ==="
vmstat -s | grep -i swap

echo ""
echo "=== OOM Kills (last 100 dmesg lines) ==="
dmesg | tail -100 | grep -i "oom\|killed" || echo "No recent OOM events"

echo ""
echo "=== vm.swappiness ==="
sysctl vm.swappiness

echo ""
echo "=== THP Setting ==="
cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null

echo ""
echo "=== Top Memory Consumers ==="
ps aux --sort=-%mem | head -11

echo ""
echo "=== Memory Reclaim Stats ==="
grep -E "pgsteal_direct|pgscan_direct|compact_stall" /proc/vmstat | \
  awk '{printf "%-30s %d\n", $1, $2}'
```

### Summary sysctl Recommendations

```bash
# /etc/sysctl.d/60-production-memory.conf

# --- Page cache writeback ---
# For database servers: minimize dirty accumulation
vm.dirty_background_bytes = 67108864  # 64MB
vm.dirty_bytes = 134217728            # 128MB

# For file servers / high throughput: allow more dirty
# vm.dirty_background_ratio = 5
# vm.dirty_ratio = 15

# --- Swap behavior ---
vm.swappiness = 10               # Database servers: minimize swap

# --- Reclaim ---
vm.min_free_kbytes = 1048576     # 1GB: keep free memory margin
vm.vfs_cache_pressure = 50       # Default (100 = even; <100 = prefer keeping dentries/inodes)

# --- Overcommit ---
vm.overcommit_memory = 0         # Default: heuristic overcommit
# vm.overcommit_memory = 1       # Always allow (for JVM or Redis)
# vm.overcommit_memory = 2       # Never overcommit (conservative)
vm.overcommit_ratio = 50         # With mode 2: allow 50% overcommit

# --- NUMA ---
kernel.numa_balancing = 1        # Enable automatic NUMA page migration
```

## Conclusion

Linux memory management is a layered system where each component — page cache, LRU aging, kswapd reclaim, swap, THP, compaction — has a specific role. Understanding the interactions between these components allows precise tuning: reducing swappiness to protect database buffer pools, tuning dirty writeback to smooth I/O patterns, disabling THP for latency-sensitive services, and using PSI to detect and respond to memory pressure before it causes OOM kills.

The most important instrument for production systems is PSI: it provides an objective measure of memory pressure severity that drives automated remediation. Combined with Prometheus alerting at meaningful thresholds (5% full-stall pressure), PSI enables proactive memory management rather than reactive crisis response.
