---
title: "Linux Process Isolation with seccomp-bpf: Writing Syscall Filter Profiles for Containers"
date: 2031-08-19T00:00:00-05:00
draft: false
tags: ["Linux", "seccomp", "BPF", "Security", "Containers", "Kubernetes", "Syscall"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into seccomp-bpf for container security: understanding the BPF filter mechanism, building minimal syscall allowlists, profiling applications with strace and seccomp-bpf audit mode, and deploying profiles in Kubernetes."
more_link: "yes"
url: "/linux-seccomp-bpf-syscall-filter-containers-guide/"
---

Every container running on Linux shares the host kernel. A compromised application that achieves code execution can attempt to use the kernel's full system call surface to escalate privileges, break out of the container namespace, or attack adjacent workloads. seccomp-bpf reduces this attack surface by filtering the system calls a process can invoke, returning `ENOSYS` or `SIGKILL` for disallowed calls. Docker's default seccomp profile blocks about 44 syscalls; a purpose-built profile for your specific application can block hundreds more.

This guide covers the seccomp-bpf mechanism from first principles: how the BPF filter interacts with the kernel, how to profile an application's actual syscall usage, how to construct a minimal allowlist profile, and how to deploy it in Kubernetes using the `SeccompProfile` custom resource.

<!--more-->

# Linux Process Isolation with seccomp-bpf: Writing Syscall Filter Profiles for Containers

## How seccomp-bpf Works

seccomp (Secure Computing Mode) has two modes:

1. **SECCOMP_MODE_STRICT** (original): allows only `read`, `write`, `exit`, and `sigreturn`
2. **SECCOMP_MODE_FILTER** (BPF): evaluates a BPF program for each syscall

When a process calls `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)` or uses the `seccomp(2)` syscall directly, the kernel loads a BPF program that is executed in the kernel context for every subsequent syscall made by that process. The BPF program receives a `seccomp_data` struct:

```c
struct seccomp_data {
    int   nr;              /* System call number */
    __u32 arch;            /* AUDIT_ARCH_* value */
    __u64 instruction_pointer; /* CPU IP of the syscall instruction */
    __u64 args[6];         /* Syscall arguments */
};
```

The BPF program returns a value that tells the kernel how to handle the syscall:

| Return Value | Behavior |
|---|---|
| `SECCOMP_RET_ALLOW` | Allow the syscall |
| `SECCOMP_RET_ERRNO` | Return -errno to the process |
| `SECCOMP_RET_KILL_PROCESS` | Kill the entire process group with SIGSYS |
| `SECCOMP_RET_KILL_THREAD` | Kill only the calling thread |
| `SECCOMP_RET_TRAP` | Send SIGSYS to the process |
| `SECCOMP_RET_TRACE` | Notify a ptrace tracer |
| `SECCOMP_RET_LOG` | Allow and log the syscall |
| `SECCOMP_RET_USER_NOTIF` | Notify a user-space listener (for SUID isolation) |

### Architecture Check

The architecture check is critical and often overlooked. Without it, a 64-bit filter can be bypassed by invoking 32-bit syscalls (which have different numbers):

```c
/* Always check architecture first in your filter */
BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
```

Docker and container runtimes handle this automatically in their default profiles using `"architecture"` fields in the JSON profile.

## Docker/OCI Seccomp Profile Format

Container runtimes use a JSON profile format:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32"
  ],
  "syscalls": [
    {
      "names": ["read", "write", "close"],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["open", "openat", "openat2"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

The `defaultAction` of `SCMP_ACT_ERRNO` means any syscall not explicitly listed returns `ENOSYS`. Alternative default action is `SCMP_ACT_KILL_PROCESS` for aggressive lockdown.

## Profiling Syscall Usage

### Method 1: strace

```bash
# Run the application under strace to capture all syscalls
strace -f -e trace=all -o /tmp/syscalls.txt ./my-application

# Count unique syscall names
grep -oP '^\w+(?=\()' /tmp/syscalls.txt | sort -u

# For a long-running service, run for several minutes covering all
# operational paths (startup, normal operation, shutdown, error handling)
strace -f -e trace=all -o /tmp/syscalls.txt \
  -p $(pgrep my-application)
```

### Method 2: seccomp Audit Mode (Preferred for Production)

Run with `SCMP_ACT_LOG` as the default action during staging. This allows all syscalls but logs any that would have been blocked:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": []
}
```

Log entries appear in the kernel audit log and are visible via `ausearch` or `journalctl`:

```bash
# Check for seccomp log entries
journalctl -k | grep "SECCOMP"

# Or via auditd
ausearch -m SECCOMP -ts recent | head -50

# Example log entry:
# type=SECCOMP msg=audit(1699123456.789:1234): auid=0 uid=0 gid=0
#   ses=1 subj=unconfined pid=12345 comm="api-server" exe="/app/server"
#   sig=0 arch=c000003e syscall=56 compat=0 ip=0x7f1234567890
#   code=0x7ffc0000
# syscall=56 corresponds to clone(2)
```

Convert syscall numbers to names:

```bash
# Map syscall number to name
ausyscall x86_64 56
# Output: clone

# Or use a lookup script
#!/bin/bash
# syscall-lookup.sh
ARCH=${1:-x86_64}
NUM=$2
ausyscall $ARCH $NUM 2>/dev/null || echo "unknown"
```

### Method 3: eBPF-based Profiling with bpftrace

```bash
# Trace all syscalls made by a specific process using bpftrace
bpftrace -e '
tracepoint:raw_syscalls:sys_enter
/pid == $1/ {
  @syscalls[args->id] = count();
}
END {
  print(@syscalls);
}
' -- $(pgrep my-application)

# Convert the output numbers to names
# syscall numbers for x86_64 are in /usr/include/asm/unistd_64.h
grep "#define __NR_" /usr/include/asm/unistd_64.h | \
  awk '{print $3, $2}' | sort -n > /tmp/syscall-map.txt
```

### Automated Profile Generation with syscall2seccomp

```bash
# Install oci-seccomp-bpf-hook (generates profiles during container runs)
# This hook intercepts syscalls during a test run and generates a profile

# Run with the profiling hook enabled
docker run \
  --security-opt seccomp=unconfined \
  --annotation io.containers.seccomp.profile="/tmp/generated-profile.json" \
  --rm \
  myapp:latest \
  /app/server --test-mode
```

## Building a Minimal Allowlist

Start from the list of syscalls your profiling revealed and build a minimal allowlist. Organize by functional group:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 38,
  "architectures": [
    "SCMP_ARCH_X86_64"
  ],
  "syscalls": [
    {
      "comment": "Process lifecycle",
      "names": [
        "exit", "exit_group",
        "getpid", "gettid",
        "getppid",
        "setsid",
        "clone", "clone3",
        "fork", "vfork",
        "execve", "execveat",
        "wait4", "waitid"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Memory management",
      "names": [
        "brk",
        "mmap", "mmap2",
        "munmap", "mprotect",
        "madvise",
        "mremap",
        "mincore",
        "mlock", "munlock",
        "msync"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "File I/O",
      "names": [
        "read", "readv", "pread64", "preadv", "preadv2",
        "write", "writev", "pwrite64", "pwritev", "pwritev2",
        "open", "openat", "openat2",
        "close", "close_range",
        "lseek",
        "stat", "fstat", "lstat", "newfstatat", "statx",
        "access", "faccessat", "faccessat2",
        "dup", "dup2", "dup3",
        "fcntl",
        "ioctl",
        "readlink", "readlinkat",
        "getcwd",
        "rename", "renameat", "renameat2",
        "unlink", "unlinkat",
        "mkdir", "mkdirat",
        "rmdir",
        "chmod", "fchmod", "fchmodat",
        "chown", "fchown", "lchown", "fchownat",
        "truncate", "ftruncate",
        "sync", "fsync", "fdatasync", "syncfs",
        "getdents", "getdents64"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Network",
      "names": [
        "socket", "socketpair",
        "bind", "listen", "accept", "accept4",
        "connect",
        "send", "sendto", "sendmsg", "sendmmsg",
        "recv", "recvfrom", "recvmsg", "recvmmsg",
        "setsockopt", "getsockopt",
        "getsockname", "getpeername",
        "shutdown"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Poll/epoll/select",
      "names": [
        "select", "pselect6", "pselect6_time64",
        "poll", "ppoll", "ppoll_time64",
        "epoll_create", "epoll_create1",
        "epoll_ctl", "epoll_wait", "epoll_pwait", "epoll_pwait2"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Signals",
      "names": [
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "rt_sigtimedwait", "rt_sigqueueinfo",
        "signalfd", "signalfd4",
        "kill", "tkill", "tgkill"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Time",
      "names": [
        "clock_gettime", "clock_gettime64",
        "clock_nanosleep", "clock_nanosleep_time64",
        "nanosleep",
        "gettimeofday", "settimeofday",
        "times",
        "time",
        "timerfd_create", "timerfd_gettime", "timerfd_settime",
        "timerfd_gettime64", "timerfd_settime64"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Thread synchronization",
      "names": [
        "futex", "futex_time64", "futex_waitv",
        "set_robust_list", "get_robust_list"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Identity and credentials",
      "names": [
        "getuid", "getgid", "geteuid", "getegid",
        "getresuid", "getresgid",
        "getgroups",
        "setuid", "setgid",
        "setresuid", "setresgid"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "comment": "Misc required by Go runtime",
      "names": [
        "arch_prctl",
        "prctl",
        "sched_yield",
        "sched_getaffinity", "sched_setaffinity",
        "set_tid_address",
        "getrlimit", "setrlimit", "prlimit64",
        "uname",
        "getrandom",
        "rseq"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

## Syscalls to Always Block

Certain syscalls are essentially never needed by application containers and represent significant risk:

```json
{
  "comment": "These should almost never appear in an allowlist",
  "names": [
    "kexec_load",        "kexec_file_load",   // Load new kernel
    "create_module",     "init_module",        // Load kernel modules
    "delete_module",     "finit_module",
    "ptrace",                                  // Process tracing (debugger attach)
    "perf_event_open",                         // Performance monitoring (info leak)
    "bpf",                                     // BPF program loading
    "keyctl",            "add_key",            // Kernel keyring manipulation
    "request_key",
    "mount",             "umount2",            // Filesystem mount/unmount
    "pivot_root",        "chroot",             // Namespace manipulation
    "unshare",           "setns",              // Namespace operations
    "swapon",            "swapoff",            // Swap management
    "reboot",                                  // System reboot
    "syslog",                                  // Kernel message buffer
    "acct",                                    // Process accounting
    "settimeofday",      "adjtimex",           // Time modification
    "clock_adjtime",     "clock_settime",
    "nfsservctl",                              // NFS server control
    "get_kernel_syms",   "query_module",       // Kernel symbol access
    "uselib",                                  // Load shared library
    "lookup_dcookie",                          // Directory entry cache
    "io_uring_setup",    "io_uring_enter",     // io_uring (complex attack surface)
    "io_uring_register"
  ],
  "action": "SCMP_ACT_ERRNO"
}
```

Note: `bpf` and `ptrace` blocking is particularly important for container breakout prevention. If your application genuinely needs `bpf` (e.g., it is itself a monitoring agent), use `SCMP_ACT_ALLOW` with a condition on the `cmd` argument rather than blocking entirely.

## Argument Filtering

seccomp-bpf can filter on syscall arguments, not just syscall numbers. This is useful for allowing a syscall in safe modes while blocking dangerous flags:

```json
{
  "syscalls": [
    {
      "comment": "Allow socket() but only for AF_INET, AF_INET6, AF_UNIX",
      "names": ["socket"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 1,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "comment": "Allow prctl but not PR_SET_SECCOMP (prevent seccomp bypass)",
      "names": ["prctl"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 22,
          "op": "SCMP_CMP_NE"
        }
      ]
    },
    {
      "comment": "Allow clone but not CLONE_NEWUSER (user namespace creation)",
      "names": ["clone"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 268435456,
          "op": "SCMP_CMP_MASKED_EQ",
          "valueTwo": 0
        }
      ]
    }
  ]
}
```

The `CLONE_NEWUSER` flag (value `0x10000000 = 268435456`) is particularly dangerous because user namespaces can be used for container escapes on kernels with CVEs. Blocking it at the seccomp level is defense-in-depth even on patched kernels.

## Go-specific Seccomp Profile

Go applications require a specific set of syscalls. The Go runtime uses:

- `clone3` / `clone` for goroutine threads
- `futex` for scheduler synchronization
- `epoll_*` for the network poller
- `mmap` for heap management
- `getrandom` for `crypto/rand`
- `sigaltstack` for signal handling
- `rseq` (kernel 4.18+) for restartable sequences

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 38,
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "comment": "Go runtime essentials",
      "names": [
        "read", "write", "close",
        "fstat", "mmap", "mprotect", "munmap",
        "rt_sigaction", "rt_sigprocmask",
        "rt_sigreturn",
        "ioctl",
        "access",
        "pipe2",
        "dup3",
        "nanosleep",
        "getpid",
        "socket", "connect", "accept4",
        "sendto", "recvfrom",
        "sendmsg", "recvmsg",
        "bind", "listen",
        "setsockopt", "getsockopt",
        "clone", "clone3",
        "execve",
        "wait4",
        "uname",
        "fcntl",
        "getdents64",
        "gettid",
        "futex",
        "sched_yield",
        "set_tid_address",
        "exit_group",
        "epoll_ctl", "epoll_create1", "epoll_pwait",
        "openat",
        "newfstatat",
        "set_robust_list",
        "prlimit64",
        "arch_prctl",
        "gettimeofday",
        "sigaltstack",
        "getrandom",
        "rseq",
        "getuid", "getgid", "geteuid", "getegid",
        "brk",
        "madvise",
        "prctl"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Test a Go binary against this minimal profile:

```bash
#!/bin/bash
# test-seccomp-profile.sh
PROFILE=$1
BINARY=$2

# Run with the custom profile
docker run --rm \
  --security-opt seccomp=$PROFILE \
  -v $(which $BINARY):/app/binary:ro \
  alpine:latest \
  /app/binary

echo "Exit code: $?"
```

## Kubernetes SeccompProfile Custom Resource

Kubernetes 1.22+ supports the `SeccompProfile` CRD from the Node Feature Discovery or via the kubelet's seccomp directory. The recommended approach uses the `securityContext.seccompProfile` field:

```yaml
# First, create the profile as a ConfigMap or store it on nodes
# Using Kubernetes Security Profiles Operator (SPO) is the recommended approach

# Install the Security Profiles Operator
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Wait for operator readiness
kubectl wait --for=condition=ready pod \
  -l app=security-profiles-operator \
  -n security-profiles-operator \
  --timeout=120s
```

```yaml
# seccomp-profile-go-api.yaml
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: go-api-server
  namespace: production
spec:
  defaultAction: SCMP_ACT_ERRNO
  architectures:
    - SCMP_ARCH_X86_64
  syscalls:
    - action: SCMP_ACT_ALLOW
      names:
        - read
        - write
        - close
        - fstat
        - mmap
        - mprotect
        - munmap
        - rt_sigaction
        - rt_sigprocmask
        - rt_sigreturn
        - openat
        - newfstatat
        - epoll_pwait
        - epoll_ctl
        - epoll_create1
        - accept4
        - recvfrom
        - sendto
        - recvmsg
        - sendmsg
        - socket
        - connect
        - bind
        - listen
        - setsockopt
        - getsockopt
        - getsockname
        - getpeername
        - clone3
        - futex
        - set_robust_list
        - set_tid_address
        - exit_group
        - getpid
        - gettid
        - uname
        - prctl
        - arch_prctl
        - getuid
        - getgid
        - geteuid
        - getegid
        - prlimit64
        - brk
        - madvise
        - getrandom
        - rseq
        - nanosleep
        - clock_gettime
        - clock_nanosleep
        - sigaltstack
        - pipe2
        - dup3
        - fcntl
        - getdents64
        - sched_yield
        - execve
        - wait4
        - ioctl
        - access
```

Apply the profile to your workload:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      securityContext:
        seccompProfile:
          type: Localhost
          localhostProfile: operator/production/go-api-server.json
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
      containers:
        - name: api-server
          image: myrepo/api-server:v1.2.3
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

The Security Profiles Operator copies the profile to each node at the path `<kubelet-seccomp-dir>/operator/<namespace>/<profile-name>.json`.

## Recording Profiles with the SPO

The Security Profiles Operator can record profiles automatically by observing a running workload:

```yaml
# Create a ProfileRecording that captures syscalls from a deployment
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: api-server-recording
  namespace: production
spec:
  kind: SeccompProfile
  recorder: bpf  # Uses eBPF for low-overhead recording
  podSelector:
    matchLabels:
      app: api-server
```

```bash
# After your workload has run through all its operational paths,
# retrieve the generated profile
kubectl get seccompprofile -n production api-server-recording -o yaml

# The profile is also available as a standard SeccompProfile CRD
# ready to apply directly to your deployment
```

## Validation and Testing

### Local Testing with Docker

```bash
#!/bin/bash
# validate-profile.sh - Test a seccomp profile against a container

PROFILE_PATH=$1
IMAGE=$2
CMD=${3:-"/bin/sh -c 'echo test'"}

echo "Testing profile: $PROFILE_PATH"
echo "Against image: $IMAGE"
echo ""

# Test with profile applied
if docker run --rm \
  --security-opt seccomp="$PROFILE_PATH" \
  "$IMAGE" \
  $CMD 2>&1; then
  echo "PASS: Container ran successfully with profile"
else
  EXIT_CODE=$?
  echo "FAIL: Container exited with code $EXIT_CODE"
  echo ""
  echo "Check dmesg for SIGSYS or audit log for seccomp violations:"
  dmesg | tail -20 | grep -i "seccomp\|SIGSYS" || true
  journalctl -k --no-pager | tail -20 | grep -i "seccomp" || true
fi
```

### Regression Testing

When updating application code, verify the seccomp profile still covers all needed syscalls:

```bash
#!/bin/bash
# seccomp-regression-test.sh
# Run the application in audit mode and compare against the expected profile

PROFILE_PATH=$1
AUDIT_TIMEOUT=${2:-60}

echo "Running $AUDIT_TIMEOUT second audit..."

# Run with logging enabled
docker run --rm \
  --security-opt seccomp=unconfined \
  --cap-drop ALL \
  myapp:latest &

APP_PID=$!
sleep $AUDIT_TIMEOUT
kill $APP_PID 2>/dev/null || true
wait $APP_PID 2>/dev/null || true

# Extract observed syscalls from audit log
OBSERVED=$(journalctl -k --no-pager -S "$(date -d "$AUDIT_TIMEOUT seconds ago" +%Y-%m-%d\ %H:%M:%S)" | \
  grep "SECCOMP" | \
  grep -oP "syscall=\K\d+" | \
  sort -u | \
  while read num; do ausyscall x86_64 $num 2>/dev/null || echo "syscall_$num"; done | \
  sort)

# Extract allowed syscalls from profile
ALLOWED=$(jq -r '.syscalls[] | select(.action == "SCMP_ACT_ALLOW") | .names[]' "$PROFILE_PATH" | sort)

# Find any observed syscalls not in the profile
MISSING=$(comm -23 <(echo "$OBSERVED") <(echo "$ALLOWED"))

if [ -z "$MISSING" ]; then
  echo "PASS: All observed syscalls are covered by the profile"
else
  echo "WARN: These syscalls were observed but may not be in the profile:"
  echo "$MISSING"
fi
```

## Common Gotchas

### 1. Missing `clone3` for new runtimes

Go 1.22+ and glibc 2.34+ prefer `clone3` over `clone`. Many older profiles only allow `clone`. Always include both.

### 2. `openat` vs `open`

Modern glibc and Go use `openat` exclusively. The original `open` syscall is rarely needed. If your profile blocks `openat` but allows `open`, container startup will fail immediately.

### 3. The `SCMP_ACT_ERRNO` return value

`SCMP_ACT_ERRNO` returns `ENOSYS` (function not implemented) by default, but this can confuse some applications that interpret `ENOSYS` as "feature not available" and silently degrade. Use `"defaultErrnoRet": 1` (`EPERM`) for clearer error messages, or `SCMP_ACT_KILL_PROCESS` to fail loudly during development.

### 4. Container runtime differences

Docker, containerd (with runc), and gVisor handle seccomp profiles differently. Test your profile against the actual runtime used in production. containerd+runc respects the same JSON format as Docker. gVisor implements its own kernel and may need a different (often simpler) profile.

### 5. Multi-stage builds

If your container has an init system (tini, s6, dumb-init), the init process makes additional syscalls before exec-ing your application. Profile the entire container startup, not just the application binary in isolation.

## Conclusion

A well-crafted seccomp-bpf profile is one of the highest-value container security controls because it operates at the kernel level independently of the container runtime or orchestrator. The investment in profiling your application's actual syscall usage and building a minimal allowlist pays off in reduced attack surface, improved compliance audit trails (seccomp violations are logged to the kernel audit subsystem), and defense against zero-day exploits that depend on obscure syscalls.

The recommended workflow for production: start with the Docker default profile, layer on argument filtering for high-risk syscalls like `clone` and `socket`, deploy to staging with `SCMP_ACT_LOG` as the default action, analyze the audit log for any missing syscalls, then switch to `SCMP_ACT_ERRNO` for production. Use the Kubernetes Security Profiles Operator to manage profile distribution across nodes and automate recording for new services.
