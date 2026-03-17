---
title: "Linux Packet Filtering with nftables: Modern Firewall Configuration"
date: 2029-06-15T00:00:00-05:00
draft: false
tags: ["Linux", "nftables", "Networking", "Security", "Firewall", "iptables"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to nftables: the modern Linux packet filtering framework. Covers tables, chains, rules, sets and maps, stateful connection tracking, NAT rules, nftrace debugging, and step-by-step migration from iptables."
more_link: "yes"
url: "/linux-nftables-packet-filtering-modern-firewall/"
---

nftables replaced iptables as the standard Linux packet filtering framework in kernel 3.13, and is the default on all major distributions since around 2019. Despite this, most documentation and tooling still references iptables. This guide covers nftables from the ground up: its data model, rule syntax, sets and maps for efficient matching, stateful filtering, NAT, debugging with nftrace, and migrating existing iptables rules.

<!--more-->

# Linux Packet Filtering with nftables: Modern Firewall Configuration

## Why nftables

nftables addresses the fundamental design limitations of iptables:

| Feature | iptables | nftables |
|---|---|---|
| Atomic updates | No (rule-by-rule) | Yes (transactions) |
| IPv4 + IPv6 | Separate tools | Single ruleset |
| Performance | O(n) rule scan | Sets use hash tables |
| Syntax | Separate match/target flags | Unified expression language |
| Sets/maps | External ipset tool | Built-in |
| Debugging | LOG target, tcpdump | nftrace with context |
| ABI stability | Changes break tooling | Stable netlink API |

## Architecture

```
Netfilter hooks:
  NIC → prerouting → [routing] → input → process
                              ↘ forward →
        process → output → [routing] → postrouting → NIC

nftables layers:
  Table  (family: ip, ip6, inet, arp, bridge, netdev)
    └── Chain (type: filter/nat/mangle/route, hook, priority)
           └── Rule (matches → statement)
```

### Families

| Family | Handles |
|---|---|
| `ip` | IPv4 |
| `ip6` | IPv6 |
| `inet` | IPv4 + IPv6 (recommended) |
| `arp` | ARP packets |
| `bridge` | Bridged traffic |
| `netdev` | Device ingress/egress (XDP alternative) |

## Basic nftables Commands

```bash
# Show current ruleset
nft list ruleset

# Show ruleset in JSON format
nft -j list ruleset

# Flush all rules (WARNING: drops all firewall rules)
nft flush ruleset

# Add rules from a file (atomic batch)
nft -f /etc/nftables.conf

# Check a file for syntax errors without applying
nft -c -f /etc/nftables.conf

# Export current rules to a file
nft list ruleset > /etc/nftables.rules
```

## Tables and Chains

### Creating a Table

```bash
# Create an inet table (handles both IPv4 and IPv6)
nft add table inet filter

# List tables
nft list tables
```

### Creating Chains

```bash
# Create a base chain (connected to a Netfilter hook)
nft add chain inet filter input \
    '{ type filter hook input priority 0; policy drop; }'

nft add chain inet filter forward \
    '{ type filter hook forward priority 0; policy drop; }'

nft add chain inet filter output \
    '{ type filter hook output priority 0; policy accept; }'

# Create a regular chain (called from a base chain, not directly connected to a hook)
nft add chain inet filter tcp-services
```

### Chain Priorities

Lower priority numbers run first:

| Priority | Name | Typical use |
|---|---|---|
| -400 | NF_IP_PRI_CONNTRACK_DEFRAG | Connection tracking defrag |
| -300 | NF_IP_PRI_RAW | Raw table |
| -200 | NF_IP_PRI_SELINUX_FIRST | SELinux |
| -150 | NF_IP_PRI_CONNTRACK | Connection tracking |
| 0 | NF_IP_PRI_FILTER | Main filter rules |
| 100 | NF_IP_PRI_SECURITY | Security modules |
| 300 | NF_IP_PRI_NAT_SRC | SNAT |

## Rules

### Rule Syntax

```
nft add rule <table> <chain> [position] <matches> <statement>
```

### Common Match Expressions

```bash
# TCP/UDP port matching
nft add rule inet filter input tcp dport 22 accept
nft add rule inet filter input tcp dport { 80, 443 } accept
nft add rule inet filter input udp dport 53 accept

# IP address matching
nft add rule inet filter input ip saddr 192.168.1.0/24 accept
nft add rule inet filter input ip daddr 10.0.0.1 drop

# Interface
nft add rule inet filter input iifname lo accept
nft add rule inet filter input iifname "eth0" accept

# Protocol
nft add rule inet filter input ip protocol icmp accept
nft add rule inet filter input meta l4proto icmpv6 accept

# Connection state
nft add rule inet filter input ct state established,related accept
nft add rule inet filter input ct state invalid drop

# Rate limiting
nft add rule inet filter input icmp type echo-request limit rate 10/second accept
nft add rule inet filter input icmp type echo-request drop

# Mark/metadata
nft add rule inet filter input meta mark 0x1 accept

# Combined matches (AND)
nft add rule inet filter input \
    tcp dport 22 \
    ip saddr 10.0.0.0/8 \
    ct state new \
    accept
```

### Rule Statements

```bash
# Terminating statements
accept
drop
reject                           # TCP RST for TCP, ICMP port unreachable for UDP
reject with tcp reset
reject with icmpx type port-unreachable

# Logging
log prefix "INPUT_DROP: "
log prefix "INPUT_DROP: " level debug
log group 1                     # NFLOG group for ulogd

# Jump to another chain
jump tcp-services
goto tcp-services               # Like jump but no return

# Counters
counter
counter name "ssh-attempts"

# Continue to next rule (default behavior, rarely needed explicitly)
continue
```

## A Complete Firewall Ruleset

```bash
# /etc/nftables.conf — complete server firewall

flush ruleset

table inet firewall {

    # Trusted management networks
    set trusted_mgmt {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,
            172.16.0.0/12,
            192.168.0.0/16
        }
    }

    # Rate limit counter for new connections
    meter ssh_ratelimit {
        type ipv4_addr
        size 65535
    }

    chain input {
        type filter hook input priority filter; policy drop;

        # Always allow loopback
        iifname lo accept

        # Allow established/related connections
        ct state established,related accept

        # Drop invalid packets
        ct state invalid counter log prefix "INVALID: " drop

        # ICMP (required for network operation)
        ip protocol icmp  icmp type  { echo-request, echo-reply, destination-unreachable,
                                       time-exceeded, parameter-problem } accept
        meta l4proto icmpv6 icmpv6 type { echo-request, echo-reply, destination-unreachable,
                                          packet-too-big, time-exceeded, parameter-problem,
                                          nd-neighbor-solicit, nd-neighbor-advert,
                                          nd-router-solicit, nd-router-advert,
                                          mld-listener-query } accept

        # SSH: rate limit new connections, allow from trusted networks without limit
        ip saddr @trusted_mgmt tcp dport 22 ct state new accept
        tcp dport 22 ct state new \
            add @ssh_ratelimit { ip saddr limit rate 3/minute burst 5 packets } \
            accept
        tcp dport 22 ct state new counter log prefix "SSH_RATE_LIMIT: " drop

        # Web services
        tcp dport { 80, 443 } ct state new accept

        # DNS (if this is a resolver)
        # tcp dport 53 accept
        # udp dport 53 accept

        # Log everything that hits the default drop policy
        counter log prefix "INPUT_DROP: "
    }

    chain forward {
        type filter hook forward priority filter; policy drop;

        # Allow established/related
        ct state established,related accept

        # Allow forwarding for specific source networks if this is a router
        # ip saddr 192.168.1.0/24 oifname "eth0" accept

        counter log prefix "FORWARD_DROP: "
    }

    chain output {
        type filter hook output priority filter; policy accept;
        # Most servers allow all outbound; add restrictions here if needed
    }
}
```

### Loading and Making Persistent

```bash
# Test the configuration
nft -c -f /etc/nftables.conf
echo $?  # 0 = no errors

# Apply atomically (all rules applied in one transaction)
nft -f /etc/nftables.conf

# Enable the systemd service for persistence across reboots
systemctl enable --now nftables

# Verify
nft list ruleset
nft list table inet firewall
nft list chain inet firewall input
```

## Sets and Maps

Sets and maps are nftables' killer feature for performance at scale.

### Sets

```bash
# Named set of IP addresses (used above for trusted management networks)
nft add set inet firewall blocked_ips { type ipv4_addr\; }
nft add element inet firewall blocked_ips { 1.2.3.4, 5.6.7.8 }
nft add rule inet firewall input ip saddr @blocked_ips drop

# Set with timeout (auto-expire entries)
nft add set inet firewall temp_blocklist {
    type ipv4_addr\;
    timeout 1h\;
    flags timeout\;
}

# Interval sets (for CIDR ranges)
nft add set inet firewall allowed_ranges {
    type ipv4_addr\;
    flags interval\;
    elements = { 10.0.0.0/8, 172.16.0.0/12 }\;
}

# Port sets
nft add set inet firewall allowed_ports {
    type inet_service\;
    elements = { 22, 80, 443, 8080 }\;
}
nft add rule inet firewall input tcp dport @allowed_ports accept

# Concatenated set (multi-key)
nft add set inet firewall port_proto {
    type inet_service . inet_proto\;
    elements = { 80 . tcp, 443 . tcp, 53 . udp }\;
}
nft add rule inet firewall input \
    meta l4proto . th dport @port_proto accept
```

### Maps

Maps translate one value to another, enabling policy decisions based on lookup tables:

```bash
# Map source IP to verdict
nft add map inet firewall ip_verdict {
    type ipv4_addr : verdict\;
    elements = {
        192.168.1.100 : accept,
        10.0.0.99     : drop
    }\;
}
nft add rule inet firewall input ip saddr vmap @ip_verdict

# Port-to-interface map (policy routing)
nft add map inet firewall port_to_chain {
    type inet_service : verdict\;
    elements = {
        22  : jump ssh-rules,
        80  : jump http-rules,
        443 : jump https-rules
    }\;
}
nft add rule inet firewall input tcp dport vmap @port_to_chain
```

## Stateful Connection Tracking

nftables uses the kernel's Netfilter connection tracking (conntrack) for stateful filtering:

```bash
# Connection states:
# new      — first packet of a new connection
# established — packet is part of an established connection
# related  — related connection (e.g., FTP data channel)
# invalid  — does not match any connection

# Standard stateful pattern
nft add rule inet firewall input ct state established,related accept
nft add rule inet firewall input ct state invalid drop
nft add rule inet firewall input ct state new tcp dport 443 accept

# Advanced: limit new connection rate per source IP using conntrack
nft add rule inet firewall input \
    tcp dport 80 \
    ct state new \
    limit rate over 100/second \
    counter drop

# Track specific protocols
nft add rule inet firewall input \
    ip protocol udp \
    ct state new \
    udp dport 53 \
    accept

# View connection tracking table
conntrack -L
conntrack -L | grep ESTABLISHED | wc -l
```

## NAT Rules

NAT in nftables uses the `nat` type chains at the `prerouting` and `postrouting` hooks.

### MASQUERADE (Source NAT for outbound traffic)

```bash
# Internet gateway: masquerade outbound traffic
nft add table ip nat
nft add chain ip nat postrouting \
    '{ type nat hook postrouting priority srcnat; }'

# Masquerade all traffic leaving eth0
nft add rule ip nat postrouting oifname "eth0" masquerade

# SNAT to a specific address (more efficient than masquerade when IP is static)
nft add rule ip nat postrouting oifname "eth0" snat to 203.0.113.1
```

### DNAT (Port Forwarding)

```bash
nft add chain ip nat prerouting \
    '{ type nat hook prerouting priority dstnat; }'

# Forward port 8080 to internal server
nft add rule ip nat prerouting \
    iifname "eth0" \
    tcp dport 8080 \
    dnat to 192.168.1.100:80

# Load balance across multiple backends using a map
nft add map ip nat lb_map {
    type inet_service : ipv4_addr . inet_service\;
    elements = {
        80  : 192.168.1.10 . 80,
        443 : 192.168.1.10 . 443
    }\;
}

# Multiple backends with random selection
nft add rule ip nat prerouting \
    tcp dport { 80, 443 } \
    dnat ip addr . port to numgen random mod 2 map {
        0 : 192.168.1.10 . 80,
        1 : 192.168.1.11 . 80
    }
```

### Transparent Proxy (TPROXY)

```bash
# Redirect traffic to a local transparent proxy
nft add chain ip mangle prerouting \
    '{ type filter hook prerouting priority mangle; }'

nft add rule ip mangle prerouting \
    tcp dport 80 \
    meta mark set 0x1 \
    tproxy to :3129
```

## nftrace: Debugging Rules

`nftrace` is nftables' built-in packet tracing mechanism. Unlike iptables LOG, it shows exactly which rules each packet matches.

```bash
# Enable tracing on packets matching a filter
# First, add a trace rule that marks packets for tracing
nft add rule inet firewall input \
    ip saddr 10.0.0.100 \
    tcp dport 443 \
    meta nftrace set 1

# Then monitor the trace output
nft monitor trace

# Example trace output:
# trace id 7f2a3c4d inet firewall input packet: iif "eth0" ip saddr 10.0.0.100 ip daddr 10.0.0.1 ip ttl 64 ip protocol tcp tcp dport 443
# trace id 7f2a3c4d inet firewall input rule ct state established,related accept (verdict accept)

# Trace with ulogd2 for persistent logging to a file
# Add to nftables rules:
nft add rule inet firewall input ip saddr 1.2.3.4 log group 100 prefix "TRACE: "
# Configure ulogd2 to write group 100 to a file
```

### Debugging a Rule That Is Not Working

```bash
# Step 1: Check if packets are reaching the chain at all
nft add rule inet firewall input counter log prefix "DEBUG_INPUT: "

# Step 2: Add counter to the specific rule
nft add rule inet firewall input tcp dport 443 counter accept

# Check counter values
nft list chain inet firewall input

# Example output showing counters:
# chain input {
#     type filter hook input priority filter; policy drop;
#     iifname "lo" accept
#     ct state established,related accept  # packets: 45231 bytes: 8734928
#     tcp dport 443 counter accept         # packets: 1523 bytes: 234567

# Step 3: Use nftrace for packet-level inspection
# Step 4: Check conntrack table
conntrack -L | grep "dport=443"
```

## Migration from iptables

### Automatic Translation

```bash
# Install iptables-to-nftables translator
apt install iptables-nftables-compat  # or: dnf install iptables-nftables-compat

# Translate existing iptables rules
iptables-save | iptables-restore-translate > /etc/nftables-translated.conf

# Review the translated rules
cat /etc/nftables-translated.conf

# IMPORTANT: Always review — the translator is not perfect
# In particular, check:
# - REJECT targets (may need 'with tcp reset' addition)
# - LOG targets (syntax changes slightly)
# - Module-specific matches (hashlimit, recent)
```

### Manual Migration Example

```bash
# iptables original:
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -m state --state NEW -j ACCEPT
iptables -A INPUT -j DROP

# nftables equivalent:
nft add rule inet filter input ct state established,related accept
nft add rule inet filter input tcp dport 22 ct state new accept
# default policy: drop (set in chain definition)
```

### Running Both in Parallel

During migration, you can run iptables rules alongside nftables. They are independent:

```bash
# Check which backend iptables is using
update-alternatives --display iptables

# Switch iptables to use nf_tables backend (uses nftables kernel infrastructure)
update-alternatives --set iptables /usr/sbin/iptables-nft
update-alternatives --set ip6tables /usr/sbin/ip6tables-nft

# This makes existing iptables rules visible in nftables
nft list table ip filter  # Shows iptables rules
nft list table ip6 filter
```

## Kubernetes and nftables

Modern Kubernetes versions (1.29+) support nftables as the kube-proxy backend:

```yaml
# kube-proxy configmap
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-proxy
  namespace: kube-system
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: nftables   # replaces: iptables
```

```bash
# Inspect kube-proxy nftables rules
nft list table ip kube-proxy
nft list table ip6 kube-proxy

# Services appear as maps
nft list map ip kube-proxy service-ips
```

## Practical nftables Snippets

### Blocklist with Dynamic Updates

```bash
# Create a persistent set that survives rule reloads
cat >> /etc/nftables.conf << 'EOF'
set blocklist {
    type ipv4_addr
    flags persistent, timeout
    timeout 24h
    size 65535
}
EOF

# Block an IP (with 24h auto-expiry)
nft add element inet firewall blocklist { 1.2.3.4 }

# Batch block from a file
nft add element inet firewall blocklist { $(paste -sd, /tmp/bad-ips.txt) }

# Script for fail2ban-like functionality
#!/bin/bash
# block-ip.sh
IP="$1"
nft add element inet firewall blocklist { "$IP" timeout 1h }
logger "Blocked IP: $IP for 1 hour"
```

### Connection Flood Protection

```bash
# Protect against SYN floods
nft add chain inet firewall syn-flood
nft add rule inet firewall syn-flood \
    limit rate 100/second burst 200 packets return
nft add rule inet firewall syn-flood \
    counter log prefix "SYN_FLOOD: " drop

nft add rule inet firewall input \
    tcp flags syn \
    ct state new \
    jump syn-flood
```

## Summary

nftables is the present and future of Linux packet filtering. Its atomic update model, built-in sets and maps, and unified IPv4/IPv6 handling make it superior to iptables for all new deployments. The migration path is well-supported — `iptables-restore-translate` converts existing rules, and the nft-variants of iptables tools bridge the gap for tooling that has not yet been updated.

For production servers, the most important nftables features are: stateful filtering with conntrack, dynamic sets for blocklists and rate limiting, and nftrace for debugging rules without resorting to tcpdump.
