---
title: "Linux nftables Firewall: Stateful Filtering, NAT, Set-Based Rules, and Migrating from iptables"
date: 2031-11-03T00:00:00-05:00
draft: false
tags: ["Linux", "nftables", "Firewall", "Networking", "iptables", "NAT", "Security", "Kernel"]
categories:
- Linux
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux nftables: building production firewall rulesets with stateful connection tracking, implementing SNAT/DNAT, leveraging sets and maps for efficient rule evaluation, and migrating from iptables to nftables with zero downtime."
more_link: "yes"
url: "/linux-nftables-stateful-filtering-nat-sets-iptables-migration/"
---

nftables replaces iptables, ip6tables, arptables, and ebtables with a unified framework that offers better performance through kernel-level set operations, atomic ruleset replacement, and a more consistent syntax. This guide covers production nftables deployments from basic stateful firewalls through complex NAT configurations and the iptables migration process.

<!--more-->

# Linux nftables: Production Firewall Configuration

## Why nftables Over iptables

iptables has well-known limitations that nftables addresses:

- **No atomic updates**: iptables rules are applied one-by-one; a crash mid-update leaves partial state
- **Duplicate evaluation**: IPv4 and IPv6 require separate rule sets with duplicated logic
- **No native sets**: IP ranges and address lists require individual rules
- **Table locking**: iptables uses a single kernel lock, causing contention
- **No maps**: Cannot efficiently map IP addresses to actions

nftables provides:
- **Atomic ruleset replacement**: Entire ruleset swapped atomically with `nft -f`
- **Unified framework**: Single binary handles IPv4, IPv6, ARP, and bridge filtering
- **Native sets**: Hash sets and interval sets for O(1) IP lookups regardless of list size
- **Maps**: Verdict maps that dispatch to different chains based on input
- **Concatenations**: Multi-dimensional set lookups

## Installation and Basics

```bash
# Install nftables
dnf install -y nftables        # RHEL/Rocky
apt-get install -y nftables    # Ubuntu/Debian

# Enable and start
systemctl enable --now nftables

# Check kernel version (nftables requires 3.13+, full features need 4.x+)
uname -r

# Verify nftables is available
nft --version

# Flush all existing rules (dangerous on production!)
# nft flush ruleset

# List current ruleset
nft list ruleset
```

## nftables Concepts

### Tables, Chains, and Rules

```
Table (inet/ip/ip6/arp/bridge/netdev)
  └── Chain (input/output/forward/prerouting/postrouting)
        └── Rule (match expressions + verdict)
```

- **Tables**: Group chains. The `inet` family handles both IPv4 and IPv6 in one table.
- **Chains**: Similar to iptables chains but must be explicitly created
- **Base chains**: Attached to Netfilter hooks with a priority
- **Regular chains**: Called via `jump`/`goto` from base chains

### Hook Priorities

```
-300: NF_IP_PRI_CONNTRACK_DEFRAG
-200: NF_IP_PRI_CONNTRACK (connection tracking setup)
-150: NF_IP_PRI_MANGLE
-100: NF_IP_PRI_NAT_DST (DNAT - prerouting)
 0:   NF_IP_PRI_FILTER
 50:  NF_IP_PRI_SECURITY
 100: NF_IP_PRI_NAT_SRC (SNAT - postrouting)
 200: NF_IP_PRI_CONNTRACK_HELPER
 300: NF_IP_PRI_CONNTRACK_CONFIRM
```

## Basic Stateful Firewall

### Minimal Secure Server Ruleset

```bash
# /etc/nftables.conf - minimal secure server
# Allows: SSH, established connections
# Blocks: everything else by default

flush ruleset

table inet firewall {
    # Set of allowed management IPs
    set mgmt_ips {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,
            172.16.0.0/12,
            192.168.0.0/16
        }
    }

    # Counter for blocked traffic (for monitoring)
    counter blocked_in {}
    counter blocked_out {}

    chain input {
        type filter hook input priority filter; policy drop;

        # Loopback interface - always allow
        iif lo accept

        # Connection tracking - allow established/related
        ct state established,related accept

        # Drop invalid packets
        ct state invalid counter drop

        # ICMPv4 - allow specific types
        icmp type {
            echo-reply,       # ping replies
            echo-request,     # ping requests (rate limited)
            destination-unreachable,
            time-exceeded,
            parameter-problem
        } accept

        # ICMPv6 - required for IPv6 operation
        ip6 nexthdr icmpv6 icmpv6 type {
            destination-unreachable,
            packet-too-big,
            time-exceeded,
            parameter-problem,
            nd-router-solicit,
            nd-router-advert,
            nd-neighbor-solicit,
            nd-neighbor-advert,
            mld-listener-query,
            mld-listener-report
        } accept

        # Rate limit ping to prevent floods
        ip protocol icmp icmp type echo-request \
            limit rate 10/second burst 30 packets accept
        ip protocol icmp icmp type echo-request drop

        # SSH - restrict to management networks
        tcp dport 22 ip saddr @mgmt_ips accept

        # HTTP and HTTPS - public
        tcp dport { 80, 443 } accept

        # UDP for QUIC/HTTP3
        udp dport 443 accept

        # Log and count dropped packets
        counter name blocked_in
        limit rate 5/minute log prefix "nftables-dropped-in: " level warn
        drop
    }

    chain output {
        type filter hook output priority filter; policy accept;

        # Drop invalid outbound
        ct state invalid counter drop

        # Allow established outbound
        ct state established,related accept
    }

    chain forward {
        type filter hook forward priority filter; policy drop;

        # For a router/gateway, add forward rules here
        # This server is not a router by default
    }
}
```

Apply the ruleset:

```bash
# Test syntax without applying
nft -c -f /etc/nftables.conf

# Apply atomically
nft -f /etc/nftables.conf

# Verify
nft list ruleset
```

## Stateful Connection Tracking

### Connection States

```bash
# nftables connection states:
# new          - new connection (SYN received)
# established  - part of an established connection
# related      - related to an established connection (FTP data, ICMP errors)
# invalid      - not a valid connection
# untracked    - explicitly untracked traffic

# Example: allow new connections only from specific subnet
chain input {
    type filter hook input priority filter; policy drop;

    ct state established,related accept
    ct state invalid drop

    # Only allow new SSH connections from management IPs
    tcp dport 22 ct state new ip saddr 10.0.0.0/8 accept
}
```

### Custom Connection Tracking Timeouts

```bash
# Reduce timeouts for specific protocols to free conntrack table entries
# /etc/nftables.conf

table inet custom_timeouts {
    ct timeout tcp_fast {
        protocol tcp;
        l3proto ip;
        policy = {
            established: 600,   # Reduce from 5 days to 10 minutes
            time_wait: 60,
            close_wait: 60,
            syn_sent: 30,
            syn_recv: 30,
            fin_wait: 120,
            close: 10
        }
    }

    chain prerouting {
        type filter hook prerouting priority -150; policy accept;
        # Apply custom timeouts to internal service connections
        ip daddr 10.0.0.0/8 tcp ct timeout set "tcp_fast"
    }
}
```

## NAT Configuration

### SNAT (Source NAT / Masquerade)

```bash
# Basic masquerade for internet-facing traffic
table ip nat {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # Masquerade all traffic going out eth0
        oif eth0 masquerade

        # Or: SNAT to a specific IP (more efficient than masquerade)
        # masquerade dynamically picks the outgoing IP
        # snat uses a fixed IP, which is faster
        oif eth0 snat to 203.0.113.10
    }
}
```

### DNAT (Destination NAT / Port Forwarding)

```bash
table ip nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # Forward port 80 to internal web server
        iif eth0 tcp dport 80 dnat to 10.0.1.10:80

        # Port range forwarding
        iif eth0 tcp dport 8000-8099 dnat to 10.0.1.20

        # Load balance across multiple backends
        iif eth0 tcp dport 443 \
            dnat to numgen inc mod 3 map {
                0 : 10.0.1.10,
                1 : 10.0.1.11,
                2 : 10.0.1.12
            }
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        masquerade
    }
}
```

### Stateless NAT

```bash
# For high-performance scenarios, use stateless NAT
# Requires manual reverse rules
table ip stateless_nat {
    chain prerouting {
        type filter hook prerouting priority -400; policy accept;

        # Stateless DNAT: rewrite destination immediately
        ip daddr 203.0.113.10 ip daddr set 10.0.1.10 notrack
    }

    chain postrouting {
        type filter hook postrouting priority -400; policy accept;

        # Stateless SNAT: rewrite source for return traffic
        ip saddr 10.0.1.10 ip saddr set 203.0.113.10 notrack
    }
}
```

## Set-Based Rules for Performance

### Named Sets

```bash
table inet advanced_filtering {
    # IPv4 blocked IP list
    set blocklist_v4 {
        type ipv4_addr
        flags interval, timeout
        timeout 1d           # Automatic expiry
        size 65536           # Maximum elements
        gc-interval 1h       # Garbage collection interval
    }

    # IPv6 blocked IP list
    set blocklist_v6 {
        type ipv6_addr
        flags interval, timeout
        timeout 1d
        size 65536
    }

    # Allowed source IPs for admin endpoints
    set admin_sources {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,
            172.31.0.0/16
        }
    }

    chain input {
        type filter hook input priority filter; policy drop;

        # Block listed IPs (O(1) lookup via hash set)
        ip saddr @blocklist_v4 counter drop
        ip6 saddr @blocklist_v6 counter drop

        # Admin access control
        tcp dport 22 ip saddr @admin_sources accept
        tcp dport 9090 ip saddr @admin_sources accept

        ct state established,related accept
        ct state invalid drop
    }
}
```

### Dynamic Set Management

```bash
# Add IP to blocklist programmatically
nft add element inet advanced_filtering blocklist_v4 { 198.51.100.1 }
nft add element inet advanced_filtering blocklist_v4 { 198.51.100.0/24 }

# Add with timeout (auto-expire in 1 hour)
nft add element inet advanced_filtering blocklist_v4 { 198.51.100.1 timeout 1h }

# Remove from blocklist
nft delete element inet advanced_filtering blocklist_v4 { 198.51.100.1 }

# List all elements
nft list set inet advanced_filtering blocklist_v4

# Flush entire set
nft flush set inet advanced_filtering blocklist_v4
```

### Fail2Ban Integration with nftables Sets

```ini
# /etc/fail2ban/action.d/nftables-multiport.conf
[Definition]
actionstart = nft add table inet fail2ban 2>/dev/null || true
              nft add chain inet fail2ban input { type filter hook input priority -1\; policy accept\; } 2>/dev/null || true
              nft add set inet fail2ban <name> { type ipv4_addr \; flags dynamic\; } 2>/dev/null || true
              nft add rule inet fail2ban input ip saddr @<name> counter drop 2>/dev/null || true

actionstop =  nft delete table inet fail2ban 2>/dev/null || true

actioncheck = nft list chain inet fail2ban input 2>/dev/null

actionban =   nft add element inet fail2ban <name> { <ip> timeout <bantime>s }

actionunban = nft delete element inet fail2ban <name> { <ip> } 2>/dev/null || true
```

## Verdict Maps for Complex Routing

Maps dispatch traffic to different chains based on packet attributes:

```bash
table inet routing {
    # Map ports to destination chains
    map port_to_chain {
        type inet_service : verdict
        elements = {
            22   : jump ssh_chain,
            80   : jump http_chain,
            443  : jump https_chain,
            3306 : jump mysql_chain,
            5432 : jump postgres_chain
        }
    }

    chain input {
        type filter hook input priority filter; policy drop;

        ct state established,related accept
        ct state invalid drop

        # Dispatch based on port - eliminates sequential rule scanning
        tcp dport vmap @port_to_chain

        # Default deny
        counter drop
    }

    chain ssh_chain {
        ip saddr 10.0.0.0/8 accept
        counter drop
    }

    chain http_chain {
        accept  # Public HTTP
    }

    chain https_chain {
        accept  # Public HTTPS
    }

    chain mysql_chain {
        ip saddr { 10.0.1.0/24, 10.0.2.0/24 } accept
        counter drop
    }

    chain postgres_chain {
        ip saddr 10.0.2.0/24 accept
        counter drop
    }
}
```

## Complete Production Server Ruleset

```bash
#!/usr/bin/nft -f
# /etc/nftables.conf - Production server ruleset
# Generated: 2031-11-03
# Host: prod-api-01.example.corp

flush ruleset

define LOOPBACK = lo
define EXT_IF = eth0
define INT_IF = eth1
define MGMT_NETS = { 10.0.0.0/8, 172.16.0.0/12 }
define APP_SERVERS = { 10.0.1.10, 10.0.1.11, 10.0.1.12 }
define DB_SERVERS = { 10.0.2.10, 10.0.2.11 }
define NTP_SERVERS = { 169.254.169.123, 10.0.0.5 }
define DNS_SERVERS = { 10.0.0.1, 10.0.0.2 }

# Main firewall table (handles both IPv4 and IPv6)
table inet main {

    # Rate limiting sets
    meter ratelimit_ssh {
        type ipv4_addr
        size 128
    }

    # Blocklist (dynamically populated by fail2ban or automation)
    set blocklist {
        type ipv4_addr
        flags interval, timeout, dynamic
        timeout 24h
        size 65536
    }

    # Trusted management sources
    set mgmt_trusted {
        type ipv4_addr
        flags interval
        elements = $MGMT_NETS
    }

    # Application servers
    set app_servers {
        type ipv4_addr
        elements = $APP_SERVERS
    }

    # Database servers
    set db_servers {
        type ipv4_addr
        elements = $DB_SERVERS
    }

    # -------------------------
    # INPUT CHAIN
    # -------------------------
    chain input {
        type filter hook input priority filter; policy drop;

        # 1. Loopback (always first)
        iif $LOOPBACK accept

        # 2. Blocklist check (fast path rejection)
        ip saddr @blocklist counter drop

        # 3. Connection tracking
        ct state established,related accept
        ct state invalid counter drop

        # 4. ICMPv4
        icmp type {
            echo-reply,
            destination-unreachable,
            time-exceeded,
            parameter-problem
        } accept
        ip protocol icmp icmp type echo-request \
            limit rate 5/second burst 10 packets accept
        ip protocol icmp icmp type echo-request counter drop

        # 5. ICMPv6
        ip6 nexthdr icmpv6 icmpv6 type {
            destination-unreachable, packet-too-big,
            time-exceeded, parameter-problem,
            nd-router-solicit, nd-router-advert,
            nd-neighbor-solicit, nd-neighbor-advert,
            mld-listener-query, mld-listener-report
        } accept

        # 6. SSH (rate limited, management only)
        tcp dport 22 ip saddr @mgmt_trusted \
            meter ratelimit_ssh { ip saddr limit rate 10/minute } \
            accept
        tcp dport 22 ip saddr @mgmt_trusted counter drop comment "SSH rate limit exceeded"
        tcp dport 22 counter drop comment "SSH from non-management IP"

        # 7. Public web traffic
        tcp dport { 80, 443 } accept
        udp dport 443 accept comment "HTTP/3 QUIC"

        # 8. Internal application traffic
        tcp dport { 8080, 8443 } ip saddr @app_servers accept

        # 9. Database connections (only from app servers)
        tcp dport { 5432, 3306 } ip saddr @app_servers accept
        tcp dport { 5432, 3306 } counter drop comment "DB from unauthorized source"

        # 10. NTP
        udp dport 123 ip daddr $NTP_SERVERS accept

        # 11. Prometheus metrics scraping
        tcp dport 9090 ip saddr @mgmt_trusted accept
        tcp dport { 9100, 9187 } ip saddr @mgmt_trusted accept

        # 12. Log and drop everything else
        limit rate 10/minute log prefix "[BLOCKED-IN] " level warn flags all
        counter name blocked_in drop
    }

    # -------------------------
    # OUTPUT CHAIN
    # -------------------------
    chain output {
        type filter hook output priority filter; policy accept;

        # Drop invalid outbound packets
        ct state invalid counter drop

        # Allow all established outbound
        ct state established,related accept
    }

    # -------------------------
    # FORWARD CHAIN
    # -------------------------
    chain forward {
        type filter hook forward priority filter; policy drop;

        # Drop forwarded traffic (not a router)
        counter drop
    }

    # -------------------------
    # COUNTERS
    # -------------------------
    counter blocked_in { comment "Packets dropped in INPUT chain" }
}

# NAT table (IPv4 only for NAT)
table ip nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # Load balance HTTP to app servers
        iif $EXT_IF tcp dport 80 \
            dnat to numgen inc mod 3 map {
                0 : 10.0.1.10,
                1 : 10.0.1.11,
                2 : 10.0.1.12
            }
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # Masquerade outbound traffic
        oif $EXT_IF masquerade
    }
}
```

## Migrating from iptables to nftables

### Automated Conversion

```bash
# Install conversion tools
dnf install -y iptables-nftables-compat  # RHEL
apt-get install -y iptables              # Ubuntu (includes iptables-translate)

# Convert existing iptables rules
iptables-save | iptables-restore-translate > /tmp/nftables-converted.conf

# Convert ip6tables rules
ip6tables-save | ip6tables-restore-translate >> /tmp/nftables-converted.conf

# Review the converted rules
cat /tmp/nftables-converted.conf
```

### Manual Migration Reference

```bash
# iptables rule:
iptables -A INPUT -p tcp --dport 22 -s 10.0.0.0/8 -j ACCEPT

# nftables equivalent:
nft add rule inet filter input tcp dport 22 ip saddr 10.0.0.0/8 accept

# iptables -m state:
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# nftables equivalent:
nft add rule inet filter input ct state established,related accept

# iptables multiport:
iptables -A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT

# nftables equivalent (simpler):
nft add rule inet filter input tcp dport { 80, 443 } accept

# iptables ipset:
iptables -A INPUT -m set --match-set blocked src -j DROP

# nftables equivalent (built-in sets):
nft add rule inet filter input ip saddr @blocked drop

# iptables LOG:
iptables -A INPUT -j LOG --log-prefix "BLOCKED: " --log-level 4

# nftables equivalent:
nft add rule inet filter input log prefix "BLOCKED: " level warn
```

### Zero-Downtime Migration Script

```bash
#!/bin/bash
# migrate-iptables-to-nftables.sh
# Performs live migration with automatic rollback on failure

set -euo pipefail

BACKUP_FILE="/etc/iptables-backup-$(date +%Y%m%d-%H%M%S).rules"
NEW_RULES="/etc/nftables.conf"
ROLLBACK_TIMEOUT=300  # Seconds before rolling back if not confirmed

echo "=== iptables to nftables Migration ==="
echo "Timestamp: $(date)"

# Step 1: Backup current iptables rules
echo "Backing up current iptables rules..."
iptables-save > "${BACKUP_FILE}"
ip6tables-save >> "${BACKUP_FILE}"
echo "Backup saved to: ${BACKUP_FILE}"

# Step 2: Validate new nftables config
echo "Validating new nftables configuration..."
nft -c -f "${NEW_RULES}"
echo "Configuration syntax valid"

# Step 3: Test apply in a subshell with auto-rollback
echo "Applying new nftables configuration (auto-rollback in ${ROLLBACK_TIMEOUT}s if not confirmed)..."

# Schedule automatic rollback
(
    sleep ${ROLLBACK_TIMEOUT}
    echo "ROLLBACK: Timeout reached, reverting to iptables..."
    # Re-enable iptables
    systemctl stop nftables 2>/dev/null
    iptables-restore < "${BACKUP_FILE}"
    systemctl start iptables 2>/dev/null
    echo "Rollback complete"
) &
ROLLBACK_PID=$!

# Apply new rules
systemctl stop iptables 2>/dev/null || true
nft -f "${NEW_RULES}"

echo ""
echo "nftables rules applied. Verify connectivity now."
echo "Run the following command to confirm and prevent rollback:"
echo "  kill ${ROLLBACK_PID}"
echo ""
echo "Or press Ctrl+C to trigger rollback manually"

# Wait for confirmation
read -p "Confirm nftables migration is successful? [y/N]: " CONFIRM

if [[ "${CONFIRM}" == "y" || "${CONFIRM}" == "Y" ]]; then
    kill ${ROLLBACK_PID} 2>/dev/null || true
    systemctl enable --now nftables
    echo "Migration confirmed. nftables is now active."
else
    kill ${ROLLBACK_PID} 2>/dev/null || true
    echo "Rolling back..."
    systemctl stop nftables
    iptables-restore < "${BACKUP_FILE}"
    systemctl enable --now iptables 2>/dev/null || true
    echo "Rollback complete. iptables restored."
fi
```

## nftables in Kubernetes Environments

### kube-proxy with nftables Mode

Since Kubernetes 1.29, kube-proxy supports nftables mode:

```yaml
# kube-proxy-config.yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: nftables
nftables:
  masqueradeAll: false
  masqueradeBit: 14
  minSyncPeriod: 1s
  syncPeriod: 30s
conntrack:
  maxPerCore: 32768
  min: 131072
  tcpCloseWaitTimeout: 1h0m0s
  tcpEstablishedTimeout: 24h0m0s
```

### Avoiding Conflicts with Kubernetes Network Policies

```bash
# Kubernetes CNI plugins manage their own nftables/iptables rules
# When adding custom nftables rules on Kubernetes nodes, ensure they don't conflict

# List current nftables tables (some created by CNI)
nft list tables

# Typically you'll see:
# table ip filter      <- Kubernetes iptables compat
# table ip6 filter
# table ip nat
# table ip mangle
# table inet kubernetes <- Some CNI plugins use inet

# Add custom rules in a separate table with appropriate priority
table inet custom-security {
    chain input {
        # Priority 10 ensures this runs AFTER Kubernetes rules (priority 0)
        type filter hook input priority 10; policy accept;

        # Blocklist check
        ip saddr @blocklist drop
    }
}
```

## Monitoring nftables Rules

### Counter and Statistics

```bash
# List all counters
nft list counters

# Show specific counter
nft list counter inet main blocked_in

# Monitor counters in real-time
watch -n 1 'nft list counter inet main blocked_in'

# Reset counters
nft reset counters

# List all rules with counters
nft -s list ruleset | grep -A 2 "counter"

# Export statistics for Prometheus
cat > /usr/local/bin/nftables-metrics.sh << 'EOF'
#!/bin/bash
# Export nftables counters as Prometheus metrics

echo "# HELP nftables_dropped_packets_total Total dropped packets"
echo "# TYPE nftables_dropped_packets_total counter"

BLOCKED=$(nft -j list counter inet main blocked_in 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(d.get('nftables', [{}])[0].get('counter', {}).get('packets', 0))" 2>/dev/null || echo 0)

echo "nftables_dropped_packets_total{chain=\"input\"} ${BLOCKED}"
EOF
chmod +x /usr/local/bin/nftables-metrics.sh
```

### Logging Configuration

```bash
# Add logging with rate limiting to avoid log flooding
table inet firewall {
    chain input {
        type filter hook input priority filter; policy drop;

        # ... other rules ...

        # Log SSH brute force attempts before dropping
        tcp dport 22 ct state new \
            limit rate over 5/minute \
            log prefix "SSH-BRUTE-FORCE: " level warn flags all

        # Rate-limited logging for dropped packets
        limit rate 30/minute \
            log prefix "DROPPED-INPUT: " level info \
            flags ip options,skuid,ether,all

        counter drop
    }
}
```

View logs:

```bash
# Real-time firewall logs
journalctl -f -k | grep -E "nftables|BLOCKED|DROPPED"

# Count drops per source IP (last 1 hour)
journalctl --since "1 hour ago" -k | \
  grep "DROPPED-INPUT:" | \
  grep -oP "SRC=\K[\d.]+" | \
  sort | uniq -c | sort -rn | head -20
```

## Conclusion

nftables provides a significantly improved firewall framework over iptables: atomic ruleset updates prevent partial-state issues during rule changes, built-in sets and maps enable O(1) IP lookups that scale to millions of elements, and the unified inet family eliminates the IPv4/IPv6 rule duplication burden. The migration from iptables is straightforward — the `iptables-translate` tool handles the mechanical conversion, and the migration script pattern with automatic rollback ensures zero-downtime transitions. For Kubernetes environments, the kube-proxy nftables mode available since 1.29 brings these same performance benefits to service routing at cluster scale.
