---
title: "Linux Transparent Huge Pages: Database Performance Tuning and Kubernetes Impact"
date: 2030-09-30T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "THP", "PostgreSQL", "Redis", "Kubernetes", "Huge Pages", "Memory Management"]
categories:
- Linux
- Performance
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux Transparent Huge Pages covering THP kernel settings (always/madvise/never), hugepage defragmentation impact, per-process madvise(MADV_HUGEPAGE) control, PostgreSQL and Redis THP recommendations, and measuring THP impact with perf and /proc/vmstat."
more_link: "yes"
url: "/linux-transparent-huge-pages-database-performance-tuning-kubernetes/"
---

Transparent Huge Pages is one of the most influential kernel settings for database performance — and one of the most frequently misconfigured. The promise is straightforward: larger memory pages (2MB instead of 4KB) mean fewer TLB entries needed, lower TLB miss rates, and less memory management overhead. The reality is that the automatic management of THP introduces latency spikes during page promotion and defragmentation that are often worse than the TLB pressure THP was meant to solve. Understanding when THP helps, when it hurts, and how to configure it precisely per workload is essential for database administrators and platform engineers managing Kubernetes clusters that host latency-sensitive applications.

<!--more-->

## Memory Pages and TLB Background

The CPU's Translation Lookaside Buffer (TLB) caches virtual-to-physical address translations. With 4KB pages, the TLB covers at most `TLB_size * 4KB` of virtual address space without misses. A 64-entry L1 TLB covers 256KB — trivially small for a database with gigabytes of working set.

With 2MB huge pages, the same 64 TLB entries cover 128MB. For workloads with large, frequently accessed memory regions (database shared buffers, in-memory caches), this dramatically reduces TLB misses and the associated page table walk overhead.

The cost is fragmentation: the kernel must find 512 contiguous 4KB pages to assemble a 2MB huge page. For long-running systems with fragmented memory, this allocation can fail or require compaction (which stalls other operations).

## THP Kernel Configuration

```bash
# View current THP settings
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# Brackets indicate current setting

cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# 10000 (milliseconds between khugepaged scans)

cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 4096 (pages scanned per khugepaged pass)
```

### THP Enabled Settings

```bash
# always: Kernel attempts to use huge pages for all anonymous memory
# madvise: Only use huge pages for memory regions that explicitly request them via madvise(MADV_HUGEPAGE)
# never: Disable THP entirely

# Set via sysfs (immediate, not persistent)
echo always > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# Persistent via sysctl (add to /etc/sysctl.d/)
# Note: THP enabled is NOT a sysctl parameter - use GRUB or rc.local:
cat >> /etc/rc.d/rc.local << 'EOF'
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
EOF
chmod +x /etc/rc.d/rc.local

# Or via systemd service (recommended approach)
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Configure Transparent Huge Pages
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled && echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag"
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable disable-thp
systemctl start disable-thp
```

### THP Defrag Settings

The `defrag` setting controls how aggressively the kernel compacts memory to create huge pages:

```bash
# always: Synchronous compaction - stalls allocation until huge page is available
# danger: CAUSES LATENCY SPIKES. Never use for latency-sensitive workloads.

# defer: Asynchronous background compaction via khugepaged
# Lower latency impact, but may not always have huge pages ready

# defer+madvise: Asynchronous compaction for all THP; synchronous for madvise regions
# Good compromise for mixed workloads

# madvise: Only compact memory for madvise(MADV_HUGEPAGE) regions (synchronous for those)

# never: No compaction for THP; only use naturally aligned regions

# Recommended for database servers:
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

### Tuning khugepaged

`khugepaged` is the kernel thread that promotes pages to huge pages asynchronously:

```bash
# Slow down khugepaged to reduce background CPU usage
# (at cost of slower huge page adoption)
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Pages to scan per pass (reduce for less disruptive scanning)
echo 4096 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# Minimum pages that must be present before promoting to huge page
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapse
# Default: 512 (all 512 pages must be present = full 2MB populated)

# Allow collapse even with fewer populated pages
echo 256 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapse
```

## Per-Process madvise Control

The `madvise(MADV_HUGEPAGE)` and `madvise(MADV_NOHUGEPAGE)` syscalls allow processes to request or reject THP for specific memory regions, regardless of the global setting.

### C Code for Per-Region THP Control

```c
#include <sys/mman.h>
#include <stdlib.h>

// Allocate 256MB and request huge page backing
void* alloc_with_hugepages(size_t size) {
    // Align to 2MB boundary for efficient huge page allocation
    void* ptr;
    if (posix_memalign(&ptr, 2 * 1024 * 1024, size) != 0) {
        return NULL;
    }

    // Request transparent huge pages for this region
    madvise(ptr, size, MADV_HUGEPAGE);

    return ptr;
}

// Allocate memory that explicitly does NOT want huge pages
// (e.g., small metadata allocations where THP would waste memory)
void* alloc_without_hugepages(size_t size) {
    void* ptr = malloc(size);
    if (ptr) {
        madvise(ptr, size, MADV_NOHUGEPAGE);
    }
    return ptr;
}
```

### Go Runtime THP Interaction

The Go runtime allocates heap memory in spans. THP interacts with the Go heap; the GODEBUG environment variable can influence this:

```bash
# Disable THP at the application level by using madvise
# Go 1.21+ respects MADV_DONTNEED and manages its heap accordingly

# For Go services that are THP-sensitive:
export GODEBUG=madvdontneed=1  # Aggressively return memory to OS (reduces THP retention)

# Check if Go runtime uses MADV_HUGEPAGE
strace -e trace=madvise ./myapp 2>&1 | grep HUGE
```

## PostgreSQL and THP

PostgreSQL's relationship with THP is well-documented and consistently negative in production:

### Why THP Hurts PostgreSQL

1. **Fork overhead**: PostgreSQL uses a process-per-connection model. Each backend process is a fork. With THP `always` enabled and huge pages present in the parent, `fork()` triggers copy-on-write for entire 2MB pages, even if only a small portion is written. A query that writes 4KB forces a full 2MB page copy.

2. **Checkpoint latency**: During checkpoints, PostgreSQL flushes dirty pages. If these pages are backed by huge pages, the write must dirty the entire 2MB region's tracking even for small writes.

3. **khugepaged stalls**: The background khugepaged thread can stall PostgreSQL processes while compacting memory to form huge pages.

### PostgreSQL THP Configuration Recommendations

```bash
# Recommended: madvise mode + hugepages_only = off
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# In postgresql.conf, use explicit huge pages:
# huge_pages = try  (use if available, don't fail if not)
# huge_page_size = 2MB

# For PostgreSQL, pre-allocate static huge pages (not THP):
# These are DIFFERENT from transparent huge pages
sysctl -w vm.nr_hugepages=1024  # 1024 * 2MB = 2GB of huge pages for PostgreSQL

# In postgresql.conf:
# shared_buffers = 2GB
# huge_pages = on  (fail if huge pages not available)
```

### PostgreSQL-Specific Benchmark: Measuring THP Impact

```bash
# Test with pgbench to measure THP impact on OLTP workload
# Baseline: THP = always
pgbench -i -s 100 mydb  # Scale factor 100 = ~1.5GB database

echo always > /sys/kernel/mm/transparent_hugepage/enabled
pgbench -c 50 -T 120 -r mydb 2>&1 | tee /tmp/thp-always.txt

# Test with THP = madvise
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
pgbench -c 50 -T 120 -r mydb 2>&1 | tee /tmp/thp-madvise.txt

# Test with THP = never
echo never > /sys/kernel/mm/transparent_hugepage/enabled
pgbench -c 50 -T 120 -r mydb 2>&1 | tee /tmp/thp-never.txt

# Compare results
echo "=== THP Impact Comparison ==="
for f in /tmp/thp-{always,madvise,never}.txt; do
    echo "--- $f ---"
    grep -E "tps|latency average|latency stddev" $f
done
```

## Redis and THP

Redis is even more sensitive to THP than PostgreSQL due to its persistence model:

### Why THP Hurts Redis

1. **BGSAVE/BGREWRITEAOF**: Redis forks to write snapshots or AOF rewrites. With THP enabled, the fork triggers massive copy-on-write operations on 2MB pages for every write during the save operation.

2. **Copy-on-write amplification**: A 2MB THP page copied due to 1 byte of write = 2MB memory consumed + 2MB I/O. With 100 writes in a 2MB region, 100 page copies occur vs. 100 with standard pages — effectively the same, but THP page copies take longer.

3. **Memory overhead**: Redis with THP enabled can use 2-4x more memory during BGSAVE than without THP.

### Redis Warning and Fix

```bash
# Redis logs this warning if THP is enabled:
# WARNING you have Transparent Huge Pages (THP) support enabled in your kernel.
# This will create latency and memory usage issues with Redis.
# To fix this issue run the command 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'
# as root, and add it to your /etc/rc.local in order to retain the setting after a reboot.

# Fix for Redis (both THP and memory overcommit):
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo 1 > /proc/sys/vm/overcommit_memory

# In systemd service for Redis:
cat >> /etc/systemd/system/redis.service << 'EOF'

[Service]
# ... existing service configuration
ExecStartPre=/bin/bash -c "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled || true"
EOF
```

### Redis Kubernetes Pod Configuration

```yaml
# Redis pod with init container to configure THP
# Requires privileged init container - appropriate for managed Redis deployment
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: redis
spec:
  serviceName: redis
  replicas: 3
  selector:
    matchLabels:
      app: redis
  template:
    spec:
      initContainers:
        - name: configure-system
          image: busybox:1.36
          securityContext:
            privileged: true  # Required to modify /sys
          command:
            - sh
            - -c
            - |
              # Disable THP for Redis
              if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
                echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
                echo "THP set to madvise"
              fi
              if [ -f /sys/kernel/mm/transparent_hugepage/defrag ]; then
                echo defer > /sys/kernel/mm/transparent_hugepage/defrag
                echo "THP defrag set to defer"
              fi
              # Set overcommit for fork-based persistence
              sysctl -w vm.overcommit_memory=1
          volumeMounts:
            - name: sys
              mountPath: /sys
      volumes:
        - name: sys
          hostPath:
            path: /sys
```

## Kubernetes and THP Management

### Node-Level THP Configuration with DaemonSet

```yaml
# Configure THP on all nodes via privileged DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: thp-disable
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: thp-disable
  template:
    metadata:
      labels:
        name: thp-disable
    spec:
      # Run on all nodes
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
        - key: node-role.kubernetes.io/master
          operator: Exists
          effect: NoSchedule
      hostPID: true
      hostNetwork: false
      initContainers:
        - name: configure-thp
          image: alpine:3.19
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              set -e
              echo "Configuring THP on $(hostname)..."

              # Set THP to madvise (recommended for mixed workloads)
              echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
              echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

              # Tune khugepaged
              echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

              echo "THP configured:"
              cat /sys/kernel/mm/transparent_hugepage/enabled
              cat /sys/kernel/mm/transparent_hugepage/defrag
          volumeMounts:
            - name: sys
              mountPath: /sys
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 10Mi
            limits:
              cpu: 5m
              memory: 20Mi
      volumes:
        - name: sys
          hostPath:
            path: /sys
```

### Per-Pod Huge Page Requests

For applications that benefit from explicit huge pages (not THP), Kubernetes supports 2Mi huge page resource requests:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-huge-pages
  namespace: production
spec:
  containers:
    - name: postgres
      image: postgres:16-alpine
      env:
        - name: POSTGRES_HUGE_PAGES
          value: "on"
        - name: POSTGRES_SHARED_BUFFERS
          value: "2GB"
      resources:
        requests:
          cpu: "4"
          memory: 16Gi
          hugepages-2Mi: 2Gi  # Request 2GB of 2Mi huge pages
        limits:
          cpu: "8"
          memory: 16Gi
          hugepages-2Mi: 2Gi  # Must equal request for huge pages

      volumeMounts:
        - name: hugepages
          mountPath: /hugepages

  volumes:
    - name: hugepages
      emptyDir:
        medium: HugePages-2Mi
```

```bash
# Verify node has pre-allocated huge pages
kubectl get node worker-1 -o jsonpath='{.status.allocatable.hugepages-2Mi}'
# 2Gi

# Check pre-allocated huge pages on the node
cat /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
cat /sys/kernel/mm/hugepages/hugepages-2048kB/free_hugepages
```

## Measuring THP Impact

### /proc/vmstat Analysis

```bash
# Key THP counters in /proc/vmstat
grep -E "^thp_" /proc/vmstat

# Key metrics:
# thp_fault_alloc        - THP allocated on page fault (success)
# thp_fault_fallback     - THP requested but fell back to small pages (fragmentation)
# thp_fault_fallback_charge - Failed due to memory cgroup limits
# thp_collapse_alloc     - khugepaged successfully collapsed pages to THP
# thp_collapse_alloc_failed - khugepaged collapse failed
# thp_split_page         - THP split back to small pages
# thp_split_page_failed  - THP split attempted but failed
# thp_deferred_split_page - THP pages queued for splitting
# thp_zero_page_alloc    - THP zero pages allocated
# thp_zero_page_alloc_failed - THP zero page allocation failed

# Watch for high fallback rate (indicates fragmentation):
watch -n 5 'awk "/^thp_fault_alloc|^thp_fault_fallback|^thp_collapse_alloc|^thp_split_page/" /proc/vmstat'

# Calculate THP hit rate
THP_ALLOC=$(grep thp_fault_alloc /proc/vmstat | awk '{print $2}')
THP_FALLBACK=$(grep thp_fault_fallback /proc/vmstat | awk '{print $2}')
TOTAL=$((THP_ALLOC + THP_FALLBACK))
HIT_RATE=$(echo "scale=2; $THP_ALLOC * 100 / $TOTAL" | bc)
echo "THP hit rate: ${HIT_RATE}%"
# < 80% hit rate with always mode = significant fragmentation, consider madvise
```

### Measuring THP Impact with perf

```bash
# Profile TLB misses before and after THP change
# Before: THP = never
echo never > /sys/kernel/mm/transparent_hugepage/enabled
perf stat -e dTLB-loads,dTLB-load-misses,iTLB-loads,iTLB-load-misses \
  -p $(pgrep postgres | head -1) \
  sleep 30

# Example output (high TLB miss rate with small pages):
# 45,234,789      dTLB-loads
#  3,456,789      dTLB-load-misses          #   7.64% of all dTLB cache accesses
#  9,876,543      iTLB-loads
#    345,678      iTLB-load-misses          #   3.50% of all iTLB cache accesses

# After: THP = madvise (PostgreSQL uses MADV_HUGEPAGE for shared buffers in some configs)
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
perf stat -e dTLB-loads,dTLB-load-misses,iTLB-loads,iTLB-load-misses \
  -p $(pgrep postgres | head -1) \
  sleep 30

# Example output (lower TLB miss rate with huge pages):
# 45,123,456      dTLB-loads
#    567,890      dTLB-load-misses          #   1.26% of all dTLB cache accesses (↓83%)
#  9,789,012      iTLB-loads
#     89,012      iTLB-load-misses          #   0.91% of all iTLB cache accesses

# Profile memory access patterns
perf record -e mem-loads,mem-stores -p $(pgrep postgres | head -1) sleep 10
perf report --sort=dso,sym --no-children | head -40
```

### Measuring Defragmentation Stalls

```bash
# Monitor memory compaction activity
grep -E "compact_" /proc/vmstat
# compact_migrate_scanned  - pages scanned during migration
# compact_free_scanned     - pages scanned for free regions
# compact_isolated         - pages isolated for compaction
# compact_stall            - processes stalled for compaction
# compact_fail             - compaction attempts that failed
# compact_success          - successful compaction operations

# High compact_stall = processes being blocked for THP defragmentation
watch -n 1 'grep compact_stall /proc/vmstat'

# Detailed compaction statistics
cat /proc/pagetypeinfo
# Shows fragmentation of memory zones

# Check for compaction-related latency in kernel tracing
perf trace -e mm:mm_compaction_begin,mm:mm_compaction_end \
  -p $(pgrep postgres | head -1) 2>&1 | \
  awk '/mm_compaction_end/ { print "Compaction stall:", $0 }' | head -20
```

### bpftrace Script for THP Latency

```bash
# Measure time processes spend blocked in memory compaction
bpftrace -e '
kprobe:try_to_compact_pages {
    @start[tid] = nsecs;
}

kretprobe:try_to_compact_pages {
    $start = @start[tid];
    if ($start != 0) {
        $lat_us = (nsecs - $start) / 1000;
        @compaction_lat_us = hist($lat_us);
        if ($lat_us > 1000) {  // > 1ms
            printf("Process %s (PID %d) stalled for compaction: %dμs\n",
                   comm, pid, $lat_us);
        }
        delete(@start[tid]);
    }
}

interval:s:30 {
    printf("=== Memory Compaction Latency Distribution ===\n");
    print(@compaction_lat_us);
    clear(@compaction_lat_us);
}
'
```

## Workload-Specific Recommendations

### Recommendation Summary

```bash
#!/bin/bash
# thp-configure.sh - Configure THP based on workload type
WORKLOAD=${1:-mixed}

case "$WORKLOAD" in
    postgresql)
        # PostgreSQL: madvise + static huge pages preferred
        echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
        echo defer > /sys/kernel/mm/transparent_hugepage/defrag
        # PostgreSQL manages its own huge page allocation
        # Pre-allocate static huge pages for shared_buffers
        SHARED_BUFFERS_MB=4096  # Match postgresql.conf shared_buffers
        HUGE_PAGES_NEEDED=$((SHARED_BUFFERS_MB / 2))
        echo $HUGE_PAGES_NEEDED > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
        echo "PostgreSQL: THP=madvise, static huge pages=$HUGE_PAGES_NEEDED"
        ;;

    redis)
        # Redis: madvise to avoid fork copy-on-write amplification
        echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
        echo defer > /sys/kernel/mm/transparent_hugepage/defrag
        sysctl -w vm.overcommit_memory=1
        echo "Redis: THP=madvise, overcommit=1"
        ;;

    mongodb)
        # MongoDB: madvise, MongoDB uses MADV_HUGEPAGE for its cache
        echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
        echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
        echo "MongoDB: THP=madvise, defrag=defer+madvise"
        ;;

    jvm)
        # Java/JVM: madvise, JVM uses MADV_HUGEPAGE for heap
        echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
        echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
        # Also set JVM flags: -XX:+UseTransparentHugePages
        echo "JVM: THP=madvise, defrag=defer+madvise"
        echo "Set JVM flags: -XX:+UseTransparentHugePages"
        ;;

    hpc|ml)
        # HPC/ML: always, working sets are large and access patterns are predictable
        echo always > /sys/kernel/mm/transparent_hugepage/enabled
        echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
        echo "HPC/ML: THP=always, defrag=defer+madvise"
        ;;

    mixed|*)
        # Mixed/Kubernetes node: madvise is safest default
        echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
        echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
        echo "Mixed workload: THP=madvise, defrag=defer+madvise"
        ;;
esac

echo ""
echo "Current settings:"
echo "  enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo "  defrag:  $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
```

The consistent recommendation across almost all latency-sensitive database workloads is `madvise` for THP enabled and `defer` or `defer+madvise` for defrag. The `always` setting that ships as default in many Linux distributions is appropriate only for scientific computing and ML training where memory access patterns are large, predictable, and where millisecond-scale latency spikes during page promotion are acceptable in exchange for sustained throughput improvements. For Kubernetes nodes hosting mixed workloads, `madvise` provides a safe foundation that allows individual pods requiring huge pages to opt in explicitly while protecting latency-sensitive applications from unexpected stalls.
