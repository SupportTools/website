---
title: "Kubernetes Backup and DR with Velero: Advanced Strategies"
date: 2029-06-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "Disaster Recovery", "CSI", "Storage"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Velero backup strategies covering hook annotations, resource filtering, backup storage locations, cross-cluster restore, backup validation workflows, and CSI volume snapshots for production Kubernetes environments."
more_link: "yes"
url: "/kubernetes-backup-dr-velero-advanced-strategies/"
---

Velero is the de facto standard for Kubernetes backup and disaster recovery, but most teams use only a fraction of its capabilities. The default `velero backup create` command captures resource definitions but misses application consistency, leaves out cluster-scoped resources unexpectedly, and provides no mechanism to validate restores. This guide covers the full production feature set: hook annotations for consistent snapshots, storage location management, cross-cluster restore procedures, and automated backup validation.

<!--more-->

# Kubernetes Backup and DR with Velero: Advanced Strategies

## Section 1: Velero Architecture

Velero runs as a Deployment in your cluster plus optional Node Agent DaemonSets (formerly Restic) for volume backup. The core components are:

- **Velero server**: Processes BackupSchedule, Backup, and Restore CRDs
- **Node Agent**: Per-node process that reads PVC contents directly for file-level backup
- **BackupStorageLocation (BSL)**: Defines where backup files are stored
- **VolumeSnapshotLocation (VSL)**: Defines where CSI snapshots are stored
- **Plugins**: Provider-specific adapters for cloud object storage and snapshots

### Installation with AWS S3

```bash
# Install Velero CLI
VELERO_VERSION=v1.13.0
curl -L https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-amd64.tar.gz | tar xz
mv velero-${VELERO_VERSION}-linux-amd64/velero /usr/local/bin/

# Create IAM credentials file (use IAM roles in production)
cat > /tmp/credentials-velero <<EOF
[default]
aws_access_key_id=<AWS_ACCESS_KEY_ID>
aws_secret_access_key=<AWS_SECRET_ACCESS_KEY>
EOF

# Install Velero with AWS plugin
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --secret-file /tmp/credentials-velero \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --pod-annotations "cluster-autoscaler.kubernetes.io/safe-to-evict=true"

# Verify installation
kubectl get pods -n velero
velero backup-location get
```

### Installation with Google Cloud

```bash
# For GKE with Workload Identity
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.9.0 \
  --bucket my-velero-gcs-bucket \
  --no-secret \
  --sa-annotations "iam.gke.io/gcp-service-account=velero@my-project.iam.gserviceaccount.com" \
  --backup-location-config serviceAccount=velero@my-project.iam.gserviceaccount.com \
  --use-node-agent
```

---

## Section 2: Backup Storage Locations (BSL) Management

Multiple BSLs allow sending backups to different destinations — different regions, different cloud providers, or air-gapped storage.

### Multiple BSLs for Multi-Region DR

```yaml
# bsl-primary.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: primary
  namespace: velero
spec:
  provider: aws
  default: true
  objectStorage:
    bucket: velero-backups-us-east-1
    prefix: production
  config:
    region: us-east-1
  credential:
    name: cloud-credentials
    key: cloud
---
# bsl-dr.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: dr-west
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-us-west-2
    prefix: production
  config:
    region: us-west-2
  credential:
    name: cloud-credentials-west
    key: cloud
---
# bsl-offsite.yaml — Azure for cross-cloud DR
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: offsite-azure
  namespace: velero
spec:
  provider: azure
  objectStorage:
    bucket: velerobackups
    prefix: production
  config:
    storageAccount: velerosa
    storageAccountKeyEnvVar: AZURE_STORAGE_ACCOUNT_ACCESS_KEY
    resourceGroup: velero-rg
    subscriptionId: <AZURE_SUBSCRIPTION_ID>
  credential:
    name: azure-credentials
    key: cloud
```

```bash
# Check BSL status
velero backup-location get
# NAME        PROVIDER   BUCKET/PREFIX                    PHASE       LAST VALIDATED
# primary     aws        velero-backups-us-east-1/prod    Available   2029-06-21T00:01:00Z
# dr-west     aws        velero-backups-us-west-2/prod    Available   2029-06-21T00:01:00Z
# offsite-azure azure    velerobackups/production         Available   2029-06-21T00:01:00Z

# Trigger BSL re-validation
velero backup-location get --output json | \
  jq -r '.items[].metadata.name' | \
  xargs -I{} kubectl patch backupstoragelocation {} -n velero \
  --type=merge -p '{"spec":{"accessMode":"ReadWrite"}}'
```

### Volume Snapshot Locations (VSL)

```yaml
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-primary
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
---
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-dr
  namespace: velero
spec:
  provider: aws
  config:
    region: us-west-2
```

---

## Section 3: Resource Filtering

Velero's filtering system determines what gets included in or excluded from a backup.

### Include/Exclude Namespaces

```bash
# Backup specific namespaces
velero backup create production-apps \
  --include-namespaces production,staging \
  --ttl 720h

# Backup everything except kube-system and velero
velero backup create full-cluster \
  --exclude-namespaces kube-system,velero,monitoring \
  --ttl 168h

# Backup with label selector
velero backup create critical-workloads \
  --selector "backup-tier=critical" \
  --include-namespaces production \
  --ttl 720h
```

### Include/Exclude Resources

```bash
# Include only specific resource types
velero backup create configs-only \
  --include-resources configmaps,secrets,serviceaccounts \
  --include-namespaces production

# Exclude stateful resources (for config-only backup)
velero backup create stateless-backup \
  --exclude-resources persistentvolumeclaims,persistentvolumes

# Include cluster-scoped resources
velero backup create with-cluster-resources \
  --include-cluster-scoped-resources namespaces,clusterroles,clusterrolebindings,storageclasses,customresourcedefinitions
```

### Resource Annotations for Exclusion

```yaml
# Exclude a specific pod from backup (useful for ephemeral workloads)
apiVersion: v1
kind: Pod
metadata:
  name: batch-job
  namespace: production
  annotations:
    velero.io/exclude-from-backup: "true"
---
# Exclude a PVC from backup but include the pod
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: scratch-disk
  namespace: production
  annotations:
    velero.io/exclude-from-backup: "true"
```

### OrLabelSelector for Complex Filtering

```yaml
# backup-spec.yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: tier1-workloads
  namespace: velero
spec:
  includedNamespaces:
  - production
  - staging
  orLabelSelectors:
  - matchLabels:
      backup-tier: critical
  - matchExpressions:
    - key: app
      operator: In
      values: ["payment-service", "auth-service", "api-gateway"]
  excludedResources:
  - events
  - events.events.k8s.io
  - backups.velero.io
  - restores.velero.io
  ttl: 720h0m0s
  storageLocation: primary
  volumeSnapshotLocations:
  - aws-primary
```

---

## Section 4: Hook Annotations for Application-Consistent Backups

Hooks run commands inside containers before and after the volume snapshot, enabling database quiescing for consistent backups.

### PostgreSQL Pre/Post Hooks

```yaml
# postgres-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Pre-backup hook: checkpoint and freeze WAL
        pre.hook.backup.velero.io/container: postgres
        pre.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "psql -U postgres -c 'CHECKPOINT;' &&
            psql -U postgres -c 'SELECT pg_start_backup($$velero-backup$$, true);'"]
        pre.hook.backup.velero.io/timeout: 60s
        pre.hook.backup.velero.io/on-error: Fail

        # Post-backup hook: end backup mode
        post.hook.backup.velero.io/container: postgres
        post.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "psql -U postgres -c 'SELECT pg_stop_backup();'"]
        post.hook.backup.velero.io/timeout: 30s
        post.hook.backup.velero.io/on-error: Continue
    spec:
      containers:
      - name: postgres
        image: postgres:16
```

### MySQL InnoDB Consistent Backup

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: production
spec:
  template:
    metadata:
      annotations:
        pre.hook.backup.velero.io/container: mysql
        pre.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'FLUSH TABLES WITH READ LOCK; FLUSH LOGS;'"]
        pre.hook.backup.velero.io/timeout: 120s
        pre.hook.backup.velero.io/on-error: Fail

        post.hook.backup.velero.io/container: mysql
        post.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'UNLOCK TABLES;'"]
        post.hook.backup.velero.io/timeout: 60s
        post.hook.backup.velero.io/on-error: Continue
```

### Hooks via BackupSpec (Override annotations)

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: postgres-consistent
  namespace: velero
spec:
  includedNamespaces:
  - production
  labelSelector:
    matchLabels:
      app: postgres
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
          - /bin/bash
          - -c
          - "psql -U postgres -c 'CHECKPOINT;'"
          onError: Fail
          timeout: 60s
      post:
      - exec:
          container: postgres
          command:
          - /bin/bash
          - -c
          - "psql -U postgres -c 'SELECT 1;'"  # Verify recovery
          onError: Continue
          timeout: 30s
```

---

## Section 5: CSI Volume Snapshots

CSI snapshots provide consistent, storage-level point-in-time copies without requiring Restic/Kopia file-level backup.

### Prerequisites

```bash
# Install CSI snapshot CRDs and controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml

# Create VolumeSnapshotClass for your CSI driver
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-aws-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  tagSpecification_1: "Name=velero-snapshot"
EOF
```

### Enable CSI Snapshot Plugin

```bash
# Install Velero CSI plugin
velero plugin add velero/velero-plugin-for-csi:v0.7.0

# Verify plugin loaded
velero plugin get | grep csi

# Create backup using CSI snapshots
velero backup create csi-backup \
  --include-namespaces production \
  --snapshot-move-data=false \
  --csi-snapshot-timeout=10m
```

### Data Mover for Cross-Cluster CSI Snapshot Portability

```bash
# Enable data mover (copies CSI snapshot data to object storage)
velero install \
  --use-node-agent \
  --features=EnableCSIVolumeData

# Backup with data movement (copies snapshot data to S3)
velero backup create portable-csi-backup \
  --include-namespaces production \
  --snapshot-move-data=true \
  --uploader-type=kopia
```

---

## Section 6: Scheduled Backups

### Production Backup Schedule Strategy

```yaml
# schedules.yaml
---
# Hourly backups of critical stateful workloads (7 day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: critical-hourly
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    includedNamespaces:
    - production
    labelSelector:
      matchLabels:
        backup-tier: critical
    ttl: 168h0m0s
    storageLocation: primary
    snapshotVolumes: true
    hooks:
      resources:
      - name: db-hooks
        labelSelector:
          matchLabels:
            app.kubernetes.io/component: database
        pre:
        - exec:
            container: db
            command: ["/scripts/pre-backup.sh"]
            onError: Fail
            timeout: 120s
        post:
        - exec:
            container: db
            command: ["/scripts/post-backup.sh"]
            onError: Continue
            timeout: 60s
---
# Daily full namespace backup (30 day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    includedNamespaces:
    - production
    - staging
    excludedResources:
    - events
    - events.events.k8s.io
    ttl: 720h0m0s
    storageLocation: primary
    snapshotVolumes: true
---
# Weekly backup to DR site (90 day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-dr
  namespace: velero
spec:
  schedule: "0 3 * * 0"
  template:
    includedNamespaces:
    - production
    ttl: 2160h0m0s   # 90 days
    storageLocation: dr-west
    snapshotVolumes: false   # Use data mover instead for portability
    snapshotMoveData: true
---
# Cross-cloud offsite (180 day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: monthly-offsite
  namespace: velero
spec:
  schedule: "0 4 1 * *"
  template:
    includedNamespaces:
    - production
    ttl: 4380h0m0s   # 180 days
    storageLocation: offsite-azure
    snapshotVolumes: false
    snapshotMoveData: true
```

---

## Section 7: Cross-Cluster Restore

Restoring to a different cluster is the primary DR scenario. Key considerations:
- The target cluster must have Velero installed with access to the same BSL
- StorageClass names may differ between clusters
- Image registry addresses may need to change

### Configure Target Cluster to Read from BSL

```bash
# On the DR cluster, configure BSL pointing to source cluster's backups
kubectl apply -f - <<'EOF'
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: source-cluster
  namespace: velero
spec:
  provider: aws
  accessMode: ReadOnly   # Safety: don't allow writes from DR cluster
  objectStorage:
    bucket: velero-backups-us-east-1
    prefix: production
  config:
    region: us-east-1
  credential:
    name: cloud-credentials
    key: cloud
EOF

# Sync backups from source
velero backup get --storage-location source-cluster
```

### Restore with Resource Mapping

```bash
# List available backups
velero backup get

# Describe backup to understand contents
velero backup describe production-backup-20290621 --details

# Restore to different namespace
velero restore create \
  --from-backup production-backup-20290621 \
  --namespace-mappings production:production-dr \
  --restore-volumes

# Restore with StorageClass substitution
velero restore create \
  --from-backup production-backup-20290621 \
  --include-namespaces production \
  --restore-volumes \
  --override-annotations "storageClassName=gp3"
```

### StorageClass Mapping via ConfigMap

```yaml
# storage-class-mapping.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storage-class-config
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  gp2: gp3              # Map old class to new
  standard: premium-ssd  # Map standard to premium in DR
  nfs-storage: ebs-csi   # Map NFS to EBS in DR
```

### Full DR Restore Script

```bash
#!/bin/bash
# dr-restore.sh — Full cluster DR restore procedure
set -euo pipefail

BACKUP_NAME="${1:?Usage: $0 <backup-name>}"
TARGET_NAMESPACE="${2:-production}"
DRY_RUN="${3:-false}"

echo "=== DR Restore Procedure ==="
echo "Backup: $BACKUP_NAME"
echo "Target namespace: $TARGET_NAMESPACE"
echo "Dry run: $DRY_RUN"

# 1. Verify backup exists and is complete
STATUS=$(velero backup get "$BACKUP_NAME" -o json | jq -r '.status.phase')
if [ "$STATUS" != "Completed" ]; then
    echo "ERROR: Backup $BACKUP_NAME is in phase $STATUS, expected Completed"
    exit 1
fi

# 2. Check backup age
BACKUP_TIME=$(velero backup get "$BACKUP_NAME" -o json | jq -r '.metadata.creationTimestamp')
echo "Backup created at: $BACKUP_TIME"

# 3. Describe backup contents
velero backup describe "$BACKUP_NAME" --details

# 4. Perform restore (or dry-run)
RESTORE_NAME="dr-restore-$(date +%Y%m%d%H%M%S)"

if [ "$DRY_RUN" = "true" ]; then
    echo "DRY RUN — Would execute:"
    echo "velero restore create $RESTORE_NAME --from-backup $BACKUP_NAME --restore-volumes"
    exit 0
fi

velero restore create "$RESTORE_NAME" \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces "$TARGET_NAMESPACE" \
  --restore-volumes \
  --wait

# 5. Check restore status
STATUS=$(velero restore get "$RESTORE_NAME" -o json | jq -r '.status.phase')
WARNINGS=$(velero restore get "$RESTORE_NAME" -o json | jq '.status.warnings')
ERRORS=$(velero restore get "$RESTORE_NAME" -o json | jq '.status.errors')

echo ""
echo "=== Restore Results ==="
echo "Status: $STATUS"
echo "Warnings: $WARNINGS"
echo "Errors: $ERRORS"

if [ "$STATUS" != "Completed" ]; then
    echo "ERROR: Restore failed with status $STATUS"
    velero restore describe "$RESTORE_NAME" --details
    exit 1
fi

echo "Restore complete: $RESTORE_NAME"
```

---

## Section 8: Backup Validation

A backup that cannot be restored is worthless. Automated validation is a critical production practice.

### Validation Job

```yaml
# backup-validator.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-validator
  namespace: velero
spec:
  schedule: "0 6 * * 1"   # Weekly on Monday
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero
          restartPolicy: Never
          containers:
          - name: validator
            image: bitnami/kubectl:latest
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              LATEST_BACKUP=$(velero backup get -o json | \
                jq -r '[.items[] | select(.status.phase == "Completed")] |
                        sort_by(.metadata.creationTimestamp) | last | .metadata.name')

              echo "Validating backup: $LATEST_BACKUP"

              # Restore to validation namespace
              RESTORE_NAME="validation-$(date +%Y%m%d)"
              velero restore create "$RESTORE_NAME" \
                --from-backup "$LATEST_BACKUP" \
                --namespace-mappings production:backup-validation \
                --restore-volumes=false \
                --wait

              # Check restore status
              STATUS=$(velero restore get "$RESTORE_NAME" -o json | \
                jq -r '.status.phase')

              if [ "$STATUS" = "Completed" ]; then
                echo "SUCCESS: Restore validation passed"

                # Check expected resources exist
                DEPLOY_COUNT=$(kubectl get deployments -n backup-validation \
                  --no-headers 2>/dev/null | wc -l)
                echo "Deployments restored: $DEPLOY_COUNT"

                if [ "$DEPLOY_COUNT" -lt 5 ]; then
                  echo "WARNING: Expected at least 5 deployments, got $DEPLOY_COUNT"
                fi
              else
                echo "FAILURE: Restore validation failed with status $STATUS"
                exit 1
              fi

              # Cleanup validation namespace
              kubectl delete namespace backup-validation --ignore-not-found=true
              velero restore delete "$RESTORE_NAME" --confirm
```

### Monitoring Backup Health

```yaml
# velero-alerts.yaml — Prometheus alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: monitoring
spec:
  groups:
  - name: velero
    interval: 60s
    rules:
    - alert: VeleroBackupFailed
      expr: |
        velero_backup_failure_total > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero backup failed"
        description: "Velero backup {{ $labels.schedule }} has failed {{ $value }} time(s)"

    - alert: VeleroBackupMissing
      expr: |
        time() - velero_backup_last_successful_timestamp{schedule=~".+"} > 86400
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "No successful backup in 24 hours"
        description: "Schedule {{ $labels.schedule }} has not completed successfully in 24 hours"

    - alert: VeleroBackupStorageUnavailable
      expr: |
        velero_backup_storage_location_available == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Backup storage location unavailable"
        description: "Storage location {{ $labels.backuplocation }} is unavailable"

    - alert: VeleroNodeAgentDown
      expr: |
        kube_daemonset_status_number_available{daemonset="node-agent", namespace="velero"}
        / kube_daemonset_status_desired_number_scheduled{daemonset="node-agent", namespace="velero"} < 0.9
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Velero node agent DaemonSet degraded"
```

---

## Section 9: Backup Encryption

```bash
# Enable server-side encryption for BSL (AWS)
kubectl apply -f - <<'EOF'
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: encrypted-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-encrypted-backups
    prefix: production
  config:
    region: us-east-1
    serverSideEncryption: aws:kms
    kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/<KEY_ID>"
EOF
```

For client-side encryption with Kopia (data mover):

```yaml
# kopia encryption config via BackupRepository
apiVersion: velero.io/v1
kind: BackupRepository
metadata:
  name: production-kopia
  namespace: velero
spec:
  backupStorageLocation: primary
  repositoryType: kopia
  volumeNamespace: production
  maintenanceFrequency: 1h0m0s
```

Kopia encrypts all data with AES-256-GCM by default before upload, providing end-to-end encryption independent of the storage backend.

---

## Section 10: Troubleshooting Common Issues

```bash
# Check Velero server logs
kubectl logs deployment/velero -n velero --tail=100

# Check node-agent logs for volume backup issues
kubectl logs daemonset/node-agent -n velero --tail=100

# Describe a failed backup
velero backup describe my-backup --details

# Check backup object logs
velero backup logs my-backup | tail -50

# Describe a failed restore
velero restore describe my-restore --details
velero restore logs my-restore | grep -i error

# Fix stuck backup (delete and recreate)
kubectl delete backup my-backup -n velero
kubectl patch backup my-backup -n velero \
  -p '{"metadata":{"finalizers":null}}' \
  --type=merge

# Check if BSL is accessible
velero backup-location get
velero backup-location set primary --default

# Increase Velero server log level
kubectl set env deployment/velero -n velero \
  VELERO_OPTS="--log-level=debug"
```

Velero's value comes from its breadth of capabilities: CSI snapshots for storage-level consistency, hooks for application-level consistency, multiple storage locations for geographic redundancy, and restore automation for verified recoverability. The investment in setting up a complete backup strategy pays dividends the first time a production incident requires a restore.
