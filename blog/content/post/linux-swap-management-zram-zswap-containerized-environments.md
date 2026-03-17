---
title: "Linux Swap Management: ZRAM, ZSWAP, and Swap Strategies for Containerized Environments"
date: 2030-03-27T00:00:00-05:00
draft: false
tags: ["Linux", "Swap", "ZRAM", "ZSWAP", "Kubernetes", "Memory Management", "Performance", "OOM"]
categories: ["Linux", "Kubernetes", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux swap management for containerized workloads, covering ZRAM compressed in-memory swap, ZSWAP as writeback cache, Kubernetes node swap configuration, OOM killer behavior, and memory pressure handling strategies."
more_link: "yes"
url: "/linux-swap-management-zram-zswap-containerized-environments/"
---

Swap management is one of the most misunderstood aspects of configuring Linux nodes for containerized workloads. The conventional wisdom "disable swap on Kubernetes nodes" has been followed mechanically by thousands of teams without understanding why it was originally recommended — and without understanding the significant performance costs it can impose under memory pressure.

The situation has evolved substantially. Kubernetes has supported swap-enabled nodes since version 1.28, ZRAM (compressed in-memory swap) offers a fundamentally different trade-off than disk-backed swap, and ZSWAP can function as a writeback cache that captures the benefits of ZRAM while still evicting cold pages to disk when needed. This guide examines the full spectrum of Linux swap technologies and provides concrete recommendations for containerized environments.

<!--more-->

## The Swap Trade-Off

The fundamental tension in swap management is between two failure modes:

**OOM killing with swap disabled**: When a node runs out of physical memory, the kernel's Out-of-Memory (OOM) killer terminates processes. In a Kubernetes context, the kubelet's memory pressure condition evicts pods before the OOM killer fires, but if eviction is too slow or limits are too tight, pods die with OOMKilled status. This is immediate, observable, and surfaced as a hard failure that operations teams can act on.

**Latency degradation with disk swap enabled**: When swap space fills with disk-backed pages, the process of moving memory pages to and from a spinning disk or even an SSD introduces latencies measured in milliseconds for what should be nanosecond operations. A Java JVM that has half its heap swapped to an NVMe drive will experience GC pauses of tens of seconds. The degradation is gradual, difficult to diagnose, and can masquerade as application bugs.

ZRAM changes this calculation because the backing store is compressed RAM, not a disk. The trade-off becomes CPU cycles for decompression versus immediate OOM — a much more favorable exchange for most workloads.

## Kernel Memory Management Fundamentals

Before configuring anything, understanding what the kernel does with memory pressure helps:

```
Physical Memory Pages
        │
        ├── Active (recently used, hard to evict)
        │   ├── File-backed (can be dropped and re-read from disk)
        │   └── Anonymous (heap, stack — must go to swap)
        │
        └── Inactive (candidates for reclaim)
            ├── File-backed (drop or writeback to disk)
            └── Anonymous (must go to swap or be killed)
```

```bash
# Current memory statistics
cat /proc/meminfo | grep -E '(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree|SwapCached|Dirty|Writeback|Active|Inactive|Anon|Mapped|Shmem)'

# Example output on a 64GB system
# MemTotal:       65536000 kB
# MemFree:         2048000 kB
# MemAvailable:   45000000 kB
# SwapTotal:       8388608 kB
# SwapFree:        7500000 kB
# SwapCached:        50000 kB
# Active:         18000000 kB
# Inactive:       12000000 kB
# Active(anon):    8000000 kB
# Inactive(anon):  3000000 kB
# Active(file):   10000000 kB
# Inactive(file):  9000000 kB

# Current vm.swappiness
cat /proc/sys/vm/swappiness

# Memory pressure information from cgroup v2
cat /sys/fs/cgroup/memory.pressure 2>/dev/null || echo "cgroup v1 or feature not enabled"
```

### vm.swappiness Explained

`vm.swappiness` does not control "how aggressively the kernel swaps." It controls the relative preference for evicting anonymous pages (going to swap) versus file pages (going to disk write-back or being dropped).

- `swappiness = 0`: Strongly prefer evicting file pages; use swap only when absolutely necessary
- `swappiness = 60`: Default — balanced preference
- `swappiness = 100`: Treat anonymous and file pages equally
- `swappiness = 200` (kernel 5.8+, only for ZRAM): Strongly prefer swapping because ZRAM is cheaper than evicting hot file caches

```bash
# View current swappiness
sysctl vm.swappiness

# Change for current session
sysctl -w vm.swappiness=100

# Make permanent
echo 'vm.swappiness = 100' > /etc/sysctl.d/99-swap.conf
sysctl -p /etc/sysctl.d/99-swap.conf
```

## ZRAM: Compressed In-Memory Swap

ZRAM creates a block device in RAM that compresses its contents using an algorithm like lz4, zstd, or lzo-rle. When the kernel writes a page to this device, the page is compressed and stored in physical RAM. The effective capacity is (physical RAM allocated to zram) / (compression ratio), which for typical workloads achieves 2:1 to 4:1 compression.

### When ZRAM Makes Sense

ZRAM is most beneficial when:
- Processes have inactive memory (cold data structures, dormant connections) that compress well
- The workload can tolerate brief CPU spikes for decompression
- Memory pressure is occasional rather than sustained
- You want a buffer against OOM events without disk latency

ZRAM is less beneficial when:
- The machine is compute-bound (CPU already at capacity)
- Data in memory does not compress (encrypted content, already-compressed images)
- Memory pressure is so severe that ZRAM fills up entirely (at which point you need real swap)

### Configuring ZRAM

```bash
# Check if zram module is available
modinfo zram

# Load the module with multiple devices
modprobe zram num_devices=1

# Check available compression algorithms
cat /sys/block/zram0/comp_algorithm
# lzo lzo-rle lz4 lz4hc [zstd]  — bracketed one is current

# Set compression algorithm (zstd gives best ratio, lz4 lowest latency)
echo zstd > /sys/block/zram0/comp_algorithm

# Set max compression streams (usually equal to CPU cores)
echo $(nproc) > /sys/block/zram0/max_comp_streams

# Configure ZRAM size
# Recommendation: 50% of RAM for general use, 100% for heavily pressured nodes
RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
ZRAM_SIZE_KB=$((RAM_KB / 2))
echo "${ZRAM_SIZE_KB}K" > /sys/block/zram0/disksize

# Format and enable as swap
mkswap /dev/zram0
swapon -p 100 /dev/zram0   # priority 100 — prefer over disk swap

# Verify
swapon --show
# NAME       TYPE      SIZE   USED PRIO
# /dev/zram0 partition  32G     0B  100
```

### Systemd Service for ZRAM

For persistent configuration across reboots:

```ini
# /etc/systemd/system/zram-setup.service
[Unit]
Description=Configure ZRAM swap
After=multi-user.target
Before=kubelet.service

[Service]
Type=oneshot
RemainAfterExit=yes

ExecStartPre=/sbin/modprobe zram num_devices=1
ExecStart=/bin/bash -c '\
  echo zstd > /sys/block/zram0/comp_algorithm && \
  echo $(nproc) > /sys/block/zram0/max_comp_streams && \
  RAM_KB=$(grep MemTotal /proc/meminfo | awk "{print $2}") && \
  echo "$((RAM_KB / 2))K" > /sys/block/zram0/disksize && \
  mkswap /dev/zram0 && \
  swapon -p 100 /dev/zram0'

ExecStop=/sbin/swapoff /dev/zram0

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now zram-setup.service
```

### ZRAM Statistics and Monitoring

```bash
# View ZRAM statistics
cat /sys/block/zram0/mm_stat
# orig_data_size compr_data_size mem_used_total mem_limit mem_used_max same_pages pages_compacted
# 4294967296     1536870912      1610612736     0         2147483648   0          0

# Parse mm_stat
python3 - << 'EOF'
with open('/sys/block/zram0/mm_stat') as f:
    vals = f.read().split()
fields = [
    'orig_data_size', 'compr_data_size', 'mem_used_total',
    'mem_limit', 'mem_used_max', 'same_pages', 'pages_compacted'
]
stats = dict(zip(fields, [int(v) for v in vals]))
ratio = stats['orig_data_size'] / max(stats['compr_data_size'], 1)
print(f"Data stored:      {stats['orig_data_size'] / 1e9:.1f} GB (uncompressed)")
print(f"Actual RAM used:  {stats['mem_used_total'] / 1e9:.1f} GB")
print(f"Compression ratio: {ratio:.2f}x")
print(f"Space saved:      {(stats['orig_data_size'] - stats['compr_data_size']) / 1e9:.1f} GB")
EOF

# Monitor ZRAM with vmstat
vmstat -s | grep -i swap

# Real-time swap activity
watch -n 1 'cat /proc/swaps && echo && cat /sys/block/zram0/mm_stat'
```

### Prometheus Exporter for ZRAM Metrics

```go
// zram_exporter.go — expose ZRAM metrics to Prometheus
package main

import (
    "fmt"
    "log"
    "net/http"
    "os"
    "strconv"
    "strings"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

type ZRAMCollector struct {
    device string

    origDataSize  *prometheus.Desc
    comprDataSize *prometheus.Desc
    memUsedTotal  *prometheus.Desc
    comprRatio    *prometheus.Desc
}

func NewZRAMCollector(device string) *ZRAMCollector {
    labels := []string{"device"}
    return &ZRAMCollector{
        device: device,
        origDataSize: prometheus.NewDesc(
            "zram_orig_data_size_bytes",
            "Uncompressed size of data stored in ZRAM",
            labels, nil,
        ),
        comprDataSize: prometheus.NewDesc(
            "zram_compr_data_size_bytes",
            "Compressed size of data in ZRAM",
            labels, nil,
        ),
        memUsedTotal: prometheus.NewDesc(
            "zram_mem_used_total_bytes",
            "Total RAM used by ZRAM including metadata",
            labels, nil,
        ),
        comprRatio: prometheus.NewDesc(
            "zram_compression_ratio",
            "Current ZRAM compression ratio (orig/compressed)",
            labels, nil,
        ),
    }
}

func (z *ZRAMCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- z.origDataSize
    ch <- z.comprDataSize
    ch <- z.memUsedTotal
    ch <- z.comprRatio
}

func (z *ZRAMCollector) Collect(ch chan<- prometheus.Metric) {
    data, err := os.ReadFile(fmt.Sprintf("/sys/block/%s/mm_stat", z.device))
    if err != nil {
        log.Printf("read mm_stat: %v", err)
        return
    }
    fields := strings.Fields(strings.TrimSpace(string(data)))
    if len(fields) < 3 {
        return
    }
    origSize, _ := strconv.ParseFloat(fields[0], 64)
    comprSize, _ := strconv.ParseFloat(fields[1], 64)
    memUsed, _ := strconv.ParseFloat(fields[2], 64)

    ratio := 0.0
    if comprSize > 0 {
        ratio = origSize / comprSize
    }

    lv := []string{z.device}
    ch <- prometheus.MustNewConstMetric(z.origDataSize, prometheus.GaugeValue, origSize, lv...)
    ch <- prometheus.MustNewConstMetric(z.comprDataSize, prometheus.GaugeValue, comprSize, lv...)
    ch <- prometheus.MustNewConstMetric(z.memUsedTotal, prometheus.GaugeValue, memUsed, lv...)
    ch <- prometheus.MustNewConstMetric(z.comprRatio, prometheus.GaugeValue, ratio, lv...)
}

func main() {
    collector := NewZRAMCollector("zram0")
    prometheus.MustRegister(collector)

    http.Handle("/metrics", promhttp.Handler())
    http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintln(w, "ok")
    })

    log.Printf("ZRAM exporter starting on :9199")
    srv := &http.Server{
        Addr:         ":9199",
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
    }
    log.Fatal(srv.ListenAndServe())
}
```

## ZSWAP: Compressed Writeback Cache

ZSWAP sits between the kernel's anonymous page reclaim path and a traditional swap device. Rather than writing pages directly to disk, ZSWAP intercepts them, compresses them in RAM, and only writes to disk when the compressed pool itself becomes full. This gives the benefits of ZRAM compression while still allowing overflow to disk.

```
Anonymous page reclaim
        │
        ▼
    ZSWAP pool
    (compressed RAM)
        │
        │ (when pool is full)
        ▼
    Swap device
    (disk/NVMe)
```

### ZSWAP vs ZRAM

| Feature | ZRAM | ZSWAP |
|---------|------|-------|
| Backing store | RAM only | RAM + disk swap |
| Configuration | Block device + swapon | Kernel parameter only |
| Overflow behavior | OOM when full | Writes to disk swap |
| Setup complexity | Moderate | Simple |
| Use case | Systems without disk swap | Systems with existing swap |

### Enabling ZSWAP

```bash
# Check if ZSWAP is compiled into the kernel
cat /sys/module/zswap/parameters/enabled 2>/dev/null || echo "Not loaded"

# Enable ZSWAP (requires swap partition to be present)
echo 1 > /sys/module/zswap/parameters/enabled
echo zstd > /sys/module/zswap/parameters/compressor
echo z3fold > /sys/module/zswap/parameters/zpool      # efficient pool allocator
echo 20 > /sys/module/zswap/parameters/max_pool_percent  # use up to 20% of RAM

# Verify settings
grep -r '' /sys/module/zswap/parameters/

# Monitor ZSWAP statistics
cat /sys/kernel/debug/zswap/pool_pages 2>/dev/null    # compressed pages
cat /sys/kernel/debug/zswap/stored_pages 2>/dev/null  # total pages stored
cat /sys/kernel/debug/zswap/written_back_pages 2>/dev/null  # pages evicted to disk
```

```bash
# Persistent ZSWAP configuration via kernel command line
# Add to /etc/default/grub GRUB_CMDLINE_LINUX:
# zswap.enabled=1 zswap.compressor=zstd zswap.max_pool_percent=20 zswap.zpool=z3fold

# Or via sysctl for parameters that accept it
cat > /etc/sysctl.d/99-zswap.conf << 'EOF'
# ZSWAP is configured at boot via kernel cmdline parameters.
# The following adjustments tune memory behavior with ZSWAP active.
vm.swappiness = 60
vm.watermark_boost_factor = 0
vm.watermark_scale_factor = 125
EOF
```

## Kubernetes and Swap

### Historical Background

Kubernetes originally required swap to be disabled because kubelet could not properly account for memory usage that included swapped pages. The `--fail-swap-on=true` flag was the default, causing kubelet to refuse to start if swap was active.

Since Kubernetes 1.28 (GA in 1.30), swap support for Linux nodes is available with `NodeSwap` feature gate enabled. The behavior differs by pod QoS class.

### Enabling Swap on Kubernetes Nodes

```yaml
# kubelet configuration — /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
memorySwap:
  swapBehavior: LimitedSwap   # or NoSwap (disable swap for all containers)
# With LimitedSwap:
# - Guaranteed QoS pods: no swap (memory limit = memory request)
# - Burstable QoS pods: proportional swap based on (request/total) * swap available
# - BestEffort QoS pods: can use all available swap
featureGates:
  NodeSwap: true
```

```bash
# Apply kubelet config changes
systemctl restart kubelet

# Verify kubelet started with swap allowed
journalctl -u kubelet | grep -i swap | tail -5
# kubelet[1234]: "Swap is enabled" node="worker-01"
```

### Node-Level Swap Configuration for Kubernetes

The recommended approach for Kubernetes nodes is ZRAM with `vm.swappiness = 0` for disk swap and a high priority ZRAM device.

```bash
#!/usr/bin/env bash
# configure-k8s-node-memory.sh
# Run this on each Kubernetes worker node.
set -euo pipefail

# 1. Disable any disk-backed swap
for dev in $(swapon --show=NAME --noheadings 2>/dev/null); do
    [[ "$dev" == /dev/zram* ]] && continue
    echo "Disabling disk swap: $dev"
    swapoff "$dev" || true
done

# Comment out disk swap entries in fstab
sed -i 's|^[^#].*swap.*|#&  # disabled for Kubernetes|g' /etc/fstab

# 2. Set up ZRAM
modprobe zram num_devices=1

# Choose compressor: zstd (best ratio), lz4 (lowest latency)
echo zstd > /sys/block/zram0/comp_algorithm
echo "$(nproc)" > /sys/block/zram0/max_comp_streams

# Size: 50% of RAM for most workloads
RAM_BYTES=$(awk '/MemTotal/{print $2 * 1024}' /proc/meminfo)
ZRAM_BYTES=$((RAM_BYTES / 2))
echo "$ZRAM_BYTES" > /sys/block/zram0/disksize

mkswap /dev/zram0
swapon -p 100 /dev/zram0

# 3. Kernel parameters
cat > /etc/sysctl.d/99-kubernetes-memory.conf << 'EOF'
# Swappiness for ZRAM: higher value is fine since ZRAM is compressed RAM
# Use 100 for ZRAM-only, 10 if any disk swap exists
vm.swappiness = 100

# Reduce kernel's tendency to over-commit memory
# 0 = heuristic overcommit (default)
# 1 = always allow overcommit (dangerous)
# 2 = never overcommit beyond (CommitLimit = swap + RAM * overcommit_ratio/100)
vm.overcommit_memory = 0

# Transparent huge pages — disable for container workloads with variable allocation
# (check: cat /sys/kernel/mm/transparent_hugepage/enabled)
# Defrag can cause latency spikes

# Memory pressure before starting page reclaim
vm.min_free_kbytes = 131072   # 128 MB minimum free

# How aggressively to reclaim cache under pressure
vm.vfs_cache_pressure = 50

# Dirty page write-back thresholds
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5
EOF

sysctl -p /etc/sysctl.d/99-kubernetes-memory.conf

echo "Memory configuration complete"
swapon --show
cat /proc/meminfo | grep -E '(MemAvailable|SwapTotal|SwapFree)'
```

### Pod-Level Memory Configuration

```yaml
# pod with proper memory configuration for swap-aware nodes
apiVersion: v1
kind: Pod
metadata:
  name: memory-aware-app
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          memory: "512Mi"    # Pod gets swap allocation proportional to this
          cpu: "250m"
        limits:
          memory: "1Gi"      # Hard memory ceiling
          cpu: "1"
      # Setting request == limit makes this a Guaranteed pod
      # Guaranteed pods do NOT use swap (even with LimitedSwap enabled)
```

```yaml
# LimitRange to prevent accidental Guaranteed classification
apiVersion: v1
kind: LimitRange
metadata:
  name: memory-defaults
  namespace: production
spec:
  limits:
    - type: Container
      default:
        memory: "512Mi"
        cpu: "500m"
      defaultRequest:
        memory: "256Mi"   # request < limit = Burstable = can use swap
        cpu: "100m"
```

## OOM Killer Behavior and Tuning

When swap is exhausted (or disabled), the OOM killer selects a process to terminate. Understanding its selection algorithm helps configure workloads to survive OOM events in the intended order.

### OOM Score Adjustment

```bash
# View current OOM scores for all processes
ps aux --sort=-%mem | head -20 | while read user pid cpu mem vsz rss tty stat start time cmd; do
    [[ "$pid" == "PID" ]] && continue
    score=$(cat /proc/$pid/oom_score 2>/dev/null || echo 0)
    adj=$(cat /proc/$pid/oom_score_adj 2>/dev/null || echo 0)
    printf "pid=%-6s score=%-4s adj=%-5s %s\n" "$pid" "$score" "$adj" "$cmd"
done

# Set OOM score adjustment for a process
# Range: -1000 (never kill) to 1000 (kill first)
# 0 = default kernel heuristic
# -1000 = protected from OOM killer

# Protect a critical system process
echo -1000 > /proc/$(pgrep kubelet)/oom_score_adj

# Mark a low-priority process as preferred OOM victim
echo 500 > /proc/$(pgrep low-priority-app)/oom_score_adj
```

### Kubernetes OOM Score Management

Kubernetes sets OOM scores automatically based on QoS class:

- **Guaranteed** (request == limit): `oom_score_adj = -997` (nearly protected)
- **Burstable** (request < limit): `oom_score_adj = 2 + (1000 * request/capacity)`
- **BestEffort** (no requests/limits): `oom_score_adj = 1000` (first to be killed)
- **kubelet**: `oom_score_adj = -999`
- **container runtime**: `oom_score_adj = -999`

```bash
# Verify OOM scores on a running node
kubectl get pods -A -o wide | grep "$(hostname)" | awk '{print $2, $1}' | \
while read pod ns; do
    pid=$(kubectl exec -n "$ns" "$pod" -- cat /proc/1/oom_score 2>/dev/null) || continue
    adj=$(kubectl exec -n "$ns" "$pod" -- cat /proc/1/oom_score_adj 2>/dev/null) || continue
    echo "ns=$ns pod=$pod score=$pid adj=$adj"
done
```

### Memory Pressure Detection

```bash
# Detect memory pressure before OOM fires
# PSI (Pressure Stall Information) — Linux 4.20+
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = at least one task stalled waiting for memory
# "full" = all tasks stalled waiting for memory
# avg10/60/300 = exponential moving average over 10s/60s/300s

# Real-time memory pressure monitoring
watch -n 1 'cat /proc/pressure/memory && echo && free -h && echo && cat /proc/swaps'

# cgroup v2 memory pressure (per-pod in Kubernetes)
find /sys/fs/cgroup -name "memory.pressure" 2>/dev/null | head -10 | \
while read f; do
    echo "=== $f ==="
    cat "$f"
done
```

### Alerting on Memory Pressure

```yaml
# prometheus-rules for memory pressure
groups:
  - name: memory.pressure
    rules:
      - alert: NodeMemoryPressureHigh
        expr: |
          (
            node_memory_MemAvailable_bytes /
            node_memory_MemTotal_bytes
          ) < 0.10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} available memory below 10%"
          description: "Available: {{ $value | humanizePercentage }}"

      - alert: NodeSwapUsageHigh
        expr: |
          (
            (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) /
            node_memory_SwapTotal_bytes
          ) > 0.80
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Swap usage above 80% on {{ $labels.instance }}"

      - alert: ZRAMCompressionRatioDegraded
        expr: zram_compression_ratio{device="zram0"} < 1.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "ZRAM compression ratio below 1.5x — data may not be compressible"
```

## Comparing Strategies: Decision Matrix

```
┌───────────────────────────────────────────────────────────────┐
│              Memory Strategy Decision Matrix                   │
├───────────────┬──────────────┬──────────────┬────────────────┤
│               │  No Swap     │  ZRAM Only   │ ZRAM + Disk    │
├───────────────┼──────────────┼──────────────┼────────────────┤
│ OOM Risk      │ High         │ Medium       │ Low            │
│ Latency Risk  │ None         │ Low (CPU)    │ High (disk I/O)│
│ Complexity    │ Low          │ Medium       │ Medium         │
│ Cost          │ Low          │ Low          │ Medium         │
│ Best For      │ Latency-     │ General      │ Batch/         │
│               │ critical     │ workloads    │ analytics      │
│               │ workloads    │              │ workloads      │
├───────────────┼──────────────┼──────────────┼────────────────┤
│ Recommended   │ Databases,   │ Web servers, │ ML training,   │
│ Workloads     │ RT apps,     │ API services,│ data pipelines,│
│               │ GPU compute  │ mixed pods   │ batch jobs     │
└───────────────┴──────────────┴──────────────┴────────────────┘
```

### Recommended Configuration by Node Role

**Kubernetes control plane nodes**:
```bash
# Control plane: protect critical services, minimal swap
modprobe zram num_devices=1
echo zstd > /sys/block/zram0/comp_algorithm
# Small ZRAM: 25% of RAM, only for emergencies
RAM_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo)
echo "$((RAM_KB * 1024 / 4))" > /sys/block/zram0/disksize
mkswap /dev/zram0 && swapon -p 100 /dev/zram0
sysctl -w vm.swappiness=10  # strongly prefer not swapping
```

**Kubernetes general purpose worker nodes**:
```bash
# General workers: ZRAM at 50% of RAM, moderate swappiness
echo "$((RAM_KB * 1024 / 2))" > /sys/block/zram0/disksize
sysctl -w vm.swappiness=100  # ZRAM is cheap
```

**Kubernetes batch/ML worker nodes**:
```bash
# Batch workers: ZRAM + disk swap for large working sets
echo "$((RAM_KB * 1024 / 2))" > /sys/block/zram0/disksize
mkswap /dev/zram0 && swapon -p 100 /dev/zram0
# Also add a disk swap partition at lower priority
swapon -p 10 /dev/nvme0n1p2
sysctl -w vm.swappiness=60
```

## Key Takeaways

The "disable swap on Kubernetes nodes" recommendation made sense in 2017 when kubelet could not account for swap usage in memory limits. It is no longer unconditionally correct.

ZRAM is the right default for most Kubernetes worker nodes. It provides a buffer against OOM events at the cost of CPU cycles for compression, not disk I/O latency. With `vm.swappiness = 100` and ZRAM as the only swap device, the kernel will preferentially compress cold anonymous pages before evicting file caches — a favorable trade-off for most container workloads.

ZSWAP is appropriate when you already have disk swap configured and want to reduce disk write pressure. It intercepts swap writes and stores them compressed in RAM first, falling back to disk only when the compressed pool fills.

Disk-backed swap remains appropriate for batch and analytics workloads where latency spikes are acceptable and large working sets that exceed physical RAM are expected. It should not be used on nodes running latency-sensitive services.

The OOM killer is not a catastrophe to be avoided at all costs. A well-configured Kubernetes cluster with properly set resource requests and limits will have pods evicted before OOM events occur. The goal is not to eliminate OOM entirely but to ensure that when memory pressure occurs, the right pods are evicted in the right order with the minimum possible collateral damage.
