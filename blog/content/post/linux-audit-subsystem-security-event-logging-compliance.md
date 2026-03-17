---
title: "Linux Audit Subsystem: Security Event Logging and Compliance Automation"
date: 2030-07-11T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Audit", "auditd", "Compliance", "SIEM", "CIS", "PCI-DSS"]
categories:
- Linux
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Linux audit guide covering auditd configuration for production systems, audit rules for file integrity and system call monitoring, ausearch and aureport analysis, integration with SIEM systems, and automating compliance audit policies for PCI-DSS, CIS, and SOX requirements."
more_link: "yes"
url: "/linux-audit-subsystem-security-event-logging-compliance/"
---

The Linux Audit subsystem is the kernel's built-in mechanism for tracking system events from a security and compliance perspective. Unlike application-level logging, audit records are generated at the kernel level before any userspace code can suppress or alter them — a critical property for forensic integrity. Every file access, privilege escalation, network connection, and configuration change that compliance frameworks require monitoring can be captured by auditd with tamper-evident records. For enterprises subject to PCI-DSS, SOX, HIPAA, or CIS Benchmarks, a correctly configured audit subsystem is both a technical control and an audit evidence source.

<!--more-->

## Architecture of the Linux Audit System

The Linux Audit subsystem has two components:

1. **Kernel audit module**: Intercepts system calls and kernel events, generates audit records in netlink sockets.
2. **auditd daemon**: Reads from the kernel netlink socket, applies dispatch rules, and writes to log files or forwards to remote syslog/SIEM.

```
Application → System Call → Kernel Audit Hook
                                  │
                                  ▼
                          Audit Netlink Socket
                                  │
                                  ▼
                        auditd (userspace)
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
        /var/log/audit/     audisp plugins         Remote SIEM
        audit.log            (syslog, etc.)         (Elasticsearch,
                                                      Splunk, etc.)
```

### Kernel Configuration Requirements

```bash
# Verify audit kernel support
grep -i audit /boot/config-$(uname -r)
# CONFIG_AUDIT=y
# CONFIG_AUDITSYSCALL=y
# CONFIG_AUDIT_ARCH=y

# Check audit subsystem status
auditctl -s
# enabled 1
# failure 1
# pid 1234
# rate_limit 0
# backlog_limit 8192
# lost 0
# backlog 0
# backlog_wait_time 60000
# loginuid_immutable 0
```

## Installing and Configuring auditd

### Installation

```bash
# RHEL/CentOS/Rocky Linux
dnf install -y audit audit-libs

# Ubuntu/Debian
apt-get install -y auditd audispd-plugins

# Enable and start
systemctl enable --now auditd

# Verify
systemctl status auditd
```

### auditd.conf: Core Configuration

```ini
# /etc/audit/auditd.conf

# Log file configuration
log_file = /var/log/audit/audit.log
log_format = ENRICHED           # Include hostname, key context
log_group = root
log_priority = LOG_INFO

# Disk space management
max_log_file = 100              # MB per log file
num_logs = 20                   # Keep 20 rotated files (2 GB total)
max_log_file_action = ROTATE    # Rotate when file hits max_log_file
space_left = 200                # MB — trigger warning when disk below this
space_left_action = SYSLOG      # Log warning (change to EMAIL in production)
admin_space_left = 50           # MB — critical threshold
admin_space_left_action = SUSPEND  # Stop auditd if below admin threshold
disk_full_action = SUSPEND      # Stop logging if disk full (vs. losing records)
disk_error_action = SYSLOG

# Network (for remote logging via audisp-remote)
tcp_listen_port = 60            # Disabled by default
tcp_max_per_addr = 1

# Performance
priority_boost = 4              # auditd process priority boost
flush = INCREMENTAL_ASYNC       # Async flush for performance
freq = 50                       # Flush after this many records

# Backpressure — critical for high-load systems
backlog_wait_time = 60000       # ms to wait if kernel backlog is full
overflow_action = SYSLOG        # What to do if events overflow
```

## Audit Rules

Audit rules are loaded with `auditctl` at runtime or persisted in `/etc/audit/rules.d/`. Always use separate rule files organized by category.

### System Call Rules

Rules have the format:
```
-a <list>,<action> -S <syscall> [-F <field>=<value>] -k <key>

list:   task, exit, user, exclude
action: always, never
```

### CIS Benchmark Level 2 Rules

```bash
# /etc/audit/rules.d/10-cis-level2.rules

# --- Audit rule set version and documentation ---
# CIS Linux Benchmark Level 2 audit rules
# Reference: CIS Distribution Independent Linux Benchmark v2.0

# Make audit config immutable — requires reboot to change rules
# IMPORTANT: This must be the LAST rule loaded
# -e 2

# Increase kernel backlog limit for busy systems
-b 8192

# Failure mode: 1=printk, 2=panic (use 1 for production)
-f 1

# === Identity changes ===
-w /etc/group  -p wa -k identity
-w /etc/passwd -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/shadow  -p wa -k identity
-w /etc/security/opasswd -p wa -k identity

# === Sudoers changes ===
-w /etc/sudoers     -p wa -k sudoers
-w /etc/sudoers.d/  -p wa -k sudoers

# === Login and logout events ===
-w /var/log/lastlog     -p wa -k logins
-w /var/run/faillock/   -p wa -k logins
-w /var/log/wtmp        -p wa -k session
-w /var/log/btmp        -p wa -k session
-w /var/run/utmp        -p wa -k session

# === Authentication config ===
-w /etc/pam.d/         -p wa -k pam_config
-w /etc/nsswitch.conf  -p wa -k auth_config
-w /etc/pam.conf       -p wa -k auth_config

# === Network configuration changes ===
-a always,exit -F arch=b64 -S sethostname -S setdomainname -k network_modification
-w /etc/issue       -p wa -k network_modification
-w /etc/issue.net   -p wa -k network_modification
-w /etc/hosts       -p wa -k network_modification
-w /etc/sysconfig/network -p wa -k network_modification
-w /etc/network/    -p wa -k network_modification

# === System startup and shutdown ===
-w /sbin/shutdown  -p x -k power_management
-w /sbin/poweroff  -p x -k power_management
-w /sbin/reboot    -p x -k power_management
-w /sbin/halt      -p x -k power_management

# === Kernel module loading ===
-w /sbin/insmod  -p x -k kernel_modules
-w /sbin/rmmod   -p x -k kernel_modules
-w /sbin/modprobe -p x -k kernel_modules
-a always,exit -F arch=b64 -S init_module    -S delete_module -k kernel_modules
-a always,exit -F arch=b64 -S finit_module -k kernel_modules

# === Mount operations ===
-a always,exit -F arch=b64 -S mount -S umount2 -F auid!=unset -k mounts

# === Privilege escalation ===
-a always,exit -F arch=b64 -S setuid -F auid>=1000 -F auid!=unset -k privilege_escalation
-a always,exit -F arch=b64 -S setgid -F auid>=1000 -F auid!=unset -k privilege_escalation
-a always,exit -F arch=b64 -S setresuid -F auid>=1000 -F auid!=unset -k privilege_escalation
-a always,exit -F arch=b64 -S setresgid -F auid>=1000 -F auid!=unset -k privilege_escalation

# Setuid program execution
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=unset -k setuid_execution

# === File deletion ===
-a always,exit -F arch=b64 -S unlink  -F auid>=1000 -F auid!=unset -k file_deletion
-a always,exit -F arch=b64 -S unlinkat -F auid>=1000 -F auid!=unset -k file_deletion
-a always,exit -F arch=b64 -S rename  -F auid>=1000 -F auid!=unset -k file_deletion
-a always,exit -F arch=b64 -S renameat -F auid>=1000 -F auid!=unset -k file_deletion

# === Unauthorized access attempts ===
-a always,exit -F arch=b64 -S creat -S open -S openat -S open_by_handle_at \
  -S truncate -S ftruncate -F exit=-EACCES -F auid>=1000 -F auid!=unset -k access
-a always,exit -F arch=b64 -S creat -S open -S openat -S open_by_handle_at \
  -S truncate -S ftruncate -F exit=-EPERM -F auid>=1000 -F auid!=unset -k access

# === SSH configuration ===
-w /etc/ssh/sshd_config -p wa -k sshd_config

# === Cron configuration ===
-w /etc/cron.allow       -p wa -k cron
-w /etc/cron.deny        -p wa -k cron
-w /etc/cron.d/          -p wa -k cron
-w /etc/cron.daily/      -p wa -k cron
-w /etc/cron.hourly/     -p wa -k cron
-w /etc/cron.monthly/    -p wa -k cron
-w /etc/cron.weekly/     -p wa -k cron
-w /etc/crontab          -p wa -k cron
-w /var/spool/cron/crontabs -p wa -k cron

# === Audit tools protection ===
-w /sbin/auditctl  -p wa -k audit_tools
-w /sbin/auditd    -p wa -k audit_tools
-w /usr/sbin/ausearch  -p wa -k audit_tools
-w /usr/sbin/aureport  -p wa -k audit_tools
```

### PCI-DSS Additional Rules

```bash
# /etc/audit/rules.d/20-pci-dss.rules
# PCI-DSS v4.0 Requirement 10 — Audit Logging

# Requirement 10.2.1 — Individual user access to cardholder data
# Replace /app/cardholder-data with actual paths
-w /app/cardholder-data/ -p rwxa -k pci_chd_access

# Requirement 10.2.2 — All root actions
-a always,exit -F arch=b64 -F euid=0 -S all -k root_actions

# Requirement 10.2.4 — Invalid logical access attempts
-a always,exit -F arch=b64 -S open -S openat -F exit=-EACCES -k pci_access_failure
-a always,exit -F arch=b64 -S open -S openat -F exit=-EPERM  -k pci_access_failure

# Requirement 10.2.5 — Use of identification and authentication mechanisms
-w /var/log/secure     -p wa -k pci_auth
-w /var/log/auth.log   -p wa -k pci_auth

# Requirement 10.2.7 — Creation/deletion of system-level objects
-a always,exit -F arch=b64 -S mknod -S mknodat -F auid>=1000 -k pci_system_objects
-a always,exit -F arch=b64 -S swapon -S swapoff -k pci_system_objects

# Requirement 10.3 — Protect audit logs
-w /var/log/audit/ -p wa -k audit_log_modification
```

### Container and Kubernetes-Specific Rules

```bash
# /etc/audit/rules.d/30-container.rules

# Container escape vectors
-a always,exit -F arch=b64 -S unshare -k namespace_manipulation
-a always,exit -F arch=b64 -S clone -F a0&0x10000000 -k namespace_manipulation

# Namespace operations
-a always,exit -F arch=b64 -S setns -k namespace_manipulation

# Docker socket access
-w /var/run/docker.sock -p rwxa -k docker_socket

# containerd socket
-w /run/containerd/containerd.sock -p rwxa -k containerd_socket

# CRI-O socket
-w /var/run/crio/crio.sock -p rwxa -k crio_socket

# Kubernetes API server certificate files
-w /etc/kubernetes/pki/ -p wa -k k8s_pki

# Kubelet configuration
-w /etc/kubernetes/kubelet.conf -p wa -k kubelet_config
-w /var/lib/kubelet/config.yaml -p wa -k kubelet_config
```

## Loading and Managing Rules

```bash
# Load rules from all files in rules.d directory
augenrules --load

# Verify rules are loaded
auditctl -l

# Check rule count
auditctl -s | grep 'Number of rules'

# Test a specific rule — watch for file access
auditctl -w /tmp/test-file -p wa -k test_watch
touch /tmp/test-file
cat /tmp/test-file
ausearch -k test_watch --start recent
# Clean up test rule
auditctl -W /tmp/test-file -p wa -k test_watch

# Reload after rule changes (soft reload)
service auditd reload
# OR
kill -HUP $(cat /var/run/auditd.pid)
```

## Querying Audit Logs with ausearch and aureport

### ausearch — Event-Level Queries

```bash
# Events by audit key
ausearch -k identity
ausearch -k privilege_escalation
ausearch -k pci_chd_access

# Events in a time range
ausearch -k logins --start 2026-03-01 --end 2026-03-17

# Recent events (last hour)
ausearch -k sudoers --start recent

# Events by user
ausearch -ua 1001                        # by UID
ausearch --loginuid 1001                 # by login UID (auid)

# Failed events only (permission denied)
ausearch --exit -EACCES
ausearch --exit -EPERM

# Events by process
ausearch -p 12345

# Events by file
ausearch -f /etc/passwd

# Display in human-readable format
ausearch -k identity --interpret

# Output as raw (for parsing)
ausearch -k identity --raw | head -20
```

### aureport — Statistical Reports

```bash
# Authentication summary (last 7 days)
aureport --auth --start 2026-03-10 --end 2026-03-17

# Failed login attempts
aureport --auth --failed

# Summary of all audit event types
aureport --summary

# Executable usage report
aureport -x --summary

# Login/logout report
aureport -l

# Account modification report
aureport --mods

# File access report
aureport -f --summary

# Events by user
aureport -u

# System call summary
aureport -s --summary

# Network events
aureport -n

# Anomaly report — unusual events
aureport --anomaly
```

### Parsing Audit Records Programmatically

Audit records have structured fields that can be parsed:

```bash
# Sample audit record
# type=SYSCALL msg=audit(1710600000.123:4567): arch=c000003e syscall=59 success=yes
#   exit=0 a0=5614bde0 a1=5614c000 a2=5614c020 a3=7ffc1234 items=2 ppid=1234
#   pid=5678 auid=1001 uid=1001 gid=1001 euid=1001 suid=1001 fsuid=1001
#   egid=1001 sgid=1001 fsgid=1001 tty=pts0 ses=12 comm="bash" exe="/bin/bash"
#   subj=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023 key="shell_exec"

# Parse into structured format with Python
python3 << 'EOF'
import subprocess
import re
import json

def parse_audit_record(line):
    fields = {}
    # Parse key=value pairs
    for match in re.finditer(r'(\w+)=(?:"([^"]*)"|([\S]+))', line):
        key = match.group(1)
        value = match.group(2) or match.group(3)
        fields[key] = value
    return fields

result = subprocess.run(
    ['ausearch', '-k', 'privilege_escalation', '--start', 'recent', '--raw'],
    capture_output=True, text=True
)

records = []
current_event = []
for line in result.stdout.splitlines():
    if line.startswith('----'):
        if current_event:
            records.append([parse_audit_record(r) for r in current_event])
            current_event = []
    else:
        current_event.append(line)

for event in records[:5]:  # First 5 events
    print(json.dumps(event, indent=2))
EOF
```

## SIEM Integration

### Forwarding with audisp-remote

```ini
# /etc/audisp/plugins.d/au-remote.conf
active = yes
direction = out
path = /sbin/audisp-remote
type = always
args =
format = string
```

```ini
# /etc/audisp/audisp-remote.conf
remote_server = siem.company.internal
port = 60
local_port = any
transport = tcp
queue_file = /var/spool/audispd-remote.q
mode = immediate
queue_depth = 2048
format = managed
network_retry_time = 1
max_tries_per_record = 3
max_time_per_record = 5
heartbeat_timeout = 0
```

### Forwarding with rsyslog

```ini
# /etc/rsyslog.d/audit.conf
# Read audit.log and forward to central syslog
module(load="imfile" PollingInterval="5")

input(
  type="imfile"
  File="/var/log/audit/audit.log"
  Tag="audit"
  Facility="local6"
  Severity="notice"
  PersistStateInterval="200"
  ReadMode="0"
)

# Forward to SIEM
local6.* @@siem.company.internal:514
```

### Elasticsearch Ingest Pipeline for Audit Logs

```json
{
  "description": "Linux audit log enrichment",
  "processors": [
    {
      "grok": {
        "field": "message",
        "patterns": [
          "type=%{WORD:audit.type} msg=audit\\(%{NUMBER:audit.epoch}:%{NUMBER:audit.sequence}\\): %{GREEDYDATA:audit.data}"
        ]
      }
    },
    {
      "kv": {
        "field": "audit.data",
        "field_split": " ",
        "value_split": "=",
        "target_field": "audit.fields",
        "strip_brackets": true,
        "ignore_failure": true
      }
    },
    {
      "date": {
        "field": "audit.epoch",
        "formats": ["UNIX"],
        "target_field": "@timestamp"
      }
    },
    {
      "convert": {
        "field": "audit.fields.uid",
        "type": "integer",
        "ignore_failure": true
      }
    },
    {
      "convert": {
        "field": "audit.fields.auid",
        "type": "integer",
        "ignore_failure": true
      }
    },
    {
      "geoip": {
        "field": "audit.fields.addr",
        "target_field": "audit.geoip",
        "ignore_failure": true
      }
    }
  ]
}
```

## Compliance Automation

### Ansible Role for Audit Configuration

```yaml
---
# roles/audit-compliance/tasks/main.yml

- name: Install audit packages
  package:
    name:
      - audit
      - audit-libs
    state: present

- name: Configure auditd.conf
  template:
    src: auditd.conf.j2
    dest: /etc/audit/auditd.conf
    owner: root
    group: root
    mode: "0640"
  notify: restart auditd

- name: Deploy CIS Level 2 audit rules
  copy:
    src: rules/10-cis-level2.rules
    dest: /etc/audit/rules.d/10-cis-level2.rules
    owner: root
    group: root
    mode: "0640"
  notify: reload audit rules

- name: Deploy PCI-DSS audit rules
  copy:
    src: rules/20-pci-dss.rules
    dest: /etc/audit/rules.d/20-pci-dss.rules
    owner: root
    group: root
    mode: "0640"
  when: audit_pci_dss_enabled | default(false)
  notify: reload audit rules

- name: Ensure auditd is enabled and running
  service:
    name: auditd
    state: started
    enabled: true

- name: Verify audit rules loaded
  command: auditctl -l
  register: audit_rules
  changed_when: false

- name: Check expected rule count
  assert:
    that:
      - audit_rules.stdout_lines | length >= audit_minimum_rules | default(50)
    fail_msg: "Fewer audit rules loaded than expected. Check /etc/audit/rules.d/"

handlers:
  - name: restart auditd
    service:
      name: auditd
      state: restarted

  - name: reload audit rules
    command: augenrules --load
```

### Compliance Verification Script

```bash
#!/usr/bin/env bash
# audit-compliance-check.sh
# Verifies audit configuration meets CIS Benchmark and PCI-DSS requirements

set -euo pipefail

PASS=0
FAIL=0
WARN=0

check() {
    local name="$1"
    local result="$2"
    local expected="$3"

    if [[ "${result}" == "${expected}" ]]; then
        echo "PASS: ${name}"
        ((PASS++)) || true
    else
        echo "FAIL: ${name} (expected: '${expected}', got: '${result}')"
        ((FAIL++)) || true
    fi
}

warn() {
    local name="$1"
    local message="$2"
    echo "WARN: ${name} — ${message}"
    ((WARN++)) || true
}

echo "=== Linux Audit Compliance Check ==="
echo "Host: $(hostname)"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 1. auditd service running
check "auditd running" \
    "$(systemctl is-active auditd 2>/dev/null || echo 'inactive')" \
    "active"

# 2. auditd enabled at boot
check "auditd enabled" \
    "$(systemctl is-enabled auditd 2>/dev/null || echo 'disabled')" \
    "enabled"

# 3. Audit kernel support
check "audit kernel module" \
    "$(grep -c 'CONFIG_AUDIT=y' /boot/config-$(uname -r) 2>/dev/null || echo '0')" \
    "1"

# 4. auditctl status
ENABLED=$(auditctl -s 2>/dev/null | awk '/enabled/{print $2}')
check "audit enabled" "${ENABLED}" "1"

# 5. Key rules present
for key in identity sudoers logins mounts privilege_escalation kernel_modules; do
    count=$(auditctl -l 2>/dev/null | grep -c "\-k ${key}" || echo 0)
    if [[ "${count}" -gt 0 ]]; then
        echo "PASS: audit key '${key}' present (${count} rules)"
        ((PASS++)) || true
    else
        echo "FAIL: audit key '${key}' missing"
        ((FAIL++)) || true
    fi
done

# 6. Log file exists and is writable
check "audit log file" \
    "$(test -f /var/log/audit/audit.log && echo 'exists' || echo 'missing')" \
    "exists"

# 7. Disk space
SPACE_LEFT=$(df /var/log/audit/ | awk 'NR==2{print int($4/1024)}')
if [[ "${SPACE_LEFT}" -gt 500 ]]; then
    echo "PASS: audit log disk space ${SPACE_LEFT} MB available"
    ((PASS++)) || true
else
    echo "WARN: audit log disk space low: ${SPACE_LEFT} MB"
    ((WARN++)) || true
fi

# 8. Backlog limit
BACKLOG=$(auditctl -s 2>/dev/null | awk '/backlog_limit/{print $2}')
if [[ "${BACKLOG:-0}" -ge 8192 ]]; then
    echo "PASS: backlog_limit ${BACKLOG} >= 8192"
    ((PASS++)) || true
else
    echo "WARN: backlog_limit ${BACKLOG:-unknown} < 8192 (may lose events under load)"
    ((WARN++)) || true
fi

echo ""
echo "=== Summary ==="
echo "PASS: ${PASS}"
echo "WARN: ${WARN}"
echo "FAIL: ${FAIL}"

if [[ "${FAIL}" -gt 0 ]]; then
    exit 1
fi
```

## Log Rotation and Retention

```bash
# /etc/logrotate.d/audit
/var/log/audit/audit.log {
    daily
    rotate 180          # 6 months retention
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        /usr/sbin/service auditd condrestart 2>/dev/null || true
    endscript
}
```

For long-term compliance archiving, forward audit logs to immutable object storage immediately:

```bash
#!/usr/bin/env bash
# archive-audit-logs.sh — run daily via cron
# Archives audit logs to S3 with integrity hash

DATE=$(date +%Y%m%d)
ARCHIVE_DIR="/tmp/audit-archive-${DATE}"
mkdir -p "${ARCHIVE_DIR}"

# Copy yesterday's audit logs
find /var/log/audit/ -name "audit.log.*" -mtime +0 -mtime -2 \
  -exec cp {} "${ARCHIVE_DIR}/" \;

# Generate SHA-256 hashes for integrity verification
sha256sum "${ARCHIVE_DIR}"/* > "${ARCHIVE_DIR}/CHECKSUMS.sha256"

# Compress and upload to S3
tar czf "/tmp/audit-${DATE}.tar.gz" -C /tmp "audit-archive-${DATE}/"

aws s3 cp "/tmp/audit-${DATE}.tar.gz" \
  "s3://company-audit-logs/linux/$(hostname)/${DATE}/audit-${DATE}.tar.gz" \
  --server-side-encryption aws:kms \
  --storage-class STANDARD_IA

# Cleanup
rm -rf "${ARCHIVE_DIR}" "/tmp/audit-${DATE}.tar.gz"
```

## Summary

The Linux Audit subsystem provides kernel-level, tamper-resistant event recording that forms the technical foundation of compliance programs for PCI-DSS, CIS Benchmarks, SOX, and HIPAA:

- **Rule organization**: Separate files per compliance domain in `/etc/audit/rules.d/`, loaded atomically with `augenrules`.
- **Critical rule categories**: Identity changes, privilege escalation, kernel module loading, filesystem access failures, and authentication events cover the majority of compliance requirements.
- **Performance tuning**: Set `backlog_limit` to at least 8192, use `INCREMENTAL_ASYNC` flush, and size log rotation to retain 90-180 days on-host.
- **SIEM integration**: Forward via `audisp-remote` or rsyslog immediately — do not rely solely on on-host logs for compliance evidence.
- **Immutable archiving**: Ship audit logs to write-once S3 or similar storage with integrity hashes for forensic validity.
- **Automation**: Deploy and verify audit rules through Ansible with compliance checks in CI to detect configuration drift.
