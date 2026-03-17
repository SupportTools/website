---
title: "Linux eBPF Maps: Advanced Data Structures for High-Performance Observability"
date: 2030-11-26T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "BPF Maps", "Observability", "Performance", "Cilium", "Go", "Kernel"]
categories:
- Linux
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into eBPF map types including hash, array, LRU, ring buffer, and perf event arrays, covering map-in-map patterns, concurrent access semantics, Go userspace access with cilium/ebpf, and production telemetry use cases."
more_link: "yes"
url: "/linux-ebpf-maps-advanced-data-structures-high-performance-observability/"
---

eBPF programs running in the kernel need to communicate with userspace processes, share state across CPU cores, and maintain per-connection metrics without expensive system call overhead. eBPF maps provide the solution: kernel data structures accessible from both eBPF programs (via helper functions) and userspace processes (via file descriptors). They are the backbone of modern network observability tools, security agents, and performance profilers.

This guide covers every production-relevant eBPF map type, their access semantics and performance characteristics, map-in-map patterns for dynamic routing tables, and Go userspace access using the `cilium/ebpf` library with complete working examples for a network telemetry collection system.

<!--more-->

# Linux eBPF Maps: Advanced Data Structures for High-Performance Observability

## Section 1: eBPF Map Fundamentals

An eBPF map is a generic key-value store managed by the kernel. Maps are created by userspace via the `bpf()` syscall and identified by a file descriptor. eBPF programs access maps via helper functions like `bpf_map_lookup_elem()` and `bpf_map_update_elem()`.

### Map Lifecycle

```
Userspace                          Kernel
─────────                          ──────
bpf(BPF_MAP_CREATE, ...)  ──────▶  map_fd = new_map(type, key_size, value_size, max_entries)
                           ◀──────  return fd

bpf(BPF_PROG_LOAD, ...)   ──────▶  verify_program()
  [references map_fd]                  - checks map access patterns
                           ◀──────  return prog_fd

attach_prog(prog_fd, ...)  ──────▶  attach to XDP/tracepoint/kprobe

                                    [packet arrives]
                                    prog runs in kernel
                                      bpf_map_lookup_elem(&my_map, &key)
                                      bpf_map_update_elem(&my_map, &key, &val, BPF_ANY)

read_map(map_fd, key)      ──────▶  copy_to_user(userspace_buffer, map_value)
                           ◀──────  return value
```

### Map Pinning

Maps can be pinned to the BPF filesystem to persist across program loads:

```bash
# Mount BPF filesystem (done automatically on modern systems)
mount -t bpf bpf /sys/fs/bpf

# Pin a map by ID
bpftool map pin id 42 /sys/fs/bpf/my_conn_map

# View map contents
bpftool map dump pinned /sys/fs/bpf/my_conn_map

# Check all loaded maps
bpftool map list
# 42  lru_hash      KEY 13B  VALUE 28B  MAX_ENTRIES 500000  MEMLOCK 32MB
```

## Section 2: Map Types Reference

### BPF_MAP_TYPE_HASH

The most general-purpose map. Uses a hash table internally with configurable pre-allocated buckets.

```c
// eBPF kernel program: connection counting per source IP
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(key_size, sizeof(__u32));    // IPv4 address
    __uint(value_size, sizeof(__u64));  // packet count
    __uint(max_entries, 65536);
    __uint(map_flags, BPF_F_NO_PREALLOC); // Allocate on demand
} conn_count_map SEC(".maps");

SEC("xdp")
int count_connections(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_PASS;
    if (eth->h_proto != __constant_htons(ETH_P_IP)) return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end) return XDP_PASS;

    __u32 src_ip = ip->saddr;

    __u64 *count = bpf_map_lookup_elem(&conn_count_map, &src_ip);
    if (count) {
        __sync_fetch_and_add(count, 1);  // atomic increment
    } else {
        __u64 initial = 1;
        bpf_map_update_elem(&conn_count_map, &src_ip, &initial, BPF_NOEXIST);
    }

    return XDP_PASS;
}
```

### BPF_MAP_TYPE_ARRAY

Array maps use integer indices as keys. Pre-allocated and ideal for per-CPU statistics:

```c
struct global_stats {
    __u64 rx_packets;
    __u64 rx_bytes;
    __u64 tx_packets;
    __u64 tx_bytes;
    __u64 drops;
};

// Per-CPU array eliminates lock contention on hot paths
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(key_size, sizeof(__u32));
    __type(value, struct global_stats);
    __uint(max_entries, 1);
} percpu_stats SEC(".maps");

SEC("xdp")
int count_bytes(struct xdp_md *ctx) {
    __u32 key = 0;
    struct global_stats *s = bpf_map_lookup_elem(&percpu_stats, &key);
    if (!s) return XDP_PASS;

    // No atomic needed — this CPU's private copy
    s->rx_packets++;
    s->rx_bytes += ctx->data_end - ctx->data;

    return XDP_PASS;
}
```

### BPF_MAP_TYPE_LRU_HASH

LRU maps automatically evict the least recently used entry when full, making them ideal for connection tracking:

```c
struct conn_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  proto;
    __u8  pad[3];
};

struct conn_state {
    __u64 first_seen_ns;
    __u64 last_seen_ns;
    __u32 syn_count;
    __u8  state;  // 0=SYN, 1=ESTABLISHED, 2=CLOSE
    __u8  pad[3];
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __type(key, struct conn_key);
    __type(value, struct conn_state);
    __uint(max_entries, 500000);  // Fixed cap; LRU evicts oldest
} conn_tracker SEC(".maps");

// Per-CPU LRU for higher throughput on multi-core systems
struct {
    __uint(type, BPF_MAP_TYPE_LRU_PERCPU_HASH);
    __type(key, struct conn_key);
    __type(value, struct conn_state);
    __uint(max_entries, 100000);
} conn_tracker_percpu SEC(".maps");
```

### BPF_MAP_TYPE_RINGBUF

Ring buffer maps (kernel 5.8+) replace perf event arrays for most streaming use cases. They support variable-length records and provide stronger ordering guarantees:

```c
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1024 * 1024);  // 1MB ring buffer
} events SEC(".maps");

#define EVENT_NEW_CONN   1
#define EVENT_CONN_CLOSE 2

struct event {
    __u64 timestamp_ns;
    __u32 pid;
    __u32 uid;
    __u8  type;
    __u8  pad[3];
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
};

SEC("kprobe/tcp_connect")
int trace_tcp_connect(struct pt_regs *ctx) {
    // Reserve space in ring buffer — zero-copy path
    struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) return 0;

    e->timestamp_ns = bpf_ktime_get_ns();
    e->pid  = bpf_get_current_pid_tgid() >> 32;
    e->uid  = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    e->type = EVENT_NEW_CONN;

    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    bpf_probe_read_kernel(&e->src_ip, 4, &sk->__sk_common.skc_rcv_saddr);
    bpf_probe_read_kernel(&e->dst_ip, 4, &sk->__sk_common.skc_daddr);

    bpf_ringbuf_submit(e, 0);
    return 0;
}
```

### BPF_MAP_TYPE_PERF_EVENT_ARRAY

Still useful for kernels < 5.8 or per-CPU fan-out scenarios:

```c
struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
} perf_events SEC(".maps");

SEC("tracepoint/syscalls/sys_enter_openat")
int trace_openat(struct trace_event_raw_sys_enter *ctx) {
    struct event e = {};
    e.timestamp_ns = bpf_ktime_get_ns();
    e.pid  = bpf_get_current_pid_tgid() >> 32;
    e.type = 3; // EVENT_FILE_OPEN

    bpf_perf_event_output(ctx, &perf_events, BPF_F_CURRENT_CPU, &e, sizeof(e));
    return 0;
}
```

## Section 3: Map-in-Map Patterns

Map-in-map allows dynamic routing tables and per-interface isolation:

```c
// Inner map prototype
struct inner_map_proto {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, struct conn_key);
    __uint(value_size, sizeof(__u64));
    __uint(max_entries, 10000);
} inner_map_proto SEC(".maps");

// Outer map: interface index -> inner connection-stats map
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY_OF_MAPS);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
    __uint(max_entries, 256);
    __array(values, struct inner_map_proto);
} per_iface_stats SEC(".maps");

SEC("xdp")
int per_interface_stats(struct xdp_md *ctx) {
    __u32 ifindex = ctx->ingress_ifindex;

    void *inner = bpf_map_lookup_elem(&per_iface_stats, &ifindex);
    if (!inner) return XDP_PASS;

    struct conn_key key = {};
    // ... fill key from packet headers ...
    __u64 *count = bpf_map_lookup_elem(inner, &key);
    if (count) __sync_fetch_and_add(count, 1);

    return XDP_PASS;
}
```

## Section 4: Concurrent Access Patterns

### Spin Locks in eBPF Maps (kernel 5.1+)

For complex multi-field updates requiring atomicity:

```c
struct rate_limit {
    struct bpf_spin_lock lock;
    __u64 tokens;
    __u64 last_refill_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, struct rate_limit);
    __uint(max_entries, 65536);
} rate_limits SEC(".maps");

static __always_inline bool check_rate_limit(__u32 client_ip, __u64 now_ns) {
    struct rate_limit *rl = bpf_map_lookup_elem(&rate_limits, &client_ip);
    if (!rl) return true;

    bpf_spin_lock(&rl->lock);

    __u64 elapsed   = now_ns - rl->last_refill_ns;
    __u64 add_tokens = elapsed / 1000000;  // 1 token per ms
    __u64 new_tokens = rl->tokens + add_tokens;
    rl->tokens       = new_tokens > 100 ? 100 : new_tokens;
    rl->last_refill_ns = now_ns;

    bool allowed = rl->tokens > 0;
    if (allowed) rl->tokens--;

    bpf_spin_unlock(&rl->lock);
    return allowed;
}
```

## Section 5: Go Userspace Access with cilium/ebpf

### Project Setup

```bash
# Install bpf2go code generator
go install github.com/cilium/ebpf/cmd/bpf2go@latest

# Project structure
network-telemetry/
├── bpf/
│   └── telemetry.c       # eBPF C program
├── main.go               # Go userspace program
├── telemetry_bpfeb.go    # Generated (big-endian)
├── telemetry_bpfel.go    # Generated (little-endian)
└── go.mod
```

```go
// gen.go - triggers bpf2go
//go:build ignore

package main

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go \
//    -cc clang \
//    -cflags "-O2 -g -Wall -Werror" \
//    telemetry ./bpf/telemetry.c
```

### Complete Go Telemetry Collector

```go
// collector/collector.go
package collector

import (
    "bytes"
    "context"
    "encoding/binary"
    "errors"
    "fmt"
    "log/slog"
    "net"
    "os"
    "time"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
    "github.com/cilium/ebpf/rlimit"
)

// Event mirrors the C struct event
type Event struct {
    TimestampNs uint64
    PID         uint32
    UID         uint32
    Type        uint8
    _           [3]byte
    SrcIP       [4]byte
    DstIP       [4]byte
    SrcPort     uint16
    DstPort     uint16
}

func (e Event) String() string {
    return fmt.Sprintf("[%s] pid=%d %s:%d -> %s:%d",
        time.Unix(0, int64(e.TimestampNs)).Format(time.RFC3339Nano),
        e.PID,
        net.IP(e.SrcIP[:]).String(), e.SrcPort,
        net.IP(e.DstIP[:]).String(), e.DstPort,
    )
}

// Collector manages eBPF programs and maps
type Collector struct {
    objs   telemetryObjects
    links  []link.Link
    reader *ringbuf.Reader
    logger *slog.Logger
    events chan Event
}

func New(logger *slog.Logger) (*Collector, error) {
    // Remove RLIMIT_MEMLOCK restriction (required for eBPF)
    if err := rlimit.RemoveMemlock(); err != nil {
        return nil, fmt.Errorf("remove memlock: %w", err)
    }

    objs := telemetryObjects{}
    if err := loadTelemetryObjects(&objs, nil); err != nil {
        var verr *ebpf.VerifierError
        if errors.As(err, &verr) {
            return nil, fmt.Errorf("verifier rejected program:\n%+v", verr)
        }
        return nil, fmt.Errorf("load ebpf objects: %w", err)
    }

    rd, err := ringbuf.NewReader(objs.Events)
    if err != nil {
        objs.Close()
        return nil, fmt.Errorf("open ringbuf reader: %w", err)
    }

    return &Collector{
        objs:   objs,
        reader: rd,
        logger: logger,
        events: make(chan Event, 4096),
    }, nil
}

func (c *Collector) AttachXDP(iface string) error {
    netIface, err := net.InterfaceByName(iface)
    if err != nil {
        return fmt.Errorf("interface %s: %w", iface, err)
    }

    l, err := link.AttachXDP(link.XDPOptions{
        Program:   c.objs.CountConnections,
        Interface: netIface.Index,
        // Use link.XDPDriverMode in production for better performance
        Flags: link.XDPGenericMode,
    })
    if err != nil {
        return fmt.Errorf("attach XDP to %s: %w", iface, err)
    }

    c.links = append(c.links, l)
    c.logger.Info("attached XDP", "interface", iface)
    return nil
}

func (c *Collector) AttachKprobe() error {
    l, err := link.Kprobe("tcp_connect", c.objs.TraceTcpConnect, nil)
    if err != nil {
        return fmt.Errorf("attach kprobe tcp_connect: %w", err)
    }
    c.links = append(c.links, l)
    return nil
}

func (c *Collector) Run(ctx context.Context) {
    go func() {
        for {
            rec, err := c.reader.Read()
            if err != nil {
                if errors.Is(err, ringbuf.ErrClosed) {
                    return
                }
                if errors.Is(err, os.ErrDeadlineExceeded) {
                    select {
                    case <-ctx.Done():
                        return
                    default:
                        continue
                    }
                }
                c.logger.Error("ringbuf read", "error", err)
                continue
            }

            var e Event
            if err := binary.Read(
                bytes.NewReader(rec.RawSample),
                binary.NativeEndian,
                &e,
            ); err != nil {
                c.logger.Error("decode event", "error", err)
                continue
            }

            select {
            case c.events <- e:
            default:
                // Drop event if buffer is full — observe via metric
            }
        }
    }()
}

func (c *Collector) Events() <-chan Event { return c.events }

// GetConnectionCount returns packet count for a source IP
func (c *Collector) GetConnectionCount(srcIP net.IP) (uint64, error) {
    var key [4]byte
    copy(key[:], srcIP.To4())

    var count uint64
    if err := c.objs.ConnCountMap.Lookup(key, &count); err != nil {
        if errors.Is(err, ebpf.ErrKeyNotExist) {
            return 0, nil
        }
        return 0, err
    }
    return count, nil
}

// GetAggregatedStats sums per-CPU counters into a single struct
func (c *Collector) GetAggregatedStats() (map[string]uint64, error) {
    numCPUs, err := ebpf.PossibleCPU()
    if err != nil {
        return nil, err
    }

    var key uint32
    type perCPUStat struct {
        RxPackets uint64
        RxBytes   uint64
        TxPackets uint64
        TxBytes   uint64
        Drops     uint64
    }

    perCPU := make([]perCPUStat, numCPUs)
    if err := c.objs.PercpuStats.Lookup(key, &perCPU); err != nil {
        return nil, err
    }

    totals := map[string]uint64{
        "rx_packets": 0,
        "rx_bytes":   0,
        "tx_packets": 0,
        "tx_bytes":   0,
        "drops":      0,
    }
    for _, v := range perCPU {
        totals["rx_packets"] += v.RxPackets
        totals["rx_bytes"]   += v.RxBytes
        totals["tx_packets"] += v.TxPackets
        totals["tx_bytes"]   += v.TxBytes
        totals["drops"]      += v.Drops
    }

    return totals, nil
}

func (c *Collector) Close() error {
    for _, l := range c.links {
        l.Close()
    }
    c.reader.Close()
    return c.objs.Close()
}
```

## Section 6: Map Size Tuning

```go
// pkg/sizing/maps.go
package sizing

import (
    "os"
    "runtime"
    "strconv"
    "strings"
)

type MapConfig struct {
    HashMaxEntries      uint32
    LRUMaxEntries       uint32
    RingBufBytes        uint32
    PerCPUHashMaxEntries uint32
}

// Recommended returns map sizes tuned to available system memory
func Recommended() MapConfig {
    memKB := memTotalKB()

    switch {
    case memKB > 64*1024*1024: // > 64 GB
        return MapConfig{
            HashMaxEntries:       2_000_000,
            LRUMaxEntries:        500_000,
            RingBufBytes:         4 * 1024 * 1024,
            PerCPUHashMaxEntries: 100_000,
        }
    case memKB > 16*1024*1024: // > 16 GB
        return MapConfig{
            HashMaxEntries:       500_000,
            LRUMaxEntries:        200_000,
            RingBufBytes:         1 * 1024 * 1024,
            PerCPUHashMaxEntries: 50_000,
        }
    default:
        return MapConfig{
            HashMaxEntries:       100_000,
            LRUMaxEntries:        50_000,
            RingBufBytes:         256 * 1024,
            PerCPUHashMaxEntries: 10_000,
        }
    }
}

// MemBytes returns expected kernel memory for a hash map
func MemBytes(keySize, valSize, maxEntries uint32, percpu bool) uint64 {
    perEntry := uint64(keySize+valSize) * 130 / 100 // 30% hash table overhead
    if percpu {
        perEntry *= uint64(runtime.NumCPU())
    }
    return uint64(maxEntries) * perEntry
}

func memTotalKB() uint64 {
    data, _ := os.ReadFile("/proc/meminfo")
    for _, line := range strings.Split(string(data), "\n") {
        if strings.HasPrefix(line, "MemTotal:") {
            fields := strings.Fields(line)
            if len(fields) >= 2 {
                v, _ := strconv.ParseUint(fields[1], 10, 64)
                return v
            }
        }
    }
    return 0
}
```

## Section 7: Prometheus Integration

```go
// pkg/metrics/ebpf_collector.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
)

type EBPFCollector struct {
    getStats func() (map[string]uint64, error)

    rxPackets *prometheus.Desc
    rxBytes   *prometheus.Desc
    drops     *prometheus.Desc
}

func NewEBPFCollector(getStats func() (map[string]uint64, error)) *EBPFCollector {
    return &EBPFCollector{
        getStats: getStats,
        rxPackets: prometheus.NewDesc(
            "ebpf_rx_packets_total",
            "Total packets received, tracked by eBPF XDP",
            []string{"interface"}, nil,
        ),
        rxBytes: prometheus.NewDesc(
            "ebpf_rx_bytes_total",
            "Total bytes received, tracked by eBPF XDP",
            []string{"interface"}, nil,
        ),
        drops: prometheus.NewDesc(
            "ebpf_drops_total",
            "Total packets dropped by eBPF XDP program",
            []string{"interface"}, nil,
        ),
    }
}

func (e *EBPFCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- e.rxPackets
    ch <- e.rxBytes
    ch <- e.drops
}

func (e *EBPFCollector) Collect(ch chan<- prometheus.Metric) {
    stats, err := e.getStats()
    if err != nil {
        return
    }

    iface := "eth0"
    ch <- prometheus.MustNewConstMetric(
        e.rxPackets, prometheus.CounterValue, float64(stats["rx_packets"]), iface)
    ch <- prometheus.MustNewConstMetric(
        e.rxBytes, prometheus.CounterValue, float64(stats["rx_bytes"]), iface)
    ch <- prometheus.MustNewConstMetric(
        e.drops, prometheus.CounterValue, float64(stats["drops"]), iface)
}
```

## Section 8: Debugging eBPF Maps

```bash
# List all loaded maps with sizes
bpftool map list
# ID  TYPE           KEY  VALUE  MAX_ENTRIES  MEMLOCK
# 42  lru_hash       13B  28B    500000       32MB
# 43  ringbuf        0B   0B     1048576      1MB
# 44  percpu_array   4B   40B    1            640KB

# Dump map contents (all entries)
bpftool map dump id 42

# Look up a specific key (hex-encoded)
bpftool map lookup id 42 key 0a 00 00 01  # 10.0.0.1

# Watch kernel trace output (for bpf_printk debugging)
cat /sys/kernel/debug/tracing/trace_pipe

# Check verifier output for a loaded program
bpftool prog dump xlated id 10

# Profile eBPF map access overhead
perf stat -e bpf:* -a -- sleep 10

# Check rlimit for current process
cat /proc/self/limits | grep "locked memory"
# The line should show "unlimited" after calling rlimit.RemoveMemlock()

# Inspect ring buffer consumer position
bpftool map show id 43
# Useful fields: bytes_written, bytes_read, drop_count

# Monitor map update rate
bpftool prog profile id 10 duration 5 cycles instructions
```

## Section 9: Production Deployment Checklist

```bash
# 1. Verify kernel version (5.8+ for ring buffer, 5.1+ for spin locks)
uname -r

# 2. Check BTF availability (required for CO-RE)
ls /sys/kernel/btf/vmlinux || echo "BTF not available - may need vmlinux.h"

# 3. Verify BPF JIT is enabled (critical for performance)
cat /proc/sys/net/core/bpf_jit_enable
# Should be 1 or 2 (2 = JIT with diagnostics)
echo 1 > /proc/sys/net/core/bpf_jit_enable

# 4. Check available locked memory before deployment
ulimit -l
# Should be unlimited after rlimit.RemoveMemlock() in Go code

# 5. Verify XDP driver support for your NIC
ethtool -i eth0 | grep driver
# Drivers with native XDP: mlx5, i40e, ixgbe, nfp, enic
# Others fall back to generic XDP (still works, higher latency)

# 6. Monitor dropped events (indicates ring buffer too small)
bpftool map show pinned /sys/fs/bpf/events | grep drop

# 7. Check eBPF program verification logs on load failure
dmesg | grep -i "bpf\|ebpf" | tail -20
```

## Conclusion

eBPF maps form the essential communication layer between kernel and userspace in modern observability systems. The key to production success is choosing the right map type for each use case:

- **HASH**: General-purpose lookups with bounded key-value patterns
- **LRU_HASH**: Connection tracking where unbounded growth is unacceptable; automatic eviction prevents OOM
- **PERCPU_ARRAY/HASH**: Hot-path statistics counters — eliminates cross-CPU lock contention entirely
- **RINGBUF**: Streaming events to userspace (kernel 5.8+) — superior to PERF_EVENT_ARRAY in almost all scenarios
- **ARRAY_OF_MAPS**: Dynamic per-interface or per-tenant routing tables

The `cilium/ebpf` library with `bpf2go` provides a maintainable Go workflow: write kernel programs in C, generate type-safe Go bindings at compile time, and access maps via idiomatic Go APIs. This combination enables production telemetry collectors and security agents that observe network traffic, system calls, and resource usage with near-zero overhead in the kernel data path.
