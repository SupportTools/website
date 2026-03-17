---
title: "Linux Swap and zswap: Compressed Swap for Modern Workloads"
date: 2029-09-04T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Memory Management", "zswap", "Performance", "Kubernetes", "Containers"]
categories: ["Linux", "Performance", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux swap and zswap architecture covering zpool backends (z3fold, zbud), compression algorithms (lz4, zstd), swap priority configuration, and memory-constrained container tuning for Kubernetes workloads."
more_link: "yes"
url: "/linux-swap-zswap-compressed-swap-modern-workloads/"
---

The conventional wisdom that "swap is bad for production servers" made sense in the spinning-disk era where disk I/O was orders of magnitude slower than RAM access. On modern NVMe systems, and especially with zswap's compressed in-memory swap cache, the calculus has changed. zswap can reclaim up to 40% more effective memory with minimal latency overhead, and Kubernetes nodes with zswap enabled can sustain higher pod density without OOM kills. This guide covers the complete Linux memory reclaim stack from traditional swap through zswap configuration.

<!--more-->

# Linux Swap and zswap: Compressed Swap for Modern Workloads

## Section 1: Memory Reclaim Fundamentals

When Linux runs low on free memory, the kernel has three mechanisms for reclaiming pages:

1. **Page cache eviction**: Drop clean file-backed pages (they can be re-read from disk)
2. **Anonymous page swapping**: Write dirty anonymous pages (heap, stack, mmap'd regions without file backing) to swap
3. **OOM killing**: When all other mechanisms fail, kill the process using the most memory

The balance between these mechanisms is controlled by `vm.swappiness` and the relative costs of reading from swap vs. re-reading from disk. zswap adds a fourth option: **compress and cache** anonymous pages in a small pool of physical RAM before they ever touch the swap device.

### Why Swap Still Matters

Modern production systems need swap for several reasons:

- **Memory overcommit**: Linux overcommits memory by default. Without swap, programs that overcommit but rarely use their full allocation cause premature OOM kills.
- **Infrequently used data**: Programs have working sets. Pages that haven't been touched in hours can be compressed and cached rather than consuming expensive RAM.
- **Kubernetes pod isolation**: Without node-level swap, a single memory-hungry pod can trigger OOM kills on neighboring pods. With zswap, the kernel can gracefully degrade performance before killing pods.
- **JVM warm-up**: Java applications allocate large heaps at startup that they don't immediately use. Swap (or zswap) allows the JVM to start without pre-faulting every page.

## Section 2: Traditional Swap Configuration

### Creating Swap Space

```bash
# Option 1: Swap partition (better performance, fixed size)
# Assuming /dev/sdb is a dedicated swap disk
mkswap -L swap0 /dev/sdb
swapon -p 10 /dev/sdb  # Priority 10 (higher = more preferred)
echo "/dev/sdb none swap sw,pri=10 0 0" >> /etc/fstab

# Option 2: Swap file (flexible size, slightly lower performance)
# Create a 32 GiB swap file using fallocate (faster than dd)
sudo fallocate -l 32G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon -p 5 /swapfile  # Priority 5 (lower than partition swap)
echo "/swapfile none swap sw,pri=5 0 0" >> /etc/fstab

# Verify swap is active
swapon --show
# NAME       TYPE  SIZE  USED PRIO
# /dev/sdb   part   32G  2.1G   10
# /swapfile  file   32G    0B    5

# Check current swap usage
free -h
# Total   Used   Free   Shared  Buff/Cache  Available
# Mem:     128G   96G    8G      1.2G        24G        30G
# Swap:    64G    2.1G   61.9G
```

### vm.swappiness Tuning

`vm.swappiness` controls the relative weight the kernel gives to swapping vs. reclaiming page cache pages. The range is 0-200 (kernel 5.8+), where:
- `0`: Never swap; only reclaim page cache
- `1`: Swap only when absolutely necessary
- `60` (default): Balance between swap and page cache reclaim
- `100`: Swap aggressively relative to page cache reclaim
- `200`: Swap twice as aggressively as page cache reclaim

```bash
# Check current swappiness
sysctl vm.swappiness
# vm.swappiness = 60

# For database servers: reduce swappiness to minimize latency impact
# The DB manages its own cache; OS should prefer reclaiming page cache
echo "vm.swappiness = 1" | sudo tee -a /etc/sysctl.d/90-memory.conf

# For containerized workloads (Kubernetes nodes): moderate swappiness
echo "vm.swappiness = 10" | sudo tee -a /etc/sysctl.d/90-memory.conf

# For batch processing nodes where throughput > latency:
echo "vm.swappiness = 60" | sudo tee -a /etc/sysctl.d/90-memory.conf

# Apply immediately
sudo sysctl -p /etc/sysctl.d/90-memory.conf

# Per-cgroup swappiness (for container isolation)
# Write to the cgroup's memory.swappiness:
echo 10 > /sys/fs/cgroup/memory/kubepods/memory.swappiness
```

## Section 3: zswap Architecture

zswap is an in-kernel compressed swap cache. Instead of writing a page to the physical swap device when it's evicted from RAM, zswap compresses the page and stores it in a dynamically-allocated pool in physical RAM. When the compressed pool fills up, the oldest pages are evicted to the actual swap device.

### Data Flow

```
Process memory (anonymous page)
          |
          | (memory pressure - page selected for eviction)
          v
      [zswap pool]
      Compress page with configured algorithm (lz4, zstd, lzo)
      Store compressed page in zpool (z3fold, zbud, zsmalloc)
          |
          | (pool full - zswap writeback)
          v
     [Swap Device]
     Write original (decompressed) page to NVMe/SSD swap
          |
          | (page fault - process accesses swapped-out page)
          v
   zswap lookup: Is page in compressed pool?
    YES: Decompress in-place, load into RAM in microseconds
    NO:  Read from swap device (milliseconds)
```

The key insight: zswap eliminates most swap I/O entirely. Only pages that overflow the compressed pool reach the swap device. For a typical server where 20-30% of memory is infrequently-used but alive (JVM heap, idle service buffers, kernel module data), zswap provides near-RAM latency for most "swap" operations.

### zpool Backends

The zpool is the memory allocator that backs zswap's compressed page store. Three backends are available:

**z3fold**: Three-to-one page folding. Stores up to 3 compressed objects per page, with good space efficiency. The default for most distributions. Best for workloads with diverse object sizes.

**zbud**: Two-to-one page folding. Stores up to 2 objects per page. Simpler and faster than z3fold but uses more memory. Good for latency-sensitive workloads.

**zsmalloc**: Variable-size object storage using size classes. Most space-efficient but adds metadata overhead. Used by zram (in-memory compressed block device). Best for workloads with highly compressible data.

```bash
# List available zpool backends
ls /sys/kernel/mm/zswap/

# Check current zpool backend
cat /sys/kernel/mm/zswap/zpool
# z3fold

# View all zswap parameters
ls /sys/kernel/mm/zswap/
# compressor  enabled  max_pool_percent  pool_limit_hit
# pool_total_size  same_filled_pages_enabled  stored_pages
# written_back_pages  zpool

# Current statistics
cat /sys/kernel/mm/zswap/stored_pages      # Pages in compressed pool
cat /sys/kernel/mm/zswap/pool_total_size    # Total bytes used by pool
cat /sys/kernel/mm/zswap/written_back_pages # Pages that overflowed to swap device
cat /sys/kernel/mm/zswap/pool_limit_hit     # Times pool was full
```

## Section 4: zswap Configuration

### Enabling and Tuning zswap

```bash
# Enable zswap at runtime
echo 1 > /sys/kernel/mm/zswap/enabled

# Or via kernel parameter at boot:
# Add to /etc/default/grub GRUB_CMDLINE_LINUX:
# zswap.enabled=1 zswap.compressor=zstd zswap.zpool=z3fold zswap.max_pool_percent=25

# Configure the compressor algorithm
echo zstd > /sys/kernel/mm/zswap/compressor
# Available: lz4, lz4hc, lzo, lzo-rle, zstd, deflate, 842

# Configure the zpool backend
echo z3fold > /sys/kernel/mm/zswap/zpool
# Available: zbud, z3fold, zsmalloc

# Set maximum pool size (% of total RAM)
# 25% is a good default: if pool is larger, the compression benefit diminishes
echo 25 > /sys/kernel/mm/zswap/max_pool_percent

# Enable same-filled page deduplication
# Pages filled with zeros (common in Java heaps) are stored without compression
echo 1 > /sys/kernel/mm/zswap/same_filled_pages_enabled
```

### Persistent zswap Configuration

```bash
# /etc/default/grub - add to GRUB_CMDLINE_LINUX
# Modern approach: kernel boot parameters

cat >> /etc/default/grub << 'EOF'
# zswap configuration - append to existing GRUB_CMDLINE_LINUX
GRUB_CMDLINE_LINUX_EXTRA="zswap.enabled=1 zswap.compressor=zstd zswap.zpool=z3fold zswap.max_pool_percent=25"
EOF

# Update grub
sudo update-grub

# Alternative: sysfs-based persistent configuration via systemd-tmpfiles
cat > /etc/tmpfiles.d/zswap.conf << 'EOF'
# zswap runtime configuration applied at boot
w /sys/module/zswap/parameters/enabled       - - - - 1
w /sys/module/zswap/parameters/compressor    - - - - zstd
w /sys/module/zswap/parameters/zpool        - - - - z3fold
w /sys/module/zswap/parameters/max_pool_percent - - - - 25
w /sys/kernel/mm/zswap/same_filled_pages_enabled - - - - 1
EOF

# Apply now
sudo systemd-tmpfiles --create /etc/tmpfiles.d/zswap.conf
```

## Section 5: Compression Algorithm Selection

The choice of compression algorithm involves three competing factors: compression ratio, CPU overhead, and decompression speed.

```bash
# Benchmark compression algorithms using zswap-relevant page sizes (4KB pages)
# Using lzbench for comparison:
apt-get install -y lzbench

# Generate test data representative of typical heap pages
dd if=/dev/urandom bs=4K count=1000 of=/tmp/random_pages.bin
dd if=/dev/zero bs=4K count=1000 of=/tmp/zero_pages.bin
# Mix (realistic heap: 30% random data, 70% structured data)
cat /tmp/random_pages.bin /tmp/zero_pages.bin > /tmp/mixed_pages.bin

# Run benchmarks
lzbench -t5 -o4 lz4,lz4hc,lzo,zstd,lzma /tmp/mixed_pages.bin

# Typical results for 4K mixed heap pages (2029 hardware):
# Algorithm    Compr. Speed    Decompr. Speed   Ratio
# lz4          3,200 MB/s      9,500 MB/s       2.1:1
# lz4hc        450 MB/s        9,200 MB/s       2.6:1
# lzo          1,800 MB/s      2,100 MB/s       2.0:1
# zstd-1       2,100 MB/s      5,800 MB/s       2.8:1
# zstd-3       900 MB/s        5,500 MB/s       3.2:1
```

### Algorithm Recommendations by Workload

**lz4**: Best for latency-sensitive workloads (real-time, low-latency APIs). The 3x+ faster decompression vs. zstd means page faults resolve faster. Accept the lower compression ratio to keep CPU overhead minimal.

**zstd**: Best for memory-constrained environments (cloud instances with limited RAM, Kubernetes nodes trying to maximize pod density). The better compression ratio means more pages fit in the pool before writeback to the swap device.

**lzo**: Legacy option. lz4 is faster with similar ratio; use lz4 for new deployments.

```bash
# Check if zstd module is available
modprobe zstd
lsmod | grep zstd

# For latency-sensitive workloads: use lz4
echo lz4 > /sys/kernel/mm/zswap/compressor

# For memory-constrained workloads: use zstd level 1
# (kernel uses the compressor's default level; zstd defaults to level 1 in kernel context)
echo zstd > /sys/kernel/mm/zswap/compressor
```

## Section 6: zswap Metrics and Monitoring

### Key Metrics

```bash
# Real-time zswap monitoring script
#!/bin/bash
while true; do
    STORED=$(cat /sys/kernel/mm/zswap/stored_pages)
    POOL_SIZE=$(cat /sys/kernel/mm/zswap/pool_total_size)
    WRITTEN_BACK=$(cat /sys/kernel/mm/zswap/written_back_pages)
    POOL_LIMIT_HIT=$(cat /sys/kernel/mm/zswap/pool_limit_hit)
    SAME_FILLED=$(cat /sys/kernel/mm/zswap/same_filled_pages_enabled)

    # Calculate compression ratio (stored_pages * 4K / pool_total_size)
    if [ "$POOL_SIZE" -gt 0 ]; then
        UNCOMPRESSED_SIZE=$(echo "$STORED * 4096" | bc)
        RATIO=$(echo "scale=2; $UNCOMPRESSED_SIZE / $POOL_SIZE" | bc)
    else
        RATIO="N/A"
    fi

    printf "Stored pages: %d | Pool size: %d MiB | Compression ratio: %s:1 | Written back: %d | Pool limit hit: %d\n" \
        "$STORED" \
        "$((POOL_SIZE / 1024 / 1024))" \
        "$RATIO" \
        "$WRITTEN_BACK" \
        "$POOL_LIMIT_HIT"
    sleep 2
done
```

### Prometheus Node Exporter Integration

```yaml
# node-exporter already exposes zswap metrics via textfile collector
# Create a zswap metrics scraper:

# /etc/node-exporter/textfile-collector/zswap.sh
#!/bin/bash
# Run as a cron job or systemd timer, output to textfile collector directory

STORED=$(cat /sys/kernel/mm/zswap/stored_pages 2>/dev/null || echo 0)
POOL_SIZE=$(cat /sys/kernel/mm/zswap/pool_total_size 2>/dev/null || echo 0)
WRITTEN_BACK=$(cat /sys/kernel/mm/zswap/written_back_pages 2>/dev/null || echo 0)
POOL_LIMIT=$(cat /sys/kernel/mm/zswap/pool_limit_hit 2>/dev/null || echo 0)
SAME_FILLED=$(cat /sys/kernel/mm/zswap/same_filled_pages 2>/dev/null || echo 0)

cat << EOF
# HELP node_zswap_stored_pages Number of pages currently stored in zswap pool
# TYPE node_zswap_stored_pages gauge
node_zswap_stored_pages $STORED

# HELP node_zswap_pool_total_bytes Total bytes used by zswap pool
# TYPE node_zswap_pool_total_bytes gauge
node_zswap_pool_total_bytes $POOL_SIZE

# HELP node_zswap_written_back_pages_total Pages written back to swap device
# TYPE node_zswap_written_back_pages_total counter
node_zswap_written_back_pages_total $WRITTEN_BACK

# HELP node_zswap_pool_limit_hit_total Times pool limit was reached
# TYPE node_zswap_pool_limit_hit_total counter
node_zswap_pool_limit_hit_total $POOL_LIMIT

# HELP node_zswap_same_filled_pages Number of same-value filled pages
# TYPE node_zswap_same_filled_pages gauge
node_zswap_same_filled_pages $SAME_FILLED
EOF
```

```yaml
# Prometheus alerting rules for zswap
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: zswap-alerts
  namespace: monitoring
spec:
  groups:
    - name: memory.zswap
      rules:
        - alert: ZswapHighWriteback
          expr: |
            rate(node_zswap_written_back_pages_total[5m]) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High zswap writeback on {{ $labels.instance }}"
            description: "{{ $value | humanize }} pages/sec being written to swap device. Consider increasing max_pool_percent or adding RAM."

        - alert: ZswapPoolLimitFrequent
          expr: |
            rate(node_zswap_pool_limit_hit_total[5m]) > 10
          for: 5m
          labels:
            severity: info
          annotations:
            summary: "zswap pool limit frequently hit on {{ $labels.instance }}"
            description: "zswap pool is filling up frequently. Increase max_pool_percent from current value."

        - alert: LowCompressionRatio
          expr: |
            (node_zswap_stored_pages * 4096) / node_zswap_pool_total_bytes < 1.5
          for: 10m
          labels:
            severity: info
          annotations:
            summary: "Low zswap compression ratio on {{ $labels.instance }}"
            description: "Compression ratio below 1.5:1. Data may not be compressible (encrypted, already compressed). Consider disabling zswap."
```

## Section 7: Kubernetes Memory Management with zswap

### Node Configuration for Kubernetes

```bash
# Enable zswap on Kubernetes nodes
# Apply via DaemonSet for automated node configuration

# Step 1: Enable swap (Kubernetes now supports swap since v1.28 for cgroup v2)
# Create swap file
fallocate -l 32G /mnt/fast-nvme/swapfile
chmod 600 /mnt/fast-nvme/swapfile
mkswap /mnt/fast-nvme/swapfile
swapon -p 10 /mnt/fast-nvme/swapfile
echo "/mnt/fast-nvme/swapfile none swap sw,pri=10 0 0" >> /etc/fstab

# Step 2: Configure zswap
echo 1 > /sys/kernel/mm/zswap/enabled
echo zstd > /sys/kernel/mm/zswap/compressor
echo z3fold > /sys/kernel/mm/zswap/zpool
echo 20 > /sys/kernel/mm/zswap/max_pool_percent

# Step 3: Configure kubelet for swap support
cat > /etc/kubernetes/kubelet-swap.yaml << 'EOF'
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
# Enable swap memory usage
memorySwap:
  swapBehavior: LimitedSwap  # Allow pods to use swap up to their memory limit
# For Guaranteed QoS pods, swap is never used
# For Burstable QoS pods, swap is limited to the difference between request and limit
# For BestEffort QoS pods, swap usage is unrestricted up to system swap capacity
EOF
```

### DaemonSet for zswap Node Tuning

```yaml
# zswap-node-tuner-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: zswap-tuner
  namespace: kube-system
  labels:
    app: zswap-tuner
spec:
  selector:
    matchLabels:
      app: zswap-tuner
  template:
    metadata:
      labels:
        app: zswap-tuner
    spec:
      hostPID: true
      tolerations:
        - operator: Exists
      priorityClassName: system-node-critical
      initContainers:
        - name: configure-zswap
          image: busybox:latest
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              #!/bin/sh
              set -eu

              echo "=== Configuring zswap ==="

              # Enable zswap
              echo 1 > /sys/kernel/mm/zswap/enabled
              echo "zswap enabled: $(cat /sys/kernel/mm/zswap/enabled)"

              # Set compression algorithm
              echo zstd > /sys/kernel/mm/zswap/compressor 2>/dev/null || \
                echo lz4 > /sys/kernel/mm/zswap/compressor
              echo "compressor: $(cat /sys/kernel/mm/zswap/compressor)"

              # Set zpool backend
              echo z3fold > /sys/kernel/mm/zswap/zpool 2>/dev/null || \
                echo zbud > /sys/kernel/mm/zswap/zpool
              echo "zpool: $(cat /sys/kernel/mm/zswap/zpool)"

              # Pool size: 20% of RAM
              echo 20 > /sys/kernel/mm/zswap/max_pool_percent
              echo "max_pool_percent: $(cat /sys/kernel/mm/zswap/max_pool_percent)"

              # Enable same-filled page optimization
              echo 1 > /sys/kernel/mm/zswap/same_filled_pages_enabled 2>/dev/null || true

              # Memory management settings for Kubernetes nodes
              sysctl -w vm.swappiness=10
              sysctl -w vm.overcommit_memory=1
              sysctl -w vm.panic_on_oom=0
              sysctl -w vm.oom_kill_allocating_task=0

              echo "=== zswap configuration complete ==="

      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            limits:
              cpu: "1m"
              memory: "4Mi"
```

### Memory Request/Limit Strategy with Swap

```yaml
# Pod configuration optimized for zswap-enabled nodes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: java-service
          image: registry.internal.corp/java-service:v2.0.0
          resources:
            requests:
              # Request only the expected steady-state working set
              memory: "1Gi"
              cpu: "500m"
            limits:
              # Limit allows burst above working set (goes to swap/zswap)
              # On zswap-enabled nodes, this overhead is handled in compressed RAM
              memory: "4Gi"
              cpu: "2"
          env:
            - name: JAVA_OPTS
              value: >-
                -Xms512m
                -Xmx3g
                -XX:+UseG1GC
                -XX:MaxGCPauseMillis=200
                -XX:+ExitOnOutOfMemoryError
```

## Section 8: Performance Benchmarking zswap

### Measuring zswap Effectiveness

```bash
#!/bin/bash
# benchmark-zswap.sh - Compare memory reclaim with/without zswap

# Step 1: Baseline - no swap, no zswap
echo 0 > /sys/kernel/mm/zswap/enabled
swapoff -a

# Create a memory pressure test using stress-ng
# Allocate 120% of available RAM to force reclamation
FREE_RAM_MB=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
TARGET_MB=$((FREE_RAM_MB * 120 / 100))

echo "Available RAM: ${FREE_RAM_MB} MiB"
echo "Target allocation: ${TARGET_MB} MiB"

# Measure baseline latency under memory pressure
/usr/bin/time -v stress-ng \
    --vm 4 \
    --vm-bytes "${TARGET_MB}M" \
    --vm-hang 0 \
    --timeout 60s \
    --metrics-brief 2>&1 | tee /tmp/baseline.txt

# Step 2: Enable zswap and repeat
echo 1 > /sys/kernel/mm/zswap/enabled
echo zstd > /sys/kernel/mm/zswap/compressor
echo 25 > /sys/kernel/mm/zswap/max_pool_percent
swapon -p 10 /mnt/fast-nvme/swapfile

# Reset counters
echo 0 > /proc/sys/vm/stat_refresh 2>/dev/null || true

/usr/bin/time -v stress-ng \
    --vm 4 \
    --vm-bytes "${TARGET_MB}M" \
    --vm-hang 0 \
    --timeout 60s \
    --metrics-brief 2>&1 | tee /tmp/zswap.txt

# Compare results
echo "=== COMPARISON ==="
echo "--- Baseline (no swap/zswap) ---"
grep "Maximum resident" /tmp/baseline.txt
grep "Elapsed" /tmp/baseline.txt

echo "--- With zswap ---"
grep "Maximum resident" /tmp/zswap.txt
grep "Elapsed" /tmp/zswap.txt

echo "--- zswap statistics ---"
echo "Stored pages: $(cat /sys/kernel/mm/zswap/stored_pages)"
echo "Pool size: $(( $(cat /sys/kernel/mm/zswap/pool_total_size) / 1024 / 1024 )) MiB"
echo "Written back: $(cat /sys/kernel/mm/zswap/written_back_pages) pages"
echo "Pool limit hit: $(cat /sys/kernel/mm/zswap/pool_limit_hit)"

# Calculate compression ratio
STORED=$(cat /sys/kernel/mm/zswap/stored_pages)
POOL_SIZE=$(cat /sys/kernel/mm/zswap/pool_total_size)
if [ "$POOL_SIZE" -gt 0 ]; then
    UNCOMPRESSED=$((STORED * 4096))
    echo "Compression ratio: $(echo "scale=2; $UNCOMPRESSED / $POOL_SIZE" | bc):1"
fi
```

## Section 9: zswap vs zram

zswap and zram are complementary, not competing:

**zswap** is a swap cache that intercepts pages on their way to the swap device, compressing and caching them in RAM.

**zram** is a compressed block device entirely in RAM that acts as a fast swap device.

```bash
# zram: create an in-memory compressed block device as swap
# This is useful when there is NO NVMe/SSD swap device

modprobe zram
# Create a zram device with 16 GiB capacity at compression ratio 3:1 = uses ~5.3 GiB RAM
echo lz4 > /sys/block/zram0/comp_algorithm
echo 16G > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 100 /dev/zram0  # Higher priority than NVMe swap

# Recommended setup: zram for fast swap + NVMe swap as overflow
# zram handles most reclaim in RAM; NVMe handles overflow
# zswap on top of NVMe swap (if NVMe swap is used)

# Check zram statistics
zramctl
# NAME       ALGORITHM DISKSIZE  DATA COMPR TOTAL STREAMS MOUNTPOINT
# /dev/zram0 lz4           16G    8G  3.2G  3.3G       4 [SWAP]

# Compression ratio
cat /sys/block/zram0/stat
# compr_data_size + metadata_size = actual RAM used
```

## Section 10: Production Recommendations

### Configuration Reference by Server Role

```bash
# ============================================================
# Web/API Server (latency sensitive, 64 GiB RAM)
# ============================================================
# Use zswap as safety net; these servers shouldn't normally swap
vm.swappiness = 5
# zswap settings:
echo 1 > /sys/kernel/mm/zswap/enabled
echo lz4 > /sys/kernel/mm/zswap/compressor    # Fast decompression
echo zbud > /sys/kernel/mm/zswap/zpool         # Simple, low overhead
echo 15 > /sys/kernel/mm/zswap/max_pool_percent

# ============================================================
# Java Application Server (batch/background, 128 GiB RAM)
# ============================================================
vm.swappiness = 30
echo 1 > /sys/kernel/mm/zswap/enabled
echo zstd > /sys/kernel/mm/zswap/compressor   # Better ratio for Java heap
echo z3fold > /sys/kernel/mm/zswap/zpool
echo 25 > /sys/kernel/mm/zswap/max_pool_percent

# ============================================================
# Kubernetes Worker Node (mixed workloads, 256 GiB RAM)
# ============================================================
vm.swappiness = 10
echo 1 > /sys/kernel/mm/zswap/enabled
echo zstd > /sys/kernel/mm/zswap/compressor
echo z3fold > /sys/kernel/mm/zswap/zpool
echo 20 > /sys/kernel/mm/zswap/max_pool_percent

# ============================================================
# Database Server (memory latency critical)
# ============================================================
vm.swappiness = 1
# zswap: disabled for databases that use O_DIRECT
# Database pages bypass the page cache; anonymous memory (heap, connections) is minimal
echo 0 > /sys/kernel/mm/zswap/enabled
# Provide small swap as safety net for OOM avoidance:
swapon -p 1 /dev/sdb  # Small priority swap, rarely used
```

## Conclusion

zswap transforms swap from a disk-bound emergency mechanism into an efficient in-memory compression layer. For modern servers with NVMe storage, the combination of zswap + NVMe swap provides graceful memory pressure handling: the vast majority of reclamation happens through zswap's compressed in-RAM store (microseconds), with overflow to NVMe (sub-millisecond) only for pages that genuinely haven't been accessed in a long time.

The practical impact for Kubernetes deployments is significant: nodes with zswap enabled can run at 80-90% memory utilization without triggering OOM kills, compared to the 70-75% ceiling on nodes without swap where memory pressure immediately leads to pod eviction. Combined with the `LimitedSwap` kubelet configuration, zswap gives the scheduler the flexibility to bin-pack pods more densely while maintaining predictable worst-case latency through the compression layer.

Start with `zstd` compressor and `z3fold` zpool at `max_pool_percent=20` for most workloads. Monitor the compression ratio and writeback rate via the Prometheus metrics in Section 6, and adjust the pool size upward if you see frequent pool limit hits.
