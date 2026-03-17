---
title: "Linux Overlay Filesystem: Container Layer Architecture and Union Mount Internals"
date: 2031-03-13T00:00:00-05:00
draft: false
tags: ["Linux", "Containers", "Filesystem", "Docker", "Performance", "Storage"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux overlayfs: layer structure internals, copy-on-write mechanics, hard link handling, tmpfs vs ext4 performance, container image layer caching, and debugging overlay mount issues in production."
more_link: "yes"
url: "/linux-overlay-filesystem-container-layer-architecture/"
---

Every time you run a container, the Linux kernel assembles a virtual filesystem by stacking multiple layers together using overlayfs. This union mount mechanism is what makes container image sharing and copy-on-write semantics possible without the overhead of full disk copies. Understanding overlayfs at the kernel level is essential for diagnosing container storage performance issues, debugging mysterious filesystem behavior, and making informed decisions about storage driver configuration. This guide covers overlayfs architecture from first principles through production debugging techniques.

<!--more-->

# Linux Overlay Filesystem: Container Layer Architecture and Union Mount Internals

## Section 1: Union Mounts and Why Containers Need Them

Before overlayfs, the primary approach to union mounts in Linux was AUFS (Another Union File System). AUFS was never merged into the mainline kernel due to code quality concerns, forcing distributions to carry it as an out-of-tree patch. overlayfs was designed as a simpler, more maintainable replacement and was merged into Linux 3.18 in 2014. Docker switched from AUFS to overlay2 as the default storage driver for most distributions starting with Docker 1.12.

The fundamental problem overlayfs solves: container images are built in layers (each Dockerfile instruction is a layer), and many containers may share base layers. Without union mounts, each container would require a full copy of all its filesystem layers, consuming disk space proportional to (number of containers × image size). With overlayfs, a thousand containers sharing the same Ubuntu base image all read from the same underlying layer files.

### The Container Layer Model

```
Container runtime perspective:
┌─────────────────────────────────────┐
│  Container writeable layer          │  ← upperdir (container-specific)
├─────────────────────────────────────┤
│  Image layer N (top)                │  ← lowerdir[0] (read-only)
├─────────────────────────────────────┤
│  Image layer N-1                    │  ← lowerdir[1] (read-only)
├─────────────────────────────────────┤
│  ...                                │
├─────────────────────────────────────┤
│  Image layer 1 (base)               │  ← lowerdir[N-1] (read-only)
└─────────────────────────────────────┘
                    ↓ merged view
┌─────────────────────────────────────┐
│  Unified filesystem (mergeddir)     │  ← what the container sees
└─────────────────────────────────────┘
```

## Section 2: overlayfs Layer Structure

### The Four Directory Roles

Every overlayfs mount involves four directories:

**lowerdir**: One or more read-only base layers. In a union mount, multiple lowerdirs can be specified using `:` as a separator. The leftmost lowerdir has highest precedence in case of filename conflicts.

**upperdir**: A read-write directory where all modifications go. Files created or modified in the merged view are written here. Only one upperdir is allowed.

**workdir**: A working directory used internally by overlayfs for atomic operations. Must be on the same filesystem as upperdir. Not directly visible to users.

**merged**: The unified view that combines all lower layers with the upper layer. This is the directory you mount inside a container.

### Creating an Overlay Mount Manually

```bash
# Create the directory structure
mkdir -p /tmp/overlay-demo/{lower1,lower2,upper,work,merged}

# Populate lower layers
echo "from lower1" > /tmp/overlay-demo/lower1/file1.txt
echo "shared content" > /tmp/overlay-demo/lower1/shared.txt
echo "from lower2" > /tmp/overlay-demo/lower2/file2.txt
echo "lower2 version" > /tmp/overlay-demo/lower2/shared.txt

# Mount with multiple lower dirs (lower2 has higher precedence here)
sudo mount -t overlay overlay \
  -o lowerdir=/tmp/overlay-demo/lower2:/tmp/overlay-demo/lower1,\
upperdir=/tmp/overlay-demo/upper,\
workdir=/tmp/overlay-demo/work \
  /tmp/overlay-demo/merged

# Inspect the merged view
ls /tmp/overlay-demo/merged/
# file1.txt  file2.txt  shared.txt

cat /tmp/overlay-demo/merged/shared.txt
# lower2 version  <- lower2 wins because it appears first in lowerdir=

# Check what's in upper (nothing yet - no writes)
ls /tmp/overlay-demo/upper/
# (empty)
```

### Understanding File Lookup

When the kernel looks up a filename in the merged directory, it searches in order:

1. upperdir
2. lowerdir[0] (leftmost = highest priority)
3. lowerdir[1]
4. ... continuing to the rightmost lowerdir

The first hit wins. This is how layer precedence works in container images: a later image layer (closer to lowerdir[0]) can override files from earlier layers.

```bash
# Demonstrate lookup order
echo "upper version" > /tmp/overlay-demo/upper/shared.txt

cat /tmp/overlay-demo/merged/shared.txt
# upper version  <- upper always wins

# The lower layers are unchanged
cat /tmp/overlay-demo/lower2/shared.txt
# lower2 version  <- untouched
```

## Section 3: Copy-on-Write Mechanics

overlayfs implements copy-on-write (CoW): when a process writes to a file that exists only in the lower layers, the kernel copies the entire file to the upper layer before applying the modification.

### File Modification CoW

```bash
# Verify file is only in lower
ls /tmp/overlay-demo/upper/
# (empty)

# Modify the file through merged view
echo "modified" >> /tmp/overlay-demo/merged/file1.txt

# Now check upper
ls -la /tmp/overlay-demo/upper/
# -rw-r--r-- 1 root root 22 ... file1.txt

# The complete file was copied to upper before modification
cat /tmp/overlay-demo/upper/file1.txt
# from lower1
# modified

# The original lower layer is unchanged
cat /tmp/overlay-demo/lower1/file1.txt
# from lower1
```

### The CoW Overhead

The first write to a file triggers a full file copy from lower to upper. For large files, this can be expensive. For a 100MB file, the first write copies 100MB to upperdir before the write is applied. Subsequent writes to the same file are in-place (the file is already in upper).

This is why container workloads that frequently modify large files (log rotation, database files) should use volume mounts rather than container layers.

```bash
# Measure CoW overhead for different file sizes
time dd if=/dev/zero of=/tmp/overlay-demo/merged/small.dat bs=1M count=1
# Creates 1MB file in upper: ~0.001s

time dd if=/dev/zero of=/tmp/overlay-demo/merged/large.dat bs=1M count=100
# Creates 100MB file in upper: ~0.5s (fast, file doesn't exist in lower yet)

# Now try writing to a file that exists in lower
cp /tmp/overlay-demo/merged/large.dat /tmp/overlay-demo/lower1/existing.dat
# After remounting to pick up the change:

time echo "x" >> /tmp/overlay-demo/merged/existing.dat
# Must copy 100MB from lower to upper first: ~0.5-2s depending on disk speed
```

### Directory Operations and CoW

Directory creation and modification use a different mechanism:

```bash
# Create a directory in merged
mkdir /tmp/overlay-demo/merged/newdir

# The directory appears in upper
ls /tmp/overlay-demo/upper/
# file1.txt  newdir/

# Creating a file inside a directory that exists only in lower
mkdir /tmp/overlay-demo/lower1/existingdir
# (remount needed for lower changes)

# After remount: create file in existing directory
echo "new" > /tmp/overlay-demo/merged/existingdir/newfile.txt

# Upper gets a copy of the directory AND the new file
ls /tmp/overlay-demo/upper/existingdir/
# newfile.txt
# (The directory itself in upper is a copy, needed to hold the new file)
```

## Section 4: Whiteout Files and Deletion

Deletion in overlayfs requires special handling because the lower layers are read-only. You cannot delete a file from a read-only layer. Instead, overlayfs uses whiteout files to mask lower-layer entries.

### Character Device Whiteouts

```bash
# Delete a file that exists in lower
rm /tmp/overlay-demo/merged/file2.txt

# Check upper - overlayfs created a whiteout
ls -la /tmp/overlay-demo/upper/
# c---------  1 root root   0, 0 ... file2.txt  <- character device, major:minor = 0,0

# This is a whiteout file - it signals "this name is deleted"
stat /tmp/overlay-demo/upper/file2.txt
# File type: character special file
# Device type: 0, 0  <- always 0,0 for whiteouts

# In the merged view, the file is gone
ls /tmp/overlay-demo/merged/file2.txt
# ls: cannot access '/tmp/overlay-demo/merged/file2.txt': No such file or directory
```

### Directory Whiteouts (Opaque Directories)

When you delete an entire directory and recreate it:

```bash
# Delete a directory that exists in lower
rm -rf /tmp/overlay-demo/merged/existingdir

# Recreate it
mkdir /tmp/overlay-demo/merged/existingdir
echo "fresh" > /tmp/overlay-demo/merged/existingdir/fresh.txt

# The new directory in upper has an opaque xattr
getfattr -n trusted.overlay.opaque /tmp/overlay-demo/upper/existingdir
# trusted.overlay.opaque="y"

# The 'y' value tells overlayfs to NOT look through to lower layers
# This means the old content from lower is effectively hidden
ls /tmp/overlay-demo/merged/existingdir/
# fresh.txt  <- only the new file, old lower content is hidden
```

### Viewing All Whiteouts

```bash
# Find all whiteouts in an upper directory (useful for debugging)
find /tmp/overlay-demo/upper -type c 2>/dev/null | while read f; do
    stat -c "%n: whiteout" "$f"
done

# Find opaque directories
find /tmp/overlay-demo/upper -type d | while read d; do
    if getfattr -n trusted.overlay.opaque "$d" 2>/dev/null | grep -q '"y"'; then
        echo "$d: opaque directory"
    fi
done
```

## Section 5: Hard Links Across Layers

Hard link handling is one of overlayfs's more subtle behaviors and has been the source of several container storage bugs.

### The Hard Link Problem

In a normal filesystem, a hard link is just a directory entry pointing to an inode. Multiple directory entries can point to the same inode. overlayfs uses inodes from different filesystems (the lower and upper layers are separate filesystem trees), which complicates hard link semantics.

```bash
# Create hard links in lower layer
echo "shared data" > /tmp/overlay-demo/lower1/original.txt
ln /tmp/overlay-demo/lower1/original.txt /tmp/overlay-demo/lower1/link.txt

# Verify they're hard linked
stat /tmp/overlay-demo/lower1/original.txt | grep Inode
# Inode: 12345  Links: 2

stat /tmp/overlay-demo/lower1/link.txt | grep Inode
# Inode: 12345  Links: 2  <- same inode

# Through the overlay, they appear as separate inodes
stat /tmp/overlay-demo/merged/original.txt | grep Inode
# Inode: 99999  <- overlay assigns different inode numbers

stat /tmp/overlay-demo/merged/link.txt | grep Inode
# Inode: 99998  <- different from original.txt!
```

### CoW Breaks Hard Links

When you write to one file of a hard-linked pair, overlayfs copies that specific file to upper, breaking the hard link relationship:

```bash
echo "modified" >> /tmp/overlay-demo/merged/original.txt

# original.txt is now in upper
ls /tmp/overlay-demo/upper/
# original.txt  <- copied to upper, hard link broken

# link.txt still refers to the lower layer version
cat /tmp/overlay-demo/merged/link.txt
# shared data  <- unchanged, still from lower

cat /tmp/overlay-demo/merged/original.txt
# shared data
# modified  <- new content only in upper
```

This hard link breaking is expected behavior but can surprise applications that rely on hard-link semantics (like rsync with `--hard-links`, or container image tools that use hard links for layer deduplication).

### Hard Link Counting in overlay

```bash
# Check nlink count through overlay
stat /tmp/overlay-demo/merged/original.txt
# Links: 1  <- shows 1 even though lower has 2 (hard link is hidden)

# This affects applications that check nlink for optimization
# For example, rsync uses nlink > 1 to identify hard-linked files
# Through overlay, these optimizations don't work
```

## Section 6: overlayfs on tmpfs vs ext4

Storage backend choice significantly affects overlayfs performance. The upperdir and workdir must share a filesystem, but the lowerdirs can be on different filesystems.

### tmpfs Upper Layer (Container Ephemeral Storage)

tmpfs is ideal for container ephemeral storage where data loss on container stop is acceptable:

```bash
# Mount tmpfs for upper layer
sudo mount -t tmpfs tmpfs /tmp/overlay-upper -o size=1G,mode=1777

mkdir -p /tmp/overlay-upper/{upper,work}

# Create overlay with tmpfs upper
sudo mount -t overlay overlay \
  -o lowerdir=/tmp/overlay-lower,\
upperdir=/tmp/overlay-upper/upper,\
workdir=/tmp/overlay-upper/work \
  /tmp/overlay-merged
```

**tmpfs upper advantages:**
- Write operations bypass disk I/O completely
- No filesystem journal overhead
- Ideal for containers with heavy write patterns (compilation, temp files)
- Automatic cleanup on unmount

**tmpfs upper disadvantages:**
- Data lost when container stops or host reboots
- Consumes RAM
- Not suitable for persistent data

### Performance Comparison: tmpfs vs ext4 upper

```bash
# Test write throughput: tmpfs upper
time dd if=/dev/zero of=/tmp/overlay-merged/test.dat bs=1M count=1000
# 1073741824 bytes transferred in 1.2 secs (894 MB/s)

# Test write throughput: ext4 upper (SSD)
time dd if=/dev/zero of=/tmp/overlay-merged-ext4/test.dat bs=1M count=1000
# 1073741824 bytes transferred in 4.8 secs (223 MB/s)

# CoW test: first write to lower layer file (ext4 lower, tmpfs upper)
time echo "x" >> /tmp/overlay-merged/large-lower-file.dat
# real 0m0.412s  <- CoW copy from ext4 lower to tmpfs upper
```

### Recommended Configuration for Production Containers

```bash
# /etc/docker/daemon.json
{
  "storage-driver": "overlay2",
  "storage-opts": [
    "overlay2.override_kernel_check=true"
  ]
}
```

For deployments with NVMe SSDs, the default ext4-backed overlay2 is optimal. For deployment on HDDs or high-write workloads, consider:

```bash
# Use xfs with d_type support for overlay2
# Most distributions default to ext4 or xfs, both work well

# Verify d_type support (required for overlay2)
xfs_info /var/lib/docker | grep ftype
# ftype=1  <- required, 1 = enabled

# For ext4
tune2fs -l /dev/sda1 | grep "Filesystem features"
# Should include: dir_index
```

## Section 7: Container Image Layer Caching

Docker and containerd use overlayfs layer sharing to minimize disk usage. Understanding this mechanism helps with image optimization.

### Docker overlay2 Directory Structure

```bash
# Inspect the Docker overlay2 storage
ls /var/lib/docker/overlay2/
# Each directory is a layer identified by its content hash
# l/ directory contains short symlinks to each layer

# Inspect a specific layer
LAYER_ID=$(docker image inspect ubuntu:22.04 --format '{{(index .RootFS.Layers 0)}}' | sed 's/sha256://')
ls /var/lib/docker/overlay2/ | grep "${LAYER_ID:0:10}"

# Layer directory structure
ls /var/lib/docker/overlay2/<layer-id>/
# diff/    <- the actual filesystem content of this layer
# link     <- the short hash used in lowerdir= mounts
# lower    <- the parent layer's short hash (for non-base layers)
# work/    <- workdir for overlay mounts (only in container upper layers)
```

### Inspecting a Running Container's Overlay Mount

```bash
# Get container ID
CONTAINER_ID=$(docker run -d nginx:latest)

# Find the overlay mount for this container
docker inspect "$CONTAINER_ID" --format '{{.GraphDriver.Data}}'
# {
#   "LowerDir": "/var/lib/docker/overlay2/abc.../diff:/var/lib/docker/overlay2/def.../diff:...",
#   "MergedDir": "/var/lib/docker/overlay2/xyz.../merged",
#   "UpperDir": "/var/lib/docker/overlay2/xyz.../diff",
#   "WorkDir": "/var/lib/docker/overlay2/xyz.../work"
# }

# View the kernel's mount information
cat /proc/mounts | grep overlay
# overlay /var/lib/docker/overlay2/xyz.../merged overlay
#   rw,relatime,lowerdir=...,upperdir=...,workdir=... 0 0

# Count lower layers (= number of image layers)
docker inspect "$CONTAINER_ID" --format '{{.GraphDriver.Data.LowerDir}}' | tr ':' '\n' | wc -l
```

### Flattening Layers to Reduce CoW Overhead

Each layer boundary is a potential CoW trigger. A container image with 50 layers will experience CoW for any file modification touching files in lower layers. Squashing layers reduces this:

```dockerfile
# Instead of many layers:
FROM ubuntu:22.04
RUN apt-get update
RUN apt-get install -y python3
RUN apt-get install -y python3-pip
RUN pip install flask gunicorn
COPY app/ /app/

# Use fewer layers with multi-line RUN:
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
RUN pip install flask gunicorn
COPY app/ /app/
```

```bash
# Squash all layers on build (removes layer caching benefit)
docker build --squash -t myapp:squashed .

# Use BuildKit's merge layers feature
DOCKER_BUILDKIT=1 docker build --squash -t myapp:merged .
```

### Layer Cache Efficiency Analysis

```bash
# Check disk usage by layer sharing
docker system df -v

# Identify layers shared between images
docker image ls --format '{{.Repository}}:{{.Tag}}' | while read img; do
    docker image inspect "$img" --format "{{.RootFS.Layers}}" | tr ' ' '\n'
done | sort | uniq -c | sort -rn | head -20
# High counts indicate heavily shared layers

# Find the size contribution of each layer
docker history --no-trunc nginx:latest --format 'table {{.CreatedBy}}\t{{.Size}}'
```

## Section 8: Advanced overlayfs Features

### Index Mode (Hardlink Reconstruction)

Linux 4.13+ added overlay index mode, which stores metadata in the workdir's `index/` subdirectory to support proper hard link semantics across overlay layers:

```bash
# Enable index mode
sudo mount -t overlay overlay \
  -o lowerdir=/lower,upperdir=/upper,workdir=/work,index=on \
  /merged

# With index=on, hard links between layers are tracked in work/index/
ls /work/index/
# <inode-hash> -> ../upper/<file>
```

### Metacopy (Reduced CoW for Metadata Changes)

Linux 4.19+ added metacopy mode. Without it, any metadata change (chmod, chown, utimes) to a lower-layer file triggers a full file copy. With metacopy:

```bash
# Enable metacopy mode
sudo mount -t overlay overlay \
  -o lowerdir=/lower,upperdir=/upper,workdir=/work,metacopy=on \
  /merged

# Now chmod on a lower-layer file only copies metadata to upper
chmod 644 /merged/large-file.dat

# Check upper - only metadata was written, not the full file
ls -la /upper/large-file.dat
# -rw-r--r-- ... 0 bytes  <- tiny metadata-only copy with redirect xattr

getfattr -n trusted.overlay.redirect /upper/large-file.dat
# trusted.overlay.redirect="/absolute/path/to/lower/large-file.dat"
```

This dramatically reduces the cost of container startup operations that involve permission changes without data modification.

### Volatile Mount (Skip Sync on Umount)

For ephemeral container workloads, the kernel's sync-on-umount behavior is unnecessary overhead:

```bash
# Volatile mode skips journal commits and sync on unmount
sudo mount -t overlay overlay \
  -o lowerdir=/lower,upperdir=/upper,workdir=/work,volatile \
  /merged
```

Note: volatile mode data may be lost if the system crashes before unmount.

## Section 9: Debugging Overlay Mount Issues

### Common Issue: Too Many Layers

overlayfs has a default limit on the number of lower layers (128 on most kernels). Deep image hierarchies can hit this limit:

```bash
# Check current limit
cat /proc/sys/fs/overcommit_memory  # Unrelated, but shows sysctl pattern

# The overlay lower dir limit is compiled in, check your kernel
grep -r OVERLAY_MAX_STACK /usr/src/linux-headers-$(uname -r)/fs/overlayfs/ 2>/dev/null
# Typically defined as PAGE_SIZE/sizeof(char*)

# If you're hitting limits with Docker, squash layers
docker build --squash -t myimage .

# Or check how many layers your image has
docker history myimage | wc -l
```

### Diagnosing CoW Storms

A common performance issue is many containers simultaneously triggering CoW on the same large lower-layer file:

```bash
# Monitor overlayfs copy operations
# Enable overlayfs tracing
echo 1 > /sys/kernel/debug/tracing/events/overlay/enable 2>/dev/null || \
  mount -t debugfs debugfs /sys/kernel/debug

# Use inotifywait on the overlay upper directories
inotifywait -m -r /var/lib/docker/overlay2 -e create 2>/dev/null | \
  grep --line-buffered "ISDIR" | head -100

# Use perf to trace copy_up operations
perf probe -a 'ovl_copy_up_one' 2>/dev/null
perf record -e probe:ovl_copy_up_one -a sleep 10
perf script | head -50
```

### Checking Filesystem Compatibility

```bash
# overlay2 requires d_type support in the underlying filesystem
# Check ext4
dumpe2fs /dev/sda1 2>/dev/null | grep -i "dir_index"

# Check xfs
xfs_info /dev/sda1 | grep -i ftype

# Docker will warn if d_type is not available
dockerd --storage-driver=overlay2 2>&1 | grep -i "d_type\|ftype"

# For tmpfs (always supports d_type)
mount -t tmpfs tmpfs /mnt/test
stat -f /mnt/test | grep "Type"  # tmpfs
```

### Debugging a Mounted Overlay

```bash
# View all overlay mounts on the system
findmnt -t overlay

# Get details of a specific overlay mount
findmnt -t overlay -o TARGET,SOURCE,OPTIONS --noheadings | while read target source opts; do
    echo "=== Mount: $target ==="
    echo "Options: $opts"
    echo ""
done

# Check for upper layer file growth (signs of CoW activity)
du -sh /var/lib/docker/overlay2/*/diff | sort -h | tail -20

# Watch for upper layer growth in real time
watch -n 1 'du -sh /var/lib/docker/overlay2/*/diff | sort -h | tail -5'

# Find the container associated with an overlay upper dir
UPPER="/var/lib/docker/overlay2/abc123/diff"
docker ps -q | while read id; do
    upper=$(docker inspect "$id" --format '{{.GraphDriver.Data.UpperDir}}')
    if [ "$upper" = "$UPPER" ]; then
        echo "Container: $(docker inspect $id --format '{{.Name}}')"
    fi
done
```

### strace-Based Overlay Debugging

```bash
# Trace system calls related to overlay operations for a specific process
PID=$(pidof myapp)
strace -p "$PID" -e trace=open,openat,stat,fstat,read,write 2>&1 | \
  grep -v "resumed\|ENOENT" | head -100

# Look for excessive CoW patterns (many copy operations of the same file)
strace -p "$PID" -e trace=write -e 'signal=' 2>&1 | \
  awk '{print $NF}' | sort | uniq -c | sort -rn | head -10
```

## Section 10: Production Recommendations

### Storage Configuration for Container Hosts

```bash
# /etc/docker/daemon.json - production overlay2 configuration
{
  "storage-driver": "overlay2",
  "storage-opts": [
    "overlay2.override_kernel_check=false"
  ],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  },
  "data-root": "/var/lib/docker"
}
```

### Filesystem Recommendations by Use Case

| Workload | Upper Filesystem | Lower Filesystem | Overlay Options |
|---|---|---|---|
| General containers | ext4 or xfs | ext4 or xfs | Default |
| Build caches | SSD-backed xfs | SSD-backed xfs | Default |
| Ephemeral/CI | tmpfs | ext4 or xfs | volatile |
| High-write workloads | tmpfs | ext4 or xfs | metacopy=on |
| Many metadata ops | ext4 with journaling | ext4 | metacopy=on |

### Image Layer Optimization Guidelines

Minimize layer count for production images:

1. Combine related RUN instructions to reduce the number of overlay lower layers
2. Remove package caches and temp files in the same RUN instruction that created them
3. Use multi-stage builds to eliminate build-time layers from the final image
4. Consider squashed images for workloads with heavy file modification patterns
5. Use volume mounts for databases, log files, and other high-write data rather than container layers

```dockerfile
# Optimized multi-stage Dockerfile for minimal overlay layers
FROM golang:1.22 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/myapp ./cmd/myapp

FROM gcr.io/distroless/static-debian12
COPY --from=builder /bin/myapp /bin/myapp
ENTRYPOINT ["/bin/myapp"]
# Result: 2-3 layers total, minimal CoW surface
```

## Summary

overlayfs is a fundamental building block of the modern container ecosystem, and its behavior directly impacts container startup latency, disk usage, and I/O throughput. Key production takeaways:

- Copy-on-write is triggered per-file on first write; large files in lower layers incur significant CoW overhead on first modification
- Whiteout files and opaque directories are how deletion is implemented across read-only layers; understanding them is essential for debugging missing files in containers
- Hard link semantics are not preserved across overlay layers by default; use index mode if hard link counting matters
- tmpfs upper layers eliminate disk I/O for writes but consume RAM and lose data on container stop
- metacopy mode (kernel 4.19+) dramatically reduces CoW overhead for metadata-only changes
- Image layer count directly affects the depth of the lowerdir chain; squashing layers reduces CoW surface area but eliminates layer sharing between images
- The Docker overlay2 storage driver is well-tuned for typical workloads; always verify d_type support on the underlying filesystem before deployment
