---
title: "Linux CPU Affinity and NUMA Topology: taskset, numactl, and IRQ Pinning"
date: 2029-08-24T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "NUMA", "CPU Affinity", "IRQ Pinning", "DPDK", "Network Performance"]
categories: ["Linux", "Performance", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux CPU affinity and NUMA topology optimization: taskset for CPU pinning, numactl NUMA-aware memory allocation, isolcpus kernel parameter, IRQ affinity for network performance, and DPDK CPU isolation for line-rate packet processing."
more_link: "yes"
url: "/linux-cpu-affinity-numa-topology-taskset-numactl-irq-pinning/"
---

Modern server hardware has Non-Uniform Memory Access (NUMA) topology where memory latency varies depending on which CPU accesses which memory. A process on CPU 24 accessing memory attached to the NUMA node hosting CPU 0 pays a 2-3x latency penalty compared to local memory access. For latency-sensitive workloads — network packet processing, financial trading systems, real-time analytics — these penalties are unacceptable. This post covers CPU affinity, NUMA-aware allocation, IRQ steering, and DPDK isolation techniques for production systems.

<!--more-->

# Linux CPU Affinity and NUMA Topology: taskset, numactl, and IRQ Pinning

## Understanding NUMA Topology

### Hardware Architecture

Modern multi-socket servers and even single-socket servers with many cores have NUMA topology:

```
┌──────────────────────────────────────────────────────────────────┐
│  Dual-socket server (example: 2x AMD EPYC 9654 96-core)         │
│                                                                  │
│  ┌──────────────────────────┐  ┌──────────────────────────────┐  │
│  │  NUMA Node 0             │  │  NUMA Node 1                 │  │
│  │  CPUs: 0-95              │  │  CPUs: 96-191                │  │
│  │  RAM: 256GB DDR5         │  │  RAM: 256GB DDR5             │  │
│  │  ┌──────────────────────┐│  │┌──────────────────────────┐  │  │
│  │  │ L3 Cache: 384MB      ││  ││ L3 Cache: 384MB          │  │  │
│  │  └──────────────────────┘│  │└──────────────────────────┘  │  │
│  └──────────────┬───────────┘  └──────────────┬───────────────┘  │
│                 │     UPI (Intel) / xGMI (AMD)  │                │
│                 └─────────────────────────────┘                  │
│                                                                  │
│  Cross-NUMA memory access penalty: ~80-120ns vs ~40-60ns local   │
└──────────────────────────────────────────────────────────────────┘
```

### Discovering NUMA Topology

```bash
# Install NUMA utilities
apt install numactl hwloc-nox

# View NUMA topology
numactl --hardware
# Output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 ... 95
# node 0 size: 261952 MB
# node 0 free: 198432 MB
# node 1 cpus: 96 97 98 99 ... 191
# node 1 size: 262144 MB
# node 1 free: 201024 MB
# node distances:
# node   0   1
#   0:  10  32
#   1:  32  10

# Detailed topology with lstopo
lstopo --output-format png > topology.png
lstopo  # ASCII art in terminal

# View CPU-to-socket mapping
lscpu | grep -E "NUMA|Socket|CPU\(s\)"
# NUMA node(s):                    2
# Socket(s):                       2
# CPU(s):                          192
# NUMA node0 CPU(s):               0-95
# NUMA node1 CPU(s):               96-191

# View cache topology
ls /sys/devices/system/cpu/cpu0/cache/
cat /sys/devices/system/cpu/cpu0/cache/index3/shared_cpu_list  # L3 shared CPUs

# Per-core NUMA affinity
cat /sys/devices/system/cpu/cpu0/topology/core_id
cat /sys/devices/system/cpu/cpu0/topology/physical_package_id
```

### NUMA Memory Access Performance

```bash
# Measure NUMA memory bandwidth with stream
numactl --membind=0 --cpunodebind=0 ./stream  # Local access
numactl --membind=1 --cpunodebind=0 ./stream  # Remote access

# Use numastat to monitor NUMA hit/miss rates
numastat -p <PID>
# numa_hit      : accesses to memory on local NUMA node
# numa_miss     : accesses that had to use remote NUMA node
# local_node    : allocations on local NUMA node
# other_node    : allocations on remote NUMA node

# Continuous monitoring
watch -n1 numastat
```

## taskset: CPU Affinity for Processes

### Basic taskset Usage

```bash
# Run a new process pinned to CPU 0
taskset -c 0 myapp

# Run on CPUs 0-3 (cores 0 through 3)
taskset -c 0-3 myapp

# Run on specific non-contiguous CPUs
taskset -c 0,2,4,6 myapp

# Use hex bitmask (bit N = CPU N)
# 0x5 = binary 0101 = CPUs 0 and 2
taskset 0x5 myapp

# Change affinity of an existing process
taskset -cp 0-3 <PID>

# View current affinity of a process
taskset -cp <PID>
# Output: pid 12345's current affinity list: 0-191

# Set affinity for a process and all children
# (taskset doesn't automatically do this — need cpuset or cgroups)
```

### CPU Affinity via /proc

```bash
# View affinity in hex via /proc
cat /proc/<PID>/status | grep Cpus_allowed
# Cpus_allowed: ffffffff,ffffffff,ffffffff  (all CPUs)

# Set via sched_setaffinity syscall in C
cat > pin_process.c << 'EOF'
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <pid> <cpu_list>\n", argv[0]);
        return 1;
    }

    pid_t pid = atoi(argv[1]);
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);

    // Parse comma-separated CPU list
    char *cpu_str = argv[2];
    char *token = strtok(cpu_str, ",");
    while (token) {
        CPU_SET(atoi(token), &cpuset);
        token = strtok(NULL, ",");
    }

    if (sched_setaffinity(pid, sizeof(cpuset), &cpuset) == -1) {
        perror("sched_setaffinity");
        return 1;
    }

    printf("CPU affinity set successfully for PID %d\n", pid);
    return 0;
}
EOF
gcc -O2 -o pin_process pin_process.c
```

### CPU Affinity in Go

```go
// pkg/cpuaffinity/affinity.go
package cpuaffinity

import (
    "fmt"
    "os"
    "runtime"
    "syscall"
    "unsafe"
)

// CPUSet represents a set of CPUs (matches kernel cpu_set_t)
type CPUSet struct {
    bits [1024 / 64]uint64 // 1024 CPUs max
}

func (s *CPUSet) Set(cpu int) {
    if cpu < 0 || cpu >= 1024 {
        return
    }
    s.bits[cpu/64] |= 1 << uint(cpu%64)
}

func (s *CPUSet) Clear(cpu int) {
    if cpu < 0 || cpu >= 1024 {
        return
    }
    s.bits[cpu/64] &^= 1 << uint(cpu%64)
}

func (s *CPUSet) IsSet(cpu int) bool {
    if cpu < 0 || cpu >= 1024 {
        return false
    }
    return s.bits[cpu/64]&(1<<uint(cpu%64)) != 0
}

// SetAffinity sets the CPU affinity for the given PID
// Pass 0 for the current process
func SetAffinity(pid int, cpus []int) error {
    var cpuSet CPUSet
    for _, cpu := range cpus {
        cpuSet.Set(cpu)
    }

    _, _, errno := syscall.RawSyscall(
        syscall.SYS_SCHED_SETAFFINITY,
        uintptr(pid),
        unsafe.Sizeof(cpuSet),
        uintptr(unsafe.Pointer(&cpuSet)),
    )

    if errno != 0 {
        return fmt.Errorf("sched_setaffinity: %w", errno)
    }
    return nil
}

// GetAffinity returns the CPU affinity mask for the given PID
func GetAffinity(pid int) ([]int, error) {
    var cpuSet CPUSet

    _, _, errno := syscall.RawSyscall(
        syscall.SYS_SCHED_GETAFFINITY,
        uintptr(pid),
        unsafe.Sizeof(cpuSet),
        uintptr(unsafe.Pointer(&cpuSet)),
    )

    if errno != 0 {
        return nil, fmt.Errorf("sched_getaffinity: %w", errno)
    }

    var cpus []int
    for i := 0; i < 1024; i++ {
        if cpuSet.IsSet(i) {
            cpus = append(cpus, i)
        }
    }
    return cpus, nil
}

// PinCurrentGoroutine pins the current goroutine's OS thread to a specific CPU
// Must be called with runtime.LockOSThread() first
func PinCurrentGoroutine(cpu int) error {
    runtime.LockOSThread()
    return SetAffinity(0, []int{cpu})
}
```

## numactl: NUMA-Aware Process Execution

### Memory Binding Policies

```bash
# NUMA node binding policies:
# --membind=<nodes>    — only allocate from specified nodes
# --preferred=<node>   — prefer this node, fall back to others
# --interleave=<nodes> — round-robin allocation across nodes
# --localalloc         — always allocate on the CPU's local node

# Run PostgreSQL pinned to NUMA node 0 with local memory
numactl --cpunodebind=0 --membind=0 postgres -D /var/lib/postgresql/data

# Run a memory-bandwidth-intensive app with interleaved allocation
# (good for applications that scan large datasets)
numactl --interleave=all ./data_scanner

# Run on specific CPUs with memory from a specific node
numactl --physcpubind=0,1,2,3 --membind=0 myapp

# Check the NUMA policy of a running process
cat /proc/<PID>/numa_maps | head -20
# Output format: address memtype meminfo
# 7f8e0a000000 default anon=512 dirty=512 N0=256 N1=256
# N0=256 means 256 pages on NUMA node 0

# Detailed NUMA memory mapping
numastat -p <PID>
```

### NUMA-Aware Go Applications

```go
// pkg/numamem/allocator.go
package numamem

/*
#include <numa.h>
#include <stdlib.h>
#include <string.h>

void* numa_alloc_on_node(size_t size, int node) {
    void *ptr = numa_alloc_onnode(size, node);
    if (ptr) memset(ptr, 0, size);
    return ptr;
}

void numa_free_mem(void *ptr, size_t size) {
    numa_free(ptr, size);
}

int get_numa_node_for_cpu(int cpu) {
    return numa_node_of_cpu(cpu);
}
*/
import "C"
import (
    "fmt"
    "runtime"
    "unsafe"
)

// AllocOnNode allocates memory on a specific NUMA node
// Returns a byte slice backed by NUMA-local memory
func AllocOnNode(size int, node int) ([]byte, error) {
    if size <= 0 {
        return nil, fmt.Errorf("size must be positive")
    }

    ptr := C.numa_alloc_on_node(C.size_t(size), C.int(node))
    if ptr == nil {
        return nil, fmt.Errorf("numa_alloc_onnode failed for node %d size %d", node, size)
    }

    // Create a Go slice backed by the NUMA-allocated memory
    // WARNING: This memory is not managed by Go's GC
    // Must call FreeOnNode when done
    slice := unsafe.Slice((*byte)(ptr), size)
    return slice, nil
}

// FreeOnNode frees NUMA-allocated memory
func FreeOnNode(mem []byte) {
    if len(mem) == 0 {
        return
    }
    C.numa_free_mem(unsafe.Pointer(&mem[0]), C.size_t(len(mem)))
}

// GetNodeForCPU returns the NUMA node for a given CPU
func GetNodeForCPU(cpu int) int {
    return int(C.get_numa_node_for_cpu(C.int(cpu)))
}

// GetCurrentCPUNode returns the NUMA node of the current goroutine's CPU
func GetCurrentCPUNode() int {
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()
    cpu, _ := sched_getcpu()
    return GetNodeForCPU(cpu)
}
```

## isolcpus: Reserving CPUs from the Kernel Scheduler

The `isolcpus` kernel parameter removes CPUs from the general kernel scheduler, making them available only for processes explicitly pinned to them.

```bash
# Edit GRUB to add isolcpus
vim /etc/default/grub

# Add to GRUB_CMDLINE_LINUX:
# isolcpus=2-15,18-31          — isolate cores 2-15 and 18-31
# nohz_full=2-15,18-31         — disable timer ticks on isolated CPUs
# rcu_nocbs=2-15,18-31         — move RCU callbacks off isolated CPUs
# irqaffinity=0,1,16,17        — keep IRQs on non-isolated CPUs

GRUB_CMDLINE_LINUX="isolcpus=2-15,18-31 nohz_full=2-15,18-31 rcu_nocbs=2-15,18-31 irqaffinity=0,1,16,17"

# Apply
update-grub
reboot

# Verify after reboot
cat /sys/devices/system/cpu/isolated
# Output: 2-15,18-31

cat /proc/cmdline | grep isolcpus

# Move processes to non-isolated CPUs (housekeeping)
# The kernel automatically does this, but verify
cat /proc/1/status | grep Cpus_allowed_list
# Should show only 0,1,16,17 (non-isolated CPUs)

# Run application on isolated CPUs
taskset -c 2-15 mylatency-critical-app
```

### cpuset Cgroups for Isolation

For finer control, use cpuset cgroups:

```bash
# Create a cpuset for latency-sensitive work
mkdir -p /sys/fs/cgroup/cpuset/realtime

# Assign isolated CPUs
echo "2-15" > /sys/fs/cgroup/cpuset/realtime/cpuset.cpus

# Assign NUMA-local memory
echo "0" > /sys/fs/cgroup/cpuset/realtime/cpuset.mems

# Enable exclusive CPU use (optional — prevents scheduler use)
echo "1" > /sys/fs/cgroup/cpuset/realtime/cpuset.cpu_exclusive

# Move process to the cpuset
echo <PID> > /sys/fs/cgroup/cpuset/realtime/tasks

# Verify
cat /proc/<PID>/status | grep Cpus_allowed_list
```

## IRQ Affinity for Network Performance

Network interface interrupts (IRQs) should be pinned to CPUs on the same NUMA node as the NIC. Receiving interrupts on the wrong NUMA node wastes memory bandwidth through cross-NUMA cache transfers.

### Discovering NIC IRQs

```bash
# List all network-related IRQs
grep eth /proc/interrupts
# Or for modern naming:
grep -E "mlx5|nvme|ena" /proc/interrupts

# View current IRQ affinity
for irq in $(grep eth0 /proc/interrupts | awk '{print $1}' | tr -d :); do
    echo "IRQ $irq affinity: $(cat /proc/irq/$irq/smp_affinity_list)"
done

# Find which NUMA node the NIC is on
cat /sys/class/net/eth0/device/numa_node
# Output: 0 (NIC is on NUMA node 0)

# List PCI device NUMA node
lspci -vvv | grep -A20 "Ethernet" | grep NUMA
```

### Setting IRQ Affinity

```bash
#!/bin/bash
# set-irq-affinity.sh — Pin NIC IRQs to CPUs on the same NUMA node

NIC="eth0"
NUMA_NODE=$(cat /sys/class/net/$NIC/device/numa_node)

# Get CPUs on the NIC's NUMA node
CPUS=$(numactl --hardware | grep "node $NUMA_NODE cpus:" | cut -d: -f2)
echo "NIC $NIC is on NUMA node $NUMA_NODE, CPUs: $CPUS"

# Convert CPU list to hex bitmask
# For NUMA node 0 with CPUs 0-15: mask = 0x0000FFFF
cpu_list_to_mask() {
    local cpus="$1"
    local mask=0
    for cpu in $(echo "$cpus" | tr ' ' '\n' | tr -d '\n'); do
        mask=$((mask | (1 << cpu)))
    done
    printf "%x" $mask
}

MASK=$(cpu_list_to_mask "$CPUS")
echo "CPU mask: 0x$MASK"

# Find all IRQs for this NIC
IRQ_LIST=$(grep "$NIC" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')

for irq in $IRQ_LIST; do
    echo "Setting IRQ $irq affinity to 0x$MASK"
    echo "$MASK" > /proc/irq/$irq/smp_affinity
done

# Verify
echo "Verification:"
for irq in $IRQ_LIST; do
    echo "IRQ $irq: $(cat /proc/irq/$irq/smp_affinity_list)"
done
```

### Multi-Queue NIC Optimization (RSS)

Modern NICs support Receive Side Scaling (RSS) — distributing receive interrupts across multiple queues, each mapped to a different CPU.

```bash
# Check number of RX queues
ethtool -l eth0
# Current hardware settings:
# RX:     16
# TX:     16

# The goal: one queue per CPU core, all on the same NUMA node
# For a NIC on NUMA node 0 with CPUs 0-15:
# Queue 0 -> IRQ -> CPU 0
# Queue 1 -> IRQ -> CPU 1
# ... etc.

# Check current queue-to-CPU mapping
cat /sys/class/net/eth0/queues/rx-0/rps_cpus  # Software RSS
ls /proc/irq/ | xargs -I{} bash -c 'grep -l "eth0-TxRx" /proc/irq/{}/actions 2>/dev/null && echo IRQ: {}'

# Use the irqbalance daemon with hints file (easier than manual)
# But irqbalance may undo manual settings — disable it for precise control
systemctl stop irqbalance
systemctl disable irqbalance

# Automatic RSS configuration script
for i in $(seq 0 15); do
    queue_irq=$(grep "eth0-TxRx-$i" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')
    if [ -n "$queue_irq" ]; then
        echo $i > /proc/irq/$queue_irq/smp_affinity_list
        echo "Queue $i -> CPU $i (IRQ $queue_irq)"
    fi
done
```

### XPS: Transmit Packet Steering

```bash
# XPS maps CPU -> TX queue to avoid cross-CPU locking on transmit
# CPU 0 uses TX queue 0, CPU 1 uses TX queue 1, etc.

for cpu in $(seq 0 15); do
    # Create bitmask for this CPU only
    mask=$(printf "%x" $((1 << cpu)))
    echo $mask > /sys/class/net/eth0/queues/tx-$cpu/xps_cpus
    echo "TX queue $cpu -> CPU $cpu (mask: 0x$mask)"
done
```

## DPDK CPU Isolation

DPDK (Data Plane Development Kit) is used for line-rate packet processing. It completely bypasses the Linux kernel networking stack and requires dedicated CPU cores.

### DPDK CPU Isolation Setup

```bash
# Kernel parameters for DPDK
# Add to GRUB_CMDLINE_LINUX:
GRUB_CMDLINE_LINUX="isolcpus=2-15 nohz_full=2-15 rcu_nocbs=2-15 \
  default_hugepagesz=1G hugepagesz=1G hugepages=32 \
  iommu=pt intel_iommu=on"

# Allocate hugepages for DPDK
echo 32 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Mount hugepages
mkdir -p /mnt/huge
mount -t hugetlbfs nodev /mnt/huge

# Verify
grep HugePages /proc/meminfo
# HugePages_Total:      32
# HugePages_Free:       32
# Hugepagesize:   1048576 kB

# Bind NIC to DPDK-compatible driver (vfio-pci for IOMMU)
modprobe vfio-pci

# Get PCI address of the NIC
dpdk-devbind.py --status | grep -E "mlx5|ixgbe|i40e"
# 0000:01:00.0 'Ethernet Controller' drv=ixgbe unused=vfio-pci

# Bind to vfio-pci
dpdk-devbind.py --bind=vfio-pci 0000:01:00.0
```

### DPDK Application with CPU Pinning

```c
// dpdk_app.c — Example DPDK application with CPU pinning
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_launch.h>
#include <rte_lcore.h>
#include <rte_mbuf.h>

#define NUM_MBUFS      8192
#define MBUF_CACHE     512
#define BURST_SIZE     256

// Per-lcore (CPU) data
struct lcore_data {
    uint16_t port_id;
    uint16_t queue_id;
} lcore_data[RTE_MAX_LCORE];

// Packet processing function — runs on a dedicated CPU core
static int lcore_process_packets(void *arg) {
    struct lcore_data *data = (struct lcore_data *)arg;
    unsigned lcore_id = rte_lcore_id();

    printf("lcore %u processing port %u queue %u\n",
        lcore_id, data->port_id, data->queue_id);

    struct rte_mbuf *bufs[BURST_SIZE];

    while (1) {
        // Receive a burst of packets
        uint16_t nb_rx = rte_eth_rx_burst(
            data->port_id, data->queue_id, bufs, BURST_SIZE);

        if (nb_rx == 0)
            continue;

        // Process packets
        for (uint16_t i = 0; i < nb_rx; i++) {
            // ... process bufs[i] ...
            rte_pktmbuf_free(bufs[i]);
        }
    }
    return 0;
}

int main(int argc, char *argv[]) {
    // EAL arguments:
    // -l 2-15       — use cores 2-15
    // -n 4          — 4 memory channels
    // --socket-mem  — per-socket huge pages
    // --master-lcore 2 — main core
    char *eal_argv[] = {
        argv[0],
        "-l", "2-15",           // Isolated CPUs
        "-n", "4",
        "--socket-mem", "8192,0",  // 8GB on NUMA node 0
        "--master-lcore", "2",
        NULL
    };
    int eal_argc = sizeof(eal_argv)/sizeof(eal_argv[0]) - 1;

    // Initialize DPDK EAL
    int ret = rte_eal_init(eal_argc, eal_argv);
    if (ret < 0)
        rte_exit(EXIT_FAILURE, "EAL init failed\n");

    // Assign one queue per lcore (starting from lcore 3)
    unsigned lcore_id;
    int queue_id = 0;
    RTE_LCORE_FOREACH_WORKER(lcore_id) {
        lcore_data[lcore_id].port_id = 0;
        lcore_data[lcore_id].queue_id = queue_id++;
    }

    // Launch per-core workers
    RTE_LCORE_FOREACH_WORKER(lcore_id) {
        rte_eal_remote_launch(
            lcore_process_packets,
            &lcore_data[lcore_id],
            lcore_id
        );
    }

    rte_eal_mp_wait_lcore();
    return 0;
}
```

## Monitoring and Validation

### Verifying NUMA Locality

```bash
# Monitor NUMA-related performance counters
perf stat -e \
  cache-misses,cache-references,\
  LLC-loads,LLC-load-misses,\
  node-loads,node-load-misses,\
  node-stores,node-store-misses \
  -p <PID> sleep 10

# Expected output for well-configured NUMA:
# Low node-load-misses/node-loads ratio (< 5%)

# PCM (Intel Performance Counter Monitor) for NUMA
pcm-memory.x

# For AMD: use AMDuProf
AMDuProfCLI collect -v memory-access -d 10 -p <PID>
```

### Latency Profiling

```bash
# Measure scheduling jitter on isolated CPUs
# Install rt-tests
apt install rt-tests

# Test scheduling latency on isolated core
taskset -c 4 cyclictest \
  --mlockall \
  --smp \
  --priority=99 \
  --interval=200 \
  --distance=0 \
  --duration=60 \
  --loops=100000 \
  --histogram=400 \
  --histofall

# Expected on well-isolated system:
# Max latency: < 10 microseconds
# On untuned system: can be > 1 millisecond

# Compare isolated vs non-isolated
taskset -c 0 cyclictest --priority=99 --interval=200 --loops=10000  # Non-isolated
taskset -c 4 cyclictest --priority=99 --interval=200 --loops=10000  # Isolated
```

### Network IRQ Statistics

```bash
# Monitor IRQ distribution across CPUs
watch -n1 'grep eth0 /proc/interrupts'

# Check for IRQ imbalance (all IRQs on CPU 0 = problem)
# Output should show roughly equal counts across CPUs 0-15

# Use irqtop for real-time IRQ monitoring
irqtop

# Check softirq distribution (NET_RX processing)
watch -n1 'cat /proc/softirqs | grep NET_RX'

# Per-CPU network statistics
ip -s link show eth0
# rx_packets and tx_packets should be distributed across CPUs
for cpu in $(seq 0 15); do
    echo -n "CPU $cpu: "
    cat /sys/class/net/eth0/queues/rx-$cpu/rps_flow_cnt 2>/dev/null || echo "N/A"
done
```

## Putting It Together: Production Configuration

### System Tuning Script

```bash
#!/bin/bash
# tune-latency-critical-system.sh

set -euo pipefail

NIC="${1:-eth0}"
ISOLATED_CPUS="2-15"
HOUSEKEEPING_CPUS="0,1"
NUMA_NODE=0

echo "=== Configuring latency-critical system ==="
echo "NIC: $NIC"
echo "Isolated CPUs: $ISOLATED_CPUS"
echo "Housekeeping CPUs: $HOUSEKEEPING_CPUS"

# 1. Stop irqbalance
systemctl stop irqbalance || true
systemctl disable irqbalance || true
echo "[1/6] Stopped irqbalance"

# 2. Set IRQ affinity for NIC
NIC_NUMA=$(cat /sys/class/net/$NIC/device/numa_node 2>/dev/null || echo 0)
HOUSEKEEPING_MASK=$(python3 -c "
cpus = '$HOUSEKEEPING_CPUS'.split(',')
mask = 0
for c in cpus:
    if '-' in c:
        start, end = map(int, c.split('-'))
        for i in range(start, end+1):
            mask |= 1 << i
    else:
        mask |= 1 << int(c)
print(hex(mask))
")

for irq in $(grep "$NIC" /proc/interrupts | cut -d: -f1 | tr -d ' '); do
    echo $HOUSEKEEPING_MASK | tr -d '0x' > /proc/irq/$irq/smp_affinity
done
echo "[2/6] Set IRQ affinity for $NIC"

# 3. Configure RSS queue-to-CPU mapping
queue=0
for cpu in $(echo $ISOLATED_CPUS | tr ',' '\n' | while read c; do
    if [[ "$c" == *-* ]]; then
        seq ${c%-*} ${c#*-}
    else
        echo $c
    fi
done); do
    irq=$(grep "${NIC}-TxRx-${queue}" /proc/interrupts 2>/dev/null | cut -d: -f1 | tr -d ' ')
    if [ -n "$irq" ]; then
        echo $cpu > /proc/irq/$irq/smp_affinity_list
    fi
    queue=$((queue + 1))
done
echo "[3/6] Configured RSS queue affinity"

# 4. Set kernel scheduling parameters
echo -1 > /proc/sys/kernel/sched_rt_runtime_us   # Unlimited RT scheduling
echo 0   > /proc/sys/kernel/numa_balancing        # Disable NUMA rebalancing
echo 1   > /proc/sys/vm/swappiness               # Minimize swapping
echo "[4/6] Configured kernel scheduler"

# 5. Set CPU frequency governor to performance
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu 2>/dev/null || true
done
echo "[5/6] Set CPU frequency governor"

# 6. Configure hugepages
echo 1024 > /proc/sys/vm/nr_hugepages  # 2MB hugepages
echo "[6/6] Configured hugepages"

echo "=== System tuning complete ==="
echo "Run your latency-sensitive app with:"
echo "  numactl --cpunodebind=$NUMA_NODE --membind=$NUMA_NODE taskset -c $ISOLATED_CPUS myapp"
```

CPU affinity, NUMA awareness, and IRQ pinning are the foundation of sub-microsecond tail latency in Linux systems. The combination of `isolcpus`, per-NIC IRQ affinity, and NUMA-local memory allocation can reduce p99 network latency from milliseconds to tens of microseconds — essential for trading systems, real-time telemetry, and high-performance storage servers.
