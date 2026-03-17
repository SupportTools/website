---
title: "Linux Network QoS: Traffic Shaping with tc and HTB for Container Egress"
date: 2031-06-06T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "QoS", "tc", "HTB", "Kubernetes", "Containers"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux traffic shaping with tc and HTB including hierarchical token bucket configuration, per-container rate limiting, tc actions for packet marking, Kubernetes NetworkPolicy QoS extensions, and measurement with iperf3."
more_link: "yes"
url: "/linux-network-qos-traffic-shaping-tc-htb-container-egress-guide/"
---

Network Quality of Service (QoS) with Linux tc (traffic control) gives you precise control over bandwidth allocation, latency guarantees, and burst handling for container workloads. Without QoS, a single misbehaving container can saturate a node's network interface and cause latency spikes for all other containers. This guide covers the complete HTB (Hierarchical Token Bucket) configuration for per-container rate limiting, filter matching for traffic classification, and integration with Kubernetes network policies.

<!--more-->

# Linux Network QoS: Traffic Shaping with tc and HTB for Container Egress

## Section 1: Linux Traffic Control Architecture

The Linux traffic control subsystem (tc) manages how packets are queued, prioritized, and shaped on network interfaces. Understanding its three-layer architecture is essential before configuring QoS:

### qdisc (Queuing Discipline)

A qdisc is attached to a network interface and determines how packets are queued and dequeued. Every interface has a qdisc. The default is `pfifo_fast` (a simple FIFO queue).

### classes

Classes are subdivision within a classful qdisc (like HTB). Traffic is sorted into classes and each class can have bandwidth guarantees and limits.

### filters

Filters classify packets into classes. They match on IP headers, port numbers, marks, and other packet attributes.

```
Network Interface (eth0)
└── root qdisc (HTB)
    ├── class 1:1 (root class, 1Gbps total)
    │   ├── class 1:10 (container-1, guaranteed 100Mbps, max 200Mbps)
    │   ├── class 1:20 (container-2, guaranteed 200Mbps, max 500Mbps)
    │   └── class 1:30 (default, guaranteed 10Mbps, max 100Mbps)
    └── filters (iptables marks or IP matches -> class 1:10, 1:20, 1:30)
```

## Section 2: HTB Fundamentals

HTB (Hierarchical Token Bucket) is the standard qdisc for bandwidth sharing and rate limiting on Linux. It provides:

- **Guaranteed rate (rate)**: Minimum bandwidth always available to a class
- **Ceiling rate (ceil)**: Maximum bandwidth a class can use when others are idle
- **Burst**: Amount of data allowed at full line rate before token bucket kicks in
- **cburst**: Burst size for the ceiling rate

### Basic HTB Configuration

```bash
# Set up HTB on a network interface with 1Gbps total bandwidth
IFACE=eth0
RATE=1gbit

# Step 1: Remove existing qdisc (ignore errors if none exists)
tc qdisc del dev $IFACE root 2>/dev/null || true

# Step 2: Add HTB as root qdisc
# handle 1: identifies this qdisc
# default 30: unclassified traffic goes to class 1:30
tc qdisc add dev $IFACE root handle 1: htb default 30

# Step 3: Add root class (bandwidth pool)
tc class add dev $IFACE parent 1: classid 1:1 htb rate $RATE burst 15k

# Step 4: Add leaf classes for different traffic types
# Container A: 100Mbps guaranteed, 200Mbps ceiling
tc class add dev $IFACE parent 1:1 classid 1:10 htb \
    rate 100mbit ceil 200mbit burst 15k cburst 15k

# Container B: 200Mbps guaranteed, 500Mbps ceiling
tc class add dev $IFACE parent 1:1 classid 1:20 htb \
    rate 200mbit ceil 500mbit burst 15k cburst 15k

# Default class: 10Mbps guaranteed, 100Mbps ceiling
tc class add dev $IFACE parent 1:1 classid 1:30 htb \
    rate 10mbit ceil 100mbit burst 15k cburst 15k

# Step 5: Add fq_codel qdisc to each leaf for fair queuing + AQM
tc qdisc add dev $IFACE parent 1:10 handle 10: fq_codel
tc qdisc add dev $IFACE parent 1:20 handle 20: fq_codel
tc qdisc add dev $IFACE parent 1:30 handle 30: fq_codel

echo "HTB configuration complete"
tc -s class show dev $IFACE
```

## Section 3: Per-Container Rate Limiting

In a containerized environment, each container runs in a network namespace. To rate-limit per container, you have two main approaches:

1. **Veth pair shaping**: Shape traffic on the host-side veth interface
2. **IFB (Intermediate Functional Block) for ingress**: Redirect ingress traffic to an IFB interface for shaping

### Container Network Namespace Setup (Overview)

```bash
# When a container starts, its network namespace has a veth pair:
# - Container side: eth0 inside the namespace
# - Host side: vethXXXXXX on the host

# Find the host-side veth for a container
CONTAINER_PID=$(docker inspect -f '{{.State.Pid}}' my-container)
VETH=$(ip link | grep "veth" | grep -v "@" | awk -F': ' '{print $2}' | \
    while read iface; do
        if nsenter -t $CONTAINER_PID -n ip link show eth0 | grep -q "$(ip link show $iface | awk '/link\/ether/{print $2}')"; then
            echo $iface
        fi
    done)

echo "Host-side veth: $VETH"
# Or more reliably:
ip link | grep "veth" | while read line; do
    veth=$(echo $line | cut -d: -f2 | tr -d ' ')
    peer_idx=$(ip -n $CONTAINER_PID link show eth0 | awk 'NR==1{print $1}' | tr -d ':')
    if ip link show | grep -q "@if${peer_idx}:"; then
        echo "$veth"
    fi
done
```

### Rate Limiting the Host-Side Veth (Egress from Container)

```bash
#!/bin/bash
# rate-limit-container.sh - Apply rate limits to a specific container
# This limits egress from the container (ingress to the veth from container side)

VETH="$1"          # e.g., veth1234abc
RATE="${2:-10mbit}" # Default 10Mbps
CEIL="${3:-20mbit}" # Default 20Mbps ceiling

if [ -z "$VETH" ]; then
    echo "Usage: $0 <veth-interface> [rate] [ceil]"
    exit 1
fi

# Clean existing config
tc qdisc del dev $VETH root 2>/dev/null || true

# Add HTB root
tc qdisc add dev $VETH root handle 1: htb default 10

# Root class
tc class add dev $VETH parent 1: classid 1:1 htb rate $CEIL burst 15k

# Container class with rate limiting
tc class add dev $VETH parent 1:1 classid 1:10 htb \
    rate $RATE ceil $CEIL burst 15k cburst 15k

# Add fq_codel for fair queuing and latency control
tc qdisc add dev $VETH parent 1:10 handle 10: fq_codel

echo "Rate limit $RATE (ceil $CEIL) applied to $VETH"
tc -s class show dev $VETH
```

### Docker Plugin for Automatic Rate Limiting

```bash
# Docker supports rate limiting via --device-write-bps flags but NOT network rate limiting
# For network rate limiting, use CNI plugins or post-start hooks

# Option 1: Docker post-start hook with inotify on veth creation
# Option 2: Use a CNI plugin that supports bandwidth (e.g., bandwidth CNI plugin)
# Option 3: Use a container runtime hook

# The bandwidth CNI plugin adds rate limiting annotations to pods:
cat > /etc/cni/net.d/10-bandwidth.conf << 'EOF'
{
    "cniVersion": "0.3.1",
    "name": "bandwidth-example",
    "plugins": [
        {
            "type": "bridge",
            "bridge": "mynet0"
        },
        {
            "type": "bandwidth",
            "ingressRate": 104857600,
            "ingressBurst": 209715200,
            "egressRate": 104857600,
            "egressBurst": 209715200
        }
    ]
}
EOF
```

## Section 4: Ingress Rate Limiting with IFB

Shaping ingress (traffic arriving at the container) requires a redirect through an IFB (Intermediate Functional Block) device, because Linux's standard traffic shaping only applies to egress:

```bash
#!/bin/bash
# setup-ingress-shaping.sh - Rate limit ingress to a container

VETH="$1"
INGRESS_RATE="${2:-10mbit}"

# Load IFB module
modprobe ifb

# Create IFB device
ip link add dev ifb0 type ifb
ip link set dev ifb0 up

# Add ingress qdisc to the veth (host side)
tc qdisc add dev $VETH ingress

# Redirect all ingress traffic to ifb0 for shaping
tc filter add dev $VETH parent ffff: \
    protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0

# Now shape on ifb0 (this shapes ingress to the container)
tc qdisc del dev ifb0 root 2>/dev/null || true
tc qdisc add dev ifb0 root handle 1: htb default 10

tc class add dev ifb0 parent 1: classid 1:1 htb rate $INGRESS_RATE burst 15k
tc class add dev ifb0 parent 1:1 classid 1:10 htb \
    rate $INGRESS_RATE ceil $INGRESS_RATE burst 15k

tc qdisc add dev ifb0 parent 1:10 handle 10: fq_codel

echo "Ingress rate limit $INGRESS_RATE applied to $VETH via ifb0"
```

## Section 5: Traffic Classification with Filters

Filters determine which traffic goes to which HTB class. Multiple filter types are available:

### u32 Filter (Universal 32-bit Filter)

```bash
# Match traffic by destination port
# HTTP traffic (port 80) -> class 1:10
tc filter add dev eth0 parent 1:0 protocol ip prio 1 u32 \
    match ip dport 80 0xffff \
    flowid 1:10

# Match by source IP subnet
tc filter add dev eth0 parent 1:0 protocol ip prio 2 u32 \
    match ip src 10.0.1.0/24 \
    flowid 1:20

# Match by destination IP
tc filter add dev eth0 parent 1:0 protocol ip prio 3 u32 \
    match ip dst 10.0.2.5/32 \
    flowid 1:30

# Match TCP traffic with specific source port
tc filter add dev eth0 parent 1:0 protocol ip prio 4 u32 \
    match ip protocol 6 0xff \
    match ip sport 443 0xffff \
    flowid 1:10
```

### fwmark Filter (Match iptables Marks)

A cleaner approach is to use iptables to mark packets and tc filters to classify by mark:

```bash
# Step 1: Mark packets with iptables

# Mark HTTP traffic from container subnet
iptables -t mangle -A POSTROUTING \
    -s 172.17.0.0/24 -p tcp --dport 80 -j MARK --set-mark 10

# Mark HTTPS traffic from container subnet
iptables -t mangle -A POSTROUTING \
    -s 172.17.0.0/24 -p tcp --dport 443 -j MARK --set-mark 10

# Mark database traffic for low-priority class
iptables -t mangle -A POSTROUTING \
    -s 172.17.0.0/24 -p tcp --dport 5432 -j MARK --set-mark 20

# Step 2: Filter by iptables mark in tc
tc filter add dev eth0 parent 1:0 protocol ip prio 1 \
    handle 10 fw flowid 1:10

tc filter add dev eth0 parent 1:0 protocol ip prio 2 \
    handle 20 fw flowid 1:20
```

### cgroup Filter for Container-Based Classification

The cgroup tc filter allows you to classify traffic by cgroup (Linux control group), which directly maps to containers:

```bash
# Step 1: Identify the cgroup path for a Docker container
CONTAINER_ID="abc123def456"
CGROUP_PATH="/sys/fs/cgroup/net_cls/docker/$CONTAINER_ID"

# Step 2: Set the net_cls classid for the container's cgroup
# classid must match the tc class: 0x00010010 = major:minor = 1:16 (hex)
echo 0x00010010 > $CGROUP_PATH/net_cls.classid

# Step 3: Add a cgroup filter in tc
tc filter add dev eth0 parent 1:0 protocol ip prio 1 \
    handle 10 cgroup flowid 1:16
```

## Section 6: Complete Multi-Tenant Rate Limiting Setup

```bash
#!/bin/bash
# multi-tenant-qos.sh
# Sets up per-tenant bandwidth allocation on a multi-tenant Kubernetes node

set -euo pipefail

IFACE="${1:-eth0}"
TOTAL_BW="${2:-1gbit}"

echo "Setting up QoS on $IFACE with total bandwidth $TOTAL_BW"

# Clean existing config
tc qdisc del dev $IFACE root 2>/dev/null || true

# Root HTB qdisc
tc qdisc add dev $IFACE root handle 1: htb default 99

# Root class (total bandwidth pool)
tc class add dev $IFACE parent 1: classid 1:1 htb \
    rate $TOTAL_BW burst 30k

# Tenant A: 500Mbps guaranteed, 800Mbps ceiling (premium)
tc class add dev $IFACE parent 1:1 classid 1:10 htb \
    rate 500mbit ceil 800mbit burst 20k cburst 20k prio 1
tc qdisc add dev $IFACE parent 1:10 handle 10: fq_codel

# Tenant B: 200Mbps guaranteed, 500Mbps ceiling (standard)
tc class add dev $IFACE parent 1:1 classid 1:20 htb \
    rate 200mbit ceil 500mbit burst 15k cburst 15k prio 2
tc qdisc add dev $IFACE parent 1:20 handle 20: fq_codel

# Tenant C: 100Mbps guaranteed, 300Mbps ceiling (basic)
tc class add dev $IFACE parent 1:1 classid 1:30 htb \
    rate 100mbit ceil 300mbit burst 10k cburst 10k prio 3
tc qdisc add dev $IFACE parent 1:30 handle 30: fq_codel

# System/infrastructure traffic: 50Mbps guaranteed, unrestricted ceiling
tc class add dev $IFACE parent 1:1 classid 1:50 htb \
    rate 50mbit ceil $TOTAL_BW burst 5k cburst 5k prio 0
tc qdisc add dev $IFACE parent 1:50 handle 50: fq_codel

# Default class: minimal bandwidth (unclassified traffic)
tc class add dev $IFACE parent 1:1 classid 1:99 htb \
    rate 10mbit ceil 100mbit burst 5k cburst 5k prio 7
tc qdisc add dev $IFACE parent 1:99 handle 99: fq_codel

# Add filters using iptables marks
# Tenant A pods are in 10.0.1.0/24
iptables -t mangle -F POSTROUTING 2>/dev/null || true
iptables -t mangle -A POSTROUTING -s 10.0.1.0/24 -j MARK --set-mark 10
iptables -t mangle -A POSTROUTING -s 10.0.2.0/24 -j MARK --set-mark 20
iptables -t mangle -A POSTROUTING -s 10.0.3.0/24 -j MARK --set-mark 30
# System infrastructure
iptables -t mangle -A POSTROUTING -s 10.0.0.0/24 -j MARK --set-mark 50

# tc filters matching iptables marks
tc filter add dev $IFACE parent 1:0 protocol ip prio 1 handle 10 fw flowid 1:10
tc filter add dev $IFACE parent 1:0 protocol ip prio 2 handle 20 fw flowid 1:20
tc filter add dev $IFACE parent 1:0 protocol ip prio 3 handle 30 fw flowid 1:30
tc filter add dev $IFACE parent 1:0 protocol ip prio 0 handle 50 fw flowid 1:50

echo "QoS configuration complete"
echo ""
echo "=== Classes ==="
tc -s class show dev $IFACE

echo ""
echo "=== Filters ==="
tc -s filter show dev $IFACE
```

## Section 7: Kubernetes NetworkPolicy QoS Extensions

Kubernetes NetworkPolicy provides L4 allow/deny rules but does not provide bandwidth controls natively. The bandwidth CNI plugin and custom admission webhooks fill this gap.

### Kubernetes Bandwidth Annotation (bandwidth CNI)

```yaml
# Pod with bandwidth limits via annotations
apiVersion: v1
kind: Pod
metadata:
  name: limited-pod
  annotations:
    # Kubernetes bandwidth annotations (supported by bandwidth CNI plugin)
    kubernetes.io/ingress-bandwidth: "100M"
    kubernetes.io/egress-bandwidth: "100M"
spec:
  containers:
    - name: app
      image: myapp:1.0
      resources:
        requests:
          cpu: "500m"
          memory: "256Mi"
```

### CNI Bandwidth Plugin Configuration

```json
// /etc/cni/net.d/10-containerd-net.conflist
{
    "cniVersion": "1.0.0",
    "name": "containerd-net",
    "plugins": [
        {
            "type": "bridge",
            "bridge": "cni0",
            "isGateway": true,
            "ipMasq": true,
            "promiscMode": true,
            "ipam": {
                "type": "host-local",
                "ranges": [
                    [{"subnet": "10.88.0.0/16"}]
                ],
                "routes": [
                    {"dst": "0.0.0.0/0"}
                ]
            }
        },
        {
            "type": "portmap",
            "capabilities": {"portMappings": true}
        },
        {
            "type": "bandwidth",
            "capabilities": {"bandwidth": true}
        }
    ]
}
```

### Custom DaemonSet for Node-Level QoS

```yaml
# qos-enforcer-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: qos-enforcer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: qos-enforcer
  template:
    metadata:
      labels:
        app: qos-enforcer
    spec:
      hostNetwork: true
      hostPID: true
      tolerations:
        - operator: Exists
      containers:
        - name: enforcer
          image: qos-enforcer:1.0
          securityContext:
            privileged: true
            capabilities:
              add: [NET_ADMIN, NET_RAW]
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: host-net
              mountPath: /host/net
              readOnly: true
            - name: tc-socket
              mountPath: /run/tc
      volumes:
        - name: host-net
          hostPath:
            path: /proc/net
        - name: tc-socket
          hostPath:
            path: /run/tc
```

## Section 8: Measuring Traffic Shaping with iperf3

Verifying that QoS rules are working requires measurement. iperf3 is the standard tool:

### Basic iperf3 Testing

```bash
# Start iperf3 server (on the destination)
iperf3 -s -p 5201

# Run bandwidth test (on the source)
iperf3 -c <server-ip> -p 5201 -t 30 -b 0  # Unlimited rate test

# Test with specific target rate
iperf3 -c <server-ip> -p 5201 -t 30 -b 200M

# UDP test (better for latency measurement)
iperf3 -c <server-ip> -p 5201 -u -t 30 -b 100M

# Bidirectional test
iperf3 -c <server-ip> -p 5201 --bidir -t 30

# Multiple parallel streams
iperf3 -c <server-ip> -p 5201 -P 8 -t 30
```

### Verifying Per-Container Rate Limits

```bash
#!/bin/bash
# test-container-rate-limit.sh

CONTAINER_NAME="rate-limited-app"
SERVER_IP="10.0.1.100"
EXPECTED_RATE_MBPS=100

# Run iperf3 from inside the container
ACTUAL_RATE=$(docker exec $CONTAINER_NAME \
    iperf3 -c $SERVER_IP -p 5201 -t 10 -f m \
    | grep "sender" | awk '{print $(NF-2)}')

echo "Expected rate: ${EXPECTED_RATE_MBPS} Mbps"
echo "Actual rate:   ${ACTUAL_RATE} Mbps"

# Check if actual rate is within 10% of expected
LOWER=$(echo "$EXPECTED_RATE_MBPS * 0.9" | bc)
UPPER=$(echo "$EXPECTED_RATE_MBPS * 1.1" | bc)

if (( $(echo "$ACTUAL_RATE >= $LOWER && $ACTUAL_RATE <= $UPPER" | bc -l) )); then
    echo "PASS: Rate within 10% of expected"
else
    echo "FAIL: Rate $ACTUAL_RATE Mbps is outside expected range $LOWER-$UPPER Mbps"
fi
```

### Monitoring tc Statistics

```bash
# View current statistics for all classes
tc -s class show dev eth0

# Sample output:
# class htb 1:10 parent 1:1 leaf 10:
#  rate 100Mbit ceil 200Mbit burst 15Kb cburst 15Kb
#  Sent 1048576000 bytes 7142857 pkt (dropped 0, overlimits 0 requeues 0)
#  rate 99.8Mbit 85714pps backlog 0b 0p requeues 0
#  lended: 5714285 borrowed: 0 giants: 0
#  tokens: 235520 ctokens: 235520

# View filter statistics
tc -s filter show dev eth0

# Monitor statistics over time
watch -n1 'tc -s class show dev eth0 | grep -A5 "class htb 1:10"'

# Export to Prometheus format (custom script)
while true; do
    tc -s class show dev eth0 | awk '
    /class htb/ {
        class=$3
    }
    /Sent/ {
        bytes=$2
        print "tc_class_bytes{class=\"" class "\"} " bytes
    }
    ' | curl -X POST --data-binary @- http://pushgateway:9091/metrics/job/tc_stats/instance/$(hostname)
    sleep 15
done
```

## Section 9: DSCP Marking for L3 QoS

For networks that support DSCP-based QoS (common in enterprise data centers), tc can mark packets with DSCP values:

```bash
# Mark packets with DSCP EF (Expedited Forwarding) for real-time traffic
# DSCP EF = 46 decimal = 0xB8 in the TOS byte (shifted to 6 bits)
tc filter add dev eth0 parent 1:0 protocol ip prio 1 u32 \
    match ip sport 5004 0xffff \
    action pedit ex munge ip dsfield set 0xB8 pipe \
    flowid 1:10

# Mark with DSCP AF31 (medium priority)
# DSCP AF31 = 26 decimal = 0x68 in TOS byte
tc filter add dev eth0 parent 1:0 protocol ip prio 2 u32 \
    match ip dport 8080 0xffff \
    action pedit ex munge ip dsfield set 0x68 pipe \
    flowid 1:20

# Verify marks are applied
tcpdump -i eth0 -v 'ip[1] & 0xfc > 0' | head -20
```

## Section 10: Troubleshooting Traffic Shaping

### Diagnosing Rate Limiting Issues

```bash
#!/bin/bash
# diagnose-tc.sh - Diagnostic script for tc issues

IFACE="${1:-eth0}"

echo "=== Interface Status ==="
ip -s link show $IFACE

echo ""
echo "=== Root Qdisc ==="
tc qdisc show dev $IFACE

echo ""
echo "=== HTB Classes ==="
tc -s class show dev $IFACE

echo ""
echo "=== Filters ==="
tc -s filter show dev $IFACE

echo ""
echo "=== iptables Marks ==="
iptables -t mangle -L POSTROUTING -v -n | grep MARK

echo ""
echo "=== Dropped Packets by Class ==="
tc -s class show dev $IFACE | awk '
/class htb/ { class=$3 }
/Sent/ {
    dropped=$(NF-3)
    if (dropped+0 > 0) {
        print class ": " dropped " dropped"
    }
}
'
```

### Common Issues

**Traffic not being classified:**
```bash
# Verify iptables marks are being set
iptables -t mangle -L POSTROUTING -v -n | grep packets

# Check if marks are surviving routing
conntrack -L | grep "mark=" | head

# Test with a specific flow
iperf3 -c 10.0.1.100 -p 5201 -t 5
tc -s class show dev eth0 | grep -A3 "1:10"  # Check if bytes increase
```

**HTB not limiting correctly:**
```bash
# Verify burst settings are not too high
# Rule of thumb: burst = rate * 10ms
# For 100Mbps rate: burst = 100000000 * 0.010 / 8 = 125000 bytes = ~122KB
# If burst is too large, HTB can overshoot the rate limit initially

# Check clock settings
tc -s qdisc show dev eth0 | grep -i htb
```

**fq_codel causing issues:**
```bash
# fq_codel can delay bursts. If you need strict rate limiting, use tbf instead:
tc qdisc change dev eth0 parent 1:10 handle 10: tbf \
    rate 100mbit burst 32kbit latency 50ms
```

## Section 11: Persistent QoS with systemd

QoS rules are lost on reboot. Use a systemd service to restore them:

```ini
# /etc/systemd/system/network-qos.service
[Unit]
Description=Network QoS Traffic Shaping
After=network.target
Wants=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/setup-qos.sh eth0 1gbit
ExecStop=/sbin/tc qdisc del dev eth0 root

[Install]
WantedBy=multi-user.target
```

```bash
# Install and enable
cp setup-qos.sh /usr/local/bin/setup-qos.sh
chmod +x /usr/local/bin/setup-qos.sh
systemctl daemon-reload
systemctl enable network-qos
systemctl start network-qos
```

## Conclusion

HTB-based traffic shaping with tc provides fine-grained control over bandwidth allocation in containerized environments. The key operational concepts are: classful qdiscs for traffic hierarchy, fwmark-based filters for container identification (far more maintainable than IP-based filters), fq_codel at leaf nodes for fair queuing and latency management, and IFB devices for ingress rate limiting. For Kubernetes environments, the bandwidth CNI plugin provides the cleanest integration, while a custom DaemonSet can enforce node-level policies dynamically. Always measure with iperf3 after applying rules to verify that the configured rates match observed behavior — tc's burst and cburst settings can cause measured rates to differ significantly from configured rates in short-duration tests.
