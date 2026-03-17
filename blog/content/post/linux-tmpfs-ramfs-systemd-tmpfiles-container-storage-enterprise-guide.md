---
title: "Linux tmpfs and ramfs: Mount Options, Size Limits, /dev/shm, systemd-tmpfiles, and Ephemeral Storage for Containers"
date: 2032-02-21T00:00:00-05:00
draft: false
tags: ["Linux", "tmpfs", "ramfs", "systemd", "Containers", "Storage", "Performance"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Linux in-memory filesystems covering tmpfs vs ramfs differences, mount option tuning, /dev/shm sizing, systemd-tmpfiles for automated directory management, and using tmpfs for high-performance ephemeral storage in containers and Kubernetes pods."
more_link: "yes"
url: "/linux-tmpfs-ramfs-systemd-tmpfiles-container-storage-enterprise-guide/"
---

Linux in-memory filesystems provide microsecond-latency storage for ephemeral data: temporary files, IPC shared memory, session scratch space, and build caches. Understanding the difference between tmpfs and ramfs, tuning mount parameters, managing /dev/shm for container workloads, and automating directory lifecycle with systemd-tmpfiles are essential skills for production Linux administrators.

<!--more-->

# Linux tmpfs and ramfs: Enterprise Administration Guide

## Section 1: tmpfs vs ramfs — Fundamental Differences

### tmpfs

`tmpfs` is the production-grade in-memory filesystem for Linux. Key properties:

- **Size limit**: configurable; defaults to half of physical RAM
- **Swap**: can swap pages to disk when memory is tight (controlled by `vm.swappiness`)
- **Resizable**: size can be changed with `mount -o remount,size=newsize`
- **Persistent within session**: survives file operations, not reboots
- **Backed by the page cache**: uses the same kernel infrastructure as file-backed mmap

### ramfs

`ramfs` is the minimal, unrestricted in-memory filesystem:

- **No size limit**: grows without bound until OOM kills the system
- **Never swaps**: pages are pinned in memory
- **Not resizable**: mount options don't include `size=`
- **Simpler code**: used internally by the kernel (initramfs is built on ramfs)

**Production rule**: use `tmpfs` everywhere. `ramfs` is only appropriate when you need pinned memory that must never be swapped (e.g., cryptographic key material) and you are certain about the maximum size.

```bash
# Mount tmpfs manually
mount -t tmpfs -o size=512m,mode=1777 tmpfs /tmp

# Mount ramfs (no size limit — dangerous on production systems)
mount -t ramfs -o mode=1777 ramfs /mnt/pinned
```

## Section 2: Mount Options Reference

### Size and Memory Options

```bash
# size= : maximum filesystem size in bytes, KB (k), MB (m), GB (g), or %
# Default: 50% of physical RAM
mount -t tmpfs -o size=1g tmpfs /mnt/tmp

# Size as percentage of physical RAM
mount -t tmpfs -o size=25% tmpfs /mnt/tmp

# nr_blocks= : size in filesystem blocks (alternative to size=)
mount -t tmpfs -o nr_blocks=262144 tmpfs /mnt/tmp   # 262144 * 4096 = 1 GiB

# nr_inodes= : maximum number of inodes (files + directories)
# Default: min(half of RAM in pages, 1M)
mount -t tmpfs -o size=1g,nr_inodes=1m tmpfs /mnt/tmp

# Disable inode limit (unlimited inodes for workloads with many small files)
mount -t tmpfs -o size=1g,nr_inodes=0 tmpfs /mnt/tmp
```

### Permission Options

```bash
# mode= : octal permissions for the mount root
mount -t tmpfs -o size=512m,mode=1777 tmpfs /tmp     # sticky + rwxrwxrwx (typical /tmp)
mount -t tmpfs -o size=512m,mode=700  tmpfs /root/tmp # root-only

# uid= and gid= : owner of the mount root
mount -t tmpfs -o size=512m,uid=1000,gid=1000 tmpfs /home/user/tmp
```

### Swap and Huge Page Options

```bash
# mpol= : memory policy for NUMA systems
# Values: default, prefer:0, bind:0, interleave:0-1
mount -t tmpfs -o size=1g,mpol=bind:0 tmpfs /mnt/numa0-tmp

# huge= : huge page support (Linux 4.7+)
# Values: never, always, within_size, advise
mount -t tmpfs -o size=4g,huge=within_size tmpfs /mnt/hugepage-tmp
```

### /etc/fstab Integration

```bash
# /etc/fstab entries for persistent tmpfs mounts
tmpfs    /tmp          tmpfs  defaults,nosuid,nodev,size=2g,mode=1777    0 0
tmpfs    /var/tmp      tmpfs  defaults,nosuid,nodev,size=4g,mode=1777    0 0
tmpfs    /run          tmpfs  defaults,nosuid,nodev,size=256m,mode=755   0 0
tmpfs    /dev/shm      tmpfs  defaults,nosuid,nodev,size=4g              0 0
```

### Verifying Mount State

```bash
# Show tmpfs mounts
mount -t tmpfs
df -h -t tmpfs

# Show free and used space on a specific tmpfs
df -h /tmp
du -sh /tmp

# Show inode usage
df -i /dev/shm

# Detailed mount options
cat /proc/mounts | grep tmpfs
findmnt -t tmpfs

# Runtime resize (does not unmount)
mount -o remount,size=4g /dev/shm
```

## Section 3: /dev/shm — POSIX Shared Memory

`/dev/shm` is a tmpfs mount used by `shm_open()` and `mmap(MAP_SHARED|MAP_ANONYMOUS)`. Applications use it for zero-copy IPC between processes.

### Default Configuration

Most Linux distributions mount `/dev/shm` automatically via systemd with a default size of half physical RAM:

```bash
# Check current /dev/shm configuration
findmnt /dev/shm
# OUTPUT:
# TARGET   SOURCE FSTYPE OPTIONS
# /dev/shm tmpfs  tmpfs  rw,nosuid,nodev,size=16384m

# Check from the memory perspective
cat /proc/sys/kernel/shmmax    # max segment size in bytes
cat /proc/sys/kernel/shmall    # total shared memory pages
cat /proc/sys/kernel/shmmni    # max number of segments
```

### Resizing /dev/shm

```bash
# Runtime resize (immediate, no remount needed)
mount -o remount,size=8g /dev/shm

# Persistent via systemd drop-in (preferred on systemd systems)
mkdir -p /etc/systemd/system/dev-shm.mount.d
cat > /etc/systemd/system/dev-shm.mount.d/size.conf << 'EOF'
[Mount]
Options=mode=1777,strictatime,nosuid,nodev,size=8g
EOF

systemctl daemon-reload
systemctl restart dev-shm.mount
```

### Monitoring /dev/shm Usage

```bash
# List objects in /dev/shm
ls -la /dev/shm/
# Each file is a POSIX shared memory segment

# Find which processes are using shared memory
ipcs -m   # System V shared memory
# For POSIX shm, look in /dev/shm

# Memory usage breakdown
cat /proc/meminfo | grep -E "Shmem|ShmemHugePages|ShmemPmdMapped"
```

### /dev/shm in Docker Containers

By default, Docker containers get a 64 MiB `/dev/shm`. This is often too small for database engines, machine learning frameworks, and browsers:

```bash
# Increase /dev/shm for a container
docker run --shm-size=2g my-image

# Or: use --ipc=host to share the host's /dev/shm (requires careful security review)
docker run --ipc=host my-image
```

## Section 4: systemd-tmpfiles

`systemd-tmpfiles` manages the creation, deletion, and cleaning of volatile and temporary files and directories. It replaces the older `tmpwatch` and manual cron-based cleanup.

### Configuration File Syntax

Files are placed in `/etc/tmpfiles.d/`, `/run/tmpfiles.d/`, or `/usr/lib/tmpfiles.d/`. Lines follow the format:

```
Type  Path               Mode  User  Group  Age  Argument
```

Common types:
- `d` — create directory if missing
- `D` — create directory and clean old files on startup
- `f` — create file if missing
- `F` — create or truncate file
- `L` — create symlink
- `z` — restore SELinux context and ownership
- `Z` — recursive version of `z`
- `r` — remove path on startup
- `R` — recursively remove path
- `e` — adjust existing file attributes (no create)
- `t` — set xattrs
- `a` — set ACL

### Example: Application Temporary Directory

```bash
# /etc/tmpfiles.d/myapp.conf

# Create /var/run/myapp owned by myapp user, cleaned hourly
d  /run/myapp              0750  myapp  myapp  1h   -

# Create /tmp/myapp with a 24-hour age limit on contents
D  /tmp/myapp              0700  myapp  myapp  24h  -

# Create config file if missing
f  /run/myapp/config.sock  0600  myapp  myapp  -    -

# Create log directory
d  /var/log/myapp          0750  myapp  adm    -    -

# Cleanup: remove files older than 7 days from /var/log/myapp
e  /var/log/myapp/*.log    -     -      -      7d   -
```

### Example: Service-Specific tmpfs

```bash
# /etc/tmpfiles.d/build-cache.conf
# Create a tmpfs mount point and use it for build cache

# The directory itself
d  /tmp/build-cache  0755  build  build  -  -
```

```ini
# /etc/systemd/system/tmp-build-cache.mount
[Unit]
Description=Build cache tmpfs
Before=local-fs.target

[Mount]
What=tmpfs
Where=/tmp/build-cache
Type=tmpfs
Options=defaults,size=8g,mode=0755,uid=1000,gid=1000,noexec,nosuid

[Install]
WantedBy=local-fs.target
```

### Applying tmpfiles Configuration

```bash
# Apply all tmpfiles.d configs now (create/clean)
systemd-tmpfiles --create
systemd-tmpfiles --clean
systemd-tmpfiles --remove

# Apply a specific config file
systemd-tmpfiles --create /etc/tmpfiles.d/myapp.conf

# Dry run (show what would happen)
systemd-tmpfiles --create --dry-run /etc/tmpfiles.d/myapp.conf

# Check timer that runs cleaning
systemctl list-timers | grep tmpfiles
# systemd-tmpfiles-clean.timer runs daily
```

### Per-Service tmpfiles in systemd Units

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Application

[Service]
User=myapp
Group=myapp
ExecStart=/usr/bin/myapp
# tmpfiles.d snippet inline in the unit
RuntimeDirectory=myapp        # creates /run/myapp
RuntimeDirectoryMode=0750
StateDirectory=myapp          # creates /var/lib/myapp (persistent)
CacheDirectory=myapp          # creates /var/cache/myapp
LogsDirectory=myapp           # creates /var/log/myapp
TmpPath=myapp                 # creates /tmp/myapp (volatile)
```

These directives create directories automatically, set ownership to the service user, and clean them up when the service is removed.

## Section 5: tmpfs for Container Ephemeral Storage

### Docker

```bash
# Mount tmpfs at a specific path in the container
docker run \
  --tmpfs /tmp:size=512m,mode=1777 \
  --tmpfs /var/cache:size=1g,mode=755 \
  my-image

# Docker Compose
```yaml
services:
  myapp:
    image: my-image
    tmpfs:
    - /tmp:size=512m,mode=1777
    - /var/cache:size=1g
    shm_size: '2gb'
```

### Kubernetes emptyDir with Medium: Memory

```yaml
# Pod with tmpfs emptyDir volumes
apiVersion: v1
kind: Pod
metadata:
  name: tmpfs-demo
  namespace: production
spec:
  containers:
  - name: app
    image: my-image:latest
    resources:
      requests:
        memory: "1Gi"
        cpu: "500m"
      limits:
        memory: "4Gi"
        cpu: "2"
    volumeMounts:
    - name: scratch
      mountPath: /tmp/scratch
    - name: shared-cache
      mountPath: /var/cache/shared
    - name: model-cache
      mountPath: /opt/model-cache
  - name: sidecar
    image: sidecar:latest
    volumeMounts:
    - name: shared-cache
      mountPath: /data/cache
  volumes:
  # tmpfs: backed by RAM, counts against container memory limits
  - name: scratch
    emptyDir:
      medium: Memory
      sizeLimit: 512Mi
  # tmpfs shared between containers in the pod
  - name: shared-cache
    emptyDir:
      medium: Memory
      sizeLimit: 2Gi
  # Disk-backed emptyDir (for larger, less critical scratch space)
  - name: model-cache
    emptyDir:
      sizeLimit: 10Gi   # no medium: field = disk-backed
```

### Important: Memory Limits and tmpfs

When a container mounts `emptyDir.medium: Memory`, the tmpfs space counts against the container's memory limit. Writing 1 GiB to a tmpfs volume consumes 1 GiB of the container's memory budget:

```yaml
resources:
  limits:
    memory: "4Gi"   # This must include tmpfs usage
  requests:
    memory: "2Gi"   # Request should account for expected tmpfs usage
```

```bash
# Verify tmpfs is mounted in a running pod
kubectl -n production exec -it tmpfs-demo -- mount -t tmpfs
kubectl -n production exec -it tmpfs-demo -- df -h | grep /tmp/scratch
```

### Kubernetes Ephemeral Storage (Disk-Backed)

For larger scratch spaces that don't need RAM-speed, use disk-backed emptyDir with `sizeLimit`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: build-pod
spec:
  containers:
  - name: builder
    image: builder:latest
    resources:
      requests:
        ephemeral-storage: "2Gi"
      limits:
        ephemeral-storage: "10Gi"
    volumeMounts:
    - name: build-dir
      mountPath: /workspace
  volumes:
  - name: build-dir
    emptyDir:
      sizeLimit: 10Gi   # Enforced by kubelet's disk pressure eviction
```

## Section 6: High-Performance Workloads Using tmpfs

### Database Buffer Pools and WAL

PostgreSQL and MySQL can benefit from placing WAL/redo logs on tmpfs for extreme write throughput in test or staging environments (not production — data is lost on restart):

```bash
# PostgreSQL: place WAL on tmpfs (testing only)
# This gives 10-50x write throughput improvement
mount -t tmpfs -o size=2g tmpfs /var/lib/postgresql/14/main/pg_wal

# In postgresql.conf
wal_level = minimal
synchronous_commit = off   # combined with tmpfs WAL = maximum write speed
```

### Build Systems (CI/CD)

CI pipelines can use tmpfs for intermediate build artifacts:

```bash
# Mount build directory on tmpfs
mount -t tmpfs -o size=8g tmpfs /build

# Docker build with tmpfs bind mount for layer cache
docker build \
  --cache-from type=local,src=/tmp/docker-cache \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t my-image .
```

```yaml
# GitLab CI: use tmpfs for test database
# .gitlab-ci.yml
test:
  services:
  - name: postgres:16
    variables:
      POSTGRES_TMPFS: /var/lib/postgresql/data
  variables:
    POSTGRES_DB: testdb
    POSTGRES_USER: test
    POSTGRES_PASSWORD: test
  script:
  - run_tests
```

### In-Memory Message Queues

```bash
# NATS server with message store on tmpfs (ephemeral/high-throughput)
mkdir -p /mnt/nats-store
mount -t tmpfs -o size=4g tmpfs /mnt/nats-store

# nats-server.conf
jetstream {
  store_dir: "/mnt/nats-store"
  max_mem: 4GB
  max_file: 0   # disable disk; memory only
}
```

## Section 7: Security Considerations

### Hardening /tmp and /var/tmp

Mounting `/tmp` as tmpfs provides security benefits beyond performance:

```bash
# /etc/fstab — hardened /tmp
tmpfs  /tmp  tmpfs  defaults,nodev,nosuid,noexec,size=2g,mode=1777  0 0

# Mount flags:
# nodev  : prevent device files in /tmp (prevents /dev/null escape tricks)
# nosuid : prevent setuid execution from /tmp
# noexec : prevent execution of binaries from /tmp (breaks some installers)
```

The `noexec` flag breaks some legitimate use cases (shell scripts in `/tmp`). Evaluate before enabling in production. Most security benchmarks (CIS, DISA STIG) require `nodev` and `nosuid` at minimum.

### tmpfs for Secrets (Not Enough by Itself)

While tmpfs never writes to disk (unless swapped), it does not encrypt data in memory. For secrets storage:

```bash
# Better: use a dedicated encrypted tmpfs
# Or: use kernel keyring (not visible to /proc/*/mem)
# Or: use hardware security modules

# If you must use tmpfs for secrets:
# 1. Lock the memory pages against swap
# 2. Use mlock() in application code to prevent page-out

# In application (C example — Go equivalent via unix.Mlock)
mlock(secret_buffer, len);
memset(secret_buffer, 0, len);  // zero on cleanup
munlock(secret_buffer, len);
```

### Container Security: /dev/shm Isolation

By default, Docker containers share `/dev/shm` with other containers in the same pod (not the host). To verify isolation:

```bash
# Check that containers have isolated /dev/shm
docker inspect container_id | jq '.[].HostConfig.ShmSize'

# Kubernetes: /dev/shm is per-pod, not shared with host
kubectl -n production exec pod-name -- ls /dev/shm
```

## Section 8: Memory Pressure and Swappiness

tmpfs pages can be swapped out under memory pressure. Control this behavior:

```bash
# View swappiness (0-100; 60 is default; 10 is common for servers)
sysctl vm.swappiness

# Reduce swap tendency to keep tmpfs in RAM
sysctl -w vm.swappiness=10

# Persist
echo "vm.swappiness = 10" > /etc/sysctl.d/99-memory.conf

# Check if tmpfs is being swapped
cat /proc/meminfo | grep -E "SwapUsed|SwapFree|SwapCached"

# Per-process swap usage
smem -s swap -r | head -20
```

### Disabling Swap for tmpfs on Critical Systems

```bash
# Disable swap entirely on systems where tmpfs must never page out
swapoff -a

# Remove swap entries from /etc/fstab
sed -i '/swap/d' /etc/fstab

# For Kubernetes nodes: kubelet requires swap to be disabled
systemctl stop swap.target
systemctl mask swap.target
```

## Section 9: Monitoring tmpfs Usage

```bash
#!/bin/bash
# /usr/local/bin/tmpfs-monitor.sh
echo "=== tmpfs Usage Report ==="
echo "Generated: $(date)"
echo ""

df -h -t tmpfs | while read -r line; do
    echo "${line}"
done

echo ""
echo "=== /dev/shm Detail ==="
ls -la --block-size=1M /dev/shm/ 2>/dev/null | head -20

echo ""
echo "=== Top tmpfs Consumers ==="
du -sh /tmp/* 2>/dev/null | sort -rh | head -10
```

Prometheus node_exporter collects tmpfs metrics automatically:

```promql
# tmpfs filesystem usage
node_filesystem_avail_bytes{fstype="tmpfs"} / node_filesystem_size_bytes{fstype="tmpfs"}

# Alert when /dev/shm is > 80% full
(
  1 - node_filesystem_avail_bytes{mountpoint="/dev/shm"} /
      node_filesystem_size_bytes{mountpoint="/dev/shm"}
) > 0.8

# /tmp usage
node_filesystem_avail_bytes{mountpoint="/tmp"} < 100 * 1024 * 1024   # < 100 MiB free
```

## Section 10: Troubleshooting

### "No space left on device" on tmpfs

```bash
# Check if size limit is hit
df -h /tmp
# Filesystem         Size  Used Avail Use%  Mounted on
# tmpfs              2.0G  2.0G     0  100% /tmp

# Solution 1: runtime resize
mount -o remount,size=4g /tmp

# Solution 2: find and remove large files
du -sh /tmp/* | sort -rh | head -20

# Check inode exhaustion (can also cause ENOSPC)
df -i /tmp
# If inodes are exhausted with space available:
mount -o remount,nr_inodes=0 /tmp  # unlimited inodes
```

### Container OOMKilled Due to tmpfs

A container writing to a Memory-backed emptyDir is effectively consuming its memory limit. If the container OOMKills unexpectedly:

```bash
# Check what's consuming memory
kubectl -n production describe pod tmpfs-demo | grep -A5 "OOM\|Memory"

# Check if the issue is tmpfs
kubectl -n production exec tmpfs-demo -- df -h | grep tmpfs
kubectl -n production exec tmpfs-demo -- cat /proc/meminfo | grep Shmem

# Fix: increase the container's memory limit or reduce tmpfs usage
```

### systemd-tmpfiles Failures

```bash
# Check for configuration errors
systemd-tmpfiles --create 2>&1 | grep -i error

# Test a single file
systemd-tmpfiles --create /etc/tmpfiles.d/myapp.conf

# Watch journal for tmpfiles issues
journalctl -u systemd-tmpfiles-setup.service -f
journalctl -u systemd-tmpfiles-clean.service --since "1 hour ago"
```

## Summary

Linux in-memory filesystems provide a powerful tool for high-performance, ephemeral storage:

- **tmpfs vs ramfs**: always use tmpfs in production — it has size limits, can swap under pressure, and is resizable; ramfs has no upper bound and will OOM a system
- **/dev/shm** is a tmpfs mount for POSIX shared memory; size it to at least the sum of all applications' expected shared memory usage plus 20% headroom
- **systemd-tmpfiles** automates directory creation, ownership, and age-based cleanup — prefer it over custom cron scripts
- **Container tmpfs** via `emptyDir.medium: Memory` on Kubernetes counts against the container's memory limit — always provision memory limits accordingly
- **nodev, nosuid, noexec** on `/tmp` and `/var/tmp` are security baselines; evaluate `noexec` carefully as it can break installer scripts

The combination of properly sized tmpfs mounts, systemd-tmpfiles lifecycle management, and Prometheus alerts on utilization creates a reliable, observable in-memory storage layer for both system services and application workloads.
