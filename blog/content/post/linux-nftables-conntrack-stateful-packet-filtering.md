---
title: "Linux Firewall Deep Dive: nftables, Conntrack, and Stateful Packet Filtering"
date: 2030-02-27T00:00:00-05:00
draft: false
tags: ["Linux", "nftables", "Firewall", "Networking", "Conntrack", "iptables", "Security"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master nftables for production firewall management: ruleset design, connection tracking, NAT configuration, rate limiting, iptables migration, and performance optimization."
more_link: "yes"
url: "/linux-nftables-conntrack-stateful-packet-filtering/"
---

nftables has been the default firewall framework in major Linux distributions since 2019 (Debian 10, RHEL 8, Ubuntu 20.04). It replaces iptables, ip6tables, arptables, and ebtables with a single coherent framework that supports atomic rule updates, improved performance through set-based matching, and a cleaner syntax that is significantly easier to audit. Yet most production systems still run iptables compatibility layers or retain old iptables configurations long past their useful life.

This guide covers building production nftables rulesets from the ground up, understanding connection tracking to write efficient stateful rules, implementing NAT for complex network topologies, rate limiting to protect against floods, and migrating safely from iptables.

<!--more-->

## nftables vs iptables: What Changed and Why It Matters

iptables processes rules linearly — every packet traverses each rule until a match is found or the default policy applies. With hundreds of rules, this is O(n) per packet. nftables introduces sets and maps that provide O(1) or O(log n) lookup for IP address lists, port ranges, and other match criteria.

iptables requires four separate tools for IPv4, IPv6, ARP, and bridge filtering. nftables handles all four in a single consistent framework with a single atomic update mechanism — you can replace an entire ruleset with a single operation that either fully succeeds or leaves the old ruleset intact.

iptables rule management is procedural (add/delete individual rules). nftables uses declarative files that can be loaded atomically, making configuration management with Ansible, Puppet, or Terraform dramatically simpler.

## Core Concepts

### Tables, Chains, and Rules

```
Table (family-scoped: inet, ip, ip6, arp, bridge, netdev)
  └── Chain (hooks: prerouting, input, forward, output, postrouting)
        └── Rule (match conditions + verdict)
```

**Families**:
- `ip`: IPv4 only
- `ip6`: IPv6 only
- `inet`: IPv4 + IPv6 (most common for new rulesets)
- `arp`: ARP filtering
- `bridge`: Bridge filtering
- `netdev`: Ingress/egress hooks at network device level

**Base Chain Types**:
- `filter`: Accept or drop packets
- `nat`: Network Address Translation
- `route`: Mark packets for policy routing

**Hook Priority**: Numbers determine execution order when multiple chains use the same hook. Lower numbers run first. Standard values: -400 (raw), -300 (conntrack), -200 (mangle), -100 (nat/dstnat), 0 (filter), 100 (srcnat).

## Building a Production Server Ruleset

Start with the complete production template, then explain each section:

```bash
# /etc/nftables.conf - Production server firewall
# Apply with: nft -f /etc/nftables.conf
# Test first: nft -c -f /etc/nftables.conf (check without applying)

# Flush all existing rules
flush ruleset

# ================================================================
# Main filter table (inet handles both IPv4 and IPv6)
# ================================================================
table inet filter {

    # ============================================================
    # Sets for efficient matching
    # ============================================================

    # Management access CIDRs (update this set to change access)
    set mgmt_cidrs {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,
            172.16.0.0/12,
            192.168.0.0/16
        }
    }

    # Blocked IPs (populated dynamically by fail2ban or custom scripts)
    set blocklist {
        type ipv4_addr
        flags dynamic, timeout
        timeout 1h
        gc-interval 30m
    }

    # Rate-limited IPs (populated by rate limit rules below)
    set ratelimited {
        type ipv4_addr
        flags dynamic, timeout
        timeout 5m
        size 65536
    }

    # Valid TCP services accessible from the internet
    set public_tcp_services {
        type inet_service
        flags interval
        elements = { 80, 443, 8080, 8443 }
    }

    # ============================================================
    # Input chain - packets destined for this host
    # ============================================================
    chain input {
        type filter hook input priority filter; policy drop;

        # Allow established and related connections (conntrack)
        ct state established,related accept

        # Drop invalid packets immediately
        ct state invalid drop

        # Allow loopback
        iif lo accept

        # Drop blocked IPs
        ip saddr @blocklist drop

        # Allow ICMP (essential for network diagnostics)
        # Limit to prevent ICMP flood
        ip protocol icmp icmp type {
            echo-reply,
            destination-unreachable,
            time-exceeded,
            parameter-problem
        } accept
        ip protocol icmp icmp type echo-request limit rate 10/second burst 30 packets accept
        ip6 nexthdr icmpv6 icmpv6 type {
            nd-neighbor-solicit,
            nd-neighbor-advert,
            nd-router-advert,
            mld-listener-query
        } accept
        ip6 nexthdr icmpv6 icmpv6 type echo-request limit rate 10/second burst 30 packets accept

        # SSH: only from management networks, with rate limiting
        tcp dport 22 ip saddr @mgmt_cidrs accept
        tcp dport 22 limit rate over 5/minute add @ratelimited { ip saddr } log prefix "SSH-FLOOD: " drop
        tcp dport 22 drop

        # Public web services
        tcp dport @public_tcp_services accept
        udp dport 443 accept  # QUIC/HTTP3

        # DNS (outgoing queries from local resolver)
        udp dport 53 ip saddr @mgmt_cidrs accept
        tcp dport 53 ip saddr @mgmt_cidrs accept

        # Prometheus metrics: internal only
        tcp dport 9090 ip saddr @mgmt_cidrs accept
        tcp dport 9100 ip saddr @mgmt_cidrs accept

        # Log and drop everything else
        limit rate 10/minute log prefix "DROPPED-INPUT: " flags all
        drop
    }

    # ============================================================
    # Forward chain - packets passing through this host
    # ============================================================
    chain forward {
        type filter hook forward priority filter; policy drop;

        # Established connections
        ct state established,related accept
        ct state invalid drop

        # Forward from internal to external (outbound)
        iifname "eth1" oifname "eth0" accept

        # Forward from external to DMZ only
        iifname "eth0" oifname "eth2" ct state new accept

        log prefix "DROPPED-FORWARD: "
        drop
    }

    # ============================================================
    # Output chain - packets originating from this host
    # ============================================================
    chain output {
        type filter hook output priority filter; policy accept;

        # Allow all outbound by default, but restrict problematic traffic
        ct state invalid drop

        # Prevent SMTP spam (common on compromised hosts)
        tcp dport 25 drop

        # Log unexpected outbound to sensitive ports
        tcp dport { 3389, 5900 } log prefix "SUSPICIOUS-OUTBOUND: "
    }
}

# ================================================================
# NAT table
# ================================================================
table inet nat {

    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # DNAT: redirect port 80 on external IP to internal web server
        iifname "eth0" tcp dport 80 dnat to 10.10.1.5:80
        iifname "eth0" tcp dport 443 dnat to 10.10.1.5:443
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # Masquerade all traffic from internal networks going out
        oifname "eth0" ip saddr 10.0.0.0/8 masquerade
        oifname "eth0" ip saddr 172.16.0.0/12 masquerade
        oifname "eth0" ip saddr 192.168.0.0/16 masquerade
    }
}

# ================================================================
# Raw table (before conntrack) for performance optimization
# ================================================================
table inet raw {

    chain prerouting {
        type filter hook prerouting priority raw; policy accept;

        # Skip conntrack for high-volume internal traffic
        # (reduces conntrack table pressure)
        ip saddr 10.10.0.0/16 ip daddr 10.10.0.0/16 notrack
    }
}
```

Apply and verify:

```bash
# Syntax check without applying
nft -c -f /etc/nftables.conf

# Apply the ruleset
nft -f /etc/nftables.conf

# List the active ruleset
nft list ruleset

# Save current ruleset
nft list ruleset > /etc/nftables.conf
```

## Connection Tracking (Conntrack) Deep Dive

Connection tracking is what makes "stateful" firewalling possible. The conntrack subsystem maintains a table of known connections and their states, allowing rules to accept reply traffic without explicit bidirectional rules.

### Conntrack States

- `new`: First packet of a new connection
- `established`: Reply seen; connection is established
- `related`: A new connection related to an existing one (e.g., FTP data channel, ICMP error for TCP session)
- `invalid`: Packet that does not match any known connection and isn't valid as a new connection
- `untracked`: Packet marked with `notrack` in the raw table

### Viewing the Conntrack Table

```bash
# Install conntrack tools
apt-get install conntrack

# List all connections
conntrack -L

# List with statistics
conntrack -L -s

# Watch new connections in real time
conntrack -E -e NEW

# Show TCP connections in ESTABLISHED state
conntrack -L -p tcp --state ESTABLISHED

# Count connections per source IP (useful for DDoS detection)
conntrack -L | awk '{print $7}' | cut -d= -f2 | sort | uniq -c | sort -rn | head -20

# Sample output:
# 2048 10.0.1.45
#  512 203.0.113.7
#  341 198.51.100.3
#    8 192.168.1.100
```

### Tuning Conntrack for High Traffic

The default conntrack table size is often too small for high-traffic servers:

```bash
# Check current conntrack table usage
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Check if table is full (entries dropped)
conntrack -S | grep drop

# Increase table size (add to /etc/sysctl.conf)
cat >> /etc/sysctl.conf << 'EOF'
# Conntrack tuning for high-traffic server
net.netfilter.nf_conntrack_max = 2097152
net.netfilter.nf_conntrack_buckets = 524288
net.netfilter.nf_conntrack_tcp_timeout_established = 3600
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close = 5
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_last_ack = 30
net.netfilter.nf_conntrack_tcp_timeout_syn_recv = 30
net.netfilter.nf_conntrack_tcp_timeout_syn_sent = 30
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 120
net.netfilter.nf_conntrack_icmp_timeout = 10
EOF

sysctl -p
```

### Conntrack Zones for Overlapping IP Spaces

In environments with overlapping private IP spaces (common in multi-tenant systems or after acquisitions), conntrack zones prevent connection tracking conflicts:

```bash
# nftables: assign conntrack zones based on interface
table inet raw {
    chain prerouting {
        type filter hook prerouting priority raw; policy accept;

        # Packets from tenant-1 interface get zone 1
        iifname "vlan100" ct zone set 1

        # Packets from tenant-2 interface get zone 2
        iifname "vlan200" ct zone set 2
    }

    chain output {
        type filter hook output priority raw; policy accept;

        oifname "vlan100" ct zone set 1
        oifname "vlan200" ct zone set 2
    }
}
```

## Advanced Rate Limiting

### Per-IP Rate Limiting with Dynamic Sets

```bash
table inet filter {

    # Dynamic set: IPs that exceed SSH rate limit
    set ssh_blocked {
        type ipv4_addr
        flags dynamic, timeout
        timeout 10m
    }

    chain input {
        type filter hook input priority filter; policy drop;

        # Block IPs that are in the blocked set
        tcp dport 22 ip saddr @ssh_blocked drop

        # Allow established SSH connections
        tcp dport 22 ct state established accept

        # Rate limit new SSH connections: max 3 per minute per source IP
        # IPs exceeding the limit are added to ssh_blocked for 10 minutes
        tcp dport 22 ct state new \
            meter ssh_attempts { ip saddr limit rate over 3/minute } \
            add @ssh_blocked { ip saddr } \
            log prefix "SSH-RATELIMIT: " \
            drop

        tcp dport 22 ct state new accept
    }
}
```

### SYN Flood Protection

```bash
table inet filter {

    chain input {
        type filter hook input priority filter; policy drop;

        # SYN flood protection:
        # 1. Limit new TCP SYN packets
        # 2. Track burst capacity with a token bucket meter

        # Allow established connections first (no rate limit needed)
        ct state established,related accept

        # Check for SYN flood
        tcp flags syn tcp dport { 80, 443 } \
            meter synflood_check { ip saddr limit rate 50/second burst 100 packets } \
            accept

        tcp flags syn tcp dport { 80, 443 } \
            limit rate 10/second \
            log prefix "SYN-FLOOD: " \
            drop

        tcp flags syn tcp dport { 80, 443 } drop
    }

    # Alternative: use hashlimit-style rate limiting with maps
    chain prerouting {
        type filter hook prerouting priority -150; policy accept;

        # HTTP/HTTPS SYN limit per source IP: 100 new conn/second, burst 200
        tcp flags & (fin|syn|rst|ack) == syn \
            tcp dport { 80, 443 } \
            meter http_syn { ip saddr limit rate over 100/second burst 200 packets } \
            jump tcp_flood
    }

    chain tcp_flood {
        limit rate 5/minute log prefix "TCP-FLOOD-DETECTED: "
        drop
    }
}
```

### ICMP Rate Limiting

```bash
table inet filter {
    chain input {
        # Accept essential ICMP types without rate limit
        ip protocol icmp icmp type {
            echo-reply,
            destination-unreachable,
            time-exceeded
        } accept

        # Rate-limit ping requests
        ip protocol icmp icmp type echo-request \
            limit rate 5/second burst 15 packets \
            accept

        # Drop excess ICMP (do NOT log - can fill logs)
        ip protocol icmp drop
    }
}
```

## NAT Configuration for Complex Topologies

### Load Balancing with NAT

nftables supports load balancing directly without external tools:

```bash
table ip nat {

    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # Round-robin load balancing across 3 backend servers
        # numgen: generates sequential (or random) numbers
        tcp dport 80 dnat to numgen inc mod 3 map {
            0 : 10.0.1.10,
            1 : 10.0.1.11,
            2 : 10.0.1.12
        }

        # Weighted distribution: backend1 gets 40%, backend2 gets 40%, backend3 gets 20%
        tcp dport 8080 dnat to numgen random mod 10 map {
            0-3  : 10.0.1.10,
            4-7  : 10.0.1.11,
            8-9  : 10.0.1.12
        }
    }
}
```

### Hairpin NAT (NAT Loopback)

```bash
table ip nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # DNAT from external IP to internal server
        iifname "eth0" tcp dport 443 dnat to 192.168.1.100:443

        # Hairpin NAT: internal clients can reach the server via the public IP
        iifname "eth1" ip daddr 203.0.113.10 tcp dport 443 dnat to 192.168.1.100:443
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # Masquerade for hairpin: when traffic leaves on same interface it entered
        ip daddr 192.168.1.100 tcp dport 443 oifname "eth1" masquerade
    }
}
```

### Transparent Proxy

```bash
table ip nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # Redirect all HTTP traffic to local proxy (squid on port 3128)
        # Exclude traffic from the proxy itself
        tcp dport 80 ip saddr != 127.0.0.1 redirect to :3128

        # Redirect HTTPS for SSL interception proxy
        # (requires TPROXY setup in the filter table)
        tcp dport 443 ip saddr != 127.0.0.1 tproxy to :3129
    }
}

table ip mangle {
    chain prerouting {
        type filter hook prerouting priority mangle; policy accept;

        # Mark packets for TPROXY (SSL proxy)
        tcp dport 443 tproxy to :3129 meta mark set 1 accept
    }
}
```

## Migrating from iptables

### Automated Migration

Red Hat and Fedora provide `iptables-translate` tools:

```bash
# Translate a single iptables rule
iptables-translate -A INPUT -p tcp --dport 22 -j ACCEPT
# Output: nft add rule ip filter INPUT tcp dport 22 counter accept

# Translate entire iptables-save output
iptables-save | iptables-restore-translate > /tmp/nftables-translated.conf

# Translate ip6tables
ip6tables-save | ip6tables-restore-translate >> /tmp/nftables-translated.conf

# Review the output carefully before applying
cat /tmp/nftables-translated.conf
```

### Manual Migration Example

iptables ruleset:

```bash
# Old iptables rules
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A INPUT -p icmp --icmp-type echo-request -m limit --limit 5/s -j ACCEPT
```

Equivalent nftables:

```bash
table inet filter {
    chain input {
        type filter hook input priority filter; policy drop;

        ct state established,related accept
        ct state invalid drop
        iif lo accept
        tcp dport 22 ip saddr 10.0.0.0/8 accept
        tcp dport { 80, 443 } accept
        ip protocol icmp icmp type echo-request limit rate 5/second accept
    }

    chain forward {
        type filter hook forward priority filter; policy drop;
    }

    chain output {
        type filter hook output priority filter; policy accept;
    }
}
```

### Running iptables and nftables Simultaneously

During migration, you can run both. iptables-nft (the default on modern systems) writes to the nftables backend, so they share state:

```bash
# Check which iptables backend is active
iptables --version
# iptables v1.8.7 (nf_tables) - means iptables-nft, shares nftables backend
# iptables v1.8.7 (legacy)   - means iptables-legacy, separate from nftables

# List all rules from both backends together
nft list ruleset

# IMPORTANT: iptables-nft and nft rules ARE the same ruleset
# Avoid mixing iptables-nft and nft management to prevent conflicts
```

## Performance Comparison and Tuning

### Set-Based Matching Performance

```bash
# SLOW: linear list matching (O(n) per packet)
# Each IP requires a separate rule
table inet filter {
    chain input {
        ip saddr 203.0.113.1 drop
        ip saddr 203.0.113.2 drop
        ip saddr 203.0.113.3 drop
        # ... 10,000 more IPs
    }
}

# FAST: set-based matching (O(1) for hash sets, O(log n) for interval sets)
table inet filter {
    set blocklist {
        type ipv4_addr
        flags interval
        # Can contain 100,000 IPs with no performance degradation
        elements = { 203.0.113.1, 203.0.113.2, 203.0.113.3 }
    }

    chain input {
        ip saddr @blocklist drop  # Single rule, O(1) lookup
    }
}
```

### Verdict Maps for Efficient Port Dispatch

```bash
table inet filter {
    # Map services to their handling chains
    map service_dispatch {
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

        # Single rule dispatches to the right chain for all services
        tcp dport vmap @service_dispatch

        drop
    }

    chain ssh_chain {
        ip saddr @mgmt_cidrs accept
        log prefix "SSH-DENIED: "
        drop
    }

    chain http_chain {
        accept
    }

    chain https_chain {
        accept
    }

    chain mysql_chain {
        ip saddr @mgmt_cidrs accept
        drop
    }

    chain postgres_chain {
        ip saddr @mgmt_cidrs accept
        drop
    }
}
```

### Monitoring nftables Performance

```bash
# Enable rule counting to measure hit rates
table inet filter {
    chain input {
        type filter hook input priority filter; policy drop;

        # counter keyword adds per-rule packet/byte counters
        ct state established,related counter accept
        iif lo counter accept
        tcp dport 22 counter accept
    }
}

# View counters
nft list ruleset | grep counter

# Reset counters
nft reset counters table inet filter

# Monitor with watch
watch -n1 'nft list ruleset | grep -E "counter|accept|drop"'
```

## Dynamic Rule Management

### Adding IPs to Sets at Runtime

```bash
# Add an IP to the blocklist
nft add element inet filter blocklist { 203.0.113.50 }

# Add with timeout (auto-remove after 1 hour)
nft add element inet filter blocklist { 203.0.113.51 timeout 1h }

# Remove an IP from the blocklist
nft delete element inet filter blocklist { 203.0.113.50 }

# Add multiple IPs at once
nft add element inet filter blocklist {
    203.0.113.100,
    203.0.113.101,
    203.0.113.102
}

# List all elements in a set
nft list set inet filter blocklist
```

### Integration with fail2ban

```ini
# /etc/fail2ban/action.d/nftables-common.conf
[Definition]
actionstart = nft add table inet f2b
              nft -- add chain inet f2b input { type filter hook input priority -1 \; }
              nft add set inet f2b addr-set-<name> { type ipv4_addr \; flags timeout \; }
              nft add rule inet f2b input ip saddr @addr-set-<name> drop

actionstop = nft delete table inet f2b

actionban = nft add element inet f2b addr-set-<name> { <ip> timeout <bantime>s }

actionunban = nft delete element inet f2b addr-set-<name> { <ip> }
```

## SystemD Integration and Persistence

```bash
# Enable nftables service
systemctl enable nftables
systemctl start nftables

# Service configuration
# /etc/systemd/system/nftables.service is provided by the package
# It loads /etc/nftables.conf on start

# Verify nftables starts at boot with correct rules
systemctl status nftables

# Test ruleset reload without disrupting existing connections
nft -f /etc/nftables.conf
```

## Key Takeaways

nftables provides a substantially better foundation for production firewall management than iptables:

1. **Atomic updates**: Replace entire rulesets atomically — either the new ruleset loads completely or the old one stays intact. This eliminates the window of inconsistency during iptables rule manipulation.
2. **Set-based matching scales**: A blocklist of 100,000 IPs requires one rule with a set, not 100,000 rules. The performance difference at scale is dramatic.
3. **Verdict maps eliminate chain overhead**: Dispatching packets to per-service chains via a map is faster than checking each rule in sequence and eliminates duplicate conntrack checks.
4. **Connection tracking timeout tuning is essential**: Default conntrack timeouts are conservative and can cause table exhaustion on busy servers. Tune timeouts based on actual traffic patterns.
5. **Dynamic set management integrates with fail2ban**: The `flags dynamic, timeout` set features make runtime IP blocking straightforward and automatic cleanup prevents unbounded set growth.
6. **Migration from iptables is well-tooled**: `iptables-translate` handles the mechanical conversion. The remaining work is refactoring sequential rules into efficient sets and maps.

For new deployments, write nftables rules from the start. For existing iptables deployments, the migration pays dividends in maintainability and performance, especially at scale.
