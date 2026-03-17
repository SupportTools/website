---
title: "Linux eBPF Networking: XDP Programs for DDoS Mitigation and Packet Processing"
date: 2031-02-17T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "XDP", "Networking", "DDoS", "Performance", "AF_XDP"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to eBPF XDP programs for DDoS mitigation and packet processing covering XDP program architecture, BPF map types for connection tracking, XDP action semantics, token bucket rate limiting, AF_XDP for userspace packet processing, and performance benchmarks."
more_link: "yes"
url: "/linux-ebpf-xdp-programs-ddos-mitigation-packet-processing/"
---

XDP (eXpress Data Path) operates at the lowest layer of the Linux network stack, processing packets before they reach the kernel's networking subsystem. By attaching eBPF programs at the driver level, XDP achieves packet drop rates in the hundreds of millions per second on modern hardware — essential for DDoS mitigation. This guide builds a complete XDP DDoS mitigation system from scratch.

<!--more-->

# Linux eBPF Networking: XDP Programs for DDoS Mitigation and Packet Processing

## XDP Architecture and Processing Pipeline

XDP intercepts packets immediately after the NIC DMA's them into memory, before sk_buff allocation. This is the kernel equivalent of DPDK, but integrated into the standard kernel networking stack:

```
NIC Hardware
    |
    v
DMA into RX ring buffer
    |
    v  <--- XDP hook: eBPF program runs HERE
    |
    v (if XDP_PASS)
sk_buff allocation
    |
    v
TC (Traffic Control) ingress
    |
    v
Netfilter (iptables/nftables)
    |
    v
Socket layer
```

XDP programs make one of five decisions for each packet:
- `XDP_DROP`: Drop the packet immediately (fastest)
- `XDP_PASS`: Pass to normal kernel networking
- `XDP_TX`: Transmit back out the same interface (redirect)
- `XDP_REDIRECT`: Redirect to another interface or AF_XDP socket
- `XDP_ABORTED`: Drop with error counter increment (for debugging)

## Section 1: Development Environment Setup

```bash
# Install required packages (Ubuntu/Debian)
sudo apt-get install -y \
    linux-headers-$(uname -r) \
    libbpf-dev \
    clang \
    llvm \
    libelf-dev \
    libpcap-dev \
    gcc-multilib \
    bpfcc-tools \
    python3-bpfcc

# Verify eBPF support
uname -r
# 5.15.0-generic  (XDP requires 4.8+; full features at 5.x)

# Check if XDP is supported on the target interface
ethtool -i eth0 | grep driver
# driver: ixgbe  (ixgbe supports native XDP)
# driver: virtio_net  (supports XDP in SKB mode)

# Verify BTF (BPF Type Format) support for CO-RE compilation
ls /sys/kernel/btf/vmlinux
# /sys/kernel/btf/vmlinux  (required for CO-RE programs)
```

## Section 2: Basic XDP Program Structure

### Minimal XDP Drop Program

```c
/* xdp_drop.c - Minimal XDP program that drops all packets
 *
 * Build: clang -O2 -g -target bpf -D __TARGET_ARCH_x86 \
 *        -I/usr/include/x86_64-linux-gnu \
 *        -c xdp_drop.c -o xdp_drop.o
 */

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

/* License is mandatory for BPF programs */
char LICENSE[] SEC("license") = "GPL";

/* The XDP program entry point.
 * All XDP programs receive struct xdp_md as the context.
 */
SEC("xdp")
int xdp_drop_all(struct xdp_md *ctx)
{
    /* Drop every packet */
    return XDP_DROP;
}
```

```bash
# Compile the XDP program
clang -O2 -g -target bpf \
    -I/usr/include/x86_64-linux-gnu \
    -c xdp_drop.c -o xdp_drop.o

# Load and attach to interface (requires root)
# --native: use native driver XDP (fastest)
# --skb-mode: use SKB mode (compatible with all drivers)
sudo ip link set dev eth0 xdp obj xdp_drop.o sec xdp

# Verify the program is attached
sudo ip link show dev eth0
# 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 xdpgeneric ...
#     link/ether ... brd ...
#     prog/xdp id 47 tag abc123def456

# Detach the program
sudo ip link set dev eth0 xdp off
```

## Section 3: Packet Parsing in XDP

### Protocol Header Parsing

```c
/* packet_parser.h - Portable packet parsing helpers for XDP programs */

#pragma once
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/icmp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

/* Bounds-checked pointer to walk the packet */
struct packet_context {
    void *data;       /* Start of packet data */
    void *data_end;   /* One byte past the end */
    __u32 nh_offset;  /* Current position (network header offset) */
};

/* Initialize packet context from XDP metadata */
static __always_inline void
pctx_init(struct packet_context *pctx, struct xdp_md *ctx)
{
    pctx->data     = (void *)(long)ctx->data;
    pctx->data_end = (void *)(long)ctx->data_end;
    pctx->nh_offset = 0;
}

/* Parse Ethernet header. Returns -1 if packet is too short. */
static __always_inline int
parse_ethhdr(struct packet_context *pctx, struct ethhdr **eth)
{
    struct ethhdr *e = pctx->data + pctx->nh_offset;

    /* Bounds check: ensure the header fits within the packet */
    if ((void *)(e + 1) > pctx->data_end)
        return -1;

    *eth = e;
    pctx->nh_offset += sizeof(*e);

    return bpf_ntohs(e->h_proto);
}

/* Parse IPv4 header. Returns protocol number or -1. */
static __always_inline int
parse_iphdr(struct packet_context *pctx, struct iphdr **ip)
{
    struct iphdr *i = pctx->data + pctx->nh_offset;

    if ((void *)(i + 1) > pctx->data_end)
        return -1;

    /* IPv4 header can have options; IHL field gives actual length */
    __u32 ihl = i->ihl * 4;
    if (ihl < 20)
        return -1;

    /* Verify the full header (including options) fits */
    if (pctx->data + pctx->nh_offset + ihl > pctx->data_end)
        return -1;

    *ip = i;
    pctx->nh_offset += ihl;

    return i->protocol;
}

/* Parse TCP header. Returns 0 on success, -1 on failure. */
static __always_inline int
parse_tcphdr(struct packet_context *pctx, struct tcphdr **tcp)
{
    struct tcphdr *t = pctx->data + pctx->nh_offset;

    if ((void *)(t + 1) > pctx->data_end)
        return -1;

    *tcp = t;
    pctx->nh_offset += t->doff * 4;

    return 0;
}

/* Parse UDP header. Returns 0 on success, -1 on failure. */
static __always_inline int
parse_udphdr(struct packet_context *pctx, struct udphdr **udp)
{
    struct udphdr *u = pctx->data + pctx->nh_offset;

    if ((void *)(u + 1) > pctx->data_end)
        return -1;

    *udp = u;
    pctx->nh_offset += sizeof(*u);

    return 0;
}
```

## Section 4: BPF Maps for Connection Tracking

### Map Types for DDoS Mitigation

```c
/* xdp_ddos.c - XDP-based DDoS mitigation with connection tracking */

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include "packet_parser.h"

char LICENSE[] SEC("license") = "GPL";

/* Key for IP source address lookup */
struct ip_stats_key {
    __u32 src_ip;
    __u16 dst_port;
    __u8  protocol;
    __u8  pad;
};

/* Per-source-IP packet statistics */
struct ip_stats_value {
    __u64 packet_count;
    __u64 byte_count;
    __u64 last_seen_ns;  /* Timestamp from bpf_ktime_get_ns() */
    __u32 drop_count;
};

/*
 * BPF_MAP_TYPE_LRU_HASH automatically evicts the least-recently-used
 * entry when the map is full. This is ideal for connection tracking:
 * legitimate connections are accessed frequently and stay in the map;
 * stale entries are evicted automatically.
 *
 * max_entries limits memory usage: 1M entries * ~80 bytes/entry = ~80 MB
 */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1000000);
    __type(key, struct ip_stats_key);
    __type(value, struct ip_stats_value);
} ip_stats_map SEC(".maps");

/*
 * Blocklist: IP addresses to unconditionally drop.
 * Updated from userspace using bpf_map_update_elem().
 */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 100000);
    __type(key, __u32);   /* source IP */
    __type(value, __u64); /* timestamp when added */
} blocklist_map SEC(".maps");

/*
 * Allowlist: IP addresses to always pass (before any rate limiting).
 * Used for trusted IPs like load balancers, monitoring systems.
 */
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);  /* Longest-prefix match for CIDR ranges */
    __uint(max_entries, 10000);
    __uint(map_flags, BPF_F_NO_PREALLOC);
    __type(key, struct bpf_lpm_trie_key); /* Variable-length key */
    __type(value, __u64);
} allowlist_map SEC(".maps");

/*
 * Configuration map: userspace writes thresholds and settings.
 * Array map with a fixed set of configuration keys.
 */
enum config_key {
    CONFIG_PPS_THRESHOLD  = 0,   /* Packets per second before blocking */
    CONFIG_BPS_THRESHOLD  = 1,   /* Bits per second before blocking */
    CONFIG_WINDOW_NS      = 2,   /* Rate limiting window in nanoseconds */
    CONFIG_MAX_KEYS       = 3,
};

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, CONFIG_MAX_KEYS);
    __type(key, __u32);
    __type(value, __u64);
} config_map SEC(".maps");

/* Per-CPU stats for efficient accounting (no locking needed) */
struct global_stats {
    __u64 passed;
    __u64 dropped;
    __u64 redirected;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct global_stats);
} global_stats_map SEC(".maps");
```

## Section 5: Token Bucket Rate Limiting in eBPF

```c
/* token_bucket.h - Token bucket rate limiter for eBPF programs
 *
 * The token bucket algorithm:
 * - A "bucket" holds tokens
 * - Tokens are added at a constant rate (refill_rate tokens/second)
 * - Each packet consumes one token
 * - If the bucket is empty, the packet is dropped
 *
 * This implementation uses nanosecond timestamps for precision.
 */

#pragma once

struct token_bucket {
    __u64 tokens;         /* Current token count (scaled by TOKEN_SCALE) */
    __u64 last_refill_ns; /* Last refill timestamp */
};

/* Scale factor to avoid floating point math in the kernel */
#define TOKEN_SCALE 1000000ULL  /* 1 million = 1 token */

/*
 * Check and consume a token from the bucket.
 * Returns 1 if a token was available (packet should pass),
 * Returns 0 if the bucket is empty (packet should be dropped).
 *
 * rate_per_sec: maximum packets per second
 * burst: maximum burst (tokens the bucket can hold)
 */
static __always_inline int
token_bucket_consume(struct token_bucket *bucket,
                     __u64 rate_per_sec,
                     __u64 burst,
                     __u64 now_ns)
{
    __u64 elapsed_ns, new_tokens, max_tokens;

    /* How many nanoseconds since the last refill? */
    if (now_ns > bucket->last_refill_ns)
        elapsed_ns = now_ns - bucket->last_refill_ns;
    else
        elapsed_ns = 0; /* Clock monotonicity protection */

    /*
     * Tokens to add = rate * elapsed_time
     * = (rate_per_sec tokens/sec) * (elapsed_ns / 1,000,000,000 sec)
     * = rate_per_sec * elapsed_ns / 1,000,000,000
     * Scaled by TOKEN_SCALE to avoid integer truncation
     */
    new_tokens = (rate_per_sec * TOKEN_SCALE * elapsed_ns) / 1000000000ULL;

    /* Maximum tokens the bucket can hold */
    max_tokens = burst * TOKEN_SCALE;

    /* Add new tokens, capped at max */
    bucket->tokens += new_tokens;
    if (bucket->tokens > max_tokens)
        bucket->tokens = max_tokens;

    bucket->last_refill_ns = now_ns;

    /* Consume one token if available */
    if (bucket->tokens >= TOKEN_SCALE) {
        bucket->tokens -= TOKEN_SCALE;
        return 1; /* Token consumed — packet should pass */
    }

    return 0; /* No tokens — packet should be dropped */
}

/* Per-source token buckets stored in an LRU hash map */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 500000);
    __type(key, __u32);               /* source IP */
    __type(value, struct token_bucket);
} rate_limit_map SEC(".maps");
```

## Section 6: Complete XDP DDoS Mitigation Program

```c
/* xdp_ddos_complete.c - Complete XDP DDoS mitigation program */

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include "packet_parser.h"
#include "token_bucket.h"

char LICENSE[] SEC("license") = "GPL";

/* Default rate limits (overridable from userspace) */
#define DEFAULT_PPS_LIMIT   10000   /* 10k packets per second per source IP */
#define DEFAULT_BURST       50000   /* Allow burst up to 50k packets */

/*
 * Main XDP entry point.
 * Decision tree:
 * 1. Parse Ethernet header (drop malformed)
 * 2. Only process IPv4 (pass IPv6 for now)
 * 3. Check allowlist (always pass)
 * 4. Check blocklist (always drop)
 * 5. Apply rate limiting (drop if exceeded)
 * 6. Update statistics
 * 7. Pass to kernel
 */
SEC("xdp")
int xdp_ddos_filter(struct xdp_md *ctx)
{
    struct packet_context pctx;
    struct ethhdr *eth;
    struct iphdr *ip;
    int eth_type, ip_proto;
    __u32 src_ip;
    __u64 now_ns;
    __u32 key_zero = 0;
    struct global_stats *stats;
    int ret = XDP_PASS;

    pctx_init(&pctx, ctx);

    /* ---- Layer 2: Ethernet ---- */
    eth_type = parse_ethhdr(&pctx, &eth);
    if (eth_type < 0)
        return XDP_DROP;  /* Malformed Ethernet header */

    /* Only process IPv4 in this example */
    if (eth_type != ETH_P_IP)
        return XDP_PASS;

    /* ---- Layer 3: IPv4 ---- */
    ip_proto = parse_iphdr(&pctx, &ip);
    if (ip_proto < 0)
        return XDP_DROP;  /* Malformed IPv4 header */

    src_ip = ip->saddr;
    now_ns = bpf_ktime_get_ns();

    /* ---- Step 1: Check allowlist ---- */
    /* LPM trie key format: {prefix_len, ip bytes} */
    struct {
        __u32 prefix_len;
        __u32 ip;
    } lpm_key = { .prefix_len = 32, .ip = src_ip };

    if (bpf_map_lookup_elem(&allowlist_map, &lpm_key)) {
        ret = XDP_PASS;
        goto update_stats;
    }

    /* ---- Step 2: Check blocklist ---- */
    if (bpf_map_lookup_elem(&blocklist_map, &src_ip)) {
        ret = XDP_DROP;
        goto update_stats;
    }

    /* ---- Step 3: Rate limiting ---- */
    {
        struct token_bucket *bucket;
        struct token_bucket new_bucket = {
            .tokens = DEFAULT_BURST * TOKEN_SCALE,
            .last_refill_ns = now_ns,
        };

        bucket = bpf_map_lookup_elem(&rate_limit_map, &src_ip);
        if (!bucket) {
            /* First packet from this source: create a new bucket */
            bpf_map_update_elem(&rate_limit_map, &src_ip, &new_bucket, BPF_ANY);
            bucket = bpf_map_lookup_elem(&rate_limit_map, &src_ip);
            if (!bucket) {
                /* Map is full — this shouldn't happen with LRU, but be safe */
                ret = XDP_PASS;
                goto update_stats;
            }
        }

        if (!token_bucket_consume(bucket, DEFAULT_PPS_LIMIT, DEFAULT_BURST, now_ns)) {
            /* Rate limit exceeded: drop the packet */
            ret = XDP_DROP;

            /* Optionally add to blocklist after sustained rate limit violations */
            /* This is implemented in userspace based on statistics */
        }
    }

update_stats:
    /* Update per-CPU statistics (lock-free) */
    stats = bpf_map_lookup_elem(&global_stats_map, &key_zero);
    if (stats) {
        if (ret == XDP_PASS)
            __sync_fetch_and_add(&stats->passed, 1);
        else if (ret == XDP_DROP)
            __sync_fetch_and_add(&stats->dropped, 1);
    }

    return ret;
}
```

## Section 7: Userspace Control Plane in Go

```go
package main

import (
    "encoding/binary"
    "fmt"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"
    "unsafe"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang xdp ./xdp_ddos_complete.c

// GlobalStats mirrors the eBPF struct global_stats
type GlobalStats struct {
    Passed     uint64
    Dropped    uint64
    Redirected uint64
}

// XDPController manages the XDP program lifecycle
type XDPController struct {
    objs  *xdpObjects
    link  link.Link
    iface *net.Interface
}

func NewXDPController(ifaceName string) (*XDPController, error) {
    iface, err := net.InterfaceByName(ifaceName)
    if err != nil {
        return nil, fmt.Errorf("finding interface %s: %w", ifaceName, err)
    }

    // Load the pre-compiled eBPF program
    objs := &xdpObjects{}
    if err := loadXdpObjects(objs, nil); err != nil {
        return nil, fmt.Errorf("loading XDP objects: %w", err)
    }

    // Attach the XDP program to the interface
    xdpLink, err := link.AttachXDP(link.XDPOptions{
        Program:   objs.XdpDdosFilter,
        Interface: iface.Index,
        // Use XDPGenericMode for compatibility; XDPDriverMode for native performance
        Flags: link.XDPGenericMode,
    })
    if err != nil {
        objs.Close()
        return nil, fmt.Errorf("attaching XDP program: %w", err)
    }

    return &XDPController{
        objs:  objs,
        link:  xdpLink,
        iface: iface,
    }, nil
}

func (c *XDPController) Close() {
    c.link.Close()
    c.objs.Close()
}

// AddToBlocklist adds an IP address to the XDP blocklist
func (c *XDPController) AddToBlocklist(ip net.IP) error {
    key := ipToUint32(ip)
    val := uint64(time.Now().Unix())
    return c.objs.BlocklistMap.Put(&key, &val)
}

// RemoveFromBlocklist removes an IP from the blocklist
func (c *XDPController) RemoveFromBlocklist(ip net.IP) error {
    key := ipToUint32(ip)
    return c.objs.BlocklistMap.Delete(&key)
}

// GetStats reads the per-CPU statistics and aggregates them
func (c *XDPController) GetStats() (*GlobalStats, error) {
    var key uint32 = 0
    var total GlobalStats

    // Per-CPU maps return one value per CPU
    values, err := c.objs.GlobalStatsMap.LookupBytes(&key)
    if err != nil {
        return nil, fmt.Errorf("reading stats: %w", err)
    }

    // Size of GlobalStats struct
    statsSize := int(unsafe.Sizeof(GlobalStats{}))
    numCPUs := len(values) / statsSize

    for cpu := 0; cpu < numCPUs; cpu++ {
        offset := cpu * statsSize
        if offset+statsSize > len(values) {
            break
        }

        var perCPU GlobalStats
        perCPU.Passed = binary.LittleEndian.Uint64(values[offset:])
        perCPU.Dropped = binary.LittleEndian.Uint64(values[offset+8:])
        perCPU.Redirected = binary.LittleEndian.Uint64(values[offset+16:])

        total.Passed += perCPU.Passed
        total.Dropped += perCPU.Dropped
        total.Redirected += perCPU.Redirected
    }

    return &total, nil
}

// MonitorStats prints packet statistics every second
func (c *XDPController) MonitorStats(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    var prevStats GlobalStats

    for range ticker.C {
        stats, err := c.GetStats()
        if err != nil {
            fmt.Printf("Error reading stats: %v\n", err)
            continue
        }

        ppsRate := float64(stats.Passed-prevStats.Passed) / interval.Seconds()
        dropRate := float64(stats.Dropped-prevStats.Dropped) / interval.Seconds()

        fmt.Printf("[%s] Passed: %d (%.0f/s) | Dropped: %d (%.0f/s)\n",
            time.Now().Format("15:04:05"),
            stats.Passed, ppsRate,
            stats.Dropped, dropRate)

        prevStats = *stats
    }
}

func ipToUint32(ip net.IP) uint32 {
    ip = ip.To4()
    if ip == nil {
        return 0
    }
    return binary.BigEndian.Uint32(ip)
}

func main() {
    if len(os.Args) < 2 {
        fmt.Fprintf(os.Stderr, "Usage: %s <interface>\n", os.Args[0])
        os.Exit(1)
    }

    ifaceName := os.Args[1]

    ctrl, err := NewXDPController(ifaceName)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to start XDP controller: %v\n", err)
        os.Exit(1)
    }
    defer ctrl.Close()

    fmt.Printf("XDP DDoS mitigation active on %s\n", ifaceName)

    // Add some example IPs to the blocklist
    // ctrl.AddToBlocklist(net.ParseIP("192.0.2.1"))

    // Start monitoring in background
    go ctrl.MonitorStats(1 * time.Second)

    // Wait for signal
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
    <-sig

    fmt.Println("\nShutting down XDP controller")
}
```

## Section 8: AF_XDP for Userspace Packet Processing

AF_XDP (Address Family XDP) allows XDP programs to redirect packets to userspace without copying through the kernel's network stack. This is similar to DPDK but uses the standard kernel interface.

```c
/* xdp_redirect_to_afxdp.c - XDP program that redirects packets to AF_XDP socket */

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

char LICENSE[] SEC("license") = "GPL";

/*
 * XSK (XDP Socket) map: maps queue IDs to AF_XDP socket file descriptors.
 * When we redirect to a queue ID in this map, the packet goes to userspace
 * via the corresponding AF_XDP socket.
 */
struct {
    __uint(type, BPF_MAP_TYPE_XSKMAP);
    __uint(max_entries, 64);  /* Max 64 queues */
    __type(key, __u32);       /* Queue ID */
    __type(value, __u32);     /* Socket file descriptor */
} xsk_map SEC(".maps");

SEC("xdp")
int xdp_redirect_xsk(struct xdp_md *ctx)
{
    /* Redirect all packets to the AF_XDP socket for queue 0 */
    __u32 queue_id = ctx->rx_queue_index;
    int ret = bpf_redirect_map(&xsk_map, queue_id, XDP_DROP);
    return ret;
}
```

```go
// AF_XDP userspace packet processing example using the xdp-tools library
// go get github.com/asavie/xdp

package afxdp

import (
    "fmt"
    "net"

    "github.com/asavie/xdp"
)

// AFXDPReceiver demonstrates high-performance packet reception via AF_XDP
type AFXDPReceiver struct {
    sock *xdp.Socket
    prog *xdp.Program
}

func NewAFXDPReceiver(ifaceName string, queueID int) (*AFXDPReceiver, error) {
    iface, err := net.InterfaceByName(ifaceName)
    if err != nil {
        return nil, fmt.Errorf("interface %s: %w", ifaceName, err)
    }

    // Load and attach the XDP redirect program
    prog, err := xdp.NewProgram(1) // Max 1 socket
    if err != nil {
        return nil, fmt.Errorf("creating XDP program: %w", err)
    }

    if err := prog.Attach(iface.Index); err != nil {
        prog.Close()
        return nil, fmt.Errorf("attaching XDP program: %w", err)
    }

    // Create the AF_XDP socket
    sock, err := xdp.NewSocket(iface.Index, queueID, nil)
    if err != nil {
        prog.Detach(iface.Index)
        prog.Close()
        return nil, fmt.Errorf("creating AF_XDP socket: %w", err)
    }

    // Register the socket with the XDP program's socket map
    if err := prog.Register(queueID, sock.FD()); err != nil {
        sock.Close()
        prog.Detach(iface.Index)
        prog.Close()
        return nil, fmt.Errorf("registering AF_XDP socket: %w", err)
    }

    return &AFXDPReceiver{sock: sock, prog: prog}, nil
}

// Receive processes packets from the AF_XDP socket
func (r *AFXDPReceiver) Receive(handler func([]byte)) {
    for {
        // Poll for received packets
        if n, pos, err := r.sock.Poll(100 /* timeout ms */); err == nil && n > 0 {
            descs := r.sock.Receive(n)
            for _, desc := range descs {
                pkt := r.sock.GetFrame(desc)
                handler(pkt[:desc.Len])
            }
            r.sock.Fill(pos)
        }
    }
}

func (r *AFXDPReceiver) Close() {
    r.sock.Close()
    r.prog.Detach(r.prog.FD()) // Would need interface index
    r.prog.Close()
}
```

## Section 9: Performance Benchmarks and Tuning

```bash
# Measure XDP packet drop rate
# Using pktgen_dpdk or the kernel's pktgen

# Load XDP program in native mode (driver-level processing)
sudo ip link set dev eth0 xdp obj xdp_drop.o sec xdp

# Run pktgen from a packet generator machine
modprobe pktgen
echo "add_device eth1" > /proc/net/pktgen/kpktgend_0
echo "pkt_size 64" > /proc/net/pktgen/eth1
echo "count 10000000" > /proc/net/pktgen/eth1
echo "start" > /proc/net/pktgen/pgctrl

# Typical XDP performance numbers (10GbE NIC):
# XDP Native mode (driver-level):  ~14.8 Mpps (10 GbE line rate)
# XDP SKB mode:                    ~3-5 Mpps
# iptables DROP:                   ~1-2 Mpps
# nftables DROP:                   ~1-2 Mpps

# For 100GbE:
# XDP Native:   ~100+ Mpps (requires multi-queue NIC and CPU pinning)
```

### CPU Pinning and NUMA Optimization

```bash
# XDP performance scales with CPU assignment
# Pin the XDP processing CPU to the same NUMA node as the NIC

# Find the NIC's NUMA node
cat /sys/class/net/eth0/device/numa_node
# 0

# Pin a process to NUMA node 0
numactl --cpunodebind=0 --membind=0 my-xdp-app

# Set CPU affinity for network IRQs
# First, find the IRQs for eth0
cat /proc/interrupts | grep eth0

# Pin each queue's IRQ to a CPU on the same NUMA node
for IRQ in $(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':'); do
    echo "1" > /proc/irq/${IRQ}/smp_affinity  # CPU 0
done

# Enable RPS (Receive Packet Steering) for multi-queue distribution
echo "f" > /sys/class/net/eth0/queues/rx-0/rps_cpus  # Use CPUs 0-3
```

## Section 10: Monitoring XDP Programs

```bash
#!/bin/bash
# xdp-monitor.sh - Monitor XDP program stats and health

IFACE="${1:-eth0}"

echo "=== XDP Program Status ==="
ip link show dev "${IFACE}" | grep prog

echo ""
echo "=== BPF Program Stats ==="
bpftool prog show name xdp_ddos_filter

echo ""
echo "=== Map Statistics ==="
# List all maps used by the program
PROG_ID=$(bpftool prog show name xdp_ddos_filter | grep -oP 'id \K[0-9]+')
bpftool prog show id ${PROG_ID} --json | jq '.map_ids[]' | while read map_id; do
    echo ""
    echo "Map ID: $map_id"
    bpftool map show id ${map_id}
    echo "Entry count: $(bpftool map dump id ${map_id} 2>/dev/null | wc -l)"
done

echo ""
echo "=== Blocklist Entries ==="
bpftool map dump name blocklist_map 2>/dev/null | head -20

echo ""
echo "=== Rate Limit Map Occupancy ==="
bpftool map dump name rate_limit_map 2>/dev/null | wc -l
echo "entries in rate limit map"
```

## Conclusion

XDP-based packet processing represents the state of the art in Linux network performance. By operating at the driver level before sk_buff allocation, XDP programs can process packets at line rate on 10/100GbE hardware while implementing sophisticated logic: connection tracking with LRU hash maps, token bucket rate limiting, blocklist lookups with LPM tries, and packet redirection to userspace via AF_XDP. The integration with the standard kernel BPF subsystem means XDP programs benefit from the full BPF toolchain — CO-RE compilation, BTF type information, and bpftool introspection — making production deployment and debugging tractable. For organizations facing volumetric DDoS attacks, XDP provides a programmable, hardware-accelerated defense layer that is significantly more capable than traditional iptables approaches.
