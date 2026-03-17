---
title: "Linux Seccomp: System Call Filtering for Container Security Hardening"
date: 2031-03-06T00:00:00-05:00
draft: false
tags: ["Security", "Linux", "Seccomp", "Containers", "Kubernetes", "Docker", "Hardening"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to seccomp-bpf filter programs, container seccomp profile JSON format, strace-based profile generation, allowlist vs denylist strategies, and Kubernetes seccompProfile configuration."
more_link: "yes"
url: "/linux-seccomp-syscall-filtering-container-security-hardening/"
---

Seccomp (Secure Computing Mode) is a Linux kernel feature that restricts which system calls a process can make. Applied to containers, a well-tuned seccomp profile dramatically reduces the attack surface available to an attacker who has achieved code execution inside the container. The default Docker/containerd profiles block approximately 44 system calls; a custom profile for a specific workload can reduce the allowed syscall set to under 50 of the 400+ available syscalls.

<!--more-->

# Linux Seccomp: System Call Filtering for Container Security Hardening

## Section 1: seccomp Architecture

### How Seccomp Works

Seccomp operates at the kernel level as a filter on system calls. When a process makes a syscall, the kernel evaluates the seccomp filter before allowing the syscall to proceed. The filter is written in BPF (Berkeley Packet Filter) bytecode.

There are two seccomp modes:
- **Mode 1 (strict)**: Only allows `read`, `write`, `exit`, and `sigreturn`. Used for sandboxing.
- **Mode 2 (filter)**: Allows a BPF program to define allowed/denied syscalls. This is what containers use.

The BPF program receives a `seccomp_data` structure for each syscall:

```c
struct seccomp_data {
    int   nr;       // syscall number (e.g., 1 = write, 2 = open)
    __u32 arch;     // architecture (AUDIT_ARCH_X86_64, etc.)
    __u64 instruction_pointer; // caller's instruction pointer
    __u64 args[6];  // syscall arguments
};
```

The filter returns one of these actions:
- `SECCOMP_RET_ALLOW`: Allow the syscall.
- `SECCOMP_RET_ERRNO`: Return an error (customizable errno value).
- `SECCOMP_RET_KILL_THREAD`: Kill the calling thread.
- `SECCOMP_RET_KILL_PROCESS`: Kill the entire process (added in Linux 4.14).
- `SECCOMP_RET_TRAP`: Send SIGSYS signal to the process.
- `SECCOMP_RET_TRACE`: Allow ptrace-based tracing (used by syscall tracers).
- `SECCOMP_RET_LOG`: Log and allow (added in Linux 4.14).

### seccomp-bpf Filter Architecture

```
process calls syscall
        │
        ▼
   kernel entry point
        │
        ▼
   seccomp filter chain
   ┌────────────────────┐
   │  Filter 1          │  ← Applied first (most recently added)
   │  BPF program       │
   │  returns: ALLOW    │
   └────────────────────┘
        │
        ▼
   ┌────────────────────┐
   │  Filter 2          │  ← Applied second (parent filter, if any)
   │  BPF program       │
   │  returns: ALLOW    │
   └────────────────────┘
        │
        ▼
   syscall executes
```

Filters compose: a child process inherits parent filters AND can add new (more restrictive) filters. Filters cannot be removed once applied.

## Section 2: Default Container Seccomp Profiles

### Docker/containerd Default Profile

The default seccomp profile blocks syscalls that are dangerous or rarely needed by typical applications. Key categories blocked:

**Privilege escalation syscalls**:
- `ptrace` (process tracing — used by debuggers)
- `process_vm_readv`, `process_vm_writev` (cross-process memory access)
- `keyctl`, `add_key`, `request_key` (kernel keyring)
- `mount`, `umount2` (filesystem mounting)
- `pivot_root` (container escape vector)

**Kernel module syscalls**:
- `init_module`, `finit_module`, `delete_module`

**Namespace syscalls**:
- `unshare` (create new namespace — container escape vector)
- `setns` (join namespace)

**Deprecated/dangerous syscalls**:
- `_sysctl` (obsolete sysctl interface)
- `acct` (process accounting)
- `nfsservctl` (NFS server)
- `vm86` (x86 virtual 8086 mode)

View the full default profile:

```bash
# Get Docker's default seccomp profile
docker run --rm alpine cat /proc/1/status | grep Seccomp
# Seccomp: 2   (mode 2 = filter mode, active)

# View allowed syscalls for a Docker container
cat /usr/share/doc/docker.io/default.json | jq '.syscalls[] | select(.action=="SCMP_ACT_ALLOW") | .names[]' | sort
```

### Checking Seccomp Status

```bash
# Check if seccomp is enabled in kernel
cat /boot/config-$(uname -r) | grep CONFIG_SECCOMP
# CONFIG_SECCOMP=y
# CONFIG_SECCOMP_FILTER=y

# Check seccomp mode of a running process
cat /proc/$(pgrep nginx)/status | grep Seccomp
# Seccomp: 2

# Check seccomp filter details (requires root)
cat /proc/$(pgrep nginx)/seccomp_filter_info
```

## Section 3: Seccomp Profile JSON Format

### Structure of a Seccomp Profile

The seccomp profile JSON format used by Docker/containerd/Kubernetes:

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
      "names": ["read", "write", "close"],
      "action": "SCMP_ACT_ALLOW",
      "args": [],
      "comment": "Basic I/O"
    },
    {
      "names": ["socket"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 2,
          "valueTwo": 0,
          "op": "SCMP_CMP_EQ"
        }
      ],
      "comment": "Allow only AF_INET (IPv4) sockets"
    },
    {
      "names": ["ptrace"],
      "action": "SCMP_ACT_KILL_PROCESS",
      "comment": "Kill if ptrace is attempted"
    }
  ]
}
```

### Action Values

| JSON Value | Meaning |
|------------|---------|
| `SCMP_ACT_ALLOW` | Allow the syscall |
| `SCMP_ACT_ERRNO` | Return errno (default: EPERM) |
| `SCMP_ACT_KILL_THREAD` | Kill the calling thread |
| `SCMP_ACT_KILL_PROCESS` | Kill the process (recommended over KILL_THREAD) |
| `SCMP_ACT_TRAP` | Send SIGSYS |
| `SCMP_ACT_LOG` | Log and allow |
| `SCMP_ACT_TRACE` | Allow with ptrace notification |

### Argument Filtering

Seccomp can filter not just on syscall number but also on argument values:

```json
{
  "names": ["ioctl"],
  "action": "SCMP_ACT_ALLOW",
  "args": [
    {
      "index": 1,
      "value": 21505,
      "op": "SCMP_CMP_EQ"
    }
  ],
  "comment": "Allow only TCGETS ioctl (0x5401)"
}
```

Comparison operators:
- `SCMP_CMP_NE`: Not equal
- `SCMP_CMP_LT`: Less than
- `SCMP_CMP_LE`: Less than or equal
- `SCMP_CMP_EQ`: Equal
- `SCMP_CMP_GE`: Greater than or equal
- `SCMP_CMP_GT`: Greater than
- `SCMP_CMP_MASKED_EQ`: Masked equality (for flags)

## Section 4: Generating Profiles with strace

### strace-Based Profile Generation

The most reliable way to build a custom seccomp profile is to run your application under strace and collect all syscalls it makes:

```bash
# Install strace
apt-get install -y strace

# Run application under strace, capturing all syscalls
# -f: follow forks
# -e trace=: capture all syscall types
# -o: output file
strace -f -e trace=all -o /tmp/strace.log ./myapp

# Extract unique syscall names
grep -oP 'syscall\(SYS_\K[^,)]+' /tmp/strace.log | sort -u

# Or extract the simpler format
grep -v "unfinished\|resumed\| +++ " /tmp/strace.log | \
  grep -oP '^\w+' | sort -u
```

### Using go-seccomp-bpf Profile Generator

For production use, the `oci-seccomp-bpf-hook` tool is more robust:

```bash
# Install the hook
apt-get install -y oci-seccomp-bpf-hook

# Run with seccomp logging enabled
docker run \
  --security-opt seccomp=unconfined \
  --annotation io.containers.trace-syscall=of:/tmp/nginx-profile.json \
  --rm \
  nginx:latest \
  nginx -t  # Run the test to exercise relevant syscalls

# The profile is generated at /tmp/nginx-profile.json
```

### Manual Profile Generation Script

```bash
#!/bin/bash
# generate-seccomp-profile.sh
# Usage: ./generate-seccomp-profile.sh <command>

CMD="$@"
TRACE_FILE="/tmp/strace-$(date +%s).log"
PROFILE_FILE="/tmp/seccomp-profile-$(date +%s).json"

echo "Tracing: $CMD"
strace -ff -o "$TRACE_FILE" $CMD 2>/dev/null || true

# Extract all unique syscall names
SYSCALLS=$(cat "${TRACE_FILE}"* 2>/dev/null | \
  grep -v "^Process\|^---\|^+++ " | \
  grep -oP '^\w+(?=\()' | \
  sort -u | \
  jq -R . | \
  jq -s .)

# Generate profile JSON
cat > "$PROFILE_FILE" << EOF
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]
    }
  ],
  "syscalls": [
    {
      "names": $SYSCALLS,
      "action": "SCMP_ACT_ALLOW",
      "comment": "Auto-generated by strace analysis"
    }
  ]
}
EOF

echo "Profile generated: $PROFILE_FILE"
echo "Syscalls allowed: $(echo $SYSCALLS | jq length)"
```

### Using seccomp-tools for Analysis

```bash
# Install seccomp-tools (Ruby gem)
gem install seccomp-tools

# Disassemble a BPF filter from a running process
seccomp-tools dump -p $(pgrep nginx)

# Build and test a filter
cat > test.asm << 'EOF'
 line  CODE  JT   JF      K
=================================
 0000: 0x20 0x00 0x00 0x00000004  A = arch
 0001: 0x15 0x01 0x00 0xc000003e  if (A == ARCH_X86_64) goto 0003
 0002: 0x06 0x00 0x00 0x00000000  return KILL
 0003: 0x20 0x00 0x00 0x00000000  A = sys_number
 0004: 0x15 0x00 0x01 0x00000001  if (A != write) goto 0006
 0005: 0x06 0x00 0x00 0x7fff0000  return ALLOW
 0006: 0x06 0x00 0x00 0x00000000  return KILL
EOF

seccomp-tools asm test.asm
```

## Section 5: Production Seccomp Profiles

### Minimal Web Server Profile

A minimal profile for an nginx or Go HTTP server:

```json
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
        "accept4", "access",
        "arch_prctl",
        "bind", "brk",
        "capget", "capset", "chdir", "chmod", "chown", "clock_gettime",
        "clone", "clone3", "close", "connect",
        "dup", "dup2", "dup3",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait",
        "epoll_wait", "eventfd2", "execve", "exit", "exit_group",
        "faccessat", "fadvise64", "fallocate", "fcntl", "fdatasync",
        "flock", "fstat", "fstatfs", "fsync", "ftruncate", "futex",
        "getcwd", "getdents64", "getegid", "geteuid", "getgid",
        "getpeername", "getpid", "getppid", "getrandom", "getrlimit",
        "getsockname", "getsockopt", "gettid", "getuid", "getxattr",
        "inotify_add_watch", "inotify_init1", "inotify_rm_watch",
        "ioctl", "kill",
        "lchown", "lgetxattr", "link", "linkat", "listen", "lseek",
        "lstat",
        "madvise", "mmap", "mprotect", "mremap", "munmap",
        "nanosleep", "newfstatat",
        "open", "openat",
        "pipe", "pipe2", "poll", "ppoll", "prctl", "pread64",
        "preadv", "preadv2", "prlimit64", "pwrite64", "pwritev",
        "pwritev2",
        "read", "readlink", "readlinkat", "readv", "recv", "recvfrom",
        "recvmsg", "rename", "renameat", "renameat2", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "rt_sigsuspend",
        "sched_getaffinity", "sched_getparam", "sched_getscheduler",
        "sched_yield", "select", "send", "sendfile", "sendmsg",
        "sendto", "set_robust_list", "set_tid_address", "setgid",
        "setgroups", "setitimer", "setpgid", "setrlimit", "setsid",
        "setsockopt", "setuid", "sigaltstack", "socket", "socketpair",
        "stat", "statfs", "statx", "symlink", "symlinkat",
        "tgkill", "timer_create", "timer_delete", "timer_gettime",
        "timer_settime", "timerfd_create", "timerfd_gettime",
        "timerfd_settime",
        "umask", "uname", "unlink", "unlinkat", "utime", "utimensat",
        "wait4", "waitid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["ptrace", "process_vm_readv", "process_vm_writev"],
      "action": "SCMP_ACT_KILL_PROCESS",
      "comment": "Explicitly kill on dangerous syscalls"
    }
  ]
}
```

### Go Application Profile

Go applications have slightly different syscall requirements due to goroutine management:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "accept4", "arch_prctl",
        "brk", "clone", "clone3", "close", "connect",
        "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_wait",
        "eventfd2", "execve", "exit_group",
        "fcntl", "fstat", "futex",
        "getdents64", "getpid", "getrandom", "getsockname",
        "getsockopt", "gettid",
        "kill",
        "listen",
        "madvise", "mincore", "mmap", "mprotect", "munmap",
        "nanosleep", "newfstatat",
        "openat",
        "pipe2", "poll", "pread64", "prlimit64",
        "read", "readlinkat", "recvfrom", "recvmsg",
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "sched_getaffinity", "sched_yield",
        "sendmsg", "sendto", "set_robust_list", "set_tid_address",
        "setsockopt", "sigaltstack", "socket",
        "stat", "statx",
        "tgkill",
        "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Go-specific requirements:
- `clone` / `clone3`: Required for goroutine creation (new OS threads)
- `futex`: Required for goroutine synchronization (mutex, channel operations)
- `mmap` / `munmap`: Required for Go's memory allocator
- `sigaltstack`: Required for Go's goroutine stack management
- `rt_sigaction`: Required for Go's signal handling (including SIGURG for async preemption)
- `getrandom`: Required for `crypto/rand`

## Section 6: Allowlist vs Denylist Strategy

### Allowlist (Recommended)

An allowlist profile blocks everything by default and explicitly permits needed syscalls:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["read", "write", "..."],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

**Pros**:
- Defense in depth: unknown/new syscalls are blocked automatically.
- Minimal attack surface.
- Clear audit trail of what the application needs.

**Cons**:
- Requires accurate profiling.
- May break on application updates that use new syscalls.
- Higher operational overhead.

### Denylist (Not Recommended for Security)

A denylist starts from Docker's default profile (which allows everything not explicitly blocked) and adds additional blocks:

```json
{
  "defaultAction": "SCMP_ACT_ALLOW",
  "syscalls": [
    {
      "names": ["ptrace", "process_vm_readv", "mount", "unshare"],
      "action": "SCMP_ACT_KILL_PROCESS"
    }
  ]
}
```

**Pros**:
- Easier to deploy (less chance of breaking the application).
- Suitable as a first step.

**Cons**:
- New attack syscalls not in the denylist are allowed.
- Requires constant maintenance as new attack techniques emerge.
- Does not significantly reduce attack surface.

### Audit Mode for Incremental Adoption

Use `SCMP_ACT_LOG` to log denied syscalls without blocking, enabling gradual profile refinement:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "syscalls": [
    {
      "names": ["read", "write", "...known-needed..."],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Collect logs:

```bash
# seccomp violations appear in auditd logs
ausearch -m SECCOMP -ts today

# Or in kernel messages
dmesg | grep "SECCOMP"

# Or via journalctl
journalctl -k | grep "type=SECCOMP"
```

Log format:

```
type=SECCOMP msg=audit(1234567890.123:456):
  auid=1000 uid=0 gid=0 ses=1 subj=... pid=1234 comm="myapp"
  exe="/usr/bin/myapp" sig=0 arch=c000003e syscall=41
  compat=0 ip=0x7f1234567890 code=0x7ffc0000
```

`syscall=41` is `socket` on x86_64. Look up syscall numbers:

```bash
# Get syscall name from number
ausyscall x86_64 41
# socket
```

## Section 7: Kubernetes seccompProfile Configuration

### Pod-Level seccompProfile

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/app-profile.json
      # type options:
      # - RuntimeDefault: use container runtime's default profile
      # - Localhost: use a profile from the node filesystem
      # - Unconfined: no seccomp filtering (dangerous)

  containers:
  - name: app
    image: myapp:latest
    securityContext:
      seccompProfile:
        type: RuntimeDefault   # Can override per-container
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 65534
      capabilities:
        drop:
        - ALL
```

### Loading Custom Profiles onto Nodes

Custom profiles must be placed on each node at a path under the kubelet's `--seccomp-profile-root` (default: `/var/lib/kubelet/seccomp`):

```bash
# Path on the node
/var/lib/kubelet/seccomp/profiles/app-profile.json

# In the Pod spec
seccompProfile:
  type: Localhost
  localhostProfile: profiles/app-profile.json
```

### DaemonSet to Distribute Profiles

Use a DaemonSet to push profiles to all nodes:

```yaml
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
      - name: installer
        image: alpine:latest
        command:
        - /bin/sh
        - -c
        - |
          mkdir -p /host/var/lib/kubelet/seccomp/profiles
          cp /profiles/* /host/var/lib/kubelet/seccomp/profiles/
          echo "Profiles installed"
        volumeMounts:
        - name: profiles
          mountPath: /profiles
        - name: host-seccomp
          mountPath: /host/var/lib/kubelet/seccomp
      containers:
      - name: pause
        image: gcr.io/pause:3.9
        resources:
          requests:
            cpu: 1m
            memory: 4Mi
      volumes:
      - name: profiles
        configMap:
          name: seccomp-profiles
      - name: host-seccomp
        hostPath:
          path: /var/lib/kubelet/seccomp
          type: DirectoryOrCreate
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: seccomp-profiles
  namespace: kube-system
data:
  nginx-profile.json: |
    {
      "defaultAction": "SCMP_ACT_ERRNO",
      "syscalls": [
        {
          "names": ["accept4", "bind", "brk", "..."],
          "action": "SCMP_ACT_ALLOW"
        }
      ]
    }
  golang-profile.json: |
    {
      "defaultAction": "SCMP_ACT_ERRNO",
      "syscalls": [...]
    }
```

### Using RuntimeDefault at Scale

For teams that cannot maintain custom profiles for every application, `RuntimeDefault` is a significant improvement over `Unconfined`:

```yaml
# Pod Security Admission — enforce RuntimeDefault for a namespace
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    # 'restricted' PSA policy requires seccomp RuntimeDefault or Localhost
```

Or use OPA Gatekeeper to enforce seccomp:

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPSeccomp
metadata:
  name: require-seccomp
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces: ["kube-system", "monitoring"]
  parameters:
    allowedProfiles:
    - "runtime/default"
    - "docker/default"
    - "localhost/*"
```

## Section 8: Seccomp with containerd and CRI-O

### containerd Default Profile

containerd uses the same JSON profile format as Docker. The default profile is embedded in the runtime.

Configure a custom default in containerd:

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd]
  [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime]
    [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime.options]
      # Path to the default seccomp profile
      # (If not set, uses the built-in default)
      SeccompProfilePath = "/etc/containerd/seccomp/default.json"
```

### Verifying Seccomp Is Applied

```bash
# Check seccomp mode of a container process
CONTAINER_PID=$(crictl inspect <container-id> | jq '.info.pid')
cat /proc/$CONTAINER_PID/status | grep Seccomp
# Seccomp: 2  (mode 2 = bpf filter, active)

# Dump the BPF filter applied to the process
# (requires bpftrace or seccomp-tools)
seccomp-tools dump -p $CONTAINER_PID 2>/dev/null | head -30
```

## Section 9: Testing Seccomp Profiles

### Unit Testing Profiles

```bash
#!/bin/bash
# test-seccomp-profile.sh
# Tests that a seccomp profile correctly blocks specified syscalls

PROFILE=$1
IMAGE=${2:-alpine:latest}

echo "Testing profile: $PROFILE"

# Test 1: profile should allow basic operations
echo "Test 1: Basic operations (should succeed)"
docker run --rm \
  --security-opt seccomp="$PROFILE" \
  "$IMAGE" \
  sh -c "echo 'hello world' && ls /tmp" \
  && echo "PASS" || echo "FAIL"

# Test 2: ptrace should be blocked
echo "Test 2: ptrace (should fail with EPERM)"
docker run --rm \
  --security-opt seccomp="$PROFILE" \
  "$IMAGE" \
  sh -c "strace -e trace=none echo test 2>&1" \
  | grep -q "Operation not permitted" && echo "PASS (blocked)" || echo "FAIL (not blocked)"

# Test 3: mount should be blocked
echo "Test 3: mount (should fail)"
docker run --rm \
  --security-opt seccomp="$PROFILE" \
  "$IMAGE" \
  mount -t tmpfs none /mnt 2>&1 \
  | grep -q "Operation not permitted" && echo "PASS (blocked)" || echo "FAIL (not blocked)"
```

### Automated Testing with Trivy

Trivy can scan containers for missing seccomp profiles:

```bash
# Scan for security misconfigurations including seccomp
trivy config --policy-namespaces builtin.kubernetes /path/to/manifests/

# Specific seccomp check
trivy config \
  --checks-bundle-dir /usr/local/share/trivy/checks \
  --severity MEDIUM,HIGH,CRITICAL \
  deployment.yaml
```

## Section 10: Seccomp Integration with AppArmor and SELinux

### Defense in Depth Layering

Seccomp, AppArmor, and SELinux are complementary controls:

| Layer | What It Controls |
|-------|-----------------|
| Seccomp | System call numbers and arguments |
| AppArmor | File paths, capabilities, network |
| SELinux | Mandatory access control via labels |
| Capabilities | Linux capabilities (CAP_NET_ADMIN, etc.) |

All four can be applied simultaneously. A container can have:
- Seccomp filtering: Only 50 allowed syscalls
- AppArmor: Cannot write to `/etc`
- SELinux: Mandatory labels for container processes
- Capabilities: `drop ALL`, `add NET_BIND_SERVICE`

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: hardened-app
    securityContext:
      seccompProfile:
        type: Localhost
        localhostProfile: profiles/myapp.json
      appArmorProfile:
        type: Localhost
        localhostProfile: myapp-apparmor
      capabilities:
        drop: ["ALL"]
        add: ["NET_BIND_SERVICE"]
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 10001
```

## Summary

Seccomp provides the tightest possible system call surface restriction for containerized workloads:

- **Profile generation**: Use strace or oci-seccomp-bpf-hook to capture syscalls during realistic workload execution.
- **Allowlist strategy**: Default-deny with explicit allows is significantly more secure than default-allow with explicit blocks.
- **Kubernetes integration**: Use `seccompProfile.type: Localhost` for custom profiles distributed via DaemonSet, or `RuntimeDefault` as a baseline.
- **Audit mode**: Deploy `SCMP_ACT_LOG` profiles initially to collect syscall data without breaking applications.
- **Testing**: Validate profiles with both positive tests (application works) and negative tests (blocked syscalls actually fail).

A production hardening baseline should layer seccomp with capability dropping, AppArmor/SELinux, and read-only root filesystems to create genuinely defense-in-depth container security.
