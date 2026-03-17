---
title: "Linux Tracing with BPFtrace: One-Liners, Scripts, and Production Debugging"
date: 2030-02-24T00:00:00-05:00
draft: false
tags: ["Linux", "BPFtrace", "eBPF", "Performance", "Tracing", "Observability"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master BPFtrace for production debugging: one-liners for immediate insight, scripts for deep analysis, latency heatmaps, off-CPU analysis, and safe kernel tracing techniques."
more_link: "yes"
url: "/linux-tracing-bpftrace-production-debugging/"
---

BPFtrace is the closest thing Linux has to a universal debugging oracle. Armed with a single command, you can trace every syscall a process makes, measure disk I/O latency with microsecond precision, find which kernel function is burning CPU cycles during a production incident, or build a full latency heatmap of your database queries — all without modifying application code, restarting processes, or taking the system offline.

This guide moves from quick one-liners for first-response debugging through complete bpftrace scripts for deep performance analysis, covering the tracing patterns that production engineers reach for most often.

<!--more-->

## What BPFtrace Actually Is

BPFtrace is a high-level tracing language for Linux that compiles to eBPF programs. It sits on top of the kernel's BPF infrastructure and provides:

- **kprobes**: Attach to any kernel function entry or return
- **uprobes**: Attach to any user-space function entry or return
- **tracepoints**: Stable kernel instrumentation points (preferred over kprobes when available)
- **USDT**: User-space statically defined tracing points (requires application support)
- **perf events**: CPU performance counters, hardware events

Unlike `perf` or `ftrace`, bpftrace uses a C-like syntax that lets you filter, aggregate, and compute statistics directly in the kernel — meaning the data you see is already processed, not a flood of raw events.

### Installation

```bash
# Ubuntu/Debian
apt-get install bpftrace

# RHEL/CentOS/Rocky
dnf install bpftrace

# From source (for latest features)
git clone https://github.com/bpftrace/bpftrace
cd bpftrace && mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)
make install
```

Verify kernel support:

```bash
bpftrace --info 2>&1 | head -40
```

You need at minimum Linux 4.9 for basic tracing; 5.x for full feature support including BTF (BPF Type Format), which enables CO-RE (Compile Once, Run Everywhere) and avoids the need for kernel headers.

## Essential One-Liners for Production First Response

Keep these in a runbook. They answer the most common "what is happening right now" questions.

### Syscall Activity

```bash
# Count syscalls by process name (top system call consumers)
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Count syscalls by name for a specific PID
bpftrace -e 'tracepoint:raw_syscalls:sys_enter /pid == 12345/ { @[probe] = count(); }'

# Trace all syscalls for a process with timing
bpftrace -e '
tracepoint:raw_syscalls:sys_enter /comm == "nginx"/ {
    @start[tid] = nsecs;
}
tracepoint:raw_syscalls:sys_exit /comm == "nginx" && @start[tid]/ {
    @latency_ns = hist(nsecs - @start[tid]);
    delete(@start[tid]);
}'
```

### File System Activity

```bash
# Files opened by process name
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s opened %s\n", comm, str(args->filename)); }'

# File read/write sizes by process
bpftrace -e '
tracepoint:syscalls:sys_exit_read /args->ret > 0/ {
    @read_bytes[comm] = sum(args->ret);
}
tracepoint:syscalls:sys_exit_write /args->ret > 0/ {
    @write_bytes[comm] = sum(args->ret);
}'

# Slow file opens (> 1ms)
bpftrace -e '
tracepoint:syscalls:sys_enter_openat {
    @start[tid] = nsecs;
    @fname[tid] = str(args->filename);
}
tracepoint:syscalls:sys_exit_openat /@start[tid]/ {
    $lat_us = (nsecs - @start[tid]) / 1000;
    if ($lat_us > 1000) {
        printf("SLOW open: %s by %s: %d us\n", @fname[tid], comm, $lat_us);
    }
    delete(@start[tid]);
    delete(@fname[tid]);
}'
```

### Network Activity

```bash
# TCP connections being established
bpftrace -e 'kprobe:tcp_connect { printf("%s -> %s\n", comm, ntop(args->sk->__sk_common.skc_daddr)); }'

# TCP retransmits (useful for detecting network problems)
bpftrace -e 'tracepoint:tcp:tcp_retransmit_skb { @[comm, pid] = count(); }'

# UDP send/receive by process
bpftrace -e '
kprobe:udp_sendmsg { @udp_send[comm] = count(); }
kprobe:udp_recvmsg { @udp_recv[comm] = count(); }'

# Socket accept latency (time from listen to accept)
bpftrace -e '
kretprobe:inet_csk_accept /retval != 0/ {
    @[comm] = count();
}'
```

### CPU and Scheduler

```bash
# CPU time by process (samples stack every 10ms)
bpftrace -e 'profile:hz:99 { @[comm] = count(); }'

# Context switches by process
bpftrace -e 'tracepoint:sched:sched_switch { @[prev_comm] = count(); }'

# Off-CPU time (time waiting, not running)
bpftrace -e '
tracepoint:sched:sched_switch {
    if (prev_state == TASK_RUNNING) {
        @start[prev_pid] = nsecs;
    }
    if (@start[next_pid]) {
        @offcpu[next_comm] = hist(nsecs - @start[next_pid]);
        delete(@start[next_pid]);
    }
}'

# Processes being woken up (useful for latency attribution)
bpftrace -e 'tracepoint:sched:sched_wakeup { @[comm, pid] = count(); }'
```

### Memory

```bash
# OOM kill events
bpftrace -e 'kprobe:oom_kill_process { printf("OOM kill: %s (pid %d)\n", comm, pid); }'

# Page faults by process
bpftrace -e '
software:page-faults:1 { @[comm] = count(); }'

# Memory allocations in kernel (kmalloc)
bpftrace -e 'tracepoint:kmem:kmalloc { @bytes_requested[comm] = hist(args->bytes_req); }'

# Large allocations (> 1MB at a time)
bpftrace -e '
tracepoint:kmem:kmalloc /args->bytes_req > 1048576/ {
    printf("Large alloc: %s requested %d bytes\n", comm, args->bytes_req);
}'
```

## Disk I/O Latency Analysis

Disk latency analysis is one of the most common production debugging tasks. This script provides a comprehensive view:

```bash
#!/usr/bin/env bpftrace
// disk-latency.bt - Disk I/O latency analysis

BEGIN {
    printf("Tracing block I/O latency... Ctrl-C to stop\n");
    printf("%-10s %-7s %-6s %-7s %s\n", "TIME", "COMM", "PID", "LATENCY", "DISK");
}

tracepoint:block:block_rq_insert {
    @start[args->dev, args->sector] = nsecs;
    @comm[args->dev, args->sector] = comm;
    @pid_map[args->dev, args->sector] = pid;
}

tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
    $lat_us = (nsecs - @start[args->dev, args->sector]) / 1000;
    $comm = @comm[args->dev, args->sector];

    // Latency histogram
    @latency_us = hist($lat_us);

    // Per-disk histogram
    @per_disk[args->dev] = hist($lat_us);

    // Alert on very slow I/O (> 100ms)
    if ($lat_us > 100000) {
        printf("SLOW I/O: %s (pid %d) lat=%d us on dev %d\n",
            $comm, @pid_map[args->dev, args->sector], $lat_us, args->dev);
    }

    delete(@start[args->dev, args->sector]);
    delete(@comm[args->dev, args->sector]);
    delete(@pid_map[args->dev, args->sector]);
}

END {
    printf("\n=== Overall I/O Latency Distribution (us) ===\n");
    print(@latency_us);
    printf("\n=== Per-Disk Latency Distribution (us) ===\n");
    print(@per_disk);
    clear(@start);
    clear(@comm);
    clear(@pid_map);
}
```

Run it:

```bash
bpftrace disk-latency.bt
```

Sample output:

```
Tracing block I/O latency... Ctrl-C to stop
TIME       COMM    PID    LATENCY  DISK
SLOW I/O: mysqld (pid 4821) lat=143520 us on dev 8388608

=== Overall I/O Latency Distribution (us) ===
@latency_us:
[1]                 4521 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[2, 4)              2104 |@@@@@@@@@@@@@@@@@@@@@@@@         |
[4, 8)               981 |@@@@@@@@@@@@                     |
[8, 16)              432 |@@@@@                            |
[16, 32)             187 |@@                               |
[32, 64)              91 |@                                |
[64, 128)             43 |                                 |
[128, 256)            12 |                                 |
[1K, 2K)               3 |                                 |
[16K, 32K)             1 |                                 |
[64K, 128K)            2 |                                 |
[128K, 256K)           1 |                                 |
```

## Latency Heatmaps

Heatmaps show latency distribution over time — essential for spotting intermittent slowdowns. BPFtrace can generate the data; you visualize it with tools like FlameGraph or your own scripts.

```bash
#!/usr/bin/env bpftrace
// latency-heatmap.bt - Generates heatmap data for syscall latency

#include <linux/sched.h>

BEGIN {
    printf("time_us,latency_us\n");  // CSV header for import
}

tracepoint:syscalls:sys_enter_read /comm == "postgres"/ {
    @start[tid] = nsecs;
}

tracepoint:syscalls:sys_exit_read /comm == "postgres" && @start[tid] && args->ret > 0/ {
    $lat_us = (nsecs - @start[tid]) / 1000;
    $time_us = nsecs / 1000;

    // Print CSV for heatmap generation
    printf("%lld,%lld\n", $time_us, $lat_us);

    // Also maintain running histogram
    @heatmap[$time_us / 1000000] = hist($lat_us);  // 1-second buckets

    delete(@start[tid]);
}
```

Generate heatmap visualization:

```python
#!/usr/bin/env python3
# generate-heatmap.py
import sys
import csv
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import LogNorm

data = []
with open(sys.argv[1]) as f:
    reader = csv.DictReader(f)
    for row in reader:
        data.append((int(row['time_us']), int(row['latency_us'])))

if not data:
    print("No data")
    sys.exit(1)

times = [d[0] for d in data]
latencies = [d[1] for d in data]

# Create 2D histogram for heatmap
min_time = min(times)
time_bins = np.linspace(0, max(times) - min_time, 100)
lat_bins = np.logspace(0, np.log10(max(latencies) + 1), 50)

adjusted_times = [t - min_time for t in times]
H, xedges, yedges = np.histogram2d(adjusted_times, latencies,
                                    bins=[time_bins, lat_bins])

plt.figure(figsize=(14, 6))
plt.pcolormesh(xedges / 1e6, yedges, H.T, cmap='hot_r', norm=LogNorm())
plt.colorbar(label='Count')
plt.xlabel('Time (seconds)')
plt.ylabel('Latency (us)')
plt.title('Read Latency Heatmap - postgres')
plt.yscale('log')
plt.savefig('heatmap.png', dpi=150, bbox_inches='tight')
print("Heatmap saved to heatmap.png")
```

## Off-CPU Analysis

Off-CPU time represents periods when a process is not scheduled — waiting for I/O, locks, or sleep. This is crucial for understanding latency that doesn't show up in CPU profiling.

```bash
#!/usr/bin/env bpftrace
// offcpu.bt - Off-CPU time analysis with stack traces

#include <linux/sched.h>

// Track when each thread goes off-CPU
tracepoint:sched:sched_switch
{
    if (prev_state == TASK_RUNNING) {
        // Thread was preempted (still runnable)
        @preempted[prev_pid] = nsecs;
    } else {
        // Thread blocked (I/O, lock, sleep)
        @blocked[prev_pid] = nsecs;
        @blocked_stack[prev_pid] = kstack;
        @blocked_ustack[prev_pid] = ustack;
        @blocked_comm[prev_pid] = prev_comm;
    }
}

tracepoint:sched:sched_switch
/@blocked[next_pid]/
{
    $wait_us = (nsecs - @blocked[next_pid]) / 1000;

    // Only report significant off-CPU time (> 1ms)
    if ($wait_us > 1000) {
        printf("\n=== Off-CPU %s (pid %d) for %d us ===\n",
            @blocked_comm[next_pid], next_pid, $wait_us);
        printf("Kernel stack when blocked:\n%s\n", @blocked_stack[next_pid]);
        printf("User stack when blocked:\n%s\n", @blocked_ustack[next_pid]);

        @offcpu_hist[@blocked_comm[next_pid]] = hist($wait_us);
    }

    delete(@blocked[next_pid]);
    delete(@blocked_stack[next_pid]);
    delete(@blocked_ustack[next_pid]);
    delete(@blocked_comm[next_pid]);
}

END {
    print(@offcpu_hist);
    clear(@preempted);
    clear(@blocked);
    clear(@blocked_stack);
    clear(@blocked_ustack);
    clear(@blocked_comm);
}
```

## Database Query Tracing with USDT

Applications compiled with USDT probes expose stable tracing points. PostgreSQL provides extensive USDT probes:

```bash
# List available PostgreSQL USDT probes
bpftrace -l 'usdt:/usr/lib/postgresql/14/bin/postgres:*'
```

```bash
#!/usr/bin/env bpftrace
// postgres-query-trace.bt - Trace PostgreSQL query execution

// Note: PostgreSQL must be compiled with --enable-dtrace
// Requires: postgresql14-server with USDT support

usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:query__start
{
    @query_start[tid] = nsecs;
    @query_text[tid] = str(arg0);
}

usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:query__done
/@query_start[tid]/
{
    $lat_ms = (nsecs - @query_start[tid]) / 1000000;

    if ($lat_ms > 100) {
        printf("SLOW QUERY (%d ms): %s\n", $lat_ms, @query_text[tid]);
    }

    @query_latency_ms = hist($lat_ms);
    delete(@query_start[tid]);
    delete(@query_text[tid]);
}

usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:query__parse__start
{
    @parse_start[tid] = nsecs;
}

usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:query__parse__done
/@parse_start[tid]/
{
    @parse_time_us = hist((nsecs - @parse_start[tid]) / 1000);
    delete(@parse_start[tid]);
}

END {
    printf("\n=== Query Latency Distribution (ms) ===\n");
    print(@query_latency_ms);
    printf("\n=== Parse Time Distribution (us) ===\n");
    print(@parse_time_us);
}
```

## Kernel Function Tracing

When you need to understand kernel behavior, kprobes let you attach to any kernel function:

```bash
#!/usr/bin/env bpftrace
// vfs-latency.bt - VFS layer latency analysis

// Track VFS read latency
kprobe:vfs_read
{
    @start[tid] = nsecs;
    @comm_map[tid] = comm;
    @pid_map[tid] = pid;
}

kretprobe:vfs_read
/@start[tid]/
{
    $lat_us = (nsecs - @start[tid]) / 1000;

    @vfs_read_lat[comm] = hist($lat_us);
    @vfs_read_bytes[comm] = sum(retval > 0 ? retval : 0);

    // Flag extremely slow reads
    if ($lat_us > 50000) {
        printf("VFS slow read: %s (pid %d) %d us, ret=%d\n",
            comm, pid, $lat_us, retval);
        printf("  kstack: %s\n", kstack(3));
    }

    delete(@start[tid]);
    delete(@comm_map[tid]);
    delete(@pid_map[tid]);
}

// Track VFS write latency
kprobe:vfs_write { @wstart[tid] = nsecs; }
kretprobe:vfs_write /@wstart[tid]/ {
    @vfs_write_lat[comm] = hist((nsecs - @wstart[tid]) / 1000);
    delete(@wstart[tid]);
}

END {
    printf("\n=== VFS Read Latency (us) by Process ===\n");
    print(@vfs_read_lat);
    printf("\n=== VFS Write Latency (us) by Process ===\n");
    print(@vfs_write_lat);
    printf("\n=== VFS Read Bytes by Process ===\n");
    print(@vfs_read_bytes);
}
```

## Lock Contention Analysis

Lock contention causes latency spikes that are invisible to CPU profilers. BPFtrace can reveal them:

```bash
#!/usr/bin/env bpftrace
// mutex-contention.bt - pthread mutex contention analysis

// Trace pthread_mutex_lock enter
uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock
{
    @lock_start[tid] = nsecs;
    @lock_addr[tid] = arg0;
}

// Trace pthread_mutex_lock return
uretprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock
/@lock_start[tid]/
{
    $wait_us = (nsecs - @lock_start[tid]) / 1000;

    if ($wait_us > 100) {
        // Significant contention
        @contention[comm, @lock_addr[tid]] = hist($wait_us);

        if ($wait_us > 10000) {
            printf("HIGH CONTENTION: %s (pid %d) waited %d us for mutex 0x%lx\n",
                comm, pid, $wait_us, @lock_addr[tid]);
            printf("Stack:\n%s\n", ustack(5));
        }
    }

    delete(@lock_start[tid]);
    delete(@lock_addr[tid]);
}

// Track spinlock contention in kernel
kprobe:queued_spin_lock_slowpath
{
    @spin_contention[comm] = count();
}

END {
    printf("\n=== Mutex Contention (us) ===\n");
    print(@contention);
    printf("\n=== Kernel Spinlock Contention ===\n");
    print(@spin_contention);
}
```

## HTTP Request Tracing with uprobes

Trace Go HTTP server handlers without modifying code:

```bash
#!/usr/bin/env bpftrace
// go-http-trace.bt - Trace Go HTTP handler latency
// Works with Go binaries compiled without stripping symbols

// Find the symbol with: nm /path/to/binary | grep ServeHTTP
// Then attach to it

uprobe:/path/to/myapp:net/http.(*ServeMux).ServeHTTP
{
    @req_start[tid] = nsecs;
}

uretprobe:/path/to/myapp:net/http.(*ServeMux).ServeHTTP
/@req_start[tid]/
{
    $lat_us = (nsecs - @req_start[tid]) / 1000;
    @http_latency_us = hist($lat_us);

    if ($lat_us > 500000) {  // > 500ms
        printf("SLOW HTTP request: %d us\n", $lat_us);
        printf("Stack:\n%s\n", ustack(5));
    }

    delete(@req_start[tid]);
}

END {
    printf("\n=== HTTP Handler Latency (us) ===\n");
    print(@http_latency_us);
}
```

## Network Packet Loss Analysis

```bash
#!/usr/bin/env bpftrace
// packet-loss.bt - Track packet drops and their causes

// TCP packet drops
kprobe:tcp_drop
{
    @tcp_drops[comm] = count();
    printf("TCP drop: %s (pid %d) - stack:\n%s\n", comm, pid, kstack(4));
}

// Kernel packet drops (generic)
tracepoint:skb:kfree_skb
{
    @kfree_skb_reasons[args->reason] = count();
}

// Socket receive buffer full
kprobe:sock_rcvmsg
/retval == -12/  // -ENOMEM
{
    @rcvbuf_full[comm] = count();
}

// Track retransmissions
tracepoint:tcp:tcp_retransmit_skb
{
    @retransmits[comm] = count();
    @retransmit_total = count();
}

// Track RST packets (abrupt connection termination)
kprobe:tcp_send_reset
{
    @tcp_resets[comm] = count();
}

interval:s:5
{
    printf("\n=== 5-second network summary ===\n");
    printf("TCP drops: "); print(@tcp_drops);
    printf("Retransmits: "); print(@retransmits);
    printf("TCP resets: "); print(@tcp_resets);
    clear(@tcp_drops);
    clear(@retransmits);
    clear(@tcp_resets);
}
```

## CPU Flame Graph Generation

```bash
#!/bin/bash
# generate-flamegraph.sh - Generate CPU flame graph with bpftrace

DURATION=${1:-30}
OUTPUT="flamegraph-$(date +%Y%m%d-%H%M%S)"
PID=${2:-}  # Optional: trace specific PID

echo "Collecting CPU stack traces for ${DURATION}s..."

if [ -n "$PID" ]; then
    FILTER="/pid == $PID/"
else
    FILTER=""
fi

bpftrace -e "
profile:hz:99 $FILTER {
    @[ustack, kstack, comm] = count();
}
END {
    print(@);
}" --duration ${DURATION} > /tmp/bpftrace-stacks.txt

echo "Processing stacks..."

# Collapse stacks for FlameGraph
python3 - << 'EOF' /tmp/bpftrace-stacks.txt > /tmp/collapsed.txt
import sys
import re

with open(sys.argv[1]) as f:
    content = f.read()

# Parse bpftrace output format
# Each entry looks like: @[stack1, stack2, comm]: count
pattern = re.compile(r'@\[([^\]]+)\]: (\d+)', re.MULTILINE | re.DOTALL)

for match in pattern.finditer(content):
    frames_raw, count = match.group(1), match.group(2)
    # Split frames and reverse (FlameGraph expects root first)
    frames = [f.strip() for f in frames_raw.split('\n') if f.strip() and f.strip() != '...']
    if frames:
        print(';'.join(reversed(frames)) + ' ' + count)
EOF

# Generate SVG
if command -v flamegraph.pl &>/dev/null; then
    flamegraph.pl /tmp/collapsed.txt > "${OUTPUT}.svg"
    echo "Flame graph: ${OUTPUT}.svg"
else
    echo "Install FlameGraph: git clone https://github.com/brendangregg/FlameGraph"
    echo "Raw collapsed stacks: /tmp/collapsed.txt"
fi
```

## Memory Leak Detection

```bash
#!/usr/bin/env bpftrace
// memleak.bt - Track kernel memory allocations and frees
// Useful for detecting kernel memory leaks

tracepoint:kmem:kmalloc
{
    @alloc[args->ptr] = args->bytes_alloc;
    @alloc_site[args->ptr] = kstack(3);
    @total_allocated = sum(args->bytes_alloc);
}

tracepoint:kmem:kfree
/@alloc[args->ptr]/
{
    @total_freed = sum(@alloc[args->ptr]);
    delete(@alloc[args->ptr]);
    delete(@alloc_site[args->ptr]);
}

tracepoint:kmem:kmalloc_node
{
    @alloc[args->ptr] = args->bytes_alloc;
    @total_allocated = sum(args->bytes_alloc);
}

interval:s:10
{
    $leaked = @total_allocated - @total_freed;
    printf("Allocated: %d bytes, Freed: %d bytes, Net: %d bytes\n",
        @total_allocated, @total_freed, $leaked);

    // Show top allocation sites by unreleased memory
    printf("Top allocation stacks (not yet freed):\n");
    // In practice you'd need to correlate @alloc_site with outstanding @alloc entries
}
```

## Production Safety Guidelines

BPFtrace is generally safe for production use, but observe these guidelines:

### Safe Practices

```bash
# Always limit duration to prevent runaway scripts
bpftrace --duration 60 my-script.bt  # Auto-exit after 60 seconds

# Use frequency-based sampling for CPU profiling rather than per-event tracing
bpftrace -e 'profile:hz:99 { @[comm] = count(); }'  # 99Hz sampling, very low overhead
# NOT: bpftrace -e 'software:cpu-clock:1 { @[comm] = count(); }'  # 1ns, very high overhead

# Filter aggressively to reduce overhead
bpftrace -e 'tracepoint:syscalls:sys_enter_read /pid == TARGET_PID/ { ... }'

# Use hist() and count() rather than printf() for high-frequency events
# printf on every disk I/O at high IOPS can cause issues
# BAD:  tracepoint:block:block_rq_complete { printf("%d\n", args->nr_sector); }
# GOOD: tracepoint:block:block_rq_complete { @sectors = hist(args->nr_sector); }

# Test scripts in dev/staging before production
# Use --dry-run to verify syntax
bpftrace --dry-run my-script.bt
```

### Overhead Estimation

```bash
# Measure overhead of your script
# Run with the script:
perf stat -e instructions,cycles bpftrace my-script.bt --duration 5

# Compare without:
perf stat -e instructions,cycles sleep 5

# Typical overhead by probe type (approximate):
# tracepoint: 0.1-1 microsecond per event
# kprobe: 1-5 microseconds per event
# uprobe: 5-20 microseconds per event
# USDT: 1-5 microseconds per event (similar to tracepoint)
# profile:hz:99: ~1% CPU overhead (99 interrupts/second)
```

### Kernel Version Compatibility

```bash
# Check what BTF information is available (preferred for CO-RE)
ls /sys/kernel/btf/

# Fall back to kernel headers if BTF unavailable
export BPFTRACE_KERNEL_SOURCE=/usr/src/linux-headers-$(uname -r)

# Verify a specific tracepoint exists before using it
bpftrace -l 'tracepoint:block:block_rq_complete'

# List all available tracepoints for a subsystem
bpftrace -l 'tracepoint:tcp:*'
bpftrace -l 'tracepoint:sched:*'
bpftrace -l 'tracepoint:syscalls:sys_enter_*' | head -20
```

## Building a Production Tracing Toolkit

Organize your bpftrace scripts for team use:

```
/etc/bpftrace/
├── runbooks/
│   ├── high-cpu.bt          # CPU profiling
│   ├── high-iowait.bt       # I/O wait analysis
│   ├── network-drops.bt     # Packet loss investigation
│   ├── slow-queries.bt      # Database query latency
│   └── memory-pressure.bt   # Memory allocation analysis
├── alerts/
│   ├── oom-notify.bt        # Page to oncall on OOM kills
│   └── disk-slow.bt         # Alert on sustained slow I/O
└── profiling/
    ├── flamegraph.sh         # CPU flame graph generator
    └── offcpu-flamegraph.sh  # Off-CPU flame graph generator
```

### Wrapper Script for Common Use

```bash
#!/bin/bash
# btrace - Simplified bpftrace wrapper for common tasks
# Usage: btrace <command> [options]

RUNBOOK_DIR="/etc/bpftrace/runbooks"

case "$1" in
    cpu)
        PID=${2:-}
        FILTER=""
        [ -n "$PID" ] && FILTER="/pid == $PID/"
        bpftrace -e "profile:hz:99 $FILTER { @[comm, ustack] = count(); }" \
            --duration ${DURATION:-30}
        ;;
    io)
        bpftrace "${RUNBOOK_DIR}/high-iowait.bt"
        ;;
    net)
        bpftrace "${RUNBOOK_DIR}/network-drops.bt"
        ;;
    syscalls)
        PID=$2
        [ -z "$PID" ] && { echo "Usage: btrace syscalls <pid>"; exit 1; }
        bpftrace -e "tracepoint:raw_syscalls:sys_enter /pid == $PID/ { @[probe] = count(); }" \
            --duration ${DURATION:-30}
        ;;
    flames)
        bash /etc/bpftrace/profiling/flamegraph.sh ${2:-30} ${3:-}
        ;;
    *)
        echo "Usage: btrace {cpu|io|net|syscalls|flames} [options]"
        echo "  cpu [pid]          - CPU profiling"
        echo "  io                 - I/O wait analysis"
        echo "  net                - Network drop analysis"
        echo "  syscalls <pid>     - System call frequency"
        echo "  flames [secs] [pid]- Generate CPU flame graph"
        exit 1
        ;;
esac
```

## Key Takeaways

BPFtrace transforms production debugging from guesswork into precision measurement:

1. **One-liners for immediate insight**: Start with syscall counts, file activity, and network tracepoints to quickly identify the category of problem before diving deeper.
2. **Histograms over printf**: For high-frequency events, always use `hist()` and `count()` rather than printing every event — this keeps overhead minimal and data useful.
3. **Off-CPU analysis reveals hidden latency**: Problems that don't show up in CPU profiles (lock contention, I/O waits, sleep calls) are visible only through off-CPU tracing.
4. **USDT probes for application-level visibility**: Databases and runtimes with USDT support give you query-level and request-level insight without any code modification.
5. **Flame graphs from bpftrace data**: CPU profiling with `profile:hz:99` plus FlameGraph tooling provides actionable stack-level attribution of CPU time.
6. **Safety by default**: Duration limits, frequency-based sampling, and aggressive filtering keep production overhead negligible.

The most valuable skill is knowing which probe type to reach for: tracepoints for stable kernel events, kprobes for arbitrary kernel functions, uprobes for user-space, and USDT for application-specific points. Combine them with bpftrace's aggregation primitives and you have a complete observability solution that works on any Linux system.
