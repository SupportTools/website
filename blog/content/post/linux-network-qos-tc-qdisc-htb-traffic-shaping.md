---
title: "Linux Network QoS: tc qdisc, HTB, and Traffic Shaping"
date: 2029-10-30T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "QoS", "tc", "HTB", "Traffic Shaping", "Bandwidth Management"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux traffic control: tc architecture, HTB class hierarchy, SFQ fairness queuing, policing vs shaping, bandwidth guarantees, and applying QoS policies to Kubernetes nodes and network namespaces."
more_link: "yes"
url: "/linux-network-qos-tc-qdisc-htb-traffic-shaping/"
---

Linux traffic control (`tc`) is one of the most powerful and least understood networking subsystems in the kernel. It provides the primitives for rate limiting, traffic prioritization, queue management, and packet scheduling that underpin everything from cloud provider bandwidth guarantees to Kubernetes network policies to CDN rate limiting. Understanding `tc` at a fundamental level enables engineers to solve problems that iptables and higher-level tools cannot — like guaranteeing minimum bandwidth to critical services while policing abusive connections.

<!--more-->

# Linux Network QoS: tc qdisc, HTB, and Traffic Shaping

## Section 1: tc Architecture

The traffic control subsystem consists of three types of objects:

- **qdisc (queuing discipline)**: A scheduler that determines how packets are enqueued and dequeued. Every network interface has a root qdisc.
- **class**: A subdivision within a classful qdisc (like HTB). Classes can be nested and have their own qdiscs.
- **filter**: A rule that classifies packets into classes. Filters use tc-flower, u32, or BPF programs.

```
NIC (eth0)
  └── Root qdisc (1:0)          -- HTB root
        ├── Class 1:1            -- Total bandwidth pool: 1Gbit
        │   ├── Class 1:10       -- High priority: 100Mbit guaranteed, 1Gbit burst
        │   │   └── SFQ qdisc    -- Fair queuing within high-priority class
        │   ├── Class 1:20       -- Standard: 500Mbit guaranteed, 800Mbit burst
        │   │   └── SFQ qdisc
        │   └── Class 1:30       -- Bulk: 100Mbit guaranteed, 400Mbit burst
        │       └── SFQ qdisc
        └── Filters
              ├── DSCP EF → class 1:10
              ├── Port 443 → class 1:10
              ├── Port 80 → class 1:20
              └── Default → class 1:30
```

### Handle Numbering

Handles are written as `major:minor`. The root qdisc is `1:0` (or just `1:`). Classes within it are `1:1`, `1:10`, `1:20`, etc. The minor number `0` always refers to the qdisc itself.

```bash
# View current qdisc on an interface
tc qdisc show dev eth0
# qdisc noqueue 0: root refcnt 2

# View with details
tc -s qdisc show dev eth0

# View classes (only for classful qdiscs)
tc class show dev eth0

# View filters
tc filter show dev eth0
```

## Section 2: Classless Qdiscs

Before HTB, it's worth understanding the simpler classless qdiscs.

### pfifo_fast (Default)

The default qdisc. Three priority bands based on TOS/DSCP:

```bash
# The default — usually not optimal for servers
tc qdisc show dev eth0
# qdisc pfifo_fast 0: root refcnt 2 bands 3 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
```

### fq_codel (Fair Queue Controlled Delay)

The best default for most scenarios. Combines fair queuing with AQM (Active Queue Management) to reduce bufferbloat:

```bash
# Replace default with fq_codel
tc qdisc replace dev eth0 root fq_codel \
    target 5ms \
    interval 100ms \
    flows 1024 \
    quantum 1514

# Verify
tc -s qdisc show dev eth0
# qdisc fq_codel 8001: root refcnt 2 limit 10240p flows 1024 quantum 1514 target 5ms interval 100ms memory_limit 32Mb ecn
```

### tbf (Token Bucket Filter) for Simple Rate Limiting

Simple ingress or egress rate limiting without classification:

```bash
# Limit eth0 egress to 100Mbit
tc qdisc add dev eth0 root tbf \
    rate 100mbit \
    burst 32kbit \
    latency 400ms

# Parameters:
# rate: target bandwidth
# burst: bucket size (max tokens stored = max burst)
# latency: maximum time a packet can be queued (determines buffer size)

# More precise: use peakrate for burst limiting
tc qdisc add dev eth0 root tbf \
    rate 100mbit \
    burst 16kb \
    peakrate 110mbit \
    minburst 1540

# View stats
tc -s qdisc show dev eth0
```

## Section 3: HTB (Hierarchical Token Bucket)

HTB is the most useful classful qdisc for production use. It allows you to define a hierarchy of bandwidth classes with guaranteed rates, burst rates, and borrowing rules.

### HTB Concepts

- **rate**: Guaranteed minimum bandwidth. Always available even when the link is saturated.
- **ceil**: Maximum bandwidth. Can borrow unused bandwidth from parent up to this limit.
- **burst**: How many bytes can be sent at `ceil` rate before throttling back to `rate`.
- **prio**: Priority for borrowing unused bandwidth. Lower number = higher priority.

### Complete HTB Setup

```bash
#!/bin/bash
# /usr/local/bin/setup-qos.sh
# Sets up HTB traffic shaping on eth0
# Total uplink: 1Gbit

DEV="eth0"
RATE_TOTAL="1gbit"

# 1. Remove existing qdisc
tc qdisc del dev $DEV root 2>/dev/null || true

# 2. Add root HTB qdisc with default class for unclassified traffic
tc qdisc add dev $DEV root handle 1: htb default 30

# 3. Add root class (total bandwidth pool)
tc class add dev $DEV parent 1: classid 1:1 htb \
    rate $RATE_TOTAL \
    burst 100k

# 4. High priority class: guaranteed 300Mbit, burst to 1Gbit
# For: management traffic, monitoring, critical APIs
tc class add dev $DEV parent 1:1 classid 1:10 htb \
    rate 300mbit \
    ceil 1gbit \
    burst 50k \
    prio 1

# 5. Standard traffic class: guaranteed 500Mbit, burst to 900Mbit
# For: regular application traffic
tc class add dev $DEV parent 1:1 classid 1:20 htb \
    rate 500mbit \
    ceil 900mbit \
    burst 50k \
    prio 2

# 6. Bulk traffic class: guaranteed 100Mbit, burst to 400Mbit
# For: backups, batch jobs, non-critical downloads
tc class add dev $DEV parent 1:1 classid 1:30 htb \
    rate 100mbit \
    ceil 400mbit \
    burst 15k \
    prio 3

# 7. Add SFQ leaf qdiscs for fair queuing within each class
# Prevents one flow from monopolizing a class
tc qdisc add dev $DEV parent 1:10 handle 10: sfq perturb 10
tc qdisc add dev $DEV parent 1:20 handle 20: sfq perturb 10
tc qdisc add dev $DEV parent 1:30 handle 30: sfq perturb 10

# 8. Add filters to classify traffic

# Management traffic (SSH, monitoring, DNS) → high priority
tc filter add dev $DEV parent 1: protocol ip prio 1 u32 \
    match ip dport 22 0xffff flowid 1:10
tc filter add dev $DEV parent 1: protocol ip prio 1 u32 \
    match ip dport 9090 0xffff flowid 1:10  # Prometheus
tc filter add dev $DEV parent 1: protocol ip prio 1 u32 \
    match ip dport 9100 0xffff flowid 1:10  # Node exporter
tc filter add dev $DEV parent 1: protocol ip prio 1 u32 \
    match ip dport 53 0xffff flowid 1:10    # DNS

# HTTPS traffic → standard
tc filter add dev $DEV parent 1: protocol ip prio 2 u32 \
    match ip dport 443 0xffff flowid 1:20

# HTTP traffic → standard
tc filter add dev $DEV parent 1: protocol ip prio 2 u32 \
    match ip dport 80 0xffff flowid 1:20

# Backup/bulk (specific subnet) → bulk
tc filter add dev $DEV parent 1: protocol ip prio 3 u32 \
    match ip dst 10.100.0.0/16 flowid 1:30

# DSCP-based classification (EF = Expedited Forwarding = high priority)
tc filter add dev $DEV parent 1: protocol ip prio 1 u32 \
    match ip tos 0xb8 0xfc flowid 1:10  # DSCP EF (46 << 2)

echo "QoS setup complete on $DEV"
tc -s class show dev $DEV
```

### Verifying HTB Operation

```bash
# Show class statistics
tc -s class show dev eth0
# class htb 1:10 parent 1:1 prio 1 rate 300Mbit ceil 1Gbit burst 50Kb cburst 1.6Kb
#  Sent 1234567890 bytes 987654 pkt (dropped 0, overlimits 0 requeues 0)
#  backlog 0b 0p requeues 0
#  lended: 123456 borrowed: 0 giants: 0
#  tokens: 15000 ctokens: 15000

# Watch traffic rates in real time
watch -n1 tc -s class show dev eth0

# Check if classes are hitting limits (overlimits indicates throttling)
tc -s class show dev eth0 | grep overlimits
```

## Section 4: SFQ (Stochastic Fair Queuing)

SFQ prevents a single flow from monopolizing bandwidth within a class. It hashes flows and round-robins between them.

```bash
# Basic SFQ
tc qdisc add dev eth0 parent 1:10 handle 10: sfq perturb 10

# Parameters:
# perturb: How often to re-hash flows (in seconds)
#          Lower = more fair but more CPU; 10 is a good default
# quantum: bytes dequeued per round (default: MTU)
# limit: queue depth (default: 1000 packets)
# divisor: hash table size (default: 1024, must be power of 2)

# SFQ with ECN marking (for TCP congestion control)
tc qdisc add dev eth0 parent 1:10 handle 10: sfq \
    perturb 10 \
    quantum 1514 \
    limit 512 \
    ecn

# fq_codel as leaf (better than SFQ for low-latency requirements)
tc qdisc add dev eth0 parent 1:10 handle 10: fq_codel \
    target 5ms \
    interval 100ms \
    quantum 1514 \
    limit 1024 \
    ecn
```

## Section 5: Policing vs. Shaping

These are fundamentally different approaches to rate limiting:

**Shaping** (egress): Delays packets to match a rate. Creates a buffer. Does not drop immediately. Works only on egress (outbound) traffic.

**Policing** (ingress): Drops packets that exceed a rate. No buffering. Works on both ingress and egress. Used when you want to drop excess traffic rather than queue it.

### Shaping (Delay Excess Traffic)

```bash
# TBF-based shaping: buffers excess, introduces delay
tc qdisc add dev eth0 root tbf \
    rate 100mbit \
    burst 1mb \
    latency 50ms

# HTB always shapes — it buffers excess in leaf qdiscs
```

### Policing (Drop Excess Traffic)

```bash
# Ingress policing: police incoming traffic
# Requires ingress qdisc (ifb for redirecting to egress)

# Method 1: Simple ingress policing with tc filter
tc qdisc add dev eth0 handle ffff: ingress

tc filter add dev eth0 parent ffff: \
    protocol ip \
    prio 1 \
    u32 match ip src 0.0.0.0/0 \
    police rate 100mbit burst 1mb drop \
    flowid :1

# Method 2: IFB (Intermediate Functional Block) for full HTB on ingress
# Redirect ingress to ifb0 where HTB can be applied
ip link add ifb0 type ifb
ip link set ifb0 up

# Redirect all ingress traffic to ifb0
tc qdisc add dev eth0 handle ffff: ingress
tc filter add dev eth0 parent ffff: \
    protocol all \
    prio 10 \
    u32 match u32 0 0 \
    action mirred egress redirect dev ifb0

# Now apply HTB shaping to ifb0 (this is actually ingress limiting)
tc qdisc add dev ifb0 root handle 1: htb default 10
tc class add dev ifb0 parent 1: classid 1:1 htb rate 1gbit
tc class add dev ifb0 parent 1:1 classid 1:10 htb rate 100mbit ceil 1gbit
tc qdisc add dev ifb0 parent 1:10 handle 10: fq_codel
```

### Per-Connection Policing with u32 Hash

Police individual IP addresses to prevent a single source from monopolizing bandwidth:

```bash
# Create a hash table for per-IP policing
tc filter add dev eth0 parent 1: \
    protocol ip \
    prio 100 \
    handle 1: u32 divisor 256

# Add a default catch for the hash table
tc filter add dev eth0 parent 1: \
    protocol ip \
    prio 100 \
    u32 ht 800:: \
    match ip src 0.0.0.0/0 \
    hashkey mask 0x000000ff at 12 \
    link 1:

# Each unique source IP gets 10Mbit maximum
# (Add per-IP entries dynamically or via eBPF)
```

## Section 6: tc-flower for Modern Classification

`tc-flower` is a more readable and maintainable filter type that supports matching on Ethernet, IP, TCP/UDP, and VLAN fields:

```bash
# Classify by destination port and VLAN
tc filter add dev eth0 parent 1: \
    protocol 802.1q \
    prio 1 \
    flower \
    vlan_id 100 \
    ip_proto tcp \
    dst_port 443 \
    action goto chain 2

# Classify by source MAC (useful for per-tenant QoS)
tc filter add dev eth0 parent 1: \
    protocol ip \
    prio 1 \
    flower \
    src_mac aa:bb:cc:dd:ee:ff \
    action mirred egress redirect dev ifb0

# DSCP marking on egress
tc filter add dev eth0 parent 1: \
    protocol ip \
    prio 1 \
    flower \
    ip_proto tcp \
    dst_port 22 \
    action pedit ex munge ip dsfield set 0xb8 retain 0xfc  # Set DSCP EF
    action mirred egress redirect dev ifb0

# Multi-action: mark and classify
tc filter add dev eth0 parent 1: \
    protocol ip prio 1 flower \
    ip_proto tcp dst_port 5432 \
    action skbedit priority 6 \  # Set socket priority
    action goto chain 1
```

## Section 7: eBPF-Based Traffic Control

For high-performance scenarios, eBPF programs can replace `u32` and `flower` filters:

```c
// tc_classify.c
#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Map: destination port → class ID
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u16);
    __type(value, __u32);
    __uint(max_entries, 256);
} port_class_map SEC(".maps");

SEC("tc")
int tc_classify(struct __sk_buff *skb) {
    void *data = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    if (ip->protocol != IPPROTO_TCP)
        return TC_ACT_OK;

    struct tcphdr *tcp = (void *)(ip + 1);
    if ((void *)(tcp + 1) > data_end)
        return TC_ACT_OK;

    __u16 dport = bpf_ntohs(tcp->dest);
    __u32 *class_id = bpf_map_lookup_elem(&port_class_map, &dport);
    if (class_id) {
        skb->tc_classid = *class_id;
        return TC_ACT_OK;
    }

    return TC_ACT_OK;
}

char _license[] SEC("license") = "GPL";
```

Compile and attach:

```bash
# Compile
clang -O2 -target bpf -c tc_classify.c -o tc_classify.o

# Attach to interface
tc filter add dev eth0 parent 1: bpf obj tc_classify.o sec tc direct-action

# Update classification rules via map
# (using bpftool or custom Go program)
bpftool map update pinned /sys/fs/bpf/port_class_map \
    key 0x01 0xbb \       # port 443 in little-endian
    value 0x0a 0x00 0x01 0x00  # classid 1:10
```

## Section 8: Kubernetes Integration

### Node-Level QoS with Calico

Calico uses tc bandwidth limits from Kubernetes NetworkPolicy annotations:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api-server
  annotations:
    # Kubernetes bandwidth QoS annotations
    kubernetes.io/ingress-bandwidth: "100M"
    kubernetes.io/egress-bandwidth: "100M"
spec:
  containers:
  - name: api
    image: api:latest
```

The CNI plugin applies TBF qdiscs on the veth pair for this pod.

### Custom tc Rules on Kubernetes Nodes

Apply QoS at the node level to protect critical system components:

```bash
#!/bin/bash
# /etc/NetworkManager/dispatcher.d/99-k8s-qos.sh
# Applied on interface up

DEV="$1"
ACTION="$2"

if [ "$ACTION" != "up" ]; then
    exit 0
fi

# Only apply to the primary node interface
if [ "$DEV" != "ens3" ]; then
    exit 0
fi

# Remove existing
tc qdisc del dev "$DEV" root 2>/dev/null || true

# Root HTB
tc qdisc add dev "$DEV" root handle 1: htb default 20

tc class add dev "$DEV" parent 1: classid 1:1 htb rate 10gbit burst 100k

# Kubernetes API server and etcd traffic (highest priority)
tc class add dev "$DEV" parent 1:1 classid 1:10 htb \
    rate 2gbit ceil 10gbit burst 50k prio 1
tc qdisc add dev "$DEV" parent 1:10 handle 10: fq_codel

# Node-to-node pod traffic
tc class add dev "$DEV" parent 1:1 classid 1:20 htb \
    rate 5gbit ceil 9gbit burst 50k prio 2
tc qdisc add dev "$DEV" parent 1:20 handle 20: fq_codel

# Bulk storage traffic (backup, image pulls)
tc class add dev "$DEV" parent 1:1 classid 1:30 htb \
    rate 1gbit ceil 4gbit burst 30k prio 3
tc qdisc add dev "$DEV" parent 1:30 handle 30: fq_codel

# Classify Kubernetes API server
tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
    match ip dport 6443 0xffff flowid 1:10
tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
    match ip sport 6443 0xffff flowid 1:10

# etcd
tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
    match ip dport 2379 0xffff flowid 1:10
tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
    match ip dport 2380 0xffff flowid 1:10

# Image registry pulls → bulk
tc filter add dev "$DEV" parent 1: protocol ip prio 3 u32 \
    match ip dport 5000 0xffff flowid 1:30
```

### tc Rules for Multi-Tenant Kubernetes

In a shared cluster, prevent noisy neighbors from consuming all network bandwidth:

```bash
#!/bin/bash
# Apply per-namespace bandwidth limits via veth pairs

# Get all pod veth pairs for a specific namespace
NAMESPACE="tenant-a"
POD_IPS=$(kubectl get pods -n "$NAMESPACE" -o jsonpath='{.items[*].status.podIP}')

for IP in $POD_IPS; do
    # Find the veth pair for this pod IP
    # (Implementation depends on CNI — Calico, Flannel, etc.)
    # This example assumes Calico with predictable veth naming
    VETH=$(ip route get "$IP" | grep dev | awk '{print $5}')

    if [ -z "$VETH" ]; then
        continue
    fi

    # Apply 100Mbit limit on veth egress (= pod ingress)
    tc qdisc del dev "$VETH" root 2>/dev/null || true
    tc qdisc add dev "$VETH" root tbf \
        rate 100mbit \
        burst 1mb \
        latency 50ms

    echo "Applied 100Mbit limit on $VETH for pod $IP"
done
```

## Section 9: Monitoring and Troubleshooting

### tc Statistics

```bash
# Per-class byte and packet counters
tc -s class show dev eth0

# Per-qdisc statistics (drops, overlimits)
tc -s qdisc show dev eth0

# Watch in real-time
watch -n1 'tc -s class show dev eth0 | grep -A4 "class htb"'

# High drop rate in a class = class is oversubscribed
# Overlimits = class is hitting its ceil (borrowing refused)
# Borrowed > 0 = class is using bandwidth from its parent
```

### Scripted Statistics Collection

```bash
#!/bin/bash
# /usr/local/bin/tc-stats.sh
# Outputs Prometheus-compatible metrics

DEV="${1:-eth0}"

tc -s class show dev "$DEV" | while read -r line; do
    if echo "$line" | grep -q "^class htb"; then
        CLASS_ID=$(echo "$line" | awk '{print $3}')
        read -r stats_line
        BYTES=$(echo "$stats_line" | grep -oP 'Sent \K[0-9]+')
        PKTS=$(echo "$stats_line" | grep -oP '[0-9]+ pkt' | awk '{print $1}')
        DROPS=$(echo "$stats_line" | grep -oP 'dropped \K[0-9]+')
        echo "tc_class_bytes_total{dev=\"$DEV\",class=\"$CLASS_ID\"} $BYTES"
        echo "tc_class_packets_total{dev=\"$DEV\",class=\"$CLASS_ID\"} $PKTS"
        echo "tc_class_drops_total{dev=\"$DEV\",class=\"$CLASS_ID\"} $DROPS"
    fi
done
```

### Debugging Classification

```bash
# Trace which class a packet is being assigned to
# Use tc-police with a count action
tc filter add dev eth0 parent 1: protocol ip prio 1 u32 \
    match ip dport 443 0xffff \
    action count \
    flowid 1:20

# Or use tc-mirred to copy to a monitoring interface
tc filter add dev eth0 parent 1: protocol ip prio 1 flower \
    dst_port 443 \
    action mirred egress mirror dev eth1  # Mirror to monitoring NIC

# Use tc with verbose output
tc -v filter show dev eth0

# Check if u32 filters are matching
tc -s filter show dev eth0 parent 1:
# filter parent 1: protocol ip pref 1 u32 chain 0
# filter parent 1: protocol ip pref 1 u32 chain 0 fh 800::800 order 2048 key ht 800 bkt 0 flowid 1:10 not_in_hw
#   match 00160000/ffff0000 at 20   <-- port 22 match
#     Sent 5000 bytes 30 pkts       <-- packets matched
```

## Section 10: Persistent tc Rules

tc rules do not survive a reboot. Use one of these approaches:

### systemd Service

```ini
# /etc/systemd/system/tc-qos.service
[Unit]
Description=Traffic Control QoS Rules
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/setup-qos.sh
ExecStop=/sbin/tc qdisc del dev eth0 root
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now tc-qos
```

### NetworkManager Dispatcher

```bash
# /etc/NetworkManager/dispatcher.d/99-tc-qos
#!/bin/bash
DEV="$1"
ACTION="$2"

[ "$DEV" = "eth0" ] && [ "$ACTION" = "up" ] && /usr/local/bin/setup-qos.sh
```

```bash
chmod +x /etc/NetworkManager/dispatcher.d/99-tc-qos
```

## Conclusion

Linux traffic control is an essential tool for network engineers working at the kernel level. HTB provides the hierarchical bandwidth management needed for multi-tenant environments and service prioritization. SFQ and fq_codel provide fairness within classes. The combination enables sophisticated QoS policies that can guarantee latency for critical services while preventing bulk traffic from affecting interactive workloads.

Key takeaways:
- Use HTB for hierarchical bandwidth allocation with guaranteed rates
- Always pair HTB classes with SFQ or fq_codel leaf qdiscs for intra-class fairness
- Policing drops packets; shaping buffers them — choose based on your requirements
- tc-flower is more readable than u32 for new rules; use eBPF for highest performance
- Monitor per-class overlimits and drops to detect bottlenecks
- Make rules persistent via systemd or NetworkManager dispatcher
