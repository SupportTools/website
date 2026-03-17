---
title: "BPF/eBPF for Production Performance Tracing: bpftrace, libbpf, and BCC Tools"
date: 2028-05-17T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "BPF", "Performance", "Tracing", "bpftrace", "BCC", "Observability"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to BPF/eBPF performance tracing for production systems: bpftrace one-liners, libbpf programs, BCC tools, and custom probes for CPU, memory, network, and disk I/O analysis."
more_link: "yes"
url: "/linux-bpf-tracing-performance-guide/"
---

Extended Berkeley Packet Filter (eBPF) has transformed Linux performance analysis. Where traditional tracing tools required kernel module compilation, reboots, or approximations, eBPF programs run safely inside the kernel with full visibility into every system call, function, and hardware event. This guide covers practical eBPF tooling for production performance analysis: bpftrace for rapid investigation, BCC for structured analysis tools, and custom libbpf programs for permanent instrumentation.

<!--more-->

## eBPF Architecture Overview

eBPF programs are small, verified programs that run in a sandboxed virtual machine inside the Linux kernel. The kernel verifier ensures programs cannot crash the kernel, loop indefinitely, or access arbitrary memory. Programs attach to kernel hooks:

- **kprobes/kretprobes**: Dynamic instrumentation of any kernel function entry/exit
- **uprobes/uretprobes**: User-space function tracing without modifying binaries
- **tracepoints**: Stable, versioned hooks at fixed kernel locations
- **perf events**: Hardware counter events (CPU cycles, cache misses, etc.)
- **XDP/TC**: Network packet processing at driver and traffic control layers
- **LSM hooks**: Linux Security Module hooks for security enforcement

eBPF programs communicate with user space through **maps** - key-value stores shared between kernel and user space.

## Prerequisites and Kernel Requirements

```bash
# Check kernel version (eBPF requires 4.4+, most features need 5.x)
uname -r
# 6.1.0-21-amd64

# Check eBPF capabilities
cat /proc/kallsyms | grep bpf | head -5

# Check BTF (BPF Type Format) - required for CO-RE programs
ls /sys/kernel/btf/vmlinux
# /sys/kernel/btf/vmlinux

# Check available tracepoints
ls /sys/kernel/debug/tracing/events/ | head -20

# Verify bpf syscall is available
strace -e bpf ls 2>&1 | head -3
```

## bpftrace: Interactive Tracing

bpftrace is the fastest path to kernel insights. Its awk-like syntax enables one-liners and short scripts without compilation.

### Installation

```bash
# Ubuntu/Debian
apt-get install -y bpftrace

# RHEL/CentOS
dnf install -y bpftrace

# From source with latest features
git clone https://github.com/bpftrace/bpftrace
cd bpftrace
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
sudo cmake --install build
```

### CPU Analysis

**Identify functions with highest on-CPU time:**

```bash
# CPU flame graph data - sample kernel+user stacks at 99Hz for 30 seconds
bpftrace -e '
profile:hz:99
/pid > 0/
{
    @[ustack, kstack, comm] = count();
}
interval:s:30 { exit(); }
' | flamegraph.pl > /tmp/cpu-flamegraph.svg
```

**Find hot kernel functions:**

```bash
# Count kernel function calls - top functions called over 5 seconds
bpftrace -e '
kprobe:* /comm == "nginx"/ { @[func] = count(); }
interval:s:5 { print(@); clear(@); }
'
```

**Off-CPU analysis - what blocks threads:**

```bash
bpftrace -e '
tracepoint:sched:sched_switch
/args->prev_state == 1 || args->prev_state == 2/
{
    @start[args->prev_pid] = nsecs;
}

tracepoint:sched:sched_switch
/@start[args->next_pid]/
{
    @offcpu_us[args->next_comm, kstack] =
        hist((nsecs - @start[args->next_pid]) / 1000);
    delete(@start[args->next_pid]);
}
' 2>/dev/null
```

**Scheduler run queue latency:**

```bash
bpftrace -e '
tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new
{
    @queuetime[args->pid] = nsecs;
}

tracepoint:sched:sched_switch
/@queuetime[args->next_pid]/
{
    @runqlat = hist((nsecs - @queuetime[args->next_pid]) / 1000);
    delete(@queuetime[args->next_pid]);
}
'
```

### Memory Analysis

**Trace malloc calls by size:**

```bash
# Trace libc malloc with size histogram for a specific process
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc
/pid == $1/
{
    @[ustack] = hist(arg0);
}
' -- 12345
```

**Track page faults:**

```bash
# Minor and major page fault rates per process
bpftrace -e '
software:faults:1
{
    @[comm, pid] = count();
}
interval:s:5
{
    print(@);
    clear(@);
    exit();
}
'
```

**OOM killer invocations:**

```bash
bpftrace -e '
kprobe:oom_kill_process
{
    printf("OOM kill: %s (pid %d) by %s (pid %d)\n",
        str(((struct task_struct *)arg1)->comm),
        ((struct task_struct *)arg1)->pid,
        comm, pid);
}'
```

**Memory allocations without free (leak detection sketch):**

```bash
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc
{
    @allocs[ustack] = sum(arg0);
}

uprobe:/lib/x86_64-linux-gnu/libc.so.6:free
{
    // Track frees - actual leak detection needs address tracking
    @frees = count();
}

interval:s:60
{
    print(@allocs);
    exit();
}
'
```

### Network Analysis

**TCP connection latency:**

```bash
bpftrace -e '
kprobe:tcp_v4_connect
{
    @start[tid] = nsecs;
}

kretprobe:tcp_v4_connect
/@start[tid]/
{
    @tcp_connect_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}
'
```

**Track new TCP connections:**

```bash
bpftrace -e '
tracepoint:sock:inet_sock_set_state
/args->newstate == 1/
{
    printf("%-8s %-16s %d -> ", comm, ntop(args->saddr), args->sport);
    printf("%s:%d\n", ntop(args->daddr), args->dport);
}
'
```

**DNS query latency:**

```bash
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo
{
    @start[tid] = nsecs;
    @hostname[tid] = str(arg0);
}

uretprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo
/@start[tid]/
{
    @dns_latency_us[@hostname[tid]] = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
    delete(@hostname[tid]);
}
'
```

**Bytes sent/received per process:**

```bash
bpftrace -e '
kprobe:tcp_sendmsg { @send_bytes[comm] = sum(arg2); }
kprobe:tcp_recvmsg { @recv_bytes[comm] = sum(arg2); }
interval:s:10 {
    print(@send_bytes);
    print(@recv_bytes);
    clear(@send_bytes);
    clear(@recv_bytes);
}
'
```

### Disk I/O Analysis

**Block I/O latency histogram:**

```bash
bpftrace -e '
tracepoint:block:block_io_start
{
    @start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_io_done
/@start[args->dev, args->sector]/
{
    @io_latency_us[args->rwbs] =
        hist((nsecs - @start[args->dev, args->sector]) / 1000);
    delete(@start[args->dev, args->sector]);
}
'
```

**Top files by read bytes:**

```bash
bpftrace -e '
tracepoint:syscalls:sys_exit_read
/args->ret > 0/
{
    @[str(((struct task_struct *)curtask)->files->fdt->fd[args->fd]->f_path.dentry->d_name.name)] +=
        args->ret;
}
interval:s:5 { print(@); exit(); }
'
```

**fsync latency by application:**

```bash
bpftrace -e '
tracepoint:syscalls:sys_enter_fsync,
tracepoint:syscalls:sys_enter_fdatasync
{
    @start[tid] = nsecs;
    @comm[tid] = comm;
}

tracepoint:syscalls:sys_exit_fsync,
tracepoint:syscalls:sys_exit_fdatasync
/@start[tid]/
{
    @fsync_us[@comm[tid]] = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
    delete(@comm[tid]);
}
'
```

## BCC Tools: Pre-Built Analysis Programs

BCC (BPF Compiler Collection) includes 100+ production-ready tools:

```bash
# Install BCC tools
apt-get install -y bpfcc-tools linux-headers-$(uname -r)
# or
dnf install -y bcc-tools kernel-devel
```

### Essential BCC Tools for Production

**execsnoop - trace new processes:**

```bash
# Monitor all exec calls (detect unexpected process spawning)
/usr/share/bcc/tools/execsnoop -T
# TIME     PCOMM            PID    PPID   RET ARGS
# 10:23:01 bash             12345  1      0   bash -c "curl http://..."
# 10:23:01 curl             12346  12345  0   curl http://169.254.169.254/
```

**opensnoop - trace file opens:**

```bash
# Find what files a process opens
/usr/share/bcc/tools/opensnoop -p 9876
# PID    COMM               FD ERR PATH
# 9876   java               23   0 /proc/self/status
# 9876   java               23   0 /etc/timezone
```

**biolatency - block I/O latency distribution:**

```bash
/usr/share/bcc/tools/biolatency -D 10
# Tracing block device I/O... Hit Ctrl-C to end.
#
# disk = 'nvme0n1'
#      usecs               : count     distribution
#        0 -> 1          : 523      |**                                      |
#        2 -> 3          : 4821     |**********************                  |
#        4 -> 7          : 8432     |****************************************|
#        8 -> 15         : 3241     |***************                         |
#       16 -> 31         : 612      |***                                     |
#       32 -> 63         : 82       |                                        |
#       64 -> 127        : 12       |                                        |
#      128 -> 255        : 3        |                                        |
```

**tcpretrans - track TCP retransmissions:**

```bash
/usr/share/bcc/tools/tcpretrans
# TIME     PID    IP LADDR:LPORT          T> RADDR:RPORT          STATE
# 10:25:11 0      4  10.0.1.45:49231     R> 10.0.2.100:8080      ESTABLISHED
# 10:25:11 0      4  10.0.1.45:49231     R> 10.0.2.100:8080      ESTABLISHED
```

**runqlat - CPU scheduler run queue latency:**

```bash
/usr/share/bcc/tools/runqlat 5 1
# Tracing run queue latency... Hit Ctrl-C to end.
#      usecs               : count     distribution
#        0 -> 1          : 91803    |****************************************|
#        2 -> 3          : 23489    |**********                              |
#        4 -> 7          : 2143     |                                        |
#        8 -> 15         : 342      |                                        |
#       16 -> 31         : 98       |                                        |
#       32 -> 63         : 23       |                                        |
```

**funcslower - trace slow kernel/user functions:**

```bash
# Show kernel functions taking >1ms
/usr/share/bcc/tools/funcslower -K 1000 vfs_read
```

**profile - CPU profiler:**

```bash
# Profile all CPUs for 10 seconds, show top stacks
/usr/share/bcc/tools/profile -F 99 10
```

## Custom libbpf Programs

For permanent instrumentation, write programs using libbpf and CO-RE (Compile Once, Run Everywhere):

### HTTP Request Latency Tracker

```c
// http_latency.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_ENTRIES 10240

struct event {
    __u32 pid;
    __u64 latency_ns;
    char comm[16];
    char path[64];
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, MAX_ENTRIES);
    __type(key, __u64);          // tid
    __type(value, __u64);        // start time
} start_time SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24); // 16MB ring buffer
} events SEC(".maps");

// Histogram for latency distribution
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 64);
    __type(key, __u32);
    __type(value, __u64);
} latency_hist SEC(".maps");

SEC("uprobe/./libssl.so:SSL_read")
int BPF_UPROBE(ssl_read_entry) {
    __u64 tid = bpf_get_current_pid_tgid();
    __u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&start_time, &tid, &ts, BPF_ANY);
    return 0;
}

SEC("uretprobe/./libssl.so:SSL_read")
int BPF_URETPROBE(ssl_read_return) {
    __u64 tid = bpf_get_current_pid_tgid();
    __u64 *start = bpf_map_lookup_elem(&start_time, &tid);
    if (!start)
        return 0;

    __u64 delta = bpf_ktime_get_ns() - *start;
    bpf_map_delete_elem(&start_time, &tid);

    // Update histogram (log2 buckets)
    __u32 bucket = 0;
    __u64 val = delta / 1000; // microseconds
    while (val > 1 && bucket < 63) {
        val >>= 1;
        bucket++;
    }
    __u64 *count = bpf_map_lookup_elem(&latency_hist, &bucket);
    if (count)
        __sync_fetch_and_add(count, 1);

    // Submit event to ring buffer if >1ms
    if (delta > 1000000) {
        struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
        if (e) {
            e->pid = bpf_get_current_pid_tgid() >> 32;
            e->latency_ns = delta;
            bpf_get_current_comm(&e->comm, sizeof(e->comm));
            bpf_ringbuf_submit(e, 0);
        }
    }

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Build with libbpf-bootstrap

```bash
# Clone libbpf-bootstrap for scaffold
git clone --recursive https://github.com/libbpf/libbpf-bootstrap

# Generate vmlinux.h for the current kernel
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h

# Compile
clang -g -O2 -target bpf \
  -D__TARGET_ARCH_x86 \
  -I/usr/include/x86_64-linux-gnu \
  -c http_latency.bpf.c \
  -o http_latency.bpf.o

# Generate skeleton header
bpftool gen skeleton http_latency.bpf.o > http_latency.skel.h
```

```c
// http_latency.c - userspace loader
#include <stdio.h>
#include <signal.h>
#include <unistd.h>
#include <bpf/libbpf.h>
#include "http_latency.skel.h"

static volatile bool running = true;

static void sig_handler(int sig) {
    running = false;
}

static int handle_event(void *ctx, void *data, size_t size) {
    struct event *e = data;
    printf("SLOW: pid=%d comm=%s latency=%.3fms\n",
           e->pid, e->comm, e->latency_ns / 1e6);
    return 0;
}

int main(int argc, char **argv) {
    struct http_latency_bpf *skel;
    struct ring_buffer *rb;
    int err;

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    skel = http_latency_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open BPF skeleton\n");
        return 1;
    }

    // Attach to specific PID if provided
    if (argc > 1) {
        LIBBPF_OPTS(bpf_uprobe_opts, opts,
            .retprobe = false);
        // Attach to process
    }

    err = http_latency_bpf__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach BPF: %d\n", err);
        goto cleanup;
    }

    rb = ring_buffer__new(
        bpf_map__fd(skel->maps.events),
        handle_event, NULL, NULL);

    printf("Tracing HTTP latency... Ctrl-C to stop.\n");

    while (running) {
        err = ring_buffer__poll(rb, 100);
        if (err < 0 && err != -EINTR) {
            fprintf(stderr, "Error polling ring buffer: %d\n", err);
            break;
        }
    }

cleanup:
    ring_buffer__free(rb);
    http_latency_bpf__destroy(skel);
    return err < 0 ? 1 : 0;
}
```

## Application-Specific Probes

### Java/JVM Tracing

Java applications with JVM support can be traced via USDT (User Statically-Defined Tracing) probes or uprobes:

```bash
# List available JVM USDT probes
bpftrace -l 'usdt:/usr/lib/jvm/java-17-openjdk/bin/java:*'

# Trace GC pause times
bpftrace -e '
usdt:/usr/lib/jvm/java-17-openjdk/bin/java:hotspot:gc__begin
{
    @start[tid] = nsecs;
}

usdt:/usr/lib/jvm/java-17-openjdk/bin/java:hotspot:gc__end
/@start[tid]/
{
    @gc_pause_ms = hist((nsecs - @start[tid]) / 1e6);
    delete(@start[tid]);
}
'
```

### Python Tracing

```bash
# Trace Python function calls (requires CPython with USDT)
bpftrace -e '
usdt:/usr/bin/python3:python:function__entry
{
    printf("ENTER: %s:%d %s\n", str(arg0), arg2, str(arg1));
}
' -p $(pgrep -f "python3 myapp.py")
```

### Go Application Tracing

Go lacks USDT probes, but function entry/exit via uprobes works:

```bash
# Trace Go HTTP handler function
bpftrace -e '
uprobe:./myservice:"net/http.(*ServeMux).ServeHTTP"
{
    @start[tid] = nsecs;
}

uretprobe:./myservice:"net/http.(*ServeMux).ServeHTTP"
/@start[tid]/
{
    @latency = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}
'
```

## Kubernetes Container Tracing

eBPF programs in Kubernetes must account for container namespaces:

```bash
# Get container PID from container name
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)

# Trace system calls for container processes
bpftrace -e '
tracepoint:syscalls:sys_enter_execve
/cgroup == cgroupid("/sys/fs/cgroup/system.slice/docker-"$1".scope")/
{
    printf("%s: %s\n", comm, str(args->filename));
}
' -- $(docker inspect --format '{{.Id}}' my-container)
```

Using cgroup-aware tracing:

```bash
# bpftrace can filter by cgroup ID
bpftrace -e '
tracepoint:syscalls:sys_enter_openat
/cgroup == cgroupid("/sys/fs/cgroup/kubepods/burstable/pod<uuid>/<container-id>")/
{
    printf("OPEN: %s %s\n", comm, str(args->filename));
}'
```

## Performance Overhead

eBPF programs have measurable overhead. Guidelines for production:

| Tool/Pattern | Overhead | Notes |
|-------------|----------|-------|
| bpftrace one-liner (tracepoint) | <1% CPU | Suitable for production |
| bpftrace (kprobe, hot path) | 1-5% CPU | Short-duration only |
| profile at 99Hz | ~1% CPU | Safe for production |
| profile at 999Hz | ~5% CPU | Use sparingly |
| uprobe on hot path | 5-30% CPU | Avoid on high-frequency functions |
| ring buffer flush | Negligible | Preferred over perf buffer |

```bash
# Measure overhead of a specific bpftrace script
perf stat -p $(pgrep -f "my-app") sleep 5 &
bpftrace my_trace.bt &
wait
```

## Packaging for Production: bpftrace as a Service

```bash
# /etc/systemd/system/bpftrace-latency-monitor.service
[Unit]
Description=BPFTrace Latency Monitor
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/bpftrace /opt/tracing/latency-monitor.bt
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
# /opt/tracing/latency-monitor.bt
#!/usr/bin/env bpftrace

// Continuous latency monitoring - output to stdout for log collection

tracepoint:block:block_io_start
{
    @start[args->dev, args->sector] = nsecs;
}

tracepoint:block:block_io_done
/@start[args->dev, args->sector]/
{
    $lat_us = (nsecs - @start[args->dev, args->sector]) / 1000;
    if ($lat_us > 100000) {  // Alert on >100ms
        printf("SLOW_IO: dev=%d:%d rw=%s lat_us=%d\n",
            args->dev >> 20, args->dev & 0xfffff,
            args->rwbs, $lat_us);
    }
    @io_lat_us = hist($lat_us);
    delete(@start[args->dev, args->sector]);
}

interval:s:60 {
    print(@io_lat_us);
    clear(@io_lat_us);
}
```

## Troubleshooting with eBPF

### Diagnosing MySQL Query Latency

```bash
bpftrace -e '
uprobe:/usr/sbin/mysqld:*dispatch_command*
{
    @start[tid] = nsecs;
}

uretprobe:/usr/sbin/mysqld:*dispatch_command*
/@start[tid]/
{
    $lat = (nsecs - @start[tid]) / 1e6;
    if ($lat > 100) {
        printf("SLOW QUERY: %.2fms\n", $lat);
    }
    @query_lat_ms = hist($lat);
    delete(@start[tid]);
}
'
```

### Finding Lock Contention

```bash
bpftrace -e '
kprobe:mutex_lock_slowpath
{
    @start[tid] = nsecs;
    @caller[tid] = kstack;
}

kretprobe:mutex_lock_slowpath
/@start[tid]/
{
    @lock_wait_us[@caller[tid]] = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
    delete(@caller[tid]);
}
' 2>/dev/null
```

### Detecting Connection Pool Exhaustion

```bash
# Trace connect() calls that block or fail
bpftrace -e '
tracepoint:syscalls:sys_enter_connect
{
    @start[tid] = nsecs;
    @comm[tid] = comm;
}

tracepoint:syscalls:sys_exit_connect
/@start[tid]/
{
    $lat = (nsecs - @start[tid]) / 1e6;
    if ($lat > 1000 || args->ret != 0) {
        printf("CONNECT: comm=%s lat=%.2fms ret=%d\n",
            str(@comm[tid]), $lat, args->ret);
    }
    delete(@start[tid]);
    delete(@comm[tid]);
}
'
```

## Summary

eBPF represents a step change in production observability. bpftrace provides interactive kernel exploration with a fraction of the setup time required by traditional tools. BCC tools give immediate access to 100+ pre-built analyzers covering every major subsystem. Custom libbpf programs enable permanent, low-overhead instrumentation that ships as part of production tooling. The key to effective eBPF use in production is understanding the overhead model - tracepoints and ring buffers are cheap; hot-path uprobes are expensive. Used correctly, eBPF programs answer performance questions that were previously unanswerable without kernel rebuilds or specialized hardware.
