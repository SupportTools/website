---
title: "Linux Namespaces and Capabilities: Security Hardening for Containerized Workloads"
date: 2031-07-26T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Containers", "Namespaces", "Capabilities", "Kubernetes"]
categories:
- Linux
- Security
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux namespaces and capabilities covering namespace isolation mechanics, capability dropping strategies, seccomp profiles, and practical security hardening patterns for production containerized workloads on Kubernetes."
more_link: "yes"
url: "/linux-namespaces-capabilities-security-hardening-containerized-workloads/"
---

Containers are not a security boundary — they are a process isolation mechanism built on Linux kernel features. Understanding what those features actually provide, and more importantly, what they do not provide, is the foundation of container security. This guide covers the Linux namespace and capability systems at the level of depth needed to make informed security decisions for production Kubernetes workloads.

<!--more-->

# Linux Namespaces and Capabilities: Security Hardening for Containerized Workloads

## Linux Namespaces: What They Isolate

Linux namespaces create isolated views of global system resources. A process in a namespace sees only the resources associated with that namespace. There are eight namespace types:

| Namespace | Kernel Symbol | Isolates |
|-----------|---------------|----------|
| Mount     | CLONE_NEWNS   | Mount points, filesystem tree |
| UTS       | CLONE_NEWUTS  | Hostname and NIS domain name |
| IPC       | CLONE_NEWIPC  | System V IPC, POSIX message queues |
| PID       | CLONE_NEWPID  | Process IDs |
| Network   | CLONE_NEWNET  | Network interfaces, routes, netfilter rules |
| User      | CLONE_NEWUSER | User and group IDs |
| Cgroup    | CLONE_NEWCGROUP | cgroup root directory |
| Time      | CLONE_NEWTIME | System clock offsets (kernel 5.6+) |

### What Namespaces Do NOT Provide

Understanding the limitations is as important as understanding the capabilities:

- **Namespaces do not prevent kernel vulnerabilities**: A container escape via a kernel bug bypasses all namespace isolation because the attacker reaches the host kernel
- **Network namespaces do not prevent network attacks**: A container can still exhaust host network bandwidth
- **PID namespaces do not prevent resource exhaustion**: A fork bomb in a container affects the host if cgroups don't limit process count
- **Mount namespaces do not isolate kernel filesystems**: `/proc`, `/sys`, and other pseudo-filesystems leak information about the host

## Inspecting Namespace Configuration

```bash
# View namespaces for a running container
CONTAINER_PID=$(docker inspect -f '{{.State.Pid}}' my-container)

# List all namespaces for this process
ls -la /proc/${CONTAINER_PID}/ns/
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 cgroup -> cgroup:[4026531835]
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 ipc -> ipc:[4026532583]
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 mnt -> mnt:[4026532581]
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 net -> net:[4026532586]
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 pid -> pid:[4026532584]
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 uts -> uts:[4026532582]
# lrwxrwxrwx 1 root root 0 Jul 26 10:00 user -> user:[4026531837]

# Compare with host namespaces
ls -la /proc/1/ns/

# If any namespace IDs match the host, that namespace is shared
# user:[4026531837] is the same — user namespace is NOT isolated (default Docker)
```

### Checking Kubernetes Pod Namespace Sharing

```bash
# Check if a pod shares host namespaces
kubectl get pod my-pod -n production -o jsonpath='{.spec.hostPID}{.spec.hostIPC}{.spec.hostNetwork}'

# Detailed security context
kubectl get pod my-pod -n production -o yaml | grep -A20 "securityContext"
```

## Linux Capabilities: Fine-Grained Privilege

The traditional Unix privilege model is binary: root (UID 0) has all privileges, non-root has none. Linux capabilities divide root's privileges into approximately 40 distinct units, allowing processes to hold only specific elevated privileges.

### Key Capabilities

```
CAP_NET_ADMIN      Manage network interfaces, routing, netfilter
CAP_NET_BIND_SERVICE  Bind to ports below 1024
CAP_SYS_ADMIN      Broad system administration (extremely dangerous)
CAP_SYS_PTRACE     Trace arbitrary processes (enables container escape)
CAP_DAC_OVERRIDE   Bypass file permission checks
CAP_CHOWN          Change file UID/GID
CAP_SETUID/SETGID  Change process UID/GID
CAP_SYS_MODULE     Load/unload kernel modules (host takeover)
CAP_SYS_RAWIO      Raw I/O operations (disk read bypass)
CAP_MKNOD          Create device files
CAP_AUDIT_WRITE    Write audit log records
CAP_KILL           Send signals to arbitrary processes
```

### Default Container Capabilities

Docker and containerd add the following capabilities by default (without `--privileged`):

```
CAP_AUDIT_WRITE
CAP_CHOWN
CAP_DAC_OVERRIDE
CAP_FOWNER
CAP_FSETID
CAP_KILL
CAP_MKNOD
CAP_NET_BIND_SERVICE
CAP_NET_RAW
CAP_SETFCAP
CAP_SETGID
CAP_SETPCAP
CAP_SETUID
CAP_SYS_CHROOT
```

Several of these are dangerous for multi-tenant environments:
- `CAP_NET_RAW`: Allows raw socket creation, enabling ARP spoofing and packet sniffing
- `CAP_SYS_CHROOT`: Enables container escape techniques
- `CAP_MKNOD`: Creates device files, potential host device access

### Inspecting Process Capabilities

```bash
# View capabilities of a running process
cat /proc/${CONTAINER_PID}/status | grep Cap

# CapInh: 0000000000000000  (inheritable)
# CapPrm: 00000000a80425fb  (permitted)
# CapEff: 00000000a80425fb  (effective)
# CapBnd: 00000000a80425fb  (bounding set)
# CapAmb: 0000000000000000  (ambient)

# Decode the hex value
capsh --decode=00000000a80425fb
# 0x00000000a80425fb=cap_chown,cap_dac_override,cap_fowner,cap_fsetid,
#   cap_kill,cap_setgid,cap_setuid,cap_setpcap,cap_net_bind_service,
#   cap_net_raw,cap_sys_chroot,cap_mknod,cap_audit_write,cap_setfcap

# View capabilities needed by a specific binary
getcap /bin/ping
# /bin/ping = cap_net_raw+ep

# List all binaries with file capabilities
find / -xdev -not -type l -executable -exec getcap {} + 2>/dev/null
```

## Capability Dropping in Kubernetes

### Pod Security Context (Minimal Capabilities)

```yaml
# production-pod-security.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  namespace: production
spec:
  template:
    spec:
      # Pod-level security context
      securityContext:
        # Run as non-root user
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        # Restrict syscall access
        seccompProfile:
          type: RuntimeDefault
        # Prevent privilege escalation via setuid/setgid
        supplementalGroups: [1000]

      containers:
        - name: web-api
          image: registry.example.com/web-api:v1.0.0
          # Container-level security context
          securityContext:
            # Drop ALL capabilities, then add back only what's needed
            capabilities:
              drop:
                - ALL
              add:
                - NET_BIND_SERVICE  # Only if binding to port < 1024
            # Prevent privilege escalation
            allowPrivilegeEscalation: false
            # Read-only root filesystem
            readOnlyRootFilesystem: true
            # Enforce non-root
            runAsNonRoot: true
            runAsUser: 1000

          # Writable volumes for required directories
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: cache
              mountPath: /app/cache

      volumes:
        - name: tmp
          emptyDir: {}
        - name: cache
          emptyDir: {}
```

### Identifying Required Capabilities

Before dropping all capabilities, identify which ones your application actually needs:

```bash
# Run the container with strace to capture syscalls
docker run --rm \
  --cap-add SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -v /tmp/traces:/traces \
  my-app:latest \
  sh -c "strace -o /traces/app.strace -f -e trace=all ./myapp"

# Analyze the strace output for capability-requiring syscalls
grep -E "socket|bind|setuid|setgid|chroot|ptrace|mknod|mount" /tmp/traces/app.strace

# Or use the capability-aware audit approach
# Run with audit logging and check what capabilities are actually used
docker run --rm \
  --security-opt apparmor=unconfined \
  my-app:latest

# Check audit log
ausearch -m AVC | grep capability
```

### Namespace-Scoped Minimum Capability Policy with Kyverno

```yaml
# kyverno-capabilities-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-capabilities
spec:
  validationFailureAction: enforce
  background: true
  rules:
    - name: require-drop-all
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [production, staging]
      validate:
        message: "All capabilities must be dropped with explicit add-back only."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.securityContext.capabilities.drop || '' }}"
                    operator: NotEquals
                    value: "['ALL']"

    - name: disallow-privileged-containers
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "Privileged containers are not allowed."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.securityContext.privileged || false }}"
                    operator: Equals
                    value: true

    - name: disallow-dangerous-capabilities
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "Capabilities SYS_ADMIN, SYS_PTRACE, and SYS_MODULE are not allowed."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.securityContext.capabilities.add || [] }}"
                    operator: AnyIn
                    value: ["SYS_ADMIN", "SYS_PTRACE", "SYS_MODULE", "SYS_RAWIO"]
```

## Seccomp Profiles

Seccomp (Secure Computing Mode) filters which syscalls a process can make. It's complementary to capabilities: capabilities restrict *what elevated operations* a process can perform; seccomp restricts *which kernel interfaces* it can use at all.

### RuntimeDefault vs Custom Profiles

Kubernetes supports three seccomp profile types:
- `Unconfined`: No seccomp filtering (dangerous)
- `RuntimeDefault`: The container runtime's default profile (blocks ~50 dangerous syscalls)
- `Localhost`: A custom profile stored on the node

The RuntimeDefault profile blocks syscalls like:
- `ptrace` (process tracing, used in many container escapes)
- `keyctl` (kernel key management, used in some escapes)
- `mount`/`umount` (filesystem mounting)
- `kexec_load` (load a new kernel)
- `create_module` (deprecated, but still risky)

### Custom Seccomp Profile

For more restrictive hardening, build a custom profile:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "access", "arch_prctl",
        "bind", "brk",
        "capget", "capset", "chdir", "chmod", "clock_getres",
        "clock_gettime", "clock_nanosleep", "clone", "close",
        "connect", "copy_file_range",
        "dup", "dup2", "dup3",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait",
        "epoll_wait", "eventfd", "eventfd2", "execve", "execveat",
        "exit", "exit_group",
        "faccessat", "faccessat2", "fadvise64", "fallocate",
        "fcntl", "fdatasync", "fgetxattr", "flock", "fork",
        "fsetxattr", "fstat", "fstatfs", "fsync", "ftruncate",
        "futex",
        "get_robust_list", "getcwd", "getdents64", "getegid",
        "geteuid", "getgid", "getgroups", "getpeername",
        "getpgid", "getpgrp", "getpid", "getppid", "getrandom",
        "getrlimit", "getrusage", "getsid", "getsockname",
        "getsockopt", "gettid", "gettimeofday", "getuid",
        "getxattr",
        "inotify_add_watch", "inotify_init1", "inotify_rm_watch",
        "ioctl", "ioprio_get", "ioprio_set",
        "kill",
        "lgetxattr", "link", "linkat", "listen", "listxattr",
        "llistxattr", "lseek", "lstat",
        "madvise", "memfd_create", "mkdir", "mkdirat", "mmap",
        "mprotect", "munmap",
        "nanosleep", "newfstatat",
        "open", "openat", "openat2",
        "pipe", "pipe2", "poll", "ppoll", "prctl",
        "pread64", "preadv", "preadv2", "prlimit64",
        "pselect6", "pwrite64", "pwritev", "pwritev2",
        "read", "readahead", "readlink", "readlinkat", "readv",
        "recv", "recvfrom", "recvmmsg", "recvmsg",
        "rename", "renameat", "renameat2", "rmdir",
        "rt_sigaction", "rt_sigpending", "rt_sigprocmask",
        "rt_sigqueueinfo", "rt_sigreturn", "rt_sigsuspend",
        "rt_sigtimedwait", "rt_tgsigqueueinfo",
        "sched_getaffinity", "sched_getattr", "sched_getparam",
        "sched_getscheduler", "sched_setaffinity",
        "sched_yield", "seccomp", "select", "send", "sendfile",
        "sendmmsg", "sendmsg", "sendto", "set_robust_list",
        "setfsgid", "setfsuid", "setgid", "setgroups",
        "setitimer", "setpgid", "setrlimit", "setsid",
        "setsockopt", "setuid", "shutdown", "sigaltstack",
        "socket", "socketpair", "splice", "stat", "statfs",
        "statx", "symlink", "symlinkat", "sync",
        "tee", "tgkill", "time", "timer_create", "timer_delete",
        "timer_getoverrun", "timer_gettime", "timer_settime",
        "timerfd_create", "timerfd_gettime", "timerfd_settime",
        "tkill",
        "umask", "uname", "unlink", "unlinkat", "utime",
        "utimensat", "utimes",
        "vfork",
        "wait4", "waitid", "waitpid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Store and reference the profile:

```bash
# Store on Kubernetes nodes (requires DaemonSet or node provisioning)
mkdir -p /var/lib/kubelet/seccomp/profiles
cp web-api-seccomp.json /var/lib/kubelet/seccomp/profiles/web-api.json

# Reference in Pod spec:
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: profiles/web-api.json
```

### Building Seccomp Profiles with eBPF

The Security Profiles Operator generates seccomp profiles automatically:

```bash
# Install Security Profiles Operator
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Create a profile recording
kubectl apply -f - <<'EOF'
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: web-api-recording
  namespace: production
spec:
  kind: SeccompProfile
  recorder: bpf
  podSelector:
    matchLabels:
      app: web-api
      record-profile: "true"
EOF

# Deploy your app with the recording label
kubectl label pod web-api-pod-xyz record-profile=true

# After running your application's test suite, retrieve the profile
kubectl get seccompprofile -n production
```

## AppArmor Profiles

AppArmor provides mandatory access control (MAC) at the file, network, and capability level:

```
# /etc/apparmor.d/web-api-profile
#include <tunables/global>

profile web-api /app/web-api flags=(attach_disconnected, mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  #include <abstractions/ssl_certs>

  # Allow the binary to execute
  /app/web-api mr,

  # Configuration files
  /app/config/** r,
  /etc/ssl/** r,

  # Writable directories
  /tmp/** rw,
  /app/cache/** rw,

  # Deny access to sensitive paths
  deny /etc/shadow r,
  deny /etc/gshadow r,
  deny /root/** rw,

  # Network: allow outbound TCP but deny raw sockets
  network tcp,
  network udp,
  deny network raw,
  deny network packet,

  # Capabilities: only what's needed
  capability net_bind_service,
  deny capability sys_admin,
  deny capability sys_ptrace,
  deny capability sys_module,
}
```

Load and apply:

```bash
apparmor_parser -r -W /etc/apparmor.d/web-api-profile
aa-status | grep web-api
```

Reference in Kubernetes:

```yaml
metadata:
  annotations:
    container.apparmor.security.beta.kubernetes.io/web-api: "localhost/web-api-profile"
```

## User Namespaces in Containers

User namespaces map container UIDs to unprivileged host UIDs. A process running as UID 0 inside the container is actually UID 100000 on the host. This is the most important security improvement for container isolation.

### Enabling User Namespaces in Kubernetes

As of Kubernetes 1.30, user namespaces are enabled via `hostUsers: false`:

```yaml
# user-namespace-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: isolated-app
  namespace: production
spec:
  # Enable user namespace isolation
  hostUsers: false

  containers:
    - name: app
      image: registry.example.com/app:v1.0.0
      securityContext:
        # Process inside container runs as root (UID 0)
        # but maps to high UID on host (e.g., 100000)
        runAsUser: 0

      # Even with runAsUser: 0 inside the container,
      # the process has NO elevated privileges on the host
```

Verify the mapping:

```bash
# Get the container PID
CONTAINER_PID=$(crictl inspect <container-id> | jq -r '.info.pid')

# Check the UID mapping
cat /proc/${CONTAINER_PID}/uid_map
# 0 100000 65536
# Container UID 0 maps to host UID 100000, for 65536 UIDs

cat /proc/${CONTAINER_PID}/gid_map
# 0 100000 65536
```

## Privilege Escalation Prevention

### allowPrivilegeEscalation

Setting `allowPrivilegeEscalation: false` sets the `no_new_privs` bit on the process, which prevents:
- `execve()` from gaining elevated privileges via setuid/setgid binaries
- Seccomp filter removal
- AppArmor profile transitions to more permissive profiles

```bash
# Verify no_new_privs is set on a container process
cat /proc/${CONTAINER_PID}/status | grep NoNewPrivs
# NoNewPrivs: 1
```

### Preventing Setuid Binary Exploitation

```bash
# Find setuid binaries in a container image
docker run --rm --entrypoint="" my-image:latest \
  find / -type f \( -perm -4000 -o -perm -2000 \) -exec ls -la {} \; 2>/dev/null

# Remove setuid bits from common binaries in Dockerfile
# (only after verifying the application doesn't need them)
RUN chmod -s /usr/bin/su /usr/bin/sudo /usr/bin/passwd /usr/bin/chage
```

## Namespace Escape Attack Patterns

Understanding common escape techniques helps in implementing effective defenses:

### Attack: CAP_SYS_ADMIN Container Escape

```bash
# Attack (requires CAP_SYS_ADMIN in container):
# Mount the host filesystem into the container
mkdir /tmp/escape
mount /dev/sda1 /tmp/escape
# Now /tmp/escape contains the host filesystem
# Write a cron job to /tmp/escape/etc/cron.d/ for command execution

# Defense: Never grant CAP_SYS_ADMIN. Use capabilities.drop: [ALL]
```

### Attack: CAP_NET_RAW ARP Spoofing

```bash
# Attack (requires CAP_NET_RAW):
# Use arping or arpspoofing to redirect traffic in the same VLAN
arpspoof -i eth0 -t <victim-ip> <gateway-ip>

# Defense: Drop CAP_NET_RAW:
securityContext:
  capabilities:
    drop: [NET_RAW]
```

### Attack: Proc Filesystem Information Leakage

```bash
# From a container sharing the host PID namespace:
cat /proc/1/environ    # Host init environment variables (may contain secrets)
cat /proc/1/cmdline    # Host command line
ls /proc/*/fd/         # Host file descriptors

# Defense: Never use hostPID: true
# Use PID namespace isolation (default Kubernetes behavior)
```

## Security Benchmark: Pod Security Standards

Kubernetes Pod Security Standards provide three levels:

**Privileged**: No restrictions (used for system components)

**Baseline**: Prevents the most dangerous escalation vectors without breaking most workloads:
- No privileged containers
- No hostPID/hostIPC/hostNetwork
- No hostPath volumes with broad paths
- No dangerous capabilities (SYS_ADMIN, etc.)

**Restricted**: Maximum security, requires application hardening:
- All of Baseline
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- `seccompProfile.type: RuntimeDefault or Localhost`
- Read-only root filesystem (strongly recommended)

```bash
# Apply Restricted policy to a namespace
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=latest \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=latest
```

## Audit Logging for Namespace and Capability Events

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all privileged pod creations at metadata level
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods"]
    namespaces: ["production"]
    omitStages:
      - RequestReceived

  # Log security context changes
  - level: Metadata
    resources:
      - group: "apps"
        resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["create", "update", "patch"]

  # Log all exec into pods
  - level: Metadata
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach"]

  # Log security context admission decisions
  - level: RequestResponse
    users: ["system:serviceaccount:kube-system:podsecurity-webhook"]
```

## Runtime Security with Falco

Falco monitors system call activity and alerts on suspicious behavior:

```yaml
# falco-rules.yaml
- rule: Unexpected Capability Added at Runtime
  desc: Detect when a container process uses capabilities not in the default set
  condition: >
    evt.type = setns and
    container.id != host and
    not proc.name in (known_setns_binaries)
  output: >
    Unexpected setns call in container
    (user=%user.name container_id=%container.id
     container_name=%container.name
     proc_name=%proc.name parent=%proc.pname
     command=%proc.cmdline)
  priority: WARNING
  tags: [container, process, mitre_privilege_escalation]

- rule: Container Running as Root Despite Policy
  desc: Alert when a container runs as root in a namespace with restricted PSS
  condition: >
    container.id != host and
    user.uid = 0 and
    k8s.ns.name in (restricted_namespaces)
  output: >
    Container running as root in restricted namespace
    (namespace=%k8s.ns.name pod=%k8s.pod.name
     container=%container.name image=%container.image.repository)
  priority: ERROR
  tags: [container, compliance]

- rule: Mount Propagation Exploit Attempt
  desc: Detect attempts to mount host filesystem paths
  condition: >
    evt.type = mount and
    container.id != host and
    not evt.arg[2] in (/proc, /sys, /dev, /tmp)
  output: >
    Mount syscall in container (container_id=%container.id
     mount_source=%evt.arg[0] mount_target=%evt.arg[1]
     mount_type=%evt.arg[2])
  priority: CRITICAL
```

## Practical Hardening Checklist

For each containerized workload, verify:

```yaml
# hardening-checklist-pod.yaml
apiVersion: v1
kind: Pod
spec:
  # Pod-level
  hostPID: false             # Never true unless essential
  hostIPC: false             # Never true unless essential
  hostNetwork: false         # Never true unless essential
  hostUsers: false           # Enable user namespace isolation (K8s 1.30+)

  securityContext:
    runAsNonRoot: true
    runAsUser: 1000          # Specific non-zero UID
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault   # Minimum; use Localhost for custom profile

  volumes:
    - name: tmp
      emptyDir: {}           # Writable scratch space; no hostPath

  containers:
    - name: app
      securityContext:
        allowPrivilegeEscalation: false    # Critical
        readOnlyRootFilesystem: true       # Forces explicit writable mounts
        capabilities:
          drop: [ALL]                       # Drop everything
          add: []                           # Add back only what's needed
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault

      volumeMounts:
        - name: tmp
          mountPath: /tmp                   # Explicit writable mount
```

## Summary

Container security is a defense-in-depth problem, and Linux namespaces and capabilities are the foundational layer. The key principles are:

- **Least privilege via capabilities**: Drop ALL capabilities and add back only what the application demonstrably needs. `CAP_SYS_ADMIN` and `CAP_SYS_PTRACE` are almost never legitimate requirements for application containers.
- **User namespaces**: Map container UIDs to unprivileged host UIDs. A "root" process inside the container should be a non-privileged process on the host.
- **seccomp profiles**: The RuntimeDefault profile is the minimum bar. Custom profiles built from actual syscall traces provide significantly stronger isolation.
- **AppArmor/SELinux**: Mandatory access control adds a layer of defense that survives capability misconfigurations.
- **No privilege escalation**: `allowPrivilegeEscalation: false` is non-negotiable for production workloads. It prevents the entire class of setuid binary exploitation.
- **Read-only root filesystem**: Forces explicit declaration of all writable paths, dramatically reducing the attack surface from container-internal attackers.

The practical starting point is enforcing Pod Security Standards at the namespace level, beginning with `restricted` for all new namespaces and progressively migrating existing workloads.
