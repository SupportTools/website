---
title: "Linux Security Modules: AppArmor and SELinux for Container Workloads"
date: 2030-07-05T00:00:00-05:00
draft: false
tags: ["AppArmor", "SELinux", "Linux", "Container Security", "Kubernetes", "seccomp", "Security"]
categories:
- Security
- Kubernetes
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Linux Security Module guide covering AppArmor profile creation for containers, seccomp filter design, SELinux policy in Kubernetes, custom security profiles with the seccomp-operator, and hardening container runtime configurations for production workloads."
more_link: "yes"
url: "/linux-security-modules-apparmor-selinux-container-workloads/"
---

Linux Security Modules (LSMs) provide mandatory access control (MAC) enforcement at the kernel level, operating independently of discretionary controls like file permissions and capabilities. For container workloads, AppArmor and SELinux are the two dominant LSM implementations, each with distinct design philosophies. AppArmor applies path-based policies per process, making it well-suited for container runtimes. SELinux labels every object in the system and enforces transitions based on type enforcement rules, offering finer-grained control at the cost of higher operational complexity. Both are essential tools for hardening production Kubernetes clusters against container escape and lateral movement.

<!--more-->

## Container Security Threat Model

Before implementing LSM controls, the threat model must be clear. Container workloads face several kernel-level attack vectors:

- **Container escape via kernel exploits**: A vulnerability in a syscall handler allows a process inside a container to gain privileges on the host.
- **Capability abuse**: A container running with excessive Linux capabilities (e.g., `CAP_SYS_ADMIN`) can reconfigure network interfaces, load kernel modules, or manipulate host namespaces.
- **Filesystem traversal**: A container that mounts host paths can read sensitive files or overwrite host binaries.
- **Syscall exploitation**: Syscalls like `ptrace`, `keyctl`, and `mount` provide attack surfaces that most application workloads do not require.

AppArmor, SELinux, and seccomp address these vectors at different layers:

| Control | Mechanism | Scope |
|---|---|---|
| seccomp | Syscall filtering | Which syscalls the process can invoke |
| AppArmor | Path-based MAC | File access, network, capabilities per process |
| SELinux | Type enforcement | All object access based on label transitions |

## AppArmor Profile Creation

### Profile Structure

An AppArmor profile defines what a binary can do. Profiles consist of rules covering files, capabilities, network, and signal access:

```
# AppArmor profile for nginx container
profile nginx-container flags=(attach_disconnected,mediate_deleted) {

  # Include base abstractions for common requirements
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Capability rules
  capability dac_override,
  capability setuid,
  capability setgid,
  capability net_bind_service,

  # Allow nginx binary
  /usr/sbin/nginx        mrix,

  # Configuration files — read only
  /etc/nginx/            r,
  /etc/nginx/**          r,
  /etc/ssl/certs/**      r,
  /etc/ssl/private/**    r,

  # Log files — read and write
  /var/log/nginx/        rw,
  /var/log/nginx/**      rw,

  # Temp and cache — full access
  /var/cache/nginx/      rw,
  /var/cache/nginx/**    rwk,
  /tmp/                  rw,
  /tmp/**                rwk,

  # Runtime files
  /run/nginx.pid         rw,
  /var/run/nginx.pid     rw,

  # Proc filesystem — restricted read
  /proc/*/               r,
  /proc/*/cpuinfo        r,
  /proc/meminfo          r,
  /proc/sys/kernel/ngroups_max r,

  # Allow reads from /sys needed by nginx
  /sys/devices/system/cpu/ r,

  # Network — allow TCP and UDP
  network tcp,
  network udp,

  # Deny all other file access
  deny /etc/shadow      r,
  deny /etc/gshadow     r,
  deny /proc/sysrq-trigger rw,
  deny /proc/kcore      rw,
  deny @{PROC}/sys/vm/drop_caches rw,

  # Deny kernel module loading
  deny /proc/*/modules  r,
  deny /sys/module/     r,
  deny /sbin/insmod     x,
  deny /sbin/rmmod      x,
  deny /sbin/modprobe   x,
}
```

### Profile Modes: Complain vs. Enforce

Development follows a two-phase workflow — complain mode logs violations without blocking, enforce mode blocks and logs:

```bash
# Install AppArmor utilities
apt-get install -y apparmor-utils

# Load profile in complain mode for testing
aa-complain /etc/apparmor.d/nginx-container

# Load profile in enforce mode for production
aa-enforce /etc/apparmor.d/nginx-container

# Check current profile status
aa-status

# View violation logs in complain mode
journalctl -k | grep apparmor | grep ALLOWED

# View blocked actions in enforce mode
journalctl -k | grep apparmor | grep DENIED
```

### Generating Profiles with aa-genprof

For complex applications, generate a profile skeleton by running the binary under `aa-genprof`:

```bash
# Start profile generation
aa-genprof /usr/sbin/custom-app

# In another terminal, exercise the application:
# - Start it
# - Send test traffic
# - Exercise all code paths

# Back in aa-genprof terminal, scan logs and generate rules:
# Press 'S' to scan logs
# Accept or deny each suggested rule
# Press 'F' to finish
```

### Applying AppArmor Profiles in Kubernetes

Kubernetes applies AppArmor profiles via pod annotations (v1.30+) or the `securityContext.appArmorProfile` field:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-hardened
  annotations:
    # Legacy annotation format (still supported)
    container.apparmor.security.beta.kubernetes.io/nginx: localhost/nginx-container
spec:
  containers:
    - name: nginx
      image: nginx:1.25
      # Kubernetes 1.30+ field format
      securityContext:
        appArmorProfile:
          type: Localhost
          localhostProfile: nginx-container
```

For DaemonSet-managed profile distribution:

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
        - name: install-profiles
          image: ubuntu:22.04
          command: ["/bin/sh", "-c"]
          args:
            - |
              cp /profiles/* /host/etc/apparmor.d/
              for profile in /profiles/*; do
                apparmor_parser -r "$profile" || true
              done
          volumeMounts:
            - name: profiles
              mountPath: /profiles
            - name: host-apparmor
              mountPath: /host/etc/apparmor.d
            - name: host-sys
              mountPath: /sys
              readOnly: false
          securityContext:
            privileged: true
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
      volumes:
        - name: profiles
          configMap:
            name: apparmor-profiles
        - name: host-apparmor
          hostPath:
            path: /etc/apparmor.d
        - name: host-sys
          hostPath:
            path: /sys
      tolerations:
        - operator: Exists
```

## seccomp: Syscall-Level Filtering

seccomp (secure computing mode) filters the syscalls a process can invoke. A well-designed seccomp profile eliminates entire classes of kernel exploits by removing the attack surface entirely.

### Default RuntimeDefault Profile

Kubernetes ships with a reasonable default seccomp profile (`runtime/default`) that blocks the most dangerous syscalls. Enable it explicitly rather than relying on it being applied automatically:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-seccomp
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      image: company-registry/app:2.1.0
```

### Custom seccomp Profile

For applications with well-understood syscall requirements, build a minimal allowlist:

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
        "accept4",
        "bind",
        "brk",
        "clock_gettime",
        "close",
        "connect",
        "dup",
        "dup2",
        "epoll_create1",
        "epoll_ctl",
        "epoll_wait",
        "eventfd2",
        "exit",
        "exit_group",
        "fstat",
        "futex",
        "getcwd",
        "getdents64",
        "getegid",
        "geteuid",
        "getgid",
        "getpid",
        "getppid",
        "getsockname",
        "getsockopt",
        "gettid",
        "getuid",
        "ioctl",
        "listen",
        "lseek",
        "madvise",
        "mmap",
        "mprotect",
        "munmap",
        "nanosleep",
        "newfstatat",
        "open",
        "openat",
        "pipe2",
        "poll",
        "pread64",
        "read",
        "readlink",
        "recv",
        "recvfrom",
        "recvmsg",
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "sched_getaffinity",
        "sched_yield",
        "send",
        "sendfile",
        "sendmsg",
        "sendto",
        "set_robust_list",
        "setsockopt",
        "shutdown",
        "sigaltstack",
        "socket",
        "stat",
        "tgkill",
        "uname",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Deploy the profile to nodes and reference it in pod specs:

```bash
# Copy profile to seccomp profiles directory on each node
# (handled via DaemonSet or node provisioning)
/var/lib/kubelet/seccomp/profiles/app-minimal.json
```

```yaml
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/app-minimal.json
```

### seccomp-operator: Kubernetes-Native Profile Management

The seccomp-operator CRD allows managing seccomp profiles as Kubernetes objects and automatically distributes them to nodes:

```bash
# Install the seccomp-operator
kubectl apply -f https://github.com/kubernetes-sigs/security-profiles-operator/releases/latest/download/operator.yaml
```

```yaml
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: app-minimal
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
        - clock_gettime
        - close
        - connect
        - epoll_create1
        - epoll_ctl
        - epoll_wait
        - exit_group
        - fstat
        - futex
        - getpid
        - getsockname
        - mmap
        - mprotect
        - munmap
        - nanosleep
        - openat
        - read
        - recvfrom
        - rt_sigaction
        - rt_sigprocmask
        - rt_sigreturn
        - sendto
        - setsockopt
        - socket
        - stat
        - write
```

```yaml
# Reference the SeccompProfile in a pod
apiVersion: v1
kind: Pod
metadata:
  name: app-hardened
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: operator/production/app-minimal.json
  containers:
    - name: app
      image: company-registry/app:2.1.0
```

### Profile Recording

The seccomp-operator can record syscall usage from a running workload to generate a profile automatically:

```yaml
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: record-app
  namespace: production
spec:
  kind: SeccompProfile
  recorder: bpf
  podSelector:
    matchLabels:
      app: myapp
      record: "true"
```

After exercising the application, retrieve the generated profile:

```bash
kubectl get seccompprofile -n production record-app -o yaml
```

## SELinux for Kubernetes Workloads

### SELinux Concepts

SELinux assigns a **label** (`user:role:type:level`) to every process and file. Access is governed by **type enforcement** rules: a process with type `httpd_t` can read files labeled `httpd_config_t` because an explicit `allow` rule exists between those types.

```bash
# View process labels
ps -eZ | grep nginx
# system_u:system_r:container_t:s0:c123,c456  nginx

# View file labels
ls -Z /etc/nginx/
# system_u:object_r:httpd_config_t:s0 nginx.conf

# Check SELinux mode
getenforce
# Enforcing

# Temporarily set to permissive for testing
setenforce 0
```

### Container Contexts

When containerd/CRI-O launches a container, it assigns an SELinux context from the MCS (Multi-Category Security) namespace. Each container gets a unique category pair (`c123,c456`) that prevents one container from reading another's files even if both run as root:

```bash
# View the MCS context of running containers
ps -eZ | grep ' 1 $' | grep container
# system_u:system_r:container_t:s0:c245,c812  /pause
# system_u:system_r:container_t:s0:c127,c334  /app
```

### Kubernetes SELinux Configuration

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-selinux
spec:
  securityContext:
    seLinuxOptions:
      level: "s0:c123,c456"   # Specific MCS categories
  containers:
    - name: app
      image: company-registry/app:2.1.0
      securityContext:
        seLinuxOptions:
          type: "container_t"
          level: "s0:c123,c456"
```

### Custom SELinux Policy for Privileged Operations

When a container legitimately requires operations beyond `container_t`, write a custom policy module:

```bash
# Generate policy from AVC denials in permissive mode
# First, run the workload in permissive mode and collect denials
ausearch -c 'custom-app' --raw | audit2allow -M custom_app_policy

# Review the generated policy
cat custom_app_policy.te

# Install the policy module
semodule -i custom_app_policy.pp

# Verify
semodule -l | grep custom_app
```

```
# Example generated policy (custom_app_policy.te)
module custom_app_policy 1.0;

require {
    type container_t;
    type sysfs_t;
    type proc_t;
    class file { read open getattr };
    class dir { search read };
}

allow container_t sysfs_t:file { read open getattr };
allow container_t sysfs_t:dir { search read };
```

### SELinux Volume Labels

Volumes mounted into containers need correct labels. Use `seLinuxOptions` to request label relabeling:

```yaml
spec:
  securityContext:
    seLinuxOptions:
      type: svirt_sandbox_file_t
  volumes:
    - name: data
      hostPath:
        path: /data/app
  containers:
    - name: app
      volumeMounts:
        - name: data
          mountPath: /data
```

Or apply labels directly to the host directory:

```bash
# Apply correct label to host directory
chcon -Rt svirt_sandbox_file_t /data/app

# Persist across relabels
semanage fcontext -a -t svirt_sandbox_file_t "/data/app(/.*)?"
restorecon -Rv /data/app
```

## Hardening Container Runtimes

### containerd Configuration

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
  runtime_type = "io.containerd.runc.v2"

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
    SystemdCgroup = true
    NoPivotRoot    = false   # Always use pivot_root for isolation

[plugins."io.containerd.grpc.v1.cri".containerd]
  no_pivot = false
  default_runtime_name = "runc"

[plugins."io.containerd.grpc.v1.cri".cni]
  bin_dir = "/opt/cni/bin"
  conf_dir = "/etc/cni/net.d"

[plugins."io.containerd.grpc.v1.cri"]
  enable_unprivileged_ports = false
  enable_unprivileged_icmp  = false

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
    runtime_type = "io.containerd.kata.v2"
```

### Kubernetes PodSecurity with LSM Integration

```yaml
# PodSecurityPolicy successor — enforce via Pod Security Standards + LSM
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
---
# Deployment with full LSM hardening
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hardened-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hardened-app
  template:
    metadata:
      labels:
        app: hardened-app
      annotations:
        container.apparmor.security.beta.kubernetes.io/app: localhost/app-minimal
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: Localhost
          localhostProfile: profiles/app-minimal.json
        seLinuxOptions:
          type: "container_t"
          level: "s0:c200,c400"
      containers:
        - name: app
          image: company-registry/hardened-app:1.0.0
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: run
              mountPath: /run
      volumes:
        - name: tmp
          emptyDir: {}
        - name: run
          emptyDir: {}
```

## Verification and Compliance

### Automated LSM Policy Testing

```bash
#!/usr/bin/env bash
# verify-lsm-policies.sh — run from CI after profile deployment

set -euo pipefail

NAMESPACE="production"
POD_NAME="policy-test-$(date +%s)"

echo "Testing AppArmor enforcement..."

# Deploy test pod
kubectl run "${POD_NAME}" \
  --image=ubuntu:22.04 \
  --restart=Never \
  --namespace="${NAMESPACE}" \
  --overrides='{"spec":{"securityContext":{"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"test","image":"ubuntu:22.04","command":["sleep","300"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":false}}]}}' \
  --annotations="container.apparmor.security.beta.kubernetes.io/test=localhost/app-minimal"

kubectl wait pod "${POD_NAME}" -n "${NAMESPACE}" --for=condition=Ready --timeout=60s

# Test that blocked operations are denied
echo "Verifying syscall restrictions..."
if kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -- \
    bash -c 'cat /proc/kcore' 2>/dev/null; then
  echo "FAIL: /proc/kcore read should be denied"
  exit 1
else
  echo "PASS: /proc/kcore read correctly denied"
fi

# Test that allowed operations work
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -- \
    bash -c 'ls /tmp' > /dev/null && echo "PASS: /tmp access allowed"

# Cleanup
kubectl delete pod "${POD_NAME}" -n "${NAMESPACE}" --grace-period=0

echo "LSM policy verification complete."
```

### Monitoring LSM Violations

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: lsm-violation-alerts
  namespace: monitoring
spec:
  groups:
    - name: lsm.violations
      rules:
        - alert: AppArmorDenials
          expr: |
            rate(container_file_descriptors{container!=""}[5m]) > 0
            and on(pod, namespace)
            kube_pod_annotations{annotation_container_apparmor_security_beta_kubernetes_io_app!=""}
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "AppArmor denials detected on pod {{ $labels.pod }}"

        - alert: SELinuxAVCDenials
          expr: rate(node_selinux_avc_cache_misses_total[5m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High SELinux AVC denial rate on node {{ $labels.node }}"
```

## Summary

LSMs provide defense-in-depth at the kernel level for container workloads:

- **AppArmor** is operationally accessible and integrates cleanly with container runtimes via profile annotations. Start with complain mode, use `aa-genprof` to profile applications, then enforce.
- **seccomp** eliminates syscall attack surface. The `RuntimeDefault` profile is a safe baseline; custom profiles built from recorded activity achieve minimal attack surface.
- **SELinux** provides the strongest MCS isolation between containers on the same node, critical in multi-tenant environments where namespace isolation alone is insufficient.
- **seccomp-operator** and **security-profiles-operator** bring profile management into the Kubernetes API, enabling GitOps workflows for security policy.

Deploy these controls in layers: seccomp restricts what the kernel accepts from the process, AppArmor restricts what files and capabilities the process can use, and SELinux enforces type transitions across the entire system call boundary.
