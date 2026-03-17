---
title: "Linux Memory Overcommit: OOM Killer Tuning, Memory Cgroups, and Production Strategies"
date: 2030-02-18T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "OOM Killer", "Cgroups", "Kubernetes", "Performance", "System Administration"]
categories: ["Linux", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux memory overcommit modes, OOM killer tuning with oom_score_adj, cgroup v2 memory management, swap configuration in containerized environments, and strategies for preventing and recovering from OOM events."
more_link: "yes"
url: "/linux-memory-overcommit-oom-killer-tuning/"
---

Linux memory management under pressure is one of the most misunderstood aspects of production systems. Teams deploy critical workloads on systems with insufficient physical memory, relying on overcommit to avoid allocation failures, only to discover at 3am that the OOM killer has terminated the wrong process. Understanding the complete model — overcommit modes, OOM score calculation, cgroup memory limits, and swap behavior — is essential for any team running production workloads on Linux, whether bare metal or Kubernetes.

<!--more-->

## Linux Memory Overcommit: The Three Modes

Linux implements virtual memory overcommitment: applications can allocate more virtual memory than physical RAM plus swap. The kernel tracks committed virtual memory separately from physical pages, and only allocates physical pages on first access (lazy allocation via demand paging).

The overcommit behavior is controlled by `/proc/sys/vm/overcommit_memory`:

### Mode 0: Heuristic Overcommit (Default)

The kernel uses a heuristic to estimate whether the allocation can be satisfied. The heuristic is approximately:

```
Allowed = RAM + Swap + (RAM * overcommit_ratio / 100)
```

Where `overcommit_ratio` defaults to 50. For a system with 16 GB RAM and 0 swap, allowed virtual memory is approximately 24 GB. Applications requesting memory beyond this limit receive `ENOMEM`.

Mode 0 works well for most workloads but can be unpredictable: the heuristic may allow allocations that later trigger the OOM killer when pages are faulted.

### Mode 1: Always Overcommit

```bash
echo 1 > /proc/sys/vm/overcommit_memory
```

The kernel never refuses memory allocation requests (except for physically impossible sizes). Virtual memory can be allocated without limit. Physical pages are only allocated on first write access.

This mode is appropriate for:
- Applications using `mmap` for large anonymous regions that are sparsely written (e.g., some garbage collectors, scientific computing code)
- Environments where OOM is acceptable and you want to avoid `malloc` returning NULL

Mode 1 shifts the risk entirely to OOM: when physical memory is exhausted, the OOM killer runs.

### Mode 2: No Overcommit

```bash
echo 2 > /proc/sys/vm/overcommit_memory
```

The kernel strictly limits total committed virtual memory to:

```
Committed Limit = Swap + (RAM * overcommit_ratio / 100)
```

With `overcommit_ratio=50` on a 16 GB system with 8 GB swap:

```
Committed Limit = 8 GB + (16 GB * 0.50) = 16 GB
```

If the committed virtual memory exceeds this limit, `malloc` returns NULL. No OOM killer is invoked; applications handle allocation failures gracefully (or crash on null pointer dereference, which is better than silent corruption).

Mode 2 is the correct choice for latency-sensitive financial applications, databases, and any workload where OOM-triggered process termination is unacceptable.

```bash
# Check current committed memory
cat /proc/meminfo | grep -E "Committed_AS|CommitLimit"
# CommitLimit:    16384000 kB
# Committed_AS:  12204032 kB
```

### Viewing and Setting Overcommit Parameters

```bash
# Current overcommit settings
cat /proc/sys/vm/overcommit_memory
cat /proc/sys/vm/overcommit_ratio
cat /proc/sys/vm/overcommit_kbytes  # alternative to ratio, in KB

# Set via sysctl (temporary)
sysctl -w vm.overcommit_memory=2
sysctl -w vm.overcommit_ratio=80

# Persistent via /etc/sysctl.d/
cat > /etc/sysctl.d/60-memory-overcommit.conf <<'EOF'
# Production mode: no overcommit, 80% of RAM + swap
vm.overcommit_memory = 2
vm.overcommit_ratio = 80
EOF
sysctl -p /etc/sysctl.d/60-memory-overcommit.conf
```

## The OOM Killer: How It Selects Victims

When the kernel cannot satisfy a memory request because physical memory is exhausted, it invokes the OOM killer. The OOM killer selects a process to terminate based on an OOM score.

### OOM Score Calculation

The base OOM score is calculated in `mm/oom_kill.c`:

```
oom_score = (process RSS + swap usage + page_cache_dirty) / total_memory * 1000
```

This yields a score from 0 to 1000, where higher scores make the process a more likely victim. The score is then adjusted by `oom_score_adj`.

```bash
# View the OOM score of a process
cat /proc/$(pgrep postgres | head -1)/oom_score

# View the adjustment value
cat /proc/$(pgrep postgres | head -1)/oom_score_adj
```

### oom_score_adj: The Tuning Knob

`oom_score_adj` is an integer from -1000 to +1000 added to the calculated OOM score:

- **-1000**: Process is never killed by the OOM killer (completely protected)
- **-500**: Score is halved; process is relatively protected
- **0**: No adjustment (default)
- **+500**: Score is increased; process is more likely to be killed
- **+1000**: Process is killed first in any OOM situation

```bash
# Protect a critical process (e.g., the system's PID 1)
echo -1000 > /proc/1/oom_score_adj

# Protect PostgreSQL from OOM termination
PG_PID=$(pgrep -x postgres | head -1)
echo -200 > /proc/${PG_PID}/oom_score_adj

# Mark a batch job as the preferred OOM victim
BATCH_PID=$(pgrep -x batch-job)
echo 500 > /proc/${BATCH_PID}/oom_score_adj

# Apply oom_score_adj persistently via systemd unit
cat > /etc/systemd/system/postgres.service.d/oom.conf <<'EOF'
[Service]
OOMScoreAdjust=-200
EOF
systemctl daemon-reload
```

### Monitoring OOM Events

```bash
# Real-time OOM event monitoring
dmesg -wH | grep -E "oom|Out of memory|Killed process"

# Check for recent OOM kills
journalctl -k --since "1 hour ago" | grep -i "out of memory\|oom"

# Count OOM events since boot
cat /proc/vmstat | grep oom

# Install earlyoom for pre-emptive OOM management
# earlyoom kills processes before the kernel OOM killer runs,
# allowing graceful shutdown instead of SIGKILL
apt-get install earlyoom
cat > /etc/default/earlyoom <<'EOF'
EARLYOOM_ARGS="-m 5 -s 10 --avoid '^(postgres|redis-server|vault)$' --prefer '^(batch|worker)$' --notify"
EOF
systemctl enable --now earlyoom
```

### Scripted OOM Score Management

```bash
#!/bin/bash
# scripts/set-oom-scores.sh
# Apply oom_score_adj settings to critical processes at boot

set -euo pipefail

# Protection levels
NEVER_KILL=-1000
PROTECTED=-500
NORMAL=0
PREFER_KILL=300
FIRST_KILL=1000

# Map process names to OOM score adjustments
declare -A OOM_SCORES=(
    ["init"]=NEVER_KILL
    ["systemd"]=NEVER_KILL
    ["postgres"]=PROTECTED
    ["redis-server"]=PROTECTED
    ["vault"]=PROTECTED
    ["etcd"]=NEVER_KILL
    ["kubelet"]=PROTECTED
    ["containerd"]=PROTECTED
    ["nginx"]=PROTECTED
    ["worker"]=PREFER_KILL
    ["batch"]=FIRST_KILL
)

apply_oom_score() {
    local name="$1"
    local score_var="$2"
    local score="${!score_var}"

    for pid in $(pgrep -x "$name" 2>/dev/null || true); do
        if [ -f "/proc/${pid}/oom_score_adj" ]; then
            current=$(cat "/proc/${pid}/oom_score_adj")
            if [ "$current" != "$score" ]; then
                echo "${score}" > "/proc/${pid}/oom_score_adj" || \
                    echo "WARNING: Could not set oom_score_adj for $name (pid $pid)"
                echo "Set $name (pid $pid) oom_score_adj: $current -> $score"
            fi
        fi
    done
}

for name in "${!OOM_SCORES[@]}"; do
    apply_oom_score "$name" "${OOM_SCORES[$name]}"
done

echo "OOM score adjustment complete"
```

## Cgroup v2 Memory Management

Cgroup v2 provides hierarchical memory limits that prevent individual workloads from exhausting system memory. Understanding the difference between `memory.limit_in_bytes` (hard limit) and `memory.soft_limit_in_bytes` (soft limit) is critical for Kubernetes resource management.

### Cgroup v2 Memory Files

```bash
# Check if cgroup v2 is active
stat -fc %T /sys/fs/cgroup
# cgroup2fs = cgroup v2 active

# Navigate to a specific container's cgroup
CG_PATH="/sys/fs/cgroup/kubepods/burstable/pod<pod-uid>/<container-id>"

# Memory limit (hard limit in bytes)
cat "${CG_PATH}/memory.max"

# Current memory usage
cat "${CG_PATH}/memory.current"

# Memory high (soft limit — throttles at this level)
cat "${CG_PATH}/memory.high"

# Memory events (OOM kills, throttle events)
cat "${CG_PATH}/memory.events"
# low 0
# high 1523        <-- times throttled at high limit
# max 0
# oom 0
# oom_kill 0       <-- container OOM kills

# Detailed memory statistics
cat "${CG_PATH}/memory.stat"
```

### Cgroup v2 OOM Behavior

When a cgroup reaches its `memory.max` limit, the kernel has two options:

1. **Kill a process in the cgroup** (default): The OOM killer selects a victim within the cgroup based on OOM scores.
2. **Return ENOMEM to the allocating process**: Set `memory.oom.group = 1` to kill the entire cgroup as a unit rather than an individual process.

```bash
# Enable group OOM kill (kill all processes in cgroup together)
echo 1 > "${CG_PATH}/memory.oom.group"

# Set up memory notifications (triggers when approaching limit)
# This requires a userspace daemon listening on the cgroup notification FD
```

### Kubernetes Resource Limits and Cgroup Mapping

```yaml
# How Kubernetes resource requests/limits map to cgroup v2 settings
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    resources:
      requests:
        memory: "512Mi"   # Sets memory.low (soft guarantee)
      limits:
        memory: "1Gi"     # Sets memory.max (hard limit)

# The kubelet also sets memory.high to 80-95% of memory.max
# to throttle the container before it hits the hard limit,
# giving the OOM killer time to react gracefully.
```

```bash
# Verify the mapping for a running pod
POD_NAME="api-server-7d8f9c-xxxxx"
CONTAINER_ID=$(kubectl get pod $POD_NAME -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|containerd://||')

CG_PATH=$(find /sys/fs/cgroup/kubepods -name "*${CONTAINER_ID:0:12}*" -type d | head -1)
echo "Container cgroup: $CG_PATH"
echo "Memory limit: $(cat ${CG_PATH}/memory.max) bytes"
echo "Memory high: $(cat ${CG_PATH}/memory.high) bytes"
echo "Memory current: $(cat ${CG_PATH}/memory.current) bytes"
echo "OOM kills: $(grep oom_kill ${CG_PATH}/memory.events | awk '{print $2}')"
```

## Swap Management in Containerized Environments

### The Kubernetes Swap Debate

Kubernetes historically required swap to be disabled on nodes. Kubernetes 1.28 introduced stable swap support for Linux nodes with cgroup v2.

The argument against swap in Kubernetes clusters:
- Swapping a container's pages makes its latency unpredictable
- The Kubernetes scheduler makes placement decisions based on memory requests, not considering swap usage
- Detecting OOM conditions is harder when swap masks actual memory pressure

The argument for controlled swap:
- Better node memory utilization when workloads have spiky memory patterns
- Prevents OOM kills for short-duration memory spikes
- Enables running more pods per node for batch/non-latency-sensitive workloads

### Configuring Swap with Kubernetes Swap Support

```yaml
# kubelet configuration for swap support (Kubernetes 1.28+)
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Enable swap
failSwapOn: false
memorySwap:
  swapBehavior: LimitedSwap  # or UnlimitedSwap

# LimitedSwap: pods can use swap proportional to their
# memory limit. A pod with 1Gi limit uses at most 1Gi of swap.
# This prevents any single pod from exhausting all swap.
```

```bash
# Configure swap on a Linux node
# Create a dedicated swap file (4 GB)
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Persistent swap via fstab
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Tune swappiness for container workloads
# Lower value = kernel prefers to keep processes in RAM
# vm.swappiness=10 is a reasonable starting point
# vm.swappiness=0 disables swapping for anonymous memory
echo "vm.swappiness=10" >> /etc/sysctl.d/60-swap.conf
sysctl -p /etc/sysctl.d/60-swap.conf

# Verify swap is active
swapon --show
free -h
```

### Swap Pressure Monitoring

```bash
# Monitor swap usage in real-time
watch -n 1 'free -h && swapon --show'

# Check which processes are using swap
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    if [ -f "/proc/$pid/status" ]; then
        vmswap=$(grep VmSwap /proc/$pid/status 2>/dev/null | awk '{print $2}')
        if [ -n "$vmswap" ] && [ "$vmswap" -gt 0 ]; then
            comm=$(cat /proc/$pid/comm 2>/dev/null || echo "unknown")
            printf "PID: %-8s COMM: %-20s SWAP: %d kB\n" \
                "$pid" "$comm" "$vmswap"
        fi
    fi
done | sort -k6 -rn | head -20

# Check paging statistics
vmstat 1 10

# Monitor via node_exporter metrics
# node_memory_SwapTotal_bytes
# node_memory_SwapFree_bytes
# node_memory_SwapCached_bytes
```

## Memory Pressure Detection and Response

### Pressure Stall Information (PSI)

Linux 4.20+ provides Pressure Stall Information, which measures the fraction of time tasks are stalled waiting for memory. PSI is far more actionable than free memory counts:

```bash
# Check memory PSI (available since Linux 4.20)
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.08 total=1234567
# full avg10=0.00 avg60=0.04 avg300=0.02 total=234567

# "some" = at least one task stalled waiting for memory
# "full" = ALL runnable tasks stalled waiting for memory
# avg10/avg60/avg300 = exponential moving average over 10s/60s/300s
```

```bash
# Set up PSI monitoring with Prometheus node_exporter
# Requires node_exporter >= 0.18 with --collector.pressure enabled
# Metrics:
# node_pressure_memory_stalled_seconds_total{type="some"}
# node_pressure_memory_stalled_seconds_total{type="full"}
```

```yaml
# Alert on sustained memory pressure
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: memory-pressure-alerts
  namespace: monitoring
spec:
  groups:
  - name: memory-pressure
    rules:
    - alert: MemoryPressureHigh
      expr: |
        rate(node_pressure_memory_stalled_seconds_total{type="some"}[5m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.instance }} has high memory pressure"
        description: >
          Memory stall rate is {{ $value | humanizePercentage }} over 5 minutes.
          Tasks are spending more than 10% of their time waiting for memory.
        runbook: "https://runbooks.support.tools/linux/memory-pressure"

    - alert: MemoryCriticalPressure
      expr: |
        rate(node_pressure_memory_stalled_seconds_total{type="full"}[1m]) > 0.05
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.instance }} has critical memory pressure"
        description: >
          Full memory stall rate is {{ $value | humanizePercentage }}.
          ALL runnable tasks are waiting for memory — system is nearly frozen.

    - alert: KubernetesNodeOOMKills
      expr: |
        increase(node_vmstat_oom_kill[5m]) > 0
      labels:
        severity: warning
      annotations:
        summary: "OOM kill detected on {{ $labels.instance }}"
        description: >
          {{ $value }} OOM kills in the last 5 minutes on {{ $labels.instance }}.
```

## Production Memory Sizing Strategy

### Container Memory Limit Recommendations

The common mistake is setting container memory limits equal to the application's steady-state usage. This leads to OOM kills during GC pauses, request spikes, or large payload processing.

```yaml
# Well-sized container resources
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
spec:
  template:
    spec:
      containers:
      - name: app
        resources:
          requests:
            # Request = expected steady-state RSS
            # This drives scheduling placement
            memory: "1Gi"
          limits:
            # Limit = request * headroom_factor
            # For JVM: 1.5-2x request (GC headroom)
            # For Go: 1.2-1.5x request
            # For Node.js: 1.5x request
            memory: "2Gi"
        env:
        # For JVM: set heap to 80% of limit
        # The remaining 20% covers off-heap (Metaspace, direct buffers, JVM overhead)
        - name: JAVA_OPTS
          value: "-XX:MaxRAMPercentage=75.0 -XX:InitialRAMPercentage=50.0"

        # For Go: no heap size tuning needed; the GC is memory-responsive
        # but set GOMEMLIMIT to 90% of the limit to trigger GC before OOM
        - name: GOMEMLIMIT
          valueFrom:
            resourceFieldRef:
              resource: limits.memory
              divisor: "1"
              # Go 1.19+: set GOMEMLIMIT = 90% of container memory limit
              # This is best set via an init container or admission webhook
              # that can perform the calculation
```

### Setting GOMEMLIMIT from Container Memory Limit

```go
// pkg/runtime/memlimit.go
// +build !windows

package runtime

import (
    "fmt"
    "os"
    "runtime/debug"
    "strconv"
    "strings"
)

// SetMemLimitFromCgroup reads the container's memory limit from the
// cgroup filesystem and sets GOMEMLIMIT to 90% of that value.
// Call this from main() before starting any goroutines.
func SetMemLimitFromCgroup() error {
    // Try cgroup v2 first
    limit, err := readCgroupV2MemLimit()
    if err != nil {
        // Fall back to cgroup v1
        limit, err = readCgroupV1MemLimit()
        if err != nil {
            return fmt.Errorf("reading cgroup memory limit: %w", err)
        }
    }

    if limit <= 0 || limit == 9223372036854771712 { // max int64 = no limit
        return nil // no cgroup limit set
    }

    // Set GOMEMLIMIT to 90% of the cgroup memory limit
    goMemLimit := int64(float64(limit) * 0.90)
    debug.SetMemoryLimit(goMemLimit)

    fmt.Fprintf(os.Stderr,
        "Set GOMEMLIMIT=%d (90%% of cgroup limit %d)\n",
        goMemLimit, limit)
    return nil
}

func readCgroupV2MemLimit() (int64, error) {
    data, err := os.ReadFile("/sys/fs/cgroup/memory.max")
    if err != nil {
        return 0, err
    }
    s := strings.TrimSpace(string(data))
    if s == "max" {
        return 0, nil // no limit
    }
    return strconv.ParseInt(s, 10, 64)
}

func readCgroupV1MemLimit() (int64, error) {
    data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    if err != nil {
        return 0, err
    }
    return strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
}
```

## Key Takeaways

Linux memory overcommit mode 2 (`vm.overcommit_memory=2`) is the appropriate setting for production systems running latency-sensitive workloads where OOM termination is unacceptable. Mode 0 is a reasonable default for general-purpose servers. Mode 1 (always overcommit) is only appropriate for specific scientific computing workloads.

OOM score tuning via `oom_score_adj` is the most important operational lever available after an OOM event occurs. Every production service that must survive OOM conditions should have its `OOMScoreAdjust` set in its systemd unit file or Kubernetes `priorityClass`. Critical infrastructure processes should use -1000; application services should use negative values; batch and background jobs should use positive values.

Cgroup v2 memory limits with `memory.high` set to 80-90% of `memory.max` provide a graduated response: the kernel throttles the container at the high watermark before triggering an OOM kill at the hard limit. This is the behavior Kubernetes exploits when it sets resource limits.

PSI metrics are the most actionable early warning signal for memory pressure. Monitoring `node_pressure_memory_stalled_seconds_total` provides minutes of warning before an OOM kill occurs, enabling proactive intervention.

For Go services, setting `GOMEMLIMIT` to 90% of the container memory limit is the single most impactful runtime tuning available. It eliminates the GC-triggering-OOM pattern where the Go runtime's garbage collector does not trigger frequently enough to prevent the cgroup memory limit from being hit.
