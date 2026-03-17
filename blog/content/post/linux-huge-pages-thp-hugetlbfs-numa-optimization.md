---
title: "Linux Huge Pages: Transparent Huge Pages, HugeTLBFS, and NUMA Optimization"
date: 2030-03-11T00:00:00-05:00
draft: false
tags: ["Linux", "Huge Pages", "THP", "NUMA", "Performance", "Memory", "Databases"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to THP vs explicit hugepages for databases and JVMs, HugeTLBFS configuration, NUMA-aware huge page allocation, performance impact measurement, and disabling THP for latency-sensitive workloads."
more_link: "yes"
url: "/linux-huge-pages-thp-hugetlbfs-numa-optimization/"
---

Huge pages reduce TLB pressure — a critical factor in workloads with large memory footprints. Instead of mapping memory in 4KB pages (requiring one TLB entry per 4KB), huge pages map 2MB or 1GB at a time, reducing TLB misses dramatically for applications that access large data sets. The Linux kernel provides two mechanisms for huge pages: Transparent Huge Pages (THP), which works automatically, and explicit HugeTLBFS pages, which require manual configuration but offer predictable performance. Understanding which mechanism to use, and when THP actually hurts latency-sensitive workloads, is essential for production database and JVM tuning.

<!--more-->

## TLB Architecture and Huge Page Benefits

The Translation Lookaside Buffer (TLB) is a hardware cache that stores recent virtual-to-physical address translations. It has a small, fixed number of entries (typically 64-1024 per CPU core). When a translation is not in the TLB (a "TLB miss"), the CPU must walk the page table in memory — adding 50-200ns of latency per access.

### Why Huge Pages Matter

With 4KB base pages:
- A process using 8GB of memory requires 2 million page table entries
- With a TLB of 1024 entries, only 4MB of working set fits in the TLB at once
- Any access outside that 4MB causes a TLB miss

With 2MB huge pages:
- The same 8GB requires only 4096 page table entries
- A TLB of 1024 entries covers 2GB of working set
- TLB miss rate decreases dramatically for large data structures

```bash
# Check TLB capacity on your system
cpuid -l 0x02 2>/dev/null || lscpu | grep -i tlb

# View TLB miss counters using perf
perf stat -e \
    dTLB-loads,dTLB-load-misses,\
    iTLB-loads,iTLB-load-misses \
    -- your-process

# dTLB-load-misses / dTLB-loads > 5% indicates TLB pressure
# that huge pages can help

# Check page table walk cost
perf stat -e \
    page-faults,\
    minor-faults,\
    major-faults \
    -- your-process
```

## Transparent Huge Pages (THP)

THP is the kernel feature that automatically promotes groups of contiguous 4KB pages to 2MB huge pages at runtime, without requiring application changes.

### THP Modes

```bash
# View current THP configuration
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# (brackets indicate the current setting)

# THP modes:
# always  - Aggressively use huge pages for all anonymous memory
# madvise - Only use huge pages when process calls madvise(MADV_HUGEPAGE)
# never   - Disable THP completely

# View defrag configuration
cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# defrag modes:
# always       - Synchronously defrag/compact memory to form huge pages
# defer        - Asynchronously defer defrag (good balance for most workloads)
# defer+madvise - Defer except for madvised regions
# madvise      - Only defrag for madvised regions
# never        - Never defrag for THP

# Scan interval for khugepaged (pages to check per scan)
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 4096

# Max pages per scan (tune for your workload)
echo 64 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
```

### When THP Hurts: The Latency Problem

THP's main drawback is that page promotion and defragmentation happen at unpredictable times, causing latency spikes:

1. **Allocation stalls**: When `defrag=always`, allocating memory can stall for tens of milliseconds while the kernel compacts memory to form a contiguous 2MB region
2. **khugepaged CPU usage**: The kernel daemon `khugepaged` periodically scans memory and promotes pages, consuming CPU
3. **THP split overhead**: When a process calls `mprotect()` or other operations that require 4KB granularity, huge pages must be split back into base pages
4. **Fork/copy-on-write amplification**: Forking a process with huge pages copies 2MB at a time on the first write, vs 4KB with base pages

```bash
# Check for THP allocation stalls
grep -i "thp_fault_alloc\|thp_collapse_alloc\|thp_split_page\|thp_deferred_split" \
    /proc/vmstat

# Watch THP activity in real time
watch -n1 "grep -E 'thp_' /proc/vmstat"

# Key counters:
# thp_fault_alloc        - Huge pages allocated on fault (desired)
# thp_collapse_alloc     - Huge pages from khugepaged promotion
# thp_split_page         - Huge pages split back to 4K (can cause stalls)
# thp_deferred_split_page - Pages queued for deferred splitting

# Measure THP allocation latency with ftrace
echo 0 > /sys/kernel/debug/tracing/tracing_on
echo "khugepaged" > /sys/kernel/debug/tracing/set_ftrace_pid
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 5
cat /sys/kernel/debug/tracing/trace | grep -E "collapse_huge_page" | head -20
```

### Disabling THP for Latency-Sensitive Workloads

Redis, Cassandra, MongoDB, and many other databases explicitly recommend disabling THP:

```bash
# Disable THP immediately (until reboot)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persistent disable via /etc/rc.local or systemd service
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=mysqld.service redis.service cassandra.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now disable-thp

# Verify
cat /sys/kernel/mm/transparent_hugepage/enabled
# always madvise [never]
```

### Per-Process THP Control with madvise

For workloads that benefit from huge pages only in specific regions:

```c
#include <sys/mman.h>
#include <stdlib.h>
#include <stdio.h>

int main() {
    size_t size = 2UL * 1024 * 1024 * 1024; // 2GB

    // Allocate a large buffer
    void *buf = mmap(NULL, size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    if (buf == MAP_FAILED) {
        perror("mmap");
        return 1;
    }

    // Request huge pages for this specific region
    // Requires THP mode = madvise or always
    if (madvise(buf, size, MADV_HUGEPAGE) != 0) {
        perror("madvise HUGEPAGE");
        // Non-fatal: falls back to 4KB pages
    }

    // For regions where you DON'T want huge pages (e.g., hot metadata)
    // Use MADV_NOHUGEPAGE for small frequently-split regions
    void *metadata = mmap(NULL, 4096 * 1000, PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    madvise(metadata, 4096 * 1000, MADV_NOHUGEPAGE);

    // Use the buffers...
    return 0;
}
```

```bash
# Check if a process is using huge pages
cat /proc/$(pgrep myprocess)/smaps | grep -i "hugepages\|AnonHugePages"
# AnonHugePages:   2097152 kB   (2GB of huge pages)

# Or use smaps_rollup for summary
cat /proc/$(pgrep myprocess)/smaps_rollup | grep -i Huge
```

## HugeTLBFS: Explicit Huge Pages

HugeTLBFS (also called "static huge pages" or "preallocated huge pages") reserves huge pages at boot or runtime, guaranteeing they are available. Unlike THP, there is no promotion latency — the pages are pre-allocated.

### Configuration

```bash
# View current hugepage configuration
cat /proc/meminfo | grep -i huge
# AnonHugePages:         0 kB   (THP-backed)
# ShmemHugePages:        0 kB
# ShmemPmdMapped:        0 kB
# FileHugePages:         0 kB
# FilePmdMapped:         0 kB
# HugePages_Total:    1024       (preallocated)
# HugePages_Free:      512       (available)
# HugePages_Rsvd:      100       (reserved by processes, not yet used)
# HugePages_Surp:        0       (surplus pages beyond configured count)
# Hugepagesize:       2048 kB    (2MB per page)
# Hugetlb:         2097152 kB   (total HugeTLBFS memory)

# Set the number of 2MB huge pages
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Or via sysctl
sysctl -w vm.nr_hugepages=1024

# Persistent configuration via /etc/sysctl.d/
cat > /etc/sysctl.d/90-hugepages.conf << 'EOF'
# Pre-allocate 16GB of huge pages (8192 x 2MB)
vm.nr_hugepages = 8192

# Allow overcommitting huge pages
vm.nr_overcommit_hugepages = 1024

# 1GB huge pages (if supported by CPU)
# Check: grep pdpe1gb /proc/cpuinfo
vm.nr_hugepages_1gb = 4
EOF
sysctl -p /etc/sysctl.d/90-hugepages.conf

# Check available 1GB huge pages
ls /sys/kernel/mm/hugepages/
# hugepages-1048576kB   (1GB)
# hugepages-2048kB      (2MB)

echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

### Configuring the HugeTLBFS Mount

Applications access huge pages through a special filesystem mount:

```bash
# Mount HugeTLBFS
mkdir -p /mnt/hugepages
mount -t hugetlbfs \
    -o uid=1000,gid=1000,mode=1770,pagesize=2M \
    nodev /mnt/hugepages

# For 1GB pages
mkdir -p /mnt/hugepages-1g
mount -t hugetlbfs \
    -o pagesize=1G \
    nodev /mnt/hugepages-1g

# Make persistent in /etc/fstab
echo "nodev /mnt/hugepages hugetlbfs pagesize=2M,uid=1000,gid=1000,mode=1770 0 0" \
    >> /etc/fstab

# Verify
mount | grep huge
ls -la /mnt/hugepages/
```

### PostgreSQL with Huge Pages

PostgreSQL has native huge pages support for its shared memory:

```bash
# In postgresql.conf
# huge_pages = on      (requires, fail if unavailable)
# huge_pages = try     (use if available, fall back to regular pages)
# huge_pages = off     (disable)
# huge_page_size = 0   (0 = use system default)

# Calculate required huge pages for PostgreSQL
# shared_buffers = 32GB
# huge pages needed = ceil(32 * 1024 * 1024 / 2048) = 16384 pages

# Calculate from actual PostgreSQL shared memory
cat /proc/$(pgrep -x postgres | head -1)/smaps | \
    grep -A 5 "SHM" | grep KernelPageSize

# Check if PostgreSQL is actually using huge pages
cat /proc/$(pgrep -x postgres | head -1)/smaps | grep -i HugePages
# Note: "Huge" in smaps means the page is actually backed by a huge page

# Monitor huge page usage
cat /proc/meminfo | grep Huge
# HugePages_Total: 16384
# HugePages_Free:    384  (16000 in use by PostgreSQL)
```

### Oracle/Java JVM with Huge Pages

```bash
# JVM huge pages via madvise (THP=madvise mode)
java -XX:+UseTransparentHugePages \
     -Xms8g -Xmx8g \
     -XX:+UseG1GC \
     YourApp

# JVM explicit huge pages
java -XX:+UseLargePages \
     -XX:LargePageSizeInBytes=2m \
     -Xms8g -Xmx8g \
     YourApp

# JVM with HugeTLBFS
# Requires ulimit -l unlimited for the JVM user
# Or configure /etc/security/limits.conf:
# @jvm-users soft memlock unlimited
# @jvm-users hard memlock unlimited

# Verify JVM is using huge pages
jcmd <pid> VM.native_memory detail | grep -i huge
```

## NUMA-Aware Huge Page Allocation

On multi-socket systems, huge pages must be allocated on the correct NUMA node to avoid remote memory access penalties (50-100% latency increase for remote NUMA access).

### NUMA Architecture Overview

```bash
# View NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 32768 MB
# node 0 free: 28124 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 32768 MB
# node 1 free: 27890 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Check NUMA memory stats
numastat
# node            node0   node1
# numa_hit        1234567 987654
# numa_miss             0     12  (remote allocations)
# numa_foreign          0      0
# local_node      1234567 987654
# other_node            0     12

# Monitor NUMA misses in real time
watch -n2 numastat
```

### Per-NUMA-Node Huge Page Allocation

```bash
# Allocate huge pages on specific NUMA nodes
# View current per-node allocation
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Allocate 8192 pages on node 0 (for processes that run on node 0 CPUs)
echo 8192 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 8192 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Script to allocate huge pages proportionally across NUMA nodes
#!/bin/bash
TOTAL_PAGES=16384
NUMA_NODES=$(ls /sys/devices/system/node/ | grep -c "^node[0-9]")
PAGES_PER_NODE=$((TOTAL_PAGES / NUMA_NODES))

for node in /sys/devices/system/node/node*/hugepages/hugepages-2048kB/; do
    echo "Allocating ${PAGES_PER_NODE} pages on $(dirname $node | xargs basename)"
    echo ${PAGES_PER_NODE} > "${node}nr_hugepages"
done

# Verify allocation across nodes
for node in /sys/devices/system/node/node*/hugepages/hugepages-2048kB/; do
    echo "$(dirname $node | xargs basename): $(cat ${node}nr_hugepages) pages"
done
```

### Running Applications with NUMA-Aware Huge Pages

```bash
# Bind a process to NUMA node 0 (CPUs and memory)
numactl --cpunodebind=0 --membind=0 \
    -- java -XX:+UseLargePages -Xms16g -Xmx16g YourApp

# For PostgreSQL on NUMA systems
# In postgresql.conf, add:
# huge_pages = on
# Then start with numactl:
numactl --cpunodebind=0,1 --interleave=0,1 \
    -- /usr/lib/postgresql/15/bin/postgres -D /var/lib/postgresql/15/main

# Memory interleaving for applications that span NUMA nodes
numactl --interleave=all -- your-multithreaded-app

# Check actual memory placement of a running process
numastat -p $(pgrep myapp)
# Per-node memory breakdown
```

### NUMA-Aware HugeTLBFS Mounts

```bash
# Mount HugeTLBFS specifically for NUMA node 0
mkdir -p /mnt/hugepages-node0
mount -t hugetlbfs \
    -o pagesize=2M,size=16G \
    nodev /mnt/hugepages-node0

# Applications can use mbind() to bind their huge page allocations
# to a specific NUMA node
# (requires numactl library or direct mbind() syscall)
```

## Measuring Performance Impact

### Before/After Comparison

```bash
#!/bin/bash
# hugepage-benchmark.sh - Compare performance with/without huge pages

echo "=== Baseline: No Huge Pages ==="
echo never > /sys/kernel/mm/transparent_hugepage/enabled

perf stat -e \
    cycles,instructions,\
    dTLB-loads,dTLB-load-misses,\
    cache-references,cache-misses \
    -- /usr/bin/time -v your-benchmark 2>&1 | \
    grep -E "cycles|instructions|dTLB|cache|Maximum resident|Elapsed"

echo ""
echo "=== With Transparent Huge Pages ==="
echo always > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# Warm up to allow THP promotion
./your-benchmark --warmup 2>/dev/null

perf stat -e \
    cycles,instructions,\
    dTLB-loads,dTLB-load-misses,\
    cache-references,cache-misses \
    -- /usr/bin/time -v your-benchmark 2>&1 | \
    grep -E "cycles|instructions|dTLB|cache|Maximum resident|Elapsed"

echo ""
echo "=== With Explicit Huge Pages (HugeTLBFS) ==="
# Run with pre-allocated HugeTLB pages
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo 8192 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

perf stat -e \
    cycles,instructions,\
    dTLB-loads,dTLB-load-misses,\
    cache-references,cache-misses \
    -- /usr/bin/time -v your-benchmark --hugepages 2>&1 | \
    grep -E "cycles|instructions|dTLB|cache|Maximum resident|Elapsed"
```

### Monitoring Huge Page Utilization

```bash
#!/bin/bash
# hugepage-monitor.sh - Continuous monitoring of huge page usage

while true; do
    TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)

    # Overall stats
    TOTAL=$(grep "HugePages_Total" /proc/meminfo | awk '{print $2}')
    FREE=$(grep "HugePages_Free" /proc/meminfo | awk '{print $2}')
    RSVD=$(grep "HugePages_Rsvd" /proc/meminfo | awk '{print $2}')
    USED=$((TOTAL - FREE))
    USED_MB=$((USED * 2))  # 2MB per page

    # THP activity
    THP_ALLOC=$(grep "thp_fault_alloc" /proc/vmstat | awk '{print $2}')
    THP_SPLIT=$(grep "thp_split_page " /proc/vmstat | awk '{print $2}')

    echo "${TIMESTAMP}: HugeTLB: ${USED}/${TOTAL} pages (${USED_MB}MB used), THP_alloc=${THP_ALLOC}, THP_split=${THP_SPLIT}"

    sleep 60
done | tee -a /var/log/hugepage-monitor.log
```

### PostgreSQL Query Performance with Huge Pages

```sql
-- PostgreSQL: measure shared_buffers hit rate before and after huge pages
-- Run this query to check buffer cache effectiveness

SELECT
    sum(heap_blks_read)  AS heap_read,
    sum(heap_blks_hit)   AS heap_hit,
    sum(heap_blks_hit) * 100.0 /
        NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0) AS cache_hit_ratio
FROM pg_statio_user_tables;

-- Check for TLB-related wait events (visible in pg_stat_activity)
SELECT
    wait_event_type,
    wait_event,
    count(*) AS count
FROM pg_stat_activity
WHERE state != 'idle'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

## Production Configuration Examples

### Redis Huge Pages Configuration

Redis documentation explicitly recommends disabling THP:

```bash
# /etc/sysctl.d/99-redis.conf
vm.overcommit_memory = 1
vm.swappiness = 1
net.core.somaxconn = 65535

# Disable THP - critical for Redis latency consistency
# kernel.mm.transparent_hugepage.enabled = never  # Not available as sysctl
# Use rc.local or systemd instead

# In /etc/rc.local:
# echo never > /sys/kernel/mm/transparent_hugepage/enabled
# echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

### Cassandra with Huge Pages

```bash
# Cassandra JVM configuration (jvm-server.options)
# Use THP with madvise (Cassandra manages its own memory carefully)
# -XX:+UseTransparentHugePages

# Or use explicit huge pages for Cassandra's off-heap storage
# The cassandra user needs memlock capability:
# /etc/security/limits.d/cassandra.conf:
# cassandra soft memlock unlimited
# cassandra hard memlock unlimited

# In cassandra-env.sh:
# JVM_OPTS="$JVM_OPTS -XX:+UseLargePages"
```

### Linux Kernel Huge Pages Boot Parameters

```bash
# /etc/default/grub GRUB_CMDLINE_LINUX additions:

# Pre-allocate 8GB of 2MB huge pages at boot
# (more reliable than runtime allocation due to fragmentation)
# hugepages=4096

# Enable 1GB huge pages (requires hardware support)
# hugepagesz=1G hugepages=8

# For NUMA systems, allocate on specific nodes:
# numa_hugepages_node=0:4096,1:4096

# Full example:
# GRUB_CMDLINE_LINUX="... hugepages=8192 hugepagesz=2M transparent_hugepage=never"

# Apply
update-grub  # Debian/Ubuntu
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL/CentOS
```

## Decision Framework: THP vs HugeTLBFS vs Neither

```
Workload Type              | Recommendation
---------------------------|--------------------------------------------------
Latency-sensitive (Redis)  | THP=never, HugeTLBFS=none (avoid both)
Streaming analytics        | THP=madvise or always (data locality benefits)
PostgreSQL (large buffers) | HugeTLBFS for shared_buffers, THP=madvise
Java/JVM applications      | THP=madvise + -XX:+UseTransparentHugePages
ML model inference         | HugeTLBFS for model weights, THP=madvise elsewhere
General OLTP database      | HugeTLBFS with NUMA-aware allocation
Batch processing           | THP=always (promotes amortize over long runs)
Container workloads        | THP=madvise at host; containers opt-in via madvise()
```

## Key Takeaways

Huge page configuration is one of the highest-impact Linux memory tuning knobs available, but must be applied with understanding of the specific workload's characteristics:

1. THP with `defrag=always` causes latency spikes during memory compaction — use `defrag=defer` or `defrag=madvise` instead; never use `defrag=always` for latency-sensitive services
2. Redis, Cassandra, and MongoDB explicitly recommend disabling THP (`enabled=never`) because their internal memory management conflicts with THP's compaction and splitting behavior
3. For PostgreSQL, set `huge_pages=on` in postgresql.conf and pre-allocate enough HugeTLBFS pages at boot for the entire `shared_buffers` value — allocation at startup is more reliable than runtime promotion
4. On NUMA systems, allocate huge pages per-node using `/sys/devices/system/node/nodeN/hugepages/` to prevent remote NUMA access; use `numactl --membind` to ensure processes use their local node's huge pages
5. The JVM `-XX:+UseLargePages` flag uses HugeTLBFS directly — the Java process user needs `memlock` unlimited in `/etc/security/limits.conf` for this to work
6. Measure dTLB-load-misses with `perf stat` before and after enabling huge pages to quantify the actual TLB pressure reduction — not all workloads with large memory footprints have TLB-bound performance
7. Boot-time huge page allocation (`hugepages=N` kernel parameter) is more reliable than runtime allocation because the system allocates from contiguous physical memory before fragmentation occurs
8. For Kubernetes nodes running memory-intensive pods, configure the node's THP setting based on the dominant workload type — there is no per-container THP control at the kernel level (application-level madvise calls are per-process)
