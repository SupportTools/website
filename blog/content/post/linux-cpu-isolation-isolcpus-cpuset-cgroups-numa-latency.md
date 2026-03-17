---
title: "Linux CPU Isolation: isolcpus, cpuset cgroups, and NUMA Topology for Latency-Critical Workloads"
date: 2030-03-30T00:00:00-05:00
draft: false
tags: ["Linux", "CPU Isolation", "NUMA", "cgroups", "Performance", "Latency", "Real-time", "Kubernetes"]
categories: ["Linux", "Performance", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux CPU isolation techniques for latency-critical workloads, covering isolcpus kernel parameter, cpuset cgroups for CPU binding, NUMA topology awareness, interrupt affinity tuning, and performance validation methodologies."
more_link: "yes"
url: "/linux-cpu-isolation-isolcpus-cpuset-cgroups-numa-latency/"
---

The Linux scheduler is one of the most sophisticated pieces of software in existence, designed to provide fair CPU time distribution across thousands of competing tasks. For latency-critical workloads — financial trading systems, real-time data processing, audio/video production, or network packet processing — this fairness mechanism becomes an adversary. A latency spike of 200 microseconds caused by the scheduler running a background kernel task on the same CPU as your critical process is unacceptable in systems where responses must complete in under a millisecond.

CPU isolation removes critical CPUs from the Linux scheduler's pool entirely, dedicates them to specific processes, pins hardware interrupts to non-isolated cores, and configures NUMA topology to eliminate cross-socket memory accesses. Done correctly, this reduces tail latency by orders of magnitude for the isolated workloads.

<!--more-->

## Understanding the Problem

Before configuring isolation, understanding what causes scheduler-induced latency on Linux helps target the right interventions:

1. **Timer interrupts**: The kernel's internal clock fires at a configurable frequency (typically 250 Hz). Each tick interrupts whatever is running on each CPU.

2. **Softirqs and tasklets**: Deferred interrupt work that can preempt normal processes.

3. **RCU callbacks**: Read-Copy-Update callbacks that run on every CPU periodically.

4. **Scheduler load balancing**: The scheduler periodically moves tasks between CPUs to equalize load.

5. **Memory management**: TLB flushes, page fault handling, and slab allocator work.

6. **Hardware interrupts**: Network card, storage, and other device interrupts firing on shared CPUs.

7. **NUMA remote memory access**: Processes accessing memory allocated on a different NUMA node pay a 2-3x latency penalty.

A fully isolated CPU is affected only by item 1 (timer interrupt at low frequency if `CONFIG_HZ_PERIODIC` is set), and even that can be reduced with `nohz_full`.

## System Topology Discovery

Start every isolation configuration by thoroughly understanding your hardware topology.

```bash
# Complete CPU topology overview
lscpu --extended

# Example output
# CPU NODE SOCKET CORE L1d:L1i:L2:L3 ONLINE    MAXMHZ    MINMHZ       MHZ
#   0    0      0    0 0:0:0:0          yes 5200.0000 800.0000 2100.0000
#   1    0      0    1 2:2:1:0          yes 5200.0000 800.0000 2100.0000
#   2    0      0    2 4:4:2:0          yes 5200.0000 800.0000 2100.0000
#   3    0      0    3 6:6:3:0          yes 5200.0000 800.0000 2100.0000
#  ...
#  32    1      1   16 0:0:0:1          yes 5200.0000 800.0000 2100.0000

# NUMA node topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node 0 size: 128636 MB
# node 0 free: 97234 MB
# node 1 cpus: 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63
# node 1 size: 129022 MB
# node 1 free: 121456 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# CPU cache topology
cat /sys/devices/system/cpu/cpu0/cache/index*/type
cat /sys/devices/system/cpu/cpu0/cache/index*/shared_cpu_list

# Which CPUs share L3 cache
python3 -c "
import os
cache_groups = {}
for cpu in range(os.cpu_count()):
    cache_dir = f'/sys/devices/system/cpu/cpu{cpu}/cache'
    if not os.path.exists(cache_dir):
        continue
    for idx in os.listdir(cache_dir):
        type_file = f'{cache_dir}/{idx}/type'
        shared_file = f'{cache_dir}/{idx}/shared_cpu_list'
        if not os.path.exists(type_file):
            continue
        with open(type_file) as f:
            if 'Unified' in f.read():  # L3
                with open(shared_file) as f:
                    group = f.read().strip()
                    cache_groups.setdefault(group, set()).add(cpu)
                break
for group, cpus in sorted(cache_groups.items()):
    print(f'L3 shared by CPUs: {sorted(cpus)}')
"

# Hyperthreading siblings (CPU pairs sharing a physical core)
for cpu in /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; do
    echo "$cpu: $(cat $cpu)"
done | sort -u
```

### Choosing CPUs to Isolate

```bash
#!/usr/bin/env bash
# plan-isolation.sh — recommend which CPUs to isolate

# Rule 1: Never isolate CPU 0 — it handles most kernel housekeeping
# Rule 2: Keep at least 2 CPUs per NUMA node for system tasks
# Rule 3: If isolating a physical core, isolate BOTH hyperthreads
# Rule 4: Keep CPUs sharing L3 cache together where possible

TOTAL_CPUS=$(nproc)
echo "Total CPUs: $TOTAL_CPUS"

# Get NUMA nodes
for node in /sys/devices/system/node/node*/cpulist; do
    echo "NUMA node $(basename $(dirname $node)): CPUs $(cat $node)"
done

# Suggest isolation plan
echo ""
echo "Suggested isolation for a 32-CPU system (2 NUMA nodes):"
echo "  System CPUs (non-isolated): 0,1,16,17 (2 per NUMA node)"
echo "  Isolated CPUs: 2-15,18-31"
echo ""
echo "Note: Include both hyperthreads of each physical core"
echo "  e.g., if cores 2,3 share physical core 1, isolate both 2 and 3"
```

## isolcpus Kernel Parameter

`isolcpus` is the kernel boot parameter that removes CPUs from the general-purpose scheduler. Processes can still be explicitly assigned to isolated CPUs, but the scheduler will never automatically place work on them.

### Configuring isolcpus

```bash
# View current kernel command line
cat /proc/cmdline

# Edit GRUB configuration
vim /etc/default/grub

# Add to GRUB_CMDLINE_LINUX_DEFAULT:
# isolcpus=2-15,18-31
# nohz_full=2-15,18-31       -- disable scheduler clock tick on isolated CPUs
# rcu_nocbs=2-15,18-31       -- offload RCU callbacks from isolated CPUs
# irqaffinity=0,1,16,17      -- route all IRQs to system CPUs
# nosoftlockup               -- disable soft lockup watchdog (reduces jitter)
# skew_tick=1                -- stagger tick across CPUs to reduce simultaneous wakeups

# Example complete GRUB_CMDLINE_LINUX_DEFAULT
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash isolcpus=2-15,18-31 nohz_full=2-15,18-31 rcu_nocbs=2-15,18-31 irqaffinity=0,1,16,17 nosoftlockup skew_tick=1"

# Update GRUB
update-grub   # Ubuntu/Debian
grub2-mkconfig -o /boot/grub2/grub.cfg   # RHEL/CentOS

# Reboot to apply
# reboot

# Verify after reboot
cat /sys/devices/system/cpu/isolated
# 2-15,18-31

cat /sys/devices/system/cpu/nohz_full
# 2-15,18-31
```

### Runtime CPU Isolation with cgroups v2

For environments where a reboot is not immediately possible, or where isolation boundaries need to change dynamically, cgroup cpuset isolation can approximate the effect of isolcpus.

```bash
# Verify cgroup v2 is active
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Create an isolated cpuset cgroup
mkdir -p /sys/fs/cgroup/isolated-workload

# Assign specific CPUs and memory nodes (NUMA)
echo "2-15,18-31" > /sys/fs/cgroup/isolated-workload/cpuset.cpus
echo "0-1" > /sys/fs/cgroup/isolated-workload/cpuset.mems   # both NUMA nodes

# Enable exclusive CPU use (no sibling cgroups can use these CPUs)
# This requires setting cpuset.cpus.exclusive in parent hierarchy
echo "2-15,18-31" > /sys/fs/cgroup/cpuset.cpus.exclusive

# Move your process into the isolated cgroup
echo $MY_PID > /sys/fs/cgroup/isolated-workload/cgroup.procs

# Verify
cat /proc/$MY_PID/status | grep Cpus_allowed
```

### Systemd Service with CPU Isolation

```ini
# /etc/systemd/system/latency-critical-app.service
[Unit]
Description=Latency-Critical Application
After=network.target

[Service]
Type=simple
User=appuser
ExecStart=/usr/local/bin/my-critical-app

# Restrict to isolated CPUs
CPUAffinity=2 3 4 5 6 7 8 9 10 11 12 13 14 15 18 19 20 21 22 23 24 25 26 27 28 29 30 31

# Lock to NUMA node 0 for memory allocation
NUMAPolicy=bind
NUMAMask=0

# Real-time priority (requires privileges)
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=50

# Prevent swapping critical pages
LockPersonality=yes
MemoryLock=infinity

# Huge pages for TLB efficiency
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## CPU Affinity for Processes and Threads

Once CPUs are isolated, you must explicitly assign processes to those CPUs. The isolated CPUs are otherwise idle — isolation without assignment wastes resources.

```bash
# Pin a process to specific CPUs using taskset
taskset -c 2-7 /usr/local/bin/my-application

# Pin an already-running process (by PID)
taskset -cp 2-7 $MY_PID

# View current CPU affinity
taskset -cp $MY_PID
# pid 12345's current affinity list: 2-7

# Pin a thread to a specific CPU
# Requires setting affinity per-thread (PID = thread ID in Linux)
ps -L -p $MY_PID | awk '{print $2}' | while read tid; do
    taskset -cp 2-7 $tid 2>/dev/null
done
```

### Thread-Level CPU Pinning in Go

```go
// cpupin/pin.go — pin Go goroutines to specific CPUs
package cpupin

import (
    "fmt"
    "runtime"
    "syscall"
    "unsafe"
)

// cpuSet represents a CPU affinity mask
type cpuSet [1024/64]uint64

func (s *cpuSet) set(cpu int) {
    s[cpu/64] |= 1 << uint(cpu%64)
}

// PinCurrentThread pins the calling OS thread to a specific CPU
// Must be called with runtime.LockOSThread() active
func PinCurrentThread(cpu int) error {
    if cpu < 0 || cpu >= 1024 {
        return fmt.Errorf("invalid cpu number: %d", cpu)
    }

    var mask cpuSet
    mask.set(cpu)

    _, _, errno := syscall.RawSyscall(
        syscall.SYS_SCHED_SETAFFINITY,
        0, // 0 = current thread
        unsafe.Sizeof(mask),
        uintptr(unsafe.Pointer(&mask)),
    )
    if errno != 0 {
        return fmt.Errorf("sched_setaffinity: %w", errno)
    }
    return nil
}

// PinWorker creates a goroutine permanently pinned to a specific CPU
func PinWorker(cpu int, work func()) error {
    ready := make(chan error, 1)
    done := make(chan struct{})

    go func() {
        // LockOSThread prevents the Go runtime from migrating
        // this goroutine to a different OS thread
        runtime.LockOSThread()
        defer runtime.UnlockOSThread()
        defer close(done)

        if err := PinCurrentThread(cpu); err != nil {
            ready <- err
            return
        }
        ready <- nil

        work()
    }()

    return <-ready
}
```

```go
// Example: high-frequency trading engine with pinned worker threads
package main

import (
    "context"
    "fmt"
    "log"
    "runtime"
    "time"

    "github.com/yourorg/cpupin"
)

type OrderProcessor struct {
    cpu    int
    orders chan Order
    done   chan struct{}
}

func NewOrderProcessor(cpu int) *OrderProcessor {
    return &OrderProcessor{
        cpu:    cpu,
        orders: make(chan Order, 10000),
        done:   make(chan struct{}),
    }
}

func (op *OrderProcessor) Start() error {
    return cpupin.PinWorker(op.cpu, func() {
        // Disable GC for this goroutine if possible
        // (use sync.Pool and object reuse to minimize GC pressure)

        log.Printf("Order processor pinned to CPU %d", op.cpu)

        for order := range op.orders {
            op.processOrder(order)
        }
        close(op.done)
    })
}

func (op *OrderProcessor) processOrder(order Order) {
    // Critical path: minimize allocations
    // All work happens on isolated CPU op.cpu
    start := time.Now()
    // ... process order ...
    latency := time.Since(start)

    if latency > 100*time.Microsecond {
        // Log latency violations
        log.Printf("WARNING: order processing latency spike: %v", latency)
    }
}

func main() {
    // Use isolated CPUs 2,3,4,5 for order processing
    isolatedCPUs := []int{2, 3, 4, 5}
    processors := make([]*OrderProcessor, len(isolatedCPUs))

    for i, cpu := range isolatedCPUs {
        processors[i] = NewOrderProcessor(cpu)
        if err := processors[i].Start(); err != nil {
            log.Fatalf("start processor on cpu %d: %v", cpu, err)
        }
    }

    fmt.Println("All processors running on isolated CPUs")
    select {}
}
```

## NUMA Topology Awareness

A server with 2 NUMA nodes has CPUs and memory banks divided between two sockets. Accessing memory on the remote NUMA node costs approximately 2-3x more latency than local access. For latency-critical workloads, this means:

1. Allocate memory on the same NUMA node as the CPUs doing the work
2. Keep worker CPUs and their associated memory on the same socket
3. Never migrate processes between NUMA nodes

```bash
# View NUMA statistics
numastat -m
# Per-node memory usage statistics

numastat -p $MY_PID
# Per-process NUMA memory allocation

# Allocate memory on a specific NUMA node
numactl --membind=0 --cpunodebind=0 /usr/local/bin/my-application

# Bind to NUMA node 0 only
numactl --cpunodebind=0 --localalloc /usr/local/bin/my-application
# --localalloc: allocate memory on the NUMA node of the requesting CPU

# Check NUMA hit/miss rates
cat /proc/vmstat | grep -E 'numa_(hit|miss|local|foreign|interleave)'
# numa_hit 1234567890
# numa_miss 12345       ← high miss count indicates cross-NUMA accesses
# numa_local 1234567890
# numa_foreign 12345

# Run a NUMA-aware task
taskset -c 0-15 numactl --membind=0 /usr/local/bin/my-application
```

### NUMA-Aware Memory Allocation in Go

```go
// numa/allocator.go — NUMA-aware memory allocation
package numa

import (
    "syscall"
    "unsafe"
)

// #cgo CFLAGS: -I/usr/include/numa
// #cgo LDFLAGS: -lnuma
// #include <numa.h>
// #include <stdlib.h>
import "C"

// AllocateOnNode allocates memory on a specific NUMA node
func AllocateOnNode(size int, node int) ([]byte, error) {
    ptr := C.numa_alloc_onnode(C.size_t(size), C.int(node))
    if ptr == nil {
        return nil, fmt.Errorf("numa_alloc_onnode failed")
    }
    // Convert to Go slice — be careful with GC
    slice := unsafe.Slice((*byte)(ptr), size)
    return slice, nil
}

// FreeNUMA frees memory allocated with AllocateOnNode
func FreeNUMA(mem []byte) {
    C.numa_free(unsafe.Pointer(&mem[0]), C.size_t(len(mem)))
}

// GetCurrentNode returns the NUMA node of the current CPU
func GetCurrentNode() int {
    return int(C.numa_node_of_cpu(C.int(C.sched_getcpu())))
}
```

## Interrupt Affinity Tuning

Hardware interrupts default to CPU 0 or are distributed across all CPUs. On a system with isolated CPUs, all interrupts must be directed to the non-isolated CPUs. This is the most common mistake in CPU isolation setups — the interrupt load is not redirected and isolated CPUs receive interrupt wakeups.

```bash
# View all IRQ assignments
cat /proc/interrupts | head -20

# View and set IRQ affinity for each IRQ
for irq in /proc/irq/*/smp_affinity_list; do
    echo "$irq: $(cat $irq)"
done

# Set all IRQs to use only system CPUs (0,1,16,17)
# Represent as CPU mask: CPUs 0,1,16,17 = 0x00030003
SYSTEM_CPU_MASK="00030003"   # hex representation of CPUs 0,1,16,17
SYSTEM_CPU_LIST="0,1,16,17"

for irq_dir in /proc/irq/[0-9]*; do
    irq=$(basename "$irq_dir")
    # Skip CPU error interrupts and similar (often cannot be changed)
    echo "$SYSTEM_CPU_MASK" > "$irq_dir/smp_affinity" 2>/dev/null || true
    echo "$SYSTEM_CPU_LIST" > "$irq_dir/smp_affinity_list" 2>/dev/null || true
done

echo "IRQ affinity set to system CPUs: $SYSTEM_CPU_LIST"

# Verify NIC interrupts specifically (most important for network workloads)
NETWORK_IRQ=$(cat /proc/interrupts | grep 'eth0\|ens\|enp' | awk '{print $1}' | tr -d ':')
for irq in $NETWORK_IRQ; do
    echo "NIC IRQ $irq: $(cat /proc/irq/$irq/smp_affinity_list)"
done
```

### Configuring RSS (Receive Side Scaling) for Network Isolation

For network-intensive workloads, RSS distributes incoming packets across CPUs. Configure it to direct network processing only to system CPUs.

```bash
# View current RSS queue configuration for a NIC
ethtool -l eth0
# Channel parameters for eth0:
# Pre-set maximums:
# RX:             8
# TX:             8
# Combined:       8
# Current hardware settings:
# RX:             8
# TX:             8
# Combined:       8

# Reduce RSS queues to match number of system CPUs
# If system CPUs are 0,1,16,17 → 4 queues
ethtool -L eth0 combined 4

# Set IRQ affinity for each NIC queue to a specific system CPU
IRQ_DIRS=$(ls /proc/irq/*/eth0-TxRx-* 2>/dev/null | head -4)
SYSTEM_CPUS=(0 1 16 17)
i=0
for irq_dir in $IRQ_DIRS; do
    irq=$(basename $irq_dir)
    echo "${SYSTEM_CPUS[$i]}" > "/proc/irq/$irq/smp_affinity_list"
    echo "Queue $i IRQ $irq → CPU ${SYSTEM_CPUS[$i]}"
    i=$((i+1))
done

# RPS (Receive Packet Steering) — software RSS for CPUs without hardware RSS
# Direct RPS to system CPUs
# CPU mask for CPUs 0,1,16,17: 0x00030003
for queue in /sys/class/net/eth0/queues/rx-*/rps_cpus; do
    echo 00030003 > "$queue"
done
```

## Disabling Kernel Background Tasks on Isolated CPUs

```bash
# Move kworker threads off isolated CPUs
# (isolated cpus with nohz_full should do this automatically)

# Check which kworkers are on isolated CPUs
ps aux | grep kworker | awk '$3 > 0 {print $1, $2, $3}'

# Manually set kworker affinity to system CPUs
SYSTEM_CPUS="0,1,16,17"
for pid in $(pgrep kworker); do
    taskset -cp "$SYSTEM_CPUS" "$pid" 2>/dev/null || true
done

# Verify with nohz_full (should prevent tick on isolated CPUs)
cat /sys/devices/system/cpu/nohz_full
# Should show: 2-15,18-31

# Check timer interrupts are not firing on isolated CPUs
# (Look for LOC column in /proc/interrupts — Local timer interrupts)
# Isolated CPUs should show very low or zero LOC counts after system is running
watch -n 1 'cat /proc/interrupts | grep "LOC\|NMI\|RES"'
```

## Validating Isolation Effectiveness

### Cyclictest — Measuring Scheduler Latency

`cyclictest` is the standard tool for measuring worst-case scheduler latency.

```bash
# Install rt-tests (contains cyclictest)
apt-get install rt-tests   # Ubuntu
dnf install rt-tests       # Fedora/RHEL

# Run on isolated CPUs with real-time priority
# -m: lock memory (prevent page faults)
# -t: number of threads (one per isolated CPU)
# -n: use clock_nanosleep
# -p: real-time priority
# -i: interval in microseconds
# -d: distance between threads (microseconds)
# -a: CPU affinity
# Duration: 60 seconds

taskset -c 2-7 cyclictest \
    -m \
    -n \
    -t 6 \
    -p 99 \
    -i 200 \
    -d 0 \
    -a 2-7 \
    -D 60 \
    --histfile=/tmp/cyclictest-isolated.hist

# Compare against non-isolated CPUs
taskset -c 0,1 cyclictest \
    -m \
    -n \
    -t 2 \
    -p 99 \
    -i 200 \
    -d 0 \
    -a 0,1 \
    -D 60 \
    --histfile=/tmp/cyclictest-system.hist

# Parse results
python3 - << 'EOF'
import sys

for label, filename in [
    ("Isolated CPUs", "/tmp/cyclictest-isolated.hist"),
    ("System CPUs", "/tmp/cyclictest-system.hist"),
]:
    try:
        with open(filename) as f:
            lines = f.readlines()
        # Find max latency line
        for line in lines:
            if line.startswith("# Max Latencies:"):
                maxvals = [int(x) for x in line.split()[3:]]
                print(f"{label}: max latency = {max(maxvals)} µs")
    except FileNotFoundError:
        print(f"{label}: file not found")
EOF

# Typical results:
# Isolated CPUs: max latency = 12 µs
# System CPUs: max latency = 847 µs
```

### perf for Latency Attribution

```bash
# Record all wakeup latency events on isolated CPUs
perf record -e sched:sched_wakeup,sched:sched_switch \
    -C 2,3,4,5 \
    -g \
    --duration 10 \
    -o /tmp/perf-isolated.data

# Analyze scheduler events
perf script -i /tmp/perf-isolated.data | \
    awk '/sched_switch/' | \
    python3 - << 'EOF'
import sys, re
from collections import defaultdict

latencies = defaultdict(list)
for line in sys.stdin:
    # Parse sched_switch events to find preemptions
    if 'sched:sched_switch' in line:
        parts = line.split()
        if len(parts) > 5:
            comm = parts[0]
            latencies[comm].append(1)  # simplified

# Report top preempting tasks
for comm, events in sorted(latencies.items(), key=lambda x: -len(x[1]))[:10]:
    print(f"{len(events):6d} preemptions: {comm}")
EOF

# Check for specific interrupt sources on isolated CPUs
perf stat -e \
    'irq:irq_handler_entry,irq:irq_handler_exit,exceptions:page_fault_user,sched:sched_migrate_task' \
    -C 2,3,4,5 \
    sleep 10
```

### Writing a Latency Measurement Harness in Go

```go
// latency/bench.go — measure application-level scheduling latency
package latency

import (
    "fmt"
    "math"
    "sort"
    "time"
    "runtime"
)

// SchedulerLatencyBench measures scheduling latency by comparing
// wall-clock time to expected sleep duration
func SchedulerLatencyBench(cpus []int, duration time.Duration, interval time.Duration) map[int]Stats {
    results := make(map[int]chan time.Duration)
    for _, cpu := range cpus {
        results[cpu] = make(chan time.Duration, int(duration/interval)+100)
    }

    done := make(chan struct{})
    go func() {
        time.Sleep(duration)
        close(done)
    }()

    for _, cpu := range cpus {
        cpu := cpu
        ch := results[cpu]
        go func() {
            runtime.LockOSThread()
            defer runtime.UnlockOSThread()

            if err := PinCurrentThread(cpu); err != nil {
                fmt.Printf("pin to cpu %d failed: %v\n", cpu, err)
                return
            }

            for {
                select {
                case <-done:
                    close(ch)
                    return
                default:
                }

                start := time.Now()
                time.Sleep(interval)
                actual := time.Since(start)
                latency := actual - interval
                if latency < 0 {
                    latency = 0
                }
                select {
                case ch <- latency:
                default:
                }
            }
        }()
    }

    // Collect results
    stats := make(map[int]Stats)
    for cpu, ch := range results {
        var measurements []float64
        for d := range ch {
            measurements = append(measurements, float64(d.Microseconds()))
        }
        if len(measurements) > 0 {
            stats[cpu] = computeStats(measurements)
        }
    }
    return stats
}

// Stats holds latency statistics
type Stats struct {
    Min    float64
    Max    float64
    Mean   float64
    P50    float64
    P95    float64
    P99    float64
    P999   float64
    Count  int
}

func computeStats(data []float64) Stats {
    sort.Float64s(data)
    n := len(data)

    sum := 0.0
    for _, v := range data {
        sum += v
    }

    percentile := func(p float64) float64 {
        idx := int(math.Ceil(p/100.0*float64(n))) - 1
        if idx < 0 {
            idx = 0
        }
        if idx >= n {
            idx = n - 1
        }
        return data[idx]
    }

    return Stats{
        Min:   data[0],
        Max:   data[n-1],
        Mean:  sum / float64(n),
        P50:   percentile(50),
        P95:   percentile(95),
        P99:   percentile(99),
        P999:  percentile(99.9),
        Count: n,
    }
}
```

## Kubernetes CPU Management Policies

For Kubernetes nodes with isolated CPUs, configure the kubelet's CPU manager to assign exclusive CPUs to Guaranteed-QoS pods.

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 5s
# Reserve system CPUs from Kubernetes allocation
reservedSystemCPUs: "0,1,16,17"
# Enable topology-aware scheduling
topologyManagerPolicy: single-numa-node
topologyManagerScope: pod
```

```yaml
# Pod that gets exclusive CPU allocation (Guaranteed QoS)
apiVersion: v1
kind: Pod
metadata:
  name: latency-critical-pod
spec:
  containers:
    - name: app
      image: latency-critical-app:latest
      resources:
        requests:
          cpu: "4"       # Integer CPU request = exclusive CPUs
          memory: "8Gi"
        limits:
          cpu: "4"       # requests == limits = Guaranteed QoS
          memory: "8Gi"
      securityContext:
        capabilities:
          add: ["SYS_NICE"]  # Allow setting real-time priority
```

```bash
# Verify CPU assignment
POD_UID=$(kubectl get pod latency-critical-pod -o jsonpath='{.metadata.uid}')
cat /sys/fs/cgroup/kubepods/guaranteed/pod${POD_UID}/*/cpuset.cpus
# Should show 4 isolated CPUs assigned exclusively to this pod
```

## Key Takeaways

Linux CPU isolation is one of the highest-impact performance interventions available for latency-critical workloads, but it requires configuring multiple layers simultaneously. Missing any one layer often negates the benefit of the others.

The `isolcpus` + `nohz_full` + `rcu_nocbs` combination removes isolated CPUs from virtually all kernel scheduler activity. These three parameters work together: `isolcpus` removes CPUs from load balancing, `nohz_full` stops the timer tick on those CPUs, and `rcu_nocbs` offloads RCU grace period callbacks to a dedicated kernel thread on a non-isolated CPU.

Interrupt affinity is the most commonly missed step. After enabling isolcpus, all hardware IRQs must be explicitly redirected to system CPUs. A single network card with RSS queues on isolated CPUs will completely undermine the isolation.

NUMA topology matters for predictable latency. A workload pinned to CPUs on NUMA node 0 that allocates memory on NUMA node 1 will experience unpredictable latency spikes as remote memory accesses compete with local ones. Use `numactl --localalloc` or `--membind` to enforce local memory allocation.

Validate isolation with cyclictest before deploying workloads. The difference between an isolated system (12 µs max scheduler latency) and a non-isolated system (847 µs max latency) is not theoretical — it is measurable in every production application that has latency SLAs below 1 millisecond.
