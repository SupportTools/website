---
title: "Linux XDP: eXpress Data Path for High-Performance Networking"
date: 2029-04-21T00:00:00-05:00
draft: false
tags: ["Linux", "XDP", "eBPF", "Networking", "Performance", "DDoS", "Cilium"]
categories: ["Linux", "Networking", "eBPF"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux XDP (eXpress Data Path): architecture, AF_XDP sockets, writing XDP programs with eBPF, packet filtering, load balancing, DDoS mitigation, and Cilium's XDP acceleration mode for Kubernetes."
more_link: "yes"
url: "/linux-xdp-express-data-path-high-performance-networking/"
---

XDP (eXpress Data Path) is a programmable, high-performance packet processing framework in the Linux kernel that allows eBPF programs to intercept and process packets at the earliest possible point in the networking stack — inside the NIC driver, before any memory allocation for socket buffers. This enables line-rate packet processing at 100+ Gbps on commodity hardware, making it the technology behind DDoS mitigation at hyperscalers and the fast data path in Cilium. This guide covers the full XDP stack from architecture through production deployment.

<!--more-->

# Linux XDP: eXpress Data Path for High-Performance Networking

## Section 1: XDP Architecture

### Where XDP Lives in the Networking Stack

```
NIC Hardware
    |
    v
NIC Driver (XDP hook point) <---- XDP program runs HERE
    |
    v  (if XDP_PASS returned)
skb allocation (kernel allocates socket buffer)
    |
    v
TC (Traffic Control) layer
    |
    v
Netfilter / iptables
    |
    v
IP routing
    |
    v
Transport layer (TCP/UDP)
    |
    v
Socket receive queue
    |
    v
User space application
```

By hooking at the driver level before `skb` allocation, XDP eliminates the primary cost of traditional packet processing: memory allocation for socket buffers. A standard kernel path processes roughly 1-2 million packets per second (Mpps) per core. XDP achieves 20-30+ Mpps per core on modern hardware.

### XDP Return Codes

Every XDP program returns one of five action codes:

| Action | Effect | Use Case |
|---|---|---|
| `XDP_DROP` | Drop packet immediately | Firewall, DDoS mitigation |
| `XDP_PASS` | Continue to normal kernel stack | Default handling |
| `XDP_TX` | Transmit packet back on same interface | Echo server, hairpin NAT |
| `XDP_REDIRECT` | Redirect to another interface or CPU | Load balancing, forwarding |
| `XDP_ABORTED` | Drop + trace (error indicator) | Debugging |

### XDP Program Modes

| Mode | Hooks at | Requires | Performance |
|---|---|---|---|
| Native (offload to NIC) | NIC firmware | Specific NIC model | Highest (hardware) |
| Native (driver) | NIC driver before skb alloc | Driver XDP support | High (~30 Mpps/core) |
| Generic (skb) | After skb allocation | Any interface | Moderate (same as TC) |

Check if your NIC/driver supports native XDP:

```bash
# List drivers with native XDP support
ip link show dev eth0
# Look for "xdp" or "xdpgeneric" in output

# Check with ethtool
ethtool -i eth0
# Drivers with native XDP: mlx5, i40e, ice, ixgbe, virtio_net, veth, bpfilter

# Verify XDP capabilities
ip link set dev eth0 xdp off 2>&1
# If "Operation not supported" -> no native, falls back to generic
```

## Section 2: Writing XDP Programs with eBPF

### Development Environment Setup

```bash
# Install dependencies (Ubuntu 22.04+)
sudo apt-get install -y \
    clang llvm libelf-dev libbpf-dev \
    linux-headers-$(uname -r) \
    bpftool perf

# Install libbpf
git clone https://github.com/libbpf/libbpf
cd libbpf/src && make && sudo make install

# Install bpf2go (for Go integration)
go install github.com/cilium/ebpf/cmd/bpf2go@latest
```

### XDP Program 1: Packet Counter

```c
// xdp_counter.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <bpf/bpf_helpers.h>

// BPF map to store per-CPU packet counts
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 2);
    __type(key, __u32);
    __type(value, __u64);
} packet_count SEC(".maps");

SEC("xdp")
int xdp_count_packets(struct xdp_md *ctx)
{
    // ctx->data and ctx->data_end are offsets relative to packet start
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Bounds check: verifier requires this
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;

    __u32 key = 0;
    __u64 *count = bpf_map_lookup_elem(&packet_count, &key);
    if (count)
        (*count)++;

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

```makefile
# Makefile
CLANG ?= clang
CFLAGS := -O2 -g -target bpf -D__TARGET_ARCH_x86_64

all: xdp_counter.o

xdp_counter.o: xdp_counter.c
	$(CLANG) $(CFLAGS) \
		-I/usr/include \
		-I/usr/include/x86_64-linux-gnu \
		-c $< -o $@

load:
	ip link set dev eth0 xdp object xdp_counter.o sec xdp

unload:
	ip link set dev eth0 xdp off
```

### XDP Program 2: IP-Based Packet Filter (Firewall)

```c
// xdp_firewall.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <arpa/inet.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Hash map of blocked source IPs
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);     // Longest prefix match for CIDR blocking
    __uint(max_entries, 65536);
    __uint(map_flags, BPF_F_NO_PREALLOC);
    __type(key, struct bpf_lpm_trie_key);     // prefix length + IP
    __type(value, __u64);                      // block reason / timestamp
} blocklist SEC(".maps");

// Stats map
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 4);
    __type(key, __u32);
    __type(value, __u64);
} stats SEC(".maps");

#define STAT_PASS     0
#define STAT_BLOCKED  1
#define STAT_MALFORMED 2

static __always_inline void increment_stat(__u32 key)
{
    __u64 *val = bpf_map_lookup_elem(&stats, &key);
    if (val)
        __sync_fetch_and_add(val, 1);
}

SEC("xdp")
int xdp_firewall(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) {
        increment_stat(STAT_MALFORMED);
        return XDP_DROP;
    }

    // Only handle IPv4
    if (eth->h_proto != bpf_htons(ETH_P_IP)) {
        return XDP_PASS;
    }

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end) {
        increment_stat(STAT_MALFORMED);
        return XDP_DROP;
    }

    // LPM trie lookup for source IP
    struct {
        __u32 prefixlen;
        __u32 addr;
    } key = {
        .prefixlen = 32,
        .addr      = ip->saddr,
    };

    if (bpf_map_lookup_elem(&blocklist, &key)) {
        increment_stat(STAT_BLOCKED);
        return XDP_DROP;
    }

    increment_stat(STAT_PASS);
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

### XDP Program 3: Load Balancer (ECMP)

```c
// xdp_lb.c — Simple consistent-hash load balancer
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define MAX_BACKENDS 8

// Backend server addresses
struct backend {
    __u32 ip;
    __u8  mac[6];
    __u32 ifindex;
};

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, MAX_BACKENDS);
    __type(key, __u32);
    __type(value, struct backend);
} backends SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u32);
} backend_count SEC(".maps");

static __always_inline __u32 hash_5tuple(
    __u32 src_ip, __u32 dst_ip,
    __u16 src_port, __u16 dst_port,
    __u8 proto)
{
    // FNV-1a hash of 5-tuple for consistent hashing
    __u32 hash = 2166136261u;
    hash ^= src_ip;   hash *= 16777619u;
    hash ^= dst_ip;   hash *= 16777619u;
    hash ^= src_port; hash *= 16777619u;
    hash ^= dst_port; hash *= 16777619u;
    hash ^= proto;    hash *= 16777619u;
    return hash;
}

SEC("xdp")
int xdp_load_balance(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_DROP;

    if (ip->protocol != IPPROTO_TCP)
        return XDP_PASS;

    struct tcphdr *tcp = (void *)ip + (ip->ihl * 4);
    if ((void *)(tcp + 1) > data_end)
        return XDP_DROP;

    // Determine backend via consistent hash
    __u32 count_key = 0;
    __u32 *count = bpf_map_lookup_elem(&backend_count, &count_key);
    if (!count || *count == 0)
        return XDP_PASS;

    __u32 hash = hash_5tuple(
        ip->saddr, ip->daddr,
        tcp->source, tcp->dest,
        ip->protocol
    );
    __u32 backend_idx = hash % *count;

    struct backend *be = bpf_map_lookup_elem(&backends, &backend_idx);
    if (!be)
        return XDP_PASS;

    // Rewrite destination MAC and IP
    __builtin_memcpy(eth->h_dest, be->mac, 6);
    ip->daddr = be->ip;

    // Recalculate IP checksum
    // (simplified — production needs incremental checksum update)
    ip->check = 0;
    // checksum calculation omitted for brevity

    // Redirect to backend interface
    return bpf_redirect(be->ifindex, 0);
}

char _license[] SEC("license") = "GPL";
```

## Section 3: AF_XDP Sockets

AF_XDP sockets allow user-space applications to bypass the kernel networking stack entirely and receive/transmit packets directly from/to NIC memory via shared ring buffers. This achieves kernel-bypass performance without requiring DPDK or special drivers.

### AF_XDP Architecture

```
NIC
 |
 +--> XDP Program (kernel)
       |
       +--> XDP_REDIRECT to AF_XDP socket
             |
             v
    ┌─────────────────────────────┐
    │  UMEM (shared memory)       │  <-- User allocated
    │  ┌──────┐ ┌──────┐ ┌──────┐│
    │  │frame0│ │frame1│ │frame2││
    │  └──────┘ └──────┘ └──────┘│
    └─────────────────────────────┘
              ↑               ↑
    ┌─────────┘               └───────┐
    │  Fill Ring (user->kernel)       │  Rx Completion Ring (kernel->user)
    │  Tx Ring   (user->kernel)       │  Completion Ring    (kernel->user)
    └─────────────────────────────────┘
    User space app reads/writes rings directly (mmap)
```

### AF_XDP in Go using cilium/ebpf

```go
// main.go — AF_XDP receiver
package main

import (
    "fmt"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"

    "github.com/cilium/ebpf/link"
    "github.com/vishvananda/netlink"
)

// To use AF_XDP sockets, load an XDP program that redirects
// to an XDP socket using BPF_MAP_TYPE_XSKMAP

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang xdp_redirect ./xdp_redirect.c

func main() {
    if len(os.Args) < 2 {
        log.Fatal("Usage: xdp-receiver <interface>")
    }
    ifaceName := os.Args[1]

    iface, err := net.InterfaceByName(ifaceName)
    if err != nil {
        log.Fatalf("interface %q: %v", ifaceName, err)
    }

    // Load pre-compiled eBPF program
    objs := xdp_redirectObjects{}
    if err := loadXdp_redirectObjects(&objs, nil); err != nil {
        log.Fatalf("loading BPF objects: %v", err)
    }
    defer objs.Close()

    // Attach XDP program to interface
    l, err := link.AttachXDP(link.XDPOptions{
        Program:   objs.XdpRedirectXsk,
        Interface: iface.Index,
    })
    if err != nil {
        log.Fatalf("attaching XDP: %v", err)
    }
    defer l.Close()

    fmt.Printf("XDP program attached to %s\n", ifaceName)
    fmt.Printf("Waiting for packets... Press Ctrl+C to exit\n")

    // Wait for signal
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
    <-stop

    fmt.Println("Detaching XDP program")
}
```

### Managing XDP Programs with bpftool

```bash
# List loaded XDP programs
bpftool prog show type xdp

# Show program details
bpftool prog show id 42

# Dump program instructions
bpftool prog dump xlated id 42

# Show maps used by a program
bpftool map show

# Dump map contents
bpftool map dump id 7

# Pin a program to the filesystem (persistent across process exit)
bpftool prog load xdp_firewall.o /sys/fs/bpf/xdp_firewall

# Attach pinned program
ip link set dev eth0 xdp pinned /sys/fs/bpf/xdp_firewall

# Show current XDP attachment
ip link show dev eth0 | grep xdp
```

## Section 4: XDP for DDoS Mitigation

XDP's ability to drop packets before any kernel processing makes it the gold standard for DDoS mitigation. A single core can drop 20-30 million packets per second — enough to absorb most volumetric attacks.

### Rate Limiting Per Source IP

```c
// xdp_ratelimit.c — Token bucket rate limiter per source IP
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>

#define NS_PER_SEC 1000000000ULL
#define RATE_PPS   10000  // Allow 10k packets/sec per source IP
#define BURST      1000   // Burst allowance

struct token_bucket {
    __u64 tokens;
    __u64 last_update_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1 << 20);  // 1M entries (LRU evicts old ones)
    __type(key, __u32);            // Source IP
    __type(value, struct token_bucket);
} rate_limits SEC(".maps");

SEC("xdp")
int xdp_ratelimit(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_DROP;

    __u32 src_ip = ip->saddr;
    __u64 now = bpf_ktime_get_ns();

    struct token_bucket *tb = bpf_map_lookup_elem(&rate_limits, &src_ip);
    if (!tb) {
        // New source IP — create bucket
        struct token_bucket new_tb = {
            .tokens = BURST,
            .last_update_ns = now,
        };
        bpf_map_update_elem(&rate_limits, &src_ip, &new_tb, BPF_ANY);
        return XDP_PASS;
    }

    // Replenish tokens based on elapsed time
    __u64 elapsed = now - tb->last_update_ns;
    __u64 new_tokens = (elapsed * RATE_PPS) / NS_PER_SEC;

    if (new_tokens > 0) {
        tb->tokens = tb->tokens + new_tokens;
        if (tb->tokens > BURST)
            tb->tokens = BURST;
        tb->last_update_ns = now;
    }

    // Check if we have tokens
    if (tb->tokens == 0) {
        return XDP_DROP;  // Rate limit exceeded
    }

    tb->tokens--;
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

### SYN Flood Mitigation

```c
// xdp_syn_cookie.c — SYN cookie validation to prevent SYN flood
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>

// BPF does not support full SYN cookie generation easily,
// but can validate incoming ACKs against a pre-computed table.
// Simpler approach: track half-open connections and rate-limit SYN packets.

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1 << 16);
    __type(key, __u32);    // Source IP
    __type(value, __u64);  // SYN packet count + timestamp
} syn_tracker SEC(".maps");

#define MAX_SYN_PER_SEC 100

SEC("xdp")
int xdp_syn_protect(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_DROP;
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end) return XDP_DROP;
    if (ip->protocol != IPPROTO_TCP) return XDP_PASS;

    struct tcphdr *tcp = (void *)ip + (ip->ihl * 4);
    if ((void *)(tcp + 1) > data_end) return XDP_DROP;

    // Only process SYN packets (SYN=1, ACK=0)
    if (!tcp->syn || tcp->ack)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;
    __u64 now_sec = bpf_ktime_get_ns() / NS_PER_SEC;

    __u64 *tracker = bpf_map_lookup_elem(&syn_tracker, &src_ip);
    if (!tracker) {
        __u64 initial = (now_sec << 32) | 1;
        bpf_map_update_elem(&syn_tracker, &src_ip, &initial, BPF_ANY);
        return XDP_PASS;
    }

    __u32 last_sec = *tracker >> 32;
    __u32 count    = *tracker & 0xFFFFFFFF;

    if (last_sec != (__u32)now_sec) {
        // New second — reset counter
        *tracker = (now_sec << 32) | 1;
        return XDP_PASS;
    }

    if (count >= MAX_SYN_PER_SEC)
        return XDP_DROP;  // Too many SYNs from this IP

    *tracker = (now_sec << 32) | (count + 1);
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

### Operational Pattern: Updating Blocklists Atomically

```bash
#!/bin/bash
# update-blocklist.sh — Atomically update XDP blocklist from threat feed

BLOCKLIST_MAP="blocklist"   # BPF map name
THREAT_FEED_URL="https://example.com/threat-feed.txt"

# Download latest blocklist
curl -sf "$THREAT_FEED_URL" -o /tmp/new_blocklist.txt

# Clear existing blocklist
bpftool map flush name "$BLOCKLIST_MAP"

# Load new entries
while IFS= read -r cidr; do
    [[ "$cidr" =~ ^#.*$ ]] && continue  # Skip comments
    [[ -z "$cidr" ]] && continue

    # Convert CIDR to key format
    IP=$(echo "$cidr" | cut -d/ -f1)
    PREFIX=$(echo "$cidr" | cut -d/ -f2)

    # bpftool map update with LPM trie key format
    bpftool map update name "$BLOCKLIST_MAP" \
        key hex $(printf '%02x' $PREFIX) 00 00 00 \
               $(printf '%d.%d.%d.%d\n' $(echo $IP | tr '.' '\n') | \
                 while read o; do printf '%02x ' $o; done) \
        value hex 01 00 00 00 00 00 00 00 2>/dev/null || true
done < /tmp/new_blocklist.txt

echo "Blocklist updated: $(wc -l < /tmp/new_blocklist.txt) entries"
```

## Section 5: XDP in Kubernetes with Cilium

Cilium leverages XDP for its highest-performance data path, eliminating iptables entirely for services that meet specific criteria.

### Cilium XDP Acceleration

```yaml
# Helm values for Cilium with XDP acceleration
# cilium-values.yaml
loadBalancer:
  # XDP acceleration: requires native-mode NIC support
  acceleration: native   # or "best-effort" to fall back to generic

bpf:
  # Masquerade in eBPF (no iptables)
  masquerade: true
  # Disable iptables entirely
  hostLegacyRouting: false

# Enable kube-proxy replacement
kubeProxyReplacement: true

# Node IP MASQ configuration
ipMasqAgent:
  enabled: true

# XDP-based NodePort for 40%+ latency improvement
nodePort:
  acceleration: native
```

```bash
# Install Cilium with XDP acceleration
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set loadBalancer.acceleration=native \
  --set bpf.masquerade=true \
  --set kubeProxyReplacement=true

# Verify XDP is in use
cilium status
# Expected output includes:
# KubeProxyReplacement: True (Strict)
# LoadBalancer & NodePort XDP Acceleration: NATIVE, NATIVE

# Check which interfaces have XDP programs loaded
ip link show | grep xdp
# eth0: <...> xdp/id:42 <...>
```

### Cilium Bandwidth Manager with XDP

```yaml
# Enable bandwidth manager for pod-level egress QoS
bandwidthManager:
  enabled: true
  # Use EDT (Earliest Departure Time) algorithm for fair queuing
  bbr: true
```

```yaml
# Apply per-pod bandwidth limits via annotation
apiVersion: v1
kind: Pod
metadata:
  name: limited-pod
  annotations:
    kubernetes.io/egress-bandwidth: "100M"   # 100 Mbps egress
    kubernetes.io/ingress-bandwidth: "50M"   # 50 Mbps ingress
spec:
  containers:
  - name: app
    image: nginx:latest
```

### Monitoring XDP Performance in Cilium

```bash
# Real-time XDP statistics
cilium bpf lb list

# View XDP metrics
cilium metrics list | grep xdp

# Monitor drop rate
watch -n 1 'cilium bpf recorder list'

# Hubble for flow visibility
hubble observe --from-pod default/myapp --verdict DROPPED
```

## Section 6: XDP Benchmarking and Performance Validation

### Benchmarking with pktgen

```bash
# Install pktgen-dpdk or use kernel pktgen
# For quick testing, use xdp-bench from xdp-tools

# Install xdp-tools
git clone https://github.com/xdp-project/xdp-tools
cd xdp-tools && make

# Benchmark XDP_DROP throughput
sudo ./xdp-bench drop eth0 --mode native

# Example output:
# Receive  rate:  29,765,432 pps (  14.3 Gpbs)
# Drop     rate:  29,765,432 pps (  14.3 Gbps)
# Pass     rate:           0 pps

# Benchmark XDP_TX throughput
sudo ./xdp-bench tx eth0 --mode native
```

### Profiling XDP Programs with bpftrace

```bash
# Trace XDP return codes distribution
bpftrace -e '
tracepoint:xdp:xdp_exception {
    @exceptions[args->act] = count();
}
interval:s:5 {
    print(@exceptions);
    clear(@exceptions);
}'

# Measure XDP program execution latency
bpftrace -e '
kprobe:__xdp_run_prog_redirect {
    @start = nsecs;
}
kretprobe:__xdp_run_prog_redirect {
    @latency = hist(nsecs - @start);
}'
```

### Performance Comparison: iptables vs XDP

| Scenario | iptables (1 core) | XDP Generic | XDP Native |
|---|---|---|---|
| Drop all packets | ~1 Mpps | ~4 Mpps | ~20-30 Mpps |
| Block specific IP | ~0.8 Mpps | ~3.5 Mpps | ~20-28 Mpps |
| Load balance (ECMP) | ~0.5 Mpps | ~2 Mpps | ~15-25 Mpps |
| CPU per 1Mpps | ~100% core | ~25% core | ~3-5% core |

## Section 7: Operational Considerations

### Rolling Out XDP Programs Safely

```bash
#!/bin/bash
# safe-xdp-deploy.sh — Deploy XDP program with fallback

INTERFACE="${1:-eth0}"
XDP_PROG="${2:-xdp_firewall.o}"
SECTION="${3:-xdp}"

echo "Deploying $XDP_PROG to $INTERFACE"

# Test with generic mode first (no performance benefit but validates program)
if ip link set dev "$INTERFACE" xdpgeneric object "$XDP_PROG" sec "$SECTION"; then
    echo "Generic mode test passed"
    ip link set dev "$INTERFACE" xdpgeneric off
else
    echo "XDP program failed generic mode test. Aborting."
    exit 1
fi

# Deploy in native mode
if ip link set dev "$INTERFACE" xdp object "$XDP_PROG" sec "$SECTION"; then
    echo "Native XDP deployed successfully"
    # Verify attachment
    ip link show dev "$INTERFACE" | grep -q "xdp/id:" && \
        echo "XDP program ID: $(ip link show dev $INTERFACE | grep -o 'xdp/id:[0-9]*' | cut -d: -f2)"
else
    echo "Native XDP not supported, falling back to generic"
    ip link set dev "$INTERFACE" xdpgeneric object "$XDP_PROG" sec "$SECTION"
fi
```

### Resource Limits for eBPF Maps

```bash
# BPF maps consume locked memory (exempt from normal ulimit)
# Check current usage
cat /proc/sys/kernel/bpf_stats_enabled

# Set BPF memory limit (kernel 5.11+)
# In /etc/sysctl.conf:
# kernel.unprivileged_bpf_disabled = 1   (security: require CAP_BPF)

# Check map memory usage
bpftool map show | grep -E 'bytes_key|bytes_value|max_entries'

# Calculate memory: max_entries * (key_size + value_size + overhead)
# LRU_HASH 1M entries with 4B key + 16B value ≈ ~50MB
```

### Kernel Version Requirements

| Feature | Minimum Kernel |
|---|---|
| Basic XDP | 4.8 |
| XDP_REDIRECT | 4.14 |
| AF_XDP | 4.18 |
| XDP in network namespaces | 5.2 |
| BTF (for CO-RE programs) | 5.2 |
| XDP multi-buffer (jumbo frames) | 5.18 |
| XDP cpumap redirect | 4.15 |

```bash
# Check kernel version
uname -r

# Check BPF feature support
bpftool feature probe kernel
```

## Section 8: Security Considerations

### Privilege Requirements

```bash
# XDP requires CAP_NET_ADMIN to attach programs
# In Kubernetes, this means the Pod needs the capability:
securityContext:
  capabilities:
    add:
    - NET_ADMIN
    - SYS_ADMIN   # Required for bpf() syscall in older kernels

# Or use CAP_BPF (kernel 5.8+, more granular)
securityContext:
  capabilities:
    add:
    - NET_ADMIN
    - BPF
```

### Program Verification

The kernel's eBPF verifier rejects unsafe programs at load time:
- All memory accesses must be bounds-checked
- No unbounded loops (kernel 5.3+: bounded loops allowed)
- No null pointer dereferences
- Program must terminate (no infinite loops in pre-5.3 kernels)

```c
// WRONG: missing bounds check — verifier will reject
SEC("xdp")
int unsafe_prog(struct xdp_md *ctx) {
    struct ethhdr *eth = (void *)(long)ctx->data;
    // Access eth->h_proto without checking bounds — REJECTED
    if (eth->h_proto == bpf_htons(ETH_P_IP))
        return XDP_PASS;
    return XDP_DROP;
}

// CORRECT: explicit bounds check
SEC("xdp")
int safe_prog(struct xdp_md *ctx) {
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;
    struct ethhdr *eth = data;

    // Verifier tracks this as proof eth is safe to access
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;

    if (eth->h_proto == bpf_htons(ETH_P_IP))
        return XDP_PASS;
    return XDP_DROP;
}
```

## Conclusion

XDP represents a fundamental shift in how Linux handles high-speed networking. By moving packet processing to the earliest possible point in the data path — inside the NIC driver before socket buffer allocation — XDP achieves packet drop and forwarding rates that were previously only possible with kernel-bypass frameworks like DPDK, while remaining fully integrated with the Linux networking stack.

For production deployments, XDP delivers the most value in three scenarios: DDoS mitigation (drop malicious traffic before it consumes any resources), high-performance load balancing (redirect packets without full kernel processing), and Kubernetes service acceleration (replacing iptables NAT with eBPF-based forwarding in Cilium).

The combination of XDP for fast-path processing and AF_XDP sockets for user-space packet processing makes it possible to build network applications that achieve line-rate performance on commodity hardware without specialized NICs or kernel modifications.
