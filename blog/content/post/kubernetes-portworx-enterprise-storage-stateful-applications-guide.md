---
title: "Kubernetes Portworx: Enterprise Storage for Stateful Applications at Scale"
date: 2030-11-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Portworx", "Storage", "StatefulSets", "Snapshots", "Autopilot", "Backup", "Enterprise Storage"]
categories:
- Kubernetes
- Storage
- Enterprise
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Portworx guide covering storage pool configuration, replication and HA policies, application-consistent snapshots, CloudSnap backup to object storage, Autopilot for automatic storage expansion, and Portworx PX-Backup for Kubernetes workload protection."
more_link: "yes"
url: "/kubernetes-portworx-enterprise-storage-stateful-applications-guide/"
---

Portworx is a software-defined storage platform that runs as a DaemonSet inside Kubernetes clusters, aggregating local block devices into a shared distributed storage pool. Its distinguishing characteristics for enterprise deployments are synchronous replication at the pod migration level (volumes follow workloads across nodes), application-consistent snapshot integration with stateful applications, Autopilot-driven automated capacity management, and CloudSnap for continuous backup to object storage. This guide covers the full operational surface of a production Portworx deployment.

<!--more-->

## Portworx Architecture

Portworx operates at the kernel layer on each node through a FUSE-like userspace driver integrated with a distributed metadata store. Each participating node contributes local block devices to a storage pool. Volumes are created as virtual block devices that Portworx replicates synchronously across a configurable number of nodes (replication factor).

Key architectural components:

- **PX-Store**: The distributed block storage layer; manages volume placement, replication, and I/O.
- **PX-Spec**: The metadata plane; tracks volume topology, snapshots, and access policies using etcd.
- **Stork**: A Kubernetes scheduler extender and CSI driver component that enables hyperconvergence — scheduling pods on nodes where their volume replicas reside.
- **Autopilot**: A rules engine that monitors storage metrics and triggers capacity or replication changes automatically.
- **PX-Backup**: An enterprise backup solution with application-aware hooks, powered by Velero under the hood.

## Prerequisites and Installation

### Hardware Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| Block device per node | 1× 100GB raw | 2-4× NVMe SSD |
| Memory per node | 4 GB | 8-16 GB |
| CPU per node | 4 cores | 8+ cores |
| Network | 1 Gbps | 10-25 Gbps |

### Installing Portworx via the Operator

```bash
# Install the Portworx Operator
kubectl apply -f 'https://install.portworx.com/2.13?comp=pxoperator'

# Wait for operator pod
kubectl -n kube-system wait --for=condition=ready pod \
  -l name=portworx-operator --timeout=120s
```

Generate the StorageCluster spec using the Portworx Spec Generator (spec.portworx.com) or manually:

```yaml
apiVersion: core.libopenstorage.org/v1
kind: StorageCluster
metadata:
  name: portworx-cluster
  namespace: kube-system
spec:
  image: portworx/oci-monitor:2.13.2
  imagePullPolicy: Always
  kvdb:
    internal: true   # Use internal KVDB for smaller deployments
    # For production, use external etcd:
    # endpoints:
    #   - "etcd:https://etcd-01.company.com:2379"
    #   - "etcd:https://etcd-02.company.com:2379"
    # authSecret: px-etcd-certs

  storage:
    useAll: false
    # Explicitly specify devices to use
    devices:
      - /dev/nvme1n1
      - /dev/nvme2n1
    # Journal device for metadata writes
    journalDevice: auto
    # System metadata device
    systemMetadataDevice: /dev/nvme0n1p2

  network:
    dataInterface: eth1     # Storage network interface
    mgmtInterface: eth0     # Management interface

  secretsProvider: k8s   # Use Kubernetes secrets for encryption keys

  # Enable storage volumes for the internal KVDB
  kvdbDevice: /dev/nvme0n1p1

  # Auto-node decommission configuration
  autoUpdateNodeSpec: true

  # CSI configuration
  csi:
    enabled: true
    installSnapshotController: true

  # Monitoring
  monitoring:
    prometheus:
      enabled: true
      exportMetrics: true
    telemetry:
      enabled: false

  # Stork scheduler extender
  stork:
    enabled: true
    args:
      health-monitor-interval: "120"
      webhook-controller: "true"

  # Advanced features
  featureGates:
    CSI_MIGRATION: "true"

  env:
    - name: PX_HTTP_PROXY
      value: ""
    - name: AUTO_NODE_RECOVERY_TIMEOUT_IN_MINS
      value: "15"
```

```bash
kubectl apply -f portworx-cluster.yaml

# Monitor cluster formation
watch -n 5 "kubectl -n kube-system get storagecluster portworx-cluster"
kubectl -n kube-system get storagenodes -o wide

# Verify PX status with pxctl
PX_POD=$(kubectl -n kube-system get pods -l name=portworx -o name | head -1)
kubectl -n kube-system exec -it ${PX_POD} -- /opt/pwx/bin/pxctl status
# Status: PX is operational
# License: PX-Enterprise (expires ...)
# Node count: 6 (6 online)
# Global capacity / free: 12 TiB / 10.8 TiB
```

## Storage Pool Configuration

Storage pools group block devices with similar characteristics. Portworx automatically creates pools, but explicit configuration provides control over placement:

```bash
# View current storage pools
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl service pool show

# Output:
# PX drive summary
# Pool    Cos   Status  Total   Used    Provisioned  IO Priority
# 0       HIGH  Online  3.6TiB  320GiB  2.1TiB       HIGH (NVMe)
# 1       MEDIUM Online 7.2TiB  1.1TiB  4.8TiB       MEDIUM (SSD)

# Update pool I/O priority label
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl service pool update 0 \
  --io_priority high \
  --labels "media=nvme,tier=fast"

kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl service pool update 1 \
  --io_priority medium \
  --labels "media=ssd,tier=standard"
```

## StorageClass Design

```yaml
# High-performance NVMe — databases and real-time applications
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-db-high
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: pxd.portworx.com
parameters:
  repl: "3"                    # Synchronous replication factor
  io_priority: "high"
  priority_io: "high"
  group: "db-high"
  fg: "true"                   # Foreground (synchronous) replication
  sharedv4: "false"
  disable_io_profile_protection: "false"
  io_profile: "db"             # Tuned for database I/O patterns
  # Encryption at rest
  secure: "true"
  secret_name: "px-encryption-key"
  secret_namespace: "kube-system"
  secret_key: "aes-key"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
---
# Shared ReadWriteMany for CMS and shared data
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-sharedv4
provisioner: pxd.portworx.com
parameters:
  repl: "3"
  io_priority: "medium"
  sharedv4: "true"
  sharedv4_failover_strategy: "normal"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
---
# Local volume for I/O-sensitive workloads (no replication overhead)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-local-fast
provisioner: pxd.portworx.com
parameters:
  repl: "1"
  io_priority: "high"
  nodes: ""    # empty = use the scheduling node
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
---
# Standard replicated storage — general purpose
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: pxd.portworx.com
parameters:
  repl: "2"
  io_priority: "medium"
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

## Application-Consistent Snapshots with 3DSnaps

Portworx 3DSnaps coordinates with application agents to ensure in-flight transactions are quiesced before snapshot creation. Integration is available for PostgreSQL, MySQL, Cassandra, and MongoDB through pre/post exec hooks.

### VolumeSnapshotClass for Portworx

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: portworx-snapclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: pxd.portworx.com
deletionPolicy: Delete
parameters:
  # Options: local (on-cluster) or cloud (CloudSnap)
  type: local
  # Timeout in seconds to wait for application quiesce
  timeout: "300"
```

### PostgreSQL Application-Consistent Snapshot

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-prod-snapshot-20301117
  namespace: databases
  annotations:
    # Execute a pre-snapshot checkpoint in PostgreSQL
    portworx.io/pre-exec: "psql -U postgres -c 'CHECKPOINT; SELECT pg_start_backup(\"px-snapshot\", true);'"
    portworx.io/post-exec: "psql -U postgres -c \"SELECT pg_stop_backup();\""
spec:
  volumeSnapshotClassName: portworx-snapclass
  source:
    persistentVolumeClaimName: postgres-data
```

### Snapshot Groups (Multi-Volume Consistency)

For applications that span multiple PVCs (e.g., a database with separate data and WAL volumes):

```yaml
apiVersion: stork.libopenstorage.org/v1alpha1
kind: GroupVolumeSnapshot
metadata:
  name: postgres-group-snapshot-20301117
  namespace: databases
spec:
  pvcSelector:
    matchLabels:
      app: postgres-prod
  # Take the snapshot across all matching PVCs atomically
  options:
    portworx/snapshot-type: local
  preExecRule: postgres-checkpoint-rule
  postExecRule: postgres-restore-rule
```

## CloudSnap: Continuous Backup to Object Storage

CloudSnap provides asynchronous backup of Portworx volumes to S3-compatible object storage, with incremental uploads after the initial full backup.

### Configuring CloudSnap Credentials

```bash
# Add S3 credentials to Portworx
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl credentials create \
  --provider s3 \
  --s3-access-key "<aws-access-key-id>" \
  --s3-secret-key "<aws-secret-access-key>" \
  --s3-region us-east-1 \
  --s3-endpoint s3.us-east-1.amazonaws.com \
  --bucket px-cloudsnap-prod \
  s3-creds-prod

# Verify credential
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl credentials validate s3-creds-prod
```

### Scheduled CloudSnap via Stork

```yaml
apiVersion: stork.libopenstorage.org/v1alpha1
kind: SchedulePolicy
metadata:
  name: cloudsnap-daily
  namespace: databases
spec:
  daily:
    time: "02:00"
    retain: 7
  weekly:
    day: "Sunday"
    time: "01:00"
    retain: 4
---
apiVersion: stork.libopenstorage.org/v1alpha1
kind: VolumeSnapshotSchedule
metadata:
  name: postgres-prod-cloudsnap
  namespace: databases
spec:
  template:
    spec:
      dataSource:
        name: postgres-data
      volumeSnapshotClassName: portworx-cloud-snapclass
  schedulePolicyName: cloudsnap-daily
  retain: 7
  # Backup to S3 using the configured credentials
  options:
    portworx/cloud-creds-id: "s3-creds-prod"
```

### VolumeSnapshotClass for CloudSnap

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: portworx-cloud-snapclass
driver: pxd.portworx.com
deletionPolicy: Delete
parameters:
  type: cloud
  credentials: s3-creds-prod
```

### Restoring from CloudSnap

```bash
# List available cloud snapshots
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl cloudsnap list \
  --cred-id s3-creds-prod

# Restore a specific cloud snapshot to a new volume
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl cloudsnap restore \
  --cred-id s3-creds-prod \
  --snap <cloud-snap-id> \
  --name postgres-data-restored
```

## Autopilot: Automated Storage Capacity Management

Autopilot monitors Portworx metrics via Prometheus and automatically expands PVCs when they approach capacity, adds replicas when disk utilization drops too low, or rebalances storage pools.

### Deploying Autopilot

```bash
kubectl apply -f https://install.portworx.com/2.13?comp=autopilot
```

### Volume Auto-Expansion Rule

```yaml
apiVersion: autopilot.libopenstorage.org/v1alpha1
kind: AutopilotRule
metadata:
  name: volume-auto-expand
spec:
  # Selector — which PVCs this rule applies to
  selector:
    matchLabels:
      pvc-auto-expand: "true"

  # Monitor conditions
  conditions:
    # Trigger when the volume is >80% full
    - key: "px_volume_usage_percent"
      operator: Gt
      values:
        - "80"
    # And the current size is <1TiB (avoid infinite expansion)
    - key: "px_volume_capacity_bytes"
      operator: Lt
      values:
        - "1099511627776"  # 1 TiB in bytes

  # Actions to take when conditions are met
  actions:
    - name: "openstorage.io.action.volume/resize"
      params:
        # Increase capacity by 50%
        scalepercentage: "50"
        # Maximum size cap
        maxsize: "2Ti"
```

Label PVCs that should be auto-expanded:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: databases
  labels:
    pvc-auto-expand: "true"
spec:
  storageClassName: portworx-db-high
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

### Storage Pool Rebalance Rule

```yaml
apiVersion: autopilot.libopenstorage.org/v1alpha1
kind: AutopilotRule
metadata:
  name: pool-rebalance
spec:
  selector:
    matchLabels:
      type: portworx-storage-pool

  conditions:
    - key: "px_pool_stats_used_bytes"
      operator: Gt
      values:
        - "107374182400"  # 100 GiB

  actions:
    - name: "openstorage.io.action.storagepool/rebalance"
```

## PX-Backup: Kubernetes Workload Protection

PX-Backup extends Portworx with a full Kubernetes backup solution that is aware of namespaces, Helm releases, and application-specific pre/post hooks.

### Installing PX-Backup

```bash
# Deploy PX-Backup using Helm
helm repo add portworx https://raw.githubusercontent.com/portworx/helm/master/repo/stable
helm repo update

helm upgrade --install px-backup portworx/px-backup \
  --namespace px-backup \
  --create-namespace \
  --version 2.7.0 \
  --set persistentStorage.storageClassName=portworx-standard \
  --set persistentStorage.mongodbVolumeSize=20Gi \
  --set pxbackupObjectstoreType=s3 \
  --set pxbackupObjectstore=px-backup-prod \
  --set pxbackupS3Endpoint=s3.us-east-1.amazonaws.com \
  --set pxbackupS3AccessKeyID="<aws-access-key-id>" \
  --set pxbackupS3SecretAccessKey="<aws-secret-access-key>"
```

### Backup Location Configuration

```yaml
apiVersion: backup.libopenstorage.org/v1alpha1
kind: BackupLocation
metadata:
  name: s3-prod
  namespace: px-backup
spec:
  type: S3
  path: "s3://px-backup-prod/kubernetes/"
  s3Config:
    region: us-east-1
    endpoint: s3.us-east-1.amazonaws.com
    encryptionKey: ""  # Optional: server-side encryption key ARN
  encryptionKey: ""
  validateCloudCredential: true
  objectLockEnabled: false
```

### Application Backup Configuration

```yaml
apiVersion: backup.libopenstorage.org/v1alpha1
kind: ApplicationBackup
metadata:
  name: databases-backup-20301117
  namespace: px-backup
spec:
  namespaces:
    - databases
    - redis
  backupLocation: s3-prod
  reclaimPolicy: Delete
  # Volume snapshot integration
  includeVolumes: true
  includeResources: true
  # Resource filters
  resourceTypes:
    - Deployment
    - StatefulSet
    - Service
    - ConfigMap
    - PersistentVolumeClaim
    - VolumeSnapshot
  backupType: Generic
  preExecRule: "database-quiesce-rule"
  postExecRule: "database-resume-rule"
```

### Scheduled Application Backup

```yaml
apiVersion: backup.libopenstorage.org/v1alpha1
kind: ApplicationBackupSchedule
metadata:
  name: databases-daily-backup
  namespace: px-backup
spec:
  schedulePolicyRef:
    name: cloudsnap-daily
    namespace: px-backup
  template:
    spec:
      namespaces:
        - databases
      backupLocation: s3-prod
      includeVolumes: true
      includeResources: true
  reclaimPolicy: Delete
  retain: 7
```

## Hyperconvergence with Stork

Stork ensures that pods running stateful workloads are scheduled on nodes where their volume replicas exist, minimizing network hops for storage I/O.

### Configuring Stork Scheduler

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-prod
  namespace: databases
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres-prod
  template:
    metadata:
      labels:
        app: postgres-prod
    spec:
      # Use the Stork scheduler for hyperconvergent placement
      schedulerName: stork
      containers:
        - name: postgres
          image: postgres:16.3
          resources:
            requests:
              memory: "4Gi"
              cpu: "2"
            limits:
              memory: "8Gi"
              cpu: "4"
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
        labels:
          pvc-auto-expand: "true"
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: portworx-db-high
        resources:
          requests:
            storage: 100Gi
```

## Monitoring Portworx with Prometheus

Portworx exposes metrics via a built-in Prometheus endpoint on port 9001 of each node plugin pod.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: portworx-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      name: portworx
  endpoints:
    - port: px-api
      interval: 30s
      path: /metrics
  namespaceSelector:
    matchNames:
      - kube-system
```

### Critical Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: portworx-alerts
  namespace: monitoring
spec:
  groups:
    - name: portworx.health
      rules:
        - alert: PortworxVolumeUsageCritical
          expr: |
            100 * (px_volume_usage_bytes / px_volume_capacity_bytes) > 85
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Portworx volume {{ $labels.volumeid }} is {{ $value | humanize }}% full"
            description: |
              Volume {{ $labels.volumeid }} on cluster {{ $labels.cluster }} is
              {{ $value }}% full. Autopilot should have triggered — check
              AutopilotRule status if volume has the pvc-auto-expand label.

        - alert: PortworxNodeDown
          expr: |
            px_cluster_nodes_online < px_cluster_nodes_total
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Portworx node down in cluster {{ $labels.cluster }}"
            description: |
              Only {{ $value }} of {{ $labels.px_cluster_nodes_total }} Portworx
              nodes are online. Data redundancy may be compromised.

        - alert: PortworxStoragePoolUsageHigh
          expr: |
            100 * (px_pool_stats_used_bytes / px_pool_stats_total_bytes) > 80
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Portworx storage pool {{ $labels.pool }} is {{ $value }}% full"

        - alert: PortworxVolumeIoError
          expr: |
            increase(px_volume_io_errors_total[5m]) > 10
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "I/O errors on Portworx volume {{ $labels.volumeid }}"
            description: "{{ $value }} I/O errors in the last 5 minutes."

        - alert: PortworxHighIoLatency
          expr: |
            px_volume_write_latency_ms > 50
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "High write latency on Portworx volume {{ $labels.volumeid }}"
            description: "Write latency is {{ $value }}ms (threshold: 50ms)."
```

## Operational Commands

```bash
# Inspect a specific volume
PX_POD=$(kubectl -n kube-system get pods -l name=portworx -o name | head -1)

kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl volume inspect <volume-id>

# List volumes with replica placement
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl volume list --all

# Manually trigger a volume resize
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl volume update --size 200 <volume-id>

# Check CloudSnap backup status
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl cloudsnap status

# View Autopilot rule status
kubectl -n kube-system get autopilotrulesstatuses

# Check Stork health
kubectl -n kube-system get pods -l name=stork
kubectl -n kube-system logs -l name=stork --since=1h | grep -i "error\|warn"

# Force a manual node decommission (for maintenance)
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl cluster decommission --nodeid <node-id>
```

## Disaster Recovery: Cross-Cluster Volume Migration

Portworx supports asynchronous replication to a DR cluster using the `AsyncDR` feature with Stork:

```yaml
# On the source cluster: create a migration schedule
apiVersion: stork.libopenstorage.org/v1alpha1
kind: MigrationSchedule
metadata:
  name: databases-dr-migration
  namespace: databases
spec:
  template:
    spec:
      clusterPair: prod-to-dr
      includeResources: true
      startApplications: false
      namespaces:
        - databases
  schedulePolicyName: cloudsnap-daily
  suspend: false
```

```yaml
# ClusterPair — authorizes Stork to migrate between clusters
apiVersion: stork.libopenstorage.org/v1alpha1
kind: ClusterPair
metadata:
  name: prod-to-dr
  namespace: databases
spec:
  config:
    # DR cluster kubeconfig (base64-encoded, stored in a Secret)
    kubernetes:
      secretName: dr-cluster-kubeconfig
      secretNamespace: databases
  options:
    ip: "dr-portworx-endpoint.company.com"
    port: "9001"
    token: "<portworx-cluster-token>"
    mode: DisasterRecovery
```

## Portworx Security: Encryption at Rest and RBAC

Portworx supports volume-level and cluster-level encryption using Kubernetes secrets or external KMS providers.

### Per-Volume Encryption

```yaml
# Encryption secret for volume-level encryption
apiVersion: v1
kind: Secret
metadata:
  name: px-vol-encryption-key
  namespace: kube-system
type: Opaque
stringData:
  # In production, use a KMS-managed key reference, not a raw key
  key: "<aes-256-encryption-key>"
---
# StorageClass with per-volume encryption
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-encrypted
provisioner: pxd.portworx.com
parameters:
  repl: "3"
  secure: "true"
  secret_name: "px-vol-encryption-key"
  secret_namespace: "kube-system"
  secret_key: "key"
```

### KMS Integration (AWS KMS)

```bash
# Configure Portworx to use AWS KMS for key management
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl secrets aws login \
  --c <aws-access-key-id> \
  --s <aws-secret-access-key> \
  --region us-east-1 \
  --cmk arn:aws:kms:us-east-1:123456789012:key/mrk-1234567890abcdef

# Create an encrypted volume using KMS
kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl volume create \
  --size 100 \
  --repl 3 \
  --secure \
  --secret_key arn:aws:kms:us-east-1:123456789012:key/mrk-1234567890abcdef \
  encrypted-prod-volume
```

## Volume Topology and Anti-Affinity

Portworx supports topology-aware volume placement to ensure replicas are spread across failure domains (zones, racks, data centers):

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: portworx-zone-spread
provisioner: pxd.portworx.com
parameters:
  repl: "3"
  io_priority: "high"
  # Spread replicas across different zones
  replicaset.placement.strategy: "spread"
  labels: "topology.kubernetes.io/zone"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1a
          - us-east-1b
          - us-east-1c
```

Verify replica placement after creating a PVC:

```bash
PV_NAME=$(kubectl -n databases get pvc postgres-data -o jsonpath='{.spec.volumeName}')

kubectl -n kube-system exec -it ${PX_POD} -- \
  /opt/pwx/bin/pxctl volume inspect "${PV_NAME}" | grep -A 10 "Replica sets"
# Replica sets on nodes:
#   Set 0:
#     Node  10.0.1.11  (zone: us-east-1a)
#     Node  10.0.1.22  (zone: us-east-1b)
#     Node  10.0.1.33  (zone: us-east-1c)
```

## Stork Volume Migration for Stateful Workload Scheduling

Stork extends the Kubernetes scheduler to ensure that StatefulSet pods are scheduled on nodes where their volume replicas reside. When a node fails, Stork reschedules the pod to a node that has an available replica rather than waiting for the original node to recover:

```bash
# Check Stork's pod placement decisions
kubectl -n kube-system logs -l name=stork --since=1h | \
  grep -i "volume\|placement\|hyperconverge"

# View Stork's volume placement score for each node
kubectl -n kube-system exec -it $(kubectl -n kube-system get pods -l name=stork -o name | head -1) -- \
  /opt/pwx/bin/pxctl sched-policy list

# Manually trigger a pod migration to its preferred node
kubectl -n databases delete pod postgres-prod-0
# Stork ensures the replacement pod is scheduled on the node with the primary replica
```

## Summary

Portworx delivers enterprise storage features — synchronous replication with pod mobility, application-consistent snapshots, automated capacity management via Autopilot, and cross-cluster DR with AsyncDR — as a fully Kubernetes-native platform. The operational model centers on defining StorageClasses that match application I/O profiles to storage pool tiers, using VolumeSnapshotSchedules with CloudSnap for continuous backup, and relying on Autopilot rules to handle routine capacity events without manual intervention. Prometheus-based monitoring with properly tuned alert thresholds ensures that genuine storage events surface before they impact application availability.
