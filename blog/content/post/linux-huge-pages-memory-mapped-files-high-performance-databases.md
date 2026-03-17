---
title: "Linux Huge Pages and Memory-Mapped Files for High-Performance Databases"
date: 2030-08-24T00:00:00-05:00
draft: false
tags: ["Linux", "Huge Pages", "PostgreSQL", "Redis", "Performance", "Memory", "NUMA", "mmap"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production memory optimization guide covering transparent huge pages for PostgreSQL and Redis, explicit huge page reservations, memory-mapped file I/O, NUMA-aware allocation, and measuring huge page impact."
more_link: "yes"
url: "/linux-huge-pages-memory-mapped-files-high-performance-databases/"
---

Memory subsystem performance is frequently the limiting factor for database workloads. The Linux kernel manages physical memory in 4 KB pages by default, which means a database managing 256 GB of shared memory requires approximately 67 million page table entries. Each TLB miss that falls through to a page table walk adds latency that compounds across millions of queries per second. Huge pages — 2 MB on x86_64 — reduce TLB pressure by a factor of 512, directly improving query throughput for working sets larger than the TLB capacity. This post covers every layer of huge page configuration: Transparent Huge Pages policy per workload, explicit HugeTLBfs reservations, NUMA-aware allocation, and memory-mapped file I/O patterns.

<!--more-->

## Understanding TLB Pressure and Huge Page Benefits

Modern x86_64 processors have two levels of TLB:

- **L1 dTLB**: 64 entries (Intel Sapphire Rapids), each covering 4 KB = 256 KB addressable without miss
- **L2 TLB**: 2048 entries (shared), 4 KB pages = 8 MB addressable
- **With 2 MB huge pages**: L2 TLB covers 4 GB without miss (2048 × 2 MB)

For PostgreSQL with `shared_buffers = 32GB`, the working set requires 8 million 4 KB page table entries. Each query accessing cold buffer pages will generate TLB misses and potentially page table walks (up to 5 memory accesses on a 4-level page table). With 2 MB huge pages, the same 32 GB requires only 16,384 entries — fitting entirely within the L2 TLB on modern processors.

The performance difference manifests as:

- Reduced CPU cycles per query (measured via `perf stat`)
- Lower `dtlb_load_misses.miss_causes_a_walk` hardware counter
- Improved throughput at high concurrency where TLB thrashing is a bottleneck

## Transparent Huge Pages

Transparent Huge Pages (THP) is the kernel's automatic mechanism for promoting contiguous 4 KB allocations into 2 MB pages. It operates in the background via `khugepaged`, which scans process address spaces for promotion candidates.

### Checking Current THP Status

```bash
# Current THP mode
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output: [always] madvise never

# khugepaged statistics
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Current THP usage
grep -i huge /proc/meminfo
```

### THP Modes

| Mode | Behavior | Recommended For |
|------|----------|----------------|
| `always` | Promote all eligible allocations | Java JVM (G1GC), general-purpose workloads |
| `madvise` | Promote only `MADV_HUGEPAGE` regions | Databases that opt in selectively |
| `never` | Disable THP entirely | Redis, latency-sensitive services |

### Why Redis Requires THP Disabled

Redis performs `fork()` for RDB snapshots and AOF rewrites. With THP enabled in `always` mode, the Copy-On-Write (COW) granularity becomes 2 MB instead of 4 KB. When the child process writes during snapshotting, entire 2 MB pages are copied even when only a few bytes changed. On a 32 GB Redis instance with high write throughput during a snapshot, this can cause:

- Memory usage to briefly double (parent + COW copies)
- Snapshot latency to increase by 3–10x
- Kernel `ksmd` and `khugepaged` competing with the database process

Redis issues a warning in its logs when THP is enabled:

```
WARNING: you have Transparent Huge Pages (THP) support enabled in your kernel.
This will create latency and memory usage issues with Redis. To fix this issue
run the command 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled' as root,
and add it to your /etc/rc.local in order to retain the setting after a reboot.
```

### Disabling THP for Redis with systemd

The correct production approach is to set THP policy in a systemd drop-in, scoping the change to the Redis service rather than the entire system:

```ini
# /etc/systemd/system/redis.service.d/thp.conf
[Service]
ExecStartPre=/bin/sh -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStartPre=/bin/sh -c 'echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag'
```

However, the THP sysfs file is system-global — writing to it from a service affects all processes. The correct granular approach uses `prctl` or `madvise` within the process, or a systemd scope with memory namespace isolation.

For system-level configuration on nodes dedicated to Redis:

```bash
# /etc/rc.local or systemd unit with After=local-fs.target
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Persist via tuned profile
cat > /etc/tuned/redis-profile/tuned.conf <<EOF
[main]
summary=Redis production profile

[vm]
transparent_hugepages=madvise
EOF

tuned-adm profile redis-profile
```

### THP Configuration for PostgreSQL

PostgreSQL benefits from THP for its shared buffer pool. With `always` mode, the kernel automatically promotes the shared memory segment PostgreSQL creates via `shmget()` or `mmap(MAP_ANONYMOUS)`. However, `always` mode has fragmentation side effects — the `khugepaged` daemon consumes CPU scanning process address spaces.

The recommended PostgreSQL approach is `madvise` combined with `hugepages = try` in `postgresql.conf`. PostgreSQL 11+ calls `madvise(MADV_HUGEPAGE)` on the shared buffer region when `huge_pages` is set to `try` or `on`:

```ini
# postgresql.conf
# Enable huge pages for shared buffers
# 'on' fails startup if huge pages unavailable
# 'try' falls back to standard pages (production recommended)
huge_pages = try

shared_buffers = 32GB

# For explicit huge page reservation (see below)
# huge_page_size = 2MB
```

```bash
# Verify PostgreSQL is using huge pages after restart
grep -i huge /proc/$(pgrep -o postgres)/smaps | grep -E "^(AnonHugePages|HugePages):"
```

## Explicit HugeTLBfs Reservations

The HugeTLBfs interface provides pre-allocated huge pages reserved in the kernel's huge page pool. Unlike THP which promotes pages opportunistically, HugeTLBfs guarantees huge page availability.

### Reserving Huge Pages

```bash
# Check current huge page pool
cat /proc/sys/vm/nr_hugepages
grep -E "^Huge" /proc/meminfo

# Reserve 16,384 huge pages (32 GB at 2 MB each)
echo 16384 > /proc/sys/vm/nr_hugepages

# Verify allocation
cat /proc/meminfo | grep HugePages
# HugePages_Total:   16384
# HugePages_Free:    16384
# HugePages_Rsvd:    0
# HugePages_Surp:    0
# Hugepagesize:      2048 kB

# Make persistent
echo "vm.nr_hugepages = 16384" >> /etc/sysctl.d/99-hugepages.conf
sysctl --system
```

### Timing of Huge Page Reservation

Reserve huge pages at boot before memory becomes fragmented. Kernel boot parameters provide the most reliable reservation:

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX="hugepages=16384 hugepagesz=2M"

# Regenerate grub
update-grub  # Debian/Ubuntu
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL/CentOS
```

### 1 GB Huge Pages for Very Large Databases

For databases with working sets exceeding 512 GB, 1 GB huge pages (available on modern x86_64 CPUs) provide even greater TLB coverage. A single 1 GB page covers the equivalent of 512 standard huge pages:

```bash
# Check 1 GB page support
grep pdpe1gb /proc/cpuinfo | head -1

# Reserve 64 × 1 GB pages = 64 GB
# Must be set at boot time (cannot be allocated post-boot)
# GRUB_CMDLINE_LINUX="default_hugepagesz=1G hugepagesz=1G hugepages=64"

# Verify
grep -i hugepage /proc/meminfo
cat /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

### PostgreSQL with Explicit HugeTLBfs

When `huge_pages = on` in `postgresql.conf`, PostgreSQL allocates shared memory from the HugeTLBfs pool. To size the reservation correctly:

```bash
# Calculate required huge pages
SHARED_BUFFERS_GB=32
OVERHEAD_PERCENT=1.2  # 20% overhead for other shared memory structures
HUGEPAGE_SIZE_MB=2

TOTAL_MB=$(echo "$SHARED_BUFFERS_GB * 1024 * $OVERHEAD_PERCENT" | bc)
HUGEPAGES=$(echo "($TOTAL_MB + $HUGEPAGE_SIZE_MB - 1) / $HUGEPAGE_SIZE_MB" | bc)

echo "Reserve $HUGEPAGES huge pages for ${SHARED_BUFFERS_GB}GB shared_buffers"
# Reserve 19661 huge pages for 32GB shared_buffers
```

Check PostgreSQL's actual huge page usage after startup:

```bash
# Get the postmaster PID
PG_PID=$(pgrep -o postgres)

# Inspect smaps for huge page backing
awk '/^AnonHugePages/ { sum += $2 } END { print sum/1024 " MB of THP" }' \
    /proc/$PG_PID/smaps

# For HugeTLBfs (explicit huge pages)
grep -c "^THPeligible:.*1" /proc/$PG_PID/smaps
```

## Memory-Mapped File I/O with mmap

Memory-mapped files allow the kernel's page cache to be accessed directly from the process's virtual address space, eliminating `read()`/`write()` system call overhead and one copy between kernel and user space.

### Basic mmap Pattern

```c
// C example showing mmap concepts (for reference in understanding kernel behavior)
// In practice, databases implement this in their storage engine

#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>

// Open the database file
int fd = open("/var/lib/mydb/data.db", O_RDWR);

// Get file size
struct stat st;
fstat(fd, &st);
size_t file_size = st.st_size;

// Map the file into virtual address space
// MAP_SHARED: writes go to the file (not MAP_PRIVATE which COWs)
// MAP_POPULATE: pre-fault pages into memory (avoids initial access faults)
void *data = mmap(NULL, file_size, PROT_READ | PROT_WRITE,
                  MAP_SHARED | MAP_POPULATE, fd, 0);

// Advise the kernel about access patterns
// MADV_SEQUENTIAL: prefetch aggressively (for scans)
madvise(data, file_size, MADV_SEQUENTIAL);

// MADV_RANDOM: disable prefetch (for index lookups)
madvise(data, file_size, MADV_RANDOM);

// MADV_HUGEPAGE: request THP backing for this region
madvise(data, file_size, MADV_HUGEPAGE);

// MADV_WILLNEED: hint that this range will be needed soon
madvise(data + offset, region_size, MADV_WILLNEED);
```

### Go mmap Implementation

```go
// pkg/storage/mmap.go
package storage

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// MmapFile provides memory-mapped access to a file.
type MmapFile struct {
    data []byte
    size int64
    file *os.File
}

// OpenMmap opens a file and maps it into memory.
func OpenMmap(path string, size int64) (*MmapFile, error) {
    f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
    if err != nil {
        return nil, fmt.Errorf("open %s: %w", path, err)
    }

    // Ensure file is at least the requested size
    if err := f.Truncate(size); err != nil {
        f.Close()
        return nil, fmt.Errorf("truncate %s to %d: %w", path, size, err)
    }

    data, err := syscall.Mmap(
        int(f.Fd()),
        0,
        int(size),
        syscall.PROT_READ|syscall.PROT_WRITE,
        syscall.MAP_SHARED,
    )
    if err != nil {
        f.Close()
        return nil, fmt.Errorf("mmap %s: %w", path, err)
    }

    // Advise kernel to use huge pages for this mapping
    if err := madviseHugepage(data); err != nil {
        // Non-fatal: THP is opportunistic
        _ = err
    }

    return &MmapFile{
        data: data,
        size: size,
        file: f,
    }, nil
}

// madviseHugepage advises the kernel to back the region with huge pages.
func madviseHugepage(data []byte) error {
    const MADV_HUGEPAGE = 14 // Linux-specific
    _, _, errno := syscall.Syscall(
        syscall.SYS_MADVISE,
        uintptr(unsafe.Pointer(&data[0])),
        uintptr(len(data)),
        MADV_HUGEPAGE,
    )
    if errno != 0 {
        return fmt.Errorf("madvise MADV_HUGEPAGE: %w", errno)
    }
    return nil
}

// ReadAt reads bytes from the mapped region at the given offset.
func (m *MmapFile) ReadAt(p []byte, off int64) (int, error) {
    if off < 0 || off >= m.size {
        return 0, fmt.Errorf("offset %d out of range [0, %d)", off, m.size)
    }
    n := copy(p, m.data[off:])
    return n, nil
}

// WriteAt writes bytes to the mapped region at the given offset.
// Changes are eventually flushed to disk by msync or the kernel's writeback.
func (m *MmapFile) WriteAt(p []byte, off int64) (int, error) {
    if off < 0 || off+int64(len(p)) > m.size {
        return 0, fmt.Errorf("write would exceed mapped region")
    }
    n := copy(m.data[off:], p)
    return n, nil
}

// Sync flushes dirty pages to disk.
// Use MS_SYNC for synchronous flush (wait for disk), MS_ASYNC for async.
func (m *MmapFile) Sync() error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_MSYNC,
        uintptr(unsafe.Pointer(&m.data[0])),
        uintptr(len(m.data)),
        syscall.MS_SYNC,
    )
    if errno != 0 {
        return fmt.Errorf("msync: %w", errno)
    }
    return nil
}

// Close unmaps and closes the file.
func (m *MmapFile) Close() error {
    if err := m.Sync(); err != nil {
        return fmt.Errorf("sync before close: %w", err)
    }
    if err := syscall.Munmap(m.data); err != nil {
        return fmt.Errorf("munmap: %w", err)
    }
    return m.file.Close()
}
```

### mmap Access Patterns for Different Workloads

```go
// pkg/storage/hints.go
package storage

import (
    "syscall"
    "unsafe"
)

const (
    MADV_SEQUENTIAL = 2
    MADV_RANDOM     = 1
    MADV_WILLNEED   = 3
    MADV_DONTNEED   = 4
    MADV_HUGEPAGE   = 14
)

// Prefetch hints the kernel to prefetch a region for sequential scan.
func (m *MmapFile) PrefetchSequential(off, length int64) error {
    return madvise(m.data, off, length, MADV_SEQUENTIAL)
}

// HintRandom disables prefetching for random-access patterns (e.g., B-tree lookups).
func (m *MmapFile) HintRandom(off, length int64) error {
    return madvise(m.data, off, length, MADV_RANDOM)
}

// Prefetch asks the kernel to fault in pages for an upcoming read.
func (m *MmapFile) Prefetch(off, length int64) error {
    return madvise(m.data, off, length, MADV_WILLNEED)
}

// Release tells the kernel this region is no longer needed (evict from page cache).
func (m *MmapFile) Release(off, length int64) error {
    return madvise(m.data, off, length, MADV_DONTNEED)
}

func madvise(data []byte, off, length int64, advice int) error {
    if off+length > int64(len(data)) {
        length = int64(len(data)) - off
    }
    _, _, errno := syscall.Syscall(
        syscall.SYS_MADVISE,
        uintptr(unsafe.Pointer(&data[off])),
        uintptr(length),
        uintptr(advice),
    )
    if errno != 0 {
        return errno
    }
    return nil
}
```

## NUMA-Aware Huge Page Allocation

On multi-socket servers, NUMA topology matters significantly. Memory allocated on a remote NUMA node incurs additional latency (typically 30–40 ns vs 10–15 ns for local access). Huge page pools should be distributed across NUMA nodes proportionally to the CPU threads that will access them.

### Checking NUMA Topology

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 128691 MB
# node 0 free: 98234 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 129020 MB
# node 1 free: 101456 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Check huge page distribution per NUMA node
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages
```

### Distributing Huge Pages Across NUMA Nodes

```bash
#!/bin/bash
# numa-hugepages.sh - Distribute huge pages evenly across NUMA nodes

TOTAL_PAGES=16384
NUMA_NODES=$(numactl --hardware | grep "available:" | awk '{print $2}')
PAGES_PER_NODE=$((TOTAL_PAGES / NUMA_NODES))

echo "Distributing $TOTAL_PAGES pages across $NUMA_NODES NUMA nodes ($PAGES_PER_NODE per node)"

for node in $(seq 0 $((NUMA_NODES - 1))); do
    echo "$PAGES_PER_NODE" > \
        "/sys/devices/system/node/node${node}/hugepages/hugepages-2048kB/nr_hugepages"
    ACTUAL=$(cat "/sys/devices/system/node/node${node}/hugepages/hugepages-2048kB/nr_hugepages")
    echo "Node $node: requested $PAGES_PER_NODE, got $ACTUAL"
done

echo "Total huge pages:"
grep "^HugePages" /proc/meminfo
```

### Running PostgreSQL with NUMA Binding

```bash
# Bind PostgreSQL to NUMA node 0's CPUs and memory
numactl --cpunodebind=0 --membind=0 \
    sudo -u postgres /usr/lib/postgresql/16/bin/postgres \
    -D /var/lib/postgresql/16/main

# For systemd service
cat > /etc/systemd/system/postgresql@16-main.service.d/numa.conf <<EOF
[Service]
ExecStart=
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/lib/postgresql/%i/bin/postgres -D %h/%i/main
EOF

systemctl daemon-reload
systemctl restart postgresql@16-main
```

### Verifying NUMA Hit Rate

```bash
# Install numastat
apt-get install numactl

# Check NUMA statistics for PostgreSQL
numastat $(pgrep -o postgres)
# Per-node memory statistics showing local vs remote allocations
# Goal: numa_hit >> numa_miss

# Monitor in real time
watch -n 5 'numastat -p $(pgrep -o postgres)'
```

## Measuring Huge Page Impact

### Before/After Benchmarking with pgbench

```bash
# Baseline: THP disabled, no explicit huge pages
echo never > /sys/kernel/mm/transparent_hugepage/enabled
systemctl restart postgresql@16-main
pgbench -i -s 1000 benchdb
pgbench -c 64 -j 8 -T 300 benchdb | tee /tmp/pgbench-baseline.txt

# With THP always
echo always > /sys/kernel/mm/transparent_hugepage/enabled
systemctl restart postgresql@16-main
pgbench -c 64 -j 8 -T 300 benchdb | tee /tmp/pgbench-thp-always.txt

# With explicit huge pages
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo 20000 > /proc/sys/vm/nr_hugepages
# Set huge_pages = on in postgresql.conf
systemctl restart postgresql@16-main
pgbench -c 64 -j 8 -T 300 benchdb | tee /tmp/pgbench-explicit-hugepages.txt

# Compare results
grep "tps" /tmp/pgbench-*.txt
```

### Hardware Counter Analysis with perf

```bash
# Measure TLB miss rate under load
PG_PID=$(pgrep -o postgres)

perf stat -e \
    dtlb_load_misses.miss_causes_a_walk,\
    dtlb_load_misses.walk_completed,\
    dtlb_store_misses.miss_causes_a_walk,\
    tlb_flush.dtlb_thread,\
    page_faults \
    -p $PG_PID \
    -- sleep 60

# With huge pages, expect:
# dtlb_load_misses.miss_causes_a_walk to drop by 50-90%
# dtlb_load_misses.walk_completed to drop correspondingly
```

### Monitoring /proc/meminfo

```bash
#!/bin/bash
# monitor-hugepages.sh - Track huge page utilization over time

while true; do
    TIMESTAMP=$(date +%s)
    TOTAL=$(awk '/HugePages_Total/ {print $2}' /proc/meminfo)
    FREE=$(awk '/HugePages_Free/ {print $2}' /proc/meminfo)
    RSVD=$(awk '/HugePages_Rsvd/ {print $2}' /proc/meminfo)
    USED=$((TOTAL - FREE))
    UTIL=$(echo "scale=2; $USED * 100 / $TOTAL" | bc)

    echo "$TIMESTAMP total=$TOTAL free=$FREE reserved=$RSVD used=$USED utilization=${UTIL}%"
    sleep 30
done
```

### Prometheus Node Exporter Metrics

The node exporter exposes huge page metrics automatically:

```promql
# Huge page utilization
(node_memory_HugePages_Total - node_memory_HugePages_Free)
  / node_memory_HugePages_Total * 100

# Alert when huge page pool is nearly exhausted
ALERT HugePagePoolExhausted
  IF (node_memory_HugePages_Total - node_memory_HugePages_Free)
       / node_memory_HugePages_Total > 0.95
  FOR 5m
  LABELS { severity = "warning" }
  ANNOTATIONS {
    summary = "Huge page pool over 95% utilized on {{ $labels.instance }}"
  }

# THP promotion rate (high rate may indicate fragmentation pressure)
rate(node_vmstat_thp_fault_alloc[5m])
rate(node_vmstat_thp_collapse_alloc[5m])
```

## Kubernetes Node Configuration for Huge Pages

When running databases in Kubernetes, huge page resources must be configured on the node and exposed to pods.

### Node-Level HugePage Setup via NodeFeatureDiscovery

```bash
# Verify huge pages are visible to kubelet
kubectl describe node database-node-01 | grep -A5 "Allocatable"
# hugepages-1Gi:  0
# hugepages-2Mi:  16Gi
```

### Pod Requesting Huge Pages

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgresql-primary
  namespace: databases
spec:
  containers:
    - name: postgresql
      image: postgres:16.3
      resources:
        requests:
          memory: "64Gi"
          hugepages-2Mi: "32Gi"
        limits:
          memory: "64Gi"
          hugepages-2Mi: "32Gi"
      volumeMounts:
        - name: hugepage-vol
          mountPath: /hugepages
        - name: shm
          mountPath: /dev/shm
      env:
        - name: POSTGRES_HBA_CONF
          value: "pg_hba.conf"
      securityContext:
        privileged: false
  volumes:
    - name: hugepage-vol
      emptyDir:
        medium: HugePages-2Mi
    - name: shm
      emptyDir:
        medium: Memory
        sizeLimit: 32Gi
  tolerations:
    - key: "database"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  nodeSelector:
    workload-type: database
```

### DaemonSet for Node Huge Page Configuration

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hugepage-configurator
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: hugepage-configurator
  template:
    metadata:
      labels:
        app: hugepage-configurator
    spec:
      hostPID: true
      hostIPC: true
      nodeSelector:
        workload-type: database
      initContainers:
        - name: configure-hugepages
          image: registry.example.com/tools/sysctl-configurator:latest
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              set -e
              echo "madvise" > /sys/kernel/mm/transparent_hugepage/enabled
              echo "defer+madvise" > /sys/kernel/mm/transparent_hugepage/defrag

              # Reserve huge pages per NUMA node
              PAGES_PER_NODE=8192
              for node_dir in /sys/devices/system/node/node*/hugepages/hugepages-2048kB; do
                echo $PAGES_PER_NODE > "${node_dir}/nr_hugepages"
              done

              echo "Huge page configuration complete"
              cat /proc/meminfo | grep -E "^(HugePages|Hugepagesize)"
          volumeMounts:
            - name: sys
              mountPath: /sys
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
      volumes:
        - name: sys
          hostPath:
            path: /sys
```

## Troubleshooting Huge Page Issues

### Huge Pages Not Allocated at Boot

```bash
# Check if allocation failed (memory fragmentation)
dmesg | grep -i "hugepage"
# "HugeTLB cma reservation failed" indicates fragmentation

# Check contiguous memory availability
cat /proc/buddyinfo
# Look for order-9 entries (9 × 4KB = 2MB) on each NUMA node
# Each column represents page order; column 9 = 2MB blocks

# Compact memory before allocating (runtime fragmentation fix)
echo 1 > /proc/sys/vm/compact_memory
echo 16384 > /proc/sys/vm/nr_hugepages
```

### PostgreSQL Not Using Huge Pages Despite Configuration

```bash
# Check PostgreSQL startup log for huge page messages
grep -i "huge" /var/log/postgresql/postgresql-16-main.log

# Verify huge_pages setting took effect
psql -c "SHOW huge_pages;"
psql -c "SHOW huge_page_size;"

# Check shared memory parameters
psql -c "SELECT name, setting, unit FROM pg_settings
         WHERE name IN ('shared_buffers', 'huge_pages', 'huge_page_size');"

# Check if the OS huge page limit is too low
# PostgreSQL needs: shared_buffers + WAL buffers + other structures
# Calculate required pages
psql -c "SELECT pg_size_pretty(pg_size_bytes(current_setting('shared_buffers')));"
```

### mmap Performance Regression Investigation

```bash
# Check page fault rates
sar -B 1 60
# pgfault/s: minor faults (page already in memory)
# pgmajfault/s: major faults (read from disk) — these hurt performance

# Use strace to observe mmap syscalls in a process
strace -e trace=mmap,madvise,munmap -p <pid> 2>&1 | head -50

# Check for excessive msync calls
strace -e trace=msync -p <pid> 2>&1 | \
    awk '{count++} END {print count " msync calls observed"}'
```

## Summary

Huge pages are one of the highest-leverage memory optimizations available for database workloads. The deployment strategy depends on the workload: Redis requires THP disabled to avoid COW amplification during fork; PostgreSQL benefits from explicit HugeTLBfs reservation for predictable huge page availability; write-intensive key-value stores may prefer `madvise` mode to selectively opt memory regions into huge page backing.

For production deployments, reserve huge pages at boot via kernel command line parameters to avoid fragmentation, distribute the reservation across NUMA nodes proportional to the workload's CPU affinity, and monitor the pool utilization via Prometheus to detect pressure before allocation failures occur. Memory-mapped files that use `madvise(MADV_HUGEPAGE)` gain the same TLB benefits for storage engine implementations that map database files directly into process address space.
