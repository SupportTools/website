---
title: "Linux Transparent Proxy and Traffic Interception with iptables and TPROXY"
date: 2030-07-28T00:00:00-05:00
draft: false
tags: ["Linux", "iptables", "TPROXY", "Networking", "Service Mesh", "Istio", "Envoy"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise transparent proxy guide covering iptables TPROXY target, policy routing, traffic redirection for service mesh sidecars, Istio and Envoy traffic capture internals, and debugging transparent proxy configurations."
more_link: "yes"
url: "/linux-transparent-proxy-tproxy-iptables-traffic-interception/"
---

Transparent proxying is the mechanism that allows a proxy process to intercept network traffic without the original endpoints being aware of the interception. It is the foundational technology behind service mesh sidecars, Kubernetes CNI traffic steering, and enterprise web filtering appliances. Understanding how iptables TPROXY, policy routing, and Linux network namespaces compose to enable transparent proxying is essential for debugging service mesh behavior, designing custom traffic interception solutions, and troubleshooting network issues in Kubernetes environments.

<!--more-->

## Transparent Proxy Fundamentals

A transparent proxy intercepts traffic that was not originally destined for it. The key challenge is that when a proxy receives a transparently redirected packet, it must know the original destination to connect to the upstream server on behalf of the client.

### Two Interception Mechanisms

**REDIRECT target**: Redirects packets to a local port by rewriting the destination IP to `127.0.0.1` (or the primary interface IP). The proxy cannot learn the original destination from the socket's `getsockname()` — it must use `SO_ORIGINAL_DST` to recover it. Works only for outbound traffic from the same network namespace.

**TPROXY target**: The more powerful mechanism. TPROXY marks packets and assigns them to a local socket without modifying the destination address. The proxy socket receives the packet with the original destination intact, visible via `getsockname()`. Required for traffic that is being forwarded (not locally originated).

## TPROXY Architecture

TPROXY operates in the `PREROUTING` chain (before routing decisions) and works in two steps:

1. Mark incoming packets with a routing mark
2. Use policy routing to redirect marked packets to the local machine (lo interface)

```
External packet → PREROUTING → TPROXY mark → Policy route → Local socket
                                                              (original dst preserved)
```

### Kernel Requirements

```bash
# Verify TPROXY support
lsmod | grep xt_TPROXY
modprobe xt_TPROXY

# Verify IP_TRANSPARENT socket option support
zcat /proc/config.gz | grep -E "CONFIG_NETFILTER_XT_TARGET_TPROXY|CONFIG_NF_TPROXY"
# Expected: CONFIG_NETFILTER_XT_TARGET_TPROXY=m or =y

# Required for marking and policy routing
modprobe ip_tables
modprobe xt_mark
modprobe xt_socket
```

## Basic TPROXY Configuration

### Setting Up TPROXY for TCP Interception

This example intercepts all TCP traffic destined for port 80 and 443 and redirects it to a local proxy on port 8080:

```bash
# Step 1: Create routing table entry for TPROXY-marked packets
# Mark value 1 → route via loopback to capture locally
echo "1 proxy_table" >> /etc/iproute2/rt_tables

# Add a route in table 100 that routes everything to local
ip rule add fwmark 1 lookup 100
ip route add local 0.0.0.0/0 dev lo table 100

# Step 2: iptables PREROUTING rule to apply TPROXY
# Only for forwarded packets (not locally generated)
iptables -t mangle -A PREROUTING \
    -p tcp \
    --dport 80 \
    -j TPROXY \
    --tproxy-mark 0x1/0x1 \
    --on-port 8080 \
    --on-ip 127.0.0.1

iptables -t mangle -A PREROUTING \
    -p tcp \
    --dport 443 \
    -j TPROXY \
    --tproxy-mark 0x1/0x1 \
    --on-port 8080 \
    --on-ip 127.0.0.1

# Step 3: Mark locally-originating traffic for the proxy
# (For intercepting outbound traffic from local processes)
iptables -t mangle -A OUTPUT \
    -p tcp \
    --dport 80 \
    -j MARK \
    --set-mark 0x1

iptables -t mangle -A OUTPUT \
    -p tcp \
    --dport 443 \
    -j MARK \
    --set-mark 0x1
```

### TPROXY Socket in Go

A Go proxy that listens as a TPROXY socket must set `IP_TRANSPARENT` to receive non-local traffic:

```go
// cmd/tproxy/main.go
package main

import (
    "fmt"
    "log"
    "net"
    "syscall"
)

// listenTProxy creates a TCP listener with IP_TRANSPARENT set,
// enabling it to accept connections with non-local destination addresses.
func listenTProxy(addr string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, conn syscall.RawConn) error {
            var setsockoptErr error
            err := conn.Control(func(fd uintptr) {
                // IP_TRANSPARENT allows binding to non-local addresses
                // and receiving packets with non-local destinations
                setsockoptErr = syscall.SetsockoptInt(
                    int(fd),
                    syscall.SOL_IP,
                    syscall.IP_TRANSPARENT,
                    1,
                )
            })
            if err != nil {
                return err
            }
            return setsockoptErr
        },
    }

    return lc.Listen(nil, "tcp", addr) // context omitted for brevity
}

// getOriginalDst retrieves the original destination address from a TPROXY socket.
// With TPROXY, the original destination is preserved and visible via getsockname.
func getOriginalDst(conn net.Conn) (net.Addr, error) {
    // With TPROXY, the local address IS the original destination
    return conn.LocalAddr(), nil
}

func handleConnection(conn net.Conn) {
    defer conn.Close()

    origDst, err := getOriginalDst(conn)
    if err != nil {
        log.Printf("failed to get original destination: %v", err)
        return
    }

    srcAddr := conn.RemoteAddr()
    log.Printf("intercepted connection: src=%s original_dst=%s", srcAddr, origDst)

    // Connect to the original destination on behalf of the client
    upstream, err := net.Dial("tcp", origDst.String())
    if err != nil {
        log.Printf("failed to connect upstream %s: %v", origDst, err)
        return
    }
    defer upstream.Close()

    // Relay traffic bidirectionally
    done := make(chan struct{}, 2)
    go func() {
        copyAndClose(upstream, conn)
        done <- struct{}{}
    }()
    go func() {
        copyAndClose(conn, upstream)
        done <- struct{}{}
    }()
    <-done
}

func main() {
    ln, err := listenTProxy("0.0.0.0:8080")
    if err != nil {
        log.Fatalf("listen failed: %v", err)
    }
    log.Printf("TPROXY listener on %s", ln.Addr())

    for {
        conn, err := ln.Accept()
        if err != nil {
            log.Printf("accept error: %v", err)
            continue
        }
        go handleConnection(conn)
    }
}
```

## Istio Traffic Capture Internals

Istio uses REDIRECT (not TPROXY by default) to capture traffic in sidecar-injected pods. Understanding the iptables rules istio-init sets up is essential for debugging.

### Istio iptables Rules

When a pod has the Istio sidecar injected, the `istio-init` initContainer runs before the application starts and sets up iptables rules:

```bash
# View Istio's iptables rules (run inside a pod with the sidecar)
kubectl exec -n production deploy/myapp -c istio-proxy -- \
    iptables-save

# Key rules added by istio-init:

# Redirect inbound traffic to Envoy's inbound port (15006)
# -A PREROUTING -p tcp -j ISTIO_INBOUND
# -A ISTIO_INBOUND -p tcp --dport 15008 -j RETURN  (skip tunneling port)
# -A ISTIO_INBOUND -p tcp -j ISTIO_IN_REDIRECT
# -A ISTIO_IN_REDIRECT -p tcp -j REDIRECT --to-ports 15006

# Redirect outbound traffic to Envoy's outbound port (15001)
# -A OUTPUT -p tcp -j ISTIO_OUTPUT
# -A ISTIO_OUTPUT ! -d 127.0.0.1/32 -o lo -j ISTIO_IN_REDIRECT  (loopback to inbound)
# -A ISTIO_OUTPUT -m owner --uid-owner 1337 -j RETURN  (skip Envoy's own traffic)
# -A ISTIO_OUTPUT -m owner --gid-owner 1337 -j RETURN  (skip Envoy's own traffic)
# -A ISTIO_OUTPUT -d 127.0.0.1/32 -j RETURN            (skip localhost)
# -A ISTIO_OUTPUT -j ISTIO_REDIRECT
# -A ISTIO_REDIRECT -p tcp -j REDIRECT --to-ports 15001
```

The critical detail: Envoy runs as UID 1337. The `--uid-owner 1337` RETURN rules prevent infinite redirection loops — Envoy's own traffic is not captured again.

### Recovering Original Destination with REDIRECT

With REDIRECT (not TPROXY), the original destination is rewritten. Envoy and Go applications recover it using `SO_ORIGINAL_DST`:

```go
// Recovering original destination from a REDIRECT-intercepted connection
package proxy

import (
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

type sockaddrStorage struct {
    ss_family uint16
    ss_data   [126]byte
}

func getSOOriginalDst(conn *net.TCPConn) (net.TCPAddr, error) {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return net.TCPAddr{}, err
    }

    var origDst net.TCPAddr
    var sockErr error

    err = rawConn.Control(func(fd uintptr) {
        var addr syscall.RawSockaddrInet4
        size := uint32(unsafe.Sizeof(addr))
        err := getsockopt(int(fd), syscall.SOL_IP, syscall.SO_ORIGINAL_DST,
            unsafe.Pointer(&addr), &size)
        if err != nil {
            sockErr = fmt.Errorf("getsockopt SO_ORIGINAL_DST: %w", err)
            return
        }
        origDst = net.TCPAddr{
            IP:   net.IP(addr.Addr[:]),
            Port: int(addr.Port>>8 | addr.Port<<8), // network byte order
        }
    })
    if err != nil {
        return net.TCPAddr{}, err
    }
    return origDst, sockErr
}

func getsockopt(fd int, level, opt int, optval unsafe.Pointer, optlen *uint32) error {
    _, _, errno := syscall.Syscall6(
        syscall.SYS_GETSOCKOPT,
        uintptr(fd),
        uintptr(level),
        uintptr(opt),
        uintptr(optval),
        uintptr(unsafe.Pointer(optlen)),
        0,
    )
    if errno != 0 {
        return errno
    }
    return nil
}
```

## Policy Routing for Traffic Steering

Policy routing allows traffic to be routed based on criteria beyond the destination IP, including source IP, incoming interface, and packet mark.

### Multiple Routing Tables

```bash
# View current routing tables
ip rule list

# Typical output on a fresh system:
# 0:      from all lookup local
# 32766:  from all lookup main
# 32767:  from all lookup default

# Add a rule: traffic marked 0x2 uses table 200
ip rule add fwmark 0x2/0x2 priority 1000 table 200

# Add routes to table 200
ip route add default via 192.168.100.1 table 200
ip route add 10.0.0.0/8 via 192.168.1.1 table 200

# Route specific source subnet through a specific gateway
ip rule add from 10.10.20.0/24 priority 500 table 300
ip route add default via 172.16.0.1 table 300
```

### VRF-Based Traffic Isolation

For more sophisticated traffic isolation, Linux VRFs (Virtual Routing and Forwarding) provide separate routing tables per VRF device:

```bash
# Create a VRF for a proxy tenant
ip link add name vrf-proxy type vrf table 400
ip link set dev vrf-proxy up

# Assign an interface to the VRF
ip link set dev eth1 master vrf-proxy

# Routes in VRF context
ip route add default via 10.20.0.1 vrf vrf-proxy
ip route add 192.168.0.0/16 unreachable vrf vrf-proxy

# VRF-aware socket binding
# Applications can bind to a VRF with SO_BINDTODEVICE
```

## Service Mesh Sidecar Traffic Interception in Kubernetes

### Network Namespace Isolation

Each Kubernetes pod has its own network namespace. The init container runs in this namespace and configures iptables rules that affect only the pod's traffic:

```bash
# Find the network namespace of a pod
POD_NAME=myapp-7d8b9c4f6-xkpjm
NAMESPACE=production

# Get the PID of the pause container (shares the net namespace)
PAUSE_PID=$(kubectl get pod $POD_NAME -n $NAMESPACE \
    -o jsonpath='{.status.containerStatuses[0].containerID}' | \
    xargs -I{} crictl inspect {} | \
    jq -r '.info.pid')

# Enter the pod's network namespace
nsenter -t $PAUSE_PID -n -- iptables -t nat -L -v -n

# View routing in the pod's namespace
nsenter -t $PAUSE_PID -n -- ip route
nsenter -t $PAUSE_PID -n -- ip rule list
```

### Custom CNI Traffic Steering

For custom service mesh implementations, CNI plugins can inject iptables rules at pod creation:

```go
// cni/plugin.go - simplified example
package main

import (
    "encoding/json"
    "fmt"
    "os"

    "github.com/containernetworking/cni/pkg/skel"
    "github.com/containernetworking/cni/pkg/types"
    "github.com/vishvananda/netlink"
    "github.com/vishvananda/netns"
)

type PluginConf struct {
    types.NetConf
    ProxyPort    int    `json:"proxy_port"`
    ProxyUID     int    `json:"proxy_uid"`
    InboundPort  int    `json:"inbound_port"`
    OutboundPort int    `json:"outbound_port"`
}

func setupIPTables(conf *PluginConf, netNS netns.NsHandle) error {
    return netns.Do(netNS, func(_ netns.NsHandle) error {
        rules := [][]string{
            // Redirect inbound to proxy inbound port
            {"-t", "nat", "-A", "PREROUTING",
                "-p", "tcp",
                "-j", "REDIRECT",
                "--to-ports", fmt.Sprintf("%d", conf.InboundPort)},
            // Redirect outbound to proxy outbound port, skip proxy user
            {"-t", "nat", "-A", "OUTPUT",
                "-p", "tcp",
                "!", "--uid-owner", fmt.Sprintf("%d", conf.ProxyUID),
                "-j", "REDIRECT",
                "--to-ports", fmt.Sprintf("%d", conf.OutboundPort)},
        }

        for _, rule := range rules {
            if err := runIPTables(rule...); err != nil {
                return fmt.Errorf("iptables rule %v: %w", rule, err)
            }
        }
        return nil
    })
}
```

### Istio TPROXY Mode (Ambient)

Istio Ambient Mesh uses TPROXY for L4 traffic interception in ztunnels, bypassing the per-pod iptables approach:

```bash
# Istio Ambient ztunnel uses TPROXY on the node for L4 interception
# Mark inbound packets for ztunnel
iptables -t mangle -A PREROUTING \
    -m mark ! --mark 0x539/0xfff \
    -m comment --comment "Istio Ambient L4 inbound" \
    -j TPROXY \
    --tproxy-mark 0x539/0xfff \
    --on-port 15008 \
    --on-ip 127.0.0.1

# Policy route for marked packets
ip rule add fwmark 0x539/0xfff lookup 133
ip route add local 0.0.0.0/0 dev lo table 133
```

## UDP TPROXY

TPROXY also supports UDP traffic interception, critical for DNS and other UDP-based services:

```bash
# UDP TPROXY for DNS interception (port 53)
iptables -t mangle -A PREROUTING \
    -p udp \
    --dport 53 \
    -j TPROXY \
    --tproxy-mark 0x1/0x1 \
    --on-port 5300 \
    --on-ip 127.0.0.1
```

Go UDP TPROXY server:

```go
// udp_tproxy.go
package main

import (
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

func listenUDPTProxy(addr string) (*net.UDPConn, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, conn syscall.RawConn) error {
            return conn.Control(func(fd uintptr) {
                // IP_TRANSPARENT for non-local destination
                syscall.SetsockoptInt(int(fd), syscall.SOL_IP, syscall.IP_TRANSPARENT, 1)
                // IP_RECVORIGDSTADDR to get original destination per packet
                syscall.SetsockoptInt(int(fd), syscall.SOL_IP, syscall.IP_RECVORIGDSTADDR, 1)
            })
        },
    }

    pc, err := lc.ListenPacket(nil, "udp", addr)
    if err != nil {
        return nil, err
    }
    return pc.(*net.UDPConn), nil
}
```

## Debugging Transparent Proxy Configurations

### Systematic Debugging Approach

```bash
# 1. Verify iptables rules are applied
iptables -t mangle -L PREROUTING -v -n
iptables -t nat -L PREROUTING -v -n
iptables -t nat -L OUTPUT -v -n

# 2. Verify policy routing rules
ip rule list
ip route show table 100  # Check TPROXY routing table

# 3. Verify the proxy is listening
ss -tlnp | grep 8080
ss -tnp | grep 8080  # Active connections

# 4. Check packet marking
# Send a test packet and watch marks
iptables -t mangle -A PREROUTING \
    -p tcp --dport 80 \
    -j LOG --log-prefix "TPROXY-MARK: " --log-level 7
# Watch kernel log
dmesg -w | grep TPROXY-MARK

# 5. Trace a packet through the netfilter framework
iptables -t raw -A PREROUTING \
    -p tcp --dport 80 -s <client-ip> \
    -j TRACE
modprobe nf_log_ipv4
iptables -t raw -A OUTPUT \
    -p tcp --dport 80 \
    -j TRACE
# View trace
cat /proc/net/netfilter/nf_log

# 6. Use conntrack to verify connection tracking
conntrack -L -p tcp --dport 80
conntrack -E -p tcp --dport 80  # Watch events
```

### Common TPROXY Pitfalls

**Pitfall 1: Missing IP_TRANSPARENT on the proxy socket**

Symptom: Connection refused on the proxy port even though iptables rules are correct.

```bash
# Verify the proxy socket has IP_TRANSPARENT
ss -tnpoe | grep 8080
# Look for "transparent" in options

# If not present, check the application's socket setup
strace -f -e trace=setsockopt myproxy 2>&1 | grep IP_TRANSPARENT
```

**Pitfall 2: Policy route not applied**

Symptom: Marked packets are not routed to the proxy socket.

```bash
# Verify the rule exists
ip rule show | grep "fwmark 0x1"

# Verify the route exists in the target table
ip route show table 100

# Test with a packet
ping -m 1 -I eth0 8.8.8.8  # -m sets the mark
# Should route via table 100
```

**Pitfall 3: Asymmetric routing breaking TPROXY**

TPROXY requires packets to traverse both PREROUTING and the return path through the same interface. If packets arrive on eth0 but replies go out eth1, TPROXY fails.

```bash
# Enable reverse path filtering to catch asymmetric routing
echo 1 > /proc/sys/net/ipv4/conf/all/rp_filter

# Or disable it for TPROXY interfaces (TPROXY requires rp_filter=0 or =2)
echo 0 > /proc/sys/net/ipv4/conf/eth0/rp_filter
```

**Pitfall 4: Conntrack interference**

Connection tracking can cause TPROXY to fail if connections are already tracked:

```bash
# Exclude TPROXY-bound traffic from conntrack
iptables -t raw -A PREROUTING \
    -p tcp --dport 80 \
    -j NOTRACK

iptables -t raw -A OUTPUT \
    -p tcp --sport 80 \
    -j NOTRACK
```

**Pitfall 5: Kubernetes pod TPROXY with network namespace isolation**

When running TPROXY rules inside a Kubernetes pod (not on the node), ip rules are namespace-scoped but routing tables are shared:

```bash
# Each network namespace has its own ip rule table
# BUT routes must be set up in the namespace too
# Run inside the pod:
ip rule add fwmark 1 lookup 100
ip route add local 0.0.0.0/0 dev lo table 100

# Verify namespace-scoped rules
nsenter -t <pid> -n -- ip rule list
nsenter -t <pid> -n -- ip route show table 100
```

### tcpdump for TPROXY Verification

```bash
# Capture on the loopback (where TPROXY delivers packets)
tcpdump -i lo -nn port 8080

# Capture with original destination visible (before NAT)
# Use the mangle table marker
tcpdump -i any -nn 'tcp and dst port 80'

# Capture inside a pod's network namespace
PID=$(docker inspect --format '{{.State.Pid}}' <container-id>)
nsenter -t $PID -n -- tcpdump -i any -nn port 80

# Capture in a Kubernetes pod
kubectl exec -n production deploy/myapp -- \
    tcpdump -i any -nn -w /tmp/capture.pcap port 80
kubectl cp production/myapp-xxx:/tmp/capture.pcap ./capture.pcap
tcpdump -r capture.pcap -nn
```

## Performance Considerations

### TPROXY vs REDIRECT Performance

TPROXY has slightly lower overhead than REDIRECT because it avoids NAT address rewriting:

```bash
# Benchmark with netperf
netperf -H target -t TCP_STREAM -l 30 -- -m 65536
# Compare with and without TPROXY rules

# Monitor netfilter performance
cat /proc/net/stat/nf_conntrack
# Watch conntrack_insert_failed for connection tracking issues

# Monitor iptables rule matching rate
iptables -t mangle -L PREROUTING -v -n --line-numbers
# Watch the 'pkts' and 'bytes' columns
```

### Reducing iptables Rule Overhead

For high-throughput environments, minimize iptables rule count and use ipset for IP-based matching:

```bash
# Create ipset for services to intercept
ipset create intercept-services hash:net
ipset add intercept-services 10.96.0.0/12  # Kubernetes service CIDR

# Single iptables rule referencing the ipset
iptables -t mangle -A PREROUTING \
    -p tcp \
    -m set --match-set intercept-services dst \
    -j TPROXY \
    --tproxy-mark 0x1/0x1 \
    --on-port 15001 \
    --on-ip 127.0.0.1
```

## Summary

Linux transparent proxying with TPROXY provides a powerful, low-overhead mechanism for intercepting and redirecting network traffic without modifying packet headers. The combination of iptables TPROXY rules, policy routing, and IP_TRANSPARENT socket options enables the seamless traffic capture that powers service meshes like Istio. Understanding the distinction between REDIRECT (NAT-based, uses SO_ORIGINAL_DST) and TPROXY (mark-based, preserves original destination), along with common failure modes around routing table configuration, rp_filter settings, and conntrack interference, is essential for diagnosing the inevitable networking issues that arise in complex Kubernetes environments.
