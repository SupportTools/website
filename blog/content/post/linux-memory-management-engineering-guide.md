---
title: "Linux Memory Management for Engineers: OOM Killer, Huge Pages, and cgroup Memory"
date: 2028-04-27T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "OOM Killer", "Huge Pages", "cgroups", "Kubernetes"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux memory management for engineers running production workloads: understanding the OOM killer, tuning huge pages for performance, controlling memory with cgroup v2, and diagnosing memory pressure in Kubernetes environments."
more_link: "yes"
url: "/linux-memory-management-engineering-guide/"
---

Linux memory management is a system that most engineers treat as a black box until something goes wrong. Understanding how the kernel allocates memory, when the OOM killer fires, how huge pages reduce TLB pressure, and how cgroup v2 enforces container memory limits is essential for running production workloads reliably. This guide covers the internals that matter for engineers operating real systems.

<!--more-->

# Linux Memory Management for Engineers: OOM Killer, Huge Pages, and cgroup Memory

## Virtual Memory Fundamentals

Every process in Linux lives in its own virtual address space. Physical RAM is divided into 4 KiB pages by default. The kernel maintains a page table for each process mapping virtual page numbers to physical page frames. When a process accesses a virtual address, the CPU's Memory Management Unit (MMU) walks the page table to find the physical address. A TLB (Translation Lookaside Buffer) caches recent translations to avoid repeated page table walks.

Key memory regions in a process:

- **Text segment**: Read-only executable code, shared between processes running the same binary
- **Data/BSS**: Static data and zero-initialized globals
- **Heap**: Dynamic allocations via `malloc()`/`brk()`/`mmap()`
- **Memory-mapped files**: Files mapped into the address space via `mmap()`
- **Stack**: Per-thread LIFO stack for local variables and function frames
- **VDSO/VVAR**: Kernel-provided shared memory for fast syscall dispatch

### The Anatomy of Memory Consumption

```bash
# Inspect a process's memory maps
cat /proc/<PID>/maps

# Summary of virtual memory areas
cat /proc/<PID>/smaps_rollup

# Detailed per-page statistics
cat /proc/<PID>/smaps | head -100

# Key fields to understand:
# Rss:   Resident Set Size - physical pages currently mapped
# Pss:   Proportional Set Size - Rss divided by number of sharing processes
# Shared_Clean: Pages shared with other processes, not dirtied
# Private_Dirty: Private pages modified by this process (counts toward swap pressure)
# Swap:  Pages currently swapped out
```

### Virtual vs Resident vs Proportional

```bash
# See VmRSS (Resident) and VmVirt (Virtual) for a process
cat /proc/<PID>/status | grep -E "Vm(RSS|Size|Swap|Peak)"

# System-wide memory overview
free -h

# Detailed accounting
cat /proc/meminfo

# Key fields:
# MemTotal:     Total physical RAM
# MemFree:      Completely unused memory
# MemAvailable: Estimate of memory available without swapping (includes reclaimable caches)
# Cached:       Page cache - can be reclaimed
# Buffers:      Block device buffer cache
# SReclaimable: Slab memory that can be reclaimed (dentry/inode caches)
# CommitLimit:  Max memory that can be committed given overcommit settings
# Committed_AS: Total virtual memory committed by all processes
```

## Memory Overcommit

Linux allows processes to allocate more virtual memory than physical RAM exists. This works because most allocated memory is never actually used (sparse arrays, pre-allocated buffers that remain empty, copy-on-write pages).

Overcommit policy is controlled by `/proc/sys/vm/overcommit_memory`:

```bash
# 0 (default): Heuristic overcommit - kernel uses estimation to allow reasonable overcommit
# 1: Always overcommit - never fail malloc() due to memory limits
# 2: Never overcommit - only allow allocations up to CommitLimit
cat /proc/sys/vm/overcommit_memory

# For mode 2, CommitLimit = (overcommit_ratio / 100 * RAM) + swap
cat /proc/sys/vm/overcommit_ratio  # Default: 50

# Set strict no-overcommit for financial or safety-critical systems
sysctl -w vm.overcommit_memory=2
sysctl -w vm.overcommit_ratio=80
```

## The OOM Killer

When the system runs out of memory and cannot reclaim any pages through swapping or cache eviction, the OOM (Out Of Memory) killer selects and terminates one or more processes to free memory.

### OOM Score Calculation

Each process has an `oom_score` (0-1000) that determines its kill priority. Higher scores mean more likely to be killed.

```bash
# View a process's OOM score
cat /proc/<PID>/oom_score

# View the OOM score adjustment (range: -1000 to 1000)
# Kernel adds this to the base oom_score
cat /proc/<PID>/oom_score_adj

# -1000: Never kill this process (kernel processes)
# 0:     No adjustment (default)
# 1000:  Kill this process first when OOM occurs
```

The base OOM score is calculated as:

```
oom_score = (process_rss_pages * 1000) / total_ram_pages
            + oom_score_adj contribution
```

Factors that increase oom_score:
- Large RSS (proportional to physical memory consumed)
- Child processes with high memory usage
- OOM score adjustment set to positive values by the OOM killer heuristics

### OOM Killer Events

```bash
# Find recent OOM kills in kernel log
dmesg | grep -A 20 "Out of memory"
# Or from systemd journal
journalctl -k | grep -A 20 "Out of memory"

# Typical OOM kill message structure:
# [timestamp] Out of memory: Kill process 12345 (java) score 847 or sacrifice child
# [timestamp] Killed process 12345 (java) total-vm:16384000kB, anon-rss:8192000kB, file-rss:512kB, shmem-rss:0kB
```

### Protecting Critical Processes

```bash
# Protect a process from OOM kill (systemd services)
systemctl edit myservice
# Add:
# [Service]
# OOMScoreAdjust=-500

# Directly adjust for a running process
echo -500 > /proc/<PID>/oom_score_adj

# Never kill this process (use with extreme caution)
echo -1000 > /proc/<PID>/oom_score_adj
```

For containerized workloads, Kubernetes sets `oom_score_adj` based on QoS class:

```
Guaranteed QoS: oom_score_adj = -997 (rarely killed)
Burstable QoS:  oom_score_adj = 2 + (1000 * requests.memory / node_allocatable_memory)
BestEffort QoS: oom_score_adj = 1000 (killed first)
```

### Triggering OOM Behavior for Testing

```bash
# stress-ng: allocate memory until OOM
stress-ng --vm 1 --vm-bytes 90% --vm-method all --verify -v --timeout 60s

# Allocate a specific amount
stress-ng --vm 1 --vm-bytes 4G --timeout 30s

# Monitor OOM activity in real time
watch -n 1 'dmesg | tail -5'
```

## Huge Pages

Standard 4 KiB pages require large page tables for processes with multi-gigabyte address spaces. Each TLB entry covers only 4 KiB of address space, and TLB misses require expensive page table walks. Huge Pages (2 MiB on x86-64) reduce TLB pressure by covering 512x more address space per TLB entry.

### Types of Huge Pages

**Static Huge Pages (HugeTLB)**: Pre-allocated at boot or runtime from contiguous physical memory. Processes must explicitly request them via `mmap(MAP_HUGETLB)` or `shmget(SHM_HUGETLB)`.

**Transparent Huge Pages (THP)**: The kernel automatically promotes 4 KiB page groups to 2 MiB pages when possible. No application changes required, but can cause latency spikes from compaction.

### Static Huge Pages Configuration

```bash
# Check current huge page allocation
cat /proc/meminfo | grep -i hugepage

# HugePages_Total: 1024   # Total pre-allocated
# HugePages_Free:  512    # Available for use
# HugePages_Rsvd:  0      # Reserved but not mapped
# HugePages_Surp:  0      # Surplus (over reservation)
# Hugepagesize:    2048 kB
# Hugetlb:         2097152 kB

# Allocate huge pages at runtime
echo 1024 > /proc/sys/vm/nr_hugepages

# Persist across reboots
echo "vm.nr_hugepages = 1024" >> /etc/sysctl.conf
sysctl -p

# Allocate at boot (more reliable for large allocations - fragmentation is lower)
# Add to kernel command line:
# hugepages=1024 hugepagesz=2M
```

### NUMA-Aware Huge Page Allocation

On NUMA systems, allocate huge pages per-node to avoid cross-NUMA memory traffic:

```bash
# Check NUMA topology
numactl --hardware

# Allocate huge pages on specific NUMA nodes
echo 512 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 512 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# View per-node allocation
cat /sys/devices/system/node/node*/hugepages/hugepages-2048kB/nr_hugepages
```

### Using Huge Pages in Applications

```c
// C example: mmap with HugeTLB
#include <sys/mman.h>
#include <stdio.h>
#include <stdlib.h>

int main() {
    size_t size = 2 * 1024 * 1024; // 2 MiB (one huge page)

    void *ptr = mmap(NULL, size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                     -1, 0);

    if (ptr == MAP_FAILED) {
        perror("mmap hugepage failed");
        return 1;
    }

    // Use the memory
    memset(ptr, 0, size);
    printf("Huge page allocated at %p\n", ptr);

    munmap(ptr, size);
    return 0;
}
```

Go applications can use huge pages for memory-intensive data structures:

```go
package hugepages

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

const (
    MAP_HUGETLB = 0x40000  // Linux-specific flag
    HUGE_PAGE_SIZE = 2 * 1024 * 1024
)

// AllocHugePage allocates a 2 MiB huge page.
func AllocHugePage() ([]byte, error) {
    size := uintptr(HUGE_PAGE_SIZE)

    ptr, _, errno := syscall.Syscall6(
        syscall.SYS_MMAP,
        0,
        size,
        uintptr(syscall.PROT_READ|syscall.PROT_WRITE),
        uintptr(syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS|MAP_HUGETLB),
        ^uintptr(0), // fd = -1
        0,
    )
    if errno != 0 {
        return nil, fmt.Errorf("mmap hugepage: %w", os.NewSyscallError("mmap", errno))
    }

    buf := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), size)
    return buf, nil
}
```

### Transparent Huge Pages Tuning

THP is enabled by default but can cause latency spikes when the kernel collapses pages or moves memory (khugepaged daemon). For latency-sensitive workloads, tune THP behavior:

```bash
# Current THP mode
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# Options:
# always:   Always use THP where possible (default on most systems)
# madvise:  Only use THP for madvise(MADV_HUGEPAGE) regions
# never:    Disable THP completely

# For latency-sensitive databases (Redis, Cassandra), use madvise or never
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Control khugepaged aggressiveness
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 1000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Defrag setting: controls how aggressively kernel compacts memory for THP
cat /sys/kernel/mm/transparent_hugepage/defrag
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

Persist THP settings:

```bash
# /etc/rc.d/rc.local or systemd unit
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

## cgroup v2 Memory Control

cgroup v2 (the unified hierarchy) provides precise memory accounting and limits for containers and processes. Kubernetes 1.25+ uses cgroup v2 by default on supported kernel versions.

### cgroup v2 Memory Interface Files

```bash
# List cgroup hierarchy
ls /sys/fs/cgroup/

# Navigate to a container's cgroup
# (path depends on container runtime)
ls /sys/fs/cgroup/kubepods/burstable/pod<UID>/<container-ID>/

# Key memory control files:
# memory.current:      Current memory usage in bytes
# memory.high:         Memory throttling threshold (soft limit)
# memory.max:          Hard memory limit - kills processes above this
# memory.swap.max:     Maximum swap usage
# memory.min:          Guaranteed memory (kernel will not reclaim below this)
# memory.low:          Soft protection threshold
# memory.stat:         Detailed memory statistics
# memory.oom.group:    When set to 1, OOM kills all tasks in the cgroup
# memory.events:       Counter for memory events (oom, oom_kill, etc.)
```

### Memory Hierarchy and Protection

cgroup v2 has a hierarchical memory model:

```bash
# View memory stats for a cgroup
cat /sys/fs/cgroup/kubepods/burstable/pod<UID>/<container>/memory.stat

# Key fields:
# anon:          Anonymous (heap, stack) memory
# file:          Page cache and file-backed memory
# kernel:        Kernel data structures for this cgroup
# kernel_stack:  Kernel stack pages
# sock:          Network socket buffers
# slab:          Kernel slab allocator usage
# slab_reclaimable:  Reclaimable slab (dentries, inodes)
# pgfault:       Total page faults
# pgmajfault:    Major page faults (required disk I/O)
# workingset_refault_anon: Refaults of recently evicted anon pages
# workingset_refault_file: Refaults of recently evicted file pages

# Monitor memory pressure events
cat /sys/fs/cgroup/kubepods/.../memory.events
# low 0      - times memory was reclaimed below low boundary
# high 1234  - times memory was throttled at high limit
# max 5      - times memory hit max limit
# oom 0      - OOM events
# oom_kill 0 - Processes killed by OOM
```

### Setting Memory Limits Programmatically

```bash
# Create a new cgroup
mkdir /sys/fs/cgroup/myapp

# Set a 512 MiB memory limit
echo $((512 * 1024 * 1024)) > /sys/fs/cgroup/myapp/memory.max

# Set high watermark for throttling before hitting hard limit
echo $((400 * 1024 * 1024)) > /sys/fs/cgroup/myapp/memory.high

# Guarantee at least 128 MiB won't be reclaimed from this cgroup
echo $((128 * 1024 * 1024)) > /sys/fs/cgroup/myapp/memory.min

# Disable swap for this cgroup
echo 0 > /sys/fs/cgroup/myapp/memory.swap.max

# Move a process into the cgroup
echo <PID> > /sys/fs/cgroup/myapp/cgroup.procs
```

### Kubernetes Memory Management and cgroups

Kubernetes translates resource requests and limits into cgroup settings:

```yaml
# Pod spec with memory resources
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      resources:
        requests:
          memory: "256Mi"  # Maps to memory.min in cgroup v2
        limits:
          memory: "512Mi"  # Maps to memory.max in cgroup v2
```

The relationship:
- `limits.memory` → `memory.max` (hard limit, process killed if exceeded)
- `requests.memory` → `memory.min` (kernel protects this much from reclaim)
- `memory.high` is set to `memory.max` by default in containerd; can be tuned

```bash
# Find a pod's cgroup path
PODUID=$(kubectl get pod mypod -o jsonpath='{.metadata.uid}' | tr '-' '_')
find /sys/fs/cgroup -name "pod${PODUID}" 2>/dev/null

# Check actual memory limit applied
cat /sys/fs/cgroup/kubepods/.../pod${PODUID}/<container-id>/memory.max

# Watch memory usage in real time
while true; do
  cat /sys/fs/cgroup/kubepods/.../pod${PODUID}/<container-id>/memory.current
  sleep 1
done
```

## Memory Pressure and Reclaim

### Page Reclaim Mechanisms

Linux reclaims memory through several mechanisms:

1. **Page cache eviction**: Clean file-backed pages are dropped and re-read from disk on demand
2. **Swap**: Anonymous pages (heap, stack) are written to swap space and evicted
3. **OOM kill**: Last resort when reclaim cannot free enough memory

Reclaim is triggered by the watermark system:

```bash
# View memory watermarks
cat /proc/zoneinfo | grep -A 10 "Node 0, zone   Normal"

# min:   Free memory must stay above this (emergency reserve)
# low:   kswapd wakes up to reclaim when free falls below this
# high:  kswapd stops when free reaches this level

# Adjust watermark scale (higher = more aggressive reclaim)
cat /proc/sys/vm/watermark_scale_factor  # Default: 10 (out of 10000)
echo 200 > /proc/sys/vm/watermark_scale_factor  # More aggressive reclaim
```

### Swappiness Tuning

`vm.swappiness` controls the tendency to swap out anonymous memory vs evict page cache:

```bash
cat /proc/sys/vm/swappiness  # Default: 60 on servers, 100 on some distros

# Lower values prefer evicting page cache over swapping
# 0: Avoid swapping unless absolutely necessary
# 10: Swap very reluctantly (good for latency-sensitive workloads)
# 60: Default - balanced
# 100: Swap aggressively

# For database servers and latency-sensitive apps
sysctl -w vm.swappiness=10
# Or disable swap entirely for containers
sysctl -w vm.swappiness=0
```

### Detecting Memory Pressure

```bash
# PSI (Pressure Stall Information) - most accurate pressure signal
cat /proc/pressure/memory

# Output format:
# some avg10=0.00 avg60=0.25 avg300=0.10 total=12345678
# full avg10=0.00 avg60=0.05 avg300=0.02 total=987654

# "some": % of time at least one task stalled waiting for memory
# "full": % of time ALL tasks stalled waiting for memory

# Monitor in real time
watch -n 1 cat /proc/pressure/memory

# Per-cgroup PSI
cat /sys/fs/cgroup/kubepods/.../memory.pressure

# Set up PSI monitoring thresholds (kernel notifies via file descriptor)
# Used by systemd, earlyoom, and kubernetes memory pressure eviction
```

### Slab Cache Tuning

Kernel slab allocations for dentries and inodes can consume significant memory on systems with many files:

```bash
# View slab usage
slabtop -o | head -30

# View reclaimable slab
cat /proc/meminfo | grep SReclaimable

# Manually drop caches (careful in production - causes temporary I/O spike)
sync
echo 1 > /proc/sys/vm/drop_caches  # Drop page cache
echo 2 > /proc/sys/vm/drop_caches  # Drop slab cache (dentries/inodes)
echo 3 > /proc/sys/vm/drop_caches  # Drop both

# Tune dentry and inode cache aggressiveness
cat /proc/sys/vm/vfs_cache_pressure  # Default: 100
echo 50 > /proc/sys/vm/vfs_cache_pressure  # More memory for VFS caches
```

## NUMA Memory Management

On multi-socket servers, memory access latency depends on whether the memory is local (same NUMA node as the CPU) or remote. Non-local access can be 2-3x slower.

### NUMA Topology and Policy

```bash
# View NUMA topology
numactl --hardware
numastat

# Run a process with NUMA policy
numactl --cpunodebind=0 --membind=0 ./myapp  # Run on node 0, use local memory
numactl --interleave=all ./myapp             # Interleave memory across nodes

# Set NUMA policy for an existing process
taskset -c 0-15 <PID>  # Bind to CPUs 0-15

# Kernel NUMA balancing: automatically migrates pages to local node
cat /proc/sys/kernel/numa_balancing  # 1 = enabled
# Disable for workloads with frequent cross-NUMA migrations
echo 0 > /proc/sys/kernel/numa_balancing
```

### NUMA and Kubernetes

Kubernetes supports NUMA-aware scheduling via the Topology Manager:

```yaml
# kubelet configuration for NUMA-aware scheduling
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: "best-effort"  # none | best-effort | restricted | single-numa-node
topologyManagerScope: "pod"           # container | pod
cpuManagerPolicy: "static"
memoryManagerPolicy: "Static"
reservedMemory:
  - numaNode: 0
    limits:
      memory: "2Gi"
  - numaNode: 1
    limits:
      memory: "2Gi"
```

## Memory Diagnostics Toolkit

```bash
# System-wide memory snapshot
echo "=== Memory Overview ===" && free -h
echo "=== Detailed /proc/meminfo ===" && cat /proc/meminfo
echo "=== Huge Pages ===" && grep -i huge /proc/meminfo
echo "=== Slab Top 10 ===" && slabtop -o | head -15
echo "=== NUMA Stats ===" && numastat
echo "=== Memory PSI ===" && cat /proc/pressure/memory
echo "=== Swap Usage ===" && swapon --show

# Per-process memory summary
ps aux --sort=-%mem | head -20

# Detailed process memory breakdown
for pid in $(ps aux --sort=-%mem | awk 'NR>1 {print $2}' | head -5); do
  echo "PID $pid: $(cat /proc/$pid/comm 2>/dev/null)"
  cat /proc/$pid/smaps_rollup 2>/dev/null | grep -E "Rss|Pss|Private"
done

# Find memory leaks with valgrind
valgrind --leak-check=full --track-origins=yes ./myapp

# Profile memory allocations with perf
perf record -e kmem:mm_page_alloc -g ./myapp
perf report

# Monitor cgroup memory events
watch -n 1 "cat /sys/fs/cgroup/kubepods/burstable/pod*/*/memory.events 2>/dev/null | \
  awk '/oom|high/ {print}'"
```

## Production Recommendations

### For Kubernetes Cluster Nodes

```bash
# Recommended sysctl settings for Kubernetes nodes
cat >> /etc/sysctl.d/99-kubernetes-memory.conf << 'EOF'
# Reduce swappiness - containers should not swap
vm.swappiness = 0

# Aggressive reclaim watermarks to avoid OOM pressure
vm.watermark_scale_factor = 200

# Reduce VFS cache pressure slightly for containerized workloads
vm.vfs_cache_pressure = 50

# Allow overcommit for container workloads
vm.overcommit_memory = 1

# Tune min_free_kbytes based on system RAM
# Rule of thumb: 1% of total RAM, min 64MiB, max 512MiB
vm.min_free_kbytes = 131072
EOF

sysctl -p /etc/sysctl.d/99-kubernetes-memory.conf
```

### For Database Servers

```bash
cat >> /etc/sysctl.d/99-database-memory.conf << 'EOF'
# No swapping for database servers
vm.swappiness = 1

# Disable THP - causes latency spikes in Redis, Cassandra, PostgreSQL
# (set in /etc/rc.local or a systemd unit)
# echo never > /sys/kernel/mm/transparent_hugepage/enabled

# Large page cache for database files
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 500

# More conservative overcommit for databases
vm.overcommit_memory = 0
vm.overcommit_ratio = 70
EOF
```

### Alerting on Memory Issues

```bash
# Shell monitor script - alerts on approaching OOM conditions
#!/bin/bash
THRESHOLD=90  # Percent memory used

while true; do
  USED=$(awk '/MemAvailable/ {avail=$2} /MemTotal/ {total=$2} END {printf "%d", (total-avail)*100/total}' /proc/meminfo)

  if [ "$USED" -gt "$THRESHOLD" ]; then
    echo "WARNING: Memory usage at ${USED}% - approaching OOM pressure" >&2
    # Send to alerting system
  fi

  # Check OOM events
  if dmesg | grep -q "Out of memory" ; then
    echo "CRITICAL: OOM kill occurred" >&2
  fi

  sleep 30
done
```

## Summary

Linux memory management has multiple layers that engineers need to understand together:

- Virtual memory overcommit allows efficient memory use but requires understanding when the OOM killer will activate
- OOM score adjustments protect critical processes; in Kubernetes, QoS class determines these automatically
- Huge Pages reduce TLB pressure for memory-intensive workloads; THP provides this transparently but with latency risk
- cgroup v2 provides hierarchical memory accounting with `memory.max` (hard limit), `memory.high` (throttle), and `memory.min` (guarantee)
- PSI metrics provide accurate memory pressure signals for proactive action before OOM conditions develop
- NUMA topology awareness is critical on multi-socket servers to avoid remote memory latency

The most common production failure mode is not setting resource limits, causing a single runaway process to consume all available memory and trigger OOM kills across unrelated workloads. The second most common is over-relying on swap on latency-sensitive systems. Address both with appropriate cgroup limits and `vm.swappiness = 0` or `1` on containers and databases.
