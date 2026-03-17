---
title: "Linux eBPF Tracing: Dynamic Instrumentation with bpftrace and BCC"
date: 2030-06-28T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "bpftrace", "BCC", "Tracing", "Performance", "Observability", "Kernel"]
categories:
- Linux
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production eBPF tracing: bpftrace one-liners and scripts, BCC Python tools, kernel function argument inspection, latency histograms, off-CPU flame graphs, and custom tracepoints for production debugging."
more_link: "yes"
url: "/linux-ebpf-tracing-bpftrace-bcc-production-debugging/"
---

Traditional profiling tools instrument programs by modifying binaries, sampling at fixed intervals, or requiring application-level changes. eBPF changes this entirely: programs can be dynamically inserted into running kernels without restarts, without source code, and without observable overhead on non-triggered paths. bpftrace and the BCC toolkit bring this capability to production debugging, where attaching strace or perf to a critical process would be unacceptable and adding instrumentation would require a deployment cycle.

<!--more-->

## eBPF Architecture Overview

eBPF programs are bytecode compiled from restricted C (or the bpftrace DSL) and verified by the kernel before execution. The verifier ensures termination, memory safety, and privilege requirements. Verified programs are JIT-compiled to native machine code and attached to probe points: kernel functions, tracepoints, hardware performance counters, network ingress/egress, and userspace functions.

### Probe Types

| Probe Type | Syntax (bpftrace) | Use Case |
|---|---|---|
| kprobe | `kprobe:vfs_read` | Kernel function entry |
| kretprobe | `kretprobe:vfs_read` | Kernel function return |
| uprobe | `uprobe:/bin/bash:readline` | Userspace function entry |
| uretprobe | `uretprobe:/bin/bash:readline` | Userspace function return |
| tracepoint | `tracepoint:syscalls:sys_enter_read` | Stable kernel tracepoints |
| perf_event | `hardware:cpu-cycles` | Hardware counters |
| usdt | `usdt:/usr/bin/python3:python:function__entry` | Userspace defined tracepoints |
| profile | `profile:hz:99` | CPU time sampling |
| interval | `interval:s:5` | Periodic execution |
| software | `software:page-faults:100` | Software events |

### Prerequisites

```bash
# Check kernel version (minimum 4.9 for basic eBPF, 5.2+ for BTF)
uname -r

# Verify BTF (BPF Type Format) support - enables CO-RE
ls /sys/kernel/btf/vmlinux

# Install bpftrace
apt-get install -y bpftrace  # Ubuntu 20.04+
# Or from source for latest version

# Install BCC tools
apt-get install -y bpfcc-tools linux-headers-$(uname -r)

# Verify bpftrace works
bpftrace -e 'BEGIN { printf("eBPF works\n"); exit(); }'
```

## bpftrace One-Liners for Production Debugging

### Syscall Tracing

```bash
# Count syscalls by process name (5-second snapshot)
bpftrace -e '
tracepoint:raw_syscalls:sys_enter
{
    @[comm] = count();
}
interval:s:5
{
    print(@);
    clear(@);
}' 

# Trace open() calls with filenames
bpftrace -e '
tracepoint:syscalls:sys_enter_openat
{
    printf("%-16s %-6d %s\n", comm, pid, str(args->filename));
}'

# Count open() calls by process showing only errors
bpftrace -e '
tracepoint:syscalls:sys_exit_openat
/args->ret < 0/
{
    @errors[comm, args->ret] = count();
}'

# Track write syscall sizes by process
bpftrace -e '
tracepoint:syscalls:sys_enter_write
{
    @[comm] = hist(args->count);
}'
```

### Network Tracing

```bash
# Trace TCP connection establishments
bpftrace -e '
kprobe:tcp_connect
{
    printf("%-8d %-16s ", pid, comm);
}
kretprobe:tcp_connect
{
    printf("ret=%d\n", retval);
}'

# Track TCP retransmits
bpftrace -e '
kprobe:tcp_retransmit_skb
{
    @retransmits[kstack] = count();
}'

# Monitor TCP accept latency
bpftrace -e '
kprobe:inet_csk_accept
{
    @start[tid] = nsecs;
}
kretprobe:inet_csk_accept
/@start[tid]/
{
    @accept_latency_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
```

### I/O Latency Analysis

```bash
# Block I/O latency histogram (microseconds)
bpftrace -e '
kprobe:blk_account_io_start
{
    @start[arg0] = nsecs;
}
kprobe:blk_account_io_done
/@start[arg0]/
{
    @io_latency_us = hist((nsecs - @start[arg0]) / 1000);
    delete(@start[arg0]);
}
interval:s:10
{
    print(@io_latency_us);
    clear(@io_latency_us);
}'

# Slow disk I/O: show operations taking more than 10ms
bpftrace -e '
kprobe:blk_account_io_start
{
    @start[arg0] = nsecs;
}
kprobe:blk_account_io_done
/@start[arg0] && ((nsecs - @start[arg0]) > 10000000)/
{
    printf("Slow I/O: %d ms, process: %s (%d)\n",
        (nsecs - @start[arg0]) / 1000000, comm, pid);
    delete(@start[arg0]);
}'
```

### Memory Analysis

```bash
# Track page fault rates by process
bpftrace -e '
software:page-faults:1
{
    @page_faults[comm] = count();
}
interval:s:5
{
    print(@page_faults);
    clear(@page_faults);
}'

# Monitor mmap() calls - useful for detecting memory mapping growth
bpftrace -e '
tracepoint:syscalls:sys_enter_mmap
{
    @[comm, pid] = hist(args->len);
}'

# OOM killer invocations
bpftrace -e '
kprobe:oom_kill_process
{
    printf("OOM kill: pid=%d comm=%s\n", pid, comm);
    print(kstack);
}'
```

## bpftrace Scripts

### Latency Histogram Script

```bash
#!/usr/bin/env bpftrace
// File: read-latency.bt
// Measure read() latency per process

BEGIN
{
    printf("Tracing read() latency... Hit Ctrl+C to end.\n");
}

tracepoint:syscalls:sys_enter_read
{
    @start[tid] = nsecs;
}

tracepoint:syscalls:sys_exit_read
/@start[tid]/
{
    $latency_us = (nsecs - @start[tid]) / 1000;
    @latency_by_comm[comm] = hist($latency_us);
    delete(@start[tid]);
}

END
{
    printf("\nRead latency histograms by process:\n");
}
```

Run it:
```bash
bpftrace read-latency.bt
```

### Function Argument Inspector

```bash
#!/usr/bin/env bpftrace
// File: inspect-tcp-connect.bt
// Show TCP connection attempts with IP and port

#include <net/sock.h>

kprobe:tcp_connect
{
    $sk = (struct sock *)arg0;
    $inet_family = $sk->__sk_common.skc_family;

    if ($inet_family == AF_INET) {
        $daddr = ntop($sk->__sk_common.skc_daddr);
        $saddr = ntop($sk->__sk_common.skc_rcv_saddr);
        $dport = $sk->__sk_common.skc_dport;
        $sport = $sk->__sk_common.skc_num;

        printf("%-7d %-16s %-15s %-5d %-15s %-5d\n",
            pid, comm,
            $saddr, $sport,
            $daddr, bswap16($dport));
    }
}

BEGIN
{
    printf("%-7s %-16s %-15s %-5s %-15s %-5s\n",
        "PID", "COMM", "SRC_ADDR", "SPORT", "DST_ADDR", "DPORT");
}
```

### Off-CPU Time Analysis

Off-CPU analysis reveals where threads are blocked waiting for I/O, locks, or sleep:

```bash
#!/usr/bin/env bpftrace
// File: offcpu.bt
// Measure time threads spend off-CPU (blocked)

BEGIN
{
    printf("Tracing off-CPU time... Hit Ctrl+C to end.\n");
}

// Track when a thread is scheduled off the CPU
tracepoint:sched:sched_switch
/args->prev_state != 0/  // Only voluntary (blocking) context switches
{
    @offcpu_start[args->prev_pid] = nsecs;
}

// Track when a thread gets scheduled back on
tracepoint:sched:sched_switch
/@offcpu_start[args->next_pid]/
{
    $duration_us = (nsecs - @offcpu_start[args->next_pid]) / 1000;
    if ($duration_us > 10) {  // Only record waits > 10 microseconds
        @offcpu_us[ustack, kstack] = hist($duration_us);
    }
    delete(@offcpu_start[args->next_pid]);
}

END
{
    printf("\nOff-CPU time histograms (stack traces):\n");
    print(@offcpu_us);
}
```

### Lock Contention Analysis

```bash
#!/usr/bin/env bpftrace
// File: mutex-contention.bt
// Track pthread mutex wait times for a specific process

uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock
/pid == $1/
{
    @mutex_lock_start[tid] = nsecs;
}

uretprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock
/pid == $1 && @mutex_lock_start[tid]/
{
    $wait_us = (nsecs - @mutex_lock_start[tid]) / 1000;
    if ($wait_us > 100) {
        printf("mutex contention: %d µs, tid=%d\n", $wait_us, tid);
        print(ustack);
    }
    @mutex_wait_us = hist($wait_us);
    delete(@mutex_lock_start[tid]);
}
```

Run targeting a specific PID:
```bash
bpftrace mutex-contention.bt 12345
```

## BCC Python Tools

### Custom BCC Tool: Slow Postgres Queries

BCC provides a Python API for building more sophisticated tools with formatted output:

```python
#!/usr/bin/env python3
# File: slow-queries.py
# Trace slow PostgreSQL queries using USDT probes

from bcc import BPF, USDT
import sys
import time

# PostgreSQL must be compiled with --enable-dtrace
# Check: ls /usr/lib/debug/.build-id/ and ldd $(which postgres)

usdt = USDT(pid=int(sys.argv[1]))
usdt.enable_probe(probe="query__start", fn_name="trace_query_start")
usdt.enable_probe(probe="query__done", fn_name="trace_query_done")

bpf_text = """
#include <uapi/linux/ptrace.h>

struct query_data_t {
    u64 start_ns;
    char query[256];
};

BPF_HASH(active_queries, u32, struct query_data_t);
BPF_PERF_OUTPUT(slow_queries);

struct slow_query_event_t {
    u32 pid;
    u64 duration_us;
    char query[256];
};

int trace_query_start(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    struct query_data_t data = {};
    data.start_ns = bpf_ktime_get_ns();

    // Read query string from first USDT argument
    bpf_usdt_readarg_p(1, ctx, &data.query, sizeof(data.query));

    active_queries.update(&tid, &data);
    return 0;
}

int trace_query_done(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    struct query_data_t *data = active_queries.lookup(&tid);
    if (!data) return 0;

    u64 duration_us = (bpf_ktime_get_ns() - data->start_ns) / 1000;
    
    // Only report queries slower than 10ms
    if (duration_us > 10000) {
        struct slow_query_event_t event = {};
        event.pid = tid >> 32;
        event.duration_us = duration_us;
        __builtin_memcpy(event.query, data->query, sizeof(event.query));
        slow_queries.perf_submit(ctx, &event, sizeof(event));
    }

    active_queries.delete(&tid);
    return 0;
}
"""

b = BPF(text=bpf_text, usdt_contexts=[usdt])

print(f"Tracing slow queries for PID {sys.argv[1]} (>10ms)...")
print(f"{'PID':<8} {'DURATION_MS':<14} QUERY")

def print_event(cpu, data, size):
    event = b["slow_queries"].event(data)
    query = event.query.decode('utf-8', errors='replace').strip()
    print(f"{event.pid:<8} {event.duration_us/1000:<14.2f} {query[:120]}")

b["slow_queries"].open_perf_buffer(print_event)

try:
    while True:
        b.perf_buffer_poll()
except KeyboardInterrupt:
    print("\nDone.")
```

### BCC Tool: File Descriptor Leak Detection

```python
#!/usr/bin/env python3
# File: fd-leak-detector.py
# Track open() calls without matching close() calls

from bcc import BPF
import time
import sys

bpf_text = """
#include <uapi/linux/ptrace.h>
#include <linux/fs.h>

struct open_event_t {
    u32 pid;
    u32 fd;
    char comm[16];
    char filename[256];
};

BPF_HASH(open_fds, u64, struct open_event_t);  // key: (pid << 32) | fd
BPF_HASH(pending_opens, u32, struct open_event_t);  // key: tid, tracking opens in flight

int trace_openat_entry(struct pt_regs *ctx, int dfd, const char __user *filename) {
    u32 tid = bpf_get_current_pid_tgid();
    struct open_event_t event = {};
    event.pid = bpf_get_current_pid_tgid() >> 32;
    bpf_get_current_comm(&event.comm, sizeof(event.comm));
    bpf_probe_read_user_str(&event.filename, sizeof(event.filename), filename);
    pending_opens.update(&tid, &event);
    return 0;
}

int trace_openat_return(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    int fd = PT_REGS_RC(ctx);
    if (fd < 0) {
        pending_opens.delete(&tid);
        return 0;
    }

    struct open_event_t *event = pending_opens.lookup(&tid);
    if (!event) return 0;

    event->fd = fd;
    u64 key = ((u64)event->pid << 32) | fd;
    open_fds.update(&key, event);
    pending_opens.delete(&tid);
    return 0;
}

int trace_close(struct pt_regs *ctx, int fd) {
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    u64 key = ((u64)pid << 32) | fd;
    open_fds.delete(&key);
    return 0;
}
"""

b = BPF(text=bpf_text)
b.attach_kprobe(event=b.get_syscall_fnname("openat"), fn_name="trace_openat_entry")
b.attach_kretprobe(event=b.get_syscall_fnname("openat"), fn_name="trace_openat_return")
b.attach_kprobe(event=b.get_syscall_fnname("close"), fn_name="trace_close")

target_comm = sys.argv[1] if len(sys.argv) > 1 else None
print(f"Tracking open FDs{' for ' + target_comm if target_comm else ''}... "
      f"Press Ctrl+C to dump results.")

try:
    time.sleep(int(sys.argv[2]) if len(sys.argv) > 2 else 60)
except KeyboardInterrupt:
    pass

print(f"\n{'PID':<8} {'FD':<6} {'COMM':<16} FILENAME")
open_fds = b["open_fds"]
for key, event in sorted(open_fds.items(), key=lambda x: x[1].pid):
    comm = event.comm.decode('utf-8', errors='replace')
    if target_comm and comm != target_comm:
        continue
    filename = event.filename.decode('utf-8', errors='replace')
    print(f"{event.pid:<8} {event.fd:<6} {comm:<16} {filename}")
```

## Flame Graph Generation with eBPF

### CPU Flame Graphs

```bash
# Collect CPU profiles with bpftrace
bpftrace -e '
profile:hz:99
/comm == "nginx"/
{
    @[kstack, ustack] = count();
}
interval:s:30
{
    exit();
}' > /tmp/nginx-stacks.txt

# Convert to flame graph using flamegraph.pl
# https://github.com/brendangregg/FlameGraph
stackcollapse-bpftrace.pl /tmp/nginx-stacks.txt | \
    flamegraph.pl --title "nginx CPU Profile" > /tmp/nginx-cpu.svg
```

### Off-CPU Flame Graphs with BCC

```bash
# BCC's offcputime tool provides ready-made off-CPU profiling
/usr/share/bcc/tools/offcputime -p $(pgrep postgres | head -1) -f 30 > \
    /tmp/postgres-offcpu.txt

# Generate flame graph
stackcollapse.pl /tmp/postgres-offcpu.txt | \
    flamegraph.pl --color=io --title="PostgreSQL Off-CPU" \
    --countname=us > /tmp/postgres-offcpu.svg
```

### Memory Allocation Flame Graphs

```bash
# Track memory allocations with BCC memleak tool
/usr/share/bcc/tools/memleak -p $(pgrep myapp) --combined-only -t 60

# For detailed allocation tracking with stack traces
/usr/share/bcc/tools/memleak -p $(pgrep myapp) -a -t 60 > /tmp/memleak.txt

# Filter for allocations not freed after 60s
grep "bytes in" /tmp/memleak.txt | sort -rn | head -20
```

## Custom Tracepoints

For applications that need stable instrumentation points, USDT (Userspace Statically Defined Tracepoints) provides named probe sites compiled into the binary:

### Adding USDT to Go Applications

Go applications can expose USDT probes using the `github.com/sasha-s/go-deadlock` or custom assembly stubs. A more portable approach uses the `go-usdt` library:

```go
// In Go, use a nop sled that bpftrace/BCC can instrument
// This requires building with CGO and the sys/unix package

package main

/*
#include <sys/sdt.h>

void request_start(int request_id, const char* path) {
    DTRACE_PROBE2(myapp, request__start, request_id, path);
}

void request_done(int request_id, int status_code, long duration_us) {
    DTRACE_PROBE3(myapp, request__done, request_id, status_code, duration_us);
}
*/
import "C"
import "unsafe"

func HandleRequest(id int, path string) {
    cPath := C.CString(path)
    defer C.free(unsafe.Pointer(cPath))
    C.request_start(C.int(id), cPath)

    // ... handle request ...
    statusCode := 200
    durationUs := int64(1500)

    C.request_done(C.int(id), C.int(statusCode), C.long(durationUs))
}
```

Trace these probes with bpftrace:

```bash
# List available probes in the binary
bpftrace -l 'usdt:/path/to/myapp:*'

# Trace request duration
bpftrace -e '
usdt:/path/to/myapp:myapp:request__start
{
    @start[arg0] = nsecs;
}
usdt:/path/to/myapp:myapp:request__done
/@start[arg0]/
{
    $duration_us = (nsecs - @start[arg0]) / 1000;
    @latency_us = hist($duration_us);
    printf("request %d: status=%d duration=%d µs\n",
        arg0, arg1, $duration_us);
    delete(@start[arg0]);
}'
```

## Kernel Function Argument Inspection

### Using BTF for Type-Safe Argument Access

With BTF-enabled kernels (5.2+), bpftrace can access kernel struct fields by name without including kernel headers:

```bash
# Inspect VFS read arguments with BTF
bpftrace -e '
kfunc:vfs_read
{
    printf("file=%s size=%d pos=%d\n",
        str(args->file->f_path.dentry->d_name.name),
        args->count,
        args->pos != 0 ? *args->pos : 0);
}'

# Track scheduler decisions
bpftrace -e '
kfunc:pick_next_task_fair
{
    $task = args->prev;
    if ($task) {
        printf("prev=%s prio=%d\n",
            str($task->comm),
            $task->prio);
    }
}'

# Monitor filesystem dentries being added to cache
bpftrace -e '
kfunc:d_add
{
    printf("dentry: %s parent: %s\n",
        str(args->entry->d_name.name),
        str(args->entry->d_parent->d_name.name));
}'
```

### Kernel Stack Trace on Specific Conditions

```bash
# Show kernel stack when a process enters uninterruptible sleep
bpftrace -e '
tracepoint:sched:sched_switch
/args->prev_state == 2 && comm == "myapp"/
{
    printf("pid=%d entered uninterruptible sleep:\n", pid);
    print(kstack);
}'

# Track when kernel allocates memory for network buffers
bpftrace -e '
kprobe:__alloc_skb
{
    @[kstack(5)] = count();
}
interval:s:10
{
    print(@);
    clear(@);
}'
```

## Production Safety Considerations

### Overhead Assessment

```bash
# Measure overhead of a bpftrace one-liner
# Run baseline
stress-ng --cpu 4 --io 2 --timeout 30s --metrics-brief 2>&1 | grep "bogo ops"

# Run with bpftrace active
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }' &
BPFTRACE_PID=$!
stress-ng --cpu 4 --io 2 --timeout 30s --metrics-brief 2>&1 | grep "bogo ops"
kill $BPFTRACE_PID

# Compare the bogo ops values to estimate overhead
```

### Safe Probe Selection

Not all probes are safe for production use without testing:
- **Tracepoints** (`tracepoint:*`): Stable, low overhead, always safe
- **kfunc** (BTF-based): Stable and type-safe, preferred over kprobe
- **kprobe/kretprobe**: Low overhead but can break on kernel updates; use tracepoints when available
- **uprobe/uretprobe**: Per-instruction overhead; avoid on high-frequency functions
- **profile**: Fixed overhead proportional to sampling rate; 99 Hz is safe

### Verifier Limits

The eBPF verifier has instruction count limits (1 million instructions as of kernel 5.2+). Complex bpftrace scripts that hit these limits will fail to load:

```bash
# Check if a program will load before using it in production
bpftrace --dry-run my-complex-script.bt

# If hitting verifier limits, simplify the script or split into multiple probes
```

## BCC Tool Reference for Production Incidents

```bash
# CPU profiling
/usr/share/bcc/tools/profile -F 99 -p $(pgrep myapp) 30

# File opens with errors
/usr/share/bcc/tools/opensnoop -x

# TCP connection tracking
/usr/share/bcc/tools/tcptracer

# DNS latency
/usr/share/bcc/tools/gethostlatency

# Disk I/O latency percentiles
/usr/share/bcc/tools/biolatency -D

# System call count by type
/usr/share/bcc/tools/syscount -p $(pgrep myapp)

# Function execution count and latency
/usr/share/bcc/tools/funccount 'vfs_*'
/usr/share/bcc/tools/funclatency vfs_read

# Memory leak detection
/usr/share/bcc/tools/memleak -p $(pgrep myapp) -t 120

# Cache hit rate
/usr/share/bcc/tools/cachestat 5

# Lock analysis
/usr/share/bcc/tools/deadlock $(pgrep myapp)
```

## Integration with Observability Platforms

### Exporting bpftrace Data to Prometheus

```python
#!/usr/bin/env python3
# bpftrace-exporter.py
# Run bpftrace and expose metrics via Prometheus HTTP endpoint

import subprocess
import re
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

BPFTRACE_SCRIPT = """
tracepoint:syscalls:sys_enter_read
{
    @read_count[comm] = count();
}
interval:s:1
{
    print(@read_count);
    clear(@read_count);
}
"""

metrics = {}

def run_bpftrace():
    proc = subprocess.Popen(
        ['bpftrace', '-e', BPFTRACE_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True
    )
    for line in proc.stdout:
        # Parse bpftrace map output
        m = re.match(r'\[(.+)\]: (\d+)', line.strip())
        if m:
            comm, count = m.group(1), int(m.group(2))
            metrics[f'ebpf_read_syscalls_total{{comm="{comm}"}}'] = count

class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/metrics':
            self.send_response(404)
            self.end_headers()
            return
        
        body = '\n'.join(f'{k} {v}' for k, v in metrics.items()) + '\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; version=0.0.4')
        self.end_headers()
        self.wfile.write(body.encode())
    
    def log_message(self, format, *args):
        pass

Thread(target=run_bpftrace, daemon=True).start()
HTTPServer(('0.0.0.0', 9090), MetricsHandler).serve_forever()
```

eBPF and bpftrace represent the most powerful non-invasive debugging tools available on Linux. The ability to answer questions like "why is this process spending 40% of its time waiting?" or "which kernel code path is causing these 100ms latency spikes?" without modifying applications or adding observability overhead changes how production incidents are investigated. Building proficiency with these tools before incidents occur pays dividends when production systems exhibit anomalous behavior that logs and metrics alone cannot explain.
