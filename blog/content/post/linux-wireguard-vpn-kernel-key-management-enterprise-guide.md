---
title: "Linux WireGuard VPN: Kernel Module Setup, Key Management, Peer Configuration, Roaming, Split Tunneling, and DNS Leak Prevention"
date: 2032-02-18T00:00:00-05:00
draft: false
tags: ["Linux", "WireGuard", "VPN", "Networking", "Security", "Kernel"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to WireGuard VPN covering kernel module installation, key pair management, server and client configuration, roaming clients, split tunneling by CIDR, and complete DNS leak prevention strategies."
more_link: "yes"
url: "/linux-wireguard-vpn-kernel-key-management-enterprise-guide/"
---

WireGuard is a modern, minimal VPN protocol implemented directly in the Linux kernel (as of 5.6). It replaces OpenVPN and IPsec in many enterprise environments due to its simplicity, performance, and cryptographic clarity. This guide covers the full operational picture: kernel module management, key lifecycle, server and multi-peer client configuration, handling roaming clients, split tunneling to route only specific subnets, and techniques to prevent DNS leaks on Linux workstations.

<!--more-->

# Linux WireGuard VPN: Enterprise Operations Guide

## Section 1: WireGuard Fundamentals

WireGuard operates at Layer 3 (IP), tunneling packets over UDP. Every peer has an asymmetric keypair. The public key is the peer's identity. There are no certificates, CAs, or negotiation phases — a connection is established the moment a valid packet from a known peer arrives.

Key properties:
- **Cryptography**: Curve25519 (ECDH), ChaCha20, Poly1305, BLAKE2s, SipHash24
- **Transport**: UDP only (stateless, connectionless at the network layer)
- **Roaming**: a peer's endpoint is updated automatically when it sends from a new IP/port
- **Firewall-friendly**: uses a single configurable UDP port
- **MTU**: WireGuard adds 60 bytes of overhead (IPv4) or 80 bytes (IPv6) to each packet

## Section 2: Kernel Module and Tooling Installation

### Check Kernel Version

```bash
uname -r
# WireGuard is built into Linux kernel >= 5.6
# For older kernels, install the out-of-tree module

# Check if wireguard module is available
modinfo wireguard
# Module loaded?
lsmod | grep wireguard
```

### Installation by Distribution

```bash
# Ubuntu 20.04+ / Debian Bullseye+
apt-get update
apt-get install wireguard wireguard-tools

# RHEL 8 / CentOS Stream 8
dnf install wireguard-tools

# RHEL 9 / Fedora 33+
dnf install wireguard-tools
# wireguard module included in kernel, no DKMS needed

# Alpine Linux
apk add wireguard-tools

# Arch Linux
pacman -S wireguard-tools

# Verify userspace tool
wg --version
wg-quick --version
```

### For Older Kernels (< 5.6): DKMS Module

```bash
# Ubuntu 18.04 LTS example
add-apt-repository ppa:wireguard/wireguard
apt-get update
apt-get install wireguard-dkms wireguard-tools

# Build the DKMS module against current kernel headers
apt-get install linux-headers-$(uname -r)
dkms status wireguard

# Verify
modprobe wireguard
lsmod | grep wireguard
```

### Load and Persist the Module

```bash
# Load immediately
modprobe wireguard

# Persist across reboots
echo "wireguard" > /etc/modules-load.d/wireguard.conf

# Verify
cat /sys/module/wireguard/version
```

## Section 3: Key Management

WireGuard uses 256-bit Curve25519 keypairs. Key generation is done with `wg genkey` and `wg pubkey`.

### Generating Keypairs

```bash
# Generate a private key
wg genkey > private.key

# Derive the public key
wg pubkey < private.key > public.key

# One-liner: private and public in one command
wg genkey | tee private.key | wg pubkey > public.key

# Generate a preshared key (optional; adds 256-bit symmetric layer)
wg genpsk > preshared.key

# View keys
cat private.key   # 44-character base64 string
cat public.key    # 44-character base64 string
```

### Key Storage and Permissions

```bash
# Store keys with strict permissions
install -d -m 700 /etc/wireguard
install -m 600 /dev/null /etc/wireguard/server_private.key
wg genkey > /etc/wireguard/server_private.key

# Derive public key from stored private
wg pubkey < /etc/wireguard/server_private.key > /etc/wireguard/server_public.key

# Verify permissions
ls -la /etc/wireguard/
# -rw------- root root server_private.key
# -rw-r--r-- root root server_public.key
```

### Key Rotation

```bash
#!/bin/bash
# /usr/local/bin/wg-rotate-key.sh
# Rotates the server private key and updates all peers' configs

set -euo pipefail
WG_IF="${1:-wg0}"
WG_CONFIG="/etc/wireguard/${WG_IF}.conf"
BACKUP="${WG_CONFIG}.$(date +%Y%m%d%H%M%S).bak"

# Backup current config
cp "${WG_CONFIG}" "${BACKUP}"
echo "Backup: ${BACKUP}"

# Generate new keypair
NEW_PRIVATE=$(wg genkey)
NEW_PUBLIC=$(echo "${NEW_PRIVATE}" | wg pubkey)

# Update config (replace PrivateKey line)
sed -i "s|^PrivateKey = .*|PrivateKey = ${NEW_PRIVATE}|" "${WG_CONFIG}"

echo "New public key: ${NEW_PUBLIC}"
echo "Update all peers with the new server public key."
echo "Reload: systemctl reload wg-quick@${WG_IF}"
```

## Section 4: Server Configuration

### Single-Server, Multiple-Client Setup

```bash
# /etc/wireguard/wg0.conf (server)

[Interface]
# Server's private key
PrivateKey = <server-private-key>

# IP address of the server on the WireGuard network
Address = 10.100.0.1/24

# Port WireGuard listens on
ListenPort = 51820

# Enable IP forwarding and NAT when tunnel interface comes up
PostUp = sysctl -w net.ipv4.ip_forward=1
PostUp = iptables -A FORWARD -i %i -j ACCEPT
PostUp = iptables -A FORWARD -o %i -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT
PostDown = iptables -D FORWARD -o %i -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Client: Alice
[Peer]
PublicKey = <alice-public-key>
PresharedKey = <alice-preshared-key>
# Only this IP is allowed from Alice
AllowedIPs = 10.100.0.2/32
PersistentKeepalive = 25

# Client: Bob
[Peer]
PublicKey = <bob-public-key>
PresharedKey = <bob-preshared-key>
AllowedIPs = 10.100.0.3/32
PersistentKeepalive = 25

# Site-to-site: Branch office subnet
[Peer]
PublicKey = <branch-public-key>
Endpoint = branch-vpn.example.com:51820
# Route the branch office subnet through this peer
AllowedIPs = 10.100.0.4/32, 192.168.50.0/24
PersistentKeepalive = 25
```

### Enable and Start the Interface

```bash
# Bring up the interface
wg-quick up wg0

# Enable at boot
systemctl enable --now wg-quick@wg0

# Check status
wg show wg0
ip addr show wg0
ip route show

# Verify peers
wg show wg0 peers
wg show wg0 latest-handshakes
```

### Persistent IP Forwarding

```bash
# Ensure IP forwarding persists across reboots
cat >> /etc/sysctl.d/99-wireguard.conf << 'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.core.rmem_max = 2500000
net.core.wmem_max = 2500000
EOF

sysctl -p /etc/sysctl.d/99-wireguard.conf
```

## Section 5: Client Configuration

### Full Tunnel Client (Route All Traffic)

```bash
# /etc/wireguard/wg0.conf (client — full tunnel)

[Interface]
PrivateKey = <client-private-key>
Address = 10.100.0.2/32
# DNS servers inside the tunnel (prevents DNS leaks)
DNS = 10.100.0.1

[Peer]
PublicKey = <server-public-key>
PresharedKey = <client-preshared-key>
# The server's public IP and port
Endpoint = vpn.example.com:51820
# 0.0.0.0/0 routes ALL traffic through the tunnel
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
```

### Configuring the Client

```bash
wg-quick up wg0
wg show wg0

# Verify routing
ip route show
# Should show: default dev wg0  (or 0.0.0.0/1 and 128.0.0.0/1 covering all IPv4)
# WireGuard uses two /1 routes instead of a default route to avoid overriding
# the actual default route to the server

# Test connectivity
curl -s https://ifconfig.me   # Should show server's public IP
```

## Section 6: Split Tunneling

Split tunneling routes only specific subnets through the VPN, leaving other traffic on the local internet path. This is configured by setting `AllowedIPs` to specific CIDRs instead of `0.0.0.0/0`.

### Route Only Corporate Subnets

```bash
# /etc/wireguard/wg0.conf (client — split tunnel)

[Interface]
PrivateKey = <client-private-key>
Address = 10.100.0.2/32
# No DNS line — use local DNS for public internet

[Peer]
PublicKey = <server-public-key>
Endpoint = vpn.example.com:51820
# Only route corporate subnets through the tunnel
AllowedIPs = 10.100.0.0/24, 192.168.10.0/24, 172.16.0.0/12, 10.0.0.0/8
PersistentKeepalive = 25
```

### Computing AllowedIPs for Exclusion (Inverted Split Tunnel)

The `AllowedIPs` field is an allowlist: only packets destined for IPs in this list are sent through the tunnel. To route everything EXCEPT specific subnets (e.g., exclude a cloud provider's IP ranges), compute the complement:

```bash
# Install the wg-allowed-ips calculator
pip3 install allowed-ips

# Exclude specific IPs from the full-tunnel config
# Example: exclude 203.0.113.0/24 (example documentation IP)
python3 -c "
from ipaddress import ip_network, collapse_addresses

all_ipv4 = ip_network('0.0.0.0/0')
excluded = [
    ip_network('10.100.0.0/24'),   # WireGuard server subnet
    ip_network('192.168.1.0/24'),  # local LAN
]

from ipaddress import summarize_address_range
import ipaddress

# Use Python to compute complement
excluded_set = set()
for n in excluded:
    for host in n:
        excluded_set.add(int(host))

# This is complex; use the wg-allowed-ips tool instead:
"

# Simpler: use wg-allowed-ips CLI tool
# https://github.com/chuangbo/wireguard-allowed-ips-calculator
wg-allowed-ips 0.0.0.0/0 - 192.168.1.0/24 - 10.100.0.0/24
# Output: list of CIDRs covering all IPv4 except the excluded subnets
```

### Dynamic Split Tunnel with Policy Routing

For more complex routing (route specific users through VPN, others directly), use policy routing:

```bash
# Create routing table 100 for VPN traffic
echo "100 vpn" >> /etc/iproute2/rt_tables

# Add route to corporate subnets via VPN in table 100
ip route add 192.168.10.0/24 dev wg0 table 100
ip route add 10.0.0.0/8 dev wg0 table 100

# Add rule: traffic from specific source subnet uses vpn table
ip rule add from 10.200.0.0/24 table vpn priority 100

# Default route for vpn table (for hosts that should have full VPN)
ip route add default dev wg0 table 100
```

## Section 7: Roaming Clients

WireGuard handles roaming natively. When a client sends a packet from a new IP/port, the server updates its endpoint record automatically. The client just needs `PersistentKeepalive` to keep the session alive through NAT.

### Server Side: Accept Roaming Clients

```bash
# Server config: do NOT set Endpoint for roaming clients
# WireGuard automatically learns the endpoint from the first authenticated packet
[Peer]
PublicKey = <mobile-client-public-key>
AllowedIPs = 10.100.0.5/32
# PersistentKeepalive is optional on server for roaming clients
# The client handles keepalives
```

### Client Side: Enable Keepalive

```bash
# Client config with keepalive for roaming
[Peer]
PublicKey = <server-public-key>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
# Send keepalive every 25 seconds to maintain NAT mapping
# Especially important for mobile clients behind carrier NAT
PersistentKeepalive = 25
```

### Monitoring Roaming

```bash
# Check current endpoint of a roaming peer
wg show wg0 endpoints
# Output: <public-key>   203.0.113.45:51234
# The port 51234 is the client's NAT-translated port

# Track endpoint changes over time
watch -n 5 "wg show wg0 endpoints"

# Last handshake time (0 = never or expired)
wg show wg0 latest-handshakes
# Recent handshake (< 3 minutes) = peer is connected
# Old handshake (> 3 minutes) = peer may have roamed or disconnected
```

## Section 8: DNS Leak Prevention

DNS leaks occur when DNS queries bypass the VPN tunnel and are sent to the ISP's resolver instead of the corporate DNS. This is a critical security and privacy concern.

### Understanding DNS in WireGuard

The `DNS` directive in `[Interface]` sets DNS using `resolvconf` or `systemd-resolved` on Linux. However, system DNS configuration can be complex — multiple resolvers, split-horizon DNS, and `systemd-resolved` stub resolver all interact.

### Method 1: systemd-resolved Integration

```bash
# /etc/wireguard/wg0.conf
[Interface]
PrivateKey = <client-private-key>
Address = 10.100.0.2/32
# Primary DNS inside tunnel; fallback DNS also inside tunnel
DNS = 10.100.0.1, 10.100.0.2
# Only resolve these domains via VPN DNS (split-horizon)
# PostUp handles the systemd-resolved integration
PostUp = resolvectl dns %i 10.100.0.1 10.100.0.2
PostUp = resolvectl domain %i ~corp.example.com ~.   # ~. = all domains via this interface
PostUp = resolvectl default-route %i yes
PostDown = resolvectl dns %i
PostDown = resolvectl domain %i

[Peer]
PublicKey = <server-public-key>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

```bash
# Verify DNS routing after connecting
resolvectl status wg0
# Should show:
#   DNS Servers: 10.100.0.1 10.100.0.2
#   DNS Domain: corp.example.com .  (routed through wg0)

# Test: does the DNS query go through the tunnel?
resolvectl query internal-service.corp.example.com
```

### Method 2: Direct /etc/resolv.conf Management (Simpler)

```bash
# Backup original resolv.conf
PostUp = cp /etc/resolv.conf /etc/resolv.conf.wg0.bak
# Set VPN DNS
PostUp = echo "nameserver 10.100.0.1\nnameserver 10.100.0.2\nsearch corp.example.com" > /etc/resolv.conf
# Restore on down
PostDown = cp /etc/resolv.conf.wg0.bak /etc/resolv.conf && rm /etc/resolv.conf.wg0.bak
```

### Method 3: iptables DNS Leak Prevention (Aggressive)

When DNS leaks must be completely prevented, use iptables to block all DNS traffic NOT going through the VPN:

```bash
# Block DNS queries that don't go through wg0
PostUp = iptables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT
PostUp = ip6tables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT
PostDown = iptables -D OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT
PostDown = ip6tables -D OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT

# Or: block UDP/53 specifically outside the tunnel
PostUp = iptables -A OUTPUT -p udp --dport 53 ! -o %i -j DROP
PostUp = iptables -A OUTPUT -p tcp --dport 53 ! -o %i -j DROP
PostDown = iptables -D OUTPUT -p udp --dport 53 ! -o %i -j DROP
PostDown = iptables -D OUTPUT -p tcp --dport 53 ! -o %i -j DROP
```

### DNS Leak Testing

```bash
# Basic test: query DNS via specific interface
dig @10.100.0.1 whoami.example.com +short

# Test for leaks using dnsleaktest.com
curl -s https://bash.dnsleaktest.com | bash

# Check what resolver is being used
systemd-resolve --status | grep "Current DNS Server"
cat /etc/resolv.conf

# tcpdump to verify DNS goes through tunnel
tcpdump -i wg0 -n 'port 53'   # should see DNS traffic here
tcpdump -i eth0 -n 'port 53'  # should NOT see DNS traffic here when VPN is active
```

## Section 9: Multi-Server High Availability

For enterprise deployments, run multiple WireGuard servers behind a load balancer or use DNS-based failover.

### Active-Passive with Floating IP

```bash
# Use keepalived to float the VPN server IP between two hosts
# /etc/keepalived/keepalived.conf (on primary)
vrrp_instance VPN_VIP {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    authentication {
        auth_type PASS
        auth_pass <keepalived-password>
    }
    virtual_ipaddress {
        203.0.113.10/32
    }
    notify_master "/usr/local/bin/wg-take-over.sh"
    notify_backup "/usr/local/bin/wg-give-up.sh"
}
```

### Client DNS-Based Failover

```bash
# Use multiple Endpoint entries via PostUp DNS overrides
# Or configure the client to try multiple servers:

# /etc/wireguard/wg0.conf
[Interface]
PrivateKey = <client-private-key>
Address = 10.100.0.5/32
# Use custom script to pick server
PostUp = /usr/local/bin/wg-select-server.sh wg0

[Peer]
# Server 1
PublicKey = <server1-public-key>
Endpoint = vpn1.example.com:51820
AllowedIPs = 10.100.0.0/24
PersistentKeepalive = 25
```

```bash
#!/bin/bash
# /usr/local/bin/wg-select-server.sh
# Pings each server and connects to the fastest responding one
WG_IF="${1:-wg0}"
SERVERS=(
    "vpn1.example.com:51820"
    "vpn2.example.com:51820"
    "vpn3.example.com:51820"
)

best_server=""
best_rtt=9999

for server in "${SERVERS[@]}"; do
    host="${server%%:*}"
    rtt=$(ping -c 3 -W 1 "${host}" 2>/dev/null | \
        grep "avg" | \
        awk -F'/' '{print $5}' | \
        cut -d'.' -f1)
    if [[ -n "${rtt}" && "${rtt}" -lt "${best_rtt}" ]]; then
        best_rtt="${rtt}"
        best_server="${server}"
    fi
done

if [[ -n "${best_server}" ]]; then
    echo "Selected server: ${best_server} (RTT: ${best_rtt}ms)"
    wg set "${WG_IF}" peer "$(wg show "${WG_IF}" peers)" endpoint "${best_server}"
fi
```

## Section 10: wg-quick vs systemd-networkd vs NetworkManager

### wg-quick (Simplest)

`wg-quick` is the standard tool. It manages the interface lifecycle, routes, and DNS.

```bash
wg-quick up wg0      # bring up, apply PostUp
wg-quick down wg0    # bring down, apply PostDown
systemctl enable wg-quick@wg0
```

### systemd-networkd (Native Integration)

```ini
# /etc/systemd/network/wg0.netdev
[NetDev]
Name=wg0
Kind=wireguard
Description=WireGuard VPN

[WireGuard]
PrivateKey=<private-key>
ListenPort=51820

[WireGuardPeer]
PublicKey=<peer-public-key>
PresharedKey=<preshared-key>
AllowedIPs=10.100.0.0/24
Endpoint=vpn.example.com:51820
PersistentKeepalive=25
```

```ini
# /etc/systemd/network/wg0.network
[Match]
Name=wg0

[Network]
Address=10.100.0.2/32
DNS=10.100.0.1
Domains=~corp.example.com

[Route]
Destination=0.0.0.0/0
Scope=global
```

```bash
systemctl restart systemd-networkd
networkctl status wg0
```

### NetworkManager (Desktop / GUI)

```bash
# Install NetworkManager WireGuard plugin
apt-get install network-manager-wireguard-gnome   # Ubuntu
dnf install NetworkManager-wireguard              # Fedora

# Import from wg-quick config
nmcli connection import type wireguard file /etc/wireguard/wg0.conf

# Verify
nmcli connection show wg0
nmcli connection up wg0
```

## Section 11: Performance Tuning

```bash
# Increase socket buffer sizes for high-throughput WireGuard
cat >> /etc/sysctl.d/99-wireguard-perf.conf << 'EOF'
# Increase UDP receive/send buffer for WireGuard
net.core.rmem_default = 1048576
net.core.rmem_max = 26214400
net.core.wmem_default = 1048576
net.core.wmem_max = 26214400
net.core.netdev_max_backlog = 50000

# Disable UDP checksum offload if getting packet drops
# (hardware-specific, test with and without)
EOF

sysctl -p /etc/sysctl.d/99-wireguard-perf.conf

# Benchmark throughput
iperf3 -s &                          # on remote side
iperf3 -c 10.100.0.1 -t 30          # on client side

# Check WireGuard statistics
cat /proc/net/dev | grep wg0
ip -s link show wg0
```

### MTU Tuning

```bash
# WireGuard overhead:
# IPv4 UDP: 20 (IP) + 8 (UDP) + 32 (WireGuard header) = 60 bytes
# IPv6 UDP: 40 (IP) + 8 (UDP) + 32 (WireGuard header) = 80 bytes

# If outer MTU is 1500 (standard Ethernet):
# WireGuard MTU = 1500 - 60 = 1440 (IPv4 transport)
# WireGuard MTU = 1500 - 80 = 1420 (IPv6 transport, safer default)

# Set MTU in [Interface] section
# MTU = 1420

# Or let wg-quick calculate it automatically (default behavior)
# Verify with:
ip link show wg0 | grep mtu
ping -M do -s 1400 10.100.0.1   # test fragmentation
```

## Section 12: Monitoring and Alerting

```bash
#!/bin/bash
# /usr/local/bin/wg-peer-monitor.sh
# Alerts when a peer's last handshake is too old (stale/disconnected)

WG_IF="${1:-wg0}"
MAX_STALE_SECONDS=300   # 5 minutes

wg show "${WG_IF}" latest-handshakes | while read -r pubkey timestamp; do
    if [[ "${timestamp}" -eq 0 ]]; then
        echo "WARN: Peer ${pubkey:0:16}... has never completed a handshake"
        continue
    fi

    now=$(date +%s)
    age=$((now - timestamp))

    if [[ "${age}" -gt "${MAX_STALE_SECONDS}" ]]; then
        echo "WARN: Peer ${pubkey:0:16}... last handshake ${age}s ago (threshold: ${MAX_STALE_SECONDS}s)"
    else
        echo "OK:   Peer ${pubkey:0:16}... last handshake ${age}s ago"
    fi
done
```

Prometheus metrics via wireguard_exporter:

```bash
# Install wireguard_exporter
docker run -d \
  --name wireguard-exporter \
  --cap-add NET_ADMIN \
  -p 9586:9586 \
  -v /etc/wireguard:/etc/wireguard:ro \
  mindflavor/prometheus-wireguard-exporter

# prometheus.yml
scrape_configs:
- job_name: wireguard
  static_configs:
  - targets: ['localhost:9586']
```

Key Prometheus queries:

```promql
# Peers with recent handshakes (< 300 seconds ago)
wireguard_latest_handshake_seconds < (time() - 300)

# Transfer rates per peer
rate(wireguard_sent_bytes_total[5m])
rate(wireguard_received_bytes_total[5m])

# Peers by endpoint (detect roaming)
wireguard_peer_info{endpoint!=""}
```

## Summary

WireGuard provides a dramatically simpler operational model compared to OpenVPN or IPsec:

- **Kernel integration** from Linux 5.6 onwards means no out-of-tree modules and excellent performance
- **Key management** is straightforward — generate Curve25519 keypairs, protect private keys with `chmod 600`, rotate on a schedule
- **Split tunneling** is configured purely via `AllowedIPs` CIDRs — no routing tables to manage separately (though policy routing extends this for complex scenarios)
- **Roaming** works out of the box — the server learns the client's new endpoint from each authenticated packet
- **DNS leaks** require explicit prevention via `systemd-resolved` routing rules or iptables; the `DNS` directive alone is insufficient on systems with complex resolver stacks
- **Performance** scales to multi-gigabit on modern hardware with proper buffer tuning

The simplicity of WireGuard means the operational burden is low, but DNS configuration and routing correctness must be verified carefully before declaring a deployment production-ready.
