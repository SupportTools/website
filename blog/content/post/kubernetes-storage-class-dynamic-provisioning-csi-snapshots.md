---
title: "Kubernetes Storage Class Provisioning: Dynamic PV with CSI and Snapshots"
date: 2029-01-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CSI", "Storage", "PersistentVolume", "Snapshots", "StorageClass"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Kubernetes StorageClass configuration, CSI driver deployment, dynamic PersistentVolume provisioning, volume snapshots, and storage topology for enterprise workloads."
more_link: "yes"
url: "/kubernetes-storage-class-dynamic-provisioning-csi-snapshots/"
---

Kubernetes storage has evolved from static PersistentVolume (PV) pre-provisioning to fully dynamic, CSI-driven provisioning with advanced features including volume snapshots, cloning, resizing, and topology-aware scheduling. Understanding the full storage stack—StorageClass, CSI drivers, PersistentVolumeClaims, and the volume lifecycle—is essential for platform teams managing stateful workloads.

This post covers StorageClass configuration in depth, the CSI architecture, dynamic provisioning patterns for major cloud providers and on-premises storage, volume snapshot management, capacity-aware scheduling, and the operational practices for managing storage at scale.

<!--more-->

## Storage Architecture Overview

The Kubernetes storage subsystem consists of several layers:

1. **StorageClass**: Defines provisioner parameters and reclaim policies
2. **PersistentVolumeClaim (PVC)**: Namespace-scoped resource expressing storage requirements
3. **PersistentVolume (PV)**: Cluster-scoped resource representing actual storage
4. **CSI Driver**: Translates Kubernetes storage operations to storage provider API calls
5. **Volume Attachment**: Binds a PV to a node for mounting

The CSI (Container Storage Interface) specification standardized driver development in Kubernetes 1.13+. Most storage vendors now publish CSI drivers instead of in-tree volume plugins, enabling faster feature development and independent upgrade cycles.

## StorageClass Configuration

### AWS EBS CSI Driver StorageClasses

```yaml
# aws-storage-classes.yaml
---
# High-performance gp3 volumes for databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3-fast
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer  # Topology-aware: waits for pod scheduling
reclaimPolicy: Retain                    # NEVER delete volumes on PVC deletion
allowVolumeExpansion: true
parameters:
  type: gp3
  iops: "6000"              # Max 16,000 for gp3
  throughput: "500"         # MiB/s, max 1000 for gp3
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abcdef1234567890"
  fsType: ext4

---
# Cost-optimized gp3 for general workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  fsType: ext4

---
# io2 Block Express for highest-performance databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-io2-extreme
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  type: io2
  iops: "64000"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abcdef1234567890"
  fsType: xfs   # XFS recommended for PostgreSQL, MongoDB
mountOptions:
- noatime
- nodiratime
- data=ordered

---
# EFS for shared ReadWriteMany workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-standard
provisioner: efs.csi.aws.com
volumeBindingMode: Immediate
reclaimPolicy: Retain
parameters:
  provisioningMode: efs-ap           # EFS Access Points for path isolation
  fileSystemId: fs-0abc123def456789
  directoryPerms: "700"
  gidRangeStart: "1000"
  gidRangeEnd: "2000"
  basePath: "/dynamic-pv"
  subPathPattern: "${.PVC.namespace}/${.PVC.name}"
  ensureUniqueDirectory: "true"
```

### GKE Persistent Disk StorageClasses

```yaml
# gke-storage-classes.yaml
---
# Balanced PD for most workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: pd-balanced
provisioner: pd.csi.storage.gke.io
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  type: pd-balanced
  replication-type: none
  disk-encryption-kms-key: "projects/my-project/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key"
  fstype: ext4

---
# SSD PD for databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: pd-ssd-premium
provisioner: pd.csi.storage.gke.io
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  type: pd-ssd
  replication-type: regional-pd    # Cross-zone replication for HA
  disk-encryption-kms-key: "projects/my-project/locations/us-east1/keyRings/my-ring/cryptoKeys/my-key"
  fstype: xfs

---
# Hyperdisk Extreme for highest IOPS requirements
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: hyperdisk-extreme
provisioner: pd.csi.storage.gke.io
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  type: hyperdisk-extreme
  provisioned-iops-on-create: "100000"
  fstype: xfs
```

### On-Premises: Rook-Ceph StorageClasses

```yaml
# rook-ceph-storage-classes.yaml
---
# RBD block storage for databases and high-performance workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block-fast
provisioner: rook-ceph.rbd.csi.ceph.com
volumeBindingMode: Immediate
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  clusterID: rook-ceph
  pool: replicapool-ssd
  imageFormat: "2"
  imageFeatures: layering,fast-diff,object-map,deep-flatten,exclusive-lock
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: xfs
mountOptions:
- noatime

---
# CephFS for shared ReadWriteMany
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs-shared
provisioner: rook-ceph.cephfs.csi.ceph.com
volumeBindingMode: Immediate
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  clusterID: rook-ceph
  fsName: myfs
  pool: myfs-data0
  rootPath: /dynamic
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
```

## PersistentVolumeClaims and StatefulSets

### StatefulSet with volumeClaimTemplates

```yaml
# postgresql-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  serviceName: postgresql
  replicas: 3
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: postgresql
            topologyKey: kubernetes.io/hostname
      containers:
      - name: postgresql
        image: postgres:16.4-alpine
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_DB
          value: production
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgresql-secret
              key: postgres-password
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: wal
          mountPath: /var/lib/postgresql/wal
        resources:
          requests:
            cpu: 2000m
            memory: 8Gi
          limits:
            cpu: 8000m
            memory: 16Gi
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 5
          periodSeconds: 5
  # Separate PVCs for data and WAL — different performance profiles
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: ebs-io2-extreme
      resources:
        requests:
          storage: 500Gi
  - metadata:
      name: wal
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: ebs-gp3-fast
      resources:
        requests:
          storage: 100Gi
```

## Volume Snapshots

Volume snapshots require the external-snapshotter components and a `VolumeSnapshotClass`:

```bash
# Install external-snapshotter (required for snapshot support)
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### VolumeSnapshotClass Configuration

```yaml
# volume-snapshot-classes.yaml
---
# EBS snapshot class
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshots
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain  # Keep snapshots even if VolumeSnapshot object is deleted
parameters:
  tagSpecification_1: "Environment=production"
  tagSpecification_2: "ManagedBy=kubernetes"

---
# Rook-Ceph RBD snapshot class
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ceph-rbd-snapshots
driver: rook-ceph.rbd.csi.ceph.com
deletionPolicy: Retain
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/snapshotter-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/snapshotter-secret-namespace: rook-ceph
```

### Creating and Restoring Snapshots

```yaml
# Create a snapshot of a database PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgresql-data-snapshot-20290119
  namespace: databases
  labels:
    app: postgresql
    backup-type: pre-migration
spec:
  volumeSnapshotClassName: ebs-snapshots
  source:
    persistentVolumeClaimName: data-postgresql-0

---
# Restore from snapshot by creating a new PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgresql-data-restored
  namespace: databases
spec:
  storageClassName: ebs-io2-extreme
  dataSource:
    name: postgresql-data-snapshot-20290119
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
```

### Automated Snapshot Backup CronJob

```yaml
# snapshot-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgresql-snapshot-backup
  namespace: databases
spec:
  schedule: "0 2 * * *"   # Daily at 2am
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: snapshot-manager
          restartPolicy: OnFailure
          containers:
          - name: snapshot-manager
            image: bitnami/kubectl:1.31.0
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              DATE=$(date +%Y%m%d-%H%M%S)
              RETENTION_DAYS=7

              echo "Creating snapshots for all PostgreSQL PVCs..."

              # Get all postgresql PVCs
              for pvc in $(kubectl get pvc -n databases -l app=postgresql \
                              -o jsonpath='{.items[*].metadata.name}'); do

                SNAPSHOT_NAME="${pvc}-${DATE}"
                echo "Creating snapshot: ${SNAPSHOT_NAME}"

                cat <<EOF | kubectl apply -f -
              apiVersion: snapshot.storage.k8s.io/v1
              kind: VolumeSnapshot
              metadata:
                name: ${SNAPSHOT_NAME}
                namespace: databases
                labels:
                  app: postgresql
                  backup-date: "${DATE}"
                  pvc-source: "${pvc}"
              spec:
                volumeSnapshotClassName: ebs-snapshots
                source:
                  persistentVolumeClaimName: ${pvc}
              EOF

                # Wait for snapshot to be ready
                kubectl wait volumesnapshot "${SNAPSHOT_NAME}" -n databases \
                  --for=jsonpath='{.status.readyToUse}=true' \
                  --timeout=10m
                echo "Snapshot ${SNAPSHOT_NAME} is ready"
              done

              # Cleanup snapshots older than retention period
              echo "Cleaning up snapshots older than ${RETENTION_DAYS} days..."
              CUTOFF=$(date -d "-${RETENTION_DAYS} days" +%Y%m%d)

              kubectl get volumesnapshot -n databases -l app=postgresql \
                -o jsonpath='{.items[*].metadata.name}' | \
              tr ' ' '\n' | while read snap; do
                SNAP_DATE=$(echo "${snap}" | grep -oE '[0-9]{8}' | head -1)
                if [ -n "${SNAP_DATE}" ] && [ "${SNAP_DATE}" -lt "${CUTOFF}" ]; then
                  echo "Deleting old snapshot: ${snap}"
                  kubectl delete volumesnapshot "${snap}" -n databases
                fi
              done

              echo "Snapshot backup complete"
```

## Volume Expansion

```bash
#!/bin/bash
# expand-pvc.sh — Safely expand a PVC with pre-expansion checks

NAMESPACE="${1}"
PVC_NAME="${2}"
NEW_SIZE="${3}"

if [ $# -ne 3 ]; then
    echo "Usage: $0 <namespace> <pvc-name> <new-size-e.g.-200Gi>"
    exit 1
fi

# Check if the StorageClass supports expansion
SC_NAME=$(kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.storageClassName}')

ALLOW_EXPAND=$(kubectl get storageclass "${SC_NAME}" \
    -o jsonpath='{.allowVolumeExpansion}')

if [ "${ALLOW_EXPAND}" != "true" ]; then
    echo "ERROR: StorageClass ${SC_NAME} does not support volume expansion"
    exit 1
fi

# Get current size
CURRENT_SIZE=$(kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.status.capacity.storage}')

echo "Expanding PVC ${NAMESPACE}/${PVC_NAME}"
echo "  Current size: ${CURRENT_SIZE}"
echo "  New size: ${NEW_SIZE}"
echo "  StorageClass: ${SC_NAME}"
echo ""

read -r -p "Confirm expansion? [y/N] " confirm
if [ "${confirm}" != "y" ]; then
    echo "Aborted."
    exit 0
fi

# Patch the PVC
kubectl patch pvc "${PVC_NAME}" -n "${NAMESPACE}" \
    -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"${NEW_SIZE}\"}}}}"

echo "Waiting for expansion to complete..."
# For filesystem expansion, the pod must be restarted to trigger fs resize
# Block device expansion happens online

timeout 300 bash -c "
until kubectl get pvc ${PVC_NAME} -n ${NAMESPACE} \
    -o jsonpath='{.status.capacity.storage}' | grep -q '${NEW_SIZE}'; do
    echo -n '.'
    sleep 5
done
echo ''
echo 'Expansion complete'
kubectl get pvc ${PVC_NAME} -n ${NAMESPACE}
"
```

## Topology-Aware Provisioning

`WaitForFirstConsumer` is critical in multi-zone clusters to ensure volumes are created in the same availability zone as the pod:

```yaml
# topology-aware-pvc.yaml
# With WaitForFirstConsumer, this PVC is not created until a pod using it is scheduled.
# The provisioner reads the pod's zone from the node and creates the volume there.
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: zone-aware-data
  namespace: production
spec:
  storageClassName: ebs-gp3-standard  # volumeBindingMode: WaitForFirstConsumer
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
---
# Pod with node affinity constraints — PVC follows the pod to the correct zone
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zone-aware-app
  namespace: production
spec:
  replicas: 1
  selector:
    matchLabels:
      app: zone-aware-app
  template:
    metadata:
      labels:
        app: zone-aware-app
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                - us-east-1a
                - us-east-1b
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: zone-aware-data
      containers:
      - name: app
        image: registry.example.com/app:v1.2.3
        volumeMounts:
        - name: data
          mountPath: /data
```

## Storage Capacity Tracking

Kubernetes 1.24+ supports storage capacity tracking, enabling the scheduler to consider available storage capacity when placing pods:

```bash
# Check available storage capacity by topology zone
kubectl get csistoragecapacity -A \
    -o custom-columns='DRIVER:.spec.storageClassName,ZONE:.metadata.labels.topology\.kubernetes\.io/zone,CAPACITY:.capacity'

# Example output:
# DRIVER                ZONE         CAPACITY
# ebs-gp3-standard     us-east-1a   10Ti
# ebs-gp3-standard     us-east-1b   8Ti
# ebs-gp3-fast         us-east-1a   2Ti
```

## Monitoring Storage Health

```yaml
# prometheus-storage-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-storage-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
  - name: storage.alerts
    rules:
    - alert: PersistentVolumeClaimPending
      expr: kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} has been Pending for 15 minutes"
        description: "Check CSI driver logs and StorageClass configuration"

    - alert: PersistentVolumeFull
      expr: |
        (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.90
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is 90%+ full"
        description: "Used: {{ $value | humanizePercentage }}"

    - alert: PersistentVolumeFailed
      expr: kube_persistentvolume_status_phase{phase="Failed"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "PersistentVolume {{ $labels.persistentvolume }} is in Failed state"

    - alert: VolumeSnapshotFailed
      expr: kube_volumesnapshot_info{ready_to_use="false"} == 1
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "VolumeSnapshot {{ $labels.namespace }}/{{ $labels.volumesnapshot }} has not become ready"
```

## Summary

A production Kubernetes storage strategy requires deliberate StorageClass design aligned with workload performance requirements, reclaim policy selection based on data criticality, and snapshot automation for backup and disaster recovery.

The key decisions:
- Use `Retain` reclaim policy for any database or production PVC—`Delete` is appropriate only for ephemeral test environments.
- Use `WaitForFirstConsumer` volume binding for all cloud storage to prevent cross-zone volume attachment failures.
- Separate data and WAL/write-ahead log volumes for databases onto different StorageClasses with different IOPS profiles.
- Automate daily snapshots with a retention CronJob; test snapshot restore procedures quarterly.
- Enable storage capacity tracking and monitor PVC fullness with alerting before volumes reach 85% capacity.
