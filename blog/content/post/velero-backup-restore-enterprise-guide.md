---
title: "Velero Backup and Restore: Enterprise Kubernetes Disaster Recovery"
date: 2027-12-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "Disaster Recovery", "Storage", "Restic", "Kopia", "CSI"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise disaster recovery guide for Velero: volume snapshots vs Restic/Kopia, BackupStorageLocation, VolumeSnapshotLocation, backup schedules, cross-cluster migration, backup validation, and CSI snapshot support."
more_link: "yes"
url: "/velero-backup-restore-enterprise-guide/"
---

Velero provides Kubernetes-native backup and restore capabilities with support for both application state (Kubernetes object manifests) and persistent data (volume snapshots and file-based backups). The gap between a functional Velero installation and a validated disaster recovery capability is significant. This guide covers the full enterprise deployment: storage backend configuration, volume backup strategies, automated schedules with retention policies, cross-cluster migration, and the validation procedures required to trust backup data before an incident occurs.

<!--more-->

# Velero Backup and Restore: Enterprise Kubernetes Disaster Recovery

## Architecture Overview

Velero backs up two distinct categories of data:

1. **Kubernetes object state** - All resources in a namespace or cluster: Deployments, Services, ConfigMaps, Secrets, PVCs, etc. Serialized as YAML/JSON and uploaded to object storage.

2. **Persistent volume data** - The actual data on PersistentVolumes. Handled by either CSI volume snapshots (cloud-native, fast, provider-specific) or file-based backup via Restic or Kopia (slower, provider-agnostic, cross-cloud).

Understanding this distinction is critical for recovery planning. Kubernetes object backup alone is insufficient for stateful applications; volume data must also be backed up.

```
velero backup create my-backup --include-namespaces production
    │
    ├── API Server: GET all resources in production namespace
    │       └── Upload to S3: s3://backups/velero/backups/my-backup/
    │
    └── For each PVC with annotation backup.velero.io/backup-volumes:
            ├── CSI snapshot path: VolumeSnapshot → VolumeSnapshotContent → Provider API
            └── File backup path: Kopia/Restic agent reads volume, uploads to S3
```

## Installation

```bash
# Install Velero CLI
VERSION="v1.13.0"
curl -L "https://github.com/vmware-tanzu/velero/releases/download/${VERSION}/velero-${VERSION}-linux-amd64.tar.gz" \
  | tar xz --strip-components=1 -C /usr/local/bin velero-${VERSION}-linux-amd64/velero

# Verify
velero version --client-only
```

## BackupStorageLocation: S3

The `BackupStorageLocation` defines where Velero stores backup metadata and Kubernetes objects.

### AWS S3 Configuration

```bash
# Create credentials file
cat > /tmp/velero-credentials << EOF
[default]
aws_access_key_id=VELERO_ACCESS_KEY_PLACEHOLDER
aws_secret_access_key=VELERO_SECRET_KEY_PLACEHOLDER
EOF

# Create IAM credentials secret
kubectl create namespace velero
kubectl create secret generic cloud-credentials \
  --namespace velero \
  --from-file cloud=/tmp/velero-credentials
rm /tmp/velero-credentials

# Install Velero with S3 backend
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket velero-backups-production \
  --backup-location-config region=us-east-1,s3ForcePathStyle=false \
  --snapshot-location-config region=us-east-1 \
  --secret-file /dev/null \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --namespace velero
```

### BackupStorageLocation CRD

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-production
    prefix: cluster-prod-us-east-1
  config:
    region: us-east-1
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/mrk-example-key-id
    s3ForcePathStyle: "false"
    checksumAlgorithm: ""
  credential:
    name: cloud-credentials
    key: cloud
  default: true
  accessMode: ReadWrite
  backupSyncPeriod: 1m
  validationFrequency: 1h
```

### Multiple Storage Locations for Cross-Region Redundancy

```yaml
# Secondary storage location in different region
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-secondary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-production-dr
    prefix: cluster-prod-us-west-2
  config:
    region: us-west-2
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-west-2:123456789012:key/mrk-example-dr-key-id
  credential:
    name: cloud-credentials-west
    key: cloud
  default: false
  accessMode: ReadWrite
```

## VolumeSnapshotLocation: CSI Snapshots

CSI volume snapshots are the preferred mechanism for backing up PVC data on cloud providers. Snapshots are taken at the storage layer, making them near-instantaneous and consistent.

```yaml
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-ebs
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
    enableSpeedyInstanceSnapshots: "false"
  credential:
    name: cloud-credentials
    key: cloud
```

### CSI Snapshot Support (Preferred for Kubernetes 1.20+)

Velero integrates with the CSI snapshot API, using standard `VolumeSnapshot` resources instead of provider-specific snapshot mechanisms.

```bash
# Install CSI snapshot controller (if not already present)
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml

# Install snapshot CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
```

```yaml
# VolumeSnapshotClass for CSI snapshots
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-csi-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  type: snap
```

The label `velero.io/csi-volumesnapshot-class: "true"` tells Velero to use this class for CSI snapshots.

## Restic vs Kopia: File-Based Volume Backup

For environments without CSI snapshot support, or for cross-cloud migration, file-based backup is the alternative.

| Feature | Restic | Kopia |
|---|---|---|
| Status | Legacy (still supported) | Recommended (default from Velero 1.12+) |
| Performance | Single-threaded | Multi-threaded, faster |
| Deduplication | Per-backup | Cross-backup with content-addressable storage |
| Encryption | Yes | Yes |
| Compression | Yes | Yes |
| Repository format | Restic repo | Kopia repo |

### Enabling Kopia (Node Agent)

```bash
# Install with Kopia as the file backup engine
velero install \
  --use-node-agent \
  --uploader-type kopia \
  --default-volumes-to-fs-backup=false \
  ...
```

The Node Agent runs as a DaemonSet and mounts host pod volumes to perform file-level backup:

```bash
kubectl get daemonset -n velero
# NAME           DESIRED   CURRENT   READY
# node-agent     3         3         3
```

### Annotating PVCs for File Backup

When not using CSI snapshots, annotate specific PVCs to trigger Kopia backup:

```yaml
# Annotate a PVC for Kopia backup
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: production
  annotations:
    backup.velero.io/backup-volumes: app-data
```

Or annotate a pod (applies to all specified volumes):

```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    backup.velero.io/backup-volumes: app-data,config-data
    backup.velero.io/backup-volumes-excludes: cache-volume
```

## Backup Schedules

### Standard Schedule Configuration

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-production-backup
  namespace: velero
spec:
  # Run daily at 2 AM UTC
  schedule: "0 2 * * *"
  # Skip if previous backup is still running
  useOwnerReferencesInBackup: false
  paused: false
  template:
    includedNamespaces:
      - production
      - staging
    excludedNamespaces: []
    includedResources:
      - "*"
    excludedResources:
      - events
      - events.events.k8s.io
    includeClusterResources: true
    storageLocation: aws-primary
    volumeSnapshotLocations:
      - aws-ebs
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    ttl: 720h    # 30 day retention
    labelSelector:
      matchExpressions:
        - key: backup
          operator: NotIn
          values:
            - "skip"
    hooks:
      resources:
        - name: postgres-pre-backup
          includedNamespaces:
            - production
          labelSelector:
            matchLabels:
              app: postgres
          pre:
            - exec:
                container: postgres
                command:
                  - /bin/bash
                  - -c
                  - "psql -U postgres -c 'CHECKPOINT;'"
                onError: Fail
                timeout: 30s
```

### Multi-Tier Retention Schedule

```yaml
---
# Hourly backups - 24 hour retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-backup
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    includedNamespaces: [production]
    storageLocation: aws-primary
    ttl: 24h
    snapshotVolumes: false   # Only metadata, no volume snapshots for hourly
---
# Daily backups - 7 day retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-backup
  namespace: velero
spec:
  schedule: "0 1 * * *"
  template:
    includedNamespaces: [production]
    storageLocation: aws-primary
    ttl: 168h   # 7 days
    snapshotVolumes: true
---
# Weekly backups - 90 day retention to DR location
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-backup-dr
  namespace: velero
spec:
  schedule: "0 2 * * 0"   # Sunday 2 AM
  template:
    includedNamespaces: [production, staging]
    storageLocation: aws-secondary   # DR region
    ttl: 2160h   # 90 days
    snapshotVolumes: true
```

## Backup Hooks: Pre/Post Application Quiescing

Hooks enable application-consistent backups by pausing writes before snapshot:

```yaml
# Database-consistent backup with pre-freeze hook
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: db-consistent-backup
  namespace: velero
spec:
  includedNamespaces:
    - production
  hooks:
    resources:
      - name: mysql-quiesce
        includedNamespaces:
          - production
        labelSelector:
          matchLabels:
            app: mysql
            role: primary
        pre:
          - exec:
              container: mysql
              command:
                - /bin/bash
                - -c
                - "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'FLUSH TABLES WITH READ LOCK;'"
              onError: Fail
              timeout: 60s
        post:
          - exec:
              container: mysql
              command:
                - /bin/bash
                - -c
                - "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'UNLOCK TABLES;'"
              onError: Continue
              timeout: 30s
```

## Cross-Cluster Migration

Velero excels at migrating workloads between clusters. The source cluster uses one `BackupStorageLocation`, and the destination cluster points to the same storage.

### Migration Process

```bash
# Step 1: On source cluster - create backup
velero backup create migration-backup \
  --include-namespaces production \
  --snapshot-volumes=true \
  --storage-location aws-primary \
  --wait

# Verify backup completed
velero backup describe migration-backup --details
velero backup logs migration-backup | grep -i error

# Step 2: On destination cluster - install Velero with same storage location
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket velero-backups-production \
  --backup-location-config region=us-east-1 \
  --secret-file credentials-file

# Step 3: Sync backup from storage
velero backup-location get
velero backup sync

# Step 4: Restore
velero restore create migration-restore \
  --from-backup migration-backup \
  --include-namespaces production \
  --namespace-mappings "production:production-migrated" \
  --restore-volumes=true

# Monitor restore
velero restore describe migration-restore --details
```

### StorageClass Mapping

Different clusters use different StorageClasses. Map them during restore:

```yaml
# configmap for storage class remapping
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storage-class-config
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  # Source StorageClass: Target StorageClass
  gp2: gp3
  standard: premium-rwo
  nfs-client: csi-nfs
```

## Backup Validation

A backup is only valuable if restore works. Automate validation.

### Automated Restore Testing Script

```bash
#!/bin/bash
# velero-backup-validation.sh
# Restore backup to a test namespace and verify application health

set -euo pipefail

BACKUP_NAME="${1:-$(velero backup get -o jsonpath='{.items[0].metadata.name}')}"
TEST_NAMESPACE="velero-validate-$$"
SOURCE_NAMESPACE="production"
TIMEOUT=300

echo "=== Velero Backup Validation ==="
echo "Backup: $BACKUP_NAME"
echo "Test namespace: $TEST_NAMESPACE"

# Step 1: Restore to test namespace
velero restore create "validate-$BACKUP_NAME" \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces "$SOURCE_NAMESPACE" \
  --namespace-mappings "${SOURCE_NAMESPACE}:${TEST_NAMESPACE}" \
  --restore-volumes=false \
  --wait

RESTORE_STATUS=$(velero restore get "validate-$BACKUP_NAME" \
  -o jsonpath='{.status.phase}')

if [ "$RESTORE_STATUS" != "Completed" ]; then
  echo "FAIL: Restore status is $RESTORE_STATUS"
  velero restore describe "validate-$BACKUP_NAME"
  exit 1
fi

# Step 2: Wait for deployments to be ready
echo "Waiting for deployments to be ready in $TEST_NAMESPACE..."
DEADLINE=$((SECONDS + TIMEOUT))
while [ $SECONDS -lt $DEADLINE ]; do
  NOT_READY=$(kubectl get deployments -n "$TEST_NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.readyReplicas}{"\n"}{end}' \
    | awk '$2 == "" || $2 == "0"' | wc -l)

  if [ "$NOT_READY" -eq 0 ]; then
    echo "All deployments ready"
    break
  fi
  echo "Waiting for $NOT_READY deployment(s) to be ready..."
  sleep 10
done

# Step 3: Run health checks
echo "Running health checks..."
kubectl get pods -n "$TEST_NAMESPACE" --no-headers | \
  awk '$3 != "Running" && $3 != "Completed" {print "UNHEALTHY:", $1, $3}'

# Step 4: Cleanup
echo "Cleaning up test namespace..."
kubectl delete namespace "$TEST_NAMESPACE" --timeout=60s || true
velero restore delete "validate-$BACKUP_NAME" --confirm

echo "Validation complete for backup: $BACKUP_NAME"
```

### Backup Status Monitoring

```bash
# Check all backup statuses
velero backup get -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.phase,ERRORS:.status.errors,WARNINGS:.status.warnings,STARTED:.status.startTimestamp,COMPLETED:.status.completionTimestamp,EXPIRES:.status.expiration'

# Check last backup for each schedule
for SCHEDULE in $(velero schedule get -o jsonpath='{.items[*].metadata.name}'); do
  LAST_BACKUP=$(velero backup get -l velero.io/schedule-name="$SCHEDULE" \
    -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null || echo "none")
  STATUS=$(velero backup get "$LAST_BACKUP" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "unknown")
  echo "$SCHEDULE: last=$LAST_BACKUP status=$STATUS"
done
```

### Prometheus Metrics for Velero

```yaml
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
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: monitoring
spec:
  groups:
    - name: velero
      rules:
        - alert: VeleroBackupFailed
          expr: velero_backup_failure_total > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failed"
            description: "{{ $value }} backup(s) have failed"

        - alert: VeleroBackupNotRecent
          expr: |
            time() - velero_backup_last_successful_timestamp{schedule=~"daily.*"} > 86400
          for: 30m
          labels:
            severity: critical
          annotations:
            summary: "No successful daily backup in 24 hours"

        - alert: VeleroSchedulePaused
          expr: velero_schedule_info{paused="true"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Velero schedule {{ $labels.schedule_name }} is paused"
```

## Backup Security: Encryption at Rest

All backup data should be encrypted. Configure S3 server-side encryption with KMS:

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: encrypted-storage
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-encrypted-backups
  config:
    region: us-east-1
    serverSideEncryption: aws:kms
    kmsKeyId: "arn:aws:kms:us-east-1:123456789012:alias/velero-backup-key"
    # Enforce bucket policy requires KMS encryption
    s3ForcePathStyle: "false"
```

Additionally, Velero encrypts Kopia/Restic repository data client-side:

```bash
# Kopia repository uses random encryption key stored in Kubernetes secret
kubectl get secret velero-repo-credentials -n velero -o yaml
# The REPOSITORY_PASSWORD is used to encrypt repository data
```

## Excluding Sensitive Resources

Avoid backing up resources that contain secrets embedded in resource specs, or resources managed by other tools:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: production-backup
  namespace: velero
spec:
  excludedResources:
    # Managed by cert-manager - will be regenerated
    - certificaterequests
    - orders
    - challenges
    # Transient state
    - events
    - events.events.k8s.io
    # External-secrets creates these - back up SecretStore instead
    - externalsecrets
    # ArgoCD application status - regenerated on sync
    - applicationrevisions
  # Or exclude specific labels
  labelSelector:
    matchExpressions:
      - key: velero.io/exclude-from-backup
        operator: DoesNotExist
```

## Summary

A production Velero deployment requires more than a working `velero backup create` command. The enterprise implementation includes: multiple `BackupStorageLocation` resources for cross-region redundancy, CSI snapshots for fast volume backup on cloud providers, Kopia for file-based backup on providers without CSI support, pre/post hooks for application-consistent snapshots of databases, scheduled backups with tiered retention matching recovery objectives, and automated restore testing to validate that backups are actually usable.

The critical gap in most Velero deployments is the last point: restore testing. A backup that has never been tested is an assumption, not a guarantee. Automate monthly restore validation to a separate namespace, verify application health, and document the RTO (Recovery Time Objective) based on measured restore durations. This transforms Velero from a hope into a validated disaster recovery capability.
