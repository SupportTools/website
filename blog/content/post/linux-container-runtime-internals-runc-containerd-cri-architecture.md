---
title: "Linux Container Runtime Internals: runc, containerd, and CRI Architecture"
date: 2030-07-21T00:00:00-05:00
draft: false
tags: ["Linux", "Containers", "runc", "containerd", "CRI", "Docker", "Kubernetes", "OCI"]
categories:
- Linux
- Containers
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into container runtimes covering runc OCI spec implementation, containerd architecture, CRI plugin, image pulling and layer management, snapshot drivers, and debugging container startup failures at the runtime level."
more_link: "yes"
url: "/linux-container-runtime-internals-runc-containerd-cri-architecture/"
---

Understanding the container runtime stack is essential for debugging container startup failures, optimizing performance, and evaluating security properties. The runtime stack forms a layered architecture: kubelet communicates with containerd via the Container Runtime Interface (CRI), containerd manages the container lifecycle and image storage, and runc creates the actual Linux namespaces and cgroups that isolate containers. Each layer can fail independently, and effective diagnosis requires knowing where to look at each level.

<!--more-->

## Container Runtime Architecture

The modern Kubernetes container runtime stack consists of:

```
kubelet
  │
  │ CRI (gRPC)
  ▼
containerd (CRI plugin)
  │
  │ OCI runtime spec
  ▼
runc / gVisor / kata-containers
  │
  │ Linux kernel syscalls
  ▼
Namespaces + Cgroups + Seccomp + Capabilities
```

**kubelet** is responsible for pod lifecycle management. It calls the CRI server (containerd) to create containers, pull images, and manage container state.

**containerd** is the container daemon managing image distribution (pull, push, content store), container lifecycle (create, start, stop, delete), snapshot management (image layer overlay), and the CRI plugin that exposes the gRPC API to kubelet.

**runc** is the low-level OCI runtime that reads a container spec bundle and executes the process in a set of Linux namespaces. It has no daemon — it is a stateless binary called by containerd.

## OCI Runtime Specification

The OCI (Open Container Initiative) runtime specification defines the format of a container bundle: a directory with `config.json` and a `rootfs/` directory.

### Generating an OCI Bundle

```bash
# Create a minimal OCI bundle manually
mkdir -p /tmp/oci-bundle/rootfs
cd /tmp/oci-bundle

# Populate rootfs with a minimal Alpine filesystem
docker export $(docker create alpine) | tar -xC rootfs/

# Generate the default OCI config spec
runc spec

# The generated config.json defines:
# - process: command, env, user, capabilities, rlimits
# - root: rootfs path
# - mounts: standard proc/sys/dev mounts
# - linux: namespaces, cgroups, seccomp, devices

cat config.json | python3 -m json.tool | head -80
```

### OCI config.json Structure

```json
{
  "ociVersion": "1.0.2",
  "process": {
    "terminal": false,
    "user": { "uid": 0, "gid": 0 },
    "args": ["/bin/sh", "-c", "echo hello"],
    "env": [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOSTNAME=container-01"
    ],
    "cwd": "/",
    "capabilities": {
      "bounding": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"],
      "effective": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"],
      "permitted": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"],
      "ambient": []
    },
    "rlimits": [
      { "type": "RLIMIT_NOFILE", "hard": 1024, "soft": 1024 }
    ],
    "noNewPrivileges": true
  },
  "root": {
    "path": "rootfs",
    "readonly": false
  },
  "hostname": "container-01",
  "mounts": [
    { "destination": "/proc", "type": "proc", "source": "proc" },
    { "destination": "/dev", "type": "tmpfs", "source": "tmpfs",
      "options": ["nosuid", "strictatime", "mode=755", "size=65536k"] },
    { "destination": "/sys", "type": "sysfs", "source": "sysfs",
      "options": ["nosuid", "noexec", "nodev", "ro"] }
  ],
  "linux": {
    "namespaces": [
      { "type": "pid" },
      { "type": "network" },
      { "type": "ipc" },
      { "type": "uts" },
      { "type": "mount" },
      { "type": "cgroup" }
    ],
    "maskedPaths": [
      "/proc/acpi", "/proc/kcore", "/proc/keys",
      "/proc/latency_stats", "/proc/timer_list",
      "/proc/timer_stats", "/proc/sched_debug", "/proc/scsi",
      "/sys/firmware"
    ],
    "readonlyPaths": [
      "/proc/asound", "/proc/bus", "/proc/fs", "/proc/irq",
      "/proc/sys", "/proc/sysrq-trigger"
    ]
  }
}
```

### Running a Container with runc Directly

```bash
# Run the container (requires root or user namespaces)
cd /tmp/oci-bundle
sudo runc run my-container

# List running containers managed by runc
sudo runc list

# Check container state
sudo runc state my-container

# Execute a command in a running container
sudo runc exec my-container /bin/sh

# Delete the container
sudo runc delete my-container
```

## Linux Namespaces Deep Dive

### Namespace Types and Their Purpose

```bash
# List namespaces for a container process
PID=$(sudo runc state my-container | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])")
ls -la /proc/$PID/ns/

# Compare namespace inodes between host and container
echo "Host PID namespace: $(readlink /proc/1/ns/pid)"
echo "Container PID namespace: $(readlink /proc/$PID/ns/pid)"

# Enter a container's namespaces with nsenter
sudo nsenter --target $PID \
  --mount --uts --ipc --net --pid \
  -- /bin/sh

# View network namespace interfaces from host
sudo nsenter --target $PID --net -- ip addr show

# View the container's cgroup assignments
cat /proc/$PID/cgroup
```

### Creating Namespaces with unshare

```bash
# Create a new user + mount + PID namespace (rootless)
unshare \
  --user \
  --pid \
  --mount \
  --fork \
  --map-root-user \
  /bin/sh

# Inside new namespace, proc must be remounted
mount -t proc proc /proc
ps aux
```

## containerd Architecture

### Core Components

containerd is organized as a set of plugins managed by the containerd daemon:

- **Snapshotter**: Manages the layered filesystem for containers (overlayfs, btrfs, zfs, native)
- **Content Store**: Immutable storage for image layers and config (referenced by digest)
- **Metadata Store**: Bolt DB backing persistent state for containers, images, namespaces
- **Tasks API**: Creates and manages `runc` container instances
- **CRI Plugin**: Exposes the Kubernetes CRI gRPC API

### containerd Configuration

```toml
# /etc/containerd/config.toml
version = 3

[grpc]
  address = "/run/containerd/containerd.sock"
  uid = 0
  gid = 0
  max_recv_message_size = 16777216
  max_send_message_size = 16777216

[ttrpc]
  address = ""
  uid = 0
  gid = 0

[debug]
  address = ""
  level = "info"
  format = "json"

[metrics]
  address = "127.0.0.1:1338"
  grpc_histogram = false

[cgroup]
  path = ""

[timeouts]
  "io.containerd.timeout.shim.cleanup" = "5s"
  "io.containerd.timeout.shim.load" = "5s"
  "io.containerd.timeout.shim.shutdown" = "3s"
  "io.containerd.timeout.task.state" = "2s"

[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    sandbox_image = "registry.k8s.io/pause:3.9"
    max_container_log_line_size = 16384
    enable_selinux = false
    enable_tls_streaming = false
    max_concurrent_downloads = 10
    disable_tcp_service = true
    stream_server_address = "127.0.0.1"
    stream_server_port = "0"

    [plugins."io.containerd.grpc.v1.cri".containerd]
      snapshotter = "overlayfs"
      default_runtime_name = "runc"
      no_pivot = false
      disable_snapshot_annotations = true

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          runtime_path = ""

          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            SystemdCgroup = true
            BinaryName = "/usr/bin/runc"
            Root = ""
            ShimCgroup = ""
            IoUid = 0
            IoGid = 0

        # gVisor sandbox runtime
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
          runtime_type = "io.containerd.runsc.v1"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
            TypeUrl = "io.containerd.runsc.v1.options"
            ConfigPath = "/etc/containerd/runsc.toml"

    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"

    [plugins."io.containerd.grpc.v1.cri".image_decryption]
      key_model = "node"

  [plugins."io.containerd.snapshotter.v1.overlayfs"]
    root_path = ""
    upper_dir_label = false
    mount_options = []
    sync_remove = false

  # Zstd image compression support
  [plugins."io.containerd.snapshotter.v1.stargz"]
    root_path = ""

  [plugins."io.containerd.gc.v1.scheduler"]
    pause_threshold = 0.02
    deletion_threshold = 0
    mutation_threshold = 100
    schedule_delay = "0s"
    startup_delay = "100ms"
```

### Using ctr for Low-Level Debugging

The `ctr` CLI is containerd's native client and bypasses CRI:

```bash
# List all namespaces (containerd uses namespaces for isolation)
sudo ctr namespaces ls
# moby    (Docker)
# k8s.io  (Kubernetes/kubelet)
# default

# List images in the Kubernetes namespace
sudo ctr -n k8s.io images ls

# List running containers
sudo ctr -n k8s.io containers ls

# List tasks (running processes)
sudo ctr -n k8s.io tasks ls

# Inspect a container
sudo ctr -n k8s.io containers info <container-id>

# Pull an image
sudo ctr -n k8s.io images pull \
  --hosts-dir /etc/containerd/certs.d \
  docker.io/library/nginx:1.25

# Show image manifest layers
sudo ctr -n k8s.io content ls | head -20

# Inspect content (image layers)
sudo ctr -n k8s.io content get \
  sha256:<layer-digest> | tar -tzf - | head -20

# Snapshotter operations
sudo ctr -n k8s.io snapshots ls
sudo ctr -n k8s.io snapshots info <snapshot-key>

# Mount a snapshot for inspection
sudo ctr -n k8s.io snapshots mounts \
  /mnt/snapshot-inspect \
  <snapshot-key>
ls /mnt/snapshot-inspect/
```

## Image Layer Management

### Content Store Internals

```bash
# Content store location
ls -la /var/lib/containerd/io.containerd.content.v1.content/

# Content is stored as files named by their SHA256 digest
ls /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/ | head -5

# Verify content integrity
sudo ctr -n k8s.io content get sha256:<digest> | sha256sum

# Show the image config (contains layer history, env, cmd)
sudo ctr -n k8s.io images ls -q | head -1 | \
  xargs sudo ctr -n k8s.io images export - | \
  tar -xOf - manifest.json | python3 -m json.tool
```

### Snapshot Drivers

containerd supports multiple snapshot drivers for the container filesystem:

```bash
# Check active snapshotter
sudo ctr -n k8s.io info | grep snapshotter

# OverlayFS snapshots (most common)
ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/

# View overlay mount for a running container
CONTAINER_ID="<container-id>"
sudo ctr -n k8s.io snapshots mounts \
  /tmp/overlay-inspect \
  $(sudo ctr -n k8s.io containers info $CONTAINER_ID \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['SnapshotKey'])")

# Check overlay mount options
mount | grep overlay | head -5
# overlay on /run/containerd/io.containerd.runtime.v2.task/k8s.io/.../rootfs
# type overlay (rw,relatime,
#   lowerdir=/var/lib/containerd/...:...,
#   upperdir=/var/lib/containerd/.../fs,
#   workdir=/var/lib/containerd/.../work)
```

## CRI Plugin and Kubernetes Integration

### CRI API Operations

The CRI plugin implements the gRPC `RuntimeService` and `ImageService` APIs:

```bash
# Use crictl to interact with CRI directly
# crictl is to containerd CRI as kubectl is to the Kubernetes API

# Configure crictl to use containerd
cat > /etc/crictl.yaml <<EOF
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
EOF

# List running pods (sandbox containers)
sudo crictl pods

# List containers
sudo crictl ps -a

# Pull an image via CRI
sudo crictl pull docker.io/library/nginx:1.25

# List images
sudo crictl images

# Get detailed container info
sudo crictl inspect <container-id>

# Get pod sandbox info
sudo crictl inspectp <pod-id>

# Check container logs (via CRI)
sudo crictl logs <container-id>

# Execute a command in a container
sudo crictl exec -it <container-id> /bin/sh

# Get container resource usage stats
sudo crictl stats
```

### Manually Invoking CRI via grpcurl

```bash
# Install grpcurl
go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest

# List available CRI services
sudo grpcurl \
  -plaintext \
  -unix /run/containerd/containerd.sock \
  list

# List running containers
sudo grpcurl \
  -plaintext \
  -unix /run/containerd/containerd.sock \
  -d '{"filter":{}}' \
  runtime.v1alpha2.RuntimeService/ListContainers

# Get pod sandbox status
sudo grpcurl \
  -plaintext \
  -unix /run/containerd/containerd.sock \
  -d '{"pod_sandbox_id":"<pod-id>","verbose":true}' \
  runtime.v1alpha2.RuntimeService/PodSandboxStatus
```

## Debugging Container Startup Failures

### Common Failure Categories

#### Image Pull Failures

```bash
# Check containerd logs for pull errors
journalctl -u containerd -f | grep -E "error|Error|failed|Failed"

# Check image pull progress
sudo ctr -n k8s.io content ls | grep -v complete

# Test registry connectivity
sudo ctr -n k8s.io images pull \
  --hosts-dir /etc/containerd/certs.d \
  registry.example.com/myapp:v1.0.0 \
  2>&1

# Configure private registry credentials
mkdir -p /etc/containerd/certs.d/registry.example.com
cat > /etc/containerd/certs.d/registry.example.com/hosts.toml <<EOF
server = "https://registry.example.com"

[host."https://registry.example.com"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/ssl/certs/ca-bundle.crt"
  client = [["/etc/containerd/registry-client.crt", "/etc/containerd/registry-client.key"]]
EOF

# For docker-format credentials
cat > /var/lib/kubelet/config.json <<EOF
{
  "auths": {
    "registry.example.com": {
      "auth": "<base64-encoded-user:password>"
    }
  }
}
EOF
```

#### Container OOMKilled

```bash
# Check if container was OOMKilled
kubectl describe pod <pod-name> -n <namespace> | grep -A5 "OOMKilled"

# Check kernel OOM events
dmesg | grep -E "OOM|killed process" | tail -20

# Check cgroup memory limit for a container
CONTAINER_PID=$(sudo crictl inspect <container-id> \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['pid'])")

# cgroups v2
cat /proc/$CONTAINER_PID/cgroup
# Look for the cgroup path, then:
cat /sys/fs/cgroup/<cgroup-path>/memory.max
cat /sys/fs/cgroup/<cgroup-path>/memory.current
cat /sys/fs/cgroup/<cgroup-path>/memory.events

# cgroups v1
cat /sys/fs/cgroup/memory/kubepods/burstable/<pod-uid>/<container-id>/memory.limit_in_bytes
cat /sys/fs/cgroup/memory/kubepods/burstable/<pod-uid>/<container-id>/memory.usage_in_bytes
cat /sys/fs/cgroup/memory/kubepods/burstable/<pod-uid>/<container-id>/memory.stat
```

#### Seccomp Profile Failures

```bash
# Enable seccomp violation logging
# Add to kernel cmdline: audit=1

# Watch for seccomp violations
auditctl -a always,exit -F arch=b64 -S all -k seccomp
ausearch -k seccomp -ts recent | tail -50

# Generate a custom seccomp profile using strace
strace -f -o /tmp/myapp.strace ./myapp &
# After capturing, convert strace output to seccomp profile
# Use tools like go-seccomp-bpf or oci-seccomp-bpf-hook

# Check if a container is using a custom seccomp profile
sudo crictl inspect <container-id> \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['info']['runtimeSpec']; print(d.get('linux',{}).get('seccomp',{}))"
```

#### AppArmor/SELinux Denials

```bash
# Check SELinux denials
ausearch -m AVC -ts recent | audit2allow -a | head -30

# Check for container-related SELinux denials
sealert -a /var/log/audit/audit.log 2>&1 | grep container_t

# Check AppArmor status (Ubuntu)
sudo aa-status | grep -E "containerd|runc"
sudo journalctl -k | grep "apparmor" | tail -20
```

#### runc Init Process Failures

```bash
# Enable runc debug logging
cat >> /etc/containerd/config.toml <<EOF
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  Debug = true
EOF
sudo systemctl restart containerd

# Watch runc execution
sudo journalctl -u containerd -f | grep runc

# Trace system calls during container creation
sudo strace -f -e trace=clone,unshare,setns,pivot_root,chroot \
  runc run test-container 2>&1 | head -100

# Check for pivot_root permission issues (common with some storage drivers)
# Error: pivot_root: invalid argument
# Solution: ensure /var/lib/containerd is on a filesystem that supports pivot_root

# Check overlay requires kernel support
cat /proc/filesystems | grep overlay
# If not present:
sudo modprobe overlay
echo "overlay" | sudo tee /etc/modules-load.d/overlay.conf
```

### Container Runtime Tracing with eBPF

```bash
# Trace all container processes being created
sudo bpftrace -e '
tracepoint:syscalls:sys_enter_clone
/comm == "runc" || comm == "containerd-shim-runc-v2"/
{
  printf("clone() from pid=%d comm=%s\n", pid, comm);
}
'

# Trace overlay filesystem operations for a specific container
PID=<container-pid>
sudo bpftrace -e "
kprobe:ovl_d_real
/pid == $PID/
{
  printf(\"overlay open: %s\n\", str(args->inode));
}
"

# Monitor cgroup events for containers
sudo bpftrace -e '
tracepoint:cgroup:cgroup_attach_task
{
  printf("pid=%d comm=%s cgroup=%s\n", args->pid, str(args->comm), str(args->path));
}
' | grep -E "containerd|runc|pause"
```

## containerd Shim Architecture

### How the Shim Works

Each container runs under a separate `containerd-shim-runc-v2` process. The shim:

1. Creates the initial container process via `runc create`
2. Starts it via `runc start`
3. Monitors the process lifecycle
4. Relays I/O between the container and containerd
5. Reports exit codes back to containerd when the container exits

This architecture allows containerd to restart or upgrade without affecting running containers:

```bash
# List shim processes
ps aux | grep containerd-shim

# Shim process hierarchy
pstree -p $(pgrep containerd | head -1) | head -20

# Connect to a container's shim directly via its socket
ls /run/containerd/io.containerd.runtime.v2.task/k8s.io/

# Check shim logs
journalctl -u containerd -f | grep "shim"
```

## Performance Considerations

### overlayfs Performance Tuning

```bash
# Check overlay xattr support (required for some features)
touch /var/lib/containerd/test-xattr
setfattr -n user.test -v "value" /var/lib/containerd/test-xattr
getfattr -n user.test /var/lib/containerd/test-xattr
rm /var/lib/containerd/test-xattr

# Enable native overlay diff (requires kernel 5.11+)
# In /etc/containerd/config.toml:
# [plugins."io.containerd.snapshotter.v1.overlayfs"]
#   root_path = ""
#   upper_dir_label = false
#   mount_options = ["index=off"]

# Monitor overlayfs cache pressure
watch -n2 'cat /proc/sys/fs/file-nr; echo; cat /proc/meminfo | grep -E "Dirty|Writeback|PageTables|Mapped"'

# Tune inotify limits for container-heavy nodes
echo "fs.inotify.max_user_watches = 1048576" | sudo tee /etc/sysctl.d/99-inotify.conf
echo "fs.inotify.max_user_instances = 8192" | sudo tee -a /etc/sysctl.d/99-inotify.conf
sudo sysctl --system
```

### Image Store Garbage Collection

```bash
# View garbage collection configuration
sudo ctr info | grep -A5 "GC"

# Trigger manual garbage collection
sudo ctr content gc

# Check content store size before/after
du -sh /var/lib/containerd/io.containerd.content.v1.content/

# Remove unused images via crictl
sudo crictl rmi --prune

# Remove unused images via ctr
sudo ctr -n k8s.io images ls -q | \
  grep -v "$(sudo crictl ps -a -q | \
    xargs -I{} sudo crictl inspect {} | \
    python3 -c 'import sys,json; [print(json.loads(l)["info"]["config"]["image"]["image"]) for l in sys.stdin if l.strip()]' 2>/dev/null | sort -u)" | \
  xargs -I{} sudo ctr -n k8s.io images rm {}
```

## Summary

The container runtime stack from kubelet through the CRI, containerd, and runc to the Linux kernel represents multiple abstraction layers, each with its own failure modes. runc implements the OCI spec by creating Linux namespaces, configuring cgroups, applying seccomp profiles, and executing the container process. containerd manages the higher-level lifecycle including image pulling, layer management via snapshotter plugins, and the CRI gRPC API for Kubernetes. The shim architecture decouples container processes from the containerd daemon for operational flexibility. When debugging startup failures, working systematically from the CRI level down through containerd logs, crictl inspection, and ultimately runc strace tracing allows pinpointing whether failures originate in image distribution, filesystem setup, or kernel namespace configuration.
