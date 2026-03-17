---
title: "Linux systemd Advanced Service Management: Units, Timers, and Dependency Graphs"
date: 2030-06-05T00:00:00-05:00
draft: false
tags: ["Linux", "systemd", "Service Management", "Timers", "journald", "DevOps", "System Administration"]
categories:
- Linux
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise systemd guide: unit file anatomy, service dependencies, socket activation, systemd timers as cron replacement, journald integration, and managing complex multi-service startup ordering."
more_link: "yes"
url: "/linux-systemd-advanced-service-management-units-timers-dependencies/"
---

systemd manages more of the Linux boot process and service lifecycle than any other component. Most administrators know `systemctl start`, `stop`, and `enable` — but production environments demand more: precise dependency ordering to eliminate race conditions, socket activation for zero-downtime restarts, timer units that replace fragile cron jobs, and structured logging integration that feeds into observability pipelines. This guide covers the patterns that matter in enterprise environments.

<!--more-->

## Unit File Anatomy

A unit file is a declarative specification of a service, socket, timer, mount, or other managed resource. Understanding the structure enables precise control over behavior.

### Service Unit Sections

Every service unit file has three primary sections:

```ini
[Unit]
# Metadata, dependencies, and ordering constraints
Description=Payment Processing Service
Documentation=https://internal.example.com/docs/payment-service
After=network-online.target postgresql.service redis.service
Requires=postgresql.service
Wants=redis.service

[Service]
# Process management configuration
Type=notify
User=payment
Group=payment
WorkingDirectory=/opt/payment-service
Environment=ENVIRONMENT=production
EnvironmentFile=/etc/payment-service/env
ExecStart=/opt/payment-service/bin/payment-service --config /etc/payment-service/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
ExecStop=/bin/kill -TERM $MAINPID
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
RestartSec=5s
StartLimitInterval=60s
StartLimitBurst=3

[Install]
# Target membership for enable/disable
WantedBy=multi-user.target
```

### Service Type Selection

The `Type=` directive determines how systemd tracks service readiness:

```ini
# Type=simple (default)
# systemd considers the service started as soon as ExecStart forks.
# Use when the process doesn't fork and doesn't signal readiness.
Type=simple

# Type=forking
# The process forks and the parent exits. systemd waits for the parent to exit.
# Use for traditional Unix daemons. Requires PIDFile= or guessing.
Type=forking
PIDFile=/var/run/myservice.pid

# Type=notify
# The process sends sd_notify("READY=1\n") when ready to accept traffic.
# Use this for Go/Rust/Python services that use libsystemd or the sd_notify API.
# Most reliable option for modern services.
Type=notify
NotifyAccess=main

# Type=oneshot
# The process runs to completion. systemd considers it done when ExecStart exits.
# Use for scripts and batch jobs.
Type=oneshot
RemainAfterExit=yes

# Type=idle
# Like simple, but waits until no other active jobs are pending.
# Rarely needed; use for services that should start last.
Type=idle
```

### Implementing sd_notify in Go

For `Type=notify`, the service must signal readiness:

```go
package main

import (
    "fmt"
    "net"
    "os"

    "github.com/coreos/go-systemd/v22/daemon"
)

func main() {
    listener, err := net.Listen("tcp", ":8080")
    if err != nil {
        fmt.Fprintf(os.Stderr, "listen failed: %v\n", err)
        os.Exit(1)
    }

    // Signal systemd that the service is ready to accept connections.
    // This must happen BEFORE systemd times out waiting for readiness.
    sent, err := daemon.SdNotify(false, daemon.SdNotifyReady)
    if err != nil {
        fmt.Fprintf(os.Stderr, "sd_notify failed: %v\n", err)
    }
    if !sent {
        // Not running under systemd — log but continue
        fmt.Println("Not running under systemd, sd_notify had no effect")
    }

    // Now serve
    http.Serve(listener, handler)
}
```

### Process Isolation and Security Hardening

systemd provides extensive namespace and capability controls:

```ini
[Service]
# Run as non-root user
User=appuser
Group=appgroup

# Filesystem isolation
PrivateTmp=true              # Private /tmp and /var/tmp
PrivateDevices=true          # No access to real hardware devices
ProtectSystem=strict         # /usr, /boot, /etc read-only
ProtectHome=true             # /home, /root, /run/user inaccessible
ReadWritePaths=/var/lib/myapp /var/log/myapp  # Exceptions

# Network isolation
PrivateNetwork=false         # Needs network access
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Capability restrictions
CapabilityBoundingSet=       # Drop ALL capabilities
NoNewPrivileges=true         # No privilege escalation via setuid

# System call filtering
SystemCallFilter=@system-service  # Allow only service-typical syscalls
SystemCallFilter=~@privileged     # Deny privileged syscalls
SystemCallArchitectures=native

# Memory protection
MemoryDenyWriteExecute=true  # Prevent JIT code execution
LockPersonality=true         # Prevent personality changes

# Resource limits (also enforced by cgroups v2)
LimitNOFILE=65536
LimitNPROC=512
MemoryMax=2G
CPUQuota=200%                # 2 CPU cores maximum
```

## Dependency and Ordering System

### Requires vs Wants vs Bindsto

Understanding the difference between dependency directives prevents unexpected behaviors:

```ini
# Requires=: Hard dependency. If the listed unit fails or is stopped,
# this unit is also stopped. systemd will attempt to start it.
Requires=postgresql.service

# Wants=: Soft dependency. systemd tries to start it but proceeds
# if it fails. Used for optional services.
Wants=redis.service

# BindsTo=: Like Requires= but tighter: if the listed unit stops
# for any reason, this unit stops immediately.
BindsTo=docker.service

# Requisite=: Like Requires= but does NOT start the listed unit.
# Fails immediately if the listed unit is not already active.
Requisite=network.target

# PartOf=: This unit is part of the listed unit.
# When the listed unit is stopped/restarted, so is this unit.
# But starting this unit does NOT start the listed unit.
PartOf=myapp.slice
```

### After and Before: Ordering Without Dependency

`After=` and `Before=` control startup order without implying dependency:

```ini
[Unit]
# "Start after network-online.target, but don't fail if it's missing"
After=network-online.target
Wants=network-online.target

# "Start before cloud-init.service"
Before=cloud-init.service

# Combined: hard require + ordered after
After=postgresql.service
Requires=postgresql.service
```

The distinction matters: `After=postgresql.service` without `Requires=` means "if both are starting, start after postgres" but does not mandate postgres be present.

### Visualizing the Dependency Graph

```bash
# Show dependency tree for a service
systemctl list-dependencies myapp.service

# Show reverse dependencies (what depends on this unit)
systemctl list-dependencies --reverse myapp.service

# Show the full dependency graph as DOT format for visualization
systemd-analyze dot myapp.service | dot -Tsvg > myapp-deps.svg

# Show units ordered by startup time
systemd-analyze blame

# Show critical chain (longest path in startup)
systemd-analyze critical-chain myapp.service

# Verify unit file for errors
systemd-analyze verify myapp.service
```

### Target Units for Grouping

Targets are synchronization points in the boot process:

```ini
# Custom application target
# /etc/systemd/system/myapp.target
[Unit]
Description=My Application Stack
Wants=myapp-api.service myapp-worker.service myapp-scheduler.service
After=network-online.target postgresql.service

[Install]
WantedBy=multi-user.target
```

```ini
# Each service declares membership in the target
# /etc/systemd/system/myapp-api.service
[Unit]
Description=MyApp API Service
PartOf=myapp.target
After=myapp.target

[Install]
WantedBy=myapp.target
```

Starting the target brings up the whole stack:

```bash
systemctl start myapp.target
systemctl stop myapp.target    # Stops all PartOf services
systemctl restart myapp.target
```

## Socket Activation

Socket activation separates socket creation from process startup. systemd holds the socket open during service restarts, eliminating the window where new connections are refused.

### How Socket Activation Works

1. systemd creates and listens on the socket.
2. Incoming connections are queued by the kernel.
3. On first connection (or at boot), systemd starts the service.
4. The service inherits the pre-bound socket via `SD_LISTEN_FDS`.
5. During restarts, the socket remains bound — no connections are dropped.

### Socket Unit File

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=MyApp Socket
PartOf=myapp.service

[Socket]
ListenStream=8080
# Socket options
NoDelay=true
KeepAlive=true
ReceiveBuffer=1048576
SendBuffer=1048576
# Socket permissions (for Unix sockets)
# SocketUser=myapp
# SocketGroup=myapp
# SocketMode=0660

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=MyApp Service
Requires=myapp.socket
After=myapp.socket

[Service]
Type=notify
User=myapp
ExecStart=/opt/myapp/bin/myapp
# SystemD passes inherited socket via SD_LISTEN_FDS environment variable
StandardInput=socket  # For simple services that only need stdin socket
# For more complex socket handling, use sd_listen_fds() API

[Install]
WantedBy=multi-user.target
```

### Go Service with Socket Activation

```go
package main

import (
    "net"
    "net/http"
    "os"
    "strconv"

    "github.com/coreos/go-systemd/v22/activation"
    "github.com/coreos/go-systemd/v22/daemon"
)

func main() {
    var listener net.Listener

    // Try to inherit a socket from systemd
    listeners, err := activation.Listeners()
    if err != nil {
        panic("cannot retrieve listeners: " + err.Error())
    }

    if len(listeners) == 1 {
        // Using socket activation
        listener = listeners[0]
    } else {
        // Fallback for non-systemd environments
        port := os.Getenv("PORT")
        if port == "" {
            port = "8080"
        }
        listener, err = net.Listen("tcp", ":"+port)
        if err != nil {
            panic("listen failed: " + err.Error())
        }
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    // Signal readiness
    daemon.SdNotify(false, daemon.SdNotifyReady)

    // Serve until shutdown
    server := &http.Server{Handler: mux}
    server.Serve(listener)
}
```

### Multiple Sockets

A service can accept multiple sockets (HTTP and HTTPS, or HTTP and a management socket):

```ini
# /etc/systemd/system/myapp.socket
[Socket]
ListenStream=8080
ListenStream=9090
```

```go
// In the service, listeners[0] is port 8080, listeners[1] is port 9090
listeners, _ := activation.Listeners()
go http.Serve(listeners[0], apiHandler)
go http.Serve(listeners[1], metricsHandler)
```

## systemd Timers

systemd timers replace cron with several advantages: integration with the journal, dependency awareness, missed execution handling, and precise monotonic scheduling.

### Timer Unit Anatomy

Every timer requires a paired service unit with the same base name:

```ini
# /etc/systemd/system/db-backup.timer
[Unit]
Description=Database Backup Timer
Requires=db-backup.service

[Timer]
# Calendar expression: daily at 02:30 UTC
OnCalendar=*-*-* 02:30:00 UTC
# Randomize start within 15 minutes to avoid thundering herd
RandomizedDelaySec=15min
# Run immediately if the last run was missed
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/db-backup.service
[Unit]
Description=Database Backup
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
User=backup
ExecStart=/usr/local/bin/backup-postgres.sh
# Send failure notifications via systemd
OnFailure=notify-oncall@%n.service
```

### Calendar Expression Syntax

```bash
# Every hour
OnCalendar=hourly

# Daily at midnight
OnCalendar=daily

# Monday through Friday at 08:00
OnCalendar=Mon..Fri 08:00:00

# Every 15 minutes
OnCalendar=*:0/15

# First day of each month at 01:00
OnCalendar=*-*-01 01:00:00

# Every 6 hours
OnCalendar=0/6:00:00

# Verify a calendar expression
systemd-analyze calendar "*-*-* 02:30:00 UTC"
# Output shows next trigger times
```

### Monotonic Timers

Monotonic timers fire relative to specific events, not wall-clock time:

```ini
[Timer]
# 5 minutes after the system boots
OnBootSec=5min

# 10 minutes after this timer unit becomes active
OnActiveSec=10min

# 30 minutes after the last time the service ran
OnUnitActiveSec=30min

# 5 minutes after the last time the service was started
# (even if it failed)
OnUnitInactiveSec=5min

# 1 hour after systemd started
OnStartupSec=1h
```

### Managing Timers

```bash
# List all active timers
systemctl list-timers

# Enable and start a timer
systemctl enable --now db-backup.timer

# Check timer status
systemctl status db-backup.timer

# Manually trigger the associated service (for testing)
systemctl start db-backup.service

# View timer execution history
journalctl -u db-backup.service --since "7 days ago"

# Show next scheduled trigger times
systemd-analyze calendar --iterations=5 "*-*-* 02:30:00 UTC"
```

### Replacing Complex Cron Jobs

```bash
# Old cron entry:
# */5 * * * * /usr/bin/check-and-cleanup.sh >> /var/log/cleanup.log 2>&1

# New timer approach:
```

```ini
# /etc/systemd/system/cleanup.timer
[Unit]
Description=Periodic Cleanup Timer

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/cleanup.service
[Unit]
Description=Cleanup Job

[Service]
Type=oneshot
User=cleanup
ExecStart=/usr/bin/check-and-cleanup.sh
# Logs go to journal automatically — no redirection needed
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cleanup
```

## journald Integration

### Structured Logging

Services writing to stdout/stderr are automatically captured by journald when run under systemd. Structured log fields can be passed via the journal protocol:

```go
package main

import (
    "fmt"
    "os"

    "github.com/coreos/go-systemd/v22/journal"
)

func LogWithFields(priority journal.Priority, msg string, fields map[string]string) {
    if journal.Enabled() {
        vars := make(map[string]string, len(fields)+1)
        vars["MESSAGE"] = msg
        for k, v := range fields {
            vars[k] = v
        }
        journal.Send(msg, priority, vars)
    } else {
        // Fallback to stderr for non-systemd environments
        fmt.Fprintln(os.Stderr, msg)
    }
}

// Usage:
LogWithFields(journal.PriInfo, "User created", map[string]string{
    "USER_ID":    "12345",
    "USER_EMAIL": "alice@example.com",
    "REQUEST_ID": "abc-def-123",
})
```

### journalctl Query Patterns

```bash
# Follow logs for a specific service
journalctl -u myapp.service -f

# Show logs from the last boot
journalctl -u myapp.service -b

# Filter by priority (err = errors and above)
journalctl -u myapp.service -p err

# Filter by time range
journalctl -u myapp.service \
  --since "2030-06-01 00:00:00" \
  --until "2030-06-01 06:00:00"

# JSON output for log aggregation
journalctl -u myapp.service -o json | jq .

# Filter by custom journal field
journalctl SYSLOG_IDENTIFIER=myapp USER_ID=12345

# Show logs from all units matching a pattern
journalctl -u "myapp-*"

# Show kernel messages alongside service logs
journalctl -u myapp.service -k

# Show logs from previous boot (crash investigation)
journalctl -u myapp.service -b -1

# Disk usage and rotation
journalctl --disk-usage
journalctl --vacuum-size=1G
journalctl --vacuum-time=30d
```

### Configuring journald

```ini
# /etc/systemd/journald.conf
[Journal]
# Maximum disk space for journal files
SystemMaxUse=2G
RuntimeMaxUse=512M

# Maximum size per journal file
SystemMaxFileSize=128M

# How long to retain journal files
MaxRetentionSec=90day

# Compression
Compress=yes

# Forward to syslog for external log aggregation
ForwardToSyslog=no   # Disabled if using a native journal reader
ForwardToKMsg=no
ForwardToConsole=no

# Rate limiting to prevent log flooding
RateLimitIntervalSec=30s
RateLimitBurst=1000
```

## Complex Multi-Service Startup Ordering

### The Problem with Simple After= Chains

A chain like A → B → C (where → means "After=") starts services sequentially. If the chain is long, boot takes unnecessarily long because parallelism is lost.

### Parallel Startup with Synchronization Points

```
                    network.target
                    /            \
        postgresql.service      redis.service
               |                      |
        +------+------+               |
        |             |               |
   api-service   worker-service  scheduler-service
        |             |               |
        +------+------+---------------+
                      |
                 app.target (synchronization point)
                      |
               monitoring.service
```

```ini
# /etc/systemd/system/postgresql.service
[Unit]
After=network.target
Wants=network.target

# /etc/systemd/system/redis.service
[Unit]
After=network.target
Wants=network.target

# /etc/systemd/system/api-service.service
[Unit]
After=postgresql.service
Requires=postgresql.service
Wants=redis.service
After=redis.service

# /etc/systemd/system/worker-service.service
[Unit]
After=postgresql.service redis.service
Requires=postgresql.service

# /etc/systemd/system/app.target
[Unit]
Wants=api-service.service worker-service.service scheduler-service.service
After=api-service.service worker-service.service scheduler-service.service

# /etc/systemd/system/monitoring.service
[Unit]
After=app.target
Wants=app.target
```

### Service Templates for Replicated Workers

Templates allow running multiple instances of a service with different parameters:

```ini
# /etc/systemd/system/worker@.service
[Unit]
Description=Background Worker Instance %i
After=postgresql.service redis.service
Requires=postgresql.service

[Service]
Type=notify
User=appuser
Environment=WORKER_QUEUE=%i
ExecStart=/opt/app/bin/worker --queue %i --concurrency 4
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start multiple instances
systemctl enable --now worker@orders.service
systemctl enable --now worker@emails.service
systemctl enable --now worker@reports.service

# Check all instances
systemctl status "worker@*.service"

# Stop a specific instance
systemctl stop worker@orders.service
```

### Drop-In Files for Configuration Overrides

Instead of modifying vendor-installed unit files (which get overwritten on package updates), use drop-in files:

```bash
# Create a drop-in directory for postgresql.service
mkdir -p /etc/systemd/system/postgresql.service.d/

# Add resource limits without touching the main unit file
cat > /etc/systemd/system/postgresql.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=65536
MemoryMax=8G
CPUQuota=400%
EOF

# Add environment variables
cat > /etc/systemd/system/postgresql.service.d/environment.conf << 'EOF'
[Service]
Environment=PGDATA=/data/postgres
EnvironmentFile=/etc/postgresql/environment
EOF

# Reload to pick up changes
systemctl daemon-reload
systemctl restart postgresql
```

### Conditional Execution

```ini
[Unit]
# Only start if /etc/myapp/config.yaml exists
ConditionPathExists=/etc/myapp/config.yaml

# Only start on systems with at least 2GB RAM
ConditionMemory=2G

# Only start if not in a container
ConditionVirtualization=!container

# Only start on specific host
ConditionHost=prod-app-01
```

## Operational Patterns

### Reload Without Restart

For services that support configuration reload (SIGHUP):

```ini
[Service]
ExecReload=/bin/kill -HUP $MAINPID
# Or for complex reload scripts:
ExecReload=/opt/myapp/bin/reload-config.sh
```

```bash
# Reload configuration without stopping the service
systemctl reload myapp.service

# Or if reload is not supported, use restart
systemctl restart myapp.service
```

### Failure Notification Service

Create a notification service that fires when another service fails:

```ini
# /etc/systemd/system/notify-oncall@.service
[Unit]
Description=On-call Notification for %i

[Service]
Type=oneshot
ExecStart=/usr/local/bin/notify-oncall.sh %i
```

```bash
#!/usr/bin/env bash
# /usr/local/bin/notify-oncall.sh
UNIT="$1"
STATUS=$(systemctl is-failed "$UNIT")
HOSTNAME=$(hostname -f)

# Post to alerting system (use placeholder for actual webhook)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"ALERT: $UNIT failed on $HOSTNAME (status: $STATUS)\"}" \
  "${ALERTING_WEBHOOK_URL}"
```

```ini
# In any service that should trigger alerts on failure:
[Service]
OnFailure=notify-oncall@%n.service
```

### Debugging Startup Failures

```bash
# Check why a service failed to start
systemctl status myapp.service

# Get detailed logs including stderr
journalctl -u myapp.service -n 100 --no-pager

# Check the unit file as systemd sees it (after merges and overrides)
systemctl cat myapp.service

# Show effective environment variables
systemctl show-environment
systemctl show myapp.service

# Check for missing dependencies
systemd-analyze verify myapp.service

# Trace D-Bus activation
busctl monitor org.freedesktop.systemd1

# Get the exact sequence of units started during boot
systemd-analyze plot > boot-timeline.svg

# Check cgroup resource usage
systemd-cgls
systemctl status myapp.service  # Shows cgroup memory/CPU
```

### Unit File Validation Before Deployment

```bash
#!/usr/bin/env bash
# validate-units.sh — run in CI before deploying unit files

set -euo pipefail

UNIT_DIR="${1:-./systemd}"

# Check syntax
for unit_file in "${UNIT_DIR}"/*.service "${UNIT_DIR}"/*.timer "${UNIT_DIR}"/*.socket; do
    [ -f "$unit_file" ] || continue

    echo "Validating: $unit_file"

    # Copy to temp dir for analysis
    tmpdir=$(mktemp -d)
    cp "$unit_file" "$tmpdir/"

    # systemd-analyze verify requires the unit to be in the load path
    systemd-analyze --root="$tmpdir" verify "$(basename "$unit_file")" || {
        echo "FAILED: $unit_file"
        rm -rf "$tmpdir"
        exit 1
    }

    rm -rf "$tmpdir"
done

echo "All unit files valid"
```

## Monitoring systemd Services with Prometheus

### node_exporter systemd Collector

```yaml
# node_exporter configuration to collect systemd unit metrics
# /etc/default/prometheus-node-exporter
ARGS="--collector.systemd \
      --collector.systemd.unit-include='^(myapp.*|postgresql|redis)\.service$'"
```

### Alerting Rules

```yaml
# prometheus-rules.yaml
groups:
  - name: systemd
    rules:
      - alert: SystemdServiceFailed
        expr: node_systemd_unit_state{state="failed"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "systemd unit {{ $labels.name }} has failed"
          description: "Unit {{ $labels.name }} on {{ $labels.instance }} is in failed state"

      - alert: SystemdServiceNotActive
        expr: |
          node_systemd_unit_state{name=~"(myapp|postgresql|redis).*\\.service",state="active"} == 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Expected service {{ $labels.name }} is not active"

      - alert: SystemdTimerMissed
        expr: |
          node_systemd_timer_last_trigger_seconds{name=~".*\\.timer"}
          < (time() - 3600)
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Timer {{ $labels.name }} has not triggered in over 1 hour"
```

## Summary

systemd's power goes far beyond process management. Unit file directives like `Type=notify`, `BindsTo=`, and `PartOf=` express precise service relationships. Socket activation enables zero-downtime restarts by decoupling connection acceptance from service availability. Timer units replace cron with dependency-aware, journald-integrated scheduling. Drop-in files allow configuration layering without touching vendor-installed files.

The dependency graph tools — `systemd-analyze dot`, `systemctl list-dependencies`, and the critical chain analysis — make it possible to diagnose boot ordering issues before they become production incidents. Combined with structured journald logging and Prometheus metrics via node_exporter, systemd becomes a complete service management platform for enterprise Linux environments.
