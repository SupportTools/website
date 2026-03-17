---
title: "Linux iptables NAT: DNAT, SNAT, and Masquerade for Container Networking"
date: 2031-05-24T00:00:00-05:00
draft: false
tags: ["Linux", "iptables", "NAT", "DNAT", "SNAT", "Networking", "Kubernetes", "Containers", "conntrack"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux iptables NAT covering PREROUTING/POSTROUTING/OUTPUT chain mechanics, DNAT for port forwarding, SNAT and MASQUERADE for outbound traffic, connection tracking interaction, how Kubernetes services leverage iptables, and debugging NAT failures."
more_link: "yes"
url: "/linux-iptables-nat-dnat-snat-masquerade-container-networking/"
---

iptables NAT is the invisible plumbing beneath every Docker container port mapping and every Kubernetes Service ClusterIP. When containers can't reach external services, or when port forwards mysteriously fail, the diagnosis always leads back to the NAT table. Understanding exactly how DNAT, SNAT, and Masquerade interact with connection tracking—and how Kubernetes extends these rules to thousands of services—is essential knowledge for any platform engineer.

<!--more-->

# Linux iptables NAT: DNAT, SNAT, and Masquerade for Container Networking

## Section 1: iptables Architecture

### Table and Chain Hierarchy

```
Packet arrives on network interface
        │
        ▼
┌─────────────────────────────────────────────┐
│           PREROUTING (raw → mangle → nat)   │
│  • DNAT for port forwarding                  │
│  • Connection tracking lookup               │
└─────────────────────────────┬───────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                              │
        ▼                                              ▼
Destination = local?                        Destination = other host?
        │                                              │
        ▼                                              ▼
┌─────────────────┐                       ┌───────────────────────┐
│    INPUT chain  │                       │    FORWARD chain       │
│  (filter table) │                       │  (filter, mangle)      │
└────────┬────────┘                       └───────────┬───────────┘
         │                                             │
         ▼                                             ▼
   Local process                          ┌────────────────────────┐
         │                                │   POSTROUTING          │
         ▼                                │  (mangle → nat)        │
    OUTPUT chain                          │  • SNAT/MASQUERADE     │
   (raw, mangle,                          └────────────┬───────────┘
    nat, filter)                                        │
         │                                              ▼
         └──────────────────────────────────► Network interface
```

### Four Tables Processing Order

| Table | Purpose | Chains |
|-------|---------|--------|
| raw | Connection tracking exemption | PREROUTING, OUTPUT |
| mangle | Packet modification (TTL, ToS) | All five chains |
| nat | Network address translation | PREROUTING, INPUT, OUTPUT, POSTROUTING |
| filter | Packet filtering (firewall) | INPUT, FORWARD, OUTPUT |

### Viewing Current NAT Rules

```bash
# Show all NAT table rules
iptables -t nat -L -n -v

# Show with line numbers (useful for deletion)
iptables -t nat -L -n -v --line-numbers

# Show rules in iptables-save format (best for parsing)
iptables -t nat -S

# Show specific chain
iptables -t nat -L PREROUTING -n -v

# Show all tables
for table in raw mangle nat filter; do
    echo "=== Table: ${table} ==="
    iptables -t ${table} -L -n -v
done

# Check rule counts
iptables -t nat -L -n -v | awk '/^Chain/ || /pkts/ || /[0-9]/ {print}'
```

## Section 2: DNAT (Destination NAT) - Port Forwarding

### Fundamentals of DNAT

DNAT rewrites the destination IP and/or port of incoming packets. It operates in the PREROUTING chain, before routing decisions, and in the OUTPUT chain for locally-originated traffic.

```bash
# Basic DNAT: forward external port 8080 to internal web server
iptables -t nat -A PREROUTING \
    -i eth0 \
    -p tcp \
    --dport 8080 \
    -j DNAT \
    --to-destination 192.168.1.10:80

# DNAT with IP specification (only for specific destination IP)
iptables -t nat -A PREROUTING \
    -d 203.0.113.1 \
    -p tcp \
    --dport 443 \
    -j DNAT \
    --to-destination 10.0.0.10:443

# DNAT port range: forward external 10000-11000 to internal 20000-21000
iptables -t nat -A PREROUTING \
    -i eth0 \
    -p tcp \
    --dport 10000:11000 \
    -j DNAT \
    --to-destination 10.0.0.5:20000-21000

# DNAT to multiple backends (round-robin load balancing)
iptables -t nat -A PREROUTING \
    -i eth0 \
    -p tcp \
    --dport 80 \
    -m statistic \
    --mode nth \
    --every 2 \
    --packet 0 \
    -j DNAT \
    --to-destination 10.0.0.10:80

iptables -t nat -A PREROUTING \
    -i eth0 \
    -p tcp \
    --dport 80 \
    -j DNAT \
    --to-destination 10.0.0.11:80

# IMPORTANT: You also need forwarding rules to allow the forwarded traffic
iptables -A FORWARD \
    -p tcp \
    -d 192.168.1.10 \
    --dport 80 \
    -j ACCEPT

# And the masquerade or SNAT on the return path is handled automatically
# by conntrack - the reply packets get reverse DNAT applied
```

### DNAT for Docker Container Port Mapping

```bash
# Docker creates these rules automatically for -p 8080:80
# Equivalent manual rules:

# Allow traffic into the Docker bridge network
iptables -t nat -A DOCKER \
    ! -i docker0 \
    -p tcp \
    --dport 8080 \
    -j DNAT \
    --to-destination 172.17.0.2:80

# The DOCKER chain is inserted into PREROUTING
iptables -t nat -A PREROUTING \
    -m addrtype \
    --dst-type LOCAL \
    -j DOCKER

# Allow forwarding to the container
iptables -A DOCKER \
    -d 172.17.0.2/32 \
    ! -i docker0 \
    -o docker0 \
    -p tcp \
    -m tcp \
    --dport 80 \
    -j ACCEPT

# View Docker's actual rules
iptables -t nat -L DOCKER -n -v
```

### Hairpin NAT (Loopback DNAT)

Hairpin NAT allows hosts on the same network as the server to use the external IP/port to reach a service—often needed in environments where split-horizon DNS is not available.

```bash
# Without hairpin, accessing external-ip:8080 from the same LAN fails
# because the return packet won't have SNAT applied

# Hairpin NAT solution: DNAT + MASQUERADE combination
# Step 1: DNAT (already set up above)
# Step 2: MASQUERADE source when forwarding through the same interface
iptables -t nat -A POSTROUTING \
    -s 192.168.1.0/24 \
    -d 192.168.1.10 \
    -p tcp \
    --dport 80 \
    -j MASQUERADE

# Alternative: SNAT to the router's IP
iptables -t nat -A POSTROUTING \
    -s 192.168.1.0/24 \
    -d 192.168.1.10 \
    -p tcp \
    --dport 80 \
    -j SNAT \
    --to-source 192.168.1.1
```

## Section 3: SNAT (Source NAT) and MASQUERADE

### SNAT vs MASQUERADE

| Feature | SNAT | MASQUERADE |
|---------|------|------------|
| IP specification | Static (--to-source) | Dynamic (uses interface IP) |
| Performance | Slightly faster | Slightly slower (IP lookup per packet) |
| Use case | Servers with fixed IPs | DHCP interfaces, cloud VMs |
| Interface goes down | Connection tracking preserved | Connections dropped |

```bash
# SNAT with fixed source IP
iptables -t nat -A POSTROUTING \
    -s 10.0.0.0/8 \
    -o eth0 \
    -j SNAT \
    --to-source 203.0.113.1

# SNAT with source port range
iptables -t nat -A POSTROUTING \
    -s 10.0.0.0/8 \
    -o eth0 \
    -j SNAT \
    --to-source 203.0.113.1:1024-65535

# MASQUERADE (uses eth0's current IP automatically)
iptables -t nat -A POSTROUTING \
    -s 10.0.0.0/8 \
    -o eth0 \
    -j MASQUERADE

# MASQUERADE with specific port range
iptables -t nat -A POSTROUTING \
    -s 10.0.0.0/8 \
    -o eth0 \
    -j MASQUERADE \
    --to-ports 1024-65535

# MASQUERADE for Docker containers (example of what Docker does)
iptables -t nat -A POSTROUTING \
    -s 172.17.0.0/16 \
    ! -o docker0 \
    -j MASQUERADE

# Kubernetes pod MASQUERADE
iptables -t nat -A POSTROUTING \
    -s 10.244.0.0/16 \
    -j MASQUERADE
```

### Kernel Parameters for NAT

```bash
# Enable IP forwarding (required for routing/NAT)
echo 1 > /proc/sys/net/ipv4/ip_forward

# Make persistent
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-nat.conf
sysctl --system

# conntrack table size (critical for high-traffic NAT)
echo 524288 > /proc/sys/net/netfilter/nf_conntrack_max
echo "net.netfilter.nf_conntrack_max = 524288" >> /etc/sysctl.d/99-nat.conf

# conntrack bucket count (should be 1/4 of nf_conntrack_max)
echo 131072 > /sys/module/nf_conntrack/parameters/hashsize

# conntrack timeout tuning for high-throughput
# TCP established connections
echo 86400 > /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established

# TCP connections in TIME_WAIT (reduce from 120s default)
echo 30 > /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_time_wait

# UDP connections
echo 30 > /proc/sys/net/netfilter/nf_conntrack_udp_timeout
echo 60 > /proc/sys/net/netfilter/nf_conntrack_udp_timeout_stream
```

## Section 4: Connection Tracking (conntrack)

### Understanding conntrack State Machine

```
TCP connection states in conntrack:

SYN sent by client:
  [client:sport → server:dport] state: SYN_SENT

SYN-ACK from server:
  [client:sport → server:dport] state: SYN_RECV

ACK from client (connection established):
  [client:sport → server:dport] state: ESTABLISHED

FIN from either side:
  [client:sport → server:dport] state: FIN_WAIT / CLOSE_WAIT

Connection closed:
  Entry remains for timeout period (default 120s for TIME_WAIT)
```

### conntrack Command Reference

```bash
# Install conntrack tools
apt-get install -y conntrack  # Debian/Ubuntu
dnf install -y conntrack-tools  # RHEL/Fedora

# List all connection tracking entries
conntrack -L

# List with NAT information
conntrack -L -n

# Count tracked connections
conntrack -C

# Monitor new connections in real-time
conntrack -E -e NEW

# Monitor all events
conntrack -E

# Delete entries for a specific IP (force reconnection)
conntrack -D -s 10.0.0.5

# Delete TIME_WAIT entries (careful: may break in-flight connections)
conntrack -D -p tcp --state TIME_WAIT

# Flush ALL conntrack entries (DANGEROUS in production!)
# conntrack -F

# Get statistics
conntrack -S

# Filter by protocol and state
conntrack -L -p tcp --state ESTABLISHED

# Watch for specific destination
conntrack -L -d 10.96.0.10  # Track Kubernetes service IP
```

### conntrack Table Analysis

```bash
#!/bin/bash
# analyze_conntrack.sh - Analyze conntrack table for issues

echo "=== conntrack Table Analysis ==="
echo ""

# Total count
TOTAL=$(conntrack -C 2>/dev/null || echo "0")
MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max)
echo "Total entries: ${TOTAL} / ${MAX} max"
echo "Utilization: $(echo "scale=1; ${TOTAL} * 100 / ${MAX}" | bc)%"
echo ""

# Distribution by protocol
echo "Protocol distribution:"
conntrack -L 2>/dev/null | awk '{print $1}' | sort | uniq -c | sort -rn
echo ""

# Distribution by state
echo "TCP state distribution:"
conntrack -L 2>/dev/null | grep "^tcp" | awk '{print $4}' | sort | uniq -c | sort -rn
echo ""

# Top source IPs
echo "Top 10 source IPs:"
conntrack -L 2>/dev/null | grep -o 'src=[0-9.]*' | sort | uniq -c | sort -rn | head -10
echo ""

# Top destination IPs
echo "Top 10 destination IPs:"
conntrack -L 2>/dev/null | grep -o 'dst=[0-9.]*' | sort | uniq -c | sort -rn | head -10
echo ""

# Connections in UNREPLIED state (potential issues)
UNREPLIED=$(conntrack -L 2>/dev/null | grep -c "UNREPLIED" || echo 0)
echo "UNREPLIED connections: ${UNREPLIED}"
if [[ ${UNREPLIED} -gt 1000 ]]; then
    echo "WARNING: High UNREPLIED count may indicate asymmetric routing or firewall issues"
fi
```

## Section 5: Kubernetes Service iptables Rules

### How kube-proxy Implements Services

When you create a Kubernetes Service, kube-proxy creates iptables rules that implement load balancing using probability-based random selection.

```bash
# View Kubernetes-created iptables rules
# ClusterIP service example: nginx service with 3 endpoints
iptables -t nat -L | grep -A 20 "KUBE-SVC"

# Example output for a ClusterIP service:
# Chain KUBE-SVC-ABCDEF1234567890 (1 references)
# target     prot opt source destination
# KUBE-SEP-ENDPOINT1  tcp  --  anywhere  anywhere  statistic mode random probability 0.33
# KUBE-SEP-ENDPOINT2  tcp  --  anywhere  anywhere  statistic mode random probability 0.50
# KUBE-SEP-ENDPOINT3  tcp  --  anywhere  anywhere
```

### Deep Dive: Kubernetes Service Packet Flow

```bash
# Step 1: PREROUTING - catch traffic destined for ClusterIP
iptables -t nat -A PREROUTING \
    -m comment --comment "kubernetes service portals" \
    -j KUBE-SERVICES

# Step 2: KUBE-SERVICES - match specific service ClusterIP
iptables -t nat -A KUBE-SERVICES \
    -d 10.96.100.50/32 \
    -p tcp \
    --dport 80 \
    -m comment --comment "production/my-service cluster IP" \
    -j KUBE-SVC-XYZXYZXYZXYZXYZ

# Step 3: KUBE-SVC - probabilistic load balancing
# First endpoint: 1/3 probability
iptables -t nat -A KUBE-SVC-XYZXYZXYZXYZXYZ \
    -m statistic \
    --mode random \
    --probability 0.33333333349 \
    -j KUBE-SEP-ENDPOINT001

# Second endpoint: 1/2 of remaining (= 1/3 overall)
iptables -t nat -A KUBE-SVC-XYZXYZXYZXYZXYZ \
    -m statistic \
    --mode random \
    --probability 0.50000000000 \
    -j KUBE-SEP-ENDPOINT002

# Third endpoint: all remaining (= 1/3 overall)
iptables -t nat -A KUBE-SVC-XYZXYZXYZXYZXYZ \
    -j KUBE-SEP-ENDPOINT003

# Step 4: KUBE-SEP - DNAT to pod IP
iptables -t nat -A KUBE-SEP-ENDPOINT001 \
    -p tcp \
    -m tcp \
    -j DNAT \
    --to-destination 10.244.1.5:8080

# Step 5: POSTROUTING - MASQUERADE if needed
iptables -t nat -A POSTROUTING \
    -m comment --comment "kubernetes postrouting rules" \
    -j KUBE-POSTROUTING

iptables -t nat -A KUBE-POSTROUTING \
    -m mark \
    --mark 0x4000/0x4000 \
    -j MASQUERADE

# NodePort services also get rules in PREROUTING
iptables -t nat -A KUBE-SERVICES \
    -m addrtype \
    --dst-type LOCAL \
    -j KUBE-NODEPORTS

iptables -t nat -A KUBE-NODEPORTS \
    -p tcp \
    --dport 30080 \
    -m comment --comment "production/my-service nodePort" \
    -j KUBE-SVC-XYZXYZXYZXYZXYZ
```

### Viewing Kubernetes Service Rules

```bash
#!/bin/bash
# k8s-nat-debug.sh - Debug Kubernetes service networking

SERVICE_IP="${1:-10.96.100.50}"
SERVICE_PORT="${2:-80}"

echo "=== Kubernetes Service NAT Debug ==="
echo "Service: ${SERVICE_IP}:${SERVICE_PORT}"
echo ""

# Find the SVC chain
echo "KUBE-SERVICES entry:"
iptables -t nat -L KUBE-SERVICES -n | grep "${SERVICE_IP}"
echo ""

# Get the SVC chain name
SVC_CHAIN=$(iptables -t nat -L KUBE-SERVICES -n | \
    grep "${SERVICE_IP}.*${SERVICE_PORT}" | \
    awk '{print $1}')

if [[ -z "${SVC_CHAIN}" ]]; then
    echo "ERROR: No iptables rule found for ${SERVICE_IP}:${SERVICE_PORT}"
    echo "Possible causes:"
    echo "  1. kube-proxy not running"
    echo "  2. Service doesn't exist"
    echo "  3. iptables rules corrupted"
    exit 1
fi

echo "SVC Chain (${SVC_CHAIN}) - Load balancing rules:"
iptables -t nat -L "${SVC_CHAIN}" -n -v
echo ""

# Get endpoint chains
echo "Endpoint (SEP) chains and their pod IPs:"
for sep in $(iptables -t nat -L "${SVC_CHAIN}" -n | \
    grep "KUBE-SEP" | awk '{print $1}'); do
    echo "  ${sep}:"
    iptables -t nat -L "${sep}" -n | grep DNAT
done
echo ""

# Check counters
echo "Rule hit counters (non-zero means traffic is flowing):"
iptables -t nat -L "${SVC_CHAIN}" -n -v | \
    awk '{if($1+0 > 0) print "  Packets:", $1, "Bytes:", $2, "→", $NF}'
```

## Section 6: Advanced NAT Scenarios

### REDIRECT: Transparent Proxy

```bash
# Redirect all HTTP traffic to local proxy (e.g., for Istio sidecar)
iptables -t nat -A PREROUTING \
    -p tcp \
    --dport 80 \
    -j REDIRECT \
    --to-port 15001

# Redirect with source exclusion (exclude specific IPs)
iptables -t nat -A PREROUTING \
    -p tcp \
    --dport 80 \
    ! -s 127.0.0.1 \
    -j REDIRECT \
    --to-port 15001

# Istio-style transparent proxy setup
# Redirect all outbound traffic except for specific ports
iptables -t nat -N ISTIO_OUTPUT
iptables -t nat -A OUTPUT \
    -p tcp \
    -j ISTIO_OUTPUT

# Skip loopback
iptables -t nat -A ISTIO_OUTPUT \
    -o lo \
    -j RETURN

# Skip traffic from Envoy itself (by UID)
iptables -t nat -A ISTIO_OUTPUT \
    -m owner \
    --uid-owner 1337 \
    -j RETURN

# Redirect remaining TCP to Envoy
iptables -t nat -A ISTIO_OUTPUT \
    -p tcp \
    -j REDIRECT \
    --to-port 15001
```

### Policy-Based Routing with NAT

```bash
# Multi-ISP NAT: different SNAT rules based on source subnet
# Traffic from 10.0.1.0/24 exits via ISP1 (eth0)
# Traffic from 10.0.2.0/24 exits via ISP2 (eth1)

# Mark packets by source subnet
iptables -t mangle -A PREROUTING \
    -s 10.0.1.0/24 \
    -j MARK \
    --set-mark 1

iptables -t mangle -A PREROUTING \
    -s 10.0.2.0/24 \
    -j MARK \
    --set-mark 2

# SNAT per ISP
iptables -t nat -A POSTROUTING \
    -m mark \
    --mark 1 \
    -o eth0 \
    -j SNAT \
    --to-source 203.0.113.1  # ISP1 IP

iptables -t nat -A POSTROUTING \
    -m mark \
    --mark 2 \
    -o eth1 \
    -j SNAT \
    --to-source 198.51.100.1  # ISP2 IP

# Configure ip rule for policy routing
ip rule add fwmark 1 lookup 100
ip rule add fwmark 2 lookup 200

ip route add default via 203.0.113.254 table 100
ip route add default via 198.51.100.254 table 200
```

## Section 7: Debugging NAT Failures

### Systematic NAT Debugging

```bash
#!/bin/bash
# debug-nat.sh - Systematic NAT debugging script

SRC_IP="${1}"
DST_IP="${2}"
DST_PORT="${3:-80}"
PROTO="${4:-tcp}"

if [[ -z "${SRC_IP}" || -z "${DST_IP}" ]]; then
    echo "Usage: $0 <src-ip> <dst-ip> [dst-port] [proto]"
    exit 1
fi

echo "=== NAT Debug: ${SRC_IP} → ${DST_IP}:${DST_PORT}/${PROTO} ==="

# 1. Check IP forwarding
echo ""
echo "1. IP Forwarding:"
FWD=$(cat /proc/sys/net/ipv4/ip_forward)
echo "   ip_forward = ${FWD}"
if [[ "${FWD}" != "1" ]]; then
    echo "   ERROR: IP forwarding is disabled! Enable with:"
    echo "   echo 1 > /proc/sys/net/ipv4/ip_forward"
fi

# 2. Check conntrack table fullness
echo ""
echo "2. conntrack Table:"
CURR=$(conntrack -C 2>/dev/null || echo "N/A")
MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max)
echo "   Entries: ${CURR} / ${MAX}"
if [[ "${CURR}" != "N/A" ]] && [[ $((CURR * 100 / MAX)) -gt 80 ]]; then
    echo "   WARNING: conntrack table >80% full!"
fi

# 3. Check for existing conntrack entry
echo ""
echo "3. Existing conntrack entry:"
conntrack -L 2>/dev/null | grep -E "${SRC_IP}.*${DST_IP}|${DST_IP}.*${SRC_IP}" | head -5
if [[ $? -ne 0 ]]; then
    echo "   No existing entry found"
fi

# 4. Check PREROUTING rules
echo ""
echo "4. PREROUTING NAT rules matching ${DST_IP}:${DST_PORT}:"
iptables -t nat -L PREROUTING -n -v | grep -E "${DST_IP}|dpt:${DST_PORT}"

# 5. Check POSTROUTING rules
echo ""
echo "5. POSTROUTING/SNAT rules:"
iptables -t nat -L POSTROUTING -n -v | head -30

# 6. Check FORWARD chain for connectivity
echo ""
echo "6. FORWARD chain rules (checking if forwarding is allowed):"
iptables -L FORWARD -n -v | grep -E "${SRC_IP}|${DST_IP}" | head -10

# 7. Route check
echo ""
echo "7. Route for ${DST_IP}:"
ip route get "${DST_IP}" from "${SRC_IP}"

# 8. Test with nf_trace
echo ""
echo "8. Packet trace (add rules to trace next packet):"
echo "   Run these commands to enable tracing:"
echo "   iptables -t raw -A PREROUTING -s ${SRC_IP} -j TRACE"
echo "   iptables -t raw -A OUTPUT -s ${SRC_IP} -j TRACE"
echo "   Then check: dmesg | tail -50"
echo "   Or use: nftables: nft add rule ip filter prerouting ip saddr ${SRC_IP} log"
```

### Using nf_log and TRACE Target

```bash
# Enable kernel netfilter tracing (kernel 4.9+)
# This is the most powerful NAT debugging tool

# First, load the nf_log_ipv4 module
modprobe nf_log_ipv4

# Enable tracing for a specific source IP
iptables -t raw -A PREROUTING \
    -s 10.0.0.5 \
    -j TRACE

iptables -t raw -A OUTPUT \
    -s 10.0.0.5 \
    -j TRACE

# Watch the kernel log for trace output
# Format: [table] [chain] IN=<iface> OUT=<iface> SRC=<ip> DST=<ip> ...
journalctl -k --since "1 minute ago" -f | grep "TRACE:"

# Example trace output:
# TRACE: raw:PREROUTING:rule:2 IN=eth0 SRC=10.0.0.5 DST=10.96.100.50
# TRACE: raw:PREROUTING:return:2 ...
# TRACE: nat:PREROUTING:rule:1 ... (KUBE-SERVICES)
# TRACE: nat:PREROUTING:rule:1 ... (KUBE-SVC-...)
# TRACE: nat:PREROUTING:rule:1 ... (KUBE-SEP-... -> DNAT to 10.244.1.5)

# Remove trace rules when done
iptables -t raw -D PREROUTING -s 10.0.0.5 -j TRACE
iptables -t raw -D OUTPUT -s 10.0.0.5 -j TRACE
```

### Common NAT Failure Scenarios

```bash
# Scenario 1: "Connection refused" when it shouldn't be
# Diagnosis steps:
echo "=== Checking conntrack ESTABLISHED entry ==="
conntrack -L | grep "ESTABLISHED.*10.0.0.5"

echo "=== Checking FORWARD chain drops ==="
iptables -L FORWARD -n -v | grep "DROP\|REJECT"

echo "=== Checking if SYN packets are reaching destination ==="
tcpdump -i any "host 10.0.0.5 and tcp and tcp[tcpflags] & tcp-syn != 0" -c 10

# Scenario 2: NAT working but slow (conntrack exhaustion)
echo "=== conntrack performance check ==="
# Check for excessive UNREPLIED entries (flood or misconfiguration)
conntrack -L | grep UNREPLIED | wc -l

# Check conntrack stats for drops
conntrack -S | grep drop

# Scenario 3: DNAT not applying
echo "=== Checking DNAT rule hit counter ==="
iptables -t nat -L PREROUTING -n -v | grep "DNAT"
# If pkts column is 0, no traffic has matched

# Verify the rule matches the actual traffic
echo "Packet capture to verify traffic:"
tcpdump -i eth0 "dst port 8080" -c 5

# Scenario 4: Kubernetes Service not reachable
echo "=== Checking kube-proxy is running ==="
kubectl -n kube-system get pods -l k8s-app=kube-proxy
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=20

echo "=== Verifying iptables rules were created ==="
iptables -t nat -L KUBE-SERVICES -n | wc -l
# Should have one entry per service

echo "=== Check for KUBE-SVC chain ==="
SERVICE_IP="10.96.100.50"  # Replace with actual ClusterIP
iptables -t nat -L KUBE-SERVICES -n | grep "${SERVICE_IP}"
```

## Section 8: nftables: Modern iptables Replacement

```bash
# Modern systems use nftables; iptables commands are often translated

# View nftables ruleset
nft list ruleset

# View NAT-equivalent tables
nft list table ip nat

# Add equivalent MASQUERADE rule in nftables
nft add table ip nat
nft add chain ip nat postrouting { type nat hook postrouting priority 100 \; }
nft add rule ip nat postrouting ip saddr 10.0.0.0/8 oif eth0 masquerade

# DNAT in nftables
nft add chain ip nat prerouting { type nat hook prerouting priority -100 \; }
nft add rule ip nat prerouting \
    iif eth0 tcp dport 8080 \
    dnat to 192.168.1.10:80

# View conntrack with nft
nft list ct table ip

# Kubernetes uses iptables-legacy or iptables-nft
# Check which mode kube-proxy is using:
kubectl -n kube-system get cm kube-proxy-config -o yaml | grep mode
```

## Section 9: Performance Optimization

```bash
# NOTRACK (raw table) for high-performance NAT bypass
# Exclude traffic that doesn't need connection tracking
iptables -t raw -A PREROUTING \
    -p udp \
    --dport 53 \
    -j NOTRACK

iptables -t raw -A OUTPUT \
    -p udp \
    --sport 53 \
    -j NOTRACK

# For UDP-based protocols (DNS, NTP, SNMP) that don't need stateful tracking
iptables -t raw -A PREROUTING \
    -s 10.0.0.0/8 \
    -p udp \
    -j NOTRACK

# Use NFQUEUE for offloading to userspace (for complex logic)
iptables -A INPUT \
    -p tcp \
    --dport 8080 \
    -j NFQUEUE \
    --queue-num 0

# conntrack hash table tuning
# Place in /etc/rc.local or systemd service
echo 131072 > /sys/module/nf_conntrack/parameters/hashsize

# Reduce TIME_WAIT tracking overhead
cat << 'EOF' > /etc/sysctl.d/99-conntrack-performance.conf
# conntrack tuning
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 30
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 60
net.netfilter.nf_conntrack_icmp_timeout = 30
# Disable timestamp option to reduce TCP packet size
net.ipv4.tcp_timestamps = 0
EOF
sysctl --system
```

## Section 10: Production NAT Configuration for Multi-Tenant Kubernetes

```bash
#!/bin/bash
# setup-production-nat.sh
# Production-grade NAT configuration for a Kubernetes node

set -euo pipefail

# Pod CIDR
POD_CIDR="10.244.0.0/16"
# Service CIDR (ClusterIP range)
SERVICE_CIDR="10.96.0.0/12"
# Node's primary network interface
NODE_INTERFACE="eth0"

echo "Setting up production NAT rules..."

# 1. Enable IP forwarding
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv6.conf.all.forwarding=1

# 2. Flush existing rules (careful in production!)
# iptables -t nat -F  # Only if safe to do so

# 3. Pod-to-external MASQUERADE
# Only masquerade traffic leaving the node interface
iptables -t nat -A POSTROUTING \
    -s "${POD_CIDR}" \
    ! -d "${POD_CIDR}" \
    ! -d "${SERVICE_CIDR}" \
    -j MASQUERADE \
    -m comment --comment "pod-outbound-nat"

# 4. Allow established/related connections
iptables -A FORWARD \
    -m conntrack \
    --ctstate ESTABLISHED,RELATED \
    -j ACCEPT

# 5. Allow pod-to-pod forwarding
iptables -A FORWARD \
    -s "${POD_CIDR}" \
    -j ACCEPT
iptables -A FORWARD \
    -d "${POD_CIDR}" \
    -j ACCEPT

# 6. Prevent direct access to node metadata endpoint from pods
# AWS instance metadata
iptables -I FORWARD \
    -s "${POD_CIDR}" \
    -d 169.254.169.254/32 \
    -j DROP \
    -m comment --comment "block-pod-metadata-access"

# 7. conntrack optimization
sysctl -w net.netfilter.nf_conntrack_max=524288

echo "Production NAT configuration complete"
echo ""
echo "Verify with:"
echo "  iptables -t nat -L -n -v"
echo "  conntrack -S"
```

The iptables NAT system underpins everything from simple Docker port mappings to Kubernetes' entire service abstraction layer. The key insight is that conntrack is what makes stateless DNAT and SNAT rules work for bidirectional connections—it stores the translation state and automatically applies the reverse translation to reply packets. When things break, systematic use of TRACE rules, conntrack state inspection, and rule counter analysis will always reveal the problem.
