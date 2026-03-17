---
title: "Linux TCP Stack Tuning: High-Throughput Network Optimization for Production Services"
date: 2030-06-08T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "Network Tuning", "Performance", "BBR", "Kernel", "System Administration"]
categories:
- Linux
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive TCP tuning guide: send/receive buffer sizing, congestion control algorithms (BBR, CUBIC), TCP Fast Open, TIME_WAIT handling, socket options, and benchmarking network performance improvements."
more_link: "yes"
url: "/linux-tcp-stack-tuning-high-throughput-network-optimization/"
---

The Linux TCP stack ships with conservative defaults optimized for memory-constrained servers handling diverse workloads. Production services with specific traffic patterns — high-throughput bulk transfers, latency-sensitive API endpoints, or connections over high-bandwidth high-latency links — routinely leave significant performance on the table by running with untuned defaults. This guide covers the kernel parameters, congestion control algorithms, and socket options that matter, with benchmarking methodology to validate improvements.

<!--more-->

## TCP Performance Fundamentals

### Why Buffer Sizes Matter

TCP throughput is bounded by the bandwidth-delay product (BDP):

```
Maximum Throughput = Receive Window Size / Round-Trip Time

Example:
  Link speed: 10 Gbps
  RTT: 100ms
  BDP = 10,000,000,000 bits/s * 0.1s = 1,000,000,000 bits = 125 MB

  To saturate a 10 Gbps link with 100ms RTT requires a 125 MB receive buffer.
  Linux default rmem_max: 212992 bytes (208 KB) — far too small.
```

The default 208 KB buffer limits TCP throughput to approximately 16 Mbps on a 100ms RTT link, regardless of available bandwidth.

### Checking Current Configuration

```bash
# Current TCP buffer sizes
sysctl net.core.rmem_default
sysctl net.core.rmem_max
sysctl net.core.wmem_default
sysctl net.core.wmem_max
sysctl net.ipv4.tcp_rmem
sysctl net.ipv4.tcp_wmem

# Current congestion control algorithm
sysctl net.ipv4.tcp_congestion_control

# Available congestion control algorithms
sysctl net.ipv4.tcp_available_congestion_control

# TCP memory allocation
sysctl net.ipv4.tcp_mem

# Connection tracking
sysctl net.ipv4.tcp_max_syn_backlog
sysctl net.core.somaxconn
sysctl net.core.netdev_max_backlog

# Measure current BDP with a test
# From server to client:
iperf3 -s

# From client (measures throughput with default buffers):
iperf3 -c <server-ip> -t 30 -P 4
```

## Buffer Sizing

### Socket Buffer Parameters

```bash
# Core socket buffer limits (all values in bytes)
# rmem: receive buffer | wmem: send buffer

# Maximum socket receive buffer (user-settable via SO_RCVBUF)
sysctl -w net.core.rmem_max=134217728   # 128 MB

# Maximum socket send buffer (user-settable via SO_SNDBUF)
sysctl -w net.core.wmem_max=134217728   # 128 MB

# Default socket receive buffer (per socket, before app sets SO_RCVBUF)
sysctl -w net.core.rmem_default=8388608  # 8 MB

# Default socket send buffer (per socket, before app sets SO_SNDBUF)
sysctl -w net.core.wmem_default=8388608  # 8 MB
```

### TCP-Specific Buffer Tuning

```bash
# tcp_rmem: min, default, max for TCP receive buffer auto-tuning
# Format: min_bytes default_bytes max_bytes
sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"
#                              4KB   85KB    128MB

# tcp_wmem: min, default, max for TCP send buffer auto-tuning
sysctl -w net.ipv4.tcp_wmem="4096 65536 134217728"
#                              4KB   64KB   128MB

# Enable auto-tuning (should be enabled — verify)
sysctl net.ipv4.tcp_moderate_rcvbuf  # Should be 1
```

### TCP Memory Pressure

```bash
# tcp_mem: min, pressure, max (in pages — multiply by 4096 for bytes)
# min: No memory pressure below this. Normal operation.
# pressure: Attempt to reduce memory usage when above this.
# max: Maximum TCP memory. Connections refuse new buffers above this.
#
# Rule of thumb: max ≈ system_memory * 0.5 / 4096

TOTAL_MEM_PAGES=$(grep MemTotal /proc/meminfo | awk '{print $2/4}')
echo "Total memory in pages: $TOTAL_MEM_PAGES"

sysctl -w "net.ipv4.tcp_mem=$(echo "$TOTAL_MEM_PAGES * 0.125 / 1" | bc) \
           $(echo "$TOTAL_MEM_PAGES * 0.25 / 1" | bc) \
           $(echo "$TOTAL_MEM_PAGES * 0.5 / 1" | bc)"

# Check current TCP memory usage
cat /proc/net/sockstat | grep TCP
```

## Congestion Control Algorithms

### CUBIC (Default)

CUBIC is the default Linux congestion control algorithm. It's optimized for high-bandwidth, high-RTT networks (long fat networks) and handles packet loss by reducing congestion window by a fixed factor.

```bash
# Verify CUBIC is active
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = cubic
```

CUBIC's window growth function is cubic in the time since the last congestion event, allowing faster recovery after packet loss on fast links.

### BBR (Bottleneck Bandwidth and RTT)

BBR (developed by Google) is fundamentally different from loss-based algorithms. Instead of using packet loss as the congestion signal, BBR estimates the bottleneck bandwidth and RTT directly and explicitly controls how much data is in flight.

BBR advantages over CUBIC:
- **Significantly better throughput on links with high packet loss** (cellular, cross-continental) where loss-based algorithms over-reduce the congestion window
- **Lower latency** — BBR fills the network pipe without overfilling buffers (reduced bufferbloat)
- **Better performance in shallow-buffered networks**

```bash
# Load BBR module
modprobe tcp_bbr

# Verify the module is loaded
lsmod | grep bbr

# Enable BBR globally
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Enable FQ packet scheduler (recommended with BBR)
sysctl -w net.core.default_qdisc=fq

# Verify
sysctl net.ipv4.tcp_congestion_control
tc qdisc show dev eth0
```

### Making Settings Persistent

```bash
# /etc/sysctl.d/99-tcp-tuning.conf
cat > /etc/sysctl.d/99-tcp-tuning.conf << 'EOF'
# TCP buffer tuning for high-throughput environments
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 8388608
net.core.wmem_default = 8388608

net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.ipv4.tcp_mem = 786432 1048576 26214400

# BBR congestion control
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Connection queue depths
net.core.netdev_max_backlog = 5000
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 8192

# TIME_WAIT handling
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# TCP Fast Open
net.ipv4.tcp_fastopen = 3

# Selective acknowledgements (SACK) — ensure enabled
net.ipv4.tcp_sack = 1

# Large receive offload — ensure enabled
# (actual config is in NIC driver, this verifies kernel support)
net.ipv4.tcp_window_scaling = 1
EOF

# Apply immediately
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf

# Load BBR on boot
echo "tcp_bbr" >> /etc/modules-load.d/modules.conf
```

## TIME_WAIT Handling

### Understanding TIME_WAIT

TIME_WAIT is the state a connection enters after the local side sends the final FIN and receives ACK. It persists for 2 * MSL (Maximum Segment Lifetime, default 60 seconds on Linux) to prevent stale packets from a closed connection being mistaken for a new one.

High-throughput servers that open and close many short connections accumulate millions of TIME_WAIT sockets, consuming file descriptors and port numbers.

```bash
# Count TIME_WAIT sockets
ss -s | grep -i time_wait

# Detailed breakdown
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
```

### TIME_WAIT Mitigation

```bash
# tcp_tw_reuse: Allow reusing TIME_WAIT sockets for NEW outbound connections
# (safe: uses TCP timestamps to distinguish old vs new connections)
sysctl -w net.ipv4.tcp_tw_reuse=1

# tcp_fin_timeout: Reduce FIN_WAIT_2 timeout (default 60s)
sysctl -w net.ipv4.tcp_fin_timeout=15

# SO_LINGER = 0 (application-level): RST instead of FIN
# Only use when you don't care about in-flight data
# conn.SetLinger(0) in Go

# Expand the ephemeral port range to allow more simultaneous connections
sysctl -w net.ipv4.ip_local_port_range="10000 65535"

# Check available ports
cat /proc/sys/net/ipv4/ip_local_port_range
```

### What to Avoid: tcp_tw_recycle

`net.ipv4.tcp_tw_recycle` was removed in Linux 4.12 because it broke NAT environments. Never attempt to restore or use it.

## TCP Fast Open

TCP Fast Open (TFO) allows data to be sent in the initial SYN packet for connections to previously-visited servers, saving one full RTT on connection establishment.

```bash
# Enable TFO for both client and server
# Bit 0: client (sends TFO cookie requests)
# Bit 1: server (accepts TFO)
# Value 3: both
sysctl -w net.ipv4.tcp_fastopen=3

# Verify
sysctl net.ipv4.tcp_fastopen

# Monitor TFO usage
netstat -s | grep -i "fast open"
```

### TFO in Go Applications

```go
package main

import (
    "net"
    "syscall"
)

// CreateTFOListener creates a TCP listener with Fast Open enabled.
func CreateTFOListener(addr string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                // TCP_FASTOPEN = 23 on Linux
                syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, 23, 1024)
            })
        },
    }
    return lc.Listen(nil, "tcp", addr)
}
```

## Socket-Level Tuning

### Application-Level Buffer Control

Applications can set per-socket buffer sizes using `SO_RCVBUF` and `SO_SNDBUF`. The kernel doubles the value you set (the extra space is for kernel bookkeeping):

```go
package main

import (
    "net"
    "syscall"
)

// ConfigureHighThroughputConn sets socket options for high-throughput transfer.
func ConfigureHighThroughputConn(conn net.Conn, bufferSize int) error {
    rawConn, err := conn.(*net.TCPConn).SyscallConn()
    if err != nil {
        return err
    }

    return rawConn.Control(func(fd uintptr) {
        // Set receive buffer (kernel doubles this value)
        syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_RCVBUF, bufferSize)

        // Set send buffer
        syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_SNDBUF, bufferSize)

        // Disable Nagle's algorithm for latency-sensitive connections
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
            syscall.TCP_NODELAY, 1)

        // Enable TCP keepalive
        syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_KEEPALIVE, 1)

        // Keepalive interval (seconds before sending keepalive probes)
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
            syscall.TCP_KEEPIDLE, 30)

        // Interval between probes
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
            syscall.TCP_KEEPINTVL, 5)

        // Number of probes before giving up
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
            syscall.TCP_KEEPCNT, 3)
    })
}
```

### TCP_CORK and TCP_NODELAY

```go
// TCP_CORK: Buffer small writes until buffer is full or cork is released.
// Useful for building HTTP responses: cork while adding headers,
// then uncork to send the full response in one segment.
func SetCork(conn net.Conn, enable bool) error {
    rawConn, err := conn.(*net.TCPConn).SyscallConn()
    if err != nil {
        return err
    }
    val := 0
    if enable {
        val = 1
    }
    return rawConn.Control(func(fd uintptr) {
        // TCP_CORK = 3 on Linux
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, 3, val)
    })
}

// TCP_NODELAY: Disable Nagle's algorithm (send small packets immediately).
// Essential for interactive applications; reduces latency at the cost of
// potentially more small packets on the network.
func SetNoDelay(conn net.Conn, noDelay bool) error {
    return conn.(*net.TCPConn).SetNoDelay(noDelay)
}
```

## High Connection Rate Tuning

### SYN Backlog and Accept Queue

```bash
# Maximum number of pending connections in the SYN queue
sysctl -w net.ipv4.tcp_max_syn_backlog=8192

# Maximum number of pending connections in the accept queue
# Applications also need to call listen() with a large backlog
sysctl -w net.core.somaxconn=65535

# SYN cookies: protect against SYN flood without dropping connections
sysctl -w net.ipv4.tcp_syncookies=1
```

```go
// Set listen backlog in application
listener, err := net.Listen("tcp", ":8080")
if err != nil {
    panic(err)
}

// Go's net.Listen uses the kernel default for backlog.
// To set a custom backlog, use syscall directly:
import (
    "syscall"
    "net"
)

fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
syscall.Bind(fd, &syscall.SockaddrInet4{Port: 8080})
syscall.Listen(fd, 65535)  // Large backlog for high connection rate
```

### Connection Rate Limiting with iptables

Protect services from connection floods while allowing legitimate high rates:

```bash
# Rate limit new connections from a single source to 100/minute
iptables -A INPUT -p tcp --dport 8080 -m conntrack \
  --ctstate NEW -m limit \
  --limit 100/minute --limit-burst 50 -j ACCEPT

iptables -A INPUT -p tcp --dport 8080 -m conntrack \
  --ctstate NEW -j DROP
```

## Network Device Tuning

### NIC Ring Buffer Size

```bash
# Check current ring buffer sizes
ethtool -g eth0

# Increase ring buffer to handle traffic bursts
ethtool -G eth0 rx 4096 tx 4096

# Verify
ethtool -g eth0
```

### Interrupt Coalescing

```bash
# Check current interrupt coalescing settings
ethtool -c eth0

# Adjust for lower latency (reduce coalescing)
ethtool -C eth0 rx-usecs 50 tx-usecs 50

# Adjust for higher throughput (increase coalescing)
ethtool -C eth0 rx-usecs 200 tx-usecs 200
```

### Multi-Queue NICs and IRQ Affinity

```bash
# Check NIC queue count
ethtool -l eth0

# Set number of queues (if driver supports it)
ethtool -L eth0 combined 16

# Check IRQ assignments
cat /proc/interrupts | grep eth0

# Set IRQ affinity to spread across all CPUs
# (Usually handled automatically by irqbalance)
systemctl status irqbalance

# Manual IRQ affinity for NUMA-aware placement
# Find IRQ numbers for eth0
ETH_IRQS=$(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':')
for irq in $ETH_IRQS; do
    echo "Setting IRQ $irq affinity"
done
```

### TCP Segmentation Offload

```bash
# Check offload settings
ethtool -k eth0

# Verify TSO (TCP Segmentation Offload) is enabled
ethtool -k eth0 | grep -E "(tcp-segmentation-offload|generic-segmentation-offload)"

# Enable offloads (usually enabled by default)
ethtool -K eth0 tso on gso on gro on
```

## Benchmarking

### iperf3 Baseline Measurements

```bash
# Install iperf3
apt-get install -y iperf3  # Debian/Ubuntu
yum install -y iperf3      # RHEL/CentOS

# Server side
iperf3 -s -p 5201

# Client: single stream TCP throughput
iperf3 -c <server-ip> -t 30

# Client: parallel streams (tests multiple connections)
iperf3 -c <server-ip> -t 30 -P 8

# Client: measure with large buffer
iperf3 -c <server-ip> -t 30 -P 8 --window 128M

# Client: UDP test (useful for baseline latency measurement)
iperf3 -c <server-ip> -u -b 1G -t 30

# Bidirectional test
iperf3 -c <server-ip> -t 30 --bidir
```

### Latency Measurement with netperf

```bash
# Install netperf
apt-get install -y netperf

# Start server
netserver

# TCP request/response latency (simulates HTTP API traffic)
netperf -H <server-ip> -t TCP_RR -l 30 -- -r 64,64

# Transaction rate test
netperf -H <server-ip> -t TCP_CRR -l 30
```

### Before/After Comparison Script

```bash
#!/usr/bin/env bash
# measure-tcp-performance.sh

SERVER_IP="${1:?Usage: $0 <server-ip>}"
DURATION=30
PARALLEL=4

echo "=== TCP Performance Baseline ==="
echo "Server: $SERVER_IP"
echo "Duration: ${DURATION}s, Parallel streams: $PARALLEL"
echo ""

echo "--- Throughput Test ---"
iperf3 -c "$SERVER_IP" -t "$DURATION" -P "$PARALLEL" -J | \
  jq '.end.sum_received.bits_per_second / 1e9 | . * 100 | round | . / 100' | \
  xargs -I{} echo "Throughput: {} Gbps"

echo ""
echo "--- Latency Test (TCP_RR) ---"
netperf -H "$SERVER_IP" -t TCP_RR -l "$DURATION" -- -r 64,64 | \
  tail -1 | awk '{print "Transaction Rate:", $6, "trans/s"}'

echo ""
echo "--- Current Socket Statistics ---"
ss -s

echo ""
echo "--- TCP Memory Usage ---"
cat /proc/net/sockstat | grep -E "TCP|sockets"
```

### Monitoring Retransmissions

Retransmissions indicate packet loss or buffer overflow — key indicators that tuning is needed:

```bash
# Monitor retransmission rate
netstat -s | grep -i retransmit
# or
ss -s

# Watch retransmit counter in real time
while true; do
    netstat -s 2>/dev/null | grep -i "segments retransmited"
    sleep 5
done

# Check for buffer overflow drops
netstat -s | grep -E "(overflow|dropped|pruned)"

# Prometheus node_exporter metrics for retransmissions
# node_netstat_Tcp_RetransSegs
# node_netstat_TcpExt_TCPSynRetrans
```

## Kubernetes Cluster Networking Considerations

### Host Network Namespace vs Pod Network

Tunings applied to the host network namespace affect all pods using `hostNetwork: true` but not pods in their own network namespace. Apply sysctl tunings inside pods using Kubernetes pod security:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: high-throughput-service
spec:
  securityContext:
    sysctls:
      # These sysctls are namespaced (safe for pods)
      - name: net.ipv4.tcp_rmem
        value: "4096 87380 134217728"
      - name: net.ipv4.tcp_wmem
        value: "4096 65536 134217728"
  containers:
    - name: service
      image: registry.example.com/service:v1.0.0
```

### Allowing Pod-Level Sysctls

```yaml
# Safe sysctls are allowed by default in most Kubernetes versions.
# Unsafe sysctls require PSA policy exceptions.
# Safe sysctls (namespaced, pod-level):
# - kernel.shm_rmid_forced
# - net.ipv4.ip_local_port_range
# - net.ipv4.ip_unprivileged_port_start
# - net.ipv4.tcp_syncookies
# - net.ipv4.ping_group_range
# - net.ipv4.tcp_fastopen

# Node-level tuning via DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: tcp-tuning
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: tcp-tuning
  template:
    metadata:
      labels:
        name: tcp-tuning
    spec:
      hostNetwork: true
      hostPID: true
      initContainers:
        - name: sysctl-tuner
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              sysctl -w net.core.rmem_max=134217728
              sysctl -w net.core.wmem_max=134217728
              sysctl -w net.ipv4.tcp_congestion_control=bbr
              sysctl -w net.core.default_qdisc=fq
              echo "TCP tuning applied"
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
```

## Summary

TCP performance tuning on Linux requires understanding the relationship between buffer sizes, bandwidth-delay product, and congestion control algorithms. The default kernel values are conservative — appropriate for unknown workloads but suboptimal for high-throughput services.

The highest-impact changes for most production workloads are:
1. **Increase buffer sizes** to match the bandwidth-delay product of your network paths
2. **Enable BBR** for workloads with any meaningful packet loss or variable RTT
3. **Set `tcp_tw_reuse=1`** for services making many outbound connections
4. **Tune the accept queue** to match peak connection arrival rates

Always benchmark before and after each change, and validate using realistic traffic patterns rather than synthetic benchmarks. The combination of iperf3 for throughput, netperf's TCP_RR for latency-sensitive workloads, and Prometheus metrics for production monitoring provides the observability needed to confirm improvements and detect regressions.
