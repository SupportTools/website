---
title: "Linux Process Scheduling Deep Dive: CFS, Real-Time Scheduling, and NUMA-Aware Placement"
date: 2031-10-04T00:00:00-05:00
draft: false
tags: ["Linux", "Process Scheduling", "CFS", "NUMA", "Real-Time", "Performance Tuning", "Kernel"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux process scheduling covering the Completely Fair Scheduler internals, real-time scheduling classes, NUMA topology and CPU pinning, and production tuning for latency-sensitive workloads."
more_link: "yes"
url: "/linux-process-scheduling-cfs-realtime-numa-placement/"
---

The Linux scheduler makes thousands of decisions per second: which process runs next, on which CPU, for how long, and whether to move it to a different CPU to balance load. For most workloads, the defaults work excellently. For latency-sensitive applications—financial trading engines, real-time audio processing, high-frequency telemetry collectors, Kubernetes node daemons—the defaults impose avoidable latency. Understanding the scheduler's internals lets you tune precisely: reduce jitter, prevent unexpected preemption, and place workloads correctly on NUMA hardware.

This guide covers the Completely Fair Scheduler's virtual runtime mechanism, the real-time scheduling classes (FIFO and RR), cgroup-based CPU allocation, and NUMA placement strategies for large multi-socket servers.

<!--more-->

# Linux Process Scheduling: CFS, Real-Time, and NUMA

## The Linux Scheduler Hierarchy

Linux has multiple scheduling classes arranged in priority order. A runnable task in a higher-priority class always runs before a task in a lower-priority class:

```
Priority (highest to lowest):
1. SCHED_DEADLINE  — EDF (Earliest Deadline First) for hard real-time tasks
2. SCHED_FIFO      — Real-time FIFO (no time-slicing between equal-priority tasks)
3. SCHED_RR        — Real-time Round Robin (time-sliced within same priority)
4. SCHED_NORMAL    — CFS (the default for most processes)
5. SCHED_BATCH     — CFS variant for CPU-intensive batch jobs (lower scheduling frequency)
6. SCHED_IDLE      — Lowest possible priority (background tasks)
```

## Part 1: The Completely Fair Scheduler (CFS)

CFS aims to give every process an equal share of CPU time. It uses a red-black tree ordered by **virtual runtime** (vruntime) — the amount of CPU time a task has received, normalised by its weight (nice value). The task with the smallest vruntime is always next to run.

### Virtual Runtime Mechanics

```
vruntime_delta = real_cpu_time * (NICE_0_WEIGHT / task_weight)

Where:
  NICE_0_WEIGHT = 1024 (the weight for nice=0)
  task_weight   = lookup table indexed by nice value (-20 to +19)
```

A task with nice=-5 has weight 3121 (3× the default), so it accumulates vruntime 3× slower, causing it to be chosen 3× more often than a nice=0 task.

### Inspecting CFS State

```bash
# View scheduler statistics for a process
cat /proc/$(pgrep nginx)/sched
# nginx (12345, #threads: 4)
# se.exec_start                :     1234567890.123456
# se.vruntime                  :         9876543.210000
# se.sum_exec_runtime          :          123456.789000
# nr_switches                  :              45678
# nr_voluntary_switches        :              23456
# nr_involuntary_switches      :              22222  ← preemptions (bad for latency)
# se.load.weight               :               1024
# policy                       :                  0  ← SCHED_NORMAL

# View scheduling info for all threads
for pid in $(pidof my-service); do
    echo "PID $pid:"
    grep -E "se\.(vruntime|sum_exec)|nr_(in)?voluntary" /proc/$pid/sched
done
```

### Nice Values and CPU Shares

```bash
# Set nice value at launch
nice -n -10 ./high-priority-service

# Change running process
renice -n -5 -p $(pgrep my-service)

# View all processes by nice value
ps -eo pid,ni,comm --sort=-ni | head -20

# In systemd unit files
[Service]
Nice=-10
```

### CFS Bandwidth Control (CPU Throttling)

CFS bandwidth control allows you to cap a cgroup's CPU usage. This is what Kubernetes resource limits use.

```bash
# Create a cgroup
mkdir /sys/fs/cgroup/cpu/myapp

# Limit to 50% of one CPU: 50000 us per 100000 us period
echo 50000  > /sys/fs/cgroup/cpu/myapp/cpu.cfs_quota_us
echo 100000 > /sys/fs/cgroup/cpu/myapp/cpu.cfs_period_us

# Add processes to the cgroup
echo $(pgrep my-service) > /sys/fs/cgroup/cpu/myapp/tasks

# Monitor throttling
cat /sys/fs/cgroup/cpu/myapp/cpu.stat
# nr_periods        1234567
# nr_throttled      89012       ← non-zero = CPU-limited (check Kubernetes CPU limits)
# throttled_time    45678901234  ns

# In Kubernetes — check throttling via Prometheus:
# container_cpu_cfs_throttled_periods_total / container_cpu_cfs_periods_total > 0.25
# = throttled more than 25% of scheduling periods → consider raising CPU limit
```

### The CFS Latency Target

The `sched_latency_ns` kernel parameter defines the target scheduling latency — the time within which every runnable task should get at least one run. With 10 runnable tasks and 6 ms latency target, each task gets 600 µs per period.

```bash
# View current CFS parameters
cat /proc/sys/kernel/sched_latency_ns      # default: 6000000 (6ms)
cat /proc/sys/kernel/sched_min_granularity_ns  # default: 750000 (0.75ms)
cat /proc/sys/kernel/sched_wakeup_granularity_ns  # default: 1000000 (1ms)

# For low-latency systems: reduce latency target
# WARNING: increases context-switch rate, which increases CPU overhead
sysctl -w kernel.sched_latency_ns=1000000         # 1ms
sysctl -w kernel.sched_min_granularity_ns=100000   # 0.1ms
sysctl -w kernel.sched_wakeup_granularity_ns=250000 # 0.25ms

# For throughput-oriented batch systems: increase latency target
sysctl -w kernel.sched_latency_ns=24000000        # 24ms
sysctl -w kernel.sched_min_granularity_ns=3000000  # 3ms
```

## Part 2: Real-Time Scheduling Classes

Real-time scheduling bypasses CFS entirely. An SCHED_FIFO task at priority 99 will preempt any CFS task and will not yield the CPU until it blocks, terminates, or is preempted by a higher-priority RT task.

### When to Use Real-Time Scheduling

Real-time scheduling is appropriate for:
- Audio/video capture and playback daemons
- Motion control systems
- Network packet timestamping daemons
- Custom high-frequency telemetry collectors
- Watchdog processes that must not be starved

**Never** run general application code with RT priority — a bug causing a tight loop will lock the CPU.

### Setting Real-Time Priority

```bash
# SCHED_FIFO: no time-slicing, runs until it blocks or is preempted by higher-priority RT task
chrt -f 50 ./my-rt-daemon

# SCHED_RR: time-sliced within same priority
chrt -r 50 ./my-rt-daemon

# Change policy of running process
chrt -f -p 80 $(pgrep my-rt-daemon)

# View scheduling policy
chrt -p $(pgrep my-rt-daemon)
# pid 12345's current scheduling policy: SCHED_FIFO
# pid 12345's current scheduling priority: 80

# From C/Go — use syscall
# syscall.SchedSetscheduler(0, syscall.SCHED_FIFO, &syscall.SchedParam{Priority: 80})
```

### The RT Throttle Safety Net

The RT throttle (CONFIG_RT_GROUP_SCHED) prevents RT tasks from starving CFS tasks completely:

```bash
# By default: RT tasks can use 95% of CPU time, leaving 5% for CFS
cat /proc/sys/kernel/sched_rt_period_us    # 1000000 (1s)
cat /proc/sys/kernel/sched_rt_runtime_us   # 950000 (0.95s = 95%)

# To disable throttling entirely (DANGEROUS — RT tasks can starve the kernel):
echo -1 > /proc/sys/kernel/sched_rt_runtime_us

# For soft real-time: keep throttling but allow 99%
sysctl -w kernel.sched_rt_runtime_us=990000
```

### SCHED_DEADLINE for Hard Real-Time Constraints

SCHED_DEADLINE implements Earliest Deadline First (EDF) scheduling. You specify the task's runtime, deadline, and period; the kernel guarantees that the task will receive `runtime` nanoseconds of CPU time within each `period`, with completion by `deadline`.

```bash
# Allocate 2ms of CPU every 10ms (20% utilisation), deadline = period
chrt --deadline --sched-runtime 2000000 \
              --sched-deadline 10000000 \
              --sched-period 10000000 \
              -p 0 $(pgrep my-deadline-task)

# From C (not directly available via Go's syscall package):
# Use sched_setattr() system call
# sched.sched_runtime  = 2000000  /* ns */
# sched.sched_deadline = 10000000 /* ns */
# sched.sched_period   = 10000000 /* ns */
```

**Admission control**: The kernel rejects SCHED_DEADLINE tasks that would make the system infeasible (total utilisation > number of CPUs). This prevents accidentally starving all other tasks.

## Part 3: CPU Affinity and Isolation

### Setting CPU Affinity

CPU affinity binds a process to specific CPUs. This reduces cache thrashing and improves predictability.

```bash
# Run process on CPUs 2 and 3 only
taskset -c 2,3 ./my-service

# Change affinity of a running process
taskset -cp 4-7 $(pgrep my-service)

# View current affinity
taskset -p $(pgrep my-service)
# pid 12345's current affinity mask: ff  (= 0b11111111 = CPUs 0-7)

# In systemd
[Service]
CPUAffinity=4 5 6 7
```

### Isolating CPUs from the Scheduler (isolcpus)

The most powerful mechanism for latency-sensitive workloads: remove CPUs from the kernel's load balancing entirely. Only explicitly assigned processes run on these CPUs.

```bash
# Add to kernel command line (requires reboot)
# /etc/default/grub:
GRUB_CMDLINE_LINUX="isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7"
# isolcpus: removes from scheduler load balancing
# nohz_full: disables scheduler tick on these CPUs (eliminates 1ms jitter from HZ interrupts)
# rcu_nocbs: offloads RCU callbacks (eliminates microsecond-scale RCU jitter)
update-grub && reboot

# After reboot, verify
cat /sys/devices/system/cpu/isolated
# 4-7

# Move your latency-sensitive process to isolated CPUs
taskset -c 4-7 ./my-low-latency-service

# Verify no other processes are running on those CPUs
ps -eo pid,psr,comm | awk '$2 >= 4 && $2 <= 7'
```

### IRQ Affinity

Hardware interrupts compete with application threads. Move them away from latency-sensitive CPUs:

```bash
# View current IRQ affinity
for irq in $(ls /proc/irq/); do
    affinity=$(cat /proc/irq/$irq/smp_affinity_list 2>/dev/null)
    echo "IRQ $irq: $affinity"
done

# Move all IRQs to CPUs 0-3 (away from isolated CPUs 4-7)
for irq in $(ls /proc/irq/); do
    echo "0-3" > /proc/irq/$irq/smp_affinity_list 2>/dev/null || true
done

# The irqbalance daemon conflicts with manual IRQ pinning — disable it
systemctl stop irqbalance
systemctl disable irqbalance
```

## Part 4: NUMA Topology and Placement

Modern multi-socket servers have Non-Uniform Memory Access (NUMA) architecture: each socket has local memory (fast access) and remote memory (slower, crosses QPI/UPI interconnect). A process running on socket 0 that allocates memory on socket 1's node will pay a 50–100 ns penalty per access.

### Inspecting NUMA Topology

```bash
# View NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 128946 MB
# node 0 free: 97234 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 128953 MB
# node 1 free: 88910 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
# ↑ Local access: 10 (normalised), Remote: 21 (2.1× slower)

# Detailed CPU-to-NUMA mapping
lscpu | grep NUMA
# NUMA node(s):          2
# NUMA node0 CPU(s):     0-11,24-35
# NUMA node1 CPU(s):     12-23,36-47

# View NUMA memory statistics
numastat
# Per-node memory allocation statistics
```

### NUMA-Aware Process Placement

```bash
# Run a process using only NUMA node 0's CPUs and memory
numactl --cpunodebind=0 --membind=0 ./my-service

# Interleave memory across both nodes (for balanced but slower access)
numactl --interleave=all ./my-memory-hungry-service

# Preferred node but fall back if insufficient memory
numactl --preferred=0 ./my-service

# Systemd service with NUMA binding
# /etc/systemd/system/my-service.service
[Service]
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/bin/my-service
```

### Checking for NUMA Issues

```bash
# Monitor NUMA miss rate (remote memory accesses)
numastat -c $(pgrep my-service)
# Per-process NUMA stats:
#                    my-service
# numa_hit              4857392  ← local node allocations
# numa_miss               45231  ← remote node allocations (want this low)
# numa_foreign              234
# interleave_hit              0
# local_node            4857392
# other_node              45231

# NUMA miss rate as percentage:
# numa_miss / (numa_hit + numa_miss) * 100

# Real-time NUMA page allocation monitoring
perf stat -e numa:numa_hit,numa:numa_miss \
  -p $(pgrep my-service) sleep 10
```

### Memory Policies for Go Applications

Go programs have limited control over NUMA placement from within Go code itself. Use numactl or cgroup cpuset:

```bash
# Use cgroup cpuset to constrain a Go application
mkdir /sys/fs/cgroup/cpuset/myapp
echo 0-11,24-35  > /sys/fs/cgroup/cpuset/myapp/cpuset.cpus
echo 0            > /sys/fs/cgroup/cpuset/myapp/cpuset.mems
echo $(pgrep my-go-service) > /sys/fs/cgroup/cpuset/myapp/tasks

# In Kubernetes — set CPU topology policy in kubelet config:
# cpuManagerPolicy: static (for Guaranteed QoS pods)
# topologyManagerPolicy: best-effort or single-numa-node
```

### Kubernetes CPU Manager and Topology Manager

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  full-pcpus-only: "true"    # allocate whole physical CPUs (no hyperthreading sharing)
topologyManagerPolicy: single-numa-node  # pack pod CPUs and memory on one NUMA node
topologyManagerScope: pod

# For pods to use CPU Manager, they must be in Guaranteed QoS:
# - All containers must have CPU requests = CPU limits
# - All containers must have memory requests = memory limits
# - CPU requests must be >= 1 (integer)
```

```yaml
# Guaranteed QoS pod for CPU Manager
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "4"       # Must be integer and equal to limits
          memory: "8Gi"
        limits:
          cpu: "4"
          memory: "8Gi"
```

## Part 5: Monitoring and Profiling

### perf for Scheduler Events

```bash
# Record scheduler context switches for a process
perf record -e sched:sched_switch -p $(pgrep my-service) sleep 30
perf report

# Count voluntary vs involuntary context switches
perf stat -e context-switches,cs -p $(pgrep my-service) sleep 10

# CPU migration events (task moving between CPUs)
perf stat -e migrations -p $(pgrep my-service) sleep 10

# Scheduler wakeup latency histogram
perf sched record -p $(pgrep my-service) sleep 5
perf sched latency
# -------------------------------------------------
#  Task                |   Runtime ms  | Switches | Average delay ms | Maximum delay ms |
# -------------------------------------------------
#  my-service          |    4123.456   |     8901 |          0.047   |          2.341   |
```

### Off-CPU Time Analysis with bpftrace

```bash
# Measure time a process spends off-CPU (blocked/sleeping)
bpftrace -e '
tracepoint:sched:sched_switch {
    if (args->prev_comm == "my-service") {
        @off_start[args->prev_pid] = nsecs;
    }
    if (args->next_comm == "my-service") {
        if (@off_start[args->next_pid]) {
            $off_time = nsecs - @off_start[args->next_pid];
            @off_cpu_us = hist($off_time / 1000);
            delete(@off_start[args->next_pid]);
        }
    }
}

interval:s:30 {
    printf("Off-CPU latency distribution (us):\n");
    print(@off_cpu_us);
    clear(@off_cpu_us);
}'
```

### Latency Percentile Tracking

```bash
# Measure scheduling latency (time from wake to run) for a specific process
bpftrace -e '
tracepoint:sched:sched_wakeup /args->comm == "my-service"/ {
    @wake_ts[args->pid] = nsecs;
}

tracepoint:sched:sched_switch /args->next_comm == "my-service"/ {
    if (@wake_ts[args->next_pid]) {
        $sched_lat = nsecs - @wake_ts[args->next_pid];
        @sched_latency_us = hist($sched_lat / 1000);
        delete(@wake_ts[args->next_pid]);
    }
}

interval:s:30 {
    printf("Scheduling latency (us):\n");
    print(@sched_latency_us);
    clear(@sched_latency_us);
}'
```

## Production Tuning Checklist

### For Latency-Sensitive Services

```bash
#!/usr/bin/env bash
# latency-tune.sh — tune a system for low-latency workloads

# 1. Reduce scheduler latency target
sysctl -w kernel.sched_latency_ns=1000000
sysctl -w kernel.sched_min_granularity_ns=100000
sysctl -w kernel.sched_wakeup_granularity_ns=250000

# 2. Disable frequency scaling (prevents CPU governor latency)
cpupower frequency-set -g performance
# Or use: echo performance > /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# 3. Disable C-states deeper than C1 (prevents wakeup latency from deep sleep)
cpupower idle-set -D 1
# Or via kernel parameter: intel_idle.max_cstate=1

# 4. Disable transparent huge pages (reduces latency spikes from THP collapsing)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# 5. Increase process priority
renice -n -15 -p $(pgrep my-latency-service)

# 6. Pin to isolated CPUs
taskset -cp 4-7 $(pgrep my-latency-service)

# 7. Persist settings
cat >> /etc/sysctl.d/99-latency.conf <<'EOF'
kernel.sched_latency_ns=1000000
kernel.sched_min_granularity_ns=100000
kernel.sched_wakeup_granularity_ns=250000
EOF
```

### For Throughput-Oriented Workloads

```bash
# Allow larger scheduling periods (fewer context switches, better cache utilisation)
sysctl -w kernel.sched_latency_ns=24000000
sysctl -w kernel.sched_min_granularity_ns=3000000

# Enable transparent huge pages for large heap workloads
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Use powersave or schedutil governor (better energy efficiency)
cpupower frequency-set -g schedutil
```

## Summary

Linux scheduling is a multi-layered system with a tool for every workload:

- **CFS** and its virtual runtime mechanism provide fair sharing for ordinary tasks; tune `sched_latency_ns` to balance responsiveness vs. context-switch overhead
- **SCHED_FIFO/RR** deliver real-time guarantees for latency-sensitive daemons; the RT throttle prevents starvation of the kernel
- **SCHED_DEADLINE** offers EDF scheduling with admission control for tasks with strict periodic execution requirements
- **CPU affinity and isolcpus** remove CPUs from the scheduler's load balancing entirely, eliminating jitter from unrelated processes
- **NUMA-aware placement** with numactl or Kubernetes CPU/Topology Manager ensures memory is allocated local to the CPUs executing the code, critical on multi-socket servers where remote NUMA access adds 50–100 ns latency

The combination of correct scheduling class, CPU isolation, NUMA binding, and C-state control can reduce tail latency by an order of magnitude on production hardware.
