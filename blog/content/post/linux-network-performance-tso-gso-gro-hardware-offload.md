---
title: "Linux Network Performance: TSO, GSO, GRO, and Hardware Offload Tuning"
date: 2030-04-02T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Performance", "TSO", "GSO", "GRO", "ethtool", "RSS", "Kernel Tuning"]
categories: ["Linux", "Networking", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux network performance optimization covering TCP Segmentation Offload, Generic Send Offload, Generic Receive Offload, RSS/RPS/RFS for multicore systems, ethtool ring buffer sizing, and hardware offload feature tuning for high-throughput server workloads."
more_link: "yes"
url: "/linux-network-performance-tso-gso-gro-hardware-offload/"
---

Modern server NICs operate at 25 Gbps, 100 Gbps, or faster. Pushing traffic at those rates on Linux requires understanding the complete stack of hardware and software offload features that exist to reduce CPU overhead. Without offloads, a 10 Gbps link can saturate a CPU core with interrupt processing alone. With properly configured offloads, the same CPU core can handle much higher throughput while remaining responsive for application work.

This guide covers every major Linux network offload feature in depth: what problem it solves, how to verify it is working correctly, when to enable or disable it, and how to measure its impact. The focus is on production server workloads — web servers, proxies, databases, and containerized applications — rather than bare-metal packet processing (which warrants its own treatment with DPDK).

<!--more-->

## Network Path Overview

Understanding where in the network path each offload operates prevents confusion about what each setting actually does.

```
Application
    │ write()/sendfile()
    ▼
Socket Buffer (sk_buff)
    │
    ▼ TCP layer
    │ Segment into MSS-sized chunks (1500 bytes max without jumbo frames)
    │
    ▼ IP layer
    │ IP header addition
    │
    ▼ TSO/GSO Decision Point (OUTBOUND)
    │ With TSO: send up to 64KB to NIC, NIC segments
    │ With GSO: segment in software (fallback)
    │
    ▼ NIC TX queue
    │ DMA to NIC hardware
    ▼
    Physical wire ──────────────────────────────────────────────►

    Physical wire ──────────────────────────────────────────────►
    │
    ▼ NIC RX interrupt
    │
    ▼ NAPI (New API) polling
    │ Interrupt fires once, driver polls for more packets
    │
    ▼ GRO Decision Point (INBOUND)
    │ Coalesce small segments into larger super-segments
    │
    ▼ IP/TCP layer reassembly
    │
    ▼ Socket receive buffer
    │
    ▼ Application read()
```

## TSO: TCP Segmentation Offload

TSO allows the kernel to pass large TCP segments (up to 64 KB by default) to the NIC, which then segments them into MTU-sized packets. Without TSO, the kernel must segment each large write into individual packets before handing them to the NIC.

### The Performance Impact

Without TSO, sending 1 MB of data requires:
- 1 MB / 1500 bytes MTU ≈ 700 packets
- 700 separate calls to the NIC driver
- 700 interrupts for TX completion
- 700 sk_buff allocations

With TSO, sending 1 MB might require:
- 1 MB / 64 KB super-segment ≈ 16 segments passed to NIC
- 16 NIC driver calls
- 16 or fewer interrupts
- NIC handles all 700 actual packet transmissions internally

### Checking and Configuring TSO

```bash
# Check TSO status
ethtool -k eth0 | grep -E '(tso|gso|gro|lro|checksum)'

# Full feature list for reference
ethtool -k eth0

# Example output with all major offloads:
# tcp-segmentation-offload: on
# generic-segmentation-offload: on
# generic-receive-offload: on
# large-receive-offload: off [fixed]
# tx-checksum-ip-generic: on
# rx-checksumming: on
# scatter-gather: on
# tx-scatter-gather: on

# Enable TSO
ethtool -K eth0 tso on

# Disable TSO (for debugging or specific workloads)
ethtool -K eth0 tso off

# Check if NIC actually supports TSO (hardware vs software)
ethtool -k eth0 | grep 'tcp-segmentation-offload'
# "on" = hardware TSO supported and enabled
# "on [tx-checksums]" = requires tx checksum to work

# Set TSO maximum segment size
# (some NICs allow tuning the max size)
ethtool -K eth0 tx-tcp-segmentation on
ethtool -K eth0 tx-tcp-ecn-segmentation on
ethtool -K eth0 tx-tcp6-segmentation on
```

### When to Disable TSO

TSO should be disabled in specific scenarios:

```bash
# Disable TSO for latency-sensitive workloads
# TSO batching adds latency (waits to accumulate data before sending)
# For trading systems, VoIP, gaming: disable TSO
ethtool -K eth0 tso off gso off

# Disable TSO when using traffic shaping (tc/qdisc)
# TSO interacts poorly with some queuing disciplines
# The kernel may not see individual packets to apply rate limiting correctly
ethtool -K eth0 tso off

# Verify impact with iperf3
iperf3 -c $SERVER -t 30                 # baseline with TSO
ethtool -K eth0 tso off
iperf3 -c $SERVER -t 30                 # without TSO
ethtool -K eth0 tso on                  # restore
```

## GSO: Generic Segmentation Offload

GSO is the software fallback for TSO. When TSO is not available (NIC doesn't support it, or TSO is disabled), GSO performs the segmentation in software just before the packet hits the NIC driver — later in the stack than if the kernel segmented during TCP processing.

GSO is preferable to no offload at all because:
- The kernel can still build large buffers higher up the stack
- Segmentation happens once, right before transmission, rather than at TCP time
- Reduces sk_buff allocations during the connection lifecycle

```bash
# GSO is typically on by default
ethtool -k eth0 | grep gso
# generic-segmentation-offload: on

# GSO maximum size
cat /proc/sys/net/core/gso_max_size
# 65536 (64 KB)

cat /proc/sys/net/core/gso_max_segs
# 65535

# Increase GSO max size for networks with jumbo frames
# (only effective if MTU is also increased)
sysctl -w net.core.gso_max_size=131072
```

## GRO: Generic Receive Offload

GRO is the receive-side counterpart to TSO/GSO. It coalesces incoming TCP segments that belong to the same flow into a single larger segment before passing them up the stack. This reduces the number of calls to the TCP/IP stack and the number of context switches into the application.

```bash
# Check GRO status
ethtool -k eth0 | grep gro
# generic-receive-offload: on

# GRO timeout — how long to accumulate packets before flushing
cat /sys/class/net/eth0/gro_flush_timeout
# 0 (disabled, flush on every NAPI poll cycle)
# Non-zero: flush after N nanoseconds

# Set GRO flush timeout (nanoseconds)
# Higher value = more coalescing = better throughput, higher latency
# Lower value = less coalescing = lower latency, more interrupts
echo 100000 > /sys/class/net/eth0/gro_flush_timeout  # 100 microseconds

# GRO maximum number of segments to coalesce
cat /sys/class/net/eth0/gro_max_size
# 65536

# Enable hardware GRO (if NIC supports it)
ethtool -K eth0 rx-gro-hw on 2>/dev/null || echo "Hardware GRO not supported"
```

### GRO and LRO Differences

```bash
# LRO (Large Receive Offload) — hardware-level reassembly
# Problems: modifies TCP timestamps, breaks certain applications
# LRO is almost always disabled in production
ethtool -k eth0 | grep lro
# large-receive-offload: off [fixed]  ← correct for most NICs

# GRO is software-implemented and safer than LRO
# GRO coalesces at the software layer, preserving IP/TCP metadata
ethtool -k eth0 | grep gro
# generic-receive-offload: on  ← should be enabled
```

## Checksum Offloads

Checksum calculation is expensive for large packet volumes. Hardware checksum offload moves this calculation to the NIC.

```bash
# View all checksum offload features
ethtool -k eth0 | grep checksum

# TX checksums (most important for outbound traffic)
# tx-checksums: on
# tx-checksum-ipv4: on
# tx-checksum-ipv6: on
# tx-checksum-ip-generic: on

# RX checksums
# rx-checksumming: on

# Scatter-gather I/O (required for checksum offload to work efficiently)
ethtool -k eth0 | grep scatter
# scatter-gather: on
# tx-scatter-gather: on
# tx-scatter-gather-fraglist: on

# Enable all checksum offloads
ethtool -K eth0 \
    rx on \
    tx on \
    sg on \
    tso on \
    gso on \
    gro on
```

## RSS, RPS, and RFS: Multicore Distribution

Modern NICs support multiple TX/RX queues. RSS (Receive Side Scaling) distributes incoming packets across those queues using a hardware hash, allowing multiple CPU cores to process network traffic in parallel.

### RSS: Receive Side Scaling

```bash
# Check number of RX/TX queues
ethtool -l eth0
# Channel parameters for eth0:
# Pre-set maximums:
# RX:             16
# TX:             16
# Combined:       16
# Current hardware settings:
# Combined:       8

# Set queue count to match CPU cores (or half for NUMA consideration)
ethtool -L eth0 combined $(nproc)

# View the RSS hash key and indirection table
ethtool -x eth0
# RX flow hash indirection table for eth0 with 8 RX ring(s):
#     0:      0     1     2     3     4     5     6     7
#     8:      0     1     2     3     4     5     6     7
#    ...

# Set the indirection table to use specific CPUs
# Spread across all CPUs evenly
ethtool -X eth0 equal $(nproc)

# Set the RSS hash function
ethtool -N eth0 rx-flow-hash tcp4 sdfn
# s = src IP, d = dst IP, f = src port, n = dst port
# Hashes on all 4-tuple components for maximum distribution

# View current hash settings
ethtool -n eth0 rx-flow-hash tcp4
```

### RSS IRQ Affinity

After configuring RSS queues, assign each queue's IRQ to a specific CPU core:

```bash
#!/usr/bin/env bash
# set-rss-affinity.sh — pin NIC queues to CPUs

NIC="eth0"
QUEUE_PREFIX="$NIC-"

# Get IRQ numbers for this NIC
IRQS=$(grep "$NIC" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')

CPU=0
for IRQ in $IRQS; do
    # Pin IRQ to CPU
    echo "$CPU" > "/proc/irq/$IRQ/smp_affinity_list"
    echo "IRQ $IRQ → CPU $CPU"
    CPU=$((CPU + 1))
    # Wrap around if more IRQs than CPUs
    if [ "$CPU" -ge "$(nproc)" ]; then
        CPU=0
    fi
done
```

### RPS: Receive Packet Steering (Software RSS)

RPS is the software implementation of RSS for NICs that do not support multiple RX queues.

```bash
# Enable RPS on a single-queue NIC
# CPU mask: all CPUs (ffffffff for 32 CPUs, ff for 8 CPUs)
CPUMASK=$(python3 -c "print(hex((1 << $(nproc)) - 1)[2:])")

for queue in /sys/class/net/eth0/queues/rx-*/rps_cpus; do
    echo "$CPUMASK" > "$queue"
    echo "Set RPS for $queue: $CPUMASK"
done

# Set RPS flow table size (affects memory usage and distribution quality)
# Default is 0 (disabled). 4096 is a good starting point.
for queue in /sys/class/net/eth0/queues/rx-*/rps_flow_cnt; do
    echo 4096 > "$queue"
done

# Global flow count (sum of all per-queue values)
sysctl -w net.core.rps_sock_flow_entries=32768
```

### RFS: Receive Flow Steering

RFS extends RPS by steering packets to the CPU where the application that will receive them is running, avoiding cross-CPU cache misses.

```bash
# Enable RFS
# Global flow table (must be power of 2, ≥ sum of per-queue rps_flow_cnt)
sysctl -w net.core.rps_sock_flow_entries=32768

# Per-queue flow table
for queue in /sys/class/net/eth0/queues/rx-*/rps_flow_cnt; do
    echo 4096 > "$queue"
done

# Verify RFS is active
cat /proc/net/softnet_stat | head -5
# Each line is a CPU's soft IRQ stats
# Column 10 (rps_needed) should be non-zero

# Monitor RFS effectiveness
watch -n 1 'cat /proc/net/softnet_stat | awk "{print NR-1, \$10, \$11}" | head -8'
# CPU# rps_needs flow_limit_count
```

## Ring Buffer Sizing

The NIC's RX ring buffer is a circular buffer of packet descriptors. If the ring fills before the CPU can process packets, packets are dropped.

```bash
# View current and maximum ring buffer sizes
ethtool -g eth0
# Ring parameters for eth0:
# Pre-set maximums:
# RX:             4096
# RX Mini:        0
# RX Jumbo:       0
# TX:             4096
# Current hardware settings:
# RX:             1024
# RX Mini:        0
# RX Jumbo:       0
# TX:             1024

# Increase ring buffer to maximum
ethtool -G eth0 rx 4096 tx 4096

# Verify
ethtool -g eth0 | grep -A5 "Current"

# Monitor ring buffer drops
ethtool -S eth0 | grep -i 'drop\|miss\|overflow\|error' | grep -v '0$'
# rx_dropped: 0          ← should be 0 or very low
# rx_fifo_errors: 0      ← FIFO overflow = ring buffer too small
# tx_fifo_errors: 0

# Watch interface statistics in real-time
watch -n 1 'cat /proc/net/dev | grep eth0'
# iface: rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame ...
```

### Choosing Ring Buffer Size

```bash
# Calculate required ring buffer size:
# At 10 Gbps with 1500-byte packets:
# 10e9 bits/s ÷ 8 bits/byte ÷ 1500 bytes/packet = 833,333 packets/sec
# If NAPI processes every 1ms = 833 packets per cycle
# Ring must hold at least 833 packets

# For 100 Gbps:
# 100e9 ÷ 8 ÷ 1500 = 8.3M packets/sec
# 1ms processing cycle = 8,300 packets per cycle
# Use maximum ring size: 4096 packets is the typical hardware max

python3 -c "
speed_gbps = 10
mtu = 1500
napi_interval_ms = 1
pps = (speed_gbps * 1e9) / 8 / mtu
per_napi = pps * napi_interval_ms / 1000
print(f'{speed_gbps} Gbps @ {mtu} MTU: {pps:,.0f} pps, {per_napi:,.0f} packets per NAPI cycle')
print(f'Minimum ring buffer size: {int(per_napi * 2):,} (2x safety margin)')
"
```

## ethtool Coalesce Settings

Interrupt coalescing reduces the number of interrupts generated by batching multiple packets into a single interrupt.

```bash
# View current coalescing settings
ethtool -c eth0
# Coalesce parameters for eth0:
# Adaptive RX: on  TX: on
# stats-block-usecs: 0
# sample-interval: 0
# pkt-rate-low: 400000
# pkt-rate-high: 450000
#
# rx-usecs: 3
# rx-frames: 0
# rx-usecs-irq: 0
# rx-frames-irq: 0
#
# tx-usecs: 0
# tx-frames: 32
# tx-usecs-irq: 0
# tx-frames-irq: 0

# For high throughput: increase coalescing (reduces interrupt rate)
ethtool -C eth0 \
    rx-usecs 50 \
    rx-frames 64 \
    tx-usecs 50 \
    tx-frames 64

# For low latency: reduce coalescing (increases interrupt rate)
ethtool -C eth0 \
    rx-usecs 0 \
    rx-frames 1 \
    tx-usecs 0 \
    tx-frames 1

# Adaptive coalescing (let driver auto-tune based on load)
ethtool -C eth0 adaptive-rx on adaptive-tx on

# Measure interrupt rate
watch -n 1 'cat /proc/interrupts | grep eth0'
```

## Kernel Network Stack Tuning

```bash
# /etc/sysctl.d/99-network-performance.conf

# Increase socket buffer sizes for high-bandwidth links
# Default: 212992 (208 KB)
# Recommended for 10G+: 134217728 (128 MB)
net.core.rmem_default = 262144
net.core.rmem_max = 134217728
net.core.wmem_default = 262144
net.core.wmem_max = 134217728

# TCP buffer sizes: min/default/max
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 87380 134217728

# TCP auto-tuning (should be on by default)
net.ipv4.tcp_moderate_rcvbuf = 1

# Increase backlog queue sizes
net.core.netdev_max_backlog = 250000    # per-CPU packet backlog
net.core.somaxconn = 65535             # max connection backlog

# Disable slow start after idle (better for latency)
net.ipv4.tcp_slow_start_after_idle = 0

# TCP connection reuse
net.ipv4.tcp_tw_reuse = 1

# Increase local port range
net.ipv4.ip_local_port_range = 1024 65535

# Jumbo frames (if network supports it)
# ip link set eth0 mtu 9000
# sysctl net.ipv4.tcp_mtu_probing = 1

# NAPI and PREEMPTION tuning
# Number of packets processed per NAPI poll (higher = more batching)
net.core.dev_weight = 64
net.core.dev_weight_tx_bias = 1

# Busy polling for ultra-low latency (trades CPU for latency)
# Polls socket for up to 50 microseconds before sleeping
net.core.busy_poll = 50
net.core.busy_read = 50
```

## Measuring Network Performance

### Baseline Throughput with iperf3

```bash
# Install on server and client
apt-get install iperf3

# Server side
iperf3 -s -p 5201

# Client: single stream TCP test
iperf3 -c $SERVER -t 30 -i 5

# Client: parallel streams (better for multi-queue NICs)
iperf3 -c $SERVER -t 30 -P 8 -i 5

# UDP test for packet loss and jitter measurement
iperf3 -c $SERVER -t 30 -u -b 1G

# Bidirectional test
iperf3 -c $SERVER -t 30 --bidir

# Example output analysis
iperf3 -c $SERVER -t 30 -P 8 | tail -5
# [SUM]   0.00-30.00  sec  35.6 GBytes  9.95 Gbits/sec   0   sender
# [SUM]   0.00-30.01  sec  35.6 GBytes  9.95 Gbits/sec        receiver
```

### Packet Rate Measurement

```bash
# Measure packets per second (more relevant than bytes for small packets)
# Install nload or iftop for real-time monitoring
nload eth0

# Precise packet rate measurement with ethtool statistics
watch -n 1 'ethtool -S eth0 | grep -E "rx_packets|tx_packets" | head -5'

# Use sar for historical data
sar -n DEV 1 60 | grep eth0

# pktgen — kernel packet generator for NIC stress testing
modprobe pktgen
# See /proc/net/pktgen/ for configuration

# netperf for latency and throughput testing
netperf -H $SERVER -t TCP_RR -l 30   # Request-response (latency)
netperf -H $SERVER -t TCP_STREAM -l 30  # Stream (throughput)
```

### Profiling Network CPU Usage

```bash
# Find which CPUs are handling network interrupts
mpstat -I ALL 1 5 | grep -E '(CPU|eth|Average)'

# perf to identify network-related functions consuming CPU
perf top -e cpu-cycles --sort comm,dso | head -30

# Identify if softirq processing is the bottleneck
watch -n 1 'cat /proc/softirqs | grep -E "(NET_TX|NET_RX|POLL)"'

# Flamegraph for network softirq
perf record -e cpu-cycles -g \
    --filter="comm=ksoftirqd" \
    sleep 30
perf script | stackcollapse-perf.pl | flamegraph.pl > net-flamegraph.svg
```

## Containerized and Kubernetes Network Offloads

Network offloads interact with the additional network layers introduced by container networking.

```bash
# Verify offloads are passing through to container network interfaces
# Check offloads on the veth pair for a container

# Find the host-side veth for a Kubernetes pod
POD_ID=$(docker inspect <container-id> --format '{{.State.Pid}}')
NETNS="/proc/$POD_ID/ns/net"

# Check offloads on the veth device
nsenter -n -t $POD_ID -- ethtool -k eth0

# Common issue: veth devices do not support TSO natively
# GSO handles this in software
nsenter -n -t $POD_ID -- ethtool -k eth0 | grep -E '(tso|gso|gro)'
# tcp-segmentation-offload: off [requested on]
# generic-segmentation-offload: on   ← GSO compensates
# generic-receive-offload: on

# Cilium ebpf datapath — check offload integration
cilium endpoint list
cilium bpf prog list | grep xdp
```

## Making Changes Persistent

```bash
# All ethtool changes are non-persistent by default.
# Use one of these methods to persist them:

# Method 1: NetworkManager dispatcher script
cat > /etc/NetworkManager/dispatcher.d/99-network-tuning << 'EOF'
#!/usr/bin/env bash
# NetworkManager dispatcher script — runs on interface up
[ "$1" != "eth0" ] && exit 0
[ "$2" != "up" ] && exit 0

ethtool -G eth0 rx 4096 tx 4096
ethtool -K eth0 tso on gso on gro on
ethtool -C eth0 adaptive-rx on adaptive-tx on
ethtool -L eth0 combined $(nproc)

# Set IRQ affinity
/usr/local/bin/set-rss-affinity.sh

logger "Network performance tuning applied to eth0"
EOF
chmod +x /etc/NetworkManager/dispatcher.d/99-network-tuning

# Method 2: systemd service
cat > /etc/systemd/system/network-tuning.service << 'EOF'
[Unit]
Description=Network Performance Tuning
After=network.target
Wants=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/network-tuning.sh

[Install]
WantedBy=multi-user.target
EOF

# Method 3: /etc/rc.local (legacy but universal)
cat >> /etc/rc.local << 'EOF'
ethtool -G eth0 rx 4096 tx 4096
ethtool -K eth0 tso on gso on gro on
EOF
```

## Complete Tuning Script

```bash
#!/usr/bin/env bash
# network-performance-tune.sh — comprehensive NIC performance configuration
# Run as root. Adjust NIC variable for your interface.

set -euo pipefail

NIC="${1:-eth0}"
LOG_TAG="net-tune"

if ! ip link show "$NIC" &>/dev/null; then
    echo "Interface $NIC not found"
    exit 1
fi

echo "[$LOG_TAG] Tuning $NIC for high-performance workloads..."

# 1. Ring buffers — maximize
MAX_RX=$(ethtool -g "$NIC" 2>/dev/null | grep 'RX:' | head -1 | awk '{print $2}' || echo 4096)
MAX_TX=$(ethtool -g "$NIC" 2>/dev/null | grep 'TX:' | head -1 | awk '{print $2}' || echo 4096)
ethtool -G "$NIC" rx "$MAX_RX" tx "$MAX_TX" 2>/dev/null && \
    echo "[$LOG_TAG] Ring buffers: RX=$MAX_RX TX=$MAX_TX" || true

# 2. Offloads — enable all standard ones
ethtool -K "$NIC" tso on gso on gro on sg on rx on tx on 2>/dev/null && \
    echo "[$LOG_TAG] Offloads enabled" || true

# 3. Adaptive coalescing
ethtool -C "$NIC" adaptive-rx on adaptive-tx on 2>/dev/null && \
    echo "[$LOG_TAG] Adaptive coalescing enabled" || true

# 4. RSS queues — match CPU count
CPU_COUNT=$(nproc)
ethtool -L "$NIC" combined "$CPU_COUNT" 2>/dev/null && \
    echo "[$LOG_TAG] RSS queues set to $CPU_COUNT" || true

# 5. IRQ affinity
IRQS=$(grep "$NIC" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')
CPU=0
for IRQ in $IRQS; do
    echo "$CPU" > "/proc/irq/$IRQ/smp_affinity_list" 2>/dev/null && \
        echo "[$LOG_TAG] IRQ $IRQ → CPU $CPU" || true
    CPU=$(( (CPU + 1) % CPU_COUNT ))
done

# 6. RPS/RFS for NICs without hardware RSS
CPUMASK=$(python3 -c "print(hex((1 << $(nproc)) - 1)[2:])")
for queue in /sys/class/net/"$NIC"/queues/rx-*/rps_cpus; do
    echo "$CPUMASK" > "$queue" 2>/dev/null || true
done
for queue in /sys/class/net/"$NIC"/queues/rx-*/rps_flow_cnt; do
    echo 4096 > "$queue" 2>/dev/null || true
done
sysctl -qw net.core.rps_sock_flow_entries=32768

echo "[$LOG_TAG] Done. Verify with: ethtool -k $NIC && ethtool -g $NIC"
```

## Key Takeaways

Linux network offloads collectively move significant CPU work from the kernel to the NIC hardware, enabling higher throughput on fewer CPU cores. The key insight is that TSO/GSO/GRO are not all-or-nothing — each offload addresses a specific piece of the packet processing pipeline, and they can be tuned independently.

TSO and GRO are almost always beneficial for throughput-oriented workloads. TSO reduces TX interrupt overhead by allowing the NIC to segment large TCP streams. GRO reduces RX processing overhead by coalescing incoming packets before handing them to the TCP stack. The only reason to disable them is diagnosed latency sensitivity (TSO adds batching latency) or confirmed incompatibility with specific applications.

RSS with correct IRQ affinity is essential for multi-core network performance. Without it, all network interrupts land on a single CPU (usually CPU 0), creating a bottleneck regardless of how many cores the server has. Set RSS queue count to match available CPU cores and pin each queue's IRQ to a specific core.

Ring buffer sizing prevents packet drops at the NIC level. The rule is simple: maximize ring buffers on production servers. The memory cost (4096 entries × 2KB per descriptor = 8MB) is trivial compared to the consequences of dropped packets under burst traffic. Monitor ring overflow with `ethtool -S eth0 | grep -i drop` and increase if non-zero values appear.

The complete tuning sequence for a new server is: maximize ring buffers → enable all standard offloads → set RSS queue count to nproc → assign IRQs to specific CPUs → apply sysctl network buffer settings → measure with iperf3 to validate improvement.
