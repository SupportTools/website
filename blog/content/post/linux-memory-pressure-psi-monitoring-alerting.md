---
title: "Linux Memory Pressure and PSI: Monitoring and Alerting on Resource Contention"
date: 2031-09-18T00:00:00-05:00
draft: false
tags: ["Linux", "PSI", "Memory Management", "Monitoring", "Performance", "cgroups"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux Pressure Stall Information (PSI), memory pressure metrics, alerting strategies, and integration with Prometheus for production resource contention monitoring."
more_link: "yes"
url: "/linux-memory-pressure-psi-monitoring-alerting/"
---

Knowing that a system is out of memory is easy — the OOM killer fires and processes die. Knowing that a system is approaching memory pressure, experiencing CPU scheduling delays, or suffering I/O wait stalls before they cause visible failures is much harder. Linux Pressure Stall Information (PSI) was introduced in kernel 4.20 to address exactly this gap: it provides quantitative, low-overhead metrics on how much time tasks are stalled waiting for CPU, memory, or I/O resources.

This post covers the PSI subsystem in depth — what it measures, how to read it, how to configure cgroup-level pressure monitoring, how to integrate PSI with Prometheus and alerting, and practical tuning strategies for high-density container environments.

<!--more-->

# Linux Memory Pressure and PSI: Monitoring and Alerting

## What PSI Measures

PSI answers a deceptively simple question: "What fraction of time are tasks unable to make progress because they lack a resource?"

There are three resource dimensions:

- **CPU**: Tasks are runnable but cannot execute because CPUs are busy.
- **Memory**: Tasks are waiting for memory to be allocated, reclaimed, or swapped in.
- **IO**: Tasks are waiting for block device I/O to complete.

Within each dimension, PSI distinguishes two severity levels:

- **some**: At least one task is stalled on this resource. Workloads may still make progress on other CPUs or with other processes.
- **full**: All runnable tasks are stalled. The system is making zero useful progress during this window.

The `full` metric is particularly important: a `full` stall means the entire system is frozen from the perspective of the affected tasks, which is directly analogous to throughput loss.

## Reading PSI Files

PSI data is exposed in `/proc/pressure/`:

```bash
cat /proc/pressure/memory
# some avg10=0.45 avg60=0.23 avg300=0.08 total=12345678
# full avg10=0.02 avg60=0.01 avg300=0.00 total=567890
```

The fields:

| Field | Description |
|-------|-------------|
| `avg10` | Percentage of time stalled over the last 10 seconds |
| `avg60` | Percentage of time stalled over the last 60 seconds |
| `avg300` | Percentage of time stalled over the last 5 minutes |
| `total` | Total microseconds spent stalled since boot |

The `total` counter is the most useful for monitoring because it is monotonically increasing and immune to the exponential-decay averaging applied to the `avg*` fields.

```bash
# Read all three pressure files
for res in cpu memory io; do
    echo "=== $res ==="
    cat /proc/pressure/$res
done
```

```
=== cpu ===
some avg10=1.23 avg60=0.87 avg300=0.34 total=89234512
=== memory ===
some avg10=0.45 avg60=0.23 avg300=0.08 total=12345678
full avg10=0.02 avg60=0.01 avg300=0.00 total=567890
=== io ===
some avg10=3.21 avg60=1.45 avg300=0.67 total=234567890
full avg10=0.89 avg60=0.43 avg300=0.19 total=45678901
```

Note that CPU does not have a `full` line because there is no concept of all tasks stalling due to CPU contention — if tasks are stalled on CPU, at least one task is running (the one holding the CPU).

## PSI in cgroups v2

PSI becomes far more powerful when combined with cgroups v2. Each cgroup exposes its own `memory.pressure`, `cpu.pressure`, and `io.pressure` files, allowing you to measure contention at the container or service level:

```bash
# List all cgroup pressure files
find /sys/fs/cgroup -name "*.pressure" 2>/dev/null | head -20

# Read pressure for a specific container
cat /sys/fs/cgroup/system.slice/docker-abc123.scope/memory.pressure
# some avg10=2.34 avg60=1.12 avg300=0.56 total=23456789
# full avg10=0.12 avg60=0.06 avg300=0.02 total=1234567
```

For Kubernetes, the cgroup path for a pod can be found by inspecting the pod's cgroup:

```bash
# Find cgroup path for a specific pod
POD_UID="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
CONTAINER_ID=$(kubectl get pod mypod -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's/containerd:\/\///')

# cgroup v2 path
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-pod${POD_UID//-/_}.slice"
ls "$CGROUP_PATH"
cat "$CGROUP_PATH/memory.pressure"
```

## Kernel PSI Triggers (Polling via Poll/Epoll)

The kernel provides a notification mechanism: you can `write` a threshold to a pressure file and then `poll` it for readiness, which fires when the threshold is exceeded. This allows userspace to react to pressure events without polling overhead:

```c
// psi_trigger.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>

int main(void) {
    // Monitor memory pressure: trigger when full stall > 100ms in 1s window
    const char *path = "/proc/pressure/memory";
    const char *trigger = "full 100000 1000000\n"; // 100ms stall / 1s window

    int fd = open(path, O_RDWR | O_NONBLOCK);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    if (write(fd, trigger, strlen(trigger)) < 0) {
        perror("write trigger");
        return 1;
    }

    struct pollfd pfd = {
        .fd = fd,
        .events = POLLPRI,
    };

    printf("Monitoring memory pressure...\n");
    while (1) {
        int ret = poll(&pfd, 1, -1);
        if (ret < 0) {
            perror("poll");
            break;
        }
        if (pfd.revents & POLLPRI) {
            printf("Memory pressure threshold exceeded!\n");
            // Read current pressure values
            char buf[256];
            lseek(fd, 0, SEEK_SET);
            int n = read(fd, buf, sizeof(buf) - 1);
            if (n > 0) {
                buf[n] = '\0';
                printf("%s\n", buf);
            }
        }
    }
    close(fd);
    return 0;
}
```

The trigger format is: `<some|full> <stall_threshold_us> <window_us>`

- `full 100000 1000000` — trigger when full stall exceeds 100ms within a 1-second window.
- Minimum window size: 500ms. Maximum window size: 10 seconds.

## Prometheus Integration

The `node_exporter` collects PSI metrics when run with `--collector.pressure` (enabled by default in recent versions):

```bash
# Verify PSI metrics are being collected
curl -s http://localhost:9100/metrics | grep node_pressure
# node_pressure_cpu_waiting_seconds_total 89.234512
# node_pressure_memory_waiting_seconds_total 12.345678
# node_pressure_memory_stalled_seconds_total 0.56789
# node_pressure_io_waiting_seconds_total 234.56789
# node_pressure_io_stalled_seconds_total 45.678901
```

For per-cgroup metrics, use `cAdvisor` (which exports container-level PSI when available):

```bash
# cAdvisor PSI metrics
curl -s http://localhost:8080/metrics | grep container_pressure
# container_memory_pressure_some_seconds_total{...} 23.456789
# container_memory_pressure_full_seconds_total{...} 1.234567
```

## Prometheus Alerting Rules

```yaml
# psi-alerts.yaml
groups:
  - name: psi.memory
    interval: 30s
    rules:
      # Alert on sustained memory pressure at the node level
      - alert: NodeMemoryPressureHigh
        expr: |
          rate(node_pressure_memory_waiting_seconds_total[5m]) * 100 > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} has high memory pressure"
          description: >
            Node {{ $labels.instance }} is spending
            {{ printf "%.1f" $value }}% of time with tasks waiting
            for memory. This indicates memory contention.

      - alert: NodeMemoryFullStalledCritical
        expr: |
          rate(node_pressure_memory_stalled_seconds_total[5m]) * 100 > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.instance }} has critical memory full stall"
          description: >
            Node {{ $labels.instance }} is spending
            {{ printf "%.1f" $value }}% of time with ALL tasks fully
            stalled on memory. Immediate action required.

      # Alert on container-level pressure
      - alert: ContainerMemoryPressureHigh
        expr: |
          rate(container_memory_pressure_some_seconds_total{
            container!="",
            container!="POD"
          }[5m]) * 100 > 20
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} has high memory pressure"
          description: >
            Container {{ $labels.container }} in pod {{ $labels.pod }}
            (namespace: {{ $labels.namespace }}) is experiencing
            {{ printf "%.1f" $value }}% memory pressure.
            Consider increasing memory limits.

  - name: psi.io
    rules:
      - alert: NodeIOStallCritical
        expr: |
          rate(node_pressure_io_stalled_seconds_total[5m]) * 100 > 25
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.instance }} has critical I/O full stall"
          description: >
            {{ printf "%.1f" $value }}% of time fully stalled on I/O.
            Disk or network I/O is severely impacting all workloads.

  - name: psi.cpu
    rules:
      - alert: NodeCPUPressureHigh
        expr: |
          rate(node_pressure_cpu_waiting_seconds_total[5m]) * 100 > 40
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} has high CPU pressure"
          description: >
            {{ printf "%.1f" $value }}% of time with tasks waiting for
            CPU. Consider adding CPU resources or reducing workload density.
```

## Grafana Dashboard Queries

Key queries for a PSI dashboard:

```promql
# Memory pressure rate (some) - % of time at least one task stalled
rate(node_pressure_memory_waiting_seconds_total{instance="$node"}[1m]) * 100

# Memory pressure rate (full) - % of time all tasks stalled
rate(node_pressure_memory_stalled_seconds_total{instance="$node"}[1m]) * 100

# Per-container memory pressure heatmap
topk(10,
  rate(container_memory_pressure_some_seconds_total{
    namespace="$namespace",
    container!="",
    container!="POD"
  }[5m]) * 100
)

# PSI pressure score: normalized composite metric
(
  rate(node_pressure_cpu_waiting_seconds_total[5m]) * 0.3 +
  rate(node_pressure_memory_waiting_seconds_total[5m]) * 0.5 +
  rate(node_pressure_io_waiting_seconds_total[5m]) * 0.2
) * 100
```

## Interpreting PSI Metrics in Practice

Understanding what PSI values mean in context:

| PSI Memory `some` (5m avg) | Interpretation | Action |
|---------------------------|----------------|--------|
| 0% - 1% | No pressure | Normal |
| 1% - 5% | Light pressure | Monitor |
| 5% - 20% | Moderate pressure | Investigate; consider scaling |
| 20% - 50% | Heavy pressure | Reduce load or add memory |
| > 50% | Severe pressure | Immediate action required |

| PSI Memory `full` (5m avg) | Interpretation | Action |
|---------------------------|----------------|--------|
| 0% | No full stalls | Normal |
| 0.1% - 1% | Occasional stalls | Watch for trends |
| 1% - 5% | Frequent stalls | Latency impact, investigate |
| > 5% | Severe stalls | Performance emergency |

The `full` metric is the stronger signal. Even 1% full stall means the workload lost 1% of its potential throughput to complete memory stalls — at 100k RPS, that is 1000 requests per second experiencing stall-induced latency.

## cgroup Memory Pressure Events

The cgroup v2 memory subsystem also generates pressure events independently of the PSI interface:

```bash
# Check memory events for a container
cat /sys/fs/cgroup/kubepods.slice/kubepods-pod*/memory.events
# low 0
# high 342
# max 12
# oom 0
# oom_kill 0
# oom_group_kill 0
```

| Event | Meaning |
|-------|---------|
| `low` | Below soft limit; minor reclaim triggered |
| `high` | Exceeded high limit; synchronous reclaim triggered |
| `max` | Attempted allocation at hard limit; blocked |
| `oom` | OOM condition reached |
| `oom_kill` | OOM kill performed |
| `oom_group_kill` | Entire cgroup OOM-killed |

The `high` counter is the leading indicator to watch: it fires before OOM and indicates the kernel is synchronously reclaiming memory in the allocation path, directly adding latency to every memory allocation in the container.

## Kubernetes Memory Pressure Detection Script

```bash
#!/bin/bash
# k8s-psi-report.sh - Report PSI metrics for all pods on this node

NODE=$(hostname)
CGROUP_BASE="/sys/fs/cgroup"

echo "PSI Report for node: $NODE"
echo "Timestamp: $(date -Iseconds)"
echo ""
echo "=== Node-level Pressure ==="
for res in cpu memory io; do
    echo "--- $res ---"
    cat /proc/pressure/$res 2>/dev/null || echo "  Not available"
done

echo ""
echo "=== Container-level Memory Pressure (top 10 by some%) ==="
printf "%-60s %8s %8s\n" "Container" "some%" "full%"
printf "%-60s %8s %8s\n" "---------" "------" "------"

find "$CGROUP_BASE" -name "memory.pressure" 2>/dev/null | while read f; do
    cgroup=$(dirname "$f")
    name=$(basename "$cgroup")
    some=$(awk '/^some/{print $2}' "$f" | sed 's/avg10=//')
    full=$(awk '/^full/{print $2}' "$f" | sed 's/avg10=//')
    [ -z "$some" ] && continue
    [ "$some" = "0.00" ] && [ "$full" = "0.00" ] && continue
    printf "%-60s %8s %8s\n" "$name" "$some" "${full:-N/A}"
done | sort -k2 -rn | head -10

echo ""
echo "=== Memory Events Summary (containers with oom_kill > 0) ==="
find "$CGROUP_BASE" -name "memory.events" 2>/dev/null | while read f; do
    oom_kill=$(grep "^oom_kill" "$f" | awk '{print $2}')
    [ "$oom_kill" -gt 0 ] 2>/dev/null || continue
    cgroup=$(dirname "$f")
    echo "  $(basename $cgroup): oom_kill=$oom_kill"
    cat "$f" | sed 's/^/    /'
done
```

## Tuning Memory Reclaim Behavior

PSI metrics interact with kernel memory management tuning. Key parameters:

```bash
# Reduce swappiness to prefer reclaiming page cache over swapping
# (good for containers where swap is undesirable)
echo 10 > /proc/sys/vm/swappiness

# Increase dirty ratio to reduce I/O pressure from page writeback
echo 20 > /proc/sys/vm/dirty_ratio
echo 10 > /proc/sys/vm/dirty_background_ratio

# Adjust memory watermarks to trigger reclaim earlier
# (prevents sudden pressure spikes)
echo 16384 > /proc/sys/vm/min_free_kbytes

# Enable memory compaction for THP/hugepage workloads
echo always > /proc/sys/vm/compaction_proactiveness
```

Verify the effect of tuning using PSI rates:

```bash
# Before tuning - measure baseline
awk '{print $2}' /proc/pressure/memory | head -1
sleep 60
awk '{print $2}' /proc/pressure/memory | head -1
# After tuning - compare avg60 values
```

## PSI in Kubernetes Node Conditions

The kubelet uses PSI-adjacent signals (memory pressure, disk pressure) to set node conditions that affect scheduling. Integrate custom PSI thresholds with the kubelet:

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
evictionSoft:
  memory.available: "500Mi"
evictionSoftGracePeriod:
  memory.available: "1m30s"
evictionPressureTransitionPeriod: "5m"
# Custom PSI-based eviction (requires PSI eviction feature gate)
# featureGates:
#   KubeletPSI: true
```

## Automated Remediation Using PSI Triggers

A Go daemon that monitors PSI and triggers remediation:

```go
package main

import (
    "bufio"
    "fmt"
    "log"
    "os"
    "os/exec"
    "strings"
    "syscall"
    "time"
)

const (
    memPressurePath = "/proc/pressure/memory"
    fullThreshold   = 5.0 // percent
    checkInterval   = 10 * time.Second
)

func readPSI(path string) (someAvg10, fullAvg10 float64, err error) {
    f, err := os.Open(path)
    if err != nil {
        return 0, 0, err
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        fields := strings.Fields(line)
        if len(fields) < 2 {
            continue
        }
        var avg10 float64
        fmt.Sscanf(fields[1], "avg10=%f", &avg10)
        if strings.HasPrefix(line, "some") {
            someAvg10 = avg10
        } else if strings.HasPrefix(line, "full") {
            fullAvg10 = avg10
        }
    }
    return someAvg10, fullAvg10, scanner.Err()
}

func triggerMemoryPressureRemediation() {
    log.Println("Memory pressure threshold exceeded, triggering remediation")

    // Example: drop page cache
    if err := os.WriteFile("/proc/sys/vm/drop_caches", []byte("1\n"), 0200); err != nil {
        log.Printf("Failed to drop caches: %v", err)
    }

    // Example: send SIGTERM to lowest-priority background job
    // In production, this would integrate with Kubernetes eviction API
    cmd := exec.Command("systemctl", "stop", "low-priority-batch.service")
    if err := cmd.Run(); err != nil {
        _ = err // service might not exist
    }
}

func main() {
    ticker := time.NewTicker(checkInterval)
    defer ticker.Stop()

    var consecutiveHigh int

    for range ticker.C {
        _, fullAvg10, err := readPSI(memPressurePath)
        if err != nil {
            log.Printf("Error reading PSI: %v", err)
            consecutiveHigh = 0
            continue
        }

        if fullAvg10 > fullThreshold {
            consecutiveHigh++
            log.Printf("Memory full stall: %.2f%% (consecutive high checks: %d)",
                fullAvg10, consecutiveHigh)
            if consecutiveHigh >= 3 {
                triggerMemoryPressureRemediation()
                consecutiveHigh = 0
            }
        } else {
            if consecutiveHigh > 0 {
                log.Printf("Memory pressure normalized: %.2f%%", fullAvg10)
            }
            consecutiveHigh = 0
        }

        _ = syscall.Getpagesize() // keep import
    }
}
```

## Production Monitoring Stack

A complete observability stack for PSI:

```yaml
# docker-compose.yml for local testing
version: "3.8"
services:
  node_exporter:
    image: prom/node-exporter:latest
    pid: host
    command:
      - "--path.procfs=/host/proc"
      - "--path.sysfs=/host/sys"
      - "--collector.pressure"
      - "--collector.cgroups"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
    ports:
      - "9100:9100"

  prometheus:
    image: prom/prometheus:latest
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.retention.time=30d"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./psi-alerts.yaml:/etc/prometheus/psi-alerts.yaml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
    volumes:
      - ./grafana-dashboards:/etc/grafana/provisioning/dashboards
    ports:
      - "3000:3000"
```

## Summary

PSI provides a unified, quantitative measure of resource contention that fills the gap between "everything is fine" and "the OOM killer fired." By monitoring both `some` and `full` stall times at the node and container level, you gain early warning of memory pressure events and can trigger remediation before workloads degrade. The combination of kernel-level PSI triggers for real-time reaction and Prometheus-based time-series tracking for trend analysis provides a complete observability solution for resource pressure in production Linux systems.
