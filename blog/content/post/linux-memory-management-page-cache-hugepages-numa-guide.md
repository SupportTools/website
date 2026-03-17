---
title: "Linux Memory Management Deep Dive: Page Cache, Huge Pages, NUMA, and OOM Killer"
date: 2029-11-30T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "Page Cache", "Huge Pages", "NUMA", "OOM Killer", "Performance", "Kernel"]
categories:
- Linux
- Performance
- Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux page cache tuning, transparent huge pages, NUMA topology awareness, memory pressure analysis, and OOM killer configuration for production servers."
more_link: "yes"
url: "/linux-memory-management-page-cache-hugepages-numa-guide/"
---

Linux memory management is a multi-layered system that profoundly affects every workload running on the machine. Misunderstanding it leads to mysterious performance degradations, unexpected OOM kills, and NUMA-induced latency spikes. This guide covers the mechanisms engineers encounter most often in production: page cache behavior, huge pages, NUMA topology, and the OOM killer.

<!--more-->

## Section 1: Virtual Memory Architecture

Every process in Linux sees a flat virtual address space. The kernel maintains a page table for each process that maps virtual page addresses to physical page frames (4KB each on x86-64). Virtual memory enables four critical capabilities:

**Memory Isolation**: Process A cannot read process B's memory (absent shared mappings).

**Overcommit**: The system can allocate more virtual memory than physical RAM. Pages are only backed by physical memory when first written (copy-on-write and demand paging).

**File-Backed Mappings**: File data can be mapped directly into process address spaces via `mmap`. When the program accesses the memory address, the kernel page-faults the data in from disk.

**Memory-Mapped I/O**: Devices and kernel structures can be accessed via memory reads rather than `read()`/`write()` syscalls.

### Viewing the Virtual Address Space

```bash
# View process memory map
cat /proc/$(pgrep my-service)/maps

# More detailed view with statistics
cat /proc/$(pgrep my-service)/smaps

# Summary of memory regions
cat /proc/$(pgrep my-service)/smaps_rollup

# System-wide virtual memory statistics
cat /proc/vmstat | grep -E 'pgfault|pgmajfault|pgpgin|pgpgout'
```

## Section 2: The Page Cache

The page cache is the kernel's in-memory buffer for file system data. Every `read()` of a file first checks the page cache; only on a miss does the kernel issue an I/O request to disk. After reading, the data remains in the page cache for future access.

### Page Cache Behavior

```bash
# View current memory usage breakdown
free -h
#               total        used        free      shared  buff/cache   available
# Mem:          125Gi        42Gi       4.2Gi       1.1Gi        79Gi        82Gi

# "buff/cache" is the page cache + buffer cache
# "available" is what can be freed for new allocations (cache is reclaimable)

# Detailed breakdown
cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable|Cached|Buffers|Dirty|Writeback|Active|Inactive'

# Monitor page cache hit rate in real-time
watch -n 1 'cat /proc/vmstat | grep -E "pgcache_hit|pgcache_miss" 2>/dev/null || \
  awk "/^pgpgin/ {pin=$2} /^pgpgout/ {pout=$2} END {print \"page-ins:\",pin,\"page-outs:\",pout}" /proc/vmstat'
```

### Tuning Page Cache Writeback

The kernel accumulates dirty pages (modified file data) and writes them back to disk asynchronously. The writeback parameters control the trade-off between write performance and data durability:

```bash
# View current writeback settings
sysctl vm.dirty_ratio vm.dirty_background_ratio \
       vm.dirty_expire_centisecs vm.dirty_writeback_centisecs

# Defaults and their meanings:
# vm.dirty_ratio = 20
#   Start synchronous writeback when dirty pages exceed 20% of total RAM
# vm.dirty_background_ratio = 10
#   Start background writeback at 10% of total RAM
# vm.dirty_expire_centisecs = 3000
#   Flush dirty pages older than 30 seconds
# vm.dirty_writeback_centisecs = 500
#   Run writeback thread every 5 seconds
```

For database workloads where the database manages its own I/O (PostgreSQL, MySQL), reduce dirty ratios to prevent the page cache from buffering database writes:

```bash
# /etc/sysctl.d/99-memory.conf for database servers
cat > /etc/sysctl.d/99-memory.conf << 'EOF'
# Reduce dirty page accumulation for database servers
vm.dirty_ratio = 5
vm.dirty_background_ratio = 2
vm.dirty_expire_centisecs = 1000
vm.dirty_writeback_centisecs = 200

# Reduce swappiness (prefer page cache eviction over swap)
vm.swappiness = 10

# Prefer to keep application data over file cache under pressure
vm.vfs_cache_pressure = 50
EOF
sysctl --system
```

### Cache Eviction Analysis with cachestat

```bash
# Install bcc-tools
apt-get install bpfcc-tools

# Monitor page cache hits, misses, and evictions in real-time
/usr/share/bcc/tools/cachestat 1

# HITS   MISSES  DIRTIES HITRATIO   BUFFERS_MB  CACHED_MB
# 14823    1241    8441    92.27%           42      61244
#  9851     403    6238    96.07%           42      61253

# Trace which files are being read through the page cache
/usr/share/bcc/tools/cachetop 1
```

## Section 3: Transparent Huge Pages

The default Linux page size is 4KB. With 128GB of RAM, that's 32 million page table entries. Translating a virtual address to a physical one requires walking the page table and can miss the TLB (Translation Lookaside Buffer), adding significant latency.

Huge pages (2MB on x86-64) reduce TLB pressure by a factor of 512. With huge pages, 128GB of RAM requires only 65,536 entries rather than 32 million.

### THP Modes

```bash
# Check current THP setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# Three modes:
# always: promote any eligible anonymous memory to huge pages automatically
# madvise: only promote regions explicitly requested via madvise(MADV_HUGEPAGE)
# never: disable THP entirely
```

### THP Impact on Different Workloads

THP benefits workloads with large, sequential memory access patterns (large JVM heaps, scientific computing, in-memory databases). It harms workloads with small, sparse allocations (Redis, Kafka) because:

1. A 2MB allocation cannot be made in one huge page if the contiguous physical memory is not available — the kernel must fragment it (khugepaged latency spikes)
2. Copy-on-write for a forked process copies 2MB at once instead of 4KB (increased latency on fork)
3. Memory waste from partial huge page usage

```bash
# Production recommendation for Redis, Kafka, and most microservices
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Persistent across reboots
cat >> /etc/rc.local << 'EOF'
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
EOF

# Production recommendation for JVM workloads (large heap)
echo always > /sys/kernel/mm/transparent_hugepage/enabled
```

### Explicit Huge Pages with HugeTLBfs

For maximum performance (database buffer pools, DPDK network stacks), pre-allocate static huge pages:

```bash
# Allocate 100 x 2MB huge pages (200MB total)
echo 100 > /proc/sys/vm/nr_hugepages

# Verify allocation
grep HugePages /proc/meminfo
# HugePages_Total:     100
# HugePages_Free:       87
# HugePages_Rsvd:        0
# Hugepagesize:       2048 kB

# Persistent allocation
cat >> /etc/sysctl.d/99-memory.conf << 'EOF'
vm.nr_hugepages = 2048
EOF

# PostgreSQL huge page configuration
# postgresql.conf
# huge_pages = on
```

## Section 4: NUMA Architecture

Non-Uniform Memory Access (NUMA) systems have multiple memory controllers, each directly attached to a subset of CPU cores. Accessing local memory (attached to your NUMA node) is fast (~70ns). Accessing remote memory (across the NUMA interconnect) is 30-40% slower (~100ns).

### Discovering NUMA Topology

```bash
# Install numactl
apt-get install numactl

# Show NUMA topology
numactl --hardware

# Example output for a 2-socket server:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 64407 MB
# node 0 free: 22341 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 64473 MB
# node 1 free: 18921 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
# Distance 10 = local access (~70ns), 21 = remote access (~100ns)

# Check current NUMA memory allocation statistics
numastat

# Per-process NUMA statistics
numastat -p $(pgrep my-service)
```

### NUMA-Aware Process Binding

```bash
# Bind a process to NUMA node 0 CPUs and local memory
numactl --cpunodebind=0 --membind=0 -- ./my-service

# Allow process to use both nodes but prefer local allocation
numactl --preferred=0 -- ./my-service

# Interleave memory across all NUMA nodes (good for multi-threaded workloads)
numactl --interleave=all -- ./my-service
```

### NUMA Balancing

The kernel's automatic NUMA balancing (`numa_balancing`) migrates pages to the NUMA node where they are most frequently accessed:

```bash
# Check if NUMA balancing is enabled
cat /proc/sys/kernel/numa_balancing  # 1 = enabled, 0 = disabled

# For applications that do their own NUMA management (JVM, databases)
# disable automatic balancing to avoid overhead
echo 0 > /proc/sys/kernel/numa_balancing

# Monitor NUMA migration activity
cat /proc/vmstat | grep numa
# numa_pages_migrated 84923  ← high value = lots of migrations
# numa_hit 99841024
# numa_miss 4982              ← remote accesses
# numa_local 99836042
# numa_foreign 4982
```

### Kubernetes NUMA Topology Management

```yaml
# Enable NUMA-aware CPU and memory allocation for high-performance pods
# kubelet configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: single-numa-node  # or best-effort, restricted
cpuManagerPolicy: static
memoryManagerPolicy: Static
reservedMemory:
  - numaNode: 0
    limits:
      memory: 1Gi
  - numaNode: 1
    limits:
      memory: 1Gi
```

```yaml
# Pod requesting guaranteed NUMA-aligned resources
spec:
  containers:
    - name: latency-critical
      resources:
        requests:
          cpu: "8"
          memory: "16Gi"
        limits:
          cpu: "8"
          memory: "16Gi"
```

## Section 5: Memory Pressure and Reclaim

When available memory drops below a threshold, the kernel begins reclaiming memory through several mechanisms in order of preference:

1. Page cache eviction (dropping clean pages)
2. Swap out anonymous pages (if swap is configured)
3. OOM kill (last resort)

### Monitoring Memory Pressure

```bash
# PSI (Pressure Stall Information) - kernel >= 4.20
# Values represent percentage of time stalled on memory
cat /proc/pressure/memory
# some avg10=0.25 avg60=0.08 avg300=0.03 total=1234567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = at least one task stalled on memory
# "full" = all tasks stalled on memory (severe)
# avg10/avg60/avg300 = 10s/60s/5min averages

# Monitor in real-time
watch -n 1 'cat /proc/pressure/memory'

# vmstat memory columns
vmstat 1 | head -3
# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
#  r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
#  2  0      0 4096232 42876 81241028    0    0     0     1    1    1  8  1 91  0  0
# si/so = swap-in/swap-out KB/s; should be 0 on a healthy system
```

### Configuring Swap

```bash
# Check if swap is configured
swapon --show

# Create a swap file (for cloud VMs without dedicated swap partitions)
fallocate -l 8G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Add to fstab
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Set swappiness (0 = avoid swap unless OOM imminent, 100 = swap aggressively)
echo 10 > /proc/sys/vm/swappiness
```

## Section 6: OOM Killer Configuration

The OOM (Out Of Memory) killer is the kernel's last resort when memory cannot be reclaimed. It selects and kills a process using the `oom_score_adj` heuristic.

### OOM Score Adjustment

```bash
# View OOM score for all processes (higher = more likely to be killed)
for pid in /proc/[0-9]*/; do
  pid="${pid##/proc/}"
  pid="${pid%%/}"
  comm=$(cat /proc/${pid}/comm 2>/dev/null)
  score=$(cat /proc/${pid}/oom_score 2>/dev/null)
  adj=$(cat /proc/${pid}/oom_score_adj 2>/dev/null)
  echo "${score} ${adj} ${pid} ${comm}"
done | sort -rn | head -20

# Protect a critical process from OOM kill
# -1000 = never kill, -999 to 1000 = adjust relative score
echo -1000 > /proc/$(pgrep etcd)/oom_score_adj

# Make less critical processes more likely to be killed first
echo 500 > /proc/$(pgrep some-batch-job)/oom_score_adj
```

### Setting OOM Score in systemd Units

```ini
# /etc/systemd/system/etcd.service.d/oom.conf
[Service]
OOMScoreAdjust=-999
```

### Kubernetes OOM Configuration

```yaml
# Kubernetes maps QoS classes to OOM score adjustments:
# Guaranteed (requests == limits): oom_score_adj = -997 (protected)
# Burstable (requests < limits): oom_score_adj = 2 to 999 (calculated)
# BestEffort (no requests/limits): oom_score_adj = 1000 (first to die)

# Always set resource requests and limits on critical pods
spec:
  containers:
    - name: api-server
      resources:
        requests:
          memory: "512Mi"
          cpu: "250m"
        limits:
          memory: "1Gi"   # Triggers OOM kill when exceeded
          cpu: "1"
```

### Diagnosing OOM Events

```bash
# Check dmesg for OOM kill events
dmesg -T | grep -i "oom\|killed process\|out of memory"

# Find recent OOM kills in kernel log
journalctl -k | grep -E "OOM|out of memory|Killed process"

# oom-kill event details include:
# - Process name and PID
# - Memory statistics at the time of kill
# - Which process was selected and why
# - Total memory allocation at the time
```

### Memory Limit Monitoring in Production

```bash
# Monitor per-cgroup memory usage (Kubernetes pods use cgroups)
# Find the cgroup for a pod
CGROUP=$(cat /proc/$(pgrep my-service)/cgroup | grep memory | cut -d: -f3)

# Read memory usage
cat /sys/fs/cgroup${CGROUP}/memory.current

# Read memory limit
cat /sys/fs/cgroup${CGROUP}/memory.max

# Usage near limit? Alert before OOM
USAGE=$(cat /sys/fs/cgroup${CGROUP}/memory.current)
LIMIT=$(cat /sys/fs/cgroup${CGROUP}/memory.max)
PERCENT=$((USAGE * 100 / LIMIT))
echo "Memory usage: ${PERCENT}% (${USAGE} / ${LIMIT} bytes)"
```

Understanding Linux memory management is not optional for engineers responsible for production systems. The page cache, huge pages, NUMA topology, and OOM killer are not edge cases — they are the mechanisms that determine whether your system performs predictably at scale or degrades mysteriously under load.
