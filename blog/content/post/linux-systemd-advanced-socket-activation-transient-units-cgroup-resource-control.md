---
title: "Linux systemd Advanced: Socket Activation, Transient Units, cgroup Resource Control, and Dependency Ordering"
date: 2031-10-21T00:00:00-05:00
draft: false
tags: ["Linux", "systemd", "cgroups", "Socket Activation", "System Administration", "Resource Management"]
categories:
- Linux
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise deep-dive into advanced systemd features covering socket-activated services, on-demand transient units, cgroup v2 resource controls, precise dependency ordering, and production hardening patterns."
more_link: "yes"
url: "/linux-systemd-advanced-socket-activation-transient-units-cgroup-resource-control/"
---

systemd manages the majority of production Linux workloads, yet most administrators only use a fraction of its capabilities. Socket activation enables zero-downtime restarts and on-demand startup without a proxy daemon. Transient units allow programmatic service creation without writing unit files. The cgroup v2 integration provides precise CPU, memory, and I/O controls that enforcement at the kernel level. This guide covers each feature at the configuration depth required for production operation.

<!--more-->

# Linux systemd Advanced Configuration

## Section 1: Socket Activation Deep Dive

Socket activation decouples socket creation from service startup. systemd creates and holds the socket, the service inherits it when the first connection arrives. Services can restart without dropping connections — the socket remains open in systemd while the service restarts, and the OS buffers incoming connections.

### Basic Socket Unit

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=MyApp Socket
Documentation=https://example.com/docs/myapp

[Socket]
# TCP socket
ListenStream=8080
# Bind only to specific interface
BindToDevice=eth0
# Set socket options
ReusePort=yes
Backlog=4096
# Accept queue for large bursts
SocketMode=0660
SocketUser=myapp
SocketGroup=myapp
# Pass socket as SD_LISTEN_FDS
FileDescriptorName=myapp-http
# Keep socket open when service is stopped (allows connection queuing)
Service=myapp.service

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=MyApp Web Service
Documentation=https://example.com/docs/myapp
# Requires socket activation
Requires=myapp.socket
# Start after socket is ready
After=myapp.socket network-online.target
# Restart on failure but not if explicitly stopped
RefuseManualStart=no

[Service]
Type=notify           # Service sends sd_notify() when ready
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp

# The service reads LISTEN_FDS and LISTEN_PID environment variables
Environment="GOMAXPROCS=4"
ExecStart=/opt/myapp/bin/myapp --config /etc/myapp/config.yaml

# Graceful shutdown — send SIGTERM, wait 30s, then SIGKILL
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30s
FinalKillSignal=SIGKILL

# Restart policy
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60s
StartLimitBurst=3

[Install]
WantedBy=multi-user.target
```

### Application Side: Reading SD_LISTEN_FDS

```go
// socket_activation.go — Go application receiving socket-activated FDs
package main

import (
    "net"
    "os"
    "strconv"
    "syscall"
    "fmt"
)

const (
    sdListenFdsStart = 3     // First FD for socket activation (after stdin/stdout/stderr)
    envListenFds     = "LISTEN_FDS"
    envListenPid     = "LISTEN_PID"
    envListenNames   = "LISTEN_FDNAMES"
)

// GetSocketActivationListeners returns net.Listener slice from socket activation.
func GetSocketActivationListeners() ([]net.Listener, error) {
    pidStr := os.Getenv(envListenPid)
    if pidStr == "" {
        return nil, nil  // Not socket-activated
    }

    pid, err := strconv.Atoi(pidStr)
    if err != nil || pid != os.Getpid() {
        return nil, nil
    }

    nfdsStr := os.Getenv(envListenFds)
    if nfdsStr == "" {
        return nil, nil
    }

    nfds, err := strconv.Atoi(nfdsStr)
    if err != nil || nfds == 0 {
        return nil, nil
    }

    listeners := make([]net.Listener, nfds)
    for i := 0; i < nfds; i++ {
        fd := sdListenFdsStart + i
        // Set close-on-exec
        syscall.CloseOnExec(fd)

        f := os.NewFile(uintptr(fd), fmt.Sprintf("socket-activation-fd-%d", i))
        l, err := net.FileListener(f)
        f.Close()  // FileListener dup()s the fd
        if err != nil {
            return nil, fmt.Errorf("create listener from fd %d: %w", fd, err)
        }
        listeners[i] = l
    }

    return listeners, nil
}

// Or use the official systemd library
// import "github.com/coreos/go-systemd/v22/activation"
//
// listeners, err := activation.Listeners()
// if err != nil || len(listeners) == 0 {
//     // Fall back to manual bind
//     l, err = net.Listen("tcp", ":8080")
// }
```

### Multi-Socket Activation (HTTP + HTTPS + Admin)

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=MyApp Sockets

[Socket]
ListenStream=8080
ListenStream=8443
ListenStream=127.0.0.1:9090
# Named FDs for the application to identify each socket
FileDescriptorName=http
FileDescriptorName=https
FileDescriptorName=admin

ReusePort=yes
Backlog=1024

[Install]
WantedBy=sockets.target
```

```bash
# Verify socket activation is working
systemctl start myapp.socket
systemctl status myapp.socket

# The service is NOT running yet — it starts on first connection
systemctl status myapp.service  # inactive (dead)

# Send a connection — service starts automatically
curl http://localhost:8080/health
systemctl status myapp.service  # active (running)

# Zero-downtime restart — socket stays open
systemctl restart myapp.service
# During restart, new connections queue in the kernel socket buffer
# After service restarts, it drains the queue
```

## Section 2: Transient Units

Transient units are created at runtime via D-Bus without writing unit files to disk. Essential for batch job scheduling, container runtimes, and tooling that spawns ephemeral processes.

### systemd-run for Transient Services

```bash
# Run a one-shot command as a transient unit with resource limits
systemd-run \
  --unit=data-migration \
  --description="Database migration job" \
  --property=User=dbmigrate \
  --property=WorkingDirectory=/opt/migrate \
  --property=MemoryMax=4G \
  --property=CPUQuota=200% \
  --property=IOWeight=50 \
  --property=TimeoutStopSec=300 \
  --setenv=DB_URL="postgres://migrate:password@db.internal:5432/prod" \
  --on-active=0 \
  /opt/migrate/bin/migrate --direction up --count all

# Monitor the unit
systemctl status data-migration.service
journalctl -u data-migration.service -f

# Run interactively in a transient scope (attach to current shell's cgroup)
systemd-run --scope --slice=user.slice --description="dev shell" \
  --property=CPUWeight=50 \
  --property=MemoryMax=2G \
  bash

# Schedule a transient timer
systemd-run \
  --unit=nightly-report \
  --on-calendar="*-*-* 02:00:00" \
  --property=User=reporting \
  /opt/reporting/bin/generate-nightly-report
```

### Programmatic Transient Unit Creation via D-Bus (Go)

```go
// transient_unit.go
package systemd

import (
    "context"
    "fmt"

    dbus "github.com/coreos/go-systemd/v22/dbus"
)

type UnitConfig struct {
    Name        string
    Description string
    ExecStart   string
    User        string
    Group       string
    MemoryMax   string  // e.g., "4G"
    CPUQuota    string  // e.g., "200%"
    Environment []string
    OnSuccess   string  // Unit to start on success
    OnFailure   string  // Unit to start on failure
}

// StartTransientService creates and starts a transient systemd service.
func StartTransientService(ctx context.Context, cfg UnitConfig) (string, error) {
    conn, err := dbus.NewSystemdConnectionContext(ctx)
    if err != nil {
        return "", fmt.Errorf("connect to systemd: %w", err)
    }
    defer conn.Close()

    props := []dbus.Property{
        dbus.PropDescription(cfg.Description),
        dbus.PropExecStart([]string{cfg.ExecStart}, false),
        dbus.PropType("oneshot"),
        {
            Name:  "RemainAfterExit",
            Value: dbus.NewVariant(false),
        },
    }

    if cfg.User != "" {
        props = append(props, dbus.Property{
            Name:  "User",
            Value: dbus.NewVariant(cfg.User),
        })
    }

    if cfg.MemoryMax != "" {
        // Convert "4G" to bytes
        props = append(props, dbus.Property{
            Name:  "MemoryMax",
            Value: dbus.NewVariant(parseBytes(cfg.MemoryMax)),
        })
    }

    if len(cfg.Environment) > 0 {
        props = append(props, dbus.Property{
            Name:  "Environment",
            Value: dbus.NewVariant(cfg.Environment),
        })
    }

    resultCh := make(chan string, 1)
    _, err = conn.StartTransientUnitContext(ctx, cfg.Name+".service", "fail", props, resultCh)
    if err != nil {
        return "", fmt.Errorf("start transient unit: %w", err)
    }

    result := <-resultCh
    return result, nil
}

func parseBytes(s string) uint64 {
    // Simplified parser for "4G", "512M", "1T"
    if len(s) == 0 {
        return 0
    }
    suffix := s[len(s)-1]
    val := uint64(0)
    fmt.Sscanf(s[:len(s)-1], "%d", &val)
    switch suffix {
    case 'K', 'k':
        return val * 1024
    case 'M', 'm':
        return val * 1024 * 1024
    case 'G', 'g':
        return val * 1024 * 1024 * 1024
    case 'T', 't':
        return val * 1024 * 1024 * 1024 * 1024
    }
    return val
}
```

## Section 3: cgroup v2 Resource Control

### CPU Controls

```ini
# /etc/systemd/system/cpu-intensive.service
[Service]
# CPUWeight: relative weight (1-10000, default 100)
# At 200, this service gets 2x more CPU than default-weighted services
CPUWeight=200

# CPUQuota: hard limit as percentage of one CPU
# 400% = up to 4 CPUs worth of time
CPUQuota=400%

# CPUAffinity: pin to specific CPUs
CPUAffinity=2 3 4 5  # CPUs 2-5

# NUMAPolicy: NUMA memory policy
NUMAPolicy=bind
NUMAMask=0  # NUMA node 0
```

```bash
# Verify CPU limits are applied to cgroup
cat /sys/fs/cgroup/system.slice/cpu-intensive.service/cpu.max
# 400000 100000  (400% of one CPU in 100ms periods)

cat /sys/fs/cgroup/system.slice/cpu-intensive.service/cpu.weight
# 200

# Real-time monitoring of cgroup CPU usage
systemd-cgtop -d 1 -n 20
```

### Memory Controls

```ini
# /etc/systemd/system/memory-managed.service
[Service]
# MemoryMin: memory this unit is guaranteed (never reclaimed)
MemoryMin=256M

# MemoryLow: soft lower bound (reclaimed only when under pressure)
MemoryLow=512M

# MemoryHigh: soft upper bound (processes slow but don't OOM)
# Processes exceeding MemoryHigh get throttled by the kernel
MemoryHigh=1.5G

# MemoryMax: hard upper bound (OOM kill if exceeded)
MemoryMax=2G

# MemorySwapMax: limit swap usage
MemorySwapMax=0  # No swap for this service

# OOMPolicy: what to do when OOM killer is invoked
OOMPolicy=continue  # Kill only the offending process, not the service
# Or: OOMPolicy=stop — kill the entire service on OOM
```

```bash
# Check current memory usage
systemctl status memory-managed.service
cat /sys/fs/cgroup/system.slice/memory-managed.service/memory.current
cat /sys/fs/cgroup/system.slice/memory-managed.service/memory.stat

# OOM history
journalctl -k --grep "Out of memory" | tail -20
```

### I/O Controls

```ini
# /etc/systemd/system/io-controlled.service
[Service]
# IOWeight: relative I/O weight (1-10000, default 100)
IOWeight=50   # This service gets half the I/O of default services

# IODeviceWeight: per-device weight
IODeviceWeight=/dev/nvme0n1 200

# IOReadBandwidthMax: hard read bandwidth limit
IOReadBandwidthMax=/dev/nvme0n1 500M

# IOWriteBandwidthMax: hard write bandwidth limit
IOWriteBandwidthMax=/dev/nvme0n1 200M

# IOReadIOPSMax: hard read IOPS limit
IOReadIOPSMax=/dev/nvme0n1 50000

# IOWriteIOPSMax: hard write IOPS limit
IOWriteIOPSMax=/dev/nvme0n1 20000

# IOLatencyTargetUSec: target latency for BFQ scheduler
IOLatencyTargetUSec=25000  # 25ms target
```

```bash
# Monitor I/O per cgroup in real time
cat /sys/fs/cgroup/system.slice/io-controlled.service/io.stat
# 8:0 rbytes=12345678 wbytes=9876543 rios=1234 wios=567 dbytes=0 dios=0

# systemd-cgtop shows aggregated I/O
systemd-cgtop -d 1 --sort=io
```

### Creating a Resource Slice for Workload Grouping

```ini
# /etc/systemd/system/production.slice
[Unit]
Description=Production Workloads
Documentation=man:systemd.slice(5)
Before=slices.target

[Slice]
# Limits for all services in this slice
MemoryMax=16G
CPUWeight=800
IOWeight=500
```

```ini
# /etc/systemd/system/myapp.service — assign to production slice
[Service]
Slice=production.slice
# Individual limits within the slice
MemoryMax=4G
CPUQuota=200%
```

```bash
# Check slice hierarchy
systemctl status production.slice
systemd-cgls /sys/fs/cgroup/production.slice/
```

## Section 4: Dependency Ordering

### The Full Dependency Grammar

```ini
# Full dependency keyword reference:
#
# After=   — this unit starts after listed units are started
# Before=  — this unit starts before listed units
# Requires=  — listed units must be active; if they fail, stop this unit
# Wants=     — try to start listed units; don't stop if they fail
# BindsTo=   — like Requires but also stops if the bound unit stops
# PartOf=    — like Requires but propagates STOP/RESTART only from parent to child
# Upholds=   — continuously restart listed units if they stop (systemd 249+)
# Conflicts= — mutual exclusion; cannot run simultaneously

# Example: a service that needs database, network, and a config generation step
[Unit]
Description=API Service
After=network-online.target postgresql.service config-generator.service
Wants=network-online.target
Requires=postgresql.service
BindsTo=postgresql.service   # Stop api if database stops
Conflicts=maintenance.target
```

### Ordering Without Starting: WantedBy vs RequiredBy

```bash
# Check the effective dependency graph
systemctl list-dependencies myapp.service --reverse  # What depends on myapp?
systemctl list-dependencies myapp.service            # What does myapp depend on?

# Show full dependency tree with state
systemctl list-dependencies myapp.service --all --plain

# Check for dependency cycles
systemd-analyze verify myapp.service
systemd-analyze critical-chain myapp.service
```

### Conditional Units

```ini
# /etc/systemd/system/nvme-optimizer.service
[Unit]
Description=NVMe I/O Scheduler Optimizer
# Only run if NVMe device exists
ConditionPathExists=/dev/nvme0n1
# Only run on physical hardware (not in a VM)
ConditionVirtualization=false
# Only run on specific architecture
ConditionArchitecture=x86-64
# Only run if kernel version >= 6.1
ConditionKernelVersion=>=6.1

[Service]
Type=oneshot
ExecStart=/usr/local/bin/set-nvme-scheduler.sh
RemainAfterExit=yes
```

```ini
# Assert variants (hard failure vs soft skip):
# Condition* — if false, unit is skipped (not started), not a failure
# Assert*    — if false, unit fails to start (treated as error)

[Unit]
AssertPathExists=/etc/myapp/required-config.yaml
AssertFileNotEmpty=/etc/myapp/required-config.yaml
```

## Section 5: Service Hardening (Security)

```ini
# /etc/systemd/system/hardened-service.service
[Service]
# User/group isolation
User=serviceuser
Group=servicegroup
SupplementaryGroups=audio

# Filesystem isolation
PrivateTmp=yes             # Private /tmp
PrivateDevices=yes         # No device files (except /dev/null etc.)
PrivateIPC=yes             # Private SysV IPC
ProtectSystem=strict       # Read-only /usr, /boot, /efi
ProtectHome=yes            # No access to /home, /root
ProtectKernelTunables=yes  # Read-only /proc sysctl
ProtectKernelModules=yes   # Cannot load kernel modules
ProtectKernelLogs=yes      # Cannot read kernel ring buffer
ProtectClock=yes           # Cannot change system clock
ProtectControlGroups=yes   # Read-only cgroup filesystem
ProtectHostname=yes        # Cannot change hostname
RestrictNamespaces=yes     # Restrict namespace creation
RestrictRealtime=yes       # No real-time scheduling
RestrictSUIDSGID=yes       # Block SUID/SGID execution

# Network isolation
PrivateNetwork=no          # Allow network (set yes to isolate)
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Capability bounding
CapabilityBoundingSet=CAP_NET_BIND_SERVICE  # Only this capability
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes        # Cannot gain new privileges via execve

# System call filter (audit with strace/seccomp-audit first)
SystemCallFilter=@system-service  # Common service syscalls
SystemCallErrorNumber=EPERM       # Return EPERM instead of SIGSYS

# Readonly paths
ReadOnlyPaths=/etc
ReadWritePaths=/var/lib/myapp /tmp/myapp

# Runtime directory (auto-created, cleaned on stop)
RuntimeDirectory=myapp
RuntimeDirectoryMode=0700
StateDirectory=myapp       # Persistent state in /var/lib/myapp
CacheDirectory=myapp       # Cache in /var/cache/myapp
LogsDirectory=myapp        # Logs in /var/log/myapp
```

```bash
# Check the security score of a unit
systemd-analyze security myapp.service

# Output includes:
# NAME                          DESCRIPTION                   EXPOSED
# PrivateNetwork=               Service has access to network  0.5
# User=/DynamicUser=            Service runs as root           0.4
# ...
# Overall exposure level: 4.7 MEDIUM
```

## Section 6: Override Files and Drop-in Configurations

```bash
# Create a drop-in override without modifying the original unit
systemctl edit postgresql.service
# Opens editor, creates /etc/systemd/system/postgresql.service.d/override.conf

# Manual drop-in for resource limits
mkdir -p /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/resource-limits.conf <<'EOF'
[Service]
LimitNOFILE=131072
LimitNPROC=65536
MemoryMax=4G
CPUQuota=400%
EOF

systemctl daemon-reload
systemctl restart nginx

# Verify effective unit configuration
systemctl cat nginx.service  # Shows merged configuration
systemctl show nginx.service --property=MemoryMax,CPUQuotaPerSecUSec
```

## Section 7: Advanced Logging with systemd-journald

```ini
# /etc/systemd/journald.conf
[Journal]
Storage=persistent          # Write to /var/log/journal
Compress=yes
Seal=yes                    # Forward-secure sealing for tamper detection
SplitMode=uid               # Separate log files per user
RateLimitIntervalSec=30s
RateLimitBurst=10000        # Allow 10000 msgs per 30s before rate limiting
SystemMaxUse=8G             # Total journal size limit
SystemKeepFree=1G           # Keep at least 1G free on disk
SystemMaxFileSize=128M      # Max size per journal file
MaxRetentionSec=90day
ForwardToSyslog=no          # Don't forward to syslog (reduces I/O)
ForwardToKMsg=no
Audit=yes                   # Include audit log in journal
```

```bash
# Query with advanced filters
journalctl \
  --since "2031-10-16 00:00:00" \
  --until "2031-10-17 00:00:00" \
  -u myapp.service \
  --priority=err \
  --output=json \
  | jq -r '.MESSAGE' | head -50

# Follow multiple units simultaneously
journalctl -u myapp.service -u postgresql.service -f

# Export logs for analysis
journalctl -u myapp.service --since "1 hour ago" -o json-pretty > /tmp/myapp-logs.json

# Check journal disk usage
journalctl --disk-usage

# Verify journal integrity
journalctl --verify
```

## Section 8: Timers as cron Replacement

```ini
# /etc/systemd/system/db-backup.timer
[Unit]
Description=Database Backup Timer
Requires=db-backup.service

[Timer]
# Calendar expression: daily at 01:30
OnCalendar=*-*-* 01:30:00
# Randomize start within 5 minutes to avoid thundering herd
RandomizedDelaySec=300
# Persist timer state across reboots
Persistent=yes
# Accuracy: fire within 1 minute of scheduled time
AccuracySec=60

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/db-backup.service
[Unit]
Description=Database Backup Job
After=network-online.target postgresql.service

[Service]
Type=oneshot
User=backup
ExecStart=/opt/backup/bin/pg-backup.sh
# Hard limits for the backup job
TimeoutStartSec=4h
MemoryMax=2G
CPUQuota=100%
IOWriteBandwidthMax=/dev/sdb 100M
Nice=10                     # Lower CPU priority
IOSchedulingClass=idle      # Idle I/O class (lowest priority)
```

```bash
# List all timers and their next trigger time
systemctl list-timers --all

# Check timer status
systemctl status db-backup.timer

# Run the timer's service immediately (for testing)
systemctl start db-backup.service

# Check when the timer last fired
journalctl -u db-backup.service --since "7 days ago" | grep "Started"
```

## Section 9: Watchdog Integration

```ini
# /etc/systemd/system/monitored-service.service
[Service]
Type=notify
# systemd will kill and restart the service if no keepalive within 30s
WatchdogSec=30s
# Service should call sd_notify("WATCHDOG=1") every WatchdogSec/2
NotifyAccess=main           # Only main PID can notify
```

```go
// watchdog.go — Application-side watchdog keepalive
package main

import (
    "time"
    "github.com/coreos/go-systemd/v22/daemon"
)

func startWatchdog() {
    // Get the watchdog interval from systemd
    interval, err := daemon.SdWatchdogEnabled(false)
    if err != nil || interval == 0 {
        return  // Watchdog not enabled
    }

    // Ping every half the watchdog interval
    ticker := time.NewTicker(interval / 2)
    go func() {
        for range ticker.C {
            daemon.SdNotify(false, daemon.SdNotifyWatchdog)
        }
    }()
}

func main() {
    // Signal systemd that the service is ready
    daemon.SdNotify(false, daemon.SdNotifyReady)
    startWatchdog()
    // ... application code
}
```

## Section 10: Debugging and Performance Analysis

```bash
# Measure service startup time
systemd-analyze blame | head -20

# Show critical boot chain
systemd-analyze critical-chain

# Plot boot chart (generates SVG)
systemd-analyze plot > boot-chart.svg

# Show dependencies as a dot graph
systemd-analyze dot myapp.service | dot -Tsvg > deps.svg

# Check for failed units
systemctl --failed

# Show all unit state
systemctl list-units --all --state=failed,activating

# Debug a service without starting it
systemd-run --shell --wait --collect \
  --property=User=myapp \
  --property=MemoryMax=1G

# Check effective cgroup limits
systemctl show myapp.service \
  --property=MemoryMax,MemoryHigh,CPUQuotaPerSecUSec,IOWeight

# Live cgroup stats
watch -n1 'systemctl show myapp.service \
  --property=MemoryCurrentBytes,CPUUsageNSec'
```

## Summary

systemd's advanced features enable patterns that were previously implemented by external daemons, wrapper scripts, or complex init sequences:

- Socket activation eliminates restart races and enables zero-downtime service updates — every production TCP service should consider it
- Transient units replace ad-hoc subprocess spawning for batch jobs and should be used by any orchestration tooling that needs resource-limited ephemeral processes
- cgroup v2 integration provides kernel-enforced resource isolation that cannot be bypassed by the service process — use `MemoryHigh` as a soft warning threshold and `MemoryMax` as the hard kill limit
- Drop-in override files allow distribution package unit files to be customized without conflicts during package upgrades
- The watchdog mechanism provides application-level health monitoring that is more reliable than external process monitoring tools
