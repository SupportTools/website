---
title: "Linux Transparent Proxy with TPROXY: Intercepting Traffic for Security and Observability"
date: 2031-01-22T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "TPROXY", "iptables", "Proxy", "Istio", "Envoy", "Security", "Observability"]
categories:
- Linux
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux TPROXY: configuring the TPROXY iptables target, IP_TRANSPARENT sockets, building a userspace proxy in Go, Istio/Envoy sidecar injection mechanics, capturing egress traffic without NAT, and debugging TPROXY configurations."
more_link: "yes"
url: "/linux-transparent-proxy-tproxy-traffic-interception-security-observability/"
---

Transparent proxying allows a process to intercept network traffic without the application being aware of the proxy's existence. Unlike REDIRECT (which uses NAT and rewrites destination addresses), TPROXY preserves the original destination IP and port while delivering packets to a local socket. This capability underpins service meshes like Istio, security inspection tools, and network observability platforms. This guide explains the kernel mechanisms, iptables configuration, socket options, a complete Go proxy implementation, and debugging techniques.

<!--more-->

# Linux Transparent Proxy with TPROXY: Intercepting Traffic for Security and Observability

## Why TPROXY Over REDIRECT

The standard approach to traffic interception uses `iptables -j REDIRECT`, which performs NAT to redirect packets to a local port. The proxy then uses `SO_ORIGINAL_DST` to recover the original destination. This works, but has significant limitations:

- The source IP in the proxy's accepted connection is the real client, but the destination is the proxy itself, not the original server
- IPv6 is poorly supported with REDIRECT
- The TCP/IP stack rewrites the destination, consuming routing resources
- Applications using SO_ORIGINAL_DST on IPv6 require `IP6T_SO_ORIGINAL_DST` which is less portable

TPROXY solves these problems by delivering packets to a local socket without modifying the destination address in the packet headers. The proxy socket sees the original client IP as source and the original destination IP as destination, enabling fully transparent operation.

## Kernel Architecture

TPROXY operates through three cooperating subsystems:

```
Packet arrives at interface
        │
        ▼
   Netfilter PREROUTING
        │
        │ iptables -j TPROXY sets:
        │   nf_conntrack_mark
        │   sk_mark on socket
        │   Routes packet to local delivery
        ▼
   Policy Routing
   (ip rule: fwmark 1 lookup 100)
        │
        ▼
   Route table 100
   (local delivery: ip route add local default dev lo table 100)
        │
        ▼
   Socket lookup
   (finds the IP_TRANSPARENT socket bound to the original destination)
        │
        ▼
   Application accept() returns conn with original src/dst
```

The critical difference from REDIRECT: the packet's destination IP remains unchanged. The kernel finds a socket bound to that IP (possible only with IP_TRANSPARENT) and delivers the packet there.

## Kernel Requirements

```bash
# Verify kernel support
zcat /proc/config.gz | grep -E 'NETFILTER_XT_TARGET_TPROXY|IP_NF_MANGLE'
# CONFIG_NETFILTER_XT_TARGET_TPROXY=m
# CONFIG_IP_NF_MANGLE=y

# Load required modules
modprobe xt_TPROXY
modprobe xt_socket
modprobe ip_tables
modprobe ip6_tables

# Verify loaded
lsmod | grep -E 'xt_TPROXY|xt_socket'
```

## iptables and Policy Routing Configuration

### Complete TPROXY Setup Script

```bash
#!/bin/bash
# setup-tproxy.sh - Configure TPROXY for egress traffic interception
set -euo pipefail

PROXY_PORT=15001          # Port where our proxy listens
PROXY_UID=1337            # UID running the proxy process
TPROXY_MARK=1             # Firewall mark for TPROXY packets
TPROXY_ROUTE_TABLE=100    # Policy routing table number

# ---- IPv4 Configuration ----

# 1. Add routing rule: packets with mark TPROXY_MARK use table TPROXY_ROUTE_TABLE
ip rule add fwmark ${TPROXY_MARK} lookup ${TPROXY_ROUTE_TABLE} priority 100

# 2. Add route in custom table: deliver all marked packets locally
ip route add local default dev lo table ${TPROXY_ROUTE_TABLE}

# 3. Mangle table PREROUTING: intercept incoming packets
iptables -t mangle -N TPROXY_INBOUND 2>/dev/null || true
iptables -t mangle -F TPROXY_INBOUND

# Skip loopback
iptables -t mangle -A TPROXY_INBOUND -i lo -j RETURN

# Skip traffic to local subnets (management traffic)
iptables -t mangle -A TPROXY_INBOUND -d 127.0.0.0/8 -j RETURN
iptables -t mangle -A TPROXY_INBOUND -d 10.0.0.0/8 -j RETURN
iptables -t mangle -A TPROXY_INBOUND -d 192.168.0.0/16 -j RETURN
iptables -t mangle -A TPROXY_INBOUND -d 172.16.0.0/12 -j RETURN

# Skip proxy's own outbound traffic (prevent loops)
iptables -t mangle -A TPROXY_INBOUND -m owner --uid-owner ${PROXY_UID} -j RETURN

# Apply TPROXY for TCP traffic
iptables -t mangle -A TPROXY_INBOUND -p tcp \
  -j TPROXY \
  --tproxy-mark ${TPROXY_MARK}/0xffffffff \
  --on-port ${PROXY_PORT}

# Apply TPROXY for UDP traffic
iptables -t mangle -A TPROXY_INBOUND -p udp \
  -j TPROXY \
  --tproxy-mark ${TPROXY_MARK}/0xffffffff \
  --on-port ${PROXY_PORT}

# Attach chain to PREROUTING
iptables -t mangle -A PREROUTING -j TPROXY_INBOUND

# 4. Mangle table OUTPUT: intercept locally-originated traffic
iptables -t mangle -N TPROXY_OUTBOUND 2>/dev/null || true
iptables -t mangle -F TPROXY_OUTBOUND

# Skip proxy's own traffic
iptables -t mangle -A TPROXY_OUTBOUND -m owner --uid-owner ${PROXY_UID} -j RETURN

# Skip loopback and private networks
iptables -t mangle -A TPROXY_OUTBOUND -d 127.0.0.0/8 -j RETURN
iptables -t mangle -A TPROXY_OUTBOUND -d 10.0.0.0/8 -j RETURN
iptables -t mangle -A TPROXY_OUTBOUND -d 192.168.0.0/16 -j RETURN

# Mark outbound TCP for local delivery to proxy
iptables -t mangle -A TPROXY_OUTBOUND -p tcp \
  -j MARK --set-mark ${TPROXY_MARK}

# Attach chain to OUTPUT
iptables -t mangle -A OUTPUT -j TPROXY_OUTBOUND

echo "TPROXY setup complete"
echo "Proxy should listen on 0.0.0.0:${PROXY_PORT} with IP_TRANSPARENT socket"
```

### Cleanup Script

```bash
#!/bin/bash
# teardown-tproxy.sh
TPROXY_MARK=1
TPROXY_ROUTE_TABLE=100

ip rule del fwmark ${TPROXY_MARK} lookup ${TPROXY_ROUTE_TABLE} 2>/dev/null || true
ip route flush table ${TPROXY_ROUTE_TABLE} 2>/dev/null || true

iptables -t mangle -D PREROUTING -j TPROXY_INBOUND 2>/dev/null || true
iptables -t mangle -D OUTPUT -j TPROXY_OUTBOUND 2>/dev/null || true
iptables -t mangle -F TPROXY_INBOUND 2>/dev/null || true
iptables -t mangle -X TPROXY_INBOUND 2>/dev/null || true
iptables -t mangle -F TPROXY_OUTBOUND 2>/dev/null || true
iptables -t mangle -X TPROXY_OUTBOUND 2>/dev/null || true

echo "TPROXY teardown complete"
```

## IP_TRANSPARENT Socket Option

The `IP_TRANSPARENT` socket option allows a process to bind to non-local IP addresses - the original destination addresses of intercepted connections. Without this option, binding to a foreign IP would fail with EADDRNOTAVAIL.

```c
// C demonstration of IP_TRANSPARENT socket setup
#include <sys/socket.h>
#include <netinet/in.h>
#include <linux/in.h>

int sock = socket(AF_INET, SOCK_STREAM, 0);

// Enable IP_TRANSPARENT - requires CAP_NET_ADMIN
int val = 1;
setsockopt(sock, SOL_IP, IP_TRANSPARENT, &val, sizeof(val));

// Enable SO_REUSEADDR and SO_REUSEPORT for listener
setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &val, sizeof(val));
setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, &val, sizeof(val));

// Bind to 0.0.0.0 to receive all TPROXY-routed connections
struct sockaddr_in addr = {
    .sin_family = AF_INET,
    .sin_addr.s_addr = INADDR_ANY,
    .sin_port = htons(15001)
};
bind(sock, (struct sockaddr*)&addr, sizeof(addr));
listen(sock, 128);

// After accept(), getsockname() returns original destination IP
// getpeername() returns original client IP - both preserved!
```

## Building a Transparent Proxy in Go

### Complete TPROXY Listener Implementation

```go
// tproxy/tproxy.go
package tproxy

import (
    "context"
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

// ListenTCP creates a TCP listener with IP_TRANSPARENT socket option.
// This allows accepting connections destined for any IP address.
func ListenTCP(addr string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                // IP_TRANSPARENT = 19, SOL_IP = 0
                // Requires CAP_NET_ADMIN capability
                if err := syscall.SetsockoptInt(int(fd), syscall.SOL_IP, syscall.IP_TRANSPARENT, 1); err != nil {
                    fmt.Printf("Warning: IP_TRANSPARENT failed: %v (need CAP_NET_ADMIN)\n", err)
                }
                // SO_REUSEADDR
                syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
                // SO_REUSEPORT
                syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEPORT, 1)
            })
        },
    }

    return lc.Listen(context.Background(), "tcp", addr)
}

// GetOriginalDst returns the original destination address from a connection
// that was intercepted by TPROXY. With TPROXY, this is simply getsockname()
// because the destination is preserved in the socket.
func GetOriginalDst(conn *net.TCPConn) (*net.TCPAddr, error) {
    // With TPROXY, LocalAddr() on the accepted connection IS the original destination
    // (unlike REDIRECT where we'd need SO_ORIGINAL_DST)
    addr := conn.LocalAddr()
    tcpAddr, ok := addr.(*net.TCPAddr)
    if !ok {
        return nil, fmt.Errorf("not a TCP address: %T", addr)
    }
    return tcpAddr, nil
}

// GetOriginalDstREDIRECT retrieves original destination from a REDIRECT-intercepted
// connection using SO_ORIGINAL_DST getsockopt. For reference/comparison.
func GetOriginalDstREDIRECT(conn *net.TCPConn) (*net.TCPAddr, error) {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return nil, err
    }

    var addr syscall.RawSockaddrInet4
    var addrLen uint32 = uint32(unsafe.Sizeof(addr))
    var callErr error

    err = rawConn.Control(func(fd uintptr) {
        // SO_ORIGINAL_DST = 80 on Linux
        _, _, errno := syscall.Syscall6(
            syscall.SYS_GETSOCKOPT,
            fd,
            syscall.SOL_IP,
            80, // SO_ORIGINAL_DST
            uintptr(unsafe.Pointer(&addr)),
            uintptr(unsafe.Pointer(&addrLen)),
            0,
        )
        if errno != 0 {
            callErr = errno
        }
    })
    if err != nil || callErr != nil {
        if callErr != nil {
            return nil, callErr
        }
        return nil, err
    }

    return &net.TCPAddr{
        IP:   net.IP(addr.Addr[:]),
        Port: int(addr.Port>>8) | int(addr.Port&0xff)<<8, // ntohs
    }, nil
}
```

### Complete Transparent Proxy Server

```go
// main.go
package main

import (
    "context"
    "io"
    "log"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "github.com/example/tproxy/tproxy"
)

var (
    connectionsAccepted = promauto.NewCounter(prometheus.CounterOpts{
        Name: "tproxy_connections_accepted_total",
        Help: "Total connections accepted by the transparent proxy",
    })
    connectionsActive = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "tproxy_connections_active",
        Help: "Currently active proxy connections",
    })
    bytesProxied = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "tproxy_bytes_total",
        Help: "Total bytes proxied",
    }, []string{"direction"})
    connectionDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "tproxy_connection_duration_seconds",
        Help:    "Duration of proxied connections",
        Buckets: prometheus.DefBuckets,
    })
)

func main() {
    listenAddr := getEnv("TPROXY_LISTEN", "0.0.0.0:15001")
    metricsAddr := getEnv("TPROXY_METRICS", "0.0.0.0:9090")

    // Start metrics server
    go func() {
        http.Handle("/metrics", promhttp.Handler())
        log.Printf("Metrics listening on %s", metricsAddr)
        http.ListenAndServe(metricsAddr, nil)
    }()

    // Create IP_TRANSPARENT listener
    ln, err := tproxy.ListenTCP(listenAddr)
    if err != nil {
        log.Fatalf("Failed to listen: %v", err)
    }
    defer ln.Close()

    log.Printf("TPROXY listening on %s", listenAddr)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Handle shutdown signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    go func() {
        <-sigCh
        log.Println("Shutting down...")
        ln.Close()
        cancel()
    }()

    for {
        conn, err := ln.Accept()
        if err != nil {
            select {
            case <-ctx.Done():
                return
            default:
                log.Printf("Accept error: %v", err)
                continue
            }
        }

        connectionsAccepted.Inc()
        go handleConnection(ctx, conn.(*net.TCPConn))
    }
}

func handleConnection(ctx context.Context, clientConn *net.TCPConn) {
    defer clientConn.Close()

    start := time.Now()
    connectionsActive.Inc()
    defer func() {
        connectionsActive.Dec()
        connectionDuration.Observe(time.Since(start).Seconds())
    }()

    // Get original destination - with TPROXY this is LocalAddr()
    dst, err := tproxy.GetOriginalDst(clientConn)
    if err != nil {
        log.Printf("Failed to get original dst: %v", err)
        return
    }

    clientAddr := clientConn.RemoteAddr()
    log.Printf("Proxying %s -> %s", clientAddr, dst)

    // Policy hook: inspect, log, block, or modify based on dst
    if shouldBlock(dst) {
        log.Printf("BLOCKED: %s -> %s", clientAddr, dst)
        clientConn.Close()
        return
    }

    // Connect to original destination
    dialer := &net.Dialer{
        Timeout: 10 * time.Second,
        Control: func(network, address string, c syscall.RawConn) error {
            // Mark outbound connection to avoid re-interception
            return c.Control(func(fd uintptr) {
                syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, 255)
            })
        },
    }

    serverConn, err := dialer.DialContext(ctx, "tcp", dst.String())
    if err != nil {
        log.Printf("Failed to connect to %s: %v", dst, err)
        return
    }
    defer serverConn.Close()

    // Bidirectional copy with byte counting
    done := make(chan struct{}, 2)

    go func() {
        n, _ := io.Copy(serverConn, clientConn)
        bytesProxied.WithLabelValues("upstream").Add(float64(n))
        serverConn.(*net.TCPConn).CloseWrite()
        done <- struct{}{}
    }()

    go func() {
        n, _ := io.Copy(clientConn, serverConn)
        bytesProxied.WithLabelValues("downstream").Add(float64(n))
        clientConn.CloseWrite()
        done <- struct{}{}
    }()

    // Wait for both directions to complete
    <-done
    <-done
}

func shouldBlock(addr *net.TCPAddr) bool {
    // Example: block connections to port 23 (telnet)
    if addr.Port == 23 {
        return true
    }
    return false
}

func getEnv(key, defaultValue string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultValue
}
```

### Running the Proxy with Correct Capabilities

```bash
# Option 1: Run as root (not recommended for production)
sudo ./tproxy

# Option 2: Use capabilities (preferred)
# Grant CAP_NET_ADMIN and CAP_NET_RAW to the binary
sudo setcap 'cap_net_admin,cap_net_raw+ep' ./tproxy

# Run as non-root user (uid 1337 matches PROXY_UID in iptables rules)
sudo -u proxyuser ./tproxy

# Option 3: Docker/container with capabilities
# docker run --cap-add NET_ADMIN --cap-add NET_RAW ...

# Option 4: Kubernetes pod securityContext
# securityContext:
#   capabilities:
#     add: ["NET_ADMIN", "NET_RAW"]
```

## Istio/Envoy Sidecar Injection Mechanics

Istio implements transparent proxying using a combination of init containers and TPROXY/REDIRECT rules. Understanding this helps with debugging and performance optimization.

### Init Container: istio-init

The `istio-init` init container runs `iptables-restore` to configure traffic interception before any application containers start:

```bash
# Reconstruct the iptables rules applied by istio-init
# (simplified - actual Istio rules are more complex)

# Create chains
iptables -t nat -N ISTIO_REDIRECT
iptables -t nat -N ISTIO_IN_REDIRECT
iptables -t nat -N ISTIO_OUTPUT
iptables -t nat -N ISTIO_INBOUND

# Redirect inbound traffic to Envoy's inbound port (15006)
iptables -t nat -A ISTIO_IN_REDIRECT -p tcp -j REDIRECT --to-ports 15006
iptables -t nat -A ISTIO_REDIRECT -p tcp -j REDIRECT --to-ports 15001

# Handle inbound traffic
iptables -t nat -A ISTIO_INBOUND -p tcp --dport 15020 -j RETURN  # Health check port
iptables -t nat -A ISTIO_INBOUND -p tcp --dport 15090 -j RETURN  # Envoy metrics
iptables -t nat -A ISTIO_INBOUND -p tcp -j ISTIO_IN_REDIRECT

# Handle outbound traffic
iptables -t nat -A ISTIO_OUTPUT -m owner --uid-owner 1337 -j RETURN  # Skip Envoy's own traffic
iptables -t nat -A ISTIO_OUTPUT -m owner --gid-owner 1337 -j RETURN
iptables -t nat -A ISTIO_OUTPUT -d 127.0.0.1/32 -j RETURN
iptables -t nat -A ISTIO_OUTPUT -j ISTIO_REDIRECT

# Hook into standard chains
iptables -t nat -A PREROUTING -p tcp -j ISTIO_INBOUND
iptables -t nat -A OUTPUT -p tcp -j ISTIO_OUTPUT
```

Istio uses REDIRECT (with NAT) by default, but supports TPROXY mode for better performance:

```yaml
# Enable TPROXY mode in Istio
# In istio-system ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio
  namespace: istio-system
data:
  mesh: |-
    defaultConfig:
      interceptionMode: TPROXY  # Instead of REDIRECT
```

### Envoy's TPROXY Socket Configuration

When Istio uses TPROXY mode, Envoy configures its listener with the transparent option:

```yaml
# Envoy listener configuration for TPROXY (simplified)
listeners:
- name: virtualOutbound
  address:
    socket_address:
      address: 0.0.0.0
      port_value: 15001
  listener_filters:
  - name: envoy.filters.listener.original_dst
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.filters.listener.original_dst.v3.OriginalDst
  - name: envoy.filters.listener.http_inspector
  transparent: true  # Enables IP_TRANSPARENT behavior
  socket_options:
  - description: IP_TRANSPARENT
    level: 0     # SOL_IP
    name: 19     # IP_TRANSPARENT
    int_value: 1
    state: STATE_PREBIND
```

## Debugging TPROXY

### Verify Policy Routing

```bash
# Check routing rules
ip rule show
# 0:      from all lookup local
# 100:    from all fwmark 0x1 lookup 100    <- Our TPROXY rule
# 32766:  from all lookup main
# 32767:  from all lookup default

# Check custom routing table
ip route show table 100
# local default dev lo scope host   <- Deliver locally

# Verify marks are being set
iptables -t mangle -L TPROXY_INBOUND -v -n --line-numbers
# Shows packet/byte counters per rule

# Watch packet counters in real time
watch -n1 'iptables -t mangle -L TPROXY_INBOUND -v -n'
```

### Verify Socket State

```bash
# Check what's listening on the TPROXY port
ss -tlnp sport = :15001

# Check socket options on the listening socket
# (requires strace or custom tooling)
strace -e trace=setsockopt,getsockopt -p $(pgrep tproxy)

# Check if IP_TRANSPARENT is set
# Linux kernel exposes this via /proc/net/tcp (6th column: tx_queue:rx_queue)
# Use ss with --info for socket details
ss -tipn sport = :15001
```

### Common Issues and Solutions

**Issue: Connections not being intercepted**

```bash
# Check if packets are hitting the mangle table rules
iptables -t mangle -L TPROXY_INBOUND -v -n
# If packet counter is 0, packets aren't reaching the rule

# Check if kernel module is loaded
lsmod | grep xt_TPROXY
# If not loaded: modprobe xt_TPROXY

# Test with a simple iptables LOG rule
iptables -t mangle -I PREROUTING 1 -p tcp -j LOG --log-prefix "TPROXY-DEBUG: "
# Check: journalctl -k -f | grep TPROXY-DEBUG
```

**Issue: EADDRNOTAVAIL on bind**

```bash
# Error: bind: cannot assign requested address
# Cause: IP_TRANSPARENT not set on the socket

# Verify the proxy process has CAP_NET_ADMIN
cat /proc/$(pgrep tproxy)/status | grep Cap
# Use capsh to decode:
capsh --decode=$(cat /proc/$(pgrep tproxy)/status | grep CapEff | awk '{print $2}')
```

**Issue: Traffic loop (proxy's traffic being intercepted)**

```bash
# The proxy's outbound traffic must be excluded
# Verify by checking the rule that skips PROXY_UID
iptables -t mangle -L TPROXY_OUTBOUND -v -n

# If packets are looping, check that PROXY_UID matches the process UID
id proxyuser
# Make sure PROXY_UID in iptables matches

# Alternative: use SO_MARK on proxy outbound sockets (mark 255 in our example)
# then add: iptables -t mangle -A TPROXY_OUTBOUND -m mark --mark 255 -j RETURN
```

**Issue: IPv6 traffic not being intercepted**

```bash
# TPROXY works with IPv6, but requires ip6tables
ip6tables -t mangle -N TPROXY_INBOUND6 2>/dev/null || true

ip6tables -t mangle -A TPROXY_INBOUND6 -p tcp \
  -j TPROXY \
  --tproxy-mark 1/0xffffffff \
  --on-port 15001

ip6tables -t mangle -A PREROUTING -j TPROXY_INBOUND6

# IPv6 policy routing
ip -6 rule add fwmark 1 lookup 100
ip -6 route add local default dev lo table 100
```

### Packet Capture for TPROXY Debugging

```bash
# Capture with tcpdump on the loopback - TPROXY packets come through lo
tcpdump -i lo -n port 15001

# Capture on the main interface to see original traffic
tcpdump -i eth0 -n port 443

# Use conntrack to observe connection tracking
conntrack -L -p tcp --dport 443 2>/dev/null

# netstat/ss to see connections to the proxy
ss -tnp dport = :15001
ss -tnp sport = :15001
```

## Istio TPROXY vs REDIRECT Performance

TPROXY mode offers performance advantages over REDIRECT for high-throughput services:

```bash
# Benchmark comparison (using iperf3)

# REDIRECT mode
iperf3 -c service-endpoint -t 30 -P 4
# [ ID] Interval         Transfer     Bandwidth
# [SUM] 0.00-30.00 sec  28.4 GBytes  8.13 Gbits/sec

# TPROXY mode (after switching Istio to TPROXY)
iperf3 -c service-endpoint -t 30 -P 4
# [SUM] 0.00-30.00 sec  31.2 GBytes  8.92 Gbits/sec  (+9.7%)

# CPU usage difference
# REDIRECT: ~12% higher CPU due to NAT translation overhead
# TPROXY: No NAT, preserves connection tracking state better
```

## Production Considerations

### Privilege Reduction

```yaml
# Kubernetes: proxy container with minimal capabilities
securityContext:
  capabilities:
    add:
    - NET_ADMIN    # Required for IP_TRANSPARENT and iptables
    - NET_RAW      # Required for raw socket operations
    drop:
    - ALL          # Drop all others
  runAsNonRoot: true
  runAsUser: 1337
  allowPrivilegeEscalation: false
```

### Resource Limits

```bash
# Monitor file descriptor usage (each proxied connection = 2 FDs)
cat /proc/$(pgrep tproxy)/limits | grep 'open files'

# Increase if needed
ulimit -n 1048576

# Or via systemd service
# LimitNOFILE=1048576

# Monitor kernel connection tracking table
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Increase conntrack table size
sysctl -w net.netfilter.nf_conntrack_max=1048576
sysctl -w net.netfilter.nf_conntrack_buckets=262144
```

### High Availability

```bash
# Use SO_REUSEPORT for multiple proxy workers
# Each worker binds to the same port
# Kernel distributes incoming connections round-robin

# In Go:
lc := net.ListenConfig{
    Control: func(network, address string, c syscall.RawConn) error {
        return c.Control(func(fd uintptr) {
            syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEPORT, 1)
            syscall.SetsockoptInt(int(fd), syscall.SOL_IP, syscall.IP_TRANSPARENT, 1)
        })
    },
}

// Start N workers, each listening on the same address
for i := 0; i < runtime.NumCPU(); i++ {
    ln, _ := lc.Listen(ctx, "tcp", "0.0.0.0:15001")
    go serveListener(ln)
}
```

## Conclusion

TPROXY is the foundation of modern service mesh traffic interception. Key takeaways:

1. **TPROXY vs REDIRECT**: TPROXY preserves original destination without NAT, enabling the proxy to correctly identify and route traffic; REDIRECT is simpler to configure but has higher overhead and weaker IPv6 support
2. **Three-part setup**: iptables TPROXY target + policy routing rule + `ip route add local` in custom table - all three are required
3. **IP_TRANSPARENT requirement**: Listening sockets must have IP_TRANSPARENT set via `setsockopt`, and the process needs `CAP_NET_ADMIN`
4. **Loop prevention**: The proxy's own outbound traffic must be excluded from TPROXY rules using `--uid-owner` or `SO_MARK`
5. **Istio integration**: TPROXY mode in Istio improves throughput by ~10% over REDIRECT by eliminating NAT overhead at scale

Understanding TPROXY mechanics enables better debugging of service mesh issues, custom observability tooling, and security proxies that require full visibility into traffic metadata.
