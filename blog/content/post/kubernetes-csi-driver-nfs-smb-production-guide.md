---
title: "Kubernetes CSI Drivers: NFS and SMB Storage for Production Workloads"
date: 2027-04-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CSI", "NFS", "SMB", "Storage", "Persistent Volumes"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying and configuring Kubernetes CSI drivers for NFS and SMB storage including dynamic provisioning, StorageClass configuration, access modes, performance tuning, and troubleshooting."
more_link: "yes"
url: "/kubernetes-csi-driver-nfs-smb-production-guide/"
---

Network-attached storage remains a practical necessity in enterprise Kubernetes environments. Applications that require shared file access across multiple pods, legacy workloads that assume POSIX filesystem semantics, and data pipelines that depend on large pre-existing NFS exports all push teams toward NFS and SMB CSI drivers. This guide covers everything needed to deploy, configure, tune, and troubleshoot both the NFS and SMB CSI drivers in production clusters, from initial Helm installation through StorageClass design, access mode selection, mount option tuning, and systematic PVC failure diagnosis.

<!--more-->

# Kubernetes CSI Drivers: NFS and SMB Storage for Production Workloads

## Architecture Overview

### How CSI Drivers Work in Kubernetes

The Container Storage Interface is a standardized API that decouples Kubernetes storage orchestration from the implementation details of any specific storage backend. A CSI driver consists of two main components:

**Node Plugin**: Runs as a DaemonSet on every eligible node. Handles volume mounting and unmounting at the host level. For NFS and SMB this translates to the kernel-level `mount` system call combined with driver-specific kernel modules (`nfs`, `cifs`).

**Controller Plugin**: Runs as a Deployment. Handles lifecycle operations that are not node-specific: CreateVolume, DeleteVolume, CreateSnapshot, DeleteSnapshot. For dynamic provisioning the controller plugin creates subdirectories on the backing NFS export or SMB share.

**Sidecar containers** provided by the Kubernetes CSI community handle communication between Kubernetes API objects (PVC, VolumeSnapshot) and the CSI driver itself:

- `external-provisioner`: Watches PVCs and calls `CreateVolume`
- `external-attacher`: Manages `VolumeAttachment` objects and calls `ControllerPublishVolume`
- `external-snapshotter`: Handles `VolumeSnapshot` and `VolumeSnapshotContent` objects
- `node-driver-registrar`: Registers the driver with the kubelet on each node
- `livenessprobe`: Exposes a health endpoint for the kubelet to probe

For NFS and SMB, ControllerPublishVolume is a no-op because both protocols are inherently multi-attach capable — the actual attach/detach concept does not apply. This is why both drivers support `ReadWriteMany` without additional coordination infrastructure.

### NFS vs SMB Decision Matrix

| Factor | NFS | SMB/CIFS |
|--------|-----|----------|
| Protocol version | NFSv3, NFSv4, NFSv4.1 | SMB 2.0, 2.1, 3.0, 3.1.1 |
| Linux client maturity | Excellent | Good (kernel cifs module) |
| Windows server support | Requires NFS role | Native |
| Kerberos auth | NFSv4 + Kerberos | AD integration, Kerberos |
| ReadWriteMany | Yes | Yes |
| File locking | Advisory (NFSv3), mandatory (NFSv4) | Mandatory (OPLOCKS) |
| Encryption in transit | NFSv4.1 + Kerberos, or stunnel | SMB 3.x native encryption |
| Typical enterprise backend | NetApp ONTAP, EMC Isilon, FreeNAS | Windows Server, Azure Files, NetApp ONTAP |

## NFS CSI Driver

### Installation with Helm

The official NFS CSI driver is maintained at `github.com/kubernetes-csi/csi-driver-nfs`. Helm is the recommended installation method.

```bash
# Add the Helm repository
helm repo add csi-driver-nfs https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/charts
helm repo update

# Install into the kube-system namespace
helm install csi-driver-nfs csi-driver-nfs/csi-driver-nfs \
  --namespace kube-system \
  --version v4.9.0 \
  --set controller.replicas=2 \
  --set controller.runOnControlPlane=false \
  --set feature.enableInlineVolume=true \
  --set driver.mountPermissions=0777
```

Verify the installation:

```bash
# Check controller pod
kubectl get pods -n kube-system -l app=csi-nfs-controller

# Check node DaemonSet
kubectl get pods -n kube-system -l app=csi-nfs-node

# Confirm the CSIDriver object was registered
kubectl get csidriver nfs.csi.k8s.io -o yaml
```

Expected CSIDriver output:

```yaml
apiVersion: storage.k8s.io/v1
kind: CSIDriver
metadata:
  name: nfs.csi.k8s.io
spec:
  attachRequired: false
  fsGroupPolicy: File
  podInfoOnMount: false
  volumeLifecycleModes:
  - Persistent
  - Ephemeral
```

The `attachRequired: false` field confirms that no VolumeAttachment step occurs — mounts happen directly at the node level during pod scheduling.

### StorageClass Configuration

#### Basic StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-standard
provisioner: nfs.csi.k8s.io
parameters:
  # NFS server hostname or IP address
  server: nfs01.internal.example.com
  # Base path on the NFS server under which subdirectories are created
  share: /exports/kubernetes
  # Subdirectory per PVC (default: "")
  subdir: ""
  # Mount options applied to the base NFS mount
  mountOptions: "nfsvers=4.1,hard,timeo=600,retrans=2,rsize=1048576,wsize=1048576"
reclaimPolicy: Delete
volumeBindingMode: Immediate
allowVolumeExpansion: true
mountOptions:
  - nfsvers=4.1
  - hard
  - timeo=600
  - retrans=2
  - rsize=1048576
  - wsize=1048576
  - nconnect=4
```

#### Production StorageClass with Retain Policy

For stateful workloads where accidental PVC deletion must not destroy data:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-retain
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: nfs.csi.k8s.io
parameters:
  server: nfs01.internal.example.com
  share: /exports/kubernetes/retain
  # Create a subdirectory named after the PVC
  subdir: "${pvc.metadata.namespace}/${pvc.metadata.name}"
  # Set permissions on the created subdirectory
  mountPermissions: "0755"
  # Clean up the subdirectory on volume deletion (requires onDelete parameter)
  onDeletePolicy: retain
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
mountOptions:
  - nfsvers=4.1
  - hard
  - timeo=600
  - retrans=2
  - rsize=1048576
  - wsize=1048576
```

#### High-Performance StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-highperf
provisioner: nfs.csi.k8s.io
parameters:
  server: nfs01.internal.example.com
  share: /exports/highperf
  # Use NFSv4.1 with session trunking
  mountOptions: "nfsvers=4.1,hard,nconnect=8,rsize=1048576,wsize=1048576,noatime,nodiratime"
reclaimPolicy: Delete
volumeBindingMode: Immediate
allowVolumeExpansion: true
mountOptions:
  - nfsvers=4.1
  - hard
  - nconnect=8
  - rsize=1048576
  - wsize=1048576
  - noatime
  - nodiratime
  - actimeo=30
```

The `nconnect` option (available in kernel 5.3+) opens multiple TCP connections to the NFS server per client, dramatically improving throughput for multi-threaded workloads. Values of 4–8 typically saturate 10 GbE links.

### PVC Dynamic Provisioning Examples

#### ReadWriteOnce PVC for a Database

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: nfs-retain
  resources:
    requests:
      storage: 100Gi
```

#### ReadWriteMany PVC for Shared Application Content

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-media
  namespace: production
  labels:
    app: webapp
    tier: storage
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-standard
  resources:
    requests:
      storage: 500Gi
```

#### ReadWriteOncePod PVC (Kubernetes 1.22+)

`ReadWriteOncePod` is the most restrictive access mode: only a single pod may hold a read-write mount at any given time, enforced by the scheduler. This is useful for workloads that are not designed for concurrent writers but should not fail silently when two instances accidentally share a mount.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: exclusive-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOncePod
  storageClassName: nfs-standard
  resources:
    requests:
      storage: 50Gi
```

### ReadWriteMany Use Cases

**Horizontal Pod Autoscaler with Shared Session Storage**

Some legacy applications store user session files on disk. NFS RWX PVCs allow multiple replicas to access the same session directory:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-webapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: legacy-webapp
  template:
    metadata:
      labels:
        app: legacy-webapp
    spec:
      containers:
      - name: webapp
        image: internal.registry.example.com/legacy-webapp:2.1.4
        volumeMounts:
        - name: session-storage
          mountPath: /var/www/sessions
        - name: shared-uploads
          mountPath: /var/www/uploads
      volumes:
      - name: session-storage
        persistentVolumeClaim:
          claimName: webapp-sessions
      - name: shared-uploads
        persistentVolumeClaim:
          claimName: webapp-uploads
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: webapp-sessions
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-standard
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: webapp-uploads
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-standard
  resources:
    requests:
      storage: 200Gi
```

**ML Training Job with Shared Dataset**

Distributed training frameworks like PyTorch DDP read a shared dataset from NFS while writing checkpoints to a per-worker subdirectory:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: model-training
  namespace: ml-platform
spec:
  completions: 4
  parallelism: 4
  completionMode: Indexed
  template:
    spec:
      containers:
      - name: trainer
        image: pytorch-training:2.2.0
        resources:
          requests:
            cpu: "8"
            memory: 64Gi
            nvidia.com/gpu: "1"
          limits:
            nvidia.com/gpu: "1"
        env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        volumeMounts:
        - name: training-data
          mountPath: /data
          readOnly: true
        - name: checkpoints
          mountPath: /checkpoints
      volumes:
      - name: training-data
        persistentVolumeClaim:
          claimName: training-dataset
          readOnly: true
      - name: checkpoints
        persistentVolumeClaim:
          claimName: training-checkpoints
      restartPolicy: OnFailure
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: training-dataset
  namespace: ml-platform
spec:
  accessModes:
    - ReadOnlyMany
  storageClassName: nfs-highperf
  resources:
    requests:
      storage: 2Ti
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: training-checkpoints
  namespace: ml-platform
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-retain
  resources:
    requests:
      storage: 100Gi
```

### Static Provisioning (Pre-existing Exports)

When the NFS export already exists and the subdirectory layout is managed outside of Kubernetes, static provisioning avoids the controller plugin entirely:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-legacy-data
  annotations:
    pv.kubernetes.io/provisioned-by: nfs.csi.k8s.io
spec:
  capacity:
    storage: 1Ti
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  mountOptions:
    - nfsvers=4.1
    - hard
    - timeo=600
    - retrans=2
    - rsize=1048576
    - wsize=1048576
  csi:
    driver: nfs.csi.k8s.io
    volumeHandle: nfs01.internal.example.com#/exports/legacy-data#legacy-data-pv
    volumeAttributes:
      server: nfs01.internal.example.com
      share: /exports/legacy-data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: legacy-data
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: ""
  volumeName: nfs-legacy-data
  resources:
    requests:
      storage: 1Ti
```

## SMB CSI Driver

### Installation

The SMB CSI driver shares a codebase with the NFS CSI driver but targets Windows Server and Azure Files backends:

```bash
# Add repository (same repo as NFS driver)
helm repo add csi-driver-smb https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
helm repo update

# Install
helm install csi-driver-smb csi-driver-smb/csi-driver-smb \
  --namespace kube-system \
  --version v1.15.0 \
  --set controller.replicas=2 \
  --set linux.enabled=true \
  --set windows.enabled=false
```

Verify:

```bash
kubectl get csidriver smb.csi.k8s.io -o yaml
kubectl get pods -n kube-system -l app=csi-smb-controller
kubectl get pods -n kube-system -l app=csi-smb-node
```

### SMB Credential Secret

The SMB CSI driver requires a Kubernetes Secret containing the SMB credentials:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: smb-credentials
  namespace: production
type: Opaque
stringData:
  # Replace with actual credentials managed through your secret management system
  username: svc-k8s-smb
  password: EXAMPLE_TOKEN_REPLACE_ME
```

For production environments, manage this secret through External Secrets Operator or Vault Agent rather than embedding credentials in manifests:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: smb-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: smb-credentials
    creationPolicy: Owner
  data:
  - secretKey: username
    remoteRef:
      key: secret/data/k8s/smb
      property: username
  - secretKey: password
    remoteRef:
      key: secret/data/k8s/smb
      property: password
```

### SMB StorageClass Configuration

#### Windows Server Backend

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: smb-standard
provisioner: smb.csi.k8s.io
parameters:
  source: //fileserver01.internal.example.com/k8s-shares
  # Reference to the Secret containing SMB credentials
  csi.storage.k8s.io/provisioner-secret-name: smb-credentials
  csi.storage.k8s.io/provisioner-secret-namespace: production
  csi.storage.k8s.io/node-stage-secret-name: smb-credentials
  csi.storage.k8s.io/node-stage-secret-namespace: production
reclaimPolicy: Delete
volumeBindingMode: Immediate
allowVolumeExpansion: false
mountOptions:
  - dir_mode=0777
  - file_mode=0777
  - uid=1000
  - gid=1000
  - noperm
  - mfsymlinks
  - cache=strict
  - noserverino
```

#### Azure Files Backend

Azure Files is a common SMB backend in AKS environments. The built-in Azure Files CSI driver is preferred in AKS, but the upstream SMB CSI driver works against Azure Files as well:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azurefile-smb
provisioner: smb.csi.k8s.io
parameters:
  source: //mystorageaccount.file.core.windows.net/myfileshare
  csi.storage.k8s.io/provisioner-secret-name: azure-smb-credentials
  csi.storage.k8s.io/provisioner-secret-namespace: kube-system
  csi.storage.k8s.io/node-stage-secret-name: azure-smb-credentials
  csi.storage.k8s.io/node-stage-secret-namespace: kube-system
reclaimPolicy: Delete
volumeBindingMode: Immediate
mountOptions:
  - dir_mode=0777
  - file_mode=0777
  - uid=1000
  - gid=1000
  - mfsymlinks
  - nobrl
  - serverino
```

### SMB PVC and Deployment Example

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: smb-shared-data
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: smb-standard
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: document-processor
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: document-processor
  template:
    metadata:
      labels:
        app: document-processor
    spec:
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
      - name: processor
        image: internal.registry.example.com/doc-processor:3.0.1
        volumeMounts:
        - name: smb-data
          mountPath: /mnt/documents
      volumes:
      - name: smb-data
        persistentVolumeClaim:
          claimName: smb-shared-data
```

## Performance Optimization

### NFS Mount Option Reference

Mount options have the largest single impact on NFS performance. The following table documents the most important options:

| Option | Default | Recommendation | Rationale |
|--------|---------|----------------|-----------|
| `nfsvers=4.1` | Negotiated | Explicit 4.1 | Session trunking, pNFS support |
| `hard` | hard | hard | Retries indefinitely vs. failing silently |
| `timeo=600` | 600 | 600 (60 seconds) | Retransmission timeout in deciseconds |
| `retrans=2` | 3 | 2–3 | Retransmission attempts before returning error |
| `rsize=1048576` | 131072 | 1048576 (1 MiB) | Read block size; larger improves sequential throughput |
| `wsize=1048576` | 131072 | 1048576 (1 MiB) | Write block size |
| `nconnect=4` | 1 | 4–8 | Parallel TCP connections (kernel 5.3+) |
| `noatime` | atime | noatime | Eliminates read-triggered write for access time |
| `nodiratime` | diratime | nodiratime | Same for directories |
| `actimeo=30` | 30 | 10–60 | Attribute cache timeout; higher reduces server load |
| `async` | sync | async (non-critical) | Buffered writes; do not use for databases |

### Kernel Parameter Tuning for NFS Client Nodes

Add these to `/etc/sysctl.d/99-nfs-client.conf` via a DaemonSet or node configuration tool:

```bash
# Increase socket buffer sizes for high-throughput NFS
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

# Increase sunrpc slot table size (NFS parallelism)
sunrpc.tcp_slot_table_entries = 128
sunrpc.tcp_max_slot_table_entries = 256

# Reduce TCP keepalive for faster stale connection detection
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
```

Apply with a DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: nfs-client-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: nfs-client-tuner
  template:
    metadata:
      labels:
        app: nfs-client-tuner
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
      - operator: Exists
      initContainers:
      - name: sysctl-tuner
        image: busybox:1.36
        securityContext:
          privileged: true
        command:
        - sh
        - -c
        - |
          sysctl -w net.core.rmem_max=134217728
          sysctl -w net.core.wmem_max=134217728
          sysctl -w sunrpc.tcp_slot_table_entries=128
          sysctl -w net.ipv4.tcp_keepalive_time=300
      containers:
      - name: pause
        image: gcr.io/google_containers/pause:3.9
        resources:
          requests:
            cpu: 1m
            memory: 1Mi
```

### SMB Mount Option Performance Tuning

```yaml
# High-throughput SMB StorageClass
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: smb-highperf
provisioner: smb.csi.k8s.io
parameters:
  source: //fileserver01.internal.example.com/highperf-share
  csi.storage.k8s.io/node-stage-secret-name: smb-credentials
  csi.storage.k8s.io/node-stage-secret-namespace: production
reclaimPolicy: Delete
volumeBindingMode: Immediate
mountOptions:
  - dir_mode=0755
  - file_mode=0644
  - uid=1000
  - gid=1000
  - cache=strict
  - rsize=65536
  - wsize=65536
  - actimeo=30
  - noserverino
  - nobrl
```

The `nobrl` option disables byte-range locks, which improves performance for applications that do not require distributed locking. The `cache=strict` option enables aggressive client-side caching while maintaining cache coherence across multiple mounts.

## Troubleshooting PVC Binding Failures

### Systematic Diagnosis Workflow

```bash
#!/bin/bash
# CSI NFS/SMB PVC Diagnostic Script
# Usage: ./diagnose-pvc.sh <namespace> <pvc-name>

set -euo pipefail

NAMESPACE="${1:?namespace required}"
PVC_NAME="${2:?pvc-name required}"

echo "=== PVC Status ==="
kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" -o wide

echo ""
echo "=== PVC Events ==="
kubectl describe pvc "${PVC_NAME}" -n "${NAMESPACE}" | grep -A 20 "Events:"

echo ""
echo "=== PV Details (if bound) ==="
PV_NAME=$(kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)
if [[ -n "${PV_NAME}" ]]; then
  kubectl describe pv "${PV_NAME}"
else
  echo "PVC is not bound to a PV"
fi

echo ""
echo "=== CSI Controller Pod Logs ==="
CONTROLLER_POD=$(kubectl get pods -n kube-system -l app=csi-nfs-controller \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -n "${CONTROLLER_POD}" ]]; then
  kubectl logs "${CONTROLLER_POD}" -n kube-system -c nfs --tail=50
fi

echo ""
echo "=== CSI Node Pod Logs (if pod is stuck) ==="
# Find the node where the problematic pod is scheduled
POD_NODE=$(kubectl get pods -n "${NAMESPACE}" \
  --field-selector spec.volumes.persistentVolumeClaim.claimName="${PVC_NAME}" \
  -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
if [[ -n "${POD_NODE}" ]]; then
  NODE_POD=$(kubectl get pods -n kube-system -l app=csi-nfs-node \
    --field-selector spec.nodeName="${POD_NODE}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -n "${NODE_POD}" ]]; then
    kubectl logs "${NODE_POD}" -n kube-system -c nfs --tail=50
  fi
fi

echo ""
echo "=== StorageClass ==="
SC_NAME=$(kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" -o jsonpath='{.spec.storageClassName}')
kubectl describe storageclass "${SC_NAME}" 2>/dev/null || echo "StorageClass ${SC_NAME} not found"
```

### Common Failure Scenarios

**PVC stuck in Pending: no StorageClass found**

```bash
# Check if the StorageClass exists
kubectl get storageclass

# Check if the driver is registered
kubectl get csidriver

# Verify the provisioner name matches
kubectl get storageclass nfs-standard -o jsonpath='{.provisioner}'
# Should output: nfs.csi.k8s.io
```

**PVC stuck in Pending: CSI controller not running**

```bash
# Verify controller deployment health
kubectl get deployment csi-nfs-controller -n kube-system
kubectl describe deployment csi-nfs-controller -n kube-system

# Check for image pull errors or resource constraints
kubectl get pods -n kube-system -l app=csi-nfs-controller -o wide
kubectl describe pod <controller-pod-name> -n kube-system
```

**Pod stuck in ContainerCreating: mount failed**

```bash
# Check kubelet logs on the node
# First identify the node
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.nodeName}'

# SSH to the node and check kubelet
journalctl -u kubelet -f --since "10 minutes ago" | grep -i "nfs\|mount\|csi"

# Check for stale mounts
findmnt -t nfs4 | head -20

# Test NFS connectivity directly from the node
showmount -e nfs01.internal.example.com

# Manual mount test
mkdir -p /tmp/nfs-test
mount -t nfs4 -o nfsvers=4.1 nfs01.internal.example.com:/exports/kubernetes /tmp/nfs-test
umount /tmp/nfs-test
```

**SMB credential errors**

```bash
# Verify the Secret exists and has the correct keys
kubectl get secret smb-credentials -n production -o jsonpath='{.data}' | \
  python3 -c "import sys,json,base64; d=json.load(sys.stdin); \
  [print(k, ':', base64.b64decode(v).decode()[:3]+'***') for k,v in d.items()]"

# Confirm CSI node pod references the correct secret
kubectl get pods -n kube-system -l app=csi-smb-node -o yaml | \
  grep -A 5 "secretName"

# Test SMB mount manually on a node (requires cifs-utils)
mount -t cifs //fileserver01.internal.example.com/k8s-shares /tmp/smb-test \
  -o username=svc-k8s-smb,password=EXAMPLE_TOKEN_REPLACE_ME,vers=3.0
```

**Volume expansion not working**

```bash
# Confirm the StorageClass has allowVolumeExpansion: true
kubectl get storageclass nfs-standard -o jsonpath='{.allowVolumeExpansion}'

# Check for FileSystemResizePending condition
kubectl get pvc webapp-uploads -n production \
  -o jsonpath='{.status.conditions[*].type}'

# Trigger expansion by editing the PVC
kubectl patch pvc webapp-uploads -n production \
  --type merge -p '{"spec":{"resources":{"requests":{"storage":"300Gi"}}}}'
```

### NFS Stale Mount Recovery

When a node loses connectivity to the NFS server while pods hold mounts, the mounts can become stale. Recovery requires:

```bash
#!/bin/bash
# NFS Stale Mount Recovery
# Run on the affected node

# List all NFS mounts
findmnt -t nfs,nfs4 --output TARGET,SOURCE,OPTIONS

# Identify stale mounts (ls will hang on stale mounts; use timeout)
for mount_point in $(findmnt -t nfs4 --output TARGET --noheadings); do
  echo -n "Testing ${mount_point}: "
  if timeout 5 ls "${mount_point}" &>/dev/null; then
    echo "OK"
  else
    echo "STALE - attempting lazy unmount"
    umount -l "${mount_point}" || true
  fi
done

# Restart kubelet to allow CSI driver to remount
systemctl restart kubelet
```

## Backup Considerations

### Volume Snapshot with the NFS CSI Driver

The NFS CSI driver supports VolumeSnapshots through a custom implementation that creates a point-in-time copy of the subdirectory on the NFS server:

```yaml
# Install the snapshot controller first
# kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml

apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: nfs-snapshotclass
driver: nfs.csi.k8s.io
deletionPolicy: Delete
parameters:
  # Location to store snapshot archives
  server: nfs01.internal.example.com
  share: /exports/snapshots
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: webapp-uploads-snap-20270430
  namespace: production
spec:
  volumeSnapshotClassName: nfs-snapshotclass
  source:
    persistentVolumeClaimName: webapp-uploads
```

### Velero Integration

For cluster-level backup that includes both the PVC data and the associated Kubernetes objects:

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-production
    prefix: cluster01
  config:
    region: us-east-1
---
# Schedule daily backups of the production namespace
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    includedNamespaces:
    - production
    storageLocation: default
    volumeSnapshotLocations:
    - default
    snapshotVolumes: true
    ttl: 720h0m0s
```

## Monitoring

### Prometheus Alerts for CSI Storage

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: csi-nfs-alerts
  namespace: monitoring
spec:
  groups:
  - name: csi-nfs
    interval: 60s
    rules:
    - alert: PVCNotBound
      expr: |
        kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is not bound"
        description: "PVC has been in {{ $labels.phase }} state for more than 10 minutes"

    - alert: PersistentVolumeFillingUp
      expr: |
        (
          kubelet_volume_stats_available_bytes /
          kubelet_volume_stats_capacity_bytes
        ) < 0.10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PV {{ $labels.persistentvolumeclaim }} is {{ printf \"%.0f\" (100 - $value * 100) }}% full"

    - alert: PersistentVolumeFull
      expr: |
        (
          kubelet_volume_stats_available_bytes /
          kubelet_volume_stats_capacity_bytes
        ) < 0.03
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "PV {{ $labels.persistentvolumeclaim }} is critically full"

    - alert: CSINodeDriverNotReady
      expr: |
        kube_node_info and on(node) (
          count by (node) (
            kube_node_status_condition{condition="Ready",status="true"}
          ) == 1
        ) unless on(node) (
          up{job="csi-nfs-node"} == 1
        )
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "CSI NFS node plugin not running on node {{ $labels.node }}"
```

## Conclusion

NFS and SMB CSI drivers provide practical, battle-tested solutions for shared storage in Kubernetes. Key operational decisions are: choosing between `nfsvers=4.1` with `nconnect` for performance-sensitive workloads, setting appropriate reclaim policies (Retain for stateful workloads, Delete for ephemeral scratch space), using ReadWriteMany access modes deliberately and only where concurrent write semantics are safe, and establishing monitoring for PVC binding state and volume fill level. Stale mount recovery remains the most common operational challenge with NFS — building runbooks and alerting around this failure mode before it manifests in production is time well spent.
