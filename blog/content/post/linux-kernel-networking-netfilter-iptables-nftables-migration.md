---
title: "Linux Kernel Networking: Netfilter Hooks, iptables Internals, and nftables Migration"
date: 2031-08-29T00:00:00-05:00
draft: false
tags: ["Linux", "Netfilter", "iptables", "nftables", "Kernel", "Networking", "Security"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to the Linux Netfilter framework, iptables table and chain internals, and a production migration strategy from iptables to nftables for enterprise environments."
more_link: "yes"
url: "/linux-kernel-networking-netfilter-iptables-nftables-migration/"
---

Every packet that enters, leaves, or traverses a Linux host passes through the Netfilter framework. Whether you are debugging a Kubernetes CNI plugin, hardening a firewall, or migrating aging iptables rules to nftables, understanding Netfilter at the kernel level eliminates guesswork. This guide walks through hook points, table evaluation order, connection tracking, and a systematic migration path from iptables to nftables.

<!--more-->

# Linux Kernel Networking: Netfilter Hooks, iptables Internals, and nftables Migration

## Netfilter Architecture

Netfilter is a kernel-level framework introduced in Linux 2.4 that provides hooks at strategic points in the network stack. Userspace tools — iptables, nftables, ipvs, conntrack — attach callbacks to these hooks.

### The Five Hook Points

```
                          ┌──────────┐
                          │  NETWORK │
                          │   STACK  │
                          └────┬─────┘
                               │
              Incoming Packet  │
                               ▼
                    ┌──────────────────┐
                    │  PREROUTING      │  NF_INET_PRE_ROUTING
                    │  (raw, conntrack,│  Hook priority: -400 (raw)
                    │   mangle, nat)   │                 -200 (conntrack)
                    └──────┬───────────┘                  -150 (mangle)
                           │                              -100 (nat/DNAT)
              ┌────────────┴──────────────┐
              │ Routing Decision          │
              └────┬──────────────────────┘
                   │
        ┌──────────┴──────────────────────────────────────────┐
        │                                                      │
        │ (to local process)                     (forward)     │
        ▼                                              ▼
┌────────────────┐                         ┌────────────────────┐
│  INPUT         │  NF_INET_LOCAL_IN       │  FORWARD           │
│  (mangle, nat, │  prio: -150, -100, 0   │  (mangle, filter)  │
│   filter)      │                         └─────────┬──────────┘
└───────┬────────┘                                   │
        │                                            ▼
        │ (local process)                   ┌────────────────────┐
        ▼                                   │  POSTROUTING       │  NF_INET_POST_ROUTING
┌────────────────┐                          │  (mangle, nat/SNAT,│  prio: -150, 100
│  OUTPUT        │  NF_INET_LOCAL_OUT       │   filter)          │
│  (raw, mangle, │  prio: -400, -150,      └────────────────────┘
│   nat, filter) │       -100, 0
└───────┬────────┘
        │
        └──────────────────────────────────────►  POSTROUTING (same as above)
```

Hook priorities determine evaluation order within each hook point. Lower numbers run first. This explains why connection tracking (priority -200 in PREROUTING) always runs before mangle (-150) and nat (-100): CT must see the original packet before any translation occurs.

### Hook Registration in the Kernel

A Netfilter module registers hooks using:

```c
// Simplified kernel source: net/netfilter/nf_tables_core.c
static const struct nf_hook_ops nft_netdev_ops[] = {
    {
        .hook     = nft_do_chain_netdev,
        .pf       = NFPROTO_NETDEV,
        .hooknum  = NF_NETDEV_INGRESS,
        .priority = NF_IP_PRI_FILTER,   // 0
    },
};

// From include/uapi/linux/netfilter_ipv4.h
enum nf_ip_hook_priorities {
    NF_IP_PRI_FIRST           = INT_MIN,
    NF_IP_PRI_RAW_BEFORE_DEFRAG = -450,
    NF_IP_PRI_CONNTRACK_DEFRAG = -400,
    NF_IP_PRI_RAW             = -300,
    NF_IP_PRI_SELINUX_FIRST   = -225,
    NF_IP_PRI_CONNTRACK       = -200,
    NF_IP_PRI_MANGLE          = -150,
    NF_IP_PRI_NAT_DST         = -100,
    NF_IP_PRI_FILTER          = 0,
    NF_IP_PRI_SECURITY        = 50,
    NF_IP_PRI_NAT_SRC         = 100,
    NF_IP_PRI_SELINUX_LAST    = 225,
    NF_IP_PRI_CONNTRACK_HELPER = 300,
    NF_IP_PRI_LAST            = INT_MAX,
};
```

## Connection Tracking (conntrack)

Conntrack maintains a state table that associates packets with flows. It is the foundation for stateful firewalls and NAT.

### Conntrack States

| State | Meaning |
|-------|---------|
| NEW | First packet of a new connection |
| ESTABLISHED | Both sides have exchanged packets |
| RELATED | Helper-identified related connection (e.g., FTP data channel) |
| INVALID | Packet does not match any known connection |
| UNTRACKED | Explicitly excluded from tracking (NOTRACK target) |

### Viewing the conntrack Table

```bash
# Install conntrack-tools
apt-get install -y conntrack

# Show all tracked connections
conntrack -L

# Filter by TCP state
conntrack -L -p tcp --state ESTABLISHED

# Real-time event stream
conntrack -E

# Count connections per source IP
conntrack -L | awk '{print $7}' | cut -d= -f2 | sort | uniq -c | sort -rn | head -20

# Current conntrack table utilization
cat /proc/sys/net/netfilter/nf_conntrack_count
# 14823
cat /proc/sys/net/netfilter/nf_conntrack_max
# 131072
```

### Conntrack Tuning for High-Traffic Servers

```bash
# /etc/sysctl.d/90-conntrack.conf

# Table size — should be 2x to 4x expected peak connections
net.netfilter.nf_conntrack_max = 524288

# Hash table buckets (nf_conntrack_max / 4 typically)
# Set at module load: options nf_conntrack hashsize=131072

# Timeout tuning for TIME_WAIT-heavy workloads
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 120
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 120

# Reduce UDP timeout for DNS-heavy workloads
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 120
```

Apply without rebooting:

```bash
sysctl -p /etc/sysctl.d/90-conntrack.conf
# Also update hashsize at runtime:
echo 131072 > /sys/module/nf_conntrack/parameters/hashsize
```

## iptables: Tables and Chains

iptables organizes rules into tables, each table containing predefined chains. The tables are evaluated in a fixed order at each hook point.

### The Four Tables

**raw**: Processed first, before conntrack. Used to exempt traffic from connection tracking.

```bash
# Exempt all traffic to/from a specific host from conntrack
iptables -t raw -A PREROUTING -s 10.0.0.5 -j NOTRACK
iptables -t raw -A OUTPUT -d 10.0.0.5 -j NOTRACK
```

**mangle**: Modify packet headers (ToS, TTL, mark packets).

```bash
# Mark packets for policy-based routing
iptables -t mangle -A PREROUTING -p tcp --dport 443 -j MARK --set-mark 100

# Clamp MSS for VPN tunnels (prevent MTU-related issues)
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu
```

**nat**: Network Address Translation. DNAT in PREROUTING, SNAT/MASQUERADE in POSTROUTING.

```bash
# DNAT: forward external port 8080 to internal service
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 192.168.1.10:80

# MASQUERADE: SNAT for pods leaving via eth0 (Kubernetes pod traffic)
iptables -t nat -A POSTROUTING -s 10.244.0.0/16 ! -o cni0 -j MASQUERADE
```

**filter**: The default table for accept/drop/reject decisions.

```bash
# The three built-in chains
iptables -t filter -L INPUT -n -v --line-numbers
iptables -t filter -L FORWARD -n -v --line-numbers
iptables -t filter -L OUTPUT -n -v --line-numbers
```

### iptables Rule Anatomy

```
iptables -t filter -A INPUT -i eth0 -p tcp -s 192.168.1.0/24 \
         --dport 22 -m conntrack --ctstate NEW,ESTABLISHED \
         -j ACCEPT

# Breakdown:
# -t filter          Table
# -A INPUT           Append to chain
# -i eth0            Interface match
# -p tcp             Protocol match
# -s 192.168.1.0/24  Source address match
# --dport 22         Destination port (implicit -m tcp)
# -m conntrack       Load conntrack module
# --ctstate NEW,ESTABLISHED  State match
# -j ACCEPT          Target
```

### iptables Internals: The Blob

iptables rules are stored in kernel memory as a flat binary array. Each rule is a fixed-size `ipt_entry` struct followed by variable-length matches and a target. The entire ruleset for a table is passed as a single blob via `setsockopt(SO_SET_REPLACE)`. This design causes two well-known problems:

1. **Atomicity with overhead**: Updating a single rule requires reading the entire blob, modifying it, and writing it back — O(n) for any change.
2. **No incremental updates**: You cannot add one rule without touching the whole table.

This is why Kubernetes clusters with thousands of Services become slow: kube-proxy's iptables mode must rewrite the entire nat table on every Service update.

```bash
# Measure iptables rule count in a Kubernetes cluster
iptables -t nat -L | grep -c '^KUBE'
# In a cluster with 500 services: ~3000+ KUBE-* rules

# Time a rule flush and restore
time iptables-save > /tmp/iptables.rules
time iptables-restore < /tmp/iptables.rules
# real    0m1.847s   (on a 3000-rule table)
```

## nftables: The Replacement Framework

nftables (introduced in kernel 3.13, recommended since RHEL 8 / Debian 10) addresses iptables' limitations:

- **Single kernel module** (nf_tables) instead of separate modules per protocol family
- **Incremental rule updates** via Netlink — no full-table rewrites
- **Set and map data structures** for O(1) lookups instead of linear rule scanning
- **Unified IPv4/IPv6 handling** in a single ruleset
- **Expression-based rules** that are more readable and composable

### nftables Concepts

```
Table → Chain → Rule → Expression/Statement
         │
         └── Sets and Maps (shared data structures)
```

A **table** belongs to a family: `ip`, `ip6`, `inet` (both), `arp`, `bridge`, `netdev`.

A **chain** has a type (`filter`, `nat`, `route`) and a hook.

A **set** is a named collection of addresses, ports, or prefixes with efficient membership testing.

### Basic nftables Configuration

```bash
# Interactive nft shell
nft -i

# Or via configuration file
cat /etc/nftables.conf
```

```nft
#!/usr/sbin/nft -f

# Flush existing ruleset
flush ruleset

# inet family handles both IPv4 and IPv6
table inet filter {
    # Blocked IP set — updated dynamically
    set blocked_ips {
        type ipv4_addr
        flags dynamic, timeout
        timeout 1h
    }

    chain input {
        type filter hook input priority filter; policy drop;

        # Allow established/related traffic
        ct state established,related accept

        # Drop invalid
        ct state invalid drop

        # Drop blocked IPs
        ip saddr @blocked_ips drop

        # Loopback
        iifname lo accept

        # ICMP — rate limit
        ip protocol icmp limit rate 10/second accept
        ip6 nexthdr icmpv6 limit rate 10/second accept

        # SSH: allow from management subnet only
        tcp dport 22 ip saddr 10.10.0.0/16 accept

        # Web services
        tcp dport { 80, 443 } accept

        # Prometheus node exporter — internal only
        tcp dport 9100 ip saddr 10.0.0.0/8 accept

        log prefix "DROPPED: " flags all drop
    }

    chain forward {
        type filter hook forward priority filter; policy drop;
    }

    chain output {
        type filter hook output priority filter; policy accept;
    }
}

table inet nat {
    chain prerouting {
        type nat hook prerouting priority dstnat;
    }

    chain postrouting {
        type nat hook postrouting priority srcnat;
        # MASQUERADE for container traffic
        ip saddr 172.16.0.0/12 oifname eth0 masquerade
    }
}
```

Load the ruleset:

```bash
nft -f /etc/nftables.conf
systemctl enable --now nftables
```

### nftables Sets for Efficient Matching

The key performance advantage of nftables is set-based matching. A set uses a hash table or radix tree internally, providing O(1) lookup versus O(n) linear scan in iptables.

```nft
table inet filter {
    # Named set of allowed management IPs
    set mgmt_hosts {
        type ipv4_addr
        elements = { 10.10.1.5, 10.10.1.6, 10.10.1.7 }
    }

    # Interval set (CIDR ranges)
    set internal_networks {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,
            172.16.0.0/12,
            192.168.0.0/16
        }
    }

    # Concatenation: match src IP + dst port tuple
    set rate_limit_exceptions {
        type ipv4_addr . inet_service
        elements = { 203.0.113.5 . 443, 198.51.100.0/24 . 80 }
    }

    chain input {
        type filter hook input priority filter; policy drop;
        ip saddr @mgmt_hosts tcp dport 22 accept
        ip saddr @internal_networks accept
        ip saddr . tcp dport @rate_limit_exceptions accept
    }
}
```

### Maps for NAT Dispatch

```nft
table ip nat {
    # Map destination port to backend host
    map port_to_backend {
        type inet_service : ipv4_addr . inet_service
        elements = {
            8080 : 192.168.1.10 . 80,
            8443 : 192.168.1.10 . 443,
            9090 : 192.168.1.11 . 9090
        }
    }

    chain prerouting {
        type nat hook prerouting priority dstnat;
        # Use the map to DNAT — single rule handles all ports
        dnat ip addr . port to tcp dport map @port_to_backend
    }
}
```

### Counters and Meters

```nft
table inet filter {
    # Named counter (persists across rule updates)
    counter ssh_accepted {}
    counter ssh_rejected {}

    # Meter: per-IP connection rate limiting
    meter ssh_rate {
        type ipv4_addr
        size 65535
    }

    chain input {
        type filter hook input priority filter; policy drop;

        tcp dport 22 {
            # Allow max 3 new connections per minute per source
            ct state new \
                meter ssh_rate { ip saddr timeout 60s limit rate 3/minute } \
                counter name ssh_accepted accept

            counter name ssh_rejected drop
        }
    }
}
```

## Migrating from iptables to nftables

### Step 1: Audit Existing Rules

```bash
# Export all iptables rules
iptables-save > /tmp/iptables-backup.rules
ip6tables-save > /tmp/ip6tables-backup.rules

# Count rules per table
iptables-save | grep -c '^-A'
# 847

# Identify custom chains
iptables-save | grep '^:' | grep -v 'ACCEPT\|DROP\|RETURN'
```

### Step 2: Automated Translation with iptables-translate

```bash
# Translate individual rules
iptables-translate -A INPUT -p tcp --dport 22 -j ACCEPT
# nft add rule ip filter INPUT tcp dport 22 accept

# Translate entire ruleset
iptables-restore-translate -f /tmp/iptables-backup.rules > /tmp/nftables-translated.conf

# Review and clean up the translation
cat /tmp/nftables-translated.conf
```

The translator produces working nft rules, but the output is verbose and misses optimization opportunities. Post-translation cleanup includes:

1. Merging separate port rules into sets: `tcp dport 80 accept; tcp dport 443 accept` → `tcp dport { 80, 443 } accept`
2. Consolidating CIDR ranges into interval sets
3. Converting custom chains to named chains or inline expressions
4. Removing redundant state matches

### Step 3: Parallel Validation

Run iptables and nftables simultaneously using nftables compatibility mode:

```bash
# iptables-nft uses nftables backend but accepts iptables syntax
update-alternatives --set iptables /usr/sbin/iptables-nft
update-alternatives --set ip6tables /usr/sbin/ip6tables-nft

# Now iptables rules are translated to nftables internally
# Verify the nftables table was created:
nft list tables
# table ip filter
# table ip nat
# table ip mangle
# table ip raw
```

This allows existing iptables-based tools (kube-proxy, ufw, fail2ban) to continue working while you prepare a native nftables configuration.

### Step 4: Kubernetes kube-proxy Migration

kube-proxy in iptables mode generates thousands of rules. The nftables mode (kube-proxy v1.29+) is dramatically more efficient:

```yaml
# kube-proxy ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-proxy
  namespace: kube-system
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: "nftables"          # Was "iptables"
    nftables:
      masqueradeBit: 14
      masqueradeAll: false
      syncPeriod: 30s
      minSyncPeriod: 1s
```

Rolling out:

```bash
# Apply to one node at a time
kubectl cordon node-01
kubectl drain node-01 --ignore-daemonsets --delete-emptydir-data

# Update kube-proxy config
kubectl edit cm kube-proxy -n kube-system

# Restart kube-proxy DaemonSet
kubectl rollout restart daemonset/kube-proxy -n kube-system

kubectl uncordon node-01
```

### Step 5: Handling fail2ban with nftables

fail2ban 1.0+ has native nftables support:

```ini
# /etc/fail2ban/jail.local
[DEFAULT]
banaction = nftables-multiport
banaction_allports = nftables-allports
chain = input
```

```ini
# /etc/fail2ban/action.d/nftables-multiport.conf
[Definition]
actionstart = nft add table inet fail2ban
              nft add chain inet fail2ban <chain> '{ type filter hook input priority -1; }'
              nft add set inet fail2ban addr-set-<name> '{ type ipv4_addr; }'
              nft add rule inet fail2ban <chain> ip saddr @addr-set-<name> drop

actionstop  = nft flush chain inet fail2ban <chain>
              nft delete chain inet fail2ban <chain>
              nft delete table inet fail2ban

actionban   = nft add element inet fail2ban addr-set-<name> { <ip> }
actionunban = nft delete element inet fail2ban addr-set-<name> { <ip> }
```

## Debugging and Tracing

### nftables Rule Tracing

```nft
table inet debug {
    chain trace_input {
        type filter hook input priority -500;
        # Trace packets from a specific source
        ip saddr 203.0.113.1 meta nftrace set 1
    }
}
```

```bash
# Start tracing monitor
nft monitor trace

# In another terminal, send a test packet
# The monitor shows each rule evaluation:
# trace id 4e0f2b5a inet filter input packet: iif "eth0" ether saddr ...
#   inet filter input rule tcp dport { 80, 443 } accept (verdict accept)
```

### conntrack Events During Debugging

```bash
# Watch conntrack events for a specific host
conntrack -E -s 10.0.0.5 -e NEW,DESTROY

# Check if a packet is being DNAT'd correctly
conntrack -L -p tcp --dport 80 | head -5
# tcp      6 299 ESTABLISHED src=203.0.113.1 dst=93.184.216.34 sport=54231 dport=80
#                              src=192.168.1.10 dst=203.0.113.1 sport=80 dport=54231
#                              [ASSURED] mark=0 use=1
```

## Performance Comparison

```bash
# Benchmark: time to apply a 3000-rule policy
# iptables (full table replace):
time iptables-restore < /tmp/3000-rules.rules
# real 0m2.143s

# nftables (atomic ruleset replace):
time nft -f /tmp/3000-rules.nft
# real 0m0.087s

# nftables (incremental: add one rule):
time nft add rule inet filter input ip saddr 10.0.0.0/8 accept
# real 0m0.003s

# Packet throughput with 1000 rules matching nothing (pps, iperf3 UDP):
# iptables (linear scan): 890,000 pps
# nftables (hash set):   2,400,000 pps
```

## Summary

The Netfilter framework is the foundation for all packet filtering, NAT, and connection tracking on Linux. Key architectural insights:

1. **Hook priorities** determine evaluation order — conntrack (-200) always runs before mangle (-150) and nat (-100), ensuring translation uses original addresses.
2. **iptables' blob model** creates O(n) update cost, explaining kube-proxy's scalability limits in large clusters.
3. **nftables sets** provide O(1) membership testing, replacing dozens of separate rules with a single set lookup.
4. **The iptables-nft shim** enables gradual migration: existing iptables tooling continues to work while native nftables rules are developed.
5. **kube-proxy nftables mode** (v1.29+) eliminates the thousands of KUBE-* rules that slow down large clusters.

For any cluster with more than 200 Services, migrating kube-proxy from iptables to nftables mode is among the highest-leverage performance optimizations available at the infrastructure layer.
