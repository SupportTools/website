---
title: "Kubernetes Pod Security: Seccomp, AppArmor, and SELinux Profiles"
date: 2031-02-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Seccomp", "AppArmor", "SELinux", "Pod Security", "CIS", "Linux"]
categories:
- Kubernetes
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes Pod security: creating seccomp profiles, writing AppArmor profiles, SELinux MCS label assignment, RuntimeDefault vs custom profiles, audit mode testing, and CIS benchmark compliance for production workloads."
more_link: "yes"
url: "/kubernetes-pod-security-seccomp-apparmor-selinux-profiles/"
---

Linux Security Modules (LSMs) — seccomp, AppArmor, and SELinux — form a defense-in-depth layer below the container runtime. While namespaces and cgroups provide isolation, LSMs restrict what system calls and resources a container process can access even if the container escapes its namespace. This guide covers the practical implementation of all three mechanisms in production Kubernetes environments, from profile creation and testing in audit mode to CIS benchmark compliance verification.

<!--more-->

# Kubernetes Pod Security: Seccomp, AppArmor, and SELinux Profiles

## Section 1: The Linux Security Module Landscape

The three LSM technologies serve different but complementary purposes:

| LSM | What It Restricts | Scope |
|---|---|---|
| **seccomp** | System calls (syscalls) | Process |
| **AppArmor** | File/network/capability access by path | Process |
| **SELinux** | Mandatory Access Control via labels | System-wide |

A container runtime breach that bypasses namespace isolation can still be blocked by:
- seccomp: if the exploit requires a blocked syscall
- AppArmor: if it needs to write to a restricted path
- SELinux: if the resulting process type doesn't have the needed permissions

## Section 2: Seccomp Profiles

Seccomp (Secure Computing Mode) filters system calls using BPF programs. It is the most portable and universally supported LSM.

### The Default RuntimeDefault Profile

Kubernetes 1.25+ enforces `RuntimeDefault` seccomp by default when using the Restricted Pod Security Standard. The RuntimeDefault profile blocks ~40 dangerous syscalls while allowing all syscalls needed by typical web services:

```yaml
# Pod with RuntimeDefault seccomp (explicit declaration)
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      image: myapp:latest
      securityContext:
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        runAsUser: 1000
        capabilities:
          drop: ["ALL"]
```

### Creating Custom Seccomp Profiles

Custom profiles give fine-grained control over which syscalls to allow:

```json
// /var/lib/kubelet/seccomp/profiles/myapp-secure.json
{
  "defaultAction": "SCMP_ACT_ERRNO",
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
        "accept", "accept4", "access", "arch_prctl",
        "bind", "brk", "capget", "capset",
        "chdir", "chmod", "chown", "clock_getres",
        "clock_gettime", "clock_nanosleep", "close",
        "connect", "copy_file_range", "dup", "dup2", "dup3",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait",
        "epoll_wait", "eventfd", "eventfd2", "execve", "execveat",
        "exit", "exit_group", "faccessat", "fadvise64",
        "fallocate", "fchdir", "fchmod", "fchmodat",
        "fchown", "fchownat", "fcntl", "fdatasync",
        "fgetxattr", "flistxattr", "flock", "fork",
        "fremovexattr", "fsetxattr", "fstat", "fstatfs",
        "fsync", "ftruncate", "futex", "getcwd",
        "getdents", "getdents64", "getegid", "geteuid",
        "getgid", "getgroups", "getpeername", "getpgid",
        "getpgrp", "getpid", "getppid", "getpriority",
        "getrandom", "getrlimit", "getrusage", "getsid",
        "getsockname", "getsockopt", "gettid", "gettimeofday",
        "getuid", "getxattr", "inotify_add_watch", "inotify_init",
        "inotify_init1", "inotify_rm_watch", "ioctl",
        "ioprio_get", "ioprio_set", "kill", "lchown",
        "lgetxattr", "link", "linkat", "listen",
        "listxattr", "llistxattr", "lremovexattr", "lseek",
        "lsetxattr", "lstat", "madvise", "memfd_create",
        "mincore", "mkdir", "mkdirat", "mlock",
        "mlock2", "mlockall", "mmap", "mprotect",
        "mq_getsetattr", "mq_notify", "mq_open", "mq_timedreceive",
        "mq_timedsend", "mq_unlink", "mremap", "msgctl",
        "msgget", "msgrcv", "msgsnd", "msync",
        "munlock", "munlockall", "munmap", "nanosleep",
        "newfstatat", "open", "openat", "openat2",
        "pause", "pidfd_open", "pipe", "pipe2",
        "poll", "ppoll", "prctl", "pread64",
        "preadv", "preadv2", "prlimit64", "pselect6",
        "pwrite64", "pwritev", "pwritev2", "read",
        "readahead", "readlink", "readlinkat", "readv",
        "recv", "recvfrom", "recvmmsg", "recvmsg",
        "rename", "renameat", "renameat2", "restart_syscall",
        "rmdir", "rt_sigaction", "rt_sigpending",
        "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn",
        "rt_sigsuspend", "rt_sigtimedwait", "rt_tgsigqueueinfo",
        "sched_getaffinity", "sched_getattr", "sched_getparam",
        "sched_get_priority_max", "sched_get_priority_min",
        "sched_getscheduler", "sched_setaffinity", "sched_setattr",
        "sched_setparam", "sched_setscheduler", "sched_yield",
        "seccomp", "select", "semctl", "semget",
        "semop", "semtimedop", "send", "sendfile",
        "sendmmsg", "sendmsg", "sendto", "set_robust_list",
        "set_tid_address", "setfsgid", "setfsuid", "setgid",
        "setgroups", "setitimer", "setpgid", "setpriority",
        "setrlimit", "setsid", "setsockopt", "setuid",
        "setxattr", "shmat", "shmctl", "shmdt",
        "shmget", "shutdown", "sigaltstack", "signalfd",
        "signalfd4", "sigreturn", "socket", "socketpair",
        "splice", "stat", "statfs", "statx",
        "symlink", "symlinkat", "sync", "sync_file_range",
        "syncfs", "sysinfo", "tgkill", "time",
        "timer_create", "timer_delete", "timer_getoverrun",
        "timer_gettime", "timer_settime", "timerfd_create",
        "timerfd_gettime", "timerfd_settime", "times", "tkill",
        "truncate", "ugetrlimit", "umask", "uname",
        "unlink", "unlinkat", "utime", "utimensat",
        "utimes", "vfork", "vmsplice", "wait4",
        "waitid", "waitpid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["personality"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {"index": 0, "value": 0, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 8, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 131072, "op": "SCMP_CMP_EQ"}
      ]
    }
  ]
}
```

### Generating Profiles with strace

The practical approach to building a custom profile is to observe what syscalls your application actually uses:

```bash
# Run your application under strace to capture syscalls
strace -f -o /tmp/app-syscalls.txt -e trace=all \
  ./myapp --config /etc/myapp/config.yaml &

# Generate load against the application
hey -n 10000 -c 50 http://localhost:8080/api/health

# Extract the unique syscall names
grep -oP "(?<=\[pid \d{1,6}\] )\w+" /tmp/app-syscalls.txt | \
  sort -u > /tmp/needed-syscalls.txt

# Or use oci-seccomp-bpf-hook to generate profiles automatically
# (requires runc with BPF support)
docker run --security-opt seccomp=unconfined \
  --annotation io.containers.trace-syscall=of:/tmp/generated-profile.json \
  myapp:latest
```

### Distributing Profiles via NodeFeatureDiscovery and DaemonSet

Custom seccomp profiles must be present on every node before pods request them. Use a DaemonSet:

```yaml
# daemonset-seccomp-profiles.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: seccomp-profile-installer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: seccomp-profile-installer
  template:
    metadata:
      labels:
        app: seccomp-profile-installer
    spec:
      initContainers:
        - name: install
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              mkdir -p /host/profiles
              cp /profiles/*.json /host/profiles/
              echo "Profiles installed:"
              ls /host/profiles/
          volumeMounts:
            - name: profiles-dir
              mountPath: /host/profiles
            - name: profiles-cm
              mountPath: /profiles
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
      volumes:
        - name: profiles-dir
          hostPath:
            path: /var/lib/kubelet/seccomp/profiles
            type: DirectoryOrCreate
        - name: profiles-cm
          configMap:
            name: seccomp-profiles
      hostPID: true
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: seccomp-profiles
  namespace: kube-system
data:
  myapp-secure.json: |
    {
      "defaultAction": "SCMP_ACT_ERRNO",
      ...
    }
```

### Using the Security Profiles Operator

The [Security Profiles Operator](https://github.com/kubernetes-sigs/security-profiles-operator) provides a Kubernetes-native way to manage seccomp and AppArmor profiles:

```bash
# Install SPO
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Wait for deployment
kubectl wait --for=condition=Ready pods --all \
  -n security-profiles-operator --timeout=120s
```

```yaml
# SeccompProfile CRD from the Security Profiles Operator
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: myapp-profile
  namespace: production
spec:
  defaultAction: SCMP_ACT_ERRNO
  architectures:
    - SCMP_ARCH_X86_64
    - SCMP_ARCH_AARCH64
  syscalls:
    - action: SCMP_ACT_ALLOW
      names:
        - read
        - write
        - open
        - openat
        - close
        - stat
        - fstat
        - lstat
        - poll
        - lseek
        - mmap
        - mprotect
        - munmap
        - brk
        - rt_sigaction
        - rt_sigprocmask
        - rt_sigreturn
        - ioctl
        - pread64
        - pwrite64
        - access
        - pipe
        - select
        - sched_yield
        - mremap
        - msync
        - mincore
        - madvise
        - socket
        - connect
        - accept
        - sendto
        - recvfrom
        - sendmsg
        - recvmsg
        - bind
        - listen
        - getsockname
        - getpeername
        - socketpair
        - setsockopt
        - getsockopt
        - clone
        - fork
        - vfork
        - execve
        - exit
        - wait4
        - kill
        - uname
        - getpid
        - getuid
        - getgid
        - geteuid
        - getegid
        - getppid
        - nanosleep
        - getitimer
        - setitimer
        - alarm
        - gettimeofday
        - settimeofday
        - getgroups
        - setgroups
        - fcntl
        - flock
        - fsync
        - fdatasync
        - truncate
        - ftruncate
        - getdents
        - getcwd
        - chdir
        - fchdir
        - rename
        - mkdir
        - rmdir
        - link
        - unlink
        - symlink
        - readlink
        - chmod
        - fchmod
        - chown
        - fchown
        - lchown
        - umask
        - getrlimit
        - setrlimit
        - prlimit64
        - getrusage
        - sysinfo
        - times
        - ptrace
        - getpgrp
        - setsid
        - setpgid
        - getpgid
        - getpid
        - gettid
        - sched_getparam
        - sched_setparam
        - sched_getscheduler
        - sched_setscheduler
        - sched_get_priority_max
        - sched_get_priority_min
        - sched_rr_get_interval
        - mlock
        - munlock
        - mlockall
        - munlockall
        - vhangup
        - modify_ldt
        - pivot_root
        - sysctl
        - prctl
        - arch_prctl
        - adjtimex
        - setrlimit
        - chroot
        - sync
        - acct
        - settimeofday
        - mount
        - umount2
        - swapon
        - swapoff
        - reboot
        - sethostname
        - setdomainname
        - iopl
        - ioperm
        - create_module
        - init_module
        - delete_module
        - get_kernel_syms
        - query_module
        - quotactl
        - nfsservctl
        - getpmsg
        - putpmsg
        - afs_syscall
        - tuxcall
        - security
        - gettid
        - readahead
        - setxattr
        - lsetxattr
        - fsetxattr
        - getxattr
        - lgetxattr
        - fgetxattr
        - listxattr
        - llistxattr
        - flistxattr
        - removexattr
        - lremovexattr
        - fremovexattr
        - tkill
        - time
        - futex
        - sched_setaffinity
        - sched_getaffinity
        - io_setup
        - io_destroy
        - io_getevents
        - io_submit
        - io_cancel
        - get_thread_area
        - lookup_dcookie
        - epoll_create
        - epoll_ctl_old
        - epoll_wait_old
        - remap_file_pages
        - getdents64
        - set_tid_address
        - restart_syscall
        - semtimedop
        - fadvise64
        - timer_create
        - timer_settime
        - timer_gettime
        - timer_getoverrun
        - timer_delete
        - clock_settime
        - clock_gettime
        - clock_getres
        - clock_nanosleep
        - exit_group
        - epoll_wait
        - epoll_ctl
        - tgkill
        - utimes
        - vserver
        - mbind
        - set_mempolicy
        - get_mempolicy
        - mq_open
        - mq_unlink
        - mq_timedsend
        - mq_timedreceive
        - mq_notify
        - mq_getsetattr
        - kexec_load
        - waitid
        - add_key
        - request_key
        - keyctl
        - ioprio_set
        - ioprio_get
        - inotify_init
        - inotify_add_watch
        - inotify_rm_watch
        - migrate_pages
        - openat
        - mkdirat
        - mknodat
        - fchownat
        - futimesat
        - newfstatat
        - unlinkat
        - renameat
        - linkat
        - symlinkat
        - readlinkat
        - fchmodat
        - faccessat
        - pselect6
        - ppoll
        - unshare
        - set_robust_list
        - get_robust_list
        - splice
        - tee
        - sync_file_range
        - vmsplice
        - move_pages
        - utimensat
        - epoll_pwait
        - signalfd
        - timerfd_create
        - eventfd
        - fallocate
        - timerfd_settime
        - timerfd_gettime
        - accept4
        - signalfd4
        - eventfd2
        - epoll_create1
        - dup3
        - pipe2
        - inotify_init1
        - preadv
        - pwritev
        - rt_tgsigqueueinfo
        - perf_event_open
        - recvmmsg
        - fanotify_init
        - fanotify_mark
        - prlimit64
        - name_to_handle_at
        - open_by_handle_at
        - clock_adjtime
        - syncfs
        - sendmmsg
        - setns
        - getcpu
        - process_vm_readv
        - process_vm_writev
        - kcmp
        - finit_module
        - sched_setattr
        - sched_getattr
        - renameat2
        - seccomp
        - getrandom
        - memfd_create
        - kexec_file_load
        - bpf
        - execveat
        - userfaultfd
        - membarrier
        - mlock2
        - copy_file_range
        - preadv2
        - pwritev2
        - pkey_mprotect
        - pkey_alloc
        - pkey_free
        - statx
        - io_pgetevents
        - rseq
        - pidfd_send_signal
        - io_uring_setup
        - io_uring_enter
        - io_uring_register
        - open_tree
        - move_mount
        - fsopen
        - fsconfig
        - fsmount
        - fspick
        - pidfd_open
        - clone3
        - close_range
        - openat2
        - pidfd_getfd
        - faccessat2
        - process_madvise
        - epoll_pwait2
        - mount_setattr
        - landlock_create_ruleset
        - landlock_add_rule
        - landlock_restrict_self
```

### Using the Profile in a Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-with-custom-seccomp
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/myapp-secure.json
  containers:
    - name: app
      image: myapp:latest
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
```

## Section 3: AppArmor Profiles

AppArmor restricts what files, capabilities, and network operations a process can perform. It is path-based (unlike SELinux's label-based approach) and ships with Ubuntu, Debian, and SUSE.

### Checking AppArmor Status

```bash
# Verify AppArmor is active
aa-status
# apparmor module is loaded.
# 47 profiles are loaded.
# 42 profiles are in enforce mode.
# 5 profiles are in complain mode.

# Check if AppArmor is compiled into the kernel
cat /sys/module/apparmor/parameters/enabled
# Y

# Install tools
apt install apparmor-utils apparmor-profiles apparmor-profiles-extra
```

### Writing an AppArmor Profile

```
# /etc/apparmor.d/containers.myapp
# AppArmor profile for the myapp container

#include <tunables/global>

profile myapp flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Deny all capabilities by default
  deny capability,

  # Allow capabilities needed by the application
  capability net_bind_service,   # Bind to port <1024 if needed
  capability dac_override,       # Read files regardless of owner
  capability setuid,             # Drop privileges at startup
  capability setgid,

  # Network access
  network inet stream,           # TCP IPv4
  network inet6 stream,          # TCP IPv6
  network inet dgram,            # UDP IPv4
  network inet6 dgram,           # UDP IPv6
  deny network raw,              # No raw sockets
  deny network packet,           # No packet sockets

  # Allow standard system paths (read-only)
  /usr/lib{,32,64}/**  mr,
  /lib{,32,64}/**      mr,
  /usr/bin/**          mr,
  /bin/**              mr,
  /etc/ld.so.cache     r,
  /etc/ld.so.conf      r,
  /etc/ld.so.conf.d/** r,
  /proc/sys/kernel/ngroups_max r,

  # Application-specific paths
  /app/**                      r,
  /app/myapp                   rix,   # r=read, ix=inherit and execute

  # Configuration
  /etc/myapp/**                r,

  # Data directory (writable)
  /data/myapp/**               rw,

  # Temp files
  /tmp/myapp-*                 rw,

  # Logging
  /var/log/myapp/**            rw,

  # Linux proc filesystem (minimal)
  /proc/@{pid}/status          r,
  /proc/@{pid}/maps            r,
  /proc/sys/net/core/somaxconn r,

  # Deny access to sensitive system paths
  deny /etc/passwd    rw,
  deny /etc/shadow    rw,
  deny /etc/sudoers** rw,
  deny /root/**       rw,
  deny /proc/sysrq-trigger rw,
  deny /sys/**             rw,

  # Allow ptrace by same profile only (needed for Go runtime)
  ptrace (read,trace) peer=myapp,
}
```

### Loading and Managing AppArmor Profiles

```bash
# Parse and load a profile
apparmor_parser -r /etc/apparmor.d/containers.myapp

# Set profile to complain mode (audit only — no enforcement)
aa-complain /etc/apparmor.d/containers.myapp

# Set profile to enforce mode
aa-enforce /etc/apparmor.d/containers.myapp

# Check status
aa-status | grep myapp

# Read audit logs for AppArmor denials
journalctl -k | grep apparmor | grep DENIED

# Use audit2allow-equivalent for AppArmor
aa-logprof /var/log/syslog  # Interactive — suggests rules for observed denials

# Verify a profile is active
cat /proc/$(pgrep myapp)/attr/current
```

### Using AppArmor Profiles in Kubernetes

```yaml
# Pod with AppArmor profile
apiVersion: v1
kind: Pod
metadata:
  name: apparmor-restricted-pod
  annotations:
    # Annotation-based approach (Kubernetes < 1.30)
    container.apparmor.security.beta.kubernetes.io/app: localhost/myapp
spec:
  containers:
    - name: app
      image: myapp:latest
      securityContext:
        # Field-based approach (Kubernetes 1.30+)
        appArmorProfile:
          type: Localhost
          localhostProfile: myapp
```

```yaml
# Using RuntimeDefault AppArmor (managed by the container runtime)
spec:
  containers:
    - name: app
      securityContext:
        appArmorProfile:
          type: RuntimeDefault
```

### Distributing AppArmor Profiles via DaemonSet

```yaml
# daemonset-apparmor-installer.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: apparmor-profile-installer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: apparmor-profile-installer
  template:
    metadata:
      labels:
        app: apparmor-profile-installer
    spec:
      initContainers:
        - name: install
          image: ubuntu:22.04
          command:
            - bash
            - -c
            - |
              apt-get update -qq && apt-get install -y apparmor-utils -qq
              cp /profiles/* /host/apparmor.d/
              for profile in /profiles/*.apparmor; do
                apparmor_parser -r "$profile" && echo "Loaded: $profile"
              done
          securityContext:
            privileged: true
          volumeMounts:
            - name: apparmor-dir
              mountPath: /host/apparmor.d
            - name: profiles-cm
              mountPath: /profiles
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
      volumes:
        - name: apparmor-dir
          hostPath:
            path: /etc/apparmor.d
            type: Directory
        - name: profiles-cm
          configMap:
            name: apparmor-profiles
      tolerations:
        - operator: Exists
```

## Section 4: SELinux in Kubernetes

SELinux uses mandatory access control labels (contexts) to restrict what processes can access. It's the default LSM on RHEL/CentOS/Rocky Linux.

### SELinux Context Structure

```
user:role:type:level
  │     │    │     └── MCS/MLS level (s0:c1,c2 for containers)
  │     │    └── Type (the primary enforcement label)
  │     └── Role (for role-based access control)
  └── User (SELinux user mapping)
```

### Checking Container SELinux Labels

```bash
# Verify SELinux is enforcing
getenforce
# Enforcing

# Check the SELinux context of a running container process
ps -eZ | grep myapp
# system_u:system_r:container_t:s0:c123,c456  12345  ...  myapp

# Check labels on container filesystem mounts
ls -lZ /var/lib/docker/overlay2/
```

### Assigning MCS Labels to Pods

Multi-Category Security (MCS) labels provide isolation between containers. Each container gets a unique pair of categories (c0-c1023):

```yaml
# Pod with custom SELinux options
apiVersion: v1
kind: Pod
metadata:
  name: selinux-pod
spec:
  securityContext:
    seLinuxOptions:
      level: "s0:c123,c456"    # MCS categories (must be unique per pod)
      type: "container_t"       # Standard container type
  containers:
    - name: app
      image: myapp:latest
      securityContext:
        seLinuxOptions:
          level: "s0:c123,c456"  # Must match pod-level for consistency
```

### Custom SELinux Policy Modules

For containers that require access beyond what `container_t` allows:

```bash
# Check what's being denied (requires audit daemon)
ausearch -m avc -ts recent | head -50

# Example denial:
# type=AVC msg=audit(1234567890.123:456): avc:  denied  { read } for
#   pid=12345 comm="myapp" name="hardware_stats"
#   scontext=system_u:system_r:container_t:s0:c100,c200
#   tcontext=system_u:object_r:sysfs_t:s0
#   tclass=file permissive=0

# Generate a policy module from audit denials
ausearch -m avc -ts recent | audit2allow -M myapp_policy

# Review the generated policy
cat myapp_policy.te

# Install the policy module
semodule -i myapp_policy.pp

# Verify installation
semodule -l | grep myapp_policy
```

### Custom SELinux Type for an Application

```
# myapp.te — custom SELinux policy module
policy_module(myapp, 1.0.0)

require {
    type container_t;
    type sysfs_t;
    type proc_t;
}

# Allow myapp containers to read specific sysfs files
allow container_t sysfs_t:file { read open getattr };

# Allow reading /proc/meminfo
allow container_t proc_t:file { read open getattr };
```

```bash
# Compile and install
make -f /usr/share/selinux/devel/Makefile myapp.pp
semodule -i myapp.pp
```

## Section 5: Audit Mode Testing

Before enforcing any LSM profile in production, test in audit mode to identify false positives.

### seccomp Audit Mode

```json
// audit-profile.json — log instead of block
{
  "defaultAction": "SCMP_ACT_LOG",
  "syscalls": [
    {
      "names": ["ptrace", "process_vm_readv", "process_vm_writev"],
      "action": "SCMP_ACT_ERRNO"
    }
  ]
}
```

```bash
# Check audit logs for seccomp denials
journalctl -k | grep "seccomp"
# Jun 15 10:23:45 node-01 kernel: audit: type=1326 audit(1234567890.123:456):
# auid=4294967295 uid=1000 gid=1000 ses=4294967295
# pid=12345 comm="myapp" exe="/app/myapp"
# sig=0 arch=c000003e syscall=62 compat=0 ip=0x7f1234567890 code=0x7ffc0000
```

### AppArmor Complain Mode Testing

```bash
# Set profile to complain mode
aa-complain /etc/apparmor.d/containers.myapp

# Run the application and exercise all code paths
# Then review the audit log
aa-logprof /var/log/syslog

# The tool interactively suggests rules:
# Adding allow rule: /data/cache/** rw,  (y/n)?

# Update the profile with suggested rules
aa-enforce /etc/apparmor.d/containers.myapp
```

### Automated Profile Testing Script

```bash
#!/bin/bash
# test-security-profiles.sh — run a workload under each profile and compare behavior

set -euo pipefail

APP_IMAGE="myapp:latest"
TEST_ENDPOINT="http://localhost:8080/api/health"
NAMESPACE="security-test"

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

test_profile() {
    local profile_type=$1
    local profile_name=$2
    local pod_name="test-${profile_type}-$(date +%s)"

    echo "Testing: ${profile_type}=${profile_name}"

    cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${pod_name}
  namespace: ${NAMESPACE}
spec:
  securityContext:
    seccompProfile:
      type: ${profile_type}
      $([ "$profile_type" == "Localhost" ] && echo "localhostProfile: profiles/${profile_name}")
  containers:
    - name: app
      image: ${APP_IMAGE}
      ports:
        - containerPort: 8080
      readinessProbe:
        httpGet:
          path: /api/health
          port: 8080
        initialDelaySeconds: 5
        periodSeconds: 3
        failureThreshold: 10
EOF

    # Wait for pod to be ready
    kubectl wait pod "$pod_name" -n "$NAMESPACE" \
      --for=condition=Ready --timeout=60s || {
        echo "FAIL: Pod ${pod_name} never became ready"
        kubectl describe pod "$pod_name" -n "$NAMESPACE"
        return 1
    }

    echo "PASS: ${pod_name} is running under ${profile_type}/${profile_name}"
    kubectl delete pod "$pod_name" -n "$NAMESPACE" --grace-period=0
}

# Test RuntimeDefault
test_profile "RuntimeDefault" ""

# Test custom profile
test_profile "Localhost" "myapp-secure.json"

echo "All profile tests completed"
```

## Section 6: CIS Benchmark Compliance

The CIS Kubernetes Benchmark includes specific requirements for LSM profiles. Key checks:

### CIS Benchmark 5.7.2 — seccomp Profile Applied

```bash
# Check: Pods should have seccomp profile defined
# CIS requires: RuntimeDefault or custom profile

# Audit all pods for seccomp compliance
kubectl get pods --all-namespaces -o json | jq -r '
  .items[] |
  {
    ns: .metadata.namespace,
    name: .metadata.name,
    seccomp: (
      .spec.securityContext.seccompProfile.type //
      "NOT SET"
    )
  } |
  select(.seccomp == "NOT SET") |
  "\(.ns)/\(.name): seccomp NOT SET"
'
```

### CIS Benchmark 5.7.3 — AppArmor Profile Applied

```bash
# Check: Pods should have AppArmor profile annotation
kubectl get pods --all-namespaces -o json | jq -r '
  .items[] |
  {
    ns: .metadata.namespace,
    name: .metadata.name,
    apparmor: (
      [.metadata.annotations // {} |
       to_entries[] |
       select(.key | startswith("container.apparmor.security.beta.kubernetes.io/"))
      ] | length
    )
  } |
  select(.apparmor == 0) |
  "\(.ns)/\(.name): no AppArmor annotation"
'
```

### Gatekeeper Policy to Enforce seccomp

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sseccompprofile
spec:
  crd:
    spec:
      names:
        kind: K8sSeccompProfile
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
        package k8sseccompprofile

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          not has_seccomp_profile(container, input.review.object)
          msg := sprintf("Container %v must have a seccomp profile", [container.name])
        }

        has_seccomp_profile(container, pod) {
          # Check container-level
          profile := container.securityContext.seccompProfile.type
          profile_allowed(profile)
        }

        has_seccomp_profile(container, pod) {
          # Check pod-level
          profile := pod.spec.securityContext.seccompProfile.type
          profile_allowed(profile)
        }

        profile_allowed(profile) {
          allowed := input.parameters.allowedProfiles
          profile == allowed[_]
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sSeccompProfile
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
      - gatekeeper-system
  parameters:
    allowedProfiles:
      - RuntimeDefault
      - Localhost
```

## Section 7: Pod Security Standards Integration

Kubernetes Pod Security Standards (PSS) enforce seccomp as part of the Restricted level:

```yaml
# Enable Restricted PSS for a namespace
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Warn in audit log for violations
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest

    # Warn developers via kubectl warnings
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest

    # Enforce — reject non-compliant pods
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
```

### A Fully Compliant Pod Template

```yaml
# Compliant with CIS Benchmark and Restricted PSS
apiVersion: v1
kind: Pod
metadata:
  name: fully-hardened-pod
  namespace: production
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
    supplementalGroups: [1000]
    sysctls: []    # No unsafe sysctls

  automountServiceAccountToken: false

  containers:
    - name: app
      image: myapp:latest@sha256:abc123...   # Pinned digest
      ports:
        - containerPort: 8080
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 1000
        capabilities:
          drop: ["ALL"]
        seccompProfile:
          type: RuntimeDefault
        appArmorProfile:
          type: RuntimeDefault
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"
      volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: cache
          mountPath: /app/cache
      env:
        - name: HOME
          value: /tmp   # Writable directory for Go runtime

  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 100Mi
    - name: cache
      emptyDir:
        sizeLimit: 500Mi

  hostPID: false
  hostIPC: false
  hostNetwork: false
```

## Section 8: Operational Troubleshooting

### Diagnosing seccomp Denials

```bash
# A process was killed with SIGSYS — seccomp denial
# Check kernel audit log
dmesg | grep seccomp | tail -20
# [12345.678] audit: type=1326 audit(1234567890.123:456):
# syscall=317 compat=0 ip=0x7f1234567890 code=0x80000000

# Decode the syscall number
# syscall=317 on x86_64 is seccomp (the seccomp syscall itself)
ausyscall x86_64 317
# seccomp

# Get human-readable output with auditd
ausearch -m avc,user_avc,selinux_err -ts today | \
  aureport --interpret

# List all seccomp denials from containers today
journalctl -k --since today | grep "type=1326"
```

### Diagnosing AppArmor Denials

```bash
# Check AppArmor denials
journalctl -k | grep "apparmor" | grep "DENIED"

# Get structured output
ausearch -m avc -ts recent | \
  grep "apparmor" | \
  sed 's/.*comm="\([^"]*\)".*name="\([^"]*\)".*/process=\1 file=\2/'

# Generate allowed rules from denials
ausearch -m avc -ts recent | grep myapp | audit2allow

# Force a profile reload after changes
apparmor_parser -r /etc/apparmor.d/containers.myapp
systemctl reload apparmor
```

### Diagnosing SELinux Denials

```bash
# Show recent AVC denials
ausearch -m avc -ts recent | grep container_t

# Get a policy decision
sesearch --allow --source container_t --target sysfs_t --class file

# Temporarily disable enforcement for a specific container type
semanage permissive -a container_t   # WARNING: reduces security

# Check if booleans need to be set
getsebool -a | grep container
semanage boolean -l | grep container_use

# Enable a relevant boolean
setsebool -P container_use_devices 0   # Keep disabled unless needed
```

Combining seccomp, AppArmor, and SELinux with Kubernetes Pod Security Standards creates a multi-layered defense that significantly increases the cost of container escapes and privilege escalation attempts — transforming your container runtime from a security boundary into a genuinely difficult target.
