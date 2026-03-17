---
title: "Kubernetes Storage Classes and CSI Drivers: Enterprise Storage Architecture Patterns"
date: 2030-10-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "CSI", "StorageClass", "EBS", "Ceph", "Persistent Volumes", "StatefulSets"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise storage architecture guide: StorageClass parameters for EBS, GCE PD, Azure Disk, and Ceph CSI drivers, ReadWriteMany volumes, volume expansion, storage tier selection, and managing stateful workloads."
more_link: "yes"
url: "/kubernetes-storage-classes-csi-drivers-enterprise-storage-architecture/"
---

Storage is the most operationally complex aspect of running stateful workloads in Kubernetes. Unlike compute and networking, where misconfiguration typically manifests immediately, storage issues often emerge gradually — through performance degradation, capacity exhaustion, snapshot failures, or backup gaps discovered only during recovery attempts. A well-designed storage architecture aligns CSI driver capabilities with workload I/O profiles, availability requirements, and compliance constraints.

<!--more-->

## CSI Architecture Overview

The Container Storage Interface standardizes how Kubernetes communicates with storage backends. Every CSI driver implements the same gRPC interface, allowing storage vendors to build drivers without modifying Kubernetes core code.

```
Kubernetes API Server
        │
        ▼
CSI External Provisioner    ← Watches PVCs, calls CreateVolume
CSI External Attacher       ← Watches VolumeAttachments, calls ControllerPublishVolume
CSI External Snapshotter    ← Manages VolumeSnapshots
CSI External Resizer        ← Handles volume expansion
        │
        ▼ (gRPC)
CSI Driver Controller Plugin
        │
        ▼ (on each node)
CSI Driver Node Plugin       ← Mounts/unmounts volumes on nodes
        │
        ▼
Underlying Storage System
(EBS, GCE PD, Ceph, NFS, etc.)
```

### CSI Driver Health Verification

```bash
# List all CSI drivers installed in the cluster
kubectl get csidrivers -o wide

# Check CSI driver pods
kubectl get pods -n kube-system -l app=ebs-csi-controller
kubectl get pods -n kube-system -l app=ebs-csi-node

# Check CSI storage capacity (for topology-aware provisioning)
kubectl get csistoragecapacities -A

# Verify provisioner is responding
kubectl get events --field-selector reason=ProvisioningSucceeded --sort-by='.lastTimestamp' | tail -10
kubectl get events --field-selector reason=ProvisioningFailed --sort-by='.lastTimestamp' | tail -10

# Check VolumeAttachment status
kubectl get volumeattachments | head -20
```

## AWS EBS CSI Driver StorageClass

### StorageClass Configurations

```yaml
# aws-ebs-storageclass-gp3.yaml
# General purpose: gp3 for most workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: aws-ebs-gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  # IOPS: 3000-16000 for gp3
  iops: "3000"
  # Throughput: 125-1000 MB/s for gp3
  throughput: "125"
  # Encryption
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:alias/kubernetes-ebs
  fsType: ext4
  # Optional: tag volumes for cost allocation
  tagSpecification_1: "Environment=production"
  tagSpecification_2: "ManagedBy=kubernetes"

volumeBindingMode: WaitForFirstConsumer  # Topology-aware provisioning
allowVolumeExpansion: true
reclaimPolicy: Retain  # Prevents accidental data loss

allowedTopologies:
- matchLabelExpressions:
  - key: topology.ebs.csi.aws.com/zone
    values:
    - us-east-1a
    - us-east-1b
    - us-east-1c
---
# High-performance: io2 for databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: aws-ebs-io2-database
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iops: "16000"     # Maximum provisioned IOPS for io2
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:alias/kubernetes-ebs
  fsType: xfs       # XFS preferred for databases

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
---
# Cost-optimized: sc1 for infrequent access, cold storage
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: aws-ebs-sc1-cold
provisioner: ebs.csi.aws.com
parameters:
  type: sc1          # Cold HDD - lowest cost
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:alias/kubernetes-ebs
  fsType: ext4

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Delete  # Cold storage - ok to delete on PVC removal
```

### EBS CSI Installation

```bash
# Install via Helm
helm repo add aws-ebs-csi-driver https://kubernetes-sigs.github.io/aws-ebs-csi-driver
helm repo update

helm install aws-ebs-csi-driver aws-ebs-csi-driver/aws-ebs-csi-driver \
  --namespace kube-system \
  --set controller.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=\
    "arn:aws:iam::123456789012:role/AmazonEKS_EBS_CSI_DriverRole" \
  --set enableVolumeResizing=true \
  --set enableVolumeSnapshot=true \
  --set controller.replicaCount=2 \
  --version 2.28.0

# Verify installation
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-ebs-csi-driver
kubectl rollout status deployment/ebs-csi-controller -n kube-system
```

## GCP Persistent Disk CSI Driver

```yaml
# gcp-pd-storageclass.yaml
# Standard persistent disk (HDD)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gcp-pd-standard
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-standard
  replication-type: regional-pd    # Cross-zone redundancy
  disk-encryption-kms-key: projects/my-project/locations/us-east1/keyRings/my-kr/cryptoKeys/my-key

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
---
# SSD persistent disk for production
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gcp-pd-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  replication-type: regional-pd
  disk-encryption-kms-key: projects/my-project/locations/us-east1/keyRings/my-kr/cryptoKeys/my-key

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
---
# Extreme persistent disk for highest-performance databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gcp-pd-extreme
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-extreme
  # iops-per-gb and throughput-mb-per-s for pd-extreme
  iops-per-gb: "50"    # Total IOPS = volume size (GB) * 50
  throughput-mb-per-s: "200"
  replication-type: none  # Extreme PD is zonal only

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
```

## Azure Disk CSI Driver

```yaml
# azure-disk-storageclass.yaml
# Standard SSD (general purpose)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azure-disk-standard-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: disk.csi.azure.com
parameters:
  skuName: StandardSSD_LRS
  kind: Managed
  fsType: ext4
  cachingMode: ReadOnly     # For read-heavy workloads
  diskEncryptionSetID: /subscriptions/SUB_ID/resourceGroups/RG/providers/Microsoft.Compute/diskEncryptionSets/my-des

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
---
# Premium SSD for production databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azure-disk-premium-ssd
provisioner: disk.csi.azure.com
parameters:
  skuName: Premium_LRS
  kind: Managed
  fsType: xfs
  cachingMode: None         # Disable cache for databases (avoid corruption)
  # Performance tier override
  perfProfile: High
  diskEncryptionSetID: /subscriptions/SUB_ID/resourceGroups/RG/providers/Microsoft.Compute/diskEncryptionSets/my-des

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
---
# Ultra Disk for extreme IOPS workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azure-disk-ultra
provisioner: disk.csi.azure.com
parameters:
  skuName: UltraSSD_LRS
  kind: Managed
  fsType: xfs
  # Ultra Disk requires specific zone selection
  logicalSectorSize: "4096"

volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
allowedTopologies:
- matchLabelExpressions:
  - key: topology.disk.csi.azure.com/zone
    values:
    - "eastus-1"  # Ultra Disk only available in specific zones
```

## Ceph RBD CSI Driver (Rook-Ceph)

```yaml
# ceph-rbd-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  # Ceph cluster configuration
  clusterID: rook-ceph
  pool: replicapool

  # Image features for performance
  imageFeatures: layering,fast-diff,object-map,deep-flatten

  # CSI RBD secret references
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph

  # Encryption (per-volume LUKS encryption)
  encryptionKMSID: vault-kms

  fsType: ext4

volumeBindingMode: Immediate
allowVolumeExpansion: true
reclaimPolicy: Retain
---
# Ceph CephFS for ReadWriteMany (shared storage)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-filesystem
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

volumeBindingMode: Immediate
allowVolumeExpansion: true
reclaimPolicy: Retain
# CephFS supports ReadWriteMany!
# PVCs with accessModes: [ReadWriteMany] use this class
```

## ReadWriteMany Volumes

Not all CSI drivers support ReadWriteMany (RWX) access mode. Understanding which backends support RWX is critical before designing stateful architectures:

```yaml
# ReadWriteMany access mode compatibility:
# EBS CSI: ReadWriteOnce ONLY (single node attachment)
# GCE PD CSI: ReadWriteOnce ONLY
# Azure Disk CSI: ReadWriteOnce ONLY
# Azure File CSI: ReadWriteMany (via SMB/NFS)
# NFS CSI: ReadWriteMany
# CephFS CSI: ReadWriteMany
# Longhorn: ReadWriteMany (via NFS export from RWO volume)

# Example RWX PVC with CephFS
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-uploads
  namespace: production
spec:
  accessModes:
  - ReadWriteMany
  storageClassName: rook-ceph-filesystem
  resources:
    requests:
      storage: 100Gi
---
# Example: multiple pods sharing the same PVC (RWX)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: upload-processor
  namespace: production
spec:
  replicas: 5  # Multiple replicas can mount the same PVC
  selector:
    matchLabels:
      app: upload-processor
  template:
    metadata:
      labels:
        app: upload-processor
    spec:
      containers:
      - name: processor
        image: your-registry.io/upload-processor:1.0.0
        volumeMounts:
        - name: uploads
          mountPath: /data/uploads
      volumes:
      - name: uploads
        persistentVolumeClaim:
          claimName: shared-uploads
```

### Azure Files for RWX

```yaml
# azure-files-rwx-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azure-files-premium-rwx
provisioner: file.csi.azure.com
parameters:
  skuName: Premium_LRS
  protocol: nfs        # NFS protocol for Linux pods
  # secretNamespace: default  # Where to store storage account credentials
  # subscriptionID, resourceGroup can be specified for cross-subscription
  # storageAccount: my-storage-account  # Or auto-created

mountOptions:
- nconnect=4           # Parallel NFS connections for higher throughput
- actimeo=30           # Attribute cache timeout
- noresvport           # Don't use reserved port

volumeBindingMode: Immediate
allowVolumeExpansion: true
reclaimPolicy: Retain
```

## Volume Expansion

### Configuring Volume Expansion

```bash
# Verify allowVolumeExpansion is enabled in the StorageClass
kubectl get storageclass aws-ebs-gp3 -o jsonpath='{.allowVolumeExpansion}'

# Expand a PVC (edit the storage request)
kubectl patch pvc my-database-data -n production --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Monitor expansion progress
kubectl get pvc my-database-data -n production -w
# NAME               STATUS   VOLUME     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# my-database-data   Bound    pvc-abc    100Gi      RWO            aws-ebs-gp3    30d
# my-database-data   Bound    pvc-abc    200Gi      RWO            aws-ebs-gp3    30d  ← expanded

# Check expansion events
kubectl describe pvc my-database-data -n production | grep -A5 Events

# For some drivers, the pod must be restarted to pick up the expanded filesystem
kubectl rollout restart statefulset postgres -n production
```

### Online Volume Expansion vs Offline

```bash
# EBS gp3/gp2: Online expansion supported (no pod restart needed for most cases)
# The CSI driver expands the volume AND resizes the filesystem while the pod is running

# Ceph RBD: Supports online expansion (pod restart not required for ext4/xfs)

# Azure Disk: Requires pod deletion for filesystem resize (limitation as of 2030)
# This will restart the pod:
kubectl delete pod postgres-0 -n databases
# The new pod will automatically trigger filesystem resize on mount

# Check if a volume resize is pending (filesystem expansion not yet done)
kubectl describe pvc my-pvc | grep "Conditions" -A5
# Condition:  FileSystemResizePending - True means waiting for pod restart
```

## VolumeSnapshot Management

```yaml
# volume-snapshot-class.yaml
# VolumeSnapshotClass for AWS EBS
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: aws-ebs-snapshot
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain  # Keep snapshots after VolumeSnapshot deletion
parameters:
  tagSpecification_1: "Environment=production"
  tagSpecification_2: "Purpose=backup"
---
# Take a snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-backup-20301021
  namespace: databases
spec:
  volumeSnapshotClassName: aws-ebs-snapshot
  source:
    persistentVolumeClaimName: postgres-data
---
# Monitor snapshot readiness
# kubectl get volumesnapshot postgres-backup-20301021 -n databases -w
# NAME                       READYTOUSE   SOURCEPVC       AGE
# postgres-backup-20301021   true         postgres-data   2m

# Restore from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: databases
spec:
  storageClassName: aws-ebs-gp3
  dataSource:
    name: postgres-backup-20301021
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 200Gi  # Must be >= original volume size
```

## StatefulSet Storage Patterns

### VolumeClaimTemplates

```yaml
# postgres-statefulset-production.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: databases
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      # Ensure pods are spread across zones for resilience
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: postgres

      terminationGracePeriodSeconds: 120

      initContainers:
      - name: postgres-init
        image: busybox:1.36
        command: ["chown", "-R", "999:999", "/data"]
        volumeMounts:
        - name: postgres-data
          mountPath: /data

      containers:
      - name: postgres
        image: postgres:16.2
        ports:
        - containerPort: 5432
          name: postgres

        env:
        - name: PGDATA
          value: /data/pgdata
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password

        # Lifecycle hook for graceful shutdown
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "pg_ctl stop -m fast -D $PGDATA"]

        resources:
          requests:
            cpu: "2"
            memory: 8Gi
          limits:
            cpu: "8"
            memory: 16Gi

        volumeMounts:
        - name: postgres-data
          mountPath: /data
        - name: postgres-wal
          mountPath: /data/wal

        # Readiness probe using pg_isready
        readinessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres", "-d", "postgres"]
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3

  # Each StatefulSet pod gets its own PVC from this template
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
      labels:
        app: postgres
        tier: database
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: aws-ebs-io2-database
      resources:
        requests:
          storage: 500Gi

  - metadata:
      name: postgres-wal
      labels:
        app: postgres
        tier: database-wal
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: aws-ebs-gp3  # WAL on separate volume for I/O isolation
      resources:
        requests:
          storage: 100Gi
```

## Storage Monitoring and Capacity Management

```yaml
# storage-monitoring-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: storage-capacity-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  groups:
  - name: storage.capacity
    interval: 60s
    rules:
    - alert: PVCCapacityAbove85Percent
      expr: |
        (
          kubelet_volume_stats_used_bytes /
          kubelet_volume_stats_capacity_bytes
        ) * 100 > 85
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is {{ $value | humanizePercentage }} full"
        description: "Volume {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} on node {{ $labels.node }} has {{ $value | humanizePercentage }} capacity used."
        runbook: https://wiki.internal.example.com/runbooks/pvc-capacity

    - alert: PVCCapacityAbove95Percent
      expr: |
        (
          kubelet_volume_stats_used_bytes /
          kubelet_volume_stats_capacity_bytes
        ) * 100 > 95
      for: 2m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "CRITICAL: PVC {{ $labels.persistentvolumeclaim }} nearly full ({{ $value | humanizePercentage }})"

    - alert: VolumeSnapshotFailed
      expr: |
        kube_volumesnapshot_info{readytouse="false"} * on(name, namespace) group_left
        (kube_volumesnapshot_status_error) kube_volumesnapshot_status_error > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VolumeSnapshot {{ $labels.name }} in {{ $labels.namespace }} failed"

    - alert: CSIDriverUnavailable
      expr: |
        up{job="csi-controller"} == 0
      for: 5m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "CSI driver controller for {{ $labels.driver }} is down"
        description: "New PVC provisioning and volume operations are unavailable."
```

## Storage Class Selection Decision Guide

```bash
#!/bin/bash
# storage-class-advisor.sh
# Interactive tool to recommend storage class based on workload requirements

echo "=== Kubernetes Storage Class Advisor ==="
echo ""
echo "Answer the following questions to get a storage class recommendation:"
echo ""

read -p "1. Is shared access (multiple pods reading/writing) required? [y/n]: " SHARED
read -p "2. Is this for a database (MySQL, PostgreSQL, MongoDB)? [y/n]: " DATABASE
read -p "3. What is the expected IOPS requirement? [low/medium/high/extreme]: " IOPS
read -p "4. Cloud provider? [aws/gcp/azure/baremetal]: " CLOUD
read -p "5. Is data encryption required at rest? [y/n]: " ENCRYPT
read -p "6. Is cross-zone redundancy required? [y/n]: " CROSSZONE

echo ""
echo "=== Recommendation ==="

if [ "$SHARED" = "y" ]; then
    case "$CLOUD" in
        aws)
            echo "Recommended: Amazon EFS via efs.csi.aws.com"
            echo "StorageClass: aws-efs-gp (ReadWriteMany)"
            ;;
        gcp)
            echo "Recommended: Google Filestore via filestore.csi.storage.gke.io"
            echo "StorageClass: gcp-filestore-rwx"
            ;;
        azure)
            echo "Recommended: Azure Files Premium NFS via file.csi.azure.com"
            echo "StorageClass: azure-files-premium-rwx"
            ;;
        baremetal)
            echo "Recommended: CephFS via rook-ceph.cephfs.csi.ceph.com"
            echo "StorageClass: rook-ceph-filesystem"
            ;;
    esac
elif [ "$DATABASE" = "y" ]; then
    case "$IOPS" in
        extreme)
            case "$CLOUD" in
                aws) echo "Recommended: aws-ebs-io2-database (16000 IOPS, XFS)" ;;
                gcp) echo "Recommended: gcp-pd-extreme (50 IOPS/GB, XFS)" ;;
                azure) echo "Recommended: azure-disk-ultra (UltraSSD_LRS, XFS)" ;;
                baremetal) echo "Recommended: rook-ceph-block with all-NVMe pool" ;;
            esac
            ;;
        high)
            case "$CLOUD" in
                aws) echo "Recommended: aws-ebs-gp3 (iops=6000, throughput=250)" ;;
                gcp) echo "Recommended: gcp-pd-ssd (regional)" ;;
                azure) echo "Recommended: azure-disk-premium-ssd" ;;
                baremetal) echo "Recommended: rook-ceph-block with NVMe pool" ;;
            esac
            ;;
        *)
            case "$CLOUD" in
                aws) echo "Recommended: aws-ebs-gp3 (default, iops=3000)" ;;
                gcp) echo "Recommended: gcp-pd-standard" ;;
                azure) echo "Recommended: azure-disk-standard-ssd" ;;
                baremetal) echo "Recommended: rook-ceph-block" ;;
            esac
            ;;
    esac
fi

echo ""
if [ "$ENCRYPT" = "y" ]; then
    echo "- Ensure kmsKeyId/diskEncryptionSetID is set in StorageClass parameters"
    echo "- Verify KMS key policy allows the CSI driver IAM role"
fi

if [ "$CROSSZONE" = "y" ]; then
    echo "- Use regional storage types where available (gcp-pd regional, EFS, Azure ZRS)"
    echo "- For EBS/Azure Disk, use StatefulSets with topologySpreadConstraints"
fi
```

A well-designed storage architecture in Kubernetes is one that matches workload I/O profiles to the right storage tier, enforces encryption at rest without compromising performance, and maintains operationally simple PVC management through consistent StorageClass naming and tagging. The investment in CSI driver configuration, VolumeSnapshot backup policies, and storage monitoring pays dividends when recovery from a storage incident becomes a structured procedure rather than a crisis.
