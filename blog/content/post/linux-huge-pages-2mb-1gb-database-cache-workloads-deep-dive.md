---
title: "Linux Huge Pages: 2MB and 1GB Pages for Database and Cache Workloads"
date: 2029-03-02T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Huge Pages", "PostgreSQL", "Redis", "Memory"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to configuring Linux 2MB and 1GB huge pages for database and cache workloads, covering TLB pressure reduction, NUMA topology, Transparent Huge Pages tuning, and Kubernetes node configuration."
more_link: "yes"
url: "/linux-huge-pages-2mb-1gb-database-cache-workloads-deep-dive/"
---

Every memory access on modern x86-64 hardware requires a virtual-to-physical address translation. The Translation Lookaside Buffer (TLB) caches these translations, and TLB misses — which force a multi-level page table walk costing 100–300 cycles — are among the most expensive operations in memory-intensive workloads. The default 4KB page size means a 64GB PostgreSQL shared buffer pool requires over 16 million page table entries. Switching to 2MB huge pages reduces that to ~32,768 entries, and 1GB huge pages to just 64 entries. For databases and caches where nearly all execution time is spent on memory access, this reduction measurably impacts throughput and latency.

<!--more-->

## TLB Architecture and Why Page Size Matters

Modern processors have multi-level TLBs. On a typical Intel Xeon:

| Level | Capacity (4KB) | Capacity (2MB) | Capacity (1GB) |
|-------|----------------|----------------|----------------|
| L1 dTLB | 64 entries | 32 entries | 4 entries |
| L2 TLB | 1536 entries | 1536 entries | 16 entries |
| STLB | 2048 entries | 2048 entries | — |

With 4KB pages, a 128GB working set requires 33.5 million TLB entries. With 2MB pages, 65,536. The practical consequence: a TLB-thrashing PostgreSQL instance doing random I/O across a 64GB shared buffer pool can spend 10–25% of CPU cycles in page table walks. Huge pages eliminate most of this overhead.

## Types of Huge Pages on Linux

### Standard Huge Pages (Static)

Static huge pages are pre-allocated at boot or via sysfs. They are permanently reserved from the memory pool and cannot be swapped.

```bash
# Check current huge page configuration
grep -i hugepage /proc/meminfo
# HugePages_Total:    8192
# HugePages_Free:     6144
# HugePages_Rsvd:     2048
# HugePages_Surp:        0
# Hugepagesize:       2048 kB
# Hugetlb:         16777216 kB

# Check supported huge page sizes
ls /sys/kernel/mm/hugepages/
# hugepages-1048576kB  hugepages-2048kB

# Check 1GB page availability (requires hardware support)
grep pdpe1gb /proc/cpuinfo | head -1
```

### Transparent Huge Pages (THP)

THP is the kernel's automatic huge page promotion system. It monitors anonymous mappings and promotes contiguous 4KB pages to 2MB pages opportunistically.

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# Check THP statistics
cat /proc/vmstat | grep -E "thp_|nr_anon_huge"
```

## Configuring Static Huge Pages

### Boot-Time Configuration (Recommended for Databases)

```bash
# /etc/default/grub — add to GRUB_CMDLINE_LINUX
# For 2MB huge pages (8192 × 2MB = 16GB reserved):
GRUB_CMDLINE_LINUX="... hugepages=8192 transparent_hugepage=never"

# For 1GB huge pages (16 × 1GB = 16GB reserved):
GRUB_CMDLINE_LINUX="... hugepagesz=1G hugepages=16 default_hugepagesz=1G transparent_hugepage=never"

# Apply grub change
grub2-mkconfig -o /boot/grub2/grub.cfg
# or on Ubuntu/Debian:
update-grub
```

### Runtime Configuration

Static huge pages allocated at runtime are less reliable because memory fragmentation may prevent contiguous allocation:

```bash
#!/bin/bash
# configure-hugepages.sh — allocate huge pages at runtime
set -euo pipefail

HUGEPAGE_SIZE="2048"  # kB, i.e., 2MB pages
TARGET_PAGES=4096     # 4096 × 2MB = 8GB

HUGEPAGE_DIR="/sys/kernel/mm/hugepages/hugepages-${HUGEPAGE_SIZE}kB"

echo "Attempting to allocate ${TARGET_PAGES} huge pages of ${HUGEPAGE_SIZE}kB each..."

# Drop caches first to reduce fragmentation
sync
echo 3 > /proc/sys/vm/drop_caches

# Set huge page count
echo "${TARGET_PAGES}" > "${HUGEPAGE_DIR}/nr_hugepages"

# Verify allocation
ALLOCATED=$(cat "${HUGEPAGE_DIR}/nr_hugepages")
if [[ "${ALLOCATED}" -lt "${TARGET_PAGES}" ]]; then
    echo "WARNING: Only ${ALLOCATED} of ${TARGET_PAGES} huge pages allocated."
    echo "Memory fragmentation may be preventing full allocation."
    echo "Consider configuring huge pages at boot time instead."
else
    echo "Success: ${ALLOCATED} huge pages allocated."
fi

# For 1GB pages (must be done at boot or early in system lifecycle)
# echo 8 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

### NUMA-Aware Huge Page Allocation

On multi-socket servers, allocate huge pages on each NUMA node separately to avoid remote memory access:

```bash
# Check NUMA topology
numactl --hardware

# Check per-NUMA-node huge page allocation
for node in /sys/devices/system/node/node*/hugepages/hugepages-2048kB/; do
    echo "${node}: $(cat ${node}/nr_hugepages) pages"
done

# Allocate huge pages on each NUMA node (4GB per node on a 2-socket system)
echo 2048 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 2048 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# For 1GB pages:
echo 8 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
echo 8 > /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages
```

## PostgreSQL Configuration

PostgreSQL uses `mmap` for shared buffers and can use huge pages via `madvise(MADV_HUGEPAGE)` or explicit `hugetlbfs` mounting.

### Hugetlbfs Mount for PostgreSQL

```bash
# Create hugetlbfs mount point
mkdir -p /dev/hugepages

# Mount hugetlbfs
mount -t hugetlbfs none /dev/hugepages -o pagesize=2M

# Make persistent
echo "none /dev/hugepages hugetlbfs pagesize=2M 0 0" >> /etc/fstab

# Set permissions for postgres user
chown postgres:postgres /dev/hugepages
chmod 700 /dev/hugepages
```

### PostgreSQL postgresql.conf Settings

```ini
# postgresql.conf — huge pages configuration

# Enable huge pages for shared_buffers
huge_pages = on                    # on, off, try
# "try" falls back to normal pages if huge pages are unavailable

# Size shared_buffers to fit in huge pages allocation
# With 8192 × 2MB pages = 16GB available:
shared_buffers = 12GB              # Leave some for OS and other processes

# Huge page size selection (requires PostgreSQL 14+)
huge_page_size = 0                 # 0 = use default huge page size (2MB)
# Set to 1048576 for 1GB pages if available

# Required: the postgres process must be able to request huge pages
# Set vm.nr_hugepages before starting PostgreSQL
```

### Verifying PostgreSQL Uses Huge Pages

```bash
# Check if PostgreSQL is using huge pages
psql -c "SHOW huge_pages;"

# Check actual usage in /proc
PG_PID=$(head -1 /var/lib/postgresql/16/main/postmaster.pid)
grep -i huge /proc/${PG_PID}/smaps | grep -E "AnonHugePages|ShmemHugePages"

# Check via pg_shmem_allocations (PostgreSQL 13+)
psql -c "SELECT name, off, size, allocated_size FROM pg_shmem_allocations ORDER BY size DESC LIMIT 10;"
```

### Calculating Required Huge Page Count

```bash
#!/bin/bash
# calculate-hugepages-for-postgres.sh
set -euo pipefail

# Target: shared_buffers + work_mem × max_connections overhead
SHARED_BUFFERS_MB=12288   # 12GB
HUGEPAGE_SIZE_MB=2

REQUIRED_PAGES=$(( (SHARED_BUFFERS_MB + HUGEPAGE_SIZE_MB - 1) / HUGEPAGE_SIZE_MB ))
RECOMMENDED_PAGES=$(( REQUIRED_PAGES + (REQUIRED_PAGES / 10) ))  # Add 10% buffer

echo "shared_buffers: ${SHARED_BUFFERS_MB} MB"
echo "Huge page size: ${HUGEPAGE_SIZE_MB} MB"
echo "Required pages: ${REQUIRED_PAGES}"
echo "Recommended (with 10% overhead): ${RECOMMENDED_PAGES}"
echo ""
echo "Add to boot parameters: hugepages=${RECOMMENDED_PAGES}"
echo "Or set at runtime: echo ${RECOMMENDED_PAGES} > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages"
```

## Redis Configuration

Redis allocates memory via `malloc`, which does not automatically use huge pages. However, THP can cause significant performance problems for Redis due to copy-on-write behavior during `BGSAVE`.

### The Redis + THP Problem

When Redis forks for `BGSAVE`, the kernel uses copy-on-write semantics. With THP enabled, a single write to a 2MB huge page causes a 2MB copy instead of a 4KB copy. This amplifies memory bandwidth consumption and can cause Redis to use 2–3x its normal memory during save operations.

```bash
# Redis strongly recommends disabling THP
# Check current Redis warning in logs:
redis-cli info server | grep -i huge
# If THP is enabled, Redis logs:
# WARNING you have Transparent Huge Pages (THP) support enabled in your kernel.
# This will create latency and memory usage issues with Redis.

# Disable THP for Redis processes (in redis init script or systemd unit):
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

### Redis systemd Unit with THP Disabled

```ini
# /etc/systemd/system/redis.service
[Unit]
Description=Redis In-Memory Data Store
After=network.target

[Service]
Type=notify
User=redis
Group=redis
ExecStartPre=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled && echo never > /sys/kernel/mm/transparent_hugepage/defrag'
ExecStart=/usr/bin/redis-server /etc/redis/redis.conf
ExecStop=/usr/bin/redis-cli shutdown
TimeoutStopSec=0
Restart=always
RestartSec=2

# Memory management
LimitNOFILE=65535
LimitMEMLOCK=infinity

# Huge pages: allow Redis to use huge pages via madvise
# Redis 7.0+ can benefit from explicit huge page usage for the allocator
Environment=MALLOC_CONF=thp:always

[Install]
WantedBy=multi-user.target
```

### jemalloc Huge Page Integration for Redis

Redis ships with jemalloc, which has native huge page support:

```bash
# Build Redis with jemalloc huge page support (Redis 7+)
# jemalloc already enables THP via MADV_HUGEPAGE by default
# Configure via environment variable:

# Enable THP for jemalloc arenas
export MALLOC_CONF="background_thread:true,metadata_thp:auto,thp:always"

# Check jemalloc stats
redis-cli debug jmap
```

## Transparent Huge Pages Tuning Reference

Different workloads require different THP settings:

```bash
#!/bin/bash
# tune-thp.sh — configure THP based on workload type
set -euo pipefail

THP_BASE="/sys/kernel/mm/transparent_hugepage"

tune_for_databases() {
    # PostgreSQL, MySQL: benefit from huge pages but must use static allocation
    # Disable THP to avoid fragmentation and unexpected memory behavior
    echo never > "${THP_BASE}/enabled"
    echo never > "${THP_BASE}/defrag"
    echo 0 > "${THP_BASE}/khugepaged/defrag"
    echo "THP disabled for database workload"
}

tune_for_java_jvm() {
    # JVM workloads: benefit from THP but need controlled promotion
    echo madvise > "${THP_BASE}/enabled"
    echo defer+madvise > "${THP_BASE}/defrag"
    echo 1 > "${THP_BASE}/khugepaged/defrag"
    # Only promote pages that applications explicitly request via madvise
    echo "THP set to madvise for JVM workload"
}

tune_for_general_compute() {
    # General: defer+madvise provides good balance
    echo madvise > "${THP_BASE}/enabled"
    echo defer > "${THP_BASE}/defrag"
    echo 0 > "${THP_BASE}/khugepaged/defrag"
    echo "THP set to defer/madvise for general compute"
}

case "${1:-}" in
    database) tune_for_databases ;;
    jvm)      tune_for_java_jvm ;;
    compute)  tune_for_general_compute ;;
    *)
        echo "Usage: $0 [database|jvm|compute]"
        exit 1
        ;;
esac
```

## Kubernetes Node Configuration

Kubernetes pods cannot directly manage huge pages on the host, but can request pre-allocated huge pages as a resource.

### Node Configuration via systemd

```bash
# /etc/systemd/system/configure-hugepages.service
cat > /etc/systemd/system/configure-hugepages.service << 'EOF'
[Unit]
Description=Configure Huge Pages for Kubernetes Node
Before=kubelet.service
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/configure-hugepages.sh

[Install]
WantedBy=multi-user.target
EOF

# /usr/local/bin/configure-hugepages.sh
cat > /usr/local/bin/configure-hugepages.sh << 'EOF'
#!/bin/bash
set -euo pipefail

# Allocate 2MB huge pages (adjust for your workload)
echo 2048 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Disable THP for database pods
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag
EOF

chmod +x /usr/local/bin/configure-hugepages.sh
systemctl enable configure-hugepages.service
```

### Kubernetes Pod Requesting Huge Pages

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-hugepages
  namespace: databases
spec:
  containers:
    - name: postgres
      image: postgres:16.3
      env:
        - name: POSTGRES_DB
          value: appdb
        - name: POSTGRES_USER
          value: appuser
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
      resources:
        requests:
          memory: "16Gi"
          hugepages-2Mi: "8Gi"
          cpu: "4"
        limits:
          memory: "16Gi"
          hugepages-2Mi: "8Gi"
          cpu: "8"
      volumeMounts:
        - name: hugepages
          mountPath: /hugepages
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

### LimitRange for Huge Pages in a Namespace

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: hugepage-limits
  namespace: databases
spec:
  limits:
    - type: Container
      max:
        hugepages-2Mi: "16Gi"
        hugepages-1Gi: "8Gi"
      default:
        hugepages-2Mi: "0"
      defaultRequest:
        hugepages-2Mi: "0"
```

## Measuring the Impact

### Benchmarking TLB Miss Rate

```bash
# Use perf to measure TLB misses before/after huge page configuration
perf stat -e dTLB-load-misses,dTLB-loads,iTLB-load-misses,iTLB-loads \
    -p $(pgrep -o postgres) \
    sleep 30

# Example output without huge pages:
# 245,891,234  dTLB-load-misses  # 18.72% of all dTLB cache accesses
# 1,312,888,401 dTLB-loads

# Example output with 2MB huge pages:
# 12,445,678  dTLB-load-misses  # 1.02% of all dTLB cache accesses
# 1,219,341,205 dTLB-loads
```

### PostgreSQL Checkpoint Latency Comparison

```sql
-- Before huge pages
SELECT * FROM pg_stat_bgwriter;
-- avg checkpoint time: 8200 ms

-- After configuring 2MB huge pages for shared_buffers
-- avg checkpoint time: 3100 ms (typical 40-60% improvement on large buffers)
```

## Common Issues and Resolutions

| Problem | Cause | Resolution |
|---------|-------|------------|
| `nr_hugepages` stays at 0 | Memory fragmentation | Allocate at boot time |
| PostgreSQL fails to start | Insufficient huge pages | Increase `nr_hugepages` |
| Redis memory doubles during BGSAVE | THP copy-on-write amplification | Disable THP |
| Kubernetes pod in `Pending` with huge pages | Node has no huge pages allocated | Configure node via DaemonSet |
| 1GB pages not available | CPU does not support `pdpe1gb` | Fall back to 2MB pages |

## Summary

Huge pages provide measurable performance improvements for memory-intensive workloads by reducing TLB pressure. The key decision points are:

- **Static 2MB pages**: Best for PostgreSQL shared_buffers and most OLTP databases. Pre-allocate at boot via kernel parameters.
- **Static 1GB pages**: Best for in-memory analytics workloads with working sets exceeding 32GB. Hardware must support `pdpe1gb`.
- **THP disabled**: Required for Redis and any fork-heavy workload to prevent copy-on-write amplification.
- **Kubernetes**: Request huge pages as `hugepages-2Mi` or `hugepages-1Gi` resource types; configure nodes via systemd before kubelet starts.

For production PostgreSQL instances with shared_buffers above 4GB, huge pages are not optional — the TLB miss reduction alone delivers 15–40% latency improvements on random-access OLTP workloads.
