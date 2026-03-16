---
title: "Kubernetes Container Runtime: containerd Configuration, CRI, and Production Optimization"
date: 2027-05-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "containerd", "CRI", "Container Runtime", "OCI", "Performance"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to containerd architecture, CRI plugin configuration, registry mirrors, garbage collection, alternate runtimes (gVisor, Kata), cgroup v2, seccomp and AppArmor profiles, crictl debugging, and upgrade procedures for Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-container-runtime-containerd-guide/"
---

containerd became the dominant Kubernetes container runtime following Docker's deprecation as a Kubernetes runtime in 1.24. Where Docker was a complete container platform with a daemon, CLI, and engine, containerd is purpose-built as a container runtime focused on the core operations Kubernetes requires: pulling images, managing snapshots, creating containers, and reporting runtime status.

Understanding containerd's architecture and configuration directly impacts cluster security, performance, and operational stability. This guide covers containerd internals, CRI configuration, registry mirror setup, garbage collection tuning, alternate runtimes for sandboxed workloads, cgroup v2 configuration, security profiles, and the crictl debugging workflow.

<!--more-->

## containerd Architecture

### Component Overview

```
                 ┌─────────────────────────────────────────┐
                 │               kubelet                   │
                 └─────────────────────┬───────────────────┘
                                       │ CRI gRPC
                                       │
                 ┌─────────────────────▼───────────────────┐
                 │              containerd                  │
                 │                                         │
                 │  ┌────────────┐   ┌──────────────────┐  │
                 │  │ CRI Plugin │   │   Task Service   │  │
                 │  └──────┬─────┘   └────────┬─────────┘  │
                 │         │                  │             │
                 │  ┌──────▼─────────────────▼─────────┐  │
                 │  │          Core Services            │  │
                 │  │                                   │  │
                 │  │  Content Store  │  Snapshotter    │  │
                 │  │  Metadata DB    │  Events         │  │
                 │  │  Diff Service   │  Leases         │  │
                 │  └──────────────────────────────────┘  │
                 │                   │                     │
                 │  ┌────────────────▼─────────────────┐  │
                 │  │           Shim API               │  │
                 │  └────────────────┬─────────────────┘  │
                 └───────────────────┼─────────────────────┘
                                     │
                    ┌────────────────┼───────────────────┐
                    │                │                   │
          ┌─────────▼──┐   ┌─────────▼──┐   ┌─────────▼──┐
          │ containerd │   │ containerd │   │ containerd │
          │ shim-runc  │   │ shim-runsc │   │ shim-kata  │
          │  (runc)    │   │  (gVisor)  │   │  (Kata)    │
          └─────────┬──┘   └─────────┬──┘   └─────────┬──┘
                    │                │                 │
               ┌────▼────┐    ┌──────▼──┐    ┌───────▼──┐
               │  runc   │    │ runsc   │    │  QEMU    │
               └─────────┘    └─────────┘    └──────────┘
```

### Core Subsystems

**Content Store**: Stores OCI content (image layers, manifests, configs) as content-addressable blobs in `/var/lib/containerd/io.containerd.content.v1.content/`. Each blob is referenced by its SHA256 digest.

**Snapshotter**: Manages filesystem snapshots for container layers. The default is `overlayfs`, which uses Linux overlay filesystem to provide efficient copy-on-write semantics. Other snapshotters include `native`, `devmapper`, and `zfs`.

**Metadata DB**: A bbolt embedded database at `/var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db` storing namespace, image, container, and snapshot metadata.

**Shim**: A lightweight process that manages the container lifecycle. Each container has a dedicated shim process, decoupling containerd's lifecycle from the container's. If containerd restarts, running containers are unaffected.

**CRI Plugin**: The gRPC server implementing the Container Runtime Interface, which kubelet calls to manage pods and containers.

## CRI Plugin Configuration

### Main Configuration File

```toml
# /etc/containerd/config.toml
version = 3

# Root directory for containerd state
root = "/var/lib/containerd"

# State directory for transient data (sockets, locks)
state = "/run/containerd"

# Temp dir for OCI bundle
temp = ""

# Address for containerd's gRPC server
[grpc]
  address = "/run/containerd/containerd.sock"
  uid = 0
  gid = 0
  max_recv_message_size = 16777216
  max_send_message_size = 16777216

# Timeouts
[timeouts]
  "io.containerd.timeout.bolt.open" = "0s"
  "io.containerd.timeout.metrics.shimstats" = "2s"
  "io.containerd.timeout.shim.cleanup" = "5s"
  "io.containerd.timeout.shim.load" = "5s"
  "io.containerd.timeout.shim.shutdown" = "3s"
  "io.containerd.timeout.task.state" = "2s"

[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    # Sandbox image for pause containers
    sandbox_image = "registry.k8s.io/pause:3.10"
    # Drain exec sync connections timeout
    drain_exec_sync_io_timeout = "0s"

    [plugins."io.containerd.grpc.v1.cri".containerd]
      # Default runtime class
      default_runtime_name = "runc"
      # Snapshotter to use for container layers
      snapshotter = "overlayfs"
      # Whether to use device mapper for devicemapper snapshotter
      discard_unpacked_layers = false

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          runtime_path = ""  # Default: /usr/bin/runc

          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            # Use cgroup v2 (recommended for Kubernetes 1.25+)
            SystemdCgroup = true
            # Binary to use for sandboxed containers
            BinaryName = ""

        # gVisor runtime class
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
          runtime_type = "io.containerd.runsc.v1"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
            TypeUrl = "io.containerd.runsc.v1.options"
            ConfigPath = "/etc/containerd/runsc.toml"

        # Kata Containers runtime class
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
          runtime_type = "io.containerd.kata.v2"
          pod_annotations = ["io.katacontainers.*"]
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
            ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration.toml"

    [plugins."io.containerd.grpc.v1.cri".cni]
      # CNI plugin directories
      bin_dir = "/opt/cni/bin"
      conf_dir = "/etc/cni/net.d"
      max_conf_num = 1
      conf_template = ""
      ip_pref = "ipv4"

    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"

    [plugins."io.containerd.grpc.v1.cri".image_decryption]
      key_model = "node"

  # Metrics plugin
  [plugins."io.containerd.internal.v1.opt"]
    path = "/opt/containerd"
```

### Registry Mirror Configuration

Registry mirrors reduce image pull latency and provide resilience against upstream registry outages.

```toml
# /etc/containerd/certs.d/docker.io/hosts.toml
server = "https://registry-1.docker.io"

[host."https://mirror.example.com"]
  capabilities = ["pull", "resolve"]
  skip_verify = false
  ca = "/etc/containerd/certs.d/docker.io/mirror-ca.crt"

[host."https://mirror.example.com".header]
  X-Registry-Mirror-Token = ["your-auth-token"]
```

```toml
# /etc/containerd/certs.d/registry.k8s.io/hosts.toml
server = "https://registry.k8s.io"

[host."https://k8s-mirror.internal.example.com"]
  capabilities = ["pull", "resolve"]
  skip_verify = false

[host."https://registry.k8s.io"]
  capabilities = ["pull", "resolve"]
```

```toml
# /etc/containerd/certs.d/_default/hosts.toml
# Default configuration for all registries not explicitly configured
# Useful for corporate proxy configurations

[host."https://proxy.internal.example.com"]
  capabilities = ["pull", "resolve"]
```

### Setting Up a Pull-Through Cache

Using distribution's pull-through cache as a registry mirror:

```yaml
# docker-compose for local registry mirror
services:
  registry:
    image: registry:2
    ports:
      - "5000:5000"
    environment:
      REGISTRY_PROXY_REMOTEURL: "https://registry-1.docker.io"
      REGISTRY_PROXY_USERNAME: ""
      REGISTRY_PROXY_PASSWORD: ""
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
      REGISTRY_HTTP_TLS_CERTIFICATE: "/certs/tls.crt"
      REGISTRY_HTTP_TLS_KEY: "/certs/tls.key"
    volumes:
      - registry-data:/var/lib/registry
      - ./certs:/certs
    restart: always

volumes:
  registry-data:
```

### Private Registry Authentication

```toml
# /etc/containerd/certs.d/registry.private.example.com/hosts.toml
server = "https://registry.private.example.com"

[host."https://registry.private.example.com"]
  capabilities = ["pull", "resolve", "push"]
  skip_verify = false
  ca = "/etc/containerd/certs.d/registry.private.example.com/ca.crt"
```

For authentication, containerd reads credentials from the standard Docker config locations when pulling:

```bash
# Create registry credentials for containerd
mkdir -p /root/.docker
cat > /root/.docker/config.json <<'EOF'
{
  "auths": {
    "registry.private.example.com": {
      "auth": "$(echo -n 'user:password' | base64)"
    }
  }
}
EOF

# For Kubernetes image pulls, use imagePullSecrets
kubectl create secret docker-registry regcred \
  --docker-server=registry.private.example.com \
  --docker-username=ci-robot \
  --docker-password="${REGISTRY_PASSWORD}" \
  --namespace=production
```

## Image Pull Policies and Performance

### Image Pull Policy Configuration

```yaml
# Pod configuration for image pull behavior
spec:
  containers:
    - name: app
      image: registry.example.com/myapp:v2.1.0
      # Always: Pull every time (never use cached image)
      # IfNotPresent: Pull only if not present locally
      # Never: Never pull; fail if not present
      imagePullPolicy: IfNotPresent  # Best for production tagged images
```

For production workloads with immutable tags (not `:latest`), `IfNotPresent` is strongly recommended. It reduces registry load and allows pods to restart after node failures without registry access.

### Pre-pulling Images

For latency-sensitive workloads, pre-pull images to all nodes:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-prepuller
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: image-prepuller
  template:
    metadata:
      labels:
        app: image-prepuller
    spec:
      initContainers:
        - name: pull-payment-api
          image: registry.example.com/payment-api:v5.0.0
          command: ["/bin/true"]
          imagePullPolicy: Always
        - name: pull-nginx
          image: registry.example.com/nginx:1.25.0
          command: ["/bin/true"]
          imagePullPolicy: Always
      containers:
        - name: placeholder
          image: registry.k8s.io/pause:3.10
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
```

### Parallel Image Pull

containerd supports parallel layer pulls. Configure via containerd config:

```toml
[plugins."io.containerd.grpc.v1.cri".containerd]
  # Maximum number of concurrent layer pulls
  # Default: 3
  max_concurrent_downloads = 5
```

## Garbage Collection

### Content Store GC

containerd periodically garbage collects unreferenced content from the content store. Configuration:

```toml
[plugins."io.containerd.metadata.v1.bolt"]
  content_sharing_policy = "shared"

[plugins."io.containerd.gc.v1.scheduler"]
  # Pause threshold — GC runs when the ratio of paused/total GC time exceeds this
  pause_threshold = 0.02
  # Deletion threshold — minimum number of deletions before GC starts
  deletion_threshold = 0
  # Mutation threshold — GC will run after this many mutations
  mutation_threshold = 100
  # Schedule for periodic GC
  schedule_delay = "0s"
  # Startup delay before first GC
  startup_delay = "100ms"
```

### Image Garbage Collection via kubelet

kubelet drives image GC based on disk usage:

```yaml
# kubelet configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# Trigger image GC when disk usage exceeds 85%
imageGCHighThresholdPercent: 85
# Stop GC when disk usage drops below 80%
imageGCLowThresholdPercent: 80
# Minimum age of an unused image before GC eligibility
minimumImageGCAge: 2m
# Maximum number of container processes
maxPods: 110
```

### Manual Image Cleanup

```bash
# List all images on a node
crictl images

# Remove a specific image
crictl rmi registry.example.com/old-app:v1.0.0

# Remove all unused images (careful: this may cause pull delays)
crictl rmi --prune

# Check content store size
du -sh /var/lib/containerd/io.containerd.content.v1.content/

# List snapshots
ctr snapshots list

# Remove a specific snapshot
ctr snapshots remove <snapshot-id>

# View garbage collection status
ctr content gc --async
```

## Alternate Runtimes

### gVisor (runsc) for Security Isolation

gVisor provides user-space kernel isolation, intercepting system calls before they reach the host kernel. Suitable for untrusted or multi-tenant workloads.

```bash
# Install gVisor
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc

# Configure gVisor
cat > /etc/containerd/runsc.toml <<'EOF'
[runsc_config]
  # Platform: ptrace (software emulation) or kvm (hardware virtualization)
  platform = "systrap"
  # Enable strace-like logging
  strace = false
  # Log system calls for debugging
  log_packets = false
EOF
```

RuntimeClass for gVisor:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
overhead:
  podFixed:
    memory: "100Mi"
    cpu: "100m"
scheduling:
  nodeClassification:
    tolerations:
      - key: "sandbox"
        operator: "Equal"
        value: "gvisor"
        effect: "NoSchedule"
```

Using gVisor for a pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sandboxed-workload
spec:
  runtimeClassName: gvisor
  containers:
    - name: app
      image: registry.example.com/untrusted-app:latest
      resources:
        requests:
          cpu: 200m
          memory: 256Mi
        limits:
          cpu: "1"
          memory: 512Mi
```

### Kata Containers for VM-Level Isolation

Kata Containers runs each pod in a lightweight VM, providing stronger isolation than gVisor for compliance-sensitive workloads.

```bash
# Install Kata on Ubuntu
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kata-containers/kata-containers/main/utils/kata-manager.sh) install-kata-tools"

# Verify installation
kata-runtime check
```

```yaml
# RuntimeClass for Kata Containers
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-containers
handler: kata
overhead:
  podFixed:
    memory: "500Mi"
    cpu: "250m"
scheduling:
  nodeClassification:
    tolerations:
      - key: "kata"
        operator: "Exists"
        effect: "NoSchedule"
---
# Pod using Kata runtime
apiVersion: v1
kind: Pod
metadata:
  name: vm-isolated-workload
spec:
  runtimeClassName: kata-containers
  containers:
    - name: app
      image: registry.example.com/payment-processor:v3.0.0
```

### Runtime Class Comparison

| Runtime | Isolation | Performance | Use Case |
|---------|-----------|-------------|---------|
| `runc` | Linux namespaces + cgroups | Native | General workloads |
| `runsc` (gVisor) | User-space kernel | ~15-20% overhead | Untrusted code, multi-tenant |
| `kata` | Full VM | ~10-30% overhead | Compliance, strong isolation |
| `runhcs` | Hyper-V container | Windows-only | Windows workloads on AKS |

## cgroup v2 Configuration

### Enabling cgroup v2

cgroup v2 provides unified hierarchy and improved resource control. Required for some Kubernetes features including Pod QoS guarantees.

```bash
# Check current cgroup version
stat -fc %T /sys/fs/cgroup

# Enable cgroup v2 in GRUB (Ubuntu/Debian)
# Add to /etc/default/grub:
# GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
sudo grub-mkconfig -o /boot/grub/grub.cfg

# Enable in kernel command line (RHEL/Fedora)
sudo grubby --update-kernel=ALL --args="systemd.unified_cgroup_hierarchy=1"

# Verify after reboot
cat /proc/cmdline | grep unified_cgroup
ls /sys/fs/cgroup/  # Should show unified hierarchy, not v1 controllers
```

### containerd with cgroup v2

```toml
# Enable systemd cgroup driver (required for cgroup v2)
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

kubelet configuration for cgroup v2:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd    # Must match containerd's SystemdCgroup setting
cgroupsPerQOS: true
enforceNodeAllocatable:
  - pods
  - system-reserved
  - kube-reserved
systemReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "10Gi"
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "10Gi"
```

### Memory QoS with cgroup v2

cgroup v2 enables memory.high for Memory QoS (MemoryQoS feature gate):

```yaml
# Pod with MemoryQoS hints
apiVersion: v1
kind: Pod
metadata:
  name: memory-qos-pod
  annotations:
    # Enable MemoryQoS for this pod
    memory.alpha.kubernetes.io/memoryThrottlingFactor: "0.9"
spec:
  containers:
    - name: app
      resources:
        requests:
          memory: "256Mi"
        limits:
          memory: "512Mi"
      # With MemoryQoS:
      # memory.min = requests.memory (256Mi)
      # memory.high = requests.memory + (limits - requests) * throttlingFactor
      #             = 256Mi + (512Mi - 256Mi) * 0.9 = 486Mi
      # memory.max = limits.memory (512Mi)
```

## Security Profiles: seccomp and AppArmor

### seccomp Profiles

seccomp filters system calls, reducing the kernel attack surface. containerd supports the OCI seccomp specification.

```json
// /etc/containerd/seccomp-profiles/custom-profile.json
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
        "accept4", "bind", "brk", "clone", "close", "connect",
        "epoll_create1", "epoll_ctl", "epoll_wait", "execve",
        "exit", "exit_group", "fstat", "futex", "getdents64",
        "getpid", "getppid", "gettimeofday", "listen", "lstat",
        "mmap", "mprotect", "munmap", "nanosleep", "open", "openat",
        "pipe2", "prctl", "pread64", "prlimit64", "read", "recvfrom",
        "recvmsg", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "sched_getaffinity", "sched_yield", "sendmsg", "sendto",
        "set_tid_address", "setitimer", "sigaltstack", "socket",
        "stat", "statx", "uname", "wait4", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Applying seccomp profiles in pods:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: seccomp-pod
spec:
  securityContext:
    # Use the default RuntimeDefault profile (recommended minimum)
    seccompProfile:
      type: RuntimeDefault
      # Or use a custom profile:
      # type: Localhost
      # localhostProfile: custom-profile.json
  containers:
    - name: app
      image: registry.example.com/app:v1.0.0
      securityContext:
        # Container-level seccomp overrides pod-level
        seccompProfile:
          type: RuntimeDefault
```

### AppArmor Profiles

```bash
# Load a custom AppArmor profile
cat > /etc/apparmor.d/k8s-app-profile <<'EOF'
#include <tunables/global>

profile k8s-app-profile flags=(attach_disconnected, mediate_deleted) {
  #include <abstractions/base>

  file,
  network inet tcp,
  network inet udp,

  deny network raw,
  deny /proc/** w,
  deny /sys/** w,
  deny /dev/shm/** rwkl,

  /app/server rix,
  /etc/ssl/certs/** r,
  /tmp/** rwk,
}
EOF

apparmor_parser -r /etc/apparmor.d/k8s-app-profile
```

Using AppArmor in pods (Kubernetes 1.30+ uses `securityContext`):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: apparmor-pod
spec:
  securityContext:
    appArmorProfile:
      type: Localhost
      localhostProfile: k8s-app-profile
  containers:
    - name: app
      image: registry.example.com/app:v1.0.0
```

## crictl Debugging Workflow

### Essential crictl Commands

crictl is the CLI for debugging containerd CRI operations, equivalent to docker for container management.

```bash
# Configure crictl to connect to containerd
cat > /etc/crictl.yaml <<'EOF'
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
pull-image-on-create: false
disable-pull-on-run: false
EOF

# List running pods
crictl pods

# List running containers
crictl ps

# List all containers including stopped
crictl ps -a

# Get detailed info about a pod
crictl inspectp <pod-id>

# Get detailed info about a container
crictl inspect <container-id>

# View container logs
crictl logs <container-id>
crictl logs --tail 100 -f <container-id>

# Execute command in container
crictl exec -it <container-id> /bin/sh

# List images
crictl images

# Pull an image
crictl pull registry.example.com/app:v1.0.0

# Inspect an image
crictl inspecti registry.example.com/app:v1.0.0

# Image statistics
crictl imagefsinfo
```

### Debugging Image Pull Issues

```bash
# Check image pull status
crictl pull --debug registry.example.com/app:v1.0.0 2>&1

# Check containerd service logs
journalctl -u containerd -f --since "5 minutes ago"

# Check for registry connectivity
curl -v --cacert /etc/containerd/certs.d/registry.example.com/ca.crt \
  https://registry.example.com/v2/

# Test authentication
crictl pull --auth "$(echo -n 'user:pass' | base64)" \
  registry.example.com/private-app:v1.0.0

# Check DNS resolution for registry
nslookup registry.example.com
# Check proxy settings
env | grep -i proxy
```

### Debugging Container Runtime Issues

```bash
# Check containerd status
systemctl status containerd
ctr version

# List all namespaces in containerd
ctr namespaces list

# List containers in the k8s.io namespace (Kubernetes uses this)
ctr -n k8s.io containers list

# List tasks (running containers)
ctr -n k8s.io tasks list

# Inspect a container's configuration
ctr -n k8s.io containers info <container-id>

# Check snapshot usage
ctr -n k8s.io snapshots usage <snapshot-id>

# Dump container metrics
ctr -n k8s.io tasks metrics <task-id>

# Check for zombie shim processes
ps aux | grep "containerd-shim" | grep -v grep

# Kill a stuck container (last resort)
ctr -n k8s.io tasks kill --signal SIGKILL <task-id>
ctr -n k8s.io tasks delete <task-id>
ctr -n k8s.io containers delete <container-id>
```

### Container Runtime Debugging Scripts

```bash
#!/bin/bash
# containerd-health-check.sh

echo "=== containerd Health Check ==="
echo "Timestamp: $(date)"
echo ""

# Service status
echo "--- Service Status ---"
systemctl is-active containerd && echo "containerd: RUNNING" || echo "containerd: STOPPED"
echo "Uptime: $(systemctl show containerd --property=ActiveEnterTimestamp --value)"
echo ""

# Version info
echo "--- Version ---"
ctr version 2>/dev/null || echo "Cannot connect to containerd socket"
echo ""

# Socket permissions
echo "--- Socket ---"
ls -la /run/containerd/containerd.sock
echo ""

# Disk usage
echo "--- Storage ---"
df -h /var/lib/containerd
echo ""
du -sh /var/lib/containerd/io.containerd.content.v1.content/ 2>/dev/null
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/ 2>/dev/null
echo ""

# Pod/container counts
echo "--- Runtime Counts ---"
echo "Pods: $(crictl pods --no-trunc 2>/dev/null | tail -n +2 | wc -l)"
echo "Containers (running): $(crictl ps 2>/dev/null | tail -n +2 | wc -l)"
echo "Containers (total): $(crictl ps -a 2>/dev/null | tail -n +2 | wc -l)"
echo "Images: $(crictl images 2>/dev/null | tail -n +2 | wc -l)"
echo ""

# Recent errors
echo "--- Recent Errors ---"
journalctl -u containerd --since "30 minutes ago" -p err --no-pager | tail -20
```

## containerd Metrics

### Prometheus Metrics

containerd exposes metrics via the metrics plugin:

```toml
# Enable metrics in containerd config
[metrics]
  address = "127.0.0.1:1338"
  grpc_histogram = false
```

Key metrics to monitor:

```promql
# Image pull duration
histogram_quantile(0.99,
  rate(containerd_pull_operations_seconds_bucket[5m])
)

# Container creation latency
histogram_quantile(0.99,
  rate(containerd_container_create_seconds_bucket[5m])
)

# Content store size
containerd_content_bytes_total

# Active tasks (running containers)
containerd_tasks_running

# Snapshot count by type
containerd_snapshots_total{type="overlayfs"}

# GC duration
containerd_gc_duration_seconds
```

### Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: containerd-metrics
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - kube-system
  selector:
    matchLabels:
      app: containerd-metrics
  endpoints:
    - port: metrics
      interval: 30s
      path: /v1/metrics
---
apiVersion: v1
kind: Service
metadata:
  name: containerd-metrics
  namespace: kube-system
  labels:
    app: containerd-metrics
spec:
  clusterIP: None
  selector:
    component: kube-node  # Matches node-level services
  ports:
    - name: metrics
      port: 1338
      targetPort: 1338
```

### Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: containerd-alerts
  namespace: monitoring
spec:
  groups:
    - name: containerd
      rules:
        - alert: ContainerdHighImagePullLatency
          expr: |
            histogram_quantile(0.99,
              rate(containerd_pull_operations_seconds_bucket[5m])
            ) > 60
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "containerd image pull p99 latency > 60s on {{ $labels.node }}"
            description: "High image pull latency may indicate registry issues or insufficient bandwidth."

        - alert: ContainerdServiceDown
          expr: up{job="containerd-metrics"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "containerd metrics endpoint down on {{ $labels.instance }}"

        - alert: ContainerdHighContentStoreSize
          expr: |
            containerd_content_bytes_total > (20 * 1024 * 1024 * 1024)
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "containerd content store > 20GB on {{ $labels.node }}"
            description: "Consider enabling more aggressive image GC or increasing disk capacity."
```

## containerd Upgrade Procedures

### Pre-Upgrade Validation

```bash
#!/bin/bash
# pre-containerd-upgrade.sh

NODE="${1:?Node name required}"
NEW_VERSION="${2:?New version required}"

echo "=== Pre-upgrade validation for ${NODE} ==="

# Check current version
CURRENT_VERSION=$(ctr version | grep -i server | grep -oP 'v\d+\.\d+\.\d+')
echo "Current containerd version: ${CURRENT_VERSION}"
echo "Target containerd version: ${NEW_VERSION}"

# Check Kubernetes version compatibility
K8S_VERSION=$(kubectl version --output=json | jq -r '.serverVersion.gitVersion')
echo "Kubernetes version: ${K8S_VERSION}"

# Verify containerd/Kubernetes compatibility matrix
# https://github.com/containerd/containerd/blob/main/docs/kubernetes-support.md

# Count running pods on node
POD_COUNT=$(kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=${NODE}" \
  --no-headers | wc -l)
echo "Pods on node: ${POD_COUNT}"

# Check for any critical system pods
CRITICAL_PODS=$(kubectl get pods -n kube-system \
  --field-selector "spec.nodeName=${NODE}" \
  --no-headers | awk '{print $1}')
echo "System pods: ${CRITICAL_PODS}"

echo ""
echo "Pre-upgrade checklist:"
echo "[ ] Node cordoned"
echo "[ ] Pods drained or rescheduled"
echo "[ ] containerd configuration backed up"
echo "[ ] Rollback plan documented"
```

### Upgrade Procedure

```bash
#!/bin/bash
# upgrade-containerd.sh

NODE="${1:?Node name required}"
NEW_VERSION="${2:?New version required}"  # e.g., 2.0.1

echo "=== Upgrading containerd to ${NEW_VERSION} on ${NODE} ==="

# Step 1: Cordon the node
kubectl cordon "${NODE}"
echo "Node cordoned"

# Step 2: Drain non-daemonset pods
kubectl drain "${NODE}" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s
echo "Node drained"

# Step 3: On the node (run as root)
ssh "${NODE}" bash <<'REMOTE_SCRIPT'
set -euo pipefail

NEW_VERSION="$1"

# Backup current config
cp /etc/containerd/config.toml /etc/containerd/config.toml.backup.$(date +%Y%m%d-%H%M%S)

# Download new version
curl -fsSL "https://github.com/containerd/containerd/releases/download/v${NEW_VERSION}/containerd-${NEW_VERSION}-linux-amd64.tar.gz" \
  -o /tmp/containerd-${NEW_VERSION}.tar.gz

# Verify checksum
curl -fsSL "https://github.com/containerd/containerd/releases/download/v${NEW_VERSION}/containerd-${NEW_VERSION}-linux-amd64.tar.gz.sha256sum" \
  -o /tmp/containerd-${NEW_VERSION}.tar.gz.sha256sum
sha256sum -c /tmp/containerd-${NEW_VERSION}.tar.gz.sha256sum

# Stop containerd
systemctl stop containerd

# Install new binaries
tar -xzf /tmp/containerd-${NEW_VERSION}.tar.gz -C /usr/local

# Verify new binary
containerd --version

# Start containerd
systemctl start containerd

# Verify service health
sleep 5
systemctl is-active containerd && echo "containerd started successfully" || {
  echo "containerd failed to start — rolling back"
  # Restore old binaries from package manager or backup
  systemctl status containerd
  exit 1
}

# Verify CRI functionality
crictl info
REMOTE_SCRIPT "${NEW_VERSION}"

# Step 4: Uncordon the node
kubectl uncordon "${NODE}"
echo "Node uncordoned"

# Step 5: Verify pod restoration
sleep 30
CURRENT_PODS=$(kubectl get pods --all-namespaces \
  --field-selector "spec.nodeName=${NODE}" \
  --no-headers | grep -v "Completed" | wc -l)
echo "Pods running on node after upgrade: ${CURRENT_PODS}"

# Verify containerd version
NEW_INSTALLED=$(ssh "${NODE}" "ctr version | grep -i server" )
echo "Installed version: ${NEW_INSTALLED}"
```

### Rolling Upgrade Across Cluster

```bash
#!/bin/bash
# rolling-containerd-upgrade.sh

NEW_VERSION="${1:?Version required}"
NODES=$(kubectl get nodes --no-headers -o custom-columns="NAME:.metadata.name" | grep -v master)

for NODE in ${NODES}; do
  echo ""
  echo "=== Upgrading node: ${NODE} ==="

  # Run upgrade
  ./upgrade-containerd.sh "${NODE}" "${NEW_VERSION}"

  # Wait for node to be ready
  echo "Waiting for ${NODE} to be Ready..."
  kubectl wait node "${NODE}" --for=condition=Ready --timeout=300s

  # Verify all pods are running
  sleep 30
  NOT_READY=$(kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=${NODE}" \
    --no-headers | grep -v Running | grep -v Completed | wc -l)

  if [ "${NOT_READY}" -gt 0 ]; then
    echo "WARNING: ${NOT_READY} pods are not Running on ${NODE}"
    kubectl get pods --all-namespaces \
      --field-selector "spec.nodeName=${NODE}" | \
      grep -v Running | grep -v Completed

    read -rp "Continue with next node? [y/N] " CONTINUE
    if [ "${CONTINUE}" != "y" ]; then
      echo "Upgrade paused. Investigate issues before continuing."
      exit 1
    fi
  fi

  echo "Node ${NODE} upgrade complete"

  # Brief pause between nodes
  sleep 10
done

echo ""
echo "=== Upgrade complete ==="
kubectl get nodes -o custom-columns="NAME:.metadata.name,VERSION:.status.nodeInfo.containerRuntimeVersion"
```

## Image Layer Caching Optimization

### Snapshotter Performance

The overlayfs snapshotter performance depends on the underlying filesystem. For production workloads:

```bash
# Verify overlayfs support
modprobe overlay
cat /proc/filesystems | grep overlay

# Use XFS or ext4 on the data volume for best performance
# XFS is recommended for overlayfs with many layers
lsblk
mount | grep containerd

# Create dedicated volume for containerd
mkfs.xfs -n ftype=1 /dev/sdb  # ftype=1 required for overlayfs
mount -o defaults,noatime /dev/sdb /var/lib/containerd

# Add to /etc/fstab for persistence
echo "/dev/sdb /var/lib/containerd xfs defaults,noatime 0 2" >> /etc/fstab
```

### Image Layer Sharing Analysis

```bash
# Analyze image layer sharing across images
ctr -n k8s.io images ls -q | while read -r image; do
  ctr -n k8s.io images export /dev/null "${image}" 2>/dev/null
  echo "Layers for ${image}:"
  ctr -n k8s.io content ls | wc -l
done

# Find large image layers
ctr -n k8s.io content ls | \
  sort -k4 -h | tail -20 | \
  awk '{print $4, $1}'

# Check disk space savings from deduplication
df -h /var/lib/containerd/
du -sh /var/lib/containerd/io.containerd.content.v1.content/
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/
```

## Summary

containerd provides the foundation for Kubernetes container lifecycle management. Key operational recommendations for production clusters:

- Always enable `SystemdCgroup = true` for cgroup v2 compatibility and reliable resource accounting
- Configure registry mirrors for all critical registries to reduce pull latency and eliminate single points of failure
- Set appropriate image GC thresholds — `imageGCHighThresholdPercent: 85` is appropriate for most clusters, but storage-constrained nodes may need `80`
- Use RuntimeClass to route sandboxed workloads (untrusted code, compliance-sensitive processing) to gVisor or Kata Containers runtimes
- Apply `RuntimeDefault` seccomp profiles to all pods — this reduces attack surface with minimal performance impact
- Monitor containerd metrics alongside Kubernetes metrics — image pull latency and GC frequency are early indicators of storage pressure
- Perform containerd upgrades with node drain/cordon to eliminate runtime disruption to existing workloads
- Maintain dedicated storage volumes for `/var/lib/containerd` using XFS with `ftype=1` to prevent unexpected filesystem failures from impacting the container runtime
