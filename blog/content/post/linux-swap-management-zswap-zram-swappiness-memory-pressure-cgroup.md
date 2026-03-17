---
title: "Linux Swap Management: zswap, zram, Swappiness Tuning, Memory Pressure Response, and cgroup memory.swap.max"
date: 2031-12-23T00:00:00-05:00
draft: false
tags: ["Linux", "Swap", "Memory", "zswap", "zram", "cgroup", "Performance", "Kernel", "Memory Management"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux swap management covering zswap compressed swap cache, zram block devices, swappiness kernel parameter tuning, memory pressure mechanisms, and cgroup v2 memory.swap.max for per-container swap limits."
more_link: "yes"
url: "/linux-swap-management-zswap-zram-swappiness-memory-pressure-cgroup/"
---

Swap is one of the most misunderstood aspects of Linux memory management. Common advice to "disable swap on Kubernetes nodes" or "always set swappiness to 0" oversimplifies a nuanced topic. Modern swap management with zswap, zram, and cgroup v2 memory controls provides fine-grained, production-appropriate memory overflow handling that improves stability without the performance cliff of spinning-disk swap.

This guide covers the complete Linux swap stack: kernel memory reclaim mechanics, zswap compressed swap cache, zram compressed block devices, swappiness parameter effects at the system and cgroup level, memory pressure notification mechanisms, and the cgroup v2 `memory.swap.max` interface for per-container swap limits.

<!--more-->

# Linux Swap Management: zswap, zram, Swappiness, Memory Pressure, and cgroup memory.swap.max

## Section 1: Linux Memory Reclaim Architecture

### 1.1 Memory Zones and LRU Lists

The kernel maintains two LRU lists per memory zone:

- **Active list**: pages accessed recently; harder to reclaim
- **Inactive list**: pages not recently accessed; candidates for reclaim

Pages migrate between these lists via the `access bit` in page table entries. The `kswapd` kernel thread periodically scans inactive pages and either:
1. **Reclaims** file-backed pages (drop from page cache, re-read from disk on fault)
2. **Swaps** anonymous pages (write to swap space, free physical frame)

### 1.2 Direct Reclaim vs kswapd

```bash
# Monitor memory reclaim activity
vmstat -w 1 5
# Fields: si/so = swap in/out per second
# pgscan_kswapd vs pgscan_direct indicates pressure level

# Watch kswapd wake-ups
perf stat -e 'vmscan:mm_vmscan_wakeup_kswapd' sleep 10

# Detailed reclaim statistics
cat /proc/vmstat | grep -E "pgscan|pgsteal|pgfault|pgmajfault|pgswap"

# Memory pressure indicators
cat /proc/meminfo | grep -E "SwapTotal|SwapFree|SwapCached|MemAvailable"
```

### 1.3 OOM Killer Behavior

```bash
# Check OOM killer events
dmesg | grep -i "oom\|killed process\|out of memory"

# Process OOM score (higher = more likely to be killed)
cat /proc/<pid>/oom_score
cat /proc/<pid>/oom_score_adj   # adjustment (-1000 to +1000)

# Protect a process from OOM
echo -1000 > /proc/<pid>/oom_score_adj

# Make a process more OOM-killable
echo 500 > /proc/<pid>/oom_score_adj
```

## Section 2: Traditional Swap Configuration

### 2.1 Swap Partition and File Setup

```bash
# Create a swap file (for systems without a dedicated swap partition)
fallocate -l 8G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Verify swap is active
swapon --show
cat /proc/swaps

# Make persistent
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Create swap partition (if separate disk available)
parted /dev/sdb mklabel gpt
parted /dev/sdb mkpart primary linux-swap 0% 8GiB
mkswap /dev/sdb1
swapon /dev/sdb1

# Set priority on swap (higher priority used first)
swapon -p 10 /dev/sdb1  # fast NVMe
swapon -p 5 /swapfile   # slower HDD-backed file
```

### 2.2 Swappiness Parameter

The `vm.swappiness` parameter (0-200) controls the kernel's preference for swapping anonymous pages vs reclaiming file-backed page cache:

- **0**: Avoid swapping; only swap when there is literally no other choice (not "disable")
- **10-30**: Cloud/server tuning; prefer file cache reclaim but allow some swap
- **60**: Default; balanced reclaim
- **100**: Treat file cache and anonymous memory equally for reclaim
- **200** (Linux 5.8+): Aggressively swap; useful for zram workloads

```bash
# Check current swappiness
cat /proc/sys/vm/swappiness
sysctl vm.swappiness

# Set for running system
sysctl -w vm.swappiness=10

# Persist across reboots
echo 'vm.swappiness = 10' > /etc/sysctl.d/90-swap.conf
sysctl --system

# For Kubernetes worker nodes (avoid swapping application memory)
echo 'vm.swappiness = 0' > /etc/sysctl.d/90-kubernetes.conf

# Linux 5.8+ MGLRU-aware recommendation for servers with NVMe swap/zram
echo 'vm.swappiness = 200' > /etc/sysctl.d/90-zram.conf
```

### 2.3 vfs_cache_pressure

```bash
# Control how aggressively the kernel reclaims dentries and inodes
# Higher = more aggressive reclaim of VFS caches
sysctl -w vm.vfs_cache_pressure=50   # default 100
# Lower values keep more metadata in memory (good for dentry-heavy workloads)
```

## Section 3: zswap — Compressed Swap Cache

### 3.1 zswap Architecture

zswap sits between the kernel's swap subsystem and the backing swap device. When a page is destined for swap:

1. zswap tries to compress the page using LZ4, zstd, or lzo
2. Compressed page is stored in a kernel memory pool (zbud, z3fold, or zsmalloc)
3. Only if the memory pool is full does zswap write to the backing swap device

This dramatically reduces I/O for swap-heavy workloads, especially when pages compress well (zeropages compress from 4K to ~50 bytes).

### 3.2 Enabling and Configuring zswap

```bash
# Check if zswap is compiled into your kernel
cat /sys/module/zswap/parameters/enabled 2>/dev/null || echo "zswap not loaded"

# Check available pool types
ls /sys/kernel/mm/zswap/

# Enable zswap at runtime
echo 1 > /sys/module/zswap/parameters/enabled

# Or at boot via kernel command line (persistent)
# GRUB_CMDLINE_LINUX="zswap.enabled=1 zswap.compressor=lz4 zswap.max_pool_percent=20 zswap.zpool=z3fold"

# Configure maximum pool size (percentage of total RAM)
echo 20 > /sys/module/zswap/parameters/max_pool_percent

# Set compression algorithm
# Available: lzo, lzo-rle, lz4, lz4hc, zstd, deflate
echo lz4 > /sys/module/zswap/parameters/compressor

# Set allocator (z3fold = best compression ratio, zsmalloc = better for many small objects)
echo z3fold > /sys/module/zswap/parameters/zpool

# Enable on-demand write-back (write LRU pages to swap when pool fills)
echo 1 > /sys/module/zswap/parameters/same_filled_pages_enabled
echo 1 > /sys/module/zswap/parameters/non_same_filled_pages_enabled
```

### 3.3 zswap Monitoring

```bash
# Monitor zswap pool usage
cat /sys/kernel/debug/zswap/*

# Key metrics:
# stored_pages: current compressed pages in pool
# pool_total_size: total pool size in bytes
# written_back_pages: pages evicted to backing swap device
# reject_compress_poor: pages rejected because compression ratio was poor
# same_filled_pages: number of same-filled (zero) pages

# Calculate compression ratio
STORED=$(cat /sys/kernel/debug/zswap/stored_pages)
POOL_SIZE=$(cat /sys/kernel/debug/zswap/pool_total_size)
UNCOMPRESSED=$((STORED * 4096))
echo "Uncompressed: $((UNCOMPRESSED / 1024 / 1024))MB"
echo "Compressed:   $((POOL_SIZE / 1024 / 1024))MB"
echo "Ratio: $(awk "BEGIN {printf \"%.2f\", $UNCOMPRESSED / $POOL_SIZE}")"

# Watch zswap stats live
watch -n 2 'cat /sys/kernel/debug/zswap/* | while read line; do echo "$line"; done'

# Expose via /proc/vmstat
grep -i zswap /proc/vmstat
# zswap_stored_pages
# zswap_pool_total_size
# zswap_written_back_pages
```

### 3.4 Optimal zswap Configuration for Kubernetes Nodes

```bash
# /etc/sysctl.d/90-zswap.conf
# For Kubernetes nodes with NVMe-backed swap or zram as backing store

# Enable zswap
# Note: Set via kernel cmdline for boot-time persistence
# zswap.enabled=1

# Allow moderate anonymous page reclaim under pressure
vm.swappiness = 10

# Reduce memory reclaim aggressiveness for container metadata
vm.vfs_cache_pressure = 50

# Minimum pages to keep around (prevent overallocation)
vm.min_free_kbytes = 131072

# Reduce THP defrag overhead
vm.defrag_page_faults = 0
```

## Section 4: zram — Compressed RAM Block Devices

### 4.1 zram Architecture

While zswap is a cache in front of traditional swap, zram creates a compressed block device entirely in RAM. There is no disk I/O — swapped pages are compressed and stored in RAM itself. This makes zram ideal for:

- Systems with no swap partition available (embedded, containerized)
- Workloads where memory pressure is occasional and the overhead of disk I/O is unacceptable
- Desktop and mobile systems (Chrome OS, Android use zram by default)

### 4.2 Setting Up zram

```bash
#!/bin/bash
# setup-zram.sh

set -euo pipefail

# Load the zram kernel module
modprobe zram

# Get number of CPUs for multiple zram devices
NUM_CPUS=$(nproc)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
ZRAM_SIZE_KB=$((TOTAL_RAM_KB / 2))  # Use 50% of RAM for zram swap

echo "Setting up ${NUM_CPUS} zram devices, total size: $((ZRAM_SIZE_KB / 1024))MB"

# Create one zram device per CPU for parallelism
for i in $(seq 0 $((NUM_CPUS - 1))); do
    DEVICE="/dev/zram${i}"
    DEVICE_SIZE_KB=$((ZRAM_SIZE_KB / NUM_CPUS))

    # Select best available compression algorithm
    if grep -q "^lz4" /sys/block/zram0/comp_algorithm 2>/dev/null; then
        echo lz4 > /sys/block/zram${i}/comp_algorithm
    elif grep -q "^zstd" /sys/block/zram0/comp_algorithm 2>/dev/null; then
        echo zstd > /sys/block/zram${i}/comp_algorithm
    else
        echo lzo-rle > /sys/block/zram${i}/comp_algorithm
    fi

    # Set device size
    echo "${DEVICE_SIZE_KB}K" > /sys/block/zram${i}/disksize

    # Format as swap
    mkswap "${DEVICE}"

    # Enable with high priority (prefer over any disk swap)
    swapon -p 100 "${DEVICE}"

    echo "Enabled ${DEVICE}: $((DEVICE_SIZE_KB / 1024))MB"
done

# Verify
swapon --show
echo "Total swap:"
cat /proc/meminfo | grep Swap
```

### 4.3 Systemd zram Service

```ini
# /etc/systemd/system/zram-swap.service
[Unit]
Description=Create zram swap devices
DefaultDependencies=no
After=local-fs.target
Before=swap.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/setup-zram.sh
ExecStop=/usr/local/sbin/teardown-zram.sh

[Install]
WantedBy=swap.target
```

```bash
# /usr/local/sbin/teardown-zram.sh
#!/bin/bash
for dev in /dev/zram*; do
    swapoff "$dev" 2>/dev/null || true
    echo 1 > /sys/block/$(basename $dev)/reset 2>/dev/null || true
done
modprobe -r zram 2>/dev/null || true
```

### 4.4 zram Monitoring

```bash
# Check zram device statistics
for dev in /dev/zram*; do
    name=$(basename $dev)
    echo "=== $name ==="
    echo "  disksize:     $(cat /sys/block/$name/disksize)"
    echo "  compr_data:   $(cat /sys/block/$name/compr_data_size)"
    echo "  mem_used:     $(cat /sys/block/$name/mem_used_total)"
    echo "  orig_data:    $(cat /sys/block/$name/orig_data_size)"
    echo "  algorithm:    $(cat /sys/block/$name/comp_algorithm)"
    echo "  ratio: $(awk "BEGIN {
        orig=$(cat /sys/block/$name/orig_data_size)
        comp=$(cat /sys/block/$name/compr_data_size)
        if (comp > 0) printf \"%.2f\", orig/comp
        else print \"N/A\"
    }")"
done

# Monitor via Prometheus node_exporter
# These are exposed automatically when node_exporter is running
curl -s http://localhost:9100/metrics | grep node_zram
```

### 4.5 zram + zswap Together

For maximum flexibility, use both: zram as the primary swap device with zswap as a cache in front of it. This provides:

1. Compressed RAM pool (zswap) for hot swap pages
2. zram as backing store (still in RAM, compressed)
3. Optional disk swap as last resort

```bash
# Setup order:
# 1. Create zram device
modprobe zram
echo lz4 > /sys/block/zram0/comp_algorithm
echo 4G > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 100 /dev/zram0

# 2. Enable zswap with zram as backing
echo 1 > /sys/module/zswap/parameters/enabled
echo 20 > /sys/module/zswap/parameters/max_pool_percent
echo lz4 > /sys/module/zswap/parameters/compressor
# zswap will use the highest-priority swap (zram0) as backing
```

## Section 5: cgroup v2 Memory and Swap Controls

### 5.1 cgroup v2 Memory Interface

```bash
# Check cgroup v2 is in use
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2

# Memory controllers available
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Memory settings for a cgroup
ls /sys/fs/cgroup/system.slice/
# memory.current       - current memory usage
# memory.max           - hard limit (SIGKILL if exceeded)
# memory.high          - soft limit (throttle + reclaim)
# memory.low           - protected allocation
# memory.min           - minimum guarantee
# memory.swap.current  - current swap usage
# memory.swap.max      - swap limit
# memory.swap.high     - swap soft limit (Linux 5.15+)
# memory.pressure      - memory pressure notifications
# memory.events        - event counters (oom, oom_kill, etc.)
# memory.stat          - detailed memory statistics
```

### 5.2 memory.swap.max

The `memory.swap.max` interface limits the total anonymous memory that can be swapped out for a cgroup:

```bash
# No swap allowed for this cgroup
echo 0 > /sys/fs/cgroup/kubepods/memory.swap.max

# Allow up to 1GB of swap
echo $((1 * 1024 * 1024 * 1024)) > /sys/fs/cgroup/kubepods/memory.swap.max

# Unlimited swap (default)
echo max > /sys/fs/cgroup/kubepods/memory.swap.max

# Note: memory.swap.max is the TOTAL of memory + swap.
# If memory.max=2GB and memory.swap.max=3GB, then 1GB of swap is allowed.
# This matches the semantics of the "memsw.limit_in_bytes" in cgroup v1.

# Check current swap usage
cat /sys/fs/cgroup/kubepods/memory.swap.current

# Check memory stats including swap accounting
cat /sys/fs/cgroup/kubepods/memory.stat | grep -i swap
```

### 5.3 Kubernetes Swap Configuration (Linux 5.17+ / Kubernetes 1.28+)

Kubernetes 1.28 promoted swap support to beta for Linux nodes with cgroup v2:

```yaml
# /var/lib/kubelet/config.yaml
memorySwap:
  swapBehavior: LimitedSwap  # or NoSwap (disable), UnlimitedSwap

# LimitedSwap: each pod gets swap proportional to its memory request
# NoSwap: containers cannot use swap (default before 1.28)
# UnlimitedSwap: no swap limit (not recommended for production)
```

```bash
# Verify swap configuration on Kubernetes node
cat /var/lib/kubelet/config.yaml | grep -A3 memorySwap

# Check per-pod cgroup swap settings
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/memory.swap.max

# Monitor swap usage per pod
for pod_cgroup in /sys/fs/cgroup/kubepods/*/pod*/; do
    swap=$(cat "$pod_cgroup/memory.swap.current" 2>/dev/null || echo 0)
    if [ "$swap" -gt 0 ]; then
        echo "$pod_cgroup: $(( swap / 1024 / 1024 ))MB swap"
    fi
done
```

### 5.4 Memory Pressure Notifications

cgroup v2 `memory.pressure` implements the Linux PSI (Pressure Stall Information) interface:

```bash
# Read memory pressure
cat /sys/fs/cgroup/kubepods/memory.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = time where at least one task was stalled on memory
# "full" = time where ALL tasks were stalled on memory

# System-wide PSI
cat /proc/pressure/memory
cat /proc/pressure/io
cat /proc/pressure/cpu

# Alert when avg60 memory pressure exceeds 10%
# (useful for pre-OOM alerting)
```

### 5.5 PSI-Based Memory Pressure Monitoring in Go

```go
package pressure

import (
    "bufio"
    "fmt"
    "os"
    "strconv"
    "strings"
    "time"
)

type PSIStats struct {
    SomeAvg10  float64
    SomeAvg60  float64
    SomeAvg300 float64
    SomeTotal  uint64
    FullAvg10  float64
    FullAvg60  float64
    FullAvg300 float64
    FullTotal  uint64
}

func ReadMemoryPressure(cgroupPath string) (*PSIStats, error) {
    var pressurePath string
    if cgroupPath == "" {
        pressurePath = "/proc/pressure/memory"
    } else {
        pressurePath = cgroupPath + "/memory.pressure"
    }

    f, err := os.Open(pressurePath)
    if err != nil {
        return nil, fmt.Errorf("opening pressure file: %w", err)
    }
    defer f.Close()

    stats := &PSIStats{}
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        fields := strings.Fields(line)
        if len(fields) < 5 { continue }

        kind := fields[0] // "some" or "full"
        var target *[4]interface{}
        if kind == "some" {
            target = &[4]interface{}{&stats.SomeAvg10, &stats.SomeAvg60, &stats.SomeAvg300, &stats.SomeTotal}
        } else if kind == "full" {
            target = &[4]interface{}{&stats.FullAvg10, &stats.FullAvg60, &stats.FullAvg300, &stats.FullTotal}
        } else {
            continue
        }

        for i, field := range fields[1:5] {
            parts := strings.SplitN(field, "=", 2)
            if len(parts) != 2 { continue }
            if i == 3 {
                v, _ := strconv.ParseUint(parts[1], 10, 64)
                *(target[i].(*uint64)) = v
            } else {
                v, _ := strconv.ParseFloat(parts[1], 64)
                *(target[i].(*float64)) = v
            }
        }
    }

    return stats, scanner.Err()
}

// WatchMemoryPressure sends notifications when avg60 exceeds the threshold.
func WatchMemoryPressure(cgroupPath string, threshold float64, ch chan<- PSIStats) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        stats, err := ReadMemoryPressure(cgroupPath)
        if err != nil {
            continue
        }
        if stats.SomeAvg60 > threshold || stats.FullAvg60 > 0 {
            select {
            case ch <- *stats:
            default:
            }
        }
    }
}
```

## Section 6: Memory Overcommit and OOM Scoring

### 6.1 Overcommit Controls

```bash
# Overcommit policy
cat /proc/sys/vm/overcommit_memory
# 0: heuristic overcommit (default)
# 1: always overcommit (DANGEROUS for production)
# 2: never overcommit beyond overcommit_ratio

# For Kubernetes nodes, disable aggressive overcommit
sysctl -w vm.overcommit_memory=0

# If using overcommit=2, set ratio
# Total memory usable = swap + (RAM * overcommit_ratio / 100)
sysctl -w vm.overcommit_ratio=80

# Check current overcommit state
cat /proc/meminfo | grep -E "CommitLimit|Committed_AS"
```

### 6.2 Production Memory Tuning for Kubernetes Nodes

```bash
# /etc/sysctl.d/90-kubernetes-memory.conf

# Moderate swappiness - allow some swap under extreme pressure
# but prefer reclaiming file-backed pages first
vm.swappiness = 1

# Keep some free memory to avoid direct reclaim in hot path
# 128MB minimum free
vm.min_free_kbytes = 131072

# Reduce writeback latency
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500

# Reduce VFS cache reclaim aggressiveness
vm.vfs_cache_pressure = 50

# Enable zswap at boot via grub (add to GRUB_CMDLINE_LINUX):
# zswap.enabled=1 zswap.compressor=lz4 zswap.max_pool_percent=20
```

## Section 7: Production Monitoring

### 7.1 Prometheus Node Exporter Memory Metrics

```promql
# Swap utilization percentage
(node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) /
node_memory_SwapTotal_bytes * 100

# Memory available percentage
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100

# Active vs inactive memory ratio
node_memory_Active_bytes / node_memory_Inactive_bytes

# Page swap rates (swap-in/out per second)
rate(node_vmstat_pswpin[5m])
rate(node_vmstat_pswpout[5m])

# Memory pressure (PSI - requires Linux 4.20+)
node_pressure_memory_stalled_seconds_total{type="some"}
node_pressure_memory_stalled_seconds_total{type="full"}

# OOM events (from dmesg kernel messages)
node_vmstat_oom_kill
```

### 7.2 Alerting Rules

```yaml
# prometheus-memory-alerts.yaml
groups:
  - name: memory-management
    rules:
      - alert: HighSwapUsage
        expr: |
          (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) /
          node_memory_SwapTotal_bytes > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High swap usage on {{ $labels.instance }}"
          description: "{{ $value | humanizePercentage }} of swap is used. This may indicate memory pressure."

      - alert: MemoryPressureHigh
        expr: |
          rate(node_pressure_memory_stalled_seconds_total{type="some"}[5m]) * 100 > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory pressure on {{ $labels.instance }}"
          description: "{{ $value }}% of time spent stalled on memory allocation"

      - alert: OOMKillDetected
        expr: |
          increase(node_vmstat_oom_kill[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "OOM kill on {{ $labels.instance }}"
          description: "{{ $value }} OOM kills in the last 5 minutes"

      - alert: SwapActivityHigh
        expr: |
          rate(node_vmstat_pswpout[5m]) > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High swap write rate on {{ $labels.instance }}"
          description: "{{ $value | humanize }} pages swapped out per second"

      - alert: MemoryAvailableLow
        expr: |
          node_memory_MemAvailable_bytes /
          node_memory_MemTotal_bytes < 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Low available memory on {{ $labels.instance }}"
          description: "Only {{ $value | humanizePercentage }} memory available"
```

## Section 8: Troubleshooting Common Swap Issues

### 8.1 Diagnosing Swap Thrashing

```bash
# High si/so in vmstat = swap thrashing
vmstat 1 30

# Identify processes using swap
for pid in /proc/[0-9]*; do
    proc=$(basename $pid)
    vmrss=$(awk '/VmRSS/{print $2}' $pid/status 2>/dev/null || echo 0)
    vmswap=$(awk '/VmSwap/{print $2}' $pid/status 2>/dev/null || echo 0)
    if [ "$vmswap" -gt 10240 ]; then
        comm=$(cat $pid/comm 2>/dev/null || echo unknown)
        echo "PID=$proc ($comm): RSS=${vmrss}KB SWAP=${vmswap}KB"
    fi
done | sort -t= -k4 -rn | head -20

# For a specific process
cat /proc/<pid>/smaps_rollup | grep -E "Rss|Swap|Pss"
```

### 8.2 zswap Not Compressing

```bash
# Check rejection reasons
cat /sys/kernel/debug/zswap/reject_alloc_fail
cat /sys/kernel/debug/zswap/reject_compress_poor
cat /sys/kernel/debug/zswap/reject_kmemcache_fail
cat /sys/kernel/debug/zswap/reject_reclaim_fail

# High reject_compress_poor = pages don't compress well
# Possible action: switch to a weaker compressor or disable zswap for this workload
echo lzo-rle > /sys/module/zswap/parameters/compressor

# Pool full but low compression ratio
# Increase pool size
echo 30 > /sys/module/zswap/parameters/max_pool_percent
```

### 8.3 Kubernetes Node Memory Accounting

```bash
# Check kubelet's memory-related stats
kubectl describe node <node-name> | grep -A20 "Allocated resources"

# Check per-namespace memory usage
kubectl top pods --all-namespaces --sort-by=memory | head -20

# Check cgroup memory stats for a pod
POD_UID="<pod-uid>"
cat /sys/fs/cgroup/kubepods/burstable/pod${POD_UID}/memory.stat

# Check swap accounting for a pod
cat /sys/fs/cgroup/kubepods/burstable/pod${POD_UID}/memory.swap.current

# View container memory events (OOM, etc.)
cat /sys/fs/cgroup/kubepods/burstable/pod${POD_UID}/memory.events
```

## Summary

Modern Linux swap management is far more nuanced than the binary "enable/disable" decision often presented:

- **zswap** provides a compressed in-memory cache in front of any swap device, reducing I/O dramatically for workloads with compressible anonymous memory; configure with lz4 or zstd for best throughput
- **zram** creates compressed block devices entirely in RAM, eliminating swap I/O entirely; combined with zswap it provides a two-tier compressed memory overflow path
- **swappiness** controls the balance between swapping anonymous pages and reclaiming file-backed page cache; value 1-10 is appropriate for Kubernetes nodes to minimize swap use while maintaining OOM stability; value 200 is optimal for zram+zswap setups on Linux 5.8+
- **cgroup v2 memory.swap.max** provides per-container swap isolation, preventing one noisy pod from consuming all swap capacity; Kubernetes 1.28+ exposes this via `memorySwap.swapBehavior`
- **PSI memory pressure** provides early warning of memory contention before OOM killing begins; monitor `some avg60 > 10%` as a pre-OOM alert threshold

The right configuration depends on workload characteristics: interactive latency-sensitive services want minimal swap, batch jobs can tolerate higher swappiness, and memory-bound analytics benefit from generous zram allocation.
