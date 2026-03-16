---
title: "Kubernetes Storage Classes and Dynamic Provisioners: Production Configuration Guide"
date: 2027-05-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "CSI", "PersistentVolume", "StorageClass"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide to Kubernetes StorageClass configuration, CSI drivers, dynamic provisioning, volume expansion, snapshots, and topology-aware provisioning across AWS, GCP, Azure, Longhorn, and Rook-Ceph."
more_link: "yes"
url: "/kubernetes-storage-classes-provisioners-guide/"
---

StorageClasses are the cornerstone of dynamic storage provisioning in Kubernetes, translating abstract storage requirements into concrete infrastructure resources. Misconfigured StorageClasses are among the most common causes of data loss, application startup failures, and cloud billing surprises in production clusters. This guide covers every aspect of StorageClass design, CSI driver configuration, and operational best practices across the major storage backends used in enterprise Kubernetes deployments.

<!--more-->

## Understanding StorageClass Architecture

A StorageClass defines a profile for dynamically provisioned storage. When a PersistentVolumeClaim references a StorageClass, the cluster's volume provisioner creates a PersistentVolume matching the claim's requirements without manual administrator intervention.

The StorageClass manifest contains four critical sections:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/mrk-abc123"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
mountOptions:
  - noatime
  - nodiratime
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.ebs.csi.aws.com/zone
        values:
          - us-east-1a
          - us-east-1b
          - us-east-1c
```

### The Default StorageClass

Every cluster should have exactly one default StorageClass. PVCs that omit the `storageClassName` field will use the default. Having multiple defaults causes unpredictable behavior.

```bash
# Check current default StorageClass
kubectl get storageclass -o custom-columns=\
'NAME:.metadata.name,DEFAULT:.metadata.annotations.storageclass\.kubernetes\.io/is-default-class,PROVISIONER:.provisioner'

# Set a StorageClass as default
kubectl patch storageclass standard \
  -p '{"metadata": {"annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}'

# Remove default annotation from another class
kubectl patch storageclass old-default \
  -p '{"metadata": {"annotations": {"storageclass.kubernetes.io/is-default-class": "false"}}}'
```

### Reclaim Policies

The reclaim policy determines what happens to the underlying storage resource when a PVC is deleted.

**Delete** (most common for dynamic provisioning):

```yaml
reclaimPolicy: Delete
```

When the PVC is deleted, the PV and its backing storage resource are automatically deleted. Suitable for ephemeral workloads, CI/CD pipelines, and non-critical data.

**Retain** (recommended for production databases):

```yaml
reclaimPolicy: Retain
```

When the PVC is deleted, the PV transitions to the `Released` state. The backing storage remains intact. An administrator must manually reclaim, repurpose, or delete the volume. Appropriate for any workload where accidental deletion must not result in data loss.

**Recycle** (deprecated, avoid):

```yaml
reclaimPolicy: Recycle
```

The `Recycle` policy is deprecated and removed in many CSI drivers. It performed a basic `rm -rf` on the volume before making it available again. Do not use this in new deployments.

### Volume Binding Modes

Volume binding mode controls when volume binding and dynamic provisioning occur.

**Immediate** (legacy default):

```yaml
volumeBindingMode: Immediate
```

The PVC binds to a PV immediately upon creation, regardless of where the pod that will consume it is scheduled. This can lead to cross-zone scheduling issues where a pod is scheduled to a zone that cannot access its volume.

**WaitForFirstConsumer** (production recommendation):

```yaml
volumeBindingMode: WaitForFirstConsumer
```

Volume binding is delayed until a pod using the PVC is scheduled. The scheduler considers node constraints, including zone affinity, pod affinity, resource requirements, and taints, before triggering provisioning. This prevents cross-AZ data transfer costs and scheduling failures.

```bash
# Verify WaitForFirstConsumer behavior
kubectl describe pvc my-pvc
# Status should show: "waiting for first consumer to be created before binding"

# After pod is scheduled, the PV will be created in the same zone
kubectl get pv -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone,STATUS:.status.phase'
```

## AWS EBS CSI Driver Configuration

The AWS EBS CSI driver replaces the deprecated in-tree `kubernetes.io/aws-ebs` provisioner and supports the full range of EBS volume types.

### Installation

```bash
# Add the EBS CSI driver via Helm
helm repo add aws-ebs-csi-driver https://kubernetes-sigs.github.io/aws-ebs-csi-driver
helm repo update

helm upgrade --install aws-ebs-csi-driver aws-ebs-csi-driver/aws-ebs-csi-driver \
  --namespace kube-system \
  --set controller.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=\
arn:aws:iam::123456789012:role/AmazonEKS_EBS_CSI_DriverRole \
  --set controller.replicaCount=2 \
  --set node.tolerateAllTaints=true
```

### StorageClass Configurations for Different Workloads

**General-purpose gp3 (default for most workloads):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**High-performance io2 for databases:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: io2-high-iops
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iops: "32000"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/mrk-db-key"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
mountOptions:
  - noatime
  - nodiratime
```

**Cost-optimized st1 for throughput workloads (logs, analytics):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: st1-throughput
provisioner: ebs.csi.aws.com
parameters:
  type: st1
  encrypted: "true"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### EBS Volume Tagging

Tag volumes for cost allocation and resource tracking:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-tagged
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
  tagSpecification_1: "key=Environment,value=production"
  tagSpecification_2: "key=Team,value=platform"
  tagSpecification_3: "key=CostCenter,value=engineering"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

## GCP Persistent Disk CSI Driver Configuration

### Installation

```bash
# GKE clusters have the CSI driver pre-installed
# For self-managed clusters:
kubectl apply -k "github.com/kubernetes-sigs/gcp-compute-persistent-disk-csi-driver/deploy/kubernetes/overlays/stable/?ref=master"
```

### StorageClass Configurations

**Standard persistent disk:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard-pd
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-standard
  replication-type: none
  disk-encryption-kms-key: projects/my-project/locations/global/keyRings/my-ring/cryptoKeys/my-key
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**Balanced persistent disk (recommended general purpose):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: balanced-pd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-balanced
  replication-type: none
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**SSD persistent disk for databases:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ssd-pd
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  replication-type: none
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
mountOptions:
  - noatime
```

**Regional persistent disk (high availability):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: regional-pd-ha
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-balanced
  replication-type: regional-pd
  replication-zones: us-central1-a,us-central1-b
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

## Azure Disk CSI Driver Configuration

### Installation

```bash
# AKS clusters include the CSI driver by default
# For self-managed clusters:
helm repo add azuredisk-csi-driver https://raw.githubusercontent.com/kubernetes-sigs/azuredisk-csi-driver/master/charts
helm install azuredisk-csi-driver azuredisk-csi-driver/azuredisk-csi-driver \
  --namespace kube-system \
  --set cloud=AzurePublicCloud
```

### StorageClass Configurations

**Standard SSD (LRS):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: managed-premium
provisioner: disk.csi.azure.com
parameters:
  skuName: Premium_LRS
  kind: Managed
  diskEncryptionSetID: /subscriptions/sub-id/resourceGroups/rg/providers/Microsoft.Compute/diskEncryptionSets/myDES
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**Ultra disk for high IOPS workloads:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ultra-disk
provisioner: disk.csi.azure.com
parameters:
  skuName: UltraSSD_LRS
  kind: Managed
  diskIOPSReadWrite: "2000"
  diskMBpsReadWrite: "200"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**Zone-redundant storage (ZRS):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: managed-zrs
provisioner: disk.csi.azure.com
parameters:
  skuName: StandardSSD_ZRS
  kind: Managed
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

## Longhorn StorageClass Configuration

Longhorn is a distributed block storage system for Kubernetes that runs entirely within the cluster. It is particularly popular for on-premises and edge deployments.

### Installation

```bash
# Prerequisites
kubectl apply -f https://raw.githubusercontent.com/longhorn/longhorn/v1.6.0/deploy/prerequisite/longhorn-iscsi-installation.yaml

# Install via Helm
helm repo add longhorn https://charts.longhorn.io
helm repo update
helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --version 1.6.0 \
  --set defaultSettings.defaultReplicaCount=3 \
  --set defaultSettings.storageMinimalAvailablePercentage=25 \
  --set defaultSettings.autoSalvage=true \
  --set defaultSettings.nodeDownPodDeletionPolicy=delete-both-statefulset-and-deployment-pod
```

### StorageClass Configurations

**Standard replicated storage (3 replicas):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"
  fromBackup: ""
  fsType: "ext4"
  dataLocality: "disabled"
  replicaAutoBalance: "ignored"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**High-performance with NVMe (data locality enabled):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-nvme-local
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "2"
  dataLocality: "best-effort"
  fsType: "xfs"
  diskSelector: "nvme"
  nodeSelector: "storage=nvme"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**Backup-enabled storage with recurring snapshots:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-with-backup
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"
  fsType: "ext4"
  recurringJobSelector: '[{"name":"daily-backup","isGroup":false}]'
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**Configure Longhorn recurring job for automatic backups:**

```yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 2 * * *"
  task: "backup"
  groups:
    - default
  retain: 7
  concurrency: 2
  labels:
    app: backup
```

## Rook-Ceph StorageClass Configuration

Rook-Ceph provides enterprise-grade storage with replication, snapshots, and multi-access capabilities.

### Installation

```bash
# Deploy Rook operator
helm repo add rook-release https://charts.rook.io/release
helm install rook-ceph rook-release/rook-ceph \
  --namespace rook-ceph \
  --create-namespace \
  --version v1.13.0

# Deploy CephCluster
cat <<'EOF' | kubectl apply -f -
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v18.2.0
  dataDirHostPath: /var/lib/rook
  mon:
    count: 3
    allowMultiplePerNode: false
  mgr:
    count: 2
  dashboard:
    enabled: true
    ssl: true
  monitoring:
    enabled: true
  network:
    provider: host
  storage:
    useAllNodes: false
    useAllDevices: false
    nodes:
      - name: "worker-node-1"
        devices:
          - name: "sdb"
      - name: "worker-node-2"
        devices:
          - name: "sdb"
      - name: "worker-node-3"
        devices:
          - name: "sdb"
  resources:
    mgr:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "1Gi"
    mon:
      requests:
        cpu: "500m"
        memory: "1Gi"
      limits:
        cpu: "1000m"
        memory: "2Gi"
    osd:
      requests:
        cpu: "1000m"
        memory: "4Gi"
      limits:
        cpu: "2000m"
        memory: "8Gi"
EOF
```

### CephBlockPool and StorageClass

```yaml
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
  parameters:
    compression_mode: aggressive
---
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
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

**CephFS for ReadWriteMany workloads:**

```yaml
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
      failureDomain: host
      replicated:
        size: 3
  preserveFilesystemOnDelete: true
  metadataServer:
    activeCount: 1
    activeStandby: true
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
  rootPath: /dynamic_volumes
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

## Volume Expansion

Volume expansion allows resizing a PVC without data loss. The StorageClass must have `allowVolumeExpansion: true`.

### Online Expansion

```bash
# Resize a PVC (online expansion - pod keeps running)
kubectl patch pvc my-database-pvc \
  -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'

# Monitor expansion progress
kubectl describe pvc my-database-pvc
# Look for: "Waiting for user to (re-)start a pod to finish file system resize"
# or: "resize of volume in use completed successfully"

# For filesystem resize (if needed after volume expansion):
kubectl exec -it my-database-pod -- resize2fs /dev/xvda
```

### Expansion Validation Script

```bash
#!/bin/bash
# validate-volume-expansion.sh
PVC_NAME=$1
NAMESPACE=${2:-default}
NEW_SIZE=$3

if [[ -z "$PVC_NAME" || -z "$NEW_SIZE" ]]; then
  echo "Usage: $0 <pvc-name> <namespace> <new-size>"
  exit 1
fi

# Check if StorageClass supports expansion
SC=$(kubectl get pvc "$PVC_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.storageClassName}')
ALLOW_EXPAND=$(kubectl get storageclass "$SC" \
  -o jsonpath='{.allowVolumeExpansion}')

if [[ "$ALLOW_EXPAND" != "true" ]]; then
  echo "ERROR: StorageClass $SC does not allow volume expansion"
  exit 1
fi

# Check current size
CURRENT=$(kubectl get pvc "$PVC_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.capacity.storage}')
echo "Current size: $CURRENT"
echo "Requested size: $NEW_SIZE"

# Apply expansion
kubectl patch pvc "$PVC_NAME" -n "$NAMESPACE" \
  -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"$NEW_SIZE\"}}}}"

echo "Expansion request submitted. Monitoring..."
kubectl get pvc "$PVC_NAME" -n "$NAMESPACE" -w
```

## Volume Snapshots

VolumeSnapshot support requires the external-snapshotter CSI sidecar and a VolumeSnapshotClass.

### VolumeSnapshotClass Configuration

**AWS EBS:**

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Delete
parameters:
  tagSpecification_1: "key=Environment,value=production"
```

**Longhorn:**

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-vsc
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

**Rook-Ceph RBD:**

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-rbdplugin-snapclass
driver: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/volumesnapshot/secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/volumesnapshot/secret-namespace: rook-ceph
deletionPolicy: Delete
```

### Creating and Restoring Snapshots

```yaml
# Create a snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: db-snapshot-20270510
  namespace: production
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data-postgres-0
---
# Restore from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  dataSource:
    name: db-snapshot-20270510
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
  resources:
    requests:
      storage: 100Gi
```

### Automated Snapshot with CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-snapshot
  namespace: production
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: snapshot-sa
          restartPolicy: OnFailure
          containers:
          - name: snapshot
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              DATE=$(date +%Y%m%d)
              cat <<EOF | kubectl apply -f -
              apiVersion: snapshot.storage.k8s.io/v1
              kind: VolumeSnapshot
              metadata:
                name: postgres-snap-${DATE}
                namespace: production
              spec:
                volumeSnapshotClassName: ebs-vsc
                source:
                  persistentVolumeClaimName: postgres-data-postgres-0
              EOF
              # Clean up snapshots older than 7 days
              kubectl get volumesnapshot -n production \
                --sort-by=.metadata.creationTimestamp \
                -o name | head -n -7 | xargs -r kubectl delete -n production
```

## Topology-Aware Provisioning

Topology constraints ensure volumes are provisioned in the same zone as the pods that will consume them.

### AllowedTopologies Configuration

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-us-east-1a
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.ebs.csi.aws.com/zone
        values:
          - us-east-1a
```

### Multi-Zone StorageClass with Pod Affinity

```yaml
# StorageClass allowing all zones
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-multi-zone
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
---
# Pod with zone affinity to match the volume
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database
spec:
  replicas: 3
  selector:
    matchLabels:
      app: database
  template:
    metadata:
      labels:
        app: database
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - database
            topologyKey: topology.kubernetes.io/zone
      containers:
      - name: database
        image: postgres:16
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: gp3-multi-zone
      resources:
        requests:
          storage: 100Gi
```

## Custom CSI Driver Parameters

### StorageClass Parameter Reference

Different CSI drivers support different parameters. Here is a comprehensive reference for common parameters:

```bash
# Discover supported parameters for a CSI driver
kubectl get csidriver -o wide

# Check CSI driver capabilities
kubectl describe csidriver ebs.csi.aws.com

# List CSI node plugins
kubectl get daemonset -n kube-system | grep csi

# Check CSI controller
kubectl get deployment -n kube-system | grep csi
```

### StorageClass for NFS CSI Driver

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-csi
provisioner: nfs.csi.k8s.io
parameters:
  server: nfs-server.default.svc.cluster.local
  share: /
  subDir: ${pvc.metadata.namespace}/${pvc.metadata.name}/${pv.metadata.name}
  onDeleteAction: delete
mountOptions:
  - nfsvers=4.1
  - hard
  - nointr
  - timeo=600
  - retrans=5
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### StorageClass for local-path-provisioner (k3s/edge):

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rancher.io/local-path
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

## StorageClass Monitoring and Alerting

### Prometheus Metrics

```yaml
# PrometheusRule for storage monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: storage-alerts
  namespace: monitoring
spec:
  groups:
  - name: storage.rules
    interval: 30s
    rules:
    - alert: PVCNearFull
      expr: |
        (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} is {{ $value | humanizePercentage }} full"
        description: "PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} is over 85% full"

    - alert: PVCCriticallyFull
      expr: |
        (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.95
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} is critically full"

    - alert: PVCPendingTooLong
      expr: |
        kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} has been Pending for 15+ minutes"

    - alert: StorageProvisioningFailure
      expr: |
        increase(storage_operation_errors_total{operation_name="provision"}[5m]) > 0
      labels:
        severity: critical
      annotations:
        summary: "Storage provisioning failures detected"
```

### Grafana Dashboard Queries

```bash
# PVC capacity utilization across all namespaces
sum by (namespace, persistentvolumeclaim) (
  kubelet_volume_stats_used_bytes /
  kubelet_volume_stats_capacity_bytes * 100
)

# PVC inode utilization
sum by (namespace, persistentvolumeclaim) (
  kubelet_volume_stats_inodes_used /
  kubelet_volume_stats_inodes * 100
)

# StorageClass provisioning latency (p99)
histogram_quantile(0.99,
  rate(storage_operation_duration_seconds_bucket{
    operation_name="provision"
  }[5m])
)
```

## StorageClass Audit and Governance

### Admission Webhook Policy with OPA Gatekeeper

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredStorageClass
metadata:
  name: require-encrypted-storage
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["PersistentVolumeClaim"]
    namespaces:
    - production
    - staging
  parameters:
    allowedClasses:
    - gp3
    - io2-high-iops
    - longhorn-standard
---
# ConstraintTemplate
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredstorageclass
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredStorageClass
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedClasses:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredstorageclass

      violation[{"msg": msg}] {
        input.review.kind.kind == "PersistentVolumeClaim"
        sc := input.review.object.spec.storageClassName
        allowed := {c | c := input.parameters.allowedClasses[_]}
        not allowed[sc]
        msg := sprintf("StorageClass %v is not in the allowed list: %v", [sc, input.parameters.allowedClasses])
      }
```

## Troubleshooting StorageClass Issues

### Common Problems and Solutions

**PVC stuck in Pending:**

```bash
# Diagnose PVC pending state
kubectl describe pvc <pvc-name> -n <namespace>

# Check provisioner events
kubectl get events -n <namespace> --field-selector reason=ProvisioningFailed

# Verify CSI driver is running
kubectl get pods -n kube-system | grep csi

# Check CSI driver logs
kubectl logs -n kube-system -l app=ebs-csi-controller -c ebs-plugin --tail=50
```

**Volume expansion not completing:**

```bash
# Check PVC conditions
kubectl get pvc <pvc-name> -o jsonpath='{.status.conditions}' | jq .

# Check for FileSystemResizePending condition
kubectl describe pvc <pvc-name> | grep -A5 Conditions

# Force filesystem resize by restarting the pod
kubectl rollout restart deployment/<deployment-name>

# For StatefulSets
kubectl rollout restart statefulset/<statefulset-name>
```

**WaitForFirstConsumer not triggering:**

```bash
# Verify pod is actually scheduling
kubectl describe pod <pod-name> | grep -A10 Events

# Check if pod has node affinity conflicting with volume topology
kubectl get pod <pod-name> -o jsonpath='{.spec.affinity}' | jq .

# Check scheduler logs
kubectl logs -n kube-system -l component=kube-scheduler --tail=100 | grep -i "volume"
```

### Diagnostic Script

```bash
#!/bin/bash
# diagnose-storage.sh
echo "=== StorageClass Status ==="
kubectl get storageclass -o custom-columns=\
'NAME:.metadata.name,PROVISIONER:.provisioner,RECLAIMPOLICY:.reclaimPolicy,BINDINGMODE:.volumeBindingMode,EXPANSION:.allowVolumeExpansion'

echo ""
echo "=== PVC Status ==="
kubectl get pvc --all-namespaces -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName,CAPACITY:.status.capacity.storage,STORAGECLASS:.spec.storageClassName'

echo ""
echo "=== PV Status ==="
kubectl get pv -o custom-columns=\
'NAME:.metadata.name,CAPACITY:.spec.capacity.storage,ACCESS:.spec.accessModes[0],RECLAIM:.spec.persistentVolumeReclaimPolicy,STATUS:.status.phase,CLAIM:.spec.claimRef.namespace'

echo ""
echo "=== CSI Drivers ==="
kubectl get csidriver

echo ""
echo "=== CSI Nodes ==="
kubectl get csinode -o custom-columns=\
'NODE:.metadata.name,DRIVERS:.spec.drivers[*].name'

echo ""
echo "=== Recent Storage Events ==="
kubectl get events --all-namespaces \
  --field-selector reason=ProvisioningSucceeded,reason=ProvisioningFailed \
  --sort-by='.lastTimestamp' | tail -20
```

## Production Checklist

Before deploying StorageClasses in production, validate the following:

```bash
# 1. Verify only one default StorageClass exists
DEFAULT_COUNT=$(kubectl get storageclass \
  -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}' \
  | wc -w)
[[ $DEFAULT_COUNT -eq 1 ]] && echo "PASS: Exactly one default StorageClass" || echo "FAIL: $DEFAULT_COUNT default StorageClasses"

# 2. Verify WaitForFirstConsumer is set for cloud providers
kubectl get storageclass -o json | jq '.items[] |
  select(.provisioner | contains("aws","gcp","azure")) |
  {name: .metadata.name, bindingMode: .volumeBindingMode}'

# 3. Verify production classes have Retain reclaim policy
kubectl get storageclass -o json | jq '.items[] |
  select(.metadata.name | contains("prod","database","db")) |
  {name: .metadata.name, reclaimPolicy: .reclaimPolicy}'

# 4. Verify volume expansion is enabled
kubectl get storageclass -o json | jq '.items[] |
  {name: .metadata.name, allowVolumeExpansion: .allowVolumeExpansion}'

# 5. Test dynamic provisioning
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc-$(date +%s)
  namespace: default
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF
```

StorageClass configuration is foundational to Kubernetes storage reliability. Using `WaitForFirstConsumer`, appropriate reclaim policies, and topology-aware provisioning prevents the most common production storage failures. Pair these configurations with monitoring alerts on PVC utilization and provisioning failures to maintain storage health across the cluster lifecycle.
