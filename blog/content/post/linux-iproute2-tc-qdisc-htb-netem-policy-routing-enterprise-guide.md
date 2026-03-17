---
title: "Linux iproute2 Advanced: tc qdisc, HTB Bandwidth Shaping, netem Network Emulation, and ip rule Policy Routing"
date: 2032-02-05T00:00:00-05:00
draft: false
tags: ["Linux", "iproute2", "tc", "Traffic Control", "HTB", "netem", "Policy Routing", "Networking", "QoS"]
categories: ["Linux", "Networking", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linux iproute2 advanced networking: configuring tc qdisc hierarchies with HTB for bandwidth shaping, using netem for realistic network emulation in CI pipelines, and implementing ip rule policy-based routing for multi-path and multi-homed environments."
more_link: "yes"
url: "/linux-iproute2-tc-qdisc-htb-netem-policy-routing-enterprise-guide/"
---

The `iproute2` suite — `ip`, `tc`, `ss`, `bridge` — is the authoritative toolset for Linux network configuration, replacing the deprecated `net-tools` (`ifconfig`, `route`, `netstat`) package. While most engineers use `ip addr` and `ip route` daily, the traffic control (`tc`) subsystem and policy routing framework are far less understood despite being essential for production network engineering, QoS enforcement, and realistic integration testing.

This guide covers the complete `tc` queueing discipline hierarchy, HTB-based multi-class bandwidth shaping, netem-based network emulation with precise loss and delay profiles, and multi-table policy routing for enterprise multi-homed environments.

<!--more-->

# Linux iproute2 Advanced: Traffic Control, HTB Shaping, netem Emulation, and Policy Routing

## The Linux Traffic Control Architecture

Traffic control in Linux operates on a three-layer model:

1. **qdisc (queuing discipline)**: The queue attached to a network interface. Controls how packets are stored and dequeued for transmission.
2. **class**: A subdivision within a classful qdisc (HTB, CBQ, HFSC). Classes can be nested.
3. **filter**: Rules that classify incoming packets and assign them to classes.

```
                    ┌─────────────────────────────┐
  Outgoing packets  │         root qdisc          │
  ─────────────────▶│  (e.g., HTB handle 1:0)     │
                    │                             │
                    │  ┌──────────┐ ┌──────────┐  │
                    │  │ class 1:1│ │ class 1:2│  │
                    │  │ 100Mbps  │ │  50Mbps  │  │
                    │  └────┬─────┘ └────┬─────┘  │
                    │       │            │         │
                    │  ┌────┴──┐    ┌───┴───┐     │
                    │  │ leaf  │    │ leaf  │     │
                    │  │ qdisc │    │ qdisc │     │
                    │  └───────┘    └───────┘     │
                    └─────────────────────────────┘
```

### Viewing Current qdisc Configuration

```bash
# Show all qdiscs on all interfaces
tc qdisc show

# Show qdiscs for a specific interface
tc qdisc show dev eth0

# Show class hierarchy
tc class show dev eth0

# Show filters
tc filter show dev eth0
```

## Classless vs. Classful qdiscs

### Classless qdiscs

Classless qdiscs process all packets as a single stream:

| qdisc | Use Case |
|---|---|
| `pfifo_fast` | Default Linux qdisc, 3-band FIFO based on TOS |
| `fq_codel` | Flow queue + CoDel, best general-purpose qdisc |
| `sfq` | Stochastic Fair Queuing, hash-based fairness |
| `tbf` | Token Bucket Filter, rate limiting |
| `netem` | Network emulator (delay, loss, corruption, reorder) |

### Classful qdiscs

Classful qdiscs support multiple classes with different scheduling:

| qdisc | Use Case |
|---|---|
| `htb` | Hierarchical Token Bucket, general bandwidth shaping |
| `hfsc` | Hierarchical Fair Service Curve, latency-sensitive |
| `cbq` | Class Based Queuing (legacy, use HTB instead) |
| `prio` | Priority-based scheduling |

## HTB: Hierarchical Token Bucket

HTB is the de facto standard for bandwidth shaping on Linux. It provides:

- Guaranteed minimum bandwidth per class (`rate`)
- Maximum burst bandwidth per class (`ceil`)
- Borrowing from parent when unused bandwidth is available
- Burst tokens for short-lived traffic spikes

### Understanding HTB Terminology

```
rate:  Guaranteed bandwidth (always available to this class)
ceil:  Maximum bandwidth (available when parent has slack)
burst: Number of bytes to send at wire speed before throttling
cburst: Burst size at the ceiling rate
prio:  Priority (lower number = higher priority for borrowing)
```

### Basic HTB Setup: Three-Class Shaping

Shape an interface to 100Mbps total, with separate classes for real-time, bulk, and best-effort traffic:

```bash
# Step 1: Create root HTB qdisc
tc qdisc add dev eth0 root handle 1: htb default 30

# Step 2: Create root class (total available bandwidth)
tc class add dev eth0 parent 1: classid 1:1 htb \
    rate 100mbit \
    burst 15k

# Step 3: Create child classes
# Real-time traffic (VoIP, video): guaranteed 40Mbps, can burst to 100Mbps
tc class add dev eth0 parent 1:1 classid 1:10 htb \
    rate 40mbit \
    ceil 100mbit \
    burst 6k \
    prio 1

# Bulk traffic (backups, large uploads): guaranteed 50Mbps, max 80Mbps
tc class add dev eth0 parent 1:1 classid 1:20 htb \
    rate 50mbit \
    ceil 80mbit \
    burst 6k \
    prio 2

# Best-effort (default class): guaranteed 10Mbps, max 100Mbps
tc class add dev eth0 parent 1:1 classid 1:30 htb \
    rate 10mbit \
    ceil 100mbit \
    burst 6k \
    prio 3

# Step 4: Attach leaf qdiscs to each class (fq_codel for flow fairness)
tc qdisc add dev eth0 parent 1:10 handle 10: fq_codel
tc qdisc add dev eth0 parent 1:20 handle 20: fq_codel
tc qdisc add dev eth0 parent 1:30 handle 30: fq_codel

# Step 5: Add filters to classify traffic
# Real-time: DSCP EF (Expedited Forwarding, 0xb8)
tc filter add dev eth0 parent 1:0 protocol ip prio 1 \
    u32 match ip tos 0xb8 0xff \
    flowid 1:10

# Bulk: port 22 (SSH/SCP) and port 9000 (Prometheus remote write)
tc filter add dev eth0 parent 1:0 protocol ip prio 2 \
    u32 match ip dport 22 0xffff \
    flowid 1:20
tc filter add dev eth0 parent 1:0 protocol ip prio 2 \
    u32 match ip dport 9000 0xffff \
    flowid 1:20
```

### Verifying HTB Configuration

```bash
# Check class statistics (bytes, packets, drops)
tc -s class show dev eth0

# Watch class statistics in real time
watch -n 1 "tc -s class show dev eth0"

# Example output
# class htb 1:10 parent 1:1 prio 1 rate 40Mbit ceil 100Mbit burst 7500b cburst 1600b
#  Sent 1048576 bytes 1024 pkt (dropped 0, overlimits 0 requeues 0)
#  rate 8002bit 8pps backlog 0b 0p requeues 0
#  lended: 12 borrowed: 8 giants: 0
#  tokens: 187500 ctokens: 200000
```

### Rate Limiting a Specific IP or Subnet

```bash
# Limit traffic to/from 10.0.0.100 to 5Mbps
tc qdisc add dev eth0 root handle 1: htb default 10

tc class add dev eth0 parent 1: classid 1:1 htb rate 1000mbit

# Default class: no limiting
tc class add dev eth0 parent 1:1 classid 1:10 htb \
    rate 1000mbit ceil 1000mbit

# Limited class: 5Mbps
tc class add dev eth0 parent 1:1 classid 1:20 htb \
    rate 5mbit ceil 5mbit burst 10k

tc qdisc add dev eth0 parent 1:20 handle 20: fq_codel

# Filter: send 10.0.0.100 traffic to limited class
tc filter add dev eth0 parent 1:0 protocol ip prio 1 \
    u32 match ip dst 10.0.0.100/32 \
    flowid 1:20
tc filter add dev eth0 parent 1:0 protocol ip prio 1 \
    u32 match ip src 10.0.0.100/32 \
    flowid 1:20
```

### HTB with iptables MARK-Based Classification

For complex classification logic, use iptables to mark packets and then match marks with `tc filter`:

```bash
# iptables: mark port 8080 traffic with 0x10
iptables -t mangle -A OUTPUT -p tcp --dport 8080 -j MARK --set-mark 0x10
iptables -t mangle -A PREROUTING -p tcp --sport 8080 -j MARK --set-mark 0x10

# tc filter: classify marked packets to class 1:10
tc filter add dev eth0 parent 1:0 protocol ip prio 1 \
    handle 0x10 fw \
    flowid 1:10
```

## netem: Network Emulator qdisc

`netem` simulates real-world network impairments: latency, jitter, packet loss, duplication, corruption, and reordering. It's invaluable for:

- Testing application resilience before production deployment
- Reproducing intermittent failures in CI pipelines
- Validating timeout and retry logic
- Simulating cross-region or cross-continent latency

### Basic Delay Injection

```bash
# Add 100ms fixed delay to all outbound packets on lo
tc qdisc add dev lo root netem delay 100ms

# Add 100ms ± 20ms jitter (uniform distribution)
tc qdisc add dev lo root netem delay 100ms 20ms

# Add 100ms ± 20ms jitter with 25% correlation between consecutive packets
# (correlation models burst behavior better than independent jitter)
tc qdisc add dev lo root netem delay 100ms 20ms 25%

# Use normal distribution for jitter (more realistic)
tc qdisc add dev lo root netem delay 100ms 20ms distribution normal

# Use pareto distribution (heavy-tailed, models network bursts)
tc qdisc add dev lo root netem delay 100ms 20ms distribution pareto
```

### Packet Loss Simulation

```bash
# Simple random loss: 1% of packets dropped
tc qdisc add dev eth0 root netem loss 1%

# Gilbert-Elliott model: burst loss (more realistic than random)
# p=probability of entering loss state, r=probability of leaving loss state
tc qdisc add dev eth0 root netem loss gemodel 1% 10% 5% 0%

# State model:
# 1% chance of entering "bad" state per packet
# 10% chance of leaving "bad" state per packet
# 5% of packets lost in "bad" state
# 0% of packets lost in "good" state
```

### Combining Impairments

```bash
# Realistic WAN simulation: 80ms delay, 5ms jitter, 0.1% loss, 0.01% corruption
tc qdisc add dev eth0 root netem \
    delay 80ms 5ms 10% \
    loss 0.1% \
    corrupt 0.01%

# Simulate mobile network (high latency + jitter + loss + reordering)
tc qdisc add dev eth0 root netem \
    delay 150ms 50ms 30% \
    loss random 2% \
    duplicate 0.1% \
    reorder 5% 50%
    # reorder: 5% of packets reordered, with 50% correlation
```

### Bandwidth Limiting with netem + tbf

`netem` alone does not limit bandwidth — combine it with Token Bucket Filter:

```bash
# Simulate a 10Mbps link with 50ms RTT latency
# tbf handles rate limiting; netem handles delay

# Add netem as child of tbf
tc qdisc add dev eth0 root handle 1: tbf \
    rate 10mbit \
    burst 10kb \
    latency 50ms

tc qdisc add dev eth0 parent 1:1 handle 10: netem delay 25ms
```

### Applying netem to Specific Ports Only (with HTB)

```bash
# Create HTB root
tc qdisc add dev eth0 root handle 1: htb default 10

# Class 10: normal traffic
tc class add dev eth0 parent 1: classid 1:10 htb rate 1000mbit

# Class 20: impaired traffic (for testing)
tc class add dev eth0 parent 1: classid 1:20 htb rate 1000mbit

# Attach netem only to class 20
tc qdisc add dev eth0 parent 1:20 handle 20: netem delay 200ms loss 5%

# Filter: only port 8080 gets impaired
tc filter add dev eth0 parent 1: protocol ip prio 1 \
    u32 match ip dport 8080 0xffff \
    flowid 1:20
```

### Cleaning Up netem Rules

```bash
# Remove all qdiscs from interface (returns to default pfifo_fast)
tc qdisc del dev eth0 root

# Remove all qdiscs from loopback
tc qdisc del dev lo root 2>/dev/null || true
```

### netem in CI Pipelines

A common CI pattern for integration testing:

```bash
#!/bin/bash
# test-with-impairments.sh

IFACE="lo"
DELAY_MS=100
LOSS_PERCENT=1

setup_netem() {
    tc qdisc add dev "$IFACE" root netem \
        delay "${DELAY_MS}ms" 10ms 10% \
        loss "${LOSS_PERCENT}%"
    echo "Network impairment enabled: ${DELAY_MS}ms delay, ${LOSS_PERCENT}% loss"
}

teardown_netem() {
    tc qdisc del dev "$IFACE" root 2>/dev/null || true
    echo "Network impairment removed"
}

trap teardown_netem EXIT

setup_netem
# Run integration tests
go test ./... -run TestNetworkResilience -timeout 120s
```

## ip rule: Policy-Based Routing

Linux maintains multiple routing tables simultaneously (default: up to 255). `ip rule` controls which routing table is consulted based on packet attributes (source IP, destination IP, TOS, firewall mark, interface).

### Understanding Routing Tables

```bash
# List all routing tables with rules
ip rule show

# Default output:
# 0:      from all lookup local      (local loopback/broadcast)
# 32766:  from all lookup main       (standard routes)
# 32767:  from all lookup default    (empty by default)

# List routes in the main table
ip route show table main

# List routes in the local table
ip route show table local

# List all named tables
cat /etc/iproute2/rt_tables
```

### Named Routing Tables

Define custom tables in `/etc/iproute2/rt_tables`:

```bash
# /etc/iproute2/rt_tables
# (append these lines)
200     isp1
201     isp2
202     vpn
203     management
```

### Multi-Homed Server: Two Default Gateways

A server with two uplinks (ISP1 on eth0, ISP2 on eth1) needs policy routing to ensure return traffic exits through the correct interface:

```bash
# Network layout:
# eth0: 192.168.1.100/24, gateway 192.168.1.1 (ISP1)
# eth1: 10.0.0.100/24,   gateway 10.0.0.1   (ISP2)

# Step 1: Populate routing tables for each ISP
ip route add default via 192.168.1.1 table isp1
ip route add 192.168.1.0/24 dev eth0 src 192.168.1.100 table isp1

ip route add default via 10.0.0.1 table isp2
ip route add 10.0.0.0/24 dev eth1 src 10.0.0.100 table isp2

# Step 2: Add policy rules
# Traffic FROM 192.168.1.100 → use isp1 table
ip rule add from 192.168.1.100 table isp1 priority 100

# Traffic FROM 10.0.0.100 → use isp2 table
ip rule add from 10.0.0.100 table isp2 priority 101

# Step 3: Verify
ip rule show
# 100:    from 192.168.1.100 lookup isp1
# 101:    from 10.0.0.100 lookup isp2
# 32766:  from all lookup main
```

### Policy Routing by Destination Subnet

Route traffic to specific subnets through a VPN gateway, regardless of source:

```bash
# VPN gateway at 172.16.0.1, accessible via eth0
# All traffic to 10.0.0.0/8 should go through VPN

# Add VPN route to a dedicated table
ip route add 10.0.0.0/8 via 172.16.0.1 table vpn

# Add rule: any packet destined for 10.0.0.0/8 uses vpn table
ip rule add to 10.0.0.0/8 table vpn priority 50

# Verify
ip rule show | grep vpn
ip route show table vpn
```

### Policy Routing by Firewall Mark

Combine iptables marking with policy routing for complex traffic steering:

```bash
# Use Case: route HTTP traffic through proxy, everything else direct

# Mark HTTP traffic
iptables -t mangle -A OUTPUT -p tcp --dport 80 -j MARK --set-mark 1
iptables -t mangle -A OUTPUT -p tcp --dport 443 -j MARK --set-mark 1

# Create routing table for marked packets
ip route add default via 10.10.10.1 table 100  # proxy gateway

# Route marked packets through proxy table
ip rule add fwmark 1 table 100 priority 50
```

### Making Policy Routes Persistent (systemd-networkd)

For persistent policy routing on systemd-based systems, use `.network` files:

```ini
# /etc/systemd/network/20-eth0.network
[Match]
Name=eth0

[Address]
Address=192.168.1.100/24

[Route]
Gateway=192.168.1.1
Table=isp1

[Route]
Destination=192.168.1.0/24
Scope=link
Table=isp1

[RoutingPolicyRule]
From=192.168.1.100
Table=isp1
Priority=100
```

### Persistent Routes via NetworkManager

For RHEL/CentOS/Rocky with NetworkManager:

```bash
# /etc/sysconfig/network-scripts/route-eth0
ADDRESS0=10.0.0.0
NETMASK0=255.0.0.0
GATEWAY0=172.16.0.1
TABLE0=vpn

# /etc/sysconfig/network-scripts/rule-eth0
from 10.0.0.100 table vpn priority 100
```

### Policy Routing for VRF (Virtual Routing and Forwarding)

Linux VRF provides complete L3 domain isolation — equivalent to MPLS VRFs:

```bash
# Create VRF device
ip link add vrf-mgmt type vrf table management
ip link set vrf-mgmt up

# Assign interfaces to the VRF
ip link set eth2 master vrf-mgmt

# Routes in the VRF are isolated to the management table
ip route add 192.168.100.0/24 via 192.168.99.1 vrf vrf-mgmt

# Process binding: ssh on management interface only
# (Application must bind to the VRF interface or use SO_BINDTODEVICE)
```

## Advanced Filters: u32, BPF, and flower

### u32 Classifier

The `u32` (32-bit match) classifier allows arbitrary byte-level packet matching:

```bash
# Match IPv4 destination port 443 (HTTPS)
# IP header starts at byte 0; TCP destination port at offset 22
tc filter add dev eth0 parent 1: protocol ip prio 1 \
    u32 match ip dport 443 0xffff \
    flowid 1:10

# Match IP TTL between 64 and 64 (single-hop traffic)
tc filter add dev eth0 parent 1: protocol ip prio 2 \
    u32 match ip ttl 64 0xff \
    flowid 1:20

# Match TOS byte (DSCP CS7 = network control, 0xe0 in high 6 bits)
tc filter add dev eth0 parent 1: protocol ip prio 1 \
    u32 match ip tos 0xe0 0xe0 \
    flowid 1:10
```

### BPF Classifier (eBPF-based Filtering)

For complex classification logic, attach an eBPF program to `tc`:

```bash
# Compile BPF program
clang -O2 -target bpf -c classifier.c -o classifier.o

# Attach to tc filter (ingress)
tc qdisc add dev eth0 ingress
tc filter add dev eth0 parent ffff: \
    bpf obj classifier.o sec tc \
    direct-action
```

### flower Classifier (Flow-Level Matching)

`flower` provides high-level flow-based matching and is the foundation of hardware offload:

```bash
# Match specific source MAC + VLAN
tc filter add dev eth0 parent 1: protocol 802.1Q prio 1 \
    flower \
    vlan_id 100 \
    src_mac 00:11:22:33:44:55 \
    action mirred egress redirect dev vlan100

# Match specific IP 5-tuple
tc filter add dev eth0 parent 1: protocol ip prio 1 \
    flower \
    ip_proto tcp \
    dst_ip 10.0.0.0/8 \
    dst_port 8080 \
    action skbedit mark 1
```

## Ingress Traffic Shaping with ifb

`tc` natively only shapes egress (outbound) traffic. To shape ingress (inbound), redirect incoming packets to an IFB (Intermediate Functional Block) device:

```bash
# Load IFB kernel module
modprobe ifb

# Create and bring up IFB device
ip link add ifb0 type ifb
ip link set ifb0 up

# Attach ingress qdisc to real interface
tc qdisc add dev eth0 ingress

# Redirect all ingress traffic to ifb0
tc filter add dev eth0 parent ffff: protocol ip u32 \
    match u32 0 0 \
    action mirred egress redirect dev ifb0

# Now shape on ifb0 (all traffic here was originally ingress on eth0)
tc qdisc add dev ifb0 root handle 1: htb default 10
tc class add dev ifb0 parent 1: classid 1:10 htb rate 100mbit
tc class add dev ifb0 parent 1:10 classid 1:20 htb rate 50mbit ceil 100mbit
```

## Monitoring and Debugging Traffic Control

### Viewing Statistics

```bash
# Detailed qdisc statistics including drops
tc -s -d qdisc show dev eth0

# Class statistics
tc -s class show dev eth0

# Filter dump with bytecounts
tc -s filter show dev eth0
```

### Using ss to Inspect Socket Buffers

```bash
# Show all TCP sockets with send/receive buffer info
ss -tmni

# Show sockets with congestion control info
ss -ti

# Filter by destination port
ss -tn dst :443
```

### Measuring Actual Throughput

```bash
# Install iperf3 for throughput testing
# Server side:
iperf3 -s -p 5201

# Client side (test shaping on server):
iperf3 -c <server-ip> -p 5201 -t 30 -P 4

# One-directional test:
iperf3 -c <server-ip> -p 5201 -t 30 --udp -b 50m
```

### Automated netem Testing Script

```bash
#!/bin/bash
# network-chaos-test.sh
# Runs a suite of tests under different network conditions

set -euo pipefail

IFACE="${1:-lo}"
TARGET="${2:-localhost}"
PORT="${3:-8080}"

declare -A SCENARIOS=(
    ["fast"]="delay 1ms"
    ["lan"]="delay 5ms 1ms"
    ["wan_us"]="delay 40ms 5ms 5% loss 0.1%"
    ["wan_eu"]="delay 80ms 10ms 10% loss 0.2%"
    ["mobile_4g"]="delay 30ms 10ms 20% loss 0.5%"
    ["mobile_3g"]="delay 100ms 30ms 30% loss 1%"
    ["satellite"]="delay 600ms 50ms 10% loss 0.5%"
    ["packet_loss"]="delay 10ms loss 5%"
    ["high_jitter"]="delay 50ms 40ms"
)

run_scenario() {
    local name="$1"
    local params="$2"

    echo "=== Scenario: $name ==="
    tc qdisc del dev "$IFACE" root 2>/dev/null || true
    # shellcheck disable=SC2086
    tc qdisc add dev "$IFACE" root netem $params

    echo "Running tests..."
    curl -sf --max-time 5 "http://${TARGET}:${PORT}/healthz" && \
        echo "  Health check: PASS" || echo "  Health check: FAIL"

    # Measure actual latency
    avg_latency=$(for i in $(seq 1 10); do
        curl -sf -o /dev/null -w "%{time_total}\n" \
            "http://${TARGET}:${PORT}/api/v1/ping" 2>/dev/null || echo "999"
    done | awk '{sum+=$1} END {printf "%.3f", sum/NR}')
    echo "  Average latency: ${avg_latency}s"
}

for name in "${!SCENARIOS[@]}"; do
    run_scenario "$name" "${SCENARIOS[$name]}"
done

tc qdisc del dev "$IFACE" root 2>/dev/null || true
echo "All scenarios complete. Network restored."
```

## Production Operational Notes

### Loading tc Configuration at Boot (systemd)

```ini
# /etc/systemd/system/tc-shaping.service
[Unit]
Description=Traffic control shaping rules
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/apply-tc-rules.sh
ExecStop=/usr/local/bin/remove-tc-rules.sh

[Install]
WantedBy=multi-user.target
```

```bash
# /usr/local/bin/apply-tc-rules.sh
#!/bin/bash
set -euo pipefail

IFACE="eth0"

# Clean up any existing rules
tc qdisc del dev "$IFACE" root 2>/dev/null || true

# Apply HTB hierarchy
tc qdisc add dev "$IFACE" root handle 1: htb default 30
tc class add dev "$IFACE" parent 1: classid 1:1 htb rate 1gbit
tc class add dev "$IFACE" parent 1:1 classid 1:10 htb rate 200mbit ceil 1gbit burst 20k prio 1
tc class add dev "$IFACE" parent 1:1 classid 1:20 htb rate 600mbit ceil 900mbit burst 60k prio 2
tc class add dev "$IFACE" parent 1:1 classid 1:30 htb rate 200mbit ceil 1gbit burst 20k prio 3

# Leaf qdiscs
for class in 10 20 30; do
    tc qdisc add dev "$IFACE" parent "1:${class}" handle "${class}:" fq_codel
done

# Filters
tc filter add dev "$IFACE" parent 1: protocol ip prio 1 \
    u32 match ip tos 0xb8 0xff flowid 1:10

tc filter add dev "$IFACE" parent 1: protocol ip prio 2 \
    u32 match ip dport 5044 0xffff flowid 1:20

echo "TC rules applied successfully"
```

## Summary

The `iproute2` traffic control subsystem is one of the most powerful and underutilized components of Linux networking. Key takeaways:

- Use `tc qdisc` with `htb` for production bandwidth shaping — it provides guaranteed rates with borrowing semantics.
- Attach `fq_codel` as leaf qdiscs under HTB classes for flow fairness and low latency.
- Use `netem` for CI/CD integration testing — it accurately emulates real-world impairments including burst loss and correlated jitter.
- Use `ip rule` with custom routing tables for multi-homed servers — never rely on source-based routing through the main table.
- Use `iptables` marks + `ip rule fwmark` for complex policy routing that depends on application-level context.
- Persist `tc` rules with a `systemd oneshot` service to survive reboots.
