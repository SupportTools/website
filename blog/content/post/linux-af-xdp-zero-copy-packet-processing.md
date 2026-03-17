---
title: "Linux AF_XDP: Zero-Copy Packet Processing in Userspace"
date: 2029-07-22T00:00:00-05:00
draft: false
tags: ["Linux", "AF_XDP", "Networking", "Performance", "eBPF", "Zero-Copy", "Kernel Bypass"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to AF_XDP socket setup, UMEM registration, fill and completion rings, zero-copy vs copy mode, kernel bypass networking, and production benchmarks for high-performance packet processing."
more_link: "yes"
url: "/linux-af-xdp-zero-copy-packet-processing/"
---

AF_XDP (Address Family eXpress Data Path) is a Linux kernel socket type that allows userspace applications to receive and transmit packets with dramatically reduced overhead compared to conventional sockets. Unlike DPDK which completely bypasses the kernel, AF_XDP sits at the XDP hook point in the kernel's network stack, allowing selective packet steering: some traffic goes to the kernel network stack normally, while chosen packets are redirected to a shared-memory ring buffer that userspace polls directly. The result is near-DPDK performance without requiring dedicated NIC drivers or root privileges for all operations.

<!--more-->

# Linux AF_XDP: Zero-Copy Packet Processing in Userspace

## Section 1: AF_XDP Architecture Overview

AF_XDP works through a combination of eBPF programs and shared-memory rings:

```
NIC ──> Driver ──> XDP hook ──> eBPF redirect program
                                       │
                                       │ XDP_REDIRECT to AF_XDP socket
                                       ▼
                              ┌─────────────────────┐
                              │   UMEM (Shared       │
                              │   Memory Region)     │
                              │   Registered with    │
                              │   kernel + userspace │
                              └─────────┬───────────┘
                                        │
              ┌─────────────────────────┼──────────────────────────┐
              │                         │                           │
    ┌─────────▼─────────┐   ┌──────────▼──────────┐   ┌──────────▼──────────┐
    │    Fill Ring       │   │     RX Ring          │   │  TX / Completion    │
    │ (userspace→kernel) │   │  (kernel→userspace)  │   │      Rings          │
    │ Provide buffers    │   │  Receive packets     │   │  Transmit packets   │
    └───────────────────┘   └─────────────────────┘   └────────────────────┘
```

### Key Components

- **UMEM**: a contiguous memory region divided into fixed-size frames (chunks). Both kernel and userspace map this region.
- **Fill Ring**: userspace writes frame addresses here to provide empty buffers for the kernel to fill with received packets
- **RX Ring**: kernel writes received packet descriptors here; userspace reads them to process packets
- **TX Ring**: userspace writes packet descriptors here to request transmission
- **Completion Ring**: kernel confirms transmitted packets by writing their addresses here; userspace recycles them

### Zero-Copy vs Copy Mode

| Mode | Mechanism | Requirements | Latency |
|---|---|---|---|
| Zero-copy | NIC DMA directly into UMEM | Driver support (i40e, mlx5, ice) | Minimal |
| Copy mode | Kernel copies packets into UMEM | Any driver | Low, but extra memcpy |

```bash
# Check if your NIC supports zero-copy AF_XDP
ethtool -i eth0 | grep driver
# Supported zero-copy drivers: i40e, ice, mlx5_core, bnxt_en, ena

# Kernel version requirement
uname -r  # 5.4+ for basic AF_XDP, 5.10+ for zero-copy on most drivers
```

## Section 2: Build Environment Setup

```bash
# Install required headers and libraries
apt-get install -y \
    linux-headers-$(uname -r) \
    libbpf-dev \
    libelf-dev \
    zlib1g-dev \
    clang \
    llvm

# Or on RHEL/CentOS
dnf install -y \
    kernel-devel-$(uname -r) \
    libbpf-devel \
    elfutils-libelf-devel \
    zlib-devel \
    clang \
    llvm

# Verify libbpf version (1.0+ recommended)
pkg-config --modversion libbpf
```

## Section 3: UMEM and Socket Initialization

```c
// afxdp/xdp_sock.h
#ifndef XDP_SOCK_H
#define XDP_SOCK_H

#include <linux/if_xdp.h>
#include <sys/mman.h>
#include <stdint.h>
#include <stdbool.h>

#define NUM_FRAMES         4096
#define FRAME_SIZE         XSK_UMEM__DEFAULT_FRAME_SIZE   // 4096 bytes
#define FILL_RING_SIZE     XSK_RING_PROD__DEFAULT_NUM_DESCS  // 2048
#define COMP_RING_SIZE     XSK_RING_CONS__DEFAULT_NUM_DESCS  // 2048
#define RX_RING_SIZE       XSK_RING_CONS__DEFAULT_NUM_DESCS  // 2048
#define TX_RING_SIZE       XSK_RING_PROD__DEFAULT_NUM_DESCS  // 2048
#define UMEM_SIZE          (NUM_FRAMES * FRAME_SIZE)

struct xdp_umem_info {
    void              *buffer;       // mmap'd memory region
    struct xsk_umem   *umem;         // libbpf UMEM handle
    struct xsk_ring_prod fill;       // fill ring
    struct xsk_ring_cons comp;       // completion ring
};

struct xdp_sock_info {
    struct xsk_socket       *xsk;    // libbpf socket handle
    struct xsk_ring_cons     rx;     // RX ring
    struct xsk_ring_prod     tx;     // TX ring
    struct xdp_umem_info    *umem;
    uint64_t                 outstanding_tx;  // frames in flight
    int                      fd;
};

#endif
```

```c
// afxdp/xdp_sock.c
#include "xdp_sock.h"
#include <xdp/xsk.h>
#include <xdp/libxdp.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <net/if.h>

// Allocate and configure the UMEM
static int setup_umem(struct xdp_umem_info **umem_out) {
    struct xdp_umem_info *umem;
    struct xsk_umem_config config = {
        .fill_size      = FILL_RING_SIZE,
        .comp_size      = COMP_RING_SIZE,
        .frame_size     = FRAME_SIZE,
        .frame_headroom = XSK_UMEM__DEFAULT_FRAME_HEADROOM,
        .flags          = 0,
    };

    umem = calloc(1, sizeof(*umem));
    if (!umem) return -ENOMEM;

    // Allocate the shared memory region
    // Aligned to page size for zero-copy compatibility
    umem->buffer = mmap(NULL, UMEM_SIZE,
                        PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                        -1, 0);

    if (umem->buffer == MAP_FAILED) {
        // Fall back to regular pages if huge pages unavailable
        umem->buffer = mmap(NULL, UMEM_SIZE,
                            PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS,
                            -1, 0);
        if (umem->buffer == MAP_FAILED) {
            perror("mmap UMEM");
            free(umem);
            return -ENOMEM;
        }
    }

    // Register the memory region with the kernel
    int ret = xsk_umem__create(&umem->umem,
                                umem->buffer, UMEM_SIZE,
                                &umem->fill, &umem->comp,
                                &config);
    if (ret) {
        fprintf(stderr, "xsk_umem__create failed: %s\n", strerror(-ret));
        munmap(umem->buffer, UMEM_SIZE);
        free(umem);
        return ret;
    }

    *umem_out = umem;
    return 0;
}

// Pre-populate the fill ring with frame addresses so kernel has buffers
static int populate_fill_ring(struct xdp_umem_info *umem) {
    uint32_t idx;
    int ret;

    // Reserve space in fill ring for all frames
    ret = xsk_ring_prod__reserve(&umem->fill, NUM_FRAMES, &idx);
    if (ret != NUM_FRAMES) {
        fprintf(stderr, "fill ring reserve: wanted %d, got %d\n", NUM_FRAMES, ret);
        return -1;
    }

    // Assign frame addresses to fill ring entries
    for (int i = 0; i < NUM_FRAMES; i++) {
        *xsk_ring_prod__fill_addr(&umem->fill, idx++) =
            (uint64_t)i * FRAME_SIZE;
    }

    xsk_ring_prod__submit(&umem->fill, NUM_FRAMES);
    return 0;
}

// Create and configure the AF_XDP socket
int xdp_socket_create(const char *ifname, int queue_id,
                       bool zero_copy, struct xdp_sock_info **sock_out) {
    struct xdp_sock_info *sock;
    struct xdp_umem_info *umem;
    int ret;

    // Setup UMEM first
    ret = setup_umem(&umem);
    if (ret) return ret;

    ret = populate_fill_ring(umem);
    if (ret) {
        xsk_umem__delete(umem->umem);
        munmap(umem->buffer, UMEM_SIZE);
        free(umem);
        return ret;
    }

    sock = calloc(1, sizeof(*sock));
    if (!sock) {
        ret = -ENOMEM;
        goto err_umem;
    }
    sock->umem = umem;

    struct xsk_socket_config xsk_cfg = {
        .rx_size          = RX_RING_SIZE,
        .tx_size          = TX_RING_SIZE,
        .xdp_flags        = zero_copy ?
                            XDP_FLAGS_DRV_MODE : XDP_FLAGS_SKB_MODE,
        .bind_flags       = zero_copy ?
                            XDP_ZEROCOPY : XDP_COPY,
        .libbpf_flags     = 0,
    };

    // Create the AF_XDP socket and bind to NIC queue
    ret = xsk_socket__create(&sock->xsk, ifname, queue_id,
                              umem->umem,
                              &sock->rx, &sock->tx,
                              &xsk_cfg);
    if (ret) {
        if (zero_copy && ret == -ENOTSUP) {
            fprintf(stderr, "Zero-copy not supported on %s, falling back to copy mode\n", ifname);
            xsk_cfg.xdp_flags = XDP_FLAGS_SKB_MODE;
            xsk_cfg.bind_flags = XDP_COPY;
            ret = xsk_socket__create(&sock->xsk, ifname, queue_id,
                                      umem->umem, &sock->rx, &sock->tx, &xsk_cfg);
        }
        if (ret) {
            fprintf(stderr, "xsk_socket__create failed: %s\n", strerror(-ret));
            goto err_sock;
        }
    }

    sock->fd = xsk_socket__fd(sock->xsk);
    *sock_out = sock;
    return 0;

err_sock:
    free(sock);
err_umem:
    xsk_umem__delete(umem->umem);
    munmap(umem->buffer, UMEM_SIZE);
    free(umem);
    return ret;
}
```

## Section 4: Packet Receive Loop

```c
// afxdp/receive.c
#include "xdp_sock.h"
#include <poll.h>
#include <stdint.h>
#include <string.h>

// Statistics
struct xdp_stats {
    uint64_t rx_packets;
    uint64_t rx_bytes;
    uint64_t rx_dropped;
    uint64_t fill_ring_empty;
};

// Process received packets — called in the hot path
static int process_rx_batch(struct xdp_sock_info *sock,
                              struct xdp_stats *stats,
                              int batch_size) {
    uint32_t idx_rx = 0, idx_fq = 0;
    unsigned int received;
    int ret;

    // Consume up to batch_size descriptors from RX ring
    received = xsk_ring_cons__peek(&sock->rx, batch_size, &idx_rx);
    if (!received) {
        return 0;
    }

    // Reserve space in fill ring to replenish consumed buffers
    ret = xsk_ring_prod__reserve(&sock->umem->fill, received, &idx_fq);
    while (ret != (int)received) {
        // Fill ring is full — spin until space available
        // In production, this should not happen if fill ring is sized correctly
        stats->fill_ring_empty++;
        ret = xsk_ring_prod__reserve(&sock->umem->fill, received, &idx_fq);
    }

    for (unsigned int i = 0; i < received; i++) {
        const struct xdp_desc *desc = xsk_ring_cons__rx_desc(&sock->rx, idx_rx++);
        uint64_t addr = desc->addr;
        uint32_t len  = desc->len;

        // Get pointer to packet data in UMEM
        void *pkt = xsk_umem__get_data(sock->umem->buffer, addr);

        // === Your packet processing logic here ===
        // pkt points to the raw Ethernet frame
        // len is the frame length in bytes
        process_packet(pkt, len, stats);

        // Return the buffer to the fill ring
        *xsk_ring_prod__fill_addr(&sock->umem->fill, idx_fq++) = addr;
    }

    // Release consumed RX descriptors
    xsk_ring_cons__release(&sock->rx, received);

    // Submit returned buffers to fill ring
    xsk_ring_prod__submit(&sock->umem->fill, received);

    stats->rx_packets += received;
    return received;
}

// Main receive loop with poll-based blocking
void xdp_receive_loop(struct xdp_sock_info *sock, volatile int *running) {
    struct pollfd fds[1] = {
        { .fd = sock->fd, .events = POLLIN }
    };
    struct xdp_stats stats = {0};

    printf("AF_XDP receive loop started (fd=%d)\n", sock->fd);

    while (*running) {
        // Try busy-poll first for minimum latency
        int n = process_rx_batch(sock, &stats, 64);

        if (n == 0) {
            // No packets — block for up to 10ms
            int poll_ret = poll(fds, 1, 10);
            if (poll_ret < 0 && errno != EINTR) {
                perror("poll");
                break;
            }
        }

        // Print stats every million packets
        if (stats.rx_packets % 1000000 == 0 && stats.rx_packets > 0) {
            printf("RX: %lu packets, %lu bytes, %lu dropped\n",
                   stats.rx_packets, stats.rx_bytes, stats.rx_dropped);
        }
    }
}

// Inline packet processing (example: count by IP protocol)
static inline void process_packet(void *data, uint32_t len, struct xdp_stats *stats) {
    // Minimum Ethernet header size
    if (len < 14) {
        stats->rx_dropped++;
        return;
    }

    // Ethernet header
    uint8_t *eth = (uint8_t *)data;
    uint16_t ethertype = (eth[12] << 8) | eth[13];

    stats->rx_bytes += len;

    // Example: just count packets by ethertype
    // In production, dispatch to per-protocol handlers
    (void)ethertype;
}
```

## Section 5: Packet Transmit

```c
// afxdp/transmit.c
#include "xdp_sock.h"
#include <string.h>

// Get a free frame from the completion ring or UMEM free list
static uint64_t get_free_frame(struct xdp_sock_info *sock) {
    uint32_t idx_cq;
    uint64_t addr;

    // Try completion ring first (recycled TX frames)
    if (xsk_ring_cons__peek(&sock->umem->comp, 1, &idx_cq)) {
        addr = *xsk_ring_cons__comp_addr(&sock->umem->comp, idx_cq);
        xsk_ring_cons__release(&sock->umem->comp, 1);
        return addr;
    }

    // No recycled frames available
    return UINT64_MAX;
}

// Transmit a packet
int xdp_transmit(struct xdp_sock_info *sock, const void *data, uint32_t len) {
    uint32_t idx_tx;
    uint64_t frame_addr;

    if (len > FRAME_SIZE) {
        return -EINVAL;
    }

    // Get a free UMEM frame for this packet
    frame_addr = get_free_frame(sock);
    if (frame_addr == UINT64_MAX) {
        return -ENOBUFS;
    }

    // Copy packet data into the UMEM frame
    void *frame = xsk_umem__get_data(sock->umem->buffer, frame_addr);
    memcpy(frame, data, len);

    // Reserve space in TX ring
    if (!xsk_ring_prod__reserve(&sock->tx, 1, &idx_tx)) {
        return -ENOBUFS;
    }

    // Write TX descriptor
    struct xdp_desc *desc = xsk_ring_prod__tx_desc(&sock->tx, idx_tx);
    desc->addr = frame_addr;
    desc->len  = len;

    xsk_ring_prod__submit(&sock->tx, 1);
    sock->outstanding_tx++;

    // Kick the kernel to process TX ring
    // In busy-poll mode, use sendmsg with MSG_DONTWAIT
    if (sock->outstanding_tx > TX_RING_SIZE / 2) {
        sendmsg(sock->fd, NULL, MSG_DONTWAIT);
        sock->outstanding_tx = 0;
    }

    return 0;
}

// Flush pending TX and drain completion ring
void xdp_flush_tx(struct xdp_sock_info *sock) {
    if (sock->outstanding_tx > 0) {
        sendmsg(sock->fd, NULL, MSG_DONTWAIT);
        sock->outstanding_tx = 0;
    }

    // Drain completion ring
    uint32_t idx_cq;
    unsigned int completed = xsk_ring_cons__peek(&sock->umem->comp, TX_RING_SIZE, &idx_cq);
    if (completed > 0) {
        xsk_ring_cons__release(&sock->umem->comp, completed);
    }
}
```

## Section 6: eBPF Program for Packet Steering

AF_XDP requires an eBPF program to redirect packets to the XDP socket. Without it, no packets reach the AF_XDP socket.

```c
// ebpf/xdp_redirect.bpf.c
// Compiled with: clang -O2 -target bpf -c xdp_redirect.bpf.c -o xdp_redirect.bpf.o

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <arpa/inet.h>

// Map to hold XDP socket file descriptors indexed by queue ID
struct {
    __uint(type,        BPF_MAP_TYPE_XSKMAP);
    __uint(max_entries, 64);    // max 64 queues
    __uint(key_size,    sizeof(int));
    __uint(value_size,  sizeof(int));
} xsks_map SEC(".maps");

// Redirect port: only redirect UDP traffic to this destination port to AF_XDP
// Change to 0 to redirect all traffic
#define TARGET_PORT 4789  // VXLAN port

SEC("xdp")
int xdp_redirect_prog(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // Only process IPv4
    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Only process UDP (for VXLAN example)
    if (ip->protocol != IPPROTO_UDP)
        return XDP_PASS;

    // Parse UDP header
    struct udphdr *udp = (void *)ip + (ip->ihl * 4);
    if ((void *)(udp + 1) > data_end)
        return XDP_PASS;

    // Check destination port
    if (TARGET_PORT != 0 && udp->dest != htons(TARGET_PORT))
        return XDP_PASS;

    // Redirect to AF_XDP socket for this queue
    int queue_id = ctx->rx_queue_index;
    if (bpf_map_lookup_elem(&xsks_map, &queue_id))
        return bpf_redirect_map(&xsks_map, queue_id, XDP_PASS);

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

```c
// ebpf/load_prog.c - Load and attach the eBPF program
#include <xdp/libxdp.h>
#include <bpf/libbpf.h>
#include <net/if.h>
#include <errno.h>
#include <stdio.h>

int load_xdp_program(const char *ifname, struct xdp_sock_info *sock, int queue_id) {
    unsigned int ifindex = if_nametoindex(ifname);
    if (!ifindex) {
        perror("if_nametoindex");
        return -1;
    }

    // Load the XDP program
    struct xdp_program *prog;
    prog = xdp_program__open_file("xdp_redirect.bpf.o", "xdp", NULL);
    if (libxdp_get_error(prog)) {
        char errmsg[1024];
        libxdp_strerror(libxdp_get_error(prog), errmsg, sizeof(errmsg));
        fprintf(stderr, "xdp_program__open_file: %s\n", errmsg);
        return -1;
    }

    // Attach to interface
    int ret = xdp_program__attach(prog, ifindex, XDP_MODE_NATIVE, 0);
    if (ret) {
        fprintf(stderr, "xdp_program__attach: %s\n", strerror(-ret));
        xdp_program__close(prog);
        return ret;
    }

    // Register the AF_XDP socket in the XSKMAP
    struct bpf_object *obj = xdp_program__bpf_obj(prog);
    struct bpf_map *xsks_map = bpf_object__find_map_by_name(obj, "xsks_map");
    if (!xsks_map) {
        fprintf(stderr, "xsks_map not found in BPF program\n");
        return -1;
    }

    int map_fd = bpf_map__fd(xsks_map);
    int xsk_fd = xsk_socket__fd(sock->xsk);
    ret = bpf_map_update_elem(map_fd, &queue_id, &xsk_fd, BPF_ANY);
    if (ret) {
        fprintf(stderr, "bpf_map_update_elem xsks_map: %s\n", strerror(errno));
        return ret;
    }

    printf("XDP program loaded and attached to %s (queue %d)\n", ifname, queue_id);
    return 0;
}
```

## Section 7: Multi-Queue AF_XDP

```c
// afxdp/multi_queue.c
// Scale AF_XDP across multiple RX queues using one socket per queue

#include "xdp_sock.h"
#include <pthread.h>
#include <sched.h>

#define MAX_QUEUES 64

struct worker_args {
    struct xdp_sock_info *sock;
    int                   cpu;
    volatile int         *running;
};

static void *worker_thread(void *arg) {
    struct worker_args *args = arg;

    // Pin thread to specific CPU
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(args->cpu, &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset);

    printf("Worker on CPU %d started (queue fd=%d)\n", args->cpu, args->sock->fd);
    xdp_receive_loop(args->sock, args->running);
    return NULL;
}

int create_multi_queue_setup(const char *ifname, int num_queues, bool zero_copy) {
    struct xdp_sock_info *socks[MAX_QUEUES];
    pthread_t threads[MAX_QUEUES];
    struct worker_args thread_args[MAX_QUEUES];
    volatile int running = 1;

    if (num_queues > MAX_QUEUES) num_queues = MAX_QUEUES;

    // Configure NIC to use num_queues RX queues
    // ethtool -L eth0 combined num_queues

    for (int q = 0; q < num_queues; q++) {
        int ret = xdp_socket_create(ifname, q, zero_copy, &socks[q]);
        if (ret) {
            fprintf(stderr, "Failed to create socket for queue %d: %s\n", q, strerror(-ret));
            return ret;
        }

        // Load eBPF program and register this socket
        ret = load_xdp_program(ifname, socks[q], q);
        if (ret) {
            return ret;
        }

        thread_args[q].sock    = socks[q];
        thread_args[q].cpu     = q;  // pin queue q to CPU q
        thread_args[q].running = &running;

        pthread_create(&threads[q], NULL, worker_thread, &thread_args[q]);
    }

    printf("AF_XDP setup complete: %d queues on %s\n", num_queues, ifname);

    // Join threads (normally they run until signal)
    for (int q = 0; q < num_queues; q++) {
        pthread_join(threads[q], NULL);
    }

    return 0;
}
```

## Section 8: Performance Benchmarks

```bash
# Benchmark setup: two servers connected back-to-back (10G NIC)
# Server A: packet generator using xdp-tools/xdp-bench
# Server B: AF_XDP receiver

# Install xdp-tools
git clone https://github.com/xdp-project/xdp-tools.git
cd xdp-tools && make && make install

# Generate packets at line rate
xdp-bench tx enp0s31f6 --mode xdp-native --pkt-size 64 --rate 10000000

# Receive with AF_XDP (zero-copy)
xdp-bench rx enp0s31f6 --mode xdp-zerocopy

# Typical results (10G NIC, 64-byte packets):
# AF_XDP zero-copy:  ~14.88 Mpps (line rate)
# AF_XDP copy mode:  ~10-12 Mpps
# Kernel socket:     ~1-2 Mpps
# DPDK (for reference): ~14.88 Mpps (line rate)
```

```bash
# Benchmark with perf to measure CPU cycles per packet
perf stat -e cycles,instructions,cache-misses,tlb-miss \
    ./af_xdp_receive -i eth0 -q 0 -z &

sleep 10
kill %1

# Expected output for zero-copy:
# cycles/packet: ~100-150 (vs ~500-800 for kernel path)
# cache-misses: very low (UMEM fits in L3 cache)
# tlb-miss: near zero (contiguous UMEM mapping)
```

### Latency Measurement

```c
// afxdp/latency_bench.c
// Measure round-trip latency: TX timestamp in packet, compare on RX

#include "xdp_sock.h"
#include <time.h>
#include <stdint.h>
#include <stdio.h>

#define NUM_SAMPLES 100000

static inline uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

// Packet format: 8-byte timestamp | payload
#define PKT_HDR_SIZE  (14 + 20 + 8)  // Ethernet + IP + UDP
#define TS_OFFSET      PKT_HDR_SIZE

int measure_latency(struct xdp_sock_info *tx_sock, struct xdp_sock_info *rx_sock) {
    uint64_t latencies[NUM_SAMPLES];
    uint8_t pkt[256] = {0};

    // Fill Ethernet/IP/UDP headers (omitted for brevity)
    // ...

    for (int i = 0; i < NUM_SAMPLES; i++) {
        uint64_t send_time = now_ns();

        // Write timestamp into packet
        memcpy(pkt + TS_OFFSET, &send_time, sizeof(send_time));

        // Transmit
        xdp_transmit(tx_sock, pkt, sizeof(pkt));
        xdp_flush_tx(tx_sock);

        // Wait for echoed packet on RX
        // ... (poll rx_sock, read back timestamp from pkt)
        uint64_t recv_time = now_ns();
        latencies[i] = recv_time - send_time;
    }

    // Calculate percentiles
    // Sort latencies
    for (int i = 0; i < NUM_SAMPLES - 1; i++) {
        for (int j = i + 1; j < NUM_SAMPLES; j++) {
            if (latencies[j] < latencies[i]) {
                uint64_t tmp = latencies[i];
                latencies[i] = latencies[j];
                latencies[j] = tmp;
            }
        }
    }

    printf("Latency (ns):\n");
    printf("  p50:  %lu\n", latencies[NUM_SAMPLES/2]);
    printf("  p99:  %lu\n", latencies[NUM_SAMPLES * 99/100]);
    printf("  p999: %lu\n", latencies[NUM_SAMPLES * 999/1000]);
    printf("  max:  %lu\n", latencies[NUM_SAMPLES-1]);

    return 0;
}
```

## Section 9: AF_XDP in Go

```go
// go/afxdp/socket.go
// Using the gopacket/afxdp or cilium/ebpf libraries

package afxdp

import (
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/pkg/errors"
)

// GoXDPSocket provides a Go-friendly wrapper around AF_XDP
// In production, use a mature library like github.com/asavie/xdp
type GoXDPSocket struct {
	iface   *net.Interface
	queueID int
	stats   XDPStats
	mu      sync.Mutex
	closed  int32
}

type XDPStats struct {
	RxPackets   uint64
	RxBytes     uint64
	TxPackets   uint64
	TxBytes     uint64
	RxDropped   uint64
}

// PacketHandler is called for each received packet
type PacketHandler func(data []byte) error

// Option configures an XDP socket
type Option func(*config)

type config struct {
	zeroCopy  bool
	batchSize int
	queueSize int
}

func WithZeroCopy() Option {
	return func(c *config) { c.zeroCopy = true }
}

func WithBatchSize(n int) Option {
	return func(c *config) { c.batchSize = n }
}

// Stats returns current socket statistics
func (s *GoXDPSocket) Stats() XDPStats {
	return XDPStats{
		RxPackets: atomic.LoadUint64(&s.stats.RxPackets),
		RxBytes:   atomic.LoadUint64(&s.stats.RxBytes),
		TxPackets: atomic.LoadUint64(&s.stats.TxPackets),
		TxBytes:   atomic.LoadUint64(&s.stats.TxBytes),
		RxDropped: atomic.LoadUint64(&s.stats.RxDropped),
	}
}

// Throughput returns packets per second based on 1-second sample
func (s *GoXDPSocket) MeasureThroughput(duration time.Duration) (float64, error) {
	before := s.Stats()
	time.Sleep(duration)
	after := s.Stats()

	elapsed := duration.Seconds()
	pps := float64(after.RxPackets-before.RxPackets) / elapsed
	return pps, nil
}
```

## Section 10: Production Considerations

### NIC Configuration for AF_XDP

```bash
# Set NIC to use a fixed number of queues (matching worker threads)
ethtool -L eth0 combined 4

# Disable NIC features that interfere with XDP
ethtool -K eth0 gro off gso off tso off

# Enable XDP-compatible XPS (transmit packet steering)
echo 1 > /sys/class/net/eth0/queues/tx-0/xps_cpus
echo 2 > /sys/class/net/eth0/queues/tx-1/xps_cpus

# Pin IRQs to CPUs matching queue assignments
# Read IRQ numbers
cat /proc/interrupts | grep eth0

# Pin IRQ 64 (queue 0) to CPU 0
echo 1 > /proc/irq/64/smp_affinity
echo 2 > /proc/irq/65/smp_affinity  # queue 1 -> CPU 1

# Isolate CPUs from OS scheduler (optional for maximum performance)
# Add to kernel cmdline: isolcpus=0-3 nohz_full=0-3 rcu_nocbs=0-3
```

### Memory and NUMA Setup

```bash
# Allocate huge pages for UMEM on the correct NUMA node
echo 1024 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages

# Pin AF_XDP application to the NUMA node with the NIC
numactl --cpunodebind=0 --membind=0 ./af_xdp_app -i eth0 -q 0-3

# Verify NUMA placement of NIC
cat /sys/class/net/eth0/device/numa_node
```

### Monitoring AF_XDP Sockets

```bash
# Check AF_XDP socket statistics
cat /proc/net/xdp_diag  # available in kernel 5.15+

# Use ss to list AF_XDP sockets
ss -s | grep xdp

# Monitor via bpftool
bpftool map list | grep xskmap
bpftool prog list | grep xdp

# Check XDP statistics via ethtool
ethtool -S eth0 | grep -E "rx_xdp|tx_xdp"
# rx_xdp_redirect: 14882943
# rx_xdp_redirect_fail: 0
# rx_xdp_tx: 0
# rx_xdp_drop: 0
```

### Comparison Table

```
AF_XDP vs Alternatives:

Feature              | Kernel Socket | AF_XDP Copy | AF_XDP ZeroCopy | DPDK
---------------------|---------------|-------------|-----------------|-----
Throughput (10G)     | 1-2 Mpps      | 10-12 Mpps  | 14.88 Mpps      | 14.88 Mpps
Latency (p99)        | 10-100 us     | 2-5 us      | 1-3 us          | 0.5-2 us
CPU Usage            | High          | Medium      | Low             | Very Low
Kernel bypass        | No            | Partial     | Partial         | Full
Selective redirect   | No            | Yes         | Yes             | No
Standard APIs        | Yes           | Partial     | Partial         | No
Root required        | No            | Yes         | Yes             | Yes
Driver requirements  | Any           | Any         | Specific        | DPDK PMD
NIC sharing          | Yes           | Yes         | Yes             | No
```
