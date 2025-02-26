---
title: "Implementing CloudFlare-Style DDoS Protection for Your Infrastructure"
date: 2025-03-01T09:00:00-06:00
draft: false
tags: ["Security", "DDoS", "CloudFlare", "Infrastructure", "DevOps", "Network Security", "iptables"]
categories:
- Security
- Infrastructure
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to implement robust DDoS protection mechanisms similar to CloudFlare's approach. This comprehensive guide covers rate limiting, connection tracking, and other essential security measures for web servers."
more_link: "yes"
url: "/cloudflare-style-dos-protection/"
---

Discover how to protect your web infrastructure against DDoS attacks using techniques inspired by CloudFlare's approach, implemented with common Linux tools.

<!--more-->

# Implementing CloudFlare-Style DDoS Protection

## Understanding DDoS Attack Vectors

Before implementing protection measures, it's crucial to understand the common types of DDoS attacks:
- ACK/FIN/RST floods
- SYN floods
- HTTP floods
- DNS amplification attacks
- X-mas tree packets

## Protection Mechanisms

### 1. Connection Tracking Protection

Use conntrack to protect against various flood attacks:

```bash
# Drop invalid packets
iptables -A INPUT --dst 1.2.3.4 -m conntrack --ctstate INVALID -j DROP

# Limit new connections per source IP
iptables -A INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -m limit --limit 60/min --limit-burst 20 -j ACCEPT
```

### 2. SYN Flood Protection

Implement SYN cookies and connection limits:

```bash
# Enable SYN cookies in sysctl
cat >> /etc/sysctl.conf << EOF
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 3
EOF

# Apply settings
sysctl -p

# Rate limit SYN packets
iptables -A INPUT -p tcp --syn -m limit --limit 1/s --limit-burst 3 -j ACCEPT
iptables -A INPUT -p tcp --syn -j DROP
```

### 3. HTTP DDoS Protection

Configure Nginx with rate limiting:

```nginx
# In http {} block
limit_req_zone $binary_remote_addr zone=one:10m rate=1r/s;

# In server {} block
location / {
    limit_req zone=one burst=5 nodelay;
    proxy_pass http://backend;
}
```

### 4. DNS Amplification Protection

Protect against DNS amplification attacks:

```bash
# Rate limit incoming DNS queries
iptables -A INPUT -p udp --dport 53 -m hashlimit \
    --hashlimit-name DNS \
    --hashlimit-above 20/sec \
    --hashlimit-burst 100 \
    --hashlimit-mode srcip \
    --hashlimit-htable-size 32768 \
    --hashlimit-htable-max 32768 \
    --hashlimit-htable-expire 60000 \
    -j DROP
```

## Advanced Protection Strategies

### 1. Geographic IP Blocking

If attacks consistently come from specific regions:

```bash
# Install required tools
apt-get install ipset xtables-addons-common

# Create and populate country blocklist
ipset create country_block hash:net
ipset add country_block 1.2.3.0/24

# Apply the blocklist
iptables -A INPUT -m set --match-set country_block src -j DROP
```

### 2. Application Layer Protection

Implement application-specific protections:

```nginx
# Prevent slow HTTP attacks
client_body_timeout 10s;
client_header_timeout 10s;
keepalive_timeout 5s 5s;
send_timeout 10s;

# Limit request size
client_max_body_size 100k;
client_body_buffer_size 100k;
```

### 3. TCP Optimization

Fine-tune TCP stack settings:

```bash
# Add to /etc/sysctl.conf
net.ipv4.tcp_max_tw_buckets = 1440000
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
```

## Monitoring and Maintenance

### 1. Set Up Logging

Configure detailed logging for security events:

```bash
# Enable logging for dropped packets
iptables -A INPUT -m limit --limit 5/min -j LOG --log-prefix "iptables denied: " --log-level 7

# Monitor logs
tail -f /var/log/syslog | grep "iptables denied"
```

### 2. Regular Maintenance Tasks

- Review and update rules monthly
- Analyze traffic patterns
- Update blocklists
- Test protection mechanisms

## Best Practices

1. **Layer Your Defense**
   - Combine multiple protection mechanisms
   - Don't rely on a single solution
   - Implement both network and application layer protection

2. **Regular Testing**
   - Conduct regular stress tests
   - Simulate various attack scenarios
   - Verify protection effectiveness

3. **Documentation**
   - Maintain detailed documentation of all rules
   - Document incident response procedures
   - Keep configuration templates updated

Remember that DDoS protection is an ongoing process. Regular monitoring, updates, and adjustments are necessary to maintain effective protection against evolving threats.
