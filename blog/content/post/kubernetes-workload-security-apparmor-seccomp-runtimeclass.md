---
title: "Kubernetes Workload Security: AppArmor Profiles, Seccomp Filters, and RuntimeClass"
date: 2030-02-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "AppArmor", "Seccomp", "RuntimeClass", "gVisor", "Kata", "Pod Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes workload security using AppArmor profiles, seccomp filter authoring with syscall auditing, RuntimeClass for gVisor and Kata containers, and replacing privileged containers with capability-based alternatives."
more_link: "yes"
url: "/kubernetes-workload-security-apparmor-seccomp-runtimeclass/"
---

Defense in depth for containerized workloads requires multiple overlapping security controls. Namespace isolation prevents most privilege escalation paths. Network policies limit lateral movement. But the most effective controls operate at the system call layer — preventing containers from calling kernel APIs they should never need. AppArmor profiles and seccomp filters provide this capability at the kernel level, independently of container runtime security.

This guide covers the complete workflow for authoring, testing, and deploying AppArmor profiles and seccomp filters in production Kubernetes clusters, along with RuntimeClass configurations for gVisor and Kata Containers that provide stronger isolation guarantees for untrusted workloads.

<!--more-->

## The Security Layering Model

A fully secured container workload in Kubernetes has multiple defense layers:

1. **Pod Security Standards**: Restrict the most dangerous capabilities at admission time
2. **seccomp filters**: Allowlist specific Linux syscalls the container is permitted to call
3. **AppArmor profiles**: MAC (Mandatory Access Control) restricting file, network, and capability access
4. **Network Policies**: Restrict network access at the CNI layer
5. **RuntimeClass**: Optional stronger isolation with gVisor (user-space kernel) or Kata (VM-based)

These layers are independent and complementary. A container running under a restricted seccomp profile can still be exploited via an allowed syscall if AppArmor is not also in place. Conversely, AppArmor cannot prevent syscalls it does not understand if seccomp is not also active.

## Seccomp Filters

Seccomp (secure computing mode) allows a process to restrict the set of system calls it can make. The kernel-level filtering is highly efficient and cannot be bypassed from userspace.

### Understanding the Default Kubernetes Seccomp Profile

```bash
# Starting from Kubernetes 1.27, RuntimeDefault is the default seccomp profile
# for all pods when PodSecurityAdmission enforces baseline+ policies

# View the default Docker seccomp profile (basis for RuntimeDefault)
# It allows ~350 of the ~450+ available syscalls

# List syscalls blocked by RuntimeDefault
cat /var/lib/kubelet/seccomp/profiles/default.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
blocked = [s['names'] for s in data.get('syscalls', []) if s['action'] == 'SCMP_ACT_ERRNO']
print('Blocked syscalls:', [s for group in blocked for s in group][:20])
"
```

### Authoring a Custom Seccomp Profile via Audit

The safest way to build a seccomp profile is to start with audit mode and observe what syscalls your application actually uses:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32"
  ],
  "syscalls": []
}
```

```yaml
# audit-seccomp-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: webapp-audit
  namespace: security-testing
  annotations:
    seccomp.security.alpha.kubernetes.io/pod: "localhost/audit-mode.json"
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: audit-mode.json
  containers:
    - name: webapp
      image: registry.internal/webapp:latest
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 1000
```

```bash
# After running the application under audit mode, collect syscalls from audit log
# On nodes with auditd configured:
ausearch -m SECCOMP --start today | \
  awk '/type=SECCOMP/ {for(i=1;i<=NF;i++) if($i ~ /syscall=/) print $i}' | \
  sort -u | \
  sed 's/syscall=//'

# Or using strace for development containers
strace -c -f -qe trace=all ./webapp 2>&1 | tail -20
```

### Production Seccomp Profile for a Web Application

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
        "bind",
        "brk",
        "capget",
        "capset",
        "chdir",
        "clone",
        "clone3",
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
        "fchdir",
        "fcntl",
        "fstat",
        "fstatfs",
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
        "lseek",
        "madvise",
        "memfd_create",
        "mmap",
        "mprotect",
        "munmap",
        "nanosleep",
        "newfstatat",
        "open",
        "openat",
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
        "readlinkat",
        "recvfrom",
        "recvmsg",
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "sched_getaffinity",
        "sched_yield",
        "sendmsg",
        "sendto",
        "setgid",
        "setgroups",
        "setsockopt",
        "setuid",
        "sigaltstack",
        "socket",
        "socketpair",
        "stat",
        "statfs",
        "statx",
        "tgkill",
        "uname",
        "unshare",
        "waitid",
        "waitpid",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["ptrace"],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1
    }
  ]
}
```

### Deploying Seccomp Profiles with SecurityProfile Operator

Managing seccomp profiles as raw JSON files on nodes is error-prone. The Security Profiles Operator (SPO) provides a Kubernetes-native way to manage profiles:

```bash
# Install the Security Profiles Operator
kubectl apply -f https://github.com/kubernetes-sigs/security-profiles-operator/releases/download/v0.8.0/operator.yaml

# Wait for the operator to be ready
kubectl -n security-profiles-operator wait \
  --for=condition=ready pod \
  --selector app=security-profiles-operator \
  --timeout=180s
```

```yaml
# seccomp-profile-webapp.yaml
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: webapp-seccomp
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
        - clone3
        - close
        - connect
        - epoll_create1
        - epoll_ctl
        - epoll_pwait
        - exit_group
        - fcntl
        - fstat
        - futex
        - getcwd
        - getrandom
        - getsockname
        - getsockopt
        - gettid
        - madvise
        - mmap
        - mprotect
        - munmap
        - nanosleep
        - newfstatat
        - openat
        - pread64
        - prlimit64
        - read
        - recvfrom
        - recvmsg
        - rt_sigaction
        - rt_sigprocmask
        - rt_sigreturn
        - sendmsg
        - sendto
        - setsockopt
        - socket
        - stat
        - statx
        - tgkill
        - write
        - writev
---
# Reference the profile in a pod
apiVersion: v1
kind: Pod
metadata:
  name: webapp
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: operator/production/webapp-seccomp.json
  containers:
    - name: webapp
      image: registry.internal/webapp:1.5.0
```

## AppArmor Profiles

AppArmor is a Linux Security Module that enforces mandatory access control policies on file system access, network access, and Linux capabilities at the kernel level.

### Checking AppArmor Status

```bash
# Check if AppArmor is enabled
aa-status
# apparmor module is loaded.
# 47 profiles are loaded.
# 34 profiles are in enforce mode.
# 13 profiles are in complain mode.

# Verify AppArmor kernel support
cat /sys/module/apparmor/parameters/enabled
# Y

# Check which profiles are active for containers
cat /proc/$(pgrep -f "webapp")/attr/current
# docker-default (enforce)  <-- using default Docker profile
```

### Writing an AppArmor Profile

```
# /etc/apparmor.d/webapp-production
# AppArmor profile for the webapp container

#include <tunables/global>

profile webapp-production flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Allow reading system information
  /proc/sys/kernel/hostname r,
  /proc/sys/net/** r,
  /proc/meminfo r,
  /proc/cpuinfo r,
  /proc/stat r,

  # Allow the binary to execute
  /usr/bin/webapp rix,
  /usr/lib/webapp/** mr,

  # Configuration files (read-only)
  /etc/webapp/config.yaml r,
  /etc/ssl/certs/** r,
  /etc/resolv.conf r,
  /etc/nsswitch.conf r,
  /etc/hosts r,

  # Temporary files
  /tmp/ rw,
  /tmp/** rw,

  # Log output (read-write)
  /var/log/webapp/ rw,
  /var/log/webapp/** rw,

  # Application data (read-only for config, read-write for runtime)
  /var/lib/webapp/config/** r,
  /var/lib/webapp/data/** rw,
  /var/lib/webapp/tmp/** rw,

  # Unix domain sockets
  /run/webapp.sock rw,

  # Network access allowed
  network tcp,
  network udp,

  # Deny access to sensitive files
  deny /etc/shadow r,
  deny /etc/passwd w,
  deny /etc/sudoers r,
  deny /root/** rw,
  deny /proc/sysrq-trigger w,
  deny /proc/kcore r,

  # Deny dangerous capabilities
  deny capability sys_admin,
  deny capability sys_ptrace,
  deny capability sys_boot,
  deny capability mac_override,
  deny capability mac_admin,
  deny capability net_admin,

  # Allow specific capabilities
  capability net_bind_service,
  capability setuid,
  capability setgid,
  capability dac_override,

  # Deny all mounts
  deny mount,
  deny umount,
  deny pivot_root,

  # Deny module loading
  deny /proc/modules r,
  deny /sys/module/ rw,
}
```

### Loading and Testing AppArmor Profiles

```bash
# Load profile in complain mode (logs violations but doesn't block)
apparmor_parser -C /etc/apparmor.d/webapp-production

# Load profile in enforce mode (blocks violations)
apparmor_parser -r /etc/apparmor.d/webapp-production

# Check profile status
aa-status | grep webapp-production
# webapp-production (enforce)

# Test the profile with a container
docker run \
  --security-opt apparmor=webapp-production \
  --rm \
  -it \
  registry.internal/webapp:latest \
  /bin/bash

# Monitor AppArmor violations
tail -f /var/log/syslog | grep apparmor

# Or with journalctl
journalctl -k -f | grep APPARMOR

# Parse violations into readable format
aa-logprof
```

### Applying AppArmor in Kubernetes

```yaml
# apparmor-webapp-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: webapp-secure
  namespace: production
  annotations:
    # Format: container.apparmor.security.beta.kubernetes.io/<container-name>
    container.apparmor.security.beta.kubernetes.io/webapp: localhost/webapp-production
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: webapp
      image: registry.internal/webapp:1.5.0
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
          add:
            - NET_BIND_SERVICE
      ports:
        - containerPort: 8080
      volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: logs
          mountPath: /var/log/webapp
  volumes:
    - name: tmp
      emptyDir: {}
    - name: logs
      emptyDir: {}
```

### AppArmor Profile Distribution with DaemonSet

AppArmor profiles must be loaded on every node where pods might run. Use a DaemonSet to distribute and load profiles:

```yaml
# apparmor-loader-daemonset.yaml
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
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
      initContainers:
        - name: apparmor-loader
          image: registry.internal/apparmor-loader:1.0.0
          securityContext:
            privileged: true
          volumeMounts:
            - name: profiles
              mountPath: /profiles
            - name: apparmor-includes
              mountPath: /etc/apparmor.d
            - name: host-apparmor
              mountPath: /host-apparmor.d
          command:
            - /bin/sh
            - -c
            - |
              set -e
              cp /profiles/*.profile /host-apparmor.d/
              for profile in /host-apparmor.d/*.profile; do
                apparmor_parser -r "${profile}" && \
                  echo "Loaded: ${profile}" || \
                  echo "Failed to load: ${profile}"
              done
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.6
          resources:
            limits:
              cpu: 10m
              memory: 10Mi
      volumes:
        - name: profiles
          configMap:
            name: apparmor-profiles
        - name: apparmor-includes
          hostPath:
            path: /etc/apparmor.d
        - name: host-apparmor
          hostPath:
            path: /etc/apparmor.d
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: apparmor-profiles
  namespace: kube-system
data:
  webapp-production.profile: |
    #include <tunables/global>
    profile webapp-production flags=(attach_disconnected,mediate_deleted) {
      #include <abstractions/base>
      /usr/bin/webapp rix,
      /etc/webapp/** r,
      /var/log/webapp/** rw,
      /tmp/** rw,
      network tcp,
      network udp,
      deny capability sys_admin,
      deny /proc/kcore r,
    }
```

## RuntimeClass for Stronger Isolation

RuntimeClass allows you to specify an alternative container runtime for workloads that need stronger isolation guarantees. The two most common options are gVisor (user-space kernel interception) and Kata Containers (lightweight VMs).

### gVisor (runsc) Configuration

gVisor intercepts all syscalls from the container and handles them in a user-space kernel written in Go. This provides strong isolation at the cost of some performance overhead (typically 10-30% for CPU-bound workloads, more for I/O-heavy workloads).

```bash
# Install gVisor on worker nodes
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | \
  sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc

# Configure containerd to use gVisor
cat > /etc/containerd/config.toml <<'EOF'
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
  TypeUrl = "io.containerd.runsc.v1.options"
  ConfigPath = "/etc/containerd/runsc.toml"
EOF

# gVisor configuration
cat > /etc/containerd/runsc.toml <<'EOF'
[runsc_config]
  network = "host"
  debug = false
  debug-log = "/tmp/runsc-debug.log"
  strace = false

  # Performance tuning
  numNetworkChannels = 4

  # Platform selection
  platform = "systrap"  # Best performance on modern kernels
  # platform = "ptrace"   # Fallback if systrap unavailable

  # Enable direct filesystem access for trusted volumes
  directfs = true
EOF

systemctl restart containerd
```

```yaml
# runtimeclass-gvisor.yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
overhead:
  podFixed:
    memory: "50Mi"
    cpu: "100m"
scheduling:
  nodeClassification:
    tolerations:
      - key: sandbox.gke.io/runtime
        operator: Equal
        value: gvisor
        effect: NoSchedule
```

### Kata Containers Configuration

Kata Containers runs each container in a lightweight VM using hardware virtualization. It provides stronger isolation than gVisor (full hardware boundary) but with higher overhead (typically 100-200ms startup, 5-15% throughput).

```bash
# Install Kata Containers
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kata-containers/kata-containers/main/utils/kata-manager.sh) install-packages"

# Configure containerd for Kata
cat >> /etc/containerd/config.toml <<'EOF'
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
  runtime_type = "io.containerd.kata-qemu.v2"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu-snp]
  runtime_type = "io.containerd.kata-qemu-snp.v2"
EOF

systemctl restart containerd
```

```yaml
# runtimeclass-kata.yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
handler: kata-qemu
overhead:
  podFixed:
    memory: "160Mi"
    cpu: "200m"
scheduling:
  nodeClassification:
    nodeSelector:
      kata-runtime: "true"
    tolerations:
      - key: kata-runtime
        operator: Equal
        value: "true"
        effect: NoSchedule
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-snp
handler: kata-qemu-snp
overhead:
  podFixed:
    memory: "200Mi"
    cpu: "300m"
```

### Using RuntimeClass in Pod Specs

```yaml
# workload with gVisor isolation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: untrusted-user-code
  namespace: sandboxed
spec:
  replicas: 3
  selector:
    matchLabels:
      app: user-sandbox
  template:
    metadata:
      labels:
        app: user-sandbox
      annotations:
        container.apparmor.security.beta.kubernetes.io/sandbox: localhost/sandbox-profile
    spec:
      runtimeClassName: gvisor
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: sandbox
          image: registry.internal/code-sandbox:latest
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "1"
              memory: "256Mi"
```

## Replacing Privileged Containers

Many legacy containerized applications run with `privileged: true` or excessive Linux capabilities when they only need specific narrow permissions. Here is how to replace the most common privileged patterns.

### Pattern 1: Container Needing to Modify Network Settings

```yaml
# BEFORE: privileged container for network tuning
# securityContext:
#   privileged: true

# AFTER: use specific capabilities
securityContext:
  capabilities:
    drop:
      - ALL
    add:
      - NET_ADMIN
      - NET_RAW
  allowPrivilegeEscalation: false
```

### Pattern 2: Container Needing to Bind Low-Numbered Ports

```yaml
# BEFORE: running as root to bind port 80
# securityContext:
#   runAsUser: 0

# AFTER: use NET_BIND_SERVICE capability with non-root user
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  capabilities:
    drop:
      - ALL
    add:
      - NET_BIND_SERVICE
  allowPrivilegeEscalation: false
```

### Pattern 3: Init Container Needing sysctl Modification

```yaml
# AFTER: use securityContext.sysctls at pod level for safe sysctls
# or use the init container pattern for unsafe sysctls with minimal capabilities
spec:
  securityContext:
    sysctls:
      - name: net.core.somaxconn
        value: "65535"
      - name: net.ipv4.tcp_syncookies
        value: "1"
  initContainers:
    - name: sysctl-tuner
      image: busybox:1.36
      securityContext:
        privileged: true  # Only this init container is privileged
        runAsUser: 0
      command:
        - /bin/sh
        - -c
        - |
          sysctl -w net.core.somaxconn=65535
          sysctl -w net.ipv4.tcp_syncookies=1
          sysctl -w vm.overcommit_memory=1
  containers:
    - name: app
      # Main container runs without privilege
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        capabilities:
          drop:
            - ALL
```

### Pattern 4: DaemonSet Needing Host Path Access

```yaml
# Minimal DaemonSet for log collection
# Instead of privileged: true, mount only the specific paths needed
spec:
  containers:
    - name: log-collector
      image: registry.internal/log-collector:latest
      securityContext:
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65534
        capabilities:
          drop:
            - ALL
      volumeMounts:
        - name: varlog
          mountPath: /var/log
          readOnly: true
        - name: pods
          mountPath: /var/log/pods
          readOnly: true
  volumes:
    - name: varlog
      hostPath:
        path: /var/log
    - name: pods
      hostPath:
        path: /var/log/pods
```

## Policy Enforcement with OPA Gatekeeper

Enforce security requirements across the cluster with Gatekeeper constraints:

```yaml
# require-seccomp-constraint.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPSeccomp
metadata:
  name: require-seccomp-profile
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - monitoring
  parameters:
    allowedProfiles:
      - RuntimeDefault
      - Localhost
    allowedLocalhostProfiles:
      - "webapp-seccomp.json"
      - "database-seccomp.json"
      - "worker-seccomp.json"
---
# require-apparmor-constraint.yaml
apiVersion: templates.gatekeeper.sh/v1beta1
kind: ConstraintTemplate
metadata:
  name: k8srequireapparmorprofile
spec:
  crd:
    spec:
      names:
        kind: K8sRequireAppArmorProfile
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequireapparmorprofile

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          annotation_key := sprintf(
            "container.apparmor.security.beta.kubernetes.io/%s",
            [container.name]
          )
          not input.review.object.metadata.annotations[annotation_key]
          msg := sprintf(
            "Container %s must have an AppArmor profile annotation",
            [container.name]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          annotation_key := sprintf(
            "container.apparmor.security.beta.kubernetes.io/%s",
            [container.name]
          )
          profile := input.review.object.metadata.annotations[annotation_key]
          not startswith(profile, "localhost/")
          profile != "runtime/default"
          msg := sprintf(
            "Container %s AppArmor profile must be 'runtime/default' or 'localhost/<name>'",
            [container.name]
          )
        }
```

## Auditing Existing Workloads

```bash
#!/bin/bash
# audit-pod-security.sh
# Identify pods with weak security configurations

echo "=== Pods Running as Root ==="
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].securityContext.runAsUser == 0 or
         .spec.securityContext.runAsUser == 0) |
  [.metadata.namespace, .metadata.name] | @tsv
'

echo ""
echo "=== Pods with Privileged Containers ==="
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].securityContext.privileged == true) |
  [.metadata.namespace, .metadata.name] | @tsv
'

echo ""
echo "=== Pods Without Seccomp Profiles ==="
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(
    (.spec.securityContext.seccompProfile == null) and
    (.metadata.annotations |
     to_entries |
     map(select(.key | startswith("seccomp"))) |
     length == 0)
  ) |
  select(.metadata.namespace != "kube-system") |
  [.metadata.namespace, .metadata.name] | @tsv
'

echo ""
echo "=== Pods Without ReadOnlyRootFilesystem ==="
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].securityContext.readOnlyRootFilesystem != true) |
  select(.metadata.namespace != "kube-system") |
  [.metadata.namespace, .metadata.name] | @tsv
' | sort -u
```

## Key Takeaways

**Seccomp before AppArmor**: Implement seccomp first because it operates at the syscall boundary — the most fundamental layer. The `RuntimeDefault` profile blocks the most dangerous syscalls (kexec, module loading, perf_event_open) with no application changes required. Custom profiles based on syscall auditing give you defense against unknown exploit techniques.

**AppArmor complements seccomp**: While seccomp controls which syscalls can be made, AppArmor controls what resources those syscalls can operate on. A process allowed to call `open()` by seccomp can still be blocked by AppArmor from opening `/etc/shadow`. Use both.

**Profile distribution requires infrastructure**: AppArmor profiles must exist on every node where a pod might schedule. Build profile distribution into your node provisioning pipeline using a DaemonSet or node configuration management tool. The Security Profiles Operator is the most Kubernetes-native solution.

**RuntimeClass for untrusted code**: When running user-submitted code, third-party plugins, or any workload where the code author is not fully trusted, run it under gVisor or Kata Containers. The isolation overhead is worth it for workloads where container escape would be catastrophic.

**Replace privilege with capabilities**: Most workloads that currently require `privileged: true` can be refactored to use specific Linux capabilities. The audit is straightforward — run `getcap` on binaries and `strace -e trace=network,process` on the application to identify the minimum capability set required.
