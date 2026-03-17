---
title: "Linux Audit System: Compliance Logging and Security Event Monitoring"
date: 2028-11-29T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Audit", "Compliance", "SIEM"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the Linux audit system: writing auditd rules for syscall and file monitoring, using ausearch/aureport for analysis, integrating with rsyslog and Elasticsearch, CIS compliance rules for PCI-DSS and SOC2, and performance tuning."
more_link: "yes"
url: "/linux-audit-system-compliance-logging-guide/"
---

The Linux audit system provides kernel-level visibility into system activity that no application-layer monitoring can match. When a file is accessed, a privileged command executed, or a system call made, the audit subsystem records it directly from the kernel - before any application has a chance to cover its tracks. This makes it the foundation of compliance logging for PCI-DSS, SOC2, and HIPAA requirements.

This guide covers the complete audit system configuration: writing effective rules, analyzing audit logs with ausearch and aureport, shipping to centralized SIEM, CIS compliance rule sets, and managing the performance impact of audit rules in production.

<!--more-->

# Linux Audit System: Compliance Logging and Security Event Monitoring

## Audit System Architecture

The Linux audit system consists of:

- **kernel audit subsystem**: Intercepts system calls and file access events at the kernel level
- **auditd**: User-space daemon that receives events from the kernel and writes to `/var/log/audit/audit.log`
- **auditctl**: Tool for managing audit rules dynamically
- **ausearch**: Log search and filtering tool
- **aureport**: Summary reporting tool
- **audisp**: Audit dispatcher for routing events to plugins (rsyslog, syslog)

### How Audit Rules Work

Audit rules intercept events at three levels:

1. **File watch rules**: Monitor read/write/execute/attribute changes on specific files or directories
2. **Syscall rules**: Intercept specific system calls (open, execve, connect, etc.)
3. **Control rules**: Modify audit system behavior (buffer size, failure mode)

```bash
# Check current audit status
auditctl -s

# List current rules
auditctl -l

# Check audit daemon status
systemctl status auditd
```

## Installing and Configuring auditd

```bash
# Install (RHEL/CentOS/Rocky)
dnf install audit audit-libs -y
systemctl enable --now auditd

# Install (Debian/Ubuntu)
apt-get install auditd audispd-plugins -y
systemctl enable --now auditd
```

### auditd Configuration

```bash
# /etc/audit/auditd.conf - key settings for production
cat > /etc/audit/auditd.conf << 'EOF'
# Log file location and rotation
log_file = /var/log/audit/audit.log
log_format = ENRICHED        # Include UIDs/GIDs resolved to names
log_group = root
priority_boost = 4

# Rotation settings - 100MB files, keep 10 rotations
max_log_file = 100           # MB per log file
max_log_file_action = ROTATE
num_logs = 10
space_left = 75              # MB - warn at this threshold
space_left_action = SYSLOG
admin_space_left = 50        # MB - critical threshold
admin_space_left_action = HALT  # Stop system if disk fills (compliance requirement)

# Failure mode: 2 = kernel panic on audit failure (use for high-security)
# 1 = log failure to syslog and continue (use for most production)
disk_full_action = SUSPEND
disk_error_action = SUSPEND

# Event buffering
disp_qos = lossy            # lossy or lossless - lossless may slow system
dispatcher = /sbin/audispd  # Event dispatcher
EOF

systemctl restart auditd
```

## Writing Effective Audit Rules

### Rule Syntax

```
# File watch rule:
-w <path> -p <permissions> -k <key>
  permissions: r=read, w=write, x=execute, a=attribute change

# Syscall rule:
-a <action,list> -S <syscall> [-F <field>=<value>...] -k <key>
  action: always or never
  list: task, exit, user, exclude
```

### Critical File Monitoring

```bash
# /etc/audit/rules.d/10-file-watch.rules

# Identity and authentication files
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers

# SSH configuration
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/ssh/ssh_config -p wa -k ssh_config
-w /root/.ssh/ -p wa -k ssh_root_keys

# PAM configuration
-w /etc/pam.d/ -p wa -k pam_config
-w /etc/security/ -p wa -k pam_security

# Audit configuration itself
-w /etc/audit/ -p wa -k audit_config
-w /etc/audit/audit.rules -p wa -k audit_config
-w /etc/auditd.conf -p wa -k audit_config

# System binaries (detect tampering)
-w /bin/su -p x -k privileged_su
-w /usr/bin/sudo -p x -k privileged_sudo
-w /usr/bin/passwd -p x -k privileged_passwd
-w /usr/sbin/useradd -p x -k user_modification
-w /usr/sbin/userdel -p x -k user_modification
-w /usr/sbin/usermod -p x -k user_modification
-w /usr/sbin/groupadd -p x -k group_modification
-w /usr/sbin/groupdel -p x -k group_modification

# Cron jobs
-w /etc/cron.d/ -p wa -k cron
-w /etc/cron.daily/ -p wa -k cron
-w /etc/cron.weekly/ -p wa -k cron
-w /etc/crontab -p wa -k cron
-w /var/spool/cron/ -p wa -k cron_user

# Network configuration
-w /etc/hosts -p wa -k network
-w /etc/resolv.conf -p wa -k network
-w /etc/network/ -p wa -k network
-w /etc/sysconfig/network -p wa -k network
```

### Syscall Monitoring Rules

```bash
# /etc/audit/rules.d/20-syscalls.rules

# Monitor all privileged commands (SUID/SGID execution)
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=unset -k privcommand
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid>=1000 -F auid!=unset -k privcommand

# File deletion by non-root users (PCI-DSS requirement)
-a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat \
  -F auid>=1000 -F auid!=unset -k delete
-a always,exit -F arch=b32 -S unlink -S unlinkat -S rename -S renameat \
  -F auid>=1000 -F auid!=unset -k delete

# Unauthorized file access (permission denied)
-a always,exit -F arch=b64 -S creat -S open -S openat -S truncate \
  -F exit=-EACCES -F auid>=1000 -F auid!=unset -k access_denied
-a always,exit -F arch=b64 -S creat -S open -S openat -S truncate \
  -F exit=-EPERM -F auid>=1000 -F auid!=unset -k access_denied
-a always,exit -F arch=b32 -S creat -S open -S openat -S truncate \
  -F exit=-EACCES -F auid>=1000 -F auid!=unset -k access_denied

# Module loading/unloading (kernel rootkit detection)
-a always,exit -F arch=b64 -S init_module -S delete_module -k kernel_modules
-a always,exit -F arch=b32 -S init_module -S delete_module -k kernel_modules

# Mount operations (detect unauthorized storage)
-a always,exit -F arch=b64 -S mount -F auid>=1000 -F auid!=unset -k mounts
-a always,exit -F arch=b32 -S mount -F auid>=1000 -F auid!=unset -k mounts

# System time changes (detect timestomping)
-a always,exit -F arch=b64 -S adjtimex -S settimeofday -S clock_settime -k time_change
-a always,exit -F arch=b32 -S adjtimex -S settimeofday -S clock_settime -k time_change

# Network configuration changes
-a always,exit -F arch=b64 -S sethostname -S setdomainname -k network_change
-a always,exit -F arch=b32 -S sethostname -S setdomainname -k network_change

# Socket creation (detect suspicious network activity)
# Only monitor for processes running as root to reduce noise
-a always,exit -F arch=b64 -S socket -F a0=2 -F euid=0 -k socket_creation_root
```

### Kubernetes-Specific Rules (Nodes)

```bash
# /etc/audit/rules.d/40-kubernetes.rules

# kubectl exec/cp (privileged container operations)
-w /usr/local/bin/kubectl -p x -k kubectl
-w /usr/bin/kubectl -p x -k kubectl

# Container runtime operations
-w /var/run/docker.sock -p rw -k docker_socket
-w /var/run/containerd/containerd.sock -p rw -k containerd_socket
-w /run/containerd/ -p rw -k containerd

# kubelet configuration changes
-w /etc/kubernetes/ -p wa -k kubernetes_config
-w /var/lib/kubelet/ -p wa -k kubelet_state

# CNI configuration
-w /etc/cni/net.d/ -p wa -k cni_config
-w /opt/cni/bin/ -p x -k cni_bin
```

### Apply Rules

```bash
# Load rules from files (persistent)
augenrules --load
systemctl restart auditd

# Verify rules loaded
auditctl -l | wc -l
auditctl -l | grep -c "always"

# Check for rule errors
ausearch -m AVC,USER_AUTH -ts today | head -20
```

## Analyzing Audit Logs

### ausearch - Event Search

```bash
# Search by key label
ausearch -k privileged_sudo | tail -50

# Search by user
ausearch -ua root -ts today

# Search by time range
ausearch -ts 2028-11-29 08:00:00 -te 2028-11-29 09:00:00

# Search for failed login attempts
ausearch -m USER_FAILED_AUTH -ts today | grep "op=mapasswd\|op=PAM"

# Search for sudo usage
ausearch -k privileged_sudo -ts today --format text

# Search for file deletions
ausearch -k delete -ts today --format text

# Search for specific file
ausearch -f /etc/passwd -ts today

# Pretty-print events
ausearch -k identity -ts today --interpret

# Count events per key
ausearch -ts today | grep "key=" | grep -oP 'key="\K[^"]+' | sort | uniq -c | sort -rn
```

### aureport - Summary Reports

```bash
# Overall summary for today
aureport -ts today

# Authentication events
aureport -au -ts today

# Failed authentication attempts
aureport --failed -au -ts today

# Executable usage
aureport -x -ts today | head -30

# Anomaly report
aureport --anomaly -ts today

# Login report
aureport -l -ts today

# File access report
aureport -f -ts today | head -30

# User command execution
aureport -u --success -ts today

# Generate full HTML report (if supported)
aureport -ts this-month --summary
```

### Parsing Raw Audit Records

```bash
# Show raw events for a specific syscall
ausearch -sc openat -ts today | head -20

# Example raw record:
# type=SYSCALL msg=audit(1732876800.123:456): arch=c000003e syscall=257 success=yes
#   exit=3 a0=ffffff9c a1=7f1234567890 a2=0 a3=0 items=1 ppid=1234 pid=5678
#   auid=1000 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000
#   fsgid=1000 tty=pts0 ses=2 comm="cat" exe="/bin/cat" key="access_denied"

# Parse with Python for custom analysis
python3 << 'EOF'
import subprocess
import re

result = subprocess.run(
    ['ausearch', '-k', 'delete', '-ts', 'today', '--raw'],
    capture_output=True, text=True
)

events = result.stdout.split('----\n')
for event in events[:10]:
    # Extract key fields
    pid_match = re.search(r'pid=(\d+)', event)
    uid_match = re.search(r'uid=(\d+)', event)
    exe_match = re.search(r'exe="([^"]+)"', event)
    name_match = re.search(r'name="([^"]+)"', event)
    
    if pid_match and exe_match:
        print(f"PID: {pid_match.group(1)}, "
              f"UID: {uid_match.group(1) if uid_match else 'N/A'}, "
              f"EXE: {exe_match.group(1)}, "
              f"FILE: {name_match.group(1) if name_match else 'N/A'}")
EOF
```

## Shipping to Centralized SIEM

### rsyslog Configuration

```bash
# /etc/audisp/plugins.d/syslog.conf
active = yes
direction = out
path = builtin_syslog
type = builtin
args = LOG_INFO
format = string
```

```bash
# /etc/rsyslog.d/60-audit.conf
# Forward audit messages to centralized syslog
module(load="imuxsock")
module(load="imfile")

# Read audit log
input(type="imfile"
      File="/var/log/audit/audit.log"
      Tag="audit"
      Severity="info"
      Facility="local6"
      PersistStateInterval="100")

# Forward to remote syslog
local6.* @siem.internal.company.com:514

# Or via TLS:
local6.* @@siem.internal.company.com:6514
```

### Shipping to Elasticsearch via Filebeat

```yaml
# /etc/filebeat/filebeat.yml
filebeat.inputs:
- type: log
  enabled: true
  paths:
    - /var/log/audit/audit.log
  tags: ["audit", "linux-audit"]
  fields:
    host_environment: production
    compliance_scope: pci-dss
  fields_under_root: true
  # Parse auditd format
  processors:
  - decode_json_fields:
      fields: ["message"]
      process_array: false
      max_depth: 1
      overwrite_keys: false

# Alternatively use the auditd module (parses format automatically)
filebeat.modules:
- module: auditd
  log:
    enabled: true
    var.paths: ["/var/log/audit/audit.log"]

output.elasticsearch:
  hosts: ["https://elasticsearch.internal.company.com:9200"]
  username: "filebeat_writer"
  password: "${ES_PASSWORD}"
  ssl.certificate_authorities: ["/etc/ssl/certs/ca-bundle.crt"]
  index: "auditd-%{+yyyy.MM.dd}"

setup.ilm.enabled: true
setup.ilm.rollover_alias: "auditd"
setup.ilm.pattern: "{now/d}-000001"
```

### Vector for High-Performance Log Shipping

```toml
# /etc/vector/vector.toml
[sources.auditd]
type = "file"
include = ["/var/log/audit/audit.log"]
ignore_older_secs = 86400

[transforms.parse_auditd]
type = "remap"
inputs = ["auditd"]
source = '''
# Parse auditd key=value format
.parsed = parse_key_value!(.message, key_value_delimiter: "=", field_delimiter: " ")
.timestamp = now()
.host = get_hostname!()
'''

[sinks.elasticsearch]
type = "elasticsearch"
inputs = ["parse_auditd"]
endpoints = ["https://elasticsearch.internal.company.com:9200"]
index = "auditd-%F"
auth.strategy = "basic"
auth.user = "vector_writer"
auth.password = "${ELASTICSEARCH_PASSWORD}"
tls.ca_file = "/etc/ssl/certs/ca-bundle.crt"

[sinks.splunk_hec]
type = "splunk_hec_logs"
inputs = ["parse_auditd"]
endpoint = "https://splunk.internal.company.com:8088"
token = "${SPLUNK_HEC_TOKEN}"
index = "linux_audit"
source = "auditd"
sourcetype = "linux:audit"
```

## CIS Compliance Rule Sets

### PCI-DSS Compliance Rules

PCI-DSS 10.2 requires logging of specific event categories:

```bash
# /etc/audit/rules.d/50-pci-dss.rules
# PCI-DSS 10.2.1 - Individual user access to cardholder data
# (customize path to your application data directory)
-w /data/cardholder/ -p rwa -k pci_cardholder_access

# PCI-DSS 10.2.2 - Administrative actions
-a always,exit -F arch=b64 -S all -F euid=0 -F auid>=1000 -F auid!=unset -k pci_admin_action

# PCI-DSS 10.2.3 - Access to audit trails
-w /var/log/audit/ -p rwa -k pci_audit_access

# PCI-DSS 10.2.4 - Invalid logical access attempts
-a always,exit -F arch=b64 -S all -F exit=-EACCES -F auid>=1000 -k pci_access_denied
-a always,exit -F arch=b64 -S all -F exit=-EPERM -F auid>=1000 -k pci_access_denied

# PCI-DSS 10.2.5 - Use of identification and authentication mechanisms
-a always,exit -F arch=b64 -S all -F auid!=unset -F uid=0 -F auid>=1000 -k pci_su_root
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=unset -k pci_privileged

# PCI-DSS 10.2.6 - Initialization of audit logs
-w /var/log/ -p wa -k pci_log_modification

# PCI-DSS 10.2.7 - Creation/deletion of system-level objects
-a always,exit -F arch=b64 -S init_module -S delete_module -k pci_kernel_module
```

### SOC2 Compliance Rules

SOC2 focuses on access control and change management:

```bash
# /etc/audit/rules.d/51-soc2.rules

# SOC2 CC6.1 - Logical access
-a always,exit -F arch=b64 -S openat -S open_by_handle_at \
  -F dir=/etc -F success=0 -F auid>=1000 -k soc2_etc_access_denied

# SOC2 CC6.2 - Authentication controls
-w /etc/pam.d/ -p wa -k soc2_auth_config
-w /etc/security/pwquality.conf -p wa -k soc2_password_policy

# SOC2 CC6.3 - Network access
-a always,exit -F arch=b64 -S bind -F a1=2 -F euid=0 -k soc2_privileged_bind

# SOC2 CC7.1 - Change management
-a always,exit -F arch=b64 -S execve \
  -F path=/usr/bin/yum -k soc2_package_manager
-a always,exit -F arch=b64 -S execve \
  -F path=/usr/bin/apt-get -k soc2_package_manager
-a always,exit -F arch=b64 -S execve \
  -F path=/usr/bin/dpkg -k soc2_package_manager

# SOC2 CC8.1 - System configuration changes
-w /etc/sysctl.conf -p wa -k soc2_sysctl
-w /etc/sysctl.d/ -p wa -k soc2_sysctl
```

### Immutable Rules (Lock After Loading)

```bash
# /etc/audit/rules.d/99-finalize.rules
# This MUST be the last rule - prevents modifying rules until reboot
# Use only on systems where you are confident in the rule set
-e 2
```

```bash
# Verify immutable mode
auditctl -s | grep enabled
# enabled 2 = immutable (reboot required to change rules)
```

## Performance Impact Analysis

Audit rules have measurable performance overhead. Measure and tune:

```bash
# Measure audit overhead with perf
perf stat -e audit:audit_start,audit:audit_end \
  dd if=/dev/zero of=/tmp/test bs=1M count=100 2>&1

# Check audit backlog (pending events in kernel buffer)
auditctl -s | grep backlog
# backlog 0 = no backlog (good)
# backlog > 100 = consider increasing buffer size or reducing rules

# Increase buffer size if seeing backlog
auditctl -b 16384  # Default is 8192

# Check for lost events
ausearch -m DAEMON_LOST -ts today
```

### Rules with Highest Performance Impact

Highest overhead (use sparingly):
1. `execve` syscall monitoring (every process execution)
2. `open/openat` without `-F exit=` filter (every file open)
3. Directory watches with `-p r` (every file read in directory)

Lower overhead:
1. File watches with `-p wa` (writes only)
2. Filtered syscall rules with `-F euid=0` or `-F auid>=1000`
3. Specific file path watches

Optimization example:

```bash
# HIGH overhead: monitor all file opens (generates enormous volume)
-a always,exit -F arch=b64 -S open -S openat -k file_access

# LOWER overhead: only monitor failed opens for non-root users
-a always,exit -F arch=b64 -S open -S openat \
  -F exit=-EACCES -F auid>=1000 -F auid!=unset -k access_denied
```

### Tuning with Rate Limiting

```bash
# Limit events per second per process (prevent audit flooding)
# This can cause missed events - only use if performance is critical
auditctl --rate 200  # Max 200 events/second

# Or limit per specific rule using rate limiting
# (not available in all auditd versions)
```

## Automating Compliance Reporting

```bash
#!/bin/bash
# daily-compliance-report.sh - run via cron

REPORT_DATE=$(date +%Y-%m-%d)
REPORT_FILE="/var/reports/compliance-${REPORT_DATE}.txt"

{
echo "=== Linux Audit Compliance Report: ${REPORT_DATE} ==="
echo ""

echo "--- Authentication Summary ---"
aureport -au -ts today 2>/dev/null | head -20

echo ""
echo "--- Failed Logins ---"
aureport --failed -au -ts today 2>/dev/null | head -20

echo ""
echo "--- Privileged Command Execution ---"
ausearch -k privileged_sudo -ts today --format text 2>/dev/null | \
  grep "^type=SYSCALL" | grep -oP 'comm="\K[^"]+' | sort | uniq -c | sort -rn | head -20

echo ""
echo "--- File Access Denials ---"
ausearch -k access_denied -ts today 2>/dev/null | wc -l
echo "total access denial events"

echo ""
echo "--- User Account Changes ---"
ausearch -k identity -ts today --format text 2>/dev/null | head -30

echo ""
echo "--- Kernel Module Changes ---"
ausearch -k kernel_modules -ts today --format text 2>/dev/null

} > "${REPORT_FILE}"

# Email report (requires mail command)
mail -s "Audit Compliance Report: ${REPORT_DATE}" security-team@company.com < "${REPORT_FILE}"

echo "Report written to: ${REPORT_FILE}"
```

## Summary

The Linux audit system provides tamper-resistant, kernel-level logging that is the foundation of security compliance. Key operational points:

1. Start with file watch rules (`-p wa`) on critical configuration files - low overhead, high value
2. Add filtered syscall rules - always include `-F auid>=1000` and `-F auid!=unset` to reduce noise from system processes
3. Use key labels (`-k <label>`) consistently across rules for efficient `ausearch` queries
4. Lock rules with `-e 2` only after thorough testing - it requires a reboot to change
5. Monitor for audit backlog (`auditctl -s | grep backlog`) and increase buffer if needed
6. Ship to SIEM in real-time with Filebeat or Vector for correlation and alerting
7. Generate daily compliance reports with `aureport` and route to security team
8. Test your compliance rules against your actual compliance framework checklist - CIS Benchmark sections map directly to specific audit rules
9. Measure performance impact of each rule category with `perf` before enabling in production
