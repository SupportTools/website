---
title: "Systemd and Modern Linux Init Systems: Service Management and System Architecture"
date: 2025-02-16T10:00:00-05:00
draft: false
tags: ["Linux", "systemd", "Init Systems", "Service Management", "System Administration", "Boot Process"]
categories:
- Linux
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Master systemd and modern Linux init systems, including service management, unit files, system architecture, advanced features, and troubleshooting techniques"
more_link: "yes"
url: "/systemd-modern-linux-init/"
---

Systemd has become the dominant init system in modern Linux distributions, fundamentally changing how services are managed, systems boot, and processes are supervised. Understanding systemd's architecture and capabilities is essential for modern Linux system administration and service deployment.

<!--more-->

# [Systemd and Modern Linux Init Systems](#systemd-modern-init)

## Systemd Architecture Overview

### Core Components

```bash
# systemd ecosystem components
systemctl status systemd --no-pager
systemctl list-dependencies systemd.target --no-pager

# Key systemd components:
# - systemd (PID 1): Main init process
# - systemd-journald: Logging daemon
# - systemd-logind: Login manager
# - systemd-networkd: Network manager
# - systemd-resolved: DNS resolver
# - systemd-timesyncd: Time synchronization
# - systemd-udevd: Device manager

# Check systemd version and features
systemctl --version

# System state
systemctl show --property=Environment
systemctl show --property=Architecture
systemctl show --property=Virtualization
```

### Understanding Units

```bash
# Unit types and their purposes
systemctl list-unit-files --type=service | head -20
systemctl list-unit-files --type=target | head -10
systemctl list-unit-files --type=socket | head -10
systemctl list-unit-files --type=timer | head -10

# Unit states
systemctl list-units --state=active
systemctl list-units --state=failed
systemctl list-units --state=inactive

# Unit dependencies
systemctl list-dependencies multi-user.target --all
systemctl show --property=Wants multi-user.target
systemctl show --property=Requires multi-user.target
```

## Service Unit Management

### Creating Custom Service Units

```ini
# /etc/systemd/system/myapp.service - Basic service
[Unit]
Description=My Application Service
Documentation=https://docs.myapp.com
After=network.target
Wants=network-online.target
RequiresMountsFor=/opt/myapp

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
EnvironmentFile=-/etc/myapp/environment
ExecStartPre=/bin/mkdir -p /var/log/myapp
ExecStart=/opt/myapp/bin/myapp --config /etc/myapp/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myapp

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/myapp /var/lib/myapp

[Install]
WantedBy=multi-user.target
```

### Advanced Service Configuration

```ini
# /etc/systemd/system/webapp.service - Advanced web application
[Unit]
Description=High-Performance Web Application
Documentation=man:webapp(8) https://webapp.example.com/docs
After=network-online.target postgresql.service redis.service
Wants=network-online.target
Requires=postgresql.service
BindsTo=redis.service

[Service]
Type=notify
User=webapp
Group=webapp
WorkingDirectory=/opt/webapp

# Environment
Environment=WEBAPP_MODE=production
Environment=WEBAPP_WORKERS=4
EnvironmentFile=/etc/webapp/environment

# Process management
ExecStartPre=/usr/bin/webapp --check-config
ExecStartPre=/bin/chown -R webapp:webapp /var/run/webapp
ExecStart=/usr/bin/webapp --daemon --config /etc/webapp/webapp.conf
ExecReload=/bin/kill -USR1 $MAINPID
ExecStop=/bin/kill -TERM $MAINPID
TimeoutStartSec=30
TimeoutStopSec=30
Restart=on-failure
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096
MemoryLimit=2G
CPUQuota=200%

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RemoveIPC=true

# File system protection
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/webapp /var/lib/webapp /var/run/webapp
ReadOnlyPaths=/etc/webapp

# Network isolation
PrivateNetwork=false
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# System call filtering
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
Alias=webapp.service
```

### Service Management Commands

```bash
#!/bin/bash
# service_management.sh - Comprehensive service management

# Service lifecycle
manage_service() {
    local service=$1
    local action=$2
    
    case $action in
        "start")
            systemctl start $service
            echo "Started $service"
            ;;
        "stop")
            systemctl stop $service
            echo "Stopped $service"
            ;;
        "restart")
            systemctl restart $service
            echo "Restarted $service"
            ;;
        "reload")
            systemctl reload-or-restart $service
            echo "Reloaded $service"
            ;;
        "enable")
            systemctl enable $service
            echo "Enabled $service"
            ;;
        "disable")
            systemctl disable $service
            echo "Disabled $service"
            ;;
        "status")
            systemctl status $service --no-pager -l
            ;;
        "logs")
            journalctl -u $service -f
            ;;
        *)
            echo "Usage: manage_service <service> <start|stop|restart|reload|enable|disable|status|logs>"
            ;;
    esac
}

# Bulk service operations
bulk_service_operation() {
    local operation=$1
    shift
    local services=("$@")
    
    for service in "${services[@]}"; do
        echo "Performing $operation on $service..."
        systemctl $operation $service
        
        if [ $? -eq 0 ]; then
            echo "✓ $service: $operation successful"
        else
            echo "✗ $service: $operation failed"
        fi
    done
}

# Service validation
validate_service() {
    local service=$1
    
    echo "Validating service: $service"
    
    # Check if service exists
    if ! systemctl list-unit-files | grep -q "^$service"; then
        echo "❌ Service $service does not exist"
        return 1
    fi
    
    # Check syntax
    if ! systemd-analyze verify /etc/systemd/system/$service 2>/dev/null; then
        echo "❌ Service $service has syntax errors"
        return 1
    fi
    
    # Check if can be loaded
    if ! systemctl is-enabled $service >/dev/null 2>&1; then
        echo "⚠️  Service $service is not enabled"
    fi
    
    # Check if active
    if systemctl is-active $service >/dev/null 2>&1; then
        echo "✅ Service $service is active"
    else
        echo "⚠️  Service $service is not active"
    fi
    
    echo "✅ Service $service validation complete"
}

# Service monitoring
monitor_service() {
    local service=$1
    local interval=${2:-5}
    
    echo "Monitoring $service (interval: ${interval}s)"
    
    while true; do
        clear
        echo "=== Service Monitor: $service ==="
        echo "Time: $(date)"
        echo
        
        # Status
        systemctl status $service --no-pager -l
        echo
        
        # Resource usage
        echo "=== Resource Usage ==="
        systemctl show $service --property=MemoryCurrent,CPUUsageNSec,TasksCurrent
        echo
        
        # Recent logs
        echo "=== Recent Logs ==="
        journalctl -u $service --since "1 minute ago" --no-pager | tail -10
        
        sleep $interval
    done
}
```

## Systemd Targets and Boot Process

### Understanding Targets

```bash
# Default target
systemctl get-default
systemctl set-default multi-user.target

# Available targets
systemctl list-units --type=target
systemctl list-unit-files --type=target

# Target dependencies
systemctl list-dependencies graphical.target
systemctl list-dependencies multi-user.target
systemctl list-dependencies basic.target

# Boot analysis
systemd-analyze
systemd-analyze blame
systemd-analyze critical-chain
systemd-analyze plot > boot-analysis.svg
```

### Custom Target Creation

```ini
# /etc/systemd/system/maintenance.target
[Unit]
Description=Maintenance Mode
Documentation=man:systemd.special(7)
Requires=basic.target
Conflicts=rescue.service rescue.target
After=basic.target rescue.service rescue.target
AllowIsolate=yes

[Install]
Alias=maintenance.target
```

### Boot Process Optimization

```bash
#!/bin/bash
# boot_optimization.sh - Boot process analysis and optimization

analyze_boot() {
    echo "=== Boot Performance Analysis ==="
    
    # Overall boot time
    echo "Total boot time:"
    systemd-analyze
    echo
    
    # Slowest services
    echo "Top 10 slowest services:"
    systemd-analyze blame | head -10
    echo
    
    # Critical chain
    echo "Critical chain:"
    systemd-analyze critical-chain
    echo
    
    # Service startup times
    echo "Service startup analysis:"
    systemd-analyze time
}

optimize_boot() {
    echo "=== Boot Optimization Suggestions ==="
    
    # Check for failed services
    echo "Failed services:"
    systemctl list-units --failed
    echo
    
    # Check for unnecessary services
    echo "Enabled services that might be unnecessary:"
    systemctl list-unit-files --state=enabled | grep -E "(bluetooth|cups|avahi|ModemManager)" || echo "None found"
    echo
    
    # Check for slow services
    echo "Services taking >5 seconds:"
    systemd-analyze blame | awk '$1 > 5000 {print}'
    echo
    
    # Check kernel command line
    echo "Current kernel parameters:"
    cat /proc/cmdline
    echo
    
    echo "Consider adding 'quiet splash' to reduce boot messages"
    echo "Consider 'systemd.show_status=false' to hide systemd messages"
}

# Service dependency visualization
create_dependency_graph() {
    local target=${1:-default.target}
    
    systemctl list-dependencies $target --all | \
    grep -E "(service|target|socket|timer)" | \
    sed 's/^[│├└─ ]*//' | \
    while read unit; do
        echo "\"$target\" -> \"$unit\""
    done > dependencies.dot
    
    echo "digraph dependencies {" > full_deps.dot
    echo "  rankdir=LR;" >> full_deps.dot
    cat dependencies.dot >> full_deps.dot
    echo "}" >> full_deps.dot
    
    if command -v dot >/dev/null; then
        dot -Tpng full_deps.dot -o dependencies.png
        echo "Dependency graph saved as dependencies.png"
    fi
}
```

## Systemd Timers

### Timer Unit Configuration

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Daily Backup Timer
Requires=backup.service

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1800

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Daily Backup Service
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=backup
ExecStart=/usr/local/bin/backup.sh
StandardOutput=journal
StandardError=journal
```

### Advanced Timer Examples

```ini
# /etc/systemd/system/monitoring.timer - Complex monitoring timer
[Unit]
Description=System Monitoring Timer
Documentation=man:systemd.timer(5)

[Timer]
# Run every 5 minutes
OnCalendar=*:0/5

# Run 30 seconds after boot
OnBootSec=30

# If missed due to downtime, run immediately
Persistent=true

# Randomize by up to 60 seconds to avoid thundering herd
RandomizedDelaySec=60

# Only run if AC power is available
ConditionACPower=true

[Install]
WantedBy=timers.target
```

### Timer Management

```bash
#!/bin/bash
# timer_management.sh - Timer operations

# List all timers
list_timers() {
    echo "=== Active Timers ==="
    systemctl list-timers --all
    echo
    
    echo "=== Timer Status ==="
    systemctl status --no-pager *.timer
}

# Create monitoring timer
create_monitoring_timer() {
    cat > /etc/systemd/system/system-monitor.timer << 'EOF'
[Unit]
Description=System Monitoring Timer
Documentation=local

[Timer]
OnCalendar=*:0/10
Persistent=true

[Install]
WantedBy=timers.target
EOF

    cat > /etc/systemd/system/system-monitor.service << 'EOF'
[Unit]
Description=System Monitoring Service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/system-monitor.sh
StandardOutput=journal
StandardError=journal
EOF

    # Create monitoring script
    cat > /usr/local/bin/system-monitor.sh << 'EOF'
#!/bin/bash
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
LOAD=$(uptime | awk -F'load average:' '{print $2}')
MEMORY=$(free -m | awk 'NR==2{printf "%.1f%%", $3*100/$2}')
DISK=$(df -h / | awk 'NR==2{print $5}')

echo "[$TIMESTAMP] Load:$LOAD Memory: $MEMORY Disk: $DISK"

# Check for high load
LOAD1=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}' | tr -d ' ')
if (( $(echo "$LOAD1 > 2.0" | bc -l) )); then
    logger -t system-monitor "High load detected: $LOAD1"
fi
EOF

    chmod +x /usr/local/bin/system-monitor.sh
    
    systemctl daemon-reload
    systemctl enable system-monitor.timer
    systemctl start system-monitor.timer
    
    echo "System monitoring timer created and started"
}

# Analyze timer accuracy
analyze_timer_accuracy() {
    local timer=$1
    
    echo "=== Timer Accuracy Analysis: $timer ==="
    
    # Show timer details
    systemctl show $timer --property=NextElapseUSTTimestamp,LastTriggerUSec
    
    # Recent trigger history
    journalctl -u $timer --since "24 hours ago" --no-pager
}
```

## Systemd Sockets

### Socket Activation

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=My Application Socket
PartOf=myapp.service

[Socket]
ListenStream=8080
ListenDatagram=8081
Accept=false
SocketUser=myapp
SocketGroup=myapp
SocketMode=0660

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/myapp.service - Socket-activated service
[Unit]
Description=My Application (Socket Activated)
Requires=myapp.socket

[Service]
Type=notify
User=myapp
Group=myapp
ExecStart=/opt/myapp/bin/myapp --socket-activation
StandardInput=socket
```

### Advanced Socket Configuration

```ini
# /etc/systemd/system/webserver.socket - Advanced web server socket
[Unit]
Description=High-Performance Web Server Socket
Documentation=man:systemd.socket(5)

[Socket]
# Multiple listen addresses
ListenStream=80
ListenStream=443
ListenStream=[::]:80
ListenStream=[::]:443

# Socket options
NoDelay=true
KeepAlive=true
KeepAliveIntervalSec=30
KeepAliveProbes=9
KeepAliveTimeSec=7200

# Performance tuning
Backlog=2048
ReceiveBuffer=262144
SendBuffer=262144

# Security
SocketUser=www-data
SocketGroup=www-data
SocketMode=0660

# Control
MaxConnections=1024
MaxConnectionsPerSource=16

[Install]
WantedBy=sockets.target
```

## Systemd Journal and Logging

### Journal Configuration

```ini
# /etc/systemd/journald.conf - Journal configuration
[Journal]
Storage=persistent
Compress=yes
SplitMode=uid
SyncIntervalSec=5m
RateLimitInterval=30s
RateLimitBurst=10000
SystemMaxUse=4G
SystemKeepFree=1G
SystemMaxFileSize=128M
MaxRetentionSec=1month
MaxFileSec=1week
ForwardToSyslog=no
ForwardToKMsg=no
ForwardToConsole=no
ForwardToWall=yes
LineMax=48K
```

### Journal Management

```bash
#!/bin/bash
# journal_management.sh - Journal operations

# Journal status and usage
journal_status() {
    echo "=== Journal Status ==="
    journalctl --disk-usage
    echo
    
    echo "=== Journal Verification ==="
    journalctl --verify
    echo
    
    echo "=== Journal Configuration ==="
    systemctl show systemd-journald --property=Environment,ExecMainPID
}

# Advanced log filtering
advanced_log_search() {
    local service=$1
    local since=${2:-"1 hour ago"}
    local priority=${3:-"info"}
    
    echo "=== Advanced Log Search: $service ==="
    
    # Basic service logs
    echo "Recent logs:"
    journalctl -u $service --since "$since" --no-pager
    echo
    
    # Error logs only
    echo "Error logs:"
    journalctl -u $service --since "$since" -p err --no-pager
    echo
    
    # Structured logging
    echo "Structured logs:"
    journalctl -u $service --since "$since" -o json-pretty | head -20
    echo
    
    # Performance metrics
    echo "Log volume analysis:"
    journalctl -u $service --since "$since" | wc -l
    echo "lines generated since $since"
}

# Log rotation and cleanup
manage_log_retention() {
    echo "=== Log Retention Management ==="
    
    # Current usage
    echo "Current journal usage:"
    journalctl --disk-usage
    echo
    
    # Cleanup old logs
    echo "Cleaning logs older than 30 days:"
    journalctl --vacuum-time=30d
    echo
    
    echo "Limiting journal size to 2GB:"
    journalctl --vacuum-size=2G
    echo
    
    echo "Keeping only 100 files:"
    journalctl --vacuum-files=100
    echo
    
    # Final usage
    echo "Final journal usage:"
    journalctl --disk-usage
}

# Real-time monitoring
realtime_monitoring() {
    local filter=${1:-""}
    
    echo "=== Real-time Log Monitoring ==="
    echo "Press Ctrl+C to stop"
    echo
    
    if [ -n "$filter" ]; then
        journalctl -f --grep="$filter"
    else
        journalctl -f
    fi
}

# Export logs
export_logs() {
    local service=$1
    local format=${2:-"json"}
    local output="/tmp/${service}_logs_$(date +%Y%m%d_%H%M%S)"
    
    case $format in
        "json")
            journalctl -u $service -o json > "${output}.json"
            echo "Logs exported to ${output}.json"
            ;;
        "csv")
            journalctl -u $service -o json | \
            jq -r '[.__REALTIME_TIMESTAMP, .PRIORITY, .MESSAGE] | @csv' > "${output}.csv"
            echo "Logs exported to ${output}.csv"
            ;;
        "text")
            journalctl -u $service > "${output}.txt"
            echo "Logs exported to ${output}.txt"
            ;;
        *)
            echo "Unsupported format: $format"
            echo "Supported formats: json, csv, text"
            return 1
            ;;
    esac
}
```

## Systemd Security and Sandboxing

### Service Hardening

```ini
# /etc/systemd/system/secure-app.service - Hardened service
[Unit]
Description=Security-Hardened Application
Documentation=man:systemd.exec(5)

[Service]
Type=simple
User=secure-app
Group=secure-app
DynamicUser=true

# Process restrictions
NoNewPrivileges=true
RemoveIPC=true
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true

# Namespace restrictions
PrivateTmp=true
PrivateDevices=true
PrivateNetwork=false
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
RestrictNamespaces=true

# File system restrictions
ProtectSystem=strict
ProtectHome=true
ProtectProc=invisible
ProcSubset=pid
ReadWritePaths=/var/lib/secure-app
ReadOnlyPaths=/etc/secure-app
InaccessiblePaths=/home /root /boot

# Capability restrictions
CapabilityBoundingSet=
AmbientCapabilities=

# System call filtering
SystemCallFilter=@system-service
SystemCallFilter=~@mount @swap @reboot @raw-io @privileged
SystemCallErrorNumber=EPERM

# Network restrictions
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
IPAddressAllow=10.0.0.0/8

# Resource limits
MemoryMax=512M
CPUQuota=50%
TasksMax=100
LimitNOFILE=1024

[Install]
WantedBy=multi-user.target
```

### Security Analysis

```bash
#!/bin/bash
# security_analysis.sh - Systemd security analysis

# Analyze service security
analyze_service_security() {
    local service=$1
    
    echo "=== Security Analysis: $service ==="
    
    # Show security-related properties
    systemctl show $service --property=User,Group,PrivateTmp,ProtectSystem,ProtectHome,NoNewPrivileges,CapabilityBoundingSet
    echo
    
    # Check for common security issues
    echo "Security recommendations:"
    
    # Check if running as root
    if systemctl show $service --property=User | grep -q "User=$"; then
        echo "⚠️  Service may be running as root"
    fi
    
    # Check basic hardening
    if ! systemctl show $service --property=NoNewPrivileges | grep -q "yes"; then
        echo "⚠️  NoNewPrivileges not enabled"
    fi
    
    if ! systemctl show $service --property=PrivateTmp | grep -q "yes"; then
        echo "⚠️  PrivateTmp not enabled"
    fi
    
    if ! systemctl show $service --property=ProtectSystem | grep -q "strict"; then
        echo "⚠️  ProtectSystem not set to strict"
    fi
    
    echo "✅ Security analysis complete"
}

# Generate security report
generate_security_report() {
    local output="/tmp/systemd_security_report_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Generating systemd security report..."
    
    {
        echo "=== Systemd Security Report ==="
        echo "Generated: $(date)"
        echo "Hostname: $(hostname)"
        echo
        
        echo "=== Services Running as Root ==="
        systemctl show "*" --property=MainPID,User,ExecStart | \
        awk '/User=$/{service=$0} /MainPID=[0-9]+/{if(service) print service " " $0; service=""}'
        echo
        
        echo "=== Services Without Security Hardening ==="
        for service in $(systemctl list-units --type=service --state=active --no-legend | awk '{print $1}'); do
            if ! systemctl show $service --property=NoNewPrivileges | grep -q "yes"; then
                echo "- $service: NoNewPrivileges not enabled"
            fi
        done
        echo
        
        echo "=== Network-Accessible Services ==="
        systemctl list-units --type=socket --state=active --no-legend
        echo
        
        echo "=== Failed Security Checks ==="
        for service in $(systemctl list-units --type=service --state=active --no-legend | awk '{print $1}'); do
            if systemctl show $service --property=User | grep -q "User=root"; then
                echo "⚠️  $service running as root"
            fi
        done
        
    } > $output
    
    echo "Security report saved to: $output"
}

# Harden existing service
harden_service() {
    local service=$1
    local service_file="/etc/systemd/system/$service"
    
    if [ ! -f "$service_file" ]; then
        echo "Service file not found: $service_file"
        return 1
    fi
    
    echo "Hardening service: $service"
    
    # Backup original
    cp "$service_file" "${service_file}.backup"
    
    # Add security options
    cat >> "$service_file" << 'EOF'

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictSUIDSGID=true
RemoveIPC=true
EOF

    echo "Security options added to $service"
    echo "Review and customize the settings, then run:"
    echo "  systemctl daemon-reload"
    echo "  systemctl restart $service"
}
```

## Troubleshooting Systemd

### Diagnostic Tools

```bash
#!/bin/bash
# systemd_troubleshooting.sh - Comprehensive troubleshooting

# System health check
system_health_check() {
    echo "=== Systemd Health Check ==="
    
    # Overall system state
    echo "System state:"
    systemctl is-system-running
    echo
    
    # Failed units
    echo "Failed units:"
    systemctl --failed --no-pager
    echo
    
    # Boot issues
    echo "Boot analysis:"
    systemd-analyze
    echo
    
    # Critical services
    echo "Critical service status:"
    for service in systemd-journald systemd-logind systemd-networkd systemd-resolved; do
        printf "%-20s: " $service
        systemctl is-active $service
    done
    echo
    
    # Resource usage
    echo "Resource usage:"
    systemctl status --no-pager | head -20
}

# Service troubleshooting
troubleshoot_service() {
    local service=$1
    
    echo "=== Troubleshooting Service: $service ==="
    
    # Service status
    echo "Service status:"
    systemctl status $service --no-pager -l
    echo
    
    # Recent logs
    echo "Recent logs:"
    journalctl -u $service --since "1 hour ago" --no-pager | tail -20
    echo
    
    # Dependencies
    echo "Dependencies:"
    systemctl list-dependencies $service --failed
    echo
    
    # Configuration
    echo "Configuration files:"
    systemctl show $service --property=FragmentPath,UnitFileState,LoadState
    echo
    
    # Process information
    if systemctl is-active $service >/dev/null; then
        echo "Process information:"
        systemctl show $service --property=MainPID,ExecStart,ExecMainStartTimestamp
        
        local main_pid=$(systemctl show $service --property=MainPID --value)
        if [ "$main_pid" != "0" ]; then
            echo "Process tree:"
            pstree -p $main_pid 2>/dev/null || echo "Process not found"
        fi
    fi
}

# Boot troubleshooting
troubleshoot_boot() {
    echo "=== Boot Troubleshooting ==="
    
    # Boot time analysis
    echo "Boot time breakdown:"
    systemd-analyze blame | head -20
    echo
    
    # Critical chain
    echo "Critical chain:"
    systemd-analyze critical-chain
    echo
    
    # Failed services during boot
    echo "Services that failed during boot:"
    journalctl -b --priority=err --no-pager | grep -i failed
    echo
    
    # Kernel messages
    echo "Kernel issues:"
    journalctl -k -b --priority=err --no-pager | head -10
}

# Dependency analysis
analyze_dependencies() {
    local unit=$1
    
    echo "=== Dependency Analysis: $unit ==="
    
    # Direct dependencies
    echo "Direct dependencies:"
    systemctl show $unit --property=Wants,Requires,After,Before
    echo
    
    # Dependency tree
    echo "Dependency tree:"
    systemctl list-dependencies $unit --all | head -30
    echo
    
    # Reverse dependencies
    echo "What depends on this unit:"
    systemctl list-dependencies --reverse $unit | head -20
    echo
    
    # Conflicting units
    echo "Conflicts:"
    systemctl show $unit --property=Conflicts
}

# Performance analysis
performance_analysis() {
    echo "=== Performance Analysis ==="
    
    # Boot performance
    echo "Boot performance:"
    systemd-analyze
    echo
    
    # Service startup times
    echo "Slowest starting services:"
    systemd-analyze blame | head -10
    echo
    
    # Current resource usage
    echo "Current resource usage:"
    systemctl status --no-pager | grep -E "(Memory|Tasks|CPU)"
    echo
    
    # Service resource consumption
    echo "Top resource-consuming services:"
    systemctl list-units --type=service --state=active --no-legend | \
    while read service _; do
        memory=$(systemctl show $service --property=MemoryCurrent --value)
        if [ "$memory" != "[not set]" ] && [ "$memory" -gt 0 ]; then
            echo "$service: $(( memory / 1024 / 1024 )) MB"
        fi
    done | sort -k2 -nr | head -10
}

# Emergency recovery
emergency_recovery() {
    echo "=== Emergency Recovery Procedures ==="
    echo
    echo "1. Boot into emergency mode:"
    echo "   systemctl emergency"
    echo
    echo "2. Boot into rescue mode:"
    echo "   systemctl rescue"
    echo
    echo "3. Reset failed units:"
    echo "   systemctl reset-failed"
    echo
    echo "4. Reload systemd configuration:"
    echo "   systemctl daemon-reload"
    echo
    echo "5. Re-enable all services:"
    echo "   systemctl preset-all"
    echo
    echo "6. Check and repair journal:"
    echo "   journalctl --verify"
    echo "   journalctl --vacuum-time=30d"
    echo
    echo "7. Boot parameter for debugging:"
    echo "   systemd.log_level=debug systemd.log_target=console"
}
```

## Best Practices

1. **Unit File Organization**: Keep custom units in `/etc/systemd/system/`
2. **Security First**: Always apply appropriate security hardening
3. **Resource Limits**: Set memory and CPU limits for services
4. **Logging**: Use structured logging with appropriate log levels
5. **Dependencies**: Define clear service dependencies and ordering
6. **Testing**: Validate unit files with `systemd-analyze verify`
7. **Monitoring**: Use timers instead of cron for modern systems

## Conclusion

Systemd represents a fundamental shift in Linux system management, providing powerful tools for service management, system initialization, and resource control. Understanding systemd's architecture, from basic service management to advanced features like socket activation and security sandboxing, is essential for modern Linux administration.

The techniques covered here—service configuration, timer management, security hardening, and troubleshooting—provide the foundation for effectively managing systemd-based systems. Whether you're deploying applications, managing services, or troubleshooting system issues, mastering systemd is crucial for modern Linux environments.