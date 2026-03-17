---
title: "Linux Capabilities: Privilege Reduction for Secure Service Deployment"
date: 2031-01-25T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Capabilities", "Containers", "Kubernetes", "seccomp", "Privilege Reduction"]
categories:
- Linux
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux capabilities: capability set theory, dropping capabilities in containers, CAP_NET_BIND_SERVICE alternatives, seccomp interaction, and configuring Kubernetes securityContext capabilities for production workloads."
more_link: "yes"
url: "/linux-capabilities-privilege-reduction-secure-service-deployment/"
---

Running services as root is a security anti-pattern that grants unlimited access to the kernel's privilege system. Linux capabilities divide root privileges into independent units that can be granted or removed individually. A web server needs to bind to port 80, not read other processes' memory. A container needs to configure network interfaces, not load kernel modules. This guide explains the capability model, how to minimize capability sets for production services, alternatives to CAP_NET_BIND_SERVICE, and how Kubernetes securityContext maps to underlying Linux capability controls.

<!--more-->

# Linux Capabilities: Privilege Reduction for Secure Service Deployment

## Linux Capability Model

Linux capabilities were introduced in kernel 2.2 to break the all-or-nothing privilege model. Instead of root having every privilege, each privilege (binding to privileged ports, changing UIDs, sending raw network packets, etc.) is an individually addressable bit.

There are currently 41 capabilities in Linux 6.x. Common ones:

| Capability | What it enables |
|-----------|-----------------|
| CAP_NET_BIND_SERVICE | Bind to ports below 1024 |
| CAP_NET_ADMIN | Configure network interfaces, routes, firewall rules |
| CAP_NET_RAW | Open raw/packet sockets (required for ping) |
| CAP_SYS_ADMIN | Many privileged system operations (too broad, avoid) |
| CAP_CHOWN | Change file ownership |
| CAP_DAC_OVERRIDE | Bypass file permission checks |
| CAP_SETUID | Change process UID |
| CAP_SETGID | Change process GID |
| CAP_SYS_PTRACE | Trace other processes |
| CAP_KILL | Send signals to any process |
| CAP_IPC_LOCK | Lock memory (mlock) |
| CAP_SYS_NICE | Set process priority below 0 |
| CAP_SYS_RESOURCE | Override resource limits |
| CAP_AUDIT_WRITE | Write to kernel audit log |

## The Five Capability Sets

Every process has five capability sets:

### 1. Permitted (P)
The maximum capabilities a process can ever have. These are the capabilities it's allowed to use. A process can only raise its effective capabilities to those in its permitted set.

### 2. Effective (E)
The capabilities currently active for privilege checks. A process can raise and lower capabilities within its permitted set. System calls check the effective set.

### 3. Inheritable (I)
Capabilities preserved across `execve()`. A new program can only gain capabilities in the intersection of the calling process's inheritable set and the file's inheritable set.

### 4. Bounding (B)
A cap on capabilities that can ever be gained via execve. Once removed from the bounding set, a capability can never be reacquired in the current process tree (without a suid-root program).

### 5. Ambient (A)
Capabilities that are preserved across execve for non-suid programs (added in Linux 4.3). The most practical mechanism for giving child processes specific capabilities without files having capability bits set.

```
When a program is exec'd:
  New Permitted = (File Permitted & Bounding) | (Ambient ∩ File Inheritable) | Ambient
  New Effective = File Effective ? New Permitted : (Ambient)
  New Inheritable = Inheritable (unchanged)
  Ambient = Ambient (if not suid/sgid)
```

## Viewing Capabilities

```bash
# View your own capabilities
cat /proc/self/status | grep -E 'Cap(Inh|Prm|Eff|Bnd|Amb)'
# CapInh: 0000000000000000
# CapPrm: 0000000000000000
# CapEff: 0000000000000000
# CapBnd: 000001ffffffffff
# CapAmb: 0000000000000000

# Decode capability hex bitmask
capsh --decode=000001ffffffffff
# 0x000001ffffffffff=cap_chown,cap_dac_override,...,cap_checkpoint_restore

# View capabilities of a running process
cat /proc/$(pgrep nginx)/status | grep Cap
capsh --decode=$(cat /proc/$(pgrep nginx)/status | grep CapEff | awk '{print $2}')

# View file capabilities
getcap /usr/bin/ping
# /usr/bin/ping cap_net_raw=ep

# List all files with capabilities
find / -xdev 2>/dev/null -exec getcap {} \; 2>/dev/null | grep -v '^$'
```

## Setting Capabilities on Files

```bash
# Grant CAP_NET_BIND_SERVICE to a binary (allows binding to ports < 1024)
# This is a common alternative to running as root
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/myserver

# Verify
getcap /usr/local/bin/myserver
# /usr/local/bin/myserver cap_net_bind_service=ep
# e = effective (active immediately when program runs)
# p = permitted (allowed to be made effective)

# Remove all capabilities from a file
sudo setcap -r /usr/local/bin/myserver

# Set multiple capabilities
sudo setcap 'cap_net_bind_service,cap_net_admin=+ep' /usr/local/bin/myserver

# Grant capability to a Go binary
# Note: Go binaries must be compiled with CGO or the capability will be dropped
# after the Go runtime initializes (capability-aware fork+exec issue)
# Use ambient capabilities instead for Go programs
```

### The Go Binary Capability Problem

Go programs have a multi-threaded runtime that uses `clone()` internally. File capabilities (P/E bits) work with single-threaded exec, but Go's runtime initialization can cause capability loss:

```bash
# Incorrect: file capability may be lost after Go runtime init
setcap 'cap_net_bind_service=+ep' ./mygoserver

# Correct approach 1: Use ambient capabilities (Linux 4.3+)
# Set parent process ambient capabilities before exec
capsh --caps="cap_net_bind_service+pie" \
      --user=myuser \
      -- -c ./mygoserver

# Correct approach 2: systemd with AmbientCapabilities
# [Service]
# AmbientCapabilities=CAP_NET_BIND_SERVICE
# User=myuser
# ExecStart=/usr/local/bin/mygoserver

# Correct approach 3: In Go code, manage capabilities programmatically
```

### Managing Capabilities in Go

```go
// capabilities.go
package main

import (
    "fmt"
    "log"
    "net"
    "os"
    "runtime"

    "kernel.org/pub/linux/libs/security/libcap/cap"
)

func dropCapabilitiesAfterBind() error {
    // Get current process capabilities
    caps, err := cap.GetPID(0)
    if err != nil {
        return fmt.Errorf("get capabilities: %w", err)
    }

    // Drop all capabilities except what we need for operation
    // After binding to port 80, we no longer need NET_BIND_SERVICE
    newCaps, err := cap.FromText("=")
    if err != nil {
        return err
    }

    if err := caps.SetProc(); err != nil {
        return fmt.Errorf("set capabilities: %w", err)
    }

    _ = newCaps
    return nil
}

func main() {
    // Lock OS thread for capability operations
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Bind to privileged port before dropping capabilities
    ln, err := net.Listen("tcp", ":80")
    if err != nil {
        log.Fatalf("Listen: %v", err)
    }

    // Drop capabilities we no longer need
    if err := dropCapabilitiesAfterBind(); err != nil {
        log.Printf("Warning: failed to drop capabilities: %v", err)
    }

    // Drop to unprivileged user
    if os.Getuid() == 0 {
        // In production, use syscall.Setuid/Setgid here
        log.Println("Warning: still running as root")
    }

    log.Printf("Listening on :80 with reduced privileges")
    // Serve connections...
    _ = ln
}
```

## CAP_NET_BIND_SERVICE Alternatives

Binding to ports below 1024 (privileged ports) requires special handling. CAP_NET_BIND_SERVICE is one approach, but has security trade-offs.

### Alternative 1: Non-Privileged Port + Reverse Proxy

The most secure approach: run the application on port 8080 and proxy from port 80:

```nginx
# nginx.conf - runs with CAP_NET_BIND_SERVICE, proxies to app on 8080
server {
    listen 80;
    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

### Alternative 2: systemd Socket Activation

systemd binds the socket as root and passes it to the service:

```ini
# /etc/systemd/system/myapp.socket
[Socket]
ListenStream=80
BindIPv6Only=both

# /etc/systemd/system/myapp.service
[Service]
User=myapp
ExecStart=/usr/local/bin/myapp
# Socket is passed as FD 3 (LISTEN_FDS env var)
# No need for CAP_NET_BIND_SERVICE in the service
```

```go
// Go socket activation support
import "github.com/coreos/go-systemd/v22/activation"

func main() {
    listeners, err := activation.Listeners()
    if err != nil {
        log.Fatal(err)
    }

    if len(listeners) > 0 {
        // Socket passed by systemd - use it directly
        http.Serve(listeners[0], handler)
    } else {
        // Running standalone - bind normally
        http.ListenAndServe(":8080", handler)
    }
}
```

### Alternative 3: IP_FREEBIND + Port 80

```go
// Bind to port 80 using IP_FREEBIND (doesn't require NET_BIND_SERVICE
// but requires CAP_NET_ADMIN, which is also powerful - trade-off)
lc := net.ListenConfig{
    Control: func(network, address string, c syscall.RawConn) error {
        return c.Control(func(fd uintptr) {
            syscall.SetsockoptInt(int(fd), syscall.SOL_IP, syscall.IP_FREEBIND, 1)
        })
    },
}
```

### Alternative 4: sysctl net.ipv4.ip_unprivileged_port_start

```bash
# Allow all users to bind to ports >= 80 (Linux 4.11+)
# Useful in container environments
sysctl -w net.ipv4.ip_unprivileged_port_start=80

# Make persistent
echo 'net.ipv4.ip_unprivileged_port_start=80' >> /etc/sysctl.d/99-unprivileged-ports.conf
sysctl -p /etc/sysctl.d/99-unprivileged-ports.conf

# This setting is per-namespace - containers get their own namespace
# so it can be set to 0 in the container without affecting the host
```

## Capability Reduction in Containers

### Docker

```bash
# Docker drops many capabilities by default
# Default set includes: CHOWN, DAC_OVERRIDE, FSETID, FOWNER, MKNOD,
# NET_RAW, SETGID, SETUID, SETFCAP, SETPCAP, NET_BIND_SERVICE,
# SYS_CHROOT, KILL, AUDIT_WRITE

# Drop all capabilities, add only what's needed
docker run \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --user=1000:1000 \
  myimage

# Verify capabilities in running container
docker exec -it mycontainer capsh --print
```

### Dockerfile Best Practices

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Minimal production image
FROM scratch
# Copy CA certificates for HTTPS
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/server /server

# Run as non-root user
# UID/GID 65534 = nobody
USER 65534:65534

EXPOSE 8080  # Non-privileged port
ENTRYPOINT ["/server"]
```

## Kubernetes securityContext Capabilities

Kubernetes maps `securityContext.capabilities` directly to Linux capability operations on the container:

### Pod-Level securityContext

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  # Pod-level security context (applies to all containers)
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 2000
    # Prevent privilege escalation via setuid/setcap binaries
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: myapp:latest
    # Container-level security context
    securityContext:
      # Drop all capabilities, add only needed ones
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE  # Only if binding to port < 1024
      # Prevent execve from gaining capabilities
      allowPrivilegeEscalation: false
      # Read-only root filesystem
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 1000
```

### Capability Profiles

```yaml
# Profile 1: Minimum viable (most services)
securityContext:
  capabilities:
    drop:
    - ALL
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true

# Profile 2: Network services (need to bind privileged ports)
securityContext:
  capabilities:
    drop:
    - ALL
    add:
    - NET_BIND_SERVICE
  allowPrivilegeEscalation: false
  runAsNonRoot: true

# Profile 3: Privileged infrastructure (e.g., CNI plugins, monitoring)
securityContext:
  capabilities:
    drop:
    - MKNOD        # Create device files
    - AUDIT_WRITE  # Write to audit log
    - SETFCAP      # Set file capabilities (dangerous)
    add:
    - NET_ADMIN    # Configure network
    - NET_RAW      # Raw sockets (for ping, etc.)
  allowPrivilegeEscalation: false

# Profile 4: eBPF / observability tools
securityContext:
  capabilities:
    drop:
    - ALL
    add:
    - SYS_ADMIN    # BPF operations (prefer BPF/PERFMON caps on newer kernels)
    - PERFMON      # Kernel 5.8+: fine-grained perf monitoring
    - BPF          # Kernel 5.8+: BPF operations without full SYS_ADMIN
  privileged: false  # Even with SYS_ADMIN, not fully privileged
```

### Restricted Pod Security Standards

Kubernetes 1.25+ Pod Security Standards enforce capability policies:

```yaml
# Enforce restricted profile on a namespace
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Restricted: requires drop ALL, no privileged, no host namespaces
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.27
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.27
```

The restricted profile requires:
- `capabilities.drop` must include `ALL`
- `capabilities.add` is limited to `NET_BIND_SERVICE` only
- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true`

### OPA/Gatekeeper Capability Policy

```yaml
# Enforce no new capabilities beyond an allowlist
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedcapabilities
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedCapabilities
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedCapabilities:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8sallowedcapabilities

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        cap := container.securityContext.capabilities.add[_]
        not allowed_cap(cap)
        msg := sprintf("Container %v adds disallowed capability %v", [container.name, cap])
      }

      allowed_cap(cap) {
        cap == input.parameters.allowedCapabilities[_]
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedCapabilities
metadata:
  name: production-allowed-capabilities
spec:
  match:
    namespaces: ["production", "staging"]
  parameters:
    allowedCapabilities:
    - NET_BIND_SERVICE
    # All other capabilities are blocked
```

## seccomp Integration

seccomp complements capabilities by filtering system calls. A process can have a capability but still be blocked by seccomp:

```yaml
# Use runtime default seccomp profile (blocks ~300 syscalls)
securityContext:
  seccompProfile:
    type: RuntimeDefault

# Custom seccomp profile for tighter control
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: profiles/myapp-seccomp.json
```

Custom seccomp profile example:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
  "syscalls": [
    {
      "names": [
        "read", "write", "close", "fstat", "lstat",
        "poll", "lseek", "mmap", "mprotect", "munmap",
        "brk", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "pread64", "pwrite64", "readv", "writev",
        "access", "pipe", "select", "sched_yield",
        "mremap", "msync", "mincore", "madvise",
        "shmget", "shmat", "shmctl",
        "dup", "dup2", "pause", "nanosleep",
        "getitimer", "alarm", "setitimer",
        "getpid", "sendfile", "socket", "connect",
        "accept", "sendto", "recvfrom", "sendmsg", "recvmsg",
        "shutdown", "bind", "listen", "getsockname", "getpeername",
        "socketpair", "setsockopt", "getsockopt",
        "clone", "fork", "vfork", "execve",
        "exit", "wait4", "kill", "uname",
        "semget", "semop", "semctl", "shmdt",
        "fcntl", "flock", "fsync", "fdatasync",
        "truncate", "ftruncate", "getdents", "getcwd",
        "chdir", "fchdir", "rename", "mkdir", "rmdir",
        "creat", "link", "unlink", "symlink", "readlink",
        "chmod", "fchmod", "chown", "fchown", "lchown",
        "umask", "gettimeofday", "getrlimit", "getrusage",
        "sysinfo", "times", "ptrace", "getuid", "syslog",
        "getgid", "setuid", "setgid", "geteuid", "getegid",
        "setpgid", "getppid", "getpgrp", "setsid", "setreuid",
        "setregid", "getgroups", "setgroups", "setresuid",
        "getresuid", "setresgid", "getresgid", "getpgid",
        "setfsuid", "setfsgid", "getsid", "capget", "capset",
        "rt_sigpending", "rt_sigtimedwait", "rt_sigqueueinfo",
        "rt_sigsuspend", "sigaltstack", "utime", "mknod",
        "uselib", "personality", "ustat", "statfs", "fstatfs",
        "sysfs", "getpriority", "setpriority", "sched_setparam",
        "sched_getparam", "sched_setscheduler", "sched_getscheduler",
        "sched_get_priority_max", "sched_get_priority_min",
        "sched_rr_get_interval", "mlock", "munlock", "mlockall",
        "munlockall", "vhangup", "modify_ldt", "pivot_root",
        "prctl", "arch_prctl", "adjtimex", "setrlimit",
        "chroot", "sync", "acct", "settimeofday", "mount",
        "umount2", "swapon", "swapoff", "reboot",
        "sethostname", "setdomainname", "iopl", "ioperm",
        "create_module", "init_module", "delete_module",
        "query_module", "quotactl", "nfsservctl",
        "getpmsg", "putpmsg", "afs_syscall", "tuxcall",
        "security", "gettid", "readahead", "setxattr",
        "lsetxattr", "fsetxattr", "getxattr", "lgetxattr",
        "fgetxattr", "listxattr", "llistxattr", "flistxattr",
        "removexattr", "lremovexattr", "fremovexattr",
        "tkill", "time", "futex", "sched_setaffinity",
        "sched_getaffinity", "set_thread_area", "io_setup",
        "io_destroy", "io_getevents", "io_submit", "io_cancel",
        "get_thread_area", "lookup_dcookie", "epoll_create",
        "epoll_ctl_old", "epoll_wait_old", "remap_file_pages",
        "getdents64", "set_tid_address", "restart_syscall",
        "semtimedop", "fadvise64", "timer_create", "timer_settime",
        "timer_gettime", "timer_getoverrun", "timer_delete",
        "clock_settime", "clock_gettime", "clock_getres",
        "clock_nanosleep", "exit_group", "epoll_wait",
        "epoll_ctl", "tgkill", "utimes", "vserver",
        "mbind", "set_mempolicy", "get_mempolicy",
        "mq_open", "mq_unlink", "mq_timedsend",
        "mq_timedreceive", "mq_notify", "mq_getsetattr",
        "kexec_load", "waitid", "add_key", "request_key",
        "keyctl", "ioprio_set", "ioprio_get", "inotify_init",
        "inotify_add_watch", "inotify_rm_watch", "migrate_pages",
        "openat", "mkdirat", "mknodat", "fchownat",
        "futimesat", "newfstatat", "unlinkat", "renameat",
        "linkat", "symlinkat", "readlinkat", "fchmodat",
        "faccessat", "pselect6", "ppoll", "unshare",
        "set_robust_list", "get_robust_list", "splice",
        "tee", "sync_file_range", "vmsplice", "move_pages",
        "utimensat", "epoll_pwait", "signalfd",
        "timerfd_create", "eventfd", "fallocate",
        "timerfd_settime", "timerfd_gettimerfd",
        "signalfd4", "eventfd2", "epoll_create1",
        "dup3", "pipe2", "inotify_init1", "preadv",
        "pwritev", "rt_tgsigqueueinfo", "perf_event_open",
        "recvmmsg", "fanotify_init", "fanotify_mark",
        "prlimit64", "name_to_handle_at", "open_by_handle_at",
        "clock_adjtime", "syncfs", "sendmmsg", "setns",
        "getcpu", "process_vm_readv", "process_vm_writev",
        "kcmp", "finit_module", "sched_setattr",
        "sched_getattr", "renameat2", "seccomp",
        "getrandom", "memfd_create", "kexec_file_load",
        "bpf", "execveat", "userfaultfd", "membarrier",
        "mlock2", "copy_file_range", "preadv2", "pwritev2",
        "pkey_mprotect", "pkey_alloc", "pkey_free",
        "statx", "io_pgetevents", "rseq",
        "pidfd_send_signal", "io_uring_setup", "io_uring_enter",
        "io_uring_register", "open_tree", "move_mount",
        "fsopen", "fsconfig", "fsmount", "fspick",
        "pidfd_open", "clone3", "close_range",
        "openat2", "pidfd_getfd", "faccessat2",
        "process_madvise", "epoll_pwait2", "mount_setattr",
        "quotactl_fd", "landlock_create_ruleset",
        "landlock_add_rule", "landlock_restrict_self",
        "memfd_secret", "process_mrelease"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

## Practical Security Hardening Script

```bash
#!/bin/bash
# harden-service.sh - Apply capability hardening to a service binary
set -euo pipefail

SERVICE_BINARY=$1
SERVICE_USER=${2:-"nobody"}
CAPABILITIES=${3:-"cap_net_bind_service"}

if [ -z "$SERVICE_BINARY" ]; then
    echo "Usage: $0 <binary_path> [user] [capabilities]"
    exit 1
fi

# 1. Set file capabilities
echo "Setting capabilities on $SERVICE_BINARY..."
setcap "${CAPABILITIES}=+ep" "$SERVICE_BINARY"
getcap "$SERVICE_BINARY"

# 2. Verify user exists
if ! id "$SERVICE_USER" &>/dev/null; then
    echo "Creating service user: $SERVICE_USER"
    useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

# 3. Set ownership - binary owned by root, readable by service user
chown root:$(id -gn "$SERVICE_USER") "$SERVICE_BINARY"
chmod 750 "$SERVICE_BINARY"

# 4. Apply bounding capability set via systemd service
cat > "/etc/systemd/system/${SERVICE_USER}.service.d/capabilities.conf" << EOF
[Service]
User=${SERVICE_USER}
AmbientCapabilities=${CAPABILITIES/cap_/CAP_}
CapabilityBoundingSet=${CAPABILITIES/cap_/CAP_}
NoNewPrivileges=yes
SecureBits=keep-caps
EOF

systemctl daemon-reload
echo "Service hardening complete"
```

## Auditing Capability Usage

```bash
# Audit processes using high-privilege capabilities
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    caps=$(cat /proc/$pid/status 2>/dev/null | grep CapEff | awk '{print $2}')
    if [ -n "$caps" ] && [ "$caps" != "0000000000000000" ]; then
        comm=$(cat /proc/$pid/comm 2>/dev/null)
        decoded=$(capsh --decode=$caps 2>/dev/null)
        echo "PID $pid ($comm): $decoded"
    fi
done 2>/dev/null

# Use auditd to log capability violations
auditctl -a always,exit -F arch=b64 -S capset -k capability_changes

# Monitor with ausearch
ausearch -k capability_changes -ts recent
```

## Conclusion

Linux capabilities are a foundational security control for production services:

1. **Principle of least privilege**: Every service should operate with only the capabilities it genuinely needs; start with `--cap-drop=ALL` and add back only what's required
2. **CAP_NET_BIND_SERVICE alternatives**: Prefer port 8080+ with reverse proxy, systemd socket activation, or `sysctl net.ipv4.ip_unprivileged_port_start` before granting NET_BIND_SERVICE
3. **Go programs**: File capabilities interact poorly with Go's multi-threaded runtime; use ambient capabilities via systemd `AmbientCapabilities` or wrapper scripts
4. **Kubernetes**: Use `capabilities.drop: [ALL]` plus specific `add` entries; combine with `allowPrivilegeEscalation: false` and `readOnlyRootFilesystem: true` for defense in depth
5. **seccomp complementarity**: Capabilities control privilege level; seccomp controls system call access; both are needed for strong container isolation
6. **OPA/Gatekeeper**: Enforce capability allowlists cluster-wide to prevent inadvertent privilege escalation in multi-tenant environments
