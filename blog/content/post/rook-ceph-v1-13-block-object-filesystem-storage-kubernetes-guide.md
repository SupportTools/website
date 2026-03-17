---
title: "Rook-Ceph v1.13: Block, Object, and Filesystem Storage with Multi-Site Replication and Failure Domain Placement"
date: 2031-12-08T00:00:00-05:00
draft: false
tags: ["Rook", "Ceph", "Kubernetes", "Storage", "Block Storage", "Object Storage", "CephFS", "Multi-Site", "Disaster Recovery"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to deploying Rook-Ceph v1.13 on Kubernetes, covering block storage with StorageClasses, S3-compatible object storage, CephFS shared filesystems, multi-site replication for disaster recovery, and CRUSH failure domain placement for availability zones."
more_link: "yes"
url: "/rook-ceph-v1-13-block-object-filesystem-storage-kubernetes-guide/"
---

Rook-Ceph turns a set of raw disks across Kubernetes worker nodes into a unified storage platform — block devices for databases, S3-compatible object storage for applications, and shared POSIX filesystems for stateful workloads. Version 1.13 brings significant improvements to multi-site object replication, improved OSD placement controls, and CephFS volume replication for disaster recovery. This guide covers the complete deployment, configuration, and operational management of a production Rook-Ceph cluster.

<!--more-->

# Rook-Ceph v1.13: Production Storage Guide

## Cluster Prerequisites

### Node Requirements

Each node that will contribute storage needs:

- Raw block devices (not partitioned, not formatted): SSDs strongly recommended for OSD journals
- At minimum 3 nodes for the default 3-replica policy
- For production: 5+ nodes across 3+ failure domains (availability zones or server racks)
- Kernel 5.4+ for best CephFS and RBD feature support

```bash
# Verify nodes have unformatted block devices
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT | grep -v MOUNTPOINT

# Expected: disks with empty FSTYPE column
# NAME    SIZE  TYPE FSTYPE MOUNTPOINT
# sda     500G  disk
# sdb     500G  disk
# nvme0n1 1T    disk
```

### Label Nodes for OSD Placement

```bash
# Label nodes by failure domain (rack/zone)
kubectl label node k8s-worker-1 topology.kubernetes.io/zone=zone-a
kubectl label node k8s-worker-2 topology.kubernetes.io/zone=zone-a
kubectl label node k8s-worker-3 topology.kubernetes.io/zone=zone-b
kubectl label node k8s-worker-4 topology.kubernetes.io/zone=zone-b
kubectl label node k8s-worker-5 topology.kubernetes.io/zone=zone-c
kubectl label node k8s-worker-6 topology.kubernetes.io/zone=zone-c

# Label nodes that have dedicated storage drives
kubectl label node k8s-worker-{1..6} role=storage-node
```

## Installing Rook-Ceph

```bash
# Add the Rook Helm repository
helm repo add rook-release https://charts.rook.io/release
helm repo update

# Install Rook operator
helm install \
  --create-namespace \
  --namespace rook-ceph \
  rook-ceph \
  rook-release/rook-ceph \
  --version 1.13.0 \
  --set monitoring.enabled=true \
  --set monitoring.createPrometheusRules=true

# Verify operator is running
kubectl -n rook-ceph get pods -l app=rook-ceph-operator
```

## Creating the Ceph Cluster

### Production Cluster Definition

```yaml
# ceph-cluster.yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v18.2.2
    allowUnsupported: false

  dataDirHostPath: /var/lib/rook

  skipUpgradeChecks: false
  continueUpgradeAfterChecksEvenIfNotHealthy: false

  # Wait 10 minutes for OSD pods to start before declaring failure
  waitTimeoutForHealthyOSDInMinutes: 10

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
      - name: pg_autoscaler
        enabled: true
      - name: dashboard
        enabled: true
      - name: prometheus
        enabled: true
      - name: balancer
        enabled: true

  dashboard:
    enabled: true
    ssl: true

  monitoring:
    enabled: true
    externalMgrPrometheusPort: 9283

  network:
    provider: host
    # Separate cluster network from public network for OSD replication traffic
    # public: 10.0.0.0/24   (client-facing)
    # cluster: 10.1.0.0/24  (OSD-to-OSD replication)

  crashCollector:
    disable: false
    daysToRetain: 30

  cleanupPolicy:
    confirmation: ""  # Empty = require explicit confirmation to destroy cluster
    sanitizeDisks:
      method: quick
      dataSource: zero
      iteration: 1
    allowUninstallWithVolumes: false

  removeOSDsIfOutAndSafeToRemove: false

  storage:
    useAllNodes: false
    useAllDevices: false
    # Target nodes with the storage-node label
    nodes:
      - name: "k8s-worker-1"
        devices:
          - name: "sda"
          - name: "sdb"
        config:
          osdsPerDevice: "1"
          encryptedDevice: "true"  # Encrypt OSDs at rest
      - name: "k8s-worker-2"
        devices:
          - name: "sda"
          - name: "sdb"
      - name: "k8s-worker-3"
        devices:
          - name: "sda"
          - name: "sdb"
      - name: "k8s-worker-4"
        devices:
          - name: "sda"
          - name: "sdb"
      - name: "k8s-worker-5"
        devices:
          - name: "sda"
          - name: "sdb"
      - name: "k8s-worker-6"
        devices:
          - name: "sda"
          - name: "sdb"

  # Placement rules for each Ceph component
  placement:
    mon:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: role
                  operator: In
                  values:
                    - storage-node
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: rook-ceph-mon
    mgr:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: rook-ceph-mgr
    osd:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: role
                  operator: In
                  values:
                    - storage-node

  resources:
    mon:
      requests:
        cpu: "500m"
        memory: "1Gi"
      limits:
        cpu: "2"
        memory: "2Gi"
    mgr:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "2"
        memory: "2Gi"
    osd:
      requests:
        cpu: "1"
        memory: "4Gi"
      limits:
        cpu: "4"
        memory: "8Gi"

  priorityClassNames:
    mon: system-node-critical
    osd: system-node-critical
    mgr: system-cluster-critical
```

```bash
kubectl apply -f ceph-cluster.yaml

# Watch cluster come up (takes 5-10 minutes)
watch -n5 'kubectl -n rook-ceph get cephcluster rook-ceph -o jsonpath="{.status.phase}" && echo ""'

# Final state should be: HEALTH_OK
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph status
```

## Block Storage: RBD StorageClass

### Creating a CephBlockPool with Failure Domain Placement

```yaml
# block-pool.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: zone     # Replicas spread across AZs
  # failureDomain: host   # Alternative: spread across hosts (less durable but OK for <3 zones)
  replicated:
    size: 3
    requireSafeReplicaSize: true  # Refuse to create pool if we can't guarantee safety
  deviceClass: ssd        # Only use SSD OSDs for this pool
  compressionMode: none
  parameters:
    compression_mode: none
    pg_num: "32"           # Start conservative; pg_autoscaler will adjust
    pg_num_min: "32"
    target_size_ratio: "0.3"  # Hint: this pool will use ~30% of total cluster capacity
  quotas:
    maxBytes: 2199023255552  # 2 TiB maximum
    maxObjects: 0            # Unlimited objects
  statusCheck:
    mirror:
      disabled: false
      interval: "60s"
```

### RBD StorageClass

```yaml
# storageclass-rbd.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering,fast-diff,object-map,deep-flatten,exclusive-lock

  # Secrets created by Rook
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph

  csi.storage.k8s.io/fstype: ext4

reclaimPolicy: Retain       # IMPORTANT: use Retain in production; Delete loses data
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### Using RBD for a PostgreSQL StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
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
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: POSTGRES_DB
              value: appdb
            - name: POSTGRES_USER
              value: appuser
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
  volumeClaimTemplates:
    - metadata:
        name: postgres-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: rook-ceph-block
        resources:
          requests:
            storage: 100Gi
```

## Object Storage: S3-Compatible RGW

### Creating an ObjectStore

```yaml
# objectstore.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: my-store
  namespace: rook-ceph
spec:
  metadataPool:
    failureDomain: zone
    replicated:
      size: 3
  dataPool:
    failureDomain: zone
    erasureCoded:
      dataChunks: 4    # k=4
      codingChunks: 2  # m=2 (can lose 2 OSDs)
    compressionMode: passive
  preservePoolsOnDelete: true
  gateway:
    port: 80
    securePort: 443
    instances: 3     # 3 RGW instances for HA
    resources:
      requests:
        cpu: "1"
        memory: "1Gi"
      limits:
        cpu: "2"
        memory: "2Gi"
    placement:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: rook-ceph-rgw
    priorityClassName: system-cluster-critical
  healthCheck:
    bucket:
      disabled: false
      interval: "60s"
  auth:
    keystone: {}  # Disable Keystone; use S3 keys
```

### Creating an ObjectStore User

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: app-s3-user
  namespace: rook-ceph
spec:
  store: my-store
  displayName: "Application S3 User"
  quotas:
    maxBuckets: 100
    maxSize: "1TiB"
    maxObjects: 1000000
  capabilities:
    user: "*"
    bucket: "*"
```

```bash
# Get the S3 credentials
kubectl -n rook-ceph get secret rook-ceph-object-user-my-store-app-s3-user -o yaml

# Extract and use with AWS CLI (using fake placeholders here)
AWS_ACCESS_KEY_ID=$(kubectl -n rook-ceph get secret \
  rook-ceph-object-user-my-store-app-s3-user \
  -o jsonpath='{.data.AccessKey}' | base64 -d)
AWS_SECRET_ACCESS_KEY=$(kubectl -n rook-ceph get secret \
  rook-ceph-object-user-my-store-app-s3-user \
  -o jsonpath='{.data.SecretKey}' | base64 -d)

RGW_ENDPOINT=$(kubectl -n rook-ceph get svc rook-ceph-rgw-my-store -o jsonpath='{.spec.clusterIP}')

# Test with AWS CLI
aws --endpoint-url "http://${RGW_ENDPOINT}" \
    s3 mb s3://test-bucket

aws --endpoint-url "http://${RGW_ENDPOINT}" \
    s3 cp /etc/hostname s3://test-bucket/test.txt

aws --endpoint-url "http://${RGW_ENDPOINT}" \
    s3 ls s3://test-bucket/
```

### S3-Compatible StorageClass for ObjectStore

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-bucket
provisioner: rook-ceph.ceph.rook.io/bucket
reclaimPolicy: Retain
parameters:
  objectStoreName: my-store
  objectStoreNamespace: rook-ceph
  region: us-east-1
```

```yaml
# Application bucket claim
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: app-bucket
  namespace: production
spec:
  generateBucketName: app-bucket
  storageClassName: rook-ceph-bucket
  additionalConfig:
    maxSize: "10Gi"
    maxObjects: "100000"
```

## Shared Filesystem: CephFS

### Creating a CephFS Filesystem

```yaml
# filesystem.yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: myfs
  namespace: rook-ceph
spec:
  # Metadata pool: small, replicated 3x, SSD-backed
  metadataPool:
    failureDomain: zone
    replicated:
      size: 3
    deviceClass: ssd

  # Data pools: can have multiple for different workloads
  dataPools:
    - name: default
      failureDomain: zone
      replicated:
        size: 3
      compressionMode: passive

    - name: erasure-coded
      failureDomain: zone
      erasureCoded:
        dataChunks: 4
        codingChunks: 2

  preserveFilesystemOnDelete: true

  # Metadata server configuration
  metadataServer:
    activeCount: 2       # 2 active MDS for performance
    activeStandby: true  # Hot standbys for failover
    resources:
      requests:
        cpu: "500m"
        memory: "1Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    placement:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: rook-ceph-mds
    priorityClassName: system-cluster-critical
```

### CephFS StorageClass for RWX Volumes

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: myfs
  pool: myfs-default    # Use the 'default' data pool

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

### Using CephFS for a Shared Logging Volume

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-logs
  namespace: production
spec:
  accessModes:
    - ReadWriteMany    # Multiple pods can mount simultaneously
  storageClassName: rook-cephfs
  resources:
    requests:
      storage: 500Gi
```

## Multi-Site Object Storage Replication

Multi-site replication lets you maintain a hot copy of your object data in a second Kubernetes cluster for disaster recovery or geo-distribution.

### Site 1 Configuration (Primary)

```yaml
# realm.yaml — The top-level naming domain
apiVersion: ceph.rook.io/v1
kind: CephObjectRealm
metadata:
  name: multisite-realm
  namespace: rook-ceph
```

```yaml
# zone-group.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectZoneGroup
metadata:
  name: us
  namespace: rook-ceph
spec:
  realm: multisite-realm
```

```yaml
# zone-primary.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectZone
metadata:
  name: us-east
  namespace: rook-ceph
spec:
  zoneGroup: us
  metadataPool:
    failureDomain: zone
    replicated:
      size: 3
  dataPool:
    failureDomain: zone
    erasureCoded:
      dataChunks: 4
      codingChunks: 2
  customEndpoints:
    - http://rgw.us-east.example.com
  storageClass: "rook-ceph-bucket"
  preservePoolsOnDelete: true
```

```yaml
# Update ObjectStore to use the zone
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: my-store
  namespace: rook-ceph
spec:
  # ... (previous config)
  zone:
    name: us-east
```

### Site 2 Configuration (Secondary)

On the second cluster, pull the realm info from the primary:

```bash
# On site 1: export realm configuration
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  radosgw-admin realm get --rgw-realm=multisite-realm > realm.json

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  radosgw-admin period get > period.json

# Transfer realm.json and period.json to site 2 (out of band)
# Create a secret on site 2 with the realm info
kubectl -n rook-ceph create secret generic realm-a-keys \
  --from-file=endpoint=./endpoint.txt \
  --from-file=access-key=./access-key.txt \
  --from-file=secret-key=./secret-key.txt
```

```yaml
# On site 2: zone-secondary.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectZone
metadata:
  name: us-west
  namespace: rook-ceph
spec:
  zoneGroup: us
  metadataPool:
    failureDomain: zone
    replicated:
      size: 3
  dataPool:
    failureDomain: zone
    replicated:
      size: 3
  customEndpoints:
    - http://rgw.us-west.example.com
```

### Monitoring Multi-Site Replication

```bash
# Check sync status between zones
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  radosgw-admin sync status

# Expected output shows lag between primary and secondary:
# realm       multisite-realm
# zonegroup   us
# zone        us-west
# ...
#           metadata sync syncing
#     full sync: 0/1024 shards
#     incremental sync: 1024/1024 shards
#     metadata is caught up with master
#
#           data sync source: us-east
#     full sync: 0/128 shards
#     incremental sync: 128/128 shards
#     data is 3 seconds behind master

# Check for sync errors
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  radosgw-admin sync error list
```

## CRUSH Map and Failure Domain Configuration

The CRUSH map controls how Ceph distributes data across OSDs to maintain the desired failure domain properties.

### Viewing the CRUSH Map

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree

# Output example:
# ID  CLASS  WEIGHT    TYPE NAME           STATUS
# -1         12.00000  root default
# -5         4.00000       zone zone-a
# -3         2.00000           host k8s-worker-1
#  0    ssd  1.00000               osd.0   up
#  1    ssd  1.00000               osd.1   up
# -4         2.00000           host k8s-worker-2
#  2    ssd  1.00000               osd.2   up
#  3    ssd  1.00000               osd.3   up
# ...
```

### Custom CRUSH Rule for Zone-Level Replication

```bash
# Create a CRUSH rule that enforces zone-level failure domains
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd crush rule create-replicated \
  zone-replicated default zone ssd

# Verify the rule
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd crush rule dump zone-replicated
```

### Applying Custom CRUSH Rule to a Pool

```bash
# Set the pool to use the zone-aware CRUSH rule
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd pool set replicapool crush_rule zone-replicated

# Verify PGs are redistributed
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph pg stat
```

## Monitoring Rook-Ceph with Prometheus

### ServiceMonitor for Ceph Metrics

```yaml
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
  endpoints:
    - port: http-metrics
      path: /metrics
      interval: 30s
```

### Key Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rook-ceph-alerts
  namespace: rook-ceph
spec:
  groups:
    - name: ceph-health
      interval: 30s
      rules:
        - alert: CephHealthCritical
          expr: ceph_health_status == 2
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Ceph cluster is in HEALTH_ERR state"
            description: "Ceph cluster health is critical. Immediate attention required."

        - alert: CephOSDDown
          expr: ceph_osd_up == 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Ceph OSD {{ $labels.ceph_daemon }} is down"

        - alert: CephCapacityWarning
          expr: >
            (ceph_cluster_total_used_bytes / ceph_cluster_total_bytes) > 0.75
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Ceph cluster capacity above 75%"
            description: "Ceph cluster is {{ $value | humanizePercentage }} full."

        - alert: CephCapacityCritical
          expr: >
            (ceph_cluster_total_used_bytes / ceph_cluster_total_bytes) > 0.85
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Ceph cluster capacity above 85% — TAKE ACTION NOW"

        - alert: CephPGsUnhealthy
          expr: ceph_pg_active != ceph_pg_total
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph has unhealthy PGs: {{ $value }} PGs not active"

        - alert: CephMDSInactive
          expr: ceph_mds_inodes == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "CephFS MDS has no active inodes — filesystem may be unavailable"
```

## Operational Runbooks

### Replacing a Failed OSD

```bash
#!/usr/bin/env bash
# replace-failed-osd.sh

set -euo pipefail

FAILED_OSD_ID="${1:?usage: $0 <osd-id>}"

echo "=== Replacing OSD ${FAILED_OSD_ID} ==="

# Step 1: Mark the OSD out so Ceph stops using it
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd out "osd.${FAILED_OSD_ID}"

# Step 2: Wait for data to be re-replicated (watch pg recover)
echo "Waiting for data recovery..."
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph -w --format json | \
  python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        if d.get('type') == 'status':
            print(f'Recovery: {d[\"output\"][\"pgmap\"].get(\"recovering_objects_per_sec\", 0):.1f} obj/s')
    except:
        pass
" &
WATCH_PID=$!
sleep 60
kill "${WATCH_PID}" 2>/dev/null || true

# Step 3: Delete the OSD pod and PVC
NODE=$(kubectl -n rook-ceph get pod -l "ceph-osd-id=${FAILED_OSD_ID}" \
  -o jsonpath='{.items[0].spec.nodeName}')
echo "OSD ${FAILED_OSD_ID} was on node ${NODE}"

kubectl -n rook-ceph delete pod -l "ceph-osd-id=${FAILED_OSD_ID}"

# Step 4: Mark the OSD as destroyed in the CRUSH map
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd destroy "osd.${FAILED_OSD_ID}" --yes-i-really-mean-it

# Step 5: Clean the disk (if replacing same physical disk)
# kubectl -n rook-ceph exec "rook-ceph-operator-pod" -- \
#   dd if=/dev/zero of=/dev/sdX bs=4M count=10

# Step 6: Rook will automatically re-create the OSD on the cleaned disk
echo "Rook will create a new OSD on ${NODE} when disk is available."
echo "Monitor with: kubectl -n rook-ceph get pods -l ceph-osd-id"
```

### Cluster Maintenance Mode

```bash
# Enter maintenance mode: no OSD rebalancing during planned maintenance
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd set noout

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd set norebalance

# Verify
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd dump | grep -E "^flags"
# flags noout,norebalance

# ... perform maintenance ...

# Exit maintenance mode
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd unset noout

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph osd unset norebalance
```

## Summary

Rook-Ceph v1.13 provides a mature, production-grade storage layer for Kubernetes. The key operational decisions are: align CRUSH failure domains with your physical topology (racks or availability zones), use erasure coding for high-capacity cold data pools while keeping frequently-accessed pools as 3x replicated, deploy at least 3 MDS instances for CephFS HA, and configure `preservePoolsOnDelete: true` on all production resources to prevent accidental data loss. Multi-site RGW replication provides RPO near-zero for object storage with a simple configuration based on realms and zone groups. Monitor cluster health status, OSD count, PG health, and capacity utilization — these four metrics together give you a complete picture of cluster health before problems become outages.
