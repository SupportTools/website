---
title: "Linux Huge Page Defragmentation: compaction, migration, and THP tuning"
date: 2029-10-13T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "Performance", "THP", "Huge Pages", "Kernel", "NUMA"]
categories:
- Linux
- Performance
- Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth guide to Linux huge page defragmentation covering memory compaction triggers, kcompactd, page migration, defrag=madvise tuning, NUMA and THP interaction, and production performance impact."
more_link: "yes"
url: "/linux-huge-page-defragmentation-compaction-thp-tuning/"
---

Transparent Huge Pages (THP) are a double-edged feature: they can dramatically improve TLB efficiency for memory-intensive workloads, but aggressive compaction to create contiguous physical memory causes latency spikes that are notoriously difficult to diagnose. The kernel's compaction and page migration subsystems are complex, and the interaction with NUMA topology adds another dimension. This guide provides the knowledge needed to tune THP behavior for production workloads.

<!--more-->

# Linux Huge Page Defragmentation: compaction, migration, and THP tuning

## Understanding the Problem

The x86-64 architecture supports 4 KB, 2 MB, and 1 GB page sizes. The default 4 KB pages require one TLB entry per 4 KB of virtual address space. For a process with 4 GB of mapped memory, that is 1 million TLB entries — far more than any TLB can hold, causing frequent TLB misses. A 2 MB huge page covers the same region with 512 TLB entries, dramatically reducing miss rates for large working sets.

THP attempts to automatically promote regular 4 KB page mappings to 2 MB huge pages by finding 512 contiguous 4 KB pages in physical memory. After a system runs for hours or days, physical memory becomes fragmented — contiguous regions become scarce, requiring the kernel to move pages around (compaction) to create the contiguous regions THP needs.

This compaction is what causes latency spikes. It involves:
1. Scanning memory zones for movable pages
2. Migrating (copying) page contents to new physical locations
3. Updating all page table entries that point to moved pages

## Section 1: THP Configuration Fundamentals

### /sys/kernel/mm/transparent_hugepage/

```bash
# Overall THP behavior
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# always  = THP for all anonymous mappings
# madvise = THP only for mappings with MADV_HUGEPAGE
# never   = THP disabled completely

# Defragmentation aggressiveness
cat /sys/kernel/mm/transparent_hugepage/defrag
# always defer defer+madvise [madvise] never

# Current allocation mode (what happens when THP allocation fails)
cat /sys/kernel/mm/transparent_hugepage/khugepaged/defrag
# 1 = enabled (background compaction)

# Page scan rate for khugepaged
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 4096

# Allocation delay after contiguous memory unavailable
cat /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs
# 60000 (60 seconds)

# Scan interval
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# 10000 (10 seconds)
```

### defrag= Option Deep Dive

The `defrag` option controls what happens when a THP allocation fails because no contiguous 2 MB region is available:

| Setting | Behavior | Latency Impact |
|---------|----------|----------------|
| `always` | Synchronously compact memory before returning failure; application blocks | Severe (milliseconds to seconds) |
| `defer` | Trigger background compaction; return smaller pages for now | Low |
| `defer+madvise` | Synchronous for MADV_HUGEPAGE regions, deferred for others | Medium for those regions |
| `madvise` | Synchronous only for MADV_HUGEPAGE regions | Moderate |
| `never` | No compaction triggered; never use THP | None |

For databases (PostgreSQL, MySQL, Redis):

```bash
# Recommended for database servers
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

For application servers with general memory usage:

```bash
# Low-latency general workloads
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag
```

For latency-critical services (high-frequency trading, real-time systems):

```bash
# Disable THP completely to eliminate compaction pauses
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

### Making Changes Persistent

```bash
# /etc/sysctl.d/99-thp.conf — does NOT work for THP (sysctl path doesn't exist)
# Use rc.local or a systemd service:

# /etc/rc.d/rc.local or /etc/rc.local
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/defrag
```

Or a systemd service unit:

```ini
# /etc/systemd/system/thp-config.service
[Unit]
Description=Configure Transparent Huge Pages
After=sysinit.target local-fs.target
Before=basic.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/bash -c 'echo defer > /sys/kernel/mm/transparent_hugepage/defrag'
ExecStart=/bin/bash -c 'echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

## Section 2: Memory Compaction Internals

### What Compaction Does

Memory compaction scans a zone for two types of pages:
- **Movable pages**: anonymous pages (process memory), file-backed pages that can be re-read
- **Unmovable pages**: kernel allocations, DMA-pinned pages, mlocked pages

Compaction moves movable pages to one end of the zone, creating a contiguous free region at the other end. This free region can then satisfy a 2 MB THP allocation.

### kcompactd — The Background Compaction Daemon

`kcompactd` is a per-NUMA-node kernel thread that performs background compaction proactively:

```bash
# See kcompactd threads
ps aux | grep kcompactd
# root  56  0.0  0.0  0  0  ?  S  Oct07  0:12 [kcompactd0]
# root  57  0.0  0.0  0  0  ?  S  Oct07  0:08 [kcompactd1]

# kcompactd is triggered by:
# 1. Watermark pressure (free pages below wmark_low)
# 2. khugepaged requesting compaction
# 3. Direct reclaim compaction requests
```

### Compaction Statistics

```bash
# Per-zone compaction statistics
cat /proc/vmstat | grep compact

# compact_migrate_scanned    12345678  # pages scanned for migration
# compact_free_scanned       45678901  # pages scanned as free
# compact_isolated           2345678   # pages isolated for migration
# compact_stall              1234      # direct compaction stalls (EXPENSIVE)
# compact_fail               890       # compaction failed to create huge page
# compact_success            4567      # compaction created a huge page
# compact_daemon_wake        23456     # kcompactd wakeups
# compact_daemon_migrate_scanned 123456789
# compact_daemon_free_scanned    456789012
```

```bash
# Monitor compaction stalls in real time (high compact_stall = latency risk)
watch -n 5 'cat /proc/vmstat | grep compact_stall'

# Stall rate
prev=$(awk '/compact_stall/ {print $2}' /proc/vmstat)
sleep 60
curr=$(awk '/compact_stall/ {print $2}' /proc/vmstat)
echo "Compaction stalls/min: $((curr - prev))"
```

### Compaction Triggering from User Space

```bash
# Force synchronous compaction on node 0
echo 1 > /proc/sys/vm/compact_memory

# This is useful:
# 1. After hugepages are enabled but before workload starts
# 2. After large memory allocation/deallocation cycles
# 3. As a scheduled maintenance operation during low-traffic windows
```

## Section 3: Page Migration

### Migration Types

Linux supports several types of page migration:

1. **NUMA migration**: Moving pages closer to the accessing CPU (NUMA balancing)
2. **Compaction migration**: Moving pages to create contiguous regions (THP)
3. **Memory hotplug migration**: Evacuating pages from memory being removed
4. **CMA migration**: Moving pages out of CMA (Contiguous Memory Allocator) regions

### NUMA Balancing Interaction with THP

NUMA balancing automatically migrates pages to the NUMA node where they are most accessed. When THP and NUMA balancing are both enabled, they can conflict:

- THP creates 2 MB pages on one NUMA node
- NUMA balancing detects cross-node access and tries to migrate the huge page
- Migrating a 2 MB huge page is significantly more expensive than a 4 KB page

```bash
# Check NUMA balancing status
cat /proc/sys/kernel/numa_balancing
# 1 = enabled

# Check if THP is causing cross-NUMA traffic
numastat -c
# Shows per-node allocation and migration statistics

# Detailed NUMA page migration stats
cat /proc/vmstat | grep numa
# numa_pte_updates         12345     # NUMA hint page faults
# numa_huge_pte_updates    890       # Huge page NUMA migrations
# numa_hint_faults         234567
# numa_pages_migrated      89012

# High numa_huge_pte_updates with latency = NUMA+THP conflict
```

### Controlling NUMA Balancing for THP Workloads

```bash
# Option 1: Disable NUMA balancing (use explicit NUMA binding instead)
echo 0 > /proc/sys/kernel/numa_balancing

# Option 2: Bind the workload to a specific NUMA node
numactl --cpunodebind=0 --membind=0 -- my-database-process

# Option 3: Use cgroups for NUMA memory policy
# (set cpuset.mems for a cgroup to a single node)
```

### Migration Failure Handling

```bash
# Check for page migration failures
cat /proc/vmstat | grep migrate

# pgmigrate_success   12345
# pgmigrate_fail      678     # ← investigate if high
# thp_migration_success  234
# thp_migration_fail     12   # THP migration failures (page split as fallback)
```

## Section 4: Production Monitoring

### THP Statistics

```bash
# Current THP usage
cat /proc/meminfo | grep -i huge
# AnonHugePages:   2097152 kB   ← Currently mapped THP (2GB in huge pages)
# ShmemHugePages:        0 kB
# ShmemPmdMapped:        0 kB
# FileHugePages:         0 kB
# FilePmdMapped:         0 kB
# HugePages_Total:       0      ← Explicit huge pages (not THP)
# HugePages_Free:        0
# HugePages_Rsvd:        0
# HugePages_Surp:        0
# Hugepagesize:       2048 kB
# Hugetlb:               0 kB

# THP allocation and promotion statistics
cat /proc/vmstat | grep thp
# thp_fault_alloc          12345    # THP allocated on page fault
# thp_fault_fallback       890      # THP failed, fell back to 4KB
# thp_fault_fallback_charge 45      # Same with charge failure
# thp_collapse_alloc       2345     # khugepaged collapsed to THP
# thp_collapse_alloc_failed 123     # khugepaged collapse failed
# thp_split_page           456      # THP split back to 4KB
# thp_split_page_failed    12       # Split failed
# thp_zero_page_alloc      789      # Zero-page huge page allocated
# thp_deferred_split_page  234      # Deferred THP split
```

### Key Metrics to Alert On

```bash
#!/bin/bash
# thp-health-check.sh

echo "=== THP Health Report ==="
echo ""

# Compaction stall rate
STALLS=$(awk '/compact_stall/ {print $2}' /proc/vmstat)
echo "Compaction stalls total: $STALLS"
echo "(High values indicate THP is causing application latency)"

# THP fallback rate
ALLOC=$(awk '/thp_fault_alloc/ {print $2}' /proc/vmstat)
FALLBACK=$(awk '/thp_fault_fallback/ {print $2}' /proc/vmstat)
if [ $((ALLOC + FALLBACK)) -gt 0 ]; then
    RATE=$(awk "BEGIN {printf \"%.1f\", ($FALLBACK / ($ALLOC + $FALLBACK)) * 100}")
    echo "THP fallback rate: ${RATE}%"
    echo "(High fallback rate = fragmented memory; consider compaction)"
fi

# Current THP usage
THP_KB=$(awk '/AnonHugePages/ {print $2}' /proc/meminfo)
THP_GB=$(awk "BEGIN {printf \"%.1f\", $THP_KB / 1024 / 1024}")
echo "AnonHugePages: ${THP_GB} GB"

# Huge page splits (fragmentation indicator)
SPLITS=$(awk '/thp_split_page/ {print $2}' /proc/vmstat)
echo "THP splits total: $SPLITS"
echo "(High splits = memory fragmentation or incompatible code accessing huge pages)"

echo ""
echo "Current THP settings:"
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag
```

### Prometheus Node Exporter Metrics

```promql
# Compaction stall rate (per minute)
rate(node_vmstat_compact_stall[5m]) * 60

# THP fallback ratio
rate(node_vmstat_thp_fault_fallback[5m]) /
  (rate(node_vmstat_thp_fault_alloc[5m]) + rate(node_vmstat_thp_fault_fallback[5m]))

# AnonHugePages in bytes
node_memory_AnonHugePages_bytes

# THP split rate
rate(node_vmstat_thp_split_page[5m])
```

### Identifying THP Latency Spikes with perf

```bash
# Record memory latency events during suspected THP compaction
perf record -e kmem:mm_compaction_begin,kmem:mm_compaction_end \
  -a -g -- sleep 60

perf report

# Or use bpftrace to measure compaction duration
bpftrace -e '
tracepoint:compaction:mm_compaction_begin { @start[tid] = nsecs; }
tracepoint:compaction:mm_compaction_end {
  if (@start[tid]) {
    $duration = (nsecs - @start[tid]) / 1000000;
    if ($duration > 100) {
      printf("Compaction took %d ms on CPU %d\n", $duration, cpu);
    }
    @durations = hist($duration);
    delete(@start[tid]);
  }
}
END { print @durations; }
'
```

## Section 5: NUMA and THP Interaction

### NUMA Topology Discovery

```bash
# View NUMA topology
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7
# node 0 size: 32768 MB
# node 0 free: 8192 MB
# node 1 cpus: 8 9 10 11 12 13 14 15
# node 1 size: 32768 MB
# node 1 free: 7456 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
# (21 = 2.1x latency for cross-NUMA access)

# Per-node memory statistics including THP
cat /sys/devices/system/node/node0/meminfo | grep -i huge
cat /sys/devices/system/node/node1/meminfo | grep -i huge
```

### Per-NUMA THP Allocation Statistics

```bash
# Check huge page availability per NUMA node
for node in /sys/devices/system/node/node*/; do
    echo "Node: $(basename $node)"
    cat ${node}meminfo | grep -E "AnonHugePages|MemFree|MemTotal"
    echo "---"
done
```

### THP with NUMA Interleaving

For workloads that access memory from multiple NUMA nodes evenly, interleaved allocation reduces worst-case latency:

```bash
# Run process with interleaved NUMA memory allocation
numactl --interleave=all -- my-process

# For databases, local allocation is usually better
numactl --localalloc -- postgres

# For workloads with symmetric access patterns
numactl --interleave=0,1 -- my-symmetric-app
```

## Section 6: Application-Specific Recommendations

### PostgreSQL

```bash
# PostgreSQL's shared_buffers uses shared memory
# THP with shared memory works differently than anonymous memory

# Recommended: disable THP entirely for PostgreSQL
# PostgreSQL has its own buffer management and THP's auto-promotion
# causes compaction stalls during peak query load

echo never > /sys/kernel/mm/transparent_hugepage/enabled

# If huge pages are desired, use explicit huge pages (not THP)
# In postgresql.conf:
# huge_pages = on
# (requires pre-allocated huge pages in /proc/sys/vm/nr_hugepages)
sysctl -w vm.nr_hugepages=1000
```

### Java Applications

```bash
# Java with G1GC can benefit from THP for the heap
# But compaction pauses can cause GC jitter

# Recommended: madvise so app can opt in per allocation
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# In JVM startup, use MADV_HUGEPAGE for heap:
# -XX:+UseTransparentHugePages  (OpenJDK flag)
```

### Redis

```bash
# Redis is extremely sensitive to latency spikes from THP compaction
# Redis explicitly warns about THP in startup logs

# Disable THP for Redis servers
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# Or configure at the process level using cgroups
# (if other workloads on the same host benefit from THP)
```

### Kubernetes / Container Environments

```bash
# THP settings apply to the entire host, not per-container
# To disable THP for a specific container:

# Option 1: DaemonSet to configure host
# (already runs on host network/pid namespace)

# Option 2: Init container that writes to /sys (requires privileged)
initContainers:
  - name: thp-disable
    image: busybox
    command:
      - /bin/sh
      - -c
      - echo never > /sys/kernel/mm/transparent_hugepage/enabled
    securityContext:
      privileged: true
    volumeMounts:
      - name: sys
        mountPath: /sys
volumes:
  - name: sys
    hostPath:
      path: /sys
```

## Section 7: Compaction Tuning Parameters

```bash
# /proc/sys/vm/compaction_proactiveness (0-100, default 20)
# Higher value = more aggressive background compaction
# 0 = disable proactive compaction
# Set to 0 for latency-sensitive workloads
sysctl -w vm.compaction_proactiveness=0

# /proc/sys/vm/extfrag_threshold (0-1000, default 500)
# Threshold of external fragmentation that triggers compaction
# Higher = less frequent compaction (more tolerant of fragmentation)
sysctl -w vm.extfrag_threshold=750

# /proc/sys/vm/min_free_kbytes
# Minimum free memory; compaction runs more to maintain this
# Setting too high causes excessive compaction
sysctl vm.min_free_kbytes

# /proc/sys/vm/watermark_scale_factor (default 10)
# Controls gap between memory watermarks
# Larger gap = more breathing room before compaction
sysctl -w vm.watermark_scale_factor=200
```

## Conclusion

THP tuning is an exercise in trade-offs between TLB efficiency and latency predictability. The `defrag=madvise` setting combined with `enabled=madvise` provides the most control: applications that benefit from huge pages (and can tolerate minor allocation delays) opt in with `madvise(MADV_HUGEPAGE)`, while latency-sensitive paths use normal 4 KB pages. Monitoring `compact_stall` via `/proc/vmstat` and `thp_fault_fallback` gives early warning of fragmentation building up. On NUMA systems, binding workloads to specific nodes reduces THP migration overhead. For the most latency-critical workloads — Redis, high-frequency trading, real-time audio/video processing — disabling THP entirely eliminates compaction pauses at the cost of higher TLB miss rates, a trade-off that only benchmarking against your specific workload can fully evaluate.
