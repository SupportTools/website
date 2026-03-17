---
title: "Linux XDP and AF_XDP: High-Performance Packet Processing at the Driver Layer"
date: 2029-12-17T00:00:00-05:00
draft: false
tags: ["Linux", "XDP", "AF_XDP", "eBPF", "Networking", "DPDK", "Zero-Copy", "Kernel", "Performance"]
categories:
- Linux
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into XDP program types, AF_XDP sockets, UMEM ring management, zero-copy forwarding, and a practical load balancer implementation using BPF maps and XDP redirect."
more_link: "yes"
url: "/linux-xdp-af-xdp-high-performance-packet-processing/"
---

eXpress Data Path (XDP) is the Linux kernel's answer to DPDK: a programmable, in-kernel fast path that executes eBPF programs at the earliest possible point in the network receive pipeline — before memory allocation, before the socket layer, and in many NICs, directly in the driver interrupt handler. When combined with AF_XDP sockets, user-space applications can pull packets from the kernel with zero copies and sub-microsecond latency. This guide covers XDP program types, AF_XDP socket setup, UMEM management, and builds a practical XDP load balancer using BPF maps.

<!--more-->

## XDP Program Types and Attachment Modes

XDP programs are attached to a network interface and run in three modes:

- **Native XDP (driver mode)**: The program runs inside the NIC driver's receive ring processing loop. Fastest mode, but requires driver support. Available on mlx5, i40e, ixgbe, virtio-net, and others.
- **Generic XDP (SKB mode)**: Falls back to running after the kernel builds an `sk_buff` structure. No driver support required, but loses the performance advantage.
- **Offloaded XDP**: The program runs on the NIC's embedded FPGA/SmartNIC processor. Eliminates host CPU usage entirely; requires Netronome or similar hardware.

XDP programs return one of five verdicts:

| Verdict | Meaning |
|---|---|
| `XDP_DROP` | Discard the packet immediately |
| `XDP_PASS` | Continue to the normal kernel network stack |
| `XDP_TX` | Transmit the packet back out the same interface |
| `XDP_REDIRECT` | Redirect to another interface, CPU queue, or AF_XDP socket |
| `XDP_ABORTED` | Drop with trace event (for debugging) |

## Writing an XDP Program in C

### Environment Setup

```bash
# Install dependencies (Ubuntu/Debian)
sudo apt-get install -y \
  clang llvm \
  libbpf-dev \
  linux-headers-$(uname -r) \
  iproute2 \
  bpftool

# Verify kernel version supports XDP (4.8+ for generic, 4.14+ for driver)
uname -r
```

### Basic Packet Filter

```c
// xdp_filter.c — drop all UDP packets destined for port 53
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define DNS_PORT 53

SEC("xdp")
int xdp_filter_prog(struct xdp_md *ctx) {
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

    if (ip->protocol != IPPROTO_UDP)
        return XDP_PASS;

    // Calculate IP header length (variable due to options)
    int ip_hdr_len = ip->ihl * 4;
    struct udphdr *udp = (void *)ip + ip_hdr_len;
    if ((void *)(udp + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(udp->dest) == DNS_PORT)
        return XDP_DROP;

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

Compile and attach:

```bash
clang -O2 -g -Wall -target bpf \
    -I/usr/include/$(uname -m)-linux-gnu \
    -c xdp_filter.c -o xdp_filter.o

# Attach in native mode (replace eth0 with your interface)
sudo ip link set dev eth0 xdp obj xdp_filter.o sec xdp

# Verify attachment
ip link show dev eth0 | grep xdp

# Detach
sudo ip link set dev eth0 xdp off
```

## XDP Load Balancer with BPF Maps

A practical XDP load balancer uses a BPF hash map keyed on the destination IP to store backend assignments, and `bpf_redirect_map` with a `devmap` to steer packets to the correct egress interface without going through the kernel stack.

### BPF Map Definitions

```c
// xdp_lb.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// devmap: index -> ifindex for XDP_REDIRECT
struct {
    __uint(type, BPF_MAP_TYPE_DEVMAP);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u32));
    __uint(max_entries, 16);
} tx_ports SEC(".maps");

// Per-CPU stats counter
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(__u64));
    __uint(max_entries, 2); // 0=forwarded, 1=dropped
} xdp_stats SEC(".maps");

// VIP-to-backend mapping: destination IP -> backend index in devmap
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(key_size, sizeof(__be32));
    __uint(value_size, sizeof(__u32));
    __uint(max_entries, 1024);
} vip_map SEC(".maps");

static __always_inline void incr_stat(__u32 idx) {
    __u64 *cnt = bpf_map_lookup_elem(&xdp_stats, &idx);
    if (cnt)
        __sync_fetch_and_add(cnt, 1);
}

SEC("xdp")
int xdp_lb_prog(struct xdp_md *ctx) {
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

    __be32 dst = ip->daddr;
    __u32 *backend_idx = bpf_map_lookup_elem(&vip_map, &dst);
    if (!backend_idx)
        return XDP_PASS;

    incr_stat(0);
    return bpf_redirect_map(&tx_ports, *backend_idx, 0);
}

char _license[] SEC("license") = "GPL";
```

### User-Space Control Plane

```c
// xdp_lb_ctrl.c — configure devmap and vip_map from user space
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    struct bpf_object *obj;
    int tx_ports_fd, vip_map_fd, prog_fd;
    int err;

    obj = bpf_object__open_file("xdp_lb.o", NULL);
    if (libbpf_get_error(obj)) {
        fprintf(stderr, "Failed to open BPF object\n");
        return 1;
    }

    err = bpf_object__load(obj);
    if (err) {
        fprintf(stderr, "Failed to load BPF object: %d\n", err);
        return 1;
    }

    tx_ports_fd = bpf_object__find_map_fd_by_name(obj, "tx_ports");
    vip_map_fd  = bpf_object__find_map_fd_by_name(obj, "vip_map");
    prog_fd     = bpf_program__fd(bpf_object__find_program_by_name(obj, "xdp_lb_prog"));

    // Add backend interfaces to devmap (index 0 -> eth1, index 1 -> eth2)
    unsigned int eth1_idx = if_nametoindex("eth1");
    unsigned int eth2_idx = if_nametoindex("eth2");
    __u32 key0 = 0, key1 = 1;

    bpf_map_update_elem(tx_ports_fd, &key0, &eth1_idx, BPF_ANY);
    bpf_map_update_elem(tx_ports_fd, &key1, &eth2_idx, BPF_ANY);

    // Route VIP 10.0.0.100 to backend index 0 (eth1)
    __be32 vip;
    inet_pton(AF_INET, "10.0.0.100", &vip);
    __u32 backend = 0;
    bpf_map_update_elem(vip_map_fd, &vip, &backend, BPF_ANY);

    // Attach to ingress interface eth0
    unsigned int ifindex = if_nametoindex("eth0");
    err = bpf_xdp_attach(ifindex, prog_fd, XDP_FLAGS_DRV_MODE, NULL);
    if (err) {
        fprintf(stderr, "Failed to attach XDP program: %s\n", strerror(errno));
        return 1;
    }

    printf("XDP load balancer attached to eth0\n");
    printf("  VIP 10.0.0.100 -> eth1 (ifindex %u)\n", eth1_idx);

    return 0;
}
```

## AF_XDP Sockets: Zero-Copy User-Space Packet Processing

AF_XDP sockets bypass the kernel's socket layer entirely. The user-space application and kernel share a UMEM (User Memory) region backed by huge pages, and exchange packet buffers through four lock-free ring queues.

### UMEM and Ring Architecture

```
User Space                          Kernel / Driver
┌────────────────────────────────────────────────────────┐
│  UMEM (shared memory - hugepages)                      │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐          │
│  │ 4KB  │ 4KB  │ 4KB  │ 4KB  │ 4KB  │ 4KB  │ frames  │
│  └──────┴──────┴──────┴──────┴──────┴──────┘          │
└────────────────────────────────────────────────────────┘

Ring Queues (shared between user and kernel via mmap):
  FILL ring:   User → Kernel  (free frame addresses for RX)
  RX ring:     Kernel → User  (received frame addresses)
  TX ring:     User → Kernel  (frames to transmit)
  COMPLETION:  Kernel → User  (completed TX frame addresses)
```

### AF_XDP Socket in C

```c
// afxdp_recv.c — minimal AF_XDP receive loop
#include <linux/if_xdp.h>
#include <sys/socket.h>
#include <sys/mman.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <bpf/xsk.h>

#define FRAME_SIZE       XSK_UMEM__DEFAULT_FRAME_SIZE  // 4096
#define NUM_FRAMES       4096
#define BATCH_SIZE       64
#define UMEM_SIZE        (NUM_FRAMES * FRAME_SIZE)

struct xsk_socket_info {
    struct xsk_ring_cons rx;
    struct xsk_ring_prod fq;
    struct xsk_umem     *umem;
    struct xsk_socket   *xsk;
    void                *umem_area;
};

static int configure_socket(struct xsk_socket_info *xsk_info,
                             const char *ifname, int queue_id) {
    // Allocate UMEM with huge pages
    xsk_info->umem_area = mmap(NULL, UMEM_SIZE,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
        -1, 0);
    if (xsk_info->umem_area == MAP_FAILED) {
        // Fallback to regular pages
        xsk_info->umem_area = mmap(NULL, UMEM_SIZE,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (xsk_info->umem_area == MAP_FAILED)
            return -1;
    }

    struct xsk_umem_config umem_cfg = {
        .fill_size      = NUM_FRAMES * 2,
        .comp_size      = NUM_FRAMES * 2,
        .frame_size     = FRAME_SIZE,
        .frame_headroom = 0,
    };

    int ret = xsk_umem__create(&xsk_info->umem,
                               xsk_info->umem_area, UMEM_SIZE,
                               &xsk_info->fq, NULL, &umem_cfg);
    if (ret)
        return ret;

    struct xsk_socket_config xsk_cfg = {
        .rx_size        = NUM_FRAMES,
        .tx_size        = NUM_FRAMES,
        .libxdp_flags   = 0,
        .xdp_flags      = XDP_FLAGS_DRV_MODE,
        .bind_flags     = XDP_ZEROCOPY,   // Zero-copy if driver supports it
    };

    ret = xsk_socket__create(&xsk_info->xsk,
                             ifname, queue_id,
                             xsk_info->umem,
                             &xsk_info->rx, NULL, &xsk_cfg);
    if (ret) {
        // Fall back to copy mode if zero-copy unavailable
        xsk_cfg.bind_flags = XDP_COPY;
        ret = xsk_socket__create(&xsk_info->xsk,
                                 ifname, queue_id,
                                 xsk_info->umem,
                                 &xsk_info->rx, NULL, &xsk_cfg);
        if (ret)
            return ret;
    }

    // Pre-populate the FILL ring with frame addresses
    __u32 idx;
    ret = xsk_ring_prod__reserve(&xsk_info->fq, NUM_FRAMES, &idx);
    for (int i = 0; i < NUM_FRAMES; i++)
        *xsk_ring_prod__fill_addr(&xsk_info->fq, idx++) = i * FRAME_SIZE;
    xsk_ring_prod__submit(&xsk_info->fq, NUM_FRAMES);

    return 0;
}

static void receive_packets(struct xsk_socket_info *xsk_info) {
    struct pollfd pfd = {
        .fd     = xsk_socket__fd(xsk_info->xsk),
        .events = POLLIN,
    };

    printf("AF_XDP socket ready. Waiting for packets...\n");

    while (1) {
        int ret = poll(&pfd, 1, 1000);
        if (ret <= 0)
            continue;

        __u32 rx_idx = 0;
        __u32 rcvd = xsk_ring_cons__peek(&xsk_info->rx, BATCH_SIZE, &rx_idx);
        if (!rcvd)
            continue;

        for (__u32 i = 0; i < rcvd; i++) {
            const struct xdp_desc *desc = xsk_ring_cons__rx_desc(&xsk_info->rx, rx_idx + i);
            __u64 addr = desc->addr;
            __u32 len  = desc->len;

            // Get pointer to packet data in UMEM — zero copy
            void *pkt = xsk_umem__get_data(xsk_info->umem_area, addr);

            // Process packet (example: just print length)
            printf("Received packet: %u bytes at UMEM offset %llu\n", len, addr);

            // Return frame to FILL ring for reuse
            __u32 fq_idx;
            xsk_ring_prod__reserve(&xsk_info->fq, 1, &fq_idx);
            *xsk_ring_prod__fill_addr(&xsk_info->fq, fq_idx) = addr;
            xsk_ring_prod__submit(&xsk_info->fq, 1);
        }

        xsk_ring_cons__release(&xsk_info->rx, rcvd);
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <ifname>\n", argv[0]);
        return 1;
    }

    struct xsk_socket_info xsk_info = {0};
    if (configure_socket(&xsk_info, argv[1], 0) != 0) {
        fprintf(stderr, "Failed to configure AF_XDP socket\n");
        return 1;
    }

    receive_packets(&xsk_info);
    return 0;
}
```

## Go User-Space Application with AF_XDP

The `github.com/asavie/xdp` Go package wraps libbpf for AF_XDP socket management:

```go
// main.go — Go AF_XDP packet counter
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/asavie/xdp"
	"github.com/vishvananda/netlink"
)

func main() {
	ifname := os.Args[1]

	link, err := netlink.LinkByName(ifname)
	if err != nil {
		log.Fatalf("could not find interface %q: %v", ifname, err)
	}

	program, err := xdp.NewProgram(5) // 5 sockets pre-allocated
	if err != nil {
		log.Fatalf("could not create XDP program: %v", err)
	}
	defer program.Detach(link.Attrs().Index)

	if err := program.Attach(link.Attrs().Index); err != nil {
		log.Fatalf("could not attach XDP program: %v", err)
	}

	// Open AF_XDP socket on queue 0
	sock, err := xdp.NewSocket(link.Attrs().Index, 0, nil)
	if err != nil {
		log.Fatalf("could not create AF_XDP socket: %v", err)
	}
	defer sock.Close()

	if err := program.Register(0, sock.FD()); err != nil {
		log.Fatalf("could not register socket: %v", err)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	var total uint64
	go func() {
		for {
			if n, pos, err := sock.Poll(-1); err == nil {
				for i := 0; i < n; i++ {
					desc := sock.Receive(pos + i)
					frame := sock.GetFrame(desc)
					// Parse Ethernet header to get source MAC
					if len(frame) >= 14 {
						src := net.HardwareAddr(frame[6:12])
						fmt.Printf("pkt from %s len=%d\n", src, len(frame))
					}
					total++
				}
				sock.FillAll()
			}
		}
	}()

	<-sig
	fmt.Printf("\nTotal packets received: %d\n", total)
}
```

## Performance Benchmarking

Measure XDP throughput against baseline kernel stack with `pktgen` and `xdp-bench`:

```bash
# Install xdp-tools
sudo apt-get install -y xdp-tools

# Benchmark XDP DROP rate on eth0 (measures max XDP processing rate)
sudo xdp-bench drop eth0 --mode native

# Expected output on a modern NIC (e.g., Intel X710):
# Running XDP on dev:eth0 (ifindex 2) action:XDP_DROP options:swhw
# XDP-DROP  CPU    pps(1sec)  pps(10sec)  rx_dropped  rx_error
# XDP-DROP    0   14,821,043  14,798,221          0        0
# XDP-DROP    1   14,815,909  14,801,445          0        0

# Measure AF_XDP throughput (zero-copy, single queue)
sudo xdp-bench xsk eth0 --mode zerocopy

# Baseline: kernel TCP stack throughput for comparison
iperf3 -s &
iperf3 -c <server_ip> -t 30 -P 4
```

## Attaching XDP Programs via ip link

```bash
# Native driver mode (fastest)
sudo ip link set dev eth0 xdp obj xdp_lb.o sec xdp

# Generic/SKB mode (fallback for any driver)
sudo ip link set dev eth0 xdpgeneric obj xdp_lb.o sec xdp

# Offload mode (SmartNIC hardware)
sudo ip link set dev eth0 xdpoffload obj xdp_lb.o sec xdp

# Detach
sudo ip link set dev eth0 xdp off

# Inspect attached program
sudo bpftool net show dev eth0

# Dump BPF map contents
sudo bpftool map show
sudo bpftool map dump id <map_id>
```

## Observability: BPF Ring Buffer

Replace per-CPU arrays with a BPF ring buffer for efficient event streaming to user space:

```c
// In the XDP program (kernel side)
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24); // 16 MB
} events SEC(".maps");

struct pkt_event {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u32 pkt_len;
};

// Inside the XDP program, after parsing headers:
struct pkt_event *evt = bpf_ringbuf_reserve(&events, sizeof(*evt), 0);
if (evt) {
    evt->src_ip   = ip->saddr;
    evt->dst_ip   = ip->daddr;
    evt->src_port = bpf_ntohs(tcp->source);
    evt->dst_port = bpf_ntohs(tcp->dest);
    evt->pkt_len  = (long)data_end - (long)data;
    bpf_ringbuf_submit(evt, 0);
}
```

## Summary

XDP provides programmable packet processing at line rate without the complexity of DPDK's user-space driver model. Native mode XDP consistently achieves 14–28 million packets per second on commodity 10/25 GbE NICs. AF_XDP zero-copy sockets bring that performance to user-space applications without kernel bypass. The load balancer pattern demonstrated here — BPF maps for VIP routing, devmap for redirect targets, per-CPU counters for statistics — forms the foundation for production-grade XDP applications including DDoS mitigation, SYN flood protection, and high-throughput packet sampling.
