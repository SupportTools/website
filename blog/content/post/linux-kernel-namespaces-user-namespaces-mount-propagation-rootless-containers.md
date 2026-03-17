---
title: "Linux Kernel Namespaces: User Namespaces, Mount Propagation, and Rootless Container Security"
date: 2031-08-15T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Containers", "Security", "Rootless", "Kernel"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical exploration of Linux kernel namespaces, focusing on user namespaces for rootless containers, mount namespace propagation, and the security model that underpins modern container runtimes."
more_link: "yes"
url: "/linux-kernel-namespaces-user-namespaces-mount-propagation-rootless-containers/"
---

Linux kernel namespaces are the foundational technology behind every container runtime — Docker, containerd, Podman, and systemd-nspawn all use them. Understanding namespaces deeply is essential for container security hardening, debugging unexpected permission errors, and building custom container tooling. This post focuses on user namespaces (the security-critical namespace), mount namespace propagation modes, and how they combine to enable safe rootless containers.

<!--more-->

# Linux Kernel Namespaces: User Namespaces, Mount Propagation, and Rootless Container Security

## Overview

Linux currently has eight namespace types:

| Namespace | Isolation | Flag | Kernel Version |
|-----------|-----------|------|----------------|
| `mnt` | Filesystem mount points | `CLONE_NEWNS` | 2.4.19 |
| `uts` | Hostname and domain name | `CLONE_NEWUTS` | 2.6.19 |
| `ipc` | System V IPC, POSIX message queues | `CLONE_NEWIPC` | 2.6.19 |
| `net` | Network devices, stacks, ports | `CLONE_NEWNET` | 2.6.24 |
| `pid` | Process IDs | `CLONE_NEWPID` | 2.6.24 |
| `user` | User and group IDs | `CLONE_NEWUSER` | 3.8 |
| `cgroup` | cgroup root directory | `CLONE_NEWCGROUP` | 4.6 |
| `time` | Clock offsets | `CLONE_NEWTIME` | 5.6 |

User namespaces deserve special attention because they are the only namespace type that unprivileged users can create, and they are the foundation for all rootless container security.

---

## Section 1: Understanding User Namespaces

### 1.1 The Core Concept

A user namespace creates a new UID/GID mapping that lets processes appear to have elevated privileges inside the namespace while remaining unprivileged on the host:

```
Host System          User Namespace
───────────          ──────────────
UID 1000             UID 0 (root inside namespace)
UID 1000-65535       UID 1-65536 (mapped range)

The process running as UID 1000 on the host
appears as UID 0 (root) inside its user namespace.
On the host, it's still just UID 1000.
```

### 1.2 Creating a User Namespace

```c
// user-ns-demo.c — Create a user namespace and verify UID mapping
#include <stdio.h>
#include <unistd.h>
#include <sched.h>
#include <stdlib.h>

int main() {
    printf("Before unshare: euid=%d, egid=%d\n", geteuid(), getegid());

    // Create a new user namespace
    if (unshare(CLONE_NEWUSER) < 0) {
        perror("unshare");
        exit(1);
    }

    // After unshare, we appear as UID 65534 (nobody) until mappings are written
    printf("After unshare (before mapping): euid=%d, egid=%d\n", geteuid(), getegid());

    // UID mapping must be written by the parent or by the process itself
    // In a real scenario, the parent writes /proc/[pid]/uid_map
    return 0;
}
```

Using shell tools:

```bash
# Check current user namespace
ls -la /proc/self/ns/user
readlink /proc/self/ns/user

# Create a new user namespace with unshare(1)
unshare --user --map-root-user bash

# Inside the namespace:
id                    # uid=0(root) gid=0(root)
cat /proc/self/uid_map  # Shows the UID mapping
# 0  1000  1           # Container UID 0 -> Host UID 1000 (1 UID mapped)

# Files appear to be owned by root inside the namespace
ls -la /tmp/
# But these are really owned by your host UID
```

### 1.3 UID/GID Mappings

Mappings are written to `/proc/[pid]/uid_map` and `/proc/[pid]/gid_map`:

```
container-start  host-start  count
0                100000       65536
```

This maps container UIDs 0-65535 to host UIDs 100000-165535.

```bash
# Set up subuid/subgid mappings in /etc/subuid and /etc/subgid
# These define the ranges a user can use for UID mapping
cat /etc/subuid
# mmattox:100000:65536
# This means user 'mmattox' can map up to 65536 UIDs starting from 100000

cat /etc/subgid
# mmattox:100000:65536

# Use newuidmap/newgidmap to write mappings safely (setuid binaries)
newuidmap <pid> 0 100000 65536
newgidmap <pid> 0 100000 65536

# Verify mappings were applied
cat /proc/<pid>/uid_map
```

### 1.4 Nested User Namespaces

```bash
# Create nested namespaces (useful for understanding the security model)
# Level 0: Host (UID 1000)
id  # uid=1000

# Level 1: First user namespace (appears as UID 0)
unshare --user --map-root-user bash
id  # uid=0(root) gid=0(root)
cat /proc/self/uid_map  # 0  1000  1

# Level 2: Nested user namespace
unshare --user --map-root-user bash
id  # uid=0(root) gid=0(root)
cat /proc/self/uid_map  # 0  0  1  (mapped within parent namespace)

# From host, the nested root is still UID 1000
```

---

## Section 2: Mount Namespaces and Propagation

### 2.1 Mount Namespaces

Each mount namespace has its own view of the filesystem hierarchy:

```bash
# Create a new mount namespace
unshare --mount bash

# Inside the new namespace, mount something
mount -t tmpfs tmpfs /mnt/test

# This mount is INVISIBLE on the host
# Exit and verify:
ls /mnt/test  # should be empty on host
```

### 2.2 Mount Propagation Types

This is one of the most misunderstood aspects of mount namespaces. Propagation controls whether mounts in one namespace are visible in another:

| Propagation | Description | Use Case |
|-------------|-------------|----------|
| `shared` | Mount events propagate in both directions | NFS mounts seen everywhere |
| `slave` | Mount events from master propagate to slave; slave mounts don't go to master | Container gets host NFS, container mounts stay local |
| `private` | No propagation in either direction | Full isolation |
| `unbindable` | Private, cannot be bind-mounted | Preventing bind mount escapes |

```bash
# Check current propagation of a mount
cat /proc/self/mountinfo | grep " / "
# 23 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
#                              ^^^^^^^^ This is the propagation type

# Set a mount point to private (no propagation)
mount --make-private /mnt

# Set to shared
mount --make-shared /mnt

# Set to slave (inherits from parent, doesn't propagate back)
mount --make-slave /mnt

# Set recursively (affects all sub-mounts)
mount --make-rprivate /
```

### 2.3 Shared Subtrees Example

```bash
# Demonstration of shared mount propagation

# Terminal 1: in the original namespace
mkdir /mnt/shared-demo
mount -t tmpfs tmpfs /mnt/shared-demo
mount --make-shared /mnt/shared-demo

# Terminal 2: create a new namespace that inherits the shared mount
unshare --mount --propagation=private bash
# Now mount something under the shared-demo
mkdir /mnt/shared-demo/from-container
mount -t tmpfs tmpfs /mnt/shared-demo/from-container

# Back in Terminal 1, check if the container's mount is visible:
# With 'shared' propagation, it WILL be visible
ls /mnt/shared-demo/from-container  # visible!

# With 'slave' propagation, it would NOT be visible
# (mounts flow from master to slave, not back)
```

### 2.4 Why This Matters for Containers

```bash
# Docker uses 'rprivate' by default for container mounts
# This means no mount events propagate between host and container

# To share a mount with proper propagation control in Docker:
docker run --rm \
  --mount type=bind,source=/mnt/data,target=/data,bind-propagation=shared \
  alpine ls /data

# Or with rslave (recommended for many use cases):
docker run --rm \
  --mount type=bind,source=/mnt/data,target=/data,bind-propagation=rslave \
  alpine ls /data
# rslave means: host mounts become visible to container,
# but container mounts do NOT become visible to host
```

---

## Section 3: Rootless Containers — Combining Namespaces

### 3.1 The Rootless Container Stack

A rootless container uses multiple namespaces together:

```
user namespace:  Maps UID 0 inside container -> unprivileged host UID
mount namespace: Isolated filesystem view
pid namespace:   Isolated process IDs (PID 1 in container)
net namespace:   Isolated network stack (slirp4netns for connectivity)
uts namespace:   Isolated hostname
ipc namespace:   Isolated IPC
```

### 3.2 Manual Rootless Container Creation

```bash
# Step 1: Verify subuid/subgid setup
cat /etc/subuid  # Should have an entry for your user

# Step 2: Create all namespaces at once
# --fork creates a new PID namespace properly
# --pid is needed for correct PID 1 behavior
unshare \
  --user \
  --map-root-user \
  --mount \
  --pid \
  --fork \
  --net \
  --uts \
  --ipc \
  bash

# Inside: we appear as root
id
# uid=0(root) gid=0(root)

# Step 3: Set up the filesystem overlay
mkdir -p /tmp/rootfs/{upper,work,merged}
# We need a base filesystem to work with
# For demo, use the host's root as lower
mount -t overlay overlay \
  -o lowerdir=/,upperdir=/tmp/rootfs/upper,workdir=/tmp/rootfs/work \
  /tmp/rootfs/merged

# Step 4: Set up essential virtual filesystems in the container
mount -t proc proc /tmp/rootfs/merged/proc
mount -t sysfs sysfs /tmp/rootfs/merged/sys
mount -t tmpfs tmpfs /tmp/rootfs/merged/tmp
mount -t devtmpfs devtmpfs /tmp/rootfs/merged/dev

# Step 5: pivot_root or chroot into the new root
chroot /tmp/rootfs/merged /bin/bash

# Now inside the container with isolated view
```

### 3.3 Podman Rootless Implementation

```bash
# Install Podman and required tools
apt-get install -y podman uidmap slirp4netns fuse-overlayfs

# Configure subuid/subgid
usermod --add-subuids 100000-165535 mmattox
usermod --add-subgids 100000-165535 mmattox

# Verify rootless Podman configuration
podman info | grep -A5 "store:"
# Should show fuse-overlayfs or native overlayfs as storage driver

# Run a container rootlessly
podman run --rm -it alpine id
# uid=0(root) gid=0(root) groups=0(root)

# But on the host, the process runs as your UID
podman run --rm -d --name test alpine sleep 3600
ps aux | grep sleep
# mmattox  12345  ...  sleep 3600
# Still your UID on the host!

# Check the UID mapping
cat /proc/$(pgrep -f "sleep 3600")/uid_map
# 0  100000  65536
```

---

## Section 4: Security Implications

### 4.1 What Rootless Containers Can and Cannot Do

```bash
# CANNOT do in a rootless container:

# 1. Bind to privileged ports (<1024) without capability grants
# Inside rootless container:
python3 -m http.server 80
# Permission denied — no CAP_NET_BIND_SERVICE

# 2. Load kernel modules
modprobe nfs
# Permission denied

# 3. Mount filesystems (except in user namespace)
mount -t nfs 10.0.0.1:/data /mnt
# Permission denied

# 4. Access /proc/kcore, /proc/kmem
cat /proc/kcore
# Permission denied

# CAN do in a rootless container:

# 1. Bind to ports >= 1024
python3 -m http.server 8080
# Works!

# 2. Write to overlay filesystem as "root"
touch /etc/myconfig
# Works (goes to overlay upper layer)

# 3. Create additional namespaces
unshare --user --map-root-user bash
# Works! (nested namespaces)
```

### 4.2 Capabilities in User Namespaces

```bash
# Inside a user namespace, a process can have capabilities
# BUT they are scoped to the user namespace, not the host kernel

# Check capabilities inside user namespace
unshare --user --map-root-user bash
capsh --print
# Current: = cap_chown,cap_dac_override,...(all capabilities!)
# But these are USER NAMESPACE capabilities, not real root capabilities

# A namespace-scoped capability like CAP_NET_ADMIN
# only controls network interfaces within the network namespace
# Not the host network interfaces

# Verify: try to change the host interface MTU
ip link set eth0 mtu 9000
# RTNETLINK answers: Operation not permitted
# Even with CAP_NET_ADMIN in user namespace!
```

### 4.3 Kernel Vulnerabilities and User Namespaces

User namespaces have historically been involved in privilege escalation vulnerabilities:

```bash
# Check if unprivileged user namespaces are enabled
cat /proc/sys/kernel/unprivileged_userns_clone
# 1 = enabled, 0 = disabled (some distros default to 0)

# Ubuntu 24.04+ restricts user namespace creation
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
# 1 = restricted (AppArmor controls which processes can create user ns)

# Disable unprivileged user namespace creation (disables rootless containers)
sysctl -w kernel.unprivileged_userns_clone=0

# For enterprise environments, consider the tradeoff:
# - Enabled: allows rootless containers (and potential exploits)
# - Disabled: prevents rootless containers but more secure kernel
```

### 4.4 Seccomp and User Namespace Security

```bash
# The default Docker/Podman seccomp profiles block dangerous syscalls
# Even inside user namespaces

# Check which syscalls are blocked
strace -e trace=ptrace podman run alpine ls 2>&1 | grep EPERM

# Custom seccomp profile to block user namespace creation inside containers
cat > /etc/containers/seccomp.json << 'EOF'
{
  "defaultAction": "SCMP_ACT_ALLOW",
  "syscalls": [
    {
      "names": ["unshare", "clone"],
      "action": "SCMP_ACT_ERRNO",
      "comment": "Prevent nested user namespace creation"
    }
  ]
}
EOF
```

---

## Section 5: Mount Namespace Operations in Practice

### 5.1 Bind Mounts

```bash
# Bind mount: expose a file or directory at a different path
# This works within a single mount namespace
mount --bind /source/dir /target/dir

# Read-only bind mount
mount --bind /source/dir /target/dir
mount --remount,ro,bind /target/dir

# Bind mount a single file
mount --bind /etc/custom-hosts /etc/hosts

# Rootless bind mounts (using user namespace)
unshare --user --map-root-user --mount bash
mount --bind /home/mmattox/project /tmp/workspace
# This is visible only in this namespace
```

### 5.2 Overlay Filesystem (OverlayFS)

OverlayFS is how containers provide copy-on-write behavior:

```bash
# Basic overlay filesystem
mkdir -p /overlay/{lower,upper,work,merged}

# Populate lower (read-only base) with some files
echo "base content" > /overlay/lower/file1.txt

# Mount the overlay
mount -t overlay overlay \
  -o lowerdir=/overlay/lower,upperdir=/overlay/upper,workdir=/overlay/work \
  /overlay/merged

# Read existing file (reads from lower)
cat /overlay/merged/file1.txt  # "base content"

# Modify the file (write goes to upper)
echo "modified" > /overlay/merged/file1.txt

# Check upper (only changed files appear here)
ls /overlay/upper/
# file1.txt (the modified version)

# Lower is unchanged
cat /overlay/lower/file1.txt  # "base content"

# From merged view:
cat /overlay/merged/file1.txt  # "modified"

# Deleting a file creates a "whiteout" in upper
rm /overlay/merged/file1.txt
ls -la /overlay/upper/
# c---------  .wh.file1.txt  (character device with major:minor 0:0)
```

### 5.3 Multiple Lower Layers

Container images use multiple lower layers corresponding to image layers:

```bash
# Create three layers
mkdir -p /layers/{base,app,config}/{upper,work} /layers/merged

# Populate layers
echo "os files" > /layers/base/upper/os-file.txt
echo "app binary" > /layers/app/upper/app
echo "config file" > /layers/config/upper/app.conf

# Mount with multiple lower layers (newest first in colon-separated list)
mount -t overlay overlay \
  -o lowerdir=/layers/config/upper:/layers/app/upper:/layers/base/upper,\
upperdir=/tmp/container-upper,workdir=/tmp/container-work \
  /layers/merged

ls /layers/merged/
# app  app.conf  os-file.txt
# All layers are visible, newest takes precedence
```

---

## Section 6: PID Namespace Deep Dive

### 6.1 PID Namespace Behavior

```bash
# Create a new PID namespace
# --fork is required for PID 1 to work correctly
unshare --pid --fork bash

# Inside: PID 1 is our bash shell
echo $$  # 1

# We can see processes inside our namespace
ps aux
# Shows only processes in this namespace

# From the host, we can still see the process (with its host PID)
# The process has TWO PIDs: one in each namespace
```

### 6.2 PID Namespace and init Behavior

```bash
# PID 1 in a namespace must handle orphaned processes
# If PID 1 exits, all processes in the namespace are killed

# When running systemd in a container, it becomes PID 1
# This is why docker run -it ubuntu systemd requires special handling:
# --cgroupns=private --tmpfs /tmp --tmpfs /run --tmpfs /run/lock
docker run --rm -it \
  --cgroupns=private \
  --tmpfs /tmp \
  --tmpfs /run \
  --tmpfs /run/lock \
  ubuntu:22.04 \
  /sbin/init
```

---

## Section 7: Namespace Inspection and Debugging

### 7.1 Inspecting Running Namespaces

```bash
# List namespaces for a specific process
ls -la /proc/<pid>/ns/
# lrwxrwxrwx cgroup -> cgroup:[4026531835]
# lrwxrwxrwx ipc    -> ipc:[4026531839]
# lrwxrwxrwx mnt    -> mnt:[4026532001]  ← different from init = containerized
# lrwxrwxrwx net    -> net:[4026531992]
# lrwxrwxrwx pid    -> pid:[4026531836]
# lrwxrwxrwx user   -> user:[4026532000] ← different = user namespace
# lrwxrwxrwx uts    -> uts:[4026531838]

# Compare with PID 1 (init)
ls -la /proc/1/ns/

# Find all processes in a specific namespace
# (useful for finding all container processes)
CONTAINER_MNT_NS=$(ls -la /proc/$(docker inspect -f '{{.State.Pid}}' container-name)/ns/mnt | grep -oP 'mnt:\K.*')
for pid in /proc/*/ns/mnt; do
    ns=$(readlink "$pid" 2>/dev/null)
    if [[ "$ns" == *"$CONTAINER_MNT_NS"* ]]; then
        echo "PID: $(basename $(dirname $pid))"
    fi
done
```

### 7.2 Entering Namespaces with nsenter

```bash
# Enter a container's namespaces without using docker exec
# Useful for debugging containers that don't have sh/bash

CONTAINER_PID=$(docker inspect -f '{{.State.Pid}}' my-container)

# Enter all namespaces
nsenter -t $CONTAINER_PID --all bash

# Enter only specific namespaces
nsenter -t $CONTAINER_PID --mount --pid bash

# Enter only the network namespace (to run network tools)
nsenter -t $CONTAINER_PID --net ip addr

# Enter as a specific user
nsenter -t $CONTAINER_PID --user --preserve-credentials ip addr

# Run a command in a container's mount namespace to access its filesystem
nsenter -t $CONTAINER_PID --mount -- ls /var/log/app/
```

### 7.3 lsns — Namespace Listing Tool

```bash
# List all namespaces on the system
lsns

# Show only user namespaces
lsns -t user

# Show only mount namespaces with process info
lsns -t mnt -o NS,TYPE,NPROCS,PID,COMMAND

# Find which namespace a process is in
lsns -p <pid>
```

---

## Section 8: Kubernetes and Namespaces

### 8.1 How Kubernetes Uses Namespaces

```yaml
# Pod security with namespace settings
apiVersion: v1
kind: Pod
metadata:
  name: security-demo
spec:
  # PID namespace sharing between containers in the same pod
  shareProcessNamespace: true

  securityContext:
    # Run all containers as non-root UID 1000
    runAsUser: 1000
    runAsGroup: 1000
    runAsNonRoot: true
    fsGroup: 2000

    # Use seccomp to restrict syscalls
    seccompProfile:
      type: RuntimeDefault

    # Namespace settings
    sysctls:
      - name: net.ipv4.tcp_syncookies
        value: "1"

  containers:
    - name: app
      image: yourorg/app:latest
      securityContext:
        # Drop all capabilities, add only what's needed
        capabilities:
          drop: ["ALL"]
          add: ["NET_BIND_SERVICE"]
        # Read-only root filesystem
        readOnlyRootFilesystem: true
        # Prevent privilege escalation
        allowPrivilegeEscalation: false
```

### 8.2 Enabling Rootless Containers in Kubernetes

```yaml
# containerd configuration for user namespace support
# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
  runtime_type = "io.containerd.runc.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
    SystemdCgroup = true

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "overlayfs"

# Enable user namespace support in kubelet
# /etc/kubernetes/kubelet.conf (or kubelet flags)
featureGates:
  UserNamespacesSupport: true
```

```yaml
# Use user namespace for a Pod (requires Kubernetes 1.30+ and enabled feature gate)
apiVersion: v1
kind: Pod
metadata:
  name: userns-pod
spec:
  hostUsers: false  # Enable user namespace for this pod
  containers:
    - name: app
      image: yourorg/app:latest
      # Container root maps to unprivileged UID on node
      securityContext:
        runAsUser: 0  # This is UID 0 inside user namespace, not host root
```

---

## Section 9: Security Hardening

### 9.1 AppArmor and User Namespaces

```bash
# Ubuntu 24.04+ restricts user namespace creation via AppArmor
# This is a defense-in-depth measure against namespace-based exploits

# Check current restriction policy
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns

# Allow specific applications to create user namespaces
# while blocking others
cat > /etc/apparmor.d/allow-container-tools << 'EOF'
abi <abi/4.0>,
include <tunables/global>

profile allow-userns /usr/bin/podman flags=(unconfined) {
    userns,
}

profile allow-userns /usr/bin/newuidmap flags=(unconfined) {
    userns,
}
EOF

apparmor_parser -r /etc/apparmor.d/allow-container-tools
```

### 9.2 Seccomp Profile for User Namespace Security

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "close", "stat", "fstat",
        "openat", "readv", "writev", "pread64", "pwrite64"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["unshare"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "op": "SCMP_CMP_MASKED_EQ",
          "value": 268435456,
          "valueTwo": 0
        }
      ],
      "comment": "Allow unshare but not with CLONE_NEWUSER (prevent privilege escalation)"
    }
  ]
}
```

---

## Section 10: Practical Debugging Examples

### 10.1 Debugging Container Filesystem Issues

```bash
# Container cannot write to a volume — debug with namespace inspection

# Find container PID
CPID=$(crictl inspect --output json <container-id> | jq .info.pid)

# Enter the mount namespace
nsenter -t $CPID --mount ls -la /mounted-volume

# Check the actual mount propagation
nsenter -t $CPID --mount cat /proc/self/mountinfo | grep mounted-volume

# Compare UID from container's perspective vs host
nsenter -t $CPID --user id
cat /proc/$CPID/uid_map

# Check effective capabilities in container
nsenter -t $CPID --user cat /proc/self/status | grep Cap
```

### 10.2 Network Namespace Debugging

```bash
# Debug container network issues by entering its network namespace
CPID=$(docker inspect -f '{{.State.Pid}}' my-container)

# Run network diagnostics in container's network namespace
nsenter -t $CPID --net -- ip addr show
nsenter -t $CPID --net -- ip route
nsenter -t $CPID --net -- ss -tulpn
nsenter -t $CPID --net -- iptables -L -n -v

# Capture traffic from a container's network namespace on the host
nsenter -t $CPID --net -- tcpdump -i eth0 -w /tmp/capture.pcap
```

---

## Summary

Linux namespaces are a powerful but nuanced feature. Key takeaways for container security practitioners:

1. **User namespaces are the rootless foundation** — they allow containers to appear as root while being unprivileged on the host, but this security boundary must be defended carefully
2. **Mount propagation determines isolation** — `rprivate` (no propagation) is the safe default for containers; `rslave` is appropriate when containers need to see host mounts
3. **Rootless does not mean completely safe** — user namespace capabilities are scoped to the namespace, providing strong isolation, but kernel vulnerabilities can still escape
4. **UID mapping is critical** — without proper subuid/subgid configuration, rootless containers cannot map the full UID range needed for realistic workloads
5. **Layered defense** — combine user namespaces with seccomp, AppArmor/SELinux, and read-only filesystems for defense in depth
6. **nsenter is your debugging friend** — when container tooling fails, nsenter lets you enter any individual namespace for targeted debugging
7. **Test your propagation assumptions** — mount propagation behavior surprises many engineers; always verify what is visible where in your container environment
