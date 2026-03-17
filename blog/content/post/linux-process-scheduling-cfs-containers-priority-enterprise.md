---
title: "Linux Process Scheduling: CFS, Real-Time Classes, and Container CPU Priorities"
date: 2029-02-20T00:00:00-05:00
draft: false
tags: ["Linux", "Scheduling", "CFS", "cgroups", "Containers", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise deep dive into Linux process scheduling — CFS internals, real-time scheduling classes, cgroup CPU bandwidth control, and practical configuration for containerized workloads in Kubernetes environments."
more_link: "yes"
url: "/linux-process-scheduling-cfs-containers-priority-enterprise/"
---

CPU scheduling is the mechanism by which the Linux kernel arbitrates access to processor time among competing processes and threads. For most workloads, the default Completely Fair Scheduler operates invisibly — processes get adequate CPU time and everything works. But under contention, when multiple high-priority workloads compete for limited CPU cycles, the scheduling policy becomes the difference between sub-millisecond response times and multi-second latency spikes.

This guide examines Linux scheduling from the kernel perspective, traces how cgroup CPU controls translate scheduler policy into Kubernetes resource limits, and provides concrete configuration guidance for latency-sensitive production workloads.

<!--more-->

## The Completely Fair Scheduler: Internals

CFS was introduced in Linux 2.6.23 and remains the default scheduler for normal processes. Its core abstraction is virtual runtime (`vruntime`) — a measure of how much CPU time a process has consumed, weighted by its scheduling priority. CFS maintains a red-black tree of runnable processes sorted by `vruntime`. The scheduler always picks the leftmost node — the process with the smallest `vruntime`, meaning it has received the least CPU time relative to its priority weight.

The key insight: CFS does not attempt to give each process exactly equal time slices. Instead, it gives each process proportional CPU time over a configurable period called the `sched_latency`. Within each period, every runnable process gets at least one time slice.

```bash
# View CFS scheduler configuration.
cat /proc/sys/kernel/sched_latency_ns          # Default: 6000000 (6ms)
cat /proc/sys/kernel/sched_min_granularity_ns  # Default: 750000 (0.75ms)
cat /proc/sys/kernel/sched_wakeup_granularity_ns  # Default: 1000000 (1ms)

# View the vruntime of processes in a cgroup.
# The 'nr_running' field shows runnable tasks; 'load.weight' is the CFS weight.
cat /sys/fs/cgroup/cpu/kubepods/pod4a8e0b62-3c9f-4d71-a7c2-8e1f0d3b9e4c/cpu.stat

# Inspect per-CPU run queue lengths and scheduling statistics.
cat /proc/schedstat

# View per-process scheduling statistics.
# Fields: nr_switches, nr_voluntary_switches, nr_involuntary_switches
awk 'NR==1 || /^ctxt/ || /^processes/' /proc/$(pgrep -n nginx)/status
```

### Nice Values and CPU Weight

Nice values map to CFS weights through a piecewise linear function defined in `kernel/sched/core.c`. A process at nice 0 has weight 1024. Each step of 1 in nice value changes weight by approximately 1.25x.

```bash
# Set nice value at launch.
nice -n 10 /usr/bin/my-batch-job --config /etc/batch/config.yaml

# Renice a running process.
renice -n -5 -p 15432  # Increase priority (requires CAP_SYS_NICE for negative values)

# View current nice value.
ps -o pid,ni,comm -p 15432

# View the weight assigned to a cgroup (Kubernetes-managed).
# Weight range: 1-10000, default 100 (maps to nice 0).
cat /sys/fs/cgroup/cpu/kubepods/burstable/pod4a8e0b62/app-container/cpu.weight
```

The mapping from Kubernetes CPU requests to cgroup `cpu.weight` (cgroups v2) or `cpu.shares` (cgroups v1) is linear:

- `cpu.shares` (v1): `requests_millicores / 1000 * 1024`, minimum 2
- `cpu.weight` (v2): `1 + ((requests_millicores - 1) * 9999) / 99999`

A container with 500m CPU request gets `cpu.shares = 512` on cgroups v1 — exactly half the weight of a container requesting 1000m.

## CPU Bandwidth Control: Throttling vs. Weights

CPU weights (shares) only matter under contention. When CPUs are idle, any container can burst to full utilization regardless of its request. CPU limits, by contrast, enforce hard bandwidth caps through the CFS bandwidth controller.

```bash
# CFS bandwidth controller parameters for a cgroup.
# quota: microseconds of CPU time allowed per period.
# period: the measurement period in microseconds (default: 100ms).
# A quota of 50000 with period 100000 limits the cgroup to 0.5 CPUs.

cat /sys/fs/cgroup/cpu/kubepods/burstable/pod4a8e0b62/app-container/cpu.cfs_quota_us
cat /sys/fs/cgroup/cpu/kubepods/burstable/pod4a8e0b62/app-container/cpu.cfs_period_us

# View throttling statistics — a critical production metric.
# throttled_time: total nanoseconds the cgroup was throttled.
# throttled_usec: same in microseconds (cgroups v2).
cat /sys/fs/cgroup/cpu/kubepods/burstable/pod4a8e0b62/app-container/cpu.stat
# Output example:
# nr_periods 12453
# nr_throttled 847
# throttled_time 4230982000
# nr_bursts 0
# burst_time 0
```

The `throttled_time` field is the most important metric for diagnosing CPU-throttling-induced latency. A container with significant `nr_throttled` counts is experiencing CPU throttling, which manifests as increased tail latency even when the container's average CPU utilization appears low.

```bash
# Monitor CPU throttling across all containers in a namespace.
for pod in $(kubectl get pods -n production -o name | sed 's|pod/||'); do
  container=$(kubectl get pod -n production "$pod" \
    -o jsonpath='{.spec.containers[0].name}')
  node=$(kubectl get pod -n production "$pod" \
    -o jsonpath='{.spec.nodeName}')
  echo "Pod: $pod  Container: $container  Node: $node"
  kubectl exec -n production "$pod" -- \
    cat /sys/fs/cgroup/cpu/cpu.stat 2>/dev/null | grep throttled
  echo "---"
done
```

### Configuring CPU Limits in Kubernetes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-api
  namespace: production
spec:
  containers:
  - name: api-server
    image: registry.example.com/api-server:v3.14.2
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        # Setting limits equal to requests makes this container Guaranteed QoS,
        # which gets elevated scheduling priority and is not subject to CPU throttling
        # caused by other containers on the same node.
        cpu: "2"
        memory: "4Gi"
    env:
    - name: GOMAXPROCS
      valueFrom:
        resourceFieldRef:
          resource: limits.cpu
```

The Guaranteed QoS class (requests == limits) ensures the kubelet pins containers to specific CPUs via cpuManager when the static CPU policy is enabled, eliminating cache thrash from CPU migration.

## Real-Time Scheduling Classes

Linux provides three scheduling policies above CFS: `SCHED_FIFO`, `SCHED_RR`, and `SCHED_DEADLINE`. These are for workloads with strict latency requirements — audio processing, industrial control systems, latency-sensitive networking.

```bash
# View the scheduling policy and priority of a process.
chrt -p $(pgrep -n my-rt-process)
# Output: pid X's current scheduling policy: SCHED_OTHER (CFS)
# pid X's current scheduling priority: 0

# Set a process to SCHED_FIFO with priority 50.
# Requires CAP_SYS_NICE or root.
chrt -f -p 50 $(pgrep -n latency-daemon)

# Set a process to SCHED_RR with priority 10.
chrt -r -p 10 $(pgrep -n audio-processor)

# SCHED_DEADLINE: specify runtime, deadline, and period in nanoseconds.
# This process gets 5ms of CPU every 10ms.
chrt --deadline --sched-runtime 5000000 --sched-deadline 10000000 \
     --sched-period 10000000 -p 0 $(pgrep -n network-daemon)

# Verify the assignment.
chrt -p $(pgrep -n network-daemon)
# pid X's current scheduling policy: SCHED_DEADLINE
```

Real-time processes run ahead of all CFS processes. A runaway `SCHED_FIFO` process with no blocking I/O will starve the entire system. The `sched_rt_runtime_us` / `sched_rt_period_us` knobs limit the fraction of CPU time the RT class can consume system-wide.

```bash
# Limit real-time processes to 95% of CPU time (default is 95%).
# This ensures CFS processes get at least 5%, preventing system lockup.
echo 950000 > /proc/sys/kernel/sched_rt_runtime_us   # 950ms
echo 1000000 > /proc/sys/kernel/sched_rt_period_us   # 1000ms = 1s period

# Verify system-wide RT throttling limits.
cat /proc/sys/kernel/sched_rt_runtime_us
cat /proc/sys/kernel/sched_rt_period_us
```

## CPU Affinity and NUMA Topology

CPU affinity pins processes to specific CPUs, preventing cache invalidation from core migrations and enabling NUMA-aware placement.

```bash
# Pin process to CPUs 0-3 and 8-11 (two physical cores with hyperthreading).
taskset -pc 0-3,8-11 $(pgrep -n database-server)

# Launch a new process with CPU affinity.
taskset -c 4-7 /usr/bin/analytics-worker --threads 4

# View NUMA topology.
numactl --hardware

# Run a process on NUMA node 0 with memory local to that node.
numactl --cpunodebind=0 --membind=0 /usr/bin/high-perf-server

# View the NUMA affinity of a running process.
cat /proc/$(pgrep -n server)/status | grep -E 'Cpus_allowed|Mems_allowed'
```

In Kubernetes, the CPU Manager static policy automates CPU pinning for Guaranteed QoS pods:

```yaml
# kubelet configuration enabling CPU Manager static policy.
# Apply to the node's kubelet config, not to a Pod spec.
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 10s
topologyManagerPolicy: best-effort
topologyManagerScope: container
reservedSystemCPUs: "0,1"  # Reserve cores 0-1 for system processes.
kubeReserved:
  cpu: "500m"
  memory: "512Mi"
systemReserved:
  cpu: "500m"
  memory: "512Mi"
```

## cgroup v2: Unified Hierarchy

cgroups v2 introduces a unified hierarchy and improved CPU controller semantics. The weight-based model replaces the `cpu.shares` integer with `cpu.weight` (range 1-10000).

```bash
# Verify cgroups v2 is in use.
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# View cgroup v2 CPU controller state for a pod.
CGROUP_PATH=$(cat /proc/$(pgrep -n my-app)/cgroup | grep '^0::' | cut -d: -f3)
echo "Cgroup path: ${CGROUP_PATH}"

cat "/sys/fs/cgroup${CGROUP_PATH}/cpu.weight"
cat "/sys/fs/cgroup${CGROUP_PATH}/cpu.max"      # Format: quota period
cat "/sys/fs/cgroup${CGROUP_PATH}/cpu.stat"

# cpu.max format: "max 100000" means unlimited; "50000 100000" means 0.5 CPU.
# Equivalent to the old cfs_quota_us / cfs_period_us in cgroups v1.
echo "100000 100000" > /sys/fs/cgroup/mygroup/cpu.max  # 1 CPU limit
echo "max 100000" > /sys/fs/cgroup/mygroup/cpu.max     # No limit
```

## Diagnosing Scheduling Problems

```bash
# perf sched: comprehensive scheduling analysis.
# Record 10 seconds of scheduling events.
perf sched record -g -a -- sleep 10

# Analyze scheduling latency — shows maximum time processes waited on runqueue.
perf sched latency | head -40

# Replay scheduling trace to identify bottlenecks.
perf sched replay

# bpftrace: trace CFS scheduler events in real time.
bpftrace -e '
tracepoint:sched:sched_switch {
    if (args->prev_state == 0 && args->prev_comm != "swapper/0") {
        @runtime[args->prev_comm, args->prev_pid] =
            hist((nsecs - @start[args->prev_pid]) / 1000);
    }
    @start[args->next_pid] = nsecs;
}
END { clear(@start); }
'

# Identify processes with high involuntary context switches.
# High inv_ctxt_switches indicates the process is being preempted by higher-priority work.
ps -eo pid,comm,min_flt,maj_flt,vsz,rss --sort=-vsz | head -20
cat /proc/$(pgrep -n my-service)/status | grep -i ctxt

# trace-cmd: kernel scheduler tracing.
trace-cmd record -e sched:sched_switch -e sched:sched_wakeup \
  -p function_graph -- sleep 5
trace-cmd report | grep -v swapper | head -100
```

## Kubernetes Node-Level Scheduler Tuning

```bash
# Increase sched_latency for high-throughput batch nodes.
# Larger latency period means longer time slices, less context switching overhead.
sysctl -w kernel.sched_latency_ns=24000000     # 24ms
sysctl -w kernel.sched_min_granularity_ns=3000000  # 3ms

# For latency-sensitive nodes, decrease latency to get faster preemption.
sysctl -w kernel.sched_latency_ns=4000000      # 4ms
sysctl -w kernel.sched_min_granularity_ns=500000   # 0.5ms

# Disable CPU frequency scaling on latency-sensitive nodes.
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "$cpu"
done

# Verify the governor change.
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# Enable IRQ affinity to pin network interrupts away from application CPUs.
# This prevents network IRQ storms from impacting application scheduling.
echo 3 > /proc/irq/$(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':')/smp_affinity
```

## Production Monitoring for Scheduling Issues

```yaml
# Prometheus recording rules for CPU scheduling observability.
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cpu-scheduling-alerts
  namespace: monitoring
spec:
  groups:
  - name: cpu-throttling
    interval: 30s
    rules:
    - alert: ContainerCPUThrottlingHigh
      expr: |
        (
          rate(container_cpu_cfs_throttled_periods_total{
            container!="",
            namespace=~"production|staging"
          }[5m])
          /
          rate(container_cpu_cfs_periods_total{
            container!="",
            namespace=~"production|staging"
          }[5m])
        ) > 0.25
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} is CPU throttled {{ $value | humanizePercentage }}"
        description: "More than 25% of CPU scheduling periods are being throttled. Consider increasing CPU limits or optimizing the application."

    - alert: ContainerCPUThrottlingCritical
      expr: |
        (
          rate(container_cpu_cfs_throttled_periods_total{
            container!="",
            namespace="production"
          }[5m])
          /
          rate(container_cpu_cfs_periods_total{
            container!="",
            namespace="production"
          }[5m])
        ) > 0.5
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Critical CPU throttling on {{ $labels.container }}"
```

Understanding the Linux CPU scheduler at this depth allows infrastructure teams to make informed decisions about container resource configuration, node topology, and scheduling policy — decisions that directly determine whether latency-sensitive workloads meet their SLOs under production load.
