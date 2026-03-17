---
title: "Linux Ceph Storage: RADOS, RBD, and CephFS Architecture"
date: 2029-11-09T00:00:00-05:00
draft: false
tags: ["Ceph", "Storage", "Linux", "RADOS", "RBD", "CephFS", "Kubernetes", "Rook"]
categories:
- Storage
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Ceph distributed storage architecture: CRUSH algorithm, OSD placement groups, RBD block device, CephFS MDS, Kubernetes Rook-Ceph operator deployment, and SSD/NVMe performance tuning."
more_link: "yes"
url: "/linux-ceph-storage-rados-rbd-cephfs-architecture/"
---

Ceph is the industry-standard open-source distributed storage system for Linux infrastructure. Understanding its architecture is fundamental to running it reliably - from the CRUSH algorithm that determines data placement without a central lookup table, to the placement groups that control parallelism, to the MDS daemons that enable POSIX-compliant distributed filesystems. This post covers Ceph internals and practical production tuning.

<!--more-->

# Linux Ceph Storage: RADOS, RBD, and CephFS Architecture

## RADOS: The Reliable Autonomic Distributed Object Store

Every Ceph abstraction (block devices, filesystems, object storage) sits atop RADOS - the distributed object store that handles replication, consistency, and recovery.

### Core Components

| Component | Role |
|-----------|------|
| OSD (Object Storage Daemon) | One per disk, stores objects, participates in replication |
| Monitor (MON) | Maintains cluster maps (OSD map, CRUSH map, etc.) |
| Manager (MGR) | Metrics, dashboard, orchestration modules |
| MDS (Metadata Server) | CephFS metadata (not needed for RBD/S3) |

### The CRUSH Algorithm

CRUSH (Controlled Replication Under Scalable Hashing) is a deterministic pseudo-random function that maps object names to OSDs without requiring a central lookup table. Any client or OSD can compute the placement independently.

```
Object placement in three steps:

1. Hash the object name to get a placement group (PG):
   pg_id = hash(object_name) % num_pgs

2. Apply CRUSH to map pg_id to a list of OSDs:
   osd_list = CRUSH(pg_id, crush_map, crush_rule)

3. Primary OSD (osd_list[0]) handles client I/O;
   replicas (osd_list[1], osd_list[2]) receive copies
```

The CRUSH map encodes the physical topology:

```bash
# Extract the CRUSH map
ceph osd getcrushmap -o crushmap.bin
crushtool -d crushmap.bin -o crushmap.txt
cat crushmap.txt
```

```
# crushmap.txt example
# devices
device 0 osd.0 class ssd
device 1 osd.1 class ssd
device 2 osd.2 class hdd
device 3 osd.3 class hdd

# types
type 0 osd
type 1 host
type 2 rack
type 3 datacenter

# buckets (topology)
host node1 {
    id -2
    alg straw2
    hash 0
    item osd.0 weight 1.000
    item osd.1 weight 1.000
}

host node2 {
    id -3
    alg straw2
    hash 0
    item osd.2 weight 2.000
    item osd.3 weight 2.000
}

rack rack1 {
    id -4
    alg straw2
    hash 0
    item node1 weight 2.000
    item node2 weight 4.000
}

root default {
    id -1
    alg straw2
    hash 0
    item rack1 weight 6.000
}

# rules (placement policies)
rule replicated_rule {
    id 0
    type replicated
    min_size 1
    max_size 10
    step take default
    step chooseleaf firstn 0 type host
    step emit
}

rule ssd_rule {
    id 1
    type replicated
    min_size 1
    max_size 3
    step take default class ssd
    step chooseleaf firstn 0 type host
    step emit
}
```

```bash
# Modify and apply a CRUSH map
crushtool -c crushmap.txt -o crushmap-new.bin
ceph osd setcrushmap -i crushmap-new.bin

# Simulate placement for an object
crushtool -i crushmap.bin --test --show-mappings \
    --num-rep 3 --rule 0 --min-x 0 --max-x 100

# Show which OSDs hold a specific object
ceph osd map <pool-name> <object-name>
```

### Placement Groups

Placement groups (PGs) are the fundamental unit of data placement and replication management. Each pool has a configurable number of PGs, and each PG is assigned to a set of OSDs via CRUSH.

```bash
# Create a pool with appropriate PG count
# Rule of thumb: target 100-200 PGs per OSD in the pool
# For 12 OSDs, replication factor 3: (100 * 12) / 3 = 400 PGs -> use 512 (power of 2)
ceph osd pool create mypool 512 512

# Set pool application
ceph osd pool application enable mypool rbd

# Set replication factor
ceph osd pool set mypool size 3
ceph osd pool set mypool min_size 2  # Minimum OSDs for I/O

# Calculate recommended PG count
# pgcalc: https://old.ceph.com/pgcalc/
# New autoscaler (Nautilus+): let Ceph manage PG counts
ceph osd pool set mypool pg_autoscale_mode on
ceph osd pool autoscale-status

# View PG distribution
ceph pg dump pgs | awk '{print $1, $15}' | head -20  # pg_id, osd_set

# Check PG state
ceph pg stat
# 512 pgs: 512 active+clean; 1.2 TiB data, 3.6 TiB used

# Detailed PG info
ceph pg 1.0 query
```

### OSD Architecture

Each OSD daemon manages one disk (or a partition). The OSD uses BlueStore as its storage backend since Ceph Luminous:

```bash
# Check OSD BlueStore details
ceph osd metadata 0 | grep -E "osd_objectstore|bluestore"

# BlueStore components:
# - RocksDB: metadata/keys stored on fast device (optionally NVMe)
# - Block device: object data on main storage
# - WAL (Write-Ahead Log): optionally on separate fast device

# Create OSD with separate block.db and WAL on NVMe
ceph-volume lvm create \
    --bluestore \
    --data /dev/sdb \
    --block.db /dev/nvme0n1p1 \
    --block.wal /dev/nvme0n1p2

# View OSD utilization
ceph osd df tree

# OSD performance statistics
ceph osd perf
```

## RBD: RADOS Block Device

RBD provides a block device interface backed by RADOS. It supports thin provisioning, snapshots, clones, and live migration.

### Creating and Using RBD Images

```bash
# Create an RBD image
rbd create --size 10G --image-format 2 --image-feature layering mypool/myimage

# List images
rbd ls mypool

# Get image info
rbd info mypool/myimage

# Map to block device (kernel driver)
sudo rbd map mypool/myimage
# Output: /dev/rbd0

# Format and mount
sudo mkfs.xfs /dev/rbd0
sudo mkdir /mnt/rbd
sudo mount /dev/rbd0 /mnt/rbd

# Unmap
sudo umount /mnt/rbd
sudo rbd unmap /dev/rbd0
```

### RBD Snapshots and Clones

```bash
# Create a snapshot
rbd snap create mypool/myimage@snapshot1

# List snapshots
rbd snap ls mypool/myimage

# Protect snapshot (required before cloning)
rbd snap protect mypool/myimage@snapshot1

# Clone from snapshot (Copy-on-Write)
rbd clone mypool/myimage@snapshot1 mypool/myimage-clone

# Flatten clone (remove dependency on parent)
rbd flatten mypool/myimage-clone

# Rollback to snapshot
rbd snap rollback mypool/myimage@snapshot1

# Delete snapshot
rbd snap unprotect mypool/myimage@snapshot1
rbd snap rm mypool/myimage@snapshot1
```

### RBD Mirroring for Disaster Recovery

```bash
# Enable mirroring on pool (journal mode)
rbd mirror pool enable mypool journal

# Configure peer cluster
rbd mirror pool peer add mypool client.mirror@remote-cluster

# Enable mirroring on specific image
rbd mirror image enable mypool/myimage journal

# Check mirror status
rbd mirror pool status mypool
rbd mirror image status mypool/myimage

# Failover (promote secondary to primary)
# On secondary cluster:
rbd mirror image promote --force mypool/myimage

# Resync after recovery
rbd mirror image resync mypool/myimage
```

## CephFS: Distributed POSIX Filesystem

CephFS stores file metadata in RADOS objects managed by the Metadata Server (MDS) and file data in RADOS objects in a data pool.

### MDS Architecture

```
CephFS Architecture:
┌─────────────┐
│   Client    │
│  (FUSE/KV)  │
└──────┬──────┘
       │ 1. Lookup path → MDS
       │    (metadata: inodes, directories)
       │ 2. Get data object locations
       │ 3. Read/write directly to OSDs
       ▼
┌─────────────┐    ┌─────────────────────┐
│     MDS     │────│   Metadata Pool     │
│  (metadata) │    │   (RADOS objects)   │
└─────────────┘    └─────────────────────┘
                   ┌─────────────────────┐
                   │    Data Pool        │
                   │   (RADOS objects)   │
                   └─────────────────────┘
```

```bash
# Create CephFS
# First create two pools: metadata and data
ceph osd pool create cephfs_metadata 64
ceph osd pool create cephfs_data 512

# Create the filesystem
ceph fs new mycephfs cephfs_metadata cephfs_data

# Check status
ceph fs status mycephfs

# Add standby MDS for HA
ceph fs set mycephfs max_mds 2  # Active-active MDS

# Mount CephFS with kernel driver
sudo mount -t ceph 10.0.0.1:6789,10.0.0.2:6789:/ /mnt/cephfs \
    -o name=admin,secret=$(ceph auth get-key client.admin)

# Mount with FUSE
ceph-fuse /mnt/cephfs -n client.admin

# Persistent mount via fstab
echo "10.0.0.1:6789,10.0.0.2:6789:/ /mnt/cephfs ceph name=admin,secretfile=/etc/ceph/admin.secret,_netdev 0 0" >> /etc/fstab
```

### CephFS Quotas and Layouts

```bash
# Set directory quota
setfattr -n ceph.quota.max_bytes -v 10737418240 /mnt/cephfs/project1  # 10GB
setfattr -n ceph.quota.max_files -v 100000 /mnt/cephfs/project1

# Get quota
getfattr -n ceph.quota.max_bytes /mnt/cephfs/project1

# Set file layout (stripe size, pool, etc.)
setfattr -n ceph.file.layout.stripe_unit -v 4194304 /mnt/cephfs/largefile.dat

# Pin subtree to specific MDS rank
setfattr -n ceph.dir.pin -v 1 /mnt/cephfs/project-a  # Pin to MDS rank 1

# Export CephFS subtree as NFS
ceph mgr module enable nfs
ceph nfs cluster create mycephfs mynfscluster
ceph nfs export create cephfs --cluster-id mynfscluster \
    --pseudo-path /exports/project1 \
    --fsname mycephfs \
    --path /project1
```

## Rook-Ceph: Kubernetes Operator

Rook is the Kubernetes operator that manages Ceph clusters as Kubernetes-native resources.

### Installation

```bash
# Add Rook Helm repo
helm repo add rook-release https://charts.rook.io/release
helm repo update

# Install Rook operator
helm install rook-ceph rook-release/rook-ceph \
    -n rook-ceph --create-namespace \
    --set csi.enableGrpcMetrics=true

# Verify operator is running
kubectl -n rook-ceph get pod -l app=rook-ceph-operator
```

### CephCluster Resource

```yaml
# ceph-cluster.yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v18.2.0   # Reef
    allowUnsupported: false

  dataDirHostPath: /var/lib/rook

  mon:
    count: 3
    allowMultiplePerNode: false
    volumeClaimTemplate:
      spec:
        storageClassName: local-path
        resources:
          requests:
            storage: 10Gi

  mgr:
    count: 2
    allowMultiplePerNode: false
    modules:
    - name: prometheus
      enabled: true
    - name: pg_autoscaler
      enabled: true

  dashboard:
    enabled: true
    ssl: true

  monitoring:
    enabled: true

  network:
    provider: host  # Use host networking for better performance

  storage:
    useAllNodes: true
    useAllDevices: false
    config:
      osdsPerDevice: "1"
    nodes:
    - name: "node1"
      devices:
      - name: "sdb"
        config:
          deviceClass: "hdd"
      - name: "nvme0n1"
        config:
          deviceClass: "nvme"
          metadataDevice: "nvme0n1"
    - name: "node2"
      devices:
      - name: "sdb"
      - name: "sdc"
    - name: "node3"
      devices:
      - name: "sdb"
      - name: "sdc"

  resources:
    mgr:
      limits:
        memory: "1Gi"
      requests:
        cpu: "500m"
        memory: "512Mi"
    mon:
      limits:
        memory: "2Gi"
      requests:
        cpu: "1"
        memory: "1Gi"
    osd:
      limits:
        memory: "4Gi"
      requests:
        cpu: "1"
        memory: "4Gi"

  # Placement for node selection
  placement:
    all:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
          - matchExpressions:
            - key: storage-node
              operator: In
              values:
              - "true"
      tolerations:
      - key: storage-node
        operator: Exists
```

### Storage Class and Block Pools

```yaml
# ceph-blockpool.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  replicated:
    size: 3
    requireSafeReplicaSize: true
  deviceClass: ssd        # Use SSD OSDs only
  enableRBDStats: true
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering,fast-diff,object-map,deep-flatten,exclusive-lock
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  # Performance tuning
  mapOptions: "lock_timeout=15000,read_from_replica=localize"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### CephFS StorageClass

```yaml
# cephfs-storageclass.yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: myfs
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
  dataPools:
  - name: replicated
    replicated:
      size: 3
  preserveFilesystemOnDelete: true
  metadataServer:
    activeCount: 1
    activeStandby: true
    resources:
      limits:
        memory: "4Gi"
      requests:
        cpu: "2"
        memory: "2Gi"
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: myfs
  pool: myfs-replicated
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

## Tuning for SSD and NVMe

### OSD Configuration Tuning

```bash
# ceph.conf tuning for NVMe OSDs
cat >> /etc/ceph/ceph.conf << 'EOF'
[osd]
# BlueStore cache
bluestore_cache_size_ssd = 4294967296       # 4GB for SSD OSDs
bluestore_cache_size_hdd = 1073741824       # 1GB for HDD OSDs

# BlueStore write optimization for NVMe
bluestore_prefer_deferred_size_ssd = 0      # Disable deferred writes on NVMe (fast enough)
bluestore_prefer_deferred_size_hdd = 65536  # 64KB deferred writes on HDD

# Allocation unit for NVMe (match device optimal I/O size)
bluestore_min_alloc_size_ssd = 4096   # 4KB for NVMe
bluestore_min_alloc_size_hdd = 65536  # 64KB for HDD

# OSD op threads
osd_op_num_threads_per_shard_ssd = 2
osd_op_num_shards_ssd = 8

# Async recovery
osd_recovery_sleep_ssd = 0
osd_recovery_max_active_ssd = 5

# Scrub
osd_scrub_sleep = 0
osd_scrub_chunk_min = 5
osd_scrub_chunk_max = 25
EOF
```

### Applying Ceph Configuration via Rook

```yaml
# ceph-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rook-config-override
  namespace: rook-ceph
data:
  config: |
    [global]
    # Network compression
    ms_compress_secure = false
    ms_osd_compress_mode = force

    # Memory target per OSD
    osd_memory_target = 4294967296

    # Client cache
    rbd_cache = true
    rbd_cache_size = 268435456       # 256MB
    rbd_cache_max_dirty = 134217728  # 128MB

    [osd]
    bluestore_cache_size_ssd = 4294967296
    osd_recovery_sleep_ssd = 0
    osd_snap_trim_sleep_ssd = 0

    # Journal write size optimization
    bluestore_prefer_deferred_size_ssd = 0

    # Compression for cold data
    bluestore_compression_algorithm = snappy
    bluestore_compression_mode = passive  # Let client request compression
```

### Pool Configuration for Performance Tiers

```bash
# Create a tiered storage setup
# Fast pool: NVMe replicated for database workloads
ceph osd pool create fast-pool 64
ceph osd pool set fast-pool size 2       # 2-way replication on NVMe
ceph osd crush rule create-replicated nvme-rule default host nvme

ceph osd pool set fast-pool crush_rule nvme-rule

# Slow pool: HDD with erasure coding for bulk storage
ceph osd erasure-code-profile set ec-profile \
    k=4 m=2 crush-failure-domain=host

ceph osd pool create slow-pool 128 128 erasure ec-profile

# Enable RBD on both pools
ceph osd pool application enable fast-pool rbd
ceph osd pool application enable slow-pool rbd

# Create RBD images in appropriate pools
rbd create --size 100G --pool fast-pool database-volume
rbd create --size 5T --pool slow-pool backup-volume
```

### Network Tuning for Ceph

```bash
# Dedicated cluster network for OSD replication (separate from public client network)
# /etc/ceph/ceph.conf
[global]
public network = 10.0.0.0/24     # Client-to-MON and client-to-OSD
cluster network = 192.168.0.0/24  # OSD-to-OSD replication

# TCP tuning for Ceph
cat >> /etc/sysctl.d/99-ceph-network.conf << 'EOF'
# Increase socket buffer sizes
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 67108864
net.core.wmem_default = 67108864
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

# Reduce TCP retransmission timeout for faster failure detection
net.ipv4.tcp_retries2 = 8

# Disable TCP slow start after idle
net.ipv4.tcp_slow_start_after_idle = 0

# Increase connection backlog
net.core.netdev_max_backlog = 50000
net.core.somaxconn = 1024
EOF
sysctl -p /etc/sysctl.d/99-ceph-network.conf
```

## Operations and Monitoring

### Health Checks

```bash
# Overall cluster health
ceph health detail

# Watch cluster status
watch -n2 ceph status

# Check specific issues
ceph health mute OSDMAP_FLAGS
ceph health unmute OSDMAP_FLAGS

# Check OSD status
ceph osd stat
ceph osd tree

# Identify slow OSDs
ceph osd perf | sort -k3 -rn | head -10

# Identify slow PGs
ceph pg dump_stuck | head -20

# IO statistics per pool
ceph osd pool stats
```

### Monitoring with Prometheus

```bash
# Enable Prometheus module
ceph mgr module enable prometheus

# Prometheus target
# http://<mgr-host>:9283/metrics

# Key metrics to alert on:
# ceph_health_status > 0         (unhealthy)
# ceph_osd_in == 0               (OSD not in cluster)
# ceph_osd_up == 0               (OSD down)
# ceph_pg_degraded > 0           (degraded PGs)
# ceph_pg_undersized > 0         (undersized PGs)
# ceph_pool_percent_used > 0.8   (pool over 80% full)
# ceph_osd_apply_latency_ms > 50 (high write latency)
# ceph_osd_commit_latency_ms > 50
```

```yaml
# Prometheus alerting rules for Ceph
groups:
- name: ceph
  rules:
  - alert: CephClusterUnhealthy
    expr: ceph_health_status > 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Ceph cluster is in {{ if eq $value 1.0 }}WARNING{{ else }}ERROR{{ end }} state"

  - alert: CephOSDDown
    expr: ceph_osd_up == 0
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Ceph OSD {{ $labels.ceph_daemon }} is down"

  - alert: CephPoolFull
    expr: ceph_pool_percent_used > 0.85
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Ceph pool {{ $labels.name }} is {{ $value | humanizePercentage }} full"

  - alert: CephOSDHighLatency
    expr: ceph_osd_apply_latency_ms > 100
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Ceph OSD {{ $labels.ceph_daemon }} apply latency {{ $value }}ms"
```

### Capacity Planning

```bash
# Current usage
ceph df

# Per-pool usage
ceph df detail

# Predict when pool will be full
# Get current usage rate and extrapolate
ceph df | awk '/mypool/{print "Used:", $3, "Available:", $4, "Usage%:", $5}'

# CRUSH weight rebalancing
# Adjust OSD weight for capacity (1.0 = 1TB reference)
ceph osd crush reweight osd.5 2.0  # This OSD has a 2TB disk

# Automatically reweight based on utilization
ceph osd reweight-by-utilization 120  # Reweight if OSD >120% average utilization
```

### Recovery Operations

```bash
# Force a specific OSD to be out (for maintenance)
ceph osd out osd.5

# Wait for recovery to complete
watch -n5 'ceph health'

# Mark OSD back in after maintenance
ceph osd in osd.5

# Force data scrubbing
ceph pg deep-scrub <pg-id>

# Repair a specific PG
ceph pg repair <pg-id>

# Check for objects that are not replicated to target
ceph osd pool set mypool size 3  # Ensure size is correct
ceph osd pool set mypool min_size 2

# Emergency: allow I/O even with unhealthy cluster (dangerous)
ceph osd set nodown
ceph osd set noout
# ... perform maintenance ...
ceph osd unset nodown
ceph osd unset noout
```

## Common Issues and Diagnostics

```bash
# OSD filling up - check per-OSD utilization
ceph osd df | sort -k7 -rn | head -5

# NEARFULL or FULL OSDs: rebalance or add capacity
# Temporary: reduce NEARFULL threshold
ceph osd set-nearfull-ratio 0.95

# Slow requests: identify which OSDs have high latency
ceph osd perf

# Check OSD log for slow requests
grep "slow requests" /var/log/ceph/ceph-osd.5.log | tail -20

# Clock skew warnings: sync time
chronyc tracking
chronyc sources

# MDS issues (CephFS)
ceph mds stat
ceph fs status mycephfs

# Kill a stuck MDS
ceph mds fail <gid>

# Remove a failed MDS
ceph mds rm <gid>

# Troubleshoot PG stuck
ceph pg <pg-id> query | jq '.state, .recovery_state'

# Find which client is accessing a specific object
ceph osd map mypool myobject
rados -p mypool stat myobject
```

## Summary

Ceph's architecture is fundamentally designed for scale-out storage without single points of failure. The CRUSH algorithm enables each client to compute object placement independently, eliminating the need for a central metadata server for RBD and S3. Key operational knowledge includes:

- **Placement groups**: PG count should target 100-200 PGs per OSD; use `pg_autoscale_mode` in modern Ceph
- **BlueStore tuning**: Separate RocksDB WAL and block.db onto NVMe for HDD OSD nodes to dramatically improve metadata performance
- **Network separation**: Use dedicated cluster network for OSD replication to isolate client traffic from internal replication
- **Rook-Ceph**: Manages the full Ceph lifecycle as Kubernetes custom resources; use `CephBlockPool` with `deviceClass` to target specific storage tiers
- **Monitoring**: Alert on `ceph_health_status > 0`, pool fullness above 80%, and OSD latency above 100ms

Ceph requires careful initial sizing and tuning, but once configured correctly it provides petabyte-scale distributed storage with no external dependencies.
