---
title: "Linux Huge Pages and Transparent Huge Pages: Memory Management for Database and HPC Workloads"
date: 2031-09-04T00:00:00-05:00
draft: false
tags: ["Linux", "Huge Pages", "THP", "Memory Management", "Database", "HPC", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux huge pages and transparent huge pages (THP), covering TLB fundamentals, static vs THP configuration, NUMA topology, and production tuning for PostgreSQL, Redis, and HPC workloads."
more_link: "yes"
url: "/linux-huge-pages-transparent-huge-pages-database-hpc-workloads/"
---

Page table walk overhead is invisible at small scale and catastrophic at large scale. A PostgreSQL server with 256 GB of shared_buffers issues millions of TLB misses per second if mapped with 4 KB pages. The same workload mapped with 2 MB huge pages reduces TLB misses by 512x. This post explains the kernel mechanisms behind huge pages, shows how to configure them for production database and HPC workloads, and covers the THP pitfalls that silently degrade performance in containerized environments.

<!--more-->

# Linux Huge Pages and Transparent Huge Pages: Memory Management for Database and HPC Workloads

## TLB and Page Walk Fundamentals

The CPU's Translation Lookaside Buffer (TLB) caches virtual-to-physical address mappings. When a mapping is not in the TLB (a TLB miss), the CPU must walk the page table — a multi-level structure in main memory — to find the physical address. On x86-64, this is a 4-level or 5-level walk:

```
Virtual Address
      │
      ▼
┌─────────────┐
│  PGD (L4)   │  Page Global Directory entry
└──────┬──────┘
       │
┌──────▼──────┐
│  PUD (L3)   │  Page Upper Directory entry
└──────┬──────┘
       │
┌──────▼──────┐
│  PMD (L2)   │  Page Middle Directory entry
└──────┬──────┘
       │
┌──────▼──────┐
│  PTE (L1)   │  Page Table Entry → Physical Frame
└─────────────┘
```

With 4 KB pages, each PTE covers 4 KB of virtual address space. A 256 GB shared memory region needs:

```
256 GB / 4 KB = 67,108,864 PTE entries × 8 bytes = 512 MB of page table memory
```

With 2 MB huge pages (x86-64 standard), the PMD points directly to a 2 MB physical frame, bypassing the PTE level entirely:

```
256 GB / 2 MB = 131,072 PMD entries × 8 bytes = 1 MB of page table memory
TLB reach: 2 MB per entry vs 4 KB per entry = 512x improvement
```

1 GB huge pages (available on modern CPUs) skip both PMD and PTE:

```
256 GB / 1 GB = 256 PUD entries × 8 bytes = 2 KB of page table memory
```

## Checking Hardware and Kernel Support

```bash
# Check supported page sizes
cat /proc/cpuinfo | grep -oP 'pse|pdpe1gb' | sort -u
# pdpe1gb  (1GB pages supported)
# pse      (2MB pages supported)

# Check huge page availability
cat /proc/meminfo | grep -i huge
# AnonHugePages:     524288 kB    (THP used)
# ShmemHugePages:         0 kB
# HugePages_Total:      512
# HugePages_Free:       512
# HugePages_Rsvd:         0
# HugePages_Surp:         0
# Hugepagesize:        2048 kB    (2 MB)
# Hugetlb:         1048576 kB

# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
# node 0 size: 64447 MB
# node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node 1 size: 64508 MB

# Check TLB miss rates (requires perf)
perf stat -e dTLB-misses,dTLB-loads -p $(pgrep postgres | head -1) sleep 5
# Performance counter stats:
#    15,234,892,134  dTLB-misses
#   148,023,456,789  dTLB-loads
# dTLB miss rate: 10.3%  (> 1% is significant)
```

## Static Huge Pages (Explicit HugeTLB)

Static huge pages are pre-allocated at boot time and persist. Applications must explicitly request them via `mmap(MAP_HUGETLB)` or the `hugetlbfs` filesystem. This is the recommended approach for databases.

### Allocating Huge Pages

```bash
# /etc/sysctl.d/10-hugepages.conf

# Number of 2 MB huge pages to pre-allocate
# For PostgreSQL with shared_buffers = 200 GB:
# 200 GB / 2 MB = 102400 pages (add 5% buffer)
vm.nr_hugepages = 107520

# Enable NUMA-aware allocation (allocates on each node proportionally)
vm.nr_hugepages_mempolicy = 107520

# Allow overcommit of huge pages (for application tuning)
vm.hugetlb_shm_group = 999   # GID of postgres group
```

Apply immediately (before large chunks of memory become fragmented):

```bash
sysctl -w vm.nr_hugepages=107520

# Verify allocation succeeded
grep HugePages /proc/meminfo
# HugePages_Total:  107520
# HugePages_Free:   107520
# HugePages_Rsvd:       0

# If Total < requested, memory is fragmented — try:
echo 3 > /proc/sys/vm/drop_caches
echo 1 > /proc/sys/kernel/compact_memory
sysctl -w vm.nr_hugepages=107520
```

### Boot-Time Allocation (Most Reliable)

```
# /etc/default/grub
GRUB_CMDLINE_LINUX="default_hugepagesz=2M hugepages=107520 transparent_hugepage=never"

# For 1 GB pages (NUMA-aware):
GRUB_CMDLINE_LINUX="default_hugepagesz=1G hugepages=256 hugepagesz=2M hugepages=0 transparent_hugepage=never"
```

```bash
update-grub
reboot
```

### NUMA-Aware Allocation

On NUMA systems, allocate pages on each node explicitly:

```bash
# Allocate 53760 pages on node 0 and node 1 each (total = 107520)
echo 53760 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 53760 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Verify
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/free_hugepages
# 53760

# For 1 GB pages:
echo 128 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
echo 128 > /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages
```

## PostgreSQL Huge Page Configuration

PostgreSQL supports huge pages via the `huge_pages` parameter:

```ini
# postgresql.conf

# Shared buffers (must be allocated from huge pages)
shared_buffers = 200GB

# Enable huge pages
huge_pages = on        # on | off | try
                       # 'try' falls back to 4KB if huge pages unavailable

# Huge page size (requires PostgreSQL 15+)
# huge_page_size = 0   # 0 = use system default (usually 2 MB)
```

Verify PostgreSQL is using huge pages:

```bash
# Check /proc/PID/smaps for PostgreSQL's shared memory
PID=$(pgrep -ox postgres)
grep -A1 "^HugePages" /proc/${PID}/smaps | grep -v '^--$' | awk '/HugePages_Total/{sum+=$2} END{print sum}'
# 102400   (× 2 MB = 200 GB mapped as huge pages)

# Or check via pg_file_settings
psql -U postgres -c "SHOW huge_pages;"
#  huge_pages
# -----------
#  on
```

### Sizing Huge Page Allocation for PostgreSQL

```bash
# Calculate required pages
SHARED_BUFFERS_MB=204800   # 200 GB in MB
HUGE_PAGE_SIZE_MB=2
REQUIRED_PAGES=$((SHARED_BUFFERS_MB / HUGE_PAGE_SIZE_MB))
BUFFER=5120                # 5 GB buffer for other shared memory
TOTAL=$((REQUIRED_PAGES + BUFFER / 2))
echo "Set vm.nr_hugepages = $TOTAL"
# Set vm.nr_hugepages = 104960
```

## Oracle/Java Applications

```java
// JVM huge page flags
// -XX:+UseLargePages          -- Enable huge pages (transparent or explicit)
// -XX:+UseHugeTLBFS           -- Use hugetlbfs (Linux only, explicit huge pages)
// -XX:LargePageSizeInBytes=2m -- Explicit page size
// -XX:+UseTransparentHugePages -- Use THP

// Heap allocation with huge pages:
// java -Xmx200g -Xms200g -XX:+UseHugeTLBFS -XX:+UseLargePages MyApp
```

## Redis Huge Page Configuration

Redis benefits from huge pages for its memory-mapped data, but THP causes significant latency spikes during fork (for RDB/AOF persistence):

```bash
# redis.conf
# Redis documentation strongly recommends disabling THP
# Do this in the container entrypoint or systemd service:
```

```ini
# /etc/systemd/system/redis.service
[Service]
ExecStartPre=/bin/sh -c "echo never > /sys/kernel/mm/transparent_hugepage/enabled"
ExecStartPre=/bin/sh -c "echo never > /sys/kernel/mm/transparent_hugepage/defrag"
ExecStart=/usr/bin/redis-server /etc/redis/redis.conf
```

To use explicit huge pages with Redis:

```bash
# Mount hugetlbfs
mkdir -p /mnt/hugepages
mount -t hugetlbfs hugetlbfs /mnt/hugepages

# Configure Redis to use the hugetlbfs mount
# redis.conf:
# unixsocket /mnt/hugepages/redis.sock
```

## Transparent Huge Pages (THP)

THP automatically backs anonymous memory with 2 MB pages without application changes. The kernel promotions 4 KB PTE-backed regions to 2 MB PMD-backed regions when:

1. The region is at least 2 MB and aligned.
2. `transparent_hugepage` is `always` (promote any region) or `madvise` (only regions with `MADV_HUGEPAGE`).
3. The `khugepaged` daemon promotes the region asynchronously.

### THP Configuration Options

```bash
# Global setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# always: THP for all anonymous mappings (default on most distros)
# madvise: Only for madvise(MADV_HUGEPAGE) regions (recommended for mixed workloads)
# never:   Disable THP entirely (recommended for Redis, some databases)

echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Defrag: how aggressively to compact memory for THP promotion
cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# always: compact synchronously during allocation (causes latency spikes)
# defer:  compact asynchronously (recommended balance)
# madvise: compact only for madvised regions
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# khugepaged tuning
echo 1000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 500 > /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs
echo 4096 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
```

### THP and the Copy-on-Write Fork Problem

When Redis or PostgreSQL forks for background save/checkpoint, the kernel uses copy-on-write (CoW). With THP, a single dirty write to a 2 MB page causes the entire 2 MB page to be copied — not just the dirty 4 KB. For a database with 64 GB RAM, this means:

```
Without THP: CoW copies only dirty 4 KB pages
With THP: CoW copies 2 MB chunks = 512× more memory copied per dirty cacheline
Observed effect: fork latency 50ms → 5 seconds; memory usage doubles during checkpoint
```

This is why Redis documentation and most database operators recommend `THP=never` or `THP=madvise` with `MADV_NOHUGEPAGE` on the data region.

### Per-Process THP with madvise

```c
// Application code: opt specific regions into or out of THP
#include <sys/mman.h>

// Large read-only dataset: benefit from THP
madvise(data_ptr, data_size, MADV_HUGEPAGE);

// Frequently forked region (write-heavy): opt out
madvise(write_region, write_size, MADV_NOHUGEPAGE);
```

In Go:

```go
package memory

import (
	"syscall"
	"unsafe"
)

// AdviseTHP enables transparent huge pages for the given memory region.
// Requires: sysctl vm.transparent_hugepage = madvise
func AdviseTHP(ptr unsafe.Pointer, size uintptr) error {
	_, _, errno := syscall.Syscall(syscall.SYS_MADVISE,
		uintptr(ptr),
		size,
		uintptr(syscall.MADV_HUGEPAGE),
	)
	if errno != 0 {
		return errno
	}
	return nil
}

// AdviseNoTHP disables THP for regions sensitive to CoW latency.
func AdviseNoTHP(ptr unsafe.Pointer, size uintptr) error {
	const MADV_NOHUGEPAGE = 15
	_, _, errno := syscall.Syscall(syscall.SYS_MADVISE,
		uintptr(ptr),
		size,
		MADV_NOHUGEPAGE,
	)
	if errno != 0 {
		return errno
	}
	return nil
}
```

## HPC Workloads: 1 GB Pages

For memory-bandwidth-intensive HPC workloads (BLAS, FFT, molecular dynamics), 1 GB pages eliminate virtually all TLB misses:

```bash
# Boot-time: allocate 1 GB pages at startup (cannot be allocated after boot for most kernels)
GRUB_CMDLINE_LINUX="hugepagesz=1G hugepages=256 default_hugepagesz=1G"

# Verify
grep -i hugepages /proc/meminfo | grep 1048576
# HugePages_Total:     256
# HugePages_Free:      256
# Hugepagesize:    1048576 kB
```

OpenMPI configuration for 1 GB pages:

```bash
mpirun --mca btl_openib_eager_rdma_size 65536 \
       --mca opal_memory_use_btl_sm 0 \
       -x OMP_NUM_THREADS=4 \
       ./simulation --huge-pages=1g
```

## Kubernetes: Managing Huge Pages

Kubernetes supports huge pages as a schedulable resource since v1.14.

### Node Configuration

```bash
# On each node, pre-allocate huge pages:
echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# After node restart, kubelet reports:
kubectl describe node worker-01 | grep hugepages
# Capacity:
#   hugepages-2Mi: 1Gi
# Allocatable:
#   hugepages-2Mi: 1Gi
```

### Pod Resource Request

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-huge
  namespace: databases
spec:
  containers:
    - name: postgres
      image: postgres:16
      resources:
        requests:
          hugepages-2Mi: 200Gi    # Request 200 GB of 2 MB huge pages
          memory: 220Gi           # Must include huge pages + normal memory
          cpu: 16
        limits:
          hugepages-2Mi: 200Gi    # Limits must equal requests for hugepages
          memory: 220Gi
      env:
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
      volumeMounts:
        - name: hugepages
          mountPath: /dev/hugepages
        - name: data
          mountPath: /var/lib/postgresql/data
  volumes:
    - name: hugepages
      emptyDir:
        medium: HugePages-2Mi
    - name: data
      persistentVolumeClaim:
        claimName: postgres-data
```

PostgreSQL inside the container then uses:

```ini
# postgresql.conf
shared_buffers = 200GB
huge_pages = on
```

### THP in Kubernetes

```yaml
# DaemonSet to configure THP on all nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: thp-disable
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: thp-disable
  template:
    metadata:
      labels:
        app: thp-disable
    spec:
      tolerations:
        - operator: Exists
      hostPID: true
      containers:
        - name: thp-disable
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              echo never > /sys/kernel/mm/transparent_hugepage/enabled
              echo never > /sys/kernel/mm/transparent_hugepage/defrag
              while true; do
                sleep 3600
              done
          volumeMounts:
            - name: sys
              mountPath: /sys
      volumes:
        - name: sys
          hostPath:
            path: /sys
```

## Monitoring and Benchmarking

```bash
# Monitor THP usage over time
watch -n 5 "cat /proc/meminfo | grep -E 'AnonHugePages|HugePages|Hugepagesize'"

# TLB miss rate with perf
perf stat -e \
  dTLB-load-misses,dTLB-loads,\
  iTLB-load-misses,iTLB-loads \
  -p $(pgrep -o postgres) \
  sleep 10

# Huge page allocation failures (fragmentation)
cat /proc/vmstat | grep thp
# thp_fault_alloc 1234         -- THP allocated on page fault
# thp_fault_fallback 567       -- Fell back to 4KB (fragmentation)
# thp_collapse_alloc 890       -- khugepaged merged pages
# thp_split_page 12            -- THP split (CoW or memory pressure)

# fragmentation ratio (want thp_fault_fallback / thp_fault_alloc < 0.01)

# Benchmark: measure memory bandwidth with and without huge pages
# Install: apt-get install -y stream
numactl --cpunodebind=0 --membind=0 stream
# Function    Best Rate MB/s  Avg time     Min time     Max time
# Copy:          85234.7     0.019148     0.018774     0.019502
# Scale:         88192.3     0.018520     0.018138     0.018901
```

## Sysctl Reference for Production Deployment

```ini
# /etc/sysctl.d/10-hugepages.conf

# Static huge page count (set based on workload calculation)
vm.nr_hugepages = 107520

# Reserve huge pages for overcommit (set to 0 for strict allocation)
vm.hugetlb_shm_group = 999

# THP: madvise for mixed workloads (applications opt in explicitly)
# Set 'never' if all workloads are sensitive to CoW latency
# vm.transparent_hugepage = madvise  (cannot be set via sysctl — use /sys/kernel/mm)

# Compact memory when needed for THP (affects latency; defer is safer)
# vm.transparent_hugepage.defrag = defer  (cannot be set via sysctl)

# Page reclaim behavior
vm.swappiness = 1             # Avoid swap; Linux prefers to evict cache
vm.dirty_ratio = 10           # Max dirty pages before blocking writes
vm.dirty_background_ratio = 5 # Start background writeback at 5% dirty

# NUMA policy
kernel.numa_balancing = 0     # Disable for latency-sensitive: prevents page migration
```

## Summary

Huge pages provide measurable performance improvements for large-memory workloads:

1. **Static huge pages** are the recommended approach for databases: pre-allocate at boot, configure PostgreSQL with `huge_pages = on`, and monitor allocation with `/proc/meminfo`.
2. **1 GB pages** deliver near-zero TLB miss rates for HPC simulations and memory-bandwidth-bound workloads, but must be allocated at boot time before memory fragmentation occurs.
3. **THP must be disabled** (`never`) for Redis, or set to `madvise` with `MADV_NOHUGEPAGE` on write-heavy regions, to prevent CoW amplification during fork operations.
4. **Kubernetes** exposes huge pages as first-class resources: `hugepages-2Mi` and `hugepages-1Gi` can be requested and limited per pod, enabling colocation of workloads with and without huge pages on the same node.
5. **NUMA awareness** doubles the benefit on multi-socket systems: allocate huge pages proportionally per node and use `numactl` to bind processes to their local node's memory.

The 5–30% throughput improvement observed in production PostgreSQL and BLAS benchmarks consistently justifies the operational overhead of huge page configuration, making it a standard component of any performance-critical Linux deployment.
