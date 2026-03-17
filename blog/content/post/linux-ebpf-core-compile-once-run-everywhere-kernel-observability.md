---
title: "Linux eBPF CO-RE: Compile Once Run Everywhere for Portable Kernel Observability"
date: 2031-09-01T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "CO-RE", "Observability", "Kernel", "BPF", "libbpf"]
categories:
- Linux
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Master eBPF CO-RE (Compile Once, Run Everywhere) to write portable BPF programs that run across kernel versions without recompilation, using BTF type information and libbpf relocations."
more_link: "yes"
url: "/linux-ebpf-core-compile-once-run-everywhere-kernel-observability/"
---

The historical barrier to eBPF adoption was portability: a BPF program compiled against kernel headers from one machine would fail or produce garbage on a kernel with different internal struct layouts. CO-RE (Compile Once, Run Everywhere) solves this using BTF (BPF Type Format) to describe kernel data structures at runtime, allowing the BPF loader to rewrite field offsets on the fly. This post builds production-grade CO-RE programs for system call tracing, network flow monitoring, and process lifecycle tracking.

<!--more-->

# Linux eBPF CO-RE: Compile Once Run Everywhere for Portable Kernel Observability

## The Portability Problem CO-RE Solves

Before CO-RE, every eBPF deployment needed to either:

1. **Compile on the target machine**: Requires kernel headers and a full toolchain on production nodes — a security and operational nightmare.
2. **Use BCC's runtime compilation**: BCC JIT-compiles C at load time, requiring clang and kernel headers at runtime, adding 1–5 seconds of startup latency and 50+ MB of dependencies.
3. **Hardcode offsets**: Fragile, kernel-version-specific, breaks on minor updates.

CO-RE uses three components to eliminate these problems:

- **BTF (BPF Type Format)**: A compact representation of kernel type information, available from `/sys/kernel/btf/vmlinux` on kernels 5.4+.
- **`__builtin_preserve_access_index`**: A Clang attribute that records field accesses as relocations instead of hardcoded offsets.
- **libbpf**: The loader that reads BTF from the running kernel, matches it against the BTF embedded in the BPF object, and patches field offsets before loading.

## Prerequisites and Toolchain

```bash
# Kernel requirement
uname -r
# 5.15.0-89-generic

# Verify BTF is available
ls -la /sys/kernel/btf/vmlinux
# -r--r--r-- 1 root root 4621312 Nov 15 2023 /sys/kernel/btf/vmlinux

# Install toolchain
apt-get install -y \
  clang \
  llvm \
  libbpf-dev \
  linux-headers-$(uname -r) \
  bpftool

# Verify bpftool can generate vmlinux.h
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
wc -l vmlinux.h
# 185234 vmlinux.h
```

The `vmlinux.h` file is a single header containing all kernel type definitions for the running kernel, generated from BTF. Including it gives access to all kernel structs without installing kernel headers.

## CO-RE Development Setup

### Directory Structure

```
ebpf-core-examples/
├── Makefile
├── include/
│   └── vmlinux.h          # Generated from target kernel
├── bpf/
│   ├── common.h           # Shared BPF helpers
│   ├── syscall_trace.bpf.c
│   ├── netflow.bpf.c
│   └── process_tracker.bpf.c
├── loader/
│   ├── syscall_trace.go
│   ├── netflow.go
│   └── process_tracker.go
└── go.mod
```

### Makefile

```makefile
# Makefile
CLANG := clang
BPFTOOL := bpftool
TARGET_ARCH := x86
BPF_CFLAGS := -g -O2 -target bpf -D__TARGET_ARCH_$(TARGET_ARCH)

# Generate vmlinux.h from running kernel
vmlinux.h:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > include/vmlinux.h

# Compile BPF programs to object files
%.bpf.o: bpf/%.bpf.c include/vmlinux.h
	$(CLANG) $(BPF_CFLAGS) \
		-I./include \
		-c $< -o $@

# Generate Go bindings using bpf2go (cilium/ebpf)
generate:
	go generate ./loader/...

.PHONY: all clean vmlinux.h generate
all: vmlinux.h syscall_trace.bpf.o netflow.bpf.o process_tracker.bpf.o
clean:
	rm -f *.bpf.o include/vmlinux.h
```

## CO-RE Fundamentals: The BPF_CORE_READ Macro

The `BPF_CORE_READ` macro from libbpf is the key tool. It reads a field from a kernel struct using a recorded relocation rather than a hardcoded offset:

```c
// include/common.h
#pragma once

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

// Maximum string length for task comm
#define TASK_COMM_LEN 16
#define MAX_FILENAME_LEN 256

// Ring buffer size (must be a power of 2, in bytes)
#define RINGBUF_SIZE (1 << 24)   // 16 MB
```

## Example 1: System Call Tracer

Trace all execve system calls to capture process creation with arguments.

```c
// bpf/syscall_trace.bpf.c
#include "common.h"

// Event structure sent to userspace
struct exec_event {
    __u32 pid;
    __u32 ppid;
    __u32 uid;
    __u32 gid;
    char  comm[TASK_COMM_LEN];
    char  filename[MAX_FILENAME_LEN];
    int   retcode;
};

// Ring buffer map for events
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, RINGBUF_SIZE);
} exec_events SEC(".maps");

// Per-PID tracking map: store filename at entry, read retcode at exit
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, struct exec_event);
} in_progress SEC(".maps");

// Tracepoint: syscalls/sys_enter_execve
SEC("tracepoint/syscalls/sys_enter_execve")
int trace_exec_enter(struct trace_event_raw_sys_enter *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u32 tid = (__u32)pid_tgid;

    // Only trace the thread group leader
    if (pid != tid) return 0;

    struct exec_event event = {};
    event.pid = pid;
    event.uid = bpf_get_current_uid_gid() >> 32;
    event.gid = (__u32)bpf_get_current_uid_gid();

    bpf_get_current_comm(&event.comm, sizeof(event.comm));

    // Read filename argument from userspace
    // ctx->args[0] is the first syscall argument (filename pointer)
    const char *filename = (const char *)ctx->args[0];
    bpf_probe_read_user_str(event.filename, sizeof(event.filename), filename);

    // Read parent PID using CO-RE
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    struct task_struct *parent = BPF_CORE_READ(task, real_parent);
    event.ppid = BPF_CORE_READ(parent, tgid);

    bpf_map_update_elem(&in_progress, &pid, &event, BPF_ANY);
    return 0;
}

// Tracepoint: syscalls/sys_exit_execve
SEC("tracepoint/syscalls/sys_exit_execve")
int trace_exec_exit(struct trace_event_raw_sys_exit *ctx)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;

    struct exec_event *event = bpf_map_lookup_elem(&in_progress, &pid);
    if (!event) return 0;

    event->retcode = ctx->ret;

    // Only emit successful execves (retcode 0)
    if (event->retcode == 0) {
        struct exec_event *rb_event = bpf_ringbuf_reserve(&exec_events,
                                                           sizeof(*event), 0);
        if (rb_event) {
            *rb_event = *event;
            bpf_ringbuf_submit(rb_event, 0);
        }
    }

    bpf_map_delete_elem(&in_progress, &pid);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Go Loader for syscall_trace

```go
// loader/syscall_trace.go
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall -target bpf" syscallTrace ../bpf/syscall_trace.bpf.c

package loader

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"unsafe"

	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"
)

// ExecEvent mirrors the BPF struct exec_event.
type ExecEvent struct {
	PID      uint32
	PPID     uint32
	UID      uint32
	GID      uint32
	Comm     [16]byte
	Filename [256]byte
	Retcode  int32
}

func RunSyscallTracer(log *slog.Logger) error {
	// Remove memory lock limit (required for BPF maps).
	if err := rlimit.RemoveMemlock(); err != nil {
		return fmt.Errorf("remove memlock: %w", err)
	}

	// Load pre-compiled BPF objects (generated by bpf2go).
	objs := syscallTraceObjects{}
	if err := loadSyscallTraceObjects(&objs, nil); err != nil {
		return fmt.Errorf("load BPF objects: %w", err)
	}
	defer objs.Close()

	// Attach to tracepoints.
	tpEnter, err := link.Tracepoint("syscalls", "sys_enter_execve",
		objs.TraceExecEnter, nil)
	if err != nil {
		return fmt.Errorf("attach enter tracepoint: %w", err)
	}
	defer tpEnter.Close()

	tpExit, err := link.Tracepoint("syscalls", "sys_exit_execve",
		objs.TraceExecExit, nil)
	if err != nil {
		return fmt.Errorf("attach exit tracepoint: %w", err)
	}
	defer tpExit.Close()

	// Open ring buffer reader.
	rd, err := ringbuf.NewReader(objs.ExecEvents)
	if err != nil {
		return fmt.Errorf("open ring buffer: %w", err)
	}
	defer rd.Close()

	log.Info("syscall tracer started — watching execve")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sig
		rd.Close()
	}()

	for {
		record, err := rd.Read()
		if err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return nil
			}
			log.Error("ring buffer read error", "error", err)
			continue
		}

		var event ExecEvent
		if err := binary.Read(bytes.NewReader(record.RawSample),
			binary.NativeEndian, &event); err != nil {
			log.Error("decode event", "error", err)
			continue
		}

		comm := nullTermString(event.Comm[:])
		filename := nullTermString(event.Filename[:])

		log.Info("exec",
			"pid", event.PID,
			"ppid", event.PPID,
			"uid", event.UID,
			"comm", comm,
			"filename", filename,
		)
	}
}

func nullTermString(b []byte) string {
	n := bytes.IndexByte(b, 0)
	if n == -1 {
		return string(b)
	}
	return string(b[:n])
}
```

## Example 2: Network Flow Monitor

Track TCP connection establishments using kprobe on `tcp_v4_connect`.

```c
// bpf/netflow.bpf.c
#include "common.h"

struct flow_event {
    __u32 pid;
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    char  comm[TASK_COMM_LEN];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, RINGBUF_SIZE);
} flow_events SEC(".maps");

// Track sock pointer between entry and return
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u64);
    __type(value, struct sock *);
} sock_store SEC(".maps");

SEC("kprobe/tcp_v4_connect")
int kprobe_tcp_v4_connect(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    bpf_map_update_elem(&sock_store, &pid_tgid, &sk, BPF_ANY);
    return 0;
}

SEC("kretprobe/tcp_v4_connect")
int kretprobe_tcp_v4_connect(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();

    struct sock **skp = bpf_map_lookup_elem(&sock_store, &pid_tgid);
    if (!skp) return 0;
    bpf_map_delete_elem(&sock_store, &pid_tgid);

    int ret = PT_REGS_RC(ctx);
    if (ret != 0) return 0;   // Connection failed.

    struct sock *sk = *skp;

    struct flow_event *event = bpf_ringbuf_reserve(&flow_events,
                                                    sizeof(*event), 0);
    if (!event) return 0;

    event->pid   = pid_tgid >> 32;
    event->saddr = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
    event->daddr = BPF_CORE_READ(sk, __sk_common.skc_daddr);
    event->sport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_num));
    event->dport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
    bpf_get_current_comm(&event->comm, sizeof(event->comm));

    bpf_ringbuf_submit(event, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

## Example 3: Process Lifecycle Tracker with Maps

Track all processes in a BPF hash map — useful for namespace and container escape detection.

```c
// bpf/process_tracker.bpf.c
#include "common.h"

struct process_info {
    __u32 pid;
    __u32 ppid;
    __u32 uid;
    __u32 ns_pid;          // PID inside container namespace
    __u64 start_time;
    char  comm[TASK_COMM_LEN];
    char  cgroup[128];     // cgroup path (container ID)
    __u8  exiting;
};

// Map of active processes
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, __u32);    // host PID
    __type(value, struct process_info);
} processes SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, RINGBUF_SIZE);
} lifecycle_events SEC(".maps");

// Hook: process fork/clone
SEC("tp_btf/sched_process_fork")
int trace_fork(struct bpf_raw_tracepoint_args *ctx)
{
    struct task_struct *parent = (struct task_struct *)ctx->args[0];
    struct task_struct *child  = (struct task_struct *)ctx->args[1];

    struct process_info info = {};

    // CO-RE reads — libbpf adjusts offsets at load time
    info.pid  = BPF_CORE_READ(child, tgid);
    info.ppid = BPF_CORE_READ(parent, tgid);
    info.uid  = BPF_CORE_READ(child, cred, uid.val);

    // Read ns_pid — PID as seen inside the namespace (container)
    struct pid *pid_ptr = BPF_CORE_READ(child, thread_pid);
    unsigned int level = BPF_CORE_READ(pid_ptr, level);
    info.ns_pid = BPF_CORE_READ(pid_ptr, numbers[level].nr);

    info.start_time = BPF_CORE_READ(child, start_time);
    bpf_probe_read_kernel_str(&info.comm, sizeof(info.comm),
                              BPF_CORE_READ(child, comm));

    // Read cgroup name for container identification
    struct css_set *cgroups = BPF_CORE_READ(child, cgroups);
    struct cgroup *cgrp = BPF_CORE_READ(cgroups, dfl_cgrp);
    struct kernfs_node *kn = BPF_CORE_READ(cgrp, kn);
    bpf_probe_read_kernel_str(&info.cgroup, sizeof(info.cgroup),
                              BPF_CORE_READ(kn, name));

    bpf_map_update_elem(&processes, &info.pid, &info, BPF_ANY);

    // Emit event
    struct process_info *ev = bpf_ringbuf_reserve(&lifecycle_events,
                                                   sizeof(*ev), 0);
    if (ev) {
        *ev = info;
        bpf_ringbuf_submit(ev, 0);
    }

    return 0;
}

// Hook: process exit
SEC("tp_btf/sched_process_exit")
int trace_exit(struct bpf_raw_tracepoint_args *ctx)
{
    struct task_struct *task = (struct task_struct *)ctx->args[0];
    __u32 pid = BPF_CORE_READ(task, tgid);
    __u32 tid = BPF_CORE_READ(task, pid);

    if (pid != tid) return 0;   // Only emit for thread group leaders.

    struct process_info *info = bpf_map_lookup_elem(&processes, &pid);
    if (info) {
        info->exiting = 1;
        struct process_info *ev = bpf_ringbuf_reserve(&lifecycle_events,
                                                       sizeof(*ev), 0);
        if (ev) {
            *ev = *info;
            bpf_ringbuf_submit(ev, 0);
        }
        bpf_map_delete_elem(&processes, &pid);
    }

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

## Handling Kernel Version Differences with CO-RE

CO-RE's `BPF_CORE_READ` handles field-level changes between kernel versions. For struct additions or removals, use `bpf_core_field_exists`:

```c
// Handle kernels where task_struct.pid_links was restructured
struct process_info fill_process(struct task_struct *task) {
    struct process_info info = {};

    // This field exists in 5.15+
    if (bpf_core_field_exists(task->thread_pid)) {
        struct pid *pid_ptr = BPF_CORE_READ(task, thread_pid);
        info.ns_pid = BPF_CORE_READ(pid_ptr, numbers[0].nr);
    } else {
        // Older kernel fallback
        info.ns_pid = BPF_CORE_READ(task, tgid);
    }

    return info;
}

// Conditional compilation for enum value changes
enum {
    BPF_TCP_ESTABLISHED_COMPAT = 1,
};

static __always_inline __u8 get_tcp_state(struct sock *sk) {
    __u8 state;
    // bpf_core_enum_value handles enum member renames between kernels
    BPF_CORE_READ_INTO(&state, sk, __sk_common.skc_state);
    return state;
}
```

## Perf Considerations

### Avoid Unbounded Loops

The BPF verifier rejects programs with unbounded loops. Use `bpf_loop` for bounded iteration:

```c
struct loop_ctx {
    int count;
    struct bpf_map *map;
};

static long count_entries(u32 index, void *ctx_ptr) {
    struct loop_ctx *ctx = ctx_ptr;
    ctx->count++;
    return (index < 100) ? 0 : 1;   // Return 1 to stop
}

SEC("tracepoint/...")
int my_program(void *ctx)
{
    struct loop_ctx lctx = {};
    bpf_loop(1000, count_entries, &lctx, 0);
    return 0;
}
```

### Map Sizing

```c
// Use per-CPU maps for high-frequency counters (no lock contention)
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_HASH);
    __uint(max_entries, 65536);
    __type(key, __u32);
    __type(value, __u64);
} syscall_counts SEC(".maps");

// Read from all CPUs in userspace
```

```go
// Read per-CPU map values
var values []uint64
if err := objs.SyscallCounts.Lookup(pid, &values); err != nil {
    return err
}
total := uint64(0)
for _, v := range values {
    total += v
}
```

## CI: Portable Distribution

Because the BPF object is compiled against BTF rather than hardcoded headers, a single binary can run on any kernel 5.4+ that exposes `/sys/kernel/btf/vmlinux`:

```dockerfile
# Multi-stage: compile BPF + Go loader
FROM ubuntu:22.04 AS builder

RUN apt-get update && apt-get install -y \
    clang llvm libbpf-dev bpftool golang-1.22

WORKDIR /build
COPY . .

# Generate vmlinux.h from the BUILD host's kernel
# In CI, this should target the minimum supported kernel
RUN make all
RUN CGO_ENABLED=0 go build -o /bin/ebpf-tracer ./cmd/...

# Runtime: no kernel headers needed
FROM gcr.io/distroless/static:nonroot
COPY --from=builder /bin/ebpf-tracer /ebpf-tracer
# BPF objects are embedded in the binary via go:embed
ENTRYPOINT ["/ebpf-tracer"]
```

### Embedding BPF Objects with go:embed

```go
// loader/syscall_trace.go
import _ "embed"

//go:embed syscall_trace_bpfel.o
var syscallTraceBPFObj []byte

// Load from embedded bytes (works without separate .o files)
spec, err := ebpf.LoadCollectionSpecFromReader(bytes.NewReader(syscallTraceBPFObj))
```

## Verification and Debugging

```bash
# Inspect loaded programs
bpftool prog list
# 42: tracepoint  name trace_exec_enter  tag a2f8e84c3b2f1d9e
# 43: tracepoint  name trace_exec_exit   tag b4a9d7e2c1f3a8b5

# Dump the verified BPF bytecode
bpftool prog dump xlated id 42

# Show BTF info embedded in the object
bpftool btf dump id $(bpftool prog show id 42 | grep btf_id | awk '{print $2}')

# Trace verifier log on load failure
export BPF_LOG_LEVEL=1
# The cilium/ebpf library will print the verifier log on LoadCollectionSpec error

# Check maps
bpftool map list
bpftool map dump id 5

# Inspect ring buffer stats
bpftool map show name exec_events
# 7: ringbuf  name exec_events  flags 0x0
#         max_entries:16777216  memlock:16781312B
```

## Summary

eBPF CO-RE fundamentally changes the eBPF deployment model:

1. **Compile once** against the vmlinux BTF from any representative kernel; the loader patches field offsets at runtime using the target kernel's BTF.
2. **`BPF_CORE_READ`** replaces raw pointer arithmetic with typed, relocatable field accesses that survive kernel updates.
3. **`bpf_core_field_exists`** and `bpf_core_enum_value` handle structural differences between kernel versions without `#ifdef` preprocessor blocks.
4. **Ring buffer maps** provide high-throughput, low-overhead event streaming from kernel to userspace with automatic backpressure.
5. **go:embed + bpf2go** produces a single statically linked binary with embedded BPF objects — no installation of clang, kernel headers, or extra files on target machines.

The result is eBPF programs that deploy as easily as any Go binary while providing deep kernel observability that no userspace tool can match.
