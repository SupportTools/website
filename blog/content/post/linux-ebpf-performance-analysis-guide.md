---
title: "Linux eBPF for Performance Analysis: Tracing System Calls, CPU Profiling, and Network IO"
date: 2028-04-17T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "BCC", "bpftrace", "Performance", "Profiling"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to using eBPF tools — BCC, bpftrace, and libbpf — to trace system calls, profile CPU usage, analyze network I/O latency, and build custom performance instrumentation for production Linux systems."
more_link: "yes"
url: "/linux-ebpf-performance-analysis-guide/"
---

eBPF (extended Berkeley Packet Filter) transforms the Linux kernel into a programmable observability engine. Instead of modifying the kernel or adding instrumentation to application source code, eBPF programs attach to kernel and user-space events at runtime, collecting precisely the data you need with overhead measured in microseconds. This guide covers the toolchain and techniques production engineers use to diagnose latency, CPU hot spots, and network I/O problems in running systems.

<!--more-->

# Linux eBPF for Performance Analysis

## Prerequisites and Kernel Requirements

eBPF requires Linux kernel 4.9+ for basic tracing; most production features require 5.4+. Verify your kernel:

```bash
uname -r
# 6.8.0-40-generic — good

# Check BPF support
grep CONFIG_BPF /boot/config-$(uname -r)
# CONFIG_BPF=y
# CONFIG_BPF_SYSCALL=y
# CONFIG_BPF_JIT=y

# BTF (BPF Type Format) — required for CO-RE programs
ls /sys/kernel/btf/vmlinux
# /sys/kernel/btf/vmlinux
```

## Toolchain Overview

Three layers of abstraction:

```
Application      bpftrace scripts     BCC Python/Lua tools
Library          libbpf (C/Go)        BCC framework
Kernel           eBPF verifier        JIT compiler
```

Install the BCC tools and bpftrace:

```bash
# Ubuntu/Debian
apt-get install -y bpfcc-tools bpftrace linux-headers-$(uname -r)

# RHEL/Fedora
dnf install -y bcc-tools bpftrace kernel-devel

# Verify
bpftrace --version
opensnoop-bpfcc --version
```

## bpftrace: Quick One-Liners

### Trace System Calls by Process

```bash
# Count all syscalls per process for 10 seconds
bpftrace -e '
tracepoint:raw_syscalls:sys_enter
{
    @calls[pid, comm] = count();
}
interval:s:10
{
    print(@calls);
    clear(@calls);
    exit();
}'
```

Output:
```
@calls[1234, nginx]: 24501
@calls[5678, postgres]: 8932
@calls[9012, redis-server]: 4210
```

### Latency Distribution for `read()` Syscalls

```bash
bpftrace -e '
tracepoint:syscalls:sys_enter_read
{
    @start[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_read
/ @start[tid] /
{
    @lat_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
```

Output (logarithmic histogram):
```
@lat_us:
[0]                    45 |@
[1]                  2843 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
[2, 4)               1204 |@@@@@@@@@@@@@
[4, 8)                321 |@@@
[8, 16)               156 |@
[16, 32)               98 |
[32, 64)               12 |
[64, 128)               3 |
[128, 256)              1 |
```

### File Open Tracing

```bash
# Show every file open with process name and path
bpftrace -e '
tracepoint:syscalls:sys_enter_openat
{
    printf("%s %s\n", comm, str(args->filename));
}'
```

### Count TCP Retransmissions

```bash
bpftrace -e '
kprobe:tcp_retransmit_skb
{
    @retransmits[kstack] = count();
}
interval:s:5
{
    print(@retransmits);
    clear(@retransmits);
}'
```

## BCC Tools: Production Workhorses

### opensnoop: File Activity in Real Time

```bash
# Track all file opens, filter to a specific PID
opensnoop-bpfcc -p $(pgrep -f "gunicorn")

# Output:
# PID    COMM               FD ERR PATH
# 12345  gunicorn            5   0 /app/config.yaml
# 12345  gunicorn            6   0 /var/run/secrets/db-password
```

### execsnoop: Process Execution

```bash
# Catch short-lived processes that are hard to catch with ps
execsnoop-bpfcc

# Output:
# PCOMM            PID    PPID   RET ARGS
# sh               15823  15822    0 /bin/sh -c /usr/bin/date
# date             15824  15823    0 /usr/bin/date
```

### biolatency: Block I/O Latency

```bash
# Block device I/O latency histogram, 10 seconds
biolatency-bpfcc 10 1

# Tracing block device I/O... Hit Ctrl-C to end.
#
#      usecs               : count     distribution
#        0 -> 1          : 0        |                                        |
#        2 -> 3          : 0        |                                        |
#        4 -> 7          : 412      |**                                      |
#        8 -> 15         : 2843     |**************                          |
#       16 -> 31         : 5212     |****************************            |
#       32 -> 63         : 4103     |**********************                  |
#       64 -> 127        : 1823     |*********                               |
#      128 -> 255        : 234      |*                                       |
#      256 -> 511        : 43       |                                        |
```

### tcpretrans: TCP Retransmissions

```bash
tcpretrans-bpfcc

# TIME     PID    IP LADDR:LPORT          T> RADDR:RPORT          STATE
# 14:32:01 0      4  10.0.1.5:45231      R> 10.0.1.10:5432       ESTABLISHED
# 14:32:01 0      4  10.0.1.5:45231      R> 10.0.1.10:5432       ESTABLISHED
```

### profile: CPU Flame Graph Data

```bash
# Sample CPU stacks at 99 Hz for 30 seconds, all processes
profile-bpfcc -F 99 30 | flamegraph.pl > cpu-flamegraph.svg

# Sample only a specific PID
profile-bpfcc -F 99 -p $(pgrep -f postgres) 30
```

### tcplife: TCP Connection Lifetimes

```bash
tcplife-bpfcc

# PID   COMM       LADDR           LPORT RADDR           RPORT TX_KB RX_KB MS
# 14522 curl       10.0.1.5        44188 93.184.216.34   80        0     1  141.95
# 14523 postgres   10.0.1.5        5432  10.0.1.3        51234   128   512  2341.2
```

## Custom BCC Python Tools

For investigation beyond the built-in tools, write targeted BCC programs.

### Tracing Slow Database Queries

```python
#!/usr/bin/env python3
# slow-queries.py — trace PostgreSQL queries > threshold
from bcc import BPF, USDT
import ctypes
import sys

THRESHOLD_US = int(sys.argv[1]) if len(sys.argv) > 1 else 10000  # default 10ms

prog = r"""
#include <uapi/linux/ptrace.h>

struct query_event_t {
    u64 latency_us;
    char query[256];
};

BPF_HASH(start, u64, u64);
BPF_PERF_OUTPUT(events);

int query_start(struct pt_regs *ctx) {
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    start.update(&pid_tgid, &ts);
    return 0;
}

int query_done(struct pt_regs *ctx) {
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 *tsp = start.lookup(&pid_tgid);
    if (tsp == NULL) return 0;

    u64 latency_us = (bpf_ktime_get_ns() - *tsp) / 1000;
    start.delete(&pid_tgid);

    if (latency_us < THRESHOLD_US_PLACEHOLDER) return 0;

    struct query_event_t event = {};
    event.latency_us = latency_us;
    bpf_usdt_readarg_p(1, ctx, &event.query, sizeof(event.query));
    events.perf_submit(ctx, &event, sizeof(event));
    return 0;
}
""".replace("THRESHOLD_US_PLACEHOLDER", str(THRESHOLD_US))

# Attach to PostgreSQL USDT probes
# PostgreSQL must be compiled with --enable-dtrace
pg_pid = int(sys.argv[2]) if len(sys.argv) > 2 else None

usdt = USDT(pid=pg_pid) if pg_pid else None
if usdt:
    usdt.enable_probe("query__start", "query_start")
    usdt.enable_probe("query__done", "query_done")
    b = BPF(text=prog, usdt_contexts=[usdt])
else:
    # Fall back to kprobes on exec_simple_query
    b = BPF(text=prog)
    b.attach_kprobe(event="exec_simple_query", fn_name="query_start")
    b.attach_kretprobe(event="exec_simple_query", fn_name="query_done")

class QueryEvent(ctypes.Structure):
    _fields_ = [
        ("latency_us", ctypes.c_uint64),
        ("query", ctypes.c_char * 256),
    ]

def handle_event(cpu, data, size):
    event = ctypes.cast(data, ctypes.POINTER(QueryEvent)).contents
    print(f"SLOW QUERY [{event.latency_us/1000:.1f}ms]: {event.query.decode('utf-8', errors='replace')}")

b["events"].open_perf_buffer(handle_event)
print(f"Tracing queries > {THRESHOLD_US/1000}ms... Ctrl-C to stop")
while True:
    b.perf_buffer_poll()
```

### Network Latency Histogram by Remote IP

```python
#!/usr/bin/env python3
# tcp-latency.py — measure TCP connect latency per remote IP
from bcc import BPF
import socket, struct

prog = r"""
#include <net/sock.h>
#include <net/inet_sock.h>
#include <bcc/proto.h>

struct latency_key_t {
    u32 daddr;
};

BPF_HASH(start, u64, u64);
BPF_HASH(sockets, u64, struct sock *);
BPF_HISTOGRAM(dist, struct latency_key_t);

int kprobe__tcp_v4_connect(struct pt_regs *ctx, struct sock *sk) {
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    start.update(&pid_tgid, &ts);
    sockets.update(&pid_tgid, &sk);
    return 0;
}

int kretprobe__tcp_v4_connect(struct pt_regs *ctx) {
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 *tsp = start.lookup(&pid_tgid);
    struct sock **skpp = sockets.lookup(&pid_tgid);
    if (!tsp || !skpp) return 0;

    struct sock *sk = *skpp;
    struct inet_sock *inet = inet_sk(sk);

    struct latency_key_t key = {};
    bpf_probe_read_kernel(&key.daddr, sizeof(key.daddr), &inet->inet_daddr);

    u64 delta_us = (bpf_ktime_get_ns() - *tsp) / 1000;
    dist.increment(key);  // simplified; use power-of-2 hist in production

    start.delete(&pid_tgid);
    sockets.delete(&pid_tgid);
    return 0;
}
"""

b = BPF(text=prog)
print("Tracing TCP connect latency... Ctrl-C to stop.")

try:
    b.trace_print()
except KeyboardInterrupt:
    for k, v in sorted(b["dist"].items(), key=lambda kv: -kv[1].value):
        ip = socket.inet_ntoa(struct.pack("I", k.daddr))
        print(f"{ip}: {v.value} connections")
```

## libbpf CO-RE Programs

For production observability tools that ship as compiled binaries (no LLVM dependency at runtime), use libbpf with CO-RE (Compile Once, Run Everywhere).

### Project Structure

```
ebpf-tool/
├── main.go
├── bpf/
│   ├── probe.bpf.c     # eBPF kernel-space program
│   └── probe.bpf.h     # shared struct definitions
└── Makefile
```

### Kernel-Space Program (C)

```c
// bpf/probe.bpf.c
//go:build ignore

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_QUERY_LEN 256

struct event {
    __u32  pid;
    __u64  latency_us;
    char   comm[16];
    char   query[MAX_QUERY_LEN];
};

// Ring buffer for efficient event delivery to user space
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);  // 256KB
} events SEC(".maps");

// Hash map: tid → start timestamp
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u64);
    __type(value, __u64);
} start_times SEC(".maps");

SEC("tracepoint/syscalls/sys_enter_read")
int handle_sys_enter_read(struct trace_event_raw_sys_enter *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&start_times, &pid_tgid, &ts, BPF_ANY);
    return 0;
}

SEC("tracepoint/syscalls/sys_exit_read")
int handle_sys_exit_read(struct trace_event_raw_sys_exit *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 *tsp = bpf_map_lookup_elem(&start_times, &pid_tgid);
    if (!tsp) return 0;

    __u64 latency_us = (bpf_ktime_get_ns() - *tsp) / 1000;
    bpf_map_delete_elem(&start_times, &pid_tgid);

    // Only report reads > 1ms
    if (latency_us < 1000) return 0;

    struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) return 0;

    e->pid = pid_tgid >> 32;
    e->latency_us = latency_us;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));

    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### User-Space Go Program

```go
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall" Probe ./bpf/probe.bpf.c
package main

import (
    "bytes"
    "encoding/binary"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
    "github.com/cilium/ebpf/rlimit"
)

type Event struct {
    PID       uint32
    LatencyUS uint64
    Comm      [16]byte
    Query     [256]byte
}

func main() {
    // Remove memlock limit for BPF maps
    if err := rlimit.RemoveMemlock(); err != nil {
        log.Fatalf("removing memlock: %v", err)
    }

    // Load pre-compiled eBPF programs
    objs := ProbeObjects{}
    if err := LoadProbeObjects(&objs, nil); err != nil {
        log.Fatalf("loading BPF objects: %v", err)
    }
    defer objs.Close()

    // Attach to tracepoints
    tpEnter, err := link.Tracepoint("syscalls", "sys_enter_read",
        objs.HandleSysEnterRead, nil)
    if err != nil {
        log.Fatalf("attaching enter tracepoint: %v", err)
    }
    defer tpEnter.Close()

    tpExit, err := link.Tracepoint("syscalls", "sys_exit_read",
        objs.HandleSysExitRead, nil)
    if err != nil {
        log.Fatalf("attaching exit tracepoint: %v", err)
    }
    defer tpExit.Close()

    // Open ring buffer reader
    rd, err := ringbuf.NewReader(objs.Events)
    if err != nil {
        log.Fatalf("opening ring buffer: %v", err)
    }
    defer rd.Close()

    // Graceful shutdown
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
    go func() {
        <-sig
        rd.Close()
    }()

    fmt.Println("Tracing slow read() syscalls (> 1ms)...")
    fmt.Printf("%-8s %-16s %-10s\n", "PID", "COMM", "LATENCY(ms)")

    var event Event
    for {
        record, err := rd.Read()
        if err != nil {
            if errors.Is(err, ringbuf.ErrClosed) {
                return
            }
            log.Printf("ring buffer read error: %v", err)
            continue
        }

        if err := binary.Read(bytes.NewReader(record.RawSample),
            binary.LittleEndian, &event); err != nil {
            log.Printf("parsing event: %v", err)
            continue
        }

        comm := nullTerminatedString(event.Comm[:])
        fmt.Printf("%-8d %-16s %-10.2f\n",
            event.PID, comm, float64(event.LatencyUS)/1000.0)
    }
}

func nullTerminatedString(b []byte) string {
    n := bytes.IndexByte(b, 0)
    if n < 0 {
        return string(b)
    }
    return string(b[:n])
}
```

## CPU Flame Graphs with eBPF

```bash
# Sample kernel and user stacks at 99 Hz for 30 seconds for a specific PID
PID=$(pgrep -f "java.*MyApp")
profile-bpfcc -F 99 -p $PID 30 -f > /tmp/stacks.txt

# Generate SVG flame graph using Brendan Gregg's FlameGraph
git clone https://github.com/brendangregg/FlameGraph /opt/flamegraph
/opt/flamegraph/flamegraph.pl /tmp/stacks.txt > /tmp/cpu-flamegraph.svg

# Open in browser
python3 -m http.server 8080 --directory /tmp &
echo "Open http://localhost:8080/cpu-flamegraph.svg"
```

For Go applications, eBPF-based profiling captures both Go runtime frames and cgo/syscall frames — something that `pprof` alone misses.

## Network I/O Analysis

### TCP Bandwidth per Process

```bash
bpftrace -e '
kprobe:tcp_sendmsg
{
    @send_bytes[pid, comm] = sum(arg2);
}
kprobe:tcp_recvmsg
{
    @recv_bytes[pid, comm] = sum(arg2);
}
interval:s:5
{
    printf("=== Top TCP senders ===\n");
    print(@send_bytes);
    printf("=== Top TCP receivers ===\n");
    print(@recv_bytes);
    clear(@send_bytes);
    clear(@recv_bytes);
}'
```

### DNS Query Latency

```bash
bpftrace -e '
// Hook getaddrinfo at the libc level via uprobe
uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo
{
    @start[tid] = nsecs;
    @hostname[tid] = str(arg0);
}
uretprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo
/ @start[tid] /
{
    $latency = (nsecs - @start[tid]) / 1000000;
    printf("%-30s %dms\n", @hostname[tid], $latency);
    delete(@start[tid]);
    delete(@hostname[tid]);
}'
```

### Tracking Socket Errors

```bash
bpftrace -e '
kprobe:tcp_done
{
    $sk = (struct sock *)arg0;
    if ($sk->sk_err != 0) {
        printf("TCP error pid=%d comm=%s err=%d state=%d\n",
            pid, comm, $sk->sk_err, $sk->sk_state);
    }
}'
```

## Off-CPU Analysis

Off-CPU time (time a thread is blocked waiting for I/O, locks, or sleep) is often the root cause of tail latency.

```bash
# Measure off-CPU time per stack for postgres processes
offcputime-bpfcc -p $(pgrep postgres | head -1) 30 | \
  /opt/flamegraph/flamegraph.pl \
  --title="Off-CPU Flame Graph" \
  --color=io > /tmp/offcpu.svg
```

## Kubernetes Pod Tracing

To trace a containerized process, find the PID in the host namespace:

```bash
# Get the container's PID1 in the host namespace
CONTAINER_ID=$(kubectl get pod my-app-7d4b8 -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d/ -f3)
HOST_PID=$(docker inspect --format '{{.State.Pid}}' "$CONTAINER_ID")
# or with containerd:
# crictl inspect $CONTAINER_ID | jq '.info.pid'

# Trace the container process and all its children
bpftrace -e "tracepoint:syscalls:sys_enter_write /pid == $HOST_PID || (pid >= $HOST_PID && pid < $HOST_PID + 100)/ { @[comm] = count(); }"
```

## Performance Impact of eBPF

eBPF programs impose minimal overhead, but there are limits:

- **kprobes** add ~1-5 ns per invocation (JIT-compiled). High-frequency paths (e.g., `tcp_sendmsg` on 100Gbps links) can add measurable overhead.
- **Tracepoints** are cheaper than kprobes because the instrumentation site is built into the kernel.
- **Ring buffers** (`BPF_MAP_TYPE_RINGBUF`) are more efficient than perf buffers for high-event-rate tools.
- **Sampling** (profile at 99 Hz) adds less than 1% CPU overhead for most workloads.

Benchmark overhead before enabling tracing permanently:

```bash
# Baseline throughput
sysbench --test=fileio --file-test-mode=rndrw run

# With tracing enabled
opensnoop-bpfcc &
sysbench --test=fileio --file-test-mode=rndrw run
kill %1
```

## Production Deployment with Continuous Profiling

Integrate eBPF profiling with Pyroscope for always-on production profiling:

```bash
# Deploy Pyroscope eBPF agent as a DaemonSet
helm repo add pyroscope-io https://pyroscope-io.github.io/helm-chart
helm install pyroscope pyroscope-io/pyroscope \
  --set ebpfSpy.enabled=true \
  --set ebpfSpy.namespace=production \
  --set server.url=https://pyroscope.internal.example.com \
  --namespace monitoring
```

The eBPF spy agent attaches to all processes in the specified namespace and ships flame graph data to the Pyroscope server, enabling continuous CPU profiling with zero application code changes.

## Quick-Reference Cheatsheet

```bash
# Trace file opens for a process
opensnoop-bpfcc -p PID

# I/O latency histogram
biolatency-bpfcc -D 10

# TCP connection lifetimes
tcplife-bpfcc

# Block I/O by process
biotop-bpfcc

# Network bandwidth by process
nethogs (alternative: nettop-bpfcc)

# CPU flame graph
profile-bpfcc -F 99 -p PID 30 | flamegraph.pl > out.svg

# Off-CPU flame graph
offcputime-bpfcc -p PID 30 | flamegraph.pl > offcpu.svg

# All syscalls by process
syscount-bpfcc -p PID

# Trace slow file reads
fileslower-bpfcc 10   # >10ms

# Trace slow block I/O
bioslower-bpfcc 10    # >10ms

# Cache hit ratio
cachestat-bpfcc 1     # 1-second intervals
```

## Summary

eBPF delivers production-safe performance observability at kernel depth. The toolkit progression is:

1. **Start with bpftrace one-liners** for ad-hoc investigation — they require no compilation and produce results in seconds.
2. **Use BCC tools** for more structured analysis of I/O, TCP, CPU, and syscall patterns.
3. **Write custom BCC Python programs** when you need domain-specific tracing (database queries, RPC calls, specific application behavior).
4. **Build libbpf CO-RE binaries** for tools that ship to production without requiring LLVM or BCC at runtime.
5. **Integrate with continuous profiling** (Pyroscope, Parca) for always-on visibility into production CPU profiles.

The combination of these tools eliminates the need for application-level instrumentation for most performance investigations, allowing you to diagnose production issues on live systems without restarts or code changes.
