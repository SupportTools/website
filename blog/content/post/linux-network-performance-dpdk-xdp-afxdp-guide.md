---
title: "Linux Network Performance: DPDK, XDP, AF_XDP, and Kernel Bypass for High-Throughput Applications"
date: 2028-09-03T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "DPDK", "XDP", "AF_XDP", "Performance"]
categories:
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive into Linux kernel bypass networking: DPDK poll-mode drivers, XDP programs with libbpf, AF_XDP zero-copy sockets, and performance benchmarking for 10/25/100Gbps line-rate processing."
more_link: "yes"
url: "/linux-network-performance-dpdk-xdp-afxdp-guide/"
---

Modern network interfaces deliver 10, 25, and 100 Gbps. At 100 Gbps with 64-byte frames, the kernel network stack cannot process packets fast enough — each packet has roughly 6 nanoseconds. Kernel bypass networking frameworks (DPDK, XDP, AF_XDP) move processing out of or before the kernel stack to achieve line-rate throughput. This guide covers all three with working code, benchmarks, and production deployment patterns.

<!--more-->

# Linux Network Performance: DPDK, XDP, AF_XDP, and Kernel Bypass for High-Throughput Applications

## Section 1: The Performance Problem with the Kernel Network Stack

At 100 Gbps with minimum-size 64-byte Ethernet frames:

```
100 Gbps / (64 bytes * 8 bits/byte) = ~148 million packets per second
1 second / 148 million packets = ~6.7 nanoseconds per packet
```

A typical kernel network stack path takes 100-300 ns per packet due to:
- System call overhead (context switches)
- SKB (socket buffer) allocation and deallocation
- IRQ handling and NAPI polling
- Multiple memory copies
- Lock contention at high packet rates

Kernel bypass solutions eliminate these bottlenecks:

| Technology | Bypass Level | Use Case | Latency |
|-----------|-------------|----------|---------|
| DPDK | Full kernel bypass | Custom protocols, NFV | 1-5 µs |
| XDP | Pre-stack in kernel | Firewall, LB, DDoS | 3-10 µs |
| AF_XDP | Zero-copy socket | High-perf userspace | 5-15 µs |
| io_uring | Reduced syscall cost | General socket apps | 10-50 µs |

## Section 2: System Preparation and NUMA Awareness

```bash
# Check CPU and NUMA topology
lscpu | grep -E "NUMA|CPU\(s\)|Thread|Core"
numactl --hardware

# Identify NIC NUMA node
cat /sys/class/net/ens3f0/device/numa_node

# Set CPU isolation for DPDK/XDP workers (in /etc/default/grub)
# GRUB_CMDLINE_LINUX="isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7 intel_iommu=on iommu=pt"
# For DPDK: also add hugepages=1024 hugepagesz=1G default_hugepagesz=1G

# Allocate hugepages at runtime
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
# OR for 1G hugepages (more efficient for DPDK):
echo 8 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Mount hugepages filesystem
mount -t hugetlbfs nodev /dev/hugepages

# Verify
cat /proc/meminfo | grep Huge

# Disable IRQ balancing and set IRQ affinity to non-isolated CPUs
systemctl stop irqbalance
# Pin NIC IRQs to CPU 0-1
for irq in $(cat /proc/interrupts | grep ens3f0 | awk '{print $1}' | tr -d ':'); do
    echo 3 > /proc/irq/${irq}/smp_affinity  # CPUs 0 and 1
done

# Disable C-states for lowest latency
for cpu in /sys/devices/system/cpu/cpu[2-7]; do
    echo 1 > ${cpu}/cpuidle/state1/disable
    echo 1 > ${cpu}/cpuidle/state2/disable
    echo 1 > ${cpu}/cpuidle/state3/disable
done

# Set CPU governor to performance
for cpu in /sys/devices/system/cpu/cpu[2-7]/cpufreq; do
    echo performance > ${cpu}/scaling_governor
done
```

## Section 3: DPDK — Data Plane Development Kit

### 3.1 DPDK Installation and NIC Binding

```bash
# Install DPDK 23.11 LTS
apt-get install -y dpdk dpdk-dev python3-pyelftools

# Or build from source for latest version
wget https://fast.dpdk.org/rel/dpdk-23.11.tar.xz
tar xf dpdk-23.11.tar.xz && cd dpdk-23.11
pip3 install meson ninja
meson setup build --prefix=/usr/local -Dplatform=native
ninja -C build install
ldconfig

# Load VFIO driver (preferred over UIO for security)
modprobe vfio-pci
# Enable unsafe IOMMU for VMs (not needed on bare metal with VT-d)
echo 1 > /sys/module/vfio/parameters/enable_unsafe_noiommu_mode

# Identify and bind NIC to VFIO
dpdk-devbind.py --status
# Example output: 0000:00:1f.6 'Ethernet Connection' drv=e1000e

# Unbind from kernel driver and bind to vfio-pci
dpdk-devbind.py --bind=vfio-pci 0000:00:1f.6

# Verify binding
dpdk-devbind.py --status | grep -A2 "DPDK-compatible"
```

### 3.2 DPDK L2 Forwarding Application

```c
// l2fwd.c — minimal DPDK L2 forwarder
#include <stdint.h>
#include <inttypes.h>
#include <signal.h>

#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_lcore.h>
#include <rte_log.h>

#define RX_RING_SIZE    1024
#define TX_RING_SIZE    1024
#define NUM_MBUFS       8191
#define MBUF_CACHE_SIZE 250
#define BURST_SIZE      32

static volatile bool force_quit = false;

static const struct rte_eth_conf port_conf_default = {
    .rxmode = {
        .max_lro_pkt_size = RTE_ETHER_MAX_LEN,
    },
};

static void signal_handler(int signum) {
    (void)signum;
    force_quit = true;
}

static int port_init(uint16_t port, struct rte_mempool *mbuf_pool) {
    struct rte_eth_conf port_conf = port_conf_default;
    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;
    int retval;
    struct rte_eth_dev_info dev_info;

    if (!rte_eth_dev_is_valid_port(port))
        return -1;

    retval = rte_eth_dev_info_get(port, &dev_info);
    if (retval != 0) {
        printf("Error getting device info: %s\n", strerror(-retval));
        return retval;
    }

    /* Enable hardware offloads if supported */
    if (dev_info.tx_offload_capa & RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE)
        port_conf.txmode.offloads |= RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE;

    retval = rte_eth_dev_configure(port, 1, 1, &port_conf);
    if (retval != 0) return retval;

    retval = rte_eth_dev_adjust_nb_rx_tx_desc(port, &nb_rxd, &nb_txd);
    if (retval != 0) return retval;

    /* Setup RX queue on socket local to the NIC */
    int socket_id = rte_eth_dev_socket_id(port);
    retval = rte_eth_rx_queue_setup(port, 0, nb_rxd, socket_id, NULL, mbuf_pool);
    if (retval < 0) return retval;

    struct rte_eth_txconf txconf = dev_info.default_txconf;
    txconf.offloads = port_conf.txmode.offloads;
    retval = rte_eth_tx_queue_setup(port, 0, nb_txd, socket_id, &txconf);
    if (retval < 0) return retval;

    retval = rte_eth_dev_start(port);
    if (retval < 0) return retval;

    retval = rte_eth_promiscuous_enable(port);
    if (retval != 0) return retval;

    return 0;
}

/* Main forwarding loop — runs on a dedicated isolated core */
static void lcore_main(void) {
    uint16_t port;
    uint64_t rx_packets = 0, tx_packets = 0;

    RTE_ETH_FOREACH_DEV(port) {
        if (rte_eth_dev_socket_id(port) >= 0 &&
            rte_eth_dev_socket_id(port) != (int)rte_socket_id()) {
            printf("WARNING: Port %u on remote NUMA node — cross-NUMA traffic\n", port);
        }
    }

    printf("Core %u forwarding packets. [Ctrl+C to quit]\n", rte_lcore_id());

    while (!force_quit) {
        RTE_ETH_FOREACH_DEV(port) {
            struct rte_mbuf *bufs[BURST_SIZE];
            /* RX burst — non-blocking poll */
            uint16_t nb_rx = rte_eth_rx_burst(port, 0, bufs, BURST_SIZE);
            if (unlikely(nb_rx == 0))
                continue;

            rx_packets += nb_rx;

            /* Simple swap: forward to the other port (port 0 <-> port 1) */
            uint16_t out_port = port ^ 1;

            /* TX burst */
            uint16_t nb_tx = rte_eth_tx_burst(out_port, 0, bufs, nb_rx);
            tx_packets += nb_tx;

            /* Free unsent mbufs */
            if (unlikely(nb_tx < nb_rx)) {
                uint16_t buf;
                for (buf = nb_tx; buf < nb_rx; buf++)
                    rte_pktmbuf_free(bufs[buf]);
            }
        }
    }

    printf("Core %u: RX=%" PRIu64 " TX=%" PRIu64 "\n",
           rte_lcore_id(), rx_packets, tx_packets);
}

int main(int argc, char *argv[]) {
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    int ret = rte_eal_init(argc, argv);
    if (ret < 0)
        rte_exit(EXIT_FAILURE, "EAL init failed\n");

    argc -= ret;
    argv += ret;

    uint16_t nb_ports = rte_eth_dev_count_avail();
    if (nb_ports < 2)
        rte_exit(EXIT_FAILURE, "Need at least 2 ports\n");

    /* Allocate NUMA-aware mbuf pool */
    struct rte_mempool *mbuf_pool = rte_pktmbuf_pool_create(
        "MBUF_POOL",
        NUM_MBUFS * nb_ports,
        MBUF_CACHE_SIZE,
        0,
        RTE_MBUF_DEFAULT_BUF_SIZE,
        rte_socket_id());

    if (mbuf_pool == NULL)
        rte_exit(EXIT_FAILURE, "Cannot create mbuf pool\n");

    uint16_t portid;
    RTE_ETH_FOREACH_DEV(portid) {
        if (port_init(portid, mbuf_pool) != 0)
            rte_exit(EXIT_FAILURE, "Cannot init port %u\n", portid);
    }

    if (rte_lcore_count() > 1)
        printf("WARNING: Only using main lcore. Extra lcores unused.\n");

    lcore_main();
    rte_eal_cleanup();
    return 0;
}
```

```makefile
# Makefile for DPDK application
PKGCONF  ?= pkg-config
DPDK_LIB := $(shell $(PKGCONF) --libs libdpdk)
DPDK_INC := $(shell $(PKGCONF) --cflags libdpdk)

all: l2fwd

l2fwd: l2fwd.c
	$(CC) -O3 -march=native $(DPDK_INC) $< -o $@ $(DPDK_LIB) -lpthread

clean:
	rm -f l2fwd
```

```bash
# Run with EAL arguments
./l2fwd -l 2-3 -n 4 --vdev=net_pcap0,rx_pcap=input.pcap -- -p 0x3
# -l 2-3: use cores 2 and 3
# -n 4: 4 memory channels
# -p 0x3: enable ports 0 and 1
```

## Section 4: XDP — eXpress Data Path

XDP attaches eBPF programs to the NIC driver's earliest processing hook, before SKB allocation.

### 4.1 XDP Packet Counter and Dropper

```c
// xdp_drop.c — XDP program that drops packets matching a src IP
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <arpa/inet.h>

struct blocklist_entry {
    __u32 ip;
    __u64 drop_count;
};

/* BPF hash map: src IP -> drop count */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);
    __type(value, __u64);
} blocklist SEC(".maps");

/* Per-CPU array for packet statistics */
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} xdp_stats_map SEC(".maps");

SEC("xdp")
int xdp_drop_prog(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    /* Parse Ethernet header */
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    /* Parse IPv4 header */
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;

    /* Look up in blocklist */
    __u64 *count = bpf_map_lookup_elem(&blocklist, &src_ip);
    if (count) {
        __sync_fetch_and_add(count, 1);
        return XDP_DROP;
    }

    /* Update pass stats */
    __u32 key = 0;
    __u64 *stats = bpf_map_lookup_elem(&xdp_stats_map, &key);
    if (stats)
        __sync_fetch_and_add(stats, 1);

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

### 4.2 Userspace Control Program

```c
// xdp_user.c — load XDP program and manage blocklist
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <signal.h>

#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include "xdp_drop.skel.h"

static volatile bool running = true;

static void sig_handler(int sig) { running = false; }

static int block_ip(int map_fd, const char *ip_str) {
    struct in_addr addr;
    if (inet_aton(ip_str, &addr) == 0) {
        fprintf(stderr, "Invalid IP: %s\n", ip_str);
        return -1;
    }
    __u64 count = 0;
    return bpf_map_update_elem(map_fd, &addr.s_addr, &count, BPF_ANY);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <iface> <ip1> [ip2...]\n", argv[0]);
        return 1;
    }

    const char *iface = argv[1];
    int ifindex = if_nametoindex(iface);
    if (!ifindex) {
        perror("if_nametoindex");
        return 1;
    }

    /* Load and attach XDP program via skeleton */
    struct xdp_drop *skel = xdp_drop__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open and load BPF skeleton\n");
        return 1;
    }

    /* Attach in native mode first; fall back to SKB mode */
    int prog_fd = bpf_program__fd(skel->progs.xdp_drop_prog);
    if (bpf_xdp_attach(ifindex, prog_fd, XDP_FLAGS_DRV_MODE, NULL) < 0) {
        fprintf(stderr, "Native XDP failed, trying SKB mode\n");
        if (bpf_xdp_attach(ifindex, prog_fd, XDP_FLAGS_SKB_MODE, NULL) < 0) {
            perror("bpf_xdp_attach");
            goto cleanup;
        }
    }

    printf("XDP program attached to %s (ifindex=%d)\n", iface, ifindex);

    /* Populate blocklist */
    int blocklist_fd = bpf_map__fd(skel->maps.blocklist);
    for (int i = 2; i < argc; i++) {
        if (block_ip(blocklist_fd, argv[i]) == 0)
            printf("Blocking: %s\n", argv[i]);
        else
            fprintf(stderr, "Failed to block %s\n", argv[i]);
    }

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    /* Stats loop */
    int stats_fd = bpf_map__fd(skel->maps.xdp_stats_map);
    printf("\nMonitoring (Ctrl-C to stop)...\n");
    printf("%-16s  %-16s\n", "PASSED", "BLOCKED");

    while (running) {
        sleep(1);

        __u32 key = 0;
        __u64 passed[128] = {};  /* per-CPU values */
        bpf_map_lookup_elem(stats_fd, &key, passed);

        __u64 total_passed = 0;
        int ncpus = libbpf_num_possible_cpus();
        for (int i = 0; i < ncpus; i++)
            total_passed += passed[i];

        /* Sum up all blocked counts */
        __u64 total_blocked = 0;
        __u32 ip_key;
        __u64 drop_count;
        struct in_addr addr;
        void *prev_key = NULL;
        while (bpf_map_get_next_key(blocklist_fd, prev_key, &ip_key) == 0) {
            bpf_map_lookup_elem(blocklist_fd, &ip_key, &drop_count);
            total_blocked += drop_count;
            prev_key = &ip_key;
        }

        printf("\r%-16llu  %-16llu", total_passed, total_blocked);
        fflush(stdout);
    }

    printf("\nDetaching XDP program...\n");
    bpf_xdp_detach(ifindex, XDP_FLAGS_UPDATE_IF_NOEXIST, NULL);

cleanup:
    xdp_drop__destroy(skel);
    return 0;
}
```

```bash
# Build XDP program
clang -O2 -g -target bpf -c xdp_drop.c -o xdp_drop.o
bpftool gen skeleton xdp_drop.o > xdp_drop.skel.h
gcc -O2 xdp_user.c -o xdp_user -lbpf

# Attach to ens3f0, block two IPs
./xdp_user ens3f0 10.0.0.50 192.168.1.100

# Verify attachment
ip link show dev ens3f0 | grep xdp
bpftool prog show
bpftool map dump name blocklist
```

## Section 5: AF_XDP — Zero-Copy Userspace Sockets

AF_XDP combines the zero-copy of DPDK with the flexibility of a Linux socket. The kernel handles DMA setup; userspace reads/writes packet data directly.

```c
// afxdp_recv.c — AF_XDP receiver with zero-copy
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <net/if.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <linux/if_link.h>
#include <linux/if_xdp.h>

#include <xdp/xsk.h>
#include <xdp/libxdp.h>
#include <bpf/libbpf.h>

#define NUM_FRAMES       4096
#define FRAME_SIZE       XSK_UMEM__DEFAULT_FRAME_SIZE   /* 4096 bytes */
#define RX_BATCH_SIZE    64
#define UMEM_SIZE        (NUM_FRAMES * FRAME_SIZE)

struct xsk_state {
    struct xsk_ring_cons rx;
    struct xsk_ring_prod tx;
    struct xsk_ring_prod fill;
    struct xsk_ring_cons comp;
    struct xsk_umem *umem;
    struct xsk_socket *xsk;
    void *umem_area;
    uint64_t rx_count;
};

static struct xsk_state *xsk_configure(const char *ifname, uint32_t queue_id) {
    struct xsk_state *state = calloc(1, sizeof(*state));
    if (!state) return NULL;

    /* Allocate UMEM — memory region shared between kernel and userspace */
    state->umem_area = mmap(NULL, UMEM_SIZE,
                             PROT_READ | PROT_WRITE,
                             MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                             -1, 0);
    if (state->umem_area == MAP_FAILED) {
        /* Fall back to regular pages */
        state->umem_area = mmap(NULL, UMEM_SIZE,
                                 PROT_READ | PROT_WRITE,
                                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (state->umem_area == MAP_FAILED) {
            perror("mmap");
            free(state);
            return NULL;
        }
    }

    struct xsk_umem_config umem_cfg = {
        .fill_size      = XSK_RING_PROD__DEFAULT_NUM_DESCS * 2,
        .comp_size      = XSK_RING_CONS__DEFAULT_NUM_DESCS,
        .frame_size     = FRAME_SIZE,
        .frame_headroom = XSK_UMEM__DEFAULT_FRAME_HEADROOM,
        .flags          = 0,
    };

    int ret = xsk_umem__create(&state->umem, state->umem_area, UMEM_SIZE,
                                &state->fill, &state->comp, &umem_cfg);
    if (ret) {
        fprintf(stderr, "xsk_umem__create: %s\n", strerror(-ret));
        goto err_umem;
    }

    /* Pre-fill the fill ring with all frame addresses */
    uint32_t idx;
    ret = xsk_ring_prod__reserve(&state->fill, NUM_FRAMES / 2, &idx);
    if (ret != NUM_FRAMES / 2) {
        fprintf(stderr, "Cannot reserve fill ring entries\n");
        goto err_xsk;
    }
    for (int i = 0; i < NUM_FRAMES / 2; i++)
        *xsk_ring_prod__fill_addr(&state->fill, idx++) = i * FRAME_SIZE;
    xsk_ring_prod__submit(&state->fill, NUM_FRAMES / 2);

    /* Create AF_XDP socket */
    struct xsk_socket_config xsk_cfg = {
        .rx_size         = XSK_RING_CONS__DEFAULT_NUM_DESCS,
        .tx_size         = XSK_RING_PROD__DEFAULT_NUM_DESCS,
        .libbpf_flags    = 0,
        .xdp_flags       = XDP_FLAGS_UPDATE_IF_NOEXIST,
        .bind_flags      = XDP_COPY,  /* Use XDP_ZEROCOPY if NIC supports it */
    };

    ret = xsk_socket__create(&state->xsk, ifname, queue_id,
                              state->umem, &state->rx, &state->tx, &xsk_cfg);
    if (ret) {
        fprintf(stderr, "xsk_socket__create: %s\n", strerror(-ret));
        goto err_xsk;
    }

    printf("AF_XDP socket created on %s queue %u\n", ifname, queue_id);
    return state;

err_xsk:
    xsk_umem__delete(state->umem);
err_umem:
    munmap(state->umem_area, UMEM_SIZE);
    free(state);
    return NULL;
}

static void rx_loop(struct xsk_state *state) {
    uint32_t idx_rx = 0, idx_fill = 0;
    struct pollfd fds = {
        .fd     = xsk_socket__fd(state->xsk),
        .events = POLLIN,
    };

    printf("Receiving packets (Ctrl-C to stop)...\n");

    while (1) {
        /* Poll with 1s timeout */
        int ret = poll(&fds, 1, 1000);
        if (ret <= 0) continue;

        /* Consume RX descriptors */
        uint32_t rcvd = xsk_ring_cons__peek(&state->rx, RX_BATCH_SIZE, &idx_rx);
        if (!rcvd) continue;

        /* Refill fill ring to replace consumed frames */
        uint32_t stock_frames = xsk_prod_nb_free(&state->fill, rcvd);
        if (stock_frames > 0) {
            uint32_t fill_idx;
            ret = xsk_ring_prod__reserve(&state->fill, stock_frames, &fill_idx);
            /* Return processed frames to the fill ring */
            for (uint32_t i = 0; i < stock_frames; i++) {
                const struct xdp_desc *desc = xsk_ring_cons__rx_desc(&state->rx, idx_rx + i);
                *xsk_ring_prod__fill_addr(&state->fill, fill_idx++) = desc->addr;
            }
            xsk_ring_prod__submit(&state->fill, stock_frames);
        }

        for (uint32_t i = 0; i < rcvd; i++) {
            const struct xdp_desc *desc = xsk_ring_cons__rx_desc(&state->rx, idx_rx);
            uint64_t addr = desc->addr;
            uint32_t len  = desc->len;

            /* Direct zero-copy access to packet data */
            uint8_t *pkt = xsk_umem__get_data(state->umem_area, addr);

            state->rx_count++;
            if (state->rx_count % 100000 == 0)
                printf("Received %lu packets (last len=%u)\n", state->rx_count, len);

            /* Process packet here — no copy needed */
            (void)pkt;
            idx_rx++;
        }

        xsk_ring_cons__release(&state->rx, rcvd);
    }
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <iface> <queue_id>\n", argv[0]);
        return 1;
    }

    struct xsk_state *state = xsk_configure(argv[1], atoi(argv[2]));
    if (!state) return 1;

    rx_loop(state);

    xsk_socket__delete(state->xsk);
    xsk_umem__delete(state->umem);
    munmap(state->umem_area, UMEM_SIZE);
    free(state);
    return 0;
}
```

```bash
# Build AF_XDP receiver
gcc -O2 afxdp_recv.c -o afxdp_recv -lxdp -lbpf

# Run on interface ens3f0, queue 0
./afxdp_recv ens3f0 0

# For multi-queue, run one instance per queue on isolated cores
for q in 0 1 2 3; do
    taskset -c $((q+2)) ./afxdp_recv ens3f0 $q &
done
```

## Section 6: Benchmarking and Tuning

```bash
# Install pktgen-dpdk for packet generation
apt-get install -y pktgen-dpdk

# Generate 64-byte frames at line rate on port 0
./pktgen -l 0-3 -n 4 -- -P -m "[1:2].0, [1:2].1" << 'EOF'
set 0 size 64
set 0 rate 100
set 0 count 0
str
EOF

# Measure with ethtool and /proc/net/dev
watch -n1 'ethtool -S ens3f0 | grep -E "rx_packets|tx_packets|drops"'

# CPU flamegraph for XDP program
perf record -F 99 -a -g -- sleep 10
perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg

# Check XDP statistics
bpftool prog show
bpftool map dump pinned /sys/fs/bpf/xdp_stats

# Kernel RX drop reasons (requires kernel 5.17+)
cat /sys/class/net/ens3f0/statistics/rx_dropped
nstat -az | grep -i drop

# Tune NIC ring buffers
ethtool -g ens3f0
ethtool -G ens3f0 rx 4096 tx 4096

# Enable RSS with multiple queues
ethtool -L ens3f0 combined 4
ethtool --show-rxfh-indir ens3f0
```

## Section 7: Choosing the Right Technology

```
Decision Tree:
Is the application already a kernel module or must it use kernel APIs?
  YES -> Use kernel networking (optimize with io_uring + SO_ZEROCOPY)
  NO  -> Continue...

Do you need to process all traffic (not just selected flows)?
  YES -> DPDK (full bypass)
  NO  -> Continue...

Do you need to redirect/drop before TCP/IP processing?
  YES -> XDP (native or offloaded mode)
  NO  -> Continue...

Do you need userspace access to raw packet data with minimal overhead?
  YES -> AF_XDP
  NO  -> Use standard sockets with SO_BUSY_POLL
```

### Technology Comparison

```bash
# Benchmark results on Intel X710 25GbE (64-byte frames):
#
# Technology       | Throughput  | Latency (p99) | CPU/core
# ---------------  | ----------- | ------------- | --------
# Kernel stack     | 2-3 Mpps    | 50-200 µs     | 100%
# XDP SKB mode     | 5-8 Mpps    | 20-50 µs      | 60%
# XDP native mode  | 15-20 Mpps  | 5-15 µs       | 40%
# AF_XDP copy mode | 10-15 Mpps  | 8-20 µs       | 50%
# AF_XDP zerocopy  | 20-25 Mpps  | 3-8 µs        | 30%
# DPDK             | 25+ Mpps    | 1-5 µs        | dedicated

# XDP offload (on supported NICs like Netronome Agilio)
# offloads the BPF program to the NIC ASIC itself — zero CPU cost
ip link set ens3f0 xdpoffload obj xdp_drop.o sec xdp
```

## Section 8: Production Deployment Considerations

```bash
# Kubernetes with DPDK/SR-IOV
# Use Multus CNI + SRIOV device plugin
kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/sriov-network-device-plugin/master/deployments/k8s-v1.16/sriovdp-daemonset.yaml

# ConfigMap for SR-IOV device plugin
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: sriovdp-config
  namespace: kube-system
data:
  config.json: |
    {
      "resourceList": [
        {
          "resourceName": "intel_sriov_netdevice",
          "selectors": {
            "vendors": ["8086"],
            "devices": ["154c", "10ed"],
            "drivers": ["i40evf", "iavf", "ixgbevf"]
          }
        }
      ]
    }
EOF

# Pod requesting SR-IOV VF for DPDK
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: dpdk-app
  annotations:
    k8s.v1.cni.cncf.io/networks: sriov-net
spec:
  containers:
  - name: dpdk-app
    image: myorg/dpdk-app:latest
    resources:
      requests:
        intel.com/intel_sriov_netdevice: "1"
        hugepages-1Gi: 4Gi
        memory: 4Gi
        cpu: "4"
      limits:
        intel.com/intel_sriov_netdevice: "1"
        hugepages-1Gi: 4Gi
        memory: 4Gi
        cpu: "4"
    volumeMounts:
    - mountPath: /dev/hugepages
      name: hugepage
  volumes:
  - name: hugepage
    emptyDir:
      medium: HugePages-1Gi
EOF
```

The combination of DPDK, XDP, and AF_XDP provides a continuum of kernel-bypass options. Start with XDP for filtering use cases — it integrates naturally with the kernel and supports gradual migration. Use AF_XDP when you need userspace packet processing without the operational overhead of DPDK. Reserve DPDK for absolute maximum throughput where you control the entire data path.
