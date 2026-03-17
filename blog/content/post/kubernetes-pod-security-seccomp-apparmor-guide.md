---
title: "Kubernetes Pod Security: Seccomp Profiles, AppArmor, Capability Dropping, and OPA Policies"
date: 2028-08-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Seccomp", "AppArmor", "Pod Security", "OPA"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to hardening Kubernetes pod security. Covers Seccomp profiles, AppArmor policies, Linux capability management, Pod Security Standards, and OPA/Gatekeeper policies for enforcing security posture across clusters."
more_link: "yes"
url: "/kubernetes-pod-security-seccomp-apparmor-guide/"
---

Kubernetes workload security is built from overlapping layers. No single mechanism provides complete isolation — you need syscall filtering (seccomp), mandatory access control (AppArmor/SELinux), capability restrictions, read-only filesystems, and policy enforcement working together. This guide covers each layer in depth, with production-ready profiles and OPA policies that enforce them at admission time.

<!--more-->

# [Kubernetes Pod Security](#kubernetes-pod-security)

## Section 1: The Security Layers

A container is a process running on the host kernel. Unlike VMs, containers share the same kernel. This means a malicious container can potentially:
- Call any syscall the kernel supports
- Escalate privileges via kernel exploits
- Escape the container namespace via misconfiguration
- Read sensitive files on the host

The defense-in-depth approach layers:

1. **Pod Security Standards** (PSS): Cluster-level admission control — restricted/baseline/privileged
2. **Seccomp**: Syscall filtering — block rarely-used syscalls that are common exploit vectors
3. **AppArmor**: Filesystem path-based MAC — limit which files a process can read/write/execute
4. **Linux Capabilities**: Drop all capabilities and grant only what is required
5. **No privilege escalation**: `allowPrivilegeEscalation: false`
6. **Read-only root filesystem**: Prevent filesystem tampering
7. **Non-root user**: Reduces impact of container escape

## Section 2: Pod Security Standards

PSS replaced the deprecated PodSecurityPolicy. Three levels are defined in the Kubernetes spec:

- **privileged**: No restrictions (for system pods like CSI drivers)
- **baseline**: Prevents known privilege escalation
- **restricted**: Maximum security, CIS benchmark compliant

### Namespace-Level Enforcement

```yaml
# Apply restricted PSS to all production namespaces
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Enforce: reject non-compliant pods
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.30

    # Audit: log non-compliant pods but allow them
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.30

    # Warn: show warnings but allow them
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.30
```

```yaml
# For system namespaces that need privileged
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: privileged
---
# For infrastructure namespaces
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

### Compliant Pod Spec (Restricted PSS)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  template:
    spec:
      # Run as non-root
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
        # Seccomp profile (required for restricted PSS)
        seccompProfile:
          type: RuntimeDefault
        # Supplemental groups
        supplementalGroups: [1000]
        sysctls: []

      # No service account token mounting unless needed
      automountServiceAccountToken: false

      containers:
        - name: api
          image: myapp:1.0.0
          securityContext:
            # Drop all capabilities
            capabilities:
              drop: [ALL]
              add: []   # Only add if absolutely required
            # No privilege escalation
            allowPrivilegeEscalation: false
            # Read-only filesystem
            readOnlyRootFilesystem: true
            # Must run as non-root
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            # Seccomp (overrides pod-level if specified)
            seccompProfile:
              type: RuntimeDefault

          # Writable volumes for app data
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: cache
              mountPath: /app/cache
            - name: config
              mountPath: /app/config
              readOnly: true

      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 100Mi
        - name: cache
          emptyDir:
            sizeLimit: 500Mi
        - name: config
          configMap:
            name: api-config
            defaultMode: 0444  # Read-only permissions
```

## Section 3: Seccomp Profiles

Seccomp (Secure Computing Mode) filters syscalls at the kernel level. The `RuntimeDefault` profile blocks ~50 rarely-used but exploitable syscalls. Custom profiles provide finer control.

### Built-in Profile Types

```yaml
# RuntimeDefault: container runtime's default filter (Docker/containerd)
seccompProfile:
  type: RuntimeDefault

# Unconfined: no filtering (avoid in production)
seccompProfile:
  type: Unconfined

# Localhost: custom profile from node filesystem
seccompProfile:
  type: Localhost
  localhostProfile: profiles/my-app.json
```

### Custom Seccomp Profile

Seccomp profiles are JSON files placed in `/var/lib/kubelet/seccomp/` on each node (or via DaemonSet).

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32"
  ],
  "syscalls": [
    {
      "names": [
        "accept",
        "accept4",
        "access",
        "bind",
        "brk",
        "capget",
        "capset",
        "chdir",
        "chmod",
        "chown",
        "clock_getres",
        "clock_gettime",
        "clock_nanosleep",
        "close",
        "connect",
        "copy_file_range",
        "dup",
        "dup2",
        "dup3",
        "epoll_create",
        "epoll_create1",
        "epoll_ctl",
        "epoll_pwait",
        "epoll_wait",
        "eventfd",
        "eventfd2",
        "execve",
        "execveat",
        "exit",
        "exit_group",
        "faccessat",
        "faccessat2",
        "fadvise64",
        "fallocate",
        "fchdir",
        "fchmod",
        "fchmodat",
        "fchown",
        "fchownat",
        "fcntl",
        "fdatasync",
        "fgetxattr",
        "flistxattr",
        "flock",
        "fremovexattr",
        "fsetxattr",
        "fstat",
        "fstatfs",
        "fsync",
        "ftruncate",
        "futex",
        "getcpu",
        "getcwd",
        "getdents",
        "getdents64",
        "getegid",
        "geteuid",
        "getgid",
        "getgroups",
        "getitimer",
        "getpeername",
        "getpgid",
        "getpgrp",
        "getpid",
        "getppid",
        "getpriority",
        "getrandom",
        "getresgid",
        "getresuid",
        "getrlimit",
        "getrusage",
        "getsid",
        "getsockname",
        "getsockopt",
        "gettid",
        "gettimeofday",
        "getuid",
        "getxattr",
        "inotify_add_watch",
        "inotify_init",
        "inotify_init1",
        "inotify_rm_watch",
        "io_cancel",
        "io_destroy",
        "io_getevents",
        "io_setup",
        "io_submit",
        "io_uring_enter",
        "io_uring_register",
        "io_uring_setup",
        "ioctl",
        "kill",
        "lgetxattr",
        "link",
        "linkat",
        "listen",
        "listxattr",
        "llistxattr",
        "lremovexattr",
        "lseek",
        "lsetxattr",
        "lstat",
        "madvise",
        "memfd_create",
        "mincore",
        "mkdir",
        "mkdirat",
        "mlock",
        "mlock2",
        "mlockall",
        "mmap",
        "mount",
        "mprotect",
        "mq_getsetattr",
        "mq_notify",
        "mq_open",
        "mq_timedreceive",
        "mq_timedsend",
        "mq_unlink",
        "mremap",
        "msgctl",
        "msgget",
        "msgrcv",
        "msgsnd",
        "msync",
        "munlock",
        "munlockall",
        "munmap",
        "nanosleep",
        "newfstatat",
        "open",
        "openat",
        "openat2",
        "pause",
        "pipe",
        "pipe2",
        "poll",
        "ppoll",
        "prctl",
        "pread64",
        "preadv",
        "preadv2",
        "prlimit64",
        "pselect6",
        "ptrace",
        "pwrite64",
        "pwritev",
        "pwritev2",
        "read",
        "readahead",
        "readlink",
        "readlinkat",
        "readv",
        "recv",
        "recvfrom",
        "recvmmsg",
        "recvmsg",
        "remap_file_pages",
        "removexattr",
        "rename",
        "renameat",
        "renameat2",
        "restart_syscall",
        "rmdir",
        "rt_sigaction",
        "rt_sigpending",
        "rt_sigprocmask",
        "rt_sigqueueinfo",
        "rt_sigreturn",
        "rt_sigsuspend",
        "rt_sigtimedwait",
        "rt_tgsigqueueinfo",
        "sched_getaffinity",
        "sched_getattr",
        "sched_getparam",
        "sched_getscheduler",
        "sched_rr_get_interval",
        "sched_setaffinity",
        "sched_setattr",
        "sched_setparam",
        "sched_setscheduler",
        "sched_yield",
        "seccomp",
        "select",
        "semctl",
        "semget",
        "semop",
        "semtimedop",
        "send",
        "sendfile",
        "sendfile64",
        "sendmmsg",
        "sendmsg",
        "sendto",
        "set_robust_list",
        "set_thread_area",
        "set_tid_address",
        "setfsgid",
        "setfsuid",
        "setgid",
        "setgroups",
        "setitimer",
        "setpgid",
        "setpriority",
        "setregid",
        "setresgid",
        "setresuid",
        "setreuid",
        "setrlimit",
        "setsid",
        "setsockopt",
        "setuid",
        "setxattr",
        "shmat",
        "shmctl",
        "shmdt",
        "shmget",
        "shutdown",
        "sigaltstack",
        "signalfd",
        "signalfd4",
        "socket",
        "socketpair",
        "splice",
        "stat",
        "statfs",
        "statx",
        "symlink",
        "symlinkat",
        "sync",
        "sync_file_range",
        "syncfs",
        "sysinfo",
        "tee",
        "tgkill",
        "time",
        "timer_create",
        "timer_delete",
        "timer_getoverrun",
        "timer_gettime",
        "timer_settime",
        "timerfd_create",
        "timerfd_gettime",
        "timerfd_settime",
        "tkill",
        "truncate",
        "umask",
        "uname",
        "unlink",
        "unlinkat",
        "utime",
        "utimensat",
        "utimes",
        "vfork",
        "vmsplice",
        "wait4",
        "waitid",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": [
        "personality"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 0,
          "valueTwo": 0,
          "op": "SCMP_CMP_EQ"
        }
      ]
    }
  ]
}
```

### Deploying Custom Profiles via DaemonSet

```yaml
# seccomp-profiles/daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: seccomp-profile-installer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: seccomp-installer
  template:
    metadata:
      labels:
        app: seccomp-installer
    spec:
      hostPID: false
      hostNetwork: false
      initContainers:
        - name: install-profiles
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              mkdir -p /host/seccomp/profiles
              cp /profiles/*.json /host/seccomp/profiles/
              echo "Seccomp profiles installed"
          volumeMounts:
            - name: seccomp-profiles
              mountPath: /profiles
            - name: host-seccomp
              mountPath: /host/seccomp
      containers:
        - name: pause
          image: gcr.io/pause:3.9
      volumes:
        - name: seccomp-profiles
          configMap:
            name: seccomp-profiles
        - name: host-seccomp
          hostPath:
            path: /var/lib/kubelet/seccomp
            type: DirectoryOrCreate
      tolerations:
        - operator: Exists
```

## Section 4: AppArmor Profiles

AppArmor provides mandatory access control based on filesystem paths. It prevents a compromised container from accessing files outside its expected scope.

### Writing an AppArmor Profile

```
#include <tunables/global>

profile myapp flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Network permissions
  network inet tcp,
  network inet6 tcp,
  network inet udp,
  network inet6 udp,

  # /proc and /sys (restricted)
  /proc/sys/net/core/somaxconn r,
  /proc/sys/vm/overcommit_memory r,
  /proc/self/ r,
  /proc/self/cmdline r,
  /proc/self/fd/ r,
  /proc/self/maps r,
  /proc/self/mounts r,
  /proc/self/stat r,
  /proc/self/status r,
  deny /proc/sys/** wklx,
  deny /proc/sysrq-trigger rwklx,
  deny /proc/kcore rwklx,

  # Application files
  /app/ r,
  /app/** r,
  /app/binary ix,

  # Writable paths
  /tmp/ rw,
  /tmp/** rw,
  /app/cache/ rw,
  /app/cache/** rw,

  # Config (read-only)
  /app/config/ r,
  /app/config/** r,

  # TLS certificates (read-only)
  /etc/ssl/certs/ r,
  /etc/ssl/certs/** r,

  # Deny dangerous paths
  deny /etc/cron.d/** rwklx,
  deny /etc/cron.daily/** rwklx,
  deny /root/** rwklx,
  deny /home/** rwklx,
  deny /var/spool/cron/** rwklx,

  # Shared library access
  /lib/** mr,
  /lib64/** mr,
  /usr/lib/** mr,
  /usr/lib64/** mr,

  # Standard device access
  /dev/null rw,
  /dev/zero rw,
  /dev/urandom r,
  /dev/tty rw,

  # Capabilities
  capability net_bind_service,  # Only if binding to ports < 1024

  # Signal handling
  signal (send, receive) peer=myapp,

  # Deny ptrace (anti-debugging)
  deny ptrace,
  deny @{PROC}/*/mem rwklx,
}
```

### Installing AppArmor Profiles

```bash
#!/bin/bash
# install-apparmor-profile.sh

PROFILE_PATH="/etc/apparmor.d/myapp"
PROFILE_NAME="myapp"

# Copy profile
cat > "${PROFILE_PATH}" << 'PROFILE'
# Profile content here
PROFILE

# Load the profile
apparmor_parser -r -W "${PROFILE_PATH}"

# Verify it's loaded
aa-status | grep "${PROFILE_NAME}"
```

```yaml
# Deploy profiles via DaemonSet
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
    spec:
      initContainers:
        - name: install-profiles
          image: ubuntu:22.04
          command:
            - sh
            - -c
            - |
              apt-get install -y apparmor apparmor-utils
              cp /profiles/* /host/etc/apparmor.d/
              apparmor_parser -r /host/etc/apparmor.d/myapp
          securityContext:
            privileged: true  # Required for apparmor_parser
          volumeMounts:
            - name: profiles
              mountPath: /profiles
            - name: host-etc
              mountPath: /host/etc
      containers:
        - name: pause
          image: gcr.io/pause:3.9
      volumes:
        - name: profiles
          configMap:
            name: apparmor-profiles
        - name: host-etc
          hostPath:
            path: /etc
      tolerations:
        - operator: Exists
```

### Using AppArmor in Pod Spec

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Kubernetes 1.30+ uses securityContext field
        # For older versions, use annotation:
        container.apparmor.security.beta.kubernetes.io/api: localhost/myapp
    spec:
      containers:
        - name: api
          image: myapp:1.0.0
          securityContext:
            # Kubernetes 1.30+ AppArmor support in securityContext
            appArmorProfile:
              type: Localhost
              localhostProfile: myapp
```

## Section 5: Linux Capabilities Management

Linux capabilities break root privileges into discrete units. The principle: drop all, add only what you need.

### Capability Reference

```yaml
# Common capabilities and when to add them back:
securityContext:
  capabilities:
    drop: [ALL]
    add:
      # NET_BIND_SERVICE: Bind to ports < 1024 (usually avoided by using port 8080)
      - NET_BIND_SERVICE
      # NET_RAW: Raw sockets (needed for ping, some VPN clients)
      - NET_RAW
      # SYS_PTRACE: Attach to processes (needed for profiling, JVM heap dumps)
      - SYS_PTRACE
      # CHOWN: Change file ownership (needed for some init systems)
      - CHOWN
      # DAC_OVERRIDE: Bypass file permission checks (avoid this)
      - DAC_OVERRIDE
      # SETUID: Set UID (needed by some privilege-dropping apps)
      - SETUID
      # SETGID: Set GID
      - SETGID
```

### Finding Required Capabilities

```bash
# Trace syscalls to find required capabilities
# Run your app with strace and look for EPERM errors
strace -e trace=capset,prctl,setuid,setgid,setresuid,setresgid,setfsgid,setfsuid \
    -f /app/binary 2>&1 | grep -E "EPERM|CAP_"

# Use capsh to run with specific capability sets
capsh --drop=cap_net_admin,cap_sys_admin -- -c "/app/binary"

# Check what capabilities a running process has
cat /proc/$(pgrep -f binary)/status | grep Cap
# Decode with capsh
capsh --decode=0000000000000000
```

## Section 6: OPA/Gatekeeper Policies

OPA Gatekeeper enforces security policies at admission time. Non-compliant pods are rejected before they are created.

### Gatekeeper Installation

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm upgrade --install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --values gatekeeper-values.yaml
```

```yaml
# gatekeeper-values.yaml
replicaCount: 3
logLevel: INFO
logDenies: true  # Log every denied admission

# Audit existing resources
auditInterval: 60
constraintViolationsLimit: 20
auditMatchKindOnly: false

# Exempt kube-system from all policies
exemptNamespaces:
  - kube-system
  - gatekeeper-system
  - cert-manager

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 512Mi
```

### Constraint Templates

```yaml
# gatekeeper/templates/require-security-context.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirecontainersecuritycontext
spec:
  crd:
    spec:
      names:
        kind: K8sRequireContainerSecurityContext
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
        package k8srequirecontainersecuritycontext

        import future.keywords.in

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          not has_security_context(container)
          msg := sprintf("Container '%v' must have a securityContext defined", [container.name])
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          sc := container.securityContext
          sc.allowPrivilegeEscalation == true
          msg := sprintf("Container '%v' must not allow privilege escalation", [container.name])
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          sc := container.securityContext
          not sc.readOnlyRootFilesystem == true
          msg := sprintf("Container '%v' must have readOnlyRootFilesystem: true", [container.name])
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          sc := container.securityContext
          caps := sc.capabilities
          added := {c | c := caps.add[_]}
          allowed := {c | c := input.parameters.allowedCapabilities[_]}
          extra := added - allowed
          count(extra) > 0
          msg := sprintf("Container '%v' adds disallowed capabilities: %v", [container.name, extra])
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          sc := container.securityContext
          sc.runAsRoot == true
          msg := sprintf("Container '%v' must not run as root", [container.name])
        }

        has_security_context(container) {
          container.securityContext
        }
---
# Apply the constraint
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireContainerSecurityContext
metadata:
  name: require-security-context
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - monitoring
      - cert-manager
  parameters:
    allowedCapabilities:
      - NET_BIND_SERVICE
```

```yaml
# gatekeeper/templates/require-seccomp.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequireseccompprofile
spec:
  crd:
    spec:
      names:
        kind: K8sRequireSeccompProfile
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
        package k8srequireseccompprofile

        import future.keywords.in

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          not pod_has_seccomp(input.review.object)
          msg := "Pod must have a seccompProfile defined"
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          pod_seccomp := input.review.object.spec.securityContext.seccompProfile
          not pod_seccomp_allowed(pod_seccomp)
          msg := sprintf("Pod seccompProfile type '%v' is not allowed", [pod_seccomp.type])
        }

        pod_has_seccomp(pod) {
          pod.spec.securityContext.seccompProfile
        }

        pod_seccomp_allowed(seccomp) {
          allowed := input.parameters.allowedProfiles
          seccomp.type in allowed
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireSeccompProfile
metadata:
  name: require-seccomp
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces: [kube-system, monitoring]
  parameters:
    allowedProfiles:
      - RuntimeDefault
      - Localhost
```

```yaml
# gatekeeper/templates/no-privileged-containers.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snoprivilegedcontainers
spec:
  crd:
    spec:
      names:
        kind: K8sNoPrivilegedContainers
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snoprivilegedcontainers

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          container.securityContext.privileged == true
          msg := sprintf("Container '%v' must not run as privileged", [container.name])
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.initContainers[_]
          container.securityContext.privileged == true
          msg := sprintf("InitContainer '%v' must not run as privileged", [container.name])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoPrivilegedContainers
metadata:
  name: no-privileged-containers
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces: [kube-system]
```

```yaml
# gatekeeper/templates/require-non-root.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirenonroot
spec:
  crd:
    spec:
      names:
        kind: K8sRequireNonRoot
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequirenonroot

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          not has_run_as_non_root(input.review.object, container)
          msg := sprintf("Container '%v' must set runAsNonRoot: true or runAsUser > 0", [container.name])
        }

        has_run_as_non_root(pod, container) {
          container.securityContext.runAsNonRoot == true
        }

        has_run_as_non_root(pod, container) {
          pod.spec.securityContext.runAsNonRoot == true
        }

        has_run_as_non_root(pod, container) {
          container.securityContext.runAsUser > 0
        }

        has_run_as_non_root(pod, container) {
          pod.spec.securityContext.runAsUser > 0
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireNonRoot
metadata:
  name: require-non-root
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces: [kube-system, monitoring]
```

## Section 7: Image Security Policies

```yaml
# gatekeeper/templates/allowed-registries.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedregistries
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRegistries
      validation:
        openAPIV3Schema:
          type: object
          properties:
            registries:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedregistries

        import future.keywords.in

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          image := container.image
          not image_from_allowed_registry(image)
          msg := sprintf("Container '%v' uses image '%v' from a disallowed registry", [container.name, image])
        }

        image_from_allowed_registry(image) {
          registry := input.parameters.registries[_]
          startswith(image, registry)
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRegistries
metadata:
  name: allowed-registries
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces: [kube-system]
  parameters:
    registries:
      - "gcr.io/myproject/"
      - "registry.k8s.io/"
      - "quay.io/myorg/"
      - "docker.io/library/"  # Only official Docker Hub images
```

## Section 8: Security Scanning Integration

### Trivy in CI/CD

```yaml
# .github/workflows/security-scan.yml
name: Container Security Scan

on:
  push:
    branches: [main]
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build image
        run: docker build -t myapp:${{ github.sha }} .

      - name: Run Trivy vulnerability scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: myapp:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif
          exit-code: 1
          severity: CRITICAL,HIGH
          vuln-type: os,library
          ignore-unfixed: true

      - name: Upload SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif

      - name: Run Trivy config scan
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: config
          scan-ref: .
          format: table
          exit-code: 1
          severity: CRITICAL,HIGH
```

### Falco Runtime Security

```yaml
# falco/falco-rules.yaml
- rule: Unexpected Outbound Network Connection
  desc: Detect unexpected outbound connections from production pods
  condition: >
    outbound and
    container and
    container.name startswith "api-" and
    not fd.sport in (80, 443, 5432, 6379) and
    not fd.sip in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
  output: >
    Unexpected outbound connection from %container.name
    (user=%user.name command=%proc.cmdline connection=%fd.name
    image=%container.image.repository)
  priority: WARNING
  tags: [network, production]

- rule: Write to /etc in container
  desc: Detect writes to /etc inside a container
  condition: >
    container and
    open_write and
    fd.name startswith /etc and
    not proc.name in (adduser, useradd, usermod)
  output: >
    Write to /etc in container %container.name
    (user=%user.name file=%fd.name image=%container.image.repository)
  priority: CRITICAL
  tags: [filesystem, privilege-escalation]

- rule: Container Shell Spawned
  desc: Detect shell spawned in production container
  condition: >
    spawned_process and
    container and
    shell_procs and
    not container.name startswith "debug-"
  output: >
    Shell spawned in container %container.name
    (user=%user.name shell=%proc.name parent=%proc.pname
    image=%container.image.repository)
  priority: WARNING
  tags: [shell, intrusion]
```

## Section 9: Security Audit Script

```bash
#!/bin/bash
# security-audit.sh — Audit pod security posture

echo "=== Kubernetes Pod Security Audit ==="

echo ""
echo "--- Pods running as root ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(
    .spec.securityContext.runAsUser == 0 or
    (.spec.containers[].securityContext.runAsUser // 0) == 0
  ) | .metadata.namespace + "/" + .metadata.name'

echo ""
echo "--- Privileged containers ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(
    .spec.containers[].securityContext.privileged == true
  ) | .metadata.namespace + "/" + .metadata.name'

echo ""
echo "--- Pods without seccomp profiles ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(
    .spec.securityContext.seccompProfile == null and
    (.spec.containers[].securityContext.seccompProfile // null) == null
  ) | .metadata.namespace + "/" + .metadata.name'

echo ""
echo "--- Pods with allowPrivilegeEscalation not set to false ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | .metadata.namespace + "/" + .metadata.name as $name |
    .spec.containers[] | select(
      (.securityContext.allowPrivilegeEscalation // true) == true
    ) | $name + " (container: " + .name + ")"'

echo ""
echo "--- Pods missing resource limits ---"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | .metadata.namespace + "/" + .metadata.name as $name |
    .spec.containers[] | select(
      .resources.limits == null or
      .resources.limits.cpu == null or
      .resources.limits.memory == null
    ) | $name + " (container: " + .name + ")"'

echo ""
echo "=== Audit complete ==="
```

## Conclusion

Pod security in Kubernetes is not a single setting but a stack of controls. Start with Pod Security Standards in `restricted` mode for all production namespaces — this provides a strong baseline. Add RuntimeDefault seccomp to all pods immediately; it has minimal performance impact and blocks the most common kernel exploit categories.

For sensitive workloads, invest in custom seccomp profiles and AppArmor policies. Use OPA/Gatekeeper to enforce your policies at admission time so non-compliant pods never reach production. Regularly run the security audit script and address findings systematically.

The principle of least privilege applies at every layer: least capabilities, least filesystem access, least syscalls. A compromised container with all these controls has far less ability to cause damage than one running as root with full capabilities.
