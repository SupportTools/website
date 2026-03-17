---
title: "Linux Security Hardening for Container Hosts: seccomp, AppArmor, and Audit"
date: 2027-09-21T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Containers", "seccomp", "AppArmor", "SELinux", "auditd"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Linux security hardening for container hosts covering seccomp BPF profiles, AppArmor policies, auditd rules, SELinux contexts, kernel module lockdown, and USBGuard configuration."
more_link: "yes"
url: "/linux-security-hardening-containers-guide/"
---

Container hosts require multiple overlapping security mechanisms that operate at different layers of the Linux kernel stack. seccomp BPF restricts the syscall surface available to container processes, AppArmor and SELinux enforce mandatory access control policies at the LSM layer, and auditd provides forensic-quality event logging for compliance and incident response. This guide covers production-grade implementation of all four mechanisms alongside kernel module hardening, USBGuard, and validation tooling suitable for CIS Benchmark compliance.

<!--more-->

## Security Architecture Overview

A hardened container host layers defenses across multiple enforcement boundaries:

- **Kernel syscall filter (seccomp)** — reduces attack surface by blocking syscalls containers never legitimately need
- **Linux Security Module (AppArmor/SELinux)** — mandatory access control for filesystem paths, capabilities, and IPC
- **Audit subsystem (auditd)** — structured logging of security-relevant events for SIEM ingestion
- **Kernel lockdown** — prevents runtime kernel modification via `/dev/mem`, kprobes, and unsigned modules
- **USBGuard** — policy-based USB device authorization at the udev layer

Each layer is independent; a bypass in one does not compromise the others.

## seccomp BPF Profiles

### Default Container Runtime Profiles

The Docker/containerd default seccomp profile blocks approximately 44 syscalls. For most workloads the default is the correct starting point — custom profiles should restrict further, not relax the default.

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
        "accept", "accept4", "access", "bind", "brk",
        "capget", "capset", "chdir", "chmod", "chown",
        "clock_getres", "clock_gettime", "clock_nanosleep",
        "close", "connect", "copy_file_range",
        "dup", "dup2", "dup3",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_wait",
        "eventfd", "eventfd2", "execve", "execveat", "exit", "exit_group",
        "faccessat", "faccessat2", "fadvise64", "fallocate", "fanotify_mark",
        "fchdir", "fchmod", "fchmodat", "fchown", "fchownat",
        "fcntl", "fdatasync", "fgetxattr", "flistxattr", "flock",
        "fork", "fremovexattr", "fsetxattr", "fstat", "fstatfs",
        "fsync", "ftruncate", "futex", "futex_time64", "futimesat",
        "getcpu", "getcwd", "getdents", "getdents64", "getegid",
        "geteuid", "getgid", "getgroups", "getitimer", "getpeername",
        "getpgid", "getpgrp", "getpid", "getppid", "getpriority",
        "getrandom", "getresgid", "getresuid", "getrlimit", "get_robust_list",
        "getrusage", "getsid", "getsockname", "getsockopt", "gettid",
        "gettimeofday", "getuid", "getxattr",
        "inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch",
        "io_cancel", "ioctl", "io_destroy", "io_getevents", "ioprio_get",
        "ioprio_set", "io_setup", "io_submit", "io_uring_enter",
        "io_uring_register", "io_uring_setup",
        "kill", "lchown", "lgetxattr", "link", "linkat",
        "listen", "listxattr", "llistxattr", "lremovexattr", "lseek",
        "lsetxattr", "lstat", "madvise", "memfd_create", "mincore",
        "mkdir", "mkdirat", "mknod", "mknodat", "mlock",
        "mlock2", "mlockall", "mmap", "mount", "mprotect",
        "mq_getsetattr", "mq_notify", "mq_open", "mq_timedreceive",
        "mq_timedreceive_time64", "mq_timedsend", "mq_timedsend_time64",
        "mq_unlink", "mremap", "msgctl", "msgget", "msgrcv",
        "msgsnd", "msync", "munlock", "munlockall", "munmap",
        "nanosleep", "newfstatat", "open", "openat", "openat2",
        "pause", "pidfd_open", "pidfd_send_signal",
        "pipe", "pipe2", "poll", "ppoll", "ppoll_time64",
        "prctl", "pread64", "preadv", "preadv2", "prlimit64",
        "pselect6", "pselect6_time64", "ptrace",
        "pwrite64", "pwritev", "pwritev2",
        "read", "readahead", "readlink", "readlinkat", "readv",
        "recv", "recvfrom", "recvmmsg", "recvmmsg_time64", "recvmsg",
        "remap_file_pages", "removexattr", "rename", "renameat", "renameat2",
        "restart_syscall", "rmdir", "rseq",
        "rt_sigaction", "rt_sigpending", "rt_sigprocmask",
        "rt_sigqueueinfo", "rt_sigreturn", "rt_sigsuspend", "rt_sigtimedwait",
        "rt_sigtimedwait_time64", "rt_tgsigqueueinfo",
        "sched_getaffinity", "sched_getattr", "sched_getparam",
        "sched_get_priority_max", "sched_get_priority_min", "sched_getscheduler",
        "sched_rr_get_interval", "sched_rr_get_interval_time64",
        "sched_setaffinity", "sched_setattr", "sched_setparam",
        "sched_setscheduler", "sched_yield",
        "seccomp", "select", "semctl", "semget", "semop",
        "semtimedop", "semtimedop_time64",
        "send", "sendfile", "sendfile64", "sendmmsg", "sendmsg", "sendto",
        "setfsgid", "setfsuid", "setgid", "setgroups", "setitimer",
        "setpgid", "setpriority", "setregid", "setresgid",
        "setresuid", "setreuid", "setrlimit", "set_robust_list",
        "setsid", "setsockopt", "set_tid_address", "setuid", "setxattr",
        "shmat", "shmctl", "shmdt", "shmget",
        "shutdown", "sigaltstack", "signalfd", "signalfd4",
        "socket", "socketpair", "splice", "stat", "statfs",
        "statx", "symlink", "symlinkat", "sync", "sync_file_range",
        "syncfs", "sysinfo", "tee", "tgkill", "time",
        "timer_create", "timer_delete", "timer_getoverrun",
        "timer_gettime", "timer_gettime64", "timer_settime", "timer_settime64",
        "timerfd_create", "timerfd_gettime", "timerfd_gettime64",
        "timerfd_settime", "timerfd_settime64", "times", "tkill",
        "truncate", "uname", "unlink", "unlinkat", "utime",
        "utimensat", "utimensat_time64", "utimes",
        "vfork", "vmsplice", "wait4", "waitid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["personality"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {"index": 0, "value": 0, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 8, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 131072, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 131080, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 4294967295, "op": "SCMP_CMP_EQ"}
      ]
    }
  ]
}
```

Apply this profile with containerd by placing it at `/etc/containerd/seccomp-default.json` and referencing it in the runtime configuration, or pass it to `docker run` via `--security-opt seccomp=/etc/docker/seccomp-custom.json`.

### Kubernetes seccomp via Pod Security

```yaml
# Pod-level seccomp via securityContext (Kubernetes 1.19+)
apiVersion: v1
kind: Pod
metadata:
  name: hardened-workload
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/production-api.json
  containers:
    - name: api
      image: registry.example.com/api:v2.1.0
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        capabilities:
          drop: ["ALL"]
          add: ["NET_BIND_SERVICE"]
```

The `localhostProfile` path is relative to the kubelet's `--seccomp-profile-root` directory (default: `/var/lib/kubelet/seccomp/`).

### Generating Profiles with strace

Use `strace` to capture syscalls during a representative workload run, then convert the trace to a seccomp allowlist:

```bash
# Trace a container workload for 60 seconds
strace -f -e trace=all -o /tmp/strace-output.txt \
  docker run --rm --name trace-target \
  registry.example.com/api:v2.1.0 /bin/app --mode benchmark

# Extract unique syscall names
grep -oP "(?<=^[^(]+\()\w+" /tmp/strace-output.txt 2>/dev/null | \
  sort -u | grep -v "^$" > /tmp/required-syscalls.txt

cat /tmp/required-syscalls.txt
# accept4
# arch_prctl
# brk
# close
# connect
# epoll_create1
# epoll_ctl
# epoll_wait
# execve
# exit_group
# fcntl
# fstat
# futex
# getdents64
# ...
```

### Audit Mode for Profile Development

Before enforcing seccomp, deploy in audit mode to identify any syscalls blocked by the profile that the application legitimately needs:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "syscalls": [
    {
      "names": ["accept4", "bind", "brk", "close", "connect"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

With `SCMP_ACT_LOG`, blocked syscalls are logged to the kernel audit log without causing the call to fail, allowing profile refinement before enforcement.

## AppArmor Policies

### Profile Structure

AppArmor profiles use a path-based access control model. Each profile defines a set of allowed filesystem paths, capabilities, and network operations.

```
# /etc/apparmor.d/container.production-api
#include <tunables/global>

profile production-api flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Deny all by default; explicit allow
  deny /** rwklx,

  # Binary and libraries
  /usr/local/bin/api rix,
  /lib/x86_64-linux-gnu/** mr,
  /usr/lib/x86_64-linux-gnu/** mr,

  # Configuration (read-only)
  /etc/ssl/certs/** r,
  /etc/resolv.conf r,
  /etc/hosts r,
  /etc/nsswitch.conf r,
  /etc/localtime r,

  # Application data directory (read-write)
  /var/lib/api/** rw,

  # Temporary files
  /tmp/ rw,
  /tmp/** rw,

  # Proc pseudo-filesystem (limited)
  /proc/sys/kernel/ngroups_max r,
  /proc/*/status r,
  /proc/*/fd/ r,
  @{PROC}/self/attr/current w,

  # Network
  network inet stream,
  network inet6 stream,
  network unix stream,

  # Capabilities
  capability net_bind_service,
  capability setuid,
  capability setgid,

  # Deny dangerous capabilities
  deny capability sys_admin,
  deny capability sys_ptrace,
  deny capability sys_module,
  deny capability mknod,

  # Mount operations denied
  deny mount,
  deny umount,

  # Signal handling (self only)
  signal (receive) peer=unconfined,
  signal (send) peer=production-api,
}
```

### Loading and Enforcing Profiles

```bash
# Parse and load a new profile
apparmor_parser -r -W /etc/apparmor.d/container.production-api

# Set profile to enforce mode
aa-enforce /etc/apparmor.d/container.production-api

# Verify loaded profiles
aa-status --json | python3 -m json.tool | grep -A5 '"enforced"'

# Check for denials in real time
journalctl -f _AUDIT_TYPE=1400 | grep apparmor

# Example denial log entry:
# audit[12345]: apparmor="DENIED" operation="file_perm"
# profile="production-api" name="/proc/sysrq-trigger"
# pid=12345 comm="api" requested_mask="w" denied_mask="w" fsuid=65534 ouid=0
```

### Applying AppArmor in Kubernetes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hardened-pod
  annotations:
    container.apparmor.security.beta.kubernetes.io/api: localhost/production-api
spec:
  containers:
    - name: api
      image: registry.example.com/api:v2.1.0
```

The annotation value `localhost/production-api` references a profile named `production-api` loaded on the node. Use a DaemonSet to distribute and load profiles across all nodes before pods are scheduled.

### Profile Synchronization DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: apparmor-loader
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: apparmor-loader
  template:
    metadata:
      labels:
        app: apparmor-loader
    spec:
      hostPID: true
      initContainers:
        - name: apparmor-loader
          image: registry.example.com/apparmor-loader:v1.2.0
          securityContext:
            privileged: true
          volumeMounts:
            - name: sys
              mountPath: /sys
              readOnly: true
            - name: apparmor-includes
              mountPath: /etc/apparmor.d
            - name: profiles
              mountPath: /profiles
          command:
            - /bin/sh
            - -c
            - |
              cp /profiles/*.profile /etc/apparmor.d/
              for f in /profiles/*.profile; do
                apparmor_parser -r -W "$f"
                echo "Loaded: $f"
              done
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
      volumes:
        - name: sys
          hostPath:
            path: /sys
        - name: apparmor-includes
          hostPath:
            path: /etc/apparmor.d
        - name: profiles
          configMap:
            name: apparmor-profiles
```

## auditd Configuration

### Rule Architecture

auditd rules follow a priority order: first-match wins for `--loginuid-immutable` and user-space filters; last-match wins for syscall rules. Place broad allow rules early and specific deny/alert rules toward the end.

```bash
# /etc/audit/rules.d/99-container-host.rules

# Increase buffer size and backlog limit for busy systems
-b 8192
--backlog_wait_time 60000

# Failures: log to syslog (2), panic on kernel OOPS (1)
-f 1

# Rate limit: maximum 200 records/second
-r 200

# Delete existing rules first (for reload)
-D

# ---- Immutable markers ----
# Prevent unloading audit rules until reboot (-e 2 makes rules immutable)
# Must be last rule if used; comment out during development
# -e 2

# ---- Privileged commands ----
-a always,exit -F path=/usr/bin/sudo -F perm=x -F auid>=1000 -F auid!=-1 -k privileged-sudo
-a always,exit -F path=/usr/bin/su -F perm=x -F auid>=1000 -F auid!=-1 -k privileged-su
-a always,exit -F path=/usr/sbin/useradd -F perm=x -F auid>=1000 -k privileged-useradd
-a always,exit -F path=/usr/sbin/usermod -F perm=x -F auid>=1000 -k privileged-usermod
-a always,exit -F path=/usr/sbin/userdel -F perm=x -F auid>=1000 -k privileged-userdel

# ---- Authentication and credentials ----
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/security/opasswd -p wa -k identity
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers

# ---- SSH configuration ----
-w /etc/ssh/sshd_config -p wa -k sshd-config
-w /etc/ssh/sshd_config.d/ -p wa -k sshd-config

# ---- Kernel and module loading ----
-w /sbin/insmod -p x -k modules
-w /sbin/rmmod -p x -k modules
-w /sbin/modprobe -p x -k modules
-a always,exit -F arch=b64 -S init_module,finit_module -k modules
-a always,exit -F arch=b64 -S delete_module -k modules

# ---- Container runtime ----
-w /usr/bin/docker -p x -k docker
-w /usr/bin/containerd -p x -k containerd
-w /usr/bin/kubectl -p x -k kubectl
-w /var/lib/docker/ -p wa -k docker-data
-w /etc/containerd/ -p wa -k containerd-config
-w /etc/kubernetes/ -p wa -k kubernetes-config

# ---- Namespace operations ----
-a always,exit -F arch=b64 -S unshare -k namespace-change
-a always,exit -F arch=b64 -S setns -k namespace-change
-a always,exit -F arch=b64 -S clone -F a0&0x10000000 -k namespace-change

# ---- Mount operations ----
-a always,exit -F arch=b64 -S mount -F auid>=1000 -k mount
-a always,exit -F arch=b64 -S umount2 -F auid>=1000 -k mount

# ---- Executable creation ----
-a always,exit -F arch=b64 -S execve -C uid!=euid -F euid=0 -k setuid-exec
-a always,exit -F arch=b64 -S execve -C gid!=egid -F egid=0 -k setgid-exec

# ---- Network configuration ----
-a always,exit -F arch=b64 -S sethostname,setdomainname -k network-config
-w /etc/hosts -p wa -k network-config
-w /etc/network/ -p wa -k network-config
-w /etc/NetworkManager/ -p wa -k network-config

# ---- Audit log protection ----
-w /var/log/audit/ -p wa -k audit-logs
-w /etc/audit/ -p wa -k audit-config
-w /etc/libaudit.conf -p wa -k audit-config
-w /etc/audisp/ -p wa -k audit-config
```

### auditd Dispatcher Configuration

Configure `audispd` to forward audit events to a remote log aggregator for SIEM ingestion:

```
# /etc/audit/plugins.d/syslog.conf
active = yes
direction = out
path = builtin_syslog
type = builtin
args = LOG_INFO
format = string
```

```
# /etc/audisp/audisp-remote.conf
remote_server = siem.example.com
port = 60
transport = tcp
mode = immediate
queue_depth = 10240
fail_action = suspend
network_failure_action = suspend
overflow_action = syslog
```

### Parsing auditd Events with ausearch

```bash
# Find all privilege escalation events in the last hour
ausearch -k privileged-sudo -ts recent -i

# Find all namespace creation events
ausearch -k namespace-change -ts today -i | aureport -i --summary

# Generate a summary report by key
aureport --key --summary

# Export events as CSV for SIEM ingestion
ausearch -k kubernetes-config -ts 2027-09-01 -te 2027-09-21 -i -l \
  | python3 /usr/local/bin/audit2csv.py > /tmp/k8s-audit-events.csv
```

## SELinux Configuration

### Container Policy Types

On RHEL/CentOS/Rocky Linux hosts, SELinux provides mandatory access control via type enforcement. The `container_t` type domain used by podman and CRI-O provides a well-tested baseline.

```bash
# Verify SELinux mode
getenforce
# Enforcing

# Check current policy
sestatus
# SELinux status: enabled
# SELinuxfs mount: /sys/fs/selinux
# SELinux mount point: /sys/fs/selinux
# Loaded policy name: targeted
# Current mode: enforcing
# Mode from config file: enforcing
# Policy MLS status: enabled
# Policy deny_unknown status: allowed
# Memory protection checking: actual (secure)
# Max kernel policy version: 33

# List container-related types
semanage fcontext -l | grep container_t

# Check denials (non-dontaudit)
ausearch -m avc -ts recent | audit2allow -a
```

### Custom SELinux Module for Kubernetes Workloads

```bash
# Step 1: Capture denials during development
# Run the workload in permissive mode for the target domain only
semanage permissive -a container_t

# Step 2: Capture denials
ausearch -m avc -c api 2>/dev/null | audit2allow -M production-api-module

# Step 3: Review the generated module
cat production-api-module.te
# module production-api-module 1.0;
# require {
#   type container_t;
#   type proc_t;
#   class file { read open };
# }
# allow container_t proc_t:file { read open };

# Step 4: Compile and install
semodule_package -o production-api-module.pp -m production-api-module.mod
semodule -i production-api-module.pp

# Step 5: Remove permissive exception
semanage permissive -d container_t
```

### File Context Management

```bash
# Apply correct context to persistent volume hostPath directories
semanage fcontext -a -t container_file_t "/var/lib/api(/.*)?"
restorecon -Rv /var/lib/api

# Verify context
ls -Z /var/lib/api/
# system_u:object_r:container_file_t:s0 data
# system_u:object_r:container_file_t:s0 config.yaml
```

## Kernel Module Hardening

### Module Blacklisting

```bash
# /etc/modprobe.d/blacklist-containers.conf

# Rarely needed by container workloads
blacklist dccp
blacklist sctp
blacklist rds
blacklist tipc
blacklist n-hdlc
blacklist ax25
blacklist netrom
blacklist x25
blacklist rose
blacklist decnet
blacklist econet
blacklist af_802154
blacklist ipx
blacklist appletalk
blacklist psnap
blacklist p8022
blacklist p8023

# Filesystem types containers should not need
blacklist cramfs
blacklist freevxfs
blacklist jffs2
blacklist hfs
blacklist hfsplus
blacklist squashfs
blacklist udf

# Prevent loading via install trap
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
install cramfs /bin/true
install freevxfs /bin/true
install jffs2 /bin/true
install hfs /bin/true
install hfsplus /bin/true
install udf /bin/true
```

### Kernel Lockdown Mode

```bash
# Enable lockdown at boot via kernel parameter
# Add to GRUB_CMDLINE_LINUX in /etc/default/grub:
# lockdown=confidentiality

# Verify lockdown is active
cat /sys/kernel/security/lockdown
# none [integrity] confidentiality

# lockdown=integrity: prevents runtime kernel modification
# lockdown=confidentiality: also prevents reading kernel memory

# Update grub
grub2-mkconfig -o /boot/grub2/grub.cfg
# or
update-grub
```

### Kernel Security Sysctl Parameters

```bash
# /etc/sysctl.d/99-security-hardening.conf

# Restrict dmesg access to CAP_SYSLOG
kernel.dmesg_restrict = 1

# Disable kernel pointer leaks to unprivileged processes
kernel.kptr_restrict = 2

# Prevent non-root processes from reading /proc/<pid>/ of other processes
kernel.yama.ptrace_scope = 2

# Disable perf events for non-root (can leak kernel addresses)
kernel.perf_event_paranoid = 3

# Disable SysRq keys in production
kernel.sysrq = 0

# Restrict core dumps
fs.suid_dumpable = 0
kernel.core_pattern = |/bin/false

# Enable ASLR (Address Space Layout Randomization) - full randomization
kernel.randomize_va_space = 2

# Protect hardlinks and symlinks from exploitation
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2

# Restrict unprivileged BPF (prevents eBPF exploitation by containers)
kernel.unprivileged_bpf_disabled = 1

# Disable user namespaces (trade-off: breaks rootless containers)
# Evaluate based on workload requirements
# kernel.unprivileged_userns_clone = 0

# Network security
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_ra = 0
net.ipv6.conf.default.accept_ra = 0
```

Apply sysctl changes:

```bash
sysctl --system
# or for a single file:
sysctl -p /etc/sysctl.d/99-security-hardening.conf
```

## USBGuard Configuration

USBGuard enforces USB device authorization policies using a kernel IPC interface, providing a defense against BadUSB attacks on physical hosts.

### Installation and Initial Policy

```bash
# Install USBGuard
dnf install usbguard usbguard-tools    # RHEL/Rocky
apt install usbguard usbguard-tools    # Debian/Ubuntu

# Generate initial policy from currently connected devices (allow-all mode)
# Run BEFORE enabling enforcement to capture legitimate devices
usbguard generate-policy > /etc/usbguard/rules.conf

# Example generated rules.conf entry:
# allow id 8087:0026 serial "" name "Integrated..." hash "..." parent-hash "..." with-interface { 09:00:00 }

# Enable and start the daemon
systemctl enable --now usbguard

# Check current policy
usbguard list-rules
usbguard list-devices
```

### Custom Policy Rules

```
# /etc/usbguard/rules.conf

# Allow known keyboard (Logitech K380)
allow id 046d:b342 name "K380" via-port "1-1.2" label "keyboard-k380"

# Allow known YubiKey 5C
allow id 1050:0407 name "YubiKey OTP+FIDO+CCID" hash "YUBKEY_HASH_PLACEHOLDER" label "yubikey-5c"

# Allow USB hubs (needed for keyboard/mouse chains)
allow with-interface 09:00:00

# Block all HID devices except explicitly approved (prevents USB rubber duckies)
reject with-interface 03:*:*

# Block mass storage by default (use explicit rules for approved drives)
reject with-interface { 08:06:50 }

# Reject everything else (implicit deny is the default, but explicit is clearer)
reject with-interface any
```

### USBGuard IPC Permissions

```
# /etc/usbguard/usbguard-daemon.conf
RuleFile=/etc/usbguard/rules.conf
IPCAllowedUsers=root usbguard
IPCAllowedGroups=wheel
# Audit log via syslog
AuditFilePath=syslog
```

## Validation and Compliance Scanning

### CIS Benchmark with kube-bench

```bash
# Run kube-bench on a Kubernetes node
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job.yaml

# Wait for completion
kubectl wait --for=condition=complete job/kube-bench --timeout=120s

# Retrieve results
kubectl logs job/kube-bench | tee /tmp/kube-bench-results.txt

# Parse and count findings
grep -E "^\[FAIL\]" /tmp/kube-bench-results.txt | wc -l
grep -E "^\[WARN\]" /tmp/kube-bench-results.txt | wc -l
grep -E "^\[PASS\]" /tmp/kube-bench-results.txt | wc -l
```

### Lynis Host Security Audit

```bash
# Run Lynis in non-interactive audit mode
lynis audit system --no-colors --quiet --log-file /tmp/lynis.log 2>&1

# Extract hardening index
grep "Hardening index" /tmp/lynis.log
# Hardening index : 74 [##############      ]

# List warnings and suggestions
grep -E "^\[WARNING\]|\[SUGGESTION\]" /tmp/lynis.log | head -30
```

### Prometheus Alerts for Security Events

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: container-host-security
  namespace: monitoring
spec:
  groups:
    - name: security.container-host
      interval: 30s
      rules:
        - alert: SeccompProfileMissing
          expr: |
            kube_pod_container_info{container!=""}
            unless on(pod, namespace, container) kube_pod_container_status_running
          labels:
            severity: warning
            team: security
          annotations:
            summary: "Pod {{ $labels.pod }} container {{ $labels.container }} may lack seccomp profile"

        - alert: PrivilegedContainerRunning
          expr: kube_pod_container_status_running{container!=""} == 1 and on(pod, namespace, container) kube_pod_container_info
          labels:
            severity: critical
            team: security
          annotations:
            summary: "Privileged container detected in namespace {{ $labels.namespace }}"

        - alert: AuditdServiceDown
          expr: up{job="node-exporter"} == 1 unless on(instance) node_service_state{name="auditd", state="running"} == 1
          for: 2m
          labels:
            severity: critical
            team: security
          annotations:
            summary: "auditd service is not running on {{ $labels.instance }}"
```

## Incident Response Integration

### Security Event Forwarding to Falco

Combine auditd with Falco runtime security for comprehensive container threat detection:

```yaml
# /etc/falco/falco_rules.local.yaml
- rule: Privileged Container Launch Detected
  desc: Alert when a new privileged container is launched
  condition: >
    container and container.privileged = true
    and not container.image.repository in (trusted_images)
  output: >
    Privileged container launched (user=%user.name
    image=%container.image.repository:%container.image.tag
    container=%container.name pid=%proc.pid)
  priority: CRITICAL
  tags: [container, cis, mitre_privilege_escalation]

- rule: Seccomp Profile Missing
  desc: Container started without a seccomp profile
  condition: >
    container.start and container.seccomp_profile = ""
    and not container.image.repository in (exempt_images)
  output: >
    Container started without seccomp profile
    (image=%container.image.repository container=%container.name)
  priority: WARNING
  tags: [container, cis]

- rule: Kernel Module Load Detected
  desc: Alert on kernel module loading from container context
  condition: >
    syscall.type = init_module or syscall.type = finit_module
  output: >
    Kernel module load detected
    (user=%user.name command=%proc.cmdline container=%container.name)
  priority: CRITICAL
  tags: [kernel, container, mitre_defense_evasion]
```

## Production Rollout Strategy

### Phase 1: Audit Mode (Week 1-2)

Deploy all controls in audit/log mode. Collect baseline violation data:

```bash
# AppArmor: complain mode
aa-complain /etc/apparmor.d/container.production-api

# auditd: logging only, no enforcement changes
# seccomp: SCMP_ACT_LOG instead of SCMP_ACT_ERRNO
# SELinux: permissive mode for target domains
semanage permissive -a container_t
```

### Phase 2: Enforce on Non-Production (Week 3-4)

Apply enforcement on development and staging clusters. Tune profiles based on application behavior:

```bash
# AppArmor: switch to enforce
aa-enforce /etc/apparmor.d/container.production-api

# seccomp: change defaultAction to SCMP_ACT_ERRNO
# SELinux: remove permissive exception
semanage permissive -d container_t
```

### Phase 3: Production Rollout (Week 5-6)

Rolling node-by-node enforcement with monitoring dashboards active. Maintain rollback playbook:

```bash
# Emergency rollback: switch AppArmor to complain
aa-complain /etc/apparmor.d/container.production-api

# Emergency rollback: seccomp — update pod annotation to use relaxed profile
kubectl annotate pod --all -n production \
  container.seccomp.security.alpha.kubernetes.io/api=unconfined \
  --overwrite

# Reload auditd without enforcement changes
systemctl reload auditd
```

### Validation Checklist

```bash
# Verify seccomp profile is applied
crictl inspect <container-id> | jq '.info.runtimeSpec.linux.seccomp.defaultAction'
# "SCMP_ACT_ERRNO"

# Verify AppArmor profile is enforcing
cat /proc/<pid>/attr/current
# production-api (enforce)

# Verify auditd is running and capturing events
systemctl is-active auditd
auditctl -l | wc -l

# Verify kernel sysctl values
sysctl kernel.dmesg_restrict kernel.kptr_restrict \
       kernel.yama.ptrace_scope kernel.unprivileged_bpf_disabled \
       fs.protected_hardlinks fs.protected_symlinks

# Run quick CIS check
lynis audit system --tests-from-group kernel --tests-from-group filesystem \
  --no-colors --quiet 2>&1 | grep -E "PASS|WARN|FAIL"
```
