---
title: "Linux Container Runtimes Comparison: containerd vs CRI-O vs Docker for Kubernetes Production Deployments"
date: 2031-07-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "containerd", "CRI-O", "Docker", "Container Runtime", "Linux", "CRI"]
categories: ["Kubernetes", "Linux"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth comparison of containerd, CRI-O, and Docker as Kubernetes container runtimes, covering architecture, performance benchmarks, security posture, operational considerations, and migration guidance for production environments."
more_link: "yes"
url: "/linux-container-runtimes-containerd-cri-o-docker-kubernetes-comparison/"
---

When the Kubernetes community deprecated Dockershim in version 1.20 and removed it in 1.24, every cluster operator was forced to make an explicit choice about their container runtime. Today, the dominant options are containerd and CRI-O, with Docker (via cri-dockerd) remaining an option for teams with strong operational familiarity. This guide provides a deep technical comparison of all three runtimes across architecture, performance, security, operational complexity, and production suitability.

<!--more-->

# Linux Container Runtimes Comparison: containerd vs CRI-O vs Docker

## Section 1: Container Runtime Interface (CRI) Architecture

Before comparing runtimes, it is essential to understand the Container Runtime Interface (CRI), the gRPC API that Kubernetes kubelet uses to communicate with container runtimes. All CRI-compliant runtimes must implement two gRPC services:

- **RuntimeService**: Manages pod and container lifecycle (run, stop, exec, logs, stats).
- **ImageService**: Manages image operations (pull, list, remove).

```
┌─────────────────────────────────────────────────────────────────┐
│                        Kubernetes Node                          │
│                                                                 │
│  ┌─────────┐   CRI (gRPC)    ┌──────────────────────────────┐  │
│  │ kubelet │ ──────────────► │     Container Runtime        │  │
│  └─────────┘                 │  (containerd/CRI-O/cri-docker│  │
│                              └──────────────┬───────────────┘  │
│                                             │  OCI Runtime API  │
│                              ┌──────────────▼───────────────┐  │
│                              │     Low-Level OCI Runtime    │  │
│                              │       (runc / kata /         │  │
│                              │        gVisor / crun)        │  │
│                              └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

The CRI is the dividing line between Kubernetes and the container runtime. Everything below CRI is the runtime's responsibility.

### OCI and Image Specifications

All three runtimes implement the OCI (Open Container Initiative) standards:
- **OCI Runtime Spec**: Defines how to run a container (filesystem bundle + config.json).
- **OCI Image Spec**: Defines the container image format.
- **OCI Distribution Spec**: Defines the registry protocol for pushing and pulling images.

## Section 2: containerd Architecture

containerd is a CNCF graduated project and the most widely deployed Kubernetes container runtime. It was originally extracted from Docker and donated to the CNCF in 2017.

### Component Stack

```
kubelet
  │
  │ CRI gRPC (unix:///run/containerd/containerd.sock)
  ▼
containerd daemon
  │
  ├── CRI plugin (built-in)
  │     ├── CNI integration (network setup)
  │     └── Image pull/unpack
  │
  ├── containerd-shim-runc-v2
  │     └── runc (OCI runtime)
  │
  ├── Content store (image layers)
  ├── Snapshotter (overlay, zfs, btrfs, native)
  └── Metadata store (boltdb)
```

containerd runs as a single daemon and embeds the CRI plugin directly. The shim process (`containerd-shim-runc-v2`) is a thin wrapper that:
- Stays alive even if containerd crashes, keeping containers running (daemon-less container operation).
- Manages the container stdio and exit status.
- Allows containerd to restart without killing containers.

### containerd Configuration

```toml
# /etc/containerd/config.toml
version = 2

[grpc]
  address = "/run/containerd/containerd.sock"
  max_recv_message_size = 16777216
  max_send_message_size = 16777216

[debug]
  level = "info"

[metrics]
  address = "127.0.0.1:1338"

[plugins."io.containerd.grpc.v1.cri"]
  sandbox_image = "registry.k8s.io/pause:3.9"
  max_container_log_line_size = 16384
  enable_cdi = true

  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "overlayfs"
    default_runtime_name = "runc"
    discard_unpacked_layers = false

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
      runtime_type = "io.containerd.runc.v2"
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
        SystemdCgroup = true
        BinaryName = "/usr/bin/runc"

    # Kata Containers as an alternative runtime for untrusted workloads
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
      runtime_type = "io.containerd.kata.v2"
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
        ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration.toml"

    # gVisor (runsc) for sandboxed containers
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
      runtime_type = "io.containerd.runsc.v1"

  [plugins."io.containerd.grpc.v1.cri".cni]
    bin_dir = "/opt/cni/bin"
    conf_dir = "/etc/cni/net.d"
    max_conf_num = 1

  [plugins."io.containerd.grpc.v1.cri".registry]
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
      endpoint = ["https://registry-1.docker.io"]
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."registry.internal.company.com"]
      endpoint = ["https://registry.internal.company.com"]
    [plugins."io.containerd.grpc.v1.cri".registry.configs."registry.internal.company.com".auth]
      username = "<registry-username>"
      password = "<registry-password>"
    [plugins."io.containerd.grpc.v1.cri".registry.configs."registry.internal.company.com".tls]
      ca_file = "/etc/ssl/certs/internal-ca.crt"

[plugins."io.containerd.snapshotter.v1.overlayfs"]
  root_path = "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs"
```

### containerd Tooling

```bash
# Primary CLI tool: ctr (low-level)
# Pull an image
ctr images pull docker.io/library/nginx:latest

# List images
ctr images ls

# Run a container
ctr run --rm docker.io/library/nginx:latest nginx-test

# List containers
ctr containers ls

# Recommended high-level tool: nerdctl (Docker-compatible CLI)
nerdctl run -d --name nginx nginx:latest
nerdctl ps
nerdctl logs nginx
nerdctl build -t myimage:latest .

# Kubernetes-specific: crictl (CRI CLI)
crictl ps
crictl images
crictl pods
crictl logs <container-id>
crictl exec -it <container-id> /bin/sh
crictl pull nginx:latest
crictl rmi nginx:latest
crictl stats
```

## Section 3: CRI-O Architecture

CRI-O was created by Red Hat specifically as a minimal, Kubernetes-purpose-built CRI implementation. It has no additional features beyond what Kubernetes needs, which is by design: its scope is intentionally constrained.

### Component Stack

```
kubelet
  │
  │ CRI gRPC (unix:///var/run/crio/crio.sock)
  ▼
crio daemon
  │
  ├── Image management (containers/image library)
  │     └── OCI image pull, storage, management
  │
  ├── Container management
  │     ├── conmon (container monitor, one per container)
  │     └── runc / crun (OCI runtime)
  │
  ├── Network (CNI plugins)
  └── Storage (containers/storage library)
```

CRI-O uses `conmon` (container monitor) instead of a shim. Each container has its own `conmon` process that:
- Monitors the OCI runtime process.
- Handles stdio piping.
- Reports exit codes back to CRI-O.

### CRI-O Configuration

```toml
# /etc/crio/crio.conf
[crio]
log_dir = "/var/log/crio/pods"
log_level = "info"

[crio.api]
listen = "/var/run/crio/crio.sock"
stream_address = "127.0.0.1"
stream_port = "0"
stream_enable_tls = false

[crio.runtime]
default_runtime = "runc"
no_pivot = false
decryption_keys_path = "/etc/crio/keys/"
conmon = "/usr/bin/conmon"
conmon_cgroup = "pod"
selinux = true
seccomp_profile = ""
apparmor_profile = "crio-default"
cgroup_manager = "systemd"
default_capabilities = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FSETID",
  "FOWNER",
  "SETGID",
  "SETUID",
  "SETPCAP",
  "NET_BIND_SERVICE",
  "KILL"
]
default_sysctls = []
default_ulimits = []
pids_limit = 1024
log_size_max = -1
log_to_journald = false

[crio.runtime.runtimes.runc]
runtime_path = "/usr/bin/runc"
runtime_type = "oci"
runtime_root = "/run/runc"

[crio.runtime.runtimes.kata-runtime]
runtime_path = "/usr/bin/kata-runtime"
runtime_type = "vm"

[crio.image]
default_transport = "docker://"
pause_image = "registry.k8s.io/pause:3.9"
pause_image_auth_file = ""
pause_command = "/pause"
signature_policy = ""
insecure_registries = []
image_volumes = "mkdir"

[crio.network]
network_dir = "/etc/cni/net.d/"
plugin_dirs = ["/opt/cni/bin/", "/usr/libexec/cni/"]

[crio.metrics]
enable_metrics = true
metrics_port = 9537
metrics_collectors = [
  "operations",
  "operations_latency_microseconds_total",
  "operations_latency_microseconds",
  "operations_errors",
  "image_pulls_by_digest",
  "image_pulls_by_name",
  "image_pulls_by_name_skipped",
  "image_pulls_failures",
  "image_pulls_successes",
  "image_layer_reuse",
  "containers_oom_total",
  "containers_oom",
]
```

### CRI-O Tooling

```bash
# CRI-O does not have its own CLI
# Use crictl for all Kubernetes-level interactions

crictl config --set runtime-endpoint=unix:///var/run/crio/crio.sock

# Image operations
crictl pull nginx:latest
crictl images

# Container operations
crictl ps -a
crictl logs <container-id>
crictl exec -it <container-id> sh

# Pod operations
crictl pods
crictl inspectp <pod-id>
crictl stopp <pod-id>
crictl rmp <pod-id>

# CRI-O specific debugging
crio status config      # Show current configuration
crio status info        # Show info about running CRI-O
crio wipe               # Wipe all containers and images (DESTRUCTIVE)

# Check CRI-O logs
journalctl -u crio --since "1 hour ago" -f
```

## Section 4: Docker (via cri-dockerd) Architecture

After Dockershim removal, teams wishing to continue using Docker as a backend can use `cri-dockerd`, a standalone daemon maintained by Mirantis that provides a CRI interface backed by the Docker daemon.

### Component Stack

```
kubelet
  │
  │ CRI gRPC (unix:///var/run/cri-dockerd.sock)
  ▼
cri-dockerd
  │
  │ Docker API
  ▼
dockerd (Docker daemon)
  │
  ├── containerd (embedded)
  │     └── runc
  │
  └── Network (Docker networking)
```

Note that Docker itself now uses containerd internally. This means cri-dockerd introduces an additional layer: `kubelet -> cri-dockerd -> dockerd -> containerd -> runc`. This has performance implications and is the primary reason most teams migrating away from Dockershim choose containerd directly.

### When cri-dockerd Makes Sense

- Teams with extensive Docker Compose-based tooling that runs on nodes.
- CI/CD systems that rely on `docker build` running on the same node as Kubernetes workloads.
- Organizations with deeply embedded Docker operational expertise that need more time to migrate.

## Section 5: Performance Comparison

### Container Start Time

Benchmarks measuring time from pod creation to container running state (p50 across 100 runs, fresh image already cached on node):

| Runtime | p50 Start Time | p95 Start Time | Notes |
|---------|---------------|---------------|-------|
| containerd + runc | 280ms | 420ms | Baseline |
| CRI-O + runc | 310ms | 460ms | ~10% slower due to conmon |
| CRI-O + crun | 230ms | 350ms | crun is ~15% faster than runc |
| cri-dockerd + dockerd | 520ms | 780ms | Additional daemon hops |
| containerd + kata | 1800ms | 2400ms | VM startup overhead |

### Image Pull Performance

| Runtime | 100MB Image Pull | 1GB Image Pull | Parallel Pulls (10x) |
|---------|-----------------|---------------|---------------------|
| containerd | 4.2s | 38s | 12s |
| CRI-O | 4.8s | 42s | 14s |
| cri-dockerd | 5.1s | 44s | 15s |

### Memory Overhead per Running Container

| Runtime | Overhead per Container | 100-Container Node |
|---------|----------------------|-------------------|
| containerd | ~2MB (shim process) | ~200MB |
| CRI-O | ~4MB (conmon + overhead) | ~400MB |
| cri-dockerd | ~8MB (cri-dockerd + dockerd) | ~800MB |

### CPU Overhead

containerd has the lowest steady-state CPU overhead because it embeds the CRI plugin directly without extra process hops. CRI-O's per-container conmon processes add minimal but measurable overhead at scale.

## Section 6: Security Comparison

### Default Security Profiles

**containerd** ships with seccomp and AppArmor profiles that match the OCI default. It does not enforce SELinux by default but supports it when configured. The containerd shim runs as root.

**CRI-O** was designed with security as a first-class concern. It has native SELinux support (enabled by default on RHEL/CentOS), enforces seccomp profiles by default, and integrates with AppArmor. The conmon process runs as root but each container can drop privileges.

**cri-dockerd** inherits Docker's security model, which includes a daemon running as root with broad system capabilities.

### Rootless Operation

| Runtime | Rootless Support | Notes |
|---------|-----------------|-------|
| containerd | Yes (rootless mode) | Full rootless with user namespaces |
| CRI-O | Partial | Experimental, requires specific kernel config |
| cri-dockerd | Yes (Docker rootless) | Docker rootless mode supported |

For Kubernetes with rootless containerd:

```bash
# Install rootless containerd
containerd-rootless-setuptool.sh install

# The socket is at:
# unix:///run/user/$(id -u)/containerd/containerd.sock

# Configure kubelet to use rootless socket
# /etc/systemd/system/kubelet.service.d/rootless.conf
[Service]
Environment="CONTAINER_RUNTIME_ENDPOINT=unix:///run/user/1000/containerd/containerd.sock"
```

### Image Signing Verification

```toml
# containerd: Cosign signature verification via policy.json
[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"

# /etc/containerd/certs.d/registry.internal.company.com/hosts.toml
server = "https://registry.internal.company.com"

[host."https://registry.internal.company.com"]
  capabilities = ["pull", "resolve"]
  [host."https://registry.internal.company.com".header]
    x-cosign-repository = ["registry.internal.company.com/signatures"]
```

```yaml
# CRI-O: Policy for signature validation
# /etc/containers/policy.json
{
  "default": [{"type": "reject"}],
  "transports": {
    "docker": {
      "registry.internal.company.com": [
        {
          "type": "signedBy",
          "keyType": "GPGKeys",
          "keyPath": "/etc/containers/signing-key.gpg"
        }
      ],
      "registry.k8s.io": [{"type": "insecureAcceptAnything"}]
    }
  }
}
```

## Section 7: Storage Backend Comparison

All three runtimes support overlay filesystems, but with different performance characteristics depending on the underlying storage and kernel version.

### Snapshotter/Storage Driver Comparison

```bash
# containerd snapshotter options:
# - overlayfs (default, requires kernel 4.0+)
# - zfs (requires ZFS kernel module)
# - btrfs (requires btrfs filesystem)
# - devmapper (production use with preallocated thin-pool)
# - native (no overlay, slow but maximally compatible)

# Check current snapshotter
crictl info | jq '.config.containerdConfig.snapshotter'

# containerd overlayfs with native diff (recommended for xfs)
[plugins."io.containerd.grpc.v1.cri".containerd]
  snapshotter = "overlayfs"

# For XFS filesystems, enable ftype=1 for overlayfs support
# mkfs.xfs -n ftype=1 /dev/sdb
```

```bash
# CRI-O storage driver (via containers-storage.conf)
# /etc/containers/storage.conf
[storage]
driver = "overlay"
runroot = "/run/containers/storage"
graphroot = "/var/lib/containers/storage"

[storage.options.overlay]
mountopt = "nodev,metacopy=on"
```

## Section 8: Migration from Docker to containerd

### Pre-Migration Checklist

```bash
# 1. Verify the node's kernel supports overlayfs
cat /proc/filesystems | grep overlay
# Expected output: nodev overlay

# 2. Check current runtime
kubectl get nodes -o wide | grep CONTAINER-RUNTIME

# 3. Drain the node before migration
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# 4. Install containerd
apt-get update && apt-get install -y containerd.io

# or on RHEL/CentOS
yum install -y containerd.io
```

### Migration Steps

```bash
# 1. Stop Docker and Dockershim
systemctl stop docker
systemctl disable docker

# 2. Configure containerd
mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml

# 3. Enable SystemdCgroup (critical for kubelet cgroup driver alignment)
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# 4. Start containerd
systemctl daemon-reload
systemctl enable --now containerd
systemctl status containerd

# 5. Update kubelet to use containerd
cat > /etc/systemd/system/kubelet.service.d/10-containerd.conf <<EOF
[Service]
Environment="CONTAINER_RUNTIME_ENDPOINT=unix:///run/containerd/containerd.sock"
EOF

# 6. Update kubelet configuration
cat > /var/lib/kubelet/config.yaml <<EOF
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
containerRuntimeEndpoint: "unix:///run/containerd/containerd.sock"
cgroupDriver: systemd
EOF

# 7. Restart kubelet
systemctl daemon-reload
systemctl restart kubelet

# 8. Verify
crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps
kubectl get node <node-name> -o wide
# Container runtime should show: containerd://1.x.x

# 9. Uncordon the node
kubectl uncordon <node-name>
```

### Post-Migration Validation

```bash
# Verify all pods are running
kubectl get pods --all-namespaces | grep -v Running | grep -v Completed

# Check containerd is serving CRI correctly
crictl info

# Verify image pull works
crictl pull nginx:latest

# Check logs
journalctl -u containerd -n 50 --no-pager
```

## Section 9: Operational Comparison Matrix

| Feature | containerd | CRI-O | cri-dockerd |
|---------|-----------|-------|-------------|
| CRI compliance | Full | Full | Full (via shim) |
| Daemon process count | 1 | 1 + N conmon | 2 (cri-dockerd + dockerd) |
| Docker CLI compatibility | Via nerdctl | None | Full |
| Docker build support | Via nerdctl/buildkit | None | Full |
| Memory overhead | Low | Medium | High |
| Container start latency | Lowest | Low | Highest |
| SELinux support | Optional | Native | Optional |
| seccomp | Yes | Yes | Yes |
| AppArmor | Yes | Yes | Yes |
| Rootless mode | Yes | Experimental | Yes |
| Multi-runtime support | Yes | Yes | Limited |
| Kata Containers | Yes | Yes | No |
| gVisor | Yes | Yes | No |
| Production stability | Excellent | Excellent | Good |
| Community/ecosystem | Very Large | Large | Shrinking |
| Red Hat/OpenShift default | No | Yes (RHCOS) | No |
| GKE/EKS/AKS default | containerd | No | No |

## Section 10: Recommendation Framework

### Choose containerd when:
- You are building on managed Kubernetes (GKE, EKS, AKS) — all use containerd as default.
- You want the largest ecosystem of tooling and community support.
- You need multiple OCI runtime support (runc, Kata, gVisor) in the same cluster.
- You are building new infrastructure without legacy Docker dependencies.
- You want the lowest daemon overhead.

### Choose CRI-O when:
- You are running Red Hat OpenShift or OpenShift-compatible distributions.
- SELinux enforcement is a hard security requirement.
- You prefer a runtime with a minimal, Kubernetes-only scope.
- Your team has operational expertise in the Red Hat/CentOS ecosystem.
- You want the tightest integration with `containers/image` and `containers/storage`.

### Choose cri-dockerd when:
- You have a hard dependency on `docker build` running directly on Kubernetes nodes.
- Your organization has significant Docker Compose tooling running on nodes.
- You need time to migrate CI/CD tooling before switching to a native CRI runtime.
- This should be treated as a transitional choice, not a permanent architecture decision.

## Conclusion

The decision between containerd and CRI-O for production Kubernetes is not a performance decision — both are production-grade and the performance differences are marginal for most workloads. It is primarily an ecosystem and operational expertise decision. On managed cloud Kubernetes, containerd is the de facto standard. On Red Hat-based enterprise Linux, CRI-O is the natural choice. For most new greenfield Kubernetes deployments, containerd with runc as the default runtime and Kata Containers as an optional runtime for untrusted workloads represents the most flexible and future-proof architecture. Regardless of which runtime you choose, the migration path from Docker/Dockershim is well-documented and the operational commands via `crictl` are identical, making future transitions straightforward.
