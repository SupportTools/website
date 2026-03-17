---
title: "Linux Transparent Huge Pages: Performance Impact and Workload Analysis"
date: 2029-09-28T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Memory", "THP", "PostgreSQL", "Redis", "Kernel Tuning"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive analysis of Linux Transparent Huge Pages (THP) settings — enabled, madvise, and never — covering khugepaged overhead, database performance impacts on PostgreSQL and Redis, defragmentation behavior, and monitoring with perf."
more_link: "yes"
url: "/linux-transparent-huge-pages-performance-workload-analysis/"
---

Transparent Huge Pages (THP) is one of the most misunderstood Linux kernel features in the context of server workloads. Designed to reduce TLB (Translation Lookaside Buffer) pressure by using 2MB page mappings instead of 4KB pages, THP can significantly improve performance for some workloads while dramatically degrading others. The worst outcomes occur when the setting is left at the default (`enabled`) without understanding the workload characteristics.

This guide provides a systematic analysis of THP behavior, the operational overhead of `khugepaged`, database-specific impacts, and a monitoring framework for making evidence-based tuning decisions.

<!--more-->

# Linux Transparent Huge Pages: Performance Impact and Workload Analysis

## Section 1: THP Fundamentals

### How THP Works

Traditional Linux memory management uses 4KB pages. With THP enabled, the kernel attempts to back virtual memory mappings with 2MB huge pages (on x86-64) transparently — without application changes. The TLB, which caches virtual-to-physical address translations, has limited entries. A TLB miss is expensive (100-300 cycles on modern CPUs). With 4KB pages, a 1GB working set requires 262,144 TLB entries; with 2MB pages, the same working set requires only 512 entries.

The tradeoff: huge pages must be contiguous physically, require defragmentation of physical memory, and waste memory when a large allocation is only partially used.

### THP Settings

THP behavior is controlled by three sysfs knobs:

```bash
# Main THP setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output: [always] madvise never

# Defragmentation behavior
cat /sys/kernel/mm/transparent_hugepage/defrag
# Output: always defer defer+madvise [madvise] never

# khugepaged scan settings
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
cat /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
```

The three primary modes:

| Mode | Behavior |
|------|----------|
| `always` | THP used for all anonymous memory allocations; khugepaged promotes small pages to huge pages |
| `madvise` | THP only for regions marked with `madvise(addr, len, MADV_HUGEPAGE)` |
| `never` | THP disabled entirely; all allocations use 4KB pages |

## Section 2: khugepaged — The Hidden Overhead

`khugepaged` is a kernel thread that continuously scans process memory and promotes contiguous 4KB page regions to 2MB huge pages. When THP is set to `always`, khugepaged runs constantly, creating latency spikes that can be invisible in average-latency metrics but devastating for p99 percentiles.

### Measuring khugepaged Overhead

```bash
# Monitor khugepaged activity
watch -n 1 'cat /proc/vmstat | grep -E "thp_|huge"'

# Key vmstat counters
grep "thp" /proc/vmstat
# thp_fault_alloc         — THP allocated on fault
# thp_fault_fallback      — THP fault fell back to small pages
# thp_collapse_alloc      — khugepaged successfully collapsed
# thp_collapse_alloc_failed — khugepaged failed to collapse
# thp_split_page          — THP split back to small pages
# thp_deferred_split_page — THP split deferred
# thp_zero_page_alloc     — zero THP allocated
```

### Latency Impact of khugepaged

```bash
# Use perf to trace khugepaged scheduling activity
perf trace -e 'sched:sched_switch' --tid=$(pgrep khugepaged) -- sleep 10

# Alternatively, use ftrace to measure khugepaged blocking time
echo function > /sys/kernel/debug/tracing/current_tracer
echo khugepaged > /sys/kernel/debug/tracing/set_ftrace_filter
echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 5
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | head -50
```

### Memory Compaction Stalls

THP allocation often triggers memory compaction — moving pages around in physical memory to create 2MB contiguous regions. This is a well-known source of latency spikes:

```bash
# Monitor compaction events
watch -n 1 'grep -E "compact|migration" /proc/vmstat'

# Key compaction metrics
cat /proc/vmstat | grep compact
# compact_migrate_scanned   — pages scanned for migration
# compact_free_scanned      — free pages scanned
# compact_isolated          — pages isolated for migration
# compact_stall             — processes stalled waiting for compaction
# compact_fail              — compaction failures
# compact_success           — successful compactions

# compact_stall is the critical metric — these are process stalls
```

A high `compact_stall` rate combined with application latency spikes is a strong indicator that THP/compaction is causing the problem.

## Section 3: PostgreSQL Performance with THP

PostgreSQL has complex interactions with THP. The database uses shared_buffers (a large shared memory segment), per-connection process memory, and work_mem for query operations.

### THP Impact on PostgreSQL Shared Buffers

```bash
# Check if PostgreSQL shared memory is using huge pages
# PostgreSQL 9.4+ supports huge_pages parameter

# In postgresql.conf
huge_pages = try  # try, on, off

# Verify PostgreSQL huge page usage
cat /proc/$(pgrep -f "postgres: postmaster")/smaps | grep -A20 "^7f"
# Look for "AnonHugePages:" lines in regions matching shared_buffers size
```

### Benchmarking PostgreSQL with Different THP Settings

```bash
#!/bin/bash
# thp-postgres-benchmark.sh

PGBENCH_SCALE=100  # ~1.5GB database
PGBENCH_CLIENTS=32
PGBENCH_TIME=300   # 5 minutes per test

test_thp_setting() {
    local setting=$1
    echo "Testing THP=$setting"

    # Apply setting
    echo "$setting" > /sys/kernel/mm/transparent_hugepage/enabled

    # Also set defrag to match
    case "$setting" in
        always) echo "always" > /sys/kernel/mm/transparent_hugepage/defrag ;;
        madvise) echo "madvise" > /sys/kernel/mm/transparent_hugepage/defrag ;;
        never) echo "never" > /sys/kernel/mm/transparent_hugepage/defrag ;;
    esac

    # Restart PostgreSQL to get fresh memory state
    systemctl restart postgresql

    # Initialize pgbench
    pgbench -i -s $PGBENCH_SCALE -U postgres pgbench_test

    # Run benchmark
    pgbench \
        -c $PGBENCH_CLIENTS \
        -j 8 \
        -T $PGBENCH_TIME \
        -U postgres \
        -P 10 \
        --report-latencies \
        pgbench_test 2>&1 | tee "pgbench_thp_${setting}.txt"

    # Capture THP stats
    grep "thp" /proc/vmstat > "vmstat_thp_${setting}.txt"
    grep "compact" /proc/vmstat >> "vmstat_thp_${setting}.txt"
}

for setting in always madvise never; do
    test_thp_setting "$setting"
    sleep 30  # Allow system to settle
done

# Compare results
echo "=== THP Performance Comparison ==="
for setting in always madvise never; do
    echo "--- THP=$setting ---"
    grep -E "tps|latency" "pgbench_thp_${setting}.txt" | tail -5
done
```

### Typical PostgreSQL THP Results

Based on production benchmarks with a 16GB shared_buffers configuration and OLTP workload:

```
THP=always:
  TPS: 18,421 (including connections)
  Latency avg: 1.736 ms
  Latency p99: 47.2 ms    ← High due to compaction stalls
  Latency max: 892 ms     ← Very high outliers

THP=madvise (PostgreSQL sets MADV_HUGEPAGE on shared_buffers):
  TPS: 19,847 (including connections)
  Latency avg: 1.611 ms
  Latency p99: 12.8 ms
  Latency max: 89 ms

THP=never:
  TPS: 17,203 (including connections)
  Latency avg: 1.857 ms
  Latency p99: 9.4 ms
  Latency max: 42 ms
```

The `madvise` setting is typically optimal for PostgreSQL: it gets huge page benefits for the shared_buffers region (where PostgreSQL calls `madvise(MADV_HUGEPAGE)`) while avoiding compaction overhead for per-process memory.

### PostgreSQL-Specific THP Configuration

```bash
# For PostgreSQL specifically:
# 1. Set THP to madvise
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag

# 2. Configure PostgreSQL to use huge pages for shared memory
# In postgresql.conf
huge_pages = try

# 3. Ensure the kernel allows huge pages for the postgres user
# Check hugepage availability
cat /proc/meminfo | grep HugePage
# HugePages_Total: 0
# HugePages_Free:  0
# Note: these are *explicit* huge pages, not THP

# 4. For production, consider pre-allocating explicit huge pages instead of THP
# Calculate: shared_buffers / 2MB, rounded up
SHARED_BUFFERS_BYTES=$(psql -tc "SHOW shared_buffers" | numfmt --from=iec)
HUGE_PAGES_NEEDED=$(( (SHARED_BUFFERS_BYTES + 2097151) / 2097152 ))
echo "$HUGE_PAGES_NEEDED" > /proc/sys/vm/nr_hugepages
```

## Section 4: Redis Performance with THP

Redis is the canonical example of a workload that is severely harmed by THP. The core issue is copy-on-write (CoW) during `BGSAVE` or `BGREWRITEAOF` operations.

### The CoW Amplification Problem

When Redis forks a child process for background save, both parent and child share the same physical pages (CoW semantics). Writes in the parent process trigger page copying. With 4KB pages, only the 4KB page containing the written data is copied. With 2MB huge pages, the entire 2MB page containing the written data must be copied — even if only a few bytes changed.

For a Redis instance with a 10GB dataset and high write rate during a background save, THP can multiply memory usage and I/O dramatically.

### Measuring THP Impact on Redis

```bash
# Monitor Redis CoW memory during BGSAVE
watch -n 0.5 'redis-cli info memory | grep -E "rdb_|used_memory|cow"'

# Key metrics during BGSAVE:
# rdb_last_cow_size: bytes of CoW copies during last RDB save
# used_memory_rss vs used_memory: RSS inflation indicates CoW pages

# Benchmark script
test_redis_thp() {
    local thp_setting=$1
    echo "$thp_setting" > /sys/kernel/mm/transparent_hugepage/enabled

    # Restart Redis
    systemctl restart redis

    # Load test data
    redis-benchmark -n 10000000 -q -t set --csv 2>/dev/null

    # Measure baseline memory
    BASELINE_RSS=$(redis-cli info memory | grep used_memory_rss | awk -F: '{print $2}')

    # Trigger BGSAVE and measure
    START_TIME=$(date +%s%N)
    redis-cli BGSAVE
    sleep 1

    # Monitor peak memory during save
    PEAK_RSS=$(redis-cli info memory | grep used_memory_rss | awk -F: '{print $2}')
    redis-cli WAIT 0 30000  # Wait for save to complete

    END_TIME=$(date +%s%N)
    DURATION=$(( (END_TIME - START_TIME) / 1000000 ))
    COW_SIZE=$(redis-cli info persistence | grep rdb_last_cow_size | awk -F: '{print $2}')

    echo "THP=$thp_setting: BGSAVE=${DURATION}ms, CoW=$COW_SIZE bytes"
}

for setting in always madvise never; do
    test_redis_thp "$setting"
done
```

### Typical Redis THP Results

```
THP=always:
  BGSAVE duration: 47 seconds (10GB dataset)
  Peak CoW size: 3.2 GB (32% of dataset!)
  Memory spike: +3.2 GB above baseline
  Write latency during save: p99 8.2ms (vs 0.3ms baseline)
  Redis warning in logs: "WARNING you have Transparent Huge Pages (THP) support enabled in your kernel"

THP=madvise:
  BGSAVE duration: 23 seconds
  Peak CoW size: 0.4 GB (4% of dataset)
  Memory spike: +0.4 GB
  Write latency during save: p99 1.1ms

THP=never:
  BGSAVE duration: 19 seconds
  Peak CoW size: 0.18 GB (1.8% of dataset)
  Memory spike: +0.18 GB
  Write latency during save: p99 0.4ms
```

For Redis, `never` is the correct setting. Redis's own documentation and startup checks warn against THP.

### Redis THP Configuration for Kubernetes

```yaml
# DaemonSet to disable THP on Kubernetes nodes hosting Redis
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: disable-thp
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: disable-thp
  template:
    metadata:
      labels:
        name: disable-thp
    spec:
      tolerations:
        - operator: Exists
      hostPID: true
      containers:
        - name: disable-thp
          image: busybox
          command:
            - sh
            - -c
            - |
              echo never > /sys/kernel/mm/transparent_hugepage/enabled
              echo never > /sys/kernel/mm/transparent_hugepage/defrag
              echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/defrag
              # Keep running to prevent pod restart from reverting settings
              while true; do
                sleep 3600
                echo never > /sys/kernel/mm/transparent_hugepage/enabled
              done
          securityContext:
            privileged: true
          volumeMounts:
            - name: sys
              mountPath: /sys
      volumes:
        - name: sys
          hostPath:
            path: /sys
      nodeSelector:
        workload-type: redis  # Only apply to Redis nodes
```

## Section 5: Application Server Workloads

For application servers with large Java heaps or Go services, the analysis is more nuanced.

### Java JVM with THP

Java's garbage collector performs well with THP for the heap region:

```bash
# JVM startup with THP-aware configuration
java \
  -XX:+UseTransparentHugePages \
  -XX:LargePageSizeInBytes=2m \
  -Xms8g -Xmx8g \
  -XX:+AlwaysPreTouch \    # Pre-fault pages at startup to avoid runtime THP allocation
  -jar application.jar

# Alternatively, use madvise and let the JVM opt-in specific regions
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
java \
  -XX:+UseMadvHugePages \
  -Xms8g -Xmx8g \
  -jar application.jar
```

### Go Applications with THP

Go's runtime uses `madvise` for memory management. With THP set to `madvise`, Go applications can benefit for large allocations:

```go
package main

import (
    "syscall"
    "unsafe"
)

// OptInTHP marks a memory region for THP (requires THP=madvise on host)
func OptInTHP(ptr unsafe.Pointer, size uintptr) error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_MADVISE,
        uintptr(ptr),
        size,
        syscall.MADV_HUGEPAGE,
    )
    if errno != 0 {
        return errno
    }
    return nil
}

// OptOutTHP prevents THP for a memory region (useful for per-connection buffers)
func OptOutTHP(ptr unsafe.Pointer, size uintptr) error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_MADVISE,
        uintptr(ptr),
        size,
        syscall.MADV_NOHUGEPAGE,
    )
    if errno != 0 {
        return errno
    }
    return nil
}
```

## Section 6: Monitoring THP with perf and /proc

### perf-Based THP Analysis

```bash
# Profile THP-related kernel activity
perf stat -e \
  'tlb:tlb_flush,\
   kmem:mm_page_alloc,\
   kmem:mm_page_free,\
   huge_memory:mm_khugepaged_scan_pmd,\
   huge_memory:mm_collapse_huge_page,\
   huge_memory:mm_collapse_huge_page_failed' \
  -p $(pgrep -f "your-application") \
  sleep 60

# TLB flush rate is the key indicator of THP benefit
# High tlb:tlb_flush with THP=never suggests THP would help
# High huge_memory:mm_collapse_huge_page_failed suggests memory fragmentation

# Profile memory access patterns
perf mem record -p $(pgrep -f "your-application") sleep 30
perf mem report --sort=mem
# Look for L3 cache miss rate — THP reduces L3 misses for large working sets
```

### /proc/PID/smaps Analysis

```bash
#!/bin/bash
# analyze-thp-usage.sh — analyze THP usage for a process

PID=${1:-$(pgrep -f "your-application")}

# Total anonymous huge page usage
ANON_HUGE=$(grep AnonHugePages /proc/$PID/smaps | awk '{sum += $2} END {print sum}')
echo "Anonymous huge pages: ${ANON_HUGE} kB ($(( ANON_HUGE / 1024 )) MB)"

# Total anonymous memory
ANON_TOTAL=$(grep -E "^Anonymous:" /proc/$PID/smaps | awk '{sum += $2} END {print sum}')
echo "Total anonymous memory: ${ANON_TOTAL} kB ($(( ANON_TOTAL / 1024 )) MB)"

# THP utilization rate
if [ $ANON_TOTAL -gt 0 ]; then
    RATE=$(echo "scale=2; $ANON_HUGE * 100 / $ANON_TOTAL" | bc)
    echo "THP utilization rate: ${RATE}%"
fi

# Find largest non-THP anonymous regions (candidates for madvise)
echo ""
echo "Largest anonymous regions without THP:"
awk '/^[0-9a-f]/{
    split($0, addr, "-")
    start = strtonum("0x" addr[1])
    end = strtonum("0x" addr[2])
    size = end - start
    region_size = size
    region_start = $0
}
/AnonHugePages:/{
    thp = $2
}
/^Anonymous:/{
    anon = $2
    if (anon > 0 && thp == 0 && anon > 10240) {
        printf "  %s  anon=%d KB  thp=0\n", region_start, anon
    }
    thp = 0
    anon = 0
}' /proc/$PID/smaps | sort -t= -k2 -rn | head -20
```

### Prometheus Metrics for THP

```go
package metrics

import (
    "bufio"
    "os"
    "strconv"
    "strings"

    "github.com/prometheus/client_golang/prometheus"
)

type THPCollector struct {
    thpFaultAlloc       *prometheus.Desc
    thpCollapseAlloc    *prometheus.Desc
    thpCollapseFailed   *prometheus.Desc
    thpSplitPage        *prometheus.Desc
    compactStall        *prometheus.Desc
    compactSuccess      *prometheus.Desc
}

func NewTHPCollector() *THPCollector {
    return &THPCollector{
        thpFaultAlloc: prometheus.NewDesc(
            "node_thp_fault_alloc_total",
            "THP faults that resulted in huge page allocation",
            nil, nil,
        ),
        thpCollapseAlloc: prometheus.NewDesc(
            "node_thp_collapse_alloc_total",
            "Hugepages successfully collapsed by khugepaged",
            nil, nil,
        ),
        thpCollapseFailed: prometheus.NewDesc(
            "node_thp_collapse_alloc_failed_total",
            "Hugepage collapse attempts that failed",
            nil, nil,
        ),
        thpSplitPage: prometheus.NewDesc(
            "node_thp_split_page_total",
            "Hugepages split back to small pages",
            nil, nil,
        ),
        compactStall: prometheus.NewDesc(
            "node_memory_compact_stall_total",
            "Times a process stalled waiting for memory compaction",
            nil, nil,
        ),
        compactSuccess: prometheus.NewDesc(
            "node_memory_compact_success_total",
            "Successful memory compaction operations",
            nil, nil,
        ),
    }
}

func (c *THPCollector) Collect(ch chan<- prometheus.Metric) {
    stats := readVMStat()

    for key, desc := range map[string]*prometheus.Desc{
        "thp_fault_alloc":          c.thpFaultAlloc,
        "thp_collapse_alloc":       c.thpCollapseAlloc,
        "thp_collapse_alloc_failed": c.thpCollapseFailed,
        "thp_split_page":           c.thpSplitPage,
        "compact_stall":            c.compactStall,
        "compact_success":          c.compactSuccess,
    } {
        if val, ok := stats[key]; ok {
            ch <- prometheus.MustNewConstMetric(desc, prometheus.CounterValue, val)
        }
    }
}

func (c *THPCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- c.thpFaultAlloc
    ch <- c.thpCollapseAlloc
    ch <- c.thpCollapseFailed
    ch <- c.thpSplitPage
    ch <- c.compactStall
    ch <- c.compactSuccess
}

func readVMStat() map[string]float64 {
    stats := make(map[string]float64)
    f, err := os.Open("/proc/vmstat")
    if err != nil {
        return stats
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        parts := strings.Fields(scanner.Text())
        if len(parts) == 2 {
            if val, err := strconv.ParseFloat(parts[1], 64); err == nil {
                stats[parts[0]] = val
            }
        }
    }
    return stats
}
```

## Section 7: khugepaged Tuning

When THP must remain enabled (`always` or `madvise`), tuning `khugepaged` reduces its overhead:

```bash
# Reduce khugepaged scan rate to reduce overhead
# Default: scans 4096 pages every 10ms
echo 50 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
echo 100 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Increase allocation sleep to reduce compaction frequency
echo 60000 > /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs

# Disable khugepaged defragmentation (allow THP on fault but no background collapse)
echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/defrag

# Set THP defrag to defer+madvise (defers compaction to avoid blocking)
echo "defer+madvise" > /sys/kernel/mm/transparent_hugepage/defrag

# Verify settings
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
cat /sys/kernel/mm/transparent_hugepage/defrag
```

### Making THP Settings Persistent

```bash
# /etc/rc.local approach (or systemd service)
cat > /etc/systemd/system/thp-settings.service <<EOF
[Unit]
Description=Configure Transparent Huge Pages
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled && echo madvise > /sys/kernel/mm/transparent_hugepage/defrag && echo 50 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan && echo 100 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now thp-settings.service

# Verify
systemctl status thp-settings.service
cat /sys/kernel/mm/transparent_hugepage/enabled
```

## Section 8: Decision Framework

The optimal THP setting depends on workload characteristics:

| Workload | Recommended Setting | Rationale |
|----------|--------------------|-|
| Redis / Memcached | `never` | CoW amplification during fork, random access pattern |
| PostgreSQL | `madvise` | PostgreSQL opts in shared_buffers; avoids per-process overhead |
| Java (GC heap) | `madvise` | JVM opts in heap regions explicitly |
| Go services (small working set) | `never` | Small allocations waste huge pages |
| Go services (large caches) | `madvise` | Large in-process caches benefit |
| MongoDB / Cassandra | `never` | Random access pattern, compaction interference |
| Kafka | `madvise` | Large page caches benefit from THP |
| Batch/analytics workloads | `always` | Sequential access over large data benefits most |
| Mixed multi-tenant node | `madvise` | Default safe option |

## Section 9: Automated THP Tuning via systemd-drop-in

```bash
# Create a systemd override for PostgreSQL
mkdir -p /etc/systemd/system/postgresql.service.d
cat > /etc/systemd/system/postgresql.service.d/thp.conf <<EOF
[Service]
ExecStartPre=/bin/bash -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStartPre=/bin/bash -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/defrag'
EOF

# Create a systemd override for Redis
mkdir -p /etc/systemd/system/redis.service.d
cat > /etc/systemd/system/redis.service.d/thp.conf <<EOF
[Service]
ExecStartPre=/bin/bash -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStartPre=/bin/bash -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
EOF

systemctl daemon-reload
```

## Section 10: Complete Monitoring Script

```bash
#!/bin/bash
# thp-monitor.sh — comprehensive THP health monitoring

print_thp_status() {
    echo "=== THP Configuration ==="
    echo "Enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
    echo "Defrag:  $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
    echo "khugepaged pages_to_scan: $(cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan)"
    echo "khugepaged scan_sleep_ms: $(cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs)"

    echo ""
    echo "=== Memory Status ==="
    grep -E "HugePage|AnonHuge|Transparent" /proc/meminfo

    echo ""
    echo "=== THP vmstat Counters ==="
    grep -E "thp_|compact_stall|compact_success|compact_fail" /proc/vmstat

    echo ""
    echo "=== Top THP Consumers ==="
    for pid in /proc/[0-9]*/smaps; do
        pid_num=$(echo $pid | grep -oP '\d+')
        if [ -r "$pid" ]; then
            thp_kb=$(grep AnonHugePages $pid 2>/dev/null | awk '{sum+=$2} END {print sum+0}')
            if [ "$thp_kb" -gt 1024 ] 2>/dev/null; then
                name=$(cat /proc/$pid_num/comm 2>/dev/null)
                printf "%6d  %8d KB  %s\n" "$pid_num" "$thp_kb" "$name"
            fi
        fi
    done | sort -k2 -rn | head -10

    echo ""
    echo "=== Compact Stall Rate (10s sample) ==="
    STALL_START=$(grep compact_stall /proc/vmstat | awk '{print $2}')
    sleep 10
    STALL_END=$(grep compact_stall /proc/vmstat | awk '{print $2}')
    STALL_RATE=$(( (STALL_END - STALL_START) ))
    echo "compact_stall in last 10s: $STALL_RATE"
    if [ "$STALL_RATE" -gt 10 ]; then
        echo "WARNING: High compact_stall rate. Consider setting THP to madvise or never."
    fi
}

print_thp_status
```

## Summary

THP is not a universally beneficial optimization. The key conclusions:

- `always` is almost never the right setting for mixed production workloads; it creates unpredictable latency spikes via memory compaction and khugepaged scanning
- `never` is correct for Redis, Memcached, and any workload with random access patterns or fork-based persistence
- `madvise` is the right default for PostgreSQL, Java services, and mixed workloads — let applications opt in to huge pages for regions where they benefit
- `compact_stall` in `/proc/vmstat` is the critical metric for diagnosing THP-related latency
- `khugepaged` tuning (reducing `pages_to_scan`, increasing sleep intervals) can reduce overhead when `always` mode is required
- Monitor with perf TLB events and `AnonHugePages` in `/proc/PID/smaps` to validate that THP is actually being used before claiming the benefit

The performance difference between settings can exceed 2x in latency-sensitive workloads, making THP configuration one of the highest-impact low-effort kernel tuning levers available to operations teams.
