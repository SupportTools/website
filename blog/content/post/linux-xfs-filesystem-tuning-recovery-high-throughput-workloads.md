---
title: "Linux XFS Filesystem: Tuning and Recovery for High-Throughput Workloads"
date: 2031-01-02T00:00:00-05:00
draft: false
tags: ["Linux", "XFS", "Filesystem", "Performance Tuning", "Kubernetes", "Storage", "Recovery"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to XFS filesystem tuning for high-throughput workloads, covering mount options, log sizing, quota management, xfs_repair procedures, and Kubernetes PV configuration."
more_link: "yes"
url: "/linux-xfs-filesystem-tuning-recovery-high-throughput-workloads/"
---

XFS is the default filesystem for RHEL, CentOS, and Rocky Linux, and it is widely used for database storage, media streaming, and container workloads because of its excellent performance on large files and high-concurrency write workloads. But its default configuration is conservative — the real performance characteristics emerge only after thoughtful tuning. This guide covers XFS internals, mount option optimization, log tuning for write-heavy workloads, quota management, repair procedures, and Kubernetes PV configuration.

<!--more-->

# Linux XFS Filesystem: Tuning and Recovery for High-Throughput Workloads

## Section 1: XFS Architecture Overview

XFS is a journaling filesystem designed for scalability. Understanding its architecture is necessary for effective tuning.

### Allocation Groups

XFS divides a filesystem into multiple Allocation Groups (AGs). Each AG manages its own free space and inode tables independently, allowing parallel I/O operations across multiple threads with no global lock contention.

```bash
# Inspect allocation group configuration
xfs_info /dev/nvme0n1p1

# Example output:
# meta-data=/dev/nvme0n1p1         isize=512    agcount=16, agsize=61036288 blks
#          =                       sectsz=512   attr=2, projid32bit=1
#          =                       crc=1        finobt=1, sparse=1, rmapbt=0
# data     =                       bsize=4096   blocks=976580608, imaxpct=25
#          =                       sunit=0      swidth=0 blks
# naming   =version 2              bsize=4096   ascii-ci=0, ftype=1
# log      =internal log           bsize=4096   blocks=476849, version=2
#          =                       sectsz=512   sunit=0 blks, lazy-count=1
# realtime =none                   extsz=4096   blocks=0, rtextents=0
```

Key parameters:
- **agcount**: Number of allocation groups. More AGs = more parallelism.
- **agsize**: Blocks per AG.
- **isize**: Inode size. 512 bytes supports extended attributes; use 256 only on very space-constrained volumes.
- **crc**: Metadata checksums (XFS v5 feature). Always enabled on modern kernels.

### XFS Journal (Log)

The XFS log records metadata changes before they are written to disk. It is the primary bottleneck for write-heavy workloads. The log can be internal (on the same device) or external (on a dedicated fast device).

## Section 2: mkfs.xfs — Getting the Format Right

Getting the allocation group and log configuration right at format time is critical because many parameters cannot be changed afterward.

```bash
# Production format for a 4TB NVMe SSD used as database storage
# - 16 AGs for parallelism (one per CPU core recommended up to 32)
# - 2048MB log for heavy write workloads
# - 512 byte inodes for extended attribute support
# - RAID stripe unit/width for RAID10 underlying volumes
mkfs.xfs \
  -L "db-data-01" \
  -f \
  -d agcount=16,su=128k,sw=4 \
  -l size=2048m,su=128k \
  -i size=512 \
  /dev/nvme0n1

# For Ceph RBD volumes or cloud block devices with no RAID:
mkfs.xfs \
  -L "cloud-data-01" \
  -f \
  -d agcount=8 \
  -l size=1024m \
  -i size=512 \
  /dev/sdb

# For high-inode workloads (many small files, e.g., container image layers):
mkfs.xfs \
  -L "container-storage" \
  -f \
  -d agcount=16 \
  -l size=512m \
  -i size=512,maxpct=50 \
  /dev/nvme1n1
```

### Stripe Unit and Width for RAID

Incorrect stripe alignment causes split writes that double I/O operations:

```bash
# For RAID10 with 4 disks (2 mirror pairs), 128K stripe unit:
# su = stripe unit (128K)
# sw = stripe width in units = number of data drives = 2
mkfs.xfs -d su=131072,sw=2 /dev/md0

# For RAID5 with 6 disks (5 data + 1 parity):
# su = stripe unit (512K)
# sw = 5 data drives
mkfs.xfs -d su=524288,sw=5 /dev/md1

# Verify alignment after creation:
xfs_info /dev/md0 | grep sunit
```

## Section 3: Mount Options for Production Workloads

Mount options significantly affect performance and data integrity. There is no single optimal set — the right choices depend on workload characteristics.

### The Critical Mount Options

```bash
# /etc/fstab entry for a database volume — optimized for throughput
/dev/nvme0n1  /data/db  xfs  defaults,noatime,nodiratime,logbsize=256k,allocsize=64m,inode64  0 2

# /etc/fstab entry for a write-heavy log volume
/dev/nvme1n1  /data/logs  xfs  defaults,noatime,logbsize=256k,allocsize=1m,largeio  0 2

# /etc/fstab entry for a read-heavy media volume
/dev/sdc1  /data/media  xfs  defaults,noatime,inode64,nodiratime  0 2
```

### Mount Option Reference

| Option | Effect | When to Use |
|---|---|---|
| `noatime` | Disables access time updates on reads | Almost always — eliminates write-on-read |
| `nodiratime` | Disables access time updates on directory reads | Use with `noatime` |
| `logbsize=256k` | Sets log buffer size (32K-256K) | Write-heavy workloads; larger = fewer log flushes |
| `allocsize=64m` | Speculative preallocation size for write-heavy files | Streaming writes, databases, log files |
| `inode64` | Allows inode allocation beyond 2^32 block boundary | Filesystems larger than 1TB |
| `largeio` | Optimizer hint for large sequential I/O | Streaming media, backup workloads |
| `nobarrier` | Disables write barriers (unsafe without battery-backed cache) | Only with BBWC or when data loss is acceptable |
| `swalloc` | Aligns allocation to stripe width | RAID volumes with correct su/sw |
| `discard` | Issues TRIM commands on delete | SSDs and thin-provisioned LUNs |
| `noquota` | Disables all quota processing | Maximizes performance on non-quota volumes |

### Applying Mount Options Without Reboot

```bash
# Remount with new options (some options require unmount/remount)
mount -o remount,noatime,logbsize=256k /data/db

# Verify applied options
mount | grep /data/db
# Output: /dev/nvme0n1 on /data/db type xfs (rw,noatime,attr2,inode64,logbsize=256k,noquota)

# Use /proc/mounts for authoritative list
cat /proc/mounts | grep "/data/db"
```

## Section 4: XFS Log Sizing for Write-Heavy Workloads

The XFS log is the single most important tuning target for write-intensive workloads. Too small and the log fills and stalls; too large and recovery takes minutes after a crash.

### Understanding Log Behavior

The log records metadata operations in circular fashion. When the log fills, XFS must wait for in-memory metadata to be written to disk before new operations can be logged. This produces a characteristic "log congestion" stall pattern.

```bash
# Monitor log traffic in real time
xfs_logprint -t /dev/nvme0n1 2>/dev/null | head -50

# Check log utilization with iostat
iostat -x 1 | grep nvme0n1

# Monitor XFS log congestion via kernel tracing
trace-cmd record -e xfs:xfs_log_done_nonperm &
sleep 30
trace-cmd stop
trace-cmd report | grep xfs_log | head -20
```

### Log Size Guidelines

| Workload Type | Log Size | logbsize |
|---|---|---|
| Light OLTP (< 500 writes/s) | 128MB | 64k |
| Heavy OLTP (500–5000 writes/s) | 512MB–1GB | 256k |
| Time-series / log ingestion | 1GB–2GB | 256k |
| Streaming large file writes | 512MB | 256k |
| Container image layer storage | 256MB | 128k |

```bash
# Check current log configuration
xfs_info /dev/nvme0n1 | grep log

# The log cannot be resized on a mounted filesystem.
# For external log (best for write-heavy workloads):
# Create a dedicated log volume on a fast NVMe device
mkfs.xfs -l logdev=/dev/nvme1n1,size=2048m /dev/sdb

# Mount with external log
mount -o logdev=/dev/nvme1n1 /dev/sdb /data/db
```

### Diagnosing Log Congestion

```bash
# Check for log-related delays in dmesg
dmesg | grep -i "xfs.*log\|xfs.*congestion" | tail -20

# Example of log congestion warning:
# XFS (nvme0n1): xlog_verify_tail_lsn: bad tail lsn, offset 0x0

# Check log write amplification via /proc/fs/xfs/stat
cat /proc/fs/xfs/stat | grep -A2 "log"
# Output:
# xfsstats:
#   xs_log_writes 1234567          <- total log writes
#   xs_log_blocks 4567890          <- total log blocks written
#   xs_log_write_ratio 3.7         <- write amplification

# Monitor via xfs_perf
xfs_perf -n 5 /data/db
```

## Section 5: XFS Quotas

XFS has native project quota support that maps directly to Kubernetes namespace-level storage quotas.

### Types of XFS Quotas

- **User quotas**: Limits per UID.
- **Group quotas**: Limits per GID.
- **Project quotas**: Limits per project ID — used for directory trees, essential for Kubernetes.

### Enabling Quotas

```bash
# /etc/fstab with quota options
/dev/nvme0n1  /data  xfs  defaults,noatime,pquota  0 2

# For user AND project quotas:
/dev/nvme0n1  /data  xfs  defaults,noatime,uquota,pquota  0 2

# Remount to enable (no reboot required on modern kernels):
mount -o remount,pquota /data

# Verify quota is active:
xfs_quota -x -c 'state' /data
# Output:
# User quota state on /data (/dev/nvme0n1)
#   Accounting: OFF
#   Enforcement: OFF
# Project quota state on /data (/dev/nvme0n1)
#   Accounting: ON
#   Enforcement: ON
```

### Project Quota Configuration

```bash
# Step 1: Define project ID and path
echo "100:/data/tenant-a" >> /etc/projects
echo "101:/data/tenant-b" >> /etc/projects

# Step 2: Map project names to IDs
echo "100:tenant-a" >> /etc/projid
echo "101:tenant-b" >> /etc/projid

# Step 3: Initialize project directories
xfs_quota -x -c 'project -s tenant-a' /data
xfs_quota -x -c 'project -s tenant-b' /data

# Step 4: Set hard and soft limits
# Limit tenant-a to 500GB hard, 450GB soft, 0 inode limits
xfs_quota -x -c 'limit -p bsoft=450g bhard=500g tenant-a' /data
xfs_quota -x -c 'limit -p bsoft=450g bhard=500g tenant-b' /data

# Step 5: Set inode limits (important for container workloads)
xfs_quota -x -c 'limit -p isoft=1000000 ihard=1100000 tenant-a' /data

# View current project quotas
xfs_quota -x -c 'report -pbih' /data
# Output:
# Project quota on /data (/dev/nvme0n1)
#                         Blocks                            Inodes
# Project ID   Used       Soft       Hard    Warn/Grace     Used  Soft  Hard Warn/Grace
# tenant-a    102400    471859200  524288000  00 [--------]   1234   1000000 1100000  00 [--------]
```

### Monitoring Quota Usage

```bash
# Check quota for a specific project
xfs_quota -c 'df -h' /data

# Output near a quota limit:
# Filesystem             Size   Used  Avail Use% Pathname
# /dev/nvme0n1           4.0T    3.9T  100.0G  98% /data/tenant-a

# Set up monitoring alert via cron
cat > /usr/local/bin/check-xfs-quotas.sh << 'SCRIPT'
#!/bin/bash
THRESHOLD=90
VOLUME=/data

xfs_quota -c 'report -pb' "$VOLUME" | awk -v threshold="$THRESHOLD" '
NR > 2 && $3 > 0 {
    used=$2; hard=$3
    pct = (used/hard)*100
    if (pct > threshold) {
        printf "WARN: Project %s at %.1f%% quota (%s/%s)\n", $1, pct, $2, $3
    }
}'
SCRIPT
chmod +x /usr/local/bin/check-xfs-quotas.sh
echo "*/15 * * * * root /usr/local/bin/check-xfs-quotas.sh | logger -t xfs-quota" >> /etc/cron.d/xfs-quota-monitor
```

## Section 6: xfs_repair Procedures

When XFS metadata is corrupted (power failure without a UPS, hardware fault, kernel bug), `xfs_repair` reconstructs the metadata structures.

### Before Running xfs_repair

**Critical rules:**
1. **Never run `xfs_repair` on a mounted filesystem.** Unmount it first.
2. **Always save the journal first.** The journal may contain the most recent metadata.
3. **Consider `xfs_check` first** to assess damage severity.

```bash
# Step 1: Unmount (or take offline for root filesystem)
umount /data/db

# If unable to unmount cleanly, remount read-only first:
mount -o remount,ro /data/db
umount /data/db

# Step 2: Replay the journal FIRST using -L (if log is clean)
# This often resolves minor inconsistencies without full repair
xfs_repair -n /dev/nvme0n1  # dry run — check only, no changes

# Review output carefully before proceeding
```

### Running xfs_repair

```bash
# Standard repair with journal replay:
xfs_repair /dev/nvme0n1

# If the log itself is corrupt, clear it and proceed (DATA LOSS RISK):
# Only use -L if you understand that uncommitted transactions will be lost
xfs_repair -L /dev/nvme0n1

# Repair with external log device:
xfs_repair -l /dev/nvme1n1 /dev/sdb

# Verbose output — critical for understanding what was repaired:
xfs_repair -v /dev/nvme0n1 2>&1 | tee /tmp/xfs_repair_output.txt

# Limit repair to specific phase (for investigation):
# Phase 1: Find and verify basic filesystem geometry
# Phase 2: Check inode tree
# Phase 3: Check for duplicate blocks
# Phase 4: Check reference counts
# Phase 5: Check inode links
# Phase 6: Check data and realtime bitmaps
# Phase 7: Verify and correct link counts
xfs_repair -P /dev/nvme0n1  # read-only pass to identify problems
```

### Interpreting xfs_repair Output

```
# Common messages and their meaning:

# SAFE - normal repair activity:
# "resetting inode ... nlinks"  — fixing link count
# "clearing dirty log"          — clearing stale journal entries
# "zeroing log..."              — log was corrupt, clearing it

# CONCERNING — data may be lost:
# "freeing disconnected inode"  — orphaned inode removed
# "clearing inode"              — inode too corrupt to recover
# "discarding entry"            — directory entry pointing to invalid inode

# CRITICAL — significant corruption:
# "bad magic number ... zeroing inode"  — inode completely lost
# "data fork in inode ... bad"          — file data extent map corrupt
```

### Post-Repair Validation

```bash
# Mount read-only and check
mount -o ro /dev/nvme0n1 /mnt/check

# Verify filesystem consistency
xfs_check /dev/nvme0n1  # deprecated but still useful for cross-validation

# Check for orphaned files in lost+found
ls -la /mnt/check/lost+found/

# Run extended read test
dd if=/dev/nvme0n1 of=/dev/null bs=1M status=progress

# Verify application data integrity
# (application-specific — run checksum validation, database consistency checks)
umount /mnt/check

# Mount normally
mount /dev/nvme0n1 /data/db
```

## Section 7: Metadata Integrity and Scrubbing

XFS v5 (introduced in kernel 3.10, default in RHEL 7+) includes metadata checksums and online scrubbing.

### Online Scrubbing with xfs_scrub

```bash
# Run online scrub (filesystem must be mounted)
xfs_scrub /data/db

# Verbose scrub with repair enabled:
xfs_scrub -v -n /data/db  # dry run first

# Run aggressive background scrub:
xfs_scrub -b /data/db  # runs at low priority in background

# Scrub a specific inode range (useful for large filesystems):
xfs_scrub -i 100-200 /data/db

# Automate via systemd timer (comes with xfsprogs 4.15+):
systemctl enable xfs_scrub@data-db.timer
systemctl start xfs_scrub@data-db.timer

# Check timer status:
systemctl status "xfs_scrub@*.timer"
```

### xfs_db for Deep Inspection

```bash
# Inspect specific data structures (read-only mode)
xfs_db -r /dev/nvme0n1

# Within xfs_db interactive mode:
xfs_db> sb 0         # Show superblock 0
xfs_db> agf 0        # Show AG free space header for AG 0
xfs_db> agi 0        # Show AG inode info for AG 0
xfs_db> inode 256    # Show inode 256
xfs_db> fsmap        # Show filesystem map
xfs_db> freesp       # Show free space histogram
xfs_db> quit

# Non-interactive metadata check:
xfs_db -r -c 'sb 0' -c 'print' /dev/nvme0n1 | grep -E "magicnum|blocksize|agcount"
```

## Section 8: Performance Monitoring

```bash
# Real-time XFS statistics from kernel counters
watch -n 1 cat /proc/fs/xfs/stat

# Key metrics in /proc/fs/xfs/stat:
# extent_alloc: extent allocations and frees
# abt:          allocation B-tree operations
# blk_map:      block mapping operations
# bmbt:         B-tree for block mappings
# dir:          directory operations
# trans:        filesystem transaction statistics
# log:          log write statistics
# xstrat:       extent write strategy statistics
# rw:           read/write call statistics
# attr:         extended attribute operations

# Use xfsstats for human-readable output:
xfsstats /data/db

# Monitor I/O patterns with blktrace
blktrace -d /dev/nvme0n1 -o /tmp/nvme0n1-trace &
sleep 30
kill %1
blkparse /tmp/nvme0n1-trace.blktrace.0 | head -100

# Use iostat for block device statistics
iostat -x -h 5 /dev/nvme0n1

# Check for fragmentation
xfs_db -r -c "frag" /dev/nvme0n1
# Output:
# actual 1234567, ideal 987654, fragmentation factor 20.00%
# Note: >20% fragmentation warrants xfs_fsr run
```

### Defragmentation with xfs_fsr

```bash
# Online defragmentation (filesystem must be mounted)
# Run during low-traffic windows
xfs_fsr /data/db

# Defragment a specific file
xfs_fsr /data/db/large-dataset.bin

# Check fragmentation before and after
xfs_db -r -c "frag" /dev/nvme0n1

# Automate weekly defrag (acceptable for HDD; unnecessary for NVMe)
echo "0 2 * * 0 root xfs_fsr /data/db > /var/log/xfs_fsr.log 2>&1" \
  > /etc/cron.d/xfs-defrag
```

## Section 9: Kubernetes XFS PV Configuration

### StorageClass with XFS

```yaml
# storageclass-xfs.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-xfs
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com  # or your CSI driver
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  iopsPerGB: "50"
  throughput: "250"
  fsType: xfs
  # XFS-specific mount options passed to CSI driver
  mountOptions: "noatime,nodiratime,logbsize=256k,allocsize=64m"
reclaimPolicy: Retain
```

### PVC for Database Workloads

```yaml
# pvc-database.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-primary-data
  namespace: databases
  labels:
    app: postgres
    role: primary
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: fast-xfs
  resources:
    requests:
      storage: 2Ti
  volumeMode: Filesystem
```

### StatefulSet with XFS PVCs

```yaml
# postgres-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-primary
  namespace: databases
spec:
  serviceName: postgres-primary
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: primary
  template:
    metadata:
      labels:
        app: postgres
        role: primary
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node.kubernetes.io/disk-type
                operator: In
                values: ["nvme"]
      containers:
      - name: postgres
        image: postgres:16.2
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        resources:
          requests:
            memory: 32Gi
            cpu: "8"
          limits:
            memory: 32Gi
            cpu: "16"
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        - name: postgres-wal
          mountPath: /var/lib/postgresql/wal
      initContainers:
      - name: tune-xfs
        image: busybox:1.36
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          # Verify XFS mount options were applied by CSI driver
          mount | grep /var/lib/postgresql/data
          # Set kernel parameters for PostgreSQL on XFS
          echo deadline > /sys/block/nvme0n1/queue/scheduler 2>/dev/null || true
          echo 4096 > /proc/sys/vm/dirty_writeback_centisecs
          echo 10 > /proc/sys/vm/dirty_ratio
          echo 5 > /proc/sys/vm/dirty_background_ratio
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-xfs
      resources:
        requests:
          storage: 2Ti
  - metadata:
      name: postgres-wal
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-xfs
      resources:
        requests:
          storage: 200Gi
```

### Local PV with XFS for Maximum Performance

For bare-metal clusters where network storage latency is unacceptable:

```yaml
# local-pv-xfs.yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-nvme-xfs-worker-01
  labels:
    storage.kubernetes.io/type: local-nvme-xfs
spec:
  capacity:
    storage: 2Ti
  volumeMode: Filesystem
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-nvme-xfs
  local:
    path: /mnt/nvme-xfs/data
    fsType: xfs
  mountOptions:
  - noatime
  - logbsize=256k
  - allocsize=64m
  - inode64
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values: ["worker-01"]
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme-xfs
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

## Section 10: XFS Kernel Parameters and System Tuning

```bash
# /etc/sysctl.d/99-xfs-performance.conf
# These settings complement XFS mount options

# Increase dirty page ratio for write-heavy workloads
vm.dirty_ratio = 20
vm.dirty_background_ratio = 10

# Increase dirty page timeout (centiseconds)
# Higher values allow more buffering before flush
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500

# Increase readahead for streaming workloads
# (also set per-device: echo 2048 > /sys/block/nvme0n1/queue/read_ahead_kb)
vm.read_ahead_kb = 2048

# Enable huge pages for large database workloads
vm.nr_hugepages = 4096

# I/O scheduler — mq-deadline for NVMe in VMs, none for bare-metal NVMe
# echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
# echo none > /sys/block/nvme0n1/queue/scheduler

# Disable NUMA balancing for database nodes (prevents unexpected migrations)
kernel.numa_balancing = 0

# Apply settings
sysctl -p /etc/sysctl.d/99-xfs-performance.conf
```

### udev Rules for Block Device Tuning

```bash
# /etc/udev/rules.d/60-xfs-nvme.rules
# Apply I/O scheduler settings when NVMe devices are detected
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/read_ahead_kb}="4096"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/nr_requests}="256"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/rq_affinity}="2"

# For SAS/SATA SSDs:
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/read_ahead_kb}="1024"

# Reload udev rules
udevadm control --reload-rules
udevadm trigger
```

## Section 11: Backup and Snapshot Strategies

```bash
# XFS-aware backup using xfsdump (preserves XFS metadata, ACLs, extended attributes)
xfsdump -l 0 -f /backup/db-data-full.dump /data/db

# Incremental dump after full:
xfsdump -l 1 -f /backup/db-data-incr1.dump /data/db

# Restore from dump:
xfsrestore -f /backup/db-data-full.dump /restore/point

# LVM snapshot + xfsdump for online backup:
lvcreate -L 50G -s -n db-data-snap /dev/vg0/db-data
mount -o ro,norecovery /dev/vg0/db-data-snap /mnt/snap
xfsdump -l 0 -f /backup/db-snapshot.dump /mnt/snap
umount /mnt/snap
lvremove -f /dev/vg0/db-data-snap
```

## Summary

XFS performance tuning follows a hierarchy of impact:

1. **Format-time decisions** (agcount, log size, stripe alignment) — highest impact, cannot be changed.
2. **Mount options** (`noatime`, `logbsize`, `allocsize`) — major performance wins, adjustable at runtime.
3. **Kernel parameters** (dirty ratios, I/O scheduler) — complements XFS tuning, applied system-wide.
4. **Quota configuration** — necessary for multi-tenant environments; minimal performance overhead with `pquota`.

For write-heavy workloads, prioritize log sizing and logbsize. For read-heavy or random-access workloads, focus on allocation group count and inode size. For Kubernetes, use the `StorageClass` `mountOptions` field to ensure CSI-provisioned volumes inherit the correct options, and combine with local PVs on NVMe hardware for latency-sensitive databases.
