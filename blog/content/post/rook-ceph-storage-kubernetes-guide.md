---
title: "Rook-Ceph Distributed Storage on Kubernetes: Block, Object, and Filesystem"
date: 2027-07-26T00:00:00-05:00
draft: false
tags: ["Rook", "Ceph", "Kubernetes", "Storage", "Block Storage"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide for deploying Rook-Ceph on Kubernetes. Covers CephCluster configuration, OSD placement, RBD block storage, S3-compatible object storage, CephFilesystem, CRUSH map tuning, and cluster health management."
more_link: "yes"
url: "/rook-ceph-storage-kubernetes-guide/"
---

Running stateful workloads on Kubernetes requires durable, scalable storage that survives node failures without human intervention. Rook-Ceph provides exactly that: a Kubernetes operator that transforms raw block devices on worker nodes into a fully managed Ceph cluster capable of serving block (RBD), object (S3), and filesystem (CephFS) storage through native Kubernetes primitives. This guide covers every stage of a production deployment, from initial operator installation to CRUSH map optimization and operational procedures.

<!--more-->

## Rook Operator Architecture

Rook translates Kubernetes CRDs into Ceph daemon configuration and lifecycle management. The operator watches for custom resources and reconciles the desired state by managing Ceph daemons as Kubernetes Deployments, DaemonSets, and Jobs.

```
┌─────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  rook-ceph namespace                                  │   │
│  │  ┌──────────────┐  ┌───────────┐  ┌───────────────┐  │   │
│  │  │ Rook Operator│  │ Ceph MONs │  │ Ceph MGR      │  │   │
│  │  │ (Deployment) │  │ (3x Pods) │  │ (1-2x Pods)   │  │   │
│  │  └──────┬───────┘  └───────────┘  └───────────────┘  │   │
│  │         │  Reconciles CephCluster CRD                  │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │ OSDs (one per disk, DaemonSet-managed)            │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ CephBlockPool│  │CephObjectStore│  │ CephFilesystem     │  │
│  │ (StorageClass)│  │ (RGW Pods)  │  │ (MDS Pods)        │  │
│  └────────────┘  └──────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Role |
|---|---|
| MON (Monitor) | Maintains the cluster map; requires quorum (3 or 5) |
| MGR (Manager) | Provides dashboards, metrics, and balancer modules |
| OSD (Object Storage Daemon) | One per disk; stores actual data |
| MDS (Metadata Server) | Required for CephFS; manages directory metadata |
| RGW (RADOS Gateway) | S3/Swift-compatible object storage API |

## Installation

### Node Requirements

Each storage node must meet minimum requirements:

```bash
# Check for raw block devices (unformatted, no filesystem)
lsblk -f | grep -v FSTYPE | grep disk

# Verify kernel modules
modprobe rbd
modprobe ceph

# Check for LVM2 tools (required for OSD provisioning)
which lvm
```

Recommended minimum: 3 storage nodes, each with at least 1 raw NVMe or SSD device, 32 GB RAM, 8 vCPUs.

### Install Rook Operator

```bash
# Clone Rook examples for the target version
git clone --single-branch --branch v1.14.9 https://github.com/rook/rook.git
cd rook/deploy/examples

# Install CRDs
kubectl apply -f crds.yaml

# Install RBAC and common resources
kubectl apply -f common.yaml

# Install the Rook operator
kubectl apply -f operator.yaml

# Verify operator is running
kubectl -n rook-ceph get pod -l app=rook-ceph-operator -w
```

### Taint Storage Nodes (Recommended)

Isolate Ceph daemons on dedicated nodes:

```bash
# Taint the storage nodes
kubectl taint nodes storage-node-1 storage-node-2 storage-node-3 \
  storage=ceph:NoSchedule

# Label nodes
kubectl label nodes storage-node-1 storage-node-2 storage-node-3 \
  role=storage-node ceph=true
```

## CephCluster CRD

The `CephCluster` resource defines the entire cluster topology.

```yaml
# cluster-production.yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v18.2.4
    allowUnsupported: false
  dataDirHostPath: /var/lib/rook
  skipUpgradeChecks: false
  continueUpgradeAfterChecksEvenIfNotHealthy: false
  waitTimeoutForHealthyOSDInMinutes: 10
  mon:
    count: 3
    allowMultiplePerNode: false
  mgr:
    count: 2
    allowMultiplePerNode: false
    modules:
      - name: pg_autoscaler
        enabled: true
      - name: balancer
        enabled: true
  dashboard:
    enabled: true
    ssl: true
  monitoring:
    enabled: true
    metricsDisabled: false
  network:
    provider: host        # Use host networking for maximum throughput
    hostNetwork: true
  crashCollector:
    disable: false
    daysToRetain: 30
  logCollector:
    enabled: true
    periodicity: daily
    maxLogSize: 500M
  cleanupPolicy:
    confirmation: ""      # Must be set to "yes-really-destroy-data" to wipe
    sanitizeDisks:
      method: quick
      dataSource: zero
      iteration: 1
    allowUninstallWithVolumes: false
  removeOSDsIfOutAndSafeToRemove: false
  priorityClassNames:
    mon: system-node-critical
    osd: system-node-critical
    mgr: system-cluster-critical
  storage:
    useAllNodes: false
    useAllDevices: false
    nodes:
      - name: storage-node-1
        devices:
          - name: nvme0n1
          - name: nvme1n1
        config:
          storeType: bluestore
          osdsPerDevice: "1"
      - name: storage-node-2
        devices:
          - name: nvme0n1
          - name: nvme1n1
        config:
          storeType: bluestore
          osdsPerDevice: "1"
      - name: storage-node-3
        devices:
          - name: nvme0n1
          - name: nvme1n1
        config:
          storeType: bluestore
          osdsPerDevice: "1"
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
        - key: storage
          operator: Equal
          value: ceph
          effect: NoSchedule
    mon:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
                - key: app
                  operator: In
                  values:
                    - rook-ceph-mon
            topologyKey: kubernetes.io/hostname
    osd:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - rook-ceph-osd
              topologyKey: kubernetes.io/hostname
  resources:
    osd:
      limits:
        cpu: "4"
        memory: 8Gi
      requests:
        cpu: "2"
        memory: 4Gi
    mon:
      limits:
        cpu: "2"
        memory: 2Gi
      requests:
        cpu: "500m"
        memory: 1Gi
    mgr:
      limits:
        cpu: "2"
        memory: 2Gi
      requests:
        cpu: "500m"
        memory: 1Gi
  disruptionManagement:
    managePodBudgets: true
    osdMaintenanceTimeout: 30
    pgHealthCheckTimeout: 0
    manageMachineDisruptionBudgets: false
```

```bash
kubectl apply -f cluster-production.yaml

# Watch cluster come online
kubectl -n rook-ceph get cephcluster rook-ceph -w
```

## OSD Placement and Device Selection

### Device Class Assignment

Assign device classes to control CRUSH map placement:

```yaml
storage:
  nodes:
    - name: storage-node-1
      devices:
        - name: nvme0n1
          config:
            deviceClass: nvme
        - name: sdb
          config:
            deviceClass: hdd
```

### OSD Encryption

```yaml
storage:
  nodes:
    - name: storage-node-1
      devices:
        - name: nvme0n1
          config:
            encryptedDevice: "true"
```

### OSD Topology Labels

For CRUSH map zone/rack awareness, label nodes:

```bash
kubectl label node storage-node-1 topology.kubernetes.io/zone=us-east-1a
kubectl label node storage-node-2 topology.kubernetes.io/zone=us-east-1b
kubectl label node storage-node-3 topology.kubernetes.io/zone=us-east-1c
```

```yaml
# Enable topology awareness in CephCluster
spec:
  storage:
    config:
      crushRoot: default
    useAllNodes: false
```

## CephBlockPool and RBD StorageClass

### Create a Replicated Block Pool

```yaml
# blockpool-production.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host
  replicated:
    size: 3
    requireSafeReplicaSize: true
    replicasPerFailureDomain: 1
  parameters:
    compression_mode: none
  mirroring:
    enabled: false
  statusCheck:
    mirror:
      disabled: false
      interval: 60s
  quotas:
    maxSize: ""
    maxObjects: ""
```

```bash
kubectl apply -f blockpool-production.yaml

# Check pool health
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph osd pool ls detail
```

### Erasure-Coded Block Pool (Production, Cost-Optimized)

```yaml
# blockpool-ec.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: ec-pool
  namespace: rook-ceph
spec:
  failureDomain: host
  erasureCoded:
    dataChunks: 4
    codingChunks: 2
  parameters:
    bulk: "true"
```

### RBD StorageClass

```yaml
# storageclass-rbd.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
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
  csi.storage.k8s.io/fstype: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
mountOptions:
  - discard
```

```bash
kubectl apply -f storageclass-rbd.yaml

# Test with a PVC
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-rbd-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: rook-ceph-block
  resources:
    requests:
      storage: 10Gi
EOF

kubectl get pvc test-rbd-pvc -w
```

## CephObjectStore for S3-Compatible API

```yaml
# objectstore-production.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: s3-store
  namespace: rook-ceph
spec:
  metadataPool:
    failureDomain: host
    replicated:
      size: 3
  dataPool:
    failureDomain: host
    erasureCoded:
      dataChunks: 4
      codingChunks: 2
    parameters:
      bulk: "true"
  preservePoolsOnDelete: true
  gateway:
    type: s3
    port: 80
    securePort: 443
    sslCertificateRef: rook-ceph-rgw-tls
    instances: 3
    resources:
      limits:
        cpu: "2"
        memory: 2Gi
      requests:
        cpu: "500m"
        memory: 1Gi
    placement:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - rook-ceph-rgw
              topologyKey: kubernetes.io/hostname
  healthCheck:
    bucket:
      disabled: false
      interval: 60s
```

### Object Store User

```yaml
# objectstore-user.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: app-s3-user
  namespace: rook-ceph
spec:
  store: s3-store
  displayName: "Application S3 User"
  capabilities:
    user: "*"
    bucket: "*"
    metadata: "*"
    usage: read
    zone: read
  quotas:
    maxBuckets: 100
    maxSize: 1Ti
    maxObjects: -1
```

### StorageClass for Object Bucket Claims

```yaml
# storageclass-s3.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-bucket
provisioner: rook-ceph.ceph.rook.io/bucket
reclaimPolicy: Delete
parameters:
  objectStoreName: s3-store
  objectStoreNamespace: rook-ceph
  region: us-east-1
```

```bash
# Create an ObjectBucketClaim
kubectl apply -f - <<'EOF'
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: app-bucket
  namespace: production
spec:
  generateBucketName: app-data
  storageClassName: rook-ceph-bucket
EOF

# Get the generated credentials
kubectl get secret app-bucket -n production -o yaml
kubectl get configmap app-bucket -n production -o yaml
```

## CephFilesystem with MDS

```yaml
# filesystem-production.yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: shared-fs
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
    failureDomain: host
    parameters:
      pg_num: "64"
  dataPools:
    - name: data0
      failureDomain: host
      replicated:
        size: 3
      parameters:
        pg_num: "128"
  preserveFilesystemOnDelete: false
  metadataServer:
    activeCount: 1
    activeStandby: true
    resources:
      limits:
        cpu: "2"
        memory: 4Gi
      requests:
        cpu: "500m"
        memory: 2Gi
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

### CephFS StorageClass

```yaml
# storageclass-cephfs.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: shared-fs
  pool: shared-fs-data0
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
mountOptions:
  - debug
```

## CRUSH Map Tuning

The CRUSH map controls how Ceph distributes data across OSDs.

### View Current CRUSH Map

```bash
# Access the Rook toolbox
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd crush tree --show-shadow

# Get the compiled CRUSH map
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd getcrushmap -o /tmp/crushmap.bin
crushtool -d /tmp/crushmap.bin -o /tmp/crushmap.txt
```

### Custom CRUSH Rule for Zone Awareness

```bash
# Create a rule that spreads across failure domains (zones)
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd crush rule create-replicated zone-replicated default zone host

# Apply the rule to a pool
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd pool set replicapool crush_rule zone-replicated
```

### Reweight OSDs for Balanced Utilization

```bash
# List OSD utilization
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd df tree

# Reweight an overloaded OSD
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd crush reweight osd.3 1.5

# Enable automatic balancer
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph balancer on
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph balancer mode upmap
```

## Monitoring with Prometheus

### Enable Ceph Dashboard and Metrics

```bash
# Verify metrics are exposed
kubectl get service rook-ceph-mgr-dashboard -n rook-ceph
kubectl get service rook-ceph-mgr -n rook-ceph

# Port-forward the dashboard
kubectl port-forward -n rook-ceph svc/rook-ceph-mgr-dashboard 8443:8443
```

### ServiceMonitor for Prometheus

```yaml
# servicemonitor-ceph.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: rook-ceph-mgr
  namespace: rook-ceph
  labels:
    team: storage
spec:
  namespaceSelector:
    matchNames:
      - rook-ceph
  selector:
    matchLabels:
      app: rook-ceph-mgr
      rook_cluster: rook-ceph
  endpoints:
    - port: http-metrics
      path: /metrics
      interval: 30s
```

### Key Prometheus Metrics

```promql
# Cluster health status (0=HEALTH_OK, 1=HEALTH_WARN, 2=HEALTH_ERR)
ceph_health_status

# OSD in/out/up/down
ceph_osd_in
ceph_osd_up

# PG states
ceph_pg_active
ceph_pg_degraded
ceph_pg_undersized

# Cluster capacity
ceph_cluster_total_bytes
ceph_cluster_total_used_raw_bytes

# Pool-level IOPS
rate(ceph_pool_rd[5m])
rate(ceph_pool_wr[5m])

# OSD latency
ceph_osd_apply_latency_ms
ceph_osd_commit_latency_ms
```

### PrometheusRule for Ceph Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ceph-cluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: ceph.health
      rules:
        - alert: CephHealthError
          expr: ceph_health_status == 2
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Ceph cluster is in HEALTH_ERR state"
            description: "Immediate attention required — Ceph cluster health is ERROR."

        - alert: CephOSDDown
          expr: ceph_osd_up == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Ceph OSD {{ $labels.ceph_daemon }} is down"

        - alert: CephPGDegraded
          expr: ceph_pg_degraded > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "{{ $value }} Ceph placement groups degraded"

        - alert: CephCapacityWarning
          expr: |
            (ceph_cluster_total_used_raw_bytes / ceph_cluster_total_bytes) * 100 > 75
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Ceph cluster capacity above 75%"
            description: "Cluster is {{ printf \"%.1f\" $value }}% full."
```

## Cluster Health Management

### Daily Health Checks

```bash
# Overall health
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph -s

# Expected output for healthy cluster:
# cluster:
#   id:     <uuid>
#   health: HEALTH_OK
# services:
#   mon: 3 daemons, quorum a,b,c
#   mgr: a(active), b(standby)
#   osd: 6 osds: 6 up, 6 in
# data:
#   pools:   3 pools, 96 pgs
#   objects: 10.20k objects, 38 GiB
#   usage:   119 GiB used, 5.9 TiB / 6.0 TiB avail
#   pgs:     96 active+clean

# Check OSD status
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph osd status

# Check placement groups
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph pg stat
```

## OSD Disk Replacement

When a disk fails, the OSD must be replaced:

```bash
# Step 1: Identify the failed OSD
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph osd tree | grep down

# Step 2: Mark the OSD out
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph osd out osd.3

# Wait for data migration to complete
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  watch ceph status

# Step 3: Delete the OSD Deployment
kubectl delete deployment -n rook-ceph rook-ceph-osd-3

# Step 4: Remove the OSD from the CRUSH map
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph osd purge osd.3 --yes-i-really-mean-it

# Step 5: Remove the OSD from auth
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph auth del osd.3

# Step 6: Replace the physical disk and let Rook auto-discover it
# The operator will create a new OSD automatically via the job
kubectl get jobs -n rook-ceph | grep provision
```

## Capacity Planning

### Calculate Required Raw Capacity

For 3x replication:

```
Usable Capacity = Raw Capacity / (Replication Factor * Storage Efficiency)
                = Raw Capacity / (3 * 1.0)
```

For 4+2 erasure coding (6 OSDs minimum):

```
Usable Capacity = Raw Capacity * (4/6) * Storage Efficiency
                = Raw Capacity * 0.667
```

### Monitor Utilization Trends

```bash
# Pool utilization
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph df detail

# Per-OSD utilization
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph osd df tree | sort -k 9 -rn | head -20
```

## Upgrading Rook-Ceph

### Upgrade Operator

```bash
# 1. Update operator image
kubectl set image -n rook-ceph deployment/rook-ceph-operator \
  rook-ceph-operator=rook/ceph:v1.14.9

# 2. Monitor the upgrade
kubectl -n rook-ceph get pods -w

# 3. Update CephCluster cephVersion
kubectl patch cephcluster rook-ceph -n rook-ceph --type merge \
  -p '{"spec":{"cephVersion":{"image":"quay.io/ceph/ceph:v18.2.4"}}}'

# 4. Watch MON/OSD rolling update
kubectl -n rook-ceph get pod -l app=rook-ceph-osd -w
```

## Troubleshooting

### Toolbox Pod

```bash
# Deploy the toolbox for ceph CLI access
kubectl apply -f https://raw.githubusercontent.com/rook/rook/v1.14.9/deploy/examples/toolbox.yaml

kubectl exec -it -n rook-ceph deploy/rook-ceph-tools -- bash
```

### OSD Not Starting

```bash
# Check OSD pod logs
kubectl logs -n rook-ceph rook-ceph-osd-0-<pod-id> -c osd

# Common causes:
# 1. Device still has LVM metadata
#    Fix: wipe device with 'sgdisk --zap-all /dev/nvme0n1'
# 2. BlueStore label present
#    Fix: use CephCluster 'cleanupPolicy' or manual wipefs
wipefs -a /dev/nvme0n1

# Check OSD prepare job
kubectl get jobs -n rook-ceph | grep osd-prepare
kubectl logs -n rook-ceph job/rook-ceph-osd-prepare-storage-node-1
```

### PVC Stuck in Pending

```bash
# Check CSI driver pods
kubectl get pods -n rook-ceph -l app=csi-rbdplugin

# Check provisioner logs
kubectl logs -n rook-ceph deployment/csi-rbdplugin-provisioner \
  -c csi-provisioner --tail=50

# Verify StorageClass provisioner matches installed CSI driver
kubectl get sc rook-ceph-block -o yaml | grep provisioner
```

## Production Best Practices

### Pod Disruption Budgets

```yaml
# Protect MONs from simultaneous disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: rook-ceph-mon
  namespace: rook-ceph
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: rook-ceph-mon
```

### Network Policy

```yaml
# Allow all rook-ceph pods to communicate
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: rook-ceph-internal
  namespace: rook-ceph
spec:
  podSelector:
    matchLabels:
      rook_cluster: rook-ceph
  ingress:
    - from:
        - podSelector:
            matchLabels:
              rook_cluster: rook-ceph
  egress:
    - to:
        - podSelector:
            matchLabels:
              rook_cluster: rook-ceph
```

## Summary

Rook-Ceph provides enterprise-grade distributed storage for Kubernetes through operator-driven lifecycle management of the full Ceph stack. Key production considerations:

- Pin Ceph daemons to dedicated nodes with taints and node affinity
- Use BlueStore with NVMe devices for OSD performance
- Configure CRUSH rules for zone-aware replication
- Enable the pg_autoscaler and balancer MGR modules
- Monitor via Prometheus with alerts for health, degraded PGs, and capacity
- Maintain a replacement procedure for OSD disk failures
- Plan capacity based on replication factor with 20% headroom
- Use Pod Disruption Budgets to prevent simultaneous MON disruption during cluster maintenance

Rook-Ceph eliminates the operational complexity of managing Ceph manually while providing the same data durability and performance characteristics required by stateful production workloads.
