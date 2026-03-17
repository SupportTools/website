---
title: "Linux Audit Framework: auditd Rules, Syscall Monitoring, and SIEM Integration"
date: 2029-12-23T00:00:00-05:00
draft: false
tags: ["Linux", "Audit", "auditd", "Security", "SIEM", "Compliance", "Syscall", "File Integrity", "Elasticsearch"]
categories:
- Linux
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into auditd configuration, syscall auditing rules, file integrity monitoring, ausearch and aureport analysis tools, and shipping audit logs to Elasticsearch for SIEM correlation."
more_link: "yes"
url: "/linux-audit-framework-auditd-syscall-monitoring-siem-integration/"
---

The Linux Audit Framework is the kernel's built-in security event logging subsystem. Unlike application-level logging, audit events are generated at the system call boundary — before any user-space process can suppress or modify them. This makes auditd the authoritative source for file access events, privilege escalations, network connections, and authentication activities, forming the foundation of compliance frameworks like PCI DSS, HIPAA, and SOC 2. This guide covers auditd installation, rule authoring, performance tuning, and forwarding audit events to Elasticsearch for SIEM correlation.

<!--more-->

## Audit Framework Architecture

The Linux audit framework consists of three components:

1. **Kernel audit subsystem**: Intercepts system calls and generates audit records based on configured rules
2. **auditd daemon**: User-space daemon that receives records from the kernel via a netlink socket and writes them to `/var/log/audit/audit.log`
3. **audispd/audisp-plugins**: Plugin dispatcher that can forward records to additional destinations (syslog, remote servers, custom scripts)

Audit records flow: `kernel syscall hook → netlink socket → auditd → audit.log → audisp plugins → SIEM`

## Installation and Service Configuration

```bash
# Install on RHEL/Rocky/AlmaLinux
sudo dnf install -y audit audit-libs

# Install on Ubuntu/Debian
sudo apt-get install -y auditd audispd-plugins

# Enable and start
sudo systemctl enable --now auditd

# Verify kernel audit support
sudo auditctl -s
# Output includes: enabled 1, pid (auditd pid), rate_limit, backlog_limit, lost, backlog

# Check current rules
sudo auditctl -l
```

### auditd.conf Tuning

```ini
# /etc/audit/auditd.conf
log_file = /var/log/audit/audit.log
log_format = ENRICHED
log_group = root
priority_boost = 4
# How many records to buffer before writing
freq = 50
# Retain up to 5 log files of 50 MB each
num_logs = 5
name_format = hostname
max_log_file = 50
# Rotate when file reaches max_log_file
max_log_file_action = ROTATE
# What to do when disk is nearly full (SYSLOG, SUSPEND, ROTATE, KEEP_LOGS)
space_left = 75
space_left_action = SYSLOG
# What to do when disk is full (SUSPEND = stop logging, ROTATE, HALT)
admin_space_left = 50
admin_space_left_action = SUSPEND
disk_full_action = SUSPEND
disk_error_action = SYSLOG
# Increase kernel backlog to prevent dropped events during bursts
tcp_listen_queue = 5
# Log format (NOLOG, INCREMENTAL_ASYNC, INCREMENTAL, DATA, SYNC)
write_logs = yes
overflow_action = SYSLOG
```

## Rule Writing

### Rule Syntax

```bash
# Basic rule syntax:
# -a <action>,<list> -S <syscall> [-F <field>=<value>] -k <key>
#
# action: always | never
# list:   task | exit | user | exclude
#
# -w <path> -p <permissions> -k <key>
# permissions: r=read, w=write, x=execute, a=attribute change
```

### Essential Audit Rule Set

```bash
# /etc/audit/rules.d/audit.rules

# Delete all existing rules on load
-D

# Set buffer size (increase if events are being lost)
-b 8192

# Failure mode: 0=silent, 1=printk, 2=panic
-f 1

# ============================================================
# Identity and Authentication
# ============================================================

# Monitor /etc/passwd, /etc/shadow, /etc/group changes
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/security/opasswd -p wa -k identity

# Sudoers changes
-w /etc/sudoers -p wa -k sudo_changes
-w /etc/sudoers.d/ -p wa -k sudo_changes

# SSH configuration
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/ssh/ssh_config -p wa -k ssh_config

# PAM configuration
-w /etc/pam.d/ -p wa -k pam_config
-w /etc/security/ -p wa -k pam_config

# ============================================================
# Privileged Command Execution
# ============================================================

# Monitor use of su and sudo
-w /bin/su -p x -k privileged_commands
-w /usr/bin/sudo -p x -k privileged_commands
-w /usr/bin/sudoedit -p x -k privileged_commands

# newgrp and sg for group changes
-w /usr/bin/newgrp -p x -k privileged_commands
-w /usr/bin/sg -p x -k privileged_commands

# passwd and chage for password changes
-w /usr/bin/passwd -p x -k privileged_commands
-w /usr/bin/chage -p x -k privileged_commands

# usermod, useradd, userdel for account management
-w /usr/sbin/usermod -p x -k account_management
-w /usr/sbin/useradd -p x -k account_management
-w /usr/sbin/userdel -p x -k account_management
-w /usr/sbin/groupadd -p x -k account_management
-w /usr/sbin/groupdel -p x -k account_management
-w /usr/sbin/groupmod -p x -k account_management

# ============================================================
# System Calls: Privilege Escalation
# ============================================================

# Monitor setuid/setgid syscalls
-a always,exit -F arch=b64 -S setuid -S setgid -S setreuid -S setregid \
    -F auid>=1000 -F auid!=4294967295 -k privilege_escalation

# Monitor capset (capability modification)
-a always,exit -F arch=b64 -S capset -k capability_changes

# ptrace (used by debuggers and injection attacks)
-a always,exit -F arch=b64 -S ptrace -k process_injection

# ============================================================
# System Calls: File and Directory Operations
# ============================================================

# Unauthorized file access (permission denied)
-a always,exit -F arch=b64 -S open -S openat -F exit=-EACCES \
    -F auid>=1000 -k unauthorized_access
-a always,exit -F arch=b64 -S open -S openat -F exit=-EPERM \
    -F auid>=1000 -k unauthorized_access

# File deletion
-a always,exit -F arch=b64 -S unlink -S unlinkat -S rename -S renameat \
    -F auid>=1000 -k file_deletion

# chmod/chown changes on sensitive directories
-a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat \
    -F auid>=1000 -k permission_changes
-a always,exit -F arch=b64 -S chown -S fchown -S fchownat -S lchown \
    -F auid>=1000 -k ownership_changes

# ============================================================
# System Calls: Network
# ============================================================

# Monitor socket creation and binding
-a always,exit -F arch=b64 -S socket -F a0=2 -k network_socket_create
-a always,exit -F arch=b64 -S bind -k network_bind
-a always,exit -F arch=b64 -S connect -k network_connect

# ============================================================
# System Calls: Kernel Module Loading
# ============================================================

-a always,exit -F arch=b64 -S init_module -S finit_module -k kernel_modules
-a always,exit -F arch=b64 -S delete_module -k kernel_modules

# ============================================================
# System Calls: Process Execution
# ============================================================

# execve (every program execution)
-a always,exit -F arch=b64 -S execve -F auid>=1000 -F auid!=4294967295 \
    -k process_execution

# execveat
-a always,exit -F arch=b64 -S execveat -F auid>=1000 \
    -k process_execution

# ============================================================
# Audit Log File Integrity
# ============================================================

# Prevent modification of audit logs and rules
-w /var/log/audit/ -p wxa -k audit_log_access
-w /etc/audit/ -p wa -k audit_config
-w /sbin/auditctl -p x -k audit_tools
-w /sbin/auditd -p x -k audit_tools

# ============================================================
# CIS Benchmark Additions
# ============================================================

# Time synchronization
-a always,exit -F arch=b64 -S adjtimex -S settimeofday \
    -k time_change
-a always,exit -F arch=b64 -S clock_settime -k time_change
-w /etc/localtime -p wa -k localtime_change

# System locale
-w /etc/locale.conf -p wa -k locale_change
-w /etc/sysconfig/i18n -p wa -k locale_change

# Make the configuration immutable (comment out to allow rule changes without reboot)
# -e 2
```

Load the rules:

```bash
sudo augenrules --load
# Or load specific file:
sudo auditctl -R /etc/audit/rules.d/audit.rules

# Verify rules are loaded
sudo auditctl -l | wc -l
```

## Searching and Analyzing Audit Logs

### ausearch

```bash
# Search by key (matches -k in rules)
sudo ausearch -k identity --start today

# Search by event type
sudo ausearch -m USER_LOGIN --start yesterday --end today

# Search for failed login attempts
sudo ausearch -m USER_FAILED_LOGIN --start recent

# Search by user ID
sudo ausearch -ui 1001 --start today

# Search by process name
sudo ausearch -c passwd --start today

# Output as interpreted text (easier to read)
sudo ausearch -k privilege_escalation --interpret

# Output as JSON for processing
sudo ausearch -k process_execution --start today -l -i \
  | ausearch --format json
```

### aureport

```bash
# Summary report of all events
sudo aureport --summary

# Authentication report
sudo aureport -au --start today

# Authorization (sudo) report
sudo aureport -m --start today | head -50

# Anomaly report (system calls that generated errors)
sudo aureport -a --start today

# Executable report (most-executed programs)
sudo aureport -x --summary --start today

# File access report
sudo aureport -f --start today

# Account modification report
sudo aureport -tm --start today

# Login report with failures
sudo aureport -l --start today --failed
```

### Parsing Audit Events in Go

```go
// internal/audit/parser.go
package audit

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// AuditEvent represents a parsed audit log record
type AuditEvent struct {
	Type      string
	Timestamp time.Time
	Serial    string
	Fields    map[string]string
	Key       string
}

var auditLineRe = regexp.MustCompile(
	`^type=(\S+) msg=audit\((\d+\.\d+):(\d+)\): (.*)$`,
)

var fieldRe = regexp.MustCompile(`(\w+)=("[^"]*"|\S+)`)

func ParseAuditLog(path string) ([]*AuditEvent, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var events []*AuditEvent
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		event, err := parseAuditLine(line)
		if err != nil {
			continue
		}
		events = append(events, event)
	}
	return events, scanner.Err()
}

func parseAuditLine(line string) (*AuditEvent, error) {
	m := auditLineRe.FindStringSubmatch(line)
	if m == nil {
		return nil, fmt.Errorf("no match: %q", line)
	}

	event := &AuditEvent{
		Type:   m[1],
		Serial: m[3],
		Fields: make(map[string]string),
	}

	// Parse timestamp (seconds.milliseconds since epoch)
	var ts float64
	fmt.Sscanf(m[2], "%f", &ts)
	sec := int64(ts)
	nsec := int64((ts - float64(sec)) * 1e9)
	event.Timestamp = time.Unix(sec, nsec)

	// Parse key=value pairs
	for _, kv := range fieldRe.FindAllStringSubmatch(m[4], -1) {
		val := strings.Trim(kv[2], `"`)
		event.Fields[kv[1]] = val
		if kv[1] == "key" {
			event.Key = val
		}
	}

	return event, nil
}
```

## Shipping Audit Logs to Elasticsearch

### audisp-remote Plugin

```ini
# /etc/audisp/plugins.d/au-remote.conf
active = yes
direction = out
path = /sbin/audisp-remote
type = always
args = <remote-syslog-server-ip>
format = string
```

### Fluent Bit Pipeline to Elasticsearch

```ini
# /etc/fluent-bit/fluent-bit.conf
[SERVICE]
    flush        5
    daemon       off
    log_level    warn
    parsers_file parsers.conf

[INPUT]
    name        tail
    tag         audit.linux
    path        /var/log/audit/audit.log
    parser      audit_log
    db          /var/lib/fluent-bit/audit.db
    refresh_interval 5

[FILTER]
    name  modify
    match audit.linux
    Add   hostname ${HOSTNAME}
    Add   environment production

[FILTER]
    name   grep
    match  audit.linux
    # Only forward events with known keys (drop noisy/unkeyed events)
    Regex  key .+

[OUTPUT]
    name            es
    match           audit.linux
    host            elasticsearch.internal.example.com
    port            9200
    tls             on
    tls.verify      on
    http_user       audit-shipper
    http_passwd     ${ELASTICSEARCH_PASSWORD}
    index           audit-linux-%Y.%m
    type            _doc
    suppress_type_name on
    retry_limit     5
```

Fluent Bit audit log parser:

```ini
# /etc/fluent-bit/parsers.conf
[PARSER]
    name        audit_log
    format      regex
    regex       ^type=(?<type>\S+) msg=audit\((?<timestamp>[^)]+)\): (?<message>.*)$
    time_key    timestamp
    time_format %s.%L
```

### Elasticsearch Index Template

```json
{
  "index_patterns": ["audit-linux-*"],
  "template": {
    "settings": {
      "number_of_shards": 2,
      "number_of_replicas": 1,
      "index.lifecycle.name": "audit-logs-policy",
      "index.lifecycle.rollover_alias": "audit-linux"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "type": { "type": "keyword" },
        "hostname": { "type": "keyword" },
        "environment": { "type": "keyword" },
        "key": { "type": "keyword" },
        "uid": { "type": "keyword" },
        "auid": { "type": "keyword" },
        "pid": { "type": "integer" },
        "comm": { "type": "keyword" },
        "exe": { "type": "keyword" },
        "syscall": { "type": "keyword" },
        "success": { "type": "keyword" },
        "exit": { "type": "integer" },
        "name": { "type": "keyword" },
        "message": { "type": "text" }
      }
    }
  }
}
```

## SIEM Correlation Rules

### Kibana Detection Rule: Privilege Escalation

```json
{
  "name": "Linux Privilege Escalation via setuid Syscall",
  "description": "Detects when a non-privileged user invokes setuid-related syscalls, which may indicate privilege escalation attempts.",
  "type": "eql",
  "language": "eql",
  "query": "sequence by hostname, pid with maxspan=30s\n  [process where key : \"privilege_escalation\" and auid >= \"1000\"]\n  [process where type : \"SYSCALL\" and syscall : (\"setuid\", \"setreuid\") and success : \"yes\"]",
  "severity": "high",
  "risk_score": 73,
  "enabled": true,
  "interval": "5m",
  "from": "now-6m",
  "tags": ["Linux", "Privilege Escalation", "T1548"]
}
```

### Wazuh Rule for auditd

```xml
<!-- /var/ossec/etc/rules/local_rules.xml -->
<group name="linux,audit,">

  <!-- Identity changes -->
  <rule id="100001" level="10">
    <if_sid>80700</if_sid>
    <field name="audit.key">identity</field>
    <description>Linux audit: user account or group database modified</description>
    <mitre>
      <id>T1136</id>
    </mitre>
    <group>authentication,account_changes</group>
  </rule>

  <!-- sudo usage -->
  <rule id="100002" level="6">
    <if_sid>80700</if_sid>
    <field name="audit.key">privileged_commands</field>
    <description>Linux audit: privileged command executed via sudo</description>
    <group>privilege_escalation</group>
  </rule>

  <!-- Kernel module loading -->
  <rule id="100003" level="14">
    <if_sid>80700</if_sid>
    <field name="audit.key">kernel_modules</field>
    <description>Linux audit: kernel module loaded or unloaded</description>
    <mitre>
      <id>T1547.006</id>
    </mitre>
    <group>rootkit_detection</group>
  </rule>

</group>
```

## Performance Tuning

High-volume syscall auditing can generate thousands of events per second on busy systems. Tune the configuration to prevent log loss without overwhelming the system:

```bash
# Increase kernel audit backlog
sudo auditctl -b 16384

# Check for lost events
sudo auditctl -s | grep lost
# If lost > 0, increase backlog or reduce rule scope

# Monitor auditd performance
sudo systemctl status auditd
journalctl -u auditd --since "1 hour ago" | grep -i "lost\|dropped"

# For high-traffic systems, limit execve logging to specific users or paths
# Instead of:
# -a always,exit -F arch=b64 -S execve -F auid>=1000 -k process_execution

# Use more targeted rules:
# -a always,exit -F arch=b64 -S execve -F auid>=1000 -F auid!=4294967295 \
#     -F path!=/usr/bin/python3 -k process_execution
```

### Excluding Noisy Processes

```bash
# /etc/audit/rules.d/exclusions.rules
# Exclude health check agent from generating noise
-a never,exit -F arch=b64 -F uid=prometheus -S all
-a never,exit -F arch=b64 -F exe=/usr/bin/node_exporter -S all

# Exclude container runtime processes (reduces noise from Kubernetes)
-a never,exit -F arch=b64 -F exe=/usr/bin/containerd -S all
-a never,exit -F arch=b64 -F exe=/usr/bin/runc -S all
```

## Summary

The Linux Audit Framework provides kernel-level, tamper-evident event logging that is foundational to PCI DSS Section 10, HIPAA audit controls, and SOC 2 availability/security criteria. Well-crafted auditd rules capture the events that matter — identity changes, privilege escalations, unauthorized file access, module loading, and process execution — without overwhelming the system with noise. The ausearch/aureport toolchain makes rapid investigation practical at the command line. Shipping structured audit events to Elasticsearch via Fluent Bit enables SIEM correlation rules that surface attack patterns across a fleet of Linux hosts in near real-time.
