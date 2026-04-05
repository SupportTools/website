---
title: "Linux OOM Killer: oom_score_adj, Memory Cgroups, OOM Group Killing, and Kubernetes OOM Behavior"
date: 2032-04-15T00:00:00-05:00
draft: false
tags: ["Linux", "OOM Killer", "Kubernetes", "Cgroups", "Memory Management", "Production"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to the Linux OOM killer including oom_score_adj tuning, memory cgroup v2 configurations, OOM group killing behavior, and how Kubernetes quality-of-service classes interact with OOM scoring for production workload protection."
more_link: "yes"
url: "/linux-oom-killer-oom-score-adj-memory-cgroups-kubernetes-oom-behavior/"
---

When a Linux system exhausts its available memory, the OOM (Out of Memory) killer selects and terminates processes to reclaim memory. In containerized environments, this mechanism interacts with cgroups, Kubernetes QoS classes, and resource limits in ways that can cause unexpected workload terminations. Understanding and tuning OOM behavior is critical for production system stability.

<!--more-->

## How the Linux OOM Killer Works

The OOM killer is invoked by the kernel when memory allocation fails and no swap is available. The selection algorithm assigns each process an OOM score and kills the process with the highest score.

### OOM Score Calculation

The kernel calculates an OOM score (0-1000) for each process based on:

```
oom_score = (process_rss_pages / total_memory_pages) * 1000
           + oom_score_adj
```

Where:
- `process_rss_pages`: Resident set size of the process (and its children)
- `total_memory_pages`: Total physical memory
- `oom_score_adj`: Administrator-set adjustment (-1000 to +1000)

```bash
# View OOM score for a process
cat /proc/<pid>/oom_score

# View OOM score adjustment
cat /proc/<pid>/oom_score_adj

# View all processes sorted by OOM score
for pid in /proc/[0-9]*; do
  score=$(cat "${pid}/oom_score" 2>/dev/null || echo "0")
  adj=$(cat "${pid}/oom_score_adj" 2>/dev/null || echo "0")
  comm=$(cat "${pid}/comm" 2>/dev/null || echo "unknown")
  echo "${score} ${adj} ${pid##*/} ${comm}"
done | sort -rn | head -20
```

### oom_score_adj Semantics

```
-1000 : Process is completely exempt from OOM killing (e.g., kernel threads)
  -999 : Extremely unlikely to be killed
     0 : Default, killed proportional to memory usage
  +500 : Much more likely to be killed
 +1000 : Always killed first when OOM occurs
```

Setting `oom_score_adj` to -1000 exempts a process from OOM killing entirely. This should be reserved for truly critical system processes because it shifts the OOM burden to everything else.

---

## Tuning oom_score_adj

### System Daemons and Critical Services

```bash
# Protect systemd (already done by systemd itself)
cat /proc/1/oom_score_adj  # typically -1000 or -999

# Protect sshd to maintain administrative access during OOM events
# systemd unit snippet for sshd:
# [Service]
# OOMScoreAdjust=-900

# Modify oom_score_adj at runtime for a running process
echo -500 > /proc/<pid>/oom_score_adj

# Using systemd OOMScoreAdjust for service units
systemctl set-property sshd.service OOMScoreAdjust=-900
```

### Persistent oom_score_adj via systemd Units

```ini
# /etc/systemd/system/critical-service.service
[Unit]
Description=Critical Production Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/critical-service
# Protect this service from OOM killing
OOMScoreAdjust=-900
# When OOM does kill this process, restart it
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

### Setting oom_score_adj for New Processes

```c
// C program to set its own oom_score_adj before exec
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

int set_oom_score_adj(int adj) {
    int fd = open("/proc/self/oom_score_adj", O_WRONLY);
    if (fd < 0) return -1;

    char buf[16];
    snprintf(buf, sizeof(buf), "%d\n", adj);

    int ret = write(fd, buf, strlen(buf));
    close(fd);
    return ret < 0 ? -1 : 0;
}

int main(int argc, char *argv[]) {
    // Set ourselves to be killed preferentially if OOM occurs
    // (positive value = more likely to be killed)
    if (set_oom_score_adj(200) < 0) {
        perror("set_oom_score_adj");
    }

    // Continue with normal execution...
    return 0;
}
```

---

## Memory Cgroups

### Cgroup v2 Memory Controller

Modern Linux systems (kernel 5.x+) and Kubernetes nodes using cgroup v2 provide richer memory control:

```bash
# Check if system uses cgroup v2
stat -f -c %T /sys/fs/cgroup

# cgroup v1 returns: tmpfs
# cgroup v2 returns: cgroup2fs

# cgroup v2 memory files for a container
ls /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<pod-uid>/<container-id>/
# memory.current    - current memory usage
# memory.high       - memory throttling threshold
# memory.max        - hard memory limit (OOM trigger)
# memory.min        - memory reservation (never reclaimed)
# memory.low        - memory soft reservation
# memory.swap.max   - swap limit
# memory.events     - OOM event counters
# memory.stat       - detailed memory statistics
```

### Memory Cgroup Thresholds

```bash
# View memory hierarchy for a specific pod/container
CONTAINER_ID="<container-id>"
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<pod-uid>/${CONTAINER_ID}"

# Current usage
echo "Current RSS+cache: $(cat ${CGROUP_PATH}/memory.current) bytes"

# Hard limit
echo "Memory limit: $(cat ${CGROUP_PATH}/memory.max) bytes"

# Soft limit (containers throttled when system is under pressure)
echo "Memory high: $(cat ${CGROUP_PATH}/memory.high) bytes"

# OOM events
echo "OOM events:"
cat ${CGROUP_PATH}/memory.events
```

### Cgroup v2 Memory Protection with memory.min

`memory.min` guarantees a minimum amount of memory for a cgroup. Memory below this threshold is never reclaimed under memory pressure:

```bash
# Set minimum guaranteed memory for a cgroup (root only)
echo $((512 * 1024 * 1024)) > /sys/fs/cgroup/kubepods.slice/memory.min

# memory.low provides a softer guarantee - memory below this
# is reclaimed only when system is critically low
echo $((1024 * 1024 * 1024)) > /sys/fs/cgroup/kubepods.slice/memory.low
```

### Monitoring OOM Events with cgroup v2

```bash
# Watch for OOM events in a container's cgroup
inotifywait -m -e modify \
  "/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<pod-uid>/<container-id>/memory.events"

# Parse OOM event counts
parse_memory_events() {
  local cgroup_path="${1}"
  local events_file="${cgroup_path}/memory.events"

  if [[ ! -f "${events_file}" ]]; then
    echo "Cgroup not found: ${cgroup_path}"
    return 1
  fi

  while IFS=' ' read -r key value; do
    case "${key}" in
      oom)          echo "OOM kills: ${value}" ;;
      oom_kill)     echo "OOM killed: ${value}" ;;
      oom_group_kill) echo "OOM group kills: ${value}" ;;
    esac
  done < "${events_file}"
}
```

---

## OOM Group Killing (cgroup v2)

### What is OOM Group Killing?

In cgroup v2, `memory.oom.group` enables "OOM group killing". When set to 1, if any process in the cgroup is OOM-killed, all processes in the cgroup are killed simultaneously. This prevents partial container states where some threads survive but the container is functionally broken.

```bash
# Enable OOM group killing for a cgroup
echo 1 > /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<pod-uid>/memory.oom.group

# This is what Kubernetes does for container cgroups
# Check current setting
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<pod-uid>/memory.oom.group
```

### OOM Group Killing in Kubernetes

Kubernetes 1.25+ enables `memory.oom.group` for container cgroups on cgroup v2 nodes. This means when a container exceeds its memory limit:

1. The kernel OOM killer selects a process within the container's cgroup
2. Because `memory.oom.group=1`, ALL processes in the container cgroup are killed
3. The container is marked as OOMKilled
4. Kubernetes restarts the container according to its restart policy

Without OOM group killing, only the specific process that triggered OOM is killed, which can leave the container in a broken state (e.g., a multi-threaded application where only one thread was killed).

```bash
# Verify OOM group is enabled for a running container
CONTAINER_ID=$(docker inspect --format='{{.Id}}' <container-name>)
# For containerd:
CONTAINER_ID=$(crictl ps --name <container-name> -q)

# Find cgroup path
cat /proc/$(pgrep -f <container-process>)/cgroup

# Check memory.oom.group
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<pod-uid>/<container-id>/memory.oom.group
```

---

## Kubernetes QoS Classes and OOM Scoring

### QoS Class to OOM Score Mapping

Kubernetes sets `oom_score_adj` based on the pod's QoS class:

| QoS Class | oom_score_adj | Condition |
|---|---|---|
| Guaranteed | -997 | All containers have requests == limits for CPU and memory |
| Burstable | 2 to 999 | At least one container has memory requests < limits |
| BestEffort | 1000 | No resource requests or limits set |

For Burstable pods, the score is calculated as:
```
oom_score_adj = 1000 - (1000 * container_memory_request / node_allocatable_memory)
```

A container requesting 100Mi on a 4Gi node:
```
oom_score_adj = 1000 - (1000 * 100Mi / 4096Mi)
             = 1000 - 24.4
             ≈ 976
```

A container requesting 2048Mi on a 4Gi node:
```
oom_score_adj = 1000 - (1000 * 2048Mi / 4096Mi)
             = 1000 - 500
             = 500
```

This means pods with LARGER memory requests are MORE protected from OOM killing, which is the intended behavior.

### Verifying OOM Scores in Kubernetes

```bash
# Check OOM scores for all container processes on a node
# Run this on the node itself

# Get kubelet-assigned OOM scores
for pid_dir in /proc/[0-9]*/; do
  pid="${pid_dir//[^0-9]/}"
  score=$(cat "${pid_dir}oom_score" 2>/dev/null) || continue
  adj=$(cat "${pid_dir}oom_score_adj" 2>/dev/null) || continue
  comm=$(cat "${pid_dir}comm" 2>/dev/null | tr -d '\n') || continue
  cgroup=$(cat "${pid_dir}cgroup" 2>/dev/null | grep "kubepods" | head -1) || continue

  [[ -n "${cgroup}" ]] && echo "${score} ${adj} ${pid} ${comm}"
done | sort -rn | head -30
```

### Kubernetes Resource Requests Best Practices for OOM Protection

```yaml
# Guaranteed QoS - best OOM protection
# requests == limits for all resources
apiVersion: v1
kind: Pod
metadata:
  name: guaranteed-pod
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          memory: "512Mi"
          cpu: "500m"
        limits:
          memory: "512Mi"   # Must equal request
          cpu: "500m"       # Must equal request
---
# Burstable QoS - moderate protection
# OOM score depends on request size relative to node capacity
apiVersion: v1
kind: Pod
metadata:
  name: burstable-pod
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          memory: "256Mi"
          cpu: "250m"
        limits:
          memory: "1Gi"     # Can burst above request
          cpu: "2000m"
---
# BestEffort QoS - killed first
# No requests or limits - oom_score_adj=1000
apiVersion: v1
kind: Pod
metadata:
  name: besteffort-pod
spec:
  containers:
    - name: batch-job
      image: batch:latest
      # No resources block = BestEffort
```

---

## OOM Kill Detection and Response

### Detecting OOM Kills in Kubernetes

```bash
# Check if a container was OOM killed
kubectl describe pod <pod-name> | grep -A5 "Last State"
# Output:
#   Last State:  Terminated
#     Reason:    OOMKilled
#     Exit Code: 137
#     Started:   ...
#     Finished:  ...

# Check OOM kills in pod events
kubectl get events --field-selector reason=OOMKilling

# Get OOM kill history for all pods in a namespace
kubectl get pods -n production -o json | jq '
  .items[] |
  select(
    .status.containerStatuses[]?.lastState.terminated.reason == "OOMKilled"
  ) | {
    pod: .metadata.name,
    container: (.status.containerStatuses[] |
      select(.lastState.terminated.reason == "OOMKilled") | .name),
    lastOOM: .status.containerStatuses[].lastState.terminated.finishedAt
  }'
```

### Node-Level OOM Detection

```bash
# Check kernel ring buffer for OOM events
dmesg -T | grep -i "oom\|killed process\|out of memory"

# Example output:
# [Mon Apr 13 10:23:45 2032] Out of memory: Kill process 12345 (java) score 756 or sacrifice child
# [Mon Apr 13 10:23:45 2032] Killed process 12345 (java) total-vm:2097152kB, anon-rss:1048576kB

# Monitor OOM events in real-time
journalctl -k -f | grep -i "oom\|killed process"

# Count OOM kills from systemd journal
journalctl -k --since="24 hours ago" | grep "Killed process" | wc -l
```

### Prometheus OOM Kill Metrics

```yaml
# kube-state-metrics exposes OOM termination reasons
# Query for containers that were OOM killed
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1

# Alert on OOM kills
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: oom-kill-alerts
  namespace: monitoring
spec:
  groups:
    - name: oom
      rules:
        - alert: ContainerOOMKilled
          expr: |
            increase(kube_pod_container_status_restarts_total[10m]) > 0
            and on(pod, container, namespace)
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} was OOM killed"

        - alert: FrequentOOMKills
          expr: |
            increase(kube_pod_container_status_restarts_total[1h]) > 3
            and on(pod, container, namespace)
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          labels:
            severity: critical
          annotations:
            summary: "Container {{ $labels.container }} OOM killed >3 times in 1h"
            description: "Memory limit may be too low or there is a memory leak in {{ $labels.pod }}"
```

---

## Memory Pressure Handling

### Kernel Memory Pressure Notifications with cgroup v2

```go
package memory

import (
    "fmt"
    "os"
    "strings"
)

// PressureLevel represents memory pressure severity
type PressureLevel string

const (
    PressureLevelSome     PressureLevel = "some"     // Some tasks stalled
    PressureLevelFull     PressureLevel = "full"     // All tasks stalled
    PressureLevelCritical PressureLevel = "critical" // Memory exhausted
)

// WatchMemoryPressure watches the cgroup memory.pressure file and calls
// the handler when pressure exceeds the threshold.
// cgroupPath: path to the cgroup (e.g., /sys/fs/cgroup/kubepods.slice)
func WatchMemoryPressure(cgroupPath string, level PressureLevel, stallWindowMS, stallThresholdUS int, handler func()) error {
    pressurePath := cgroupPath + "/memory.pressure"

    f, err := os.Open(pressurePath)
    if err != nil {
        return fmt.Errorf("opening memory.pressure: %w", err)
    }

    // Register pressure notification using PSI (Pressure Stall Information)
    // Format: "LEVEL stall_window_us threshold_us"
    notifyConfig := fmt.Sprintf("%s %d %d",
        level,
        stallWindowMS*1000,   // Convert to microseconds
        stallThresholdUS,
    )

    if _, err := f.WriteString(notifyConfig); err != nil {
        f.Close()
        return fmt.Errorf("writing pressure config: %w", err)
    }

    // Read from the fd blocks until threshold is exceeded
    go func() {
        defer f.Close()
        buf := make([]byte, 64)
        for {
            n, err := f.Read(buf)
            if err != nil {
                return
            }
            if strings.TrimSpace(string(buf[:n])) != "" {
                handler()
            }
        }
    }()

    return nil
}
```

### Application-Level Memory Limit Awareness

Applications should respond to approaching memory limits before the OOM killer intervenes:

```go
package memory

import (
    "context"
    "fmt"
    "os"
    "runtime"
    "strconv"
    "strings"
    "time"

    "go.uber.org/zap"
)

// LimitWatcher monitors cgroup memory usage and triggers GC or shedding
// before the OOM killer is invoked.
type LimitWatcher struct {
    logger           *zap.Logger
    cgroupMemPath    string
    warningThreshold float64 // 0.85 = trigger at 85% of limit
    criticalThreshold float64 // 0.95 = shed load at 95% of limit
    interval         time.Duration
    onWarning        func(used, limit int64)
    onCritical       func(used, limit int64)
}

// NewLimitWatcher creates a watcher for the current process's cgroup.
func NewLimitWatcher(logger *zap.Logger, warning, critical float64) (*LimitWatcher, error) {
    cgroupPath, err := detectCgroupPath()
    if err != nil {
        return nil, fmt.Errorf("detecting cgroup path: %w", err)
    }

    return &LimitWatcher{
        logger:            logger,
        cgroupMemPath:     cgroupPath,
        warningThreshold:  warning,
        criticalThreshold: critical,
        interval:          5 * time.Second,
    }, nil
}

func detectCgroupPath() (string, error) {
    // Read /proc/self/cgroup to find the cgroup v2 path
    data, err := os.ReadFile("/proc/self/cgroup")
    if err != nil {
        return "", err
    }

    for _, line := range strings.Split(string(data), "\n") {
        parts := strings.SplitN(line, ":", 3)
        if len(parts) == 3 && parts[0] == "0" {
            return "/sys/fs/cgroup" + parts[2], nil
        }
    }

    return "", fmt.Errorf("cgroup v2 path not found")
}

func readInt64File(path string) (int64, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return 0, err
    }
    s := strings.TrimSpace(string(data))
    if s == "max" {
        return 1<<62 - 1, nil // Effectively unlimited
    }
    return strconv.ParseInt(s, 10, 64)
}

// Run starts the memory watcher loop.
func (w *LimitWatcher) Run(ctx context.Context) {
    ticker := time.NewTicker(w.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            w.check()
        }
    }
}

func (w *LimitWatcher) check() {
    current, err := readInt64File(w.cgroupMemPath + "/memory.current")
    if err != nil {
        w.logger.Warn("reading memory.current", zap.Error(err))
        return
    }

    limit, err := readInt64File(w.cgroupMemPath + "/memory.max")
    if err != nil {
        w.logger.Warn("reading memory.max", zap.Error(err))
        return
    }

    ratio := float64(current) / float64(limit)

    if ratio >= w.criticalThreshold {
        w.logger.Warn("memory usage critical",
            zap.Float64("ratio", ratio),
            zap.Int64("current_bytes", current),
            zap.Int64("limit_bytes", limit),
        )

        // Force GC to reclaim memory
        runtime.GC()

        if w.onCritical != nil {
            w.onCritical(current, limit)
        }
    } else if ratio >= w.warningThreshold {
        w.logger.Info("memory usage high",
            zap.Float64("ratio", ratio),
            zap.Int64("current_bytes", current),
            zap.Int64("limit_bytes", limit),
        )

        // Suggest GC without forcing
        runtime.GC()

        if w.onWarning != nil {
            w.onWarning(current, limit)
        }
    }
}
```

---

## Investigating OOM Kills

### Post-OOM Analysis Script

```bash
#!/usr/bin/env bash
# oom-analysis.sh - Analyze OOM kills on a Kubernetes node

set -euo pipefail

echo "=== OOM Kill Analysis $(date) ==="

echo ""
echo "--- Recent kernel OOM events (last 24h) ---"
journalctl -k --since="24 hours ago" --no-pager | \
  grep -E "oom|killed process|out of memory" | \
  tail -50

echo ""
echo "--- Current node memory pressure ---"
cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|Cached|SwapTotal|SwapFree|Dirty|Writeback"

echo ""
echo "--- Cgroup memory usage (top 10) ---"
find /sys/fs/cgroup/kubepods.slice -name "memory.current" 2>/dev/null | \
  while read f; do
    val=$(cat "${f}" 2>/dev/null || echo 0)
    echo "${val} ${f}"
  done | sort -rn | head -10 | \
  while read val path; do
    cgroup="${path%/memory.current}"
    limit=$(cat "${cgroup}/memory.max" 2>/dev/null || echo "unknown")
    echo "Usage: $((val/1024/1024))Mi  Limit: ${limit}  Cgroup: ${cgroup##*/}"
  done

echo ""
echo "--- Kubernetes pods with OOMKilled containers ---"
kubectl get pods -A -o json 2>/dev/null | jq -r '
  .items[] |
  select(
    .status.containerStatuses != null and
    (.status.containerStatuses[] | .lastState.terminated.reason == "OOMKilled")
  ) |
  [
    .metadata.namespace,
    .metadata.name,
    (.status.containerStatuses[] |
      select(.lastState.terminated.reason == "OOMKilled") |
      .name + " (OOMKilled at " + .lastState.terminated.finishedAt + ")"
    )
  ] | @tsv' | column -t

echo ""
echo "--- Top memory-consuming processes ---"
ps aux --sort=-%mem | head -20
```

### Memory Limit Tuning Recommendations

```bash
# Get current requests and limits for all containers in a namespace
kubectl get pods -n production -o json | jq -r '
  .items[] | .metadata.name as $pod |
  .spec.containers[] |
  [
    $pod,
    .name,
    (.resources.requests.memory // "none"),
    (.resources.limits.memory // "none")
  ] | @tsv' | column -t -N "POD,CONTAINER,MEMORY_REQUEST,MEMORY_LIMIT"

# Kubernetes VPA recommendation (install VPA first)
kubectl get vpa -n production -o json | jq -r '
  .items[] |
  [
    .metadata.name,
    (.status.recommendation.containerRecommendations[] |
      .containerName + ": " +
      "request=" + .lowerBound.memory +
      " target=" + .target.memory +
      " limit=" + .upperBound.memory
    )
  ] | @tsv'
```

---

## Kernel OOM Parameters

### /proc/sys/vm Tuning

```bash
# Check current overcommit settings
cat /proc/sys/vm/overcommit_memory
# 0: Heuristic overcommit (default)
# 1: Always overcommit (dangerous in production)
# 2: Never overcommit beyond (overcommit_ratio)%

cat /proc/sys/vm/overcommit_ratio
# Used when overcommit_memory=2
# Default: 50 (50% of RAM + swap)

# Check OOM killer behavior
cat /proc/sys/vm/panic_on_oom
# 0: Call OOM killer (default)
# 1: Panic on OOM (for clusters that prefer node restart over partial failure)
# 2: Panic only if oom_kill_allocating_task fails

# OOM killer logging verbosity
cat /proc/sys/vm/oom_dump_tasks
# 1: Dump all tasks when OOM occurs (default)
```

### Production-Recommended sysctl Settings

```yaml
# DaemonSet to apply kernel memory tuning on all nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-memory-tuning
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-memory-tuning
  template:
    metadata:
      labels:
        app: node-memory-tuning
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      initContainers:
        - name: sysctl-tuner
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              # Heuristic overcommit - default, recommended for Kubernetes
              sysctl -w vm.overcommit_memory=0

              # Enable OOM dumps for debugging
              sysctl -w vm.oom_dump_tasks=1

              # Don't panic on OOM - let OOM killer work
              sysctl -w vm.panic_on_oom=0

              # Reduce swappiness - prefer OOM kill over heavy swapping
              sysctl -w vm.swappiness=10

              # Reduce dirty page writeback to avoid memory spikes
              sysctl -w vm.dirty_ratio=10
              sysctl -w vm.dirty_background_ratio=5

              echo "Memory tuning applied"
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
```

---

## Summary

The Linux OOM killer involves multiple interacting layers in Kubernetes environments:

- **oom_score_adj**: Set by kubelet based on QoS class. Guaranteed pods (-997) are heavily protected, BestEffort pods (1000) are always killed first
- **cgroup v2 memory.oom.group**: Ensures entire container is killed together, preventing partial-state failures
- **memory.min and memory.low**: Provide memory protection guarantees within the cgroup hierarchy
- **Proper resource requests**: Setting accurate memory requests is the primary mechanism for OOM protection in Kubernetes

The practical takeaway for production: always set memory requests and limits on every container, right-size based on VPA recommendations, and use Guaranteed QoS for latency-sensitive workloads that cannot tolerate unexpected termination.
