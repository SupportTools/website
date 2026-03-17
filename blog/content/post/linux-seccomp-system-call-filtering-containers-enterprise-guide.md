---
title: "Linux Seccomp: System Call Filtering for Containers"
date: 2029-04-18T00:00:00-05:00
draft: false
tags: ["Linux", "Seccomp", "Security", "Containers", "Kubernetes", "Docker", "OCI"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux seccomp system call filtering for containers, covering BPF programs, audit mode, default Docker and Kubernetes profiles, custom profiles with seccomp-tools and strace analysis, and OCI spec integration."
more_link: "yes"
url: "/linux-seccomp-system-call-filtering-containers-enterprise-guide/"
---

Seccomp (secure computing mode) is a Linux kernel feature that restricts the system calls a process can make. For containers, seccomp filtering is one of the most effective security controls available — it dramatically reduces the attack surface by preventing processes from calling system calls that exploit kernel vulnerabilities, even if the container is fully compromised.

Docker applies a default seccomp profile to all containers. Kubernetes supports custom seccomp profiles. This guide covers everything from the kernel-level BPF machinery through profiling container syscall usage with strace, creating minimal custom profiles, and integrating them into the OCI runtime spec.

<!--more-->

# Linux Seccomp: System Call Filtering for Containers

## Section 1: Seccomp Internals

### How Seccomp Works

Seccomp intercepts system calls at the kernel boundary. When a process makes a syscall, the kernel checks whether a seccomp filter is installed for that process. If so, the filter program (written in cBPF — classic Berkeley Packet Filter) is executed to determine whether to allow or deny the call.

Seccomp operates in two modes:

**SECCOMP_MODE_STRICT**: Only `read`, `write`, `_exit`, and `sigreturn` are allowed. All other syscalls immediately terminate the process with SIGKILL. Used by sandboxed environments that don't need a general container runtime.

**SECCOMP_MODE_FILTER**: A cBPF program is installed as a filter. Each syscall is passed through the filter, which returns an action:
- `SECCOMP_RET_ALLOW`: Allow the syscall
- `SECCOMP_RET_KILL_PROCESS`: Kill the entire process (not just the thread)
- `SECCOMP_RET_KILL_THREAD`: Kill only the offending thread
- `SECCOMP_RET_ERRNO(e)`: Return error code `e` to the caller without executing the syscall
- `SECCOMP_RET_TRAP`: Send SIGSYS to the process
- `SECCOMP_RET_TRACE`: Notify a ptrace tracer
- `SECCOMP_RET_LOG`: Log and allow (for audit mode)
- `SECCOMP_RET_NOTIFY`: Notify a user-space supervisor

### Kernel Requirements

```bash
# Check seccomp support
grep SECCOMP /boot/config-$(uname -r)
# CONFIG_SECCOMP=y
# CONFIG_SECCOMP_FILTER=y

# Check if seccomp is active
cat /proc/$(pgrep nginx | head -1)/status | grep Seccomp
# Seccomp: 2   (0=disabled, 1=strict, 2=filter)

# Check available seccomp actions
cat /proc/sys/kernel/seccomp/actions_avail
# kill_process kill_thread trap errno user_notif trace log allow

# Check logged actions
cat /proc/sys/kernel/seccomp/actions_logged
# kill_process kill_thread trap errno user_notif trace log
```

## Section 2: Default Docker Seccomp Profile

### What the Default Profile Blocks

Docker's default seccomp profile allows ~330 of the ~400+ available syscalls. The blocked calls include:

- `add_key`, `keyctl`, `request_key`: Kernel keyring manipulation
- `acct`: Process accounting
- `bpf`: eBPF program loading (containers shouldn't need to modify BPF programs)
- `clone` with `CLONE_NEWUSER`: Creating user namespaces from within containers
- `create_module`, `delete_module`, `init_module`: Kernel module loading
- `ioperm`, `iopl`: Direct I/O port access
- `mount`: Filesystem mounting (without CAP_SYS_ADMIN)
- `nfsservctl`: NFS server control
- `perf_event_open`: Performance monitoring
- `pivot_root`: Changing the root filesystem
- `reboot`: System reboot
- `settimeofday`, `adjtimex`, `clock_adjtime`: Clock adjustment
- `swapon`, `swapoff`: Swap management
- `syslog`: Reading kernel ring buffer
- `umount2`: Filesystem unmounting
- `unshare`: Creating new namespaces

### Viewing the Default Profile

```bash
# Extract Docker's default seccomp profile
docker run --rm alpine cat /proc/self/status | grep Seccomp
# Seccomp: 2  <- filter mode active

# Get the default profile
docker info --format '{{.SecurityOptions}}' | grep -o 'seccomp=[^,]*'

# View the default profile JSON
curl -sL https://raw.githubusercontent.com/moby/moby/master/profiles/seccomp/default.json | \
  jq '.syscalls[] | select(.action == "SCMP_ACT_ALLOW") | .names[]' | \
  sort | head -50
```

### Running a Container Without Seccomp

```bash
# Disable seccomp (NOT recommended for production)
docker run --rm --security-opt seccomp=unconfined alpine \
  /bin/sh -c "unshare --user --map-root-user id"
# uid=0(root) gid=0(root) groups=0(root)  <- user namespace creation worked

# With default seccomp (blocked)
docker run --rm alpine \
  /bin/sh -c "unshare --user --map-root-user id"
# unshare: unshare failed: Operation not permitted
```

## Section 3: Profiling Container Syscall Usage with strace

### Capturing Syscalls with strace

Before writing a custom seccomp profile, you must understand which syscalls your application actually uses:

```bash
# Run application with strace to capture all syscalls
strace -f -c docker run --rm --security-opt seccomp=unconfined \
  nginx:1.25 nginx -g "daemon off;" &

# Send some test traffic
sleep 5
curl -s http://localhost:80/ >/dev/null
curl -s http://localhost:80/404 >/dev/null

# Stop strace
kill $!

# strace output (summary mode with -c):
# % time     seconds  usecs/call     calls    errors syscall
# ------ ----------- ----------- --------- --------- ----------------
#  25.00    0.000050          50         1           execve
#  20.00    0.000040          40         1           mmap
#  15.00    0.000030          30         1           openat
# ...
```

### Comprehensive Syscall Profiling

```bash
#!/bin/bash
# profile-container-syscalls.sh — comprehensive syscall profiling

CONTAINER_NAME="nginx-profile-test"
OUTPUT_FILE="nginx-syscalls.txt"

# Start container with strace wrapper
docker run -d \
  --name $CONTAINER_NAME \
  --security-opt seccomp=unconfined \
  --entrypoint "" \
  nginx:1.25 \
  strace -f -q \
    -o /tmp/strace-output.txt \
    -e trace=all \
    nginx -g "daemon off;"

# Wait for startup
sleep 3

# Generate representative traffic
for i in $(seq 1 100); do
  curl -s http://localhost:80/ >/dev/null
  curl -s http://localhost:80/api >/dev/null
  curl -s http://localhost:80/static/test.css >/dev/null
done

# Extract unique syscall names from strace output
docker exec $CONTAINER_NAME cat /tmp/strace-output.txt | \
  grep -oP '^\w+(?=\()' | \
  sort -u > $OUTPUT_FILE

echo "Syscalls used by nginx:"
cat $OUTPUT_FILE

# Clean up
docker rm -f $CONTAINER_NAME

echo ""
echo "Total unique syscalls: $(wc -l < $OUTPUT_FILE)"
```

### Using seccomp-tools for Profile Analysis

```bash
# Install seccomp-tools
gem install seccomp-tools

# Disassemble an existing seccomp profile (BPF bytecode)
seccomp-tools dump -p $(pgrep nginx | head -1)

# Emulate a seccomp filter against specific syscalls
seccomp-tools emu \
  -f /path/to/profile.bpf \
  --arch x86_64 \
  openat 0 "/etc/passwd" 0

# Convert between JSON and BPF formats
seccomp-tools compile nginx-profile.json -o nginx-profile.bpf

# Inspect a container's seccomp filter
PID=$(docker inspect --format '{{.State.Pid}}' nginx)
seccomp-tools dump -p $PID
```

### oci-seccomp-bpf-hook for Automated Profiling

```bash
# The OCI seccomp BPF hook can capture syscalls during container runtime
# Install
dnf install oci-seccomp-bpf-hook

# Run container with profiling enabled
podman run \
  --annotation io.containers.trace-syscall=of:/tmp/nginx-syscalls.json \
  --security-opt seccomp=unconfined \
  -d \
  nginx:1.25

# After exercising the container, view the generated profile
cat /tmp/nginx-syscalls.json | jq '.syscalls[].names | length'
```

## Section 4: Creating Custom Seccomp Profiles

### Minimal Profile Structure

A seccomp profile in OCI format is a JSON document:

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
            "names": [
                "accept",
                "accept4",
                "access",
                "arch_prctl",
                "bind",
                "brk",
                "capget",
                "capset",
                "chdir",
                "chmod",
                "chown",
                "clock_gettime",
                "clone",
                "close",
                "connect",
                "dup",
                "dup2",
                "dup3",
                "epoll_create",
                "epoll_create1",
                "epoll_ctl",
                "epoll_pwait",
                "epoll_wait",
                "eventfd2",
                "execve",
                "exit",
                "exit_group",
                "faccessat",
                "fadvise64",
                "fchdir",
                "fchown",
                "fcntl",
                "fdatasync",
                "fstat",
                "fstatfs",
                "fsync",
                "ftruncate",
                "futex",
                "getcwd",
                "getdents64",
                "getegid",
                "geteuid",
                "getgid",
                "getpeername",
                "getpgrp",
                "getpid",
                "getppid",
                "getrandom",
                "getrlimit",
                "getsockname",
                "getsockopt",
                "gettid",
                "gettimeofday",
                "getuid",
                "inotify_add_watch",
                "inotify_init1",
                "inotify_rm_watch",
                "ioctl",
                "kill",
                "lchown",
                "lgetxattr",
                "link",
                "listen",
                "lstat",
                "madvise",
                "mkdir",
                "mmap",
                "mount",
                "mprotect",
                "mremap",
                "munmap",
                "nanosleep",
                "newfstatat",
                "open",
                "openat",
                "pause",
                "pipe",
                "pipe2",
                "poll",
                "ppoll",
                "prctl",
                "pread64",
                "prlimit64",
                "pselect6",
                "read",
                "readlink",
                "readv",
                "recv",
                "recvfrom",
                "recvmsg",
                "rename",
                "rmdir",
                "rt_sigaction",
                "rt_sigpending",
                "rt_sigprocmask",
                "rt_sigreturn",
                "rt_sigsuspend",
                "rt_sigtimedwait",
                "sched_getaffinity",
                "sched_setaffinity",
                "sched_yield",
                "select",
                "send",
                "sendfile",
                "sendmsg",
                "sendto",
                "set_robust_list",
                "set_tid_address",
                "setgid",
                "setgroups",
                "setuid",
                "setsockopt",
                "shutdown",
                "sigaltstack",
                "socket",
                "socketpair",
                "stat",
                "statfs",
                "statx",
                "symlink",
                "tgkill",
                "time",
                "umask",
                "uname",
                "unlink",
                "unlinkat",
                "utimensat",
                "wait4",
                "waitid",
                "write",
                "writev"
            ],
            "action": "SCMP_ACT_ALLOW"
        }
    ]
}
```

### Profile with Conditional Arguments

You can restrict syscalls based on their arguments for more granular control:

```json
{
    "defaultAction": "SCMP_ACT_ERRNO",
    "syscalls": [
        {
            "names": ["socket"],
            "action": "SCMP_ACT_ALLOW",
            "args": [
                {
                    "index": 0,
                    "value": 2,
                    "op": "SCMP_CMP_EQ"
                }
            ]
        }
    ]
}
```

This allows `socket(AF_INET, ...)` (AF_INET=2) but blocks `socket(AF_NETLINK, ...)` and `socket(AF_PACKET, ...)`.

### Restricting clone Flags

Allow `clone` for thread creation but block new namespace creation:

```json
{
    "names": ["clone"],
    "action": "SCMP_ACT_ALLOW",
    "args": [
        {
            "index": 0,
            "value": 2114060288,
            "valueTwo": 2114060288,
            "op": "SCMP_CMP_MASKED_EQ"
        }
    ]
}
```

The mask `0x7E020000` covers `CLONE_NEWNS|CLONE_NEWUTS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWCGROUP`. If any of these bits are set, the mask comparison fails and the syscall is blocked.

### Audit Mode Profile

Start with a permissive audit-mode profile that logs blocked calls without denying them:

```json
{
    "defaultAction": "SCMP_ACT_LOG",
    "architectures": [
        "SCMP_ARCH_X86_64"
    ],
    "syscalls": [
        {
            "names": [
                "reboot",
                "syslog",
                "kexec_load",
                "pivot_root",
                "add_key",
                "keyctl",
                "request_key"
            ],
            "action": "SCMP_ACT_ERRNO"
        }
    ]
}
```

Read the audit log:

```bash
# View seccomp audit events
ausearch -m SECCOMP | tail -20

# Or via auditd
grep "type=SECCOMP" /var/log/audit/audit.log | tail -20

# Decode syscall numbers
ausearch -m SECCOMP --format text | \
  grep "syscall=" | \
  awk -F'syscall=' '{print $2}' | \
  awk '{print $1}' | sort -u | while read num; do
    echo "$num: $(awk 'NR=='"$num"'' /usr/include/asm/unistd_64.h | grep -o '__NR_[a-z_]*' || \
      python3 -c "import ctypes; print(ctypes.CDLL(None).syscall($num))")"
  done
```

## Section 5: Kubernetes Seccomp Integration

### Pod-Level Seccomp in Kubernetes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: seccomp-nginx
  namespace: production
spec:
  securityContext:
    # Apply a custom seccomp profile from the node
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/nginx-custom.json
      # localhostProfile path is relative to kubelet's --seccomp-profile-root
      # Default: /var/lib/kubelet/seccomp/

  containers:
  - name: nginx
    image: nginx:1.25
    securityContext:
      # Container-level seccomp overrides pod-level
      seccompProfile:
        type: RuntimeDefault   # use the container runtime's default profile
      allowPrivilegeEscalation: false
      runAsNonRoot: true
      runAsUser: 1000
      capabilities:
        drop: ["ALL"]
        add: ["NET_BIND_SERVICE"]
```

### Seccomp Profile Types

```yaml
seccompProfile:
  type: Unconfined       # no seccomp filtering (insecure)
  # OR
  type: RuntimeDefault   # container runtime's default (e.g., Docker's default)
  # OR
  type: Localhost
  localhostProfile: profiles/my-app.json
```

### Distributing Custom Profiles to Nodes

Custom profiles must be present on every node before pods can use them. Use a DaemonSet to distribute:

```yaml
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
      initContainers:
      - name: install-profiles
        image: registry.example.com/seccomp-profiles:v1.2.0
        command:
        - /bin/sh
        - -c
        - |
          cp /profiles/*.json /host/var/lib/kubelet/seccomp/profiles/
          echo "Profiles installed:"
          ls /host/var/lib/kubelet/seccomp/profiles/
        volumeMounts:
        - name: profiles
          mountPath: /profiles
        - name: host-seccomp
          mountPath: /host/var/lib/kubelet/seccomp
      containers:
      - name: pause
        image: gcr.io/pause:3.9
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
  nginx-custom.json: |
    {
        "defaultAction": "SCMP_ACT_ERRNO",
        "architectures": ["SCMP_ARCH_X86_64"],
        "syscalls": [
            {
                "names": ["accept4", "bind", "brk", ...],
                "action": "SCMP_ACT_ALLOW"
            }
        ]
    }
```

### Security Profiles Operator (SPO)

The Security Profiles Operator automates seccomp profile management:

```bash
# Install SPO
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Wait for operator to be ready
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=security-profiles-operator \
  -n security-profiles-operator \
  --timeout=120s
```

```yaml
# Create a SeccompProfile resource
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: nginx-profile
  namespace: production
spec:
  defaultAction: SCMP_ACT_ERRNO
  architectures:
  - SCMP_ARCH_X86_64
  syscalls:
  - action: SCMP_ACT_ALLOW
    names:
    - accept4
    - bind
    - brk
    - capget
    - capset
    - chdir
    - clone
    - close
    - connect
    # ... more syscalls
---
# Use in a Pod
apiVersion: v1
kind: Pod
metadata:
  name: nginx-spo
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: operator/production/nginx-profile.json
  containers:
  - name: nginx
    image: nginx:1.25
```

### Recording Syscalls with SPO

```yaml
# Create a ProfileRecording to automatically capture syscalls
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: nginx-recording
  namespace: production
spec:
  kind: SeccompProfile
  recorder: bpf   # use eBPF for low-overhead recording
  # OR: recorder: logs  (uses audit logs)
  podSelector:
    matchLabels:
      app: nginx-profile-target
```

```yaml
# Deploy the target pod with recording label
apiVersion: v1
kind: Pod
metadata:
  name: nginx-recording-target
  namespace: production
  labels:
    app: nginx-profile-target
spec:
  containers:
  - name: nginx
    image: nginx:1.25
    securityContext:
      allowPrivilegeEscalation: false
```

```bash
# Generate traffic to exercise all code paths
curl http://nginx-service/
curl http://nginx-service/api/v1/users
curl http://nginx-service/static/app.js

# Stop recording and get the generated profile
kubectl delete profilerecording nginx-recording -n production

# The SPO automatically creates a SeccompProfile with recorded syscalls
kubectl get seccompprofile nginx-recording-nginx -n production -o yaml
```

## Section 6: OCI Runtime Spec Integration

### Seccomp in the OCI Runtime Spec

The OCI (Open Container Initiative) runtime spec defines how container runtimes apply seccomp:

```json
{
    "ociVersion": "1.1.0",
    "process": {
        "user": {"uid": 1000, "gid": 1000},
        "args": ["/usr/sbin/nginx", "-g", "daemon off;"],
        "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        "cwd": "/"
    },
    "linux": {
        "seccomp": {
            "defaultAction": "SCMP_ACT_ERRNO",
            "defaultErrnoRet": 1,
            "architectures": ["SCMP_ARCH_X86_64"],
            "syscalls": [
                {
                    "names": ["accept4", "bind", "brk"],
                    "action": "SCMP_ACT_ALLOW"
                },
                {
                    "names": ["socket"],
                    "action": "SCMP_ACT_ALLOW",
                    "args": [
                        {
                            "index": 0,
                            "value": 2,
                            "op": "SCMP_CMP_EQ"
                        }
                    ]
                }
            ]
        }
    }
}
```

### Container Runtime Seccomp Support

```bash
# Check if containerd supports seccomp
containerd config dump 2>/dev/null | grep -i seccomp

# Check if CRI-O supports seccomp
crio config 2>/dev/null | grep -i seccomp

# Verify seccomp is applied to a running container
PID=$(crictl inspect --output go-template \
  --template '{{.info.pid}}' \
  $CONTAINER_ID 2>/dev/null)

cat /proc/$PID/status | grep Seccomp
# Seccomp: 2
```

## Section 7: Testing and Verifying Profiles

### Testing a Seccomp Profile

```bash
#!/bin/bash
# test-seccomp-profile.sh — test that a profile blocks expected syscalls

PROFILE_PATH="$1"
IMAGE="$2"

if [ -z "$PROFILE_PATH" ] || [ -z "$IMAGE" ]; then
  echo "Usage: $0 <profile.json> <image>"
  exit 1
fi

# Test 1: Basic container startup
echo "Test 1: Container starts successfully..."
if docker run --rm \
  --security-opt seccomp=$PROFILE_PATH \
  $IMAGE echo "startup ok" 2>&1 | grep -q "startup ok"; then
  echo "PASS"
else
  echo "FAIL: Container failed to start"
  exit 1
fi

# Test 2: Verify reboot is blocked
echo "Test 2: reboot syscall is blocked..."
if docker run --rm \
  --security-opt seccomp=$PROFILE_PATH \
  $IMAGE /bin/sh -c 'syscall_test 169' 2>&1 | grep -qiE "permit|not allowed|operation not permitted"; then
  echo "PASS: reboot blocked"
else
  echo "WARN: Could not verify reboot blocking (test tool may not be available)"
fi

# Test 3: Verify create user namespace is blocked
echo "Test 3: user namespace creation is blocked..."
if ! docker run --rm \
  --security-opt seccomp=$PROFILE_PATH \
  $IMAGE /bin/sh -c "unshare --user id" 2>&1 | grep -q "uid=0"; then
  echo "PASS: user namespace creation blocked"
else
  echo "FAIL: user namespace creation NOT blocked"
fi

echo "All tests passed for profile: $PROFILE_PATH"
```

### Using syscall_test Tool

```c
// syscall_test.c — minimal tool to test specific syscall numbers
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <errno.h>
#include <string.h>

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <syscall_number>\n", argv[0]);
        return 1;
    }

    long nr = atol(argv[1]);
    long ret = syscall(nr);

    if (ret == -1 && errno == EPERM) {
        printf("syscall %ld: BLOCKED (EPERM)\n", nr);
    } else if (ret == -1 && errno == ENOSYS) {
        printf("syscall %ld: NOT IMPLEMENTED\n", nr);
    } else {
        printf("syscall %ld: ALLOWED (ret=%ld, errno=%d %s)\n",
               nr, ret, errno, strerror(errno));
    }
    return 0;
}
```

## Section 8: Production Hardening Recommendations

### Defense in Depth with Multiple Controls

Seccomp should be part of a layered security model:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hardened-app
  namespace: production
spec:
  securityContext:
    # Seccomp: restrict syscalls
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/myapp.json
    # Run as non-root
    runAsNonRoot: true
    runAsUser: 10000
    runAsGroup: 10000
    # Read-only root filesystem
    fsGroup: 10000

  containers:
  - name: app
    image: registry.example.com/myapp:v1.0.0
    securityContext:
      # Capabilities: drop all, add only what's needed
      capabilities:
        drop: ["ALL"]
        add: ["NET_BIND_SERVICE"]  # if binding port < 1024
      # No privilege escalation
      allowPrivilegeEscalation: false
      # Read-only filesystem
      readOnlyRootFilesystem: true
      # Seccomp per container (overrides pod-level)
      seccompProfile:
        type: Localhost
        localhostProfile: profiles/myapp-container.json
    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: logs
      mountPath: /var/log/app

  volumes:
  - name: tmp
    emptyDir: {}
  - name: logs
    emptyDir: {}
```

### Common Mistakes to Avoid

**Mistake 1: Using SCMP_ACT_KILL without testing**

```json
// Dangerous without testing: instant SIGKILL on unexpected syscalls
// means debugging is very difficult
{
    "defaultAction": "SCMP_ACT_KILL",
    ...
}

// Better for production: use SCMP_ACT_ERRNO to get error propagation
{
    "defaultAction": "SCMP_ACT_ERRNO",
    "defaultErrnoRet": 1,  // EPERM
    ...
}
```

**Mistake 2: Profile doesn't include all architectures**

```json
// Wrong: x86-only profile will fail on ARM64 nodes
{
    "architectures": ["SCMP_ARCH_X86_64"],
    ...
}

// Correct: include all architectures used in your cluster
{
    "architectures": [
        "SCMP_ARCH_X86_64",
        "SCMP_ARCH_AARCH64",
        "SCMP_ARCH_ARM"
    ],
    ...
}
```

**Mistake 3: Not testing with actual production traffic**

A profile that works in a dev environment may block syscalls triggered by production load patterns. Always capture syscalls under realistic load before finalizing profiles.

### Monitoring Seccomp in Production

```bash
# Alert on seccomp violations via audit daemon
cat >> /etc/audit/rules.d/seccomp.rules << 'EOF'
-a always,exit -F arch=b64 -S seccomp -k seccomp_violation
EOF

augenrules --load

# Create Prometheus exporter for seccomp audit events
# (using audit2metrics or custom script)

# Monitor seccomp denials in container runtime logs
journalctl -u containerd | grep -i "seccomp\|blocked" | tail -20
```

```yaml
# Falco rule for seccomp violation detection
- rule: Seccomp Profile Violation
  desc: Container process made a blocked syscall
  condition: >
    evt.type = seccomp and
    container.name != "" and
    not (ka.user.name = "system:serviceaccount:kube-system:*")
  output: >
    Seccomp violation in container
    (user=%ka.user.name container=%container.name
     image=%container.image.repository
     syscall=%evt.arg.syscall)
  priority: WARNING
  tags: [container, seccomp, security]
```

## Summary

Seccomp is a powerful kernel-level security control that significantly reduces the attack surface of containers by restricting system call access. The key workflow for production deployment is:

1. Run containers with `SCMP_ACT_LOG` default action to capture all syscalls without blocking
2. Use strace, SPO's eBPF recorder, or `oci-seccomp-bpf-hook` to build a baseline syscall list
3. Start from Docker's default profile and remove syscalls not used by your application
4. Test the custom profile with `SCMP_ACT_ERRNO` before switching to `SCMP_ACT_KILL`
5. Deploy profiles to nodes via DaemonSet or Security Profiles Operator
6. Reference profiles in Pod specs via `seccompProfile.type: Localhost`
7. Monitor audit logs and container runtime logs for unexpected violations

Combined with capability dropping (`capabilities.drop: ["ALL"]`), non-root user execution, and read-only root filesystems, seccomp forms a critical layer in a defense-in-depth container security architecture that makes container escape attacks substantially more difficult.
