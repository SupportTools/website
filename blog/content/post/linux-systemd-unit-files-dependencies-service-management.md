---
title: "Linux Systemd: Unit Files, Dependencies, and Service Management for DevOps"
date: 2029-05-08T00:00:00-05:00
draft: false
tags: ["Linux", "Systemd", "DevOps", "Service Management", "Unit Files", "cgroups", "journald"]
categories:
- Linux
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive DevOps guide to Linux systemd: unit file syntax, dependency ordering, socket activation, systemd journal, cgroup delegation, systemd-analyze performance analysis, and drop-in overrides."
more_link: "yes"
url: "/linux-systemd-unit-files-dependencies-service-management/"
---

systemd is the init system and service manager on virtually every modern Linux distribution. For DevOps engineers, deep systemd knowledge translates directly into more reliable service deployments, faster boot times, better resource isolation, and more effective troubleshooting. This guide covers the essential systemd concepts that matter most for production infrastructure: unit file authoring, dependency resolution, socket activation, cgroup-based resource control, journal management, and the drop-in override pattern.

<!--more-->

# Linux Systemd: Unit Files, Dependencies, and Service Management for DevOps

## systemd Architecture

systemd manages the system as a graph of units. Each unit represents a resource: a service, a socket, a mount point, a timer, a device, or a scope. Units are described in unit files (`.service`, `.socket`, `.timer`, `.mount`, etc.) and loaded from several directories:

```
/lib/systemd/system/     (distribution-provided, do not edit)
/usr/lib/systemd/system/ (package-provided)
/etc/systemd/system/     (administrator overrides, highest priority)
/run/systemd/system/     (runtime units, ephemeral)
~/.config/systemd/user/  (user units)
```

Priority order: `/etc/systemd/system/` > `/run/systemd/system/` > `/lib/systemd/system/`

## Service Unit File Anatomy

```ini
# /etc/systemd/system/my-api.service
[Unit]
Description=My API Service
Documentation=https://docs.example.com/my-api
# Soft dependency: start after network is up, but do not fail if network is down
After=network.target
# Hard dependency: require network-online.target before starting
Wants=network-online.target
After=network-online.target
# Start after PostgreSQL if it is running
After=postgresql.service

[Service]
Type=simple                           # Main process is the service
User=myapp
Group=myapp
WorkingDirectory=/opt/my-api
ExecStart=/opt/my-api/bin/server --config /etc/my-api/config.yaml
ExecReload=/bin/kill -HUP $MAINPID   # Signal for config reload
ExecStop=/bin/kill -TERM $MAINPID    # Graceful shutdown signal
KillMode=mixed                        # Send SIGTERM, wait, then SIGKILL
KillSignal=SIGTERM
TimeoutStopSec=30                     # Wait 30s before SIGKILL
Restart=on-failure                    # Restart on non-zero exit
RestartSec=5s                         # Wait 5s before restart
StartLimitBurst=5                     # Allow 5 restarts
StartLimitIntervalSec=30s             # Within 30 seconds

# Environment
Environment=GOMAXPROCS=4
EnvironmentFile=-/etc/my-api/environment  # '-' prefix: ignore if file missing

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=my-api               # journald identifier tag

# Security hardening
PrivateTmp=true                       # Isolated /tmp
NoNewPrivileges=true                  # Disable setuid/setgid
ProtectSystem=strict                  # Read-only /usr, /boot, /etc
ProtectHome=true                      # No access to /home
ReadWritePaths=/var/lib/my-api        # Explicit writable paths
CapabilityBoundingSet=                # Drop all capabilities
AmbientCapabilities=                  # No ambient capabilities

[Install]
WantedBy=multi-user.target
```

## Service Types

The `Type=` directive controls how systemd considers the service "started":

### Type=simple (Default)

```ini
Type=simple
ExecStart=/usr/bin/my-server
# systemd considers the unit started immediately when ExecStart forks
# Use for processes that do not daemonize
```

### Type=exec

```ini
Type=exec
ExecStart=/usr/bin/my-server
# Like simple but waits for exec() to succeed before considering unit started
# Preferred over simple for most services
```

### Type=forking

```ini
Type=forking
PIDFile=/run/my-server.pid
ExecStart=/usr/bin/my-server --daemon
# For traditional Unix daemons that fork and exit
# systemd waits for the parent to exit and tracks the child via PIDFile
```

### Type=notify

```ini
Type=notify
ExecStart=/usr/bin/my-server
# Service explicitly signals systemd when ready via sd_notify()
# Most reliable readiness detection for complex services
```

Go example with sd_notify:

```go
import "github.com/coreos/go-systemd/v22/daemon"

func main() {
    server := initServer()

    // Signal systemd that we are ready
    sent, err := daemon.SdNotify(false, daemon.SdNotifyReady)
    if err != nil {
        log.Printf("sd_notify failed: %v", err)
    }
    if !sent {
        log.Println("sd_notify not supported (not running under systemd)")
    }

    server.Serve()
}
```

### Type=oneshot

```ini
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/setup-script.sh
# For scripts that run once and exit
# RemainAfterExit=yes lets other units depend on this unit persistently
```

## Dependency Directives

Understanding dependency semantics is critical for correct boot ordering.

### Requires vs Wants

```ini
# Requires: hard dependency -- if dependency fails, this unit fails
Requires=postgresql.service

# Wants: soft dependency -- start dependency if available, do not fail without it
Wants=redis.service

# BindsTo: stronger than Requires -- this unit stops when dependency stops
BindsTo=device-dev-sda.device

# PartOf: stopping/restarting parent also stops/restarts this unit
PartOf=app-stack.target
```

### After and Before

Dependency directives (`Requires`, `Wants`) establish existence dependencies but NOT ordering. Use `After`/`Before` for ordering:

```ini
# WRONG: This only ensures both start, not the order
Requires=database.service

# CORRECT: Start after database is fully up
Requires=database.service
After=database.service
```

The rule: `Requires=A` means A must be active when B is active. `After=A` means B starts after A. Both are needed for "B needs A running before B can start".

### Conflicts

```ini
# Cannot run simultaneously
Conflicts=my-service-old.service
```

### OnSuccess and OnFailure

```ini
# Start these units when this service succeeds or fails
OnSuccess=notify-success.service
OnFailure=notify-failure.service
```

## Target Units

Targets are synchronization points similar to SysV runlevels:

```
graphical.target          -- equivalent to runlevel 5
multi-user.target         -- equivalent to runlevel 3 (default for servers)
basic.target              -- early boot basics
network.target            -- network interfaces configured
network-online.target     -- network is actually reachable
sysinit.target            -- system initialization
local-fs.target           -- local filesystems mounted
```

### Custom Targets for Application Stacks

```ini
# /etc/systemd/system/my-app-stack.target
[Unit]
Description=My Application Stack
Wants=my-api.service my-worker.service my-scheduler.service
After=my-api.service my-worker.service my-scheduler.service
```

```bash
systemctl start my-app-stack.target   # Starts all three services
systemctl stop my-app-stack.target    # Stops all three services
```

## Socket Activation

Socket activation is one of systemd's most powerful features. systemd opens the socket before the service starts, eliminating the "service not ready" race condition at boot and enabling on-demand service activation.

### Benefits

1. **Parallel boot**: All services can start simultaneously -- systemd buffers socket connections until the service is ready.
2. **On-demand activation**: Service only starts when a connection arrives.
3. **Zero-downtime restarts**: Socket stays open during service restart; connections queue.

### Example: Socket-Activated Service

```ini
# /etc/systemd/system/my-api.socket
[Unit]
Description=My API Socket

[Socket]
ListenStream=0.0.0.0:8080
ListenStream=/run/my-api.sock
Accept=false
SocketMode=0660
SocketUser=myapp
SocketGroup=myapp
Backlog=4096
ReceiveBuffer=256K

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/my-api.service
[Unit]
Description=My API Service
Requires=my-api.socket
After=my-api.socket

[Service]
Type=notify
User=myapp
ExecStart=/opt/my-api/bin/server
StandardInput=socket
```

The service receives the pre-opened socket as file descriptor 3 via `sd_listen_fds()`:

```go
import "github.com/coreos/go-systemd/v22/activation"

func main() {
    // Get listeners from systemd socket activation
    listeners, err := activation.Listeners()
    if err != nil {
        log.Fatal(err)
    }

    var ln net.Listener
    if len(listeners) > 0 {
        // Socket-activated: use systemd's listener
        ln = listeners[0]
        log.Println("Using systemd socket activation")
    } else {
        // Not socket-activated: bind ourselves
        ln, err = net.Listen("tcp", ":8080")
        if err != nil {
            log.Fatal(err)
        }
    }

    daemon.SdNotify(false, daemon.SdNotifyReady)
    http.Serve(ln, handler)
}
```

Enable socket first; the service starts on demand:

```bash
systemctl enable --now my-api.socket
# my-api.service will start when first connection arrives
```

## Timer Units: Replacing Cron

systemd timers replace cron with better logging, dependency integration, and missed-run handling.

```ini
# /etc/systemd/system/db-backup.timer
[Unit]
Description=Database Backup Timer

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
RandomizedDelaySec=1800
AccuracySec=1min

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/db-backup.service
[Unit]
Description=Database Backup
After=postgresql.service

[Service]
Type=oneshot
User=backup
ExecStart=/usr/local/bin/backup-database.sh
CPUWeight=50
IOWeight=50
```

```bash
# Useful timer management commands
systemctl list-timers --all
systemctl start db-backup.timer
systemctl status db-backup.service

# Verify calendar expression
systemd-analyze calendar "*-*-* 02:00:00"
# Original form: *-*-* 02:00:00
#  Next elapse: Mon 2024-01-16 02:00:00 UTC
```

## systemd Journal

The systemd journal (`journald`) is a structured binary log store:

```bash
# Basic journal queries
journalctl -u my-api.service              # Logs for a specific unit
journalctl -u my-api -n 100               # Last 100 lines
journalctl -u my-api -f                   # Follow (like tail -f)
journalctl -u my-api --since "1 hour ago"
journalctl -p err                         # Only error priority and above
journalctl -p err -u my-api

# Boot-specific queries
journalctl -b                             # Current boot
journalctl -b -1                          # Previous boot
journalctl --list-boots

# JSON output for processing
journalctl -u my-api -o json-pretty | jq '.MESSAGE'
journalctl -u my-api -o json | \
  jq -r 'select(.__PRIORITY <= "3") | .MESSAGE'

# Kernel messages
journalctl -k
journalctl -k --since "10 minutes ago"

# Disk usage and cleanup
journalctl --disk-usage
journalctl --vacuum-time=30d
journalctl --vacuum-size=1G
```

### Journal Configuration

```ini
# /etc/systemd/journald.conf
[Journal]
Storage=persistent
Compress=yes
Seal=yes
SystemMaxUse=4G
SystemKeepFree=1G
SystemMaxFileSize=64M
MaxRetentionSec=30day
MaxFileSec=1week
RateLimitIntervalSec=30s
RateLimitBurst=10000
ForwardToSyslog=no
```

## cgroup Resource Control

systemd integrates with the kernel's cgroup v2 hierarchy to provide per-service resource limits.

### CPU and Memory Limits in Unit Files

```ini
[Service]
# CPU
CPUWeight=100             # Default weight (1-10000, default=100)
CPUQuota=200%             # Use at most 2 CPU cores
CPUAffinity=0-3           # Only run on CPUs 0-3

# Memory
MemoryMax=2G              # Hard limit: OOM-killed above this
MemoryHigh=1.5G           # Soft limit: throttled above this
MemorySwapMax=0           # Disable swap for this service
MemoryMin=256M            # Guaranteed minimum

# IO
IOWeight=100
IODeviceWeight=/dev/sda 200
IOReadBandwidthMax=/dev/sda 200M
IOWriteBandwidthMax=/dev/sda 100M

# Tasks
TasksMax=4096

# IP accounting
IPAccounting=yes
IPAddressAllow=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
IPAddressDeny=any
```

### cgroup Delegation for Container Runtimes

containerd and Kubernetes need to create sub-cgroups. Delegation grants this permission:

```ini
# /etc/systemd/system/containerd.service
[Service]
Delegate=yes
KillMode=process
OOMScoreAdjust=-999
```

### Checking cgroup Usage

```bash
# Real-time resource usage per service
systemd-cgtop

# Check a specific unit's cgroup
systemctl status my-api.service | grep CGroup
# CGroup: /system.slice/my-api.service
#         +-- 12345 /opt/my-api/bin/server

# Check actual cgroup values
cat /sys/fs/cgroup/system.slice/my-api.service/cpu.max
# 200000 100000   (200ms per 100ms period = 200% = 2 cores)

cat /sys/fs/cgroup/system.slice/my-api.service/memory.max
# 2147483648      (2GB)
```

## Drop-In Overrides

Drop-in overrides allow modifying unit files without editing the originals. This approach survives package upgrades.

### Creating a Drop-In

```bash
# Create the override interactively
systemctl edit my-api.service

# Or create manually
mkdir -p /etc/systemd/system/my-api.service.d/
cat > /etc/systemd/system/my-api.service.d/override.conf << 'OVERRIDE'
[Service]
Environment=DEBUG=true
MemoryMax=4G
Restart=always
OVERRIDE

# Apply changes
systemctl daemon-reload
systemctl restart my-api.service
```

### Drop-In for a Distribution Unit

```bash
# Override nginx's memory limit
mkdir -p /etc/systemd/system/nginx.service.d/

cat > /etc/systemd/system/nginx.service.d/memory.conf << 'OVERRIDE'
[Service]
MemoryMax=1G
MemoryHigh=800M
OVERRIDE

cat > /etc/systemd/system/nginx.service.d/restart.conf << 'OVERRIDE'
[Service]
Restart=always
RestartSec=2s
OVERRIDE

systemctl daemon-reload
```

### Viewing Effective Configuration

```bash
# Show merged configuration (original + all drop-ins)
systemctl cat my-api.service

# Show service configuration as parsed by systemd
systemctl show my-api.service

# Show only specific properties
systemctl show my-api.service -p Restart,RestartSec,MemoryMax
```

## systemd-analyze: Performance Analysis

```bash
# Show boot time breakdown
systemd-analyze

# Blame: units sorted by startup time
systemd-analyze blame | head -20
#   12.543s docker.service
#    8.234s containerd.service
#    4.123s kubelet.service

# Critical path through the dependency graph
systemd-analyze critical-chain multi-user.target

# Dependency graph (generate SVG)
systemd-analyze dot | dot -Tsvg > boot-deps.svg

# Verify unit files for errors
systemd-analyze verify /etc/systemd/system/my-api.service

# Show security score of a service
systemd-analyze security my-api.service
# my-api.service                     -- 5.2 MEDIUM
# (PrivateTmp missing, etc.)
```

## Hardening Services

systemd provides extensive security sandboxing:

```ini
[Service]
# Filesystem isolation
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes

# Capabilities
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=

# Network
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# System calls
SystemCallFilter=@system-service
SystemCallArchitectures=native
SystemCallErrorNumber=EPERM

# Misc
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RemoveIPC=yes
```

```bash
# Check hardening score
systemd-analyze security my-api.service
# NAME                                          DESCRIPTION
# ✗ PrivateNetwork=                             Service has access to the host's network
# ✓ PrivateTmp=                                 Service has no access to temp files
# ...
# Overall exposure level for my-api.service: 3.4 OK
```

## Practical Service Management Commands

```bash
# State management
systemctl start my-api.service
systemctl stop my-api.service
systemctl restart my-api.service
systemctl reload my-api.service
systemctl reload-or-restart my-api.service

# Enable/disable auto-start at boot
systemctl enable my-api.service
systemctl disable my-api.service
systemctl enable --now my-api.service
systemctl mask my-api.service           # Prevent starting
systemctl unmask my-api.service

# Status and introspection
systemctl status my-api.service
systemctl is-active my-api.service      # active, inactive, failed
systemctl is-enabled my-api.service     # enabled, disabled, static, masked
systemctl is-failed my-api.service
systemctl list-units --type=service
systemctl list-units --type=service --state=failed
systemctl list-dependencies my-api.service
systemctl list-dependencies --reverse my-api.service

# Reset after failure
systemctl reset-failed my-api.service
```

## Deploying a Go Service with systemd

Step-by-step deployment of a Go HTTP service:

```bash
# Create system user
useradd --system --no-create-home --shell /usr/sbin/nologin myapi

# Install binary
install -o root -g root -m 755 my-api /usr/local/bin/my-api

# Create data and config directories
install -d -o myapi -g myapi -m 750 /var/lib/myapi
install -d -o root -g myapi -m 750 /etc/myapi
```

```ini
# /etc/systemd/system/myapi.service
[Unit]
Description=My API Service
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=notify
User=myapi
Group=myapi
WorkingDirectory=/var/lib/myapi
ExecStart=/usr/local/bin/my-api --config /etc/myapi/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
StartLimitBurst=3
StartLimitIntervalSec=30s
EnvironmentFile=/etc/myapi/environment
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/myapi
CapabilityBoundingSet=
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myapi
MemoryMax=1G
CPUWeight=100
TasksMax=1024

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
systemctl daemon-reload
systemctl enable --now myapi.service
systemctl status myapi.service

# Verify logs
journalctl -u myapi -f
```

systemd's depth rewards engineers who invest in learning it. Socket activation alone can eliminate entire categories of race conditions at boot. The cgroup integration provides more reliable resource limits than any application-level throttling. And the journal's structured logging makes grep-based log analysis feel antiquated once you have experienced `journalctl`'s powerful filtering capabilities.
