---
title: "Deep Dive: Kubernetes Container Runtime (containerd)"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "containerd", "containers", "runtime"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive deep dive into containerd architecture, configuration, and container management"
url: "/training/kubernetes-deep-dive/containerd/"
---

Containerd is the container runtime used in Kubernetes to manage container lifecycle operations. This deep dive explores its architecture, configuration, and internal workings.

<!--more-->

# [Architecture Overview](#architecture)

## Component Architecture
```plaintext
kubelet -> CRI -> containerd -> runc
                            -> snapshotter
                            -> content store
```

## Key Components
1. **Core Services**
   - Container Management
   - Image Management
   - Snapshot Management
   - Content Management

2. **Runtime Components**
   - runc
   - Task Management
   - Network Namespace

3. **Storage Components**
   - Snapshotter
   - Content Store
   - Metadata Store

# [Container Management](#containers)

## 1. Container Lifecycle
```go
// Container creation workflow
type Container interface {
    ID() string
    Info() containers.Container
    Delete(context.Context) error
    NewTask(context.Context, cio.Creator, ...NewTaskOpts) (Task, error)
    Spec() (*specs.Spec, error)
    Task(context.Context, cio.Attach) (Task, error)
    Image(context.Context) (Image, error)
    Labels(context.Context) (map[string]string, error)
    SetLabels(context.Context, map[string]string) (map[string]string, error)
    Extensions(context.Context) (map[string]types.Any, error)
    Update(context.Context, ...UpdateContainerOpts) error
}
```

## 2. Task Management
```go
// Task operations
type Task interface {
    ID() string
    Pid() uint32
    Start(context.Context) error
    Delete(context.Context, ...ProcessDeleteOpts) (*Exit, error)
    Kill(context.Context, syscall.Signal, ...KillOpts) error
    Pause(context.Context) error
    Resume(context.Context) error
    Status(context.Context) (Status, error)
    Wait(context.Context) (*Exit, error)
    Exec(context.Context, string, *specs.Process, cio.Creator) (Process, error)
    Pids(context.Context) ([]ProcessInfo, error)
    CloseIO(context.Context, ...IOCloserOpts) error
    Resize(ctx context.Context, w, h uint32) error
    IO() cio.IO
    Checkpoint(context.Context, ...CheckpointTaskOpts) (Image, error)
    Update(context.Context, ...UpdateTaskOpts) error
}
```

# [Image Management](#images)

## 1. Image Operations
```bash
# Pull image
ctr images pull docker.io/library/nginx:latest

# List images
ctr images ls

# Tag image
ctr images tag docker.io/library/nginx:latest nginx:custom

# Remove image
ctr images rm docker.io/library/nginx:latest
```

## 2. Content Store
```go
// Content store interface
type Store interface {
    Walk(context.Context, func(Info) error) error
    Delete(context.Context, digest.Digest) error
    Info(context.Context, digest.Digest) (Info, error)
    Update(context.Context, Info, ...UpdateOpt) (Info, error)
    Walk(context.Context, func(Info) error) error
    Delete(context.Context, digest.Digest) error
    ListStatuses(context.Context, string) ([]Status, error)
    Status(context.Context, string) (Status, error)
    Abort(context.Context, string) error
    Writer(context.Context, ...WriterOpt) (Writer, error)
}
```

# [Storage Management](#storage)

## 1. Snapshotter Configuration
```toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "overlayfs"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
      runtime_type = "io.containerd.runc.v2"
```

## 2. Storage Operations
```bash
# List snapshots
ctr snapshots ls

# Create snapshot
ctr snapshots prepare my-snapshot --image docker.io/library/nginx:latest

# Remove snapshot
ctr snapshots rm my-snapshot
```

# [Runtime Configuration](#configuration)

## 1. Base Configuration
```toml
version = 2
root = "/var/lib/containerd"
state = "/run/containerd"
oom_score = -999

[grpc]
  address = "/run/containerd/containerd.sock"
  uid = 0
  gid = 0

[debug]
  address = "/run/containerd/debug.sock"
  level = "info"

[metrics]
  address = "127.0.0.1:1338"
```

## 2. CRI Plugin Configuration
```toml
[plugins."io.containerd.grpc.v1.cri"]
  sandbox_image = "k8s.gcr.io/pause:3.5"
  max_container_log_line_size = 16384
  
  [plugins."io.containerd.grpc.v1.cri".containerd]
    default_runtime_name = "runc"
    
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
      runtime_type = "io.containerd.runc.v2"
      
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
        SystemdCgroup = true
```

# [Performance Tuning](#performance)

## 1. Resource Management
```toml
[plugins."io.containerd.grpc.v1.cri"]
  enable_selinux = false
  enable_tls_streaming = false
  max_concurrent_downloads = 3
  disable_tcp_service = true
  
  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "overlayfs"
    disable_snapshot_annotations = true
```

## 2. Memory Management
```toml
[plugins."io.containerd.grpc.v1.cri"]
  max_container_log_line_size = 16384
  max_concurrent_downloads = 3
  max_container_log_size = "16Mi"
  disable_proc_mount = true
```

# [Monitoring and Metrics](#monitoring)

## 1. Metrics Configuration
```toml
[metrics]
  address = "127.0.0.1:1338"
  grpc_histogram = false
```

## 2. Important Metrics
```plaintext
# Key metrics to monitor
container_runtime_operations_latency_seconds
container_runtime_operations_errors_total
container_memory_usage_bytes
container_cpu_usage_seconds_total
```

# [Troubleshooting](#troubleshooting)

## Common Issues

1. **Container Start Issues**
```bash
# Check containerd status
systemctl status containerd

# View containerd logs
journalctl -u containerd

# Check container status
ctr containers ls
```

2. **Image Pull Problems**
```bash
# Check image status
ctr images ls

# Pull image manually
ctr images pull --platform linux/amd64 docker.io/library/nginx:latest

# Check image content
ctr images mount docker.io/library/nginx:latest /mnt
```

3. **Storage Issues**
```bash
# Check available space
df -h /var/lib/containerd

# Clean up unused data
ctr content garbage-collect
```

# [Best Practices](#best-practices)

1. **Security**
   - Enable seccomp by default
   - Configure AppArmor profiles
   - Use read-only root filesystem
   - Implement proper SELinux policies

2. **Performance**
   - Use overlayfs snapshotter
   - Configure proper resource limits
   - Enable metrics collection
   - Monitor resource usage

3. **Maintenance**
   - Regular garbage collection
   - Monitor disk usage
   - Update runtime regularly
   - Backup metadata

# [Advanced Features](#advanced)

## 1. Custom Runtime Configuration
```toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.custom]
  runtime_type = "io.containerd.runc.v2"
  pod_annotations = ["custom.io/*"]
  container_annotations = ["custom.io/*"]
  privileged_without_host_devices = false
  base_runtime_spec = "/etc/containerd/custom-runtime.json"
```

## 2. Namespace Configuration
```toml
[plugins."io.containerd.grpc.v1.cri"]
  enable_selinux = true
  selinux_category_range = 1024
  
  [plugins."io.containerd.grpc.v1.cri".containerd]
    default_runtime_name = "runc"
    disable_snapshot_annotations = false
    discard_unpacked_layers = true
```

For more information, check out:
- [Container Runtime Interface](/training/kubernetes-deep-dive/cri/)
- [Container Security](/training/kubernetes-deep-dive/container-security/)
- [Runtime Best Practices](/training/kubernetes-deep-dive/runtime-best-practices/)
