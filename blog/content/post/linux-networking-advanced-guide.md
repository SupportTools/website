---
title: "Advanced Linux Networking: Traffic Control, Namespaces, and Performance"
date: 2027-09-19T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "tc", "Namespaces", "Performance"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Linux networking internals covering network namespaces, veth pairs, traffic control with tc/netem, iptables and nftables deep dive, socket buffer tuning, XDP for high-performance packet processing, and SR-IOV virtual functions."
more_link: "yes"
url: "/linux-networking-advanced-guide/"
---

Linux networking internals underpin every container, virtual machine, and service mesh deployment in modern infrastructure. Understanding network namespaces, traffic control, and high-performance packet processing paths is essential for engineers who build and operate systems where networking throughput and latency are first-class concerns. This guide moves beyond basic configuration into the mechanisms that production systems depend on.

<!--more-->

# Advanced Linux Networking: Traffic Control, Namespaces, and Performance

## Section 1: Network Namespaces and veth Pairs

### Creating Isolated Network Namespaces

Network namespaces provide complete isolation of the network stack. Each namespace has its own interfaces, routing table, iptables rules, and sockets.

```bash
# Create two network namespaces
ip netns add ns-blue
ip netns add ns-red

# List namespaces
ip netns list

# Run a command inside a namespace
ip netns exec ns-blue ip link list

# Check which namespace the current process uses
ls -la /proc/self/ns/net
```

### Connecting Namespaces with veth Pairs

```bash
# Create a veth pair — two virtual NICs connected back-to-back
ip link add veth-blue type veth peer name veth-red

# Move each end into its namespace
ip link set veth-blue netns ns-blue
ip link set veth-red  netns ns-red

# Configure IP addresses
ip netns exec ns-blue ip addr add 192.168.100.1/24 dev veth-blue
ip netns exec ns-red  ip addr add 192.168.100.2/24 dev veth-red

# Bring interfaces up
ip netns exec ns-blue ip link set veth-blue up
ip netns exec ns-red  ip link set veth-red  up
ip netns exec ns-blue ip link set lo up
ip netns exec ns-red  ip link set lo up

# Verify connectivity
ip netns exec ns-blue ping -c 3 192.168.100.2
```

### Linux Bridge Connecting Multiple Namespaces

```bash
# Create a bridge
ip link add br0 type bridge
ip link set br0 up
ip addr add 192.168.200.1/24 dev br0

# Create veth pairs for two containers
ip link add veth-c1 type veth peer name veth-c1-br
ip link add veth-c2 type veth peer name veth-c2-br

# Move container ends into namespaces
ip link set veth-c1 netns ns-blue
ip link set veth-c2 netns ns-red

# Connect bridge ends to bridge
ip link set veth-c1-br master br0
ip link set veth-c2-br master br0

# Bring all bridge-side interfaces up
ip link set veth-c1-br up
ip link set veth-c2-br up

# Configure namespaces
ip netns exec ns-blue ip addr add 192.168.200.2/24 dev veth-c1
ip netns exec ns-blue ip link set veth-c1 up
ip netns exec ns-blue ip route add default via 192.168.200.1

ip netns exec ns-red ip addr add 192.168.200.3/24 dev veth-c2
ip netns exec ns-red ip link set veth-c2 up
ip netns exec ns-red ip route add default via 192.168.200.1

# Enable IP forwarding for routing between namespaces
sysctl -w net.ipv4.ip_forward=1

# Verify cross-namespace connectivity
ip netns exec ns-blue ping -c 3 192.168.200.3
```

### Namespace Inspection and Cleanup

```bash
# Show all network resources in a namespace
ip netns exec ns-blue ip -a

# Monitor network events in a namespace
ip netns exec ns-blue ip monitor

# View routing table
ip netns exec ns-blue ip route show table all

# Delete namespace (all associated resources cleaned up)
ip netns del ns-blue
ip netns del ns-red
```

---

## Section 2: Traffic Control with tc

### Understanding the tc Queueing Discipline Hierarchy

Traffic control in Linux operates on a tree structure:
- **qdisc** (queueing discipline) — decides how packets are enqueued and dequeued
- **class** — subdivides a qdisc into traffic classes
- **filter** — classifies packets into classes

```bash
# Show current qdiscs on an interface
tc qdisc show dev eth0

# Show classes
tc class show dev eth0

# Show filters
tc filter show dev eth0
```

### HTB — Hierarchical Token Bucket for Bandwidth Allocation

```bash
# Scenario: 100 Mbps link with three traffic classes:
# - Critical (Kubernetes API): guaranteed 40 Mbps, max 80 Mbps
# - Application traffic:       guaranteed 40 Mbps, max 80 Mbps
# - Background (backups):      guaranteed 5 Mbps,  max 20 Mbps

ETH=eth0
RATE_TOTAL=100mbit

# Step 1: Replace the default qdisc with HTB
tc qdisc replace dev ${ETH} root handle 1: htb default 30

# Step 2: Create root class with total bandwidth
tc class add dev ${ETH} parent 1:  classid 1:1  htb rate ${RATE_TOTAL} ceil ${RATE_TOTAL}

# Step 3: Create leaf classes
tc class add dev ${ETH} parent 1:1 classid 1:10 htb rate 40mbit ceil 80mbit prio 1
tc class add dev ${ETH} parent 1:1 classid 1:20 htb rate 40mbit ceil 80mbit prio 2
tc class add dev ${ETH} parent 1:1 classid 1:30 htb rate 5mbit  ceil 20mbit prio 3

# Step 4: Attach fair queueing qdiscs to each leaf class
tc qdisc add dev ${ETH} parent 1:10 handle 10: sfq perturb 10
tc qdisc add dev ${ETH} parent 1:20 handle 20: sfq perturb 10
tc qdisc add dev ${ETH} parent 1:30 handle 30: sfq perturb 10

# Step 5: Add filters to classify traffic
# Kubernetes API server (port 6443) goes to critical class
tc filter add dev ${ETH} parent 1:0 protocol ip prio 1 \
  u32 match ip dport 6443 0xffff flowid 1:10

# Application traffic (port 8080) goes to application class
tc filter add dev ${ETH} parent 1:0 protocol ip prio 2 \
  u32 match ip dport 8080 0xffff flowid 1:20

# Everything else falls to default class 30

# Verify
tc -s class show dev ${ETH}
```

### netem — Network Emulation for Testing

```bash
# Simulate a WAN link with 100ms latency and 0.1% packet loss
tc qdisc add dev eth0 root netem delay 100ms loss 0.1%

# Add jitter (20ms) following a normal distribution
tc qdisc add dev eth0 root netem delay 100ms 20ms distribution normal

# Simulate packet corruption and reordering
tc qdisc add dev eth0 root netem \
  delay 50ms 10ms \
  loss 0.5% \
  corrupt 0.1% \
  reorder 5% 25%

# Limit bandwidth with tbf and add delay with netem
tc qdisc add dev eth0 root handle 1: tbf rate 10mbit burst 32kbit latency 400ms
tc qdisc add dev eth0 parent 1:1 handle 10: netem delay 50ms

# Remove all tc rules
tc qdisc del dev eth0 root

# Apply netem only to a specific namespace (for container testing)
ip netns exec ns-blue tc qdisc add dev veth-c1 root netem delay 50ms loss 1%
```

### CAKE — Common Applications Kept Enhanced

```bash
# CAKE is an advanced qdisc combining shaping, scheduling, and AQM
# Built into kernel 4.19+

# Basic CAKE setup for a 100 Mbps uplink with fair per-flow scheduling
tc qdisc replace dev eth0 root cake \
  bandwidth 100mbit \
  besteffort \
  nat \
  ethernet

# CAKE with per-host isolation and DSCP prioritization
tc qdisc replace dev eth0 root cake \
  bandwidth 100mbit \
  diffserv4 \
  triple-isolate \
  nat \
  ethernet

# Show CAKE statistics
tc -s qdisc show dev eth0
```

---

## Section 3: iptables and nftables Deep Dive

### iptables Architecture

```bash
# Tables and chains:
# filter:  INPUT, FORWARD, OUTPUT
# nat:     PREROUTING, OUTPUT, POSTROUTING
# mangle:  PREROUTING, INPUT, FORWARD, OUTPUT, POSTROUTING
# raw:     PREROUTING, OUTPUT

# Show all rules with line numbers and packet counts
iptables -nvL --line-numbers

# Show NAT rules
iptables -t nat -nvL --line-numbers

# Rate-limit new connections to protect against SYN floods
iptables -A INPUT -p tcp --syn -m limit --limit 30/s --limit-burst 60 -j ACCEPT
iptables -A INPUT -p tcp --syn -j DROP

# Show connection tracking state
conntrack -L | head -30
conntrack -S
```

### nftables — Modern Replacement

```bash
# Show all nftables rules
nft list ruleset

# Create a complete nftables configuration
cat > /etc/nftables.conf << 'EOF'
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        # Accept established and related connections
        ct state established,related accept

        # Accept loopback
        iifname lo accept

        # Accept ICMP
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        # Rate-limit SSH
        tcp dport 22 ct state new \
            limit rate 10/minute burst 20 packets accept

        # Accept HTTP/HTTPS
        tcp dport { 80, 443 } accept

        # Accept Kubernetes API from internal networks
        tcp dport 6443 ip saddr 10.0.0.0/8 accept

        # Log and drop everything else
        log prefix "nftables-drop: " flags all drop
    }

    chain forward {
        type filter hook forward priority 0; policy drop;

        iifname "cni0" accept
        oifname "cni0" ct state established,related accept
        ct state established,related accept
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}

table inet nat {
    chain prerouting {
        type nat hook prerouting priority -100;

        # DNAT: forward port 8443 to internal service
        iifname eth0 tcp dport 8443 \
            dnat to 10.96.0.100:443
    }

    chain postrouting {
        type nat hook postrouting priority 100;

        # Masquerade container traffic
        ip saddr 10.244.0.0/16 oifname eth0 masquerade
    }
}
EOF

# Apply
nft -f /etc/nftables.conf
systemctl enable nftables
```

### Connection Tracking Optimization

```bash
# View conntrack table entries
cat /proc/net/nf_conntrack | head -10

# Count connections by state
awk '{print $5}' /proc/net/nf_conntrack | sort | uniq -c | sort -rn

# Monitor conntrack events in real time
conntrack -E

# Tune conntrack table size for high-connection workloads
sysctl -w net.netfilter.nf_conntrack_max=1048576
sysctl -w net.netfilter.nf_conntrack_buckets=262144
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=600

# Bypass conntrack for high-rate UDP (e.g., DNS resolvers)
iptables -t raw -A PREROUTING -p udp --dport 53 -j NOTRACK
iptables -t raw -A OUTPUT     -p udp --dport 53 -j NOTRACK
```

---

## Section 4: XDP for High-Performance Packet Processing

### XDP Program — Blacklist Drop

```c
/* xdp-drop-blacklist.c — Drop packets from a blacklist of source IPs */
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key,   __u32);
    __type(value, __u8);
} blacklist SEC(".maps");

SEC("xdp")
int xdp_drop_blacklist(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;
    __u8 *blocked = bpf_map_lookup_elem(&blacklist, &src_ip);
    if (blocked && *blocked)
        return XDP_DROP;

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

```bash
# Compile the XDP program
clang -O2 -target bpf -c xdp-drop-blacklist.c -o xdp-drop-blacklist.o

# Load onto network interface
ip link set dev eth0 xdp obj xdp-drop-blacklist.o sec xdp

# Add an IP to the blacklist map (192.168.1.1 in hex little-endian)
bpftool map update pinned /sys/fs/bpf/blacklist \
  key hex 01 01 a8 c0 \
  value hex 01

# Show loaded XDP program
ip link show eth0 | grep xdp
bpftool prog show

# Detach XDP program
ip link set dev eth0 xdp off

# XDP statistics (driver-level)
ethtool -S eth0 | grep -i xdp
```

### XDP Decision Return Codes

```c
// XDP return codes and their meanings:
// XDP_PASS    — pass packet to normal kernel network stack
// XDP_DROP    — drop packet immediately (very low overhead)
// XDP_TX      — transmit packet back out the same interface
// XDP_REDIRECT — redirect to another interface or CPU queue
// XDP_ABORTED — drop with trace event (debugging only)
```

### XDP Attachment Modes

```bash
# Native mode (fastest — driver support required)
ip link set dev eth0 xdp obj prog.o sec xdp

# SKB mode (universal — works on all drivers, slower)
ip link set dev eth0 xdpskb obj prog.o sec xdp

# Offloaded mode (fastest — NIC does processing; requires SmartNIC)
ip link set dev eth0 xdpoffload obj prog.o sec xdp
```

---

## Section 5: SR-IOV Virtual Functions

### Enabling SR-IOV on a Physical NIC

```bash
# Check if NIC supports SR-IOV
lspci -vv | grep -A 20 "Ethernet Controller" | grep -i "SR-IOV\|VF"

# Check current and maximum VF count
cat /sys/class/net/eth0/device/sriov_numvfs
cat /sys/class/net/eth0/device/sriov_totalvfs

# Create 4 Virtual Functions
echo 4 > /sys/class/net/eth0/device/sriov_numvfs

# Verify VFs created
ip link show eth0
# eth0: ... vf 0 MAC 00:00:00:00:00:01, ... vf 3 MAC 00:00:00:00:00:04

# Make SR-IOV persistent via udev rule
cat > /etc/udev/rules.d/90-sriov.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="net", ENV{ID_NET_DRIVER}=="i40e", \
    RUN+="/bin/sh -c 'echo 4 > /sys/class/net/%k/device/sriov_numvfs'"
EOF

udevadm control --reload-rules
```

### Configuring VF Properties

```bash
# Configure VF MAC, VLAN, and rate limits
ip link set eth0 vf 0 mac 52:54:00:ab:cd:01
ip link set eth0 vf 0 vlan 100
ip link set eth0 vf 0 max_tx_rate 1000    # Mbps
ip link set eth0 vf 0 trust on

ip link set eth0 vf 1 mac 52:54:00:ab:cd:02
ip link set eth0 vf 1 vlan 200

# Show VF configuration
ip link show eth0

# List VF PCI addresses
lspci | grep "Virtual Function"
# 0000:01:10.0 Ethernet controller: Intel X550 Virtual Function
# 0000:01:10.2 Ethernet controller: Intel X550 Virtual Function
```

### Kubernetes SR-IOV CNI

```yaml
# sriov-network-attachment-definition.yaml
apiVersion: "k8s.cni.cncf.io/v1"
kind: NetworkAttachmentDefinition
metadata:
  name: sriov-net
  annotations:
    k8s.v1.cni.cncf.io/resourceName: intel.com/intel_sriov_netdevice
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "sriov",
      "name": "sriov-net",
      "vlan": 100,
      "ipam": {
        "type": "host-local",
        "subnet": "10.56.217.0/24",
        "routes": [{"dst": "0.0.0.0/0"}],
        "gateway": "10.56.217.1"
      }
    }
---
# Pod requesting SR-IOV VF
apiVersion: v1
kind: Pod
metadata:
  name: sriov-pod
  annotations:
    k8s.v1.cni.cncf.io/networks: sriov-net
spec:
  containers:
  - name: app
    image: docker.io/library/ubuntu:22.04
    command: ["sleep", "infinity"]
    resources:
      limits:
        intel.com/intel_sriov_netdevice: "1"
```

---

## Section 6: Socket Buffer Tuning

### System-Level Socket Buffer Configuration

```ini
# /etc/sysctl.d/40-socket-buffers.conf

# Maximum socket receive/send buffer sizes
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728

# Default socket buffer sizes
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216

# TCP auto-tuning ranges: min, default, max
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

# UDP receive buffer (critical for high-rate UDP metrics)
net.core.netdev_max_backlog = 250000
```

### Application Socket Tuning in Python

```python
#!/usr/bin/env python3
# high-perf-server.py — socket configured for maximum throughput

import socket

def create_tuned_socket(host='0.0.0.0', port=8080):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    # Enable address reuse
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)

    # Enlarge socket buffers
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 * 1024 * 1024)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 8 * 1024 * 1024)

    # Disable Nagle algorithm for latency-sensitive workloads
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    # Enable TCP keepalive
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE,  30)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT,    3)

    sock.bind((host, port))
    sock.listen(65535)

    # Verify actual buffer sizes
    rcv = sock.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
    snd = sock.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)
    print(f"Socket bound to {host}:{port}")
    print(f"Receive buffer: {rcv // 1024} KB")
    print(f"Send buffer:    {snd // 1024} KB")

    return sock

if __name__ == '__main__':
    srv = create_tuned_socket()
```

---

## Section 7: Advanced Routing

### Policy-Based Routing

```bash
# Create routing tables
echo "200 app_traffic"  >> /etc/iproute2/rt_tables
echo "201 mgmt_traffic" >> /etc/iproute2/rt_tables

# Add routes to custom tables
ip route add default via 192.168.1.1 table app_traffic
ip route add default via 10.0.0.1   table mgmt_traffic

# Traffic from 10.1.0.0/24 uses app_traffic table
ip rule add from 10.1.0.0/24 table app_traffic priority 100

# Traffic to 10.0.0.0/8 uses mgmt_traffic table
ip rule add to 10.0.0.0/8 table mgmt_traffic priority 200

# Verify
ip rule show
ip route show table app_traffic
ip route show table mgmt_traffic
```

### ECMP — Equal-Cost Multi-Path Routing

```bash
# ECMP across two uplinks
ip route add 0.0.0.0/0 \
  nexthop via 192.168.1.1 dev eth0 weight 1 \
  nexthop via 192.168.2.1 dev eth1 weight 1

# Configure flow-based hashing (default; keeps per-flow ordering)
sysctl -w net.ipv4.fib_multipath_hash_policy=1

# Verify ECMP is active
ip route show 0.0.0.0/0
```

### VXLAN Overlay

```bash
# VXLAN tunnel between two hosts
# Host A: 192.168.1.10, container IP 10.100.0.1
# Host B: 192.168.1.20, container IP 10.100.0.2

# On Host A
ip link add vxlan100 type vxlan \
  id 100 \
  remote 192.168.1.20 \
  local  192.168.1.10 \
  dstport 4789 \
  dev eth0
ip addr add 10.100.0.1/24 dev vxlan100
ip link set vxlan100 up

# On Host B
ip link add vxlan100 type vxlan \
  id 100 \
  remote 192.168.1.10 \
  local  192.168.1.20 \
  dstport 4789 \
  dev eth0
ip addr add 10.100.0.2/24 dev vxlan100
ip link set vxlan100 up

# Test overlay connectivity
ping -c 3 10.100.0.2

# Show VXLAN FDB
bridge fdb show dev vxlan100
```

---

## Section 8: Network Performance Benchmarking

### iperf3 Methodology

```bash
# Install
apt-get install -y iperf3

# Server
iperf3 -s -p 5201 --daemon

# Single TCP stream
iperf3 -c 192.168.1.10 -p 5201 -t 30

# Multi-stream (saturate 10 GbE)
iperf3 -c 192.168.1.10 -p 5201 -t 30 -P 8

# Bidirectional
iperf3 -c 192.168.1.10 -p 5201 -t 30 -P 4 --bidir

# UDP latency
iperf3 -c 192.168.1.10 -u -b 1G -t 30

# Explicit socket buffer size
iperf3 -c 192.168.1.10 -t 30 -w 8M
```

### netperf for TCP_RR Latency

```bash
# Install
apt-get install -y netperf

# Start server
netserver -p 12865

# TCP request-response latency (microservice simulation)
netperf -H 192.168.1.10 -p 12865 -t TCP_RR -l 30 \
  -- -o min_latency,mean_latency,p50_latency,p99_latency,max_latency

# Expected on 10 GbE same-rack:
# Min: 45 us  Mean: 52 us  P99: 95 us

# Measure connection setup rate
netperf -H 192.168.1.10 -t TCP_CRR -l 30
```

### Network Diagnostic Commands

```bash
# Replacement for netstat — show TCP connections with process
ss -tnp
ss -tnp state established
ss -tnp dport :8080

# Summary statistics
ss -s

# Check for TCP retransmits
ss -oi | awk '/retrans/'

# Real-time per-flow bandwidth
nethogs eth0

# nstat — kernel network counters
nstat -az | grep -E "TcpRetrans|TcpExtTCPSyn"

# Packet capture
tcpdump -i eth0 -w /tmp/capture.pcap -c 10000 port 8080

# Analyze with tshark
tshark -r /tmp/capture.pcap -q -z io,stat,1
tshark -r /tmp/capture.pcap -q -z conv,tcp | head -30
```

---

## Section 9: Kubernetes CNI Networking Internals

### Inspecting CNI Operation

```bash
# List installed CNI plugins
ls /opt/cni/bin/

# Current CNI configuration
ls /etc/cni/net.d/
cat /etc/cni/net.d/10-flannel.conflist

# Pod network routes
ip route show | grep -E "10.244|cni|flannel"

# Show bridge device used by CNI
bridge link show
ip link show type bridge

# Pod-to-pod connectivity test
kubectl exec -it pod-a -- ping 10.244.1.5
```

### Cilium eBPF Networking

```bash
# Cilium status
cilium status --verbose

# List all endpoints (pods)
cilium endpoint list

# BPF conntrack table
cilium bpf ct list global | head -20

# Monitor network events in real time
cilium monitor --type drop
cilium monitor --type trace --from-endpoint 1234

# Check loaded eBPF programs
bpftool prog show | grep cilium

# Bandwidth manager (per-pod rate limiting via eBPF)
cilium config set enable-bandwidth-manager=true
```

Advanced Linux networking spans from isolated namespace topology through precise traffic shaping to high-performance kernel bypass via XDP. Namespaces provide isolation, veth pairs and bridges provide connectivity, tc provides policy enforcement, and XDP provides the escape hatch for workloads needing per-packet processing at line rate. Mastering these tools enables precise diagnosis of production network issues and efficient solutions that avoid the cost and complexity of external hardware appliances.
