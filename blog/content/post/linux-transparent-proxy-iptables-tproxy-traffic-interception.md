---
title: "Linux Transparent Proxy: iptables TPROXY and Traffic Interception"
date: 2029-07-15T00:00:00-05:00
draft: false
tags: ["Linux", "iptables", "TPROXY", "Networking", "Envoy", "Istio", "Traffic Management"]
categories: ["Linux", "Networking", "Service Mesh"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux transparent proxy implementation: TPROXY iptables target, IP_TRANSPARENT socket option, original destination retrieval, Envoy and Istio transparent proxy implementation, and debugging with iptables trace."
more_link: "yes"
url: "/linux-transparent-proxy-iptables-tproxy-traffic-interception/"
---

Transparent proxy is how Envoy sidecars intercept all traffic without modifying the application code. Understanding the kernel mechanisms—iptables TPROXY, IP_TRANSPARENT socket option, and original destination retrieval—is essential for debugging service mesh issues, implementing custom traffic interception, and understanding why certain network policies behave unexpectedly in Kubernetes.

<!--more-->

# Linux Transparent Proxy: iptables TPROXY and Traffic Interception

## Transparent Proxy Fundamentals

A transparent proxy intercepts network connections without the originating application's knowledge. The key challenge: when a packet arrives at a proxy socket, the proxy needs to know the *original* destination (not the proxy's own address) to forward it correctly.

```
Without transparent proxy:
  App (10.0.0.1:54321) → SYN → Server (10.0.0.2:8080)
  SYN arrives at server's network stack on 10.0.0.2:8080

With transparent proxy (TPROXY):
  App (10.0.0.1:54321) → SYN → Server (10.0.0.2:8080)
  SYN is REDIRECTED to Proxy (127.0.0.1:15001)
  Proxy accepts on 10.0.0.2:8080 (IP_TRANSPARENT)
  Proxy reads original destination: 10.0.0.2:8080
  Proxy opens connection to 10.0.0.2:8080 as the upstream
```

### Two Kernel Mechanisms

Linux provides two ways to redirect traffic:

| Feature | REDIRECT | TPROXY |
|---------|---------|--------|
| Target | Rewrites destination IP/port | Doesn't modify packet |
| Original dest recovery | SO_ORIGINAL_DST getsockopt | SO_ORIGINAL_DST + IP_TRANSPARENT |
| Binding to original IP | Not possible | Yes, via IP_TRANSPARENT |
| Traffic in | Must be LOCAL (INPUT chain) | Can be PREROUTING |
| Use case | Simple port redirection | Full transparent proxy |

## iptables REDIRECT: The Simple Approach

Before TPROXY, applications used REDIRECT to intercept traffic:

```bash
# Intercept all outbound traffic on port 80 to a local proxy on 15001
iptables -t nat -A OUTPUT -p tcp --dport 80 -j REDIRECT --to-port 15001

# The packet's destination IP is changed to 127.0.0.1 (loopback)
# The proxy can recover the original destination using SO_ORIGINAL_DST
```

```go
package redirect

import (
    "encoding/binary"
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

const (
    SO_ORIGINAL_DST = 80  // from /usr/include/linux/netfilter_ipv4.h
)

// GetOriginalDst recovers the original destination before REDIRECT
// Works for both REDIRECT and TPROXY
func GetOriginalDst(conn *net.TCPConn) (net.IP, uint16, error) {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return nil, 0, err
    }

    var (
        origDstIP   net.IP
        origDstPort uint16
        sockErr     error
    )

    rawConn.Control(func(fd uintptr) {
        // struct sockaddr_in (for IPv4)
        // SO_ORIGINAL_DST returns a sockaddr_in structure
        addr, err := syscall.GetsockoptIPv6Mreq(int(fd), syscall.IPPROTO_IP, SO_ORIGINAL_DST)
        if err != nil {
            sockErr = fmt.Errorf("getsockopt SO_ORIGINAL_DST: %w", err)
            return
        }
        // addr.Multiaddr contains the sockaddr_in:
        // bytes 2-3: port (big-endian)
        // bytes 4-7: IP address
        origDstPort = binary.BigEndian.Uint16(addr.Multiaddr[2:4])
        origDstIP = net.IP(addr.Multiaddr[4:8])
    })

    if sockErr != nil {
        return nil, 0, sockErr
    }

    return origDstIP, origDstPort, nil
}

// Simple proxy using REDIRECT
func handleREDIRECTedConnection(conn *net.TCPConn) {
    origIP, origPort, err := GetOriginalDst(conn)
    if err != nil {
        fmt.Printf("Error getting original dst: %v\n", err)
        conn.Close()
        return
    }

    fmt.Printf("Connection intercepted, original dest: %s:%d\n", origIP, origPort)

    // Connect to the original destination
    upstream, err := net.Dial("tcp", fmt.Sprintf("%s:%d", origIP, origPort))
    if err != nil {
        fmt.Printf("Failed to connect upstream: %v\n", err)
        conn.Close()
        return
    }
    defer upstream.Close()
    defer conn.Close()

    // Bidirectional proxy
    done := make(chan struct{}, 2)
    go func() {
        io.Copy(upstream, conn)
        done <- struct{}{}
    }()
    go func() {
        io.Copy(conn, upstream)
        done <- struct{}{}
    }()
    <-done
}
```

## iptables TPROXY: The Production Approach

TPROXY is more powerful than REDIRECT because it:
1. Doesn't modify the packet header (preserves original destination)
2. Allows binding to the original destination IP
3. Works in the PREROUTING chain (can intercept forwarded traffic)

### Setting Up TPROXY Rules

```bash
#!/bin/bash
# TPROXY setup (as used by Istio/Envoy)

# Load required kernel modules
modprobe xt_TPROXY
modprobe xt_mark
modprobe xt_socket

# Create a routing table for intercepted traffic
echo "100 tproxy" >> /etc/iproute2/rt_tables
ip rule add fwmark 1 lookup tproxy
ip route add local 0.0.0.0/0 dev lo table tproxy

# Mangle table rules (PREROUTING - applies to all incoming packets)
# Intercept inbound TCP traffic to port 80 and 443
iptables -t mangle -A PREROUTING -p tcp \
  --dport 80 -j TPROXY \
  --tproxy-mark 0x1/0x1 \
  --on-port 15001 \
  --on-ip 127.0.0.1

iptables -t mangle -A PREROUTING -p tcp \
  --dport 443 -j TPROXY \
  --tproxy-mark 0x1/0x1 \
  --on-port 15001 \
  --on-ip 127.0.0.1
```

### The TPROXY Target Parameters

```bash
# TPROXY target options:
# --tproxy-mark <value>[/<mask>]
#   Sets the packet mark. Packets with this mark are routed to local (via ip rule)
#
# --on-port <port>
#   The local port where the proxy is listening
#
# --on-ip <ip>
#   The local IP where the proxy is listening (optional, defaults to 0.0.0.0)

# Full TPROXY setup for Envoy-style interception:

# 1. Create routing: packets marked 1 go to loopback (handled locally)
ip rule add fwmark 0x1/0x1 lookup 100
ip route add local 0.0.0.0/0 dev lo table 100

# 2. Outbound interception (OUTPUT chain for locally generated traffic)
iptables -t mangle -N PROXY_OUT

# Skip traffic from the proxy itself (uid 1337 = envoy user)
iptables -t mangle -A PROXY_OUT -m owner --uid-owner 1337 -j RETURN

# Skip loopback traffic
iptables -t mangle -A PROXY_OUT -o lo -j RETURN

# Mark outbound TCP for interception
iptables -t mangle -A PROXY_OUT -p tcp -j MARK --set-mark 1
iptables -t mangle -A OUTPUT -j PROXY_OUT

# 3. Inbound interception (PREROUTING for incoming traffic)
iptables -t mangle -N PROXY_IN

# TPROXY inbound traffic to the proxy
iptables -t mangle -A PROXY_IN -p tcp -j TPROXY \
  --tproxy-mark 0x1/0x1 \
  --on-port 15006

iptables -t mangle -A PREROUTING -j PROXY_IN
```

## IP_TRANSPARENT Socket Option

The `IP_TRANSPARENT` socket option allows a process to bind to an IP address that doesn't belong to the local machine. This is what allows the proxy to accept connections to the *original* destination IP:

```go
package tproxy

import (
    "fmt"
    "net"
    "syscall"
)

// CreateTransparentListener creates a TCP listener with IP_TRANSPARENT
// This allows binding to any IP address, enabling the proxy to appear
// as if it is the original destination
func CreateTransparentListener(port int) (*net.TCPListener, error) {
    // Use net.ListenConfig with a control function to set IP_TRANSPARENT
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            var sockErr error
            c.Control(func(fd uintptr) {
                // IP_TRANSPARENT: allow binding to non-local addresses
                sockErr = syscall.SetsockoptInt(int(fd),
                    syscall.SOL_IP,
                    syscall.IP_TRANSPARENT,
                    1,
                )
                if sockErr != nil {
                    return
                }
                // SO_REUSEADDR: allow port reuse
                sockErr = syscall.SetsockoptInt(int(fd),
                    syscall.SOL_SOCKET,
                    syscall.SO_REUSEADDR,
                    1,
                )
                if sockErr != nil {
                    return
                }
                // IP_RECVORIGDSTADDR: receive original destination in ancillary data
                // Alternative to SO_ORIGINAL_DST for UDP
                sockErr = syscall.SetsockoptInt(int(fd),
                    syscall.SOL_IP,
                    syscall.IP_RECVORIGDSTADDR,
                    1,
                )
            })
            return sockErr
        },
    }

    ln, err := lc.Listen(nil, "tcp", fmt.Sprintf("0.0.0.0:%d", port))
    if err != nil {
        return nil, fmt.Errorf("listen: %w", err)
    }

    return ln.(*net.TCPListener), nil
}

// AcceptWithOriginalDst accepts a connection and returns the original destination
// Works with both REDIRECT and TPROXY
type ProxyConn struct {
    Conn         *net.TCPConn
    OriginalDst  net.Addr
    LocalAddr    net.Addr
}

func AcceptTransparent(ln *net.TCPListener) (*ProxyConn, error) {
    conn, err := ln.AcceptTCP()
    if err != nil {
        return nil, err
    }

    // Get original destination
    origIP, origPort, err := GetOriginalDst(conn)
    if err != nil {
        // Fallback: use the local address (works for TPROXY where local addr IS original dst)
        origIP = conn.LocalAddr().(*net.TCPAddr).IP
        origPort = uint16(conn.LocalAddr().(*net.TCPAddr).Port)
    }

    return &ProxyConn{
        Conn:        conn,
        OriginalDst: &net.TCPAddr{IP: origIP, Port: int(origPort)},
        LocalAddr:   conn.LocalAddr(),
    }, nil
}
```

## Envoy/Istio Transparent Proxy Implementation

Istio's transparent proxy uses the init container `istio-init` to set up iptables rules. Understanding this helps debug pod networking issues:

```bash
# Actual iptables rules created by istio-init (simplified)
# Run: kubectl exec <pod> -c istio-proxy -- iptables-save

# NAT table
*nat
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]

# Custom chains
:ISTIO_INBOUND - [0:0]
:ISTIO_IN_REDIRECT - [0:0]
:ISTIO_OUTPUT - [0:0]
:ISTIO_REDIRECT - [0:0]

# Redirect inbound traffic to Envoy's inbound listener (15006)
-A PREROUTING -p tcp -j ISTIO_INBOUND
-A ISTIO_INBOUND -p tcp --dport 15008 -j RETURN  # Skip HBONE
-A ISTIO_INBOUND -p tcp --dport 15090 -j RETURN  # Skip metrics
-A ISTIO_INBOUND -p tcp --dport 15021 -j RETURN  # Skip health
-A ISTIO_INBOUND -p tcp --dport 15020 -j RETURN  # Skip merged metrics
-A ISTIO_INBOUND -p tcp -j ISTIO_IN_REDIRECT
-A ISTIO_IN_REDIRECT -p tcp -j REDIRECT --to-ports 15006

# Redirect outbound traffic to Envoy's outbound listener (15001)
-A OUTPUT -p tcp -j ISTIO_OUTPUT
-A ISTIO_OUTPUT -o lo -s 127.0.0.6/32 -j RETURN     # Skip Envoy passthrough
-A ISTIO_OUTPUT -o lo -m owner --uid-owner 1337 -j ISTIO_IN_REDIRECT  # Envoy loopback
-A ISTIO_OUTPUT -o lo -j RETURN                     # Other loopback
-A ISTIO_OUTPUT -m owner --uid-owner 1337 -j RETURN  # Skip Envoy itself
-A ISTIO_OUTPUT -m owner --gid-owner 1337 -j RETURN  # Skip Envoy group
-A ISTIO_OUTPUT -d 127.0.0.1/32 -j RETURN           # Skip localhost
-A ISTIO_OUTPUT -j ISTIO_REDIRECT
-A ISTIO_REDIRECT -p tcp -j REDIRECT --to-ports 15001
COMMIT
```

### Envoy's SO_ORIGINAL_DST Usage

```yaml
# Envoy listener configuration that uses original_dst cluster
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address:
        address: 0.0.0.0
        port_value: 15001
    use_original_dst: true  # Read original destination from SO_ORIGINAL_DST
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress_http
          route_config:
            name: local_route
            virtual_hosts:
            - name: local_service
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                route:
                  cluster: original_dst_cluster

  clusters:
  - name: original_dst_cluster
    type: ORIGINAL_DST  # Use original destination from SO_ORIGINAL_DST
    connect_timeout: 5s
    lb_policy: CLUSTER_PROVIDED  # Required for ORIGINAL_DST clusters
```

## Implementing a Full Transparent Proxy in Go

```go
package tproxy

import (
    "context"
    "fmt"
    "io"
    "net"
    "os"
    "syscall"
    "time"

    "go.uber.org/zap"
)

type TransparentProxy struct {
    listenPort  int
    logger      *zap.Logger
    interceptFn func(src, dst net.Addr) bool  // Whether to intercept this connection
    transformFn func(conn *ProxyConn) error   // Transform/inspect traffic
}

func NewTransparentProxy(port int, logger *zap.Logger) *TransparentProxy {
    return &TransparentProxy{
        listenPort: port,
        logger:     logger,
        interceptFn: func(src, dst net.Addr) bool { return true }, // Intercept all
    }
}

func (p *TransparentProxy) ListenAndServe(ctx context.Context) error {
    ln, err := CreateTransparentListener(p.listenPort)
    if err != nil {
        return fmt.Errorf("creating transparent listener on port %d: %w", p.listenPort, err)
    }
    defer ln.Close()

    p.logger.Info("transparent proxy listening",
        zap.Int("port", p.listenPort),
    )

    // Close listener when context is cancelled
    go func() {
        <-ctx.Done()
        ln.Close()
    }()

    for {
        proxyConn, err := AcceptTransparent(ln)
        if err != nil {
            if ctx.Err() != nil {
                return nil // Graceful shutdown
            }
            p.logger.Error("accept error", zap.Error(err))
            continue
        }

        go p.handleConnection(ctx, proxyConn)
    }
}

func (p *TransparentProxy) handleConnection(ctx context.Context, proxyConn *ProxyConn) {
    defer proxyConn.Conn.Close()

    src := proxyConn.Conn.RemoteAddr()
    dst := proxyConn.OriginalDst

    p.logger.Debug("intercepted connection",
        zap.String("src", src.String()),
        zap.String("original_dst", dst.String()),
        zap.String("local", proxyConn.LocalAddr.String()),
    )

    if !p.interceptFn(src, dst) {
        // Pass through without interception
        p.passThrough(ctx, proxyConn)
        return
    }

    // Apply transformation (logging, rate limiting, etc.)
    if p.transformFn != nil {
        if err := p.transformFn(proxyConn); err != nil {
            p.logger.Error("transform failed", zap.Error(err))
            return
        }
    }

    // Connect to the original destination
    // Use IP_TRANSPARENT on the upstream connection to appear as the original source
    upstream, err := p.dialTransparent(ctx, src, dst)
    if err != nil {
        p.logger.Error("failed to connect to upstream",
            zap.String("dst", dst.String()),
            zap.Error(err),
        )
        return
    }
    defer upstream.Close()

    // Bidirectional proxy with timeout handling
    p.proxy(ctx, proxyConn.Conn, upstream)
}

// dialTransparent creates an upstream connection that appears to come from the original source
// Requires CAP_NET_ADMIN and IP_TRANSPARENT on the socket
func (p *TransparentProxy) dialTransparent(ctx context.Context, src, dst net.Addr) (*net.TCPConn, error) {
    srcAddr := src.(*net.TCPAddr)
    dstAddr := dst.(*net.TCPAddr)

    d := net.Dialer{
        LocalAddr: srcAddr,  // Spoof source address
        Control: func(network, address string, c syscall.RawConn) error {
            var sockErr error
            c.Control(func(fd uintptr) {
                // IP_TRANSPARENT allows spoofing the source address
                sockErr = syscall.SetsockoptInt(int(fd),
                    syscall.SOL_IP, syscall.IP_TRANSPARENT, 1)
            })
            return sockErr
        },
    }

    conn, err := d.DialContext(ctx, "tcp", dstAddr.String())
    if err != nil {
        return nil, err
    }

    return conn.(*net.TCPConn), nil
}

func (p *TransparentProxy) passThrough(ctx context.Context, proxyConn *ProxyConn) {
    upstream, err := net.Dial("tcp", proxyConn.OriginalDst.String())
    if err != nil {
        p.logger.Error("passthrough dial failed", zap.Error(err))
        return
    }
    defer upstream.Close()
    p.proxy(ctx, proxyConn.Conn, upstream)
}

func (p *TransparentProxy) proxy(ctx context.Context, src, dst net.Conn) {
    done := make(chan struct{}, 2)
    go func() {
        io.Copy(dst, src)
        dst.(*net.TCPConn).CloseWrite()
        done <- struct{}{}
    }()
    go func() {
        io.Copy(src, dst)
        src.(*net.TCPConn).CloseWrite()
        done <- struct{}{}
    }()

    select {
    case <-done:
        <-done // Wait for both directions
    case <-ctx.Done():
    }
}
```

## Debugging with iptables-trace

When transparent proxy isn't working, `iptables` tracing pinpoints where packets are being dropped or mishandled:

```bash
#!/bin/bash
# Enable iptables tracing for a specific connection

TARGET_SRC="10.0.0.1"
TARGET_DST="10.0.0.2"
TARGET_PORT="80"

echo "Enabling iptables trace for ${TARGET_SRC} -> ${TARGET_DST}:${TARGET_PORT}"

# Add TRACE rules (logs every rule the packet matches)
iptables -t raw -A PREROUTING -s ${TARGET_SRC} -d ${TARGET_DST} \
  -p tcp --dport ${TARGET_PORT} -j TRACE

iptables -t raw -A OUTPUT -s ${TARGET_SRC} -d ${TARGET_DST} \
  -p tcp --dport ${TARGET_PORT} -j TRACE

# Trace will appear in kernel log
# Read with dmesg or /var/log/kern.log
dmesg -w | grep "TRACE:"

# Example output:
# [12345.678] TRACE: mangle:PREROUTING:rule:1 IN=eth0 OUT= ... DST=10.0.0.2 DPT=80
# [12345.679] TRACE: mangle:PROXY_IN:rule:1 IN=eth0 OUT= ... DST=10.0.0.2 DPT=80
# [12345.679] TRACE: mangle:PROXY_IN:target:TPROXY ... DPT=80 -> 127.0.0.1:15001

# Remove trace rules when done
iptables -t raw -D PREROUTING -s ${TARGET_SRC} -d ${TARGET_DST} \
  -p tcp --dport ${TARGET_PORT} -j TRACE
iptables -t raw -D OUTPUT -s ${TARGET_SRC} -d ${TARGET_DST} \
  -p tcp --dport ${TARGET_PORT} -j TRACE
```

### Using conntrack for Connection Tracking Debugging

```bash
# Monitor connection tracking for transparent proxy
conntrack -E -p tcp --dport 80

# Expected for TPROXY (connection tracking preserves original dest):
# [NEW] tcp 6 120 SYN_SENT src=10.0.0.1 dst=10.0.0.2 sport=54321 dport=80 [UNREPLIED] src=10.0.0.2 dst=10.0.0.1 sport=80 dport=54321

# For REDIRECT (notice dst changes to 127.0.0.1):
# [NEW] tcp 6 120 SYN_SENT src=10.0.0.1 dst=127.0.0.1 sport=54321 dport=15001 ...
```

## Kubernetes Pod Network Interception Debugging

```bash
#!/bin/bash
# Debug transparent proxy in a Kubernetes pod (requires privileged access)

POD_NAME="my-app-pod"
NAMESPACE="default"

# Get the pod's network namespace
PID=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's|containerd://||' | \
  xargs -I{} crictl inspect {} | \
  jq -r '.info.pid')

echo "Pod PID: ${PID}"

# Run iptables inside the pod's network namespace
nsenter -t ${PID} -n -- iptables-save

# Check routing tables
nsenter -t ${PID} -n -- ip rule list
nsenter -t ${PID} -n -- ip route show table 100 2>/dev/null || echo "No custom routing table"

# Check what's listening on the proxy ports
nsenter -t ${PID} -n -- ss -tlnp | grep -E "15001|15006"

# Enable TRACE for debugging (temporary)
nsenter -t ${PID} -n -- iptables -t raw -A PREROUTING -j TRACE
nsenter -t ${PID} -n -- dmesg | grep TRACE | tail -20
nsenter -t ${PID} -n -- iptables -t raw -D PREROUTING -j TRACE
```

## iptables Alternatives: nftables and eBPF

### nftables TPROXY

```bash
# nftables equivalent of iptables TPROXY rules
# Modern kernels use nftables; Istio still uses iptables-legacy

table ip tproxy {
    chain prerouting {
        type filter hook prerouting priority mangle; policy accept;

        # Skip established connections (performance optimization)
        meta l4proto tcp ct state established,related accept

        # TPROXY to local proxy
        meta l4proto tcp meta mark set 1 tproxy ip to 127.0.0.1:15001
    }

    chain output {
        type route hook output priority mangle; policy accept;

        # Skip proxy traffic
        meta skuid 1337 accept
        meta l4proto tcp meta mark set 1
    }
}

table ip routing {
    chain postrouting {
        type nat hook postrouting priority 0; policy accept;
    }
}
```

### eBPF-Based Transparent Proxy (Ambient Mesh)

Istio's ambient mesh mode uses eBPF instead of iptables for better performance:

```c
// Simplified eBPF program for transparent proxy (illustrative)
// Actual implementation uses tc BPF or socket-level eBPF

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>

SEC("classifier/ingress")
int tproxy_ingress(struct __sk_buff *skb) {
    struct iphdr *ip;
    struct tcphdr *tcp;

    // Parse packet headers
    // ... (bounds checking omitted for brevity)

    // Check if this should be intercepted
    if (tcp->dest == bpf_htons(80) || tcp->dest == bpf_htons(443)) {
        // Mark for TPROXY routing
        skb->mark = 1;

        // Redirect to proxy port 15001
        // bpf_skb_store_bytes to rewrite destination port
        __u16 new_dest = bpf_htons(15001);
        bpf_skb_store_bytes(skb, offsetof(struct tcphdr, dest) + sizeof(struct iphdr) + sizeof(struct ethhdr),
                           &new_dest, sizeof(new_dest), BPF_F_RECOMPUTE_CSUM);
    }

    return TC_ACT_OK;
}
```

## Common Issues and Solutions

### Issue: Proxy Not Receiving Traffic

```bash
# 1. Verify iptables rules are correct
iptables -t mangle -L -v -n | grep -E "TPROXY|REDIRECT"
iptables -t nat -L -v -n | grep REDIRECT

# 2. Verify routing table for TPROXY
ip rule list | grep fwmark
ip route show table 100

# 3. Check if the proxy is listening
ss -tlnp | grep :15001

# 4. Verify IP_TRANSPARENT capability
# The proxy process needs CAP_NET_ADMIN
capsh --print | grep cap_net_admin
# Or check in /proc
cat /proc/$(pgrep proxy)/status | grep Cap
```

### Issue: Connection Refused After TPROXY

```bash
# TPROXY delivers packets to the socket even if the socket isn't
# bound to the destination address. The socket MUST be listening
# on 0.0.0.0 with IP_TRANSPARENT set.

# Check: is the proxy bound correctly?
ss -tlnp | grep :15001
# Expected: 0.0.0.0:15001 (not 127.0.0.1:15001 for TPROXY)

# Check: does the process have IP_TRANSPARENT?
# Run proxy with strace to verify:
strace -e setsockopt -p $(pgrep proxy) 2>&1 | grep IP_TRANSPARENT
```

### Issue: Split Traffic (Some Flows Not Intercepted)

```bash
# Add logging to identify which flows bypass interception
iptables -t mangle -A PREROUTING -p tcp ! -j TPROXY \
  -m comment --comment "flows not intercepted" \
  -j LOG --log-prefix "NOT-TPROXY: "

# Read logs
journalctl -k | grep "NOT-TPROXY:"
```

## Summary

Linux transparent proxy provides the foundation for service mesh traffic interception:

1. **REDIRECT** is simpler but rewrites packet headers and requires LOCAL traffic; `SO_ORIGINAL_DST` recovers the original destination
2. **TPROXY** is more powerful—it preserves original packet headers, works in PREROUTING for forwarded traffic, and enables binding to the original destination via `IP_TRANSPARENT`
3. **IP_TRANSPARENT** socket option allows a process to bind to IPs that don't belong to the local machine, enabling true transparent proxying
4. **Envoy/Istio** combine iptables REDIRECT/TPROXY with Envoy's `use_original_dst` and `ORIGINAL_DST` cluster type to implement transparent service mesh interception
5. **iptables TRACE** in the raw table provides packet-level visibility when debugging interception issues
6. **eBPF** (ambient mesh) provides a cleaner path with better performance by eliminating the iptables overhead entirely

Understanding these mechanisms is essential for debugging service mesh connectivity, implementing custom traffic policies, and understanding why security policies behave differently inside Kubernetes pods versus on bare metal.
