---
title: "Linux Memory Management Deep Dive: Page Tables, Swap, OOM Killer, and Memory Pressure Tuning"
date: 2028-08-05T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "OOM Killer", "Page Tables", "Performance"]
categories:
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Linux memory management covering virtual memory and page tables, swap configuration and tuning, OOM killer behavior and scoring, memory pressure control groups, huge pages, and production tuning for Kubernetes nodes."
more_link: "yes"
url: "/linux-memory-management-page-tables-oom-guide/"
---

Understanding Linux memory management is one of the most valuable skills for anyone running production systems. Memory-related issues — OOM kills, swap exhaustion, page table bloat, memory pressure stalls — are among the most disruptive failures in production, and they are consistently misunderstood even by experienced engineers.

This guide cuts through the abstraction and explains how Linux actually manages memory: the page table walk, virtual-to-physical address translation, swap behavior, the OOM killer scoring algorithm, cgroup v2 memory controls, transparent huge pages, and the kernel parameters that matter for database and Kubernetes workloads.

<!--more-->

# Linux Memory Management Deep Dive: Page Tables, Swap, OOM Killer, and Memory Pressure Tuning

## Section 1: Virtual Memory and the Address Space

Every process in Linux gets a private virtual address space — on 64-bit x86, this is 128 TB of addressable space (the top half is reserved for the kernel). Virtual addresses are translated to physical addresses by the Memory Management Unit (MMU) using page tables.

### The Page and the Page Table

The smallest unit of memory management is the **page**: 4 KB on x86_64 by default. Every virtual address maps to a physical page frame via a multi-level page table.

On x86_64, the page table has four levels (five with 5-level paging for systems with more than 128 TB of physical RAM):

```
Virtual Address (48-bit, 4-level paging)
 ┌──────────┬──────────┬──────────┬──────────┬──────────────┐
 │  PML4    │  PDPT    │  PD      │  PT      │  Page Offset │
 │  [47:39] │  [38:30] │  [29:21] │  [20:12] │  [11:0]      │
 │  9 bits  │  9 bits  │  9 bits  │  9 bits  │  12 bits     │
 └──────────┴──────────┴──────────┴──────────┴──────────────┘
```

Each level indexes into a 4 KB table of 512 8-byte entries. The full walk:

1. CR3 register holds the physical address of the PML4 table
2. PML4 index → PDPT table physical address
3. PDPT index → PD table physical address
4. PD index → PT table physical address
5. PT index → physical page frame number
6. Physical address = page frame number concatenated with page offset

The **Translation Lookaside Buffer (TLB)** caches recent page table walks. A TLB miss triggers the full 4-level walk, which costs ~50 ns. This is why huge pages matter: a 2 MB huge page requires only 3 levels (no PT level), reducing TLB misses for large working sets.

### Inspecting Process Memory

```bash
# Virtual memory map of a process (PID 1234)
cat /proc/1234/maps
# Format: address range, permissions, offset, device, inode, pathname
# 7f8b2c000000-7f8b2d000000 rw-p 00000000 00:00 0
# Permissions: r=read w=write x=execute p=private s=shared

# Summarized memory usage
cat /proc/1234/status | grep -E "VmRSS|VmSize|VmSwap|VmPeak|VmHWM"
# VmPeak: peak virtual memory size
# VmSize: current virtual memory size
# VmHWM:  peak resident set size (RSS)
# VmRSS:  current RSS
# VmSwap: amount swapped out

# NUMA-aware memory map
cat /proc/1234/numa_maps

# System-wide memory info
cat /proc/meminfo
```

Key `/proc/meminfo` fields explained:

```bash
cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|AnonPages|Mapped|Slab|PageTables|HugePages"

# MemAvailable: realistic estimate of memory available for new allocations
#   This is NOT MemFree + Cached. It accounts for unreclaimable caches.
#   Use this for capacity planning, not MemFree.

# AnonPages: anonymous pages (heap, stack, mmap without file backing)
# Mapped: file-backed pages currently mapped into any process
# Slab:   kernel slab allocator (dentries, inodes, etc.)
# PageTables: memory used by page tables themselves (can be large with many processes)
# Dirty:  pages modified but not yet written to disk
```

### Page Table Memory Usage

In environments with many containers (Kubernetes nodes with 200+ pods), page table memory can become significant:

```bash
# Check page table memory usage
cat /proc/meminfo | grep PageTables
# PageTables: 2048000 kB  <- 2 GB used by page tables alone!

# Per-process page table size
cat /proc/*/status 2>/dev/null | awk '/^Name:/{name=$2} /^VmPTE:/{print $2, name}' | sort -rn | head -20

# Memory maps count per process (high count = high page table pressure)
wc -l /proc/*/maps 2>/dev/null | sort -rn | head -20
```

Reducing page table pressure:

```bash
# Use huge pages (reduces page table entries by 512x for 2MB pages)
# Enable transparent huge pages for memory-intensive processes:
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Or application-level: use madvise(MADV_HUGEPAGE) for large allocations

# Reduce virtual address space fragmentation
# Set vm.max_map_count higher if processes use many mmap regions
sysctl -w vm.max_map_count=262144  # Default is 65530; Java needs ~256k
```

## Section 2: Page Faults and Memory Allocation

### The Demand Paging Model

Linux does not allocate physical memory when `malloc()` is called. It allocates virtual address space. Physical pages are allocated on first access via a **page fault**:

1. Process accesses a virtual address with no physical backing
2. CPU raises a page fault exception
3. Kernel page fault handler (`do_page_fault`) runs
4. If the address is valid (in VMA), kernel allocates a physical page and installs the PTE
5. Process resumes

This is why `malloc(1GB)` succeeds even if only 100 MB of physical RAM is available — as long as you don't touch all the pages.

```c
// Demonstrating demand paging in C
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    size_t size = 1024 * 1024 * 1024; // 1 GB

    // This succeeds immediately — just virtual address space
    char *buf = malloc(size);
    printf("Allocated 1GB virtual memory, PID %d\n", getpid());
    printf("Check: cat /proc/%d/status | grep VmRSS\n", getpid());
    // VmRSS at this point: ~a few MB (just the overhead of malloc)

    sleep(5);

    // Now touch every page — this triggers page faults and physical allocation
    memset(buf, 0, size);
    printf("Touched 1GB — physical pages now allocated\n");
    printf("Check: cat /proc/%d/status | grep VmRSS\n", getpid());
    // VmRSS now: ~1GB

    sleep(60);
    free(buf);
    return 0;
}
```

### Copy-on-Write (CoW)

When a process forks, the child's page tables point to the same physical pages as the parent, marked read-only. When either process writes, a copy is made — this is Copy-on-Write. It's why `fork()` is cheap even for large processes.

```bash
# Observe CoW in action
# After fork(), both parent and child show the same RSS until one writes
strace -e trace=brk,mmap,munmap ./my-program 2>&1 | head -50
```

### NUMA Memory Allocation

On multi-socket systems, memory access time depends on which NUMA node the physical page lives on:

```bash
# Check NUMA topology
numactl --hardware
# Shows nodes, CPUs per node, memory per node, distances

# Run a process with NUMA affinity
numactl --cpunodebind=0 --membind=0 ./my-process

# Check process NUMA statistics
numastat -p my-process

# Check system NUMA statistics
numastat
# numa_hit: allocations from preferred NUMA node
# numa_miss: allocations from non-preferred node (performance impact)
```

## Section 3: Swap Deep Dive

### What Swap Actually Does

Swap is commonly misunderstood. It does not "expand RAM" in a useful way for latency-sensitive workloads, but it serves two important purposes:

1. **Anonymous page overflow**: When physical RAM is exhausted, anonymous pages (heap, stack) that haven't been accessed recently can be swapped to disk rather than the OOM killer firing.
2. **Memory compaction**: The kernel can swap out idle pages to consolidate physical memory for large contiguous allocations (huge pages).

### Swappiness

`vm.swappiness` controls how aggressively the kernel swaps anonymous pages relative to reclaiming page cache (file-backed pages):

```bash
# Check current swappiness
cat /proc/sys/vm/swappiness  # Default: 60

# For database servers (MySQL, PostgreSQL): reduce to 1-10
# Prevents the kernel from swapping database buffers to disk
sysctl -w vm.swappiness=10

# For Kubernetes nodes: often set to 0 (controversial)
# k8s kubelet requires swappiness=0 unless swap feature gate is enabled
sysctl -w vm.swappiness=0

# Persist across reboots
echo "vm.swappiness=10" >> /etc/sysctl.d/99-memory-tuning.conf
```

The actual reclaim decision is more nuanced. Kernel 5.8+ introduced `vm.swappiness=200` for zswap (compressed swap in RAM), which can be useful for memory-constrained environments.

### Swap Configuration

```bash
# Create a swap file (8GB)
dd if=/dev/zero of=/swapfile bs=1M count=8192 status=progress
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Verify swap is active
swapon --show
free -h

# Add to /etc/fstab for persistence
echo "/swapfile none swap sw 0 0" >> /etc/fstab

# Create swap on a dedicated partition (faster than swapfile)
mkswap /dev/nvme1n1p2
swapon /dev/nvme1n1p2

# Multiple swap areas with priorities
swapon -p 10 /dev/nvme0n1p3  # SSD swap (higher priority)
swapon -p 5  /swapfile        # HDD swap (lower priority)
```

### Monitoring Swap Usage

```bash
# Real-time swap I/O
vmstat 1 | awk 'NR==1 || NR==2 || NR>2 {print}' | head -5
# si: pages swapped in per second
# so: pages swapped out per second

# Which processes are using swap
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  swap=$(cat /proc/$pid/status 2>/dev/null | grep VmSwap | awk '{print $2}')
  name=$(cat /proc/$pid/comm 2>/dev/null)
  if [ -n "$swap" ] && [ "$swap" -gt 0 ]; then
    echo "$swap kB $pid $name"
  fi
done | sort -rn | head -20

# sar for historical swap data
sar -S 1 10
```

### zswap: Compressed In-Memory Swap

```bash
# Enable zswap (compresses pages in RAM before writing to disk swap)
echo 1 > /sys/module/zswap/parameters/enabled
echo zstd > /sys/module/zswap/parameters/compressor  # or lz4, lzo
echo 20 > /sys/module/zswap/parameters/max_pool_percent  # 20% of RAM

# Check zswap statistics
cat /sys/kernel/debug/zswap/pool_total_size
cat /sys/kernel/debug/zswap/stored_pages
cat /sys/kernel/debug/zswap/written_back_pages  # Ideally near 0

# Add to kernel cmdline for persistence:
# zswap.enabled=1 zswap.compressor=zstd zswap.max_pool_percent=20
```

## Section 4: The OOM Killer

When the system runs completely out of memory and cannot reclaim any (swap full, no reclaimable pages), the kernel's Out-Of-Memory killer selects a process to terminate.

### OOM Score Calculation

Each process has an `/proc/PID/oom_score` (0-1000) and `/proc/PID/oom_score_adj` (-1000 to 1000). The OOM killer selects the process with the highest `oom_score`.

The score is approximately:

```
oom_score ≈ (process_RSS_in_pages / total_RAM_in_pages) * 1000 + oom_score_adj
```

Large processes with no adjustment score higher and are killed first.

```bash
# Check OOM scores
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  score=$(cat /proc/$pid/oom_score 2>/dev/null)
  adj=$(cat /proc/$pid/oom_score_adj 2>/dev/null)
  name=$(cat /proc/$pid/comm 2>/dev/null)
  rss=$(cat /proc/$pid/status 2>/dev/null | grep VmRSS | awk '{print $2}')
  if [ -n "$score" ] && [ "$score" -gt 0 ]; then
    echo "score=$score adj=$adj rss=${rss}kB pid=$pid name=$name"
  fi
done | sort -rn | head -20

# Current OOM candidates (highest scores)
sort -n /proc/*/oom_score 2>/dev/null | tail -10
```

### Adjusting OOM Scores

```bash
# Protect a process from OOM kill (score = -1000 = never killed)
# Use with extreme caution — can cause kernel panic if it prevents all OOM resolution
echo -1000 > /proc/$(pgrep -x mysqld)/oom_score_adj

# For systemd services, use OOMScoreAdjust in the unit file
# /etc/systemd/system/mysql.service.d/oom.conf
cat > /etc/systemd/system/mysql.service.d/oom.conf << 'EOF'
[Service]
OOMScoreAdjust=-900
EOF
systemctl daemon-reload

# Make a process MORE likely to be OOM killed (e.g., low-priority batch jobs)
echo 500 > /proc/$(pgrep -x batch-job)/oom_score_adj

# Kubernetes sets oom_score_adj based on QoS class:
# BestEffort pods:  oom_score_adj = 1000  (killed first)
# Burstable pods:   oom_score_adj = 2 * (requests/node_capacity * 1000 - 10)
# Guaranteed pods:  oom_score_adj = -997  (almost never killed)
```

### OOM Killer Logs

```bash
# Find OOM events in kernel logs
dmesg | grep -i "oom\|killed process\|out of memory" | tail -50

# Or from journald
journalctl -k | grep -i "oom killer\|killed process" | tail -50

# Detailed OOM kill event
dmesg | grep -A 50 "Out of memory"
# Shows: OOM score, memory maps summary, killer decision, process killed

# Count OOM kills over time
journalctl -k --since="24 hours ago" | grep "Killed process" | wc -l
```

### OOM Kill Analysis Script

```bash
#!/bin/bash
# oom-analyze.sh
# Analyze OOM events and identify root cause

set -euo pipefail

echo "=== OOM Kill Analysis ==="
echo "Time range: last 24 hours"
echo ""

# Extract OOM events with timestamps
echo "[OOM Events]"
journalctl -k --since="24 hours ago" | grep "Killed process" | while read -r line; do
  echo "  ${line}"
done

echo ""
echo "[Memory State at Last OOM Event]"
# Get the last OOM event context
dmesg | grep -B 5 "Out of memory" | tail -20

echo ""
echo "[Current Memory Pressure]"
cat /proc/meminfo | grep -E "MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty"

echo ""
echo "[Top Memory Consumers]"
ps aux --sort=-%mem | head -15

echo ""
echo "[Kubernetes Pod Memory Usage (if applicable)]"
if command -v kubectl &>/dev/null; then
  kubectl top pods -A --sort-by=memory 2>/dev/null | head -20 || echo "  (kubectl top not available)"
fi

echo ""
echo "[Memory Cgroup Limits]"
find /sys/fs/cgroup -name "memory.limit_in_bytes" 2>/dev/null | while read -r f; do
  limit=$(cat "$f")
  if [ "$limit" -lt "9223372036854775807" ]; then
    echo "  $(dirname $f): $(( limit / 1024 / 1024 ))MB"
  fi
done | head -20
```

## Section 5: cgroup v2 Memory Control

Linux cgroup v2 provides fine-grained memory accounting and limits. Kubernetes uses cgroups v2 on modern distributions.

### cgroup v2 Memory Interfaces

```bash
# Find the cgroup for a Kubernetes pod
# Pod UID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-pod${POD_UID}.slice"

# Memory limit
cat ${CGROUP_PATH}/memory.max
# "max" = no limit; otherwise bytes

# Current memory usage
cat ${CGROUP_PATH}/memory.current

# Memory statistics (comprehensive)
cat ${CGROUP_PATH}/memory.stat
# anon: anonymous pages
# file: file-backed pages
# kernel: kernel memory
# slab: slab allocator pages
# sock: socket buffers
# pgfault: minor page faults
# pgmajfault: major page faults (disk read required)

# Memory pressure events
cat ${CGROUP_PATH}/memory.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# Memory swap limit (requires memory+swap accounting)
cat ${CGROUP_PATH}/memory.swap.max
```

### Setting Memory Limits

```bash
# Set memory limit for a cgroup (1GB)
echo "1073741824" > /sys/fs/cgroup/my-workload/memory.max

# Set memory + swap limit (prevents using swap at all)
echo "1073741824" > /sys/fs/cgroup/my-workload/memory.swap.max

# Soft limit (kernel tries to keep usage below this)
echo "805306368" > /sys/fs/cgroup/my-workload/memory.high  # 768MB

# OOM kill behavior: 0=kill task, 1=kill all tasks in cgroup
echo 1 > /sys/fs/cgroup/my-workload/memory.oom.group
```

### Memory Pressure Stalls (PSI)

Pressure Stall Information (PSI), available since Linux 4.20, quantifies time lost to memory pressure. This is the most accurate measure of whether memory is a bottleneck:

```bash
# System-level memory pressure
cat /proc/pressure/memory
# some avg10=5.23 avg60=2.11 avg300=0.89 total=3421567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
#
# "some": % of time at least one task was stalled waiting for memory
# "full": % of time ALL tasks were stalled (more severe)
# avg10/60/300: rolling averages over 10s/60s/300s

# Per-cgroup memory pressure
cat /sys/fs/cgroup/my-workload/memory.pressure

# Monitor PSI with a threshold alert
python3 - << 'EOF'
import time

def read_psi(path):
    with open(path) as f:
        for line in f:
            if line.startswith("some"):
                parts = line.split()
                return float(parts[1].split("=")[1])
    return 0.0

while True:
    pressure = read_psi("/proc/pressure/memory")
    if pressure > 10.0:
        print(f"ALERT: Memory pressure {pressure:.1f}% (>10% threshold)")
    time.sleep(10)
EOF
```

### Using memory.events for Monitoring

```bash
# Memory events for a cgroup
cat /sys/fs/cgroup/my-workload/memory.events
# low: number of times memory usage hit the low threshold
# high: number of times usage hit the high threshold
# max: number of times OOM killer was called (for this cgroup)
# oom: number of successful OOM kills
# oom_kill: number of processes killed

# Watch for OOM events in real time
while true; do
  oom=$(cat /sys/fs/cgroup/kubepods.slice/memory.events | grep "^oom_kill" | awk '{print $2}')
  echo "$(date): oom_kills=$oom"
  sleep 5
done
```

## Section 6: Transparent Huge Pages

Transparent Huge Pages (THP) allow the kernel to automatically use 2 MB pages instead of 4 KB pages for anonymous memory, reducing TLB pressure. The behavior is controlled by the `enabled` and `defrag` settings.

### THP Configuration

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# Options:
# always:        Use THP everywhere (can cause latency spikes during defrag)
# madvise:       Only use THP for madvise(MADV_HUGEPAGE) regions
# never:         Disable THP completely
# defer:         Reclaim pages in background to form huge pages (less latency)
# defer+madvise: Background THP for madvise regions only (best for databases)

# Recommended for databases (MySQL, PostgreSQL, MongoDB, Redis):
echo never > /sys/kernel/mm/transparent_hugepage/enabled
# Redis explicitly recommends disabling THP

# Recommended for Java (JVM):
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
# JVM uses madvise for heap regions

# Check THP statistics
cat /proc/meminfo | grep Huge
# AnonHugePages: 2MB pages in use
# HugePages_Total: explicit huge pages (HugeTLBfs)
# HugePages_Free: unused explicit huge pages
```

### Explicit Huge Pages (HugeTLBfs)

For workloads that benefit most from huge pages (databases, key-value stores), explicit huge pages allocated at boot are more reliable than THP:

```bash
# Allocate 512 huge pages (512 * 2MB = 1GB)
echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Persist via sysctl
echo "vm.nr_hugepages = 512" >> /etc/sysctl.d/99-hugepages.conf

# Mount hugetlbfs for application use
mkdir -p /dev/hugepages
mount -t hugetlbfs hugetlbfs /dev/hugepages

# PostgreSQL huge pages configuration
# /etc/postgresql/16/main/postgresql.conf:
# huge_pages = on
# shared_buffers = 8GB  # Will use huge pages from hugetlbfs

# 1GB huge pages for NUMA memory locking (requires hardware support)
grep pdpe1gb /proc/cpuinfo | head -1
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

## Section 7: Production Kernel Memory Tuning

### Complete sysctl Tuning Reference

```bash
# /etc/sysctl.d/99-memory-production.conf

# --- Swappiness ---
# Kubernetes node (swap usually disabled):
vm.swappiness = 0
# Database server:
vm.swappiness = 10
# General-purpose server:
vm.swappiness = 30

# --- Page cache writeback ---
# How long dirty pages can stay before being written (seconds)
vm.dirty_expire_centisecs = 3000   # 30 seconds (default 3000)
# Frequency of writeback daemon wakeup
vm.dirty_writeback_centisecs = 500 # 5 seconds (default 500)
# % of RAM that can be dirty before blocking writes (latency-sensitive: lower)
vm.dirty_ratio = 20                # (default 20)
# % of RAM before background writeback starts
vm.dirty_background_ratio = 5     # (default 10)

# --- OOM killer behavior ---
# Panic on OOM instead of killing processes (for HA setups)
# vm.panic_on_oom = 1  # Use with caution
vm.panic_on_oom = 0

# Overcommit settings
vm.overcommit_memory = 1    # 0=heuristic, 1=always allow, 2=never allow more than RAM+swap
vm.overcommit_ratio = 50    # Used when overcommit_memory=2

# --- VFS cache ---
vm.vfs_cache_pressure = 100  # Higher = more aggressive dentry/inode reclaim
# For memory-constrained systems: increase to free cache faster
# vm.vfs_cache_pressure = 200
# For systems with fast I/O: decrease to keep metadata cached
# vm.vfs_cache_pressure = 50

# --- mmap limits ---
vm.max_map_count = 262144   # Java needs ~256k; Elasticsearch needs ~262k
vm.min_free_kbytes = 65536  # Keep at least 64MB free (prevents OOM edge cases)

# --- Huge pages ---
vm.nr_hugepages = 0          # Set non-zero for databases with huge page support
vm.nr_overcommit_hugepages = 128

# Apply immediately
sysctl -p /etc/sysctl.d/99-memory-production.conf
```

### Kubernetes Node Memory Tuning

```bash
# /etc/sysctl.d/99-kubernetes-node.conf

# Disable swap (required by kubelet)
vm.swappiness = 0

# Allow containers to use more memory maps
vm.max_map_count = 262144

# Reduce OOM killer aggressiveness for system components
# (Kubernetes uses cgroup OOM, not system OOM, for containers)
vm.panic_on_oom = 0
vm.oom_kill_allocating_task = 1  # Kill the task that triggered OOM, not "best" candidate

# Reduce kernel memory fragmentation
vm.min_free_kbytes = 131072      # 128MB

# Disable THP (can interfere with container memory accounting)
# Set in /sys/kernel/mm/transparent_hugepage/enabled via:
# echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Memory overcommit (Kubernetes expects overcommit to work)
vm.overcommit_memory = 1
```

### Memory Pressure Monitoring with Prometheus

```yaml
# prometheus-memory-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: memory-pressure-alerts
  namespace: monitoring
spec:
  groups:
    - name: memory.rules
      interval: 30s
      rules:
        # Alert on high system memory PSI
        - alert: HighMemoryPressure
          expr: |
            node_pressure_memory_stalled_seconds_total
              > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Memory pressure on {{ $labels.instance }}"
            description: "Memory stall > 10% for 5 minutes"

        # Alert when available memory drops below 10%
        - alert: LowAvailableMemory
          expr: |
            node_memory_MemAvailable_bytes /
            node_memory_MemTotal_bytes < 0.10
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Low available memory on {{ $labels.instance }}"
            description: "Available memory {{ $value | humanizePercentage }}"

        # Alert on OOM kills in Kubernetes pods
        - alert: KubernetesPodOOMKill
          expr: |
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Pod OOM killed: {{ $labels.pod }}"
            description: "Container {{ $labels.container }} in pod {{ $labels.pod }} was OOM killed"

        # High swap usage
        - alert: HighSwapUsage
          expr: |
            (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) /
            node_memory_SwapTotal_bytes > 0.60
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High swap usage on {{ $labels.instance }}"
```

## Section 8: Memory Debugging Tools

### valgrind and AddressSanitizer

```bash
# valgrind for memory leak detection
valgrind --leak-check=full --track-origins=yes ./my-program

# AddressSanitizer (faster, for development)
gcc -fsanitize=address -g -O1 -o my-program my-program.c
./my-program

# Memory usage profiling with heaptrack
heaptrack ./my-program
heaptrack_gui heaptrack.my-program.12345.gz
```

### perf for Memory Access Patterns

```bash
# Profile cache misses (indicates TLB pressure or bad locality)
perf stat -e cache-references,cache-misses,dTLB-loads,dTLB-load-misses \
  ./my-program

# Profile page faults
perf stat -e page-faults,minor-faults,major-faults ./my-program

# Profile memory bandwidth
perf stat -e cpu/event=0xd0,umask=0x81/,cpu/event=0xd0,umask=0x82/ \
  ./my-program
# (Intel: MEM_INST_RETIRED.ALL_LOADS, MEM_INST_RETIRED.ALL_STORES)

# Memory access latency with perf mem
perf mem record -a sleep 10
perf mem report
```

### smem for Proportional Set Size

Standard `top`/`ps` RSS overcounts shared memory (shared libraries are counted for each process). `smem` computes PSS (Proportional Set Size) and USS (Unique Set Size):

```bash
# Install smem
apt-get install smem

# Show memory usage with PSS
smem -t -k -p -s pss | head -20
# USS: Unique Set Size (memory only this process uses)
# PSS: Proportional Set Size (USS + shared/n_sharers)
# RSS: Resident Set Size (USS + all shared, overcounts)

# Per-user summary
smem -U

# Per-process by PSS
smem -t -k -p -s pss -r | head -20
```

### /proc/slabinfo Analysis

```bash
# Kernel slab cache analysis
cat /proc/slabinfo | awk 'NR==1 || NR==2 {print} NR>2 {printf "%s %s %s %s\n", $1, $2, $3, $4*$2/1024 " KB"}' | \
  sort -k4 -rn | head -20
# High consumers: dentry, inode_cache, kmalloc-*, ext4_inode_cache

# slabtop for real-time slab monitoring
slabtop

# Drop slab caches (use carefully in production)
echo 2 > /proc/sys/vm/drop_caches  # Drop dentries and inodes
echo 3 > /proc/sys/vm/drop_caches  # Drop page cache + slabs
```

## Section 9: Memory Limits in Kubernetes

Understanding how Kubernetes translates resource requests/limits to cgroup settings:

```yaml
# pod-memory-limits.yaml
apiVersion: v1
kind: Pod
metadata:
  name: memory-demo
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          memory: "256Mi"  # Scheduler uses this for placement
        limits:
          memory: "512Mi"  # cgroup memory.max = 512Mi
      # Container QoS: Burstable (request != limit)
      # oom_score_adj: 2 * (256/node_memory * 1000 - 10)
```

```bash
# Find the cgroup for a specific pod container
POD_UID=$(kubectl get pod memory-demo -o jsonpath='{.metadata.uid}')
CONTAINER_ID=$(kubectl get pod memory-demo -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's/containerd:\/\///')

# On cgroupv2 system:
CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/kubepods-pod${POD_UID}.slice/cri-containerd-${CONTAINER_ID}.scope"
cat ${CGROUP}/memory.max  # Should match limit
cat ${CGROUP}/memory.current
cat ${CGROUP}/memory.stat

# Watch memory usage in real time for a pod
watch -n 1 "cat /sys/fs/cgroup/kubepods.slice/kubepods-pod${POD_UID}.slice/memory.current"
```

## Conclusion

Linux memory management rewards deep understanding. The key insights from this guide:

- **Virtual memory is cheap; physical memory is not.** `malloc()` doesn't allocate physical pages. Page faults do. Profile RSS and PSI, not virtual size.
- **OOM score is RSS-proportional.** Large processes with no `oom_score_adj` will be killed first. Protect critical processes with negative adjustments; make ephemeral batch jobs more likely to be killed.
- **Swappiness is not a swap toggle.** It shifts the kernel's preference between swapping anonymous pages and reclaiming page cache. Set it to 1-10 for databases, 0 for Kubernetes nodes.
- **PSI is the best memory pressure metric.** `avg10 > 10%` on `/proc/pressure/memory` indicates real memory contention. Don't wait for OOM kills to alert on memory problems.
- **THP has latency trade-offs.** Disable for Redis and latency-sensitive workloads; use `madvise` for Java. Never use `always` in production without measuring the defrag latency spikes.
- **Kernel slab and page tables are invisible to application monitoring.** On Kubernetes nodes with hundreds of containers, `PageTables` in `/proc/meminfo` can consume gigabytes. Monitor it explicitly.
