---
title: "Linux DPDK Data Plane: Huge Pages Setup, EAL Initialization, Poll-Mode Drivers, Packet I/O Patterns, and NUMA Affinity"
date: 2032-01-22T00:00:00-05:00
draft: false
tags: ["Linux", "DPDK", "Networking", "Performance", "NUMA", "High Performance Computing"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to DPDK (Data Plane Development Kit) covering huge pages configuration, EAL (Environment Abstraction Layer) initialization parameters, poll-mode driver architecture, packet I/O ring buffer patterns, NUMA topology awareness, and building high-performance packet processing applications for NFV and telecom workloads."
more_link: "yes"
url: "/linux-dpdk-data-plane-hugepages-eal-poll-mode-drivers-numa/"
---

DPDK (Data Plane Development Kit) enables user-space packet processing at line rate by bypassing the Linux kernel network stack entirely. At 100Gbps, the kernel's interrupt-driven model introduces latency and CPU overhead that makes it impossible to process every packet. DPDK's poll-mode drivers (PMDs) and huge page memory management change the fundamental economics of packet forwarding. This guide covers production DPDK deployment from hardware preparation through application patterns.

<!--more-->

# Linux DPDK Data Plane: Production Guide

## Section 1: Architecture Overview

DPDK moves network I/O from kernel space to user space. Instead of the kernel handling interrupts and copying packets through multiple layers, DPDK gives user-space applications direct access to NIC hardware via mapped MMIO registers and DMA ring buffers.

### Kernel vs DPDK Data Path

```
KERNEL PATH:
NIC ──interrupt──► kernel driver ──► sk_buff allocation
                                    ──► protocol stack (TCP/IP)
                                    ──► socket buffer
                                    ──► system call boundary
                                    ──► application buffer

DPDK PATH:
NIC ──DMA──► rx_ring (huge pages) ──► PMD poll ──► rte_mbuf
                                               ──► application code (user space)
                                               ──► tx_ring
                                               ──► DMA ──► NIC
```

### Key DPDK Components

| Component | Purpose |
|-----------|---------|
| EAL | Environment Abstraction Layer - init, CPU affinity, NUMA, PCI |
| PMD | Poll-Mode Driver - NIC hardware abstraction |
| rte_mbuf | Packet buffer management with zero-copy |
| rte_ring | Lock-free SPSC/MPMC ring buffers |
| rte_mempool | Memory pool allocator using huge pages |
| rte_ethdev | Ethernet device abstraction API |
| rte_timer | High-resolution timer |

### Supported NICs

DPDK supports a wide range of NICs through PMDs:
- Intel: igb, ixgbe (10G), i40e (25/40G), ice (100G)
- Mellanox: mlx4 (10G), mlx5 (10/25/40/100G)
- Cavium: octeontx
- Virtio: virtio-pmd (KVM guests)
- VFIO/AF_XDP: generic driver for any NIC

## Section 2: Huge Pages Configuration

DPDK requires huge pages for its memory pools. The default 4KB kernel pages cause TLB pressure and performance degradation at high packet rates.

### Huge Page Types

| Type | Size | Use Case |
|------|------|---------|
| 2MB (hugepages) | 2MiB | Standard DPDK workloads |
| 1GB (gigantic pages) | 1GiB | Large memory pools, maximum TLB performance |

### Configuring 2MB Huge Pages

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 63906 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 64471 MB

# Allocate 2MB huge pages per NUMA node
# For a dual-socket system running DPDK with two ports (one per socket):
echo 2048 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 2048 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Or allocate globally (kernel distributes across NUMA nodes)
echo 4096 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Verify allocation
cat /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
cat /proc/meminfo | grep Huge
# HugePages_Total:    4096
# HugePages_Free:     4096
# HugePages_Rsvd:        0
# Hugepagesize:       2048 kB
```

### Configuring 1GB Huge Pages

1GB pages must be configured at boot time - they cannot be allocated after the system has been running:

```bash
# Add to kernel boot parameters in /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="default_hugepagesz=1G hugepagesz=1G hugepages=32 \
  hugepagesz=2M hugepages=1024 \
  iommu=pt intel_iommu=on \
  isolcpus=2-15,18-31 nohz_full=2-15,18-31 rcu_nocbs=2-15,18-31"

# Apply
update-grub
reboot

# Verify after reboot
cat /proc/meminfo | grep -i huge
# HugePages_Total:      32  <- 1GB pages
# HugePages_Free:       32
# Hugepagesize:    1048576 kB
```

### Mounting hugetlbfs

DPDK requires hugepages to be accessible via a mounted filesystem:

```bash
# Create mount point
mkdir -p /dev/hugepages
mkdir -p /dev/hugepages1G  # separate mount for 1GB pages

# Mount 2MB hugepages
mount -t hugetlbfs -o pagesize=2M nodev /dev/hugepages

# Mount 1GB hugepages
mount -t hugetlbfs -o pagesize=1G nodev /dev/hugepages1G

# Make persistent in /etc/fstab
cat >> /etc/fstab << 'EOF'
nodev   /dev/hugepages  hugetlbfs  pagesize=2M  0  0
nodev   /dev/hugepages1G  hugetlbfs  pagesize=1G  0  0
EOF

# Verify
df -h | grep huge
mount | grep huge
```

## Section 3: VFIO and Driver Binding

DPDK requires unbinding NICs from their kernel driver and binding them to VFIO (Virtual Function I/O) or UIO (Userspace I/O).

### Checking PCI Device IDs

```bash
# List all network devices with PCI IDs
lspci -vmm | grep -A 5 "Network controller\|Ethernet controller"

# Find NIC PCI addresses
dpdk-devbind.py --status

# Output:
# Network devices using kernel driver
# ============================================================
# 0000:03:00.0 'Ethernet Controller X710 1572' drv=i40e unused=vfio-pci,igb_uio
# 0000:03:00.1 'Ethernet Controller X710 1572' drv=i40e unused=vfio-pci,igb_uio
```

### Binding to VFIO

```bash
# Load VFIO modules
modprobe vfio-pci
modprobe vfio_iommu_type1

# Enable IOMMU in kernel (must be in grub cmdline: intel_iommu=on or amd_iommu=on)
cat /sys/class/iommu/*/devices/*/iommu_group/type

# Verify IOMMU is active
dmesg | grep -i iommu | head -5

# Bind NIC to VFIO
dpdk-devbind.py --bind=vfio-pci 0000:03:00.0
dpdk-devbind.py --bind=vfio-pci 0000:03:00.1

# Verify binding
dpdk-devbind.py --status

# Output after binding:
# Network devices using DPDK-compatible driver
# ============================================================
# 0000:03:00.0 'Ethernet Controller X710 1572' drv=vfio-pci unused=i40e
# 0000:03:00.1 'Ethernet Controller X710 1572' drv=vfio-pci unused=i40e

# Make binding persistent across reboots
cat > /etc/udev/rules.d/dpdk.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="net", ATTR{address}=="aa:bb:cc:dd:ee:01", RUN+="/usr/sbin/dpdk-devbind.py --bind=vfio-pci $env{PCI_SLOT_NAME}"
ACTION=="add", SUBSYSTEM=="net", ATTR{address}=="aa:bb:cc:dd:ee:02", RUN+="/usr/sbin/dpdk-devbind.py --bind=vfio-pci $env{PCI_SLOT_NAME}"
EOF
```

## Section 4: EAL Initialization

The Environment Abstraction Layer (EAL) handles initialization of the DPDK runtime: CPU affinity, NUMA awareness, PCI device initialization, and memory allocation.

### EAL Command Line Arguments

```bash
# Typical EAL arguments for a production application
./dpdk-app \
    -l 2-15 \           # lcore list: use cores 2-15
    -n 4 \              # memory channels (match CPU memory channels)
    --socket-mem=4096,4096 \  # 4GB per NUMA socket
    --huge-dir=/dev/hugepages \
    --file-prefix=dpdk-app \   # unique prefix for hugepage files (multi-process)
    --proc-type=primary \      # primary | secondary | auto
    --vdev=net_pcap0,rx_pcap=input.pcap \  # virtual device for testing
    -- \                # EAL args end here
    -p 0x3 \            # application-specific args
    --config="(0,0,2),(1,0,3)"
```

### EAL in Code

```c
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_ring.h>
#include <rte_mempool.h>
#include <rte_lcore.h>

#define RX_RING_SIZE    1024
#define TX_RING_SIZE    1024
#define NUM_MBUFS       8191
#define MBUF_CACHE_SIZE 250
#define BURST_SIZE      32

static const struct rte_eth_conf port_conf_default = {
    .rxmode = {
        .max_rx_pkt_len = RTE_ETHER_MAX_LEN,
        .offloads = DEV_RX_OFFLOAD_CHECKSUM,
    },
    .txmode = {
        .mq_mode = ETH_MQ_TX_NONE,
        .offloads = DEV_TX_OFFLOAD_IPV4_CKSUM |
                    DEV_TX_OFFLOAD_UDP_CKSUM  |
                    DEV_TX_OFFLOAD_TCP_CKSUM,
    },
};

int main(int argc, char *argv[])
{
    int ret;

    /* Initialize EAL */
    ret = rte_eal_init(argc, argv);
    if (ret < 0) {
        rte_exit(EXIT_FAILURE, "EAL initialization failed: %s\n",
                 rte_strerror(rte_errno));
    }

    argc -= ret;
    argv += ret;

    /* Check available ports */
    uint16_t nb_ports = rte_eth_dev_count_avail();
    if (nb_ports < 2) {
        rte_exit(EXIT_FAILURE, "Need at least 2 ports (found %d)\n", nb_ports);
    }
    printf("Found %u available ports\n", nb_ports);

    /* Check NUMA awareness */
    unsigned socket_id = rte_socket_id();
    printf("Running on socket %u\n", socket_id);

    /* Parse application arguments */
    ret = parse_args(argc, argv);
    if (ret < 0) {
        rte_exit(EXIT_FAILURE, "Invalid arguments\n");
    }

    /* Run main loop */
    return run_forwarding_app();
}
```

## Section 5: Memory Pool and mbuf

Every packet in DPDK is represented by an `rte_mbuf`. The mempool allocates these from huge pages in fixed-size chunks.

### Creating a Mempool

```c
#include <rte_mempool.h>
#include <rte_mbuf.h>

struct rte_mempool *mbuf_pool;

/*
 * Create a packet mempool on the correct NUMA socket.
 * Key parameters:
 *   n       - number of elements (must be power of 2 minus 1 for ring efficiency)
 *   cache_size - per-lcore cache (reduces contention on pool)
 *   priv_size  - private data per mbuf (0 for standard usage)
 *   data_room_size - size of data area per mbuf (RTE_MBUF_DEFAULT_BUF_SIZE = 2176)
 */
static int
init_mempool(uint16_t port_id)
{
    unsigned socket_id = rte_eth_dev_socket_id(port_id);
    if (socket_id == SOCKET_ID_ANY) {
        socket_id = rte_socket_id();
    }

    /* Name must be unique per process */
    char pool_name[RTE_MEMPOOL_NAMESIZE];
    snprintf(pool_name, sizeof(pool_name), "mbuf_pool_port%u", port_id);

    mbuf_pool = rte_pktmbuf_pool_create(
        pool_name,
        NUM_MBUFS,           /* n: total elements in pool */
        MBUF_CACHE_SIZE,     /* cache_size: per-lcore cache */
        0,                   /* priv_size: no private data */
        RTE_MBUF_DEFAULT_BUF_SIZE,  /* data_room_size: 2176 bytes */
        socket_id            /* NUMA socket for allocation */
    );

    if (mbuf_pool == NULL) {
        printf("Cannot create mbuf pool on socket %u: %s\n",
               socket_id, rte_strerror(rte_errno));
        return -1;
    }

    printf("Created mbuf pool '%s': %u mbufs, %u per lcore, socket %u\n",
           pool_name, NUM_MBUFS, MBUF_CACHE_SIZE, socket_id);
    return 0;
}
```

### Packet Access Pattern

```c
#include <rte_ether.h>
#include <rte_ip.h>
#include <rte_udp.h>

static void
process_packet(struct rte_mbuf *pkt)
{
    /* Get pointer to start of Ethernet header */
    struct rte_ether_hdr *eth_hdr =
        rte_pktmbuf_mtod(pkt, struct rte_ether_hdr *);

    /* Check if it's an IPv4 packet */
    if (rte_be_to_cpu_16(eth_hdr->ether_type) != RTE_ETHER_TYPE_IPV4) {
        rte_pktmbuf_free(pkt);
        return;
    }

    /* Get IPv4 header (follows Ethernet header) */
    struct rte_ipv4_hdr *ip_hdr =
        (struct rte_ipv4_hdr *)(eth_hdr + 1);

    /* Check for UDP */
    if (ip_hdr->next_proto_id != IPPROTO_UDP) {
        rte_pktmbuf_free(pkt);
        return;
    }

    /* Get UDP header */
    struct rte_udp_hdr *udp_hdr =
        (struct rte_udp_hdr *)((uint8_t *)ip_hdr +
                               ((ip_hdr->version_ihl & 0x0f) << 2));

    /* Get payload */
    uint8_t *payload = (uint8_t *)(udp_hdr + 1);
    uint16_t payload_len = rte_be_to_cpu_16(udp_hdr->dgram_len) -
                           sizeof(struct rte_udp_hdr);

    /* Process payload... */
    (void)payload;
    (void)payload_len;

    /* Note: caller is responsible for freeing mbuf */
}
```

## Section 6: Poll-Mode Driver (PMD) and Port Initialization

```c
static int
port_init(uint16_t port, struct rte_mempool *mbuf_pool)
{
    struct rte_eth_conf port_conf = port_conf_default;
    struct rte_eth_dev_info dev_info;
    int retval;
    uint16_t q;

    /* Verify port is valid */
    if (!rte_eth_dev_is_valid_port(port)) {
        return -1;
    }

    /* Get device capabilities */
    retval = rte_eth_dev_info_get(port, &dev_info);
    if (retval != 0) {
        printf("Error getting info for port %u: %s\n", port,
               strerror(-retval));
        return retval;
    }

    printf("Port %u: driver=%s, rx_queues_max=%u, tx_queues_max=%u\n",
           port, dev_info.driver_name,
           dev_info.max_rx_queues, dev_info.max_tx_queues);

    /* Enable TX offloads if supported */
    if (dev_info.tx_offload_capa & DEV_TX_OFFLOAD_MBUF_FAST_FREE) {
        port_conf.txmode.offloads |= DEV_TX_OFFLOAD_MBUF_FAST_FREE;
    }

    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;

    /* Configure port: 1 RX queue, 1 TX queue */
    retval = rte_eth_dev_configure(port, 1, 1, &port_conf);
    if (retval != 0) return retval;

    /* Adjust descriptor counts to device limits */
    retval = rte_eth_dev_adjust_nb_rx_tx_desc(port, &nb_rxd, &nb_txd);
    if (retval != 0) return retval;

    /* Allocate RX queue on correct NUMA socket */
    unsigned socket_id = rte_eth_dev_socket_id(port);
    retval = rte_eth_rx_queue_setup(port, 0, nb_rxd,
                                    socket_id, NULL, mbuf_pool);
    if (retval < 0) return retval;

    /* Configure TX queue */
    struct rte_eth_txconf txconf = dev_info.default_txconf;
    txconf.offloads = port_conf.txmode.offloads;
    retval = rte_eth_tx_queue_setup(port, 0, nb_txd, socket_id, &txconf);
    if (retval < 0) return retval;

    /* Start device */
    retval = rte_eth_dev_start(port);
    if (retval < 0) return retval;

    /* Display MAC address */
    struct rte_ether_addr addr;
    rte_eth_macaddr_get(port, &addr);
    printf("Port %u MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
           port,
           addr.addr_bytes[0], addr.addr_bytes[1],
           addr.addr_bytes[2], addr.addr_bytes[3],
           addr.addr_bytes[4], addr.addr_bytes[5]);

    /* Enable promiscuous mode */
    rte_eth_promiscuous_enable(port);

    return 0;
}
```

## Section 7: Packet I/O Burst Patterns

The burst API is fundamental to DPDK performance. Processing packets individually is catastrophically slow.

### RX/TX Burst

```c
#define BURST_SIZE 32

static void
lcore_main_loop(void)
{
    uint16_t port;

    /* Verify lcore is on correct NUMA socket for each port */
    RTE_ETH_FOREACH_DEV(port) {
        if (rte_eth_dev_socket_id(port) >= 0 &&
            rte_eth_dev_socket_id(port) != (int)rte_socket_id()) {
            printf("WARNING: port %u on different socket than lcore.\n",
                   port);
        }
    }

    printf("Core %u forwarding packets. [Ctrl+C to quit]\n", rte_lcore_id());

    struct rte_mbuf *bufs[BURST_SIZE];

    for (;;) {
        /* Receive burst from port 0, queue 0 */
        const uint16_t nb_rx = rte_eth_rx_burst(0, 0, bufs, BURST_SIZE);

        if (unlikely(nb_rx == 0)) {
            continue;  /* Poll loop - no sleep */
        }

        /* Process each received packet */
        uint16_t i;
        for (i = 0; i < nb_rx; i++) {
            /* Prefetch next mbuf while processing current */
            if (likely(i < nb_rx - 1)) {
                rte_prefetch0(rte_pktmbuf_mtod(bufs[i + 1], void *));
            }
            process_packet(bufs[i]);
        }

        /* Transmit burst to port 1, queue 0 */
        const uint16_t nb_tx = rte_eth_tx_burst(1, 0, bufs, nb_rx);

        /* Free any unsent packets */
        if (unlikely(nb_tx < nb_rx)) {
            uint16_t buf;
            for (buf = nb_tx; buf < nb_rx; buf++) {
                rte_pktmbuf_free(bufs[buf]);
            }
        }
    }
}
```

### rte_ring for Inter-Core Communication

Pass packets between lcores using lock-free rings:

```c
#include <rte_ring.h>

/* Create a ring between RX lcore and processing lcores */
struct rte_ring *rx_to_proc_ring;

static int
init_rings(void)
{
    /* Ring name must be unique */
    /* Ring size must be power of 2 */
    rx_to_proc_ring = rte_ring_create("rx_to_proc",
                                       65536,          /* ring size */
                                       rte_socket_id(), /* NUMA socket */
                                       RING_F_SP_ENQ | RING_F_SC_DEQ);  /* single producer, single consumer */

    if (rx_to_proc_ring == NULL) {
        printf("Cannot create rx_to_proc ring: %s\n",
               rte_strerror(rte_errno));
        return -1;
    }
    return 0;
}

/* RX lcore: receive and enqueue */
static void
rx_lcore_fn(void)
{
    struct rte_mbuf *bufs[BURST_SIZE];

    for (;;) {
        uint16_t nb_rx = rte_eth_rx_burst(0, 0, bufs, BURST_SIZE);
        if (nb_rx == 0) continue;

        uint32_t nb_enq = rte_ring_enqueue_burst(rx_to_proc_ring,
                                                  (void **)bufs,
                                                  nb_rx, NULL);

        /* Free packets that couldn't be enqueued (ring full) */
        if (unlikely(nb_enq < nb_rx)) {
            uint16_t i;
            for (i = nb_enq; i < nb_rx; i++) {
                rte_pktmbuf_free(bufs[i]);
            }
        }
    }
}

/* Processing lcore: dequeue and process */
static void
proc_lcore_fn(void)
{
    struct rte_mbuf *bufs[BURST_SIZE];

    for (;;) {
        uint32_t nb_deq = rte_ring_dequeue_burst(rx_to_proc_ring,
                                                  (void **)bufs,
                                                  BURST_SIZE, NULL);
        if (nb_deq == 0) continue;

        uint16_t i;
        for (i = 0; i < nb_deq; i++) {
            process_packet(bufs[i]);
            rte_pktmbuf_free(bufs[i]);
        }
    }
}
```

## Section 8: NUMA Affinity

NUMA (Non-Uniform Memory Access) is critical for DPDK performance. Accessing memory on the wrong NUMA socket adds 70-150ns latency per access - devastating at 100Gbps line rates.

### NUMA-Aware Resource Allocation

```c
#include <rte_lcore.h>
#include <rte_per_lcore.h>

/* Get socket for a given lcore */
static unsigned
get_lcore_socket(unsigned lcore_id)
{
    return rte_lcore_to_socket_id(lcore_id);
}

/* NUMA-aware mempool creation */
static struct rte_mempool *
create_mempool_for_port(uint16_t port_id)
{
    unsigned port_socket = rte_eth_dev_socket_id(port_id);
    char pool_name[64];
    snprintf(pool_name, sizeof(pool_name), "pool_port%u", port_id);

    return rte_pktmbuf_pool_create(pool_name,
                                    NUM_MBUFS,
                                    MBUF_CACHE_SIZE,
                                    0,
                                    RTE_MBUF_DEFAULT_BUF_SIZE,
                                    port_socket);  /* allocate on port's socket */
}

/* Check and warn about cross-NUMA access */
static void
check_numa_affinity(uint16_t port_id, unsigned lcore_id)
{
    int port_socket = rte_eth_dev_socket_id(port_id);
    unsigned lcore_socket = rte_lcore_to_socket_id(lcore_id);

    if (port_socket >= 0 && (unsigned)port_socket != lcore_socket) {
        printf("WARNING: Port %u is on socket %d but lcore %u is on socket %u\n",
               port_id, port_socket, lcore_id, lcore_socket);
        printf("         This will cause cross-NUMA memory access (~100ns penalty/packet)\n");
    }
}
```

### CPU Isolation for DPDK Lcores

```bash
# /etc/default/grub - isolate CPUs for DPDK use
# CPU 0 is never isolated (system use)
# CPUs 2-15 on socket 0: DPDK lcores
# CPUs 18-31 on socket 1: DPDK lcores

GRUB_CMDLINE_LINUX_DEFAULT="quiet splash \
  intel_iommu=on iommu=pt \
  default_hugepagesz=1G hugepagesz=1G hugepages=32 \
  hugepagesz=2M hugepages=1024 \
  isolcpus=2-15,18-31 \
  nohz_full=2-15,18-31 \
  rcu_nocbs=2-15,18-31 \
  irqaffinity=0,1,16,17"

# After reboot: verify CPU isolation
cat /sys/devices/system/cpu/isolated
# 2-15,18-31

# Set IRQ affinity away from DPDK lcores
# Move all IRQs to non-DPDK CPUs
for irq in /proc/irq/*/smp_affinity; do
    echo "00030003" > "$irq" 2>/dev/null  # CPUs 0,1,16,17 (mask)
done

# Verify DPDK lcores have no system interrupts
grep "CPU2\|CPU3" /proc/interrupts | head -10
```

## Section 9: Statistics and Monitoring

```c
#include <rte_ethdev.h>

static void
print_stats(void)
{
    struct rte_eth_stats stats;
    uint16_t port_id;

    printf("\n\n=== Port Statistics ===\n");
    RTE_ETH_FOREACH_DEV(port_id) {
        rte_eth_stats_get(port_id, &stats);
        printf("Port %u:\n"
               "  RX packets: %lu\n"
               "  RX bytes:   %lu\n"
               "  RX errors:  %lu\n"
               "  RX missed:  %lu  <- packets dropped due to full ring\n"
               "  TX packets: %lu\n"
               "  TX bytes:   %lu\n"
               "  TX errors:  %lu\n",
               port_id,
               stats.ipackets, stats.ibytes,
               stats.ierrors, stats.imissed,
               stats.opackets, stats.obytes,
               stats.oerrors);

        /* Extended stats (NIC-specific) */
        int num_xstats = rte_eth_xstats_get(port_id, NULL, 0);
        if (num_xstats > 0) {
            struct rte_eth_xstat_name *xnames = malloc(num_xstats * sizeof(*xnames));
            struct rte_eth_xstat *xstats = malloc(num_xstats * sizeof(*xstats));
            rte_eth_xstats_get_names(port_id, xnames, num_xstats);
            rte_eth_xstats_get(port_id, xstats, num_xstats);

            for (int i = 0; i < num_xstats; i++) {
                if (xstats[i].value > 0) {
                    printf("  %s: %lu\n", xnames[i].name, xstats[i].value);
                }
            }
            free(xnames);
            free(xstats);
        }
    }
}
```

## Section 10: DPDK in Kubernetes (SR-IOV and VFIO)

```yaml
# DPDK workload in Kubernetes using SR-IOV Network Device Plugin
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dpdk-app
  namespace: cnf
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dpdk-app
  template:
    metadata:
      annotations:
        k8s.v1.cni.cncf.io/networks: dpdk-net-1,dpdk-net-2
    spec:
      containers:
        - name: dpdk
          image: dpdk-app:v23.11
          command: ["/app/dpdk-l3fwd"]
          args:
            - "-l"
            - "2-3"
            - "-n"
            - "4"
            - "--socket-mem=1024,0"
            - "--vdev=net_pcap0,rx_pcap=/pcap/input.pcap"
            - "--"
            - "-p"
            - "0x3"
          env:
            - name: RTE_EAL_PMD_PATH
              value: /usr/lib/dpdk/pmds
          resources:
            requests:
              memory: 4Gi
              hugepages-1Gi: 2Gi
              intel.com/intel_sriov_dpdk: "2"
            limits:
              memory: 4Gi
              hugepages-1Gi: 2Gi
              intel.com/intel_sriov_dpdk: "2"
          securityContext:
            capabilities:
              add:
                - IPC_LOCK    # required for huge page locking
                - NET_ADMIN
                - SYS_RAWIO
          volumeMounts:
            - name: hugepage
              mountPath: /dev/hugepages
      volumes:
        - name: hugepage
          emptyDir:
            medium: HugePages-1Gi
      nodeSelector:
        dpdk-enabled: "true"
      runtimeClassName: sriov-isolcpus
```

DPDK represents the cutting edge of Linux packet processing performance. The investment in hardware preparation, memory configuration, and NUMA-aware application design pays dividends in forwarding rates that are simply impossible with kernel-based networking. The patterns here form the foundation for NFV, telco, and high-frequency trading infrastructure built on commodity server hardware.
