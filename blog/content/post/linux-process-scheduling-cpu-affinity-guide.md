---
title: "Linux Process Scheduling and CPU Affinity for Latency-Sensitive Workloads"
date: 2028-05-02T00:00:00-05:00
draft: false
tags: ["Linux", "Scheduler", "CPU Affinity", "NUMA", "Real-time", "Latency"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A technical deep dive into Linux process scheduling, CPU affinity management, real-time scheduling policies, NUMA-aware placement, and kernel tuning for latency-sensitive workloads including trading systems, media processing, and telco applications."
more_link: "yes"
url: "/linux-process-scheduling-cpu-affinity-guide/"
---

Linux scheduling is sophisticated enough to run latency-sensitive workloads with microsecond response times, but only when properly configured. Understanding the CFS scheduler's interaction with NUMA topology, isolating CPUs from the scheduler, using real-time scheduling policies, and managing interrupt affinity are the foundation skills for anyone responsible for systems where latency variance matters.

<!--more-->

# Linux Process Scheduling and CPU Affinity for Latency-Sensitive Workloads

## The Linux Scheduler: CFS and Its Overhead

The Completely Fair Scheduler (CFS) is the default scheduler for most processes. It maintains a red-black tree of runnable tasks ordered by virtual runtime (`vruntime`). The scheduler picks the task with the smallest `vruntime` at each scheduling tick and preempts it when a timer fires or a higher-priority task becomes runnable.

Key CFS parameters:

- **sched_min_granularity_ns**: Minimum time a task runs before being preemptible (default: 4 ms on most systems)
- **sched_latency_ns**: Target scheduling latency - how long before a runnable task gets CPU time (default: 24 ms)
- **sched_migration_cost_ns**: Estimated cost of migrating a task between CPUs; affects when tasks move (default: 500 µs)

```bash
# View current CFS tunables
cat /proc/sys/kernel/sched_min_granularity_ns
cat /proc/sys/kernel/sched_latency_ns
cat /proc/sys/kernel/sched_migration_cost_ns
cat /proc/sys/kernel/sched_nr_migrate

# For latency-sensitive workloads: reduce scheduling latency
sysctl -w kernel.sched_min_granularity_ns=1000000   # 1ms
sysctl -w kernel.sched_latency_ns=3000000            # 3ms
sysctl -w kernel.sched_migration_cost_ns=5000000     # 5ms (prevent excessive migration)
```

## CPU Topology Awareness

Modern CPUs are far from uniform. Understanding topology is prerequisite to effective scheduling:

```bash
# View full CPU topology
lscpu -e

# CPU layout with NUMA nodes, sockets, cores, threads
lstopo --output-format console

# View NUMA topology
numactl --hardware

# View per-CPU cache topology
cat /sys/devices/system/cpu/cpu0/cache/index*/size

# Identify hyperthreading siblings
cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list
# Example: "0,24" means cpu0 and cpu24 share the same physical core

# View NUMA distance matrix
cat /sys/devices/system/node/node*/distance
# Lower numbers = faster memory access
```

### Why Topology Matters for Latency

On a 2-socket server with 2 NUMA nodes:
- Intra-core communication (L1/L2 cache): ~1-4 ns
- Intra-socket communication (LLC cache): ~10-30 ns
- Inter-socket NUMA communication: ~80-150 ns
- Remote NUMA memory access: ~100-300 ns overhead vs local

A latency-sensitive process that migrates between NUMA nodes will see memory latency spikes orders of magnitude larger than its target response time.

## CPU Affinity Management

### taskset: Pin Processes to CPUs

```bash
# Run a program pinned to CPU 2
taskset -c 2 ./myapp

# Run on a range of CPUs
taskset -c 4-7 ./myapp

# Run on specific CPUs (not contiguous)
taskset -c 0,4,8,12 ./myapp

# Pin an already-running process
taskset -cp 0,4 <PID>

# View current CPU affinity
taskset -cp <PID>

# Using hex mask (bit 0 = CPU 0, bit 1 = CPU 1, etc.)
taskset -p 0x00ff <PID>  # Allow CPUs 0-7

# Pin process to a NUMA node's CPUs
numactl --cpunodebind=0 --membind=0 ./myapp
```

### Programmatic CPU Affinity in C/Go

```c
// C: Set CPU affinity
#include <sched.h>
#include <stdio.h>

int pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);

    if (sched_setaffinity(0, sizeof(set), &set) != 0) {
        perror("sched_setaffinity");
        return -1;
    }
    return 0;
}

// Pin to a range of CPUs
int pin_to_cpus(int start, int end) {
    cpu_set_t set;
    CPU_ZERO(&set);
    for (int i = start; i <= end; i++) {
        CPU_SET(i, &set);
    }
    return sched_setaffinity(0, sizeof(set), &set);
}
```

```go
// Go: CPU affinity via syscall
package affinity

import (
    "fmt"
    "runtime"
    "syscall"
    "unsafe"
)

// SetCPUAffinity pins the current goroutine's OS thread to a specific CPU.
// Call runtime.LockOSThread() before this to ensure the goroutine stays on the thread.
func SetCPUAffinity(cpus ...int) error {
    runtime.LockOSThread()

    // Build cpu_set_t (128 bytes = 1024 CPUs)
    var set [128 / 8]byte

    for _, cpu := range cpus {
        if cpu >= 1024 {
            return fmt.Errorf("CPU %d exceeds maximum (1023)", cpu)
        }
        set[cpu/8] |= 1 << (uint(cpu) % 8)
    }

    _, _, errno := syscall.RawSyscall(
        syscall.SYS_SCHED_SETAFFINITY,
        0, // 0 = current thread
        uintptr(len(set)),
        uintptr(unsafe.Pointer(&set[0])),
    )
    if errno != 0 {
        return fmt.Errorf("sched_setaffinity: %w", errno)
    }

    return nil
}

// GetCPUAffinity returns the current CPU affinity mask.
func GetCPUAffinity() ([]int, error) {
    var set [128 / 8]byte

    _, _, errno := syscall.RawSyscall(
        syscall.SYS_SCHED_GETAFFINITY,
        0,
        uintptr(len(set)),
        uintptr(unsafe.Pointer(&set[0])),
    )
    if errno != 0 {
        return nil, fmt.Errorf("sched_getaffinity: %w", errno)
    }

    var cpus []int
    for i := 0; i < 1024; i++ {
        if set[i/8]&(1<<(uint(i)%8)) != 0 {
            cpus = append(cpus, i)
        }
    }
    return cpus, nil
}
```

## CPU Isolation with isolcpus

The strongest CPU isolation removes CPUs entirely from the scheduler's general-purpose pool. Isolated CPUs are only used by processes explicitly assigned to them.

### Kernel Boot Parameter Isolation

```bash
# /etc/default/grub: add isolcpus to GRUB_CMDLINE_LINUX
GRUB_CMDLINE_LINUX="isolcpus=4-7,12-15 nohz_full=4-7,12-15 rcu_nocbs=4-7,12-15"

# isolcpus=4-7,12-15: Remove these CPUs from scheduler
# nohz_full=4-7,12-15: Disable timer ticks on idle isolated CPUs
# rcu_nocbs=4-7,12-15: Offload RCU callbacks from isolated CPUs

update-grub
reboot
```

After reboot, verify isolation:

```bash
# Check which CPUs are isolated
cat /sys/devices/system/cpu/isolated
# Should show: 4-7,12-15

# Verify scheduler doesn't use isolated CPUs
taskset -c 0-3,8-11 cat /proc/self/status | grep Cpus_allowed
```

### cgroups cpuset for Process Isolation

cgroup cpuset is more flexible than isolcpus and can be changed at runtime:

```bash
# Create a cpuset cgroup for latency-sensitive workloads
mkdir -p /sys/fs/cgroup/cpuset/realtime

# Assign CPUs 4-7 to this cgroup (exclusive = not shared with other cgroups)
echo 4-7 > /sys/fs/cgroup/cpuset/realtime/cpuset.cpus
echo 0 > /sys/fs/cgroup/cpuset/realtime/cpuset.mems  # NUMA node 0

# Enable exclusive CPU assignment (no sharing with parent cgroup)
echo 1 > /sys/fs/cgroup/cpuset/realtime/cpuset.cpu_exclusive

# Remove CPUs 4-7 from the root cgroup (system processes won't use them)
echo 0-3,8-$(nproc --all | xargs -I{} expr {} - 1) \
  > /sys/fs/cgroup/cpuset/cpuset.cpus

# Move process into the isolated cgroup
echo <PID> > /sys/fs/cgroup/cpuset/realtime/cgroup.procs
```

For cgroup v2 (modern systems):

```bash
# Create cpuset partition for isolated workload
mkdir -p /sys/fs/cgroup/realtime

# Enable cpuset controller
echo "+cpuset" > /sys/fs/cgroup/cgroup.subtree_control

# Set partition type to "root" for exclusive CPU access
echo "root" > /sys/fs/cgroup/realtime/cpuset.cpus.partition

# Assign CPUs
echo "4-7" > /sys/fs/cgroup/realtime/cpuset.cpus

# Assign workload
echo <PID> > /sys/fs/cgroup/realtime/cgroup.procs
```

## Real-Time Scheduling Policies

Linux supports three scheduling policies beyond CFS for real-time requirements:

| Policy | Name | Priority | Behavior |
|--------|------|----------|----------|
| `SCHED_OTHER` | CFS | 0 | Default; uses nice values |
| `SCHED_FIFO` | RT FIFO | 1-99 | Runs until blocked or preempted by higher RT priority |
| `SCHED_RR` | RT Round Robin | 1-99 | FIFO but with a quantum; same-priority tasks take turns |
| `SCHED_DEADLINE` | Deadline | N/A | CBS-based; deadline, period, runtime parameters |

Higher RT priority number = higher priority (99 is highest). RT tasks preempt CFS tasks and lower-priority RT tasks.

### Using SCHED_FIFO and SCHED_RR

```bash
# Run a process with SCHED_FIFO at priority 50
chrt --fifo 50 ./latency-critical-process

# Run with SCHED_RR
chrt --rr 50 ./latency-critical-process

# Change scheduling of a running process
chrt --fifo -p 50 <PID>

# View current scheduling policy
chrt -p <PID>

# View max RT priority
cat /proc/sys/kernel/sched_rt_priority_max
```

### SCHED_DEADLINE for Periodic Workloads

SCHED_DEADLINE gives the strongest guarantees for periodic tasks with known worst-case execution time:

```c
#include <linux/sched.h>
#include <sys/syscall.h>

struct sched_attr {
    __u32 size;
    __u32 sched_policy;
    __u64 sched_flags;
    __s32 sched_nice;
    __u32 sched_priority;
    __u64 sched_runtime;   // Execution budget per period (ns)
    __u64 sched_deadline;  // Absolute deadline relative to period (ns)
    __u64 sched_period;    // Period (ns)
};

int set_deadline_scheduling(
    pid_t pid,
    unsigned long long runtime_ns,
    unsigned long long deadline_ns,
    unsigned long long period_ns
) {
    struct sched_attr attr = {
        .size          = sizeof(attr),
        .sched_policy  = SCHED_DEADLINE,
        .sched_runtime = runtime_ns,
        .sched_deadline = deadline_ns,
        .sched_period  = period_ns,
    };

    return syscall(SYS_sched_setattr, pid, &attr, 0);
}

// Example: 1ms budget every 10ms period (10% CPU)
// set_deadline_scheduling(0, 1000000, 5000000, 10000000);
```

### RT Priority Limits

By default, Linux limits RT processes to 95% of CPU to prevent starvation of system processes:

```bash
# View RT bandwidth limits
cat /proc/sys/kernel/sched_rt_period_us  # Period (default: 1,000,000 µs = 1s)
cat /proc/sys/kernel/sched_rt_runtime_us # Max RT runtime per period (default: 950,000 µs = 950ms)

# Allow RT processes to use 100% of CPU (dangerous - can lock up system)
sysctl -w kernel.sched_rt_runtime_us=-1

# Allow 99% CPU for RT
sysctl -w kernel.sched_rt_runtime_us=990000
```

## Interrupt Affinity (IRQ Balancing)

Hardware interrupts (network cards, storage, timers) can cause latency spikes when they fire on the same CPUs as your critical workloads. IRQ affinity directs interrupts to specific CPUs.

```bash
# List all IRQs and their current affinity
cat /proc/interrupts
cat /proc/irq/*/smp_affinity_list

# View interrupts in human-readable form
for irq in /proc/irq/*/smp_affinity_list; do
    irqnum=$(echo "$irq" | grep -oP '\d+(?=/smp)')
    printf "IRQ %3d: %s (%s)\n" "$irqnum" "$(cat $irq)" \
      "$(cat /proc/irq/${irqnum}/node)"
done 2>/dev/null

# Disable irqbalance daemon (required for manual IRQ pinning)
systemctl stop irqbalance
systemctl disable irqbalance

# Direct all NIC interrupts to CPUs 0-3 (non-isolated CPUs)
for irq in $(cat /proc/interrupts | grep -E "eth0|ens3|enp" | awk '{print $1}' | tr -d ':'); do
    echo "0-3" > /proc/irq/${irq}/smp_affinity_list
done

# Move timer interrupts away from isolated CPUs
for cpu in 4 5 6 7; do
    echo "0-3" > /proc/irq/0/smp_affinity_list 2>/dev/null || true
done
```

### Network Card Multi-Queue Affinity

Modern NICs have multiple queue pairs. Distribute them across non-isolated CPUs:

```bash
# Check number of NIC queues
ethtool -l eth0

# View current queue IRQ assignment
cat /proc/interrupts | grep eth0

# Set combined queues to match non-isolated CPUs
ethtool -L eth0 combined 4  # 4 queues for CPUs 0-3

# Pin each queue to a specific CPU
Q=0
for irq in $(cat /proc/interrupts | grep "eth0" | awk '{print $1}' | tr -d ':'); do
    echo $Q > /proc/irq/${irq}/smp_affinity_list
    ((Q++))
done
```

## NUMA Topology and Memory Pinning

For workloads sensitive to memory latency, pin both CPUs and memory to the same NUMA node:

```bash
# Run on NUMA node 0 only (both CPU and memory local)
numactl --cpunodebind=0 --membind=0 ./myapp

# Or for a running process, use memhog to migrate anonymous pages
numactl --membind=0 cat /dev/zero > /dev/null &  # Bad example, just for demo

# Check page placement for a process
cat /proc/<PID>/numa_maps | head -20
# Format: address policy node_pages
# 7f8a0000000 default N0=1234 N1=56
# N0=1234 means 1234 pages on NUMA node 0

# Move anonymous pages to local NUMA node
migrate_pages <PID> <from_node> <to_node>
```

### NUMA-Aware Memory Allocation in C

```c
#include <numa.h>
#include <numaif.h>

// Allocate memory on a specific NUMA node
void* numa_alloc_on_node(size_t size, int node) {
    return numa_alloc_onnode(size, node);
}

// Allocate interleaved across all nodes (good for distributed data)
void* numa_alloc_interleaved(size_t size) {
    return numa_alloc_interleaved(size);
}

// Set memory policy for current process
int set_local_alloc_policy() {
    struct bitmask *nodemask = numa_allocate_nodemask();
    numa_bitmask_setbit(nodemask, numa_node_of_cpu(sched_getcpu()));
    return set_mempolicy(MPOL_BIND, nodemask->maskp, nodemask->size + 1);
}
```

## Measuring and Validating Latency

### cyclictest: RT Latency Measurement

```bash
# Install rt-tests
apt-get install rt-tests  # Debian/Ubuntu
yum install rt-tests       # RHEL/CentOS

# Basic cyclictest: measure wakeup latency on isolated CPU
cyclictest \
  --mlockall \
  --smp \
  --priority=80 \
  --interval=200 \
  --distance=0 \
  --loops=100000 \
  --affinity=4

# High-precision measurement on a single isolated CPU
cyclictest \
  --mlockall \
  --quiet \
  --priority=98 \
  --policy=fifo \
  --interval=100 \
  --affinity=4 \
  --loops=1000000 \
  --histogram=200

# Expected results on well-tuned system:
# Min: < 5 µs
# Avg: < 20 µs
# Max: < 100 µs (without hardware SMI/NMI)
```

### perf: Scheduler Latency Analysis

```bash
# Record scheduler wakeup events
perf sched record -a -- sleep 10

# Analyze scheduler latency
perf sched latency --sort max

# View per-task scheduler statistics
perf sched timehist

# Record context switches
perf record -e 'sched:sched_switch' -a -- sleep 10
perf report

# Measure frequency of scheduler interrupts
perf stat -e 'sched:sched_switch,sched:sched_migrate_task' \
  -p <PID> -- sleep 10
```

### ftrace: Tracing Scheduler Events

```bash
# Enable function tracer for scheduler
echo function > /sys/kernel/debug/tracing/current_tracer

# Trace scheduling of a specific process
echo <PID> > /sys/kernel/debug/tracing/set_ftrace_pid
echo 1 > /sys/kernel/debug/tracing/tracing_on

# Read trace buffer
cat /sys/kernel/debug/tracing/trace | head -100

# Use trace-cmd for easier access
trace-cmd record -e sched:sched_switch -e sched:sched_wakeup \
  -p <PID> -- sleep 5
trace-cmd report | head -50
```

## Kubernetes CPU Management for Latency Workloads

Kubernetes uses the CPU Manager to pin container threads to CPUs. The `static` policy assigns exclusive CPUs to Guaranteed QoS containers:

```yaml
# kubelet configuration for static CPU management
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: "static"
cpuManagerReconcilePeriod: "10s"
# Reserve system CPUs (never allocated to containers)
reservedSystemCPUs: "0-1"
```

```yaml
# Pod with exclusive CPU allocation (Guaranteed QoS)
# Request = Limit = whole CPU = exclusive pinning
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: latency-critical
      resources:
        requests:
          cpu: "4"       # Must be integer for exclusive allocation
          memory: "4Gi"
        limits:
          cpu: "4"       # Must equal requests
          memory: "4Gi"
```

```bash
# Verify CPU assignments
cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool

# Check which CPUs are assigned to a container
CONTAINER_ID=$(kubectl get pod mypod -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d/ -f3)
cat /sys/fs/cgroup/cpuset/kubepods/guaranteed/pod*/*/cpuset.cpus
```

## Comprehensive System Tuning Script

```bash
#!/bin/bash
# tune-for-latency.sh - Apply latency tuning settings

# Verify we're on a system with isolated CPUs
ISOLATED_CPUS=$(cat /sys/devices/system/cpu/isolated 2>/dev/null)
if [ -z "$ISOLATED_CPUS" ]; then
    echo "WARNING: No isolated CPUs detected. Add isolcpus=N-M to kernel cmdline."
fi

echo "Applying latency tuning..."

# CPU frequency scaling: disable power saving
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo "performance" > "$cpu" 2>/dev/null || true
done

# Disable frequency boost (reduces max latency variance)
# echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Scheduler tuning
sysctl -w kernel.sched_min_granularity_ns=1000000
sysctl -w kernel.sched_latency_ns=3000000
sysctl -w kernel.sched_migration_cost_ns=5000000
sysctl -w kernel.sched_rt_runtime_us=980000

# Memory tuning
sysctl -w vm.swappiness=0
sysctl -w vm.dirty_background_ratio=3
sysctl -w vm.dirty_ratio=10

# Network tuning
sysctl -w net.core.busy_poll=50
sysctl -w net.core.busy_read=50

# Disable transparent huge pages (reduces latency spikes from compaction)
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Allocate huge pages
echo 1024 > /proc/sys/vm/nr_hugepages

# Stop irqbalance for manual IRQ control
systemctl stop irqbalance

# Pin NIC interrupts to non-isolated CPUs (adjust for your interface names)
NON_ISOLATED_CPUS="0-3"
for irq in $(grep -l "eth0\|ens3\|enp" /proc/irq/*/node 2>/dev/null | grep -oP '\d+'); do
    echo "$NON_ISOLATED_CPUS" > /proc/irq/${irq}/smp_affinity_list 2>/dev/null || true
done

# Validate with cyclictest on isolated CPUs
echo ""
echo "Running 10-second latency validation..."
cyclictest \
    --mlockall \
    --priority=80 \
    --policy=fifo \
    --interval=100 \
    --loops=100000 \
    --affinity="${ISOLATED_CPUS:-0}" \
    --quiet

echo "Tuning complete."
```

## Summary

Effective latency optimization for Linux workloads requires a layered approach:

- **CPU topology awareness**: Understand NUMA nodes, cache hierarchy, and hyperthreading before assigning workloads
- **CPU isolation**: Use `isolcpus` at boot or cgroup cpusets to reserve CPUs exclusively for critical workloads
- **Affinity pinning**: Use `taskset`, `numactl`, or programmatic `sched_setaffinity` to keep processes on local NUMA CPUs
- **Real-time scheduling**: Use `SCHED_FIFO` or `SCHED_RR` for processes that must respond within bounded time
- **IRQ affinity**: Move network and storage interrupts to non-isolated CPUs to prevent interrupt-driven latency spikes
- **Measurement**: Validate with `cyclictest` before and after each change; use `perf sched` to identify scheduling bottlenecks

No single change guarantees latency targets. The kernel itself (SMI, NMI, RCU callbacks) introduces irreducible latency on commodity hardware. For sub-100 µs P99 requirements, investigate `PREEMPT_RT` kernel patches and hardware-level power management controls.
