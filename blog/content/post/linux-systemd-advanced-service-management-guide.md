---
title: "Linux systemd Advanced: Service Management, Timers, and Unit Dependencies"
date: 2028-10-03T00:00:00-05:00
draft: false
tags: ["Linux", "systemd", "Service Management", "Automation", "DevOps"]
categories:
- Linux
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into systemd unit file anatomy, socket activation, timer units, journald configuration, boot profiling with systemd-analyze, template units, and drop-in overrides for production service management."
more_link: "yes"
url: "/linux-systemd-advanced-service-management-guide/"
---

systemd is the init system and service manager on virtually every modern Linux distribution. Most administrators know the basics—`systemctl start`, `systemctl enable`, and reading logs with `journalctl`. But systemd's real power comes from its declarative dependency model, socket activation, timer units that replace cron, cgroup resource control, and security sandboxing directives. This guide explores the advanced features needed for production-grade service management.

<!--more-->

# Linux systemd Advanced: Service Management, Timers, and Unit Dependencies

## Unit File Anatomy

Every systemd unit is a structured text file divided into sections. A service unit has three primary sections: `[Unit]` for metadata and dependencies, `[Service]` for execution parameters, and `[Install]` for enabling behavior.

### Production-Grade Service Unit

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=MyApp Application Server
Documentation=https://docs.example.com/myapp
After=network-online.target postgresql.service redis.service
Wants=network-online.target
Requires=postgresql.service
# PartOf=myapp.slice  # Uncomment if using a slice unit
ConditionPathExists=/etc/myapp/config.yaml
AssertFileNotEmpty=/etc/myapp/config.yaml

[Service]
Type=notify
# Use notify type so systemd waits for sd_notify("READY=1\n")
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp
EnvironmentFile=-/etc/myapp/environment
ExecStartPre=/usr/bin/myapp --check-config
ExecStart=/usr/bin/myapp serve --config /etc/myapp/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
ExecStop=/bin/kill -TERM $MAINPID
ExecStopPost=/usr/bin/myapp cleanup

# Restart policy
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60
StartLimitBurst=3

# File descriptor and process limits
LimitNOFILE=65536
LimitNPROC=4096
LimitCORE=0

# Timeouts
TimeoutStartSec=60
TimeoutStopSec=30
WatchdogSec=30

# Output routing
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myapp

# Resource control via cgroups
CPUQuota=200%         # Max 2 CPU cores
MemoryMax=2G
MemoryHigh=1.5G       # Triggers reclaim before hard limit
IOWeight=50           # Relative I/O weight (default 100)
TasksMax=512

# Security hardening
PrivateTmp=true
PrivateDevices=true
PrivateNetwork=false
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectHostname=true
ProtectClock=true
ReadWritePaths=/var/lib/myapp /var/log/myapp
NoNewPrivileges=true
SecureBits=no-setuid-fixup-locked
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
AmbientCapabilities=
CapabilityBoundingSet=
# Restrict address families
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictRealtime=true
RestrictNamespaces=true

[Install]
WantedBy=multi-user.target
```

Load and verify the unit:

```bash
# Validate unit file syntax
systemd-analyze verify /etc/systemd/system/myapp.service

# Reload systemd and start the service
systemctl daemon-reload
systemctl enable --now myapp.service

# Check status with journal tail
systemctl status myapp.service
journalctl -fu myapp.service
```

## Dependency Ordering Deep Dive

systemd dependencies are often misunderstood. There are four distinct dependency types:

```ini
# Ordering (does not imply activation)
After=postgresql.service    # Start after postgresql, but do not start postgresql
Before=backup.service       # Start before backup

# Activation dependencies
Wants=redis.service         # Start redis if not running; do not fail if redis fails
Requires=postgresql.service # Start postgresql; fail if postgresql fails
Requisite=postgresql.service # Fail immediately if postgresql is not already active
BindsTo=postgresql.service  # Stop this service if postgresql stops
PartOf=myapp.target         # Stop/restart with parent target

# Negative dependencies
Conflicts=oldapp.service    # Cannot run simultaneously
```

Visualize the dependency graph:

```bash
# Generate dependency graph for a target
systemd-analyze dot multi-user.target | dot -Tsvg > deps.svg

# Show the dependency tree as text
systemctl list-dependencies myapp.service --all

# Find what a unit depends on (reverse lookup)
systemctl list-dependencies myapp.service --reverse
```

## Socket Activation

Socket activation allows systemd to hold open a listening socket, starting the service only when a connection arrives. This is ideal for services that are occasionally used and should not consume memory at idle:

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=MyApp Socket Activation
PartOf=myapp.service

[Socket]
ListenStream=0.0.0.0:8080
ListenStream=[::]:8080
Accept=false          # Pass the socket to the service (not fork per connection)
Backlog=2048
ReusePort=true
SocketMode=0660
NoDelay=true
KeepAlive=true
KeepAliveTimeSec=60
KeepAliveIntervalSec=10
KeepAliveProbes=5

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/myapp.service (socket-activated version)
[Unit]
Description=MyApp Application Server (socket-activated)
Requires=myapp.socket
After=myapp.socket

[Service]
Type=simple
User=myapp
ExecStart=/usr/bin/myapp serve --fd-activation
StandardInput=socket
# The service uses sd_listen_fds() to retrieve the pre-opened socket
```

The Go application receives the socket via systemd file descriptor passing:

```go
// main.go - socket activation compatible server
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/coreos/go-systemd/v22/activation"
)

func main() {
	var ln net.Listener
	var err error

	// Check for systemd socket activation
	listeners, err := activation.Listeners()
	if err != nil {
		fmt.Fprintln(os.Stderr, "activation.Listeners:", err)
		os.Exit(1)
	}

	if len(listeners) == 1 {
		// Socket passed by systemd
		ln = listeners[0]
		fmt.Println("Using systemd socket activation")
	} else {
		// Standalone mode
		ln, err = net.Listen("tcp", ":8080")
		if err != nil {
			fmt.Fprintln(os.Stderr, "net.Listen:", err)
			os.Exit(1)
		}
		fmt.Println("Listening on :8080")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	if err := http.Serve(ln, mux); err != nil {
		fmt.Fprintln(os.Stderr, "http.Serve:", err)
		os.Exit(1)
	}
}
```

Enable the socket (not the service directly):

```bash
systemctl enable --now myapp.socket
# systemd will start myapp.service automatically on first connection
curl http://localhost:8080/health
```

## Path Units

Path units trigger a service when files or directories change, implementing a poor man's inotify-based trigger:

```ini
# /etc/systemd/system/data-processor.path
[Unit]
Description=Watch for new data files

[Path]
PathChanged=/var/spool/data-processor/input
PathModified=/var/spool/data-processor/input
DirectoryNotEmpty=/var/spool/data-processor/input
MakeDirectory=true
DirectoryMode=0755

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/data-processor.service
[Unit]
Description=Process incoming data files
After=network-online.target

[Service]
Type=oneshot
User=processor
ExecStart=/usr/local/bin/process-data.sh /var/spool/data-processor/input
Nice=10
IOSchedulingClass=idle
```

```bash
systemctl enable --now data-processor.path
```

## Timer Units Replacing Cron

systemd timers are strictly more capable than cron: they support monotonic clocks (relative to boot/activation), calendar expressions more powerful than cron syntax, randomized delays to spread load, and missed execution tracking.

### Monotonic Timer (runs after service starts)

```ini
# /etc/systemd/system/db-cleanup.timer
[Unit]
Description=Database cleanup timer
Requires=db-cleanup.service

[Timer]
# Run 5 minutes after system boot, then every 4 hours
OnBootSec=5min
OnUnitActiveSec=4h
# Spread the start time randomly within ±5 minutes to avoid thundering herd
RandomizedDelaySec=5min
# Run missed activations if the system was off
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
```

### Calendar Timer (cron-like, but more expressive)

```ini
# /etc/systemd/system/weekly-report.timer
[Unit]
Description=Weekly report generation
Requires=weekly-report.service

[Timer]
# Every Monday at 06:30
OnCalendar=Mon *-*-* 06:30:00
# Ensure it runs if the system was off at the scheduled time
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/weekly-report.service
[Unit]
Description=Generate weekly reports

[Service]
Type=oneshot
User=reporter
ExecStart=/usr/local/bin/generate-report.py --output /var/reports/weekly
TimeoutStartSec=3600
# Email on failure via systemd's OnFailure mechanism
OnFailure=notify-admin@.service

[Install]
WantedBy=multi-user.target
```

```bash
# List all timers with next activation time
systemctl list-timers --all

# Test calendar expression parsing
systemd-analyze calendar "Mon *-*-* 06:30:00"
# Output:
#   Original form: Mon *-*-* 06:30:00
#   Normalized form: Mon *-*-* 06:30:00
#   Next elapse: Mon 2028-10-07 06:30:00 UTC

# Check timer status
systemctl status weekly-report.timer
```

### Comprehensive Calendar Expression Examples

```bash
# Every day at midnight
systemd-analyze calendar "*-*-* 00:00:00"

# Every 15 minutes
systemd-analyze calendar "*:0/15"

# First day of every month at 3am
systemd-analyze calendar "*-*-01 03:00:00"

# Weekdays only, every hour during business hours
systemd-analyze calendar "Mon..Fri *-*-* 08..17:00:00"

# Every 6 hours starting from midnight
systemd-analyze calendar "*-*-* 00/6:00:00"
```

## Template Units for Multiple Instances

Template units parameterize a single unit file to serve multiple instances. The `%i` specifier expands to the instance name:

```ini
# /etc/systemd/system/worker@.service
[Unit]
Description=Worker instance %i
After=network-online.target redis.service
Wants=network-online.target

[Service]
Type=simple
User=worker
Group=worker
WorkingDirectory=/opt/worker
EnvironmentFile=/etc/worker/%i.env
ExecStart=/usr/bin/worker \
  --queue %i \
  --concurrency 4 \
  --metrics-port %I
# %I is the instance name with special characters unescaped
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=worker-%i

MemoryMax=512M
CPUQuota=100%

[Install]
WantedBy=multi-user.target
```

Create per-instance environment files:

```bash
mkdir -p /etc/worker

cat > /etc/worker/high-priority.env << 'EOF'
REDIS_URL=redis://redis.svc.cluster.local:6379/0
LOG_LEVEL=info
WORKER_METRICS_PORT=9101
EOF

cat > /etc/worker/low-priority.env << 'EOF'
REDIS_URL=redis://redis.svc.cluster.local:6379/1
LOG_LEVEL=warn
WORKER_METRICS_PORT=9102
EOF

# Enable and start specific instances
systemctl enable --now worker@high-priority.service
systemctl enable --now worker@low-priority.service

# Check all instances
systemctl status 'worker@*.service'

# Stop all instances using glob
systemctl stop 'worker@*.service'
```

## Drop-In Overrides with `systemctl edit`

Never modify vendor-provided unit files directly. Use drop-in overrides to avoid losing changes on package upgrades:

```bash
# Opens $EDITOR to create /etc/systemd/system/nginx.service.d/override.conf
systemctl edit nginx.service
```

The drop-in file:

```ini
# /etc/systemd/system/nginx.service.d/override.conf
[Service]
# Override the memory limit set by the distro package
MemoryMax=4G
MemoryHigh=3G

# Add an environment file not in the original unit
EnvironmentFile=-/etc/nginx/environment

# Change restart behavior
Restart=always
RestartSec=2s

# Override a specific ExecStart (must clear first, then set)
ExecStart=
ExecStart=/usr/sbin/nginx -g 'daemon off;' -c /etc/nginx/nginx.conf
```

View the effective configuration after applying overrides:

```bash
# Show the combined unit (original + overrides)
systemctl cat nginx.service

# Show only the drop-in files
ls /etc/systemd/system/nginx.service.d/

# Verify the effective settings
systemctl show nginx.service --property=MemoryMax,Restart,ExecStart
```

## journald Configuration and Log Management

```ini
# /etc/systemd/journald.conf.d/production.conf
[Journal]
# Storage: auto, volatile (RAM only), persistent (disk), none
Storage=persistent

# Compress journal files
Compress=yes

# Maximum disk usage for journal files
SystemMaxUse=4G
SystemKeepFree=1G

# Maximum size of each journal file (rotation trigger)
SystemMaxFileSize=128M

# Maximum number of journal files to retain
SystemMaxFiles=16

# Rate limiting per service
RateLimitIntervalSec=30s
RateLimitBurst=1000

# Forward to syslog socket
ForwardToSyslog=no
ForwardToWall=no

# Maximum size of message to accept
MaxLevelStore=debug
MaxLevelSyslog=err
```

```bash
# Apply journald changes
systemctl restart systemd-journald

# Query logs with advanced filters
journalctl -u myapp.service \
  --since "2028-10-01 00:00:00" \
  --until "2028-10-01 23:59:59" \
  --output json \
  | jq 'select(.PRIORITY <= "3") | {time: .__REALTIME_TIMESTAMP, msg: .MESSAGE}'

# Show logs at priority error and above for all services
journalctl -p err --no-pager --output short-precise

# Filter by custom syslog identifier
journalctl SYSLOG_IDENTIFIER=myapp -n 100

# Show all logs from the current boot
journalctl -b 0

# Check journal disk usage
journalctl --disk-usage

# Vacuum old logs
journalctl --vacuum-size=2G
journalctl --vacuum-time=30d
```

## systemd-analyze for Boot Profiling

```bash
# Overall boot time breakdown
systemd-analyze time

# Show slowest units (blame list)
systemd-analyze blame | head -20

# Generate an SVG boot chart
systemd-analyze plot > boot.svg

# Check unit file for errors
systemd-analyze verify myapp.service

# Show critical path (longest chain of sequential dependencies)
systemd-analyze critical-chain myapp.service

# Security scoring for a service
systemd-analyze security myapp.service
```

Example output of `systemd-analyze security`:

```
NAME                DESCRIPTION                              EXPOSURE
PrivateNetwork=     Service has access to the host network       0.5
SupplementaryGroups= Service runs with supplementary groups      0.1
...
-> Overall exposure level for myapp.service: 3.2 MEDIUM
```

## Watchdog Integration in Go

Services using `Type=notify` can implement the systemd watchdog protocol to get automatically restarted if they become unresponsive:

```go
// pkg/watchdog/watchdog.go
package watchdog

import (
	"fmt"
	"os"
	"time"

	"github.com/coreos/go-systemd/v22/daemon"
)

// Start sends periodic watchdog notifications to systemd.
// The interval should be half the WATCHDOG_USEC value.
func Start(interval time.Duration) (func(), error) {
	ok, err := daemon.SdNotify(false, daemon.SdNotifyReady)
	if err != nil {
		return nil, fmt.Errorf("sd_notify READY: %w", err)
	}
	if !ok {
		// Not running under systemd, no-op
		return func() {}, nil
	}

	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if _, err := daemon.SdNotify(false, daemon.SdNotifyWatchdog); err != nil {
					fmt.Fprintln(os.Stderr, "watchdog notify failed:", err)
				}
			case <-stop:
				return
			}
		}
	}()

	return func() { close(stop) }, nil
}

// NotifyReloading signals systemd that the service is reloading configuration.
func NotifyReloading() error {
	_, err := daemon.SdNotify(false, "RELOADING=1")
	return err
}

// NotifyStopping signals systemd that the service is shutting down.
func NotifyStopping() error {
	_, err := daemon.SdNotify(false, "STOPPING=1")
	return err
}

// UpdateStatus sends a human-readable status update to systemd.
func UpdateStatus(status string) error {
	_, err := daemon.SdNotify(false, "STATUS="+status)
	return err
}
```

Usage in main:

```go
// cmd/server/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/yourorg/app/pkg/watchdog"
)

func main() {
	// Start watchdog (interval = WatchdogSec / 2 = 15s for WatchdogSec=30s)
	stopWatchdog, err := watchdog.Start(15 * time.Second)
	if err != nil {
		log.Fatalf("watchdog start: %v", err)
	}
	defer stopWatchdog()

	watchdog.UpdateStatus("Starting up")

	// ... initialization ...

	watchdog.UpdateStatus(fmt.Sprintf("Serving on :8080"))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// On SIGHUP, reload configuration
	// sigHup := make(chan os.Signal, 1)
	// signal.Notify(sigHup, syscall.SIGHUP)

	<-ctx.Done()

	watchdog.NotifyStopping()
	watchdog.UpdateStatus("Shutting down")
}
```

## Slice Units for Resource Grouping

Slice units group related services into a cgroup hierarchy for collective resource management:

```ini
# /etc/systemd/system/myapp.slice
[Unit]
Description=MyApp Services Slice
Before=slices.target

[Slice]
CPUWeight=80          # Relative CPU priority
MemoryMax=8G          # Total memory cap for all services in this slice
MemoryHigh=6G
IOWeight=80
TasksMax=2048
```

Update service units to use the slice:

```ini
# In myapp.service, myapp-worker.service, etc.
[Service]
Slice=myapp.slice
```

```bash
# View resource usage per slice
systemd-cgtop /system.slice/myapp.slice

# Show cgroup hierarchy
systemctl status myapp.slice
```

## Hardening Score Improvements

The `systemd-analyze security` command gives a numeric exposure score. Here are the directives that provide the most impact:

```ini
[Service]
# Disable privilege escalation entirely
NoNewPrivileges=true

# Create a private /tmp invisible to other services
PrivateTmp=true

# Prevent access to hardware devices except stdio
PrivateDevices=true

# Mount /usr, /boot, /etc as read-only
ProtectSystem=full    # or strict (more restrictive, includes /usr)

# Make /home, /root, /run/user inaccessible
ProtectHome=true

# Prevent kernel tunable changes
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true

# Prevent cgroup changes
ProtectControlGroups=true

# Whitelist only the syscalls needed for a typical server
SystemCallFilter=@system-service @network-io @basic-io

# Prevent writing to executable memory (defeats many exploits)
MemoryDenyWriteExecute=true

# Lock the personality to prevent setuid-related attacks
LockPersonality=true
```

Verify the security score after hardening:

```bash
systemd-analyze security myapp.service --no-pager
```

## Practical Runbook: Debugging a Failing Service

```bash
# 1. Check current status
systemctl status myapp.service

# 2. View recent journal entries
journalctl -u myapp.service -n 50 --no-pager

# 3. Check if the unit file parses correctly
systemd-analyze verify /etc/systemd/system/myapp.service

# 4. Check what other units depend on this service
systemctl list-dependencies myapp.service --reverse

# 5. Check if required files exist
systemctl show myapp.service --property=ConditionResult,AssertResult

# 6. Check cgroup resource usage
systemctl show myapp.service --property=MemoryCurrent,CPUUsageNSec

# 7. Temporarily disable restart to see the raw exit code
systemctl edit myapp.service
# Add: Restart=no
systemctl daemon-reload
systemctl start myapp.service; systemctl status myapp.service

# 8. Run the service in the foreground with systemd-run
systemd-run --unit=myapp-debug --user \
  --property=User=myapp \
  --property=WorkingDirectory=/opt/myapp \
  /usr/bin/myapp serve --config /etc/myapp/config.yaml
```

## Summary

systemd provides a complete service management framework that goes far beyond process supervision. Socket activation eliminates idle memory overhead. Timer units with `Persistent=true` handle missed executions correctly, which cron cannot. Template units consolidate management of parameterized service sets. Drop-in overrides keep package-managed configurations upgrade-safe. And the security hardening directives—particularly `PrivateTmp`, `ProtectSystem=strict`, `NoNewPrivileges`, and `SystemCallFilter`—provide defense-in-depth for long-running services without requiring custom LSM policies.
