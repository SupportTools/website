---
title: "Kubernetes Snapshot and Restore: VolumeSnapshot API"
date: 2029-05-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VolumeSnapshot", "Storage", "CSI", "Backup", "Restore", "PersistentVolume"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to the Kubernetes VolumeSnapshot API: VolumeSnapshotClass setup, creating VolumeSnapshot objects, VolumeSnapshotContent management, CSI snapshot controller deployment, restore workflows, and cross-namespace restore patterns for production backup strategies."
more_link: "yes"
url: "/kubernetes-volume-snapshot-restore-api/"
---

VolumeSnapshots provide a standardized way to capture point-in-time copies of PersistentVolumes in Kubernetes. Unlike ad-hoc backup scripts, the VolumeSnapshot API integrates with CSI drivers to take storage-layer snapshots that are crash-consistent and often near-instantaneous (depending on the storage backend). This post covers the complete lifecycle from VolumeSnapshotClass configuration through cross-namespace restore, including the operational details that make snapshot-based workflows production-reliable.

<!--more-->

# Kubernetes Snapshot and Restore: VolumeSnapshot API

## Section 1: VolumeSnapshot API Architecture

The VolumeSnapshot API is a Kubernetes extension (currently beta/GA depending on version) with three core resource types:

```
VolumeSnapshot          (namespace-scoped, user-facing)
  └── bound to
VolumeSnapshotContent   (cluster-scoped, like PersistentVolume)
  └── uses
VolumeSnapshotClass     (cluster-scoped, like StorageClass)
```

The CSI external-snapshotter sidecar watches these resources and calls the CSI driver's `CreateSnapshot` and `DeleteSnapshot` RPCs.

### Component Overview

```
kubectl create VolumeSnapshot
        │
        ▼
external-snapshotter controller
        │
        ├── Validates VolumeSnapshotClass
        ├── Creates VolumeSnapshotContent
        └── Calls CSI Driver
                │
                └── Storage API (AWS EBS CreateSnapshot, etc.)
```

## Section 2: Installation

### Installing the CSI Snapshotter

```bash
# Clone the external-snapshotter repo
SNAPSHOTTER_VERSION="v7.0.1"
git clone --branch ${SNAPSHOTTER_VERSION} \
  https://github.com/kubernetes-csi/external-snapshotter.git
cd external-snapshotter

# Install CRDs (VolumeSnapshot, VolumeSnapshotContent, VolumeSnapshotClass)
kubectl apply -f client/config/crd/

# Verify CRDs are installed
kubectl get crd | grep snapshot
# volumesnapshotclasses.snapshot.storage.k8s.io
# volumesnapshotcontents.snapshot.storage.k8s.io
# volumesnapshots.snapshot.storage.k8s.io

# Install the snapshot controller (cluster-level)
kubectl apply -f deploy/kubernetes/snapshot-controller/
```

### Deploy Snapshot Controller with RBAC

```yaml
# snapshot-controller.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: snapshot-controller
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: snapshot-controller-runner
rules:
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims"]
  verbs: ["get", "list", "watch", "update"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["list", "watch", "create", "update", "patch"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshotclasses"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshotcontents"]
  verbs: ["create", "get", "list", "watch", "update", "delete", "patch"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshotcontents/status"]
  verbs: ["patch"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshots"]
  verbs: ["get", "list", "watch", "update", "patch"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshots/status"]
  verbs: ["update", "patch"]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: snapshot-controller
  namespace: kube-system
spec:
  replicas: 2  # HA deployment
  selector:
    matchLabels:
      app: snapshot-controller
  template:
    metadata:
      labels:
        app: snapshot-controller
    spec:
      serviceAccountName: snapshot-controller
      containers:
      - name: snapshot-controller
        image: registry.k8s.io/sig-storage/snapshot-controller:v7.0.1
        args:
        - "--v=5"
        - "--leader-election=true"
        - "--leader-election-namespace=kube-system"
        imagePullPolicy: IfNotPresent
```

## Section 3: VolumeSnapshotClass

VolumeSnapshotClass is analogous to StorageClass — it specifies which CSI driver handles snapshots and its parameters.

### AWS EBS VolumeSnapshotClass

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshot-class
  annotations:
    # Make this the default snapshot class
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Delete   # Delete or Retain
parameters:
  # EBS-specific parameters
  # Tag snapshots for cost allocation
  tagSpecification_1: "key=Environment,value=production"
  tagSpecification_2: "key=ManagedBy,value=kubernetes"
  # CSI Driver specific parameters
  # csi.storage.k8s.io/snapshotter-secret-name: ebs-secret
```

### GCE PD VolumeSnapshotClass

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: gce-pd-snapshot-class
driver: pd.csi.storage.gke.io
deletionPolicy: Delete
parameters:
  storage-locations: us-central1  # Snapshot region
  # Snapshot type: standard or archive
  # "type": "standard"
```

### Longhorn VolumeSnapshotClass

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-snapshot-class
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

### Rook-Ceph VolumeSnapshotClass

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-rbdplugin-snapclass
driver: rook-ceph.rbd.csi.ceph.com
parameters:
  # Ceph cluster connection
  clusterID: rook-ceph
  csi.storage.k8s.io/snapshotter-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/snapshotter-secret-namespace: rook-ceph
deletionPolicy: Delete
```

## Section 4: Creating VolumeSnapshots

### Manual Snapshot

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-20290515
  namespace: production
  labels:
    app: postgres
    backup-type: manual
  annotations:
    description: "Pre-upgrade snapshot before PostgreSQL 16 migration"
spec:
  volumeSnapshotClassName: ebs-snapshot-class
  source:
    # Reference to the PVC to snapshot
    persistentVolumeClaimName: postgres-data
```

```bash
# Apply and watch status
kubectl apply -f postgres-snapshot.yaml

# Wait for snapshot to be ready
kubectl wait volumesnapshot postgres-snapshot-20290515 \
  -n production \
  --for=condition=ReadyToUse=true \
  --timeout=300s

# Check snapshot details
kubectl describe volumesnapshot postgres-snapshot-20290515 -n production
```

### Scheduled Snapshots with CronJob

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: snapshot-creator
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: snapshot-creator
  namespace: production
rules:
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshots"]
  verbs: ["get", "list", "create", "delete"]
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-snapshot-daily
  namespace: production
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: snapshot-creator
          restartPolicy: OnFailure
          containers:
          - name: snapshot-creator
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              set -e
              DATE=$(date +%Y%m%d-%H%M%S)
              SNAPSHOT_NAME="postgres-auto-${DATE}"
              NAMESPACE="production"
              RETENTION_DAYS=7

              # Create snapshot
              cat <<EOF | kubectl apply -f -
              apiVersion: snapshot.storage.k8s.io/v1
              kind: VolumeSnapshot
              metadata:
                name: ${SNAPSHOT_NAME}
                namespace: ${NAMESPACE}
                labels:
                  backup-type: automatic
                  app: postgres
              spec:
                volumeSnapshotClassName: ebs-snapshot-class
                source:
                  persistentVolumeClaimName: postgres-data
              EOF

              # Wait for ready
              kubectl wait volumesnapshot "${SNAPSHOT_NAME}" \
                -n "${NAMESPACE}" \
                --for=condition=ReadyToUse=true \
                --timeout=300s

              echo "Snapshot ${SNAPSHOT_NAME} created successfully"

              # Prune old snapshots
              CUTOFF=$(date -d "-${RETENTION_DAYS} days" +%Y%m%d)
              kubectl get volumesnapshot -n "${NAMESPACE}" \
                -l backup-type=automatic,app=postgres \
                -o json | \
                jq -r '.items[] | select(.metadata.name | test("postgres-auto-")) |
                  select((.metadata.name | split("-") | .[2]) < "'"${CUTOFF}"'") |
                  .metadata.name' | \
                while read name; do
                  echo "Deleting old snapshot: $name"
                  kubectl delete volumesnapshot "$name" -n "${NAMESPACE}"
                done
```

### Verifying Snapshot Status

```bash
# List all snapshots in a namespace
kubectl get volumesnapshot -n production
# NAME                        READYTOUSE   SOURCEPVC       SOURCESNAPSHOTCONTENT   RESTORESIZE   SNAPSHOTCLASS          SNAPSHOTCONTENT                               CREATIONTIME   AGE
# postgres-snapshot-20290515   true         postgres-data                           20Gi          ebs-snapshot-class     snapcontent-abc123                            2m             5m

# Get snapshot content (cluster-scoped)
kubectl get volumesnapshotcontent
# NAME                   READYTOUSE   RESTORESIZE   DELETIONPOLICY   DRIVER           VOLUMESNAPSHOTCLASS     VOLUMESNAPSHOT                      VOLUMESNAPSHOTNAMESPACE   AGE
# snapcontent-abc123     true         21474836480   Delete           ebs.csi.aws.com  ebs-snapshot-class      postgres-snapshot-20290515          production                5m

# Full details
kubectl describe volumesnapshotcontent snapcontent-abc123
# Shows the underlying storage snapshot ID (e.g., snap-0abc1234def56789)

# Check error conditions
kubectl get volumesnapshot -n production -o jsonpath=\
'{range .items[*]}{.metadata.name}: readyToUse={.status.readyToUse} error={.status.error.message}{"\n"}{end}'
```

## Section 5: VolumeSnapshotContent

VolumeSnapshotContent represents the actual snapshot on the storage system. It can be dynamically created by VolumeSnapshot or pre-provisioned for importing existing storage snapshots.

### Pre-Provisioned VolumeSnapshotContent

Import an existing storage snapshot into Kubernetes:

```yaml
# Step 1: Create VolumeSnapshotContent pointing to existing snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: imported-snapshot-content
spec:
  deletionPolicy: Retain  # Don't delete underlying snapshot when this is deleted
  driver: ebs.csi.aws.com
  source:
    # The actual storage snapshot ID
    snapshotHandle: snap-0abc1234def56789
  volumeSnapshotRef:
    name: imported-snapshot
    namespace: production
    # UID will be set after VolumeSnapshot is created
---
# Step 2: Create VolumeSnapshot referencing the content
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: imported-snapshot
  namespace: production
spec:
  source:
    # Reference the pre-created content (not a PVC)
    volumeSnapshotContentName: imported-snapshot-content
```

```bash
# Verify the import
kubectl get volumesnapshot imported-snapshot -n production
# Should show readyToUse=true

# Update VolumeSnapshotContent with the VolumeSnapshot UID
SNAPSHOT_UID=$(kubectl get volumesnapshot imported-snapshot -n production \
  -o jsonpath='{.metadata.uid}')

kubectl patch volumesnapshotcontent imported-snapshot-content \
  --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/volumeSnapshotRef/uid\",\"value\":\"${SNAPSHOT_UID}\"}]"
```

### Retention Policy

```yaml
# Retain: when VolumeSnapshot is deleted, VolumeSnapshotContent stays
# Useful for long-term backup archives
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: retained-snapshots
driver: ebs.csi.aws.com
deletionPolicy: Retain  # vs Delete
```

```bash
# Check if content is retained after snapshot deletion
kubectl delete volumesnapshot postgres-snapshot-20290515 -n production

# Content should still exist with status: Released
kubectl get volumesnapshotcontent
# Status changes from Bound to Released

# Manually delete retained content when no longer needed
kubectl delete volumesnapshotcontent snapcontent-abc123
```

## Section 6: Restore Workflow

### Restore to Same Namespace

```yaml
# Restore: create a PVC from a snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  storageClassName: gp3-csi  # Must be compatible with snapshot's driver
  dataSource:
    name: postgres-snapshot-20290515
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      # Must be >= snapshot's restoreSize
      storage: 20Gi
```

```bash
# Monitor PVC creation
kubectl get pvc postgres-data-restored -n production -w
# NAME                      STATUS    VOLUME     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# postgres-data-restored    Pending                                        gp3-csi        5s
# postgres-data-restored    Bound     pvc-xyz    20Gi       RWO            gp3-csi        45s

# The PVC is ready to use — mount it in a pod for validation
kubectl run restore-validator \
  --image=postgres:16 \
  --restart=Never \
  --env="PGDATA=/data" \
  --overrides='{
    "spec": {
      "volumes": [{"name":"data","persistentVolumeClaim":{"claimName":"postgres-data-restored"}}],
      "containers": [{"name":"restore-validator","image":"postgres:16",
        "command":["postgres","-D","/data","--check-data-checksums"],
        "volumeMounts":[{"name":"data","mountPath":"/data"}]}]
    }
  }'
```

### Restore Strategy for Stateful Applications

```bash
#!/bin/bash
# restore_postgres.sh - Safe restore procedure for PostgreSQL

NAMESPACE="production"
APP="postgres"
SNAPSHOT_NAME="${1:-}"  # Pass snapshot name or use latest

if [ -z "$SNAPSHOT_NAME" ]; then
    # Find the most recent successful snapshot
    SNAPSHOT_NAME=$(kubectl get volumesnapshot -n "$NAMESPACE" \
      -l "app=$APP,backup-type=automatic" \
      -o json | \
      jq -r '.items | sort_by(.metadata.creationTimestamp) | reverse | .[0] | .metadata.name')
    echo "Using latest snapshot: $SNAPSHOT_NAME"
fi

# Verify snapshot is ready
READY=$(kubectl get volumesnapshot "$SNAPSHOT_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.readyToUse}')
if [ "$READY" != "true" ]; then
    echo "ERROR: Snapshot $SNAPSHOT_NAME is not ready (readyToUse=$READY)"
    exit 1
fi

RESTORE_SIZE=$(kubectl get volumesnapshot "$SNAPSHOT_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.restoreSize}')
echo "Restore size: $RESTORE_SIZE"

# Step 1: Scale down the application
echo "Scaling down postgres..."
kubectl scale statefulset postgres --replicas=0 -n "$NAMESPACE"
kubectl wait pod -l "app=$APP" -n "$NAMESPACE" \
  --for=delete --timeout=120s

# Step 2: Create restore PVC
RESTORE_PVC="postgres-data-restore-$(date +%Y%m%d%H%M%S)"
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${RESTORE_PVC}
  namespace: ${NAMESPACE}
spec:
  storageClassName: gp3-csi
  dataSource:
    name: ${SNAPSHOT_NAME}
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: ${RESTORE_SIZE}
EOF

# Wait for PVC to be bound
echo "Waiting for restore PVC to be bound..."
kubectl wait pvc "$RESTORE_PVC" -n "$NAMESPACE" \
  --for=jsonpath='{.status.phase}'=Bound \
  --timeout=300s

# Step 3: Swap PVC (rename old, rename new)
OLD_PVC="postgres-data"
BACKUP_PVC="postgres-data-pre-restore-$(date +%Y%m%d%H%M%S)"

# The StatefulSet uses volumeClaimTemplate, so we patch the PV directly
OLD_PV=$(kubectl get pvc "$OLD_PVC" -n "$NAMESPACE" -o jsonpath='{.spec.volumeName}')
kubectl patch pv "$OLD_PV" \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

kubectl delete pvc "$OLD_PVC" -n "$NAMESPACE"

# Rename restore PVC to match StatefulSet expectation
# (StatefulSet expects specific PVC name based on template)
# Alternative: update StatefulSet volumeClaimTemplate reference

# Step 4: Scale up with restored data
echo "Scaling up postgres with restored data..."
kubectl scale statefulset postgres --replicas=3 -n "$NAMESPACE"

# Step 5: Wait for readiness
kubectl rollout status statefulset/postgres -n "$NAMESPACE" --timeout=300s

echo "Restore complete from snapshot: $SNAPSHOT_NAME"
```

## Section 7: Cross-Namespace Restore

The VolumeSnapshot API doesn't natively support cross-namespace restore — a VolumeSnapshot in namespace A cannot directly be used as a PVC dataSource in namespace B. The solution is to use pre-provisioned VolumeSnapshotContent.

### Cross-Namespace Restore Pattern

```bash
#!/bin/bash
# cross_namespace_restore.sh

SOURCE_NAMESPACE="production"
TARGET_NAMESPACE="staging"
SNAPSHOT_NAME="postgres-snapshot-20290515"

# Step 1: Get the VolumeSnapshotContent name
CONTENT_NAME=$(kubectl get volumesnapshot "$SNAPSHOT_NAME" \
  -n "$SOURCE_NAMESPACE" \
  -o jsonpath='{.status.boundVolumeSnapshotContentName}')

SNAPSHOT_HANDLE=$(kubectl get volumesnapshotcontent "$CONTENT_NAME" \
  -o jsonpath='{.status.snapshotHandle}')

RESTORE_SIZE=$(kubectl get volumesnapshot "$SNAPSHOT_NAME" \
  -n "$SOURCE_NAMESPACE" \
  -o jsonpath='{.status.restoreSize}')

echo "Content: $CONTENT_NAME"
echo "Handle: $SNAPSHOT_HANDLE"
echo "Restore size: $RESTORE_SIZE"

# Step 2: Create a new VolumeSnapshotContent in cluster scope
# pointing to the same underlying storage snapshot
NEW_CONTENT_NAME="cross-ns-restore-$(date +%Y%m%d%H%M%S)"
NEW_SNAPSHOT_NAME="postgres-from-production"

cat <<EOF | kubectl apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: ${NEW_CONTENT_NAME}
spec:
  deletionPolicy: Retain
  driver: ebs.csi.aws.com
  source:
    snapshotHandle: ${SNAPSHOT_HANDLE}
  volumeSnapshotRef:
    name: ${NEW_SNAPSHOT_NAME}
    namespace: ${TARGET_NAMESPACE}
EOF

# Step 3: Create VolumeSnapshot in target namespace
cat <<EOF | kubectl apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${NEW_SNAPSHOT_NAME}
  namespace: ${TARGET_NAMESPACE}
spec:
  source:
    volumeSnapshotContentName: ${NEW_CONTENT_NAME}
EOF

# Patch with UID
SNAPSHOT_UID=$(kubectl get volumesnapshot "$NEW_SNAPSHOT_NAME" \
  -n "$TARGET_NAMESPACE" \
  -o jsonpath='{.metadata.uid}')

kubectl patch volumesnapshotcontent "$NEW_CONTENT_NAME" \
  --type=json \
  -p "[{\"op\":\"add\",\"path\":\"/spec/volumeSnapshotRef/uid\",\"value\":\"${SNAPSHOT_UID}\"}]"

# Wait for ready
kubectl wait volumesnapshot "$NEW_SNAPSHOT_NAME" \
  -n "$TARGET_NAMESPACE" \
  --for=condition=ReadyToUse=true \
  --timeout=120s

echo "Snapshot available in $TARGET_NAMESPACE as $NEW_SNAPSHOT_NAME"

# Step 4: Create PVC in target namespace from cross-namespace snapshot
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: ${TARGET_NAMESPACE}
spec:
  storageClassName: gp3-csi
  dataSource:
    name: ${NEW_SNAPSHOT_NAME}
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: ${RESTORE_SIZE}
EOF

kubectl wait pvc postgres-data -n "$TARGET_NAMESPACE" \
  --for=jsonpath='{.status.phase}'=Bound \
  --timeout=300s

echo "Cross-namespace restore complete!"
```

## Section 8: Integrating Snapshots with Backup Tools

### Velero Integration

Velero can use CSI volume snapshots for PVC backup:

```yaml
# Enable CSI snapshot support in Velero
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-velero-backups
    prefix: velero
  config:
    region: us-east-1
---
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-default
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
---
# Enable CSI plugin
# velero install --use-volume-snapshots=true \
#   --plugins velero/velero-plugin-for-csi:v0.7.0
```

```bash
# Create backup with CSI snapshots
velero backup create postgres-backup-$(date +%Y%m%d) \
  --include-namespaces production \
  --snapshot-volumes=true \
  --volume-snapshot-locations aws-default \
  --storage-location default

# Check backup status
velero backup describe postgres-backup-20290515 --details

# Restore to new namespace
velero restore create \
  --from-backup postgres-backup-20290515 \
  --namespace-mappings production:staging-restore \
  --restore-volumes=true
```

### Snapshot Metrics and Alerting

```yaml
# PrometheusRule for snapshot monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: volumesnapshot-alerts
  namespace: monitoring
spec:
  groups:
  - name: volumesnapshots
    rules:
    - alert: VolumeSnapshotNotReady
      expr: |
        kube_volumesnapshot_info{ready_to_use="false"} == 1
        and on(volumesnapshot, namespace)
        (time() - kube_volumesnapshot_creation_timestamp_seconds) > 600
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "VolumeSnapshot {{ $labels.volumesnapshot }} not ready after 10 minutes"

    - alert: VolumeSnapshotBackupAge
      expr: |
        (time() - max by (namespace) (
          kube_volumesnapshot_creation_timestamp_seconds{
            label_backup_type="automatic"
          }
        )) > 86400 * 2  # > 2 days old
      labels:
        severity: critical
      annotations:
        summary: "No recent backup snapshot in namespace {{ $labels.namespace }}"
```

The VolumeSnapshot API provides a standardized, CSI-driver-agnostic mechanism for point-in-time storage copies. The operational workflow presented here — VolumeSnapshotClass setup, scheduled creation, cross-namespace restore, and integration with Velero — covers the full lifecycle for production database backup and disaster recovery scenarios.
