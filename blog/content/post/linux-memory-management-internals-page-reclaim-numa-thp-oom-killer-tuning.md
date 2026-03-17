---
title: "Linux Memory Management Internals: Page Reclaim, NUMA Balancing, THP Defragmentation, and OOM Killer Tuning"
date: 2031-11-07T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "NUMA", "THP", "OOM Killer", "Kernel", "Performance Tuning"]
categories: ["Linux", "Systems Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth guide to Linux kernel memory management covering page reclaim algorithms, NUMA balancing policies, Transparent Huge Page defragmentation strategies, and OOM killer tuning for production workloads."
more_link: "yes"
url: "/linux-memory-management-internals-page-reclaim-numa-thp-oom-killer-tuning/"
---

Linux memory management is one of the most consequential and least understood subsystems for production performance. The decisions made by kswapd, the NUMA balancing daemon, the THP defragmentation path, and the OOM killer can mean the difference between sub-millisecond response times and multi-second stalls. This guide provides the internals knowledge required to tune each subsystem for real workloads.

<!--more-->

# Linux Memory Management Internals: Page Reclaim, NUMA Balancing, THP Defragmentation, and OOM Killer Tuning

## Memory Management Architecture Overview

Linux organizes physical memory into a hierarchy:

```
System
├── NUMA Nodes (one per physical CPU socket or NUMA domain)
│   ├── Zones
│   │   ├── DMA (0–16 MB, legacy ISA)
│   │   ├── DMA32 (0–4 GB, 32-bit DMA)
│   │   └── Normal (4 GB+, most allocations)
│   └── Pages
│       ├── Anonymous (stack, heap, mmap private)
│       └── File-backed (page cache, mmap shared)
```

Each zone maintains its own LRU lists and watermark thresholds. Understanding watermarks is the key to understanding reclaim triggers.

## Section 1: Page Reclaim Deep Dive

### 1.1 Memory Watermarks

Each zone has three watermarks that control reclaim behavior:

| Watermark | Default calculation | Behavior when crossed |
|---|---|---|
| `min` | `pages_low * 2/3` | Direct reclaim triggered for allocating processes |
| `low` | `sqrt(managed_pages) * 4` | `kswapd` wakes up |
| `high` | `pages_low + pages_min` | `kswapd` goes back to sleep |

```bash
# View current watermarks per zone
cat /proc/zoneinfo | grep -A5 "Node 0, zone   Normal"
# Output:
# Node 0, zone   Normal
#   pages free     1234567
#         min      65536
#         low      81920
#         high     98304

# View system-wide memory pressure
cat /proc/meminfo | grep -E "(MemFree|MemAvailable|Cached|SwapCached|Active|Inactive)"
```

### 1.2 Adjusting Watermarks

```bash
# Increase watermark_scale_factor to make kswapd more aggressive
# Values are in fractions of 10000 (default: 10 = 0.1%)
# Increase to 150 (1.5%) on systems with large memory and high allocation rates
echo 150 > /proc/sys/vm/watermark_scale_factor

# Persist via sysctl
cat >> /etc/sysctl.d/99-memory-tuning.conf << 'EOF'
# Raise watermarks to give kswapd more headroom before hitting min
vm.watermark_scale_factor = 150

# Reduce swappiness: prefer evicting page cache over anonymous memory
# 10 for latency-sensitive workloads, 1 for in-memory databases
vm.swappiness = 10

# Reduce the tendency to dirty a lot of memory before writebacks
vm.dirty_ratio = 10
vm.dirty_background_ratio = 3

# Increase vfs_cache_pressure to reclaim dentry/inode caches more aggressively
# Default 100; increase to 200 for workloads with large directory trees
vm.vfs_cache_pressure = 200
EOF
sysctl -p /etc/sysctl.d/99-memory-tuning.conf
```

### 1.3 LRU Lists and the CLOCK Algorithm

The kernel maintains four LRU lists per zone:

- **Active anonymous**: Recently accessed pages not backed by files
- **Inactive anonymous**: Candidates for swap eviction
- **Active file**: Recently accessed page cache entries
- **Inactive file**: Candidates for page cache eviction

The CLOCK (second-chance) algorithm moves pages between active and inactive lists based on the PG_referenced bit. Access via hardware sets the bit; the scanner clears it and promotes/demotes accordingly.

```bash
# View LRU list sizes per NUMA node
cat /proc/vmstat | grep -E "nr_(active|inactive)_(anon|file)"
# Sample output:
# nr_inactive_anon 123456
# nr_active_anon 456789
# nr_inactive_file 234567
# nr_active_file 567890

# Monitor reclaim rates in real time
vmstat -w 1 | awk 'NR==1 || NR==2 || NR>2{print}' | \
  awk '{printf "%-8s %-8s %-8s %-8s\n", $7, $8, $9, $10}'
# Columns: swpd (swap used), free, buff, cache
```

### 1.4 kswapd Tuning

`kswapd` is a per-NUMA-node kernel thread responsible for background reclaim. When it runs too aggressively, CPU time is wasted on scanning LRU lists. When it runs too conservatively, processes hit direct reclaim (synchronous, latency-impacting).

```bash
# Check if kswapd is spending significant CPU
top -bn1 | grep kswapd
# kswapd0  R  0.5  0.0  0 kswapd0

# Enable perf tracing of kswapd
perf trace -e 'vmscan:*' --duration 10 2>&1 | head -50

# Critical metric: direct reclaim rate (processes blocked waiting for memory)
cat /proc/vmstat | grep pgsteal_direct
# pgsteal_direct_normal 42000
# A non-zero and rising number indicates memory pressure requiring tuning
```

### 1.5 Monitoring Page Reclaim with eBPF

```c
// reclaim_tracer.bt (bpftrace script)
// Run: bpftrace reclaim_tracer.bt
tracepoint:vmscan:mm_vmscan_direct_reclaim_begin
{
    @direct_reclaim_start[tid] = nsecs;
    @direct_reclaim_count = count();
}

tracepoint:vmscan:mm_vmscan_direct_reclaim_end
/@direct_reclaim_start[tid]/
{
    $latency_us = (nsecs - @direct_reclaim_start[tid]) / 1000;
    @direct_reclaim_latency_us = hist($latency_us);
    delete(@direct_reclaim_start[tid]);
}

tracepoint:vmscan:mm_vmscan_kswapd_wake
{
    @kswapd_wakeups = count();
}

interval:s:10
{
    print(@direct_reclaim_count);
    print(@direct_reclaim_latency_us);
    print(@kswapd_wakeups);
    clear(@direct_reclaim_count);
    clear(@kswapd_wakeups);
}
```

## Section 2: NUMA Balancing

### 2.1 NUMA Architecture and Access Cost

On multi-socket servers, memory access latency differs depending on whether the accessing CPU is local (same socket) or remote (different socket). Remote memory access can be 1.5x–3x slower than local access.

```bash
# Identify NUMA topology
numactl --hardware
# Available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11
# node 0 size: 128773 MB
# node 0 free: 64231 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23
# node 1 size: 128774 MB
# node 1 free: 63822 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Check current NUMA statistics
numastat
# Per-node allocation statistics
```

### 2.2 Automatic NUMA Balancing

The kernel's AutoNUMA feature (controlled by `numa_balancing`) periodically unmaps pages and re-faults them to detect access patterns, then migrates pages toward the node doing the most accesses.

```bash
# Check AutoNUMA status
cat /proc/sys/kernel/numa_balancing
# 1 = enabled

# AutoNUMA scan rate tuning (in ms, default 1000)
# Lower = more aggressive scanning = more CPU overhead but faster migration
echo 250 > /proc/sys/kernel/numa_balancing_scan_delay_ms

# Maximum scan rate per second (default 1000 MB/s)
echo 2000 > /proc/sys/kernel/numa_balancing_scan_size_mb

# Persist
cat >> /etc/sysctl.d/99-numa.conf << 'EOF'
kernel.numa_balancing = 1
kernel.numa_balancing_scan_delay_ms = 500
kernel.numa_balancing_scan_size_mb = 1500
kernel.numa_balancing_scan_period_min_ms = 100
kernel.numa_balancing_scan_period_max_ms = 60000
EOF
```

### 2.3 NUMA Placement Policies

For workloads with known memory access patterns, explicit NUMA placement outperforms AutoNUMA.

```bash
# Pin a process to node 0 CPUs, allocate memory from node 0
numactl --cpunodebind=0 --membind=0 /usr/bin/redis-server /etc/redis.conf

# Interleaved allocation: distribute pages round-robin across all nodes
# Good for shared memory workloads that access uniformly across NUMA nodes
numactl --interleave=all /usr/bin/java -jar app.jar

# Preferred: use node 0 for allocation, fall back to node 1 if node 0 is full
numactl --preferred=0 /usr/bin/postgres -D /var/lib/postgresql/data

# Set NUMA policy for a running process
taskset -c 0-11 <pid>   # CPU affinity
echo 2 > /proc/<pid>/numa_maps  # Check current NUMA mappings
```

### 2.4 NUMA-Aware Memory Allocation in Applications

```c
// numa_alloc.c — demonstrate libnuma usage
#include <numa.h>
#include <numaif.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BUFFER_SIZE (1024 * 1024 * 256)  // 256 MB

int main(void) {
    if (numa_available() == -1) {
        fprintf(stderr, "NUMA not available\n");
        return 1;
    }

    int num_nodes = numa_num_configured_nodes();
    printf("NUMA nodes: %d\n", num_nodes);

    // Allocate on the local node of the current CPU
    int cpu = numa_node_of_cpu(sched_getcpu());
    printf("Current CPU NUMA node: %d\n", cpu);

    void *buf = numa_alloc_onnode(BUFFER_SIZE, cpu);
    if (!buf) {
        perror("numa_alloc_onnode");
        return 1;
    }

    // Touch all pages to actually allocate (demand paging)
    memset(buf, 0xAB, BUFFER_SIZE);

    // Verify placement
    int status[1];
    void *pages[1] = {buf};
    if (move_pages(0, 1, pages, NULL, status, 0) == 0) {
        printf("Buffer placed on NUMA node: %d\n", status[0]);
    }

    numa_free(buf, BUFFER_SIZE);
    return 0;
}
```

### 2.5 NUMA Statistics and Diagnosis

```bash
# Monitor NUMA migrations
watch -n1 'cat /proc/vmstat | grep numa'
# numa_hit          = allocations satisfied from preferred node
# numa_miss         = allocations that went to non-preferred node
# numa_foreign      = allocations from another node's perspective
# numa_interleave   = interleaved allocations
# numa_local        = allocations local to running CPU
# numa_other        = allocations not local to running CPU

# High numa_miss with AutoNUMA enabled suggests the scan period is too long
# or a workload with very short-lived allocations
```

## Section 3: Transparent Huge Pages

### 3.1 THP Internals

Transparent Huge Pages (THP) allows the kernel to use 2 MB pages (huge pages) for anonymous memory transparently. The benefit is reduced TLB pressure; the cost is fragmentation-induced latency during compaction.

```bash
# Check current THP configuration
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

cat /sys/kernel/mm/transparent_hugepage/defrag
# always defer defer+madvise [madvise] never

# THP statistics
cat /proc/vmstat | grep thp
# thp_fault_alloc 1234        — successful THP faults
# thp_fault_fallback 56       — fell back to 4K pages
# thp_collapse_alloc 789      — khugepaged collapsed pages
# thp_collapse_alloc_failed 10 — compaction needed but failed
# thp_split_page 234          — THP split due to partial unmap/remap
```

### 3.2 THP Configuration Strategies

```bash
# Strategy 1: always — maximize THP coverage, maximize latency risk
echo always > /sys/kernel/mm/transparent_hugepage/enabled
echo always > /sys/kernel/mm/transparent_hugepage/defrag

# Strategy 2: madvise — only use THP for regions explicitly marked
# Best for applications that benefit from THP but must avoid allocation latency
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Strategy 3: defer+madvise — use THP for madvised regions, defer compaction
# Best balance for most production workloads
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Strategy 4: never — disable THP entirely
# Required for some databases (MongoDB, Redis) that manage their own memory
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

### 3.3 Application-Level THP Hints

```c
// thp_hints.c
#include <sys/mman.h>
#include <stdlib.h>
#include <stdio.h>

#define HUGE_PAGE_SIZE (2 * 1024 * 1024)
#define ALLOC_SIZE     (256 * 1024 * 1024)  // 256 MB

int main(void) {
    // Allocate aligned to huge page boundary
    void *buf;
    posix_memalign(&buf, HUGE_PAGE_SIZE, ALLOC_SIZE);

    // Advise kernel to use huge pages for this region
    // Only effective when THP is in madvise mode
    if (madvise(buf, ALLOC_SIZE, MADV_HUGEPAGE) != 0) {
        perror("madvise MADV_HUGEPAGE");
    }

    // For regions where THP would hurt (e.g., many small allocations)
    // advise against them
    void *small_region = malloc(65536);
    if (madvise(small_region, 65536, MADV_NOHUGEPAGE) != 0) {
        perror("madvise MADV_NOHUGEPAGE");
    }

    // MADV_COLLAPSE: force immediate THP compaction (Linux 6.1+)
    // Useful to pre-warm a region before latency-critical operation
    if (madvise(buf, ALLOC_SIZE, MADV_COLLAPSE) != 0) {
        perror("madvise MADV_COLLAPSE");
        // Not fatal — kernel will collapse opportunistically
    }

    free(buf);
    free(small_region);
    return 0;
}
```

### 3.4 Khugepaged Tuning

`khugepaged` is the kernel thread that scans for 4K page ranges that can be collapsed into a THP. Its scan rate controls the trade-off between compaction throughput and CPU overhead.

```bash
# Tune khugepaged scan rate
# pages_to_scan: pages scanned per scan cycle (default: 4096)
echo 8192 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# scan_sleep_millisecs: sleep between scan cycles (default: 10000 = 10s)
# Lower values = more aggressive collapse
echo 2000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# alloc_sleep_millisecs: sleep after failed allocation (default: 60000 = 60s)
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs

# Monitor khugepaged activity
watch -n1 'cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed'
```

### 3.5 THP Defragmentation Impact on Latency

The compaction process required to create THPs can cause measurable latency spikes (1–100ms range). Diagnosis:

```bash
# Detect compaction-related latency
perf stat -e 'mm_compaction:*' -a sleep 10

# Check compaction statistics
cat /proc/vmstat | grep compact
# compact_stall: processes blocked for compaction
# compact_fail: compaction attempts that failed
# compact_success: successful compactions

# If compact_stall is non-zero with THP enabled:
# 1. Switch to defer+madvise defrag mode
# 2. Or disable THP for latency-sensitive processes with MADV_NOHUGEPAGE
# 3. Or use memfd with MFD_HUGETLB for explicit huge page allocations
```

## Section 4: OOM Killer Tuning

### 4.1 OOM Killer Selection Algorithm

When the system is critically low on memory and cannot reclaim enough, the OOM killer selects a process to kill. The selection uses an `oom_score` calculated from:

```
oom_score ≈ (process_memory_pages / total_memory_pages) * 1000
           + oom_score_adj (range: -1000 to +1000)
           - nice_value_adjustment
           - root_process_adjustment (small negative bonus)
```

```bash
# View OOM scores for all processes
for pid in /proc/[0-9]*/oom_score; do
    score=$(cat "$pid" 2>/dev/null) || continue
    adj=$(cat "${pid%score}score_adj" 2>/dev/null) || continue
    comm=$(cat "${pid%oom_score}comm" 2>/dev/null) || continue
    printf "%5s %5s %5s %s\n" "${pid#/proc/}" "$score" "$adj" "$comm"
done | sort -k2 -rn | head -20
```

### 4.2 Protecting Critical Processes

```bash
# Protect a critical process from OOM killing
# oom_score_adj = -1000 makes the process immune (never killed)
echo -1000 > /proc/$(pgrep -x sshd)/oom_score_adj

# More portable: use systemd
# /etc/systemd/system/critical-service.service
cat > /etc/systemd/system/critical-service.service << 'EOF'
[Unit]
Description=Critical Service
After=network.target

[Service]
ExecStart=/usr/bin/critical-service
OOMScoreAdjust=-900
Restart=always

[Install]
WantedBy=multi-user.target
EOF

# Set via systemd cgroup (recommended for containers)
# In /etc/systemd/system/critical-service.service
# OOMPolicy=kill (default), continue (ignore OOM), stop (stop unit)
```

### 4.3 Application-Level OOM Score Management

```go
// pkg/oom/protect.go
package oom

import (
    "fmt"
    "os"
    "strconv"
    "strings"
)

const (
    // OOMScoreProtected makes a process very unlikely to be killed.
    OOMScoreProtected = -900

    // OOMScoreNormal lets the kernel use default heuristics.
    OOMScoreNormal = 0

    // OOMScoreSacrificial makes a process likely to be killed first.
    OOMScoreSacrificial = 500

    // OOMScoreImmune makes a process immune from OOM killing.
    // Use with extreme caution — can cause the OOM killer to be unable
    // to recover the system.
    OOMScoreImmune = -1000
)

// SetOOMScore adjusts the OOM score for the current process.
func SetOOMScore(adj int) error {
    if adj < -1000 || adj > 1000 {
        return fmt.Errorf("oom_score_adj must be in [-1000, 1000], got %d", adj)
    }

    path := fmt.Sprintf("/proc/%d/oom_score_adj", os.Getpid())
    f, err := os.OpenFile(path, os.O_WRONLY, 0)
    if err != nil {
        return fmt.Errorf("opening %s: %w", path, err)
    }
    defer f.Close()

    if _, err := fmt.Fprintf(f, "%d\n", adj); err != nil {
        return fmt.Errorf("writing oom_score_adj: %w", err)
    }
    return nil
}

// GetOOMScore returns the current OOM score for the process.
func GetOOMScore() (int, error) {
    path := fmt.Sprintf("/proc/%d/oom_score", os.Getpid())
    data, err := os.ReadFile(path)
    if err != nil {
        return 0, err
    }
    score, err := strconv.Atoi(strings.TrimSpace(string(data)))
    if err != nil {
        return 0, fmt.Errorf("parsing oom_score: %w", err)
    }
    return score, nil
}
```

### 4.4 Kubernetes OOM Tuning

In Kubernetes, containers are killed by the cgroup OOM killer (or by the kubelet) based on resource limits. The `oom_score_adj` is set by the kubelet based on QoS class.

```
QoS Class    → oom_score_adj
Guaranteed   → -997
Burstable    → max(2, 1000 - (1000 * request_memory/node_memory))
BestEffort   → 1000
```

```yaml
# pod-oom-guaranteed.yaml
# Guaranteed QoS: requests == limits, gets oom_score_adj = -997
apiVersion: v1
kind: Pod
metadata:
  name: database-server
spec:
  containers:
    - name: postgres
      image: postgres:16.2
      resources:
        requests:
          memory: "8Gi"
          cpu: "4"
        limits:
          memory: "8Gi"
          cpu: "4"
      env:
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
```

### 4.5 OOM Notifier: Early Warning System

```bash
# Create a simple cgroup OOM event watcher
# This monitors the cgroup memory.oom_kill event file

#!/usr/bin/env bash
# oom-notifier.sh

CGROUP_PATH="${1:-/sys/fs/cgroup/memory}"
ALERT_WEBHOOK="${2:-https://hooks.slack.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX}"

monitor_oom_events() {
    local path="$1"

    # inotifywait on memory.oom_control for legacy cgroups v1
    # For cgroups v2, monitor memory.events

    local events_file="${path}/memory.events"
    if [[ ! -f "$events_file" ]]; then
        echo "ERROR: $events_file not found. Ensure cgroups v2 is mounted."
        exit 1
    fi

    local last_oom_kill
    last_oom_kill=$(awk '/oom_kill/{print $2}' "$events_file")

    inotifywait -m -e modify "$events_file" 2>/dev/null | while read -r _; do
        current_oom_kill=$(awk '/oom_kill/{print $2}' "$events_file")
        if [[ "$current_oom_kill" != "$last_oom_kill" ]]; then
            delta=$((current_oom_kill - last_oom_kill))
            last_oom_kill="$current_oom_kill"

            # Send alert
            curl -s -X POST "$ALERT_WEBHOOK" \
                -H 'Content-type: application/json' \
                --data "{
                    \"text\": \"OOM kill event on $(hostname): ${delta} process(es) killed in cgroup ${path}\"
                }"

            # Log to syslog
            logger -p user.crit "OOM kill: ${delta} process(es) killed in ${path}"

            # Log kernel OOM details
            dmesg --time-format=iso | grep -E "oom|Out of memory" | tail -20
        fi
    done
}

monitor_oom_events "$CGROUP_PATH"
```

## Section 5: Memory Pressure Monitoring and Alerting

### 5.1 PSI (Pressure Stall Information)

PSI, available since Linux 4.20, provides fine-grained memory pressure metrics that distinguish between full stalls (all tasks blocked) and partial stalls (some tasks blocked).

```bash
# View PSI memory pressure
cat /proc/pressure/memory
# some avg10=0.50 avg60=1.23 avg300=0.45 total=12345678
# full avg10=0.00 avg60=0.10 avg300=0.03 total=1234567
#
# "some": at least one task was stalled waiting for memory
# "full": ALL runnable tasks were stalled waiting for memory
# avg10/60/300: moving averages over 10s, 60s, 300s (percentages)
# total: cumulative stall time in microseconds

# Monitor continuously
while true; do
    printf "[%s] " "$(date -u +%H:%M:%S)"
    cat /proc/pressure/memory
    sleep 1
done
```

### 5.2 Prometheus Metrics from PSI

```bash
# node_exporter exposes PSI metrics automatically (v1.3.0+)
# Useful Prometheus queries:

# Memory pressure rate (% of time with at least one task stalled)
# rate(node_pressure_memory_stalled_seconds_total{type="some"}[5m]) * 100

# Alert when full memory stall exceeds 5% over 5 minutes
# rate(node_pressure_memory_stalled_seconds_total{type="full"}[5m]) * 100 > 5
```

```yaml
# prometheusrule-memory-pressure.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: linux-memory-pressure
  namespace: monitoring
spec:
  groups:
    - name: memory.pressure
      rules:
        - alert: MemoryPressureHigh
          expr: |
            rate(node_pressure_memory_stalled_seconds_total{type="some"}[5m]) * 100 > 25
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High memory pressure on {{ $labels.instance }}"
            description: "Memory pressure (some) is {{ $value | printf \"%.1f\" }}% over the last 5 minutes."

        - alert: MemoryPressureCritical
          expr: |
            rate(node_pressure_memory_stalled_seconds_total{type="full"}[5m]) * 100 > 5
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Critical memory pressure on {{ $labels.instance }}"
            description: "All tasks are stalling on memory {{ $value | printf \"%.1f\" }}% of the time."

        - alert: OOMKillDetected
          expr: |
            increase(node_vmstat_oom_kill[5m]) > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "OOM kill on {{ $labels.instance }}"
            description: "{{ $value }} process(es) killed by OOM in the last 5 minutes."
```

### 5.3 Complete Memory Tuning Playbook

```bash
#!/usr/bin/env bash
# memory-tune.sh — comprehensive memory tuning script for production

set -euo pipefail

WORKLOAD_TYPE="${1:-general}"  # general, database, latency-sensitive, batch

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

apply_general_tuning() {
    log "Applying general production memory tuning..."

    sysctl -w vm.swappiness=10
    sysctl -w vm.watermark_scale_factor=150
    sysctl -w vm.dirty_ratio=15
    sysctl -w vm.dirty_background_ratio=5
    sysctl -w vm.vfs_cache_pressure=100
    sysctl -w kernel.numa_balancing=1
    echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
    echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
}

apply_database_tuning() {
    log "Applying database memory tuning (PostgreSQL/MySQL)..."

    sysctl -w vm.swappiness=1
    sysctl -w vm.overcommit_memory=2
    sysctl -w vm.overcommit_ratio=80
    sysctl -w vm.watermark_scale_factor=200
    echo never > /sys/kernel/mm/transparent_hugepage/enabled
    echo never > /sys/kernel/mm/transparent_hugepage/defrag
    sysctl -w kernel.numa_balancing=0  # Disable for predictable latency
}

apply_latency_tuning() {
    log "Applying latency-sensitive memory tuning..."

    sysctl -w vm.swappiness=0
    sysctl -w vm.watermark_scale_factor=300
    # Disable THP to eliminate compaction stalls
    echo never > /sys/kernel/mm/transparent_hugepage/enabled
    echo never > /sys/kernel/mm/transparent_hugepage/defrag
    # Pre-allocate huge pages instead if needed
    # echo 1024 > /proc/sys/vm/nr_hugepages
    sysctl -w kernel.numa_balancing=1
}

apply_batch_tuning() {
    log "Applying batch workload memory tuning..."

    sysctl -w vm.swappiness=60
    sysctl -w vm.watermark_scale_factor=50
    echo always > /sys/kernel/mm/transparent_hugepage/enabled
    echo always > /sys/kernel/mm/transparent_hugepage/defrag
    sysctl -w kernel.numa_balancing=1
}

case "$WORKLOAD_TYPE" in
    general)           apply_general_tuning ;;
    database)          apply_database_tuning ;;
    latency-sensitive) apply_latency_tuning ;;
    batch)             apply_batch_tuning ;;
    *) echo "Unknown workload type: $WORKLOAD_TYPE"; exit 1 ;;
esac

log "Memory tuning complete for workload type: $WORKLOAD_TYPE"

# Verify
log "Current settings:"
echo "  swappiness: $(cat /proc/sys/vm/swappiness)"
echo "  THP enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo "  THP defrag: $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
echo "  NUMA balancing: $(cat /proc/sys/kernel/numa_balancing)"
echo "  watermark_scale_factor: $(cat /proc/sys/vm/watermark_scale_factor)"
```

## Summary

Linux memory management requires workload-aware configuration across four dimensions:

1. **Page reclaim tuning** centers on watermark_scale_factor, swappiness, and dirty ratio settings. Monitor `compact_stall` and `pgsteal_direct` to detect when kswapd cannot keep up with allocation rates.

2. **NUMA balancing** should be enabled with AutoNUMA for general workloads. For latency-sensitive services, use explicit `numactl --membind` placement to eliminate migration overhead.

3. **THP configuration** has no universal correct answer. `madvise` with `defer+madvise` defrag is the safest default. Applications that benefit from THP (JVMs, key-value stores with large value regions) should use `MADV_HUGEPAGE`; databases managing their own buffers should use `MADV_NOHUGEPAGE` or disable THP system-wide.

4. **OOM killer tuning** requires protecting critical processes with negative `oom_score_adj` via systemd `OOMScoreAdjust` and using Kubernetes QoS classes (Guaranteed) for workloads that must not be killed. Instrument OOM events with PSI metrics and alerting before they become production incidents.
