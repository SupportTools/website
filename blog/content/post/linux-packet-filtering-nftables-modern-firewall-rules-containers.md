---
title: "Linux Packet Filtering with nftables: Modern Firewall Rules for Containers"
date: 2031-02-04T00:00:00-05:00
draft: false
tags: ["Linux", "nftables", "iptables", "Firewall", "Networking", "Docker", "Kubernetes", "Security"]
categories:
- Linux
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to nftables: tables/chains/rules syntax, set-based matching, stateful connection tracking, Docker and Kubernetes interaction, migration from iptables, and performance comparison."
more_link: "yes"
url: "/linux-packet-filtering-nftables-modern-firewall-rules-containers/"
---

nftables replaces the legacy iptables/ip6tables/arptables/ebtables framework with a unified, efficient subsystem that offers better performance, reduced code duplication, and a far more expressive rule language. As the default packet filter on RHEL 9, Debian 11+, and Ubuntu 22.04+, nftables is now the production-ready choice for enterprise Linux firewall management. This guide covers everything from basic ruleset design to managing the complex interaction between nftables, Docker, and Kubernetes networking.

<!--more-->

# Linux Packet Filtering with nftables: Modern Firewall Rules for Containers

## Section 1: nftables Architecture

nftables introduces a layered structure that differs fundamentally from iptables:

```
┌─────────────────────────────────────────────────────────┐
│                       Table                              │
│  (family: ip, ip6, inet, arp, bridge, netdev)           │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │    Chain     │  │    Chain     │  │    Chain     │    │
│  │ (base/regular│  │  (base/      │  │  (regular)   │    │
│  │  input hook) │  │  forward)    │  │  (called)    │    │
│  │              │  │              │  │              │    │
│  │  Rule        │  │  Rule        │  │  Rule        │    │
│  │  Rule        │  │  Rule        │  │  Rule        │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                         │
│  Sets: { 192.168.1.0/24, 10.0.0.0/8 }                 │
│  Maps: { 80 : "http", 443 : "https" }                  │
└─────────────────────────────────────────────────────────┘
```

### Key Differences from iptables

| Feature | iptables | nftables |
|---|---|---|
| Rule language | Match + target syntax | Expression-based |
| Address families | Separate tools per family | Unified with `inet` table |
| Sets | ipset (separate tool) | Native named sets |
| Atomic rule updates | No (partial) | Yes (`nft -f` atomically) |
| Performance at scale | Degrades with rule count | O(1) with sets |
| Logging | Limited | Rich JSON logging |
| Counter reset | Per-rule only | Per-rule or per-set-element |

## Section 2: Basic nftables Syntax

### Listing Current Ruleset

```bash
# Show current ruleset
nft list ruleset

# Show a specific table
nft list table inet filter

# Show a specific chain
nft list chain inet filter input

# Show all tables
nft list tables

# Check nftables service status
systemctl status nftables
```

### Creating a Basic Ruleset

```bash
# /etc/nftables.conf — base configuration
#!/usr/sbin/nft -f

# Flush existing ruleset before loading
flush ruleset

# Main filter table for IPv4 and IPv6 (inet handles both)
table inet filter {

    # INPUT chain — traffic destined for this host
    chain input {
        type filter hook input priority 0; policy drop;

        # Allow established and related connections
        ct state established,related accept

        # Allow loopback
        iifname "lo" accept

        # Drop invalid packets
        ct state invalid drop

        # Allow ICMP and ICMPv6 (necessary for IPv6 NDP)
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        # SSH — limit to prevent brute force
        tcp dport 22 ct state new limit rate 10/minute accept
        tcp dport 22 drop   # Drop excess SSH connections

        # HTTP and HTTPS
        tcp dport { 80, 443 } accept

        # Allow custom application ports
        tcp dport { 8080, 8443, 9090, 9091 } accept

        # Log and drop everything else
        log prefix "nft-input-drop: " level info
    }

    # FORWARD chain — traffic being routed through this host
    chain forward {
        type filter hook forward priority 0; policy drop;

        ct state established,related accept
        ct state invalid drop
    }

    # OUTPUT chain — traffic originating from this host
    chain output {
        type filter hook output priority 0; policy accept;
    }
}
```

```bash
# Load the configuration
nft -f /etc/nftables.conf

# Test syntax before applying
nft -c -f /etc/nftables.conf   # -c = check only

# Apply and enable at boot
systemctl enable --now nftables
```

## Section 3: Set-Based Matching

Sets are nftables' most powerful performance optimization. Instead of many individual rules, a single rule can match thousands of addresses or ports in O(1) time.

### Anonymous Sets (Inline)

```bash
# Inline anonymous set — the curly braces create an anonymous set
nft add rule inet filter input tcp dport { 80, 443, 8080, 8443 } accept

# IPv4 address set
nft add rule inet filter input ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } accept
```

### Named Sets

```bash
# Define named sets in a table
table inet filter {

    # Simple set of allowed management IPs
    set mgmt_hosts {
        type ipv4_addr
        flags interval
        elements = {
            10.100.0.0/24,     # Management VLAN
            172.20.0.1,        # Jump host
            192.168.100.50     # Monitoring server
        }
    }

    # Dynamic set for rate limiting (auto-expire entries)
    set ssh_bruteforce {
        type ipv4_addr
        flags dynamic, timeout
        timeout 1h
        gc-interval 5m
    }

    # Port set for web traffic
    set web_ports {
        type inet_service
        elements = { 80, 443, 8080, 8443 }
    }

    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept

        # Management access
        ip saddr @mgmt_hosts tcp dport 22 accept

        # Web services
        tcp dport @web_ports accept

        # Block brute force attackers
        ip saddr @ssh_bruteforce drop

        # Add to bruteforce set: 3 connections in 30s triggers block
        tcp dport 22 ct state new \
            add @ssh_bruteforce { ip saddr timeout 1h \
            limit rate over 3/minute } drop

        tcp dport 22 ct state new accept
    }
}
```

### Manipulating Named Sets at Runtime

```bash
# Add elements to a named set
nft add element inet filter mgmt_hosts { 192.168.50.100 }

# Remove elements
nft delete element inet filter mgmt_hosts { 172.20.0.1 }

# Flush an entire set
nft flush set inet filter mgmt_hosts

# List set contents
nft list set inet filter mgmt_hosts
```

### Maps for Dynamic Translation

```bash
table inet nat {

    # Map destination ports to backend services
    map service_targets {
        type inet_service : ipv4_addr . inet_service
        elements = {
            80  : 10.0.0.10 . 8080,
            443 : 10.0.0.10 . 8443,
            3306 : 10.0.0.20 . 3306,
        }
    }

    chain prerouting {
        type nat hook prerouting priority -100;

        # Use the map for DNAT
        dnat to tcp dport map @service_targets
    }
}
```

## Section 4: Stateful Connection Tracking

nftables integrates with the Linux netfilter connection tracking (conntrack) subsystem:

```bash
table inet filter {

    chain input {
        type filter hook input priority 0; policy drop;

        # Connection tracking states:
        # new       - first packet of a new connection
        # established - part of an existing tracked connection
        # related   - related to an established connection (e.g., FTP data)
        # invalid   - does not match any known connection state

        # Early accept for established sessions (performance optimization)
        ct state { established, related } accept comment "Allow tracked connections"

        # Explicitly drop invalid state packets
        ct state invalid drop comment "Drop invalid state"

        # New connections — apply rate limiting and rules
        ct state new jump new_connections

        drop
    }

    chain new_connections {
        # HTTP/HTTPS
        tcp dport { 80, 443 } accept

        # SSH with connection rate limiting
        tcp dport 22 limit rate 15/minute burst 5 packets accept

        # ICMP for health checks
        ip protocol icmp icmp type { echo-request } limit rate 10/second accept
        ip6 nexthdr icmpv6 icmpv6 type {
            echo-request, nd-neighbor-solicit, nd-neighbor-advert,
            nd-router-solicit, nd-router-advert
        } accept

        return
    }
}
```

### Connection Tracking Zones for Overlapping Networks

When managing multiple network namespaces with overlapping IP ranges (common with Kubernetes):

```bash
table netdev raw_traffic {
    chain prerouting {
        type filter hook ingress device "eth0" priority -300;

        # Assign packets from specific VLANs to separate CT zones
        # This prevents CT conflicts with overlapping IP ranges
        ip saddr 10.0.0.0/8 ct zone set 1
    }
}
```

## Section 5: Docker and nftables Interaction

Docker uses iptables by default but can be configured to work with nftables. The critical issue is that Docker's iptables rules and nftables rules both run against the same netfilter hooks, and the interaction can be complex.

### Docker with iptables on an nftables System

Modern Linux distributions use `nftables` as the kernel framework, with `iptables-nft` (iptables implemented on top of nftables) providing compatibility. This means Docker's iptables calls go through nftables:

```bash
# Check which iptables backend is in use
iptables --version
# iptables v1.8.9 (nf_tables)   — nftables backend (good)
# iptables v1.8.9 (legacy)      — legacy backend (conflicts possible)

# Verify Docker is using the nftables-backed iptables
nft list ruleset | grep -A5 "DOCKER"
```

### nftables Rules That Work with Docker

```bash
# /etc/nftables.conf — compatible with Docker iptables-nft

flush ruleset

table ip filter {

    chain INPUT {
        type filter hook input priority 0; policy accept;

        # Allow established and related
        ct state established,related accept
        ct state invalid drop

        # Local loopback
        iifname "lo" accept

        # SSH (apply before Docker rules which may affect INPUT)
        tcp dport 22 accept

        # Docker-managed traffic comes in via the DOCKER-USER chain
        # that Docker creates. We can add rules there too:
    }

    chain FORWARD {
        type filter hook forward priority 0; policy drop;

        ct state established,related accept

        # Docker creates its own FORWARD rules in the DOCKER chain
        # Jump to Docker's chain for container traffic
        # (Docker handles this automatically via iptables-nft)

        # Allow traffic to/from Docker networks
        iifname "docker0" accept
        oifname "docker0" ct state related,established accept
    }

    chain OUTPUT {
        type filter hook output priority 0; policy accept;
    }

    # Docker inserts rules here automatically via iptables-nft
    # Do not manually modify DOCKER or DOCKER-ISOLATION-STAGE-* chains
}

table ip nat {
    chain PREROUTING {
        type nat hook prerouting priority -100; policy accept;
    }

    chain INPUT {
        type nat hook input priority 100; policy accept;
    }

    chain OUTPUT {
        type nat hook output priority -100; policy accept;
    }

    chain POSTROUTING {
        type nat hook postrouting priority 100; policy accept;

        # Docker adds MASQUERADE rules here for containers
        # Example: ip saddr 172.17.0.0/16 ! oifname "docker0" masquerade
    }
}
```

### Adding Custom Rules to the Docker-user Chain

Docker provides `DOCKER-USER` for operator rules that run before Docker's own rules:

```bash
# Add host-level firewall rules that take precedence over Docker
# These run BEFORE Docker's FORWARD rules

# Block container-to-container traffic across different networks
nft add rule ip filter DOCKER-USER \
  iifname "br-*" oifname "br-*" drop

# Rate limit external access to a specific container
nft add rule ip filter DOCKER-USER \
  ip daddr 172.17.0.2 tcp dport 80 \
  limit rate over 1000/second drop

# Block a specific external IP from reaching any container
nft add rule ip filter DOCKER-USER \
  ip saddr 1.2.3.4 drop
```

## Section 6: Kubernetes and nftables

Kubernetes uses kube-proxy with iptables or IPVS mode, plus CNI plugins that add their own rules. Managing nftables on a Kubernetes node requires careful coexistence:

### Node-Level Firewall with Kubernetes

```bash
# /etc/nftables.conf for a Kubernetes worker node
flush ruleset

table inet filter {

    # Set of trusted management IPs
    set mgmt_ips {
        type ipv4_addr
        flags interval
        elements = { 10.100.0.0/24 }
    }

    # Kubernetes pod CIDR ranges
    set k8s_pod_cidrs {
        type ipv4_addr
        flags interval
        elements = {
            10.244.0.0/16,   # Flannel default
            192.168.0.0/16   # Calico default
        }
    }

    # Kubernetes service CIDR
    set k8s_service_cidr {
        type ipv4_addr
        flags interval
        elements = { 10.96.0.0/12 }   # Default cluster service CIDR
    }

    chain input {
        type filter hook input priority 0; policy drop;

        # Established connections
        ct state established,related accept
        ct state invalid drop

        # Loopback required for Kubernetes
        iifname "lo" accept

        # Kubernetes internal network (pods and services)
        ip saddr @k8s_pod_cidrs accept
        ip saddr @k8s_service_cidr accept

        # CNI bridge interface (flannel, calico, cilium)
        iifname { "cni0", "flannel.1", "calico+", "cilium_host" } accept

        # Allow VXLAN for overlay networking
        udp dport 8472 accept    # Flannel VXLAN
        udp dport 4789 accept    # Generic VXLAN

        # Allow Geneve for Calico/Cilium
        udp dport 6081 accept

        # Management access
        ip saddr @mgmt_ips tcp dport 22 accept

        # Kubernetes API server access (from within cluster)
        tcp dport 6443 accept

        # kubelet API (from control plane)
        tcp dport 10250 accept

        # kube-proxy health
        tcp dport 10256 accept

        # NodePort range
        tcp dport 30000-32767 accept
        udp dport 30000-32767 accept

        # ICMP
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        log prefix "nft-k8s-input-drop: " flags all
    }

    chain forward {
        type filter hook forward priority 0; policy accept;

        # Accept forwarded pod-to-pod traffic
        ip saddr @k8s_pod_cidrs accept
        ip daddr @k8s_pod_cidrs accept

        ct state established,related accept
        ct state invalid drop
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}
```

### Cilium eBPF Mode and nftables

When using Cilium in full eBPF mode (`kube-proxy` replacement), Cilium bypasses both iptables and nftables for in-cluster traffic. Node-level nftables rules still apply for host-destined traffic:

```bash
# Cilium in eBPF mode — verify kube-proxy is disabled
kubectl get daemonset kube-proxy -n kube-system 2>/dev/null && \
  echo "kube-proxy is still running" || \
  echo "kube-proxy is not present (eBPF mode)"

# Check Cilium's masquerade handling
cilium status | grep -A5 "Masquerading"

# nftables rules coexist cleanly with Cilium eBPF mode
# Cilium uses BPF maps and hooks at a lower level
nft list ruleset   # Shows only node-level rules, no Cilium entries
```

## Section 7: Migration from iptables to nftables

### Automated Translation Tools

```bash
# Install translation tools
dnf install iptables-nftables-compat   # RHEL/Fedora
apt install iptables-nftables-compat   # Debian/Ubuntu

# Translate iptables rules to nftables syntax
iptables-save | iptables-restore-translate -f

# Example output translation:
# iptables: -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# nftables:  ct state established,related accept

# Translate ip6tables rules
ip6tables-save | ip6tables-restore-translate -f

# Save to nftables configuration
iptables-save | iptables-restore-translate -f > /tmp/nftables-from-iptables.conf

# Review the translated output before applying
cat /tmp/nftables-from-iptables.conf
```

### Manual Migration of Common Rules

```bash
# iptables equivalents in nftables

# BEFORE (iptables)
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# AFTER (nftables)
nft add rule inet filter input ct state established,related accept

# BEFORE
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
# AFTER
nft add rule inet filter input tcp dport 22 accept

# BEFORE
iptables -A INPUT -s 192.168.1.0/24 -j ACCEPT
# AFTER
nft add rule inet filter input ip saddr 192.168.1.0/24 accept

# BEFORE (multiple ports with multiport)
iptables -A INPUT -p tcp -m multiport --dports 80,443,8080 -j ACCEPT
# AFTER (nftables native set syntax)
nft add rule inet filter input tcp dport { 80, 443, 8080 } accept

# BEFORE (rate limiting)
iptables -A INPUT -p tcp --dport 22 -m limit --limit 3/min -j ACCEPT
# AFTER
nft add rule inet filter input tcp dport 22 limit rate 3/minute accept

# BEFORE (logging)
iptables -A INPUT -j LOG --log-prefix "INPUT-DROP: "
# AFTER
nft add rule inet filter input log prefix "nft-input-drop: " level info

# BEFORE (NAT masquerade)
iptables -t nat -A POSTROUTING -s 10.0.0.0/8 -o eth0 -j MASQUERADE
# AFTER
nft add rule ip nat postrouting ip saddr 10.0.0.0/8 oifname "eth0" masquerade

# BEFORE (DNAT)
iptables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 192.168.1.10:8080
# AFTER
nft add rule ip nat prerouting tcp dport 80 dnat to 192.168.1.10:8080
```

### Migration Script

```bash
#!/bin/bash
# migrate-iptables-to-nftables.sh
# Safely migrate from iptables to nftables

set -euo pipefail

BACKUP_DIR="/etc/firewall-backup-$(date +%Y%m%d%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Step 1: Backing up current iptables rules..."
iptables-save > "$BACKUP_DIR/iptables.rules"
ip6tables-save > "$BACKUP_DIR/ip6tables.rules"
echo "Backup saved to: $BACKUP_DIR"

echo "Step 2: Translating to nftables format..."
iptables-save | iptables-restore-translate -f > "$BACKUP_DIR/nftables-translated.conf"

echo "Step 3: Validating translated ruleset..."
nft -c -f "$BACKUP_DIR/nftables-translated.conf" && \
  echo "Syntax validation passed" || \
  { echo "VALIDATION FAILED"; exit 1; }

echo "Step 4: Creating nftables configuration..."
cat > /etc/nftables.conf <<'NFTEOF'
#!/usr/sbin/nft -f
# Migrated from iptables on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Original rules backed up to: BACKUP_DIR_PLACEHOLDER

NFTEOF
cat "$BACKUP_DIR/nftables-translated.conf" >> /etc/nftables.conf

echo "Step 5: Test loading new configuration..."
nft -c -f /etc/nftables.conf && echo "Test load passed"

echo ""
echo "Migration prepared. To apply:"
echo "  systemctl stop iptables ip6tables"
echo "  systemctl disable iptables ip6tables"
echo "  systemctl enable --now nftables"
echo ""
echo "To rollback:"
echo "  systemctl stop nftables"
echo "  iptables-restore < $BACKUP_DIR/iptables.rules"
```

## Section 8: Performance Comparison

### Benchmarking Rule Lookup Performance

```bash
# Generate a large iptables ruleset for comparison
for i in $(seq 1 10000); do
    iptables -A INPUT -s 10.${i%256}.${i}.1 -j ACCEPT
done

# Benchmark with a packet trace
nstat -z | grep IpInReceives   # Baseline

# Time a simple HTTP request under each firewall
time curl -s http://test-server/ > /dev/null

# iptables: degrades linearly with rule count
# nftables: O(1) lookup with sets

# Equivalent nftables set (all 10000 IPs in one set)
nft add table inet bench
nft add chain inet bench input \
  "{ type filter hook input priority 0; policy accept; }"

# Load IPs into a set
nft add set inet bench allowed_ips { type ipv4_addr\; flags interval\; }
for i in $(seq 1 10000); do
    echo "10.${i%256}.${i}.1,"
done | tr -d '\n' | \
nft add element inet bench allowed_ips "{ $(cat /dev/stdin) }"

# Single rule against the set — O(log n) or O(1) depending on set type
nft add rule inet bench input ip saddr @allowed_ips accept
```

### nftables Performance Tuning

```bash
# Use the nf_conntrack_max sysctl to scale conntrack table
# Default is typically 65536 — increase for high-connection servers
echo "131072" > /proc/sys/net/netfilter/nf_conntrack_max

# Persist in sysctl
cat >> /etc/sysctl.d/90-nftables.conf <<EOF
net.netfilter.nf_conntrack_max = 131072
net.netfilter.nf_conntrack_tcp_timeout_established = 600
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 15
net.netfilter.nf_conntrack_udp_timeout = 30
net.core.netdev_max_backlog = 65536
net.ipv4.tcp_max_syn_backlog = 16384
EOF

sysctl --system
```

## Section 9: Advanced nftables Features

### Verdict Maps (Routing Decisions)

```bash
table inet filter {

    # Map source IP ranges to verdict (accept/drop/jump chain)
    map source_policy {
        type ipv4_addr : verdict
        flags interval
        elements = {
            10.0.0.0/8      : accept,        # Internal networks
            172.16.0.0/12   : accept,        # Private RFC1918
            192.168.0.0/16  : accept,        # Private RFC1918
            1.1.1.1         : jump trusted,  # Jump to special chain
            0.0.0.0/0       : jump external, # Everything else
        }
    }

    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept
        ip saddr vmap @source_policy
    }

    chain trusted {
        tcp dport { 22, 80, 443, 8080, 9090 } accept
        return
    }

    chain external {
        tcp dport { 80, 443 } accept
        tcp dport 22 limit rate 5/minute accept
        return
    }
}
```

### Flowtables for Fast Path Forwarding

Flowtables bypass the normal netfilter processing path for established connections, dramatically improving forwarding performance:

```bash
table inet filter {

    # Flowtable definition — hardware offload if NIC supports it
    flowtable ft {
        hook ingress priority 0;
        devices = { eth0, eth1 };
    }

    chain forward {
        type filter hook forward priority 0; policy drop;

        # Offload established connections to the flowtable fast path
        ip protocol { tcp, udp } flow add @ft

        ct state established,related accept
        ct state new accept
    }
}
```

### Secmark for SELinux Integration

```bash
table inet security {
    chain input {
        type filter hook input priority 50; policy accept;

        # Apply SELinux security marks to incoming packets
        tcp dport 80 meta secmark set "system_u:object_r:http_port_t:s0"
        tcp dport 443 meta secmark set "system_u:object_r:http_port_t:s0"
    }
}
```

## Section 10: Monitoring and Logging

### Rich Rule Logging

```bash
table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept

        # Log new SSH connections (useful for audit trails)
        tcp dport 22 ct state new log prefix "ssh-new-conn: " level info \
          flags all accept

        # Log and count dropped packets
        counter drop log prefix "nft-input-drop: " level info
    }
}
```

### Counters for Traffic Monitoring

```bash
table inet filter {

    # Named counters (persist between rule reloads)
    counter http_requests {}
    counter https_requests {}
    counter dropped_packets {}

    chain input {
        type filter hook input priority 0; policy drop;

        tcp dport 80 counter name http_requests accept
        tcp dport 443 counter name https_requests accept

        counter name dropped_packets drop
    }
}

# Query counter values
nft list counter inet filter http_requests
# table inet filter {
#     counter http_requests {
#         packets 45281 bytes 2714860
#     }
# }

# Reset counters
nft reset counters inet filter

# Export counters via a monitoring script
nft -j list ruleset | \
  jq '.nftables[] | select(.counter) | .counter | {name, packets, bytes}'
```

### Prometheus Integration via nft-exporter

```bash
#!/usr/bin/env python3
# nft-exporter.py — expose nftables counters as Prometheus metrics
import subprocess
import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

def get_nft_counters():
    result = subprocess.run(
        ['nft', '-j', 'list', 'ruleset'],
        capture_output=True, text=True
    )
    data = json.loads(result.stdout)

    metrics = []
    for item in data.get('nftables', []):
        if 'counter' in item:
            c = item['counter']
            family = c.get('family', 'inet')
            table = c.get('table', 'filter')
            name = c['name']
            packets = c.get('packets', 0)
            bytess = c.get('bytes', 0)

            metrics.append(
                f'nftables_counter_packets_total{{family="{family}",'
                f'table="{table}",name="{name}"}} {packets}'
            )
            metrics.append(
                f'nftables_counter_bytes_total{{family="{family}",'
                f'table="{table}",name="{name}"}} {bytess}'
            )

    return '\n'.join(metrics)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/metrics':
            metrics = get_nft_counters()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; version=0.0.4')
            self.end_headers()
            self.wfile.write(metrics.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress access log

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9998
    server = HTTPServer(('0.0.0.0', port), Handler)
    print(f"nft-exporter listening on :{port}")
    server.serve_forever()
```

## Section 11: Troubleshooting nftables

### Tracing Packet Flow

```bash
# Enable packet tracing for debugging
# WARNING: Very verbose — use for short periods only

# Add a trace rule (must be in a chain with type=filter)
nft add rule inet filter input \
  ip saddr 1.2.3.4 tcp dport 80 meta nftrace set 1

# Monitor trace output
nft monitor trace

# Example trace output:
# trace id 3c3d0c9b inet filter input packet:
#   iifname "eth0" ip saddr 1.2.3.4 ip daddr 10.0.0.1 ip protocol tcp
#   tcp sport 54321 tcp dport 80 tcp flags == syn
# trace id 3c3d0c9b inet filter input rule
#   ip saddr 1.2.3.4 tcp dport 80 meta nftrace set 1 (verdict continue)
# trace id 3c3d0c9b inet filter input rule
#   tcp dport { 80, 443 } accept (verdict accept)
```

### Common Issues

```bash
# Issue: Docker rules disappear after reloading nftables
# Cause: flush ruleset clears Docker's rules
# Fix: Don't flush Docker-managed chains, or use incremental updates

# Wrong:
# flush ruleset
# apply custom rules

# Right: Only manage your own tables/chains
nft delete table inet my_filter 2>/dev/null || true
nft -f /etc/nftables-custom.conf

# Issue: Port forwarding not working with nftables
# Verify ip_forward is enabled
sysctl net.ipv4.ip_forward   # Should be 1
cat /proc/sys/net/ipv4/ip_forward

# Enable if needed
echo 1 > /proc/sys/net/ipv4/ip_forward
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-forwarding.conf

# Issue: Connection tracking table overflow
dmesg | grep "nf_conntrack: table full"
sysctl net.netfilter.nf_conntrack_count   # Current count
sysctl net.netfilter.nf_conntrack_max     # Maximum allowed

# Issue: Rules loaded but packets still being dropped
# Check if nftables policy is actually drop
nft list chain inet filter input | head -5
# Should show: policy drop;

# Check for competing chains
nft list ruleset | grep -A3 "hook input"
# Multiple chains on the same hook can interact unexpectedly
```

nftables provides a significantly cleaner, more performant, and more expressive firewall framework than iptables. The key to managing it successfully in containerized environments is understanding the hook priority system, using named sets for scalable matching, and carefully managing coexistence with Docker and Kubernetes networking components.
