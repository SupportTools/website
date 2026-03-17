---
title: "Linux Interrupt Handling and Softirq: Kernel Bottom Half Mechanisms"
date: 2029-08-02T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Interrupts", "Softirq", "Performance", "Containers", "Networking"]
categories: ["Linux", "Systems Programming", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux interrupt handling: hardirq vs softirq, tasklets, workqueues, threaded interrupts, analyzing /proc/interrupts, and the latency impact of interrupt handling on containerized workloads."
more_link: "yes"
url: "/linux-interrupt-handling-softirq-kernel-bottom-half-mechanisms/"
---

Every network packet, disk I/O completion, and timer expiration generates a hardware interrupt. The Linux kernel's interrupt handling architecture determines how quickly your system responds to these events and how much CPU time is spent servicing them. For containerized workloads, particularly those running high-throughput networking or real-time processing, understanding interrupt affinity, softirq saturation, and bottom-half processing latency is often the difference between a system that performs as expected and one that mysteriously drops packets or has unpredictable tail latencies. This guide covers the full interrupt handling pipeline from hardware to application.

<!--more-->

# Linux Interrupt Handling and Softirq: Kernel Bottom Half Mechanisms

## The Interrupt Handling Architecture

Hardware interrupts require the CPU to stop what it's doing, save state, and run the interrupt handler immediately. But interrupt handlers must be fast because interrupts are disabled while they run (on a single CPU). The Linux kernel solves this with the "top-half / bottom-half" split:

**Top half (hardirq)**: Runs immediately when the interrupt fires. Minimal work: acknowledge the interrupt, save critical data, schedule bottom-half processing. Interrupts disabled on the current CPU.

**Bottom half**: Deferred processing of the work the interrupt triggered. Several mechanisms:
- **Softirqs**: Kernel thread-like execution, run with interrupts enabled. Fixed set, statically allocated.
- **Tasklets**: Built on softirqs, dynamically allocated, guaranteed not to run concurrently on multiple CPUs.
- **Workqueues**: Kernel threads that can sleep, used for work that needs blocking operations.
- **Threaded interrupts**: Each IRQ can have its own kernel thread, available since Linux 2.6.30.

```
Hardware Event
     |
     v
CPU interrupt vector
     |
     v (interrupts disabled on this CPU)
Top Half (hardirq handler)
- Acknowledge interrupt
- Read critical data into kernel buffers
- Schedule bottom half
     |
     v (interrupts re-enabled)
Bottom Half (softirq/tasklet/workqueue)
- Process received data
- Allocate memory
- Update kernel structures
     |
     v
Application Space
```

## Analyzing /proc/interrupts

```bash
# View current interrupt counts
cat /proc/interrupts

# Sample output (64-core system):
#            CPU0       CPU1  ... CPU63
#   0:          9          0  ...     0  IR-IO-APIC    2-edge      timer
#   1:          0          0  ...     0  IR-IO-APIC    1-edge      i8042
#  16:          0          0  ...     0  IR-IO-APIC   16-edge      ehci_hcd:usb1
# 120:    1523456      87654  ...     0  IR-PCI-MSI  524288-edge   xhci_hcd
# 121:  982345678   12345678  ...     0  IR-PCI-MSI  524289-edge   eth0
# 122:   45678901    3456789  ...     0  IR-PCI-MSI  524290-edge   eth0-rx-0
# 123:   23456789    2345678  ...     0  IR-PCI-MSI  524291-edge   eth0-rx-1
# NMI:          3          3  ...     3  Non-maskable interrupts
# LOC: 4567890123  456789012  ...     0  Local timer interrupts
# SPU:          0          0  ...     0  Spurious interrupts
# PMI:          0          0  ...     0  Performance monitoring interrupts
# IWI:      12345      12345  ...     0  IRQ work interrupts
# RTR:          0                        APIC ICR read retries
# RES:  1234567890  123456789 ...     0  Rescheduling interrupts
# CAL:    1234567    1234567  ...     0  Function call interrupts
# TLB:     987654     987654  ...     0  TLB shootdowns
# ERR:          0
# MIS:          0
# PIN:          0          0  ...     0  Posted-interrupt notification event
# NPI:          0          0  ...     0  Nested posted-interrupt event
# PIW:          0          0  ...     0  Posted-interrupt wakeup event

# Watch interrupt rates in real-time
watch -n 1 -d "cat /proc/interrupts"

# Calculate interrupt rate per second
#!/bin/bash
prev=$(grep "eth0-rx-0" /proc/interrupts | awk '{sum=0; for(i=2;i<=NF-3;i++) sum+=$i; print sum}')
sleep 1
curr=$(grep "eth0-rx-0" /proc/interrupts | awk '{sum=0; for(i=2;i<=NF-3;i++) sum+=$i; print sum}')
echo "IRQs/second: $((curr - prev))"
```

### Checking Softirq Statistics

```bash
# /proc/softirqs shows per-CPU softirq counts by type
cat /proc/softirqs

# Output:
#                     CPU0       CPU1       CPU2       CPU3
#           HI:          5          4          3          2   <- High priority tasklets
#        TIMER:  123456789  234567890  123456789  234567890   <- Timer softirqs
#       NET_TX:      12345      23456      12345      23456   <- Network transmit
#       NET_RX:  987654321  876543210  987654321  876543210   <- Network receive
#        BLOCK:      54321      65432      54321      65432   <- Block I/O completions
#     IRQ_POLL:          0          0          0          0   <- I/O polling
#      TASKLET:    1234567    2345678    1234567    2345678   <- Tasklet processing
#        SCHED:  456789012  567890123  456789012  567890123   <- Scheduler
#      HRTIMER:   23456789   34567890   23456789   34567890   <- High-res timers
#          RCU:  789012345  890123456  789012345  890123456   <- RCU callbacks

# Monitor softirq rates
#!/bin/bash
while true; do
    cat /proc/softirqs | awk '
    BEGIN { print strftime("%H:%M:%S") }
    /NET_RX/ {
        sum = 0
        for (i=2; i<=NF; i++) sum += $i
        printf "NET_RX total: %d\n", sum
    }'
    sleep 1
done

# Check ksoftirqd CPU usage (softirq kernel threads)
top -bn1 | grep ksoftirqd
ps aux | grep ksoftirqd
```

## IRQ Affinity Configuration

Binding interrupts to specific CPUs is critical for network-intensive workloads and latency-sensitive applications.

### Viewing and Setting IRQ Affinity

```bash
# View affinity for all IRQs
for irq in /proc/irq/*/smp_affinity; do
    irq_num=$(echo $irq | awk -F/ '{print $4}')
    affinity=$(cat $irq)
    echo "IRQ $irq_num: $affinity"
done

# View effective affinity (after IRQBALANCE adjustments)
for irq in /proc/irq/*/effective_affinity_list; do
    irq_num=$(echo $irq | awk -F/ '{print $4}')
    cpus=$(cat $irq)
    echo "IRQ $irq_num: CPUs $cpus"
done

# Set IRQ to specific CPU (CPU 0 = bitmask 0x1, CPU 1 = 0x2, CPU 2 = 0x4...)
# Bind network IRQ to CPU 4 (bitmask = 0x10)
IRQ_NUM=$(grep "eth0-rx-0" /proc/interrupts | awk '{print $1}' | tr -d ':')
echo "10" > /proc/irq/${IRQ_NUM}/smp_affinity

# Bind to multiple CPUs (CPUs 4-7 = 0xf0)
echo "f0" > /proc/irq/${IRQ_NUM}/smp_affinity

# Using CPU list format instead of bitmask
echo "4-7" > /proc/irq/${IRQ_NUM}/smp_affinity_list
```

### Automatic IRQ Affinity for Network Cards

Modern NICs with multiple queues (RSS/RFS) benefit from systematic IRQ pinning:

```bash
#!/bin/bash
# set-irq-affinity.sh - Pin NIC queues to CPU cores
# Based on the set_irq_affinity scripts used in high-performance networking

NIC="${1:-eth0}"
NUM_QUEUES=$(ls /sys/class/net/${NIC}/queues/ | grep -c rx)
NUM_CPUS=$(nproc)

echo "NIC: ${NIC}, Queues: ${NUM_QUEUES}, CPUs: ${NUM_CPUS}"

# Stop irqbalance from overriding our settings
systemctl stop irqbalance

# Find IRQs for this NIC
IRQ_LIST=()
while read -r irq_num irq_name; do
    if echo "$irq_name" | grep -q "^${NIC}"; then
        IRQ_LIST+=("$irq_num")
    fi
done < <(grep "${NIC}" /proc/interrupts | awk '{print $1, $NF}' | tr -d ':')

echo "Found ${#IRQ_LIST[@]} IRQs for ${NIC}"

# Pin each queue IRQ to a dedicated CPU
for i in "${!IRQ_LIST[@]}"; do
    irq="${IRQ_LIST[$i]}"
    cpu=$((i % NUM_CPUS))

    # Calculate bitmask: CPU N = 2^N
    bitmask=$(python3 -c "print(hex(1 << $cpu)[2:])")

    echo "${bitmask}" > /proc/irq/${irq}/smp_affinity
    echo "  IRQ ${irq} -> CPU ${cpu} (mask: 0x${bitmask})"
done

# Set RPS (Receive Packet Steering) for software-side distribution
RPS_CPUS=$(python3 -c "print(hex((1 << $(nproc)) - 1)[2:])")
for queue in /sys/class/net/${NIC}/queues/rx-*/rps_cpus; do
    echo "${RPS_CPUS}" > "$queue"
done

# Set RFS (Receive Flow Steering) to route packets to the CPU that last processed the flow
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
for queue in /sys/class/net/${NIC}/queues/rx-*/rps_flow_cnt; do
    echo $((32768 / NUM_QUEUES)) > "$queue"
done

echo "IRQ affinity configured"
```

### CPU Isolation for Interrupt-Free Application Cores

```bash
# Kernel command line parameters for CPU isolation
# /etc/default/grub
GRUB_CMDLINE_LINUX="isolcpus=8-15 nohz_full=8-15 rcu_nocbs=8-15"

# isolcpus: Remove CPUs from general scheduling
# nohz_full: Disable scheduling-clock ticks on these CPUs
# rcu_nocbs: Move RCU callbacks off these CPUs

# After setting, update grub and reboot
update-grub && reboot

# Verify isolation after reboot
cat /sys/devices/system/cpu/isolated
# Should show: 8-15

# Run a latency-sensitive process on isolated CPUs
taskset -c 8-15 numactl --localalloc my-realtime-app

# Check that no interrupts are going to isolated CPUs
for cpu in 8 9 10 11 12 13 14 15; do
    count=$(grep -E "CPU${cpu}" /proc/interrupts | awk '{print $(('"$cpu"'+2))}' | paste -sd+ | bc)
    echo "CPU ${cpu}: ${count} interrupts"
done
```

## Threaded Interrupts

Linux 2.6.30 introduced threaded IRQ handlers that move the actual processing into a kernel thread:

```bash
# View threaded IRQ threads
ps aux | grep "irq/"

# Sample output:
# root   120  0.0  0.0  0  0 ?  S  00:00  0:00 [irq/122-eth0-rx]
# root   121  0.0  0.0  0  0 ?  S  00:00  0:00 [irq/123-eth0-rx]

# Set scheduling policy and priority for IRQ threads
chrt -f -p 50 $(pgrep -f "irq/122-eth0")

# Or use rtirq to manage RT IRQ priorities
# apt-get install rtirq-init
# /etc/rtirq.conf:
# RTIRQ_NAME_LIST="rtc snd timer net"
# RTIRQ_PRIO_HIGH=90
```

## Workqueues: Kernel Threads for Deferred Work

Workqueues differ from softirqs and tasklets in that they run in kernel threads and can sleep:

```bash
# View kernel workqueue threads
ps aux | grep "kworker"

# kworker naming: kworker/<cpu>:<id>[H]
# H = high priority workqueue
# The number after colon is the worker ID within the CPU's pool

# Monitor workqueue utilization
cat /sys/kernel/debug/workqueue/stats

# Or use the worqueue debugfs interface
ls /sys/kernel/debug/workqueue/

# Check per-workqueue stats
for wq in /sys/kernel/debug/workqueue/*/; do
    echo "=== $(basename $wq) ==="
    cat "$wq/stats" 2>/dev/null | head -5
done
```

## Impact on Containerized Workloads

### Container Network Performance and Softirq

Containers share the host kernel, so network-heavy containers compete for softirq processing:

```bash
# Identify which containers are generating the most interrupts
# First, identify container network interfaces
for pid in $(ls /proc/*/net/dev 2>/dev/null | grep -v "self\|thread" | awk -F/ '{print $3}'); do
    container=$(cat /proc/${pid}/cgroup 2>/dev/null | grep "container" | head -1)
    if [[ -n "$container" ]]; then
        echo "${pid}: ${container}"
    fi
done

# For Kubernetes pods, use:
crictl pods | head
crictl inspect <pod-id> | grep pid

# Check if ksoftirqd is saturated
mpstat -I SCPU 1 5 | grep -E "CPU|softirq"

# High ksoftirqd CPU = softirq processing can't keep up
# Solutions:
# 1. Increase interrupt affinity spread
# 2. Enable RSS/RPS/RFS on the NIC
# 3. Reduce container network I/O (batching, compression)
# 4. Use DPDK or XDP for extreme cases
```

### CPU Throttling and Interrupt Interaction

A common issue in Kubernetes: a container that hits its CPU limit gets throttled, but its associated softirq processing continues on the host CPU outside the cgroup limit. This means the container uses more CPU than its limit for network processing:

```bash
# Check CPU throttling
cat /sys/fs/cgroup/cpu/kubepods/pod${POD_ID}/${CONTAINER_ID}/cpu.stat

# Key metrics:
# nr_throttled: Number of times throttled
# throttled_time: Total throttle time in nanoseconds
# throttled_usec: Same in microseconds (newer kernels)

# A heavily throttled container that is also network-intensive
# will see softirq processing happening outside its cgroup,
# effectively giving it more CPU than its limit

# To measure true CPU usage including softirqs:
perf stat -e softirq:softirq_entry,softirq:softirq_exit \
  -p $(pgrep my-container-app) -- sleep 10
```

### eBPF for Interrupt Monitoring

```python
#!/usr/bin/env python3
# softirq-monitor.py - Monitor softirq latency using eBPF/bpftrace

# Run with: bpftrace softirq-monitor.bt

bpftrace_script = """
#include <linux/interrupt.h>

BEGIN {
    printf("Monitoring softirq latency. Ctrl+C to stop.\\n");
    printf("%-10s %-20s %10s\\n", "TIME", "SOFTIRQ", "LATENCY(us)");
}

tracepoint:irq:softirq_entry {
    @start[tid] = nsecs;
    @type[tid] = args->vec;
}

tracepoint:irq:softirq_exit {
    if (@start[tid] != 0) {
        $latency = (nsecs - @start[tid]) / 1000;
        $vec = @type[tid];
        if ($latency > 100) {  // Only show >100us
            printf("%-10llu %-20d %10llu\\n", nsecs, $vec, $latency);
        }
        @latency_hist = hist($latency);
        delete(@start[tid]);
        delete(@type[tid]);
    }
}

END {
    printf("\\nSoftirq latency histogram (microseconds):\\n");
    print(@latency_hist);
    clear(@latency_hist);
}
"""

import subprocess
import tempfile

with tempfile.NamedTemporaryFile(mode='w', suffix='.bt', delete=False) as f:
    f.write(bpftrace_script)
    script_file = f.name

subprocess.run(['bpftrace', script_file])
```

```bash
# Alternative: use perf for softirq latency
perf trace --event softirq:softirq_entry,softirq:softirq_exit 2>&1 | \
  awk '
/softirq_entry/ { start[$3] = $1 }
/softirq_exit/ {
  if (start[$3]) {
    lat = ($1 - start[$3]) * 1000  # Convert to us
    if (lat > 100) printf "Softirq latency: %.2f us (vec=%s)\n", lat, $3
    delete start[$3]
  }
}'

# Continuous latency tracking
# perf-latency.sh
#!/bin/bash
perf record -e irq:softirq_entry,irq:softirq_exit -a -g -- sleep 30
perf report --stdio | head -50
```

## Tuning for High-Performance Networking

### NAPI and Interrupt Coalescing

NAPI (New API) is the Linux network polling mechanism that replaces interrupt-driven packet processing with polling under load:

```bash
# Check NAPI stats
cat /proc/net/dev

# Configure interrupt coalescing on NIC
ethtool -c eth0

# Sample output:
# Coalesce parameters for eth0:
# Adaptive RX: on  TX: on
# rx-usecs: 3           <- Wait 3us before raising RX interrupt
# rx-frames: 0          <- Interrupt after N frames (0 = disabled)
# tx-usecs: 500         <- Wait 500us before raising TX interrupt
# tx-frames: 0

# Increase coalescing for higher throughput (more latency)
ethtool -C eth0 rx-usecs 50 tx-usecs 500

# Decrease for lower latency (more interrupts)
ethtool -C eth0 rx-usecs 0 tx-usecs 0 adaptive-rx off adaptive-tx off

# Disable adaptive coalescing for consistent behavior
ethtool -C eth0 adaptive-rx off adaptive-tx off
```

### /proc/sys/net Tuning for Softirq

```bash
# Increase the softnet backlog (netdev backlog)
# Default 1000, increase for high-packet-rate NICs
sysctl -w net.core.netdev_max_backlog=250000

# Increase netdev budget (max packets to process per softirq cycle)
# Default 300, increase for high-throughput
sysctl -w net.core.netdev_budget=50000
sysctl -w net.core.netdev_budget_usecs=8000

# Socket receive buffer
sysctl -w net.core.rmem_max=134217728
sysctl -w net.core.rmem_default=134217728

# Check for dropped packets (softirq overruns)
netstat -s | grep -i "receive buffer errors\|receive errors\|softirq"
cat /proc/net/dev | awk '{if(NR>2) print $1, "RX_DROP:", $5, "TX_DROP:", $17}'

# Per-CPU dropped packet stats
cat /proc/net/softnet_stat

# Format: total squeezed dropped throttled
# squeezed = times NAPI budget was exhausted (increase budget)
# dropped = packets dropped due to full queue (increase backlog)
```

### XDP for Bypass of Softirq

eXpress Data Path bypasses most of the network stack, processing packets in the driver before they reach NAPI:

```c
// xdp_drop.c - XDP program to drop packets at the NIC driver level
// This avoids even the softirq overhead

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <arpa/inet.h>

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);    // Source IP
    __type(value, __u8);   // 1 = blocked
} blocked_ips SEC(".maps");

SEC("xdp")
int xdp_filter(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Check if source IP is blocked
    __u8 *blocked = bpf_map_lookup_elem(&blocked_ips, &ip->saddr);
    if (blocked && *blocked) {
        return XDP_DROP;  // Drop before softirq processing
    }

    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

```bash
# Load XDP program
clang -O2 -target bpf -c xdp_drop.c -o xdp_drop.o
ip link set dev eth0 xdp obj xdp_drop.o sec xdp

# Verify XDP is loaded
ip link show dev eth0 | grep xdp

# Remove XDP program
ip link set dev eth0 xdp off
```

## Debugging Interrupt-Related Performance Issues

### latency-top: Finding Interrupt Latency Sources

```bash
# Install and run latencytop
apt-get install latencytop
latencytop

# This shows the top latency causes for processes
# Look for entries mentioning interrupts or softirq

# cyclictest for measuring interrupt latency
apt-get install rt-tests
cyclictest -t1 -p99 -n -i1000 -l10000

# Output shows latency distribution for timer interrupts
# T: 0 ( 1234) P:99 I:1000 C: 10000 Min:      5 Act:    6 Avg:    7 Max:   45
# Min/Avg/Max in microseconds
# Max > 100us on a non-RT kernel is normal
# Max > 50us on RT kernel is concerning
```

### ftrace for Interrupt Tracing

```bash
# Enable function tracing for interrupt handlers
echo function_graph > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on

# Filter to just interrupt-related functions
echo "do_irq irq_enter irq_exit" > /sys/kernel/tracing/set_ftrace_filter
echo 1 > /sys/kernel/tracing/tracing_on

# Capture for 1 second
sleep 1
echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/trace | head -100

# irqsoff tracer - find longest interrupt-disabled period
echo irqsoff > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
sleep 5
echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace

# This shows the longest period interrupts were disabled
# Useful for finding latency sources in kernel code paths
```

## Summary

Linux interrupt handling is a multi-layer system where performance at each layer affects application behavior:

1. **Hardware interrupts (top-half)** should execute in microseconds. If your top-half handler takes too long, all other interrupts on that CPU queue up.
2. **Softirqs** handle the bulk of network packet processing. Monitor `/proc/softirqs` and watch `ksoftirqd` CPU usage. Softirq saturation causes packet drops and networking latency.
3. **IRQ affinity** ensures interrupt processing uses the CPUs with local memory access to the NIC. Use `set_irq_affinity.sh` scripts from NIC vendors as a starting point.
4. **CPU isolation** (`isolcpus`) removes CPUs from interrupt delivery and general scheduling, creating deterministic execution environments for latency-sensitive workloads.
5. **Container workloads** inherit host interrupt behavior. Heavily throttled containers can still consume significant CPU for softirq processing outside their cgroup limits.
6. **XDP and DPDK** bypass softirq entirely for maximum throughput or minimum latency, at the cost of significant implementation complexity.
7. **Tools for diagnosis**: `/proc/interrupts`, `/proc/softirqs`, `perf trace`, `bpftrace`, `cyclictest`, and `latencytop` cover all aspects of interrupt-related performance analysis.
