---
title: "Kubernetes Cluster Backup with Velero: Scheduled Backups and Cross-Region DR"
date: 2029-03-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Disaster Recovery", "Backup", "AWS", "Restic"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Velero for Kubernetes cluster backup and cross-region disaster recovery, covering S3 backend configuration, scheduled backup policies, PersistentVolume snapshots, restore testing, and RTO/RPO measurement."
more_link: "yes"
url: "/kubernetes-cluster-backup-velero-scheduled-backups-cross-region-dr/"
---

Kubernetes clusters store critical state in etcd, PersistentVolumes, and the configuration of dozens of namespaced resources. A storage failure, operator error, or ransomware attack can render that state unrecoverable without a structured backup strategy. Velero provides Kubernetes-native backup and restore, with support for multiple cloud storage backends, volume snapshots, and cross-cluster migration.

This guide builds a complete production backup architecture: daily cluster-wide backups, hourly backups of critical namespaces, cross-region replication, automated restore testing, and alerting when backup jobs fail.

<!--more-->

## Architecture Overview

```
Primary Cluster (us-east-1)
  ├── Velero (velero namespace)
  │     ├── BackupStorageLocation → s3://acme-k8s-backups-primary/velero (us-east-1)
  │     └── VolumeSnapshotLocation → AWS EBS snapshots (us-east-1)
  └── Scheduled Backups
        ├── hourly-critical   → production namespace, 24h retention
        ├── daily-cluster     → all namespaces, 30d retention
        └── weekly-full       → all namespaces + all volumes, 90d retention

DR Cluster (us-west-2)
  └── Velero
        └── BackupStorageLocation → s3://acme-k8s-backups-dr/velero (us-west-2)
            (populated by S3 Cross-Region Replication from primary bucket)
```

S3 Cross-Region Replication (CRR) copies all objects from the primary bucket to the DR bucket automatically. The DR cluster's Velero instance reads from the DR bucket for restore operations.

---

## Installation

### IAM Policy for Velero

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeVolumes",
        "ec2:DescribeSnapshots",
        "ec2:CreateSnapshot",
        "ec2:DeleteSnapshot",
        "ec2:DescribeTags",
        "ec2:CreateTags"
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
      "Resource": "arn:aws:s3:::acme-k8s-backups-primary/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-k8s-backups-primary"
    }
  ]
}
```

Attach this policy to the IAM role used by the Velero service account via IRSA (IAM Roles for Service Accounts):

```bash
# Create IRSA role
eksctl create iamserviceaccount \
  --cluster=acme-production \
  --namespace=velero \
  --name=velero \
  --role-name=velero-production \
  --attach-policy-arn=arn:aws:iam::123456789012:policy/VeleroBackup \
  --approve \
  --region=us-east-1
```

### Velero Helm Installation

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm repo update

helm upgrade --install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --version 6.3.0 \
  --values velero-values.yaml
```

```yaml
# velero-values.yaml
image:
  repository: velero/velero
  tag: v1.14.0

configuration:
  backupStorageLocation:
    - name: primary
      provider: aws
      bucket: acme-k8s-backups-primary
      prefix: velero
      config:
        region: us-east-1
        s3ForcePathStyle: "false"
      default: true
  volumeSnapshotLocation:
    - name: primary
      provider: aws
      config:
        region: us-east-1

serviceAccount:
  server:
    annotations:
      eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/velero-production"

initContainers:
  - name: velero-plugin-for-aws
    image: velero/velero-plugin-for-aws:v1.10.0
    volumeMounts:
      - mountPath: /target
        name: plugins

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 1000m
    memory: 512Mi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    additionalLabels:
      prometheus: kube-prometheus

podAnnotations:
  cluster-autoscaler.kubernetes.io/safe-to-evict: "false"

tolerations:
  - key: "node-role.kubernetes.io/control-plane"
    effect: NoSchedule

nodeSelector:
  node-role.kubernetes.io/control-plane: ""
```

Running Velero on control-plane nodes ensures it remains available during application node failures.

---

## Backup Configuration

### BackupStorageLocation

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: acme-k8s-backups-primary
    prefix: velero
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
  accessMode: ReadWrite
  default: true
  validationFrequency: 1m
```

```yaml
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: primary
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
```

### Scheduled Backups

```yaml
# Hourly backup of the production namespace — RPO: 1 hour
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-production
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    includedNamespaces:
      - production
    excludedResources:
      - events
      - events.events.k8s.io
    snapshotVolumes: true
    volumeSnapshotLocations:
      - primary
    storageLocation: primary
    ttl: 24h0m0s
    labelSelector:
      matchExpressions:
        - key: "velero.io/exclude-from-backup"
          operator: DoesNotExist
  useOwnerReferencesInBackup: false
---
# Daily cluster-wide backup — RPO: 24 hours
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-cluster
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
    excludedResources:
      - events
      - events.events.k8s.io
      - nodes
      - pvcs
    snapshotVolumes: false
    storageLocation: primary
    ttl: 720h0m0s   # 30 days
---
# Weekly full backup including all volumes — 90-day retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-full
  namespace: velero
spec:
  schedule: "0 3 * * 0"
  template:
    excludedResources:
      - events
      - events.events.k8s.io
    snapshotVolumes: true
    volumeSnapshotLocations:
      - primary
    storageLocation: primary
    ttl: 2160h0m0s  # 90 days
```

### File System Backup for Stateful Applications

For PersistentVolumes that do not support CSI snapshots (e.g., NFS, local volumes), Velero can use the Kopia data mover:

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: stateful-apps-kopia
  namespace: velero
spec:
  schedule: "30 1 * * *"
  template:
    includedNamespaces:
      - databases
    snapshotMoveData: true
    defaultVolumesToFsBackup: true
    uploaderType: kopia
    storageLocation: primary
    ttl: 168h0m0s  # 7 days
```

---

## Cross-Region Replication

### S3 CRR Configuration

```bash
# Create the DR bucket in us-west-2
aws s3 mb s3://acme-k8s-backups-dr --region us-west-2

# Enable versioning on both buckets (required for CRR)
aws s3api put-bucket-versioning \
  --bucket acme-k8s-backups-primary \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-versioning \
  --bucket acme-k8s-backups-dr \
  --versioning-configuration Status=Enabled

# Apply CRR configuration
aws s3api put-bucket-replication \
  --bucket acme-k8s-backups-primary \
  --replication-configuration file://s3-crr-config.json
```

```json
{
  "Role": "arn:aws:iam::123456789012:role/s3-crr-role",
  "Rules": [
    {
      "ID": "velero-backups-crr",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "velero/"
      },
      "Destination": {
        "Bucket": "arn:aws:s3:::acme-k8s-backups-dr",
        "StorageClass": "STANDARD_IA",
        "ReplicationTime": {
          "Status": "Enabled",
          "Time": { "Minutes": 15 }
        },
        "Metrics": {
          "Status": "Enabled",
          "EventThreshold": { "Minutes": 15 }
        }
      },
      "DeleteMarkerReplication": {
        "Status": "Disabled"
      }
    }
  ]
}
```

### DR Cluster Velero Configuration

On the DR cluster, configure a **read-only** BackupStorageLocation pointing at the replicated bucket:

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: dr-source
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: acme-k8s-backups-dr
    prefix: velero
  config:
    region: us-west-2
  accessMode: ReadOnly
  default: true
```

Syncing backup metadata to the DR cluster:

```bash
# Force Velero to sync backup objects from S3 (useful after failover)
velero backup-location get
velero backup get

# If backups don't appear within 60s, force a sync:
kubectl patch backupstoragelocation dr-source \
  -n velero \
  --type merge \
  -p '{"spec":{"validationFrequency":"30s"}}'
```

---

## Restore Procedures

### Namespace-Level Restore

```bash
# List available backups
velero backup get

# Restore a specific backup
velero restore create \
  --from-backup daily-cluster-20290322020000 \
  --include-namespaces production \
  --restore-volumes true \
  --wait

# Monitor restore progress
velero restore describe production-restore-1 --details

# Verify restore completion
velero restore logs production-restore-1 | grep -E "(error|warning|restored)" | tail -50
```

### Selective Resource Restore

```bash
# Restore only ConfigMaps and Secrets from a backup
velero restore create config-restore \
  --from-backup daily-cluster-20290322020000 \
  --include-namespaces production \
  --include-resources configmaps,secrets \
  --restore-volumes false
```

### Cross-Namespace Restore (Blue-Green Recovery)

```bash
# Restore production namespace into a staging namespace for validation
velero restore create validation-restore \
  --from-backup daily-cluster-20290322020000 \
  --include-namespaces production \
  --namespace-mappings production:production-restored \
  --restore-volumes false
```

---

## Automated Restore Testing

Restore testing should run on a schedule in the DR cluster. The following Job performs a restore and validates key resources:

```bash
#!/usr/bin/env bash
# restore-test.sh — Run in the DR cluster after a DR drill.
set -euo pipefail

BACKUP_NAME=$(velero backup get --output json \
  | jq -r '[.items[] | select(.status.phase=="Completed")] | sort_by(.metadata.creationTimestamp) | last | .metadata.name')

echo "Testing restore from: $BACKUP_NAME"

RESTORE_NAME="test-restore-$(date +%Y%m%d%H%M%S)"

velero restore create "$RESTORE_NAME" \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces production \
  --namespace-mappings production:restore-validation \
  --restore-volumes false \
  --wait

PHASE=$(velero restore get "$RESTORE_NAME" -o json | jq -r '.status.phase')
if [[ "$PHASE" != "Completed" ]]; then
  echo "FAIL: restore phase=$PHASE"
  velero restore logs "$RESTORE_NAME" | tail -30
  exit 1
fi

# Validate key resources exist in the restored namespace
EXPECTED_DEPLOYMENTS="api-server worker-service"
for dep in $EXPECTED_DEPLOYMENTS; do
  if ! kubectl get deployment "$dep" -n restore-validation > /dev/null 2>&1; then
    echo "FAIL: deployment $dep not found in restore-validation"
    exit 1
  fi
done

echo "PASS: restore validation completed successfully"

# Clean up test namespace
kubectl delete namespace restore-validation --timeout=120s

# Record RTO
echo "RTO measurement: $(velero restore describe "$RESTORE_NAME" --details \
  | grep -E 'Started|Completed' | awk '{print $NF}' | tr '\n' ' ')"
```

---

## Monitoring and Alerting

```yaml
# Velero Prometheus alert rules
groups:
  - name: velero-backup
    rules:
      - alert: VeleroBackupJobFailed
        expr: |
          velero_backup_failure_total > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Velero backup {{ $labels.schedule }} failed"
          description: "Check velero logs: kubectl logs -n velero -l app.kubernetes.io/name=velero"

      - alert: VeleroBackupNotRecent
        expr: |
          (time() - velero_backup_last_successful_timestamp{schedule="daily-cluster"}) > 86400
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "No successful daily-cluster backup in 24 hours"

      - alert: VeleroStorageLocationUnavailable
        expr: |
          velero_backup_storage_location_info{phase!="Available"} == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Velero BackupStorageLocation {{ $labels.backup_storage_location }} is unavailable"
```

---

## RTO and RPO Measurement

Document measured RTO and RPO values as part of the DR runbook:

| Backup Type | Schedule | Retention | RPO | Measured RTO (namespace restore) |
|-------------|----------|-----------|-----|----------------------------------|
| hourly-production | `0 * * * *` | 24h | 1 hour | 8 min |
| daily-cluster | `0 2 * * *` | 30d | 24 hours | 22 min |
| weekly-full | `0 3 * * 0` | 90d | 7 days | 45 min (with volumes) |

RTO is dominated by PersistentVolume restore time. Excluding volume restores and using snapshot-based recovery reduces RTO to under 10 minutes for most namespaces.

---

## Summary

A production Velero deployment requires attention to four concerns beyond basic installation:

1. **Granularity**: Different namespaces have different RPO requirements. Separate schedules with appropriate retention prevent backup storage costs from growing unbounded.

2. **Cross-region replication**: S3 CRR with 15-minute replication SLA provides the backup copy needed for regional DR without requiring Velero to write to two buckets simultaneously.

3. **Restore testing**: A backup that has never been restored is an assumption, not a guarantee. Automated restore validation on a weekly schedule proves the backup is usable and measures actual RTO.

4. **Alerting**: Backup failures are silent by default. Prometheus metrics from Velero combined with alert rules for failed backups and stale storage locations ensure failures are visible before a DR event occurs.
