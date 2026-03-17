---
title: "Linux Audit Subsystem: auditd Rules, SIEM Integration, and Compliance Automation"
date: 2030-03-14T00:00:00-05:00
draft: false
tags: ["Linux", "auditd", "SIEM", "Compliance", "PCI-DSS", "SOC2", "Security", "Filebeat"]
categories: ["Linux", "Security", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to writing auditd rules for PCI-DSS and SOC2 compliance, ausearch and aureport analysis, shipping audit logs to SIEM with Filebeat, and automated compliance reporting."
more_link: "yes"
url: "/linux-audit-subsystem-auditd-siem-compliance/"
---

The Linux Audit subsystem provides an immutable, kernel-level record of security-sensitive system calls and file accesses. Unlike application-level logging that can be bypassed or tampered with, audit records are generated in the kernel and written to a tamper-evident log before any userspace code can intercept them. This property makes auditd the foundation for demonstrable compliance with PCI-DSS, SOC2, HIPAA, and CIS Benchmark requirements on Linux systems. This guide covers the complete audit infrastructure from rule authoring through SIEM integration and automated compliance reporting.

<!--more-->

## Linux Audit Architecture

The kernel audit subsystem consists of:

- **Kernel audit module**: Intercepts security-sensitive operations (system calls, file accesses, network connections)
- **auditd daemon**: Userspace daemon that receives kernel audit events and writes them to disk
- **audisp** (Audit Dispatcher): Multiplexes audit records to multiple consumers (files, syslog, remote systems)
- **audit rules**: Filters that define which events to record

### Kernel Audit Flow

```
System call invoked
        |
Kernel checks audit rules
        |
If match: audit record generated → netlink socket
        |
auditd receives via netlink
        |
Writes to /var/log/audit/audit.log
        +→ audisp plugins (syslog, remote, etc.)
```

```bash
# Check if audit subsystem is loaded
lsmod | grep audit
# audit  (module)
# autofs4 uses audit

# Check kernel audit configuration
cat /proc/sys/kernel/audit
# 1 = enabled

# Check auditd status
systemctl status auditd
auditctl -s
# enabled 1
# failure 1   (1=printk, 2=panic on failure)
# pid 1234
# rate_limit 0
# backlog_limit 8192
# lost 0
# backlog 0
# backlog_wait_time 60000
# loginuid_immutable 0 unlocked

# View current audit rules
auditctl -l

# Count current rules
auditctl -l | wc -l
```

## Writing Audit Rules

Audit rules come in three types:
- **Control rules**: Modify audit system behavior
- **File watch rules**: Monitor files and directories
- **System call rules**: Audit specific system calls

### Rule Syntax

```bash
# File watch rules
# -w <path>    : watch this path
# -p <perms>   : permissions to watch (r=read, w=write, x=execute, a=attribute change)
# -k <key>     : tag for this rule (for searching)

# Watch /etc/passwd for writes and attribute changes
auditctl -w /etc/passwd -p wa -k identity

# Watch entire /etc directory for all access
auditctl -w /etc -p rwxa -k etc_changes

# System call rules
# -a <list>,<action>: append rule, list can be: always, never, exit, task, user
# action: always=log, never=ignore
# -S <syscall>     : system call name or number
# -F <field>=<val> : filter field

# Audit all execve() calls by non-root users
auditctl -a always,exit -F arch=b64 -S execve -F uid!=0 -k cmd_execution

# Audit privilege escalation attempts
auditctl -a always,exit -F arch=b64 -S setuid -S setgid -F uid!=0 -k privilege_escalation

# Audit file deletions by users other than root
auditctl -a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat \
    -F uid!=0 -k file_deletion
```

### PCI-DSS Compliance Rule Set

PCI-DSS requires auditing of all access to cardholder data, authentication events, privilege escalation, and configuration changes.

```bash
# /etc/audit/rules.d/pci-dss.rules
# PCI-DSS v4.0 Compliance Audit Rules

# ===== Control Rules =====
# Delete all existing rules
-D

# Increase backlog buffer for high-traffic systems
-b 16384

# Enable auditing
-e 2

# Failure mode: 1=printk, 2=panic
# For PCI-DSS, use 1 to avoid DOS via audit failure
-f 1

# ===== Identity and Access Management (PCI 8.x) =====
# Monitor /etc/passwd and group files
-w /etc/passwd -p wa -k pci_identity
-w /etc/shadow -p wa -k pci_identity
-w /etc/group -p wa -k pci_identity
-w /etc/gshadow -p wa -k pci_identity
-w /etc/sudoers -p wa -k pci_privileged_access
-w /etc/sudoers.d/ -p wa -k pci_privileged_access

# PAM configuration changes
-w /etc/pam.d/ -p wa -k pci_pam_config
-w /lib/security/ -p wa -k pci_pam_config
-w /lib64/security/ -p wa -k pci_pam_config

# SSH configuration
-w /etc/ssh/sshd_config -p wa -k pci_sshd_config
-w /etc/ssh/ -p wa -k pci_ssh_config

# ===== Authentication Events (PCI 8.2.x) =====
# Failed login attempts
-w /var/log/lastlog -p wa -k pci_login_events
-w /var/run/faillock/ -p wa -k pci_login_events

# su and sudo usage
-w /bin/su -p x -k pci_su_usage
-w /usr/bin/sudo -p x -k pci_sudo_usage
-w /var/log/sudo.log -p wa -k pci_sudo_log

# ===== Privilege Escalation (PCI 7.x, 8.x) =====
# setuid/setgid system calls
-a always,exit -F arch=b64 -S setuid -S setgid -S setreuid -S setregid \
    -F uid!=0 -k pci_privilege_escalation
-a always,exit -F arch=b32 -S setuid -S setgid -S setreuid -S setregid \
    -F uid!=0 -k pci_privilege_escalation

# Capability changes
-a always,exit -F arch=b64 -S capset -k pci_privilege_escalation

# suid/sgid programs
-a always,exit -F arch=b64 -S execve -F euid=0 -F uid!=0 -k pci_setuid_exec
-a always,exit -F arch=b64 -S execve -F egid=0 -F gid!=0 -k pci_setgid_exec

# ===== File System Changes (PCI 10.x) =====
# Modifications to executable files
-w /usr/sbin/ -p wa -k pci_usr_sbin_changes
-w /usr/bin/ -p wa -k pci_usr_bin_changes
-w /sbin/ -p wa -k pci_sbin_changes
-w /bin/ -p wa -k pci_bin_changes

# Kernel modules
-w /etc/modprobe.conf -p wa -k pci_module_config
-w /etc/modprobe.d/ -p wa -k pci_module_config
-a always,exit -F arch=b64 -S init_module -S finit_module -S delete_module \
    -k pci_kernel_module

# Cron and scheduled tasks
-w /etc/cron.d/ -p wa -k pci_cron_changes
-w /etc/cron.daily/ -p wa -k pci_cron_changes
-w /etc/crontab -p wa -k pci_cron_changes
-w /var/spool/cron/ -p wa -k pci_cron_changes
-w /etc/cron.deny -p wa -k pci_cron_changes

# Network configuration
-w /etc/hosts -p wa -k pci_network_config
-w /etc/hostname -p wa -k pci_network_config
-w /etc/resolv.conf -p wa -k pci_network_config
-w /etc/network/ -p wa -k pci_network_config
-w /etc/sysconfig/network -p wa -k pci_network_config

# ===== System Call Audit (PCI 10.2.x) =====
# All execve calls (command execution) - very verbose, filter in SIEM
-a always,exit -F arch=b64 -S execve -k pci_exec
-a always,exit -F arch=b32 -S execve -k pci_exec

# File deletions
-a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat \
    -F uid!=0 -k pci_file_deletion

# chown/chmod to detect permission tampering
-a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat -k pci_perm_change
-a always,exit -F arch=b64 -S chown -S fchown -S fchownat -S lchown -k pci_owner_change

# ===== Network Connections =====
# Socket creation (detect new network services)
-a always,exit -F arch=b64 -S socket -F a0=2 -k pci_inet4_socket
-a always,exit -F arch=b64 -S socket -F a0=10 -k pci_inet6_socket

# ===== Immutable Lock =====
# Lock rules after loading (cannot be changed without reboot)
# WARNING: Only enable after testing, requires reboot to unlock
# -e 2
```

### SOC2 Compliance Rules

SOC2 Trust Services Criteria require auditing of logical access, change management, and availability:

```bash
# /etc/audit/rules.d/soc2.rules
# SOC2 Type II Audit Rules

-D
-b 16384
-f 1

# ===== CC6: Logical and Physical Access Controls =====
# All authentication events
-a always,exit -F arch=b64 -S open -F path=/var/log/auth.log -k soc2_auth
-w /var/log/secure -p wa -k soc2_auth_log
-w /var/log/auth.log -p wa -k soc2_auth_log

# Login configuration
-w /etc/login.defs -p wa -k soc2_login_config
-w /etc/securetty -p wa -k soc2_securetty

# User and group management
-a always,exit -F arch=b64 -S add_key -S request_key -S keyctl -k soc2_keyring

# Account lockout
-w /etc/security/pwquality.conf -p wa -k soc2_password_policy
-w /etc/security/access.conf -p wa -k soc2_access_control

# SSH key management
-w /root/.ssh/ -p wa -k soc2_root_ssh_keys
-a always,exit -F arch=b64 -S open -F dir=/home -F name=authorized_keys \
    -F perm=wa -k soc2_user_ssh_keys

# ===== CC7: System Operations =====
# System and service changes
-w /etc/init.d/ -p wa -k soc2_init_changes
-w /lib/systemd/ -p wa -k soc2_systemd_changes
-w /etc/systemd/ -p wa -k soc2_systemd_config
-w /usr/lib/systemd/ -p wa -k soc2_systemd_units

# Container runtime changes
-w /etc/docker/ -p wa -k soc2_docker_config
-w /var/lib/docker/ -p wa -k soc2_docker_data

# Firewall changes
-w /etc/iptables/ -p wa -k soc2_firewall
-w /etc/nftables.conf -p wa -k soc2_firewall
-a always,exit -F arch=b64 -S setsockopt -k soc2_socket_options

# ===== CC8: Change Management =====
# Package management
-w /usr/bin/apt -p x -k soc2_package_mgmt
-w /usr/bin/apt-get -p x -k soc2_package_mgmt
-w /usr/bin/dpkg -p x -k soc2_package_mgmt
-w /usr/bin/yum -p x -k soc2_package_mgmt
-w /usr/bin/rpm -p x -k soc2_package_mgmt
-w /usr/bin/pip -p x -k soc2_package_mgmt
-w /usr/bin/pip3 -p x -k soc2_package_mgmt

# Application deployments
-a always,exit -F arch=b64 -S execve -F path=/usr/bin/rsync -k soc2_rsync
-a always,exit -F arch=b64 -S execve -F path=/usr/bin/git -k soc2_git

# Bootloader and kernel
-w /boot/ -p wa -k soc2_boot_changes
-w /etc/grub.d/ -p wa -k soc2_grub_config

# ===== Availability (A-series) =====
# Disk and filesystem changes
-a always,exit -F arch=b64 -S mount -S umount2 -k soc2_mount

# Time synchronization changes (for log integrity)
-w /etc/chrony.conf -p wa -k soc2_time_config
-w /etc/ntp.conf -p wa -k soc2_time_config
-a always,exit -F arch=b64 -S adjtimex -S settimeofday -k soc2_time_change
```

## Managing Audit Rules with augenrules

```bash
# augenrules reads rules from /etc/audit/rules.d/*.rules
# and compiles them into /etc/audit/audit.rules

# Apply rules from rules.d/
augenrules --load

# Check for rule compilation errors
augenrules --check

# View compiled rules
cat /etc/audit/audit.rules

# Reload without restarting auditd
service auditd reload
# or
kill -HUP $(cat /var/run/auditd.pid)

# Check rules loaded in kernel
auditctl -l

# Count total rules
auditctl -l | wc -l

# Check audit system status
auditctl -s
```

## Searching and Analyzing Audit Logs

### ausearch: Real-Time Log Analysis

```bash
# ausearch syntax:
# -k <key>        : search by rule key
# -m <type>       : search by message type (AVC, EXECVE, USER_AUTH, etc.)
# -ts <start>     : start timestamp (recent, today, yesterday, or date)
# -te <end>       : end timestamp
# -i              : interpret output (translate UIDs to names, etc.)
# -x <command>    : search by executable path

# Find all sudo usage today
ausearch -k pci_sudo_usage -ts today -i

# Find failed authentication events
ausearch -m USER_AUTH -ts today | grep res=failed

# Find privilege escalation events
ausearch -k pci_privilege_escalation -ts today -i

# Find all commands executed in the last hour
ausearch -k pci_exec -ts recent -i | grep -i execve

# Find changes to /etc/passwd
ausearch -k identity -ts today

# Find all events for a specific UID
ausearch -ua 1001 -ts today -i

# Find file deletions
ausearch -k pci_file_deletion -ts today -i

# Find events by PID
ausearch -pp 12345 -ts today

# Complex query: failed SSH login attempts with interpretation
ausearch -m USER_LOGIN -ts "$(date -d '1 hour ago' '+%m/%d/%Y %H:%M:%S')" \
    | grep result=failed | ausearch -i

# Output in JSON format for SIEM processing
ausearch -k pci_sudo_usage -ts today --format json
```

### aureport: Compliance Reporting

```bash
# Generate summary report of audit events
aureport --summary

# Report on authentication events
aureport --auth

# Report on failed events
aureport --failed

# Report on anomaly events
aureport --anomaly

# Report on file events
aureport --file

# Report on executable events
aureport --executable

# Report on login events
aureport --login

# Report on user events
aureport --user

# Report on terminal events
aureport --tty

# Specific time range report
aureport --start today --end now --auth

# Export report to CSV
aureport --auth --format csv > /tmp/auth-report-$(date +%Y%m%d).csv

# Generate PCI-DSS weekly report
aureport \
    --start "$(date -d '7 days ago' '+%m/%d/%Y')" \
    --end "$(date '+%m/%d/%Y')" \
    --auth \
    --failed \
    --file \
    --executable \
    --summary \
    > /tmp/pci-weekly-report-$(date +%Y%m%d).txt
```

## Shipping Audit Logs to SIEM with Filebeat

### Filebeat Configuration for Audit Logs

```yaml
# /etc/filebeat/filebeat.yml
filebeat.inputs:

  # Audit log input
  - type: filestream
    id: auditd
    enabled: true
    paths:
      - /var/log/audit/audit.log
      - /var/log/audit/audit.log.*
    parsers:
      - multiline:
          type: pattern
          pattern: '^type='
          negate: true
          match: after
    processors:
      - decode_json_fields:
          when:
            contains:
              message: "type=EXECVE"
          fields: ["message"]
          process_array: false
          max_depth: 1
          target: ""
          overwrite_keys: false
    tags: ["audit", "linux-security"]
    fields:
      log_type: auditd
      host_environment: production
      compliance_framework: pci-dss

# Ingest pipeline for SIEM normalization
setup.ingest.pipeline:
  enabled: true
  name: "auditd-pipeline"
  description: "Normalize auditd events for SIEM"

# Output to Elasticsearch/OpenSearch
output.elasticsearch:
  hosts: ["https://elasticsearch.siem.internal:9200"]
  protocol: "https"
  ssl:
    certificate_authorities: ["/etc/filebeat/ca.crt"]
    certificate: "/etc/filebeat/filebeat.crt"
    key: "/etc/filebeat/filebeat.key"
  index: "auditd-%{+yyyy.MM.dd}"
  pipeline: "auditd-pipeline"
  username: "${ELASTICSEARCH_USERNAME}"
  password: "${ELASTICSEARCH_PASSWORD}"
  bulk_max_size: 2048
  compression_level: 3

# Index template
setup.template.settings:
  index.number_of_shards: 3
  index.number_of_replicas: 1

# Logging
logging.level: info
logging.to_files: true
logging.files:
  path: /var/log/filebeat
  name: filebeat
  keepfiles: 7
```

### Elasticsearch Ingest Pipeline for Audit Normalization

```json
{
  "description": "Normalize Linux auditd events",
  "processors": [
    {
      "grok": {
        "field": "message",
        "patterns": [
          "type=%{WORD:audit.type} msg=audit\\(%{NUMBER:audit.epoch}:%{NUMBER:audit.seq}\\): %{GREEDYDATA:audit.data}",
          "%{GREEDYDATA:audit.raw}"
        ],
        "ignore_failure": true
      }
    },
    {
      "kv": {
        "field": "audit.data",
        "field_split": " ",
        "value_split": "=",
        "target_field": "audit.fields",
        "ignore_failure": true
      }
    },
    {
      "date": {
        "field": "audit.epoch",
        "target_field": "@timestamp",
        "formats": ["UNIX"],
        "ignore_failure": true
      }
    },
    {
      "rename": {
        "field": "audit.fields.key",
        "target_field": "audit.rule_key",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "audit.fields.uid",
        "target_field": "user.id",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "audit.fields.exe",
        "target_field": "process.executable",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "audit.fields.comm",
        "target_field": "process.name",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "audit.fields.hostname",
        "target_field": "host.hostname",
        "ignore_missing": true
      }
    },
    {
      "set": {
        "field": "event.kind",
        "value": "event"
      }
    },
    {
      "script": {
        "description": "Map audit type to ECS event category",
        "lang": "painless",
        "source": "String t = ctx.audit?.type; if (t != null) { if (t.contains('AUTH') || t.contains('LOGIN')) { ctx.event.category = ['authentication']; ctx.event.type = ['info']; } else if (t.contains('EXECVE') || t.contains('SYSCALL')) { ctx.event.category = ['process']; ctx.event.type = ['start']; } else if (t.contains('CONFIG')) { ctx.event.category = ['configuration']; ctx.event.type = ['change']; } else if (t.contains('AVC')) { ctx.event.category = ['intrusion_detection']; ctx.event.type = ['denied']; } }",
        "ignore_failure": true
      }
    },
    {
      "remove": {
        "field": ["message", "audit.data", "audit.raw"],
        "ignore_missing": true
      }
    }
  ]
}
```

### Using audisp-remote for Real-Time Shipping

For high-assurance environments where audit logs must leave the system immediately:

```bash
# Install audisp-plugins
apt-get install -y audispd-plugins  # Debian/Ubuntu
dnf install -y audispd-plugins      # RHEL/CentOS

# Configure remote plugin
cat > /etc/audisp/audisp-remote.conf << 'EOF'
remote_server = siem.internal.example.com
port = 60
transport = tcp
mode = connected
queue_depth = 10000
fail_action = suspend
network_failure_action = suspend
EOF

# Configure the syslog plugin to also send to local syslog
cat > /etc/audisp/plugins.d/syslog.conf << 'EOF'
active = yes
direction = out
path = builtin_syslog
type = builtin
args = LOG_INFO LOG_LOCAL6
format = string
EOF

# Restart auditd
service auditd restart

# Monitor the remote connection
auditctl -s | grep -E "lost|backlog"
```

## Automated Compliance Reporting

### PCI-DSS Daily Report Script

```bash
#!/bin/bash
# /usr/local/sbin/pci-daily-audit-report.sh
# Generates daily PCI-DSS compliance audit report
# Run via cron: 0 7 * * * root /usr/local/sbin/pci-daily-audit-report.sh

set -euo pipefail

REPORT_DIR="/var/log/compliance/pci-dss"
DATE=$(date +%Y-%m-%d)
YESTERDAY=$(date -d yesterday +%m/%d/%Y)
TODAY=$(date +%m/%d/%Y)
REPORT_FILE="${REPORT_DIR}/pci-audit-${DATE}.txt"

mkdir -p "$REPORT_DIR"

exec > "$REPORT_FILE" 2>&1

echo "====================================================="
echo "PCI-DSS Daily Audit Report - ${DATE}"
echo "Host: $(hostname -f)"
echo "====================================================="
echo ""

echo "=== 1. Authentication Summary ==="
aureport --auth --start "$YESTERDAY" --end "$TODAY"
echo ""

echo "=== 2. Failed Authentication Events ==="
aureport --auth --failed --start "$YESTERDAY" --end "$TODAY"
echo ""

echo "=== 3. Privileged Access Usage (sudo/su) ==="
ausearch -k pci_sudo_usage -ts yesterday -te today -i 2>/dev/null | \
    grep -E "type=SYSCALL|type=EXECVE" | head -100 || echo "No events"
echo ""

echo "=== 4. Privilege Escalation Events ==="
ausearch -k pci_privilege_escalation -ts yesterday -te today -i 2>/dev/null | \
    head -50 || echo "No events"
echo ""

echo "=== 5. Identity File Changes (/etc/passwd, /etc/shadow) ==="
ausearch -k pci_identity -ts yesterday -te today -i 2>/dev/null | \
    head -50 || echo "No events"
echo ""

echo "=== 6. System Binary Changes ==="
ausearch -k pci_usr_bin_changes -k pci_usr_sbin_changes \
    -ts yesterday -te today -i 2>/dev/null | \
    head -50 || echo "No events"
echo ""

echo "=== 7. Network Configuration Changes ==="
ausearch -k pci_network_config -ts yesterday -te today -i 2>/dev/null | \
    head -50 || echo "No events"
echo ""

echo "=== 8. Cron/Scheduled Task Changes ==="
ausearch -k pci_cron_changes -ts yesterday -te today -i 2>/dev/null | \
    head -30 || echo "No events"
echo ""

echo "=== 9. Kernel Module Changes ==="
ausearch -k pci_kernel_module -ts yesterday -te today -i 2>/dev/null | \
    head -30 || echo "No events"
echo ""

echo "=== 10. File Deletions ==="
ausearch -k pci_file_deletion -ts yesterday -te today -i 2>/dev/null | \
    head -50 || echo "No events"
echo ""

echo "=== 11. Anomaly Events ==="
aureport --anomaly --start "$YESTERDAY" --end "$TODAY"
echo ""

echo "=== 12. Audit System Statistics ==="
auditctl -s
echo ""
aureport --summary --start "$YESTERDAY" --end "$TODAY"

echo ""
echo "====================================================="
echo "Report generated: $(date)"
echo "====================================================="

# Send report via email
COMPLIANCE_EMAIL="compliance-team@example.com"
SECURITY_EMAIL="security-ops@example.com"

if command -v mail &>/dev/null; then
    mail -s "PCI-DSS Daily Audit Report - $(hostname) - ${DATE}" \
        "${COMPLIANCE_EMAIL},${SECURITY_EMAIL}" \
        < "$REPORT_FILE"
fi

# Ship to SIEM via Slack webhook for critical events
CRITICAL_EVENTS=$(grep -c "privilege_escalation\|kernel_module" "$REPORT_FILE" || true)
if [ "$CRITICAL_EVENTS" -gt 0 ]; then
    curl -s -X POST https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN> \
        -H 'Content-type: application/json' \
        --data "{
            \"text\": \"PCI-DSS Alert: ${CRITICAL_EVENTS} critical audit events on $(hostname) - ${DATE}\",
            \"attachments\": [{
                \"color\": \"danger\",
                \"text\": \"Review full report at: ${REPORT_FILE}\"
            }]
        }"
fi
```

### Real-Time Alerting on Critical Events

```bash
#!/bin/bash
# /usr/local/sbin/audit-realtime-monitor.sh
# Monitor audit log in real-time for critical events
# systemd service: /etc/systemd/system/audit-monitor.service

SLACK_WEBHOOK="https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
SIEM_ENDPOINT="https://siem.internal.example.com/api/events"
HOSTNAME=$(hostname -f)

alert() {
    local severity=$1
    local message=$2
    local detail=$3

    # Log locally
    logger -t audit-monitor -p security.alert "$message: $detail"

    # Send to Slack for critical events
    if [ "$severity" = "critical" ]; then
        curl -s -X POST "$SLACK_WEBHOOK" \
            -H 'Content-type: application/json' \
            --data "{
                \"text\": \"CRITICAL Security Alert on ${HOSTNAME}\",
                \"attachments\": [{
                    \"color\": \"danger\",
                    \"title\": \"${message}\",
                    \"text\": \"${detail}\",
                    \"ts\": $(date +%s)
                }]
            }" > /dev/null 2>&1
    fi

    # Send to SIEM
    curl -s -X POST "$SIEM_ENDPOINT" \
        -H 'Content-type: application/json' \
        -H "Authorization: Bearer ${SIEM_TOKEN}" \
        --data "{
            \"severity\": \"${severity}\",
            \"source\": \"auditd\",
            \"host\": \"${HOSTNAME}\",
            \"message\": \"${message}\",
            \"detail\": \"${detail}\",
            \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
        }" > /dev/null 2>&1
}

# Monitor audit log using tail
tail -F /var/log/audit/audit.log | while read -r line; do
    # Detect privilege escalation
    if echo "$line" | grep -q "key=\"pci_privilege_escalation\""; then
        UID_VAL=$(echo "$line" | grep -o 'uid=[0-9]*' | head -1 | cut -d= -f2)
        EXE_VAL=$(echo "$line" | grep -o 'exe="[^"]*"' | cut -d'"' -f2)
        alert "critical" "Privilege Escalation Detected" \
            "UID=${UID_VAL} executed ${EXE_VAL}"
    fi

    # Detect kernel module loading
    if echo "$line" | grep -q "key=\"pci_kernel_module\""; then
        alert "high" "Kernel Module Loaded" "$line"
    fi

    # Detect /etc/passwd modification
    if echo "$line" | grep -q "key=\"pci_identity\"" && echo "$line" | grep -q "WRITE\|CREATE"; then
        UID_VAL=$(echo "$line" | grep -o 'uid=[0-9]*' | head -1 | cut -d= -f2)
        alert "critical" "Identity File Modified" \
            "UID=${UID_VAL} modified an identity file"
    fi

    # Detect root SSH key changes
    if echo "$line" | grep -q "key=\"soc2_root_ssh_keys\""; then
        alert "critical" "Root SSH Keys Modified" "$line"
    fi

    # Detect audit log tampering (someone modifying audit logs)
    if echo "$line" | grep -q "name=\"/var/log/audit\"" && echo "$line" | grep -q "WRITE\|DELETE"; then
        alert "critical" "AUDIT LOG TAMPERING ATTEMPT DETECTED" "$line"
    fi
done
```

## CIS Benchmark Audit Configuration

```bash
# CIS Level 2 Linux Benchmark audit rules
# Recommended for financial services and healthcare

# 4.1.1.1 Ensure auditd is installed
dpkg -s auditd
# or
rpm -q audit

# 4.1.1.2 Ensure auditd service is enabled
systemctl is-enabled auditd
# enabled

# 4.1.1.3 Ensure audit log storage size is configured
grep "^max_log_file " /etc/audit/auditd.conf
# max_log_file = 1024   (1GB per log file)

# 4.1.1.4 Ensure audit logs are not automatically deleted
grep "^max_log_file_action" /etc/audit/auditd.conf
# max_log_file_action = keep_logs  (do not delete old logs)

# 4.1.1.5 Ensure system is disabled when audit logs are full
grep "^space_left_action\|^disk_full_action" /etc/audit/auditd.conf
# space_left_action = email   (or syslog)
# disk_full_action = halt     (or single for less strict)

# auditd.conf optimized for compliance
cat > /etc/audit/auditd.conf << 'EOF'
local_events = yes
write_logs = yes
log_file = /var/log/audit/audit.log
log_group = root
log_format = ENRICHED
flush = INCREMENTAL_ASYNC
freq = 50
max_log_file = 1024
num_logs = 99
priority_boost = 4
disp_qos = lossy
dispatcher = /sbin/audispd
name_format = HOSTNAME
max_log_file_action = keep_logs
space_left = 100
space_left_action = email
verify_email = yes
action_mail_acct = security@example.com
admin_space_left = 50
admin_space_left_action = single
disk_full_action = suspend
disk_error_action = suspend
use_libwrap = yes
tcp_listen_port = 60
tcp_listen_queue = 5
tcp_max_per_addr = 1
tcp_client_max_idle = 0
enable_krb5 = no
krb5_principal = auditd
distribute_network = no
q_depth = 1200
overflow_action = syslog
max_restarts = 10
plugin_dir = /etc/audit/plugins.d
EOF
```

## Key Takeaways

The Linux audit subsystem is the foundation for demonstrable compliance on Linux systems because it operates below the application layer and cannot be bypassed by compromised userspace software. The key principles for production audit deployments are:

1. Use `augenrules` with rules organized in `/etc/audit/rules.d/*.rules` files rather than editing `/etc/audit/audit.rules` directly — this makes rule management, version control, and auditing the audit rules themselves much cleaner
2. Always tag rules with descriptive `-k` keys and use consistent naming conventions (e.g., `pci_`, `soc2_`, `cis_` prefixes) — `ausearch -k pci_privilege_escalation` is far faster than grepping raw audit logs during an incident
3. Set `max_log_file_action = keep_logs` and use log rotation with adequate disk space — losing audit logs during a compliance audit or investigation is a critical failure
4. Set `disk_full_action = suspend` rather than `halt` for most production systems — `halt` prevents service availability to maintain audit integrity, while `suspend` stops writing new events but keeps the system running
5. The `audisp-remote` plugin should be configured to ship audit logs off the system in real-time to a tamper-resistant SIEM — local audit logs alone are insufficient evidence of non-tampering
6. Filebeat with the Elasticsearch ingest pipeline normalizes audit records to the Elastic Common Schema (ECS) format, which enables correlation with other security data sources in your SIEM
7. Automate compliance reporting with daily cron jobs that run `aureport` and `ausearch` for each compliance control and ship results to your GRC system — manual report generation during audits introduces errors and takes time that automation eliminates
8. Review auditd's backlog (`auditctl -s | grep backlog`) and `lost` counter regularly — if `lost` is non-zero, you have a kernel buffer overflow situation where audit events are being dropped, which is a compliance violation for most frameworks
