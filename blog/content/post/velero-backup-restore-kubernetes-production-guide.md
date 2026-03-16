---
title: "Velero: Kubernetes Cluster Backup, Restore, and Migration in Production"
date: 2027-04-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "Disaster Recovery", "Migration"]
categories: ["Kubernetes", "Backup", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Velero for Kubernetes backup and disaster recovery, covering scheduled backups to S3/GCS/Azure, CSI snapshot integration, namespace-level restore, cross-cluster migration, backup hooks for database consistency, and Prometheus monitoring for backup health."
more_link: "yes"
url: "/velero-backup-restore-kubernetes-production-guide/"
---

Kubernetes does not back itself up. The etcd database that stores all cluster state, the persistent volumes attached to stateful workloads, and the configuration that ties it all together must be protected by external tooling. Velero provides a unified backup and restore layer that covers Kubernetes API objects, PersistentVolume data via CSI snapshots or file-system-level backup with Kopia, and namespace-level restore workflows that translate directly into cross-cluster migration paths.

This guide covers Velero installation, BackupStorageLocation configuration for AWS S3, GCS, and Azure Blob, backup hooks for database consistency, the Kopia integration for file-level data backup, CSI snapshot integration, restore procedures, migration workflows, and Prometheus monitoring — with production-ready manifests throughout.

<!--more-->

## Section 1: Velero Architecture

### Core Components

Velero runs as a Deployment inside the cluster it protects. The `velero` server pod handles backup and restore operations, delegating storage interactions to provider plugins.

- **Backup controller**: Watches for `Backup` objects, serializes Kubernetes API resources to an object store, and triggers volume backup via the configured method.
- **Restore controller**: Watches for `Restore` objects, retrieves serialized resources from the object store, applies them to the target cluster, and mounts restored volume data.
- **Schedule controller**: Creates `Backup` objects on a cron schedule, enforces TTL-based expiration, and maintains a configurable count of recent backups.
- **Restic/Kopia integration**: File-system-level backup of PersistentVolume data without requiring cloud provider snapshot APIs. Velero uses Kopia as the default in version 1.12+.

### Backup Storage and Volume Backup Methods

Velero supports two independent approaches to volume data backup:

1. **CSI snapshots**: Use the Kubernetes CSI VolumeSnapshot API to take snapshots at the storage provider level. Fast, consistent, and provider-native — requires a CSI driver that supports snapshots.
2. **File-system backup (Kopia)**: Tar the contents of the PV mount path from a sidecar, compress and encrypt, and upload to the object store alongside the API resource backup. Provider-agnostic — works with any storage.

## Section 2: Installation

### Prerequisites

```bash
# Verify CSI snapshot support
kubectl get crd volumesnapshotclasses.snapshot.storage.k8s.io 2>/dev/null \
  && echo "CSI snapshots supported" \
  || echo "Install the external-snapshotter CRD"

# Install external-snapshotter CRDs if not present
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.2/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.2/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.2/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Install the snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.2/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.2/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### Install Velero with AWS S3 Backend

```bash
# Install Velero CLI (version 1.13.x)
curl -L https://github.com/vmware-tanzu/velero/releases/download/v1.13.2/velero-v1.13.2-linux-amd64.tar.gz \
  | tar -xz -C /usr/local/bin --strip-components=1 velero-v1.13.2-linux-amd64/velero
velero version --client-only

# Create S3 bucket for backups (one-time setup)
aws s3 mb s3://k8s-velero-backups-us-east-1 \
  --region us-east-1

# Enable versioning to protect backup objects from accidental deletion
aws s3api put-bucket-versioning \
  --bucket k8s-velero-backups-us-east-1 \
  --versioning-configuration Status=Enabled

# Create IAM policy for Velero
cat > /tmp/velero-iam-policy.json <<'EOF'
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
      "Resource": "arn:aws:s3:::k8s-velero-backups-us-east-1/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::k8s-velero-backups-us-east-1"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name VeleroBackupPolicy \
  --policy-document file:///tmp/velero-iam-policy.json

# Install Velero with AWS plugin using IRSA
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.2 \
  --bucket k8s-velero-backups-us-east-1 \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --pod-annotations "eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/velero-irsa-role" \
  --no-secret \
  --features=EnableCSI \
  --use-node-agent \     # enables Kopia/restic file-system backup
  --default-volumes-to-fs-backup=false \  # opt-in to FS backup per PVC
  --wait
```

### Install Velero with GCS Backend

```bash
# Create GCS bucket
gsutil mb -l us-east1 gs://k8s-velero-backups-us-east1

# Create service account for Velero
gcloud iam service-accounts create velero-backup-sa \
  --display-name "Velero Backup Service Account" \
  --project my-platform-project

# Grant the service account access to the bucket
gsutil iam ch \
  serviceAccount:velero-backup-sa@my-platform-project.iam.gserviceaccount.com:objectAdmin \
  gs://k8s-velero-backups-us-east1

# Create and download the key
gcloud iam service-accounts keys create /tmp/velero-gcs-key.json \
  --iam-account velero-backup-sa@my-platform-project.iam.gserviceaccount.com

kubectl create secret generic gcs-credentials \
  -n velero \
  --from-file=cloud=/tmp/velero-gcs-key.json

velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.9.2 \
  --bucket k8s-velero-backups-us-east1 \
  --secret-file /tmp/velero-gcs-key.json \
  --backup-location-config serviceAccount=velero-backup-sa@my-platform-project.iam.gserviceaccount.com \
  --features=EnableCSI \
  --use-node-agent \
  --wait
```

## Section 3: BackupStorageLocation CRD

The `BackupStorageLocation` defines where backup files are written. Multiple locations can be configured for multi-cloud DR scenarios.

```yaml
# backup-storage-location-primary.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: k8s-velero-backups-us-east-1
    prefix: "cluster-us-east-1-prod"  # isolate by cluster within shared bucket
  config:
    region: us-east-1
    s3ForcePathStyle: "false"         # use virtual-hosted style for AWS
    checksumAlgorithm: ""             # leave empty to use AWS default (CRC32C)
  # Validate the BSL is reachable on this interval
  validationFrequency: 5m
  default: true    # used for backups that don't specify a storageLocation
  accessMode: ReadWrite
```

```yaml
# backup-storage-location-dr.yaml — secondary location in eu-west-1 for DR
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: dr-eu-west-1
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: k8s-velero-backups-eu-west-1
    prefix: "cluster-us-east-1-prod"
  config:
    region: eu-west-1
  validationFrequency: 10m
  default: false
  accessMode: ReadWrite
```

```bash
# Check BSL status
velero backup-location get
# NAME        PROVIDER   BUCKET/PREFIX                              PHASE       LAST VALIDATED
# primary     aws        k8s-velero-backups-us-east-1/cluster-...  Available   10s ago
# dr-eu-west  aws        k8s-velero-backups-eu-west-1/cluster-...  Available   5m ago
```

## Section 4: VolumeSnapshotLocation CRD

```yaml
# volume-snapshot-location.yaml
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-ebs-us-east-1
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
    # KMS key for encrypting EBS snapshots
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/example-kms-key-id-replace-me
```

## Section 5: Backup CRD

### Namespace-Scoped Backup

```yaml
# backup-payments-namespace.yaml — backup a single team's namespace
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: payments-2027-04-04
  namespace: velero
spec:
  includedNamespaces:
    - payments
    - payments-config   # include the config namespace as well
  excludedNamespaces: []
  # Include all resource types except ephemeral ones
  includedResources: []    # empty = all resources
  excludedResources:
    - events
    - events.events.k8s.io
  # Label selectors can further scope the backup
  labelSelector: {}
  # Storage configuration
  storageLocation: primary
  volumeSnapshotLocations:
    - aws-ebs-us-east-1
  # TTL: keep this backup for 30 days
  ttl: 720h0m0s
  # Volume backup method
  defaultVolumesToFsBackup: false   # use CSI snapshots by default
  snapshotVolumes: true             # take volume snapshots
  # Include cluster-scoped resources that the namespace resources reference
  includeClusterResources: null     # auto-detect (recommended)
```

### Cluster-Wide Backup

```yaml
# backup-full-cluster.yaml — complete cluster backup
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: full-cluster-2027-04-04
  namespace: velero
spec:
  includedNamespaces:
    - "*"   # all namespaces
  excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - velero          # do not back up Velero itself (bootstrapped separately)
  excludedResources:
    - events
    - events.events.k8s.io
    - endpoints        # reconstructed from Services
  storageLocation: primary
  volumeSnapshotLocations:
    - aws-ebs-us-east-1
  ttl: 168h0m0s    # 7-day retention for weekly backups
  defaultVolumesToFsBackup: false
  snapshotVolumes: true
  includeClusterResources: true
```

## Section 6: Schedule CRD for Automated Backups

```yaml
# schedule-daily-full.yaml — daily full backup with 30-day retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"    # 02:00 UTC every day
  template:
    includedNamespaces:
      - "*"
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
      - velero
    excludedResources:
      - events
      - events.events.k8s.io
    storageLocation: primary
    volumeSnapshotLocations:
      - aws-ebs-us-east-1
    ttl: 720h0m0s    # 30 days
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    labels:
      backup-type: daily
      managed-by: velero-schedule
  useOwnerReferencesInBackup: false
---
# schedule-hourly-critical.yaml — hourly backup of critical namespaces
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-critical-namespaces
  namespace: velero
spec:
  schedule: "15 * * * *"   # 15 minutes past every hour
  template:
    includedNamespaces:
      - payments
      - auth
      - database
    excludedResources:
      - events
    storageLocation: primary
    volumeSnapshotLocations:
      - aws-ebs-us-east-1
    ttl: 48h0m0s    # 48-hour retention for hourly backups
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    labels:
      backup-type: hourly
      tier: critical
```

## Section 7: Backup Hooks for Database Consistency

Backup hooks run commands inside containers before and after the backup to quiesce I/O, ensuring a crash-consistent or application-consistent snapshot.

### PostgreSQL Backup Hook

```yaml
# postgres-deployment-with-hooks.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres-payments
  namespace: payments
  annotations:
    # Pre-backup: checkpoint and flush WAL buffers
    pre.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c",
       "psql -U postgres -c 'CHECKPOINT;' && psql -U postgres -c 'SELECT pg_switch_wal();'"]
    pre.hook.backup.velero.io/container: postgres
    pre.hook.backup.velero.io/on-error: Fail   # abort backup if hook fails
    pre.hook.backup.velero.io/timeout: 60s
    # Post-backup: resume normal operations
    post.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c", "echo 'Backup complete - resuming normal operations'"]
    post.hook.backup.velero.io/container: postgres
    post.hook.backup.velero.io/on-error: Continue   # log but do not fail
    post.hook.backup.velero.io/timeout: 30s
spec:
  selector:
    matchLabels:
      app: postgres-payments
  template:
    metadata:
      labels:
        app: postgres-payments
    spec:
      containers:
        - name: postgres
          image: postgres:16.2-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: postgres-payments-data
```

### MySQL Backup Hook

```yaml
# mysql-deployment-with-hooks.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql-catalog
  namespace: catalog
  annotations:
    # Flush and lock tables for consistent snapshot
    pre.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c",
       "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'FLUSH TABLES WITH READ LOCK; FLUSH LOGS;'"]
    pre.hook.backup.velero.io/container: mysql
    pre.hook.backup.velero.io/on-error: Fail
    pre.hook.backup.velero.io/timeout: 90s
    # Unlock tables after snapshot completes
    post.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c",
       "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'UNLOCK TABLES;'"]
    post.hook.backup.velero.io/container: mysql
    post.hook.backup.velero.io/on-error: Continue
    post.hook.backup.velero.io/timeout: 30s
spec:
  selector:
    matchLabels:
      app: mysql-catalog
  template:
    metadata:
      labels:
        app: mysql-catalog
    spec:
      containers:
        - name: mysql
          image: mysql:8.2
          env:
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-credentials
                  key: root-password
          volumeMounts:
            - name: data
              mountPath: /var/lib/mysql
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: mysql-catalog-data
```

## Section 8: CSI Snapshot Integration

CSI snapshots are the recommended volume backup method for clusters with CSI drivers that support the snapshot API. They are faster, more consistent, and vendor-native compared to file-system backup.

### VolumeSnapshotClass Configuration

```yaml
# volumesnapshotclass-ebs.yaml — configure the EBS CSI snapshot class for Velero
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-csi-vsc
  labels:
    # This label tells Velero to use this class for CSI snapshots
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain   # keep snapshots when VolumeSnapshot objects are deleted
parameters:
  # Encrypt snapshots with the cluster's KMS key
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/example-kms-key-id-replace-me
```

### PVC with CSI Backup Annotation

```yaml
# pvc-postgres-data.yaml — PVC configured for CSI snapshot backup
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-payments-data
  namespace: payments
  labels:
    backup: "true"   # used by Schedule labelSelector to scope which PVCs are snapped
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: ebs-csi-gp3   # must use a CSI driver with snapshot support
```

### Backup with CSI Snapshots Enabled

```yaml
# backup-with-csi.yaml — explicitly use CSI snapshots
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: payments-csi-backup-2027-04-04
  namespace: velero
spec:
  includedNamespaces:
    - payments
  storageLocation: primary
  volumeSnapshotLocations:
    - aws-ebs-us-east-1
  # CSI snapshot is controlled at the feature level; ensure --features=EnableCSI is set
  snapshotVolumes: true
  defaultVolumesToFsBackup: false
  ttl: 720h0m0s
```

## Section 9: File-System Backup with Kopia

For PVs backed by storage that does not support CSI snapshots (NFS, local volumes, older drivers), Velero uses Kopia (the default in Velero 1.12+) to perform file-system-level backup.

### Enable Kopia per PVC

```yaml
# PVC annotation to enable Kopia file-system backup for this specific PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-uploads
  namespace: payments
  annotations:
    backup.velero.io/backup-volumes: "uploads"   # container volume name to back up
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: nfs-csi   # no CSI snapshot support
```

### Deployment Annotation for Kopia

```yaml
# deployment annotation to opt in specific volumes to FS backup
metadata:
  annotations:
    backup.velero.io/backup-volumes: "uploads,config"   # comma-separated volume names
    backup.velero.io/backup-volumes-excludes: "cache"   # volumes to exclude
```

### Kopia Repository Configuration

```bash
# Velero automatically creates the Kopia repository in the BSL bucket
# Check Kopia maintenance status
velero get backup-repository

# Force a Kopia repository maintenance run (compaction + garbage collection)
velero backup-repository maintenance --namespace velero
```

## Section 10: Restore CRD

### Basic Namespace Restore

```yaml
# restore-payments-from-backup.yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: payments-restore-2027-04-04
  namespace: velero
spec:
  backupName: payments-2027-04-04   # name of the Backup object to restore from
  includedNamespaces:
    - payments
  excludedNamespaces: []
  # Restore all resource types
  includedResources: []
  excludedResources:
    - nodes
    - events
    - events.events.k8s.io
    - PersistentVolume   # do not restore PV objects — let PVCs create new ones
  # Restore volume data
  restorePVs: true
  # Do not restore existing resources (preserveNodePorts, existingResourcePolicy)
  existingResourcePolicy: none   # fail if resource already exists
  # Restore all label selectors
  labelSelector: {}
```

### Namespace Remapping for Migration

```yaml
# restore-with-namespace-remap.yaml — migrate payments namespace to payments-v2
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: payments-migration-to-v2
  namespace: velero
spec:
  backupName: payments-2027-04-04
  includedNamespaces:
    - payments
  # Remap the namespace name in the restored objects
  namespaceMapping:
    payments: payments-v2    # old name: new name
  restorePVs: true
  existingResourcePolicy: none
```

### Selective Resource Restore

```yaml
# restore-only-configmaps.yaml — restore only ConfigMaps from a backup
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: restore-configmaps-only
  namespace: velero
spec:
  backupName: full-cluster-2027-04-04
  includedNamespaces:
    - payments
    - auth
  includedResources:
    - configmaps
    - secrets
  restorePVs: false
  existingResourcePolicy: update   # overwrite existing ConfigMaps and Secrets
```

## Section 11: Cross-Cluster Migration Workflow

### Migration Procedure

```bash
#!/usr/bin/env bash
# migrate-namespace.sh — migrate a namespace from source cluster to target cluster
# Usage: ./migrate-namespace.sh <namespace> <source-context> <target-context>
set -euo pipefail

NAMESPACE="${1:?Namespace required}"
SOURCE_CTX="${2:?Source context required}"
TARGET_CTX="${3:?Target context required}"
BACKUP_NAME="migration-${NAMESPACE}-$(date +%Y%m%d%H%M%S)"

echo "=== Step 1: Create backup on source cluster ==="
kubectl config use-context "${SOURCE_CTX}"
velero backup create "${BACKUP_NAME}" \
  --include-namespaces "${NAMESPACE}" \
  --snapshot-volumes \
  --wait

echo "=== Step 2: Verify backup status ==="
velero backup describe "${BACKUP_NAME}" --details
BACKUP_STATUS=$(velero backup get "${BACKUP_NAME}" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['status']['phase'])")
if [[ "${BACKUP_STATUS}" != "Completed" ]]; then
  echo "ERROR: Backup did not complete. Status: ${BACKUP_STATUS}"
  exit 1
fi

echo "=== Step 3: Configure BSL on target cluster ==="
kubectl config use-context "${TARGET_CTX}"
# The target cluster must have Velero installed and a BSL pointing to the same bucket
velero backup-location get primary

echo "=== Step 4: Sync backup metadata to target cluster ==="
# Force Velero to discover the backup from the shared bucket
velero backup-location sync primary

echo "=== Step 5: Restore backup on target cluster ==="
velero restore create "${BACKUP_NAME}-restore" \
  --from-backup "${BACKUP_NAME}" \
  --include-namespaces "${NAMESPACE}" \
  --restore-volumes \
  --wait

echo "=== Step 6: Verify restore status ==="
velero restore describe "${BACKUP_NAME}-restore" --details
RESTORE_STATUS=$(velero restore get "${BACKUP_NAME}-restore" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['status']['phase'])")
if [[ "${RESTORE_STATUS}" != "Completed" ]]; then
  echo "ERROR: Restore did not complete. Status: ${RESTORE_STATUS}"
  exit 1
fi

echo "=== Step 7: Verify workloads on target cluster ==="
kubectl get pods -n "${NAMESPACE}" --context "${TARGET_CTX}"
kubectl get pvc -n "${NAMESPACE}" --context "${TARGET_CTX}"

echo "Migration of ${NAMESPACE} from ${SOURCE_CTX} to ${TARGET_CTX} completed."
```

### Migration with Namespace Remapping

```bash
# Restore to target cluster with namespace rename
velero restore create \
  --from-backup "migration-payments-20270404120000" \
  --namespace-mappings "payments:payments-prod" \
  --restore-volumes \
  --wait
```

## Section 12: Prometheus Monitoring for Backup Health

### Velero Metrics Reference

```bash
# Verify Velero is exposing metrics
kubectl port-forward svc/velero -n velero 8085:8085
curl -s http://localhost:8085/metrics | grep velero

# Key metrics:
# velero_backup_total                     — total backups by status
# velero_backup_success_total             — successful backup count
# velero_backup_failure_total             — failed backup count
# velero_backup_duration_seconds          — backup duration histogram
# velero_backup_last_successful_timestamp — Unix timestamp of last success
# velero_restore_total                    — total restores
# velero_restore_success_total            — successful restore count
# velero_restore_failed_total             — failed restore count
# velero_volume_snapshot_attempt_total    — snapshot attempts
# velero_volume_snapshot_success_total    — successful snapshots
# velero_volume_snapshot_failure_total    — failed snapshots
```

### Prometheus Alert Rules

```yaml
# velero-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-backup-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: velero.backup
      interval: 60s
      rules:
        # Alert if no successful backup in 26 hours (daily backup missed)
        - alert: VeleroBackupMissed
          expr: |
            (time() - velero_backup_last_successful_timestamp{schedule="daily-full-backup"}) > 93600
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Velero daily backup missed on {{ $labels.cluster }}"
            description: "No successful backup for schedule {{ $labels.schedule }} in the last 26 hours. Last success: {{ $value | humanizeDuration }} ago."
            runbook: "https://wiki.example.com/runbooks/velero-backup-missed"

        # Alert on any backup failure
        - alert: VeleroBackupFailed
          expr: |
            increase(velero_backup_failure_total[1h]) > 0
          for: 0m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Velero backup failed"
            description: "{{ $value }} backup(s) failed in the last hour."

        # Alert if backup duration is unusually long (> 2 hours)
        - alert: VeleroBackupDurationHigh
          expr: |
            velero_backup_duration_seconds{quantile="0.99"} > 7200
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Velero backup taking too long"
            description: "P99 backup duration is {{ $value | humanizeDuration }}, expected < 2 hours."

        # Alert on volume snapshot failures
        - alert: VeleroVolumeSnapshotFailed
          expr: |
            increase(velero_volume_snapshot_failure_total[1h]) > 0
          for: 0m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Velero volume snapshot failed"
            description: "{{ $value }} volume snapshot(s) failed in the last hour."

        # Alert if BSL becomes unavailable
        - alert: VeleroBackupStorageUnavailable
          expr: |
            velero_backup_storage_location_phase{phase!="Available"} == 1
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Velero BackupStorageLocation unavailable: {{ $labels.name }}"
            description: "BSL {{ $labels.name }} is in phase {{ $labels.phase }}. Backups cannot be stored or retrieved."
```

### ServiceMonitor for Velero

```yaml
# velero-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: velero
  namespace: monitoring
  labels:
    app: velero
spec:
  namespaceSelector:
    matchNames:
      - velero
  selector:
    matchLabels:
      app.kubernetes.io/name: velero
  endpoints:
    - port: monitoring
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

## Section 13: Velero CLI Cheatsheet

```bash
# === Backup Operations ===

# Create an ad-hoc backup immediately
velero backup create adhoc-backup-$(date +%Y%m%d) \
  --include-namespaces payments \
  --snapshot-volumes \
  --wait

# List all backups with status
velero backup get

# Show detailed backup information including hooks and warnings
velero backup describe adhoc-backup-20270404 --details

# Download backup logs for debugging
velero backup logs adhoc-backup-20270404

# Delete a specific backup and its storage artifacts
velero backup delete adhoc-backup-20270404 --confirm

# === Restore Operations ===

# List available restores
velero restore get

# Create a restore from a backup
velero restore create --from-backup adhoc-backup-20270404 --wait

# Show restore details
velero restore describe adhoc-backup-20270404-restore --details

# Download restore logs
velero restore logs adhoc-backup-20270404-restore

# === Schedule Operations ===

# List all schedules
velero schedule get

# Pause a schedule during maintenance
velero schedule pause daily-full-backup

# Resume a paused schedule
velero schedule unpause daily-full-backup

# Manually trigger a scheduled backup immediately
velero backup create --from-schedule daily-full-backup

# === Storage Location Operations ===

# List backup storage locations with health status
velero backup-location get

# Sync backups from a BSL that another cluster wrote to
velero backup-location sync primary

# === Debug Operations ===

# Check Velero server logs
kubectl logs deploy/velero -n velero --since=1h

# Check node agent (restic/kopia) logs
kubectl logs daemonset/node-agent -n velero --since=1h

# Describe a specific backup to see all metadata
kubectl get backup adhoc-backup-20270404 -n velero -o yaml

# Check all VolumeSnapshots created by a backup
kubectl get volumesnapshots -A -l velero.io/backup-name=adhoc-backup-20270404

# Check which PVCs were backed up
kubectl get podvolumebackups -n velero --field-selector spec.backupName=adhoc-backup-20270404
```

## Section 14: Backup Validation Testing Runbook

Untested backups are not backups. The following runbook verifies restore correctness at a namespace level without affecting production.

```bash
#!/usr/bin/env bash
# validate-backup.sh — restore a namespace to an isolated test namespace
# and verify application health
# Usage: ./validate-backup.sh <backup-name> <source-namespace>
set -euo pipefail

BACKUP_NAME="${1:?Backup name required}"
SOURCE_NS="${2:?Source namespace required}"
TEST_NS="${SOURCE_NS}-restore-test-$(date +%s)"
TIMEOUT_SECONDS=300

echo "=== Backup Validation: ${BACKUP_NAME} ==="
echo "Restoring ${SOURCE_NS} to ${TEST_NS}"

# Create the restore with namespace remapping
velero restore create "validate-${BACKUP_NAME}" \
  --from-backup "${BACKUP_NAME}" \
  --include-namespaces "${SOURCE_NS}" \
  --namespace-mappings "${SOURCE_NS}:${TEST_NS}" \
  --restore-volumes \
  --wait --timeout "${TIMEOUT_SECONDS}s"

echo "--- Checking restored resources ---"
kubectl get pods -n "${TEST_NS}"
kubectl get pvc -n "${TEST_NS}"
kubectl get svc -n "${TEST_NS}"

# Wait for pods to become ready
echo "--- Waiting for pods to become ready ---"
kubectl wait --for=condition=Ready pod --all \
  -n "${TEST_NS}" \
  --timeout="${TIMEOUT_SECONDS}s" \
  || echo "WARNING: Not all pods became ready within timeout"

# Run a basic health check (customize the endpoint for the application)
SVC_IP=$(kubectl get svc -n "${TEST_NS}" -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null)
if [[ -n "${SVC_IP}" ]]; then
  HEALTH_CODE=$(kubectl run curl-test --rm -it --restart=Never \
    -n "${TEST_NS}" \
    --image=curlimages/curl:8.6.0 \
    -- curl -s -o /dev/null -w "%{http_code}" "http://${SVC_IP}/health" 2>/dev/null)
  echo "Health check response: ${HEALTH_CODE}"
  if [[ "${HEALTH_CODE}" == "200" ]]; then
    echo "PASS: Application health check succeeded"
  else
    echo "WARN: Health check returned ${HEALTH_CODE}"
  fi
fi

echo "--- Cleaning up test namespace ---"
kubectl delete namespace "${TEST_NS}"
velero restore delete "validate-${BACKUP_NAME}" --confirm

echo "=== Validation complete for backup: ${BACKUP_NAME} ==="
```

## Summary

Velero provides a comprehensive Kubernetes backup and restore solution that operates at two independent levels: the Kubernetes API object layer (serialized to an object store) and the PersistentVolume data layer (via CSI snapshots or Kopia file-system backup). BackupStorageLocation objects define the target object store, with multiple locations enabling geo-redundant DR configurations. Schedule objects automate daily or hourly backups with configurable TTLs. Backup hooks serialize database I/O before CSI snapshots execute, eliminating the class of corruption caused by in-flight write buffers. Restore objects map directly to cross-cluster migration workflows through namespace remapping. Prometheus metrics and PrometheusRule alerts close the observability loop, ensuring that a missed backup triggers a PagerDuty incident before the next disaster test reveals an empty bucket.
