---
title: "Linux Swap Configuration: Swappiness, zswap, and zram for Modern Workloads"
date: 2031-01-12T00:00:00-05:00
draft: false
tags: ["Linux", "Swap", "zswap", "zram", "Memory", "Kernel", "Kubernetes", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux swap configuration covering swappiness tuning for databases and general workloads, zswap compressed swap cache, zram block device setup, swap priority configuration, Kubernetes swap support, and OOM behavior analysis."
more_link: "yes"
url: "/linux-swap-configuration-swappiness-zswap-zram-modern-workloads/"
---

Swap remains one of the most misunderstood subsystems in Linux memory management. The common advice to "just disable swap on Kubernetes nodes" is simultaneously correct in some contexts and dangerously wrong in others. Understanding when swap hurts performance, when it prevents OOM kills, and how compressed swap alternatives like zswap and zram change the calculus is essential for operating production systems at the limits of available memory. This guide covers the full spectrum from kernel swappiness tuning to Kubernetes beta swap support.

<!--more-->

# Linux Swap Configuration: Swappiness, zswap, and zram for Modern Workloads

## Section 1: How Linux Swap Works

### Virtual Memory and the Page Cache

Linux uses virtual memory with demand paging. Every process sees a contiguous address space. The kernel maps virtual pages to physical frames on first access. When physical memory pressure builds, the kernel must reclaim pages.

The kernel reclaims memory from two pools:
- **Page cache**: cached filesystem data that can be dropped because it can be re-read from disk
- **Anonymous memory**: heap, stack, and mmap regions that have been modified and cannot be discarded without saving

Swap is the backing store for anonymous memory. When the kernel evicts an anonymous page to swap, it writes the page contents to the swap device and marks the virtual page as "swapped out." On next access, a page fault triggers a swap read.

### Memory Pressure Levels

The kernel tracks memory pressure through kswapd, the kernel swap daemon:

```
Available Memory
      |
      v
Free > High Watermark  -> No reclaim
Free < High Watermark  -> Background reclaim (kswapd wakes)
Free < Low Watermark   -> Direct reclaim (allocation stalls)
Free < Min Watermark   -> OOM killer invoked
```

Check current watermarks:

```bash
cat /proc/zoneinfo | grep -E "min|low|high|free" | head -20
```

Watch kswapd activity:

```bash
vmstat 1 | head -20
# pgswpout column: pages swapped out per second
# pgswpin column: pages swapped in per second
```

## Section 2: Swappiness Tuning

`vm.swappiness` controls the kernel's preference for swapping anonymous memory versus reclaiming page cache. Its interpretation changed between kernel versions.

### Kernel 5.8+ Swappiness Semantics

In kernels before 5.8, swappiness was approximately the percentage of reclaim effort directed at anonymous memory. In 5.8+, the value affects a ratio in the page reclaim algorithm:

```
anon_refault_distance / (file_refault_distance * (swappiness + 1))
```

Higher swappiness = more willingness to swap anonymous pages before dropping page cache.

```bash
# Check current swappiness
sysctl vm.swappiness
# Default: 60

# Disable swap preference (page cache evicted before anonymous memory)
sysctl -w vm.swappiness=0

# Maximum swap preference
sysctl -w vm.swappiness=200   # kernel 5.8+ supports 0-200

# Persistent configuration
echo "vm.swappiness=10" >> /etc/sysctl.d/99-memory.conf
sysctl --system
```

### Workload-Specific Recommendations

**PostgreSQL and other databases:**
```bash
# Databases manage their own buffer pool. Swapping database buffer pages
# is catastrophic for performance. Set swappiness very low.
vm.swappiness=1
# Value of 1 (not 0) ensures some swap headroom for emergency OOM prevention
```

**Elasticsearch:**
```bash
# Elasticsearch recommends disabling swap entirely for the JVM heap.
# However, system processes still need some swap headroom.
vm.swappiness=1
# Additionally, use mlockall in JVM options or memlock limits
```

**General application servers:**
```bash
# Allow moderate swap for infrequently accessed data
vm.swappiness=10
```

**Desktop/development systems:**
```bash
# Higher swappiness keeps more file cache for frequently accessed files
vm.swappiness=60  # default, appropriate
```

**Memory-constrained systems at risk of OOM:**
```bash
# Accept some swap latency in exchange for not killing processes
vm.swappiness=30
```

### Per-cgroup Swappiness (cgroup v2)

With cgroup v2, you can set swappiness per-cgroup:

```bash
# For a systemd service
systemctl set-property myservice.service MemorySwapMax=0

# Direct cgroup v2 manipulation
echo 10 > /sys/fs/cgroup/myapp/memory.swappiness
```

## Section 3: Swap Priority Configuration

Linux supports multiple swap devices with different priorities. Higher priority swap is used first.

```bash
# Create swap on fast NVMe
mkswap /dev/nvme0n1p2
swapon -p 100 /dev/nvme0n1p2   # priority 100 (used first)

# Create swap on slower SSD as overflow
mkswap /dev/sda1
swapon -p 50 /dev/sda1          # priority 50 (used second)

# Check swap usage
swapon --show
# NAME         TYPE      SIZE   USED PRIO
# /dev/nvme0n1p2 partition  16G    2G  100
# /dev/sda1    partition  32G    0G   50

# /etc/fstab entries
# /dev/nvme0n1p2 none swap sw,pri=100 0 0
# /dev/sda1      none swap sw,pri=50  0 0
```

Equal-priority swap devices stripe writes, similar to RAID-0:

```bash
# Two NVMe devices with equal priority: writes alternate between them
swapon -p 100 /dev/nvme0n1p2
swapon -p 100 /dev/nvme1n1p1   # same priority = stripe
```

## Section 4: zswap - Compressed Swap Cache

zswap is an in-memory compressed cache for swap pages. Instead of writing evicted pages directly to disk swap, the kernel compresses and stores them in RAM. Only pages that don't fit in the zswap pool are written to disk.

### How zswap Works

```
Anonymous page evicted
         |
         v
    zswap compresses page
         |
     Fits in pool?
    /            \
  YES              NO
   |               |
Store in zswap   Write to disk swap
compressed pool
         |
    Page faulted
         |
  In zswap pool?
    /        \
  YES          NO
   |            |
Decompress    Read from disk
& return
```

### Enabling and Configuring zswap

```bash
# Check if zswap is compiled in
zcat /proc/config.gz 2>/dev/null | grep -E "ZSWAP|ZPOOL|Z3FOLD|ZBUD|ZSMALLOC"
# Or
grep -r ZSWAP /boot/config-$(uname -r)

# Enable zswap at runtime
echo 1 > /sys/module/zswap/parameters/enabled

# Enable at boot via kernel parameter
# GRUB_CMDLINE_LINUX="zswap.enabled=1"

# Configure maximum pool size (% of total RAM)
echo 20 > /sys/module/zswap/parameters/max_pool_percent

# Choose compressor (lz4 recommended for speed/ratio balance)
echo lz4 > /sys/module/zswap/parameters/compressor

# Choose memory allocator (z3fold recommended for density)
echo z3fold > /sys/module/zswap/parameters/zpool

# Verify configuration
cat /sys/module/zswap/parameters/*
```

### zswap Performance Monitoring

```bash
# Monitor zswap activity
watch -n1 "grep zswap /proc/vmstat"
# zswap_pool_total_size   - current compressed pool size (bytes)
# zswap_stored_pages      - pages currently in zswap
# zswap_written_back_pages - pages evicted from zswap to disk
# zswap_reject_compress_poor - pages rejected because compression was poor
# zswap_reject_alloc_fail    - rejections due to allocation failure
# zswap_same_filled_pages    - zero-filled pages (special case, no compress needed)

# Calculate compression ratio
awk '/zswap_stored_pages/{pages=$2} /zswap_pool_total_size/{pool=$2} END{
    if (pages > 0) printf "Ratio: %.2fx (pages: %d, pool: %.1fMB)\n",
    pages*4096/pool, pages, pool/1048576
}' /proc/vmstat
```

### zswap Compressor Selection

```bash
# Available compressors
ls /sys/kernel/debug/zswap/pool/ 2>/dev/null
# Or check loaded modules
lsmod | grep -E "lz4|lzo|zstd|deflate"

# Performance characteristics (approximate, hardware-dependent):
# lz4:   ~4 GB/s compress, ~8 GB/s decompress, ratio ~2x
# lzo:   ~2 GB/s compress, ~4 GB/s decompress, ratio ~2x
# zstd:  ~1 GB/s compress, ~3 GB/s decompress, ratio ~3x
# lz4hc: ~0.5 GB/s compress, ~8 GB/s decompress, ratio ~2.5x

# For latency-sensitive workloads: lz4
echo lz4 > /sys/module/zswap/parameters/compressor

# For memory-constrained workloads: zstd
echo zstd > /sys/module/zswap/parameters/compressor
```

## Section 5: zram - Compressed RAM Block Device

zram creates a compressed block device in RAM. Unlike zswap (which is a cache for disk swap), zram IS the swap device. There is no disk backing store. Memory compressed with zram is entirely in RAM with no I/O penalty.

### zram Setup

```bash
# Load module
modprobe zram

# Check available devices
ls /dev/zram*

# Configure zram device 0
# Set compression algorithm
echo lz4 > /sys/block/zram0/comp_algorithm

# Set maximum size (uncompressed). Common recommendation: 50% of RAM
TOTAL_RAM=$(grep MemTotal /proc/meminfo | awk '{print $2}')
ZRAM_SIZE=$((TOTAL_RAM / 2))  # 50% of RAM in KB
echo "${ZRAM_SIZE}K" > /sys/block/zram0/disksize

# Format as swap
mkswap /dev/zram0

# Enable with highest priority
swapon -p 32767 /dev/zram0

# Verify
zramctl
# NAME       ALGORITHM DISKSIZE DATA COMPR TOTAL STREAMS MOUNTPOINT
# /dev/zram0 lz4           8G   2.1G  512M  560M       8 [SWAP]
```

### Multiple zram Devices for Multi-Core Systems

For systems with many cores, multiple zram devices reduce lock contention:

```bash
# Create one zram device per CPU socket
NUM_CPUS=$(nproc)
TOTAL_RAM=$(grep MemTotal /proc/meminfo | awk '{print $2}')
ZRAM_TOTAL_KB=$((TOTAL_RAM / 2))
ZRAM_PER_DEVICE_KB=$((ZRAM_TOTAL_KB / NUM_CPUS))

# Set number of devices
echo $NUM_CPUS > /sys/class/zram-control/hot_add  # hot_add creates a new device

for i in $(seq 0 $((NUM_CPUS - 1))); do
    echo lz4 > /sys/block/zram${i}/comp_algorithm
    echo "${ZRAM_PER_DEVICE_KB}K" > /sys/block/zram${i}/disksize
    mkswap /dev/zram${i}
    swapon -p 32767 /dev/zram${i}
done
```

### Persistent zram with systemd

```ini
# /etc/systemd/system/zram-swap.service
[Unit]
Description=Configure zram swap
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/setup-zram.sh
ExecStop=/usr/local/sbin/teardown-zram.sh

[Install]
WantedBy=multi-user.target
```

```bash
# /usr/local/sbin/setup-zram.sh
#!/bin/bash
set -euo pipefail

modprobe zram

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
ZRAM_SIZE_KB=$((TOTAL_RAM_KB / 2))

echo lz4 > /sys/block/zram0/comp_algorithm
echo "${ZRAM_SIZE_KB}K" > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 32767 /dev/zram0

echo "zram0 configured: ${ZRAM_SIZE_KB}K at priority 32767"
```

### zram Monitoring

```bash
# Detailed zram statistics
zramctl --output NAME,DISKSIZE,DATA,COMPR,TOTAL,RATIO,ALGORITHM,STREAMS

# Per-device statistics
cat /sys/block/zram0/stat
# 225 0 1800 ... (similar to /proc/diskstats)

# Detailed stats
cat /sys/block/zram0/mm_stat
# orig_data_size compr_data_size mem_used_total mem_limit ...
```

## Section 6: Comparing Swap, zswap, and zram

```
                    | Disk Swap | zswap+disk | zram
--------------------|-----------|------------|------
Access latency      | 1-5ms     | <1μs (hit) | <1μs
                    |           | 1-5ms(miss)|
Capacity beyond RAM | Yes       | Yes        | No (bounded by RAM)
RAM overhead        | Minimal   | Pool size  | Full compressed pages
Survives OOM        | Sometimes | Sometimes  | No (compressed in RAM)
Best for            | Rare swap | Frequent   | Low-latency swap
                    | bursts    | swap       | requirement
```

### Recommended Configuration by Use Case

**Kubernetes worker node (database workload):**
```bash
# Minimal swap only for OOM prevention
zram: 1GB
vm.swappiness=1
```

**Kubernetes worker node (general purpose):**
```bash
# zswap with fallback to disk
zswap enabled, 20% pool
disk swap: 8GB
vm.swappiness=10
```

**Desktop with 16GB RAM:**
```bash
# zram for transparent compression
zram: 8GB (50% of RAM)
vm.swappiness=100  # aggressive swap to zram is fast and transparent
```

**VM with constrained disk I/O:**
```bash
# zram to avoid disk I/O entirely
zram: 50% of RAM
No disk swap
vm.swappiness=60
```

## Section 7: Kubernetes Swap Support

Kubernetes historically required swap to be disabled on worker nodes. Starting in Kubernetes 1.28, swap support moved to beta for Linux nodes.

### Enabling Swap Support in Kubernetes 1.28+

```yaml
# kubelet configuration
# /etc/kubernetes/kubelet.conf or kubelet ConfigMap
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false
memorySwap:
  swapBehavior: LimitedSwap  # or NoSwap, UnlimitedSwap
```

```bash
# Node must have swap configured
swapon --show  # Must show active swap

# Kubelet feature gate (pre-1.28)
--feature-gates=NodeSwap=true

# For 1.28+ with beta, feature gate is enabled by default
```

### Swap Behavior Options

**NoSwap (default when swap enabled on node):**
Pods cannot use swap. Same as before, but the kubelet no longer fails when swap is enabled.

**LimitedSwap:**
Pods can use swap proportional to their memory limit. A pod with a 100Mi memory limit can use up to 100Mi of swap. This formula applies:

```
swapAllowed = (node_swap_capacity * pod_memory_limit) / node_memory_capacity
```

**UnlimitedSwap (not recommended for multi-tenant):**
Pods can use swap without limits. The pod memory limit only applies to RAM.

### Pod-Level Swap Configuration

```yaml
# With LimitedSwap, resource requests affect swap allocation
apiVersion: v1
kind: Pod
metadata:
  name: memory-intensive
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          memory: "256Mi"    # RAM allocation
        limits:
          memory: "512Mi"    # RAM limit; swap allocation proportional
```

### OOM Behavior with Swap Enabled

With swap enabled, the OOM killer behavior changes:

```
Scenario: Container exceeds memory limit with LimitedSwap
1. Container hits memory limit (RAM portion)
2. Kernel tries to swap anonymous pages to swap
3. If swap also exhausted, OOM kill triggered
4. OOM kill is delayed vs. no-swap scenario

Scenario: Container exceeds memory limit without swap
1. Container hits memory limit
2. OOM kill triggered immediately
```

For latency-sensitive applications, immediate OOM kill (no swap) is often preferable to swap-induced latency spikes.

## Section 8: OOM Killer Configuration

### OOM Score Adjustment

The OOM killer scores processes based on memory usage and oom_score_adj:

```bash
# Check OOM scores for running processes
for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
    score=$(cat /proc/$pid/oom_score 2>/dev/null)
    adj=$(cat /proc/$pid/oom_score_adj 2>/dev/null)
    cmd=$(cat /proc/$pid/comm 2>/dev/null)
    echo "$score $adj $cmd"
done | sort -rn | head -20
```

```bash
# Protect critical processes from OOM kill
echo -1000 > /proc/$(pgrep postgres)/oom_score_adj
# -1000 = never kill
# -999 to -1 = very unlikely to kill
# 0 = default
# 1-999 = increasingly likely to kill
# 1000 = kill first

# For Kubernetes containers, set via pod spec
```

```yaml
# Kubernetes pod with OOM protection
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: critical-app
      resources:
        requests:
          memory: "1Gi"
        limits:
          memory: "2Gi"
  # Guaranteed QoS class (requests == limits) gets lower OOM score
```

### Kubernetes QoS Classes and OOM Priority

```
Guaranteed (requests == limits):  oom_score_adj = -997
Burstable (requests < limits):    oom_score_adj = min(max(2, 1000-10*(limit/request)), 999)
BestEffort (no requests/limits):  oom_score_adj = 1000
```

This means BestEffort pods are killed first, then Burstable, then Guaranteed.

## Section 9: Memory Pressure Monitoring

### Key Metrics to Monitor

```bash
# PSI (Pressure Stall Information) - shows memory pressure impact
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.00 avg300=0.00 total=123456
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = some tasks stalled on memory
# "full" = ALL tasks stalled on memory (most severe)

# Prometheus: node_pressure_memory_stalled_seconds_total
```

```bash
# Watch for swap activity
vmstat -w 1
# si: swap in pages/sec
# so: swap out pages/sec
# If so > 0, you are swapping; if si > 0, you are swapping in (worse)
```

### Grafana Dashboard Alert Rules

```yaml
# PrometheusRule for swap monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: memory-pressure
spec:
  groups:
    - name: memory
      rules:
        - alert: HighSwapUsage
          expr: (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) / node_memory_SwapTotal_bytes > 0.5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.instance }} swap usage above 50%"

        - alert: MemoryPressureHigh
          expr: rate(node_vmstat_pswpout[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.instance }} swapping out >100 pages/sec"

        - alert: MemoryPressureCritical
          expr: rate(node_vmstat_pswpin[5m]) > 100
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.instance }} swapping IN >100 pages/sec (severe degradation)"
```

## Section 10: Production Configuration Reference

### Complete sysctl Configuration for Different Workloads

```bash
# /etc/sysctl.d/99-memory-tuning.conf

# === Database Server (PostgreSQL/MySQL) ===
vm.swappiness=1
vm.dirty_ratio=15
vm.dirty_background_ratio=3
vm.overcommit_memory=0

# === Kubernetes Worker Node (General Purpose) ===
vm.swappiness=10
vm.dirty_ratio=20
vm.dirty_background_ratio=5
vm.overcommit_memory=1   # Allow memory overcommit for containers

# === Memory-Constrained VM or Edge Node ===
vm.swappiness=60
vm.dirty_ratio=40
vm.dirty_background_ratio=10

# === Real-time/Latency-Sensitive (Financial, Telco) ===
vm.swappiness=0          # Zero: never swap if possible
vm.dirty_ratio=5
vm.dirty_background_ratio=2
# Also consider: huge pages, CPU pinning, NUMA affinity
```

### Validating Swap Configuration

```bash
#!/bin/bash
# validate-swap.sh - Validates swap configuration for a Kubernetes node

echo "=== Swap Configuration Validation ==="

# Check swap devices
echo -e "\n--- Swap Devices ---"
swapon --show 2>/dev/null || echo "No swap enabled"

# Check swappiness
SWAPPINESS=$(sysctl -n vm.swappiness)
echo -e "\n--- Swappiness: $SWAPPINESS ---"
if [ "$SWAPPINESS" -le 10 ]; then
    echo "OK: Low swappiness appropriate for production"
elif [ "$SWAPPINESS" -le 60 ]; then
    echo "WARN: Moderate swappiness (consider reducing for databases)"
else
    echo "WARN: High swappiness (may cause unexpected swap on production)"
fi

# Check zswap
echo -e "\n--- zswap Status ---"
if [ -f /sys/module/zswap/parameters/enabled ]; then
    ZSWAP_ENABLED=$(cat /sys/module/zswap/parameters/enabled)
    ZSWAP_COMPRESSOR=$(cat /sys/module/zswap/parameters/compressor)
    ZSWAP_MAX=$(cat /sys/module/zswap/parameters/max_pool_percent)
    echo "Enabled: $ZSWAP_ENABLED"
    echo "Compressor: $ZSWAP_COMPRESSOR"
    echo "Max pool: ${ZSWAP_MAX}%"
else
    echo "zswap module not loaded"
fi

# Check zram
echo -e "\n--- zram Devices ---"
if command -v zramctl &>/dev/null; then
    zramctl 2>/dev/null || echo "No zram devices"
else
    echo "zramctl not available"
fi

# Check memory pressure
echo -e "\n--- Memory Pressure (PSI) ---"
if [ -f /proc/pressure/memory ]; then
    cat /proc/pressure/memory
else
    echo "PSI not available (kernel <4.20 or not enabled)"
fi

# Check OOM
echo -e "\n--- Recent OOM Events ---"
dmesg --since "1 day ago" 2>/dev/null | grep -i "oom\|out of memory" | tail -5 || \
    journalctl --since "1 day ago" -k 2>/dev/null | grep -i "oom\|out of memory" | tail -5 || \
    echo "No recent OOM events found"

echo -e "\n=== Validation Complete ==="
```

Swap configuration is not a set-and-forget concern. As workload characteristics change, swap requirements change. Regular monitoring of PSI metrics, swap I/O rates, and OOM events guides ongoing tuning. The combination of low swappiness, zswap for compression-friendly acceleration, and careful Kubernetes QoS class assignment provides the best balance between performance and resilience for production Kubernetes clusters.
