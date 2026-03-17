---
title: "Linux TCP/IP Stack Tuning: CUBIC vs BBR, Receive Buffer Autotuning, TCP_NODELAY, and SO_REUSEPORT"
date: 2031-10-28T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "Networking", "Performance", "BBR", "CUBIC", "Kernel Tuning", "SO_REUSEPORT"]
categories:
- Linux
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "In-depth guide to Linux TCP/IP stack performance tuning: comparing CUBIC and BBR congestion control, configuring receive buffer autotuning, understanding TCP_NODELAY vs Nagle's algorithm, and leveraging SO_REUSEPORT for high-throughput servers."
more_link: "yes"
url: "/linux-tcp-ip-stack-tuning-cubic-bbr-receive-buffer-tcp-nodelay-so-reuseport/"
---

Network performance tuning in Linux requires understanding the interaction between congestion control algorithms, kernel buffer management, and socket options. A poorly tuned TCP stack can leave 50-70% of available bandwidth on the table even with modern hardware. This guide covers practical, production-tested optimizations from congestion control selection through application-level socket configuration.

<!--more-->

# Linux TCP/IP Stack Tuning: Comprehensive Production Guide

## Understanding the TCP Tuning Landscape

Before applying any tuning, establish a baseline. The goal is to identify which layer of the stack is the bottleneck:

```bash
# Measure current throughput
iperf3 -s &
iperf3 -c server-ip -t 60 -P 4 -i 5

# Check current TCP statistics
ss -s
cat /proc/net/netstat | head -3

# View current kernel parameters
sysctl -a | grep -E "net\.(core|ipv4\.tcp)" | sort
```

## Congestion Control: CUBIC vs BBR

### CUBIC (Default)

CUBIC is the default Linux congestion control algorithm since kernel 2.6.19. It uses a cubic function to determine window growth:

- **Window growth**: Cubic polynomial based on time since last congestion event
- **Fairness**: Good fairness between competing CUBIC flows
- **High-BDP**: Struggles in high bandwidth-delay product networks (satellite, intercontinental)
- **Loss-based**: Reduces window on packet loss, creating sawtooth patterns

```bash
# Check current congestion control
cat /proc/sys/net/ipv4/tcp_congestion_control

# List available algorithms
cat /proc/sys/net/ipv4/tcp_available_congestion_control
sysctl net.ipv4.tcp_available_congestion_control
```

### BBR (Bottleneck Bandwidth and Round-trip propagation time)

BBR, developed by Google, takes a fundamentally different approach:

- **Model-based**: Builds an explicit model of the network path (bandwidth and RTT)
- **Not loss-based**: Does not reduce window on loss (crucial for lossy networks)
- **Probing phases**: Alternates between bandwidth probing and RTT probing
- **Full pipe utilization**: Achieves near-maximum throughput on high-BDP paths

```bash
# Load BBR module
modprobe tcp_bbr

# Verify it loaded
lsmod | grep bbr

# Enable BBR
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Verify
sysctl net.ipv4.tcp_congestion_control
```

Make it persistent:

```bash
cat >> /etc/sysctl.d/99-tcp-bbr.conf << 'EOF'
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
EOF

sysctl -p /etc/sysctl.d/99-tcp-bbr.conf
```

The `fq` (Fair Queue) qdisc is required for BBR to work correctly — it provides pacing.

### When to Use BBR vs CUBIC

| Scenario | Recommended |
|----------|-------------|
| Intra-datacenter (< 1ms RTT) | CUBIC or BBR (marginal difference) |
| Cross-datacenter (1-10ms RTT) | BBR recommended |
| WAN/Internet links (> 10ms RTT) | BBR strongly recommended |
| Lossy networks (wireless backhaul) | BBR strongly recommended |
| High BDP (satellite, > 100ms RTT) | BBR or HTCP |
| Many competing flows | CUBIC (better fairness) |

### BBR Performance Measurement

```bash
#!/bin/bash
# compare-congestion-control.sh

SERVER_IP="10.0.0.100"
DURATION=30
PARALLEL=4

echo "=== Benchmarking CUBIC ==="
sysctl -w net.ipv4.tcp_congestion_control=cubic
sleep 1
iperf3 -c "${SERVER_IP}" -t "${DURATION}" -P "${PARALLEL}" --json > /tmp/cubic-results.json
python3 -c "
import json
with open('/tmp/cubic-results.json') as f:
    d = json.load(f)
bps = d['end']['sum_received']['bits_per_second']
print(f'CUBIC throughput: {bps/1e9:.2f} Gbps')
"

echo "=== Benchmarking BBR ==="
sysctl -w net.ipv4.tcp_congestion_control=bbr
sleep 1
iperf3 -c "${SERVER_IP}" -t "${DURATION}" -P "${PARALLEL}" --json > /tmp/bbr-results.json
python3 -c "
import json
with open('/tmp/bbr-results.json') as f:
    d = json.load(f)
bps = d['end']['sum_received']['bits_per_second']
print(f'BBR throughput: {bps/1e9:.2f} Gbps')
"
```

### BBRv2 (Experimental)

BBRv2 improves on BBRv1 with better coexistence with CUBIC flows:

```bash
# Check if BBRv2 is available (kernel 5.13+)
grep -r bbr2 /lib/modules/$(uname -r)/

# Enable if available
sysctl -w net.ipv4.tcp_congestion_control=bbr2
```

## Receive Buffer Autotuning

Linux implements automatic receive buffer sizing to match the bandwidth-delay product of the connection. Understanding and tuning this mechanism is critical for throughput.

### The BDP Formula

Optimal buffer size = Bandwidth (bytes/sec) x RTT (seconds)

For a 10 Gbps link with 1ms RTT:
- BDP = 10,000,000,000 / 8 x 0.001 = 1,250,000 bytes = ~1.2 MB

The receive buffer must be at least 2x BDP to keep the pipe full.

### Current Buffer Settings

```bash
# View current socket buffer settings
sysctl net.core.rmem_default     # Default receive buffer size
sysctl net.core.rmem_max         # Maximum receive buffer size
sysctl net.ipv4.tcp_rmem         # Min, default, max for TCP

sysctl net.core.wmem_default     # Default send buffer size
sysctl net.core.wmem_max         # Maximum send buffer size
sysctl net.ipv4.tcp_wmem         # Min, default, max for TCP

# TCP autotuning status
sysctl net.ipv4.tcp_moderate_rcvbuf
```

### Autotuning Configuration

```bash
# /etc/sysctl.d/99-tcp-buffers.conf

# Core socket buffers
# Minimum: 4KB, Default: 128KB, Maximum: 16MB
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 131072
net.core.wmem_default = 131072

# TCP-specific buffers (min, default, max in bytes)
# For 10 Gbps with 1ms RTT, max should be ~4MB minimum
net.ipv4.tcp_rmem = 4096 131072 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Enable TCP autotuning (should be on by default)
net.ipv4.tcp_moderate_rcvbuf = 1

# Disable per-connection memory limits for high-throughput servers
net.ipv4.tcp_mem = 786432 1048576 26777216

# Backlog for accept queue (per-socket)
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# Increase netdev queue length
net.core.netdev_max_backlog = 65536
```

Apply:

```bash
sysctl -p /etc/sysctl.d/99-tcp-buffers.conf
```

### Per-Socket Buffer Override

Applications can override system defaults for specific connections:

```go
// Go example: setting large receive buffers
conn, err := net.Dial("tcp", "server:8080")
if err != nil {
    log.Fatal(err)
}

rawConn, err := conn.(*net.TCPConn).SyscallConn()
if err != nil {
    log.Fatal(err)
}

rawConn.Control(func(fd uintptr) {
    // Set 4MB receive buffer
    syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4*1024*1024)
    // Set 4MB send buffer
    syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, 4*1024*1024)
})
```

### Monitoring Buffer Utilization

```bash
# Check actual buffer usage per connection
ss -tmn | head -20
# Output columns: State, Recv-Q, Send-Q, Local, Peer, Timer
# Recv-Q: bytes in receive buffer not yet read by application
# Send-Q: bytes sent but not yet acknowledged

# Monitor buffer pressure
watch -n 1 'cat /proc/net/sockstat'
# Expected output:
# sockets: used 1234
# TCP: inuse 890 orphan 5 tw 45 alloc 920 mem 234
# UDP: inuse 12 mem 1

# Detailed per-socket buffer state
ss -tmn 'dst 10.0.0.100'
```

### Diagnosing Buffer Bottlenecks

```bash
#!/bin/bash
# diagnose-tcp-buffers.sh

echo "=== TCP Buffer Statistics ==="
echo "Current sysctl settings:"
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max

echo ""
echo "Socket memory pressure:"
cat /proc/net/sockstat

echo ""
echo "Connections with full receive queues (>0 Recv-Q):"
ss -tmn | awk 'NR>1 && $2>0 {print}'

echo ""
echo "TCP retransmit/error counters:"
cat /proc/net/netstat | awk 'NR==1{split($0,h," ")} NR==2{for(i=1;i<=NF;i++) if($i>0) print h[i]"="$i}' | \
  grep -E "TCPRcvCoalesce|TCPOFOQueue|TCPRcvQDrop|TCPBacklogCoalesce"

echo ""
echo "nstat TCP counters:"
nstat -az | grep -E "TcpExt(TCPRcvQ|Prune|OFO)"
```

## TCP_NODELAY and Nagle's Algorithm

### What Nagle's Algorithm Does

Nagle's algorithm (RFC 896) reduces the number of small packets by buffering data until:
- The buffer contains a full-size segment (MSS), OR
- All previously sent data has been acknowledged

This is excellent for interactive applications with small payloads on slow links, but causes latency problems for:
- Bulk streaming applications sending many small writes
- Request/response protocols (HTTP, gRPC, databases)
- Real-time applications where latency matters more than efficiency

### When to Use TCP_NODELAY

```bash
# Check if TCP_NODELAY is set on existing connections (requires ss with Linux 4.14+)
ss -tmno dst 10.0.0.100 | grep nodelay
```

```go
// Go: Enable TCP_NODELAY for a client connection
conn, err := net.DialTCP("tcp", nil, &net.TCPAddr{IP: net.ParseIP("10.0.0.100"), Port: 8080})
if err != nil {
    log.Fatal(err)
}

if err := conn.SetNoDelay(true); err != nil {
    log.Printf("failed to set TCP_NODELAY: %v", err)
}

// Go: Enable TCP_NODELAY on server-accepted connections
listener, _ := net.Listen("tcp", ":8080")
for {
    conn, err := listener.Accept()
    if err != nil {
        continue
    }
    if tcpConn, ok := conn.(*net.TCPConn); ok {
        tcpConn.SetNoDelay(true)
    }
    go handleConn(conn)
}
```

```c
// C: Enable TCP_NODELAY
int flag = 1;
setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
```

### TCP_NODELAY vs TCP_CORK

TCP_CORK (Linux-specific) is the opposite: hold data until the buffer is full or `TCP_CORK` is removed. Use this when you have fine-grained control over when to flush:

```go
// Go: use TCP_CORK for controlled flushing
rawConn, _ := conn.(*net.TCPConn).SyscallConn()

// Cork the connection (hold data)
rawConn.Control(func(fd uintptr) {
    cork := 1
    syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_CORK, cork)
})

// Write multiple small pieces
conn.Write(httpHeaders)
conn.Write(httpBody)

// Uncork to flush everything in one segment
rawConn.Control(func(fd uintptr) {
    cork := 0
    syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_CORK, cork)
})
```

### The 40ms Nagle + Delayed ACK Interaction

The notorious 40ms latency bug occurs when:
1. Sender uses Nagle (waiting for ACK before sending more)
2. Receiver uses Delayed ACK (waiting 40ms to batch ACKs)

This creates a deadlock: sender waits for ACK, receiver waits to batch ACK.

```bash
# Measure if you're hitting delayed ACK
strace -e trace=sendto,recvfrom -T -tt -p $(pgrep myapp) 2>&1 | \
  awk '/sendto/{t=$1} /recvfrom/{if(t) print $1-t, "ms delay"}'

# Disable delayed ACK globally (not recommended - use per-socket)
sysctl -w net.ipv4.tcp_delack_min=0
```

Fix in application code:

```go
// Fix: Use TCP_NODELAY on both client AND server
// Client:
conn.SetNoDelay(true)

// Or: fix delayed ACK on the server side
rawConn.Control(func(fd uintptr) {
    // TCP_QUICKACK disables delayed ACK for this socket
    syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_QUICKACK, 1)
})
```

## SO_REUSEPORT for High-Throughput Servers

`SO_REUSEPORT` (Linux 3.9+) allows multiple sockets to bind to the same address:port. The kernel load-balances incoming connections using a hash of the 4-tuple.

### Benefits Over Single-Socket Accept

Without `SO_REUSEPORT`:
- Single accept queue, protected by one lock
- All worker threads contend for the lock
- Accept rate limited by single-core lock performance
- Maximum ~1-2M connections/second on modern hardware

With `SO_REUSEPORT`:
- Multiple sockets, each with its own accept queue
- Workers own their queue, no cross-core contention
- Linear scaling with CPU cores
- Maximum 5-10M+ connections/second

### Implementing SO_REUSEPORT in Go

```go
// internal/listener/reuseport.go
package listener

import (
    "fmt"
    "net"
    "syscall"

    "golang.org/x/sys/unix"
)

// NewReusePortListener creates a TCP listener with SO_REUSEPORT enabled
func NewReusePortListener(addr string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            var setErr error
            err := c.Control(func(fd uintptr) {
                setErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
            })
            if err != nil {
                return err
            }
            return setErr
        },
    }
    return lc.Listen(ctx, "tcp", addr)
}

// StartWorkers starts n workers each with their own SO_REUSEPORT listener
func StartWorkers(addr string, n int, handler func(net.Conn)) error {
    var wg sync.WaitGroup

    for i := 0; i < n; i++ {
        ln, err := NewReusePortListener(addr)
        if err != nil {
            return fmt.Errorf("worker %d failed to listen: %w", i, err)
        }

        wg.Add(1)
        workerID := i
        go func(ln net.Listener) {
            defer wg.Done()
            defer ln.Close()

            for {
                conn, err := ln.Accept()
                if err != nil {
                    if isTemporary(err) {
                        continue
                    }
                    return
                }
                go handler(conn)
            }
        }(ln)
    }

    wg.Wait()
    return nil
}

func isTemporary(err error) bool {
    netErr, ok := err.(net.Error)
    return ok && netErr.Temporary()
}
```

### HTTP Server with SO_REUSEPORT

```go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "os"
    "runtime"
    "syscall"

    "golang.org/x/sys/unix"
)

func main() {
    numWorkers := runtime.NumCPU()
    addr := ":8080"

    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Hello from worker on goroutine %d", runtime.NumGoroutine())
    })

    servers := make([]*http.Server, numWorkers)
    listeners := make([]net.Listener, numWorkers)

    for i := 0; i < numWorkers; i++ {
        lc := net.ListenConfig{
            Control: func(network, address string, c syscall.RawConn) error {
                return c.Control(func(fd uintptr) {
                    unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
                })
            },
        }

        ln, err := lc.Listen(context.Background(), "tcp", addr)
        if err != nil {
            fmt.Fprintf(os.Stderr, "worker %d listen error: %v\n", i, err)
            os.Exit(1)
        }
        listeners[i] = ln

        srv := &http.Server{
            Handler: mux,
        }
        servers[i] = srv

        go func(s *http.Server, l net.Listener) {
            if err := s.Serve(l); err != http.ErrServerClosed {
                fmt.Fprintf(os.Stderr, "server error: %v\n", err)
            }
        }(srv, ln)
    }

    fmt.Printf("Started %d workers on %s with SO_REUSEPORT\n", numWorkers, addr)

    // Wait for signal
    sigCh := make(chan os.Signal, 1)
    <-sigCh
}
```

### Benchmarking SO_REUSEPORT Impact

```bash
# Without SO_REUSEPORT
wrk -t4 -c1000 -d30s http://server:8080/

# With SO_REUSEPORT (same binary, different config)
wrk -t4 -c1000 -d30s http://server-reuseport:8080/

# Compare accept queue pressure
watch -n 0.5 'ss -tlnp | grep :8080'
# Without SO_REUSEPORT: single queue fills up under load
# With SO_REUSEPORT: queue distributed across sockets

# Monitor accept queue overflows
netstat -s | grep -i "listen"
# "X connections reset due to unexpected data" indicates overflow
```

## TCP Keep-Alive Configuration

```bash
# /etc/sysctl.d/99-tcp-keepalive.conf

# Time before sending first keepalive probe (seconds)
net.ipv4.tcp_keepalive_time = 60

# Interval between keepalive probes (seconds)
net.ipv4.tcp_keepalive_intvl = 10

# Number of probes before declaring dead
net.ipv4.tcp_keepalive_probes = 6
```

Application-level keep-alive:

```go
// Go: configure TCP keep-alive per connection
conn, _ := net.DialTCP("tcp", nil, serverAddr)
conn.SetKeepAlive(true)
conn.SetKeepAlivePeriod(30 * time.Second)
```

## TIME_WAIT and Connection Reuse

High-throughput servers generate many connections in `TIME_WAIT` state. This can exhaust ephemeral ports:

```bash
# Check TIME_WAIT count
ss -s | grep TIME-WAIT

# View port range
cat /proc/sys/net/ipv4/ip_local_port_range
```

```bash
# /etc/sysctl.d/99-tcp-timewait.conf

# Expand ephemeral port range
net.ipv4.ip_local_port_range = 10000 65535

# Reuse TIME_WAIT sockets for new outbound connections
net.ipv4.tcp_tw_reuse = 1

# Reduce TIME_WAIT duration (default 60s, minimum 30s)
# WARNING: Only reduce if you control both ends of connections
net.ipv4.tcp_fin_timeout = 30

# Maximum TIME_WAIT buckets (increase if needed)
net.ipv4.tcp_max_tw_buckets = 1440000
```

## SYN Flood Protection

```bash
# /etc/sysctl.d/99-tcp-syn.conf

# Enable SYN cookies for SYN flood protection
net.ipv4.tcp_syncookies = 1

# Maximum number of SYN backlog entries
net.ipv4.tcp_max_syn_backlog = 65535

# Number of retries for SYN-SENT (outbound)
net.ipv4.tcp_syn_retries = 4

# Number of retries for SYN-RECV (server side)
net.ipv4.tcp_synack_retries = 2
```

## Complete Production Tuning Profile

Consolidating all tunings into a production profile:

```bash
# /etc/sysctl.d/99-tcp-production.conf
# Production TCP tuning for high-throughput Kubernetes nodes
# Tuned for 10 Gbps with 1-5ms intra-cluster RTT

# Congestion control
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq

# Socket buffers (autotuned between min and max)
net.core.rmem_max = 134217728        # 128MB max
net.core.wmem_max = 134217728        # 128MB max
net.core.rmem_default = 262144       # 256KB default
net.core.wmem_default = 262144       # 256KB default
net.ipv4.tcp_rmem = 4096 262144 134217728
net.ipv4.tcp_wmem = 4096 262144 134217728
net.ipv4.tcp_moderate_rcvbuf = 1

# TCP memory
net.ipv4.tcp_mem = 786432 1048576 26777216

# Connection handling
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65536

# TIME_WAIT management
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_max_tw_buckets = 1440000
net.ipv4.ip_local_port_range = 10000 65535

# Keep-alive
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_syn_retries = 4
net.ipv4.tcp_synack_retries = 2

# Misc performance
net.ipv4.tcp_slow_start_after_idle = 0  # Don't slow start after idle
net.ipv4.tcp_no_metrics_save = 0         # Save connection metrics
net.ipv4.tcp_mtu_probing = 1             # Enable PMTU discovery
net.ipv4.tcp_sack = 1                    # Selective ACK
net.ipv4.tcp_fack = 0                    # Forward ACK (deprecated in newer kernels)
net.ipv4.tcp_timestamps = 1              # Required for PAWS and RTT measurement
```

## Monitoring TCP Stack Health

### Key Metrics to Track

```bash
#!/bin/bash
# monitor-tcp-stack.sh

echo "=== TCP Connection States ==="
ss -s

echo ""
echo "=== Retransmit and Error Counters ==="
nstat -az | grep -E "^Tcp" | \
  awk '$2 > 0 {printf "%-40s %d\n", $1, $2}' | sort -k2 -rn | head -20

echo ""
echo "=== Buffer Pressure ==="
cat /proc/net/sockstat

echo ""
echo "=== High Recv-Q Connections (backpressure) ==="
ss -tmn | awk 'NR>1 && $2 > 10000 {print $0}' | head -20

echo ""
echo "=== Connection Rate (syn) ==="
nstat TcpPassiveOpens TcpActiveOpens 2>/dev/null

echo ""
echo "=== Drop Counters ==="
nstat -az | grep -iE "(drop|lost|abort|reset|fail)" | awk '$2 > 0' | sort -k2 -rn
```

### Prometheus Node Exporter TCP Metrics

```yaml
# prometheus-rules-tcp.yaml
groups:
  - name: tcp_stack
    interval: 30s
    rules:
      - alert: HighTCPRetransmitRate
        expr: |
          rate(node_netstat_Tcp_RetransSegs[5m]) /
          rate(node_netstat_Tcp_OutSegs[5m]) > 0.01
        for: 5m
        annotations:
          summary: "TCP retransmit rate > 1% on {{ $labels.instance }}"
          description: "Retransmit rate: {{ $value | humanizePercentage }}"

      - alert: TCPSynDrops
        expr: rate(node_netstat_TcpExt_TCPReqQFullDrop[5m]) > 10
        for: 2m
        annotations:
          summary: "SYN queue overflow on {{ $labels.instance }}"

      - alert: HighTimeWaitConnections
        expr: node_sockstat_TCP_tw > 50000
        for: 10m
        annotations:
          summary: "Large TIME_WAIT count: {{ $value }}"

      - alert: TCPMemoryPressure
        expr: node_sockstat_TCP_mem_bytes / node_memory_MemTotal_bytes > 0.1
        for: 5m
        annotations:
          summary: "TCP memory > 10% of total RAM"
```

### Grafana Dashboard Query Examples

```promql
# TCP connections by state
sum by (state) (node_sockstat_sockets_used)

# Retransmit rate per node
rate(node_netstat_Tcp_RetransSegs[5m])

# Accept queue depth
node_sockstat_TCP_mem

# BBR bandwidth probe
rate(node_netstat_TcpExt_TCPHystartDelayCwnd[5m])

# TIME_WAIT connections
node_sockstat_TCP_tw
```

## Network Card Tuning to Match TCP Stack

The TCP stack tuning is only effective if the NIC can keep up:

```bash
# Check NIC ring buffer size
ethtool -g eth0

# Increase ring buffers for high-throughput
ethtool -G eth0 rx 4096 tx 4096

# Enable NIC offload features
ethtool -k eth0              # List offload features
ethtool -K eth0 gso on       # Generic Segmentation Offload
ethtool -K eth0 gro on       # Generic Receive Offload
ethtool -K eth0 tso on       # TCP Segmentation Offload
ethtool -K eth0 rx-checksumming on
ethtool -K eth0 tx-checksumming on

# CPU affinity for IRQs (distribute across cores)
# Find NIC IRQs
grep eth0 /proc/interrupts | awk '{print $1}' | tr -d ':'

# Set per-queue CPU affinity
for irq in $(grep eth0 /proc/interrupts | awk '{print $1}' | tr -d ':'); do
    cpu=$(( $(cat /sys/class/net/eth0/queues/rx-0/rps_cpus | wc -c) ))
    echo 1 > /proc/irq/${irq}/smp_affinity
done

# Enable Receive Packet Steering (software RSS)
# Distribute across all CPUs
for queue in /sys/class/net/eth0/queues/rx-*; do
    echo "ff" > ${queue}/rps_cpus
done

# Increase XPS (Transmit Packet Steering)
for queue in /sys/class/net/eth0/queues/tx-*; do
    echo "ff" > ${queue}/xps_cpus
done
```

## Persistent Configuration via systemd-networkd

```ini
# /etc/systemd/network/10-eth0.network
[Match]
Name=eth0

[Link]
MTUBytes=9000

[Network]
DHCP=yes

[DHCP]
UseMTU=true
RouteMetric=100
```

For kernel parameters that must persist across reboots with priority:

```bash
# /etc/sysctl.d/README
# Files in /etc/sysctl.d/ are applied in lexicographic order
# Use 99- prefix to ensure our settings override distribution defaults

# Verify which file sets a particular value
sysctl -a --all-sources 2>/dev/null | grep "tcp_congestion"
```

## Conclusion

Linux TCP/IP tuning is layered — each parameter interacts with others. The most impactful changes for most workloads are:

1. **Switch to BBR** for any traffic traversing more than 5ms RTT
2. **Increase socket buffers** to 2x the BDP of your longest paths
3. **Enable TCP_NODELAY** on any request/response protocol
4. **Deploy SO_REUSEPORT** for any server handling > 50k connections/second
5. **Tune TIME_WAIT** parameters to prevent port exhaustion under high connection rates

Always measure before and after each change in isolation — TCP tuning parameters interact in complex ways, and a change that helps one workload may hurt another.
