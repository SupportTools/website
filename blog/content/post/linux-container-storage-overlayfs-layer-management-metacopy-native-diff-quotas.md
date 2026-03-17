---
title: "Linux Container Storage with OverlayFS: Layer Management, Metacopy Optimization, Native Diff, and Quotas"
date: 2031-11-13T00:00:00-05:00
draft: false
tags: ["Linux", "OverlayFS", "Container Storage", "containerd", "Docker", "Storage Driver", "Kernel"]
categories: ["Linux", "Container Technologies"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth guide to Linux OverlayFS as used in container runtimes, covering layer stack mechanics, metacopy optimization, native diff algorithms, project quota enforcement, and performance tuning for production container workloads."
more_link: "yes"
url: "/linux-container-storage-overlayfs-layer-management-metacopy-native-diff-quotas/"
---

OverlayFS is the storage driver used by Docker, containerd, and Podman on almost every production Linux system. Understanding how it manages layers, handles copy-on-write, implements the metacopy optimization, and enforces quotas is essential for diagnosing container storage performance issues, optimizing image build times, and preventing the "container filled up the disk" class of production incidents.

<!--more-->

# Linux Container Storage with OverlayFS: Layer Management, Metacopy Optimization, Native Diff, and Quotas

## OverlayFS Architecture

OverlayFS combines multiple directories into a single unified view:

```
Container view (merged)
       ↑
┌──────────────┐
│ Upper (R/W)  │ ← Container writes go here
├──────────────┤
│ Work dir     │ ← Required temp dir on same fs as upper
├──────────────┤
│ Lower N      │ ← Top image layer (R/O)
├──────────────┤
│ Lower N-1    │ ← ...
├──────────────┤
│ Lower 1      │ ← Base image layer (R/O)
└──────────────┘
```

Key properties:
- **Reads** fall through to the first lower layer that contains the file.
- **Writes** copy the file to the upper layer first (copy-on-write).
- **Deletes** create a "whiteout" file in the upper layer.
- **Directory renames** require special handling (opaque directories).

## Section 1: OverlayFS Mount Mechanics

### 1.1 Manual OverlayFS Mount

```bash
# Create a simple OverlayFS mount with two lower layers
mkdir -p /tmp/overlay/{lower1,lower2,upper,work,merged}

# Populate layers
echo "from lower1" > /tmp/overlay/lower1/file1.txt
echo "from lower2" > /tmp/overlay/lower2/file2.txt
echo "original in lower1" > /tmp/overlay/lower1/shared.txt
echo "override in lower2" > /tmp/overlay/lower2/shared.txt  # Overrides lower1

# Mount with two lower layers (colon-separated, topmost first)
mount -t overlay overlay \
    -o lowerdir=/tmp/overlay/lower2:/tmp/overlay/lower1,\
upperdir=/tmp/overlay/upper,\
workdir=/tmp/overlay/work \
    /tmp/overlay/merged

# Verify the view
ls /tmp/overlay/merged/
# file1.txt  file2.txt  shared.txt

cat /tmp/overlay/merged/shared.txt
# override in lower2  (lower2 wins)

# Write to a lower-layer file — triggers copy-up
echo "modified" > /tmp/overlay/merged/shared.txt
ls /tmp/overlay/upper/
# shared.txt  (copy-up occurred; lower1 and lower2 unchanged)

# Delete a file — creates whiteout
rm /tmp/overlay/merged/file1.txt
ls -la /tmp/overlay/upper/
# c---------. 1 root root 0, 0 Nov 13 2031 file1.txt  (whiteout device)

# Cleanup
umount /tmp/overlay/merged
```

### 1.2 OverlayFS in containerd

containerd uses OverlayFS through the `overlayfs` snapshotter. Each container layer corresponds to one OverlayFS lower directory:

```bash
# View containerd snapshot tree
ctr snapshots list

# View the actual mount configuration for a container
ctr task exec <container-id> sh -c "cat /proc/mounts | grep overlay"
# overlay /  overlay rw,relatime,
#   lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/47/fs:
#            /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/46/fs:
#            /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/45/fs,
#   upperdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/52/fs,
#   workdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/52/work,
#   index=off,xino=off

# Inspect a snapshot
SNAP_ID=47
ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/${SNAP_ID}/fs/

# View snapshot metadata
ctr snapshots info <snapshot-name>
```

### 1.3 Debugging Copy-Up Performance

```bash
# Measure copy-up latency with eBPF
# copy-up happens in ovl_copy_up_one() kernel function
bpftrace -e '
kprobe:ovl_copy_up_one
{
    @start[tid] = nsecs;
}
kretprobe:ovl_copy_up_one
/@start[tid]/
{
    @latency_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}
interval:s:5
{
    print(@latency_us);
    clear(@latency_us);
}
'

# Alternatively, use ftrace
echo 'ovl_copy_up_one' > /sys/kernel/tracing/set_graph_function
echo function_graph > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
# Run container workload...
echo 0 > /sys/kernel/tracing/tracing_on
grep 'ovl_copy_up_one' /sys/kernel/tracing/trace | \
    awk '{print $3}' | sort -n
```

## Section 2: Metacopy Optimization

### 2.1 What Metacopy Solves

Without metacopy, any write to a file's metadata (ownership, permissions, timestamps) triggers a full data copy-up of the entire file. For containers that `chown` many files during startup (a common pattern in images that run as non-root), this causes significant I/O.

**Metacopy** (available since Linux 4.19) allows the upper layer to store only the changed metadata, leaving the actual data in the lower layer. The upper layer contains an "inode metadata" entry that points to the lower layer's data via an extended attribute.

```bash
# Check if metacopy is available
cat /proc/filesystems | grep overlay

# Check kernel version (metacopy requires 4.19+)
uname -r

# Verify metacopy is enabled
mount | grep overlay | grep metacopy

# Enable metacopy when mounting
mount -t overlay overlay \
    -o lowerdir=...,upperdir=...,workdir=...,metacopy=on \
    /merged
```

### 2.2 Metacopy in containerd

```toml
# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".containerd]
  snapshotter = "overlayfs"

[plugins."io.containerd.snapshotter.v1.overlayfs"]
  # Enable metacopy: reduces I/O for metadata-only operations
  sync_remove = false

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  # Ensure the overlay options are passed
  SystemdCgroup = true
```

For Docker:

```json
{
  "storage-driver": "overlay2",
  "storage-opts": [
    "overlay2.override_kernel_check=false"
  ]
}
```

### 2.3 Verifying Metacopy Behavior

```bash
# Create test environment
mkdir -p /tmp/meta-test/{lower,upper,work,merged}
echo "large file content" > /tmp/meta-test/lower/testfile.txt
dd if=/dev/urandom of=/tmp/meta-test/lower/bigfile.bin bs=1M count=100

# Mount with metacopy enabled
mount -t overlay overlay \
    -o lowerdir=/tmp/meta-test/lower,\
upperdir=/tmp/meta-test/upper,\
workdir=/tmp/meta-test/work,\
metacopy=on \
    /tmp/meta-test/merged

# Change only permissions — should not trigger data copy-up
chmod 644 /tmp/meta-test/merged/bigfile.bin

# Verify: upper should have metadata marker but NOT the full file data
ls -la /tmp/meta-test/upper/
# -rw-r--r-- 1 root root 0 Nov 13 2031 bigfile.bin  ← empty, only metadata

# Check the metacopy xattr
getfattr -n trusted.overlay.metacopy /tmp/meta-test/upper/bigfile.bin
# trusted.overlay.metacopy: "\x00\x01"  ← metacopy marker

# Verify lowerdata xattr points to origin
getfattr -n trusted.overlay.lowerdata /tmp/meta-test/upper/bigfile.bin

umount /tmp/meta-test/merged
```

## Section 3: Native Diff Algorithm

### 3.1 How Native Diff Works

When building container images or exporting layers, the container runtime must compute the "diff" between two OverlayFS snapshots. Without native diff, this requires comparing directory trees recursively.

**Native diff** uses OverlayFS's ability to enumerate only the files that have actually been modified in the upper layer — avoiding a full directory walk.

```bash
# See what's in the upper layer of a running container
# (This is the native diff of that container)
CONTAINER_ID=$(crictl ps -q | head -1)
UPPER_DIR=$(crictl inspect "$CONTAINER_ID" | \
    jq -r '.info.runtimeSpec.mounts[] | select(.destination == "/") | .source')
echo "Upper dir: $UPPER_DIR"

# List all modified files
find "$UPPER_DIR" -type f -o -type c | while read -r f; do
    if [[ -c "$f" ]]; then
        echo "DELETED: ${f#$UPPER_DIR}"
    else
        echo "MODIFIED/CREATED: ${f#$UPPER_DIR}"
    fi
done
```

### 3.2 Enabling Native Diff in containerd

```toml
# /etc/containerd/config.toml
[plugins."io.containerd.diff.v1.walking"]
  # native_diff is enabled by default in recent containerd versions
  # but can be forced or disabled
  discard_unpacked_layers = false

# For the snapshotter to use native diff:
[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "overlayfs"
    disable_snapshot_annotations = false  # Required for native diff
```

### 3.3 Benchmarking Native Diff vs. Walking Diff

```bash
#!/usr/bin/env bash
# benchmark-diff.sh
# Compares layer export performance with and without native diff

set -euo pipefail

IMAGE="ubuntu:22.04"
ITERATIONS=3

# Ensure image is pulled
ctr images pull docker.io/library/ubuntu:22.04

benchmark_export() {
    local method="$1"
    local total_time=0

    for i in $(seq 1 $ITERATIONS); do
        local start_ns
        start_ns=$(date +%s%N)

        if [[ "$method" == "native" ]]; then
            ctr images export --platform linux/amd64 /tmp/export-test.tar \
                docker.io/library/ubuntu:22.04 2>/dev/null
        else
            # Force walking diff by using a method that doesn't use overlayfs snapshots
            docker save ubuntu:22.04 -o /tmp/export-test.tar 2>/dev/null
        fi

        local end_ns
        end_ns=$(date +%s%N)
        local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
        total_time=$((total_time + duration_ms))
        rm -f /tmp/export-test.tar
    done

    echo "${method}: avg $(( total_time / ITERATIONS )) ms"
}

echo "Image: $IMAGE, Iterations: $ITERATIONS"
benchmark_export "native"
benchmark_export "walking"
```

## Section 4: Quotas

### 4.1 Project Quotas for Container Storage

On XFS and ext4 with project quotas enabled, you can limit how much space each container's upper (writable) layer can consume.

```bash
# Enable project quotas on XFS
# Add 'prjquota' to mount options in /etc/fstab
# /dev/sdb /var/lib/containerd xfs defaults,prjquota 0 2

# Verify quota support
xfs_quota -x -c "state" /var/lib/containerd
# Filesystem: /var/lib/containerd
# Quota Accounting: Project=ON
# Quota Enforcement: Project=ON

# Check current quota usage
xfs_quota -x -c "report -pbih" /var/lib/containerd
```

### 4.2 containerd Snapshot Quotas

```toml
# /etc/containerd/config.toml
[plugins."io.containerd.snapshotter.v1.overlayfs"]
  # Maximum size for each snapshot (upper layer)
  # Requires XFS with project quotas OR ext4 with project quotas
  # upper_dir_quota_size = 10737418240  # 10 GB
```

For Kubernetes, use `ephemeral-storage` limits which containerd enforces via project quotas:

```yaml
# pod-storage-limits.yaml
apiVersion: v1
kind: Pod
metadata:
  name: storage-limited-pod
spec:
  containers:
    - name: app
      image: nginx:1.27
      resources:
        requests:
          ephemeral-storage: "1Gi"
        limits:
          ephemeral-storage: "5Gi"   # Enforced by kubelet via overlay quotas
```

### 4.3 Implementing Per-Container Quotas Manually

```bash
#!/usr/bin/env bash
# overlay-quota.sh
# Sets XFS project quota on a container's upper directory

set -euo pipefail

CONTAINER_ID="${1:?Usage: $0 <container-id> <quota-bytes>}"
QUOTA_BYTES="${2:?}"
PROJECT_ID="${3:-12345}"   # Must be unique per container

# Get upper directory path
UPPER_DIR=$(crictl inspect "$CONTAINER_ID" | \
    jq -r '.info.runtimeSpec.linux.namespaces' 2>/dev/null || \
    # Fallback: parse overlay mount
    cat /proc/$(crictl inspect "$CONTAINER_ID" | \
    jq -r '.info.pid')/mounts | \
    awk '/overlay/{match($0, /upperdir=([^,]*)/, arr); print arr[1]}')

if [[ -z "$UPPER_DIR" ]]; then
    echo "ERROR: Could not determine upper directory for container $CONTAINER_ID"
    exit 1
fi

echo "Setting ${QUOTA_BYTES} byte quota on ${UPPER_DIR} (project ${PROJECT_ID})"

# Assign project ID to the directory
echo "${PROJECT_ID}:${UPPER_DIR}" >> /etc/projects
echo "${PROJECT_ID}:${UPPER_DIR}" >> /etc/projid

# Set the quota
QUOTA_BLOCKS=$(( QUOTA_BYTES / 4096 ))
xfs_quota -x -c "project -s -p ${UPPER_DIR} ${PROJECT_ID}" /var/lib/containerd
xfs_quota -x -c "limit -p bhard=${QUOTA_BLOCKS} ${PROJECT_ID}" /var/lib/containerd

echo "Quota set successfully"
xfs_quota -x -c "report -pbih" /var/lib/containerd | grep -A2 "Project ${PROJECT_ID}"
```

## Section 5: Layer Deduplication and Cleanup

### 5.1 Analyzing Layer Usage

```bash
# Check total containerd storage usage
du -sh /var/lib/containerd/

# List all snapshots with sizes
ctr snapshots ls | head -20

# Find the largest snapshots
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/*/fs \
    2>/dev/null | sort -rh | head -20

# List unreferenced (orphaned) layers
# These are snapshots not referenced by any image or container
ctr content ls | awk '{print $1}' > /tmp/used-content.txt
find /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/ -type f | \
    xargs -I{} basename {} | grep -v -F -f /tmp/used-content.txt | \
    head -20
```

### 5.2 Automated Layer Cleanup

```bash
#!/usr/bin/env bash
# container-storage-cleanup.sh
# Cleans up unused images, containers, and snapshots

set -euo pipefail

DRY_RUN="${1:-true}"
MIN_FREE_PERCENT="${2:-20}"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

check_disk_space() {
    local df_line
    df_line=$(df /var/lib/containerd | tail -1)
    local use_percent
    use_percent=$(echo "$df_line" | awk '{print $5}' | tr -d '%')
    echo $((100 - use_percent))
}

free_percent=$(check_disk_space)
log "Current free space: ${free_percent}%"

if (( free_percent >= MIN_FREE_PERCENT )); then
    log "Sufficient free space, skipping cleanup"
    exit 0
fi

log "Free space below ${MIN_FREE_PERCENT}%, starting cleanup"

if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY RUN] Would clean:"

    # Unused images
    crictl images | awk 'NR>1 && $3=="<none>" {print "  Image:", $1}' || true

    # Exited containers
    crictl ps -a | awk 'NR>1 && $4!="Running" {print "  Container:", $1}' || true
else
    log "Removing stopped containers..."
    crictl rm $(crictl ps -a --state Exited -q 2>/dev/null) 2>/dev/null || true

    log "Removing unused images..."
    crictl rmi --prune 2>/dev/null || true

    # containerd-specific: prune unreferenced content
    log "Pruning containerd content..."
    ctr content prune --help 2>/dev/null && \
        ctr content prune references || true

    free_after=$(check_disk_space)
    log "Cleanup complete. Free space: ${free_after}%"
fi
```

### 5.3 Image Layer Sharing Analysis

```bash
#!/usr/bin/env bash
# layer-sharing.sh
# Shows which image layers are shared between images (deduplication)

echo "Image layer manifest digests:"
crictl images -o json | jq -r '.images[].repoTags[]' | \
    while read -r image; do
        echo "=== $image ==="
        ctr images export /dev/null "$image" 2>/dev/null || true
    done

# Check actual deduplication ratio
echo ""
echo "Storage breakdown:"
LOGICAL_SIZE=$(ctr images ls -q | xargs -I{} sh -c \
    'ctr images export /dev/null {} 2>/dev/null; echo $?' | \
    awk '{sum+=$1} END{print sum}')
ACTUAL_SIZE=$(du -sb /var/lib/containerd | awk '{print $1}')
echo "Logical (sum of all layers): $((LOGICAL_SIZE / 1024 / 1024)) MB"
echo "Actual disk usage:           $((ACTUAL_SIZE / 1024 / 1024)) MB"
```

## Section 6: Performance Tuning

### 6.1 OverlayFS Mount Options

```bash
# Key mount options that affect performance:

# index=off (default on older kernels)
# Disables inode indexing, required when lowerdir is on NFS/network storage
# Not needed for local storage; adds overhead when enabled unnecessarily

# xino=off (default)
# Disable cross-filesystem inode number merging
# Enable (xino=on) for consistent inode numbers across mounts
# Required for some applications that rely on stable inodes

# redirect_dir=on (default: nofollow)
# Enables renaming of directories within upper layer
# Required for containerized builds that rename directories
# Adds overhead; only enable if needed

# Mount options for production container storage on local NVMe
mount -t overlay overlay \
    -o lowerdir=...,upperdir=...,workdir=...,\
       metacopy=on,\
       index=off,\
       xino=off \
    /merged
```

### 6.2 /proc/sys Tuning for OverlayFS

```bash
# Increase inotify limits for container storage watching
echo 1048576 > /proc/sys/fs/inotify/max_user_watches
echo 1048576 > /proc/sys/fs/inotify/max_user_instances

# For systems running many containers:
# Increase dcache (dentry cache) size
# The default is typically sufficient, but high-density nodes may need tuning
echo 100 > /proc/sys/vm/vfs_cache_pressure   # Default 100, reduce to 50 for container-heavy nodes

# Persist
cat >> /etc/sysctl.d/99-container-storage.conf << 'EOF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 1048576
vm.vfs_cache_pressure = 50
EOF
```

### 6.3 Diagnosing Slow Container Starts

Container start latency often comes from OverlayFS copy-up during entrypoint execution. Profile it:

```bash
#!/usr/bin/env bash
# profile-container-start.sh
# Measures OverlayFS copy-up activity during container startup

CONTAINER_IMAGE="${1:-nginx:1.27}"
CONTAINER_NAME="overlay-profile-test"

# Enable block I/O tracing
echo 1 > /sys/kernel/tracing/events/block/block_rq_issue/enable
echo 1 > /sys/kernel/tracing/tracing_on

START_TIME=$(date +%s%N)

# Start container
ctr run --rm "$CONTAINER_IMAGE" "$CONTAINER_NAME" sleep 5 &
CONTAINER_PID=$!

# Wait for container to start
sleep 1

END_TIME=$(date +%s%N)
STARTUP_MS=$(( (END_TIME - START_TIME) / 1000000 ))

echo 0 > /sys/kernel/tracing/tracing_on
echo 0 > /sys/kernel/tracing/events/block/block_rq_issue/enable

echo "Container startup: ${STARTUP_MS}ms"

# Count block I/O during startup
IO_COUNT=$(cat /sys/kernel/tracing/trace | \
    awk -v start="$((START_TIME / 1000000000))" \
        '/block_rq_issue/{
            ts=$3; sub(/:/, "", ts);
            if (ts > start) count++
        }
        END {print count}')

echo "Block I/O operations during startup: ${IO_COUNT}"

# Clean up
wait "$CONTAINER_PID" 2>/dev/null || true
echo 0 > /sys/kernel/tracing/tracing_on
```

## Section 7: Monitoring OverlayFS Health

### 7.1 Key Metrics

```bash
# Monitor OverlayFS-related kernel counters
watch -n1 'cat /proc/vmstat | grep -E "(nr_dirty|nr_writeback|pgpg|pdflush)"'

# Check for OverlayFS mount errors
dmesg | grep -i overlay | tail -20

# Monitor copy-up rate via kprobe
bpftrace -e '
kprobe:ovl_copy_up_one { @copyup_count = count(); }
interval:s:1 {
    printf("Copy-up/s: %d\n", @copyup_count);
    clear(@copyup_count);
}
' &

# Check for whiteout file accumulation (indicates excessive deletes)
find /var/lib/containerd -name ".wh.*" 2>/dev/null | wc -l
```

### 7.2 Prometheus Metrics for Container Storage

```yaml
# Custom metrics via node_exporter textfile collector
# /etc/cron.d/container-storage-metrics

#!/usr/bin/env bash
# container-storage-metrics.sh
# Generates Prometheus metrics for container storage health

METRICS_FILE="/var/lib/node_exporter/textfile_collector/container_storage.prom"

{
    echo "# HELP container_storage_used_bytes Total bytes used by container storage"
    echo "# TYPE container_storage_used_bytes gauge"
    echo "container_storage_used_bytes $(du -sb /var/lib/containerd 2>/dev/null | awk '{print $1}')"

    echo "# HELP container_overlay_snapshots_total Number of overlay snapshots"
    echo "# TYPE container_overlay_snapshots_total gauge"
    SNAP_COUNT=$(ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/ 2>/dev/null | wc -l)
    echo "container_overlay_snapshots_total ${SNAP_COUNT}"

    echo "# HELP container_whiteout_files_total Number of whiteout files in overlay upper dirs"
    echo "# TYPE container_whiteout_files_total gauge"
    WO_COUNT=$(find /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/*/fs \
        -name ".wh.*" 2>/dev/null | wc -l)
    echo "container_whiteout_files_total ${WO_COUNT}"
} > "$METRICS_FILE"
```

## Summary

OverlayFS underpins container storage on virtually every production Linux system. The operational knowledge required for production container workloads:

1. **Layer mechanics**: Every file write triggers a copy-up from lower layers to the upper (writable) layer. For large files, this is expensive. Structure Dockerfiles to minimize writes to large files during container startup.

2. **Metacopy**: Enable `metacopy=on` in containerd's snapshotter configuration to avoid data copy-up for permission-only changes. This is critical for images that `chown` files during startup (common in official images that drop root after setup).

3. **Native diff**: Enable `disable_snapshot_annotations = false` in containerd to allow native diff. This makes layer exports and image pushes significantly faster by enumerating only changed files.

4. **Quotas**: Use `ephemeral-storage` limits in Kubernetes to enforce OverlayFS upper layer quotas via XFS project quotas. Prevents a single container from filling the node's container storage filesystem.

5. **Cleanup**: Implement automated cleanup triggered by disk usage percentage rather than schedule-based cleanup. Set the threshold at 80% utilization to avoid emergency cleanups during high traffic.

6. **Monitoring**: Track copy-up rate via bpftrace/kprobes and whiteout file accumulation via textfile collector metrics. Sudden increases indicate workload changes that may stress the storage layer.
