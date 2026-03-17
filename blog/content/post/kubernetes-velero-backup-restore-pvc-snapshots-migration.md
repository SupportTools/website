---
title: "Kubernetes Backup and Restore with Velero: PVC Snapshots and Cross-Cluster Migration"
date: 2030-09-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "Disaster Recovery", "PVC", "CSI", "Migration", "Storage"]
categories:
- Kubernetes
- DevOps
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Velero guide covering backup storage locations, CSI snapshot integration, schedule management, backup hooks for database consistency, restore procedures, cross-cluster migration patterns, and disaster recovery testing."
more_link: "yes"
url: "/kubernetes-velero-backup-restore-pvc-snapshots-migration/"
---

Disaster recovery for Kubernetes workloads requires more than cluster-level etcd backups. A complete DR strategy must capture both the Kubernetes API objects (Deployments, Services, ConfigMaps, Secrets, PVCs) and the persistent volume data those objects reference. Velero provides a unified backup solution that serializes API objects to object storage and integrates with CSI snapshot APIs to capture point-in-time PVC snapshots atomically. For stateful workloads like databases, backup hooks coordinate application-level quiesce operations before snapshot initiation. This guide covers the full production Velero deployment: storage location configuration, schedule management, database-consistent backups using hooks, the complete restore workflow, cross-cluster migration procedures, and the DR testing methodology needed to validate that restores actually work before they are needed in a real incident.

<!--more-->

## Velero Architecture

Velero consists of:

- **Velero server**: A Deployment that processes backup and restore operations.
- **BackupStorageLocation (BSL)**: Points to an object storage bucket (S3, GCS, Azure Blob) where Kubernetes API objects are serialized.
- **VolumeSnapshotLocation (VSL)**: Points to a volume snapshot provider (CSI, AWS EBS, GCE PD, etc.).
- **BackupRepository**: Manages Restic or Kopia file-level backup repositories for volumes that do not support CSI snapshots.
- **BackupStorageLocation controller**: Periodically syncs backup metadata from the BSL.

### Data Flow

```
Backup trigger (schedule or manual)
    │
    ▼
Velero server discovers API objects via kubectl API
    │
    ├─ Serializes objects to JSON → uploads to object storage BSL
    │
    ├─ For each PVC with CSI snapshot support:
    │    └─ Creates VolumeSnapshot → CSI driver takes snapshot
    │
    └─ For each PVC without CSI snapshot (file-backup mode):
         └─ Restic/Kopia backs up volume contents to BSL
```

## Installation

### Preparing Object Storage

```bash
# AWS S3 example
aws s3 mb s3://my-cluster-velero-backups --region us-east-1

# Create IAM policy
cat > velero-policy.json << 'EOF'
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ec2:DescribeVolumes",
                "ec2:DescribeSnapshots",
                "ec2:CreateTags",
                "ec2:CreateVolume",
                "ec2:CreateSnapshot",
                "ec2:DeleteSnapshot"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:DeleteObject",
                "s3:PutObject",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts"
            ],
            "Resource": "arn:aws:s3:::my-cluster-velero-backups/*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket",
                "s3:GetBucketLocation",
                "s3:ListBucketMultipartUploads"
            ],
            "Resource": "arn:aws:s3:::my-cluster-velero-backups"
        }
    ]
}
EOF

aws iam put-role-policy \
  --role-name velero-backup-role \
  --policy-name VeleroBackupPolicy \
  --policy-document file://velero-policy.json
```

### Velero Helm Installation

```yaml
# velero-values.yaml
configuration:
  backupStorageLocation:
  - name: aws-primary
    provider: aws
    bucket: my-cluster-velero-backups
    prefix: cluster-prod
    default: true
    config:
      region: us-east-1
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/example-key-id"
      serverSideEncryption: "aws:kms"

  volumeSnapshotLocation:
  - name: aws-ebs
    provider: aws
    config:
      region: us-east-1

  defaultBackupStorageLocation: aws-primary
  defaultVolumeSnapshotLocations: "aws:aws-ebs"
  defaultRepoMaintainFrequency: 168h   # Weekly repository maintenance
  garbageCollectionFrequency: 24h

credentials:
  useSecret: true
  existingSecret: velero-aws-credentials

serviceAccount:
  server:
    annotations:
      eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/velero-backup-role"

initContainers:
- name: velero-plugin-for-aws
  image: velero/velero-plugin-for-aws:v1.10.0
  imagePullPolicy: IfNotPresent
  volumeMounts:
  - mountPath: /target
    name: plugins

features: "EnableCSI"

kubectl:
  image:
    tag: 1.30.0

snapshotsEnabled: true

deployNodeAgent: true    # Required for file-level (Restic/Kopia) backups
nodeAgent:
  podVolumePath: /var/lib/kubelet/pods
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      memory: 1Gi

resources:
  requests:
    cpu: 500m
    memory: 128Mi
  limits:
    memory: 512Mi
```

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm upgrade --install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --version 7.2.1 \
  --values velero-values.yaml
```

## Backup Storage Locations

### Multiple Storage Locations for Geographic Redundancy

```yaml
# Primary BSL — same region as cluster
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-us-east-1-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-backups-primary
    prefix: cluster-prod
  config:
    region: us-east-1
    serverSideEncryption: "aws:kms"
    kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/example-key-id"
  default: true
  accessMode: ReadWrite
  credential:
    name: velero-aws-credentials
    key: cloud

---
# Secondary BSL — disaster recovery region
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-us-west-2-dr
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-backups-dr
    prefix: cluster-prod
  config:
    region: us-west-2
    serverSideEncryption: "aws:kms"
    kmsKeyId: "arn:aws:kms:us-west-2:123456789012:key/example-dr-key-id"
  default: false
  accessMode: ReadWrite
```

### Checking BSL Status

```bash
velero backup-location get

# NAME                        PROVIDER   BUCKET/PREFIX                              PHASE       LAST VALIDATED
# aws-us-east-1-primary       aws        my-cluster-velero-backups-primary/...      Available   8s ago
# aws-us-west-2-dr            aws        my-cluster-velero-backups-dr/...           Available   12s ago
```

## CSI Volume Snapshot Integration

CSI snapshots require:
1. The `external-snapshotter` controller installed in the cluster.
2. A `VolumeSnapshotClass` configured for the CSI driver.
3. The `--features=EnableCSI` flag in Velero.

```yaml
# VolumeSnapshotClass for EBS CSI driver
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"   # Velero uses this label to find the VSC
driver: ebs.csi.aws.com
deletionPolicy: Retain    # Keep snapshots until Velero's backup TTL expires
parameters:
  type: snap
```

```yaml
# VolumeSnapshotClass for Longhorn
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

### Annotating PVCs for Backup Method

```yaml
# Force file-level backup (Kopia/Restic) for a PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  annotations:
    backup.velero.io/backup-volumes: "app-data"      # Include in file backup
    # backup.velero.io/backup-volumes-excludes: "app-data"  # Exclude from file backup
```

For CSI snapshot mode (preferred), no annotation is needed — Velero automatically uses CSI snapshots when the StorageClass has a matching `VolumeSnapshotClass`.

## Backup Schedules

```yaml
# Daily backup schedule — all namespaces, 30-day retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"    # 02:00 UTC daily
  template:
    ttl: 720h               # 30 days
    includedNamespaces:
    - "*"
    excludedNamespaces:
    - velero
    - kube-system
    - kube-public
    - kube-node-lease
    excludedResources:
    - events
    - events.events.k8s.io
    storageLocation: aws-us-east-1-primary
    snapshotVolumes: true
    snapshotMoveData: false   # Set true to copy snapshots to object storage (cross-region)
    csiSnapshotTimeout: 10m
    itemOperationTimeout: 4h
    volumeSnapshotLocations:
    - aws-ebs
    labelSelector:
      matchExpressions:
      - key: backup-exclude
        operator: DoesNotExist

---
# Hourly backup — production stateful workloads only
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-stateful-backup
  namespace: velero
spec:
  schedule: "15 * * * *"   # 15 minutes past each hour
  template:
    ttl: 48h                # 2 days
    includedNamespaces:
    - production
    - data
    labelSelector:
      matchLabels:
        backup-tier: stateful
    snapshotVolumes: true
    csiSnapshotTimeout: 10m
```

## Backup Hooks for Database Consistency

Backup hooks execute commands inside containers before and after snapshot creation, enabling application-level quiesce operations.

### PostgreSQL Consistent Backup

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: data
  annotations:
    pre.hook.backup.velero.io/container: postgres
    pre.hook.backup.velero.io/command: >
      ["/bin/bash", "-c",
       "psql -U $POSTGRES_USER -c 'CHECKPOINT;' && psql -U $POSTGRES_USER -c 'SELECT pg_start_backup(''velero'', true);'"]
    pre.hook.backup.velero.io/timeout: "60s"
    pre.hook.backup.velero.io/on-error: Fail

    post.hook.backup.velero.io/container: postgres
    post.hook.backup.velero.io/command: >
      ["/bin/bash", "-c",
       "psql -U $POSTGRES_USER -c 'SELECT pg_stop_backup();'"]
    post.hook.backup.velero.io/timeout: "60s"
    post.hook.backup.velero.io/on-error: Continue
```

### MySQL Consistent Backup

```yaml
metadata:
  annotations:
    pre.hook.backup.velero.io/container: mysql
    pre.hook.backup.velero.io/command: >
      ["/bin/bash", "-c",
       "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'FLUSH TABLES WITH READ LOCK;'"]
    pre.hook.backup.velero.io/timeout: "60s"

    post.hook.backup.velero.io/container: mysql
    post.hook.backup.velero.io/command: >
      ["/bin/bash", "-c",
       "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'UNLOCK TABLES;'"]
    post.hook.backup.velero.io/timeout: "30s"
```

### Redis Consistent Backup

```yaml
metadata:
  annotations:
    pre.hook.backup.velero.io/container: redis
    pre.hook.backup.velero.io/command: >
      ["/bin/bash", "-c", "redis-cli -a $REDIS_PASSWORD BGSAVE && sleep 5"]
    pre.hook.backup.velero.io/timeout: "120s"
```

### Hook-Aware Backup Creation

```bash
# Create a manual backup for the data namespace with hooks
velero backup create postgres-consistent-backup \
  --include-namespaces data \
  --snapshot-volumes \
  --wait
```

## Manual Backup Operations

```bash
# Create an on-demand backup
velero backup create pre-upgrade-backup \
  --include-namespaces production \
  --ttl 168h \
  --snapshot-volumes \
  --wait

# Check backup status
velero backup describe pre-upgrade-backup --details

# List all backups
velero backup get

# Download backup logs
velero backup logs pre-upgrade-backup

# Delete a backup
velero backup delete old-backup --confirm
```

## Restore Procedures

### Namespace Restore

```bash
# Restore a namespace from the most recent backup
velero restore create \
  --from-backup daily-full-backup-20300908020000 \
  --include-namespaces production \
  --restore-volumes true \
  --wait

# Check restore status
velero restore describe production-restore-20300908 --details

# Restore specific resource types only
velero restore create \
  --from-backup daily-full-backup-20300908020000 \
  --include-namespaces production \
  --include-resources deployments,services,configmaps \
  --restore-volumes false
```

### Selective Resource Restore

```bash
# Restore only a specific Deployment
velero restore create \
  --from-backup daily-full-backup-20300908020000 \
  --include-namespaces production \
  --selector "app=checkout-api" \
  --restore-volumes true

# Restore to a different namespace
velero restore create \
  --from-backup daily-full-backup-20300908020000 \
  --include-namespaces production \
  --namespace-mappings "production:production-restored" \
  --restore-volumes true
```

### Restore Status Monitoring

```bash
# Watch restore progress
watch velero restore get

# Check for restore warnings/errors
velero restore describe production-restore --details | grep -A5 "Errors\|Warnings"

# Verify restored workloads
kubectl get pods -n production
kubectl get pvc -n production
```

## Cross-Cluster Migration

### Migration Workflow

```
Source Cluster                    Target Cluster
     │                                  │
     │  1. Create backup                │
     │     (backup to BSL)              │
     │                                  │
     │  2. Wait for CSI snapshot        │
     │     copy to object storage       │
     │     (snapshotMoveData: true)     │
     │                                  │
     │─────────Object Storage──────────►│
     │                                  │
     │                            3. Configure same BSL
     │                            4. velero restore
     │                            5. Verify workloads
```

### Step 1: Source Cluster Backup with Data Movement

```bash
# On the source cluster — backup with snapshot data movement to object storage
velero backup create migration-source \
  --include-namespaces production \
  --snapshot-volumes \
  --snapshot-move-data \
  --data-mover velero \
  --ttl 720h \
  --wait

velero backup describe migration-source --details
```

`--snapshot-move-data` uploads CSI snapshot data to the BSL, making it accessible from any cluster that can access the same bucket — not just the source cluster where the EBS/GCE snapshots exist.

### Step 2: Target Cluster Configuration

```yaml
# Configure BSL on target cluster pointing to same bucket
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-us-east-1-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-backups-primary
    prefix: cluster-prod
  config:
    region: us-east-1
  default: true
  accessMode: ReadOnly    # Source cluster keeps ReadWrite; target is ReadOnly
```

### Step 3: Restore on Target Cluster

```bash
# Sync backup inventory from BSL
velero backup-location sync aws-us-east-1-primary

# List available backups (includes source cluster backups)
velero backup get

# Restore to target cluster
velero restore create migration-target \
  --from-backup migration-source \
  --restore-volumes true \
  --wait

# Verify
kubectl get pods -n production
kubectl get pvc -n production
kubectl describe pvc -n production | grep "Volume:"
```

### Namespace Remapping for Migration

```bash
# Migrate production namespace to new-production on target cluster
velero restore create cross-cluster-migrate \
  --from-backup migration-source \
  --namespace-mappings "production:new-production" \
  --restore-volumes true
```

## Disaster Recovery Testing

### DR Test Procedure

DR tests must be scheduled and executed against real backups, not theoretical ones. A quarterly DR test validates:

1. Backups are complete and consistent.
2. Restore procedures produce functional workloads.
3. RTO (Recovery Time Objective) is achievable within SLA.
4. RPO (Recovery Point Objective) is met by the backup schedule.

```bash
#!/bin/bash
# dr-test.sh — quarterly disaster recovery validation
set -euo pipefail

BACKUP_NAME="${1:-$(velero backup get -o json | jq -r '.items | sort_by(.metadata.creationTimestamp) | last | .metadata.name')}"
TEST_NAMESPACE="dr-test-$(date +%Y%m%d)"

echo "=== DR Test: restoring from backup: ${BACKUP_NAME} ==="
echo "Test namespace: ${TEST_NAMESPACE}"
echo "Start time: $(date -Iseconds)"

# Restore to test namespace
velero restore create "dr-test-$(date +%Y%m%d)" \
  --from-backup "${BACKUP_NAME}" \
  --include-namespaces production \
  --namespace-mappings "production:${TEST_NAMESPACE}" \
  --restore-volumes true \
  --wait

echo "Restore complete: $(date -Iseconds)"

# Wait for Pods to become Ready
echo "Waiting for Pods to be Ready..."
kubectl wait pods \
  --namespace "${TEST_NAMESPACE}" \
  --all \
  --for condition=Ready \
  --timeout 300s

echo "All Pods Ready: $(date -Iseconds)"

# Run smoke tests
echo "Running smoke tests..."
kubectl run smoke-test \
  --image=curlimages/curl:8.9.1 \
  --namespace "${TEST_NAMESPACE}" \
  --restart=Never \
  --rm \
  --command -- \
  curl -sf "http://checkout-api.${TEST_NAMESPACE}.svc.cluster.local:8080/health"

echo "Smoke tests passed: $(date -Iseconds)"

# Cleanup test namespace
kubectl delete namespace "${TEST_NAMESPACE}"
echo "DR test PASSED. Cleanup complete: $(date -Iseconds)"
```

### Scheduled DR Testing

```yaml
# CronJob for quarterly DR tests
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dr-validation
  namespace: velero
spec:
  schedule: "0 3 1 */3 *"    # First day of every third month, 03:00
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero-dr-tester
          containers:
          - name: dr-test
            image: bitnami/kubectl:1.30
            command: ["/bin/bash", "/scripts/dr-test.sh"]
            volumeMounts:
            - name: scripts
              mountPath: /scripts
          volumes:
          - name: scripts
            configMap:
              name: dr-test-scripts
          restartPolicy: OnFailure
```

## Monitoring Velero with Prometheus

```yaml
# Prometheus ServiceMonitor for Velero metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: velero
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: velero
  endpoints:
  - port: monitoring
    interval: 30s
```

Key Velero metrics:

```
# Alert: backup not completing
velero_backup_success_total
velero_backup_failure_total
velero_backup_last_successful_timestamp

# Alert: restore failures
velero_restore_success_total
velero_restore_failed_total
```

```yaml
# PrometheusRule for Velero backup monitoring
groups:
- name: velero
  rules:
  - alert: VeleroBackupFailure
    expr: increase(velero_backup_failure_total[1h]) > 0
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Velero backup failed in the last hour"

  - alert: VeleroBackupNotRunning
    expr: |
      (time() - velero_backup_last_successful_timestamp{schedule="daily-full-backup"}) > 90000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "No successful backup in the last 25 hours for schedule {{ $labels.schedule }}"
```

## Velero Best Practices

### Resource Labeling for Backup Inclusion/Exclusion

```yaml
# Exclude ephemeral workloads from backup
metadata:
  labels:
    backup-exclude: "true"     # Matches excludeSelector in Schedule spec

# Mark stateful workloads for hourly backup
metadata:
  labels:
    backup-tier: stateful      # Matches labelSelector in hourly Schedule
```

### Backup Validation

```bash
# Verify backup completeness after creation
velero backup describe daily-full-backup-20300908020000 | grep "Phase:"
# Phase:  Completed

# Check for partial failures
velero backup describe daily-full-backup-20300908020000 | grep -A5 "Errors:"

# List items included in backup
velero backup describe daily-full-backup-20300908020000 --details | grep "Total items backed up"
```

## Summary

Production Velero operations require attention to four areas: storage location redundancy (primary + DR regions), CSI snapshot integration with correctly configured VolumeSnapshotClasses, backup hooks for application-consistent database captures, and validated restore procedures tested on a quarterly cadence. Cross-cluster migration via data movement (`--snapshot-move-data`) decouples snapshot data from the originating cloud region, enabling restoration in any cluster with access to the backup bucket. The DR test procedure — restoring to a shadow namespace and running smoke tests — provides the only reliable validation that backups will succeed when a real incident requires them. Without scheduled DR tests, backup existence provides false confidence without confirmed recovery capability.
