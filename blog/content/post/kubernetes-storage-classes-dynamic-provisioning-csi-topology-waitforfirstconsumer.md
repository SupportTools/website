---
title: "Kubernetes Storage Classes and Dynamic Provisioning: CSI Drivers, Topology, and WaitForFirstConsumer"
date: 2030-03-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "CSI", "StorageClass", "PersistentVolume", "Topology", "WaitForFirstConsumer"]
categories: ["Kubernetes", "Storage", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise deep-dive into Kubernetes storage class configuration, CSI driver topology awareness, WaitForFirstConsumer binding mode for local storage, multi-zone placement strategies, and production StorageClass parameter tuning."
more_link: "yes"
url: "/kubernetes-storage-classes-dynamic-provisioning-csi-topology-waitforfirstconsumer/"
---

Storage is where many Kubernetes deployments accumulate their most difficult operational debt. Teams set up a StorageClass early in the project, discover it does not behave correctly under specific conditions (pods scheduled to a different zone than their volume, local storage volumes bound before pod scheduling decisions are made), and then live with the consequences rather than understanding and correcting the root cause.

This guide covers the full storage class lifecycle from CSI driver fundamentals through topology-aware provisioning, the WaitForFirstConsumer binding mode that enables local storage to work correctly, multi-zone placement strategies, and parameter tuning for production workloads across the major storage backends.

<!--more-->

## Storage Class Architecture

A StorageClass is a Kubernetes API object that defines a "class" of storage, including the CSI driver that provisions it, the reclaim policy for released volumes, and driver-specific parameters that control the properties of provisioned volumes.

```
PersistentVolumeClaim
        │
        │ references
        ▼
  StorageClass
  ┌─────────────────────────────────┐
  │ provisioner: ebs.csi.aws.com    │
  │ parameters:                     │
  │   type: gp3                     │
  │   iops: "16000"                 │
  │   throughput: "1000"            │
  │ reclaimPolicy: Delete           │
  │ volumeBindingMode:              │
  │   WaitForFirstConsumer          │
  │ allowVolumeExpansion: true      │
  └─────────────┬───────────────────┘
                │ instructs
                ▼
         CSI Driver
    (ebs.csi.aws.com plugin)
                │ calls
                ▼
        Cloud/Storage API
    (AWS EBS CreateVolume, etc.)
                │ produces
                ▼
  PersistentVolume
  (bound to PVC)
```

### StorageClass Fields

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"

# The CSI driver responsible for provisioning
provisioner: ebs.csi.aws.com

# Driver-specific parameters — vary by provisioner
parameters:
  type: gp3
  iopsPerGB: "50"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-<key-id>"
  csi.storage.k8s.io/fstype: ext4

# What happens when a PVC is deleted
# Delete: the underlying volume is deleted (default for dynamic)
# Retain: the volume persists (must be manually cleaned up)
reclaimPolicy: Delete

# Whether PVCs can request more storage after creation
allowVolumeExpansion: true

# Immediate: provision volume immediately when PVC is created
# WaitForFirstConsumer: wait until a pod is scheduled
volumeBindingMode: WaitForFirstConsumer

# Restrict which nodes/topologies can access volumes from this class
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.ebs.csi.aws.com/zone
        values:
          - us-east-1a
          - us-east-1b
          - us-east-1c

# Mount options passed to the node when mounting the volume
mountOptions:
  - noatime
  - nodiratime
  - discard
```

## CSI Driver Architecture

The Container Storage Interface (CSI) is the standard API that decouples storage vendor implementations from the Kubernetes core. Every CSI driver implements two components:

**Controller plugin**: Runs as a Deployment (not on every node). Handles CreateVolume, DeleteVolume, ControllerPublishVolume (attach), and ControllerUnpublishVolume (detach) calls. Requires access to the storage API.

**Node plugin**: Runs as a DaemonSet on every node. Handles NodeStageVolume (format/mount to staging path) and NodePublishVolume (bind-mount to pod directory). Requires privileged access to the node.

```yaml
# Typical CSI driver deployment structure
---
# Controller Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ebs-csi-controller
  namespace: kube-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ebs-csi-controller
  template:
    spec:
      serviceAccountName: ebs-csi-controller-sa
      containers:
        # CSI driver container
        - name: ebs-plugin
          image: public.ecr.aws/ebs-csi-driver/aws-ebs-csi-driver:v1.38.0
          args: ["--endpoint=unix:///var/lib/csi/sockets/pluginproxy/csi.sock"]

        # Kubernetes CSI sidecars
        - name: csi-provisioner
          image: registry.k8s.io/sig-storage/csi-provisioner:v4.0.1
          args:
            - "--csi-address=/var/lib/csi/sockets/pluginproxy/csi.sock"
            - "--feature-gates=Topology=true"
            - "--extra-create-metadata"
            - "--leader-election"

        - name: csi-attacher
          image: registry.k8s.io/sig-storage/csi-attacher:v4.6.1
          args:
            - "--csi-address=/var/lib/csi/sockets/pluginproxy/csi.sock"
            - "--leader-election"

        - name: csi-resizer
          image: registry.k8s.io/sig-storage/csi-resizer:v1.11.1

        - name: csi-snapshotter
          image: registry.k8s.io/sig-storage/csi-snapshotter:v7.0.2
---
# Node DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebs-csi-node
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: ebs-csi-node
  template:
    spec:
      containers:
        - name: ebs-plugin
          image: public.ecr.aws/ebs-csi-driver/aws-ebs-csi-driver:v1.38.0
          args: ["--endpoint=unix:/csi/csi.sock", "--logtostderr", "--v=2"]
          securityContext:
            privileged: true
          volumeMounts:
            - name: kubelet-dir
              mountPath: /var/lib/kubelet
              mountPropagation: Bidirectional
            - name: device-dir
              mountPath: /dev

        - name: node-driver-registrar
          image: registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.10.1
          args:
            - "--csi-address=/csi/csi.sock"
            - "--kubelet-registration-path=/var/lib/kubelet/plugins/ebs.csi.aws.com/csi.sock"

        - name: liveness-probe
          image: registry.k8s.io/sig-storage/livenessprobe:v2.12.0
      volumes:
        - name: kubelet-dir
          hostPath:
            path: /var/lib/kubelet
            type: Directory
        - name: device-dir
          hostPath:
            path: /dev
            type: Directory
```

## Topology-Aware Provisioning

In multi-zone Kubernetes clusters, storage volumes are typically zone-specific. An EBS volume in us-east-1a can only be mounted by nodes in us-east-1a. Without topology-aware provisioning, a volume might be created in a different zone than the pod that needs it, causing scheduling to fail.

### How Topology Works

CSI drivers expose topology keys that map to placement constraints. The provisioner sidecar reads these keys and passes them to the CreateVolume call, ensuring the volume is created in the zone where the pod will run.

```yaml
# StorageClass with explicit topology configuration
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-topology-aware
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  csi.storage.k8s.io/fstype: xfs
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
# WaitForFirstConsumer + no allowedTopologies = provision in zone where pod lands
```

```yaml
# StorageClass restricting to specific zones
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-us-east-1a-only
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.ebs.csi.aws.com/zone
        values:
          - us-east-1a
# This restricts pod scheduling to nodes in us-east-1a
# Use when you need volumes pinned to a specific zone
```

### Verifying Topology Configuration

```bash
# Check topology keys advertised by CSI nodes
kubectl get csinodes -o yaml | \
  python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin.read())
for item in data.get('items', []):
    name = item['metadata']['name']
    topo = item.get('spec', {}).get('topologyKeys', [])
    print(f'{name}: {topo}')
"

# Example output:
# worker-01: ['kubernetes.io/hostname', 'topology.ebs.csi.aws.com/zone']
# worker-02: ['kubernetes.io/hostname', 'topology.ebs.csi.aws.com/zone']

# Check node topology labels
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.ebs\.csi\.aws\.com/zone}{"\n"}{end}'

# Verify PV was created in correct zone
kubectl get pv -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeAffinity.required.nodeSelectorTerms[*].matchExpressions[*]}{"\n"}{end}'
```

## WaitForFirstConsumer Binding Mode

`WaitForFirstConsumer` is the critical setting for any StorageClass that involves zone-specific or node-specific volumes. Without it, volumes are provisioned in an arbitrary zone at PVC creation time, before the scheduler has decided where the pod will run.

### The Problem Without WaitForFirstConsumer

```
Timeline without WaitForFirstConsumer (Immediate binding):

t=0:  PVC created → StorageClass provisions EBS volume in us-east-1c
t=1:  Pod created referencing PVC
t=2:  Scheduler tries to place pod
t=3:  Scheduler sees pod needs volume in us-east-1c
t=4:  All us-east-1c nodes are full or unavailable
t=5:  Pod stuck in Pending forever (volume pinned to wrong zone)
```

```
Timeline with WaitForFirstConsumer:

t=0:  PVC created → No volume provisioned yet, PVC stays Pending
t=1:  Pod created referencing PVC
t=2:  Scheduler evaluates node candidates across all zones
t=3:  Scheduler selects node in us-east-1a, annotates PVC with topology hint
t=4:  CSI provisioner sees annotation, creates volume in us-east-1a
t=5:  Volume and pod both in us-east-1a, pod runs successfully
```

### WaitForFirstConsumer Deep Dive

```yaml
# Correct StorageClass for any zone-specific storage
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

```bash
# Watch the PVC state transitions with WaitForFirstConsumer
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: standard
  resources:
    requests:
      storage: 20Gi
EOF

# PVC stays Pending until a pod claims it
kubectl get pvc test-pvc
# NAME       STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# test-pvc   Pending                                      standard       5s

kubectl describe pvc test-pvc | grep -A3 'Events:'
# Events:
#   Warning  WaitForFirstConsumer  Normal  waiting for first consumer
#                                          to be created before binding

# Now create a pod
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: app
      image: busybox
      command: ["sleep", "3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: test-pvc
EOF

# Watch the chain: pod scheduling → PVC annotation → PV provisioning → pod running
kubectl get events --sort-by='.lastTimestamp' | grep -E '(test-pvc|test-pod)' | tail -10
```

### When Immediate Binding is Appropriate

`Immediate` binding mode is appropriate when:
- The storage is not zone-specific (NFS, Ceph with cross-zone replication, etc.)
- You intentionally want the volume provisioned before a pod claims it (pre-provisioning)
- You are using a ReadWriteMany volume that can be mounted from any zone

```yaml
# StorageClass for NFS (not zone-specific)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-client
provisioner: nfs.csi.k8s.io
parameters:
  server: nfs-server.storage.svc.cluster.local
  share: /data
  mountPermissions: "0755"
reclaimPolicy: Delete
# Immediate is fine for NFS — any node can mount it
volumeBindingMode: Immediate
allowVolumeExpansion: true
mountOptions:
  - hard
  - nfsvers=4.1
  - rsize=1048576
  - wsize=1048576
  - timeo=600
  - retrans=2
```

## Local Storage StorageClasses

Local volumes use actual disk partitions or directories on specific nodes. They require `WaitForFirstConsumer` and must have a node affinity on the PersistentVolume.

### Local Volume Provisioner

The local volume static provisioner from `sig-storage` discovers local disks and creates PersistentVolume objects with appropriate node affinity.

```yaml
# StorageClass for local NVMe SSDs
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme
provisioner: kubernetes.io/no-provisioner   # Static provisioning
volumeBindingMode: WaitForFirstConsumer     # REQUIRED for local volumes
reclaimPolicy: Delete
```

```yaml
# PersistentVolume for a local disk (created by local volume provisioner or manually)
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-nvme-worker-01-disk-a
spec:
  capacity:
    storage: 1Ti
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Delete
  storageClassName: local-nvme
  local:
    path: /mnt/disks/nvme0n1   # mount point on the host
  # REQUIRED: tells Kubernetes which node owns this volume
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - worker-01
```

```yaml
# local-volume-provisioner ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-provisioner-config
  namespace: kube-system
data:
  storageClassMap: |
    local-nvme:
      hostDir: /mnt/disks
      mountDir: /mnt/disks
      blockCleanerCommand:
        - "/scripts/shred.sh"
        - "2"
      volumeMode: Filesystem
      fsType: xfs
      namePattern: "*"
```

### Using Local Storage with StatefulSets

```yaml
# StatefulSet using local-nvme storage
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
spec:
  serviceName: cassandra
  replicas: 3
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      # Pod must be on a node that has a local NVMe disk
      # The volume scheduler handles this automatically with WaitForFirstConsumer
      containers:
        - name: cassandra
          image: cassandra:5.0
          ports:
            - containerPort: 9042
          env:
            - name: MAX_HEAP_SIZE
              value: "8192M"
            - name: HEAP_NEWSIZE
              value: "2048M"
          volumeMounts:
            - name: data
              mountPath: /var/lib/cassandra/data
          resources:
            requests:
              cpu: "4"
              memory: "16Gi"
            limits:
              cpu: "8"
              memory: "32Gi"
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: local-nvme
        resources:
          requests:
            storage: 500Gi
```

## Multi-Zone Storage Placement

For workloads that need high availability across multiple zones, storage strategy requires careful thought.

### Zone-Aware StatefulSet with Anti-Affinity

```yaml
# Spread StatefulSet pods across zones AND ensure each gets a local volume in its zone
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: distributed-store
spec:
  replicas: 3
  selector:
    matchLabels:
      app: distributed-store
  template:
    metadata:
      labels:
        app: distributed-store
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: distributed-store
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: distributed-store
              topologyKey: kubernetes.io/hostname
      containers:
        - name: store
          image: distributed-store:latest
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-topology-aware   # WaitForFirstConsumer
        resources:
          requests:
            storage: 100Gi
```

### Cross-Zone Replication StorageClass (Portworx Example)

```yaml
# StorageClass with built-in cross-zone replication
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-replicated
provisioner: pxd.portworx.com
parameters:
  # Replicate across 3 nodes in different zones
  repl: "3"
  # I/O profile: db for databases, sequential for logs
  io_profile: db_remote
  # Prioritise SSD-backed storage nodes
  priority_io: "high"
  # Enforce zone distribution of replicas
  label: "pz=true"
reclaimPolicy: Delete
allowVolumeExpansion: true
# Immediate is OK here because Portworx manages cross-zone replication
volumeBindingMode: Immediate
```

## StorageClass Parameter Tuning by Backend

### AWS EBS gp3

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3-database
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  # gp3 baseline: 3000 IOPS, 125 MB/s
  # Maximum: 16000 IOPS, 1000 MB/s
  iops: "8000"
  throughput: "500"
  encrypted: "true"
  csi.storage.k8s.io/fstype: xfs
  # XFS is preferred for databases: better performance, online shrink not supported
  # ext4 is fine for general use
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Delete
mountOptions:
  - noatime
  - nodiratime
```

```yaml
# High-performance EBS io2 for demanding databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-io2-high-performance
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iopsPerGB: "64"    # Up to 64000 IOPS per volume (io2 Block Express)
  encrypted: "true"
  csi.storage.k8s.io/fstype: xfs
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain   # Retain for production databases
```

### GCE Persistent Disk

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gce-ssd-database
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  # pd-ssd: 30 IOPS/GB read, 30 IOPS/GB write, up to 100,000 IOPS
  csi.storage.k8s.io/fstype: ext4
  labels: environment=production
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
```

```yaml
# GCE Hyperdisk for extreme IOPS
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: hyperdisk-ml
provisioner: pd.csi.storage.gke.io
parameters:
  type: hyperdisk-ml
  # Hyperdisk ML: 250,000 IOPS, 2,400 MB/s for ML training workloads
  provisioned-iops-on-create: "250000"
  provisioned-throughput-on-create: "2400Mi"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### Longhorn (Self-Hosted)

```yaml
# StorageClass for Longhorn distributed storage
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-replicated
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate   # Longhorn manages replication internally
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"  # 48 hours
  fromBackup: ""
  # Ensure replicas land in different zones
  dataLocality: "disabled"
  # Encryption with Longhorn
  encrypted: "false"
  recurringJobSelector: '[{"name":"snapshot-daily", "isGroup":false}]'
```

## Volume Snapshots

Volume snapshots enable point-in-time copies of PVCs, critical for backup and disaster recovery.

```yaml
# VolumeSnapshotClass
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Delete
parameters:
  # Tag snapshots for cost allocation
  csi.storage.k8s.io/snapshotter-secret-name: aws-secret
  csi.storage.k8s.io/snapshotter-secret-namespace: kube-system
---
# Take a snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-snapshot-20300328
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data-0
---
# Restore from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
spec:
  storageClassName: ebs-gp3-database
  dataSource:
    name: postgres-data-snapshot-20300328
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 100Gi
```

## Volume Expansion

```yaml
# StorageClass with expansion enabled
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: expandable-storage
provisioner: ebs.csi.aws.com
allowVolumeExpansion: true   # Required
volumeBindingMode: WaitForFirstConsumer
```

```bash
# Expand a PVC — simply edit the capacity
kubectl patch pvc postgres-data-0 -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Watch expansion progress
kubectl get pvc postgres-data-0 -w
# NAME               STATUS   VOLUME               CAPACITY   ACCESS MODES   STORAGECLASS         AGE
# postgres-data-0    Bound    pvc-abc123def456...   100Gi      RWO            expandable-storage   2d
# postgres-data-0    Bound    pvc-abc123def456...   100Gi      RWO            expandable-storage   2d   (FileSystemResizePending)
# postgres-data-0    Bound    pvc-abc123def456...   200Gi      RWO            expandable-storage   2d

# Verify filesystem was expanded
kubectl exec -it postgres-0 -- df -h /data

# Manual filesystem resize if the CSI driver does not do it automatically
kubectl exec -it postgres-0 -- resize2fs /dev/xvdf   # ext4
kubectl exec -it postgres-0 -- xfs_growfs /data       # xfs
```

## Troubleshooting Common Storage Issues

```bash
#!/usr/bin/env bash
# diagnose-storage.sh — comprehensive storage diagnostics

echo "=== StorageClass Summary ==="
kubectl get storageclass -o custom-columns=\
'NAME:.metadata.name,PROVISIONER:.provisioner,BINDING:.volumeBindingMode,EXPAND:.allowVolumeExpansion,DEFAULT:.metadata.annotations.storageclass\.kubernetes\.io/is-default-class'

echo ""
echo "=== Pending PVCs ==="
kubectl get pvc -A --field-selector=status.phase=Pending

echo ""
echo "=== PVC Events (last 1h) ==="
kubectl get events -A --sort-by='.lastTimestamp' | grep -i 'pvc\|volume\|provision' | tail -20

echo ""
echo "=== CSI Driver Status ==="
kubectl get csidrivers
kubectl get csinodes | head -10

echo ""
echo "=== Volume Attachment Status ==="
kubectl get volumeattachment | grep -v Attached | head -10

echo ""
echo "=== PV Reclaim Issues ==="
kubectl get pv | grep -E '(Released|Failed)'
```

```bash
# Debug a stuck PVC
PVC_NAME="postgres-data-0"
NAMESPACE="production"

echo "=== PVC Details ==="
kubectl describe pvc -n "$NAMESPACE" "$PVC_NAME"

echo ""
echo "=== Associated PV ==="
PV_NAME=$(kubectl get pvc -n "$NAMESPACE" "$PVC_NAME" -o jsonpath='{.spec.volumeName}')
if [[ -n "$PV_NAME" ]]; then
    kubectl describe pv "$PV_NAME"
fi

echo ""
echo "=== VolumeAttachment ==="
kubectl get volumeattachment | grep "$PV_NAME"

echo ""
echo "=== CSI Controller Logs ==="
kubectl logs -n kube-system \
  "$(kubectl get pods -n kube-system -l app=ebs-csi-controller -o name | head -1)" \
  -c ebs-plugin | tail -30

echo ""
echo "=== CSI Node Logs (on scheduled node) ==="
NODE=$(kubectl get pod -n "$NAMESPACE" -l "statefulset.kubernetes.io/pod-name=$(echo $PVC_NAME | sed 's/-data-//')-0" \
  -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null)
if [[ -n "$NODE" ]]; then
    NODE_POD=$(kubectl get pods -n kube-system -l app=ebs-csi-node \
      --field-selector="spec.nodeName=$NODE" -o name | head -1)
    kubectl logs -n kube-system "$NODE_POD" -c ebs-plugin | tail -30
fi
```

## Key Takeaways

StorageClass configuration is not a set-and-forget operation. The choices you make about binding mode, reclaim policy, and parameters have significant consequences for application availability, data safety, and operational complexity.

The single most important rule is `volumeBindingMode: WaitForFirstConsumer` for any zone-specific or node-specific storage. Using `Immediate` with EBS, GCE PD, or local volumes creates a class of scheduling failure where pods are permanently stuck because their volume is in the wrong zone. WaitForFirstConsumer eliminates this failure mode entirely by deferring provisioning until the scheduler has made its placement decision.

Local volumes (using `kubernetes.io/no-provisioner`) always require WaitForFirstConsumer and explicit PersistentVolume objects with nodeAffinity. The local volume provisioner from sig-storage automates the PV creation step by watching for new disks on nodes and creating matching PV objects.

For production databases and stateful workloads, use `reclaimPolicy: Retain` rather than `Delete`. The `Delete` policy permanently destroys the underlying volume when a PVC is deleted — this is the right default for ephemeral workloads but catastrophic for databases. The Retain policy leaves the underlying volume intact, requiring manual cleanup but ensuring data is never lost by accident.

Volume snapshots via the CSI snapshot API are the correct implementation of backup for dynamically-provisioned storage. Pre-provision VolumeSnapshotClass resources and integrate snapshot creation into your backup pipelines rather than attempting filesystem-level backups of running databases.
