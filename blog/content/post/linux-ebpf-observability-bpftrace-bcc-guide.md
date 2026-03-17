---
title: "Linux eBPF Observability: bpftrace Programs, BCC Tools, and Custom Kernel Instrumentation"
date: 2028-07-16T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "bpftrace", "BCC", "Observability", "Performance"]
categories:
- Linux
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux eBPF observability covering bpftrace one-liners and programs, BCC Python tools, Go eBPF with cilium/ebpf, kernel tracepoints, uprobes, and production performance analysis workflows."
more_link: "yes"
url: "/linux-ebpf-observability-bpftrace-bcc-guide/"
---

eBPF has fundamentally changed how we observe Linux systems. Instead of modifying the kernel or relying on coarse-grained metrics, eBPF programs attach to any kernel or userspace function, run at native speed, and report structured data without rebooting or risking system stability. This guide covers the practical tools and programming patterns that production engineers use daily — from quick bpftrace one-liners to production-grade Go eBPF programs.

<!--more-->

# Linux eBPF Observability: bpftrace Programs, BCC Tools, and Custom Kernel Instrumentation

## Section 1: eBPF Architecture and Prerequisites

### How eBPF Works

eBPF programs are event-driven: they attach to probe points and execute when that point fires. The verifier ensures the program is safe (no unbounded loops, no invalid memory access) before loading it into the kernel JIT compiler.

```
User Space                         Kernel Space
──────────                         ────────────
bpftrace script  ─── BPF bytecode ──► Verifier
BCC Python tool  ─── BPF bytecode ──► JIT Compile ──► Attach to probe
Go ebpf program  ─── BPF bytecode ──► Run on event ──► Write to map
                                      Read maps ◄─── Maps (ringbuf, hash, array)
```

### Probe Types

| Probe Type | Target | Example |
|------------|--------|---------|
| kprobe | Kernel function entry | `kprobe:tcp_connect` |
| kretprobe | Kernel function return | `kretprobe:tcp_connect` |
| tracepoint | Stable kernel tracepoints | `tracepoint:syscalls:sys_enter_open` |
| uprobe | Userspace function entry | `uprobe:/usr/bin/nginx:ngx_http_request_handler` |
| uretprobe | Userspace function return | `uretprobe:/lib/libssl.so:SSL_read` |
| USDT | Userspace static tracepoints | `usdt:/usr/sbin/mysqld:query__start` |
| perf_event | Hardware/software perf counters | `hardware:cache-misses:1000000` |
| socket filter | Network packet processing | raw socket programs |
| XDP | Network driver level | packet filtering/forwarding |

### Installation

```bash
# Ubuntu 22.04+
sudo apt-get install -y bpftrace bpfcc-tools linux-headers-$(uname -r) \
  python3-bpfcc libbpf-dev clang llvm

# Verify kernel support
bpftrace --info 2>&1 | grep -E "features|map types"

# Check kernel config
zcat /proc/config.gz 2>/dev/null | grep -E "CONFIG_BPF|CONFIG_FTRACE" | head -20

# Minimum kernel version: 5.8+ recommended, 5.15+ for full BTF support
uname -r

# Install Go eBPF library
go get github.com/cilium/ebpf@latest
```

---

## Section 2: bpftrace — The Swiss Army Knife

### Essential One-Liners

```bash
# Files opened by process name
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args->filename)); }'

# Count syscalls by process
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Top 10 syscalls by name
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[ksym(*(uint64*)curtask->mm->exe_file + 0), args->id] = count(); }
END { print(@, 10); }'

# TCP connections by destination port
bpftrace -e 'kprobe:tcp_connect { $sk = (struct sock *)arg0;
  printf("%s → %s:%d\n", comm,
    ntop(AF_INET, $sk->__sk_common.skc_daddr),
    $sk->__sk_common.skc_dport); }'

# Process CPU time (on-CPU sampling)
bpftrace -e 'profile:hz:99 { @cpu[comm, kstack] = count(); }'

# Block I/O latency distribution
bpftrace -e '
tracepoint:block:block_rq_issue { @start[args->dev, args->sector] = nsecs; }
tracepoint:block:block_rq_complete {
  $key = (uint64)args->dev * 1000000 + args->sector;
  @usecs = hist((nsecs - @start[args->dev, args->sector]) / 1000);
  delete(@start[args->dev, args->sector]);
}'

# Network packet size distribution
bpftrace -e 'kprobe:ip_output { @bytes = hist(skb->len); }'

# Page fault frequency by process
bpftrace -e 'software:page-faults:1 { @[comm, pid] = count(); }'

# File descriptor leaks — processes with most open files
bpftrace -e 'kretprobe:__alloc_fd { @fds[comm, pid] = count(); } END { print(@fds, 10); }'

# Slow kernel functions (>1ms)
bpftrace -e '
kprobe:* { @start[tid] = nsecs; @fn[tid] = func; }
kretprobe:* /nsecs - @start[tid] > 1000000/ {
  printf("SLOW %s took %d ms\n", @fn[tid], (nsecs - @start[tid]) / 1000000);
  delete(@start[tid]); delete(@fn[tid]);
}'
```

### bpftrace Programs — Beyond One-Liners

#### TCP Retransmit Tracker

```bash
#!/usr/bin/env bpftrace
# tcp_retransmit.bt — track TCP retransmits with connection details

#include <net/sock.h>

BEGIN {
  printf("%-25s %-20s %-6s %-6s %s\n",
    "TIME", "LADDR:PORT", "RADDR", "RPORT", "COMM");
}

kprobe:tcp_retransmit_skb {
  $sk = (struct sock *)arg0;
  $lport = $sk->__sk_common.skc_num;
  $dport = $sk->__sk_common.skc_dport;
  $dport = ($dport >> 8) | (($dport & 0xff) << 8);  // htons

  printf("%-25s %-20s %-6d %-6d %s\n",
    strftime("%H:%M:%S.%f", nsecs),
    strcat(ntop(AF_INET, $sk->__sk_common.skc_rcv_saddr), strcat(":", itoa($lport))),
    ntop(AF_INET, $sk->__sk_common.skc_daddr),
    $dport,
    comm);

  @retransmits[comm, ntop(AF_INET, $sk->__sk_common.skc_daddr)] = count();
}

END {
  printf("\nRetransmits by process/dest:\n");
  print(@retransmits);
}
```

#### Memory Allocation Profiler

```bash
#!/usr/bin/env bpftrace
# mem_alloc_profile.bt — track malloc/free to find allocation hotspots
# Usage: bpftrace mem_alloc_profile.bt -p <PID>

uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc {
  @alloc_size[ustack] = hist(arg0);
  @alloc_count[ustack] = count();
  @pending[tid] = arg0;
}

uretprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc /retval != 0/ {
  @allocs[tid] = retval;
  @sizes[retval] = @pending[tid];
  delete(@pending[tid]);
}

uprobe:/lib/x86_64-linux-gnu/libc.so.6:free /arg0 != 0/ {
  delete(@allocs[tid]);
  delete(@sizes[arg0]);
}

interval:s:10 {
  printf("\n=== Top Allocation Sites ===\n");
  print(@alloc_count, 5);
  printf("\n=== Allocation Size Distribution ===\n");
  print(@alloc_size, 3);

  // Outstanding allocations (not yet freed)
  $outstanding = 0;
  // Note: bpftrace doesn't support map iteration for sum easily
  // Use BCC for detailed leak tracking
}

END {
  print(@alloc_count, 10);
}
```

#### SSL/TLS Key Logger (Debugging Only)

```bash
#!/usr/bin/env bpftrace
# ssl_debug.bt — capture SSL_read/write data for debugging
# WARNING: Only use in dev/test environments, never production!

uprobe:/lib/x86_64-linux-gnu/libssl.so:SSL_read,
uprobe:/lib/x86_64-linux-gnu/libssl.so:SSL_write {
  printf("%-6d %-16s %s %d bytes\n",
    pid, comm,
    (probe == "uprobe:/lib/x86_64-linux-gnu/libssl.so:SSL_read") ? "READ" : "WRITE",
    arg2);
  // arg1 is the buffer pointer — use printf("%s", str(arg1, arg2)) to print content
  // ONLY in controlled environments
}
```

---

## Section 3: BCC — Python-Based eBPF Tools

### Custom BCC Program: Request Latency Tracker

```python
#!/usr/bin/env python3
# http_latency.py — measure HTTP request latency from kernel perspective
# Traces: sys_enter_sendto / sys_exit_recvfrom for HTTP workloads

from bcc import BPF
from collections import defaultdict
import ctypes
import time

prog = r"""
#include <uapi/linux/ptrace.h>
#include <linux/sched.h>

// Store start time keyed by tid+fd
BPF_HASH(start, u64, u64);

// Output ring buffer
struct event_t {
    u32 pid;
    u32 tid;
    char comm[TASK_COMM_LEN];
    u64 latency_ns;
    int bytes;
};

BPF_RINGBUF_OUTPUT(events, 8);

TRACEPOINT_PROBE(syscalls, sys_enter_sendto) {
    u64 id = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    start.update(&id, &ts);
    return 0;
}

TRACEPOINT_PROBE(syscalls, sys_exit_recvfrom) {
    u64 id = bpf_get_current_pid_tgid();
    u64 *tsp = start.lookup(&id);

    if (!tsp) return 0;

    u64 latency = bpf_ktime_get_ns() - *tsp;
    start.delete(&id);

    // Filter: only report latency > 1ms
    if (latency < 1000000) return 0;

    struct event_t *e = events.ringbuf_reserve(sizeof(*e));
    if (!e) return 0;

    e->pid = id >> 32;
    e->tid = id & 0xffffffff;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));
    e->latency_ns = latency;
    e->bytes = args->ret;

    events.ringbuf_submit(e, 0);
    return 0;
}
"""

# Histogram for distribution tracking (Python side)
latency_hist = defaultdict(int)

def handle_event(ctx, data, size):
    event = b["events"].event(data)
    latency_ms = event.latency_ns / 1_000_000
    bucket = int(latency_ms)
    latency_hist[bucket] += 1
    print(f"{event.comm.decode():16s} pid={event.pid:6d} "
          f"latency={latency_ms:8.2f}ms bytes={event.bytes}")

b = BPF(text=prog)
b["events"].open_ring_buffer(handle_event)

print("Tracing HTTP request latency (>1ms). Ctrl-C to stop.\n")
print(f"{'COMM':16s} {'PID':6s} {'LATENCY':>10s} {'BYTES':>8s}")

try:
    while True:
        b.ring_buffer_poll(timeout=100)
except KeyboardInterrupt:
    print("\n\n=== Latency Distribution (ms) ===")
    for ms in sorted(latency_hist.keys()):
        bar = "#" * min(latency_hist[ms], 60)
        print(f"{ms:4d}ms: {bar} ({latency_hist[ms]})")
```

### Disk I/O Latency Heatmap

```python
#!/usr/bin/env python3
# disk_latency_heatmap.py — track block I/O latency per disk

from bcc import BPF
import time

prog = r"""
#include <linux/blkdev.h>
#include <linux/blk_types.h>

struct key_t {
    char disk[DISK_NAME_LEN];
    int  op;       // 0=read, 1=write
    u64  slot;     // latency bucket (log2 of microseconds)
};

BPF_HASH(start, struct request *, u64);
BPF_HASH(dist, struct key_t);

void trace_req_start(struct pt_regs *ctx, struct request *req) {
    u64 ts = bpf_ktime_get_ns();
    start.update(&req, &ts);
}

void trace_req_done(struct pt_regs *ctx, struct request *req) {
    u64 *tsp = start.lookup(&req);
    if (!tsp) return;

    u64 latency_us = (bpf_ktime_get_ns() - *tsp) / 1000;
    start.delete(&req);

    struct key_t key = {};
    struct gendisk *disk = req->rq_disk;
    if (disk) {
        bpf_probe_read_kernel(&key.disk, sizeof(key.disk), disk->disk_name);
    }

    // Determine operation type
    key.op = (req->cmd_flags & REQ_OP_WRITE) ? 1 : 0;

    // Log2 bucketing
    u64 slot = 0;
    u64 val = latency_us;
    for (int i = 0; i < 64 && val > 1; i++) {
        val >>= 1;
        slot++;
    }
    key.slot = slot;

    u64 *count = dist.lookup(&key);
    if (count) (*count)++;
    else {
        u64 one = 1;
        dist.update(&key, &one);
    }
}
"""

b = BPF(text=prog)
b.attach_kprobe(event="blk_account_io_start", fn_name="trace_req_start")
b.attach_kprobe(event="blk_account_io_done", fn_name="trace_req_done")

print("Tracing block I/O latency. Ctrl-C to print distribution.\n")

try:
    while True:
        time.sleep(5)
        # Print running summary every 5 seconds
        print(f"\n{'='*60}")
        print(f"{'Disk':<12} {'Op':<6} {'Latency Bucket':<20} {'Count':>8}")
        print(f"{'='*60}")
        for k, v in sorted(b["dist"].items(), key=lambda x: (x[0].disk, x[0].op, x[0].slot)):
            disk = k.disk.decode().rstrip('\x00')
            op = "WRITE" if k.op == 1 else "READ "
            lo = 2 ** k.slot if k.slot > 0 else 0
            hi = 2 ** (k.slot + 1)
            print(f"{disk:<12} {op:<6} {lo:>8}us - {hi:>8}us  {v.value:>8}")

except KeyboardInterrupt:
    print("\nDone.")
```

---

## Section 4: Go eBPF with cilium/ebpf

The `cilium/ebpf` library provides a production-grade Go interface for loading, attaching, and interacting with eBPF programs compiled from C.

### Project Structure

```
ebpf-app/
  cmd/
    tracer/
      main.go
  internal/
    tracer/
      tracer.go
  bpf/
    tracer.c        # eBPF C program
    tracer.go       # Generated Go bindings (bpf2go output)
  Makefile
  go.mod
```

### eBPF C Program

```c
// bpf/tracer.c
//go:build ignore

#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

// Event structure shared between kernel and user space
struct event {
    u32 pid;
    u32 uid;
    u8  comm[16];
    u8  filename[256];
    int ret;
};

// Ring buffer for sending events to user space
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);  // 16MB ring buffer
} events SEC(".maps");

// Hash map to track open calls (pid -> filename)
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, u32);
    __type(value, struct event);
} inflight SEC(".maps");

// Filter by UID (0 = trace all)
const volatile u32 filter_uid = 0;

SEC("tracepoint/syscalls/sys_enter_openat")
int tracepoint__syscalls__sys_enter_openat(struct trace_event_raw_sys_enter *ctx) {
    u64 id = bpf_get_current_pid_tgid();
    u32 pid = id >> 32;
    u32 tid = (u32)id;
    u32 uid = bpf_get_current_uid_gid();

    if (filter_uid != 0 && uid != filter_uid) return 0;

    struct event ev = {};
    ev.pid = pid;
    ev.uid = uid;
    bpf_get_current_comm(&ev.comm, sizeof(ev.comm));

    // Read filename from user space
    const char *fname = (const char *)ctx->args[1];
    bpf_probe_read_user_str(&ev.filename, sizeof(ev.filename), fname);

    // Store for later (kretprobe will add return value)
    bpf_map_update_elem(&inflight, &tid, &ev, BPF_ANY);
    return 0;
}

SEC("tracepoint/syscalls/sys_exit_openat")
int tracepoint__syscalls__sys_exit_openat(struct trace_event_raw_sys_exit *ctx) {
    u64 id = bpf_get_current_pid_tgid();
    u32 tid = (u32)id;

    struct event *ev = bpf_map_lookup_elem(&inflight, &tid);
    if (!ev) return 0;

    ev->ret = ctx->ret;

    // Send to ring buffer
    struct event *ringbuf_ev = bpf_ringbuf_reserve(&events, sizeof(*ev), 0);
    if (!ringbuf_ev) {
        bpf_map_delete_elem(&inflight, &tid);
        return 0;
    }

    __builtin_memcpy(ringbuf_ev, ev, sizeof(*ev));
    bpf_ringbuf_submit(ringbuf_ev, 0);
    bpf_map_delete_elem(&inflight, &tid);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Makefile for bpf2go Code Generation

```makefile
# Makefile
.PHONY: generate build clean

CLANG ?= clang
ARCH := $(shell uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')

generate:
	# bpf2go generates Go bindings from the C eBPF program
	go generate ./bpf/...

build: generate
	go build -o bin/tracer ./cmd/tracer/

clean:
	rm -f bpf/tracer_bpfel.go bpf/tracer_bpfeb.go
	rm -f bpf/tracer_bpfel.o bpf/tracer_bpfeb.o
	rm -f bin/tracer
```

### Generated eBPF Bindings (bpf2go directive)

```go
// bpf/tracer.go
package tracer

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall -Werror" Tracer tracer.c -- -I../headers
```

### Go User-Space Program

```go
// internal/tracer/tracer.go
package tracer

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"

	// Import the generated package from bpf2go
	ebpf "your-org/ebpf-app/bpf"
)

// Event mirrors the C struct event
type Event struct {
	PID      uint32
	UID      uint32
	Comm     [16]byte
	Filename [256]byte
	Ret      int32
}

func (e *Event) CommString() string {
	return string(bytes.TrimRight(e.Comm[:], "\x00"))
}

func (e *Event) FilenameString() string {
	return string(bytes.TrimRight(e.Filename[:], "\x00"))
}

type Tracer struct {
	objs  ebpf.TracerObjects
	links []link.Link
	rd    *ringbuf.Reader
	log   *slog.Logger
}

func New(logger *slog.Logger) (*Tracer, error) {
	// Remove memory lock limit (required for eBPF maps)
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, fmt.Errorf("removing memlock: %w", err)
	}

	var objs ebpf.TracerObjects
	if err := ebpf.LoadTracerObjects(&objs, nil); err != nil {
		return nil, fmt.Errorf("loading eBPF objects: %w", err)
	}

	// Attach tracepoints
	tpEnter, err := link.Tracepoint("syscalls", "sys_enter_openat",
		objs.TracerPrograms.TracepointSyscallsSysEnterOpenat, nil)
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("attaching enter tracepoint: %w", err)
	}

	tpExit, err := link.Tracepoint("syscalls", "sys_exit_openat",
		objs.TracerPrograms.TracepointSyscallsSysExitOpenat, nil)
	if err != nil {
		tpEnter.Close()
		objs.Close()
		return nil, fmt.Errorf("attaching exit tracepoint: %w", err)
	}

	// Open ring buffer reader
	rd, err := ringbuf.NewReader(objs.TracerMaps.Events)
	if err != nil {
		tpEnter.Close()
		tpExit.Close()
		objs.Close()
		return nil, fmt.Errorf("opening ringbuf reader: %w", err)
	}

	return &Tracer{
		objs:  objs,
		links: []link.Link{tpEnter, tpExit},
		rd:    rd,
		log:   logger,
	}, nil
}

func (t *Tracer) Close() {
	t.rd.Close()
	for _, l := range t.links {
		l.Close()
	}
	t.objs.Close()
}

func (t *Tracer) Run(ctx context.Context, handler func(Event)) error {
	t.log.Info("Starting eBPF tracer")

	go func() {
		<-ctx.Done()
		t.rd.Close()
	}()

	for {
		record, err := t.rd.Read()
		if err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return nil
			}
			t.log.Error("ringbuf read error", "error", err)
			continue
		}

		var event Event
		if err := binary.Read(bytes.NewReader(record.RawSample), binary.LittleEndian, &event); err != nil {
			t.log.Error("parsing event", "error", err)
			continue
		}

		handler(event)
	}
}

// SetFilterUID configures the UID filter (0 = all users)
func (t *Tracer) SetFilterUID(uid uint32) error {
	return t.objs.TracerMaps.FilterUid.Update(uint32(0), uid, 0)
}
```

```go
// cmd/tracer/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"your-org/ebpf-app/internal/tracer"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "eBPF tracing requires root privileges")
		os.Exit(1)
	}

	t, err := tracer.New(logger)
	if err != nil {
		logger.Error("Failed to create tracer", "error", err)
		os.Exit(1)
	}
	defer t.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	fmt.Printf("%-8s %-6s %-16s %-6s %s\n", "TIME", "PID", "COMM", "FD", "FILENAME")

	err = t.Run(ctx, func(ev tracer.Event) {
		fmt.Printf("%-8s %-6d %-16s %-6d %s\n",
			"now",
			ev.PID,
			ev.CommString(),
			ev.Ret,
			ev.FilenameString(),
		)
	})
	if err != nil {
		logger.Error("Tracer error", "error", err)
		os.Exit(1)
	}
}
```

---

## Section 5: Performance Analysis Workflows

### CPU Flame Graph with bpftrace

```bash
# Sample CPU stack traces at 99Hz for 30 seconds
bpftrace -e '
profile:hz:99 /pid > 1/ {
  @[comm, kstack, ustack] = count();
}' -o /tmp/stacks.bt &

sleep 30
kill %1

# Convert to Brendan Gregg flame graph format
# (bpftrace output needs filtering)
bpftrace -e '
profile:hz:99 /pid > 1/ {
  @[comm, ustack] = count();
}' | \
  awk '/^@/{found=1; next} found && !/^$/{print}' | \
  stackcollapse.pl | \
  flamegraph.pl --title="CPU Flame Graph" > /tmp/cpu-flame.svg

# Interactive approach using profile.py from BCC
/usr/share/bcc/tools/profile -F 99 -d 30 | \
  flamegraph.pl > /tmp/cpu-flame.svg
```

### Off-CPU Analysis

```bash
# off-CPU analysis — where threads are sleeping waiting
bpftrace -e '
tracepoint:sched:sched_switch {
  if (args->prev_state) {  // Thread going off-CPU (not voluntary)
    @start[args->prev_pid] = nsecs;
  }
}

tracepoint:sched:sched_switch {
  $s = @start[args->next_pid];
  if ($s) {
    @offcpu_us[args->next_comm, kstack(perf)] =
      hist((nsecs - $s) / 1000);
    delete(@start[args->next_pid]);
  }
}'
```

### Memory Leak Detection

```bash
#!/usr/bin/env bpftrace
# memleak.bt — basic malloc/free balance tracking

uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc { @alloc_size[tid] = arg0; }

uretprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc /retval/ {
  if (@alloc_size[tid]) {
    @bytes_outstanding += @alloc_size[tid];
    @allocs[retval] = @alloc_size[tid];
    @stack_count[ustack] = count();
    delete(@alloc_size[tid]);
  }
}

uprobe:/lib/x86_64-linux-gnu/libc.so.6:free /arg0/ {
  if (@allocs[arg0]) {
    @bytes_outstanding -= @allocs[arg0];
    delete(@allocs[arg0]);
  }
}

interval:s:10 {
  printf("Outstanding allocated bytes: %d\n", @bytes_outstanding);
  printf("Top allocation stacks:\n");
  print(@stack_count, 5);
  clear(@stack_count);
}
```

---

## Section 6: Network Observability

### TCP State Tracker

```bash
#!/usr/bin/env bpftrace
# tcp_states.bt — track TCP connection state changes

#include <net/tcp_states.h>
#include <net/sock.h>

// Map state numbers to names
BEGIN {
  @tcp_states[1]  = "ESTABLISHED";
  @tcp_states[2]  = "SYN_SENT";
  @tcp_states[3]  = "SYN_RECV";
  @tcp_states[4]  = "FIN_WAIT1";
  @tcp_states[5]  = "FIN_WAIT2";
  @tcp_states[6]  = "TIME_WAIT";
  @tcp_states[7]  = "CLOSE";
  @tcp_states[8]  = "CLOSE_WAIT";
  @tcp_states[9]  = "LAST_ACK";
  @tcp_states[10] = "LISTEN";
  @tcp_states[11] = "CLOSING";
}

kprobe:tcp_set_state {
  $sk = (struct sock *)arg0;
  $newstate = arg1;
  $oldstate = $sk->sk_state;

  $dport = $sk->__sk_common.skc_dport;
  $dport = ($dport >> 8) | (($dport & 0xff) << 8);

  printf("%-26s %-7s %-22s → %-14s %s\n",
    strftime("%H:%M:%S.%f", nsecs),
    comm,
    strcat(ntop(AF_INET, $sk->__sk_common.skc_daddr), strcat(":", itoa($dport))),
    @tcp_states[$newstate],
    @tcp_states[$oldstate]);
}

END {
  clear(@tcp_states);
}
```

### DNS Query Tracker

```bash
#!/usr/bin/env bpftrace
# dns_snoop.bt — trace DNS queries via recvfrom

tracepoint:syscalls:sys_enter_recvfrom {
  @fds[tid] = args->fd;
}

tracepoint:syscalls:sys_exit_recvfrom /retval > 12/ {
  $buf = args->ubuf;
  // DNS packet starts at byte 12 with QName
  // Simplified: print first 64 bytes as hex for analysis
  printf("DNS recv pid=%-6d comm=%-16s len=%-5d\n",
    pid, comm, retval);
}
```

---

## Section 7: Kubernetes-Specific eBPF Observability

### Pod Network Traffic with Container Awareness

```python
#!/usr/bin/env python3
# k8s_net_tracer.py — trace network traffic with container/pod awareness

from bcc import BPF
import subprocess
import json

# Get pod/container mapping from cgroups
def get_container_cgroup_map():
    result = subprocess.run(
        ['crictl', 'ps', '-o', 'json'],
        capture_output=True, text=True
    )
    containers = {}
    if result.returncode == 0:
        data = json.loads(result.stdout)
        for c in data.get('containers', []):
            cgroup_id = c.get('id', '')[:12]
            pod_name = c.get('labels', {}).get('io.kubernetes.pod.name', 'unknown')
            containers[cgroup_id] = pod_name
    return containers

prog = r"""
#include <linux/sched.h>
#include <net/sock.h>
#include <bcc/proto.h>

struct net_event {
    u32 pid;
    u32 saddr;
    u32 daddr;
    u16 sport;
    u16 dport;
    u32 size;
    u8  comm[16];
    char cgroup[64];
};

BPF_RINGBUF_OUTPUT(net_events, 1 << 22);

int trace_tcp_sendmsg(struct pt_regs *ctx, struct sock *sk,
                      struct msghdr *msg, size_t size) {
    struct net_event *e = net_events.ringbuf_reserve(sizeof(*e));
    if (!e) return 0;

    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->saddr = sk->__sk_common.skc_rcv_saddr;
    e->daddr = sk->__sk_common.skc_daddr;
    e->sport = sk->__sk_common.skc_num;
    u16 dport = sk->__sk_common.skc_dport;
    e->dport = (dport >> 8) | ((dport & 0xff) << 8);
    e->size = size;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));

    // Get cgroup name for container identification
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    bpf_probe_read_kernel_str(&e->cgroup, sizeof(e->cgroup),
        task->cgroups->subsys[0]->cgroup->kn->name);

    net_events.ringbuf_submit(e, 0);
    return 0;
}
"""

b = BPF(text=prog)
b.attach_kprobe(event="tcp_sendmsg", fn_name="trace_tcp_sendmsg")
containers = get_container_cgroup_map()

def handle_net_event(ctx, data, size):
    event = b["net_events"].event(data)
    import socket, struct
    src = socket.inet_ntoa(struct.pack("I", event.saddr))
    dst = socket.inet_ntoa(struct.pack("I", event.daddr))
    cgroup = event.cgroup.decode().rstrip('\x00')
    pod = containers.get(cgroup[:12], cgroup[:12])

    print(f"{event.comm.decode():16s} [{pod:30s}] "
          f"{src}:{event.sport} → {dst}:{event.dport} "
          f"{event.size} bytes")

b["net_events"].open_ring_buffer(handle_net_event)
print("Tracing TCP sends. Ctrl-C to stop.\n")

while True:
    try:
        b.ring_buffer_poll(timeout=100)
    except KeyboardInterrupt:
        break
```

---

## Section 8: Building an eBPF Metrics Exporter for Prometheus

```go
// cmd/ebpf-exporter/main.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	openatCalls = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ebpf_openat_calls_total",
			Help: "Total openat syscalls observed by eBPF",
		},
		[]string{"comm", "success"},
	)

	openatLatency = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "ebpf_openat_latency_microseconds",
			Help:    "openat syscall latency distribution",
			Buckets: prometheus.ExponentialBuckets(1, 2, 20),
		},
		[]string{"comm"},
	)
)

func init() {
	prometheus.MustRegister(openatCalls, openatLatency)
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	tr, err := tracer.New(logger)
	if err != nil {
		logger.Error("Failed to start eBPF tracer", "error", err)
		os.Exit(1)
	}
	defer tr.Close()

	ctx, stop := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Process events in background
	go func() {
		tr.Run(ctx, func(ev tracer.Event) {
			comm := ev.CommString()
			success := "true"
			if ev.Ret < 0 {
				success = "false"
			}
			openatCalls.WithLabelValues(comm, success).Inc()
		})
	}()

	// Prometheus HTTP server
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":9090",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("Starting metrics server", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			logger.Error("Metrics server error", "error", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
	logger.Info("eBPF exporter stopped")
}
```

---

## Section 9: Security Use Cases

### Detecting Privilege Escalation

```bash
#!/usr/bin/env bpftrace
# priv_escalation.bt — detect setuid/setgid and capability changes

tracepoint:syscalls:sys_enter_setuid,
tracepoint:syscalls:sys_enter_setgid {
  printf("PRIV_CHANGE %-8s pid=%-6d uid=%-6d → new_id=%d\n",
    probe, pid, uid, args->uid);
}

kprobe:cap_capable {
  $cap = arg2;
  $audit = arg3;
  if ($cap == 12 || $cap == 21 || $cap == 39) {  // NET_ADMIN, SYS_ADMIN, BPF
    printf("CAP_CHECK %-16s pid=%-6d cap=%d\n", comm, pid, $cap);
  }
}

kprobe:security_bprm_check {
  printf("EXEC %-16s → %s\n", comm, str(arg0));
}
```

### Container Escape Detection

```bash
#!/usr/bin/env bpftrace
# container_escape.bt — detect potential container escape attempts

// Detect namespace joins (a potential escape indicator)
kprobe:setns {
  printf("SETNS pid=%-6d comm=%-16s nstype=%d\n", pid, comm, arg1);
}

// Detect /proc access (host PID namespace access)
tracepoint:syscalls:sys_enter_openat {
  $fname = str(args->filename);
  if ($fname == "/proc/1/ns/mnt" || $fname == "/proc/1/exe") {
    printf("HOST_PROC_ACCESS pid=%-6d comm=%-16s file=%s\n",
      pid, comm, $fname);
  }
}

// Detect ptrace of processes outside the container
kprobe:sys_ptrace {
  printf("PTRACE pid=%-6d comm=%-16s target=%d\n",
    pid, comm, arg1);
}
```

---

## Section 10: Production Deployment

### Packaging eBPF Tools as a DaemonSet

```yaml
# ebpf-exporter-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebpf-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: ebpf-exporter
  template:
    metadata:
      labels:
        app: ebpf-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      hostPID: true        # Access host process namespace
      hostNetwork: true    # For network tracing
      tolerations:
        - operator: Exists   # Run on all nodes including control plane
      initContainers:
        # Verify kernel version and eBPF support
        - name: check-ebpf
          image: alpine:3.19
          command:
            - sh
            - -c
            - |
              KERNEL=$(uname -r | cut -d. -f1,2 | tr -d .)
              if [ "$KERNEL" -lt "515" ]; then
                echo "Kernel 5.15+ required for BTF/CO-RE"
                exit 1
              fi
              echo "Kernel check passed: $(uname -r)"
          securityContext:
            privileged: true
      containers:
        - name: ebpf-exporter
          image: your-registry/ebpf-exporter:1.0.0
          ports:
            - containerPort: 9090
              name: metrics
          securityContext:
            privileged: true   # Required for eBPF
            # Alternative (more restrictive):
            # capabilities:
            #   add: ["BPF", "PERFMON", "NET_ADMIN", "SYS_RESOURCE"]
          resources:
            requests:
              memory: "64Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          volumeMounts:
            - name: sys
              mountPath: /sys
              readOnly: true
            - name: debugfs
              mountPath: /sys/kernel/debug
              readOnly: false
      volumes:
        - name: sys
          hostPath:
            path: /sys
        - name: debugfs
          hostPath:
            path: /sys/kernel/debug
      serviceAccountName: ebpf-exporter
```

eBPF has made Linux truly introspectable at production scale. The combination of bpftrace for rapid investigation, BCC for Python prototyping, and cilium/ebpf for production Go services covers the full spectrum from ad-hoc debugging to always-on observability infrastructure. The key is understanding which probe type matches your target: tracepoints for stable kernel interfaces, kprobes for deep kernel internals, and uprobes for userspace application insight.
