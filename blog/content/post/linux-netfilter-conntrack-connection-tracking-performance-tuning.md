---
title: "Linux Netfilter and Conntrack: Connection Tracking Tables and Performance Tuning"
date: 2030-09-14T00:00:00-05:00
draft: false
tags: ["Linux", "Netfilter", "Conntrack", "Networking", "Kubernetes", "Performance", "Kernel"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Netfilter deep dive: conntrack table sizing, conntrack timeouts per protocol, NOTRACK rules, nf_conntrack_max tuning, conntrack in Kubernetes environments, debugging 'nf_conntrack: table full' errors, and conntrack helper modules."
more_link: "yes"
url: "/linux-netfilter-conntrack-connection-tracking-performance-tuning/"
---

The `nf_conntrack: table full, dropping packet` kernel message is a production crisis that strikes without warning. One moment traffic flows normally; the next, connections are being silently dropped at the kernel level, causing application timeouts, failed health checks, and cascading outages. The root cause is always the same: the connection tracking table has reached its maximum size and new connections cannot be tracked. Understanding Netfilter's connection tracking subsystem — its data structures, sizing constraints, timeout semantics, and failure modes — is essential knowledge for anyone operating high-traffic Kubernetes nodes.

<!--more-->

## Netfilter Architecture Overview

Netfilter is the Linux kernel framework that intercepts and transforms network packets at defined hook points in the network stack. iptables, nftables, and Kubernetes kube-proxy are all built on top of Netfilter.

The connection tracking (conntrack) module provides stateful packet inspection by maintaining a hash table of all known connections. Every TCP connection, UDP flow, and ICMP exchange creates an entry in this table. The table is consulted on every packet to determine whether it belongs to an established connection or represents a new flow.

### Conntrack Table Data Structures

The conntrack table is a hash table indexed by a 5-tuple:
- Source IP address
- Destination IP address
- Source port
- Destination port
- Layer 4 protocol (TCP, UDP, ICMP, etc.)

Each entry (`nf_conn` structure) stores:
- The connection's state (NEW, ESTABLISHED, RELATED, INVALID)
- Timeout value for automatic expiry
- Statistics counters
- Extension data (NAT mappings, helper state, etc.)

```bash
# View conntrack table entry count
cat /proc/sys/net/netfilter/nf_conntrack_count

# View maximum table size
cat /proc/sys/net/netfilter/nf_conntrack_max

# View actual table entries
conntrack -L 2>/dev/null | head -20

# Example output:
# tcp      6 431999 ESTABLISHED src=10.0.1.5 dst=10.0.2.10 sport=52341 dport=5432
#          src=10.0.2.10 dst=10.0.1.5 sport=5432 dport=52341 [ASSURED] mark=0 use=1
# udp      17 28 src=10.0.1.5 dst=8.8.8.8 sport=54321 dport=53
#          src=8.8.8.8 dst=10.0.1.5 sport=53 dport=54321 mark=0 use=1
```

### Hash Table Bucket Count

The hash table bucket count is set at module load time and cannot be changed without unloading the module:

```bash
# View current hash table size (buckets)
cat /proc/sys/net/netfilter/nf_conntrack_buckets

# The default bucket count is min(nf_conntrack_max/8, 65536)
# With nf_conntrack_max=131072, buckets = 131072/8 = 16384

# For optimal performance, the ratio of max_entries to buckets should be ~4:1 to 8:1.
# More buckets = faster lookups but more memory usage.
```

Set the bucket count via kernel module parameter (must be done before module loads):

```bash
# In /etc/modprobe.d/nf_conntrack.conf
echo "options nf_conntrack hashsize=65536" > /etc/modprobe.d/nf_conntrack.conf

# After setting hashsize, nf_conntrack_max should be at least 4x hashsize
echo "131072" > /proc/sys/net/netfilter/nf_conntrack_max
```

## Sizing the Conntrack Table

### Calculating the Required Table Size

The conntrack table must be large enough to hold all concurrent connections plus headroom. For a Kubernetes node, the calculation involves:

```
nf_conntrack_max = (peak_concurrent_connections × safety_factor)

Where:
- peak_concurrent_connections = sum of all connection states across all pods
- safety_factor = 2.0-4.0 to handle bursts and TIME_WAIT accumulation
```

For a node running 100 pods each with up to 200 concurrent connections:

```
peak = 100 pods × 200 connections = 20,000
with 4x safety factor = 80,000
round up to next power of 2 = 131,072
```

### Memory Usage Calculation

Each conntrack entry uses approximately 300-400 bytes of kernel memory:

```bash
# Calculate memory usage
# nf_conntrack_max × ~400 bytes per entry
echo "Memory for 131072 entries: $((131072 * 400 / 1024 / 1024)) MB"
# Output: Memory for 131072 entries: 50 MB

# For 1048576 (1M) entries: ~400 MB
# This is acceptable on modern hardware with 64GB+ RAM
```

### Setting nf_conntrack_max

```bash
# Temporary change (survives until reboot)
sysctl -w net.netfilter.nf_conntrack_max=524288

# Permanent change via sysctl.conf
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
# Conntrack table sizing for high-traffic Kubernetes nodes
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_buckets = 131072

# Reduce TCP ESTABLISHED timeout for long-idle connections
net.netfilter.nf_conntrack_tcp_timeout_established = 1800

# Reduce TIME_WAIT timeout (default 120s is excessive)
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30

# Reduce CLOSE_WAIT timeout
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60

# UDP timeout (important for DNS and metrics)
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 120
EOF

sysctl -p /etc/sysctl.d/99-conntrack.conf
```

## Conntrack Timeout Configuration

Timeouts control how long an entry remains in the conntrack table after no packets have been seen. Misconfigured timeouts are a primary cause of table exhaustion.

### TCP State Timeouts

```bash
# View all TCP conntrack timeouts
sysctl -a | grep nf_conntrack_tcp

# Key timeouts:
# nf_conntrack_tcp_timeout_syn_sent = 120    # Waiting for SYN-ACK
# nf_conntrack_tcp_timeout_syn_recv = 60     # Waiting for ACK
# nf_conntrack_tcp_timeout_established = 432000  # 5 days! Default is excessive
# nf_conntrack_tcp_timeout_fin_wait = 120
# nf_conntrack_tcp_timeout_close_wait = 60
# nf_conntrack_tcp_timeout_last_ack = 30
# nf_conntrack_tcp_timeout_time_wait = 120
# nf_conntrack_tcp_timeout_close = 10
# nf_conntrack_tcp_timeout_unacknowledged = 300
```

The `nf_conntrack_tcp_timeout_established` default of 432000 seconds (5 days) is appropriate for long-lived NAT scenarios but excessive for Kubernetes nodes where pods are frequently replaced. Reducing this to 1800 seconds (30 minutes) significantly reduces table bloat from idle connections.

### UDP Timeout Configuration

UDP has no connection state, so conntrack must use a simple timeout:

```bash
# UDP stream (bidirectional traffic seen) timeout
sysctl net.netfilter.nf_conntrack_udp_timeout_stream
# Default: 180 seconds

# UDP single-packet timeout (e.g., DNS query with no response yet)
sysctl net.netfilter.nf_conntrack_udp_timeout
# Default: 30 seconds

# For high-volume DNS environments, the UDP stream timeout can cause
# table bloat from DNS resolver connections:
sysctl -w net.netfilter.nf_conntrack_udp_timeout_stream=60
```

### ICMP Timeout

```bash
# ICMP timeout (ping, traceroute)
sysctl net.netfilter.nf_conntrack_icmp_timeout
# Default: 30 seconds — reasonable for most environments
```

### Viewing Per-Protocol Timeout Statistics

```bash
# Count entries by protocol and state
conntrack -L 2>/dev/null | awk '{print $1, $3}' | sort | uniq -c | sort -rn

# Count entries approaching expiry (timeout < 30s)
conntrack -L 2>/dev/null | awk '$4 < 30 {count[$1]++} END {for (p in count) print count[p], p}' | sort -rn

# Find connections with the largest timeout remaining (long-lived entries)
conntrack -L 2>/dev/null | sort -t' ' -k4 -n -r | head -20
```

## NOTRACK Rules for Performance Optimization

Certain traffic does not benefit from connection tracking and creates unnecessary table entries. NOTRACK rules skip the conntrack processing for specified traffic, improving performance and reducing table pressure.

### Identifying Traffic to Exclude from Tracking

Traffic suitable for NOTRACK:
- Loopback traffic (already excluded by default in most configurations)
- Health check traffic from known sources
- Metrics scraping traffic
- High-volume internal RPC traffic that does not require NAT

### Implementing NOTRACK Rules with iptables

```bash
# Exclude health check traffic from conntrack
# Health checks come from the load balancer at 10.0.0.1 to port 8080
iptables -t raw -A PREROUTING -p tcp --dport 8080 -s 10.0.0.1 -j NOTRACK
iptables -t raw -A OUTPUT -p tcp --sport 8080 -d 10.0.0.1 -j NOTRACK

# Exclude Prometheus scraping traffic (scraper is in 10.1.0.0/24)
iptables -t raw -A PREROUTING -p tcp --dport 9090 -s 10.1.0.0/24 -j NOTRACK
iptables -t raw -A OUTPUT -p tcp --sport 9090 -d 10.1.0.0/24 -j NOTRACK

# Exclude all loopback traffic
iptables -t raw -A PREROUTING -i lo -j NOTRACK
iptables -t raw -A OUTPUT -o lo -j NOTRACK

# View the current raw table rules
iptables -t raw -L -n -v
```

### NOTRACK with nftables

nftables (the modern replacement for iptables) provides a cleaner NOTRACK syntax:

```nftables
table inet raw {
    chain prerouting {
        type filter hook prerouting priority raw; policy accept;

        # Exclude health check traffic
        ip saddr 10.0.0.1 tcp dport 8080 notrack

        # Exclude Prometheus scraping
        ip saddr 10.1.0.0/24 tcp dport 9090 notrack

        # Exclude loopback
        iif lo notrack
    }

    chain output {
        type filter hook output priority raw; policy accept;

        # Mirror of prerouting rules for outbound direction
        ip daddr 10.0.0.1 tcp sport 8080 notrack
        ip daddr 10.1.0.0/24 tcp sport 9090 notrack
        oif lo notrack
    }
}
```

Apply the nftables configuration:

```bash
# Save to file
cat > /etc/nftables-notrack.conf << 'EOF'
table inet raw {
    chain prerouting {
        type filter hook prerouting priority raw; policy accept;
        iif lo notrack
        ip saddr 10.1.0.0/24 tcp dport 9090 notrack
    }
    chain output {
        type filter hook output priority raw; policy accept;
        oif lo notrack
        ip daddr 10.1.0.0/24 tcp sport 9090 notrack
    }
}
EOF

nft -f /etc/nftables-notrack.conf
nft list table inet raw
```

## Conntrack in Kubernetes Environments

Kubernetes uses conntrack extensively for kube-proxy's service NAT rules. Understanding the interaction is critical for operating large clusters.

### How kube-proxy Uses Conntrack

When a pod connects to a Service ClusterIP, kube-proxy has installed iptables DNAT rules that translate the ClusterIP to a pod IP. Conntrack tracks this translation so that reply packets can be translated back from the pod IP to the ClusterIP.

Each active Service connection creates:
1. An ORIGINAL entry: ClusterIP:port → Pod:port
2. A REPLY entry: Pod:port → ClusterIP:port (automatically created)

This means each Service connection consumes two conntrack entries.

### Conntrack Entry Multiplication in Large Clusters

For a node with many pods each connecting to many services:

```bash
# Calculate expected conntrack usage
# Each pod-to-service connection = 2 conntrack entries (original + reply)
# Plus 1 entry for pod-to-pod direct traffic

PODS_PER_NODE=50
SERVICES_PER_POD=20
CONNECTIONS_PER_SERVICE=10
DIRECT_POD_CONNECTIONS=100

TOTAL=$((PODS_PER_NODE * SERVICES_PER_POD * CONNECTIONS_PER_SERVICE * 2 + DIRECT_POD_CONNECTIONS))
echo "Estimated conntrack entries per node: $TOTAL"
# Output: Estimated conntrack entries per node: 20100
```

### Kubernetes Node Sysctl Configuration

A recommended Kubernetes node sysctl configuration for a 50-pod node:

```bash
cat > /etc/sysctl.d/99-kubernetes-conntrack.conf << 'EOF'
# Conntrack table size - sized for 50 pods with room to spare
net.netfilter.nf_conntrack_max = 262144

# Bucket count = max/8 (optimal ratio)
# Cannot be set via sysctl after module load - set via modprobe.d
# net.netfilter.nf_conntrack_buckets = 32768

# Reduce TCP ESTABLISHED timeout from 5 days to 30 minutes
# Kubernetes pods are ephemeral; 5-day timeouts cause table bloat
net.netfilter.nf_conntrack_tcp_timeout_established = 1800

# TIME_WAIT: reduce from 120s to 30s
# High pod churn creates many TIME_WAIT entries
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30

# CLOSE_WAIT: reduce from 60s to 30s
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 30

# SYN_SENT: reduce from 120s to 30s (failed connections)
net.netfilter.nf_conntrack_tcp_timeout_syn_sent = 30

# UDP stream timeout: reduce from 180s to 60s
net.netfilter.nf_conntrack_udp_timeout_stream = 60

# UDP single-packet timeout: keep at 30s for DNS
net.netfilter.nf_conntrack_udp_timeout = 30

# Enable connection tracking statistics in /proc/net/stat/nf_conntrack
net.netfilter.nf_conntrack_count = 0  # This is read-only; set max instead

# Allow invalid packets through (prevents FIN scan false positives)
net.netfilter.nf_conntrack_tcp_loose = 0
EOF

sysctl -p /etc/sysctl.d/99-kubernetes-conntrack.conf
```

### Monitoring Conntrack Usage with kube-state-metrics

```bash
# Conntrack utilization as a percentage
# Monitor this metric — alert when it exceeds 80%
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Calculate utilization
COUNT=$(cat /proc/sys/net/netfilter/nf_conntrack_count)
MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max)
echo "Conntrack utilization: $(echo "scale=2; $COUNT * 100 / $MAX" | bc)%"
```

Prometheus alerting rule:

```yaml
groups:
  - name: conntrack
    rules:
      - alert: ConntrackTableNearlyFull
        expr: |
          (node_nf_conntrack_entries / node_nf_conntrack_entries_limit) > 0.80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Conntrack table {{ $value | humanizePercentage }} full on {{ $labels.instance }}"
          description: "nf_conntrack table is {{ $value | humanizePercentage }} full. Increase net.netfilter.nf_conntrack_max or reduce connection timeouts."

      - alert: ConntrackTableFull
        expr: |
          (node_nf_conntrack_entries / node_nf_conntrack_entries_limit) > 0.95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Conntrack table critically full on {{ $labels.instance }}"
          description: "nf_conntrack table is {{ $value | humanizePercentage }} full. Packet dropping is likely occurring."
```

## Debugging "nf_conntrack: table full" Errors

### Immediate Response

When the `nf_conntrack: table full, dropping packet` message appears in `/var/log/kern.log` or `dmesg`, immediate action is required:

```bash
# Step 1: Check current state
echo "Current count: $(cat /proc/sys/net/netfilter/nf_conntrack_count)"
echo "Maximum: $(cat /proc/sys/net/netfilter/nf_conntrack_max)"

# Step 2: Identify the biggest consumers
conntrack -L 2>/dev/null | awk '{print $1, $NF}' | grep -v "^$" | \
  sort | uniq -c | sort -rn | head -20

# Step 3: Immediately increase the limit (emergency mitigation)
sysctl -w net.netfilter.nf_conntrack_max=524288

# Step 4: Identify if there's a connection leak
# Look for an unusually large number of entries in a specific state
conntrack -L 2>/dev/null | awk '{print $3}' | sort | uniq -c | sort -rn
# If TIME_WAIT is dominant, a connection recycling issue exists
# If SYN_SENT is dominant, there's a failed connection flood

# Step 5: Check kernel log for context
dmesg -T | grep conntrack | tail -50
journalctl -k --since "1 hour ago" | grep conntrack
```

### Root Cause Analysis

```bash
# Analyze connection distribution by source/destination
conntrack -L 2>/dev/null | \
  awk '{for(i=1;i<=NF;i++) if($i~/^src=/) src=$i; if(src) print src}' | \
  sort | uniq -c | sort -rn | head -20

# Find pods with unusual connection counts
# Map conntrack source IPs to pod names
for ip in $(conntrack -L 2>/dev/null | grep -oP 'src=\K[0-9.]+' | sort -u); do
  pod=$(kubectl get pod --all-namespaces -o wide 2>/dev/null | awk -v ip="$ip" '$7==ip {print $1"/"$2}')
  count=$(conntrack -L 2>/dev/null | grep "src=$ip" | wc -l)
  if [ -n "$pod" ]; then
    echo "$count $pod ($ip)"
  fi
done | sort -rn | head -20

# Check for conntrack entries from expired pods (IP reuse)
# These indicate stale entries that haven't timed out yet
```

### Long-Term Resolution Strategies

```bash
# 1. Increase table size permanently
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
net.netfilter.nf_conntrack_max = 1048576
EOF

# 2. Reduce timeout aggressiveness for TCP
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
net.netfilter.nf_conntrack_tcp_timeout_established = 600
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 10
EOF

# 3. Add NOTRACK rules for high-volume but trackable traffic
# (see NOTRACK section above)

# 4. Consider switching from iptables to ipvs kube-proxy mode
# ipvs maintains its own state table and puts less pressure on conntrack
# Edit kube-proxy ConfigMap:
kubectl -n kube-system edit configmap kube-proxy
# Set: mode: "ipvs"
# After editing, restart kube-proxy:
kubectl -n kube-system rollout restart daemonset kube-proxy
```

## Conntrack Helper Modules

Conntrack helper modules enable tracking of protocols that embed IP addresses or port numbers in the payload (FTP, SIP, H.323, etc.). These modules inspect packet contents to create RELATED entries for the secondary connections these protocols use.

### Common Helper Modules

```bash
# List loaded conntrack helpers
lsmod | grep nf_conntrack

# Key helpers:
# nf_conntrack_ftp    - FTP PASV/PORT command tracking
# nf_conntrack_sip    - SIP signaling and media stream tracking
# nf_conntrack_h323   - H.323 video conferencing
# nf_conntrack_tftp   - TFTP transfers
# nf_conntrack_irc    - IRC DCC transfers
# nf_conntrack_amanda - Amanda backup protocol
```

### Security Implications of Helper Modules

Conntrack helpers have historically been a source of security vulnerabilities because they must parse complex protocol payloads. Unless the protocol is actively used, helpers should be disabled:

```bash
# Check which helpers are active
cat /proc/net/nf_conntrack_expect

# Disable unnecessary helpers
# In /etc/modprobe.d/disable-conntrack-helpers.conf
cat > /etc/modprobe.d/disable-conntrack-helpers.conf << 'EOF'
# Disable conntrack helpers not needed in this environment
install nf_conntrack_ftp /bin/false
install nf_conntrack_irc /bin/false
install nf_conntrack_sip /bin/false
install nf_conntrack_h323 /bin/false
install nf_conntrack_tftp /bin/false
install nf_conntrack_amanda /bin/false
EOF

# Apply immediately (unload if loaded)
modprobe -r nf_conntrack_ftp 2>/dev/null
modprobe -r nf_conntrack_sip 2>/dev/null
```

### Manual Helper Assignment

Since kernel 4.7, conntrack helpers are not automatically assigned. They must be explicitly configured to reduce the attack surface:

```bash
# Explicitly assign FTP helper only for connections to internal FTP server
iptables -t raw -A PREROUTING -p tcp --dport 21 -d 10.0.1.50 \
  -j CT --helper ftp

# View helper assignments
conntrack -L expect 2>/dev/null
```

## Conntrack Statistics and Performance Monitoring

```bash
# Per-CPU conntrack statistics
cat /proc/net/stat/nf_conntrack

# Column meanings:
# entries   - current entries in table
# searched  - hash table lookups
# found     - successful lookups
# new       - new connections established
# invalid   - invalid packets
# ignore    - ignored packets (NOTRACK)
# delete    - entries deleted (expired or explicit)
# delete_list - entries on delete list
# insert    - entries inserted
# insert_failed - failed insertions (table full!)
# drop      - dropped packets due to table full
# early_drop - entries evicted to make room (if enabled)
# error     - other errors
# search_restart - hash chain searches restarted due to resizing

# Monitor insert_failed and drop columns for table full events
watch -n 1 'cat /proc/net/stat/nf_conntrack | awk "NR==1{print} NR>1{sum+=\$9} END{print \"insert_failed:\",sum}"'
```

### Prometheus Node Exporter Metrics

node_exporter exposes conntrack metrics automatically:

```promql
# Current conntrack utilization
node_nf_conntrack_entries / node_nf_conntrack_entries_limit

# Rate of connection tracking errors (table full events)
rate(node_nf_conntrack_stat_drop[5m])

# Rate of new connections being tracked
rate(node_nf_conntrack_stat_new[5m])

# Invalid packet rate (potential attack indicator)
rate(node_nf_conntrack_stat_invalid[5m])
```

## Summary

Effective conntrack management requires attention to four areas:

1. **Sizing**: Calculate the required `nf_conntrack_max` based on actual peak connection counts, multiply by 2-4x for safety, and ensure `nf_conntrack_buckets` is set to max/8 via modprobe configuration

2. **Timeouts**: Reduce `nf_conntrack_tcp_timeout_established` from the 5-day default to 30 minutes for Kubernetes nodes; reduce `nf_conntrack_tcp_timeout_time_wait` to 30 seconds

3. **NOTRACK**: Exempt health check, metrics, and loopback traffic from conntrack processing to reduce table pressure

4. **Monitoring**: Alert at 80% utilization and track `insert_failed` and `drop` counters to detect table full events before they cause production impact

Switching kube-proxy to IPVS mode eliminates much of the conntrack pressure from Service traffic, as IPVS maintains its own kernel-level connection tracking that is more efficient for the Service NAT use case.
