---
title: "Linux Audit Subsystem: Real-Time Security Monitoring with auditd and go-audit"
date: 2031-04-12T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Auditd", "Monitoring", "SIEM", "Kubernetes", "Go"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to the Linux audit subsystem covering auditd rule configuration, syscall and file access monitoring, go-audit for high-performance log processing, shipping to Elasticsearch and Splunk, and correlation with Kubernetes audit logs for enterprise security operations."
more_link: "yes"
url: "/linux-audit-subsystem-auditd-go-audit-security-monitoring/"
---

The Linux audit subsystem provides a kernel-level mechanism for recording security-relevant events with cryptographic integrity guarantees. When properly configured, it forms the foundation of a SOC's detection capability, feeding SIEM platforms with the raw events needed to detect privilege escalation, lateral movement, and data exfiltration. This guide covers auditd rule authoring, high-performance log processing with go-audit, shipping pipelines to Elasticsearch and Splunk, and correlating Linux audit events with Kubernetes audit logs.

<!--more-->

# Linux Audit Subsystem: Real-Time Security Monitoring with auditd and go-audit

## Section 1: Architecture and Components

The Linux audit system consists of several interoperating components:

```
┌─────────────────────────────────────────────────────────────┐
│                       Linux Kernel                          │
│                                                             │
│  ┌──────────────┐     ┌──────────────┐    ┌─────────────┐  │
│  │  Syscall     │────▶│  Audit       │───▶│ Audit       │  │
│  │  Intercept   │     │  Filter      │    │ Netlink     │  │
│  └──────────────┘     │  Engine      │    │ Socket      │  │
│                       └──────────────┘    └─────────────┘  │
└──────────────────────────────────────────────┬──────────────┘
                                               │ AF_NETLINK
                          ┌────────────────────┴────────────────────┐
                          │                                          │
                   ┌──────┴──────┐                           ┌──────┴──────┐
                   │   auditd    │                           │  go-audit   │
                   │  (userspace)│                           │  (userspace)│
                   │  - Rules    │                           │  - Fast     │
                   │  - Dispatch │                           │  - JSON out │
                   │  - Rotate   │                           │  - Filter   │
                   └──────┬──────┘                           └──────┬──────┘
                          │                                          │
                   ┌──────┴──────┐                                  │
                   │  audisp     │                                   │
                   │  Dispatcher │                                   │
                   │  Plugins    │                                   │
                   └──────┬──────┘                                   │
                          └────────────────┬───────────────────────┘
                                           │
                              ┌────────────▼────────────┐
                              │    Log Shipper           │
                              │  (Filebeat/Logstash/     │
                              │   Fluent Bit)            │
                              └────────────┬────────────┘
                                           │
                         ┌─────────────────┼──────────────────┐
                         ▼                 ▼                  ▼
                    ┌─────────┐      ┌──────────┐      ┌──────────┐
                    │  SIEM   │      │  Elastic │      │  Splunk  │
                    │  Rules  │      │  Stack   │      │  HEC     │
                    └─────────┘      └──────────┘      └──────────┘
```

### Audit Components

- **Kernel audit subsystem**: Hooks into system calls and file system events, applies filter rules, writes records to a netlink socket
- **auditd**: Userspace daemon that reads from netlink socket, applies rate limiting, writes to disk, and dispatches to plugins
- **auditctl**: CLI for managing rules and querying status
- **go-audit**: High-performance alternative to auditd written in Go, reads directly from netlink

## Section 2: Installing and Configuring auditd

```bash
# Install on RHEL/CentOS/Rocky
sudo dnf install -y audit audit-libs

# Install on Ubuntu/Debian
sudo apt-get install -y auditd audispd-plugins

# Enable and start
sudo systemctl enable --now auditd

# Verify kernel audit support
cat /proc/sys/kernel/audit

# Check audit system status
sudo auditctl -s
# enabled 1
# failure 1
# pid 1234
# rate_limit 0
# backlog_limit 8192
# lost 0
# backlog 0
# backlog_wait_time 15000
# loginuid_immutable 0 unlocked
```

### Main Configuration: /etc/audit/auditd.conf

```ini
# /etc/audit/auditd.conf
# Production-hardened configuration

log_file = /var/log/audit/audit.log
log_group = root
log_format = ENRICHED
flush = INCREMENTAL_ASYNC
freq = 50
max_log_file = 128          # MB per log file
num_logs = 10               # Keep 10 rotated files = 1.28GB total
priority_boost = 4
disp_qos = lossy
dispatcher = /sbin/audispd
name_format = HOSTNAME
name = my-server-01

# CRITICAL: What to do when disk is full
# halt: stop the system (most secure, prevents audit gaps)
# syslog: log warning and continue (less secure but available)
# rotate: rotate logs and continue
max_log_file_action = ROTATE

# When disk space is low
space_left = 512            # MB remaining before action
space_left_action = SYSLOG  # Log warning
admin_space_left = 64       # MB remaining before emergency action
admin_space_left_action = HALT  # Halt system

# Disk error handling
disk_full_action = SUSPEND
disk_error_action = SUSPEND

# TCP syslog receiver (for centralized collection)
tcp_listen_port = 60
tcp_listen_queue = 5
tcp_max_per_addr = 1
tcp_client_max_idle = 0
enable_krb5 = no

# Performance
write_logs = yes
tcp_wrappers = no
```

## Section 3: Writing Production Audit Rules

Audit rules are evaluated top-to-bottom and first match wins. Structure rules for performance by placing high-frequency exclusions early.

### /etc/audit/rules.d/00-base.rules

```bash
## /etc/audit/rules.d/00-base.rules
## Foundation rules - applied first

# Clear existing rules
-D

# Set buffer size - increase for high-load systems
# Each audit record is ~256 bytes; buffer = peak_events_per_second * max_latency
-b 32768

# Failure mode: 0=silent, 1=printk, 2=panic
# Use 1 in production to avoid service disruption
-f 1

# Rate limit audit messages (per second, 0=unlimited)
-r 1000
```

### /etc/audit/rules.d/10-identity.rules

```bash
## /etc/audit/rules.d/10-identity.rules
## Identity and authentication events

# Monitor /etc/passwd and shadow for modifications
-w /etc/passwd -p wa -k identity-passwd
-w /etc/shadow -p wa -k identity-shadow
-w /etc/group -p wa -k identity-group
-w /etc/gshadow -p wa -k identity-gshadow
-w /etc/security/opasswd -p wa -k identity-opasswd

# Monitor sudoers configuration
-w /etc/sudoers -p wa -k sudoers-change
-w /etc/sudoers.d/ -p wa -k sudoers-change

# Monitor PAM configuration
-w /etc/pam.d/ -p wa -k pam-config

# Monitor SSH daemon configuration
-w /etc/ssh/sshd_config -p wa -k sshd-config
-w /etc/ssh/sshd_config.d/ -p wa -k sshd-config

# Login/logout monitoring
-w /var/log/lastlog -p wa -k login-events
-w /var/run/faillock -p wa -k login-failures
-w /var/log/btmp -p wa -k login-failures
-w /var/log/wtmp -p wa -k login-success

# Monitor user home directory creation
-w /home -p wa -k home-directory
```

### /etc/audit/rules.d/20-syscalls.rules

```bash
## /etc/audit/rules.d/20-syscalls.rules
## Syscall monitoring for privilege escalation and persistence

# Monitor setuid/setgid bit changes
-a always,exit -F arch=b64 -S chmod,fchmod,fchmodat -F auid>=1000 -F auid!=-1 -k setuid-setgid
-a always,exit -F arch=b32 -S chmod,fchmod,fchmodat -F auid>=1000 -F auid!=-1 -k setuid-setgid

# Monitor privilege escalation via setuid/setgid execution
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=-1 -k privilege-escalation
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid>=1000 -F auid!=-1 -k privilege-escalation

# Monitor ptrace (debugging/injection)
-a always,exit -F arch=b64 -S ptrace -F auid>=1000 -F auid!=-1 -k ptrace
-a always,exit -F arch=b32 -S ptrace -F auid>=1000 -F auid!=-1 -k ptrace

# Monitor module loading (rootkits)
-a always,exit -F arch=b64 -S init_module,finit_module -k kernel-module-load
-a always,exit -F arch=b32 -S init_module,finit_module -k kernel-module-load
-w /sbin/insmod -p x -k kernel-module-load
-w /sbin/rmmod -p x -k kernel-module-load
-w /sbin/modprobe -p x -k kernel-module-load

# Monitor network configuration changes
-a always,exit -F arch=b64 -S sethostname,setdomainname -k network-config
-a always,exit -F arch=b32 -S sethostname,setdomainname -k network-config

# Monitor cron jobs
-w /etc/crontab -p wa -k cron
-w /etc/cron.allow -p wa -k cron
-w /etc/cron.deny -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /etc/cron.daily/ -p wa -k cron
-w /etc/cron.hourly/ -p wa -k cron
-w /etc/cron.monthly/ -p wa -k cron
-w /etc/cron.weekly/ -p wa -k cron
-w /var/spool/cron/ -p wa -k cron

# Monitor systemd unit files
-w /etc/systemd/system/ -p wa -k systemd-units
-w /usr/lib/systemd/system/ -p wa -k systemd-units
-w /usr/local/lib/systemd/system/ -p wa -k systemd-units

# Monitor at jobs
-w /var/spool/at/ -p wa -k at-jobs

# Monitor container escapes via namespace manipulation
-a always,exit -F arch=b64 -S unshare,clone -F auid>=1000 -F auid!=-1 -k namespace-manipulation
-a always,exit -F arch=b32 -S unshare,clone -F auid>=1000 -F auid!=-1 -k namespace-manipulation

# Monitor mounts (container escapes, persistence)
-a always,exit -F arch=b64 -S mount,umount2 -F auid>=1000 -F auid!=-1 -k mount
-a always,exit -F arch=b32 -S mount,umount2 -F auid>=1000 -F auid!=-1 -k mount
```

### /etc/audit/rules.d/30-network.rules

```bash
## /etc/audit/rules.d/30-network.rules
## Network activity monitoring

# Monitor socket creation (detect backdoors)
-a always,exit -F arch=b64 -S socket -F a0=2 -F auid>=1000 -F auid!=-1 -k inet-socket
-a always,exit -F arch=b64 -S socket -F a0=10 -F auid>=1000 -F auid!=-1 -k inet6-socket

# Monitor network configuration tools
-w /sbin/ip -p x -k network-tools
-w /sbin/ifconfig -p x -k network-tools
-w /sbin/iptables -p x -k network-tools
-w /sbin/ip6tables -p x -k network-tools
-w /sbin/nft -p x -k network-tools

# Suspicious network utilities
-w /usr/bin/nc -p x -k suspicious-nettools
-w /usr/bin/ncat -p x -k suspicious-nettools
-w /usr/bin/netcat -p x -k suspicious-nettools
-w /usr/bin/socat -p x -k suspicious-nettools
-w /usr/bin/nmap -p x -k suspicious-nettools
-w /usr/bin/masscan -p x -k suspicious-nettools

# Monitor /etc/hosts and DNS configuration
-w /etc/hosts -p wa -k hosts-file
-w /etc/resolv.conf -p wa -k dns-config
-w /etc/nsswitch.conf -p wa -k nsswitch
```

### /etc/audit/rules.d/40-data-access.rules

```bash
## /etc/audit/rules.d/40-data-access.rules
## Sensitive data access monitoring

# Monitor sensitive configuration files
-w /etc/kubernetes/ -p rwxa -k kubernetes-config
-w /etc/docker/ -p rwxa -k docker-config
-w /run/secrets/ -p rwxa -k secret-access
-w /var/lib/kubelet/ -p rwxa -k kubelet-data

# Monitor private keys
-w /etc/ssl/private/ -p rwxa -k private-keys
-w /root/.ssh/ -p rwxa -k root-ssh
-w /home -p rwxa -F dir=.ssh -k ssh-keys

# Monitor container runtime sockets
-w /var/run/docker.sock -p rwxa -k docker-socket
-w /run/containerd/containerd.sock -p rwxa -k containerd-socket
-w /run/crio/crio.sock -p rwxa -k crio-socket

# Monitor audit log tampering
-w /var/log/audit/ -p wxa -k audit-log-tamper
-w /etc/audit/ -p wxa -k audit-config-change

# Monitor credential files
-w /proc -p wa -F dir=1 -k proc-write
```

### /etc/audit/rules.d/50-execution.rules

```bash
## /etc/audit/rules.d/50-execution.rules
## Process execution monitoring

# Monitor execution in suspicious locations
-a always,exit -F arch=b64 -S execve -F dir=/tmp -F auid>=1000 -F auid!=-1 -k exec-tmp
-a always,exit -F arch=b32 -S execve -F dir=/tmp -F auid>=1000 -F auid!=-1 -k exec-tmp
-a always,exit -F arch=b64 -S execve -F dir=/dev/shm -F auid>=1000 -F auid!=-1 -k exec-shm
-a always,exit -F arch=b64 -S execve -F dir=/var/tmp -F auid>=1000 -F auid!=-1 -k exec-var-tmp

# Monitor common attack tools
-w /usr/bin/curl -p x -k download-tools
-w /usr/bin/wget -p x -k download-tools
-w /usr/bin/python -p x -k scripting
-w /usr/bin/python3 -p x -k scripting
-w /usr/bin/perl -p x -k scripting
-w /usr/bin/ruby -p x -k scripting
-w /usr/bin/lua -p x -k scripting
-w /bin/bash -p x -k shell-execution
-w /bin/sh -p x -k shell-execution
-w /bin/dash -p x -k shell-execution
-w /bin/zsh -p x -k shell-execution

# Monitor passwd/shadow utilities
-w /usr/bin/passwd -p x -k password-change
-w /usr/sbin/useradd -p x -k user-management
-w /usr/sbin/usermod -p x -k user-management
-w /usr/sbin/userdel -p x -k user-management
-w /usr/sbin/groupadd -p x -k group-management
-w /usr/sbin/groupmod -p x -k group-management
-w /usr/sbin/groupdel -p x -k group-management

# su and sudo
-w /bin/su -p x -k su-execution
-w /usr/bin/sudo -p x -k sudo-execution
-w /usr/bin/sudoedit -p x -k sudo-execution
```

### /etc/audit/rules.d/99-immutable.rules

```bash
## /etc/audit/rules.d/99-immutable.rules
## Make rules immutable - requires reboot to change

# Lock rules to prevent runtime modification
# COMMENT OUT during initial setup, enable in production
-e 2
```

### Apply Rules

```bash
# Load all rules from /etc/audit/rules.d/
sudo augenrules --load

# Verify rules loaded
sudo auditctl -l | head -50

# Check rule counts
sudo auditctl -s | grep -E "rules_file|backlog"

# Test a rule
sudo touch /etc/passwd
sudo ausearch -k identity-passwd --start recent -i | tail -20
```

## Section 4: Parsing Audit Events

### Understanding Audit Record Format

```
type=SYSCALL msg=audit(1710500000.123:456789): arch=c000003e syscall=2 success=yes exit=4 a0=55f1234 a1=0 a2=1b6 a3=24 items=1 ppid=12345 pid=12346 auid=1000 uid=1000 gid=1000 euid=0 suid=0 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=pts0 ses=1 comm="passwd" exe="/usr/bin/passwd" subj=unconfined_u:unconfined_r:passwd_t:s0-s0:c0.c1023 key="identity-passwd"
type=PATH msg=audit(1710500000.123:456789): item=0 name="/etc/passwd" inode=262150 dev=fd:00 mode=0100644 ouid=0 ogid=0 rdev=00:00 obj=system_u:object_r:passwd_file_t:s0 objtype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
type=PROCTITLE msg=audit(1710500000.123:456789): proctitle=passwd
```

Key fields:
- `msg=audit(timestamp:serial)` — event ID for correlation
- `auid` — audit UID (login UID, persists across su/sudo)
- `uid/euid` — current real/effective UID
- `key` — rule key for event categorization
- `syscall` — system call number
- `comm/exe` — process name and path

## Section 5: go-audit for High-Performance Processing

go-audit reads directly from the kernel netlink socket, bypassing auditd entirely. It provides structured JSON output and scales to 100,000+ events per second.

### go-audit Configuration

```yaml
# /etc/go-audit/config.yaml
socket_buffer:
  receive: 16384     # netlink receive buffer (kernel side)

events:
  min: 1
  max: 2147483647
  # Filter out noisy event types
  filters:
    - type: "PROCTITLE"    # Decode but don't emit separately
    - type: "EOE"          # End of event marker, not useful

output:
  # Write structured JSON to stdout
  attempts: 3
  stdout:
    enabled: false
  file:
    enabled: true
    path: /var/log/go-audit/audit.json
    mode: 0600

# Log level: debug, info, warn, error
log:
  level: info

# Enrichment
# Resolve UIDs to usernames, etc.
message_tracking:
  enabled: true
  log_out_of_order: false
  max_out_of_order: 500
```

### go-audit Installation

```bash
# Build from source
go install github.com/slackhq/go-audit@latest

# Or download binary
wget https://github.com/slackhq/go-audit/releases/latest/download/go-audit-linux-amd64
chmod +x go-audit-linux-amd64
sudo mv go-audit-linux-amd64 /usr/local/bin/go-audit

# Create systemd service
sudo tee /etc/systemd/system/go-audit.service << 'EOF'
[Unit]
Description=go-audit Linux Audit Daemon
Documentation=https://github.com/slackhq/go-audit
After=network.target
# Conflict with auditd - only run one
Conflicts=auditd.service

[Service]
Type=simple
ExecStart=/usr/local/bin/go-audit -config /etc/go-audit/config.yaml
Restart=on-failure
RestartSec=5s
# Must run as root to access netlink
User=root
Group=root
# Security hardening
NoNewPrivileges=false  # needs netlink capabilities
AmbientCapabilities=CAP_AUDIT_READ
CapabilityBoundingSet=CAP_AUDIT_READ

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now go-audit
```

### Custom go-audit Event Processor

```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "os"
    "strings"
    "time"
)

// AuditEvent represents a structured audit event from go-audit
type AuditEvent struct {
    Timestamp  float64            `json:"timestamp"`
    Serial     int64              `json:"serial"`
    Type       string             `json:"type"`
    Data       map[string]string  `json:"data"`
    Enrichment *Enrichment        `json:"enrichment,omitempty"`
    Sequence   []AuditRecord      `json:"sequence,omitempty"`
}

type AuditRecord struct {
    Type string            `json:"type"`
    Data map[string]string `json:"data"`
}

type Enrichment struct {
    Username  string `json:"username,omitempty"`
    Hostname  string `json:"hostname,omitempty"`
    Timestamp string `json:"@timestamp,omitempty"`
}

// EnrichedAuditEvent is the final output format
type EnrichedAuditEvent struct {
    Timestamp   time.Time         `json:"@timestamp"`
    Host        HostInfo          `json:"host"`
    Audit       map[string]string `json:"audit"`
    Process     ProcessInfo       `json:"process,omitempty"`
    User        UserInfo          `json:"user"`
    Event       EventInfo         `json:"event"`
    File        *FileInfo         `json:"file,omitempty"`
    Network     *NetworkInfo      `json:"network,omitempty"`
    Tags        []string          `json:"tags"`
    RawEvent    *AuditEvent       `json:"_raw,omitempty"`
}

type HostInfo struct {
    Hostname string `json:"hostname"`
    IP       string `json:"ip,omitempty"`
}

type ProcessInfo struct {
    PID        string `json:"pid,omitempty"`
    PPID       string `json:"ppid,omitempty"`
    Name       string `json:"name,omitempty"`
    Executable string `json:"executable,omitempty"`
    CommandLine string `json:"command_line,omitempty"`
}

type UserInfo struct {
    ID    string `json:"id,omitempty"`
    Name  string `json:"name,omitempty"`
    AuditID string `json:"audit_id,omitempty"`
    EffectiveID string `json:"effective_id,omitempty"`
}

type EventInfo struct {
    Category string `json:"category"`
    Type     string `json:"type"`
    Action   string `json:"action"`
    Outcome  string `json:"outcome"`
    RuleKey  string `json:"rule_key,omitempty"`
}

type FileInfo struct {
    Path string `json:"path,omitempty"`
    Mode string `json:"mode,omitempty"`
    UID  string `json:"uid,omitempty"`
    GID  string `json:"gid,omitempty"`
}

type NetworkInfo struct {
    Protocol string `json:"protocol,omitempty"`
    Family   string `json:"family,omitempty"`
}

// AuditProcessor processes audit events
type AuditProcessor struct {
    hostname string
    output   io.Writer
    stats    ProcessorStats
}

type ProcessorStats struct {
    Processed int64
    Errors    int64
    Filtered  int64
}

func NewAuditProcessor(hostname string, output io.Writer) *AuditProcessor {
    return &AuditProcessor{
        hostname: hostname,
        output:   output,
    }
}

func (p *AuditProcessor) ProcessStream(reader io.Reader) error {
    scanner := bufio.NewScanner(reader)
    scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer

    for scanner.Scan() {
        line := scanner.Text()
        if err := p.ProcessLine(line); err != nil {
            p.stats.Errors++
            log.Printf("error processing event: %v", err)
        }
        p.stats.Processed++
    }

    return scanner.Err()
}

func (p *AuditProcessor) ProcessLine(line string) error {
    if strings.TrimSpace(line) == "" {
        return nil
    }

    var event AuditEvent
    if err := json.Unmarshal([]byte(line), &event); err != nil {
        return fmt.Errorf("unmarshal: %w", err)
    }

    enriched := p.enrich(&event)
    if enriched == nil {
        p.stats.Filtered++
        return nil
    }

    output, err := json.Marshal(enriched)
    if err != nil {
        return fmt.Errorf("marshal enriched: %w", err)
    }

    _, err = fmt.Fprintln(p.output, string(output))
    return err
}

func (p *AuditProcessor) enrich(event *AuditEvent) *EnrichedAuditEvent {
    ts := time.Unix(int64(event.Timestamp), int64((event.Timestamp-float64(int64(event.Timestamp)))*1e9))

    enriched := &EnrichedAuditEvent{
        Timestamp: ts,
        Host: HostInfo{
            Hostname: p.hostname,
        },
        Audit: event.Data,
        Tags:  []string{"audit", "linux"},
    }

    // Extract user info
    enriched.User = UserInfo{
        ID:          event.Data["uid"],
        AuditID:     event.Data["auid"],
        EffectiveID: event.Data["euid"],
        Name:        event.Data["acct"],
    }

    // Extract process info
    enriched.Process = ProcessInfo{
        PID:        event.Data["pid"],
        PPID:       event.Data["ppid"],
        Name:       event.Data["comm"],
        Executable: event.Data["exe"],
    }

    // Categorize event
    enriched.Event = p.categorize(event)

    // Extract file info if present
    if path, ok := event.Data["name"]; ok && path != "" {
        enriched.File = &FileInfo{
            Path: path,
            Mode: event.Data["mode"],
            UID:  event.Data["ouid"],
            GID:  event.Data["ogid"],
        }
    }

    return enriched
}

func (p *AuditProcessor) categorize(event *AuditEvent) EventInfo {
    key := event.Data["key"]

    // Map rule keys to ECS event categories
    categoryMap := map[string]EventInfo{
        "identity-passwd": {
            Category: "iam",
            Type:     "change",
            Action:   "password-file-modified",
        },
        "sudo-execution": {
            Category: "process",
            Type:     "start",
            Action:   "sudo-executed",
        },
        "privilege-escalation": {
            Category: "privilege_escalation",
            Type:     "start",
            Action:   "privilege-change",
        },
        "exec-tmp": {
            Category: "process",
            Type:     "start",
            Action:   "suspicious-exec-location",
        },
        "kernel-module-load": {
            Category: "driver",
            Type:     "start",
            Action:   "module-loaded",
        },
        "docker-socket": {
            Category: "process",
            Type:     "access",
            Action:   "container-socket-access",
        },
    }

    if info, ok := categoryMap[key]; ok {
        info.RuleKey = key
        info.Outcome = p.extractOutcome(event)
        return info
    }

    return EventInfo{
        Category: "host",
        Type:     "info",
        Action:   event.Type,
        RuleKey:  key,
        Outcome:  p.extractOutcome(event),
    }
}

func (p *AuditProcessor) extractOutcome(event *AuditEvent) string {
    if success, ok := event.Data["success"]; ok {
        if success == "yes" {
            return "success"
        }
        return "failure"
    }
    return "unknown"
}

func main() {
    hostname, _ := os.Hostname()
    processor := NewAuditProcessor(hostname, os.Stdout)

    log.Printf("Starting audit event processor for host: %s", hostname)

    if err := processor.ProcessStream(os.Stdin); err != nil {
        log.Fatalf("Processing failed: %v", err)
    }

    log.Printf("Stats: processed=%d errors=%d filtered=%d",
        processor.stats.Processed,
        processor.stats.Errors,
        processor.stats.Filtered,
    )
}
```

## Section 6: Shipping to Elasticsearch

### Filebeat Configuration for Audit Logs

```yaml
# /etc/filebeat/filebeat.yml
filebeat.inputs:
  # Traditional auditd text logs
  - type: filestream
    id: auditd-logs
    enabled: true
    paths:
      - /var/log/audit/audit.log
    parsers:
      - multiline:
          type: pattern
          pattern: '^----'
          negate: true
          match: after

  # go-audit JSON output
  - type: filestream
    id: go-audit-json
    enabled: true
    paths:
      - /var/log/go-audit/audit.json
    parsers:
      - ndjson:
          target: ""
          overwrite_keys: true
          add_error_key: true
          expand_keys: true

filebeat.modules:
  - module: auditd
    log:
      enabled: true
      var.paths: ["/var/log/audit/audit.log"]

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
  hosts: ["https://elasticsearch.logging.svc.cluster.local:9200"]
  username: "filebeat"
  password: "${ELASTICSEARCH_PASSWORD}"
  ssl:
    enabled: true
    certificate_authorities: ["/etc/ssl/certs/elasticsearch-ca.crt"]

  # ILM for retention management
  ilm.enabled: true
  ilm.rollover_alias: "auditd"
  ilm.pattern: "{now/d}-000001"

  # Index template
  setup.template.name: "auditd"
  setup.template.pattern: "auditd-*"

setup.kibana:
  host: "https://kibana.logging.svc.cluster.local:5601"
  username: "elastic"
  password: "${KIBANA_PASSWORD}"
```

## Section 7: Correlating with Kubernetes Audit Logs

Kubernetes API server maintains its own audit log. Correlating it with Linux audit events enables complete attack chain reconstruction.

### Kubernetes Audit Policy

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log pod exec/attach at RequestResponse level
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]
    omitStages:
      - RequestReceived

  # Log secrets access at Metadata level (don't log content)
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps", "serviceaccounts"]

  # Log all service account token requests
  - level: Request
    resources:
      - group: "authentication.k8s.io"
        resources: ["tokenreviews"]

  # Log RBAC changes
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources:
          - "clusterroles"
          - "clusterrolebindings"
          - "roles"
          - "rolebindings"

  # Log node operations
  - level: Request
    users: ["system:node:*"]
    resources:
      - group: ""
        resources: ["pods", "nodes", "nodes/status"]

  # Log all privileged pod creation
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods"]
    omitStages:
      - RequestReceived

  # Log webhook configuration changes
  - level: RequestResponse
    resources:
      - group: "admissionregistration.k8s.io"
        resources:
          - "mutatingwebhookconfigurations"
          - "validatingwebhookconfigurations"

  # Minimal logging for read-only operations
  - level: None
    verbs: ["get", "list", "watch"]
    resources:
      - group: ""
        resources: ["events"]

  # Default: log metadata only for everything else
  - level: Metadata
    omitStages:
      - RequestReceived
```

### Kubernetes API Server Configuration

```yaml
# kube-apiserver manifest additions
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    # ... other flags ...
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-format=json
    volumeMounts:
    - name: audit-logs
      mountPath: /var/log/kubernetes/audit
    - name: audit-policy
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
  volumes:
  - name: audit-logs
    hostPath:
      path: /var/log/kubernetes/audit
      type: DirectoryOrCreate
  - name: audit-policy
    hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
```

### Correlation Logic

```go
package correlation

import (
    "encoding/json"
    "fmt"
    "time"
)

// K8sAuditEvent represents a Kubernetes audit event
type K8sAuditEvent struct {
    APIVersion        string            `json:"apiVersion"`
    Kind              string            `json:"kind"`
    Level             string            `json:"level"`
    AuditID           string            `json:"auditID"`
    Stage             string            `json:"stage"`
    RequestURI        string            `json:"requestURI"`
    Verb              string            `json:"verb"`
    User              K8sUser           `json:"user"`
    SourceIPs         []string          `json:"sourceIPs"`
    UserAgent         string            `json:"userAgent"`
    ObjectRef         *ObjectReference  `json:"objectRef,omitempty"`
    ResponseStatus    *ResponseStatus   `json:"responseStatus,omitempty"`
    RequestTimestamp  time.Time         `json:"requestReceivedTimestamp"`
    StageTimestamp    time.Time         `json:"stageTimestamp"`
    Annotations       map[string]string `json:"annotations,omitempty"`
}

type K8sUser struct {
    Username string   `json:"username"`
    UID      string   `json:"uid"`
    Groups   []string `json:"groups"`
    Extra    map[string][]string `json:"extra,omitempty"`
}

type ObjectReference struct {
    Resource  string `json:"resource"`
    Namespace string `json:"namespace"`
    Name      string `json:"name"`
    APIGroup  string `json:"apiGroup"`
    APIVersion string `json:"apiVersion"`
    Subresource string `json:"subresource,omitempty"`
}

type ResponseStatus struct {
    Code    int    `json:"code"`
    Status  string `json:"status"`
    Message string `json:"message,omitempty"`
}

// CorrelationKey generates a key for correlating K8s and Linux audit events
func CorrelationKey(sourceIP string, t time.Time) string {
    // Round to 1-second window for correlation
    window := t.Truncate(time.Second)
    return fmt.Sprintf("%s:%d", sourceIP, window.Unix())
}

// SuspiciousEventPattern represents a detection rule
type SuspiciousEventPattern struct {
    Name        string
    Description string
    Severity    string
    Detect      func(k8s *K8sAuditEvent, linux *EnrichedAuditEvent) bool
}

// DetectionRules contains patterns for cross-log correlation
var DetectionRules = []SuspiciousEventPattern{
    {
        Name:        "pod-exec-with-privilege-escalation",
        Description: "kubectl exec followed by privilege escalation on the same node",
        Severity:    "critical",
        Detect: func(k8s *K8sAuditEvent, linux *EnrichedAuditEvent) bool {
            if k8s == nil || linux == nil {
                return false
            }
            // K8s: pod exec event
            isPodExec := k8s.Verb == "create" &&
                k8s.ObjectRef != nil &&
                k8s.ObjectRef.Subresource == "exec"

            // Linux: privilege escalation within 30s
            isPrivEsc := linux.Event.Category == "privilege_escalation"
            timeDiff := linux.Timestamp.Sub(k8s.RequestTimestamp).Abs()
            isTimeCorrelated := timeDiff < 30*time.Second

            return isPodExec && isPrivEsc && isTimeCorrelated
        },
    },
    {
        Name:        "secret-read-before-data-exfil",
        Description: "K8s secret read followed by suspicious network connection",
        Severity:    "high",
        Detect: func(k8s *K8sAuditEvent, linux *EnrichedAuditEvent) bool {
            if k8s == nil || linux == nil {
                return false
            }
            isSecretRead := k8s.Verb == "get" &&
                k8s.ObjectRef != nil &&
                k8s.ObjectRef.Resource == "secrets"

            isSuspiciousNetwork := linux.Event.Category == "network" &&
                linux.Event.Action == "connection-established"

            timeDiff := linux.Timestamp.Sub(k8s.RequestTimestamp).Abs()

            return isSecretRead && isSuspiciousNetwork && timeDiff < 60*time.Second
        },
    },
}
```

## Section 8: Alerting Rules for SIEM

### Sigma Rules for Audit Events

```yaml
# sigma-linux-audit-rules.yaml
title: Suspicious Execution from Temporary Directory
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
status: production
description: Detects execution of binaries from /tmp or /dev/shm which is a common attacker TTP
references:
  - https://attack.mitre.org/techniques/T1059/
author: support.tools
date: 2026/03/17
tags:
  - attack.execution
  - attack.t1059
logsource:
  product: linux
  service: auditd
detection:
  selection:
    type: SYSCALL
    syscall: execve
    key: exec-tmp
  condition: selection
falsepositives:
  - Software installation scripts that execute from /tmp
  - Container builds that use /tmp
level: high
---
title: Kernel Module Loading Outside Package Manager
id: b2c3d4e5-f6a7-8901-bcde-f01234567891
status: production
description: Detects kernel module loading not initiated by the package manager
logsource:
  product: linux
  service: auditd
detection:
  selection:
    type: SYSCALL
    key: kernel-module-load
  filter:
    exe:
      - /usr/bin/dpkg
      - /usr/bin/rpm
      - /usr/bin/apt
      - /usr/sbin/modprobe
  condition: selection and not filter
level: critical
```

### Elasticsearch Detection Rules (EQL)

```json
{
  "name": "Container Socket Access Followed by Network Connection",
  "description": "Detects access to Docker/containerd socket followed by outbound connection",
  "risk_score": 75,
  "severity": "high",
  "type": "eql",
  "language": "eql",
  "query": "sequence by host.name with maxspan=1m\n  [file where event.action == \"container-socket-access\" and\n   file.path : (\"/var/run/docker.sock\", \"/run/containerd/containerd.sock\")]\n  [network where event.direction == \"outbound\" and not\n   destination.ip : (\"10.0.0.0/8\", \"172.16.0.0/12\", \"192.168.0.0/16\")]",
  "index": ["auditd-*"],
  "interval": "5m",
  "from": "now-6m"
}
```

The Linux audit subsystem, when properly configured, provides an immutable kernel-level record of security events that cannot be tampered with by userspace processes. Combined with go-audit's high-throughput processing and a well-designed SIEM integration, it becomes a powerful foundation for detecting sophisticated attacks including container escapes, privilege escalation, and data exfiltration in production Kubernetes environments.
