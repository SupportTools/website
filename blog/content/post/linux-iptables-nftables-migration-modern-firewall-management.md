---
title: "Linux iptables and nftables Migration: Modern Firewall Management for Production Systems"
date: 2030-11-06T00:00:00-05:00
draft: false
tags: ["Linux", "iptables", "nftables", "Firewall", "Network Security", "Kubernetes", "netfilter"]
categories:
- Linux
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Firewall management guide covering iptables-to-nftables migration, nftables rule syntax, set-based packet matching, nft scripting, Docker and Kubernetes iptables interaction, netfilter hook priorities, and stateful connection tracking with nftables."
more_link: "yes"
url: "/linux-iptables-nftables-migration-modern-firewall-management/"
---

nftables has been the default firewall framework in major Linux distributions since kernel 3.13 and has replaced iptables as the preferred user-space tool in RHEL 8/9, Debian 10+, and Ubuntu 20.04+. Despite this, many production systems still rely on iptables rules for Docker, Kubernetes (kube-proxy), and system firewalls. This guide covers the complete migration path from iptables to nftables, managing coexistence with container orchestration tools, and building production-grade stateful firewall configurations with nftables.

<!--more-->

## netfilter Architecture

Both iptables and nftables are user-space frontends to the Linux kernel's netfilter framework. Netfilter operates via hooks in the network stack that fire at specific points in packet processing:

```
Incoming packet
        │
        ▼
  ┌─────────────┐
  │  PREROUTING │  ← Hook 0: Before routing decision
  │  NF_INET_   │
  │  PRE_ROUTING│
  └──────┬──────┘
         │
    ┌────┴────┐
    │  Route  │  ← Kernel routing table lookup
    └────┬────┘
         │
   ┌─────┴──────────────────────┐
   │                             │
   ▼                             ▼
┌──────────┐              ┌─────────────┐
│  LOCAL   │              │   FORWARD   │  ← Hook 2: Transit packets
│  INPUT   │  ← Hook 1    │   NF_INET_  │
└──────────┘              │   FORWARD   │
   │                      └──────┬──────┘
   ▼                             │
[Process]                        ▼
   │                     ┌─────────────┐
   ▼                     │ POSTROUTING │  ← Hook 4
┌──────────┐             └─────────────┘
│  OUTPUT  │  ← Hook 3
└──────────┘
       │
       └──────────────────► POSTROUTING
```

In nftables, hooks are specified explicitly in table and chain declarations, giving precise control over where rules execute and in what order relative to other hooks.

## nftables Core Concepts

### Tables, Chains, and Rules

```bash
# nftables is configured via the 'nft' command or script files

# Show current nftables configuration
nft list ruleset

# Tables: top-level namespace for chains
# Families: ip (IPv4), ip6 (IPv6), inet (both), arp, bridge, netdev

# Create a table in the inet family (covers both IPv4 and IPv6)
nft add table inet filter

# Chains within a table
# type: filter, nat, route
# hook: prerouting, input, forward, output, postrouting
# priority: integer; lower numbers execute first
#   -400 = before conntrack (-300 conntrack default)
#   -200 = before nf_nat prerouting
#   -100 = before IP stack
#    0   = default filter priority
#    100 = after mangle
#    300 = after conntrack state tracking

nft add chain inet filter input \
  '{ type filter hook input priority 0; policy drop; }'

nft add chain inet filter forward \
  '{ type filter hook forward priority 0; policy drop; }'

nft add chain inet filter output \
  '{ type filter hook output priority 0; policy accept; }'

# Add rules
# Rules are evaluated in order; first match wins
nft add rule inet filter input ct state established,related accept
nft add rule inet filter input iif lo accept
nft add rule inet filter input ip protocol icmp accept
nft add rule inet filter input tcp dport 22 accept
nft add rule inet filter input tcp dport { 80, 443 } accept

# Insert a rule at a specific position
nft insert rule inet filter input \
  position 0 \
  meta l4proto tcp tcp dport 8080 log prefix "HTTP-8080: " accept

# Delete a rule by handle (get handle with: nft -a list ruleset)
nft delete rule inet filter input handle 12
```

### nftables Script Format

Production firewall configurations should be managed as files, not ad-hoc commands:

```bash
# /etc/nftables/main.nft
# Flush all existing rules and load this configuration atomically
flush ruleset

# The 'inet' family handles both IPv4 and IPv6
table inet filter {

    # ─── Sets (reusable groups of IPs, ports, etc.) ───────────────────────

    # Management IP ranges — used in multiple rules
    set management_networks {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,
            172.16.0.0/12,
            192.168.0.0/16
        }
    }

    set management_networks_v6 {
        type ipv6_addr
        flags interval
        elements = {
            fd00::/8
        }
    }

    # Blocked IPs — dynamically populated, with timeout
    set blocklist {
        type ipv4_addr
        flags dynamic, timeout
        timeout 1h
        gc-interval 30m
    }

    # Rate limiting set for SSH brute force protection
    set ssh_ratelimit {
        type ipv4_addr
        flags dynamic
        timeout 60s
    }

    # Allowed service ports
    set allowed_tcp_ports {
        type inet_service
        flags interval
        elements = { 80, 443, 8080, 8443 }
    }

    # ─── Chains ───────────────────────────────────────────────────────────

    # INPUT chain: traffic destined for this host
    chain input {
        type filter hook input priority filter
        policy drop

        # Allow established connections (conntrack)
        ct state established,related accept
        ct state invalid drop

        # Allow loopback
        iif "lo" accept

        # ICMP (IPv4): allow ping, PMTUD; rate-limit to prevent flood
        ip protocol icmp icmp type {
            echo-reply,
            destination-unreachable,
            time-exceeded,
            parameter-problem
        } accept

        ip protocol icmp icmp type echo-request \
            limit rate 10/second \
            accept

        # ICMPv6: required for IPv6 neighbor discovery
        icmpv6 type {
            destination-unreachable,
            packet-too-big,
            time-exceeded,
            parameter-problem,
            nd-router-advert,
            nd-neighbor-solicit,
            nd-neighbor-advert,
            mld-listener-query,
            mld-listener-report
        } accept

        # Drop blocklisted IPs
        ip saddr @blocklist drop

        # SSH: rate limit and restrict to management networks
        tcp dport 22 \
            ip saddr @management_networks \
            ct state new \
            add @ssh_ratelimit { ip saddr limit rate 5/minute } \
            accept

        # SSH brute force: block IPs exceeding rate limit
        tcp dport 22 \
            ct state new \
            add @blocklist { ip saddr timeout 1h } \
            log prefix "SSH-BLOCKED: " \
            drop

        # Web services: accept from anywhere
        tcp dport @allowed_tcp_ports accept

        # DNS (if this is a DNS server)
        udp dport 53 accept
        tcp dport 53 accept

        # Log and drop everything else
        log prefix "INPUT-DROP: " flags all limit rate 5/minute
    }

    # FORWARD chain: traffic transiting this host (router/container host)
    chain forward {
        type filter hook forward priority filter
        policy drop

        ct state established,related accept
        ct state invalid drop

        # Container traffic forwarding (adjust interface names as needed)
        iif "docker0" oif "eth0" accept
        iif "eth0" oif "docker0" ct state established,related accept
    }

    # OUTPUT chain: traffic originating from this host
    chain output {
        type filter hook output priority filter
        policy accept

        # You can restrict outbound traffic here if needed
        # For most servers, output is allowed by default
    }
}

# NAT table
table inet nat {

    chain prerouting {
        type nat hook prerouting priority dstnat
        policy accept

        # Port forwarding example: redirect external 8080 to internal :80
        # tcp dport 8080 dnat to :80
    }

    chain postrouting {
        type nat hook postrouting priority srcnat
        policy accept

        # Masquerade outbound traffic from container networks
        ip saddr 172.17.0.0/16 oif "eth0" masquerade
        ip saddr 10.244.0.0/16 oif "eth0" masquerade
    }
}
```

```bash
# Apply the configuration atomically
nft -f /etc/nftables/main.nft

# Validate configuration without applying
nft -c -f /etc/nftables/main.nft

# Enable nftables on boot (systemd)
systemctl enable nftables
systemctl start nftables
```

## Dynamic Sets and Rate Limiting

nftables sets are one of the most powerful features — they allow rules to reference groups of addresses, ports, or interfaces that can be updated without rule changes.

```bash
# Dynamic rate limiting — automatically block scanners
# This configuration detects and blocks port scanners

cat >> /etc/nftables/main.nft << 'EOF'

table inet portscan_protection {

    set scanners {
        type ipv4_addr
        flags dynamic, timeout
        timeout 4h
        size 65536    # Maximum entries before oldest is evicted
        gc-interval 1h
    }

    chain prerouting {
        type filter hook prerouting priority -100

        # Detect and block port scanners
        # If new TCP connection is made to a closed port, add to scanner set
        # After 3 connections to closed ports within 60s, drop all traffic
        tcp flags & (fin|syn|rst|psh|ack|urg) == syn \
            ct state new \
            meter portscan {
                ip saddr timeout 60s limit rate over 3/minute
            } \
            add @scanners { ip saddr } \
            drop

        ip saddr @scanners drop
    }
}
EOF
```

### Stateful Connection Tracking Configuration

```bash
# /etc/nftables/conntrack.nft
# Advanced conntrack configuration for high-connection-rate environments

# Tune conntrack kernel parameters for high-traffic production systems
# (These are kernel sysctl settings, not nftables rules)

cat > /etc/sysctl.d/99-conntrack.conf << 'EOF'
# Maximum number of tracked connections
# Default 65536; increase for servers with many concurrent connections
net.netfilter.nf_conntrack_max = 1048576

# Conntrack hash table size (set to nf_conntrack_max / 4)
net.netfilter.nf_conntrack_buckets = 262144

# Timeout values (seconds)
net.netfilter.nf_conntrack_tcp_timeout_established = 3600
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 15
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 120

# Enable conntrack accounting (useful for traffic statistics)
net.netfilter.nf_conntrack_acct = 1

# Enable timestamp tracking (useful for debugging connection issues)
net.netfilter.nf_conntrack_timestamp = 1
EOF

sysctl -p /etc/sysctl.d/99-conntrack.conf

# Monitor conntrack table utilization
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# View active connections
nft list meter inet portscan_protection/portscan
conntrack -L | head -20
conntrack -S  # Statistics
```

## iptables-to-nftables Migration

### Migration Tools

```bash
# Convert existing iptables rules to nftables syntax
# iptables-translate converts individual rules
iptables-translate -A INPUT -p tcp --dport 443 -j ACCEPT
# Output: nft add rule ip filter INPUT tcp dport 443 counter accept

# iptables-restore-translate converts complete rulesets
iptables-save > /tmp/iptables-backup.rules
iptables-restore-translate -f /tmp/iptables-backup.rules > /tmp/iptables-translated.nft

# Review and clean up the translated rules
# The translation is not always perfect — common issues:
# 1. -m state replaced by ct state
# 2. -m multiport replaced by sets { port1, port2, ... }
# 3. REJECT --reject-with tcp-reset replaced by tcp reset
# 4. -m iprange removed (nftables uses intervals natively)

# For ip6tables
ip6tables-save | iptables-restore-translate > /tmp/ip6tables-translated.nft
```

### Common iptables-to-nftables Translations

```bash
# ─── INPUT RULES ──────────────────────────────────────────────────────────

# iptables: allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# nftables:
# ct state established,related accept

# iptables: allow SSH from specific IP
iptables -A INPUT -s 10.0.0.5 -p tcp --dport 22 -j ACCEPT
# nftables:
# ip saddr 10.0.0.5 tcp dport 22 accept

# iptables: multiport
iptables -A INPUT -p tcp -m multiport --dports 80,443,8080 -j ACCEPT
# nftables:
# tcp dport { 80, 443, 8080 } accept

# iptables: rate limiting (hashlimit)
iptables -A INPUT -p tcp --dport 22 -m hashlimit \
  --hashlimit-upto 5/minute --hashlimit-mode srcip \
  --hashlimit-name ssh-limit -j ACCEPT
# nftables:
# tcp dport 22 ct state new \
#   meter ssh-limit { ip saddr timeout 60s limit rate 5/minute } accept

# iptables: LOG target
iptables -A INPUT -j LOG --log-prefix "INPUT-DROP: " --log-level 4
# nftables:
# log prefix "INPUT-DROP: " level warn

# iptables: REJECT with tcp-reset
iptables -A INPUT -p tcp -j REJECT --reject-with tcp-reset
# nftables:
# tcp reset

# ─── NAT RULES ──────────────────────────────────────────────────────────

# iptables: DNAT
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 192.168.1.10:80
# nftables:
# tcp dport 8080 dnat to 192.168.1.10:80

# iptables: MASQUERADE
iptables -t nat -A POSTROUTING -s 172.17.0.0/16 -o eth0 -j MASQUERADE
# nftables:
# ip saddr 172.17.0.0/16 oif "eth0" masquerade

# iptables: SNAT
iptables -t nat -A POSTROUTING -s 10.0.0.0/8 -o eth0 -j SNAT --to-source 203.0.113.5
# nftables:
# ip saddr 10.0.0.0/8 oif "eth0" snat to 203.0.113.5
```

### Migration Strategy

```bash
# Phase 1: Run nftables in parallel with iptables (coexistence)
# Install nftables but leave iptables active
# nftables rules operate alongside iptables at different hook priorities

# Phase 2: Migrate rules incrementally
# Start with stateless rules, then stateful, then NAT
# Use 'warn' logging with new nftables rules to verify they fire
# before removing iptables equivalents

# Phase 3: Verify and switch
# Disable iptables service and enable nftables exclusively

# Check what's running on the system
iptables -L -n -v | head -20
nft list ruleset

# Check if iptables-legacy or iptables-nft is in use
update-alternatives --display iptables

# On systems with both: switch iptables commands to use nftables backend
# This means iptables commands manipulate nftables tables (for compatibility)
update-alternatives --set iptables /usr/sbin/iptables-nft
update-alternatives --set ip6tables /usr/sbin/ip6tables-nft

# With iptables-nft, Docker and Kubernetes can continue using iptables commands
# while the kernel enforces via nftables
```

## Docker and Kubernetes iptables Interaction

Container orchestration tools heavily use iptables. Managing coexistence is critical.

### Docker's iptables Tables

```bash
# Docker creates chains in these tables:
# nat table:
#   DOCKER chain: port forwarding for published ports
#   DOCKER-INGRESS: swarm ingress DNAT
#   POSTROUTING: masquerade for container traffic

# filter table:
#   DOCKER chain: per-container filtering
#   DOCKER-USER chain: user-defined rules (INSERT HERE — not DOCKER chain)
#   DOCKER-ISOLATION-STAGE-1: cross-bridge isolation
#   DOCKER-ISOLATION-STAGE-2: cross-bridge isolation

# CRITICAL: Add custom firewall rules to DOCKER-USER chain, NOT INPUT or FORWARD
# Docker's FORWARD chain jumps to DOCKER before custom rules otherwise apply

# Allow specific host access to all containers
iptables -I DOCKER-USER -i eth0 -s 10.0.0.0/8 -j ACCEPT

# Block all external access to containers (allow only through published ports)
iptables -I DOCKER-USER -i eth0 -j DROP
# Then add specific allows:
iptables -I DOCKER-USER -i eth0 -s 10.0.0.0/8 -j ACCEPT

# With nftables (using iptables-nft backend):
# The same DOCKER-USER rules work identically
# Docker's iptables calls populate nftables tables transparently

# View the complete nftables picture (shows Docker's tables too)
nft list ruleset | grep -A20 "chain DOCKER"
```

### Kubernetes kube-proxy iptables Mode

```bash
# kube-proxy in iptables mode creates these chains:
# KUBE-SERVICES: jump target for all service traffic
# KUBE-SVC-*: per-service load balancing (random selection)
# KUBE-SEP-*: per-endpoint DNAT rules
# KUBE-NODEPORTS: NodePort service rules
# KUBE-POSTROUTING: masquerade for NodePort and LoadBalancer traffic
# KUBE-MARK-MASQ: mark packets requiring masquerade

# View kube-proxy rules
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -30
iptables -t nat -L KUBE-SVC-ERIFXISMVUID7Y6N -n  # Example service chain

# kube-proxy iptables rule count grows with number of services and endpoints
# 1000 services with 5 endpoints each = ~5000+ iptables rules
# This is the primary reason to consider kube-proxy in ipvs or eBPF (Cilium) mode

# Check kube-proxy mode
kubectl get configmap -n kube-system kube-proxy -o yaml | grep mode

# kube-proxy with nftables backend (Kubernetes 1.31+)
# Configure kube-proxy to use nftables:
kubectl edit configmap -n kube-system kube-proxy
# Set: mode: "nftables"
```

### Kubernetes Network Policy and nftables

```bash
# When using Calico as CNI with nftables:
# Calico uses its own iptables-based policy enforcement
# or eBPF mode (bypasses iptables entirely)

# To prevent conflicts between Calico iptables and custom nftables rules:
# - Add custom rules at priority 0 (default filter)
# - Calico uses priority -200 for its rules
# - Your rules at priority 0 run AFTER Calico's accept/drop decisions

# Example: add logging rules after Calico without interfering
cat >> /etc/nftables/main.nft << 'EOF'
table inet post_calico_logging {
    chain forward_logging {
        type filter hook forward priority 100  # After Calico at -200
        # Log forwarded traffic that Calico allowed
        log prefix "FORWARD-ALLOWED: " flags all limit rate 1/second
    }
}
EOF
```

## nft Scripting and Automation

### Atomic Rule Updates

```bash
#!/bin/bash
# /usr/local/sbin/update-firewall.sh
# Atomically update firewall rules from configuration files

set -euo pipefail

NFTABLES_DIR="/etc/nftables"
MAIN_CONFIG="${NFTABLES_DIR}/main.nft"
BACKUP_DIR="/etc/nftables/backups"

mkdir -p "${BACKUP_DIR}"

# Back up current ruleset
BACKUP_FILE="${BACKUP_DIR}/ruleset-$(date +%Y%m%d-%H%M%S).nft"
nft list ruleset > "${BACKUP_FILE}"
echo "Backup saved to: ${BACKUP_FILE}"

# Validate new configuration
if ! nft -c -f "${MAIN_CONFIG}"; then
    echo "ERROR: Configuration validation failed"
    exit 1
fi

# Apply atomically (single nft call with flush ruleset at top = atomic replacement)
if ! nft -f "${MAIN_CONFIG}"; then
    echo "ERROR: Failed to apply configuration"
    echo "Attempting rollback from backup..."
    nft -f "${BACKUP_FILE}"
    echo "Rollback complete"
    exit 1
fi

echo "Firewall configuration applied successfully"
nft list ruleset | grep -c "rule" | xargs echo "Total rules:"
```

### Dynamic Blocklist Management

```bash
# Add an IP to the blocklist (persists until timeout or manual removal)
# This works even while the firewall is live — nftables sets are atomic
nft add element inet filter blocklist { 203.0.113.100 timeout 4h }

# Add with comment (nftables 0.9.4+)
nft add element inet filter blocklist { 203.0.113.100 timeout 4h comment "scanner" }

# Remove from blocklist
nft delete element inet filter blocklist { 203.0.113.100 }

# List current blocklist entries
nft list set inet filter blocklist

# Flush the entire blocklist
nft flush set inet filter blocklist

# Script: auto-populate blocklist from threat intelligence feed
#!/bin/bash
# /usr/local/sbin/update-blocklist.sh

THREAT_FEED_URL="https://blocklist.internal.example.com/ips.txt"
TEMP_FILE=$(mktemp)
SET_NAME="blocklist"
TABLE="inet filter"

# Download threat intelligence feed
curl -sf "${THREAT_FEED_URL}" > "${TEMP_FILE}" || {
    echo "Failed to download threat feed"
    exit 1
}

# Flush current blocklist
nft flush set ${TABLE} ${SET_NAME}

# Add all IPs from the feed
# Build a single nft command for atomic addition
{
    echo "add element ${TABLE} ${SET_NAME} {"
    awk '!/^#/ && NF { printf "    %s,\n", $1 }' "${TEMP_FILE}"
    echo "}"
} | nft -f -

echo "Blocklist updated: $(nft list set ${TABLE} ${SET_NAME} | grep -c 'type')"
rm -f "${TEMP_FILE}"
```

## Monitoring and Troubleshooting

### nftables Counters and Statistics

```bash
# Enable counters on specific rules for traffic analysis
nft add rule inet filter input \
  counter \
  tcp dport 443 \
  accept

# Show rules with counter values
nft list ruleset | grep -A2 "counter"

# Named counters (available from nftables 0.9.1)
nft add counter inet traffic_stats https_in
nft add rule inet filter input tcp dport 443 counter name https_in accept

# Show named counters
nft list counter inet traffic_stats https_in

# Monitor counters in real-time
watch -n1 'nft list counter inet traffic_stats https_in'

# Trace a specific packet flow for debugging
# IMPORTANT: nft trace generates a LOT of output; use restrictively
nft add rule inet filter input \
  ip saddr 192.168.1.100 \
  tcp dport 80 \
  meta nftrace set 1

# Start trace listener in another terminal
nft monitor trace

# Remove trace rule when done
nft delete rule inet filter input handle <handle-number>
```

### Logging Best Practices

```bash
# nftables log statement syntax
log prefix "PREFIX: " level warn group 0 snaplen 64 flags all

# Log levels: emerg, alert, crit, err, warn, notice, info, debug
# flags: tcp sequence, tcp options, ip options, skuid, ether, all

# Production logging: limit rate to prevent log flooding
log prefix "PORTSCAN: " level warn limit rate 5/minute

# Log to netlink group (for high-performance logging with ulogd2)
log group 1 prefix "DROP: " snaplen 64

# ulogd2 configuration for structured firewall log export to Elasticsearch
# /etc/ulogd.conf
cat > /etc/ulogd.conf << 'EOF'
[global]
logfile="syslog"
loglevel=5

stack=group1:NFLOG,base1:BASE,ifi1:IFINDEX,ip2str1:IP2STR,print1:PRINTPKT,emu1:LOGEMU
stack=group1:NFLOG,base1:BASE,ifi1:IFINDEX,ip2str1:IP2STR,json1:JSON,logfile1:LOGFILE

[group1]
group=1
unbind=false
nlbufsiz=16777216
bufsize=16384
qthresh=20

[json1]
eventmask=0xffffffff

[logfile1]
file="/var/log/ulogd/firewall.log"
sync=1
EOF
```

## Summary

Managing Linux firewalls in 2030 means understanding nftables as the primary framework while maintaining awareness of iptables for legacy container and orchestration tool compatibility:

- **nftables fundamentals**: Tables, chains, and rules with explicit hook and priority declarations give precise control over packet processing order
- **Sets and maps**: Named sets for IP groups, dynamic sets for rate limiting and blocklisting enable rule reuse and atomic updates
- **Stateful tracking**: Connection tracking (ct) state matching is the foundation of modern stateful firewall rules
- **Migration**: `iptables-translate` and `iptables-restore-translate` provide starting points; `iptables-nft` backend enables gradual migration without breaking Docker or Kubernetes
- **Container coexistence**: Use `DOCKER-USER` for Docker rules and understand kube-proxy chain hierarchy to avoid conflicts
- **Operations**: Atomic file-based configuration updates, dynamic set management via `nft` commands, and rate-limited logging provide production-grade operational capability
