---
title: "Linux ftrace: Kernel Function Tracing for Performance and Debugging"
date: 2030-05-29T00:00:00-05:00
draft: false
tags: ["Linux", "ftrace", "Performance", "Debugging", "Kernel", "Tracing", "Systems"]
categories:
- Linux
- Performance
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux ftrace: function tracer, function graph tracer, events subsystem, trace-cmd, perf integration, and using ftrace to debug kernel performance bottlenecks."
more_link: "yes"
url: "/linux-ftrace-kernel-function-tracing-performance-debugging/"
---

Linux ftrace (function tracer) is the kernel's built-in tracing infrastructure, available on every production Linux system since kernel 2.6.27. Unlike external profiling tools that require kernel modules or eBPF programs, ftrace operates through the tracefs filesystem mounted at `/sys/kernel/tracing`, making it available in minimal container environments and restricted production systems where other tooling cannot be installed.

This guide covers ftrace from the basics of the tracefs interface through advanced production debugging patterns: tracing specific kernel functions for latency analysis, using the function graph tracer to understand call chains, and correlating ftrace data with perf and bpftrace findings.

<!--more-->

## ftrace Architecture

### The Tracefs Interface

ftrace exposes all configuration and output through a virtual filesystem:

```bash
# Mount tracefs if not already mounted
mount -t tracefs tracefs /sys/kernel/tracing

# Verify mount
mount | grep tracefs
# tracefs on /sys/kernel/tracing type tracefs (rw,relatime)

# Core files in tracefs
ls /sys/kernel/tracing/
# available_events        -- All traceable events
# available_filter_funcs  -- All traceable kernel functions
# available_tracers       -- Tracer plugins available
# buffer_size_kb          -- Per-CPU trace buffer size
# current_tracer          -- Active tracer name
# events/                 -- Event subsystem directory
# instances/              -- Multiple independent trace instances
# options/                -- Tracer options
# set_ftrace_filter       -- Function filter (which functions to trace)
# set_ftrace_notrace      -- Negative function filter
# set_graph_function      -- Function graph entry point
# trace                   -- The trace output (reads current buffer)
# trace_pipe              -- Streaming trace output (blocks until data)
# tracing_on              -- Enable/disable tracing (1/0)
```

### Available Tracers

```bash
cat /sys/kernel/tracing/available_tracers
# blk function function_graph hwlat irqsoff mmiotrace nop preemptoff preemptirqsoff wakeup wakeup_dl wakeup_rt

# Tracer descriptions:
# nop             -- No tracing (off)
# function        -- Record each function call
# function_graph  -- Record function call graphs with timing
# irqsoff         -- Measure latency when IRQs are disabled
# preemptoff      -- Measure latency when preemption is disabled
# wakeup          -- Measure task wakeup latency
# blk             -- Block device I/O tracing
```

## Function Tracer

### Basic Function Tracing

```bash
# Save current tracer to restore later
SAVED_TRACER=$(cat /sys/kernel/tracing/current_tracer)
echo "nop" > /sys/kernel/tracing/current_tracer

# Set tracer to function
echo "function" > /sys/kernel/tracing/current_tracer

# Increase buffer size for busy systems (per CPU, in KB)
echo 65536 > /sys/kernel/tracing/buffer_size_kb

# Clear the buffer
echo > /sys/kernel/tracing/trace

# Start tracing
echo 1 > /sys/kernel/tracing/tracing_on

# Run your workload here...
sleep 5

# Stop tracing
echo 0 > /sys/kernel/tracing/tracing_on

# Read the trace
head -50 /sys/kernel/tracing/trace
# # tracer: function
# #
# # entries-in-buffer/entries-written: 1234567/4567890   #P:8
# #
# #                                _-----=> irqs-off/BH-disabled
# #                               / _----=> need-resched
# #                              | / _---=> hardirq/softirq
# #                              || / _--=> preempt-depth
# #                              ||| / _-=> migrate-disable
# #                              |||| /     delay
# #           TASK-PID     CPU#  |||||  TIMESTAMP  FUNCTION
# #              | |         |   |||||     |         |
#       nginx-1234  [002] ..... 123456.789012: do_sys_open <-do_sys_openat2
#       nginx-1234  [002] ..... 123456.789034: vfs_read <-ksys_read

# Restore original tracer
echo "$SAVED_TRACER" > /sys/kernel/tracing/current_tracer
```

### Function Filtering

Tracing all kernel functions generates enormous output. Filter to specific functions or subsystems:

```bash
# Trace only tcp functions
echo "tcp_*" > /sys/kernel/tracing/set_ftrace_filter
cat /sys/kernel/tracing/set_ftrace_filter | head -10
# tcp_abort
# tcp_accept
# tcp_add_backlog
# tcp_check_space
# tcp_cleanup_rbuf

# Multiple patterns
echo "tcp_* udp_* ip_*" > /sys/kernel/tracing/set_ftrace_filter

# Append to existing filter (use >> not >)
echo "sock_*" >> /sys/kernel/tracing/set_ftrace_filter

# Trace everything EXCEPT debug/trace functions (notrace filter)
echo "ftrace_*" > /sys/kernel/tracing/set_ftrace_notrace

# Reset to trace all functions
echo > /sys/kernel/tracing/set_ftrace_filter

# Filter by module
echo ":mod:ext4" > /sys/kernel/tracing/set_ftrace_filter

# Check how many functions match a pattern
grep -c "^tcp" /sys/kernel/tracing/available_filter_funcs
# 247
```

### Pid Filtering

```bash
# Only trace a specific process
echo 12345 > /sys/kernel/tracing/set_ftrace_pid

# Only trace processes in a cgroup
CGROUP_PROCS=/sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/cgroup.procs
cat "$CGROUP_PROCS" > /sys/kernel/tracing/set_ftrace_pid

# Trace current shell session
echo $$ > /sys/kernel/tracing/set_ftrace_pid

# Clear pid filter (trace all)
echo > /sys/kernel/tracing/set_ftrace_pid
```

## Function Graph Tracer

The function graph tracer records both function entry and exit, generating a call graph with timing information:

```bash
# Enable function graph tracer
echo "function_graph" > /sys/kernel/tracing/current_tracer

# Set a specific entry function to trace call tree from
echo "ext4_file_write_iter" > /sys/kernel/tracing/set_graph_function

# Configure depth limit to avoid overwhelming output
echo 5 > /sys/kernel/tracing/max_graph_depth

# Enable timing display
echo "funcgraph-proc" > /sys/kernel/tracing/trace_options

# Start tracing
echo 1 > /sys/kernel/tracing/tracing_on
# perform workload
echo 0 > /sys/kernel/tracing/tracing_on

# Read graph output
cat /sys/kernel/tracing/trace
# tracer: function_graph
#
# CPU  DURATION                  FUNCTION CALLS
# |    |   |                     |   |   |   |
#  2)               |  ext4_file_write_iter() {
#  2)               |    ext4_buffered_write_iter() {
#  2)               |      generic_perform_write() {
#  2)   0.423 us    |        ext4_write_begin();
#  2)               |        iov_iter_copy_from_user_atomic() {
#  2)   1.234 us    |          kmap_atomic();
#  2)   0.891 us    |          kunmap_atomic();
#  2)   4.123 us    |        }  /* iov_iter_copy_from_user_atomic */
#  2)               |        ext4_write_end() {
#  2)  28.341 us    |          ext4_mark_inode_dirty();
#  2)  31.234 us    |        }  /* ext4_write_end */
#  2)  42.891 us    |      }  /* generic_perform_write */
#  2)  45.123 us    |    }  /* ext4_buffered_write_iter */
#  2)  47.234 us    |  }  /* ext4_file_write_iter */
```

### Identifying Slow Kernel Functions

```bash
# Use function graph to find slow operations
# Look for functions taking >1ms (1000 us)
echo "function_graph" > /sys/kernel/tracing/current_tracer
echo 10 > /sys/kernel/tracing/max_graph_depth
echo 1 > /sys/kernel/tracing/tracing_on
sleep 10
echo 0 > /sys/kernel/tracing/tracing_on

# Filter trace output for slow operations
awk '$4 ~ /us/ && $3+0 > 1000 {print}' /sys/kernel/tracing/trace
# Shows all functions that took more than 1000 microseconds
```

## Event Tracing Subsystem

The events subsystem provides structured tracing points (tracepoints) built directly into the kernel. Unlike function tracing, tracepoints are stable ABI with documented fields.

### Discovering Available Events

```bash
# List event categories
ls /sys/kernel/tracing/events/
# block  compaction  exceptions  ext4  fib  filemap  fs_dax
# huge_memory  i2c  initcall  io_uring  irq  kmem  kvm  lock
# migrate  mm_vmscan  module  napi  net  netlink  oom  pagemap
# power  printk  raw_syscalls  rcu  regmap  rpm  sched  scsi
# signal  skb  sock  syscalls  task  tcp  timer  tlb  udp  vmscan

# List events within a category
ls /sys/kernel/tracing/events/sched/
# enable  filter  sched_kthread_stop  sched_migrate_task
# sched_process_exec  sched_process_exit  sched_process_fork
# sched_process_free  sched_process_wait  sched_stat_blocked
# sched_stat_iowait  sched_stat_runtime  sched_stat_sleep
# sched_stat_wait  sched_switch  sched_wakeup  sched_wakeup_new

# Show event format (fields)
cat /sys/kernel/tracing/events/sched/sched_switch/format
# name: sched_switch
# ID: 315
# format:
#     field:unsigned short common_type;      offset:0;  size:2; signed:0;
#     field:unsigned char common_flags;      offset:2;  size:1; signed:0;
#     field:unsigned char common_preempt_count; offset:3; size:1; signed:0;
#     field:int common_pid;                  offset:4;  size:4; signed:1;
#     field:char prev_comm[16];             offset:8;  size:16; signed:1;
#     field:pid_t prev_pid;                  offset:24; size:4; signed:1;
#     field:int prev_prio;                   offset:28; size:4; signed:1;
#     field:long prev_state;                 offset:32; size:8; signed:1;
#     field:char next_comm[16];             offset:40; size:16; signed:1;
#     field:pid_t next_pid;                  offset:56; size:4; signed:1;
#     field:int next_prio;                   offset:60; size:4; signed:1;
```

### Enabling Specific Events

```bash
# Enable scheduler context switch events
echo 1 > /sys/kernel/tracing/events/sched/sched_switch/enable

# Enable all network events
echo 1 > /sys/kernel/tracing/events/net/enable

# Enable specific TCP events
echo 1 > /sys/kernel/tracing/events/tcp/tcp_retransmit_skb/enable
echo 1 > /sys/kernel/tracing/events/tcp/tcp_send_reset/enable

# Disable an event
echo 0 > /sys/kernel/tracing/events/tcp/tcp_retransmit_skb/enable

# Enable events with filters
# Only capture sched_switch events where next_comm contains "nginx"
echo 'next_comm ~ "nginx*"' > /sys/kernel/tracing/events/sched/sched_switch/filter
echo 1 > /sys/kernel/tracing/events/sched/sched_switch/enable
```

### Event Filters

```bash
# Block I/O events filtered by device and size
# Filter for writes > 512KB to device 8:0 (sda)
cat /sys/kernel/tracing/events/block/block_rq_issue/format | grep field | head -10

echo 'rwbs == "W" && nr_sector > 1024' > \
    /sys/kernel/tracing/events/block/block_rq_issue/filter
echo 1 > /sys/kernel/tracing/events/block/block_rq_issue/enable

# Filter by process name
echo 'comm == "mysqld"' > /sys/kernel/tracing/events/syscalls/sys_enter_read/filter
echo 1 > /sys/kernel/tracing/events/syscalls/sys_enter_read/enable
```

## trace-cmd: High-Level ftrace Interface

`trace-cmd` wraps the raw tracefs interface with a more usable CLI and binary recording format:

```bash
# Install trace-cmd
apt-get install -y trace-cmd   # Debian/Ubuntu
dnf install -y trace-cmd       # RHEL/Fedora

# Record function graph for a specific command
trace-cmd record \
    -p function_graph \
    -g ext4_file_write_iter \
    --max-graph-depth 5 \
    dd if=/dev/zero of=/tmp/test bs=4096 count=1000

# Record specific events
trace-cmd record \
    -e sched:sched_switch \
    -e sched:sched_wakeup \
    -e tcp:tcp_retransmit_skb \
    -e block:block_rq_issue \
    -P 12345 \
    sleep 30

# Read the trace data
trace-cmd report | head -100

# Report with latency information
trace-cmd report --cpu 2 | grep -E "us\)" | sort -n -k3 | tail -20

# Show histogram of function call counts
trace-cmd report --stat

# Stream output in real time (like trace_pipe)
trace-cmd stream -e tcp:tcp_retransmit_skb

# Record to specific file
trace-cmd record -o /tmp/trace-$(date +%Y%m%d-%H%M%S).dat \
    -e net:netif_rx \
    sleep 60

# Extract to readable format offline
trace-cmd report -i /tmp/trace-20300529-143022.dat > trace-report.txt
```

### trace-cmd for Container Performance Analysis

```bash
#!/bin/bash
# trace-container-io.sh
# Capture I/O trace for a specific container

CONTAINER_ID="${1:?Usage: $0 <container-id> [duration-seconds]}"
DURATION="${2:-30}"

# Get PIDs in the container
PIDS=$(cat /sys/fs/cgroup/kubepods.slice/*/pod*.slice/*${CONTAINER_ID}*/cgroup.procs 2>/dev/null | tr '\n' ',' | sed 's/,$//')

if [ -z "$PIDS" ]; then
    echo "Container $CONTAINER_ID not found"
    exit 1
fi

echo "Tracing PIDs: $PIDS for ${DURATION}s"

trace-cmd record \
    -o "/tmp/trace-${CONTAINER_ID}-$(date +%s).dat" \
    -e block:block_rq_issue \
    -e block:block_rq_complete \
    -e ext4:ext4_file_write_iter \
    -e syscalls:sys_enter_read \
    -e syscalls:sys_enter_write \
    $(echo $PIDS | tr ',' '\n' | awk '{printf "-P %s ", $1}') \
    sleep "$DURATION"

echo "Trace complete. Generating report..."
trace-cmd report -i "/tmp/trace-${CONTAINER_ID}-"*.dat \
    | awk '/block_rq_complete/ {print}' \
    | head -50
```

## Latency Tracers

### irqsoff Tracer

Measures how long interrupts are disabled, which contributes to scheduling latency:

```bash
# Enable irqsoff tracer
echo "irqsoff" > /sys/kernel/tracing/current_tracer

# Record maximum latency automatically
echo 1 > /sys/kernel/tracing/tracing_on
sleep 30
echo 0 > /sys/kernel/tracing/tracing_on

# Read the trace — shows function call that caused the maximum IRQ-off period
cat /sys/kernel/tracing/trace
# tracer: irqsoff
# #
# irqsoff latency trace v1.1.5 on 5.15.0-91-generic
# --------------------------------------------------------------------
# latency: 42 us, #40/40, CPU#3 | (M:preempt VP:0, KP:0, SP:0 HP:0 #P:8)
#    -----------------
#    | task: swapper/3-0 (uid:0 nice:0 policy:0 rt_prio:0)
#    -----------------
#  => started at: apic_timer_interrupt
#  => ended at:   apic_timer_interrupt

# The maximum latency and call stack shows where IRQs were disabled longest
```

### wakeup Tracer

Measures the time from task wakeup to scheduling:

```bash
echo "wakeup" > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
sleep 10
echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/trace
# tracer: wakeup
# #
# wakeup latency trace v1.1.5 on 5.15.0-91-generic
# latency: 78 us, #72/72, CPU#5
# -- shows the task that experienced the worst wakeup latency
```

## Multiple Trace Instances

ftrace supports isolated trace instances to avoid interference between multiple tracing sessions:

```bash
# Create a dedicated instance for network tracing
mkdir /sys/kernel/tracing/instances/network-trace

# Configure the instance independently
echo "nop" > /sys/kernel/tracing/instances/network-trace/current_tracer
echo 1 > /sys/kernel/tracing/instances/network-trace/events/tcp/tcp_retransmit_skb/enable
echo 1 > /sys/kernel/tracing/instances/network-trace/events/tcp/tcp_send_reset/enable
echo 1 > /sys/kernel/tracing/instances/network-trace/tracing_on

# Create another instance for filesystem tracing
mkdir /sys/kernel/tracing/instances/filesystem-trace
echo 1 > /sys/kernel/tracing/instances/filesystem-trace/events/ext4/enable
echo 1 > /sys/kernel/tracing/instances/filesystem-trace/tracing_on

# Each instance has independent buffers
cat /sys/kernel/tracing/instances/network-trace/trace
cat /sys/kernel/tracing/instances/filesystem-trace/trace

# Clean up instances
echo 0 > /sys/kernel/tracing/instances/network-trace/tracing_on
rmdir /sys/kernel/tracing/instances/network-trace

echo 0 > /sys/kernel/tracing/instances/filesystem-trace/tracing_on
rmdir /sys/kernel/tracing/instances/filesystem-trace
```

## Integration with perf

perf can record ftrace events alongside hardware performance counters:

```bash
# Record ftrace events with perf for combined analysis
perf record \
    -e sched:sched_switch \
    -e sched:sched_wakeup \
    -e block:block_rq_issue \
    -e block:block_rq_complete \
    -a \
    sleep 30

perf report --stdio | head -30

# Use perf-trace for system call tracing (like strace but faster)
perf trace -p 12345 --duration 30 2>&1 | head -50

# Cross-correlate ftrace and perf hardware counters
# Record CPU cycles alongside scheduler events
perf record \
    -e cycles:pp \
    -e sched:sched_switch \
    -g \
    -p 12345 \
    sleep 10

perf script | head -50
```

## Production Debugging Example: I/O Latency Spikes

A complete workflow for diagnosing unexplained I/O latency spikes in a production Kubernetes node:

```bash
#!/bin/bash
# diagnose-io-latency.sh
# Capture ftrace data during an I/O latency spike

echo "Setting up ftrace for I/O latency analysis..."

# Use a dedicated instance
mkdir -p /sys/kernel/tracing/instances/io-latency

INST="/sys/kernel/tracing/instances/io-latency"

# Set up tracers and events
echo "function_graph" > "$INST/current_tracer"
echo "blkdev_queue_stat" > "$INST/set_graph_function" 2>/dev/null || true
echo 4 > "$INST/max_graph_depth"
echo 32768 > "$INST/buffer_size_kb"

# Enable block layer events
echo 1 > "$INST/events/block/block_rq_issue/enable"
echo 1 > "$INST/events/block/block_rq_complete/enable"
echo 1 > "$INST/events/block/block_rq_requeue/enable"

# Enable I/O wait tracking
echo 1 > "$INST/events/sched/sched_stat_iowait/enable"

echo "Tracing for 60 seconds..."
echo 1 > "$INST/tracing_on"
sleep 60
echo 0 > "$INST/tracing_on"

echo "Extracting high-latency block operations..."
# Parse block I/O completions and report those > 100ms
awk '
/block_rq_issue/ {
    # Extract sector number as request key
    match($0, /sector=([0-9]+)/, arr)
    if (arr[1]) {
        start[arr[1]] = $4  # timestamp
    }
}
/block_rq_complete/ {
    match($0, /sector=([0-9]+)/, arr)
    if (arr[1] && start[arr[1]]) {
        latency = $4 - start[arr[1]]
        if (latency > 0.100) {  # > 100ms
            printf "SLOW IO: sector=%s latency=%.3fs\n", arr[1], latency
        }
        delete start[arr[1]]
    }
}
' "$INST/trace"

# Cleanup
rmdir "$INST" 2>/dev/null || true
echo "Done."
```

## ftrace Safety Considerations

### Production Impact

```bash
# Function tracer with no filter can generate 500MB/s of data
# Always filter to specific functions or use events instead

# Check current buffer fill rate
watch -n 1 'cat /sys/kernel/tracing/trace_stat/events_lost 2>/dev/null
    && echo "entries in buffer:" && \
    grep "entries-in-buffer" /sys/kernel/tracing/trace | head -1'

# Monitor tracer CPU overhead
pidstat -p $(pgrep trace-cmd) 1

# Set a maximum trace duration with a watchdog
timeout 30 bash -c '
    echo 1 > /sys/kernel/tracing/tracing_on
    sleep 30
' ; echo 0 > /sys/kernel/tracing/tracing_on
```

### Scripted Capture and Reset

```bash
#!/bin/bash
# safe-ftrace.sh
# Wrapper that always resets ftrace state, even on errors

TRACEFS="/sys/kernel/tracing"

cleanup() {
    echo 0 > "$TRACEFS/tracing_on"
    echo > "$TRACEFS/set_ftrace_filter"
    echo > "$TRACEFS/set_ftrace_pid"
    echo "nop" > "$TRACEFS/current_tracer"
    echo 0 > "$TRACEFS/events/enable" 2>/dev/null || true
    echo "ftrace reset complete"
}

trap cleanup EXIT INT TERM

# Your tracing setup here
echo "function_graph" > "$TRACEFS/current_tracer"
echo "do_sys_openat2" > "$TRACEFS/set_graph_function"
echo 3 > "$TRACEFS/max_graph_depth"
echo 1 > "$TRACEFS/tracing_on"

# Run for 10 seconds
sleep 10

echo 0 > "$TRACEFS/tracing_on"
cat "$TRACEFS/trace" > /tmp/ftrace-output-$(date +%s).txt
echo "Trace saved to /tmp/ftrace-output-*.txt"
# cleanup() called by trap
```

## Summary

Linux ftrace provides unparalleled visibility into kernel behavior without requiring additional software installation. The function tracer identifies hot code paths, the function graph tracer maps call hierarchies with per-function timing, and the events subsystem exposes stable, field-rich tracepoints for scheduler, network, filesystem, and memory management subsystems.

The trace-cmd wrapper makes ftrace accessible in production workflows by providing a command-line interface that handles buffer management, binary recording, and multi-CPU data merging. Combined with perf for hardware counter correlation and bpftrace for dynamic probe insertion, ftrace forms the foundation of a complete kernel observability toolkit that requires zero prerequisites beyond a modern Linux kernel.
