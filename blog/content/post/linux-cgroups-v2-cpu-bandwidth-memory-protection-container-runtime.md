---
title: "Linux Cgroups v2: CPU Bandwidth Controller, Memory Protection, and Container Runtime Implications"
date: 2032-04-07T00:00:00-05:00
draft: false
tags: ["Linux", "Cgroups", "cgroups v2", "Containers", "CPU", "Memory", "Kubernetes", "Container Runtime", "Performance"]
categories:
- Linux
- Containers
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep technical guide to Linux cgroups v2 architecture, CPU bandwidth controller, memory protection mechanisms, and their direct implications for container runtimes like containerd and Kubernetes resource management."
more_link: "yes"
url: "/linux-cgroups-v2-cpu-bandwidth-memory-protection-container-runtime/"
---

Linux cgroups version 2 (cgroupv2) represents a fundamental redesign of the control groups subsystem, unifying the fragmented cgroupv1 hierarchy into a single, coherent tree with vastly improved semantics. The CPU bandwidth controller replaces the complex interaction between cpu.shares and cpu.cfs_quota_us with explicit bandwidth allocation, while the memory controller gains protection mechanisms that prevent aggressive page reclaim from impacting well-behaved processes.

For platform engineers operating Kubernetes clusters, cgroups v2 is no longer optional. Kubernetes 1.25+ defaults to cgroupv2, containerd 1.6+ supports it natively, and features like MemoryQoS and proper CPU burstable behavior depend on cgroupv2 semantics. This guide covers the technical internals of cgroupv2's CPU and memory controllers, their direct mapping to Kubernetes resource models, and the operational knowledge needed to debug resource contention in modern container environments.

<!--more-->

## CGgroups V2 Architecture

### From V1 to V2: Key Differences

```
cgroups v1 (legacy):
  /sys/fs/cgroup/
  ├── cpu/               (cpu.shares, cpu.cfs_quota_us, cpu.cfs_period_us)
  ├── memory/            (memory.limit_in_bytes, memory.soft_limit_in_bytes)
  ├── blkio/             (blkio.weight, blkio.throttle.*)
  ├── pids/              (pids.max)
  ├── cpuset/            (cpuset.cpus, cpuset.mems)
  └── devices/           (devices.allow/deny)

  Problems:
  - Each resource has a separate hierarchy (different parent/child relationships)
  - Inconsistent semantics across subsystems
  - "Threaded" processes hard to manage (a process can be in only one cgroup per subsystem)
  - No composition guarantees

cgroups v2 (unified):
  /sys/fs/cgroup/
  ├── cgroup.controllers   (available: cpu memory io pids)
  ├── cgroup.procs         (processes in this cgroup)
  ├── cpu.weight           (relative scheduling weight, replaces cpu.shares)
  ├── cpu.max              (absolute bandwidth limit)
  ├── cpu.pressure         (PSI - pressure stall information)
  ├── memory.max           (hard memory limit)
  ├── memory.high          (soft memory limit with throttling)
  ├── memory.min           (absolute memory protection)
  ├── memory.low           (best-effort memory protection)
  ├── memory.pressure      (PSI for memory)
  └── io.max               (block I/O limits)

  All resources in a single tree - consistent hierarchy
```

### Kernel Configuration Check

```bash
# Verify cgroupv2 is active
stat -fc %T /sys/fs/cgroup/
# If output is: cgroup2fs → cgroupv2 is mounted
# If output is: tmpfs → cgroupv1 (the cgroup directory is a tmpfs mount)

# Check mount
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Check kernel version (cgroupv2 stable since 4.15, full controllers in 5.2+)
uname -r

# Check available controllers
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Check which controllers are delegated to child cgroups
cat /sys/fs/cgroup/cgroup.subtree_control
# cpuset cpu io memory pids
```

### Migration from V1 to V2

```bash
# Check if systemd is using cgroupv2
systemctl status | head -5
# Look for: "CGroup: 2" or check unified_cgroup_hierarchy

# Enable cgroupv2 via kernel boot parameter
# Edit /etc/default/grub:
GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
# Or on kernel 5.12+:
GRUB_CMDLINE_LINUX="cgroup_no_v1=all"

# Update grub
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot

# For container runtimes: verify cgroupv2 support
containerd --version
# containerd v1.7.x (cgroupv2 supported by default)

# Configure containerd for cgroupv2
cat /etc/containerd/config.toml | grep -A5 "cgroup_driver\|SystemdCgroup"
```

## CPU Controller V2 Deep Dive

### CPU Weight (Replaces cpu.shares)

```bash
# cgroupv1: cpu.shares (100-262144, default 1024)
# cgroupv2: cpu.weight (1-10000, default 100)

# Translation: weight = shares * 10000 / 1024

# View current weight
cat /sys/fs/cgroup/system.slice/myservice.service/cpu.weight
# 100 (default)

# Set higher priority
echo 200 > /sys/fs/cgroup/system.slice/myservice.service/cpu.weight

# Check CPU time distribution
cat /sys/fs/cgroup/system.slice/myservice.service/cpu.stat
# usage_usec 1234567890      ← total CPU time consumed (microseconds)
# user_usec 987654321        ← user space CPU time
# system_usec 246913569      ← kernel space CPU time
# nr_periods 12345           ← number of scheduling periods
# nr_throttled 234           ← times throttled
# throttled_usec 23456789    ← total time spent throttled
# nr_bursts 0                ← bursting periods used
# burst_usec 0               ← time spent in burst mode
```

### CPU Bandwidth Controller (cpu.max)

The CPU bandwidth controller provides hard CPU limits using the period/quota model, but with cleaner semantics than cgroupv1.

```bash
# cpu.max format: "$MAX $PERIOD"
# $MAX: microseconds of CPU time allowed per $PERIOD
# $PERIOD: scheduling period in microseconds (default 100ms = 100000)
# "max": unlimited (no quota)

# View current limit
cat /sys/fs/cgroup/system.slice/mycontainer.service/cpu.max
# 200000 100000
# This means: 200ms CPU time per 100ms period = 2 CPU cores maximum

# Set limit to 0.5 CPUs (50ms per 100ms period)
echo "50000 100000" > /sys/fs/cgroup/system.slice/mycontainer.service/cpu.max

# Set to 1.5 CPUs
echo "150000 100000" > /sys/fs/cgroup/system.slice/mycontainer.service/cpu.max

# Remove limit
echo "max 100000" > /sys/fs/cgroup/system.slice/mycontainer.service/cpu.max

# Kubernetes mapping:
# resources.limits.cpu: "500m" → cpu.max = "50000 100000"
# resources.limits.cpu: "2" → cpu.max = "200000 100000"
# No limits.cpu → cpu.max = "max 100000"
```

### CPU Burst Mode

cgroupv2 adds CPU burst mode, allowing containers to exceed their quota temporarily by accumulating unused bandwidth:

```bash
# cpu.max.burst: maximum accumulated burst credit in microseconds
# Default: 0 (no burst)

# Allow up to 100ms of burst accumulation for a container with 0.5 CPU limit
echo "50000 100000" > cpu.max      # 0.5 CPU quota
echo "100000" > cpu.max.burst      # 100ms burst allowed

# This means the container can use up to 1.5x its quota briefly
# if it has been idle and accumulated burst credit

# Check burst usage
cat cpu.stat | grep burst
# nr_bursts 45
# burst_usec 1234567

# In Kubernetes (alpha feature - requires feature gate):
# containerName:
#   resources:
#     limits:
#       cpu: "500m"
#     # No native Kubernetes burst yet, but containerd supports it via annotations
```

### CPU Pressure Stall Information (PSI)

PSI provides quantitative measurement of CPU resource pressure — the percentage of time work is stalled waiting for CPU:

```bash
# Read CPU PSI
cat /sys/fs/cgroup/system.slice/myservice.service/cpu.pressure
# some avg10=2.34 avg60=1.89 avg300=1.45 total=12345678
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# Interpretation:
# "some": fraction of time at least one task was waiting (lost productivity)
# "full": fraction of time ALL tasks were stalled (complete CPU starvation)
# avg10/60/300: exponential moving averages over 10s/60s/300s windows
# total: total stall time in microseconds since cgroup creation

# A PSI "some" of 2.34% means 2.34% of the observation window had at least
# one task unable to make progress due to CPU contention

# Set up a PSI-based trigger for monitoring
# Create a pipe file and write threshold to cpu.pressure
MONITOR_FILE=$(mktemp)
# Trigger when avg10 > 5% for 1 second window
echo "some 500000 1000000" > /sys/fs/cgroup/system.slice/myservice.service/cpu.pressure
# Note: PSI monitoring via cgroup requires Linux 5.2+
```

### CPU Set Controller

```bash
# cpuset.cpus: restrict to specific CPU cores
cat /sys/fs/cgroup/system.slice/myservice.service/cpuset.cpus
# 0-7  (all 8 cores)

# Pin to cores 0-3 only (NUMA-aware placement)
echo "0-3" > /sys/fs/cgroup/system.slice/myservice.service/cpuset.cpus

# cpuset.mems: restrict to specific NUMA memory nodes
echo "0" > /sys/fs/cgroup/system.slice/myservice.service/cpuset.mems

# cpuset.cpus.partition: for exclusive CPU assignment (realtime workloads)
# "root": this cgroup is a partition root (exclusive CPUs)
echo "root" > /sys/fs/cgroup/system.slice/myservice.service/cpuset.cpus.partition
```

## Memory Controller V2 Deep Dive

### Memory Limits and Throttling

cgroupv2 introduces multiple memory control knobs that work together to provide granular memory management:

```bash
# memory.max: hard limit - OOM killer invoked at this point
cat /sys/fs/cgroup/system.slice/myservice.service/memory.max
# 1073741824 (1GB)

# Set memory hard limit
echo "1073741824" > /sys/fs/cgroup/system.slice/myservice.service/memory.max
# or: echo "1G" > ...  (human-readable on Linux 5.12+)

# memory.high: soft limit - process is throttled but not killed
# Kernel will aggressively reclaim memory before hitting memory.max
echo "900M" > /sys/fs/cgroup/system.slice/myservice.service/memory.high

# When memory.high is exceeded:
# 1. Kernel tries to reclaim memory (page out, drop caches)
# 2. If reclaim succeeds, no process impact
# 3. If reclaim fails, processes are throttled (slowed down)
# 4. At memory.max, OOM killer is invoked

# Kubernetes mapping:
# resources.limits.memory: "1Gi" → memory.max = 1073741824
# resources.requests.memory: "512Mi" → informational only (for scheduling)
# With MemoryQoS feature gate: memory.high = 0.9 * memory.max
```

### Memory Protection: min and low

Memory protection prevents aggressive reclaim from impacting well-behaved cgroups:

```bash
# memory.min: absolute protection — pages will NEVER be reclaimed
# Even under severe global memory pressure, this memory is kept warm
echo "256M" > /sys/fs/cgroup/system.slice/myservice.service/memory.min

# memory.low: best-effort protection — pages reclaimed only when necessary
# Under normal pressure, pages are kept; under severe pressure, they may be reclaimed
echo "512M" > /sys/fs/cgroup/system.slice/myservice.service/memory.low

# Comparison:
# memory.min: guaranteed minimum — analogous to Kubernetes Guaranteed QoS (requests == limits)
# memory.low: best-effort protection — analogous to Kubernetes Burstable QoS (requests < limits)

# Kubernetes MemoryQoS mapping (alpha, requires feature gate MemoryQoS):
# - resources.requests.memory  → memory.low  (best-effort protection)
# - resources.limits.memory    → memory.max  (hard limit)
# Kubernetes Guaranteed pods:
# - memory.min = memory.low = requests = limits

# Check current protection
cat /sys/fs/cgroup/system.slice/myservice.service/memory.min
cat /sys/fs/cgroup/system.slice/myservice.service/memory.low
```

### Memory Statistics

```bash
# Comprehensive memory stats
cat /sys/fs/cgroup/system.slice/myservice.service/memory.stat

# Key fields:
# anon: anonymous memory (heap, stack)
# file: file-backed memory (page cache, shared libraries)
# kernel_stack: kernel stack pages
# slab: kernel slab allocations
# sock: socket buffers
# shmem: shared memory
# file_mapped: memory-mapped files
# file_dirty: dirty file cache (waiting to be written)
# file_writeback: file cache being written to disk
# anon_thp: transparent huge pages for anonymous memory
# inactive_anon: LRU inactive anonymous pages
# active_anon: LRU active anonymous pages
# inactive_file: LRU inactive file pages (candidates for reclaim)
# active_file: LRU active file pages
# unevictable: pages that cannot be swapped or reclaimed
# oom_score_adj: OOM score adjustment

# Memory events
cat /sys/fs/cgroup/system.slice/myservice.service/memory.events
# low 0          ← times low threshold was crossed
# high 42        ← times high threshold was crossed (throttling events)
# max 0          ← times max threshold was crossed (OOM invocations)
# oom 0          ← OOM kills
# oom_kill 0     ← processes killed by OOM

# memory.pressure
cat /sys/fs/cgroup/system.slice/myservice.service/memory.pressure
# some avg10=0.89 avg60=0.34 avg300=0.12 total=1234567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### Swap Controller

```bash
# memory.swap.max: limit on swap usage by this cgroup
# Default: inherits from parent (typically system-wide swap)

# Disable swap for this cgroup
echo "0" > /sys/fs/cgroup/system.slice/myservice.service/memory.swap.max

# Allow 500MB of swap
echo "524288000" > /sys/fs/cgroup/system.slice/myservice.service/memory.swap.max

# Note: memory.memsw.limit_in_bytes (v1) maps to memory.max + memory.swap.max (v2)
# v1: memsw = memory + swap
# v2: memory.max = memory only; memory.swap.max = swap only (separate controls)

# Kubernetes sets memory.swap.max=0 by default to prevent swap usage
# This can be changed via kubelet --memory-swap-behavior flag
```

## Container Runtime Integration

### containerd and cgroupv2

```toml
# /etc/containerd/config.toml — cgroupv2 configuration
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          # Use systemd cgroup driver (required for cgroupv2 with Kubernetes)
          SystemdCgroup = true
```

```bash
# Verify containerd is using cgroupv2
containerd config dump | grep -A3 "SystemdCgroup"

# Check how containerd creates cgroups for containers
# Each container gets: /sys/fs/cgroup/kubepods/<QoS>/<podUID>/<containerID>/

# Pod Guaranteed QoS: /sys/fs/cgroup/kubepods/pod<uid>/<container-id>/
# Pod Burstable QoS:  /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/
# Pod BestEffort QoS: /sys/fs/cgroup/kubepods/besteffort/pod<uid>/<container-id>/

# Inspect a running container's cgroup
CONTAINER_ID=$(crictl ps | grep my-container | awk '{print $1}')
CGROUP_PATH=$(crictl inspect $CONTAINER_ID | jq -r '.info.runtimeSpec.cgroupsPath')
echo "/sys/fs/cgroup/${CGROUP_PATH}"
ls /sys/fs/cgroup/${CGROUP_PATH}/
```

### How Kubernetes Maps to cgroupv2

```bash
# Kubernetes Pod QoS classes map to cgroup hierarchy:
# - Guaranteed: requests == limits for ALL containers
# - Burstable: at least one container has requests != limits
# - BestEffort: no requests or limits specified

# For a Guaranteed pod (all containers: requests == limits):
POD_CGROUP="/sys/fs/cgroup/kubepods/pod<uid>"

# cpu.max = "200000 100000"  (2 CPUs max for 2000m limit)
# cpu.weight = 100           (default weight)
# memory.max = 2147483648    (2GB limit)
# memory.min = 2147483648    (memory.min = memory.max for Guaranteed)

# For a Burstable pod (requests != limits):
# cpu.max = quota based on limits.cpu
# cpu.weight = 2 * (requests.cpu / 1000) + 1  (proportional weight)
# memory.max = limits.memory
# memory.high = 0.9 * limits.memory (with MemoryQoS feature gate)

# For a BestEffort pod:
# cpu.max = "max 100000"    (unlimited)
# cpu.weight = 2            (minimum weight)
# memory.max = "max"        (unlimited)
```

### Inspecting Kubernetes Container cgroups

```bash
#!/bin/bash
# inspect-pod-cgroups.sh — show cgroup resource settings for a Kubernetes pod

NAMESPACE="${1:-default}"
POD_NAME="${2:?Usage: $0 <namespace> <pod-name>}"

echo "=== cgroup settings for pod: $POD_NAME ==="
echo ""

# Get pod UID
POD_UID=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.metadata.uid}')
echo "Pod UID: $POD_UID"

# Get QoS class
QOS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.qosClass}')
echo "QoS Class: $QOS"
echo ""

# Find cgroup path based on QoS
case "$QOS" in
  Guaranteed)
    CGROUP_BASE="/sys/fs/cgroup/kubepods/pod${POD_UID}"
    ;;
  Burstable)
    CGROUP_BASE="/sys/fs/cgroup/kubepods/burstable/pod${POD_UID}"
    ;;
  BestEffort)
    CGROUP_BASE="/sys/fs/cgroup/kubepods/besteffort/pod${POD_UID}"
    ;;
esac

echo "Cgroup path: $CGROUP_BASE"
echo ""

if [ -d "$CGROUP_BASE" ]; then
  echo "=== CPU Settings ==="
  echo "cpu.max: $(cat $CGROUP_BASE/cpu.max 2>/dev/null || echo 'N/A')"
  echo "cpu.weight: $(cat $CGROUP_BASE/cpu.weight 2>/dev/null || echo 'N/A')"
  echo ""
  echo "=== Memory Settings ==="
  echo "memory.max: $(cat $CGROUP_BASE/memory.max 2>/dev/null || echo 'N/A')"
  echo "memory.high: $(cat $CGROUP_BASE/memory.high 2>/dev/null || echo 'N/A')"
  echo "memory.min: $(cat $CGROUP_BASE/memory.min 2>/dev/null || echo 'N/A')"
  echo "memory.low: $(cat $CGROUP_BASE/memory.low 2>/dev/null || echo 'N/A')"
  echo ""
  echo "=== Current Usage ==="
  echo "memory.current: $(cat $CGROUP_BASE/memory.current 2>/dev/null || echo 'N/A') bytes"
  echo ""
  echo "=== Pressure (PSI) ==="
  echo "CPU PSI:"
  cat $CGROUP_BASE/cpu.pressure 2>/dev/null || echo 'N/A'
  echo "Memory PSI:"
  cat $CGROUP_BASE/memory.pressure 2>/dev/null || echo 'N/A'
else
  echo "Cgroup directory not found: $CGROUP_BASE"
  echo "Are you running this on the node where the pod is scheduled?"
fi
```

## Kubernetes MemoryQoS Feature

MemoryQoS (alpha in 1.22, beta in 1.27) uses cgroupv2's memory.high to throttle containers before they hit memory.max, preventing OOM kills for memory-hungry-but-not-runaway processes:

```yaml
# Enable MemoryQoS in kubelet configuration
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  MemoryQoS: true
memoryThrottlingFactor: 0.9  # Set memory.high to 90% of memory.max
```

```bash
# With MemoryQoS enabled, for a Burstable pod:
# limits.memory: 1Gi → memory.max = 1073741824
# requests.memory: 512Mi → memory.low = 536870912
# memory.high = 0.9 * 1073741824 = 966367641 (throttle before OOM)

# For a Guaranteed pod:
# requests == limits == 1Gi → memory.min = memory.max = memory.high = 1073741824

# Check if MemoryQoS is taking effect
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/memory.high
# 966367641 (throttle at 90% of limit)

# Monitor throttling events
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/memory.events | grep high
# high 142  ← 142 throttling events (memory exceeded memory.high)
```

## PSI-Based Workload Management

PSI (Pressure Stall Information) provides a way to programmatically detect and respond to resource pressure before it causes service degradation:

```go
// pkg/psi/monitor.go — PSI-based resource pressure monitoring
package psi

import (
    "bufio"
    "fmt"
    "os"
    "strconv"
    "strings"
    "time"
)

// PSIData holds parsed pressure stall information
type PSIData struct {
    SomeAvg10  float64
    SomeAvg60  float64
    SomeAvg300 float64
    FullAvg10  float64
    FullAvg60  float64
    FullAvg300 float64
    TotalStall time.Duration
}

// ReadCgroupPSI reads PSI data from a cgroup's pressure file
func ReadCgroupPSI(cgroupPath, resource string) (*PSIData, error) {
    path := fmt.Sprintf("%s/%s.pressure", cgroupPath, resource)
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("opening %s: %w", path, err)
    }
    defer f.Close()

    psi := &PSIData{}
    scanner := bufio.NewScanner(f)

    for scanner.Scan() {
        line := scanner.Text()
        parts := strings.Fields(line)
        if len(parts) < 5 {
            continue
        }

        level := parts[0] // "some" or "full"
        for _, kv := range parts[1:] {
            kvParts := strings.SplitN(kv, "=", 2)
            if len(kvParts) != 2 {
                continue
            }
            key, val := kvParts[0], kvParts[1]

            f64, err := strconv.ParseFloat(val, 64)
            if err != nil {
                continue
            }

            switch level + "." + key {
            case "some.avg10":
                psi.SomeAvg10 = f64
            case "some.avg60":
                psi.SomeAvg60 = f64
            case "some.avg300":
                psi.SomeAvg300 = f64
            case "full.avg10":
                psi.FullAvg10 = f64
            case "full.avg60":
                psi.FullAvg60 = f64
            case "full.avg300":
                psi.FullAvg300 = f64
            case "some.total", "full.total":
                us, _ := strconv.ParseInt(val, 10, 64)
                if level == "some" {
                    psi.TotalStall += time.Duration(us) * time.Microsecond
                }
            }
        }
    }

    return psi, scanner.Err()
}

// IsUnderPressure returns true if PSI indicates significant resource pressure
func (p *PSIData) IsUnderPressure(threshold float64) bool {
    return p.SomeAvg10 > threshold
}

// IsCritical returns true if ALL tasks are stalled (full pressure)
func (p *PSIData) IsCritical(threshold float64) bool {
    return p.FullAvg10 > threshold
}

// Example usage in a pressure-aware scheduler
func MonitorPodPressure(cgroupPath string, warningThreshold float64) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        cpuPSI, _ := ReadCgroupPSI(cgroupPath, "cpu")
        memPSI, _ := ReadCgroupPSI(cgroupPath, "memory")
        ioPSI, _ := ReadCgroupPSI(cgroupPath, "io")

        if cpuPSI != nil && cpuPSI.IsUnderPressure(warningThreshold) {
            fmt.Printf("WARNING: CPU pressure %.2f%% (avg10) - consider scaling\n",
                cpuPSI.SomeAvg10)
        }

        if memPSI != nil && memPSI.IsCritical(1.0) {
            fmt.Printf("CRITICAL: Memory full stall %.2f%% - OOM risk\n",
                memPSI.FullAvg10)
        }

        if ioPSI != nil && ioPSI.IsUnderPressure(warningThreshold) {
            fmt.Printf("WARNING: IO pressure %.2f%% - storage bottleneck\n",
                ioPSI.SomeAvg10)
        }
    }
}
```

## Debugging Resource Throttling

### CPU Throttling Analysis

```bash
#!/bin/bash
# cpu-throttle-check.sh — identify throttled containers

echo "=== CPU Throttle Analysis ==="
echo ""
echo "Checking all container cgroups for throttling..."
echo ""
printf "%-50s %10s %10s %10s\n" "CGROUP" "PERIODS" "THROTTLED" "THROTTLE%"
echo "$(printf '%0.s-' {1..80})"

find /sys/fs/cgroup/kubepods -name "cpu.stat" 2>/dev/null | while read f; do
    DIR=$(dirname "$f")
    CGROUP_NAME=$(basename "$DIR")

    # Parse cpu.stat
    NR_PERIODS=$(grep "^nr_periods" "$f" | awk '{print $2}')
    NR_THROTTLED=$(grep "^nr_throttled" "$f" | awk '{print $2}')

    if [ -n "$NR_PERIODS" ] && [ "$NR_PERIODS" -gt 100 ]; then
        THROTTLE_PCT=$(echo "scale=2; $NR_THROTTLED * 100 / $NR_PERIODS" | bc)

        # Only show if throttling > 5%
        if (( $(echo "$THROTTLE_PCT > 5" | bc -l) )); then
            printf "%-50s %10s %10s %9s%%\n" \
                "${DIR##*/sys/fs/cgroup/}" \
                "$NR_PERIODS" \
                "$NR_THROTTLED" \
                "$THROTTLE_PCT"
        fi
    fi
done
```

### Memory OOM Investigation

```bash
#!/bin/bash
# oom-investigation.sh — trace OOM events in container cgroups

# Watch for OOM events across all pod cgroups
inotifywait -mr -e modify /sys/fs/cgroup/kubepods/ \
  --include "memory.events" 2>/dev/null | \
while read DIR EVENT FILE; do
    OOM=$(cat "${DIR}/${FILE}" | grep "^oom " | awk '{print $2}')
    OOM_KILL=$(cat "${DIR}/${FILE}" | grep "^oom_kill " | awk '{print $2}')

    if [ "${OOM_KILL:-0}" -gt "0" ]; then
        CGROUP_SHORT="${DIR##*/sys/fs/cgroup/}"
        echo "$(date): OOM KILL in $CGROUP_SHORT"
        echo "  oom: $OOM oom_kill: $OOM_KILL"
        echo "  memory.current: $(cat ${DIR}/memory.current 2>/dev/null)"
        echo "  memory.max: $(cat ${DIR}/memory.max 2>/dev/null)"
        echo "  memory.stat (top):"
        head -20 "${DIR}/memory.stat" 2>/dev/null | sed 's/^/    /'
    fi
done
```

## Performance Tuning for Containers

### CPU Performance Tuning

```bash
# For latency-sensitive containers: increase cpu.weight
# Standard workload: weight=100
# High-priority API server: weight=500
# Batch job: weight=20

# Set weight for a specific pod
# (Kubernetes doesn't expose this directly - use a DaemonSet or node tuning)
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container>/cpu.weight
echo 500 > /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container>/cpu.weight

# For workloads needing consistent latency: avoid CPU throttling entirely
# Option 1: Set limits high enough that throttling never occurs
# resources.limits.cpu: "4"  (if you only use 1, you won't be throttled)

# Option 2: Disable CFS quota for the container (expert option)
# This means the container can use unlimited CPU when needed
# but won't be throttled during quota period
echo "max 100000" > /sys/fs/cgroup/kubepods/.../cpu.max
```

### Memory Tuning for Container Workloads

```bash
# For JVM containers: tune to allow memory warmup without throttling
# Set memory.high slightly below memory.max to prevent OOM with throttle warning
# JVM heap: -Xmx equals ~80% of memory.max
# memory.high = 90% of memory.max (let JVM breathe before hard limit)

# Verify effective memory configuration
POD_CGROUP="/sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>"
echo "memory.max:  $(cat $POD_CGROUP/memory.max)"
echo "memory.high: $(cat $POD_CGROUP/memory.high)"
echo "memory.min:  $(cat $POD_CGROUP/memory.min)"
echo "memory.low:  $(cat $POD_CGROUP/memory.low)"
echo "memory.swap.max: $(cat $POD_CGROUP/memory.swap.max)"
echo ""
echo "Current usage: $(cat $POD_CGROUP/memory.current) bytes"
echo ""
echo "Events (throttle/OOM count):"
cat $POD_CGROUP/memory.events
```

## Conclusion

cgroupv2 unifies the control groups subsystem into a coherent model that eliminates the semantic inconsistencies and operational complexity of the v1 hierarchy. The CPU bandwidth controller provides transparent throttling visibility through `cpu.stat`, while the layered memory controls (`min`, `low`, `high`, `max`) enable sophisticated quality-of-service policies that map directly to Kubernetes QoS classes.

For platform teams, the most impactful takeaways are: PSI metrics expose resource pressure before it becomes service degradation; CPU throttling statistics reveal misconfigured resource limits that cause latency outliers without hitting OOM; and cgroupv2's memory protection hierarchy provides the foundation for Kubernetes MemoryQoS to reduce OOM kills in multi-tenant clusters.

The transition from cgroupv1 to cgroupv2 is largely transparent for standard Kubernetes workloads, but operators who understand the underlying cgroup semantics gain powerful tools for debugging performance problems and designing resource allocation strategies that maintain service quality under load.
