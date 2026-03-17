---
title: "Linux Kernel Tracing: ftrace, kprobes, uprobes, and SystemTap"
date: 2029-12-13T00:00:00-05:00
draft: false
tags: ["Linux", "ftrace", "kprobes", "uprobes", "SystemTap", "Performance", "Tracing", "Debugging"]
categories:
- Linux
- Performance
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to ftrace function tracing, dynamic kprobes, uprobes for userspace tracing, trace-cmd, and production performance investigation techniques for Linux kernel and application debugging."
more_link: "yes"
url: "/linux-kernel-tracing-ftrace-kprobes-uprobes-systemtap/"
---

When a production system behaves unexpectedly — high latency without obvious CPU or memory pressure, inexplicable syscall patterns, or intermittent kernel panics — standard profiling tools like `perf top` and `strace` often can't answer the question "what is the kernel doing at this exact moment?". Linux kernel tracing tools provide surgical visibility into kernel internals: ftrace shows every function call in the kernel call graph, kprobes let you inspect kernel function arguments at runtime, uprobes bring the same capability to userspace, and SystemTap packages all of this into programmable scripts. This guide covers the full tracing stack for production investigation.

<!--more-->

## ftrace: The Kernel's Built-in Tracer

ftrace (function tracer) is compiled into every modern Linux kernel and is accessible through the `tracefs` virtual filesystem, typically mounted at `/sys/kernel/tracing`. No additional software is needed.

### ftrace Basics

```bash
# Mount tracefs if not already mounted
mount -t tracefs nodev /sys/kernel/tracing

# Check available tracers
cat /sys/kernel/tracing/available_tracers
# hwlat blk mmiotrace function_graph wakeup_dl wakeup_rt wakeup function nop

# Enable function tracer (traces all kernel function calls)
echo function > /sys/kernel/tracing/current_tracer

# Start tracing
echo 1 > /sys/kernel/tracing/tracing_on

# Trigger some activity...
# ls /tmp

# Read the trace
cat /sys/kernel/tracing/trace | head -40
# <idle>-0     [000] .N..  1234.567890: do_sys_openat2 <-__x64_sys_openat
# ...

# Stop and reset
echo 0 > /sys/kernel/tracing/tracing_on
echo nop > /sys/kernel/tracing/current_tracer
echo > /sys/kernel/tracing/trace
```

### Function Graph Tracer

The `function_graph` tracer shows call depth and duration, making it easier to identify where time is spent:

```bash
echo function_graph > /sys/kernel/tracing/current_tracer

# Filter to a specific function and its callees
echo do_sys_openat2 > /sys/kernel/tracing/set_graph_function

echo 1 > /sys/kernel/tracing/tracing_on
# trigger: open a file
echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/trace
# # tracer: function_graph
# #
# #   CPU    DURATION             FUNCTION CALLS
# #  |  |   |   |                 |   |   |   |
#  0)               |  do_sys_openat2() {
#  0)               |    getname_flags() {
#  0)   0.850 us    |      kmem_cache_alloc() ;
#  0)               |      strncpy_from_user() {
#  0)   0.430 us    |        _cond_resched() ;
#  0)   1.234 us    |      }
#  0)   2.890 us    |    }
#  0)   5.678 us    |  }
```

### Filtering by PID and Function

```bash
# Trace only a specific PID
echo $PID > /sys/kernel/tracing/set_ftrace_pid

# Filter to specific functions using set_ftrace_filter
echo 'tcp_*' > /sys/kernel/tracing/set_ftrace_filter
# Uses glob syntax

# Exclude functions (inverse filter)
echo 'tcp_v4_rcv' > /sys/kernel/tracing/set_ftrace_notrace

# Trace only scheduling events for a PID
echo "sched_*" > /sys/kernel/tracing/set_ftrace_filter
echo $PID > /sys/kernel/tracing/set_ftrace_pid
```

## trace-cmd: ftrace Frontend

`trace-cmd` is the userspace frontend for ftrace, providing cleaner interfaces and compressed recording:

```bash
# Install
apt-get install trace-cmd  # Debian/Ubuntu

# Record all TCP function calls for 5 seconds
trace-cmd record -p function_graph -g 'tcp_*' -F sleep 5

# Analyze recording
trace-cmd report trace.dat | head -50

# Record scheduler events with stack traces
trace-cmd record -e sched_switch -e sched_wakeup --stacktrace sleep 5

# Record for a specific command
trace-cmd record -p function -F ls /tmp
trace-cmd report

# Live streaming (don't buffer — useful for kernel panics)
trace-cmd stream -p function_graph -g 'ext4_*' > /tmp/trace_stream.txt &

# Kernel latency histogram
trace-cmd hist -e sched_switch -k "prev_comm" sleep 5
```

## kprobes: Dynamic Kernel Instrumentation

kprobes attach handlers to any kernel instruction, even in production kernels without debug symbols. They work by replacing the instruction at the target address with a breakpoint (INT3 on x86), executing the handler, then continuing.

### kprobes via tracefs

```bash
# List available kprobe events
cat /sys/kernel/tracing/available_filter_functions | grep tcp_sendmsg

# Create a kprobe on tcp_sendmsg to trace send sizes
echo 'p:myprobe tcp_sendmsg size=$arg3' > /sys/kernel/tracing/kprobe_events
# Format: [p|r]:name function [arguments]
# p = entry probe, r = return probe

# Enable the probe
echo 1 > /sys/kernel/tracing/events/kprobes/myprobe/enable

# Set filter: only trace large sends (size > 65536)
echo 'size > 65536' > /sys/kernel/tracing/events/kprobes/myprobe/filter

echo 1 > /sys/kernel/tracing/tracing_on
# ... trigger some network activity ...
cat /sys/kernel/tracing/trace

# Clean up
echo 0 > /sys/kernel/tracing/events/kprobes/myprobe/enable
echo '-:myprobe' >> /sys/kernel/tracing/kprobe_events
```

### kprobes with Return Probes (kretprobes)

kretprobes fire when the function returns, allowing you to capture return values:

```bash
# Probe the return value of do_sys_openat2 (file descriptor or error)
echo 'r:openat_ret do_sys_openat2 retval=$retval' > /sys/kernel/tracing/kprobe_events

echo 1 > /sys/kernel/tracing/events/kprobes/openat_ret/enable
echo 1 > /sys/kernel/tracing/tracing_on

# Trigger file opens
ls /etc

echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace | grep openat_ret
# ls-12345 [001] 1234.5678: openat_ret: (do_sys_openat2+0x0/0x2f0 <- __x64_sys_openat) retval=3
# ls-12345 [001] 1234.5679: openat_ret: retval=4
```

### perf-kprobe: kprobes with perf

```bash
# Add a kprobe via perf
perf probe --add 'tcp_sendmsg size=@arg3'

# List added probes
perf probe --list

# Record with the kprobe
perf record -e probe:tcp_sendmsg -a sleep 10

# Analyze
perf script | head -20
# tcp_sendmsg 12345 [001] 1234.567: probe:tcp_sendmsg: (ffffffff...)  size=4096

# Remove probe
perf probe --del 'tcp_sendmsg'
```

## uprobes: Userspace Dynamic Tracing

uprobes apply the kprobe mechanism to userspace processes, tracing arbitrary instructions in application binaries and shared libraries without recompilation:

```bash
# Probe a specific address in a binary
# First, find the address of the function
readelf -s /usr/bin/myapp | grep processRequest
# 12345: 00000000004a1234  245 FUNC  GLOBAL DEFAULT   13 processRequest

# Create a uprobe at that address
echo 'p:myapp_probe /usr/bin/myapp:0x4a1234' > /sys/kernel/tracing/uprobe_events

# Enable it
echo 1 > /sys/kernel/tracing/events/uprobes/myapp_probe/enable
echo 1 > /sys/kernel/tracing/tracing_on

# ... run myapp ...
cat /sys/kernel/tracing/trace
```

### perf-uprobe: More Practical Uprobe Interface

```bash
# Add uprobe on a Go function (mangled symbol)
SYMBOL='main.processRequest'
perf probe --exec /usr/bin/myapp --add "${SYMBOL}"

# For Go with debug info
perf probe --exec /usr/bin/myapp -D "${SYMBOL}"
# Shows available variables at entry

# Record uprobe events for 30 seconds
perf record -e "probe_myapp:processRequest" -p $(pgrep myapp) sleep 30

# Flamegraph with uprobes
perf record -e "probe_myapp:processRequest" --call-graph dwarf -p $(pgrep myapp) sleep 10
perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg
```

### USDT: User Statically Defined Tracepoints

USDT probes are pre-compiled tracepoints in applications that are more reliable than function-offset uprobes since they're stable across binary rebuilds. Node.js, Python, and many databases include USDT probes:

```bash
# List USDT probes in Node.js
tplist -l /usr/bin/node | head -20
# /usr/bin/node node:gc__start
# /usr/bin/node node:gc__done
# /usr/bin/node node:http__server__request

# Trace Node.js HTTP requests via USDT
perf probe --exec /usr/bin/node --add sdt_node:http__server__request
perf record -e "sdt_node:http__server__request" -p $(pgrep node) sleep 5
perf script | head -20
```

## SystemTap: Programmable Kernel Tracing

SystemTap compiles small D-like scripts into kernel modules, enabling complex probe logic that would require multiple ftrace/kprobe commands:

```bash
# Install SystemTap and kernel debug info
apt-get install systemtap linux-image-$(uname -r)-dbg linux-headers-$(uname -r)
```

### SystemTap Script: Syscall Latency Distribution

```systemtap
#!/usr/bin/env stap
# syscall_latency.stp — distribution of open() latency

global start_time, latency_hist

probe syscall.open {
    start_time[tid()] = gettimeofday_ns()
}

probe syscall.open.return {
    if (!(tid() in start_time)) next
    delta = gettimeofday_ns() - start_time[tid()]
    delete start_time[tid()]

    if ($return >= 0) {  # Only successful opens
        latency_hist <<< delta
    }
}

probe end {
    printf("open() latency distribution (nanoseconds):\n")
    print(@hist_log(latency_hist))
    printf("  min=%d avg=%d max=%d\n",
           @min(latency_hist), @avg(latency_hist), @max(latency_hist))
}
```

```bash
stap syscall_latency.stp -T 10  # Run for 10 seconds
```

### SystemTap Script: TCP Retransmit Tracking

```systemtap
#!/usr/bin/env stap
# tcp_retransmit.stp — track TCP retransmissions by destination

global retransmit_count

probe kernel.function("tcp_retransmit_skb") {
    dst_ip = format_ipaddr(__ip_sock_daddr($sk), __ip_sock_family($sk))
    retransmit_count[dst_ip]++
}

probe timer.s(5) {
    printf("TCP Retransmissions in last 5 seconds:\n")
    foreach (ip in retransmit_count- limit 10) {
        printf("  %-20s %5d\n", ip, retransmit_count[ip])
    }
    delete retransmit_count
}
```

### SystemTap Script: Lock Contention Analysis

```systemtap
#!/usr/bin/env stap
# mutex_contention.stp — find heavily contended mutexes

global contention_time, contention_count

probe kernel.function("mutex_lock") {
    if (pid() == target())
        contention_time[tid()] = gettimeofday_us()
}

probe kernel.function("mutex_lock").return {
    if (!(tid() in contention_time)) next
    delta = gettimeofday_us() - contention_time[tid()]
    delete contention_time[tid()]

    if (delta > 100) {  # More than 100 microseconds
        contention_count[usymname($__ip)] += delta
    }
}

probe end {
    printf("Mutex contention (microseconds total):\n")
    foreach (sym in contention_count- limit 20) {
        printf("  %-50s %10d us\n", sym, contention_count[sym])
    }
}
```

```bash
stap mutex_contention.stp --target $PID -T 30
```

## Production Investigation Workflow

A real performance investigation combines these tools in sequence:

```bash
# Step 1: High-level: is it CPU, I/O, or scheduling?
perf stat -p $PID sleep 10
# Look at: cache-misses, context-switches, cpu-migrations

# Step 2: CPU profile to find hot functions
perf record -g -p $PID sleep 10
perf report --sort=sym | head -20

# Step 3: ftrace to see what the hot function calls
FUNC=$(perf report --sort=sym | head -5 | awk '{print $3}' | head -1)
echo "$FUNC" > /sys/kernel/tracing/set_graph_function
echo function_graph > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on && sleep 5
echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace | head -100

# Step 4: kprobe to inspect arguments
perf probe --add "tcp_sendmsg size=@arg3 sk=+0(+0(%di)):x64"
perf record -e probe:tcp_sendmsg -p $PID sleep 10
perf script | awk '{print $NF}' | sort | uniq -c | sort -rn | head -20

# Step 5: SystemTap for complex correlation
stap -e '
  probe kernel.function("tcp_sendmsg") {
    if (pid() == target())
      printf("%s: size=%d\n", execname(), $size)
  }
' --target $PID -T 10
```

## Kernel Tracing Safety

These tools are safe for production use with appropriate care:

- ftrace with `function` tracer on a busy kernel can add 10-40% overhead. Use `set_ftrace_filter` to limit scope.
- kprobes on extremely hot paths (e.g., `__alloc_pages`) can cause measurable slowdowns. Profile with the probe disabled first to establish baseline.
- SystemTap compiles and loads kernel modules. A bug in your script can panic the kernel. Test in staging.
- Use `set_ftrace_pid` and `-F command` to limit tracing to specific processes, minimizing impact on other workloads.

The combination of ftrace for call graph visibility, kprobes for runtime argument inspection, uprobes for userspace correlation, and SystemTap for programmable analysis provides a complete toolkit for the most challenging production performance and correctness investigations.
