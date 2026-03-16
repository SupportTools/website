---
title: "Kubernetes Persistent Volume Lifecycle: Claims, Binding, and Data Management"
date: 2027-05-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PersistentVolume", "PVC", "Storage", "StatefulSet"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes PersistentVolume lifecycle management, access modes, reclaim policies, static and dynamic provisioning, StatefulSet volumeClaimTemplates, volume cloning, and cross-namespace snapshot workflows."
more_link: "yes"
url: "/kubernetes-persistent-volume-lifecycle-guide/"
---

The PersistentVolume (PV) and PersistentVolumeClaim (PVC) system in Kubernetes abstracts the details of how storage is provided from how it is consumed. Understanding the complete lifecycle—from provisioning through binding to reclamation—is essential for building reliable stateful applications. Mismanaging this lifecycle is a leading cause of data loss in production Kubernetes environments.

<!--more-->

## The PV/PVC Lifecycle Model

The lifecycle of a PersistentVolume follows a well-defined state machine:

```
Provisioning → Available → Bound → Released → [Reclaimed|Deleted|Retained]
```

Each phase has specific characteristics:

- **Available**: The PV exists and has no claim bound to it
- **Bound**: The PV is associated with a specific PVC
- **Released**: The PVC has been deleted but the PV has not been reclaimed
- **Failed**: The PV has failed automatic reclamation

```bash
# View all PV lifecycle states
kubectl get pv -o custom-columns=\
'NAME:.metadata.name,CAPACITY:.spec.capacity.storage,ACCESS:.spec.accessModes[0],RECLAIM:.spec.persistentVolumeReclaimPolicy,STATUS:.status.phase,CLAIM:.spec.claimRef.namespace,STORAGECLASS:.spec.storageClassName,AGE:.metadata.creationTimestamp'
```

## Access Modes Deep Dive

Access modes define how a volume can be mounted. The four access modes serve distinct use cases.

### ReadWriteOnce (RWO)

```yaml
accessModes:
  - ReadWriteOnce
```

The volume can be mounted as read-write by a single node. Multiple pods on the same node can access the volume simultaneously if they are in the same pod. This is the most common mode for block storage (EBS, Azure Disk, Ceph RBD).

Important distinction: RWO restricts access per node, not per pod. Two pods on the same node referencing the same PVC will both have read-write access.

```bash
# Verify RWO volumes are only bound to one node
kubectl get pv -o json | jq '.items[] |
  select(.spec.accessModes[] == "ReadWriteOnce") |
  {name: .metadata.name, node: .spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values}'
```

### ReadOnlyMany (ROX)

```yaml
accessModes:
  - ReadOnlyMany
```

The volume can be mounted as read-only by many nodes simultaneously. Useful for distributing configuration files, static assets, or reference data across multiple pods without replication overhead.

```yaml
# Example: Shared configuration volume
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-config
  namespace: production
spec:
  accessModes:
    - ReadOnlyMany
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
spec:
  replicas: 10
  template:
    spec:
      volumes:
      - name: config
        persistentVolumeClaim:
          claimName: shared-config
          readOnly: true
      containers:
      - name: web
        volumeMounts:
        - name: config
          mountPath: /etc/app-config
          readOnly: true
```

### ReadWriteMany (RWX)

```yaml
accessModes:
  - ReadWriteMany
```

The volume can be mounted as read-write by many nodes simultaneously. Supported by NFS, CephFS, Azure File, and similar distributed filesystems. Required for stateful applications that need shared write access across replicas.

```yaml
# Example: Shared upload directory
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uploads-shared
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: rook-cephfs
  resources:
    requests:
      storage: 500Gi
```

### ReadWriteOncePod (RWOP)

```yaml
accessModes:
  - ReadWriteOncePod
```

Introduced in Kubernetes 1.22 (GA in 1.29), RWOP restricts volume access to exactly one pod in the entire cluster. Unlike RWO which allows multiple pods on the same node, RWOP enforces single-pod ownership cluster-wide. This is the strongest isolation mode and is appropriate for critical databases where simultaneous access by multiple pods must be prevented even during node failures or rescheduling.

```yaml
# Single-pod exclusive access for critical databases
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: primary-db-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOncePod
  storageClassName: gp3
  resources:
    requests:
      storage: 500Gi
```

### Access Mode Compatibility Matrix

```
Storage Backend      | RWO | ROX | RWX | RWOP
---------------------|-----|-----|-----|------
AWS EBS             |  Y  |  N  |  N  |  Y
GCP PD              |  Y  |  Y  |  N  |  N
Azure Disk          |  Y  |  N  |  N  |  Y
Azure File (SMB)    |  Y  |  Y  |  Y  |  N
NFS                 |  Y  |  Y  |  Y  |  N
CephFS              |  Y  |  Y  |  Y  |  N
Ceph RBD            |  Y  |  Y  |  N  |  Y
Longhorn            |  Y  |  N  |  N  |  Y
Local Volumes       |  Y  |  N  |  N  |  N
```

## Reclaim Policies in Practice

### Retain Policy: Production Database Pattern

The Retain policy prevents automatic deletion of PVs when their PVC is removed. This is the correct choice for any data that must survive accidental deletion.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-primary-pv
  annotations:
    pv.kubernetes.io/provisioned-by: ebs.csi.aws.com
    volume.kubernetes.io/storage-provisioner: ebs.csi.aws.com
spec:
  capacity:
    storage: 500Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: gp3
  awsElasticBlockStore:
    volumeID: vol-0a1b2c3d4e5f67890
    fsType: ext4
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: topology.kubernetes.io/zone
          operator: In
          values:
          - us-east-1a
```

**Reclaiming a Released PV for reuse:**

```bash
# After PVC is deleted, PV enters Released state
kubectl get pv postgres-primary-pv
# STATUS: Released

# Remove the claimRef to make it Available again
kubectl patch pv postgres-primary-pv \
  -p '{"spec":{"claimRef": null}}'

# Verify it's now Available
kubectl get pv postgres-primary-pv
# STATUS: Available

# Create a new PVC that binds to this specific PV
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
  volumeName: postgres-primary-pv  # Bind to specific PV
  resources:
    requests:
      storage: 500Gi
EOF
```

### Delete Policy: Ephemeral Workload Pattern

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ci-ephemeral
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
allowVolumeExpansion: false
volumeBindingMode: WaitForFirstConsumer
```

### Changing Reclaim Policy on Existing PV

```bash
# Change reclaim policy from Delete to Retain for an existing PV
kubectl patch pv <pv-name> \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# Verify the change
kubectl get pv <pv-name> -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'
```

## Static Provisioning

Static provisioning is appropriate when storage is pre-provisioned by an administrator and must be explicitly mapped to specific Kubernetes volumes.

### Manual PV Creation

```yaml
# Pre-provisioned NFS share
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-media-pv
  labels:
    type: nfs
    tier: media
spec:
  capacity:
    storage: 10Ti
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: nfs-static
  mountOptions:
    - nfsvers=4.1
    - hard
    - nointr
  nfs:
    server: 10.0.1.100
    path: /exports/media
---
# PVC that binds to the specific PV using selector
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: media-storage
  namespace: media-processing
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-static
  selector:
    matchLabels:
      type: nfs
      tier: media
  resources:
    requests:
      storage: 10Ti
```

### Static Provisioning from Existing Cloud Volumes

**Existing EBS volume:**

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: existing-ebs-pv
spec:
  capacity:
    storage: 200Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: gp3
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-0123456789abcdef0
    fsType: ext4
    volumeAttributes:
      storage.kubernetes.io/csiProvisionerIdentity: 1234567890-8081-ebs.csi.aws.com
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: topology.ebs.csi.aws.com/zone
          operator: In
          values:
          - us-east-1b
```

**Existing GCP Persistent Disk:**

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: existing-gcp-pd
spec:
  capacity:
    storage: 200Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ssd-pd
  csi:
    driver: pd.csi.storage.gke.io
    volumeHandle: projects/my-project/zones/us-central1-a/disks/my-disk
    fsType: ext4
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: topology.gke.io/zone
          operator: In
          values:
          - us-central1-a
```

## Dynamic Provisioning Flow

Understanding the sequence of events in dynamic provisioning helps with troubleshooting.

```
User creates PVC
    ↓
kube-controller-manager detects unbound PVC
    ↓
If volumeBindingMode=Immediate: provisioner called immediately
If volumeBindingMode=WaitForFirstConsumer:
    Wait for pod to be scheduled
    ↓
    Scheduler selects node considering topology
    ↓
    PVC annotated with selected node topology
    ↓
External provisioner watches for annotated PVCs
    ↓
Provisioner calls CSI CreateVolume RPC
    ↓
CSI driver creates volume in backing infrastructure
    ↓
Provisioner creates PV with binding reference
    ↓
kube-controller-manager binds PVC to PV
    ↓
kubelet calls CSI NodeStageVolume
    ↓
kubelet calls CSI NodePublishVolume
    ↓
Volume is mounted in pod
```

### Monitoring Provisioning Events

```bash
# Watch provisioning events in real time
kubectl get events --all-namespaces \
  --field-selector reason=ProvisioningSucceeded,reason=ProvisioningFailed,reason=ExternalProvisioning \
  -w

# Detailed provisioning timeline for a specific PVC
kubectl describe pvc <pvc-name> -n <namespace>

# Check controller-manager logs for binding decisions
kubectl logs -n kube-system -l component=kube-controller-manager \
  --tail=100 | grep -i "persistentvolume\|pvc\|provision"
```

## StatefulSet volumeClaimTemplates

StatefulSets use `volumeClaimTemplates` to create dedicated PVCs for each pod replica. This provides stable, per-pod storage identity.

### Basic volumeClaimTemplate

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres-headless
  replicas: 3
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
          value: myapp
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: wal
          mountPath: /var/lib/postgresql/wal
        resources:
          requests:
            cpu: "2"
            memory: "8Gi"
          limits:
            cpu: "4"
            memory: "16Gi"
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 5
          periodSeconds: 5
  volumeClaimTemplates:
  - metadata:
      name: data
      labels:
        app: postgres
        tier: database
      annotations:
        volume.beta.kubernetes.io/storage-class: io2-high-iops
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: io2-high-iops
      resources:
        requests:
          storage: 500Gi
  - metadata:
      name: wal
      labels:
        app: postgres
        tier: wal
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: gp3
      resources:
        requests:
          storage: 100Gi
```

### StatefulSet PVC Naming Convention

StatefulSet creates PVCs following the pattern: `<template-name>-<statefulset-name>-<ordinal>`

```bash
# List PVCs created by a StatefulSet
kubectl get pvc -n production | grep postgres

# Expected output:
# data-postgres-0    Bound    pvc-abc123   500Gi   RWO   io2-high-iops   5d
# data-postgres-1    Bound    pvc-def456   500Gi   RWO   io2-high-iops   5d
# data-postgres-2    Bound    pvc-ghi789   500Gi   RWO   io2-high-iops   5d
# wal-postgres-0     Bound    pvc-jkl012   100Gi   RWO   gp3             5d
# wal-postgres-1     Bound    pvc-mno345   100Gi   RWO   gp3             5d
# wal-postgres-2     Bound    pvc-pqr678   100Gi   RWO   gp3             5d
```

### PVC Retention Policy for StatefulSets

Kubernetes 1.27 GA'd `persistentVolumeClaimRetentionPolicy` which controls PVC lifecycle when pods or the StatefulSet itself are deleted:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: messaging
spec:
  replicas: 3
  serviceName: kafka-headless
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain    # Keep PVCs when StatefulSet is deleted
    whenScaled: Delete     # Delete PVCs when scaling down
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      containers:
      - name: kafka
        image: confluentinc/cp-kafka:7.6.0
        volumeMounts:
        - name: data
          mountPath: /var/kafka-data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: gp3
      resources:
        requests:
          storage: 200Gi
```

## Volume Binding Details

### Selector-Based Binding

PVCs can use label selectors to target specific PVs:

```yaml
# PV with labels for selector matching
apiVersion: v1
kind: PersistentVolume
metadata:
  name: fast-ssd-pv-01
  labels:
    environment: production
    tier: database
    zone: us-east-1a
spec:
  capacity:
    storage: 500Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-storage
  local:
    path: /mnt/nvme/disk1
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - db-node-01
---
# PVC with selector
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: primary-db
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-storage
  selector:
    matchLabels:
      environment: production
      tier: database
      zone: us-east-1a
  resources:
    requests:
      storage: 500Gi
```

### Capacity Matching Rules

The Kubernetes scheduler matches PVCs to PVs based on these rules in order:

1. StorageClass name must match (or both must be empty string)
2. Access modes must be compatible (PV must support all requested modes)
3. PV capacity must be greater than or equal to PVC request
4. Selector must match PV labels (if specified)
5. Volume binding mode constraints must be satisfied

The scheduler selects the smallest PV that satisfies all constraints to minimize waste.

```bash
# Manually verify binding eligibility
kubectl get pv -o json | jq --arg class "gp3" --arg size "100Gi" '
  .items[] |
  select(
    .spec.storageClassName == $class and
    .status.phase == "Available"
  ) |
  {name: .metadata.name, capacity: .spec.capacity.storage, accessModes: .spec.accessModes}
'
```

## Volume Cloning

Volume cloning creates a new volume pre-populated with data from an existing PVC. Both source and destination PVCs must be in the same namespace and use the same StorageClass.

### Basic Volume Clone

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-clone-for-testing
  namespace: staging
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
  dataSource:
    name: postgres-data-postgres-0
    kind: PersistentVolumeClaim
  resources:
    requests:
      storage: 500Gi
```

### Clone for Development Environment

```bash
# Script to clone production PVC to development namespace
#!/bin/bash
SOURCE_NS="production"
TARGET_NS="development"
SOURCE_PVC="postgres-data-postgres-0"
TARGET_PVC="postgres-dev-clone"

# Get source PVC storage class and size
SC=$(kubectl get pvc "$SOURCE_PVC" -n "$SOURCE_NS" \
  -o jsonpath='{.spec.storageClassName}')
SIZE=$(kubectl get pvc "$SOURCE_PVC" -n "$SOURCE_NS" \
  -o jsonpath='{.status.capacity.storage}')

echo "Cloning $SOURCE_PVC ($SIZE, $SC) to $TARGET_NS/$TARGET_PVC"

# Note: Cross-namespace cloning requires VolumeSnapshot as intermediary
# First create snapshot in source namespace
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: prod-snap-for-dev
  namespace: $SOURCE_NS
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: $SOURCE_PVC
EOF

# Wait for snapshot to be ready
kubectl wait volumesnapshot prod-snap-for-dev \
  -n "$SOURCE_NS" \
  --for=condition=ReadyToUse \
  --timeout=300s

# Get snapshot content name for cross-namespace access
SNAP_CONTENT=$(kubectl get volumesnapshot prod-snap-for-dev \
  -n "$SOURCE_NS" \
  -o jsonpath='{.status.boundVolumeSnapshotContentName}')

echo "Snapshot content: $SNAP_CONTENT"
```

## Cross-Namespace Snapshot Workflows

Snapshots are namespace-scoped, but VolumeSnapshotContent is cluster-scoped. This enables cross-namespace data sharing.

### Cross-Namespace Snapshot Restore

```bash
# Step 1: Create snapshot in source namespace
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: prod-db-snapshot
  namespace: production
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data-postgres-0
EOF

# Step 2: Get the VolumeSnapshotContent (cluster-scoped)
kubectl wait volumesnapshot prod-db-snapshot \
  -n production --for=condition=ReadyToUse --timeout=300s

CONTENT_NAME=$(kubectl get volumesnapshot prod-db-snapshot \
  -n production \
  -o jsonpath='{.status.boundVolumeSnapshotContentName}')

SNAPSHOT_HANDLE=$(kubectl get volumesnapshotcontent "$CONTENT_NAME" \
  -o jsonpath='{.status.snapshotHandle}')

echo "Snapshot handle: $SNAPSHOT_HANDLE"

# Step 3: Create a new VolumeSnapshotContent pointing to same snapshot
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: imported-prod-snapshot
spec:
  deletionPolicy: Retain
  driver: ebs.csi.aws.com
  source:
    snapshotHandle: "$SNAPSHOT_HANDLE"
  volumeSnapshotRef:
    name: staging-db-snapshot
    namespace: staging
EOF

# Step 4: Create VolumeSnapshot in target namespace referencing the content
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: staging-db-snapshot
  namespace: staging
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    volumeSnapshotContentName: imported-prod-snapshot
EOF

# Step 5: Restore PVC from snapshot in target namespace
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-postgres-0
  namespace: staging
spec:
  dataSource:
    name: staging-db-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
  resources:
    requests:
      storage: 500Gi
EOF
```

## PVC Protection and Finalizers

Kubernetes uses finalizers to prevent PVC deletion while a pod is actively using it.

```bash
# Check PVC finalizers
kubectl get pvc my-pvc -o jsonpath='{.metadata.finalizers}'
# Output: ["kubernetes.io/pvc-protection"]

# A PVC cannot be deleted while mounted by a running pod
# The deletion will be deferred until the pod is terminated

# Force-remove a stuck PVC (use with caution - only if pod is already gone)
kubectl patch pvc stuck-pvc \
  -p '{"metadata":{"finalizers":null}}'
```

### PV Protection

```bash
# PVs also have protection finalizers
kubectl get pv my-pv -o jsonpath='{.metadata.finalizers}'
# Output: ["kubernetes.io/pv-protection"]
```

## Ephemeral Volumes

For temporary per-pod storage that does not need to persist beyond the pod's lifetime, use ephemeral volumes.

### Generic Ephemeral Volumes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: data-processor
spec:
  containers:
  - name: processor
    image: data-processor:1.0
    volumeMounts:
    - name: scratch-space
      mountPath: /tmp/scratch
    - name: output
      mountPath: /tmp/output
  volumes:
  - name: scratch-space
    ephemeral:
      volumeClaimTemplate:
        metadata:
          labels:
            type: scratch
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: gp3
          resources:
            requests:
              storage: 10Gi
  - name: output
    ephemeral:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: gp3
          resources:
            requests:
              storage: 50Gi
```

The ephemeral volume PVC is created with the pod and deleted when the pod is deleted. The PVC name follows the pattern: `<pod-name>-<volume-name>`.

## Volume Health Monitoring

CSI drivers can report volume health status through the VolumeCondition feature.

```yaml
# Check volume health conditions
kubectl get pvc my-pvc -o jsonpath='{.status.conditions}' | jq .

# Example unhealthy condition output:
# [
#   {
#     "type": "FileSystemResizePending",
#     "status": "True",
#     "lastProbeTime": null,
#     "lastTransitionTime": "2027-05-11T10:00:00Z",
#     "message": "Waiting for user to (re-)start a pod to finish file system resize of volume on node."
#   }
# ]
```

### PVC Health Check Script

```bash
#!/bin/bash
# check-pvc-health.sh

echo "=== PVC Health Report ==="
echo "Generated: $(date)"
echo ""

# Find PVCs in non-Bound state
echo "--- Unhealthy PVCs ---"
kubectl get pvc --all-namespaces \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,STORAGECLASS:.spec.storageClassName,CAPACITY:.resources.requests.storage' \
  | grep -v Bound

echo ""
echo "--- PVCs with Pending Resize ---"
kubectl get pvc --all-namespaces -o json | \
  jq -r '.items[] |
    select(.status.conditions != null) |
    select(.status.conditions[].type == "FileSystemResizePending") |
    "\(.metadata.namespace)/\(.metadata.name)"'

echo ""
echo "--- Released PVs (potential data loss risk) ---"
kubectl get pv --field-selector status.phase=Released \
  -o custom-columns='NAME:.metadata.name,CAPACITY:.spec.capacity.storage,RECLAIM:.spec.persistentVolumeReclaimPolicy,CLAIM:.spec.claimRef.namespace'

echo ""
echo "--- PV Capacity Utilization (requires metrics-server) ---"
kubectl top pods --all-namespaces 2>/dev/null | head -5 || echo "metrics-server not available"
```

## Backup Strategies for PVCs

### Velero-Based Backup

```bash
# Install Velero with AWS S3 backend
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.8.0 \
  --bucket my-velero-backups \
  --secret-file ./credentials-velero \
  --use-volume-snapshots=true \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --use-node-agent

# Create backup including PVCs
velero backup create production-backup \
  --include-namespaces production \
  --volume-snapshot-locations default \
  --snapshot-move-data \
  --storage-location default \
  --ttl 720h

# Create scheduled backup
velero schedule create daily-production \
  --schedule="0 2 * * *" \
  --include-namespaces production \
  --ttl 168h

# Check backup status
velero backup describe production-backup --details

# Restore from backup
velero restore create --from-backup production-backup \
  --include-namespaces production \
  --restore-volumes=true
```

### Manual rsync-Based Backup

```yaml
# Job to back up a PVC to object storage
apiVersion: batch/v1
kind: Job
metadata:
  name: pvc-backup-20270511
  namespace: production
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      serviceAccountName: backup-sa
      volumes:
      - name: source-data
        persistentVolumeClaim:
          claimName: postgres-data-postgres-0
          readOnly: true
      containers:
      - name: backup
        image: amazon/aws-cli:2.15.0
        command:
        - /bin/sh
        - -c
        - |
          aws s3 sync /data s3://my-backup-bucket/postgres/$(date +%Y/%m/%d)/ \
            --sse aws:kms \
            --sse-kms-key-id arn:aws:kms:us-east-1:123456789:key/backup-key \
            --exclude "*.pid" \
            --exclude "postmaster.pid"
        volumeMounts:
        - name: source-data
          mountPath: /data
          readOnly: true
        env:
        - name: AWS_DEFAULT_REGION
          value: us-east-1
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
```

## Troubleshooting PV/PVC Issues

### Debugging Binding Failures

```bash
# PVC not binding - check reasons
kubectl describe pvc <pvc-name> -n <namespace>
# Common messages:
# "no persistent volumes available for this claim and no storage class is set"
# "storageclass.storage.k8s.io "gp3" not found"
# "waiting for a volume to be created, either by external provisioner..."

# Check if StorageClass exists
kubectl get storageclass <storage-class-name>

# Check provisioner pod
kubectl get pods -n kube-system | grep csi

# Check controller-manager logs for binding decisions
kubectl logs -n kube-system \
  -l component=kube-controller-manager \
  --tail=100 | grep -E "pvc|persistentvolume|bind"
```

### Recovering Stuck PVs

```bash
# PV stuck in Terminating state
kubectl get pv <pv-name>

# Remove protection finalizer
kubectl patch pv <pv-name> \
  -p '{"metadata":{"finalizers":null}}'

# PV in Released state that needs to be rebound
# Option 1: Clear claimRef for rebinding
kubectl patch pv <pv-name> \
  -p '{"spec":{"claimRef":null}}'

# Option 2: Manually delete and recreate PV to match new PVC
# (dangerous - only for volumes you are certain have no data)
kubectl delete pv <pv-name>
```

### Volume Not Mounting

```bash
# Check kubelet logs for mount errors
journalctl -u kubelet --since "1 hour ago" | grep -i "mount\|volume\|csi"

# Check CSI node driver logs
kubectl logs -n kube-system \
  $(kubectl get pod -n kube-system -l app=ebs-csi-node -o name | head -1) \
  -c ebs-plugin --tail=100

# Check node status for volume attachment
kubectl describe node <node-name> | grep -A20 "Volumes"

# Manually check volume attachment
kubectl get volumeattachment | grep <pv-name>
```

## Production Operations Runbook

### Pre-Flight PVC Audit

```bash
#!/bin/bash
# pre-flight-pvc-audit.sh

echo "=== Pre-Flight PVC Audit Report ==="
echo "Cluster: $(kubectl config current-context)"
echo "Date: $(date)"
echo ""

ISSUES=0

# 1. Check for PVCs without resource limits
echo "--- PVCs without resource requests ---"
kubectl get pvc --all-namespaces -o json | jq -r '
  .items[] |
  select(.spec.resources.requests.storage == null) |
  "\(.metadata.namespace)/\(.metadata.name)"
'

# 2. Check for PVCs using default StorageClass
echo ""
echo "--- PVCs using default StorageClass (potential misconfiguration) ---"
kubectl get pvc --all-namespaces -o json | jq -r '
  .items[] |
  select(.spec.storageClassName == null or .spec.storageClassName == "") |
  "\(.metadata.namespace)/\(.metadata.name)"
'

# 3. Check for large PVCs (>1Ti) with Delete reclaim policy
echo ""
echo "--- Large PVCs with Delete reclaim policy (data loss risk) ---"
kubectl get pv -o json | jq -r '
  .items[] |
  select(.spec.persistentVolumeReclaimPolicy == "Delete") |
  select(.spec.capacity.storage | test("Ti|[5-9][0-9]{2}Gi|[0-9]{4}Gi")) |
  "\(.metadata.name): \(.spec.capacity.storage) [\(.spec.persistentVolumeReclaimPolicy)]"
'

# 4. Check for PVCs approaching capacity (requires prometheus)
echo ""
echo "--- Summary ---"
TOTAL=$(kubectl get pvc --all-namespaces --no-headers | wc -l)
BOUND=$(kubectl get pvc --all-namespaces --no-headers | grep Bound | wc -l)
PENDING=$(kubectl get pvc --all-namespaces --no-headers | grep Pending | wc -l)
echo "Total PVCs: $TOTAL"
echo "Bound: $BOUND"
echo "Pending: $PENDING"
```

The PV/PVC lifecycle system provides powerful abstractions for managing stateful storage in Kubernetes. Understanding access modes, reclaim policies, and the binding state machine allows teams to design storage architectures that are both resilient and operationally manageable. Regular audits of PVC health, reclaim policies, and capacity utilization prevent the silent data loss risks that plague teams unfamiliar with the full lifecycle semantics.
