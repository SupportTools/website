---
title: "Configuring IPv4 and IPv6 Preferences in Linux Systems"
date: 2025-03-30T09:00:00-06:00
draft: false
tags: ["Networking", "Linux", "IPv4", "IPv6", "System Administration", "Performance"]
categories:
- Networking
- Linux Administration
- System Configuration
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to configure IPv4 and IPv6 preferences in Linux systems to optimize network performance and resolve connectivity issues. Includes practical examples and troubleshooting tips."
more_link: "yes"
url: "/configure-ipv4-ipv6-preference/"
---

A comprehensive guide to managing IPv4 and IPv6 preferences in Linux systems, helping you optimize network connectivity and resolve common issues.

<!--more-->

# Managing IPv4 and IPv6 Preferences in Linux

## Understanding the Challenge

While IPv6 adoption continues to grow, not all services and repositories are fully IPv6-ready. This can lead to connectivity issues, particularly when:
- Downloading packages from repositories
- Accessing services that aren't properly configured for IPv6
- Dealing with dual-stack environments
- Experiencing slower connections due to failed IPv6 attempts

## Quick Solutions

### 1. Force APT to Use IPv4

If you're experiencing issues with package downloads, you can force APT to use IPv4:

```bash
echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
```

This configuration ensures that APT will only use IPv4 for package downloads.

### 2. System-Wide IPv4 Preference

To configure IPv4 preference system-wide using gai.conf:

```bash
echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf
```

This setting tells the system to prefer IPv4 addresses when both IPv4 and IPv6 are available.

## Detailed Configuration Options

### 1. Fine-Tuning gai.conf

The gai.conf file allows for detailed control over address selection:

```bash
# /etc/gai.conf

# Prefer IPv4 over IPv6
precedence ::ffff:0:0/96  100

# Alternative: Prefer IPv6 over IPv4
# precedence 2001::/32  50
# precedence ::/0        40
# precedence ::ffff:0:0/96  35

# Label IPv4-only destinations
label ::ffff:0:0/96  4
```

### 2. Application-Specific Configuration

For specific applications that support it:

```bash
# Example for curl
curl -4 https://example.com

# Example for wget
wget -4 https://example.com
```

### 3. Network Manager Configuration

If using NetworkManager, you can set IPv4 preference:

```bash
# Create a new connection profile
nmcli connection add type ethernet con-name "IPv4-Preferred" ifname eth0 ip4 auto ip6 ignore

# Or modify existing connection
nmcli connection modify "Wired connection 1" ipv6.method ignore
```

## Troubleshooting

### 1. Verify Current Configuration

Check your current IP configuration:

```bash
# View active IP addresses
ip addr show

# Test IPv4/IPv6 connectivity
ping -4 example.com
ping -6 example.com
```

### 2. Common Issues and Solutions

1. **Slow Package Downloads**
```bash
# Force IPv4 for a single apt operation
apt-get -o Acquire::ForceIPv4=true update
```

2. **Repository Connection Issues**
```bash
# Check repository connectivity
curl -4 -v http://archive.ubuntu.com/ubuntu/
curl -6 -v http://archive.ubuntu.com/ubuntu/
```

3. **DNS Resolution Problems**
```bash
# Test DNS resolution
dig -4 example.com
dig -6 example.com
```

## Best Practices

1. **Monitoring and Testing**
   - Regularly test both IPv4 and IPv6 connectivity
   - Monitor connection performance
   - Keep logs of connection issues

2. **Documentation**
   - Document any IPv4/IPv6 preferences set
   - Maintain records of problematic services
   - Keep configuration changes logged

3. **Security Considerations**
   - Ensure firewall rules are updated for both protocols
   - Monitor both IPv4 and IPv6 traffic
   - Keep security policies consistent across both protocols

## Performance Optimization

1. **Connection Testing**
```bash
# Test connection speeds
curl -4 -w "IPv4: %{time_total}\n" -o /dev/null -s https://example.com
curl -6 -w "IPv6: %{time_total}\n" -o /dev/null -s https://example.com
```

2. **Happy Eyeballs Algorithm**
Modern systems use the Happy Eyeballs algorithm to optimize dual-stack connections. You can adjust its behavior through sysctl:

```bash
# Adjust connection attempt delay
sysctl -w net.ipv6.tcp_fastopen=3
```

Remember that while forcing IPv4 can solve immediate issues, it's generally better to maintain dual-stack capability when possible. Only implement these preferences when necessary, and regularly review their necessity as IPv6 support continues to improve across the internet.
