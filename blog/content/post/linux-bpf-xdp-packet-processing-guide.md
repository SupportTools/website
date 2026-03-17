---
title: "Linux XDP and BPF: High-Performance Packet Processing at the NIC"
date: 2028-09-25T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "XDP", "Networking", "Performance"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux XDP and eBPF packet processing including XDP program structure, libbpf development workflow, BPF maps, AF_XDP sockets, BTF and CO-RE for portability, bpftrace for observability, and building a DDoS mitigation prototype."
more_link: "yes"
url: "/linux-bpf-xdp-packet-processing-guide/"
---

XDP (eXpress Data Path) runs eBPF programs at the earliest possible point in the Linux network stack — before the kernel allocates an `sk_buff`, before netfilter, before routing. This placement enables packet processing at wire speed on modern NICs: tens of millions of packets per second on a single CPU core, with the ability to drop, modify, redirect, or pass packets with latencies measured in nanoseconds.

This guide builds up from a minimal XDP drop program to a functional DDoS mitigation system, covering the complete libbpf-based development workflow.

<!--more-->

# Linux XDP and BPF: High-Performance Packet Processing at the NIC

## Development Environment Setup

```bash
# Ubuntu 22.04 / 24.04
apt-get install -y \
    clang llvm \
    libelf-dev \
    libbpf-dev \
    linux-headers-$(uname -r) \
    bpftool \
    linux-tools-$(uname -r) \
    iproute2 \
    tcpdump \
    netcat-openbsd

# Verify kernel version (XDP requires 4.8+, full feature set at 5.4+)
uname -r

# Check BPF capabilities
bpftool version
ls /sys/fs/bpf

# Mount the BPF filesystem if not auto-mounted
mount -t bpf bpf /sys/fs/bpf
```

## XDP Program Structure

XDP programs are eBPF programs loaded at the XDP hook point. They receive a pointer to `xdp_md` and return an action code.

### Minimal XDP Program

```c
// xdp_minimal.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

// The SEC() macro marks the program with the correct section name
// so the loader knows where to attach it
SEC("xdp")
int xdp_pass(struct xdp_md *ctx)
{
    // ctx->data: pointer to start of packet data
    // ctx->data_end: pointer past end of packet data
    // ctx->ingress_ifindex: interface index packet arrived on

    // Always validate pointers before dereferencing
    // The verifier enforces this
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    // Ensure there is at least one byte
    if (data >= data_end)
        return XDP_DROP;

    // Pass the packet up the stack
    return XDP_PASS;
}

// License must be GPL for XDP programs that use GPL-only helpers
char _license[] SEC("license") = "GPL";
```

XDP return codes:

| Code | Value | Behavior |
|------|-------|----------|
| `XDP_ABORTED` | 0 | Drop, generate tracepoint event (debugging) |
| `XDP_DROP` | 1 | Drop immediately at the driver level |
| `XDP_PASS` | 2 | Continue up the normal stack |
| `XDP_TX` | 3 | Retransmit on the same interface |
| `XDP_REDIRECT` | 4 | Redirect to another interface or CPU (via maps) |

### Compiling and Loading

```bash
# Compile to BPF object file
clang -O2 -g \
    -target bpf \
    -D__KERNEL__ \
    -I/usr/include/linux \
    -I/usr/include \
    -c xdp_minimal.c \
    -o xdp_minimal.o

# Inspect the compiled program
llvm-objdump -S xdp_minimal.o

# Load and attach using ip link
ip link set dev eth0 xdp obj xdp_minimal.o sec xdp

# Or using xdpgeneric (software mode, slower but works on all NICs)
ip link set dev eth0 xdpgeneric obj xdp_minimal.o sec xdp

# Verify it's loaded
ip link show eth0
# xdp attached (id 42)

# Remove the XDP program
ip link set dev eth0 xdp off

# Using bpftool for inspection
bpftool prog list
bpftool prog show id 42
bpftool prog dump xlated id 42      # Decoded BPF instructions
bpftool prog dump jited id 42       # JIT-compiled native code
```

## Parsing Packets: Ethernet, IP, TCP/UDP

```c
// xdp_packet_parse.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Helper: advance a pointer and check bounds
// Returns NULL if advancing would exceed data_end
static __always_inline void *bounds_check(void *ptr, __u32 size, void *data_end)
{
    if (ptr + size > data_end)
        return NULL;
    return ptr;
}

SEC("xdp")
int xdp_parser(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;
    __u16 eth_type;
    __u8 ip_proto;
    __u32 src_ip = 0;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if (!bounds_check(eth, sizeof(*eth), data_end))
        return XDP_PASS;

    eth_type = bpf_ntohs(eth->h_proto);

    // Only process IPv4 for now
    if (eth_type != ETH_P_IP)
        return XDP_PASS;

    // Parse IPv4 header
    struct iphdr *ip = (void *)(eth + 1);
    if (!bounds_check(ip, sizeof(*ip), data_end))
        return XDP_PASS;

    // Reject fragments
    if (ip->frag_off & bpf_htons(IP_MF | IP_OFFSET))
        return XDP_PASS;

    src_ip  = ip->saddr;
    ip_proto = ip->protocol;

    // Calculate IP header length (variable due to options)
    __u32 ip_hlen = ip->ihl * 4;
    if (ip_hlen < sizeof(*ip))
        return XDP_DROP;  // Malformed

    void *l4 = (void *)ip + ip_hlen;

    if (ip_proto == IPPROTO_TCP) {
        struct tcphdr *tcp = l4;
        if (!bounds_check(tcp, sizeof(*tcp), data_end))
            return XDP_PASS;

        __u16 dst_port = bpf_ntohs(tcp->dest);

        // Example: block port 23 (Telnet) entirely
        if (dst_port == 23)
            return XDP_DROP;

    } else if (ip_proto == IPPROTO_UDP) {
        struct udphdr *udp = l4;
        if (!bounds_check(udp, sizeof(*udp), data_end))
            return XDP_PASS;

        __u16 dst_port = bpf_ntohs(udp->dest);

        // Block UDP amplification sources (DNS amplification often on port 53)
        (void)dst_port;  // Use as needed
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

## BPF Maps

BPF maps are the primary mechanism for sharing state between the BPF program and userspace, and between BPF programs on different CPUs.

### Hash Map: IP Blocklist

```c
// xdp_blocklist.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// BPF_MAP_TYPE_HASH: key/value hash table
// Max entries should be a power of 2
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key,   __u32);    // IPv4 source address (network byte order)
    __type(value, __u64);    // Block reason/timestamp
} blocklist_map SEC(".maps");

// Per-CPU array map for packet counters (no lock needed)
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 2);  // [0] = passed, [1] = dropped
    __type(key,   __u32);
    __type(value, __u64);
} pkt_counter SEC(".maps");

SEC("xdp")
int xdp_blocklist(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;

    // Check if source IP is in the blocklist
    __u64 *blocked = bpf_map_lookup_elem(&blocklist_map, &src_ip);
    if (blocked) {
        // Increment drop counter
        __u32 key = 1;
        __u64 *cnt = bpf_map_lookup_elem(&pkt_counter, &key);
        if (cnt)
            __sync_fetch_and_add(cnt, 1);

        return XDP_DROP;
    }

    // Increment pass counter
    __u32 key = 0;
    __u64 *cnt = bpf_map_lookup_elem(&pkt_counter, &key);
    if (cnt)
        __sync_fetch_and_add(cnt, 1);

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

### LRU Hash Map: Connection Rate Limiting

```c
// xdp_ratelimit.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// LRU hash automatically evicts the least-recently-used entry
// when full — no manual eviction needed
struct conn_state {
    __u64 pkt_count;
    __u64 first_seen_ns;
    __u64 last_seen_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 100000);
    __type(key,   __u32);            // Source IP
    __type(value, struct conn_state);
} conn_tracker SEC(".maps");

// Rate limit: max 10000 packets per second per source IP
#define RATE_LIMIT_PPS  10000
#define WINDOW_NS       1000000000ULL  // 1 second in nanoseconds

SEC("xdp")
int xdp_ratelimit(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;
    __u64 now = bpf_ktime_get_ns();

    struct conn_state *state = bpf_map_lookup_elem(&conn_tracker, &src_ip);
    if (!state) {
        // First packet from this IP
        struct conn_state new_state = {
            .pkt_count    = 1,
            .first_seen_ns = now,
            .last_seen_ns  = now,
        };
        bpf_map_update_elem(&conn_tracker, &src_ip, &new_state, BPF_ANY);
        return XDP_PASS;
    }

    // Reset window if more than 1 second has passed
    if (now - state->first_seen_ns > WINDOW_NS) {
        state->pkt_count     = 1;
        state->first_seen_ns = now;
        state->last_seen_ns  = now;
        return XDP_PASS;
    }

    state->pkt_count++;
    state->last_seen_ns = now;

    // Enforce rate limit
    if (state->pkt_count > RATE_LIMIT_PPS) {
        return XDP_DROP;
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

## libbpf-Based Userspace Loader

Modern BPF programs use libbpf's skeleton-based loader, which is generated at compile time and provides type-safe access to maps and programs.

### Project Structure

```
xdp-ddos/
├── CMakeLists.txt
├── src/
│   ├── xdp_ddos.bpf.c     # BPF (kernel) program
│   ├── xdp_ddos.c          # Userspace control program
│   └── xdp_ddos.h          # Shared types
└── vmlinux.h               # Generated with: bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
```

```c
// src/xdp_ddos.h - Shared between kernel and userspace
#pragma once
#include <linux/types.h>

struct event {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  proto;
    __u8  action;    // 0=pass, 1=drop, 2=rate-limited
    __u64 timestamp;
};

#define ACTION_PASS        0
#define ACTION_DROP        1
#define ACTION_RATELIMITED 2
```

```c
// src/xdp_ddos.bpf.c - BPF kernel program with CO-RE
// CO-RE (Compile Once - Run Everywhere) via BTF allows the
// same binary to run on different kernel versions

// Use vmlinux.h instead of individual kernel headers
// This requires BTF support in the kernel (5.4+)
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_core_read.h>
#include "xdp_ddos.h"

// Perf event map for sending events to userspace
struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(int));
    __uint(value_size, sizeof(int));
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 65536);
    __type(key,   __u32);
    __type(value, __u64);  // Packet count in window
} blocklist SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_PERCPU_HASH);
    __uint(max_entries, 100000);
    __type(key,   __u32);
    __type(value, __u64);
} rate_counters SEC(".maps");

// Configurable threshold via map (userspace can update)
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key,   __u32);
    __type(value, __u32);
} config SEC(".maps");

static __always_inline int parse_ipv4(
    void *data, void *data_end,
    __u32 *src_ip, __u32 *dst_ip, __u8 *proto)
{
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return -1;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return -1;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return -1;

    *src_ip = ip->saddr;
    *dst_ip = ip->daddr;
    *proto  = ip->protocol;
    return 0;
}

SEC("xdp")
int xdp_ddos_filter(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;
    __u32 src_ip, dst_ip;
    __u8 proto;

    if (parse_ipv4(data, data_end, &src_ip, &dst_ip, &proto) < 0)
        return XDP_PASS;

    // Check blocklist first (fast path)
    if (bpf_map_lookup_elem(&blocklist, &src_ip))
        return XDP_DROP;

    // Rate limit check
    __u32 config_key = 0;
    __u32 *threshold = bpf_map_lookup_elem(&config, &config_key);
    __u32 rate_limit = threshold ? *threshold : 10000;

    __u64 *count = bpf_map_lookup_elem(&rate_counters, &src_ip);
    if (count) {
        __sync_fetch_and_add(count, 1);
        if (*count > rate_limit) {
            // Send event to userspace for decision
            struct event evt = {
                .src_ip    = src_ip,
                .dst_ip    = dst_ip,
                .proto     = proto,
                .action    = ACTION_RATELIMITED,
                .timestamp = bpf_ktime_get_ns(),
            };
            bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU,
                                  &evt, sizeof(evt));
            return XDP_DROP;
        }
    } else {
        __u64 init = 1;
        bpf_map_update_elem(&rate_counters, &src_ip, &init, BPF_ANY);
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

```c
// src/xdp_ddos.c - Userspace controller
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <linux/perf_event.h>
#include <sys/resource.h>
#include <bpf/libbpf.h>
#include "xdp_ddos.skel.h"   // Auto-generated by bpftool gen skeleton
#include "xdp_ddos.h"

static volatile bool exiting = false;

static void sig_handler(int sig)
{
    (void)sig;
    exiting = true;
}

static void handle_event(void *ctx, int cpu, void *data, __u32 size)
{
    struct event *evt = data;
    char src_str[INET_ADDRSTRLEN];

    inet_ntop(AF_INET, &evt->src_ip, src_str, sizeof(src_str));

    if (evt->action == ACTION_RATELIMITED) {
        printf("[%llu] RATE-LIMITED src=%s proto=%d\n",
               evt->timestamp, src_str, evt->proto);

        // Auto-block IPs that consistently hit the rate limit
        // In production: implement a smarter policy
        struct xdp_ddos_bpf *skel = ctx;
        __u64 block_reason = evt->timestamp;
        bpf_map__update_elem(skel->maps.blocklist,
                             &evt->src_ip, sizeof(__u32),
                             &block_reason, sizeof(__u64),
                             BPF_ANY);
        printf("  -> Added %s to blocklist\n", src_str);
    }
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <interface>\n", argv[0]);
        return 1;
    }

    const char *ifname = argv[1];
    int ifindex = if_nametoindex(ifname);
    if (!ifindex) {
        fprintf(stderr, "Interface %s not found\n", ifname);
        return 1;
    }

    // Increase rlimit for locked memory (required for BPF maps)
    struct rlimit r = {RLIM_INFINITY, RLIM_INFINITY};
    if (setrlimit(RLIMIT_MEMLOCK, &r)) {
        perror("setrlimit");
        return 1;
    }

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    // Load BPF skeleton (generated by: bpftool gen skeleton xdp_ddos.bpf.o > xdp_ddos.skel.h)
    struct xdp_ddos_bpf *skel = xdp_ddos_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open/load BPF skeleton\n");
        return 1;
    }

    // Set initial rate limit threshold (10000 pps)
    __u32 config_key = 0;
    __u32 rate_limit  = 10000;
    bpf_map__update_elem(skel->maps.config,
                         &config_key, sizeof(config_key),
                         &rate_limit, sizeof(rate_limit),
                         BPF_ANY);

    // Attach XDP program to interface
    // XDP_FLAGS_DRV_MODE: native driver mode (fastest)
    // XDP_FLAGS_SKB_MODE: generic software mode (any NIC)
    LIBBPF_OPTS(bpf_xdp_attach_opts, opts);
    int prog_fd = bpf_program__fd(skel->progs.xdp_ddos_filter);
    if (bpf_xdp_attach(ifindex, prog_fd, XDP_FLAGS_DRV_MODE, &opts) < 0) {
        fprintf(stderr, "Native mode failed, trying SKB mode\n");
        if (bpf_xdp_attach(ifindex, prog_fd, XDP_FLAGS_SKB_MODE, &opts) < 0) {
            perror("bpf_xdp_attach");
            xdp_ddos_bpf__destroy(skel);
            return 1;
        }
    }

    printf("XDP DDoS filter attached to %s\n", ifname);

    // Set up perf event buffer to receive events from the BPF program
    struct perf_buffer *pb = perf_buffer__new(
        bpf_map__fd(skel->maps.events),
        8,          // 8 pages per CPU buffer
        handle_event,
        NULL,
        skel,       // Context passed to handle_event
        NULL
    );

    if (!pb) {
        fprintf(stderr, "Failed to create perf buffer\n");
        goto cleanup;
    }

    printf("Listening for DDoS events (Ctrl+C to stop)\n");

    while (!exiting) {
        int err = perf_buffer__poll(pb, 100);  // 100ms timeout
        if (err < 0 && errno != EINTR) {
            fprintf(stderr, "perf_buffer__poll error: %d\n", err);
            break;
        }
    }

    perf_buffer__free(pb);

cleanup:
    bpf_xdp_detach(ifindex, XDP_FLAGS_DRV_MODE, &opts);
    xdp_ddos_bpf__destroy(skel);
    printf("XDP program detached\n");
    return 0;
}
```

```makefile
# Makefile
CLANG   ?= clang
CC      ?= gcc
BPFTOOL ?= bpftool

CFLAGS  := -O2 -g -Wall
BPF_CFLAGS := -O2 -g -target bpf -D__TARGET_ARCH_x86

.PHONY: all clean vmlinux

all: xdp_ddos

vmlinux.h:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

# Compile BPF kernel program
xdp_ddos.bpf.o: src/xdp_ddos.bpf.c vmlinux.h src/xdp_ddos.h
	$(CLANG) $(BPF_CFLAGS) \
		-I. -Isrc \
		-c $< -o $@

# Generate the BPF skeleton header
xdp_ddos.skel.h: xdp_ddos.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

# Compile userspace program
xdp_ddos: src/xdp_ddos.c xdp_ddos.skel.h src/xdp_ddos.h
	$(CC) $(CFLAGS) \
		-I. -Isrc \
		$< -o $@ \
		-lbpf -lelf -lz

clean:
	rm -f *.o *.skel.h xdp_ddos vmlinux.h
```

## bpftrace for Observability

bpftrace provides a high-level scripting language for eBPF-based observability without writing C.

```bash
# Install bpftrace
apt-get install -y bpftrace

# Count packets by protocol using XDP tracepoints
bpftrace -e '
tracepoint:net:netif_receive_skb {
    @[args->name] = count();
}

interval:s:1 {
    print(@);
    clear(@);
}
'

# Trace slow network syscalls (>1ms)
bpftrace -e '
kprobe:tcp_sendmsg {
    @start[tid] = nsecs;
}

kretprobe:tcp_sendmsg /@start[tid]/ {
    $duration = (nsecs - @start[tid]) / 1000000;
    if ($duration > 1) {
        printf("tcp_sendmsg: pid=%d comm=%s duration=%dms\n",
               pid, comm, $duration);
    }
    delete(@start[tid]);
}
'

# Monitor TCP connection state changes
bpftrace -e '
kprobe:tcp_set_state {
    $sk = (struct sock *)arg0;
    $oldstate = (int)arg1;
    $newstate = (int)arg2;
    printf("pid=%d comm=%s %d -> %d\n",
           pid, comm, $oldstate, $newstate);
}
'

# Count XDP drops per interface
bpftrace -e '
tracepoint:xdp:xdp_exception {
    @drops[args->ifindex, args->act] = count();
}

interval:s:5 {
    print(@drops);
    clear(@drops);
}
'

# Profile packet processing latency
bpftrace -e '
BEGIN { printf("Tracing XDP latency...\n"); }

tracepoint:xdp:xdp_entry { @start[tid] = nsecs; }

tracepoint:xdp:xdp_return /@start[tid]/ {
    $lat = nsecs - @start[tid];
    @hist = hist($lat);
    delete(@start[tid]);
}

END { print(@hist); }
'
```

## AF_XDP Sockets for Kernel Bypass

AF_XDP sockets allow XDP programs to redirect packets directly to userspace memory, bypassing most of the kernel network stack:

```c
// Conceptual structure for AF_XDP zero-copy receive
// Full implementation requires the xdp-tools library (libxdp) or libbpf

// The XDP program sends packets to userspace:
SEC("xdp")
int xdp_redirect_to_user(struct xdp_md *ctx)
{
    // UMEM ring is set up by userspace
    // XDP redirects matched packets directly to that memory
    // For most traffic, pass to kernel; redirect specific flows to AF_XDP

    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;
    struct ethhdr *eth = data;

    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // Only redirect UDP packets for user-space processing
    // (e.g., custom DNS server or DPDK-style application)
    if (bpf_ntohs(eth->h_proto) == ETH_P_IP) {
        struct iphdr *ip = (void *)(eth + 1);
        if ((void *)(ip + 1) > data_end)
            return XDP_PASS;

        if (ip->protocol == IPPROTO_UDP) {
            // Redirect to AF_XDP socket on queue 0
            return bpf_redirect_map(&xsk_map, ctx->rx_queue_index, XDP_PASS);
        }
    }

    return XDP_PASS;
}
```

## Running the DDoS Mitigation System

```bash
# Build the project
make all

# Run with root privileges
sudo ./xdp_ddos eth0

# In another terminal, send test traffic
# Normal traffic
hping3 -S -p 80 -c 100 192.168.1.100

# Flood traffic (should trigger rate limiting)
hping3 -S -p 80 --flood 192.168.1.100

# Monitor BPF maps in real time
watch -n1 'bpftool map dump name blocklist_map 2>/dev/null | head -20'
watch -n1 'bpftool map dump name rate_counters 2>/dev/null | head -20'

# Check XDP statistics
bpftool prog show name xdp_ddos_filter
cat /proc/net/dev | grep eth0

# View drop statistics via kernel tracepoints
bpftool prog tracelog
```

## Production Considerations

### XDP Modes

```bash
# Native XDP (fastest): requires driver support
# Check if your NIC supports it
ethtool -i eth0 | grep driver
# Intel i40e, ixgbe, mlx5, virtio-net (5.0+), bnxt all support native XDP

# Generic XDP (fallback): works on all NICs, ~50% of native speed
ip link set dev eth0 xdpgeneric obj program.o sec xdp

# Offloaded XDP (fastest possible): runs ON the NIC
# Requires specific NICs (Netronome Agilio, some Mellanox)
ip link set dev eth0 xdpoffload obj program.o sec xdp
```

### Verifier Limitations

The BPF verifier rejects programs that:
- Have loops without a bounded iteration count (use `bpf_loop()` helper in 5.17+)
- Access memory out of bounds (every pointer must be range-checked)
- Call non-whitelisted kernel functions
- Exceed the 1 million instruction limit
- Have unreachable code paths

```c
// Use __builtin_expect for common-path optimization
if (__builtin_expect(!!(data >= data_end), 0))
    return XDP_DROP;

// Bounded loop with bpf_loop() (kernel 5.17+)
// BPF_LOOP(nr_iters, callback, ctx, flags)
```

## Summary

XDP and eBPF enable packet processing at line rate in the Linux kernel without custom hardware or driver modifications. Key takeaways:

- XDP programs run before `sk_buff` allocation — this is the source of their performance advantage
- Always validate packet bounds before every pointer dereference; the verifier enforces this
- BPF maps provide shared state between kernel and userspace; use LRU maps for caches to avoid manual eviction
- CO-RE via BTF allows a single compiled BPF binary to run across different kernel versions
- Use the libbpf skeleton pattern for type-safe userspace loaders
- bpftrace provides rapid observability scripting without C code
- AF_XDP sockets enable userspace packet I/O with zero kernel copies for the highest-performance applications
- Prefer native XDP driver mode; fall back to generic mode only when the NIC driver lacks native support
