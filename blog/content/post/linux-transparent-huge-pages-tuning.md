---
title: "Linux Transparent Huge Pages: Performance Tuning for Databases and JVMs"
date: 2029-01-11T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Transparent Huge Pages", "THP", "Databases", "JVM", "Kernel Tuning"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise guide to Linux Transparent Huge Pages (THP) configuration, covering the performance impact on databases and JVMs, khugepaged tuning, defrag strategies, and per-process control for production workloads."
more_link: "yes"
url: "/linux-transparent-huge-pages-tuning/"
---

Linux Transparent Huge Pages (THP) is a kernel feature that automatically uses 2MB memory pages (huge pages) instead of the standard 4KB pages where possible, reducing Translation Lookaside Buffer (TLB) pressure and improving memory access performance. While THP can deliver substantial throughput gains for memory-intensive workloads, it introduces latency spikes and operational complexity that make it problematic for latency-sensitive databases and Java applications without careful tuning. This guide provides the operational knowledge needed to configure THP correctly for production systems running databases, JVMs, and mixed workloads.

<!--more-->

## Understanding THP Architecture

The kernel manages THP through two subsystems: the `khugepaged` daemon, which proactively scans for page promotion opportunities, and the fault-time allocation path, which attempts to satisfy memory faults with huge pages immediately.

### TLB and Page Table Impact

A CPU's TLB caches virtual-to-physical address translations. With 4KB pages, a 32GB working set requires over 8 million TLB entries. Modern CPUs provide 1,500–6,000 TLB entries, causing frequent TLB misses and page table walks. With 2MB huge pages, the same 32GB working set needs only ~16,000 entries, dramatically reducing TLB miss rates.

```bash
# Measure TLB miss rate before and after THP changes
# Requires perf with hardware event support
perf stat -e \
  dTLB-loads,dTLB-load-misses,\
  dTLB-stores,dTLB-store-misses,\
  iTLB-loads,iTLB-load-misses \
  -p $(pgrep -f postgres | head -1) \
  sleep 30

# Sample output for PostgreSQL with THP disabled:
#   dTLB-loads:      4,832,910,445
#   dTLB-load-misses:   98,221,034  # 2.03% miss rate
#
# Sample output with THP enabled:
#   dTLB-loads:      4,821,003,221
#   dTLB-load-misses:   12,441,881  # 0.26% miss rate
```

## Current THP Configuration Inspection

```bash
# View current THP settings
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# Brackets indicate current setting

cat /sys/kernel/mm/transparent_hugepage/defrag
# always defer defer+madvise [madvise] never

cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# 10000

cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 4096

# Check huge page usage statistics
grep -E 'AnonHugePages|HugePages_Total|HugePages_Free|Hugepagesize' /proc/meminfo
# AnonHugePages:   3276800 kB
# HugePages_Total:       0
# HugePages_Free:        0
# Hugepagesize:       2048 kB

# Per-process THP usage
pid=$(pgrep -f "mysqld" | head -1)
grep AnonHugePages /proc/${pid}/smaps_rollup
# AnonHugePages:    819200 kB  ← 400 huge pages used by this process

# Full smaps detail for a specific memory region
grep -A 20 "heap" /proc/${pid}/smaps | head -40
```

## THP Defrag Modes Explained

The `defrag` setting controls how aggressively the kernel compacts memory to create contiguous 2MB regions.

```bash
# defrag=always: Synchronous compaction on every fault attempt
# IMPACT: Worst for latency. Stalls the faulting process during compaction.
echo always > /sys/kernel/mm/transparent_hugepage/defrag

# defrag=defer: Asynchronous compaction via kcompactd. Low latency impact.
# THP allocation falls back to 4KB if 2MB not immediately available.
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# defrag=defer+madvise: defer for all, but synchronous for madvise(MADV_HUGEPAGE) regions
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# defrag=madvise: Only compact for regions explicitly requesting huge pages
# Recommended for mixed workloads
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag

# defrag=never: No compaction, huge pages only if immediately available
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

## Workload-Specific THP Recommendations

### PostgreSQL

PostgreSQL shared buffers benefit significantly from THP, but its copy-on-write fork model causes "THP bloat" when worker processes inherit huge pages from the parent, leading to memory waste and compaction stalls.

```bash
# Recommended PostgreSQL THP configuration
# Enable THP globally but use madvise defrag to avoid stalls
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# PostgreSQL 14+ supports huge_pages = try (uses madvise internally)
# In postgresql.conf:
# huge_pages = try          # try to use, fall back gracefully
# huge_page_size = 0        # 0 = use system default (2MB)

# Check if PostgreSQL is using huge pages
psql -c "SELECT name, setting FROM pg_settings WHERE name LIKE 'huge_pages%';"
#        name       | setting
# ------------------+---------
#  huge_pages       | try
#  huge_page_size   | 0

# Verify huge pages in use
grep HugePages /proc/$(pgrep -xf 'postgres: checkpointer' | head -1)/status
# HugePages_Anon:          8192  ← 8192 huge pages (16GB)
# HugePages_Shmem:             0
# HugePages_File:              0
# HugePages_Shared:            0
# HugePages_Private:           0
```

```ini
# /etc/sysctl.d/60-postgresql-thp.conf
# Static huge pages for PostgreSQL shared_buffers
# Set to (shared_buffers / 2MB) + 20% headroom
# For shared_buffers=32GB: (32768 / 2) + 20% = 19,661 ≈ 20000
vm.nr_hugepages = 20000
vm.hugetlb_shm_group = 26          # postgres GID
kernel.shmmax = 34359738368        # 32GB + overhead
kernel.shmall = 8388608            # 32GB in 4KB pages
```

### MySQL / InnoDB

InnoDB's buffer pool benefits from huge pages. MySQL explicitly supports static huge pages via `large_pages=ON`.

```bash
# MySQL THP configuration
# MySQL recommends disabling THP and using static huge pages instead

# Step 1: Disable THP for new allocations
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Step 2: Allocate static huge pages for InnoDB buffer pool
# For innodb_buffer_pool_size=64G:
echo 32768 > /proc/sys/vm/nr_hugepages   # 64GB / 2MB per page

# Step 3: Enable in MySQL configuration
# /etc/mysql/mysql.conf.d/huge-pages.cnf
cat > /etc/mysql/mysql.conf.d/huge-pages.cnf << 'EOF'
[mysqld]
large_pages = ON
innodb_buffer_pool_size = 68719476736  # 64GB
innodb_buffer_pool_instances = 16
EOF

# Verify MySQL is using huge pages
mysql -e "SHOW VARIABLES LIKE 'large_pages';"
# +-------------+-------+
# | Variable_name | Value |
# +-------------+-------+
# | large_pages | ON    |
```

### Redis

Redis uses a fork-based persistence model (RDB/AOF rewrite) that is severely impacted by THP. When a fork occurs, copy-on-write causes huge pages to be split and remapped, leading to memory spikes and latency stalls.

```bash
# Redis explicitly warns about THP in logs:
# WARNING you have Transparent Huge Pages (THP) support enabled in your kernel.
# This will create latency and memory usage issues with Redis.

# Recommended: Disable THP entirely for Redis hosts
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# For containers, apply per-process using madvise(MADV_NOHUGEPAGE)
# Redis 6.2+ does this automatically when thp is 'madvise' at system level
```

### Java Virtual Machine (JVM)

JVMs benefit enormously from THP for large heaps, but require careful configuration to avoid GC pause amplification caused by compaction events coinciding with GC.

```bash
# JVM THP configuration
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# Tune khugepaged to avoid scanning during business hours
# (adjust scan aggressiveness based on application requirements)
echo 20000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 4096  > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# Enable huge pages at JVM level (JDK 8u151+, JDK 11+)
# JAVA_OPTS for a 16GB heap application server:
java \
  -Xms16g \
  -Xmx16g \
  -XX:+UseG1GC \
  -XX:+UseTransparentHugePages \
  -XX:LargePageSizeInBytes=2m \
  -XX:+PerfDisableSharedMem \
  -jar myapp.jar
```

## khugepaged Tuning

`khugepaged` is the kernel thread responsible for promoting small pages into huge pages asynchronously.

```bash
# View all khugepaged parameters
ls /sys/kernel/mm/transparent_hugepage/khugepaged/
# alloc_sleep_millisecs  max_ptes_none  pages_collapsed  scan_sleep_millisecs
# defrag                 max_ptes_swap  pages_to_scan

# Explanation of key parameters:
# scan_sleep_millisecs: Time between scans (default: 10000ms = 10s)
# pages_to_scan: Pages examined per scan round (default: 4096)
# max_ptes_none: Max empty PTEs allowed in a promotion candidate region (default: 511)
# max_ptes_swap: Max swapped PTEs allowed in a promotion candidate (default: 64)
# alloc_sleep_millisecs: Sleep when allocation fails (default: 60000ms)

# Aggressive promotion for memory-bound workloads
echo 1000  > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 16384 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
echo 0     > /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none

# Conservative promotion for latency-sensitive workloads
echo 60000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 512   > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# Monitor khugepaged activity
cat /proc/vmstat | grep -E 'thp_|huge'
# thp_fault_alloc                    14293820
# thp_fault_fallback                   422103  ← fallbacks indicate fragmentation
# thp_fault_fallback_charge                 0
# thp_collapse_alloc                   891203
# thp_collapse_alloc_failed             12034
# thp_file_alloc                            0
# thp_file_mapped                           0
# thp_split_page                        83201
# thp_split_page_failed                     0
# thp_deferred_split_page             4421031
# thp_split_pmd                        83201
# thp_zero_page_alloc                       1
```

## Making THP Changes Persistent

Sysfs changes do not survive reboots. Use systemd units and udev rules for persistence.

```bash
# Method 1: rc.local (simple but not recommended for systemd systems)
cat >> /etc/rc.local << 'EOF'
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer   > /sys/kernel/mm/transparent_hugepage/defrag
EOF

# Method 2: systemd service (recommended)
cat > /etc/systemd/system/thp-config.service << 'EOF'
[Unit]
Description=Configure Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=basic.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled"
ExecStart=/bin/bash -c "echo defer > /sys/kernel/mm/transparent_hugepage/defrag"
ExecStart=/bin/bash -c "echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs"
ExecStart=/bin/bash -c "echo 4096 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan"

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now thp-config.service
systemctl status thp-config.service
```

## Per-Process THP Control

Applications can opt in or out of THP independently of the system-wide setting using `madvise`.

```go
// Go example: opting out of THP for a specific memory region
// Requires golang.org/x/sys/unix
package memory

import (
    "fmt"
    "unsafe"

    "golang.org/x/sys/unix"
)

// AllocNoHugePages allocates a byte slice and advises the kernel
// not to promote it to huge pages. Useful for small, frequently
// written buffers where THP would waste memory.
func AllocNoHugePages(size int) ([]byte, error) {
    buf := make([]byte, size)
    ptr := unsafe.Pointer(&buf[0])

    if err := unix.Madvise(
        unsafe.Slice((*byte)(ptr), size),
        unix.MADV_NOHUGEPAGE,
    ); err != nil {
        return nil, fmt.Errorf("madvise MADV_NOHUGEPAGE: %w", err)
    }
    return buf, nil
}

// AllocHugePages allocates a byte slice and requests huge page promotion.
// Requires system-level THP set to 'madvise' or 'always'.
func AllocHugePages(size int) ([]byte, error) {
    // Align size to 2MB for efficient huge page usage
    aligned := (size + (1<<21 - 1)) &^ (1<<21 - 1)
    buf := make([]byte, aligned)
    ptr := unsafe.Pointer(&buf[0])

    if err := unix.Madvise(
        unsafe.Slice((*byte)(ptr), aligned),
        unix.MADV_HUGEPAGE,
    ); err != nil {
        return nil, fmt.Errorf("madvise MADV_HUGEPAGE: %w", err)
    }
    return buf[:size], nil
}
```

## THP in Container Environments

Containers share the host kernel's THP settings. Kubernetes workloads running in containers are subject to the node's THP configuration.

```yaml
# kubernetes/daemonset-thp-config.yaml
# DaemonSet to configure THP on all nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: thp-config
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: thp-config
  template:
    metadata:
      labels:
        app: thp-config
    spec:
      hostIPC: true
      hostPID: true
      tolerations:
        - effect: NoSchedule
          operator: Exists
        - effect: NoExecute
          operator: Exists
      initContainers:
        - name: thp-config
          image: registry.corp.example.com/busybox:1.36.1
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              set -e
              echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
              echo defer   > /sys/kernel/mm/transparent_hugepage/defrag
              echo 10000   > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
              echo 4096    > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
              echo "THP configuration applied successfully"
          volumeMounts:
            - name: sys
              mountPath: /sys
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 8Mi
            limits:
              cpu: 10m
              memory: 16Mi
      volumes:
        - name: sys
          hostPath:
            path: /sys
```

## Monitoring THP Performance Impact

### Prometheus Alerting Rules

```yaml
# prometheus/rules/thp-alerts.yaml
groups:
  - name: transparent_huge_pages
    interval: 60s
    rules:
      - alert: HighTHPFaultFallbackRate
        expr: |
          rate(node_vmstat_thp_fault_fallback[5m]) /
          (rate(node_vmstat_thp_fault_alloc[5m]) + rate(node_vmstat_thp_fault_fallback[5m]))
          > 0.10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High THP fault fallback rate on {{ $labels.instance }}"
          description: >
            THP fault fallback rate is {{ $value | humanizePercentage }}.
            This indicates memory fragmentation preventing huge page allocation.
            Consider running echo 1 > /proc/sys/vm/compact_memory or reviewing
            khugepaged configuration.

      - alert: HighTHPSplitRate
        expr: rate(node_vmstat_thp_split_page[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High THP split rate on {{ $labels.instance }}"
          description: >
            THP pages are being split at {{ $value }} splits/sec on {{ $labels.instance }}.
            Splitting indicates workloads are touching only portions of huge pages,
            suggesting THP may be counterproductive for this workload.
```

### Shell-Based Performance Validation

```bash
#!/usr/bin/env bash
# scripts/thp-benchmark.sh
# Measures the performance impact of THP settings changes

set -euo pipefail

WORKLOAD_PID="${1:-$(pgrep -f java | head -1)}"
DURATION=60

echo "=== THP Performance Benchmark ==="
echo "Target PID: ${WORKLOAD_PID}"
echo "Duration: ${DURATION}s"
echo

echo "--- Current THP State ---"
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag
echo

echo "--- Huge Page Usage for PID ${WORKLOAD_PID} ---"
grep AnonHugePages /proc/${WORKLOAD_PID}/smaps_rollup

echo "--- THP Statistics (${DURATION}s interval) ---"
start_alloc=$(grep thp_fault_alloc /proc/vmstat | awk '{print $2}')
start_fallback=$(grep thp_fault_fallback /proc/vmstat | awk '{print $2}')
start_split=$(grep thp_split_page /proc/vmstat | awk '{print $2}')

sleep "${DURATION}"

end_alloc=$(grep thp_fault_alloc /proc/vmstat | awk '{print $2}')
end_fallback=$(grep thp_fault_fallback /proc/vmstat | awk '{print $2}')
end_split=$(grep thp_split_page /proc/vmstat | awk '{print $2}')

allocs=$((end_alloc - start_alloc))
fallbacks=$((end_fallback - start_fallback))
splits=$((end_split - start_split))
total=$((allocs + fallbacks))

echo "THP allocs/s:    $((allocs / DURATION))"
echo "THP fallbacks/s: $((fallbacks / DURATION))"
echo "THP splits/s:    $((splits / DURATION))"
if [ "${total}" -gt 0 ]; then
    echo "Fallback rate:   $(echo "scale=1; ${fallbacks} * 100 / ${total}" | bc)%"
fi

echo
echo "--- TLB Miss Rate ---"
perf stat -e dTLB-load-misses,dTLB-loads \
  -p "${WORKLOAD_PID}" \
  sleep 10 2>&1 | grep -E "dTLB|TLB"
```

## Decision Framework: THP Configuration Matrix

| Workload | THP Enabled | Defrag | khugepaged | Notes |
|---|---|---|---|---|
| PostgreSQL | madvise | defer+madvise | Default | Use huge_pages=try in postgresql.conf |
| MySQL/InnoDB | never | never | N/A | Use static huge pages instead |
| Redis | never | never | N/A | Fork-based persistence incompatible |
| Elasticsearch | madvise | defer | Reduced | Large heap benefits; disable bootstrap check |
| Java/G1GC | madvise | defer | Moderate | Use -XX:+UseTransparentHugePages |
| Java/ZGC | always | defer | Aggressive | ZGC benefits most from huge pages |
| OLAP (Spark) | always | defer | Aggressive | Large sequential scans benefit greatly |
| NGINX/HAProxy | never | never | N/A | Small working sets, THP overhead > benefit |

## Summary

Transparent Huge Pages require workload-specific tuning rather than a one-size-fits-all configuration. The key operational principles are:

- Never use `defrag=always` in production; it causes synchronous compaction stalls
- Redis, MySQL, and other fork-based processes should run with THP disabled or managed via static huge pages
- PostgreSQL and JVM workloads benefit significantly from `madvise` mode with `defer` defrag
- Monitor `thp_fault_fallback` and `thp_split_page` vmstat counters to detect misconfiguration
- Use a DaemonSet to enforce THP settings consistently across Kubernetes node pools
- Validate THP changes with perf TLB statistics and application-level latency benchmarks before production rollout

## Advanced: Huge Page Sizing Beyond 2MB

On x86-64 systems with Intel/AMD CPUs that support 1GB huge pages, certain workloads (large in-memory databases, HPC) can benefit from the next tier of huge page size.

```bash
# Check for 1GB huge page support
grep pdpe1gb /proc/cpuinfo && echo "1GB pages supported" || echo "Not supported"

# Allocate 1GB huge pages at boot (cannot be allocated dynamically)
# /etc/default/grub:
# GRUB_CMDLINE_LINUX="default_hugepagesz=1G hugepagesz=1G hugepages=32 hugepagesz=2M hugepages=512"

# After rebooting with the parameter:
grep HugePages /proc/meminfo
# HugePages_Total:      32         ← 1GB pages
# HugePages_Free:       30
# Hugepagesize:    1048576 kB      ← 1GB

# Use 1GB pages with PostgreSQL (postgresql.conf):
# huge_page_size = 1GB   # PostgreSQL 14+
# huge_pages = try

# Verify in PostgreSQL:
psql -c "SELECT pg_size_pretty(current_setting('huge_page_size')::bigint);"
```

## NUMA-Aware Huge Page Allocation

On multi-socket NUMA systems, huge page allocation and placement matters for performance:

```bash
# View huge page allocation per NUMA node
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Allocate huge pages on specific NUMA nodes
# Allocate 5000 huge pages on NUMA node 0 (local to socket 0)
echo 5000 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
# Allocate 5000 huge pages on NUMA node 1 (local to socket 1)
echo 5000 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Check NUMA memory balance for a running process
numastat -p $(pgrep -xf 'postgres' | head -1)
#                           Node 0          Node 1           Total
#                  --------------- --------------- ---------------
# Numa_Hit                1845234         1823091         3668325
# Numa_Miss                  8421            9102           17523
# Interleave_Hit              145             142             287
# Local_Node              1845234         1823091         3668325
# Other_Node                 8421            9102           17523
# Numa_Miss > 5% indicates poor NUMA locality

# Pin a process to a specific NUMA node for predictable huge page allocation
numactl --membind=0 --cpunodebind=0 -- postgres -D /var/lib/postgresql/data
```

## Memory Compaction: Manual and Automatic

When THP fallback rates are high due to memory fragmentation, proactive compaction can help:

```bash
# Manual compaction (momentary stall, then improved huge page availability)
echo 1 > /proc/sys/vm/compact_memory

# Check compaction effectiveness
before=$(grep thp_fault_fallback /proc/vmstat | awk '{print $2}')
echo 1 > /proc/sys/vm/compact_memory
sleep 5
after=$(grep thp_fault_fallback /proc/vmstat | awk '{print $2}')
echo "Fallbacks before: ${before}, after (5s): ${after}"

# View compaction statistics
grep 'compact_' /proc/vmstat
# compact_migrate_scanned        1234567
# compact_free_scanned           8901234
# compact_isolated               3456789
# compact_stall                     1234   ← synchronous compaction events
# compact_fail                        56
# compact_success                   1178
# compact_daemon_wake                 89   ← kcompactd invocations

# Tune compaction aggressiveness
# compaction_proactiveness: 0=off, 100=very aggressive (default: 20)
echo 50 > /proc/sys/vm/compaction_proactiveness

# watermark_scale_factor: controls when kcompactd wakes (default: 10 = 0.1%)
# Higher values wake kcompactd more aggressively before memory is tight
echo 200 > /proc/sys/vm/watermark_scale_factor
```

## THP Interaction with Swap

THP and swap interact in ways that can cause severe performance problems:

```bash
# Check swap pressure
vmstat 1 5 | awk '{print NR": r=" $1 " b=" $2 " swpd=" $3 " si=" $7 " so=" $8}'

# THP pages that are swapped in must be reconstructed from 512 small pages
# This causes 512x the I/O compared to swapping small pages
# If swap is in use alongside THP, disable THP to reduce swap amplification

# Check if huge pages are being split before swap
grep thp_deferred_split_page /proc/vmstat
# thp_deferred_split_page    421034  ← pages being split to enable partial swap

# Recommended: If swap is active on a system, disable THP
swaps=$(cat /proc/swaps | grep -c '^/' || true)
if [ "${swaps}" -gt 0 ]; then
    echo "Swap is active. Disabling THP to prevent swap amplification."
    echo never > /sys/kernel/mm/transparent_hugepage/enabled
    echo never > /sys/kernel/mm/transparent_hugepage/defrag
fi

# Persistent sysctl for swap + THP environments
cat >> /etc/sysctl.d/99-memory-tuning.conf << 'EOF'
# Minimize swapping for workloads that benefit from page cache
vm.swappiness = 10
# Reduce dirty page writeback to improve write latency consistency
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF
sysctl --system
```
