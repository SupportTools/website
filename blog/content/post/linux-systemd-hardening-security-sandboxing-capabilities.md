---
title: "Linux systemd Hardening: Security Sandboxing, Capability Restrictions, and Service Isolation"
date: 2031-07-03T00:00:00-05:00
draft: false
tags: ["Linux", "systemd", "Security", "Sandboxing", "Capabilities", "Hardening"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to systemd service hardening using security sandboxing directives, Linux capability restrictions, namespace isolation, and syscall filtering to minimize attack surface in production environments."
more_link: "yes"
url: "/linux-systemd-hardening-security-sandboxing-capabilities/"
---

Every service running on a Linux system is a potential entry point for attackers. The default systemd service configuration gives processes broad access to the system—the filesystem, network, other processes, and kernel interfaces. systemd's hardening directives allow you to progressively restrict what a service can do, so that a compromised service causes minimal damage. This post covers the full spectrum of systemd security features with production-ready configurations.

<!--more-->

# Linux systemd Hardening: Security Sandboxing, Capability Restrictions, and Service Isolation

## Measuring the Current Security Score

systemd-analyze provides a security score for every service unit, highlighting which hardening features are missing:

```bash
# Analyze all running services
systemd-analyze security

# Analyze a specific service
systemd-analyze security nginx.service

# Example output:
# nginx.service                                              UNSAFE 9.2
#
# → PrivateTmp=                                              Service has access to other services' temporary files
#   PrivateDevices=                                         Service has access to hardware devices
#   PrivateNetwork=                                         Service has access to the host network
#   ProtectSystem=                                         Service has full access to the OS file hierarchy
#   ...
```

The score ranges from 0 (maximally hardened) to 10 (no hardening). Target is below 4.0 for production services.

## Filesystem Isolation

### ProtectSystem

`ProtectSystem` mounts portions of the filesystem read-only for the service:

```ini
[Service]
# strict: /usr, /boot, /efi all read-only, /proc/sys read-only
ProtectSystem=strict

# full: /usr, /boot, /efi read-only (less restrictive than strict)
# ProtectSystem=full

# true: /usr, /boot read-only
# ProtectSystem=true
```

With `ProtectSystem=strict`, the service can only write to explicitly allowed paths. Grant writable access with `ReadWritePaths`:

```ini
[Service]
ProtectSystem=strict
ReadWritePaths=/var/lib/myapp
ReadWritePaths=/var/log/myapp
ReadOnlyPaths=/etc/myapp
```

### ProtectHome

```ini
[Service]
# yes: /home, /root, /run/user are inaccessible and empty
ProtectHome=yes

# read-only: /home, /root, /run/user are visible but read-only
# ProtectHome=read-only

# tmpfs: mount tmpfs over home directories (makes them empty but writable)
# ProtectHome=tmpfs
```

### Private Temporary Directory

```ini
[Service]
# Creates a private /tmp and /var/tmp for this service
# Files in /tmp from other services are not visible
PrivateTmp=yes
```

### Inaccessible Paths

Block access to sensitive paths entirely:

```ini
[Service]
InaccessiblePaths=/proc/sys/kernel
InaccessiblePaths=/sys/firmware
InaccessiblePaths=/sys/hypervisor
InaccessiblePaths=/etc/shadow
InaccessiblePaths=/etc/gshadow
InaccessiblePaths=/root
```

### BindPaths for Specific Requirements

When a service needs access to a path outside its normal scope:

```ini
[Service]
ProtectSystem=strict
# Make /data/shared visible inside the service at /srv
BindPaths=/data/shared:/srv
# Mount read-only
BindReadOnlyPaths=/etc/ssl/certs:/etc/ssl/certs
```

## Namespace Isolation

Linux namespaces provide process, user, network, IPC, and mount isolation.

```ini
[Service]
# Use a private PID namespace - service cannot see other processes
PrivatePID=yes

# Use a private user namespace (maps UIDs/GIDs)
PrivateUsers=yes

# Use a private IPC namespace - service cannot access SysV IPC, POSIX message queues
PrivateIPC=yes

# Use a private network namespace with only loopback
PrivateNetwork=yes

# Separate /dev hierarchy (only whitelisted devices)
PrivateDevices=yes
```

Note: `PrivateNetwork=yes` isolates the service completely from the network. For services that need network access, use `IPAddressAllow` and `IPAddressDeny` instead:

```ini
[Service]
# Restrict network access to specific IP ranges
# Block everything
IPAddressDeny=any
# Allow localhost
IPAddressAllow=127.0.0.0/8
IPAddressAllow=::1
# Allow internal network
IPAddressAllow=10.0.0.0/8
IPAddressAllow=172.16.0.0/12
IPAddressAllow=192.168.0.0/16
```

## Capability Restrictions

Linux capabilities divide the traditional root privilege set into 40 distinct capabilities. Services running as root have all capabilities; services should only have the capabilities they need.

```bash
# Check which capabilities a process currently has
cat /proc/$(pgrep nginx)/status | grep Cap
# CapInh: 0000000000000000
# CapPrm: 00000000a80425fb
# CapEff: 00000000a80425fb
# CapBnd: 00000000a80425fb

# Decode capability bitmask
capsh --decode=00000000a80425fb
```

In systemd unit files:

```ini
[Service]
# Drop all capabilities (for services that don't need root privileges)
CapabilityBoundingSet=
AmbientCapabilities=

# Or specify only the capabilities needed
# NET_BIND_SERVICE: bind to ports < 1024
# CAP_SYS_PTRACE: required for some monitoring agents
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

# For a service that needs to bind to port 80 but otherwise runs unprivileged
User=myapp
Group=myapp
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

### Common Capability Patterns

**Web Server (nginx, Apache) on port 80/443:**

```ini
[Service]
User=www-data
Group=www-data
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_DAC_OVERRIDE
AmbientCapabilities=CAP_NET_BIND_SERVICE
# Or simply use authbind/iptables redirect to avoid needing root port
```

**Database Server (PostgreSQL):**

```ini
[Service]
User=postgres
Group=postgres
# PostgreSQL needs to read its data files (no special capabilities needed
# when running as the data directory owner)
CapabilityBoundingSet=
AmbientCapabilities=
```

**Monitoring Agent (e.g., node_exporter):**

```ini
[Service]
User=node-exporter
CapabilityBoundingSet=
# If the agent needs to read hardware sensors, it may need:
# CAP_SYS_RAWIO for reading raw I/O ports
# CAP_NET_ADMIN for network statistics
```

## Syscall Filtering with Seccomp

`SystemCallFilter` uses seccomp to whitelist or blacklist system calls. This is one of the most effective hardening mechanisms.

```ini
[Service]
# Whitelist approach: only allow specific system call groups
# @system-service: common system service calls
# @file-system: file operations
# @network-io: network operations
# @io-event: epoll, eventfd, etc.
# @basic-io: read, write, etc.
SystemCallFilter=@system-service @file-system @network-io @io-event @basic-io

# Alternative: blacklist approach for less restrictive services
# Deny specific high-risk syscalls
# SystemCallFilter=~@privileged @obsolete @clock @cpu-emulation @debug @keyring @module @mount @raw-io @reboot @setuid @swap

# Architecture restrictions (important for preventing 32-bit syscall bypasses)
SystemCallArchitectures=native
```

Systemd provides predefined syscall groups. Key ones for web services:

| Group | Contents |
|-------|----------|
| `@system-service` | Calls typically needed by most services |
| `@network-io` | socket, connect, accept, recv, send, etc. |
| `@file-system` | open, read, write, close, stat, etc. |
| `@process` | fork, exec, wait, exit, etc. |
| `@privileged` | Dangerous privileged calls (block these) |
| `@debug` | ptrace, perf_event (block for production) |
| `@module` | insmod, rmmod (almost never needed) |
| `@mount` | mount, umount (block unless needed) |
| `@raw-io` | ioperm, iopl (almost never needed) |
| `@reboot` | reboot, kexec (block) |

## NoNewPrivileges and Seccomp Enforcement

```ini
[Service]
# Prevent the service from gaining new privileges
# (prevents setuid binaries and privilege escalation)
NoNewPrivileges=yes

# Strict seccomp error handling
# SIGSYS: send SIGSYS signal on disallowed syscall (allows debugging)
# kill: kill the process on disallowed syscall
SystemCallErrorNumber=EPERM
```

## Resource Limits

systemd resource limits map directly to Linux cgroups:

```ini
[Service]
# Memory limits
MemoryMax=2G          # Hard limit (process killed at this point)
MemoryHigh=1.8G       # Soft limit (throttling begins here)
MemorySwapMax=0       # No swap for this service

# CPU limits
CPUQuota=200%         # 2 CPU cores max
CPUWeight=100         # Relative priority (default 100)

# I/O limits
IOWeight=100          # Relative I/O priority
IOReadBandwidthMax=/dev/sda 100M   # 100 MB/s read max
IOWriteBandwidthMax=/dev/sda 50M   # 50 MB/s write max

# Open files
LimitNOFILE=65536

# Process limit
TasksMax=1024

# Core dump prevention
LimitCORE=0
```

## User and Group Configuration

```ini
[Service]
# Run as dedicated system user
User=myapp
Group=myapp

# Dynamic user: create an ephemeral user for this invocation
# The user is deleted when the service stops
# DynamicUser=yes

# With DynamicUser, you need StateDirectory for persistent storage
# StateDirectory=myapp
# CacheDirectory=myapp
# LogsDirectory=myapp
# RuntimeDirectory=myapp
```

For services using `DynamicUser=yes`:

```ini
[Service]
DynamicUser=yes
# These directories are created with the dynamic user as owner
StateDirectory=myapp        # /var/lib/myapp
CacheDirectory=myapp        # /var/cache/myapp
LogsDirectory=myapp         # /var/log/myapp
RuntimeDirectory=myapp      # /run/myapp
ConfigurationDirectory=myapp  # /etc/myapp (read-only)

# StateDirectory persists across restarts; other directories are transient
```

## Environment Variable Hardening

```ini
[Service]
# Clear all environment variables before starting
Environment="HOME=/var/lib/myapp"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

# Load environment from file (useful for secrets)
# Note: File must be readable by service user
EnvironmentFile=-/etc/myapp/env  # The - prefix means: don't fail if file missing

# Never hardcode secrets in unit files; they appear in 'systemctl show'
# Use EnvironmentFile with appropriate permissions instead
```

## Protecting the Kernel

```ini
[Service]
# Prevent modifications to kernel variables via /proc/sys
ProtectKernelTunables=yes

# Prevent loading kernel modules
ProtectKernelModules=yes

# Prevent accessing kernel logs
ProtectKernelLogs=yes

# Prevent modifications to the kernel's clock
ProtectClock=yes

# Restrict hostname and domain name modifications
ProtectHostname=yes

# Restrict writes to /proc/PID/audit_loginuid
ProtectControlGroups=yes
```

## Complete Hardened Service Examples

### Example 1: Hardened nginx

```ini
# /etc/systemd/system/nginx-hardened.service
[Unit]
Description=nginx HTTP Server (hardened)
After=network.target

[Service]
Type=forking
PIDFile=/run/nginx.pid
ExecStartPre=/usr/sbin/nginx -t
ExecStart=/usr/sbin/nginx
ExecReload=/bin/kill -s HUP $MAINPID
ExecStop=/bin/kill -s QUIT $MAINPID

# User/Group
User=www-data
Group=www-data

# Capabilities
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_SETUID CAP_SETGID
AmbientCapabilities=CAP_NET_BIND_SERVICE

# Filesystem
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/nginx /var/cache/nginx /run
ReadOnlyPaths=/etc/nginx /etc/ssl
InaccessiblePaths=/proc/sysrq-trigger

# Kernel protections
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
ProtectControlGroups=yes

# Other namespaces
PrivateIPC=yes
RestrictNamespaces=yes

# Syscall filtering
SystemCallFilter=@system-service @network-io @file-system @process @signal @basic-io @io-event
SystemCallFilter=~@debug @module @mount @raw-io @reboot @privileged
SystemCallArchitectures=native
SystemCallErrorNumber=EPERM

# No new privileges
NoNewPrivileges=yes

# Address families
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Network
IPAddressDeny=
# (Allow all networks - nginx needs to serve public traffic)

# Resource limits
LimitNOFILE=65536
LimitCORE=0

[Install]
WantedBy=multi-user.target
```

Verify the security score:

```bash
systemctl daemon-reload
systemctl start nginx-hardened
systemd-analyze security nginx-hardened.service
# Target: score below 4.0
```

### Example 2: Hardened PostgreSQL

```ini
# /etc/systemd/system/postgresql-hardened.service
[Unit]
Description=PostgreSQL Database Server (hardened)
After=network.target

[Service]
Type=notify
User=postgres
Group=postgres

ExecStart=/usr/lib/postgresql/15/bin/postgres \
  -D /var/lib/postgresql/15/main \
  -c config_file=/etc/postgresql/15/main/postgresql.conf

ExecReload=/bin/kill -HUP $MAINPID
KillMode=mixed
KillSignal=SIGINT
TimeoutSec=infinity

# Filesystem
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/postgresql /run/postgresql /var/log/postgresql

# Kernel protections
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
ProtectControlGroups=yes

# Capabilities
CapabilityBoundingSet=
AmbientCapabilities=

# Syscalls
SystemCallFilter=@system-service @network-io @file-system @process @signal @basic-io @io-event @ipc
SystemCallFilter=~@debug @module @mount @raw-io @reboot @privileged @keyring
SystemCallArchitectures=native
SystemCallErrorNumber=EPERM

NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
PrivateIPC=yes

# Resource limits
LimitNOFILE=65536
LimitCORE=0

[Install]
WantedBy=multi-user.target
```

### Example 3: Fully Sandboxed Microservice with DynamicUser

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Application (fully sandboxed)
After=network.target postgresql.service

[Service]
Type=simple
ExecStart=/usr/bin/myapp --config /etc/myapp/config.yaml

# Dynamic user - ephemeral identity
DynamicUser=yes
StateDirectory=myapp
CacheDirectory=myapp
LogsDirectory=myapp
RuntimeDirectory=myapp
ConfigurationDirectory=myapp

# Environment
Environment="APP_ENV=production"
EnvironmentFile=-/etc/myapp/env

# Filesystem (very strict - DynamicUser + ProtectSystem=strict)
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes

# Kernel protections (full set)
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
ProtectControlGroups=yes

# Network restrictions
PrivateNetwork=no
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8 ::1 10.0.0.0/8

# Capabilities - none needed
CapabilityBoundingSet=
AmbientCapabilities=

# No new privileges
NoNewPrivileges=yes

# Namespace restrictions
RestrictNamespaces=yes
PrivateIPC=yes
PrivateUsers=yes

# Syscall filtering
SystemCallFilter=@system-service @network-io @file-system @process @signal @basic-io @io-event
SystemCallFilter=~@debug @module @mount @raw-io @reboot @privileged @keyring @clock
SystemCallArchitectures=native
SystemCallErrorNumber=EPERM

# Memory limits
MemoryMax=512M
MemoryHigh=450M
MemorySwapMax=0

# CPU limits
CPUQuota=100%
TasksMax=256

# Security bits
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RemoveIPC=yes

[Install]
WantedBy=multi-user.target
```

## MemoryDenyWriteExecute and LockPersonality

Two directives often overlooked:

```ini
[Service]
# Prevents creating memory mappings that are both writable and executable
# Breaks JIT-compiled languages (Java, Node.js, Ruby with JIT)
# Safe for compiled Go, C, Rust, Python applications
MemoryDenyWriteExecute=yes

# Prevents changing the process personality (ABI) via personality(2)
# Prevents 32-bit execution on 64-bit systems
LockPersonality=yes

# Prevents acquiring realtime scheduling (SCHED_FIFO, SCHED_RR)
# which can lock up a system
RestrictRealtime=yes

# Prevents SUID/SGID bits from having effect
RestrictSUIDSGID=yes

# Remove IPC resources owned by the unit user/group on stop
RemoveIPC=yes
```

## Auditing and Verification

### Check What a Service Can Do

```bash
# Show effective security settings
systemctl show myapp.service --property=SystemCallFilter
systemctl show myapp.service --property=CapabilityBoundingSet
systemctl show myapp.service --property=ProtectSystem

# Show the effective environment
systemctl show myapp.service --property=Environment

# Check resource limits
systemctl show myapp.service --property=MemoryMax
```

### Monitor Security Violations

```bash
# Watch for seccomp violations (blocked syscalls)
journalctl -f --unit=myapp.service | grep "SIGSYS\|seccomp\|syscall"

# Audit log (requires auditd)
auditctl -a always,exit -F arch=b64 -S all -k myapp-audit
ausearch -k myapp-audit --start recent | head -50

# Check if service tried to access blocked paths
auditctl -w /etc/shadow -p rwa -k shadow-access
ausearch -k shadow-access | grep myapp
```

### Incremental Hardening Workflow

Start with a permissive configuration and progressively tighten:

```bash
# Step 1: Check the baseline security score
systemd-analyze security myapp.service

# Step 2: Apply hardening directives one group at a time
# Add filesystem protection, restart, verify service works
systemctl restart myapp.service
journalctl -u myapp.service -n 50

# Step 3: Check if any operations are now blocked
# Look for permission denied errors in the service log

# Step 4: Use strace to identify what syscalls the service uses
strace -e trace=all -f -p $(pgrep myapp) 2>&1 | grep EPERM

# Step 5: Adjust SystemCallFilter to allow blocked but needed syscalls

# Step 6: Repeat for each hardening group until score is below 4.0
```

## Conclusion

Systemd's security directives implement defense in depth at the service layer. A fully hardened service is isolated from the filesystem it doesn't need, cannot access hardware it doesn't use, is restricted to the system calls its legitimate workload requires, and runs with the minimum set of capabilities. When a service is compromised, this containment limits the blast radius to that service's allowed resources rather than the entire host. The DynamicUser feature is particularly powerful for stateless microservices, as it eliminates the attack surface of persistent user accounts. Apply these patterns incrementally—start with `ProtectSystem`, `PrivateTmp`, and `NoNewPrivileges`, then add syscall filtering and capability restrictions based on the specific requirements of each service.
