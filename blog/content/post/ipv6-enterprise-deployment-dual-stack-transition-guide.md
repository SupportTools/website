---
title: "Enterprise IPv6 Deployment and Dual-Stack Transition: Complete Guide to Production IPv6 Implementation and Network Migration"
date: 2025-04-22T10:00:00-05:00
draft: false
tags: ["IPv6", "Dual-Stack", "Network Migration", "Enterprise Networking", "IPv4 Transition", "Network Architecture", "Tunneling", "Enterprise Infrastructure"]
categories:
- Network Engineering
- IPv6 Implementation
- Enterprise Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive enterprise guide to IPv6 deployment, dual-stack implementation, network migration strategies, tunneling solutions, and production-grade IPv6 infrastructure for modern data centers"
more_link: "yes"
url: "/ipv6-enterprise-deployment-dual-stack-transition-guide/"
---

IPv6 deployment in enterprise environments requires comprehensive planning, strategic implementation approaches, and sophisticated transition mechanisms to ensure business continuity while modernizing network infrastructure. This guide covers enterprise IPv6 architecture design, dual-stack implementation strategies, migration methodologies, and production-grade deployment frameworks for large-scale organizational networks.

<!--more-->

# [IPv6 Enterprise Architecture Overview](#ipv6-enterprise-architecture-overview)

## IPv6 Transition Strategies and Timeline

Enterprise IPv6 adoption demands careful planning across multiple network layers, considering legacy system compatibility, security requirements, and operational continuity throughout the transition process.

### IPv6 Deployment Models Comparison

```
┌─────────────────────────────────────────────────────────────────┐
│                 Enterprise IPv6 Deployment Models               │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│   Dual-Stack    │   IPv6-Only     │   Tunneling     │  Hybrid   │
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ IPv4 Stack  │ │ │    IPv6     │ │ │ IPv6 over   │ │ │Mixed  │ │
│ │     +       │ │ │    Only     │ │ │ IPv4 Tunnel │ │ │Deploy │ │
│ │ IPv6 Stack  │ │ │ + NAT64/64  │ │ │   (6to4)    │ │ │Models │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ Pros:           │ Pros:           │ Pros:           │ Pros:     │
│ • Compatibility │ • Simplified    │ • Gradual       │ • Flexible│
│ • Gradual       │ • Future-proof  │ • Low impact    │ • Adaptive│
│                 │ • Performance   │ • Cost effective│           │
│ Cons:           │ Cons:           │ Cons:           │ Cons:     │
│ • Complexity    │ • Legacy issues │ • Performance   │ • Complex │
│ • Resource use  │ • Migration     │ • Reliability   │ • Costly  │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Enterprise IPv6 Implementation Phases

| Phase | Duration | Focus Areas | Complexity | Risk Level |
|-------|----------|-------------|------------|------------|
| **Planning** | 3-6 months | Architecture, addressing, security | Medium | Low |
| **Pilot** | 2-4 months | Limited deployment, testing | Medium | Medium |
| **Infrastructure** | 6-12 months | Core network, services | High | Medium |
| **Application Migration** | 12-24 months | Application compatibility | Very High | High |
| **Legacy Sunset** | 6-18 months | IPv4 decommissioning | High | Medium |

## IPv6 Address Architecture and Planning

### Enterprise IPv6 Addressing Framework

```python
#!/usr/bin/env python3
"""
Enterprise IPv6 Address Planning and Management System
"""

import ipaddress
import json
import yaml
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path
import logging

@dataclass
class IPv6Subnet:
    network: str
    purpose: str
    location: str
    vlan_id: Optional[int] = None
    security_zone: str = "internal"
    delegation_level: int = 64
    allocated: bool = False
    notes: str = ""

@dataclass
class IPv6Site:
    site_code: str
    site_name: str
    region: str
    site_prefix: str  # e.g., /48 or /56
    subnets: List[IPv6Subnet]
    border_routers: List[str]
    dns_servers: List[str]

class IPv6AddressManager:
    def __init__(self, config_file: str = "ipv6_config.yaml"):
        self.config_file = Path(config_file)
        self.sites: Dict[str, IPv6Site] = {}
        self.global_prefix = None
        self.reserved_prefixes = []
        
        self.logger = self._setup_logging()
        self._load_configuration()
    
    def _setup_logging(self) -> logging.Logger:
        """Setup logging configuration"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        handler = logging.StreamHandler()
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        
        return logger
    
    def _load_configuration(self) -> None:
        """Load IPv6 configuration from file"""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    config = yaml.safe_load(f)
                
                self.global_prefix = config.get('global_prefix')
                self.reserved_prefixes = config.get('reserved_prefixes', [])
                
                for site_data in config.get('sites', []):
                    site = IPv6Site(
                        site_code=site_data['site_code'],
                        site_name=site_data['site_name'],
                        region=site_data['region'],
                        site_prefix=site_data['site_prefix'],
                        subnets=[IPv6Subnet(**subnet) for subnet in site_data.get('subnets', [])],
                        border_routers=site_data.get('border_routers', []),
                        dns_servers=site_data.get('dns_servers', [])
                    )
                    self.sites[site.site_code] = site
                
                self.logger.info(f"Loaded configuration for {len(self.sites)} sites")
                
            except Exception as e:
                self.logger.error(f"Failed to load configuration: {e}")
                self._create_default_config()
        else:
            self._create_default_config()
    
    def _create_default_config(self) -> None:
        """Create default IPv6 configuration"""
        self.global_prefix = "2001:db8::/32"  # Documentation prefix
        self.reserved_prefixes = [
            "2001:db8:ffff::/48",  # Reserved for special use
            "2001:db8:fffe::/48"   # Reserved for testing
        ]
        self.logger.info("Created default IPv6 configuration")
    
    def save_configuration(self) -> None:
        """Save current configuration to file"""
        config = {
            'global_prefix': self.global_prefix,
            'reserved_prefixes': self.reserved_prefixes,
            'sites': [
                {
                    'site_code': site.site_code,
                    'site_name': site.site_name,
                    'region': site.region,
                    'site_prefix': site.site_prefix,
                    'border_routers': site.border_routers,
                    'dns_servers': site.dns_servers,
                    'subnets': [asdict(subnet) for subnet in site.subnets]
                }
                for site in self.sites.values()
            ]
        }
        
        with open(self.config_file, 'w') as f:
            yaml.dump(config, f, default_flow_style=False)
        
        self.logger.info(f"Configuration saved to {self.config_file}")
    
    def allocate_site_prefix(self, site_code: str, prefix_size: int = 48) -> str:
        """Allocate a site prefix from the global allocation"""
        try:
            global_net = ipaddress.IPv6Network(self.global_prefix, strict=False)
            
            # Generate site prefixes based on global allocation
            site_prefixes = list(global_net.subnets(new_prefix=prefix_size))
            
            # Find first available prefix
            allocated_prefixes = [
                ipaddress.IPv6Network(site.site_prefix, strict=False) 
                for site in self.sites.values()
            ]
            
            for prefix in site_prefixes:
                if not any(prefix.overlaps(allocated) for allocated in allocated_prefixes):
                    return str(prefix)
            
            raise ValueError("No available site prefixes")
            
        except Exception as e:
            self.logger.error(f"Failed to allocate site prefix: {e}")
            raise
    
    def create_site(self, site_code: str, site_name: str, region: str, 
                   prefix_size: int = 48) -> IPv6Site:
        """Create a new site with allocated prefix"""
        if site_code in self.sites:
            raise ValueError(f"Site {site_code} already exists")
        
        site_prefix = self.allocate_site_prefix(site_code, prefix_size)
        
        site = IPv6Site(
            site_code=site_code,
            site_name=site_name,
            region=region,
            site_prefix=site_prefix,
            subnets=[],
            border_routers=[],
            dns_servers=[]
        )
        
        self.sites[site_code] = site
        self.logger.info(f"Created site {site_code} with prefix {site_prefix}")
        
        return site
    
    def allocate_subnet(self, site_code: str, purpose: str, location: str,
                       subnet_size: int = 64, vlan_id: Optional[int] = None,
                       security_zone: str = "internal") -> IPv6Subnet:
        """Allocate a subnet within a site"""
        if site_code not in self.sites:
            raise ValueError(f"Site {site_code} not found")
        
        site = self.sites[site_code]
        site_network = ipaddress.IPv6Network(site.site_prefix, strict=False)
        
        # Generate available subnets
        available_subnets = list(site_network.subnets(new_prefix=subnet_size))
        
        # Find allocated subnets
        allocated_networks = [
            ipaddress.IPv6Network(subnet.network, strict=False)
            for subnet in site.subnets
        ]
        
        # Find first available subnet
        for subnet_net in available_subnets:
            if not any(subnet_net.overlaps(allocated) for allocated in allocated_networks):
                subnet = IPv6Subnet(
                    network=str(subnet_net),
                    purpose=purpose,
                    location=location,
                    vlan_id=vlan_id,
                    security_zone=security_zone,
                    delegation_level=subnet_size,
                    allocated=True
                )
                
                site.subnets.append(subnet)
                self.logger.info(f"Allocated subnet {subnet_net} for {purpose} at {site_code}")
                
                return subnet
        
        raise ValueError(f"No available subnets in site {site_code}")
    
    def generate_standard_subnets(self, site_code: str) -> List[IPv6Subnet]:
        """Generate standard enterprise subnets for a site"""
        standard_subnets = [
            ("management", "Management Network", None, "management"),
            ("servers", "Server Network", 100, "dmz"),
            ("workstations", "Workstation Network", 200, "internal"),
            ("guest", "Guest Network", 300, "guest"),
            ("iot", "IoT Network", 400, "iot"),
            ("infrastructure", "Infrastructure Network", 500, "infrastructure")
        ]
        
        allocated_subnets = []
        
        for purpose, location, vlan_id, security_zone in standard_subnets:
            try:
                subnet = self.allocate_subnet(
                    site_code=site_code,
                    purpose=purpose,
                    location=location,
                    vlan_id=vlan_id,
                    security_zone=security_zone
                )
                allocated_subnets.append(subnet)
            except ValueError as e:
                self.logger.warning(f"Failed to allocate {purpose} subnet: {e}")
        
        return allocated_subnets
    
    def validate_addressing_plan(self) -> Dict[str, List[str]]:
        """Validate the current addressing plan for conflicts"""
        issues = {
            'overlapping_sites': [],
            'overlapping_subnets': [],
            'invalid_prefixes': [],
            'utilization_warnings': []
        }
        
        # Check for overlapping site prefixes
        site_networks = []
        for site in self.sites.values():
            try:
                network = ipaddress.IPv6Network(site.site_prefix, strict=False)
                site_networks.append((site.site_code, network))
            except ValueError:
                issues['invalid_prefixes'].append(f"Invalid site prefix: {site.site_prefix}")
        
        for i, (site1_code, net1) in enumerate(site_networks):
            for site2_code, net2 in site_networks[i+1:]:
                if net1.overlaps(net2):
                    issues['overlapping_sites'].append(f"{site1_code} overlaps with {site2_code}")
        
        # Check subnet utilization
        for site in self.sites.values():
            try:
                site_network = ipaddress.IPv6Network(site.site_prefix, strict=False)
                total_subnets = sum(1 for _ in site_network.subnets(new_prefix=64))
                used_subnets = len(site.subnets)
                
                utilization = (used_subnets / total_subnets) * 100
                
                if utilization > 80:
                    issues['utilization_warnings'].append(
                        f"Site {site.site_code} utilization: {utilization:.1f}%"
                    )
            except ValueError:
                continue
        
        return issues
    
    def generate_ipv6_deployment_report(self) -> str:
        """Generate comprehensive IPv6 deployment report"""
        report = []
        report.append("=" * 80)
        report.append("ENTERPRISE IPv6 DEPLOYMENT REPORT")
        report.append("=" * 80)
        report.append(f"Global Prefix: {self.global_prefix}")
        report.append(f"Total Sites: {len(self.sites)}")
        
        total_subnets = sum(len(site.subnets) for site in self.sites.values())
        report.append(f"Total Subnets: {total_subnets}")
        report.append("")
        
        # Site breakdown
        for site in self.sites.values():
            report.append(f"Site: {site.site_code} ({site.site_name})")
            report.append(f"  Region: {site.region}")
            report.append(f"  Prefix: {site.site_prefix}")
            report.append(f"  Subnets: {len(site.subnets)}")
            
            if site.subnets:
                report.append("  Subnet Allocation:")
                for subnet in site.subnets:
                    vlan_info = f" (VLAN {subnet.vlan_id})" if subnet.vlan_id else ""
                    report.append(f"    {subnet.network} - {subnet.purpose}{vlan_info}")
            
            report.append("")
        
        # Validation issues
        issues = self.validate_addressing_plan()
        if any(issues.values()):
            report.append("ADDRESSING PLAN ISSUES:")
            report.append("-" * 30)
            
            for issue_type, issue_list in issues.items():
                if issue_list:
                    report.append(f"{issue_type.replace('_', ' ').title()}:")
                    for issue in issue_list:
                        report.append(f"  - {issue}")
                    report.append("")
        else:
            report.append("✓ No addressing plan issues detected")
        
        report.append("=" * 80)
        
        return "\n".join(report)

# Example enterprise IPv6 setup
def setup_enterprise_ipv6():
    """Example of enterprise IPv6 address planning"""
    manager = IPv6AddressManager()
    manager.global_prefix = "2001:db8::/32"  # Replace with actual allocation
    
    # Create sites
    sites_config = [
        ("HQ", "Headquarters", "North America"),
        ("DC1", "Primary Data Center", "North America"),
        ("DC2", "Secondary Data Center", "Europe"),
        ("BR1", "Regional Branch 1", "Asia Pacific"),
        ("BR2", "Regional Branch 2", "Europe")
    ]
    
    for site_code, site_name, region in sites_config:
        site = manager.create_site(site_code, site_name, region)
        
        # Generate standard subnets for each site
        manager.generate_standard_subnets(site_code)
        
        # Add site-specific configurations
        if site_code in ["DC1", "DC2"]:
            # Data centers get additional subnets
            manager.allocate_subnet(site_code, "database", "Database Tier", 64, 700, "database")
            manager.allocate_subnet(site_code, "storage", "Storage Network", 64, 800, "storage")
            manager.allocate_subnet(site_code, "backup", "Backup Network", 64, 900, "backup")
    
    # Save configuration
    manager.save_configuration()
    
    # Generate report
    print(manager.generate_ipv6_deployment_report())
    
    return manager

if __name__ == "__main__":
    setup_enterprise_ipv6()
```

# [Dual-Stack Implementation Strategy](#dual-stack-implementation-strategy)

## Enterprise Dual-Stack Network Configuration

### Advanced Network Infrastructure Setup

```bash
#!/bin/bash
# Enterprise Dual-Stack IPv4/IPv6 Network Configuration Framework

set -euo pipefail

# Configuration variables
DEPLOYMENT_CONFIG="/etc/network/ipv6-deployment.conf"
LOG_DIR="/var/log/ipv6-deployment"
BACKUP_DIR="/opt/network-backup/$(date +%Y%m%d_%H%M%S)"

# Network configuration
IPV6_PREFIX="${IPV6_PREFIX:-2001:db8::/64}"
IPV4_NETWORK="${IPV4_NETWORK:-192.168.0.0/24}"
ROUTER_IPV6="${ROUTER_IPV6:-2001:db8::1}"
ROUTER_IPV4="${ROUTER_IPV4:-192.168.0.1}"
DNS_SERVERS_IPV6="${DNS_SERVERS_IPV6:-2001:4860:4860::8888,2001:4860:4860::8844}"
DNS_SERVERS_IPV4="${DNS_SERVERS_IPV4:-8.8.8.8,8.8.4.4}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging functions
log() { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; }
error() { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; exit 1; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; }

# Setup environment
setup_environment() {
    log "Setting up IPv6 deployment environment..."
    
    mkdir -p "$LOG_DIR" "$BACKUP_DIR"
    chmod 755 "$LOG_DIR"
    chmod 700 "$BACKUP_DIR"
    
    # Backup current network configuration
    backup_network_config
    
    # Install required packages
    install_network_tools
    
    success "Environment setup completed"
}

# Backup existing network configuration
backup_network_config() {
    log "Backing up current network configuration..."
    
    local backup_files=(
        "/etc/network/interfaces"
        "/etc/netplan/*.yaml"
        "/etc/systemd/network/*.network"
        "/etc/resolv.conf"
        "/etc/hosts"
        "/proc/sys/net/ipv6/conf/all/disable_ipv6"
    )
    
    for file_pattern in "${backup_files[@]}"; do
        if ls $file_pattern >/dev/null 2>&1; then
            cp -r $file_pattern "$BACKUP_DIR/" 2>/dev/null || true
        fi
    done
    
    # Backup routing table
    ip route show > "$BACKUP_DIR/ipv4_routes.txt"
    ip -6 route show > "$BACKUP_DIR/ipv6_routes.txt" 2>/dev/null || true
    
    success "Network configuration backed up to $BACKUP_DIR"
}

# Install required network tools
install_network_tools() {
    log "Installing required network tools..."
    
    local tools=(
        "iputils-ping"
        "traceroute"
        "mtr"
        "tcpdump"
        "netcat-openbsd"
        "dnsutils"
        "bridge-utils"
        "vlan"
        "net-tools"
    )
    
    if command -v apt >/dev/null 2>&1; then
        apt update
        apt install -y "${tools[@]}"
    elif command -v yum >/dev/null 2>&1; then
        yum install -y "${tools[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y "${tools[@]}"
    fi
    
    success "Network tools installed"
}

# Enable IPv6 support
enable_ipv6() {
    log "Enabling IPv6 support..."
    
    # Enable IPv6 in kernel
    echo 0 > /proc/sys/net/ipv6/conf/all/disable_ipv6
    echo 0 > /proc/sys/net/ipv6/conf/default/disable_ipv6
    
    # Make persistent
    cat > "/etc/sysctl.d/99-ipv6.conf" << EOF
# IPv6 Configuration
net.ipv6.conf.all.disable_ipv6 = 0
net.ipv6.conf.default.disable_ipv6 = 0
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.default.forwarding = 1

# IPv6 Router Advertisement
net.ipv6.conf.all.accept_ra = 1
net.ipv6.conf.default.accept_ra = 1
net.ipv6.conf.all.accept_ra_defrtr = 1
net.ipv6.conf.default.accept_ra_defrtr = 1

# Privacy extensions (for client systems)
net.ipv6.conf.all.use_tempaddr = 2
net.ipv6.conf.default.use_tempaddr = 2

# IPv6 Security
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
EOF
    
    sysctl -p /etc/sysctl.d/99-ipv6.conf
    
    success "IPv6 support enabled"
}

# Configure dual-stack networking
configure_dual_stack() {
    log "Configuring dual-stack networking..."
    
    # Detect network configuration method
    if [[ -d /etc/netplan ]]; then
        configure_netplan_dual_stack
    elif [[ -f /etc/network/interfaces ]]; then
        configure_interfaces_dual_stack
    elif [[ -d /etc/systemd/network ]]; then
        configure_systemd_networkd_dual_stack
    else
        warn "Unknown network configuration method, manual configuration required"
        return 1
    fi
    
    success "Dual-stack networking configured"
}

# Configure dual-stack with Netplan (Ubuntu 18.04+)
configure_netplan_dual_stack() {
    log "Configuring dual-stack with Netplan..."
    
    local interface
    interface=$(ip route | grep default | awk '{print $5}' | head -1)
    
    if [[ -z "$interface" ]]; then
        error "Could not detect primary network interface"
    fi
    
    cat > "/etc/netplan/99-dual-stack.yaml" << EOF
network:
  version: 2
  ethernets:
    $interface:
      dhcp4: true
      dhcp6: true
      addresses:
        - $IPV6_PREFIX
      nameservers:
        addresses:
          - ${DNS_SERVERS_IPV4//,/ }
          - ${DNS_SERVERS_IPV6//,/ }
      routes:
        - to: "::/0"
          via: "$ROUTER_IPV6"
          metric: 100
      accept-ra: true
      ipv6-privacy: true
EOF
    
    # Test and apply configuration
    if netplan try --timeout 30; then
        netplan apply
        success "Netplan dual-stack configuration applied"
    else
        error "Netplan configuration failed"
    fi
}

# Configure dual-stack with traditional interfaces file
configure_interfaces_dual_stack() {
    log "Configuring dual-stack with /etc/network/interfaces..."
    
    local interface
    interface=$(ip route | grep default | awk '{print $5}' | head -1)
    
    cat >> "/etc/network/interfaces" << EOF

# Dual-Stack IPv6 Configuration
iface $interface inet6 static
    address $IPV6_PREFIX
    gateway $ROUTER_IPV6
    dns-nameservers ${DNS_SERVERS_IPV6//,/ }
    accept_ra 1
    privext 2
EOF
    
    # Restart networking
    systemctl restart networking
    
    success "Traditional interfaces dual-stack configuration applied"
}

# Configure dual-stack with systemd-networkd
configure_systemd_networkd_dual_stack() {
    log "Configuring dual-stack with systemd-networkd..."
    
    local interface
    interface=$(ip route | grep default | awk '{print $5}' | head -1)
    
    cat > "/etc/systemd/network/50-dual-stack.network" << EOF
[Match]
Name=$interface

[Network]
DHCP=yes
IPv6AcceptRA=yes
IPForward=yes

[Address]
Address=$IPV6_PREFIX

[Route]
Gateway=$ROUTER_IPV6
Destination=::/0

[DHCPv4]
UseDNS=yes

[DHCPv6]
UseDNS=yes

[IPv6AcceptRA]
UseDNS=yes
EOF
    
    systemctl enable systemd-networkd
    systemctl restart systemd-networkd
    
    success "systemd-networkd dual-stack configuration applied"
}

# Configure advanced IPv6 features
configure_advanced_ipv6() {
    log "Configuring advanced IPv6 features..."
    
    # IPv6 Router Advertisement Daemon (if this is a router)
    if [[ "${ENABLE_RADVD:-false}" == "true" ]]; then
        configure_radvd
    fi
    
    # IPv6 Neighbor Discovery optimization
    configure_neighbor_discovery
    
    # IPv6 security configurations
    configure_ipv6_security
    
    success "Advanced IPv6 features configured"
}

# Configure Router Advertisement Daemon
configure_radvd() {
    log "Configuring Router Advertisement Daemon..."
    
    if ! command -v radvd >/dev/null 2>&1; then
        if command -v apt >/dev/null 2>&1; then
            apt install -y radvd
        else
            warn "radvd not available, skipping router advertisement configuration"
            return
        fi
    fi
    
    local interface
    interface=$(ip route | grep default | awk '{print $5}' | head -1)
    
    cat > "/etc/radvd.conf" << EOF
# Router Advertisement Configuration
interface $interface {
    AdvSendAdvert on;
    MinRtrAdvInterval 3;
    MaxRtrAdvInterval 10;
    AdvHomeAgentFlag off;
    AdvManagedFlag on;
    AdvOtherConfigFlag on;
    
    prefix $IPV6_PREFIX {
        AdvOnLink on;
        AdvAutonomous on;
        AdvRouterAddr off;
    };
    
    RDNSS ${DNS_SERVERS_IPV6//,/ } {
        AdvRDNSSLifetime 300;
    };
};
EOF
    
    systemctl enable radvd
    systemctl restart radvd
    
    success "Router Advertisement Daemon configured"
}

# Configure neighbor discovery optimization
configure_neighbor_discovery() {
    log "Configuring IPv6 neighbor discovery optimization..."
    
    cat >> "/etc/sysctl.d/99-ipv6.conf" << EOF

# Neighbor Discovery Optimization
net.ipv6.neigh.default.gc_thresh1 = 1024
net.ipv6.neigh.default.gc_thresh2 = 2048
net.ipv6.neigh.default.gc_thresh3 = 4096
net.ipv6.neigh.default.base_reachable_time_ms = 30000
net.ipv6.neigh.default.retrans_time_ms = 1000
EOF
    
    sysctl -p /etc/sysctl.d/99-ipv6.conf
}

# Configure IPv6 security
configure_ipv6_security() {
    log "Configuring IPv6 security settings..."
    
    # Install and configure ip6tables
    if command -v apt >/dev/null 2>&1; then
        apt install -y iptables-persistent netfilter-persistent
    fi
    
    # Basic IPv6 firewall rules
    cat > "/etc/ip6tables/rules.v6" << EOF
# IPv6 Firewall Rules
*filter

# Default policies
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]

# Allow loopback
-A INPUT -i lo -j ACCEPT

# Allow established and related connections
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow ICMPv6 (essential for IPv6)
-A INPUT -p icmpv6 -j ACCEPT

# Allow SSH
-A INPUT -p tcp --dport 22 -j ACCEPT

# Allow DHCPv6
-A INPUT -p udp --dport 546 -j ACCEPT

# Allow Router Advertisements (if client)
-A INPUT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT

# Allow Neighbor Discovery
-A INPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT
-A INPUT -p icmpv6 --icmpv6-type neighbor-advertisement -j ACCEPT

COMMIT
EOF
    
    # Apply rules
    ip6tables-restore < /etc/ip6tables/rules.v6
    
    # Save configuration
    if command -v netfilter-persistent >/dev/null 2>&1; then
        netfilter-persistent save
    fi
    
    success "IPv6 security configured"
}

# Network connectivity testing
test_connectivity() {
    log "Testing dual-stack connectivity..."
    
    local test_results=()
    
    # Test IPv4 connectivity
    if ping -c 3 8.8.8.8 >/dev/null 2>&1; then
        test_results+=("✓ IPv4 connectivity: PASS")
    else
        test_results+=("✗ IPv4 connectivity: FAIL")
    fi
    
    # Test IPv6 connectivity
    if ping6 -c 3 2001:4860:4860::8888 >/dev/null 2>&1; then
        test_results+=("✓ IPv6 connectivity: PASS")
    else
        test_results+=("✗ IPv6 connectivity: FAIL")
    fi
    
    # Test DNS resolution (IPv4)
    if nslookup google.com 8.8.8.8 >/dev/null 2>&1; then
        test_results+=("✓ IPv4 DNS resolution: PASS")
    else
        test_results+=("✗ IPv4 DNS resolution: FAIL")
    fi
    
    # Test DNS resolution (IPv6)
    if nslookup google.com 2001:4860:4860::8888 >/dev/null 2>&1; then
        test_results+=("✓ IPv6 DNS resolution: PASS")
    else
        test_results+=("✗ IPv6 DNS resolution: FAIL")
    fi
    
    # Display results
    echo ""
    echo "=== Connectivity Test Results ==="
    for result in "${test_results[@]}"; do
        if [[ "$result" == *"PASS"* ]]; then
            echo -e "${GREEN}$result${NC}"
        else
            echo -e "${RED}$result${NC}"
        fi
    done
    echo ""
}

# Generate network status report
generate_status_report() {
    local report_file="$LOG_DIR/network_status_$(date +%Y%m%d_%H%M%S).txt"
    
    log "Generating network status report..."
    
    {
        echo "DUAL-STACK NETWORK STATUS REPORT"
        echo "================================"
        echo "Generated: $(date)"
        echo ""
        
        echo "IPv4 Configuration:"
        echo "==================="
        ip -4 addr show
        echo ""
        ip -4 route show
        echo ""
        
        echo "IPv6 Configuration:"
        echo "==================="
        ip -6 addr show
        echo ""
        ip -6 route show
        echo ""
        
        echo "DNS Configuration:"
        echo "=================="
        cat /etc/resolv.conf
        echo ""
        
        echo "Network Interfaces:"
        echo "==================="
        ip link show
        echo ""
        
        echo "Connectivity Tests:"
        echo "==================="
        ping -c 3 8.8.8.8 2>&1 || echo "IPv4 connectivity failed"
        echo ""
        ping6 -c 3 2001:4860:4860::8888 2>&1 || echo "IPv6 connectivity failed"
        echo ""
        
    } > "$report_file"
    
    success "Network status report generated: $report_file"
    
    # Display summary
    cat "$report_file" | head -50
}

# Monitoring and maintenance
setup_monitoring() {
    log "Setting up IPv6 monitoring..."
    
    # Create monitoring script
    cat > "/usr/local/bin/ipv6-monitor.sh" << 'EOF'
#!/bin/bash
# IPv6 Network Monitoring Script

LOG_FILE="/var/log/ipv6-deployment/monitor.log"
ALERT_THRESHOLD=3

check_ipv6_connectivity() {
    if ! ping6 -c 3 2001:4860:4860::8888 >/dev/null 2>&1; then
        echo "$(date): IPv6 connectivity lost" >> "$LOG_FILE"
        return 1
    fi
    return 0
}

check_ipv4_connectivity() {
    if ! ping -c 3 8.8.8.8 >/dev/null 2>&1; then
        echo "$(date): IPv4 connectivity lost" >> "$LOG_FILE"
        return 1
    fi
    return 0
}

check_dns_resolution() {
    if ! nslookup google.com >/dev/null 2>&1; then
        echo "$(date): DNS resolution failed" >> "$LOG_FILE"
        return 1
    fi
    return 0
}

# Main monitoring loop
failed_checks=0

if ! check_ipv6_connectivity; then
    ((failed_checks++))
fi

if ! check_ipv4_connectivity; then
    ((failed_checks++))
fi

if ! check_dns_resolution; then
    ((failed_checks++))
fi

if [[ $failed_checks -ge $ALERT_THRESHOLD ]]; then
    echo "$(date): CRITICAL: Multiple network failures detected" >> "$LOG_FILE"
    # Send alert (customize as needed)
    logger -p crit "IPv6 deployment: Multiple network failures detected"
fi
EOF

    chmod +x "/usr/local/bin/ipv6-monitor.sh"
    
    # Create systemd timer
    cat > "/etc/systemd/system/ipv6-monitor.service" << EOF
[Unit]
Description=IPv6 Network Monitoring
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ipv6-monitor.sh
User=root
EOF

    cat > "/etc/systemd/system/ipv6-monitor.timer" << EOF
[Unit]
Description=Run IPv6 monitoring every 5 minutes
Requires=ipv6-monitor.service

[Timer]
OnCalendar=*:*/5:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload
    systemctl enable ipv6-monitor.timer
    systemctl start ipv6-monitor.timer
    
    success "IPv6 monitoring configured"
}

# Main deployment function
main() {
    case "${1:-deploy}" in
        "deploy")
            log "Starting dual-stack IPv6 deployment..."
            setup_environment
            enable_ipv6
            configure_dual_stack
            configure_advanced_ipv6
            setup_monitoring
            test_connectivity
            generate_status_report
            success "Dual-stack IPv6 deployment completed successfully!"
            ;;
        "test")
            test_connectivity
            ;;
        "status")
            generate_status_report
            ;;
        "monitor")
            /usr/local/bin/ipv6-monitor.sh
            ;;
        "backup")
            backup_network_config
            ;;
        *)
            echo "Usage: $0 {deploy|test|status|monitor|backup}"
            echo ""
            echo "Commands:"
            echo "  deploy  - Complete dual-stack deployment"
            echo "  test    - Test network connectivity"
            echo "  status  - Generate status report"
            echo "  monitor - Run monitoring check"
            echo "  backup  - Backup network configuration"
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

# [IPv6 Tunneling Solutions](#ipv6-tunneling-solutions)

## Enterprise Tunneling Implementation

### Advanced 6to4 and Hurricane Electric Tunnel Configuration

```python
#!/usr/bin/env python3
"""
Enterprise IPv6 Tunneling Management System
Supports 6to4, 6in4, and Hurricane Electric Tunnel Broker
"""

import subprocess
import ipaddress
import json
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from pathlib import Path
import requests
import logging

@dataclass
class TunnelConfig:
    tunnel_type: str  # "6to4", "6in4", "he_tunnel"
    local_ipv4: str
    remote_ipv4: str
    tunnel_ipv6: str
    routed_prefix: str
    interface_name: str
    mtu: int = 1480
    enabled: bool = True

class IPv6TunnelManager:
    def __init__(self):
        self.tunnels: Dict[str, TunnelConfig] = {}
        self.config_file = Path("/etc/ipv6-tunnels.json")
        self.logger = self._setup_logging()
        
        # Hurricane Electric API endpoint
        self.he_api_base = "https://ipv4.tunnelbroker.net"
        
        self._load_configuration()
    
    def _setup_logging(self) -> logging.Logger:
        """Setup logging configuration"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        handler = logging.StreamHandler()
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        
        return logger
    
    def _load_configuration(self) -> None:
        """Load tunnel configurations from file"""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    config_data = json.load(f)
                
                for tunnel_name, tunnel_data in config_data.items():
                    self.tunnels[tunnel_name] = TunnelConfig(**tunnel_data)
                
                self.logger.info(f"Loaded {len(self.tunnels)} tunnel configurations")
                
            except Exception as e:
                self.logger.error(f"Failed to load tunnel configuration: {e}")
    
    def save_configuration(self) -> None:
        """Save tunnel configurations to file"""
        config_data = {}
        for tunnel_name, tunnel in self.tunnels.items():
            config_data[tunnel_name] = {
                'tunnel_type': tunnel.tunnel_type,
                'local_ipv4': tunnel.local_ipv4,
                'remote_ipv4': tunnel.remote_ipv4,
                'tunnel_ipv6': tunnel.tunnel_ipv6,
                'routed_prefix': tunnel.routed_prefix,
                'interface_name': tunnel.interface_name,
                'mtu': tunnel.mtu,
                'enabled': tunnel.enabled
            }
        
        with open(self.config_file, 'w') as f:
            json.dump(config_data, f, indent=2)
        
        self.logger.info("Tunnel configuration saved")
    
    def create_6to4_tunnel(self, name: str, local_ipv4: str) -> TunnelConfig:
        """Create 6to4 tunnel configuration"""
        try:
            # Calculate 6to4 prefix from IPv4 address
            ipv4_addr = ipaddress.IPv4Address(local_ipv4)
            ipv4_hex = f"{ipv4_addr:08x}"
            
            # 6to4 prefix: 2002::/16 + 32-bit IPv4 address
            tunnel_ipv6 = f"2002:{ipv4_hex[:4]}:{ipv4_hex[4:]}::1/64"
            routed_prefix = f"2002:{ipv4_hex[:4]}:{ipv4_hex[4:]}::/48"
            
            tunnel = TunnelConfig(
                tunnel_type="6to4",
                local_ipv4=local_ipv4,
                remote_ipv4="192.88.99.1",  # 6to4 anycast relay
                tunnel_ipv6=tunnel_ipv6,
                routed_prefix=routed_prefix,
                interface_name=f"6to4-{name}",
                mtu=1480
            )
            
            self.tunnels[name] = tunnel
            self.logger.info(f"Created 6to4 tunnel {name}")
            
            return tunnel
            
        except Exception as e:
            self.logger.error(f"Failed to create 6to4 tunnel: {e}")
            raise
    
    def create_he_tunnel(self, name: str, local_ipv4: str, tunnel_id: str,
                        tunnel_ipv6: str, routed_prefix: str, 
                        remote_ipv4: str) -> TunnelConfig:
        """Create Hurricane Electric tunnel configuration"""
        try:
            tunnel = TunnelConfig(
                tunnel_type="he_tunnel",
                local_ipv4=local_ipv4,
                remote_ipv4=remote_ipv4,
                tunnel_ipv6=tunnel_ipv6,
                routed_prefix=routed_prefix,
                interface_name=f"he-{name}",
                mtu=1480
            )
            
            self.tunnels[name] = tunnel
            self.logger.info(f"Created Hurricane Electric tunnel {name}")
            
            return tunnel
            
        except Exception as e:
            self.logger.error(f"Failed to create HE tunnel: {e}")
            raise
    
    def configure_tunnel_interface(self, tunnel_name: str) -> bool:
        """Configure tunnel interface using ip commands"""
        if tunnel_name not in self.tunnels:
            self.logger.error(f"Tunnel {tunnel_name} not found")
            return False
        
        tunnel = self.tunnels[tunnel_name]
        
        try:
            # Remove existing tunnel if it exists
            subprocess.run(['ip', 'tunnel', 'del', tunnel.interface_name], 
                         capture_output=True)
            
            if tunnel.tunnel_type == "6to4":
                # Create 6to4 tunnel
                subprocess.run([
                    'ip', 'tunnel', 'add', tunnel.interface_name,
                    'mode', 'sit',
                    'remote', tunnel.remote_ipv4,
                    'local', tunnel.local_ipv4,
                    'ttl', '64'
                ], check=True)
                
            elif tunnel.tunnel_type == "he_tunnel":
                # Create Hurricane Electric tunnel
                subprocess.run([
                    'ip', 'tunnel', 'add', tunnel.interface_name,
                    'mode', 'sit',
                    'remote', tunnel.remote_ipv4,
                    'local', tunnel.local_ipv4,
                    'ttl', '255'
                ], check=True)
            
            # Bring interface up
            subprocess.run(['ip', 'link', 'set', tunnel.interface_name, 'up'], 
                         check=True)
            
            # Set MTU
            subprocess.run(['ip', 'link', 'set', tunnel.interface_name, 
                          'mtu', str(tunnel.mtu)], check=True)
            
            # Add IPv6 address
            subprocess.run(['ip', '-6', 'addr', 'add', tunnel.tunnel_ipv6, 
                          'dev', tunnel.interface_name], check=True)
            
            # Add default route for 6to4
            if tunnel.tunnel_type == "6to4":
                subprocess.run(['ip', '-6', 'route', 'add', '2000::/3', 
                              'dev', tunnel.interface_name], check=True)
            else:
                subprocess.run(['ip', '-6', 'route', 'add', 'default', 
                              'dev', tunnel.interface_name], check=True)
            
            self.logger.info(f"Tunnel {tunnel_name} configured successfully")
            return True
            
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Failed to configure tunnel {tunnel_name}: {e}")
            return False
    
    def remove_tunnel_interface(self, tunnel_name: str) -> bool:
        """Remove tunnel interface"""
        if tunnel_name not in self.tunnels:
            self.logger.error(f"Tunnel {tunnel_name} not found")
            return False
        
        tunnel = self.tunnels[tunnel_name]
        
        try:
            # Remove tunnel interface
            subprocess.run(['ip', 'tunnel', 'del', tunnel.interface_name], 
                         check=True)
            
            self.logger.info(f"Tunnel {tunnel_name} removed successfully")
            return True
            
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Failed to remove tunnel {tunnel_name}: {e}")
            return False
    
    def test_tunnel_connectivity(self, tunnel_name: str) -> Dict[str, bool]:
        """Test tunnel connectivity"""
        if tunnel_name not in self.tunnels:
            return {"error": True}
        
        tunnel = self.tunnels[tunnel_name]
        results = {}
        
        try:
            # Test tunnel interface exists
            result = subprocess.run(['ip', 'link', 'show', tunnel.interface_name], 
                                  capture_output=True)
            results['interface_exists'] = result.returncode == 0
            
            # Test IPv6 connectivity through tunnel
            test_targets = [
                "2001:4860:4860::8888",  # Google DNS
                "2606:4700:4700::1111",  # Cloudflare DNS
            ]
            
            for target in test_targets:
                result = subprocess.run(['ping6', '-c', '3', '-I', 
                                       tunnel.interface_name, target], 
                                      capture_output=True, timeout=15)
                results[f'ping_{target}'] = result.returncode == 0
            
            # Test DNS resolution
            result = subprocess.run(['nslookup', 'google.com', 
                                   '2001:4860:4860::8888'], 
                                  capture_output=True, timeout=10)
            results['dns_resolution'] = result.returncode == 0
            
        except Exception as e:
            self.logger.error(f"Error testing tunnel {tunnel_name}: {e}")
            results['error'] = True
        
        return results
    
    def update_he_tunnel_endpoint(self, tunnel_name: str, username: str, 
                                 password: str, tunnel_id: str) -> bool:
        """Update Hurricane Electric tunnel endpoint IP"""
        if tunnel_name not in self.tunnels:
            return False
        
        tunnel = self.tunnels[tunnel_name]
        
        try:
            # Get current public IP
            response = requests.get('https://ipv4.icanhazip.com', timeout=10)
            current_ip = response.text.strip()
            
            # Update HE tunnel endpoint
            update_url = f"{self.he_api_base}/nic/update"
            params = {
                'hostname': tunnel_id,
                'myip': current_ip
            }
            
            response = requests.get(update_url, params=params, 
                                  auth=(username, password), timeout=10)
            
            if response.status_code == 200:
                # Update local configuration
                tunnel.local_ipv4 = current_ip
                self.save_configuration()
                
                # Reconfigure tunnel
                self.remove_tunnel_interface(tunnel_name)
                self.configure_tunnel_interface(tunnel_name)
                
                self.logger.info(f"Updated HE tunnel {tunnel_name} endpoint to {current_ip}")
                return True
            else:
                self.logger.error(f"Failed to update HE tunnel endpoint: {response.text}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error updating HE tunnel endpoint: {e}")
            return False
    
    def generate_startup_script(self) -> str:
        """Generate startup script for tunnel configuration"""
        script_lines = [
            "#!/bin/bash",
            "# IPv6 Tunnel Startup Script",
            "# Generated automatically - do not edit",
            "",
            "set -e",
            "",
            "# Function to configure tunnel",
            "configure_tunnel() {",
            "    local name=\"$1\"",
            "    local type=\"$2\"",
            "    local local_ip=\"$3\"",
            "    local remote_ip=\"$4\"",
            "    local tunnel_ipv6=\"$5\"",
            "    local interface=\"$6\"",
            "    local mtu=\"$7\"",
            "",
            "    echo \"Configuring tunnel: $name\"",
            "",
            "    # Remove existing tunnel",
            "    ip tunnel del \"$interface\" 2>/dev/null || true",
            "",
            "    # Create tunnel",
            "    ip tunnel add \"$interface\" mode sit remote \"$remote_ip\" local \"$local_ip\" ttl 64",
            "",
            "    # Configure interface",
            "    ip link set \"$interface\" up",
            "    ip link set \"$interface\" mtu \"$mtu\"",
            "    ip -6 addr add \"$tunnel_ipv6\" dev \"$interface\"",
            "",
            "    if [[ \"$type\" == \"6to4\" ]]; then",
            "        ip -6 route add 2000::/3 dev \"$interface\"",
            "    else",
            "        ip -6 route add default dev \"$interface\"",
            "    fi",
            "",
            "    echo \"Tunnel $name configured successfully\"",
            "}",
            "",
            "# Configure all tunnels"
        ]
        
        for tunnel_name, tunnel in self.tunnels.items():
            if tunnel.enabled:
                script_lines.append(f"configure_tunnel \"{tunnel_name}\" "
                                  f"\"{tunnel.tunnel_type}\" \"{tunnel.local_ipv4}\" "
                                  f"\"{tunnel.remote_ipv4}\" \"{tunnel.tunnel_ipv6}\" "
                                  f"\"{tunnel.interface_name}\" \"{tunnel.mtu}\"")
        
        script_lines.extend([
            "",
            "echo \"All tunnels configured\"",
            "exit 0"
        ])
        
        return "\n".join(script_lines)
    
    def create_systemd_service(self) -> None:
        """Create systemd service for tunnel management"""
        startup_script = "/usr/local/bin/ipv6-tunnels-startup.sh"
        
        # Write startup script
        with open(startup_script, 'w') as f:
            f.write(self.generate_startup_script())
        
        Path(startup_script).chmod(0o755)
        
        # Create systemd service
        service_content = f"""[Unit]
Description=IPv6 Tunnels
After=network.target
Wants=network.target

[Service]
Type=oneshot
ExecStart={startup_script}
ExecStop=/usr/local/bin/ipv6-tunnels-shutdown.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
        
        with open("/etc/systemd/system/ipv6-tunnels.service", 'w') as f:
            f.write(service_content)
        
        # Create shutdown script
        shutdown_script = """#!/bin/bash
# IPv6 Tunnels Shutdown Script

set -e

echo "Shutting down IPv6 tunnels..."

# Remove all tunnel interfaces
for tunnel in $(ip tunnel show | grep -E "(he-|6to4-)" | cut -d: -f1); do
    echo "Removing tunnel: $tunnel"
    ip tunnel del "$tunnel" 2>/dev/null || true
done

echo "All tunnels removed"
exit 0
"""
        
        with open("/usr/local/bin/ipv6-tunnels-shutdown.sh", 'w') as f:
            f.write(shutdown_script)
        
        Path("/usr/local/bin/ipv6-tunnels-shutdown.sh").chmod(0o755)
        
        # Enable service
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'enable', 'ipv6-tunnels.service'], check=True)
        
        self.logger.info("Systemd service created and enabled")

# Example usage and CLI interface
def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='IPv6 Tunnel Management System')
    parser.add_argument('action', choices=['create', 'remove', 'test', 'list', 'service'],
                       help='Action to perform')
    parser.add_argument('--name', help='Tunnel name')
    parser.add_argument('--type', choices=['6to4', 'he_tunnel'], help='Tunnel type')
    parser.add_argument('--local-ip', help='Local IPv4 address')
    parser.add_argument('--remote-ip', help='Remote IPv4 address')
    parser.add_argument('--tunnel-ipv6', help='Tunnel IPv6 address')
    parser.add_argument('--routed-prefix', help='Routed IPv6 prefix')
    parser.add_argument('--tunnel-id', help='Hurricane Electric tunnel ID')
    
    args = parser.parse_args()
    
    manager = IPv6TunnelManager()
    
    if args.action == 'create':
        if not args.name or not args.type or not args.local_ip:
            print("Error: --name, --type, and --local-ip are required for create")
            return 1
        
        if args.type == '6to4':
            tunnel = manager.create_6to4_tunnel(args.name, args.local_ip)
        elif args.type == 'he_tunnel':
            if not all([args.remote_ip, args.tunnel_ipv6, args.routed_prefix]):
                print("Error: HE tunnel requires --remote-ip, --tunnel-ipv6, and --routed-prefix")
                return 1
            tunnel = manager.create_he_tunnel(
                args.name, args.local_ip, args.tunnel_id or "",
                args.tunnel_ipv6, args.routed_prefix, args.remote_ip
            )
        
        manager.save_configuration()
        
        # Configure the tunnel
        if manager.configure_tunnel_interface(args.name):
            print(f"Tunnel {args.name} created and configured successfully")
        else:
            print(f"Tunnel {args.name} created but configuration failed")
    
    elif args.action == 'remove':
        if not args.name:
            print("Error: --name is required for remove")
            return 1
        
        if manager.remove_tunnel_interface(args.name):
            del manager.tunnels[args.name]
            manager.save_configuration()
            print(f"Tunnel {args.name} removed successfully")
        else:
            print(f"Failed to remove tunnel {args.name}")
    
    elif args.action == 'test':
        if not args.name:
            print("Error: --name is required for test")
            return 1
        
        results = manager.test_tunnel_connectivity(args.name)
        print(f"Connectivity test results for {args.name}:")
        for test, result in results.items():
            status = "PASS" if result else "FAIL"
            print(f"  {test}: {status}")
    
    elif args.action == 'list':
        print("Configured tunnels:")
        for name, tunnel in manager.tunnels.items():
            status = "Enabled" if tunnel.enabled else "Disabled"
            print(f"  {name} ({tunnel.tunnel_type}) - {status}")
            print(f"    Local: {tunnel.local_ipv4}")
            print(f"    Remote: {tunnel.remote_ipv4}")
            print(f"    IPv6: {tunnel.tunnel_ipv6}")
            print(f"    Prefix: {tunnel.routed_prefix}")
            print()
    
    elif args.action == 'service':
        manager.create_systemd_service()
        print("Systemd service created successfully")
    
    return 0

if __name__ == '__main__':
    exit(main())
```

# [Production IPv6 Monitoring and Management](#production-ipv6-monitoring-management)

## Enterprise IPv6 Operations Framework

### Comprehensive IPv6 Monitoring and Alerting System

```bash
#!/bin/bash
# Enterprise IPv6 Monitoring and Management System

set -euo pipefail

# Configuration
MONITORING_CONFIG="/etc/ipv6-monitoring.conf"
LOG_DIR="/var/log/ipv6-monitoring"
METRICS_DIR="/var/lib/ipv6-monitoring/metrics"
ALERT_SCRIPT="/usr/local/bin/ipv6-alert.sh"

# Default monitoring targets
DEFAULT_IPV6_TARGETS=(
    "2001:4860:4860::8888"  # Google DNS
    "2606:4700:4700::1111"  # Cloudflare DNS
    "2001:500:88:200::10"   # Root server
)

# Monitoring thresholds
PING_TIMEOUT=5
MAX_PACKET_LOSS=10
MAX_RTT_MS=200
DNS_TIMEOUT=5

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log() { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_DIR/monitor.log"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_DIR/monitor.log"; }
error() { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_DIR/monitor.log"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*" | tee -a "$LOG_DIR/monitor.log"; }

# Setup monitoring environment
setup_monitoring() {
    log "Setting up IPv6 monitoring environment..."
    
    mkdir -p "$LOG_DIR" "$METRICS_DIR"
    chmod 755 "$LOG_DIR" "$METRICS_DIR"
    
    # Create default configuration if it doesn't exist
    if [[ ! -f "$MONITORING_CONFIG" ]]; then
        create_default_config
    fi
    
    # Create alert script
    create_alert_script
    
    success "Monitoring environment setup completed"
}

# Create default monitoring configuration
create_default_config() {
    cat > "$MONITORING_CONFIG" << EOF
# IPv6 Monitoring Configuration

# Monitoring targets (space-separated)
IPV6_TARGETS="${DEFAULT_IPV6_TARGETS[*]}"

# Monitoring intervals (seconds)
CONNECTIVITY_CHECK_INTERVAL=60
DNS_CHECK_INTERVAL=120
ROUTE_CHECK_INTERVAL=300
INTERFACE_CHECK_INTERVAL=60

# Alert thresholds
PING_TIMEOUT=$PING_TIMEOUT
MAX_PACKET_LOSS=$MAX_PACKET_LOSS
MAX_RTT_MS=$MAX_RTT_MS
DNS_TIMEOUT=$DNS_TIMEOUT

# Alert configuration
ENABLE_EMAIL_ALERTS=false
ALERT_EMAIL=""
ENABLE_SLACK_ALERTS=false
SLACK_WEBHOOK=""
ENABLE_SYSLOG_ALERTS=true

# Interfaces to monitor (empty = all)
MONITOR_INTERFACES=""
EOF
    
    log "Created default monitoring configuration"
}

# Create alert script
create_alert_script() {
    cat > "$ALERT_SCRIPT" << 'EOF'
#!/bin/bash
# IPv6 Alert Handler Script

ALERT_TYPE="$1"
ALERT_MESSAGE="$2"
SEVERITY="$3"

# Load configuration
if [[ -f "/etc/ipv6-monitoring.conf" ]]; then
    source "/etc/ipv6-monitoring.conf"
fi

# Syslog alert
if [[ "${ENABLE_SYSLOG_ALERTS:-true}" == "true" ]]; then
    logger -p daemon.warn "IPv6 Monitor [$SEVERITY]: $ALERT_MESSAGE"
fi

# Email alert
if [[ "${ENABLE_EMAIL_ALERTS:-false}" == "true" && -n "${ALERT_EMAIL:-}" ]]; then
    echo "$ALERT_MESSAGE" | mail -s "IPv6 Alert: $ALERT_TYPE" "$ALERT_EMAIL"
fi

# Slack alert
if [[ "${ENABLE_SLACK_ALERTS:-false}" == "true" && -n "${SLACK_WEBHOOK:-}" ]]; then
    curl -X POST -H 'Content-type: application/json' \
        --data "{\"text\":\"IPv6 Alert [$SEVERITY]: $ALERT_MESSAGE\"}" \
        "$SLACK_WEBHOOK" 2>/dev/null || true
fi

# Custom alert actions can be added here
EOF
    
    chmod +x "$ALERT_SCRIPT"
}

# Load monitoring configuration
load_config() {
    if [[ -f "$MONITORING_CONFIG" ]]; then
        source "$MONITORING_CONFIG"
    else
        warn "Monitoring configuration not found, using defaults"
    fi
}

# IPv6 connectivity monitoring
monitor_ipv6_connectivity() {
    local timestamp=$(date +%s)
    local failed_targets=0
    local total_targets=0
    
    for target in ${IPV6_TARGETS:-${DEFAULT_IPV6_TARGETS[*]}}; do
        ((total_targets++))
        
        # Ping test
        local ping_result
        ping_result=$(ping6 -c 3 -W "$PING_TIMEOUT" "$target" 2>/dev/null || echo "FAILED")
        
        if [[ "$ping_result" == "FAILED" ]]; then
            ((failed_targets++))
            echo "$timestamp,connectivity,$target,FAILED,0,0" >> "$METRICS_DIR/connectivity.csv"
            
            "$ALERT_SCRIPT" "Connectivity" "IPv6 connectivity to $target failed" "CRITICAL"
        else
            # Extract statistics
            local packet_loss
            packet_loss=$(echo "$ping_result" | grep "packet loss" | grep -o "[0-9]*%" | tr -d '%')
            
            local avg_rtt
            avg_rtt=$(echo "$ping_result" | grep "rtt" | cut -d'/' -f5 | cut -d'.' -f1 2>/dev/null || echo "0")
            
            echo "$timestamp,connectivity,$target,SUCCESS,$packet_loss,$avg_rtt" >> "$METRICS_DIR/connectivity.csv"
            
            # Check thresholds
            if [[ ${packet_loss:-0} -gt ${MAX_PACKET_LOSS:-10} ]]; then
                "$ALERT_SCRIPT" "Connectivity" "High packet loss to $target: ${packet_loss}%" "WARNING"
            fi
            
            if [[ ${avg_rtt:-0} -gt ${MAX_RTT_MS:-200} ]]; then
                "$ALERT_SCRIPT" "Connectivity" "High RTT to $target: ${avg_rtt}ms" "WARNING"
            fi
        fi
    done
    
    # Overall connectivity status
    local success_rate=$((100 * (total_targets - failed_targets) / total_targets))
    echo "$timestamp,overall_connectivity,all,SUCCESS,$success_rate,0" >> "$METRICS_DIR/connectivity.csv"
    
    if [[ $success_rate -lt 50 ]]; then
        "$ALERT_SCRIPT" "Connectivity" "Overall IPv6 connectivity degraded: ${success_rate}%" "CRITICAL"
    fi
}

# DNS resolution monitoring
monitor_dns_resolution() {
    local timestamp=$(date +%s)
    local test_domains=("google.com" "cloudflare.com" "example.com")
    local failed_tests=0
    
    for domain in "${test_domains[@]}"; do
        local start_time=$(date +%s%N)
        
        # Test AAAA record resolution
        if timeout "$DNS_TIMEOUT" nslookup "$domain" 2001:4860:4860::8888 >/dev/null 2>&1; then
            local end_time=$(date +%s%N)
            local response_time=$(( (end_time - start_time) / 1000000 ))  # Convert to ms
            
            echo "$timestamp,dns,$domain,SUCCESS,0,$response_time" >> "$METRICS_DIR/dns.csv"
        else
            ((failed_tests++))
            echo "$timestamp,dns,$domain,FAILED,0,0" >> "$METRICS_DIR/dns.csv"
            
            "$ALERT_SCRIPT" "DNS" "DNS resolution failed for $domain" "WARNING"
        fi
    done
    
    if [[ $failed_tests -gt 1 ]]; then
        "$ALERT_SCRIPT" "DNS" "Multiple DNS resolution failures detected" "CRITICAL"
    fi
}

# IPv6 route monitoring
monitor_ipv6_routes() {
    local timestamp=$(date +%s)
    
    # Check default route
    if ip -6 route show default | grep -q "default"; then
        echo "$timestamp,routes,default,SUCCESS,0,0" >> "$METRICS_DIR/routes.csv"
    else
        echo "$timestamp,routes,default,FAILED,0,0" >> "$METRICS_DIR/routes.csv"
        "$ALERT_SCRIPT" "Routing" "IPv6 default route missing" "CRITICAL"
    fi
    
    # Count total IPv6 routes
    local route_count
    route_count=$(ip -6 route show | wc -l)
    echo "$timestamp,routes,count,SUCCESS,$route_count,0" >> "$METRICS_DIR/routes.csv"
}

# Interface monitoring
monitor_ipv6_interfaces() {
    local timestamp=$(date +%s)
    local interfaces_to_check
    
    if [[ -n "${MONITOR_INTERFACES:-}" ]]; then
        interfaces_to_check="$MONITOR_INTERFACES"
    else
        interfaces_to_check=$(ip -6 addr show | grep "inet6" | grep -v "::1" | awk '{print $NF}' | sort -u | tr '\n' ' ')
    fi
    
    for interface in $interfaces_to_check; do
        # Check if interface is up
        if ip link show "$interface" 2>/dev/null | grep -q "state UP"; then
            # Check IPv6 addresses
            local ipv6_count
            ipv6_count=$(ip -6 addr show "$interface" | grep "inet6" | grep -v "fe80" | wc -l)
            
            echo "$timestamp,interface,$interface,SUCCESS,$ipv6_count,0" >> "$METRICS_DIR/interfaces.csv"
            
            if [[ $ipv6_count -eq 0 ]]; then
                "$ALERT_SCRIPT" "Interface" "No global IPv6 address on interface $interface" "WARNING"
            fi
        else
            echo "$timestamp,interface,$interface,FAILED,0,0" >> "$METRICS_DIR/interfaces.csv"
            "$ALERT_SCRIPT" "Interface" "Interface $interface is down" "CRITICAL"
        fi
    done
}

# Neighbor discovery monitoring
monitor_neighbor_discovery() {
    local timestamp=$(date +%s)
    
    # Check neighbor table size
    local neighbor_count
    neighbor_count=$(ip -6 neigh show | wc -l)
    echo "$timestamp,neighbors,count,SUCCESS,$neighbor_count,0" >> "$METRICS_DIR/neighbors.csv"
    
    # Check for failed neighbor entries
    local failed_neighbors
    failed_neighbors=$(ip -6 neigh show | grep -c "FAILED" || true)
    
    if [[ $failed_neighbors -gt 5 ]]; then
        "$ALERT_SCRIPT" "Neighbors" "High number of failed neighbor entries: $failed_neighbors" "WARNING"
    fi
}

# Security monitoring
monitor_ipv6_security() {
    local timestamp=$(date +%s)
    
    # Check for IPv6 firewall rules
    if command -v ip6tables >/dev/null 2>&1; then
        local rule_count
        rule_count=$(ip6tables -L | grep -c "^ACCEPT\|^DROP\|^REJECT" || true)
        echo "$timestamp,security,firewall_rules,SUCCESS,$rule_count,0" >> "$METRICS_DIR/security.csv"
        
        if [[ $rule_count -eq 0 ]]; then
            "$ALERT_SCRIPT" "Security" "No IPv6 firewall rules detected" "WARNING"
        fi
    fi
    
    # Check for IPv6 privacy extensions
    local privacy_enabled=0
    for interface in $(ip -6 addr show | grep "inet6" | awk '{print $NF}' | sort -u); do
        if [[ -f "/proc/sys/net/ipv6/conf/$interface/use_tempaddr" ]]; then
            local tempaddr
            tempaddr=$(cat "/proc/sys/net/ipv6/conf/$interface/use_tempaddr")
            if [[ $tempaddr -gt 0 ]]; then
                privacy_enabled=1
                break
            fi
        fi
    done
    
    echo "$timestamp,security,privacy_extensions,SUCCESS,$privacy_enabled,0" >> "$METRICS_DIR/security.csv"
}

# Generate monitoring report
generate_monitoring_report() {
    local report_file="$LOG_DIR/ipv6_status_$(date +%Y%m%d_%H%M%S).txt"
    
    log "Generating IPv6 monitoring report..."
    
    {
        echo "IPv6 MONITORING STATUS REPORT"
        echo "============================="
        echo "Generated: $(date)"
        echo ""
        
        echo "CONNECTIVITY STATUS:"
        echo "==================="
        if [[ -f "$METRICS_DIR/connectivity.csv" ]]; then
            tail -10 "$METRICS_DIR/connectivity.csv" | while IFS=, read -r timestamp type target status metric1 metric2; do
                local datetime
                datetime=$(date -d "@$timestamp" '+%Y-%m-%d %H:%M:%S')
                printf "%-19s %-15s %-25s %-10s\n" "$datetime" "$type" "$target" "$status"
            done
        fi
        echo ""
        
        echo "DNS RESOLUTION STATUS:"
        echo "====================="
        if [[ -f "$METRICS_DIR/dns.csv" ]]; then
            tail -10 "$METRICS_DIR/dns.csv" | while IFS=, read -r timestamp type domain status metric1 metric2; do
                local datetime
                datetime=$(date -d "@$timestamp" '+%Y-%m-%d %H:%M:%S')
                printf "%-19s %-15s %-25s %-10s\n" "$datetime" "$type" "$domain" "$status"
            done
        fi
        echo ""
        
        echo "INTERFACE STATUS:"
        echo "================"
        ip -6 addr show | grep -E "(^[0-9]+:|inet6)" | while read -r line; do
            if [[ $line =~ ^[0-9]+: ]]; then
                echo "$line"
            elif [[ $line =~ inet6 ]]; then
                echo "    $line"
            fi
        done
        echo ""
        
        echo "ROUTING TABLE:"
        echo "============="
        ip -6 route show | head -20
        echo ""
        
        echo "RECENT ALERTS:"
        echo "============="
        if [[ -f "$LOG_DIR/monitor.log" ]]; then
            grep "Alert" "$LOG_DIR/monitor.log" | tail -10
        fi
        
    } > "$report_file"
    
    cat "$report_file"
    success "Monitoring report generated: $report_file"
}

# Main monitoring loop
run_monitoring_loop() {
    log "Starting IPv6 monitoring loop..."
    
    load_config
    
    while true; do
        local start_time=$(date +%s)
        
        # Run monitoring checks
        monitor_ipv6_connectivity &
        monitor_dns_resolution &
        monitor_ipv6_routes &
        monitor_ipv6_interfaces &
        monitor_neighbor_discovery &
        monitor_ipv6_security &
        
        # Wait for all background jobs to complete
        wait
        
        # Calculate sleep time
        local end_time=$(date +%s)
        local elapsed=$((end_time - start_time))
        local sleep_time=$((${CONNECTIVITY_CHECK_INTERVAL:-60} - elapsed))
        
        if [[ $sleep_time -gt 0 ]]; then
            sleep "$sleep_time"
        fi
    done
}

# Install monitoring service
install_service() {
    log "Installing IPv6 monitoring service..."
    
    # Create systemd service
    cat > "/etc/systemd/system/ipv6-monitoring.service" << EOF
[Unit]
Description=IPv6 Network Monitoring
After=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=$0 monitor
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ipv6-monitoring.service
    
    success "IPv6 monitoring service installed and enabled"
}

# Main function
main() {
    case "${1:-monitor}" in
        "setup")
            setup_monitoring
            ;;
        "monitor")
            setup_monitoring
            run_monitoring_loop
            ;;
        "report")
            load_config
            generate_monitoring_report
            ;;
        "test")
            load_config
            monitor_ipv6_connectivity
            monitor_dns_resolution
            ;;
        "install")
            setup_monitoring
            install_service
            ;;
        *)
            echo "Usage: $0 {setup|monitor|report|test|install}"
            echo ""
            echo "Commands:"
            echo "  setup   - Setup monitoring environment"
            echo "  monitor - Run continuous monitoring"
            echo "  report  - Generate status report"
            echo "  test    - Run single monitoring test"
            echo "  install - Install as systemd service"
            exit 1
            ;;
    esac
}

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
    exit 1
fi

main "$@"
```

This comprehensive enterprise IPv6 deployment guide provides production-ready frameworks for dual-stack implementation, advanced tunneling solutions, and sophisticated monitoring systems. The included tools support large-scale IPv6 transitions, ensuring business continuity while modernizing network infrastructure for future-ready enterprise environments.