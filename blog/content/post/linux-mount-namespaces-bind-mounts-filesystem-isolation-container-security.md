---
title: "Linux Mount Namespaces and Bind Mounts: Filesystem Isolation for Container Security"
date: 2030-11-09T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Mount Namespaces", "Containers", "Security", "overlayfs", "bind mounts"]
categories:
- Linux
- Containers
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Mount namespace deep dive: bind mount use cases, pivot_root vs chroot, overlay filesystem for container layers, shared subtree propagation modes, and using mount namespaces for secure application sandboxing."
more_link: "yes"
url: "/linux-mount-namespaces-bind-mounts-filesystem-isolation-container-security/"
---

Mount namespaces are the Linux kernel mechanism underlying container filesystem isolation. Every container runtime — containerd, Docker, Podman — relies on mount namespaces, bind mounts, and overlay filesystems to present each container with its own isolated filesystem view. Understanding these primitives at the kernel level is essential for debugging container storage issues, implementing secure sandboxing, and designing custom container runtimes. This guide covers mount namespace internals, bind mount semantics, overlay filesystem layer management, and shared subtree propagation — the full stack that makes container filesystem isolation work.

<!--more-->

## Mount Namespace Fundamentals

A mount namespace is a per-process (or per-process-group) instance of the filesystem mount table. When a new mount namespace is created, it receives a copy of the parent namespace's mount table. Subsequently, mount and unmount operations in the child namespace do not affect the parent, and vice versa.

```bash
# List mount namespaces visible to the current process
ls -la /proc/self/ns/mnt
# lrwxrwxrwx 1 root root 0 Nov  9 00:00 /proc/self/ns/mnt -> 'mnt:[4026531840]'

# The inode number (4026531840) identifies the namespace

# List all mount namespaces on the system
lsns -t mnt

# Expected output:
#         NS TYPE NPROCS   PID USER COMMAND
# 4026531840 mnt     142     1 root /sbin/init
# 4026532234 mnt       1  1234 root containerd-shim
# 4026532315 mnt       2  5678 root containerd-shim
# 4026532401 mnt       1  9012 1000 conmon

# Inspect a specific process's mount namespace
cat /proc/1234/mountinfo
# Each line: mountid parentid major:minor root mountpoint mountoptions optional-fields - fstype source superoptions
```

## Creating Mount Namespaces

### Using unshare

```bash
# Create a new mount namespace for the current shell
# --mount: create new mount namespace
# --propagation private: prevent mount events propagating to parent
unshare --mount --propagation private bash

# Verify we have a new namespace
cat /proc/self/ns/mnt
# Should show a different inode than the original

# Within the new namespace: mounts are invisible to the host
mount -t tmpfs tmpfs /mnt/test
ls /mnt/test  # Visible here

# From another terminal on the host:
ls /mnt/test  # Empty — mount not visible in host namespace
```

### Using clone() with CLONE_NEWNS

```c
// minimal_namespace.c — demonstrate mount namespace creation via syscall
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/mount.h>

static int child_func(void *arg) {
    // This function runs in the new mount namespace

    // Mount a tmpfs in the child namespace — invisible to parent
    if (mount("tmpfs", "/tmp/child-ns-test", "tmpfs", 0, NULL) != 0) {
        perror("mount");
        return 1;
    }

    printf("Child namespace mount successful\n");
    printf("Child mnt ns: ");
    fflush(stdout);
    system("readlink /proc/self/ns/mnt");

    pause(); // Keep the namespace alive for inspection
    return 0;
}

int main() {
    // Allocate stack for child process
    char *child_stack = malloc(1024 * 1024);
    char *stack_top = child_stack + 1024 * 1024;

    printf("Parent mnt ns: ");
    fflush(stdout);
    system("readlink /proc/self/ns/mnt");

    // CLONE_NEWNS: create new mount namespace
    // CLONE_NEWPID: create new PID namespace (common pairing)
    pid_t child_pid = clone(child_func, stack_top,
        CLONE_NEWNS | CLONE_NEWPID | SIGCHLD,
        NULL);

    if (child_pid < 0) {
        perror("clone");
        return 1;
    }

    printf("Child PID: %d\n", child_pid);
    waitpid(child_pid, NULL, 0);
    free(child_stack);
    return 0;
}
```

```bash
# Compile and run
gcc -o minimal_namespace minimal_namespace.c
sudo ./minimal_namespace
```

## Bind Mounts

Bind mounts make a file or directory accessible at a different path. The source and destination share the same inode; writes through either path affect the same data.

```bash
# Basic bind mount
mount --bind /var/lib/app-data /data

# Bind mount a single file
mount --bind /etc/app/config.conf /app/config.conf

# Read-only bind mount
mount --bind /sensitive-data /sandboxed-app/data
mount -o remount,ro,bind /sandboxed-app/data

# Bind mount with recursive flag (includes submounts)
mount --rbind /source/with/submounts /destination/

# Persistent bind mount in /etc/fstab
echo "/var/lib/app-data /data none bind 0 0" >> /etc/fstab
echo "/var/lib/app-data /data none bind,ro 0 0" >> /etc/fstab

# Verify bind mount
findmnt /data
# TARGET SOURCE            FSTYPE OPTIONS
# /data  /dev/nvme0n1p2[/var/lib/app-data] ext4 rw,relatime

# List all bind mounts on the system
findmnt --output TARGET,SOURCE,FSTYPE,OPTIONS | grep '\[/'
```

### Bind Mount Use Cases

```bash
# Use case 1: Share host credentials into a container without image modification
# The container reads /run/secrets/db-password; the actual file is elsewhere on host
mount --bind /secure/secrets/production/db-password \
  /var/lib/containerd/state/container-abc123/rootfs/run/secrets/db-password

# Use case 2: Development overlay — override specific files in an immutable image
# Mount source code over the installed application directory
mount --bind /home/dev/project/src /var/app/src

# Use case 3: Log collection — bind mount a host log directory into a container
mount --bind /var/log/app-container /host-log-dir
# Container writes to /host-log-dir; logs appear in /var/log/app-container on host

# Use case 4: Shared storage between containers
# Both containers bind-mount the same host path
mount --bind /shared/data /container-a/mnt/shared
mount --bind /shared/data /container-b/mnt/shared
```

## Overlay Filesystem

The overlay filesystem (overlayfs) is the mechanism behind container image layers. It combines a read-only lower layer (the container image) with a read-write upper layer (the container-writable layer), presenting a unified view.

```
Unified view (overlay mount)
  │
  ├── /etc/hosts  ← From upper layer (modified in container)
  ├── /bin/ls     ← From lower layer (unchanged image file)
  ├── /app/       ← From lower layer
  └── /tmp/       ← From upper layer (container created)

Upper layer (container-specific):
  ├── /etc/hosts  (modified copy)
  └── /tmp/       (new directory)

Lower layer (container image — read only):
  ├── /bin/ls
  ├── /app/
  └── /etc/hosts  (original — unchanged)
```

### Creating an Overlay Mount

```bash
# Set up overlay filesystem structure
mkdir -p /overlay/{lower,upper,work,merged}

# Create some files in the lower layer (simulates container image)
echo "original content" > /overlay/lower/file.txt
mkdir /overlay/lower/bin
echo "#!/bin/sh" > /overlay/lower/bin/myapp
chmod +x /overlay/lower/bin/myapp

# Mount the overlay
mount -t overlay overlay \
  -o lowerdir=/overlay/lower,upperdir=/overlay/upper,workdir=/overlay/work \
  /overlay/merged

# Inspect the unified view
ls /overlay/merged
# file.txt  bin/

cat /overlay/merged/file.txt
# original content

# Modify a file — writes go to upper layer
echo "modified content" > /overlay/merged/file.txt

# The original in lower layer is unchanged
cat /overlay/lower/file.txt
# original content

# The upper layer now has the modified copy
cat /overlay/upper/file.txt
# modified content

# The overlay view shows the modified version
cat /overlay/merged/file.txt
# modified content

# Create a new file — appears only in upper layer
echo "new file" > /overlay/merged/newfile.txt
ls /overlay/upper/
# file.txt  newfile.txt

ls /overlay/lower/
# file.txt  bin/  (newfile.txt NOT here)
```

### Whiteout Files and Directory Deletion

When a file from the lower layer is deleted in the overlay, a "whiteout" entry is created in the upper layer:

```bash
# Delete a file from the lower layer
rm /overlay/merged/file.txt

# The lower layer still has the file
ls /overlay/lower/file.txt
# /overlay/lower/file.txt

# The upper layer has a whiteout entry (character device 0,0)
ls -la /overlay/upper/
# c---------. 1 root root 0, 0 Nov  9 file.txt  ← whiteout device

# The merged view shows the file as deleted
ls /overlay/merged/file.txt
# ls: cannot access '/overlay/merged/file.txt': No such file or directory
```

### Multi-Layer Overlays (Container Image Stacking)

Container images consist of multiple read-only layers. overlayfs supports multiple lower layers:

```bash
# Create a 3-layer image simulation
mkdir -p /layers/{layer1,layer2,layer3,upper,work,merged}

# layer1: base OS
echo "os-file" > /layers/layer1/os-file.txt

# layer2: runtime libraries (built on top of layer1)
echo "runtime-lib" > /layers/layer2/runtime-lib.so

# layer3: application (built on top of layer2)
echo "app-binary" > /layers/layer3/app

# Mount with multiple lower layers (colon-separated, highest to lowest)
mount -t overlay overlay \
  -o lowerdir=/layers/layer3:/layers/layer2:/layers/layer1,\
     upperdir=/layers/upper,\
     workdir=/layers/work \
  /layers/merged

# The merged view shows all layers
ls /layers/merged/
# os-file.txt  runtime-lib.so  app

# File resolution order: upper → layer3 → layer2 → layer1
# A file in layer3 shadows the same file in layer2 or layer1
```

### containerd Layer Management

```bash
# Inspect how containerd stores overlayfs layers
# (on systems using containerd with overlayfs snapshotter)

# List all snapshots
ctr -n k8s.io snapshots ls | head -20

# Show snapshotter info for a specific container
CONTAINER_ID="abc123def456"
SNAPSHOT_KEY=$(ctr -n k8s.io containers info "${CONTAINER_ID}" | \
  jq -r '.SnapshotKey')

# Get overlayfs mount options for the snapshot
ctr -n k8s.io snapshots mounts "/tmp/inspect-${CONTAINER_ID}" \
  "${SNAPSHOT_KEY}" 2>/dev/null | head -5

# Manually inspect a container's filesystem layers
# containerd stores layer data in:
# /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/

# Each snapshot has a 'fs' directory (lower layer) and 'work' directory
ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/ | head -10

# Inspect a specific snapshot
SNAP_ID=12345
ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/${SNAP_ID}/
# fs/  work/
```

## chroot vs pivot_root

Both `chroot` and `pivot_root` change the root directory of a process, but they operate differently and have different security implications.

### chroot Limitations

```bash
# chroot changes the root filesystem view but has critical security limitations
# A privileged process inside a chroot can escape by:
# 1. Creating a new root directory and chrooting again
# 2. Using certain syscalls to reference the real filesystem via /proc

# Basic chroot demonstration
mkdir -p /tmp/chroot-test/{bin,lib,lib64,proc}
cp /bin/bash /tmp/chroot-test/bin/
cp /bin/ls /tmp/chroot-test/bin/

# Copy required libraries (use ldd to find them)
ldd /bin/bash | awk '/=>/ {print $3}' | xargs -I{} cp {} /tmp/chroot-test/lib/
cp /lib64/ld-linux-x86-64.so.2 /tmp/chroot-test/lib64/

chroot /tmp/chroot-test /bin/bash

# Inside the chroot — appears to be root of filesystem
# BUT: root-capable processes can escape using directory traversal + chroot()
```

### pivot_root: The Secure Alternative

`pivot_root` moves the entire filesystem hierarchy, making escape via directory traversal impossible:

```bash
# pivot_root moves the current root to put_old and makes new_root the new root
# Requires:
# 1. The process must be in a private mount namespace
# 2. new_root must be a mount point
# 3. new_root cannot be on the same filesystem as the current root

# Demonstration using a shell script (normally done in container runtime)
#!/bin/bash
# create_container_root.sh

set -euo pipefail

NEW_ROOT="$1"
OLD_ROOT="${NEW_ROOT}/.old-root"

# Step 1: New root must be a mount point
# Bind mount new_root onto itself to make it a mount point
mount --bind "${NEW_ROOT}" "${NEW_ROOT}"

# Step 2: Create the directory for the old root
mkdir -p "${OLD_ROOT}"

# Step 3: Switch root directories
# pivot_root <new_root> <put_old>
pivot_root "${NEW_ROOT}" "${OLD_ROOT}"

# Step 4: Change working directory to the new root
cd /

# Step 5: Unmount and remove the old root
# The old root is now at /.old-root
# Use --lazy (-l) to avoid "busy" errors
umount -l /.old-root
rm -rf /.old-root

echo "pivot_root complete — old root is gone"
```

```c
// pivot_root_example.c — pivot_root in a containerized process
#define _GNU_SOURCE
#include <sys/syscall.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

static int pivot_root(const char *new_root, const char *put_old) {
    return syscall(SYS_pivot_root, new_root, put_old);
}

int setup_container_root(const char *new_root) {
    char old_root[1024];
    snprintf(old_root, sizeof(old_root), "%s/.pivot_old", new_root);

    // Make new_root a bind mount (required by pivot_root)
    if (mount(new_root, new_root, NULL, MS_BIND | MS_REC, NULL) < 0) {
        perror("bind mount new_root");
        return -1;
    }

    // Create put_old directory
    if (mkdir(old_root, 0700) < 0 && errno != EEXIST) {
        perror("mkdir put_old");
        return -1;
    }

    // Perform pivot_root
    if (pivot_root(new_root, old_root) < 0) {
        perror("pivot_root");
        return -1;
    }

    // Change directory to new root
    if (chdir("/") < 0) {
        perror("chdir /");
        return -1;
    }

    // Unmount old root (lazy unmount allows it to complete when not busy)
    if (umount2("/.pivot_old", MNT_DETACH) < 0) {
        perror("umount2 old root");
        // Non-fatal: old root may be cleaned up by the parent
    }

    if (rmdir("/.pivot_old") < 0) {
        // Non-fatal
    }

    return 0;
}
```

## Shared Subtree Propagation Modes

Mount propagation controls whether mount events in one namespace or mount point are visible in other namespaces or bind-mount copies. This is one of the most nuanced aspects of Linux namespaces.

```bash
# The four propagation modes:
# private:    No mount propagation in either direction
# shared:     Mount events propagate bidirectionally (default for root namespace)
# slave:      Mount events propagate from master to slave, not vice versa
# unbindable: Like private, but cannot be bind-mounted

# Check current propagation of mount points
cat /proc/self/mountinfo | awk '{print $5, $7}' | head -20
# Fields: mountpoint, optional-fields (includes "shared:N", "master:N", "slave", etc.)

# View with findmnt
findmnt -o TARGET,PROPAGATION | head -20

# Set propagation modes
mount --make-private /mnt/data       # private
mount --make-shared /mnt/shared      # shared
mount --make-slave /mnt/external     # slave
mount --make-unbindable /mnt/secret  # unbindable

# Recursive propagation change
mount --make-rprivate /  # Make entire filesystem tree private
```

### Practical Propagation Example

```bash
# Example: Container host setup
# The host mounts a network filesystem and wants containers to see it
# WITHOUT containers being able to propagate mounts back to the host

# Step 1: On the host, create a shared mount point
mkdir /shared-nfs
mount --make-shared /shared-nfs
mount -t nfs nfs-server.internal:/exports /shared-nfs

# Step 2: In each container (new mount namespace):
# Bind mount the shared directory as SLAVE
# Containers see mounts made on the host (from master)
# But container mounts don't propagate back to host

unshare --mount bash << 'EOF'
  # Make root private first (don't propagate anything by default)
  mount --make-rprivate /

  # Bind mount the shared directory as slave
  mount --bind /shared-nfs /container-data
  mount --make-slave /container-data

  # Now if the host mounts something new under /shared-nfs,
  # it will be visible in /container-data here.
  # But if we mount something under /container-data here,
  # it will NOT be visible in /shared-nfs on the host.
EOF

# Verify propagation behavior
# Host-side:
mount -t tmpfs tmpfs /shared-nfs/new-dir
ls /shared-nfs/new-dir  # visible on host
# In container: ls /container-data/new-dir  # ALSO visible (slave propagation)
# In container: mount tmpfs /container-data/another-dir  # visible only in container
```

### Container Runtime Propagation Configuration

```yaml
# Kubernetes Pod volume with specific mount propagation
apiVersion: v1
kind: Pod
metadata:
  name: shared-volume-demo
spec:
  containers:
  - name: app
    image: app:v1.0
    volumeMounts:
    - name: shared-data
      mountPath: /data
      # mountPropagation options:
      # None (default): equivalent to private mount
      # HostToContainer: slave propagation — host mounts visible in container
      # Bidirectional: shared propagation — mounts propagate both ways
      #   REQUIRES privileged: true (security risk)
      mountPropagation: HostToContainer

  - name: log-forwarder
    image: fluentd:v1.16
    volumeMounts:
    - name: shared-data
      mountPath: /input
      mountPropagation: None

  volumes:
  - name: shared-data
    hostPath:
      path: /data/shared
      type: DirectoryOrCreate
```

## Secure Application Sandboxing with Mount Namespaces

Combining all these primitives enables robust application sandboxing:

```bash
#!/bin/bash
# /usr/local/sbin/sandbox.sh
# Launch an application in a restricted filesystem environment

set -euo pipefail

APP_IMAGE_DIR="$1"  # Read-only application files
APP_DATA_DIR="$2"   # Read-write data directory
APP_CMD="${@:3}"     # Command to run

# Create a temporary directory for the overlay
WORK_DIR=$(mktemp -d /tmp/sandbox.XXXXXXXXXX)
UPPER_DIR="${WORK_DIR}/upper"
WORK_OVL="${WORK_DIR}/work"
MERGED_DIR="${WORK_DIR}/merged"
OLD_ROOT="${MERGED_DIR}/.old-root"

mkdir -p "${UPPER_DIR}" "${WORK_OVL}" "${MERGED_DIR}"

cleanup() {
    # Cleanup on exit
    umount -l "${MERGED_DIR}" 2>/dev/null || true
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

# Step 1: Create overlay filesystem with image as lower, temp dir as upper
mount -t overlay overlay \
  -o lowerdir="${APP_IMAGE_DIR}",upperdir="${UPPER_DIR}",workdir="${WORK_OVL}" \
  "${MERGED_DIR}"

# Step 2: Set up essential directories in merged view
mkdir -p "${MERGED_DIR}"/{proc,sys,dev,tmp,data}
mount -t proc proc "${MERGED_DIR}/proc"
mount -t sysfs sysfs "${MERGED_DIR}/sys" -o ro
mount -t devtmpfs devtmpfs "${MERGED_DIR}/dev"
mount -t tmpfs tmpfs "${MERGED_DIR}/tmp"

# Step 3: Bind mount application data (read-write)
mount --bind "${APP_DATA_DIR}" "${MERGED_DIR}/data"

# Step 4: Create required /etc files
echo "127.0.0.1 localhost" > "${MERGED_DIR}/etc/hosts"
echo "nameserver 8.8.8.8" > "${MERGED_DIR}/etc/resolv.conf"

# Step 5: Launch in new namespace with pivot_root
exec unshare \
  --mount \
  --pid --fork \
  --user --map-root-user \
  --net \
  --uts \
  -- \
  /bin/sh -c "
    mount --make-rprivate /
    mount --bind ${MERGED_DIR} ${MERGED_DIR}
    mkdir -p ${OLD_ROOT}
    pivot_root ${MERGED_DIR} ${OLD_ROOT}
    cd /
    umount -l /.old-root
    rmdir /.old-root
    exec ${APP_CMD}
  "
```

## Debugging Mount Namespace Issues

```bash
# Find what process holds a mount namespace
# (useful when debugging why a namespace won't be cleaned up)
ls -la /proc/*/ns/mnt | sort -t'[' -k2 -n | uniq -f6 | head -20

# Compare mount tables across two namespaces
nsenter --mount=/proc/${PID1}/ns/mnt -- cat /proc/self/mounts > /tmp/ns1-mounts
nsenter --mount=/proc/${PID2}/ns/mnt -- cat /proc/self/mounts > /tmp/ns2-mounts
diff /tmp/ns1-mounts /tmp/ns2-mounts

# Enter a container's mount namespace for debugging
CONTAINER_PID=$(crictl inspect <container-id> | jq -r '.info.pid')
nsenter --mount=/proc/${CONTAINER_PID}/ns/mnt bash

# From inside: inspect the container's mount table
cat /proc/mounts
findmnt

# Check overlay mount details for a specific container
nsenter --mount=/proc/${CONTAINER_PID}/ns/mnt -- \
  findmnt -t overlay -o TARGET,SOURCE,OPTIONS

# Debug "device or resource busy" umount failures
fuser -mv /mnt/stuck-mount  # Shows processes using the mount
lsof +D /mnt/stuck-mount    # Detailed open files

# Force umount of stuck overlay (last resort)
umount -l /overlay/merged   # Lazy unmount — detaches when no longer busy
```

### Common overlayfs Issues

```bash
# Issue: "cannot create directory: read-only filesystem"
# Cause: The upper directory is on a read-only filesystem
# Fix: Ensure upper and work dirs are on a writable filesystem

# Issue: "overlayfs: workdir and upperdir must reside under the same mount"
# Cause: upper and work are on different filesystems
# Fix: Both must be on the same filesystem

# Issue: Container failing with ENOSPC despite available disk space
# Cause: overlayfs inode exhaustion on the upper layer filesystem
df -i /var/lib/containerd/  # Check inode usage
# Fix: Use XFS (no fixed inode limit) or increase ext4 inode density

# Issue: "too many levels of symbolic links" in container
# Cause: Overlay mount depth limit (max 500 lower layers in kernel 6.x)
# Fix: Merge container image layers before mounting

# Check overlay mount depth
cat /proc/mounts | grep overlay | awk -F'lowerdir=' '{print $2}' | tr ':' '\n' | wc -l
```

## Summary

Mount namespaces and their related primitives form the complete filesystem isolation stack for Linux containers:

- **Mount namespaces**: Per-process filesystem mount tables that isolate mount/unmount operations between processes
- **Bind mounts**: O(1) filesystem view aliasing — the mechanism for injecting host files into containers and sharing data between containers
- **pivot_root vs chroot**: `pivot_root` provides secure root filesystem switching with no escape path; `chroot` is insufficient for security isolation and should not be used in container runtimes
- **overlayfs**: Copy-on-write layer stacking that enables container image sharing with container-specific write layers; whiteout files implement deletion across layers
- **Multi-layer overlays**: Container image layers stacked via colon-separated `lowerdir` enabling efficient image sharing across many containers
- **Propagation modes**: `private`, `shared`, `slave`, and `unbindable` control mount event visibility across namespaces; `slave` is the correct mode for injecting host mounts into containers without reverse propagation
- **Sandboxing**: Combining `unshare`, `pivot_root`, overlayfs, and selective bind mounts creates a complete application sandbox without requiring a full container runtime
