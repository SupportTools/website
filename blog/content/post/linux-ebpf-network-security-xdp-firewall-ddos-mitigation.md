---
title: "Linux eBPF Network Security: XDP Firewall, Traffic Filtering, and DDoS Mitigation"
date: 2030-01-06T00:00:00-05:00
draft: false
tags: ["eBPF", "XDP", "Linux", "Network Security", "DDoS", "Firewall", "Performance"]
categories: ["Linux", "Network Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Building high-performance network security with eBPF XDP programs, implementing packet filtering at the NIC level, rate limiting, and connection tracking in eBPF for enterprise DDoS mitigation."
more_link: "yes"
url: "/linux-ebpf-network-security-xdp-firewall-ddos-mitigation/"
---

Traditional Linux firewall tools like iptables and nftables operate in the kernel's network stack after the packet has been processed through multiple layers of the kernel. For high-rate DDoS attacks and line-rate packet filtering requirements, this overhead is unacceptable. eXpress Data Path (XDP) solves this by allowing eBPF programs to process packets at the earliest possible point — directly in the NIC driver — enabling packet drop decisions at tens of millions of packets per second with minimal CPU overhead.

This guide covers building production-grade network security infrastructure using eBPF XDP programs, including stateless ACLs, rate limiting with token buckets, TCP SYN flood protection, and connection tracking implemented entirely in eBPF maps.

<!--more-->

# Linux eBPF Network Security: XDP Firewall, Traffic Filtering, and DDoS Mitigation

## Why XDP for Network Security

Before diving into implementation, understanding the performance difference between XDP and traditional kernel-based packet processing is essential for justifying the complexity investment.

**Traditional iptables path:**
```
NIC → Driver → sk_buff allocation → Network stack → Netfilter → iptables → Application
     ↑ ~200-500ns per packet
```

**XDP path:**
```
NIC → Driver → XDP program → XDP_DROP/XDP_PASS/XDP_TX
     ↑ ~50-100ns per packet, no sk_buff allocation for dropped packets
```

On a modern server with a 25G NIC, iptables can sustain roughly 5-8 million packets per second (Mpps) before saturating CPUs. XDP with native driver support can sustain 20-30 Mpps on the same hardware, dropping malicious traffic before it ever enters the kernel network stack.

## Development Environment Setup

### Required Packages

```bash
# Ubuntu/Debian
apt-get install -y \
    clang \
    llvm \
    libbpf-dev \
    linux-headers-$(uname -r) \
    linux-tools-$(uname -r) \
    linux-tools-common \
    bpftool \
    iproute2 \
    libelf-dev \
    zlib1g-dev \
    gcc-multilib \
    pkg-config

# Verify kernel BPF support
bpftool feature probe | grep -E "map_type|prog_type" | head -20

# Check BTF support (required for CO-RE)
ls /sys/kernel/btf/vmlinux
bpftool btf dump file /sys/kernel/btf/vmlinux format c | head -5
```

### Project Structure

```
xdp-firewall/
├── Makefile
├── xdp_firewall.c       # eBPF kernel program
├── xdp_firewall.h       # Shared data structures
├── xdp_loader.c         # Userspace loader
├── xdp_controller.go    # Go management daemon
├── vmlinux.h            # Generated BTF header
└── libbpf/              # libbpf submodule
```

Generate the vmlinux header for CO-RE (Compile Once - Run Everywhere):

```bash
bpftool btf dump file /sys/kernel/btf/vmlinux format c > xdp-firewall/vmlinux.h
```

## Part 1: Stateless Packet Filtering

### Core Data Structures

```c
/* xdp_firewall.h */
#ifndef __XDP_FIREWALL_H
#define __XDP_FIREWALL_H

#include <linux/types.h>

/* Maximum entries in various maps */
#define MAX_BLOCKLIST_ENTRIES    1000000
#define MAX_ALLOWLIST_ENTRIES    10000
#define MAX_RATE_LIMIT_ENTRIES   100000
#define MAX_CONNTRACK_ENTRIES    500000
#define MAX_STATS_CPUS           256

/* IP protocol numbers */
#define IPPROTO_ICMP    1
#define IPPROTO_TCP     6
#define IPPROTO_UDP     17

/* XDP action codes (matches kernel definitions) */
#define XDP_ABORTED     0
#define XDP_DROP        1
#define XDP_PASS        2
#define XDP_TX          3
#define XDP_REDIRECT    4

/* Blocklist entry - key is a single IPv4 address */
struct blocklist_key {
    __u32 ip;
};

/* Blocklist value with metadata */
struct blocklist_value {
    __u64 blocked_at;     /* Unix timestamp when added */
    __u64 packet_count;   /* Number of packets blocked */
    __u32 reason;         /* Why this IP was blocked */
    __u32 ttl;            /* TTL in seconds, 0 = permanent */
};

/* Rate limit key - per source IP and destination port */
struct rate_limit_key {
    __u32 src_ip;
    __u16 dst_port;
    __u8  protocol;
    __u8  pad;
};

/* Token bucket state for rate limiting */
struct token_bucket {
    __u64 tokens;           /* Current token count (scaled by 1000) */
    __u64 last_refill_ns;   /* Last refill time in nanoseconds */
    __u64 rate_per_ns;      /* Tokens to add per nanosecond */
    __u64 burst;            /* Maximum token burst */
    __u64 dropped_packets;  /* Count of dropped packets */
};

/* Connection tracking key - 5-tuple */
struct conntrack_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  protocol;
    __u8  pad[3];
};

/* Connection state values */
enum conn_state {
    CONN_NEW       = 0,
    CONN_SYNRECEIVED = 1,
    CONN_ESTABLISHED = 2,
    CONN_FIN_WAIT  = 3,
    CONN_TIME_WAIT = 4,
};

struct conntrack_value {
    __u64 created_at;
    __u64 last_seen;
    __u32 packets_fwd;
    __u32 packets_rev;
    __u8  state;
    __u8  flags;
    __u16 pad;
};

/* Per-CPU statistics */
struct xdp_stats {
    __u64 packets_passed;
    __u64 packets_dropped;
    __u64 packets_rate_limited;
    __u64 bytes_passed;
    __u64 bytes_dropped;
};

/* Rule configuration for userspace-to-kernel communication */
struct fw_rule {
    __u32 src_ip;
    __u32 src_mask;
    __u32 dst_ip;
    __u32 dst_mask;
    __u16 src_port_min;
    __u16 src_port_max;
    __u16 dst_port_min;
    __u16 dst_port_max;
    __u8  protocol;     /* 0 = any */
    __u8  action;       /* XDP_DROP or XDP_PASS */
    __u16 priority;
    __u32 rule_id;
};

#endif /* __XDP_FIREWALL_H */
```

### Main XDP Program

```c
/* xdp_firewall.c */
#include "vmlinux.h"
#include "xdp_firewall.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

/* ===== eBPF Maps ===== */

/* IPv4 blocklist - LRU hash for automatic eviction of old entries */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, MAX_BLOCKLIST_ENTRIES);
    __type(key, struct blocklist_key);
    __type(value, struct blocklist_value);
} blocklist SEC(".maps");

/* Allowlist - takes priority over blocklist */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, MAX_ALLOWLIST_ENTRIES);
    __type(key, struct blocklist_key);
    __type(value, __u8);
} allowlist SEC(".maps");

/* Rate limiting state - LRU hash with per-CPU values */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_PERCPU_HASH);
    __uint(max_entries, MAX_RATE_LIMIT_ENTRIES);
    __type(key, struct rate_limit_key);
    __type(value, struct token_bucket);
} rate_limit_map SEC(".maps");

/* Connection tracking */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, MAX_CONNTRACK_ENTRIES);
    __type(key, struct conntrack_key);
    __type(value, struct conntrack_value);
} conntrack_map SEC(".maps");

/* Per-CPU statistics */
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct xdp_stats);
} stats_map SEC(".maps");

/* Configuration flags */
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 16);
    __type(key, __u32);
    __type(value, __u64);
} config_map SEC(".maps");

/* ===== Helper Functions ===== */

static __always_inline
struct xdp_stats *get_stats(void)
{
    __u32 key = 0;
    return bpf_map_lookup_elem(&stats_map, &key);
}

static __always_inline
int check_blocklist(__u32 src_ip)
{
    struct blocklist_key key = { .ip = src_ip };
    struct blocklist_value *val = bpf_map_lookup_elem(&blocklist, &key);

    if (!val)
        return 0;  /* Not in blocklist */

    /* Check TTL */
    if (val->ttl > 0) {
        __u64 now = bpf_ktime_get_ns() / 1000000000ULL;  /* seconds */
        if (now > val->blocked_at + val->ttl) {
            /* Entry expired */
            bpf_map_delete_elem(&blocklist, &key);
            return 0;
        }
    }

    /* Atomically increment packet counter */
    __sync_fetch_and_add(&val->packet_count, 1);
    return 1;  /* In blocklist */
}

static __always_inline
int check_allowlist(__u32 src_ip)
{
    struct blocklist_key key = { .ip = src_ip };
    return bpf_map_lookup_elem(&allowlist, &key) != NULL;
}

/* Token bucket rate limiter
 * Returns 1 if packet should be dropped, 0 if allowed */
static __always_inline
int rate_limit_check(__u32 src_ip, __u16 dst_port, __u8 proto,
                     __u64 rate_pps, __u64 burst_pps)
{
    struct rate_limit_key key = {
        .src_ip   = src_ip,
        .dst_port = dst_port,
        .protocol = proto,
    };

    struct token_bucket *bucket = bpf_map_lookup_elem(&rate_limit_map, &key);
    __u64 now = bpf_ktime_get_ns();

    if (!bucket) {
        /* New entry - initialize bucket */
        struct token_bucket new_bucket = {
            .tokens         = burst_pps * 1000,
            .last_refill_ns = now,
            .rate_per_ns    = (rate_pps * 1000) / 1000000000ULL,
            .burst          = burst_pps * 1000,
            .dropped_packets = 0,
        };
        bpf_map_update_elem(&rate_limit_map, &key, &new_bucket, BPF_NOEXIST);
        return 0;  /* Allow first packet */
    }

    /* Refill tokens based on elapsed time */
    __u64 elapsed_ns = now - bucket->last_refill_ns;
    __u64 new_tokens = elapsed_ns * bucket->rate_per_ns;
    bucket->tokens += new_tokens;
    if (bucket->tokens > bucket->burst)
        bucket->tokens = bucket->burst;
    bucket->last_refill_ns = now;

    /* Check if we have a token */
    if (bucket->tokens >= 1000) {
        bucket->tokens -= 1000;
        return 0;  /* Allow */
    }

    /* Rate limited - drop */
    bucket->dropped_packets++;
    return 1;
}

/* ===== TCP SYN Flood Protection ===== */

static __always_inline
int check_syn_flood(__u32 src_ip, __u32 dst_ip,
                    __u16 src_port, __u16 dst_port,
                    __u8 tcp_flags)
{
    /* Only check SYN packets without ACK */
    if (!(tcp_flags & 0x02) || (tcp_flags & 0x10))
        return 0;

    struct conntrack_key key = {
        .src_ip   = src_ip,
        .dst_ip   = dst_ip,
        .src_port = src_port,
        .dst_port = dst_port,
        .protocol = IPPROTO_TCP,
    };

    struct conntrack_value *conn = bpf_map_lookup_elem(&conntrack_map, &key);
    if (conn) {
        /* Existing connection - allow */
        conn->last_seen = bpf_ktime_get_ns();
        return 0;
    }

    /* New SYN - rate limit new connections per source IP */
    return rate_limit_check(src_ip, dst_port, IPPROTO_TCP,
                            100,   /* 100 new connections/sec per source */
                            1000); /* burst of 1000 */
}

/* ===== Main XDP Entry Point ===== */

SEC("xdp")
int xdp_firewall_main(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct xdp_stats *stats = get_stats();

    /* Parse Ethernet header */
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_ABORTED;

    /* Only handle IPv4 */
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    /* Parse IPv4 header */
    struct iphdr *iph = (void *)(eth + 1);
    if ((void *)(iph + 1) > data_end)
        return XDP_ABORTED;

    /* Validate IP header length */
    if (iph->ihl < 5)
        return XDP_DROP;

    __u32 src_ip = iph->saddr;
    __u32 dst_ip = iph->daddr;
    __u32 pkt_len = bpf_ntohs(iph->tot_len);

    /* Step 1: Check allowlist (highest priority) */
    if (check_allowlist(src_ip))
        goto allow;

    /* Step 2: Check blocklist */
    if (check_blocklist(src_ip))
        goto drop;

    /* Step 3: Protocol-specific checks */
    __u16 src_port = 0, dst_port = 0;
    __u8  tcp_flags = 0;

    if (iph->protocol == IPPROTO_TCP) {
        struct tcphdr *tcph = (void *)iph + (iph->ihl * 4);
        if ((void *)(tcph + 1) > data_end)
            return XDP_ABORTED;

        src_port  = bpf_ntohs(tcph->source);
        dst_port  = bpf_ntohs(tcph->dest);
        tcp_flags = (((__u8 *)tcph)[13]);  /* TCP flags byte */

        /* SYN flood protection */
        if (check_syn_flood(src_ip, dst_ip, src_port, dst_port, tcp_flags))
            goto drop_rate_limited;

    } else if (iph->protocol == IPPROTO_UDP) {
        struct udphdr *udph = (void *)iph + (iph->ihl * 4);
        if ((void *)(udph + 1) > data_end)
            return XDP_ABORTED;

        src_port = bpf_ntohs(udph->source);
        dst_port = bpf_ntohs(udph->dest);

        /* UDP flood protection */
        if (rate_limit_check(src_ip, dst_port, IPPROTO_UDP,
                             10000,   /* 10k UDP pps per source per port */
                             50000))  /* burst 50k */
            goto drop_rate_limited;

    } else if (iph->protocol == IPPROTO_ICMP) {
        /* ICMP flood protection */
        if (rate_limit_check(src_ip, 0, IPPROTO_ICMP,
                             100,    /* 100 ICMP pps per source */
                             500))   /* burst 500 */
            goto drop_rate_limited;
    }

allow:
    if (stats) {
        stats->packets_passed++;
        stats->bytes_passed += pkt_len;
    }
    return XDP_PASS;

drop_rate_limited:
    if (stats)
        stats->packets_rate_limited++;
    /* Fall through to drop */

drop:
    if (stats) {
        stats->packets_dropped++;
        stats->bytes_dropped += pkt_len;
    }
    return XDP_DROP;
}

char LICENSE[] SEC("license") = "GPL";
```

## Part 2: Building the Makefile

```makefile
# Makefile
CLANG   := clang
LLVM_STRIP := llvm-strip
BPFTOOL := bpftool

# Kernel source (for headers)
KERNEL_HEADERS := /usr/include

# BPF compilation flags
BPF_CFLAGS := \
    -target bpf \
    -D __BPF_TRACING__ \
    -D __TARGET_ARCH_x86 \
    -Wall \
    -Werror \
    -O2 \
    -g \
    -I$(KERNEL_HEADERS) \
    -I./libbpf/src \
    -fno-stack-protector

# Userspace compilation flags
CC      := gcc
CFLAGS  := -Wall -Werror -O2 -g -I./libbpf/src
LDFLAGS := -L./libbpf/src -lbpf -lelf -lz

.PHONY: all clean generate

all: generate xdp_firewall.o xdp_loader

# Generate vmlinux.h
generate:
	bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h

# Compile BPF program to object file
xdp_firewall.o: xdp_firewall.c xdp_firewall.h vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@
	$(LLVM_STRIP) -g $@  # Remove DWARF from BPF object

# Generate BPF skeleton
xdp_firewall.skel.h: xdp_firewall.o
	$(BPFTOOL) gen skeleton $< > $@

# Build userspace loader
xdp_loader: xdp_loader.c xdp_firewall.skel.h
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS)

clean:
	rm -f *.o *.skel.h xdp_loader vmlinux.h
```

## Part 3: Userspace Management in Go

```go
// xdp_controller.go
package main

import (
    "encoding/binary"
    "fmt"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"
    "unsafe"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
)

// BlocklistKey must match the C struct
type BlocklistKey struct {
    IP uint32
}

// BlocklistValue must match the C struct
type BlocklistValue struct {
    BlockedAt    uint64
    PacketCount  uint64
    Reason       uint32
    TTL          uint32
}

// XDPStats must match the C struct
type XDPStats struct {
    PacketsPassed      uint64
    PacketsDropped     uint64
    PacketsRateLimited uint64
    BytesPassed        uint64
    BytesDropped       uint64
}

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall -Werror" XDPFirewall xdp_firewall.c

// FirewallController manages the XDP firewall
type FirewallController struct {
    objects *XDPFirewallObjects
    link    link.Link
    iface   *net.Interface
}

// NewFirewallController creates and attaches the XDP firewall
func NewFirewallController(ifaceName string) (*FirewallController, error) {
    iface, err := net.InterfaceByName(ifaceName)
    if err != nil {
        return nil, fmt.Errorf("finding interface %s: %w", ifaceName, err)
    }

    // Load pre-compiled eBPF programs
    objs := &XDPFirewallObjects{}
    if err := LoadXDPFirewallObjects(objs, nil); err != nil {
        return nil, fmt.Errorf("loading eBPF objects: %w", err)
    }

    // Attach XDP program to interface
    l, err := link.AttachXDP(link.XDPOptions{
        Program:   objs.XdpFirewallMain,
        Interface: iface.Index,
        Flags:     link.XDPGenericMode, // Use XDPNativeMode for production
    })
    if err != nil {
        objs.Close()
        return nil, fmt.Errorf("attaching XDP program: %w", err)
    }

    log.Printf("XDP firewall attached to interface %s (index %d)", ifaceName, iface.Index)

    return &FirewallController{
        objects: objs,
        link:    l,
        iface:   iface,
    }, nil
}

// BlockIP adds an IP address to the blocklist
func (fc *FirewallController) BlockIP(ipStr string, ttlSeconds uint32, reason uint32) error {
    ip := net.ParseIP(ipStr)
    if ip == nil {
        return fmt.Errorf("invalid IP address: %s", ipStr)
    }

    ip4 := ip.To4()
    if ip4 == nil {
        return fmt.Errorf("only IPv4 supported: %s", ipStr)
    }

    key := BlocklistKey{
        IP: binary.BigEndian.Uint32(ip4),
    }

    now := uint64(time.Now().Unix())
    value := BlocklistValue{
        BlockedAt:   now,
        PacketCount: 0,
        Reason:      reason,
        TTL:         ttlSeconds,
    }

    if err := fc.objects.Blocklist.Put(
        unsafe.Pointer(&key),
        unsafe.Pointer(&value),
    ); err != nil {
        return fmt.Errorf("updating blocklist: %w", err)
    }

    log.Printf("Blocked IP %s (TTL: %ds, reason: %d)", ipStr, ttlSeconds, reason)
    return nil
}

// UnblockIP removes an IP from the blocklist
func (fc *FirewallController) UnblockIP(ipStr string) error {
    ip := net.ParseIP(ipStr)
    if ip == nil {
        return fmt.Errorf("invalid IP address: %s", ipStr)
    }

    ip4 := ip.To4()
    if ip4 == nil {
        return fmt.Errorf("only IPv4 supported: %s", ipStr)
    }

    key := BlocklistKey{
        IP: binary.BigEndian.Uint32(ip4),
    }

    if err := fc.objects.Blocklist.Delete(unsafe.Pointer(&key)); err != nil {
        if err == ebpf.ErrKeyNotExist {
            return fmt.Errorf("IP %s not in blocklist", ipStr)
        }
        return fmt.Errorf("removing from blocklist: %w", err)
    }

    log.Printf("Unblocked IP %s", ipStr)
    return nil
}

// GetStats returns aggregate statistics across all CPUs
func (fc *FirewallController) GetStats() (*XDPStats, error) {
    var key uint32 = 0
    var perCPUValues []XDPStats

    if err := fc.objects.StatsMap.Lookup(key, &perCPUValues); err != nil {
        return nil, fmt.Errorf("reading stats: %w", err)
    }

    var total XDPStats
    for _, cpu := range perCPUValues {
        total.PacketsPassed += cpu.PacketsPassed
        total.PacketsDropped += cpu.PacketsDropped
        total.PacketsRateLimited += cpu.PacketsRateLimited
        total.BytesPassed += cpu.BytesPassed
        total.BytesDropped += cpu.BytesDropped
    }

    return &total, nil
}

// PrintStats periodically prints firewall statistics
func (fc *FirewallController) PrintStats(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    var prevStats XDPStats
    for range ticker.C {
        stats, err := fc.GetStats()
        if err != nil {
            log.Printf("Error reading stats: %v", err)
            continue
        }

        // Calculate rates
        passedRate := float64(stats.PacketsPassed-prevStats.PacketsPassed) /
            interval.Seconds()
        droppedRate := float64(stats.PacketsDropped-prevStats.PacketsDropped) /
            interval.Seconds()
        rateLimitedRate := float64(stats.PacketsRateLimited-prevStats.PacketsRateLimited) /
            interval.Seconds()

        fmt.Printf(
            "[%s] Passed: %.0f pps (%d total) | Dropped: %.0f pps (%d total) | Rate-limited: %.0f pps (%d total)\n",
            time.Now().Format("15:04:05"),
            passedRate, stats.PacketsPassed,
            droppedRate, stats.PacketsDropped,
            rateLimitedRate, stats.PacketsRateLimited,
        )

        prevStats = *stats
    }
}

// AutoBlockDDoSSources monitors stats and auto-blocks attack sources
func (fc *FirewallController) AutoBlockDDoSSources(
    threshold uint64,
    blockDuration time.Duration,
) {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    log.Printf("Auto-block enabled: threshold=%d pps, duration=%v", threshold, blockDuration)

    for range ticker.C {
        // Iterate through rate limit map to find sources exceeding threshold
        var key, nextKey struct {
            SrcIP    uint32
            DstPort  uint16
            Protocol uint8
            Pad      uint8
        }

        iter := fc.objects.RateLimitMap.Iterate()
        for iter.Next(&key, &nextKey) {
            // In production, you'd check the dropped_packets counter
            // and auto-block sources with consistently high drop rates
            _ = key
        }
    }
}

// Close detaches the XDP program and releases resources
func (fc *FirewallController) Close() error {
    if fc.link != nil {
        if err := fc.link.Close(); err != nil {
            return fmt.Errorf("detaching XDP: %w", err)
        }
    }
    if fc.objects != nil {
        fc.objects.Close()
    }
    log.Println("XDP firewall detached")
    return nil
}

func main() {
    if len(os.Args) < 2 {
        fmt.Fprintf(os.Stderr, "Usage: %s <interface>\n", os.Args[0])
        os.Exit(1)
    }

    ifaceName := os.Args[1]

    // Create and attach firewall
    fc, err := NewFirewallController(ifaceName)
    if err != nil {
        log.Fatalf("Creating firewall: %v", err)
    }
    defer fc.Close()

    // Example: block a known malicious IP
    if err := fc.BlockIP("192.168.100.100", 3600, 1); err != nil {
        log.Printf("Warning: %v", err)
    }

    // Start statistics printing
    go fc.PrintStats(5 * time.Second)

    // Start auto-blocking
    go fc.AutoBlockDDoSSources(100000, 1*time.Hour)

    // Wait for signal
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
    <-sig

    log.Println("Shutting down XDP firewall...")
}
```

## Part 4: Advanced Techniques

### IP Prefix Matching with LPM Trie

For CIDR-based blocking (blocking entire subnets), use the BPF_MAP_TYPE_LPM_TRIE:

```c
/* LPM (Longest Prefix Match) trie for subnet blocking */
struct lpm_key {
    __u32 prefixlen;
    __u32 data;
};

struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __uint(max_entries, 10000);
    __type(key, struct lpm_key);
    __type(value, struct blocklist_value);
    __uint(map_flags, BPF_F_NO_PREALLOC);
} subnet_blocklist SEC(".maps");

static __always_inline
int check_subnet_blocklist(__u32 src_ip)
{
    struct lpm_key key = {
        .prefixlen = 32,  /* Match exact IP first */
        .data = src_ip,
    };
    return bpf_map_lookup_elem(&subnet_blocklist, &key) != NULL;
}
```

Add subnets from userspace:

```go
// BlockSubnet adds a CIDR range to the subnet blocklist
func (fc *FirewallController) BlockSubnet(cidr string) error {
    _, ipNet, err := net.ParseCIDR(cidr)
    if err != nil {
        return fmt.Errorf("parsing CIDR: %w", err)
    }

    ones, _ := ipNet.Mask.Size()
    ip4 := ipNet.IP.To4()
    if ip4 == nil {
        return fmt.Errorf("only IPv4 CIDRs supported")
    }

    type LPMKey struct {
        Prefixlen uint32
        Data      uint32
    }

    key := LPMKey{
        Prefixlen: uint32(ones),
        Data:      binary.BigEndian.Uint32(ip4),
    }

    value := BlocklistValue{
        BlockedAt: uint64(time.Now().Unix()),
        Reason:    2, // subnet block
    }

    return fc.objects.SubnetBlocklist.Put(
        unsafe.Pointer(&key),
        unsafe.Pointer(&value),
    )
}
```

### Geo-Blocking with Country Code Mapping

```c
/* Country code to XDP action mapping */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 256);
    __type(key, __u32);    /* Country code as uint32 */
    __type(value, __u8);   /* XDP action: XDP_PASS or XDP_DROP */
} geo_rules SEC(".maps");

/* ASN-to-country mapping - populated from GeoIP database */
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __uint(max_entries, 200000);  /* All BGP prefixes */
    __type(key, struct lpm_key);
    __type(value, __u32);  /* Country code */
    __uint(map_flags, BPF_F_NO_PREALLOC);
} geo_prefix_map SEC(".maps");
```

### Performance Testing

```bash
#!/bin/bash
# xdp-perf-test.sh - Test XDP firewall performance

INTERFACE="${1:-eth0}"
TEST_DURATION=10

echo "=== XDP Firewall Performance Test ==="
echo "Interface: $INTERFACE"
echo "Duration:  ${TEST_DURATION}s"

# Baseline: test without XDP
echo ""
echo "--- Baseline (no XDP) ---"
ip link set "$INTERFACE" xdp off 2>/dev/null || true
perf stat -e \
    cpu-cycles,instructions,cache-references,cache-misses,\
    net:net_dev_xmit,net:netif_receive_skb \
    -a sleep "$TEST_DURATION" 2>&1 | grep -E "net:|cycles|instructions"

# Load XDP in generic mode (software)
echo ""
echo "--- XDP Generic Mode ---"
./xdp_loader "$INTERFACE" generic
sleep 1
perf stat -e \
    cpu-cycles,instructions,cache-references,cache-misses,\
    xdp:xdp_exception,xdp:xdp_redirect \
    -a sleep "$TEST_DURATION" 2>&1

# Check kernel XDP stats
echo ""
echo "--- XDP Statistics ---"
bpftool map show | grep -E "id|name"
bpftool prog show name xdp_firewall_main

# Packet rate measurement using ethtool
echo ""
echo "--- Packet Rate ---"
for i in $(seq 1 3); do
    RX1=$(ethtool -S "$INTERFACE" | grep rx_packets | awk '{print $2}' | head -1)
    sleep 1
    RX2=$(ethtool -S "$INTERFACE" | grep rx_packets | awk '{print $2}' | head -1)
    echo "RX rate: $((RX2 - RX1)) pps"
done
```

## Operational Considerations

### Loading XDP in Different Modes

```bash
# Native mode (fastest - requires driver support)
ip link set dev eth0 xdp object xdp_firewall.o section xdp

# Generic mode (software fallback - works on all NICs)
ip link set dev eth0 xdp generic object xdp_firewall.o section xdp

# Offload mode (fastest - executed on SmartNIC)
ip link set dev eth0 xdp offload object xdp_firewall.o section xdp

# Check current XDP mode
ip link show eth0 | grep xdp

# Remove XDP program
ip link set dev eth0 xdp off
```

### Persisting Rules Across Restarts

```bash
# Pin the BPF maps to the filesystem for persistence
mount -t bpf bpf /sys/fs/bpf/

# Pin maps during program load
bpftool prog load xdp_firewall.o /sys/fs/bpf/xdp_firewall \
    pinmaps /sys/fs/bpf/xdp_maps

# Access pinned maps from userspace
bpftool map dump pinned /sys/fs/bpf/xdp_maps/blocklist
```

### Integration with DDoS Mitigation Workflow

```bash
#!/bin/bash
# ddos-response.sh - Automated DDoS response using XDP

XDP_CONTROLLER="./xdp_controller"
NETFLOW_LOG="/var/log/netflow/current.log"
BLOCK_THRESHOLD=100000  # pps

echo "Starting DDoS response monitor..."

while true; do
    # Parse top sources from NetFlow data
    TOP_SOURCES=$(cat "$NETFLOW_LOG" | \
        awk '{print $4}' | \
        sort | uniq -c | sort -rn | \
        awk '$1 > '"$BLOCK_THRESHOLD"' {print $2}' | \
        head -20)

    for src_ip in $TOP_SOURCES; do
        echo "Auto-blocking attack source: $src_ip"
        $XDP_CONTROLLER block "$src_ip" --ttl 3600 --reason "ddos_auto"

        # Alert via PagerDuty or Slack
        curl -s -X POST https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN> \
            -H 'Content-type: application/json' \
            -d "{\"text\":\"XDP auto-blocked DDoS source: $src_ip\"}"
    done

    sleep 5
done
```

## Key Takeaways

XDP-based network security provides capabilities that are simply impossible with traditional iptables or nftables at high packet rates. The key architectural decisions:

**Choose XDP mode carefully**: Native mode requires driver support but provides the highest performance. Generic mode works universally but runs in software. Test your specific NIC drivers to determine which modes are supported.

**Maps are the configuration interface**: eBPF maps allow userspace to communicate with kernel programs atomically. The map update model means firewall rule changes are instant and race-free.

**LRU maps prevent memory exhaustion**: For state that should age out (connection tracking, rate limiter state), LRU hash maps prevent the kernel from running out of memory during attacks.

**Monitor with per-CPU arrays**: Per-CPU statistics avoid atomic contention in the hot path, then aggregate in userspace. This is the pattern used in production high-performance systems.

**Layer XDP with nftables**: XDP drops volumetric attacks at the NIC. For stateful filtering and complex policy, pass traffic to nftables running in the kernel network stack. This hybrid approach gets the best of both worlds.
