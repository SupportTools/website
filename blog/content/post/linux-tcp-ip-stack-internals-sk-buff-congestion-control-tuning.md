---
title: "Linux TCP/IP Stack Internals: Socket Buffers, Congestion Control, and Tuning"
date: 2029-07-08T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "Networking", "Performance", "Kernel", "Socket Buffers", "Congestion Control"]
categories: ["Linux", "Networking", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into the Linux TCP/IP stack: sk_buff lifecycle, TCP receive windows, socket buffer sizing, BBR vs CUBIC vs RENO congestion control algorithms, tcp_mem tuning, and optimizing high-bandwidth connections in production."
more_link: "yes"
url: "/linux-tcp-ip-stack-internals-sk-buff-congestion-control-tuning/"
---

Understanding the Linux TCP/IP stack at the kernel level is essential for engineers who need to squeeze maximum throughput from high-bandwidth connections, debug mysterious packet drops, or tune production servers handling millions of concurrent connections. This guide covers the internals that matter most: the sk_buff lifecycle, TCP receive window mechanics, socket buffer sizing strategy, congestion control algorithm selection, and the kernel parameters that control memory pressure.

<!--more-->

# Linux TCP/IP Stack Internals: Socket Buffers, Congestion Control, and Tuning

## The sk_buff: Linux's Universal Packet Container

Every network packet in the Linux kernel is represented by a `struct sk_buff` (socket buffer). Understanding its lifecycle is fundamental to understanding network performance.

### sk_buff Structure Overview

```c
// Simplified representation of key sk_buff fields (from include/linux/skbuff.h)
struct sk_buff {
    /* Data pointers */
    unsigned char       *head;      // Start of allocated buffer
    unsigned char       *data;      // Start of actual packet data
    unsigned char       *tail;      // End of packet data
    unsigned char       *end;       // End of allocated buffer

    /* Packet metadata */
    struct sock         *sk;        // Owning socket (NULL for forwarded packets)
    struct net_device   *dev;       // Network device
    __u32               priority;   // Packet priority (for QoS)
    __be16              protocol;   // L3 protocol (ETH_P_IP, ETH_P_IPV6)

    /* Transport layer */
    union {
        struct tcphdr   *th;        // TCP header
        struct udphdr   *uh;        // UDP header
        struct icmphdr  *icmph;     // ICMP header
    } h;

    /* Network layer */
    union {
        struct iphdr    *iph;       // IPv4 header
        struct ipv6hdr  *ipv6h;     // IPv6 header
    } nh;

    /* Fragmentation and scatter-gather */
    unsigned int        len;        // Length of actual data
    unsigned int        data_len;   // Length in frags
    __u16               nr_frags;   // Number of DMA fragments
    skb_frag_t          frags[MAX_SKB_FRAGS]; // DMA scatter-gather list

    /* Timestamps and tracing */
    ktime_t             tstamp;     // Receive timestamp
    __u32               hash;       // Flow hash for RSS/RPS

    /* Cloning and reference counting */
    atomic_t            users;      // Reference count
    struct sk_buff      *next;      // Next in queue
    struct sk_buff      *prev;      // Previous in queue
};
```

### sk_buff Memory Layout

The memory layout of an sk_buff uses a headroom/tailroom model that allows header prepending and appending without reallocation:

```
 +------------------+  <-- head
 |   headroom       |  Reserved for protocol headers (L2, L3, L4)
 +------------------+  <-- data
 |   packet data    |
 +------------------+  <-- tail
 |   tailroom       |  Reserved for protocol trailers
 +------------------+  <-- end
```

When a packet travels up the network stack, `skb_pull()` advances the `data` pointer (consuming header bytes). When traveling down, `skb_push()` moves `data` backward to prepend headers.

### sk_buff Lifecycle: Receive Path

```
NIC Hardware
    |
    v (DMA into ring buffer)
Driver ISR / NAPI poll
    |
    v skb_alloc() or page_pool_alloc()
netif_receive_skb()
    |
    v
ip_rcv()          [L3 - IP processing]
    |
    v
tcp_v4_rcv()      [L4 - TCP demultiplexing]
    |
    v
tcp_rcv_established()
    |
    v
sk_add_backlog() or tcp_queue_rcv()
    |
    v (copied to user space via recv()/read())
kfree_skb()       [reference count drops to 0]
```

You can trace this path with `perf`:

```bash
# Trace sk_buff allocation and freeing
sudo perf probe -a 'skb_alloc=__alloc_skb size'
sudo perf probe -a 'skb_free=kfree_skb reason'
sudo perf record -e probe:skb_alloc,probe:skb_free -g -- sleep 5
sudo perf script | head -100
```

### sk_buff Cloning vs Copying

A critical distinction for performance:

```c
// Clone: increments reference count, shares data
// Used when same packet goes to multiple destinations (e.g., multicast, tapping)
struct sk_buff *skb_clone(struct sk_buff *skb, gfp_t gfp_mask);

// Copy: full data copy
// Used when data must be modified (e.g., NAT, encapsulation)
struct sk_buff *skb_copy(const struct sk_buff *skb, gfp_t gfp_mask);

// Copy with headroom for header prepending
struct sk_buff *skb_copy_expand(const struct sk_buff *skb,
                                int newheadroom, int newtailroom,
                                gfp_t gfp_mask);
```

Monitoring clone/copy overhead with `ftrace`:

```bash
# Enable function tracing for skb operations
echo 'skb_clone' > /sys/kernel/debug/tracing/set_ftrace_filter
echo 'skb_copy' >> /sys/kernel/debug/tracing/set_ftrace_filter
echo function > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 2
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | grep -c skb_clone
cat /sys/kernel/debug/tracing/trace | grep -c skb_copy
```

## TCP Receive Window: Flow Control Mechanics

The TCP receive window is one of the most misunderstood aspects of TCP performance. It controls how much unacknowledged data the sender can have in flight.

### Window Size Calculation

The advertised receive window is determined by the amount of free space in the socket's receive buffer:

```
receive_window = receive_buffer_size - bytes_in_receive_queue
```

The kernel computes the actual window to advertise:

```c
// Simplified from net/ipv4/tcp_output.c
static u16 tcp_select_window(struct sock *sk)
{
    struct tcp_sock *tp = tcp_sk(sk);
    u32 old_win = tp->rcv_wnd;
    u32 cur_win = tcp_receive_window(tp);
    u32 new_win = __tcp_select_window(sk);

    // Window shrinking is forbidden by RFC 793
    if (new_win < cur_win) {
        new_win = ALIGN(cur_win, 1 << tp->rx_opt.rcv_wscale);
    }
    return new_win;
}
```

### Window Scaling

For connections with high bandwidth-delay product (BDP), the standard 16-bit window field limits throughput:

```
Max throughput without scaling = 65535 bytes / RTT
# On a 100ms RTT link: 65535 * 8 / 0.1 = ~5.2 Mbps

With window scaling (scale factor 7):
Max window = 65535 * 2^7 = 8,388,480 bytes
Max throughput = 8,388,480 * 8 / 0.1 = ~671 Mbps
```

Checking window scale negotiation:

```bash
# Capture TCP handshake and check window scale option
tcpdump -i eth0 -nn 'tcp[tcpflags] & (tcp-syn) != 0' -w /tmp/syn.pcap
tshark -r /tmp/syn.pcap -Y 'tcp.flags.syn==1' \
  -T fields -e tcp.window_size -e tcp.options.wscale.shift

# Check current socket window sizes
ss -tni | grep -A1 '10\.0\.'
# Look for: rcv_wnd, snd_wnd fields
```

### Receive Buffer Auto-Tuning

Modern Linux kernels implement receive buffer auto-tuning (`tcp_moderate_rcvbuf`). The kernel dynamically adjusts the receive buffer based on measured RTT and throughput:

```c
// From net/ipv4/tcp_input.c - tcp_rcv_rtt_measure_ts()
// The kernel tracks:
// tp->rcv_rtt_est.rtt  - measured receive-side RTT
// tp->rcvq_space.space - optimal receive buffer size
// tp->rcvq_space.seq   - sequence number for measurement
```

Monitor auto-tuning behavior:

```bash
# Watch socket buffer sizes for a connection
watch -n 0.5 'ss -tni dst 192.168.1.100 | grep rcv_wnd'

# Check if auto-tuning is enabled
sysctl net.ipv4.tcp_moderate_rcvbuf
# 1 = enabled (default)

# Observe buffer growth over time
ss -tm | awk '/skmem/{print $0}'
# skmem:(r<rcvbuf>,rb<rcvbuf_max>,t<sndbuf>,tb<sndbuf_max>,...)
```

## Socket Buffer Sizing

Socket buffers are the primary lever for TCP throughput tuning. Getting the sizing right requires understanding the bandwidth-delay product.

### Bandwidth-Delay Product Calculation

```bash
#!/bin/bash
# Calculate optimal buffer size for a connection

RTT_MS=50          # Round-trip time in milliseconds
BANDWIDTH_GBPS=10  # Link bandwidth in Gbps

# BDP = bandwidth * RTT
BDP_BYTES=$(echo "scale=0; ($BANDWIDTH_GBPS * 1000 * 1000 * 1000 / 8) * ($RTT_MS / 1000)" | bc)
echo "Bandwidth-Delay Product: ${BDP_BYTES} bytes"
echo "Recommended buffer size (2x BDP): $((BDP_BYTES * 2)) bytes"
echo "In MB: $((BDP_BYTES * 2 / 1024 / 1024)) MB"

# For 10Gbps with 50ms RTT:
# BDP = 10Gbps/8 * 0.05s = 62,500,000 bytes (~60MB)
# Recommended buffer = 125,000,000 bytes (~120MB)
```

### Kernel Socket Buffer Parameters

```bash
# /etc/sysctl.d/99-tcp-buffers.conf

# Maximum socket receive buffer (bytes)
# Default: 212992 (208KB) - far too small for high-bandwidth links
net.core.rmem_max = 134217728        # 128MB

# Maximum socket send buffer (bytes)
net.core.wmem_max = 134217728        # 128MB

# Default socket receive buffer (bytes)
net.core.rmem_default = 212992       # 208KB - kernel auto-tunes from here

# Default socket send buffer (bytes)
net.core.wmem_default = 212992       # 208KB

# TCP receive buffer: min, default, max (bytes)
# min: never go below this (even under memory pressure)
# default: initial buffer size
# max: maximum auto-tuned size (capped by rmem_max)
net.ipv4.tcp_rmem = 4096 87380 134217728

# TCP send buffer: min, default, max (bytes)
net.ipv4.tcp_wmem = 4096 65536 134217728

# TCP memory pressure thresholds (in pages, typically 4096 bytes each)
# low: below this, TCP is not constrained
# pressure: above this, TCP enters memory pressure mode
# high: absolute maximum pages for TCP
net.ipv4.tcp_mem = 786432 1048576 1572864
# For 128GB RAM system, consider:
# net.ipv4.tcp_mem = 8388608 12582912 16777216

# Enable TCP window scaling (required for > 65535 byte windows)
net.ipv4.tcp_window_scaling = 1

# Enable selective acknowledgments
net.ipv4.tcp_sack = 1

# Enable forward acknowledgment
net.ipv4.tcp_fack = 1

# Enable timestamps (required for PAWS, helps with RTT estimation)
net.ipv4.tcp_timestamps = 1

# Auto-tune receive buffers
net.ipv4.tcp_moderate_rcvbuf = 1
```

Apply and verify:

```bash
sysctl -p /etc/sysctl.d/99-tcp-buffers.conf

# Verify settings are active
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max

# Test with iperf3 to measure actual throughput
iperf3 -s &
iperf3 -c <server_ip> -t 30 -P 4 --get-server-output
```

### Per-Socket Buffer Configuration

Applications can override system defaults for individual sockets:

```go
package main

import (
    "fmt"
    "net"
    "syscall"
)

func setSocketBuffers(conn net.Conn, recvBuf, sendBuf int) error {
    rawConn, err := conn.(*net.TCPConn).SyscallConn()
    if err != nil {
        return fmt.Errorf("getting raw conn: %w", err)
    }

    var setErr error
    rawConn.Control(func(fd uintptr) {
        // Set receive buffer
        if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_RCVBUF, recvBuf); err != nil {
            setErr = fmt.Errorf("SO_RCVBUF: %w", err)
            return
        }
        // Set send buffer
        if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_SNDBUF, sendBuf); err != nil {
            setErr = fmt.Errorf("SO_SNDBUF: %w", err)
            return
        }
        // Verify what kernel actually set (kernel doubles the value)
        rcvBufActual, _ := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
        sndBufActual, _ := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF)
        fmt.Printf("Actual recv buffer: %d bytes\n", rcvBufActual)
        fmt.Printf("Actual send buffer: %d bytes\n", sndBufActual)
    })
    return setErr
}

// High-throughput TCP server with optimized buffers
func optimizedListener() {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            var sockErr error
            c.Control(func(fd uintptr) {
                // 4MB receive buffer
                sockErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                    syscall.SO_RCVBUF, 4*1024*1024)
                if sockErr != nil {
                    return
                }
                // 4MB send buffer
                sockErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                    syscall.SO_SNDBUF, 4*1024*1024)
            })
            return sockErr
        },
    }

    ln, err := lc.Listen(nil, "tcp", ":8080")
    if err != nil {
        panic(err)
    }
    defer ln.Close()
    // ... accept loop
    _ = ln
}
```

## Congestion Control Algorithms

Linux supports multiple TCP congestion control algorithms, each with different performance characteristics. Selecting the right one can dramatically impact throughput.

### Available Algorithms

```bash
# List available congestion control algorithms
cat /proc/sys/net/ipv4/tcp_available_congestion_control
# cubic reno bbr htcp lp veno westwood

# Check current default
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = cubic

# Check allowed algorithms (non-root can switch to these)
sysctl net.ipv4.tcp_allowed_congestion_control
```

### TCP RENO: Classic Loss-Based

RENO is the original TCP congestion control. It uses packet loss as its primary congestion signal:

```
Slow Start: cwnd doubles each RTT until ssthresh
Congestion Avoidance: cwnd increases by 1 MSS per RTT (additive increase)
Loss Detection: cwnd halved (multiplicative decrease)

State machine:
SLOW_START -> CA_OPEN (cwnd >= ssthresh)
CA_OPEN -> CA_RECOVERY (3 duplicate ACKs)
CA_RECOVERY -> CA_OPEN (recovery complete)
CA_OPEN -> CA_LOSS (RTO timeout)
```

RENO limitations:
- Treats all loss as congestion (misidentifies random loss on wireless)
- Cannot distinguish between buffer overflow and link issues
- Performance degrades in high-latency, high-bandwidth paths

### TCP CUBIC: Default Linux Algorithm

CUBIC replaced RENO as the default in Linux 2.6.19. It uses a cubic function to control window growth:

```
Window function: W(t) = C(t - K)^3 + W_max

Where:
  t = time since last congestion event
  K = time to reach W_max
  C = scaling constant (default 0.4)
  W_max = window size at last congestion
```

```bash
# CUBIC tuning parameters
# /proc/sys/net/ipv4/ doesn't expose CUBIC directly
# Use tcp_cubic module parameters:
ls /sys/module/tcp_cubic/parameters/
# beta_scale  fast_convergence

# beta_scale: multiplicative decrease factor (default 717, ~0.7)
# Higher = more aggressive recovery
cat /sys/module/tcp_cubic/parameters/beta_scale

# fast_convergence: reduces W_max when bandwidth decreases (fairness)
cat /sys/module/tcp_cubic/parameters/fast_convergence
```

CUBIC performance profile:
- Excellent on high-bandwidth, low-latency datacenter links
- Good fairness between competing flows
- Can fill large buffers, contributing to bufferbloat
- Not optimal for paths with significant queuing delay

### TCP BBR: Bandwidth-Based Congestion Control

BBR (Bottleneck Bandwidth and Round-trip propagation time) was developed by Google and is fundamentally different from RENO and CUBIC. Instead of reacting to loss, BBR models the network pipe:

```
BBR Key Insight:
  Network operating point = max bandwidth at minimum RTT

  BBR measures:
    BtlBw = Maximum achieved delivery rate (bottleneck bandwidth)
    RTprop = Minimum observed RTT (propagation delay)

  BBR maintains:
    cwnd = BtlBw * RTprop * gain_factor
    pacing_rate = BtlBw * pacing_gain
```

BBR state machine:

```
STARTUP: Probe for bandwidth (2x growth like slow start)
         Exit when: BtlBw estimate plateaus

DRAIN:   Drain the queue filled during STARTUP
         Exit when: inflight <= BDP estimate

PROBE_BW: Steady state (cycles through 8-phase gain schedule)
          [1.25, 0.75, 1, 1, 1, 1, 1, 1] * BtlBw

PROBE_RTT: Temporarily reduce cwnd to 4 packets
           Purpose: Measure minimum RTT (clear standing queue)
           Duration: 200ms every ~10 seconds
```

Enabling BBR:

```bash
# Load BBR module
modprobe tcp_bbr

# Set as default
echo 'net.ipv4.tcp_congestion_control = bbr' >> /etc/sysctl.d/99-tcp-bbr.conf

# Enable FQ pacing (required for BBR pacing to work correctly)
echo 'net.core.default_qdisc = fq' >> /etc/sysctl.d/99-tcp-bbr.conf

sysctl -p /etc/sysctl.d/99-tcp-bbr.conf

# Verify BBR is active
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = bbr

# Verify FQ is active on interfaces
tc qdisc show dev eth0
# qdisc fq 8001: root refcnt 2 limit 10000p flow_limit 100p ...
```

### BBR vs CUBIC Comparison

```bash
#!/bin/bash
# Run comparative throughput test between BBR and CUBIC

SERVER_IP="10.0.0.1"
DURATION=30

echo "=== Testing CUBIC ==="
sysctl -w net.ipv4.tcp_congestion_control=cubic
iperf3 -c $SERVER_IP -t $DURATION -P 4 --get-server-output 2>&1 | \
  grep -E "SUM.*sender|SUM.*receiver"

echo ""
echo "=== Testing BBR ==="
sysctl -w net.ipv4.tcp_congestion_control=bbr
iperf3 -c $SERVER_IP -t $DURATION -P 4 --get-server-output 2>&1 | \
  grep -E "SUM.*sender|SUM.*receiver"
```

When to prefer each algorithm:

| Scenario | Recommended Algorithm |
|----------|----------------------|
| Datacenter, low latency (<1ms) | CUBIC or BBR |
| WAN, high BDP (>100ms, >1Gbps) | BBR |
| Wireless/lossy links | BBR |
| Mixed datacenter/WAN | BBR |
| Many competing flows, fairness critical | CUBIC |
| Very old kernel (<4.9) | CUBIC |

### Per-Connection Algorithm Selection

Applications can select congestion control per connection:

```go
package main

import (
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

const TCP_CONGESTION = 13 // from /usr/include/netinet/tcp.h

func setCongestionControl(conn *net.TCPConn, algo string) error {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return err
    }

    var setErr error
    rawConn.Control(func(fd uintptr) {
        b := []byte(algo + "\x00")
        setErr = syscall.SetsockoptString(int(fd),
            syscall.IPPROTO_TCP, TCP_CONGESTION, algo)
    })
    _ = unsafe.Pointer(nil) // suppress unused import
    return setErr
}

// Dial with specific congestion control
func dialWithBBR(address string) (*net.TCPConn, error) {
    conn, err := net.Dial("tcp", address)
    if err != nil {
        return nil, err
    }
    tcpConn := conn.(*net.TCPConn)
    if err := setCongestionControl(tcpConn, "bbr"); err != nil {
        // BBR not available, fall back gracefully
        fmt.Printf("BBR not available: %v, using system default\n", err)
    }
    return tcpConn, nil
}
```

## tcp_mem Tuning

The `net.ipv4.tcp_mem` parameter controls kernel-wide TCP memory allocation and is critical for servers with many concurrent connections.

### Understanding tcp_mem

```bash
# Current values (in pages, usually 4096 bytes each)
sysctl net.ipv4.tcp_mem
# net.ipv4.tcp_mem = 786432 1048576 1572864

# Convert to MB
PAGE_SIZE=$(getconf PAGE_SIZE)
read LOW PRESSURE HIGH < /proc/sys/net/ipv4/tcp_mem

echo "Low threshold:      $((LOW * PAGE_SIZE / 1024 / 1024)) MB"
echo "Pressure threshold: $((PRESSURE * PAGE_SIZE / 1024 / 1024)) MB"
echo "Max threshold:      $((HIGH * PAGE_SIZE / 1024 / 1024)) MB"
```

### Memory Pressure Behavior

```
Below low:     Normal operation, buffers auto-tune upward freely
low..pressure: TCP starts reducing buffer allocations
pressure..high: TCP enters pressure mode, limits new connections
Above high:    TCP refuses new socket allocations (ENOMEM)
```

Monitor memory pressure:

```bash
# Check current TCP memory usage
cat /proc/net/sockstat
# Tcp: inuse 1234 orphan 5 tw 678 alloc 1239 mem 98304

# mem field = pages currently used by TCP
# Compare against tcp_mem thresholds

# Watch for memory pressure events
watch -n 1 'cat /proc/net/sockstat; echo "---"; cat /proc/sys/net/ipv4/tcp_mem'

# Kernel logs when pressure is hit
dmesg | grep -i "TCP: out of memory"
dmesg | grep -i "TCP: Possible SYN flooding"
```

### Calculating Optimal tcp_mem

```bash
#!/bin/bash
# Calculate tcp_mem values based on system RAM and workload

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
PAGE_SIZE=$(getconf PAGE_SIZE)

# Reserve 80% of RAM for TCP (adjust based on workload)
TCP_MEM_BUDGET_MB=$((TOTAL_RAM_MB * 80 / 100))

# Thresholds: low=50%, pressure=75%, high=100% of budget
LOW_PAGES=$(( TCP_MEM_BUDGET_MB * 1024 * 1024 / PAGE_SIZE / 2 ))
PRESSURE_PAGES=$(( TCP_MEM_BUDGET_MB * 1024 * 1024 * 3 / 4 / PAGE_SIZE ))
HIGH_PAGES=$(( TCP_MEM_BUDGET_MB * 1024 * 1024 / PAGE_SIZE ))

echo "System RAM: ${TOTAL_RAM_MB} MB"
echo "TCP memory budget: ${TCP_MEM_BUDGET_MB} MB"
echo ""
echo "Recommended tcp_mem:"
echo "net.ipv4.tcp_mem = ${LOW_PAGES} ${PRESSURE_PAGES} ${HIGH_PAGES}"
echo ""
echo "In /etc/sysctl.d/99-tcp-mem.conf:"
echo "net.ipv4.tcp_mem = ${LOW_PAGES} ${PRESSURE_PAGES} ${HIGH_PAGES}"
```

### Complete tcp_mem Configuration

```bash
# /etc/sysctl.d/99-tcp-performance.conf
# For a 128GB production server

# TCP memory (pages): low, pressure, high
net.ipv4.tcp_mem = 8388608 12582912 16777216

# Per-socket buffers (min, default, max in bytes)
net.ipv4.tcp_rmem = 4096 262144 134217728
net.ipv4.tcp_wmem = 4096 262144 134217728

# System-wide socket buffer maximums
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728

# Increase connection backlog
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 250000
net.ipv4.tcp_max_syn_backlog = 65535

# TIME_WAIT recycling for high-connection-rate servers
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30

# Keepalive tuning for long-lived connections
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5

# Increase local port range for outbound connections
net.ipv4.ip_local_port_range = 1024 65535

# BBR congestion control
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
```

## High-Bandwidth Connection Optimization

Bringing together all the concepts above for specific high-bandwidth scenarios.

### 100Gbps Network Interface Tuning

```bash
# /etc/sysctl.d/99-100g-network.conf

# Massive socket buffers for 100G (BDP = 100Gbps * 100ms RTT = ~1.25GB)
net.core.rmem_max = 2147483647
net.core.wmem_max = 2147483647
net.ipv4.tcp_rmem = 4096 87380 2147483647
net.ipv4.tcp_wmem = 4096 65536 2147483647

# TCP memory for 100G workloads (for 128GB server)
net.ipv4.tcp_mem = 33554432 50331648 67108864

# IRQ affinity and CPU steering for 100G
# Distribute NIC interrupt handling across CPUs
```

```bash
#!/bin/bash
# Configure IRQ affinity for 100G NIC (Mellanox ConnectX-6)
IFACE="eth0"

# Get NIC IRQs
IRQ_LIST=$(grep "${IFACE}" /proc/interrupts | awk '{print $1}' | tr -d ':')
CPU_COUNT=$(nproc)
CPU=0

for IRQ in $IRQ_LIST; do
    CPU_MASK=$(printf "%x" $((1 << CPU)))
    echo "$CPU_MASK" > /proc/irq/$IRQ/smp_affinity
    echo "IRQ $IRQ -> CPU $CPU (mask: 0x$CPU_MASK)"
    CPU=$(( (CPU + 1) % CPU_COUNT ))
done

# Set RPS (Receive Packet Steering) for software distribution
for i in $(seq 0 7); do
    echo "ff" > /sys/class/net/${IFACE}/queues/rx-${i}/rps_cpus
done

# Set XPS (Transmit Packet Steering)
for i in $(seq 0 7); do
    CPU_MASK=$(printf "%x" $((1 << i)))
    echo "$CPU_MASK" > /sys/class/net/${IFACE}/queues/tx-${i}/xps_cpus
done
```

### Large Send Offload (LSO/TSO) and Receive Offload (GRO/LRO)

```bash
# Check current offload settings
ethtool -k eth0 | grep -E "tcp-segmentation|generic-receive|large-receive|generic-segmentation"

# Enable hardware offloads for throughput
ethtool -K eth0 tso on      # TCP Segmentation Offload
ethtool -K eth0 gso on      # Generic Segmentation Offload
ethtool -K eth0 gro on      # Generic Receive Offload
ethtool -K eth0 lro on      # Large Receive Offload (use carefully - may hurt latency)

# For latency-sensitive workloads, disable LRO but keep GRO
ethtool -K eth0 lro off
ethtool -K eth0 gro on

# Increase ring buffer sizes
ethtool -g eth0              # Show current ring sizes
ethtool -G eth0 rx 4096 tx 4096  # Increase to 4096 slots
```

### Monitoring TCP Performance

```bash
#!/bin/bash
# Comprehensive TCP performance monitoring script

echo "=== TCP Socket Statistics ==="
ss -s

echo ""
echo "=== TCP Memory Usage ==="
cat /proc/net/sockstat | grep -E "TCP|Tcp"
echo "tcp_mem thresholds: $(cat /proc/sys/net/ipv4/tcp_mem)"

echo ""
echo "=== TCP Error Counters (non-zero only) ==="
netstat -s 2>/dev/null | grep -v "0 " | head -30

echo ""
echo "=== Active Connections by State ==="
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

echo ""
echo "=== Congestion Control Distribution ==="
ss -tni | grep -oP 'bbr|cubic|reno' | sort | uniq -c

echo ""
echo "=== Retransmission Rate ==="
# Get retransmits from /proc/net/snmp
awk '/^Tcp:/{
    if (header) {
        for(i=1;i<=NF;i++) vals[i]=$i
    } else {
        for(i=1;i<=NF;i++) hdrs[i]=$i
        header=1
    }
} END {
    for(i=1;i<=length(hdrs);i++) {
        if (hdrs[i] ~ /Retrans/) printf "%s: %s\n", hdrs[i], vals[i]
    }
}' /proc/net/snmp
```

### BPF-Based TCP Monitoring

```bash
# Install BCC tools
apt-get install -y bpftrace bcc-tools

# Trace TCP retransmissions
/usr/share/bcc/tools/tcpretrans

# Trace TCP connections with latency
/usr/share/bcc/tools/tcptracer -t

# Plot TCP round-trip times
/usr/share/bcc/tools/tcprtt -d 1 -a

# Monitor TCP queue depths
bpftrace -e '
kprobe:tcp_recvmsg {
    @recv_queue[comm] = hist(((struct sock *)arg0)->sk_rcvbuf -
                             ((struct sock *)arg0)->sk_rmem_alloc.counter);
}
interval:s:5 {
    print(@recv_queue);
    clear(@recv_queue);
}
'
```

## Diagnosing Common TCP Performance Problems

### Problem: Zero Window Stalls

```bash
# Detect zero window events with tcpdump
tcpdump -i eth0 -nn 'tcp[14:2] = 0' -w /tmp/zero-window.pcap

# Count zero window packets
tshark -r /tmp/zero-window.pcap -q -z conv,tcp | head -20

# Solution: Increase receive buffer
sysctl -w net.ipv4.tcp_rmem="4096 1048576 134217728"
sysctl -w net.core.rmem_max=134217728
```

### Problem: High Retransmission Rate

```bash
# Check per-interface retransmission metrics
cat /proc/net/dev | awk 'NR>2{print $1, "rx_err:", $4, "tx_err:", $12}'

# Check TCP-level retransmissions
nstat -az | grep -E "TcpRetrans|TcpInErrs"

# If hardware errors: check NIC health
ethtool -S eth0 | grep -i error

# If software: check CPU saturation
mpstat -P ALL 1 5
# High softirq% indicates packet processing bottleneck
```

### Problem: SYN Queue Full

```bash
# Symptoms: new connections timing out during bursts
dmesg | grep "SYN flooding"

# Solution
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
sysctl -w net.core.somaxconn=65535

# Enable SYN cookies as defense against SYN floods
sysctl -w net.ipv4.tcp_syncookies=1
```

### Problem: tcp_mem Pressure

```bash
# Monitor for pressure events
watch -n 1 '
echo "=== TCP Memory ==="
cat /proc/net/sockstat | grep Tcp
echo ""
echo "tcp_mem limits: $(cat /proc/sys/net/ipv4/tcp_mem)"
echo ""
echo "Current usage (pages): $(awk "/Tcp:/{if(\$2==\"mem\") print \$3}" /proc/net/sockstat 2>/dev/null || grep mem /proc/net/sockstat)"
'

# If consistently near pressure threshold:
CURRENT_HIGH=$(awk '{print $3}' /proc/sys/net/ipv4/tcp_mem)
NEW_HIGH=$((CURRENT_HIGH * 2))
echo "net.ipv4.tcp_mem = $((NEW_HIGH/2)) $((NEW_HIGH*3/4)) $NEW_HIGH" >> /etc/sysctl.d/99-tcp.conf
sysctl -p /etc/sysctl.d/99-tcp.conf
```

## Production Tuning Checklist

```bash
#!/bin/bash
# TCP performance validation script

echo "=== TCP Performance Audit ==="

# 1. Check congestion control
CC=$(sysctl -n net.ipv4.tcp_congestion_control)
echo "Congestion control: $CC"
[[ "$CC" == "bbr" ]] && echo "  OK: BBR enabled" || echo "  WARN: Consider BBR for high-BDP paths"

# 2. Check buffer sizes
RMEM_MAX=$(sysctl -n net.core.rmem_max)
echo "rmem_max: $RMEM_MAX bytes ($((RMEM_MAX/1024/1024)) MB)"
(( RMEM_MAX >= 134217728 )) && echo "  OK" || echo "  WARN: Consider increasing to 128MB+"

# 3. Check tcp_mem pressure
PAGE=$(getconf PAGE_SIZE)
read LOW PRESS HIGH < /proc/sys/net/ipv4/tcp_mem
read _ _ _ CUR_MEM < <(grep ^Tcp: /proc/net/sockstat | head -1)
# Note: parsing sockstat varies by kernel version
echo "tcp_mem: low=$((LOW*PAGE/1024/1024))MB pressure=$((PRESS*PAGE/1024/1024))MB high=$((HIGH*PAGE/1024/1024))MB"

# 4. Check queue discipline
QD=$(tc qdisc show dev eth0 | awk '{print $2}')
echo "Queue discipline: $QD"
[[ "$QD" == "fq" ]] && echo "  OK: FQ enabled (required for BBR pacing)" || echo "  WARN: Consider FQ qdisc for BBR"

# 5. Check TCP timestamps
TS=$(sysctl -n net.ipv4.tcp_timestamps)
echo "TCP timestamps: $TS"
(( TS == 1 )) && echo "  OK" || echo "  WARN: Enable timestamps for RTT estimation"

# 6. Check SACK
SACK=$(sysctl -n net.ipv4.tcp_sack)
echo "SACK enabled: $SACK"
(( SACK == 1 )) && echo "  OK" || echo "  WARN: Enable SACK for loss recovery"

echo ""
echo "=== Retransmission Health ==="
nstat -az 2>/dev/null | grep -E "TcpRetransSegs|TcpOutSegs" | \
  awk 'BEGIN{r=0;o=0} /Retrans/{r=$2} /OutSegs/{o=$2} END{
    if(o>0) printf "Retransmission rate: %.4f%% (%d/%d)\n", r/o*100, r, o
    else print "No data"
  }'
```

## Summary

Tuning the Linux TCP stack for high-bandwidth connections requires understanding the full pipeline:

1. **sk_buff lifecycle** - packets traverse the kernel as sk_buff structures; understanding clone vs copy overhead helps identify unnecessary data copying
2. **Receive window** - must be at least 2x BDP for full throughput; auto-tuning handles most cases but requires sufficient `rmem_max`
3. **Socket buffers** - set `tcp_rmem`/`tcp_wmem` max to at least 2x BDP, with `rmem_max`/`wmem_max` as hard caps
4. **BBR congestion control** - superior to CUBIC for high-latency or lossy paths; requires FQ qdisc for proper pacing
5. **tcp_mem** - must be sized to accommodate peak concurrent connection memory without triggering pressure mode

The interaction between these parameters means tuning one in isolation often underdelivers. Always validate with end-to-end throughput tests using iperf3 with multiple parallel streams, and monitor retransmission rates and memory pressure under production load.
