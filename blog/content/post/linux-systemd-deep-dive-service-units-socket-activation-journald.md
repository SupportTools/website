---
title: "Linux Systemd Deep Dive: Service Units, Socket Activation, Journald, and Targets"
date: 2029-12-20T00:00:00-05:00
draft: false
tags: ["Linux", "Systemd", "Service Management", "Socket Activation", "Journald", "Security Hardening", "Init System"]
categories:
- Linux
- Systems Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to systemd unit file authoring, socket activation patterns, service dependency ordering, security hardening options, journald log management, and target-based system states."
more_link: "yes"
url: "/linux-systemd-deep-dive-service-units-socket-activation-journald/"
---

Systemd is the init system and service manager on virtually every modern Linux distribution. Despite its ubiquity, most engineers interact with systemd only through `systemctl start/stop/status` and never explore its richer capabilities: socket-activated services that only launch on first connection, capability-based sandboxing that rivals containers, journald's structured logging with persistent retention, and target-based dependency graphs that replace the brittle runlevel model. This guide covers all of those — with production-quality unit files throughout.

<!--more-->

## Unit File Anatomy

Systemd unit files live in three locations with a clear precedence:

| Location | Purpose | Precedence |
|---|---|---|
| `/lib/systemd/system/` | Distribution-provided units | Lowest |
| `/etc/systemd/system/` | Administrator overrides | Middle |
| `/run/systemd/system/` | Runtime units (transient) | Highest |

Drop-in override files go in `/etc/systemd/system/<unit>.d/override.conf` and merge with the base unit, making upgrades safe.

### Complete Service Unit

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Application Server
Documentation=https://docs.example.com/myapp
After=network-online.target postgresql.service
Requires=postgresql.service
Wants=redis.service

[Service]
Type=notify
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp
EnvironmentFile=-/etc/myapp/environment
RuntimeDirectory=myapp
RuntimeDirectoryMode=0750
StateDirectory=myapp
LogsDirectory=myapp
ExecStartPre=/usr/bin/myapp --check-config
ExecStart=/usr/bin/myapp serve --config /etc/myapp/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
ExecStop=/bin/kill -TERM $MAINPID
TimeoutStopSec=30
Restart=on-failure
RestartSec=5s
StartLimitInterval=120s
StartLimitBurst=5
OOMScoreAdjust=-100
LimitNOFILE=65536
LimitNPROC=4096
WatchdogSec=30s
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
PrivateDevices=true
ProcSubset=pid
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
RestrictRealtime=true
MemoryDenyWriteExecute=true
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

### Service Types

The `Type=` directive controls how systemd determines when a service has finished starting:

- **`Type=simple`** (default): The `ExecStart` process is the main process. Systemd considers the service started immediately after fork.
- **`Type=forking`**: The service forks and the parent exits (traditional daemons). Requires `PIDFile=`.
- **`Type=notify`**: The service sends `sd_notify("READY=1")` when fully initialized. Best for services that need startup time for DB connections and configuration loading.
- **`Type=exec`**: Like `simple`, but systemd waits for the `exec()` call to complete before marking the service as started.
- **`Type=oneshot`**: Runs to completion, then exits. Pair with `RemainAfterExit=yes` for services that perform setup tasks.
- **`Type=dbus`**: Service acquires a D-Bus name when ready.

## Socket Activation

Socket activation allows systemd to listen on a port or Unix socket and only start the service process when the first connection arrives. This enables:

- Faster boot (services start lazily)
- Zero-downtime restarts (systemd holds the socket while the service restarts)
- Parallel service startup (all sockets are ready immediately)

### Socket Unit

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=My Application Socket

[Socket]
ListenStream=0.0.0.0:8080
ListenStream=/run/myapp/myapp.sock
Accept=false
Backlog=4096
KeepAlive=true
NoDelay=true
ReusePort=true
ReceiveBuffer=2M
SendBuffer=2M

[Install]
WantedBy=sockets.target
```

The corresponding service unit:

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Application (socket-activated)
Requires=myapp.socket

[Service]
Type=notify
User=myapp
ExecStart=/usr/bin/myapp serve
StandardInput=socket
Restart=on-failure
```

### Reading Socket FDs in Go

```go
// main.go — socket-activated Go service
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/coreos/go-systemd/v22/activation"
	"github.com/coreos/go-systemd/v22/daemon"
)

func main() {
	listeners, err := activation.Listeners()
	if err != nil {
		fmt.Fprintf(os.Stderr, "socket activation error: %v\n", err)
		os.Exit(1)
	}

	var ln net.Listener

	if len(listeners) > 0 {
		ln = listeners[0]
		fmt.Println("using systemd socket-activated listener")
	} else {
		ln, err = net.Listen("tcp", ":8080")
		if err != nil {
			fmt.Fprintf(os.Stderr, "listen error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("listening on :8080 (direct bind)")
	}

	// Signal readiness to systemd (requires Type=notify)
	daemon.SdNotify(false, daemon.SdNotifyReady)

	http.Serve(ln, http.DefaultServeMux)
}
```

### Instantiated Services with Unit Templates

```ini
# /etc/systemd/system/worker@.service
[Unit]
Description=Worker Instance %i
After=network.target

[Service]
Type=simple
User=worker
ExecStart=/usr/bin/worker --queue %i
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable specific instances:

```bash
systemctl enable --now worker@email.service
systemctl enable --now worker@media.service
systemctl enable --now worker@webhooks.service
```

## Systemd Targets

Targets replace SysV runlevels. Each target is a synchronization point grouping a set of units.

```bash
# List all active targets
systemctl list-units --type=target

# Common targets:
# poweroff.target   = halt system (runlevel 0)
# rescue.target     = single-user mode (runlevel 1)
# multi-user.target = multi-user without GUI (runlevel 3)
# graphical.target  = multi-user with GUI (runlevel 5)
# reboot.target     = reboot system (runlevel 6)

# Change the default boot target
systemctl set-default multi-user.target

# Switch to a target immediately (like changing runlevel)
systemctl isolate rescue.target
```

### Custom Application Stack Target

```ini
# /etc/systemd/system/myapp-stack.target
[Unit]
Description=My Application Stack
After=network-online.target
Wants=postgresql.service redis.service myapp.service myapp-worker.service
```

```bash
systemctl enable myapp-stack.target
systemctl start myapp-stack.target
```

## Service Dependency Directives

### Reference for Common Directives

```ini
[Unit]
# Ordering (no hard dependency — just controls start sequence)
After=network-online.target
Before=myapp.service

# Hard dependency: this unit fails if the dependency fails
Requires=postgresql.service

# Soft dependency: try to start, proceed even if unavailable
Wants=redis.service

# Prevent simultaneous operation
Conflicts=conflict.service

# Stop this unit when the named unit stops
BindsTo=postgresql.service

# Part of a group: stopping/restarting the group affects this unit
PartOf=myapp-stack.target
```

### Checking Dependency Graph

```bash
# Generate a dependency graph image
systemd-analyze dot myapp.service | dot -Tpng -o myapp-deps.png

# Show the critical path (slowest startup chain)
systemd-analyze critical-chain myapp.service

# List all units that would start with a target
systemctl list-dependencies myapp-stack.target
```

## Journald Configuration and Log Management

### Enabling Persistent Storage

By default, journald stores logs in memory under `/run/log/journal/`. Enable persistent storage:

```bash
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
```

### journald.conf Settings

```ini
# /etc/systemd/journald.conf
[Journal]
Storage=persistent
Compress=yes
SystemMaxUse=2G
SystemMaxFileSize=128M
SystemKeepFree=500M
MaxRetentionSec=90day
ForwardToSyslog=no
ForwardToKMsg=no
RateLimitInterval=30s
RateLimitBurst=10000
Audit=yes
```

Restart journald to apply changes:

```bash
systemctl restart systemd-journald
```

### Querying Journald

```bash
# Follow a service's logs in real time
journalctl -u myapp.service -f

# Show logs since the last boot
journalctl -u myapp.service -b

# Time-bounded log retrieval
journalctl -u myapp.service \
  --since "2029-12-20 08:00" \
  --until "2029-12-20 09:00"

# Show only errors and above (emerg, alert, crit, err)
journalctl -u myapp.service -p err

# Output as JSON for log shipping pipelines
journalctl -u myapp.service -o json | jq .

# Filter by custom field set at log time
journalctl SYSLOG_IDENTIFIER=myapp REQUEST_ID=abc123

# Check disk usage
journalctl --disk-usage

# Manually rotate and vacuum old journal files
journalctl --rotate
journalctl --vacuum-time=30d
journalctl --vacuum-size=1G
```

### Structured Logging to Journald from Go

```go
// internal/log/journal.go
package log

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/coreos/go-systemd/v22/journal"
)

// JournaldHandler sends structured log entries directly to journald
// with native field support (no parsing required by log shippers)
type JournaldHandler struct {
	level slog.Level
}

func (h *JournaldHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level
}

func (h *JournaldHandler) Handle(_ context.Context, r slog.Record) error {
	vars := map[string]string{
		"GO_LOG_LEVEL": r.Level.String(),
	}
	r.Attrs(func(a slog.Attr) bool {
		vars[a.Key] = fmt.Sprintf("%v", a.Value.Any())
		return true
	})

	priority := journal.PriInfo
	switch {
	case r.Level >= slog.LevelError:
		priority = journal.PriErr
	case r.Level >= slog.LevelWarn:
		priority = journal.PriWarning
	case r.Level >= slog.LevelDebug:
		priority = journal.PriDebug
	}

	return journal.Send(r.Message, priority, vars)
}

func (h *JournaldHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return h
}

func (h *JournaldHandler) WithGroup(name string) slog.Handler {
	return h
}
```

## Security Hardening

### Syscall Filtering

```ini
[Service]
# Whitelist the standard set of syscalls needed by most services
SystemCallFilter=@system-service

# Additionally block privileged and resource syscalls
SystemCallFilter=~@privileged @resources @module

# Return EPERM instead of SIGSYS for blocked syscalls
SystemCallErrorNumber=EPERM
```

Common syscall groups for reference: `@system-service`, `@basic-io`, `@file-system`, `@io-event`, `@ipc`, `@network-io`, `@process`, `@signal`, `@sync`, `@timer`, `@privileged`, `@module`, `@mount`, `@raw-io`, `@reboot`, `@clock`, `@setuid`.

### Namespace and Filesystem Isolation

```ini
[Service]
# Private network namespace — no network access at all
PrivateNetwork=true

# Private IPC namespace — no System V IPC shared with other processes
PrivateIPC=true

# Transient UID/GID created at runtime and discarded on exit
DynamicUser=true

# Bind-mount specific read-only paths into the service's view
BindReadOnlyPaths=/etc/ssl/certs /etc/resolv.conf

# Make specific paths completely inaccessible
InaccessiblePaths=/proc/sysrq-trigger
```

### Analyzing Hardening Score

```bash
systemd-analyze security myapp.service

# Example output (abbreviated):
# NAME                              DESCRIPTION                      EXPOSURE
# ✗ RootDirectory=/RootImage=       Service runs in host root        0.1
# ✓ SupplementaryGroups=            No supplementary groups
# ✓ NoNewPrivileges=yes             Cannot acquire new privileges
# ...
# Overall exposure level: 2.8 LOW
```

## Override Files and Unit Debugging

```bash
# Create a drop-in override (opens $EDITOR)
systemctl edit myapp.service
# Creates /etc/systemd/system/myapp.service.d/override.conf

# View the merged effective unit (base + all overrides)
systemctl cat myapp.service

# Verify syntax before reloading
systemd-analyze verify myapp.service

# Show all unit properties
systemctl show myapp.service

# Reload after editing unit files
systemctl daemon-reload

# Diagnose startup failures
systemctl status myapp.service
journalctl -u myapp.service -n 50 --no-pager

# List all failed units
systemctl --failed
```

## Transient Units for One-Off Tasks

```bash
# Run a migration with full systemd cgroup tracking and journal logging
systemd-run \
  --unit=db-migrate \
  --description="Database migration" \
  --property=User=myapp \
  --property=PrivateTmp=true \
  --property=NoNewPrivileges=true \
  --property=StandardOutput=journal \
  /usr/bin/myapp migrate --env production

# Follow the transient unit's output
journalctl -u db-migrate -f

# Check exit status
systemctl status db-migrate
```

## Resource Control with cgroups v2

```ini
[Service]
# Memory limits (hard limit triggers OOM killer)
MemoryMax=512M
# Soft limit: service is throttled when system is under pressure
MemoryHigh=400M

# CPU bandwidth (50% of one core)
CPUQuota=50%

# IO weight relative to other services (100 is default)
IOWeight=50

# Limit total number of tasks (threads + processes)
TasksMax=512
```

## Summary

Systemd provides far more than a simple service manager. Socket activation eliminates port binding races and enables zero-downtime service restarts. The sandboxing directives — `PrivateTmp`, `NoNewPrivileges`, `SystemCallFilter`, `ProtectSystem=strict` — provide defense-in-depth that rivals container isolation without the overhead. Journald's structured, indexed log store makes filtering and correlation practical at the command line or via log shippers. Understanding target dependencies, drop-in overrides, and `systemd-analyze security` turns systemd from a black box into a precision instrument for reliable, auditable service management.
