---
title: "Linux CFS Bandwidth Control: CPU Throttling and Quota Management"
date: 2029-05-14T00:00:00-05:00
draft: false
tags: ["Linux", "CFS", "CPU", "cgroups", "Kubernetes", "Performance", "eBPF"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux Completely Fair Scheduler bandwidth control: cpu.cfs_quota_us mechanics, throttled_time analysis, burst mode configuration, identifying CPU throttling with perf and eBPF, and practical Kubernetes CPU limits tuning to eliminate unnecessary throttling."
more_link: "yes"
url: "/linux-cfs-bandwidth-control-cpu-throttling-quota-management/"
---

CPU throttling is one of the most misunderstood performance problems in containerized environments. A pod can appear CPU-constrained — exhibiting high latency, slow startup, or request timeouts — even when the node has plenty of available CPU. The culprit is CFS bandwidth control: the Linux kernel's mechanism for enforcing CPU limits via the Completely Fair Scheduler. Understanding how quotas and periods interact, how to detect throttling, and when burst mode changes the math is essential for anyone running latency-sensitive workloads on Kubernetes.

<!--more-->

# Linux CFS Bandwidth Control: CPU Throttling and Quota Management

## Section 1: CFS Bandwidth Control Mechanics

The Completely Fair Scheduler (CFS) assigns CPU time using a virtual runtime model. Bandwidth control adds a quota/period layer on top: each cgroup is allocated `cpu.cfs_quota_us` microseconds of CPU time every `cpu.cfs_period_us` microseconds.

### The Quota/Period Model

```
Period: 100ms (100,000 microseconds — the default)
Quota:  200ms (200,000 microseconds — meaning "2 CPUs worth")

Each 100ms period:
├── cgroup gets 200ms of CPU time
├── If it uses 200ms: throttled until next period
└── If it uses 150ms: 50ms unused (NOT carried over by default)
```

### cgroup v1 Controls

```bash
# Find your container's cgroup
cat /proc/$(pidof myapp)/cgroup
# 11:cpu,cpuacct:/kubepods/burstable/pod<uuid>/<container-id>

CGROUP_PATH="/sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod<uuid>/<container-id>"

# View current settings
cat $CGROUP_PATH/cpu.cfs_period_us   # Typically: 100000 (100ms)
cat $CGROUP_PATH/cpu.cfs_quota_us    # -1 = unlimited, or n microseconds

# Calculate effective CPU limit
QUOTA=$(cat $CGROUP_PATH/cpu.cfs_quota_us)
PERIOD=$(cat $CGROUP_PATH/cpu.cfs_period_us)
echo "Effective CPU limit: $(echo "scale=2; $QUOTA / $PERIOD" | bc) CPUs"

# View CPU usage stats
cat $CGROUP_PATH/cpu.stat
# nr_periods       1000
# nr_throttled     42
# throttled_time   4200000000   # nanoseconds spent throttled
```

### cgroup v2 Controls

```bash
# cgroup v2 (unified hierarchy - used in newer kernels/distributions)
CGROUP_V2="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/..."

# cpu.max format: quota period
cat $CGROUP_V2/cpu.max
# 200000 100000  = 200ms quota per 100ms period = 2 CPUs

# CPU stats
cat $CGROUP_V2/cpu.stat
# usage_usec          15234561
# user_usec           12000000
# system_usec         3234561
# nr_periods          1000
# nr_throttled        42
# throttled_usec      4200000   # Microseconds throttled
# nr_bursts           0
# burst_usec          0

# Set quota (100ms per 100ms = 1 CPU)
echo "100000 100000" > $CGROUP_V2/cpu.max

# Unlimited
echo "max 100000" > $CGROUP_V2/cpu.max
```

### Kubernetes Translates to cgroup Settings

```yaml
resources:
  requests:
    cpu: "500m"    # 0.5 CPU - used for scheduling
  limits:
    cpu: "1000m"   # 1 CPU - translates to cfs_quota_us
```

The kubelet sets:
- `cpu.cfs_period_us = 100000` (100ms, fixed)
- `cpu.cfs_quota_us = 100000` (for 1000m limit: 1000m * 100ms / 1000 = 100ms)

For a 500m limit:
- `cpu.cfs_quota_us = 50000` (500m * 100ms / 1000 = 50ms)

## Section 2: Understanding Throttled_time

`throttled_time` is the key metric for diagnosing CPU constraint. It accumulates nanoseconds spent in throttled state.

### Calculating Throttle Percentage

```bash
#!/bin/bash
# cpu_throttle_check.sh - Check throttling for all containers on a node

CGROUP_BASE="/sys/fs/cgroup/cpu,cpuacct/kubepods"

find "$CGROUP_BASE" -name "cpu.stat" | while read statfile; do
    container_path=$(dirname "$statfile")
    container_id=$(basename "$container_path")

    nr_periods=$(grep "^nr_periods " "$statfile" | awk '{print $2}')
    nr_throttled=$(grep "^nr_throttled " "$statfile" | awk '{print $2}')
    throttled_time=$(grep "^throttled_time " "$statfile" | awk '{print $2}')

    if [ "$nr_periods" -gt "0" ] && [ "$nr_throttled" -gt "0" ]; then
        throttle_pct=$(echo "scale=2; $nr_throttled * 100 / $nr_periods" | bc)
        throttled_sec=$(echo "scale=3; $throttled_time / 1000000000" | bc)

        quota=$(cat "$container_path/cpu.cfs_quota_us")
        period=$(cat "$container_path/cpu.cfs_period_us")

        echo "Container: $container_id"
        echo "  CPU Limit: $(echo "scale=2; $quota / $period" | bc) CPUs ($quota/$period us)"
        echo "  Throttled: $nr_throttled/$nr_periods periods ($throttle_pct%)"
        echo "  Throttled Time: ${throttled_sec}s total"
        echo ""
    fi
done
```

### Real-Time Throttle Rate

```bash
# Monitor throttling in real time
watch -n1 'cat /sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod<uuid>/<id>/cpu.stat'

# Calculate rate of throttling (throttled periods per second)
for i in $(seq 5); do
    nr=$(grep nr_throttled /sys/fs/cgroup/.../cpu.stat | awk '{print $2}')
    echo "$(date +%T): nr_throttled=$nr"
    sleep 1
done
```

### Prometheus Metrics for Throttling

The `container_cpu_cfs_throttled_periods_total` and `container_cpu_cfs_periods_total` metrics from cAdvisor expose this data:

```promql
# Throttle ratio per container (last 5 minutes)
rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m])
/
rate(container_cpu_cfs_periods_total{container!=""}[5m])

# Containers with >25% throttling
(
  rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m])
  /
  rate(container_cpu_cfs_periods_total{container!=""}[5m])
) > 0.25

# Time spent throttled per container
rate(container_cpu_cfs_throttled_seconds_total{container!=""}[5m])
```

## Section 3: Burst Mode

Linux kernel 5.14 introduced CPU burst (also called cfs_burst). It allows cgroups to accumulate unused quota across periods and spend it later, handling brief spikes without throttling.

### How Burst Works

```
Without burst:
  Period 1: Used 60ms, limit 50ms → Throttled 10ms, 0ms unused
  Period 2: Used 60ms, limit 50ms → Throttled 10ms, 0ms unused

With burst (burst_budget = 50ms):
  Period 1: Used 40ms, limit 50ms → 0ms throttled, 10ms saved to burst bucket
  Period 2: Used 40ms, limit 50ms → 0ms throttled, 20ms in burst bucket
  Period 3: Used 70ms, limit 50ms → No throttle! Used 20ms from burst bucket
```

### Configuring Burst

```bash
# cgroup v1 burst (kernel 5.14+)
echo 10000 > /sys/fs/cgroup/cpu,cpuacct/.../cpu.cfs_burst_us
# 10000 = 10ms burst credit maximum

# cgroup v2 burst
# cpu.max.burst file
echo 10000 > /sys/fs/cgroup/.../cpu.max.burst
```

### Kubernetes CPU Burst via Alpha Feature Gate

As of Kubernetes 1.27, CPU burst is available as an alpha feature:

```yaml
# kubelet configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  CPUManagerPolicyAlphaOptions: true
# Enable burst via CPUManager policy option
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  full-pcpus-only: "true"
```

With standard cgroups, set burst via annotation (if your container runtime supports it):

```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    # Some container runtimes (containerd 1.7+) support burst via annotations
    cpu.alpha.kubernetes.io/burst: "100m"
spec:
  containers:
  - name: app
    resources:
      limits:
        cpu: "1000m"
```

### Manual Burst Configuration

For immediate use without waiting for Kubernetes support:

```bash
# Find container cgroup path
CONTAINER_ID=$(docker inspect --format '{{.Id}}' my-container)
CGROUP_PATH="/sys/fs/cgroup/cpu/docker/$CONTAINER_ID"

# Or for containerd:
# CGROUP_PATH="/sys/fs/cgroup/cpu,cpuacct/system.slice/containerd.service/kubepods/..."

# Set burst to 50% of quota (allow 50ms burst credit on 100ms quota)
QUOTA=$(cat $CGROUP_PATH/cpu.cfs_quota_us)
BURST=$(echo "$QUOTA / 2" | bc)
echo $BURST > $CGROUP_PATH/cpu.cfs_burst_us

echo "Set burst to: ${BURST}us on ${QUOTA}us quota"
```

## Section 4: Identifying Throttling with perf

### perf sched for Scheduler Analysis

```bash
# Install perf tools
sudo apt-get install -y linux-tools-$(uname -r) linux-tools-generic

# Record scheduler events for a container's PID namespace
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)

# Record for 10 seconds
sudo perf sched record -p $CONTAINER_PID -- sleep 10

# Analyze scheduling latency
sudo perf sched latency --sort max

# Output shows:
# Task      |   Runtime ms  | Switches | Average delay ms | Maximum delay ms |
# myapp     |   4500.000    |   2000   |     2.000        |    89.000        |
# ^^^^^^^^^^^                                                ^^^^^^^^^^^
# High max delay indicates throttling

# Histogram of scheduling delays
sudo perf sched timehist -p $CONTAINER_PID
```

### perf stat for CPU Utilization

```bash
# Measure actual CPU utilization vs wall time
sudo perf stat -p $CONTAINER_PID -- sleep 10

# Output:
#   10,000.000 msec task-clock       #  0.312 CPUs utilized
#   ...
# 0.312 CPUs utilized means the process wanted 0.312 CPUs over 10s
# If limit is 0.5 CPUs and actual is 0.312, no throttling
# If limit is 0.2 CPUs and actual is 0.312, serious throttling

# Measure throttling events directly (kernel tracepoints)
sudo perf stat -e sched:sched_stat_wait,sched:sched_stat_sleep \
  -p $CONTAINER_PID -- sleep 10
```

### Recording Throttle Events

```bash
# Record CFS throttle events
sudo perf record -e cgroup:cgroup_attach_task \
  -e sched:sched_process_wait \
  -a -g -- sleep 30

# Or use ftrace directly
echo 1 > /sys/kernel/debug/tracing/events/cgroup/cgroup_throttle_cfs/enable
cat /sys/kernel/debug/tracing/trace_pipe | grep cgroup_throttle
```

## Section 5: Identifying Throttling with eBPF

### bpftrace for CFS Throttle Events

```bash
# Trace when cgroup scheduler runs out of quota
sudo bpftrace -e '
tracepoint:cgroup:cgroup_throttle_cfs {
    printf("Throttled: cgroup=%s (%s)\n",
        str(args->path), comm);
    @throttles[str(args->path)] = count();
}
interval:s:10 {
    print(@throttles);
    clear(@throttles);
}'

# Trace scheduler wait time distribution
sudo bpftrace -e '
tracepoint:sched:sched_stat_wait {
    if (args->delay > 10000000) {  // >10ms wait
        printf("Long wait: %s pid=%d delay=%dms\n",
            args->comm, args->pid, args->delay/1000000);
    }
    @wait_ms = hist(args->delay / 1000000);
}
END { print(@wait_ms); }'
```

### eBPF Program for Throttle Detection

```c
// throttle_monitor.bpf.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

struct event {
    __u32 pid;
    __u64 duration_ns;
    char comm[16];
    char cgroup_name[64];
};

struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, __u64);
} throttle_start SEC(".maps");

SEC("tracepoint/cgroup/cgroup_throttle_cfs")
int trace_throttle_start(void *ctx)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&throttle_start, &pid, &ts, BPF_ANY);
    return 0;
}

SEC("tracepoint/cgroup/cgroup_unthrottle_cfs")
int trace_throttle_end(void *ctx)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u64 *start = bpf_map_lookup_elem(&throttle_start, &pid);
    if (!start) return 0;

    struct event e = {};
    e.pid = pid;
    e.duration_ns = bpf_ktime_get_ns() - *start;
    bpf_get_current_comm(&e.comm, sizeof(e.comm));

    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU,
                          &e, sizeof(e));
    bpf_map_delete_elem(&throttle_start, &pid);
    return 0;
}

char _license[] SEC("license") = "GPL";
```

### bcc-based Throttle Monitor

```python
#!/usr/bin/env python3
# throttle_monitor.py - Monitor CPU throttling with BCC

from bcc import BPF
import time
import sys

prog = """
#include <linux/sched.h>

struct data_t {
    u32 pid;
    u64 duration_ns;
    char comm[TASK_COMM_LEN];
};

BPF_PERF_OUTPUT(events);
BPF_HASH(throttle_start, u32, u64);

TRACEPOINT_PROBE(cgroup, cgroup_throttle_cfs) {
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    u64 ts = bpf_ktime_get_ns();
    throttle_start.update(&pid, &ts);
    return 0;
}

TRACEPOINT_PROBE(cgroup, cgroup_unthrottle_cfs) {
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    u64 *start = throttle_start.lookup(&pid);
    if (!start) return 0;

    struct data_t data = {};
    data.pid = pid;
    data.duration_ns = bpf_ktime_get_ns() - *start;
    bpf_get_current_comm(&data.comm, sizeof(data.comm));

    events.perf_submit(args, &data, sizeof(data));
    throttle_start.delete(&pid);
    return 0;
}
"""

b = BPF(text=prog)
print("Monitoring CPU throttle events (Ctrl-C to stop)...")
print(f"{'PID':<8} {'COMM':<20} {'THROTTLE MS':<15}")

def process_event(cpu, data, size):
    event = b["events"].event(data)
    duration_ms = event.duration_ns / 1_000_000
    if duration_ms > 1:  # Only show throttles > 1ms
        print(f"{event.pid:<8} {event.comm.decode():<20} {duration_ms:<15.2f}")

b["events"].open_perf_buffer(process_event)

try:
    while True:
        b.perf_buffer_poll()
except KeyboardInterrupt:
    pass
```

```bash
# Run the monitor
sudo python3 throttle_monitor.py
```

## Section 6: Kubernetes CPU Limits Tuning

### The Case Against CPU Limits

For many latency-sensitive workloads, removing CPU limits entirely (while keeping requests) reduces P99 latency significantly. Requests ensure the scheduler allocates CPU correctly; limits only add throttling risk.

```yaml
# Pattern: requests without limits (use only when the node is dedicated)
resources:
  requests:
    cpu: "500m"
  # No limits: process can burst to use available CPU
  # Risk: noisy neighbors on shared nodes
```

### Right-Sizing CPU Limits

```bash
#!/bin/bash
# right_size_cpu.sh - Recommend CPU limit based on actual usage

NAMESPACE="production"
LOOKBACK="7d"

echo "Analyzing CPU usage for namespace: $NAMESPACE"
echo ""

# Query Prometheus for actual CPU usage (p99 over 7 days)
kubectl exec -n monitoring prometheus-0 -- promtool query instant \
  "quantile_over_time(0.99,
    rate(container_cpu_usage_seconds_total{
      namespace=\"$NAMESPACE\",container!=\"\",container!=\"POD\"
    }[5m])[$LOOKBACK:5m]
  )" 2>/dev/null | grep -v "^#" | while read line; do
    container=$(echo $line | grep -oP 'container="\K[^"]+')
    current_limit=$(kubectl get pod -n $NAMESPACE \
      -o jsonpath="{.spec.containers[?(@.name==\"$container\")].resources.limits.cpu}" 2>/dev/null)
    p99_usage=$(echo $line | grep -oP 'value="\K[^"]+')

    echo "Container: $container"
    echo "  Current limit: $current_limit"
    echo "  P99 usage: $(echo "scale=3; $p99_usage * 1000" | bc)m"
    echo "  Recommended: $(echo "scale=0; $p99_usage * 1000 * 1.2 / 1" | bc)m (P99 + 20% headroom)"
    echo ""
done
```

### Per-Namespace CPU Quota

Use LimitRange and ResourceQuota for namespace-level control:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-defaults
  namespace: production
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"       # Default limit if none specified
    defaultRequest:
      cpu: "100m"       # Default request if none specified
    max:
      cpu: "4000m"      # Maximum limit allowed
    min:
      cpu: "50m"        # Minimum request required
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: cpu-quota
  namespace: production
spec:
  hard:
    # Total CPU requests in this namespace
    requests.cpu: "50"
    # Total CPU limits in this namespace
    limits.cpu: "100"
```

### Dynamic CPU Limit Adjustment

Vertical Pod Autoscaler (VPA) can automatically adjust CPU requests and limits based on observed usage:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Auto"  # Off | Initial | Recreate | Auto
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 2Gi
      controlledResources: ["cpu", "memory"]
      # Don't auto-adjust requests below recommended
      controlledValues: RequestsAndLimits
```

### Changing the CFS Period

The default 100ms period is too coarse for some workloads. A shorter period reduces the size of throttle bursts:

```bash
# kubelet configuration to change default CFS period
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuCFSQuotaPeriod: "10ms"  # Default: 100ms
```

Changing to 10ms means:
- 1000m CPU limit → 10ms quota per 10ms period (same ratio)
- A brief spike can only consume 10ms before throttling (not 100ms)
- Throttling is more frequent but much shorter in duration

This trades fewer large throttle events for many small ones, which often improves P99 latency:

```bash
# Apply kubelet config change
# 1. Update kubelet config on each node
sudo sed -i 's/cpuCFSQuotaPeriod:.*/cpuCFSQuotaPeriod: "10ms"/' \
  /etc/kubernetes/kubelet-config.yaml

# 2. Restart kubelet
sudo systemctl restart kubelet

# 3. Verify new period
cat /sys/fs/cgroup/cpu,cpuacct/kubepods/.../cpu.cfs_period_us
# Should show: 10000 (10ms)
```

## Section 7: Practical Investigation Workflow

### Step-by-Step Throttle Investigation

```bash
#!/bin/bash
# investigate_throttling.sh - Complete throttle investigation for a pod

POD_NAME=$1
NAMESPACE=${2:-default}

echo "=== CPU Throttle Investigation: $POD_NAME ==="
echo ""

# 1. Get pod's container IDs
echo "--- Pod Info ---"
kubectl describe pod "$POD_NAME" -n "$NAMESPACE" | grep -A5 "Limits\|Requests\|Container ID"

# 2. Find cgroup path
CONTAINER_ID=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's|containerd://||' | cut -c1-12)

echo ""
echo "--- cgroup Stats ---"
find /sys/fs/cgroup -name "cpu.stat" | xargs grep -l "" 2>/dev/null | \
  while read f; do
    if [[ "$f" == *"$CONTAINER_ID"* ]]; then
      echo "Found: $f"
      cat "$f"
      echo "cpu.cfs_quota_us: $(cat $(dirname $f)/cpu.cfs_quota_us)"
      echo "cpu.cfs_period_us: $(cat $(dirname $f)/cpu.cfs_period_us)"
    fi
  done

# 3. Current node CPU pressure
echo ""
echo "--- Node CPU Usage ---"
top -bn1 | head -5

# 4. Last 5 minutes of CPU metrics from prometheus
echo ""
echo "--- Prometheus Throttle Rate ---"
echo "Run this PromQL query:"
echo "  rate(container_cpu_cfs_throttled_periods_total{pod=\"$POD_NAME\",namespace=\"$NAMESPACE\"}[5m])"
echo "  /"
echo "  rate(container_cpu_cfs_periods_total{pod=\"$POD_NAME\",namespace=\"$NAMESPACE\"}[5m])"
```

CPU throttling is a subtle but significant source of latency in containerized systems. The key insight is that a container can be throttled even when the node has CPU headroom — the quota mechanism enforces instantaneous limits, not time-averaged limits. Measuring throttled_time, understanding burst mechanics, and right-sizing CPU limits based on actual P99 usage (not theoretical peak) are the tools for eliminating unnecessary throttling from production Kubernetes workloads.
