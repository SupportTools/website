---
title: "Linux Kernel Networking: TCP/IP Stack Internals, Socket Buffers, and Performance Tuning"
date: 2030-01-09T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "TCP", "Kernel", "Performance", "NAPI", "Socket Buffers"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux network stack internals including sk_buff structure, TCP window scaling, NAPI polling, interrupt coalescing, and kernel bypass techniques for high-performance networking."
more_link: "yes"
url: "/linux-kernel-networking-tcp-ip-stack-internals-performance/"
---

Understanding how Linux processes network packets is essential for anyone responsible for high-performance network services. When a 10G NIC at line rate delivers 14.8 million 64-byte packets per second and your service handles only 3 million, the gap is almost always attributable to kernel networking overhead that can be reduced through informed configuration. This guide examines the Linux network stack from interrupt handling through the socket API, explaining how each layer contributes to latency and throughput, and how to tune each component for production workloads.

<!--more-->

# Linux Kernel Networking: TCP/IP Stack Internals, Socket Buffers, and Performance Tuning

## The Journey of a Packet: From NIC to Application

When a packet arrives at your server, it traverses this path:

```
Network → NIC PHY → NIC MAC → DMA to Ring Buffer → Hardware Interrupt
       → Interrupt Handler → NAPI Poll → netif_receive_skb → IP Layer
       → TCP Layer → Socket Receive Buffer → Application read()
```

Each step has configurable parameters that affect latency and throughput. Let us examine each in detail.

## Part 1: NIC Ring Buffers and DMA

### NIC Ring Buffer Architecture

Modern NICs use descriptor ring buffers for zero-copy packet reception. The NIC uses Direct Memory Access (DMA) to write packet data directly into pre-allocated kernel memory, avoiding a CPU-assisted copy from NIC FIFO to RAM.

```
       NIC Hardware              Kernel Memory
   ┌───────────────┐         ┌─────────────────────┐
   │  RX Descriptor │ ──DMA→ │  sk_buff data area  │
   │  Ring Buffer   │         │  (pre-allocated)    │
   │  [0] [1] [2]  │         └─────────────────────┘
   │  [3] [4] [5]  │
   └───────────────┘
```

Check and configure ring buffer sizes:

```bash
# Check current ring buffer sizes
ethtool -g eth0
# Output:
# Ring parameters for eth0:
# Pre-set maximums:
# RX:     4096
# TX:     4096
# Current hardware settings:
# RX:     512
# TX:     512

# Increase ring buffers to reduce packet drops under burst traffic
ethtool -G eth0 rx 4096 tx 4096

# Verify the change
ethtool -g eth0

# Check for ring buffer overruns (dropped at NIC level)
ethtool -S eth0 | grep -i "drop\|miss\|overflow"
# Look for: rx_dropped, rx_fifo_errors, rx_missed_errors
```

### Interrupt Coalescing

Without interrupt coalescing, each packet triggers a hardware interrupt, consuming enormous CPU time at high packet rates. Coalescing delays the interrupt until a configurable number of packets have arrived or a timeout expires.

```bash
# Check current coalescing settings
ethtool -c eth0
# Output:
# Coalesce parameters for eth0:
# Adaptive RX: off    TX: off
# rx-usecs: 3
# rx-frames: 0
# tx-usecs: 50
# tx-frames: 0

# Latency-optimized settings: low usecs, no frame coalescing
ethtool -C eth0 rx-usecs 50 rx-frames 0 tx-usecs 50 tx-frames 0

# Throughput-optimized settings: high usecs, large frame counts
ethtool -C eth0 rx-usecs 200 rx-frames 64 tx-usecs 200 tx-frames 64

# Adaptive coalescing (NIC auto-adjusts based on traffic)
ethtool -C eth0 adaptive-rx on adaptive-tx on

# For ultra-low latency (busy polling mode):
ethtool -C eth0 rx-usecs 0 rx-frames 1

# Make persistent (RHEL/CentOS)
cat > /etc/NetworkManager/dispatcher.d/99-eth0-coalesce << 'EOF'
#!/bin/bash
[ "$1" = "eth0" ] && [ "$2" = "up" ] && \
    ethtool -C eth0 rx-usecs 50 rx-frames 0
EOF
chmod +x /etc/NetworkManager/dispatcher.d/99-eth0-coalesce
```

## Part 2: NAPI and the Softirq Network Subsystem

### NAPI (New API) Polling

NAPI is the packet reception model used by all modern Linux NICs. When the first packet arrives, the NIC fires a hardware interrupt. The interrupt handler disables further NIC interrupts and schedules a NAPI poll. The kernel then polls the NIC at the next softirq opportunity, processing up to `net.core.netdev_budget` packets before re-enabling interrupts.

This transforms O(packets) interrupt overhead into O(poll-cycles) overhead.

```c
/* Simplified NAPI flow (for understanding, not for modification) */
/* NIC driver interrupt handler */
static irqreturn_t nic_interrupt(int irq, void *data)
{
    struct nic_ring *ring = data;

    /* Disable interrupts for this queue */
    nic_disable_irq(ring);

    /* Schedule NAPI poll */
    napi_schedule(&ring->napi);

    return IRQ_HANDLED;
}

/* NAPI poll function - called from softirq context */
static int nic_napi_poll(struct napi_struct *napi, int budget)
{
    int cleaned = 0;

    while (cleaned < budget) {
        struct sk_buff *skb = nic_get_rx_packet(napi);
        if (!skb)
            break;

        /* Pass to network stack */
        netif_receive_skb(skb);
        cleaned++;
    }

    if (cleaned < budget) {
        /* No more packets - disable polling, re-enable interrupts */
        napi_complete_done(napi, cleaned);
        nic_enable_irq(napi->dev);
    }

    return cleaned;
}
```

Configure NAPI budget:

```bash
# NAPI poll budget per device (default: 300 packets per poll cycle)
sysctl -w net.core.netdev_budget=600

# Time budget for NAPI polling in microseconds (Linux 5.x)
sysctl -w net.core.netdev_budget_usecs=4000

# Maximum packets processed per softirq pass
sysctl -w net.core.netdev_max_backlog=10000

# Check softirq statistics
cat /proc/net/softnet_stat
# Column 1: processed packets
# Column 2: dropped packets (backlog full)
# Column 3: time_squeeze (NAPI budget exceeded)
# Column 10: received_rps (multiqueue)

# Parse softnet_stat for drops
awk '{
    split($0, cols, " ")
    printf "CPU%d: processed=%d dropped=%d throttled=%d\n",
           NR-1, strtonum("0x"cols[1]), strtonum("0x"cols[2]),
           strtonum("0x"cols[3])
}' /proc/net/softnet_stat
```

### RSS (Receive Side Scaling) and Multi-Queue NICs

Modern NICs support multiple hardware queues, distributing packet processing across CPU cores using a hash of the packet's 5-tuple.

```bash
# Check number of queues
ethtool -l eth0
# Output:
# Channel parameters for eth0:
# Pre-set maximums:
# RX:     0
# TX:     0
# Combined: 16
# Current hardware settings:
# Combined: 4

# Set queue count to match CPU count (or NUMA node CPU count)
ethtool -L eth0 combined $(nproc)

# View RSS hash configuration
ethtool -x eth0

# Configure RSS to hash on 5-tuple (src/dst IP, port, protocol)
ethtool -X eth0 hfunc toeplitz
ethtool -U eth0 flow-type tcp4 src-ip 0.0.0.0 m 0.0.0.0 action 0

# Pin NIC queues to specific CPUs (important for NUMA)
# Queue 0 → CPU 0, Queue 1 → CPU 1, etc.
for i in $(seq 0 3); do
    IRQ=$(grep "eth0-$i" /proc/interrupts | awk '{print $1}' | tr -d ':')
    echo $((1 << i)) > /proc/irq/${IRQ}/smp_affinity
done

# Verify affinity
grep "eth0" /proc/interrupts
```

## Part 3: The sk_buff Structure

The `sk_buff` (socket buffer) is the core data structure for packet storage in the Linux kernel. Understanding it is crucial for performance optimization.

```c
/* Simplified sk_buff layout (from include/linux/skbuff.h) */
struct sk_buff {
    /* These two members must be first - they are used in list operations */
    struct sk_buff     *next;
    struct sk_buff     *prev;

    /* Device and socket this buffer belongs to */
    struct net_device  *dev;
    struct sock        *sk;

    /* Timestamps */
    ktime_t            tstamp;

    /* Control block - protocol specific data */
    char               cb[48];  /* 48 bytes for protocol use */

    /* Data pointers - crucial for understanding memory layout */
    unsigned char      *head;   /* Start of allocated buffer */
    unsigned char      *data;   /* Start of actual packet data */
    unsigned char      *tail;   /* End of actual packet data */
    unsigned char      *end;    /* End of allocated buffer */

    /* Length fields */
    unsigned int       len;     /* Length of actual packet data */
    unsigned int       data_len; /* Length of paged data */
    unsigned int       truesize; /* Length of memory consumed */

    /* Protocol-specific offsets (set as packet traverses stack) */
    sk_buff_data_t     mac_header;
    sk_buff_data_t     network_header;
    sk_buff_data_t     transport_header;

    /* Checksum and GSO info */
    __wsum             csum;
    __u32              priority;
    __u8               ip_summed;
    __u8               csum_valid;
    __u16              gso_size;
    __u16              gso_segs;
    netdev_features_t  features;
};
```

The memory layout of sk_buff data:

```
  head                            tail    end
   |                               |       |
   v                               v       v
   ┌──────────┬──────────────────────┬─────┐
   │  headroom │    packet data       │ pad │
   │(push room)│ [eth][ip][tcp][data] │     │
   └──────────┴──────────────────────┴─────┘
               ^
               data
```

The headroom allows the kernel to prepend headers without copying as packets traverse up the stack.

### sk_buff Cloning and Fragmentation

Zero-copy techniques rely on `sk_buff` structure sharing:

```bash
# Monitor sk_buff allocation pressure
cat /proc/net/sockstat
# Output includes: sockets: used X
# For sk_buff allocation stats:
bpftrace -e '
kprobe:__alloc_skb {
    @alloc[comm] = count();
}
kprobe:kfree_skb {
    @free[comm] = count();
}
interval:s:5 {
    print(@alloc); print(@free);
    clear(@alloc); clear(@free);
}
'
```

## Part 4: TCP Socket Buffer Tuning

The socket receive and send buffers are the primary bottleneck for high-throughput TCP connections. Understanding the relationship between buffer size, TCP window size, and bandwidth-delay product (BDP) is essential.

```
BDP = Bandwidth × RTT
For 10Gbps with 10ms RTT:
BDP = 10,000,000,000 / 8 × 0.010 = 12,500,000 bytes = ~12MB

Your TCP buffer must be >= BDP to achieve line-rate throughput
```

### Socket Buffer Configuration

```bash
# Current socket buffer settings
sysctl net.core.rmem_default  # Default receive buffer
sysctl net.core.rmem_max      # Maximum receive buffer
sysctl net.core.wmem_default  # Default send buffer
sysctl net.core.wmem_max      # Maximum send buffer

# TCP-specific buffers (min, default, max)
sysctl net.ipv4.tcp_rmem  # e.g.: 4096 87380 6291456
sysctl net.ipv4.tcp_wmem  # e.g.: 4096 16384 4194304

# High-throughput settings for 10G+ networks
cat >> /etc/sysctl.d/99-network-performance.conf << 'EOF'
# Core socket buffer maximums (256MB)
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216

# TCP socket buffers: min=4K, default=16MB, max=256MB
net.ipv4.tcp_rmem = 4096 16777216 268435456
net.ipv4.tcp_wmem = 4096 16777216 268435456

# Enable TCP buffer auto-tuning
net.ipv4.tcp_moderate_rcvbuf = 1

# Increase the maximum TCP socket backlog
net.core.netdev_max_backlog = 250000

# TCP connection queue
net.ipv4.tcp_max_syn_backlog = 65536
net.core.somaxconn = 65536

# Enable BBR congestion control (Linux 4.9+)
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq

# TCP keepalive tuning (for detecting dead connections quickly)
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# Reduce TIME_WAIT accumulation
net.ipv4.tcp_fin_timeout = 10
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.tcp_tw_reuse = 1

# TCP offloading features
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_dsack = 1
net.ipv4.tcp_fack = 1

# Increase ephemeral port range
net.ipv4.ip_local_port_range = 1024 65535
EOF

sysctl -p /etc/sysctl.d/99-network-performance.conf
```

### TCP Window Scaling

TCP Window Scaling allows advertised window sizes larger than 65535 bytes (the 16-bit window field limit). It is critical for high-bandwidth, high-latency links.

```bash
# Verify window scaling is enabled
sysctl net.ipv4.tcp_window_scaling
# Should be: 1

# Capture a TCP handshake to verify window scale option
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0' \
    -c 10 -v 2>/dev/null | grep "wscale"

# Check effective window sizes in use
ss -tn | head -20
# Recv-Q shows receive buffer used, Send-Q shows send buffer used

# ss with socket memory details
ss -tmni 'dst 10.0.0.1' | grep -A3 "tcp"
# Look for: rcv_space, snd_wnd, rcv_wnd
```

### Monitoring TCP Buffer Usage

```bash
# TCP buffer exhaustion monitoring script
cat > monitor-tcp-buffers.sh << 'EOF'
#!/bin/bash
echo "=== TCP Buffer Utilization ==="
echo "Connections with high receive buffer usage (>1MB):"
ss -tn state established | awk '$3 > 1048576 {print}' | head -20

echo ""
echo "Connections with high send queue (>1MB):"
ss -tn state established | awk '$2 > 1048576 {print}' | head -20

echo ""
echo "TCP statistics:"
ss -s

echo ""
echo "Socket memory pressure:"
sysctl net.ipv4.tcp_mem
echo "Current usage: $(cat /proc/net/sockstat | grep TCP)"

echo ""
echo "Dropped packets from receive buffer overflow:"
netstat -s | grep "receive buffer"
EOF
chmod +x monitor-tcp-buffers.sh
```

## Part 5: TCP Congestion Control Deep Dive

### BBR (Bottleneck Bandwidth and Round-trip propagation time)

BBR is Google's congestion control algorithm, designed to achieve high throughput and low latency simultaneously by explicitly modeling the network.

```bash
# Enable BBR
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.core.default_qdisc=fq

# Verify BBR is active
sysctl net.ipv4.tcp_congestion_control
# Should show: bbr

# Check available algorithms
cat /proc/sys/net/ipv4/tcp_available_congestion_control

# Load BBR module if not available
modprobe tcp_bbr

# Monitor BBR behavior with ss
ss -tin dst 10.0.0.1 | grep bbr
# Look for: bbr:(bw:X,mrtt:X,pacing_gain:X,cwnd_gain:X)
```

### Comparing Congestion Controllers

```bash
# Test throughput comparison
# Install iperf3
apt-get install -y iperf3

# Server side
iperf3 -s -p 5201

# Client side - test with cubic
sysctl -w net.ipv4.tcp_congestion_control=cubic
iperf3 -c server_ip -t 30 -P 4 --congestion cubic

# Client side - test with BBR
sysctl -w net.ipv4.tcp_congestion_control=bbr
iperf3 -c server_ip -t 30 -P 4 --congestion bbr

# Test retransmission rates during congestion
iperf3 -c server_ip -t 60 -J | jq '.end.streams[0].sender.retransmits'
```

## Part 6: NIC Offloading Features

Modern NICs can perform many operations that would otherwise consume CPU cycles.

```bash
# List all offload features
ethtool -k eth0

# Key offload features and their impact:
# tx-checksumming: NIC computes TCP/UDP/IP checksums (on = fast, off = CPU does it)
# rx-checksumming: NIC verifies checksums (saves CPU on receive path)
# scatter-gather: Allows sk_buff to point to non-contiguous memory (zero-copy)
# tcp-segmentation-offload (TSO): NIC segments large TCP frames (reduce interrupts)
# generic-segmentation-offload (GSO): Software equivalent of TSO
# large-receive-offload (LRO): NIC coalesces small packets into larger ones
# generic-receive-offload (GRO): Software LRO (safe for routing)
# receive-hashing (RPS/RFS): Hash-based queue steering to CPUs

# Enable all offloads for throughput
ethtool -K eth0 tso on gso on gro on lro off rx on tx on sg on
# Note: LRO is disabled because it breaks routing scenarios

# For lowest latency (at cost of throughput):
ethtool -K eth0 tso off gso off gro off lro off

# Check if GRO is working
ethtool -S eth0 | grep -i "gro"
# Should see: gro_rx_packets, gro_merged
```

### TSO and GSO Impact

```bash
# Visualize TSO impact on CPU usage
bpftrace -e '
kprobe:tcp_write_xmit {
    @tso_size[comm] = hist(arg2);
}
interval:s:5 {
    print(@tso_size);
    clear(@tso_size);
}
'

# Measure CPU cycles consumed by network stack
perf stat -e \
    'net:napi_poll,net:net_dev_xmit,net:net_dev_queue,\
    skb:consume_skb,skb:kfree_skb' \
    -a sleep 10
```

## Part 7: Kernel Bypass with DPDK and io_uring

### io_uring for High-Performance Network I/O

io_uring (introduced in Linux 5.1) provides an asynchronous I/O interface that eliminates syscall overhead for high-throughput I/O by using shared ring buffers between kernel and userspace.

```c
/* io_uring network server example (simplified) */
#include <liburing.h>
#include <sys/socket.h>
#include <netinet/in.h>

#define QUEUE_DEPTH 1024
#define BUFFER_SIZE 4096

struct connection {
    int fd;
    char buf[BUFFER_SIZE];
};

int main(void)
{
    struct io_uring ring;

    /* Initialize io_uring with SQPOLL for kernel-side polling */
    struct io_uring_params params = {
        .flags = IORING_SETUP_SQPOLL,  /* Enable kernel-side SQ polling */
        .sq_thread_idle = 2000,         /* Poll for 2 seconds then sleep */
    };

    io_uring_queue_init_params(QUEUE_DEPTH, &ring, &params);

    /* Create and bind listening socket */
    int lfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(8080),
        .sin_addr.s_addr = INADDR_ANY,
    };
    setsockopt(lfd, SOL_SOCKET, SO_REUSEPORT, &(int){1}, sizeof(int));
    bind(lfd, (struct sockaddr *)&addr, sizeof(addr));
    listen(lfd, SOMAXCONN);

    /* Submit initial accept operation */
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    struct sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);
    io_uring_prep_accept(sqe, lfd,
        (struct sockaddr *)&client_addr, &client_len, 0);
    io_uring_sqe_set_data(sqe, NULL);  /* NULL = accept operation */
    io_uring_submit(&ring);

    /* Event loop */
    while (1) {
        struct io_uring_cqe *cqe;
        io_uring_wait_cqe(&ring, &cqe);

        struct connection *conn = io_uring_cqe_get_data(cqe);

        if (conn == NULL) {
            /* Accept completion - new connection */
            int client_fd = cqe->res;
            struct connection *new_conn = malloc(sizeof(struct connection));
            new_conn->fd = client_fd;

            /* Submit read for new connection */
            struct io_uring_sqe *rsqe = io_uring_get_sqe(&ring);
            io_uring_prep_recv(rsqe, client_fd, new_conn->buf,
                               BUFFER_SIZE, 0);
            io_uring_sqe_set_data(rsqe, new_conn);

            /* Re-submit accept for next connection */
            struct io_uring_sqe *asqe = io_uring_get_sqe(&ring);
            io_uring_prep_accept(asqe, lfd,
                (struct sockaddr *)&client_addr, &client_len, 0);
            io_uring_sqe_set_data(asqe, NULL);

            io_uring_submit(&ring);
        } else {
            /* Read completion */
            if (cqe->res > 0) {
                /* Echo back */
                struct io_uring_sqe *wsqe = io_uring_get_sqe(&ring);
                io_uring_prep_send(wsqe, conn->fd, conn->buf, cqe->res, 0);
                io_uring_sqe_set_data(wsqe, conn);
                io_uring_submit(&ring);
            } else {
                /* Connection closed */
                close(conn->fd);
                free(conn);
            }
        }

        io_uring_cqe_seen(&ring, cqe);
    }

    io_uring_queue_exit(&ring);
    return 0;
}
```

### SO_BUSY_POLL for Ultra-Low Latency

```bash
# Enable busy polling globally
sysctl -w net.core.busy_poll=50        # Poll for 50 microseconds
sysctl -w net.core.busy_read=50        # Read busy polling

# Enable per-socket busy polling
# In application code:
# int idle = 50;
# setsockopt(fd, SOL_SOCKET, SO_BUSY_POLL, &idle, sizeof(idle));

# Monitor busy poll statistics
cat /proc/net/busy_poll
```

## Part 8: Advanced Profiling and Diagnosis

### Network Performance Profiling with perf and eBPF

```bash
# Identify hot functions in network path
perf top -e cycles:k --call-graph dwarf \
    --filter "net,tcp,ip,skb,napi" 2>/dev/null | head -50

# Full network stack flame graph
perf record -g -a -e cycles:k \
    --filter "ip_rcv,tcp_v4_rcv,tcp_recvmsg" \
    sleep 10
perf script | stackcollapse-perf.pl | flamegraph.pl > net-flamegraph.svg

# eBPF: track TCP state transitions
bpftrace -e '
kprobe:tcp_set_state {
    @states[arg1] = count();  /* arg1 is new state */
}
interval:s:5 {
    /* TCP states: 1=ESTABLISHED, 4=FIN_WAIT1, 6=TIME_WAIT, etc. */
    print(@states);
    clear(@states);
}
'

# eBPF: measure TCP receive latency (from NIC to application)
bpftrace -e '
/* Timestamp when packet enters TCP layer */
kprobe:tcp_v4_rcv {
    @start[arg0] = nsecs;
}
/* Timestamp when application calls recv() */
kretprobe:tcp_recvmsg {
    $skb = arg0;
    if (@start[$skb]) {
        @latency_ns = hist(nsecs - @start[$skb]);
        delete(@start[$skb]);
    }
}
interval:s:10 {
    print(@latency_ns);
    clear(@latency_ns);
}
'
```

### Network Queue Disciplines (tc qdisc)

```bash
# Check current qdisc configuration
tc qdisc show dev eth0

# For BBR: use fq qdisc with pacing
tc qdisc replace dev eth0 root fq maxrate 10gbit pacing

# Check queue length and drops
tc -s qdisc show dev eth0

# For low-latency with fair queuing
tc qdisc replace dev eth0 root fq_codel

# Monitor qdisc statistics
tc -s qdisc show dev eth0 | grep -E "Sent|dropped|overlimits"
```

## Comprehensive Tuning Checklist

```bash
#!/bin/bash
# linux-network-tuning.sh - Apply all tuning settings

set -e

echo "=== Applying Linux Network Performance Tuning ==="

# 1. Ring buffers
echo "--- Configuring NIC ring buffers ---"
for iface in $(ls /sys/class/net/ | grep -v lo); do
    ethtool -G "$iface" rx 4096 tx 4096 2>/dev/null || true
done

# 2. Interrupt coalescing (balanced setting)
for iface in $(ls /sys/class/net/ | grep -v lo); do
    ethtool -C "$iface" rx-usecs 50 tx-usecs 50 2>/dev/null || true
done

# 3. Multi-queue optimization
for iface in $(ls /sys/class/net/ | grep -v lo); do
    QUEUES=$(cat /sys/class/net/"$iface"/queues/rx-*/rps_cpus 2>/dev/null | wc -l)
    if [ "$QUEUES" -gt 0 ]; then
        CPU_MASK=$(printf '%x' $(( (1 << $(nproc)) - 1 )))
        for file in /sys/class/net/"$iface"/queues/rx-*/rps_cpus; do
            echo "$CPU_MASK" > "$file"
        done
        for file in /sys/class/net/"$iface"/queues/tx-*/xps_cpus; do
            echo "$CPU_MASK" > "$file"
        done
    fi
done

# 4. Offload features
for iface in $(ls /sys/class/net/ | grep -v lo); do
    ethtool -K "$iface" tso on gso on gro on sg on rx on tx on 2>/dev/null || true
done

# 5. Kernel parameters
sysctl -w net.core.rmem_max=268435456
sysctl -w net.core.wmem_max=268435456
sysctl -w net.core.rmem_default=16777216
sysctl -w net.core.wmem_default=16777216
sysctl -w net.ipv4.tcp_rmem="4096 16777216 268435456"
sysctl -w net.ipv4.tcp_wmem="4096 16777216 268435456"
sysctl -w net.core.netdev_max_backlog=250000
sysctl -w net.core.netdev_budget=600
sysctl -w net.ipv4.tcp_max_syn_backlog=65536
sysctl -w net.core.somaxconn=65536
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.core.default_qdisc=fq
sysctl -w net.ipv4.tcp_window_scaling=1
sysctl -w net.ipv4.tcp_timestamps=1
sysctl -w net.ipv4.tcp_sack=1
sysctl -w net.ipv4.tcp_moderate_rcvbuf=1
sysctl -w net.ipv4.tcp_keepalive_time=60
sysctl -w net.ipv4.tcp_keepalive_intvl=10
sysctl -w net.ipv4.tcp_keepalive_probes=6
sysctl -w net.ipv4.tcp_fin_timeout=10
sysctl -w net.ipv4.tcp_tw_reuse=1
sysctl -w net.ipv4.ip_local_port_range="1024 65535"

echo "=== Network tuning applied successfully ==="
echo "Run: ./monitor-tcp-buffers.sh to verify"
```

## Key Takeaways

The Linux network stack is highly configurable, and the default settings are optimized for general-purpose server workloads rather than high-performance scenarios. The key insights:

**Ring buffer sizing** is the first thing to check when experiencing packet drops. A ring buffer that empties before NAPI can poll it will drop packets silently at the NIC level.

**NAPI budget** controls the trade-off between throughput (higher budget = process more packets per softirq) and latency (lower budget = more frequent context switches back to application threads).

**TCP buffer sizes** must be larger than the bandwidth-delay product of your highest-latency connections. With modern auto-tuning, the maximum buffer size is the binding constraint.

**BBR consistently outperforms CUBIC** on high-bandwidth, variable-latency connections because it explicitly models the network rather than reacting to loss events. Enable it unconditionally for new deployments.

**NIC offloading** (TSO, GRO, checksum offload) should be enabled unless you have a specific reason to disable it. The CPU savings are substantial, and modern drivers handle the edge cases correctly.
