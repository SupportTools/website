---
title: "Linux Kernel Networking: Netfilter Hooks and Connection Tracking"
date: 2029-11-05T00:00:00-05:00
draft: false
tags: ["Linux", "Netfilter", "Conntrack", "Kernel Networking", "NAT", "Kubernetes", "iptables"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux Netfilter hook points, the conntrack state machine, NAT implementation, conntrack table tuning, nf_conntrack_max configuration, and Kubernetes networking implications."
more_link: "yes"
url: "/linux-kernel-networking-netfilter-hooks-conntrack/"
---

Understanding Netfilter is fundamental to diagnosing Kubernetes networking issues, writing custom firewall rules, and optimizing network performance on Linux. This post covers the internals of Netfilter hook points, the connection tracking (conntrack) state machine, NAT implementation, and practical tuning guidance for production Kubernetes environments.

<!--more-->

# Linux Kernel Networking: Netfilter Hooks and Connection Tracking

## The Netfilter Framework Architecture

Netfilter is the Linux kernel's packet filtering framework. It provides a series of hooks embedded into the kernel's network stack where kernel modules can register callback functions to inspect, modify, or drop packets.

Every packet flowing through the Linux network stack traverses several well-defined hook points. Understanding which hooks fire for which packet paths is essential for writing correct iptables rules and debugging traffic issues.

### Hook Points in the IPv4 Stack

```
                    Routing
                   Decision
                      │
 NF_INET_PRE_ROUTING  │  NF_INET_FORWARD   NF_INET_POST_ROUTING
         │            │        │                    │
Incoming ──►[PREROUTING]──►[Route]──►[FORWARD]──►[POSTROUTING]──► Outgoing
                              │
                        [LOCAL_IN]──► Local Process ──►[LOCAL_OUT]──►[POSTROUTING]
                    NF_INET_LOCAL_IN                NF_INET_LOCAL_OUT
```

The five hook points and their positions:

| Hook | Position | Typical Use |
|------|----------|-------------|
| NF_INET_PRE_ROUTING | Before routing decision | DNAT, connection tracking |
| NF_INET_LOCAL_IN | After routing, for local delivery | Input filtering |
| NF_INET_FORWARD | For forwarded packets | Forward filtering |
| NF_INET_LOCAL_OUT | After local process generates packet | Output filtering |
| NF_INET_POST_ROUTING | After routing decision, before wire | SNAT/masquerade |

### Hook Registration in Kernel Modules

A kernel module registers a hook using `nf_register_net_hook`:

```c
#include <linux/netfilter.h>
#include <linux/netfilter_ipv4.h>
#include <linux/ip.h>
#include <linux/tcp.h>

static unsigned int my_hook_fn(void *priv,
                                struct sk_buff *skb,
                                const struct nf_hook_state *state)
{
    struct iphdr *iph;
    struct tcphdr *tcph;

    if (!skb)
        return NF_ACCEPT;

    iph = ip_hdr(skb);
    if (iph->protocol != IPPROTO_TCP)
        return NF_ACCEPT;

    tcph = tcp_hdr(skb);

    /* Log connections to port 80 */
    if (ntohs(tcph->dest) == 80) {
        printk(KERN_INFO "HTTP packet from %pI4\n", &iph->saddr);
    }

    return NF_ACCEPT;
}

static struct nf_hook_ops my_hook_ops = {
    .hook     = my_hook_fn,
    .pf       = PF_INET,
    .hooknum  = NF_INET_PRE_ROUTING,
    .priority = NF_IP_PRI_FIRST,
};

static int __init my_module_init(void)
{
    return nf_register_net_hook(&init_net, &my_hook_ops);
}

static void __exit my_module_exit(void)
{
    nf_unregister_net_hook(&init_net, &my_hook_ops);
}
```

Hook return values determine packet fate:

```c
#define NF_DROP   0   /* Drop the packet silently */
#define NF_ACCEPT 1   /* Continue processing */
#define NF_STOLEN 2   /* Hook consumed the packet */
#define NF_QUEUE  3   /* Queue packet to userspace */
#define NF_REPEAT 4   /* Call this hook again */
```

### Hook Priority Values

Multiple modules can register at the same hook point. Priority determines order:

```c
enum nf_ip_hook_priorities {
    NF_IP_PRI_FIRST           = INT_MIN,
    NF_IP_PRI_RAW_BEFORE_DEFRAG = -450,
    NF_IP_PRI_CONNTRACK_DEFRAG = -400,
    NF_IP_PRI_RAW             = -300,
    NF_IP_PRI_SELINUX_FIRST   = -225,
    NF_IP_PRI_CONNTRACK       = -200,   /* conntrack runs here */
    NF_IP_PRI_MANGLE          = -150,
    NF_IP_PRI_NAT_DST         = -100,   /* DNAT at PREROUTING */
    NF_IP_PRI_FILTER          = 0,
    NF_IP_PRI_SECURITY        = 50,
    NF_IP_PRI_NAT_SRC         = 100,    /* SNAT at POSTROUTING */
    NF_IP_PRI_SELINUX_LAST    = 225,
    NF_IP_PRI_CONNTRACK_HELPER= 300,
    NF_IP_PRI_CONNTRACK_CONFIRM = INT_MAX,
};
```

The order at PREROUTING is: conntrack (-200) then DNAT (-100) then filter (0). This means conntrack sees the original destination before DNAT rewrites it, which is critical for tracking connections correctly.

## Connection Tracking State Machine

The conntrack subsystem maintains a table of all active connections. Each entry in the table represents a flow identified by a 5-tuple: (source IP, destination IP, source port, destination port, protocol).

### Connection States

```
                      ┌─────────────────────┐
                      │                     │
    SYN ──────────────►  SYN_SENT/SYN_RECV  │
                      │                     │
    SYN+ACK ──────────►    ESTABLISHED      │◄──── Data packets
                      │                     │
    FIN ──────────────►   FIN_WAIT / etc    │
                      │                     │
    Last packet ──────►      TIME_WAIT      │
                      │                     │
    Timeout ──────────►       (delete)      │
                      └─────────────────────┘
```

Conntrack tracks these states in `/proc/net/nf_conntrack`:

```
ipv4     2 tcp      6 431999 ESTABLISHED src=10.0.0.1 dst=10.0.0.2 \
  sport=54321 dport=80 packets=100 bytes=12345 \
  src=10.0.0.2 dst=10.0.0.1 sport=80 dport=54321 \
  packets=80 bytes=9876 [ASSURED] mark=0 use=2
```

The conntrack states relevant to iptables rules:

| State | Meaning |
|-------|---------|
| NEW | First packet of a connection |
| ESTABLISHED | Connection seen in both directions |
| RELATED | Related to an existing connection (e.g., FTP data) |
| INVALID | Does not belong to any tracked connection |
| UNTRACKED | Packet explicitly excluded from tracking |

### Conntrack Internal Structure

Each conntrack entry is a `struct nf_conn` in kernel memory:

```c
struct nf_conn {
    struct nf_conntrack ct_general;      /* reference count */
    spinlock_t          lock;
    u16                 cpu;

    struct nf_conntrack_tuple_hash tuplehash[IP_CT_DIR_MAX];
    /* tuplehash[0] = original direction (client->server) */
    /* tuplehash[1] = reply direction (server->client) */

    unsigned long       status;          /* IPS_* bits */
    u32                 timeout;         /* timeout in jiffies */

    possible_net_t      ct_net;

    struct hlist_node   nat_bysource;

    /* Extensions: NAT, helper, accounting, timestamps, etc. */
    struct nf_ct_ext    *ext;

    union nf_conntrack_proto proto;      /* protocol-specific data */
};
```

The `status` field encodes connection properties:

```c
enum ip_conntrack_status {
    IPS_EXPECTED_BIT      = 0,   /* This is an expected connection */
    IPS_SEEN_REPLY_BIT    = 1,   /* We've seen a reply */
    IPS_ASSURED_BIT       = 2,   /* Won't expire unless forced */
    IPS_CONFIRMED_BIT     = 3,   /* Added to conntrack table */
    IPS_SRC_NAT_BIT       = 4,   /* Source NAT applied */
    IPS_DST_NAT_BIT       = 5,   /* Destination NAT applied */
    IPS_SEQ_ADJUST_BIT    = 6,   /* TCP sequence adjustment needed */
    IPS_SRC_NAT_DONE_BIT  = 7,
    IPS_DST_NAT_DONE_BIT  = 8,
    IPS_DYING_BIT         = 9,   /* Being removed */
    IPS_FIXED_TIMEOUT_BIT = 10,  /* Timeout cannot be changed */
    IPS_TEMPLATE_BIT      = 11,  /* Template for new connections */
    IPS_UNTRACKED_BIT     = 12,  /* Untracked connection */
    IPS_HELPER_BIT        = 13,  /* Connection has helper */
    IPS_OFFLOAD_BIT       = 14,  /* Offloaded to hardware */
    IPS_HW_OFFLOAD_BIT    = 15,  /* Hardware offload */
};
```

### Conntrack Helpers

Helpers are protocol-aware modules that handle application-layer protocols that embed addresses (like FTP):

```bash
# List loaded conntrack helpers
lsmod | grep nf_conntrack

# FTP helper enables tracking of FTP data connections
modprobe nf_conntrack_ftp

# Check helper assignments
conntrack -L | grep helper
```

For protocols like FTP, SIP, and H.323, helpers parse the payload to create RELATED expectations:

```c
/* FTP helper creates an expectation for the data connection */
static int help(struct sk_buff *skb, unsigned int protoff,
                struct nf_conn *ct, enum ip_conntrack_info ctinfo)
{
    struct nf_conntrack_expect *exp;

    exp = nf_ct_expect_alloc(ct);
    if (!exp)
        return NF_DROP;

    /* Set up expectation for the data connection */
    nf_ct_expect_init(exp, NF_CT_EXPECT_CLASS_DEFAULT, nf_ct_l3num(ct),
                      &ct->tuplehash[IP_CT_DIR_ORIGINAL].tuple.src.u3,
                      &ct->tuplehash[IP_CT_DIR_REPLY].tuple.src.u3,
                      IPPROTO_TCP, NULL, &port);

    nf_ct_expect_related(exp);
    nf_ct_expect_put(exp);

    return NF_ACCEPT;
}
```

## NAT Implementation

Network Address Translation in Linux is implemented as a Netfilter module that modifies the conntrack entry's NAT mapping and rewrites packet headers.

### DNAT (Destination NAT)

DNAT rewrites the destination address/port, typically used for port forwarding and load balancing. It fires at PREROUTING:

```bash
# Forward external port 8080 to internal service at 192.168.1.100:80
iptables -t nat -A PREROUTING -p tcp --dport 8080 \
    -j DNAT --to-destination 192.168.1.100:80

# Kubernetes kube-proxy equivalent (NodePort):
iptables -t nat -A KUBE-NODEPORTS -p tcp --dport 30080 \
    -j KUBE-SVC-XXXXXXXXXXXXXXXX

iptables -t nat -A KUBE-SVC-XXXXXXXXXXXXXXXX -m statistic \
    --mode random --probability 0.33 \
    -j KUBE-SEP-ENDPOINT1

iptables -t nat -A KUBE-SEP-ENDPOINT1 -p tcp \
    -j DNAT --to-destination 10.244.1.5:80
```

### SNAT and Masquerade

SNAT rewrites the source address, used for outbound NAT. It fires at POSTROUTING:

```bash
# Static SNAT - fixed source IP
iptables -t nat -A POSTROUTING -o eth0 \
    -j SNAT --to-source 203.0.113.1

# Masquerade - dynamic SNAT using interface IP (better for DHCP)
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

# Kubernetes pod-to-external traffic masquerade:
iptables -t nat -A KUBE-POSTROUTING -m comment \
    --comment "kubernetes service traffic requiring SNAT" \
    -m mark --mark 0x4000/0x4000 \
    -j MASQUERADE --random-fully
```

### How NAT and Conntrack Interact

When NAT is applied to the first packet of a connection:

1. Conntrack creates a new entry at PREROUTING (priority -200)
2. DNAT rule fires at PREROUTING (priority -100) and modifies the conntrack NAT info
3. The reply tuple in conntrack is updated to reflect the translated addresses
4. Subsequent packets in the same flow are handled by conntrack's fast path without re-evaluating rules
5. Reply packets have the reverse NAT applied automatically by conntrack

```bash
# Observe NAT mappings in conntrack table
conntrack -L -p tcp --dport 80

# Example output:
# tcp  6 86399 ESTABLISHED
#   src=10.0.0.1 dst=203.0.113.1 sport=54321 dport=80
#   src=203.0.113.1 dst=10.0.0.1 sport=80 dport=54321 [ASSURED]
# After DNAT to 192.168.1.100:80:
# tcp  6 86399 ESTABLISHED
#   src=10.0.0.1 dst=192.168.1.100 sport=54321 dport=80
#   src=192.168.1.100 dst=10.0.0.1 sport=80 dport=54321 [ASSURED]
```

## Conntrack Table Tuning

On busy servers or Kubernetes nodes, the conntrack table can become a bottleneck. Understanding and tuning it is essential for production systems.

### Key Parameters

```bash
# View current conntrack table usage
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Default buckets (hash table size)
cat /proc/sys/net/netfilter/nf_conntrack_buckets

# View all conntrack parameters
sysctl -a | grep conntrack
```

### nf_conntrack_max Calculation

The maximum conntrack table size should be set based on available memory:

```bash
# Each conntrack entry uses approximately 288 bytes on x86_64
# Formula: nf_conntrack_max = (RAM_in_bytes * 0.1) / 288

# For a 32GB server:
# 32 * 1024 * 1024 * 1024 * 0.1 / 288 = ~11,930,000

# Practical upper limit for Kubernetes nodes:
# Set nf_conntrack_max proportional to expected pod density

# Check current count vs max
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Persistent tuning via sysctl
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
# Conntrack table size - 1M entries for busy Kubernetes nodes
net.netfilter.nf_conntrack_max = 1048576

# Hash table buckets - should be 1/4 of nf_conntrack_max
net.netfilter.nf_conntrack_buckets = 262144

# TCP timeout tuning
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 120
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_syn_sent = 120

# UDP timeouts
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 180

# Generic timeout
net.netfilter.nf_conntrack_generic_timeout = 600
EOF

sysctl -p /etc/sysctl.d/99-conntrack.conf
```

### Per-Namespace Conntrack Tables

With network namespaces (used by Kubernetes pods), each namespace has its own conntrack table:

```bash
# Check conntrack in a pod's namespace
POD=$(kubectl get pod -n default -l app=myapp -o jsonpath='{.items[0].metadata.name}')
PID=$(kubectl get pod -n default $POD -o jsonpath='{.status.hostIP}' | \
    xargs -I{} kubectl get node -o jsonpath='{.status.addresses[0].address}')

# Get the pod's network namespace
CONTAINER_ID=$(kubectl get pod $POD -o jsonpath='{.status.containerStatuses[0].containerID}' | \
    sed 's|containerd://||')

# Enter the pod's network namespace
NETNS=$(crictl inspect $CONTAINER_ID | jq -r '.info.runtimeSpec.linux.namespaces[] | select(.type=="network") | .path')
nsenter --net=$NETNS -- conntrack -L
```

### Conntrack Table Exhaustion Monitoring

When the conntrack table fills up, new connections are dropped silently:

```bash
# Check for conntrack drops
watch -n1 'cat /proc/net/stat/nf_conntrack | awk "NR>1{print \"Drops:\", \$6}"'

# Or via netstat
netstat -s | grep conntrack

# Prometheus metrics for monitoring
# nf_conntrack_entries - current entries
# nf_conntrack_entries_limit - maximum

# Set up alerting
cat > /etc/prometheus/rules/conntrack.yml << 'EOF'
groups:
- name: conntrack
  rules:
  - alert: ConntrackTableNearFull
    expr: |
      node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.8
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Conntrack table {{ $value | humanizePercentage }} full on {{ $labels.instance }}"
  - alert: ConntrackTableFull
    expr: |
      node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.95
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Conntrack table critically full on {{ $labels.instance }}"
EOF
```

### Conntrack Zone Support

For asymmetric routing scenarios, conntrack zones allow the same tuple to exist in different zones:

```bash
# Assign traffic from different interfaces to different zones
iptables -t raw -A PREROUTING -i eth0 -j CT --zone 1
iptables -t raw -A PREROUTING -i eth1 -j CT --zone 2

# This prevents conntrack collision when same 5-tuple arrives on both interfaces
# Common in HA setups with ECMP routing
```

## Debugging Conntrack with nftables

Modern Linux systems can use nftables as a higher-level abstraction over Netfilter:

```bash
# Install nftables
apt-get install -y nftables

# Basic nftables ruleset with conntrack
cat > /etc/nftables.conf << 'EOF'
#!/usr/sbin/nft -f

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        # Allow established/related connections
        ct state established,related accept

        # Drop invalid connections
        ct state invalid drop

        # Allow loopback
        iif lo accept

        # Allow SSH
        tcp dport 22 ct state new accept

        # Allow ICMP
        ip protocol icmp accept
        ip6 nexthdr ipv6-icmp accept
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
        ct state established,related accept
        ct state invalid drop

        # Allow pod-to-pod traffic in Kubernetes
        ip saddr 10.244.0.0/16 ip daddr 10.244.0.0/16 accept
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}

table ip nat {
    chain prerouting {
        type nat hook prerouting priority -100;
        # Port forwarding example
        tcp dport 8080 dnat to 192.168.1.100:80
    }

    chain postrouting {
        type nat hook postrouting priority 100;
        # Masquerade outbound traffic
        oif eth0 masquerade
    }
}
EOF

nft -f /etc/nftables.conf

# Debug: trace packet path through nftables
nft add table inet debug
nft 'add chain inet debug trace { type filter hook prerouting priority -500; }'
nft 'add rule inet debug trace ip saddr 10.0.0.1 nftrace set 1'
nft monitor trace
```

## Kubernetes Implications

Kubernetes networking relies heavily on conntrack and Netfilter. Understanding the interaction is critical for diagnosing network issues.

### kube-proxy iptables Mode

kube-proxy in iptables mode creates hundreds or thousands of iptables rules:

```bash
# Count kube-proxy generated rules
iptables -t nat -L | grep -c KUBE

# View service chain for a specific service
SERVICE_IP=$(kubectl get svc myservice -o jsonpath='{.spec.clusterIP}')
iptables -t nat -L KUBE-SERVICES -n | grep $SERVICE_IP

# Trace packet path through kube-proxy rules
iptables -t nat -L KUBE-SVC-XXXXXXXXXXXXXXXX -n --line-numbers
iptables -t nat -L KUBE-SEP-YYYYYYYYYYYYYYYY -n --line-numbers
```

### kube-proxy ipvs Mode

IPVS mode avoids the O(n) iptables rule scan with O(1) hash-table lookups:

```bash
# Enable IPVS mode
kubectl edit configmap kube-proxy -n kube-system
# Set mode: "ipvs"

# Verify IPVS is active
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o name | head -1 | \
    xargs -I{} kubectl exec -n kube-system {} -- ipvsadm -L -n

# IPVS still uses conntrack for NAT
# Check IPVS conntrack interaction
ipvsadm -L --stats -n

# IPVS virtual services
ipvsadm -L -n | head -50
```

### Conntrack and Kubernetes Services

A known issue with Kubernetes is conntrack table exhaustion under high connection rates:

```bash
# Check for conntrack-related drops on a Kubernetes node
# These appear as "nf_conntrack: table full, dropping packet" in dmesg
dmesg | grep -i conntrack | tail -20

# Kubernetes recommended conntrack settings
# These are typically set by kubeadm/kubelet automatically
cat /proc/sys/net/netfilter/nf_conntrack_max

# For Kubernetes nodes, the recommended value is
# max(131072, 4 * maxPods * 4)
# For 110 pods max: max(131072, 4 * 110 * 4) = 131072

# Check what kubelet sets
cat /var/lib/kubelet/config.yaml | grep -A5 -i conntrack
```

### Conntrack and CoreDNS UDP

UDP DNS queries and conntrack interact in a subtle way:

```bash
# DNS over UDP creates short-lived conntrack entries
# High DNS query rates can exhaust the conntrack table

# Check DNS-related conntrack entries
conntrack -L -p udp --dport 53 | wc -l

# Mitigate by reducing UDP timeout for DNS
sysctl -w net.netfilter.nf_conntrack_udp_timeout=10
sysctl -w net.netfilter.nf_conntrack_udp_timeout_stream=30

# Alternatively, use nodelocaldns to avoid conntrack for DNS
# This is a Kubernetes addon that caches DNS locally
kubectl apply -f https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml
```

### Diagnosing Network Issues with conntrack

```bash
# Real-time conntrack monitoring
watch -n1 'conntrack -L 2>/dev/null | wc -l'

# Find connections to a specific pod
POD_IP=$(kubectl get pod mypod -o jsonpath='{.status.podIP}')
conntrack -L -d $POD_IP 2>/dev/null

# Dump all ESTABLISHED TCP connections
conntrack -L -p tcp --state ESTABLISHED 2>/dev/null | head -20

# Count connections per source IP (find connection floods)
conntrack -L 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i~/^src=/) print $i}' | \
    sort | uniq -c | sort -rn | head -20

# Force-delete a stuck conntrack entry
conntrack -D -p tcp --src 10.0.0.1 --dst 10.0.0.2 --sport 54321 --dport 80

# Delete all entries for a specific IP (when a pod is terminated)
conntrack -D -s $POD_IP
conntrack -D -d $POD_IP
```

### Bypassing Conntrack for Performance

Some workloads benefit from bypassing conntrack entirely:

```bash
# Skip conntrack for loopback traffic (no need to track)
iptables -t raw -A PREROUTING -i lo -j NOTRACK
iptables -t raw -A OUTPUT -o lo -j NOTRACK

# Skip conntrack for high-volume internal traffic
iptables -t raw -A PREROUTING -s 10.0.0.0/8 -d 10.0.0.0/8 -j NOTRACK
iptables -t raw -A OUTPUT -s 10.0.0.0/8 -d 10.0.0.0/8 -j NOTRACK

# With nftables
nft add table raw
nft 'add chain raw prerouting { type filter hook prerouting priority -300; }'
nft 'add rule raw prerouting iif lo notrack'

# eBPF alternative: Cilium can bypass conntrack completely
# using BPF for packet processing, which is far more scalable
```

## Conntrack Accounting and Statistics

```bash
# Enable per-connection accounting (byte/packet counts)
sysctl -w net.netfilter.nf_conntrack_acct=1

# View accounting data
conntrack -L --output extended | grep -E 'packets|bytes'

# Conntrack statistics per CPU
cat /proc/net/stat/nf_conntrack

# Fields: found, invalid, ignore, insert, insert_failed,
#         drop, early_drop, error, search_restart

# Parse stats script
python3 << 'EOF'
with open('/proc/net/stat/nf_conntrack') as f:
    headers = f.readline().split()
    for line in f:
        vals = [int(x, 16) for x in line.split()]
        for h, v in zip(headers, vals):
            if v > 0:
                print(f"{h}: {v}")
EOF
```

## Production Hardening Checklist

```bash
#!/bin/bash
# conntrack-tuning.sh - Production conntrack tuning

set -euo pipefail

# Detect available RAM in KB
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')

# Calculate nf_conntrack_max
# Use 10% of RAM, each entry ~320 bytes
CONNTRACK_MAX=$(( TOTAL_RAM_KB * 1024 / 10 / 320 ))

# Minimum 131072, maximum 4194304
CONNTRACK_MAX=$(( CONNTRACK_MAX < 131072 ? 131072 : CONNTRACK_MAX ))
CONNTRACK_MAX=$(( CONNTRACK_MAX > 4194304 ? 4194304 : CONNTRACK_MAX ))

# Buckets = max / 4
CONNTRACK_BUCKETS=$(( CONNTRACK_MAX / 4 ))

echo "Setting nf_conntrack_max=$CONNTRACK_MAX"
echo "Setting nf_conntrack_buckets=$CONNTRACK_BUCKETS"

cat > /etc/sysctl.d/99-conntrack-production.conf << EOF
# Conntrack table size
net.netfilter.nf_conntrack_max = $CONNTRACK_MAX
net.netfilter.nf_conntrack_buckets = $CONNTRACK_BUCKETS

# Reduce TCP established timeout from default 5 days to 24 hours
net.netfilter.nf_conntrack_tcp_timeout_established = 86400

# Reduce TIME_WAIT from 120s (kernel default already good)
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 120

# Faster cleanup of closed connections
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_last_ack = 30

# UDP timeouts - reduce for DNS workloads
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 120

# Enable timestamps for accurate RTT measurement
net.netfilter.nf_conntrack_timestamp = 1

# Enable accounting
net.netfilter.nf_conntrack_acct = 1

# Log invalid packets (useful for debugging, disable in production)
# net.netfilter.nf_conntrack_log_invalid = 6
EOF

sysctl -p /etc/sysctl.d/99-conntrack-production.conf

echo "Conntrack tuning applied successfully"
echo "Current count: $(cat /proc/sys/net/netfilter/nf_conntrack_count)"
echo "Maximum: $(cat /proc/sys/net/netfilter/nf_conntrack_max)"
```

## Summary

Netfilter's hook-based architecture provides a flexible framework for packet filtering, NAT, and connection tracking. For Kubernetes operators, the key takeaways are:

- Conntrack state flows through PREROUTING before DNAT, ensuring correct reply-direction NAT
- `nf_conntrack_max` must be sized appropriately for pod density and connection rates
- IPVS mode scales better than iptables mode for large clusters with many services
- UDP DNS traffic creates many short-lived conntrack entries; NodeLocalDNS mitigates this
- Monitor `node_nf_conntrack_entries / node_nf_conntrack_entries_limit` to prevent silent connection drops
- The `NOTRACK` target in the raw table can bypass conntrack for trusted, high-volume traffic paths

Mastering these internals allows you to diagnose subtle network failures that manifest as intermittent connection resets, asymmetric routing issues, or mysterious packet drops in containerized environments.
