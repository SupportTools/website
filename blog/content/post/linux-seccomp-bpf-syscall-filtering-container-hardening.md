---
title: "Linux seccomp-BPF: Syscall Filtering, Container Hardening, libseccomp, and Audit Mode"
date: 2031-12-27T00:00:00-05:00
draft: false
tags: ["Linux", "seccomp", "Security", "Containers", "BPF", "Kernel", "Hardening"]
categories:
- Linux
- Security
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux seccomp-BPF syscall filtering: understanding the BPF filter engine, writing seccomp profiles, hardening containers with custom profiles, using libseccomp, and leveraging audit mode to develop profiles safely."
more_link: "yes"
url: "/linux-seccomp-bpf-syscall-filtering-container-hardening/"
---

Seccomp (Secure Computing Mode) is the Linux kernel's syscall filtering mechanism and one of the most effective tools for reducing the attack surface of containerized workloads. Despite being available since kernel 2.6.12 (basic mode) and 3.5 (BPF mode), seccomp remains underutilized in production environments, often because teams treat it as a black box. This guide demystifies seccomp-BPF from first principles: how the BPF filter engine processes syscalls, how to write and validate profiles using libseccomp and raw BPF, how to generate profiles for real workloads using audit mode, and how to apply profiles to containers in Kubernetes with enforcement and monitoring.

<!--more-->

# Linux seccomp-BPF: Syscall Filtering and Container Hardening

## Section 1: How seccomp-BPF Works

### The Classic seccomp Mode

The original seccomp mode (activated with `prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT)`) allows only four syscalls: `read`, `write`, `exit`, and `sigreturn`. It is too restrictive for any real application.

### The BPF Extension

seccomp-BPF extends the original mechanism by allowing a Berkeley Packet Filter program to inspect the `seccomp_data` structure populated by the kernel for each syscall. The structure is:

```c
struct seccomp_data {
    int   nr;                /* syscall number */
    __u32 arch;              /* AUDIT_ARCH_* value (see <linux/audit.h>) */
    __u64 instruction_pointer; /* CPU IP at time of syscall */
    __u64 args[6];           /* up to 6 syscall arguments */
};
```

A seccomp filter program returns one of several actions:

| Action                   | Numeric Value | Behavior |
|--------------------------|---------------|----------|
| `SECCOMP_RET_ALLOW`      | `0x7fff0000`  | Allow the syscall |
| `SECCOMP_RET_ERRNO`      | `0x00050000`  | Return -errno to userspace |
| `SECCOMP_RET_TRAP`       | `0x00030000`  | Send SIGSYS to the thread |
| `SECCOMP_RET_KILL_THREAD`| `0x00000000`  | Kill the current thread |
| `SECCOMP_RET_KILL_PROCESS`| `0x80000000` | Kill the entire process |
| `SECCOMP_RET_LOG`        | `0x7ffc0000`  | Log and allow |
| `SECCOMP_RET_TRACE`      | `0x7ff00000`  | Notify a ptracer |
| `SECCOMP_RET_USER_NOTIF` | `0x7fc00000`  | Notify userspace handler |

### The Execution Pipeline

When a syscall is issued, the kernel:

1. Saves CPU registers to the kernel stack
2. Iterates over all seccomp filters attached to the thread (newest first)
3. Runs each BPF program against `seccomp_data`
4. Takes the lowest-priority (most restrictive) action from all filters
5. Either continues with the syscall or returns the action result

Crucially, seccomp filters are inherited across `fork()` and `execve()`. Once applied, they cannot be removed, only added to (with increasing restrictiveness).

## Section 2: Architecture Detection and the arch Field

One of the most common seccomp bugs is architecture mismatch. On x86_64 systems, a 32-bit process can invoke syscalls via the `int $0x80` instruction, using a completely different syscall table. An attacker can bypass x86_64 filters by calling 32-bit syscalls.

Always validate the architecture:

```c
// Raw BPF approach
struct sock_filter validate_arch[] = {
    /* Load the arch field */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    /* Compare with the expected architecture */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    /* Kill if arch doesn't match */
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
};
```

In libseccomp, this is handled automatically when you specify the target architecture.

## Section 3: Raw seccomp-BPF in C

Understanding the raw BPF instructions helps when debugging complex filters or when libseccomp's overhead is unacceptable.

```c
// seccomp_filter.c — example raw seccomp filter
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define ARRAY_SIZE(arr) (sizeof(arr) / sizeof((arr)[0]))

static int install_filter(void) {
    struct sock_filter filter[] = {
        /* Validate architecture */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        /* Load syscall number */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 offsetof(struct seccomp_data, nr)),

        /* Allow read */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_read, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Allow write */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_write, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Allow exit */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Allow exit_group */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit_group, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Deny all other syscalls with EPERM */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    };

    struct sock_fprog prog = {
        .len    = ARRAY_SIZE(filter),
        .filter = filter,
    };

    /* No new privileges required for SECCOMP_MODE_FILTER */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");
        return -1;
    }

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) == -1) {
        perror("prctl(PR_SET_SECCOMP)");
        return -1;
    }

    return 0;
}

int main(void) {
    if (install_filter() != 0) {
        fprintf(stderr, "Failed to install seccomp filter\n");
        return EXIT_FAILURE;
    }

    /* This write will succeed */
    write(STDOUT_FILENO, "Filter installed\n", 17);

    /* This open will fail with EPERM because it's not in the allowlist */
    int fd = syscall(__NR_openat, AT_FDCWD, "/etc/passwd", O_RDONLY);
    if (fd < 0) {
        write(STDOUT_FILENO, "openat blocked as expected\n", 27);
    }

    return EXIT_SUCCESS;
}
```

Compile and test:

```bash
gcc -o seccomp_filter seccomp_filter.c
./seccomp_filter
# Expected output:
# Filter installed
# openat blocked as expected
```

## Section 4: libseccomp — The High-Level Interface

libseccomp provides a C API and Python/Go bindings for constructing seccomp filters without writing raw BPF.

### Installation

```bash
# Debian/Ubuntu
apt-get install libseccomp-dev libseccomp2 seccomp

# RHEL/CentOS
dnf install libseccomp-devel libseccomp

# Build from source (for latest features)
git clone https://github.com/seccomp/libseccomp.git
cd libseccomp
./autogen.sh
./configure --prefix=/usr/local
make -j$(nproc)
make install
```

### C Example with libseccomp

```c
// seccomp_libseccomp.c
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

int main(void) {
    scmp_filter_ctx ctx;

    /* Initialize with default action: kill process on unknown syscall */
    ctx = seccomp_init(SCMP_ACT_KILL_PROCESS);
    if (!ctx) {
        fprintf(stderr, "seccomp_init failed\n");
        return EXIT_FAILURE;
    }

    /* Add allowed syscalls */
    struct {
        int syscall;
        const char *name;
    } allowed[] = {
        { SCMP_SYS(read),        "read" },
        { SCMP_SYS(write),       "write" },
        { SCMP_SYS(openat),      "openat" },
        { SCMP_SYS(close),       "close" },
        { SCMP_SYS(fstat),       "fstat" },
        { SCMP_SYS(mmap),        "mmap" },
        { SCMP_SYS(mprotect),    "mprotect" },
        { SCMP_SYS(munmap),      "munmap" },
        { SCMP_SYS(brk),         "brk" },
        { SCMP_SYS(rt_sigaction),"rt_sigaction" },
        { SCMP_SYS(rt_sigprocmask),"rt_sigprocmask" },
        { SCMP_SYS(exit_group),  "exit_group" },
        { SCMP_SYS(exit),        "exit" },
        { SCMP_SYS(futex),       "futex" },
        { SCMP_SYS(set_tid_address),"set_tid_address" },
        { SCMP_SYS(set_robust_list),"set_robust_list" },
    };

    for (size_t i = 0; i < sizeof(allowed)/sizeof(allowed[0]); i++) {
        int rc = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, allowed[i].syscall, 0);
        if (rc != 0) {
            fprintf(stderr, "seccomp_rule_add(%s) failed: %d\n",
                    allowed[i].name, rc);
            seccomp_release(ctx);
            return EXIT_FAILURE;
        }
    }

    /* Add a conditional rule: allow write only to fd 1 (stdout) and fd 2 (stderr) */
    seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(write), 1,
                     SCMP_A0(SCMP_CMP_LE, 2));

    /* Load the filter */
    if (seccomp_load(ctx) != 0) {
        fprintf(stderr, "seccomp_load failed\n");
        seccomp_release(ctx);
        return EXIT_FAILURE;
    }

    seccomp_release(ctx);

    write(STDOUT_FILENO, "Filter installed via libseccomp\n", 32);
    return EXIT_SUCCESS;
}
```

```bash
gcc -o seccomp_libseccomp seccomp_libseccomp.c -lseccomp
./seccomp_libseccomp
```

### Exporting a Filter for Inspection

```c
/* Export the BPF bytecode for review */
seccomp_export_bpf(ctx, STDOUT_FILENO);

/* Export as PFC (Pseudo Filter Code) for human-readable review */
seccomp_export_pfc(ctx, STDOUT_FILENO);
```

```bash
# Use seccomp-tools to disassemble
gem install seccomp-tools
./seccomp_libseccomp 2>&1 | seccomp-tools disasm /dev/stdin
```

## Section 5: Docker and Container Seccomp Profiles

### Docker's Default Profile

Docker applies a built-in seccomp profile that allows approximately 300 of the ~400 available syscalls, blocking the most dangerous ones. View it:

```bash
# Extract Docker's default profile
docker inspect --format='{{json .HostConfig.SecurityOpt}}' <container-id>

# Or get the embedded default from the Docker source
curl -sL https://raw.githubusercontent.com/moby/moby/master/profiles/seccomp/default.json | \
  python3 -m json.tool | head -50
```

The profile format uses OCI seccomp spec:

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
      "names": ["accept", "accept4", "access", "adjtimex"],
      "action": "SCMP_ACT_ALLOW",
      "args": [],
      "comment": "Standard allowed syscalls",
      "includes": {},
      "excludes": {}
    },
    {
      "names": ["ptrace"],
      "action": "SCMP_ACT_ALLOW",
      "args": [],
      "includes": {
        "minKernel": "4.8"
      }
    }
  ]
}
```

### Custom Application Profile for a Go HTTP Server

Start with an audit profile to identify required syscalls, then build a restrictive allowlist:

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
    }
  ],
  "syscalls": [
    {
      "names": [
        "accept4",
        "arch_prctl",
        "bind",
        "clone",
        "close",
        "connect",
        "epoll_create1",
        "epoll_ctl",
        "epoll_wait",
        "exit",
        "exit_group",
        "fcntl",
        "fstat",
        "futex",
        "getcwd",
        "getdents64",
        "getpid",
        "getppid",
        "getrandom",
        "getsockname",
        "getsockopt",
        "gettid",
        "listen",
        "madvise",
        "mincore",
        "mmap",
        "mprotect",
        "munmap",
        "nanosleep",
        "newfstatat",
        "openat",
        "pipe2",
        "prctl",
        "pread64",
        "read",
        "readlinkat",
        "recvfrom",
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "sched_getaffinity",
        "sched_yield",
        "sendto",
        "set_robust_list",
        "set_tid_address",
        "setsockopt",
        "sigaltstack",
        "socket",
        "stat",
        "tgkill",
        "uname",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW",
      "comment": "Minimal syscall set for Go HTTP server"
    }
  ]
}
```

Apply with Docker:

```bash
docker run \
  --security-opt seccomp=./go-http-server-profile.json \
  -p 8080:8080 \
  your-go-http-server:latest
```

## Section 6: Audit Mode — Safe Profile Development

Audit mode (`SCMP_ACT_LOG`) logs syscall violations without blocking them. Use this in staging to discover which syscalls your application actually uses before enforcing a restrictive profile.

### Setting Up Audit Logging

```bash
# Ensure auditd is running
systemctl start auditd

# Check audit rules
auditctl -l

# Configure to capture seccomp events
auditctl -a always,exit -F arch=b64 -S all -k seccomp-audit
```

### Running a Container in Audit Mode

Create an audit-only profile:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]
    }
  ],
  "syscalls": []
}
```

```bash
docker run \
  --security-opt seccomp=./audit-only.json \
  --name my-app-audit \
  your-application:latest &

# Exercise all application paths (HTTP requests, background jobs, etc.)
sleep 60
docker stop my-app-audit
```

### Extracting Syscalls from Audit Log

```bash
# Extract syscall names used by the container
ausearch -k seccomp-audit --start recent -m SECCOMP | \
  grep "syscall=" | \
  awk -F'syscall=' '{print $2}' | \
  awk '{print $1}' | \
  sort -u | \
  while read syscall_num; do
    # Convert syscall number to name
    python3 -c "import ctypes; libc = ctypes.CDLL(None); \
      print('${syscall_num}:', '$(python3 -c "import ctypes, os; \
        libc = ctypes.CDLL(None); \
        print(ctypes.c_char_p(libc.strsignal(${syscall_num})).value.decode() \
              if hasattr(libc, 'strsignal') else str(${syscall_num}))")')" \
    2>/dev/null || echo "${syscall_num}"
  done
```

Use `strace` for a more accessible approach during development:

```bash
# Profile a process with strace
strace -f -e trace=all -o /tmp/strace-output.txt \
  ./your-application --config /etc/app/config.yaml &

APP_PID=$!
sleep 30
kill $APP_PID

# Extract unique syscall names
grep -oP '(?<=^[a-z_]+(?=\())([a-z_]+)' /tmp/strace-output.txt | \
  sort -u > /tmp/syscalls-needed.txt

cat /tmp/syscalls-needed.txt
```

### Using oci-seccomp-bpf-hook

For a fully automated approach, use the `oci-seccomp-bpf-hook` container hook:

```bash
# Install
dnf install oci-seccomp-bpf-hook  # RHEL/Fedora

# Use with podman
podman run \
  --annotation io.containers.trace-syscall=of:/tmp/my-profile.json \
  your-application:latest

# The profile is written to /tmp/my-profile.json
cat /tmp/my-profile.json
```

## Section 7: Kubernetes Seccomp Profiles

### Pod-Level seccomp

Kubernetes supports seccomp profiles at the pod and container level since 1.19 (GA in 1.22):

```yaml
# pod-seccomp.yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/go-http-server.json
  containers:
    - name: app
      image: your-app:latest
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 1000
        capabilities:
          drop:
            - ALL
```

The `localhostProfile` path is relative to the kubelet's seccomp profile directory, which defaults to `/var/lib/kubelet/seccomp/`.

### Deploying Profiles to Nodes

Use a DaemonSet to distribute profiles:

```yaml
# seccomp-profile-distributor.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: seccomp-profile-distributor
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: seccomp-profile-distributor
  template:
    metadata:
      labels:
        app: seccomp-profile-distributor
    spec:
      initContainers:
        - name: installer
          image: busybox:1.36
          command:
            - /bin/sh
            - -c
            - |
              mkdir -p /host/seccomp/profiles
              cp /profiles/* /host/seccomp/profiles/
              echo "Profiles installed:"
              ls -la /host/seccomp/profiles/
          volumeMounts:
            - name: host-seccomp
              mountPath: /host/seccomp
            - name: profiles
              mountPath: /profiles
              readOnly: true
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
      volumes:
        - name: host-seccomp
          hostPath:
            path: /var/lib/kubelet/seccomp
            type: DirectoryOrCreate
        - name: profiles
          configMap:
            name: seccomp-profiles
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: seccomp-profiles
  namespace: kube-system
data:
  go-http-server.json: |
    {
      "defaultAction": "SCMP_ACT_ERRNO",
      "defaultErrnoRet": 1,
      "archMap": [
        {
          "architecture": "SCMP_ARCH_X86_64",
          "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]
        }
      ],
      "syscalls": [
        {
          "names": [
            "accept4", "arch_prctl", "bind", "clone", "close",
            "connect", "epoll_create1", "epoll_ctl", "epoll_wait",
            "exit", "exit_group", "fcntl", "fstat", "futex",
            "getcwd", "getdents64", "getpid", "getrandom",
            "getsockname", "getsockopt", "gettid", "listen",
            "madvise", "mmap", "mprotect", "munmap", "nanosleep",
            "newfstatat", "openat", "pipe2", "prctl", "read",
            "readlinkat", "recvfrom", "rt_sigaction",
            "rt_sigprocmask", "rt_sigreturn", "sched_getaffinity",
            "sched_yield", "sendto", "set_robust_list",
            "set_tid_address", "setsockopt", "sigaltstack",
            "socket", "stat", "tgkill", "uname", "write", "writev"
          ],
          "action": "SCMP_ACT_ALLOW"
        }
      ]
    }
```

### Using the Security Profiles Operator

The Security Profiles Operator (SPO) provides a Kubernetes-native way to manage seccomp profiles as CRDs:

```bash
# Install the operator
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Wait for the operator to be ready
kubectl -n security-profiles-operator wait pod \
  -l app=security-profiles-operator \
  --for=condition=Ready \
  --timeout=120s
```

Define a profile as a CRD:

```yaml
# seccomp-profile-crd.yaml
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: go-http-server
  namespace: production
spec:
  defaultAction: SCMP_ACT_ERRNO
  archMap:
    - architecture: SCMP_ARCH_X86_64
      subArchitectures:
        - SCMP_ARCH_X86
        - SCMP_ARCH_X32
  syscalls:
    - action: SCMP_ACT_ALLOW
      names:
        - accept4
        - arch_prctl
        - bind
        - clone
        - close
        - connect
        - epoll_create1
        - epoll_ctl
        - epoll_wait
        - exit
        - exit_group
        - fcntl
        - fstat
        - futex
        - getcwd
        - getrandom
        - getsockname
        - gettid
        - listen
        - madvise
        - mmap
        - mprotect
        - munmap
        - openat
        - prctl
        - read
        - recvfrom
        - rt_sigaction
        - rt_sigprocmask
        - rt_sigreturn
        - sched_getaffinity
        - sendto
        - set_robust_list
        - set_tid_address
        - setsockopt
        - sigaltstack
        - socket
        - stat
        - tgkill
        - write
        - writev
```

Reference the CRD profile in a pod:

```yaml
# pod-with-spo-profile.yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
  namespace: production
  annotations:
    container.seccomp.security.alpha.kubernetes.io/app: "localhost/operator/production/go-http-server.json"
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: operator/production/go-http-server.json
  containers:
    - name: app
      image: your-app:latest
```

## Section 8: Profile Generation with SPO's Recording Mode

The Security Profiles Operator can automatically record syscalls during workload execution:

```yaml
# profile-recording.yaml
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: go-http-server-recording
  namespace: production
spec:
  kind: SeccompProfile
  recorder: bpf
  podSelector:
    matchLabels:
      app: go-http-server
```

Deploy a test workload with the matching label:

```bash
kubectl -n production apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-http-server-test
spec:
  replicas: 1
  selector:
    matchLabels:
      app: go-http-server
  template:
    metadata:
      labels:
        app: go-http-server
    spec:
      containers:
        - name: server
          image: your-app:latest
EOF
```

Exercise the application, then stop recording:

```bash
# Send traffic to exercise all code paths
for i in $(seq 1 100); do
  curl -s http://your-app-service/api/health
  curl -s http://your-app-service/api/users
  curl -s -X POST http://your-app-service/api/users \
    -H "Content-Type: application/json" \
    -d '{"email": "test@example.com", "name": "Test User"}'
done

# Stop the recording by deleting it
kubectl -n production delete profilerecording go-http-server-recording

# The generated profile appears as a SeccompProfile CR
kubectl -n production get seccompprofiles
kubectl -n production get seccompprofile go-http-server-recording-server -o yaml
```

## Section 9: Verifying and Testing Seccomp Profiles

### Using seccomp-tools

```bash
gem install seccomp-tools

# Dump the BPF bytecode of a running process
seccomp-tools dump ./your-application

# Disassemble a profile
seccomp-tools disasm profile.bpf

# Emulate execution of a profile against a syscall
echo "openat: allow" | seccomp-tools asm
```

### Automated Testing with libseccomp's verify

Write a test harness to verify your profile:

```bash
#!/usr/bin/env bash
# test-seccomp-profile.sh
set -euo pipefail

PROFILE="./go-http-server.json"
TEST_BINARY="./seccomp-test-runner"

# Compile the test runner if needed
if [ ! -f "${TEST_BINARY}" ]; then
    cat > /tmp/test_runner.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <syscall_number>\n", argv[0]);
        return EXIT_FAILURE;
    }
    long syscall_num = atol(argv[1]);
    long ret = syscall(syscall_num);
    if (ret == -1 && errno == EPERM) {
        printf("BLOCKED\n");
    } else {
        printf("ALLOWED\n");
    }
    return EXIT_SUCCESS;
}
EOF
    gcc -o "${TEST_BINARY}" /tmp/test_runner.c
fi

# Verify dangerous syscalls are blocked
DANGEROUS_SYSCALLS=("315" "317" "318")  # bpf, add_key, request_key
BLOCKED_COUNT=0

for sc in "${DANGEROUS_SYSCALLS[@]}"; do
    RESULT=$(docker run --rm \
        --security-opt "seccomp=${PROFILE}" \
        -v "${TEST_BINARY}:/test-runner:ro" \
        alpine:3.19 \
        /test-runner "${sc}" 2>/dev/null || echo "KILLED")

    if [ "${RESULT}" = "BLOCKED" ] || [ "${RESULT}" = "KILLED" ]; then
        echo "PASS: syscall ${sc} is blocked"
        BLOCKED_COUNT=$((BLOCKED_COUNT + 1))
    else
        echo "FAIL: syscall ${sc} is NOT blocked"
    fi
done

echo ""
echo "Results: ${BLOCKED_COUNT}/${#DANGEROUS_SYSCALLS[@]} dangerous syscalls blocked"
```

## Section 10: Monitoring and Incident Response

### Prometheus Monitoring for Seccomp Violations

When using `SCMP_ACT_LOG` or audit mode, forward violations to Prometheus:

```bash
# Deploy a log exporter that parses audit logs
# Install node_exporter with textfile collector
# Create a script to parse seccomp violations:
cat > /usr/local/bin/seccomp-metrics.sh << 'EOF'
#!/bin/bash
METRICS_FILE="/var/lib/node_exporter/textfile_collector/seccomp.prom"
VIOLATIONS=$(ausearch -m SECCOMP --start today 2>/dev/null | grep -c "type=SECCOMP" || echo 0)

cat > "${METRICS_FILE}" << METRICS
# HELP seccomp_violations_total Total seccomp violations today
# TYPE seccomp_violations_total counter
seccomp_violations_total ${VIOLATIONS}
METRICS
EOF
chmod +x /usr/local/bin/seccomp-metrics.sh

# Add to cron
echo "* * * * * root /usr/local/bin/seccomp-metrics.sh" > /etc/cron.d/seccomp-metrics
```

### Alert on Unexpected Syscall Patterns

```yaml
# seccomp-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: seccomp-violation-alerts
  namespace: monitoring
spec:
  groups:
    - name: seccomp.violations
      rules:
        - alert: SeccompViolationSpikeDetected
          expr: |
            rate(seccomp_violations_total[5m]) > 10
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High rate of seccomp violations"
            description: "Seccomp violations are occurring at {{ $value | humanize }}/s. This may indicate an attempted exploit."

        - alert: SeccompKillProcessEvent
          expr: |
            increase(seccomp_kill_process_total[1m]) > 0
          labels:
            severity: critical
          annotations:
            summary: "Process killed by seccomp filter"
            description: "A process was killed by seccomp KILL_PROCESS action. Immediate investigation required."
```

### Responding to Seccomp Violations

```bash
# Retrieve violations for a specific container
CONTAINER_ID=$(docker inspect --format='{{.Id}}' my-container)
ausearch -m SECCOMP -i | \
  grep "${CONTAINER_ID:0:12}" | \
  awk '{print $0}' | \
  while IFS= read -r line; do
    # Extract syscall number and convert to name
    SYSCALL=$(echo "$line" | grep -oP 'syscall=\K[0-9]+')
    if [ -n "$SYSCALL" ]; then
        SYSCALL_NAME=$(python3 -c "
import ctypes, os
# Use ausyscall if available
import subprocess
result = subprocess.run(['ausyscall', '$SYSCALL'], capture_output=True, text=True)
print(result.stdout.strip() if result.returncode == 0 else '$SYSCALL')
        " 2>/dev/null || echo "$SYSCALL")
        echo "Blocked syscall: ${SYSCALL_NAME} (${SYSCALL})"
    fi
  done | sort | uniq -c | sort -rn
```

seccomp-BPF is a defense-in-depth tool that, combined with namespace isolation, capabilities dropping, and network policies, dramatically narrows the attack surface available to a compromised container. The key to successful deployment is using audit mode to learn what your applications actually need, then iterating toward a minimal allowlist enforced in production with kernel-level certainty.
