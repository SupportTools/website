---
title: "Linux eBPF Networking: TC Classifiers, Redirect Maps, XDP Combined Pipelines, and XDP_PASS/DROP"
date: 2031-11-20T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "XDP", "TC", "Networking", "Kernel", "Performance", "BPF"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Linux eBPF networking: implementing TC (Traffic Control) classifiers for packet processing, using redirect maps for efficient packet forwarding, building combined XDP and TC pipelines, and understanding XDP_PASS/DROP/REDIRECT semantics for high-performance network applications."
more_link: "yes"
url: "/linux-ebpf-networking-tc-classifier-redirect-maps-xdp-pipeline-guide/"
---

eBPF has fundamentally changed Linux networking. What previously required kernel module development or userspace packet processing (DPDK) can now be implemented as BPF programs that run safely in the kernel, verified by the BPF verifier, and loaded without rebooting. The TC (Traffic Control) subsystem and XDP (eXpress Data Path) provide two complementary attachment points — each with different capabilities, access to packet data, and performance characteristics.

This guide covers both layers in depth: the XDP hook for maximum-speed early packet processing, TC classifiers for flexible bidirectional processing with full socket and routing context, redirect maps for zero-copy forwarding between interfaces, and how to compose XDP and TC programs into production networking pipelines.

<!--more-->

# Linux eBPF Networking: XDP and TC Deep Dive

## XDP vs TC: When to Use Each

Before writing code, understand the architectural difference:

### XDP (eXpress Data Path)

XDP programs attach to the receive path of a network interface **before** the kernel allocates an sk_buff (socket buffer). This makes it extremely fast but limited:

- **Position**: Just after NIC driver receives the packet
- **Context**: `struct xdp_md` — pointer to packet start/end, ingress interface ID
- **Access**: Raw packet bytes only; no socket context, no routing table
- **Actions**: XDP_PASS, XDP_DROP, XDP_REDIRECT, XDP_TX, XDP_ABORTED
- **Direction**: Ingress only
- **Performance**: Can reach line rate on 10Gbps+ NICs (millions of PPS)
- **Use cases**: DDoS mitigation, load balancing (Katran), firewall fast path

### TC (Traffic Control)

TC BPF programs attach to the TC ingress or egress hook on a netdevice, after sk_buff allocation:

- **Position**: TC layer (after sk_buff allocation)
- **Context**: `struct __sk_buff` — full socket buffer, with metadata, IP/port info
- **Access**: sk_buff data, conntrack state, cgroup info, socket options
- **Actions**: TC_ACT_OK, TC_ACT_SHOT, TC_ACT_REDIRECT, TC_ACT_PIPE
- **Direction**: Both ingress and egress
- **Performance**: Lower than XDP but still very fast; full Linux networking context
- **Use cases**: Policy enforcement, monitoring, NAT, traffic shaping

### Hybrid Strategy

The most powerful deployments combine both:
- XDP handles the fast path (DDoS mitigation, known-good packet forwarding)
- TC handles the slow path (new connection policy, monitoring, NAT)

## Setting Up the Development Environment

```bash
# Install BPF development tools
apt-get install -y \
  clang llvm \
  linux-headers-$(uname -r) \
  libbpf-dev \
  bpftool \
  iproute2 \
  libelf-dev

# Verify BTF support (required for CO-RE BPF programs)
ls /sys/kernel/btf/vmlinux

# Verify BPF syscall support
ls /proc/sys/kernel/bpf_stats_enabled
```

## XDP Program Fundamentals

### Hello World XDP: Count and Drop ICMP

```c
// xdp_drop_icmp.c
// Compile with: clang -O2 -target bpf -c xdp_drop_icmp.c -o xdp_drop_icmp.o

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/icmp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Per-CPU array for statistics (lock-free, cache-hot)
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 2);
    __type(key, __u32);
    __type(value, __u64);
} stats_map SEC(".maps");

#define STAT_PASS  0
#define STAT_DROP  1

static __always_inline void count_stat(__u32 key) {
    __u64 *counter = bpf_map_lookup_elem(&stats_map, &key);
    if (counter)
        __sync_fetch_and_add(counter, 1);
}

SEC("xdp")
int xdp_drop_icmp_prog(struct xdp_md *ctx) {
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // Only handle IPv4
    if (bpf_ntohs(eth->h_proto) != ETH_P_IP) {
        count_stat(STAT_PASS);
        return XDP_PASS;
    }

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Drop ICMP
    if (ip->protocol == IPPROTO_ICMP) {
        count_stat(STAT_DROP);
        return XDP_DROP;
    }

    count_stat(STAT_PASS);
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

```c
// Build script
// clang -O2 -g -target bpf \
//   -D__TARGET_ARCH_x86 \
//   -I/usr/include/bpf \
//   -I/usr/include/x86_64-linux-gnu \
//   -c xdp_drop_icmp.c \
//   -o xdp_drop_icmp.o
```

Load the XDP program:

```bash
# Load in native mode (fastest, requires driver support)
ip link set dev eth0 xdp obj xdp_drop_icmp.o sec xdp

# Load in generic mode (software, works on any interface)
ip link set dev eth0 xdpgeneric obj xdp_drop_icmp.o sec xdp

# Verify it is attached
ip link show eth0
# Should show: xdp/id:42 (or similar)

# Inspect with bpftool
bpftool net show dev eth0
bpftool prog show

# Read statistics
bpftool map dump name stats_map
```

## XDP_REDIRECT and devmap for Fast Packet Forwarding

XDP_REDIRECT is the key to zero-copy, kernel-bypass-like performance. It redirects packets between interfaces without going through the full Linux networking stack.

### devmap: Interface Index Map

```c
// xdp_redirect.c
// Forwards packets based on destination IP to a pre-configured interface

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// devmap: maps interface indices to XDP redirect targets
// Key: arbitrary index (e.g., route entry ID)
// Value: target interface ifindex
struct {
    __uint(type, BPF_MAP_TYPE_DEVMAP);
    __uint(max_entries, 256);
    __type(key, __u32);
    __type(value, __u32);
} tx_port SEC(".maps");

// LPM trie for IP routing decisions
struct lpm_key {
    __u32 prefixlen;
    __u32 addr;
};

struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __uint(max_entries, 1024);
    __type(key, struct lpm_key);
    __type(value, __u32);       // devmap key
    __uint(map_flags, BPF_F_NO_PREALLOC);
} routing_table SEC(".maps");

SEC("xdp")
int xdp_router(struct xdp_md *ctx) {
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Look up destination in routing table
    struct lpm_key key = {
        .prefixlen = 32,
        .addr = ip->daddr,
    };

    __u32 *devmap_key = bpf_map_lookup_elem(&routing_table, &key);
    if (!devmap_key)
        return XDP_PASS;

    // Redirect to the target interface via devmap
    return bpf_redirect_map(&tx_port, *devmap_key, XDP_PASS);
}

char _license[] SEC("license") = "GPL";
```

Load and configure routing:

```bash
# Load the program
ip link set dev eth0 xdp obj xdp_redirect.o sec xdp

# Get the ifindex of the output interface
cat /sys/class/net/eth1/ifindex
# e.g., 3

# Also attach an XDP program to the TX interface (required for DEVMAP redirect)
ip link set dev eth1 xdp obj xdp_pass.o sec xdp

# Configure devmap: key 0 -> ifindex 3 (eth1)
bpftool map update name tx_port key 0 0 0 0 value 3 0 0 0

# Configure routing table: 10.0.1.0/24 -> devmap key 0
# Key format: 24 (prefixlen as BE32) + 10.0.1.0 as BE32
bpftool map update name routing_table \
  key 24 0 0 0 10 0 1 0 \
  value 0 0 0 0
```

## TC BPF Programs

TC programs operate after sk_buff allocation, giving access to the full packet context.

### TC Egress: Add Custom Header

```c
// tc_add_header.c
// Adds a custom VxLAN-like encapsulation header in TC egress
// Compile: clang -O2 -target bpf -c tc_add_header.c -o tc_add_header.o

#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define VXLAN_HDRLEN 8
#define ENCAP_OVERHEAD (sizeof(struct ethhdr) + sizeof(struct iphdr) + \
                        sizeof(struct udphdr) + VXLAN_HDRLEN)

struct vxlan_hdr {
    __u32 vx_flags;
    __u32 vx_vni;
};

SEC("tc")
int tc_encap(struct __sk_buff *skb) {
    // Reserve space for encapsulation headers
    if (bpf_skb_adjust_room(skb, ENCAP_OVERHEAD,
                            BPF_ADJ_ROOM_MAC,
                            BPF_F_ADJ_ROOM_ENCAP_L3_IPV4 |
                            BPF_F_ADJ_ROOM_ENCAP_L4_UDP |
                            BPF_F_ADJ_ROOM_ENCAP_L2(sizeof(struct ethhdr))))
        return TC_ACT_SHOT;

    return TC_ACT_OK;
}

char _license[] SEC("license") = "GPL";
```

### TC Ingress: L7-Aware Traffic Classification

```c
// tc_l7_classifier.c
// Classifies HTTP vs HTTPS traffic and marks sk_buff priority

#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define HTTP_PORT  80
#define HTTPS_PORT 443

// Per-CPU statistics
struct traffic_stats {
    __u64 http_packets;
    __u64 https_packets;
    __u64 other_packets;
    __u64 http_bytes;
    __u64 https_bytes;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct traffic_stats);
} traffic_map SEC(".maps");

SEC("tc")
int tc_classifier(struct __sk_buff *skb) {
    void *data     = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    __u32 key = 0;
    struct traffic_stats *stats = bpf_map_lookup_elem(&traffic_map, &key);
    if (!stats)
        return TC_ACT_OK;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        goto other;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    if (ip->protocol != IPPROTO_TCP)
        goto other;

    // Calculate IP header length (variable due to options)
    __u32 ip_hdr_len = ip->ihl * 4;
    struct tcphdr *tcp = (void *)ip + ip_hdr_len;
    if ((void *)(tcp + 1) > data_end)
        return TC_ACT_OK;

    __u16 dport = bpf_ntohs(tcp->dest);
    __u16 sport = bpf_ntohs(tcp->source);

    if (dport == HTTP_PORT || sport == HTTP_PORT) {
        __sync_fetch_and_add(&stats->http_packets, 1);
        __sync_fetch_and_add(&stats->http_bytes, skb->len);
        // Mark for QoS: HTTP gets lower priority than HTTPS
        skb->priority = 4;
        return TC_ACT_OK;
    }

    if (dport == HTTPS_PORT || sport == HTTPS_PORT) {
        __sync_fetch_and_add(&stats->https_packets, 1);
        __sync_fetch_and_add(&stats->https_bytes, skb->len);
        skb->priority = 6;
        return TC_ACT_OK;
    }

other:
    __sync_fetch_and_add(&stats->other_packets, 1);
    return TC_ACT_OK;
}

char _license[] SEC("license") = "GPL";
```

### Loading TC Programs with iproute2

```bash
# TC BPF requires a qdisc (queue discipline) first
# Add clsact qdisc (lightweight, for BPF classifiers)
tc qdisc add dev eth0 clsact

# Load ingress classifier
tc filter add dev eth0 ingress \
  bpf da obj tc_l7_classifier.o sec tc \
  verbose

# Load egress program
tc filter add dev eth0 egress \
  bpf da obj tc_encap.o sec tc \
  verbose

# Show loaded TC programs
tc filter show dev eth0 ingress
tc filter show dev eth0 egress

# Show statistics
bpftool map dump name traffic_map

# Delete programs
tc filter del dev eth0 ingress
tc qdisc del dev eth0 clsact
```

## Combined XDP + TC Pipeline

The real power comes from combining XDP and TC in a pipeline where they each handle what they are best at:

```
                 Network Interface (eth0)
                         |
                    NIC Driver
                         |
                  ┌──────┴──────┐
                  │  XDP Hook   │  ← XDP_DROP: known-bad IPs, rate-limited
                  │             │    XDP_TX: hairpin to same interface
                  │             │    XDP_REDIRECT: fast-path forwarding
                  └──────┬──────┘
                         │ XDP_PASS: needs further processing
                  sk_buff allocated
                         │
                  ┌──────┴──────┐
                  │  TC Ingress │  ← Full context: cgroups, conntrack, routing
                  │             │    Rate limiting, monitoring, policy
                  └──────┬──────┘
                         │
                    IP Stack / Socket
                         │
                  ┌──────┴──────┐
                  │  TC Egress  │  ← Egress policy, encapsulation
                  └──────┬──────┘
                         │
                    NIC Driver
```

### Implementation: Rate Limiter Pipeline

XDP handles the fast path (known sources), TC handles new connections:

```c
// xdp_ratelimit.c
// Fast-path rate limiting using token bucket

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define RATE_LIMIT_PPS 1000000  // 1Mpps per source IP
#define BUCKET_SIZE    (RATE_LIMIT_PPS * 2)  // 2-second burst

struct token_bucket {
    __u64 tokens;
    __u64 last_refill_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 100000);
    __type(key, __u32);    // Source IP
    __type(value, struct token_bucket);
} rate_limit_map SEC(".maps");

// Blocklist: IPs that should be hard-dropped immediately
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10000);
    __type(key, __u32);
    __type(value, __u8);
} blocklist SEC(".maps");

static __always_inline int rate_limit(__u32 src_ip) {
    // Check blocklist first (fastest path)
    __u8 *blocked = bpf_map_lookup_elem(&blocklist, &src_ip);
    if (blocked)
        return 1;  // Drop

    __u64 now = bpf_ktime_get_ns();
    struct token_bucket *bucket = bpf_map_lookup_elem(&rate_limit_map, &src_ip);

    if (!bucket) {
        // New source: create bucket with full tokens
        struct token_bucket new_bucket = {
            .tokens = BUCKET_SIZE - 1,
            .last_refill_ns = now,
        };
        bpf_map_update_elem(&rate_limit_map, &src_ip, &new_bucket, BPF_ANY);
        return 0;  // Allow
    }

    // Refill tokens based on elapsed time
    __u64 elapsed_ns = now - bucket->last_refill_ns;
    __u64 new_tokens = (elapsed_ns * RATE_LIMIT_PPS) / 1000000000ULL;

    if (new_tokens > 0) {
        bucket->tokens += new_tokens;
        if (bucket->tokens > BUCKET_SIZE)
            bucket->tokens = BUCKET_SIZE;
        bucket->last_refill_ns = now;
    }

    if (bucket->tokens == 0)
        return 1;  // Rate limit exceeded, drop

    bucket->tokens--;
    return 0;  // Allow
}

SEC("xdp")
int xdp_ratelimiter(struct xdp_md *ctx) {
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    if (rate_limit(ip->saddr))
        return XDP_DROP;

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

## BPF Maps: The Communication Layer

Maps are the primary mechanism for communication between BPF programs and userspace, and between multiple BPF programs.

### Map Types for Networking

```c
// Common map type examples

// LRU hash: good for per-connection state (auto-evicts old entries)
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1000000);
    __type(key, __u64);    // Connection 5-tuple hash
    __type(value, struct conn_state);
} conn_table SEC(".maps");

// Per-CPU array: lock-free counters
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 256);
    __type(key, __u32);
    __type(value, __u64);
} pkt_counters SEC(".maps");

// Ring buffer: high-performance event streaming to userspace
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);  // 256KB ring buffer
} events SEC(".maps");

// Tail call map: program chaining
struct {
    __uint(type, BPF_MAP_TYPE_PROG_ARRAY);
    __uint(max_entries, 8);
    __type(key, __u32);
    __type(value, __u32);  // BPF program fd
} jump_table SEC(".maps");
```

### Ring Buffer for High-Speed Event Streaming

```c
// Packet event structure
struct pkt_event {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  protocol;
    __u8  action;
    __u16 len;
    __u64 timestamp_ns;
};

SEC("tc")
int tc_monitor(struct __sk_buff *skb) {
    // ... parse headers ...

    // Reserve space in ring buffer (non-blocking)
    struct pkt_event *event = bpf_ringbuf_reserve(&events,
                                                   sizeof(*event), 0);
    if (!event)
        return TC_ACT_OK;  // Buffer full, drop event (not packet)

    event->src_ip = ip->saddr;
    event->dst_ip = ip->daddr;
    event->src_port = bpf_ntohs(tcp->source);
    event->dst_port = bpf_ntohs(tcp->dest);
    event->protocol = ip->protocol;
    event->len = skb->len;
    event->timestamp_ns = bpf_ktime_get_ns();

    bpf_ringbuf_submit(event, 0);
    return TC_ACT_OK;
}
```

Userspace consumer in Go using cilium/ebpf:

```go
package main

import (
    "encoding/binary"
    "fmt"
    "net"
    "os"
    "os/signal"
    "syscall"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/ringbuf"
    "github.com/cilium/ebpf/rlimit"
)

type PktEvent struct {
    SrcIP     uint32
    DstIP     uint32
    SrcPort   uint16
    DstPort   uint16
    Protocol  uint8
    Action    uint8
    Len       uint16
    Timestamp uint64
}

func main() {
    // Remove memory limit for BPF maps
    if err := rlimit.RemoveMemlock(); err != nil {
        panic(err)
    }

    // Load pre-compiled BPF objects
    spec, err := ebpf.LoadCollectionSpec("tc_monitor.o")
    if err != nil {
        panic(err)
    }

    coll, err := ebpf.NewCollection(spec)
    if err != nil {
        panic(err)
    }
    defer coll.Close()

    // Create ring buffer reader
    rd, err := ringbuf.NewReader(coll.Maps["events"])
    if err != nil {
        panic(err)
    }
    defer rd.Close()

    // Handle shutdown
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
    go func() {
        <-sig
        rd.Close()
    }()

    fmt.Println("Reading packet events...")
    for {
        record, err := rd.Read()
        if err != nil {
            if err == ringbuf.ErrClosed {
                return
            }
            fmt.Printf("Error reading ringbuf: %v\n", err)
            continue
        }

        var event PktEvent
        if err := binary.Read(
            bytes.NewReader(record.RawSample),
            binary.LittleEndian,
            &event,
        ); err != nil {
            continue
        }

        srcIP := make(net.IP, 4)
        binary.BigEndian.PutUint32(srcIP, event.SrcIP)
        dstIP := make(net.IP, 4)
        binary.BigEndian.PutUint32(dstIP, event.DstIP)

        fmt.Printf("%s:%d -> %s:%d proto=%d len=%d\n",
            srcIP, event.SrcPort,
            dstIP, event.DstPort,
            event.Protocol, event.Len)
    }
}
```

## XDP Action Reference

| Action | Value | Meaning |
|---|---|---|
| XDP_ABORTED | 0 | Program error — packet dropped, counted as error |
| XDP_DROP | 1 | Drop packet at earliest possible point |
| XDP_PASS | 2 | Pass to normal kernel network stack |
| XDP_TX | 3 | Transmit back out the same interface (hairpin) |
| XDP_REDIRECT | 4 | Redirect to another interface or CPU |

## Debugging and Observability

```bash
# Dump all loaded BPF programs
bpftool prog list

# Show BPF program statistics (requires CONFIG_BPF_STATS_ENABLED)
echo 1 > /proc/sys/kernel/bpf_stats_enabled
bpftool prog show --stats

# Dump JIT-compiled x86 instructions for a program
bpftool prog dump jited id <prog-id>

# Inspect BPF maps
bpftool map list
bpftool map dump id <map-id>
bpftool map lookup id <map-id> key 0 0 0 0

# Trace XDP events with perf
perf trace -e xdp:* -- sleep 10

# Monitor BPF verifier log during load
ip link set dev eth0 xdp obj xdp_prog.o sec xdp verbose 2>&1 | head -100

# Check XDP hardware offload support
ethtool -k eth0 | grep xdp
```

## Performance Considerations

### XDP Driver Mode vs Generic Mode

```bash
# Driver mode: XDP runs in the NIC driver before sk_buff allocation
# Fastest, but requires driver support
ip link set dev eth0 xdp obj prog.o sec xdp

# Check if native (driver) mode is active
ip link show eth0 | grep xdp
# xdp/id:42 <-- driver mode
# xdpgeneric/id:42 <-- generic mode (slower)

# List drivers with native XDP support:
# mlx4, mlx5, ixgbe, i40e, ice, nfp, bnxt, virtio-net, veth, tun
```

### Avoiding Common Verifier Rejections

```c
// Common mistake: unbounded loop (rejected by verifier)
for (int i = 0; i < n; i++) {  // n is runtime value
    process(data + i);
}

// Correct: bounded loop with compile-time constant
#pragma unroll
for (int i = 0; i < 16; i++) {  // 16 is a compile-time constant
    process(data + i);
}

// Or use bpf_loop() for dynamic bounds (kernel 5.17+)
bpf_loop(n, process_cb, &ctx, 0);

// Common mistake: pointer arithmetic without bounds check
struct tcphdr *tcp = data + sizeof(struct ethhdr) + sizeof(struct iphdr);
tcp->dest;  // REJECTED: no bounds check

// Correct: always verify bounds
struct tcphdr *tcp = (void *)(eth + 1);
if ((void *)(tcp + 1) > data_end)
    return XDP_PASS;
tcp->dest;  // OK
```

## Summary

XDP and TC BPF programs represent the most powerful approach to programmable Linux networking available today. XDP's position before sk_buff allocation makes it ideal for dropping traffic at line rate — critical for DDoS mitigation, load balancer fast paths, and ingress filtering. TC's access to the full sk_buff context and bidirectional operation makes it the right choice for monitoring, NAT, policy enforcement, and traffic shaping. The two layers are complementary, and the most sophisticated deployments (Cilium, Katran, Cloudflare's L4 load balancer) use both in concert.

The cilium/ebpf Go library provides an excellent userspace interface for loading and managing BPF programs, making it practical to build production networking tools entirely in Go with BPF for the data plane hot path.
