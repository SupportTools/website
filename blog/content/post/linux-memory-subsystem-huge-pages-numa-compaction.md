---
title: "Linux Memory Subsystem: Huge Pages, NUMA Balancing, and Memory Compaction"
date: 2030-07-01T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "NUMA", "Huge Pages", "Performance", "Kernel Tuning", "Databases"]
categories:
- Linux
- Performance
- Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux memory: transparent huge pages configuration, explicit huge pages for databases, NUMA auto-balancing, memory compaction, page reclaim tuning, and production memory optimization patterns."
more_link: "yes"
url: "/linux-memory-subsystem-huge-pages-numa-compaction/"
---

Memory performance problems are among the hardest to diagnose in production because they manifest as CPU stalls rather than direct memory errors. A process can be spending 40% of its CPU cycles waiting for TLB misses caused by sub-optimal huge page configuration. NUMA-unaware memory allocation silently adds 30-100ns to every memory access for processes whose threads span multiple sockets. Memory compaction stalls can pause latency-sensitive processes for hundreds of milliseconds without generating any visible error. Understanding the Linux memory subsystem at this depth transforms inexplicable performance anomalies into tunable parameters.

<!--more-->

## Memory Architecture Fundamentals

### Physical Memory Layout

Modern x86-64 systems use a 48-bit virtual address space (256 TB) mapped to physical memory through a four-level page table hierarchy. Each page table lookup requires up to four memory accesses before reaching the actual data, which is why the Translation Lookaside Buffer (TLB) — a cache of recent virtual-to-physical address mappings — is so performance-critical.

```bash
# Examine physical memory topology
cat /proc/iomem | head -20

# NUMA node topology
numactl --hardware

# Example output on a dual-socket system:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
# node 0 size: 128763 MB
# node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node 1 size: 129024 MB
# node distances:
# node   0   1
#   0:  10  21

# Memory access latency: local (10) vs remote (21) = 2.1x penalty
```

### TLB and Page Table Pressure

```bash
# Monitor TLB miss rate with perf
perf stat -e dTLB-load-misses,dTLB-store-misses,iTLB-load-misses \
  -p $(pgrep postgres | head -1) sleep 30

# Typical output showing TLB pressure:
# 45,234,123  dTLB-load-misses
# 12,345,678  dTLB-store-misses

# With 4KB pages, each TLB miss costs ~10-50ns on a miss that hits L3 cache
# At 1M TLB misses/second, that's 10-50ms/second of stall time
```

## Transparent Huge Pages

Transparent Huge Pages (THP) is the kernel feature that automatically promotes 4KB pages to 2MB huge pages when a process has a sufficient contiguous memory region. THP reduces TLB pressure by reducing the number of TLB entries needed by a factor of 512.

### THP Modes

```bash
# Check current THP configuration
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# Options:
# always   - promote pages to huge pages whenever possible
# madvise  - only for regions explicitly marked with madvise(MADV_HUGEPAGE)
# never    - disable THP entirely

cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never
# always:         synchronous defragmentation (can cause latency spikes)
# defer:          defer defrag to background thread
# defer+madvise:  defer except for madvised regions
# madvise:        only defrag madvised regions synchronously
# never:          no defragmentation (fragmention may prevent THP promotion)

cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# 10000 (default: scan every 10 seconds)
```

### THP and Databases

Most databases (PostgreSQL, MongoDB, Redis, Oracle) recommend disabling THP because:
1. The synchronous defragmentation (`defrag=always`) causes latency spikes during memory allocation
2. THP promotion occurs at page fault time, adding non-deterministic latency
3. Databases manage their own buffer pools and benefit from explicit huge page control

```bash
# Disable THP for database servers
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persist in /etc/rc.local or systemd unit
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=basic.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=basic.target
EOF

systemctl enable disable-thp
systemctl start disable-thp
```

### THP for Java and Go Applications

For JVM-based and Go applications that manage large heaps, `madvise` mode with `defer` defrag provides huge page benefits without the defrag latency spikes:

```bash
# Recommended for JVM/Go applications
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# JVM: enable THP awareness
# -XX:+UseTransparentHugePages (JDK 11+)

# Go runtime: hint for huge pages on large allocations
# The Go runtime does not have explicit huge page control,
# but madvise mode benefits large heap allocations automatically
```

## Explicit Huge Pages (HugeTLBFS)

Explicit huge pages are pre-allocated at boot and cannot be swapped. They are always available as 2MB (default) or 1GB (gigantic) pages. Databases like PostgreSQL and Oracle explicitly use these for their shared memory buffers.

### Allocating Huge Pages

```bash
# Check current huge page status
cat /proc/meminfo | grep -i huge
# AnonHugePages:   2097152 kB  <- THP in use
# ShmemHugePages:        0 kB
# HugePages_Total:    4096     <- pre-allocated huge pages
# HugePages_Free:     3892     <- available for applications
# HugePages_Rsvd:      204     <- reserved but not yet faulted
# HugePages_Surp:        0     <- surplus pages
# Hugepagesize:       2048 kB
# Hugetlb:        8388608 kB   <- total hugepage memory

# Allocate 16GB of 2MB huge pages (8192 pages)
echo 8192 > /proc/sys/vm/nr_hugepages

# Verify allocation succeeded
cat /proc/meminfo | grep HugePages_Total
# HugePages_Total: 8192

# If allocation fails (due to fragmentation), try after boot or use:
echo 8192 > /proc/sys/vm/nr_hugepages
# Then check if the count was actually set:
cat /proc/sys/vm/nr_hugepages
```

### 1GB Gigantic Pages

For databases with very large working sets, 1GB pages further reduce TLB pressure:

```bash
# 1GB pages must be allocated at boot via kernel command line
# Edit /etc/default/grub:
GRUB_CMDLINE_LINUX="hugepagesz=1G hugepages=32 default_hugepagesz=1G"
update-grub
reboot

# Verify 1GB pages
cat /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
grep -i hugepages /proc/meminfo

# Note: 1GB pages cannot be allocated after boot (require contiguous physical memory)
```

### Making Huge Pages Persistent

```bash
# /etc/sysctl.d/99-hugepages.conf
vm.nr_hugepages = 8192
vm.nr_overcommit_hugepages = 2048  # Allow some surplus allocation

# For NUMA systems: allocate per-node
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 4096 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 4096 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages
```

### PostgreSQL Huge Pages Configuration

```bash
# postgresql.conf
huge_pages = on           # require | on | off
# 'require' fails to start if huge pages unavailable
# 'on' uses huge pages if available, falls back otherwise
# 'off' never uses huge pages

# Calculate required huge pages:
# shared_buffers / hugepagesize
# Example: 32GB shared_buffers / 2MB = 16384 pages
shared_buffers = 32GB

# Verify PostgreSQL is using huge pages
grep -i huge /proc/$(pgrep postgres | head -1)/smaps | grep HugePages
```

## NUMA Architecture and Optimization

### NUMA Topology Inspection

```bash
# Detailed NUMA topology
numactl --hardware
lstopo          # hwloc topology visualization
lstopo --output-format png > /tmp/topology.png

# CPU-to-NUMA-node mapping
cat /sys/devices/system/cpu/cpu0/topology/core_id
cat /sys/devices/system/cpu/cpu*/topology/physical_package_id | sort | uniq -c

# Memory bandwidth per NUMA node
numastat -m
# Shows memory allocation and usage per NUMA node

# Per-process NUMA statistics
numastat -p $(pgrep postgres | head -1)
```

### NUMA Memory Policies

```bash
# Run a process with memory bound to a specific NUMA node
numactl --cpunodebind=0 --membind=0 postgres

# Interleave memory allocation across nodes (good for throughput, not latency)
numactl --interleave=all myapp

# Check memory policy for running process
cat /proc/$(pgrep myapp)/numa_maps | head -20
# Shows virtual address ranges and their NUMA memory placement

# Example output:
# 7f1234560000 default anon=15 dirty=15 N0=10 N1=5
# ^address     ^policy ^anon ^dirty ^node0=10 ^node1=5
# This line shows memory split across nodes (NUMA imbalance)
```

### NUMA Auto-Balancing

NUMA auto-balancing (AutoNUMA) periodically migrates pages to the NUMA node where they are most frequently accessed. It works by:
1. Unmapping pages temporarily (creating NUMA hint faults)
2. Recording which CPU (and therefore NUMA node) caused each fault
3. Migrating pages to the node with the most faults

```bash
# Check AutoNUMA status
cat /proc/sys/kernel/numa_balancing
# 1 = enabled, 0 = disabled

# AutoNUMA statistics
cat /proc/vmstat | grep numa
# numa_hint_faults: 1234567      <- pages probed (temporarily unmapped)
# numa_hint_faults_local: 900000 <- faults from local node (good)
# numa_pages_migrated: 234567    <- pages migrated to better node
# numa_pte_updates: 456789       <- PTE updates for balancing

# Tune AutoNUMA scan rate (default: 1000ms between scans)
echo 1000 > /proc/sys/kernel/numa_balancing_scan_delay_ms
echo 1000 > /proc/sys/kernel/numa_balancing_scan_period_min_ms
echo 60000 > /proc/sys/kernel/numa_balancing_scan_period_max_ms
```

### When to Disable AutoNUMA

AutoNUMA works best for long-running processes with stable access patterns. It should be disabled for:
- Latency-sensitive applications (page scanning adds minor latency)
- Processes that are already NUMA-pinned
- Applications with rapidly changing access patterns (e.g., batch jobs)

```bash
# Disable AutoNUMA for latency-sensitive applications
echo 0 > /proc/sys/kernel/numa_balancing

# Or disable for a specific cgroup
echo 0 > /sys/fs/cgroup/system.slice/myapp.service/memory.numa_stat
```

### NUMA-Aware Application Deployment

```bash
# Pin Kubernetes pods to specific NUMA nodes via CPU Manager
# (requires cpu-manager-policy: static in kubelet config)

# Kubernetes topology manager for NUMA-aligned resource allocation
# kubelet flag: --topology-manager-policy=single-numa-node

# Verify NUMA alignment in Kubernetes
kubectl exec -it mypod -- sh -c 'cat /proc/1/numa_maps | grep -v "^$"'

# For database pods, use node affinity to ensure NUMA-aware node selection
# and set guaranteed QoS (CPU/memory requests == limits)
```

## Memory Compaction

Memory compaction moves physical pages around to create large contiguous free regions, enabling huge page allocations. Compaction is expensive: it can pause the process waiting for a huge page allocation.

### Monitoring Compaction

```bash
# Compaction statistics
cat /proc/vmstat | grep compact
# compact_migrate_scanned: 1234567
# compact_free_scanned: 2345678
# compact_isolated: 345678
# compact_stall: 1234         <- times a process stalled waiting for compaction
# compact_fail: 456           <- compaction attempts that failed
# compact_success: 778        <- successful compaction events
# compact_daemon_wake: 890    <- times kcompactd was woken

# High compact_stall indicates allocation latency from compaction
```

### Compaction Tuning

```bash
# /etc/sysctl.d/99-compaction.conf

# Compaction proactiveness (0-100): higher = more background compaction
# Default: 20. Increase to pre-empt compaction stalls in foreground processes
vm.compaction_proactiveness = 40

# Min free kbytes: kernel tries to keep this much memory free
# Too low: fragmentation, compaction stalls
# Too high: wastes memory that could be used for cache
# Rule of thumb: ~1% of RAM, max 1GB
vm.min_free_kbytes = 524288  # 512MB

# Watermarks for huge page allocation attempts
vm.watermark_boost_factor = 15000
vm.watermark_scale_factor = 125
```

### Fragmentation Index

```bash
# Check memory fragmentation
cat /proc/buddyinfo
# Tells you how many free pages of each size order are available per zone

# Example:
# Node 0, zone   Normal  5000  3200  1800  900  400  150  50  10  2  0  0
# The numbers represent free blocks of size 2^n pages
# Order 9 = 2^9 = 512 pages = 2MB huge page
# Only 2 free 2MB blocks in Normal zone means THP allocation will fail

# More detailed fragmentation information
cat /sys/kernel/debug/extfrag/extfrag_index
# Values near 1.0 = high fragmentation, allocation will fail
# Values near 0.0 = low fragmentation, allocation will succeed
```

## Page Reclaim Tuning

### Swappiness

```bash
# vm.swappiness controls the balance between:
# 0:   never swap, prefer OOM kill (use for dedicated database servers)
# 10:  very strong preference for file cache over swap
# 60:  default: balanced
# 100: aggressively swap to keep file cache hot

# For database servers: 0 or 1
echo 0 > /proc/sys/vm/swappiness

# For application servers: 10
echo 10 > /proc/sys/vm/swappiness
```

### VFS Cache Pressure

```bash
# vm.vfs_cache_pressure controls reclaimation of inode/dentry caches
# 100: default (balanced)
# 50:  keep directory entry cache twice as long as default (metadata-heavy workloads)
# 200: reclaim directory entries more aggressively (memory-constrained)

# For filesystem-heavy workloads (many small files)
echo 50 > /proc/sys/vm/vfs_cache_pressure
```

### Zone Reclaim Mode

```bash
# vm.zone_reclaim_mode controls NUMA zone behavior when a zone is low on memory
# 0: default (disabled) - allocate from remote NUMA nodes before reclaiming local cache
# 1: reclaim local zone memory before using remote NUMA nodes
# 2: write dirty pages to disk before using remote NUMA nodes
# 4: swap pages before using remote NUMA nodes

# For most workloads: 0 (avoid local reclaim overhead, use remote memory first)
echo 0 > /proc/sys/vm/zone_reclaim_mode

# Exception: for databases with strict NUMA locality requirements
# where remote memory access is worse than cache eviction
echo 1 > /proc/sys/vm/zone_reclaim_mode
```

## OOM Killer Tuning

```bash
# Set OOM score for critical processes (lower = less likely to be killed)
# Range: -1000 (never kill) to 1000 (kill first)

# Protect a database process
echo -500 > /proc/$(pgrep postgres | head -1)/oom_score_adj

# Mark a process as the preferred OOM victim (e.g., batch jobs)
echo 500 > /proc/$(pgrep batch-job | head -1)/oom_score_adj

# Disable OOM killer for a critical process (use with extreme caution)
# This can cause the entire system to deadlock if truly OOM
echo -1000 > /proc/$(pgrep critical-service | head -1)/oom_score_adj

# Configure OOM kill behavior: kill (1) or panic (0)
# panic is appropriate for high-availability systems that should fail over
echo 0 > /proc/sys/vm/oom_kill_allocating_task
# 1 = kill the task that triggered OOM (may not free enough memory)
# 0 = use the standard oom_score-based selection algorithm
```

## Memory Monitoring and Alerting

### Key Metrics

```bash
# Memory utilization breakdown
cat /proc/meminfo

# Key fields:
# MemTotal:    total physical memory
# MemFree:     completely unused memory
# MemAvailable: memory available for new allocations (includes reclaimable cache)
# Cached:      page cache (can be reclaimed)
# Buffers:     kernel buffers (can be reclaimed)
# Dirty:       dirty pages waiting to be written to disk
# Writeback:   pages being written to disk
# AnonPages:   anonymous (process) memory
# Slab:        kernel slab allocator memory
# SReclaimable: reclaimable slab (e.g., dentry cache)
# SUnreclaim:  unreclaimable slab (e.g., network buffers in use)

# The critical metric for "out of memory" is MemAvailable, not MemFree
# MemAvailable = MemFree + Reclaimable cache
```

### Prometheus Alerting Rules

```yaml
groups:
- name: memory
  rules:
  - alert: NodeMemoryPressure
    expr: |
      node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Less than 10% memory available on {{ $labels.instance }}"

  - alert: NodeHugePagesExhausted
    expr: |
      node_memory_HugePages_Free_total == 0 and
      node_memory_HugePages_Total_total > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "All huge pages in use on {{ $labels.instance }}"

  - alert: NodeMemoryCompactionStalls
    expr: |
      rate(node_vmstat_compact_stall[5m]) > 10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High memory compaction stall rate on {{ $labels.instance }}"

  - alert: NodeNUMAImbalance
    expr: |
      (node_numa_hit_total - node_numa_local_total) /
      node_numa_hit_total > 0.3
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "30% of memory accesses crossing NUMA boundaries on {{ $labels.instance }}"
```

## Production Memory Tuning Playbook

### Database Server (PostgreSQL, MySQL)

```bash
# /etc/sysctl.d/99-database-memory.conf
vm.swappiness = 0
vm.nr_hugepages = 16384          # Enough for shared_buffers + overhead
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 500
vm.dirty_writeback_centisecs = 100
vm.vfs_cache_pressure = 50
kernel.numa_balancing = 0         # Disable AutoNUMA; pin manually instead
vm.compaction_proactiveness = 60  # More background compaction
vm.min_free_kbytes = 524288
```

```bash
# Disable THP for databases
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Pin database to NUMA node 0
numactl --cpunodebind=0 --membind=0 systemctl start postgresql
```

### Application Server (JVM, Go)

```bash
# /etc/sysctl.d/99-app-memory.conf
vm.swappiness = 10
vm.overcommit_memory = 1     # Allow optimistic memory allocation (required for Go/JVM)
vm.overcommit_ratio = 50     # Overcommit up to 50% of RAM + swap
vm.compaction_proactiveness = 30
vm.min_free_kbytes = 131072  # 128MB
```

```bash
# Use madvise THP mode for JVM/Go
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag
```

### Container Host (Kubernetes Node)

```bash
# /etc/sysctl.d/99-kubernetes-memory.conf
vm.swappiness = 0            # Kubernetes recommends disabling swap
vm.overcommit_memory = 1     # Allow overcommit (containers use limits, not reservations)
vm.panic_on_oom = 0          # Don't panic, use OOM killer
vm.oom_kill_allocating_task = 0
vm.min_free_kbytes = 524288  # 512MB reserve for kernel operations
```

The Linux memory subsystem rewards deep understanding. The difference between a database server with 2ms p99 query latency and 15ms p99 query latency is often not hardware — it is THP defragmentation stalls, NUMA-unaware memory allocation, and page reclaim interfering with the buffer pool. Systematic measurement of TLB miss rates, compaction stalls, and NUMA locality, combined with the tuning parameters above, transforms memory from a black box into a set of controllable parameters.
