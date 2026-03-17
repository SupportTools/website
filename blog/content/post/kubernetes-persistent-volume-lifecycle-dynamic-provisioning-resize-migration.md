---
title: "Kubernetes Persistent Volume Lifecycle: Dynamic Provisioning, Resize, and Migration"
date: 2030-06-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "PersistentVolume", "CSI", "StorageClass", "Volume Snapshots", "Dynamic Provisioning"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise PV management: StorageClass parameters, WaitForFirstConsumer binding, online volume resize, volume snapshots, data migration between storage classes, and CSI driver troubleshooting."
more_link: "yes"
url: "/kubernetes-persistent-volume-lifecycle-dynamic-provisioning-resize-migration/"
---

Persistent volumes in Kubernetes exist at the intersection of the storage subsystem and the scheduler, which makes them uniquely difficult to reason about. A PVC can be stuck in Pending for reasons that span CSI driver health, node availability, topology constraints, and RBAC. Volume resize involves a negotiation between the API server, the CSI driver, and the node's kubelet. Data migration between storage classes requires snapshot support, restore coordination, and careful application quiescence. Understanding the full lifecycle — from StorageClass design to cross-class migration — prevents the class of storage incidents that most teams only understand after experiencing them.

<!--more-->

## StorageClass Architecture

### StorageClass Parameters

A StorageClass defines the provisioner, reclaim policy, and driver-specific parameters. Every parameter is passed directly to the CSI driver's `CreateVolume` call, making the valid parameters specific to each driver.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-xfs
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"          # gp3: 3000-16000 IOPS
  throughput: "250"      # gp3: 125-1000 MB/s
  fsType: xfs
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
reclaimPolicy: Retain    # Retain | Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
mountOptions:
- noatime
- nodiratime
- logbufs=8
allowedTopologies:
- matchLabelExpressions:
  - key: topology.ebs.csi.aws.com/zone
    values:
    - us-east-1a
    - us-east-1b
    - us-east-1c
```

### Volume Binding Modes

**Immediate binding** (`volumeBindingMode: Immediate`) creates the PV as soon as the PVC is submitted. The PV is provisioned in a zone determined by the CSI driver before the scheduler has decided where the pod runs. If the PV lands in a different zone than the node the scheduler chooses, the pod can never start.

**WaitForFirstConsumer** delays PV provisioning until a pod using the PVC is scheduled to a specific node. The scheduler's topology decisions (node affinity, pod anti-affinity, resource availability) determine which zone the PV is provisioned in, eliminating the zone-mismatch problem.

```yaml
# Always use WaitForFirstConsumer for topology-aware storage
volumeBindingMode: WaitForFirstConsumer
```

The exception: storage that is not topology-constrained (e.g., NFS, Ceph RBD without zone isolation) can safely use `Immediate`.

### Reclaim Policy Selection

- `Delete`: When the PVC is deleted, the PV and underlying storage are deleted. Use for ephemeral workloads.
- `Retain`: When the PVC is deleted, the PV and underlying storage persist. Requires manual cleanup. Use for production databases.

For production, always use `Retain` and implement automated cleanup pipelines that verify data has been backed up before reclaiming.

## PersistentVolumeClaim Lifecycle

### PVC States

```
PVC States:
Pending  ->  Bound  ->  (Released after PVC deletion with Retain policy)
    ^
    |-- Waiting for:
        - Available PV matching storage request
        - CSI driver to provision PV (dynamic provisioning)
        - WaitForFirstConsumer: pod to be scheduled first
        - Storage quota availability
```

### PVC Definition

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
  labels:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/component: database
  annotations:
    # Document the workload using this volume for audit purposes
    storage.company.com/owner: "platform-team"
    storage.company.com/criticality: "high"
    storage.company.com/backup-schedule: "hourly"
spec:
  storageClassName: gp3-xfs
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
  # Optional: request specific volume attributes (CSI feature gates)
  volumeAttributesClassName: fast-io
```

### Diagnosing Stuck PVCs

```bash
# Check PVC status
kubectl get pvc postgres-data -n production -o wide

# Detailed events
kubectl describe pvc postgres-data -n production

# Check if provisioner is running
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-ebs-csi-driver

# Check CSI driver logs for provisioning errors
kubectl logs -n kube-system \
  -l app=ebs-csi-controller \
  -c csi-provisioner \
  --tail=100 | grep -E "ERROR|error|postgres-data"

# For WaitForFirstConsumer: check if any pod is referencing the PVC
kubectl get pods -n production -o json | \
  jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName == "postgres-data") | .metadata.name'

# Check node topology labels match StorageClass allowed topologies
kubectl get nodes -o json | \
  jq -r '.items[] | "\(.metadata.name): \(.metadata.labels | to_entries[] | select(.key | startswith("topology.")) | "\(.key)=\(.value)")"'
```

## Online Volume Resize

Volume expansion requires the StorageClass to have `allowVolumeExpansion: true`. As of Kubernetes 1.24, online expansion (without stopping the pod) is supported for most CSI drivers that implement the `EXPAND_VOLUME` controller capability and `NODE_EXPAND_VOLUME` node capability.

### Expanding a PVC

```bash
# Current size
kubectl get pvc postgres-data -n production

# Expand the PVC by patching the resource request
kubectl patch pvc postgres-data -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/resources/requests/storage", "value": "750Gi"}]'

# Monitor expansion progress
kubectl get pvc postgres-data -n production -w

# The PVC goes through these conditions:
# status.conditions[FileSystemResizePending]: true   <- controller expanded, waiting for node
# status.capacity.storage: 750Gi                    <- expansion complete
```

### Expansion Status

```bash
# Detailed expansion status
kubectl get pvc postgres-data -n production -o yaml | \
  yq '.status'

# Expected output when expansion is pending node-side resize:
# capacity:
#   storage: 500Gi         <- old size until node resize completes
# conditions:
# - lastProbeTime: null
#   lastTransitionTime: "2030-06-29T10:00:00Z"
#   message: Waiting for user to (re-)start a pod to finish file system resize of volume
#   status: "True"
#   type: FileSystemResizePending

# Check if node-side expansion completed
kubectl describe pvc postgres-data -n production | grep -A5 "Conditions:"
```

### Resize Troubleshooting

```bash
# If expansion is stuck at FileSystemResizePending, check node-plugin logs
NODE=$(kubectl get pod postgres-0 -n production -o jsonpath='{.spec.nodeName}')
NODE_POD=$(kubectl get pods -n kube-system \
  -o jsonpath="{.items[?(@.spec.nodeName=='$NODE')].metadata.name}" \
  -l app=ebs-csi-node)

kubectl logs -n kube-system $NODE_POD -c node-driver-registrar --tail=50

# Check kubelet logs on the node for resize errors
journalctl -u kubelet --since "30 minutes ago" | grep -i "resize\|expand"

# For cases where the pod needs a restart to trigger node resize,
# perform a rolling restart
kubectl rollout restart statefulset/postgres -n production
```

## Volume Snapshots

Volume snapshots capture the state of a PV at a point in time. They support both backup and cloning workflows.

### VolumeSnapshotClass

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  # AWS EBS CSI specific: tag the snapshot
  csi.storage.k8s.io/volumesnapshot/name: ${volumesnapshot.name}
  csi.storage.k8s.io/volumesnapshot/namespace: ${volumesnapshot.namespace}
  csi.storage.k8s.io/volumesnapshotcontent/name: ${volumesnapshotcontent.name}
```

### Creating a Snapshot

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-20300629
  namespace: production
  labels:
    app.kubernetes.io/name: postgres
    backup-type: pre-migration
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data
```

```bash
# Monitor snapshot status
kubectl get volumesnapshot postgres-data-20300629 -n production -w

# Snapshot is ready when READYTOUSE=true
# NAME                       READYTOUSE   SOURCEPVC       SOURCESNAPSHOTCONTENT  RESTORESIZE   SNAPSHOTCLASS  SNAPSHOTCONTENT                                    CREATIONTIME   AGE
# postgres-data-20300629     true         postgres-data                          500Gi         ebs-vsc        snapcontent-abc123                                 2m             2m

# Get snapshot content details (contains provider-specific snapshot ID)
kubectl describe volumesnapshotcontent snapcontent-abc123
```

### Restoring from Snapshot

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  storageClassName: gp3-xfs
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi  # Must be >= snapshot size
  dataSource:
    name: postgres-data-20300629
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

### Volume Cloning

Cloning creates a new PVC with identical contents to an existing PVC, using the CSI driver's clone capability (faster than snapshot+restore for same-driver copies):

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-clone
  namespace: production
spec:
  storageClassName: gp3-xfs
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
  dataSource:
    name: postgres-data        # Source PVC
    kind: PersistentVolumeClaim
```

## Data Migration Between Storage Classes

Migrating data from one StorageClass to another (e.g., from gp2 to gp3, or from one CSI driver to another) requires copying data while maintaining consistency.

### Strategy 1: Snapshot-Restore with Target StorageClass

```bash
#!/bin/bash
# migrate-pvc.sh
# Migrates a PVC to a new StorageClass using snapshot+restore

SOURCE_PVC="postgres-data"
TARGET_SC="gp3-xfs"
NAMESPACE="production"
SNAPSHOT_NAME="${SOURCE_PVC}-migration-$(date +%Y%m%d%H%M%S)"

echo "Step 1: Create snapshot of source PVC"
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: $SNAPSHOT_NAME
  namespace: $NAMESPACE
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: $SOURCE_PVC
EOF

# Wait for snapshot to be ready
echo "Waiting for snapshot to be ready..."
kubectl wait volumesnapshot/$SNAPSHOT_NAME \
  -n $NAMESPACE \
  --for=jsonpath='{.status.readyToUse}'=true \
  --timeout=600s

echo "Step 2: Scale down the workload"
kubectl scale statefulset/postgres -n $NAMESPACE --replicas=0
kubectl wait --for=delete pod/postgres-0 -n $NAMESPACE --timeout=120s

echo "Step 3: Create new PVC from snapshot with new StorageClass"
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${SOURCE_PVC}-new
  namespace: $NAMESPACE
spec:
  storageClassName: $TARGET_SC
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: $(kubectl get pvc $SOURCE_PVC -n $NAMESPACE -o jsonpath='{.spec.resources.requests.storage}')
  dataSource:
    name: $SNAPSHOT_NAME
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF

# Wait for new PVC to be bound
kubectl wait pvc/${SOURCE_PVC}-new -n $NAMESPACE \
  --for=jsonpath='{.status.phase}'=Bound \
  --timeout=300s

echo "Step 4: Rename PVCs (requires StatefulSet volume claim template update)"
# StatefulSets reference PVCs by name in volumeClaimTemplates
# The PVC name pattern is: <claim-name>-<pod-name>
# For pod postgres-0, the PVC is postgres-data-postgres-0
# Renaming requires:
# 1. Delete old PVC (with Retain policy, PV persists)
# 2. Create a new PVC with the original name bound to the new PV
OLD_PV=$(kubectl get pvc $SOURCE_PVC -n $NAMESPACE -o jsonpath='{.spec.volumeName}')
NEW_PV=$(kubectl get pvc ${SOURCE_PVC}-new -n $NAMESPACE -o jsonpath='{.spec.volumeName}')

echo "Old PV: $OLD_PV"
echo "New PV: $NEW_PV"

echo "Migration complete. Scale up the workload and verify data."
echo "kubectl scale statefulset/postgres -n $NAMESPACE --replicas=1"
```

### Strategy 2: rsync-Based Migration

For workloads where snapshot support is unavailable:

```yaml
# migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pvc-migration-rsync
  namespace: production
spec:
  template:
    spec:
      restartPolicy: OnFailure
      volumes:
      - name: source
        persistentVolumeClaim:
          claimName: postgres-data
          readOnly: true
      - name: target
        persistentVolumeClaim:
          claimName: postgres-data-new
      containers:
      - name: rsync
        image: alpine:3.19
        command:
        - sh
        - -c
        - |
          apk add --no-cache rsync
          echo "Starting rsync migration..."
          rsync -avz --progress --delete \
            /source/ /target/
          echo "Verifying..."
          SOURCE_SIZE=$(du -sb /source | cut -f1)
          TARGET_SIZE=$(du -sb /target | cut -f1)
          echo "Source: $SOURCE_SIZE bytes, Target: $TARGET_SIZE bytes"
          if [ "$SOURCE_SIZE" -eq "$TARGET_SIZE" ]; then
            echo "Migration successful"
          else
            echo "WARNING: Size mismatch"
            exit 1
          fi
        volumeMounts:
        - name: source
          mountPath: /source
          readOnly: true
        - name: target
          mountPath: /target
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 1Gi
```

### StatefulSet PVC Migration

StatefulSets complicate PVC migration because the PVC names are derived from the volumeClaimTemplate name and pod ordinal. To migrate a StatefulSet's PVCs:

```bash
#!/bin/bash
# statefulset-pvc-migrate.sh
# Migrates all PVCs in a StatefulSet to a new StorageClass

SS_NAME="postgres"
CLAIM_TEMPLATE_NAME="data"
NAMESPACE="production"
NEW_SC="gp3-xfs"
REPLICAS=$(kubectl get statefulset $SS_NAME -n $NAMESPACE \
  -o jsonpath='{.spec.replicas}')

# Scale down
kubectl scale statefulset/$SS_NAME -n $NAMESPACE --replicas=0

for i in $(seq 0 $((REPLICAS - 1))); do
    PVC_NAME="${CLAIM_TEMPLATE_NAME}-${SS_NAME}-${i}"
    echo "Processing PVC: $PVC_NAME"

    # Get current size
    SIZE=$(kubectl get pvc $PVC_NAME -n $NAMESPACE \
      -o jsonpath='{.spec.resources.requests.storage}')

    # Create snapshot
    SNAPSHOT="${PVC_NAME}-migration"
    kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: $SNAPSHOT
  namespace: $NAMESPACE
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: $PVC_NAME
EOF

    kubectl wait volumesnapshot/$SNAPSHOT -n $NAMESPACE \
      --for=jsonpath='{.status.readyToUse}'=true \
      --timeout=600s

    # Get old PV name
    OLD_PV=$(kubectl get pvc $PVC_NAME -n $NAMESPACE \
      -o jsonpath='{.spec.volumeName}')

    # Delete old PVC (PV retained)
    kubectl delete pvc $PVC_NAME -n $NAMESPACE

    # Create new PVC from snapshot with new StorageClass and SAME NAME
    kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $PVC_NAME
  namespace: $NAMESPACE
spec:
  storageClassName: $NEW_SC
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: $SIZE
  dataSource:
    name: $SNAPSHOT
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF

    kubectl wait pvc/$PVC_NAME -n $NAMESPACE \
      --for=jsonpath='{.status.phase}'=Bound \
      --timeout=300s

    echo "PVC $PVC_NAME migrated successfully"
done

# Scale back up
kubectl scale statefulset/$SS_NAME -n $NAMESPACE --replicas=$REPLICAS
echo "StatefulSet migration complete. Scaling back to $REPLICAS replicas."
```

## CSI Driver Troubleshooting

### CSI Driver Architecture

```
API Server
    |
    v
External Provisioner (sidecar) <-> CSI Controller Plugin
External Resizer (sidecar)     <->      |
External Snapshotter (sidecar) <->      |
    |                                   v
Node Driver Registrar (sidecar) <-> CSI Node Plugin (DaemonSet)
    |
    v
kubelet <-> CSI Node Plugin (gRPC over Unix socket)
```

### Common CSI Issues

```bash
# Check CSI driver pods
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-ebs-csi-driver -o wide

# Check driver registration
kubectl get csinodes
kubectl describe csinode <node-name>

# Check CSI storage capacity (if CSIStorageCapacity is enabled)
kubectl get csistoragecapacities -A

# Check VolumeAttachment objects (tracks which volume is attached to which node)
kubectl get volumeattachments

# Find stuck VolumeAttachments
kubectl get volumeattachments -o json | \
  jq -r '.items[] | select(.status.attached == false) |
    "\(.metadata.name): node=\(.spec.nodeName) pv=\(.spec.source.persistentVolumeName)"'

# Force delete a stuck VolumeAttachment (use with caution)
kubectl patch volumeattachment <name> \
  --type=json \
  -p='[{"op": "remove", "path": "/metadata/finalizers"}]'
kubectl delete volumeattachment <name>
```

### PV/PVC Binding Issues

```bash
# Manual PV binding: create a PV and bind it to a specific PVC
# Useful when migrating from one CSI driver to another

# Step 1: Get the volume ID from the old PV
OLD_VOLUME_ID=$(kubectl get pv <pv-name> \
  -o jsonpath='{.spec.csi.volumeHandle}')

# Step 2: Create a new PV pointing to the existing storage
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-data-imported
  annotations:
    pv.kubernetes.io/provisioned-by: ebs.csi.aws.com
spec:
  capacity:
    storage: 500Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: gp3-xfs
  # Pre-bind to a specific PVC
  claimRef:
    namespace: production
    name: postgres-data
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-0abc123def456789  # The actual EBS volume ID
    fsType: xfs
    volumeAttributes:
      storage.kubernetes.io/csiProvisionerIdentity: "1234567890-ebs.csi.aws.com"
EOF
```

### Debugging CSI gRPC Calls

```bash
# Enable verbose CSI logging
kubectl set env deployment/ebs-csi-controller \
  -n kube-system \
  -c csi-provisioner \
  GRPC_GO_LOG_VERBOSITY_LEVEL=99

# Watch CSI controller logs during a provisioning operation
kubectl logs -n kube-system \
  -l app=ebs-csi-controller \
  -c ebs-plugin \
  --follow | grep -E "CreateVolume|DeleteVolume|ControllerPublish"

# Watch node plugin logs during volume mount
kubectl logs -n kube-system \
  -l app=ebs-csi-node \
  -c ebs-plugin \
  --follow | grep -E "NodeStageVolume|NodePublishVolume|NodeExpandVolume"
```

## Access Modes and Multi-Node Scenarios

### ReadWriteMany Volumes

Most block storage (EBS, GCE PD) only supports `ReadWriteOnce`. For multi-node access, use NFS-based storage or managed shared filesystems:

```yaml
# EFS StorageClass for ReadWriteMany
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-sc
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-0abc123def456789
  directoryPerms: "700"
  gidRangeStart: "1000"
  gidRangeEnd: "2000"
  basePath: "/dynamic_provisioning"
  subPathPattern: "${.PVC.namespace}/${.PVC.name}"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-config
spec:
  storageClassName: efs-sc
  accessModes:
  - ReadWriteMany
  resources:
    requests:
      storage: 5Gi
```

## Volume Protection and Retention

### Protecting PVCs from Accidental Deletion

```bash
# Check PVC finalizers (kubernetes.io/pvc-protection prevents deletion while in use)
kubectl get pvc postgres-data -n production \
  -o jsonpath='{.metadata.finalizers}'
# ["kubernetes.io/pvc-protection"]

# The pvc-protection finalizer is automatically removed when no pods reference the PVC
# Do not remove it manually unless doing controlled migrations
```

### Reclaim Policy Changes

```bash
# Change a PV's reclaim policy from Delete to Retain (cannot be done on StorageClass after provisioning)
kubectl patch pv <pv-name> \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/persistentVolumeReclaimPolicy", "value": "Retain"}]'

# List PVs with Delete reclaim policy in production namespaces
kubectl get pv -o json | \
  jq -r '.items[] |
    select(.spec.persistentVolumeReclaimPolicy == "Delete") |
    select(.spec.claimRef.namespace | startswith("production")) |
    "\(.metadata.name): \(.spec.claimRef.namespace)/\(.spec.claimRef.name)"'
```

## Monitoring Storage Health

```yaml
# Prometheus alerting rules for storage
groups:
- name: kubernetes-storage
  rules:
  - alert: PersistentVolumeClaimPending
    expr: |
      kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} stuck in Pending"

  - alert: PersistentVolumeClaimLost
    expr: |
      kube_persistentvolumeclaim_status_phase{phase="Lost"} == 1
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is Lost"

  - alert: PersistentVolumeFillingUp
    expr: |
      (
        kubelet_volume_stats_available_bytes /
        kubelet_volume_stats_capacity_bytes
      ) < 0.15
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "PV {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is {{ $value | humanizePercentage }} full"

  - alert: PersistentVolumeCriticallyFull
    expr: |
      (
        kubelet_volume_stats_available_bytes /
        kubelet_volume_stats_capacity_bytes
      ) < 0.05
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "PV {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is critically full (< 5% free)"
```

A mature Kubernetes storage strategy starts with correctly designed StorageClasses, uses WaitForFirstConsumer for all topology-aware storage, implements snapshot-based backup and migration procedures, and monitors volume capacity and attachment health with Prometheus. The operational complexity of stateful workloads in Kubernetes is real, but it is manageable with the right procedures in place before the first production incident occurs.
