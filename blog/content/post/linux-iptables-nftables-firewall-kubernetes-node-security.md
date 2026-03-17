---
title: "Linux iptables and nftables: Firewall Rules for Kubernetes Node Security"
date: 2029-03-09T00:00:00-05:00
draft: false
tags: ["Linux", "iptables", "nftables", "Kubernetes", "Security", "Networking"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to iptables and nftables firewall configuration for Kubernetes nodes, covering the interaction between kube-proxy and netfilter, node-level hardening rules, and migration from iptables to nftables."
more_link: "yes"
url: "/linux-iptables-nftables-firewall-kubernetes-node-security/"
---

Kubernetes nodes run a complex netfilter ruleset managed by kube-proxy, with tens of thousands of rules in large clusters. Overlaying custom iptables or nftables rules without understanding the interaction model leads to connectivity failures, security holes, and rules that silently no-op after kube-proxy rewrites its chains. This post covers the iptables/nftables data plane as it exists on a Kubernetes node: the chains kube-proxy owns, the chains operators can safely extend, and how to implement node-level firewall policies that survive kube-proxy reconciliation.

<!--more-->

## iptables Architecture on Kubernetes Nodes

### Table and Chain Hierarchy

Linux netfilter processes packets through five tables, each containing standard and user-defined chains:

```
Packet IN
    │
    ▼
[raw] PREROUTING ──► [mangle] PREROUTING ──► [nat] PREROUTING ──► routing
                                                                      │
                                                          LOCAL ──────┤
                                                                      │
                                                           FWD ───────┼──► [filter] FORWARD ──► [mangle] POSTROUTING ──► [nat] POSTROUTING ──► OUT
                                                                      │
                                                                 [mangle] INPUT ──► [filter] INPUT ──► LOCAL PROCESS
```

### kube-proxy's iptables Chains

kube-proxy creates and manages the following chains. Never insert rules into or modify these chains:

```bash
# kube-proxy-managed chains (do not touch)
# nat table:
# KUBE-SERVICES          — entry point for all Service traffic
# KUBE-NODEPORTS         — NodePort handling
# KUBE-POSTROUTING       — MASQUERADE for pods leaving the cluster
# KUBE-SVC-*             — per-Service load balancing
# KUBE-SEP-*             — per-endpoint (Service Endpoint) rules
# KUBE-MARK-MASQ         — marks packets for MASQUERADE

# filter table:
# KUBE-FORWARD           — allows forwarding for established connections
# KUBE-EXTERNAL-SERVICES — blocks external access to unready services
# KUBE-IPVS-IPS          — (when using IPVS mode)

# Observe the current kube-proxy rules
iptables -t nat -L KUBE-SERVICES --line-numbers | head -30
iptables -t filter -L KUBE-FORWARD --line-numbers
```

### Safe Insertion Points for Custom Rules

Custom rules must be inserted in ways that survive `iptables-restore` calls made by kube-proxy during periodic reconciliation:

```
filter table:
  INPUT chain:  Safe for node-level ingress rules
  FORWARD chain: Safe for inter-pod and cluster-egress policies
  OUTPUT chain:  Safe for node-process egress rules

nat table:
  PREROUTING:  Avoid — conflicts with KUBE-SERVICES
  POSTROUTING: Append after KUBE-POSTROUTING only
```

## Node Hardening with iptables

### Baseline INPUT Chain Policy

```bash
#!/bin/bash
# node-firewall-setup.sh — establish baseline INPUT rules for a Kubernetes worker node
set -euo pipefail

# Kubernetes API server endpoint (update for your environment)
API_SERVER_CIDR="10.0.0.10/32"   # Single master or load balancer IP
CLUSTER_CIDR="10.244.0.0/16"     # Pod CIDR (from kubeadm config)
SERVICE_CIDR="10.96.0.0/12"      # Service CIDR (from kubeadm config)
NODE_CIDR="10.0.0.0/24"          # Node subnet
MANAGEMENT_CIDR="10.0.1.0/24"    # Operations/management subnet

# Flush custom chains (not kube-proxy chains)
iptables -F NODE-INPUT 2>/dev/null || true
iptables -X NODE-INPUT 2>/dev/null || true

# Create custom chain for node input rules
iptables -N NODE-INPUT

# Jump to our chain from INPUT before the default ACCEPT
iptables -I INPUT 1 -j NODE-INPUT

# Allow established/related connections (stateful)
iptables -A NODE-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow loopback
iptables -A NODE-INPUT -i lo -j ACCEPT

# Allow ICMP (ping, traceroute, MTU path discovery)
iptables -A NODE-INPUT -p icmp --icmp-type echo-request -m limit --limit 10/s -j ACCEPT
iptables -A NODE-INPUT -p icmp --icmp-type echo-reply -j ACCEPT
iptables -A NODE-INPUT -p icmp --icmp-type destination-unreachable -j ACCEPT
iptables -A NODE-INPUT -p icmp --icmp-type time-exceeded -j ACCEPT

# Allow SSH from management CIDR only
iptables -A NODE-INPUT -p tcp --dport 22 -s "${MANAGEMENT_CIDR}" -j ACCEPT

# Allow Kubernetes node communications
iptables -A NODE-INPUT -s "${NODE_CIDR}" -j ACCEPT
iptables -A NODE-INPUT -s "${CLUSTER_CIDR}" -j ACCEPT
iptables -A NODE-INPUT -s "${SERVICE_CIDR}" -j ACCEPT

# Allow kubelet API port (used by metrics-server, kubectl exec, etc.)
iptables -A NODE-INPUT -p tcp --dport 10250 -s "${API_SERVER_CIDR}" -j ACCEPT
iptables -A NODE-INPUT -p tcp --dport 10250 -s "${NODE_CIDR}" -j ACCEPT

# Allow NodePort range for external LoadBalancer health checks
iptables -A NODE-INPUT -p tcp --dport 30000:32767 -j ACCEPT
iptables -A NODE-INPUT -p udp --dport 30000:32767 -j ACCEPT

# Allow etcd (control plane nodes only — remove from worker nodes)
# iptables -A NODE-INPUT -p tcp --dport 2379:2380 -s "${NODE_CIDR}" -j ACCEPT

# Log and drop everything else (rate-limited to avoid log flooding)
iptables -A NODE-INPUT -m limit --limit 5/min --limit-burst 10 \
  -j LOG --log-prefix "[IPTABLES-DROP] " --log-level 7

iptables -A NODE-INPUT -j DROP

echo "Node INPUT rules configured"
iptables -L NODE-INPUT -v --line-numbers
```

### Persistent Rule Storage

```bash
# Save rules to survive reboot
iptables-save > /etc/iptables/rules.v4
ip6tables-save > /etc/iptables/rules.v6

# Install iptables-persistent to restore on boot
apt-get install -y iptables-persistent

# Verify rules restore correctly after reboot simulation
iptables-restore --test /etc/iptables/rules.v4 && echo "Rules valid"
```

## nftables: The Modern Alternative

nftables replaces iptables with a cleaner, more performant implementation. Kubernetes clusters on RHEL 9+, Ubuntu 22.04+, and modern distributions use nftables by default, with iptables as a compatibility shim (iptables-nft).

### nftables Table Structure

```
# nftables uses tables > chains > rules
# Tables are associated with address families: ip, ip6, inet (both), arp, bridge, netdev
table inet <name> {
    chain <name> {
        type <filter|nat|route> hook <input|output|forward|prerouting|postrouting> priority <value>
        policy <accept|drop>
        <rules>
    }
}
```

### Complete nftables Node Security Ruleset

```nft
#!/usr/sbin/nft -f
# /etc/nftables-node.conf
# Node-level security rules for Kubernetes worker nodes.
# Load with: nft -f /etc/nftables-node.conf

# Flush existing node ruleset if present
table inet node-security
delete table inet node-security

table inet node-security {
    # Define named sets for IP ranges
    set management_hosts {
        type ipv4_addr
        flags interval
        elements = { 10.0.1.0/24, 192.168.10.0/24 }
    }

    set node_subnet {
        type ipv4_addr
        flags interval
        elements = { 10.0.0.0/24 }
    }

    set cluster_cidrs {
        type ipv4_addr
        flags interval
        elements = {
            10.244.0.0/16,   # Pod CIDR
            10.96.0.0/12     # Service CIDR
        }
    }

    set blocked_countries {
        type ipv4_addr
        flags interval, timeout
        # Populated dynamically from threat intelligence feeds
    }

    chain input {
        type filter hook input priority filter; policy drop

        # Conntrack: allow established/related
        ct state established,related accept
        ct state invalid drop

        # Loopback
        iifname "lo" accept

        # ICMP rate-limited
        ip protocol icmp icmp type { echo-request } limit rate 10/second accept
        ip protocol icmp icmp type { echo-reply, destination-unreachable, time-exceeded, parameter-problem } accept

        # SSH from management hosts only
        tcp dport 22 ip saddr @management_hosts accept
        tcp dport 22 log prefix "[NFT-SSH-DENY] " drop

        # Kubernetes node ports
        ip saddr @node_subnet accept
        ip saddr @cluster_cidrs accept

        # Kubelet API (authenticated via certificates)
        tcp dport 10250 ip saddr @node_subnet accept
        tcp dport 10250 ip saddr { 10.0.0.10/32 } accept

        # NodePort range (all sources — exposed via LoadBalancer)
        tcp dport 30000-32767 accept
        udp dport 30000-32767 accept

        # Drop packets from known bad IPs
        ip saddr @blocked_countries drop

        # Log and drop everything else
        limit rate 5/minute log prefix "[NFT-DROP] " level info
        drop
    }

    chain forward {
        type filter hook forward priority filter; policy accept
        # kube-proxy manages forward rules; just ensure no accidental drops
        # Add explicit pod-to-pod policies here if using a non-CNI firewall
    }

    chain output {
        type filter hook output priority filter; policy accept
        # Prevent node from initiating connections to known-malicious IPs
        ip daddr @blocked_countries reject with icmp type admin-prohibited
    }
}
```

### Loading nftables Rules

```bash
# Validate syntax
nft -c -f /etc/nftables-node.conf && echo "Syntax OK"

# Load rules atomically
nft -f /etc/nftables-node.conf

# Verify rules are active
nft list table inet node-security

# List all chains
nft list chains

# Show ruleset for debugging
nft list ruleset

# Make persistent (systemd nftables service)
cp /etc/nftables-node.conf /etc/nftables.d/node-security.nft

cat >> /etc/nftables.conf << 'EOF'
include "/etc/nftables.d/*.nft"
EOF

systemctl enable nftables
systemctl restart nftables
```

## Coexistence: iptables-nft and Kubernetes

Kubernetes (kube-proxy, Cilium, Calico) writes iptables rules. On systems where iptables is actually iptables-nft (using nftables as backend), the rules coexist in the `ip/iptables` and `ip/ip6tables` nftables tables:

```bash
# Check which iptables backend is in use
iptables --version
# iptables v1.8.9 (nf_tables)  ← nftables backend
# iptables v1.8.9 (legacy)     ← classic iptables backend

# When using iptables-nft, kube-proxy rules appear as:
nft list table ip filter
nft list table ip nat

# Custom nftables rules in a separate table do NOT conflict with these
# They are evaluated in priority order: lower priority numbers run first
```

### Priority Ordering Reference

```
netdev: -500 (raw packet processing, XDP)
mangle prerouting: -150
nat prerouting: -100
filter forward: 0 (kube-proxy uses priority 0 + 1)
filter input: 0
filter output: 0
nat postrouting: 100
mangle postrouting: 150
```

When adding custom nftables chains, use priority values that do not conflict with kube-proxy:

```nft
chain custom-input {
    type filter hook input priority filter + 10;  # Run after kube-proxy's filter chains
    policy accept
    # rules...
}
```

## Monitoring and Alerting

### Prometheus Metrics for netfilter

```yaml
# node-exporter textfile metrics for iptables
# /usr/local/bin/collect-iptables-metrics.sh
#!/bin/bash
METRICS_FILE="/var/lib/node_exporter/textfile_collector/iptables.prom"

cat > "${METRICS_FILE}" << EOF
# HELP node_iptables_rule_count Number of iptables rules in each chain
# TYPE node_iptables_rule_count gauge
EOF

for table in filter nat mangle; do
    iptables -t "${table}" -L --line-numbers 2>/dev/null | \
    awk -v table="${table}" '
        /^Chain / {
            chain=$2
            count=0
        }
        /^[0-9]/ {
            count++
        }
        /^$/ && chain != "" {
            printf "node_iptables_rule_count{table=\"%s\",chain=\"%s\"} %d\n", table, chain, count
        }
    ' >> "${METRICS_FILE}"
done

# Count dropped packets from NODE-INPUT log entries (last 60s)
DROP_COUNT=$(journalctl -k --since="60 seconds ago" 2>/dev/null | \
    grep -c "\[IPTABLES-DROP\]" || echo 0)
echo "node_iptables_drops_total ${DROP_COUNT}" >> "${METRICS_FILE}"
```

```yaml
# Prometheus alert for unexpected drop rate
groups:
  - name: node-firewall
    rules:
      - alert: NodeFirewallHighDropRate
        expr: |
          rate(node_iptables_drops_total[5m]) > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High firewall drop rate on {{ $labels.instance }}"
          description: "Node {{ $labels.instance }} is dropping more than 100 packets/second. May indicate a scan or misconfiguration."
```

## Auditing kube-proxy Rules

```bash
#!/bin/bash
# audit-kube-proxy-rules.sh — count and summarize kube-proxy iptables rules
set -euo pipefail

echo "=== NAT Table Rules by Category ==="
echo "Total NAT rules: $(iptables -t nat -L | grep -c '^-A\|^ [0-9]' || iptables -t nat -L | wc -l)"
echo ""
echo "KUBE-SVC chains (one per Service):"
iptables -t nat -L | grep "^Chain KUBE-SVC" | wc -l

echo ""
echo "KUBE-SEP chains (one per Endpoint):"
iptables -t nat -L | grep "^Chain KUBE-SEP" | wc -l

echo ""
echo "=== Filter Table ==="
echo "KUBE-FORWARD rules:"
iptables -t filter -L KUBE-FORWARD -v --line-numbers

echo ""
echo "=== Rule Count Growth ==="
echo "If KUBE-SVC chain count > 1000, consider switching to IPVS mode"
echo "Services: $(kubectl get svc --all-namespaces --no-headers | wc -l)"
echo "Endpoints: $(kubectl get endpoints --all-namespaces --no-headers | wc -l)"
```

## Summary

Kubernetes nodes operate with a complex, dynamically-maintained netfilter ruleset. The safe approach for node hardening is:

- **Create custom chains** (`NODE-INPUT`) that kube-proxy does not touch
- **Insert rules by chain name**, not position, to survive kube-proxy's `iptables-restore` operations
- **Use nftables named tables** (`inet node-security`) which are completely separate from the iptables namespace kube-proxy writes to
- **Never write to `KUBE-*` chains** — kube-proxy overwrites them during every resync (default every 30 seconds in iptables mode)
- **Persist rules** via `iptables-persistent` or the systemd `nftables` service to survive node reboots
- **Monitor drop counts** via node-exporter textfile metrics to detect configuration drift or active scanning
