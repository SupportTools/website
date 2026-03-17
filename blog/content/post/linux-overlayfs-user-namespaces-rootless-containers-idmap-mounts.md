---
title: "Linux OverlayFS with User Namespaces: Rootless Container Storage, Idmap Mounts, and Upper/Lower Dir Patterns"
date: 2032-02-01T00:00:00-05:00
draft: false
tags: ["Linux", "OverlayFS", "Containers", "User Namespaces", "Rootless", "Storage", "Kernel"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux OverlayFS combined with user namespaces for rootless container storage. Covers overlayfs mount mechanics, upper/lower/work directory patterns, idmap mount support in kernel 5.19+, fuse-overlayfs as a fallback, and production rootless container storage configuration."
more_link: "yes"
url: "/linux-overlayfs-user-namespaces-rootless-containers-idmap-mounts/"
---

OverlayFS is the storage driver behind Docker, containerd, and Podman containers. It enables copy-on-write layering by composing multiple directory trees into a unified view. When combined with user namespaces for rootless containers, the interaction is complex: ownership mapping, privilege restrictions, and idmap mounts all affect behavior. This guide covers the kernel internals and production configuration for rootless container storage.

<!--more-->

# Linux OverlayFS with User Namespaces

## OverlayFS Fundamentals

OverlayFS presents a merged view of two directory trees: a read-only lower directory and a read-write upper directory. Reads come from upper if the file exists there, otherwise from lower. Writes go to upper. Deletions create "whiteout" files in upper that hide lower entries.

```
Container View (merged)
        |
   OverlayFS
   /          \
upper dir    lower dir(s)
(read-write) (read-only, stacked)
   |
work dir (internal, same fs as upper)
```

### Basic Mount

```bash
# Create the directory structure
mkdir -p /tmp/overlay/{lower,upper,work,merged}

# Create files in lower (simulates container image layer)
echo "base config" > /tmp/overlay/lower/config.txt
echo "base binary" > /tmp/overlay/lower/app

# Mount overlayfs
mount -t overlay overlay \
  -o lowerdir=/tmp/overlay/lower,\
     upperdir=/tmp/overlay/upper,\
     workdir=/tmp/overlay/work \
  /tmp/overlay/merged

# Read from lower (file not in upper yet)
cat /tmp/overlay/merged/config.txt
# base config

# Write to merged (goes to upper)
echo "modified config" > /tmp/overlay/merged/config.txt

# Upper now has the modified file
cat /tmp/overlay/upper/config.txt
# modified config

# Lower is untouched
cat /tmp/overlay/lower/config.txt
# base config

# Delete a file from merged (creates a whiteout in upper)
rm /tmp/overlay/merged/app
ls -la /tmp/overlay/upper/
# total 8
# -rw-r--r-- 1 root root 16 Jan  1 00:00 config.txt
# c--------- 1 root root 0,  0 Jan  1 00:00 app  <- character device, major/minor 0/0 = whiteout

# Unmount
umount /tmp/overlay/merged
```

### Multi-Layer Lower Directories

Container images have multiple layers. OverlayFS supports stacking them:

```bash
# Three image layers: base, middleware, app
mkdir -p /tmp/layers/{base,middleware,app,upper,work,merged}

# base layer: OS files
mkdir -p /tmp/layers/base/usr/bin
echo "#!/bin/sh" > /tmp/layers/base/usr/bin/sh
chmod +x /tmp/layers/base/usr/bin/sh

# middleware layer: runtime
mkdir -p /tmp/layers/middleware/usr/lib
echo "libruntime.so" > /tmp/layers/middleware/usr/lib/libruntime.so

# app layer: application
mkdir -p /tmp/layers/app/usr/local/bin
echo "#!/bin/sh\necho hello" > /tmp/layers/app/usr/local/bin/myapp
chmod +x /tmp/layers/app/usr/local/bin/myapp

# Mount with multiple lower dirs (colon-separated, top-to-bottom priority)
mount -t overlay overlay \
  -o lowerdir=/tmp/layers/app:/tmp/layers/middleware:/tmp/layers/base,\
     upperdir=/tmp/layers/upper,\
     workdir=/tmp/layers/work \
  /tmp/layers/merged

# Higher layers (leftmost) override lower layers
ls /tmp/layers/merged/usr/bin/      # from base
ls /tmp/layers/merged/usr/lib/      # from middleware
ls /tmp/layers/merged/usr/local/bin/ # from app
```

### Kernel OverlayFS Options

```bash
# Mount options (kernel 5.11+)
mount -t overlay overlay \
  -o lowerdir=lower1:lower2:lower3,\
     upperdir=upper,\
     workdir=work,\
     userxattr,\         # use user.* xattrs instead of trusted.* (required for rootless)
     redirect_dir=on,\   # support efficient directory renames
     metacopy=on,\       # copy only metadata on chown/chmod (not file data)
     index=on,\          # enable hardlink counting across layers
     volatile \          # skip fsync for performance (container scratch space)
  merged

# metacopy is important for image pull performance:
# Without metacopy: chown on a file copies the entire file to upper
# With metacopy: only stores metadata override in upper (pointer to lower data)
```

## User Namespaces and OverlayFS

User namespaces allow a process to have a different view of UIDs/GIDs. UID 0 inside a user namespace maps to an unprivileged UID outside (e.g., 100000).

### User Namespace UID/GID Mapping

```bash
# /etc/subuid and /etc/subgid define the mapping range
# Format: username:start:count
cat /etc/subuid
# alice:100000:65536
# bob:165536:65536

# This means alice's container UID 0 maps to host UID 100000
# alice's container UID 1000 maps to host UID 101000

# Configure for a service account (e.g., container runtime user)
echo "containeruser:200000:65536" | sudo tee -a /etc/subuid
echo "containeruser:200000:65536" | sudo tee -a /etc/subgid
```

### OverlayFS in User Namespaces (Before Kernel 5.11)

Before kernel 5.11, OverlayFS was only mountable as root. Rootless containers had to use `fuse-overlayfs` as a workaround.

Kernel 5.11 added support for mounting OverlayFS inside user namespaces with the `userxattr` option:

```bash
# Check if unprivileged overlayfs is supported
grep CONFIG_OVERLAY_FS /boot/config-$(uname -r)
# CONFIG_OVERLAY_FS=m  (module)
# CONFIG_OVERLAY_FS_REDIRECT_DIR=y
# CONFIG_OVERLAY_FS_REDIRECT_ALWAYS_FOLLOW=y
# CONFIG_OVERLAY_FS_INDEX=y
# CONFIG_OVERLAY_FS_XINO_AUTO=y
# CONFIG_OVERLAY_FS_METACOPY=y
# CONFIG_OVERLAY_FS_DEBUG=n

# Check kernel version for user namespace overlayfs
uname -r
# Requires >= 5.11 for FUSE-less rootless overlayfs

# Ubuntu 22.04+: kernel sysctl for user namespace overlay
cat /proc/sys/kernel/unprivileged_userns_clone
# 1  (enabled)

# Some distributions disable this for security
# Enable temporarily for testing:
sysctl -w kernel.unprivileged_userns_clone=1
```

### Rootless OverlayFS Mount (Kernel 5.11+)

```bash
# As a regular user in a user namespace
unshare --user --map-root-user --mount -- bash << 'EOF'
    # Inside user namespace: we appear as root
    # But we're really uid 1000 on the host

    mkdir -p /tmp/rootless-overlay/{lower,upper,work,merged}
    echo "content" > /tmp/rootless-overlay/lower/file.txt

    # Mount with userxattr (required for user namespaces)
    mount -t overlay overlay \
        -o lowerdir=/tmp/rootless-overlay/lower,\
           upperdir=/tmp/rootless-overlay/upper,\
           workdir=/tmp/rootless-overlay/work,\
           userxattr \
        /tmp/rootless-overlay/merged

    ls /tmp/rootless-overlay/merged/
    echo "modified" > /tmp/rootless-overlay/merged/file.txt
    echo "new file" > /tmp/rootless-overlay/merged/new.txt

    ls /tmp/rootless-overlay/upper/
    # file.txt  new.txt

    umount /tmp/rootless-overlay/merged
EOF
```

## Idmap Mounts (Kernel 5.12+)

Idmap mounts allow remapping file ownership when a filesystem is mounted. This is critical for rootless containers where image files are owned by virtual UIDs (0-65535) that must be remapped to the container's UID range (e.g., 100000-165535 on the host).

### The Problem Idmap Solves

```bash
# Container image layer has files owned by root (uid=0)
# In rootless mode, host uid=0 is not available to unprivileged user
# We need files to appear as uid=0 inside container
# but be owned by uid=100000 on the host

# Without idmap:
# - Run as root inside container: uid 0 doesn't own the host files -> permission denied
# - OR: chown all files to 100000 on host (slow, modifies image, unsafe)

# With idmap mount:
# - Mount the lower dir with uid mapping: 0->100000, 1->100001, etc.
# - Files owned by host uid 100000 appear as uid 0 inside the mount
# - No file copying, no chown, purely metadata remapping in VFS
```

### Creating an Idmap Mount

```bash
# Idmap mounts require a user namespace with the desired mapping
# The mount_setattr syscall (or mount --bind with --idmap) applies the mapping

# Using util-linux 2.38+ (mount --bind --idmap)
# Or using the low-level mount_setattr API

# Example with newuidmap/newgidmap for container runtime
cat > /tmp/create_idmap_mount.sh << 'SCRIPT'
#!/bin/bash
# Create an idmap bind mount
# Usage: create_idmap_mount.sh <source> <target> <uid-map> <gid-map>
# uid-map format: "container_uid host_uid count"

SOURCE="$1"
TARGET="$2"
UID_MAP="$3"  # "0 100000 65536"
GID_MAP="$4"  # "0 100000 65536"

# Create user namespace with the mapping
# Then create a bind mount within that namespace
# and "steal" the file descriptor to apply the idmap

# This is what container runtimes do internally
# (simplified representation)
unshare --user \
    --map-user="$(echo $UID_MAP | awk '{print $1}')" \
    --map-group="$(echo $GID_MAP | awk '{print $1}')" -- \
    mount --bind "$SOURCE" "$TARGET"
SCRIPT
```

### Kernel API: mount_setattr for Idmap

```c
#include <sys/mount.h>
#include <linux/mount.h>
#include <linux/fcntl.h>
#include <unistd.h>

// Creates an idmapped bind mount using new mount API
int create_idmap_mount(const char *source, const char *target,
                       int userns_fd)
{
    // Open the source as a mount FD
    int src_fd = open_tree(AT_FDCWD, source,
                           OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC |
                           AT_EMPTY_PATH);
    if (src_fd < 0) return -1;

    // Apply the idmap from the user namespace FD
    struct mount_attr attr = {
        .attr_set  = MOUNT_ATTR_IDMAP,
        .userns_fd = userns_fd,
    };
    if (mount_setattr(src_fd, "", AT_EMPTY_PATH, &attr, sizeof(attr)) < 0) {
        close(src_fd);
        return -1;
    }

    // Attach the mapped mount to the target
    if (move_mount(src_fd, "", AT_FDCWD, target, MOVE_MOUNT_F_EMPTY_PATH) < 0) {
        close(src_fd);
        return -1;
    }

    close(src_fd);
    return 0;
}

// Create the user namespace with uid/gid mappings
int create_userns_with_mapping(const char *uid_map, const char *gid_map)
{
    int fd = open("/proc/self/ns/user", O_RDONLY);
    if (fd < 0) return -1;

    // Clone into new user namespace
    if (unshare(CLONE_NEWUSER) < 0) {
        close(fd);
        return -1;
    }

    // Write uid/gid mappings
    int uid_map_fd = open("/proc/self/uid_map", O_WRONLY);
    write(uid_map_fd, uid_map, strlen(uid_map));
    close(uid_map_fd);

    // Write "deny" to setgroups before writing gid_map
    int setgroups_fd = open("/proc/self/setgroups", O_WRONLY);
    write(setgroups_fd, "deny", 4);
    close(setgroups_fd);

    int gid_map_fd = open("/proc/self/gid_map", O_WRONLY);
    write(gid_map_fd, gid_map, strlen(gid_map));
    close(gid_map_fd);

    // Return the new user namespace FD
    int userns_fd = open("/proc/self/ns/user", O_RDONLY);
    // Restore original namespace
    setns(fd, CLONE_NEWUSER);
    close(fd);
    return userns_fd;
}
```

## Container Runtime Integration

### containerd with Native OverlayFS

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "overlayfs"

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
      runtime_type = "io.containerd.runc.v2"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
        SystemdCgroup = true

# Rootless containerd (run as non-root user):
[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "native"  # or "fuse-overlayfs" for overlayfs features

# Check what snapshotter is in use
ctr plugins ls | grep snapshotter
# io.containerd.snapshotter.v1    native          -    ok
# io.containerd.snapshotter.v1    overlayfs       -    ok  <- this one
# io.containerd.snapshotter.v1    fuse-overlayfs  -    ok
```

### Podman Rootless Storage

```ini
# ~/.config/containers/storage.conf (rootless user)
[storage]
driver = "overlay"

[storage.options]
# Use native overlay if kernel supports it (>= 5.11)
# Falls back to fuse-overlayfs automatically if not
graphRoot = "/home/user/.local/share/containers/storage"
runRoot = "/run/user/1000/containers"

[storage.options.overlay]
# Explicit options for native overlay in user namespace
mount_program = ""  # empty = use kernel overlay
mountopt = "nodev,metacopy=on"

# If kernel overlay is not available, use fuse-overlayfs
# mount_program = "/usr/bin/fuse-overlayfs"
```

```bash
# Verify Podman storage driver
podman info | grep -A5 "graphDriverName"
# graphDriverName: overlay
# graphOptions:
#   overlay.mount_program: /usr/bin/fuse-overlayfs
#   overlay.mountopt: nodev

# Check which filesystem type is used
podman info | grep graphRoot
stat -f ~/.local/share/containers/storage/overlay
# file system type (type): overlayfs (0x794c7630)
# or: fuse (0x65735546) if using fuse-overlayfs

# Force native kernel overlay (requires kernel 5.11+)
podman --storage-opt overlay.mount_program="" info
```

## fuse-overlayfs: Rootless Fallback

For kernels < 5.11 or when unprivileged overlay is disabled, `fuse-overlayfs` provides the same semantics via FUSE:

```bash
# Install fuse-overlayfs
apt install fuse-overlayfs
# or
dnf install fuse-overlayfs

# Check version (need >= 1.9 for idmap support)
fuse-overlayfs --version
# fuse-overlayfs: version 1.13

# Manual fuse-overlayfs mount
fuse-overlayfs \
  -o lowerdir=/tmp/layers/app:/tmp/layers/base,\
     upperdir=/tmp/fuse-overlay/upper,\
     workdir=/tmp/fuse-overlay/work \
  /tmp/fuse-overlay/merged

# fuse-overlayfs with idmap
fuse-overlayfs \
  -o lowerdir=/tmp/lower,\
     upperdir=/tmp/upper,\
     workdir=/tmp/work,\
     uidmapping=0:100000:65536,\
     gidmapping=0:100000:65536 \
  /tmp/merged
```

### Performance Comparison: Kernel vs FUSE

```bash
# Benchmark: create 10,000 files in a container layer

# Test with kernel overlayfs (native)
time bash -c "
  mount -t overlay overlay -o lowerdir=/tmp/lower,upperdir=/tmp/upper,workdir=/tmp/work /tmp/merged
  for i in \$(seq 10000); do echo \$i > /tmp/merged/file\$i; done
  umount /tmp/merged
"
# real 0m2.341s

# Test with fuse-overlayfs
time bash -c "
  fuse-overlayfs -o lowerdir=/tmp/lower,upperdir=/tmp/upper,workdir=/tmp/work /tmp/merged
  for i in \$(seq 10000); do echo \$i > /tmp/merged/file\$i; done
  fusermount -u /tmp/merged
"
# real 0m8.712s (3.7x slower due to FUSE context switches)

# For file I/O heavy workloads, native overlayfs is significantly faster
# FUSE overhead is most pronounced with small file operations
```

## Debugging OverlayFS

### Inspect OverlayFS Mounts

```bash
# List all overlayfs mounts
findmnt -t overlay

# Detailed mount info
findmnt -t overlay -o TARGET,SOURCE,OPTIONS,FSTYPE

# For a specific container (containerd)
CONTAINER_ID="abc123..."
# Find the overlayfs mount for the container
cat /proc/mounts | grep overlay | grep "$CONTAINER_ID"

# Or via containerd
ctr snapshots info "$CONTAINER_ID"
```

### Inspect Layer Content

```bash
# Find all layers for a container image
docker inspect nginx:latest | jq '.[0].GraphDriver.Data'
# {
#   "LowerDir": "/var/lib/docker/overlay2/abc.../diff:...",
#   "MergedDir": "/var/lib/docker/overlay2/xyz.../merged",
#   "UpperDir": "/var/lib/docker/overlay2/xyz.../diff",
#   "WorkDir": "/var/lib/docker/overlay2/xyz.../work"
# }

# Inspect what changed in a container (upper dir only)
CONTAINER=$(docker inspect mycontainer | jq -r '.[0].GraphDriver.Data.UpperDir')
find "$CONTAINER" -newer /tmp/start-marker

# List whiteout files (deleted files)
find "$CONTAINER" -type c  # character devices with major:minor 0:0
```

### Kernel Tracing for OverlayFS

```bash
# Trace overlayfs operations with ftrace
echo 1 > /sys/kernel/debug/tracing/tracing_on
echo 'ovl_*' > /sys/kernel/debug/tracing/set_ftrace_filter
echo function > /sys/kernel/debug/tracing/current_tracer

# Run operation
cat /tmp/merged/somefile

# View trace
cat /sys/kernel/debug/tracing/trace | head -30
# ...
# cat-12345   [000] .... 123.456: ovl_open_realfile <-ovl_open
# cat-12345   [000] .... 123.456: ovl_read_iter <-new_sync_read

# eBPF alternative (no permanent tracing overhead)
bpftrace -e '
kprobe:ovl_create_upper,
kprobe:ovl_copy_up_one,
kprobe:ovl_create_whiteout
{
    printf("%s %s\n", comm, func);
}'
```

### Common OverlayFS Issues

```bash
# Issue 1: "overlayfs: filesystem on upper/work is not supported as upperdir"
# Upper and work must be on the same filesystem (not overlayfs itself)
mount | grep "on /var/lib/docker type overlayfs"
# If upper is on another overlayfs, use a different path

# Issue 2: "overlayfs: failed to set opaque flag on upper"
# Requires xattr support on the underlying filesystem
# Check: touch /tmp/test && setfattr -n trusted.overlay.opaque -v y /tmp/test
# If fails: filesystem doesn't support xattrs (e.g., FAT, some NFS)

# Issue 3: "overlayfs: unlink ... -13 EACCES" in rootless mode
# Symptom: container cannot delete files from image layers
# Solution: use userxattr mount option
mount -t overlay overlay \
  -o lowerdir=...,upperdir=...,workdir=...,userxattr \
  merged

# Issue 4: Slow file operations in rootless containers
# Symptom: container I/O is 3-5x slower than native
# Cause: using fuse-overlayfs when kernel overlay is available
podman info | grep mount_program
# If it shows fuse-overlayfs, upgrade kernel to 5.11+

# Issue 5: "EROFS: readonly filesystem" on container write
# Symptom: write fails even though container should have rw layer
# Cause: upper directory is on a read-only mount
findmnt --output TARGET,OPTIONS /var/lib/containers/storage
# Check OPTIONS for 'ro'
```

## Security Considerations

```bash
# OverlayFS with user namespaces: containment boundaries

# 1. Seccomp: block mount syscall in container to prevent overlay escape
# Container runtimes apply seccomp profiles that deny mount()

# 2. Capability: CAP_SYS_ADMIN not available in rootless containers
# Kernel enforces this: unprivileged overlayfs uses user.* xattrs only

# 3. File access: upper dir should not be world-readable on host
chmod 700 /var/lib/containers/storage/overlay

# 4. Whiteout files: a container can create char devices if it has CAP_MKNOD
# Block this with seccomp or by dropping CAP_MKNOD
# Runc and crun drop CAP_MKNOD by default

# 5. Path traversal via symlinks: kernel 5.12+ addresses symlink attacks
# in overlayfs via redirect_dir hardening

# Audit mounts
auditctl -a always,exit -F arch=b64 -S mount -k container_mount
ausearch -k container_mount | grep overlayfs
```

## Production Configuration Summary

```bash
# /etc/sysctl.d/99-rootless-containers.conf

# Required for rootless container user namespaces
kernel.unprivileged_userns_clone = 1

# Allow user namespaces (required for rootless podman/buildah)
user.max_user_namespaces = 28633

# Maximum number of nested user namespaces
# (limit to prevent resource exhaustion)
user.max_pid_namespaces = 28633

# For overlayfs on tmpfs (CI environments)
# Don't set vm.overcommit_memory = 0 — container build tools expect overcommit
```

```bash
# Validate rootless overlay support
podman system info --format json | jq '.store.graphOptions'

# Quick test: run rootless container
podman run --rm alpine cat /proc/self/maps | grep overlay
# If using native overlay: maps show overlay
# If using fuse: maps show fuse.fuse-overlayfs

# Performance test
time podman run --rm alpine sh -c "for i in \$(seq 1000); do touch /tmp/f\$i; done"
# Native kernel overlay: < 1s
# fuse-overlayfs: 3-5s
```

OverlayFS with user namespaces represents the secure, efficient foundation for rootless containers. The combination of kernel overlay (5.11+), idmap mounts (5.12+), and metacopy eliminates the historic performance and security compromises of rootless container storage. On modern kernels, rootless container I/O performance is within 5-10% of root container performance, making it suitable for production workloads where privileged containers are prohibited by policy.
