---
title: "Kubernetes CSI Drivers: Advanced Storage Configuration for Production"
date: 2027-11-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CSI", "Storage", "Longhorn", "Ceph"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes CSI driver architecture, StorageClass parameters, volume expansion, snapshots and cloning, topology-aware provisioning, local volumes, and production deployment patterns for Longhorn and Rook-Ceph."
more_link: "yes"
url: "/kubernetes-storage-csi-advanced-guide/"
---

Storage is the last frontier of stateful workloads in Kubernetes. Get it wrong and you face data loss, split-brain databases, pods stuck in pending due to topology mismatches, and backup operations that silently fail. Get it right and you have a storage layer that provisions dynamically, expands online, creates crash-consistent snapshots, and places data intelligently across failure domains.

This guide covers CSI driver architecture, StorageClass parameter tuning, snapshot and clone workflows, topology-aware provisioning, and the production tradeoffs between Longhorn and Rook-Ceph for on-premises deployments.

<!--more-->

# Kubernetes CSI Drivers: Advanced Storage Configuration for Production

## Section 1: CSI Architecture and the Plugin Model

The Container Storage Interface is a standard that decouples storage systems from the Kubernetes core. A CSI driver implements three gRPC services:

- **Identity Service**: Reports driver name and capabilities
- **Controller Service**: Manages volume lifecycle at the infrastructure level (create, delete, attach, detach, snapshot)
- **Node Service**: Handles node-local operations (mount, unmount, format)

```
┌─────────────────────────────────────────────────────────┐
│                      Kubernetes API                      │
│  PVC → StorageClass → CSI Driver → PersistentVolume      │
└─────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
   ┌──────────▼──────┐ ┌──────▼────────┐ ┌───▼─────────────┐
   │  external-       │ │  CSI          │ │  Node Plugin     │
   │  provisioner    │ │  Controller   │ │  (DaemonSet)     │
   │  (sidecar)      │ │  (Deployment) │ │                  │
   └─────────────────┘ └───────────────┘ └─────────────────┘
```

CSI sidecars (external-provisioner, external-attacher, external-resizer, external-snapshotter) are maintained by the Kubernetes storage SIG and handle Kubernetes API interactions, freeing driver authors to focus on storage-specific logic.

### Understanding Volume Lifecycle

```bash
# Create a PVC that triggers dynamic provisioning
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-nvme
  resources:
    requests:
      storage: 50Gi
EOF

# Watch the PVC bind
kubectl get pvc app-data -w -n production

# Inspect the resulting PV
kubectl get pv $(kubectl get pvc app-data -n production -o jsonpath='{.spec.volumeName}') -o yaml

# Check CSI driver events
kubectl describe pvc app-data -n production
```

## Section 2: StorageClass Design

StorageClass parameters control provisioner-specific behavior. Getting these parameters right is the difference between a storage tier that performs predictably and one that degrades under load.

### AWS EBS CSI StorageClass

```yaml
# fast-nvme StorageClass for NVMe-backed EBS volumes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-nvme
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  # gp3 allows independent IOPS/throughput configuration
  type: gp3
  # 3000 IOPS is the gp3 baseline; up to 16000 for extra cost
  iops: "6000"
  # gp3 throughput in MiB/s (baseline 125, max 1000)
  throughput: "500"
  # Server-side encryption with customer-managed KMS key
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123def456"
  # File system type created on the volume
  csi.storage.k8s.io/fstype: ext4
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
mountOptions:
  - discard       # TRIM support for SSD efficiency
  - noatime       # Skip access time updates for performance
  - data=ordered  # ext4 journaling mode
---
# Standard StorageClass for cost-sensitive workloads
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
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123def456"
  csi.storage.k8s.io/fstype: ext4
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
```

### GCP Persistent Disk CSI StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: premium-rwo
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  replication-type: regional-pd
  csi.storage.k8s.io/fstype: xfs
  disk-encryption-kms-key: projects/myproject/locations/us-central1/keyRings/storage/cryptoKeys/disk-key
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
allowedTopologies:
- matchLabelExpressions:
  - key: topology.gke.io/zone
    values:
    - us-central1-a
    - us-central1-b
    - us-central1-c
```

## Section 3: Volume Expansion

Online volume expansion resizes a PVC without pod disruption on most CSI drivers. The process involves two phases: expanding the PersistentVolume (storage layer), then expanding the filesystem.

```bash
# Patch an existing PVC to expand it from 50Gi to 100Gi
kubectl patch pvc app-data -n production -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'

# Watch the expansion progress
kubectl get pvc app-data -n production -w

# The PVC will show Resizing condition while expansion is in progress
kubectl describe pvc app-data -n production

# After storage expansion, check that filesystem is also expanded
kubectl exec -n production deployment/app -- df -h /data
```

For StatefulSets, PVC expansion requires updating each PVC individually since StatefulSet does not propagate storage changes to existing PVCs:

```bash
#!/bin/bash
# expand-statefulset-pvcs.sh
# Expands all PVCs for a StatefulSet to a new size

NAMESPACE="${1:-default}"
STATEFULSET="${2}"
NEW_SIZE="${3}"

if [[ -z "$STATEFULSET" || -z "$NEW_SIZE" ]]; then
    echo "Usage: $0 <namespace> <statefulset> <new-size>"
    echo "Example: $0 production postgres 200Gi"
    exit 1
fi

# Get all PVCs belonging to the StatefulSet
PVCS=$(kubectl get pvc -n "$NAMESPACE" \
    -l "app=$STATEFULSET" \
    -o jsonpath='{.items[*].metadata.name}')

for PVC in $PVCS; do
    echo "Expanding PVC $PVC to $NEW_SIZE..."
    kubectl patch pvc "$PVC" -n "$NAMESPACE" \
        -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"$NEW_SIZE\"}}}}"

    # Wait for expansion to complete
    kubectl wait --for=condition=FileSystemResizePending=false \
        pvc/"$PVC" -n "$NAMESPACE" --timeout=300s || true
done

echo "All PVCs expanded. Current status:"
kubectl get pvc -n "$NAMESPACE" -l "app=$STATEFULSET"
```

## Section 4: Volume Snapshots and Cloning

VolumeSnapshot resources require the `external-snapshotter` controller and a CSI driver that supports the `CREATE_DELETE_SNAPSHOT` capability.

### VolumeSnapshotClass Configuration

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshot-class
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  # CSI driver-specific snapshot parameters
  tagSpecification_1: "Name=k8s-snapshot-{{.VolumeSnapshotName}}"
  tagSpecification_2: "CreatedBy=kubernetes"
---
# Create a snapshot of an existing PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: app-data-snapshot-20271115
  namespace: production
  annotations:
    backup.mycompany.io/created-by: "automated-backup"
    backup.mycompany.io/ttl: "30d"
spec:
  volumeSnapshotClassName: ebs-snapshot-class
  source:
    persistentVolumeClaimName: app-data
```

Monitor snapshot readiness:

```bash
# Watch snapshot creation
kubectl get volumesnapshot app-data-snapshot-20271115 -n production -w

# Verify snapshot is ready
kubectl wait --for=jsonpath='{.status.readyToUse}'=true \
    volumesnapshot/app-data-snapshot-20271115 -n production --timeout=300s

# Get snapshot handle (useful for cross-cluster operations)
kubectl get volumesnapshot app-data-snapshot-20271115 -n production \
    -o jsonpath='{.status.boundVolumeSnapshotContentName}'
```

### Restoring from Snapshot

```yaml
# Create a new PVC from a snapshot (restore)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-nvme
  resources:
    requests:
      storage: 50Gi  # Must be >= snapshot size
  dataSource:
    name: app-data-snapshot-20271115
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

### Volume Cloning

Cloning creates an exact copy of a PVC without going through a snapshot:

```yaml
# Clone an existing PVC (same namespace, same StorageClass required)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data-clone
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-nvme
  resources:
    requests:
      storage: 50Gi
  dataSource:
    name: app-data      # Source PVC name
    kind: PersistentVolumeClaim
```

## Section 5: Topology-Aware Provisioning

`WaitForFirstConsumer` binding mode delays volume provisioning until a Pod is scheduled, allowing the provisioner to create the volume in the same failure domain (zone) as the Pod.

```yaml
# StorageClass with topology constraints
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: zone-aware-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer  # Critical for topology awareness
reclaimPolicy: Delete
allowVolumeExpansion: true
# Restrict provisioning to specific zones
allowedTopologies:
- matchLabelExpressions:
  - key: topology.kubernetes.io/zone
    values:
    - us-east-1a
    - us-east-1b
    - us-east-1c
```

For workloads that must co-locate replicas in different zones, use Pod topology spread constraints with the storage class:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: distributed-db
  namespace: production
spec:
  serviceName: distributed-db
  replicas: 3
  selector:
    matchLabels:
      app: distributed-db
  template:
    metadata:
      labels:
        app: distributed-db
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: distributed-db
      containers:
      - name: db
        image: postgres:16.2
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: zone-aware-ssd
      resources:
        requests:
          storage: 100Gi
```

## Section 6: Local Volumes for High-Performance Workloads

Local volumes bypass the network stack entirely for maximum IOPS, but require manual provisioning or the Local Path Provisioner, and lack cross-node mobility.

### Local Path Provisioner

```bash
# Install Local Path Provisioner (suitable for development and edge)
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml

# Verify installation
kubectl get storageclass local-path
kubectl get pods -n local-path-storage
```

### Production Local Volume Configuration

For production local volumes, use the static provisioner with pre-formatted disks:

```yaml
# StorageClass for local NVMe volumes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
---
# PersistentVolume for a specific local disk
# One PV per disk per node
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-pv-node1-nvme0
  labels:
    storage-type: local-nvme
    node: worker-node-1
spec:
  capacity:
    storage: 1800Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-nvme
  local:
    path: /mnt/nvme0
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - worker-node-1
```

Script to generate PVs for all NVMe disks across nodes:

```bash
#!/bin/bash
# generate-local-pvs.sh
# Generates PV manifests for all NVMe disks on a node

NODE_NAME=$(kubectl get node -o name | head -1 | cut -d/ -f2)
DISKS=$(lsblk -d -o NAME,TYPE | grep disk | grep nvme | awk '{print $1}')

for DISK in $DISKS; do
    PV_NAME="local-pv-${NODE_NAME}-${DISK}"
    DISK_PATH="/mnt/${DISK}"
    DISK_SIZE=$(lsblk -d -o SIZE --noheadings /dev/$DISK | tr -d ' ')

    cat <<EOF
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${PV_NAME}
spec:
  capacity:
    storage: ${DISK_SIZE}
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-nvme
  local:
    path: ${DISK_PATH}
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - ${NODE_NAME}
EOF
done
```

## Section 7: Longhorn - Distributed Block Storage

Longhorn provides replicated block storage built on iSCSI and NFS, with a rich web UI, backup to S3, and snapshot support. It is best suited for clusters of 3-10 nodes where simplicity and operational visibility matter.

### Longhorn Installation

```bash
# Prerequisites check
curl -sSfL https://raw.githubusercontent.com/longhorn/longhorn/v1.7.0/scripts/environment_check.sh | bash

# Install with Helm
helm repo add longhorn https://charts.longhorn.io
helm repo update

helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --version 1.7.0 \
  --set defaultSettings.defaultReplicaCount=3 \
  --set defaultSettings.storageOverProvisioningPercentage=150 \
  --set defaultSettings.storageMinimalAvailablePercentage=15 \
  --set defaultSettings.backupTarget="s3://my-backup-bucket@us-east-1/" \
  --set defaultSettings.backupTargetCredentialSecret=s3-credentials \
  --set persistence.defaultClassReplicaCount=3 \
  --set persistence.reclaimPolicy=Retain
```

### Longhorn StorageClass Configuration

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-fast
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  fromBackup: ""
  diskSelector: "ssd"           # Only use SSDs for this class
  nodeSelector: "storage=true"  # Only use nodes with storage=true label
  recurringJobSelector: '[{"name":"backup-daily","isGroup":false}]'
  # Data locality: best-effort places one replica on the scheduling node
  dataLocality: "best-effort"
  # XFS provides better performance than ext4 for databases
  fsType: "xfs"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
---
# Longhorn backup StorageClass (cheaper, spinning disk)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-standard
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "30"
  diskSelector: "hdd"
  dataLocality: "disabled"
  fsType: "ext4"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
```

### Longhorn S3 Backup Configuration

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: s3-credentials
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "EXAMPLEAWSACCESSKEY123"
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  AWS_ENDPOINTS: ""     # Leave empty for standard AWS S3
  VIRTUAL_HOSTED_STYLE: "true"
---
# Configure recurring backup job via Longhorn RecurringJob CRD
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: backup-daily
  namespace: longhorn-system
spec:
  cron: "0 2 * * *"  # 2 AM daily
  task: backup
  retain: 14          # Keep 14 backups
  concurrency: 2      # Run 2 backups simultaneously
  labels:
    backup-type: daily
```

## Section 8: Rook-Ceph - Enterprise Scale Storage

Rook-Ceph provides a production-grade distributed storage system with block, file, and object storage. It excels at clusters with many nodes and workloads requiring ReadWriteMany access or S3-compatible object storage.

### Rook-Ceph Operator Installation

```bash
# Install Rook operator
helm repo add rook-release https://charts.rook.io/release
helm repo update

helm install rook-ceph rook-release/rook-ceph \
  --namespace rook-ceph \
  --create-namespace \
  --version 1.15.3 \
  --set enableDiscoveryDaemon=true \
  --set monitoring.enabled=true
```

### CephCluster Configuration

```yaml
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
  mon:
    count: 3
    allowMultiplePerNode: false
  mgr:
    count: 2
    modules:
    - name: pg_autoscaler
      enabled: true
    - name: dashboard
      enabled: true
    - name: prometheus
      enabled: true
  dashboard:
    enabled: true
    ssl: true
  monitoring:
    enabled: true
  network:
    provider: host  # Use host networking for maximum performance
    selectors:
      public: enp0s3   # NIC for client-facing traffic
      cluster: enp0s8  # Dedicated NIC for cluster replication traffic
  crashCollector:
    disable: false
  cleanupPolicy:
    # IMPORTANT: Set to empty string in production. Only set sanitizeDisks
    # for decommissioning: confirmation: yes-really-destroy-data
    confirmation: ""
  removeOSDsIfOutAndSafeToRemove: false
  storage:
    useAllNodes: false
    useAllDevices: false
    nodes:
    - name: "storage-node-1"
      devices:
      - name: "nvme0n1"
        config:
          deviceClass: ssd
      - name: "sdb"
        config:
          deviceClass: hdd
    - name: "storage-node-2"
      devices:
      - name: "nvme0n1"
        config:
          deviceClass: ssd
      - name: "sdb"
        config:
          deviceClass: hdd
    - name: "storage-node-3"
      devices:
      - name: "nvme0n1"
        config:
          deviceClass: ssd
      - name: "sdb"
        config:
          deviceClass: hdd
  placement:
    all:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
          - matchExpressions:
            - key: role
              operator: In
              values:
              - storage
      tolerations:
      - key: storage
        operator: Exists
        effect: NoSchedule
  resources:
    mgr:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    mon:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    osd:
      requests:
        cpu: 1000m
        memory: 4Gi
      limits:
        cpu: 4000m
        memory: 8Gi
```

### Ceph Block Pool and StorageClass

```yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host  # Spread replicas across different hosts
  replicated:
    size: 3
    requireSafeReplicaSize: true  # Refuse writes if < 3 replicas available
  deviceClass: ssd     # Use only SSDs for this pool
  parameters:
    compression_mode: none
    # pg_num managed automatically by pg_autoscaler
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
  imageFeatures: layering,fast-diff,object-map,deep-flatten,exclusive-lock
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: xfs
reclaimPolicy: Retain
allowVolumeExpansion: true
mountOptions:
  - discard
```

### CephFilesystem for ReadWriteMany Access

```yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: shared-fs
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
    deviceClass: ssd
  dataPools:
  - name: default
    failureDomain: host
    replicated:
      size: 3
    deviceClass: ssd
  preserveFilesystemOnDelete: true
  metadataServer:
    activeCount: 2
    activeStandby: true
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 2000m
        memory: 4Gi
---
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
reclaimPolicy: Retain
allowVolumeExpansion: true
```

## Section 9: StatefulSet Storage Patterns

StatefulSets have unique storage requirements: each replica needs its own stable, persistent identity.

### PostgreSQL HA with StatefulSet

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
      securityContext:
        fsGroup: 999       # postgres group
        runAsUser: 999     # postgres user
        fsGroupChangePolicy: "OnRootMismatch"  # Avoid slow chown on large volumes
      initContainers:
      - name: init-permissions
        image: busybox:1.36
        command: ['sh', '-c', 'chown -R 999:999 /var/lib/postgresql/data']
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        securityContext:
          runAsUser: 0  # root needed for chown
      containers:
      - name: postgres
        image: postgres:16.2
        env:
        - name: POSTGRES_DB
          value: appdb
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
        ports:
        - containerPort: 5432
          name: postgres
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        - name: postgres-config
          mountPath: /etc/postgresql
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 2
      volumes:
      - name: postgres-config
        configMap:
          name: postgres-config
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
      annotations:
        # Specify backup schedule for this PVC
        backup.longhorn.io/recurringjobselector: '[{"name":"backup-daily","isGroup":false}]'
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: longhorn-fast
      resources:
        requests:
          storage: 200Gi
```

## Section 10: Longhorn vs Rook-Ceph Decision Matrix

Choosing between Longhorn and Rook-Ceph depends on operational requirements, cluster size, and feature needs.

| Factor | Longhorn | Rook-Ceph |
|---|---|---|
| Cluster size | 3-15 nodes | 5+ nodes (scales to hundreds) |
| Protocol | iSCSI over host | RADOS (native distributed) |
| ReadWriteMany | Not supported (RWO only) | Yes (CephFS) |
| Object storage | No | Yes (Ceph RGW / S3-compatible) |
| Operational complexity | Low (built-in UI) | High (requires Ceph expertise) |
| Backup | S3-native, built-in | Requires velero or separate tooling |
| Snapshot | Yes (CSI) | Yes (CSI) |
| Thin provisioning | Yes | Yes |
| Data locality | Best-effort | Configurable per pool |
| Minimum RAM per storage node | 2Gi | 8Gi (MON+OSD overhead) |
| Recovery from node loss | Automatic re-replication | Automatic re-replication |

### Monitoring Storage Health

```bash
# Longhorn health check
kubectl get volumes.longhorn.io -n longhorn-system
kubectl get engines.longhorn.io -n longhorn-system | grep -v Attached

# Rook-Ceph health check
kubectl exec -n rook-ceph $(kubectl get pod -n rook-ceph -l app=rook-ceph-tools -o name) \
    -- ceph status

kubectl exec -n rook-ceph $(kubectl get pod -n rook-ceph -l app=rook-ceph-tools -o name) \
    -- ceph osd tree

# Check PVC usage across all namespaces
kubectl get pvc -A --sort-by=.metadata.creationTimestamp

# Find PVCs approaching capacity (requires metrics-server)
kubectl top pods -A | sort -k4 -rn | head -20
```

### Prometheus Alerts for Storage

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: storage-alerts
  namespace: monitoring
spec:
  groups:
  - name: storage
    rules:
    - alert: PVCUsageHigh
      expr: |
        (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} usage above 85%"
        description: "PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} is {{ $value | humanizePercentage }} full."

    - alert: PVCUsageCritical
      expr: |
        (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.95
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} critically full"
        description: "PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} is {{ $value | humanizePercentage }} full. Immediate action required."

    - alert: PersistentVolumeClaimPending
      expr: kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} stuck in Pending"
        description: "PVC {{ $labels.persistentvolumeclaim }} has been in Pending state for over 15 minutes."
```

## Summary

Production Kubernetes storage requires careful attention at every layer:

**StorageClass design**: Use `WaitForFirstConsumer` binding mode to ensure topology alignment between pods and volumes. Set explicit IOPS and throughput parameters on cloud providers rather than accepting defaults. Always enable `allowVolumeExpansion: true` with `reclaimPolicy: Retain` for stateful workloads.

**Volume snapshots**: Deploy the external-snapshotter controller and VolumeSnapshotClass before workloads need backup. Test restore procedures regularly - snapshot creation is worthless without a validated restore path.

**Topology awareness**: Multi-zone deployments require topology spread constraints on StatefulSets combined with zone-aware StorageClasses. Without this, all replicas may land in the same zone.

**Longhorn** is the right choice for small-to-medium clusters that need operational simplicity, integrated backup, and a web UI. It does not support ReadWriteMany.

**Rook-Ceph** is the right choice for large clusters, workloads requiring ReadWriteMany (shared filesystems), or when S3-compatible object storage is needed alongside block storage.

**Monitoring**: Alert on PVC usage above 85% to allow time for expansion. Alert on PVCs stuck in Pending for more than 15 minutes - this indicates either topology mismatches or storage pool exhaustion.
