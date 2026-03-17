---
title: "Linux DPDK: Kernel Bypass Networking for High-Performance Applications"
date: 2029-07-25T00:00:00-05:00
draft: false
tags: ["Linux", "DPDK", "Networking", "Performance", "NFV", "Kernel Bypass", "Telco"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to DPDK architecture, poll mode drivers, memory pool management, ring buffers, performance benchmarks comparing DPDK against kernel networking, and enterprise use cases in NFV and telco environments."
more_link: "yes"
url: "/linux-dpdk-kernel-bypass-networking/"
---

The Data Plane Development Kit (DPDK) is a set of libraries and drivers that enable userspace applications to send and receive network packets without going through the Linux kernel network stack. By bypassing the kernel entirely, DPDK applications can achieve wire-rate packet processing on 10G, 25G, 100G, and 400G NICs using a single CPU core. DPDK powers the fast path in commercial NFV (Network Function Virtualization) products, telecom packet cores, software load balancers, and high-frequency trading platforms. This guide covers DPDK architecture, essential APIs, production deployment, and performance optimization.

<!--more-->

# Linux DPDK: Kernel Bypass Networking for High-Performance Applications

## Section 1: Why DPDK?

The Linux kernel network stack was designed for versatility, not raw throughput. Every packet traverses:
1. NIC interrupt
2. Driver interrupt handler
3. Softirq / NAPI poll
4. sk_buff allocation and fill
5. Protocol stack (Ethernet → IP → TCP/UDP)
6. Socket buffer copy to userspace

At 10 Gbps with 64-byte packets, this means approximately 14.88 million packets per second. Each packet through the kernel stack requires ~500-1000 CPU cycles. A single core can sustain roughly 1-2 Mpps through the kernel stack.

DPDK eliminates this overhead through:
- **Poll Mode Drivers (PMD)**: busy-poll the NIC instead of using interrupts
- **Huge Pages**: NIC DMA directly into TLB-pinned memory (zero kernel page table overhead)
- **Per-CPU Memory Pools**: NUMA-aware, lock-free memory allocation per core
- **Lock-Free Ring Buffers**: multi-producer/multi-consumer rings without locks
- **CPU Affinity**: dedicated cores that never sleep, never yield to OS scheduler

Result: a single DPDK core can sustain 14.88 Mpps on 10G with 64-byte packets — 7-15x the kernel path.

## Section 2: DPDK Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    DPDK Application                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  EAL          │  │  mbuf Pool   │  │  Ring Buffer         │  │
│  │  (init,       │  │  (packet     │  │  (queue between      │  │
│  │   lcore mgmt, │  │   memory)    │  │   lcores)            │  │
│  │   huge pages) │  │              │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           Poll Mode Driver (PMD)                          │   │
│  │  rte_eth_rx_burst() ─── rte_eth_tx_burst()               │   │
│  └──────────────────────────┬────────────────────────────┘   │
└────────────────────────────┼────────────────────────────────┘
                             │ Direct NIC access (UIO/VFIO)
                             ▼
                    ┌─────────────────┐
                    │  NIC (i40e,      │
                    │  mlx5, ixgbe)    │
                    │  DMA → huge pages│
                    └─────────────────┘
```

## Section 3: Environment Setup

### Hardware Requirements

```bash
# Check NIC support (DPDK-supported NICs)
# Full list: https://core.dpdk.org/supported/

# Intel: i40e (XL710), ice (E810), ixgbe (82599), igb (I350)
# Mellanox/NVIDIA: mlx5 (ConnectX-5/6/7)
# Broadcom: bnxt (BCM57508)
# Amazon: ena

# Check your NIC PCI address
lspci | grep -E "Ethernet|Network"
# 0000:00:08.0 Ethernet controller: Intel Corporation 82599ES 10-Gigabit SFI/SFP+

# Check IOMMU is enabled (required for VFIO)
dmesg | grep -E "IOMMU|iommu"
# DMAR: IOMMU enabled

# Enable IOMMU in kernel cmdline if not enabled
# GRUB: intel_iommu=on iommu=pt
grep GRUB_CMDLINE /etc/default/grub
```

### Installation

```bash
# Install DPDK from distribution packages
apt-get install -y dpdk dpdk-dev dpdk-doc libdpdk-dev

# Or build from source for latest version
DPDK_VERSION=23.11
wget https://fast.dpdk.org/rel/dpdk-${DPDK_VERSION}.tar.xz
tar xf dpdk-${DPDK_VERSION}.tar.xz
cd dpdk-${DPDK_VERSION}

# Build with meson/ninja
apt-get install -y python3-pyelftools libnuma-dev
meson setup build \
    -Denable_kmods=true \
    -Dkernel_dir=/lib/modules/$(uname -r)/build
ninja -C build
ninja -C build install
ldconfig

# Verify installation
dpdk-devbind.py --status
```

### Huge Pages and Memory Configuration

```bash
# Allocate 4 GB of 1GB huge pages for DPDK
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Or 2 MB pages (more flexible)
echo 2048 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Mount hugetlbfs for DPDK
mkdir -p /mnt/huge
mount -t hugetlbfs nodev /mnt/huge

# Persistent configuration
cat >> /etc/fstab << 'EOF'
nodev /mnt/huge hugetlbfs pagesize=1G 0 0
EOF

echo 'vm.nr_hugepages = 4' >> /etc/sysctl.d/99-dpdk.conf
sysctl -p /etc/sysctl.d/99-dpdk.conf

# For NUMA systems, allocate huge pages per node
echo 2 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
echo 2 > /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages
```

### NIC Binding

```bash
# Load required kernel modules
modprobe vfio-pci
modprobe uio_pci_generic  # Alternative to vfio (less secure)

# Get NIC PCI address
dpdk-devbind.py --status-dev net

# Detach NIC from kernel driver and bind to DPDK
# Method 1: VFIO (recommended, requires IOMMU)
dpdk-devbind.py --bind vfio-pci 0000:00:08.0

# Method 2: UIO (simpler, no IOMMU required)
dpdk-devbind.py --bind uio_pci_generic 0000:00:08.0

# Verify binding
dpdk-devbind.py --status
# 0000:00:08.0 '82599ES 10-Gigabit' drv=vfio-pci unused=ixgbe

# Unbind and restore to kernel driver
dpdk-devbind.py --bind ixgbe 0000:00:08.0
```

## Section 4: DPDK EAL Initialization

The Environment Abstraction Layer (EAL) is the foundation of every DPDK application.

```c
// dpdk_app.c — minimal DPDK application skeleton
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_mempool.h>
#include <rte_lcore.h>
#include <rte_ring.h>
#include <rte_cycles.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>

#define RX_RING_SIZE     1024
#define TX_RING_SIZE     1024
#define NUM_MBUFS        8191       // Should be (2^n - 1) for best performance
#define MBUF_CACHE_SIZE  250
#define BURST_SIZE       32         // Process packets in batches

static volatile bool force_quit = false;

static void signal_handler(int signum) {
    if (signum == SIGINT || signum == SIGTERM) {
        printf("\nSignal %d received — quitting\n", signum);
        force_quit = true;
    }
}

// Port configuration
static const struct rte_eth_conf port_conf = {
    .rxmode = {
        .mq_mode = RTE_ETH_MQ_RX_RSS,        // Enable RSS for multi-queue
        .offloads = RTE_ETH_RX_OFFLOAD_CHECKSUM,
    },
    .rx_adv_conf = {
        .rss_conf = {
            .rss_key = NULL,
            .rss_hf = RTE_ETH_RSS_IP | RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP,
        },
    },
    .txmode = {
        .mq_mode = RTE_ETH_MQ_TX_NONE,
        .offloads = RTE_ETH_TX_OFFLOAD_IPV4_CKSUM |
                    RTE_ETH_TX_OFFLOAD_UDP_CKSUM |
                    RTE_ETH_TX_OFFLOAD_TCP_CKSUM,
    },
};

int init_port(uint16_t port_id, struct rte_mempool *mbuf_pool) {
    struct rte_eth_dev_info dev_info;
    int ret;
    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;

    if (!rte_eth_dev_is_valid_port(port_id)) {
        fprintf(stderr, "Port %u is not valid\n", port_id);
        return -1;
    }

    ret = rte_eth_dev_info_get(port_id, &dev_info);
    if (ret) {
        fprintf(stderr, "rte_eth_dev_info_get: %s\n", rte_strerror(-ret));
        return ret;
    }

    printf("Initializing port %u: %s\n", port_id, dev_info.driver_name);

    // Configure the port
    struct rte_eth_conf local_conf = port_conf;
    if (dev_info.tx_offload_capa & RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE)
        local_conf.txmode.offloads |= RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE;

    ret = rte_eth_dev_configure(port_id, 1, 1, &local_conf);
    if (ret) {
        fprintf(stderr, "rte_eth_dev_configure: %s\n", rte_strerror(-ret));
        return ret;
    }

    // Adjust descriptor counts to hardware capabilities
    ret = rte_eth_dev_adjust_nb_rx_tx_desc(port_id, &nb_rxd, &nb_txd);
    if (ret) {
        fprintf(stderr, "rte_eth_dev_adjust_nb_rx_tx_desc: %s\n", rte_strerror(-ret));
        return ret;
    }

    // Setup RX queue
    struct rte_eth_rxconf rxconf = dev_info.default_rxconf;
    rxconf.offloads = local_conf.rxmode.offloads;
    ret = rte_eth_rx_queue_setup(port_id, 0, nb_rxd,
                                  rte_eth_dev_socket_id(port_id),
                                  &rxconf, mbuf_pool);
    if (ret) {
        fprintf(stderr, "rte_eth_rx_queue_setup: %s\n", rte_strerror(-ret));
        return ret;
    }

    // Setup TX queue
    struct rte_eth_txconf txconf = dev_info.default_txconf;
    txconf.offloads = local_conf.txmode.offloads;
    ret = rte_eth_tx_queue_setup(port_id, 0, nb_txd,
                                  rte_eth_dev_socket_id(port_id),
                                  &txconf);
    if (ret) {
        fprintf(stderr, "rte_eth_tx_queue_setup: %s\n", rte_strerror(-ret));
        return ret;
    }

    // Start the port
    ret = rte_eth_dev_start(port_id);
    if (ret) {
        fprintf(stderr, "rte_eth_dev_start: %s\n", rte_strerror(-ret));
        return ret;
    }

    // Enable promiscuous mode for testing
    rte_eth_promiscuous_enable(port_id);

    printf("Port %u initialized: %u RX descriptors, %u TX descriptors\n",
           port_id, nb_rxd, nb_txd);
    return 0;
}

int main(int argc, char *argv[]) {
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Initialize EAL (parses --lcores, --socket-mem, -w port, etc.)
    int ret = rte_eal_init(argc, argv);
    if (ret < 0) {
        rte_exit(EXIT_FAILURE, "rte_eal_init: %s\n", rte_strerror(-ret));
    }
    argc -= ret;
    argv += ret;

    // Count available ports
    uint16_t nb_ports = rte_eth_dev_count_avail();
    printf("Available DPDK ports: %u\n", nb_ports);

    // Create mbuf pool (one per NUMA socket)
    struct rte_mempool *mbuf_pool = rte_pktmbuf_pool_create(
        "MBUF_POOL",
        NUM_MBUFS * nb_ports,
        MBUF_CACHE_SIZE,
        0,
        RTE_MBUF_DEFAULT_BUF_SIZE,
        rte_socket_id()
    );

    if (!mbuf_pool) {
        rte_exit(EXIT_FAILURE, "Cannot create mbuf pool: %s\n",
                 rte_strerror(rte_errno));
    }

    // Initialize each port
    uint16_t port_id;
    RTE_ETH_FOREACH_DEV(port_id) {
        ret = init_port(port_id, mbuf_pool);
        if (ret) {
            rte_exit(EXIT_FAILURE, "Cannot init port %u\n", port_id);
        }
    }

    // Launch worker lcores
    // rte_eal_mp_remote_launch(lcore_main, NULL, CALL_MAIN);
    lcore_main(NULL);  // simplified single-core version

    // Cleanup
    RTE_ETH_FOREACH_DEV(port_id) {
        rte_eth_dev_stop(port_id);
        rte_eth_dev_close(port_id);
    }
    rte_eal_cleanup();
    return 0;
}
```

## Section 5: Packet Processing Loop

```c
// packet_loop.c — the hot path for packet receive and transmit

#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_ip.h>
#include <rte_udp.h>
#include <rte_ether.h>
#include <rte_cycles.h>

// Statistics structure (per-lcore)
struct lcore_stats {
    uint64_t rx_packets;
    uint64_t rx_bytes;
    uint64_t tx_packets;
    uint64_t tx_dropped;
    uint64_t pps_last;          // packets per second in last interval
    uint64_t last_tsc;          // TSC at last measurement
} __rte_cache_aligned;

static struct lcore_stats stats[RTE_MAX_LCORE];

// Process a single mbuf — example: loopback (swap src/dst MAC and retransmit)
static inline void process_mbuf(struct rte_mbuf *m) {
    struct rte_ether_hdr *eth = rte_pktmbuf_mtod(m, struct rte_ether_hdr *);

    // Swap source and destination MAC addresses (loopback)
    struct rte_ether_addr tmp;
    rte_ether_addr_copy(&eth->src_addr, &tmp);
    rte_ether_addr_copy(&eth->dst_addr, &eth->src_addr);
    rte_ether_addr_copy(&tmp, &eth->dst_addr);
}

// Hot path: receive and transmit loop
static int lcore_main(__rte_unused void *arg) {
    uint16_t port;
    uint32_t lcore_id = rte_lcore_id();

    printf("lcore %u: starting receive loop\n", lcore_id);

    RTE_ETH_FOREACH_DEV(port) {
        if (rte_eth_dev_socket_id(port) >= 0 &&
            rte_eth_dev_socket_id(port) != (int)rte_socket_id()) {
            printf("WARNING: lcore %u is on socket %u but port %u is on socket %d\n",
                   lcore_id, rte_socket_id(), port, rte_eth_dev_socket_id(port));
            printf("Performance may be impacted due to cross-socket traffic\n");
        }
    }

    struct rte_mbuf *rx_mbufs[BURST_SIZE];
    uint64_t last_tsc = rte_rdtsc();

    while (!force_quit) {
        // Receive burst from each port
        RTE_ETH_FOREACH_DEV(port) {
            // rx_burst: polls the NIC RX descriptor ring
            // Returns number of packets received (0 if no packets ready)
            uint16_t nb_rx = rte_eth_rx_burst(port, 0, rx_mbufs, BURST_SIZE);
            if (unlikely(nb_rx == 0))
                continue;

            stats[lcore_id].rx_packets += nb_rx;

            for (uint16_t i = 0; i < nb_rx; i++) {
                struct rte_mbuf *m = rx_mbufs[i];
                stats[lcore_id].rx_bytes += rte_pktmbuf_pkt_len(m);
                process_mbuf(m);
            }

            // Transmit processed packets
            uint16_t nb_tx = rte_eth_tx_burst(port ^ 1, 0, rx_mbufs, nb_rx);
            stats[lcore_id].tx_packets += nb_tx;

            // Free any packets that couldn't be transmitted
            if (unlikely(nb_tx < nb_rx)) {
                stats[lcore_id].tx_dropped += nb_rx - nb_tx;
                for (uint16_t i = nb_tx; i < nb_rx; i++) {
                    rte_pktmbuf_free(rx_mbufs[i]);
                }
            }
        }

        // Print stats every second
        uint64_t now_tsc = rte_rdtsc();
        if (now_tsc - last_tsc > rte_get_tsc_hz()) {
            double elapsed = (double)(now_tsc - last_tsc) / rte_get_tsc_hz();
            double pps = (stats[lcore_id].rx_packets - stats[lcore_id].pps_last) / elapsed;
            printf("lcore %u: %.2f Mpps  RX=%lu TX=%lu DROP=%lu\n",
                   lcore_id, pps / 1e6,
                   stats[lcore_id].rx_packets,
                   stats[lcore_id].tx_packets,
                   stats[lcore_id].tx_dropped);
            stats[lcore_id].pps_last = stats[lcore_id].rx_packets;
            last_tsc = now_tsc;
        }
    }

    return 0;
}
```

## Section 6: Memory Pool (rte_mempool)

```c
// mempool_demo.c — understanding DPDK memory pools

#include <rte_mempool.h>
#include <rte_mbuf.h>
#include <rte_malloc.h>

// Memory pool design principles:
//
// 1. Per-NUMA-node pools: minimize cross-socket memory access
// 2. Per-core local cache: reduce contention on pool operations
// 3. Huge page backing: NIC can DMA directly, TLB friendly
// 4. Fixed-size objects: no fragmentation, O(1) alloc/free

#define POOL_SIZE       65535  // Must be 2^n - 1
#define CACHE_SIZE      512    // Per-core cache size
#define PRIV_DATA_SIZE  0      // Private data per mbuf

void setup_mempool_per_socket(struct rte_mempool **pools, int num_sockets) {
    for (int socket = 0; socket < num_sockets; socket++) {
        char pool_name[32];
        snprintf(pool_name, sizeof(pool_name), "mbuf_pool_%d", socket);

        pools[socket] = rte_pktmbuf_pool_create_by_ops(
            pool_name,
            POOL_SIZE,
            CACHE_SIZE,
            PRIV_DATA_SIZE,
            RTE_MBUF_DEFAULT_BUF_SIZE,
            socket,          // NUMA socket for allocation
            "ring_mp_mc"     // Multi-producer, multi-consumer ring
        );

        if (!pools[socket]) {
            rte_exit(EXIT_FAILURE, "Cannot create mbuf pool for socket %d: %s\n",
                     socket, rte_strerror(rte_errno));
        }

        printf("Created mbuf pool for socket %d: %u objects, %zu bytes each\n",
               socket, POOL_SIZE,
               rte_mempool_calc_obj_size(RTE_MBUF_DEFAULT_BUF_SIZE, 0, NULL));
    }
}

// Working with mbufs
void mbuf_operations_demo(struct rte_mempool *pool) {
    // Allocate single mbuf
    struct rte_mbuf *m = rte_pktmbuf_alloc(pool);
    if (!m) {
        printf("mbuf allocation failed (pool empty?)\n");
        return;
    }

    // Get pointer to packet data area
    char *data = rte_pktmbuf_mtod(m, char *);

    // Write packet data
    uint16_t len = 64;
    memset(data, 0xAB, len);
    rte_pktmbuf_pkt_len(m) = len;
    rte_pktmbuf_data_len(m) = len;

    // Append data (move data_len pointer)
    uint16_t extra = 8;
    char *extra_data = rte_pktmbuf_append(m, extra);
    if (extra_data) {
        memset(extra_data, 0xCD, extra);
    }

    // Check pool stats
    struct rte_mempool_info info;
    rte_mempool_ops_get_info(pool, &info);
    printf("Pool: %u available, %u in use\n",
           rte_mempool_avail_count(pool),
           rte_mempool_in_use_count(pool));

    // Free the mbuf
    rte_pktmbuf_free(m);

    // Bulk allocate for batch processing
    struct rte_mbuf *burst[BURST_SIZE];
    int nb = rte_pktmbuf_alloc_bulk(pool, burst, BURST_SIZE);
    if (nb == 0) {
        printf("Allocated %d mbufs in bulk\n", BURST_SIZE);
        // Free all at once
        for (int i = 0; i < BURST_SIZE; i++) {
            rte_pktmbuf_free(burst[i]);
        }
    }
}
```

## Section 7: Ring Buffers

```c
// ring_demo.c — DPDK lock-free ring buffers for inter-lcore communication

#include <rte_ring.h>
#include <rte_launch.h>
#include <rte_lcore.h>

#define RING_SIZE 4096

// Producer lcore: receives packets and enqueues to ring
static int producer_lcore(void *arg) {
    struct rte_ring *ring = (struct rte_ring *)arg;
    struct rte_mbuf *mbufs[BURST_SIZE];
    uint32_t lcore_id = rte_lcore_id();

    printf("Producer on lcore %u\n", lcore_id);

    while (!force_quit) {
        // Receive from NIC
        uint16_t nb_rx = rte_eth_rx_burst(0, 0, mbufs, BURST_SIZE);
        if (nb_rx == 0) continue;

        // Enqueue to ring (non-blocking: SP = single producer)
        unsigned int nb_enq = rte_ring_sp_enqueue_burst(
            ring, (void **)mbufs, nb_rx, NULL);

        // Free any packets that couldn't be enqueued (ring full)
        if (nb_enq < nb_rx) {
            for (uint16_t i = nb_enq; i < nb_rx; i++)
                rte_pktmbuf_free(mbufs[i]);
        }
    }
    return 0;
}

// Consumer lcore: dequeues from ring and processes packets
static int consumer_lcore(void *arg) {
    struct rte_ring *ring = (struct rte_ring *)arg;
    struct rte_mbuf *mbufs[BURST_SIZE];
    uint32_t lcore_id = rte_lcore_id();

    printf("Consumer on lcore %u\n", lcore_id);

    while (!force_quit) {
        // Dequeue from ring (SC = single consumer)
        unsigned int nb_deq = rte_ring_sc_dequeue_burst(
            ring, (void **)mbufs, BURST_SIZE, NULL);

        if (nb_deq == 0) continue;

        // Process packets
        for (uint16_t i = 0; i < nb_deq; i++) {
            // Example: IP lookup, NAT, firewall, etc.
            process_mbuf(mbufs[i]);
        }

        // Transmit
        uint16_t nb_tx = rte_eth_tx_burst(1, 0, mbufs, nb_deq);
        for (uint16_t i = nb_tx; i < nb_deq; i++)
            rte_pktmbuf_free(mbufs[i]);
    }
    return 0;
}

void setup_pipeline(void) {
    // Create a single-producer single-consumer ring
    struct rte_ring *ring = rte_ring_create(
        "packet_ring",
        RING_SIZE,
        rte_socket_id(),
        RING_F_SP_ENQ | RING_F_SC_DEQ  // SP/SC flags enable lock-free fast path
    );

    if (!ring) {
        rte_exit(EXIT_FAILURE, "Cannot create ring: %s\n",
                 rte_strerror(rte_errno));
    }

    // Launch producer on lcore 1, consumer on lcore 2
    unsigned int producer_lcore_id = 1;
    unsigned int consumer_lcore_id = 2;

    rte_eal_remote_launch(producer_lcore, ring, producer_lcore_id);
    rte_eal_remote_launch(consumer_lcore, ring, consumer_lcore_id);

    // Wait for both to complete
    rte_eal_wait_lcore(producer_lcore_id);
    rte_eal_wait_lcore(consumer_lcore_id);
}
```

## Section 8: Multi-Queue and RSS

```c
// multi_queue.c — RSS (Receive Side Scaling) for distributing packets across queues

#include <rte_ethdev.h>

#define NUM_QUEUES 4

// RSS configuration: distribute packets based on flow 5-tuple
static const uint8_t rss_key[40] = {
    0x6d, 0x5a, 0x56, 0xda, 0x25, 0x5b, 0x0e, 0xc2,
    0x41, 0x67, 0x25, 0x3d, 0x43, 0xa3, 0x8f, 0xb0,
    0xd0, 0xca, 0x2b, 0xcb, 0xae, 0x7b, 0x30, 0xb4,
    0x77, 0xcb, 0x2d, 0xa3, 0x80, 0x30, 0xf2, 0x0c,
    0x6a, 0x42, 0xb7, 0x3b, 0xbe, 0xac, 0x01, 0xfa,
};

int init_port_multi_queue(uint16_t port_id, struct rte_mempool *mbuf_pool) {
    struct rte_eth_dev_info dev_info;
    rte_eth_dev_info_get(port_id, &dev_info);

    struct rte_eth_conf port_conf = {
        .rxmode = {
            .mq_mode = RTE_ETH_MQ_RX_RSS,
        },
        .rx_adv_conf = {
            .rss_conf = {
                .rss_key     = (uint8_t *)rss_key,
                .rss_key_len = sizeof(rss_key),
                .rss_hf      = (RTE_ETH_RSS_IP | RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP) &
                               dev_info.flow_type_rss_offloads,
            },
        },
    };

    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;

    rte_eth_dev_configure(port_id, NUM_QUEUES, NUM_QUEUES, &port_conf);
    rte_eth_dev_adjust_nb_rx_tx_desc(port_id, &nb_rxd, &nb_txd);

    // Setup one RX and TX queue per lcore
    for (int q = 0; q < NUM_QUEUES; q++) {
        int socket = rte_eth_dev_socket_id(port_id);

        rte_eth_rx_queue_setup(port_id, q, nb_rxd, socket,
                               &dev_info.default_rxconf, mbuf_pool);
        rte_eth_tx_queue_setup(port_id, q, nb_txd, socket,
                               &dev_info.default_txconf);
    }

    rte_eth_dev_start(port_id);
    return 0;
}

// Each lcore handles its own queue
static int per_queue_lcore(void *arg) {
    uint32_t lcore_id = rte_lcore_id();
    uint16_t queue_id = (uint16_t)(lcore_id - 1);  // lcore 1→queue 0, lcore 2→queue 1
    uint16_t port_id  = 0;

    struct rte_mbuf *mbufs[BURST_SIZE];

    printf("lcore %u handling queue %u on port %u\n", lcore_id, queue_id, port_id);

    while (!force_quit) {
        uint16_t nb_rx = rte_eth_rx_burst(port_id, queue_id, mbufs, BURST_SIZE);
        if (nb_rx == 0) continue;

        // Each lcore handles packets for its own flow groups (RSS ensures locality)
        for (uint16_t i = 0; i < nb_rx; i++) {
            process_mbuf(mbufs[i]);
        }

        uint16_t nb_tx = rte_eth_tx_burst(port_id ^ 1, queue_id, mbufs, nb_rx);
        for (uint16_t i = nb_tx; i < nb_rx; i++)
            rte_pktmbuf_free(mbufs[i]);
    }
    return 0;
}
```

## Section 9: DPDK vs Kernel Networking Benchmarks

```bash
# Benchmark environment:
# Server: Dell R650, 2x Intel Xeon Gold 6338 (32 cores each)
# NIC: Intel E810 25GbE (ice driver)
# DPDK version: 23.11
# Linux: 6.6 LTS

# Test 1: Baseline kernel networking throughput (iperf3)
# Server
iperf3 -s -B 192.168.1.1

# Client
iperf3 -c 192.168.1.1 -t 60 -P 16 -Z

# Results: ~9.5 Gbps on 10G NIC (87% of line rate)
# CPU usage: 100% softirq on both cores
# Packets/sec: ~2.1 Mpps (64-byte)

# Test 2: DPDK l3fwd (L3 forwarding sample)
./dpdk-l3fwd \
    -l 0-3 \
    -n 4 \
    --socket-mem=4096 \
    -- \
    -p 0x3 \
    --config="(0,0,0),(0,1,1),(1,0,2),(1,1,3)"

# Results: 14.88 Mpps on 10G NIC (100% line rate, 64-byte packets)
# CPU usage: ~95% busy-polling (no interrupts)
# Latency: 0.8 - 1.2 microseconds p99

# Test 3: DPDK vs AF_XDP for medium packet sizes (512 bytes)
# DPDK:   ~5.2 Mpps per core  (~2.6 Gbps per core, scales linearly)
# AF_XDP: ~4.1 Mpps per core  (copy mode)
# Kernel: ~1.8 Mpps per core

# Summary table:
# Packet Size | Kernel (pps) | AF_XDP (Mpps) | DPDK (Mpps)
# 64 bytes    | 2.1          | 12            | 14.88
# 256 bytes   | 2.0          | 10            | 12.5
# 512 bytes   | 1.8          | 4.1           | 5.2
# 1024 bytes  | 1.5          | 2.2           | 2.8
# 1500 bytes  | 1.2          | 1.7           | 2.1
```

## Section 10: NFV Use Cases

### Virtual Network Function Architecture

```
NFV Fast Path with DPDK:

Internet ──> vRouter ──> Firewall VNF ──> LB VNF ──> App

Each VNF:
  - Runs in DPDK container/VM
  - Uses SR-IOV VF or vhost-user for NIC access
  - Processes packets in dedicated CPU cores
  - Uses DPDK rings to pass packets between VNFs

Performance: 10-40 Gbps per VNF instance with 2-4 cores
vs. iptables-based solution: 1-2 Gbps max
```

```bash
# DPDK with vhost-user for VM connectivity (QEMU/KVM)
# vhost-user uses shared memory rings between DPDK host and VM guest

# Start DPDK vhost application
./dpdk-vhost-switch \
    --socket-mem=1024 \
    -l 0-1 \
    -- \
    --socket-file /tmp/vhost-user-1.sock

# QEMU commandline for VM with vhost-user
qemu-system-x86_64 \
    -enable-kvm \
    -cpu host \
    -smp 4 \
    -m 8G \
    -mem-path /dev/hugepages \
    -mem-prealloc \
    -netdev type=vhost-user,id=mynet1,\
            chardev=char1,vhostforce,queues=4 \
    -chardev socket,id=char1,path=/tmp/vhost-user-1.sock \
    -device virtio-net-pci,netdev=mynet1,\
            mq=on,vectors=10

# Inside VM: use DPDK with virtio PMD for near-native performance
./dpdk-testpmd \
    -l 0-3 \
    -- \
    -i \
    --nb-cores=3 \
    --rxq=3 --txq=3 \
    --forward-mode=io
```

### DPDK in Kubernetes (SR-IOV)

```yaml
# SRIOV device plugin for DPDK NICs in Kubernetes
apiVersion: v1
kind: Pod
metadata:
  name: dpdk-app
  annotations:
    k8s.v1.cni.cncf.io/networks: sriov-net
spec:
  containers:
  - name: dpdk-container
    image: dpdk-app:latest
    securityContext:
      privileged: true
    resources:
      limits:
        cpu: "4"
        memory: "4Gi"
        hugepages-1Gi: "2Gi"
        intel.com/intel_sriov_dpdk: "1"  # 1 SR-IOV VF
      requests:
        cpu: "4"
        memory: "4Gi"
        hugepages-1Gi: "2Gi"
        intel.com/intel_sriov_dpdk: "1"
    volumeMounts:
    - name: hugepage
      mountPath: /dev/hugepages
    - name: dev
      mountPath: /dev
    env:
    - name: DPDK_NUM_QUEUES
      value: "4"
  volumes:
  - name: hugepage
    emptyDir:
      medium: HugePages-1Gi
  - name: dev
    hostPath:
      path: /dev
```

## Section 11: DPDK Telco Use Cases

DPDK is foundational in telco 5G infrastructure:

```
5G User Plane (N3/N6 interface):
  ┌─────────────────────────────────────────────────────┐
  │                  UPF (User Plane Function)          │
  │                                                      │
  │  GTP-U tunnel  →  DPDK fast path  →  IP routing    │
  │                   (packet decode,     (to internet) │
  │                    QoS marking,                     │
  │                    charging)                        │
  │                                                      │
  │  Performance: 50-100 Gbps per server               │
  │  CPU: 8-16 DPDK cores for 50 Gbps                  │
  └─────────────────────────────────────────────────────┘

DU (Distributed Unit) eCPRI fronthaul:
  ┌─────────────────────────────────────────────────────┐
  │  DPDK processes eCPRI/RoE (Radio over Ethernet)    │
  │  Timing: requires hardware timestamping (PTP)       │
  │  Latency: <100 microseconds end-to-end              │
  └─────────────────────────────────────────────────────┘
```

## Section 12: DPDK Tuning and Production Checklist

```bash
# CPU isolation for DPDK lcores (add to kernel cmdline)
# isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7

# Disable CPU frequency scaling on DPDK cores
for cpu in 2 3 4 5 6 7; do
    cpupower -c $cpu frequency-set -g performance
    echo performance > /sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor
done

# Disable C-states (prevents CPU wakeup latency)
for cpu in 2 3 4 5 6 7; do
    # Disable all C-states deeper than C1
    cpupower -c $cpu idle-set -d 2
done

# Set IRQ affinity: keep NIC interrupts away from DPDK cores
# Assign NIC interrupt to CPU 0 (management core)
NIC_IRQ=$(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':')
echo 1 > /proc/irq/${NIC_IRQ}/smp_affinity  # CPU 0 only

# Monitor DPDK application
dpdk-pdump --help
dpdk-proc-info --stats  # View per-queue stats from running DPDK app

# DPDK log levels
export RTE_LOG_LEVEL=7  # Debug level
```

```
DPDK Production Checklist:

Hardware:
  [ ] NIC on DPDK supported list
  [ ] IOMMU enabled in BIOS + kernel
  [ ] SR-IOV enabled if using VFs
  [ ] CPU supports DDIO (Direct Data I/O) for DMA into L3 cache

OS Configuration:
  [ ] Huge pages allocated at boot (not on-demand)
  [ ] DPDK cores isolated (isolcpus)
  [ ] C-states disabled on DPDK cores
  [ ] CPU frequency scaling set to performance
  [ ] NIC IRQs moved to non-DPDK cores
  [ ] NUMA-aware huge page allocation

Application:
  [ ] mbuf pool sized to avoid pool exhaustion (check with rte_mempool_avail_count)
  [ ] BURST_SIZE tuned for workload (32-64 typical)
  [ ] RSS configured to distribute flows evenly
  [ ] TX burst flush timer to avoid TX ring stall
  [ ] Per-lcore stats collection

Monitoring:
  [ ] Packet drop counters exposed (rte_eth_stats_get)
  [ ] mbuf pool utilization tracked
  [ ] CPU cycles per packet measured (rdtsc)
  [ ] p99 latency measured under load
```
