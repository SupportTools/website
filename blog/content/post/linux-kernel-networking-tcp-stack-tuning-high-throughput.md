---
title: "Linux Kernel Networking: TCP Stack Tuning for High Throughput"
date: 2029-05-01T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "Networking", "Performance", "Kernel", "BBR", "Tuning"]
categories:
- Linux
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux TCP stack tuning for high throughput: TCP window scaling, BBR congestion control, SO_REUSEPORT, TCP_FASTOPEN, receive buffer auto-tuning, netstat/ss analysis, and kernel 6.x improvements."
more_link: "yes"
url: "/linux-kernel-networking-tcp-stack-tuning-high-throughput/"
---

The Linux TCP stack is a marvel of engineering that has been tuned for everything from embedded devices to 400 Gbps cloud servers. Most production systems run with default kernel parameters that are conservative and suitable for general workloads — but not for high-throughput data transfer, low-latency APIs, or Kubernetes node networking. This guide covers the full spectrum of TCP tuning: from window scaling arithmetic and BBR congestion control through socket options, buffer auto-tuning, and kernel 6.x improvements.

<!--more-->

# Linux Kernel Networking: TCP Stack Tuning for High Throughput

## Understanding the TCP Throughput Formula

Before tuning, understand the theoretical maximum throughput:

```
Throughput = Window Size / RTT
```

On a 10ms RTT link with a 65,535-byte (64 KB) default window:

```
65,535 bytes / 0.010 s = 6.5 MB/s = 52 Mbps
```

On a 100 Gbps link, you need a window of:

```
100 Gbps * 0.010 s = 1 Gbps * 0.010 s = 10,000,000 bytes = ~9.5 MB minimum window
```

Default Linux settings cap throughput far below what modern hardware can deliver.

## TCP Window Scaling (RFC 7323)

Window scaling extends the 16-bit TCP window field to an effective maximum of 1 GB (the scale factor is a 4-bit shift, allowing up to 2^30 bytes = 1 GB).

### Verify Window Scaling is Enabled

```bash
sysctl net.ipv4.tcp_window_scaling
# net.ipv4.tcp_window_scaling = 1  (should be 1)
```

### Socket Buffer Sizes

The socket buffer (not the TCP window) is the primary control. The kernel advertises a receive window derived from the socket receive buffer.

```bash
# Current defaults
sysctl net.ipv4.tcp_rmem
# net.ipv4.tcp_rmem = 4096  131072  6291456
# min     default   max

sysctl net.ipv4.tcp_wmem
# net.ipv4.tcp_wmem = 4096  16384   4194304
```

For high-throughput bulk transfer (backups, Kafka, object storage):

```bash
cat /etc/sysctl.d/99-tcp-tuning.conf
```

```ini
# TCP socket buffers
# Formula: 2 * BDP = 2 * bandwidth * RTT
# For 10Gbps * 10ms RTT: 2 * (10e9/8) * 0.010 = 25MB
net.ipv4.tcp_rmem = 4096 87380 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432

# Global maximum socket buffer
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.core.rmem_default = 262144
net.core.wmem_default = 262144

# Increase the number of in-flight TCP connections allowed
net.ipv4.tcp_max_syn_backlog = 65536
net.core.somaxconn = 65536

# Increase connection backlog
net.core.netdev_max_backlog = 65536
```

Apply:

```bash
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

### Receive Buffer Auto-Tuning

Linux auto-tunes receive buffer sizes per-connection when `tcp_moderate_rcvbuf` is enabled (default: on):

```bash
sysctl net.ipv4.tcp_moderate_rcvbuf
# net.ipv4.tcp_moderate_rcvbuf = 1
```

The kernel doubles the rcvbuf when it detects the application is consuming data quickly, up to `tcp_rmem[2]`. The max setting is the effective ceiling.

## BBR Congestion Control

BBR (Bottleneck Bandwidth and Round-trip time) is Google's congestion control algorithm, available since Linux 4.9. It significantly outperforms CUBIC in high-latency, high-bandwidth-delay product (BDP) networks and in networks with shallow buffers.

### Enable BBR

```bash
# Check available algorithms
sysctl net.ipv4.tcp_available_congestion_control
# net.ipv4.tcp_available_congestion_control = reno cubic bbr

# Set BBR as default
echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.d/99-tcp-tuning.conf

# Use FQ (Fair Queue) packet scheduler — required for BBR's pacing
echo "net.core.default_qdisc = fq" >> /etc/sysctl.d/99-tcp-tuning.conf

sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

### BBR vs CUBIC

| Scenario | CUBIC | BBR |
|---|---|---|
| High BDP (intercontinental) | Struggles, underutilizes bandwidth | Excellent, quickly reaches full rate |
| Shallow buffers | Overdrives buffers, high latency | Paces based on measured BDP |
| Congested shared network | Competitive | Slightly less aggressive |
| Loopback / LAN | Comparable | Comparable |

### Verify BBR is Active

```bash
# Check a live connection
ss -tio | grep -i bbr

# For a new connection
python3 -c "
import socket
s = socket.socket()
s.connect(('8.8.8.8', 443))
import struct
TCP_CONGESTION = 13
print(s.getsockopt(socket.IPPROTO_TCP, TCP_CONGESTION, 16))
"
```

### BBR v2 and BBR v3

BBR v3 was merged into the kernel in Linux 6.6+ and addresses several BBR v1 fairness issues:

```bash
# Linux 6.6+
modprobe tcp_bbr2 2>/dev/null || true
sysctl net.ipv4.tcp_available_congestion_control
```

## SO_REUSEPORT: Eliminating Accept Lock Contention

Traditional socket programming uses a single listening socket shared across threads, creating an accept queue bottleneck. `SO_REUSEPORT` allows multiple sockets on the same port, with the kernel distributing incoming connections across them.

### Classic Architecture (bottleneck)

```
[NIC] --> [Kernel] --> [Single Accept Queue] --> [Thread 1]
                                             \-> [Thread 2]
                                             \-> [Thread 3]
```

### SO_REUSEPORT Architecture

```
[NIC] --> [Kernel RSS/RPS] --> [Queue 1] --> [Thread 1 private socket]
                           --> [Queue 2] --> [Thread 2 private socket]
                           --> [Queue 3] --> [Thread 3 private socket]
```

### Using SO_REUSEPORT in Go

```go
package main

import (
    "net"
    "syscall"
    "golang.org/x/sys/unix"
)

func listenReusePort(network, address string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            var setSockOptErr error
            err := c.Control(func(fd uintptr) {
                setSockOptErr = syscall.SetsockoptInt(
                    int(fd),
                    syscall.SOL_SOCKET,
                    unix.SO_REUSEPORT,
                    1,
                )
            })
            if err != nil {
                return err
            }
            return setSockOptErr
        },
    }
    return lc.Listen(context.Background(), network, address)
}

// Start one listener per CPU core
func main() {
    numCPU := runtime.NumCPU()
    for i := 0; i < numCPU; i++ {
        go func() {
            ln, err := listenReusePort("tcp", ":8080")
            if err != nil {
                log.Fatal(err)
            }
            http.Serve(ln, handler)
        }()
    }
    select {}
}
```

### NGINX with SO_REUSEPORT

```nginx
events {
    use epoll;
    worker_connections 65536;
    multi_accept on;
}

http {
    server {
        listen 80 reuseport;
        listen 443 ssl reuseport;
        # ...
    }
}
```

## TCP_FASTOPEN: Eliminating the 3-Way Handshake for Repeat Connections

TCP Fast Open (TFO) allows data to be sent in the SYN packet for repeat connections, eliminating one RTT for clients that have previously connected.

### How TFO Works

**First connection (no TFO):**
```
Client --> SYN -----------------------------------------> Server
Client <-- SYN-ACK + TFO cookie <----------------------- Server
Client --> ACK + HTTP Request ---> Server
Client <-- HTTP Response <--------- Server
```

**Subsequent connections (with TFO):**
```
Client --> SYN + TFO cookie + HTTP Request -> Server
Client <-- SYN-ACK + HTTP Response <-------- Server
Client --> ACK --------------------------------> Server
```

### Enable TFO

```bash
# Kernel setting: 1=client, 2=server, 3=both
echo "net.ipv4.tcp_fastopen = 3" >> /etc/sysctl.d/99-tcp-tuning.conf
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

### TFO in Go (Server)

```go
lc := net.ListenConfig{
    Control: func(network, address string, c syscall.RawConn) error {
        return c.Control(func(fd uintptr) {
            // TCP_FASTOPEN socket option: set queue length
            syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_FASTOPEN, 256)
        })
    },
}
ln, _ := lc.Listen(ctx, "tcp", ":443")
```

### TFO Caveats

TFO has replay attack implications for non-idempotent operations. HTTP GET is safe; HTTP POST or API mutations require careful consideration. TFO is also blocked by some middleboxes (firewalls, NAT devices).

## Nagle's Algorithm and TCP_NODELAY

Nagle's algorithm coalesces small writes to reduce packet count, which hurts latency for interactive or RPC workloads.

```bash
# Disable Nagle for the entire system (rarely recommended)
# Better: use TCP_NODELAY per socket

sysctl net.ipv4.tcp_low_latency
```

In Go, `net.TCPConn.SetNoDelay(true)` is the default for TCP connections since Go 1.0. In other languages:

```python
import socket
s = socket.socket()
s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
```

For Kubernetes pod communication over localhost (loopback), Nagle has no meaningful effect.

## TIME_WAIT State Optimization

High-connection-rate servers can exhaust the 5-tuple connection table with TIME_WAIT connections.

```bash
# Number of connections in TIME_WAIT
ss -s | grep TIME-WAIT

# Allow TIME_WAIT socket reuse (RFC 1323 timestamps required)
echo "net.ipv4.tcp_tw_reuse = 1" >> /etc/sysctl.d/99-tcp-tuning.conf

# Extend local port range for outbound connections
echo "net.ipv4.ip_local_port_range = 1024 65535" >> /etc/sysctl.d/99-tcp-tuning.conf

# Reduce FIN_WAIT2 timeout (default 60s)
echo "net.ipv4.tcp_fin_timeout = 15" >> /etc/sysctl.d/99-tcp-tuning.conf
```

`tcp_tw_recycle` was removed in Linux 4.12 due to issues with NAT environments.

## Receive Side Scaling (RSS) and RPS

For multi-queue NICs, distribute receive processing across CPU cores:

```bash
# Check NIC queue count
ethtool -l eth0
# Channel parameters for eth0:
# Pre-set maximums:
# RX:             16
# TX:             16
# Combined:       16
# Current hardware settings:
# Combined:       4

# Set to match CPU count
ethtool -L eth0 combined $(nproc)

# Verify IRQ affinity
cat /proc/interrupts | grep eth0

# Set IRQ affinity manually (or use irqbalance)
for i in $(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':'); do
  echo $((1 << (i % $(nproc)))) > /proc/irq/$i/smp_affinity
done
```

### RPS (Software RSS for Single-Queue NICs)

```bash
# Enable RPS on single-queue NIC
for f in /sys/class/net/eth0/queues/rx-*/rps_cpus; do
    echo $(printf '%x' $((2**$(nproc) - 1))) > $f
done

# Enable RFS (Receive Flow Steering) — keeps flows on the CPU that processes app
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
echo 4096 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
```

## TCP Keep-Alive for Long-Lived Connections

Kubernetes and service meshes maintain many long-lived TCP connections. Dead connections must be detected promptly.

```bash
# Time before sending keep-alive probes (default: 7200s = 2 hours!)
echo "net.ipv4.tcp_keepalive_time = 60" >> /etc/sysctl.d/99-tcp-tuning.conf

# Interval between probes
echo "net.ipv4.tcp_keepalive_intvl = 10" >> /etc/sysctl.d/99-tcp-tuning.conf

# Number of probes before declaring dead
echo "net.ipv4.tcp_keepalive_probes = 6" >> /etc/sysctl.d/99-tcp-tuning.conf
```

This detects dead connections within `60 + 10*6 = 120` seconds instead of 2 hours.

In Go, enable per-connection:

```go
conn.(*net.TCPConn).SetKeepAlive(true)
conn.(*net.TCPConn).SetKeepAlivePeriod(30 * time.Second)
```

## Using ss and netstat for Analysis

`ss` (socket statistics) is the modern replacement for `netstat`.

### Connection State Overview

```bash
ss -s
# Total: 1247
# TCP:   892 (estab 412, closed 380, orphaned 0, timewait 380)
```

### Inspect TCP State and Socket Buffers

```bash
# All TCP connections with buffer info
ss -tnp

# Show internal TCP state (congestion control, RTT, etc.)
ss -tio
# State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port
# ESTAB  0       0       10.0.0.1:8080       10.0.1.5:54321
#          cubic wscale:7,7 rto:204 rtt:3.5/1.75 ato:40 mss:1460 pmtu:1500
#          rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:125000 bytes_acked:125000
#          bytes_received:8500 segs_out:90 segs_in:60 data_segs_out:85
#          send 33.4Mbps lastsnd:800 lastrcv:800 lastack:800 pacing_rate 66.8Mbps
#          delivery_rate 33.4Mbps delivered:86 app_limited busy:100ms rwnd_limited:0ms
#          sndbuf_limited:0ms unacked:0 retrans:0/0 rcv_rtt:4 rcv_space:29200
#          rcv_ssthresh:29200 minrtt:3.25 snd_wnd:262144

# Show connections with process info
ss -tnp src :8080

# Show TIME_WAIT count
ss -tn state time-wait | wc -l

# Monitor connections in real-time
watch -n1 'ss -tn | awk "NR>1 {print \$1}" | sort | uniq -c | sort -rn'
```

### Measure Retransmit Rate

```bash
# Retransmit counters from /proc
cat /proc/net/snmp | grep -E "^Tcp:"
# Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens ...
# Tcp: 1 200 120000 -1 425621 38421 0 0 462042 0 3 182 0 ...

# Per-second retransmit rate
watch -n1 "awk '/^Tcp:/ {if(NR==4) {retrans=\$13}; if(NR==5) {print \"RetransSegs:\", \$13-retrans; retrans=\$13}}' /proc/net/snmp"
```

### tcpdump for Deep Inspection

```bash
# Capture TCP connections on port 8080
tcpdump -i eth0 -n 'tcp port 8080' -w capture.pcap

# Show TCP flags
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-syn != 0'

# Show connections with SYN retransmits
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-syn != 0' | \
  awk '{print $3}' | sort | uniq -c | sort -rn | head -20
```

## Linux 6.x Networking Improvements

### MultiPath TCP (MPTCP) — Stable in 6.x

```bash
# Enable MPTCP
ip mptcp endpoint add 10.0.0.1 dev eth0 subflow
ip mptcp endpoint add 10.0.0.2 dev eth1 subflow signal

# Create MPTCP socket (Linux 5.6+)
socket(AF_INET, SOCK_STREAM, IPPROTO_MPTCP)
```

### TCP Zero-Copy Receive (MSG_ZEROCOPY)

Linux 6.0+ improves MSG_ZEROCOPY stability for receive paths, reducing CPU overhead for high-bandwidth applications.

### io_uring for Network I/O

```bash
# Check io_uring support
ls /proc/sys/kernel/io_uring_*

# io_uring provides:
# - Fixed file descriptors (avoid fdtable lookups)
# - Multishot accept (one accept call for many connections)
# - Zero-copy sends
```

### XDP (eXpress Data Path) Integration

```bash
# Load XDP program on NIC
ip link set dev eth0 xdp obj xdp_prog.o sec xdp

# XDP_DROP: filter at driver level, before SKB allocation
# XDP_TX: hairpin transmission
# XDP_REDIRECT: redirect to another interface or CPU queue
# XDP_PASS: pass to normal network stack
```

## Complete Tuning Profile

### High-Throughput Bulk Transfer (Object Storage, Kafka)

```ini
# /etc/sysctl.d/99-bulk-transfer.conf

# Large socket buffers for high BDP
net.ipv4.tcp_rmem = 4096 87380 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.core.rmem_default = 524288
net.core.wmem_default = 524288

# BBR + FQ
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq

# Maximize concurrent connections
net.core.somaxconn = 65536
net.ipv4.tcp_max_syn_backlog = 65536
net.core.netdev_max_backlog = 65536

# TIME_WAIT handling
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_fin_timeout = 15

# Fast keep-alive for dead connection detection
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# Selective ACKs
net.ipv4.tcp_sack = 1
net.ipv4.tcp_fack = 1

# Timestamps for RTT measurement
net.ipv4.tcp_timestamps = 1
```

### Low-Latency API (RPC, gRPC, Redis)

```ini
# /etc/sysctl.d/99-low-latency.conf

# Smaller buffers — less memory, faster acknowledgement
net.ipv4.tcp_rmem = 4096 16384 4194304
net.ipv4.tcp_wmem = 4096 16384 4194304

# BBR still appropriate for pacing
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq

# Aggressive TIME_WAIT cleanup
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_fin_timeout = 10

# Very fast dead connection detection
net.ipv4.tcp_keepalive_time = 30
net.ipv4.tcp_keepalive_intvl = 5
net.ipv4.tcp_keepalive_probes = 3

# Maximize accept queue
net.core.somaxconn = 65536
net.ipv4.tcp_max_syn_backlog = 65536
```

## Kubernetes-Specific Considerations

Kubernetes nodes need additional tuning because of the overlay network overhead (VXLAN/Geneve adds ~50 bytes per packet, reducing effective MTU):

```bash
# Set MTU for overlay network interfaces
ip link set flannel.1 mtu 1450
ip link set cni0 mtu 1450

# Or configure in CNI plugin (Calico example)
kubectl patch configmap -n kube-system calico-config \
  --patch '{"data":{"veth_mtu":"1430"}}'
```

For nodes with high pod density, increase conntrack table size:

```bash
sysctl net.netfilter.nf_conntrack_max
# Default: 131072 — often too small for dense nodes

echo "net.netfilter.nf_conntrack_max = 1048576" >> /etc/sysctl.d/99-conntrack.conf
echo "net.netfilter.nf_conntrack_buckets = 262144" >> /etc/sysctl.d/99-conntrack.conf
sysctl -p /etc/sysctl.d/99-conntrack.conf
```

Monitor conntrack exhaustion:

```bash
# Current usage vs maximum
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Watch for drops due to conntrack exhaustion
watch -n1 "dmesg | grep 'nf_conntrack: table full' | tail -5"
```

## Performance Benchmarking

Before and after tuning, measure with:

```bash
# iperf3 single stream
iperf3 -s &
iperf3 -c <server-ip> -t 30

# iperf3 parallel streams (stress test)
iperf3 -c <server-ip> -P 8 -t 30

# netperf for request/response latency
netperf -H <server-ip> -t TCP_RR -l 30

# wrk for HTTP throughput
wrk -t4 -c400 -d30s http://<server-ip>:8080/

# Validate BBR is active
iperf3 -c <server-ip> -Z -t 30 2>&1 | grep -i bbr
```

TCP tuning is workload-specific. Always benchmark your specific traffic pattern rather than applying generic recommendations blindly.
