---
title: "Kubernetes Velero + Restic: Application-Consistent Backups for Stateful Workloads with Pre/Post Hooks"
date: 2031-08-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Restic", "Backup", "Disaster Recovery", "StatefulSet", "Storage"]
categories: ["Kubernetes", "Backup", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes backup with Velero and Restic: architecture, S3 configuration, application-consistent backups using pre/post hooks for PostgreSQL and MySQL, backup schedules, restore procedures, and disaster recovery testing."
more_link: "yes"
url: "/velero-restic-stateful-backup-prehook-posthook-kubernetes-guide/"
---

Kubernetes backup has two fundamentally different requirements: backing up Kubernetes resources (Deployments, Services, ConfigMaps, Secrets — the cluster state) and backing up the data that applications produce (PostgreSQL data directories, object storage files, persistent volumes). Velero handles both, but stateful workloads require additional care. A filesystem-level backup of a running PostgreSQL instance captures data in an inconsistent state unless the database is quiesced first. Velero's pre/post hook mechanism solves this by running commands in the application container before and after the volume snapshot — triggering a checkpoint, flush, or freeze that ensures the backup is application-consistent.

<!--more-->

# Kubernetes Velero + Restic: Application-Consistent Backups for Stateful Workloads with Pre/Post Hooks

## Architecture Overview

```
Velero Architecture:
┌────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                     │
│                                                         │
│  Velero Controller Pod                                  │
│  ├── Schedule CRDs (when to back up)                    │
│  ├── Backup CRDs (what to back up)                      │
│  └── Restore CRDs (how to restore)                      │
│                                                         │
│  Node Agent DaemonSet (Restic)                          │
│  ├── Pod on each node                                   │
│  └── Mounts PVC volumes for file-level backup           │
│                                                         │
└─────────────────────┬──────────────────────────────────┘
                      │
                      ▼ S3/GCS/Azure Blob
                ┌─────────────┐
                │  Backup     │
                │  Storage    │
                │  (Object    │
                │  Storage)   │
                └─────────────┘
```

Velero supports two volume backup methods:
1. **CSI Volume Snapshots**: creates a snapshot via the CSI driver (preferred for supported CSI drivers like EBS, GCE PD, Azure Disk)
2. **Restic**: file-level backup that reads the volume data and uploads to object storage (works with any PVC, including NFS and local volumes)

For most production cases: use CSI snapshots for performance-critical stateful workloads (they are nearly instantaneous) and Restic for volumes on storage drivers that don't support snapshots.

## Installation

### Prerequisites

```bash
# Install Velero CLI
VELERO_VERSION=v1.13.0
curl -fsSL \
  "https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-amd64.tar.gz" | \
  tar -xzf - --strip-components=1 -C /usr/local/bin velero-${VELERO_VERSION}-linux-amd64/velero

velero version --client-only
# Client:
#     Version: v1.13.0

# Create S3 bucket for backup storage
aws s3api create-bucket \
  --bucket velero-backups-production \
  --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1

# Enable versioning on the backup bucket
aws s3api put-bucket-versioning \
  --bucket velero-backups-production \
  --versioning-configuration Status=Enabled

# Enable server-side encryption
aws s3api put-bucket-encryption \
  --bucket velero-backups-production \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:us-east-1:<account-id>:key/<key-id>"
      },
      "BucketKeyEnabled": true
    }]
  }'
```

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
      "Resource": [
        "arn:aws:s3:::velero-backups-production/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::velero-backups-production"
      ]
    }
  ]
}
```

### Installing Velero with Helm

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm repo update

helm install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --version 6.0.0 \
  --values velero-values.yaml
```

```yaml
# velero-values.yaml
image:
  repository: velero/velero
  tag: v1.13.0

# Use IRSA for AWS credentials (no static keys)
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/velero-backup-role

configuration:
  # Primary backup storage location
  backupStorageLocation:
    - name: default
      provider: aws
      bucket: velero-backups-production
      prefix: cluster-production
      default: true
      config:
        region: us-east-1
        kmsKeyId: arn:aws:kms:us-east-1:<account-id>:key/<key-id>
        serverSideEncryption: aws:kms

  # Volume snapshot location
  volumeSnapshotLocation:
    - name: default
      provider: aws
      config:
        region: us-east-1

  # Default backup TTL
  backupTTL: 720h  # 30 days

  uploaderType: restic

# Deploy the node agent DaemonSet for Restic/Kopia backups
deployNodeAgent: true

nodeAgent:
  podVolumePath: /var/lib/kubelet/pods
  privileged: false
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

resources:
  requests:
    cpu: 500m
    memory: 128Mi
  limits:
    cpu: 1000m
    memory: 512Mi

# Enable metrics
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
```

## Application-Consistent Backup with Hooks

The pre/post hook mechanism is the critical feature for stateful workload backups. Without hooks:
- PostgreSQL: backup may capture pages in the middle of a write, requiring crash recovery
- MySQL: InnoDB buffer pool may have unflushed dirty pages
- MongoDB: backup may be inconsistent across shards

### PostgreSQL Hook Configuration

```yaml
# postgres-deployment.yaml (with backup hooks)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: postgres
      annotations:
        # Pre-hook: trigger checkpoint before backup
        # pg_start_backup() checkpoint ensures all dirty pages are written to disk
        pre.hook.backup.velero.io/container: postgres
        pre.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "psql -U $POSTGRES_USER -c \"SELECT pg_start_backup('velero', false, false)\" postgres"]
        pre.hook.backup.velero.io/timeout: 60s
        pre.hook.backup.velero.io/on-error: Fail

        # Post-hook: stop the backup mode
        post.hook.backup.velero.io/container: postgres
        post.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "psql -U $POSTGRES_USER -c \"SELECT pg_stop_backup(false, true)\" postgres"]
        post.hook.backup.velero.io/timeout: 60s
        post.hook.backup.velero.io/on-error: Continue
    spec:
      containers:
        - name: postgres
          image: postgres:16.2
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: postgres-data
          persistentVolumeClaim:
            claimName: postgres-data
```

For PostgreSQL using CloudNativePG (where you can't easily add annotations to the operator-managed pods), use a separate Backup resource hook:

```yaml
# velero-backup-postgres.yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: postgres-consistent-backup
  namespace: velero
spec:
  includedNamespaces:
    - production
  labelSelector:
    matchLabels:
      app: postgres
  storageLocation: default
  volumeSnapshotLocations:
    - default
  ttl: 720h
  defaultVolumesToFsBackup: true  # Use Restic for PVCs

  # Hooks defined in the Backup resource (alternative to annotations)
  hooks:
    resources:
      - name: postgres-backup-hook
        includedNamespaces:
          - production
        labelSelector:
          matchLabels:
            app: postgres
        pre:
          - exec:
              container: postgres
              command:
                - sh
                - -c
                - |
                  # Create a checkpoint and wait for it to complete
                  psql -U $POSTGRES_USER \
                    -c "CHECKPOINT;" \
                    -c "SELECT pg_start_backup('velero-$(date +%Y%m%d%H%M%S)', false, false);" \
                    postgres
              timeout: 60s
              onError: Fail
        post:
          - exec:
              container: postgres
              command:
                - sh
                - -c
                - |
                  psql -U $POSTGRES_USER \
                    -c "SELECT pg_stop_backup(false, true);" \
                    postgres
              timeout: 60s
              onError: Continue
```

### MySQL / MariaDB Hook Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Pre-hook: flush and lock tables
        pre.hook.backup.velero.io/container: mysql
        pre.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'FLUSH TABLES WITH READ LOCK; FLUSH LOGS;'"]
        pre.hook.backup.velero.io/timeout: 120s
        pre.hook.backup.velero.io/on-error: Fail

        # Post-hook: unlock tables
        post.hook.backup.velero.io/container: mysql
        post.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'UNLOCK TABLES;'"]
        post.hook.backup.velero.io/timeout: 30s
        post.hook.backup.velero.io/on-error: Continue
```

### Redis Hook Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Pre-hook: trigger BGSAVE and wait for it to complete
        pre.hook.backup.velero.io/container: redis
        pre.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "redis-cli BGSAVE && until [ $(redis-cli LASTSAVE) -gt $(date +%s -d '5 minutes ago') ]; do sleep 1; done"]
        pre.hook.backup.velero.io/timeout: 300s
        pre.hook.backup.velero.io/on-error: Fail
```

### MongoDB Hook Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mongodb
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Pre-hook: fsync and lock the database
        pre.hook.backup.velero.io/container: mongodb
        pre.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "mongo admin -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --eval 'db.fsyncLock()'"]
        pre.hook.backup.velero.io/timeout: 60s
        pre.hook.backup.velero.io/on-error: Fail

        # Post-hook: unlock the database
        post.hook.backup.velero.io/container: mongodb
        post.hook.backup.velero.io/command: >-
          ["sh", "-c",
           "mongo admin -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --eval 'db.fsyncUnlock()'"]
        post.hook.backup.velero.io/timeout: 30s
        post.hook.backup.velero.io/on-error: Continue
```

## Backup Schedules

```yaml
# scheduled-backups.yaml

# Daily full backup of all namespaces
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM UTC daily
  template:
    includedNamespaces:
      - production
      - staging
      - monitoring
    excludedResources:
      - nodes
      - events
      - events.events.k8s.io
    storageLocation: default
    volumeSnapshotLocations:
      - default
    ttl: 720h  # 30 days
    defaultVolumesToFsBackup: true
    hooks:
      resources:
        - name: pre-backup-hook
          includedNamespaces:
            - production
          labelSelector:
            matchExpressions:
              - key: velero.io/backup-hooks
                operator: In
                values: ["enabled"]
          pre:
            - exec:
                container: app
                command: ["/bin/sh", "-c", "/scripts/pre-backup.sh"]
                timeout: 120s
                onError: Fail

---
# Hourly incremental backup of critical namespace only
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-critical-backup
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    includedNamespaces:
      - production
    labelSelector:
      matchLabels:
        backup-tier: critical
    storageLocation: default
    volumeSnapshotLocations:
      - default
    ttl: 168h  # 7 days
    defaultVolumesToFsBackup: false  # Snapshots only for hourly
```

## Backup Verification

Backups are only valuable if restores work. Automate restoration testing:

```bash
#!/bin/bash
# verify-backup.sh - Automated backup verification
# Run this in a separate verification cluster to avoid impacting production

BACKUP_NAME=${1:?Usage: verify-backup.sh <backup-name>}
VERIFY_NAMESPACE="backup-verification-$(date +%s)"

echo "=== Backup Verification: $BACKUP_NAME ==="

# Create an isolated namespace for verification
kubectl create namespace "$VERIFY_NAMESPACE"
trap "kubectl delete namespace $VERIFY_NAMESPACE" EXIT

echo "Restoring backup $BACKUP_NAME to namespace $VERIFY_NAMESPACE..."

# Restore with namespace mapping
velero restore create \
  --from-backup "$BACKUP_NAME" \
  --namespace-mappings "production:$VERIFY_NAMESPACE" \
  --restore-volumes=false \  # Don't restore PVCs for quick structural check
  --include-namespaces production \
  --wait

# Check restore status
RESTORE_STATUS=$(velero restore describe \
  --details \
  $(velero restore get | grep "$BACKUP_NAME" | head -1 | awk '{print $1}') | \
  grep "Phase:" | awk '{print $2}')

if [ "$RESTORE_STATUS" != "Completed" ]; then
  echo "FAIL: Restore phase is $RESTORE_STATUS, expected Completed"
  velero restore describe --details | tail -50
  exit 1
fi

echo "Restore phase: $RESTORE_STATUS"

# Verify key resources were restored
echo ""
echo "Verifying restored resources:"
for resource in deployment statefulset service configmap; do
  COUNT=$(kubectl get $resource -n "$VERIFY_NAMESPACE" --no-headers 2>/dev/null | wc -l)
  echo "  $resource: $COUNT"
done

# Verify pods start successfully (basic smoke test)
echo ""
echo "Checking pod startup (30s timeout)..."
kubectl wait --for=condition=ready pod \
  -n "$VERIFY_NAMESPACE" \
  -l app=api-server \
  --timeout=30s 2>/dev/null && echo "  API server pods: READY" || echo "  API server pods: NOT READY (check logs)"

echo ""
echo "=== Verification complete ==="
```

### Monthly Full Restore Test

```yaml
# restore-test-schedule.yaml - Monthly full DR test
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: monthly-restore-test
  namespace: velero
spec:
  schedule: "0 4 1 * *"  # 4 AM UTC on the 1st of each month
  template:
    # This creates a backup that is used as the restore test source
    includedNamespaces:
      - production
    ttl: 48h  # Keep only 2 days - it's just for testing
    storageLocation: default
    volumeSnapshotLocations:
      - default
    defaultVolumesToFsBackup: true
    # After this backup completes, a separate CronJob triggers the restore test
    labels:
      backup-purpose: restore-test
```

```yaml
# restore-test-job.yaml - CronJob that tests restores monthly
apiVersion: batch/v1
kind: CronJob
metadata:
  name: monthly-restore-verification
  namespace: velero
spec:
  schedule: "0 6 1 * *"  # 6 AM UTC on the 1st (2 hours after backup)
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero
          containers:
            - name: restore-verifier
              image: myrepo/velero-test:latest
              command:
                - /bin/bash
                - /scripts/verify-backup.sh
              env:
                - name: BACKUP_LABEL
                  value: "backup-purpose=restore-test"
                - name: NOTIFY_SLACK
                  value: "true"
          restartPolicy: Never
```

## Monitoring Backup Health

```yaml
# PrometheusRule for Velero
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-backup-alerts
  namespace: monitoring
spec:
  groups:
    - name: velero.backup
      rules:
        - alert: VeleroBackupFailed
          expr: |
            velero_backup_failure_total > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failed: {{ $labels.schedule }}"
            description: "{{ $value }} backup(s) failed for schedule {{ $labels.schedule }}"

        - alert: VeleroBackupPartiallyFailed
          expr: |
            velero_backup_partial_failure_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Velero backup partially failed"

        - alert: VeleroBackupNotRun
          expr: |
            (time() - velero_backup_last_successful_timestamp{schedule=~"daily-.*"}) > 86400
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Daily backup has not run in over 24 hours"
            description: "Last successful backup for {{ $labels.schedule }}: {{ $value | humanizeTimestamp }}"

        - alert: VeleroRestoreFailed
          expr: |
            velero_restore_failed_total > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Velero restore failed"

        - alert: VeleroNodeAgentNotReady
          expr: |
            kube_daemonset_status_number_ready{daemonset="node-agent", namespace="velero"} <
            kube_daemonset_status_desired_number_scheduled{daemonset="node-agent", namespace="velero"}
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Velero node agent not ready on all nodes"
```

## Disaster Recovery Runbook

### Full Cluster Restore

```bash
#!/bin/bash
# cluster-restore.sh - Full cluster disaster recovery

TARGET_CLUSTER=${1:?}
BACKUP_NAME=${2:?}
SOURCE_CLUSTER=${3:-production}

echo "=== Cluster Restore: $BACKUP_NAME to $TARGET_CLUSTER ==="
echo ""
echo "This will restore all resources from backup $BACKUP_NAME"
echo "Target cluster: $TARGET_CLUSTER"
echo ""
read -p "Continue? (yes/no): " confirm
[ "$confirm" = "yes" ] || exit 1

# Switch kubectl context to target cluster
kubectl config use-context "$TARGET_CLUSTER"

# Install Velero on the target cluster (if not present)
# ... (helm install as above) ...

# Verify target cluster can access the backup storage
velero backup-location get

# List available backups
echo ""
echo "Available backups:"
velero backup get | grep -E "Completed|$BACKUP_NAME"
echo ""

# Restore system namespaces first (CRDs, RBAC, etc.)
echo "Step 1: Restoring CRDs and cluster-wide resources..."
velero restore create \
  --from-backup "$BACKUP_NAME" \
  --include-cluster-scoped-resources crd,clusterrole,clusterrolebinding \
  --include-namespaces "" \
  --restore-volumes=false \
  --wait

# Wait for CRDs to be established
kubectl wait --for condition=established crd --all --timeout=120s

# Restore core namespaces
echo ""
echo "Step 2: Restoring core namespaces (cert-manager, monitoring)..."
velero restore create \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces cert-manager,monitoring \
  --restore-volumes=true \
  --wait

# Restore application namespaces
echo ""
echo "Step 3: Restoring application namespaces..."
velero restore create \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces production \
  --restore-volumes=true \
  --wait

# Verify restore status
echo ""
echo "Restore Summary:"
velero restore get | tail -10

# Check pod health
echo ""
echo "Pod status across restored namespaces:"
kubectl get pods -A --field-selector 'status.phase!=Running,status.phase!=Completed' | \
  grep -v NAMESPACE | head -30

echo ""
echo "=== Restore complete. Verify application health before updating DNS. ==="
```

## Best Practices for Stateful Backup

### PVC Annotation for Opt-In Restic Backup

By default, Velero can be configured to back up all PVCs or only opted-in ones. For large clusters, opt-in is safer:

```yaml
# Add this annotation to PVCs that should be backed up via Restic
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
  annotations:
    backup.velero.io/backup-volumes: "postgres-data"  # Opt-in this PVC for file backup
    # Or to use CSI snapshot for this specific PVC:
    backup.velero.io/backup-volumes-excludes: ""  # Exclude from file backup (use CSI snapshot)
```

### Backup Retention Policy

```bash
#!/bin/bash
# backup-retention.sh - List and clean up old backups exceeding retention policy

MAX_DAILY_BACKUPS=30
MAX_WEEKLY_BACKUPS=12

echo "Daily backups older than $MAX_DAILY_BACKUPS days:"
velero backup get | \
  awk '/daily/ && /Completed/ {print $1, $3}' | \
  while read name age; do
    days=$(echo "$age" | grep -oP '\d+(?=d)')
    [ -n "$days" ] && [ "$days" -gt "$MAX_DAILY_BACKUPS" ] && echo "  EXPIRED: $name ($age)"
  done

echo ""
echo "To delete an expired backup:"
echo "  velero backup delete <backup-name>"
echo ""
echo "To enable automatic TTL-based deletion, set TTL in the Schedule:"
echo "  spec.template.ttl: 720h  # 30 days"
```

## Summary

Effective Kubernetes backup with Velero requires understanding the distinction between resource backup (cluster state) and data backup (persistent volume contents), and ensuring that data backups are application-consistent rather than crash-consistent.

The pre/post hook mechanism is the critical piece: without it, a PostgreSQL or MySQL backup captures the filesystem at an arbitrary point during transaction processing, and the restored database must run crash recovery on every restore. With proper hooks — `pg_start_backup()`/`pg_stop_backup()` for PostgreSQL, `FLUSH TABLES WITH READ LOCK` for MySQL — the backup captures a consistent checkpoint that restores cleanly without recovery.

For production deployments: use CSI volume snapshots where the storage driver supports them (near-zero impact on the application), fall back to Restic for volumes on drivers without snapshot support, always test restores monthly in an isolated environment, and monitor backup age with Prometheus alerts so that a failed backup job doesn't go undetected for days.
