---
title: "Linux Scheduler Deep Dive: CFS, Real-Time Scheduling, and CPU Affinity"
date: 2030-01-01T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Scheduler", "CFS", "Real-Time", "CPU Affinity", "NUMA", "cgroups", "Performance", "Latency"]
categories:
- Linux
- Kernel
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to the Completely Fair Scheduler, RT scheduling classes, CPU affinity, NUMA scheduling, cgroups CPU bandwidth, and latency tuning for enterprise Linux systems."
more_link: "yes"
url: "/linux-scheduler-deep-dive-cfs-realtime-scheduling-cpu-affinity/"
---

The Linux scheduler is one of the most consequential components of the kernel for application performance, yet most systems engineers interact with it only when something goes wrong. Understanding CFS, real-time scheduling classes, CPU affinity, and NUMA topology enables deliberate performance tuning rather than trial-and-error sysctl adjustments. This guide covers the scheduler from theory to production configuration.

<!--more-->

## Section 1: Completely Fair Scheduler (CFS)

CFS is the default scheduler for normal processes (scheduling class `SCHED_OTHER`/`SCHED_NORMAL`). It aims to give each runnable process a fair share of CPU time by maintaining a red-black tree sorted by virtual runtime (vruntime) — the amount of CPU time a task has consumed, weighted by its priority (nice value).

### CFS Key Concepts

- **vruntime**: Accumulated CPU time weighted by inverse of priority. Lower vruntime = more scheduler debt = scheduled next.
- **sched_latency_ns**: Target latency for each task to run once (default: 6–24 ms depending on number of tasks).
- **sched_min_granularity_ns**: Minimum time a task runs before it can be preempted (default: 0.75 ms).
- **Load balancing**: CFS balances load across CPU cores periodically and on task wakeup.

### Inspecting CFS Scheduler State

```bash
# View per-CPU scheduler statistics.
cat /proc/schedstat

# View per-task scheduler statistics.
cat /proc/<pid>/schedstat
# Fields: cpu_time, wait_time, run_count

# View scheduler debug info (requires CONFIG_SCHED_DEBUG=y).
cat /proc/sched_debug

# Monitor context switches per second.
vmstat 1 | awk '{print $12, $13}'  # cs (context switches), in (interrupts)

# Trace scheduler events with perf.
perf sched record -- sleep 10
perf sched latency

# Show task scheduling latency histogram.
perf sched timehist | head -50
```

### CFS Tuning Parameters

```bash
# View current CFS tuning knobs.
sysctl -a | grep kernel.sched

# Key tunable: target latency (nanoseconds).
# Lower = more responsive; higher = better throughput.
# Default: 6000000 (6ms).
sysctl kernel.sched_latency_ns

# Minimum preemption granularity.
# Default: 750000 (0.75ms).
sysctl kernel.sched_min_granularity_ns

# Wakeup granularity: when a woken task preempts the current one.
# Default: 1000000 (1ms).
sysctl kernel.sched_wakeup_granularity_ns

# Tune for latency-sensitive workloads (reduces throughput slightly).
sysctl -w kernel.sched_latency_ns=1000000
sysctl -w kernel.sched_min_granularity_ns=100000
sysctl -w kernel.sched_wakeup_granularity_ns=200000

# Make persistent in /etc/sysctl.d/99-scheduler.conf.
cat >> /etc/sysctl.d/99-scheduler.conf << 'EOF'
kernel.sched_latency_ns = 1000000
kernel.sched_min_granularity_ns = 100000
kernel.sched_wakeup_granularity_ns = 200000
EOF
```

## Section 2: Nice Values and Priority

Nice values (-20 to +19) adjust the weight of a task in CFS. Each nice unit corresponds to a ~10% CPU time difference.

```bash
# Run a command with lower priority (nice 10 = ~40% less CPU weight than nice 0).
nice -n 10 ./myjob

# Renice a running process.
renice -n 5 -p <pid>
renice -n -5 -p <pid>  # Requires CAP_SYS_NICE or root.

# View current nice values.
ps -eo pid,ni,comm | sort -k2 -n

# Set nice programmatically in Go.
import "syscall"
syscall.Setpriority(syscall.PRIO_PROCESS, 0, 10) // nice = 10 for current process
```

### I/O Priority (ionice)

```bash
# Set I/O scheduler class for a process.
# Class 1 = real-time, class 2 = best-effort (default), class 3 = idle.
ionice -c 2 -n 0 ./myjob   # Best-effort, highest priority.
ionice -c 3 ./backup-job    # Idle: only runs when no other I/O.

# View current I/O priority.
ionice -p <pid>
```

## Section 3: Real-Time Scheduling Classes

Linux provides three real-time scheduling classes that bypass CFS:

| Class | Policy Constant | Priority Range | Behavior |
|---|---|---|---|
| `SCHED_FIFO` | 1 | 1–99 | Runs until it blocks or yields; higher number = higher priority |
| `SCHED_RR` | 2 | 1–99 | Round-robin among equal-priority RT tasks with configurable timeslice |
| `SCHED_DEADLINE` | 6 | N/A | EDF scheduling with runtime, deadline, and period constraints |

### SCHED_FIFO and SCHED_RR

```bash
# Run a process with SCHED_FIFO at priority 50.
# Requires CAP_SYS_NICE or RLIMIT_RTPRIO.
chrt -f 50 ./realtime-process

# Run with SCHED_RR at priority 30.
chrt -r 30 ./realtime-process

# Change scheduling policy of a running process.
chrt -f -p 50 <pid>

# View scheduling policy and priority.
chrt -p <pid>

# SCHED_RR timeslice (default: 100ms).
cat /proc/sys/kernel/sched_rr_timeslice_ms
sysctl -w kernel.sched_rr_timeslice_ms=5  # 5ms timeslice for RT tasks.
```

### Setting RT Priority Programmatically

```go
package rtutil

import (
    "fmt"
    "syscall"
    "unsafe"
)

// SchedParam matches struct sched_param in Linux.
type SchedParam struct {
    Priority int32
}

const (
    SCHED_OTHER   = 0
    SCHED_FIFO    = 1
    SCHED_RR      = 2
    SCHED_BATCH   = 3
    SCHED_IDLE    = 5
    SCHED_DEADLINE = 6
)

// SetSchedFIFO sets the current thread to SCHED_FIFO with the given priority.
// Requires CAP_SYS_NICE or an appropriate RLIMIT_RTPRIO.
func SetSchedFIFO(priority int) error {
    param := SchedParam{Priority: int32(priority)}
    ret, _, errno := syscall.Syscall(
        syscall.SYS_SCHED_SETSCHEDULER,
        0, // 0 = current thread
        uintptr(SCHED_FIFO),
        uintptr(unsafe.Pointer(&param)),
    )
    if ret != 0 {
        return fmt.Errorf("sched_setscheduler: %w", errno)
    }
    return nil
}

// GetSchedPolicy returns the scheduling policy for the current thread.
func GetSchedPolicy() (int, int, error) {
    var param SchedParam
    ret, _, errno := syscall.Syscall(
        syscall.SYS_SCHED_GETPARAM,
        0,
        uintptr(unsafe.Pointer(&param)),
        0,
    )
    if ret != 0 {
        return 0, 0, fmt.Errorf("sched_getparam: %w", errno)
    }
    policy, _, _ := syscall.Syscall(syscall.SYS_SCHED_GETSCHEDULER, 0, 0, 0)
    return int(policy), int(param.Priority), nil
}
```

### SCHED_DEADLINE — Deadline-Based Scheduling

SCHED_DEADLINE implements Earliest Deadline First (EDF) scheduling. A task declares its runtime (how much CPU it needs per period), deadline, and period:

```bash
# Set SCHED_DEADLINE: 5ms runtime, 10ms deadline, 10ms period.
# deadline_runtime_ns <= deadline_ns <= period_ns
chrt -d --sched-runtime 5000000 --sched-deadline 10000000 --sched-period 10000000 ./audio-encoder

# Real-time throttling: limit RT tasks to 95% of CPU time.
# (The remaining 5% ensures the system remains responsive.)
sysctl kernel.sched_rt_runtime_us   # Default: 950000 (950ms per 1s period)
sysctl kernel.sched_rt_period_us    # Default: 1000000 (1s)

# Disable RT throttling for dedicated real-time systems.
sysctl -w kernel.sched_rt_runtime_us=-1  # -1 disables throttling.
```

## Section 4: CPU Affinity

CPU affinity binds a process or thread to a set of CPUs, preventing the scheduler from migrating it. This reduces cache misses and improves predictable latency.

### Setting CPU Affinity

```bash
# Bind a process to CPUs 0 and 1.
taskset -c 0,1 ./myprocess

# Set affinity of a running process.
taskset -c 0,1 -p <pid>

# View current CPU affinity.
taskset -p <pid>

# Bind to CPUs using a hexadecimal mask (bit 0 = CPU 0).
taskset 0x3 ./myprocess  # CPUs 0 and 1.
taskset 0xf ./myprocess  # CPUs 0-3.
```

### CPU Affinity in Go

```go
package cpuaffinity

import (
    "fmt"
    "runtime"
    "syscall"
    "unsafe"
)

// CPUSet matches cpu_set_t in Linux (128 bytes for up to 1024 CPUs).
type CPUSet [16]uint64

// Set sets the bit for CPU n.
func (s *CPUSet) Set(n int) {
    s[n/64] |= 1 << uint(n%64)
}

// Clear clears the bit for CPU n.
func (s *CPUSet) Clear(n int) {
    s[n/64] &^= 1 << uint(n%64)
}

// IsSet returns true if CPU n is in the set.
func (s *CPUSet) IsSet(n int) bool {
    return s[n/64]&(1<<uint(n%64)) != 0
}

// SetAffinity binds the current goroutine's OS thread to the specified CPUs.
// Must call runtime.LockOSThread() before this function.
func SetAffinity(cpus []int) error {
    var set CPUSet
    for _, cpu := range cpus {
        if cpu < 0 || cpu >= 1024 {
            return fmt.Errorf("invalid CPU number: %d", cpu)
        }
        set.Set(cpu)
    }
    _, _, errno := syscall.Syscall(
        syscall.SYS_SCHED_SETAFFINITY,
        0, // 0 = current thread
        uintptr(unsafe.Sizeof(set)),
        uintptr(unsafe.Pointer(&set)),
    )
    if errno != 0 {
        return fmt.Errorf("sched_setaffinity: %w", errno)
    }
    return nil
}

// PinThread pins the current goroutine to a single CPU.
// Returns a cleanup function that unlocks the OS thread.
func PinThread(cpu int) (cleanup func(), err error) {
    runtime.LockOSThread()
    if err = SetAffinity([]int{cpu}); err != nil {
        runtime.UnlockOSThread()
        return nil, err
    }
    return runtime.UnlockOSThread, nil
}
```

## Section 5: NUMA Scheduling

On multi-socket servers, memory latency varies depending on whether a CPU accesses local or remote NUMA node memory. The kernel's NUMA balancing moves tasks and pages to minimize remote memory accesses.

### Inspecting NUMA Topology

```bash
# View NUMA node topology.
numactl --hardware

# Example output:
# node 0 cpus: 0-23 48-71
# node 1 cpus: 24-47 72-95
# node 0 size: 128951 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# View NUMA memory usage.
numastat -m

# Show per-process NUMA memory statistics.
numastat -p <pid>
```

### NUMA-Aware Process Placement

```bash
# Run on NUMA node 0, with memory allocated from node 0.
numactl --cpunodebind=0 --membind=0 ./myprocess

# Interleave memory across all nodes (useful for parallel workloads).
numactl --interleave=all ./myprocess

# Prefer node 0 memory but allow remote allocation if needed.
numactl --preferred=0 ./myprocess

# Set NUMA policy for a running process.
# (Requires restarting with numactl; cannot change after start easily.)
```

### NUMA Tuning

```bash
# Enable automatic NUMA balancing (default: enabled).
sysctl kernel.numa_balancing

# NUMA balancing scan delay (ms). Lower = more aggressive migration.
sysctl kernel.numa_balancing_scan_delay_ms
sysctl -w kernel.numa_balancing_scan_delay_ms=500

# For latency-critical workloads, disable automatic NUMA balancing
# and manually bind processes to NUMA nodes.
sysctl -w kernel.numa_balancing=0
```

## Section 6: cgroups CPU Bandwidth Control

cgroups v2 CPU bandwidth allows enforcing CPU time limits and relative weights.

### CPU Weight (Shares)

```bash
# CPU weight in cgroups v2 (range: 1-10000, default: 100).
# A cgroup with weight 200 gets 2x the CPU of one with weight 100.

# Set weight for a systemd service.
systemctl set-property myservice.service CPUWeight=200

# Direct cgroup manipulation.
echo 200 > /sys/fs/cgroup/myapp/cpu.weight
```

### CPU Quota (Bandwidth)

```bash
# CPU quota limits maximum CPU time in a period.
# cpu.max format: "quota_us period_us"
# Example: allow 50ms per 100ms = 50% of one CPU.
echo "50000 100000" > /sys/fs/cgroup/myapp/cpu.max

# Allow 200% (2 CPUs) out of 100ms period.
echo "200000 100000" > /sys/fs/cgroup/myapp/cpu.max

# Unlimited (default).
echo "max 100000" > /sys/fs/cgroup/myapp/cpu.max

# Via systemd.
systemctl set-property myservice.service CPUQuota=150%  # 1.5 CPUs
```

### Kubernetes CPU Requests and Limits Mapping

Kubernetes maps CPU resources to cgroup parameters:

- `requests.cpu` → `cpu.weight` (relative scheduling weight)
- `limits.cpu` → `cpu.max` (hard quota)

```yaml
resources:
  requests:
    cpu: "500m"   # → cpu.weight = 50 (approximately)
  limits:
    cpu: "2"      # → cpu.max = "200000 100000" (200ms per 100ms period)
```

```bash
# Inspect cgroup settings for a Kubernetes pod.
CONTAINER_ID=$(crictl ps | grep mypod | awk '{print $1}')
CGROUP_PATH=$(crictl inspect $CONTAINER_ID | jq -r '.info.runtimeSpec.linux.cgroupsPath')
cat /sys/fs/cgroup/${CGROUP_PATH}/cpu.max
cat /sys/fs/cgroup/${CGROUP_PATH}/cpu.weight
```

## Section 7: Isolcpus and CPU Isolation for Low-Latency

For the lowest possible scheduling jitter, isolate CPUs from the kernel scheduler entirely:

```bash
# Kernel boot parameter: isolate CPUs 2-7 from the scheduler.
# Edit /etc/default/grub:
# GRUB_CMDLINE_LINUX="... isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7"

# Update grub and reboot.
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot

# After reboot, verify isolation.
cat /sys/devices/system/cpu/isolated

# Pin a real-time process to isolated CPUs.
taskset -c 2-7 chrt -f 80 ./low-latency-process

# Move kernel threads away from isolated CPUs (optional, manual).
for pid in $(ps -eLo pid,comm | grep '\[k' | awk '{print $1}'); do
    taskset -p 0x3 "$pid" 2>/dev/null  # Allow only CPUs 0-1 for kernel threads.
done
```

### Measuring Scheduling Latency

```bash
# Cyclictest measures real-time scheduling latency.
apt-get install -y rt-tests

# Run cyclictest for 60 seconds measuring latency on CPU 2.
cyclictest --mlockall -t1 -p 80 -n -a 2 -D 60s --histogram=400

# Output shows latency percentiles:
# T: 0 (16928) A: 3 C: 3600000 Min: 1 Act: 3 Avg: 3 Max: 47
# (Max latency: 47 microseconds)

# Use hwlatdetect to measure hardware-induced latency (SMI, etc.).
hwlatdetect --duration 60s --threshold 10
```

## Section 8: Latency Tuning Summary

Combine multiple techniques for minimum latency:

```bash
#!/bin/bash
# latency-tune.sh — Apply a comprehensive set of latency tuning parameters.

# Disable CPU frequency scaling (use performance governor).
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu" 2>/dev/null || true
done

# Disable CPU C-states deeper than C1 to avoid wake-up latency.
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
    state=$(echo "$cpu" | grep -oE 'state[0-9]+' | grep -oE '[0-9]+')
    if [ "$state" -gt 1 ]; then
        echo 1 > "$cpu" 2>/dev/null || true
    fi
done

# Disable transparent huge pages (can cause latency spikes during defrag).
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Disable NUMA balancing for pinned processes.
sysctl -w kernel.numa_balancing=0

# Set RT throttling to unlimited for the real-time process group.
sysctl -w kernel.sched_rt_runtime_us=-1

# Increase scheduler granularity for lower latency.
sysctl -w kernel.sched_latency_ns=1000000
sysctl -w kernel.sched_min_granularity_ns=100000
sysctl -w kernel.sched_wakeup_granularity_ns=25000

# Reduce timer interrupt frequency on isolated CPUs (requires nohz_full boot param).
# Already handled by the isolcpus/nohz_full kernel parameter.

# Lock application memory to prevent page faults under load.
# (Do this in the application itself with mlockall(MCL_CURRENT | MCL_FUTURE).)

echo "Latency tuning applied."
cyclictest --mlockall -t1 -p 80 -n -D 10s 2>&1 | tail -5
```

The Linux scheduler provides extraordinary flexibility for the full spectrum from throughput-optimized batch workloads through microsecond-latency real-time systems. The path from understanding CFS vruntime to isolcpus-based CPU isolation is a continuum of increasingly precise control. Most enterprise applications need only cgroup CPU weights and occasional `nice` adjustments; real-time applications require the full stack from SCHED_FIFO through isolcpus and hardware latency analysis.
