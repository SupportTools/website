---
title: "Ubuntu Router & NAT Configuration Guide 2025: Complete Network Gateway Setup with iptables"
date: 2025-11-08T10:00:00-05:00
draft: false
tags: ["Ubuntu Router", "NAT", "iptables", "Network Gateway", "Linux Networking", "IP Forwarding", "Network Configuration", "Firewall", "Home Router", "Enterprise Networking", "Network Security", "Linux Router", "Internet Gateway", "Network Administration"]
categories:
- Linux
- Networking
- System Administration
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Ubuntu router configuration with NAT, iptables, and advanced networking. Complete guide to Linux gateway setup, IP forwarding, firewall rules, traffic shaping, VPN integration, and enterprise network management."
more_link: "yes"
url: "/ubuntu-router-nat-configuration-guide-2025/"
---

Ubuntu servers can function as powerful network routers with NAT capabilities, providing enterprise-grade routing, firewall protection, and network services. This comprehensive guide covers router configuration, iptables management, advanced networking features, and enterprise deployment strategies.

<!--more-->

# [Ubuntu Router Architecture Overview](#ubuntu-router-architecture-overview)

## Why Use Ubuntu as a Router

### Advantages Over Commercial Routers
- **Flexibility**: Complete control over routing policies and configurations
- **Performance**: Dedicated hardware with enterprise-grade capabilities
- **Security**: Advanced firewall rules and intrusion prevention
- **Cost-Effective**: Repurpose existing hardware or use cloud instances
- **Extensibility**: Add VPN, load balancing, traffic analysis, and monitoring

### Common Use Cases
- **Home Lab Networks**: Advanced routing for development environments
- **Small Business Gateways**: Cost-effective enterprise features
- **Edge Computing**: Remote site connectivity and local services
- **Cloud Networking**: Inter-VPC routing and hybrid cloud connectivity
- **Security Perimeter**: Advanced firewall and intrusion detection

### Network Topology Planning
```
Internet
    |
[Ubuntu Router]
    |
Internal Network
192.168.1.0/24
    |
[Clients/Servers]
```

# [Network Interface Configuration](#network-interface-configuration)

## Modern Netplan Configuration

### Install Required Packages
```bash
# Update system packages
sudo apt update

# Install networking utilities
sudo apt install -y iptables-persistent netfilter-persistent

# Install network analysis tools
sudo apt install -y tcpdump wireshark-common bridge-utils net-tools

# Install traffic monitoring
sudo apt install -y vnstat iftop nethogs
```

### Netplan Configuration (Ubuntu 18.04+)
```bash
# Create netplan configuration
sudo tee /etc/netplan/01-router-config.yaml << 'EOF'
network:
  version: 2
  renderer: networkd
  ethernets:
    # External interface (WAN)
    eth0:
      dhcp4: false
      addresses:
        - 10.6.26.67/24
      gateway4: 10.6.26.254
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
          - 1.1.1.1
      routes:
        - to: 0.0.0.0/0
          via: 10.6.26.254
          metric: 100
    
    # Internal interface (LAN)
    eth1:
      dhcp4: false
      addresses:
        - 192.168.1.1/24
      nameservers:
        addresses:
          - 127.0.0.1
EOF

# Apply configuration
sudo netplan apply

# Verify interfaces
ip addr show
ip route show
```

### Legacy Interface Configuration (Ubuntu 16.04 and earlier)
```bash
# Backup original configuration
sudo cp /etc/network/interfaces /etc/network/interfaces.backup

# Configure interfaces
sudo tee /etc/network/interfaces << 'EOF'
# Loopback interface
auto lo
iface lo inet loopback

# External interface (WAN)
auto eth0
iface eth0 inet static
    address 10.6.26.67
    netmask 255.255.255.0
    gateway 10.6.26.254
    dns-nameservers 8.8.8.8 8.8.4.4
    post-up /sbin/iptables-restore < /etc/iptables/rules.v4

# Internal interface (LAN)
auto eth1
iface eth1 inet static
    address 192.168.1.1
    netmask 255.255.255.0
    post-up echo 1 > /proc/sys/net/ipv4/ip_forward
EOF

# Restart networking (from console, not SSH)
sudo systemctl restart networking
```

## Advanced Interface Configuration

### Multiple VLANs Support
```bash
# Install VLAN support
sudo apt install -y vlan

# Load 8021q module
sudo modprobe 8021q
echo "8021q" | sudo tee -a /etc/modules

# Configure VLAN interfaces
sudo tee -a /etc/netplan/01-router-config.yaml << 'EOF'
  vlans:
    eth1.10:
      id: 10
      link: eth1
      addresses:
        - 192.168.10.1/24
    eth1.20:
      id: 20
      link: eth1
      addresses:
        - 192.168.20.1/24
    eth1.30:
      id: 30
      link: eth1
      addresses:
        - 192.168.30.1/24
EOF

sudo netplan apply
```

### Bridge Configuration
```bash
# Configure bridge for VM/container networking
sudo tee -a /etc/netplan/01-router-config.yaml << 'EOF'
  bridges:
    br0:
      interfaces:
        - eth1
      addresses:
        - 192.168.1.1/24
      parameters:
        stp: false
        forward-delay: 0
EOF
```

# [IP Forwarding and Kernel Parameters](#ip-forwarding-and-kernel-parameters)

## Enable IP Forwarding

### Permanent IP Forwarding Configuration
```bash
# Configure sysctl parameters
sudo tee /etc/sysctl.d/99-router.conf << 'EOF'
# Enable IP forwarding
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Network performance optimizations
net.core.rmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_default = 262144
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Security enhancements
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# ICMP rate limiting
net.ipv4.icmp_ratelimit = 1000
net.ipv4.icmp_ratemask = 6168

# TCP SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 5

# Connection tracking optimization
net.netfilter.nf_conntrack_max = 65536
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
EOF

# Apply sysctl changes
sudo sysctl -p /etc/sysctl.d/99-router.conf

# Verify settings
sysctl net.ipv4.ip_forward
```

## Advanced Kernel Tuning

### High-Performance Networking
```bash
# Additional performance tuning
sudo tee -a /etc/sysctl.d/99-router.conf << 'EOF'
# Increase connection tracking table size
net.netfilter.nf_conntrack_max = 131072
net.netfilter.nf_conntrack_buckets = 32768

# TCP window scaling
net.ipv4.tcp_window_scaling = 1
net.core.netdev_max_backlog = 5000

# Increase buffer sizes
net.core.netdev_budget = 600
net.core.netdev_max_backlog = 5000

# BBR congestion control (requires kernel 4.9+)
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
```

# [Advanced iptables Configuration](#advanced-iptables-configuration)

## Comprehensive Firewall Rules

### Basic NAT and Firewall Setup
```bash
#!/bin/bash
# Advanced Ubuntu Router iptables Configuration

# Define interfaces
WAN_INTERFACE="eth0"
LAN_INTERFACE="eth1"
LAN_NETWORK="192.168.1.0/24"

# Clear existing rules
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X

# Set default policies
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT

# Allow loopback traffic
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established and related connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow SSH access (change port as needed)
iptables -A INPUT -p tcp --dport 22 -m state --state NEW -j ACCEPT

# Allow LAN to router communication
iptables -A INPUT -i $LAN_INTERFACE -s $LAN_NETWORK -j ACCEPT

# Allow LAN to WAN forwarding
iptables -A FORWARD -i $LAN_INTERFACE -o $WAN_INTERFACE -s $LAN_NETWORK -j ACCEPT

# NAT configuration
iptables -t nat -A POSTROUTING -o $WAN_INTERFACE -j MASQUERADE

# DNS forwarding (if running local DNS server)
iptables -A INPUT -i $LAN_INTERFACE -p udp --dport 53 -j ACCEPT
iptables -A INPUT -i $LAN_INTERFACE -p tcp --dport 53 -j ACCEPT

# DHCP server (if running local DHCP)
iptables -A INPUT -i $LAN_INTERFACE -p udp --dport 67 -j ACCEPT

# Allow ICMP (ping) from LAN
iptables -A INPUT -i $LAN_INTERFACE -p icmp -j ACCEPT

# Allow limited ICMP from WAN
iptables -A INPUT -i $WAN_INTERFACE -p icmp --icmp-type echo-request -m limit --limit 1/second -j ACCEPT

# Log dropped packets (optional)
iptables -A INPUT -j LOG --log-prefix "iptables-input-dropped: " --log-level 4
iptables -A FORWARD -j LOG --log-prefix "iptables-forward-dropped: " --log-level 4

# Save rules
iptables-save > /etc/iptables/rules.v4
```

### Advanced Security Rules
```bash
#!/bin/bash
# Enhanced security iptables rules

# Anti-DDoS protection
iptables -A INPUT -p tcp --dport 22 -m state --state NEW -m recent --set --name SSH
iptables -A INPUT -p tcp --dport 22 -m state --state NEW -m recent --update --seconds 60 --hitcount 4 --name SSH -j DROP

# SYN flood protection
iptables -A INPUT -p tcp --syn -m limit --limit 1/s --limit-burst 3 -j ACCEPT
iptables -A INPUT -p tcp --syn -j DROP

# Port scan protection
iptables -A INPUT -p tcp --tcp-flags ALL ALL -j DROP
iptables -A INPUT -p tcp --tcp-flags ALL NONE -j DROP
iptables -A INPUT -p tcp --tcp-flags ALL FIN,PSH,URG -j DROP
iptables -A INPUT -p tcp --tcp-flags ALL SYN,FIN -j DROP
iptables -A INPUT -p tcp --tcp-flags SYN,RST SYN,RST -j DROP
iptables -A INPUT -p tcp --tcp-flags FIN,RST FIN,RST -j DROP

# Block invalid packets
iptables -A INPUT -m state --state INVALID -j DROP
iptables -A FORWARD -m state --state INVALID -j DROP

# Rate limit ICMP
iptables -A INPUT -p icmp -m limit --limit 2/second --limit-burst 2 -j ACCEPT
iptables -A INPUT -p icmp -j DROP
```

## Port Forwarding and DMZ

### Port Forwarding Rules
```bash
#!/bin/bash
# Port forwarding configuration

# Web server (port 80 and 443)
iptables -t nat -A PREROUTING -i $WAN_INTERFACE -p tcp --dport 80 -j DNAT --to-destination 192.168.1.100:80
iptables -t nat -A PREROUTING -i $WAN_INTERFACE -p tcp --dport 443 -j DNAT --to-destination 192.168.1.100:443

# SSH to internal server
iptables -t nat -A PREROUTING -i $WAN_INTERFACE -p tcp --dport 2222 -j DNAT --to-destination 192.168.1.101:22

# Game server
iptables -t nat -A PREROUTING -i $WAN_INTERFACE -p tcp --dport 25565 -j DNAT --to-destination 192.168.1.102:25565
iptables -t nat -A PREROUTING -i $WAN_INTERFACE -p udp --dport 25565 -j DNAT --to-destination 192.168.1.102:25565

# Allow forwarded traffic to these destinations
iptables -A FORWARD -i $WAN_INTERFACE -o $LAN_INTERFACE -p tcp --dport 80 -d 192.168.1.100 -j ACCEPT
iptables -A FORWARD -i $WAN_INTERFACE -o $LAN_INTERFACE -p tcp --dport 443 -d 192.168.1.100 -j ACCEPT
iptables -A FORWARD -i $WAN_INTERFACE -o $LAN_INTERFACE -p tcp --dport 22 -d 192.168.1.101 -j ACCEPT
iptables -A FORWARD -i $WAN_INTERFACE -o $LAN_INTERFACE -p tcp --dport 25565 -d 192.168.1.102 -j ACCEPT
iptables -A FORWARD -i $WAN_INTERFACE -o $LAN_INTERFACE -p udp --dport 25565 -d 192.168.1.102 -j ACCEPT
```

### DMZ Configuration
```bash
#!/bin/bash
# DMZ setup for a specific host

DMZ_HOST="192.168.1.200"

# Forward all traffic to DMZ host (except already defined port forwards)
iptables -t nat -A PREROUTING -i $WAN_INTERFACE -j DNAT --to-destination $DMZ_HOST

# Allow all traffic to DMZ host
iptables -A FORWARD -i $WAN_INTERFACE -o $LAN_INTERFACE -d $DMZ_HOST -j ACCEPT
```

# [Quality of Service (QoS) and Traffic Shaping](#quality-of-service-qos-and-traffic-shaping)

## Traffic Control with tc

### Install Traffic Control
```bash
# Install traffic control utilities
sudo apt install -y iproute2 wondershaper

# Load kernel modules
sudo modprobe sch_htb
sudo modprobe sch_fq_codel
```

### Basic Bandwidth Limiting
```bash
#!/bin/bash
# Traffic shaping configuration

WAN_INTERFACE="eth0"
LAN_INTERFACE="eth1"
UPLOAD_SPEED="950kbit"    # Upload bandwidth limit
DOWNLOAD_SPEED="9500kbit" # Download bandwidth limit

# Clear existing rules
tc qdisc del dev $WAN_INTERFACE root 2>/dev/null
tc qdisc del dev $LAN_INTERFACE root 2>/dev/null

# Upload shaping (WAN interface)
tc qdisc add dev $WAN_INTERFACE root handle 1: htb default 30
tc class add dev $WAN_INTERFACE parent 1: classid 1:1 htb rate $UPLOAD_SPEED
tc class add dev $WAN_INTERFACE parent 1:1 classid 1:10 htb rate 50kbit ceil $UPLOAD_SPEED prio 1
tc class add dev $WAN_INTERFACE parent 1:1 classid 1:20 htb rate 100kbit ceil $UPLOAD_SPEED prio 2
tc class add dev $WAN_INTERFACE parent 1:1 classid 1:30 htb rate 800kbit ceil $UPLOAD_SPEED prio 3

# Download shaping (LAN interface)
tc qdisc add dev $LAN_INTERFACE root handle 1: htb default 30
tc class add dev $LAN_INTERFACE parent 1: classid 1:1 htb rate $DOWNLOAD_SPEED
tc class add dev $LAN_INTERFACE parent 1:1 classid 1:10 htb rate 500kbit ceil $DOWNLOAD_SPEED prio 1
tc class add dev $LAN_INTERFACE parent 1:1 classid 1:20 htb rate 1000kbit ceil $DOWNLOAD_SPEED prio 2
tc class add dev $LAN_INTERFACE parent 1:1 classid 1:30 htb rate 8000kbit ceil $DOWNLOAD_SPEED prio 3

# Add fair queuing
tc qdisc add dev $WAN_INTERFACE parent 1:10 handle 10: fq_codel
tc qdisc add dev $WAN_INTERFACE parent 1:20 handle 20: fq_codel
tc qdisc add dev $WAN_INTERFACE parent 1:30 handle 30: fq_codel
tc qdisc add dev $LAN_INTERFACE parent 1:10 handle 10: fq_codel
tc qdisc add dev $LAN_INTERFACE parent 1:20 handle 20: fq_codel
tc qdisc add dev $LAN_INTERFACE parent 1:30 handle 30: fq_codel
```

### Priority-Based QoS
```bash
#!/bin/bash
# Priority-based traffic classification

# Mark packets with iptables
iptables -t mangle -A FORWARD -p tcp --dport 22 -j MARK --set-mark 1  # SSH - High priority
iptables -t mangle -A FORWARD -p tcp --dport 53 -j MARK --set-mark 1  # DNS - High priority
iptables -t mangle -A FORWARD -p udp --dport 53 -j MARK --set-mark 1  # DNS - High priority
iptables -t mangle -A FORWARD -p tcp --dport 80 -j MARK --set-mark 2  # HTTP - Medium priority
iptables -t mangle -A FORWARD -p tcp --dport 443 -j MARK --set-mark 2 # HTTPS - Medium priority
iptables -t mangle -A FORWARD -p tcp --sport 22 -j MARK --set-mark 1  # SSH return traffic

# Traffic classification filters
tc filter add dev $WAN_INTERFACE protocol ip parent 1:0 prio 1 handle 1 fw flowid 1:10
tc filter add dev $WAN_INTERFACE protocol ip parent 1:0 prio 2 handle 2 fw flowid 1:20
tc filter add dev $LAN_INTERFACE protocol ip parent 1:0 prio 1 handle 1 fw flowid 1:10
tc filter add dev $LAN_INTERFACE protocol ip parent 1:0 prio 2 handle 2 fw flowid 1:20
```

# [DHCP and DNS Services](#dhcp-and-dns-services)

## DHCP Server Configuration

### Install and Configure ISC DHCP Server
```bash
# Install DHCP server
sudo apt install -y isc-dhcp-server

# Configure DHCP server
sudo tee /etc/dhcp/dhcpd.conf << 'EOF'
# Global options
default-lease-time 600;
max-lease-time 7200;
ddns-update-style none;
authoritative;

# Subnet configuration
subnet 192.168.1.0 netmask 255.255.255.0 {
    range 192.168.1.100 192.168.1.200;
    option domain-name "local";
    option domain-name-servers 192.168.1.1, 8.8.8.8;
    option routers 192.168.1.1;
    option broadcast-address 192.168.1.255;
    default-lease-time 600;
    max-lease-time 7200;
}

# Static reservations
host server1 {
    hardware ethernet 00:11:22:33:44:55;
    fixed-address 192.168.1.10;
}

host server2 {
    hardware ethernet 00:11:22:33:44:66;
    fixed-address 192.168.1.11;
}

# VLAN subnets
subnet 192.168.10.0 netmask 255.255.255.0 {
    range 192.168.10.50 192.168.10.100;
    option domain-name "vlan10.local";
    option domain-name-servers 192.168.10.1, 8.8.8.8;
    option routers 192.168.10.1;
}

subnet 192.168.20.0 netmask 255.255.255.0 {
    range 192.168.20.50 192.168.20.100;
    option domain-name "vlan20.local";
    option domain-name-servers 192.168.20.1, 8.8.8.8;
    option routers 192.168.20.1;
}
EOF

# Configure DHCP interface
sudo tee /etc/default/isc-dhcp-server << 'EOF'
INTERFACESv4="eth1"
INTERFACESv6=""
EOF

# Start and enable DHCP service
sudo systemctl enable isc-dhcp-server
sudo systemctl start isc-dhcp-server
sudo systemctl status isc-dhcp-server
```

## DNS Server with dnsmasq

### Install and Configure dnsmasq
```bash
# Install dnsmasq
sudo apt install -y dnsmasq

# Backup original configuration
sudo cp /etc/dnsmasq.conf /etc/dnsmasq.conf.backup

# Configure dnsmasq
sudo tee /etc/dnsmasq.conf << 'EOF'
# Listen interfaces
interface=eth1
bind-interfaces

# DNS settings
domain-needed
bogus-priv
no-resolv
server=8.8.8.8
server=8.8.4.4
server=1.1.1.1

# Local domain
local=/local/
domain=local
expand-hosts

# DHCP settings
dhcp-range=192.168.1.100,192.168.1.200,12h
dhcp-option=option:router,192.168.1.1
dhcp-option=option:dns-server,192.168.1.1

# Static DHCP reservations
dhcp-host=00:11:22:33:44:55,server1,192.168.1.10
dhcp-host=00:11:22:33:44:66,server2,192.168.1.11

# Local DNS records
address=/router.local/192.168.1.1
address=/server1.local/192.168.1.10
address=/server2.local/192.168.1.11

# VLAN DHCP ranges
dhcp-range=set:vlan10,192.168.10.50,192.168.10.100,12h
dhcp-range=set:vlan20,192.168.20.50,192.168.20.100,12h

# Cache settings
cache-size=1000
neg-ttl=60

# Logging
log-queries
log-dhcp
EOF

# Disable systemd-resolved to avoid conflicts
sudo systemctl disable systemd-resolved
sudo systemctl stop systemd-resolved
sudo rm /etc/resolv.conf
echo "nameserver 127.0.0.1" | sudo tee /etc/resolv.conf

# Start dnsmasq
sudo systemctl enable dnsmasq
sudo systemctl start dnsmasq
sudo systemctl status dnsmasq
```

# [VPN Integration](#vpn-integration)

## OpenVPN Server Setup

### Install OpenVPN
```bash
# Install OpenVPN and Easy-RSA
sudo apt install -y openvpn easy-rsa

# Create CA directory
make-cadir ~/openvpn-ca
cd ~/openvpn-ca

# Configure Easy-RSA
cat >> vars << 'EOF'
export KEY_COUNTRY="US"
export KEY_PROVINCE="CA"
export KEY_CITY="SanFrancisco"
export KEY_ORG="MyOrganization"
export KEY_EMAIL="admin@example.com"
export KEY_OU="MyOrganizationalUnit"
export KEY_NAME="server"
EOF

# Initialize PKI
./easyrsa init-pki
./easyrsa build-ca nopass
./easyrsa gen-req server nopass
./easyrsa sign-req server server
./easyrsa gen-dh

# Generate client certificate
./easyrsa gen-req client1 nopass
./easyrsa sign-req client client1

# Copy files to OpenVPN directory
sudo cp pki/ca.crt /etc/openvpn/
sudo cp pki/issued/server.crt /etc/openvpn/
sudo cp pki/private/server.key /etc/openvpn/
sudo cp pki/dh.pem /etc/openvpn/
```

### Configure OpenVPN Server
```bash
# Create OpenVPN server configuration
sudo tee /etc/openvpn/server.conf << 'EOF'
port 1194
proto udp
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem

server 10.8.0.0 255.255.255.0
ifconfig-pool-persist ipp.txt

# Push routes to clients
push "route 192.168.1.0 255.255.255.0"
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 192.168.1.1"

keepalive 10 120
tls-auth ta.key 0
cipher AES-256-CBC
user nobody
group nogroup
persist-key
persist-tun

status openvpn-status.log
verb 3
explicit-exit-notify 1
EOF

# Generate TLS auth key
sudo openvpn --genkey --secret /etc/openvpn/ta.key

# Configure iptables for VPN
iptables -A INPUT -i tun+ -j ACCEPT
iptables -A FORWARD -i tun+ -j ACCEPT
iptables -A FORWARD -i tun+ -o eth0 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -A FORWARD -i eth0 -o tun+ -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.8.0.0/8 -o eth0 -j MASQUERADE

# Start OpenVPN
sudo systemctl enable openvpn@server
sudo systemctl start openvpn@server
```

## WireGuard VPN (Modern Alternative)

### Install WireGuard
```bash
# Install WireGuard
sudo apt install -y wireguard

# Generate server keys
sudo wg genkey | sudo tee /etc/wireguard/private.key
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Configure WireGuard
sudo tee /etc/wireguard/wg0.conf << 'EOF'
[Interface]
PrivateKey = SERVER_PRIVATE_KEY_HERE
Address = 10.0.0.1/24
ListenPort = 51820
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Client configurations
[Peer]
PublicKey = CLIENT_PUBLIC_KEY_HERE
AllowedIPs = 10.0.0.2/32
EOF

# Replace private key in config
PRIVATE_KEY=$(sudo cat /etc/wireguard/private.key)
sudo sed -i "s/SERVER_PRIVATE_KEY_HERE/$PRIVATE_KEY/" /etc/wireguard/wg0.conf

# Enable WireGuard
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0
```

# [Monitoring and Logging](#monitoring-and-logging)

## Network Traffic Monitoring

### Install Monitoring Tools
```bash
# Install network monitoring packages
sudo apt install -y vnstat ntopng bandwidthd mrtg

# Configure vnstat
sudo vnstat -u -i eth0
sudo vnstat -u -i eth1
sudo systemctl enable vnstat
sudo systemctl start vnstat
```

### ntopng Configuration
```bash
# Configure ntopng
sudo tee /etc/ntopng/ntopng.conf << 'EOF'
-P=/var/lib/ntopng/ntopng.pid
-d=/var/lib/ntopng
-w=3000
-i=eth0,eth1
-m=192.168.1.0/24
-x=60
-q
--community
EOF

# Start ntopng
sudo systemctl enable ntopng
sudo systemctl start ntopng
```

## Log Analysis and Alerting

### Configure rsyslog for Network Logs
```bash
# Configure rsyslog for iptables logging
sudo tee /etc/rsyslog.d/10-iptables.conf << 'EOF'
:msg,contains,"iptables" /var/log/iptables.log
& stop
EOF

# Restart rsyslog
sudo systemctl restart rsyslog

# Create log rotation
sudo tee /etc/logrotate.d/iptables << 'EOF'
/var/log/iptables.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate
    endscript
}
EOF
```

### Network Monitoring Script
```bash
#!/bin/bash
# Network monitoring and alerting script

LOG_FILE="/var/log/network-monitor.log"
ALERT_EMAIL="admin@example.com"
WAN_INTERFACE="eth0"
LAN_INTERFACE="eth1"

# Function to log messages
log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# Check interface status
check_interface() {
    local interface="$1"
    if ! ip link show "$interface" | grep -q "state UP"; then
        log_message "ALERT: Interface $interface is DOWN"
        echo "Interface $interface is down" | mail -s "Network Alert" "$ALERT_EMAIL"
        return 1
    fi
    return 0
}

# Check internet connectivity
check_connectivity() {
    if ! ping -c 3 8.8.8.8 >/dev/null 2>&1; then
        log_message "ALERT: Internet connectivity lost"
        echo "Internet connectivity lost" | mail -s "Network Alert" "$ALERT_EMAIL"
        return 1
    fi
    return 0
}

# Check bandwidth usage
check_bandwidth() {
    local interface="$1"
    local threshold_mbps="$2"
    
    # Get interface statistics
    local rx_bytes=$(cat "/sys/class/net/$interface/statistics/rx_bytes")
    local tx_bytes=$(cat "/sys/class/net/$interface/statistics/tx_bytes")
    
    # Store in temporary file for rate calculation
    local stat_file="/tmp/bandwidth_$interface"
    local current_time=$(date +%s)
    
    if [ -f "$stat_file" ]; then
        local prev_data=$(cat "$stat_file")
        local prev_time=$(echo "$prev_data" | cut -d: -f1)
        local prev_rx=$(echo "$prev_data" | cut -d: -f2)
        local prev_tx=$(echo "$prev_data" | cut -d: -f3)
        
        local time_diff=$((current_time - prev_time))
        if [ $time_diff -gt 0 ]; then
            local rx_rate=$(((rx_bytes - prev_rx) * 8 / time_diff / 1000000))
            local tx_rate=$(((tx_bytes - prev_tx) * 8 / time_diff / 1000000))
            
            if [ $rx_rate -gt $threshold_mbps ] || [ $tx_rate -gt $threshold_mbps ]; then
                log_message "ALERT: High bandwidth usage on $interface (RX: ${rx_rate}Mbps, TX: ${tx_rate}Mbps)"
            fi
        fi
    fi
    
    echo "$current_time:$rx_bytes:$tx_bytes" > "$stat_file"
}

# Main monitoring loop
log_message "Starting network monitoring"

# Check interfaces
check_interface "$WAN_INTERFACE"
check_interface "$LAN_INTERFACE"

# Check connectivity
check_connectivity

# Check bandwidth (alert if over 80% of 100Mbps)
check_bandwidth "$WAN_INTERFACE" 80
check_bandwidth "$LAN_INTERFACE" 80

# Check iptables rules count
rule_count=$(iptables -L | wc -l)
if [ $rule_count -lt 10 ]; then
    log_message "WARNING: Firewall rules count is low ($rule_count)"
fi

log_message "Network monitoring check completed"
```

# [Enterprise Deployment and Automation](#enterprise-deployment-and-automation)

## Ansible Automation

### Router Configuration Playbook
```yaml
---
- name: Configure Ubuntu Router
  hosts: routers
  become: yes
  vars:
    wan_interface: eth0
    lan_interface: eth1
    lan_network: "192.168.1.0/24"
    wan_ip: "10.6.26.67"
    wan_gateway: "10.6.26.254"
    lan_ip: "192.168.1.1"
  
  tasks:
    - name: Install required packages
      apt:
        name:
          - iptables-persistent
          - netfilter-persistent
          - dnsmasq
          - vnstat
        state: present
        update_cache: yes
    
    - name: Configure netplan
      template:
        src: netplan.yaml.j2
        dest: /etc/netplan/01-router-config.yaml
        backup: yes
      notify: apply netplan
    
    - name: Configure sysctl for IP forwarding
      sysctl:
        name: "{{ item.name }}"
        value: "{{ item.value }}"
        state: present
        reload: yes
      loop:
        - { name: net.ipv4.ip_forward, value: 1 }
        - { name: net.ipv4.conf.all.rp_filter, value: 1 }
        - { name: net.ipv4.conf.all.accept_redirects, value: 0 }
        - { name: net.ipv4.conf.all.send_redirects, value: 0 }
    
    - name: Configure iptables rules
      template:
        src: iptables-rules.j2
        dest: /etc/iptables/rules.v4
        backup: yes
      notify: restart netfilter-persistent
    
    - name: Configure dnsmasq
      template:
        src: dnsmasq.conf.j2
        dest: /etc/dnsmasq.conf
        backup: yes
      notify: restart dnsmasq
    
    - name: Start and enable services
      systemd:
        name: "{{ item }}"
        state: started
        enabled: yes
      loop:
        - dnsmasq
        - netfilter-persistent
        - vnstat
  
  handlers:
    - name: apply netplan
      command: netplan apply
    
    - name: restart netfilter-persistent
      systemd:
        name: netfilter-persistent
        state: restarted
    
    - name: restart dnsmasq
      systemd:
        name: dnsmasq
        state: restarted
```

## Docker-based Router Services

### Containerized Network Services
```yaml
version: '3.8'
services:
  pihole:
    image: pihole/pihole:latest
    container_name: pihole
    environment:
      TZ: 'America/New_York'
      WEBPASSWORD: 'admin123'
    volumes:
      - './pihole/etc-pihole/:/etc/pihole/'
      - './pihole/etc-dnsmasq.d/:/etc/dnsmasq.d/'
    ports:
      - "53:53/tcp"
      - "53:53/udp"
      - "80:80/tcp"
    restart: unless-stopped
    networks:
      - router_network
  
  unbound:
    image: mvance/unbound:latest
    container_name: unbound
    volumes:
      - './unbound:/opt/unbound/etc/unbound/'
    ports:
      - "5053:53/tcp"
      - "5053:53/udp"
    restart: unless-stopped
    networks:
      - router_network
  
  ntopng:
    image: ntop/ntopng:stable
    container_name: ntopng
    command: --community -i eth0,eth1 -w 3000
    ports:
      - "3000:3000"
    network_mode: host
    restart: unless-stopped

networks:
  router_network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

This comprehensive Ubuntu router guide provides enterprise-grade networking capabilities, advanced security features, and automated deployment strategies for modern network infrastructure requirements.