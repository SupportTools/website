---
title: "Kubernetes Longhorn Storage: Enterprise Configuration, Backup, and Disaster Recovery"
date: 2030-09-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Longhorn", "Storage", "Backup", "Disaster Recovery", "Production", "S3"]
categories:
- Kubernetes
- Storage
- Production Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Longhorn guide: volume replication configuration, node disk scheduling, snapshot and backup to S3, recurring backup policies, volume restore procedures, upgrading Longhorn without data loss, and performance tuning for database workloads."
more_link: "yes"
url: "/kubernetes-longhorn-storage-enterprise-configuration-backup-disaster-recovery/"
---

Longhorn provides cloud-native distributed block storage for Kubernetes, built entirely on standard Linux tools: sparse files, iSCSI, and the Linux SCSI target. Unlike Ceph which requires dedicated OSDs and a complex ring topology, Longhorn runs as regular Kubernetes workloads, uses any available disk space on existing nodes, and manages replication through its own controller. This accessibility comes with trade-offs in performance and operational overhead compared to dedicated storage systems, but for clusters where the storage budget doesn't support dedicated hardware and the workload mix includes databases alongside stateless services, Longhorn delivers production-grade reliability with reasonable operational complexity.

<!--more-->

## Longhorn Architecture

Understanding Longhorn's components is essential for troubleshooting and tuning:

- **Longhorn Manager**: DaemonSet running on every node; orchestrates volume lifecycle, scheduling, and replication
- **Longhorn Engine**: Per-volume process running on the node hosting the active replica; handles I/O and replication
- **Replica**: Thin-provisioned sparse file + journal living in a directory on each node's disk
- **Instance Manager**: Manages engine and replica processes on each node
- **CSI Driver**: Translates Kubernetes PVC requests into Longhorn volume operations
- **UI**: Grafana-style dashboard for volume management and health monitoring

Data path for a write:
1. Application writes to mounted volume
2. Linux kernel directs write to iSCSI target (Longhorn Engine)
3. Engine writes to local replica and simultaneously replicates to remote replicas
4. Once all replicas acknowledge, write is confirmed to application

## Installation and Initial Configuration

### Prerequisites Verification

```bash
# Verify all nodes meet Longhorn requirements
curl -sSfL https://raw.githubusercontent.com/longhorn/longhorn/v1.7.0/scripts/environment_check.sh | bash

# Manual checks:
# 1. open-iscsi installed and running on all nodes
apt-get install -y open-iscsi
systemctl enable --now iscsid

# 2. nfs-common for RWX volumes
apt-get install -y nfs-common

# 3. Bash on all nodes
which bash

# 4. Mount propagation enabled (verify Kubernetes feature gate)
kubectl get nodes -o json | jq '.items[].spec.containers'

# Check available disk space per node
for node in $(kubectl get nodes -o name | sed 's/node\///'); do
  echo "=== $node ==="
  kubectl debug node/"$node" -it --image=busybox -- \
    df -h /var/lib/longhorn 2>/dev/null || \
    ssh "$node" df -h /var/lib/longhorn 2>/dev/null
done
```

### Helm Installation with Production Configuration

```yaml
# longhorn-values.yaml
defaultSettings:
  # Replica count: 3 for production (tolerates 2 simultaneous failures)
  defaultReplicaCount: 3

  # Storage over-provisioning: 200% allows creating volumes larger than
  # current disk space (assuming data won't fill all volumes simultaneously)
  storageOverProvisioningPercentage: 200

  # Minimum available space on a disk before Longhorn stops scheduling replicas
  storageMinimalAvailablePercentage: 15

  # Allow scheduling on nodes with storage pressure
  allowVolumeCreationWithDegradedAvailability: false

  # Replica soft anti-affinity: prefer to place replicas on different nodes
  # but allow same-node placement if no other option exists
  replicaSoftAntiAffinity: true

  # Replica zone soft anti-affinity: for multi-zone clusters
  replicaZoneSoftAntiAffinity: true

  # Automatic salvage: automatically salvage a volume with all failed replicas
  autoSalvage: true

  # Snapshot data integrity: check snapshot data periodically
  snapshotDataIntegrity: "fast-check"

  # Backup compression: lz4 for speed, gzip for size
  backupCompressionMethod: "lz4"

  # Number of worker threads for backup operations
  backupConcurrentLimit: 2

  # Recurring job default group
  recurringJobSelector:
    enable: false

  # Node drain policy: block pod eviction if last healthy replica
  nodeDrainPolicy: "block-if-contains-last-replica"

  # Taint toleration for storage-dedicated nodes
  # taintToleration: "storage-only=true:NoSchedule"

  # Snapshot maximum age (days) before automatic cleanup
  snapshotMaxCount: 5

  # Failed backup time-to-live: clean up failed backups after 7 days
  failedBackupTtl: 10080

  # Concurrent replica rebuild limit
  concurrentReplicaRebuildPerNodeLimit: 5

  # Volume data locality: prefer routing I/O through the local replica
  defaultDataLocality: "best-effort"

persistence:
  defaultClass: true
  defaultFsType: ext4
  defaultClassReplicaCount: 3
  defaultDataLocality: best-effort
  reclaimPolicy: Retain
  recurringJobSelector:
    enable: true
    jobList:
      - name: daily-backup
        isGroup: false

longhornUI:
  replicas: 1
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

longhornManager:
  priorityClass: system-node-critical
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 512Mi
```

```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update

helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --version 1.7.0 \
  --values longhorn-values.yaml \
  --wait --timeout=600s

# Verify installation
kubectl get pods -n longhorn-system
kubectl get sc longhorn
```

## Node Disk Scheduling Configuration

### Configuring Dedicated Disks

Longhorn uses the default path `/var/lib/longhorn` on each node's root disk unless additional disks are configured. For production, dedicated data disks provide better performance isolation:

```bash
# Add a dedicated disk to a node via the Longhorn API
# Replace <node-name> with actual node name
NODE_NAME="storage-node-01"
DISK_PATH="/mnt/longhorn-ssd"
DISK_SIZE_BYTES="500000000000"  # 500GB

# Prepare the disk
DISK_DEVICE="/dev/nvme1n1"
mkfs.xfs -f "$DISK_DEVICE"
mkdir -p "$DISK_PATH"
echo "$DISK_DEVICE $DISK_PATH xfs defaults,nofail 0 2" >> /etc/fstab
mount "$DISK_PATH"

# Add disk via Longhorn API
kubectl patch node/"$NODE_NAME" \
  --type=merge \
  --patch-file=/dev/stdin << EOF
{
  "metadata": {
    "annotations": {
      "node.longhorn.io/default-disks-config": "[{\"path\":\"$DISK_PATH\",\"allowScheduling\":true,\"tags\":[\"ssd\"]}]"
    }
  }
}
EOF
```

### Disk Tagging for Workload Placement

Disk tags enable routing specific volume types to specific storage tiers:

```bash
# Tag SSD disks
kubectl patch node/storage-node-01 \
  --type=json \
  -p='[{"op":"add","path":"/metadata/annotations/node.longhorn.io~1default-disks-config","value":"[{\"path\":\"/mnt/longhorn-ssd\",\"allowScheduling\":true,\"tags\":[\"ssd\",\"nvme\"]}]"}]'

# Tag HDD disks
kubectl patch node/storage-node-02 \
  --type=json \
  -p='[{"op":"add","path":"/metadata/annotations/node.longhorn.io~1default-disks-config","value":"[{\"path\":\"/mnt/longhorn-hdd\",\"allowScheduling\":true,\"tags\":[\"hdd\"]}]"}]'
```

### StorageClass with Disk and Node Tags

```yaml
# storageclass-ssd.yaml — volumes land only on SSD-tagged disks
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-ssd
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  fromBackup: ""
  diskSelector: "ssd"
  nodeSelector: ""
  dataLocality: "best-effort"
  fsType: "xfs"
  recurringJobSelector: '[{"name":"daily-backup","isGroup":false}]'
---
# storageclass-hdd.yaml — for bulk data, logs, archives
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-hdd
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "2880"  # 2 days (HDDs are slower to rebuild)
  diskSelector: "hdd"
  dataLocality: "disabled"     # HDD — data locality less important
  fsType: "xfs"
```

## Snapshots and Backup Configuration

### Configuring S3 Backup Target

```bash
# Create the backup target secret
# DO NOT use hardcoded access keys — use IRSA or credential rotation
kubectl create secret generic longhorn-backup-secret \
  --from-literal=AWS_ACCESS_KEY_ID="<aws-access-key-id>" \
  --from-literal=AWS_SECRET_ACCESS_KEY="<aws-secret-access-key>" \
  --from-literal=AWS_REGION="us-east-1" \
  --from-literal=AWS_ENDPOINTS="" \
  -n longhorn-system

# Or using IRSA (recommended — no static credentials)
# Create ServiceAccount with annotation pointing to IAM role
kubectl annotate serviceaccount -n longhorn-system longhorn-service-account \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/LonghornBackupRole
```

```yaml
# longhorn-backup-settings.yaml
# Configure via Longhorn Settings API or Helm values
apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-default-setting
  namespace: longhorn-system
data:
  backup-target: "s3://longhorn-backups-production@us-east-1/backups"
  backup-target-credential-secret: "longhorn-backup-secret"
  backup-compression-method: "lz4"
  backup-concurrent-limit: "2"
  restore-concurrent-limit: "2"
```

### IAM Policy for S3 Backup

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LonghornBackupS3Access",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::longhorn-backups-production",
        "arn:aws:s3:::longhorn-backups-production/*"
      ]
    }
  ]
}
```

### Creating Recurring Backup Jobs

```yaml
# recurring-backup-job.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 2 * * *"    # 2 AM daily
  task: "backup"
  groups:
    - default
  retain: 14            # Keep 14 backups (2 weeks)
  concurrency: 2
  labels:
    type: "daily"
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot
  namespace: longhorn-system
spec:
  cron: "0 * * * *"    # Every hour
  task: "snapshot"
  groups:
    - default
  retain: 24            # Keep 24 hourly snapshots
  concurrency: 5
  labels:
    type: "hourly"
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: weekly-backup
  namespace: longhorn-system
spec:
  cron: "0 3 * * 0"    # 3 AM every Sunday
  task: "backup"
  groups:
    - default
  retain: 52            # Keep 52 weekly backups (1 year)
  concurrency: 1
  labels:
    type: "weekly"
```

### Creating Ad-Hoc Snapshots

```bash
# Create a manual snapshot via kubectl
kubectl apply -f - << 'EOF'
apiVersion: longhorn.io/v1beta2
kind: Snapshot
metadata:
  name: pre-migration-snapshot
  namespace: longhorn-system
spec:
  volume: pvc-12345678-abcd-1234-efgh-123456789012
  createSnapshot: true
EOF

# Wait for snapshot to complete
kubectl wait snapshot/pre-migration-snapshot \
  -n longhorn-system \
  --for=condition=Ready \
  --timeout=300s

# List snapshots for a volume
kubectl get snapshots -n longhorn-system \
  -l longhornvolume=pvc-12345678-abcd-1234-efgh-123456789012
```

## Volume Restore Procedures

### Restoring from Backup

```yaml
# restore-from-backup.yaml
# Create a new PVC from a Longhorn backup
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-restored
  namespace: databases
  annotations:
    # The backup URL from the Longhorn UI or CLI
    longhorn.io/volume-from-backup: "s3://longhorn-backups-production@us-east-1/backups?backup=backup-1234567890&volume=pvc-12345678-abcd-1234-efgh-123456789012"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ssd
  resources:
    requests:
      storage: 100Gi
```

```bash
# Alternatively, restore via Longhorn API
# Get available backups
kubectl get backups.longhorn.io -n longhorn-system

# Create a PVC from a specific backup
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: database-restore-20300920
  namespace: databases
  annotations:
    longhorn.io/volume-from-backup: "s3://longhorn-backups-production@us-east-1/backups?backup=backup-20300920-020000&volume=pvc-database-primary"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ssd
  resources:
    requests:
      storage: 200Gi
EOF

# Monitor restore progress
watch 'kubectl get pvc database-restore-20300920 -n databases && \
  kubectl get volumes.longhorn.io -n longhorn-system | grep restore'
```

### Restoring from Snapshot (Same Volume)

```bash
# Revert a volume to a previous snapshot
# CAUTION: This destroys all data written after the snapshot point

# 1. Scale down workload using the volume
kubectl scale deployment postgres -n databases --replicas=0
kubectl wait pods -n databases -l app=postgres --for=delete --timeout=120s

# 2. Find the snapshot to revert to
kubectl get snapshots -n longhorn-system | grep postgres

# 3. Revert volume to snapshot (via Longhorn UI or API)
# Using Longhorn API:
VOLUME_NAME="pvc-12345678-abcd-1234-efgh-123456789012"
SNAPSHOT_NAME="snapshot-20300920-140000"

kubectl patch volume/"$VOLUME_NAME" -n longhorn-system \
  --type=merge \
  --patch '{"spec":{"fromBackup":"","isRestoring":false}}'

# Actually revert (requires Longhorn UI for snapshot revert, or use CLI)
longhorn volume revert --volume "$VOLUME_NAME" --snapshot "$SNAPSHOT_NAME"

# 4. Scale workload back up
kubectl scale deployment postgres -n databases --replicas=1
```

## Upgrading Longhorn Without Data Loss

### Pre-Upgrade Checklist

```bash
#!/bin/bash
# longhorn-pre-upgrade-check.sh

echo "=== Longhorn Pre-Upgrade Health Check ==="

# 1. Verify all volumes are healthy
DEGRADED_VOLUMES=$(kubectl get volumes.longhorn.io -n longhorn-system \
  -o json | \
  jq -r '.items[] | select(.status.robustness != "healthy") | .metadata.name')

if [ -n "$DEGRADED_VOLUMES" ]; then
    echo "ERROR: Degraded volumes detected — do not upgrade"
    echo "$DEGRADED_VOLUMES"
    exit 1
fi
echo "All volumes healthy: OK"

# 2. Verify all nodes have the correct number of replicas
VOLUMES_UNDERSIZED=$(kubectl get volumes.longhorn.io -n longhorn-system \
  -o json | \
  jq -r '.items[] | select(.spec.numberOfReplicas != (.status.currentNodeID | length)) | .metadata.name' 2>/dev/null | head -5)
# Note: the jq above is illustrative — actual field paths may differ

# 3. Verify no backups are in progress
RUNNING_BACKUPS=$(kubectl get backups.longhorn.io -n longhorn-system \
  -o json | \
  jq -r '.items[] | select(.status.state == "InProgress") | .metadata.name')

if [ -n "$RUNNING_BACKUPS" ]; then
    echo "WARNING: Backups in progress — wait for completion before upgrading"
    echo "$RUNNING_BACKUPS"
fi

# 4. Take a snapshot of all volumes before upgrade
echo "Creating pre-upgrade snapshots..."
for volume in $(kubectl get volumes.longhorn.io -n longhorn-system -o name | sed 's|volumes.longhorn.io/||'); do
    kubectl apply -f - << EOF
apiVersion: longhorn.io/v1beta2
kind: Snapshot
metadata:
  name: pre-upgrade-${volume}
  namespace: longhorn-system
spec:
  volume: ${volume}
  createSnapshot: true
EOF
done

echo "Pre-upgrade snapshots created"
echo "Proceed with upgrade"
```

### Upgrade Process

```bash
# Upgrade Longhorn using Helm
# Longhorn supports rolling upgrades — no downtime required

# Step 1: Update Helm repo
helm repo update

# Step 2: Check what version you're upgrading to
helm search repo longhorn/longhorn --versions | head -5

# Step 3: Review upgrade notes
# https://longhorn.io/docs/latest/deploy/upgrade/

# Step 4: Upgrade (Longhorn performs in-place upgrade of CRDs)
helm upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version 1.8.0 \
  --values longhorn-values.yaml \
  --wait \
  --timeout=1800s

# Monitor upgrade progress
watch -n 5 'kubectl get pods -n longhorn-system | grep -v Running'

# Step 5: Verify upgrade completed
kubectl get pods -n longhorn-system
kubectl get volumes.longhorn.io -n longhorn-system | grep -v "healthy"

# Check Longhorn version
kubectl get setting longhorn-system-managed-components-nodeport-enabled \
  -n longhorn-system -o json | jq '.status.value'
```

## Performance Tuning for Database Workloads

### Volume Configuration for Databases

```yaml
# high-performance-postgres-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: databases
  annotations:
    # Increase replica rebuild timeout for large volumes
    longhorn.io/replicaSoftAntiAffinity: "false"  # Strict anti-affinity for DB
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ssd
  resources:
    requests:
      storage: 200Gi
---
# StorageClass optimized for databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-db
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  diskSelector: "nvme"
  nodeSelector: ""
  # Data locality: strict ensures I/O goes through local replica only
  # This eliminates network hop for database writes
  dataLocality: "strict-local"
  # Revision counter disabled for high-IOPS workloads
  revisionCounterDisabled: "true"
  fsType: "xfs"
  # XFS mount options for database performance
  # mkfsParams: "-d agcount=64"
```

### Tuning Linux I/O Scheduler for Longhorn Volumes

```bash
# Set I/O scheduler for NVMe devices (none/mq-deadline work best)
for dev in /sys/block/nvme*; do
  echo "mq-deadline" > "$dev/queue/scheduler" 2>/dev/null || true
  echo "128" > "$dev/queue/nr_requests" 2>/dev/null || true
  echo "0" > "$dev/queue/rotational" 2>/dev/null || true
done

# Set I/O scheduler for Longhorn's iSCSI-backed block devices
# Longhorn presents volumes as /dev/longhorn/volume-name
for dev in /sys/block/sd*; do
  if readlink -f "$dev" | grep -q "longhorn"; then
    echo "none" > "$dev/queue/scheduler" 2>/dev/null || true
  fi
done

# Persist via udev rules
cat > /etc/udev/rules.d/71-longhorn-scheduler.rules << 'EOF'
# Use none scheduler for Longhorn iSCSI devices (block layer scheduling duplicates effort)
SUBSYSTEM=="block", ENV{DM_NAME}=="longhorn*", ATTR{queue/scheduler}="none"
# Use mq-deadline for NVMe devices
SUBSYSTEM=="block", KERNEL=="nvme*", ATTR{queue/scheduler}="mq-deadline"
EOF
udevadm control --reload-rules
```

### PostgreSQL Configuration for Longhorn Storage

```ini
# postgresql.conf optimizations for Longhorn-backed storage
# These settings account for the distributed I/O characteristics of Longhorn

# Checkpoint configuration
checkpoint_completion_target = 0.9
max_wal_size = 8GB         # Allow larger WAL to reduce checkpoint frequency
min_wal_size = 1GB
wal_buffers = 64MB

# I/O settings
effective_io_concurrency = 4    # Longhorn replicates writes, so parallelism helps
random_page_cost = 1.5          # SSD-backed Longhorn is faster than HDD
effective_cache_size = 24GB     # Set to ~75% of system RAM

# Synchronous replication
# Longhorn handles data durability at the storage layer via synchronous
# replication across 3 replicas. PostgreSQL full_page_writes is still
# needed for crash recovery after fsync gaps.
fsync = on
synchronous_commit = on

# Connection pooling (use PgBouncer in front of PostgreSQL)
max_connections = 100           # Keep low — use connection pooler

# Parallel query
max_parallel_workers_per_gather = 2
max_parallel_workers = 8
```

## Production Monitoring

### Key Longhorn Metrics

```promql
# Volume health status (1 = healthy, 0 = degraded/faulted)
longhorn_volume_robustness == 1

# Storage utilization per volume
longhorn_volume_actual_size_bytes / longhorn_volume_capacity_bytes

# Node storage utilization (alert at 80%)
(
  longhorn_node_storage_usage_bytes /
  longhorn_node_storage_capacity_bytes
) > 0.80

# Replica rebuild in progress (may indicate a node failure)
longhorn_volume_replica_count{state="rebuilding"} > 0

# Backup failure rate
rate(longhorn_backup_state{state="error"}[1h]) > 0
```

### Alerting Rules

```yaml
groups:
  - name: longhorn-alerts
    rules:
      - alert: LonghornVolumeActualSpaceUsedWarning
        expr: |
          (
            longhorn_volume_actual_size_bytes /
            longhorn_volume_capacity_bytes * 100
          ) > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Longhorn volume {{ $labels.volume }} is {{ $value | humanize }}% full"

      - alert: LonghornVolumeStatusCritical
        expr: longhorn_volume_robustness != 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Longhorn volume {{ $labels.volume }} is not healthy (robustness={{ $labels.robustness }})"
          description: "Volume may be degraded or faulted. Check replica health and node status."

      - alert: LonghornNodeStorageWarning
        expr: |
          (
            longhorn_node_storage_usage_bytes /
            longhorn_node_storage_capacity_bytes * 100
          ) > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Longhorn node {{ $labels.node }} storage {{ $value | humanize }}% utilized"

      - alert: LonghornBackupFailed
        expr: longhorn_backup_state{state="error"} == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Longhorn backup {{ $labels.backup }} failed"
          description: "Check Longhorn UI for backup error details and verify S3 connectivity."
```

### Operational Dashboard Queries

```bash
# Quick health overview script
kubectl get volumes.longhorn.io -n longhorn-system \
  -o custom-columns=\
'NAME:.metadata.name,SIZE:.spec.size,STATE:.status.state,ROBUSTNESS:.status.robustness,REPLICAS:.spec.numberOfReplicas' | \
  column -t

# List volumes with unhealthy replicas
kubectl get volumes.longhorn.io -n longhorn-system -o json | \
  jq -r '.items[] | select(.status.robustness != "healthy") |
    "\(.metadata.name): \(.status.robustness) (\(.status.conditions[0].message // "unknown"))"'

# Backup status summary
kubectl get backups.longhorn.io -n longhorn-system \
  -o custom-columns=\
'NAME:.metadata.name,STATE:.status.state,SIZE:.status.size,CREATED:.metadata.creationTimestamp' | \
  sort -k4 -r | head -20
```

## Summary

Longhorn provides a pragmatic path to distributed block storage for Kubernetes clusters that don't have dedicated storage infrastructure:

1. **Volume replication** at 3 replicas with disk and node tag selectors ensures data redundancy without requiring dedicated storage nodes

2. **Data locality** in `strict-local` mode eliminates network hops for database I/O by routing all reads and writes through the local replica — critical for latency-sensitive workloads

3. **Recurring backup jobs** combined with S3-backed backup targets provide RPO of 1 hour (hourly snapshots) and RTO of 30-60 minutes (time to restore from S3 backup)

4. **Pre-upgrade snapshot automation** ensures a clean rollback point before every Longhorn version upgrade

5. **Longhorn upgrade** is performed in-place via Helm without requiring volume recreation or pod disruption — only the Longhorn components restart during the upgrade

6. **Performance tuning** for database workloads requires both Longhorn-level configuration (`strict-local` data locality, NVMe disk tags, `revisionCounterDisabled`) and OS-level I/O scheduler optimization

The primary operational considerations are monitoring storage utilization across nodes (Longhorn cannot rebalance automatically), managing replica rebuild time during node failures (large volumes on HDDs can take hours to rebuild), and ensuring backup targets are accessible and tested regularly through restore drills.
