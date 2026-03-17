---
title: "Linux Network Performance: Receive Side Scaling and Interrupt Affinity"
date: 2029-05-20T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Performance", "RSS", "RPS", "IRQ", "NUMA", "ethtool"]
categories: ["Linux", "Networking", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux network performance tuning covering RSS, RPS, RFS, XPS, IRQ balancing, NUMA-aware network configuration, ethtool ring buffer tuning, and multi-queue NIC optimization."
more_link: "yes"
url: "/linux-network-performance-receive-side-scaling-interrupt-affinity/"
---

Modern high-speed networks demand that Linux fully leverage multi-core hardware to avoid single-CPU bottlenecks. A 100 Gbps NIC can generate millions of interrupts per second — more than any single CPU core can handle. This post covers the full stack of Linux network performance features: Receive Side Scaling (RSS), Receive Packet Steering (RPS), Receive Flow Steering (RFS), Transmit Packet Steering (XPS), hardware interrupt affinity, NUMA topology awareness, and ring buffer tuning.

<!--more-->

# Linux Network Performance: Receive Side Scaling and Interrupt Affinity

## Understanding the Problem: CPU Bottlenecks in Network Receive

Before tuning, understand where time is spent receiving a packet:

```
Hardware NIC
    |
    v
DMA ring buffer (hardware descriptor ring)
    |
    v
Hardware IRQ → CPU picks up interrupt
    |
    v
NAPI poll (softirq budget)
    |
    v
Socket receive buffer
    |
    v
Application
```

Without scaling, all of this processing lands on a single CPU. On a busy server receiving 1 million packets per second, that CPU runs at 100% while others sit idle.

### Measuring the Problem

```bash
# See which CPUs are handling which interrupts
watch -n 1 'cat /proc/interrupts | grep -E "(eth|ens|eno|enp)"'

# See per-CPU softirq counts
watch -n 1 'cat /proc/net/softnet_stat'

# softnet_stat columns:
# total   dropped   time_squeeze   0 0 0 0 0   cpu_collision   received_rps   flow_limit_count

# Check if a single CPU is overwhelmed
mpstat -P ALL 1 5 | grep -v ^$

# Profile network interrupt distribution
sar -n INT 1 5
```

## Section 1: Hardware Multi-Queue NICs and RSS

### What is RSS?

Receive Side Scaling (RSS) is a hardware feature in modern NICs that distributes incoming packets across multiple hardware receive queues — and thus multiple CPUs — using a hash of the packet's flow tuple (source IP, dest IP, source port, dest port, protocol).

```
NIC with 8 RX queues
                    ┌─────────────────────────────────────────┐
Incoming            │ Hash(src_ip, dst_ip, src_port, dst_port)│
Packets ──────────► │                                         │
                    │  Queue 0 ──► CPU 0  IRQ 32              │
                    │  Queue 1 ──► CPU 1  IRQ 33              │
                    │  Queue 2 ──► CPU 2  IRQ 34              │
                    │  Queue 3 ──► CPU 3  IRQ 35              │
                    │  Queue 4 ──► CPU 4  IRQ 36              │
                    │  Queue 5 ──► CPU 5  IRQ 37              │
                    │  Queue 6 ──► CPU 6  IRQ 38              │
                    │  Queue 7 ──► CPU 7  IRQ 39              │
                    └─────────────────────────────────────────┘
```

### Checking RSS Queue Count

```bash
# Check current queue count
ethtool -l eth0

# Output:
# Channel parameters for eth0:
# Pre-set maximums:
# RX:             0
# TX:             0
# Other:          1
# Combined:       63   ← maximum combined queues (RX+TX pairs)
# Current hardware settings:
# RX:             0
# TX:             0
# Other:          1
# Combined:       8    ← currently active combined queues

# Check RSS hash configuration
ethtool -x eth0
# RX flow hash indirection table for eth0 with 8 RX ring(s):
#     0:      0     1     2     3     4     5     6     7
#     8:      0     1     2     3     4     5     6     7
#     ...
```

### Configuring RSS Queue Count

```bash
# Set combined queues to match CPU count (or NUMA node CPU count)
ethtool -L eth0 combined 16

# For dedicated RX/TX queues (some NICs support this)
ethtool -L eth0 rx 16 tx 16

# Verify change
ethtool -l eth0
```

### RSS Hash Configuration

Control which packet fields are hashed:

```bash
# Show current hash settings
ethtool -n eth0 rx-flow-hash tcp4
# TCP over IPV4 flows use these fields for computing Hash flow key:
# IP SA
# IP DA
# L4 bytes 0 & 1 [TCP/UDP src port]
# L4 bytes 2 & 3 [TCP/UDP dst port]

# Configure hash fields for UDP (useful for QUIC/UDP applications)
ethtool -N eth0 rx-flow-hash udp4 sdfn
# s = IP source address
# d = IP destination address
# f = bytes 0 & 1 of transport header (source port)
# n = bytes 2 & 3 of transport header (dest port)

# For symmetric hashing (same CPU handles both directions of a flow)
# Not all NICs support this
ethtool -X eth0 hfunc toeplitz

# Set a custom RSS indirection table to bias toward certain CPUs
ethtool -X eth0 equal 8  # Distribute evenly across first 8 queues
```

## Section 2: IRQ Affinity — Pinning Interrupts to CPUs

### Manual IRQ Affinity Configuration

```bash
# List IRQs for network interface
cat /proc/interrupts | grep eth0

# Output example:
#  32:   1234567   0   0   0   PCI-MSI 524288-edge      eth0-TxRx-0
#  33:         0   1234567   0   0   PCI-MSI 524289-edge      eth0-TxRx-1
#  34:         0   0   1234567   0   PCI-MSI 524290-edge      eth0-TxRx-2
#  35:         0   0   0   1234567   PCI-MSI 524291-edge      eth0-TxRx-3

# Check current affinity for IRQ 32
cat /proc/irq/32/smp_affinity
# f  ← hex bitmask — f = 0b1111 = CPUs 0-3

cat /proc/irq/32/smp_affinity_list
# 0-3  ← human-readable CPU list

# Pin IRQ 32 to CPU 0 only
echo 1 > /proc/irq/32/smp_affinity          # hex bitmask: bit 0 = CPU 0
echo 0 > /proc/irq/32/smp_affinity_list     # or use CPU list format

# Pin IRQ 33 to CPU 1 only
echo 2 > /proc/irq/33/smp_affinity
echo 1 > /proc/irq/33/smp_affinity_list

# Pin IRQ 34 to CPU 2
echo 4 > /proc/irq/34/smp_affinity
echo 2 > /proc/irq/34/smp_affinity_list

# Pin IRQ 35 to CPU 3
echo 8 > /proc/irq/35/smp_affinity
echo 3 > /proc/irq/35/smp_affinity_list
```

### Automated IRQ Balancing Script

```bash
#!/bin/bash
# set_irq_affinity.sh — pin NIC IRQs to CPUs in round-robin fashion
# Skips CPU 0 to keep it available for OS tasks

set -euo pipefail

INTERFACE="${1:-eth0}"
SKIP_CPU=0  # Don't use CPU 0 for network IRQs

# Get CPU count
NUM_CPUS=$(nproc)

# Get IRQs for this interface
IRQS=$(grep "${INTERFACE}" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')

if [[ -z "${IRQS}" ]]; then
    echo "No IRQs found for ${INTERFACE}"
    exit 1
fi

CPU=$((SKIP_CPU + 1))

for IRQ in ${IRQS}; do
    if [[ $CPU -ge $NUM_CPUS ]]; then
        CPU=$((SKIP_CPU + 1))
    fi

    echo "Pinning IRQ ${IRQ} to CPU ${CPU}"
    echo "${CPU}" > /proc/irq/${IRQ}/smp_affinity_list

    ((CPU++))
done

echo "Done. IRQ affinity configuration:"
for IRQ in ${IRQS}; do
    echo "  IRQ ${IRQ}: $(cat /proc/irq/${IRQ}/smp_affinity_list)"
done
```

### Disabling irqbalance

The `irqbalance` daemon dynamically moves IRQs between CPUs. For latency-sensitive workloads, disable it:

```bash
# Disable and stop irqbalance
systemctl disable --now irqbalance

# Verify it's stopped
systemctl status irqbalance

# For containers/VMs where systemd isn't available
killall irqbalance || true
```

For servers that need `irqbalance` for some IRQs but not network ones, use the banned CPUs or policy options:

```bash
# /etc/default/irqbalance
IRQBALANCE_BANNED_CPUS=0xff00  # Don't move IRQs to CPUs 8-15
IRQBALANCE_ARGS="--policyscript=/etc/irqbalance-network.sh"
```

## Section 3: Receive Packet Steering (RPS)

RPS is the software equivalent of RSS — useful when your NIC doesn't support hardware multi-queue or when you have more CPUs than hardware queues.

```
NIC (1 RX queue)
      |
      v
CPU 0 (handles IRQ)
      |
      v  RPS: compute hash, pick target CPU
      |
      ├──► CPU 1 (process packet)
      ├──► CPU 2 (process packet)
      ├──► CPU 3 (process packet)
      └──► CPU 4 (process packet)
```

### Configuring RPS

```bash
# RPS is configured per receive queue via sysfs
# Path: /sys/class/net/<interface>/queues/rx-<N>/rps_cpus

# Enable RPS on all CPUs for eth0's first queue
echo ffffffff > /sys/class/net/eth0/queues/rx-0/rps_cpus

# For a system with 16 CPUs (CPUs 0-15, mask = 0xffff)
echo ffff > /sys/class/net/eth0/queues/rx-0/rps_cpus

# For NUMA awareness: only use CPUs on the same NUMA node as the NIC
# Find NIC's NUMA node
cat /sys/class/net/eth0/device/numa_node
# 0

# Get CPUs on NUMA node 0
cat /sys/devices/system/node/node0/cpulist
# 0-7,16-23

# Calculate hex mask for CPUs 0-7 (first 8 bits = 0xff)
echo ff > /sys/class/net/eth0/queues/rx-0/rps_cpus
```

### RPS Flow Limit

Prevent a single flow from monopolizing CPU:

```bash
# Enable flow limit (requires RPS to be enabled)
echo 8192 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt

# Set global flow limit table size (per CPU)
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
```

### Automated RPS Configuration

```bash
#!/bin/bash
# configure_rps.sh — enable RPS across all queues for an interface

INTERFACE="${1:-eth0}"
NUMA_NODE=$(cat /sys/class/net/${INTERFACE}/device/numa_node 2>/dev/null || echo -1)

if [[ "${NUMA_NODE}" -ge 0 ]]; then
    # Use only CPUs from the same NUMA node
    CPU_LIST=$(cat /sys/devices/system/node/node${NUMA_NODE}/cpulist)
    echo "Using NUMA node ${NUMA_NODE} CPUs: ${CPU_LIST}"

    # Convert CPU list to hex mask
    CPU_MASK=$(python3 -c "
cpus = '${CPU_LIST}'
mask = 0
for part in cpus.split(','):
    if '-' in part:
        start, end = map(int, part.split('-'))
        for cpu in range(start, end + 1):
            mask |= 1 << cpu
    else:
        mask |= 1 << int(part)
print(hex(mask)[2:])
")
else
    # Use all CPUs
    NUM_CPUS=$(nproc)
    CPU_MASK=$(python3 -c "print(hex((1 << ${NUM_CPUS}) - 1)[2:])")
fi

echo "CPU mask: ${CPU_MASK}"

for QUEUE_DIR in /sys/class/net/${INTERFACE}/queues/rx-*; do
    QUEUE=$(basename ${QUEUE_DIR})
    echo "${CPU_MASK}" > "${QUEUE_DIR}/rps_cpus"
    echo "8192" > "${QUEUE_DIR}/rps_flow_cnt"
    echo "Configured ${QUEUE}: rps_cpus=${CPU_MASK}"
done

# Set global flow table
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
```

## Section 4: Receive Flow Steering (RFS)

RFS extends RPS by steering packets to the CPU where the application consuming them is running — improving cache locality.

```
Without RFS:            With RFS:
Packet arrives          Packet arrives
     │                       │
     ▼                       ▼
CPU 3 (RPS hash)        CPU 3 (RFS: app is on CPU 3)
     │                       │
     ▼                       ▼
Cache miss when         Cache hit — app's socket
app on CPU 7 reads      is warm on CPU 3
```

### Configuring RFS

```bash
# Global flow table size (must be power of 2)
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries

# Per-queue flow entries (rps_flow_cnt)
for QUEUE_DIR in /sys/class/net/eth0/queues/rx-*; do
    echo 4096 > "${QUEUE_DIR}/rps_flow_cnt"
done

# RFS is automatically used when both settings are non-zero
# and RPS is enabled
```

### Verifying RFS is Working

```bash
# Check if packets are being steered to application CPUs
# Compare RPS stats before and after enabling RFS
cat /proc/net/softnet_stat | awk '{print $10}' | paste -s -d+ | bc
# The 10th column is received_rps count — should increase with RFS
```

## Section 5: Transmit Packet Steering (XPS)

XPS maps transmit queues to the CPU cores that should use them, reducing lock contention on the transmit path.

```bash
# Check XPS configuration
ls /sys/class/net/eth0/queues/tx-*/xps_cpus
ls /sys/class/net/eth0/queues/tx-*/xps_rxqs

# Configure XPS: map TX queue N to CPU N (1:1 for first 8)
# TX queue 0 → CPU 0
echo 1 > /sys/class/net/eth0/queues/tx-0/xps_cpus
# TX queue 1 → CPU 1
echo 2 > /sys/class/net/eth0/queues/tx-1/xps_cpus
# TX queue 2 → CPU 2
echo 4 > /sys/class/net/eth0/queues/tx-2/xps_cpus
# TX queue 3 → CPU 3
echo 8 > /sys/class/net/eth0/queues/tx-3/xps_cpus

# For NUMA: all TX queues use all CPUs on the same NUMA node
NUMA_MASK=$(cat /sys/devices/system/node/node0/cpumap | tr -d '\n')
for QUEUE_DIR in /sys/class/net/eth0/queues/tx-*; do
    echo "${NUMA_MASK}" > "${QUEUE_DIR}/xps_cpus"
done
```

### XPS with Receive Queue Mapping (xps_rxqs)

```bash
# Map TX queue to RX queue (so TX uses same CPU as RX for same flow)
# This is useful for bidirectional flows
echo 1 > /sys/class/net/eth0/queues/tx-0/xps_rxqs  # TX-0 maps to RX-0
echo 2 > /sys/class/net/eth0/queues/tx-1/xps_rxqs  # TX-1 maps to RX-1
```

## Section 6: ethtool Ring Buffer Tuning

Ring buffers are the circular buffers between the NIC and the kernel. Too small causes packet drops; too large causes latency.

### Checking Ring Buffer Settings

```bash
# Show current and maximum ring buffer sizes
ethtool -g eth0

# Output:
# Ring parameters for eth0:
# Pre-set maximums:
# RX:             4096
# RX Mini:        0
# RX Jumbo:       0
# TX:             4096
# Current hardware settings:
# RX:             512    ← current RX ring size
# RX Mini:        0
# RX Jumbo:       0
# TX:             512    ← current TX ring size

# Check for drops due to ring overflow
ethtool -S eth0 | grep -i "drop\|miss\|error"
# rx_missed_errors: 0
# rx_fifo_errors: 12345  ← non-zero means ring buffer was full
```

### Tuning Ring Buffer Size

```bash
# Increase ring buffers to reduce drops
ethtool -G eth0 rx 4096 tx 4096

# For latency-sensitive applications, SMALLER buffers reduce bufferbloat
ethtool -G eth0 rx 256 tx 256

# Monitor drops after change
watch -n 1 'ethtool -S eth0 | grep -i "drop\|fifo\|miss"'
```

### Adaptive Interrupt Coalescing

Interrupt coalescing batches interrupts to reduce CPU overhead at the cost of latency:

```bash
# Show current coalescing settings
ethtool -c eth0

# Output:
# Coalesce parameters for eth0:
# Adaptive RX: on  TX: on
# stats-block-usecs: 0
# sample-interval: 0
# pkt-rate-low: 2000
# pkt-rate-high: 20000
#
# rx-usecs: 8           ← interrupt after 8 microseconds of inactivity
# rx-frames: 0          ← or after this many frames (0 = disabled)
# rx-usecs-irq: 0
# rx-frames-irq: 0
# tx-usecs: 8
# tx-frames: 0

# For low latency: disable coalescing (interrupt on every packet)
ethtool -C eth0 rx-usecs 0 tx-usecs 0 adaptive-rx off adaptive-tx off

# For high throughput: increase coalescing interval
ethtool -C eth0 rx-usecs 50 tx-usecs 50 adaptive-rx on adaptive-tx on

# Aggressive throughput tuning
ethtool -C eth0 rx-usecs 100 rx-frames 64 tx-usecs 100 tx-frames 64
```

## Section 7: NUMA-Aware Network Configuration

On multi-socket systems, network performance degrades significantly when packets cross NUMA boundaries. The NIC should be connected to the same NUMA node as the CPUs that process its interrupts.

### Identifying NIC NUMA Topology

```bash
# Find the NUMA node for a network interface
cat /sys/class/net/eth0/device/numa_node
# 0

# Show all devices and their NUMA nodes
for iface in /sys/class/net/*/device/numa_node; do
    IFACE=$(echo $iface | cut -d/ -f5)
    NODE=$(cat $iface 2>/dev/null || echo "N/A")
    echo "${IFACE}: NUMA node ${NODE}"
done

# Show NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 32676 MB
# node 0 free: 28234 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 32768 MB
# node 1 free: 30891 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# If NIC is on NUMA node 0, pin IRQs to CPUs 0-7,16-23
```

### NUMA-Optimal IRQ Assignment

```bash
#!/bin/bash
# numa_irq_affinity.sh — assign NIC IRQs to CPUs on the same NUMA node

INTERFACE="${1:-eth0}"
DEVICE_PATH=$(readlink -f /sys/class/net/${INTERFACE}/device)
NUMA_NODE=$(cat ${DEVICE_PATH}/numa_node 2>/dev/null || echo 0)

echo "Interface ${INTERFACE} is on NUMA node ${NUMA_NODE}"

# Get CPUs for this NUMA node
CPU_LIST=$(cat /sys/devices/system/node/node${NUMA_NODE}/cpulist)
echo "CPUs available on NUMA node ${NUMA_NODE}: ${CPU_LIST}"

# Expand CPU list to array
CPU_ARRAY=()
IFS=',' read -ra RANGES <<< "${CPU_LIST}"
for RANGE in "${RANGES[@]}"; do
    if [[ "${RANGE}" == *-* ]]; then
        START=$(echo ${RANGE} | cut -d- -f1)
        END=$(echo ${RANGE} | cut -d- -f2)
        for ((cpu=START; cpu<=END; cpu++)); do
            CPU_ARRAY+=($cpu)
        done
    else
        CPU_ARRAY+=(${RANGE})
    fi
done

echo "Expanded CPU list: ${CPU_ARRAY[@]}"

# Get IRQs for this interface
IRQS=$(grep "${INTERFACE}" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')
IDX=0

for IRQ in ${IRQS}; do
    CPU=${CPU_ARRAY[$((IDX % ${#CPU_ARRAY[@]}))]}
    echo "Pinning IRQ ${IRQ} to CPU ${CPU}"
    echo "${CPU}" > /proc/irq/${IRQ}/smp_affinity_list
    ((IDX++))
done

# Configure RPS/XPS to use the same NUMA node CPUs
CPU_MASK=$(cat /sys/devices/system/node/node${NUMA_NODE}/cpumap | tr -d '\n 0' | sed 's/^0*//')

for QUEUE_DIR in /sys/class/net/${INTERFACE}/queues/rx-*; do
    echo "${CPU_MASK}" > "${QUEUE_DIR}/rps_cpus"
    echo "4096" > "${QUEUE_DIR}/rps_flow_cnt"
done

for QUEUE_DIR in /sys/class/net/${INTERFACE}/queues/tx-*; do
    echo "${CPU_MASK}" > "${QUEUE_DIR}/xps_cpus"
done

echo "NUMA-aware network configuration complete"
```

### Running Applications with NUMA Affinity

```bash
# Bind a network application to the same NUMA node as the NIC
numactl --cpunodebind=0 --membind=0 ./my-network-app

# Or use taskset for CPU affinity
# For NIC on NUMA node 0, CPUs 0-7
taskset -c 0-7 ./my-network-app

# For kernel threads that process network packets
# Find ksoftirqd threads
ps aux | grep ksoftirqd
# root         11  0.0  0.0      0     0 ?        S    10:23   0:00 [ksoftirqd/0]
# root         17  0.0  0.0      0     0 ?        S    10:23   0:00 [ksoftirqd/1]

# Pin ksoftirqd to NUMA node CPUs (use chrt for real-time priority too)
for cpu in 0 1 2 3 4 5 6 7; do
    PID=$(pgrep -x "ksoftirqd/${cpu}")
    if [[ -n "${PID}" ]]; then
        taskset -cp ${cpu} ${PID}
    fi
done
```

## Section 8: Kernel Parameters for Network Performance

```bash
# /etc/sysctl.d/99-network-performance.conf

# Increase socket receive and send buffer sizes
net.core.rmem_max = 134217728       # 128 MB max receive buffer
net.core.wmem_max = 134217728       # 128 MB max send buffer
net.core.rmem_default = 16777216    # 16 MB default receive buffer
net.core.wmem_default = 16777216    # 16 MB default send buffer

# TCP-specific buffer tuning
net.ipv4.tcp_rmem = 4096 87380 134217728   # min default max
net.ipv4.tcp_wmem = 4096 65536 134217728

# Increase network device backlog queue
net.core.netdev_max_backlog = 250000

# Increase connection tracking table size
net.netfilter.nf_conntrack_max = 1000000

# Increase somaxconn for high-connection workloads
net.core.somaxconn = 65535

# TCP optimizations
net.ipv4.tcp_fastopen = 3           # Client and server TCP Fast Open
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_low_latency = 1

# Reduce TIME_WAIT impact
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# Reduce TCP keepalive interval
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# IP source routing (disable for security)
net.ipv4.conf.all.accept_source_route = 0

# Increase local port range
net.ipv4.ip_local_port_range = 1024 65535
```

```bash
# Apply immediately
sysctl -p /etc/sysctl.d/99-network-performance.conf
```

## Section 9: Measuring Performance Improvements

### Benchmark Tools

```bash
# iperf3 — measure throughput
# Server
iperf3 -s -p 5201

# Client — single stream
iperf3 -c SERVER_IP -p 5201 -t 30

# Client — parallel streams (stress multi-queue)
iperf3 -c SERVER_IP -p 5201 -t 30 -P 8

# netperf — lower-level benchmarking
# Install: apt-get install netperf
netserver &  # on server
netperf -H SERVER_IP -t TCP_STREAM -l 30
netperf -H SERVER_IP -t TCP_RR -l 30  # Request-response latency

# pktgen — kernel-level packet generation
modprobe pktgen
echo "add_device eth0" > /proc/net/pktgen/kpktgend_0
cat > /proc/net/pktgen/eth0 <<EOF
count 10000000
pkt_size 64
dst 192.168.1.100
dst_mac 00:11:22:33:44:55
EOF
echo "start" > /proc/net/pktgen/pgctrl
cat /proc/net/pktgen/eth0 | grep -E "pkts|err|pps"
```

### Monitoring Scripts

```bash
#!/bin/bash
# network_stats.sh — real-time network performance monitoring

INTERFACE="${1:-eth0}"

while true; do
    clear
    echo "=== Network Performance: ${INTERFACE} ==="
    echo ""

    echo "--- Interrupt Distribution ---"
    grep "${INTERFACE}" /proc/interrupts | awk '{
        printf "IRQ %s:", $1
        for (i=2; i<=NF-3; i++) printf " CPU%d=%s", i-2, $i
        print ""
    }'
    echo ""

    echo "--- Softnet Stats (drops/squeezes) ---"
    paste <(cat /proc/net/softnet_stat) <(seq 0 $(nproc)) | \
        awk '{printf "CPU%d: total=%d dropped=%d squeezed=%d rps=%d\n", $NF, strtonum("0x"$1), strtonum("0x"$2), strtonum("0x"$3), strtonum("0x"$10)}'
    echo ""

    echo "--- ethtool Stats ---"
    ethtool -S ${INTERFACE} 2>/dev/null | grep -E "rx_bytes|tx_bytes|rx_packets|tx_packets|rx_missed|rx_fifo|tx_dropped" | head -20
    echo ""

    sleep 2
done
```

## Section 10: Production Configuration Checklist

```bash
#!/bin/bash
# network_perf_setup.sh — complete production network tuning

set -euo pipefail

INTERFACE="${1:?Usage: $0 <interface>}"

echo "Configuring network performance for ${INTERFACE}..."

# 1. Set queue count to match CPU/NUMA topology
NUMA_NODE=$(cat /sys/class/net/${INTERFACE}/device/numa_node 2>/dev/null || echo 0)
NUMA_CPU_COUNT=$(cat /sys/devices/system/node/node${NUMA_NODE}/cpulist | \
    python3 -c "
import sys
total = 0
for part in sys.stdin.read().strip().split(','):
    if '-' in part:
        s, e = map(int, part.split('-'))
        total += e - s + 1
    else:
        total += 1
print(total)
")

echo "Setting ${NUMA_CPU_COUNT} queues for NUMA node ${NUMA_NODE}"
ethtool -L ${INTERFACE} combined ${NUMA_CPU_COUNT} 2>/dev/null || \
    echo "Warning: could not set queue count (driver may not support it)"

# 2. Tune ring buffers
MAX_RX=$(ethtool -g ${INTERFACE} 2>/dev/null | grep "^RX:" | tail -1 | awk '{print $2}')
MAX_TX=$(ethtool -g ${INTERFACE} 2>/dev/null | grep "^TX:" | tail -1 | awk '{print $2}')
ethtool -G ${INTERFACE} rx ${MAX_RX:-4096} tx ${MAX_TX:-4096} 2>/dev/null || \
    echo "Warning: could not set ring buffers"

# 3. Configure IRQ affinity
./set_irq_affinity.sh ${INTERFACE} 2>/dev/null || \
    echo "Warning: could not set IRQ affinity"

# 4. Configure RPS/RFS/XPS
./configure_rps.sh ${INTERFACE}

echo 32768 > /proc/sys/net/core/rps_sock_flow_entries

IDX=0
for TX_QUEUE in /sys/class/net/${INTERFACE}/queues/tx-*; do
    echo $((1 << IDX)) > "${TX_QUEUE}/xps_cpus" 2>/dev/null || true
    ((IDX++))
done

# 5. Apply kernel parameters
sysctl -p /etc/sysctl.d/99-network-performance.conf

echo "Network performance configuration complete."
echo "Run 'ethtool -S ${INTERFACE}' to monitor statistics."
```

## Conclusion

Optimal Linux network performance requires a layered approach. Start by understanding your NIC's hardware capabilities with `ethtool -l` and `ethtool -g`. Configure the number of hardware queues to match your NUMA topology. Pin IRQs to the CPUs on the same NUMA node as the NIC to avoid cross-socket memory access. Use RPS and RFS for NICs without hardware multi-queue support. Tune ring buffers based on your workload — larger for throughput, smaller for latency. Finally, apply kernel parameters and measure the improvement with `iperf3` or `netperf`.

The combination of RSS + NUMA-aware IRQ affinity + appropriate ring buffer sizing can reduce CPU overhead by 40-60% and increase throughput by 2-3x on modern multi-core servers compared to default configurations.
