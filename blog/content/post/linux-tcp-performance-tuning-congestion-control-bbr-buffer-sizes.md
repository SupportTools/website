---
title: "Linux TCP Performance Tuning: Congestion Control Algorithms, Buffer Sizes, and BBR Configuration"
date: 2031-08-02T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "Networking", "Performance", "BBR", "Congestion Control", "Kernel Tuning", "Sysctl"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux TCP performance tuning covering congestion control algorithm selection, socket buffer sizing, BBR configuration, and kernel parameter optimization for high-throughput production workloads."
more_link: "yes"
url: "/linux-tcp-performance-tuning-congestion-control-bbr-buffer-sizes/"
---

Linux TCP defaults are designed to be conservative and work reasonably well across a wide range of network conditions, but they are not optimized for the high-bandwidth, low-latency links that connect modern cloud infrastructure. A host with default TCP settings on a 10 Gbps link will typically achieve 1-3 Gbps of throughput. The same host, properly tuned with BBR congestion control and appropriate buffer sizes, can sustain 8-9 Gbps. For services where network throughput is the bottleneck, TCP tuning is one of the highest-leverage operations you can perform.

This guide covers the full TCP tuning stack: understanding congestion control algorithms, selecting buffer sizes based on bandwidth-delay product calculations, enabling BBR, and validating the impact of each change.

<!--more-->

# Linux TCP Performance Tuning: Congestion Control Algorithms, Buffer Sizes, and BBR Configuration

## Understanding the Problem Space

Before changing any settings, you need to measure the current state and understand what is limiting throughput.

### Bandwidth-Delay Product

The bandwidth-delay product (BDP) is the theoretical maximum amount of data that can be "in flight" on a network path at any moment:

```
BDP = Bandwidth × RTT
Example: 10 Gbps link, 1ms RTT
BDP = 10,000,000,000 bits/sec × 0.001 sec = 10,000,000 bits = 1.25 MB
```

TCP's send buffer must be at least as large as the BDP to fully utilize the link. The default Linux TCP socket buffer is 87380 bytes (~85 KB). On a 10 Gbps link with 1ms RTT, this limits throughput to approximately:

```
Max throughput = Buffer size / RTT = 87380 bytes / 0.001 sec ≈ 700 Mbps
```

This is why default settings underperform on high-speed links.

### Current State Assessment

```bash
# Check current congestion control algorithm
sysctl net.ipv4.tcp_congestion_control
# For available algorithms:
sysctl net.ipv4.tcp_available_congestion_control

# Check current buffer sizes
sysctl net.core.rmem_default net.core.rmem_max
sysctl net.core.wmem_default net.core.wmem_max
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem

# Check TCP statistics
ss -s          # socket summary
ss -ntp        # all TCP sockets with processes
cat /proc/net/tcp  # detailed TCP state table

# Network interface statistics
ip -s link show eth0
ethtool -S eth0 | grep -E 'rx_|tx_' | head -20

# Interrupt and soft IRQ distribution
cat /proc/interrupts | grep eth0
cat /proc/softirqs

# Measure current throughput (requires iperf3 on both ends)
# Server side:
iperf3 -s -p 5201

# Client side (single stream):
iperf3 -c <server-ip> -p 5201 -t 30

# Client side (multiple parallel streams, closer to real-world aggregate):
iperf3 -c <server-ip> -p 5201 -t 30 -P 8

# Measure RTT
ping -c 100 <target> | tail -1
# or
hping3 -c 100 -S <target> -p 443 --fast 2>&1 | tail -5
```

## Congestion Control Algorithms

Linux supports multiple TCP congestion control algorithms. The right choice depends on your network characteristics.

### CUBIC (Default)

CUBIC is the Linux default and performs well on standard LANs and WANs. It uses a cubic function to grow the congestion window, recovering quickly from losses.

```bash
# CUBIC is already default; verify:
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = cubic
```

CUBIC limitations:
- Buffers large amounts of data in network queues (bufferbloat)
- Aggressive window growth can saturate bottleneck links
- Performance degrades significantly over long-distance, high-latency paths

### BBR (Bottleneck Bandwidth and Round-trip propagation time)

BBR is Google's congestion control algorithm, introduced in Linux 4.9. Unlike loss-based algorithms (CUBIC, RENO), BBR estimates the bottleneck bandwidth and minimum RTT to operate at the network's true capacity without filling buffers.

BBR advantages:
- Higher throughput on high-BDP paths (continental and intercontinental links)
- Lower bufferbloat (reduced latency for competing flows)
- Better performance through shallow-buffered bottlenecks
- Faster convergence after congestion events

```bash
# Check if BBR is available
sysctl net.ipv4.tcp_available_congestion_control
# Should include 'bbr' on kernel 4.9+

# If bbr is not listed, load the module:
modprobe tcp_bbr
echo "tcp_bbr" >> /etc/modules-load.d/bbr.conf

# Enable BBR globally
sysctl -w net.ipv4.tcp_congestion_control=bbr

# BBR works best with fair queuing (FQ) packet scheduler
# This enables per-flow pacing which is critical for BBR
sysctl -w net.core.default_qdisc=fq

# Verify BBR is active
sysctl net.ipv4.tcp_congestion_control
# Verify FQ scheduler on your interfaces
tc qdisc show dev eth0
```

### BBRv2

BBRv2 (available in some distributions as a backport or in newer kernels) addresses BBRv1's over-aggressiveness in mixed deployments.

```bash
# Check kernel version (BBRv2 landed in 6.x)
uname -r

# BBRv2 availability
sysctl net.ipv4.tcp_available_congestion_control | grep bbr2
# If available:
sysctl -w net.ipv4.tcp_congestion_control=bbr2
```

### HTCP for WAN Links

HTCP performs well on high-bandwidth, high-latency paths:

```bash
modprobe tcp_htcp
sysctl -w net.ipv4.tcp_congestion_control=htcp
```

## Buffer Size Tuning

### Formula for Optimal Buffer Size

```
Optimal buffer = 2 × BDP × safety_factor
Where safety_factor = 1.5 to 2.0 (accounts for ACK processing delays)

For 10 Gbps, 5ms RTT (typical data center-to-data center):
BDP = 10e9 × 0.005 / 8 = 6.25 MB
Buffer = 2 × 6.25 × 1.5 = ~19 MB

For 1 Gbps, 50ms RTT (cross-continental):
BDP = 1e9 × 0.050 / 8 = 6.25 MB
Buffer = 2 × 6.25 × 1.5 = ~19 MB
```

### Setting Buffer Sizes

The `tcp_rmem` and `tcp_wmem` sysctls have three values: minimum, default, and maximum.

```bash
# Core socket buffer limits (applies to all socket types)
# These set the absolute maximum that tcp_rmem/tcp_wmem can reach
sysctl -w net.core.rmem_max=134217728    # 128 MB
sysctl -w net.core.wmem_max=134217728    # 128 MB
sysctl -w net.core.rmem_default=31457280  # 30 MB
sysctl -w net.core.wmem_default=31457280  # 30 MB

# TCP-specific buffer tuning
# Format: min default max (in bytes)
# min: minimum buffer, even under memory pressure
# default: initial buffer size for new connections (auto-tuned up from here)
# max: maximum buffer size (cannot exceed net.core.rmem/wmem_max)
sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"
sysctl -w net.ipv4.tcp_wmem="4096 65536 134217728"

# Enable TCP autotuning (should already be on by default)
sysctl -w net.ipv4.tcp_moderate_rcvbuf=1

# Increase the backlog for incoming connections
sysctl -w net.core.netdev_max_backlog=65536
sysctl -w net.ipv4.tcp_max_syn_backlog=65536
sysctl -w net.core.somaxconn=65536

# Memory pressure thresholds
# Format: min pressure max (in 4KB pages)
# Tune to match available RAM: these are global limits across all sockets
sysctl -w net.ipv4.tcp_mem="786432 1048576 26214400"
```

### Application-Level Buffer Hints

For applications you control, set socket buffer sizes explicitly to bypass the autotuning startup ramp-up:

```python
# Python example: setting high-performance socket buffers
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
# Request large buffers; kernel will grant up to wmem_max/rmem_max
sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 33554432)  # 32 MB
sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 33554432)  # 32 MB
```

```go
// Go example: setting TCP socket options
import (
    "net"
    "syscall"
)

listener, _ := net.Listen("tcp", ":8080")
tcpListener := listener.(*net.TCPListener)
f, _ := tcpListener.File()
// 32 MB receive buffer
syscall.SetsockoptInt(int(f.Fd()), syscall.SOL_SOCKET, syscall.SO_RCVBUF, 33554432)
syscall.SetsockoptInt(int(f.Fd()), syscall.SOL_SOCKET, syscall.SO_SNDBUF, 33554432)
```

## Additional Kernel Parameters

### Connection Management

```bash
# TIME_WAIT socket reuse (safe for client-facing services)
sysctl -w net.ipv4.tcp_tw_reuse=1
# Note: tcp_tw_recycle was removed in Linux 4.12 due to NAT issues; do not use it

# Reduce TIME_WAIT timer from default 60s to 30s
# WARNING: this can cause issues with certain NAT configurations
# Kernel default is not tunable via sysctl; set via ip_conntrack or netfilter

# Maximum number of TIME_WAIT sockets
sysctl -w net.ipv4.tcp_max_tw_buckets=1440000

# Keepalive settings (reduce time to detect dead connections)
sysctl -w net.ipv4.tcp_keepalive_time=60      # Start keepalives after 60s idle
sysctl -w net.ipv4.tcp_keepalive_intvl=10     # Interval between keepalive probes
sysctl -w net.ipv4.tcp_keepalive_probes=6     # Probes before declaring dead

# FIN_WAIT_2 timeout
sysctl -w net.ipv4.tcp_fin_timeout=15
```

### SYN Flood Protection

```bash
# SYN cookies: enables stateless SYN handling under flood conditions
sysctl -w net.ipv4.tcp_syncookies=1

# Increase SYN queue size
sysctl -w net.ipv4.tcp_max_syn_backlog=65536
```

### Receive Side Scaling (RSS) and Steering

```bash
# Enable RSS to distribute connections across CPU cores
# This is a NIC-level setting; check your driver documentation

# Check current queue count
ethtool -l eth0

# Set combined queues (match CPU count, up to NIC maximum)
ethtool -L eth0 combined $(nproc)

# RPS (software RSS for single-queue NICs)
echo "ff" > /sys/class/net/eth0/queues/rx-0/rps_cpus

# XPS (transmit packet steering)
echo "ff" > /sys/class/net/eth0/queues/tx-0/xps_cpus

# Enable RFS (Receive Flow Steering) — routes packets to the CPU
# that is running the application socket
sysctl -w net.core.rps_sock_flow_entries=32768
echo 32768 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
```

### TCP Timestamps and SACK

```bash
# TCP timestamps: required for RTTM and PAWS; keep enabled unless you have
# security concerns about timestamp-based fingerprinting
sysctl -w net.ipv4.tcp_timestamps=1

# Selective acknowledgment: essential for efficient loss recovery
sysctl -w net.ipv4.tcp_sack=1

# DSACK: duplicate SACK, allows sender to distinguish retransmit from
# network duplication
sysctl -w net.ipv4.tcp_dsack=1

# Forward acknowledgment
sysctl -w net.ipv4.tcp_fack=1

# Window scaling: required for buffers >64KB (should already be enabled)
sysctl -w net.ipv4.tcp_window_scaling=1

# Explicit Congestion Notification: reduces packet drops on ECN-capable networks
sysctl -w net.ipv4.tcp_ecn=1
```

## Persistent Configuration

Apply all settings at boot using `/etc/sysctl.d/`:

```bash
cat > /etc/sysctl.d/99-tcp-performance.conf << 'EOF'
# BBR congestion control
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Socket buffer sizes
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 31457280
net.core.wmem_default = 31457280

# TCP buffer autotuning
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.ipv4.tcp_moderate_rcvbuf = 1
net.ipv4.tcp_mem = 786432 1048576 26214400

# Connection management
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_max_tw_buckets = 1440000
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_max_syn_backlog = 65536
net.core.netdev_max_backlog = 65536
net.core.somaxconn = 65536

# Reliability
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_dsack = 1
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_ecn = 1

# Connection establishment
net.ipv4.tcp_syn_retries = 3
net.ipv4.tcp_synack_retries = 3
EOF

# Apply immediately
sysctl -p /etc/sysctl.d/99-tcp-performance.conf
```

### Module Loading at Boot

```bash
# Ensure BBR module loads at boot
echo "tcp_bbr" > /etc/modules-load.d/tcp-bbr.conf

# Verify after reboot
sysctl net.ipv4.tcp_congestion_control
tc qdisc show dev eth0
```

## Validating the Impact

### iperf3 Throughput Test

```bash
# Baseline (before tuning) — record this first
iperf3 -c <target> -t 60 -P 8 --logfile /tmp/baseline.txt

# After tuning:
iperf3 -c <target> -t 60 -P 8 --logfile /tmp/tuned.txt

# Compare results
grep "sender" /tmp/baseline.txt /tmp/tuned.txt

# Test with BBR vs CUBIC per-connection (requires kernel 4.9+)
# On Linux you can set the congestion control per socket via setsockopt
# For testing, temporarily switch the algorithm:
sysctl -w net.ipv4.tcp_congestion_control=cubic
iperf3 -c <target> -t 60 -P 8

sysctl -w net.ipv4.tcp_congestion_control=bbr
iperf3 -c <target> -t 60 -P 8
```

### ss: Socket Statistics

```bash
# View TCP buffer usage per connection
ss -ntpi dst <target-ip>

# Check for connections hitting buffer limits
# (rcv_wnd at 0 means receive window is advertised as 0 — buffer is full)
ss -ntpi | awk '/rcv_wnd:0/{print}'

# Detailed metrics for a single socket
ss -ntpoi dst <target-ip>
```

### /proc/net/netstat Analysis

```bash
# Check TCP statistics for signs of problems
cat /proc/net/netstat | awk 'NR%2==0{for(i=1;i<=NF;i++) printf "%s=%s\n", prev[i], $i}
                              NR%2==1{for(i=1;i<=NF;i++) prev[i]=$i}'

# Key metrics to watch:
# TCPSackRecovery: SACK-based recovery events
# TCPLostRetransmit: retransmissions due to loss
# TCPFullUndo: congestion window fully recovered (good sign with BBR)
# TCPBacklogCoalesce: skb merging (generally positive)

# Watch TCP error counters in real time
watch -n 1 'netstat -s | grep -E "retransmit|reset|fail|error|overflow|drop"'
```

### Wireshark/tcpdump Analysis

```bash
# Capture traffic and examine TCP window scaling
tcpdump -nn -i eth0 -w /tmp/capture.pcap host <target> &
sleep 30
kill %1

# Analyze with tcptrace (shows throughput, window sizes, RTT)
tcptrace -G /tmp/capture.pcap

# Or use tshark for automated analysis
tshark -r /tmp/capture.pcap -q -z io,stat,1,"tcp"
```

## Kubernetes and Container Considerations

In Kubernetes, TCP settings must be applied at the node level (to the host kernel), not inside pods. Pods inherit the host network namespace's TCP parameters.

```yaml
# DaemonSet to apply sysctl tuning to all nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: tcp-tuning
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: tcp-tuning
  template:
    metadata:
      labels:
        app: tcp-tuning
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - effect: NoSchedule
          operator: Exists
      initContainers:
        - name: apply-sysctl
          image: busybox:1.37
          securityContext:
            privileged: true
          command: [sh, -c]
          args:
            - |
              set -e
              sysctl -w net.core.default_qdisc=fq
              sysctl -w net.ipv4.tcp_congestion_control=bbr
              sysctl -w net.core.rmem_max=134217728
              sysctl -w net.core.wmem_max=134217728
              sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"
              sysctl -w net.ipv4.tcp_wmem="4096 65536 134217728"
              sysctl -w net.ipv4.tcp_tw_reuse=1
              sysctl -w net.core.somaxconn=65536
              echo "TCP tuning applied successfully"
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
```

### Pod-Level Sysctl (Safe Subset Only)

Kubernetes allows certain "safe" sysctls to be set per-pod. TCP buffer settings are not in the safe subset and require node-level tuning.

```yaml
# For safe sysctls only (TCP buffer changes require node-level)
apiVersion: v1
kind: Pod
spec:
  securityContext:
    sysctls:
      # These are safe because they are namespaced
      - name: net.ipv4.ip_local_port_range
        value: "1024 65535"
      - name: net.ipv4.tcp_syncookies
        value: "1"
```

## Profiling Specific Bottlenecks

### Identifying Buffer Bloat

```bash
# Bufferbloat test: ping during saturated download
# Start a large download
wget -O /dev/null http://<server>/large-file &

# Measure latency increase during download
ping -i 0.1 -c 100 <server>

# With CUBIC: expect 10x+ latency increase during saturation
# With BBR: expect 2-3x latency increase (much better)
# With BBR + FQ: expect near-baseline latency even during saturation
```

### CPU Soft IRQ Analysis

High-throughput networking can saturate CPU soft IRQs. Distribute interrupt processing across cores.

```bash
# Watch soft IRQ distribution
watch -n 1 'cat /proc/softirqs | grep -E "^NET|^RX|^TX"'

# Check if all interrupts are handled by CPU 0 (bad for performance)
# Solution: enable irqbalance or manually set IRQ affinity
systemctl enable --now irqbalance

# Or manually distribute:
# List NIC IRQs
cat /proc/interrupts | grep eth0

# Set affinity for each IRQ (e.g., IRQ 42 to CPU 0, IRQ 43 to CPU 1)
echo "1" > /proc/irq/42/smp_affinity
echo "2" > /proc/irq/43/smp_affinity
echo "4" > /proc/irq/44/smp_affinity
echo "8" > /proc/irq/45/smp_affinity
```

### GRO/GSO Configuration

```bash
# Generic Receive Offload: reduces CPU for receive processing
ethtool -k eth0 | grep receive-offload
ethtool -K eth0 gro on

# Generic Segmentation Offload: reduces CPU for transmit
ethtool -k eth0 | grep segmentation
ethtool -K eth0 gso on
ethtool -K eth0 tso on

# TCP Segmentation Offload (hardware)
ethtool -K eth0 tx-tcp-segmentation on
```

## Performance Validation Matrix

After applying all tuning, measure the following metrics and document them as your baseline for future comparisons:

```bash
#!/bin/bash
# tcp-benchmark.sh - comprehensive TCP performance validation

TARGET="${1:-10.0.0.2}"

echo "=== TCP Performance Benchmark ==="
echo "Target: $TARGET"
echo "Date: $(date)"
echo ""

echo "--- Kernel Settings ---"
sysctl net.ipv4.tcp_congestion_control
sysctl net.core.default_qdisc
sysctl net.core.rmem_max
sysctl net.ipv4.tcp_rmem
echo ""

echo "--- Single Stream Throughput ---"
iperf3 -c "$TARGET" -t 30 2>&1 | grep -E "sender|receiver"
echo ""

echo "--- Multi-Stream Throughput (8 streams) ---"
iperf3 -c "$TARGET" -t 30 -P 8 2>&1 | grep "SUM"
echo ""

echo "--- Latency Under Load ---"
# Start background traffic
iperf3 -c "$TARGET" -t 60 -P 4 > /dev/null &
IPERF_PID=$!
sleep 5
ping -c 50 -i 0.1 "$TARGET" 2>&1 | tail -3
kill $IPERF_PID 2>/dev/null
echo ""

echo "--- TCP Error Counters ---"
netstat -s | grep -E "retransmit|reset|overflow"
```

## Summary

TCP tuning for Linux production systems follows a predictable methodology:

1. Measure baseline throughput and latency before any changes
2. Switch to BBR congestion control with FQ queuing discipline on all hosts communicating over links with BDP > 1 MB
3. Size socket buffers to at least 2x the BDP of your longest significant network path, with the maximum at 128 MB to avoid memory waste
4. Enable TCP autotuning (the default) rather than hard-coding buffer sizes; autotuning scales down for short connections
5. Apply tuning at the node level for Kubernetes deployments via a privileged DaemonSet
6. Measure again: document throughput, latency under load, and CPU utilization after each change

The combination of BBR + FQ + adequate buffer sizes typically yields a 2-5x throughput improvement over defaults on high-BDP paths, with the additional benefit of significantly reduced bufferbloat that improves latency for all competing flows.
