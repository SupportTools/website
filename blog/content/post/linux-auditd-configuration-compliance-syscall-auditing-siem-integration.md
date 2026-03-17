---
title: "Linux auditd Configuration for Compliance: Syscall Auditing, Log Management, and SIEM Integration"
date: 2031-06-23T00:00:00-05:00
draft: false
tags: ["Linux", "auditd", "Security", "Compliance", "SIEM", "Auditing", "SOC2", "PCI-DSS"]
categories:
- Linux
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux auditd for enterprise compliance: rule design for PCI-DSS and CIS benchmarks, high-throughput log management with audisp, SIEM integration via Fluentd and Elasticsearch, and performance tuning."
more_link: "yes"
url: "/linux-auditd-configuration-compliance-syscall-auditing-siem-integration/"
---

The Linux Audit Framework (`auditd`) provides kernel-level visibility into system calls, file access, user authentication, and privilege escalation — the exact events that compliance frameworks like PCI-DSS, SOC 2, HIPAA, and CIS benchmarks require to be logged. Unlike application-level logging, auditd events cannot be suppressed by compromised user-space processes, making it the authoritative source for security investigations and compliance evidence.

This guide covers production auditd deployment: rule design for major compliance frameworks, handling high-volume audit log streams without data loss, audisp plugin configuration for structured output, and reliable forwarding to SIEM platforms including Elasticsearch and Splunk.

<!--more-->

# Linux auditd Configuration for Compliance: Syscall Auditing, Log Management, and SIEM Integration

## Architecture Overview

```
┌────────────────────────────────────────────────────┐
│                    Linux Kernel                     │
│                                                     │
│   System Calls ──► Audit Subsystem ──► Netlink     │
│                                         Socket      │
└───────────────────────────────────────────┬────────┘
                                            │
                                     ┌──────▼──────┐
                                     │   auditd    │
                                     │  (daemon)   │
                                     └──────┬──────┘
                                            │
                        ┌───────────────────┼─────────────────────┐
                        │                   │                     │
                 ┌──────▼──────┐   ┌────────▼───────┐   ┌────────▼───────┐
                 │/var/log/    │   │  audisp-remote │   │  audisp-syslog │
                 │audit/       │   │  (SIEM relay)  │   │  (syslog fwd)  │
                 │audit.log    │   └────────────────┘   └────────────────┘
                 └─────────────┘
```

## Installation and Basic Configuration

```bash
# Install
apt-get install -y auditd audispd-plugins   # Debian/Ubuntu
dnf install -y audit audit-libs            # RHEL/Rocky

# Enable and start
systemctl enable --now auditd

# Verify kernel audit support
cat /proc/self/status | grep -i cap
ausearch -ts today -m USER_AUTH | head -5
```

### Core Configuration File

```bash
# /etc/audit/auditd.conf
cat > /etc/audit/auditd.conf << 'EOF'
# Audit log settings
log_file = /var/log/audit/audit.log
log_format = ENRICHED         # Include human-readable names
log_group = root
priority_boost = 4
flush = INCREMENTAL_ASYNC
freq = 50                      # Flush every 50 records

# Log rotation
max_log_file = 256             # MB per log file
num_logs = 10                  # Keep 10 rotated files
max_log_file_action = ROTATE

# Disk space management
space_left = 500               # MB before warning
space_left_action = SYSLOG     # Log warning to syslog
admin_space_left = 100         # MB before critical action
admin_space_left_action = SUSPEND  # Stop auditing if disk critical
disk_full_action = SUSPEND
disk_error_action = SYSLOG

# Network (for audisp-remote)
tcp_listen_port = 60
tcp_listen_queue = 5
tcp_max_per_addr = 1
use_libwrap = yes

# Performance
write_logs = yes
name_format = HOSTNAME         # Include hostname in every record
name = production-server-01
EOF
```

## Audit Rule Design

Audit rules are processed in order, top to bottom. The rule evaluation engine is fast (kernel-level), but poorly designed rule sets can saturate the netlink socket.

### Rule Priority and Structure

```bash
# /etc/audit/rules.d/00-ruleset-structure.rules
# Rule order matters:
# 1. Delete existing rules (start clean)
# 2. Set buffer size
# 3. Failure mode
# 4. Exclude noisy, irrelevant events
# 5. Watch critical files
# 6. Monitor privileged operations
# 7. Monitor network activity
# 8. Lock rules (immutable)

# Buffer size (increase for high-throughput systems)
-b 32768

# Failure mode: 0=silent, 1=printk, 2=panic
-f 1

# Rate limit (events per second) — prevent DoS of audit subsystem
-r 1000
```

### CIS Level 2 / PCI-DSS Ruleset

```bash
# /etc/audit/rules.d/10-cis-level2.rules

##############################################
# 1. IDENTITY AND AUTHENTICATION
##############################################

# User and group management
-w /etc/group -p wa -k identity
-w /etc/passwd -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/security/opasswd -p wa -k identity
-w /etc/sudoers -p wa -k identity
-w /etc/sudoers.d/ -p wa -k identity

# SSH configuration changes
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/ssh/ -p wa -k sshd_config

# PAM configuration
-w /etc/pam.d/ -p wa -k pam

# Login and authentication events
-w /var/log/faillog -p wa -k logins
-w /var/log/lastlog -p wa -k logins
-w /var/run/faillock/ -p wa -k logins

# Logout events
-w /var/run/utmp -p wa -k session
-w /var/log/wtmp -p wa -k logins
-w /var/log/btmp -p wa -k logins

##############################################
# 2. PRIVILEGE ESCALATION
##############################################

# Sudo usage (all sudo invocations)
-w /usr/bin/sudo -p x -k sudo_usage
-w /usr/bin/su -p x -k priv_esc

# Setuid/setgid programs
-a always,exit -F arch=b64 -S setuid -F a0=0 -F exe=/usr/bin/su -k priv_esc
-a always,exit -F arch=b64 -S setresuid -F a0=0 -F exe=/usr/bin/sudo -k priv_esc
-a always,exit -F arch=b64 -S execve -C uid!=euid -F euid=0 -k setuid

##############################################
# 3. FILE AND DIRECTORY MONITORING
##############################################

# Audit configuration changes
-w /etc/audit/ -p wa -k audit_config
-w /etc/libaudit.conf -p wa -k audit_config
-w /etc/audisp/ -p wa -k audit_config

# System binaries modification
-w /bin/ -p wa -k system_binaries
-w /sbin/ -p wa -k system_binaries
-w /usr/bin/ -p wa -k system_binaries
-w /usr/sbin/ -p wa -k system_binaries
-w /usr/local/bin/ -p wa -k system_binaries
-w /usr/local/sbin/ -p wa -k system_binaries

# Library directories
-w /lib/ -p wa -k library_modification
-w /lib64/ -p wa -k library_modification
-w /usr/lib/ -p wa -k library_modification

# Kernel module changes
-w /etc/modprobe.conf -p wa -k modules
-w /etc/modprobe.d/ -p wa -k modules
-a always,exit -F arch=b64 -S init_module,finit_module -k kernel_modules
-a always,exit -F arch=b64 -S delete_module -k kernel_modules
-w /sbin/insmod -p x -k kernel_modules
-w /sbin/rmmod -p x -k kernel_modules
-w /sbin/modprobe -p x -k kernel_modules

# Network configuration
-w /etc/hosts -p wa -k network_config
-w /etc/resolv.conf -p wa -k network_config
-w /etc/sysconfig/network -p wa -k network_config
-w /etc/network/ -p wa -k network_config
-w /etc/netplan/ -p wa -k network_config

# Cron jobs
-w /etc/cron.allow -p wa -k cron
-w /etc/cron.deny -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /etc/cron.daily/ -p wa -k cron
-w /etc/cron.hourly/ -p wa -k cron
-w /etc/cron.monthly/ -p wa -k cron
-w /etc/cron.weekly/ -p wa -k cron
-w /etc/crontab -p wa -k cron
-w /var/spool/cron/ -p wa -k cron

# Systemd unit files
-w /etc/systemd/ -p wa -k systemd
-w /usr/lib/systemd/ -p wa -k systemd

##############################################
# 4. SYSTEM CALL AUDITING
##############################################

# File deletion by non-root users
-a always,exit -F arch=b64 -S unlink,unlinkat,rename,renameat -F auid>=1000 -F auid!=-1 -k delete
-a always,exit -F arch=b32 -S unlink,unlinkat,rename,renameat -F auid>=1000 -F auid!=-1 -k delete

# Unauthorized file access attempts
-a always,exit -F arch=b64 -S open,creat,truncate,ftruncate,openat -F exit=-EACCES -F auid>=1000 -F auid!=-1 -k access_denied
-a always,exit -F arch=b64 -S open,creat,truncate,ftruncate,openat -F exit=-EPERM -F auid>=1000 -F auid!=-1 -k access_denied
-a always,exit -F arch=b32 -S open,creat,truncate,ftruncate,openat -F exit=-EACCES -F auid>=1000 -F auid!=-1 -k access_denied

# Mount/unmount operations
-a always,exit -F arch=b64 -S mount,umount2 -k mounts
-a always,exit -F arch=b32 -S mount,umount2 -k mounts

# Process injection (ptrace)
-a always,exit -F arch=b64 -S ptrace -k process_injection
-a always,exit -F arch=b32 -S ptrace -k process_injection

# Socket creation and connections
-a always,exit -F arch=b64 -S socket -F a0=2 -k network_socket  # AF_INET
-a always,exit -F arch=b64 -S socket -F a0=10 -k network_socket # AF_INET6

# Setuid/setgid syscalls
-a always,exit -F arch=b64 -S setuid,setgid,setreuid,setregid -k setuid_setgid
-a always,exit -F arch=b64 -S setfsuid,setfsgid -k setuid_setgid

# Chown/chmod operations (potential UID/GID manipulation)
-a always,exit -F arch=b64 -S chown,fchown,lchown,fchownat -k chown
-a always,exit -F arch=b64 -S chmod,fchmod,fchmodat -k chmod

##############################################
# 5. NETWORK EVENTS
##############################################

# Network configuration changes
-a always,exit -F arch=b64 -S sethostname,setdomainname -k network_config_change
-w /etc/issue -p wa -k network_config_change
-w /etc/issue.net -p wa -k network_config_change

##############################################
# 6. IMMUTABLE RULE LOCK (MUST BE LAST)
##############################################
# -e 2  # Uncomment in production — requires reboot to change rules
```

### Container/Kubernetes Host Specific Rules

```bash
# /etc/audit/rules.d/20-containers.rules

# Container runtime socket access
-w /var/run/docker.sock -p rwxa -k docker_socket
-w /run/containerd/containerd.sock -p rwxa -k containerd_socket
-w /run/crio/crio.sock -p rwxa -k crio_socket

# Container escapes via nsenter/unshare
-w /usr/bin/nsenter -p x -k namespace_tools
-w /usr/bin/unshare -p x -k namespace_tools

# Namespace syscalls (container pivots)
-a always,exit -F arch=b64 -S unshare -k namespace_create
-a always,exit -F arch=b64 -S setns -k namespace_enter

# Pivot root (container escapes)
-a always,exit -F arch=b64 -S pivot_root -k container_escape

# Kubernetes config and secrets
-w /etc/kubernetes/ -p wa -k k8s_config
-w /var/lib/kubelet/ -p wa -k kubelet_config

# Container image downloads
-w /usr/bin/docker -p x -k container_runtime
-w /usr/bin/ctr -p x -k container_runtime
-w /usr/bin/crictl -p x -k container_runtime
```

### Reducing Noise with Exclusion Rules

```bash
# /etc/audit/rules.d/05-exclusions.rules
# Process these BEFORE the main rules to suppress noisy events

# Exclude high-frequency monitoring processes
-a never,exit -F arch=b64 -S open,openat -F exe=/usr/bin/prometheus-node-exporter
-a never,exit -F arch=b64 -S open,openat -F exe=/usr/bin/telegraf
-a never,exit -F arch=b64 -S open,openat -F exe=/usr/sbin/sshd -F dir=/proc

# Exclude regular user proc reads
-a never,exit -F arch=b64 -S open,read -F dir=/proc -F auid=4294967295

# Exclude compilers from binary watch (too noisy in dev environments)
# -a never,exit -F arch=b64 -S execve -F exe=/usr/bin/gcc
# (Only for non-production hosts)
```

## Loading and Validating Rules

```bash
# Load rules from /etc/audit/rules.d/
augenrules --load

# Verify loaded rules
auditctl -l | wc -l       # Count loaded rules
auditctl -l | head -20    # Show first 20 rules
auditctl -s               # Show audit subsystem status

# Test a specific rule
auditctl -l | grep identity

# Check for rule conflicts
augenrules --check

# Force reload without restart
service auditd reload

# Verify auditd is healthy
systemctl status auditd
auditctl -s | grep enabled
# enabled 1  (0=disabled, 1=enabled, 2=immutable/locked)
```

## Log Analysis with ausearch and aureport

```bash
# Search by key
ausearch -k identity --interpret | tail -30

# Search by time range
ausearch -ts "2031-06-20 00:00:00" -te "2031-06-20 23:59:59" -k sudo_usage

# Search by user
ausearch -ua alice --interpret | tail -20

# Search by syscall
ausearch -sc execve --interpret | grep -E "failed|FAILED" | tail -20

# All login failures today
ausearch -m USER_AUTH -ts today --success no --interpret

# Summary reports
aureport --summary                    # Overall summary
aureport -au                          # Authentication report
aureport --failed                     # Failed events
aureport --executable                 # Executable report
aureport --file                       # File access report
aureport -i --login --failed -ts this-week  # Failed logins this week

# Specific compliance reports
# PCI-DSS: All privileged actions
ausearch -k priv_esc -k sudo_usage --interpret | \
  awk '/type=SYSCALL/ {print $0}' | \
  grep -E "auid=[0-9]+" | \
  sort | uniq -c | sort -rn
```

## audisp Configuration for Structured Output

The `audisp` (Audit Dispatcher) plugins transform raw audit records into structured formats for forwarding:

```bash
# /etc/audit/plugins.d/syslog.conf
cat > /etc/audit/plugins.d/syslog.conf << 'EOF'
active = yes
direction = out
path = builtin_syslog
type = builtin
args = LOG_INFO LOG_LOCAL6
format = string
EOF

# Restart auditd to activate plugin
systemctl restart auditd

# Verify syslog output
journalctl -f | grep audit
```

### audisp-json for Structured JSON Output

```bash
# Install audisp-json (converts to JSON for SIEM ingest)
# Available via GitHub: linux-audit/audisp-json
apt-get install -y audisp-json  # or compile from source

# /etc/audit/plugins.d/audisp-json.conf
cat > /etc/audit/plugins.d/audisp-json.conf << 'EOF'
active = yes
direction = out
path = /usr/lib/audisp/audisp-json
type = always
args = /var/log/audit/audit.json
format = string
EOF

systemctl restart auditd
tail -f /var/log/audit/audit.json | python3 -m json.tool | head -50
```

## SIEM Integration

### Fluentd/Fluent Bit to Elasticsearch

```yaml
# fluent-bit-audit.conf
[SERVICE]
    Flush         5
    Daemon        Off
    Log_Level     info
    storage.path  /var/lib/fluent-bit/audit/

[INPUT]
    Name          tail
    Tag           audit.linux
    Path          /var/log/audit/audit.log
    DB            /var/lib/fluent-bit/audit/tail.db
    Parser        audit
    Mem_Buf_Limit 50MB
    Buffer_Chunk_Size 1MB
    Buffer_Max_Size   10MB
    Rotate_Wait   5
    Skip_Long_Lines Off

[FILTER]
    Name          lua
    Match         audit.*
    Script        /etc/fluent-bit/audit_enrich.lua
    Call          enrich_audit

[OUTPUT]
    Name          es
    Match         audit.*
    Host          elasticsearch.monitoring.svc.cluster.local
    Port          9200
    TLS           On
    TLS.Verify    On
    HTTP_User     fluent-bit
    HTTP_Passwd   ${ELASTICSEARCH_PASSWORD}
    Index         audit-linux
    Logstash_Format On
    Logstash_Prefix audit
    Logstash_DateFormat %Y.%m.%d
    Retry_Limit   5
    Buffer_Size   10MB
    Compress      gzip
    Replace_Dots  On
    Trace_Error   Off
```

```lua
-- /etc/fluent-bit/audit_enrich.lua
function enrich_audit(tag, timestamp, record)
    -- Parse hostname from audit record
    local hostname = record["hostname"] or record["node"]
    if hostname then
        record["host"] = {["name"] = hostname}
    end

    -- Classify event severity
    local event_type = record["type"] or ""
    if event_type:match("SYSCALL") then
        local syscall = record["syscall"] or ""
        local exit = tonumber(record["exit"] or "0")
        if exit and exit < 0 then
            record["event"] = {["category"] = "process", ["outcome"] = "failure"}
        else
            record["event"] = {["category"] = "process", ["outcome"] = "success"}
        end
    elseif event_type:match("USER_AUTH") then
        record["event"] = {["category"] = "authentication"}
    elseif event_type:match("USER_MGMT") or event_type:match("GRP_MGMT") then
        record["event"] = {["category"] = "iam"}
    end

    -- Normalize UID to user.id (ECS)
    if record["uid"] then
        record["user"] = record["user"] or {}
        record["user"]["id"] = record["uid"]
    end
    if record["auid"] then
        record["user"] = record["user"] or {}
        record["user"]["audit"] = {["id"] = record["auid"]}
    end

    return 1, timestamp, record
end
```

### Filebeat to Elasticsearch (Elastic Stack)

```yaml
# /etc/filebeat/modules.d/auditd.yml
- module: auditd
  log:
    enabled: true
    var.paths:
      - /var/log/audit/audit.log
    var.preserve_original_event: true
    var.tags:
      - production
      - compliance
```

```yaml
# /etc/filebeat/filebeat.yml
filebeat.config.modules:
  path: ${path.config}/modules.d/*.yml
  reload.enabled: false

processors:
  - add_host_metadata:
      when.not.contains.tags: forwarded
  - add_cloud_metadata: ~
  - add_docker_metadata: ~
  - add_kubernetes_metadata:
      host: ${NODE_NAME}
      matchers:
        - logs_path:
            logs_path: "/var/log/containers/"

output.elasticsearch:
  hosts: ["https://elasticsearch:9200"]
  username: "filebeat_writer"
  password: "${ELASTICSEARCH_PASSWORD}"
  ssl.certificate_authorities: ["/etc/filebeat/ca.crt"]
  indices:
    - index: "auditd-%{[agent.version]}-%{+yyyy.MM.dd}"
      when.contains:
        event.module: "auditd"

setup.ilm.enabled: true
setup.ilm.rollover_max_size: "30gb"
setup.ilm.rollover_max_age: "7d"
```

### Splunk Universal Forwarder

```ini
# /opt/splunkforwarder/etc/system/local/inputs.conf
[monitor:///var/log/audit/audit.log]
index = linux_audit
sourcetype = linux:audit
host_segment = 3
crcSalt = <SOURCE>
whitelist = \.log$

# For JSON output from audisp-json
[monitor:///var/log/audit/audit.json]
index = linux_audit
sourcetype = _json
host_segment = 3
```

```ini
# /opt/splunkforwarder/etc/system/local/props.conf
[linux:audit]
MAX_TIMESTAMP_LOOKAHEAD = 50
TIME_FORMAT = %s.%9N
TRANSFORMS-set-index = auditd_index_routing

# Parse audit records into fields
REPORT-auditd = auditd_kv_pairs

[auditd_kv_pairs]
MV_ADD = true
REGEX = (\w+)=("[^"]*"|\S+)
FORMAT = $1::$2
```

## Performance Tuning

### Buffer Sizing

The kernel audit buffer (`-b`) is the most critical parameter for preventing audit log loss:

```bash
# Check for dropped events
auditctl -s | grep -E "lost|backlog"
# backlog 0           — current queue depth
# lost 0              — total events dropped since boot

# If lost > 0, increase buffer
# Default: -b 8192; increase for high-syscall workloads
auditctl -b 65536

# Make permanent
echo "-b 65536" > /etc/audit/rules.d/00-buffer.rules
augenrules --load
```

### Selective Syscall Auditing

Auditing every syscall creates massive volume. Be precise:

```bash
# BAD: audit all file opens (extremely high volume)
-a always,exit -F arch=b64 -S open

# GOOD: audit opens by specific user group that failed
-a always,exit -F arch=b64 -S open -F auid>=1000 -F exit=-EACCES -k access_denied

# GOOD: audit opens in specific sensitive directory
-a always,exit -F arch=b64 -S open,openat -F dir=/etc/ssl/private -k ssl_access
```

### Reducing auditd CPU Impact

```bash
# Check auditd CPU usage
pidstat -u -p $(pgrep auditd) 5

# If high, check which rules generate most events
# Add -c flag to ausearch for count
ausearch -ts this-hour -k identity | wc -l
ausearch -ts this-hour -k delete | wc -l
ausearch -ts this-hour -k access_denied | wc -l

# For very noisy rules, add rate limiting by key
# (Not native auditd, but filter at Fluentd/Filebeat level)
```

## Compliance Reporting

### Generating PCI-DSS Evidence

```bash
#!/bin/bash
# pci-audit-report.sh — Generate daily PCI-DSS audit evidence

DATE=$(date +%Y-%m-%d)
REPORT_DIR="/var/reports/pci-dss"
mkdir -p "${REPORT_DIR}"

echo "=== PCI-DSS Daily Audit Report: ${DATE} ===" > "${REPORT_DIR}/report-${DATE}.txt"

echo -e "\n--- Requirement 8.3: Authentication Events ---" >> "${REPORT_DIR}/report-${DATE}.txt"
ausearch -m USER_AUTH,USER_LOGIN -ts "${DATE} 00:00:00" -te "${DATE} 23:59:59" \
  --interpret 2>/dev/null | \
  awk '/type=USER_AUTH/ || /type=USER_LOGIN/ {print}' >> "${REPORT_DIR}/report-${DATE}.txt"

echo -e "\n--- Requirement 10.2: Privileged Operations ---" >> "${REPORT_DIR}/report-${DATE}.txt"
ausearch -k sudo_usage,priv_esc -ts "${DATE} 00:00:00" -te "${DATE} 23:59:59" \
  --interpret 2>/dev/null >> "${REPORT_DIR}/report-${DATE}.txt"

echo -e "\n--- Requirement 10.3: File Integrity Events ---" >> "${REPORT_DIR}/report-${DATE}.txt"
ausearch -k identity,system_binaries -ts "${DATE} 00:00:00" -te "${DATE} 23:59:59" \
  --interpret 2>/dev/null >> "${REPORT_DIR}/report-${DATE}.txt"

echo -e "\n--- Failed Access Attempts ---" >> "${REPORT_DIR}/report-${DATE}.txt"
ausearch -k access_denied -ts "${DATE} 00:00:00" -te "${DATE} 23:59:59" \
  --interpret 2>/dev/null | head -100 >> "${REPORT_DIR}/report-${DATE}.txt"

echo "Report generated: ${REPORT_DIR}/report-${DATE}.txt"
```

### Elasticsearch Kibana Query Examples

```json
// All sudo executions today
{
  "query": {
    "bool": {
      "must": [
        {"term": {"event.dataset": "auditd.log"}},
        {"term": {"tags": "k:sudo_usage"}},
        {"range": {"@timestamp": {"gte": "now/d"}}}
      ]
    }
  },
  "sort": [{"@timestamp": {"order": "desc"}}]
}
```

```json
// User account modifications in last 7 days
{
  "query": {
    "bool": {
      "must": [
        {"term": {"event.dataset": "auditd.log"}},
        {"terms": {"auditd.log.record_type": ["ADD_USER", "DEL_USER", "ADD_GROUP"]}},
        {"range": {"@timestamp": {"gte": "now-7d"}}}
      ]
    }
  }
}
```

## Incident Response with auditd

### Tracing a Suspicious Process

```bash
# Investigate a suspicious binary execution
ausearch -x /tmp/suspicious_binary --interpret

# Trace all activity from a specific session
# First: get the session ID from an alert
SESSION_ID=42
ausearch -i -se "${SESSION_ID}" | aureport --interpret

# Find all files accessed by a compromised user
ausearch -ua compromised_user -ts "2031-06-20 08:00:00" --interpret | \
  grep "type=SYSCALL" | \
  grep -E "open|creat|read|write" | \
  awk '{print $NF}' | sort | uniq
```

### Preserving Evidence

```bash
# Before investigation, preserve current logs
mkdir -p /forensics/audit-$(date +%Y%m%d)
cp /var/log/audit/audit.log* /forensics/audit-$(date +%Y%m%d)/

# Create tamper-evident hash
sha256sum /forensics/audit-$(date +%Y%m%d)/audit.log* > \
  /forensics/audit-$(date +%Y%m%d)/SHA256SUMS

# Export relevant events to a self-contained report
ausearch -ts "2031-06-20 00:00:00" -te "2031-06-20 23:59:59" \
  --raw > /forensics/audit-$(date +%Y%m%d)/raw-events.log
```

## Kubernetes DaemonSet Deployment

For Kubernetes nodes, deploy auditd configuration via DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: auditd-configurator
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: auditd-configurator
  template:
    metadata:
      labels:
        app: auditd-configurator
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists   # Run on all nodes including masters
      containers:
        - name: configurator
          image: your-registry/auditd-config:latest
          securityContext:
            privileged: true
          volumeMounts:
            - name: audit-rules
              mountPath: /etc/audit/rules.d
            - name: auditd-conf
              mountPath: /etc/audit/auditd.conf
              subPath: auditd.conf
          command:
            - /bin/sh
            - -c
            - |
              # Reload audit rules
              augenrules --load
              auditctl -e 1
              # Keep container running
              tail -f /dev/null
      volumes:
        - name: audit-rules
          configMap:
            name: audit-rules
        - name: auditd-conf
          configMap:
            name: auditd-conf
      terminationGracePeriodSeconds: 5
```

Linux auditd, when properly configured with targeted rules, enriched output plugins, and reliable SIEM forwarding, provides the audit trail that compliance auditors require and security teams depend on for incident investigation. The key operational principles are: prefer targeted syscall rules over broad watches, tune the kernel buffer to prevent event drops, use audisp plugins for structured output, and monitor the audit subsystem health metrics as diligently as the events it produces.
