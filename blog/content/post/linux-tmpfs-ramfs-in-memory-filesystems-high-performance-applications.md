---
title: "Linux tmpfs and ramfs: In-Memory Filesystems for High-Performance Applications"
date: 2031-01-05T00:00:00-05:00
draft: false
tags: ["Linux", "tmpfs", "ramfs", "In-Memory", "Kubernetes", "Performance", "Security", "Storage"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux in-memory filesystems, covering tmpfs vs ramfs differences, sizing, swap interaction, Kubernetes emptyDir with memory medium, and security implications for enterprise workloads."
more_link: "yes"
url: "/linux-tmpfs-ramfs-in-memory-filesystems-high-performance-applications/"
---

In-memory filesystems eliminate I/O latency by keeping data in RAM. For applications with extreme performance requirements — high-frequency trading, real-time analytics, build caches, and secrets handling — the difference between disk I/O and memory I/O is often the difference between meeting SLOs and missing them. Linux provides two in-memory filesystem types: `tmpfs` and `ramfs`. Understanding their differences, sizing implications, swap behavior, and security characteristics is essential for using them correctly in production and Kubernetes environments.

<!--more-->

# Linux tmpfs and ramfs: In-Memory Filesystems for High-Performance Applications

## Section 1: tmpfs vs ramfs — Core Differences

Both `tmpfs` and `ramfs` store all data in kernel memory (page cache). The differences determine which is appropriate for production use.

### tmpfs

- **Size-limited**: You must specify a maximum size. The kernel enforces this limit.
- **Swap-capable**: When memory pressure occurs, the kernel can swap tmpfs pages to disk.
- **POSIX-compliant**: Supports all standard filesystem semantics including permissions, symlinks, and extended attributes.
- **Dynamically sized**: Only uses as much RAM as currently stored data; does not pre-allocate the full quota.
- **Available since Linux 2.4**: Widely supported and production-tested.

### ramfs

- **Unlimited size**: No enforced capacity limit — it will grow until OOM.
- **No swap**: Pages are pinned in RAM; the kernel cannot reclaim them under memory pressure.
- **POSIX-compliant**: Same semantics as tmpfs.
- **Simple implementation**: Older, simpler codebase; fewer kernel features.

### Summary Table

| Feature | tmpfs | ramfs |
|---|---|---|
| Size limit | Yes (enforced at mount time) | No (grows until OOM) |
| Swap support | Yes | No |
| Dynamic sizing | Yes | Yes |
| Production safety | High | Low (OOM risk) |
| Performance vs disk | Equivalent | Equivalent |
| Kubernetes support | Yes (emptyDir.medium=Memory) | No |

**Production recommendation**: Always use `tmpfs`. `ramfs` is a footgun — a runaway process writing to ramfs will exhaust all system memory and trigger OOM kills. The only legitimate use case for ramfs is embedded systems without swap partitions where you need guaranteed memory residency.

## Section 2: Mounting tmpfs

### Basic Mount

```bash
# Mount tmpfs for /tmp (most common use case)
mount -t tmpfs -o size=4g,mode=1777 tmpfs /tmp

# Mount tmpfs for build cache
mount -t tmpfs -o size=8g,mode=0755 tmpfs /var/cache/build

# Mount tmpfs for application scratch space
mount -t tmpfs -o size=2g,uid=1000,gid=1000,mode=0700 tmpfs /app/scratch

# Mount with noexec for security (prevent executing files from tmpfs)
mount -t tmpfs -o size=1g,noexec,nosuid,nodev tmpfs /tmp/uploads
```

### /etc/fstab Entries

```bash
# /tmp on tmpfs — best practice for container hosts and CI runners
tmpfs  /tmp      tmpfs  defaults,noatime,nosuid,nodev,noexec,size=8g,mode=1777  0 0

# Build cache on tmpfs (speeds up compilation significantly)
tmpfs  /var/cache/ccache  tmpfs  defaults,noatime,size=16g,uid=build,gid=build,mode=0700  0 0

# Secrets directory on tmpfs (never written to disk)
tmpfs  /run/secrets  tmpfs  defaults,noatime,nosuid,nodev,noexec,size=64m,mode=0700  0 0

# Docker/containerd layer cache on tmpfs (for ephemeral CI environments)
tmpfs  /var/lib/docker/overlay2  tmpfs  defaults,noatime,size=20g  0 0

# PostgreSQL shared memory area
tmpfs  /dev/shm  tmpfs  defaults,size=8g  0 0
```

### Mount Option Reference

| Option | Effect |
|---|---|
| `size=N[k/m/g/%]` | Maximum size (bytes, kibibytes, mebibytes, gibibytes, or % of RAM) |
| `mode=OCTAL` | Permissions on mount point |
| `uid=N` / `gid=N` | Owner of mount point |
| `noatime` | Skip access time updates |
| `noexec` | Prevent execution of binaries stored here |
| `nosuid` | Prevent setuid execution |
| `nodev` | Prevent device files |
| `nr_inodes=N` | Maximum inode count (defaults to RAM/4096) |
| `nr_blocks=N` | Maximum block count (alternative to size=) |
| `mpol=POLICY` | NUMA memory policy (default, prefer, bind, interleave) |

## Section 3: Swap Interaction and Memory Pressure

Understanding how tmpfs interacts with swap is critical for sizing decisions.

### How tmpfs Swapping Works

When the system encounters memory pressure, the kernel can page out tmpfs contents to swap space just like anonymous process memory. This means:

1. Tmpfs data survives memory pressure (unlike ramfs which can trigger OOM).
2. Performance degrades gracefully rather than crashing.
3. But: if you're using tmpfs specifically to avoid I/O latency, swap defeats the purpose.

### Preventing tmpfs Swap with mlockall

```c
// For processes that write sensitive data to tmpfs and need it to stay in RAM:
// Use mlock() to pin specific mappings
#include <sys/mman.h>

// Lock a specific memory region (e.g., after mmap of a tmpfs file)
mlock(ptr, size);

// Lock all process memory (requires CAP_IPC_LOCK)
mlockall(MCL_CURRENT | MCL_FUTURE);
```

```bash
# Check if tmpfs pages have been swapped
# swapon --show lists active swap devices
# /proc/swaps shows current swap usage
cat /proc/swaps

# Check tmpfs memory usage
df -h /tmp
# Filesystem      Size  Used Avail Use% Mounted on
# tmpfs           8.0G  2.3G  5.7G  29% /tmp

# Monitor tmpfs swap pressure
cat /proc/meminfo | grep -E "SwapTotal|SwapFree|SwapCached|Dirty|Writeback"
```

### Sizing tmpfs Correctly

A common mistake is mounting tmpfs at a size larger than the system has available RAM + swap:

```bash
# Calculate safe tmpfs sizes
TOTAL_RAM=$(free -g | awk '/^Mem:/{print $2}')
TOTAL_SWAP=$(free -g | awk '/^Swap:/{print $2}')
echo "Total RAM: ${TOTAL_RAM}GB, Total Swap: ${TOTAL_SWAP}GB"
echo "Max safe tmpfs total: $((TOTAL_RAM + TOTAL_SWAP))GB"

# For production: leave headroom
# If RAM=64GB, Swap=32GB:
# Max tmpfs total = ~80GB (leaving 16GB for OS + process working sets)
# Recommended: /tmp=16g, /var/cache/build=32g, /run/secrets=512m
```

## Section 4: Common Use Cases

### 4.1 /tmp on tmpfs

Replacing a disk-backed `/tmp` with tmpfs is one of the most impactful single-line optimizations for application servers:

```bash
# Benchmark: write 10,000 small files
time for i in $(seq 10000); do echo "data" > /tmp/bench-$i; done; rm /tmp/bench-*

# Typical results:
# Disk-backed /tmp (HDD): 45.2 seconds
# Disk-backed /tmp (SSD): 3.8 seconds
# tmpfs: 0.4 seconds
```

### 4.2 Compiler and Build Caches

Modern build systems (Bazel, Gradle, cargo) produce enormous intermediate artifacts. Putting the build cache on tmpfs dramatically speeds up incremental builds:

```bash
# ccache configuration for tmpfs
mkdir -p /var/cache/ccache
mount -t tmpfs -o size=16g,uid=$(id -u build),gid=$(id -g build) tmpfs /var/cache/ccache

# Configure ccache to use tmpfs location
export CCACHE_DIR=/var/cache/ccache
export CCACHE_MAXSIZE=15G  # slightly less than mount size

# Cargo (Rust) build cache on tmpfs
export CARGO_TARGET_DIR=/tmp/cargo-build
# Add to ~/.cargo/config.toml
cat >> ~/.cargo/config.toml << 'EOF'
[build]
target-dir = "/tmp/cargo-build"
EOF

# Gradle daemon tmpdir
# Add to gradle.properties or GRADLE_OPTS:
export GRADLE_OPTS="-Djava.io.tmpdir=/tmp/gradle-build"
```

### 4.3 Secrets Handling on tmpfs

Storing secrets in tmpfs ensures they are never written to persistent storage (disks, SSD wear-leveling blocks, swap):

```bash
# Mount dedicated tmpfs for secrets
mkdir -p /run/secrets
mount -t tmpfs -o size=64m,noexec,nosuid,nodev,mode=0700 tmpfs /run/secrets

# Write secret (from Vault, AWS SSM, etc.) to tmpfs
vault kv get -field=db_password secret/myapp > /run/secrets/db_password
chmod 600 /run/secrets/db_password

# Application reads secret from memory-backed file
# No disk write ever occurs

# On application shutdown, the secret disappears with the tmpfs on unmount
umount /run/secrets

# Or wipe explicitly before unmount (defense in depth)
shred -u /run/secrets/db_password
umount /run/secrets
```

### 4.4 Database Temp Space

PostgreSQL, MySQL, and other databases use temporary space for sorting and hash operations. Pointing this to tmpfs eliminates sort spill latency:

```bash
# PostgreSQL: configure temp_tablespaces to use tmpfs
mount -t tmpfs -o size=32g,mode=0700,uid=postgres,gid=postgres tmpfs /var/lib/postgresql/pgsql_tmp

# In postgresql.conf:
# temp_tablespaces = 'fast_tmp'

# Create PostgreSQL tablespace pointing to tmpfs
# (connect as superuser)
# CREATE TABLESPACE fast_tmp LOCATION '/var/lib/postgresql/pgsql_tmp';
# ALTER DATABASE mydb SET temp_tablespaces TO fast_tmp;
```

### 4.5 POSIX Shared Memory

`/dev/shm` is a tmpfs mount that enables POSIX shared memory (shm_open). Applications using shared memory IPC (Python multiprocessing, Apache Spark, most ML frameworks) rely on this:

```bash
# Check current /dev/shm size
df -h /dev/shm

# For ML workloads with large tensor sharing, increase the size:
# Note: default is often only 64MB or half of RAM
mount -o remount,size=32g /dev/shm

# Persistent change in /etc/fstab:
# tmpfs  /dev/shm  tmpfs  defaults,size=32g  0 0

# PyTorch multiprocessing uses /dev/shm for tensor sharing:
# If workers report "OSError: [Errno 28] No space left on device"
# on /dev/shm, increase its size
```

## Section 5: Kubernetes emptyDir with Memory Medium

Kubernetes' `emptyDir` volume with `medium: Memory` is tmpfs mounted by the kubelet. It is the standard way to give containers access to RAM-backed storage.

### 5.1 Basic emptyDir Memory Volume

```yaml
# emptydir-memory-basic.yaml
apiVersion: v1
kind: Pod
metadata:
  name: memory-cache-demo
  namespace: default
spec:
  containers:
  - name: app
    image: redis:7.2-alpine
    resources:
      requests:
        memory: 1Gi
        cpu: 200m
      limits:
        memory: 2Gi
    volumeMounts:
    - name: shm
      mountPath: /dev/shm
    - name: cache-scratch
      mountPath: /cache
  volumes:
  # Replace /dev/shm with a properly sized version
  - name: shm
    emptyDir:
      medium: Memory
      sizeLimit: 512Mi
  # In-memory scratch space for cache data
  - name: cache-scratch
    emptyDir:
      medium: Memory
      sizeLimit: 1Gi
```

### 5.2 Memory Accounting for emptyDir

Kubernetes counts emptyDir memory usage against the Pod's memory limit. This is critical: if a container writes 500Mi to an emptyDir Memory volume and its memory limit is 1Gi, the container is using 500Mi of its limit from the emptyDir alone, in addition to its working set RSS.

```yaml
# emptydir-memory-accounting.yaml
# IMPORTANT: size_of_emptydir_data + container_RSS must fit within limits.memory
# If you write 2Gi to an emptyDir Memory volume and limits.memory is 2Gi,
# the container will be OOM killed because the emptyDir memory counts.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: high-performance-cache
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: high-performance-cache
  template:
    metadata:
      labels:
        app: high-performance-cache
    spec:
      containers:
      - name: cache
        image: registry.support.tools/cache-service:3.0.0
        resources:
          requests:
            # request = expected RSS (2Gi) + expected emptyDir usage (4Gi)
            memory: 6Gi
            cpu: "2"
          limits:
            # limit = max RSS (3Gi) + max emptyDir usage (4Gi) + headroom (1Gi)
            memory: 8Gi
            cpu: "4"
        volumeMounts:
        - name: hot-cache
          mountPath: /cache/hot
        - name: work-buffer
          mountPath: /tmp/work
      volumes:
      - name: hot-cache
        emptyDir:
          medium: Memory
          sizeLimit: 4Gi
      - name: work-buffer
        emptyDir:
          medium: Memory
          sizeLimit: 512Mi
```

### 5.3 Sidecar Pattern with Shared Memory

A common pattern for ML inference: the model loader sidecar writes the model to shared memory, and the inference container reads from it without re-loading.

```yaml
# shared-memory-sidecar.yaml
apiVersion: v1
kind: Pod
metadata:
  name: ml-inference
  namespace: ml-workloads
spec:
  initContainers:
  # Init container loads the model into shared memory
  - name: model-loader
    image: registry.support.tools/model-loader:1.5.0
    env:
    - name: MODEL_PATH
      value: /models/bert-large
    - name: SHM_PATH
      value: /dev/shm/bert-large
    resources:
      requests:
        memory: 8Gi  # must hold the model during loading
    volumeMounts:
    - name: model-store
      mountPath: /models
    - name: shared-memory
      mountPath: /dev/shm

  containers:
  # Inference container reads model from shared memory
  - name: inference-server
    image: registry.support.tools/inference-server:2.0.0
    env:
    - name: MODEL_SHM_PATH
      value: /dev/shm/bert-large
    resources:
      requests:
        memory: 4Gi  # smaller because model is in shared memory
        cpu: "4"
      limits:
        memory: 10Gi  # 4Gi RSS + 6Gi for shared memory usage accounting
        cpu: "8"
    volumeMounts:
    - name: shared-memory
      mountPath: /dev/shm
    ports:
    - containerPort: 8080
      name: http

  volumes:
  - name: model-store
    persistentVolumeClaim:
      claimName: ml-models
  - name: shared-memory
    emptyDir:
      medium: Memory
      sizeLimit: 6Gi  # size of the model
```

### 5.4 emptyDir for Container Build Caches

In Kubernetes CI runners (Tekton, Argo Workflows), build layers can be cached in emptyDir Memory to speed up builds within a pipeline run:

```yaml
# tekton-pipeline-with-memory-cache.yaml
apiVersion: tekton.dev/v1beta1
kind: TaskRun
metadata:
  name: build-with-memory-cache
spec:
  taskSpec:
    steps:
    - name: build
      image: gcr.io/kaniko-project/executor:latest
      args:
      - --dockerfile=./Dockerfile
      - --context=.
      - --destination=registry/my-app:latest
      - --cache=true
      - --cache-dir=/cache
      volumeMounts:
      - name: build-cache
        mountPath: /cache
      - name: workspace
        mountPath: /workspace
    volumes:
    - name: build-cache
      emptyDir:
        medium: Memory
        sizeLimit: 4Gi
    - name: workspace
      emptyDir:
        medium: Memory
        sizeLimit: 2Gi
  podTemplate:
    securityContext:
      fsGroup: 0
```

## Section 6: Security Implications

### 6.1 Sensitive Data in Memory

In-memory filesystems are not inherently secure. Memory contents can be accessed via:

- `/proc/<pid>/mem` by root (or any process with `ptrace` capability)
- Hypervisor snapshots (cloud environments)
- Memory dumps after kernel crashes (kdump)
- Cold-boot attacks (physical access)
- Swap partition if tmpfs swapping is enabled

Defense in depth:

```bash
# 1. Disable core dumps (prevent secrets in core files)
echo "* hard core 0" >> /etc/security/limits.conf
ulimit -c 0
echo "kernel.core_pattern=/dev/null" >> /etc/sysctl.d/99-nosecrets.conf

# 2. Disable swap for security-sensitive hosts
swapoff -a
# Remove swap entries from /etc/fstab

# 3. Mount tmpfs with noswap equivalent (not a kernel option, but configure swap=0):
# Use cgroups v2 memory.swap.max = 0 to prevent container swap

# 4. Enable memory encryption (AMD SME/SEV on supported hardware)
# Check support:
dmesg | grep -i "memory encryption"

# 5. Use seccomp to prevent /proc/mem access:
# In container: securityContext.seccompProfile.type=RuntimeDefault
```

### 6.2 tmpfs in Container Security Contexts

```yaml
# pod-with-secure-tmpfs.yaml
apiVersion: v1
kind: Pod
metadata:
  name: secrets-handler
  namespace: secure-workloads
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 10000
    runAsGroup: 10000
    fsGroup: 10000
    # Disable swap for this pod's memory (cgroups v2)
    # Requires Kubernetes 1.28+ with MemorySwap feature gate
  containers:
  - name: app
    image: registry.support.tools/secrets-app:1.0.0
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
    resources:
      requests:
        memory: 256Mi
      limits:
        memory: 512Mi
    volumeMounts:
    - name: tmp-work
      mountPath: /tmp
    - name: secrets-cache
      mountPath: /run/secrets
      readOnly: false
  volumes:
  - name: tmp-work
    emptyDir:
      medium: Memory
      sizeLimit: 64Mi
  - name: secrets-cache
    emptyDir:
      medium: Memory
      sizeLimit: 4Mi  # small: only holds decrypted keys
```

### 6.3 Preventing tmpfs Over-commit

Linux allows mounting tmpfs with a total size larger than available RAM + swap, which causes silent failures when the actual limit is reached. Monitor tmpfs usage:

```bash
# Script: check-tmpfs-health.sh
#!/bin/bash
# Monitor tmpfs utilization and alert on high usage

ALERT_PCT=80

df -h --type=tmpfs | tail -n +2 | while read fs size used avail pct mount; do
    # Extract numeric percentage
    pct_num=${pct%%%}
    if [ "$pct_num" -gt "$ALERT_PCT" ]; then
        echo "ALERT: tmpfs at ${pct} utilization: ${mount} (${used}/${size})"
        logger -t tmpfs-monitor "tmpfs ${mount} at ${pct} capacity"
    fi
done

# Also check if any tmpfs is at 100% (writes will fail silently)
df --type=tmpfs | awk 'NR>1 && $5=="100%" {print "CRITICAL: tmpfs full: " $6}'
```

```yaml
# Prometheus alert for tmpfs utilization
groups:
- name: tmpfs-alerts
  rules:
  - alert: TmpfsHighUtilization
    expr: |
      (
        node_filesystem_size_bytes{fstype="tmpfs"} -
        node_filesystem_avail_bytes{fstype="tmpfs"}
      ) / node_filesystem_size_bytes{fstype="tmpfs"} > 0.85
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "tmpfs {{ $labels.mountpoint }} is {{ $value | humanizePercentage }} full"

  - alert: TmpfsFull
    expr: node_filesystem_avail_bytes{fstype="tmpfs"} == 0
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "tmpfs {{ $labels.mountpoint }} is completely full"
```

## Section 7: ramfs — When to Use It

Despite its risks, ramfs has legitimate use cases in specific environments:

### When ramfs Is Appropriate

1. **Embedded systems without swap**: If the platform has no swap, ramfs and tmpfs behave identically (both keep data in RAM). ramfs is simpler.
2. **Security-sensitive pinned memory**: ramfs pages cannot be swapped, which is useful when you explicitly need to prevent disk writes (though using mlock on a tmpfs file is more controlled).
3. **Root filesystem overlays**: Some initramfs implementations use ramfs for the initial rootfs before switching to a real filesystem.

### Comparing ramfs and tmpfs Performance

Performance is identical — both use the same kernel page cache. Do not use ramfs for "better performance"; they are equivalent.

```bash
# Benchmark comparison (run on the same system):
# tmpfs
mount -t tmpfs -o size=1g tmpfs /mnt/tmpfs-bench
fio --name=seqwrite --rw=write --bs=4k --size=256m --directory=/mnt/tmpfs-bench \
  --output-format=json | jq '.jobs[0].write.bw_bytes'

# ramfs
mount -t ramfs ramfs /mnt/ramfs-bench
fio --name=seqwrite --rw=write --bs=4k --size=256m --directory=/mnt/ramfs-bench \
  --output-format=json | jq '.jobs[0].write.bw_bytes'

# Results are within 1-2% of each other — both are memory-speed I/O
```

## Section 8: Kubernetes Node-Level tmpfs Configuration

For Kubernetes worker nodes, systemd mounts and kubelet configuration control tmpfs behavior:

```bash
# Configure /tmp as tmpfs on Kubernetes worker nodes
# /etc/systemd/system/tmp.mount
cat > /etc/systemd/system/tmp.mount << 'EOF'
[Unit]
Description=Temporary Directory (/tmp)
Documentation=man:hier(7)
Documentation=https://www.freedesktop.org/wiki/Software/systemd/APIFileSystems
ConditionPathIsSymbolicLink=!/tmp
DefaultDependencies=no
Conflicts=umount.target
Before=local-fs.target umount.target
After=swap.target

[Mount]
What=tmpfs
Where=/tmp
Type=tmpfs
Options=mode=1777,strictatime,nosuid,nodev,noexec,size=16g

[Install]
WantedBy=local-fs.target
EOF

systemctl enable tmp.mount
systemctl start tmp.mount
```

### Kubelet Configuration for emptyDir

```yaml
# kubelet configuration to limit total tmpfs usage
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# Evict pods when tmpfs (memory) emptyDir usage gets high
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
  imagefs.available: "15%"
# Soft eviction: warn but don't immediately evict
evictionSoft:
  memory.available: "1Gi"
evictionSoftGracePeriod:
  memory.available: "2m"
# Maximum emptyDir size (default: unlimited)
# Uncomment if you want to cap total emptyDir usage per node
# (applies to both disk and memory emptyDir)
# maxOpenFiles: 1000000
```

## Section 9: NUMA-Aware tmpfs

On multi-socket NUMA systems, tmpfs memory allocation policy matters for performance:

```bash
# Mount tmpfs on specific NUMA node for local access
# mpol=bind:0 — allocate only from NUMA node 0
mount -t tmpfs -o size=32g,mpol=bind:0 tmpfs /data/numa-local-0

# mpol=interleave:0,1 — round-robin across NUMA nodes (good for shared access)
mount -t tmpfs -o size=64g,mpol=interleave:0,1 tmpfs /data/numa-interleave

# mpol=prefer:0 — prefer NUMA node 0, fallback to others
mount -t tmpfs -o size=32g,mpol=prefer:0 tmpfs /data/numa-prefer-0

# Verify NUMA allocation
numastat -m | grep tmpfs

# Check which NUMA node a process allocates from
numastat -p <pid>
```

## Section 10: Operational Runbook

### Sizing Worksheet

```bash
#!/bin/bash
# tmpfs-sizing-worksheet.sh
# Run on your target system to generate sizing recommendations

echo "=== System Memory ==="
free -gh

echo ""
echo "=== Current tmpfs Mounts ==="
df -h --type=tmpfs

echo ""
echo "=== Recommended Sizes ==="
RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
SWAP_GB=$(free -g | awk '/^Swap:/{print $2}')
TOTAL=$((RAM_GB + SWAP_GB))

echo "Total RAM: ${RAM_GB}GB"
echo "Total Swap: ${SWAP_GB}GB"
echo "Addressable total: ${TOTAL}GB"
echo ""
echo "Recommendations (assuming standard production server):"
echo "  /tmp:              $((RAM_GB / 8))GB (12.5% of RAM)"
echo "  /run/secrets:      64MB"
echo "  /dev/shm:          $((RAM_GB / 4))GB (25% of RAM)"
echo "  build-cache:       $((RAM_GB / 4))GB (25% of RAM)"
echo "  Remaining for OS:  $((RAM_GB - RAM_GB/8 - RAM_GB/4 - RAM_GB/4))GB"
```

### Emergency Procedure: tmpfs Full

```bash
# When a tmpfs is 100% full, writes fail with ENOSPC

# Step 1: Identify which tmpfs is full
df --type=tmpfs | awk '$5 == "100%"'

# Step 2: Find what is consuming space
du -sh /tmp/* 2>/dev/null | sort -rh | head -20

# Step 3: Clear safe temporary files
find /tmp -name "*.tmp" -mtime +1 -delete
find /tmp -name "core.*" -delete

# Step 4: If that doesn't help, extend the tmpfs (online resize)
mount -o remount,size=16g /tmp  # double the size

# Step 5: If you cannot extend (RAM too low), identify and kill the producer
lsof +D /tmp | awk 'NR>1 {print $2}' | sort -u | \
  xargs -I{} ps -p {} -o pid,ppid,user,cmd
```

## Summary

In-memory filesystems provide kernel-speed I/O for workloads where disk latency is unacceptable. The operational guidelines are:

1. **Always use tmpfs, never ramfs** in production. The size limit prevents OOM and provides graceful behavior under memory pressure.
2. **Size conservatively**: Size constraints are not pre-allocated, so using `size=16g` on a system with 64GB RAM is fine — only actually written data consumes memory.
3. **Account for swap interaction**: For latency-sensitive workloads, either disable swap on the host or use `mlock()` to pin critical mappings.
4. **In Kubernetes, emptyDir Memory counts against pod limits**: Request memory = container RSS + expected emptyDir usage.
5. **Security**: Use `noexec,nosuid,nodev` for untrusted content; disable swap for secrets-handling workloads; use small, purpose-specific mounts rather than one large general-purpose tmpfs.
6. **Monitor utilization**: A full tmpfs causes silent write failures (ENOSPC). Alert at 80% and page at 95%.
