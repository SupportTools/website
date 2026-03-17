---
title: "Linux Process Scheduling: CFS, RT Scheduling, and CPU Affinity for Latency-Sensitive Apps"
date: 2031-01-15T00:00:00-05:00
draft: false
tags: ["Linux", "Scheduling", "CFS", "Real-Time", "CPU Affinity", "Performance", "Kernel", "Latency"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux process scheduling covering CFS internals, SCHED_FIFO/SCHED_RR real-time classes, cgroups CPU bandwidth control, taskset and cpuset affinity, isolcpus kernel parameter, and configuring CPU pinning for low-latency applications."
more_link: "yes"
url: "/linux-process-scheduling-cfs-rt-cpu-affinity-latency-sensitive/"
---

The Linux scheduler makes thousands of scheduling decisions per second across all CPU cores. For most workloads, the default Completely Fair Scheduler (CFS) provides excellent throughput and fairness. But for latency-sensitive applications — financial trading systems, real-time audio, industrial control, or any application where a scheduling delay of milliseconds is unacceptable — understanding and controlling the scheduler is essential. This guide covers CFS internals, real-time scheduling classes, CPU affinity mechanisms, kernel isolation parameters, and practical configuration for production deployments.

<!--more-->

# Linux Process Scheduling: CFS, RT Scheduling, and CPU Affinity for Latency-Sensitive Apps

## Section 1: CFS Scheduler Internals

### The Red-Black Tree and vruntime

CFS maintains a red-black tree of runnable tasks ordered by virtual runtime (vruntime). The task with the smallest vruntime always runs next.

```
vruntime increases as:
  vruntime += actual_runtime * (NICE_0_LOAD / task_weight)

Where:
  NICE_0_LOAD = 1024 (weight for nice=0)
  task_weight = derived from nice value (nice -20 = 88761, nice 0 = 1024, nice 19 = 15)
```

Lower nice value = higher weight = slower vruntime growth = more CPU time.

```bash
# Check scheduling information for a process
cat /proc/<pid>/sched
# nr_switches: number of context switches
# nr_voluntary_switches: voluntary switches (blocked on I/O, sleep, etc.)
# nr_involuntary_switches: preempted by scheduler
# se.vruntime: current virtual runtime
# se.load.weight: scheduling weight

# View nice value and scheduling policy
ps -o pid,ni,cls,rtprio,cmd -p <pid>
# NI: nice value (-20 to 19)
# CLS: scheduling class (TS=CFS, FF=FIFO, RR=Round-Robin, IDL=Idle)
# RTPRIO: real-time priority (1-99 for RT tasks)
```

### CFS Tuning Parameters

```bash
# Minimum granularity: minimum time a task runs before being preempted (microseconds)
cat /proc/sys/kernel/sched_min_granularity_ns
# Default: 750000 (750μs)

# Latency target: how long one scheduling pass takes (affects max scheduling delay)
cat /proc/sys/kernel/sched_latency_ns
# Default: 6000000 (6ms)

# Wakeup granularity: preempt running task for newly woken task only if difference > this
cat /proc/sys/kernel/sched_wakeup_granularity_ns
# Default: 1000000 (1ms)

# For lower latency (at cost of higher context switch rate):
echo 500000 > /proc/sys/kernel/sched_min_granularity_ns
echo 3000000 > /proc/sys/kernel/sched_latency_ns
echo 500000 > /proc/sys/kernel/sched_wakeup_granularity_ns

# Migration cost: penalty for moving tasks between CPUs
cat /proc/sys/kernel/sched_migration_cost_ns
# Default: 500000 (500μs)
# Increase to keep tasks on their current CPU (reduces cache misses)
echo 5000000 > /proc/sys/kernel/sched_migration_cost_ns
```

### NUMA Scheduling

On multi-socket systems, NUMA (Non-Uniform Memory Access) awareness is critical:

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
# node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node distances:
# node   0   1
#   0:  10  21

# NUMA balancing: kernel automatically migrates tasks and pages
cat /proc/sys/kernel/numa_balancing
# 1 = enabled (default)

# For latency-sensitive apps, disable NUMA balancing and pin manually
echo 0 > /proc/sys/kernel/numa_balancing

# Run a process on NUMA node 0 with memory from node 0
numactl --cpunodebind=0 --membind=0 -- ./myapp
```

## Section 2: Real-Time Scheduling Classes

### SCHED_FIFO and SCHED_RR

Linux provides two real-time scheduling classes for time-critical tasks:

**SCHED_FIFO (First In, First Out):**
- A FIFO task runs until it blocks or is preempted by a higher-priority RT task
- No time slice; once running, it does not yield to same-priority tasks
- Use when you need guaranteed exclusive CPU time

**SCHED_RR (Round Robin):**
- Like SCHED_FIFO but has a time quantum (default 100ms)
- Tasks at the same priority share CPU time in a round-robin fashion
- Use when multiple tasks at the same priority should share CPU

```bash
# Check RT time quantum
cat /proc/sys/kernel/sched_rr_timeslice_ms
# 100 (100ms)

# Set a process to SCHED_FIFO priority 50
chrt -f 50 ./myapp

# Set a process to SCHED_RR priority 30
chrt -r 30 ./myapp

# Change scheduling class of running process
chrt -f -p 50 <pid>
chrt -r -p 30 <pid>

# Check current scheduling class
chrt -p <pid>
# pid 12345's current scheduling policy: SCHED_FIFO
# pid 12345's current scheduling priority: 50

# Set via systemd service
[Service]
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=50
```

### RT Priority Scale

```
Priority 99 (highest) ── RT kernel threads (watchdog, migration)
           ↓
Priority 50           ── Custom high-priority application
           ↓
Priority 1  (lowest)  ── Lowest RT priority
           ↓
Priority 0            ── Normal (CFS) scheduling
```

WARNING: Setting a process to SCHED_FIFO priority >= 99 can render the system unresponsive. The kernel watchdog runs at priority 99. Keep application RT priorities below 90.

### RT Bandwidth Throttling

To prevent an RT task from starving the system (a runaway RT task at high priority would make the system unresponsive without this):

```bash
# RT throttle: RT tasks can use at most rt_runtime out of every rt_period microseconds
cat /proc/sys/kernel/sched_rt_period_us
# 1000000 (1 second)

cat /proc/sys/kernel/sched_rt_runtime_us
# 950000 (950ms = 95% of RT budget)

# For dedicated RT systems, allow 100% RT usage (DANGEROUS: may starve normal tasks)
echo -1 > /proc/sys/kernel/sched_rt_runtime_us
# -1 = no RT throttling

# More conservative: allow 99% of CPU to RT
echo 990000 > /proc/sys/kernel/sched_rt_runtime_us
```

### SCHED_DEADLINE

`SCHED_DEADLINE` implements the Earliest Deadline First (EDF) algorithm. Each task specifies its runtime (how much CPU it needs), period (how often it needs CPU), and deadline (when it must complete its runtime within the period).

```c
// C code to set SCHED_DEADLINE for a process
#include <linux/sched.h>
#include <sys/syscall.h>

struct sched_attr {
    uint32_t size;
    uint32_t sched_policy;
    uint64_t sched_flags;
    int32_t sched_nice;
    uint32_t sched_priority;
    uint64_t sched_runtime;   // nanoseconds of CPU per period
    uint64_t sched_deadline;  // nanoseconds to complete runtime within period
    uint64_t sched_period;    // period in nanoseconds
};

// Example: task needs 10ms of CPU every 100ms, must finish within 50ms of period start
struct sched_attr attr = {
    .size = sizeof(attr),
    .sched_policy = SCHED_DEADLINE,
    .sched_runtime = 10000000,   // 10ms
    .sched_deadline = 50000000,  // 50ms
    .sched_period = 100000000,   // 100ms
};

syscall(SYS_sched_setattr, pid, &attr, 0);
```

## Section 3: CPU Affinity

### taskset - Basic Affinity

```bash
# Pin a new process to CPU 0 and CPU 1
taskset -c 0,1 ./myapp

# Pin a running process to CPU 2-5
taskset -c 2-5 -p <pid>

# Check current affinity of a process
taskset -c -p <pid>
# pid 12345's current affinity list: 0-31

# Pin to a hex bitmask (bit 0 = CPU 0)
taskset 0x3 ./myapp  # CPUs 0 and 1 (binary: 11)

# System-wide: pin a process to all CPUs on NUMA node 0
numactl --cpunodebind=0 ./myapp
```

### cpuset cgroup Controller

For container and Kubernetes workloads, `cpuset` in the cgroup v1/v2 hierarchy provides persistent affinity:

```bash
# cgroup v1
mkdir /sys/fs/cgroup/cpuset/latency-app

# Assign CPUs
echo "4-7" > /sys/fs/cgroup/cpuset/latency-app/cpuset.cpus

# Assign memory nodes
echo "0" > /sys/fs/cgroup/cpuset/latency-app/cpuset.mems

# Add process to cpuset
echo <pid> > /sys/fs/cgroup/cpuset/latency-app/tasks

# cgroup v2
mkdir /sys/fs/cgroup/latency-app
echo "4-7" > /sys/fs/cgroup/latency-app/cpuset.cpus
echo "0" > /sys/fs/cgroup/latency-app/cpuset.mems
echo <pid> > /sys/fs/cgroup/latency-app/cgroup.procs
```

### Kubernetes CPU Manager

Kubernetes's CPU Manager policy `static` pins Guaranteed QoS pods to exclusive CPUs:

```yaml
# kubelet configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 10s
```

```yaml
# Pod with exclusive CPU pinning (Guaranteed QoS: requests == limits)
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-app
spec:
  containers:
    - name: app
      image: registry.example.com/app:latest
      resources:
        requests:
          cpu: "4"            # 4 exclusive cores
          memory: "2Gi"
        limits:
          cpu: "4"            # Must equal requests for Guaranteed QoS
          memory: "2Gi"
```

```bash
# Verify CPU pinning
kubectl exec -n default latency-sensitive-app -- taskset -c -p 1
# pid 1's current affinity list: 4-7
# (CPUs 4-7 are exclusively allocated to this pod)
```

## Section 4: isolcpus - Kernel Parameter

`isolcpus` removes CPUs from the general scheduler's pool. Only processes explicitly pinned to isolated CPUs will run on them, eliminating scheduler noise from other processes.

```bash
# Current grub default
cat /etc/default/grub | grep GRUB_CMDLINE_LINUX

# Add isolcpus to kernel parameters
GRUB_CMDLINE_LINUX="isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7"

# Parameters explained:
# isolcpus=4-7:     Remove CPUs 4-7 from scheduler's general pool
# nohz_full=4-7:    Disable timer interrupts on these CPUs (reduce OS jitter)
# rcu_nocbs=4-7:    Move RCU callbacks off these CPUs

# Apply changes
update-grub
reboot

# Verify after reboot
cat /sys/devices/system/cpu/isolated
# 4-7

# Check which CPUs kworker threads are on (should avoid isolated CPUs)
ps -eo pid,psr,cmd | grep kworker | head -5
```

### irqbalance and Interrupt Affinity

On isolated CPU systems, ensure hardware interrupts are not routed to isolated CPUs:

```bash
# Check current interrupt assignments
cat /proc/interrupts | head -20

# View interrupt affinity
cat /proc/irq/24/smp_affinity  # hex bitmask
cat /proc/irq/24/smp_affinity_list  # CPU list

# Exclude isolated CPUs from interrupt handling
# Stop irqbalance first
systemctl stop irqbalance

# Set affinity for NIC interrupts to CPUs 0-3 only (not isolated 4-7)
for i in $(ls /proc/irq/); do
    if [ -f /proc/irq/$i/smp_affinity_list ]; then
        echo "0-3" > /proc/irq/$i/smp_affinity_list 2>/dev/null || true
    fi
done

# Configure irqbalance to avoid isolated CPUs
# /etc/default/irqbalance
IRQBALANCE_BANNED_CPUS=f0  # hex: avoid CPUs 4-7 (0xf0 = bits 4-7)
systemctl start irqbalance
```

## Section 5: CPU Frequency and Power States

Scheduling latency is also affected by CPU frequency scaling. P-states control frequency; C-states control sleep depth.

```bash
# Check current frequency governor
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Set performance governor (no frequency scaling, maximum speed)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Or use cpupower
cpupower frequency-set -g performance

# Check available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# performance powersave

# For BIOS-controlled frequency (BIOS sets P-states): use acpi-cpufreq
# For Intel hardware (default modern Intel): use intel_pstate
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# intel_pstate
```

### C-State Management

C-states are CPU idle states. Deeper C-states save power but have higher wakeup latency.

```bash
# Disable deep C-states via kernel parameter
# (forces CPU to stay in C0/C1 - prevents transition latency)
GRUB_CMDLINE_LINUX="intel_idle.max_cstate=1 processor.max_cstate=1"

# At runtime, use /dev/cpu_dma_latency
# Opening this file and writing a latency requirement prevents deeper C-states
# (close the fd to release)
# This is used by real-time frameworks like PREEMPT_RT and audio servers

# Check current C-state usage
powertop --time=5 --csv=/tmp/powertop.csv
grep "C-state" /tmp/powertop.csv
```

## Section 6: cgroups CPU Bandwidth Control

### CFS Bandwidth Throttling

CPU quotas in cgroups implement CPU bandwidth control using the CFS bandwidth throttling mechanism:

```bash
# cgroup v2: set CPU quota
# Allow 200ms CPU time per 1000ms period (20% of one CPU)
echo "200000 1000000" > /sys/fs/cgroup/myapp/cpu.max

# Allow 4 full CPUs worth of CPU time
echo "4000000 1000000" > /sys/fs/cgroup/myapp/cpu.max

# No limit
echo "max 1000000" > /sys/fs/cgroup/myapp/cpu.max

# Check throttling statistics
cat /sys/fs/cgroup/myapp/cpu.stat
# usage_usec 123456789
# user_usec 98765432
# system_usec 24691357
# nr_periods 1000
# nr_throttled 50          <- number of periods where cgroup was throttled
# throttled_usec 500000    <- total time throttled (microseconds)
```

```yaml
# Kubernetes: CPU requests and limits map to cgroup CPU quotas
apiVersion: v1
kind: Pod
spec:
  containers:
    - resources:
        requests:
          cpu: "1"      # Minimum 1 CPU (used for scheduling, not enforcement)
        limits:
          cpu: "2"      # Maximum 2 CPUs (enforced via CFS bandwidth throttle)
                        # Translates to: cpu.max = 200000 100000
                        # (200ms per 100ms period = 2 CPUs)
```

### CPU Throttling Impact on Latency

CFS bandwidth throttling can cause significant p99 latency spikes:

```bash
# Monitor for CPU throttling
kubectl top pod --containers
# If CPU usage approaches limit, expect latency spikes

# Check container throttling
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/cpu.stat

# Prometheus metric for CPU throttling
container_cpu_throttled_seconds_total
container_cpu_cfs_throttled_periods_total

# Alert when throttling rate > 25%
sum(rate(container_cpu_cfs_throttled_periods_total[5m])) by (pod)
/ sum(rate(container_cpu_cfs_periods_total[5m])) by (pod)
> 0.25
```

## Section 7: PREEMPT_RT Kernel Patches

For the most demanding real-time applications, the PREEMPT_RT patch set converts Linux into a fully preemptible kernel:

```bash
# Check if current kernel has PREEMPT_RT
uname -r
# 6.6.0-rt12-generic (RT kernel)

grep PREEMPT_RT /boot/config-$(uname -r)
# CONFIG_PREEMPT_RT=y

# Key differences in RT kernel:
# - Spinlocks converted to sleeping locks (preemptible)
# - Hard IRQ handlers made preemptible threads
# - High-resolution timers enabled by default
# - Priority inheritance for all locks

# Check scheduling latency with cyclictest
apt-get install rt-tests
cyclictest -l 100000 -m -p 80 -i 200 -n
# -l 100000: run 100000 loops
# -m: lock memory (prevent page faults)
# -p 80: run at RT priority 80
# -i 200: check every 200 microseconds
# -n: use clock_nanosleep

# Typical output on RT kernel:
# T: 0 (12345) P:80 I:200 C:100000 Min:   4 Act:   7 Avg:   6 Max:  45
#                                                              ^^^
#                                                         Max jitter: 45μs
```

## Section 8: Memory Locking for RT Applications

Page faults cause scheduling latency. RT applications lock their memory to prevent faults:

```bash
# Lock all current and future memory of a process
ulimit -l unlimited
# Or in /etc/security/limits.conf:
# myrtuser hard memlock unlimited
# myrtuser soft memlock unlimited
```

```c
// C code for memory locking in RT applications
#include <sys/mman.h>
#include <limits.h>

int setup_realtime_memory(void) {
    // Lock all current mappings
    if (mlockall(MCL_CURRENT | MCL_FUTURE) < 0) {
        perror("mlockall");
        return -1;
    }

    // Pre-fault stack by writing to it
    char stack_prefault[PTHREAD_STACK_MIN * 4];
    memset(stack_prefault, 0, sizeof(stack_prefault));

    return 0;
}
```

In Kubernetes, privileged pods or pods with `IPC_LOCK` capability can use `mlockall`:

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - securityContext:
        capabilities:
          add:
            - IPC_LOCK  # Allows mlockall
```

## Section 9: Complete Production Configuration

The following script configures a Kubernetes node for hosting latency-sensitive workloads on CPUs 4-7:

```bash
#!/bin/bash
# configure-rt-node.sh
set -euo pipefail

ISOLATED_CPUS="4-7"
HOUSEKEEPING_CPUS="0-3"

echo "=== Configuring RT Node ==="

# 1. Scheduler tuning
echo 500000 > /proc/sys/kernel/sched_min_granularity_ns
echo 3000000 > /proc/sys/kernel/sched_latency_ns
echo 500000 > /proc/sys/kernel/sched_wakeup_granularity_ns
echo 5000000 > /proc/sys/kernel/sched_migration_cost_ns
echo 0 > /proc/sys/kernel/numa_balancing

# 2. CPU frequency governor
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu" 2>/dev/null || true
done

# 3. Redirect IRQs to housekeeping CPUs
systemctl stop irqbalance || true
for irq in /proc/irq/*/smp_affinity_list; do
    echo "$HOUSEKEEPING_CPUS" > "$irq" 2>/dev/null || true
done

# 4. Move kernel threads off isolated CPUs
for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
    comm=$(cat /proc/$pid/comm 2>/dev/null || echo "")
    if echo "$comm" | grep -qE "kworker|ksoftirq|kthread"; then
        taskset -c -p "$HOUSEKEEPING_CPUS" "$pid" 2>/dev/null || true
    fi
done

# 5. Configure kubelet CPU manager
cat > /etc/kubernetes/kubelet-cpu.yaml <<EOF
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
reservedSystemCPUs: "${HOUSEKEEPING_CPUS}"
EOF

echo "=== RT Node Configuration Complete ==="
echo "Isolated CPUs: ${ISOLATED_CPUS}"
echo "Housekeeping CPUs: ${HOUSEKEEPING_CPUS}"
echo "Pods with Guaranteed QoS and integer CPU requests will be pinned to isolated CPUs"
```

### Verifying Low Latency Configuration

```bash
# Measure scheduling jitter with cyclictest
cyclictest -l 1000000 -m -p 80 -i 1000 -n -a 4-7
# Should see Max latency < 100μs on properly configured system
# > 1ms indicates interrupt or page fault issues
# > 10ms indicates serious configuration problem

# Monitor live latency percentiles
taskset -c 4 cyclictest -p 80 -i 200 -n -m -q &
CYCLIC_PID=$!
sleep 60
kill $CYCLIC_PID

# Check for dropped scheduling deadlines
cat /proc/schedstat
# Per-CPU statistics including time spent waiting on run queue

# Use perf to trace scheduling events
perf sched record -- sleep 10
perf sched latency
# Shows scheduling latency histogram with max and average wait times
```

Combining CPU isolation, real-time scheduling classes, memory locking, interrupt affinity, and CFS tuning creates an environment where latency-sensitive applications can meet their timing requirements consistently. The key is measuring latency before and after each change to quantify the improvement and verify you've addressed the actual bottleneck.
