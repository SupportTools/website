---
title: "Kubernetes Persistent Volume Performance: Storage Classes and CSI Tuning"
date: 2029-04-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "CSI", "StorageClass", "Performance", "EBS", "Tuning"]
categories: ["Kubernetes", "Storage", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes Persistent Volume performance tuning: StorageClass parameters, CSI driver configuration, volume mount options, filesystem tuning for ext4/xfs, fio benchmarking, and cloud-specific optimizations for EBS and GCE PD."
more_link: "yes"
url: "/kubernetes-persistent-volume-performance-storage-classes-csi-tuning/"
---

Storage performance is one of the most overlooked aspects of Kubernetes deployments. Stateful workloads — databases, message queues, search indexes — depend on low-latency, high-throughput I/O, yet most teams deploy with default StorageClass parameters and wonder why their PostgreSQL instance lags. This guide covers the full stack: StorageClass design, CSI driver knobs, mount options, filesystem tuning, benchmark methodology, and cloud-provider-specific optimizations for AWS EBS and GCE Persistent Disk.

<!--more-->

# Kubernetes Persistent Volume Performance: Storage Classes and CSI Tuning

## Section 1: Understanding the I/O Stack

Every read and write from a Pod traverses a layered stack before reaching physical media:

```
Pod process
  └─ glibc / language runtime buffering
      └─ Linux VFS (virtual filesystem)
          └─ ext4 / xfs filesystem layer
              └─ block device driver (dm, md, nvme)
                  └─ CSI node plugin (bind-mount or block device)
                      └─ cloud provider volume (EBS, GCE PD, etc.)
```

Tuning any single layer in isolation yields marginal gains. The goal is to remove bottlenecks at each layer so that the workload reaches the limits of the underlying hardware. Understanding where latency originates requires baseline measurement before any changes.

### Key I/O Metrics

| Metric | Tool | What it reveals |
|---|---|---|
| IOPS | fio, iostat | Parallelism ceiling |
| Throughput (MB/s) | fio, dd | Bandwidth ceiling |
| Latency (p50/p99) | fio, ioping | Tail behavior |
| Queue depth | iostat -x | Saturation point |
| Await time | iostat | Combined service + wait time |

## Section 2: StorageClass Design Principles

A StorageClass is not merely a provisioner reference — it encodes the I/O contract between a workload and its storage backend. Parameters vary by CSI driver, but the principles are universal.

### Anatomy of a StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-performance
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "16000"
  throughput: "1000"
  fsType: ext4
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - discard
```

### Critical StorageClass Parameters

**`volumeBindingMode: WaitForFirstConsumer`**

This is essential for multi-AZ clusters. Immediate binding provisions the volume before the Pod is scheduled, potentially in a different AZ. WaitForFirstConsumer defers provisioning until the scheduler selects a node, ensuring the volume and node are in the same AZ.

```yaml
# Anti-pattern: volume provisioned in us-east-1a, Pod scheduled to us-east-1b
volumeBindingMode: Immediate  # Do not use in multi-AZ clusters

# Correct
volumeBindingMode: WaitForFirstConsumer
```

**`reclaimPolicy: Retain`**

For production databases, always use Retain. Delete causes the underlying volume to be destroyed when the PVC is removed, which creates a catastrophic failure mode during accidental namespace deletion or operator bugs.

```yaml
reclaimPolicy: Retain   # Safe for production
reclaimPolicy: Delete   # Convenient but dangerous for stateful workloads
```

### Tiered StorageClass Architecture

A well-structured cluster defines multiple StorageClasses representing distinct performance tiers:

```yaml
# Tier 1: High-performance NVMe for OLTP databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nvme-database
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iops: "64000"
  throughput: "1000"
  fsType: xfs
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - discard
  - largeio
---
# Tier 2: Balanced general-purpose for most workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  fsType: ext4
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
---
# Tier 3: Throughput-optimized for analytics/logging
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: st1-analytics
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: st1
  fsType: xfs
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - largeio
  - inode64
```

## Section 3: CSI Driver Tuning

### AWS EBS CSI Driver

The AWS EBS CSI driver (`ebs.csi.aws.com`) exposes several tuning parameters beyond the basic `type` parameter.

**Installation with performance-tuned values:**

```yaml
# values.yaml for aws-ebs-csi-driver Helm chart
controller:
  extraVolumeTags:
    Environment: production
    ManagedBy: helm
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

node:
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  # Enable NVMe volume attachment (io2 Block Express)
  enableMetrics: true

# Volume modification feature: allows changing IOPS/throughput without detach
enableVolumeModification: true
```

**EBS volume type selection matrix:**

| Volume Type | Max IOPS | Max Throughput | Use Case |
|---|---|---|---|
| gp3 | 16,000 | 1,000 MB/s | General purpose, cost-effective |
| io2 | 64,000 | 1,000 MB/s | High-performance OLTP |
| io2 Block Express | 256,000 | 4,000 MB/s | Mission-critical databases |
| st1 | 500 | 500 MB/s | Sequential read/write, analytics |
| sc1 | 250 | 250 MB/s | Cold data, infrequent access |

**Dynamic IOPS provisioning with StorageClass:**

```yaml
# StorageClass that provisions gp3 with maximum allowed IOPS
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-max
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  # gp3 allows up to 500 IOPS per GB, max 16,000
  iops: "16000"
  throughput: "1000"
  fsType: xfs
  blockExpress: "false"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-example"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - discard
  - inode64
  - allocsize=128k
```

### GCE Persistent Disk CSI Driver

The GCE PD CSI driver (`pd.csi.storage.gke.io`) supports similar tiering:

```yaml
# High-performance SSD for databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: pd-ssd-high-perf
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  replication-type: none   # or regional-pd for HA
  disk-encryption-kms-key: projects/my-project/locations/us-central1/keyRings/my-ring/cryptoKeys/my-key
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - discard
---
# Hyperdisk Extreme for maximum IOPS (GKE 1.28+)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: hyperdisk-extreme
provisioner: pd.csi.storage.gke.io
parameters:
  type: hyperdisk-extreme
  provisioned-iops-on-create: "80000"
  provisioned-throughput-on-create: "2400Mi"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - discard
```

### Longhorn CSI Driver Tuning

For on-premise clusters using Longhorn:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-fast
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "2"       # Balance HA vs write amplification
  staleReplicaTimeout: "2880"
  fromBackup: ""
  # Data locality: best-effort keeps replica on same node as Pod
  dataLocality: best-effort
  # Disable auto-healing during peak hours via annotation
  recurringJobSelector: '[{"name":"snap-daily","isGroup":false}]'
  diskSelector: nvme         # Pin to NVMe disk via node tag
  nodeSelector: storage-fast # Pin to fast-storage-labeled nodes
  migratable: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
```

## Section 4: Volume Mount Options

Mount options are passed directly to the Linux `mount` syscall and can significantly impact I/O behavior. They are specified at the StorageClass level and applied uniformly to all volumes provisioned from that class.

### Universal Performance Mount Options

```bash
# The most impactful universal mount options
noatime          # Do not update access time on reads (major win for read-heavy workloads)
nodiratime       # Do not update directory access time
relatime         # Compromise: update atime only if newer than mtime (kernel default)
discard          # Enable TRIM for SSDs (send discard commands on block free)
```

### ext4-Specific Mount Options

```bash
# For ext4 filesystems
data=writeback   # Fastest mode: metadata journaled, data not
                 # WARNING: can cause data corruption on crash for some workloads
data=ordered     # Default: data written before metadata (safe, reasonable performance)
barrier=0        # Disable write barriers (dangerous, only for battery-backed storage)
commit=60        # Increase journal commit interval (default 5s, trade durability for speed)
nodelalloc       # Disable delayed allocation (reduces fragmentation for databases)
```

### xfs-Specific Mount Options

```bash
# For xfs filesystems (recommended for databases)
nobarrier        # Disable write barriers (only safe with battery-backed cache)
allocsize=128k   # Increase speculative preallocation unit
inode64          # Allow inode allocation across full filesystem (essential for large filesystems)
largeio          # Use large I/O requests for better sequential performance
swalloc          # Allocate blocks in stripe units
logbsize=256k    # Increase log buffer size for write-heavy workloads
```

### Complete Production StorageClass with Tuned Mount Options

```yaml
# Production xfs StorageClass for PostgreSQL
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: postgres-storage
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "12000"
  throughput: "750"
  fsType: xfs
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
mountOptions:
  - noatime
  - nodiratime
  - discard
  - allocsize=128k
  - inode64
  - largeio
```

## Section 5: Filesystem Tuning

### Choosing ext4 vs xfs

| Criterion | ext4 | xfs |
|---|---|---|
| Metadata-heavy workloads | Better | Worse (larger metadata overhead) |
| Large files (>1GB) | Good | Excellent (64-bit block numbers) |
| Parallel writes | Moderate | Excellent (per-AG locking) |
| Database WAL | Good | Excellent |
| Maximum filesystem size | 1 EiB | 8 EiB |
| Delayed allocation | Yes | Yes |
| Online resize | Grow only | Grow only |
| Recommended for | General use | Databases, large files |

### ext4 Tuning via mkfs Options

The CSI driver calls mkfs when a volume is first formatted. Some drivers allow passing mkfs options via annotations or StorageClass parameters:

```yaml
# AWS EBS CSI allows custom mkfs options via annotation on PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  annotations:
    # Pass custom mkfs options (driver-specific support)
    ebs.csi.aws.com/fs-options: "-E lazy_itable_init=0,lazy_journal_init=0 -O has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3-standard
  resources:
    requests:
      storage: 100Gi
```

### Post-Mount Filesystem Tuning via InitContainer

Since CSI drivers format volumes before first mount, use an initContainer to apply filesystem-level tuning after mount:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      initContainers:
      - name: tune-filesystem
        image: busybox:1.36
        securityContext:
          privileged: true
        command:
        - sh
        - -c
        - |
          set -e
          DEVICE=$(findmnt -n -o SOURCE /data)
          echo "Tuning device: $DEVICE"

          # Set readahead to 256 sectors (128KB) for database workloads
          # Default is often 128 or 256 but varies by driver
          blockdev --setra 256 "$DEVICE"

          # For ext4: tune2fs adjustments (safe to run on live filesystem)
          if tune2fs -l "$DEVICE" 2>/dev/null | grep -q "^Filesystem magic"; then
            # Reduce reserved block percentage from 5% to 1% for data volumes
            tune2fs -m 1 "$DEVICE"
            # Set max mount count to avoid periodic fsck
            tune2fs -c 0 -i 0 "$DEVICE"
          fi

          echo "Filesystem tuning complete"
        volumeMounts:
        - name: data
          mountPath: /data
      containers:
      - name: postgres
        image: postgres:16
        env:
        - name: PGDATA
          value: /data/pgdata
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: postgres-storage
      resources:
        requests:
          storage: 200Gi
```

### Readahead Tuning

Readahead prefetches sequential data, dramatically improving throughput for sequential I/O. The optimal value depends on the access pattern:

```bash
# Check current readahead (in 512-byte sectors)
blockdev --getra /dev/nvme1n1

# Set readahead to 2MB (4096 sectors) for analytics/sequential workloads
blockdev --setra 4096 /dev/nvme1n1

# Set readahead to 128KB (256 sectors) for OLTP/random I/O
blockdev --setra 256 /dev/nvme1n1

# Disable readahead for pure random I/O workloads (e.g., key-value stores)
blockdev --setra 0 /dev/nvme1n1
```

**Persistent readahead via udev rule (applied at node level with DaemonSet):**

```bash
# /etc/udev/rules.d/60-readahead.rules
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{bdi/read_ahead_kb}="128"
ACTION=="add|change", KERNEL=="xvd[a-z]*", ATTR{bdi/read_ahead_kb}="256"
```

```yaml
# DaemonSet to apply tuning at node level
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: storage-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: storage-tuner
  template:
    metadata:
      labels:
        app: storage-tuner
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
      - operator: Exists
      initContainers:
      - name: tune
        image: busybox:1.36
        securityContext:
          privileged: true
        command:
        - sh
        - -c
        - |
          # Tune all NVMe devices
          for dev in /sys/block/nvme*n*/queue/read_ahead_kb; do
            echo 128 > "$dev" 2>/dev/null || true
          done
          # Tune scheduler to none/mq-deadline for NVMe
          for dev in /sys/block/nvme*n*/queue/scheduler; do
            echo "none" > "$dev" 2>/dev/null || \
            echo "mq-deadline" > "$dev" 2>/dev/null || true
          done
          echo "Node storage tuning complete"
      containers:
      - name: pause
        image: gcr.io/google-containers/pause:3.9
```

## Section 6: Benchmarking with fio

fio (Flexible I/O Tester) is the standard tool for characterizing storage performance. Always benchmark before and after any tuning change.

### fio Job Files for Common Patterns

```ini
# random-read.fio — OLTP random read simulation
[global]
ioengine=libaio
iodepth=32
direct=1
numjobs=4
size=8g
time_based
runtime=60
group_reporting

[random-read]
rw=randread
bs=4k
filename=/data/fio-test

# random-write.fio — OLTP random write simulation
[global]
ioengine=libaio
iodepth=32
direct=1
numjobs=4
size=8g
time_based
runtime=60
group_reporting

[random-write]
rw=randwrite
bs=4k
filename=/data/fio-test

# sequential-read.fio — Analytics / data warehouse
[global]
ioengine=libaio
iodepth=8
direct=1
numjobs=2
size=16g
time_based
runtime=60
group_reporting

[seq-read]
rw=read
bs=1m
filename=/data/fio-test

# mixed-rw.fio — Typical database mixed workload
[global]
ioengine=libaio
iodepth=64
direct=1
numjobs=8
size=8g
time_based
runtime=60
group_reporting

[mixed]
rw=randrw
rwmixread=70
bs=4k
filename=/data/fio-test
```

### Running fio in a Kubernetes Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: fio-benchmark
  namespace: default
spec:
  restartPolicy: Never
  containers:
  - name: fio
    image: nixery.dev/fio
    command:
    - sh
    - -c
    - |
      echo "=== Random Read IOPS ==="
      fio --name=randread --ioengine=libaio --iodepth=32 \
          --rw=randread --bs=4k --direct=1 --numjobs=4 \
          --size=4g --runtime=60 --time_based --group_reporting \
          --filename=/data/testfile --output-format=json \
          | python3 -c "
      import json, sys
      data = json.load(sys.stdin)
      job = data['jobs'][0]
      print(f'IOPS: {job[\"read\"][\"iops\"]:.0f}')
      print(f'BW: {job[\"read\"][\"bw_bytes\"]/1024/1024:.1f} MB/s')
      print(f'lat p50: {job[\"read\"][\"lat_ns\"][\"percentile\"][\"50.000000\"]/1000:.0f} us')
      print(f'lat p99: {job[\"read\"][\"lat_ns\"][\"percentile\"][\"99.000000\"]/1000:.0f} us')
      print(f'lat p999: {job[\"read\"][\"lat_ns\"][\"percentile\"][\"99.900000\"]/1000:.0f} us')
      "

      echo "=== Sequential Read Throughput ==="
      fio --name=seqread --ioengine=libaio --iodepth=8 \
          --rw=read --bs=1m --direct=1 --numjobs=2 \
          --size=4g --runtime=60 --time_based --group_reporting \
          --filename=/data/testfile --output-format=terse \
          | awk -F';' '{printf "Throughput: %.1f MB/s\n", $6/1024}'

      echo "Done"
    volumeMounts:
    - name: test-volume
      mountPath: /data
  volumes:
  - name: test-volume
    persistentVolumeClaim:
      claimName: fio-test-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fio-test-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3-performance
  resources:
    requests:
      storage: 20Gi
```

### Interpreting fio Results

```
# Sample output for gp3 with 3000 IOPS (baseline, no tuning):
IOPS: 2987
BW: 11.7 MB/s
lat p50: 8,423 us
lat p99: 22,341 us
lat p999: 35,102 us

# After tuning to 16000 IOPS with xfs + noatime + iodepth=32:
IOPS: 15,891
BW: 62.1 MB/s
lat p50: 1,204 us
lat p99: 4,892 us
lat p999: 8,103 us
```

Key observations when analyzing results:
- p99 latency more than 2x p50 indicates queue saturation — reduce `iodepth` or increase IOPS provisioning
- BW significantly below `IOPS * block_size` indicates CPU overhead — check kernel scheduler setting
- IOPS ceiling exactly matching provisioned value indicates provisioning limit, not drive capability

## Section 7: I/O Scheduler Tuning

The Linux I/O scheduler determines how kernel queues and dispatches I/O requests. For cloud-attached block devices (NVMe-backed EBS, GCE PD), the optimal scheduler is `none` or `mq-deadline`.

```bash
# Check current scheduler for a device
cat /sys/block/nvme1n1/queue/scheduler
# Output: [none] mq-deadline kyber bfq

# Set to none (best for NVMe with hardware queue management)
echo none > /sys/block/nvme1n1/queue/scheduler

# Set queue depth (nr_requests) — increase for high-IOPS volumes
cat /sys/block/nvme1n1/queue/nr_requests
# Default: 256
echo 1024 > /sys/block/nvme1n1/queue/nr_requests
```

Apply via DaemonSet for Kubernetes nodes:

```yaml
# Patch to the storage-tuner DaemonSet initContainer
command:
- sh
- -c
- |
  for dev in /sys/block/nvme*n*; do
    devname=$(basename "$dev")
    # Set scheduler
    echo "none" > "$dev/queue/scheduler" 2>/dev/null || \
    echo "mq-deadline" > "$dev/queue/scheduler" 2>/dev/null
    # Increase queue depth
    echo 1024 > "$dev/queue/nr_requests" 2>/dev/null || true
    # Increase read-ahead for sequential access patterns
    echo 128 > "$dev/queue/read_ahead_kb" 2>/dev/null || true
    echo "Tuned $devname: scheduler=$(cat $dev/queue/scheduler)"
  done
```

## Section 8: PVC Resource Requests and Access Modes

### Access Mode Selection

```yaml
# ReadWriteOnce (RWO): Single node read/write — for most stateful workloads
accessModes:
  - ReadWriteOnce

# ReadWriteOncePod (RWOP): Single Pod read/write — Kubernetes 1.22+, strictest isolation
accessModes:
  - ReadWriteOncePod

# ReadOnlyMany (ROX): Multiple nodes read-only — for shared config/assets
accessModes:
  - ReadOnlyMany

# ReadWriteMany (RWX): Multiple nodes read/write — requires NFS/CephFS/Longhorn
accessModes:
  - ReadWriteMany
```

### Volume Size and IOPS Relationship

On gp3, IOPS and throughput are decoupled from size. On gp2 (legacy), IOPS scale at 3 IOPS/GB with a minimum of 100:

```python
# gp2 IOPS calculation
def gp2_iops(size_gb):
    baseline = 100
    burst_threshold = 1000  # volumes below this can burst to 3000
    return max(baseline, min(16000, size_gb * 3))

# gp3: flat rate, independent of size
def gp3_iops(provisioned_iops=3000):
    return min(16000, max(3000, provisioned_iops))
```

This means migrating from gp2 to gp3 often provides the same IOPS at lower cost, since you no longer need to over-provision size to get IOPS.

## Section 9: Monitoring Storage Performance

### Prometheus Metrics for CSI

The EBS CSI driver exposes metrics on port 3301:

```yaml
# ServiceMonitor for EBS CSI controller
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ebs-csi-controller
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: aws-ebs-csi-driver
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key Prometheus queries for storage health:

```promql
# Volume attach/detach latency
histogram_quantile(0.99,
  rate(storage_operation_duration_seconds_bucket{
    operation_name=~"volume_attach|volume_detach"
  }[5m])
)

# Failed storage operations rate
rate(storage_operation_errors_total[5m])

# Node disk I/O wait (from node_exporter)
rate(node_disk_io_time_seconds_total{device=~"nvme.*"}[5m])

# Disk queue length
rate(node_disk_reads_completed_total[5m]) + rate(node_disk_writes_completed_total[5m])
```

### Grafana Dashboard Queries

```promql
# IOPS per volume (requires node_exporter)
rate(node_disk_reads_completed_total{device="nvme1n1"}[1m]) +
rate(node_disk_writes_completed_total{device="nvme1n1"}[1m])

# I/O latency (milliseconds)
(
  rate(node_disk_read_time_seconds_total{device="nvme1n1"}[1m]) /
  rate(node_disk_reads_completed_total{device="nvme1n1"}[1m])
) * 1000

# Throughput (MB/s)
(
  rate(node_disk_read_bytes_total{device="nvme1n1"}[1m]) +
  rate(node_disk_written_bytes_total{device="nvme1n1"}[1m])
) / 1024 / 1024
```

## Section 10: Common Performance Anti-Patterns

### Anti-Pattern 1: Using the Default StorageClass for All Workloads

The default StorageClass is intentionally generic. A Redis instance and a PostgreSQL cluster have radically different I/O profiles. Define workload-specific StorageClasses and specify them explicitly in StatefulSet volumeClaimTemplates.

### Anti-Pattern 2: Ignoring `volumeBindingMode`

In production multi-AZ clusters, Immediate binding causes cross-AZ I/O, which adds 1-3ms per operation and incurs inter-AZ data transfer costs. Always use WaitForFirstConsumer.

### Anti-Pattern 3: Forgetting `noatime`

Every file read triggers a metadata write to update the access time. For read-heavy workloads, this doubles the write IOPS consumed. The `noatime` mount option eliminates this entirely.

### Anti-Pattern 4: Using a Single Large Volume Instead of Multiple Smaller Ones

Cloud block storage has per-volume IOPS and throughput limits. For workloads that exceed per-volume limits, stripe across multiple volumes using software RAID or database tablespace distribution.

```bash
# Create RAID-0 stripe across 4 gp3 volumes for 4x IOPS
mdadm --create /dev/md0 --level=0 --raid-devices=4 \
  /dev/nvme1n1 /dev/nvme2n1 /dev/nvme3n1 /dev/nvme4n1

# Format and mount
mkfs.xfs -f /dev/md0
mount -o noatime,nodiratime,inode64 /dev/md0 /data
```

### Anti-Pattern 5: Not Benchmarking Before and After

Tuning without measurement is guessing. Always establish a baseline with fio before making changes, and verify improvements are real and not within noise bounds. Run each benchmark at least three times to account for variance.

## Conclusion

Kubernetes storage performance is a multi-layer concern. The StorageClass encodes the performance contract, CSI driver parameters control provisioning, mount options affect VFS behavior, and filesystem tuning determines on-disk efficiency. Combine all layers — provision the right volume type with appropriate IOPS, use xfs for databases, apply noatime, tune readahead for the access pattern, and set the I/O scheduler to none for NVMe — and measure the results with fio to confirm gains.

The investments in storage tuning compound: a 50% reduction in I/O latency can translate to a 2-3x improvement in database query throughput without any application changes.
