---
title: "Linux Audit Framework: auditd Rules, ausearch/aureport Analysis, and Compliance Logging for SOC2 and PCI DSS"
date: 2031-10-11T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "auditd", "Compliance", "SOC2", "PCI DSS", "Audit", "SIEM"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the Linux audit framework: configuring auditd for production, writing targeted audit rules for SOC2 and PCI DSS requirements, analyzing audit logs with ausearch and aureport, and shipping audit events to a SIEM."
more_link: "yes"
url: "/linux-audit-framework-auditd-soc2-pci-compliance-logging/"
---

Every SOC 2 Type II audit and every PCI DSS assessment asks the same question: can you prove that privileged access was logged, that file integrity was monitored, and that authentication events were captured? The Linux audit framework—`auditd` and its kernel counterpart—provides the infrastructure to answer yes. When correctly configured, it captures syscall-level events that no userspace application can suppress, ships them to a tamper-evident log, and produces the structured output required by automated compliance tooling. This guide covers the full stack from kernel audit architecture to SIEM integration.

<!--more-->

# Linux Audit Framework for SOC2 and PCI DSS

## Section 1: Architecture of the Linux Audit System

The audit system has two components: a kernel subsystem and a userspace daemon.

```
┌─────────────────────────────────────────────────────────┐
│  Kernel Space                                            │
│                                                          │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Audit Rules │───▶│  Audit Subsystem (syscall     │   │
│  │  (audit_add_ │    │  hooks, fsnotify, netfilter)  │   │
│  │   watch etc) │    └───────────────┬──────────────┘   │
│  └──────────────┘                    │                   │
│                                      │ netlink socket    │
└──────────────────────────────────────┼───────────────────┘
                                       │
┌──────────────────────────────────────┼───────────────────┐
│  Userspace                           │                   │
│                                      ▼                   │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  auditctl    │    │  auditd (audit daemon)        │   │
│  │  (rule mgmt) │    │  - writes /var/log/audit/     │   │
│  └──────────────┘    │  - plugins: audisp, syslog    │   │
│                       └──────────────┬───────────────┘   │
│  ┌──────────────┐                    │                   │
│  │  ausearch    │    ┌───────────────▼───────────────┐   │
│  │  aureport    │    │  audit.log (structured text)  │   │
│  └──────────────┘    └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

The kernel generates audit records for every event matching a rule and sends them over a netlink socket to `auditd`, which writes them to disk. The `auditd` process runs as root with special protections: it cannot be killed by ordinary processes, and it can halt the system if the audit log fills up (configurable).

## Section 2: auditd Configuration

### /etc/audit/auditd.conf

```ini
# /etc/audit/auditd.conf — production settings

# Log file location
log_file = /var/log/audit/audit.log

# Log format: RAW (structured key=value), ENRICHED (resolves UIDs/GIDs)
log_format = ENRICHED

# Maximum log file size in MB before rotation
max_log_file = 100

# Number of log files to keep
num_logs = 10

# Action when disk is full: SYSLOG, SUSPEND, SINGLE, HALT
disk_full_action = SYSLOG

# Action when disk space is critically low
disk_error_action = SYSLOG

# Free space threshold in MB before action
space_left = 500
space_left_action = EMAIL
action_mail_acct = security-alerts@example.com

# Enable TCP listener for remote logging (for centralized audit)
tcp_listen_port = 60
tcp_max_per_addr = 3

# Immutable mode: prevents rule changes without reboot
# Set to 2 after finalizing rules in production
# immutable = 2

# Priority boost for auditd process
priority_boost = 4

# Queue depth for kernel -> userspace events
disp_qos = lossy
q_depth = 10000
overflow_action = SYSLOG
```

### systemd Service Hardening

```ini
# /etc/systemd/system/auditd.service.d/hardening.conf
[Service]
# Protect audit log from other processes
ReadOnlyPaths=/
ReadWritePaths=/var/log/audit
TemporaryFileSystem=/run/auditd
NoNewPrivileges=no
# auditd needs CAP_AUDIT_CONTROL and CAP_AUDIT_READ
AmbientCapabilities=CAP_AUDIT_CONTROL CAP_AUDIT_READ CAP_NET_BIND_SERVICE
```

## Section 3: Audit Rule Syntax and Types

Rules are loaded by `auditctl` or from `/etc/audit/rules.d/*.rules`.

### Rule Types

```bash
# Filesystem watch (inotify-based)
# -w <path> -p <permissions> -k <key>
# permissions: r=read, w=write, x=execute, a=attribute change

# System call rule
# -a <action,list> -S <syscall> -F <field=value> -k <key>
# action: always (record) / never (suppress)
# list: task, exit, user, exclude

# Control rule (not an audit event)
# -b <buffer_size>
# -f <failure_mode>
# -e <enable_flag>
```

## Section 4: SOC 2 Audit Rules

SOC 2 Trust Services Criteria require demonstrating access controls, system operations monitoring, and logical access management.

```bash
#!/bin/bash
# soc2-audit-rules.sh — install comprehensive SOC2 audit rules
# Place contents in /etc/audit/rules.d/40-soc2.rules

cat > /etc/audit/rules.d/40-soc2.rules <<'EOF'
## SOC 2 Audit Rules
## Reference: TSC CC6.1, CC6.2, CC6.3, CC7.1, CC7.2, CC7.3

# Delete all existing rules first
-D

# Set buffer size (increase for high-volume systems)
-b 16384

# Failure mode: 2=panic (kernel panic on failure), 1=printk, 0=silent
# Use 1 in production to avoid outages from audit failures
-f 1

##
## CC6.1 — Logical and Physical Access Controls
##

# User authentication events
-w /etc/pam.d/ -p wa -k pam-config-change
-w /etc/nsswitch.conf -p wa -k nsswitch-change
-w /etc/passwd -p wa -k identity-change
-w /etc/shadow -p wa -k identity-change
-w /etc/group -p wa -k identity-change
-w /etc/gshadow -p wa -k identity-change
-w /etc/sudoers -p wa -k sudoers-change
-w /etc/sudoers.d/ -p wa -k sudoers-change

# SSH configuration changes
-w /etc/ssh/sshd_config -p wa -k sshd-config-change
-w /etc/ssh/ssh_config -p wa -k ssh-config-change

# Login/logout events (via PAM)
-w /var/log/wtmp -p wa -k logins
-w /var/log/btmp -p wa -k logins
-w /var/log/lastlog -p wa -k logins
-w /var/run/faillock/ -p wa -k logins

##
## CC6.2 — Prior to Issuing System Credentials
##

# Password changes and account management syscalls
-a always,exit -F arch=b64 -S chpasswd -k password-change
-a always,exit -F arch=b64 -S passwd -k password-change
-a always,exit -F arch=b64 -S openat,open,creat,truncate -F path=/etc/shadow -k shadow-access
-a always,exit -F arch=b64 -S openat,open,creat,truncate -F path=/etc/passwd -k passwd-access

##
## CC6.3 — Access Restrictions
##

# Privilege escalation
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=-1 -k privileged-exec
-a always,exit -F arch=b64 -S setuid,setgid,setreuid,setregid -k setuid
-a always,exit -F arch=b64 -S seteuid,setegid -k setuid

# sudo usage
-w /usr/bin/sudo -p x -k sudo-exec
-w /usr/bin/su -p x -k su-exec

# Container/VM breakout attempts
-a always,exit -F arch=b64 -S unshare -k namespace-change
-a always,exit -F arch=b64 -S clone -F a0&0x7c020000 -k namespace-change

##
## CC7.1 — System Monitoring
##

# Kernel module loading/unloading
-a always,exit -F arch=b64 -S init_module,finit_module -k kernel-modules
-a always,exit -F arch=b64 -S delete_module -k kernel-modules
-w /sbin/insmod -p x -k kernel-modules
-w /sbin/rmmod -p x -k kernel-modules
-w /sbin/modprobe -p x -k kernel-modules

# cron job changes
-w /etc/cron.d/ -p wa -k cron-change
-w /etc/cron.daily/ -p wa -k cron-change
-w /etc/cron.weekly/ -p wa -k cron-change
-w /etc/crontab -p wa -k cron-change
-w /var/spool/cron/ -p wa -k cron-change

# Systemd unit changes
-w /etc/systemd/system/ -p wa -k systemd-change
-w /usr/lib/systemd/system/ -p wa -k systemd-change
-w /usr/bin/systemctl -p x -k systemctl-exec

##
## CC7.2 — Audit Logging of Security Events
##

# Network configuration changes
-a always,exit -F arch=b64 -S sethostname,setdomainname -k network-change
-w /etc/hosts -p wa -k network-change
-w /etc/network/ -p wa -k network-change
-w /etc/NetworkManager/ -p wa -k network-change

# Firewall rule changes
-w /usr/sbin/iptables -p x -k firewall-change
-w /usr/sbin/ip6tables -p x -k firewall-change
-w /usr/sbin/nft -p x -k firewall-change
-w /etc/iptables/ -p wa -k firewall-change

# File deletion in sensitive directories
-a always,exit -F arch=b64 -S unlink,unlinkat,rename,renameat -F dir=/etc -k etc-deletion

##
## CC7.3 — Configuration Management
##

# Important system binary changes
-w /usr/bin/ -p wa -k bin-change
-w /usr/sbin/ -p wa -k sbin-change
-w /bin/ -p wa -k bin-change
-w /sbin/ -p wa -k bin-change

# Time changes (important for log correlation)
-a always,exit -F arch=b64 -S adjtimex,settimeofday,clock_settime -k time-change
-w /etc/localtime -p wa -k time-change

## Make rules immutable (requires reboot to change after this)
## Uncomment only after validating all rules in staging
# -e 2
EOF

# Load the rules
augenrules --load
auditctl -l | wc -l
echo "Audit rules loaded"
```

## Section 5: PCI DSS Audit Rules

PCI DSS requirements 10.2 and 10.3 mandate logging of all individual user access, privileged access, and access to cardholder data.

```bash
cat > /etc/audit/rules.d/50-pci-dss.rules <<'EOF'
## PCI DSS v4.0 Audit Rules
## Requirements: 10.2, 10.3, 10.5

##
## Req 10.2.1 — Log individual user access to cardholder data
##

# Cardholder data environment directories (adjust paths to your environment)
-w /opt/payment-app/data/ -p rwxa -k chd-access
-w /var/lib/postgresql/14/main/pg_tblspc/ -p rwxa -k chd-db-access
-w /mnt/card-data/ -p rwxa -k chd-access

# Database client executions (potential CHD access)
-w /usr/bin/psql -p x -k db-client-exec
-w /usr/bin/mysql -p x -k db-client-exec
-w /usr/bin/mongo -p x -k db-client-exec

##
## Req 10.2.2 — Log all actions taken by root
##

-a always,exit -F arch=b64 -F euid=0 -F auid!=0 -k root-actions
-a always,exit -F arch=b64 -F uid=0 -k root-actions

##
## Req 10.2.3 — Log all invalid logical access attempts
##

# Failed authentication syscalls
-a always,exit -F arch=b64 -S open,openat -F exit=-EACCES -k access-denied
-a always,exit -F arch=b64 -S open,openat -F exit=-EPERM -k access-denied

##
## Req 10.2.4 — Log use of identification and authentication mechanisms
##

# Authentication libraries
-w /lib64/security/ -p wa -k auth-lib-change
-w /lib/x86_64-linux-gnu/security/ -p wa -k auth-lib-change

# SSH authorized keys changes (account-level)
-a always,exit -F arch=b64 -S openat,open,creat,truncate \
  -F path=/root/.ssh/authorized_keys -k ssh-authorized-keys
# For non-root users, watch entire .ssh directories
-w /home/ -p wa -k user-ssh-change

##
## Req 10.2.5 — Log use of and changes to identification and authentication mechanisms
##

# Certificate/key file access
-a always,exit -F arch=b64 -S openat,open -F dir=/etc/ssl/private -k ssl-private-access
-a always,exit -F arch=b64 -S openat,open -F dir=/etc/pki/ -k pki-access

##
## Req 10.2.6 — Log initialization, stopping, pausing of audit logs
##

# auditd control
-a always,exit -F arch=b64 -S kill -F a1=15 -F exe=/sbin/auditd -k audit-stop

##
## Req 10.2.7 — Log creation and deletion of system-level objects
##

-a always,exit -F arch=b64 -S mknod,mknodat -k dev-creation
-a always,exit -F arch=b64 -S mount -k filesystem-mount
-a always,exit -F arch=b64 -S umount2 -k filesystem-umount

##
## Req 10.5 — Protect audit trails from unauthorized modification
##

# Audit log file access
-w /var/log/audit/ -p rwxa -k audit-log-access

EOF

augenrules --load
```

## Section 6: Analyzing Audit Logs with ausearch

### Common ausearch Queries

```bash
# Search by key
ausearch -k privileged-exec --start today

# Search by username
ausearch -ua mmattox --start "2031-10-01" --end "2031-10-07"

# Search for failed sudo attempts
ausearch -k sudo-exec -sv no --start today

# Search for specific file access
ausearch -f /etc/shadow --start today

# Search by process ID
ausearch -p 45678

# Search by system call
ausearch -sc execve --start "this-month"

# Raw output (for parsing)
ausearch -k pam-config-change --start today --output raw

# Interpret (resolve UIDs, syscall names)
ausearch -k identity-change --interpret

# Filter by event type
ausearch --event USER_CMD --start today | \
  aureport --cmd --summary

# Recent privileged commands
ausearch -k privileged-exec --start "1 hour ago" -i | \
  grep -E "^type=EXECVE"
```

### Parsing a Specific Event

Audit events span multiple lines with the same timestamp. This extracts a complete event:

```bash
# Find an event by its record ID (serial number)
EVENT_ID=12345678
ausearch --event "${EVENT_ID}" -i

# Sample output (EXECVE event):
# ----
# type=SYSCALL msg=audit(1728172800.123:12345678): arch=c000003e syscall=59 \
#   success=yes exit=0 a0=557a2b a1=557a3c a2=557a4d a3=7ffe12 \
#   items=2 ppid=1234 pid=5678 auid=1000 uid=0 gid=0 euid=0 suid=0 \
#   fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0 ses=4 comm="cat" exe="/usr/bin/cat" \
#   subj=unconfined key="privileged-exec"
# type=EXECVE msg=audit(1728172800.123:12345678): argc=2 a0="cat" a1="/etc/shadow"
# type=PATH msg=audit(1728172800.123:12345678): item=0 name="/usr/bin/cat" \
#   inode=786435 dev=fd:01 mode=0100755 ouid=0 ogid=0 rdev=00:00 obj=system_u:..
```

## Section 7: Reporting with aureport

### Pre-Built Reports

```bash
# Summary of all events
aureport --summary

# Authentication events report
aureport --auth

# Failed authentication attempts
aureport --auth --failed

# Executable report (who ran what)
aureport --executable --summary

# System call report
aureport --syscall --summary

# Anomaly report (unusual events)
aureport --anomaly

# Key report (which audit keys triggered)
aureport --key --summary

# Login/logout report
aureport --login

# Full report for PCI DSS period
aureport --start "2031-10-01" --end "2031-10-31" \
  --auth --executable --key > pci-dss-monthly-report.txt
```

### Custom Compliance Report Script

```bash
#!/bin/bash
# pci-compliance-report.sh

REPORT_DIR="/var/reports/audit"
PERIOD_START="${1:-$(date -d '1 month ago' '+%m/%d/%Y %H:%M:%S')}"
PERIOD_END="${2:-$(date '+%m/%d/%Y %H:%M:%S')}"
OUTPUT="${REPORT_DIR}/pci-report-$(date +%Y%m%d).txt"

mkdir -p "${REPORT_DIR}"

cat > "${OUTPUT}" <<HEADER
PCI DSS Compliance Audit Report
Period: ${PERIOD_START} to ${PERIOD_END}
Generated: $(date)
Host: $(hostname)
Kernel: $(uname -r)
========================================

HEADER

section() {
  echo "" >> "${OUTPUT}"
  echo "## $1" >> "${OUTPUT}"
  echo "---" >> "${OUTPUT}"
}

section "10.2.1 — CHD Access Events"
ausearch -k chd-access --start "${PERIOD_START}" --end "${PERIOD_END}" \
  -i 2>/dev/null | grep "type=SYSCALL" | \
  awk '{print $3, $NF}' | sort | uniq -c | sort -rn >> "${OUTPUT}"

section "10.2.2 — Root Actions"
ausearch -k root-actions --start "${PERIOD_START}" --end "${PERIOD_END}" \
  -i 2>/dev/null | grep "type=EXECVE" | \
  sed 's/.*a0="\(.*\)" a1="\(.*\)".*/\1 \2/' | \
  sort | uniq -c | sort -rn | head -50 >> "${OUTPUT}"

section "10.2.3 — Failed Access Attempts"
aureport --auth --failed --start "${PERIOD_START}" --end "${PERIOD_END}" \
  2>/dev/null >> "${OUTPUT}"

section "10.2.5 — Sudo Usage"
ausearch -k sudo-exec --start "${PERIOD_START}" --end "${PERIOD_END}" \
  -i 2>/dev/null | grep "type=USER_CMD" | \
  grep -oP 'acct="[^"]*"|cmd="[^"]*"' | \
  paste - - | sort | uniq -c | sort -rn >> "${OUTPUT}"

section "10.2.6 — Audit Log Changes"
ausearch -k audit-log-access --start "${PERIOD_START}" --end "${PERIOD_END}" \
  -i 2>/dev/null | grep "type=PATH" >> "${OUTPUT}"

section "10.3 — Firewall Rule Changes"
ausearch -k firewall-change --start "${PERIOD_START}" --end "${PERIOD_END}" \
  -i 2>/dev/null >> "${OUTPUT}"

section "Kernel Module Changes"
ausearch -k kernel-modules --start "${PERIOD_START}" --end "${PERIOD_END}" \
  -i 2>/dev/null >> "${OUTPUT}"

echo "Report generated: ${OUTPUT}"
wc -l "${OUTPUT}"
```

## Section 8: Shipping Audit Logs to a SIEM

### audisp Plugin Configuration for Syslog Forwarding

```ini
# /etc/audit/plugins.d/syslog.conf
active = yes
direction = out
path = builtin_syslog
type = builtin
args = LOG_INFO LOG_LOCAL6
format = string
```

### Forwarding to Elasticsearch via Filebeat

```yaml
# /etc/filebeat/inputs.d/audit.yml
- type: filestream
  id: audit-log
  enabled: true
  paths:
    - /var/log/audit/audit.log
  parsers:
    - ndjson:
        # Audit logs are NOT JSON; use multiline + dissect
        enabled: false
  processors:
    - dissect:
        tokenizer: "type=%{audit.type} msg=audit(%{audit.epoch}:%{audit.serial}): %{audit.data}"
        field: "message"
        target_prefix: ""
    - add_fields:
        target: host
        fields:
          hostname: "%{HOST}"
          environment: production
    - add_tags:
        tags: [audit, security, pci-dss]

output.elasticsearch:
  hosts: ["elasticsearch.logging.svc.cluster.local:9200"]
  index: "audit-logs-%{+yyyy.MM.dd}"
  pipeline: audit-enrichment
  username: "filebeat-audit"
  password: "changeme-use-keystore"
```

### Elasticsearch Ingest Pipeline for Audit Events

```json
{
  "description": "Enrich Linux audit log events",
  "processors": [
    {
      "grok": {
        "field": "audit.data",
        "patterns": [
          "arch=%{WORD:audit.arch} syscall=%{NUMBER:audit.syscall:int} success=%{WORD:audit.success} exit=%{NUMBER:audit.exit:int}.*uid=%{NUMBER:audit.uid:int} gid=%{NUMBER:audit.gid:int} euid=%{NUMBER:audit.euid:int}.*auid=%{NUMBER:audit.auid:int}.*comm=\"%{DATA:audit.comm}\" exe=\"%{DATA:audit.exe}\" key=\"%{DATA:audit.key}\""
        ],
        "ignore_failure": true
      }
    },
    {
      "date": {
        "field": "audit.epoch",
        "formats": ["UNIX"]
      }
    },
    {
      "set": {
        "field": "event.category",
        "value": "authentication",
        "if": "ctx?.audit?.type == 'USER_AUTH' || ctx?.audit?.type == 'USER_LOGIN'"
      }
    },
    {
      "set": {
        "field": "event.outcome",
        "value": "failure",
        "if": "ctx?.audit?.success == 'no'"
      }
    }
  ]
}
```

## Section 9: Hardening auditd Against Tampering

### Making Audit Configuration Immutable

```bash
# After all rules are loaded and validated, make them immutable
# This requires a reboot to change rules (prevents attacker from disabling audit)
auditctl -e 2

# Verify immutable mode
auditctl -s | grep enabled
# enabled 2   <- immutable
```

### Protecting Audit Logs with SELinux/AppArmor

```bash
# SELinux: label audit logs to prevent access by non-audit processes
chcon -t var_log_t /var/log/audit/audit.log
# Or use restorecon after adding the context in policy

# Verify
ls -lZ /var/log/audit/
# -rw------- root root system_u:object_r:auditd_log_t:s0 audit.log
```

### Remote Audit Log Storage with audisp-remote

```ini
# /etc/audit/audisp-remote.conf
remote_server = audit-central.example.com
port = 60
transport = TCP
mode = immediate
queue_depth = 20000
connection_timeout = 5
reconnect_time = 10
ssl_verify_peer = yes
ssl_verify_host = yes
ssl_cert = /etc/audit/ssl/client.pem
ssl_key = /etc/audit/ssl/client-key.pem
ssl_ca_cert = /etc/audit/ssl/ca.pem
```

```ini
# /etc/audit/plugins.d/au-remote.conf
active = yes
direction = out
path = /sbin/audisp-remote
type = always
format = string
```

## Section 10: Performance Tuning

### High-Volume Rule Optimization

```bash
# Measure rule processing overhead
perf stat -e syscalls:sys_enter_openat \
  -p $(pgrep -f "java.*payment") sleep 10

# Suppress noisy high-frequency paths
-a never,exit -F arch=b64 -F dir=/proc -k noisy-proc
-a never,exit -F arch=b64 -F dir=/sys -k noisy-sys
-a never,exit -F arch=b64 -F path=/dev/null -k noisy-devnull

# Suppress specific high-frequency commands
-a never,exit -F arch=b64 -S execve -F exe=/usr/bin/node -k noisy-node

# Monitor rule processing performance
auditctl -s
# enabled 1
# failure 1
# pid 1234
# rate_limit 0
# backlog_limit 16384
# lost 0           <- MUST be 0; if nonzero, increase buffer or reduce rules
# backlog 3        <- current queue depth
# loginuid_immutable 0
```

### Checking for Lost Events

```bash
# Check for dropped audit events (critical: any loss is a compliance finding)
auditctl -s | grep lost

# Monitor continuously
watch -n5 'auditctl -s | grep -E "lost|backlog"'

# If lost > 0, increase buffer:
auditctl -b 32768

# Make permanent
echo '-b 32768' >> /etc/audit/rules.d/10-buffer.rules
```

## Section 11: Containerized Environment Audit

In Kubernetes environments, run a privileged DaemonSet that mounts the host audit log and forwards events:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: audit-forwarder
  namespace: security
spec:
  selector:
    matchLabels:
      app: audit-forwarder
  template:
    metadata:
      labels:
        app: audit-forwarder
    spec:
      tolerations:
        - operator: Exists
      hostPID: true
      hostNetwork: true
      priorityClassName: system-node-critical
      containers:
        - name: filebeat
          image: docker.elastic.co/beats/filebeat:8.15.0
          securityContext:
            privileged: false
            runAsUser: 0
          volumeMounts:
            - name: audit-log
              mountPath: /var/log/audit
              readOnly: true
            - name: filebeat-config
              mountPath: /usr/share/filebeat/filebeat.yml
              subPath: filebeat.yml
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
      volumes:
        - name: audit-log
          hostPath:
            path: /var/log/audit
            type: Directory
        - name: filebeat-config
          configMap:
            name: audit-forwarder-config
```

## Summary

The Linux audit framework provides kernel-level, tamper-resistant event logging that meets the evidentiary standard required by SOC 2 Type II and PCI DSS assessments. The audit rules in this guide cover every mandatory event category: identity changes, privilege escalation, cardholder data access, firewall modifications, and kernel module loading. `ausearch` and `aureport` provide immediate query capability for incident response, while the audisp plugin ecosystem enables centralized SIEM forwarding over encrypted TCP. Making rules immutable with `-e 2` after validation ensures that a compromised process cannot disable audit logging, providing the tamper evidence guarantee that auditors require.
