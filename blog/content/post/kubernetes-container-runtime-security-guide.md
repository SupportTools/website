---
title: "Kubernetes Container Runtime Security: gVisor, Kata Containers, and Seccomp Profiles"
date: 2027-05-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "gVisor", "Kata Containers", "Seccomp", "Container Runtime"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to hardening Kubernetes container runtimes using gVisor, Kata Containers, seccomp profiles, AppArmor, and Falco for enterprise workload isolation."
more_link: "yes"
url: "/kubernetes-container-runtime-security-guide/"
---

Container security in Kubernetes extends far beyond network policies and RBAC. The container runtime itself represents the last line of defense between workloads and the host kernel. Misconfigurations at this layer — overly permissive syscall access, missing seccomp profiles, or shared kernel namespaces — have led to some of the most severe container escapes seen in production environments. This guide covers the full spectrum of runtime security options available in modern Kubernetes clusters, from kernel namespace isolation through hardware-virtualized runtimes, with practical configurations for each approach.

<!--more-->

## Container Isolation Fundamentals

### The Linux Kernel Isolation Stack

Every container running on a Linux host shares the host kernel. Unlike virtual machines, containers rely entirely on kernel features to create the illusion of isolation. Understanding this stack is prerequisite to making informed runtime security decisions.

The isolation stack has five primary layers:

**Linux Namespaces** provide resource visibility isolation. Each namespace type controls what a process can see:

- `pid`: Process ID isolation — container processes cannot see host PIDs
- `net`: Network stack isolation — separate interfaces, routing tables, firewall rules
- `mnt`: Mount point isolation — separate filesystem view
- `uts`: Hostname and domain name isolation
- `ipc`: System V IPC and POSIX message queue isolation
- `user`: UID/GID mapping — container root can map to unprivileged host UID
- `cgroup`: Control group visibility isolation

**cgroups v2** enforce resource limits — CPU, memory, I/O, and PIDs. They prevent a single container from exhausting host resources but do not prevent kernel exploitation.

**Seccomp** (Secure Computing Mode) filters syscalls at the kernel level. A seccomp profile defines an allowlist or denylist of syscalls a process may invoke. Violations can result in SIGKILL or SIGSYS signals. This is the most impactful single hardening measure available for standard runtimes.

**AppArmor** and **SELinux** enforce Mandatory Access Control (MAC) policies. These operate at a higher level than seccomp, controlling file access, network operations, and capability usage based on process labels.

**Linux Capabilities** subdivide the traditional root/non-root privilege model into fine-grained privileges. A container needs `NET_BIND_SERVICE` to bind ports below 1024, `SYS_ADMIN` for many administrative operations, and `CAP_SETUID` to change user IDs. Dropping all capabilities and adding back only what is required dramatically reduces the attack surface.

### Kernel Attack Surface Without Runtime Hardening

When a container runs without seccomp or AppArmor profiles, it has access to over 400 Linux syscalls. Historical container escapes have exploited:

- `clone()` with `CLONE_NEWUSER` to create user namespaces and gain capabilities
- `ptrace()` to attach to host processes visible through pid namespace leaks
- `keyctl()` to access kernel keyrings
- `perf_event_open()` to read kernel memory via side channels
- `bpf()` to load malicious eBPF programs
- `userfaultfd()` combined with race conditions in kernel code paths

The container runtime security hardening below addresses these vectors systematically.

## Standard Runtime Hardening: runc

### Dropping All Linux Capabilities

The default Docker and containerd capability set grants more than most workloads require. The correct pattern is to drop all capabilities and add back only what the specific workload needs:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hardened-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hardened-api
  template:
    metadata:
      labels:
        app: hardened-api
    spec:
      containers:
      - name: api
        image: registry.internal/api:v2.1.0
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 65534
          runAsGroup: 65534
          capabilities:
            drop:
            - ALL
            add:
            - NET_BIND_SERVICE    # Only if binding ports < 1024
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: cache
          mountPath: /var/cache/app
      volumes:
      - name: tmp
        emptyDir: {}
      - name: cache
        emptyDir: {}
```

The `allowPrivilegeEscalation: false` setting prevents the container from gaining more privileges than its parent process — this closes the `setuid` binary attack vector. The `readOnlyRootFilesystem: true` setting prevents attackers from writing malicious binaries or scripts to the container filesystem.

### Enforcing Pod-Level Security

Container-level security contexts handle per-container settings, while pod-level settings apply to all init containers and containers in the pod:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hardened-worker
  namespace: production
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        fsGroupChangePolicy: "OnRootMismatch"
        seccompProfile:
          type: RuntimeDefault
        sysctls: []
      hostPID: false
      hostIPC: false
      hostNetwork: false
      automountServiceAccountToken: false
      containers:
      - name: worker
        image: registry.internal/worker:v1.4.2
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
```

Setting `hostPID: false`, `hostIPC: false`, and `hostNetwork: false` explicitly prevents namespace sharing with the host. The `automountServiceAccountToken: false` prevents the Kubernetes API token from being mounted unless the workload explicitly requires it.

## Seccomp Profiles

### Understanding the RuntimeDefault Profile

Kubernetes ships with a `RuntimeDefault` seccomp profile that maps to the container runtime's default seccomp configuration. For containerd with runc, this is the Docker default seccomp profile, which blocks approximately 44 syscalls while allowing the ~350 commonly needed by containerized workloads.

To apply `RuntimeDefault` via the pod security context:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: seccomp-default
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: registry.internal/app:latest
```

This single change blocks many dangerous syscalls including `create_module`, `init_module`, `finit_module`, `delete_module`, `kexec_load`, `reboot`, and `syslog`.

### Creating Custom Seccomp Profiles

For workloads with well-understood syscall requirements, a custom restrictive profile provides significantly better isolation. Custom profiles are stored as JSON files and must be placed on every node in the cluster.

First, generate an audit profile to discover what syscalls the application actually uses:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32"
  ],
  "syscalls": [
    {
      "names": ["exit", "exit_group"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

After running the application under the audit profile and collecting logs from `/var/log/syslog` or the audit daemon, build a restrictive allowlist:

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
        "accept4",
        "access",
        "arch_prctl",
        "bind",
        "brk",
        "clone",
        "close",
        "connect",
        "dup2",
        "epoll_create1",
        "epoll_ctl",
        "epoll_pwait",
        "execve",
        "exit",
        "exit_group",
        "fcntl",
        "fstat",
        "futex",
        "getdents64",
        "getpeername",
        "getpid",
        "getrandom",
        "getsockname",
        "getsockopt",
        "gettid",
        "listen",
        "lseek",
        "mmap",
        "mprotect",
        "munmap",
        "nanosleep",
        "newfstatat",
        "open",
        "openat",
        "poll",
        "prctl",
        "pread64",
        "prlimit64",
        "read",
        "readlink",
        "recvfrom",
        "recvmsg",
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "sched_getaffinity",
        "sendmsg",
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
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": [
        "ptrace",
        "process_vm_readv",
        "process_vm_writev",
        "kexec_load",
        "init_module",
        "finit_module",
        "delete_module",
        "create_module",
        "syslog",
        "perf_event_open",
        "bpf",
        "userfaultfd",
        "keyctl",
        "add_key",
        "request_key"
      ],
      "action": "SCMP_ACT_ERRNO"
    }
  ]
}
```

Deploy the custom profile using a DaemonSet that copies profile files to the kubelet seccomp directory:

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
      hostPID: true
      initContainers:
      - name: install-profiles
        image: registry.internal/seccomp-profiles:v1.0.0
        command:
        - /bin/sh
        - -c
        - |
          mkdir -p /host/var/lib/kubelet/seccomp/profiles
          cp /profiles/*.json /host/var/lib/kubelet/seccomp/profiles/
          echo "Profiles installed successfully"
        volumeMounts:
        - name: host-seccomp
          mountPath: /host/var/lib/kubelet/seccomp
        - name: profiles
          mountPath: /profiles
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
      volumes:
      - name: host-seccomp
        hostPath:
          path: /var/lib/kubelet/seccomp
          type: DirectoryOrCreate
      - name: profiles
        configMap:
          name: seccomp-profiles
```

Reference the custom profile in a pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: restricted-api
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: "profiles/api-server.json"
  containers:
  - name: api
    image: registry.internal/api:v2.1.0
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

### Using the Security Profiles Operator

The Security Profiles Operator (SPO) provides a Kubernetes-native approach to managing seccomp and AppArmor profiles as Custom Resources:

```bash
# Install the Security Profiles Operator
kubectl apply -f https://github.com/kubernetes-sigs/security-profiles-operator/releases/latest/download/deploy-operator.yaml

# Wait for operator to be ready
kubectl wait --for=condition=ready pod \
  -l app=security-profiles-operator \
  -n security-profiles-operator \
  --timeout=120s
```

Create a SeccompProfile resource:

```yaml
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: api-server-profile
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
    - clone
    - close
    - connect
    - epoll_create1
    - epoll_ctl
    - epoll_pwait
    - exit
    - exit_group
    - fcntl
    - fstat
    - futex
    - getpid
    - getrandom
    - getsockname
    - getsockopt
    - listen
    - mmap
    - mprotect
    - munmap
    - nanosleep
    - open
    - openat
    - poll
    - read
    - recvfrom
    - recvmsg
    - rt_sigaction
    - rt_sigprocmask
    - rt_sigreturn
    - sendmsg
    - sendto
    - setsockopt
    - sigaltstack
    - socket
    - stat
    - tgkill
    - write
    - writev
```

Reference the SPO-managed profile in a pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api-with-spo-profile
  namespace: production
  annotations:
    seccomp.security.alpha.kubernetes.io/pod: "localhost/operator/production/api-server-profile.json"
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: "operator/production/api-server-profile.json"
  containers:
  - name: api
    image: registry.internal/api:v2.1.0
```

## AppArmor Profiles in Kubernetes

### Creating and Loading AppArmor Profiles

AppArmor profiles must be loaded into the kernel on each node before containers can reference them. A profile controls what files, capabilities, and network operations a confined process may use:

```
#include <tunables/global>

profile kubernetes-api-server flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  # Allow network operations
  network inet tcp,
  network inet udp,
  network inet6 tcp,
  network inet6 udp,

  # Allow reading application files
  /app/** r,
  /app/api ix,

  # Allow writing to specific paths only
  /tmp/** rw,
  /var/log/app/** rw,
  /var/cache/app/** rw,

  # Allow reading system files
  /etc/ssl/certs/** r,
  /etc/resolv.conf r,
  /etc/nsswitch.conf r,
  /etc/hosts r,

  # Block access to sensitive paths
  deny /proc/sys/kernel/** rwklx,
  deny /proc/sysrq-trigger rwklx,
  deny /sys/** rwklx,

  # Block dangerous capabilities
  deny capability sys_admin,
  deny capability sys_ptrace,
  deny capability sys_module,
  deny capability mknod,
  deny capability net_admin,

  # Allow specific capabilities
  capability net_bind_service,
  capability setuid,
  capability setgid,
  capability chown,
  capability dac_override,
  capability kill,

  # Signals
  signal (send) set=(kill, term, usr1, usr2),
  signal (receive) set=(kill, term, usr1, usr2),

  # Ptrace restrictions
  deny ptrace (read, write, readby, writeby),
}
```

Load the profile on each node:

```bash
# Copy profile to AppArmor profiles directory
sudo cp kubernetes-api-server /etc/apparmor.d/kubernetes-api-server

# Load the profile
sudo apparmor_parser -r -W /etc/apparmor.d/kubernetes-api-server

# Verify it is loaded
sudo aa-status | grep kubernetes-api-server
```

### Applying AppArmor Profiles via Pod Annotations

Kubernetes applies AppArmor profiles through pod annotations:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-with-apparmor
  namespace: production
spec:
  template:
    metadata:
      annotations:
        container.apparmor.security.beta.kubernetes.io/api: "localhost/kubernetes-api-server"
    spec:
      containers:
      - name: api
        image: registry.internal/api:v2.1.0
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
```

For Kubernetes 1.30+, AppArmor profiles can be specified in the security context directly:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api-apparmor-native
  namespace: production
spec:
  containers:
  - name: api
    image: registry.internal/api:v2.1.0
    securityContext:
      appArmorProfile:
        type: Localhost
        localhostProfile: kubernetes-api-server
```

### Automating AppArmor Profile Distribution

Distribute AppArmor profiles across nodes using a DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: apparmor-profile-installer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: apparmor-installer
  template:
    metadata:
      labels:
        app: apparmor-installer
    spec:
      hostPID: true
      initContainers:
      - name: install
        image: ubuntu:22.04
        command:
        - /bin/bash
        - -c
        - |
          set -ex
          # Copy profiles to host
          cp /profiles/* /host/etc/apparmor.d/
          # Load profiles using nsenter to run in host PID namespace
          nsenter -t 1 -m -- apparmor_parser -r -W /etc/apparmor.d/kubernetes-api-server
          nsenter -t 1 -m -- apparmor_parser -r -W /etc/apparmor.d/kubernetes-worker
          echo "AppArmor profiles installed and loaded"
        securityContext:
          privileged: true
        volumeMounts:
        - name: host-apparmor
          mountPath: /host/etc/apparmor.d
        - name: profiles
          mountPath: /profiles
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
      volumes:
      - name: host-apparmor
        hostPath:
          path: /etc/apparmor.d
          type: DirectoryOrCreate
      - name: profiles
        configMap:
          name: apparmor-profiles
```

## gVisor: User-Space Kernel Isolation

### gVisor Architecture

gVisor provides a user-space kernel that intercepts system calls from containerized applications before they reach the host kernel. This architecture significantly reduces the host kernel attack surface.

The two primary gVisor components are:

**Sentry** — The core of gVisor, running in user space. It implements the Linux system call interface and provides the containerized application's view of the kernel. The Sentry is written in Go and runs with limited host kernel capabilities. It handles process management, memory management, network I/O, and file system operations for containers.

**Gofer** — A file system proxy server that mediates all file system access from the Sentry. The Gofer runs as a separate process with access to the host file system, communicating with the Sentry via the 9P protocol. This isolation means that even if the Sentry is compromised, the attacker cannot directly access the host file system.

gVisor supports two platform modes for translating user-space syscalls:

- **ptrace**: Uses ptrace to intercept syscalls. Compatible with any Linux system but has higher overhead.
- **KVM**: Uses hardware virtualization to intercept syscalls. Requires KVM support in the kernel (`/dev/kvm`). Significantly lower overhead than ptrace.

### Installing gVisor on Kubernetes Nodes

```bash
# Add the gVisor repository
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null

# Install runsc (gVisor's container runtime)
sudo apt-get update && sudo apt-get install -y runsc

# Verify installation
runsc --version
```

Configure containerd to use gVisor as a runtime shim:

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd]
  default_runtime_name = "runc"

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
      runtime_type = "io.containerd.runc.v2"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
        SystemdCgroup = true

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
      runtime_type = "io.containerd.runsc.v1"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
        TypeUrl = "io.containerd.runsc.v1.options"
        ConfigPath = "/etc/containerd/runsc.toml"

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc-kvm]
      runtime_type = "io.containerd.runsc.v1"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc-kvm.options]
        TypeUrl = "io.containerd.runsc.v1.options"
        ConfigPath = "/etc/containerd/runsc-kvm.toml"
```

Create gVisor configuration files:

```toml
# /etc/containerd/runsc.toml
[runsc_config]
  platform = "ptrace"
  network = "sandbox"
  debug-log = "/var/log/runsc/"
  strace = false
```

```toml
# /etc/containerd/runsc-kvm.toml
[runsc_config]
  platform = "kvm"
  network = "sandbox"
  debug-log = "/var/log/runsc/"
  strace = false
```

Restart containerd after configuration changes:

```bash
sudo systemctl restart containerd
sudo systemctl status containerd
```

### Creating RuntimeClass Resources

RuntimeClass resources allow workloads to select specific container runtimes:

```yaml
# RuntimeClass for gVisor ptrace mode
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
overhead:
  podFixed:
    memory: "20Mi"
    cpu: "25m"
scheduling:
  nodeSelector:
    runtime.kubernetes.io/gvisor: "true"
  tolerations:
  - key: runtime.kubernetes.io/gvisor
    operator: Exists
    effect: NoSchedule
```

```yaml
# RuntimeClass for gVisor KVM mode (better performance)
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor-kvm
handler: runsc-kvm
overhead:
  podFixed:
    memory: "20Mi"
    cpu: "25m"
scheduling:
  nodeSelector:
    runtime.kubernetes.io/gvisor-kvm: "true"
  tolerations:
  - key: runtime.kubernetes.io/gvisor-kvm
    operator: Exists
    effect: NoSchedule
```

Label nodes that have gVisor installed:

```bash
kubectl label node worker-01 runtime.kubernetes.io/gvisor=true
kubectl label node worker-02 runtime.kubernetes.io/gvisor=true
kubectl label node worker-03 runtime.kubernetes.io/gvisor-kvm=true
```

### Deploying Workloads with gVisor

Any pod can opt into gVisor isolation by referencing the RuntimeClass:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: untrusted-processor
  namespace: processing
  labels:
    security-level: high
spec:
  replicas: 2
  selector:
    matchLabels:
      app: untrusted-processor
  template:
    metadata:
      labels:
        app: untrusted-processor
    spec:
      runtimeClassName: gvisor
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: processor
        image: registry.internal/processor:v1.0.0
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "250m"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
```

### gVisor Performance Considerations

gVisor introduces overhead for system call-heavy workloads. The overhead profile varies significantly:

| Workload Type | ptrace Overhead | KVM Overhead |
|--------------|-----------------|--------------|
| Network-heavy (HTTP APIs) | 15-25% | 5-10% |
| CPU-bound computation | 2-5% | 1-2% |
| File I/O intensive | 20-40% | 10-15% |
| Memory-heavy | 5-10% | 2-5% |

For production deployment, measure overhead with realistic load before deploying gVisor for latency-sensitive services. Use `runsc-kvm` where hardware virtualization is available.

## Kata Containers: Hardware-Virtualized Isolation

### Kata Containers Architecture

Kata Containers runs each container (or pod) inside a lightweight virtual machine, providing hardware-level isolation while maintaining the container API. Unlike gVisor's user-space kernel approach, Kata provides a real hardware isolation boundary between the workload and the host.

Key Kata components:

- **kata-runtime**: The OCI runtime that launches VMs instead of container processes
- **kata-agent**: A process running inside the VM guest that manages containers within the VM
- **kata-shim**: Manages the VM lifecycle and communicates with the agent via gRPC
- **QEMU/NEMU/cloud-hypervisor**: Hypervisor backends (cloud-hypervisor provides the lowest overhead)

Each pod becomes a VM with its own kernel. This means:
- Complete kernel isolation — a kernel exploit in one pod cannot affect other pods or the host
- Full hardware isolation via CPU virtualization
- Independent memory pages — no shared memory attack surface
- Separate network stack running inside the VM

### Installing Kata Containers

```bash
# Install Kata Containers packages (Ubuntu 22.04)
sudo bash -c "echo 'deb http://download.opensuse.org/repositories/home:/katacontainers:/releases:/x86_64:/stable-3.2/xUbuntu_22.04/ /' > /etc/apt/sources.list.d/kata-containers.list"
curl -sL https://download.opensuse.org/repositories/home:/katacontainers:/releases:/x86_64:/stable-3.2/xUbuntu_22.04/Release.key | sudo apt-key add -
sudo apt-get update && sudo apt-get install -y kata-runtime kata-proxy kata-shim

# Verify KVM is available (required for Kata)
ls -la /dev/kvm
# If not present, load the module:
sudo modprobe kvm_intel  # or kvm_amd

# Check kata installation
kata-runtime kata-check
```

Configure containerd to use Kata:

```toml
# /etc/containerd/config.toml additions
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  privileged_without_host_devices = true

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration.toml"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
  runtime_type = "io.containerd.kata-qemu.v2"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh]
  runtime_type = "io.containerd.kata-clh.v2"
```

Configure Kata for production:

```toml
# /opt/kata/share/defaults/kata-containers/configuration.toml
[hypervisor.qemu]
  path = "/usr/bin/qemu-kvm"
  kernel = "/opt/kata/share/kata-containers/vmlinux.container"
  image = "/opt/kata/share/kata-containers/kata-containers.img"
  machine_type = "q35"

  # Resource limits per VM
  default_vcpus = 1
  default_maxvcpus = 4
  default_memory = 2048
  default_maxmemory = 8192

  # Performance tuning
  enable_iothreads = true
  block_device_driver = "virtio-blk"
  enable_vhost_user_store = false

  # Security
  enable_template = false
  machine_accelerators = "kvm"

[agent.kata]
  enable_debug = false
  debug_console_enabled = false

[runtime]
  enable_debug = false
  enable_cpu_memory_hotplug = true
  sandbox_cgroup_only = false
  static_sandbox_resource_mgmt = false
```

### Kata Containers RuntimeClass

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
handler: kata-qemu
overhead:
  podFixed:
    memory: "160Mi"
    cpu: "250m"
scheduling:
  nodeSelector:
    runtime.kubernetes.io/kata: "true"
  tolerations:
  - key: runtime.kubernetes.io/kata
    operator: Exists
    effect: NoSchedule
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-clh
handler: kata-clh
overhead:
  podFixed:
    memory: "130Mi"
    cpu: "100m"
scheduling:
  nodeSelector:
    runtime.kubernetes.io/kata-clh: "true"
  tolerations:
  - key: runtime.kubernetes.io/kata-clh
    operator: Exists
    effect: NoSchedule
```

Label nodes for Kata:

```bash
kubectl label node worker-04 runtime.kubernetes.io/kata=true
kubectl label node worker-05 runtime.kubernetes.io/kata=true
```

### Deploying Multi-Tenant Workloads with Kata

Kata is ideal for multi-tenant environments where different customers' workloads share the same cluster:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: customer-workload
  namespace: tenant-acme
  labels:
    tenant: acme
    security-level: isolated
spec:
  replicas: 3
  selector:
    matchLabels:
      app: customer-workload
      tenant: acme
  template:
    metadata:
      labels:
        app: customer-workload
        tenant: acme
    spec:
      runtimeClassName: kata
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
      - name: app
        image: registry.internal/customer-app:v3.0.0
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
```

## Workload-Specific Runtime Selection Strategy

### Runtime Selection Matrix

Different workloads require different isolation levels. A practical selection framework:

| Workload Type | Recommended Runtime | Rationale |
|--------------|--------------------|-----------|
| Internal microservices | runc + seccomp + AppArmor | Low overhead, sufficient for trusted code |
| Third-party code processing | gVisor (KVM) | Reduced kernel attack surface |
| Customer-uploaded code execution | Kata Containers | Hardware isolation boundary |
| CI/CD build jobs | Kata or gVisor | Prevents build-time escapes |
| Data processing (untrusted input) | gVisor (ptrace) | Syscall interception for untrusted data |
| GPU workloads | runc (hardened) | gVisor/Kata have limited GPU support |
| System monitoring agents | runc with minimal caps | Need host access by design |

### Namespace-Level Runtime Enforcement with Kyverno

Enforce that specific namespaces use specific runtimes:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: enforce-runtime-class
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: require-kata-in-tenant-namespaces
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaceSelector:
            matchLabels:
              isolation-level: tenant
    validate:
      message: "Tenant namespaces must use kata or gvisor RuntimeClass"
      pattern:
        spec:
          runtimeClassName: "kata | gvisor | gvisor-kvm"
  - name: require-seccomp-in-production
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaceSelector:
            matchLabels:
              environment: production
    validate:
      message: "Production pods must have a seccomp profile"
      pattern:
        spec:
          securityContext:
            seccompProfile:
              type: "RuntimeDefault | Localhost"
```

## Falco Runtime Security Rules

### Installing Falco

Falco provides runtime threat detection by monitoring syscalls and Kubernetes audit events for anomalous behavior:

```bash
# Add Falco Helm repository
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

# Install Falco with eBPF driver (preferred over kernel module)
helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --set driver.kind=ebpf \
  --set falcosidekick.enabled=true \
  --set falcosidekick.config.slack.webhookurl="https://hooks.slack.com/services/YOUR/WEBHOOK/URL" \
  --set collectors.kubernetes.enabled=true \
  --set-string falco.jsonOutput=true \
  --set-string falco.logLevel=info
```

### Writing Custom Falco Rules

Create targeted rules for Kubernetes-specific threats:

```yaml
# /etc/falco/rules/kubernetes-security.yaml
- rule: Container Escape via Privileged Pod
  desc: Detect attempts to escape container using privileged capabilities
  condition: >
    spawned_process and
    container and
    (proc.name in (nsenter, unshare) or
     (proc.name = chroot and proc.args contains "/host"))
  output: >
    Potential container escape detected
    (user=%user.name command=%proc.cmdline container=%container.name
     image=%container.image.repository:%container.image.tag
     namespace=%k8s.ns.name pod=%k8s.pod.name)
  priority: CRITICAL
  tags: [container, escape, T1611]

- rule: Write to Sensitive Host Filesystem Path
  desc: Detect writes to sensitive host paths mounted into containers
  condition: >
    open_write and
    container and
    (fd.name startswith /host/etc or
     fd.name startswith /host/proc or
     fd.name startswith /host/sys or
     fd.name startswith /proc/sys or
     fd.name startswith /etc/cron.d or
     fd.name startswith /var/run/docker)
  output: >
    Write to sensitive host path from container
    (user=%user.name command=%proc.cmdline file=%fd.name
     container=%container.name namespace=%k8s.ns.name)
  priority: CRITICAL
  tags: [filesystem, container, T1610]

- rule: Crypto Mining Activity Detected
  desc: Detect potential cryptocurrency mining based on process and network patterns
  condition: >
    spawned_process and
    container and
    (proc.name in (xmrig, minerd, cpuminer, cgminer, bfgminer) or
     (proc.cmdline contains "stratum+tcp" or
      proc.cmdline contains "stratum+ssl" or
      proc.cmdline contains "pool.minexmr.com" or
      proc.cmdline contains "xmrig"))
  output: >
    Cryptocurrency mining process detected
    (user=%user.name command=%proc.cmdline container=%container.name
     image=%container.image.repository namespace=%k8s.ns.name)
  priority: CRITICAL
  tags: [cryptomining, T1496]

- rule: kubectl exec into Production Pod
  desc: Alert on interactive shell access to production containers
  condition: >
    ka.target.resource = pods and
    ka.target.subresource = exec and
    ka.verb = create and
    ka.target.namespace in (production, staging)
  output: >
    kubectl exec executed in sensitive namespace
    (user=%ka.user.name pod=%ka.target.name
     namespace=%ka.target.namespace uri=%ka.uri)
  priority: WARNING
  tags: [kubernetes, exec, audit]
  source: k8s_audit

- rule: Privilege Escalation via SUID Binary
  desc: Detect execution of SUID binaries that could enable privilege escalation
  condition: >
    spawned_process and
    container and
    proc.is_suid = true and
    not proc.name in (su, sudo, newgrp, passwd, chage, gpasswd)
  output: >
    SUID binary execution detected in container
    (user=%user.name binary=%proc.name command=%proc.cmdline
     container=%container.name namespace=%k8s.ns.name)
  priority: HIGH
  tags: [privilege-escalation, T1548]

- rule: Sensitive File Read by Unexpected Process
  desc: Alert when sensitive files are read by processes that should not access them
  condition: >
    open_read and
    container and
    fd.name in (/etc/shadow, /etc/sudoers, /proc/keys, /var/run/secrets/kubernetes.io/serviceaccount/token) and
    not proc.name in (cat, grep, find, awk, sed, python, python3, node, java, ruby)
  output: >
    Sensitive file read in container
    (user=%user.name process=%proc.name file=%fd.name
     container=%container.name namespace=%k8s.ns.name)
  priority: HIGH
  tags: [sensitive-files, T1552]

- rule: Outbound Connection to Unexpected IP
  desc: Detect container connections to external IPs outside approved ranges
  condition: >
    outbound and
    container and
    not fd.sip in (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and
    not fd.sport in (80, 443, 8080, 8443) and
    not container.image.repository startswith "registry.internal"
  output: >
    Unexpected outbound connection from container
    (user=%user.name command=%proc.cmdline connection=%fd.name
     container=%container.name namespace=%k8s.ns.name)
  priority: WARNING
  tags: [network, exfiltration, T1041]
```

### Configuring Falco Alerting

Configure Falco to send alerts to multiple destinations:

```yaml
# falco-sidekick-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: falcosidekick-config
  namespace: falco
data:
  config.yaml: |
    listenaddress: "0.0.0.0"
    listenport: 2801
    debug: false

    slack:
      webhookurl: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
      channel: "#security-alerts"
      minimumpriority: "warning"
      messageformat: "Alert: *%rule%* Priority: *%priority%* on *%hostname%*"

    pagerduty:
      routingkey: "your-pagerduty-routing-key"
      minimumpriority: "critical"

    elasticsearch:
      hostport: "http://elasticsearch:9200"
      index: "falco-alerts"
      minimumpriority: "warning"

    webhook:
      address: "http://security-webhook.internal/falco"
      minimumpriority: "warning"
      customheaders: "Authorization:Bearer token123"
```

## Pod Security Admission and Policy Enforcement

### Configuring Pod Security Standards

Kubernetes Pod Security Admission enforces security baselines at the namespace level:

```yaml
# Label namespaces for appropriate security levels
---
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
---
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: baseline
```

The `restricted` level enforces:
- No privileged containers
- No host namespaces
- No host path volumes
- Required seccomp profile (RuntimeDefault or custom)
- Required non-root user
- Required `allowPrivilegeEscalation: false`
- Required `capabilities.drop: [ALL]`

### Kyverno Policies for Runtime Security

Supplement Pod Security Admission with Kyverno for fine-grained control:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-drop-all-capabilities
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: drop-all-capabilities
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaceSelector:
            matchLabels:
              environment: production
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - monitoring
    validate:
      message: "All Linux capabilities must be dropped. Found: {{ request.object.spec.containers[].securityContext.capabilities.drop }}"
      foreach:
      - list: "request.object.spec.containers"
        deny:
          conditions:
            any:
            - key: "ALL"
              operator: AnyNotIn
              value: "{{ element.securityContext.capabilities.drop || `[]` }}"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privilege-escalation
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: no-privilege-escalation
    match:
      any:
      - resources:
          kinds:
          - Pod
    validate:
      message: "allowPrivilegeEscalation must be set to false"
      foreach:
      - list: "request.object.spec.containers"
        deny:
          conditions:
            any:
            - key: "{{ element.securityContext.allowPrivilegeEscalation || `true` }}"
              operator: Equals
              value: true
```

## Monitoring and Auditing Runtime Security

### Prometheus Metrics for Runtime Security Events

The Security Profiles Operator and Falco both export Prometheus metrics:

```yaml
# ServiceMonitor for Falco metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: falco-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: falco
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
  namespaceSelector:
    matchNames:
    - falco
```

Key Falco metrics to alert on:

```yaml
# Prometheus alerting rules for Falco
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: falco-security-alerts
  namespace: monitoring
spec:
  groups:
  - name: falco.security
    interval: 60s
    rules:
    - alert: FalcoCriticalEventRate
      expr: rate(falco_events_total{priority="Critical"}[5m]) > 0.1
      for: 1m
      labels:
        severity: critical
        team: security
      annotations:
        summary: "Critical Falco security events detected"
        description: "Falco is generating critical security events at {{ $value }} events/sec"

    - alert: ContainerEscapeAttempt
      expr: falco_events_total{rule="Container Escape via Privileged Pod"} > 0
      for: 0m
      labels:
        severity: critical
        team: security
      annotations:
        summary: "Container escape attempt detected"
        description: "A container escape attempt was detected on {{ $labels.hostname }}"
```

## Complete Hardening Checklist

A summary of all hardening measures covered in this guide:

```yaml
# Reference hardened pod template
apiVersion: v1
kind: Pod
metadata:
  name: fully-hardened-pod
  namespace: production
  annotations:
    # AppArmor (pre-1.30)
    container.apparmor.security.beta.kubernetes.io/app: "localhost/kubernetes-api-server"
spec:
  # Runtime isolation
  runtimeClassName: gvisor  # or kata for strongest isolation

  # Host namespace isolation
  hostPID: false
  hostIPC: false
  hostNetwork: false

  # Disable service account token automount
  automountServiceAccountToken: false

  # Pod-level security context
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
    fsGroupChangePolicy: "OnRootMismatch"
    seccompProfile:
      type: Localhost
      localhostProfile: "profiles/api-server.json"

  containers:
  - name: app
    image: registry.internal/app@sha256:abc123...  # Use digest, not tag
    imagePullPolicy: Always

    # Container-level security context
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 65534
      capabilities:
        drop:
        - ALL
        # Only add back if absolutely required:
        # add:
        # - NET_BIND_SERVICE

    # Resource limits prevent resource exhaustion
    resources:
      requests:
        memory: "64Mi"
        cpu: "50m"
      limits:
        memory: "128Mi"
        cpu: "100m"

    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: app-cache
      mountPath: /var/cache/app

  volumes:
  - name: tmp
    emptyDir:
      medium: Memory    # tmpfs — not persisted to disk
      sizeLimit: 32Mi
  - name: app-cache
    emptyDir:
      sizeLimit: 64Mi
```

## Conclusion

Kubernetes container runtime security requires a layered approach. No single control is sufficient in isolation. The recommended stack for production workloads combines: capability dropping (ALL), read-only root filesystem, non-root execution, seccomp profiles (at minimum RuntimeDefault, custom for sensitive workloads), AppArmor or SELinux profiles, Pod Security Admission at the `restricted` level, and runtime threat detection with Falco.

For workloads processing untrusted input or running in multi-tenant environments, gVisor provides meaningful additional isolation with manageable overhead. For the strongest isolation guarantees — such as customer code execution or regulated data processing — Kata Containers' hardware virtualization boundary is the appropriate choice.

The investment in runtime security hardening pays dividends not only in breach prevention but also in compliance posture for frameworks including PCI-DSS, SOC 2, and HIPAA, which require documented controls for workload isolation and privilege management.
