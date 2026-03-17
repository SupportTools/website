---
title: "Linux eBPF Networking: XDP Programs for High-Performance Packet Processing"
date: 2028-12-18T00:00:00-05:00
draft: false
tags: ["eBPF", "XDP", "Linux Networking", "Performance", "Packet Processing", "Kernel"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise deep-dive into Linux XDP (eXpress Data Path) programming with eBPF for high-performance packet processing, covering XDP program development, load balancing, DDoS mitigation, connection tracking, and production deployment patterns."
more_link: "yes"
url: "/linux-ebpf-xdp-high-performance-packet-processing-guide/"
---

Traditional Linux network packet processing traverses the full network stack: NIC driver, softirq, TCP/IP stack, socket buffer, user space syscall. At 100Gbps line rate, this path cannot process packets fast enough without expensive DPDK-class hardware or large CPU allocations. XDP (eXpress Data Path) intercepts packets at the NIC driver level using eBPF programs, enabling line-rate processing on commodity hardware with minimal CPU overhead.

This guide covers XDP program development with eBPF: the XDP execution model, writing XDP programs in C and loading them with libbpf, implementing a high-performance packet filter, Layer 4 load balancer, and connection tracker, deploying XDP programs in containerized environments with Cilium, and measuring performance against kernel stack alternatives.

<!--more-->

## XDP Architecture and Execution Model

XDP programs execute in a hook inserted by the NIC driver before any kernel network stack processing. The execution context is:

1. **Hardware mode (XDP_MODE_HW)**: Program runs on the NIC hardware itself (SmartNIC/FPGA). Lowest latency, limited instruction set.
2. **Driver mode (XDP_MODE_NATIVE)**: Program runs in the NIC driver's NAPI poll context, before `skb` allocation. Highest performance for software execution; requires driver support.
3. **Generic mode (XDP_MODE_SKB)**: Program runs after `skb` allocation in the generic XDP path. Lower performance but works with any NIC driver.

### Supported NIC Drivers (Native Mode)

Native mode XDP requires driver-level support:

| Driver | NIC Family |
|--------|-----------|
| mlx5 | Mellanox/NVIDIA ConnectX-5+ |
| i40e | Intel XL710, X710 |
| ice | Intel E810 |
| bnxt_en | Broadcom BCM578xx |
| virtio_net | QEMU/KVM virtio |
| veth | Linux virtual ethernet |
| ixgbe | Intel 82599 (10GbE) |

```bash
# Check if your NIC driver supports native XDP
ethtool -i eth0 | grep driver
# driver: mlx5_core

# Verify XDP support
ip link show dev eth0 | grep xdp
# (no output if not loaded, shows xdp if a program is attached)
```

### XDP Return Codes

An XDP program returns one of five actions:

| Action | Value | Effect |
|--------|-------|--------|
| `XDP_DROP` | 1 | Drop the packet silently |
| `XDP_PASS` | 2 | Pass to normal kernel network stack |
| `XDP_TX` | 3 | Retransmit the packet on the same interface |
| `XDP_REDIRECT` | 4 | Redirect to another interface or CPU |
| `XDP_ABORTED` | 0 | Drop with trace_xdp_exception event (debugging) |

## Development Environment Setup

```bash
# Install required development packages (Ubuntu 24.04)
apt-get install -y \
  clang \
  llvm \
  libbpf-dev \
  linux-headers-$(uname -r) \
  libbpf-tools \
  bpftool \
  iproute2 \
  tcpdump

# Verify bpf filesystem is mounted
mount | grep bpf
# bpf on /sys/fs/bpf type bpf (rw,nosuid,nodev,noexec,relatime,mode=700)

# Verify BTF (BPF Type Format) is available — required for CO-RE
ls /sys/kernel/btf/vmlinux
```

## XDP Program: High-Performance Packet Filter

### The eBPF C Program

```c
/* xdp_filter.c — Drop packets from blocked IP addresses using an eBPF hash map */
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

/* Map: blocked source IPv4 addresses -> drop reason */
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);  /* Longest-prefix match for CIDR blocking */
    __type(key, struct bpf_lpm_trie_key); /* Prefix + data */
    __type(value, __u64);                 /* Drop count */
    __uint(max_entries, 65536);
    __uint(map_flags, BPF_F_NO_PREALLOC);
} blocked_cidrs SEC(".maps");

/* Map: per-IP rate limiting using token bucket */
struct rate_limit_value {
    __u64 tokens;
    __u64 last_update_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __type(key, __u32);                    /* Source IP */
    __type(value, struct rate_limit_value);
    __uint(max_entries, 1000000);          /* 1M concurrent tracked IPs */
} rate_limits SEC(".maps");

/* Statistics map */
struct xdp_stats {
    __u64 passed;
    __u64 dropped_blocklist;
    __u64 dropped_ratelimit;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __type(key, __u32);
    __type(value, struct xdp_stats);
    __uint(max_entries, 1);
} stats SEC(".maps");

/* Token bucket rate limiter: 10000 packets/second, burst of 1000 */
#define RATE_LIMIT_PPS       10000ULL
#define BURST_TOKENS         1000ULL
#define NANOSECONDS_PER_SEC  1000000000ULL

static __always_inline int is_rate_limited(__u32 src_ip) {
    struct rate_limit_value *rl;
    struct rate_limit_value new_rl;
    __u64 now_ns = bpf_ktime_get_ns();

    rl = bpf_map_lookup_elem(&rate_limits, &src_ip);
    if (!rl) {
        /* First packet from this IP */
        new_rl.tokens = BURST_TOKENS - 1;
        new_rl.last_update_ns = now_ns;
        bpf_map_update_elem(&rate_limits, &src_ip, &new_rl, BPF_ANY);
        return 0;
    }

    /* Refill tokens based on time elapsed */
    __u64 elapsed_ns = now_ns - rl->last_update_ns;
    __u64 new_tokens = (elapsed_ns * RATE_LIMIT_PPS) / NANOSECONDS_PER_SEC;
    __u64 tokens = rl->tokens + new_tokens;
    if (tokens > BURST_TOKENS)
        tokens = BURST_TOKENS;

    if (tokens == 0)
        return 1; /* Rate limited */

    /* Consume one token */
    rl->tokens = tokens - 1;
    rl->last_update_ns = now_ns;
    return 0;
}

SEC("xdp")
int xdp_filter_main(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    __u32 key = 0;
    struct xdp_stats *xstats;

    xstats = bpf_map_lookup_elem(&stats, &key);
    if (!xstats)
        return XDP_PASS;

    /* Parse Ethernet header */
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    /* Only process IPv4 for this example */
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    /* Parse IPv4 header */
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;

    /* Check blocklist (LPM TRIE supports CIDR prefix matching) */
    struct {
        __u32 prefixlen;
        __u32 data;
    } lpm_key;
    lpm_key.prefixlen = 32;
    lpm_key.data = src_ip;

    __u64 *block_count = bpf_map_lookup_elem(&blocked_cidrs, &lpm_key);
    if (block_count) {
        __sync_fetch_and_add(block_count, 1);
        __sync_fetch_and_add(&xstats->dropped_blocklist, 1);
        return XDP_DROP;
    }

    /* Rate limiting check */
    if (is_rate_limited(src_ip)) {
        __sync_fetch_and_add(&xstats->dropped_ratelimit, 1);
        return XDP_DROP;
    }

    __sync_fetch_and_add(&xstats->passed, 1);
    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

### Building the XDP Program

```makefile
# Makefile for XDP program compilation

CLANG ?= clang
LLC ?= llc
BPFTOOL ?= bpftool
LIBBPF_DIR ?= /usr/lib/x86_64-linux-gnu

CFLAGS := \
  -O2 \
  -g \
  -Wall \
  -target bpf \
  -D__TARGET_ARCH_x86 \
  -I/usr/include/x86_64-linux-gnu \
  -I/usr/include

.PHONY: all clean

all: xdp_filter.o xdp_filter.skel.h

# Compile C to BPF bytecode
xdp_filter.o: xdp_filter.c
	$(CLANG) $(CFLAGS) -c $< -o $@
	@echo "Verifying BPF program..."
	$(BPFTOOL) prog load $@ /sys/fs/bpf/xdp_filter_verify 2>&1 || true
	@rm -f /sys/fs/bpf/xdp_filter_verify

# Generate skeleton for use with libbpf in userspace loader
xdp_filter.skel.h: xdp_filter.o
	$(BPFTOOL) gen skeleton $< > $@

clean:
	rm -f *.o *.skel.h
```

### Userspace Loader with libbpf

```c
/* xdp_loader.c — Load and manage the XDP program */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <bpf/bpf.h>
#include <bpf/libbpf.h>

#include "xdp_filter.skel.h"

static volatile int running = 1;

static void sig_handler(int sig) {
    running = 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <interface>\n", argv[0]);
        return 1;
    }

    const char *ifname = argv[1];
    int ifindex = if_nametoindex(ifname);
    if (!ifindex) {
        perror("if_nametoindex");
        return 1;
    }

    /* Load and verify BPF program */
    struct xdp_filter_bpf *skel = xdp_filter_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open and load BPF skeleton\n");
        return 1;
    }

    /* Attach XDP program to the network interface */
    struct bpf_link *link = bpf_program__attach_xdp(skel->progs.xdp_filter_main, ifindex);
    if (!link) {
        fprintf(stderr, "Failed to attach XDP program to %s: %s\n",
                ifname, strerror(errno));
        xdp_filter_bpf__destroy(skel);
        return 1;
    }

    printf("XDP filter attached to %s (ifindex %d)\n", ifname, ifindex);
    printf("Press Ctrl+C to detach...\n");

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    /* Example: Block the 192.168.100.0/24 subnet */
    struct {
        __u32 prefixlen;
        __u32 data;
    } block_key;

    block_key.prefixlen = 24;
    inet_pton(AF_INET, "192.168.100.0", &block_key.data);
    __u64 initial_count = 0;
    bpf_map__update_elem(skel->maps.blocked_cidrs,
                         &block_key, sizeof(block_key),
                         &initial_count, sizeof(initial_count),
                         BPF_ANY);

    /* Monitor statistics */
    while (running) {
        __u32 key = 0;
        struct {
            __u64 passed;
            __u64 dropped_blocklist;
            __u64 dropped_ratelimit;
        } total_stats = {};

        /* Sum per-CPU stats */
        int ncpus = libbpf_num_possible_cpus();
        struct xdp_stats *per_cpu_stats = calloc(ncpus, sizeof(*per_cpu_stats));
        if (per_cpu_stats) {
            bpf_map__lookup_elem(skel->maps.stats,
                                 &key, sizeof(key),
                                 per_cpu_stats, sizeof(*per_cpu_stats) * ncpus,
                                 0);
            for (int i = 0; i < ncpus; i++) {
                total_stats.passed += per_cpu_stats[i].passed;
                total_stats.dropped_blocklist += per_cpu_stats[i].dropped_blocklist;
                total_stats.dropped_ratelimit += per_cpu_stats[i].dropped_ratelimit;
            }
            free(per_cpu_stats);
        }

        printf("\r[stats] passed: %llu, blocked: %llu, rate-limited: %llu  ",
               total_stats.passed,
               total_stats.dropped_blocklist,
               total_stats.dropped_ratelimit);
        fflush(stdout);
        sleep(1);
    }

    printf("\nDetaching XDP program...\n");
    bpf_link__destroy(link);
    xdp_filter_bpf__destroy(skel);
    printf("Done.\n");
    return 0;
}
```

## XDP Load Balancer with Consistent Hashing

XDP can implement a stateless Layer 4 load balancer that distributes connections across backend servers using consistent hashing on the 5-tuple:

```c
/* xdp_lb.c — Consistent hash L4 load balancer */
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define MAX_BACKENDS 64
#define BACKEND_MAP_SIZE 65536  /* Power of 2 for efficient modulo */

struct backend {
    __u32 ip;
    __u16 port;
    __u8  active;
    __u8  pad;
};

/* Array of backend servers */
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __type(key, __u32);
    __type(value, struct backend);
    __uint(max_entries, MAX_BACKENDS);
} backends SEC(".maps");

/* Hash ring: maps hash values to backend indices */
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __type(key, __u32);
    __type(value, __u32);
    __uint(max_entries, BACKEND_MAP_SIZE);
} hash_ring SEC(".maps");

static __always_inline __u32 hash_5tuple(__u32 src_ip, __u32 dst_ip,
                                          __u16 src_port, __u16 dst_port,
                                          __u8 proto) {
    /* FNV-1a hash for 5-tuple consistent hashing */
    __u32 h = 2166136261u;
    h ^= src_ip;  h *= 16777619u;
    h ^= dst_ip;  h *= 16777619u;
    h ^= (__u32)src_port << 16 | dst_port;  h *= 16777619u;
    h ^= proto;   h *= 16777619u;
    return h;
}

SEC("xdp")
int xdp_lb_main(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    if (ip->protocol != IPPROTO_TCP)
        return XDP_PASS;

    struct tcphdr *tcp = (void *)((__u8 *)ip + (ip->ihl << 2));
    if ((void *)(tcp + 1) > data_end)
        return XDP_PASS;

    /* Hash the 5-tuple to select a backend */
    __u32 h = hash_5tuple(ip->saddr, ip->daddr,
                           tcp->source, tcp->dest,
                           ip->protocol);

    __u32 ring_idx = h & (BACKEND_MAP_SIZE - 1);
    __u32 *backend_idx = bpf_map_lookup_elem(&hash_ring, &ring_idx);
    if (!backend_idx)
        return XDP_PASS;

    struct backend *be = bpf_map_lookup_elem(&backends, backend_idx);
    if (!be || !be->active)
        return XDP_PASS;

    /* Rewrite destination IP and port (DNAT) */
    __be32 old_daddr = ip->daddr;
    __be16 old_dport = tcp->dest;

    ip->daddr = be->ip;
    tcp->dest = be->port;

    /* Recalculate IP header checksum */
    /* In production, use bpf_l3_csum_replace() for incremental update */
    __u32 csum = 0;
    __u16 *ip16 = (__u16 *)ip;
    ip->check = 0;
    for (int i = 0; i < (ip->ihl << 1); i++) {
        if ((void *)(ip16 + i + 1) > data_end)
            break;
        csum += ip16[i];
    }
    while (csum >> 16)
        csum = (csum & 0xffff) + (csum >> 16);
    ip->check = ~csum;

    /* Use bpf_l4_csum_replace for TCP checksum update */
    bpf_l4_csum_replace(ctx,
        sizeof(struct ethhdr) + (ip->ihl << 2) + offsetof(struct tcphdr, check),
        old_daddr, be->ip, BPF_F_PSEUDO_HDR | sizeof(__u32));
    bpf_l4_csum_replace(ctx,
        sizeof(struct ethhdr) + (ip->ihl << 2) + offsetof(struct tcphdr, check),
        old_dport, be->port, sizeof(__u16));

    return XDP_TX; /* Transmit the modified packet back out the interface */
}

char LICENSE[] SEC("license") = "GPL";
```

## XDP Redirect: Forwarding Between Interfaces

XDP redirect sends packets to another network device or CPU queue without kernel stack overhead:

```c
/* Redirect to a map of output interfaces */
struct {
    __uint(type, BPF_MAP_TYPE_DEVMAP);
    __type(key, __u32);    /* Input interface ifindex */
    __type(value, __u32);  /* Output interface ifindex */
    __uint(max_entries, 256);
} tx_port SEC(".maps");

SEC("xdp")
int xdp_redirect_main(struct xdp_md *ctx) {
    /* ... packet parsing ... */

    /* Redirect packet to the mapped output interface */
    return bpf_redirect_map(&tx_port, ctx->ingress_ifindex, XDP_DROP);
}
```

## Deployment with iproute2

```bash
# Load XDP program in driver mode (requires driver support)
ip link set dev eth0 xdpdrv obj xdp_filter.o sec xdp verbose

# Load in generic mode (works with any driver, lower performance)
ip link set dev eth0 xdpgeneric obj xdp_filter.o sec xdp verbose

# Verify program attachment
ip link show dev eth0
# Returns: ... xdpdrv/id:42 ...

# View loaded BPF programs
bpftool prog list

# View BPF maps
bpftool map list

# Detach XDP program
ip link set dev eth0 xdp off

# Inspect program internals
bpftool prog dump xlated id 42
bpftool prog dump jited id 42
```

### Managing Maps at Runtime

```bash
# Add an IP to the blocklist map
bpftool map update id <MAP_ID> \
  key hex c0 a8 64 00 20 00 00 00 \
  value hex 00 00 00 00 00 00 00 00

# Read blocklist entries
bpftool map dump id <MAP_ID>

# Pin a map to the BPF filesystem for persistence across program reloads
bpftool map pin id <MAP_ID> /sys/fs/bpf/blocked_cidrs

# Load a new program version that reuses the pinned map
# (passes the pinned map path via --reuse-maps)
```

## XDP in Kubernetes with Cilium

Cilium implements its network policy enforcement, load balancing, and observability using eBPF/XDP:

```yaml
# Install Cilium with XDP acceleration enabled
helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set loadBalancer.acceleration=native \
  --set loadBalancer.mode=dsr \
  --set kubeProxyReplacement=true \
  --set bpf.masquerade=true \
  --set bpf.hostRouting=true \
  --set devices="{eth0,eth1}"
```

```yaml
# CiliumNetworkPolicy that uses eBPF for enforcement (not iptables)
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: payments-api-policy
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payments-api
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: api-gateway
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
  egress:
  - toEndpoints:
    - matchLabels:
        app: postgres
    toPorts:
    - ports:
      - port: "5432"
        protocol: TCP
```

## Performance Benchmarking

```bash
# Generate test traffic with pktgen (kernel packet generator)
# First, load the pktgen kernel module
modprobe pktgen

# Configure pktgen to send UDP packets at line rate
echo "add_device eth0@0" > /proc/net/pktgen/kpktgend_0

# Configure the pktgen thread
cat > /proc/net/pktgen/eth0@0 << 'EOF'
pkt_size 64
count 10000000
delay 0
dst_mac 00:11:22:33:44:55
dst 203.0.113.1
dport 80
src_min 198.51.100.0
src_max 198.51.100.255
EOF

echo "start" > /proc/net/pktgen/pgctrl

# Measure XDP drop rate
bpftool map dump id <STATS_MAP_ID>
# Compare drops/second between runs with and without XDP

# Using mlx5 hardware counters for accurate measurement
ethtool -S eth0 | grep -E "rx_xdp_drop|rx_packets"
```

### Benchmark Results: XDP vs iptables vs netfilter

Representative performance data on a 25GbE NIC (Mellanox ConnectX-5):

| Method | Packet Drop Rate (Mpps) | CPU Usage (%) |
|--------|------------------------|---------------|
| iptables DROP | 3.5 Mpps | 95% (single core) |
| nftables DROP | 4.2 Mpps | 90% |
| XDP (generic mode) | 8.5 Mpps | 60% |
| XDP (driver mode) | 24.0 Mpps | 35% |
| XDP (hardware mode) | 125 Mpps | ~0% (on NIC) |

## Debugging XDP Programs

```bash
# View XDP program verifier output (errors during load)
bpftool prog load xdp_filter.o /sys/fs/bpf/xdp_filter 2>&1

# Trace XDP program execution with bpf_trace_printk
# (development only — significant overhead)
cat /sys/kernel/debug/tracing/trace_pipe

# Use bpftrace to trace XDP events
bpftrace -e 'tracepoint:net:xdp_exception { printf("XDP exception on %s: action=%d\n", str(args->name), args->act); }'

# Check for XDP errors in kernel ring buffer
dmesg | grep xdp

# View BPF program verification statistics
bpftool prog show id 42 --pretty
```

## Production Considerations

### Memory Requirements

XDP maps pre-allocate memory. Plan for:

```
LRU_HASH map (1M entries × 16 bytes/entry) = 16MB per CPU
PERCPU_ARRAY map (1 entry × 32 bytes × 128 CPUs) = 4KB
LPM_TRIE map (65536 entries × 40 bytes) = 2.5MB
```

### Kernel Version Requirements

| Feature | Minimum Kernel Version |
|---------|----------------------|
| XDP basic | 4.8 |
| XDP redirect | 4.14 |
| XDP hardware offload | 4.15 |
| BPF CO-RE (portable) | 5.2 |
| BTF-enabled maps | 4.18 |
| BPF ring buffer | 5.8 |

For production deployments, kernel 5.15+ (LTS) is recommended for full feature availability.

## Conclusion

XDP with eBPF enables line-rate packet processing on commodity hardware, making previously cost-prohibitive network functions feasible: DDoS mitigation at 24+ Mpps, L4 load balancing with microsecond latency, and fine-grained traffic filtering without iptables overhead.

The key production practices:

1. **Use driver mode** (`xdpdrv`) for maximum performance; fall back to generic mode for development and testing
2. **Use CO-RE (Compile Once, Run Everywhere)** with BTF to produce portable eBPF programs that work across kernel versions
3. **Monitor per-CPU statistics** using `BPF_MAP_TYPE_PERCPU_ARRAY` to avoid atomic contention on the data path
4. **Test with the BPF verifier's strict mode** — programs that pass verification will not crash the kernel
5. **Use libbpf skeletons** for type-safe userspace interaction with BPF programs and maps
6. **Benchmark before replacing iptables**: XDP wins at high packet rates but adds operational complexity that must be justified by actual traffic volumes
