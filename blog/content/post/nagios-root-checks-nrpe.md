---
title: "Running Nagios Checks as Root with NRPE: A Secure Implementation Guide"
date: 2026-01-15T09:00:00-06:00
draft: false
tags: ["Nagios", "NRPE", "Monitoring", "Security", "System Administration", "Linux"]
categories:
- Monitoring
- Security
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to securely configure and run Nagios checks with root privileges using NRPE. Includes security best practices, configuration examples, and implementation guidelines."
more_link: "yes"
url: "/nagios-root-checks-nrpe/"
---

Master the art of securely running Nagios checks with root privileges using NRPE while maintaining system security and monitoring effectiveness.

<!--more-->

# Running Nagios Checks as Root with NRPE

## Understanding the Need

Some Nagios checks require root privileges to:
- Access system files
- Monitor protected resources
- Execute privileged commands
- Perform system-level checks

## Secure Implementation

### 1. Sudo Configuration

```bash
# /etc/sudoers.d/nrpe
# Allow NRPE to run specific commands as root
Defaults:nrpe !requiretty
nrpe ALL=(root) NOPASSWD: /usr/lib64/nagios/plugins/check_disk
nrpe ALL=(root) NOPASSWD: /usr/lib64/nagios/plugins/check_load
nrpe ALL=(root) NOPASSWD: /usr/lib64/nagios/plugins/custom_root_check.sh
```

### 2. NRPE Configuration

```ini
# /etc/nagios/nrpe.cfg

# Basic Settings
server_address=0.0.0.0
server_port=5666
allowed_hosts=127.0.0.1,monitoring.server.ip
dont_blame_nrpe=0
allow_bash_command_substitution=0

# Command Definitions
command[check_disk]=/usr/bin/sudo /usr/lib64/nagios/plugins/check_disk -w 20% -c 10% -p /
command[check_load]=/usr/bin/sudo /usr/lib64/nagios/plugins/check_load -w 15,10,5 -c 30,25,20
command[check_custom]=/usr/bin/sudo /usr/lib64/nagios/plugins/custom_root_check.sh
```

## Security Hardening

### 1. File Permissions

```bash
#!/bin/bash
# secure-nrpe.sh

# Set correct ownership
chown root:nrpe /etc/nagios/nrpe.cfg
chown -R root:nrpe /usr/lib64/nagios/plugins/

# Set restrictive permissions
chmod 640 /etc/nagios/nrpe.cfg
chmod 750 /usr/lib64/nagios/plugins/
find /usr/lib64/nagios/plugins/ -type f -exec chmod 750 {} \;

# Secure sudo configuration
chmod 440 /etc/sudoers.d/nrpe
```

### 2. Plugin Security

```bash
#!/bin/bash
# check-plugin-security.sh

check_plugin_security() {
    local plugin=$1
    
    # Check file permissions
    if [[ $(stat -c %a "$plugin") != "750" ]]; then
        echo "Warning: Incorrect permissions on $plugin"
    fi
    
    # Check ownership
    if [[ $(stat -c %U:%G "$plugin") != "root:nrpe" ]]; then
        echo "Warning: Incorrect ownership on $plugin"
    fi
    
    # Check for SUID/SGID bits
    if [[ -u "$plugin" || -g "$plugin" ]]; then
        echo "Warning: SUID/SGID bits set on $plugin"
    fi
}

# Check all plugins
for plugin in /usr/lib64/nagios/plugins/*; do
    check_plugin_security "$plugin"
done
```

## Implementation Guide

### 1. Custom Root Check Template

```bash
#!/bin/bash
# custom_root_check.sh

# Exit codes
OK=0
WARNING=1
CRITICAL=2
UNKNOWN=3

# Function to handle cleanup
cleanup() {
    # Remove temporary files
    rm -f /tmp/check_tmp.*
}

# Set trap for cleanup
trap cleanup EXIT

# Perform check with root privileges
perform_check() {
    local result
    local status=$OK
    
    # Your root-level check logic here
    # Example: Check system file
    if [[ ! -f "/path/to/protected/file" ]]; then
        echo "CRITICAL - Protected file not found"
        return $CRITICAL
    fi
    
    # Example: Check protected service
    if ! systemctl is-active --quiet protected-service; then
        echo "WARNING - Protected service not running"
        return $WARNING
    fi
    
    echo "OK - All checks passed"
    return $OK
}

# Main execution
main() {
    local check_result
    perform_check
    check_result=$?
    
    exit $check_result
}

main "$@"
```

### 2. Monitoring Configuration

```cfg
# services.cfg
define service {
    use                     generic-service
    host_name              target-host
    service_description    Root Level Disk Check
    check_command         check_nrpe!check_disk
    notifications_enabled  1
    check_interval        5
}

define service {
    use                     generic-service
    host_name              target-host
    service_description    Custom Root Check
    check_command         check_nrpe!check_custom
    notifications_enabled  1
    check_interval        10
}
```

## Monitoring and Auditing

### 1. NRPE Logging

```bash
#!/bin/bash
# setup-nrpe-logging.sh

# Configure rsyslog for NRPE
cat > /etc/rsyslog.d/nrpe.conf << 'EOF'
if $programname == 'nrpe' then /var/log/nrpe.log
& stop
EOF

# Create log file with proper permissions
touch /var/log/nrpe.log
chown nrpe:nrpe /var/log/nrpe.log
chmod 640 /var/log/nrpe.log

# Configure log rotation
cat > /etc/logrotate.d/nrpe << 'EOF'
/var/log/nrpe.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    create 640 nrpe nrpe
}
EOF

# Restart services
systemctl restart rsyslog
```

### 2. Audit Configuration

```bash
# Enable audit rules for NRPE
auditctl -w /usr/lib64/nagios/plugins/ -p rwxa -k nrpe_plugins
auditctl -w /etc/nagios/nrpe.cfg -p rwa -k nrpe_config
auditctl -w /etc/sudoers.d/nrpe -p rwa -k nrpe_sudo
```

## Best Practices

1. **Security Principles**
   - Minimize root access
   - Use specific sudo rules
   - Audit all actions
   - Regular security reviews

2. **Maintenance**
   - Regular permission checks
   - Plugin updates
   - Security patches
   - Configuration reviews

3. **Documentation**
   - Track root checks
   - Document permissions
   - Maintain change logs
   - Security procedures

Remember to regularly review and update your NRPE configuration to maintain security while ensuring effective system monitoring.
