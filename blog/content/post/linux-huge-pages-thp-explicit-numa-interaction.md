---
title: "Linux Huge Pages: THP, Explicit Huge Pages, and NUMA Interaction"
date: 2029-07-18T00:00:00-05:00
draft: false
tags: ["Linux", "Huge Pages", "THP", "NUMA", "Performance Tuning", "Kernel", "Memory Management"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux huge pages covering transparent huge pages (THP), explicit huge pages with mmap, NUMA-aware allocation, khugepaged tuning, and database workload optimization."
more_link: "yes"
url: "/linux-huge-pages-thp-explicit-numa-interaction/"
---

Modern applications running databases, in-memory caches, and high-throughput networking stacks live or die by memory subsystem performance. Linux huge pages — both transparent and explicit — are among the most impactful kernel features available to engineers who need to squeeze maximum performance from hardware. This guide covers the full picture: how the kernel manages huge pages, how khugepaged works, how to allocate explicit huge pages with `mmap`, the interaction with NUMA topology, and how to tune all of it for real production workloads.

<!--more-->

# Linux Huge Pages: THP, Explicit Huge Pages, and NUMA Interaction

## Section 1: Why Huge Pages Matter

The x86-64 MMU translates virtual addresses to physical addresses using a four-level (or five-level) page table walk. Every memory access that misses the TLB causes this walk, which touches multiple cache lines and adds latency. With a 4 KB base page size and 64 GB of RAM, a process needs roughly 16 million page table entries. This produces TLB pressure that degrades performance for large working sets.

Huge pages solve this by mapping larger contiguous physical regions with a single TLB entry:

- **2 MB huge pages** (PMD-level, most common): each TLB entry covers 512x more memory than a 4 KB page
- **1 GB huge pages** (PUD-level): one entry covers 262,144x more memory

The practical result for a database with a 64 GB buffer pool is that TLB miss rates drop dramatically, reducing the percentage of CPU cycles spent in page table walks from several percent to near zero.

### TLB Size and Hit Rate Math

```
Standard 4 KB pages:
  64 GB / 4 KB = 16,777,216 entries needed
  L1 dTLB: ~64 entries — covers 256 KB
  L2 TLB: ~1536 entries — covers 6 MB
  Any working set > 6 MB causes L2 TLB thrashing

2 MB huge pages:
  64 GB / 2 MB = 32,768 entries needed
  L1 dTLB: ~64 entries — covers 128 MB
  L2 TLB: ~1536 entries — covers 3 GB
  Working sets up to 3 GB fit in L2 TLB

1 GB huge pages:
  64 GB / 1 GB = 64 entries
  L1 dTLB: ~64 entries — covers 64 GB
  Entire working set covered by L1 TLB
```

## Section 2: Transparent Huge Pages (THP)

Transparent Huge Pages allow the kernel to automatically back anonymous memory mappings with 2 MB pages without requiring application changes. The kernel promotes groups of 512 contiguous 4 KB pages to a single PMD-level huge page opportunistically.

### Global THP Policy

The THP policy is controlled through `/sys/kernel/mm/transparent_hugepage/enabled`:

```bash
# Check current THP policy
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output: [always] madvise never

# Set to madvise (recommended for most workloads)
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Set to always (aggressive - can cause latency spikes)
echo always > /sys/kernel/mm/transparent_hugepage/enabled

# Disable THP entirely
echo never > /sys/kernel/mm/transparent_hugepage/enabled
```

The three modes:
- **always**: the kernel attempts to use huge pages for all anonymous memory mappings
- **madvise**: huge pages are used only for regions where the application called `madvise(addr, len, MADV_HUGEPAGE)`
- **never**: THP is completely disabled; only explicit huge pages work

### Defrag Policy

THP defragmentation controls whether the kernel compacts memory to satisfy huge page allocations:

```bash
# Check defrag policy
cat /sys/kernel/mm/transparent_hugepage/defrag
# Output: always defer defer+madvise [madvise] never

# Recommended for latency-sensitive workloads
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

The defrag modes:
- **always**: synchronous compaction on every THP allocation — worst latency impact
- **defer**: try to allocate without compaction; schedule async compaction via kcompactd
- **defer+madvise**: defer for `always` regions; synchronous compaction for `madvise` regions
- **madvise**: synchronous compaction only for `MADV_HUGEPAGE` regions
- **never**: no compaction; fall back to small pages if huge page unavailable

### Huge Zero Page

```bash
# Enable/disable the huge zero page (used for zero-mapped regions)
cat /sys/kernel/mm/transparent_hugepage/use_zero_page
echo 1 > /sys/kernel/mm/transparent_hugepage/use_zero_page
```

### Reading THP Statistics

```bash
# THP allocation counters
cat /proc/vmstat | grep thp
# Key metrics:
# thp_fault_alloc - huge pages allocated on page fault
# thp_fault_fallback - fell back to small pages on fault
# thp_collapse_alloc - khugepaged successfully collapsed
# thp_collapse_alloc_failed - khugepaged collapse failed
# thp_split_page - huge page split back to small pages
# thp_zero_page_alloc - huge zero page allocations
# thp_deferred_split_page - deferred split queue additions
```

```bash
# Per-process THP usage
cat /proc/$(pgrep postgres | head -1)/smaps | grep AnonHugePages | awk '{sum+=$2} END {print sum/1024 " MB"}'

# Detailed smaps for a specific mapping
grep -A 30 "heap" /proc/$(pgrep postgres | head -1)/smaps | grep -E "Size|AnonHugePages|THPeligible"
```

## Section 3: khugepaged — The THP Promotion Daemon

khugepaged is a kernel thread that scans anonymous memory regions and collapses groups of 4 KB pages into 2 MB huge pages. It runs in the background and is the engine behind THP's "always" mode doing work after initial allocation.

### khugepaged Tuning Parameters

```bash
# Base directory for khugepaged controls
ls /sys/kernel/mm/transparent_hugepage/khugepaged/

# Scan period (milliseconds between scans)
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# Default: 10000 (10 seconds)
echo 1000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Alloc sleep when allocation fails (milliseconds)
cat /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs
# Default: 60000 (60 seconds)
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs

# Maximum pages to scan per iteration
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# Default: 4096
echo 8192 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# Maximum percentage of small pages allowed before collapse
# Lower value = more aggressive collapsing
cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none
# Default: 511 (allow up to 511 of 512 pages to be unmapped)
echo 256 > /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none

# Maximum swap entries allowed in a THP candidate region
cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_swap
# Default: 0 (do not collapse if any pages are swapped)
```

### khugepaged Statistics

```bash
# Monitor khugepaged activity
watch -n 1 'cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed && \
            cat /proc/vmstat | grep -E "thp_collapse|thp_fault"'

# Full khugepaged stats
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed
cat /sys/kernel/mm/transparent_hugepage/khugepaged/full_scans
```

### Systemd Service for Persistent THP Configuration

```ini
# /etc/systemd/system/thp-tuning.service
[Unit]
Description=Configure Transparent Huge Pages and khugepaged
After=network.target
DefaultDependencies=no
Before=basic.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/configure-thp.sh

[Install]
WantedBy=basic.target
```

```bash
#!/bin/bash
# /usr/local/bin/configure-thp.sh
set -euo pipefail

THP_BASE=/sys/kernel/mm/transparent_hugepage

# For database servers: use madvise to give apps control
echo madvise > "${THP_BASE}/enabled"
echo defer+madvise > "${THP_BASE}/defrag"
echo 1 > "${THP_BASE}/use_zero_page"

# Tune khugepaged for faster promotion
echo 1000  > "${THP_BASE}/khugepaged/scan_sleep_millisecs"
echo 8192  > "${THP_BASE}/khugepaged/pages_to_scan"
echo 10000 > "${THP_BASE}/khugepaged/alloc_sleep_millisecs"
echo 256   > "${THP_BASE}/khugepaged/max_ptes_none"

echo "THP configuration applied"
```

## Section 4: Explicit Huge Pages

Explicit huge pages (also called HugeTLB pages) are pre-allocated by the kernel at boot or runtime, pinned in memory, and exposed to applications through `hugetlbfs` mounts or the `MAP_HUGETLB` flag in `mmap`. They provide deterministic availability — unlike THP, they never fall back to small pages — and avoid the compaction latency of THP.

### Allocating Explicit Huge Pages

```bash
# Check current huge page configuration
cat /proc/meminfo | grep -i huge
# HugePages_Total: 0
# HugePages_Free:  0
# HugePages_Rsvd:  0
# HugePages_Surp:  0
# Hugepagesize:    2048 kB
# Hugetlb:         0 kB

# Allocate 1000 x 2 MB huge pages (2 GB total)
echo 1000 > /proc/sys/vm/nr_hugepages

# Verify allocation (may be less if memory is fragmented)
cat /proc/meminfo | grep HugePages_Total

# Allocate 1 GB huge pages (requires hardware + kernel support)
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Persistent configuration via sysctl
cat >> /etc/sysctl.d/99-hugepages.conf << 'EOF'
vm.nr_hugepages = 1000
vm.nr_overcommit_hugepages = 256
EOF
sysctl -p /etc/sysctl.d/99-hugepages.conf

# Kernel command line for early allocation (avoids fragmentation)
# Add to GRUB: hugepages=1000 hugepagesz=2M default_hugepagesz=2M
```

### hugetlbfs Mount

```bash
# Mount hugetlbfs
mkdir -p /dev/hugepages
mount -t hugetlbfs -o pagesize=2M,size=4G hugetlbfs /dev/hugepages

# Mount for 1 GB pages
mkdir -p /dev/hugepages1G
mount -t hugetlbfs -o pagesize=1G,size=4G hugetlbfs /dev/hugepages1G

# Persistent via /etc/fstab
echo "hugetlbfs /dev/hugepages hugetlbfs pagesize=2M,size=4G 0 0" >> /etc/fstab
```

### mmap with MAP_HUGETLB

```c
// huge_page_alloc.c - Allocating explicit huge pages via mmap
#include <sys/mman.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>

#ifndef MAP_HUGE_2MB
#define MAP_HUGE_2MB (21 << MAP_HUGE_SHIFT)
#endif

#ifndef MAP_HUGE_1GB
#define MAP_HUGE_1GB (30 << MAP_HUGE_SHIFT)
#endif

#define HUGE_PAGE_SIZE_2MB (2UL * 1024 * 1024)
#define HUGE_PAGE_SIZE_1GB (1UL * 1024 * 1024 * 1024)
#define BUFFER_SIZE (10UL * HUGE_PAGE_SIZE_2MB)  // 20 MB

int main(void) {
    void *addr;

    // Allocate using MAP_HUGETLB (kernel chooses default huge page size)
    addr = mmap(NULL, BUFFER_SIZE,
                PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                -1, 0);

    if (addr == MAP_FAILED) {
        fprintf(stderr, "mmap MAP_HUGETLB failed: %s\n", strerror(errno));
        fprintf(stderr, "Check: cat /proc/meminfo | grep HugePages_Free\n");
        return 1;
    }

    printf("Allocated %lu MB with 2MB huge pages at %p\n",
           BUFFER_SIZE / (1024*1024), addr);

    // Touch all pages to fault them in
    memset(addr, 0, BUFFER_SIZE);

    // Explicit 2MB page request
    void *addr2m = mmap(NULL, HUGE_PAGE_SIZE_2MB,
                        PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_2MB,
                        -1, 0);

    if (addr2m != MAP_FAILED) {
        printf("Explicitly allocated 2MB huge page at %p\n", addr2m);
        munmap(addr2m, HUGE_PAGE_SIZE_2MB);
    }

    // Explicit 1GB page request
    void *addr1g = mmap(NULL, HUGE_PAGE_SIZE_1GB,
                        PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_1GB,
                        -1, 0);

    if (addr1g != MAP_FAILED) {
        printf("Allocated 1GB huge page at %p\n", addr1g);
        munmap(addr1g, HUGE_PAGE_SIZE_1GB);
    } else {
        printf("1GB pages unavailable: %s\n", strerror(errno));
    }

    munmap(addr, BUFFER_SIZE);
    return 0;
}
```

```c
// huge_page_madvise.c - Using MADV_HUGEPAGE with THP
#include <sys/mman.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define REGION_SIZE (256UL * 1024 * 1024)  // 256 MB

int main(void) {
    // Allocate regular anonymous memory aligned to 2MB boundary
    void *addr = aligned_alloc(2 * 1024 * 1024, REGION_SIZE);
    if (!addr) {
        perror("aligned_alloc");
        return 1;
    }

    // Hint to kernel to use huge pages for this region (requires THP madvise mode)
    if (madvise(addr, REGION_SIZE, MADV_HUGEPAGE) != 0) {
        perror("madvise MADV_HUGEPAGE");
        free(addr);
        return 1;
    }

    printf("Hinted %lu MB region for THP at %p\n",
           REGION_SIZE / (1024*1024), addr);

    // Touch all pages — huge pages will be allocated on fault
    memset(addr, 0xAB, REGION_SIZE);

    // Check in /proc/self/smaps how many huge pages were actually backed
    printf("Check: grep -A 5 '%p' /proc/%d/smaps | grep AnonHugePages\n",
           addr, getpid());

    // Advise against THP for specific sub-region (e.g., frequently split data)
    char *subregion = (char *)addr + (64UL * 1024 * 1024);
    madvise(subregion, 4096, MADV_NOHUGEPAGE);

    // Simulate work
    volatile char *p = addr;
    long sum = 0;
    for (size_t i = 0; i < REGION_SIZE; i += 4096) {
        sum += p[i];
    }
    printf("Sum (prevents optimization): %ld\n", sum);

    free(addr);
    return 0;
}
```

## Section 5: NUMA and Huge Pages

On multi-socket systems, huge page allocation interacts critically with NUMA topology. A huge page allocated on the wrong NUMA node adds ~100 ns remote memory latency to every access, which can dwarf the TLB savings.

### NUMA Huge Page Allocation

```bash
# Check NUMA topology
numactl --hardware

# Check huge pages per NUMA node
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Allocate huge pages on specific NUMA nodes
echo 512 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 512 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Check free huge pages per node
for node in /sys/devices/system/node/node*/hugepages/hugepages-2048kB; do
    echo "$node: $(cat $node/free_hugepages) free / $(cat $node/nr_hugepages) total"
done
```

### NUMA-Aware Application Allocation

```c
// numa_huge_pages.c - NUMA-aware huge page allocation
#define _GNU_SOURCE
#include <numa.h>
#include <numaif.h>
#include <sys/mman.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#define HUGE_PAGE_SIZE (2UL * 1024 * 1024)
#define PAGES_PER_NODE 256
#define BUFFER_SIZE (PAGES_PER_NODE * HUGE_PAGE_SIZE)

int main(void) {
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available\n");
        return 1;
    }

    int num_nodes = numa_num_configured_nodes();
    printf("NUMA nodes: %d\n", num_nodes);

    for (int node = 0; node < num_nodes; node++) {
        // Bind allocation to this NUMA node
        struct bitmask *nodemask = numa_allocate_nodemask();
        numa_bitmask_setbit(nodemask, node);

        // mbind approach: allocate then bind
        void *addr = mmap(NULL, BUFFER_SIZE,
                          PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                          -1, 0);

        if (addr == MAP_FAILED) {
            fprintf(stderr, "mmap failed on node %d: %s\n", node, strerror(errno));
            numa_free_nodemask(nodemask);
            continue;
        }

        // Bind the memory to this NUMA node
        if (mbind(addr, BUFFER_SIZE, MPOL_BIND,
                  nodemask->maskp, nodemask->size + 1,
                  MPOL_MF_MOVE | MPOL_MF_STRICT) != 0) {
            perror("mbind");
        }

        // Touch to fault in on correct node
        memset(addr, 0, BUFFER_SIZE);

        // Verify NUMA node of allocation
        int numa_node;
        get_mempolicy(&numa_node, NULL, 0, addr, MPOL_F_NODE | MPOL_F_ADDR);
        printf("Node %d: allocated %lu MB huge pages, landed on node %d\n",
               node, BUFFER_SIZE / (1024*1024), numa_node);

        munmap(addr, BUFFER_SIZE);
        numa_free_nodemask(nodemask);
    }

    return 0;
}
```

```bash
# Run application with NUMA binding
numactl --membind=0 --cpunodebind=0 ./database_server

# Check NUMA memory stats
numastat
numastat -p $(pgrep postgres | head -1)

# NUMA huge page statistics
numastat -m | grep -i huge
```

### NUMA Huge Page Policy via numactl

```bash
# Pre-allocate huge pages ensuring NUMA balance
# Script to evenly distribute huge pages across nodes
cat > /usr/local/bin/numa-hugepages-setup.sh << 'EOF'
#!/bin/bash
TOTAL_PAGES=2048
NUM_NODES=$(numactl --hardware | grep "available:" | awk '{print $2}')
PAGES_PER_NODE=$((TOTAL_PAGES / NUM_NODES))

for node in $(seq 0 $((NUM_NODES - 1))); do
    echo "Allocating ${PAGES_PER_NODE} huge pages on node ${node}"
    echo ${PAGES_PER_NODE} > \
        /sys/devices/system/node/node${node}/hugepages/hugepages-2048kB/nr_hugepages
done

echo "Done. Current allocation:"
for node in $(seq 0 $((NUM_NODES - 1))); do
    echo "  node${node}: $(cat /sys/devices/system/node/node${node}/hugepages/hugepages-2048kB/nr_hugepages) pages"
done
EOF
chmod +x /usr/local/bin/numa-hugepages-setup.sh
```

## Section 6: Database Workload Tuning

### PostgreSQL with Huge Pages

```bash
# Calculate required huge pages for PostgreSQL
# shared_buffers + wal_buffers + max_connections overhead
SHARED_BUFFERS_GB=16
HUGE_PAGE_SIZE_MB=2
PAGES_NEEDED=$(( (SHARED_BUFFERS_GB * 1024) / HUGE_PAGE_SIZE_MB + 50 ))  # +50 overhead

echo "Huge pages needed for PostgreSQL: ${PAGES_NEEDED}"

# Reserve huge pages before starting PostgreSQL
echo ${PAGES_NEEDED} > /proc/sys/vm/nr_hugepages

# postgresql.conf settings
cat >> /etc/postgresql/15/main/postgresql.conf << 'EOF'
# Huge pages configuration
huge_pages = on                  # on, off, or try
huge_page_size = 2MB             # 2MB or 1GB (if available)
shared_buffers = 16GB
# huge_pages=try falls back to standard pages if huge pages unavailable
EOF

# Check PostgreSQL huge page usage after start
psql -c "SHOW huge_pages;"
cat /proc/$(pgrep -f "postgres: checkpointer" | head -1)/smaps_rollup | grep Huge
```

### Redis with Explicit Huge Pages

```bash
# redis.conf
cat >> /etc/redis/redis.conf << 'EOF'
# Disable THP to avoid latency spikes (Redis prefers explicit huge pages or no THP)
# THP causes copy-on-write overhead during BGSAVE
# Use explicit huge pages instead via the OS configuration

# Memory settings
maxmemory 32gb
maxmemory-policy allkeys-lru
EOF

# For Redis, typically disable THP and use explicit huge pages
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# The Redis startup script
cat > /etc/systemd/system/redis-server.service.d/hugepages.conf << 'EOF'
[Service]
# Ensure huge pages are available before Redis starts
ExecStartPre=/bin/bash -c 'echo 16384 > /proc/sys/vm/nr_hugepages'
EOF
```

### Java JVM with Huge Pages

```bash
# JVM huge page flags
JAVA_OPTS="-server \
  -Xms32g \
  -Xmx32g \
  -XX:+UseLargePages \
  -XX:+UseTransparentHugePages \
  -XX:LargePageSizeInBytes=2m \
  -XX:+UseNUMA \
  -XX:+PrintFlagsFinal"

# Verify JVM is using huge pages
$JAVA_HOME/bin/java ${JAVA_OPTS} -version 2>&1 | grep -E "LargePages|THP"

# Check /proc for the JVM process
JVM_PID=$(pgrep java | head -1)
grep AnonHugePages /proc/${JVM_PID}/smaps | awk '{sum+=$2} END{print "AnonHugePages: " sum/1024 " MB"}'
```

## Section 7: Monitoring Huge Page Health

### Prometheus and Node Exporter

```yaml
# prometheus-huge-pages-rules.yaml
groups:
  - name: huge_pages
    interval: 30s
    rules:
      - alert: HugePagesExhausted
        expr: |
          node_memory_HugePages_Free / node_memory_HugePages_Total < 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Huge pages nearly exhausted on {{ $labels.instance }}"
          description: "Only {{ $value | humanizePercentage }} of huge pages remain free"

      - alert: THPSplitRateHigh
        expr: |
          rate(node_vmstat_thp_split_page[5m]) > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High THP split rate on {{ $labels.instance }}"
          description: "THP pages splitting at {{ $value | humanize }}/s — may indicate memory pressure"

      - alert: THPFaultFallbackHigh
        expr: |
          rate(node_vmstat_thp_fault_fallback[5m]) > 50
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "THP fallback to small pages on {{ $labels.instance }}"
```

### Shell Monitoring Script

```bash
#!/bin/bash
# /usr/local/bin/monitor-hugepages.sh
# Comprehensive huge page health monitoring

echo "=== Huge Page Status $(date) ==="

echo ""
echo "--- Global Huge Pages ---"
cat /proc/meminfo | grep -E "HugePage|Hugepage"

echo ""
echo "--- THP Stats ---"
printf "%-35s %s\n" "Metric" "Count"
printf "%-35s %s\n" "------" "-----"
while IFS= read -r line; do
    metric=$(echo "$line" | awk '{print $1}')
    value=$(echo "$line" | awk '{print $2}')
    printf "%-35s %s\n" "$metric" "$value"
done < <(grep thp /proc/vmstat)

echo ""
echo "--- NUMA Distribution ---"
for node_dir in /sys/devices/system/node/node*/hugepages/hugepages-2048kB; do
    node=$(echo "$node_dir" | grep -oP 'node\d+')
    total=$(cat "$node_dir/nr_hugepages" 2>/dev/null || echo 0)
    free=$(cat "$node_dir/free_hugepages" 2>/dev/null || echo 0)
    echo "  $node: ${free}/${total} free (2MB pages)"
done

echo ""
echo "--- Top Processes by Huge Page Usage ---"
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    smaps="/proc/$pid/smaps_rollup"
    if [[ -r "$smaps" ]]; then
        huge=$(grep "AnonHugePages:" "$smaps" 2>/dev/null | awk '{print $2}')
        if [[ -n "$huge" && "$huge" -gt 0 ]]; then
            comm=$(cat /proc/$pid/comm 2>/dev/null || echo "unknown")
            echo "  PID $pid ($comm): ${huge} kB"
        fi
    fi
done | sort -t: -k2 -rn | head -10

echo ""
echo "--- khugepaged Stats ---"
echo "  Collapsed: $(cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed)"
echo "  Full scans: $(cat /sys/kernel/mm/transparent_hugepage/khugepaged/full_scans)"
```

## Section 8: Huge Pages in Containers and Kubernetes

### Kubernetes Huge Page Resource Limits

```yaml
# pod-with-hugepages.yaml
apiVersion: v1
kind: Pod
metadata:
  name: database-with-hugepages
spec:
  containers:
  - name: postgres
    image: postgres:16
    resources:
      limits:
        cpu: "4"
        memory: "32Gi"
        hugepages-2Mi: 16Gi   # Reserve 16 GB of 2MB huge pages
      requests:
        cpu: "2"
        memory: "16Gi"
        hugepages-2Mi: 16Gi   # requests must equal limits for huge pages
    volumeMounts:
    - name: hugepage-vol
      mountPath: /hugepages
    env:
    - name: POSTGRES_HUGE_PAGES
      value: "on"
  volumes:
  - name: hugepage-vol
    emptyDir:
      medium: HugePages-2Mi
      sizeLimit: 16Gi
```

```yaml
# node-with-hugepages (node prep via DaemonSet)
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: configure-hugepages
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: configure-hugepages
  template:
    metadata:
      labels:
        app: configure-hugepages
    spec:
      hostPID: true
      hostIPC: true
      tolerations:
      - operator: Exists
      initContainers:
      - name: configure-hugepages
        image: busybox:latest
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
          echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
          echo 2048 > /proc/sys/vm/nr_hugepages
          echo "Huge pages configured: $(cat /proc/meminfo | grep HugePages_Total)"
        volumeMounts:
        - name: sys
          mountPath: /sys
        - name: proc
          mountPath: /proc
      containers:
      - name: pause
        image: gcr.io/google_containers/pause:3.9
      volumes:
      - name: sys
        hostPath:
          path: /sys
      - name: proc
        hostPath:
          path: /proc
```

## Section 9: Troubleshooting Huge Page Issues

### Common Problems and Solutions

```bash
# Problem: nr_hugepages set but HugePages_Total is less
# Cause: memory fragmentation — kernel cannot find contiguous 2MB regions
# Solution: allocate at boot time or run memory compaction

# Trigger manual memory compaction
echo 1 > /proc/sys/vm/compact_memory

# Check compaction stats
cat /proc/vmstat | grep compact

# Problem: application not using huge pages despite MAP_HUGETLB
# Check: are huge pages available?
cat /proc/meminfo | grep HugePages_Free  # Must be > 0

# Problem: THP causing latency spikes (common with Redis, Cassandra)
# Symptom: periodic latency spikes correlating with khugepaged scans
# Solution: disable THP or switch to madvise + explicit huge pages

# Check if khugepaged is causing the latency
perf record -g -p $(pgrep redis-server) sleep 30
perf report | grep -E "khugepaged|collapse|compaction"

# Problem: NUMA cross-node huge page allocation
# Symptom: high remote memory access rate despite local huge pages
numastat -p $(pgrep postgres | head -1)
# If numa_miss is high, pages are being allocated on wrong node

# Fix: ensure huge pages are allocated per-node before starting application
for node in 0 1; do
    echo 512 > /sys/devices/system/node/node${node}/hugepages/hugepages-2048kB/nr_hugepages
done
numactl --membind=0 --cpunodebind=0 -- postgres -D /var/lib/postgresql/data
```

### Huge Page Audit Script

```bash
#!/bin/bash
# /usr/local/bin/hugepage-audit.sh
# Full audit of huge page configuration for production readiness

ISSUES=0

check() {
    local desc="$1"
    local cmd="$2"
    local expected="$3"
    local actual
    actual=$(eval "$cmd" 2>/dev/null)
    if [[ "$actual" == *"$expected"* ]]; then
        echo "  PASS: $desc"
    else
        echo "  FAIL: $desc (got: '$actual', want: '$expected')"
        ISSUES=$((ISSUES + 1))
    fi
}

echo "=== Huge Page Production Audit ==="

echo ""
echo "THP Configuration:"
check "THP mode is madvise" "cat /sys/kernel/mm/transparent_hugepage/enabled" "madvise"
check "Defrag is defer+madvise" "cat /sys/kernel/mm/transparent_hugepage/defrag" "defer+madvise"

echo ""
echo "Explicit Huge Pages:"
TOTAL=$(cat /proc/meminfo | grep HugePages_Total | awk '{print $2}')
FREE=$(cat /proc/meminfo | grep HugePages_Free | awk '{print $2}')
echo "  Total: $TOTAL, Free: $FREE"
if [[ "$FREE" -eq "$TOTAL" && "$TOTAL" -gt 0 ]]; then
    echo "  WARN: All huge pages are free — no application is using them"
fi

echo ""
echo "NUMA Balance:"
for node_dir in /sys/devices/system/node/node*/hugepages/hugepages-2048kB; do
    total=$(cat "$node_dir/nr_hugepages" 2>/dev/null || echo 0)
    echo "  $(basename $(dirname $(dirname $node_dir))): $total pages"
done

echo ""
if [[ "$ISSUES" -gt 0 ]]; then
    echo "RESULT: $ISSUES issue(s) found"
else
    echo "RESULT: All checks passed"
fi
```

## Section 10: Summary and Recommendations

Huge page configuration is workload-specific. Here is a decision matrix for common scenarios:

| Workload | THP Mode | Explicit Pages | NUMA | Notes |
|---|---|---|---|---|
| PostgreSQL | madvise | Yes (shared_buffers) | Per-node | Boot-time allocation preferred |
| Redis | never | Optional | Local only | THP causes COW latency during BGSAVE |
| Java JVM | try | Via -XX:+UseLargePages | numactl | UseNUMA flag required |
| Cassandra | never | No | Local binding | THP causes GC pause spikes |
| ClickHouse | madvise | Optional | Per-node | Benefits from MADV_HUGEPAGE on buffer pool |
| NFV/DPDK | never | 1GB pages | Explicit | DPDK manages its own memory pool |

Key takeaways:
- Always allocate explicit huge pages at kernel boot time on database nodes to avoid fragmentation
- Use per-NUMA-node allocation to prevent remote memory access
- Disable THP for latency-sensitive workloads and use explicit pages instead
- Monitor `thp_split_page` and `thp_fault_fallback` rates to detect memory pressure
- In Kubernetes, request `hugepages-2Mi` resources and mount `emptyDir` with `HugePages-2Mi` medium
