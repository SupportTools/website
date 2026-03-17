---
title: "Linux Audit Subsystem: Compliance Logging and Intrusion Detection"
date: 2029-05-17T00:00:00-05:00
draft: false
tags: ["Linux", "Audit", "auditd", "Security", "Compliance", "Falco", "Kubernetes"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to the Linux audit subsystem: auditd configuration, comprehensive audit rules for syscall/file/network monitoring, ausearch/aureport analysis, Falco vs auditd for container environments, and Kubernetes audit policy integration for compliance logging."
more_link: "yes"
url: "/linux-audit-subsystem-compliance-logging-intrusion-detection/"
---

The Linux audit subsystem is the canonical mechanism for compliance logging and host-level intrusion detection. Unlike higher-level security tools that operate above the kernel boundary, auditd captures events directly from the kernel's audit framework — syscall entries and exits, file accesses, network connections, and authentication events — with tamper-evident logging. This post covers production auditd configuration for PCI-DSS and SOC2 requirements, advanced rule writing, log analysis with ausearch/aureport, comparison with Falco, and integration with Kubernetes audit policy.

<!--more-->

# Linux Audit Subsystem: Compliance Logging and Intrusion Detection

## Section 1: Audit Subsystem Architecture

The Linux audit subsystem consists of:

1. **Kernel audit module** — intercepts syscalls and generates audit events
2. **auditd daemon** — reads events from the kernel netlink socket and writes to disk
3. **audispd/audisp-af_unix** — dispatcher for sending events to external consumers
4. **ausearch/aureport** — query and report tools for audit logs

```
Application → syscall → kernel audit filter → audit buffer
                                                   ↓
                                            auditd (userspace)
                                                   ↓
                                           /var/log/audit/audit.log
                                                   ↓
                                            ausearch/aureport
                                                   │
                                     audisp-syslog (→ syslog/rsyslog/fluentd)
                                     audisp-remote (→ remote audit collector)
```

### Installation and Initial Setup

```bash
# Install auditd
sudo apt-get install -y auditd audispd-plugins

# Or on RHEL/Rocky/Alma
sudo dnf install -y audit audit-libs

# Enable and start
sudo systemctl enable --now auditd

# Check status
sudo systemctl status auditd
sudo auditctl -s   # Show audit system status
# Output:
# enabled 1         (1=enabled, 0=disabled, 2=immutable)
# failure 1         (action on kernel audit queue overflow: 0=silent,1=printk,2=panic)
# pid 1234          (auditd PID)
# rate_limit 0      (max msgs/sec, 0=unlimited)
# backlog_limit 8192
# backlog_wait_time 60000
# lost 0            (messages lost due to full queue)
# backlog 0         (current queue depth)
```

## Section 2: auditd Configuration

### /etc/audit/auditd.conf

```ini
# /etc/audit/auditd.conf — Core auditd settings

# Log storage
log_file = /var/log/audit/audit.log
log_format = ENRICHED        # ENRICHED adds hostname/node info, RAW for performance
log_group = root
priority_boost = 4           # Nice priority adjustment for auditd

# Rotation
flush = INCREMENTAL_ASYNC    # SYNC for maximum safety, INCREMENTAL_ASYNC for performance
freq = 50                    # Flush every 50 records (when INCREMENTAL)
num_logs = 99                # Keep 99 rotated log files
disp_qos = lossy             # lossy=don't block on dispatcher backlog, lossless=block
dispatcher = /sbin/audispd
name_format = HOSTNAME       # Add hostname to log records
max_log_file = 100           # Rotate at 100MB
max_log_file_action = ROTATE

# Disk space management
space_left = 1024            # Warn when < 1GB free (MB)
space_left_action = SYSLOG   # Actions: IGNORE, SYSLOG, EMAIL, EXEC, SUSPEND, SINGLE, HALT
action_mail_acct = root
admin_space_left = 50        # Critical threshold (MB)
admin_space_left_action = SUSPEND  # Stop logging rather than OOM
disk_full_action = SUSPEND
disk_error_action = SUSPEND

# TCP server for remote collection
# tcp_listen_port = 60        # Enable to receive from remote systems
# tcp_listen_queue = 5
# tcp_max_per_addr = 1
```

### Performance Tuning

```bash
# Increase kernel audit backlog for burst traffic
sudo auditctl -b 16384      # Increase backlog to 16384 records

# Set failure mode (0=silent, 1=printk, 2=panic)
# Compliance often requires 2 (panic) to prevent log bypass
sudo auditctl -f 1          # Use printk for most environments

# Check for lost records
sudo auditctl -s | grep lost
# If > 0, increase backlog_limit or reduce rule count

# Set rate limit
sudo auditctl --rate 100    # Max 100 audit records/second (0=unlimited)
```

## Section 3: Writing Audit Rules

Audit rules have three types:
- **Control rules** — modify audit system behavior (`-b`, `-e`, `-f`)
- **File system rules** — watch files/directories (`-w`)
- **System call rules** — intercept syscalls (`-a`, `-A`)

### Rule File Structure

```bash
# /etc/audit/rules.d/audit.rules
# Rules are loaded in alphabetical order from /etc/audit/rules.d/
# Use numbered prefixes to control order:
# 00-preamble.rules   - backlog and rate settings
# 10-procmon.rules    - process monitoring
# 20-access.rules     - file access
# 30-identity.rules   - identity changes
# 40-network.rules    - network changes
# 50-login.rules      - login/logout events
# 60-privileged.rules - privileged commands
# 99-finalize.rules   - immutable lock
```

### 00-preamble.rules

```bash
# Remove all existing rules
-D

# Set buffer size — needs to handle burst traffic
-b 16384

# Failure mode: 1=printk, 2=panic
# Use 2 for high-security environments (prevents audit bypass via overflow)
-f 1

# Limit rate (0=unlimited)
--rate 0
```

### 10-procmon.rules — Process Monitoring

```bash
# Monitor process execution (execve syscall)
# arch=b64 for 64-bit, b32 for 32-bit compatibility layer
-a always,exit -F arch=b64 -S execve -k process_exec
-a always,exit -F arch=b32 -S execve -k process_exec

# Monitor privileged command execution
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid!=4294967295 -k privileged_exec
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid!=4294967295 -k privileged_exec

# Specifically track important binaries
-w /bin/su -p x -k session_change
-w /usr/bin/sudo -p x -k session_change
-w /usr/bin/ssh -p x -k ssh_exec
-w /usr/bin/scp -p x -k file_transfer
-w /usr/bin/rsync -p x -k file_transfer

# Container-related
-w /usr/bin/docker -p x -k docker_exec
-w /usr/bin/kubectl -p x -k k8s_exec
-w /usr/bin/containerd -p x -k container_runtime
```

### 20-access.rules — File System Monitoring

```bash
# Critical system files — watch for all accesses
-w /etc/passwd -p wa -k identity_change
-w /etc/shadow -p wa -k identity_change
-w /etc/group -p wa -k identity_change
-w /etc/gshadow -p wa -k identity_change
-w /etc/sudoers -p wa -k privilege_escalation
-w /etc/sudoers.d/ -p wa -k privilege_escalation

# SSH configuration
-w /etc/ssh/sshd_config -p wa -k ssh_config
-w /etc/ssh/ -p wa -k ssh_config

# Cron jobs
-w /etc/cron.daily/ -p wa -k scheduled_tasks
-w /etc/cron.weekly/ -p wa -k scheduled_tasks
-w /etc/cron.monthly/ -p wa -k scheduled_tasks
-w /etc/cron.d/ -p wa -k scheduled_tasks
-w /var/spool/cron/ -p wa -k scheduled_tasks

# System binaries modification
-w /sbin/ -p wa -k system_binary_modification
-w /usr/sbin/ -p wa -k system_binary_modification
-w /bin/ -p wa -k system_binary_modification
-w /usr/bin/ -p wa -k system_binary_modification

# Kernel modules
-w /sbin/insmod -p x -k kernel_module
-w /sbin/rmmod -p x -k kernel_module
-w /sbin/modprobe -p x -k kernel_module
-a always,exit -F arch=b64 -S init_module,finit_module,delete_module -k kernel_module

# Audit configuration itself
-w /etc/audit/ -p wa -k audit_config
-w /etc/libaudit.conf -p wa -k audit_config

# Mount operations (data exfiltration via USB/removable)
-a always,exit -F arch=b64 -S mount,umount2 -k mount_ops
-a always,exit -F arch=b32 -S mount,umount -k mount_ops

# Unauthorized file open attempts
-a always,exit -F arch=b64 -S open,openat,openat2 \
  -F exit=-EACCES -k unauthorized_access
-a always,exit -F arch=b64 -S open,openat,openat2 \
  -F exit=-EPERM -k unauthorized_access
```

### 30-identity.rules — Identity and Authentication

```bash
# User and group management
-a always,exit -F arch=b64 -S setuid,setgid,setreuid,setregid \
  -F auid>=1000 -F auid!=-1 -k identity_change
-a always,exit -F arch=b64 -S setfsuid,setfsgid -k identity_change

# Account management via utilities
-w /usr/sbin/useradd -p x -k account_management
-w /usr/sbin/userdel -p x -k account_management
-w /usr/sbin/usermod -p x -k account_management
-w /usr/sbin/groupadd -p x -k account_management
-w /usr/sbin/groupdel -p x -k account_management
-w /usr/sbin/groupmod -p x -k account_management
-w /usr/sbin/adduser -p x -k account_management
-w /usr/sbin/deluser -p x -k account_management
-w /usr/sbin/passwd -p x -k password_change

# PAM configuration
-w /etc/pam.d/ -p wa -k pam_config
-w /etc/nsswitch.conf -p wa -k identity_config

# Hostname and network identity
-a always,exit -F arch=b64 -S sethostname,setdomainname -k system_identity
```

### 40-network.rules — Network Monitoring

```bash
# Listen/bind operations (new services starting)
-a always,exit -F arch=b64 -S bind -k network_bind
-a always,exit -F arch=b32 -S bind -k network_bind

# Connection attempts (outbound)
-a always,exit -F arch=b64 -S connect -k network_connect
-a always,exit -F arch=b32 -S connect -k network_connect

# Socket creation
-a always,exit -F arch=b64 -S socket -F a0=2 -k network_socket_ipv4
-a always,exit -F arch=b64 -S socket -F a0=10 -k network_socket_ipv6

# Network configuration changes
-w /etc/hosts -p wa -k network_config
-w /etc/hosts.allow -p wa -k network_config
-w /etc/hosts.deny -p wa -k network_config
-w /etc/resolv.conf -p wa -k dns_config
-w /etc/sysconfig/network -p wa -k network_config
-w /etc/network/ -p wa -k network_config
-w /etc/NetworkManager/ -p wa -k network_config

# iptables/nftables changes
-w /sbin/iptables -p x -k firewall_change
-w /sbin/ip6tables -p x -k firewall_change
-w /usr/sbin/nft -p x -k firewall_change
-w /etc/sysconfig/iptables -p wa -k firewall_config
```

### 50-login.rules — Login Events

```bash
# TTY-based login tracking
-w /var/log/faillog -p wa -k logins
-w /var/log/lastlog -p wa -k logins
-w /var/log/btmp -p wa -k session_failed
-w /var/run/utmp -p wa -k session

# PAM session events
-a always,exit -F arch=b64 -S open -F dir=/var/run/utmp \
  -F success=1 -k session_open

# TTY input (captures terminal commands, useful for insider threat)
# WARNING: Very high volume — enable only for specific users
# -a always,exit -F arch=b64 -S write -F a0=1 \
#   -F auid!=4294967295 -F uid=0 -k tty_input
```

### 60-privileged.rules — Privileged Operations

```bash
# SUID/SGID program execution
# These are common privilege escalation vectors
-a always,exit -F path=/usr/bin/newgrp -F perm=x -F auid>=1000 \
  -F auid!=-1 -k privileged_newgrp
-a always,exit -F path=/usr/bin/chsh -F perm=x -F auid>=1000 \
  -F auid!=-1 -k privileged_chsh
-a always,exit -F path=/usr/bin/chfn -F perm=x -F auid>=1000 \
  -F auid!=-1 -k privileged_chfn
-a always,exit -F path=/usr/bin/crontab -F perm=x -F auid>=1000 \
  -F auid!=-1 -k privileged_crontab

# ptrace (debugger attach — could be used for credential extraction)
-a always,exit -F arch=b64 -S ptrace -k ptrace_use

# Capability changes
-a always,exit -F arch=b64 -S capset -k capability_change

# Chroot
-a always,exit -F arch=b64 -S chroot -k chroot_use
```

### 99-finalize.rules — Lock the Audit Configuration

```bash
# Make the audit configuration immutable
# After this, rules cannot be changed until reboot
# Required by PCI-DSS
-e 2
```

### Loading Rules

```bash
# Apply rules
sudo augenrules --load
# Or:
sudo service auditd reload

# Verify rules are loaded
sudo auditctl -l

# Count active rules
sudo auditctl -l | wc -l

# Check for any errors
sudo auditctl -l 2>&1 | grep -i error
```

## Section 4: Log Analysis with ausearch and aureport

### ausearch — Query Individual Events

```bash
# Recent authentication failures
sudo ausearch -m USER_FAILED_LOGIN --start today
sudo ausearch -m USER_AUTH -sv no --start today

# File access events by key
sudo ausearch -k identity_change --start today

# Events from a specific user
sudo ausearch -ua 1000 --start yesterday

# Events on a specific file
sudo ausearch -f /etc/passwd --start today

# Privileged command executions
sudo ausearch -m EXECVE -k privileged_exec --start today

# Failed syscalls (access denied)
sudo ausearch -m SYSCALL -sv no --start "1 hour ago"

# Events in a time window
sudo ausearch --start "04/01/2029 00:00:00" --end "04/01/2029 23:59:59"

# Network connection events
sudo ausearch -k network_connect --start today | ausearch --interpret

# Output formats
sudo ausearch -m USER_LOGIN --start today -i   # Human-readable
sudo ausearch -m USER_LOGIN --start today --format json  # JSON output
```

### aureport — Summary Reports

```bash
# Summary of all audit events for today
sudo aureport --start today --end now --summary

# Login report
sudo aureport --login --start today
# Output:
# Login Report
# ============
# # date time auid host term exe success event
# 1. 05/15/2029 09:01:23 1000 server1 ssh /usr/bin/sshd yes 4521
# 2. 05/15/2029 09:15:44 0 server1 pts/0 /bin/bash yes 4823

# Authentication failures
sudo aureport --auth --failed --start today

# File system events summary
sudo aureport --file --start today

# Account modification events
sudo aureport --user --start today

# Executable report (what binaries were run)
sudo aureport --executable --start today

# Anomaly detection report
sudo aureport --anomaly --start today

# System calls report
sudo aureport --syscall --start today | head -30

# Failed syscalls only
sudo aureport --syscall --failed --start today

# Generate compliance summary report
sudo aureport --summary --start "this-month"

# Events per user
sudo aureport --user --start today --end now | sort -k3 -rn
```

### Custom Analysis Scripts

```bash
#!/bin/bash
# audit_report.sh - Daily security summary

DATE=$(date +%Y-%m-%d)
YESTERDAY=$(date -d yesterday +%Y-%m-%d)

echo "=== Security Audit Report: $DATE ==="
echo ""

echo "--- Authentication Events ---"
sudo aureport --auth --start "$YESTERDAY" --end "$DATE" 2>/dev/null
echo ""

echo "--- Failed Login Attempts ---"
sudo ausearch -m USER_FAILED_LOGIN --start yesterday 2>/dev/null | \
  grep "acct=" | awk -F'acct=' '{print $2}' | awk '{print $1}' | \
  sort | uniq -c | sort -rn | head -10
echo ""

echo "--- Privileged Executions ---"
sudo ausearch -k privileged_exec --start yesterday 2>/dev/null | \
  grep "exe=" | awk -F'exe=' '{print $2}' | awk '{print $1}' | \
  sort | uniq -c | sort -rn | head -20
echo ""

echo "--- Identity Changes ---"
sudo ausearch -k identity_change --start yesterday 2>/dev/null | \
  grep -v "^----$" | head -30
echo ""

echo "--- Network Binds (New Services) ---"
sudo ausearch -k network_bind --start yesterday 2>/dev/null | \
  grep -oP '(?<=saddr=)\S+' | sort | uniq -c | sort -rn | head -10
echo ""

echo "--- Kernel Module Operations ---"
sudo ausearch -k kernel_module --start yesterday 2>/dev/null | \
  grep "key=kernel_module"
```

## Section 5: Falco vs auditd

### Comparison Matrix

| Feature | auditd | Falco |
|---------|--------|-------|
| Kernel integration | Kernel audit subsystem | eBPF or kernel module |
| Container awareness | Limited (via cgroup info) | Native container/K8s context |
| Rule language | Simple key=value | YAML with conditions |
| Real-time alerting | via audisp plugins | Native |
| Kubernetes integration | Manual | Native (K8s audit webhook) |
| Performance overhead | Low-medium | Low (eBPF driver) |
| Compliance mapping | Excellent (AUID tracking) | Via tagging |
| File integrity monitoring | Excellent | Limited |
| Syscall coverage | Complete | Configurable |

### When to Use Each

Use **auditd** for:
- Compliance frameworks requiring AUID tracking (PCI-DSS, HIPAA, SOC2)
- File integrity monitoring
- Complete syscall audit trail
- Long-term log retention and forensics
- Environments where eBPF is not available

Use **Falco** for:
- Container runtime security in Kubernetes
- Real-time alerting with rich context
- Behavioral anomaly detection
- Cloud-native environments

Use **both** for:
- High-security environments needing defense in depth
- Compliance + real-time security operations center integration

### Running Both Together

```bash
# auditd handles compliance logging
# Falco handles container-level behavioral detection

# Configure auditd for host-level events
# Configure Falco for container-level events

# Route auditd events to SIEM via audisp-syslog
# /etc/audisp/plugins.d/syslog.conf
[syslog]
active = yes
direction = out
path = /sbin/audisp-syslog
type = always
args = LOG_INFO
format = string
```

```yaml
# Falco configuration for containers
# /etc/falco/falco.yaml
rules_file:
  - /etc/falco/falco_rules.yaml
  - /etc/falco/falco_rules.local.yaml

# Send alerts to various destinations
json_output: true
json_include_output_property: true

outputs:
  rate: 1
  max_burst: 1000

# Send to syslog for SIEM integration
syslog_output:
  enabled: true

# Webhook for real-time alerting
http_output:
  enabled: true
  url: http://falco-exporter:2801
```

## Section 6: Kubernetes Audit Policy Integration

Kubernetes has its own audit logging that captures API server requests. Combining K8s audit policy with auditd on nodes gives complete visibility from API to syscall.

### Kubernetes Audit Policy

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
# Don't log requests at the metadata level
omitStages:
  - "RequestReceived"

rules:
  # Log pod exec and port-forward at RequestResponse level
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["pods/exec", "pods/portforward", "pods/attach"]
    verbs: ["create"]

  # Log secret access at RequestResponse level (capture secret values)
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["secrets"]
    verbs: ["get", "list", "watch"]

  # Log RBAC changes
  - level: RequestResponse
    resources:
    - group: "rbac.authorization.k8s.io"
      resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]
    verbs: ["create", "update", "patch", "delete"]

  # Log service account token creation
  - level: Request
    resources:
    - group: ""
      resources: ["serviceaccounts/token"]
    verbs: ["create"]

  # Log configmap and secret creation/modification
  - level: Metadata
    resources:
    - group: ""
      resources: ["configmaps", "secrets"]
    verbs: ["create", "update", "patch", "delete"]
    namespaces: ["kube-system"]

  # Log authentication failures
  - level: RequestResponse
    users: ["system:anonymous"]

  # Don't log health check endpoints
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
    resources:
    - group: ""
      resources: ["endpoints", "services", "services/status"]

  # Don't log kube-apiserver health check
  - level: None
    userGroups: ["system:authenticated"]
    nonResourceURLs:
    - "/api*"
    - "/version"
    - "/healthz"
    - "/readyz"
    - "/livez"

  # Log everything else at Metadata level
  - level: Metadata
    omitStages:
      - "RequestReceived"
```

### Enabling Kubernetes Audit Logging

```yaml
# kube-apiserver configuration (kubeadm cluster)
# /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30        # Keep 30 days
    - --audit-log-maxbackup=10     # Keep 10 backup files
    - --audit-log-maxsize=100      # Rotate at 100MB
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    # Dynamic audit backend (send to webhook)
    - --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
    - --audit-webhook-batch-max-wait=1s
    volumeMounts:
    - name: audit-policy
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
    - name: audit-log
      mountPath: /var/log/kubernetes/audit
  volumes:
  - name: audit-policy
    hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
  - name: audit-log
    hostPath:
      path: /var/log/kubernetes/audit
      type: DirectoryOrCreate
```

### Shipping Kubernetes Audit Logs to SIEM

```yaml
# audit-webhook.yaml — Send to Falco or custom aggregator
apiVersion: v1
kind: Config
clusters:
- name: audit-backend
  cluster:
    server: http://audit-aggregator.kube-system.svc.cluster.local:8080/audit
contexts:
- context:
    cluster: audit-backend
    user: ""
  name: default-context
current-context: default-context
users: []
preferences: {}
```

```yaml
# Fluentd/FluentBit configuration to ship audit logs
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: kube-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info

    [INPUT]
        Name              tail
        Tag               audit.kubernetes
        Path              /var/log/kubernetes/audit/audit.log
        Parser            json
        DB                /var/log/audit.db
        Refresh_Interval  5

    [INPUT]
        Name              tail
        Tag               audit.system
        Path              /var/log/audit/audit.log
        Parser            logfmt
        DB                /var/log/system-audit.db

    [OUTPUT]
        Name              es
        Match             audit.*
        Host              elasticsearch.monitoring.svc.cluster.local
        Port              9200
        Index             audit-logs
        Type              _doc
        Logstash_Format   On
        Logstash_Prefix   audit
```

## Section 7: Compliance Mapping

### PCI-DSS Requirements Mapped to Audit Rules

```bash
# Requirement 10.2.1 — Individual user access to cardholder data
-a always,exit -F arch=b64 -S open,openat,openat2 \
  -F dir=/data/cardholder -F success=1 -k pci_data_access

# Requirement 10.2.2 — All actions taken by root
-a always,exit -F arch=b64 -F uid=0 -F auid!=4294967295 -k pci_root_action

# Requirement 10.2.3 — Access to audit trails
-w /var/log/audit/ -p rwa -k pci_audit_access

# Requirement 10.2.4 — Invalid logical access attempts
-a always,exit -F arch=b64 -S open,openat -F exit=-EACCES -k pci_failed_access
-a always,exit -F arch=b64 -S open,openat -F exit=-EPERM -k pci_failed_access

# Requirement 10.2.5 — Use of and changes to identification and authentication
-w /etc/passwd -p wa -k pci_identity
-w /etc/shadow -p wa -k pci_identity
-w /etc/sudoers -p wa -k pci_privilege

# Requirement 10.2.6 — Initialization, stopping, or pausing of the audit logs
-w /etc/audit/ -p wa -k pci_audit_config
-w /sbin/auditd -p x -k pci_audit_config

# Requirement 10.2.7 — Creation and deletion of system-level objects
-a always,exit -F arch=b64 -S open,openat,openat2 \
  -F exit=-ENOENT -k pci_object_access

# Requirement 10.3 — Capture specific event details
# auid (Always User ID) provides the actual user even after su/sudo
# This is the primary differentiator from syslog
```

### Generating Compliance Reports

```bash
#!/bin/bash
# pci_compliance_report.sh

START="last-month"
END="now"

echo "PCI-DSS Audit Log Review"
echo "Period: $(date -d "last month" +%Y-%m) to $(date +%Y-%m-%d)"
echo "Generated: $(date)"
echo ""

echo "=== 10.2.2: Root Actions ==="
sudo aureport --start "$START" --end "$END" --user 2>/dev/null | \
  grep " root " | head -50

echo ""
echo "=== 10.2.4: Failed Access Attempts ==="
sudo ausearch -k pci_failed_access --start "$START" 2>/dev/null | \
  grep "type=SYSCALL" | awk '{print $5" "$9" "$22}' | \
  sort | uniq -c | sort -rn | head -20

echo ""
echo "=== 10.2.5: Identity Changes ==="
sudo ausearch -k pci_identity --start "$START" 2>/dev/null | \
  grep "type=PATH\|type=SYSCALL" | head -30

echo ""
echo "=== 10.2.6: Audit Configuration Access ==="
sudo ausearch -k pci_audit_config --start "$START" 2>/dev/null
```

The Linux audit subsystem, properly configured, provides the forensic-grade logging that compliance frameworks require and that security operations teams need for incident investigation. Combined with Kubernetes audit policy for API-level events and a SIEM for aggregation, it creates complete observability from user action to kernel operation.
