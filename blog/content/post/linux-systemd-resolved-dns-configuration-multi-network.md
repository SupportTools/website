---
title: "Linux Systemd-Resolved: DNS Configuration for Multi-Network Environments"
date: 2031-05-07T00:00:00-05:00
draft: false
tags: ["Linux", "DNS", "systemd-resolved", "Networking", "Kubernetes", "CoreDNS", "Split-Horizon"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to systemd-resolved for multi-network DNS: per-link DNS, DNS-over-TLS, LLMNR, split-horizon routing domains, Kubernetes CoreDNS interaction, and debugging with resolvectl."
more_link: "yes"
url: "/linux-systemd-resolved-dns-configuration-multi-network/"
---

`systemd-resolved` is the default DNS resolver on modern Linux distributions (Ubuntu 18.04+, RHEL 9+, Fedora). It provides per-link DNS configuration, DNS-over-TLS, LLMNR/mDNS for local name resolution, and split-horizon DNS via routing domains. Understanding it is essential for operating Kubernetes nodes, VPN-connected servers, and multi-homed hosts. This guide covers production configuration patterns with emphasis on Kubernetes node DNS behavior.

<!--more-->

# Linux Systemd-Resolved: DNS Configuration for Multi-Network Environments

## Section 1: Architecture Overview

systemd-resolved runs as `systemd-resolved.service` and listens on:
- `127.0.0.53:53` - The stub resolver (full resolver with caching)
- `127.0.0.54:53` - DNS-only queries (no mDNS/LLMNR, used by nss-resolve)

`/etc/resolv.conf` should be a symlink to one of:
- `/run/systemd/resolve/stub-resolv.conf` - Points to 127.0.0.53 (recommended)
- `/run/systemd/resolve/resolv.conf` - Contains actual upstream DNS servers (for compatibility)
- `/etc/resolv.conf` - Manually managed (bypasses systemd-resolved)

```bash
# Check current resolv.conf symlink
ls -la /etc/resolv.conf

# Expected (recommended):
# /etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf

# Contents of stub-resolv.conf:
# nameserver 127.0.0.53
# options edns0 trust-ad

# Check systemd-resolved status
systemctl status systemd-resolved
resolvectl status
```

## Section 2: Global DNS Configuration

The global systemd-resolved configuration is in `/etc/systemd/resolved.conf`:

```ini
# /etc/systemd/resolved.conf
[Resolve]
# Global upstream DNS servers (used when per-link DNS is not configured)
# Separate multiple servers with spaces
DNS=1.1.1.1 1.0.0.1 2606:4700:4700::1111 2606:4700:4700::1001

# Fallback DNS (used when upstream DNS fails)
FallbackDNS=8.8.8.8 8.8.4.4 2001:4860:4860::8888 2001:4860:4860::8844

# Search domains (appended to single-label queries)
Domains=example.com corp.example.com

# DNSSEC validation
# Options: false, allow-downgrade, true
DNSSEC=allow-downgrade

# DNS-over-TLS
# Options: false, opportunistic (try TLS, fallback to plain), true (require TLS)
DNSOverTLS=opportunistic

# Cache negative results (prevent re-querying for NXDOMAIN)
Cache=yes

# Cache max negative TTL in seconds (default: 0 = use DNS TTL)
CacheMaxNegativeTTL=30

# LLMNR (Link-Local Multicast Name Resolution)
# Options: false, resolve (respond to queries), true (also announce)
LLMNR=resolve

# mDNS (Multicast DNS, .local domains)
# Options: false, resolve, true
MulticastDNS=resolve

# ReadEtcHosts - read /etc/hosts in addition to DNS
ReadEtcHosts=yes

# ResolveUnicastSingleLabel - resolve single-label names via DNS
# (not just mDNS/LLMNR)
ResolveUnicastSingleLabel=no

# StaleRetentionSec - How long to keep stale DNS cache entries
# when upstream DNS is unreachable (seconds, 0=disabled)
StaleRetentionSec=30
```

```bash
# Apply configuration changes
systemctl restart systemd-resolved

# Or reload without restart (for some config changes)
systemctl kill -s HUP systemd-resolved
```

## Section 3: Per-Link DNS Configuration with NetworkManager

The most powerful feature of systemd-resolved is per-network-interface DNS configuration:

```bash
# Configure DNS per connection with nmcli
nmcli connection modify "Corporate VPN" \
  ipv4.dns "10.100.1.53 10.100.2.53" \
  ipv4.dns-search "corp.example.com internal.example.com" \
  ipv4.dns-priority 10  # Lower number = higher priority
  # Negative priority (-1 to -2147483648) makes it routing-only (not for *.*)

# For split-horizon, use routing domain prefix ~
# Queries for .corp.example.com go to VPN DNS, all other queries use default
nmcli connection modify "Corporate VPN" \
  ipv4.dns-search "~corp.example.com ~internal.example.com"

# The ~ prefix means this is a routing domain:
# Queries matching this domain are sent to this interface's DNS
# Queries NOT matching go to other interfaces' DNS
```

### NetworkManager Keyfile Configuration

```ini
# /etc/NetworkManager/system-connections/corporate-vpn.nmconnection
[connection]
id=corporate-vpn
type=vpn
interface-name=tun0

[vpn]
service-type=org.freedesktop.NetworkManager.openvpn
# ... VPN settings

[ipv4]
method=auto
dns=10.100.1.53;10.100.2.53;
dns-search=~corp.example.com;~internal.example.com;
dns-priority=10
ignore-auto-dns=false
route-metric=100

[ipv6]
method=auto
dns-priority=10
```

## Section 4: Split-Horizon DNS with Routing Domains

Split-horizon DNS sends different DNS queries to different servers based on domain:

```bash
# Scenario:
# - Corporate DNS at 10.100.1.53 handles corp.example.com and internal.example.com
# - Public DNS at 1.1.1.1 handles everything else

# Corporate LAN connection
nmcli connection modify "Corporate LAN" \
  ipv4.dns "10.100.1.53 10.100.2.53" \
  ipv4.dns-search "~corp.example.com ~internal.example.com ~example.com" \
  ipv4.dns-priority 50

# Verify routing domain configuration
resolvectl domain

# Expected output:
# Global:
# Link 2 (eth0):    ~corp.example.com ~internal.example.com ~example.com
# Link 3 (eth1):    (empty)

# Test which DNS is used for a query
resolvectl query --interface=eth0 db.corp.example.com
resolvectl query --interface=eth0 google.com

# Verify DNS routing decisions
resolvectl service

# Check per-link status
resolvectl status eth0
```

### Global Catch-All Configuration

```bash
# Make a specific interface handle ALL DNS queries
# Use ~ as the routing domain (matches everything)
nmcli connection modify "Primary Connection" \
  ipv4.dns-search "~." \
  ipv4.dns-priority -1

# This makes eth0 handle all DNS queries EXCEPT those with
# more specific routing domains on other interfaces

# Verify:
resolvectl domain
# Link 2 (eth0): ~.  <- matches everything
# Link 3 (tun0): ~corp.example.com <- more specific, takes priority
```

## Section 5: DNS-over-TLS Configuration

```ini
# /etc/systemd/resolved.conf for strict DNS-over-TLS
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 1.0.0.1#cloudflare-dns.com
FallbackDNS=8.8.8.8#dns.google 8.8.4.4#dns.google

# Format: IP#hostname
# The hostname is used for TLS SNI verification
# Cloudflare: 1.1.1.1#cloudflare-dns.com
# Google: 8.8.8.8#dns.google
# Quad9: 9.9.9.9#dns.quad9.net

# Require TLS (refuse to send plaintext DNS)
DNSOverTLS=true

# With DNSSEC
DNSSEC=true
```

```bash
# Verify DoT is working
resolvectl statistics | grep -i tls

# Query with DoT
resolvectl query --protocol=dns example.com

# Check TCP port 853 connectivity
nc -zv 1.1.1.1 853
openssl s_client -connect 1.1.1.1:853 -servername cloudflare-dns.com </dev/null
```

## Section 6: Custom DNS for Specific Applications

Use `nsswitch.conf` and systemd-resolved to route application DNS:

```bash
# /etc/nsswitch.conf - DNS resolution order
# hosts: files mdns4_minimal [NOTFOUND=return] dns myhostname

# For systemd-resolved:
# hosts: mymachines resolve [!UNAVAIL=return] files mdns4_minimal [NOTFOUND=return] dns

# The order is:
# 1. mymachines - systemd-machined local containers
# 2. resolve - systemd-resolved stub
# 3. files - /etc/hosts
# 4. mdns4_minimal - mDNS for .local
# 5. dns - traditional /etc/resolv.conf (fallback)
```

Application-specific DNS via systemd service configuration:

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Application

[Service]
ExecStart=/usr/bin/myapp
Environment=RES_OPTIONS=ndots:2:timeout:5:attempts:3

# Use different DNS resolver for this service
# via network namespace with custom resolv.conf
PrivateNetwork=no

# Force specific DNS resolution
ExecStart=/bin/sh -c 'DNS_SERVERS="10.0.0.53" exec myapp'
```

## Section 7: LLMNR and mDNS Handling

```bash
# Check LLMNR status per interface
resolvectl status eth0 | grep LLMNR

# Disable LLMNR globally (reduces multicast traffic)
# In /etc/systemd/resolved.conf:
# LLMNR=false

# Disable mDNS (if not using Avahi/Bonjour)
# MulticastDNS=false

# For Kubernetes nodes, disable both to reduce noise:
cat > /etc/systemd/resolved.conf.d/k8s-node.conf << 'EOF'
[Resolve]
LLMNR=false
MulticastDNS=false
EOF

systemctl restart systemd-resolved

# Test .local resolution (mDNS)
avahi-resolve --name myprinter.local

# If mDNS is disabled, .local goes to DNS:
resolvectl query myprinter.local
# Returns NXDOMAIN if not in DNS
```

## Section 8: Kubernetes Node DNS Configuration

Kubernetes nodes require specific DNS configuration to work correctly with CoreDNS:

### The Kubernetes DNS Stack

```
Pod
 │
 │ DNS query (nameserver: 10.96.0.10)
 ▼
CoreDNS Service (10.96.0.10:53)
 │
 ├── .cluster.local queries → handled internally by CoreDNS
 └── External queries → forwarded to Node's DNS resolver
                         │
                         ▼
                   systemd-resolved (127.0.0.53)
                         │
                         ▼
                   Upstream DNS (1.1.1.1, etc.)
```

### Node resolv.conf Configuration

```bash
# Verify /etc/resolv.conf points to stub resolver
ls -la /etc/resolv.conf
# Should be: /etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf

# If not, fix it:
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf

# Verify the contents (what kubelet reads for node DNS):
cat /etc/resolv.conf
# nameserver 127.0.0.53
# options edns0 trust-ad
```

### kubelet DNS Configuration

```yaml
# kubelet-config.yaml (kubeadm config)
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
clusterDNS:
  - "10.96.0.10"           # CoreDNS service ClusterIP
clusterDomain: cluster.local
resolvConf: /run/systemd/resolve/resolv.conf  # Use actual upstream DNS, not stub
# IMPORTANT: Use /run/systemd/resolve/resolv.conf (actual upstream DNS)
# NOT /run/systemd/resolve/stub-resolv.conf (127.0.0.53)
# because containers cannot reach 127.0.0.53 from the host's loopback
```

```bash
# Check what kubelet is configured to use
cat /var/lib/kubelet/config.yaml | grep -E "clusterDNS|resolvConf|clusterDomain"

# Verify CoreDNS can resolve upstream
kubectl run dns-test --image=busybox --restart=Never --rm -it -- \
  nslookup google.com

# Check CoreDNS Corefile for forwarding configuration
kubectl get configmap coredns -n kube-system -o yaml

# CoreDNS Corefile:
# .:53 {
#     errors
#     health {
#        lameduck 5s
#     }
#     ready
#     kubernetes cluster.local in-addr.arpa ip6.arpa {
#        pods insecure
#        fallthrough in-addr.arpa ip6.arpa
#        ttl 30
#     }
#     prometheus :9153
#     forward . /etc/resolv.conf {  <-- Uses node's resolv.conf
#        max_concurrent 1000
#     }
#     cache 30
#     loop
#     reload
#     loadbalance
# }
```

### Node-Local DNS Cache (NodeLocalDNS)

For high-query-rate clusters, deploy NodeLocalDNS to cache DNS at each node:

```bash
# NodeLocalDNS runs as a DaemonSet and intercepts DNS queries before CoreDNS
# It caches responses locally, reducing CoreDNS load

# Download and deploy NodeLocalDNS
NODE_LOCAL_DNS_VERSION="1.23.0"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/kubernetes/v1.29.0/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml

# Verify DaemonSet is running
kubectl get daemonset -n kube-system nodelocaldns
```

## Section 9: Troubleshooting DNS Issues

### resolvectl Diagnostic Commands

```bash
# Check overall status
resolvectl status

# Full detailed status for all links
resolvectl status --no-pager

# Check specific interface
resolvectl status eth0

# Query a specific hostname (with detailed output)
resolvectl query --legend=yes example.com
resolvectl query --legend=yes --type=A example.com
resolvectl query --legend=yes --type=AAAA example.com
resolvectl query --legend=yes --type=MX example.com
resolvectl query --legend=yes --type=TXT example.com

# Query via specific interface
resolvectl query --interface=eth0 corp.example.com

# Query via specific DNS server
resolvectl query --dns-server=8.8.8.8 example.com

# Check statistics (cache hits, etc.)
resolvectl statistics

# Flush DNS cache
resolvectl flush-caches

# Show DNS search domains and routing domains
resolvectl domain

# Check DNS service discovery
resolvectl service --legend=yes

# Show DNSSEC status
resolvectl dnssec

# Monitor DNS queries in real-time
resolvectl monitor
```

### Common Issues and Solutions

```bash
# Issue 1: DNS not resolving after VPN connects
# Cause: Routing domains not configured for VPN
resolvectl domain
# Solution: Set routing domains on VPN interface
nmcli connection modify "Corporate VPN" \
  ipv4.dns-search "~corp.example.com"

# Issue 2: systemd-resolved not used (old /etc/resolv.conf)
ls -la /etc/resolv.conf
# If it shows a real file, not a symlink:
cat /etc/resolv.conf
# Fix:
cp /etc/resolv.conf /etc/resolv.conf.backup
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
systemctl restart systemd-resolved

# Issue 3: DNS queries slow (DoT timeout)
# Check if DNS-over-TLS is timing out
journalctl -u systemd-resolved --since "5 min ago" | grep -i tls
# Disable DoT if upstream doesn't support it:
sed -i 's/DNSOverTLS=.*/DNSOverTLS=no/' /etc/systemd/resolved.conf
systemctl restart systemd-resolved

# Issue 4: NXDOMAIN for internal hosts
# Check if search domains are configured
resolvectl domain
# Check if correct DNS server is being used
resolvectl query --legend=yes internal-host

# Issue 5: Multiple DNS servers with inconsistent results
# Check which DNS was used for a query
resolvectl query --legend=yes example.com | grep "Server"

# Issue 6: DNS loop (stub resolver -> systemd-resolved -> stub)
# This happens when /etc/resolv.conf points to 127.0.0.53 and
# CoreDNS is configured to forward to the node's resolv.conf
cat /run/systemd/resolve/resolv.conf  # Should show real upstream DNS
# If this shows 127.0.0.53, there's a loop
# Fix: Configure DNS in systemd-resolved.conf directly
```

### Debug Mode

```bash
# Enable detailed logging
systemctl edit systemd-resolved
# Add:
# [Service]
# Environment=SYSTEMD_LOG_LEVEL=debug

systemctl restart systemd-resolved

# Watch logs
journalctl -u systemd-resolved -f

# Filter for specific queries
journalctl -u systemd-resolved -f | grep "example.com"

# Packet capture for DNS traffic
tcpdump -i eth0 -nn -v port 53 2>/dev/null
tcpdump -i any -nn -v port 53 and host 127.0.0.53 2>/dev/null
```

## Section 10: DNS-Over-TLS with Self-Signed Certificates (Internal CA)

For corporate environments using an internal CA:

```bash
# Configure DoT to internal DNS server with self-signed cert
# /etc/systemd/resolved.conf
# DNS=10.100.1.53#dns.corp.example.com
# DNSOverTLS=true

# The hostname after # is used for TLS SNI and certificate verification
# If using self-signed cert, need to add CA to system trust

# Install internal CA certificate
cp /path/to/internal-ca.crt /usr/local/share/ca-certificates/internal-ca.crt
update-ca-certificates  # Ubuntu/Debian
update-ca-trust         # RHEL/Rocky

# Verify TLS connection to internal DNS
openssl s_client \
  -connect dns.corp.example.com:853 \
  -servername dns.corp.example.com \
  -CAfile /path/to/internal-ca.crt \
  </dev/null 2>&1 | grep -E "Verify|Cert"
```

## Section 11: Automated Node Configuration with Cloud-Init

For Kubernetes worker nodes provisioned with cloud-init:

```yaml
# cloud-init user-data for DNS configuration
#cloud-config
write_files:
  - path: /etc/systemd/resolved.conf
    content: |
      [Resolve]
      DNS=10.0.0.53 10.0.0.54
      FallbackDNS=1.1.1.1 8.8.8.8
      Domains=cluster.internal example.com
      DNSSEC=allow-downgrade
      DNSOverTLS=opportunistic
      LLMNR=false
      MulticastDNS=false
      Cache=yes
      CacheMaxNegativeTTL=30
      StaleRetentionSec=60

  - path: /etc/systemd/resolved.conf.d/kubernetes.conf
    content: |
      [Resolve]
      # Kubernetes CoreDNS will handle cluster.local
      # systemd-resolved handles all other queries
      ResolveUnicastSingleLabel=no

runcmd:
  # Ensure stub resolver is used
  - ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
  - systemctl restart systemd-resolved
  # Verify
  - resolvectl status
  - resolvectl query example.com
```

## Section 12: Monitoring DNS Health

```bash
# Prometheus metrics via systemd-resolved
# systemd-resolved exposes metrics via DBus, not directly via Prometheus
# Use node_exporter with a custom script:

cat > /usr/local/bin/collect-dns-metrics.sh << 'SCRIPT'
#!/bin/bash
# Collect systemd-resolved statistics for node_exporter

OUTPUT_FILE="/var/lib/node_exporter/textfile_collector/dns_resolved.prom"

# Get statistics via resolvectl
STATS=$(resolvectl statistics 2>/dev/null)

cache_hits=$(echo "$STATS" | awk '/Current Cache Size/{print $NF}')
transactions=$(echo "$STATS" | awk '/Total Transactions/{print $NF}')
cache_size=$(echo "$STATS" | awk '/Current Cache Size/{print $NF}')
dnssec_success=$(echo "$STATS" | awk '/DNSSEC Verified/{print $NF}')
dnssec_failed=$(echo "$STATS" | awk '/DNSSEC Failed/{print $NF}')

cat > "${OUTPUT_FILE}.tmp" << EOF
# HELP systemd_resolved_cache_size Current DNS cache size
# TYPE systemd_resolved_cache_size gauge
systemd_resolved_cache_size ${cache_size:-0}

# HELP systemd_resolved_transactions_total Total DNS transactions
# TYPE systemd_resolved_transactions_total counter
systemd_resolved_transactions_total ${transactions:-0}

# HELP systemd_resolved_dnssec_verified_total DNSSEC verified queries
# TYPE systemd_resolved_dnssec_verified_total counter
systemd_resolved_dnssec_verified_total ${dnssec_success:-0}

# HELP systemd_resolved_dnssec_failed_total DNSSEC failed queries
# TYPE systemd_resolved_dnssec_failed_total counter
systemd_resolved_dnssec_failed_total ${dnssec_failed:-0}
EOF

mv "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
SCRIPT

chmod +x /usr/local/bin/collect-dns-metrics.sh

# Run every minute
echo "* * * * * root /usr/local/bin/collect-dns-metrics.sh" > /etc/cron.d/dns-metrics
```

Prometheus alerts for DNS:

```yaml
# dns-alerts.yaml
groups:
  - name: dns
    rules:
      - alert: SystemdResolvedDown
        expr: up{job="node"} == 1 unless on(instance) systemd_unit_state{name="systemd-resolved.service",state="active"} == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "systemd-resolved is not running on {{ $labels.instance }}"

      - alert: DNSResolutionFailing
        expr: |
          rate(node_dns_responses_total{rcode="SERVFAIL"}[5m]) > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "DNS SERVFAIL responses on {{ $labels.instance }}"
```

## Summary

systemd-resolved provides production-grade DNS management for modern Linux systems through:

1. **Stub resolver** on 127.0.0.53 with caching reduces upstream DNS load
2. **Per-link DNS** enables different DNS servers for different networks (VPN, corporate, cloud)
3. **Routing domains** with `~` prefix implement split-horizon DNS without overlapping configuration
4. **DNS-over-TLS** with `#hostname` notation for verified server identity
5. **LLMNR/mDNS disable** for Kubernetes nodes reduces multicast noise on pod networks
6. **`/run/systemd/resolve/resolv.conf`** for kubelet's `resolvConf` provides upstream DNS without the stub loop issue
7. **`resolvectl`** CLI provides comprehensive debugging and monitoring

The most critical configuration for Kubernetes nodes: set kubelet's `resolvConf` to `/run/systemd/resolve/resolv.conf` (not `stub-resolv.conf`) to prevent the CoreDNS -> stub resolver -> stub loop that causes DNS failures when CoreDNS restarts.
