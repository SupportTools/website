---
title: "Linux Process Scheduling: CFS Tuning, Real-Time Priorities, cgroup CPU Scheduling, and Latency Optimization"
date: 2028-08-24T00:00:00-05:00
draft: false
tags: ["Linux", "Scheduling", "CFS", "Real-Time", "cgroups", "Latency"]
categories:
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux process scheduling: the Completely Fair Scheduler, real-time scheduling classes, cgroup CPU bandwidth control, NUMA topology, and techniques to minimize scheduling latency for production workloads."
more_link: "yes"
url: "/linux-process-scheduling-cfs-realtime-guide/"
---

Linux process scheduling is one of the most consequential kernel subsystems for production performance. The default Completely Fair Scheduler handles most workloads well, but database servers, trading systems, audio pipelines, and network packet processors all require deeper knowledge: why a process stalls for 50ms when nothing appears to be happening, how to guarantee bounded latency, how cgroups impose CPU quotas, and what CONFIG_PREEMPT options change about scheduling behavior.

This guide covers CFS internals, real-time scheduling classes, cgroup CPU bandwidth control, NUMA-aware scheduling, and practical tuning for latency-sensitive workloads.

<!--more-->

# [Linux Process Scheduling: CFS Tuning, Real-Time Priorities, cgroup CPU Scheduling, and Latency Optimization](#linux-process-scheduling)

## Section 1: Scheduler Architecture Overview

The Linux scheduler is organized into scheduling classes with strict priority ordering:

```
stop_sched_class     (migration/stop tasks — highest priority)
    dl_sched_class   (SCHED_DEADLINE)
        rt_sched_class   (SCHED_FIFO, SCHED_RR)
            fair_sched_class (SCHED_NORMAL, SCHED_BATCH)
                idle_sched_class (SCHED_IDLE — lowest)
```

Each class implements a set of scheduler operations. The main loop always picks from the highest-priority non-empty class.

### Checking a Process's Scheduling Policy

```bash
# View scheduling class and priority for a process
chrt -p <pid>

# Example output:
# pid 1234's current scheduling policy: SCHED_OTHER
# pid 1234's current scheduling priority: 0

# View nice value and priority
ps -o pid,ni,pri,class,comm -p <pid>

# View scheduler stats for all threads
cat /proc/<pid>/sched

# View top-level scheduler stats
cat /proc/schedstat
```

## Section 2: The Completely Fair Scheduler (CFS)

CFS implements a weighted fair queue using a red-black tree ordered by virtual runtime (`vruntime`). Processes with the smallest `vruntime` run next.

### Virtual Runtime Calculation

```
vruntime += delta_exec * (NICE_0_LOAD / task_weight)
```

Where `task_weight` is derived from the nice value:

| Nice Value | Weight | Relative CPU share |
|------------|--------|--------------------|
| -20 | 88761 | ~10x more than nice 0 |
| -10 | 9548  | ~3x more than nice 0 |
| 0   | 1024  | Baseline |
| 10  | 110   | ~9x less than nice 0 |
| 19  | 15    | ~68x less than nice 0 |

### Key CFS Tunables

```bash
# View current CFS parameters
cat /proc/sys/kernel/sched_latency_ns
# Default: 6000000 (6ms) — target scheduling latency for n tasks

cat /proc/sys/kernel/sched_min_granularity_ns
# Default: 750000 (750μs) — minimum time a task runs before preemption

cat /proc/sys/kernel/sched_wakeup_granularity_ns
# Default: 1000000 (1ms) — minimum vruntime advantage to preempt current task

cat /proc/sys/kernel/sched_migration_cost_ns
# Default: 500000 (500μs) — estimated cache-cold migration cost

cat /proc/sys/kernel/sched_nr_migrate
# Default: 32 — max tasks to migrate per load balancing pass
```

### Tuning CFS for Throughput (Batch/HPC Workloads)

Increase scheduling latency to reduce context switches:

```bash
# Increase scheduling period to reduce context switch frequency
sysctl -w kernel.sched_latency_ns=24000000       # 24ms
sysctl -w kernel.sched_min_granularity_ns=3000000 # 3ms
sysctl -w kernel.sched_wakeup_granularity_ns=4000000 # 4ms

# Persist in /etc/sysctl.d/99-scheduler.conf:
cat > /etc/sysctl.d/99-scheduler-throughput.conf << 'EOF'
kernel.sched_latency_ns = 24000000
kernel.sched_min_granularity_ns = 3000000
kernel.sched_wakeup_granularity_ns = 4000000
kernel.sched_migration_cost_ns = 5000000
kernel.sched_nr_migrate = 8
EOF
sysctl -p /etc/sysctl.d/99-scheduler-throughput.conf
```

### Tuning CFS for Low Latency (Web Servers, Databases)

Decrease scheduling period so tasks preempt faster:

```bash
cat > /etc/sysctl.d/99-scheduler-latency.conf << 'EOF'
kernel.sched_latency_ns = 1000000
kernel.sched_min_granularity_ns = 100000
kernel.sched_wakeup_granularity_ns = 150000
kernel.sched_migration_cost_ns = 250000
kernel.sched_nr_migrate = 64
EOF
```

### Nice Values and renice

```bash
# Launch a process with a specific nice value
nice -n 10 my-batch-job

# Renice a running process
renice -n -5 -p <pid>

# Set nice value for all processes in a cgroup
# (better approach — see Section 5)

# View current nice values
ps -eo pid,ni,comm --sort=ni | head -20
```

## Section 3: Real-Time Scheduling Classes

### SCHED_FIFO

Runs until it voluntarily yields, blocks, or is preempted by a higher-priority RT task. No time-slice. Appropriate for tight control loops.

```bash
# Set a process to SCHED_FIFO priority 50 (range: 1–99)
chrt -f 50 <command>

# Set for existing process
chrt -f -p 50 <pid>

# View
chrt -p <pid>
```

### SCHED_RR (Round Robin)

Like SCHED_FIFO but with a time quantum. After the quantum expires, the task goes to the end of the run queue for its priority level.

```bash
# View RR timeslice
cat /proc/sys/kernel/sched_rr_timeslice_ms
# Default: 100ms

# Set process to SCHED_RR
chrt -r 50 <command>
chrt -r -p 50 <pid>
```

### SCHED_DEADLINE

The most powerful real-time class. Each task specifies its deadline, runtime, and period. The scheduler uses Earliest Deadline First (EDF) ordering.

```bash
# Set SCHED_DEADLINE parameters:
# runtime=5ms, deadline=10ms, period=10ms (50% CPU)
chrt -d --sched-runtime 5000000 \
        --sched-deadline 10000000 \
        --sched-period 10000000 \
        0 <command>
```

**Warning**: SCHED_DEADLINE tasks can starve CFS and RT tasks if misconfigured. Protect the system with:

```bash
# Reserve 5% of CPU for non-RT tasks (default is 5%)
cat /proc/sys/kernel/sched_rt_runtime_us
# -1 means no limit (dangerous)
# 950000 means RT gets 950ms out of every 1000ms

# Set RT throttling: RT tasks can use at most 95% of CPU
sysctl -w kernel.sched_rt_period_us=1000000
sysctl -w kernel.sched_rt_runtime_us=950000
```

### Capabilities Required for RT Scheduling

```bash
# Regular users cannot set RT policies without CAP_SYS_NICE
# Grant a binary the capability:
setcap cap_sys_nice=eip /usr/local/bin/my-rt-app

# Or configure PAM limits in /etc/security/limits.conf:
@realtime - rtprio 99
@realtime - nice -20
@realtime - memlock unlimited

# Add user to realtime group and configure limits
usermod -a -G realtime myuser
```

## Section 4: CPU Affinity and Isolation

### Setting CPU Affinity

```bash
# Run a process pinned to CPUs 2 and 3
taskset -c 2,3 <command>

# Set affinity for running process
taskset -c -p 2,3 <pid>

# Set affinity using bitmask (CPUs 0 and 1 = 0b11 = 3)
taskset -p 3 <pid>

# View current affinity
taskset -c -p <pid>
```

### isolcpus Kernel Parameter

Isolate CPUs from the general scheduler. Useful for RT tasks that need dedicated cores.

```bash
# Add to GRUB_CMDLINE_LINUX in /etc/default/grub:
# isolcpus=4,5,6,7 nohz_full=4,5,6,7 rcu_nocbs=4,5,6,7

# After reboot, verify:
cat /sys/devices/system/cpu/isolated
# 4-7

# Move all kernel threads off isolated CPUs
tuna --cpus=4,5,6,7 --isolate

# Pin RT application to isolated CPUs
taskset -c 4,5,6,7 chrt -f 90 ./my-rt-app
```

### Checking Scheduler Interruptions on Isolated CPUs

```bash
# cyclictest measures scheduling latency on RT workloads
# Install: apt install rt-tests
cyclictest --mlockall --smp --priority=80 --interval=200 --distance=0 \
           --duration=30s --histofall=10000 --affinity=4,5,6,7

# Output shows max latency per CPU:
# CPU  0: 12347 cycles, Max:   87 us
# CPU  4:  9821 cycles, Max:    8 us  (isolated — much better)
```

## Section 5: cgroup CPU Scheduling

### cgroup v2 CPU Controls

```bash
# View cgroup hierarchy
systemd-cgls

# Check if cgroup v2 is active
mount | grep cgroup2

# View CPU controller for a service
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.max
# Format: quota period (in microseconds)
# 200000 100000 means 200ms quota per 100ms period = 2 CPUs max
# max 100000 means no limit
```

### CPU Bandwidth Control with cgroup v2

```bash
# Limit myapp.service to 1.5 CPUs
# quota=150000, period=100000
echo "150000 100000" > /sys/fs/cgroup/system.slice/myapp.service/cpu.max

# Give myapp.service a CPU weight (relative share among cgroup peers)
# Weight range: 1–10000, default: 100
echo 200 > /sys/fs/cgroup/system.slice/myapp.service/cpu.weight

# View current usage
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.stat
```

### systemd Unit CPU Quotas

```ini
# /etc/systemd/system/myapp.service
[Service]
# CPUQuota limits total CPU usage
CPUQuota=150%        # 1.5 CPUs worth of CPU time

# CPUWeight controls relative share (replaces old CPUShares)
CPUWeight=200        # Default is 100

# Pin to specific CPUs
CPUAffinity=0 1 2 3  # Allow only CPUs 0-3

# Real-time scheduling
Restart=always
IOSchedulingClass=realtime
IOSchedulingPriority=0

# RT priority (requires CAP_SYS_NICE)
# Nice=-10           # Negative nice (higher priority in CFS)
```

```bash
# Apply and verify
systemctl daemon-reload
systemctl restart myapp

# Check effective limits
systemctl show myapp | grep -E "CPU|Nice"
```

### Kubernetes CPU Requests and Limits via cgroups

In Kubernetes, `resources.requests.cpu` maps to `cpu.weight` and `resources.limits.cpu` maps to `cpu.max`:

```bash
# On the node, find the cgroup for a pod
POD_UID=$(kubectl get pod myapp-xxx -n production -o jsonpath='{.metadata.uid}')
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice"

# Find the pod's cgroup
find $CGROUP_PATH -name "pod${POD_UID}" -type d

# Check CPU quota for a container
cat /sys/fs/cgroup/kubepods.slice/.../cpu.max
# 100000 100000 = 1 CPU limit (100ms quota per 100ms period)

# Check CPU weight (from requests)
cat /sys/fs/cgroup/kubepods.slice/.../cpu.weight
# 1000 = 1 CPU request (weight proportional to millicores)
```

### CPU Throttling in Kubernetes

CPU throttling occurs when a container exhausts its cgroup quota. Check for it:

```bash
# Check throttling stats for a container
POD_NAME="myapp-xxx"
CONTAINER_NAME="app"
NAMESPACE="production"

# Via node's cgroup filesystem
cat /sys/fs/cgroup/kubepods.slice/.../${POD_NAME}/${CONTAINER_NAME}/cpu.stat
# nr_periods       1000000
# nr_throttled     50000    <- throttled 5% of periods
# throttled_usec   2500000000

# Via kubectl top (only shows current usage, not throttle rate)
kubectl top pod myapp-xxx -n production --containers

# Via Prometheus (cadvisor metrics)
# container_cpu_cfs_throttled_seconds_total
# container_cpu_cfs_throttled_periods_total / container_cpu_cfs_periods_total
```

### Eliminating Throttling Without Removing Limits

```yaml
# Option 1: Increase CPU limit
resources:
  limits:
    cpu: "2"      # Was "500m", increase if budget allows

# Option 2: Use Guaranteed QoS (requests == limits)
resources:
  requests:
    cpu: "1"
  limits:
    cpu: "1"     # Guaranteed class: less throttling variance

# Option 3: Disable CPU limits entirely (set only requests)
resources:
  requests:
    cpu: "500m"
  # No limits: container can burst to available capacity
```

## Section 6: NUMA Topology and Scheduling

Non-Uniform Memory Access (NUMA) systems have multiple memory controllers, each local to a CPU socket. Accessing remote memory costs 30–50% more latency.

### Checking NUMA Topology

```bash
# View NUMA topology
numactl --hardware

# Output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 64215 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 64436 MB
# node distances:
# node   0   1
#   0:  10  21

# Check NUMA stats for a process
numastat -p <pid>

# Check NUMA page fault stats
cat /proc/<pid>/numa_maps | head -20
```

### Running Processes with NUMA Affinity

```bash
# Run on NUMA node 0 only
numactl --cpunodebind=0 --membind=0 ./my-app

# Run across nodes but prefer local memory
numactl --preferred=0 ./my-app

# Interleave memory across nodes (good for parallel HPC workloads)
numactl --interleave=all ./my-app

# For systemd services
# /etc/systemd/system/myapp.service
[Service]
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/local/bin/myapp
```

### NUMA Balancing

The kernel can migrate pages toward the CPU that accesses them most frequently:

```bash
# Check if NUMA balancing is enabled
cat /proc/sys/kernel/numa_balancing
# 1 = enabled

# Disable for latency-sensitive workloads (migrations cause TLB flushes)
sysctl -w kernel.numa_balancing=0

# For Kubernetes, disable NUMA balancing system-wide on nodes
# with CPU Manager policy=static
```

### Kubernetes CPU Manager and NUMA

```bash
# Check CPU Manager policy on a node
cat /var/lib/kubelet/cpu_manager_state

# Enable static CPU Manager policy (requires restart):
# /var/lib/kubelet/config.yaml
# cpuManagerPolicy: static
# topologyManagerPolicy: best-effort  (or: restricted, single-numa-node)

# With static policy, Guaranteed QoS pods get exclusive CPUs
# With single-numa-node topology policy, all resources are from one NUMA node
```

## Section 7: Measuring and Diagnosing Scheduling Latency

### Using perf sched

```bash
# Record scheduling events for 10 seconds
perf sched record -g -- sleep 10

# Analyze latency statistics
perf sched latency --sort max

# Output sample:
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms
# myapp:(4)             |    1234.456   |    5678  |          0.123   |          12.345
# postgres:(8)          |    5678.901   |   12345  |          0.045   |           2.345

# Show scheduling trace
perf sched timehist | head -50

# Replay trace to find worst offenders
perf sched replay
```

### Using ftrace for Scheduler Tracing

```bash
# Enable scheduler wakeup latency tracing
echo 0 > /sys/kernel/debug/tracing/tracing_on
echo > /sys/kernel/debug/tracing/trace
echo "sched_wakeup" > /sys/kernel/debug/tracing/set_event
echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 5
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | head -100

# Use tracer for wakeup latency
echo wakeup > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 1
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace
```

### Using bpftrace for Scheduling Analysis

```bash
# Install bpftrace
apt install bpftrace

# Trace run queue latency (time from wakeup to actual execution)
bpftrace -e '
tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new {
    @qtime[args->pid] = nsecs;
}

tracepoint:sched:sched_switch {
    if (@qtime[args->next_pid]) {
        $latency_us = (nsecs - @qtime[args->next_pid]) / 1000;
        @runq_latency = hist($latency_us);
        delete(@qtime[args->next_pid]);
    }
}

END { clear(@qtime); }
'
# Hit Ctrl+C after a few seconds to see histogram

# Find processes with highest scheduling latency
bpftrace -e '
tracepoint:sched:sched_wakeup { @start[args->pid] = nsecs; }
tracepoint:sched:sched_switch {
    $pid = args->next_pid;
    if (@start[$pid]) {
        @latency_ms[$pid, args->next_comm] =
            hist((nsecs - @start[$pid]) / 1000000);
        delete(@start[$pid]);
    }
}
'
```

### Using cyclictest for RT Latency Measurement

```bash
# Comprehensive RT latency test
# Requires rt-tests package
cyclictest \
    --mlockall \
    --threads=4 \
    --priority=80 \
    --interval=200 \
    --distance=0 \
    --duration=60s \
    --histogram=10000 \
    --histfile=/tmp/latency-hist.txt \
    --affinity=0-3

# Parse results
grep "Max" /tmp/latency-hist.txt

# A good result for an isolated RT system:
# Max:    12 us  (under 50μs is excellent for a tuned RT Linux system)
# A bad result (interruptions from scheduling, IRQs):
# Max:  1234 us  (millisecond-scale latency is unacceptable for RT)
```

## Section 8: Interrupt Affinity and IRQ Balancing

Uncontrolled IRQ delivery can cause scheduling latency spikes on any CPU, including those running RT tasks.

```bash
# View current IRQ affinity
for irq in /proc/irq/*/smp_affinity_list; do
    echo "$irq: $(cat $irq)"
done

# View IRQ statistics
cat /proc/interrupts | head -30

# Move all IRQs away from isolated CPUs (0-3 isolated, 4-7 for RT)
# Move eth0 IRQs to CPUs 0-3
IRQS=$(grep "eth0" /proc/interrupts | awk '{print $1}' | tr -d ':')
for IRQ in $IRQS; do
    echo 0f > /proc/irq/$IRQ/smp_affinity  # CPUs 0-3 bitmask: 0b00001111
done

# Disable IRQ balancing daemon (conflicts with manual affinity)
systemctl stop irqbalance
systemctl disable irqbalance

# For Kubernetes nodes: keep irqbalance on for non-isolated CPUs
# Configure irqbalance to respect isolated CPUs
cat > /etc/sysconfig/irqbalance << 'EOF'
IRQBALANCE_ARGS="--banirq=<rt-irq-numbers>"
EOF
```

## Section 9: Kernel Preemption Models

The kernel preemption model affects worst-case scheduling latency:

| Config | Description | Max Latency | Use Case |
|--------|-------------|-------------|----------|
| `CONFIG_PREEMPT_NONE` | No preemption | 10ms–100ms | Throughput servers |
| `CONFIG_PREEMPT_VOLUNTARY` | Voluntary preemption points | 1ms–10ms | Desktop default |
| `CONFIG_PREEMPT` | Full preemption | 100μs–1ms | Interactive/server |
| `CONFIG_PREEMPT_RT` (PREEMPT_RT patch) | Real-time | 10μs–100μs | Audio, control systems |

```bash
# Check current preemption model
cat /sys/kernel/debug/sched/preempt
# or
grep -i preempt /boot/config-$(uname -r)

# Check if RT patch is applied
uname -r | grep -i rt
# Example: 5.15.0-73-generic (no RT patch)
# Example: 5.15.71-rt53 (with PREEMPT_RT patch)

# Ubuntu/Debian RT kernel
apt search linux-image-rt
apt install linux-image-$(uname -r | sed 's/-generic//')-rt
```

## Section 10: Complete Tuning Script for Latency-Sensitive Systems

```bash
#!/bin/bash
# tune-for-latency.sh
# Applies comprehensive scheduling tuning for low-latency workloads
# Run as root on the target system

set -euo pipefail

RT_CPUS="4,5,6,7"      # CPUs reserved for RT/latency-sensitive tasks
GENERAL_CPUS="0,1,2,3" # CPUs for general workloads

echo "=== Applying Latency Optimization Tuning ==="

# 1. CFS scheduler tuning
cat > /etc/sysctl.d/99-cfs-latency.conf << 'EOF'
# Reduce scheduling period for faster preemption
kernel.sched_latency_ns = 1000000
kernel.sched_min_granularity_ns = 100000
kernel.sched_wakeup_granularity_ns = 150000

# Reduce migration cost to enable faster cross-CPU migration
kernel.sched_migration_cost_ns = 250000
kernel.sched_nr_migrate = 64

# RT throttling: allow RT tasks to use 95% of CPU time
kernel.sched_rt_period_us = 1000000
kernel.sched_rt_runtime_us = 950000
EOF
sysctl -p /etc/sysctl.d/99-cfs-latency.conf

# 2. Disable NUMA balancing (prevents TLB flushes during RT execution)
sysctl -w kernel.numa_balancing=0
echo "kernel.numa_balancing = 0" >> /etc/sysctl.d/99-cfs-latency.conf

# 3. Set CPU governor to performance
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu" 2>/dev/null || true
done

# 4. Disable CPU frequency scaling
cpupower frequency-set -g performance 2>/dev/null || true

# 5. Disable C-states for RT CPUs (prevents wakeup latency)
for cpu in 4 5 6 7; do
    # Disable all C-states beyond C0
    for state in /sys/devices/system/cpu/cpu${cpu}/cpuidle/state*/disable; do
        echo 1 > "$state" 2>/dev/null || true
    done
done

# 6. Move IRQs away from RT CPUs
RT_CPU_MASK="0f"  # CPUs 0-3 bitmask (general CPUs handle IRQs)
for irq_dir in /proc/irq/*/; do
    irq=$(basename "$irq_dir")
    [[ "$irq" == "0" ]] && continue  # Skip timer IRQ
    echo "$RT_CPU_MASK" > "/proc/irq/${irq}/smp_affinity" 2>/dev/null || true
done

# 7. Stop IRQ balance daemon
systemctl stop irqbalance 2>/dev/null || true

# 8. Set watchdog to general CPUs only
# (kernel watchdog can cause latency spikes)
echo "${GENERAL_CPUS//,/}" > /sys/devices/system/cpu/nohz_full 2>/dev/null || true

# 9. Transparent huge pages — disable for RT (THP collapses cause latency spikes)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# 10. Verify settings
echo ""
echo "=== Verification ==="
echo "CFS latency_ns: $(cat /proc/sys/kernel/sched_latency_ns)"
echo "NUMA balancing: $(cat /proc/sys/kernel/numa_balancing)"
echo "CPU governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo N/A)"
echo "THP: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo ""
echo "Tuning complete. Run cyclictest to verify latency:"
echo "cyclictest --mlockall --threads=4 --priority=80 --interval=200 --duration=10s --affinity=${RT_CPUS}"
```

## Section 11: Scheduling in Containers and Kubernetes

### Container Scheduling Constraints

Containers inherit the host's scheduling parameters but are constrained by their cgroup:

```bash
# Check if a container has RT scheduling capability
docker run --cap-add SYS_NICE --ulimit rtprio=99 my-rt-app

# In Kubernetes, allow RT scheduling via SecurityContext
# (requires SYS_NICE capability)
```

```yaml
containers:
- name: rt-app
  image: my-rt-app:v1.0
  securityContext:
    capabilities:
      add: ["SYS_NICE"]
  resources:
    requests:
      cpu: "2"
    limits:
      cpu: "2"
      # Use Guaranteed QoS to get exclusive CPUs with CPU Manager
```

### Kubernetes CPU Manager Static Policy

For guaranteed low scheduling latency in Kubernetes:

```bash
# Node configuration for exclusive CPU allocation
# /var/lib/kubelet/config.yaml
cat >> /var/lib/kubelet/config.yaml << 'EOF'
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  full-pcpus-only: "true"        # Allocate full physical CPUs only
  distribute-cpus-across-numa: "true"  # NUMA-aware allocation
topologyManagerPolicy: single-numa-node  # All resources from one NUMA node
topologyManagerScope: pod
EOF

systemctl restart kubelet

# Verify CPU Manager is using static policy
cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool
```

## Section 12: Prometheus Metrics for Scheduling Latency

```bash
# Node Exporter exposes scheduling-related metrics
# Key metrics to alert on:

# Run queue latency (time waiting to be scheduled)
# node_schedstat_waiting_seconds_total

# Context switches per second
# node_context_switches_total

# CPU steal (VMs) — indicates hypervisor scheduling contention
# node_cpu_seconds_total{mode="steal"}

# Example Prometheus alert rules
cat > scheduling-alerts.yaml << 'EOF'
groups:
- name: scheduling
  rules:
  - alert: HighCPUThrottling
    expr: |
      sum(increase(container_cpu_cfs_throttled_seconds_total[5m])) by (pod, container, namespace)
      / sum(increase(container_cpu_cfs_periods_total[5m])) by (pod, container, namespace)
      > 0.25
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Container {{ $labels.container }} in {{ $labels.pod }} throttled > 25%"

  - alert: HighContextSwitchRate
    expr: rate(node_context_switches_total[5m]) > 100000
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "High context switch rate on {{ $labels.instance }}"

  - alert: CPUStealing
    expr: rate(node_cpu_seconds_total{mode="steal"}[5m]) > 0.1
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "CPU steal > 10% on {{ $labels.instance }}: hypervisor contention"
EOF
```

## Section 13: Summary

### Scheduling Class Decision Guide

| Workload Type | Recommended Class | Typical Priority |
|---------------|-------------------|-----------------|
| Batch processing | SCHED_BATCH or nice 10-19 | N/A |
| Web server | SCHED_NORMAL, nice 0 | N/A |
| Database | SCHED_NORMAL, nice -5 | N/A |
| Control loop (soft RT) | SCHED_RR | 30–50 |
| Hard real-time | SCHED_FIFO | 70–90 |
| Periodic with deadline | SCHED_DEADLINE | N/A |

### Key Takeaways

1. CFS `sched_latency_ns` and `sched_min_granularity_ns` are the primary levers for CFS behavior
2. RT scheduling requires `CAP_SYS_NICE` or PAM limits configuration
3. `isolcpus` + `nohz_full` is essential for hard real-time workloads alongside CFS workloads
4. cgroup v2 `cpu.max` implements CPU bandwidth control (CPU limits in Kubernetes)
5. CPU throttling in Kubernetes containers is caused by hitting `cpu.max` quota — increase limits or switch to burstable QoS
6. Disable C-states and frequency scaling on RT CPUs to eliminate wakeup latency variance
7. Move IRQs off RT CPUs — a single interrupt can cause multi-millisecond latency spikes
8. `cyclictest` and `bpftrace` are the definitive tools for measuring scheduling latency
9. PREEMPT_RT kernel patches reduce worst-case latency from milliseconds to tens of microseconds
