---
title: "DPDK Programming for Network Performance Optimization: Enterprise-Grade High-Speed Packet Processing"
date: 2026-06-18T00:00:00-05:00
draft: false
tags: ["DPDK", "Network Programming", "Packet Processing", "Performance", "Systems Programming", "High-Speed Networking"]
categories:
- Systems Programming
- Network Programming
- Performance Optimization
- Enterprise Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Master DPDK programming for building high-performance network applications. Learn packet processing, memory management, multi-core scaling, and enterprise deployment strategies for ultra-low latency systems."
more_link: "yes"
url: "/dpdk-programming-network-performance-optimization/"
---

Data Plane Development Kit (DPDK) enables unprecedented network performance by bypassing the kernel and providing direct userspace access to network hardware. This comprehensive guide explores advanced DPDK programming techniques for building enterprise-grade high-speed packet processing applications.

<!--more-->

# [DPDK Architecture and Environment Setup](#dpdk-architecture)

## Section 1: Advanced DPDK Environment Configuration

DPDK requires careful system configuration to achieve optimal performance, including CPU isolation, memory management, and hardware setup.

### Production Environment Setup

```bash
#!/bin/bash
# dpdk_setup.sh - Production DPDK environment setup

set -euo pipefail

# DPDK configuration parameters
DPDK_VERSION="23.11"
HUGE_PAGE_SIZE="1G"
HUGE_PAGE_COUNT="8"
CPU_ISOLATION="2-15"  # Isolate cores 2-15 for DPDK
IRQ_AFFINITY_CORE="1"  # Pin interrupts to core 1

# Kernel parameters for optimal DPDK performance
setup_kernel_parameters() {
    echo "Setting up kernel parameters for DPDK..."
    
    # Add to /etc/default/grub
    cat >> /etc/default/grub << EOF

# DPDK optimizations
GRUB_CMDLINE_LINUX_DEFAULT="\$GRUB_CMDLINE_LINUX_DEFAULT \\
    isolcpus=${CPU_ISOLATION} \\
    nohz_full=${CPU_ISOLATION} \\
    rcu_nocbs=${CPU_ISOLATION} \\
    hugepagesz=${HUGE_PAGE_SIZE} \\
    hugepages=${HUGE_PAGE_COUNT} \\
    default_hugepagesz=${HUGE_PAGE_SIZE} \\
    iommu=pt \\
    intel_iommu=on \\
    processor.max_cstate=1 \\
    intel_idle.max_cstate=0 \\
    nosoftlockup"
EOF
    
    update-grub
}

# Setup hugepages
setup_hugepages() {
    echo "Configuring hugepages..."
    
    # Create hugepage mount point
    mkdir -p /mnt/huge
    
    # Add to /etc/fstab
    echo "nodev /mnt/huge hugetlbfs pagesize=${HUGE_PAGE_SIZE} 0 0" >> /etc/fstab
    
    # Mount hugepages
    mount /mnt/huge
    
    # Set permissions
    chmod 777 /mnt/huge
}

# Setup VFIO for device access
setup_vfio() {
    echo "Setting up VFIO..."
    
    # Load VFIO modules
    modprobe vfio-pci
    modprobe vfio
    
    # Add to /etc/modules
    cat >> /etc/modules << EOF
vfio
vfio-pci
EOF
    
    # Bind network devices to VFIO
    # Example for Intel X710 NIC
    echo "8086 1572" > /sys/bus/pci/drivers/vfio-pci/new_id
}

# Configure CPU frequency scaling
setup_cpu_scaling() {
    echo "Configuring CPU frequency scaling..."
    
    # Set performance governor
    for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        echo "performance" > "$cpu" 2>/dev/null || true
    done
    
    # Disable C-states
    for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
        echo 1 > "$cpu" 2>/dev/null || true
    done
}

# Install DPDK
install_dpdk() {
    echo "Installing DPDK ${DPDK_VERSION}..."
    
    # Dependencies
    apt-get update
    apt-get install -y build-essential python3-pyelftools libnuma-dev \
                      pkg-config meson ninja-build

    # Download and build DPDK
    cd /opt
    wget "http://fast.dpdk.org/rel/dpdk-${DPDK_VERSION}.tar.xz"
    tar xf "dpdk-${DPDK_VERSION}.tar.xz"
    cd "dpdk-${DPDK_VERSION}"
    
    # Configure build
    meson build \
        -Denable_kmods=true \
        -Dexamples=all \
        -Dtests=false \
        -Ddisable_drivers=crypto/*,compress/*,regex/*,vdpa/*,ml/*
    
    # Build and install
    ninja -C build
    ninja -C build install
    ldconfig
    
    # Set environment variables
    cat >> /etc/environment << EOF
PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig
RTE_SDK=/opt/dpdk-${DPDK_VERSION}
RTE_TARGET=x86_64-native-linux-gcc
EOF
}

# Main setup function
main() {
    echo "Starting DPDK production environment setup..."
    
    setup_kernel_parameters
    setup_hugepages
    setup_vfio
    setup_cpu_scaling
    install_dpdk
    
    echo "DPDK setup complete. Please reboot to apply kernel parameters."
}

main "$@"
```

### Device Binding and Management

```c
// dpdk_device_mgmt.c - DPDK device management utilities
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <sys/queue.h>
#include <errno.h>

#include <rte_common.h>
#include <rte_log.h>
#include <rte_malloc.h>
#include <rte_memory.h>
#include <rte_memcpy.h>
#include <rte_eal.h>
#include <rte_per_lcore.h>
#include <rte_launch.h>
#include <rte_atomic.h>
#include <rte_cycles.h>
#include <rte_prefetch.h>
#include <rte_lcore.h>
#include <rte_per_lcore.h>
#include <rte_branch_prediction.h>
#include <rte_interrupts.h>
#include <rte_pci.h>
#include <rte_random.h>
#include <rte_debug.h>
#include <rte_ether.h>
#include <rte_ethdev.h>
#include <rte_mempool.h>
#include <rte_mbuf.h>

#define MAX_PORTS 16
#define MBUF_CACHE_SIZE 256
#define BURST_SIZE 32
#define RX_RING_SIZE 2048
#define TX_RING_SIZE 2048

// Port configuration structure
struct port_config {
    uint16_t port_id;
    uint16_t nb_rx_queues;
    uint16_t nb_tx_queues;
    struct rte_eth_conf port_conf;
    struct rte_eth_rxconf rx_conf;
    struct rte_eth_txconf tx_conf;
    struct rte_mempool *mbuf_pool;
    bool enabled;
    uint64_t rx_packets;
    uint64_t tx_packets;
    uint64_t rx_bytes;
    uint64_t tx_bytes;
    uint64_t rx_errors;
    uint64_t tx_errors;
};

// Global port configuration
static struct port_config port_configs[MAX_PORTS];
static uint16_t nb_ports = 0;

// Default port configuration optimized for performance
static const struct rte_eth_conf default_port_conf = {
    .rxmode = {
        .mq_mode = RTE_ETH_MQ_RX_RSS,
        .offloads = RTE_ETH_RX_OFFLOAD_CHECKSUM |
                   RTE_ETH_RX_OFFLOAD_RSS_HASH,
    },
    .rx_adv_conf = {
        .rss_conf = {
            .rss_key = NULL,
            .rss_hf = RTE_ETH_RSS_IP | RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP,
        },
    },
    .txmode = {
        .mq_mode = RTE_ETH_MQ_TX_NONE,
        .offloads = RTE_ETH_TX_OFFLOAD_MULTI_SEGS |
                   RTE_ETH_TX_OFFLOAD_TCP_CKSUM |
                   RTE_ETH_TX_OFFLOAD_UDP_CKSUM |
                   RTE_ETH_TX_OFFLOAD_IPV4_CKSUM,
    },
    .intr_conf = {
        .lsc = 1,  // Link status change interrupt
    },
};

// Initialize DPDK environment
int dpdk_init(int argc, char **argv)
{
    int ret;
    
    // Initialize EAL
    ret = rte_eal_init(argc, argv);
    if (ret < 0) {
        rte_panic("Cannot init EAL: %s\n", rte_strerror(-ret));
    }
    
    // Check if we have enough ports
    nb_ports = rte_eth_dev_count_avail();
    if (nb_ports == 0) {
        rte_panic("No Ethernet ports available\n");
    }
    
    if (nb_ports > MAX_PORTS) {
        printf("Warning: Only using %d of %d available ports\n", 
               MAX_PORTS, nb_ports);
        nb_ports = MAX_PORTS;
    }
    
    printf("Found %d Ethernet ports\n", nb_ports);
    
    return ret;
}

// Create memory pool for packet buffers
struct rte_mempool *create_packet_mempool(const char *name, unsigned nb_mbufs,
                                         unsigned cache_size, uint16_t data_room_size)
{
    struct rte_mempool *mbuf_pool;
    
    mbuf_pool = rte_pktmbuf_pool_create(name, nb_mbufs, cache_size, 0,
                                       data_room_size, rte_socket_id());
    
    if (mbuf_pool == NULL) {
        rte_panic("Cannot create mbuf pool: %s\n", rte_strerror(-rte_errno));
    }
    
    return mbuf_pool;
}

// Configure a single port
int configure_port(uint16_t port_id, uint16_t nb_rx_queues, uint16_t nb_tx_queues,
                  struct rte_mempool *mbuf_pool)
{
    struct rte_eth_dev_info dev_info;
    struct port_config *config = &port_configs[port_id];
    int ret;
    uint16_t q;
    
    if (port_id >= nb_ports) {
        return -EINVAL;
    }
    
    // Get device info
    ret = rte_eth_dev_info_get(port_id, &dev_info);
    if (ret != 0) {
        printf("Error getting device info for port %u: %s\n",
               port_id, strerror(-ret));
        return ret;
    }
    
    // Initialize port configuration
    config->port_id = port_id;
    config->nb_rx_queues = nb_rx_queues;
    config->nb_tx_queues = nb_tx_queues;
    config->port_conf = default_port_conf;
    config->mbuf_pool = mbuf_pool;
    
    // Adjust configuration based on device capabilities
    if (dev_info.tx_offload_capa & RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE) {
        config->port_conf.txmode.offloads |= RTE_ETH_TX_OFFLOAD_MBUF_FAST_FREE;
    }
    
    // Configure RSS if supported
    if (dev_info.rx_offload_capa & RTE_ETH_RX_OFFLOAD_RSS_HASH) {
        config->port_conf.rx_adv_conf.rss_conf.rss_hf &=
            dev_info.flow_type_rss_offloads;
    }
    
    // Configure the Ethernet device
    ret = rte_eth_dev_configure(port_id, nb_rx_queues, nb_tx_queues,
                               &config->port_conf);
    if (ret != 0) {
        printf("Cannot configure device: err=%d, port=%u\n", ret, port_id);
        return ret;
    }
    
    // Adjust number of descriptors
    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;
    
    ret = rte_eth_dev_adjust_nb_rx_tx_desc(port_id, &nb_rxd, &nb_txd);
    if (ret != 0) {
        printf("Cannot adjust number of descriptors: err=%d, port=%u\n",
               ret, port_id);
        return ret;
    }
    
    // Setup RX queues
    config->rx_conf = dev_info.default_rxconf;
    config->rx_conf.offloads = config->port_conf.rxmode.offloads;
    
    for (q = 0; q < nb_rx_queues; q++) {
        ret = rte_eth_rx_queue_setup(port_id, q, nb_rxd,
                                   rte_eth_dev_socket_id(port_id),
                                   &config->rx_conf, mbuf_pool);
        if (ret < 0) {
            printf("Cannot setup RX queue %u for port %u: %s\n",
                   q, port_id, strerror(-ret));
            return ret;
        }
    }
    
    // Setup TX queues
    config->tx_conf = dev_info.default_txconf;
    config->tx_conf.offloads = config->port_conf.txmode.offloads;
    
    for (q = 0; q < nb_tx_queues; q++) {
        ret = rte_eth_tx_queue_setup(port_id, q, nb_txd,
                                   rte_eth_dev_socket_id(port_id),
                                   &config->tx_conf);
        if (ret < 0) {
            printf("Cannot setup TX queue %u for port %u: %s\n",
                   q, port_id, strerror(-ret));
            return ret;
        }
    }
    
    // Start the Ethernet port
    ret = rte_eth_dev_start(port_id);
    if (ret < 0) {
        printf("Cannot start port %u: %s\n", port_id, strerror(-ret));
        return ret;
    }
    
    // Enable promiscuous mode
    ret = rte_eth_promiscuous_enable(port_id);
    if (ret != 0) {
        printf("Cannot enable promiscuous mode for port %u: %s\n",
               port_id, strerror(-ret));
        return ret;
    }
    
    // Check link status
    struct rte_eth_link link;
    ret = rte_eth_link_get_nowait(port_id, &link);
    if (ret < 0) {
        printf("Cannot get link status for port %u: %s\n",
               port_id, strerror(-ret));
        return ret;
    }
    
    if (link.link_status == RTE_ETH_LINK_UP) {
        printf("Port %u: Link Up - speed %u Mbps - %s\n",
               port_id, link.link_speed,
               (link.link_duplex == RTE_ETH_LINK_FULL_DUPLEX) ?
               "full-duplex" : "half-duplex");
    } else {
        printf("Port %u: Link Down\n", port_id);
    }
    
    config->enabled = true;
    return 0;
}

// Initialize all available ports
int initialize_all_ports(void)
{
    uint16_t port_id;
    struct rte_mempool *mbuf_pool;
    int ret;
    
    // Create mbuf pool
    mbuf_pool = create_packet_mempool("MBUF_POOL",
                                     8192 * nb_ports,
                                     MBUF_CACHE_SIZE,
                                     RTE_MBUF_DEFAULT_BUF_SIZE);
    
    // Configure each port
    for (port_id = 0; port_id < nb_ports; port_id++) {
        ret = configure_port(port_id, 1, 1, mbuf_pool);
        if (ret != 0) {
            printf("Failed to configure port %u\n", port_id);
            return ret;
        }
    }
    
    return 0;
}

// Get port statistics
void get_port_stats(uint16_t port_id, struct rte_eth_stats *stats)
{
    if (port_id >= nb_ports || !port_configs[port_id].enabled) {
        memset(stats, 0, sizeof(*stats));
        return;
    }
    
    rte_eth_stats_get(port_id, stats);
}

// Print port statistics
void print_port_stats(uint16_t port_id)
{
    struct rte_eth_stats stats;
    
    if (port_id >= nb_ports || !port_configs[port_id].enabled) {
        printf("Port %u: Not available\n", port_id);
        return;
    }
    
    get_port_stats(port_id, &stats);
    
    printf("Port %u Statistics:\n", port_id);
    printf("  RX Packets: %"PRIu64" (%"PRIu64" bytes)\n",
           stats.ipackets, stats.ibytes);
    printf("  TX Packets: %"PRIu64" (%"PRIu64" bytes)\n",
           stats.opackets, stats.obytes);
    printf("  RX Errors:  %"PRIu64"\n", stats.ierrors);
    printf("  TX Errors:  %"PRIu64"\n", stats.oerrors);
    printf("  RX Missed:  %"PRIu64"\n", stats.imissed);
}
```

## Section 2: High-Performance Packet Processing Engine

Building efficient packet processing pipelines requires understanding DPDK's poll-mode drivers and optimizing for CPU cache behavior.

### Advanced Packet Processing Pipeline

```c
// packet_processor.c - High-performance packet processing engine
#include <rte_prefetch.h>
#include <rte_hash.h>
#include <rte_jhash.h>
#include <rte_acl.h>

#define MAX_PATTERN_NUM 1024
#define MAX_PKT_BURST 64
#define PREFETCH_OFFSET 3

// Packet processing statistics
struct processing_stats {
    uint64_t packets_processed;
    uint64_t packets_dropped;
    uint64_t packets_forwarded;
    uint64_t bytes_processed;
    uint64_t cycles_per_packet;
    uint64_t last_tsc;
    uint64_t total_cycles;
};

// Flow classification structure
struct flow_key {
    uint32_t src_ip;
    uint32_t dst_ip;
    uint16_t src_port;
    uint16_t dst_port;
    uint8_t protocol;
    uint8_t pad[3];  // Padding for alignment
} __rte_packed;

struct flow_entry {
    struct flow_key key;
    uint32_t action;
    uint64_t packet_count;
    uint64_t byte_count;
    uint64_t last_seen;
    uint8_t flags;
} __rte_cache_aligned;

// Packet processing context
struct processing_context {
    struct rte_hash *flow_table;
    struct rte_acl_ctx *acl_ctx;
    struct processing_stats stats;
    uint16_t port_id;
    uint16_t queue_id;
    struct rte_mempool *clone_pool;
    
    // Batch processing buffers
    struct rte_mbuf *rx_burst[MAX_PKT_BURST];
    struct rte_mbuf *tx_burst[MAX_PKT_BURST];
    uint16_t nb_rx;
    uint16_t nb_tx;
    
    // Pipeline stages
    uint16_t parsed_count;
    uint16_t classified_count;
    uint16_t processed_count;
};

// Initialize flow table
static struct rte_hash *create_flow_table(void)
{
    struct rte_hash_parameters hash_params = {
        .name = "flow_table",
        .entries = 1024 * 1024,  // 1M flows
        .key_len = sizeof(struct flow_key),
        .hash_func = rte_jhash,
        .hash_func_init_val = 0,
        .socket_id = rte_socket_id(),
        .extra_flag = RTE_HASH_EXTRA_FLAGS_RW_CONCURRENCY |
                     RTE_HASH_EXTRA_FLAGS_MULTI_WRITER_ADD,
    };
    
    return rte_hash_create(&hash_params);
}

// Optimized packet parsing with prefetching
static inline void parse_packet_batch(struct processing_context *ctx)
{
    struct rte_mbuf *m;
    struct rte_ether_hdr *eth_hdr;
    struct rte_ipv4_hdr *ipv4_hdr;
    struct rte_tcp_hdr *tcp_hdr;
    struct rte_udp_hdr *udp_hdr;
    uint16_t i;
    
    // Prefetch packet data
    for (i = 0; i < ctx->nb_rx && i < PREFETCH_OFFSET; i++) {
        rte_prefetch0(rte_pktmbuf_mtod(ctx->rx_burst[i], void *));
    }
    
    for (i = 0; i < ctx->nb_rx; i++) {
        // Prefetch next packet
        if (i + PREFETCH_OFFSET < ctx->nb_rx) {
            rte_prefetch0(rte_pktmbuf_mtod(ctx->rx_burst[i + PREFETCH_OFFSET], void *));
        }
        
        m = ctx->rx_burst[i];
        
        // Parse Ethernet header
        eth_hdr = rte_pktmbuf_mtod(m, struct rte_ether_hdr *);
        
        if (eth_hdr->ether_type != rte_cpu_to_be_16(RTE_ETHER_TYPE_IPV4)) {
            // Non-IPv4 packet, mark for dropping
            m->udata64 = 0;
            continue;
        }
        
        // Parse IPv4 header
        ipv4_hdr = (struct rte_ipv4_hdr *)(eth_hdr + 1);
        
        if (ipv4_hdr->version_ihl != 0x45) {
            // Invalid IPv4 header
            m->udata64 = 0;
            continue;
        }
        
        // Extract flow key
        struct flow_key *key = (struct flow_key *)&m->udata64;
        key->src_ip = ipv4_hdr->src_addr;
        key->dst_ip = ipv4_hdr->dst_addr;
        key->protocol = ipv4_hdr->next_proto_id;
        
        // Parse transport layer
        void *l4_hdr = (uint8_t *)ipv4_hdr + sizeof(struct rte_ipv4_hdr);
        
        switch (ipv4_hdr->next_proto_id) {
        case IPPROTO_TCP:
            tcp_hdr = (struct rte_tcp_hdr *)l4_hdr;
            key->src_port = tcp_hdr->src_port;
            key->dst_port = tcp_hdr->dst_port;
            break;
            
        case IPPROTO_UDP:
            udp_hdr = (struct rte_udp_hdr *)l4_hdr;
            key->src_port = udp_hdr->src_port;
            key->dst_port = udp_hdr->dst_port;
            break;
            
        default:
            key->src_port = 0;
            key->dst_port = 0;
            break;
        }
        
        // Store parsed packet length
        m->pkt_len = rte_be_to_cpu_16(ipv4_hdr->total_length);
    }
    
    ctx->parsed_count = ctx->nb_rx;
}

// Bulk flow classification
static inline void classify_flows_batch(struct processing_context *ctx)
{
    struct rte_mbuf *m;
    struct flow_key *key;
    struct flow_entry *entry;
    int32_t ret;
    uint16_t i;
    uint64_t current_tsc = rte_rdtsc();
    
    // Bulk lookup in flow table
    const void *keys[MAX_PKT_BURST];
    int32_t positions[MAX_PKT_BURST];
    
    for (i = 0; i < ctx->parsed_count; i++) {
        m = ctx->rx_burst[i];
        key = (struct flow_key *)&m->udata64;
        keys[i] = key;
    }
    
    // Perform bulk hash lookup
    ret = rte_hash_lookup_bulk(ctx->flow_table, keys, ctx->parsed_count, positions);
    
    for (i = 0; i < ctx->parsed_count; i++) {
        m = ctx->rx_burst[i];
        key = (struct flow_key *)&m->udata64;
        
        if (positions[i] >= 0) {
            // Existing flow found
            entry = (struct flow_entry *)positions[i];
            entry->packet_count++;
            entry->byte_count += m->pkt_len;
            entry->last_seen = current_tsc;
            
            // Store action in packet metadata
            m->hash.rss = entry->action;
        } else {
            // New flow - create entry
            struct flow_entry new_entry = {
                .key = *key,
                .action = classify_new_flow(key),
                .packet_count = 1,
                .byte_count = m->pkt_len,
                .last_seen = current_tsc,
                .flags = 0,
            };
            
            ret = rte_hash_add_key_data(ctx->flow_table, key, &new_entry);
            if (ret >= 0) {
                m->hash.rss = new_entry.action;
            } else {
                // Hash table full, use default action
                m->hash.rss = 0;  // Drop
            }
        }
    }
    
    ctx->classified_count = ctx->parsed_count;
}

// Fast packet forwarding based on classification
static inline uint16_t process_packets_batch(struct processing_context *ctx)
{
    struct rte_mbuf *m;
    uint16_t i, nb_tx = 0;
    uint64_t start_tsc = rte_rdtsc();
    
    for (i = 0; i < ctx->classified_count; i++) {
        m = ctx->rx_burst[i];
        uint32_t action = m->hash.rss;
        
        switch (action & 0xFF) {
        case 0:  // Drop
            rte_pktmbuf_free(m);
            ctx->stats.packets_dropped++;
            break;
            
        case 1:  // Forward
            ctx->tx_burst[nb_tx++] = m;
            ctx->stats.packets_forwarded++;
            break;
            
        case 2:  // Mirror and forward
            {
                struct rte_mbuf *clone = rte_pktmbuf_clone(m, ctx->clone_pool);
                if (clone) {
                    ctx->tx_burst[nb_tx++] = clone;
                }
                ctx->tx_burst[nb_tx++] = m;
                ctx->stats.packets_forwarded += (clone ? 2 : 1);
            }
            break;
            
        default:
            // Unknown action, drop
            rte_pktmbuf_free(m);
            ctx->stats.packets_dropped++;
            break;
        }
        
        ctx->stats.bytes_processed += m->pkt_len;
    }
    
    ctx->stats.packets_processed += ctx->classified_count;
    
    // Update performance statistics
    uint64_t end_tsc = rte_rdtsc();
    ctx->stats.total_cycles += (end_tsc - start_tsc);
    
    if (ctx->stats.packets_processed > 0) {
        ctx->stats.cycles_per_packet = ctx->stats.total_cycles / 
                                      ctx->stats.packets_processed;
    }
    
    return nb_tx;
}

// Main packet processing loop
int packet_processing_loop(void *arg)
{
    struct processing_context *ctx = (struct processing_context *)arg;
    uint16_t nb_tx;
    uint64_t stats_timer = 0;
    const uint64_t stats_interval = rte_get_timer_hz();  // 1 second
    
    printf("Starting packet processing on core %u for port %u queue %u\n",
           rte_lcore_id(), ctx->port_id, ctx->queue_id);
    
    while (1) {
        // Receive packets
        ctx->nb_rx = rte_eth_rx_burst(ctx->port_id, ctx->queue_id,
                                     ctx->rx_burst, MAX_PKT_BURST);
        
        if (ctx->nb_rx == 0) {
            continue;
        }
        
        // Process packet batch through pipeline
        parse_packet_batch(ctx);
        classify_flows_batch(ctx);
        nb_tx = process_packets_batch(ctx);
        
        // Transmit processed packets
        if (nb_tx > 0) {
            uint16_t sent = rte_eth_tx_burst(ctx->port_id, ctx->queue_id,
                                           ctx->tx_burst, nb_tx);
            
            // Free unsent packets
            for (uint16_t i = sent; i < nb_tx; i++) {
                rte_pktmbuf_free(ctx->tx_burst[i]);
            }
        }
        
        // Print statistics periodically
        uint64_t current_tsc = rte_rdtsc();
        if (current_tsc - stats_timer > stats_interval) {
            print_processing_stats(ctx);
            stats_timer = current_tsc;
        }
    }
    
    return 0;
}

// Initialize processing context
struct processing_context *init_processing_context(uint16_t port_id, uint16_t queue_id)
{
    struct processing_context *ctx;
    
    ctx = rte_zmalloc("processing_ctx", sizeof(*ctx), RTE_CACHE_LINE_SIZE);
    if (ctx == NULL) {
        return NULL;
    }
    
    ctx->port_id = port_id;
    ctx->queue_id = queue_id;
    
    // Create flow table
    ctx->flow_table = create_flow_table();
    if (ctx->flow_table == NULL) {
        rte_free(ctx);
        return NULL;
    }
    
    // Create clone pool for packet mirroring
    ctx->clone_pool = rte_pktmbuf_pool_create("clone_pool", 8192, 256, 0,
                                             RTE_MBUF_DEFAULT_BUF_SIZE,
                                             rte_socket_id());
    if (ctx->clone_pool == NULL) {
        rte_hash_free(ctx->flow_table);
        rte_free(ctx);
        return NULL;
    }
    
    return ctx;
}

// Print processing statistics
void print_processing_stats(struct processing_context *ctx)
{
    printf("Core %u Port %u Queue %u Statistics:\n",
           rte_lcore_id(), ctx->port_id, ctx->queue_id);
    printf("  Processed: %"PRIu64" packets (%"PRIu64" bytes)\n",
           ctx->stats.packets_processed, ctx->stats.bytes_processed);
    printf("  Forwarded: %"PRIu64" packets\n", ctx->stats.packets_forwarded);
    printf("  Dropped:   %"PRIu64" packets\n", ctx->stats.packets_dropped);
    printf("  Performance: %"PRIu64" cycles/packet\n", ctx->stats.cycles_per_packet);
    
    if (ctx->stats.packets_processed > 0) {
        double drop_rate = (double)ctx->stats.packets_dropped / 
                          ctx->stats.packets_processed * 100.0;
        printf("  Drop rate: %.2f%%\n", drop_rate);
    }
}

// Flow classification function (implement based on your requirements)
static uint32_t classify_new_flow(const struct flow_key *key)
{
    // Example classification logic
    // Return 1 for forward, 0 for drop, 2 for mirror
    
    // Allow HTTP traffic
    if (key->protocol == IPPROTO_TCP && 
        (rte_be_to_cpu_16(key->dst_port) == 80 || 
         rte_be_to_cpu_16(key->dst_port) == 443)) {
        return 1;  // Forward
    }
    
    // Allow DNS traffic
    if (key->protocol == IPPROTO_UDP && 
        rte_be_to_cpu_16(key->dst_port) == 53) {
        return 1;  // Forward
    }
    
    // Drop everything else by default
    return 0;  // Drop
}
```

This comprehensive DPDK programming guide demonstrates advanced techniques for building high-performance network applications. The implementation covers environment setup, device management, and sophisticated packet processing pipelines optimized for enterprise workloads. Key features include lock-free data structures, batch processing, cache optimization, and comprehensive performance monitoring suitable for ultra-low latency network applications.