---
title: "Kubernetes Trident: NetApp Storage Integration for Enterprise Kubernetes Deployments"
date: 2030-11-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Trident", "NetApp", "ONTAP", "Storage", "CSI", "Persistent Volumes", "Enterprise Storage"]
categories:
- Kubernetes
- Storage
- Enterprise
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Trident guide covering ONTAP NAS/SAN backend configuration, StorageClass design for different performance tiers, volume import and clone operations, snapshot-based backup integration, QoS policies, and migrating legacy storage to Kubernetes with Trident."
more_link: "yes"
url: "/kubernetes-trident-netapp-storage-enterprise-guide/"
---

NetApp Trident is the de-facto CSI driver for organizations with existing NetApp ONTAP investments who need to extend that infrastructure into Kubernetes. Trident bridges the gap between the enterprise storage world — with its tiered QoS, snapshots, clones, and data management workflows — and the Kubernetes PersistentVolume model. This guide covers backend configuration for both NAS (NFS) and SAN (iSCSI/Fibre Channel) workloads, StorageClass design, snapshot integration, volume migration, and operational monitoring.

<!--more-->

## Trident Architecture

Trident deploys as a DaemonSet (node plugin) and a Deployment (controller). The controller handles provisioning decisions by calling the ONTAP REST API or ZAPI; the node plugins attach and mount volumes on Kubernetes worker nodes.

Core concepts:

- **Backend**: A Trident resource representing an ONTAP SVM (Storage Virtual Machine) with credentials and configuration.
- **StoragePool**: A subset of backend capacity (an aggregate) with specific characteristics.
- **StorageClass**: A Kubernetes resource that maps requests to a backend/pool combination via Virtual Storage Pool selectors.
- **TridentVolumeReference**: A Trident annotation that enables volume import from existing ONTAP volumes.

Trident supports these ONTAP backends:

| Driver | Protocol | Use Case |
|--------|----------|----------|
| `ontap-nas` | NFS v3/v4 | ReadWriteMany workloads, shared filesystems |
| `ontap-nas-economy` | NFS | High volume count, qtree-based |
| `ontap-nas-flexgroup` | NFS | Very large single namespace |
| `ontap-san` | iSCSI | Block storage, ReadWriteOnce |
| `ontap-san-economy` | iSCSI | High volume count, LUN-based |

## Installing Trident

Install Trident using the Helm chart:

```bash
helm repo add netapp-trident https://netapp.github.io/trident-helm-chart
helm repo update

helm upgrade --install trident netapp-trident/trident-operator \
  --namespace trident \
  --create-namespace \
  --version 24.10.0 \
  --set tridentAutosupportProxy="" \
  --set tridentAutosupportInsecure=true \
  --set imageRegistry="docker.io/netapp"

# Verify installation
kubectl -n trident get pods
# NAME                                  READY   STATUS    RESTARTS   AGE
# trident-controller-59b4f9f898-xkqvt   6/6     Running   0          3m
# trident-node-linux-2m8q7              2/2     Running   0          3m
# trident-node-linux-7p4rs              2/2     Running   0          3m
# trident-node-linux-qnx9f              2/2     Running   0          3m
# trident-operator-7b56487489-k9lzx     1/1     Running   0          3m

# Install tridentctl
kubectl exec -n trident deploy/trident-controller -- tridentctl version
```

## Configuring ONTAP NAS Backends

### Dedicated SVM for Kubernetes

Best practice is to create a dedicated SVM for Kubernetes workloads:

```bash
# Run on ONTAP CLI or via System Manager
# Create SVM
vserver create -vserver svm-k8s-prod -rootvolume svm_k8s_prod_root \
  -rootvolume-security-style unix -language en_US \
  -snapshot-policy default -ipspace Default

# Create a management LIF
network interface create -vserver svm-k8s-prod \
  -lif svm-k8s-mgmt -service-policy default-management \
  -home-node ontap-node-01 -home-port e0c \
  -address 10.0.2.50 -netmask 255.255.255.0

# Create data LIFs for NFS
network interface create -vserver svm-k8s-prod \
  -lif svm-k8s-nfs-01 -service-policy default-data-files \
  -home-node ontap-node-01 -home-port e0d \
  -address 10.0.2.51 -netmask 255.255.255.0

network interface create -vserver svm-k8s-prod \
  -lif svm-k8s-nfs-02 -service-policy default-data-files \
  -home-node ontap-node-02 -home-port e0d \
  -address 10.0.2.52 -netmask 255.255.255.0

# Enable NFS
nfs create -vserver svm-k8s-prod -access true -v3 enabled -v4.1 enabled

# Create export policy for Kubernetes nodes
vserver export-policy create -vserver svm-k8s-prod -policyname k8s-nodes
vserver export-policy rule create -vserver svm-k8s-prod \
  -policyname k8s-nodes -clientmatch 10.0.1.0/24 \
  -rorule sys -rwrule sys -superuser sys -anon 65534

# Set SVM root volume export policy
volume modify -vserver svm-k8s-prod -volume svm_k8s_prod_root \
  -policy k8s-nodes
```

### ONTAP NAS Backend Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ontap-nas-backend-secret
  namespace: trident
type: Opaque
stringData:
  username: "vsadmin"
  password: "<ontap-vsadmin-password>"
```

### ONTAP NAS Backend Configuration

```yaml
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ontap-nas-backend-prod
  namespace: trident
spec:
  version: 1
  backendName: ontap-nas-prod
  storageDriverName: ontap-nas
  managementLIF: "10.0.2.50"
  dataLIF: "10.0.2.51"
  svm: "svm-k8s-prod"
  credentials:
    name: ontap-nas-backend-secret
    type: Secret
  # NFS mount options applied to all volumes from this backend
  nfsMountOptions: "vers=4.1,nconnect=16,rsize=65536,wsize=65536,hard,timeo=600,retrans=2"
  # Snapshot directory visibility
  snapshotDir: "false"
  # Unix permissions for new volumes
  unixPermissions: "0777"
  # Export policy to use for new volumes
  exportPolicy: "k8s-nodes"
  # Labels applied to volumes for chargeback
  labels:
    environment: production
    managed-by: trident
    platform: kubernetes
  # Virtual Storage Pools — different aggregates with different characteristics
  storage:
    - labels:
        performance: premium
        media: ssd
      aggregate: aggr_ssd_01
      spaceAllocation: "true"
      spaceReserve: volume
      encryption: "true"
      qosPolicy: k8s-premium-qos
    - labels:
        performance: standard
        media: hdd
      aggregate: aggr_hdd_01
      spaceAllocation: "true"
      spaceReserve: none
      encryption: "false"
    - labels:
        performance: archive
        media: hdd
        tier: cold
      aggregate: aggr_archive_01
      spaceAllocation: "true"
      tieringPolicy: auto
```

Verify backend registration:

```bash
kubectl -n trident exec deploy/trident-controller -- \
  tridentctl get backend ontap-nas-prod -o wide
# +-------------------+----------------+--------------------------------------+--------+
# | NAME              | STORAGE DRIVER | UUID                                 | STATE  |
# +-------------------+----------------+--------------------------------------+--------+
# | ontap-nas-prod    | ontap-nas      | a40c90d9-e4b6-f0b9-c123-456789abcdef | online |
# +-------------------+----------------+--------------------------------------+--------+
```

## Configuring ONTAP SAN Backends (iSCSI)

### iSCSI SVM Configuration

```bash
# Create iSCSI LIF
network interface create -vserver svm-k8s-prod \
  -lif svm-k8s-iscsi-01 -service-policy default-data-iscsi \
  -home-node ontap-node-01 -home-port e0e \
  -address 10.0.3.51 -netmask 255.255.255.0

# Enable iSCSI
iscsi create -vserver svm-k8s-prod
iscsi interface enable -vserver svm-k8s-prod -lif svm-k8s-iscsi-01
```

```yaml
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ontap-san-backend-prod
  namespace: trident
spec:
  version: 1
  backendName: ontap-san-prod
  storageDriverName: ontap-san
  managementLIF: "10.0.2.50"
  dataLIF: "10.0.3.51"
  svm: "svm-k8s-prod"
  credentials:
    name: ontap-nas-backend-secret
    type: Secret
  # iSCSI-specific settings
  useCHAP: true
  chapInitiatorSecret: "<iscsi-chap-initiator-secret>"
  chapTargetInitiatorSecret: "<iscsi-chap-target-initiator-secret>"
  chapTargetUsername: "trident-target"
  chapUsername: "trident-initiator"
  igroupName: "k8s-prod-igroup"
  # LUN geometry for performance
  lunGeometry: "4096"
  storage:
    - labels:
        performance: nvme-flash
        protocol: iscsi
      aggregate: aggr_nvme_01
      spaceAllocation: "true"
      spaceReserve: volume
      snapshots: "true"
    - labels:
        performance: flash
        protocol: iscsi
      aggregate: aggr_ssd_01
      spaceAllocation: "true"
      spaceReserve: none
```

## StorageClass Design for Performance Tiers

Map the Virtual Storage Pool labels to Kubernetes StorageClasses:

```yaml
# Premium SSD NFS — ReadWriteMany workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: netapp-nfs-premium
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: csi.trident.netapp.io
parameters:
  selector: "performance=premium && media=ssd"
  fsType: ""
  snapshotPolicy: "daily"
  snapshotReserve: "10"
  exportPolicy: "k8s-nodes"
  unixPermissions: "0777"
  encryption: "true"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
mountOptions:
  - vers=4.1
  - nconnect=16
  - hard
  - rsize=65536
  - wsize=65536
---
# Standard HDD NFS — general purpose
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: netapp-nfs-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: csi.trident.netapp.io
parameters:
  selector: "performance=standard && media=hdd"
  fsType: ""
  snapshotPolicy: "default"
  snapshotReserve: "5"
  exportPolicy: "k8s-nodes"
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
---
# NVMe Flash iSCSI — database block storage
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: netapp-san-nvme
provisioner: csi.trident.netapp.io
parameters:
  selector: "performance=nvme-flash && protocol=iscsi"
  fsType: "ext4"
  snapshotPolicy: "default"
  snapshotReserve: "10"
  iops: "50000"
  encryption: "true"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
---
# Archive — cold data with auto-tiering
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: netapp-nfs-archive
provisioner: csi.trident.netapp.io
parameters:
  selector: "tier=cold"
  fsType: ""
  tieringPolicy: "auto"
  snapshotPolicy: "weekly"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
```

## Volume Snapshot Integration

Trident integrates with the Kubernetes VolumeSnapshot API for application-consistent snapshots.

### Install VolumeSnapshot CRDs and Controller

```bash
# Install snapshot controller and CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### VolumeSnapshotClass

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: netapp-snapclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: csi.trident.netapp.io
deletionPolicy: Delete
parameters:
  snapshotDir: "true"
```

### Creating and Restoring Snapshots

```yaml
# Create a snapshot of a running database PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-snapshot-20301114
  namespace: databases
spec:
  volumeSnapshotClassName: netapp-snapclass
  source:
    persistentVolumeClaimName: postgres-data
```

```bash
kubectl -n databases get volumesnapshot postgres-data-snapshot-20301114
# NAME                               READYTOUSE   SOURCEPVC       SOURCESNAPSHOTCONTENT   RESTORESIZE   SNAPSHOTCLASS        AGE
# postgres-data-snapshot-20301114   true         postgres-data                           100Gi         netapp-snapclass     5m
```

Restore from a snapshot by creating a new PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: databases
spec:
  storageClassName: netapp-san-nvme
  dataSource:
    name: postgres-data-snapshot-20301114
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

## Volume Import from Existing ONTAP Volumes

Trident can import pre-existing ONTAP FlexVols into Kubernetes as managed PersistentVolumes, enabling zero-downtime migration of legacy NFS-mounted applications.

### Import a NAS Volume

```bash
# The volume must already exist on ONTAP with data
# Get the ONTAP volume name
kubectl -n trident exec deploy/trident-controller -- \
  tridentctl import volume ontap-nas-prod existing-app-data \
  --pvc existing-app-data-pvc.yaml \
  -n production

# existing-app-data-pvc.yaml defines the desired PVC spec:
```

```yaml
# existing-app-data-pvc.yaml (used as import template — not applied directly)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: existing-app-data
  namespace: production
  annotations:
    trident.netapp.io/importVolume: "existing-app-data"
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: netapp-nfs-premium
  resources:
    requests:
      storage: 500Gi
```

After import, the PV and PVC are created and bound. The application can be repointed to use the PVC without moving data.

## Volume Cloning

ONTAP FlexClone creates space-efficient clones for dev/test environments that share blocks with the parent:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-clone-dev
  namespace: development
  annotations:
    trident.netapp.io/cloneFromPVC: "postgres-data"
    trident.netapp.io/splitOnClone: "false"
spec:
  storageClassName: netapp-san-nvme
  dataSourceRef:
    name: postgres-data
    kind: PersistentVolumeClaim
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

The clone is created in seconds regardless of volume size because ONTAP uses metadata redirection rather than copying data blocks until they are modified (copy-on-write).

## QoS Policy Configuration

Define Adaptive QoS policies on ONTAP and reference them in Trident backends:

```bash
# Create a QoS policy on ONTAP
qos adaptive-policy-group create \
  -policy-group k8s-premium-qos \
  -vserver svm-k8s-prod \
  -expected-iops 5000 \
  -peak-iops 50000 \
  -expected-iops-allocation allocated-space \
  -peak-iops-allocation used-space

qos adaptive-policy-group create \
  -policy-group k8s-standard-qos \
  -vserver svm-k8s-prod \
  -expected-iops 500 \
  -peak-iops 5000 \
  -expected-iops-allocation allocated-space \
  -peak-iops-allocation used-space
```

Reference in the backend Virtual Storage Pool:

```yaml
storage:
  - labels:
      performance: premium
    aggregate: aggr_ssd_01
    qosPolicy: k8s-premium-qos
```

Trident applies the QoS policy to each newly provisioned FlexVol or LUN automatically.

## Automated Volume Expansion with Trident

When a PVC's storage request is increased and `allowVolumeExpansion: true` is set on the StorageClass:

```bash
# Expand a database PVC online
kubectl -n databases patch pvc postgres-data \
  --type='merge' \
  -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Monitor the expansion
kubectl -n databases get pvc postgres-data
# STATUS: Bound  CAPACITY: 200Gi
# CONDITION: FileSystemResizePending -> (clears after filesystem is resized)

# Trident calls ONTAP to grow the FlexVol, then resizes the filesystem inside the pod
kubectl -n databases describe pvc postgres-data | grep -A5 Conditions
```

For SAN volumes, the filesystem resize happens online if the application supports it. For NFS, the capacity increase is immediate at the ONTAP level.

## Migrating Legacy Storage to Kubernetes with Trident

### Migration Strategy Overview

The recommended approach for migrating NFS-mounted VMs to Kubernetes PVCs:

1. Create a new FlexVol clone of the source volume using ONTAP FlexClone.
2. Import the clone into Kubernetes using `tridentctl import`.
3. Run the application against the cloned PVC for validation.
4. When ready, quiesce the source application, perform a final volume resync, and cut over.

```bash
# Step 1: Create a FlexClone of the legacy volume
# Run on ONTAP CLI
volume clone create \
  -vserver svm-k8s-prod \
  -flexclone k8s-import-legacy-app \
  -type RW \
  -parent-volume legacy-app-data \
  -parent-snapshot ""

# Step 2: Import the clone into Kubernetes
kubectl -n trident exec deploy/trident-controller -- \
  tridentctl import volume ontap-nas-prod k8s-import-legacy-app \
  --pvc legacy-app-data-pvc.yaml \
  -n production

# Step 3: Deploy the application pointing at the new PVC
# Step 4: At cutover time, quiesce source, snapshot, and import final delta
```

## Monitoring Trident and ONTAP Health

### Trident Metrics

Trident exposes Prometheus metrics via the controller pod:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: trident-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: controller.csi.trident.netapp.io
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
  namespaceSelector:
    matchNames:
      - trident
```

### Key Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: trident-alerts
  namespace: monitoring
spec:
  groups:
    - name: trident.health
      rules:
        - alert: TridentBackendOffline
          expr: |
            trident_backend_state{state!="online"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Trident backend {{ $labels.backend }} is offline"
            description: |
              Trident storage backend {{ $labels.backend }} is in state {{ $labels.state }}.
              New PVC provisioning will fail for StorageClasses using this backend.

        - alert: TridentVolumeProvisioningFailing
          expr: |
            increase(trident_operation_duration_milliseconds_count{
              operation="ProvisionVolume", status="Failed"
            }[15m]) > 3
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Trident volume provisioning failures on {{ $labels.backend }}"
            description: "More than 3 volume provisioning failures in the last 15 minutes."

        - alert: TridentStoragePoolNearCapacity
          expr: |
            (trident_storage_pool_used_bytes / trident_storage_pool_capacity_bytes) > 0.80
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Trident storage pool {{ $labels.pool }} is {{ $value | humanizePercentage }} full"
            description: "Storage pool {{ $labels.pool }} on backend {{ $labels.backend }} is near capacity."
```

### ONTAP Performance Monitoring via REST API

```bash
# Use curl to check ONTAP REST API performance data
curl -sk -u admin:<ontap-password> \
  "https://ontap-mgmt.company.com/api/storage/volumes?svm.name=svm-k8s-prod&fields=name,space,statistics" \
  | python3 -m json.tool | grep -E '"name"|"used"|"available"'
```

## Operational Runbooks

### Diagnosing Failed PVC Binding

```bash
# Check Trident logs for provisioning errors
kubectl -n trident logs deploy/trident-controller -c trident-main --since=1h | \
  grep -i "error\|fail\|unable" | tail -30

# Check the PVC events
kubectl -n production describe pvc problem-pvc | grep -A20 Events

# List all Trident volumes and their states
kubectl -n trident exec deploy/trident-controller -- \
  tridentctl get volume -o wide

# Check backend health
kubectl -n trident exec deploy/trident-controller -- \
  tridentctl get backend -o wide
```

### Manually Deleting a Stuck PV

```bash
# When a PV is stuck in Terminating due to a finalizer
kubectl get pv pvc-12345678-abcd -o json | \
  python3 -c "
import json, sys
pv = json.load(sys.stdin)
pv['metadata']['finalizers'] = []
print(json.dumps(pv))
" | kubectl apply -f -
```

## Multi-Tenancy and Namespace Isolation

In multi-tenant Kubernetes environments, Trident's Virtual Storage Pools and export policies enforce isolation between tenants. Each tenant namespace is mapped to a distinct SVM or export policy:

```yaml
# Tenant A backend — dedicated SVM
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ontap-nas-tenant-a
  namespace: trident
spec:
  version: 1
  backendName: ontap-nas-tenant-a
  storageDriverName: ontap-nas
  managementLIF: "10.0.2.50"
  dataLIF: "10.0.2.53"
  svm: "svm-k8s-tenant-a"
  credentials:
    name: ontap-tenant-a-secret
    type: Secret
  exportPolicy: "tenant-a-nodes"
  labels:
    tenant: "tenant-a"
    environment: production
  storage:
    - labels:
        tenant: "tenant-a"
        tier: premium
      aggregate: aggr_ssd_tenant_a
---
# Tenant A StorageClass — selects only tenant-a backend
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: netapp-tenant-a-premium
provisioner: csi.trident.netapp.io
parameters:
  selector: "tenant=tenant-a && tier=premium"
  fsType: ""
allowVolumeExpansion: true
reclaimPolicy: Retain
```

Namespace restrictions via Trident's namespace selector ensure StorageClass resources cannot be used cross-tenant even if a user has access to the StorageClass name.

## ONTAP FlexGroup Volumes for Large Namespaces

For applications that need to store millions of small files or hundreds of terabytes in a single namespace, ONTAP FlexGroup volumes distribute data across all aggregates automatically:

```yaml
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ontap-flexgroup-backend
  namespace: trident
spec:
  version: 1
  backendName: ontap-flexgroup-prod
  storageDriverName: ontap-nas-flexgroup
  managementLIF: "10.0.2.50"
  dataLIF: "10.0.2.54"
  svm: "svm-k8s-prod"
  credentials:
    name: ontap-nas-backend-secret
    type: Secret
  autoExportCIDRs:
    - "10.0.1.0/24"
  autoExportPolicy: true
  # FlexGroup spans all aggregates automatically
  limitVolumeSize: "200Ti"
  nfsMountOptions: "vers=4.1,nconnect=16,hard"
```

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: netapp-flexgroup-large
provisioner: csi.trident.netapp.io
parameters:
  backendType: "ontap-nas-flexgroup"
  snapshotPolicy: "daily"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
```

FlexGroup volumes are appropriate for AI/ML training data repositories, log aggregation volumes, and genomics data stores where individual file count exceeds 100 million.

## SnapMirror Integration for Cross-SVM Volume Replication

ONTAP SnapMirror provides asynchronous replication of FlexVol volumes between SVMs or clusters. For Kubernetes DR workloads, SnapMirror replicates the Trident-managed volume to a DR cluster where it can be imported via Trident volume import:

```bash
# On ONTAP CLI — create a SnapMirror relationship
snapmirror create \
  -source-path svm-k8s-prod:trident_pvc_a1b2c3d4 \
  -destination-path svm-k8s-dr:trident_pvc_a1b2c3d4_dr \
  -schedule hourly \
  -policy MirrorAllSnapshots

snapmirror initialize \
  -destination-path svm-k8s-dr:trident_pvc_a1b2c3d4_dr

# Monitor replication lag
snapmirror show -destination-path svm-k8s-dr:trident_pvc_a1b2c3d4_dr \
  -fields lag-time,mirror-state,last-transfer-size
# lag-time: 0:02:34   mirror-state: snapmirrored   last-transfer-size: 2.1GB
```

At DR failover time, break the SnapMirror relationship and import the replicated volume into the DR cluster's Trident:

```bash
# Break SnapMirror on DR cluster
snapmirror break -destination-path svm-k8s-dr:trident_pvc_a1b2c3d4_dr

# Import into Kubernetes on DR cluster
kubectl -n trident exec deploy/trident-controller -- \
  tridentctl import volume ontap-nas-dr trident_pvc_a1b2c3d4_dr \
  --pvc dr-import-pvc.yaml \
  -n production-dr
```

## Trident GitOps Integration

Managing Trident backends and StorageClasses through GitOps (ArgoCD or Flux) ensures that storage configuration is version-controlled and auditable:

```yaml
# argocd/trident-config/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: trident-storage-config
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://git.company.com/platform/kubernetes-config
    targetRevision: HEAD
    path: trident/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: trident
  syncPolicy:
    automated:
      prune: false   # Never auto-delete StorageClasses or backends
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - RespectIgnoreDifferences=true
  ignoreDifferences:
    - group: trident.netapp.io
      kind: TridentBackendConfig
      jsonPointers:
        - /spec/credentials   # Credentials are managed separately via Sealed Secrets
```

This approach ensures that SVM migrations, new aggregate additions, and StorageClass changes are reviewed via pull request before being applied to production.

## Summary

Trident brings enterprise NetApp ONTAP capabilities — multi-tier storage, space-efficient clones, application-consistent snapshots, adaptive QoS, and auto-tiering — to Kubernetes with a CSI interface that fits naturally into GitOps workflows. The recommended production deployment uses dedicated SVMs per Kubernetes cluster, Virtual Storage Pools to map ONTAP aggregates to StorageClass performance tiers, VolumeSnapshot integration for pre-upgrade and pre-maintenance data protection, and SnapMirror-backed DR replication. The volume import capability eliminates the need for complex data migrations when moving legacy NFS workloads into Kubernetes, while GitOps-managed backend configurations ensure storage topology changes are auditable and repeatable.
