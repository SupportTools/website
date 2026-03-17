---
title: "Linux Audit Framework: Comprehensive Security Auditing with auditd and auditctl"
date: 2030-12-23T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "auditd", "auditctl", "SIEM", "Compliance", "Kubernetes", "Syscall"]
categories:
- Linux
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linux auditd covering syscall monitoring rules, file access auditing, user session tracking, ausearch and aureport analysis, SIEM integration, and Kubernetes audit framework integration for SOC2 and PCI-DSS compliance."
more_link: "yes"
url: "/linux-audit-framework-auditd-comprehensive-security-auditing/"
---

The Linux Audit framework is the foundation of compliance and security monitoring on Linux systems. While many teams rely on third-party agents, understanding the native audit subsystem enables precise control over what gets recorded, at what cost, and how audit logs are forwarded to SIEM platforms. This guide covers everything from basic auditd configuration through production audit rule sets that satisfy PCI-DSS, SOC2, and CIS Benchmark requirements.

<!--more-->

# Linux Audit Framework: Comprehensive Security Auditing with auditd and auditctl

## Architecture Overview

The Linux Audit framework consists of three components:

1. **Kernel audit subsystem**: Hooks into system calls and kernel events, generating audit records
2. **auditd daemon**: Receives records from the kernel via a netlink socket, writes to `/var/log/audit/audit.log`
3. **Audit tools**: `auditctl` (rule management), `ausearch` (log searching), `aureport` (log summarization), `autrace` (process tracing)

The audit framework operates at the kernel level, which means it cannot be bypassed by userspace processes (unlike file-based monitoring tools). This is critical for security-sensitive environments.

## Installation and Basic Configuration

### Installing Audit Tools

```bash
# RHEL/CentOS/Fedora
dnf install audit audit-libs

# Debian/Ubuntu
apt-get install auditd audispd-plugins

# Verify installation
auditd --version
auditctl --version
```

### Core auditd Configuration

The primary configuration file is `/etc/audit/auditd.conf`:

```ini
# /etc/audit/auditd.conf - Production configuration

# Log file settings
log_file = /var/log/audit/audit.log
log_format = ENRICHED         # Include uid/gid name resolution
log_group = root
priority_boost = 4            # Slightly increase auditd scheduler priority
flush = INCREMENTAL_ASYNC     # Balance performance and reliability
freq = 50                     # Flush every 50 records

# Log rotation settings
max_log_file = 200            # Max log size in MB
num_logs = 10                 # Keep 10 rotated logs
max_log_file_action = ROTATE  # Rotate when size limit reached

# Disk space management
space_left = 75               # MB remaining before action
space_left_action = SYSLOG    # Write warning to syslog
admin_space_left = 50         # Critical threshold
admin_space_left_action = SUSPEND  # Stop writing when critical
disk_full_action = SUSPEND    # Suspend logging when disk full
disk_error_action = SUSPEND   # Suspend on disk error

# Network (for remote logging)
##tcp_listen_port = 60
##tcp_listen_queue = 5
##tcp_max_per_addr = 1

# TCP keep-alive for remote logging
##tcp_client_heartbeat_timeout = 0
##tcp_client_max_idle = 0

# Plugins
disp_qos = lossy              # Or 'lossless' for high-security environments
dispatcher = /sbin/audispd   # Dispatcher daemon for plugins

# Performance tuning
write_logs = yes
name_format = HOSTNAME        # Include hostname in records
name = myserver01
```

### Starting and Enabling auditd

```bash
# Enable and start auditd
systemctl enable auditd
systemctl start auditd

# Check status
systemctl status auditd

# Verify the audit subsystem is enabled
auditctl -s
```

Expected output from `auditctl -s`:
```
enabled 1
failure 1
pid 1234
rate_limit 0
backlog_limit 8192
lost 0
backlog 0
backlog_wait_time 60000
loginuid_immutable 0 unlocked
```

## Writing Effective Audit Rules

Audit rules are managed via `auditctl` and stored in `/etc/audit/rules.d/`. Rules follow a specific syntax:

```
auditctl [-a|-d|-D] action,filter -S syscall(s) [-F field=value] [-k keyname]
```

Where:
- `action`: `always` (record) or `never` (suppress)
- `filter`: `task`, `exit`, `user`, `exclude`, or `filesystem`
- `-S`: Specific syscall(s) to monitor
- `-F`: Filter conditions
- `-k`: Key name for searching logs

### CIS Benchmark Audit Rule Set

The CIS (Center for Internet Security) benchmark provides a comprehensive starting point:

```bash
# /etc/audit/rules.d/99-cis-benchmark.rules

# Remove all existing rules
-D

# Set the buffer size (increase for high-volume environments)
-b 8192

# Failure mode: 0=silent, 1=printk, 2=panic
-f 1

# ============================================================
# Section 4.1.2 - Ensure auditd collects system administrator actions
# ============================================================
-w /etc/sudoers -p wa -k scope
-w /etc/sudoers.d/ -p wa -k scope

# ============================================================
# Section 4.1.3 - Ensure auditd collects information on the use of privileged commands
# ============================================================
# Find all SUID/SGID programs and audit their execution
# Run: find / -xdev \( -perm -4000 -o -perm -2000 \) -type f 2>/dev/null
# Then add rules like:
-a always,exit -F path=/usr/bin/sudo -F perm=x -F auid>=1000 -F auid!=-1 -k privileged
-a always,exit -F path=/usr/bin/su -F perm=x -F auid>=1000 -F auid!=-1 -k privileged
-a always,exit -F path=/usr/bin/newgrp -F perm=x -F auid>=1000 -F auid!=-1 -k privileged
-a always,exit -F path=/usr/bin/chsh -F perm=x -F auid>=1000 -F auid!=-1 -k privileged
-a always,exit -F path=/usr/bin/mount -F perm=x -F auid>=1000 -F auid!=-1 -k privileged
-a always,exit -F path=/usr/bin/umount -F perm=x -F auid>=1000 -F auid!=-1 -k privileged

# ============================================================
# Section 4.1.4 - Ensure auditd collects information on file deletions
# ============================================================
-a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat -F auid>=1000 -F auid!=-1 -k delete
-a always,exit -F arch=b32 -S unlink -S unlinkat -S rename -S renameat -F auid>=1000 -F auid!=-1 -k delete

# ============================================================
# Section 4.1.5 - Ensure auditd collects changes to system administration scope
# ============================================================
-a always,exit -F arch=b64 -S sethostname -S setdomainname -k system-locale
-a always,exit -F arch=b32 -S sethostname -S setdomainname -k system-locale
-w /etc/issue -p wa -k system-locale
-w /etc/issue.net -p wa -k system-locale
-w /etc/hosts -p wa -k system-locale
-w /etc/hostname -p wa -k system-locale
-w /etc/sysconfig/network -p wa -k system-locale

# ============================================================
# Section 4.1.6 - Ensure auditd collects system login and logout events
# ============================================================
-w /var/log/lastlog -p wa -k logins
-w /var/run/faillock -p wa -k logins

# ============================================================
# Section 4.1.7 - Ensure auditd collects session initiation information
# ============================================================
-w /var/run/utmp -p wa -k session
-w /var/log/wtmp -p wa -k logins
-w /var/log/btmp -p wa -k logins

# ============================================================
# Section 4.1.8 - Ensure auditd collects discretionary access control
# ============================================================
-a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat -F auid>=1000 -F auid!=-1 -k perm_mod
-a always,exit -F arch=b32 -S chmod -S fchmod -S fchmodat -F auid>=1000 -F auid!=-1 -k perm_mod
-a always,exit -F arch=b64 -S chown -S fchown -S fchownat -S lchown -F auid>=1000 -F auid!=-1 -k perm_mod
-a always,exit -F arch=b32 -S chown -S fchown -S fchownat -S lchown -F auid>=1000 -F auid!=-1 -k perm_mod
-a always,exit -F arch=b64 -S setxattr -S lsetxattr -S fsetxattr -S removexattr -S lremovexattr -S fremovexattr -F auid>=1000 -F auid!=-1 -k perm_mod
-a always,exit -F arch=b32 -S setxattr -S lsetxattr -S fsetxattr -S removexattr -S lremovexattr -S fremovexattr -F auid>=1000 -F auid!=-1 -k perm_mod

# ============================================================
# Section 4.1.9 - Ensure auditd collects unsuccessful unauthorized access
# ============================================================
-a always,exit -F arch=b64 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EACCES -F auid>=1000 -F auid!=-1 -k access
-a always,exit -F arch=b32 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EACCES -F auid>=1000 -F auid!=-1 -k access
-a always,exit -F arch=b64 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EPERM -F auid>=1000 -F auid!=-1 -k access
-a always,exit -F arch=b32 -S creat -S open -S openat -S truncate -S ftruncate -F exit=-EPERM -F auid>=1000 -F auid!=-1 -k access

# ============================================================
# Section 4.1.10 - Ensure auditd collects information on kernel module loading/unloading
# ============================================================
-w /sbin/insmod -p x -k modules
-w /sbin/rmmod -p x -k modules
-w /sbin/modprobe -p x -k modules
-a always,exit -F arch=b64 -S init_module -S finit_module -S delete_module -k modules

# ============================================================
# Section 4.1.11 - Ensure auditd collects time change events
# ============================================================
-a always,exit -F arch=b64 -S adjtimex -S settimeofday -S clock_settime -k time-change
-a always,exit -F arch=b32 -S adjtimex -S settimeofday -S clock_settime -k time-change
-w /etc/localtime -p wa -k time-change

# ============================================================
# Section 4.1.12 - Ensure auditd collects user/group information changes
# ============================================================
-w /etc/group -p wa -k identity
-w /etc/passwd -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/security/opasswd -p wa -k identity

# ============================================================
# Section 4.1.13 - Ensure auditd collects MAC policy changes
# ============================================================
-w /etc/selinux/ -p wa -k MAC-policy
-w /usr/share/selinux/ -p wa -k MAC-policy

# ============================================================
# Make the audit configuration immutable (requires reboot to change)
# Comment out during initial configuration; enable for production
# ============================================================
#-e 2
```

### Critical File Monitoring Rules

```bash
# /etc/audit/rules.d/50-critical-files.rules

# SSH configuration
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/ssh/sshd_config.d/ -p wa -k sshd_config

# PAM configuration
-w /etc/pam.d/ -p wa -k pam_config
-w /etc/security/ -p wa -k pam_config

# Cron configuration
-w /etc/cron.d/ -p wa -k cron
-w /etc/cron.daily/ -p wa -k cron
-w /etc/cron.hourly/ -p wa -k cron
-w /etc/cron.monthly/ -p wa -k cron
-w /etc/cron.weekly/ -p wa -k cron
-w /etc/crontab -p wa -k cron
-w /var/spool/cron/crontabs -p wa -k cron

# Boot configuration
-w /boot/grub2/grub.cfg -p wa -k boot_cfg
-w /etc/grub.d/ -p wa -k boot_cfg

# Network configuration
-w /etc/sysconfig/network-scripts/ -p wa -k network_cfg
-w /etc/NetworkManager/ -p wa -k network_cfg

# Systemd unit files
-w /etc/systemd/ -p wa -k systemd_config
-w /usr/lib/systemd/ -p wa -k systemd_config
-w /usr/local/lib/systemd/ -p wa -k systemd_config

# Certificate files
-w /etc/pki/ -p wa -k certificates
-w /etc/ssl/ -p wa -k certificates

# Audit configuration itself
-w /etc/audit/ -p wa -k audit_config
-w /etc/libaudit.conf -p wa -k audit_config

# Sysctl kernel parameters
-w /etc/sysctl.conf -p wa -k sysctl
-w /etc/sysctl.d/ -p wa -k sysctl
```

### Advanced Syscall Monitoring

```bash
# /etc/audit/rules.d/40-syscall-advanced.rules

# Monitor network configuration changes
-a always,exit -F arch=b64 -S socket -F a0=10 -k network_socket_ipv6
-a always,exit -F arch=b64 -S socket -F a0=2  -k network_socket_ipv4

# Monitor ptrace (debugging/injection attacks)
-a always,exit -F arch=b64 -S ptrace -F a0=4 -k code_injection
-a always,exit -F arch=b64 -S ptrace -F a0=5 -k data_injection
-a always,exit -F arch=b64 -S ptrace -F a0=6 -k register_injection
-a always,exit -F arch=b32 -S ptrace -k ptrace

# Monitor process creation (execve is the core syscall)
-a always,exit -F arch=b64 -S execve -F auid!=unset -k exec
-a always,exit -F arch=b32 -S execve -F auid!=unset -k exec

# Monitor memory-mapped execution (shellcode patterns)
-a always,exit -F arch=b64 -S mmap -F a2&0x4 -F a3&0x22 -k mmap_exec
-a always,exit -F arch=b64 -S mprotect -F a2&0x4 -k mprotect_exec

# Monitor attempts to access /proc filesystem of other processes
-a always,exit -F dir=/proc -F auid!=unset -F auid>=1000 -k proc_access

# Monitor raw socket creation (network scanning tools)
-a always,exit -F arch=b64 -S socket -F a0=17 -k raw_socket
-a always,exit -F arch=b64 -S socket -F a0=3  -k raw_socket

# Monitor mount operations
-a always,exit -F arch=b64 -S mount -F auid!=unset -k mount
-a always,exit -F arch=b32 -S mount -F auid!=unset -k mount

# Monitor inotify watches (could indicate surveillance tools)
-a always,exit -F arch=b64 -S inotify_add_watch -k inotify

# Monitor writes to /dev/kmem, /dev/mem (kernel memory tampering)
-a always,exit -F arch=b64 -S open -F path=/dev/mem -F perm=w -k kernel_memory
-a always,exit -F arch=b64 -S open -F path=/dev/kmem -F perm=w -k kernel_memory
```

### Container and Kubernetes-Specific Rules

```bash
# /etc/audit/rules.d/60-containers.rules

# Monitor container runtime (containerd, docker)
-a always,exit -F arch=b64 -S clone -F a0&268435456 -k container_create
-a always,exit -F arch=b64 -S unshare -k namespace_change
-a always,exit -F arch=b64 -S setns -k namespace_change

# Monitor capabilities (privilege escalation in containers)
-a always,exit -F arch=b64 -S capset -k capabilities
-a always,exit -F arch=b64 -S setuid -S setgid -k uid_gid_change
-a always,exit -F arch=b64 -S setreuid -S setregid -k uid_gid_change
-a always,exit -F arch=b64 -S setresuid -S setresgid -k uid_gid_change

# Monitor cgroup manipulation
-w /sys/fs/cgroup -p wa -k cgroup_change

# Monitor namespace-related files
-w /proc/self/ns -p r -k ns_access

# Monitor container runtime configuration
-w /etc/containerd/ -p wa -k containerd_config
-w /etc/docker/ -p wa -k docker_config
-w /var/lib/docker/ -p wa -k docker_data
```

## Analyzing Audit Logs

### ausearch - Searching Audit Logs

ausearch provides powerful filtering to extract specific events from audit logs:

```bash
# Search by key name
ausearch -k identity
ausearch -k privileged
ausearch -k access

# Search by time range
ausearch --start today --end now -k identity
ausearch --start "01/01/2024 00:00:00" --end "01/31/2024 23:59:59" -k scope

# Search by user
ausearch -ua 1000            # By user UID
ausearch -un alice           # By username

# Search by process
ausearch -p 12345            # By PID
ausearch -x /usr/bin/sudo    # By executable

# Search for failed operations only
ausearch -sv no              # Failed system calls

# Search for specific event types
ausearch -m USER_AUTH        # Authentication events
ausearch -m USER_ACCT        # Account-related events
ausearch -m EXECVE           # Process execution
ausearch -m SYSCALL          # System calls

# Combine filters
ausearch -k identity -sv no --start today

# Format output for readability
ausearch -k privileged -i | less   # -i interprets UIDs to usernames
```

### aureport - Summary Reports

aureport generates concise summaries of audit activity:

```bash
# Summary of all events
aureport --summary

# Authentication report
aureport -au

# Failed authentication attempts
aureport -au --failed

# Account changes
aureport -m

# File access report (most accessed files)
aureport -f

# Executable report
aureport -x

# Login report
aureport -l

# User report
aureport -u

# Time-bounded report
aureport --start today --end now --summary

# Report for last 7 days
aureport --start "7 days ago" --end now -au

# Anomaly detection (events that fail checks)
aureport --anomaly

# Terminal report (logins by terminal type)
aureport -t
```

### Automated Compliance Report Script

```bash
#!/bin/bash
# /usr/local/bin/audit-compliance-report.sh
# Generates daily compliance summary report

REPORT_DATE=$(date +%Y-%m-%d)
REPORT_FILE="/var/log/audit/compliance-report-${REPORT_DATE}.txt"
START_TIME="yesterday"
END_TIME="now"

echo "=== Audit Compliance Report for ${REPORT_DATE} ===" > "$REPORT_FILE"
echo "Generated: $(date)" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== Authentication Events ===" >> "$REPORT_FILE"
aureport -au --start "$START_TIME" --end "$END_TIME" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== Failed Authentication Attempts ===" >> "$REPORT_FILE"
aureport -au --failed --start "$START_TIME" --end "$END_TIME" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== User Account Changes ===" >> "$REPORT_FILE"
ausearch -k identity --start "$START_TIME" --end "$END_TIME" -i 2>/dev/null | \
  grep -E "(type=USER_MGMT|type=USYS_CONFIG|type=GRP_MGMT)" | \
  head -50 >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== Privileged Command Execution ===" >> "$REPORT_FILE"
ausearch -k privileged --start "$START_TIME" --end "$END_TIME" -i 2>/dev/null | \
  grep "type=EXECVE" | head -50 >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== File Deletions by Non-Root Users ===" >> "$REPORT_FILE"
ausearch -k delete --start "$START_TIME" --end "$END_TIME" -i 2>/dev/null | \
  grep -v "auid=0" | head -50 >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== Sudo Usage ===" >> "$REPORT_FILE"
ausearch -k scope --start "$START_TIME" --end "$END_TIME" -i 2>/dev/null | \
  head -50 >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== Kernel Module Events ===" >> "$REPORT_FILE"
ausearch -k modules --start "$START_TIME" --end "$END_TIME" -i 2>/dev/null | \
  head -20 >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "=== Summary Statistics ===" >> "$REPORT_FILE"
aureport --start "$START_TIME" --end "$END_TIME" --summary >> "$REPORT_FILE"

# Send report via email
mail -s "Audit Compliance Report - ${REPORT_DATE}" security@example.com < "$REPORT_FILE"

echo "Report generated: $REPORT_FILE"
```

### Real-Time Audit Monitoring with auditd

For real-time monitoring, use `autrace` or read directly from the audit log:

```bash
# Trace a specific process
autrace /usr/bin/ssh user@remote-host

# Watch the audit log in real time
tail -f /var/log/audit/audit.log | ausearch --input-logs

# Monitor for specific event types in real time
ausearch -m EXECVE -i --start recent | tail -f
```

## SIEM Integration

### Forwarding Audit Logs to Elasticsearch

Install and configure the audisp-remote plugin:

```bash
# Install audisp-remote
dnf install audispd-plugins

# Configure /etc/audisp/audisp-remote.conf
cat > /etc/audisp/audisp-remote.conf << 'EOF'
remote_server = siem.example.com
port = 60
transport = tcp
mode = immediate
queue_depth = 10240
connection_retries = 3
reconnect_time = 5
receive_timeout = 6
enable_krb5 = no
krb5_principal = auditd
krb5_client_name = auditd
krb5_creds_cache = /etc/audisp/audit.key
EOF
```

### Filebeat Configuration for Audit Logs

```yaml
# /etc/filebeat/filebeat.yml

filebeat.inputs:
- type: log
  enabled: true
  paths:
  - /var/log/audit/audit.log
  tags: ["linux-audit"]
  fields:
    log_type: audit
    hostname: "${HOSTNAME}"
    datacenter: "us-east-1"
  fields_under_root: false

  # Parse multiline audit records
  multiline.pattern: '^type='
  multiline.negate: true
  multiline.match: after

processors:
- dissect:
    tokenizer: "type=%{audit_type} msg=audit(%{audit_time}): %{audit_message}"
    field: "message"
    target_prefix: "audit"
    ignore_failure: true

- decode_csv_fields:
    fields:
      message: decoded_message
    separator: " "
    ignore_missing: true

- add_host_metadata:
    when.not.contains.tags: forwarded

output.elasticsearch:
  hosts: ["elasticsearch.example.com:9200"]
  index: "linux-audit-%{+yyyy.MM.dd}"
  username: "filebeat"
  password: "<elasticsearch-password>"
  ssl.certificate_authorities: ["/etc/filebeat/ca.crt"]
  ssl.certificate: "/etc/filebeat/filebeat.crt"
  ssl.key: "/etc/filebeat/filebeat.key"

setup.template.name: "linux-audit"
setup.template.pattern: "linux-audit-*"
setup.template.settings:
  index.number_of_shards: 1
  index.number_of_replicas: 1
```

### Splunk Universal Forwarder Configuration

```ini
# /opt/splunkforwarder/etc/system/local/inputs.conf

[monitor:///var/log/audit/audit.log]
disabled = false
index = linux_security
sourcetype = linux_audit
host_segment = 4

[monitor:///var/log/secure]
disabled = false
index = linux_security
sourcetype = linux_secure
host_segment = 4

# /opt/splunkforwarder/etc/system/local/props.conf
[linux_audit]
SHOULD_LINEMERGE = false
TIME_PREFIX = msg=audit\(
TIME_FORMAT = %s.%N:%
TRANSFORMS-audittype = audit-type-extract

# /opt/splunkforwarder/etc/system/local/transforms.conf
[audit-type-extract]
REGEX = type=(\w+)
FORMAT = audit_type::$1
WRITE_META = true
```

### Graylog Sidecar with auditd

```yaml
# /etc/graylog/sidecar/sidecar.yml

server_url: "https://graylog.example.com/api/"
server_api_token: "<graylog-api-token>"
node_id: "file:/etc/graylog/sidecar/node-id"
log_path: "/var/log/graylog/sidecar"
log_rotation_time: 86400
log_max_age: 604800
update_interval: 10
tls_skip_verify: false
send_status: true
list_log_files:
- /var/log

collector_configuration_directory: "/etc/graylog/sidecar/generated"
cache_path: "/var/cache/graylog/sidecar"
```

## Kubernetes Audit Framework Integration

Kubernetes has its own audit framework that complements the Linux audit subsystem:

### Kubernetes API Server Audit Policy

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
- RequestReceived  # Skip initial receive for performance

rules:
# Log all pod exec/attach commands (security-critical)
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log secret access
- level: Metadata
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]
  verbs: ["get", "list", "watch"]

# Log authentication and authorization
- level: Metadata
  resources:
  - group: "authentication.k8s.io"
  - group: "authorization.k8s.io"

# Log changes to RBAC resources
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]

# Log namespace modifications
- level: RequestResponse
  resources:
  - group: ""
    resources: ["namespaces"]

# Log Node changes
- level: Metadata
  resources:
  - group: ""
    resources: ["nodes"]

# Catch-all: Log at Metadata level for everything else
- level: Metadata
  omitStages:
  - RequestReceived
```

### Enabling API Server Audit Logging

Add to `/etc/kubernetes/manifests/kube-apiserver.yaml`:

```yaml
spec:
  containers:
  - command:
    - kube-apiserver
    - --audit-log-path=/var/log/kubernetes/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-format=json
    volumeMounts:
    - mountPath: /etc/kubernetes/audit-policy.yaml
      name: audit-policy
      readOnly: true
    - mountPath: /var/log/kubernetes/
      name: audit-log
  volumes:
  - hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
    name: audit-policy
  - hostPath:
      path: /var/log/kubernetes/
      type: DirectoryOrCreate
    name: audit-log
```

### Forwarding Kubernetes Audit Logs to SIEM

```yaml
# kubernetes-audit-filebeat.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat-audit
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: filebeat-audit
  template:
    metadata:
      labels:
        app: filebeat-audit
    spec:
      serviceAccountName: filebeat
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      containers:
      - name: filebeat
        image: elastic/filebeat:8.11.0
        args: ["-c", "/etc/filebeat.yml", "-e"]
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        volumeMounts:
        - name: config
          mountPath: /etc/filebeat.yml
          subPath: filebeat.yml
        - name: audit-log
          mountPath: /var/log/kubernetes/
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: filebeat-audit-config
      - name: audit-log
        hostPath:
          path: /var/log/kubernetes/
```

## Performance Optimization

### Reducing Audit Log Volume

Audit rules can generate enormous volumes of data. Use exclusion filters to reduce noise:

```bash
# /etc/audit/rules.d/90-exclusions.rules

# Exclude high-frequency, low-value events from specific processes
-a never,exit -F arch=b64 -S open -F exe=/usr/sbin/sshd
-a never,exit -F arch=b64 -S getattr -F exe=/usr/lib/systemd/systemd

# Exclude cron job executions (high frequency, usually not interesting)
-a never,exit -F arch=b64 -S execve -F auid=unset

# Exclude reads of common dynamic libraries
-a never,exit -F arch=b64 -S open -F dir=/usr/lib64
-a never,exit -F arch=b64 -S open -F dir=/usr/lib

# Exclude temp file access
-a never,exit -F arch=b64 -S open -F dir=/tmp -F uid=0
```

### Audit Backlog Tuning

```bash
# Increase the kernel audit backlog buffer
auditctl -b 32768

# Persist this in rules file
echo "-b 32768" > /etc/audit/rules.d/10-bufsize.rules

# Check for lost events
auditctl -s | grep lost
# If non-zero, increase backlog size

# Monitor audit performance
watch -n 5 'auditctl -s | grep -E "(backlog|lost)"'
```

### Selective High-Value Monitoring

For extremely high-throughput systems, focus on the highest-value events:

```bash
# /etc/audit/rules.d/95-high-value-only.rules

# CRITICAL: sudo use and su (privilege escalation)
-w /usr/bin/sudo -p x -k privileged
-w /usr/bin/su -p x -k privileged

# CRITICAL: SSH key modifications
-w /root/.ssh -p wa -k root_ssh
-a always,exit -F dir=/home -F name=.ssh -p wa -k user_ssh

# CRITICAL: Crontab modifications
-w /etc/crontab -p wa -k cron
-w /etc/cron.d -p wa -k cron
-w /var/spool/cron -p wa -k cron

# CRITICAL: User/group database changes
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/group -p wa -k identity
```

## Summary

The Linux Audit framework provides the most reliable and tamper-resistant audit trail available on Linux systems. Key production considerations:

- Start with the CIS Benchmark rule set as a baseline, then tune for your environment's volume characteristics
- Use `aureport` daily for quick anomaly detection and trend analysis
- Always include both b32 and b64 architecture variants for syscall rules
- Forward audit logs to an immutable external SIEM as quickly as possible
- Use the `-e 2` immutable flag in production to prevent rule modification without reboots
- Monitor the `lost` counter with Prometheus to detect audit buffer overflow conditions
- Integrate with Kubernetes audit logging for a complete picture of container workload activity
- Separate high-frequency exclusion rules from critical monitoring rules for maintainability
