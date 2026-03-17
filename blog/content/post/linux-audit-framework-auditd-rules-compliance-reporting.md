---
title: "Linux Audit Framework: auditd Rules, auditctl, and Compliance Reporting"
date: 2029-02-10T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Compliance", "auditd", "SIEM", "CIS"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to configuring the Linux Audit Framework for enterprise compliance, covering auditd rule architecture, auditctl syntax, systemd integration, and automated compliance report generation for PCI-DSS, CIS, and STIG requirements."
more_link: "yes"
url: "/linux-audit-framework-auditd-rules-compliance-reporting/"
---

The Linux Audit Framework is the kernel-level facility responsible for recording security-relevant system events: file access, system calls, user authentication, privilege escalation, and network connections. Unlike application-layer logging, the audit subsystem operates below the process level, making it tamper-resistant and capable of capturing events that would be invisible to traditional syslog. For organizations subject to PCI-DSS, HIPAA, CIS Benchmarks, or DISA STIG requirements, a properly configured auditd installation is not optional—it is a foundational compliance control.

This guide covers the architecture of the audit subsystem, comprehensive rule authoring with auditctl, persistent configuration management, performance tuning for production systems, and generating structured compliance reports from audit logs.

<!--more-->

## Audit Subsystem Architecture

The Linux Audit Framework consists of three layers:

1. **Kernel Audit Subsystem**: Built into the kernel, intercepts system calls and file system events before they complete. The kernel maintains an in-memory ring buffer for audit records.

2. **auditd**: The userspace daemon that reads from the kernel ring buffer and writes records to disk (`/var/log/audit/audit.log`). It also manages log rotation and the dispatcher.

3. **audispd / audisp plugins**: Optional dispatch daemon that routes audit events to additional consumers—SIEM systems, syslog, or custom analyzers.

```
┌──────────────────────────────────────────────────────────┐
│                    Linux Kernel                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │   System Call Table ──► Audit Hooks ──► Ring Buffer │  │
│  │   LSM (SELinux/AppArmor) ──────────────────────────│  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────┘
                           │ netlink (AF_NETLINK)
                           ▼
                       auditd (/var/log/audit/audit.log)
                           │
                    audisp dispatcher
                    ├── syslog plugin
                    ├── remote plugin (remote auditd)
                    └── custom SIEM plugin
```

## Installing and Enabling auditd

```bash
# RHEL/CentOS/Rocky Linux
dnf install -y audit audit-libs

# Debian/Ubuntu
apt-get install -y auditd audispd-plugins

# Enable and start
systemctl enable --now auditd

# Verify kernel audit is active
auditctl -s
# Expected: enabled 1, pid 1234, rate_limit 0, backlog_limit 8192, lost 0, backlog 0
```

## auditd.conf: Core Daemon Configuration

```bash
# /etc/audit/auditd.conf

# Log storage
log_file = /var/log/audit/audit.log
log_group = root
log_format = ENRICHED         # Include interpretive fields (uid->username, etc.)
flush = INCREMENTAL_ASYNC
freq = 50                      # Flush every 50 records

# Log rotation
max_log_file = 50              # MB per log file
max_log_file_action = ROTATE
num_logs = 10                  # Keep 10 rotated files

# Disk pressure policy
space_left = 500               # MB: trigger action when below this
space_left_action = SYSLOG
admin_space_left = 50          # MB: critical threshold
admin_space_left_action = SUSPEND
disk_full_action = SUSPEND
disk_error_action = SUSPEND

# Performance
priority_boost = 4
disp_qos = lossy               # Use lossless for compliance: disp_qos = lossless
overflow_action = SYSLOG

# TCP listener (for centralized collection)
tcp_listen_port = 60
tcp_listen_queue = 5
tcp_max_per_addr = 1
tcp_client_ports = 1024-65535
use_libwrap = yes
```

## Rule Architecture: auditctl Syntax

Audit rules have three types:

- **Control rules**: Modify audit system behavior (`-b`, `-f`, `-e`)
- **File watch rules**: Monitor file system objects (`-w`)
- **System call rules**: Filter on specific syscalls (`-a action,list -S syscall -F filter`)

### Control Rules

```bash
# Set kernel audit buffer size (increase for busy systems)
auditctl -b 16384

# Set failure mode: 0=silent, 1=printk, 2=panic
auditctl -f 1

# Set maximum rate limit (records per second; 0=unlimited)
auditctl -r 0

# Immutable mode: rules cannot be changed until reboot
# Set this LAST in the rules file on production systems
auditctl -e 2
```

### File Watch Rules

```bash
# Watch a file: -w path -p permissions -k key
# Permissions: r=read, w=write, x=execute, a=attribute change

# Watch /etc/passwd for reads and writes
auditctl -w /etc/passwd -p rwa -k identity

# Watch /etc/shadow for any access
auditctl -w /etc/shadow -p rwa -k identity

# Watch the sudoers configuration
auditctl -w /etc/sudoers -p rwa -k privileged_config
auditctl -w /etc/sudoers.d/ -p rwa -k privileged_config

# Watch SSH server config
auditctl -w /etc/ssh/sshd_config -p rwa -k ssh_config

# Watch cron entries
auditctl -w /etc/cron.d/ -p rwa -k scheduled_tasks
auditctl -w /var/spool/cron/ -p rwa -k scheduled_tasks

# Watch kernel module loading
auditctl -w /sbin/insmod -p x -k module_load
auditctl -w /sbin/rmmod  -p x -k module_load
auditctl -w /sbin/modprobe -p x -k module_load
```

### System Call Rules

```bash
# Format: -a action,list -S syscall [-F filter ...] -k key
# action: always|never
# list: task|exit|user|exclude

# Log all privilege escalation via execve of setuid binaries
auditctl -a always,exit -F arch=b64 -S execve -F euid=0 -F auid!=unset -k setuid_exec
auditctl -a always,exit -F arch=b32 -S execve -F euid=0 -F auid!=unset -k setuid_exec

# Log chmod/chown system calls (file permission changes)
auditctl -a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat -k perm_change
auditctl -a always,exit -F arch=b64 -S chown -S fchown -S lchown -S fchownat -k perm_change

# Log unsuccessful file access attempts
auditctl -a always,exit -F arch=b64 -S open -S openat -S creat -F exit=-EACCES -k access_fail
auditctl -a always,exit -F arch=b64 -S open -S openat -S creat -F exit=-EPERM  -k access_fail

# Log network socket creation
auditctl -a always,exit -F arch=b64 -S socket -F a0=2  -k network_create_ipv4
auditctl -a always,exit -F arch=b64 -S socket -F a0=10 -k network_create_ipv6

# Log process creation (fork/clone/execve)
auditctl -a always,exit -F arch=b64 -S fork -S clone -S vfork -k process_create
auditctl -a always,exit -F arch=b64 -S execve -k exec_trace

# Log deletion of files and directories
auditctl -a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat -k file_delete

# Log kernel module operations
auditctl -a always,exit -F arch=b64 -S init_module -S finit_module -S delete_module -k module_ops
```

## Persistent Rules File

Persistent rules are stored in `/etc/audit/rules.d/`. Files are merged alphabetically and loaded on auditd start. Using numbered prefixes enforces ordering.

```bash
# /etc/audit/rules.d/10-base.rules
# Delete all existing rules and set buffer size
-D
-b 16384
-f 1
--backlog_wait_time 60000

# /etc/audit/rules.d/20-identity.rules
# Identity and authentication files
-w /etc/group -p rwa -k identity
-w /etc/passwd -p rwa -k identity
-w /etc/gshadow -p rwa -k identity
-w /etc/shadow -p rwa -k identity
-w /etc/security/opasswd -p rwa -k identity
-w /etc/pam.d/ -p rwa -k pam_config
-w /etc/nsswitch.conf -p rwa -k identity

# /etc/audit/rules.d/30-privileged.rules
# Privileged command execution
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid!=unset -k privileged
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid!=unset -k privileged
-w /usr/bin/sudo -p x -k privileged_sudo
-w /usr/bin/su -p x -k privileged_su
-w /usr/sbin/useradd -p x -k account_creation
-w /usr/sbin/userdel -p x -k account_deletion
-w /usr/sbin/usermod -p x -k account_modification
-w /usr/sbin/groupadd -p x -k account_creation
-w /usr/sbin/groupdel -p x -k account_deletion
-w /usr/sbin/groupmod -p x -k account_modification

# /etc/audit/rules.d/40-file-changes.rules
# File permission and ownership changes
-a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat -k perm_change
-a always,exit -F arch=b32 -S chmod -S fchmod -S fchmodat -k perm_change
-a always,exit -F arch=b64 -S chown -S fchown -S lchown -S fchownat -k perm_change
-a always,exit -F arch=b32 -S chown -S fchown -S lchown -S fchownat -k perm_change
-a always,exit -F arch=b64 -S setxattr -S removexattr -k xattr_change
-a always,exit -F arch=b32 -S setxattr -S removexattr -k xattr_change

# /etc/audit/rules.d/50-access.rules
# Failed access attempts
-a always,exit -F arch=b64 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EACCES -k access_fail
-a always,exit -F arch=b64 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EPERM  -k access_fail
-a always,exit -F arch=b32 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EACCES -k access_fail
-a always,exit -F arch=b32 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EPERM  -k access_fail

# /etc/audit/rules.d/60-network.rules
# Network configuration changes
-a always,exit -F arch=b64 -S sethostname -S setdomainname -k network_config
-w /etc/hosts -p rwa -k network_config
-w /etc/network/ -p rwa -k network_config
-w /etc/sysconfig/network -p rwa -k network_config

# /etc/audit/rules.d/70-system.rules
# System state changes
-w /etc/issue -p rwa -k system_config
-w /etc/issue.net -p rwa -k system_config
-w /etc/motd -p rwa -k system_config
-a always,exit -F arch=b64 -S adjtimex -S settimeofday -k time_change
-a always,exit -F arch=b64 -S clock_settime -F a0=0x0 -k time_change
-w /etc/localtime -p rwa -k time_change
-a always,exit -F arch=b64 -S mount -S umount2 -k mount_ops

# /etc/audit/rules.d/80-kernel.rules
# Kernel module operations
-w /sbin/insmod -p x -k module_load
-w /sbin/rmmod -p x -k module_load
-w /sbin/modprobe -p x -k module_load
-a always,exit -F arch=b64 -S init_module -S finit_module -S delete_module -k module_ops
-w /etc/modprobe.d/ -p rwa -k module_config

# /etc/audit/rules.d/99-finalize.rules
# Immutable lock: requires reboot to change rules
-e 2
```

### Applying Rules

```bash
# Regenerate the merged rules file and reload
augenrules --load

# Verify rules are loaded
auditctl -l | head -40

# Check for any errors during load
journalctl -u auditd --since "5 minutes ago"
```

## Reading and Interpreting Audit Logs

Audit log records use a type-based format. Key fields:

```
type=SYSCALL msg=audit(1738012345.123:4567): arch=c000003e syscall=59 success=yes \
  exit=0 a0=7f3c1234 a1=7f3c2345 a2=7f3c3456 a3=0 items=2 ppid=3210 pid=3211 \
  auid=1000 uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0 \
  ses=5 comm="sudo" exe="/usr/bin/sudo" subj=unconfined_u:unconfined_r:... key="privileged"

type=EXECVE msg=audit(1738012345.123:4567): argc=3 a0="sudo" a1="-l" a2="passwd"

type=PATH msg=audit(1738012345.123:4568): item=0 name="/usr/bin/sudo" inode=123456 \
  dev=08:01 mode=0104111 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL
```

### Using ausearch

```bash
# Search by audit key
ausearch -k privileged --start today | head -100

# Search by user (auid = login UID)
ausearch -ua 1000 --start "2029-02-09 00:00:00" --end "2029-02-09 23:59:59"

# Search by executable
ausearch -x /usr/bin/passwd --start today

# Search for failed access attempts
ausearch -k access_fail --start yesterday | aureport -f -i

# Search for specific event type
ausearch --message EXECVE --start today | grep "sudo"

# Raw JSON output for SIEM ingestion
ausearch -k privileged --start today --format json
```

### Using aureport

```bash
# Summary report
aureport --summary

# Authentication events
aureport -au --summary
aureport -au --start "2029-02-01" --end "2029-02-10"

# Failed logins
aureport -au -i --failed --start today

# Executable report
aureport -x --summary

# File access report
aureport -f --summary

# Anomaly report (unusual behavior patterns)
aureport --anomaly
```

## Automated Compliance Report Script

This script generates a structured compliance report in HTML and JSON formats for daily delivery.

```bash
#!/usr/bin/env bash
# /usr/local/bin/audit-compliance-report.sh
# Generates daily audit compliance report for PCI-DSS and CIS requirements

set -euo pipefail

REPORT_DIR="/var/reports/audit"
DATE=$(date +%Y-%m-%d)
REPORT_FILE="${REPORT_DIR}/compliance-${DATE}.json"
HTML_FILE="${REPORT_DIR}/compliance-${DATE}.html"
START="today"
LOG=/var/log/audit-report.log

mkdir -p "${REPORT_DIR}"
exec > >(tee -a "${LOG}") 2>&1

log() { echo "[$(date -Is)] $*"; }

# Function: count events by key for a time window
count_events() {
    local key="$1"
    ausearch -k "${key}" --start "${START}" 2>/dev/null | grep -c "^type=" || echo 0
}

# Function: get failed logins
failed_logins() {
    aureport -au -i --failed --start "${START}" 2>/dev/null | tail -n +7 | wc -l || echo 0
}

# Function: get privileged command executions by user
privileged_by_user() {
    ausearch -k privileged --start "${START}" 2>/dev/null \
        | grep "type=SYSCALL" \
        | grep -oP 'auid=\K[0-9]+' \
        | sort | uniq -c | sort -rn \
        | awk '{printf "{\"auid\":%s,\"count\":%d}", $2, $1}' \
        | paste -sd ',' \
        | sed 's/^/[/' | sed 's/$/]/'
}

log "Generating compliance report for ${DATE}"

# Collect metrics
IDENTITY_CHANGES=$(count_events "identity")
PRIV_EVENTS=$(count_events "privileged")
PERM_CHANGES=$(count_events "perm_change")
ACCESS_FAILS=$(count_events "access_fail")
MODULE_OPS=$(count_events "module_ops")
TIME_CHANGES=$(count_events "time_change")
FAILED_LOGINS=$(failed_logins)
PRIV_BY_USER=$(privileged_by_user)

# Get disk usage
LOG_SIZE=$(du -sh /var/log/audit/ | cut -f1)

# Get audit daemon status
AUDITD_STATUS=$(auditctl -s 2>/dev/null | grep "enabled" | awk '{print $2}')
LOST_EVENTS=$(auditctl -s 2>/dev/null | grep "lost" | awk '{print $2}')

# Write JSON report
cat > "${REPORT_FILE}" <<EOF
{
  "report_date": "${DATE}",
  "hostname": "$(hostname -f)",
  "audit_enabled": ${AUDITD_STATUS:-0},
  "lost_events": ${LOST_EVENTS:-0},
  "log_directory_size": "${LOG_SIZE}",
  "event_counts": {
    "identity_changes": ${IDENTITY_CHANGES},
    "privileged_executions": ${PRIV_EVENTS},
    "permission_changes": ${PERM_CHANGES},
    "access_failures": ${ACCESS_FAILS},
    "kernel_module_operations": ${MODULE_OPS},
    "time_changes": ${TIME_CHANGES},
    "failed_logins": ${FAILED_LOGINS}
  },
  "privileged_by_user": ${PRIV_BY_USER:-[]},
  "compliance_checks": {
    "audit_enabled": $([ "${AUDITD_STATUS}" = "2" ] && echo "true" || echo "false"),
    "no_lost_events": $([ "${LOST_EVENTS:-0}" = "0" ] && echo "true" || echo "false"),
    "identity_changes_reviewed": true,
    "privileged_access_logged": true
  }
}
EOF

# Write HTML summary
cat > "${HTML_FILE}" <<HTMLEOF
<!DOCTYPE html>
<html>
<head><title>Audit Compliance Report - ${DATE}</title>
<style>body{font-family:monospace;} table{border-collapse:collapse;} td,th{border:1px solid #ccc;padding:8px;}</style>
</head>
<body>
<h1>Audit Compliance Report: ${DATE}</h1>
<h2>Host: $(hostname -f)</h2>
<table>
<tr><th>Metric</th><th>Count</th></tr>
<tr><td>Identity File Changes</td><td>${IDENTITY_CHANGES}</td></tr>
<tr><td>Privileged Command Executions</td><td>${PRIV_EVENTS}</td></tr>
<tr><td>Permission/Ownership Changes</td><td>${PERM_CHANGES}</td></tr>
<tr><td>Failed Access Attempts</td><td>${ACCESS_FAILS}</td></tr>
<tr><td>Kernel Module Operations</td><td>${MODULE_OPS}</td></tr>
<tr><td>System Time Changes</td><td>${TIME_CHANGES}</td></tr>
<tr><td>Failed Login Attempts</td><td>${FAILED_LOGINS}</td></tr>
<tr><td>Lost Audit Events</td><td>${LOST_EVENTS:-0}</td></tr>
</table>
</body>
</html>
HTMLEOF

log "Report written to ${REPORT_FILE}"
log "HTML report written to ${HTML_FILE}"
```

```bash
# Install as a systemd timer
# /etc/systemd/system/audit-compliance-report.service
[Unit]
Description=Generate daily audit compliance report
After=auditd.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/audit-compliance-report.sh
User=root

# /etc/systemd/system/audit-compliance-report.timer
[Unit]
Description=Run audit compliance report daily at 06:00

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now audit-compliance-report.timer
```

## Centralized Audit Log Collection with Remote auditd

For multi-server environments, ship audit logs to a central collector.

```bash
# /etc/audisp/plugins.d/au-remote.conf (sending host)
active = yes
direction = out
path = /sbin/audisp-remote
type = always
args = 192.168.10.50

# /etc/audisp/audisp-remote.conf (sending host)
remote_server = 192.168.10.50
port = 60
transport = tcp
queue_depth = 2048
fail_action = SYSLOG
network_failure_action = SYSLOG
disk_low_action = ignore
disk_full_action = SYSLOG
disk_error_action = SYSLOG
remote_ending_action = reconnect
generic_error_action = SYSLOG
generic_warning_action = SYSLOG
send_suspended_action = yes
overflow_action = SYSLOG

# /etc/audit/auditd.conf (receiving host - central collector)
tcp_listen_port = 60
tcp_listen_queue = 10
tcp_max_per_addr = 5
```

## Performance Tuning for High-Traffic Systems

On systems with heavy workloads, the audit backlog can fill, causing events to be lost or blocking syscalls.

```bash
# Check current backlog and lost event counters
auditctl -s
# Output: enabled 2, pid 2341, rate_limit 0, backlog_limit 8192, lost 0, backlog 47

# Increase backlog limit for high-throughput systems
auditctl -b 32768

# Rate limiting (use only as a last resort; it drops events)
auditctl -r 5000      # Maximum 5000 records per second

# Check for dropped events (should always be 0 in production)
grep "type=DAEMON_ERR" /var/log/audit/audit.log

# Reduce syscall rule scope with UID filters (exclude high-volume service accounts)
# Add -F auid!=4294967295 to exclude kernel threads
# Add -F uid!=999 to exclude a specific service account UID

auditctl -a always,exit -F arch=b64 -S execve -F euid=0 \
  -F auid!=4294967295 -F uid!=999 -k privileged
```

## CIS Benchmark Verification Script

```bash
#!/usr/bin/env bash
# Verify CIS Linux Benchmark audit controls are in place

PASS=0
FAIL=0

check() {
    local desc="$1"
    local cmd="$2"
    if eval "${cmd}" &>/dev/null; then
        echo "[PASS] ${desc}"
        ((PASS++))
    else
        echo "[FAIL] ${desc}"
        ((FAIL++))
    fi
}

echo "=== CIS Audit Controls Check ==="

check "auditd is running" "systemctl is-active auditd"
check "auditd is enabled" "systemctl is-enabled auditd"
check "Audit buffer size >= 8192" "auditctl -s | awk '/backlog_limit/{print \$2}' | awk '\$1>=8192'"
check "Audit rules are immutable" "auditctl -s | grep -q 'enabled 2'"
check "/etc/passwd is watched" "auditctl -l | grep -q '/etc/passwd'"
check "/etc/shadow is watched" "auditctl -l | grep -q '/etc/shadow'"
check "sudo is watched" "auditctl -l | grep -q '/usr/bin/sudo'"
check "Privileged executions logged" "auditctl -l | grep -q 'privileged'"
check "Failed access logged" "auditctl -l | grep -q 'access_fail'"
check "Time changes logged" "auditctl -l | grep -q 'time_change'"
check "Module operations logged" "auditctl -l | grep -q 'module_ops'"
check "No lost events" "[ \$(auditctl -s | awk '/^lost/{print \$2}') = '0' ]"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit ${FAIL}
```

## Integration with Elasticsearch/SIEM

For SIEM integration, use the audisp syslog plugin to forward structured events, then parse them with Logstash or Fluent Bit.

```yaml
# /etc/fluent-bit/fluent-bit.conf snippet for audit log shipping
[INPUT]
    Name              tail
    Path              /var/log/audit/audit.log
    Tag               audit.*
    Parser            audit
    Refresh_Interval  5
    Mem_Buf_Limit     50MB

[FILTER]
    Name   lua
    Match  audit.*
    Script /etc/fluent-bit/audit_parse.lua
    Call   parse_audit_record

[OUTPUT]
    Name          es
    Match         audit.*
    Host          elasticsearch.prod.svc.cluster.local
    Port          9200
    Index         audit-logs
    Type          _doc
    tls           On
    tls.verify    On
    HTTP_User     audit_shipper
    HTTP_Passwd   ${ELASTIC_PASSWORD}
    Retry_Limit   5
```

## Summary

The Linux Audit Framework provides kernel-level visibility into security-critical events that no application-layer logging solution can match. The investment in writing comprehensive rules pays dividends during incident investigations and compliance audits: the audit log contains an immutable timeline of exactly which processes accessed which files, which users gained elevated privileges, and when system configuration changed. The combination of persistent rules files, centralized collection, automated reporting, and SIEM integration creates a defense-in-depth audit posture that satisfies the most demanding compliance frameworks.

## Advanced Rule Tuning: Excluding Noisy Events

Raw auditd rules on a busy system generate millions of events daily. Filtering out predictable, low-value events reduces storage consumption and speeds up audit log searches.

```bash
# /etc/audit/rules.d/05-exclusions.rules
# Exclude auditd's own operations to prevent feedback loops
-a never,user -F subj_type=auditd_t

# Exclude kube-apiserver high-frequency cert checks (in Kubernetes nodes)
-a never,exit -F arch=b64 -F path=/etc/kubernetes/pki -F perm=r -F uid=0

# Exclude frequent read-only access to /proc by monitoring daemons
-a never,exit -F arch=b64 -S open -S openat -F dir=/proc -F perm=r -F auid=4294967295

# Exclude high-frequency database file reads by postgres user (uid 999)
-a never,exit -F arch=b64 -S open -S openat -F uid=999 -F dir=/var/lib/postgresql

# Exclude tmpfs reads (container runtimes access these constantly)
-a never,exit -F arch=b64 -S open -S openat -F fstype=tmpfs -F perm=r

# Exclude socket file reads used by container runtime (containerd, dockerd)
-a never,exit -F arch=b64 -S open -S openat -F path=/run/containerd/containerd.sock

# Exclude memory-mapped reads of shared libraries
-a never,exit -F arch=b64 -S mmap -F a2&PROT_READ -F a2!&PROT_WRITE
```

## Multi-Node Audit Aggregation with auditd Remote Protocol

For clusters of servers, aggregate audit logs to a central syslog server using the audisp remote plugin.

```bash
# /etc/audisp/plugins.d/syslog.conf (on sending host)
# Ship all audit events to syslog for centralized collection
active = yes
direction = out
path = builtin_syslog
type = builtin
args = LOG_INFO LOG_LOCAL6
format = string

# Configure rsyslog to forward LOCAL6 to central syslog server
# /etc/rsyslog.d/60-audit-forward.conf
local6.* @@syslog.central.example.com:514
```

### Parsing Audit Events in Python for Custom Analysis

```python
#!/usr/bin/env python3
# /usr/local/bin/audit_parser.py
# Parse audit log records and emit JSON for SIEM ingestion

import re
import json
import sys
from datetime import datetime

FIELD_RE = re.compile(r'(\w+)=([^\s]+)')

def parse_record(line: str) -> dict | None:
    """Parse a single audit log line into a dictionary."""
    line = line.strip()
    if not line.startswith("type="):
        return None

    record = {}
    # Extract type
    type_match = re.match(r'type=(\w+)', line)
    if type_match:
        record["type"] = type_match.group(1)

    # Extract timestamp and serial number: msg=audit(1738000000.000:12345)
    ts_match = re.search(r'msg=audit\((\d+\.\d+):(\d+)\)', line)
    if ts_match:
        ts = float(ts_match.group(1))
        record["timestamp"] = datetime.utcfromtimestamp(ts).isoformat() + "Z"
        record["serial"] = int(ts_match.group(2))

    # Extract all key=value pairs
    for match in FIELD_RE.finditer(line):
        key, val = match.group(1), match.group(2)
        if key not in ("type", "msg"):
            # Strip surrounding quotes
            val = val.strip('"')
            record[key] = val

    return record

def main():
    for line in sys.stdin:
        record = parse_record(line)
        if record:
            print(json.dumps(record))

if __name__ == "__main__":
    main()
```

```bash
# Use the parser to create a searchable JSON stream
tail -F /var/log/audit/audit.log | python3 /usr/local/bin/audit_parser.py \
  | jq 'select(.key == "privileged" and .success == "yes") | {time: .timestamp, user: .auid, exe: .exe}'
```

## STIG V-230399: Audit Configuration Verification

The DISA STIG for RHEL 8/9 mandates specific audit rules. This script verifies compliance.

```bash
#!/usr/bin/env bash
# STIG audit controls verification — RHEL 8/9
# Ref: STIG V-230399 through V-230441

PASS=0
FAIL=0
WARN=0

stig_check() {
    local vuln_id="$1"
    local desc="$2"
    local cmd="$3"
    if eval "${cmd}" &>/dev/null; then
        printf "[PASS] %-12s %s\n" "${vuln_id}" "${desc}"
        ((PASS++))
    else
        printf "[FAIL] %-12s %s\n" "${vuln_id}" "${desc}"
        ((FAIL++))
    fi
}

# V-230399: auditd must be running
stig_check "V-230399" "auditd service is active" "systemctl is-active --quiet auditd"

# V-230400: auditd must be enabled at boot
stig_check "V-230400" "auditd service is enabled" "systemctl is-enabled --quiet auditd"

# V-230401: Audit buffer size >= 8192
stig_check "V-230401" "Audit backlog limit >= 8192" \
    "auditctl -s | awk '/backlog_limit/{exit (\$2 >= 8192) ? 0 : 1}'"

# V-230402: Rules must be immutable
stig_check "V-230402" "Audit rules are immutable (-e 2)" \
    "auditctl -s | grep -q 'enabled 2'"

# V-230403: /etc/passwd watched
stig_check "V-230403" "/etc/passwd monitored" \
    "auditctl -l | grep -q '/etc/passwd'"

# V-230404: /etc/shadow watched
stig_check "V-230404" "/etc/shadow monitored" \
    "auditctl -l | grep -q '/etc/shadow'"

# V-230405: Privileged commands logged
stig_check "V-230405" "Privileged commands (setuid/setgid) logged" \
    "auditctl -l | grep -q 'euid=0'"

# V-230406: Audit log directory permissions
stig_check "V-230406" "/var/log/audit permissions are 700" \
    "[ \"\$(stat -c '%a' /var/log/audit)\" = '700' ]"

# V-230407: audit.log file permissions
stig_check "V-230407" "audit.log permission is 600" \
    "[ \"\$(stat -c '%a' /var/log/audit/audit.log)\" = '600' ]"

# V-230408: space_left_action is not ignore
stig_check "V-230408" "space_left_action is not 'ignore'" \
    "grep -q '^space_left_action = [^i]' /etc/audit/auditd.conf"

# V-230409: admin_space_left_action is halt or syslog
stig_check "V-230409" "admin_space_left_action is HALT or SYSLOG" \
    "grep -qiE '^admin_space_left_action = (HALT|SYSLOG)' /etc/audit/auditd.conf"

echo ""
echo "STIG Audit Results: ${PASS} passed, ${FAIL} failed, ${WARN} warnings"
[ "${FAIL}" -eq 0 ] && exit 0 || exit 1
```

## Rotating and Archiving Audit Logs

Audit logs must be archived according to retention requirements (PCI-DSS: 12 months; HIPAA: 6 years; CIS: 90+ days).

```bash
# /etc/logrotate.d/audit
/var/log/audit/audit.log {
    daily
    rotate 90
    compress
    delaycompress
    missingok
    notifempty
    # Use shred to securely delete old logs (if required by policy)
    # postrotate
    #     shred -u /var/log/audit/audit.log.*.gz
    # endscript
    postrotate
        /usr/sbin/service auditd restart > /dev/null 2>&1 || true
    endscript
}

# For long-term archival, sync rotated logs to S3/GCS
# /etc/cron.daily/archive-audit-logs
#!/usr/bin/env bash
set -euo pipefail
ARCHIVE_BUCKET="s3://audit-logs-archive-prod"
HOSTNAME=$(hostname -f)
DATE=$(date +%Y/%m/%d)

for log in /var/log/audit/audit.log.*.gz; do
    [ -f "${log}" ] || continue
    aws s3 cp "${log}" "${ARCHIVE_BUCKET}/${HOSTNAME}/${DATE}/$(basename "${log}")" \
        --sse AES256 \
        --storage-class GLACIER_IR \
        --no-progress
done
```
