---
title: "Linux Seccomp Filters: System Call Whitelisting for Container Security"
date: 2030-08-10T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Seccomp", "Containers", "Kubernetes", "OCI", "Container Security"]
categories:
- Security
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production seccomp guide: seccomp-bpf filter design, seccomp profiles for OCI containers, Kubernetes default seccomp profiles, creating minimal profiles with strace analysis, seccomp-tools, and audit logging for seccomp violations."
more_link: "yes"
url: "/linux-seccomp-filters-system-call-whitelisting-container-security/"
---

Seccomp (Secure Computing Mode) restricts which system calls a process can invoke, transforming the Linux kernel's attack surface from hundreds of syscalls to only those required by the application. A well-crafted seccomp profile prevents entire classes of container escape exploits and privilege escalation techniques that rely on syscalls outside a workload's legitimate requirements.

<!--more-->

## Overview

This guide covers the design and operational deployment of seccomp-bpf filters for production container environments: filter architecture, creating profiles through strace analysis, the OCI seccomp profile format, Kubernetes default and custom profile configuration, seccomp-tools for profile development, and audit logging for violation detection.

## Seccomp Architecture

### Modes of Operation

Linux seccomp operates in two modes:
- **Mode 1 (strict)**: Only `read`, `write`, `_exit`, and `sigreturn` are allowed. All others cause SIGKILL. Used for sandboxing compute kernels.
- **Mode 2 (filter/BPF)**: A BPF program evaluates each syscall and returns an action. This is the mode used by containers.

```
Userspace Process
       │
       │ syscall(SYS_open, ...)
       │
       ▼
Seccomp BPF Filter
       │
       ├─── ALLOW   → syscall proceeds
       ├─── ERRNO   → syscall returns error (EPERM, ENOSYS, etc.)
       ├─── KILL    → process receives SIGSYS
       ├─── TRACE   → ptrace tracer is notified
       └─── LOG     → audit log written, syscall allowed
```

### BPF Filter Mechanics

```c
// What the kernel executes for each syscall:
// The BPF program receives: syscall number, architecture, args

struct seccomp_data {
    int nr;                  // Syscall number
    __u32 arch;              // Architecture identifier (e.g., AUDIT_ARCH_X86_64)
    __u64 instruction_pointer;
    __u64 args[6];           // Syscall arguments
};
```

The BPF program is a sequence of instructions that evaluate `seccomp_data` and return an action. Most production filters are expressed as JSON profiles and compiled to BPF by the container runtime.

## Seccomp Profiles: The OCI JSON Format

### Profile Structure

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": [
        "SCMP_ARCH_X86",
        "SCMP_ARCH_X32"
      ]
    },
    {
      "architecture": "SCMP_ARCH_AARCH64",
      "subArchitectures": [
        "SCMP_ARCH_ARM"
      ]
    }
  ],
  "syscalls": [
    {
      "names": ["read", "write", "close", "fstat", "lseek", "mmap", "mprotect",
                "munmap", "brk", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
                "pread64", "pwrite64", "readv", "writev", "access", "dup",
                "dup2", "getpid", "socket", "connect", "accept", "sendto",
                "recvfrom", "shutdown", "bind", "listen", "getsockname",
                "getpeername", "socketpair", "setsockopt", "getsockopt",
                "clone", "fork", "execve", "exit", "wait4", "kill",
                "uname", "fcntl", "flock", "fsync", "fdatasync",
                "getdents", "getcwd", "chdir", "rename", "mkdir", "rmdir",
                "creat", "link", "unlink", "symlink", "readlink", "stat",
                "lstat", "chmod", "lchown", "umask", "gettimeofday",
                "getrlimit", "getrusage", "sysinfo", "times", "ptrace",
                "getuid", "syslog", "getgid", "setuid", "setgid",
                "geteuid", "getegid", "setpgid", "getppid", "getpgrp",
                "setsid", "setreuid", "setregid", "getgroups", "setgroups",
                "setresuid", "getresuid", "setresgid", "getresgid",
                "getpgid", "setfsuid", "setfsgid", "getsid",
                "rt_sigpending", "rt_sigtimedwait", "rt_sigqueueinfo",
                "rt_sigsuspend", "sigaltstack", "utime", "mknod",
                "personality", "ustat", "statfs", "fstatfs",
                "getpriority", "setpriority", "sched_setparam",
                "sched_getparam", "sched_setscheduler", "sched_getscheduler",
                "sched_get_priority_max", "sched_get_priority_min",
                "sched_rr_get_interval", "mlock", "munlock", "mlockall",
                "munlockall", "vhangup", "pivot_root", "prctl",
                "arch_prctl", "adjtimex", "setrlimit", "chroot", "sync",
                "acct", "settimeofday", "mount", "umount2", "swapon",
                "swapoff", "reboot", "sethostname", "setdomainname",
                "iopl", "ioperm", "create_module", "init_module",
                "delete_module", "get_kernel_syms", "query_module",
                "quotactl", "nfsservctl", "getpmsg", "putpmsg",
                "afs_syscall", "tuxcall", "security", "gettid",
                "readahead", "setxattr", "lsetxattr", "fsetxattr",
                "getxattr", "lgetxattr", "fgetxattr", "listxattr",
                "llistxattr", "flistxattr", "removexattr", "lremovexattr",
                "fremovexattr", "tkill", "time", "futex", "sched_setaffinity",
                "sched_getaffinity", "set_thread_area", "io_setup", "io_destroy",
                "io_getevents", "io_submit", "io_cancel", "get_thread_area",
                "lookup_dcookie", "epoll_create", "epoll_ctl_old", "epoll_wait_old",
                "remap_file_pages", "getdents64", "set_tid_address",
                "restart_syscall", "semtimedop", "fadvise64", "timer_create",
                "timer_settime", "timer_gettime", "timer_getoverrun",
                "timer_delete", "clock_settime", "clock_gettime",
                "clock_getres", "clock_nanosleep", "exit_group",
                "epoll_wait", "epoll_ctl", "tgkill", "utimes",
                "vserver", "mbind", "set_mempolicy", "get_mempolicy",
                "mq_open", "mq_unlink", "mq_timedsend", "mq_timedreceive",
                "mq_notify", "mq_getsetattr", "kexec_load", "waitid",
                "add_key", "request_key", "keyctl", "ioprio_set",
                "ioprio_get", "inotify_init", "inotify_add_watch",
                "inotify_rm_watch", "migrate_pages", "openat", "mkdirat",
                "mknodat", "fchownat", "futimesat", "newfstatat",
                "unlinkat", "renameat", "linkat", "symlinkat", "readlinkat",
                "fchmodat", "faccessat", "pselect6", "ppoll", "unshare",
                "set_robust_list", "get_robust_list", "splice", "tee",
                "sync_file_range", "vmsplice", "move_pages", "utimensat",
                "epoll_pwait", "signalfd", "timerfd_create", "eventfd",
                "fallocate", "timerfd_settime", "timerfd_gettime",
                "accept4", "signalfd4", "eventfd2", "epoll_create1",
                "dup3", "pipe2", "inotify_init1", "preadv", "pwritev",
                "rt_tgsigqueueinfo", "perf_event_open", "recvmmsg",
                "fanotify_init", "fanotify_mark", "prlimit64",
                "name_to_handle_at", "open_by_handle_at", "clock_adjtime",
                "syncfs", "sendmmsg", "setns", "getcpu", "process_vm_readv",
                "process_vm_writev", "kcmp", "finit_module", "sched_setattr",
                "sched_getattr", "renameat2", "seccomp", "getrandom",
                "memfd_create", "kexec_file_load", "bpf", "execveat",
                "userfaultfd", "membarrier", "mlock2", "copy_file_range",
                "preadv2", "pwritev2", "pkey_mprotect", "pkey_alloc",
                "pkey_free", "statx", "io_pgetevents", "rseq",
                "pidfd_send_signal", "io_uring_setup", "io_uring_enter",
                "io_uring_register", "open_tree", "move_mount", "fsopen",
                "fsconfig", "fsmount", "fspick", "pidfd_open",
                "clone3", "close_range", "openat2", "pidfd_getfd",
                "faccessat2", "process_madvise", "epoll_pwait2",
                "mount_setattr", "landlock_create_ruleset",
                "landlock_add_rule", "landlock_restrict_self"],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["ptrace"],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1
    }
  ]
}
```

## Creating Minimal Profiles with strace

### Step 1: Run the Application Under strace

```bash
# Run application with strace to capture all syscalls
strace -f -e trace=all -o /tmp/syscalls.log ./my-service

# For a containerized application, use strace in the container
docker run --security-opt seccomp=unconfined \
  --cap-add SYS_PTRACE \
  -v /tmp:/tmp \
  my-service:latest \
  strace -f -e trace=all -o /tmp/syscalls.log ./app

# For Kubernetes pods with strace (debugging only):
kubectl debug -it pod/my-service-xxx \
  --image=nicolaka/netshoot \
  --share-processes \
  -- strace -p 1 -f -e trace=all -o /tmp/syscalls.log
```

### Step 2: Extract Unique Syscall Names

```bash
# Parse strace output to get unique syscall names
grep -oP '^\d+ +\K[a-z_0-9]+(?=\()' /tmp/syscalls.log | \
  sort -u > /tmp/required-syscalls.txt

cat /tmp/required-syscalls.txt
# Output example:
# accept4
# bind
# brk
# clone
# close
# connect
# epoll_create1
# epoll_ctl
# epoll_pwait
# exit_group
# ...
```

### Step 3: Generate a Profile with oci-seccomp-bpf-hook

```bash
# Install oci-seccomp-bpf-hook (OCI runtime hook for automatic profile generation)
dnf install -y oci-seccomp-bpf-hook  # Fedora/RHEL

# Run container with profile generation enabled
podman run \
  --annotation io.containers.trace-syscall=/tmp/my-service-profile.json \
  --security-opt seccomp=unconfined \
  my-service:latest

# The profile is written to /tmp/my-service-profile.json
```

### Step 4: Generate Profile with seccomp-tools

```bash
# Install seccomp-tools (Ruby gem for seccomp analysis)
gem install seccomp-tools

# Disassemble an existing seccomp filter from a running process
seccomp-tools dump /proc/$(pidof my-service)/fd/3

# Generate profile from syscall list
cat > generate-profile.rb << 'EOF'
require 'seccomp-tools'
require 'json'

syscalls = File.readlines('/tmp/required-syscalls.txt').map(&:chomp)

profile = {
  defaultAction: "SCMP_ACT_ERRNO",
  defaultErrnoRet: 1,
  archMap: [
    {
      architecture: "SCMP_ARCH_X86_64",
      subArchitectures: ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]
    }
  ],
  syscalls: [
    {
      names: syscalls,
      action: "SCMP_ACT_ALLOW"
    }
  ]
}

puts JSON.pretty_generate(profile)
EOF
ruby generate-profile.rb > /tmp/my-service-seccomp.json
```

## Docker Seccomp Profiles

### Applying a Profile to a Docker Container

```bash
# Apply profile at container creation
docker run \
  --security-opt seccomp=/etc/docker/seccomp/my-service.json \
  my-service:latest

# Use the Docker default profile
docker run \
  --security-opt seccomp=default \
  my-service:latest

# Disable seccomp (never in production)
docker run \
  --security-opt seccomp=unconfined \
  my-service:latest
```

### Docker Default Seccomp Profile

The Docker default seccomp profile blocks dangerous syscalls including:

```json
{
  "syscalls": [
    {
      "names": [
        "acct", "add_key", "bpf", "clock_adjtime", "clock_settime",
        "create_module", "delete_module", "finit_module", "get_kernel_syms",
        "get_mempolicy", "init_module", "ioperm", "iopl", "kcmp",
        "kexec_file_load", "kexec_load", "keyctl", "lookup_dcookie",
        "mbind", "mount", "move_pages", "name_to_handle_at",
        "nfsservctl", "open_by_handle_at", "perf_event_open",
        "personality", "pivot_root", "process_vm_readv", "process_vm_writev",
        "ptrace", "query_module", "quotactl", "reboot", "request_key",
        "set_mempolicy", "setns", "settimeofday", "stime",
        "swapoff", "swapon", "sysfs", "unshare", "umount", "umount2",
        "_sysctl", "vhangup", "vmsplice"
      ],
      "action": "SCMP_ACT_ERRNO"
    }
  ]
}
```

### Custom Minimal Profile for a Go HTTP Server

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]
    },
    {
      "architecture": "SCMP_ARCH_AARCH64",
      "subArchitectures": ["SCMP_ARCH_ARM"]
    }
  ],
  "syscalls": [
    {
      "names": [
        "accept4", "arch_prctl", "brk", "clone", "clone3", "close",
        "close_range", "epoll_create1", "epoll_ctl", "epoll_pwait",
        "epoll_pwait2", "epoll_wait", "exit", "exit_group", "faccessat",
        "faccessat2", "fcntl", "fstat", "futex", "getdents64", "getgid",
        "getpid", "getppid", "getrandom", "gettid", "getuid",
        "io_uring_enter", "io_uring_register", "io_uring_setup",
        "ioctl", "lseek", "madvise", "mmap", "mprotect", "munmap",
        "nanosleep", "newfstatat", "openat", "pipe2", "pread64",
        "pwrite64", "read", "readlinkat", "rt_sigaction", "rt_sigprocmask",
        "rt_sigreturn", "rt_sigsuspend", "sched_getaffinity",
        "sched_yield", "select", "sendfile", "set_robust_list",
        "set_tid_address", "sigaltstack", "socket", "setsockopt",
        "getsockopt", "getsockname", "getpeername", "bind", "listen",
        "connect", "sendto", "recvfrom", "shutdown",
        "statx", "tgkill", "uname", "write", "writev",
        "prctl", "timer_create", "timer_settime", "timer_gettime",
        "timer_delete", "clock_gettime", "clock_nanosleep",
        "pselect6", "ppoll", "wait4", "waitid",
        "setuid", "setgid", "setgroups", "capget", "capset"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

## Kubernetes Seccomp Profiles

### Default Seccomp Profile (Kubernetes v1.27+)

Since Kubernetes 1.27, the `RuntimeDefault` seccomp profile is enabled by default in new clusters. Explicitly enabling it in Pod specs ensures consistent behavior:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault   # Uses container runtime's default profile
  containers:
  - name: app
    image: registry.support.tools/app:v1.0.0
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop:
        - ALL
      readOnlyRootFilesystem: true
      runAsNonRoot: true
```

### Custom Seccomp Profile via Localhost

Kubernetes supports loading profiles from the node filesystem or from a `SeccompProfile` resource (with SPO):

```yaml
# Using a profile file on the node (deprecated in favor of SPO)
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: profiles/my-service.json
    # File must exist at: <kubelet-seccomp-dir>/profiles/my-service.json
    # Default kubelet-seccomp-dir: /var/lib/kubelet/seccomp
```

### Security Profiles Operator (SPO)

The Security Profiles Operator manages seccomp (and AppArmor) profiles as Kubernetes resources:

```bash
# Install SPO
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Verify installation
kubectl -n security-profiles-operator get pods
```

```yaml
# SeccompProfile resource
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: my-service-minimal
  namespace: production
spec:
  defaultAction: SCMP_ACT_ERRNO
  architectures:
  - SCMP_ARCH_X86_64
  - SCMP_ARCH_AARCH64
  syscalls:
  - action: SCMP_ACT_ALLOW
    names:
    - accept4
    - arch_prctl
    - brk
    - clone
    - close
    - epoll_create1
    - epoll_ctl
    - epoll_pwait
    - exit_group
    - faccessat
    - fcntl
    - fstat
    - futex
    - getrandom
    - gettid
    - io_uring_enter
    - io_uring_register
    - io_uring_setup
    - madvise
    - mmap
    - mprotect
    - munmap
    - nanosleep
    - openat
    - pread64
    - read
    - rt_sigaction
    - rt_sigprocmask
    - rt_sigreturn
    - sched_getaffinity
    - set_tid_address
    - sigaltstack
    - socket
    - statx
    - tgkill
    - write
    - prctl
    - clock_gettime
    - clock_nanosleep
```

Reference the profile in Pod spec:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # SPO annotation to use the SeccompProfile resource
        seccomp.security.alpha.kubernetes.io/pod: localhost/operator/production/my-service-minimal.json
    spec:
      securityContext:
        seccompProfile:
          type: Localhost
          localhostProfile: operator/production/my-service-minimal.json
```

### SPO Profile Recording

SPO can automatically generate profiles by observing workloads:

```yaml
# ProfileRecording resource
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: my-service-recording
  namespace: production
spec:
  kind: SeccompProfile
  recorder: bpf       # Use eBPF-based recording (more accurate than audit)
  podSelector:
    matchLabels:
      app: my-service
```

```bash
# Start recording
kubectl apply -f recording.yaml

# Run representative workload
kubectl -n production rollout restart deployment/my-service
# Wait for pods to cycle and traffic to flow through all endpoints
sleep 300

# Stop recording and collect profile
kubectl -n production delete profilerecording my-service-recording
# Profile is saved as a SeccompProfile resource automatically
kubectl -n production get seccompprofile my-service-recording -o yaml
```

## Audit Logging for Seccomp Violations

### SCMP_ACT_LOG Action

`SCMP_ACT_LOG` allows the syscall but writes an audit log entry. This is invaluable for profiling which syscalls are actually needed before switching to `SCMP_ACT_ERRNO`:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "syscalls": [
    {
      "names": ["read", "write", "close", "..."],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

### Reading Seccomp Audit Logs

```bash
# Seccomp violations appear in kernel audit log
ausearch -m seccomp | tail -20

# Or via journald
journalctl -k | grep seccomp

# Sample violation log entry:
# type=SECCOMP msg=audit(1721654400.000:12345): auid=1000 uid=0 gid=0
# ses=1 subj=system_u:system_r:container_t:s0
# pid=24601 comm="app" exe="/app/server"
# sig=0 arch=c000003e syscall=158 compat=0 ip=0x7f3a4b2c1234 code=0x7ffc0000

# syscall=158 maps to:
grep -r "^#define __NR_arch_prctl" /usr/include/asm/unistd_64.h
# arch_prctl = 158

# Convert syscall numbers to names
auditctl -l
ausyscall --dump | grep "^158"
```

### Prometheus Alerting for Seccomp Violations

```bash
# Node Exporter text collector for seccomp violations
cat /proc/self/status | grep Seccomp

# Custom metric via audit daemon
#!/bin/bash
# /usr/local/bin/seccomp-violations-collector.sh
VIOLATIONS=$(ausearch -m seccomp --start recent --end now 2>/dev/null | wc -l)
echo "# HELP seccomp_violations_total Seccomp filter violations"
echo "# TYPE seccomp_violations_total counter"
echo "seccomp_violations_total $VIOLATIONS"
```

```yaml
# Prometheus alerting rule
groups:
- name: seccomp
  rules:
  - alert: SeccompViolation
    expr: increase(seccomp_violations_total[5m]) > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Seccomp violations detected on {{ $labels.instance }}"
      description: "{{ $value }} seccomp violations in the last 5 minutes"
```

## OPA/Gatekeeper Policy for Seccomp Enforcement

Enforce seccomp profiles across all workloads with OPA Gatekeeper:

```yaml
# ConstraintTemplate requiring seccomp profiles
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequireseccomp
spec:
  crd:
    spec:
      names:
        kind: K8sRequireSeccomp
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedProfiles:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequireseccomp
      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.securityContext.seccompProfile
        not input.review.object.spec.securityContext.seccompProfile
        msg := sprintf("Container %v requires a seccomp profile", [container.name])
      }
      violation[{"msg": msg}] {
        profile := input.review.object.spec.securityContext.seccompProfile.type
        not profile_allowed(profile)
        msg := sprintf("Seccomp profile type %v is not allowed", [profile])
      }
      profile_allowed(profile) {
        allowed := input.parameters.allowedProfiles
        profile == allowed[_]
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireSeccomp
metadata:
  name: require-seccomp-profile
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
    - kube-public
  parameters:
    allowedProfiles:
    - RuntimeDefault
    - Localhost
```

## Seccomp for Privileged Workloads

Some workloads legitimately need elevated capabilities (e.g., network monitoring, storage drivers). For these, craft a targeted profile that allows the required capabilities-related syscalls without opening the full syscall table:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "read", "write", "close", "fstat", "mmap", "mprotect",
        "munmap", "brk", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "socket", "connect", "accept", "sendto", "recvfrom", "shutdown",
        "bind", "listen", "getsockname", "setsockopt", "getsockopt",
        "clone", "exit", "wait4", "kill", "uname", "fcntl",
        "getdents64", "getcwd", "stat", "lstat", "access",
        "getuid", "getgid", "geteuid", "getegid",
        "setuid", "setgid", "setgroups",
        "capget", "capset",
        "prctl",
        "openat", "newfstatat", "readlinkat", "futex",
        "clock_gettime", "clock_nanosleep", "getrandom",
        "epoll_create1", "epoll_ctl", "epoll_pwait",
        "set_tid_address", "exit_group", "tgkill",
        "rt_sigprocmask", "rt_sigaction",
        "madvise", "brk", "sched_yield"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["perf_event_open"],
      "action": "SCMP_ACT_ALLOW",
      "comment": "Required for eBPF perf events"
    },
    {
      "names": ["bpf"],
      "action": "SCMP_ACT_ALLOW",
      "comment": "Required for eBPF programs"
    },
    {
      "names": ["ioctl"],
      "action": "SCMP_ACT_ALLOW",
      "comment": "Required for network interface management"
    }
  ]
}
```

## Testing Seccomp Profiles

### Validating a Profile Before Deployment

```bash
# Test profile in a container without affecting production
docker run \
  --rm \
  --security-opt seccomp=/tmp/my-service-seccomp.json \
  my-service:latest \
  /app/server --health-check-only

# Check exit code
echo "Exit: $?"

# Run integration tests against profile
docker run \
  --rm \
  --security-opt seccomp=/tmp/my-service-seccomp.json \
  -p 8080:8080 \
  my-service:latest &

# Run test suite
go test ./... -v -run TestIntegration
docker stop $(docker ps -q --filter ancestor=my-service:latest)
```

### Detecting Blocked Syscalls During Testing

```bash
# Use SCMP_ACT_KILL_PROCESS with PTRACE to capture blocked syscalls
docker run \
  --security-opt seccomp=/tmp/test-profile.json \
  --cap-add SYS_PTRACE \
  my-service:latest \
  strace -f -e 'trace=!read,write,close' ./app 2>&1 | grep -i "operation not permitted\|EPERM\|ENOSYS"
```

## Summary

Seccomp filters provide a kernel-level mechanism for reducing attack surface by restricting the syscall interface available to container workloads. Effective profiles are built from observed syscall behavior via strace or SPO recording, expressed in the OCI JSON format, and applied through container runtime security options or Kubernetes `seccompProfile` spec fields. The Security Profiles Operator simplifies profile lifecycle management in Kubernetes. Audit logging with `SCMP_ACT_LOG` enables detection of unexpected syscall usage in pre-production environments. OPA Gatekeeper policies enforce that all production workloads declare a seccomp profile, closing the gap between capability and enforcement.
