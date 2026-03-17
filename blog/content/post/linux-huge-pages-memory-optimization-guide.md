---
title: "Linux Huge Pages: Memory Optimization for Databases, JVM, and Containers"
date: 2028-05-22T00:00:00-05:00
draft: false
tags: ["Linux", "Huge Pages", "Memory", "Performance", "PostgreSQL", "JVM", "Kubernetes", "NUMA"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux Huge Pages: transparent huge pages, explicit huge pages, hugetlbfs, NUMA-aware allocation, and tuning for PostgreSQL, Oracle, Java/JVM workloads in containers and Kubernetes."
more_link: "yes"
url: "/linux-huge-pages-memory-optimization-guide/"
---

Memory translation overhead is a hidden tax on every memory access in modern applications. The CPU's Translation Lookaside Buffer (TLB) caches virtual-to-physical address mappings. With the default 4KB page size, a working set of 8GB requires over 2 million TLB entries. TLBs hold hundreds to a few thousand entries. The result: most memory accesses require a page table walk, adding latency and consuming CPU cycles. Huge pages (2MB on x86_64) reduce TLB pressure by 512x. This guide covers all aspects of huge page configuration for production Linux systems and Kubernetes environments.

<!--more-->

## Memory Translation Architecture

Understanding the TLB and page tables is prerequisite to tuning huge pages effectively.

Virtual memory addresses are translated to physical addresses via a multi-level page table hierarchy (4 levels on modern x86_64). Each level introduces a memory access if the entry isn't cached. The TLB caches recent translations to avoid these walks.

With 4KB pages:
- 8GB working set = 2,097,152 page table entries
- Modern L1 TLB: 64 entries
- L2 TLB: 1,024-4,096 entries
- TLB miss rate on large working sets: extremely high
- Each miss: 3-5 memory accesses for 4-level page table walk

With 2MB huge pages:
- 8GB working set = 4,096 page table entries
- TLB miss rate: dramatically reduced
- Fewer page table levels needed (skip the last level entirely)

Real-world performance impact:
- PostgreSQL: 5-15% throughput improvement on large shared_buffers
- Redis: 10-20% latency reduction on large datasets
- JVM: 5-10% GC pause reduction, 3-8% throughput improvement
- Memory-intensive analytics: 15-30% throughput improvement

## Huge Page Types in Linux

### Transparent Huge Pages (THP)

THP automatically promotes 4KB pages to 2MB huge pages at the kernel level. No application changes required.

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# Set THP globally
echo always > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled  # Only when requested
echo never > /sys/kernel/mm/transparent_hugepage/enabled    # Disable entirely
```

THP defrag policy (handles memory fragmentation during promotion):

```bash
# Check defrag setting
cat /sys/kernel/mm/transparent_hugepage/defrag
# always defer defer+madvise [madvise] never

# Production recommendation: defer+madvise
# - Defragments asynchronously (doesn't block application)
# - Only for memory regions that requested it
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

**THP khugepaged settings:**

```bash
# How aggressively the kernel promotes pages
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 4096 - pages scanned per pass

# Delay between scans (milliseconds)
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# 10000

# Production tuning
echo 64 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
```

### Explicit Huge Pages (HugeTLBfs)

Pre-allocated huge pages available via `mmap()` with `MAP_HUGETLB` or through hugetlbfs mounts. More predictable than THP but require upfront configuration.

```bash
# Check current huge page pool
cat /proc/meminfo | grep -i huge
# AnonHugePages:    524288 kB
# ShmemHugePages:        0 kB
# FileHugePages:         0 kB
# HugePages_Total:    1024
# HugePages_Free:      512
# HugePages_Rsvd:       64
# HugePages_Surp:        0
# Hugepagesize:       2048 kB
# Hugetlb:         2097152 kB

# Allocate huge pages (2MB each)
echo 1024 > /proc/sys/vm/nr_hugepages

# For 1GB huge pages (requires CPU support)
echo 4 > /proc/sys/vm/nr_hugepages  # This sets 2MB pages
# For 1GB:
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Persistent configuration in /etc/sysctl.conf
echo "vm.nr_hugepages = 1024" >> /etc/sysctl.conf
sysctl -p
```

## Persistent Boot Configuration

```bash
# /etc/sysctl.d/99-hugepages.conf

# 2MB huge pages: allocate 16GB worth (8192 × 2MB)
vm.nr_hugepages = 8192

# Allow overcommit of huge pages (for PostgreSQL shared memory)
vm.nr_overcommit_hugepages = 2048

# Transparent huge pages for remaining memory
# Set via kernel cmdline, not sysctl
```

```bash
# /etc/default/grub
# Add to GRUB_CMDLINE_LINUX:
# hugepages=8192 transparent_hugepage=madvise

# For 1GB huge pages:
# hugepages=8 default_hugepagesz=1G hugepagesz=1G
```

## NUMA-Aware Huge Page Allocation

On multi-socket systems, allocate huge pages per NUMA node:

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11
# node 0 size: 128795 MB
# node 0 free: 89234 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23
# node 1 size: 129020 MB
# node 1 free: 91102 MB

# Allocate huge pages per node
echo 4096 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 4096 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Verify allocation
grep -r HugePages /sys/devices/system/node/*/meminfo
```

Bind processes to NUMA nodes for optimal huge page use:

```bash
# Bind PostgreSQL to node 0 huge pages
numactl --cpunodebind=0 --membind=0 /usr/lib/postgresql/15/bin/postgres -D /data/pg
```

## hugetlbfs Mount

Applications can directly map files in a hugetlbfs filesystem:

```bash
# Mount hugetlbfs
mkdir -p /dev/hugepages
mount -t hugetlbfs -o uid=postgres,gid=postgres,mode=775,pagesize=2M \
  hugetlbfs /dev/hugepages

# Persistent in /etc/fstab
echo "hugetlbfs /dev/hugepages hugetlbfs defaults,pagesize=2M 0 0" >> /etc/fstab

# For 1GB pages
mkdir -p /dev/hugepages1G
mount -t hugetlbfs -o pagesize=1G hugetlbfs /dev/hugepages1G
```

## PostgreSQL Huge Pages Configuration

PostgreSQL benefits significantly from huge pages for its shared buffer pool:

```bash
# postgresql.conf

# Enable huge pages
huge_pages = on                # 'on', 'off', or 'try'
                               # 'try' falls back gracefully if unavailable

# Size the shared buffer pool appropriately
shared_buffers = 32GB          # 25-40% of total RAM

# Huge page requirement calculation:
# shared_buffers = 32GB
# huge pages needed = 32GB / 2MB = 16384 pages
# Add ~10% buffer for PostgreSQL overhead
# nr_hugepages should be >= 18000
```

Verify PostgreSQL is using huge pages:

```bash
# Check after PostgreSQL startup
grep -i huge /proc/$(pgrep -f "postgres: checkpointer")/smaps | \
  awk '/AnonHugePages/ {sum+=$2} END {print "AnonHugePages: " sum/1024 " MB"}'

# Or check PostgreSQL logs
grep -i huge /var/log/postgresql/postgresql-15-main.log

# Explicit verification via pg_config
psql -c "SHOW huge_pages;"
# huge_pages
# -----------
# on
```

```bash
# System configuration for PostgreSQL huge pages
# /etc/sysctl.d/99-postgresql-hugepages.conf

# Allow PostgreSQL to use huge pages via POSIX shared memory
vm.nr_hugepages = 18000

# Maximum shared memory segment size (must be large enough for shared_buffers)
# 32GB + overhead
kernel.shmmax = 36507222016

# Maximum total shared memory
kernel.shmall = 8912896
```

## Oracle Database Huge Pages

Oracle has used explicit huge pages for decades. Configuration via `hugetlb_shm_group`:

```bash
# Get Oracle user's GID
id oracle
# uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba)

# Allow oracle group to use huge pages
echo 54321 > /proc/sys/vm/hugetlb_shm_group

# Disable THP for Oracle (Oracle requires it disabled)
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# Calculate Oracle huge pages needed:
# Oracle SGA size = 64GB
# Huge pages needed = 64GB / 2MB = 32768 + 10% buffer = 36000
echo 36000 > /proc/sys/vm/nr_hugepages
```

## Java/JVM Huge Pages

JVM workloads benefit significantly, especially with large heaps:

### Explicit Large Pages

```bash
# JVM flags for huge pages
JAVA_OPTS="-Xms32g -Xmx32g \
  -XX:+UseLargePages \
  -XX:LargePageSizeInBytes=2m \
  -XX:+UseHugeTLBFS"   # Linux-specific flag to use hugetlbfs
```

### Transparent Huge Pages for JVM

```bash
# Use THP with madvise (JVM calls madvise for heap regions)
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# JVM flags
JAVA_OPTS="-Xms32g -Xmx32g \
  -XX:+UseTransparentHugePages"
```

### G1GC with Huge Pages

G1GC uses regions. Configure region size to align with huge pages:

```bash
# G1GC region size should be a power of 2, range 1MB to 32MB
# With 2MB huge pages, use 2MB or 4MB regions
JAVA_OPTS="-Xms64g -Xmx64g \
  -XX:+UseG1GC \
  -XX:G1HeapRegionSize=2m \
  -XX:+UseLargePages"
```

Verify JVM is using large pages:

```bash
# Check JVM large page usage
java -Xms8g -Xmx8g -XX:+UseLargePages -XX:+PrintFlagsFinal -version 2>&1 | \
  grep -i "LargePage"

# Check /proc/[pid]/smaps for AnonHugePages
JVM_PID=$(pgrep -f "java.*myapp")
awk '/AnonHugePages/ {sum+=$2} END {print "AnonHugePages: " sum/1024 " MB"}' \
  /proc/$JVM_PID/smaps
```

## Redis Huge Pages Configuration

```bash
# redis.conf or command line

# Disable THP for Redis (Redis documentation recommends this for latency)
# Redis uses many small allocations that THP interferes with
echo never > /sys/kernel/mm/transparent_hugepage/enabled
# OR set to madvise and let Redis control it

# Use madvise for precise control
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

Redis explicitly calls madvise(MADV_HUGEPAGE) for its aof_buf and other large buffers when THP is in madvise mode. For the main data dictionary (which uses jemalloc), THP is beneficial:

```bash
# Redis build with jemalloc and MADV_HUGEPAGE support
# jemalloc will call madvise(MADV_HUGEPAGE) on large allocations
REDIS_CFLAGS="-DJEMALLOC_MADV_HUGEPAGE" make
```

## MongoDB Huge Pages

```bash
# MongoDB requires THP disabled (or madvise)
# MongoDB startup will warn if THP is enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# Verify MongoDB sees correct THP state
mongo --eval "db.adminCommand({getParameter:1, transparentHugePages:1})"
```

## Kubernetes Huge Page Support

Kubernetes supports huge pages as a native resource type since v1.14:

### Node Configuration

Nodes must have huge pages pre-allocated:

```bash
# On each node, configure huge pages before Kubernetes starts
# /etc/sysctl.d/99-k8s-hugepages.conf
vm.nr_hugepages = 1024

# Kubernetes will advertise available huge pages as a resource
kubectl describe node node-1 | grep hugepages
# hugepages-2Mi:  2Gi
# hugepages-1Gi:  0
```

### Pod Resource Request

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-huge-pages
spec:
  containers:
  - name: postgres
    image: postgres:15.4
    resources:
      requests:
        memory: 64Gi
        cpu: "8"
        hugepages-2Mi: 32Gi     # Request 16384 × 2MB huge pages
      limits:
        memory: 64Gi
        cpu: "8"
        hugepages-2Mi: 32Gi     # Limits must equal requests for huge pages
    volumeMounts:
    - mountPath: /dev/hugepages
      name: hugepage
  volumes:
  - name: hugepage
    emptyDir:
      medium: HugePages
  securityContext:
    privileged: false
    capabilities:
      add:
      - IPC_LOCK             # Required to lock huge pages in memory
```

### StatefulSet with Huge Pages for PostgreSQL

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-ha
  namespace: databases
spec:
  serviceName: postgres
  replicas: 3
  template:
    spec:
      initContainers:
      # Verify huge pages are available
      - name: check-hugepages
        image: busybox:1.36
        command: ["/bin/sh", "-c"]
        args:
        - |
          AVAILABLE=$(cat /sys/kernel/mm/hugepages/hugepages-2048kB/free_hugepages)
          NEEDED=16384
          if [ "$AVAILABLE" -lt "$NEEDED" ]; then
            echo "ERROR: Need $NEEDED huge pages, only $AVAILABLE available"
            exit 1
          fi
          echo "OK: $AVAILABLE huge pages available"
        securityContext:
          privileged: true
      containers:
      - name: postgres
        image: postgres:15.4
        env:
        - name: POSTGRES_SHARED_BUFFERS
          value: "32GB"
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        resources:
          requests:
            memory: 96Gi
            cpu: "16"
            hugepages-2Mi: 32Gi
          limits:
            memory: 96Gi
            cpu: "32"
            hugepages-2Mi: 32Gi
        volumeMounts:
        - name: hugepage
          mountPath: /dev/hugepages
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: postgres-config
          mountPath: /etc/postgresql
      volumes:
      - name: hugepage
        emptyDir:
          medium: HugePages-2Mi
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 1Ti
```

### Node Affinity for Huge Page Nodes

Not all nodes may have huge pages configured. Use node selectors to target correctly configured nodes:

```bash
# Label nodes with huge page capacity
kubectl label node node-01 hugepages=2Mi
kubectl label node node-02 hugepages=2Mi
```

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: hugepages
            operator: In
            values:
            - 2Mi
```

## THP Monitoring and Troubleshooting

```bash
# Monitor THP promotion and demotion rates
watch -n 1 'grep -E "^(AnonHugePages|HugePages)" /proc/meminfo'

# Detailed THP statistics
cat /proc/vmstat | grep -i thp
# thp_fault_alloc 12849
# thp_fault_fallback 0
# thp_fault_fallback_charge 0
# thp_collapse_alloc 8391
# thp_collapse_alloc_failed 0
# thp_file_alloc 0
# thp_file_mapped 0
# thp_split_page 142
# thp_split_pmd 142
# thp_zero_page_alloc 0
# thp_zero_page_alloc_failed 0
# thp_swpout 0
# thp_swpout_fallback 0

# Key metrics:
# thp_collapse_alloc_failed: high value = memory fragmentation issue
# thp_split_page: THP pages being split back to 4KB (deoptimization)
```

Detect THP fragmentation issues:

```bash
# Check memory fragmentation
cat /proc/buddyinfo
# Node 0, zone DMA      1  1  1  1  2  2  2  2  2  0  0
# Node 0, zone Normal 143 91  45  23  12  6  3  1  0  0  0
# (right column is 2^10 = 1024 pages = 4MB blocks, relevant for THP)

# Force defragmentation (costly, avoid in production during peak)
echo 1 > /proc/sys/vm/compact_memory
```

## Performance Validation

```bash
#!/bin/bash
# huge-pages-benchmark.sh
# Compares TLB miss rate with and without huge pages

# Requires: perf

echo "=== TLB Miss Rate Without Huge Pages ==="
echo never > /sys/kernel/mm/transparent_hugepage/enabled
sync && echo 3 > /proc/sys/vm/drop_caches

perf stat -e dTLB-loads,dTLB-load-misses \
  sysbench memory \
    --memory-block-size=1G \
    --memory-scope=global \
    --memory-hugetlb=off \
    --memory-oper=read \
    --time=30 run 2>&1

echo ""
echo "=== TLB Miss Rate With Huge Pages (THP) ==="
echo always > /sys/kernel/mm/transparent_hugepage/enabled

perf stat -e dTLB-loads,dTLB-load-misses \
  sysbench memory \
    --memory-block-size=1G \
    --memory-scope=global \
    --memory-hugetlb=off \
    --memory-oper=read \
    --time=30 run 2>&1

# Interpret results:
# dTLB-load-misses / dTLB-loads = miss rate
# With huge pages, miss rate should decrease by 10-100x for large working sets
```

PostgreSQL-specific benchmark:

```bash
# pgbench with and without huge_pages
psql -c "ALTER SYSTEM SET huge_pages = off; SELECT pg_reload_conf();"
pgbench -c 32 -j 8 -T 60 mydb
# baseline TPS

psql -c "ALTER SYSTEM SET huge_pages = on; SELECT pg_reload_conf();"
# Requires PostgreSQL restart to reallocate shared_buffers as huge pages
pg_ctlcluster 15 main restart
pgbench -c 32 -j 8 -T 60 mydb
# huge pages TPS (expect 5-15% improvement on large shared_buffers)
```

## Summary

Huge pages provide significant, measurable performance improvements for memory-intensive workloads. The 512x reduction in TLB entries (4KB vs 2MB pages) directly reduces TLB misses, eliminating a hidden source of latency in database, JVM, and analytics workloads. Transparent Huge Pages with `madvise` mode provides the best balance: applications that need huge pages get them, others are unaffected. For databases like PostgreSQL and Oracle with predictable large memory allocations, explicit huge pages with `vm.nr_hugepages` provide the most reliable behavior. Kubernetes supports huge pages as first-class resources, enabling proper isolation and accounting across multi-tenant clusters. The investment in configuration pays consistent dividends on every memory-intensive workload.
