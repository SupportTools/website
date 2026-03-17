---
title: "Linux Systemd Unit Files: Advanced Service Management for Production Workloads"
date: 2031-04-05T00:00:00-05:00
draft: false
tags: ["Linux", "systemd", "Service Management", "System Administration", "Production", "DevOps"]
categories:
- Linux
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced systemd unit file guide covering Service, Timer, and Socket activation unit types, dependency ordering, cgroup resource limits, watchdog integration, template units, and debugging with systemd-analyze."
more_link: "yes"
url: "/linux-systemd-unit-files-advanced-service-management-production/"
---

systemd is the standard init system on all major Linux distributions. Beyond basic service management, it provides timer-based job scheduling, socket-activated on-demand services, per-service resource accounting via cgroups, watchdog integration for automatic restart, and template units for managing fleets of similar services. This guide covers production-grade patterns that go well beyond `systemctl start`.

<!--more-->

# Linux Systemd Unit Files: Advanced Service Management for Production Workloads

## Unit File Fundamentals

Unit files are INI-format configuration files located in:
- `/usr/lib/systemd/system/`: Distribution-provided units (do not modify)
- `/etc/systemd/system/`: System-wide administrator overrides (highest priority)
- `/run/systemd/system/`: Runtime units (cleared on reboot)
- `~/.config/systemd/user/`: Per-user units (for `--user` mode)

## Section 1: Service Unit Deep Dive

### Production-Grade Service Unit

```ini
# /etc/systemd/system/myapp.service

[Unit]
Description=MyApp Production Service
# Human-readable documentation
Documentation=https://docs.example.com/myapp
# man:myapp(8)

# Hard dependency: if network-online.target fails, this unit fails
Requires=network-online.target

# Soft dependency: start after these units if they are enabled,
# but don't fail if they aren't
Wants=postgresql.service redis.service

# Ordering: start after these units regardless of dependency type
After=network-online.target postgresql.service redis.service

# Conflict: this service cannot run simultaneously with myapp-maintenance.service
Conflicts=myapp-maintenance.service

[Service]
# Type=notify means the service notifies systemd when it is ready
# using sd_notify(). Other types: simple, exec, forking, oneshot, idle
Type=notify

# Run as a dedicated non-root user
User=myapp
Group=myapp

# Working directory for the process
WorkingDirectory=/opt/myapp

# Path to the binary. Use absolute paths.
ExecStart=/opt/myapp/bin/myapp \
    --config /etc/myapp/config.yaml \
    --port 8080

# Command to send SIGUSR1 to trigger log rotation
ExecReload=/bin/kill -USR1 $MAINPID

# ExecStop is optional; systemd sends SIGTERM by default
ExecStop=/opt/myapp/bin/myapp-graceful-stop

# Environment variables
Environment=APP_ENV=production
Environment=LOG_LEVEL=info
# Load sensitive vars from a file (640 root:myapp permissions)
EnvironmentFile=-/etc/myapp/environment

# Restart policy
Restart=on-failure
RestartSec=5s
# Restart up to 5 times within 60 seconds before failing permanently
StartLimitIntervalSec=60
StartLimitBurst=5

# Timeout settings
TimeoutStartSec=90s
TimeoutStopSec=30s
TimeoutAbortSec=60s

# Watchdog: the service must call sd_notify("WATCHDOG=1") at least
# every WatchdogSec interval. If it doesn't, systemd restarts it.
WatchdogSec=30s
NotifyAccess=main

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/myapp /var/log/myapp
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
# Restrict available system calls
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# Restrict address families
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myapp

[Install]
WantedBy=multi-user.target
```

### Systemd Watchdog Integration in Go

```go
// pkg/systemd/watchdog.go
package systemd

import (
    "context"
    "fmt"
    "net"
    "os"
    "strconv"
    "strings"
    "time"
)

// Notify sends a notification string to the systemd socket.
func Notify(state string) error {
    socketPath := os.Getenv("NOTIFY_SOCKET")
    if socketPath == "" {
        return nil // Not running under systemd
    }

    conn, err := net.Dial("unixgram", socketPath)
    if err != nil {
        return fmt.Errorf("connecting to notify socket: %w", err)
    }
    defer conn.Close()

    _, err = conn.Write([]byte(state))
    return err
}

// NotifyReady tells systemd the service is ready to receive connections.
func NotifyReady() error {
    return Notify("READY=1")
}

// NotifyStopping tells systemd the service is beginning its shutdown.
func NotifyStopping() error {
    return Notify("STOPPING=1")
}

// NotifyWatchdog resets the watchdog timer.
func NotifyWatchdog() error {
    return Notify("WATCHDOG=1")
}

// NotifyStatus sends an arbitrary status string visible in systemctl status.
func NotifyStatus(status string) error {
    return Notify(fmt.Sprintf("STATUS=%s", status))
}

// WatchdogInterval returns the watchdog interval from the environment.
// Returns 0 if no watchdog is configured.
func WatchdogInterval() time.Duration {
    usec := os.Getenv("WATCHDOG_USEC")
    if usec == "" {
        return 0
    }
    n, err := strconv.ParseInt(usec, 10, 64)
    if err != nil {
        return 0
    }
    return time.Duration(n) * time.Microsecond
}

// StartWatchdog starts a background goroutine that pings the watchdog
// at half the configured interval to ensure reliable health signaling.
func StartWatchdog(ctx context.Context) {
    interval := WatchdogInterval()
    if interval == 0 {
        return
    }

    pingInterval := interval / 2
    go func() {
        ticker := time.NewTicker(pingInterval)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                if err := NotifyWatchdog(); err != nil {
                    // Log the error but don't exit; systemd will handle timeout
                    _ = err
                }
            case <-ctx.Done():
                return
            }
        }
    }()
}
```

```go
// main.go - integrating systemd notifications
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"

    "github.com/example/myapp/pkg/systemd"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Initialize application...
    server := &http.Server{Addr: ":8080"}

    // Start watchdog before server is ready
    systemd.StartWatchdog(ctx)

    // Start server
    go server.ListenAndServe()

    // Notify systemd that we are ready (required for Type=notify)
    systemd.NotifyReady()
    systemd.NotifyStatus("Serving on :8080")
    slog.Info("Service ready")

    // Wait for termination signal
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    <-sigCh

    // Notify systemd that shutdown has begun
    systemd.NotifyStatus("Shutting down gracefully...")
    systemd.NotifyStopping()

    // Graceful shutdown
    shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 30*time.Second)
    defer shutdownCancel()
    server.Shutdown(shutdownCtx)
}
```

## Section 2: Timer Units

Timer units replace cron jobs with better dependency handling, logging, and on-demand triggering.

### Recurring Timer Unit

```ini
# /etc/systemd/system/database-backup.timer

[Unit]
Description=Daily Database Backup Timer
Documentation=https://docs.example.com/backup

[Timer]
# Run daily at 2:30 AM (local time)
OnCalendar=*-*-* 02:30:00
# Add up to 5 minutes of random delay to prevent thundering herd
RandomizedDelaySec=5min
# Catch up missed runs if the system was offline
Persistent=true
# The service unit to activate (defaults to same name with .service extension)
Unit=database-backup.service

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/database-backup.service
# This service is triggered by the timer, not started directly.

[Unit]
Description=Database Backup Job
After=postgresql.service
Requires=postgresql.service

[Service]
Type=oneshot
User=backup
Group=backup
ExecStart=/opt/backup/scripts/backup-postgres.sh
# Environment for backup destination
Environment=BACKUP_DEST=s3://mycompany-backups/postgres
EnvironmentFile=-/etc/backup/environment

# Security hardening for oneshot jobs
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/backup
PrivateTmp=yes

# Email notification on failure
OnFailure=email-notify@%n.service

# stdout/stderr goes to journal with unit identifier
StandardOutput=journal
StandardError=journal
SyslogIdentifier=database-backup
```

### Monotonic Timer (Run After Boot)

```ini
# Run 10 minutes after system boot, then every 6 hours
[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
```

### Calendar Expression Examples

```bash
# systemd-analyze calendar - validate and preview calendar expressions

# Every day at midnight
systemd-analyze calendar "daily"
# 2031-04-05 00:00:00 UTC (next trigger)

# Every weekday at 8 AM
systemd-analyze calendar "Mon..Fri 08:00:00"

# Every 15 minutes
systemd-analyze calendar "*:0/15"

# First Monday of every month at 3 AM
systemd-analyze calendar "Mon *-*-1..7 03:00:00"

# Every hour on the hour, except 0200-0400 (maintenance window)
# (systemd doesn't support exclusions; use two timers or script logic)

# List all active timers
systemctl list-timers --all

# Force-run a timer unit's service immediately
systemctl start database-backup.service
```

### Transient Timers with systemd-run

```bash
# Run a one-off job 30 minutes from now
systemd-run --on-active=30min /opt/scripts/send-report.sh

# Run a job at a specific calendar time
systemd-run --on-calendar="2031-04-06 14:00:00" /opt/scripts/send-report.sh

# Run with resource limits
systemd-run --unit=temp-job \
  --property=CPUQuota=50% \
  --property=MemoryLimit=512M \
  --on-active=5min \
  /opt/scripts/heavy-job.sh
```

## Section 3: Socket Activation

Socket activation allows systemd to listen on a socket and start the service only when a connection arrives. This improves boot time and allows zero-downtime restarts.

### Socket Unit

```ini
# /etc/systemd/system/myapp.socket

[Unit]
Description=MyApp Socket Activation

[Socket]
# TCP socket
ListenStream=0.0.0.0:8080
# Accept=no means the service handles connections via the fd passed by systemd
Accept=no
# Backlog size
Backlog=2048
# Keep-alive
KeepAlive=yes
# File descriptor name (used by sd_listen_fds_with_names)
FileDescriptorName=myapp-http

# Unix socket example:
# ListenStream=/run/myapp/myapp.sock
# SocketMode=0660
# SocketUser=www-data
# SocketGroup=myapp

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/myapp.service (modified for socket activation)

[Unit]
Description=MyApp Production Service
Requires=myapp.socket
After=myapp.socket

[Service]
Type=notify
User=myapp
ExecStart=/opt/myapp/bin/myapp --config /etc/myapp/config.yaml
# Inherit the socket from systemd instead of binding it
# The app uses sd_listen_fds() or checks LISTEN_FDS env var
NonBlocking=yes

[Install]
WantedBy=multi-user.target
Also=myapp.socket
```

### Using Socket Activation in Go

```go
// pkg/systemd/socket.go
package systemd

import (
    "fmt"
    "net"
    "os"
    "strconv"
    "syscall"
)

// ListenFDs returns file descriptors passed by systemd via socket activation.
// The first fd is always 3 (SD_LISTEN_FDS_START).
func ListenFDs() ([]net.Listener, error) {
    listenFDsStr := os.Getenv("LISTEN_FDS")
    if listenFDsStr == "" {
        return nil, nil // Not socket-activated
    }

    n, err := strconv.Atoi(listenFDsStr)
    if err != nil {
        return nil, fmt.Errorf("parsing LISTEN_FDS: %w", err)
    }

    const SD_LISTEN_FDS_START = 3
    listeners := make([]net.Listener, n)
    for i := 0; i < n; i++ {
        fd := SD_LISTEN_FDS_START + i
        // Set close-on-exec flag
        syscall.CloseOnExec(fd)
        f := os.NewFile(uintptr(fd), fmt.Sprintf("socket-activation-fd-%d", i))
        ln, err := net.FileListener(f)
        if err != nil {
            return nil, fmt.Errorf("creating listener from fd %d: %w", fd, err)
        }
        listeners[i] = ln
    }
    return listeners, nil
}

// ListenOrFallback returns systemd-provided listeners or creates new ones
// if not socket-activated. This allows the service to work both with and
// without socket activation.
func ListenOrFallback(addr string) (net.Listener, error) {
    listeners, err := ListenFDs()
    if err != nil {
        return nil, err
    }
    if len(listeners) > 0 {
        return listeners[0], nil
    }
    // Not socket-activated, create our own listener
    return net.Listen("tcp", addr)
}
```

```go
// Usage in main.go
func main() {
    listener, err := systemd.ListenOrFallback(":8080")
    if err != nil {
        log.Fatalf("failed to create listener: %v", err)
    }

    server := &http.Server{Handler: router}

    systemd.NotifyReady()
    if err := server.Serve(listener); err != http.ErrServerClosed {
        log.Fatalf("server error: %v", err)
    }
}
```

## Section 4: Dependency Ordering

Understanding the difference between Requires, Wants, After, and Before is essential for correct dependency graphs.

### Dependency Types Explained

```ini
[Unit]
# Requires: Hard dependency. If dependency fails to start, this unit fails.
# The dependency is also stopped when this unit stops.
Requires=postgresql.service

# Wants: Soft dependency. Start the dependency if possible, but continue
# even if it fails.
Wants=metrics-agent.service

# BindsTo: Even stronger than Requires. If the dependency stops, this
# unit is also immediately stopped.
BindsTo=docker.service

# PartOf: This unit is part of the listed unit. When the listed unit
# is stopped or restarted, this unit is too. Does not pull in dependencies.
PartOf=myapp.target

# After: Start this unit after the listed units. Pure ordering, no dependency.
# Without After, units could start in parallel even with Requires.
After=network-online.target postgresql.service

# Before: Start this unit before the listed units.
Before=myapp-migration.service

# Conflicts: This unit cannot run at the same time as the listed units.
Conflicts=myapp-maintenance.service
```

### Creating Custom Targets

```ini
# /etc/systemd/system/myapp.target
# A target is a synchronization point and dependency anchor.

[Unit]
Description=MyApp Stack
# This target is reached when all components are running
Requires=myapp.service myapp-worker.service
After=myapp.service myapp-worker.service
```

```ini
# Pull in the target from the service
# myapp.service
[Install]
WantedBy=myapp.target multi-user.target
```

```bash
# Start the entire application stack
systemctl start myapp.target

# Check status of all units in the target
systemctl status myapp.target
```

## Section 5: Resource Limits via cgroups

systemd's cgroup integration allows fine-grained resource controls per service.

### CPU Limits

```ini
[Service]
# CPUQuota: percentage of a single CPU
# 50% = half a CPU, 200% = 2 CPUs
CPUQuota=200%

# CPUShares: relative weight for CPU time (deprecated in v2, use CPUWeight)
CPUWeight=100
# Default is 100, range 1-10000

# CPUAffinity: pin to specific CPUs
CPUAffinity=0 1 2 3

# Real-time CPU scheduling (requires CAP_SYS_NICE or elevated privileges)
# CPUSchedulingPolicy=rr
# CPUSchedulingPriority=50
```

### Memory Limits

```ini
[Service]
# Hard limit: OOM kill at this usage
MemoryMax=2G

# Soft limit: can be exceeded temporarily, triggers memory reclaim
MemoryHigh=1.5G

# Swap limit (requires kernel support)
MemorySwapMax=0

# Memory low: guaranteed minimum
MemoryLow=256M
```

### I/O Limits

```ini
[Service]
# Limit I/O weight relative to other services (1-10000)
IOWeight=200

# Limit specific device read/write bandwidth
IOReadBandwidthMax=/dev/sda 50M
IOWriteBandwidthMax=/dev/sda 50M

# Limit I/O operations per second
IOReadIOPSMax=/dev/sda 1000
IOWriteIOPSMax=/dev/sda 500
```

### File Descriptor and Process Limits

```ini
[Service]
# Maximum number of file descriptors
LimitNOFILE=65536

# Maximum number of processes/threads
LimitNPROC=4096

# Core dump size (0 = no core dumps)
LimitCORE=0

# Maximum stack size
LimitSTACK=8M

# These correspond to ulimit settings:
# LimitNOFILE = ulimit -n
# LimitNPROC  = ulimit -u
# LimitCORE   = ulimit -c
```

### Checking cgroup Usage

```bash
# View resource usage for a service
systemctl status myapp.service

# Detailed cgroup stats
systemd-cgtop myapp.service

# View cgroup hierarchy
systemd-cgls

# Check current limits
systemctl show myapp.service | grep -E "CPU|Memory|IO|Limit"

# Real-time resource usage
systemd-cgtop
```

## Section 6: Template Units (Instantiated Units)

Template units allow creating multiple instances of a service from a single unit file.

### Template Unit Syntax

A template unit filename contains `@`: `myapp@.service`. Instances are created as `myapp@instance-name.service`.

```ini
# /etc/systemd/system/worker@.service
# The %i specifier expands to the instance name

[Unit]
Description=MyApp Worker Instance %i
After=network-online.target postgresql.service

[Service]
Type=notify
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp

# %i = instance name (between @ and .service)
ExecStart=/opt/myapp/bin/worker \
    --worker-id %i \
    --queue-prefix %i-

# Instance-specific log file using %i
StandardOutput=journal
SyslogIdentifier=worker-%i

# Instance-specific environment file
EnvironmentFile=-/etc/myapp/worker-%i.env

Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start specific instances
systemctl enable worker@north.service worker@south.service worker@east.service
systemctl start worker@north.service worker@south.service worker@east.service

# Check all instances
systemctl status 'worker@*'

# View logs from a specific instance
journalctl -u worker@north.service -f

# View logs from all instances of the template
journalctl -u 'worker@*' -f

# Stop all instances
systemctl stop 'worker@*'
```

### Dynamic Instance Management

```bash
#!/bin/bash
# manage-workers.sh - dynamically manage worker instances based on a config file

CONFIG_FILE="/etc/myapp/workers.conf"
TEMPLATE="worker"

# Read desired worker list from config
mapfile -t DESIRED_WORKERS < "${CONFIG_FILE}"

# Get currently running workers
RUNNING_WORKERS=$(systemctl list-units --state=running "${TEMPLATE}@*.service" \
    --no-legend --plain | awk '{print $1}' | \
    sed "s/${TEMPLATE}@//;s/\.service//")

# Start new workers
for worker in "${DESIRED_WORKERS[@]}"; do
    if ! echo "${RUNNING_WORKERS}" | grep -q "^${worker}$"; then
        echo "Starting new worker: ${worker}"
        systemctl start "${TEMPLATE}@${worker}.service"
    fi
done

# Stop removed workers
for worker in ${RUNNING_WORKERS}; do
    if ! printf '%s\n' "${DESIRED_WORKERS[@]}" | grep -q "^${worker}$"; then
        echo "Stopping removed worker: ${worker}"
        systemctl stop "${TEMPLATE}@${worker}.service"
    fi
done
```

### Template Unit with TCP Socket Per Instance

```ini
# /etc/systemd/system/myapp@.socket
[Unit]
Description=MyApp Socket for Instance %i

[Socket]
# Use different ports per instance (base port + instance offset)
# Instance "0" gets port 8080, "1" gets 8081, etc.
ListenStream=808%i

[Install]
WantedBy=sockets.target
```

## Section 7: Debugging with systemd-analyze

### Boot Performance Analysis

```bash
# Overall boot time breakdown
systemd-analyze
# Startup finished in 2.891s (kernel) + 4.521s (initrd) + 8.340s (userspace) = 15.752s

# Per-unit startup times (slowest first)
systemd-analyze blame

# Critical path (slowest sequential chain)
systemd-analyze critical-chain

# Generate SVG visualization of boot sequence
systemd-analyze plot > /tmp/boot-sequence.svg

# Check specific unit's startup time
systemd-analyze blame | grep myapp
```

### Dependency Analysis

```bash
# Show what a unit requires/wants
systemctl list-dependencies myapp.service

# Show what would be started/stopped with a unit (reverse deps)
systemctl list-dependencies --reverse myapp.service

# Check if units would conflict
systemd-analyze verify /etc/systemd/system/myapp.service

# Check security score of a service
systemd-analyze security myapp.service
# Outputs per-hardening-feature score and overall exposure score
```

### Unit File Validation

```bash
# Validate unit file syntax
systemd-analyze verify /etc/systemd/system/myapp.service
# Note: checks syntax and references, not semantic correctness

# Check what happens when starting a unit (dry run sort of)
systemctl --no-block start myapp.service

# Show effective settings after all overrides applied
systemctl cat myapp.service

# Show computed configuration (with defaults filled in)
systemctl show myapp.service

# Show systemd logs with full context
journalctl -xe -u myapp.service
```

### Creating Drop-in Override Files

Instead of modifying the original unit file (which may be overwritten on package updates), use drop-in overrides:

```bash
# Create override directory and file
systemctl edit myapp.service
# Opens /etc/systemd/system/myapp.service.d/override.conf in editor

# Or manually:
mkdir -p /etc/systemd/system/myapp.service.d/
cat > /etc/systemd/system/myapp.service.d/limits.conf <<'EOF'
[Service]
# These settings override (or in most cases extend) the original unit
LimitNOFILE=100000
MemoryMax=4G
CPUQuota=400%

# To clear a list-type directive before adding new values:
Environment=
Environment=APP_ENV=production
Environment=LOG_LEVEL=debug
EOF

# Reload systemd configuration
systemctl daemon-reload

# Verify the override is applied
systemctl cat myapp.service
# Shows the original unit + the override sections

systemctl restart myapp.service
```

### Advanced Journalctl Usage

```bash
# Follow service logs in real time
journalctl -u myapp.service -f

# Show last 100 lines from a service
journalctl -u myapp.service -n 100

# Show logs since a specific time
journalctl -u myapp.service --since "2031-04-05 10:00:00" --until "2031-04-05 11:00:00"

# Show only error-level and above
journalctl -u myapp.service -p err

# JSON output for log aggregation
journalctl -u myapp.service -o json | jq '.MESSAGE'

# Show logs from this boot only
journalctl -u myapp.service -b

# Export logs for archiving
journalctl -u myapp.service --since yesterday -o export | gzip > myapp-logs-yesterday.gz
```

## Section 8: Advanced Patterns

### One-Shot Migration Service

```ini
# /etc/systemd/system/myapp-migrate.service

[Unit]
Description=MyApp Database Migration
# Run before the main app
Before=myapp.service
After=postgresql.service
Requires=postgresql.service
# Only run once at install time; after success, won't run again
# until manually triggered or on next install
ConditionPathExists=!/var/lib/myapp/.migration-complete

[Service]
Type=oneshot
# Keep the "success" state even after exit
RemainAfterExit=yes
User=myapp
ExecStart=/opt/myapp/bin/migrate --config /etc/myapp/config.yaml up
ExecStartPost=/bin/touch /var/lib/myapp/.migration-complete

[Install]
WantedBy=myapp.service
```

### Failure Notification Service

```ini
# /etc/systemd/system/email-notify@.service
# Sends email on service failure when OnFailure=email-notify@%n.service is set

[Unit]
Description=Email notification for failed unit: %i

[Service]
Type=oneshot
ExecStart=/opt/scripts/notify-failure.sh %i
User=root
```

```bash
#!/bin/bash
# /opt/scripts/notify-failure.sh
UNIT="${1}"
HOSTNAME=$(hostname -f)

# Get failure details from journal
JOURNAL_TAIL=$(journalctl -u "${UNIT}" -n 50 --no-pager -o short)

mail -s "[ALERT] Service failure: ${UNIT} on ${HOSTNAME}" \
  ops-team@example.com <<EOF
Service ${UNIT} has failed on ${HOSTNAME}.

Last 50 journal lines:
${JOURNAL_TAIL}
EOF
```

### Conditional Unit Loading

```ini
[Unit]
# Only start on specific hardware
ConditionVirtualization=!container
ConditionVirtualization=!vm

# Only start if a file exists
ConditionPathExists=/dev/mydevice

# Only start if a path is a mount point
ConditionPathIsMountPoint=/mnt/data

# Only start on specific architecture
ConditionArchitecture=x86-64

# Only if kernel version matches
ConditionKernelVersion=>=5.15
```

## Conclusion

systemd's unit file system provides the primitives for building robust, observable production services: socket activation for zero-downtime restarts, timer units with proper catch-up semantics, per-service cgroup isolation for predictable resource behavior, template units for fleet management, and drop-in overrides for clean customization. The debugging tools—systemd-analyze, journalctl, and `systemctl cat`—provide deep visibility into service dependencies, boot performance, and effective configuration. Investing in well-crafted unit files pays dividends in operational reliability and reduces incident response time when things go wrong.
