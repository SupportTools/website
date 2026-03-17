---
title: "Linux Container Runtime Internals: runc, crun, and OCI Runtime Specification Deep Dive"
date: 2030-01-31T00:00:00-05:00
draft: false
tags: ["Linux", "Containers", "runc", "crun", "OCI", "Container Runtime", "Security", "Kubernetes"]
categories: ["Linux", "Containers", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into OCI runtime specification implementation: runc lifecycle hooks, crun performance advantages, rootless containers, user namespace mapping, and seccomp default profiles for container security hardening."
more_link: "yes"
url: "/linux-container-runtime-internals-runc-crun-oci-spec/"
---

Every container you run on Kubernetes ultimately executes through an OCI-compliant container runtime. When containerd receives a container creation request, it delegates to an OCI runtime — typically runc or crun — via the OCI Runtime Specification. Understanding what happens at this layer reveals the Linux primitives that make containers possible: namespaces, cgroups, seccomp, capabilities, and user namespace mapping.

This guide dissects the OCI Runtime Specification, compares runc and crun performance characteristics, explains rootless container mechanics, and covers seccomp profile construction for hardened production containers.

<!--more-->

## The Container Stack

Before examining individual components, understand the full stack:

```
kubectl apply / docker run
        ↓
Container Orchestrator (Kubernetes / Docker daemon)
        ↓
High-Level Container Runtime (containerd / CRI-O / podman)
    - Image pulling, overlay filesystem setup, CNI networking
        ↓
OCI Runtime Shim (containerd-shim-runc-v2 / conmon)
    - Keeps container running after high-level runtime exits
        ↓
OCI Runtime (runc / crun / youki / gVisor)
    - Executes OCI runtime spec; creates namespaces, starts process
        ↓
Linux Kernel (namespaces + cgroups + seccomp + capabilities)
```

## The OCI Runtime Specification

The OCI Runtime Specification defines how a conformant runtime must behave. The spec consists of a `config.json` file and a filesystem bundle.

### config.json Structure

```bash
# Extract OCI bundle from a running container (containerd)
# First, find the container's bundle directory
sudo ls /run/containerd/io.containerd.runtime.v2.task/k8s.io/

# Export to examine the spec
CONTAINER_ID="<container-id>"
sudo cat /run/containerd/io.containerd.runtime.v2.task/k8s.io/${CONTAINER_ID}/config.json | \
  python3 -m json.tool | head -200
```

### Complete config.json Example

```json
{
  "ociVersion": "1.1.0",
  "process": {
    "terminal": false,
    "user": {
      "uid": 1000,
      "gid": 1000,
      "additionalGids": [1001, 1002]
    },
    "args": ["/usr/bin/myapp", "--config", "/etc/myapp/config.yaml"],
    "env": [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "TERM=xterm",
      "HOME=/home/app"
    ],
    "cwd": "/app",
    "capabilities": {
      "bounding": ["CAP_NET_BIND_SERVICE"],
      "effective": ["CAP_NET_BIND_SERVICE"],
      "permitted": ["CAP_NET_BIND_SERVICE"],
      "ambient": []
    },
    "rlimits": [
      {"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536},
      {"type": "RLIMIT_NPROC", "hard": 1024, "soft": 1024}
    ],
    "noNewPrivileges": true,
    "apparmorProfile": "docker-default",
    "selinuxLabel": "system_u:system_r:container_t:s0:c123,c456",
    "seccompProfile": {
      "defaultAction": "SCMP_ACT_ERRNO",
      "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86"],
      "syscalls": [
        {
          "names": ["read", "write", "close", "fstat", "mmap", "brk"],
          "action": "SCMP_ACT_ALLOW"
        }
      ]
    }
  },
  "root": {
    "path": "rootfs",
    "readonly": true
  },
  "hostname": "my-container",
  "mounts": [
    {
      "destination": "/proc",
      "type": "proc",
      "source": "proc"
    },
    {
      "destination": "/sys",
      "type": "sysfs",
      "source": "sysfs",
      "options": ["nosuid", "noexec", "nodev", "ro"]
    },
    {
      "destination": "/tmp",
      "type": "tmpfs",
      "source": "tmpfs",
      "options": ["nosuid", "strictatime", "mode=1777", "size=65536k"]
    }
  ],
  "linux": {
    "uidMappings": [
      {"containerID": 0, "hostID": 100000, "size": 65536}
    ],
    "gidMappings": [
      {"containerID": 0, "hostID": 100000, "size": 65536}
    ],
    "resources": {
      "devices": [
        {"allow": false, "access": "rwm"}
      ],
      "memory": {
        "limit": 536870912,
        "reservation": 268435456,
        "swap": 536870912,
        "swappiness": 0
      },
      "cpu": {
        "shares": 1024,
        "quota": 100000,
        "period": 100000,
        "cpus": "0-3"
      },
      "pids": {"limit": 512}
    },
    "cgroupsPath": "/kubepods/burstable/pod12345/container-id",
    "namespaces": [
      {"type": "pid"},
      {"type": "network"},
      {"type": "ipc"},
      {"type": "uts"},
      {"type": "mount"},
      {"type": "user"}
    ],
    "seccomp": {
      "defaultAction": "SCMP_ACT_ERRNO",
      "architectures": ["SCMP_ARCH_X86_64"],
      "syscalls": []
    },
    "maskedPaths": [
      "/proc/acpi",
      "/proc/kcore",
      "/proc/keys",
      "/proc/latency_stats",
      "/proc/timer_list",
      "/proc/timer_stats",
      "/proc/sched_debug",
      "/proc/scsi",
      "/sys/firmware"
    ],
    "readonlyPaths": [
      "/proc/asound",
      "/proc/bus",
      "/proc/fs",
      "/proc/irq",
      "/proc/sys",
      "/proc/sysrq-trigger"
    ]
  },
  "hooks": {
    "prestart": [
      {
        "path": "/usr/libexec/oci/prestart-hook",
        "args": ["prestart-hook", "arg1"],
        "env": ["HOOK_ENV=value"]
      }
    ],
    "poststart": [
      {
        "path": "/usr/libexec/oci/poststart-hook",
        "timeout": 5
      }
    ],
    "poststop": [
      {
        "path": "/usr/libexec/oci/cleanup-hook",
        "timeout": 10
      }
    ],
    "createRuntime": [],
    "createContainer": [],
    "startContainer": []
  }
}
```

## runc: The Reference Implementation

runc is the C-implemented reference OCI runtime, originally extracted from Docker. Every major container platform uses runc or a compatible implementation.

### runc Container Lifecycle

```
runc create    → Initialize namespaces, mount filesystem, apply seccomp
runc start     → Execute container process (exec into created namespace)
runc state     → Query container state (created/running/stopped)
runc kill      → Send signal to container process
runc delete    → Clean up namespaces, cgroups, filesystem
```

### Direct runc Usage

```bash
# Create an OCI bundle manually
mkdir -p /tmp/container-bundle/rootfs

# Extract a minimal root filesystem
docker export $(docker create alpine) | tar xf - -C /tmp/container-bundle/rootfs

# Generate a spec template
cd /tmp/container-bundle
runc spec

# Review and modify config.json
vim config.json

# Create container (namespaces set up, process not yet started)
sudo runc create mycontainer --bundle /tmp/container-bundle

# Start the container process
sudo runc start mycontainer

# Inspect state
sudo runc state mycontainer
# {
#   "ociVersion": "1.1.0",
#   "id": "mycontainer",
#   "pid": 12345,
#   "status": "running",
#   "bundle": "/tmp/container-bundle",
#   "rootfs": "/tmp/container-bundle/rootfs",
#   "created": "2026-03-17T00:00:00Z"
# }

# Execute command in running container
sudo runc exec mycontainer /bin/sh -c "cat /etc/os-release"

# Delete when done
sudo runc kill mycontainer SIGTERM
sudo runc delete mycontainer
```

### runc Lifecycle Hooks

Hooks allow running external programs at specific container lifecycle points:

```bash
#!/bin/bash
# /usr/libexec/oci/prestart-hook
# Runs after namespace setup but before container process starts
# stdin receives the container state JSON

STATE=$(cat)
CONTAINER_ID=$(echo $STATE | jq -r '.id')
BUNDLE=$(echo $STATE | jq -r '.bundle')

echo "prestart hook: container=$CONTAINER_ID" >&2

# Common use cases:
# - Configure network (CNI plugins use createRuntime/createContainer hooks)
# - Set up /dev devices
# - Configure seccomp profiles dynamically
# - Register with service mesh

# Must exit 0 for container to proceed
exit 0
```

```bash
#!/bin/bash
# /usr/libexec/oci/poststop-hook
# Runs after container stops
# Used for: cleanup, deregistration, audit logging

STATE=$(cat)
CONTAINER_ID=$(echo $STATE | jq -r '.id')
BUNDLE=$(echo $STATE | jq -r '.bundle')

# Log container stop event for audit trail
echo "$(date -u): container $CONTAINER_ID stopped" >> /var/log/container-audit.log

exit 0
```

### Hook Types in OCI 1.1

| Hook Type | Trigger Point | Namespace State |
|---|---|---|
| `createRuntime` | After runtime environment created | No container namespaces yet |
| `createContainer` | After container namespaces created | Container namespaces exist, process not started |
| `startContainer` | Just before container process exec | Runs inside container namespaces |
| `prestart` | Deprecated equivalent of `createRuntime` + `createContainer` |  |
| `poststart` | After container process starts | Container running |
| `poststop` | After container process stops | Container stopped |

## crun: Performance and Flexibility

crun is a C-based OCI runtime written by Red Hat with significantly lower memory footprint and startup time than runc:

### Performance Comparison

```bash
# Benchmark container startup time: runc vs crun
# Using hyperfine for precise measurements
hyperfine \
  --warmup 10 \
  'sudo runc run --bundle /tmp/alpine-bundle bench-runc' \
  'sudo crun run --bundle /tmp/alpine-bundle bench-crun'

# Typical results:
# runc:  mean 45ms ± 5ms
# crun:  mean 15ms ± 2ms  (3x faster)

# Memory usage comparison
# runc binary: ~8MB RAM for a minimal container
# crun binary:  ~400KB RAM for a minimal container
```

### Installing crun

```bash
# Ubuntu/Debian
sudo apt install crun

# Build from source (for latest features)
git clone https://github.com/containers/crun
cd crun
./autogen.sh
./configure --prefix=/usr --sysconfdir=/etc
make
sudo make install

# Verify
crun --version
# crun version 1.15
# spec: 1.0.0
# +SYSTEMD +SELINUX +APPARMOR +CAP +SECCOMP +EBPF +CRIU +WASM:wasmedge
```

### Configuring containerd to Use crun

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd]
  default_runtime_name = "crun"

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.crun]
    runtime_type = "io.containerd.runc.v2"

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.crun.options]
      BinaryName = "/usr/bin/crun"

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
    runtime_type = "io.containerd.runc.v2"

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
      BinaryName = "/usr/bin/runc"
```

### WebAssembly Support in crun

crun supports running WebAssembly modules alongside OCI containers:

```bash
# crun can run WASM modules with wasmedge/wasmtime handler
# This enables lightweight WASM workloads without full container overhead

# Example: WASM container using crun+WasmEdge
cat > /tmp/wasm-bundle/config.json << 'EOF'
{
  "ociVersion": "1.0.0",
  "annotations": {
    "module.wasm.image/variant": "compat-smart"
  },
  "process": {
    "args": ["hello.wasm"]
  }
}
EOF
```

## Rootless Containers

Rootless containers run without root privileges on the host, significantly reducing the attack surface:

### How Rootless Works

```bash
# Non-root user can create user namespaces
unshare --user --map-root-user sh
# Inside: whoami = root, but this "root" maps to your UID on the host

# Verify: the "root" inside maps to real user outside
echo $$  # Get the unshare PID
cat /proc/$$/uid_map  # From outside the namespace
# 0  1000  1  (container UID 0 → host UID 1000, size 1)
```

### UID/GID Mapping Configuration

```bash
# Enable user namespace support (usually enabled by default)
sysctl kernel.unprivileged_userns_clone
# kernel.unprivileged_userns_clone = 1

# Configure /etc/subuid and /etc/subgid for rootless container users
# Format: username:start_uid:count
grep myuser /etc/subuid
# myuser:100000:65536

grep myuser /etc/subgid
# myuser:100000:65536

# This means myuser can use UIDs 100000-165535 for container UID 1-65535
```

### Rootless with podman

```bash
# podman uses rootless by default
podman run --rm -it alpine sh

# Inspect namespace mappings
podman unshare cat /proc/self/uid_map
# 0        1000           1
# 1      100000       65535

# UIDs inside container:
# 0 (root) → host UID 1000
# 1-65535  → host UIDs 100001-165535
```

### Rootless Kubernetes with rootless containerd

```bash
# Install rootless containerd
mkdir -p ~/.local/bin
wget -O ~/.local/bin/containerd-rootless-setuptool.sh \
  https://raw.githubusercontent.com/containerd/nerdctl/main/extras/rootless/containerd-rootless-setuptool.sh
chmod +x ~/.local/bin/containerd-rootless-setuptool.sh

~/.local/bin/containerd-rootless-setuptool.sh install

# Start rootless containerd
containerd-rootless-setuptool.sh nsenter -- containerd

# Configure kubelet for rootless
# --container-runtime-endpoint=unix:///run/user/$UID/containerd/containerd.sock
```

### OCI Spec for Rootless Containers

```json
{
  "linux": {
    "uidMappings": [
      {
        "containerID": 0,
        "hostID": 1000,
        "size": 1
      },
      {
        "containerID": 1,
        "hostID": 100000,
        "size": 65535
      }
    ],
    "gidMappings": [
      {
        "containerID": 0,
        "hostID": 1000,
        "size": 1
      },
      {
        "containerID": 1,
        "hostID": 100000,
        "size": 65535
      }
    ],
    "namespaces": [
      {"type": "user"},
      {"type": "pid"},
      {"type": "network"},
      {"type": "mount"},
      {"type": "ipc"},
      {"type": "uts"}
    ]
  }
}
```

## Seccomp: Syscall Filtering

Seccomp (Secure Computing Mode) restricts which system calls a process can make. The default Docker/Kubernetes seccomp profile blocks ~44 dangerous syscalls.

### Docker Default Seccomp Profile Structure

```bash
# Download Docker's default seccomp profile
curl -o /tmp/default-seccomp.json \
  https://raw.githubusercontent.com/moby/moby/master/profiles/seccomp/default.json

# Count allowed syscalls
jq '.syscalls[] | select(.action == "SCMP_ACT_ALLOW") | .names[]' \
  /tmp/default-seccomp.json | wc -l
# ~315 allowed syscalls out of ~440+ total

# Check specific syscall
jq '.syscalls[] | select(.names[] | contains("ptrace"))' \
  /tmp/default-seccomp.json
```

### Custom Seccomp Profile for Minimal Container

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86"],
  "syscalls": [
    {
      "names": [
        "accept4", "bind", "brk", "clock_gettime", "clone",
        "close", "connect", "dup", "dup2", "epoll_create1",
        "epoll_ctl", "epoll_pwait", "epoll_wait", "execve",
        "exit", "exit_group", "faccessat", "fchmod", "fcntl",
        "fdatasync", "fstat", "fstatfs", "fsync", "ftruncate",
        "futex", "getcwd", "getdents64", "getegid", "geteuid",
        "getgid", "getpid", "getppid", "getrandom", "getrlimit",
        "getsockname", "getsockopt", "gettid", "gettimeofday",
        "getuid", "ioctl", "kill", "lseek", "lstat", "madvise",
        "mkdir", "mmap", "mprotect", "munmap", "nanosleep",
        "newfstatat", "open", "openat", "pipe2", "poll",
        "prctl", "pread64", "pwrite64", "read", "readlink",
        "recvfrom", "recvmsg", "rename", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "sched_getaffinity",
        "sched_yield", "sendmsg", "sendto", "set_robust_list",
        "set_tid_address", "setgid", "setgroups", "setsockopt",
        "setuid", "sigaltstack", "socket", "stat", "statfs",
        "tgkill", "umask", "unlink", "uname", "wait4",
        "write", "writev"
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

### Building Syscall Profiles with strace

```bash
# Profile syscalls used by your application
strace -f -e trace=all -o /tmp/syscalls.txt ./myapp --config /etc/myapp/config.yaml &
sleep 10  # Run under load
kill %1

# Extract unique syscall names
grep -oP '^\d+ +\K\w+(?=\()' /tmp/syscalls.txt | \
  sort -u | \
  grep -v -E '^(---|\+\+\+)' > /tmp/required-syscalls.txt

cat /tmp/required-syscalls.txt

# Use oci-seccomp-bpf-hook for automatic profile generation
# (containerizes the profiling process)
podman run \
  --annotation io.containers.trace-syscall=of:/tmp/profile.json \
  yourimage:latest \
  ./myapp --config /etc/myapp/config.yaml
```

### Applying Seccomp to Kubernetes Pods

```yaml
# pod-with-seccomp.yaml
apiVersion: v1
kind: Pod
metadata:
  name: hardened-app
  namespace: production
spec:
  securityContext:
    # Use runtime default (Docker default profile equivalent)
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      image: yourorg/myapp:v1.2.3
      securityContext:
        # Override with custom profile (must be present on node at /var/lib/kubelet/seccomp/)
        seccompProfile:
          type: Localhost
          localhostProfile: profiles/myapp-seccomp.json
        runAsNonRoot: true
        runAsUser: 1000
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
          add:
            - NET_BIND_SERVICE
        readOnlyRootFilesystem: true
```

### Distributing Custom Seccomp Profiles via DaemonSet

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
      app: seccomp-distributor
  template:
    spec:
      initContainers:
        - name: copy-profiles
          image: yourorg/seccomp-profiles:latest
          command:
            - sh
            - -c
            - |
              mkdir -p /host-seccomp/profiles
              cp /profiles/*.json /host-seccomp/profiles/
              echo "Profiles installed: $(ls /host-seccomp/profiles/)"
          volumeMounts:
            - name: seccomp-dir
              mountPath: /host-seccomp
      containers:
        - name: noop
          image: gcr.io/distroless/static:latest
          command: ["/pause"]
      volumes:
        - name: seccomp-dir
          hostPath:
            path: /var/lib/kubelet/seccomp
            type: DirectoryOrCreate
```

## Linux Capabilities in Containers

Capabilities split root privileges into discrete units. Containers should drop all capabilities and add only what they need:

```bash
# View all available capabilities
capsh --print

# Check which capabilities a running container has
PID=$(docker inspect --format '{{.State.Pid}}' mycontainer)
cat /proc/$PID/status | grep Cap
# CapInh: 0000000000000000
# CapPrm: 00000000000004a0  (CAP_CHOWN, CAP_NET_BIND_SERVICE, CAP_SETUID, etc.)
# CapEff: 00000000000004a0
# CapBnd: 00000000000004a0
# CapAmb: 0000000000000000

# Decode capability bitmask
capsh --decode=00000000000004a0
```

### Minimum Required Capabilities by Workload

```bash
# Web server (Go, nginx, etc.)
# Needs: none (if using port > 1024) or NET_BIND_SERVICE for port 80/443
Capabilities drop: ALL
Capabilities add: (none) or NET_BIND_SERVICE

# Java application with JVM
# JVM needs: nothing by default with modern JVM
Capabilities drop: ALL
Capabilities add: (none)

# Network monitoring agent (capturing packets)
Capabilities drop: ALL
Capabilities add: NET_ADMIN, NET_RAW

# Database (writing to /var/lib/postgresql)
Capabilities drop: ALL
Capabilities add: (none, if files owned by UID matching container user)

# syslog/audit daemon (reading kernel ring buffer)
Capabilities drop: ALL
Capabilities add: SYS_ADMIN (or SYSLOG)
```

## Comparing Runtime Features

```bash
# Feature comparison: runc vs crun vs youki
# runc: reference impl, most stable, C-based, 8MB
# crun: production-ready, faster, C-based, 400KB, WASM support
# youki: Rust-based, memory-safe, newer, growing ecosystem

# Check which runtime containerd is using
ctr --namespace k8s.io containers info <container-id> | grep runtime

# Switch runtime per-pod in Kubernetes via RuntimeClass
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: crun
handler: crun
---
apiVersion: v1
kind: Pod
metadata:
  name: fast-startup-app
spec:
  runtimeClassName: crun   # Use crun for this pod
  containers:
    - name: app
      image: yourorg/app:latest
```

## Key Takeaways

Understanding the OCI runtime layer clarifies the security model of all Linux containers:

1. **Namespaces provide isolation, not security**: Network, PID, mount, UTS, and IPC namespaces isolate container processes from each other and the host, but a privileged container can still break out. Security comes from capabilities, seccomp, and AppArmor/SELinux.

2. **crun is ready for production**: For Kubernetes nodes where container startup latency matters (serverless, spot instances with rapid scaling), crun's 3x lower startup time and 20x lower memory footprint are significant advantages over runc.

3. **Rootless containers eliminate privilege escalation vectors**: Running containerd and all containers as non-root eliminates entire classes of container escape vulnerabilities that require host root to exploit.

4. **Seccomp default profile is not minimal**: Docker's default seccomp profile allows ~315 syscalls. A hardened application profile allows 50-80. Build application-specific profiles using strace to minimize attack surface.

5. **capabilities drop: ALL must be the default**: Never run containers with the default capability set. Always explicitly add only the capabilities required, with `drop: ALL` as the starting point.

6. **OCI hooks are the right CNI/CSI integration point**: The `createRuntime` and `createContainer` hooks run before the container process starts, making them the correct integration point for network setup (CNI) and device configuration.

7. **The OCI spec is the contract, not the implementation**: The same config.json works with runc, crun, youki, and gVisor. Switching OCI runtimes does not require changing application code or Kubernetes manifests.
