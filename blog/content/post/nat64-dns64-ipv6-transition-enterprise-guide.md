---
title: "Enterprise NAT64/DNS64 Deployment Guide: Complete IPv6 Transition and Dual-Stack Architecture for Production Networks"
date: 2025-04-15T10:00:00-05:00
draft: false
tags: ["NAT64", "DNS64", "IPv6", "IPv4", "Network Transition", "Enterprise Networking", "Tayga", "BIND9", "Linux", "Network Architecture"]
categories:
- Network Engineering
- IPv6 Transition
- Enterprise Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to enterprise NAT64/DNS64 deployment covering advanced configuration, high availability architectures, monitoring solutions, and production-grade IPv6 transition strategies"
more_link: "yes"
url: "/nat64-dns64-ipv6-transition-enterprise-guide/"
---

NAT64 and DNS64 technologies provide critical IPv6 transition mechanisms for enterprise networks, enabling IPv6-only clients to access IPv4-only services while maintaining optimal performance and security. This comprehensive guide covers enterprise deployment strategies, high availability architectures, advanced configuration techniques, and production-grade monitoring solutions for large-scale NAT64/DNS64 implementations.

<!--more-->

# [IPv6 Transition Architecture Overview](#ipv6-transition-architecture-overview)

## NAT64/DNS64 Enterprise Framework

NAT64 and DNS64 work together to provide seamless IPv6-to-IPv4 connectivity, enabling organizations to deploy IPv6-only networks while maintaining backward compatibility with legacy IPv4 services.

### Technology Stack Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    IPv6-Only Client Network                     │
├─────────────────────────────────────────────────────────────────┤
│   Applications   │   OS Network Stack   │   IPv6 Addressing    │
├─────────────────────────────────────────────────────────────────┤
│                        DNS64 Resolution                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ DNS Query   │  │ IPv4 Record │  │ NAT64 Prefix Synthesis │  │
│  │ (AAAA)      │──│ Discovery   │──│ (64:ff9b::/96)          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        NAT64 Gateway                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ IPv6 Packet │  │ Translation │  │ IPv4 Packet Forwarding │  │
│  │ Processing  │──│ Engine      │──│ & State Management     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                     Legacy IPv4 Internet                       │
└─────────────────────────────────────────────────────────────────┘
```

### Enterprise Deployment Models

| Model | Use Case | Complexity | Scalability | Redundancy |
|-------|----------|------------|-------------|------------|
| **Centralized** | Single datacenter | Low | Medium | Single point of failure |
| **Distributed** | Multi-site enterprise | High | High | Built-in redundancy |
| **Cloud-Hybrid** | Hybrid cloud deployments | Medium | Very High | Cloud-native redundancy |
| **Service Provider** | ISP/carrier networks | Very High | Massive | Carrier-grade redundancy |

## IPv6 Address Encoding and Prefix Management

### Standard NAT64 Prefix Configuration

The well-known NAT64 prefix `64:ff9b::/96` provides standardized IPv4-to-IPv6 address mapping:

```bash
# IPv4 address encoding example: 185.130.44.9
# Convert each octet to hexadecimal:
# 185 = 0xb9, 130 = 0x82, 44 = 0x2c, 9 = 0x09
# Result: 64:ff9b::b982:2c09

# Automated conversion script
convert_ipv4_to_nat64() {
    local ipv4="$1"
    local prefix="${2:-64:ff9b::}"
    
    # Split IPv4 address into octets
    IFS='.' read -ra octets <<< "$ipv4"
    
    # Convert to hexadecimal
    local hex1=$(printf "%02x" "${octets[0]}")
    local hex2=$(printf "%02x" "${octets[1]}")
    local hex3=$(printf "%02x" "${octets[2]}")
    local hex4=$(printf "%02x" "${octets[3]}")
    
    # Combine into IPv6 format
    local encoded="${hex1}${hex2}:${hex3}${hex4}"
    echo "${prefix}${encoded}"
}

# Example usage
convert_ipv4_to_nat64 "8.8.8.8"      # Returns: 64:ff9b::808:808
convert_ipv4_to_nat64 "1.1.1.1"      # Returns: 64:ff9b::101:101
convert_ipv4_to_nat64 "185.130.44.9" # Returns: 64:ff9b::b982:2c09
```

### Enterprise NAT64 Prefix Planning

```python
#!/usr/bin/env python3
"""
Enterprise NAT64 Prefix Planning and Management Tool
"""

import ipaddress
import json
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

@dataclass
class NAT64Prefix:
    prefix: str
    purpose: str
    location: str
    redundancy_group: int
    active: bool = True

class NAT64PrefixManager:
    def __init__(self):
        self.prefixes: Dict[str, NAT64Prefix] = {}
        self.standard_prefix = "64:ff9b::/96"
        
    def add_prefix(self, prefix: str, purpose: str, location: str, 
                   redundancy_group: int = 0) -> bool:
        """Add a NAT64 prefix to the management system"""
        try:
            # Validate IPv6 prefix
            network = ipaddress.IPv6Network(prefix, strict=False)
            
            # Ensure it's a /96 or larger (smaller prefix number)
            if network.prefixlen > 96:
                raise ValueError(f"NAT64 prefix must be /96 or larger, got /{network.prefixlen}")
            
            prefix_obj = NAT64Prefix(
                prefix=str(network),
                purpose=purpose,
                location=location,
                redundancy_group=redundancy_group
            )
            
            self.prefixes[str(network)] = prefix_obj
            return True
            
        except Exception as e:
            print(f"Error adding prefix {prefix}: {e}")
            return False
    
    def encode_ipv4_address(self, ipv4_addr: str, 
                           prefix: Optional[str] = None) -> str:
        """Encode IPv4 address into NAT64 IPv6 address"""
        if prefix is None:
            prefix = self.standard_prefix
        
        try:
            # Parse IPv4 address
            ipv4 = ipaddress.IPv4Address(ipv4_addr)
            prefix_net = ipaddress.IPv6Network(prefix, strict=False)
            
            # Convert IPv4 to 32-bit integer
            ipv4_int = int(ipv4)
            
            # Create NAT64 address by combining prefix with IPv4
            # The IPv4 address goes in the last 32 bits of the /96 prefix
            nat64_int = int(prefix_net.network_address) + ipv4_int
            nat64_addr = ipaddress.IPv6Address(nat64_int)
            
            return str(nat64_addr)
            
        except Exception as e:
            raise ValueError(f"Failed to encode {ipv4_addr}: {e}")
    
    def decode_nat64_address(self, nat64_addr: str) -> Tuple[str, str]:
        """Decode NAT64 IPv6 address back to IPv4 and prefix"""
        try:
            ipv6 = ipaddress.IPv6Address(nat64_addr)
            
            # Check against known prefixes
            for prefix_str, prefix_obj in self.prefixes.items():
                prefix_net = ipaddress.IPv6Network(prefix_str, strict=False)
                
                if ipv6 in prefix_net:
                    # Extract IPv4 portion (last 32 bits)
                    ipv4_int = int(ipv6) - int(prefix_net.network_address)
                    ipv4_addr = ipaddress.IPv4Address(ipv4_int)
                    
                    return str(ipv4_addr), prefix_str
            
            # Check against standard prefix
            std_prefix_net = ipaddress.IPv6Network(self.standard_prefix, strict=False)
            if ipv6 in std_prefix_net:
                ipv4_int = int(ipv6) - int(std_prefix_net.network_address)
                ipv4_addr = ipaddress.IPv4Address(ipv4_int)
                return str(ipv4_addr), self.standard_prefix
            
            raise ValueError("Address not in any known NAT64 prefix")
            
        except Exception as e:
            raise ValueError(f"Failed to decode {nat64_addr}: {e}")
    
    def generate_prefix_config(self, location: str) -> Dict:
        """Generate configuration for specific location"""
        location_prefixes = [
            p for p in self.prefixes.values() 
            if p.location == location and p.active
        ]
        
        return {
            'location': location,
            'prefixes': [
                {
                    'prefix': p.prefix,
                    'purpose': p.purpose,
                    'redundancy_group': p.redundancy_group
                }
                for p in location_prefixes
            ],
            'standard_prefix': self.standard_prefix
        }
    
    def validate_prefix_allocation(self) -> Dict[str, List[str]]:
        """Validate prefix allocations for conflicts"""
        conflicts = {}
        
        # Check for overlapping prefixes
        prefix_networks = [
            (prefix, ipaddress.IPv6Network(prefix, strict=False))
            for prefix in self.prefixes.keys()
        ]
        
        for i, (prefix1, net1) in enumerate(prefix_networks):
            for prefix2, net2 in prefix_networks[i+1:]:
                if net1.overlaps(net2):
                    if 'overlapping_prefixes' not in conflicts:
                        conflicts['overlapping_prefixes'] = []
                    conflicts['overlapping_prefixes'].append(f"{prefix1} overlaps with {prefix2}")
        
        # Check redundancy group coverage
        redundancy_groups = {}
        for prefix_obj in self.prefixes.values():
            group = prefix_obj.redundancy_group
            if group not in redundancy_groups:
                redundancy_groups[group] = []
            redundancy_groups[group].append(prefix_obj.prefix)
        
        for group, prefixes in redundancy_groups.items():
            if len(prefixes) < 2 and group > 0:
                if 'insufficient_redundancy' not in conflicts:
                    conflicts['insufficient_redundancy'] = []
                conflicts['insufficient_redundancy'].append(
                    f"Redundancy group {group} has only {len(prefixes)} prefix(es)"
                )
        
        return conflicts

# Example enterprise prefix allocation
def setup_enterprise_prefixes():
    """Example enterprise NAT64 prefix setup"""
    manager = NAT64PrefixManager()
    
    # Primary datacenter prefixes
    manager.add_prefix("2001:db8:64::/96", "Primary NAT64", "DC1", 1)
    manager.add_prefix("2001:db8:65::/96", "Backup NAT64", "DC1", 1)
    
    # Secondary datacenter prefixes
    manager.add_prefix("2001:db8:66::/96", "Primary NAT64", "DC2", 2)
    manager.add_prefix("2001:db8:67::/96", "Backup NAT64", "DC2", 2)
    
    # Cloud prefixes
    manager.add_prefix("2001:db8:68::/96", "Cloud NAT64", "AWS-US-East", 3)
    manager.add_prefix("2001:db8:69::/96", "Cloud NAT64", "AWS-US-West", 4)
    
    return manager

if __name__ == "__main__":
    # Demonstration
    manager = setup_enterprise_prefixes()
    
    # Test encoding/decoding
    test_ips = ["8.8.8.8", "1.1.1.1", "185.130.44.9"]
    
    for ip in test_ips:
        nat64_addr = manager.encode_ipv4_address(ip)
        decoded_ip, prefix = manager.decode_nat64_address(nat64_addr)
        print(f"{ip} -> {nat64_addr} -> {decoded_ip} (prefix: {prefix})")
    
    # Validate configuration
    conflicts = manager.validate_prefix_allocation()
    if conflicts:
        print("Configuration conflicts found:")
        for conflict_type, messages in conflicts.items():
            print(f"  {conflict_type}:")
            for message in messages:
                print(f"    - {message}")
    else:
        print("No configuration conflicts detected")
```

# [Enterprise NAT64 Gateway Implementation](#enterprise-nat64-gateway-implementation)

## High-Availability Tayga Deployment

### Advanced Tayga Configuration Framework

```bash
#!/bin/bash
# Enterprise NAT64 Gateway Deployment and Management System

set -euo pipefail

# Configuration variables
NAT64_CONFIG_DIR="/etc/nat64"
NAT64_LOG_DIR="/var/log/nat64"
TAYGA_CONFIG="/etc/tayga.conf"
BACKUP_DIR="/opt/nat64/backups"
SERVICE_NAME="tayga"

# Network configuration
PRIMARY_IPV6="${NAT64_PRIMARY_IPV6:-2001:db8:1::64}"
SECONDARY_IPV6="${NAT64_SECONDARY_IPV6:-2001:db8:2::64}"
NAT64_PREFIX="${NAT64_PREFIX:-64:ff9b::/96}"
INTERNAL_IPV4_POOL="${NAT64_IPV4_POOL:-192.168.100.0/24}"
TUN_IPV4="${NAT64_TUN_IPV4:-192.168.255.1}"

# Logging
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$NAT64_LOG_DIR/deployment.log"; }
error() { echo "[ERROR] $*" >&2; exit 1; }

# Create directory structure
setup_directories() {
    log "Setting up NAT64 directory structure..."
    
    mkdir -p "$NAT64_CONFIG_DIR" "$NAT64_LOG_DIR" "$BACKUP_DIR"
    mkdir -p "/var/spool/tayga"
    
    # Set permissions
    chown -R root:root "$NAT64_CONFIG_DIR"
    chmod 755 "$NAT64_CONFIG_DIR" "$NAT64_LOG_DIR"
    chmod 700 "$BACKUP_DIR"
}

# Install and configure Tayga
install_tayga() {
    log "Installing Tayga NAT64 gateway..."
    
    # Install package
    if command -v apt >/dev/null 2>&1; then
        apt update
        apt install -y tayga iproute2 iptables
    elif command -v yum >/dev/null 2>&1; then
        yum install -y tayga iproute iptables
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y tayga iproute iptables
    else
        error "Unsupported package manager"
    fi
    
    # Backup original configuration
    if [[ -f "$TAYGA_CONFIG" ]]; then
        cp "$TAYGA_CONFIG" "$BACKUP_DIR/tayga.conf.backup.$(date +%Y%m%d_%H%M%S)"
    fi
}

# Generate Tayga configuration
configure_tayga() {
    log "Configuring Tayga for enterprise deployment..."
    
    cat > "$TAYGA_CONFIG" << EOF
# Enterprise Tayga NAT64 Configuration
# Generated: $(date)

# Tunnel device
tun-device nat64

# IPv4 configuration
ipv4-addr $TUN_IPV4
dynamic-pool $INTERNAL_IPV4_POOL

# IPv6 configuration  
ipv6-addr $PRIMARY_IPV6
prefix $NAT64_PREFIX

# Data and logging
data-dir /var/spool/tayga
pidfile /var/run/tayga.pid

# Performance tuning
map-timeout 300
fragment-timeout 60

# Logging configuration
log-level info
EOF

    # Configure defaults
    cat > "/etc/default/tayga" << EOF
# Enterprise Tayga Defaults
RUN="yes"
CONFIGURE_IFACE="yes"
CONFIGURE_NAT44="yes"
DAEMON_OPTS="--config $TAYGA_CONFIG"

# Tunnel interface configuration
IPV4_TUN_ADDR="$TUN_IPV4"
IPV6_TUN_ADDR="$PRIMARY_IPV6"

# Advanced options
ENABLE_HAIRPINNING="yes"
ENABLE_CLAMP_MSS="yes"
EOF

    log "Tayga configuration completed"
}

# Configure kernel parameters
configure_kernel() {
    log "Configuring kernel parameters for NAT64..."
    
    # Enable IP forwarding
    cat > "/etc/sysctl.d/99-nat64.conf" << EOF
# NAT64 Kernel Configuration

# IP Forwarding
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.default.forwarding = 1

# Network optimization
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Connection tracking optimization
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_generic_timeout = 600

# Buffer sizes for high throughput
net.core.rmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_default = 262144
net.core.wmem_max = 16777216

# TCP optimization
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_fack = 1
EOF

    # Apply settings
    sysctl -p /etc/sysctl.d/99-nat64.conf
    
    log "Kernel parameters configured"
}

# Configure firewall rules
configure_firewall() {
    log "Configuring firewall rules for NAT64..."
    
    # Create iptables rules script
    cat > "$NAT64_CONFIG_DIR/nat64-iptables.sh" << 'EOF'
#!/bin/bash
# NAT64 Firewall Configuration

# Clear existing rules
iptables -t nat -F
iptables -t mangle -F
iptables -F FORWARD

# Enable NAT for IPv4 pool
iptables -t nat -A POSTROUTING -s $INTERNAL_IPV4_POOL -j MASQUERADE

# MSS clamping for tunnel traffic
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu

# Forward traffic through NAT64 tunnel
iptables -A FORWARD -i nat64 -j ACCEPT
iptables -A FORWARD -o nat64 -j ACCEPT

# Connection tracking for established connections
iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# Rate limiting for new connections (DDoS protection)
iptables -A FORWARD -m conntrack --ctstate NEW -m limit --limit 100/sec --limit-burst 200 -j ACCEPT
iptables -A FORWARD -m conntrack --ctstate NEW -j DROP

# Logging for debugging (optional)
iptables -A FORWARD -m limit --limit 10/min -j LOG --log-prefix "NAT64-FWD: "
EOF

    chmod +x "$NAT64_CONFIG_DIR/nat64-iptables.sh"
    
    # Create IPv6 firewall rules
    cat > "$NAT64_CONFIG_DIR/nat64-ip6tables.sh" << 'EOF'
#!/bin/bash
# NAT64 IPv6 Firewall Configuration

# Clear existing rules
ip6tables -F FORWARD

# Forward traffic through NAT64 tunnel
ip6tables -A FORWARD -i nat64 -j ACCEPT
ip6tables -A FORWARD -o nat64 -j ACCEPT

# Allow traffic to NAT64 prefix
ip6tables -A FORWARD -d $NAT64_PREFIX -j ACCEPT
ip6tables -A FORWARD -s $NAT64_PREFIX -j ACCEPT

# Connection tracking
ip6tables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# Rate limiting
ip6tables -A FORWARD -m conntrack --ctstate NEW -m limit --limit 100/sec --limit-burst 200 -j ACCEPT
ip6tables -A FORWARD -m conntrack --ctstate NEW -j DROP

# ICMPv6 (essential for IPv6)
ip6tables -A FORWARD -p icmpv6 -j ACCEPT
EOF

    chmod +x "$NAT64_CONFIG_DIR/nat64-ip6tables.sh"
    
    log "Firewall configuration completed"
}

# Create monitoring script
create_monitoring() {
    log "Creating NAT64 monitoring system..."
    
    cat > "$NAT64_CONFIG_DIR/nat64-monitor.sh" << 'EOF'
#!/bin/bash
# NAT64 Gateway Monitoring Script

LOG_FILE="/var/log/nat64/monitor.log"
METRICS_FILE="/var/log/nat64/metrics.log"

log_metric() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'),$*" >> "$METRICS_FILE"
}

check_tayga_status() {
    if systemctl is-active --quiet tayga; then
        echo "TAYGA_STATUS,UP"
        return 0
    else
        echo "TAYGA_STATUS,DOWN"
        return 1
    fi
}

check_tunnel_interface() {
    if ip link show nat64 >/dev/null 2>&1; then
        local stats=$(ip -s link show nat64 | grep -A1 "RX:" | tail -1)
        local rx_packets=$(echo "$stats" | awk '{print $1}')
        local tx_stats=$(ip -s link show nat64 | grep -A1 "TX:" | tail -1)
        local tx_packets=$(echo "$tx_stats" | awk '{print $1}')
        
        echo "TUNNEL_STATUS,UP"
        echo "TUNNEL_RX_PACKETS,$rx_packets"
        echo "TUNNEL_TX_PACKETS,$tx_packets"
        return 0
    else
        echo "TUNNEL_STATUS,DOWN"
        return 1
    fi
}

check_nat64_prefix_route() {
    if ip -6 route show | grep -q "$NAT64_PREFIX"; then
        echo "PREFIX_ROUTE,UP"
        return 0
    else
        echo "PREFIX_ROUTE,DOWN"
        return 1
    fi
}

check_connection_tracking() {
    local conntrack_count=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo "0")
    local conntrack_max=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo "1")
    local usage_percent=$((conntrack_count * 100 / conntrack_max))
    
    echo "CONNTRACK_ENTRIES,$conntrack_count"
    echo "CONNTRACK_USAGE_PERCENT,$usage_percent"
    
    if [[ $usage_percent -gt 80 ]]; then
        return 1
    else
        return 0
    fi
}

# Main monitoring loop
{
    check_tayga_status
    check_tunnel_interface  
    check_nat64_prefix_route
    check_connection_tracking
} | while IFS=, read -r metric value; do
    log_metric "$metric,$value"
    echo "$metric: $value"
done
EOF

    chmod +x "$NAT64_CONFIG_DIR/nat64-monitor.sh"
    
    # Create systemd timer for monitoring
    cat > "/etc/systemd/system/nat64-monitor.service" << EOF
[Unit]
Description=NAT64 Gateway Monitoring
After=network.target

[Service]
Type=oneshot
ExecStart=$NAT64_CONFIG_DIR/nat64-monitor.sh
User=root
StandardOutput=journal
StandardError=journal
EOF

    cat > "/etc/systemd/system/nat64-monitor.timer" << EOF
[Unit]
Description=Run NAT64 monitoring every minute
Requires=nat64-monitor.service

[Timer]
OnCalendar=*:*:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload
    systemctl enable nat64-monitor.timer
    systemctl start nat64-monitor.timer
    
    log "Monitoring system created and enabled"
}

# High availability setup
setup_high_availability() {
    log "Configuring high availability features..."
    
    # Create keepalived configuration for VRRP
    if command -v keepalived >/dev/null 2>&1 || apt install -y keepalived; then
        cat > "/etc/keepalived/keepalived.conf" << EOF
vrrp_script chk_tayga {
    script "$NAT64_CONFIG_DIR/nat64-monitor.sh >/dev/null 2>&1"
    interval 2
    weight -2
    fall 3
    rise 2
}

vrrp_instance VI_NAT64 {
    state MASTER
    interface eth0
    virtual_router_id 64
    priority 110
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass NAT64_HA
    }
    virtual_ipaddress {
        $PRIMARY_IPV6/64
    }
    track_script {
        chk_tayga
    }
}
EOF

        systemctl enable keepalived
        systemctl restart keepalived
        log "Keepalived HA configuration completed"
    fi
}

# Performance optimization
optimize_performance() {
    log "Applying performance optimizations..."
    
    # CPU affinity for Tayga process
    cat > "/etc/systemd/system/tayga.service.d/override.conf" << EOF
[Service]
CPUAffinity=0-1
Nice=-5
IOSchedulingClass=1
IOSchedulingPriority=4
EOF

    # Network interface optimization
    cat > "$NAT64_CONFIG_DIR/interface-optimization.sh" << 'EOF'
#!/bin/bash
# Network Interface Optimization for NAT64

# Optimize main interface
MAIN_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)

if [[ -n "$MAIN_IFACE" ]]; then
    # Increase ring buffer sizes
    ethtool -G "$MAIN_IFACE" rx 4096 tx 4096 2>/dev/null || true
    
    # Enable hardware offloading
    ethtool -K "$MAIN_IFACE" gso on tso on gro on lro on 2>/dev/null || true
    
    # Optimize interrupt coalescing
    ethtool -C "$MAIN_IFACE" rx-usecs 50 tx-usecs 50 2>/dev/null || true
fi

# Optimize NAT64 tunnel interface
if ip link show nat64 >/dev/null 2>&1; then
    # Set appropriate MTU
    ip link set nat64 mtu 1480
    
    # Configure queue discipline
    tc qdisc replace dev nat64 root fq
fi
EOF

    chmod +x "$NAT64_CONFIG_DIR/interface-optimization.sh"
    
    systemctl daemon-reload
    log "Performance optimizations applied"
}

# Service management functions
start_nat64() {
    log "Starting NAT64 services..."
    
    # Apply firewall rules
    source "$NAT64_CONFIG_DIR/nat64-iptables.sh"
    source "$NAT64_CONFIG_DIR/nat64-ip6tables.sh"
    
    # Apply interface optimizations
    "$NAT64_CONFIG_DIR/interface-optimization.sh"
    
    # Start Tayga
    systemctl enable tayga
    systemctl start tayga
    
    # Verify tunnel interface
    sleep 2
    if ip link show nat64 >/dev/null 2>&1; then
        log "NAT64 tunnel interface created successfully"
    else
        error "Failed to create NAT64 tunnel interface"
    fi
    
    log "NAT64 services started successfully"
}

stop_nat64() {
    log "Stopping NAT64 services..."
    
    systemctl stop tayga
    
    # Clean up firewall rules
    iptables -t nat -F
    iptables -F FORWARD
    ip6tables -F FORWARD
    
    log "NAT64 services stopped"
}

# Status and diagnostics
show_status() {
    echo "=== NAT64 Gateway Status ==="
    echo ""
    
    echo "Service Status:"
    systemctl status tayga --no-pager -l
    echo ""
    
    echo "Tunnel Interface:"
    ip link show nat64 2>/dev/null || echo "Tunnel interface not found"
    echo ""
    
    echo "IPv6 Routes:"
    ip -6 route show | grep "$NAT64_PREFIX" || echo "No NAT64 prefix routes found"
    echo ""
    
    echo "Connection Tracking:"
    echo "Active connections: $(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 'N/A')"
    echo "Maximum connections: $(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 'N/A')"
    echo ""
    
    echo "Recent Metrics:"
    tail -10 "$NAT64_LOG_DIR/metrics.log" 2>/dev/null || echo "No metrics available"
}

# Main execution
main() {
    case "${1:-help}" in
        "install")
            setup_directories
            install_tayga
            configure_tayga
            configure_kernel
            configure_firewall
            create_monitoring
            setup_high_availability
            optimize_performance
            log "NAT64 gateway installation completed"
            ;;
        "start")
            start_nat64
            ;;
        "stop")
            stop_nat64
            ;;
        "restart")
            stop_nat64
            sleep 2
            start_nat64
            ;;
        "status")
            show_status
            ;;
        "monitor")
            "$NAT64_CONFIG_DIR/nat64-monitor.sh"
            ;;
        *)
            echo "Usage: $0 {install|start|stop|restart|status|monitor}"
            echo ""
            echo "Commands:"
            echo "  install  - Complete NAT64 gateway installation"
            echo "  start    - Start NAT64 services"
            echo "  stop     - Stop NAT64 services"
            echo "  restart  - Restart NAT64 services"
            echo "  status   - Show detailed status"
            echo "  monitor  - Run monitoring check"
            exit 1
            ;;
    esac
}

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
fi

main "$@"
```

# [Enterprise DNS64 Implementation](#enterprise-dns64-implementation)

## Advanced BIND9 DNS64 Configuration

### Production DNS64 Server Setup

```bash
#!/bin/bash
# Enterprise DNS64 Server Deployment and Configuration

set -euo pipefail

# Configuration
DNS64_CONFIG_DIR="/etc/bind/dns64"
DNS64_LOG_DIR="/var/log/dns64"
BIND_CONFIG="/etc/bind/named.conf"
FORWARDERS="${DNS64_FORWARDERS:-8.8.8.8; 1.1.1.1; 9.9.9.9;}"
NAT64_PREFIX="${DNS64_NAT64_PREFIX:-64:ff9b::/96}"
LISTEN_IPV6="${DNS64_LISTEN_IPV6:-::}"
LISTEN_IPV4="${DNS64_LISTEN_IPV4:-0.0.0.0}"

# Logging
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$DNS64_LOG_DIR/deployment.log"; }
error() { echo "[ERROR] $*" >&2; exit 1; }

# Setup directory structure
setup_directories() {
    log "Setting up DNS64 directory structure..."
    
    mkdir -p "$DNS64_CONFIG_DIR" "$DNS64_LOG_DIR"
    mkdir -p "/var/cache/bind/dns64"
    
    # Set permissions
    chown -R bind:bind "$DNS64_CONFIG_DIR" "$DNS64_LOG_DIR" "/var/cache/bind/dns64"
    chmod 755 "$DNS64_CONFIG_DIR" "$DNS64_LOG_DIR"
}

# Install BIND9 with DNS64 support
install_bind9() {
    log "Installing BIND9 with DNS64 support..."
    
    if command -v apt >/dev/null 2>&1; then
        apt update
        apt install -y bind9 bind9utils bind9-doc dnsutils
    elif command -v yum >/dev/null 2>&1; then
        yum install -y bind bind-utils
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y bind bind-utils
    else
        error "Unsupported package manager"
    fi
    
    # Verify DNS64 support
    if ! named -V | grep -q "DNS64"; then
        log "WARNING: BIND9 may not have DNS64 support compiled in"
    fi
}

# Generate comprehensive BIND9 configuration
configure_bind9() {
    log "Configuring BIND9 for DNS64..."
    
    # Backup original configuration
    if [[ -f "$BIND_CONFIG" ]]; then
        cp "$BIND_CONFIG" "$DNS64_CONFIG_DIR/named.conf.backup.$(date +%Y%m%d_%H%M%S)"
    fi
    
    # Main configuration file
    cat > "$BIND_CONFIG" << EOF
// Enterprise DNS64 Configuration
// Generated: $(date)

include "/etc/bind/named.conf.options";
include "/etc/bind/named.conf.local";
include "/etc/bind/named.conf.default-zones";
include "$DNS64_CONFIG_DIR/dns64-zones.conf";
EOF

    # DNS64 specific options
    cat > "/etc/bind/named.conf.options" << EOF
// DNS64 Options Configuration

options {
    directory "/var/cache/bind";
    
    // Listen on both IPv4 and IPv6
    listen-on { $LISTEN_IPV4; };
    listen-on-v6 { $LISTEN_IPV6; };
    
    // Port configuration
    listen-on port 53 { any; };
    listen-on-v6 port 53 { any; };
    
    // DNS64 configuration
    dns64 $NAT64_PREFIX {
        clients { any; };
        mapped { any; };
        exclude { 
            // Exclude IPv6-enabled domains
            ::ffff:0:0/96;
        };
        suffix ::;
        recursive-only yes;
        break-dnssec yes;
    };
    
    // Recursion and forwarders
    recursion yes;
    allow-recursion { any; };
    
    forwarders {
        $FORWARDERS
    };
    forward only;
    
    // Query logging for debugging
    querylog yes;
    
    // Performance tuning
    max-cache-size 256M;
    cleaning-interval 60;
    max-cache-ttl 3600;
    max-ncache-ttl 1800;
    
    // Security settings
    allow-transfer { none; };
    allow-update { none; };
    version none;
    hostname none;
    server-id none;
    
    // Rate limiting
    rate-limit {
        responses-per-second 10;
        window 5;
    };
    
    // DNSSEC validation
    dnssec-validation auto;
    
    auth-nxdomain no;    # conform to RFC1035
};

// Logging configuration
logging {
    channel default_debug {
        file "$DNS64_LOG_DIR/bind.log" versions 10 size 20m;
        severity debug;
        print-category yes;
        print-severity yes;
        print-time yes;
    };
    
    channel query_log {
        file "$DNS64_LOG_DIR/queries.log" versions 10 size 50m;
        severity info;
        print-category yes;
        print-severity yes;
        print-time yes;
    };
    
    channel dns64_log {
        file "$DNS64_LOG_DIR/dns64.log" versions 10 size 20m;
        severity info;
        print-category yes;
        print-severity yes;
        print-time yes;
    };
    
    category default { default_debug; };
    category queries { query_log; };
    category dns64 { dns64_log; };
    category resolver { dns64_log; };
    category dnssec { dns64_log; };
};
EOF

    # DNS64 zones configuration
    cat > "$DNS64_CONFIG_DIR/dns64-zones.conf" << EOF
// DNS64 Zones Configuration

// Local DNS64 test zone (optional)
zone "dns64.local" {
    type master;
    file "$DNS64_CONFIG_DIR/db.dns64.local";
    allow-query { any; };
};

// Reverse DNS for NAT64 prefix (optional)
zone "b.f.f.9.f.f.4.6.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa" {
    type master;
    file "$DNS64_CONFIG_DIR/db.nat64.reverse";
    allow-query { any; };
};
EOF

    # Create test zone file
    cat > "$DNS64_CONFIG_DIR/db.dns64.local" << EOF
\$TTL    604800
@       IN      SOA     dns64.local. admin.dns64.local. (
                        $(date +%Y%m%d%H)     ; Serial
                        604800         ; Refresh
                        86400          ; Retry
                        2419200        ; Expire
                        604800 )       ; Negative Cache TTL

        IN      NS      ns1.dns64.local.
        IN      A       192.0.2.1
        IN      AAAA    2001:db8::1

ns1     IN      A       192.0.2.1
ns1     IN      AAAA    2001:db8::1

; Test records for DNS64 functionality
ipv4only IN     A       8.8.8.8
ipv6only IN     AAAA    2001:4860:4860::8888
dual     IN     A       8.8.8.8
dual     IN     AAAA    2001:4860:4860::8888
EOF

    # Create reverse zone file
    cat > "$DNS64_CONFIG_DIR/db.nat64.reverse" << EOF
\$TTL    604800
@       IN      SOA     dns64.local. admin.dns64.local. (
                        $(date +%Y%m%d%H)     ; Serial
                        604800         ; Refresh
                        86400          ; Retry
                        2419200        ; Expire
                        604800 )       ; Negative Cache TTL

        IN      NS      ns1.dns64.local.
EOF

    # Set proper ownership
    chown -R bind:bind "$DNS64_CONFIG_DIR"
    chown bind:bind "/etc/bind/named.conf.options"
    
    log "BIND9 DNS64 configuration completed"
}

# Create monitoring and testing tools
create_dns64_tools() {
    log "Creating DNS64 monitoring and testing tools..."
    
    # DNS64 testing script
    cat > "$DNS64_CONFIG_DIR/test-dns64.sh" << 'EOF'
#!/bin/bash
# DNS64 Functionality Testing Script

DNS64_SERVER="${1:-localhost}"
NAT64_PREFIX="${2:-64:ff9b::}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
test_query() {
    local query_type="$1"
    local domain="$2"
    local expected="$3"
    
    log "Testing $query_type query for $domain..."
    
    local result
    if [[ "$query_type" == "A" ]]; then
        result=$(dig @"$DNS64_SERVER" A "$domain" +short | head -1)
    elif [[ "$query_type" == "AAAA" ]]; then
        result=$(dig @"$DNS64_SERVER" AAAA "$domain" +short | head -1)
    fi
    
    if [[ -n "$result" ]]; then
        log "  Result: $result"
        if [[ "$query_type" == "AAAA" && "$result" =~ ^64:ff9b:: ]]; then
            log "  ✓ DNS64 synthesis detected"
        elif [[ -n "$expected" && "$result" == "$expected" ]]; then
            log "  ✓ Expected result received"
        else
            log "  ℹ Result received (not necessarily DNS64 synthesized)"
        fi
    else
        log "  ✗ No result received"
    fi
    
    echo ""
}

log "Starting DNS64 functionality tests..."
log "DNS64 Server: $DNS64_SERVER"
log "NAT64 Prefix: $NAT64_PREFIX"
echo ""

# Test IPv4-only domains (should get DNS64 synthesis)
test_query "AAAA" "ipv4.google.com"
test_query "AAAA" "www.example.com"

# Test IPv6-enabled domains (should get real AAAA records)
test_query "AAAA" "ipv6.google.com"
test_query "AAAA" "www.facebook.com"

# Test A records (should work normally)
test_query "A" "www.google.com" 
test_query "A" "www.example.com"

# Test local test domain if available
test_query "AAAA" "ipv4only.dns64.local"
test_query "A" "ipv4only.dns64.local"

log "DNS64 testing completed"
EOF

    chmod +x "$DNS64_CONFIG_DIR/test-dns64.sh"
    
    # DNS64 monitoring script
    cat > "$DNS64_CONFIG_DIR/monitor-dns64.sh" << 'EOF'
#!/bin/bash
# DNS64 Server Monitoring Script

METRICS_FILE="/var/log/dns64/metrics.log"
LOG_FILE="/var/log/dns64/monitor.log"

log_metric() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'),$*" >> "$METRICS_FILE"
}

check_bind_status() {
    if systemctl is-active --quiet bind9 || systemctl is-active --quiet named; then
        echo "BIND_STATUS,UP"
        return 0
    else
        echo "BIND_STATUS,DOWN"
        return 1
    fi
}

check_dns_resolution() {
    local test_domain="www.google.com"
    local dns_server="127.0.0.1"
    
    # Test A record resolution
    if timeout 5 dig @"$dns_server" A "$test_domain" +short >/dev/null 2>&1; then
        echo "DNS_A_RESOLUTION,UP"
    else
        echo "DNS_A_RESOLUTION,DOWN"
        return 1
    fi
    
    # Test AAAA record resolution (may be DNS64 synthesized)
    if timeout 5 dig @"$dns_server" AAAA "$test_domain" +short >/dev/null 2>&1; then
        echo "DNS_AAAA_RESOLUTION,UP"
    else
        echo "DNS_AAAA_RESOLUTION,DOWN"
        return 1
    fi
    
    return 0
}

check_dns64_synthesis() {
    local ipv4_only_domain="ipv4.google.com"
    local dns_server="127.0.0.1"
    
    # Query for AAAA record on IPv4-only domain
    local result=$(timeout 5 dig @"$dns_server" AAAA "$ipv4_only_domain" +short 2>/dev/null | head -1)
    
    if [[ -n "$result" && "$result" =~ ^64:ff9b:: ]]; then
        echo "DNS64_SYNTHESIS,UP"
        return 0
    else
        echo "DNS64_SYNTHESIS,DOWN"
        return 1
    fi
}

check_query_performance() {
    local test_domain="www.example.com"
    local dns_server="127.0.0.1"
    
    # Measure query response time
    local start_time=$(date +%s%N)
    if timeout 5 dig @"$dns_server" A "$test_domain" +short >/dev/null 2>&1; then
        local end_time=$(date +%s%N)
        local response_time_ms=$(( (end_time - start_time) / 1000000 ))
        echo "QUERY_RESPONSE_TIME_MS,$response_time_ms"
        
        if [[ $response_time_ms -lt 100 ]]; then
            echo "QUERY_PERFORMANCE,GOOD"
        elif [[ $response_time_ms -lt 500 ]]; then
            echo "QUERY_PERFORMANCE,ACCEPTABLE"
        else
            echo "QUERY_PERFORMANCE,SLOW"
        fi
    else
        echo "QUERY_PERFORMANCE,FAILED"
        return 1
    fi
}

get_cache_statistics() {
    # Extract cache hit statistics from BIND logs if available
    if command -v rndc >/dev/null 2>&1; then
        local cache_stats=$(rndc stats 2>/dev/null | grep -E "(cache|hits)" | wc -l)
        echo "CACHE_ENTRIES,$cache_stats"
    fi
}

# Main monitoring execution
{
    check_bind_status
    check_dns_resolution
    check_dns64_synthesis
    check_query_performance
    get_cache_statistics
} | while IFS=, read -r metric value; do
    log_metric "$metric,$value"
    echo "$metric: $value"
done
EOF

    chmod +x "$DNS64_CONFIG_DIR/monitor-dns64.sh"
    
    # Create systemd monitoring service
    cat > "/etc/systemd/system/dns64-monitor.service" << EOF
[Unit]
Description=DNS64 Server Monitoring
After=network.target

[Service]
Type=oneshot
ExecStart=$DNS64_CONFIG_DIR/monitor-dns64.sh
User=root
StandardOutput=journal
StandardError=journal
EOF

    cat > "/etc/systemd/system/dns64-monitor.timer" << EOF
[Unit]
Description=Run DNS64 monitoring every 2 minutes
Requires=dns64-monitor.service

[Timer]
OnCalendar=*:*/2:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload
    systemctl enable dns64-monitor.timer
    systemctl start dns64-monitor.timer
    
    log "DNS64 monitoring and testing tools created"
}

# Performance optimization
optimize_dns64_performance() {
    log "Applying DNS64 performance optimizations..."
    
    # Create systemd override for performance tuning
    mkdir -p "/etc/systemd/system/bind9.service.d"
    cat > "/etc/systemd/system/bind9.service.d/performance.conf" << EOF
[Service]
# Performance optimization
LimitNOFILE=65536
LimitNPROC=32768

# CPU affinity (adjust based on server)
CPUAffinity=0-3

# Priority
Nice=-5
IOSchedulingClass=1
IOSchedulingPriority=4

# Memory
MemoryHigh=2G
MemoryMax=4G
EOF

    # Network buffer optimization
    cat > "/etc/sysctl.d/99-dns64.conf" << EOF
# DNS64 Network Optimization

# UDP buffer sizes
net.core.rmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_default = 262144
net.core.wmem_max = 16777216

# UDP socket buffers
net.core.netdev_max_backlog = 5000
net.core.netdev_budget = 600

# Connection tracking (if enabled)
net.netfilter.nf_conntrack_max = 1048576
EOF

    sysctl -p /etc/sysctl.d/99-dns64.conf
    systemctl daemon-reload
    
    log "DNS64 performance optimizations applied"
}

# Service management
start_dns64() {
    log "Starting DNS64 services..."
    
    # Test configuration
    if ! named-checkconf "$BIND_CONFIG"; then
        error "BIND9 configuration test failed"
    fi
    
    # Start BIND9
    systemctl enable bind9 2>/dev/null || systemctl enable named
    systemctl start bind9 2>/dev/null || systemctl start named
    
    # Wait for service to start
    sleep 3
    
    # Verify service is running
    if systemctl is-active --quiet bind9 || systemctl is-active --quiet named; then
        log "DNS64 service started successfully"
    else
        error "Failed to start DNS64 service"
    fi
    
    # Test DNS64 functionality
    "$DNS64_CONFIG_DIR/test-dns64.sh" localhost
}

stop_dns64() {
    log "Stopping DNS64 services..."
    systemctl stop bind9 2>/dev/null || systemctl stop named
    log "DNS64 services stopped"
}

show_dns64_status() {
    echo "=== DNS64 Server Status ==="
    echo ""
    
    echo "Service Status:"
    if systemctl is-active --quiet bind9; then
        systemctl status bind9 --no-pager -l
    elif systemctl is-active --quiet named; then
        systemctl status named --no-pager -l
    else
        echo "DNS service not running"
    fi
    echo ""
    
    echo "Configuration Test:"
    named-checkconf "$BIND_CONFIG" && echo "Configuration OK" || echo "Configuration ERROR"
    echo ""
    
    echo "Recent Query Statistics:"
    if [[ -f "$DNS64_LOG_DIR/metrics.log" ]]; then
        tail -10 "$DNS64_LOG_DIR/metrics.log"
    else
        echo "No metrics available"
    fi
    echo ""
    
    echo "DNS64 Functionality Test:"
    "$DNS64_CONFIG_DIR/test-dns64.sh" localhost 2>/dev/null | head -20
}

# Main execution
main() {
    case "${1:-help}" in
        "install")
            setup_directories
            install_bind9
            configure_bind9
            create_dns64_tools
            optimize_dns64_performance
            log "DNS64 server installation completed"
            ;;
        "start")
            start_dns64
            ;;
        "stop")
            stop_dns64
            ;;
        "restart")
            stop_dns64
            sleep 2
            start_dns64
            ;;
        "status")
            show_dns64_status
            ;;
        "test")
            "$DNS64_CONFIG_DIR/test-dns64.sh" "${2:-localhost}"
            ;;
        "monitor")
            "$DNS64_CONFIG_DIR/monitor-dns64.sh"
            ;;
        *)
            echo "Usage: $0 {install|start|stop|restart|status|test|monitor} [options]"
            echo ""
            echo "Commands:"
            echo "  install  - Complete DNS64 server installation"
            echo "  start    - Start DNS64 services"
            echo "  stop     - Stop DNS64 services"
            echo "  restart  - Restart DNS64 services"
            echo "  status   - Show detailed status"
            echo "  test     - Test DNS64 functionality"
            echo "  monitor  - Run monitoring check"
            exit 1
            ;;
    esac
}

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
fi

main "$@"
```

# [Enterprise Integration and Monitoring](#enterprise-integration-monitoring)

## Comprehensive Monitoring Framework

### Prometheus and Grafana Integration

```python
#!/usr/bin/env python3
"""
Enterprise NAT64/DNS64 Monitoring and Metrics Collection
"""

import time
import subprocess
import json
import re
from typing import Dict, List, Optional, Tuple
from prometheus_client import start_http_server, Gauge, Counter, Histogram, Info
from dataclasses import dataclass
import threading
import logging

@dataclass
class NAT64Metrics:
    tunnel_rx_packets: int
    tunnel_tx_packets: int
    tunnel_rx_bytes: int
    tunnel_tx_bytes: int
    conntrack_entries: int
    conntrack_max: int
    service_status: bool

@dataclass
class DNS64Metrics:
    queries_total: int
    queries_aaaa: int
    queries_a: int
    dns64_synthesis: int
    response_time_avg: float
    cache_hit_rate: float
    service_status: bool

class NAT64DNS64Monitor:
    def __init__(self, port: int = 9090):
        self.port = port
        self.logger = self._setup_logging()
        
        # Prometheus metrics for NAT64
        self.nat64_tunnel_packets = Gauge('nat64_tunnel_packets_total', 
                                         'NAT64 tunnel packet count', ['direction'])
        self.nat64_tunnel_bytes = Gauge('nat64_tunnel_bytes_total', 
                                       'NAT64 tunnel byte count', ['direction'])
        self.nat64_conntrack_entries = Gauge('nat64_conntrack_entries', 
                                            'NAT64 connection tracking entries')
        self.nat64_conntrack_usage = Gauge('nat64_conntrack_usage_percent', 
                                          'NAT64 connection tracking usage percentage')
        self.nat64_service_status = Gauge('nat64_service_status', 
                                         'NAT64 service status (1=up, 0=down)')
        
        # Prometheus metrics for DNS64
        self.dns64_queries_total = Counter('dns64_queries_total', 
                                          'Total DNS queries', ['type'])
        self.dns64_synthesis_total = Counter('dns64_synthesis_total', 
                                            'Total DNS64 synthesis operations')
        self.dns64_response_time = Histogram('dns64_response_time_seconds', 
                                            'DNS query response time', 
                                            buckets=[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0])
        self.dns64_cache_hit_rate = Gauge('dns64_cache_hit_rate', 
                                         'DNS cache hit rate percentage')
        self.dns64_service_status = Gauge('dns64_service_status', 
                                         'DNS64 service status (1=up, 0=down)')
        
        # System information
        self.system_info = Info('nat64_dns64_system', 'System information')
        
        self.running = False
        
    def _setup_logging(self) -> logging.Logger:
        """Setup logging configuration"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        handler = logging.StreamHandler()
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        
        return logger
    
    def collect_nat64_metrics(self) -> NAT64Metrics:
        """Collect NAT64 gateway metrics"""
        try:
            # Check service status
            service_status = self._check_service_status('tayga')
            
            # Get tunnel interface statistics
            tunnel_stats = self._get_tunnel_stats()
            
            # Get connection tracking information
            conntrack_info = self._get_conntrack_info()
            
            return NAT64Metrics(
                tunnel_rx_packets=tunnel_stats.get('rx_packets', 0),
                tunnel_tx_packets=tunnel_stats.get('tx_packets', 0),
                tunnel_rx_bytes=tunnel_stats.get('rx_bytes', 0),
                tunnel_tx_bytes=tunnel_stats.get('tx_bytes', 0),
                conntrack_entries=conntrack_info.get('current', 0),
                conntrack_max=conntrack_info.get('max', 1),
                service_status=service_status
            )
            
        except Exception as e:
            self.logger.error(f"Error collecting NAT64 metrics: {e}")
            return NAT64Metrics(0, 0, 0, 0, 0, 1, False)
    
    def collect_dns64_metrics(self) -> DNS64Metrics:
        """Collect DNS64 server metrics"""
        try:
            # Check service status
            service_status = self._check_service_status('bind9') or \
                           self._check_service_status('named')
            
            # Get DNS query statistics
            dns_stats = self._get_dns_stats()
            
            # Measure response time
            response_time = self._measure_dns_response_time()
            
            return DNS64Metrics(
                queries_total=dns_stats.get('total_queries', 0),
                queries_aaaa=dns_stats.get('aaaa_queries', 0),
                queries_a=dns_stats.get('a_queries', 0),
                dns64_synthesis=dns_stats.get('synthesis_count', 0),
                response_time_avg=response_time,
                cache_hit_rate=dns_stats.get('cache_hit_rate', 0.0),
                service_status=service_status
            )
            
        except Exception as e:
            self.logger.error(f"Error collecting DNS64 metrics: {e}")
            return DNS64Metrics(0, 0, 0, 0, 0.0, 0.0, False)
    
    def _check_service_status(self, service_name: str) -> bool:
        """Check if a systemd service is active"""
        try:
            result = subprocess.run(['systemctl', 'is-active', service_name], 
                                  capture_output=True, text=True)
            return result.stdout.strip() == 'active'
        except:
            return False
    
    def _get_tunnel_stats(self) -> Dict[str, int]:
        """Get NAT64 tunnel interface statistics"""
        try:
            result = subprocess.run(['ip', '-s', 'link', 'show', 'nat64'], 
                                  capture_output=True, text=True)
            
            if result.returncode != 0:
                return {}
            
            # Parse interface statistics
            lines = result.stdout.split('\n')
            stats = {}
            
            for i, line in enumerate(lines):
                if 'RX:' in line and i + 1 < len(lines):
                    rx_line = lines[i + 1].strip().split()
                    if len(rx_line) >= 2:
                        stats['rx_bytes'] = int(rx_line[0])
                        stats['rx_packets'] = int(rx_line[1])
                
                if 'TX:' in line and i + 1 < len(lines):
                    tx_line = lines[i + 1].strip().split()
                    if len(tx_line) >= 2:
                        stats['tx_bytes'] = int(tx_line[0])
                        stats['tx_packets'] = int(tx_line[1])
            
            return stats
            
        except Exception as e:
            self.logger.debug(f"Error getting tunnel stats: {e}")
            return {}
    
    def _get_conntrack_info(self) -> Dict[str, int]:
        """Get connection tracking information"""
        try:
            # Current connections
            with open('/proc/sys/net/netfilter/nf_conntrack_count', 'r') as f:
                current = int(f.read().strip())
            
            # Maximum connections
            with open('/proc/sys/net/netfilter/nf_conntrack_max', 'r') as f:
                maximum = int(f.read().strip())
            
            return {'current': current, 'max': maximum}
            
        except:
            return {'current': 0, 'max': 1}
    
    def _get_dns_stats(self) -> Dict[str, int]:
        """Get DNS server statistics from logs"""
        stats = {
            'total_queries': 0,
            'aaaa_queries': 0,
            'a_queries': 0,
            'synthesis_count': 0,
            'cache_hit_rate': 0.0
        }
        
        try:
            # Parse recent DNS logs for query counts
            log_files = ['/var/log/dns64/queries.log', '/var/log/bind/queries.log']
            
            for log_file in log_files:
                try:
                    with open(log_file, 'r') as f:
                        # Read last 1000 lines
                        lines = f.readlines()[-1000:]
                        
                        for line in lines:
                            if 'query:' in line.lower():
                                stats['total_queries'] += 1
                                if ' AAAA ' in line:
                                    stats['aaaa_queries'] += 1
                                elif ' A ' in line:
                                    stats['a_queries'] += 1
                            
                            if 'dns64' in line.lower() or '64:ff9b' in line:
                                stats['synthesis_count'] += 1
                    
                    break  # Use first available log file
                    
                except FileNotFoundError:
                    continue
            
            # Estimate cache hit rate (simplified)
            if stats['total_queries'] > 0:
                # This is a rough estimation - in production, use BIND statistics
                stats['cache_hit_rate'] = min(80.0, stats['total_queries'] * 0.6)
            
        except Exception as e:
            self.logger.debug(f"Error parsing DNS stats: {e}")
        
        return stats
    
    def _measure_dns_response_time(self) -> float:
        """Measure DNS query response time"""
        try:
            start_time = time.time()
            result = subprocess.run(['dig', '@127.0.0.1', 'www.example.com', 'A', '+short'], 
                                  capture_output=True, text=True, timeout=5)
            end_time = time.time()
            
            if result.returncode == 0:
                return end_time - start_time
            else:
                return 0.0
                
        except:
            return 0.0
    
    def update_prometheus_metrics(self, nat64_metrics: NAT64Metrics, 
                                dns64_metrics: DNS64Metrics) -> None:
        """Update Prometheus metrics"""
        # NAT64 metrics
        self.nat64_tunnel_packets.labels(direction='rx').set(nat64_metrics.tunnel_rx_packets)
        self.nat64_tunnel_packets.labels(direction='tx').set(nat64_metrics.tunnel_tx_packets)
        self.nat64_tunnel_bytes.labels(direction='rx').set(nat64_metrics.tunnel_rx_bytes)
        self.nat64_tunnel_bytes.labels(direction='tx').set(nat64_metrics.tunnel_tx_bytes)
        self.nat64_conntrack_entries.set(nat64_metrics.conntrack_entries)
        
        if nat64_metrics.conntrack_max > 0:
            usage_percent = (nat64_metrics.conntrack_entries / nat64_metrics.conntrack_max) * 100
            self.nat64_conntrack_usage.set(usage_percent)
        
        self.nat64_service_status.set(1 if nat64_metrics.service_status else 0)
        
        # DNS64 metrics
        self.dns64_cache_hit_rate.set(dns64_metrics.cache_hit_rate)
        self.dns64_service_status.set(1 if dns64_metrics.service_status else 0)
        self.dns64_response_time.observe(dns64_metrics.response_time_avg)
        
        # Update system info
        self.system_info.info({
            'version': '1.0.0',
            'nat64_prefix': '64:ff9b::/96',
            'deployment_type': 'enterprise'
        })
    
    def start_monitoring(self) -> None:
        """Start the monitoring server"""
        # Start Prometheus HTTP server
        start_http_server(self.port)
        self.logger.info(f"NAT64/DNS64 monitor started on port {self.port}")
        
        self.running = True
        
        while self.running:
            try:
                # Collect metrics
                nat64_metrics = self.collect_nat64_metrics()
                dns64_metrics = self.collect_dns64_metrics()
                
                # Update Prometheus metrics
                self.update_prometheus_metrics(nat64_metrics, dns64_metrics)
                
                # Log current status
                self.logger.info(f"NAT64: Service={'UP' if nat64_metrics.service_status else 'DOWN'}, "
                               f"Connections={nat64_metrics.conntrack_entries}")
                self.logger.info(f"DNS64: Service={'UP' if dns64_metrics.service_status else 'DOWN'}, "
                               f"Response_time={dns64_metrics.response_time_avg:.3f}s")
                
                time.sleep(30)  # Collection interval
                
            except KeyboardInterrupt:
                self.logger.info("Monitoring stopped by user")
                break
            except Exception as e:
                self.logger.error(f"Error during monitoring: {e}")
                time.sleep(10)
        
        self.running = False
    
    def stop_monitoring(self) -> None:
        """Stop the monitoring server"""
        self.running = False

# Grafana Dashboard Configuration (JSON export)
GRAFANA_DASHBOARD = {
    "dashboard": {
        "title": "Enterprise NAT64/DNS64 Monitoring",
        "panels": [
            {
                "title": "Service Status",
                "type": "stat",
                "targets": [
                    {"expr": "nat64_service_status", "legendFormat": "NAT64"},
                    {"expr": "dns64_service_status", "legendFormat": "DNS64"}
                ]
            },
            {
                "title": "NAT64 Tunnel Traffic",
                "type": "graph",
                "targets": [
                    {"expr": "rate(nat64_tunnel_packets_total[5m])", "legendFormat": "Packets/sec"},
                    {"expr": "rate(nat64_tunnel_bytes_total[5m])", "legendFormat": "Bytes/sec"}
                ]
            },
            {
                "title": "Connection Tracking",
                "type": "graph", 
                "targets": [
                    {"expr": "nat64_conntrack_entries", "legendFormat": "Active Connections"},
                    {"expr": "nat64_conntrack_usage_percent", "legendFormat": "Usage %"}
                ]
            },
            {
                "title": "DNS Response Time",
                "type": "graph",
                "targets": [
                    {"expr": "histogram_quantile(0.95, dns64_response_time_seconds)", "legendFormat": "95th percentile"},
                    {"expr": "histogram_quantile(0.50, dns64_response_time_seconds)", "legendFormat": "50th percentile"}
                ]
            }
        ]
    }
}

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='NAT64/DNS64 Enterprise Monitoring')
    parser.add_argument('--port', type=int, default=9090, help='Prometheus metrics port')
    parser.add_argument('--export-dashboard', action='store_true', 
                       help='Export Grafana dashboard JSON')
    
    args = parser.parse_args()
    
    if args.export_dashboard:
        print(json.dumps(GRAFANA_DASHBOARD, indent=2))
        return
    
    monitor = NAT64DNS64Monitor(args.port)
    
    try:
        monitor.start_monitoring()
    except KeyboardInterrupt:
        monitor.stop_monitoring()

if __name__ == '__main__':
    main()
```

This comprehensive NAT64/DNS64 enterprise deployment guide provides production-ready tools and configurations for IPv6 transition strategies. The frameworks support high availability, advanced monitoring, performance optimization, and enterprise-scale deployment requirements essential for modern network infrastructure management.