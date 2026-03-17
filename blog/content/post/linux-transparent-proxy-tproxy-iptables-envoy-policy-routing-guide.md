---
title: "Linux Transparent Proxy with TPROXY: iptables TPROXY Target, SO_TRANSPARENT, Envoy Interception, and Policy Routing"
date: 2031-12-13T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "TPROXY", "iptables", "Envoy", "Service Mesh", "Transparent Proxy", "Policy Routing", "Kernel Networking"]
categories: ["Linux", "Networking", "Service Mesh"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux transparent proxying with the TPROXY iptables target, SO_TRANSPARENT socket option, policy routing with ip rule and ip route, and the complete Envoy sidecar interception setup used in service meshes like Istio and Linkerd."
more_link: "yes"
url: "/linux-transparent-proxy-tproxy-iptables-envoy-policy-routing-guide/"
---

Transparent proxying — redirecting network traffic to a proxy without modifying the original IP addresses — is the foundational networking mechanism behind every service mesh sidecar, network-level firewall, and TLS inspection system. Understanding how TPROXY works at the kernel level is essential for debugging service mesh routing failures, implementing custom network policies, and building your own traffic interception systems. This guide covers the complete stack: iptables TPROXY target, the SO_TRANSPARENT socket option, policy routing with ip rule/ip route, and the exact setup Istio uses to intercept pod traffic.

<!--more-->

# Linux Transparent Proxy with TPROXY

## Network Namespaces and the Interception Problem

When a Kubernetes pod with an Envoy sidecar sends a packet to `10.0.0.5:8080`, the desired behavior is:

1. Packet leaves the application container (PID namespace)
2. Envoy intercepts it WITHOUT the original destination address being changed
3. Envoy applies policy (mTLS, retries, circuit breaking)
4. Envoy forwards to the actual destination

There are two interception mechanisms:
- **REDIRECT**: Changes the destination IP/port to localhost:15001. The original destination is recoverable via `SO_ORIGINAL_DST`.
- **TPROXY**: Delivers packets to the proxy with the ORIGINAL destination address preserved. The proxy sees `dst=10.0.0.5:8080`, not `dst=127.0.0.1:15001`.

TPROXY is architecturally cleaner and required for UDP interception.

## Kernel Prerequisites

```bash
# Verify TPROXY kernel module is loaded
lsmod | grep -i tproxy
# xt_TPROXY             16384  2

# Load if not present
modprobe xt_TPROXY

# Verify iptables has TPROXY target support
iptables -t mangle -j TPROXY --help 2>&1 | head -5

# Verify ip route/rule commands are available
ip rule help 2>&1 | head -3
ip route help 2>&1 | head -3

# Kernel config requirements (for custom kernels):
# CONFIG_NETFILTER_XT_TARGET_TPROXY=m
# CONFIG_IP_NF_MANGLE=m
# CONFIG_NETFILTER_NETLINK=y
```

## TPROXY Theory: What Happens to Packets

### Standard Packet Flow (No Proxy)

```
app sends TCP SYN to 10.0.0.5:8080
  --> skb: src=pod-ip:ephemeral  dst=10.0.0.5:8080
  --> routing: via eth0
  --> leaves pod network namespace
```

### REDIRECT Flow (Original-Dst Recovery)

```
app sends TCP SYN to 10.0.0.5:8080
  --> iptables OUTPUT: -j REDIRECT --to-port 15001
  --> skb: src=pod-ip:ephemeral  dst=127.0.0.1:15001  (modified!)
  --> proxy receives SYN to 127.0.0.1:15001
  --> proxy calls getsockopt(SO_ORIGINAL_DST) -> recovers 10.0.0.5:8080
```

Problem: SO_ORIGINAL_DST only works for TCP. UDP has no connection state.

### TPROXY Flow (Original Addresses Preserved)

```
app sends UDP/TCP packet to 10.0.0.5:8080
  --> iptables PREROUTING mangle: -j TPROXY --tproxy-mark 0x1/0x1 --on-port 15001
  --> packet marked 0x1, NOT modified
  --> ip rule: fwmark 0x1 lookup table 100
  --> table 100: 0.0.0.0/0 via local  (all traffic delivered locally)
  --> kernel delivers to proxy listening with IP_TRANSPARENT on 0.0.0.0:15001
  --> proxy sees: src=app-ip:port  dst=10.0.0.5:8080  (original addresses!)
```

## Step-by-Step TPROXY Setup

### Step 1: Policy Routing Table

TPROXY requires a special routing table that routes ALL traffic to the local machine:

```bash
# Create routing table 100 (or any unused number in /etc/iproute2/rt_tables)
# Add to /etc/iproute2/rt_tables
echo "100 tproxy" >> /etc/iproute2/rt_tables

# Add a route in table 100: all packets go to local (lo interface)
ip route add local 0.0.0.0/0 dev lo table tproxy

# Verify
ip route show table tproxy
# local 0.0.0.0/0 dev lo scope host

# Add an ip rule: if packet has fwmark 0x1, use table tproxy
ip rule add fwmark 0x1 lookup tproxy priority 100

# Verify
ip rule show | grep tproxy
# 100: from all fwmark 0x1 lookup tproxy
```

### Step 2: iptables TPROXY Rules

```bash
# Create a chain for TPROXY rules
iptables -t mangle -N TPROXY_INTERCEPT

# Intercept inbound traffic to specific ports (PREROUTING only — not OUTPUT)
# -j TPROXY sets the mark AND redirects to local socket
iptables -t mangle -A TPROXY_INTERCEPT \
  -p tcp \
  ! -s 127.0.0.1 \
  -j TPROXY \
  --tproxy-mark 0x1/0x1 \
  --on-ip 127.0.0.1 \
  --on-port 15001

# Apply to PREROUTING
iptables -t mangle -A PREROUTING -j TPROXY_INTERCEPT

# For outbound traffic, we need OUTPUT + MARK (not TPROXY in OUTPUT)
iptables -t mangle -N TPROXY_MARK_OUTBOUND

iptables -t mangle -A TPROXY_MARK_OUTBOUND \
  -p tcp \
  ! -d 127.0.0.1 \
  ! -d <pod-cidr> \
  -j MARK --set-mark 0x1

# Apply to OUTPUT for outbound packet interception
iptables -t mangle -A OUTPUT -j TPROXY_MARK_OUTBOUND
```

### Step 3: Socket with SO_TRANSPARENT

The proxy must bind its socket with `IP_TRANSPARENT` to receive packets with non-local destination addresses:

```c
// tproxy-listener.c — Minimal example of a TPROXY-aware listener
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

int main(void) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) { perror("socket"); exit(1); }

    int one = 1;

    // SO_REUSEADDR: allow re-binding immediately after restart
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    // IP_TRANSPARENT: receive packets not destined for this host
    // Requires CAP_NET_ADMIN or running as root
    if (setsockopt(sock, IPPROTO_IP, IP_TRANSPARENT, &one, sizeof(one)) < 0) {
        perror("setsockopt IP_TRANSPARENT");
        exit(1);
    }

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(15001),
        .sin_addr   = { .s_addr = INADDR_ANY },  // 0.0.0.0
    };

    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind"); exit(1);
    }

    listen(sock, 1024);
    printf("TPROXY listener ready on :15001\n");

    while (1) {
        struct sockaddr_in client_addr, orig_dst_addr;
        socklen_t addrlen = sizeof(client_addr);

        int client = accept(sock, (struct sockaddr*)&client_addr, &addrlen);
        if (client < 0) { perror("accept"); continue; }

        // The accepted socket's LOCAL address is the ORIGINAL destination
        // (because IP_TRANSPARENT + routing table delivers it with original dst)
        socklen_t dst_len = sizeof(orig_dst_addr);
        getsockname(client, (struct sockaddr*)&orig_dst_addr, &dst_len);

        printf("Connection from %s:%d to %s:%d (original destination)\n",
            inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port),
            inet_ntoa(orig_dst_addr.sin_addr), ntohs(orig_dst_addr.sin_port));

        // At this point you have:
        // - client_addr: the real source IP:port
        // - orig_dst_addr: the ORIGINAL destination IP:port
        // The proxy can now establish a new connection to orig_dst_addr

        close(client);
    }
}
```

```bash
# Compile and run (requires root or CAP_NET_ADMIN + CAP_NET_RAW)
gcc -O2 -o tproxy-listener tproxy-listener.c
sudo ./tproxy-listener
```

## Istio/Envoy TPROXY Mode

### Istio Init Container Setup

Istio's `istio-init` container runs iptables rules to redirect pod traffic to Envoy. In TPROXY mode (as opposed to default REDIRECT mode):

```bash
#!/usr/bin/env bash
# istio-iptables-tproxy.sh — Simplified version of Istio's init container logic
# This runs inside the pod's network namespace

set -e

PROXY_UID=1337    # Envoy runs as this UID
PROXY_PORT=15001  # Envoy's inbound TPROXY listener
PROXY_OUTBOUND_PORT=15001
INBOUND_CAPTURE_PORTS="*"  # Capture all ports
EXCLUDE_OUTBOUND_PORTS="15090,15021,15020"  # Exclude Envoy's own ports

echo "Setting up TPROXY-based traffic interception"

# Step 1: Routing table
ip rule add fwmark 1337 lookup 133
ip route add local 0.0.0.0/0 dev lo table 133

# Step 2: Inbound interception (PREROUTING)
# Mark and redirect inbound packets NOT from Envoy
iptables -t mangle -N ISTIO_INBOUND
iptables -t mangle -A PREROUTING -j ISTIO_INBOUND

# Don't intercept traffic from Envoy itself (avoids loops)
iptables -t mangle -A ISTIO_INBOUND -p tcp -m conntrack --ctstate ESTABLISHED -j ACCEPT
iptables -t mangle -A ISTIO_INBOUND -p tcp \
  ! -m owner --uid-owner "${PROXY_UID}" \
  -j TPROXY \
  --tproxy-mark 1337/0xffffffff \
  --on-port "${PROXY_PORT}"

# Step 3: Outbound interception (OUTPUT)
iptables -t mangle -N ISTIO_OUTPUT
iptables -t mangle -A OUTPUT -j ISTIO_OUTPUT

# Don't intercept Envoy's own traffic (avoids loops)
iptables -t mangle -A ISTIO_OUTPUT -m owner --uid-owner "${PROXY_UID}" -j RETURN

# Don't intercept loopback
iptables -t mangle -A ISTIO_OUTPUT -o lo -j RETURN

# Don't intercept Envoy management ports
for port in $(echo "${EXCLUDE_OUTBOUND_PORTS}" | tr ',' ' '); do
    iptables -t mangle -A ISTIO_OUTPUT -p tcp --dport "${port}" -j RETURN
done

# Mark all remaining outbound traffic for re-routing
iptables -t mangle -A ISTIO_OUTPUT -p tcp -j MARK --set-mark 1337

echo "TPROXY interception configured"

# Verify
echo ""
echo "ip rules:"
ip rule show | grep 133

echo ""
echo "routing table 133:"
ip route show table 133

echo ""
echo "iptables mangle:"
iptables -t mangle -L -n -v
```

### Envoy Configuration for TPROXY

```yaml
# envoy-tproxy-listener.yaml
static_resources:
  listeners:
    - name: tproxy_inbound_listener
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 15001
      listener_filters:
        # ORIGINAL_DST listener filter reads the original destination
        # from the socket's local address (set by TPROXY + routing table)
        - name: envoy.filters.listener.original_dst
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.original_dst.v3.OriginalDst
      use_original_dst: true   # Pass connections to correct FilterChain based on original dst
      transparent: true        # Bind with IP_TRANSPARENT
      freebind: true           # Bind to addresses not yet assigned to the host
      filter_chains:
        - filter_chain_match:
            destination_port: 8080
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: inbound_8080
                route_config:
                  virtual_hosts:
                    - name: local_service
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          route:
                            cluster: local_app_8080
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
```

## UDP Transparent Proxying

TPROXY excels at UDP interception, which REDIRECT cannot handle:

```bash
# UDP TPROXY interception
iptables -t mangle -A PREROUTING \
  -p udp \
  ! -s 127.0.0.1 \
  -j TPROXY \
  --tproxy-mark 0x1/0x1 \
  --on-ip 127.0.0.1 \
  --on-port 15001
```

```c
// udp-tproxy-listener.c — UDP transparent proxy socket
#include <sys/socket.h>
#include <netinet/in.h>
#include <linux/in.h>

int udp_tproxy_socket(uint16_t port) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    int one = 1;

    setsockopt(sock, IPPROTO_IP, IP_TRANSPARENT, &one, sizeof(one));
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    // IP_RECVORIGDSTADDR: receive original destination in control message
    setsockopt(sock, IPPROTO_IP, IP_RECVORIGDSTADDR, &one, sizeof(one));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(port),
        .sin_addr   = { .s_addr = INADDR_ANY },
    };
    bind(sock, (struct sockaddr*)&addr, sizeof(addr));

    return sock;
}

// To read original destination for UDP:
// Use recvmsg() with cmsg, look for IP_ORIGDSTADDR in control messages
```

## Debugging TPROXY Issues

### Common Failure: Rules Applied but No Traffic Intercepted

```bash
# 1. Verify the routing table exists and has the local route
ip route show table 133
# Expected: local 0.0.0.0/0 dev lo scope host

# 2. Verify ip rule is present
ip rule show
# Expected: 100: from all fwmark 0x1 lookup 133

# 3. Verify iptables rules are matching
iptables -t mangle -L PREROUTING -n -v
# Check packet counter is incrementing

# 4. Test with a probe
# Send a SYN to a non-local address and watch if it appears on lo
tcpdump -i lo host 10.0.0.5 -n
# Should see packets if TPROXY is working

# 5. Check if proxy has IP_TRANSPARENT
ss -tnlp | grep 15001
# Verify listening socket
# In /proc/<pid>/net/tcp, the socket should show 0.0.0.0:15001
```

### Common Failure: "Operation not permitted" on SO_TRANSPARENT

```bash
# The process needs CAP_NET_ADMIN
# In Kubernetes, the sidecar init container needs:
securityContext:
  capabilities:
    add:
      - NET_ADMIN
      - NET_RAW
  runAsNonRoot: false  # TPROXY setup requires root or specific capabilities
```

### Verifying TPROXY in Kubernetes Pod

```bash
# Exec into the pod and check the interception rules
kubectl exec -it my-pod -c istio-proxy -- sh

# Inside the pod:
iptables -t mangle -L -n -v
ip rule show
ip route show table 133

# Watch TPROXY marks being applied
watch -n1 'iptables -t mangle -L ISTIO_OUTPUT -n -v --line-numbers | head -20'
```

### Packet-Level Debugging with nftables

Modern distributions use nftables. Equivalent TPROXY rules:

```bash
# nftables equivalent of iptables TPROXY
cat > /etc/nftables-tproxy.conf << 'EOF'
table ip tproxy_table {
    chain prerouting {
        type filter hook prerouting priority mangle;

        # Skip established connections
        meta l4proto tcp ct state established accept

        # Apply TPROXY for new TCP connections
        meta l4proto tcp tproxy ip to 127.0.0.1:15001
        meta mark set 0x1
    }

    chain output {
        type route hook output priority mangle;

        # Don't mark loopback
        oif lo accept

        # Don't mark traffic from proxy user
        meta skuid 1337 accept

        # Mark outbound for re-routing
        meta l4proto tcp meta mark set 0x1
    }
}
EOF

nft -f /etc/nftables-tproxy.conf
```

## Complete Packet Walk-Through

Let's trace exactly what happens when an application in a Kubernetes pod calls `curl http://10.96.0.1:80`:

```
1. Application: connect("10.96.0.1", 80)
   kernel creates TCP socket, SYN generated

2. iptables mangle OUTPUT:
   match: -p tcp -m owner ! --uid-owner 1337
   action: MARK --set-mark 1337

3. Routing:
   ip rule: fwmark 1337 -> table 133
   table 133: 0.0.0.0/0 dev lo
   Result: SYN is looped back to lo

4. iptables mangle PREROUTING (on lo):
   match: -p tcp ! --src 127.0.0.1
   action: TPROXY --tproxy-mark 1337 --on-ip 127.0.0.1 --on-port 15001

5. Kernel socket lookup:
   Look for socket with IP_TRANSPARENT on port 15001
   Found: Envoy's listener (bound with IP_TRANSPARENT)

6. Envoy accept():
   local_addr = 10.96.0.1:80  (ORIGINAL destination!)
   remote_addr = pod-ip:ephemeral_port

7. Envoy applies policy (mTLS, retry, circuit break)
   Envoy opens new connection to 10.96.0.1:80

8. Response flows directly back to the application
   (or through Envoy's outbound listener, depending on config)
```

## Security Implications

```bash
# TPROXY gives a process the ability to receive packets for ANY address
# This is a powerful capability that must be carefully controlled

# In Kubernetes, restrict who can configure TPROXY via PSA:
# pod security admission: require specific capabilities only for proxy pods

# Verify no unexpected processes are listening on tproxy ports
ss -tnlp | grep -E "15001|15006|15008"

# Check for unauthorized MARK rules
iptables -t mangle -L -n -v | grep "MARK set"

# Monitor for TPROXY rule modifications
auditctl -a always,exit -F arch=b64 -S setsockopt \
  -F a1=IPPROTO_IP -F a2=IP_TRANSPARENT \
  -k tproxy_socket
```

## Summary

TPROXY achieves transparent proxying by combining three kernel mechanisms: the `TPROXY` iptables target in the mangle table (PREROUTING only) sets a firewall mark and designates a local socket to receive the packet; policy routing via `ip rule` and a custom route table routes marked packets to the local machine without modifying addresses; and the proxy's socket with `IP_TRANSPARENT` instructs the kernel to deliver packets addressed to foreign IPs to this socket. The critical difference from REDIRECT is that TPROXY preserves the original destination address on the accepted socket, enabling both UDP interception and avoiding the overhead of `SO_ORIGINAL_DST` recovery. In service mesh deployments, TPROXY mode is more architecturally correct than REDIRECT mode but requires careful handling of the "don't intercept proxy's own traffic" loop-prevention rules, which are implemented by matching on the proxy process's UID.
