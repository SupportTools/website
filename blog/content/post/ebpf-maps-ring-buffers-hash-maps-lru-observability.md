---
title: "eBPF Maps: Ring Buffers, Hash Maps, and LRU Caches for Observability"
date: 2029-02-24T00:00:00-05:00
draft: false
tags: ["eBPF", "Linux", "Observability", "Performance", "BPF Maps", "Kernel"]
categories:
- Linux
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused deep dive into eBPF map types — ring buffers, hash maps, LRU caches, and per-CPU arrays — covering memory layout, performance characteristics, and practical patterns for kernel-level observability tools."
more_link: "yes"
url: "/ebpf-maps-ring-buffers-hash-maps-lru-observability/"
---

eBPF maps are the shared memory mechanism between eBPF programs running in kernel space and userspace consumers that read, process, and export observability data. The choice of map type determines the performance characteristics, memory usage, and data loss behavior of an eBPF-based tool. Using the wrong map type for a workload — for example, a standard hash map where an LRU cache is appropriate, or a perf event buffer where a ring buffer would reduce overhead — results in dropped events, excessive memory consumption, or unnecessary CPU overhead.

This guide examines the map types that matter most for production observability: ring buffers, hash maps, per-CPU variants, and LRU caches. For each type, the discussion covers internal implementation, appropriate use cases, sizing guidance, and concrete BPF C and Go userspace code.

<!--more-->

## eBPF Map Architecture

All eBPF maps share a common interface: they are created with `bpf_map_create` (or the equivalent libbpf call), identified by a file descriptor, and accessed from BPF programs using helper functions and from userspace using the `bpf()` syscall. Maps are reference-counted — the map persists as long as any file descriptor or BPF program references it.

The key properties that differentiate map types:

- **Concurrency model**: Global maps require spin-locks for atomic updates; per-CPU maps eliminate locking by giving each CPU its own copy.
- **Eviction policy**: Fixed-size maps with no eviction (hash map) vs. LRU maps that evict the least recently used entry when full.
- **Memory vs. event semantics**: Array maps store state; ring buffers and perf event buffers transport events.

## BPF Ring Buffer: The Preferred Event Transport

The ring buffer (`BPF_MAP_TYPE_RINGBUF`) was introduced in Linux 5.8 and is the recommended mechanism for transporting events from eBPF programs to userspace. It supersedes the perf event buffer (`BPF_MAP_TYPE_PERF_EVENT_ARRAY`) for most use cases.

Key advantages over perf event buffer:
- Single buffer shared across all CPUs eliminates per-CPU overhead.
- Memory mapping allows userspace to read events without a syscall per event.
- Reserving and discarding events atomically prevents partial writes.
- Variable-length events without wasted padding.

```c
// SPDX-License-Identifier: GPL-2.0
#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

// Event structure sent from kernel to userspace.
struct connect_event {
    __u32 pid;
    __u32 uid;
    __u8  comm[16];
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    __u64 timestamp_ns;
};

// Ring buffer map — size must be a multiple of the system page size
// and a power of two. 4MB is a reasonable starting point.
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 22);  // 4MB
} events SEC(".maps");

// Trace TCP connect syscall to capture outbound connections.
SEC("tracepoint/syscalls/sys_enter_connect")
int trace_connect(struct trace_event_raw_sys_enter *ctx)
{
    struct connect_event *e;

    // Reserve space in the ring buffer.
    // The kernel guarantees this is atomic — no partial writes.
    e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return 0;  // Buffer full — event dropped.

    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    e->timestamp_ns = bpf_ktime_get_ns();
    bpf_get_current_comm(e->comm, sizeof(e->comm));

    // Submit the event to the ring buffer.
    // After submit, userspace will see the event.
    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

Userspace Go consumer using the `cilium/ebpf` library:

```go
package main

import (
    "bytes"
    "encoding/binary"
    "fmt"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
    "github.com/cilium/ebpf/rlimit"
)

// ConnectEvent mirrors the BPF struct connect_event.
type ConnectEvent struct {
    PID         uint32
    UID         uint32
    Comm        [16]byte
    SAddr       uint32
    DAddr       uint32
    SPort       uint16
    DPort       uint16
    TimestampNs uint64
}

func main() {
    // Remove memory lock limit so BPF maps can be allocated.
    if err := rlimit.RemoveMemlock(); err != nil {
        log.Fatalf("removing memlock: %v", err)
    }

    // Load compiled BPF objects. The //go:generate directive compiles
    // the BPF C code with bpf2go.
    objs := bpfObjects{}
    if err := loadBpfObjects(&objs, nil); err != nil {
        log.Fatalf("loading BPF objects: %v", err)
    }
    defer objs.Close()

    // Attach the tracepoint program.
    tp, err := link.Tracepoint("syscalls", "sys_enter_connect",
        objs.TraceConnect, nil)
    if err != nil {
        log.Fatalf("attaching tracepoint: %v", err)
    }
    defer tp.Close()

    // Create a ring buffer reader.
    rd, err := ringbuf.NewReader(objs.Events)
    if err != nil {
        log.Fatalf("creating ring buffer reader: %v", err)
    }
    defer rd.Close()

    // Handle shutdown signal.
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    go func() {
        <-sigCh
        rd.Close()
    }()

    fmt.Println("Tracing TCP connections... Press Ctrl+C to stop.")
    for {
        record, err := rd.Read()
        if err != nil {
            if err == ringbuf.ErrClosed {
                return
            }
            log.Printf("reading ring buffer: %v", err)
            continue
        }

        var event ConnectEvent
        if err := binary.Read(bytes.NewBuffer(record.RawSample),
            binary.LittleEndian, &event); err != nil {
            log.Printf("decoding event: %v", err)
            continue
        }

        comm := string(bytes.TrimRight(event.Comm[:], "\x00"))
        daddr := net.IP(intToIPv4(event.DAddr))
        fmt.Printf("%-16s PID=%-8d UID=%-6d -> %s:%d\n",
            comm, event.PID, event.UID, daddr.String(), event.DPort)
    }
}

func intToIPv4(n uint32) []byte {
    b := make([]byte, 4)
    binary.LittleEndian.PutUint32(b, n)
    return b
}
```

## Hash Maps: Global State and Per-CPU Variants

Hash maps (`BPF_MAP_TYPE_HASH`) provide O(1) average-case lookup, insert, and delete. They are the right tool for tracking per-connection or per-process state.

```c
// Track active TCP connections: key is (pid, fd), value is connection metadata.
struct connection_key {
    __u32 pid;
    __u32 fd;
};

struct connection_val {
    __u64 start_ns;
    __u32 saddr;
    __u32 daddr;
    __u16 sport;
    __u16 dport;
    __u64 bytes_sent;
    __u64 bytes_recv;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, struct connection_key);
    __type(value, struct connection_val);
    __uint(max_entries, 65536);
    // BPF_F_NO_PREALLOC avoids pre-allocating all 65536 entries at load time.
    // Use for maps that will be sparsely populated.
    __uint(map_flags, BPF_F_NO_PREALLOC);
} connections SEC(".maps");

SEC("kprobe/tcp_connect")
int trace_tcp_connect(struct pt_regs *ctx)
{
    struct connection_key key = {
        .pid = bpf_get_current_pid_tgid() >> 32,
        .fd  = 0,  // Would extract actual fd in production.
    };
    struct connection_val val = {
        .start_ns = bpf_ktime_get_ns(),
    };

    bpf_map_update_elem(&connections, &key, &val, BPF_NOEXIST);
    return 0;
}

SEC("kprobe/tcp_close")
int trace_tcp_close(struct pt_regs *ctx)
{
    struct connection_key key = {
        .pid = bpf_get_current_pid_tgid() >> 32,
        .fd  = 0,
    };

    // Delete on close to prevent unbounded map growth.
    bpf_map_delete_elem(&connections, &key);
    return 0;
}
```

### Per-CPU Hash Maps: Eliminating Lock Contention

When multiple CPUs update the same hash map entry, the BPF runtime must serialize access with a spin-lock. For high-frequency counters, this contention degrades performance. Per-CPU maps (`BPF_MAP_TYPE_PERCPU_HASH`) give each CPU its own value per key, eliminating contention. Userspace aggregates by summing across CPUs.

```c
// Per-CPU hash map for high-frequency syscall counting.
// Each CPU maintains its own counter — no locking required.
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_HASH);
    __type(key, __u32);    // Syscall number
    __type(value, __u64);  // Hit count
    __uint(max_entries, 512);
} syscall_counts SEC(".maps");

SEC("tracepoint/raw_syscalls/sys_enter")
int count_syscalls(struct trace_event_raw_sys_enter *ctx)
{
    __u32 syscall_nr = ctx->id;
    __u64 *count = bpf_map_lookup_elem(&syscall_counts, &syscall_nr);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 initial = 1;
        bpf_map_update_elem(&syscall_counts, &syscall_nr, &initial, BPF_NOEXIST);
    }
    return 0;
}
```

Aggregating per-CPU values in Go:

```go
func aggregateSyscallCounts(m *ebpf.Map) (map[uint32]uint64, error) {
    result := make(map[uint32]uint64)

    var key uint32
    // Per-CPU maps return a slice of values, one per CPU.
    values := make([]uint64, ebpf.MustPossibleCPU())

    iter := m.Iterate()
    for iter.Next(&key, &values) {
        var total uint64
        for _, v := range values {
            total += v
        }
        result[key] = total
    }

    return result, iter.Err()
}
```

## LRU Hash Maps: Bounded Memory for Unbounded Key Spaces

LRU hash maps (`BPF_MAP_TYPE_LRU_HASH`) automatically evict the least recently used entry when the map is full. This is essential for tracking per-IP or per-connection state where the key space is unbounded.

```c
// Track per-source-IP connection counts for DDoS detection.
// When the map fills, the LRU eviction removes cold entries automatically.
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __type(key, __u32);    // Source IP address
    __type(value, __u64);  // Connection count in the last window
    __uint(max_entries, 1 << 16);  // 65536 unique IPs tracked
} ip_conn_count SEC(".maps");

SEC("kprobe/tcp_v4_connect")
int track_ip_connections(struct pt_regs *ctx)
{
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    __u32 saddr;
    bpf_probe_read_kernel(&saddr, sizeof(saddr), &sk->__sk_common.skc_rcv_saddr);

    __u64 *count = bpf_map_lookup_elem(&ip_conn_count, &saddr);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 initial = 1;
        bpf_map_update_elem(&ip_conn_count, &saddr, &initial, BPF_ANY);
    }
    return 0;
}
```

## Array Maps and Per-CPU Arrays

Array maps (`BPF_MAP_TYPE_ARRAY`) use integer indices as keys and are faster than hash maps for small, fixed-size lookup tables. All entries are pre-allocated — the map never grows or shrinks.

```c
// Fixed-size configuration table loaded from userspace at startup.
// Index 0: max_connections, Index 1: rate_limit_rps, Index 2: timeout_ns
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, 16);
} config_table SEC(".maps");

static __always_inline __u64 get_config(__u32 index) {
    __u64 *val = bpf_map_lookup_elem(&config_table, &index);
    return val ? *val : 0;
}

// Per-CPU array for per-CPU statistics without hash overhead.
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __type(key, __u32);    // Stat index
    __type(value, __u64);  // Stat value
    __uint(max_entries, 8);
} stats SEC(".maps");

#define STAT_PACKETS_IN  0
#define STAT_PACKETS_OUT 1
#define STAT_BYTES_IN    2
#define STAT_BYTES_OUT   3
#define STAT_DROPS       4

static __always_inline void increment_stat(__u32 stat, __u64 amount) {
    __u64 *val = bpf_map_lookup_elem(&stats, &stat);
    if (val)
        __sync_fetch_and_add(val, amount);
}
```

## Map-in-Map: Dynamic Program Updates

Maps of maps (`BPF_MAP_TYPE_HASH_OF_MAPS`, `BPF_MAP_TYPE_ARRAY_OF_MAPS`) enable atomic replacement of inner maps without unloading the BPF program. This pattern enables configuration updates to BPF programs at runtime.

```go
// Go code for atomic inner map replacement.
func updateAllowlist(outerMap *ebpf.Map, newAllowedIPs []net.IP) error {
    // Create a new inner map with the updated allowlist.
    innerSpec := &ebpf.MapSpec{
        Type:       ebpf.Hash,
        KeySize:    4,  // IPv4 address
        ValueSize:  1,  // Boolean (allowed = 1)
        MaxEntries: uint32(len(newAllowedIPs) + 64),
    }

    innerMap, err := ebpf.NewMap(innerSpec)
    if err != nil {
        return fmt.Errorf("creating inner map: %w", err)
    }
    defer innerMap.Close()

    // Populate the new inner map.
    for _, ip := range newAllowedIPs {
        ip4 := ip.To4()
        if ip4 == nil {
            continue
        }
        key := binary.LittleEndian.Uint32(ip4)
        val := uint8(1)
        if err := innerMap.Put(key, val); err != nil {
            return fmt.Errorf("inserting IP %s: %w", ip, err)
        }
    }

    // Atomically replace the inner map at key 0 in the outer map.
    // BPF programs using the outer map immediately see the new inner map.
    outerKey := uint32(0)
    return outerMap.Put(outerKey, innerMap)
}
```

## Ring Buffer Sizing and Overflow Handling

The ring buffer size determines the burst capacity of the event pipeline. If the userspace consumer falls behind, the kernel fills the buffer and subsequent `bpf_ringbuf_reserve` calls return NULL (the event is dropped).

```bash
# Monitor ring buffer statistics via bpftool.
bpftool map show name events

# Check the dropped event counter (requires kernel >= 5.15).
bpftool map dump name events | grep -i drop

# Monitor in real time with bpftrace.
bpftrace -e '
tracepoint:bpf:bpf_trace_printk {
    @drops = count();
}
interval:s:1 {
    print(@drops);
    clear(@drops);
}
'

# Estimate required ring buffer size:
# max_events_per_second * avg_event_size * drain_latency_seconds * safety_margin
# Example: 100000 events/s * 128 bytes * 0.1s drain latency * 2 = ~2.5MB
# Round up to next power-of-two page-aligned size: 4MB (1 << 22)
python3 -c "
events_per_sec = 100_000
event_size = 128
drain_latency = 0.1
safety_margin = 2
required = events_per_sec * event_size * drain_latency * safety_margin
import math
pages = math.ceil(required / 4096)
power_of_two = 2 ** math.ceil(math.log2(pages))
print(f'Required: {required/1024:.0f} KB')
print(f'Recommended size: {power_of_two * 4096} bytes ({power_of_two * 4096 // 1024 // 1024} MB)')
print(f'BPF definition: __uint(max_entries, 1 << {int(math.ceil(math.log2(power_of_two * 4096)))})')
"
```

## Complete Observability Tool: HTTP Latency Tracker

```c
// http_latency.bpf.c — track HTTP request latency via socket probes.
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct latency_key {
    __u32 pid;
    __u64 socket_ptr;
};

struct latency_val {
    __u64 start_ns;
    __u32 saddr;
    __u16 dport;
};

struct latency_event {
    __u32 pid;
    __u8  comm[16];
    __u64 duration_ns;
    __u32 daddr;
    __u16 dport;
    __u16 status_code;
};

// Track in-flight requests: map from (pid, socket) -> start time.
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __type(key, struct latency_key);
    __type(value, struct latency_val);
    __uint(max_entries, 8192);
} in_flight SEC(".maps");

// Export completed request latencies.
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 23);  // 8MB
} latency_events SEC(".maps");

// Histogram buckets for latency distribution (per CPU to avoid locking).
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __type(key, __u32);     // Bucket index (0=<1ms, 1=<10ms, 2=<100ms, 3=>=100ms)
    __type(value, __u64);   // Count
    __uint(max_entries, 4);
} latency_histogram SEC(".maps");

char LICENSE[] SEC("license") = "GPL";
```

eBPF maps are the foundation of production-grade kernel observability. Selecting the right map type — ring buffer for event streaming, per-CPU hash maps for high-frequency counters, LRU maps for unbounded state, and array maps for configuration — produces tools that observe production systems with sub-microsecond overhead while maintaining correctness under high-load conditions.
