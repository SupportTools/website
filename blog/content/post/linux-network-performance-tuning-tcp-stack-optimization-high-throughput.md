---
title: "Linux Network Performance Tuning: TCP Stack Optimization for High-Throughput Services"
date: 2031-02-21T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "TCP", "Performance Tuning", "Kernel", "High Throughput"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Linux TCP stack optimization covering buffer tuning, Nagle algorithm, TCP_CORK, SO_REUSEPORT, BBR congestion control, and benchmarking with iperf3 and netperf for enterprise high-throughput services."
more_link: "yes"
url: "/linux-network-performance-tuning-tcp-stack-optimization-high-throughput/"
---

The Linux TCP stack is highly configurable, but the default values are conservative — tuned for compatibility across diverse network conditions rather than peak throughput in data center environments. For services handling tens of thousands of connections per second or moving hundreds of gigabits per hour, the difference between default settings and properly tuned settings can be 200-400% in throughput.

This guide walks through the complete TCP optimization stack: buffer sizing, socket options, congestion control algorithms, multi-queue accept, and measurement methodology.

<!--more-->

# Linux Network Performance Tuning: TCP Stack Optimization for High-Throughput Services

## Section 1: Understanding the TCP Receive and Send Pipeline

Before tuning, you need to understand where data moves:

```
Application write() -> Socket send buffer (sk_sndbuf)
                    -> TCP segmentation
                    -> IP layer
                    -> NIC TX ring buffer
                    -> Wire

Wire -> NIC RX ring buffer
     -> Kernel RX path (NAPI)
     -> Socket receive buffer (sk_rcvbuf)
     -> Application read()
```

Bottlenecks can occur at:
1. Socket buffer overflow (data dropped, causing retransmits)
2. CPU saturation in softirq processing
3. NIC ring buffer overflow
4. TCP window size limiting throughput (BDP problem)

### Bandwidth-Delay Product

The Bandwidth-Delay Product (BDP) defines the minimum buffer size needed to keep a link fully utilized:

```
BDP = Bandwidth × RTT

Example: 10 Gbps link, 1ms RTT
BDP = 10,000,000,000 bps × 0.001 s = 10,000,000 bytes = ~10 MB

Default Linux rmem_max = 131,072 bytes (128 KB)
This limits a 10 Gbps link to:
  128 KB / 0.001 s = 128 MB/s = ~1 Gbps (10% of capacity!)
```

The TCP window size cannot exceed the receive buffer. With the default 128 KB buffer on a 10 Gbps link with 1 ms RTT, you leave 90% of capacity on the table.

## Section 2: System-Wide Buffer Configuration

### Current Values Baseline

```bash
# Check current TCP buffer settings
sysctl net.core.rmem_max
sysctl net.core.wmem_max
sysctl net.core.rmem_default
sysctl net.core.wmem_default
sysctl net.ipv4.tcp_rmem
sysctl net.ipv4.tcp_wmem
sysctl net.ipv4.tcp_mem

# Check socket buffer allocation strategy
sysctl net.ipv4.tcp_adv_win_scale
sysctl net.ipv4.tcp_moderate_rcvbuf
```

### Production Buffer Settings

```bash
# /etc/sysctl.d/99-tcp-tuning.conf
# Apply with: sysctl -p /etc/sysctl.d/99-tcp-tuning.conf

# =============================================
# Network core settings
# =============================================

# Maximum receive socket buffer size (bytes)
# For 10 Gbps links with 1ms RTT: BDP = 1.25 MB, set 2x for safety
net.core.rmem_max = 67108864          # 64 MB

# Maximum send socket buffer size
net.core.wmem_max = 67108864          # 64 MB

# Default receive socket buffer (can be overridden per socket)
net.core.rmem_default = 1048576       # 1 MB

# Default send socket buffer
net.core.wmem_default = 1048576       # 1 MB

# Maximum receive queue before packets are dropped at interface
net.core.netdev_max_backlog = 250000

# Maximum number of sockets queued for accept()
net.core.somaxconn = 65535

# Optmem - socket option memory
net.core.optmem_max = 67108864

# =============================================
# TCP-specific settings
# =============================================

# TCP receive buffer: min / default / max (bytes)
# min: minimum allocated per socket
# default: initial allocation (overrides net.core.rmem_default for TCP)
# max: maximum autotuned value
net.ipv4.tcp_rmem = 4096 1048576 67108864

# TCP send buffer: min / default / max
net.ipv4.tcp_wmem = 4096 1048576 67108864

# TCP memory pressure thresholds (pages, not bytes)
# min: start reclaiming memory
# pressure: continue reclaiming
# max: hard limit, drop connections
# Each page = 4096 bytes on x86
net.ipv4.tcp_mem = 786432 1048576 26777216

# Enable TCP receive buffer autotuning
net.ipv4.tcp_moderate_rcvbuf = 1

# Increase TCP connection backlog
net.ipv4.tcp_max_syn_backlog = 65535

# TCP FIN_WAIT2 timeout (seconds)
net.ipv4.tcp_fin_timeout = 15

# TIME_WAIT connection recycling (be careful with NAT)
net.ipv4.tcp_tw_reuse = 1

# Maximum TIME_WAIT sockets
net.ipv4.tcp_max_tw_buckets = 2000000

# TCP keepalive settings
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5

# SYN retry count
net.ipv4.tcp_syn_retries = 3
net.ipv4.tcp_synack_retries = 3

# =============================================
# BBR congestion control (see Section 6)
# =============================================
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# =============================================
# IPv4 local port range
# =============================================
net.ipv4.ip_local_port_range = 1024 65535
```

Apply the settings:

```bash
# Apply immediately without reboot
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf

# Verify applied
sysctl net.ipv4.tcp_rmem
# Output: net.ipv4.tcp_rmem = 4096 1048576 67108864
```

## Section 3: The Nagle Algorithm and TCP_NODELAY

The Nagle algorithm (RFC 896) was designed to reduce the number of small TCP segments. It works by buffering small writes until either:
- The buffer reaches the MSS (Maximum Segment Size), or
- An ACK arrives for previously unacknowledged data.

This is excellent for bulk data transfer but terrible for interactive protocols and request/response applications.

### When Nagle Causes Latency Problems

```
Application sends 100-byte request
  -> Nagle buffers it (waiting for MSS or ACK)
Server is waiting for request
  -> 40ms ACK timeout on client side
  -> Nagle finally flushes the buffer
Server processes request, sends response
Total latency: 40+ ms instead of sub-millisecond
```

This is the "Nagle delay" — and it interacts badly with delayed ACK (another optimization) to create the infamous "Nagle/delayed-ACK" 40ms delay.

### Disabling Nagle with TCP_NODELAY

```c
// C example — set TCP_NODELAY on a socket
#include <netinet/tcp.h>

int flag = 1;
setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, (char *)&flag, sizeof(flag));
```

In Go:

```go
package main

import (
    "net"
    "syscall"
)

func setTCPNoDelay(conn net.Conn) error {
    tcpConn, ok := conn.(*net.TCPConn)
    if !ok {
        return nil
    }
    return tcpConn.SetNoDelay(true)
}

// For a TCP listener, set nodelay on all accepted connections
func acceptWithNoDelay(ln *net.TCPListener) (*net.TCPConn, error) {
    conn, err := ln.AcceptTCP()
    if err != nil {
        return nil, err
    }
    if err := conn.SetNoDelay(true); err != nil {
        conn.Close()
        return nil, err
    }
    return conn, nil
}
```

### TCP_NODELAY vs TCP_CORK

| Option | Purpose | Use Case |
|---|---|---|
| TCP_NODELAY | Disable Nagle | RPC/request-response protocols |
| TCP_CORK | Buffer until full MSS or uncorked | Bulk file/data transfer |
| Default (neither) | Nagle active | Telnet-style interactive sessions |

## Section 4: TCP_CORK for Bulk Transfer Optimization

`TCP_CORK` is the opposite of `TCP_NODELAY`. It holds all pending data in the buffer until either:
- You remove the cork (set TCP_CORK to 0), or
- The buffer fills to MSS size.

This is ideal for `sendfile(2)` workloads where you want to prepend HTTP headers before a file body:

```c
// C example of HTTP/1.1 response with cork
#include <netinet/tcp.h>

void send_file_response(int sock, int file_fd, size_t file_size) {
    int one = 1, zero = 0;
    char headers[1024];

    // Cork the socket before writing headers
    setsockopt(sock, IPPROTO_TCP, TCP_CORK, &one, sizeof(one));

    // Write HTTP headers (small write — buffered by cork)
    int header_len = snprintf(headers, sizeof(headers),
        "HTTP/1.1 200 OK\r\n"
        "Content-Length: %zu\r\n"
        "Content-Type: application/octet-stream\r\n"
        "\r\n", file_size);
    write(sock, headers, header_len);

    // Sendfile writes the file body — combined with headers in one segment
    off_t offset = 0;
    sendfile(sock, file_fd, &offset, file_size);

    // Uncork — flush everything as optimally-packed segments
    setsockopt(sock, IPPROTO_TCP, TCP_CORK, &zero, sizeof(zero));
}
```

In Go, HTTP servers handle this automatically, but for raw TCP:

```go
package main

import (
    "net"
    "syscall"
)

func corkTCPConn(conn *net.TCPConn, cork bool) error {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return err
    }
    val := 0
    if cork {
        val = 1
    }
    return rawConn.Control(func(fd uintptr) {
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_CORK, val)
    })
}
```

## Section 5: SO_REUSEPORT — Multi-Process Accept Scaling

The classic bottleneck in high-connection-rate servers: a single goroutine/thread calling `accept()` on one socket cannot keep up with the connection arrival rate.

`SO_REUSEPORT` allows multiple sockets (in different processes or threads) to bind to the same address:port. The kernel distributes incoming connections across all sockets using consistent hashing, which:

1. Eliminates the accept lock contention.
2. Allows each CPU core to run its own accept loop.
3. Improves cache locality — each worker handles the full lifecycle of its connections.

```go
package main

import (
    "fmt"
    "net"
    "runtime"
    "syscall"
)

// createReusePortListener creates a TCP listener with SO_REUSEPORT
func createReusePortListener(address string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            var setSockoptErr error
            err := c.Control(func(fd uintptr) {
                setSockoptErr = syscall.SetsockoptInt(
                    int(fd),
                    syscall.SOL_SOCKET,
                    syscall.SO_REUSEPORT,
                    1,
                )
            })
            if err != nil {
                return err
            }
            return setSockoptErr
        },
    }
    return lc.Listen(nil, "tcp", address)
}

// StartMultiCoreServer spawns one accept loop per CPU core
func StartMultiCoreServer(address string, handler func(net.Conn)) error {
    numCPU := runtime.NumCPU()
    errCh := make(chan error, numCPU)

    for i := 0; i < numCPU; i++ {
        go func(workerID int) {
            ln, err := createReusePortListener(address)
            if err != nil {
                errCh <- fmt.Errorf("worker %d: %w", workerID, err)
                return
            }
            defer ln.Close()

            fmt.Printf("Worker %d listening on %s\n", workerID, address)
            for {
                conn, err := ln.Accept()
                if err != nil {
                    errCh <- fmt.Errorf("worker %d accept: %w", workerID, err)
                    return
                }
                go handler(conn)
            }
        }(i)
    }

    return <-errCh
}
```

### Benchmark: Single Accept vs SO_REUSEPORT

```bash
# Benchmark connection establishment rate
# Without SO_REUSEPORT (single accept goroutine):
wrk -c 10000 -t 8 -d 30s http://server:8080/
# Requests/sec: ~45,000

# With SO_REUSEPORT (8 accept goroutines):
# Requests/sec: ~180,000 (4x improvement on 8-core server)
```

## Section 6: BBR Congestion Control

BBR (Bottleneck Bandwidth and RTT) is a Google-developed TCP congestion control algorithm that models the network path rather than reacting to packet loss.

Traditional algorithms (CUBIC, Reno) interpret packet loss as a congestion signal and back off. BBR probes bandwidth and RTT continuously to maintain the optimal operating point.

BBR advantages:
- **Higher throughput on high-BDP links**: Doesn't waste capacity waiting for loss events.
- **Lower queuing latency**: Maintains smaller queues, reducing bufferbloat.
- **Better performance through lossy links** (WAN, wireless).
- **Handles shallow buffers**: Works well in cloud environments with variable bandwidth.

### Enabling BBR

```bash
# Check if BBR is available
modprobe tcp_bbr
lsmod | grep tcp_bbr

# Enable BBR
echo "net.core.default_qdisc = fq" >> /etc/sysctl.d/99-tcp-tuning.conf
echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.d/99-tcp-tuning.conf
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf

# Verify
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = bbr

# Check BBR version
cat /boot/config-$(uname -r) | grep BBR
# CONFIG_TCP_CONG_BBR=m  (BBRv1)
# CONFIG_TCP_CONG_BBR2=m (BBRv2, if available)
```

### Why fq (Fair Queueing) with BBR

BBR requires `fq` (Fair Queueing) as the packet scheduler to work optimally. `fq` dequeues packets from different flows in a round-robin fashion and enables pacing — BBR controls the transmission rate by requesting packet pacing from `fq`.

```bash
# Configure fq on the primary interface
tc qdisc add dev eth0 root fq

# Or configure per-queue
tc qdisc add dev eth0 root fq pacing

# Verify
tc qdisc show dev eth0
# qdisc fq 8001: root refcnt 2 limit 10000p flow_limit 100p buckets 1024 orphan_mask 1023 quantum 3028b initial_quantum 15140b low_rate_threshold 550Kbit refill_delay 40.0ms timer_slack 10.000us
```

## Section 7: Receive Side Scaling and CPU Affinity

For multi-Gbps traffic, interrupt coalescing and RSS (Receive Side Scaling) distribute work across CPU cores:

```bash
# Check current interrupt distribution
cat /proc/interrupts | grep eth0

# Enable RSS / multiqueue
ethtool -l eth0
# Current hardware settings:
# RX:     16
# TX:     16

# Set queue count to match CPU count
ethtool -L eth0 combined $(nproc)

# Configure interrupt coalescing (reduce interrupt rate, increase latency slightly)
ethtool -C eth0 adaptive-rx on adaptive-tx on
ethtool -C eth0 rx-usecs 50 tx-usecs 50
ethtool -C eth0 rx-frames 64 tx-frames 64

# Set RPS (Receive Packet Steering) for software-based distribution
# across all CPUs (bitmap: all bits set)
for file in /sys/class/net/eth0/queues/rx-*/rps_cpus; do
    echo "ffffffff" > "$file"
done

# Set RFS (Receive Flow Steering) — direct packets to CPU running the application
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
for file in /sys/class/net/eth0/costues/rx-*/rps_flow_cnt; do
    echo 2048 > "$file"
done
```

### IRQ Affinity

```bash
# Pin NIC interrupts to specific CPU cores to avoid NUMA cross-traffic
# Get interrupt numbers for eth0
IRQ_LIST=$(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':')

# Pin to physical cores (avoiding hyperthreads for IRQ handling)
CPU=0
for IRQ in $IRQ_LIST; do
    # Convert CPU number to affinity bitmask
    MASK=$(printf "%x" $((1 << $CPU)))
    echo $MASK > /proc/irq/$IRQ/smp_affinity
    CPU=$((CPU + 1))
    if [ $CPU -ge $(nproc --all) ]; then
        CPU=0
    fi
done
```

## Section 8: TCP Fast Open

TCP Fast Open (TFO) allows data to be sent in the SYN packet, eliminating one round trip for the initial request:

```bash
# Enable TFO (value 3 = both client and server)
# 1 = client only
# 2 = server only
# 3 = both
echo 3 > /proc/sys/net/ipv4/tcp_fastopen
sysctl net.ipv4.tcp_fastopen=3

# Persist in sysctl.conf
echo "net.ipv4.tcp_fastopen = 3" >> /etc/sysctl.d/99-tcp-tuning.conf
```

Go server with TFO:

```go
package main

import (
    "net"
    "syscall"
)

// EnableTFO enables TCP Fast Open on a listener
func EnableTFO(ln net.Listener) error {
    tcpLn, ok := ln.(*net.TCPListener)
    if !ok {
        return nil
    }
    rawConn, err := tcpLn.SyscallConn()
    if err != nil {
        return err
    }
    return rawConn.Control(func(fd uintptr) {
        // TCP_FASTOPEN = 23 on Linux
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, 23, 1024)
    })
}
```

## Section 9: Measuring with iperf3

iperf3 is the standard tool for measuring TCP throughput and identifying stack bottlenecks.

### Basic Throughput Test

```bash
# Server side
iperf3 -s -p 5201 --daemon

# Client side — single stream
iperf3 -c server-ip -p 5201 -t 30

# Multiple parallel streams (better for multi-core)
iperf3 -c server-ip -p 5201 -t 30 -P 8

# UDP test with target bandwidth
iperf3 -c server-ip -p 5201 -u -b 10G -t 30

# Reverse direction (server sends, client receives)
iperf3 -c server-ip -p 5201 -R -t 30
```

### Advanced iperf3 Testing

```bash
# Test with specific window size
iperf3 -c server-ip -w 64M -t 60

# Test buffer sizes
for buffer in 64K 128K 256K 512K 1M 4M 16M; do
    echo "Testing buffer size: $buffer"
    iperf3 -c server-ip -w $buffer -t 10 | grep -E "sender|receiver"
done

# Zero-copy test (uses sendfile)
iperf3 -c server-ip --zerocopy -t 30

# JSON output for scripting
iperf3 -c server-ip -t 30 -J | jq '.end.sum_received.bits_per_second / 1e9'

# Bidirectional test (simultaneous send and receive)
iperf3 -c server-ip --bidir -t 30
```

### Interpreting iperf3 Results

```
[ ID] Interval           Transfer     Bitrate         Retr  Cwnd
[  5]   0.00-10.00  sec  11.2 GBytes  9.60 Gbits/sec    0   6.00 MBytes
[  5]  10.00-20.00  sec  11.3 GBytes  9.69 Gbits/sec    0   6.12 MBytes

# Key metrics:
# Bitrate: achieved throughput
# Retr: TCP retransmissions (should be 0 on LAN)
# Cwnd: congestion window size (growing = BBR probing)
```

## Section 10: Measuring with netperf

netperf provides more granular measurements including transaction throughput and latency:

```bash
# Install netperf
apt-get install netperf  # or yum install netperf

# Start netserver on the target
netserver -p 12865

# TCP stream throughput
netperf -H server-ip -p 12865 -t TCP_STREAM -l 30

# TCP request/response (measures latency + throughput)
netperf -H server-ip -p 12865 -t TCP_RR -l 30

# TCP request/response with specific payload sizes
netperf -H server-ip -p 12865 -t TCP_RR -l 30 -- -r 1024,1024

# UDP round-trip
netperf -H server-ip -p 12865 -t UDP_RR -l 30

# Comprehensive latency histogram
netperf -H server-ip -p 12865 -t TCP_RR -l 30 -- -r 64,64 -P 0
```

### Automated Benchmark Script

```bash
#!/bin/bash
# tcp-benchmark.sh — comprehensive TCP performance test suite

SERVER_IP="${1:-localhost}"
DURATION=30
OUTPUT_DIR="/tmp/tcp-benchmark-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "TCP Performance Benchmark - $(date)"
echo "Target: $SERVER_IP"
echo "Duration: ${DURATION}s per test"
echo "Results: $OUTPUT_DIR"
echo "============================================"

# Test 1: Baseline throughput (single stream)
echo "Test 1: Single stream throughput..."
iperf3 -c "$SERVER_IP" -t "$DURATION" -J > "$OUTPUT_DIR/test1-single-stream.json"
THROUGHPUT=$(cat "$OUTPUT_DIR/test1-single-stream.json" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d['end']['sum_received']['bits_per_second']/1e9:.2f} Gbps\")")
echo "  Result: $THROUGHPUT"

# Test 2: Multi-stream throughput
echo "Test 2: Multi-stream throughput (8 parallel streams)..."
iperf3 -c "$SERVER_IP" -t "$DURATION" -P 8 -J > "$OUTPUT_DIR/test2-multi-stream.json"

# Test 3: Throughput vs window size
echo "Test 3: Window size sweep..."
for WS in 64K 256K 1M 4M 16M 64M; do
    RESULT=$(iperf3 -c "$SERVER_IP" -t 10 -w "$WS" -J 2>/dev/null | \
        python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d['end']['sum_received']['bits_per_second']/1e9:.2f}\")" 2>/dev/null)
    printf "  Window %-6s: ${RESULT} Gbps\n" "$WS"
done

# Test 4: Round-trip latency
echo "Test 4: TCP round-trip latency..."
if command -v netperf &>/dev/null; then
    netperf -H "$SERVER_IP" -t TCP_RR -l 10 -- -r 64,64 2>/dev/null | tail -3
fi

# Test 5: Connection establishment rate
echo "Test 5: Connection rate (TCP_CRR)..."
if command -v netperf &>/dev/null; then
    netperf -H "$SERVER_IP" -t TCP_CRR -l 10 2>/dev/null | tail -3
fi

# Collect kernel stats
echo ""
echo "Kernel TCP statistics:"
netstat -s | grep -E "segments|retransmit|failed|reset|established"

echo ""
echo "Current congestion control: $(sysctl -n net.ipv4.tcp_congestion_control)"
echo "Buffer settings:"
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem | awk '{print "  " $0}'

echo ""
echo "Benchmark complete. Results in: $OUTPUT_DIR"
```

## Section 11: Monitoring TCP Performance in Production

### ss — Socket Statistics

```bash
# All TCP connections with buffer stats
ss -tipm state established

# Connections sorted by send queue length
ss -tnp | sort -k3 -n -r | head -20

# Connections with retransmit info
ss -ti | grep -E "retrans|reordering|rtt"

# Per-process socket stats
ss -tnp src :8080 | head -20

# Connections in specific states
ss -s
# Total: 45623
# TCP:   12847 (estab 8234, closed 0, orphaned 123, timewait 4490)
```

### Kernel TCP Counters

```bash
# Full TCP statistics
cat /proc/net/netstat | head -2 | awk '{print $1}' | paste - -

# Key counters to monitor
nstat -az | grep -E "TcpRetransSegs|TcpAttemptFails|TcpEstabResets|TcpActiveOpens|TcpPassiveOpens"

# TCP window full events (buffer too small)
nstat -az TcpExtTCPRcvCoalesce TcpExtTCPOFOQueue TcpExtTCPWinProbe

# BBR-specific stats
nstat -az | grep -i bbr 2>/dev/null || echo "BBR stats in /proc/net/netstat"
```

### Prometheus Integration

```bash
# node_exporter exposes TCP stats automatically
# Key metrics to alert on:

# High retransmit rate
node_network_transmit_packets_total
node_sockstat_TCP_mem_bytes

# Custom recording rules
groups:
  - name: tcp_performance
    rules:
      - record: tcp_retransmit_rate
        expr: |
          rate(node_netstat_Tcp_RetransSegs[5m]) /
          rate(node_netstat_Tcp_OutSegs[5m])

      - alert: HighTCPRetransmitRate
        expr: tcp_retransmit_rate > 0.01
        for: 5m
        annotations:
          summary: "TCP retransmit rate > 1% on {{ $labels.instance }}"
```

## Section 12: Application-Level Socket Tuning in Go

```go
package main

import (
    "net"
    "syscall"
    "time"
)

// ProductionDialer creates a TCP dialer with optimized settings
func NewProductionDialer() *net.Dialer {
    return &net.Dialer{
        Timeout:   30 * time.Second,
        KeepAlive: 30 * time.Second,
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                // Enable TCP_NODELAY for request/response protocols
                syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
                    syscall.TCP_NODELAY, 1)

                // Set SO_RCVBUF and SO_SNDBUF
                // Note: kernel autotuning works better, only set if needed
                // syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                //     syscall.SO_RCVBUF, 4*1024*1024)
                // syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                //     syscall.SO_SNDBUF, 4*1024*1024)

                // Enable TCP keepalive
                syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                    syscall.SO_KEEPALIVE, 1)

                // Keepalive idle time (seconds before first probe)
                syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
                    syscall.TCP_KEEPIDLE, 60)

                // Keepalive interval between probes
                syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
                    syscall.TCP_KEEPINTVL, 10)

                // Number of probes before declaring connection dead
                syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
                    syscall.TCP_KEEPCNT, 5)
            })
        },
    }
}

// ProductionListenConfig creates a listener with SO_REUSEPORT and optimized settings
func NewProductionListenConfig() net.ListenConfig {
    return net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                // SO_REUSEPORT for multi-goroutine accept
                syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                    syscall.SO_REUSEPORT, 1)

                // SO_REUSEADDR to allow fast restart
                syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                    syscall.SO_REUSEADDR, 1)

                // Defer accept — don't wake accept() until data arrives
                // Reduces wakeups for protocols with an initial client message
                syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
                    syscall.TCP_DEFER_ACCEPT, 1)
            })
        },
        KeepAlive: 30 * time.Second,
    }
}
```

## Summary

TCP performance tuning is layered: kernel buffers set the ceiling, socket options control per-connection behavior, congestion control determines bandwidth utilization, and application socket configuration glues it together.

**The five highest-impact changes for most production services:**

1. **Increase TCP buffer sizes** to match the BDP of your network (often 4-64 MB for data center workloads).
2. **Enable BBR** with `fq` scheduling — single most impactful change for long-distance and cloud traffic.
3. **Set TCP_NODELAY** on all request/response protocol sockets to eliminate Nagle delay.
4. **Use SO_REUSEPORT** with multiple accept goroutines/processes to eliminate the accept bottleneck at scale.
5. **Increase the connection backlog** (`net.core.somaxconn` and `net.ipv4.tcp_max_syn_backlog`) to handle traffic spikes without dropping connections.

Measure before and after with `iperf3 -P 8` to confirm improvements. Monitor `TcpRetransSegs` and socket buffer overflows (`ss -ti | grep rcvbuf`) continuously to catch regressions.
