---
title: "Linux Swap and Memory Pressure Management for Kubernetes Nodes"
date: 2030-08-27T00:00:00-05:00
draft: false
tags: ["Linux", "Kubernetes", "Memory", "Swap", "OOM", "PSI", "Performance"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production swap management for Kubernetes nodes: disabling swap, swap alternatives with zswap and zram, memory pressure via PSI, kubelet eviction thresholds, and graceful OOM handling without destabilizing the node."
more_link: "yes"
url: "/linux-swap-memory-pressure-management-kubernetes-nodes/"
---

Memory pressure management on Kubernetes nodes requires understanding both the Linux kernel's memory reclaim mechanisms and the kubelet's eviction subsystem. The longstanding requirement to disable swap for Kubernetes has been revisited with swap support in beta since Kubernetes 1.28, but the operational complexity of swap in containerized environments means most production clusters still run without it. This post covers the complete memory management stack: why swap interacts poorly with container memory limits, Linux PSI for detecting memory pressure before OOM events, kubelet eviction tuning, zswap and zram as high-performance alternatives, and the operational procedures for handling node OOM events gracefully.

<!--more-->

## Why Kubernetes Historically Required Swap Disabled

The original reasoning for disabling swap on Kubernetes nodes was performance predictability. Kubernetes schedules pods based on memory requests, not limits, and makes scheduling decisions assuming a pod will consume at most its requested memory with no ability to overflow into swap. When swap is enabled:

1. A pod that exceeds its memory limit may thrash in swap rather than being OOM-killed immediately.
2. The performance of a swapping pod degrades dramatically (microsecond memory access vs millisecond disk access), causing latency spikes that are invisible to the scheduler.
3. Other pods on the same node experience indirect performance degradation from increased kernel reclaim activity.
4. The `memory.limit_in_bytes` cgroup v1 control does not include swap by default; the separate `memory.memsw.limit_in_bytes` must be set to include swap in the limit.

The kubelet's `--fail-swap-on` flag (default `true`) enforces this policy by refusing to start if swap is detected.

### Checking and Disabling Swap

```bash
# Check current swap usage
free -h
swapon --show

# Disable swap immediately
swapoff -a

# Verify swap is off
cat /proc/swaps

# Disable persistently (comment out swap entries in fstab)
sed -i 's/^.*\bswap\b.*$/#&/' /etc/fstab

# For systemd-managed swap
systemctl mask swap.target

# Verify kubelet starts successfully after swap disabled
systemctl status kubelet
journalctl -u kubelet | grep -i swap
```

### Kubernetes 1.28+ Swap Support (Beta)

Since Kubernetes 1.28, swap support for Linux nodes is in beta under the `NodeSwap` feature gate. Enable it with care:

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  NodeSwap: true
memorySwap:
  swapBehavior: LimitedSwap  # Only swap if pod has no memory limit (Burstable/BestEffort)
  # NoSwap: swap disabled for all pods (default when feature gate enabled)
  # LimitedSwap: pods can use swap proportional to memory limit
```

For production clusters, `NoSwap` with the feature gate enabled is equivalent to the traditional `--fail-swap-on` behavior and is the safe migration path.

## zswap: Compressed Swap Cache

zswap is a compressed write-back cache for swap pages. Pages evicted from working sets are compressed and stored in RAM rather than written to disk immediately. Only pages that cannot be stored in the zswap pool are written to the backing swap device.

This provides the latency characteristics of compressed in-memory storage (300–600 ns decompression) rather than disk swap (1–10 ms), making zswap a viable memory extension for bursty workloads.

### Enabling zswap

```bash
# Check if zswap is available
cat /boot/config-$(uname -r) | grep CONFIG_ZSWAP
# CONFIG_ZSWAP=y  (good)

# Enable zswap
echo 1 > /sys/module/zswap/parameters/enabled

# Set pool size (percentage of total RAM)
# Default 20%; for Kubernetes nodes with memory pressure, use 10%
echo 10 > /sys/module/zswap/parameters/max_pool_percent

# Set compression algorithm (lz4 offers best speed/ratio tradeoff)
echo lz4 > /sys/module/zswap/parameters/compressor

# Set zpool type (z3fold or zbud — z3fold has better compression ratio)
echo z3fold > /sys/module/zswap/parameters/zpool

# Make persistent via kernel parameters
cat >> /etc/default/grub <<'EOF'
GRUB_CMDLINE_LINUX="${GRUB_CMDLINE_LINUX} zswap.enabled=1 zswap.compressor=lz4 zswap.max_pool_percent=10 zswap.zpool=z3fold"
EOF
update-grub
```

### Monitoring zswap Statistics

```bash
# Check zswap activity
cat /sys/kernel/debug/zswap/pool_total_size   # bytes used by zswap pool
cat /sys/kernel/debug/zswap/stored_pages      # pages in zswap
cat /sys/kernel/debug/zswap/pool_limit_hit    # times pool size limit was hit
cat /sys/kernel/debug/zswap/written_back_pages # pages written to disk (bad)
cat /sys/kernel/debug/zswap/reject_*          # rejection counters

# Compute compression ratio
STORED=$(cat /sys/kernel/debug/zswap/stored_pages)
POOL_SIZE=$(cat /sys/kernel/debug/zswap/pool_total_size)
PAGE_SIZE=4096
UNCOMPRESSED=$((STORED * PAGE_SIZE))
if [ "$POOL_SIZE" -gt 0 ]; then
    echo "Compression ratio: $(echo "scale=2; $UNCOMPRESSED / $POOL_SIZE" | bc):1"
fi
```

### Prometheus Metrics for zswap

```bash
# Node exporter exposes zswap metrics via /proc/vmstat and debugfs
# Add to node exporter startup: --collector.zswap

# Sample metrics
cat /proc/vmstat | grep -E "^zswap"
# zswap_stored_pages 12045
# zswap_pool_total_size 45678912
# zswapout 2341    # pages written back to disk
```

## zram: Compressed RAM Disk

zram creates a block device backed by compressed RAM, usable as a swap device without any physical backing store. Unlike zswap (which is a cache in front of disk swap), zram eliminates disk entirely.

zram is commonly used on systems with no swap partition and is particularly effective for Kubernetes worker nodes where temporary page-out needs to happen but disk-based swap latency is unacceptable.

### Creating and Activating zram

```bash
# Load zram module
modprobe zram

# Create a zram device with 8GB uncompressed size
# (actual RAM usage will be much less depending on compressibility)
echo 8G > /sys/block/zram0/disksize
echo lz4 > /sys/block/zram0/comp_algorithm

# Format as swap
mkswap /dev/zram0

# Activate with high priority (prefer zram over disk swap)
swapon -p 100 /dev/zram0

# Verify
swapon --show
# NAME       TYPE SIZE USED PRIO
# /dev/zram0 partition   8G   0B  100
```

### systemd Service for Persistent zram Swap

```ini
# /etc/systemd/system/zram-setup.service
[Unit]
Description=Configure zram swap device
DefaultDependencies=no
After=local-fs.target
Before=swap.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/zram-setup.sh
ExecStop=/bin/bash -c 'swapoff /dev/zram0; rmmod zram'

[Install]
WantedBy=multi-user.target
```

```bash
#!/bin/bash
# /usr/local/bin/zram-setup.sh

set -euo pipefail

ZRAM_SIZE="8G"
ZRAM_COMPRESSION="lz4"

# Load module
modprobe zram

# Wait for device
sleep 0.5

# Configure
echo "$ZRAM_COMPRESSION" > /sys/block/zram0/comp_algorithm
echo "$ZRAM_SIZE" > /sys/block/zram0/disksize

# Set up swap
mkswap /dev/zram0
swapon -p 100 /dev/zram0

echo "zram swap configured: ${ZRAM_SIZE} compressed pool"
swapon --show
```

### zram on Kubernetes Nodes: Considerations

zram swap can be used alongside `--fail-swap-on=false` on nodes designated for burstable workloads:

```yaml
# kubelet-config.yaml for nodes with zram
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
failSwapOn: false  # Allow zram swap
memorySwap:
  swapBehavior: NoSwap  # Don't allow pods to swap
# With NoSwap, zram is only used by kernel reclaim (not pod memory)
# Burstable pod memory that exceeds requests goes to reclaim/OOM, not swap
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
```

## Linux PSI (Pressure Stall Information)

PSI provides quantitative measurement of memory (and CPU, I/O) pressure as the fraction of time tasks spent stalled waiting for resources. Unlike free memory statistics, PSI measures actual impact on workload performance.

### Understanding PSI Metrics

PSI exposes three metrics per resource, each measured over 10s, 60s, and 300s windows:

```bash
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.08 total=1234567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=45678

# "some": fraction of time at least one task was stalled
# "full": fraction of time ALL runnable tasks were stalled (indicates severe pressure)

# Interpret:
# avg60=0.12 means 12% of the last 60 seconds, some task was waiting for memory
# avg60 > 5.0 indicates significant pressure
# avg60 > 20.0 indicates severe pressure requiring intervention
```

### PSI-Based Memory Pressure Detection Script

```bash
#!/bin/bash
# psi-monitor.sh - Alert on sustained memory pressure

THRESHOLD_SOME=10.0  # Alert if "some" pressure > 10% over 60s
THRESHOLD_FULL=1.0   # Alert if "full" pressure > 1% over 60s
CHECK_INTERVAL=30

while true; do
    # Read current PSI values
    PSI_LINE=$(cat /proc/pressure/memory)
    SOME_60=$(echo "$PSI_LINE" | grep -oP 'some avg60=\K[0-9.]+')
    FULL_60=$(echo "$PSI_LINE" | grep -oP 'full avg60=\K[0-9.]+')

    # Check thresholds
    if (( $(echo "$SOME_60 > $THRESHOLD_SOME" | bc -l) )); then
        echo "WARNING: Memory pressure SOME avg60=${SOME_60}% (threshold ${THRESHOLD_SOME}%)"
        # Collect diagnostics
        free -h
        ps aux --sort=-%mem | head -10
    fi

    if (( $(echo "$FULL_60 > $THRESHOLD_FULL" | bc -l) )); then
        echo "CRITICAL: Memory pressure FULL avg60=${FULL_60}% (threshold ${THRESHOLD_FULL}%)"
        # Trigger pre-emptive eviction or alert
    fi

    sleep "$CHECK_INTERVAL"
done
```

### PSI Prometheus Exporter

The node exporter exposes PSI metrics:

```promql
# Memory stall fraction (10-second window)
node_pressure_memory_stalled_seconds_total

# Alert when 60s average memory pressure exceeds 10%
ALERT MemoryPressureHigh
  IF rate(node_pressure_memory_stalled_seconds_total{type="some"}[5m]) * 100 > 10
  FOR 5m
  LABELS { severity = "warning" }
  ANNOTATIONS {
    summary = "High memory pressure on {{ $labels.instance }}"
    description = "Memory pressure (some) at {{ $value | humanize }}% over 5 minutes"
  }

ALERT MemoryPressureCritical
  IF rate(node_pressure_memory_stalled_seconds_total{type="full"}[5m]) * 100 > 1
  FOR 2m
  LABELS { severity = "critical" }
  ANNOTATIONS {
    summary = "Critical memory pressure on {{ $labels.instance }}"
    description = "All processes stalled for memory {{ $value | humanize }}% of time"
  }
```

## Kubelet Memory Eviction

The kubelet monitors node-level resource usage and evicts pods when resources drop below configurable thresholds.

### Hard vs Soft Eviction Thresholds

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Hard eviction: immediate pod eviction when threshold crossed
evictionHard:
  memory.available: "200Mi"      # Evict when < 200Mi available
  nodefs.available: "5%"
  imagefs.available: "10%"
  nodefs.inodesFree: "5%"

# Soft eviction: evict pods after grace period
evictionSoft:
  memory.available: "500Mi"      # Begin soft eviction at 500Mi
  nodefs.available: "10%"
evictionSoftGracePeriod:
  memory.available: "2m"         # Give pods 2 minutes to clean up
  nodefs.available: "5m"

# Minimum reclaim: ensure eviction frees enough memory to be worthwhile
evictionMinimumReclaim:
  memory.available: "100Mi"

# Pressure signal grace period before acting on PSI
evictionPressureTransitionPeriod: "5m"
```

### Understanding Eviction Ordering

The kubelet evicts pods based on QoS class:

1. **BestEffort** pods (no requests or limits) are evicted first.
2. **Burstable** pods (requests < limits, or only limits set) are evicted when actual usage exceeds requests.
3. **Guaranteed** pods (requests == limits for all containers) are evicted last, only under hard eviction.

Within each QoS class, the kubelet evicts the pod using the most memory above its request first.

```bash
# Check current eviction events on the node
kubectl describe node <node-name> | grep -A10 "Conditions"

# Check kubelet eviction logs
journalctl -u kubelet | grep -E "(evict|Evict|pressure|Pressure)" | tail -30

# Check pod eviction events
kubectl get events --field-selector reason=Evicted -A
```

### Configuring Guaranteed QoS for Critical Services

```yaml
# Guaranteed QoS: requests == limits for all containers
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-api
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/api:latest
          resources:
            requests:
              memory: "2Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"  # Equal to requests = Guaranteed QoS
              cpu: "500m"
```

### Node Allocatable Calculation

Understanding how kubelet reserves memory for system processes:

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Reserve memory for kubelet and system processes
# Node capacity: 64Gi
# System reserved: 512Mi (kernel, systemd, sshd)
# Kube reserved: 1Gi (kubelet, container runtime)
# Hard eviction threshold: 200Mi
# Allocatable to pods: 64Gi - 512Mi - 1Gi - 200Mi = 62.3Gi

kubeReserved:
  memory: "1Gi"
  cpu: "200m"
  ephemeral-storage: "2Gi"

systemReserved:
  memory: "512Mi"
  cpu: "100m"
  ephemeral-storage: "2Gi"

enforceNodeAllocatable:
  - pods
  - kube-reserved
  - system-reserved
```

Verify allocatable resources:

```bash
kubectl describe node <node-name> | grep -A10 "Allocatable"
# Allocatable:
#   cpu:                15800m
#   ephemeral-storage:  450Gi
#   hugepages-1Gi:      0
#   hugepages-2Mi:      0
#   memory:             62Gi
#   pods:               110
```

## OOM Kill Handling

When memory pressure escalates beyond eviction capability, the Linux kernel OOM killer terminates processes. Understanding and configuring OOM behavior prevents it from destabilizing the node.

### OOM Score Configuration

The kernel uses `oom_score_adj` (-1000 to 1000) to determine which process to kill under OOM. Container runtimes set these values automatically:

```bash
# Check OOM scores of running processes
cat /proc/$(pgrep -o kubelet)/oom_score_adj  # Should be -999 (protected)
cat /proc/$(pgrep -o containerd)/oom_score_adj  # Should be -999 (protected)

# Check OOM score of a container process
# Find the container's init process
CONTAINER_ID=$(kubectl get pod api-server-xyz -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's/containerd:\/\///')
CONTAINER_PID=$(crictl inspect $CONTAINER_ID | jq -r '.info.pid')
cat /proc/$CONTAINER_PID/oom_score_adj
# BestEffort containers: 1000 (highest kill priority)
# Burstable containers: varies 1-999
# Guaranteed containers: -997 (low kill priority)
```

### Detecting OOM Events

```bash
# Check kernel OOM logs
dmesg | grep -i "oom\|killed"
journalctl -k | grep -i "oom\|out of memory"

# Recent OOM events in structured format
journalctl -k -o json | jq 'select(.MESSAGE | test("oom|killed process")) | {
  time: .REALTIME_TIMESTAMP,
  message: .MESSAGE
}' | head -20

# Kubernetes OOM event
kubectl get events -A --field-selector reason=OOMKilling
```

### Preventing Node Destabilization During OOM Events

When the OOM killer fires, the node can become unstable if it kills critical system or Kubernetes processes. Several configurations protect against this:

```bash
# Protect the container runtime from OOM kill
echo -999 > /proc/$(pgrep -o containerd)/oom_score_adj
echo -999 > /proc/$(pgrep -o dockerd)/oom_score_adj

# Protect kubelet
echo -999 > /proc/$(pgrep -o kubelet)/oom_score_adj

# These are set by systemd service configurations:
cat > /etc/systemd/system/kubelet.service.d/oom.conf <<'EOF'
[Service]
OOMScoreAdjust=-999
EOF

cat > /etc/systemd/system/containerd.service.d/oom.conf <<'EOF'
[Service]
OOMScoreAdjust=-999
EOF

systemctl daemon-reload
systemctl restart kubelet containerd
```

### cgroup Memory Limits to Prevent Node OOM

Configuring cgroup memory limits for the Kubernetes pods cgroup slice ensures pods cannot consume memory beyond the node allocatable, forcing the kubelet's eviction to fire before the kernel OOM killer:

```yaml
# kubelet-config.yaml - enforce cgroup limits
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
cgroupsPerQOS: true
enforceNodeAllocatable:
  - pods
  - kube-reserved
  - system-reserved
```

With `cgroupsPerQOS: true`, the kubelet creates cgroup hierarchy:

```
/sys/fs/cgroup/memory/
├── kubepods/          ← limit = node allocatable
│   ├── besteffort/    ← unlimited within kubepods
│   ├── burstable/     ← unlimited within kubepods
│   └── guaranteed/    ← unlimited within kubepods
├── kube-reserved/     ← limit = kubeReserved.memory
└── system-reserved/   ← limit = systemReserved.memory
```

The `/sys/fs/cgroup/memory/kubepods/memory.limit_in_bytes` value equals the node's allocatable memory, ensuring the kernel OOM killer fires within the pods cgroup before affecting the host system.

## Memory Reclaim Tuning

### vm.swappiness Configuration

`vm.swappiness` controls the kernel's tendency to reclaim anonymous memory (application heap) vs page cache (filesystem buffers):

```bash
# Check current value
cat /proc/sys/vm/swappiness  # Default: 60

# Kubernetes recommendation: 0-10 to minimize swap usage
# Note: 0 means "avoid swap as much as possible", not "never swap"
# (setting to 0 on older kernels could cause OOM when free RAM is low but page cache is full)

# Recommended for Kubernetes nodes without swap
echo 0 > /proc/sys/vm/swappiness

# For nodes with zram
echo 10 > /proc/sys/vm/swappiness

# Persist
echo "vm.swappiness = 0" >> /etc/sysctl.d/99-kubernetes.conf
sysctl --system
```

### vm.overcommit_memory Configuration

```bash
# Default (0): heuristic overcommit
# 1: always overcommit (dangerous for production)
# 2: never overcommit beyond overcommit_ratio

# Kubernetes recommendation: default (0) or conservative (2)
# For nodes running Java workloads that pre-allocate large heaps:
echo 1 > /proc/sys/vm/overcommit_memory  # Not recommended for general use

# Check overcommit behavior
cat /proc/sys/vm/overcommit_memory
cat /proc/sys/vm/overcommit_ratio   # percentage of RAM for overcommit limit
cat /proc/meminfo | grep Committed   # current committed memory
```

### vm.vfs_cache_pressure

Controls how aggressively the kernel reclaims inode and dentry cache:

```bash
# Default: 100 (balanced)
# Higher: more aggressive cache reclaim (reduces cache hit rate)
# Lower: keeps more cache in memory at cost of harder memory pressure

# For database nodes: reduce slightly to keep page cache available
echo 50 > /proc/sys/vm/vfs_cache_pressure
echo "vm.vfs_cache_pressure = 50" >> /etc/sysctl.d/99-kubernetes.conf
```

## Node Memory Monitoring Dashboard

```yaml
# Prometheus recording rules for node memory
groups:
  - name: node_memory
    interval: 30s
    rules:
      - record: node:memory_utilization:ratio
        expr: |
          1 - (
            node_memory_MemAvailable_bytes /
            node_memory_MemTotal_bytes
          )

      - record: node:memory_pressure:psi_some_60s
        expr: |
          rate(node_pressure_memory_stalled_seconds_total{type="some"}[60s]) * 100

      - record: node:memory_pressure:psi_full_60s
        expr: |
          rate(node_pressure_memory_stalled_seconds_total{type="full"}[60s]) * 100

  - name: node_memory_alerts
    rules:
      - alert: NodeMemoryPressure
        expr: node:memory_pressure:psi_some_60s > 5
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Memory pressure on {{ $labels.instance }}"
          description: "PSI memory-some at {{ $value | printf \"%.1f\" }}%"

      - alert: NodeMemoryLow
        expr: node:memory_utilization:ratio > 0.90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node memory over 90% on {{ $labels.instance }}"

      - alert: NodeOOMKillDetected
        expr: increase(node_vmstat_oom_kill[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "OOM kill detected on {{ $labels.instance }}"
```

## Kubernetes Node Problem Detector for Memory Issues

```yaml
# node-problem-detector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-config
  namespace: kube-system
data:
  kernel-monitor.json: |
    {
      "plugin": "kmsg",
      "logPath": "/dev/kmsg",
      "lookback": "5m",
      "bufferSize": 10,
      "source": "kernel-monitor",
      "conditions": [
        {
          "type": "MemoryPressure",
          "reason": "KernelOOMKilling",
          "message": "Memory pressure is high. OOM kill detected."
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "MemoryPressure",
          "reason": "KernelOOMKilling",
          "pattern": "oom_kill_process|Out of memory: Kill process"
        }
      ]
    }
```

## Tuned Profile for Kubernetes Nodes

Create a comprehensive tuned profile combining all memory settings:

```ini
# /etc/tuned/kubernetes-node/tuned.conf
[main]
summary=Kubernetes worker node memory optimization

[cpu]
governor=performance

[vm]
transparent_hugepages=madvise

[sysctl]
vm.swappiness = 0
vm.overcommit_memory = 0
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.min_free_kbytes = 524288
kernel.pid_max = 4194304
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
```

```bash
# Apply the profile
tuned-adm profile kubernetes-node

# Verify active profile
tuned-adm active
```

## Summary

Memory management on Kubernetes nodes requires a defense-in-depth approach. At the bottom layer, configure `vm.swappiness=0`, disable traditional disk swap, and tune `vm.min_free_kbytes` to maintain a kernel memory reserve. For nodes that need memory elasticity, zram provides compressed in-memory swap with latency characteristics acceptable for container workloads. At the kubelet layer, set `kubeReserved` and `systemReserved` to protect node processes, configure soft eviction thresholds that trigger before hard limits, and use `evictionMinimumReclaim` to ensure eviction makes meaningful progress. Monitor PSI pressure metrics to detect sustained memory stalls before they escalate to OOM events, and ensure the container runtime and kubelet are protected with OOM score adjustments so a container OOM event does not destabilize the entire node.
