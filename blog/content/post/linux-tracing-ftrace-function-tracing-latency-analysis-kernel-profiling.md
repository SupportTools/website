---
title: "Linux Tracing with ftrace: Function Tracing, Latency Analysis, and Kernel Profiling"
date: 2029-03-29T00:00:00-05:00
draft: false
tags: ["Linux", "ftrace", "Performance", "Kernel", "Tracing", "Observability"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to Linux ftrace for kernel function tracing, scheduling latency measurement, interrupt handling analysis, and production performance profiling—covering the tracefs interface, trace-cmd, and perf-ftrace integration for on-host diagnosis without instrumentation overhead."
more_link: "yes"
url: "/linux-tracing-ftrace-function-tracing-latency-analysis-kernel-profiling/"
---

When `perf`, `strace`, and application profilers cannot explain a performance problem, the kernel's built-in tracing subsystem—ftrace—provides the next level of visibility. ftrace is available on every Linux kernel since 2.6.27, requires no kernel modules, no eBPF programs, and no recompilation. It exposes a file-based interface under `/sys/kernel/tracing` (or `/sys/kernel/debug/tracing` on older kernels) that can trace every kernel function call, measure scheduler latency, record interrupt handling times, and profile specific code paths in microseconds.

This guide covers the direct tracefs interface, `trace-cmd` for production use, and practical workflows for diagnosing latency spikes, scheduler issues, and I/O performance problems.

<!--more-->

## tracefs Interface Overview

Mount tracefs if not already mounted:

```bash
mount -t tracefs tracefs /sys/kernel/tracing
# On most modern distributions this is already mounted.

# Verify
ls /sys/kernel/tracing/
# available_events    current_tracer    options/    set_event  trace
# available_filter_functions  events/  per_cpu/   set_ftrace_filter  trace_pipe
# available_tracers   free_buffer       saved_cmdlines  snapshot   tracing_on
```

Key files:

| File | Purpose |
|------|---------|
| `tracing_on` | Enable (1) or disable (0) tracing |
| `current_tracer` | Select tracer: `nop`, `function`, `function_graph`, `irqsoff`, `preemptoff`, `wakeup`, `wakeup_rt` |
| `trace` | Read the trace buffer (snapshot) |
| `trace_pipe` | Stream trace output in real time |
| `set_ftrace_filter` | Limit function tracing to specific functions |
| `set_ftrace_pid` | Limit tracing to a specific PID |
| `available_tracers` | List supported tracers on this kernel |

---

## Basic Function Tracing

The `function` tracer records every kernel function call. With no filter, this generates millions of events per second and will fill buffers almost instantly. Always set a filter first.

```bash
# Step 1: Set the tracer
echo function > /sys/kernel/tracing/current_tracer

# Step 2: Filter to specific functions (avoid tracing everything)
echo 'ext4_*' > /sys/kernel/tracing/set_ftrace_filter
# Verify the filter was accepted
cat /sys/kernel/tracing/set_ftrace_filter | head -10

# Step 3: Enable tracing
echo 1 > /sys/kernel/tracing/tracing_on

# Step 4: Run the workload (e.g., write a file to trigger ext4 functions)
dd if=/dev/zero of=/tmp/testfile bs=4096 count=1024 oflag=sync

# Step 5: Disable tracing
echo 0 > /sys/kernel/tracing/tracing_on

# Step 6: Read the trace
cat /sys/kernel/tracing/trace | head -50
```

Example output:

```
# tracer: function
#
# entries-in-buffer/entries-written: 42812/42812  #P:8
#
#                                _-----=> irqs-off
#                               / _----=> need-resched
#                              | / _---=> hardirq/softirq
#                              || / _--=> preempt-depth
#                              ||| /     delay
#           TASK-PID     CPU#  ||||   TIMESTAMP  FUNCTION
#              | |         |   ||||      |         |
              dd-18432   [002] .... 1234567.890123: ext4_file_write_iter <-new_sync_write
              dd-18432   [002] .... 1234567.890125: ext4_buffered_write_iter <-ext4_file_write_iter
              dd-18432   [002] .... 1234567.890126: ext4_journal_check_start <-ext4_buffered_write_iter
```

### Filtering by PID

```bash
# Trace only a specific process
echo $$ > /sys/kernel/tracing/set_ftrace_pid
echo function > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
# Run workload...
echo 0 > /sys/kernel/tracing/tracing_on
```

### Function Graph Tracer

The `function_graph` tracer adds call depth visualization and measures execution time in each function:

```bash
echo function_graph > /sys/kernel/tracing/current_tracer
echo 'schedule tcp_*' > /sys/kernel/tracing/set_graph_function
echo 1 > /sys/kernel/tracing/tracing_on
sleep 0.1
echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace | head -60
```

Output with call depth and timing:

```
# tracer: function_graph
#
# TIME        CPU  TASK/PID         DURATION                  FUNCTION CALLS
# |           |    |    |           |   |                     |   |   |   |
 1234567.89 [003]  nginx-9812     |  0.842 us    |          tcp_sendmsg_locked();
 1234567.89 [003]  nginx-9812     |              |          tcp_push() {
 1234567.89 [003]  nginx-9812     |  0.391 us    |            __tcp_push_pending_frames();
 1234567.89 [003]  nginx-9812     |  1.053 us    |          }
```

---

## Measuring Scheduling Latency

The `wakeup` tracer measures the time between when a task is woken and when it actually runs on a CPU. This is the scheduling latency—critical for latency-sensitive workloads.

```bash
# The wakeup tracer measures max latency automatically
echo wakeup > /sys/kernel/tracing/current_tracer
echo 0 > /sys/kernel/tracing/tracing_max_latency  # Reset max latency
echo 1 > /sys/kernel/tracing/tracing_on

# Run the workload for 30 seconds
sleep 30

echo 0 > /sys/kernel/tracing/tracing_on

# Read the maximum scheduling latency observed
cat /sys/kernel/tracing/tracing_max_latency
# 847   (microseconds — the worst-case wake-up-to-run latency)

# Read the trace for the worst-case event
cat /sys/kernel/tracing/trace | head -100
```

The trace shows exactly what was running when the latency occurred, the preemption state, and the sequence of scheduler decisions.

### wakeup_rt: Real-Time Task Latency

```bash
# wakeup_rt measures latency only for SCHED_FIFO and SCHED_RR tasks
echo wakeup_rt > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
```

---

## irqsoff Tracer: Interrupt Disabled Latency

When interrupts are disabled, the system cannot respond to hardware events. Long interrupt-disabled sections cause latency spikes for all I/O operations. The `irqsoff` tracer measures the maximum duration interrupts were disabled:

```bash
echo irqsoff > /sys/kernel/tracing/current_tracer
echo 0 > /sys/kernel/tracing/tracing_max_latency
echo 1 > /sys/kernel/tracing/tracing_on

# Generate I/O load
fio --name=randread --ioengine=libaio --direct=1 --rw=randread \
    --bs=4k --numjobs=4 --size=1G --runtime=30 --time_based \
    --filename=/dev/nvme0n1 --output=/tmp/fio-output.txt &

sleep 30
echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/tracing_max_latency
# 312   (microseconds with interrupts disabled)

cat /sys/kernel/tracing/trace | head -80
```

---

## trace-cmd: Production ftrace Wrapper

Working with tracefs files directly is tedious for production use. `trace-cmd` provides a CLI that manages the tracefs interface and saves traces to binary files for offline analysis.

```bash
# Install trace-cmd
apt-get install trace-cmd   # Debian/Ubuntu
dnf install trace-cmd       # Fedora/RHEL

# Record function_graph trace for 5 seconds, filtering on tcp functions
trace-cmd record \
  -p function_graph \
  -g 'tcp_*' \
  -P $(pgrep nginx | head -1) \
  sleep 5

# This creates trace.dat in the current directory

# Report the trace
trace-cmd report | head -100

# Report with function statistics (call count and time)
trace-cmd report --stat | sort -k3 -rn | head -20
```

### Recording Specific Events

```bash
# Record scheduler and system call events for a specific process
trace-cmd record \
  -e sched:sched_switch \
  -e sched:sched_wakeup \
  -e syscalls:sys_enter_read \
  -e syscalls:sys_exit_read \
  -P $(pgrep -n api-server) \
  -- sleep 10

# Analyze the trace
trace-cmd report | grep -E "(sched_switch|sys_enter_read)" | head -30
```

---

## Dynamic Tracing with kprobe Events

ftrace supports dynamic tracepoints via kprobes, allowing instrumentation of any kernel function without kernel modification:

```bash
# Add a kprobe on do_sys_open to capture filenames being opened
echo 'p:myprobe do_sys_open filename=+0(%si):string flags=%dx:x32' \
  > /sys/kernel/tracing/kprobe_events

# Enable the probe
echo 1 > /sys/kernel/tracing/events/kprobes/myprobe/enable
echo 1 > /sys/kernel/tracing/tracing_on

# Watch which files a process opens
cat /sys/kernel/tracing/trace_pipe | grep -v "^#"

# Sample output:
# nginx-9812 [002] 1234567.89: myprobe: (do_sys_open+0x0) filename="/etc/ssl/certs/ca-bundle.crt" flags=0x80000
# nginx-9812 [002] 1234567.89: myprobe: (do_sys_open+0x0) filename="/var/log/nginx/access.log" flags=0x441

# Clean up
echo 0 > /sys/kernel/tracing/events/kprobes/myprobe/enable
echo '-:myprobe' >> /sys/kernel/tracing/kprobe_events
```

---

## Practical Example: Diagnosing Storage Latency Spikes

A common production problem: occasional I/O latency spikes with no obvious cause in application metrics. The following workflow isolates whether the spikes are in the kernel block layer or in the filesystem:

```bash
#!/usr/bin/env bash
# diagnose-io-latency.sh
set -euo pipefail

TRACE_DIR=/sys/kernel/tracing
DURATION=60
OUTPUT=/tmp/io-latency-trace-$(date +%Y%m%d_%H%M%S)

echo "Setting up block I/O event tracing..."
echo nop > "$TRACE_DIR/current_tracer"

# Enable block layer events
echo 1 > "$TRACE_DIR/events/block/block_rq_issue/enable"
echo 1 > "$TRACE_DIR/events/block/block_rq_complete/enable"

# Enable ext4 events
echo 1 > "$TRACE_DIR/events/ext4/ext4_sync_file_enter/enable"
echo 1 > "$TRACE_DIR/events/ext4/ext4_sync_file_exit/enable"

# Increase buffer size (default 1408 KB is often too small)
echo 65536 > "$TRACE_DIR/buffer_size_kb"

echo "Recording for ${DURATION} seconds..."
echo 1 > "$TRACE_DIR/tracing_on"
sleep "$DURATION"
echo 0 > "$TRACE_DIR/tracing_on"

echo "Saving trace to $OUTPUT.txt..."
cat "$TRACE_DIR/trace" > "$OUTPUT.txt"

# Analyze: find block requests that took > 100ms
echo "=== Block requests taking > 100ms ==="
awk '
  /block_rq_issue/ {
    match($0, /sector=([0-9]+)/, arr)
    sector = arr[1]
    match($0, /[0-9]+\.[0-9]+:/, ts)
    issue_time[sector] = substr(ts[0], 1, length(ts[0])-1) + 0
  }
  /block_rq_complete/ {
    match($0, /sector=([0-9]+)/, arr)
    sector = arr[1]
    match($0, /[0-9]+\.[0-9]+:/, ts)
    complete_time = substr(ts[0], 1, length(ts[0])-1) + 0
    if (sector in issue_time) {
      latency_ms = (complete_time - issue_time[sector]) * 1000
      if (latency_ms > 100) {
        printf "Sector %s: %.1f ms\n", sector, latency_ms
      }
    }
  }
' "$OUTPUT.txt" | sort -k3 -rn | head -20

echo "Trace saved to $OUTPUT.txt"
```

---

## trace-cmd with KernelShark Visualization

For complex traces, KernelShark provides GUI visualization:

```bash
# Record with trace-cmd
trace-cmd record -p function_graph \
  -e sched:sched_switch \
  -e block:block_rq_issue \
  -e block:block_rq_complete \
  sleep 30

# Launch KernelShark for visual analysis
kernelshark trace.dat &
```

KernelShark renders per-CPU timeline views showing which functions ran on which CPU at each microsecond, making it straightforward to identify which process was preempted during a latency spike.

---

## Extracting Histograms with tracefs hist Triggers

Kernel 4.7+ supports trigger-based histograms directly in tracefs, without streaming all events through user space:

```bash
# Create a histogram of block I/O latency using synthetic events
# Requires kernel 4.9+ for latency histograms

# Create a histogram of read syscall latency
echo 'hist:keys=pid,comm:vals=hitcount,lat=common_timestamp.usecs:sort=lat:size=2048' \
  > /sys/kernel/tracing/events/syscalls/sys_exit_read/trigger

# Let it run for 30 seconds, then read
sleep 30
cat /sys/kernel/tracing/events/syscalls/sys_exit_read/hist

# Sample output:
# { pid:  9812, comm: nginx          } hitcount:    1842     lat:       12
# { pid:  9812, comm: nginx          } hitcount:     203     lat:       45
# { pid:  9812, comm: nginx          } hitcount:      18     lat:      312
# ...
# Totals:
#   Hits: 2063
#   Entries: 32
#   Dropped: 0

# Clear the trigger
echo '!hist:...' > /sys/kernel/tracing/events/syscalls/sys_exit_read/trigger
```

---

## Safety and Performance Impact

```bash
# Always check buffer state before long traces
cat /sys/kernel/tracing/tracing_stats | grep "entries"
# If "entries written" >> "entries in buffer", the ring buffer overflowed.
# Increase buffer size or narrow the filter.

# Disable all tracing cleanly
echo 0 > /sys/kernel/tracing/tracing_on
echo nop > /sys/kernel/tracing/current_tracer
echo > /sys/kernel/tracing/set_ftrace_filter
echo > /sys/kernel/tracing/set_graph_function
# Disable all events
echo 0 > /sys/kernel/tracing/events/enable
```

The performance impact of ftrace:

- `nop` tracer (events only): ~50-200 ns per event, negligible aggregate overhead for sparse events
- `function` tracer (unfiltered): 5-30% CPU overhead — always filter to specific functions
- `function_graph` tracer (filtered): 2-10% CPU overhead on filtered functions
- `irqsoff`/`wakeup` tracers: 1-3% overhead, safe for production diagnosis

---

## Summary

ftrace provides kernel-level observability with no external dependencies:

| Tracer | Use Case | Key Metric |
|--------|----------|------------|
| `function` | Understand which kernel functions execute during an operation | Call count per function |
| `function_graph` | Measure time spent in specific kernel code paths | Per-function duration |
| `wakeup` | Diagnose scheduling latency for latency-sensitive processes | Max wake-to-run latency (μs) |
| `irqsoff` | Find code paths that hold interrupts disabled too long | Max irq-off duration (μs) |
| `preemptoff` | Find code paths that disable preemption | Max preempt-off duration (μs) |
| kprobe events | Instrument arbitrary kernel functions with parameters | Custom per-call parameters |
| hist triggers | On-kernel latency histograms without user-space streaming | Latency distribution |

For production diagnosis, `trace-cmd record` is more ergonomic than the raw tracefs interface and produces portable trace files for offline analysis. Combine ftrace with eBPF-based tools (BCC, bpftrace) for cases where ftrace's ring-buffer model causes too much data loss at high event rates.
