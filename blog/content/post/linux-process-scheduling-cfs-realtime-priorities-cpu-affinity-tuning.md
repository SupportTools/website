---
title: "Linux Process Scheduling: CFS, Real-Time Priorities, and CPU Affinity Tuning"
date: 2030-07-25T00:00:00-05:00
draft: false
tags: ["Linux", "Scheduling", "CFS", "Real-Time", "CPU Affinity", "Kubernetes", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Linux scheduler deep dive covering CFS vruntime and scheduler latency, SCHED_FIFO and SCHED_RR for latency-sensitive workloads, taskset CPU pinning, cgroup CPU scheduling, and tuning scheduler parameters for Kubernetes node performance."
more_link: "yes"
url: "/linux-process-scheduling-cfs-realtime-priorities-cpu-affinity-tuning/"
---

The Linux process scheduler is one of the most consequential subsystems for production workload performance, yet it is frequently treated as a black box. Understanding how the Completely Fair Scheduler (CFS) allocates CPU time, how real-time scheduling policies bypass CFS, and how CPU affinity and cgroup controls interact with the scheduler provides the foundation for eliminating latency variability in production systems and Kubernetes node tuning.

<!--more-->

## The Completely Fair Scheduler (CFS)

CFS was introduced in Linux 2.6.23 (2007) and remains the default scheduling class for normal processes. It aims to give every runnable process a fair share of CPU time, implemented through a red-black tree sorted by virtual runtime.

### Virtual Runtime (vruntime)

Every process in CFS has a `vruntime` — a monotonically increasing counter representing how much CPU time the process has consumed, weighted by priority. The scheduler always picks the process with the smallest `vruntime`:

```
vruntime += actual_runtime * (NICE_0_LOAD / process_weight)
```

Higher-priority (lower-nice) processes have a larger `process_weight`, so their `vruntime` increases more slowly, causing them to be selected more frequently:

```bash
# Nice values and corresponding CFS weights
# Nice -20: weight 88761
# Nice   0: weight 1024  (NICE_0_LOAD)
# Nice +19: weight 15

# View process priority and nice value
ps -eo pid,ni,pri,rtprio,cls,comm | head -20

# View scheduler statistics for a process
cat /proc/$(pgrep -f myapp)/sched
```

### CFS Scheduler Parameters

Key tunable parameters are exposed via `/proc/sys/kernel/sched_*`:

```bash
# Minimum time a process is scheduled to run before being preempted (ns)
# Default: 750000 (750 microseconds)
cat /proc/sys/kernel/sched_min_granularity_ns
echo 1000000 > /proc/sys/kernel/sched_min_granularity_ns

# Target scheduling latency: how often every process should run (ns)
# Default: 6000000 (6 milliseconds)
cat /proc/sys/kernel/sched_latency_ns
echo 4000000 > /proc/sys/kernel/sched_latency_ns

# Wakeup granularity: threshold for preempting current task on wakeup (ns)
# Larger values reduce wakeup preemption, improving throughput at cost of latency
# Default: 1000000 (1 millisecond)
cat /proc/sys/kernel/sched_wakeup_granularity_ns
echo 2000000 > /proc/sys/kernel/sched_wakeup_granularity_ns

# Migration cost for NUMA awareness (ns)
cat /proc/sys/kernel/sched_migration_cost_ns
echo 5000000 > /proc/sys/kernel/sched_migration_cost_ns
```

Setting these parameters persistently via sysctl:

```ini
# /etc/sysctl.d/99-scheduler.conf

# Reduce scheduling latency for interactive/latency-sensitive workloads
kernel.sched_min_granularity_ns = 1000000
kernel.sched_latency_ns = 4000000
kernel.sched_wakeup_granularity_ns = 500000

# For throughput-focused workloads (batch processing)
# kernel.sched_min_granularity_ns = 4000000
# kernel.sched_latency_ns = 20000000
```

### Scheduler Latency Measurement

Understanding actual scheduling latency requires tracing tools:

```bash
# Measure scheduling latency with perf sched
perf sched record -g -- sleep 5
perf sched latency --sort max

# Output example:
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms
# ----------------------|---------------|----------|------------------|------------------
# myapp:(1)             |      2345.123 |     4521 |            0.012 |            1.823

# Measure wakeup latency with BPF
# Install bpfcc-tools or bcc
runqlat 1 5

# Sample output:
# usecs               : count     distribution
# 0 -> 1              : 1043     |********************|
# 2 -> 3              : 521      |**********          |
# 4 -> 7              : 89       |*                   |
# 8 -> 15             : 12       |                    |
# 16 -> 31            : 3        |                    |

# Run queue length over time
runqlen 1 5
```

## Real-Time Scheduling Policies

When CFS latency is insufficient, Linux provides real-time scheduling classes that preempt normal processes. Real-time processes are always preferred over CFS processes.

### SCHED_FIFO and SCHED_RR

`SCHED_FIFO` (First In, First Out): A `SCHED_FIFO` process runs until it voluntarily yields, blocks, or is preempted by a higher-priority real-time process. There is no time slice.

`SCHED_RR` (Round Robin): Like `SCHED_FIFO` but with a time slice. When the time slice expires, the process goes to the back of its priority queue.

Real-time priorities range from 1 (lowest) to 99 (highest):

```bash
# Set a process to SCHED_FIFO with priority 50
chrt -f -p 50 $(pgrep -f myapp)

# Set a process to SCHED_RR with priority 40
chrt -r -p 40 $(pgrep -f myapp)

# View current scheduling policy for a process
chrt -p $(pgrep -f myapp)

# Launch a process with real-time scheduling
chrt -f 60 /usr/bin/mylatency-sensitive-app

# View real-time time slice (for SCHED_RR)
cat /proc/sys/kernel/sched_rr_timeslice_ms
```

### SCHED_DEADLINE

`SCHED_DEADLINE` is the highest-priority scheduling class, designed for hard real-time tasks. It implements the EDF (Earliest Deadline First) algorithm:

```bash
# Set SCHED_DEADLINE with runtime=5ms, deadline=10ms, period=20ms
chrt -d --sched-runtime 5000000 --sched-deadline 10000000 --sched-period 20000000 0 myapp

# The scheduler guarantees the task gets 5ms CPU time every 20ms
# and will complete within 10ms of its period start
```

`SCHED_DEADLINE` requires admission control — the kernel rejects settings that would overcommit CPU bandwidth.

### Real-Time Throttling

To prevent a runaway real-time process from starving the system:

```bash
# RT processes can use at most 95% of each 1-second period
# Default: rt_runtime=950000us, rt_period=1000000us
cat /proc/sys/kernel/sched_rt_runtime_us
cat /proc/sys/kernel/sched_rt_period_us

# Disable RT throttling (use with extreme caution)
# Only on systems where RT processes are fully trusted
echo -1 > /proc/sys/kernel/sched_rt_runtime_us

# Persistent configuration
echo "kernel.sched_rt_runtime_us = 950000" >> /etc/sysctl.d/99-scheduler.conf
```

### Capabilities Required for Real-Time Scheduling

Setting real-time priorities requires `CAP_SYS_NICE`. In container environments:

```yaml
# Kubernetes pod spec for RT-capable container
apiVersion: v1
kind: Pod
metadata:
  name: rt-workload
spec:
  containers:
    - name: app
      image: myapp:latest
      securityContext:
        capabilities:
          add:
            - SYS_NICE
      resources:
        limits:
          cpu: "2"
          memory: "512Mi"
```

## CPU Affinity with taskset

CPU affinity binds a process or thread to specific CPU cores, reducing cache invalidation and NUMA effects.

### Basic taskset Usage

```bash
# Pin process to CPU 0 only
taskset -cp 0 $(pgrep -f myapp)

# Pin process to CPUs 0-3
taskset -cp 0-3 $(pgrep -f myapp)

# Pin process to CPUs 0,2,4,6 (even cores)
taskset -cp 0,2,4,6 $(pgrep -f myapp)

# Launch with affinity
taskset -c 4-7 myapp

# View current affinity mask
taskset -p $(pgrep -f myapp)

# Set affinity for a specific thread (TID)
taskset -cp 2 $(cat /proc/$(pgrep -f myapp)/task/*/tid | head -1)
```

### CPU Affinity via /proc

```bash
# Read affinity mask in hex
cat /proc/$(pgrep -f myapp)/status | grep Cpus_allowed

# List per-thread affinity
for tid in $(ls /proc/$(pgrep -f myapp)/task/); do
    echo -n "TID $tid: "
    taskset -p $tid 2>/dev/null | awk '{print $NF}'
done
```

### Setting Affinity Programmatically

```c
// C example: pin calling thread to CPU 0 and 1
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>

int pin_to_cpus(int *cpus, int ncpus) {
    cpu_set_t mask;
    CPU_ZERO(&mask);
    for (int i = 0; i < ncpus; i++) {
        CPU_SET(cpus[i], &mask);
    }
    return sched_setaffinity(0, sizeof(mask), &mask);
}
```

In Go:

```go
package main

import (
    "golang.org/x/sys/unix"
    "fmt"
    "runtime"
)

func pinToCore(core int) error {
    // Lock to OS thread so affinity applies to this goroutine's thread
    runtime.LockOSThread()

    var cpuSet unix.CPUSet
    cpuSet.Set(core)
    return unix.SchedSetaffinity(0, &cpuSet)
}

func main() {
    if err := pinToCore(2); err != nil {
        fmt.Printf("failed to pin: %v\n", err)
        return
    }
    fmt.Printf("pinned to core 2\n")
    // CPU-intensive work here runs on core 2
}
```

## NUMA Topology and Scheduling

On multi-socket systems, NUMA topology critically affects scheduling performance.

### Inspecting NUMA Topology

```bash
# View NUMA topology
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7
# node 0 size: 32768 MB
# node 1 cpus: 8 9 10 11 12 13 14 15
# node 1 size: 32768 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# View NUMA stats for a process
numastat -p $(pgrep -f myapp)

# Launch process bound to NUMA node 0
numactl --cpunodebind=0 --membind=0 myapp
```

### NUMA-Aware CPU Affinity

```bash
# Pin to all CPUs on NUMA node 0
numactl --cpunodebind=0 taskset -c 0-7 myapp

# Identify which CPUs share L3 cache
lscpu --extended | grep -E "CPU|SOCKET|CACHE"

# For a 2-socket, 8-core-per-socket system:
# Socket 0: CPUs 0-7
# Socket 1: CPUs 8-15
# Pin latency-sensitive app to one socket
taskset -c 0-7 myapp
```

## cgroup CPU Scheduling

cgroups v1 and v2 provide CPU scheduling controls used by both systemd and Kubernetes.

### cgroup v2 CPU Controls

```bash
# View cgroup v2 CPU stats
cat /sys/fs/cgroup/system.slice/kubelet.service/cpu.stat

# Set CPU weight (replaces cgroup v1 cpu.shares)
# Range: 1-10000, default: 100
echo 200 > /sys/fs/cgroup/myapp/cpu.weight

# Set CPU bandwidth (hard limit)
# cpu.max format: "quota period" in microseconds
# Allow 50ms of CPU time per 100ms period (50% of one CPU)
echo "50000 100000" > /sys/fs/cgroup/myapp/cpu.max

# Allow 200ms per 100ms period (2 CPUs worth)
echo "200000 100000" > /sys/fs/cgroup/myapp/cpu.max

# Disable CPU bandwidth limit (unlimited)
echo "max 100000" > /sys/fs/cgroup/myapp/cpu.max

# View CPU pressure
cat /sys/fs/cgroup/myapp/cpu.pressure
```

### cgroup v1 CPU Controls

```bash
# cpu.shares: relative weight (default 1024)
echo 2048 > /sys/fs/cgroup/cpu/myapp/cpu.shares

# cpu.cfs_quota_us and cpu.cfs_period_us: hard limit
# Allow 2 CPUs worth: 200ms per 100ms period
echo 100000 > /sys/fs/cgroup/cpu/myapp/cpu.cfs_period_us
echo 200000 > /sys/fs/cgroup/cpu/myapp/cpu.cfs_quota_us

# cpuset: restrict to specific CPUs and NUMA nodes
echo "0-3" > /sys/fs/cgroup/cpuset/myapp/cpuset.cpus
echo "0" > /sys/fs/cgroup/cpuset/myapp/cpuset.mems

# Move process into cpuset cgroup
echo $(pgrep -f myapp) > /sys/fs/cgroup/cpuset/myapp/tasks
```

## Kubernetes Node Scheduler Tuning

Kubernetes translates container resource requests/limits into cgroup controls. Understanding this mapping is essential for node-level performance tuning.

### CPU Request and Limit Translation

```yaml
# Container with 500m CPU request and 2 CPU limit
resources:
  requests:
    cpu: "500m"
  limits:
    cpu: "2"
```

This translates to:
- `cpu.shares = 512` (500m / 1000m * 1024, cgroup v1)
- `cpu.cfs_quota_us = 200000` (2 CPUs * 100ms period)
- `cpu.cfs_period_us = 100000`

### CPU Manager Policy

Kubernetes CPU Manager enables exclusive CPU allocation for Guaranteed QoS pods:

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 10s
reservedSystemCPUs: "0,1"  # Reserve cores 0 and 1 for system processes
```

With `static` CPU Manager policy, Guaranteed QoS pods with integer CPU requests get exclusive CPU cores:

```yaml
# Pod that will receive exclusive CPUs with static CPU manager policy
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-app
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          cpu: "4"        # Must be integer for exclusive assignment
          memory: "4Gi"
        limits:
          cpu: "4"        # Must equal requests for Guaranteed QoS
          memory: "4Gi"
```

Checking CPU Manager state:

```bash
# View allocated CPUs per container
cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool

# View which CPUs are reserved/available
kubectl describe node $(hostname) | grep -A5 "Allocatable"
```

### Topology Manager Policy

The Topology Manager ensures CPU, memory, and device locality:

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: single-numa-node
topologyManagerScope: pod
cpuManagerPolicy: static
```

Topology Manager policies:
- `none`: Default, no topology alignment
- `best-effort`: Attempt alignment but allow failures
- `restricted`: Require alignment for Hint Providers
- `single-numa-node`: Require all resources from single NUMA node

### IRQ Balancing and CPU Isolation

For maximum CPU isolation on latency-sensitive nodes:

```bash
# Isolate CPUs 4-15 from the scheduler and IRQ balancing
# Add to kernel command line in GRUB:
# isolcpus=4-15 nohz_full=4-15 rcu_nocbs=4-15

# Verify isolation
cat /sys/devices/system/cpu/isolated
# Expected: 4-15

# Move IRQs off isolated CPUs
for irq in $(cat /proc/interrupts | awk '{print $1}' | grep -E '^[0-9]+:$' | tr -d ':'); do
    current=$(cat /proc/irq/$irq/smp_affinity_list 2>/dev/null)
    if [ -n "$current" ]; then
        echo "0-3" > /proc/irq/$irq/smp_affinity_list 2>/dev/null
    fi
done

# Disable irqbalance on isolated CPUs
systemctl stop irqbalance

# Configure irqbalance to avoid isolated CPUs
cat > /etc/sysconfig/irqbalance <<EOF
IRQBALANCE_ARGS="--banirq=<irq-number> --banscript=/usr/share/irqbalance/banscript.sh"
ONESHOT="no"
IRQBALANCE_BANNED_CPUS=0xFFF0  # Ban CPUs 4-15 (bits 4-15 set)
EOF
```

## Scheduler Debugging and Profiling

### ftrace Scheduler Events

```bash
# Enable scheduler tracing
mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null || true

# Trace context switches for a specific PID
echo 1 > /sys/kernel/debug/tracing/events/sched/sched_switch/enable
echo "pid == $(pgrep -f myapp)" > \
  /sys/kernel/debug/tracing/events/sched/sched_switch/filter
echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 5
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | head -50
echo 0 > /sys/kernel/debug/tracing/events/sched/sched_switch/enable
```

### perf sched Analysis

```bash
# Record scheduler events for 10 seconds
perf sched record -o perf.data sleep 10

# Analyze scheduling latency
perf sched latency -i perf.data --sort max

# Show scheduler timeline
perf sched timehist -i perf.data

# Show per-CPU scheduler activity
perf sched map -i perf.data
```

### BCC/BPF Scheduler Observability

```bash
# Run queue latency histogram (1-second intervals, 10 intervals)
runqlat -m 1 10

# Off-CPU time analysis (time waiting for CPU)
offcputime -df -p $(pgrep -f myapp) 30 | flamegraph.pl > offcpu.svg

# CPU wakeup latency
wakeuptime -df -p $(pgrep -f myapp) 30 | flamegraph.pl > wakeup.svg

# Identify processes with highest scheduler latency
runqslower 10000  # Show tasks waiting > 10ms for the CPU
```

## Practical Tuning Recipes

### Recipe 1: Low-Latency Network Service

```bash
# /etc/sysctl.d/99-network-latency.conf
kernel.sched_min_granularity_ns = 500000
kernel.sched_latency_ns = 3000000
kernel.sched_wakeup_granularity_ns = 500000
kernel.sched_migration_cost_ns = 250000

# systemd service unit for network service
# /etc/systemd/system/mynetwork.service
[Service]
ExecStart=/usr/bin/mynetworkapp
CPUSchedulingPolicy=rr
CPUSchedulingPriority=40
CPUAffinity=4 5 6 7
Nice=-10
IOSchedulingClass=realtime
IOSchedulingPriority=0
```

### Recipe 2: Kubernetes Node for Latency-Sensitive Workloads

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
topologyManagerPolicy: single-numa-node
topologyManagerScope: pod
reservedSystemCPUs: "0,1"
systemReserved:
  cpu: "1000m"
  memory: "2Gi"
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
```

```bash
# Kernel cmdline additions for Kubernetes latency node
# /etc/default/grub GRUB_CMDLINE_LINUX additions:
# isolcpus=2-15 nohz_full=2-15 rcu_nocbs=2-15
# intel_pstate=disable processor.max_cstate=1 intel_idle.max_cstate=0
# nosoftlockup

# Disable CPU frequency scaling on isolated cores
for cpu in $(seq 2 15); do
    echo performance > /sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor
done

# Disable hyperthreading for predictable latency
# (only isolate physical cores, not HT siblings)
for sibling in $(cat /sys/devices/system/cpu/cpu*/topology/thread_siblings_list | \
    sort -u | grep ',' | cut -d',' -f2); do
    echo 0 > /sys/devices/system/cpu/cpu${sibling}/online
done
```

### Recipe 3: Batch Processing Node

```bash
# Maximize throughput, sacrifice latency
# /etc/sysctl.d/99-batch.conf
kernel.sched_min_granularity_ns = 10000000
kernel.sched_latency_ns = 80000000
kernel.sched_wakeup_granularity_ns = 10000000
kernel.sched_migration_cost_ns = 5000000

# Enable automatic NUMA balancing for data-movement optimization
echo 1 > /proc/sys/kernel/numa_balancing
```

## Monitoring Scheduler Health

### Prometheus Node Exporter Metrics

The node exporter exposes several scheduler-relevant metrics:

```bash
# CPU steal time (indicates hypervisor competition)
node_cpu_seconds_total{mode="steal"}

# CPU wait (I/O wait - indirectly impacts scheduler)
node_cpu_seconds_total{mode="iowait"}

# Context switches per second
node_context_switches_total

# Process scheduling delay (from /proc/schedstat)
node_schedstat_waiting_seconds_total
node_schedstat_timeslices_total
node_schedstat_running_seconds_total
```

Grafana dashboard query for scheduler latency:

```promql
# Average run queue wait time per CPU (milliseconds)
rate(node_schedstat_waiting_seconds_total[5m]) /
rate(node_schedstat_timeslices_total[5m]) * 1000

# Context switch rate per second
rate(node_context_switches_total[1m])

# CPU saturation: run queue length
node_load1 / count(node_cpu_seconds_total{mode="idle"}) by (instance)
```

## Summary

Linux process scheduling operates across multiple layers — CFS vruntime-based fairness for normal workloads, real-time scheduling classes for latency-sensitive applications, CPU affinity for cache locality, and cgroup controls for containerized workloads. For Kubernetes nodes, the combination of CPU Manager static policy, Topology Manager alignment, and isolated CPU sets provides the strongest guarantees for predictable execution. Profiling tools — perf sched, ftrace, and BCC/BPF — complete the picture by revealing actual scheduling delays in production, enabling data-driven tuning decisions.
