---
title: "Running Apache with mod_spdy and PHP-FPM: Performance Optimization Guide"
date: 2025-09-30T09:00:00-06:00
draft: false
tags: ["Apache", "PHP-FPM", "SPDY", "Performance", "Web Server", "HTTP/2"]
categories:
- Web Servers
- Performance
- Apache
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to optimize your Apache web server performance by implementing mod_spdy with PHP-FPM. A comprehensive guide to configuration, optimization, and troubleshooting."
more_link: "yes"
url: "/apache-mod-spdy-php-fpm-setup/"
---

Master the art of high-performance web serving by combining Apache's mod_spdy with PHP-FPM for optimal speed and resource utilization.

<!--more-->

# Apache with mod_spdy and PHP-FPM

## Understanding SPDY Protocol

SPDY (pronounced "speedy") offers several advantages:
- Multiplexed streams
- Prioritized requests
- Compressed headers
- Server push capability
- Reduced latency

## Installation Requirements

### 1. Apache Setup

```bash
# Install Apache and development tools
apt-get update
apt-get install -y apache2 apache2-dev build-essential

# Install mod_spdy dependencies
apt-get install -y python pkg-config libssl-dev
```

### 2. PHP-FPM Installation

```bash
# Install PHP-FPM and required modules
apt-get install -y php-fpm php-mysql php-curl php-gd php-intl php-mbstring php-soap php-xml php-zip
```

## Configuration Steps

### 1. mod_spdy Configuration

```apache
# /etc/apache2/mods-available/spdy.conf
<IfModule mod_spdy.c>
    # Enable SPDY
    SpdyEnabled on
    
    # Configure SPDY settings
    SpdyMaxThreadsPerProcess 30
    SpdyMaxStreamsPerConnection 100
    SpdyPriorityEnforce on
    
    # Enable server push (optional)
    SpdyPushPriority * 3
</IfModule>
```

### 2. PHP-FPM Configuration

```ini
; /etc/php/8.2/fpm/pool.d/www.conf
[www]
user = www-data
group = www-data

; Dynamic process management
pm = dynamic
pm.max_children = 50
pm.start_servers = 5
pm.min_spare_servers = 5
pm.max_spare_servers = 35
pm.max_requests = 500

; Performance settings
request_terminate_timeout = 300s
rlimit_files = 131072
rlimit_core = unlimited
```

### 3. Apache-FPM Integration

```apache
# Enable required modules
a2enmod proxy_fcgi setenvif

# Configure PHP-FPM handler
<FilesMatch ".+\.ph(ar|p|tml)$">
    SetHandler "proxy:unix:/run/php/php8.2-fpm.sock|fcgi://localhost"
</FilesMatch>
```

## Performance Optimization

### 1. Apache MPM Configuration

```apache
# /etc/apache2/mods-available/mpm_event.conf
<IfModule mpm_event_module>
    StartServers             3
    MinSpareThreads         25
    MaxSpareThreads         75
    ThreadLimit             64
    ThreadsPerChild         25
    MaxRequestWorkers      400
    MaxConnectionsPerChild   0
</IfModule>
```

### 2. PHP-FPM Process Management

```ini
; Dynamic process management optimization
pm.max_children = $((`grep -c ^processor /proc/cpuinfo` * 4))
pm.start_servers = $((`grep -c ^processor /proc/cpuinfo` * 2))
pm.min_spare_servers = $((`grep -c ^processor /proc/cpuinfo` * 2))
pm.max_spare_servers = $((`grep -c ^processor /proc/cpuinfo` * 4))
```

### 3. OpCache Settings

```ini
; PHP OpCache optimization
opcache.enable=1
opcache.memory_consumption=128
opcache.interned_strings_buffer=8
opcache.max_accelerated_files=4000
opcache.revalidate_freq=60
opcache.fast_shutdown=1
opcache.enable_cli=1
```

## Monitoring and Debugging

### 1. SPDY Status Check

```bash
#!/bin/bash
# check_spdy.sh

curl -I --http2 https://your-domain.com

# Check SPDY module status
apache2ctl -M | grep spdy
```

### 2. PHP-FPM Status Page

```ini
; Enable status page
pm.status_path = /status

; Configure access control
<Location /status>
    SetHandler "proxy:unix:/run/php/php8.2-fpm.sock|fcgi://localhost"
    Require local
</Location>
```

### 3. Performance Monitoring

```bash
#!/bin/bash
# monitor-performance.sh

# Check Apache status
curl http://localhost/server-status?auto

# Check PHP-FPM status
curl http://localhost/status?json

# Monitor process resources
top -b -n 1 -p $(pgrep -d',' -f 'apache2|php-fpm')
```

## Security Considerations

### 1. SSL Configuration

```apache
# Enable SSL with modern cipher configuration
SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
SSLCipherSuite ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384
SSLHonorCipherOrder on
SSLCompression off
```

### 2. PHP-FPM Security

```ini
; Restrict PHP-FPM access
security.limit_extensions = .php
cgi.fix_pathinfo = 0
expose_php = Off
```

## Troubleshooting Guide

### 1. Common Issues

```bash
# Check error logs
tail -f /var/log/apache2/error.log
tail -f /var/log/php8.2-fpm.log

# Test configuration
apache2ctl configtest
php-fpm8.2 -t
```

### 2. Performance Issues

```bash
# Check Apache processes
ps aux | grep apache2 | wc -l

# Monitor PHP-FPM processes
watch -n1 "ps aux | grep php-fpm | wc -l"

# Check system resources
vmstat 1
iostat -x 1
```

## Best Practices

1. **Regular Maintenance**
   - Monitor error logs
   - Update configurations
   - Tune performance settings

2. **Backup Strategy**
   - Backup configurations
   - Document changes
   - Maintain rollback plans

3. **Performance Testing**
   - Regular benchmarks
   - Load testing
   - Resource monitoring

Remember to regularly test and update your configuration as new versions of Apache, PHP-FPM, and mod_spdy become available. Always test changes in a staging environment before applying to production.
