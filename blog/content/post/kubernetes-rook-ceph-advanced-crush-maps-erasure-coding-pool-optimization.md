---
title: "Kubernetes Rook-Ceph Advanced: CRUSH Maps, Erasure Coding, and Pool Optimization"
date: 2030-12-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Rook", "Ceph", "Storage", "CRUSH", "Erasure Coding", "BlueStore", "Disaster Recovery"]
categories:
- Kubernetes
- Storage
- Ceph
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Rook-Ceph advanced configuration: custom CRUSH maps for rack and zone awareness, erasure coding profiles, RBD and CephFS performance tuning, OSD placement, BlueStore tuning, and disaster recovery from OSD failures in production Kubernetes environments."
more_link: "yes"
url: "/kubernetes-rook-ceph-advanced-crush-maps-erasure-coding-pool-optimization/"
---

Rook-Ceph is the de facto storage solution for production Kubernetes clusters requiring persistent block and file storage. The default deployment works well for development, but enterprise workloads demand custom CRUSH topologies, erasure coding for space efficiency, and carefully tuned pool configurations. This guide walks through every layer of advanced Rook-Ceph configuration required for production operations.

<!--more-->

# Kubernetes Rook-Ceph Advanced: CRUSH Maps, Erasure Coding, and Pool Optimization

## Section 1: CRUSH Map Architecture and Rack Awareness

The CRUSH (Controlled Replication Under Scalable Hashing) algorithm determines how Ceph distributes data across OSDs. The default CRUSH map places all OSDs in a flat host-based hierarchy, which means three replicas of the same object could land on three OSDs in the same physical rack — a rack failure eliminates all copies.

### Understanding CRUSH Hierarchy

The CRUSH hierarchy defines failure domains. For enterprise deployments, the standard levels are:

```
root
  └── datacenter
        └── room
              └── rack
                    └── host
                          └── osd
```

For Kubernetes deployments, you typically work with at minimum `root > rack > host > osd`.

### Node Labels for CRUSH Topology

Rook-Ceph reads node labels to build the CRUSH map. Label your nodes before deploying:

```bash
# Label nodes with topology information
kubectl label node k8s-node-01 topology.kubernetes.io/zone=us-east-1a
kubectl label node k8s-node-01 topology.rook.io/rack=rack-01

kubectl label node k8s-node-02 topology.kubernetes.io/zone=us-east-1a
kubectl label node k8s-node-02 topology.rook.io/rack=rack-01

kubectl label node k8s-node-03 topology.kubernetes.io/zone=us-east-1b
kubectl label node k8s-node-03 topology.rook.io/rack=rack-02

kubectl label node k8s-node-04 topology.kubernetes.io/zone=us-east-1b
kubectl label node k8s-node-04 topology.rook.io/rack=rack-02

kubectl label node k8s-node-05 topology.kubernetes.io/zone=us-east-1c
kubectl label node k8s-node-05 topology.rook.io/rack=rack-03

kubectl label node k8s-node-06 topology.kubernetes.io/zone=us-east-1c
kubectl label node k8s-node-06 topology.rook.io/rack=rack-03
```

### CephCluster with Topology-Aware CRUSH

```yaml
# ceph-cluster.yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v18.2.0
    allowUnsupported: false
  dataDirHostPath: /var/lib/rook
  skipUpgradeChecks: false
  continueUpgradeAfterChecksEvenIfNotHealthy: false
  mon:
    count: 3
    allowMultiplePerNode: false
  mgr:
    count: 2
    allowMultiplePerNode: false
    modules:
      - name: pg_autoscaler
        enabled: true
      - name: rook
        enabled: true
  dashboard:
    enabled: true
    ssl: true
  monitoring:
    enabled: true
  network:
    provider: host
    selectors:
      public: enp3s0
      cluster: enp4s0
  crashCollector:
    disable: false
  logCollector:
    enabled: true
    periodicity: daily
    maxLogSize: 500M
  cleanupPolicy:
    confirmation: ""
    sanitizeDisks:
      method: quick
      dataSource: zero
      iteration: 1
    allowUninstallWithVolumes: false
  storage:
    useAllNodes: false
    useAllDevices: false
    # Topology spread across racks
    nodes:
      - name: k8s-node-01
        devices:
          - name: sdb
            config:
              deviceClass: ssd
          - name: sdc
            config:
              deviceClass: ssd
      - name: k8s-node-02
        devices:
          - name: sdb
            config:
              deviceClass: ssd
          - name: sdc
            config:
              deviceClass: ssd
      - name: k8s-node-03
        devices:
          - name: sdb
            config:
              deviceClass: hdd
          - name: sdc
            config:
              deviceClass: hdd
      - name: k8s-node-04
        devices:
          - name: sdb
            config:
              deviceClass: hdd
          - name: sdc
            config:
              deviceClass: hdd
      - name: k8s-node-05
        devices:
          - name: sdb
            config:
              deviceClass: nvme
          - name: sdc
            config:
              deviceClass: nvme
      - name: k8s-node-06
        devices:
          - name: sdb
            config:
              deviceClass: nvme
          - name: sdc
            config:
              deviceClass: nvme
  placement:
    all:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: role
                  operator: In
                  values:
                    - storage-node
      tolerations:
        - key: storage-node
          operator: Exists
  priorityClassNames:
    mon: system-node-critical
    osd: system-node-critical
    mgr: system-cluster-critical
  resources:
    mgr:
      limits:
        memory: "2Gi"
      requests:
        cpu: "500m"
        memory: "1Gi"
    mon:
      limits:
        memory: "4Gi"
      requests:
        cpu: "1000m"
        memory: "2Gi"
    osd:
      limits:
        memory: "8Gi"
      requests:
        cpu: "2000m"
        memory: "4Gi"
```

### Custom CRUSH Rules via CephBlockPool

The `failureDomain` field in CephBlockPool controls where Ceph places replicas:

```yaml
# rack-replicated-pool.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool-rack
  namespace: rook-ceph
spec:
  failureDomain: rack
  replicated:
    size: 3
    requireSafeReplicaSize: true
    replicasPerFailureDomain: 1
  deviceClass: ssd
  parameters:
    pg_num: "128"
    pg_num_min: "64"
    pg_autoscale_mode: "on"
    compression_mode: none
    bulk: "false"
```

### Viewing and Modifying the CRUSH Map Directly

For advanced customization, extract and edit the CRUSH map directly:

```bash
# Get a shell in the toolbox pod
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash

# Export the CRUSH map
ceph osd getcrushmap -o /tmp/crushmap.bin
crushtool -d /tmp/crushmap.bin -o /tmp/crushmap.txt

# View the compiled CRUSH map
cat /tmp/crushmap.txt
```

A typical CRUSH map with rack topology looks like:

```
# begin crush map
tunable choose_local_tries 0
tunable choose_local_fallback_tries 0
tunable choose_total_tries 50
tunable chooseleaf_descend_once 1
tunable chooseleaf_vary_r 1
tunable chooseleaf_stable 1
tunable straw_calc_version 1
tunable allowed_bucket_algs 54

# devices
device 0 osd.0 class ssd
device 1 osd.1 class ssd
device 2 osd.2 class hdd
device 3 osd.3 class hdd
device 4 osd.4 class nvme
device 5 osd.5 class nvme

# types
type 0 osd
type 1 host
type 2 rack
type 3 root

# buckets
host k8s-node-01 {
    id -2
    id -3 class ssd
    alg straw2
    hash 0
    item osd.0 weight 1.000
    item osd.1 weight 1.000
}
host k8s-node-02 {
    id -4
    id -5 class ssd
    alg straw2
    hash 0
    item osd.2 weight 1.000
    item osd.3 weight 1.000
}
rack rack-01 {
    id -6
    id -7 class ssd
    alg straw2
    hash 0
    item k8s-node-01 weight 2.000
    item k8s-node-02 weight 2.000
}
root default {
    id -1
    id -8 class ssd
    alg straw2
    hash 0
    item rack-01 weight 4.000
    item rack-02 weight 4.000
    item rack-03 weight 4.000
}

# rules
rule replicated_rule {
    id 0
    type replicated
    min_size 1
    max_size 10
    step take default
    step chooseleaf firstn 0 type rack
    step emit
}
```

To create a custom rule that distributes across racks:

```bash
# Add a custom rack-aware rule
cat >> /tmp/crushmap.txt << 'EOF'
rule rack-replicated {
    id 1
    type replicated
    min_size 1
    max_size 10
    step take default class ssd
    step chooseleaf firstn 0 type rack
    step emit
}
EOF

# Compile and inject the modified CRUSH map
crushtool -c /tmp/crushmap.txt -o /tmp/crushmap-new.bin
ceph osd setcrushmap -i /tmp/crushmap-new.bin

# Verify
ceph osd crush rule list
ceph osd crush rule dump rack-replicated
```

## Section 2: Erasure Coding for Space-Efficient Storage

Erasure coding provides better space efficiency than replication for cold and warm data tiers. A 4+2 erasure coding profile tolerates the loss of any 2 OSDs while using only 1.5x the raw space (versus 3x for three-way replication).

### Erasure Coding Profiles

```bash
# In the toolbox pod
# Create a k=4, m=2 erasure profile (67% storage efficiency)
ceph osd erasure-code-profile set ec-4-2 \
    k=4 \
    m=2 \
    crush-failure-domain=rack \
    crush-device-class=hdd \
    plugin=jerasure \
    technique=reed_sol_van

# Verify the profile
ceph osd erasure-code-profile get ec-4-2

# Create a high-performance profile for NVMe
ceph osd erasure-code-profile set ec-8-3-nvme \
    k=8 \
    m=3 \
    crush-failure-domain=host \
    crush-device-class=nvme \
    plugin=jerasure \
    technique=reed_sol_van

# List profiles
ceph osd erasure-code-profile ls
```

### CephBlockPool with Erasure Coding

Erasure-coded pools cannot directly use RBD (which requires overwrites). You need an EC data pool paired with a replicated metadata pool:

```yaml
# erasure-coded-pools.yaml
---
# Replicated metadata pool (required for EC + RBD)
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: ec-metadata
  namespace: rook-ceph
spec:
  failureDomain: rack
  replicated:
    size: 3
    requireSafeReplicaSize: true
  deviceClass: ssd
  parameters:
    pg_num: "32"
    pg_autoscale_mode: "on"
---
# Erasure coded data pool
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: ec-data
  namespace: rook-ceph
spec:
  failureDomain: rack
  erasureCoded:
    dataChunks: 4
    codingChunks: 2
  deviceClass: hdd
  parameters:
    pg_num: "128"
    pg_autoscale_mode: "on"
    allow_ec_overwrites: "true"
```

### StorageClass for Erasure-Coded RBD

```yaml
# ec-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-rbd-ec
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: ec-metadata
  dataPool: ec-data
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: ext4
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### CephFS with Erasure Coding

CephFS supports erasure-coded data pools natively:

```yaml
# cephfs-ec.yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: cephfs-ec
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
    deviceClass: ssd
    parameters:
      pg_num: "64"
  dataPools:
    - name: replicated
      failureDomain: rack
      replicated:
        size: 3
      deviceClass: ssd
      parameters:
        pg_num: "64"
    - name: ec-data
      failureDomain: rack
      erasureCoded:
        dataChunks: 4
        codingChunks: 2
      deviceClass: hdd
      parameters:
        pg_num: "256"
        allow_ec_overwrites: "true"
  preserveFilesystemOnDelete: true
  metadataServer:
    activeCount: 2
    activeStandby: true
    resources:
      limits:
        memory: "4Gi"
      requests:
        cpu: "1000m"
        memory: "2Gi"
    placement:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
                - key: app
                  operator: In
                  values:
                    - rook-ceph-mds
            topologyKey: kubernetes.io/hostname
```

## Section 3: OSD BlueStore Configuration and Tuning

BlueStore is the default OSD backend since Ceph Luminous. Proper tuning dramatically impacts throughput and latency.

### BlueStore Cache Configuration

```yaml
# osd-config-override.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rook-config-override
  namespace: rook-ceph
data:
  config: |
    [global]
    # Network settings
    ms_type = async+posix
    ms_async_op_threads = 8
    ms_dispatch_throttle_bytes = 104857600

    [osd]
    # BlueStore cache settings (tune per OSD RAM)
    bluestore_cache_size_ssd = 4294967296      # 4GB for SSD OSDs
    bluestore_cache_size_hdd = 1073741824      # 1GB for HDD OSDs
    bluestore_cache_meta_ratio = 0.01
    bluestore_cache_kv_ratio = 0.01

    # BlueStore write behavior
    bluestore_compression_mode = passive        # compress if requested
    bluestore_compression_algorithm = snappy
    bluestore_min_alloc_size_ssd = 4096        # 4K for SSD
    bluestore_min_alloc_size_hdd = 65536       # 64K for HDD

    # Throttle settings
    bluestore_throttle_bytes = 67108864
    bluestore_throttle_deferred_bytes = 134217728

    # RocksDB tuning
    bluestore_rocksdb_options = compression=kNoCompression,max_write_buffer_number=4,min_write_buffer_number_to_merge=1,recycle_log_file_num=4,write_buffer_size=268435456,writable_file_max_buffer_size=0,compaction_readahead_size=2097152

    # OSD operation threads
    osd_op_num_threads_per_shard = 2
    osd_op_num_shards = 8

    # Recovery throttling
    osd_recovery_max_active = 3
    osd_recovery_max_active_ssd = 10
    osd_max_backfills = 2
    osd_recovery_sleep = 0
    osd_recovery_sleep_ssd = 0

    [mon]
    # Monitor settings
    mon_osd_full_ratio = 0.95
    mon_osd_nearfull_ratio = 0.85
    mon_osd_backfillfull_ratio = 0.90
    auth_cluster_required = cephx
    auth_service_required = cephx
    auth_client_required = cephx
```

### Dedicated WAL and DB Devices

For maximum OSD performance, place the BlueStore WAL and DB on fast NVMe devices:

```yaml
# ceph-cluster-with-wal-db.yaml (storage section)
  storage:
    useAllNodes: false
    useAllDevices: false
    nodes:
      - name: k8s-node-01
        devices:
          # Slow HDD OSD with NVMe WAL and DB
          - name: sdb
            config:
              deviceClass: hdd
              walDevice: nvme0n1
              dbDevice: nvme0n1
              walSizeMB: "1024"
              dbSizeMB: "20480"
          - name: sdc
            config:
              deviceClass: hdd
              walDevice: nvme0n1
              dbDevice: nvme0n1
              walSizeMB: "1024"
              dbSizeMB: "20480"
          # NVMe OSD without external WAL/DB (self-contained)
          - name: nvme1n1
            config:
              deviceClass: nvme
```

## Section 4: Pool Optimization and PG Tuning

Placement Group (PG) count directly impacts cluster performance and rebalancing behavior.

### Calculating Optimal PG Count

The general formula: `PG count = (OSDs * 100) / pool_size`, rounded to the nearest power of 2.

```bash
# In the toolbox pod

# Check current PG distribution
ceph osd pool ls detail

# Check PG autoscaler recommendations
ceph osd pool autoscale-status

# For a pool with known target size, set the target
ceph osd pool set replicapool target_size_ratio 0.4

# Manually set PG count for a pool
ceph osd pool set replicapool pg_num 256
ceph osd pool set replicapool pgp_num 256

# Monitor PG peering after changes
watch ceph -s
```

### Pool-Level Compression

```bash
# Enable compression on a specific pool
ceph osd pool set cold-storage compression_mode aggressive
ceph osd pool set cold-storage compression_algorithm zstd
ceph osd pool set cold-storage compression_required_ratio 0.875
ceph osd pool set cold-storage compression_min_blob_size 131072  # 128K

# Verify compression stats
ceph osd pool stats cold-storage
```

### CephBlockPool with QoS

```yaml
# qos-pool.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: high-priority-pool
  namespace: rook-ceph
spec:
  failureDomain: rack
  replicated:
    size: 3
    requireSafeReplicaSize: true
  deviceClass: nvme
  parameters:
    pg_num: "64"
    pg_autoscale_mode: "on"
    # QoS - limit IOPS to prevent noisy neighbors
    rbd_qos_iops_limit: "10000"
    rbd_qos_bps_limit: "1073741824"   # 1GB/s
    rbd_qos_read_iops_limit: "7000"
    rbd_qos_write_iops_limit: "3000"
```

## Section 5: Disaster Recovery from OSD Failures

### Identifying and Responding to Failed OSDs

```bash
# Check cluster health
ceph health detail

# Identify failed OSDs
ceph osd tree | grep -E "(down|out)"

# Check which PGs are affected
ceph pg dump_stuck unclean
ceph pg dump_stuck inactive

# View OSD status
ceph osd stat
ceph osd dump | grep -E "^osd\." | grep -v " up "
```

### OSD Replacement Workflow

```bash
# Step 1: Mark the failed OSD out (if not already)
ceph osd out osd.5

# Step 2: Wait for recovery to complete
watch ceph -s

# Step 3: Remove the OSD from the CRUSH map
ceph osd crush remove osd.5

# Step 4: Remove the OSD auth key
ceph auth del osd.5

# Step 5: Remove the OSD
ceph osd rm osd.5

# Step 6: Delete the OSD deployment in Kubernetes
kubectl -n rook-ceph delete deployment rook-ceph-osd-5

# Step 7: Clean the disk on the node (requires exec into node or direct access)
# On the node directly:
dd if=/dev/zero of=/dev/sdb bs=4096 count=100 oflag=direct

# Step 8: Remove the OSD prepare job
kubectl -n rook-ceph delete job rook-ceph-osd-prepare-k8s-node-03

# Step 9: Trigger OSD re-provisioning by editing the CephCluster
# or by deleting and re-adding the device in the cluster spec
kubectl -n rook-ceph patch cephcluster rook-ceph --type merge \
  -p '{"spec":{"storage":{"nodes":[{"name":"k8s-node-03","devices":[{"name":"sdb"}]}]}}}'
```

### Recovery Monitoring Script

```bash
#!/bin/bash
# osd-recovery-monitor.sh
# Monitor Ceph recovery progress

NAMESPACE="rook-ceph"
TOOLBOX_POD=$(kubectl -n $NAMESPACE get pod -l app=rook-ceph-tools -o name | head -1)

while true; do
    clear
    echo "=== Ceph Recovery Status $(date) ==="
    kubectl -n $NAMESPACE exec $TOOLBOX_POD -- ceph -s

    echo ""
    echo "=== Recovery Progress ==="
    kubectl -n $NAMESPACE exec $TOOLBOX_POD -- ceph progress

    echo ""
    echo "=== Stuck PGs ==="
    kubectl -n $NAMESPACE exec $TOOLBOX_POD -- ceph pg dump_stuck | head -20

    echo ""
    echo "=== OSD Tree ==="
    kubectl -n $NAMESPACE exec $TOOLBOX_POD -- ceph osd tree

    sleep 10
done
```

### Handling Full OSDs

```bash
# When cluster approaches full (default 85% nearfull, 95% full)

# Emergency: temporarily increase full ratio to allow management
ceph osd set-full-ratio 0.97
ceph osd set-nearfull-ratio 0.90

# Delete unnecessary data or PVCs
kubectl delete pvc <unused-pvc-name>

# Identify largest images
ceph rbd -p replicapool ls | while read img; do
    SIZE=$(rbd -p replicapool info $img 2>/dev/null | grep size | awk '{print $2, $3}')
    echo "$img: $SIZE"
done | sort -t: -k2 -rn | head -20

# Add emergency OSDs by adding more nodes/disks
# Then restore normal ratios after cleanup
ceph osd set-full-ratio 0.95
ceph osd set-nearfull-ratio 0.85
```

### Snapshot-Based Disaster Recovery

```yaml
# volume-snapshot-class.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-rbdplugin-snapclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/snapshotter-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/snapshotter-secret-namespace: rook-ceph
deletionPolicy: Delete
```

```yaml
# volume-snapshot.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: db-snapshot-20301211
  namespace: production
spec:
  volumeSnapshotClassName: csi-rbdplugin-snapclass
  source:
    persistentVolumeClaimName: postgres-data
```

```yaml
# restore-from-snapshot.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  storageClassName: ceph-rbd
  dataSource:
    name: db-snapshot-20301211
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

## Section 6: RBD and CephFS Performance Tuning

### RBD Performance Tuning

```yaml
# high-performance-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-rbd-nvme
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: nvme-pool
  imageFormat: "2"
  # RBD image features - keep minimal for maximum compatibility
  imageFeatures: layering,fast-diff,object-map,deep-flatten
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: xfs
  # Mount options for performance
  mounter: rbd
  # Tune RBD client cache
  mapOptions: "lock_on_read,queue_depth=1024"
mountOptions:
  - discard
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### CephFS StorageClass with Tuning

```yaml
# cephfs-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-filesystem
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: cephfs-ec
  pool: cephfs-ec-ec-data
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  kernelMountOptions: "noatime,nodiratime,rsize=1048576,wsize=1048576,readdir_max_bytes=1048576"
mountOptions:
  - discard
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### CSI Driver Tuning

```yaml
# rook-ceph-operator-config.yaml (ConfigMap patch)
apiVersion: v1
kind: ConfigMap
metadata:
  name: rook-ceph-operator-config
  namespace: rook-ceph
data:
  # Parallel provisioning
  CSI_PROVISIONER_REPLICAS: "3"
  # RBD node plugin tuning
  CSI_RBD_GRPC_METRICS_PORT: "9090"
  ROOK_CSI_ENABLE_RBD: "true"
  ROOK_CSI_ENABLE_CEPHFS: "true"
  # Attach/detach timeouts
  CSI_ATTACHER_RECONCILE_PERIOD: "60s"
  # Log level (0=minimal, 5=debug)
  CSI_LOG_LEVEL: "0"
  # Enable RBD map options
  CSI_RBD_MAP_OPTIONS: ""
  # Kernel or FUSE mounter for CephFS
  CSI_CEPHFS_KERNEL_MOUNT_OPTIONS: "ms_mode=crc,recover_session=clean"
```

## Section 7: Monitoring and Alerting

### Prometheus Alerts for Ceph

```yaml
# ceph-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ceph-storage-alerts
  namespace: rook-ceph
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: ceph.rules
      rules:
        - alert: CephClusterNearFull
          expr: ceph_cluster_total_used_bytes / ceph_cluster_total_bytes > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph cluster is near capacity"
            description: "Ceph cluster usage is above 80%. Current: {{ $value | humanizePercentage }}"
            runbook_url: "https://runbooks.support.tools/ceph-near-full"

        - alert: CephClusterFull
          expr: ceph_cluster_total_used_bytes / ceph_cluster_total_bytes > 0.90
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Ceph cluster is full"
            description: "Ceph cluster usage is above 90%. Writes may be blocked."
            runbook_url: "https://runbooks.support.tools/ceph-full"

        - alert: CephOSDDown
          expr: ceph_osd_up == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Ceph OSD {{ $labels.ceph_daemon }} is down"
            description: "OSD {{ $labels.ceph_daemon }} has been down for more than 1 minute."

        - alert: CephOSDNearFull
          expr: ceph_osd_stat_bytes_used / ceph_osd_stat_bytes > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph OSD {{ $labels.ceph_daemon }} is near full"
            description: "OSD {{ $labels.ceph_daemon }} is {{ $value | humanizePercentage }} full."

        - alert: CephMONQuorumAtRisk
          expr: count(ceph_mon_quorum_status == 1) < 3
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Ceph monitor quorum is at risk"
            description: "Only {{ $value }} monitors in quorum. Minimum 3 required."

        - alert: CephPGNotClean
          expr: ceph_pg_total - ceph_pg_clean > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Ceph has unclean PGs"
            description: "{{ $value }} PGs are not in clean state for more than 10 minutes."

        - alert: CephSlowOps
          expr: ceph_osd_op_wip > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph OSD has slow operations"
            description: "OSD {{ $labels.ceph_daemon }} has {{ $value }} operations in progress."
```

## Section 8: Production Operational Checklist

### Pre-Deployment Validation

```bash
#!/bin/bash
# ceph-preflight.sh - Run before deploying to production

NAMESPACE="rook-ceph"
TOOLBOX=$(kubectl -n $NAMESPACE get pod -l app=rook-ceph-tools -o jsonpath='{.items[0].metadata.name}')

echo "=== Ceph Cluster Health ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph health detail

echo ""
echo "=== OSD Tree ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph osd tree

echo ""
echo "=== PG Autoscale Status ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph osd pool autoscale-status

echo ""
echo "=== Pool Statistics ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph df detail

echo ""
echo "=== Cluster IOPS and Throughput ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph osd pool stats

echo ""
echo "=== Slow Requests ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph osd blocked-requests --threshold 30

echo ""
echo "=== MON Status ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph mon stat

echo ""
echo "=== MGR Active ==="
kubectl -n $NAMESPACE exec $TOOLBOX -- ceph mgr stat
```

### Upgrade Procedure

```bash
# Check the current version
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph version

# Update the CephCluster CR with the new image
kubectl -n rook-ceph patch cephcluster rook-ceph --type merge \
  -p '{"spec":{"cephVersion":{"image":"quay.io/ceph/ceph:v18.2.1"}}}'

# Watch the upgrade progress
kubectl -n rook-ceph get pods -w

# Monitor ceph health during upgrade
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- watch ceph -s
```

This advanced guide covers the core building blocks for production-grade Rook-Ceph deployments. The CRUSH map topology ensures data survives rack-level failures, erasure coding reduces storage overhead for cold data tiers, and careful BlueStore tuning extracts maximum performance from your hardware. Combine these with robust monitoring and a rehearsed OSD replacement runbook to maintain a reliable, enterprise-grade storage platform on Kubernetes.
