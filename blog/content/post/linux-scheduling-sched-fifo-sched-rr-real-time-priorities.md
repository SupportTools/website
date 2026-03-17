---
title: "Linux Scheduling: SCHED_FIFO, SCHED_RR, and Real-Time Priorities"
date: 2029-07-02T00:00:00-05:00
draft: false
tags: ["Linux", "Scheduling", "Real-Time", "SCHED_FIFO", "SCHED_RR", "Kubernetes", "CPU Manager"]
categories: ["Linux", "Performance", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux real-time scheduling classes: SCHED_FIFO, SCHED_RR, priority inheritance, priority inversion, the chrt command, and running real-time workloads in Kubernetes with the CPU manager."
more_link: "yes"
url: "/linux-scheduling-sched-fifo-sched-rr-real-time-priorities/"
---

The Linux scheduler manages how CPU time is allocated among competing processes. For most workloads, the default `SCHED_OTHER` (CFS — Completely Fair Scheduler) is appropriate. But for latency-sensitive applications — audio processing, industrial control, financial trading systems, network packet processing — real-time scheduling classes `SCHED_FIFO` and `SCHED_RR` provide deterministic CPU access that CFS cannot guarantee. This post covers both concepts and their application in Kubernetes environments.

<!--more-->

# Linux Scheduling: SCHED_FIFO, SCHED_RR, and Real-Time Priorities

## The Linux Scheduler Architecture

The Linux scheduler is a multi-class system. Each scheduling class has a priority range and its own run queue:

```
Priority Order (highest to lowest):
1. SCHED_DEADLINE  (sporadic deadline scheduling)
2. SCHED_FIFO      (real-time, FIFO within priority)
3. SCHED_RR        (real-time, round-robin within priority)
4. SCHED_OTHER     (CFS — the default)
5. SCHED_BATCH     (batch processing, lower priority)
6. SCHED_IDLE      (runs only when nothing else is runnable)
```

Real-time processes (SCHED_FIFO and SCHED_RR) always preempt CFS processes. A real-time process at priority 1 (the minimum) will preempt any CFS process.

## Section 1: SCHED_FIFO

`SCHED_FIFO` is the simplest real-time scheduler: within a given priority level, processes run until they voluntarily yield, block on I/O, or are preempted by a higher-priority real-time process.

### Key Properties

- **No timeslice**: A SCHED_FIFO process runs until it blocks or explicitly yields
- **Priority-based preemption**: A higher-priority SCHED_FIFO process always preempts a lower-priority one
- **Starvation risk**: A misbehaving SCHED_FIFO process at high priority can starve everything below it, including the kernel

### Priority Range

Real-time priorities range from 1 (lowest) to 99 (highest). POSIX specifies at least 32 priority levels; Linux provides 99.

```bash
# View scheduling attributes of a process
chrt -p <PID>

# Example output:
# pid 1234's current scheduling policy: SCHED_OTHER
# pid 1234's current scheduling priority: 0

# Set SCHED_FIFO priority 50 for PID 1234 (requires CAP_SYS_NICE or root)
chrt -f -p 50 <PID>

# Run a new command with SCHED_FIFO priority 50
chrt -f 50 ./my-rt-process

# Reset to SCHED_OTHER
chrt -o -p 0 <PID>
```

### Setting Scheduling Policy Programmatically

```c
// C: set SCHED_FIFO
#include <sched.h>
#include <stdio.h>

int set_realtime_priority(int policy, int priority) {
    struct sched_param param = {
        .sched_priority = priority
    };
    return sched_setscheduler(0, policy, &param); // 0 = current process
}

int main() {
    if (set_realtime_priority(SCHED_FIFO, 50) != 0) {
        perror("sched_setscheduler");
        return 1;
    }
    // Now running as SCHED_FIFO priority 50
    run_audio_processing_loop();
    return 0;
}
```

In Go, you need to use `syscall` or a CGo wrapper since the `sched_setscheduler` system call is not in the standard library:

```go
package realtime

import (
    "fmt"
    "syscall"
    "unsafe"
)

const (
    SCHED_OTHER   = 0
    SCHED_FIFO    = 1
    SCHED_RR      = 2
    SCHED_BATCH   = 3
    SCHED_IDLE    = 5
    SCHED_DEADLINE = 6
)

type SchedParam struct {
    SchedPriority int32
}

// SetSchedFIFO sets the calling thread to SCHED_FIFO with the given priority.
// Requires CAP_SYS_NICE or root privileges.
func SetSchedFIFO(priority int) error {
    if priority < 1 || priority > 99 {
        return fmt.Errorf("priority %d out of range [1, 99]", priority)
    }
    param := SchedParam{SchedPriority: int32(priority)}
    _, _, errno := syscall.RawSyscall(
        syscall.SYS_SCHED_SETSCHEDULER,
        0, // current thread
        uintptr(SCHED_FIFO),
        uintptr(unsafe.Pointer(&param)),
    )
    if errno != 0 {
        return fmt.Errorf("sched_setscheduler: %w", errno)
    }
    return nil
}

// GetSchedPolicy returns the scheduling policy and priority of the current thread.
func GetSchedPolicy() (policy int, priority int, err error) {
    policy = -1
    p, _, errno := syscall.RawSyscall(syscall.SYS_SCHED_GETSCHEDULER, 0, 0, 0)
    if errno != 0 {
        return -1, -1, fmt.Errorf("sched_getscheduler: %w", errno)
    }
    policy = int(p)

    var param SchedParam
    _, _, errno = syscall.RawSyscall(
        syscall.SYS_SCHED_GETPARAM,
        0,
        uintptr(unsafe.Pointer(&param)),
        0,
    )
    if errno != 0 {
        return policy, -1, fmt.Errorf("sched_getparam: %w", errno)
    }
    return policy, int(param.SchedPriority), nil
}
```

Important note for Go: goroutines are multiplexed onto OS threads by the Go runtime. `sched_setscheduler` applies to an OS thread (`runtime.LockOSThread()` is required to make a goroutine permanently bound to its OS thread before setting RT policy).

```go
import "runtime"

func RunAsRealtime(priority int, fn func()) error {
    errCh := make(chan error, 1)
    go func() {
        // Lock this goroutine to its OS thread
        runtime.LockOSThread()
        defer runtime.UnlockOSThread()

        if err := SetSchedFIFO(priority); err != nil {
            errCh <- err
            return
        }
        errCh <- nil
        fn()
    }()
    return <-errCh
}
```

## Section 2: SCHED_RR

`SCHED_RR` (Round Robin) is similar to `SCHED_FIFO` but adds a timeslice. When a SCHED_RR process exhausts its timeslice, it moves to the back of the queue at the same priority level.

### SCHED_RR vs SCHED_FIFO

| Property | SCHED_FIFO | SCHED_RR |
|----------|-----------|---------|
| Timeslice | None (runs until yield/block) | Yes (default 100ms) |
| Same-priority fairness | FIFO order | Round-robin |
| Starvation risk | Higher | Lower (within same priority) |
| Latency guarantee | Stronger | Slightly weaker |
| Use case | Single high-priority task | Multiple equal-priority RT tasks |

```bash
# Set SCHED_RR
chrt -r 50 ./my-process

# View the RR timeslice
cat /proc/sys/kernel/sched_rr_timeslice_ms
# 100 (default: 100ms)

# Reduce timeslice for finer-grained scheduling
echo 10 > /proc/sys/kernel/sched_rr_timeslice_ms
```

## Section 3: Priority Inversion and Inheritance

Priority inversion is a subtle correctness issue that arises when a high-priority real-time task is blocked waiting for a resource held by a low-priority task, which itself is preempted by a medium-priority task.

### Classic Priority Inversion Scenario

```
Timeline:
T=0: Low priority task L acquires mutex M
T=1: High priority task H starts, tries to acquire M, blocks
T=2: Medium priority task Me becomes runnable
T=3: Me preempts L (since Me > L, but Me < H)
T=4: H is blocked, L is blocked on Me, M is held by L
→ H is effectively at Me's priority
```

This is the scenario that caused the Mars Pathfinder lander to repeatedly reset in 1997.

### Priority Inheritance Mutexes

Linux `pthread_mutex` supports priority inheritance as a compile-time option:

```c
// C: create a priority-inheritance mutex
pthread_mutexattr_t attr;
pthread_mutexattr_init(&attr);
pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);

pthread_mutex_t mutex;
pthread_mutex_init(&mutex, &attr);

// Now: when H blocks on mutex held by L, L temporarily
// inherits H's priority, preventing Me from preempting L
```

In Go, `sync.Mutex` does NOT implement priority inheritance. This is a fundamental limitation of Go's standard library mutex for real-time use cases. For real-time Go applications, use Linux futexes directly or avoid shared-state synchronization on the RT path.

### Priority Ceiling Protocol

An alternative to priority inheritance: the mutex is assigned a ceiling priority equal to the highest-priority task that might acquire it.

```c
pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_PROTECT);
pthread_mutexattr_setprioceiling(&attr, 60); // ceiling = 60

pthread_mutex_t mutex;
pthread_mutex_init(&mutex, &attr);

// Any task acquiring this mutex temporarily runs at priority 60
// regardless of its own priority
```

## Section 4: Real-Time Scheduling Tuning

### Kernel RT Preemption

The Linux kernel must be compiled with `CONFIG_PREEMPT_RT` (the PREEMPT_RT patch set, mainlined in kernel 6.12) for full real-time preemptibility.

```bash
# Check kernel preemption type
cat /sys/kernel/debug/sched/preempt
# FULL = full RT preemption (best for RT workloads)
# VOLUNTARY = voluntary preemption points
# NONE = no preemption (server kernels)

# Check if RT features are available
uname -v | grep PREEMPT_RT
# Linux ... SMP PREEMPT_RT
```

### CPU Isolation with isolcpus

Dedicate CPU cores to real-time processes by removing them from the CFS scheduler:

```bash
# Add to kernel command line in /etc/default/grub
GRUB_CMDLINE_LINUX="... isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3"

# After reboot, CPUs 2 and 3 receive no OS scheduling (except RT processes)
cat /sys/devices/system/cpu/isolated
# 2-3

# Move all non-RT work away from isolated CPUs
# Use cpuset to restrict processes
```

```bash
# Using cpuset to constrain processes
# Move all current processes to CPUs 0-1
for pid in $(ps -eLo pid --no-headers); do
    taskset -cp 0-1 $pid 2>/dev/null
done

# Pin real-time process to isolated CPUs
taskset -cp 2,3 <RT-PID>
```

### Interrupt Affinity

Route hardware interrupts away from RT CPUs:

```bash
# View interrupt affinity
cat /proc/irq/<N>/smp_affinity_list

# Set IRQ affinity to CPUs 0-1 only (away from RT CPUs 2-3)
echo 0-1 > /proc/irq/<N>/smp_affinity_list

# Use irqbalance with banned CPUs
echo "IRQBALANCE_BANNED_CPUS=0000000c" >> /etc/default/irqbalance
# 0x0c = CPUs 2 and 3 in hex
```

### Latency Measurement with cyclictest

```bash
# Install rt-tests
apt-get install rt-tests

# Run cyclictest on isolated CPUs
cyclictest \
  --affinity=2 \
  --priority=90 \
  --policy=fifo \
  --interval=200 \
  --duration=60 \
  --histogram=400 \
  --quiet

# Output example:
# Min latencies: 000007
# Avg latencies: 000012
# Max latencies: 000043
# (microseconds)

# A well-tuned RT system should show max latency < 100µs
# A poorly tuned system may show spikes > 1ms
```

### RT Throttling

The kernel includes a safety mechanism called RT throttling to prevent RT processes from completely starving the system:

```bash
# View RT bandwidth allocation
cat /proc/sys/kernel/sched_rt_period_us
# 1000000 (1 second period)

cat /proc/sys/kernel/sched_rt_runtime_us
# 950000 (950ms of each 1s period)

# This means RT processes get 95% of CPU time maximum
# -1 disables RT throttling (dangerous but sometimes required)
echo -1 > /proc/sys/kernel/sched_rt_runtime_us
```

**Warning**: Disabling RT throttling can make the system unresponsive if an RT process enters an infinite loop. Always test with throttling enabled first.

## Section 5: SCHED_DEADLINE

For the most demanding real-time workloads, `SCHED_DEADLINE` provides EDF (Earliest Deadline First) scheduling with explicit timing parameters:

```bash
# Set SCHED_DEADLINE on a process
# Parameters: runtime, deadline, period (all in nanoseconds)
# This says: I need 10ms of CPU time every 100ms, deadline is 50ms
chrt -d \
  --sched-runtime 10000000 \
  --sched-deadline 50000000 \
  --sched-period 100000000 \
  0 ./my-process
```

```go
package realtime

import (
    "fmt"
    "syscall"
    "unsafe"
)

const SCHED_DEADLINE = 6

type SchedAttr struct {
    Size           uint32
    SchedPolicy    uint32
    SchedFlags     uint64
    SchedNice      int32
    SchedPriority  uint32
    SchedRuntime   uint64
    SchedDeadline  uint64
    SchedPeriod    uint64
}

// SetSchedDeadline sets SCHED_DEADLINE on the current thread.
// runtime, deadline, and period are in nanoseconds.
func SetSchedDeadline(runtime, deadline, period uint64) error {
    attr := SchedAttr{
        Size:          uint32(unsafe.Sizeof(SchedAttr{})),
        SchedPolicy:   SCHED_DEADLINE,
        SchedRuntime:  runtime,
        SchedDeadline: deadline,
        SchedPeriod:   period,
    }
    _, _, errno := syscall.RawSyscall(
        314, // sched_setattr syscall number on x86_64
        0,   // current thread
        uintptr(unsafe.Pointer(&attr)),
        0, // flags
    )
    if errno != 0 {
        return fmt.Errorf("sched_setattr: %w", errno)
    }
    return nil
}
```

## Section 6: Kubernetes CPU Manager with Real-Time Workloads

Kubernetes' CPU Manager can be configured to use the `static` policy, which provides exclusive CPU pinning for Guaranteed QoS pods. This is a prerequisite for running RT workloads in Kubernetes.

### Enabling the Static CPU Manager Policy

```bash
# On the kubelet node, in /var/lib/kubelet/config.yaml
cat >> /var/lib/kubelet/config.yaml << 'EOF'
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 5s
reservedSystemCPUs: "0-1"
EOF

# Restart kubelet
systemctl restart kubelet

# Verify CPU manager is active
cat /var/lib/kubelet/cpu_manager_state
```

### Creating a Guaranteed QoS Pod for RT Workloads

For the CPU Manager to pin CPUs, the pod must have:
1. `resources.requests == resources.limits` for CPU
2. Non-fractional CPU requests (integer CPUs)
3. Guaranteed QoS class (CPU and memory requests == limits)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: rt-audio-processor
  namespace: realtime
spec:
  # Prevent the pod from being scheduled on non-isolated nodes
  nodeSelector:
    node.kubernetes.io/rt-enabled: "true"

  # Pin to isolated CPUs via CPU Manager
  containers:
  - name: processor
    image: audio-processor:latest
    resources:
      requests:
        cpu: "2"          # 2 exclusive CPUs
        memory: "512Mi"
      limits:
        cpu: "2"          # must equal requests for Guaranteed QoS
        memory: "512Mi"

    # Capabilities needed for RT scheduling
    securityContext:
      capabilities:
        add:
        - SYS_NICE       # Required to call sched_setscheduler

  # Disable CPU sharing with other pods
  runtimeClassName: kata-containers  # optional: stronger isolation
```

```bash
# Verify CPU pinning
kubectl exec -it rt-audio-processor -- cat /proc/self/status | grep Cpus_allowed
# Cpus_allowed: 0c  (binary 0000 1100 = CPUs 2 and 3)
```

### Using a Mutating Webhook to Set RT Priority

A common pattern is to use a mutating admission webhook that sets the RT scheduling policy at pod startup via an init container:

```yaml
# Init container that sets RT scheduling for the main container's PID
# This requires sharing the process namespace
apiVersion: v1
kind: Pod
metadata:
  name: rt-workload
spec:
  shareProcessNamespace: true
  initContainers:
  - name: set-rt-priority
    image: rt-helper:latest
    command: ["/set-rt-priority.sh"]
    # script: find main container PID, chrt -f -p 50 PID
    securityContext:
      capabilities:
        add: ["SYS_NICE"]
  containers:
  - name: main
    image: my-rt-app:latest
    resources:
      requests:
        cpu: "2"
      limits:
        cpu: "2"
```

### Topology Manager for NUMA-Aware RT Placement

For NUMA systems, combine CPU Manager with Topology Manager to ensure CPU and memory are co-located:

```bash
# kubelet configuration for NUMA-aware placement
cat >> /var/lib/kubelet/config.yaml << 'EOF'
topologyManagerPolicy: single-numa-node
cpuManagerPolicy: static
memoryManagerPolicy: Static
reservedMemory:
  - numaNode: 0
    limits:
      memory: "1Gi"
  - numaNode: 1
    limits:
      memory: "1Gi"
EOF
```

```yaml
# Pod requesting NUMA-aligned resources
spec:
  containers:
  - name: rt-app
    resources:
      requests:
        cpu: "4"
        memory: "4Gi"
        hugepages-1Gi: "2Gi"
      limits:
        cpu: "4"
        memory: "4Gi"
        hugepages-1Gi: "2Gi"
```

## Section 7: Monitoring Real-Time Scheduling

### Key Metrics to Track

```bash
# Check RT scheduling statistics
cat /proc/schedstat

# Per-CPU scheduling statistics
cat /proc/sched_debug | grep -A5 "cpu#2"

# Track preemption count
watch -n1 'cat /proc/interrupts | grep -E "^(LOC|NMI)"'

# Monitor context switches
vmstat 1 | awk '{print $12, $13}' # cs (context switches) column
```

### Prometheus Metrics for RT Workloads

```yaml
# Prometheus node_exporter collects relevant metrics
# Key metrics for RT workload monitoring:
# node_schedstat_waiting_seconds_total - time waiting for CPU
# node_schedstat_running_seconds_total - time on CPU
# node_schedstat_timeslices_total - number of timeslices
# node_cpu_seconds_total{mode="irq"} - interrupt CPU usage
```

```promql
# Alert: RT process waiting too long (indicates scheduling problem)
rate(node_schedstat_waiting_seconds_total{cpu="2"}[5m]) > 0.001

# Alert: High interrupt load on RT CPUs
rate(node_cpu_seconds_total{mode="irq", cpu="2"}[5m]) > 0.05
```

## Section 8: Common Pitfalls and Solutions

### Pitfall 1: RT Process Sleeping in Kernel

A SCHED_FIFO process that makes blocking syscalls (disk I/O, network I/O) effectively reduces to CFS behavior while blocked. Real-time applications must use non-blocking I/O with polling:

```go
// Use epoll for non-blocking I/O in RT context
import (
    "golang.org/x/sys/unix"
)

func setupEpoll(fds ...int) (int, error) {
    epfd, err := unix.EpollCreate1(0)
    if err != nil {
        return -1, err
    }
    for _, fd := range fds {
        if err := unix.EpollCtl(epfd, unix.EPOLL_CTL_ADD, fd, &unix.EpollEvent{
            Events: unix.EPOLLIN | unix.EPOLLET,
            Fd:     int32(fd),
        }); err != nil {
            return -1, err
        }
    }
    return epfd, nil
}
```

### Pitfall 2: Memory Page Faults in RT Context

Page faults cause latency spikes. Lock all pages in memory before the RT loop:

```c
// Lock all current and future memory pages
#include <sys/mman.h>

if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
    perror("mlockall");
    exit(1);
}
// Now page faults will not occur for this process's memory
```

```go
// Go equivalent using syscall
import "syscall"

const (
    MCL_CURRENT = 1
    MCL_FUTURE  = 2
)

func lockAllMemory() error {
    _, _, errno := syscall.Syscall(syscall.SYS_MLOCKALL, MCL_CURRENT|MCL_FUTURE, 0, 0)
    if errno != 0 {
        return fmt.Errorf("mlockall: %w", errno)
    }
    return nil
}
```

### Pitfall 3: Go GC Pause During RT Section

Go's GC can pause goroutines. For RT sections, either:

1. Use `runtime.GC()` explicitly before the RT section starts
2. Set `GOGC=off` and manage memory manually
3. Pre-allocate all needed memory and use object pools

```go
import "runtime"

func runRTSection(fn func()) {
    // Force GC before entering RT section to minimize pause probability
    runtime.GC()
    runtime.GC() // Run twice to ensure finalizers complete

    // Disable GC during RT section
    old := debug.SetGCPercent(-1)
    defer debug.SetGCPercent(old)

    fn()
}
```

## Conclusion

Linux real-time scheduling provides deterministic CPU access for latency-sensitive workloads, but it comes with significant operational requirements. Key takeaways:

- `SCHED_FIFO` provides the strongest latency guarantee but requires careful priority assignment to avoid starvation
- `SCHED_RR` adds fairness among same-priority real-time tasks
- Priority inversion is a real correctness problem: use priority-inheritance mutexes or eliminate shared state on the RT path
- Kernel RT preemption (`PREEMPT_RT`), CPU isolation (`isolcpus`), and interrupt affinity are all required for production-quality RT systems
- In Kubernetes, the static CPU Manager policy is the foundation for RT workloads; pair it with Topology Manager for NUMA-aware placement
- Go's goroutine scheduler and GC are not RT-aware; `runtime.LockOSThread()` and pre-allocation are essential for RT Go applications

For mission-critical applications, measure latency continuously with `cyclictest` under production-like load, not just in idle benchmarks.
