---
title: "Linux Kernel Tracing: ftrace, perf, and BPF for Production Debugging"
date: 2030-12-06T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Tracing", "ftrace", "perf", "BPF", "bpftrace", "Performance", "Debugging"]
categories:
- Linux
- Performance
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux kernel tracing using ftrace function tracing, perf record and report, BPF-based tracing with bpftrace, flame graph generation, tracing kernel scheduler events, and diagnosing latency spikes without code instrumentation."
more_link: "yes"
url: "/linux-kernel-tracing-ftrace-perf-bpf-production-debugging/"
---

When a service exhibits intermittent latency spikes or unexpected CPU usage and you have exhausted application-level profiling, the cause is often in the kernel: scheduler preemptions, memory reclaim, TCP retransmits, or storage I/O waits. These kernel-level behaviors are invisible to application profilers. The Linux kernel's tracing infrastructure — ftrace, perf, and the BPF/eBPF stack — provides surgical observability into what the kernel is doing without requiring application instrumentation, kernel patches, or service restarts.

This guide covers the complete production debugging workflow using these tools: ftrace for function-level kernel tracing, perf for CPU sampling and event counting, bpftrace for dynamic BPF-based analysis, flame graph generation for visual profiling, and specific techniques for diagnosing latency spikes, scheduler issues, and I/O bottlenecks.

<!--more-->

# Linux Kernel Tracing: ftrace, perf, and BPF for Production Debugging

## The Linux Tracing Landscape

The Linux kernel provides multiple tracing mechanisms built on a shared infrastructure:

- **Tracepoints**: Static instrumentation points compiled into the kernel at predictable locations (scheduler events, system calls, block I/O). Low overhead when not enabled.
- **kprobes**: Dynamic instrumentation of any kernel function. Higher overhead but can attach to any kernel symbol.
- **uprobes**: Dynamic instrumentation of userspace functions.
- **perf_events**: The kernel subsystem that aggregates event data from all of the above and hardware performance counters.

The user-facing tools (ftrace, perf, bpftrace, BCC) are different interfaces to these underlying mechanisms:

| Tool | Interface | Use Case |
|------|-----------|----------|
| ftrace | /sys/kernel/debug/tracing | Kernel function call tracing |
| perf | perf_event_open syscall | CPU profiling, event counting |
| bpftrace | BPF programs | Dynamic analysis, custom aggregations |
| BCC | BPF programs (Python/C) | Higher-level tools (tcptracer, biolatency) |

## ftrace: Kernel Function Tracing

ftrace is controlled through a virtual filesystem at `/sys/kernel/debug/tracing/`. It requires root access and is available on all modern Linux kernels without additional installation.

### Basic ftrace Setup

```bash
# Mount debugfs if not already mounted
mount -t debugfs nodev /sys/kernel/debug

# Navigate to the tracing directory
cd /sys/kernel/debug/tracing

# Check available tracers
cat available_tracers
# Output: function function_graph blk mmiotrace nop

# Check current tracer
cat current_tracer
# Output: nop (disabled)

# Check available trace events
ls events/
# Output: block, exceptions, ext4, filemap, kmem, net, sched, signal, skb, sock, syscalls, tcp, ...
```

### Function Tracer: Tracing All Kernel Functions

```bash
# Enable function tracer — WARNING: very high overhead, use briefly
echo function > /sys/kernel/debug/tracing/current_tracer

# Capture a few seconds of data
sleep 2

# Read the trace buffer
cat /sys/kernel/debug/tracing/trace | head -50

# Sample output:
# <idle>-0     [003] d... 12345.678901: do_idle <-cpu_startup_entry
# <idle>-0     [003] d... 12345.678902: cpuidle_enter_state <-do_idle
# myservice-1234 [001] .... 12345.679001: tcp_sendmsg <-sock_sendmsg

# Disable tracer
echo nop > /sys/kernel/debug/tracing/current_tracer
```

### Function Graph Tracer: Call Graph with Timing

The function graph tracer shows a hierarchical call graph with entry/exit timing:

```bash
# Enable function_graph tracer
echo function_graph > /sys/kernel/debug/tracing/current_tracer

# Filter to a specific process PID to reduce noise
echo 1234 > /sys/kernel/debug/tracing/set_ftrace_pid

# Set maximum depth to avoid overwhelming output
echo 5 > /sys/kernel/debug/tracing/max_graph_depth

# Capture trace
sleep 1
cat /sys/kernel/debug/tracing/trace | head -100

# Sample output:
# 1)               |  tcp_sendmsg() {
# 1)               |    lock_sock_nested() {
# 1)   1.234 us    |      _raw_spin_lock_bh();
# 1)   2.567 us    |    }
# 1)               |    tcp_send_mss() {
# 1)   0.891 us    |      tcp_current_mss();
# 1)   1.234 us    |    }
# 1) + 98.765 us   |  } /* tcp_sendmsg */
# The '+' prefix means the function took longer than 10us

# Clear PID filter and disable
echo > /sys/kernel/debug/tracing/set_ftrace_pid
echo nop > /sys/kernel/debug/tracing/current_tracer
```

### Function Filtering

Without filtering, ftrace captures all kernel functions. Filter to specific functions to reduce overhead:

```bash
# Trace only tcp_* functions
echo 'tcp_*' > /sys/kernel/debug/tracing/set_ftrace_filter

# Trace functions related to memory allocation
echo 'kmalloc* kfree* __alloc_pages*' > /sys/kernel/debug/tracing/set_ftrace_filter

# Check what's set
cat /sys/kernel/debug/tracing/set_ftrace_filter

# Notrace filter: exclude specific functions (useful to reduce noise)
echo '__rcu_read_lock __rcu_read_unlock' > /sys/kernel/debug/tracing/set_ftrace_notrace

# Clear filters
echo > /sys/kernel/debug/tracing/set_ftrace_filter
echo > /sys/kernel/debug/tracing/set_ftrace_notrace
```

### Tracepoints: Scheduler Events

Tracepoints provide higher-level, more stable interfaces than raw function tracing:

```bash
# List available scheduler tracepoints
ls /sys/kernel/debug/tracing/events/sched/

# Enable scheduler switch events (shows context switches)
echo 1 > /sys/kernel/debug/tracing/events/sched/sched_switch/enable

# Enable scheduler wakeup events
echo 1 > /sys/kernel/debug/tracing/events/sched/sched_wakeup/enable

# Capture and analyze
cat /sys/kernel/debug/tracing/trace | grep "sched_switch" | \
  awk '{print $1, $2, $NF}' | head -20

# Sample output showing context switches to/from myservice:
# myservice-1234 [003] 12345.000: sched_switch: myservice:1234 [120] R ==> swapper/3:0 [120]
# This shows myservice was preempted and the idle task ran

# Disable tracepoints
echo 0 > /sys/kernel/debug/tracing/events/sched/sched_switch/enable
echo 0 > /sys/kernel/debug/tracing/events/sched/sched_wakeup/enable
```

### Latency Tracer: Finding Scheduling Latency

The `wakeup` and `wakeup_rt` tracers measure the latency from when a task is woken up to when it actually runs on CPU:

```bash
# Use wakeup tracer to measure scheduling latency for a specific PID
echo wakeup > /sys/kernel/debug/tracing/current_tracer
echo 1234 > /sys/kernel/debug/tracing/set_ftrace_pid

# Run for a few seconds
sleep 5

# Read the maximum recorded latency
cat /sys/kernel/debug/tracing/tracing_max_latency
# Output: 1234 (in microseconds)

# Read the trace buffer to see what happened during max latency
cat /sys/kernel/debug/tracing/trace | head -30

echo nop > /sys/kernel/debug/tracing/current_tracer
```

### trace-cmd: ftrace with Better UX

`trace-cmd` wraps the ftrace interface with a much more convenient command-line UX:

```bash
# Install
dnf install -y trace-cmd

# Record scheduler events for 5 seconds
trace-cmd record -e sched:sched_switch -e sched:sched_wakeup -p function -P 1234 sleep 5

# Generate a human-readable report
trace-cmd report trace.dat | head -50

# Record network events
trace-cmd record -e net:netif_receive_skb -e net:net_dev_xmit sleep 10
trace-cmd report trace.dat | grep "myservice"
```

## perf: CPU Profiling and Event Analysis

`perf` is the most versatile Linux performance tool. It can sample CPU call stacks, count hardware performance counter events, trace kernel and userspace functions, and generate flame graphs.

### CPU Profiling with perf record

```bash
# Profile a running process for 30 seconds at 99 Hz
# 99 Hz avoids lockstep with 100Hz timer events
perf record -F 99 -p 1234 -g -- sleep 30

# Profile the entire system
perf record -F 99 -a -g -- sleep 30

# Profile with dwarf unwinding (better for compiled binaries without frame pointers)
perf record -F 99 -p 1234 --call-graph=dwarf -- sleep 30

# View the report interactively
perf report

# View as flat text
perf report --stdio | head -50
```

### perf report: Interpreting Output

```bash
# Show the top functions by CPU time
perf report --stdio --sort comm,dso,symbol | head -40

# Show call graphs
perf report --stdio --call-graph=graph | head -60

# Filter to a specific command
perf report --stdio --comm=myservice | head -40

# Sample output:
# Overhead  Command     Shared Object       Symbol
# ........  .........   .................   ...................................
#   35.12%  myservice   myservice           myservice::processRequest
#   12.45%  myservice   libc.so.6           malloc
#    8.23%  myservice   [kernel]            __sys_recvfrom
#    6.78%  myservice   myservice           encoding/json.Marshal
```

### perf stat: Hardware Performance Counters

```bash
# Count hardware events for a process
perf stat -p 1234 sleep 10

# Sample output:
#  Performance counter stats for process id '1234':
#    42,345,678,123      cycles
#    38,912,456,789      instructions              #    0.92  insn per cycle
#     1,234,567,890      cache-references
#       123,456,789      cache-misses              #   10.00% of all cache refs
#       456,789,012      branch-misses

# Count specific events
perf stat -e cache-misses,cache-references,cycles,instructions -p 1234 sleep 10

# Count with interval output
perf stat -I 1000 -e cache-misses,cycles -p 1234 sleep 30
```

### perf trace: System Call Tracing

`perf trace` provides strace-like system call tracing with much lower overhead:

```bash
# Trace system calls for a process
perf trace -p 1234 --no-syscalls --event 'net:*' 2>&1 | head -30

# Trace specific system calls
perf trace -e read,write,sendto,recvfrom -p 1234 2>&1 | head -30

# Show latency distribution for read system calls
perf trace --summary=syscall -p 1234 sleep 10

# Sample output:
# Summary of events:
#  read                                          1234 [    0.00%,    0.000 ms avg,    0.000 ms max]
#  write                                         5678 [    0.00%,    0.001 ms avg,    0.123 ms max]
#  epoll_wait                                    2345 [   95.23%,  42.123 ms avg,  500.456 ms max]
```

### perf sched: Scheduler Analysis

```bash
# Capture scheduler events (requires root)
perf sched record -- sleep 10

# Analyze scheduler latency statistics
perf sched latency

# Sample output:
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms |
# myservice:(15)        |   1234.567   |    45678 |   0.027 ms       |   15.234 ms      |
# Note high max delay — indicates scheduling latency spikes

# Generate timeline visualization
perf sched timehist | head -30

# Find tasks with highest context switch rate
perf sched map | grep myservice
```

## bpftrace: Dynamic BPF Tracing

bpftrace provides a high-level scripting language for writing BPF programs. It is the most powerful tool for dynamic analysis because it can aggregate data efficiently in the kernel, minimizing overhead.

### Installation

```bash
# Install bpftrace
dnf install -y bpftrace

# Or use the static binary for portable deployment
curl -Lo /usr/local/bin/bpftrace \
  https://github.com/bpftrace/bpftrace/releases/latest/download/bpftrace
chmod +x /usr/local/bin/bpftrace
```

### Basic bpftrace Syntax

```bash
# List available tracepoints
bpftrace -l 'tracepoint:sched:*'

# List available kprobes
bpftrace -l 'kprobe:tcp_*' | head -20

# Run a one-liner: count system calls per process
bpftrace -e 'tracepoint:syscalls:sys_enter_* { @[comm, probe] = count(); }'

# Count TCP connections by destination port
bpftrace -e 'tracepoint:syscalls:sys_enter_connect { @[((struct sockaddr_in *)args->uservaddr)->sin_port] = count(); }'
```

### Latency Histograms

```bash
# Measure read() syscall latency distribution
bpftrace -e '
tracepoint:syscalls:sys_enter_read {
    @start[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_read
/@start[tid]/
{
    @latency_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'

# Sample output:
# @latency_us:
# [0]                  1234 |@@@@@@@@@@@@@@@@@@@@                    |
# [1]                  5678 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
# [2, 4)               2345 |@@@@@@@@@@@@@@@@                        |
# [4, 8)                456 |@@@                                     |
# [8, 16)               123 |                                        |
# [16, 32)               45 |                                        |
# [64, 128)              12 |                                        |
# [256, 512)              3 |                                        |  <- These are latency spikes
# [1K, 2K)                1 |                                        |  <- Investigate!
```

### Tracing Scheduler Preemptions

```bash
#!/usr/bin/env bpftrace
// preemption-latency.bt
// Find tasks being preempted and measure the off-CPU time

tracepoint:sched:sched_switch
{
    // Record when a task gets preempted
    if (args->prev_state == TASK_RUNNING) {
        @preempt_start[args->prev_pid] = nsecs;
    }
    // Record when a task gets back on CPU
    if (@preempt_start[args->next_pid]) {
        $latency_us = (nsecs - @preempt_start[args->next_pid]) / 1000;
        if ($latency_us > 1000) {  // Only report >1ms preemptions
            printf("PID %d was off-CPU for %d us\n", args->next_pid, $latency_us);
        }
        @off_cpu_latency_us = hist($latency_us);
        delete(@preempt_start[args->next_pid]);
    }
}

END
{
    printf("\nOff-CPU latency distribution (microseconds):\n");
    print(@off_cpu_latency_us);
}
```

```bash
bpftrace preemption-latency.bt
```

### TCP Retransmit Tracking

```bash
#!/usr/bin/env bpftrace
// tcp-retransmits.bt
// Track TCP retransmissions with source/destination info

#include <net/sock.h>
#include <linux/tcp.h>

kprobe:tcp_retransmit_skb
{
    $sk = (struct sock *)arg0;
    $dport = ($sk->__sk_common.skc_dport >> 8) | (($sk->__sk_common.skc_dport << 8) & 0xff00);
    printf("TCP retransmit: %s -> %s:%d (PID: %d, CMD: %s)\n",
        ntop($sk->__sk_common.skc_rcv_saddr),
        ntop($sk->__sk_common.skc_daddr),
        $dport,
        pid, comm);
    @retransmits[comm] = count();
}

END
{
    print(@retransmits);
}
```

### Memory Allocation Tracing

```bash
#!/usr/bin/env bpftrace
// malloc-by-size.bt
// Track memory allocations by size class to find allocation patterns

uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc
{
    @alloc_sizes = lhist(arg0, 0, 65536, 1024);
    @alloc_by_stack[ustack] = count();
}

uretprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc
/retval/
{
    @alloc_addrs[retval] = arg0;  // Track address -> size mapping
}

uprobe:/lib/x86_64-linux-gnu/libc.so.6:free
/@alloc_addrs[arg0]/
{
    delete(@alloc_addrs[arg0]);
}

interval:s:30
{
    printf("Live allocations: %d\n", count(@alloc_addrs));
}

END
{
    printf("\nAllocation size distribution:\n");
    print(@alloc_sizes);
    printf("\nTop allocation stacks:\n");
    print(@alloc_by_stack, 10);
}
```

### Block I/O Latency Tracing

```bash
#!/usr/bin/env bpftrace
// block-io-latency.bt
// Measure block I/O latency by device and operation type

tracepoint:block:block_rq_issue
{
    @start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
    $latency_us = (nsecs - @start[args->dev, args->sector]) / 1000;
    @io_latency_us[args->rwbs] = hist($latency_us);
    delete(@start[args->dev, args->sector]);

    if ($latency_us > 100000) {  // Alert on >100ms I/O
        printf("SLOW IO: dev=%d:%d sector=%lu op=%s latency=%dms\n",
            args->dev >> 20, args->dev & 0xfffff,
            args->sector,
            args->rwbs,
            $latency_us / 1000);
    }
}

END
{
    printf("\nBlock I/O latency by operation:\n");
    print(@io_latency_us);
}
```

## Flame Graphs: Visualizing Profiling Data

Flame graphs are a visualization that shows the relative CPU time spent in each call path, making it easy to spot bottlenecks at a glance.

### Generating Flame Graphs from perf

```bash
# Install FlameGraph scripts
git clone https://github.com/brendangregg/FlameGraph /opt/flamegraph

# Capture a CPU profile
perf record -F 99 -p 1234 -g -- sleep 60

# Generate the flame graph
perf script | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl \
    --title "MyService CPU Profile (60s)" \
    --width 1600 \
    > cpu-flamegraph.svg

# View in browser
python3 -m http.server 8080 &
xdg-open http://localhost:8080/cpu-flamegraph.svg
```

### Off-CPU Flame Graphs

Off-CPU flame graphs show where threads are blocked waiting (I/O, locks, sleeps):

```bash
# Capture off-CPU events
perf record -e sched:sched_switch -a -g -- sleep 30

# Generate off-CPU flame graph
perf script | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl \
    --title "Off-CPU Flame Graph" \
    --color io \
    > offcpu-flamegraph.svg
```

### Flame Graphs with bpftrace

```bash
#!/usr/bin/env bpftrace
// cpu-stack-sampling.bt
// Sample CPU stacks for flame graph generation

profile:hz:99
/pid == $1/   // $1 = target PID passed as argument
{
    @stacks[kstack, ustack, comm] = count();
}

END
{
    // Output in folded format for flamegraph.pl
}
```

```bash
# Run the bpftrace script and generate flame graph
bpftrace -f json cpu-stack-sampling.bt 1234 | \
  /opt/flamegraph/flamegraph.pl > bpf-flamegraph.svg
```

## Diagnosing Latency Spikes

Latency spikes are the most common production debugging scenario. Here is the systematic approach:

### Step 1: Correlate Spike Timing with System Events

```bash
# Watch for GC pauses, OOM events, and CPU steal
vmstat 1 | awk '{print strftime("%H:%M:%S"), $0}'

# Watch interrupts and context switches
mpstat -P ALL 1 | head -30

# Check for thermal throttling
watch -n 1 'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq | sort | uniq -c'

# Check for CPU steal (relevant in VMs)
top -b -n 3 | grep "%Cpu"
```

### Step 2: Check Scheduling Latency with perf sched

```bash
# Record scheduler events during a spike
perf sched record -- sleep 30

# Analyze wake-up latency
perf sched latency | sort -k6 -rn | head -20

# Look for tasks with max_delay > 5ms — these are experiencing scheduler latency
```

### Step 3: Correlate with Kernel Activity

```bash
# Check for memory pressure causing latency
bpftrace -e '
kprobe:direct_reclaim_begin { @reclaim_start[tid] = nsecs; }
kprobe:direct_reclaim_end /@reclaim_start[tid]/ {
    printf("Direct reclaim for PID %d took %d us\n",
        pid, (nsecs - @reclaim_start[tid]) / 1000);
    delete(@reclaim_start[tid]);
}'

# Check for THP (Transparent Huge Pages) compaction pauses
bpftrace -e '
kprobe:try_to_compact_pages {
    printf("THP compaction started for PID %d (%s)\n", pid, comm);
    @compact_start = nsecs;
}
kretprobe:try_to_compact_pages /@compact_start/ {
    printf("THP compaction took %d ms\n", (nsecs - @compact_start) / 1e6);
    @compact_start = 0;
}'
```

### Step 4: Diagnose Lock Contention

```bash
# Find kernel lock contention
bpftrace -e '
kprobe:mutex_lock_slowpath
{
    @lock_start[tid] = nsecs;
    @lock_stacks[tid] = kstack;
}
kretprobe:mutex_lock_slowpath
/@lock_start[tid]/
{
    $wait_us = (nsecs - @lock_start[tid]) / 1000;
    if ($wait_us > 1000) {
        printf("Lock wait %d us:\n", $wait_us);
        print(@lock_stacks[tid]);
    }
    delete(@lock_start[tid]);
    delete(@lock_stacks[tid]);
}'
```

### Putting It Together: Latency Spike Investigation Script

```bash
#!/bin/bash
# investigate-latency.sh
# Run during a reported latency spike to capture evidence

PID=${1:-$(pgrep myservice)}
DURATION=${2:-60}
OUTPUT_DIR=/tmp/latency-$(date +%Y%m%d-%H%M%S)
mkdir -p $OUTPUT_DIR

echo "Investigating PID $PID for $DURATION seconds"
echo "Output: $OUTPUT_DIR"

# 1. CPU profile
perf record -F 99 -p $PID -g -o $OUTPUT_DIR/cpu.perf -- sleep $DURATION &
PERF_PID=$!

# 2. Scheduler events
perf sched record -o $OUTPUT_DIR/sched.perf -- sleep $DURATION &
SCHED_PID=$!

# 3. System statistics
vmstat 1 $DURATION > $OUTPUT_DIR/vmstat.txt &
iostat -x 1 $DURATION > $OUTPUT_DIR/iostat.txt &
sar -u -r -q 1 $DURATION > $OUTPUT_DIR/sar.txt &

# 4. Network statistics
netstat -s > $OUTPUT_DIR/netstat-before.txt
sleep $DURATION
netstat -s > $OUTPUT_DIR/netstat-after.txt

# Wait for perf processes
wait $PERF_PID $SCHED_PID

# 5. Generate flame graph
perf script -i $OUTPUT_DIR/cpu.perf | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl > $OUTPUT_DIR/cpu-flame.svg

# 6. Analyze scheduling
perf sched latency -i $OUTPUT_DIR/sched.perf > $OUTPUT_DIR/sched-latency.txt
perf sched timehist -i $OUTPUT_DIR/sched.perf > $OUTPUT_DIR/sched-timeline.txt

echo "Analysis complete. Review:"
echo "  $OUTPUT_DIR/cpu-flame.svg     - CPU flame graph"
echo "  $OUTPUT_DIR/sched-latency.txt - Scheduling latency"
echo "  $OUTPUT_DIR/sched-timeline.txt - Scheduling timeline"
echo "  $OUTPUT_DIR/vmstat.txt        - Memory/swap pressure"
echo "  $OUTPUT_DIR/iostat.txt        - I/O utilization"
```

## Privilege Management for Production Tracing

These tools require elevated privileges. Manage them safely:

```bash
# perf paranoid level — controls what non-root can profile
# -1 = allow all, 0 = disallow kernel samples, 1 = disallow callchain, 2 = disallow sampling
cat /proc/sys/kernel/perf_event_paranoid

# For operator profiles, use -1 temporarily
echo -1 > /proc/sys/kernel/perf_event_paranoid

# Restore after profiling
echo 2 > /proc/sys/kernel/perf_event_paranoid

# For containerized environments, give perf capabilities to a debug container
kubectl debug -it --image=nicolaka/netshoot \
  --profile=sysadmin \
  node/my-node-name -- bash

# Inside the debug container:
perf record -F 99 -a -g -- sleep 30
```

### Kubernetes-Native Tracing

```yaml
# debug-pod.yaml — privileged debug pod for kernel tracing
apiVersion: v1
kind: Pod
metadata:
  name: kernel-debug
  namespace: kube-system
spec:
  hostPID: true   # Required for perf to access host processes
  hostNetwork: true
  containers:
    - name: debug
      image: quay.io/cilium/cilium-bpftrace:latest
      command: ["sleep", "infinity"]
      securityContext:
        privileged: true  # Required for kernel tracing
      volumeMounts:
        - name: sys
          mountPath: /sys
        - name: modules
          mountPath: /lib/modules
  volumes:
    - name: sys
      hostPath:
        path: /sys
    - name: modules
      hostPath:
        path: /lib/modules
  nodeSelector:
    kubernetes.io/hostname: target-node
  restartPolicy: Never
```

## Summary

The Linux kernel tracing toolkit — ftrace, perf, and bpftrace — provides a complete investigative framework for production performance issues that application-level tools cannot reach. ftrace excels at function-level call graph analysis and measuring scheduler latency; use it for narrow, targeted investigations. perf provides CPU-level profiling and hardware counter analysis; use `perf record + flame graph` as your first step when CPU time is unexplained. bpftrace is the most powerful and flexible tool for dynamic analysis: write custom aggregations, latency histograms, and correlation scripts that run with minimal overhead in production. Combined with the systematic latency investigation methodology — correlate timing, capture scheduler data, check memory pressure, measure lock contention — these tools turn opaque kernel behavior into a debuggable, quantified problem.
