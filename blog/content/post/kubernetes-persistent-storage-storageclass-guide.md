---
title: "Kubernetes Persistent Storage: StorageClass Design, CSI Driver Configuration, and Volume Lifecycle Management"
date: 2028-08-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "StorageClass", "CSI", "Persistent Volumes"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes persistent storage covering StorageClass design for multiple tiers, CSI driver installation and configuration, PersistentVolume lifecycle management, volume expansion, snapshots, backup strategies, and storage troubleshooting for production clusters."
more_link: "yes"
url: "/kubernetes-persistent-storage-storageclass-guide/"
---

Kubernetes persistent storage is one of the most complex and consequential parts of cluster administration. Getting it wrong means lost data, failed backups, application downtime during volume operations, and difficult debugging sessions involving kernel storage drivers, cloud provider APIs, and CSI sidecars all at once.

This guide covers the complete persistent storage stack: StorageClass design for multi-tier environments, CSI driver architecture and installation, PersistentVolume and PVC lifecycle, dynamic provisioning, volume expansion, snapshots, and the operational playbooks you need when things go wrong.

<!--more-->

# Kubernetes Persistent Storage: StorageClass Design, CSI Driver Configuration, and Volume Lifecycle Management

## Section 1: Storage Architecture Overview

Kubernetes persistent storage is built on three layers:

```
Application Layer
├── PersistentVolumeClaim (PVC)   — what the app requests
│
Kubernetes Storage Layer
├── StorageClass                  — defines provisioner and parameters
├── PersistentVolume (PV)         — actual storage resource
│
Infrastructure Layer
├── CSI Driver                    — storage system adapter
├── Provisioner                   — creates actual volumes
└── Storage Backend               — EBS, Ceph, NFS, local disk, etc.
```

**Key relationships**:
- PVCs bind to PVs (either statically pre-created or dynamically provisioned)
- StorageClass references a provisioner that creates PVs on demand
- CSI drivers implement the provisioner interface and handle volume lifecycle

## Section 2: StorageClass Design

### Single-Region Production StorageClasses

```yaml
# storageclass-ssd.yaml
# High-performance SSD for databases and critical workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"
  throughput: "250"       # MB/s
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/abc-def"
volumeBindingMode: WaitForFirstConsumer  # Wait for pod scheduling before provisioning
reclaimPolicy: Retain                    # Don't delete volume when PVC is deleted
allowVolumeExpansion: true
mountOptions:
  - noatime
  - nodiratime
---
# storageclass-standard.yaml
# Standard SSD for general workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
---
# storageclass-bulk.yaml
# High-capacity HDD for logs, backups, cold data
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: bulk
provisioner: ebs.csi.aws.com
parameters:
  type: st1          # Throughput-optimized HDD
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
---
# storageclass-local.yaml
# Local NVMe for highest-performance workloads (no replication)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

### Multi-Zone StorageClass with Topology

```yaml
# storageclass-multi-az.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ssd-multi-az
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1a
          - us-east-1b
          - us-east-1c
```

### StorageClass for Rook-Ceph

```yaml
# ceph-block-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-rbd
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
volumeBindingMode: Immediate
reclaimPolicy: Delete
allowVolumeExpansion: true
---
# ceph-filesystem-storageclass.yaml
# CephFS for ReadWriteMany (shared volumes)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-filesystem
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: myfs
  pool: myfs-data0
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
volumeBindingMode: Immediate
reclaimPolicy: Delete
allowVolumeExpansion: true
```

## Section 3: CSI Driver Architecture

CSI (Container Storage Interface) is the standard API that Kubernetes uses to communicate with storage systems. Understanding the architecture prevents confusion when debugging.

### CSI Components

```
┌─────────────────────────────────────┐
│         Kubernetes Control Plane     │
│  kube-controller-manager            │
│  ├── external-provisioner (sidecar) │ ← Watches PVCs, calls CreateVolume
│  ├── external-attacher   (sidecar)  │ ← Calls ControllerPublishVolume
│  └── external-resizer    (sidecar)  │ ← Calls ControllerExpandVolume
└─────────────────────────────────────┘
              │ gRPC over Unix socket
┌─────────────────────────────────────┐
│         CSI Controller Plugin        │
│  (typically a Deployment)           │
│  - CreateVolume / DeleteVolume       │
│  - ControllerPublishVolume           │
│  - CreateSnapshot / DeleteSnapshot   │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│         CSI Node Plugin (DaemonSet)  │
│  - NodeStageVolume   (format+mount)  │
│  - NodePublishVolume (bind mount)    │
│  - NodeExpandVolume                  │
└─────────────────────────────────────┘
         │
    kubelet plugin registration
    /var/lib/kubelet/plugins/...
```

### Installing the AWS EBS CSI Driver

```bash
# Using Helm
helm repo add aws-ebs-csi-driver https://kubernetes-sigs.github.io/aws-ebs-csi-driver
helm repo update

helm upgrade --install aws-ebs-csi-driver aws-ebs-csi-driver/aws-ebs-csi-driver \
  --namespace kube-system \
  --set controller.serviceAccount.create=true \
  --set controller.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/ebs-csi-controller-role" \
  --set node.serviceAccount.create=true \
  --set node.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/ebs-csi-node-role" \
  --set defaultStorageClass.enabled=false \
  --version 2.33.0

# Verify installation
kubectl get pods -n kube-system | grep ebs-csi
kubectl get csidrivers ebs.csi.aws.com
```

### IAM Policy for EBS CSI Driver

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateSnapshot",
        "ec2:AttachVolume",
        "ec2:DetachVolume",
        "ec2:ModifyVolume",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeInstances",
        "ec2:DescribeSnapshots",
        "ec2:DescribeTags",
        "ec2:DescribeVolumes",
        "ec2:DescribeVolumesModifications"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateTags"
      ],
      "Resource": [
        "arn:aws:ec2:*:*:volume/*",
        "arn:aws:ec2:*:*:snapshot/*"
      ],
      "Condition": {
        "StringEquals": {
          "ec2:CreateAction": [
            "CreateVolume",
            "CreateSnapshot"
          ]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DeleteTags"
      ],
      "Resource": [
        "arn:aws:ec2:*:*:volume/*",
        "arn:aws:ec2:*:*:snapshot/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "ec2:CreateVolume",
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "aws:RequestTag/ebs.csi.aws.com/cluster": "true"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": "ec2:DeleteVolume",
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "aws:ResourceTag/ebs.csi.aws.com/cluster": "true"
        }
      }
    }
  ]
}
```

## Section 4: PersistentVolume and PVC Lifecycle

### Static Provisioning

```yaml
# pv-static.yaml
# Pre-created PV pointing to an existing EBS volume
apiVersion: v1
kind: PersistentVolume
metadata:
  name: database-volume
  labels:
    app: postgresql
    tier: database
spec:
  capacity:
    storage: 100Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce    # RWO: single node mount
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ssd
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-0a1b2c3d4e5f67890
    fsType: ext4
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: topology.kubernetes.io/zone
              operator: In
              values:
                - us-east-1a
---
# pvc-static.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: ssd
  selector:
    matchLabels:
      app: postgresql    # Selects specific PV
      tier: database
  volumeName: database-volume  # Direct binding
```

### Dynamic Provisioning

```yaml
# pvc-dynamic.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: production
  annotations:
    # Optional: override StorageClass parameters per-PVC
    # (not all CSI drivers support this)
    volume.beta.kubernetes.io/storage-provisioner: ebs.csi.aws.com
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: ssd
  volumeMode: Filesystem
```

### Volume Modes

```yaml
# Block mode PVC (raw block device — for databases like Cassandra)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cassandra-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  volumeMode: Block     # Raw block device, not formatted
  resources:
    requests:
      storage: 500Gi
  storageClassName: ssd
---
# Pod using block volume
apiVersion: v1
kind: Pod
metadata:
  name: cassandra
spec:
  containers:
    - name: cassandra
      image: cassandra:4.1
      volumeDevices:            # Note: volumeDevices, not volumeMounts
        - name: data
          devicePath: /dev/xvda
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: cassandra-data
```

## Section 5: Access Modes Deep Dive

| Mode | Short | Description | Typical Use |
|------|-------|-------------|-------------|
| ReadWriteOnce | RWO | Single node read-write | Databases, stateful apps |
| ReadOnlyMany | ROX | Multiple nodes read-only | Config/assets served from one writer |
| ReadWriteMany | RWX | Multiple nodes read-write | Shared filesystems (NFS, CephFS) |
| ReadWriteOncePod | RWOP | Single pod read-write (k8s 1.22+) | Strict single-pod ownership |

```yaml
# RWX example with NFS
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-assets
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 100Gi
  storageClassName: ceph-filesystem  # Must support RWX
---
# Multiple pods can mount this simultaneously
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-server
  namespace: production
spec:
  replicas: 5  # All 5 replicas can read/write the same volume
  template:
    spec:
      containers:
        - name: nginx
          volumeMounts:
            - name: assets
              mountPath: /var/www/html
      volumes:
        - name: assets
          persistentVolumeClaim:
            claimName: shared-assets
```

## Section 6: Volume Expansion

```bash
# Prerequisites: StorageClass must have allowVolumeExpansion: true
kubectl get storageclass ssd -o jsonpath='{.allowVolumeExpansion}'

# Expand a PVC by editing the spec
kubectl patch pvc postgres-data -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/resources/requests/storage", "value": "200Gi"}]'

# Monitor expansion progress
kubectl get pvc postgres-data -n production -w
# Status transitions:
# Bound -> FileSystemResizePending -> Bound (new size)

# Check for expansion events
kubectl describe pvc postgres-data -n production | grep -A 10 Events
```

### Online vs Offline Expansion

Some CSI drivers support online expansion (while pod is running); others require the volume to be detached:

```bash
# Check if online expansion is supported
kubectl get csidriver ebs.csi.aws.com -o yaml | grep -A 5 capabilities
# Look for: RequiresRepublish or NodeExpansionRequired

# For drivers requiring offline expansion:
# 1. Scale down the statefulset/deployment
kubectl scale statefulset postgres --replicas=0 -n production

# 2. Patch the PVC size
kubectl patch pvc postgres-data -n production \
  -p '{"spec": {"resources": {"requests": {"storage": "200Gi"}}}}'

# 3. Wait for resize to complete
kubectl wait --for=jsonpath='{.status.capacity.storage}'=200Gi \
  pvc/postgres-data -n production --timeout=300s

# 4. Scale back up
kubectl scale statefulset postgres --replicas=1 -n production
```

## Section 7: Volume Snapshots

VolumeSnapshots provide point-in-time copies of PVCs. They require the VolumeSnapshot CRDs and a driver that supports snapshots.

### Installing VolumeSnapshot CRDs

```bash
# Install VolumeSnapshot CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Install the snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### VolumeSnapshotClass and Snapshots

```yaml
# volumesnapshotclass.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshot-class
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Delete     # Delete underlying snapshot when VolumeSnapshot is deleted
parameters:
  tagSpecification_1: "key=backup-type,value=scheduled"
  tagSpecification_2: "key=environment,value=production"
---
# Take a snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-20280807
  namespace: production
spec:
  volumeSnapshotClassName: ebs-snapshot-class
  source:
    persistentVolumeClaimName: postgres-data
```

### Restore from Snapshot

```yaml
# pvc-from-snapshot.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  dataSource:
    name: postgres-snapshot-20280807
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi    # Must match or exceed snapshot size
  storageClassName: ssd
```

### Automated Snapshot Schedule

```bash
#!/bin/bash
# snapshot-schedule.sh
# Creates daily snapshots and retains last 7

set -euo pipefail

NAMESPACE="production"
PVC_NAME="postgres-data"
SNAPSHOT_CLASS="ebs-snapshot-class"
RETENTION_DAYS=7

DATE=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_NAME="${PVC_NAME}-${DATE}"

echo "Creating snapshot: ${SNAPSHOT_NAME}"

kubectl apply -f - << EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${SNAPSHOT_NAME}
  namespace: ${NAMESPACE}
  labels:
    app: postgres
    backup-schedule: daily
spec:
  volumeSnapshotClassName: ${SNAPSHOT_CLASS}
  source:
    persistentVolumeClaimName: ${PVC_NAME}
EOF

# Wait for snapshot to be ready
kubectl wait volumesnapshot "${SNAPSHOT_NAME}" \
  -n "${NAMESPACE}" \
  --for=jsonpath='{.status.readyToUse}'=true \
  --timeout=300s

echo "Snapshot ${SNAPSHOT_NAME} ready."

# Clean up old snapshots (keep last RETENTION_DAYS)
echo "Cleaning up snapshots older than ${RETENTION_DAYS} days..."
kubectl get volumesnapshots -n "${NAMESPACE}" \
  -l "app=postgres,backup-schedule=daily" \
  --sort-by=.metadata.creationTimestamp \
  -o json | jq -r '.items[].metadata.name' | \
  head -n -${RETENTION_DAYS} | while read -r old_snapshot; do
  echo "  Deleting: ${old_snapshot}"
  kubectl delete volumesnapshot "${old_snapshot}" -n "${NAMESPACE}"
done

echo "Done."
```

## Section 8: Local Persistent Volumes

For workloads needing maximum I/O performance with local NVMe:

```yaml
# local-pv.yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-nvme-node1
spec:
  capacity:
    storage: 1Ti
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-nvme
  local:
    path: /mnt/nvme0n1    # Must exist on the node
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node1.cluster.internal
```

### Local Volume Provisioner

Manual PV creation doesn't scale. The local-static-provisioner discovers and creates PVs automatically:

```yaml
# local-provisioner-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-provisioner-config
  namespace: kube-system
data:
  storageClassMap: |
    local-nvme:
      hostDir: /mnt/fast-disks
      mountDir: /mnt/fast-disks
      blockCleanerCommand:
        - "/scripts/shred.sh"
        - "2"
      volumeMode: Filesystem
      fsType: ext4
      namePattern: "*"
```

## Section 9: StatefulSet Storage Patterns

```yaml
# statefulset-with-storage.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: production
spec:
  serviceName: elasticsearch
  replicas: 3
  selector:
    matchLabels:
      app: elasticsearch
  template:
    metadata:
      labels:
        app: elasticsearch
    spec:
      initContainers:
        # Fix ownership after volume mount
        - name: fix-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 1000:1000 /usr/share/elasticsearch/data"]
          volumeMounts:
            - name: data
              mountPath: /usr/share/elasticsearch/data
      containers:
        - name: elasticsearch
          image: docker.elastic.co/elasticsearch/elasticsearch:8.12.0
          env:
            - name: node.name
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: cluster.name
              value: production-cluster
          volumeMounts:
            - name: data
              mountPath: /usr/share/elasticsearch/data
          resources:
            requests:
              memory: 2Gi
              cpu: 500m
            limits:
              memory: 4Gi
  # VolumeClaimTemplate creates one PVC per pod
  volumeClaimTemplates:
    - metadata:
        name: data
        labels:
          app: elasticsearch
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ssd
        resources:
          requests:
            storage: 100Gi
```

### Managing StatefulSet PVCs

```bash
# List PVCs for a StatefulSet
kubectl get pvc -l app=elasticsearch -n production
# data-elasticsearch-0, data-elasticsearch-1, data-elasticsearch-2

# PVCs are NOT deleted when StatefulSet is deleted — intentional safety
kubectl delete statefulset elasticsearch -n production
kubectl get pvc -l app=elasticsearch -n production  # Still exists

# To fully clean up (DESTRUCTIVE — deletes data):
kubectl delete pvc -l app=elasticsearch -n production

# Scale down gracefully, check data replication before PVC deletion
kubectl scale statefulset elasticsearch --replicas=2 -n production
# Wait for ES to rebalance, then:
kubectl delete pvc data-elasticsearch-2 -n production
```

## Section 10: Reclaim Policies

```bash
# Check reclaim policy for all PVs
kubectl get pv -o custom-columns=\
'NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy,STATUS:.status.phase,CLAIM:.spec.claimRef.name'

# Change reclaim policy of an existing PV (prevents accidental deletion)
kubectl patch pv pvc-1234abcd-5678-efgh \
  -p '{"spec": {"persistentVolumeReclaimPolicy": "Retain"}}'
```

### Released PV Recovery

When a PVC is deleted with `Retain` policy, the PV enters `Released` state. The data is still there; the PV just can't be bound to a new PVC until the `claimRef` is cleared:

```bash
# PV is in Released state — data preserved
kubectl get pv pvc-1234abcd -o yaml | grep status
# phase: Released

# Clear the claimRef to make it Available again
kubectl patch pv pvc-1234abcd \
  --type=json \
  -p='[{"op": "remove", "path": "/spec/claimRef"}]'

# Now the PV is Available and can be bound to a new PVC
kubectl get pv pvc-1234abcd
# STATUS: Available

# Bind to a specific PVC by name
kubectl apply -f - << EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: recovered-data
  namespace: production
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 100Gi
  storageClassName: ssd
  volumeName: pvc-1234abcd   # Direct binding
EOF
```

## Section 11: Troubleshooting Storage Issues

### PVC Stuck in Pending

```bash
# Check PVC events
kubectl describe pvc app-data -n production
# Common causes:
# "no persistent volumes available" -> need to create PVs or check StorageClass
# "waiting for first consumer" -> normal for WaitForFirstConsumer, create a pod
# "failed to provision" -> check CSI driver logs

# Check CSI driver logs
kubectl logs -n kube-system deploy/ebs-csi-controller \
  -c csi-provisioner --tail=50

# Check if StorageClass provisioner is running
kubectl get pods -n kube-system | grep ebs-csi

# Check VolumeBinding plugin logs
kubectl logs -n kube-system kube-scheduler-control-plane \
  | grep -i "volume\|storage" | tail -20

# For WaitForFirstConsumer: PVC binds when a pod using it is scheduled
kubectl describe pvc app-data | grep "waiting for"
# "waiting for first consumer to be created before binding"
# -> Create the pod that uses this PVC
```

### Volume Mount Failures

```bash
# Check pod events for mount errors
kubectl describe pod postgres-0 -n production | grep -A 20 Events
# Common: "MountVolume.SetUp failed"
# "Unable to attach or mount volumes"
# "timed out waiting for the condition"

# Check node storage driver
kubectl get node node1.cluster.internal -o yaml | grep -A 5 volumesAttached

# Check CSI node plugin logs
kubectl logs -n kube-system daemonset/ebs-csi-node \
  -c ebs-plugin --tail=50

# Check kubelet logs on the node
journalctl -u kubelet -n 200 | grep "volume\|mount" | tail -30

# Force detach and reattach (DANGER: only if pod is not running)
# Get volume attachment
kubectl get volumeattachment | grep vol-0abc123
# Delete the attachment to force re-creation
kubectl delete volumeattachment csi-1234abcd
```

### Disk Full Alerts

```yaml
# prometheus-storage-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: storage-alerts
  namespace: monitoring
spec:
  groups:
    - name: storage.rules
      rules:
        # PVC almost full
        - alert: PVCAlmostFull
          expr: |
            (
              kubelet_volume_stats_used_bytes /
              kubelet_volume_stats_capacity_bytes
            ) > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.persistentvolumeclaim }} is {{ $value | humanizePercentage }} full"

        # PVC critically full
        - alert: PVCCriticallyFull
          expr: |
            (
              kubelet_volume_stats_used_bytes /
              kubelet_volume_stats_capacity_bytes
            ) > 0.95
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "PVC {{ $labels.persistentvolumeclaim }} is critically full"

        # PVC inodes exhausted
        - alert: PVCInodesExhausted
          expr: |
            kubelet_volume_stats_inodes_free /
            kubelet_volume_stats_inodes < 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.persistentvolumeclaim }} has < 5% inodes free"
```

## Section 12: Backup with Velero

```bash
# Install Velero for cluster backup (includes PVC snapshots)
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --set configuration.provider=aws \
  --set configuration.backupStorageLocation.bucket=my-velero-backups \
  --set configuration.backupStorageLocation.config.region=us-east-1 \
  --set configuration.volumeSnapshotLocation.provider=aws \
  --set configuration.volumeSnapshotLocation.config.region=us-east-1 \
  --set serviceAccount.server.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789:role/velero-role \
  --set snapshotsEnabled=true \
  --set initContainers[0].name=velero-plugin-for-aws \
  --set initContainers[0].image=velero/velero-plugin-for-aws:v1.9.0 \
  --set initContainers[0].volumeMounts[0].mountPath=/target \
  --set initContainers[0].volumeMounts[0].name=plugins

# Schedule daily backups
velero schedule create daily-backup \
  --schedule="0 2 * * *" \
  --include-namespaces production \
  --ttl 168h \
  --snapshot-volumes=true

# Manual backup
velero backup create production-backup-$(date +%Y%m%d) \
  --include-namespaces production \
  --snapshot-volumes=true

# Check backup status
velero backup get
velero backup describe production-backup-20280807 --details

# Restore
velero restore create --from-backup production-backup-20280807 \
  --include-namespaces production \
  --namespace-mappings production:production-restored
```

## Section 13: StorageClass Benchmarking

```bash
#!/bin/bash
# storage-benchmark.sh
# Runs fio benchmarks against a PVC using a pod

set -euo pipefail

STORAGE_CLASS=${1:-"ssd"}
NAMESPACE=${2:-"default"}
SIZE=${3:-"10Gi"}

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: bench-pvc
  namespace: ${NAMESPACE}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${STORAGE_CLASS}
  resources:
    requests:
      storage: ${SIZE}
EOF

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: storage-bench
  namespace: ${NAMESPACE}
spec:
  restartPolicy: Never
  containers:
    - name: fio
      image: ljishen/fio:latest
      command:
        - sh
        - -c
        - |
          echo "=== Sequential Write ===" && \
          fio --name=seqwrite --ioengine=libaio --iodepth=32 \
              --rw=write --bs=1m --direct=1 --size=4g \
              --filename=/data/testfile --output-format=terse && \
          echo "=== Sequential Read ===" && \
          fio --name=seqread --ioengine=libaio --iodepth=32 \
              --rw=read --bs=1m --direct=1 --size=4g \
              --filename=/data/testfile --output-format=terse && \
          echo "=== Random Read/Write 4K ===" && \
          fio --name=randrw --ioengine=libaio --iodepth=64 \
              --rw=randrw --rwmixread=75 --bs=4k --direct=1 --size=4g \
              --filename=/data/testfile --output-format=terse
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: bench-pvc
EOF

echo "Waiting for benchmark pod to complete..."
kubectl wait pod/storage-bench -n "${NAMESPACE}" \
  --for=condition=Succeeded --timeout=600s

echo "=== Benchmark Results ==="
kubectl logs storage-bench -n "${NAMESPACE}"

echo ""
echo "Cleaning up..."
kubectl delete pod/storage-bench pvc/bench-pvc -n "${NAMESPACE}"
```

## Conclusion

Kubernetes persistent storage requires careful design at every layer. Key takeaways:

- **StorageClass tiers**: Design at least three tiers — high-IOPS SSD for databases, standard SSD for general workloads, and bulk HDD for cold storage. Set `WaitForFirstConsumer` binding mode to ensure volumes are provisioned in the same zone as the pod.
- **CSI drivers**: Understand the three-component model (controller plugin, node plugin, sidecar provisioners). When storage operations fail, logs from all three components are needed to diagnose.
- **Reclaim policies**: Use `Retain` for databases and production data. Use `Delete` for ephemeral workloads. Never use `Recycle` (deprecated).
- **Volume expansion**: Always verify `allowVolumeExpansion: true` on the StorageClass before you need to expand. Online expansion depends on CSI driver capabilities — not all drivers support it.
- **Snapshots**: The VolumeSnapshot API is stable and well-supported. Use it for application-consistent pre-upgrade backups, not just as a substitute for proper backup tooling like Velero.
- **Monitoring**: Track PVC fill rate with linear prediction, not just current usage. A PVC at 80% that grew 5% in the last hour needs attention before it hits 95%.
