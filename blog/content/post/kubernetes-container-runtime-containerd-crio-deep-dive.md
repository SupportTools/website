---
title: "Kubernetes Container Runtime: containerd and CRI-O Deep Dive"
date: 2029-05-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "containerd", "CRI-O", "CRI", "Container Runtime", "Kata Containers", "RuntimeClass"]
categories:
- Kubernetes
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Kubernetes container runtimes: the CRI interface, containerd architecture, snapshotters, content store, CRI-O vs containerd comparison, runtime classes, and Kata Containers integration."
more_link: "yes"
url: "/kubernetes-container-runtime-containerd-crio-deep-dive/"
---

When Docker was deprecated as a Kubernetes runtime in 1.24, many teams scrambled to understand what actually runs their containers. The Container Runtime Interface (CRI) decouples Kubernetes from the underlying runtime, and today containerd and CRI-O are the two dominant choices. Understanding their architectures — how images are stored, snapshotted, and executed — is essential for platform engineers who need to optimize performance, troubleshoot failures, and integrate specialized runtimes like Kata Containers for stronger workload isolation.

<!--more-->

# Kubernetes Container Runtime: containerd and CRI-O Deep Dive

## The Container Runtime Interface

The CRI is a gRPC API defined by Kubernetes. Any runtime that implements this API can serve as the container engine for a kubelet. The interface is defined in `k8s.io/cri-api`:

```protobuf
service RuntimeService {
    // Pod/sandbox management
    rpc RunPodSandbox(RunPodSandboxRequest) returns (RunPodSandboxResponse);
    rpc StopPodSandbox(StopPodSandboxRequest) returns (StopPodSandboxResponse);
    rpc RemovePodSandbox(RemovePodSandboxRequest) returns (RemovePodSandboxResponse);
    rpc PodSandboxStatus(PodSandboxStatusRequest) returns (PodSandboxStatusResponse);
    rpc ListPodSandbox(ListPodSandboxRequest) returns (ListPodSandboxResponse);

    // Container management
    rpc CreateContainer(CreateContainerRequest) returns (CreateContainerResponse);
    rpc StartContainer(StartContainerRequest) returns (StartContainerResponse);
    rpc StopContainer(StopContainerRequest) returns (StopContainerResponse);
    rpc RemoveContainer(RemoveContainerRequest) returns (RemoveContainerResponse);
    rpc ListContainers(ListContainersRequest) returns (ListContainersResponse);
    rpc ContainerStatus(ContainerStatusRequest) returns (ContainerStatusResponse);

    // Exec/attach/port-forward
    rpc ExecSync(ExecSyncRequest) returns (ExecSyncResponse);
    rpc Exec(ExecRequest) returns (ExecResponse);
    rpc Attach(AttachRequest) returns (AttachResponse);
    rpc PortForward(PortForwardRequest) returns (PortForwardResponse);

    // Metrics
    rpc ContainerStats(ContainerStatsRequest) returns (ContainerStatsResponse);
    rpc ListContainerStats(ListContainerStatsRequest) returns (ListContainerStatsResponse);
}

service ImageService {
    rpc ListImages(ListImagesRequest) returns (ListImagesResponse);
    rpc ImageStatus(ImageStatusRequest) returns (ImageStatusResponse);
    rpc PullImage(PullImageRequest) returns (PullImageResponse);
    rpc RemoveImage(RemoveImageRequest) returns (RemoveImageResponse);
    rpc ImageFsInfo(ImageFsInfoRequest) returns (ImageFsInfoResponse);
}
```

The kubelet connects to the CRI socket and speaks this protocol. The socket path is configurable:

```
--container-runtime-endpoint=unix:///run/containerd/containerd.sock
--container-runtime-endpoint=unix:///var/run/crio/crio.sock
```

## containerd Architecture

containerd is a CNCF-graduated project that implements the CRI as a plugin within its broader daemon architecture.

### Component Hierarchy

```
kubelet
  |
  | gRPC (CRI API)
  v
containerd daemon (/run/containerd/containerd.sock)
  |-- CRI plugin (implements CRI, bridges to containerd core)
  |-- Snapshotter plugins
  |     |-- overlayfs (default on Linux)
  |     |-- native (copy-based, for systems without overlay support)
  |     |-- devmapper (for direct-lvm block devices)
  |     |-- zfs (ZFS datasets as snapshots)
  |     |-- btrfs (btrfs subvolumes)
  |     |-- nydus/stargz (lazy pull snapshotters)
  |-- Content Store (content-addressable, immutable layer blobs)
  |-- Metadata Store (BoltDB: images, containers, snapshots)
  |-- Runtime plugin
        |-- runc (default OCI runtime)
        |-- kata-runtime
        |-- runsc (gVisor)
```

### containerd Configuration

```toml
# /etc/containerd/config.toml

version = 2

[grpc]
  address = "/run/containerd/containerd.sock"
  max_recv_message_size = 16777216
  max_send_message_size = 16777216

[metrics]
  address = "127.0.0.1:1338"

[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    sandbox_image = "registry.k8s.io/pause:3.9"
    max_container_log_line_size = 16384
    enable_unprivileged_ports = true
    enable_unprivileged_icmp = true

    [plugins."io.containerd.grpc.v1.cri".containerd]
      snapshotter = "overlayfs"
      default_runtime_name = "runc"
      no_pivot = false
      disable_snapshot_annotations = false

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            SystemdCgroup = true
            BinaryName = "/usr/bin/runc"

        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
            ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration.toml"

    [plugins."io.containerd.grpc.v1.cri".registry]
      [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
          endpoint = ["https://mirror.gcr.io", "https://registry-1.docker.io"]

      [plugins."io.containerd.grpc.v1.cri".registry.configs]
        [plugins."io.containerd.grpc.v1.cri".registry.configs."my-registry.internal:5000"]
          [plugins."io.containerd.grpc.v1.cri".registry.configs."my-registry.internal:5000".tls]
            insecure_skip_verify = false
            ca_file = "/etc/containerd/certs.d/my-registry.internal:5000/ca.crt"

  [plugins."io.containerd.snapshotter.v1.overlayfs"]
    root_path = "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs"
    upperdir_label = false
    sync_remove = false
    slow_chown = false
```

Apply changes:

```bash
systemctl restart containerd
```

### Content Store

The content store is a CAS (content-addressable storage) layer that stores image layer blobs by digest:

```bash
# List all content in the store
ctr content ls

# Inspect a specific blob
ctr content get sha256:abc123... | gunzip | tar tv

# Garbage collect unreferenced content
ctr content gc
```

Internal layout on disk:

```
/var/lib/containerd/io.containerd.content.v1.content/
├── blobs/
│   └── sha256/
│       ├── abc123...  (image manifest)
│       ├── def456...  (image config)
│       └── ghi789...  (layer tar.gz)
└── ingest/            (in-progress downloads)
```

### Snapshotters Deep Dive

When a container is created, containerd creates a filesystem snapshot by stacking layers. The default overlayfs snapshotter uses the kernel's OverlayFS:

```
Layer 0 (base OS)    [read-only, lowerdir]
Layer 1 (app deps)   [read-only, lowerdir]
Layer 2 (app code)   [read-only, lowerdir]
Container writable   [read-write, upperdir]
                     [merged view via overlayfs]
```

```bash
# Inspect snapshots
ctr snapshots ls

# Show overlay mount details for a running container
CONTAINER_ID=$(ctr -n k8s.io containers ls -q | head -1)
ctr -n k8s.io snapshots info $CONTAINER_ID

# Find overlayfs mounts directly
mount | grep overlay | head -5
# overlay on /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/rootfs
#   type overlay (rw,relatime,lowerdir=/var/lib/containerd/...,
#   upperdir=/var/lib/containerd/.../diff,
#   workdir=/var/lib/containerd/.../work)
```

### Stargz/Nydus Lazy Pull Snapshotters

Standard image pulls download the entire image before starting a container. Lazy snapshotters allow containers to start while image data is still being fetched:

```toml
# containerd with stargz snapshotter
[plugins."io.containerd.grpc.v1.cri".containerd]
  snapshotter = "stargz"

[plugins."io.containerd.snapshotter.v1.stargz"]
  root_path = "/var/lib/containerd-stargz-grpc"
```

This can reduce container startup time by 70% for large images when the application starts before all layers are downloaded.

## containerd CLI Tools

### ctr (Low-Level)

```bash
# Image operations (namespace: k8s.io for Kubernetes containers)
ctr -n k8s.io images ls
ctr -n k8s.io images pull docker.io/library/nginx:latest
ctr -n k8s.io images rm docker.io/library/nginx:latest

# Container operations
ctr -n k8s.io containers ls
ctr -n k8s.io containers info <container-id>

# Task operations (running containers)
ctr -n k8s.io tasks ls
ctr -n k8s.io tasks exec --exec-id debug <container-id> /bin/sh

# Namespace management
ctr namespaces ls
# NAME    LABELS
# default
# k8s.io     (Kubernetes containers live here)
```

### nerdctl (Docker-Compatible)

```bash
# Pull and run with Docker-compatible interface
nerdctl run -it --rm nginx:latest

# Use with Kubernetes namespace
nerdctl -n k8s.io ps
nerdctl -n k8s.io images

# Build OCI images
nerdctl build -t my-app:latest .
nerdctl push my-registry.internal/my-app:latest
```

### crictl (CRI-Level)

`crictl` speaks the CRI protocol directly, identical behavior for both containerd and CRI-O:

```bash
# Configure crictl runtime endpoint
cat /etc/crictl.yaml
# runtime-endpoint: unix:///run/containerd/containerd.sock
# image-endpoint: unix:///run/containerd/containerd.sock
# timeout: 30
# debug: false

# Pod and container operations
crictl pods
crictl ps
crictl images

# Inspect running pod
crictl inspectp <pod-id>

# Execute command in container
crictl exec -it <container-id> /bin/sh

# Pull image
crictl pull nginx:latest

# Get container logs
crictl logs <container-id>

# Container stats
crictl stats

# Port forward
crictl port-forward <pod-id> 8080:80
```

## CRI-O Architecture

CRI-O is a minimal CRI implementation purpose-built for Kubernetes. It has no standalone container management capabilities — its only job is to implement the CRI.

### Architecture

```
kubelet
  |
  | gRPC (CRI API)
  v
crio daemon (/var/run/crio/crio.sock)
  |-- Image management (via containers/image library)
  |-- Storage (via containers/storage library)
  |-- OCI runtime shim (conmon + runc)
  |-- CNI plugin integration
```

### CRI-O Configuration

```toml
# /etc/crio/crio.conf

[crio]
  storage_driver = "overlay"
  storage_option = ["overlay.mountopt=nodev,metacopy=on"]

[crio.api]
  listen = "/var/run/crio/crio.sock"

[crio.runtime]
  default_runtime = "runc"
  selinux = true
  seccomp_profile = ""
  apparmor_profile = "crio-default"
  cgroup_manager = "systemd"
  default_sysctls = []
  allowed_devices = ["/dev/fuse", "/dev/net/tun"]

  [crio.runtime.runtimes]
    [crio.runtime.runtimes.runc]
      runtime_path = "/usr/bin/runc"
      runtime_type = "oci"
      runtime_root = "/run/runc"

    [crio.runtime.runtimes.kata-runtime]
      runtime_path = "/usr/bin/kata-runtime"
      runtime_type = "vm"
      privileged_without_host_devices = true

[crio.image]
  default_transport = "docker://"
  pause_image = "registry.k8s.io/pause:3.9"
  pause_image_auth_file = ""

[crio.network]
  network_dir = "/etc/cni/net.d/"
  plugin_dirs = ["/opt/cni/bin/", "/usr/lib/cni/"]
```

### containers/storage Library

CRI-O uses the `containers/storage` library (shared with Podman and Buildah) for image and container storage:

```bash
# Storage layout
ls /var/lib/containers/storage/
# overlay/           (unpacked layers)
# overlay-images/    (image metadata)
# overlay-containers/ (container filesystems)
# libpod/            (Podman metadata, if present)
```

## containerd vs CRI-O Comparison

| Dimension | containerd | CRI-O |
|---|---|---|
| Scope | General container engine + CRI | CRI-only, Kubernetes-specific |
| CLI tools | ctr, nerdctl, crictl | crictl (primary), podman |
| Image format | OCI + Docker v2 | OCI + Docker v2 |
| Snapshotter API | Extensible plugin | containers/storage |
| Lazy pull | stargz/nydus plugins | partial support |
| Configuration | TOML, plugin-based | TOML |
| Memory footprint | ~50 MB | ~30 MB |
| Update cadence | Fast, frequent | Synchronized with k8s releases |
| Default on | EKS, GKE, AKS | OpenShift, some bare-metal |
| Podman compatibility | No | Shared library ecosystem |
| Gvisor (runsc) | Well supported | Supported |
| Kata Containers | Well supported | Supported |

### When to Choose containerd

- You use managed Kubernetes (EKS, GKE, AKS) — all default to containerd
- You need nerdctl or lazy pull features
- You build container images on nodes (nerdctl build)
- You run mixed workloads with different runtime classes

### When to Choose CRI-O

- You run OpenShift
- You prefer minimal attack surface on nodes
- You use Podman/Buildah in CI and want shared image cache
- You want synchronized releases with upstream Kubernetes

## RuntimeClass: Running Different Runtimes Per Workload

RuntimeClass allows individual pods to specify which container runtime to use:

```yaml
# Create RuntimeClass for Kata Containers
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
handler: kata         # Must match runtime name in containerd/CRI-O config
overhead:
  podFixed:
    memory: "160Mi"   # Kata VM overhead
    cpu: "250m"
scheduling:
  nodeSelector:
    kata-containers: "true"    # Only schedule on nodes with Kata support
  tolerations:
  - key: "kata-containers"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
```

```yaml
# Create RuntimeClass for gVisor
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

```yaml
# Pod using RuntimeClass
apiVersion: v1
kind: Pod
metadata:
  name: secure-workload
spec:
  runtimeClassName: kata    # Use Kata VM isolation
  containers:
  - name: app
    image: my-sensitive-app:latest
```

## Kata Containers Integration

Kata Containers runs each pod in a lightweight VM, providing hardware-level isolation between pods. This is critical for multi-tenant clusters where workloads from different customers share nodes.

### Architecture

```
kubelet --> CRI --> containerd --> kata-runtime (shim)
                                       |
                                       v
                              QEMU/KVM or Firecracker VM
                              |-- Guest kernel
                              |-- kata-agent (init process)
                              |-- Container workload (runc inside VM)
```

### Installing Kata on a Node

```bash
# Install Kata packages (Ubuntu)
apt-get install kata-containers

# Verify hardware virtualization
kata-runtime check
# WARN[0000] CPU does not support hypervisor hardware support
# (this is OK on some cloud instance types that use nested virt)

# Check available hypervisors
ls /opt/kata/bin/
# containerd-shim-kata-v2  kata-collect-data  kata-monitor  kata-runtime  qemu-system-x86_64
```

### Kata with containerd

```toml
# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  privileged_without_host_devices = true
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"
```

### Kata with Firecracker (microVMs)

```toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc]
  runtime_type = "io.containerd.kata.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"
```

Firecracker microVMs start in ~125ms vs ~1s for QEMU, with a much smaller TCB (trusted computing base).

### Performance Considerations for Kata

```yaml
# Kata pods need more resources due to VM overhead
spec:
  runtimeClassName: kata
  containers:
  - name: app
    resources:
      requests:
        memory: "256Mi"    # App + VM overhead
        cpu: "500m"        # Includes hypervisor overhead
      limits:
        memory: "512Mi"
        cpu: "2"
```

## Debugging Container Runtime Issues

### Containerd Service Status

```bash
systemctl status containerd
journalctl -u containerd --since "10 minutes ago" | grep -E "(error|warn|ERRO|WARN)"

# containerd debug endpoint
curl --unix-socket /run/containerd/containerd.sock \
  http://localhost/v1/metrics | grep containerd_
```

### CRI-Level Debugging

```bash
# Check what CRI sees (useful for kubelet debugging)
crictl info | jq .

# Check image pull events
journalctl -u containerd | grep "pulling\|pulled\|failed" | tail -20

# Inspect why a container failed to start
crictl inspect <container-id> | jq .status.reason
crictl inspect <container-id> | jq .status.message
```

### Snapshotter Issues

```bash
# overlayfs requires kernel 4.0+ and d_type support
dmesg | grep overlay

# Check filesystem type of containerd root
stat -f /var/lib/containerd
# File: "/var/lib/containerd"
# Type: ext2/ext3        (overlay requires d_type, XFS needs ftype=1)

# For XFS, check ftype
xfs_info /dev/sda1 | grep ftype
```

### Image Layer Corruption

```bash
# Verify image manifest integrity
ctr -n k8s.io images check nginx:latest

# Force re-pull a corrupt image
ctr -n k8s.io images rm nginx:latest
crictl pull nginx:latest
```

## Storage Optimization

### Image Layer Deduplication

Both containerd and CRI-O deduplicate image layers automatically — if two images share a layer digest, it is stored only once:

```bash
# See how much disk is used by images vs shared layers
du -sh /var/lib/containerd/io.containerd.content.v1.content/blobs/
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/

# Prune unused images (via crictl, applies to both runtimes)
crictl rmi --prune
```

### Containerd Garbage Collection

```bash
# Manual GC
ctr content gc

# Configure automatic GC in containerd
# GC runs automatically when disk usage exceeds threshold
```

### Image Pre-pulling (DaemonSet Pattern)

Pre-pull images to all nodes before deployment to eliminate pull latency:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-prepuller
spec:
  selector:
    matchLabels:
      name: image-prepuller
  template:
    metadata:
      labels:
        name: image-prepuller
    spec:
      initContainers:
      - name: pull-app
        image: my-app:v2.0.0
        command: ["sh", "-c", "echo 'image pre-pulled'"]
        resources:
          requests:
            cpu: "10m"
            memory: "16Mi"
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
```

The container runtime caches the image on the node. The DaemonSet can be deleted after the images are cached.

## Security Hardening

### Seccomp Profiles

```bash
# Set default seccomp profile in containerd
[plugins."io.containerd.grpc.v1.cri"]
  seccomp_profile = "/etc/containerd/seccomp.json"
```

### Rootless containerd

```bash
# Install rootless containerd
containerd-rootless-setuptool.sh install

# Run as non-root
CONTAINERD_ROOTLESS_ROOTLESSKIT_FLAGS="" containerd-rootless.sh

# Config location
~/.config/containerd/config.toml
```

### Image Signing Verification

```toml
# containerd with cosign verification (via notation or policy)
[plugins."io.containerd.grpc.v1.cri".registry.configs]
  [plugins."io.containerd.grpc.v1.cri".registry.configs."my-registry.internal"]
    [plugins."io.containerd.grpc.v1.cri".registry.configs."my-registry.internal".auth]
      username = "robot-sa"
      password = "<TOKEN>"
```

Use `policy.json` for signature verification:

```json
{
    "default": [{"type": "insecureAcceptAnything"}],
    "transports": {
        "docker": {
            "my-registry.internal": [
                {
                    "type": "signedBy",
                    "keyType": "GPGKeys",
                    "keyPath": "/etc/containers/cosign-pub.key"
                }
            ]
        }
    }
}
```

Understanding the full CRI stack — from kubelet gRPC calls through snapshotter layer management to OCI runtime execution — gives platform engineers the visibility needed to optimize container startup times, diagnose image pull failures, and make informed decisions about runtime isolation requirements for their workloads.
