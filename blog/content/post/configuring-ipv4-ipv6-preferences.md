---
title: "Configuring IPv4 and IPv6 Preferences in Linux: A Comprehensive Guide"
date: 2026-02-15T09:00:00-06:00
draft: false
tags: ["Linux", "Networking", "IPv4", "IPv6", "System Administration", "Performance"]
categories:
- Networking
- System Administration
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to effectively configure and optimize IPv4 and IPv6 preferences in Linux systems. Includes configuration examples, performance tuning, and troubleshooting guides."
more_link: "yes"
url: "/configuring-ipv4-ipv6-preferences/"
---

Master the art of configuring IPv4 and IPv6 preferences in Linux systems to optimize network performance and reliability.

<!--more-->

# Configuring IPv4 and IPv6 Preferences

## Understanding IP Protocol Preferences

### 1. System Configuration

```bash
# View current IP configuration
ip addr show
ip -6 addr show

# Check routing tables
ip route show
ip -6 route show
```

### 2. Protocol Stack Settings

```bash
# View protocol preferences
sysctl -a | grep 'ipv6.conf.*.prefer_ipv4_outgoing'
sysctl -a | grep 'ipv6.bindv6only'
```

## Implementation Guide

### 1. System-wide Configuration

```bash
#!/bin/bash
# configure-ip-preferences.sh

# Set IPv4 preference
configure_ipv4_preference() {
    local prefer_ipv4=$1  # true/false
    
    if [ "$prefer_ipv4" = true ]; then
        # Prefer IPv4 over IPv6
        cat > /etc/gai.conf << 'EOF'
precedence ::ffff:0:0/96  100
precedence ::/0          20
EOF
    else
        # Prefer IPv6 over IPv4
        cat > /etc/gai.conf << 'EOF'
precedence ::/0          50
precedence ::ffff:0:0/96  10
EOF
    fi
}

# Configure sysctl settings
configure_sysctl() {
    cat > /etc/sysctl.d/99-ip-preferences.conf << 'EOF'
# IPv6 settings
net.ipv6.conf.all.disable_ipv6 = 0
net.ipv6.conf.default.disable_ipv6 = 0
net.ipv6.conf.all.forwarding = 1

# IPv4 settings
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
EOF

    # Apply settings
    sysctl -p /etc/sysctl.d/99-ip-preferences.conf
}
```

### 2. Application-specific Configuration

```python
#!/usr/bin/env python3
# configure_app_preferences.py

import socket
import sys

def set_socket_preferences(sock, prefer_ipv4=True):
    """Configure socket IP preferences"""
    if prefer_ipv4:
        # Prefer IPv4
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    else:
        # Prefer IPv6
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    
    return sock

def create_dual_stack_socket(port, prefer_ipv4=True):
    """Create a dual-stack socket with preferences"""
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock = set_socket_preferences(sock, prefer_ipv4)
        sock.bind(('::', port))
        return sock
    except Exception as e:
        print(f"Error creating socket: {e}")
        return None
```

## Performance Optimization

### 1. Network Stack Tuning

```bash
#!/bin/bash
# optimize-network-stack.sh

# Optimize network stack settings
optimize_network() {
    cat > /etc/sysctl.d/99-network-performance.conf << 'EOF'
# General network performance
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# IPv4 specific
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_slow_start_after_idle = 0

# IPv6 specific
net.ipv6.conf.all.accept_ra = 2
net.ipv6.conf.all.autoconf = 1
EOF

    sysctl -p /etc/sysctl.d/99-network-performance.conf
}

# Configure TCP timestamps
configure_tcp_timestamps() {
    echo 0 > /proc/sys/net/ipv4/tcp_timestamps
}

# Main execution
optimize_network
configure_tcp_timestamps
```

### 2. DNS Resolution Optimization

```bash
# /etc/resolv.conf
options timeout:1
options attempts:2
options rotate
options single-request-reopen
options use-vc
```

## Monitoring and Troubleshooting

### 1. Network Monitoring Script

```python
#!/usr/bin/env python3
# monitor_ip_performance.py

import subprocess
import time
from datetime import datetime

def check_ip_connectivity():
    """Check IPv4 and IPv6 connectivity"""
    tests = {
        'IPv4': ['8.8.8.8', 'google.com'],
        'IPv6': ['2001:4860:4860::8888', 'google.com']
    }
    
    results = {}
    for protocol, targets in tests.items():
        results[protocol] = []
        for target in targets:
            try:
                # Test connectivity
                cmd = f"ping{' -6' if protocol == 'IPv6' else ''} -c 1 -W 2 {target}"
                subprocess.check_output(cmd.split())
                results[protocol].append(True)
            except subprocess.CalledProcessError:
                results[protocol].append(False)
    
    return results

def monitor_network():
    """Continuous network monitoring"""
    while True:
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        results = check_ip_connectivity()
        
        # Log results
        with open('network_monitor.log', 'a') as f:
            for protocol, status in results.items():
                success = sum(status)
                total = len(status)
                f.write(f"{timestamp} - {protocol}: {success}/{total} tests passed\n")
        
        time.sleep(300)  # Check every 5 minutes

if __name__ == "__main__":
    monitor_network()
```

### 2. Performance Analysis

```bash
#!/bin/bash
# analyze_ip_performance.sh

# Test IPv4 vs IPv6 performance
test_performance() {
    local target=$1
    
    echo "Testing IPv4 performance..."
    time curl -4 -s "$target" > /dev/null
    
    echo "Testing IPv6 performance..."
    time curl -6 -s "$target" > /dev/null
}

# Monitor connection statistics
monitor_connections() {
    echo "Active connections:"
    ss -s
    
    echo "Connection distribution:"
    netstat -n | awk '/^tcp/ {print $NF}' | sort | uniq -c | sort -rn
}

# Main execution
test_performance "https://example.com"
monitor_connections
```

## Best Practices

1. **Protocol Stack Configuration**
   - Enable both protocols
   - Configure preferences
   - Optimize performance

2. **Security Considerations**
   - Firewall rules
   - Network isolation
   - Access controls

3. **Monitoring**
   - Regular testing
   - Performance tracking
   - Issue detection

Remember to regularly review and update your IP configuration to maintain optimal network performance and reliability.
