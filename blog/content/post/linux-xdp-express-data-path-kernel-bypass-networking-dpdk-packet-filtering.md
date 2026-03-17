---
title: "Linux XDP (eXpress Data Path): Kernel Bypass Networking, DPDK Alternatives, and Packet Filtering at Line Rate"
date: 2031-10-24T00:00:00-05:00
draft: false
tags: ["Linux", "XDP", "eBPF", "Networking", "Performance", "Kernel Bypass", "DPDK"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-deep-dive into Linux XDP covering driver-mode operation, AF_XDP for userspace packet processing, comparison with DPDK, load balancer implementation, DDoS mitigation at line rate, and benchmark methodology."
more_link: "yes"
url: "/linux-xdp-express-data-path-kernel-bypass-networking-dpdk-packet-filtering/"
---

XDP (eXpress Data Path) is a Linux kernel framework that allows eBPF programs to process network packets before the kernel networking stack allocates socket buffers. Combined with AF_XDP sockets for userspace delivery, XDP achieves near-DPDK throughput while preserving full kernel networking for non-XDP traffic. This guide covers the programming model, driver modes, AF_XDP zero-copy, a complete load balancer implementation, and DDoS mitigation patterns.

<!--more-->

# Linux XDP: Express Data Path for Line-Rate Packet Processing

## Section 1: XDP Architecture and Modes

### Where XDP Fits in the Network Stack

```
NIC Hardware
    │
    ▼
XDP Driver Hook (earliest possible point — before sk_buff allocation)
    │
    ├── XDP_DROP      → discard packet immediately (zero CPU overhead)
    ├── XDP_PASS      → continue to normal kernel stack
    ├── XDP_TX        → retransmit on same interface
    ├── XDP_REDIRECT  → redirect to another interface or AF_XDP socket
    └── XDP_ABORTED   → drop and increment error counter
    │
    ▼
TC (Traffic Control)
    │
    ▼
Netfilter / iptables
    │
    ▼
Socket Buffer (sk_buff) allocation
    │
    ▼
Transport Layer (TCP/UDP)
    │
    ▼
Application
```

### XDP Hook Modes

| Mode | Description | Performance | Requirement |
|------|-------------|-------------|-------------|
| Native (driver) | Runs in NIC driver before DMA | Highest — avoids sk_buff | Driver support required |
| Generic (SKB) | Runs after sk_buff allocation | ~30-40% overhead vs native | Any NIC, for testing |
| Offload | Runs on NIC SmartNIC | Ultimate — CPU-free processing | SmartNIC with XDP offload |

```bash
# Check if a driver supports native XDP
ethtool -i eth0 | grep driver
# Then check driver XDP support:
# mlx5: yes (ConnectX-5+)
# i40e: yes (Intel X710/XXV710)
# ixgbe: yes (Intel X520/X540)
# virtio_net: yes (for VMs)
# veth: yes (useful for testing)

# Load XDP program in native mode
ip link set dev eth0 xdpdrv obj xdp_prog.bpf.o sec xdp

# Load in generic mode (fallback)
ip link set dev eth0 xdpgeneric obj xdp_prog.bpf.o sec xdp

# Unload XDP program
ip link set dev eth0 xdp off

# Check XDP status
ip link show eth0 | grep xdp
```

## Section 2: Your First XDP Program

### Packet Counter and Filter

```c
// xdp_counter.bpf.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Per-CPU stats to avoid lock contention
struct xdp_stats {
    __u64 rx_packets;
    __u64 rx_bytes;
    __u64 dropped_packets;
    __u64 passed_packets;
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct xdp_stats);
} stats_map SEC(".maps");

// IP blocklist — IPv4 addresses to drop
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __uint(max_entries, 10000);
    __uint(map_flags, BPF_F_NO_PREALLOC);
    __type(key, struct {
        __u32 prefixlen;
        __u32 addr;
    });
    __type(value, __u64);  // Drop count
} blocklist_v4 SEC(".maps");

static __always_inline void update_stats(struct xdp_md *ctx, int action) {
    __u32 key = 0;
    struct xdp_stats *stats = bpf_map_lookup_elem(&stats_map, &key);
    if (!stats)
        return;

    __u64 pkt_len = ctx->data_end - ctx->data;
    stats->rx_packets++;
    stats->rx_bytes += pkt_len;

    if (action == XDP_DROP)
        stats->dropped_packets++;
    else
        stats->passed_packets++;
}

SEC("xdp")
int xdp_packet_filter(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // Only process IPv4
    if (eth->h_proto != bpf_htons(ETH_P_IP)) {
        update_stats(ctx, XDP_PASS);
        return XDP_PASS;
    }

    // Parse IP header
    struct iphdr *iph = (void *)(eth + 1);
    if ((void *)(iph + 1) > data_end)
        return XDP_DROP;

    // Check against blocklist
    struct {
        __u32 prefixlen;
        __u32 addr;
    } key = {
        .prefixlen = 32,
        .addr = iph->saddr,
    };

    __u64 *drop_count = bpf_map_lookup_elem(&blocklist_v4, &key);
    if (drop_count) {
        __sync_fetch_and_add(drop_count, 1);
        update_stats(ctx, XDP_DROP);
        return XDP_DROP;
    }

    update_stats(ctx, XDP_PASS);
    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

### Building and Loading

```bash
# Compile
clang -g -O2 -target bpf \
  -I/usr/include/bpf \
  -D__TARGET_ARCH_x86 \
  -c xdp_counter.bpf.c \
  -o xdp_counter.bpf.o

# Load onto interface
bpftool prog load xdp_counter.bpf.o /sys/fs/bpf/xdp_counter
ip link set dev eth0 xdpdrv pinned /sys/fs/bpf/xdp_counter

# Add an IP to the blocklist
bpftool map update pinned /sys/fs/bpf/blocklist_v4 \
  key hex 20 00 00 00 c0 a8 01 01 \
  value hex 00 00 00 00 00 00 00 00

# Read per-CPU stats
bpftool map dump pinned /sys/fs/bpf/stats_map
```

## Section 3: XDP Load Balancer (IPVS Alternative)

```c
// xdp_lb.bpf.c — Layer 4 load balancer using XDP_TX and REDIRECT
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define MAX_BACKENDS 64
#define LB_PORT 8080

struct backend {
    __u32 ip;
    __u8  mac[ETH_ALEN];
    __u32 port;     // Backend port (may differ from frontend)
};

// Backend pool
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, MAX_BACKENDS);
    __type(key, __u32);
    __type(value, struct backend);
} backends SEC(".maps");

// Number of active backends
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u32);
} backend_count SEC(".maps");

// Connection tracking for session affinity
struct conn_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8  proto;
} __attribute__((packed));

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1000000);  // 1M concurrent sessions
    __type(key, struct conn_key);
    __type(value, __u32);          // Backend index
} conn_table SEC(".maps");

// Frontend MAC for ARP (must match interface MAC)
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u8[ETH_ALEN]);
} frontend_mac SEC(".maps");

static __always_inline __u16 checksum_fold(__u32 csum) {
    csum = (csum >> 16) + (csum & 0xffff);
    csum += (csum >> 16);
    return ~csum;
}

static __always_inline __u32 csum_add(__u32 csum, __u32 addend) {
    csum += addend;
    return csum + (csum < addend);
}

static __always_inline void update_l4_checksum(
    struct iphdr *iph, void *l4hdr, __u32 old_ip, __u32 new_ip)
{
    // Update IP checksum
    __u32 ip_csum = ~iph->check;
    ip_csum = csum_add(ip_csum, ~old_ip);
    ip_csum = csum_add(ip_csum, new_ip);
    iph->check = checksum_fold(ip_csum);

    // Update TCP/UDP checksum (pseudo-header includes IPs)
    if (iph->protocol == IPPROTO_TCP) {
        struct tcphdr *tcph = l4hdr;
        __u32 l4_csum = ~tcph->check;
        l4_csum = csum_add(l4_csum, ~old_ip);
        l4_csum = csum_add(l4_csum, new_ip);
        tcph->check = checksum_fold(l4_csum);
    } else if (iph->protocol == IPPROTO_UDP) {
        struct udphdr *udph = l4hdr;
        if (udph->check) {
            __u32 l4_csum = ~udph->check;
            l4_csum = csum_add(l4_csum, ~old_ip);
            l4_csum = csum_add(l4_csum, new_ip);
            udph->check = checksum_fold(l4_csum);
        }
    }
}

SEC("xdp")
int xdp_lb(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_PASS;
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;

    struct iphdr *iph = (void *)(eth + 1);
    if ((void *)(iph + 1) > data_end) return XDP_PASS;

    // Only handle TCP and UDP
    if (iph->protocol != IPPROTO_TCP && iph->protocol != IPPROTO_UDP)
        return XDP_PASS;

    void *l4hdr = (void *)iph + (iph->ihl * 4);
    __u16 dst_port = 0;
    __u16 src_port = 0;

    if (iph->protocol == IPPROTO_TCP) {
        struct tcphdr *tcph = l4hdr;
        if ((void *)(tcph + 1) > data_end) return XDP_PASS;
        dst_port = tcph->dest;
        src_port = tcph->source;
    } else {
        struct udphdr *udph = l4hdr;
        if ((void *)(udph + 1) > data_end) return XDP_PASS;
        dst_port = udph->dest;
        src_port = udph->source;
    }

    // Only load balance traffic to our frontend port
    if (dst_port != bpf_htons(LB_PORT))
        return XDP_PASS;

    // Look up or create session affinity entry
    struct conn_key ckey = {
        .src_ip   = iph->saddr,
        .dst_ip   = iph->daddr,
        .src_port = src_port,
        .dst_port = dst_port,
        .proto    = iph->protocol,
    };

    __u32 *backend_idx = bpf_map_lookup_elem(&conn_table, &ckey);
    __u32 idx;

    if (backend_idx) {
        idx = *backend_idx;
    } else {
        // Consistent hash to select backend
        __u32 count_key = 0;
        __u32 *count = bpf_map_lookup_elem(&backend_count, &count_key);
        if (!count || *count == 0) return XDP_PASS;

        // Simple hash — production uses maglev or jump consistent hash
        __u32 hash = iph->saddr ^ (iph->saddr >> 16) ^ bpf_htons(src_port);
        idx = hash % *count;

        bpf_map_update_elem(&conn_table, &ckey, &idx, BPF_NOEXIST);
    }

    struct backend *be = bpf_map_lookup_elem(&backends, &idx);
    if (!be) return XDP_PASS;

    // Rewrite destination IP and MAC
    __u32 old_daddr = iph->daddr;
    iph->daddr = be->ip;
    __builtin_memcpy(eth->h_dest, be->mac, ETH_ALEN);

    // Update checksums
    update_l4_checksum(iph, l4hdr, old_daddr, be->ip);

    // Send packet back on the same interface (to gateway/router)
    return XDP_TX;
}

char LICENSE[] SEC("license") = "GPL";
```

## Section 4: DDoS Mitigation

```c
// xdp_ddos.bpf.c — SYN flood and amplification attack mitigation
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define RATE_LIMIT_PPS 10000   // Packets per second per source IP
#define RATE_WINDOW_NS 1000000000ULL  // 1 second in nanoseconds

struct rate_entry {
    __u64 last_reset_ns;
    __u64 pkt_count;
};

// Per-source rate limiter
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1000000);
    __type(key, __u32);           // Source IP
    __type(value, struct rate_entry);
} rate_limiter SEC(".maps");

// Permanent blocklist (controlled from userspace)
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 100000);
    __type(key, __u32);
    __type(value, __u8);
} blocklist SEC(".maps");

// Per-CPU drop counter
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} drop_count SEC(".maps");

static __always_inline bool is_rate_limited(__u32 src_ip) {
    __u64 now = bpf_ktime_get_ns();

    struct rate_entry *entry = bpf_map_lookup_elem(&rate_limiter, &src_ip);
    if (!entry) {
        struct rate_entry new_entry = {
            .last_reset_ns = now,
            .pkt_count = 1,
        };
        bpf_map_update_elem(&rate_limiter, &src_ip, &new_entry, BPF_NOEXIST);
        return false;
    }

    // Reset window
    if (now - entry->last_reset_ns > RATE_WINDOW_NS) {
        entry->last_reset_ns = now;
        entry->pkt_count = 1;
        return false;
    }

    // Increment and check
    entry->pkt_count++;
    return entry->pkt_count > RATE_LIMIT_PPS;
}

SEC("xdp")
int xdp_ddos_protection(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_DROP;
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;

    struct iphdr *iph = (void *)(eth + 1);
    if ((void *)(iph + 1) > data_end) return XDP_DROP;

    __u32 src_ip = iph->saddr;

    // Check permanent blocklist first (fastest path)
    __u8 *blocked = bpf_map_lookup_elem(&blocklist, &src_ip);
    if (blocked) {
        __u32 key = 0;
        __u64 *cnt = bpf_map_lookup_elem(&drop_count, &key);
        if (cnt) __sync_fetch_and_add(cnt, 1);
        return XDP_DROP;
    }

    // TCP SYN flood detection
    if (iph->protocol == IPPROTO_TCP) {
        struct tcphdr *tcph = (void *)iph + (iph->ihl * 4);
        if ((void *)(tcph + 1) > data_end) return XDP_DROP;

        // Drop TCP SYN packets from rate-limited sources
        if (tcph->syn && !tcph->ack) {
            if (is_rate_limited(src_ip)) {
                __u32 key = 0;
                __u64 *cnt = bpf_map_lookup_elem(&drop_count, &key);
                if (cnt) __sync_fetch_and_add(cnt, 1);
                return XDP_DROP;
            }
        }
    }

    // UDP amplification: block DNS responses > 512 bytes (possible amplification)
    if (iph->protocol == IPPROTO_UDP) {
        struct udphdr *udph = (void *)iph + (iph->ihl * 4);
        if ((void *)(udph + 1) > data_end) return XDP_DROP;

        __u16 pkt_len = bpf_ntohs(iph->tot_len);

        // DNS (53) response flood
        if (udph->source == bpf_htons(53) && pkt_len > 512) {
            if (is_rate_limited(src_ip)) {
                return XDP_DROP;
            }
        }

        // NTP amplification: source port 123, response > 100 bytes
        if (udph->source == bpf_htons(123) && pkt_len > 100) {
            return XDP_DROP;
        }
    }

    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

## Section 5: AF_XDP for Userspace Packet Processing

AF_XDP sockets allow XDP programs to redirect packets to userspace at near line-rate using zero-copy shared memory rings.

```c
// xdp_redirect_to_user.bpf.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>

// XSK (AF_XDP socket) map
struct {
    __uint(type, BPF_MAP_TYPE_XSKMAP);
    __uint(max_entries, 64);  // One entry per queue
    __type(key, __u32);
    __type(value, __u32);
} xsk_map SEC(".maps");

SEC("xdp")
int xdp_redirect_to_xsk(struct xdp_md *ctx) {
    // Redirect to AF_XDP socket on the same queue
    __u32 queue_id = ctx->rx_queue_index;
    return bpf_redirect_map(&xsk_map, queue_id, XDP_PASS);
    // XDP_PASS as fallback means: if no socket on this queue, pass to kernel
}

char LICENSE[] SEC("license") = "GPL";
```

```c
// af_xdp_userspace.c — userspace AF_XDP packet processor
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/mman.h>
#include <linux/if_xdp.h>
#include <bpf/xsk.h>
#include <bpf/libbpf.h>

#define NUM_FRAMES       4096
#define FRAME_SIZE       XSK_UMEM__DEFAULT_FRAME_SIZE
#define BATCH_SIZE       64
#define INVALID_UMEM_FRAME UINT64_MAX

struct xsk_socket_info {
    struct xsk_ring_cons rx;
    struct xsk_ring_prod tx;
    struct xsk_umem     *umem;
    struct xsk_socket   *xsk;

    uint64_t umem_frame_addr[NUM_FRAMES];
    uint32_t umem_frame_free;

    uint32_t outstanding_tx;
};

static uint64_t xsk_alloc_umem_frame(struct xsk_socket_info *xsk) {
    uint64_t frame;
    if (xsk->umem_frame_free == 0)
        return INVALID_UMEM_FRAME;
    frame = xsk->umem_frame_addr[--xsk->umem_frame_free];
    xsk->umem_frame_addr[xsk->umem_frame_free] = INVALID_UMEM_FRAME;
    return frame;
}

static struct xsk_socket_info *create_xsk_socket(
    void *umem_area, uint32_t ifindex, uint32_t queue_id)
{
    struct xsk_socket_info *xsk_info = calloc(1, sizeof(*xsk_info));
    struct xsk_umem_config umem_cfg = {
        .fill_size  = XSK_RING_PROD__DEFAULT_NUM_DESCS * 2,
        .comp_size  = XSK_RING_CONS__DEFAULT_NUM_DESCS,
        .frame_size = FRAME_SIZE,
        .frame_headroom = 0,
    };
    struct xsk_socket_config xsk_cfg = {
        .rx_size = XSK_RING_CONS__DEFAULT_NUM_DESCS,
        .tx_size = XSK_RING_PROD__DEFAULT_NUM_DESCS,
        .bind_flags = XDP_USE_NEED_WAKEUP,
    };

    // Initialize UMEM
    int ret = xsk_umem__create(&xsk_info->umem, umem_area,
                               NUM_FRAMES * FRAME_SIZE,
                               NULL, NULL, &umem_cfg);
    if (ret) {
        fprintf(stderr, "xsk_umem__create: %s\n", strerror(-ret));
        free(xsk_info);
        return NULL;
    }

    // Initialize frame pool
    for (int i = 0; i < NUM_FRAMES; i++)
        xsk_info->umem_frame_addr[i] = i * FRAME_SIZE;
    xsk_info->umem_frame_free = NUM_FRAMES;

    // Create socket
    ret = xsk_socket__create(&xsk_info->xsk, "eth0", queue_id,
                             xsk_info->umem,
                             &xsk_info->rx, &xsk_info->tx,
                             &xsk_cfg);
    if (ret) {
        fprintf(stderr, "xsk_socket__create: %s\n", strerror(-ret));
        xsk_umem__delete(xsk_info->umem);
        free(xsk_info);
        return NULL;
    }

    return xsk_info;
}

static void process_packets(struct xsk_socket_info *xsk) {
    unsigned int idx_rx = 0;
    unsigned int rcvd = xsk_ring_cons__peek(&xsk->rx, BATCH_SIZE, &idx_rx);
    if (!rcvd)
        return;

    for (unsigned int i = 0; i < rcvd; i++) {
        const struct xdp_desc *desc = xsk_ring_cons__rx_desc(&xsk->rx, idx_rx + i);
        uint64_t addr = desc->addr;
        uint32_t len  = desc->len;

        uint8_t *pkt = xsk_umem__get_data(xsk_info->umem, addr);

        // Process packet (e.g., parse Ethernet/IP/TCP headers)
        // This runs at ZERO-COPY — pkt points directly into UMEM
        printf("Received packet: addr=%llu len=%u\n", addr, len);

        // Return frame to fill ring for reuse
        xsk_alloc_umem_frame(xsk);  // In production, properly manage frame lifecycle
    }

    xsk_ring_cons__release(&xsk->rx, rcvd);
}
```

## Section 6: Performance Benchmarks

### Benchmark Methodology

```bash
#!/usr/bin/env bash
# benchmark-xdp.sh — measure XDP drop performance

NIC="eth0"
PKTGEN_SCRIPT="/usr/src/linux/samples/pktgen/pktgen_sample03_burst_single_flow.sh"

# Load the XDP drop program (XDP_DROP on all packets)
cat > /tmp/xdp_drop.bpf.c <<'EOF'
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

SEC("xdp")
int xdp_drop_all(struct xdp_md *ctx) { return XDP_DROP; }
char LICENSE[] SEC("license") = "GPL";
EOF

clang -O2 -target bpf -c /tmp/xdp_drop.bpf.c -o /tmp/xdp_drop.bpf.o
ip link set dev $NIC xdpdrv obj /tmp/xdp_drop.bpf.o sec xdp

echo "Running pktgen for 10 seconds..."
# Using Linux pktgen kernel module
modprobe pktgen

cat << EOF > /proc/net/pktgen/pgctrl
stop
EOF

cat << EOF > /proc/net/pktgen/kpktgend_0
rem_device_all
add_device $NIC
EOF

cat << EOF > /proc/net/pktgen/$NIC
count 0
delay 0
pkt_size 64
dst_mac 52:54:00:12:34:56
dst 10.0.0.1
src 10.0.0.2
EOF

# Capture stats before
BEFORE=$(cat /sys/class/net/$NIC/statistics/rx_dropped)

echo start > /proc/net/pktgen/pgctrl
sleep 10
echo stop > /proc/net/pktgen/pgctrl

# Capture stats after
AFTER=$(cat /sys/class/net/$NIC/statistics/rx_dropped)
PPS=$(( ($AFTER - $BEFORE) / 10 ))
echo "XDP DROP rate: $PPS packets/second"
echo "That's approximately $(( $PPS / 1000000 )) Mpps"

# Unload XDP
ip link set dev $NIC xdp off
```

### Typical Performance Numbers (Intel X710 25GbE, AMD EPYC)

```
# Native XDP Drop (no processing):     ~30 Mpps @ 64-byte packets
# XDP with hash map lookup:             ~15 Mpps @ 64-byte packets
# XDP with LRU hash conn tracking:      ~10 Mpps @ 64-byte packets
# Generic XDP (fallback):                ~2 Mpps @ 64-byte packets
# iptables DROP (comparison):            ~1 Mpps @ 64-byte packets
# DPDK (comparison, zero-copy):        ~80 Mpps @ 64-byte packets (specialized)
```

## Section 7: XDP vs DPDK Decision Framework

| Criterion | XDP | DPDK |
|-----------|-----|------|
| Kernel integration | Full — coexists with kernel networking | Bypasses kernel entirely |
| CPU dedication | No — uses normal scheduler | Yes — busy-poll cores |
| Throughput (64B) | 10-30 Mpps | 60-80 Mpps |
| Programming model | eBPF + C (restricted) | C, C++, Rust (full language) |
| Driver support | Broad (most modern drivers) | Specific DPDK PMDs |
| Operational complexity | Low — ip link commands | High — VFIO, hugepages, core isolation |
| Use case | DDoS mitigation, LB, filtering | High-frequency trading, telecom NFV |

**Choose XDP when:** You need 10-30 Mpps with kernel networking compatibility, manageable operational overhead, and the ability to fall through to the normal stack for non-hot-path traffic.

**Choose DPDK when:** You need >30 Mpps and can dedicate CPU cores, use DPDK-supported NICs, and accept the operational cost of managing DPDK-specific memory and driver models.

## Section 8: Monitoring XDP Programs

```bash
# View loaded XDP programs
bpftool prog show --json | jq '.[] | select(.type == "xdp")'

# Profile XDP program execution
bpftool prog profile id 42 duration 5

# Trace XDP events with bpftrace
bpftrace -e 'tracepoint:xdp:xdp_exception { @[args->prog_id] = count(); }'

# Monitor per-CPU drop rates
watch -n1 'cat /sys/class/net/eth0/statistics/rx_dropped'

# XDP map monitoring
bpftool map dump name stats_map --pretty

# Real-time packet drop rate from XDP
perf stat -e net:netif_rx_drop,net:napi_gro_frags_entry -a sleep 5
```

## Section 9: Production Deployment Checklist

```bash
#!/usr/bin/env bash
# deploy-xdp.sh — production XDP deployment with validation

set -euo pipefail

NIC="${1:?NIC interface required}"
BPF_OBJ="${2:?BPF object file required}"
SECTION="${3:-xdp}"

# Validate NIC supports native XDP
ethtool -i "$NIC" | grep "driver:" || exit 1

# Check current XDP program
CURRENT_XDP=$(ip link show "$NIC" | grep xdp | awk '{print $2}')
if [[ -n "$CURRENT_XDP" ]]; then
    echo "WARNING: XDP already loaded on $NIC: $CURRENT_XDP"
    echo "Replacing..."
fi

# Load new program
ip link set dev "$NIC" xdpdrv obj "$BPF_OBJ" sec "$SECTION"

# Verify it loaded
sleep 1
XDP_STATUS=$(ip link show "$NIC" | grep xdp)
if [[ -z "$XDP_STATUS" ]]; then
    echo "ERROR: XDP program failed to load"
    exit 1
fi
echo "XDP loaded: $XDP_STATUS"

# Monitor for errors in first 60 seconds
echo "Monitoring for 60 seconds..."
BEFORE_ERR=$(ethtool -S "$NIC" 2>/dev/null | grep -i "xdp.*error\|rx_drop" | awk '{sum+=$2} END {print sum}')
sleep 60
AFTER_ERR=$(ethtool -S "$NIC" 2>/dev/null | grep -i "xdp.*error\|rx_drop" | awk '{sum+=$2} END {print sum}')
NEW_ERRORS=$(( ${AFTER_ERR:-0} - ${BEFORE_ERR:-0} ))

if [[ $NEW_ERRORS -gt 1000 ]]; then
    echo "WARNING: $NEW_ERRORS XDP errors detected in 60s. Review configuration."
else
    echo "Deployment successful. XDP errors in first 60s: $NEW_ERRORS"
fi
```

## Summary

XDP provides kernel-resident packet processing at 10-30 Mpps without the operational overhead of DPDK. The key production patterns are:

- Use native (driver) mode whenever the NIC driver supports it — generic mode has 3-5x overhead due to sk_buff allocation
- LPM trie maps for IP prefix blocklists enable subnet-level DDoS mitigation without iterating every blocked IP
- LRU hash for connection tracking automatically evicts old sessions — size the map for your expected concurrent sessions with 20% headroom
- AF_XDP provides a path to userspace at near line-rate for applications that need full packet processing capabilities not available in restricted eBPF
- Always pin BPF maps to `/sys/fs/bpf/` so they persist across program reloads and can be read by monitoring tools
