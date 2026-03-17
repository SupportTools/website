---
title: "Velero Kubernetes Backup: Disaster Recovery and Cross-Cluster Migration"
date: 2028-09-27T00:00:00-05:00
draft: false
tags: ["Velero", "Kubernetes", "Backup", "Disaster Recovery", "Storage"]
categories:
- Velero
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete Velero Kubernetes backup guide covering BackupStorageLocation with S3/GCS/Azure, VolumeSnapshotLocation, scheduled backups, namespace and cluster-scoped backups, backup hooks, restore ordering, cross-cluster migration, backup encryption, and testing restore procedures."
more_link: "yes"
url: "/kubernetes-velero-backup-disaster-recovery-guide/"
---

A Kubernetes cluster without a tested backup and restore procedure is a liability waiting to materialize. Velero provides namespace-level and cluster-scoped backups of Kubernetes resources, integrates with cloud provider snapshot APIs for persistent volume backup, and supports cross-cluster migration as a first-class use case.

This guide covers Velero installation, backup storage configuration, scheduled backups, backup hooks for application consistency, restore procedures, and the cross-cluster migration workflow.

<!--more-->

# Velero Kubernetes Backup: Disaster Recovery and Cross-Cluster Migration

## Architecture Overview

Velero consists of:

1. **Velero server** — Kubernetes Deployment that processes backups and restores
2. **Restic/Kopia integration** — agent for file-level volume backup (no snapshot API required)
3. **BackupStorageLocation (BSL)** — S3/GCS/Azure bucket where backup tarballs are stored
4. **VolumeSnapshotLocation (VSL)** — cloud provider snapshot API configuration
5. **Schedule CRDs** — cron-based automatic backups
6. **Backup/Restore CRDs** — representing individual backup and restore operations

## Installation

### AWS S3 Backend

```bash
# Install the Velero CLI
VELERO_VERSION="v1.14.0"
curl -L "https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-amd64.tar.gz" | tar xz
sudo mv velero-${VELERO_VERSION}-linux-amd64/velero /usr/local/bin/

# Create S3 bucket for backups
BUCKET_NAME="my-cluster-velero-backups"
REGION="us-east-1"

aws s3 mb "s3://${BUCKET_NAME}" --region "${REGION}"

# Enable versioning on the bucket
aws s3api put-bucket-versioning \
  --bucket "${BUCKET_NAME}" \
  --versioning-configuration Status=Enabled

# Enable server-side encryption
aws s3api put-bucket-encryption \
  --bucket "${BUCKET_NAME}" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:us-east-1:123456789012:key/my-key-id"
      }
    }]
  }'

# Create IAM policy for Velero
cat > velero-policy.json <<'EOF'
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
            "Resource": ["arn:aws:s3:::my-cluster-velero-backups/*"]
        },
        {
            "Effect": "Allow",
            "Action": ["s3:ListBucket"],
            "Resource": ["arn:aws:s3:::my-cluster-velero-backups"]
        }
    ]
}
EOF

aws iam create-policy \
  --policy-name VeleroBackupPolicy \
  --policy-document file://velero-policy.json

# Create IAM role for IRSA (if using EKS)
# Or create an IAM user and store credentials as a secret
aws iam create-user --user-name velero
aws iam attach-user-policy \
  --user-name velero \
  --policy-arn arn:aws:iam::123456789012:policy/VeleroBackupPolicy

aws iam create-access-key --user-name velero > velero-credentials.json

# Create the credentials file
cat > credentials-velero <<EOF
[default]
aws_access_key_id=$(jq -r '.AccessKey.AccessKeyId' velero-credentials.json)
aws_secret_access_key=$(jq -r '.AccessKey.SecretAccessKey' velero-credentials.json)
EOF

# Install Velero with AWS plugin
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket "${BUCKET_NAME}" \
  --backup-location-config "region=${REGION}" \
  --snapshot-location-config "region=${REGION}" \
  --secret-file ./credentials-velero \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --namespace velero \
  --wait
```

### GCS Backend

```bash
# Create GCS bucket
PROJECT_ID="my-gcp-project"
BUCKET_NAME="my-cluster-velero-backups"

gsutil mb -p "${PROJECT_ID}" -l US-CENTRAL1 "gs://${BUCKET_NAME}"
gsutil versioning set on "gs://${BUCKET_NAME}"

# Create service account
gcloud iam service-accounts create velero \
  --display-name "Velero backup service account" \
  --project "${PROJECT_ID}"

# Grant permissions
gsutil iam ch \
  "serviceAccount:velero@${PROJECT_ID}.iam.gserviceaccount.com:objectAdmin" \
  "gs://${BUCKET_NAME}"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:velero@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role "roles/compute.storageAdmin"

# Create and download key
gcloud iam service-accounts keys create credentials-velero \
  --iam-account "velero@${PROJECT_ID}.iam.gserviceaccount.com"

# Install Velero with GCP plugin
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.10.0 \
  --bucket "${BUCKET_NAME}" \
  --secret-file ./credentials-velero \
  --use-node-agent \
  --namespace velero \
  --wait
```

### Helm Installation (Alternative)

```yaml
# velero-values.yaml
configuration:
  backupStorageLocation:
    - name: aws-primary
      provider: aws
      bucket: my-cluster-velero-backups
      config:
        region: us-east-1
        s3ForcePathStyle: "false"
        s3Url: ""  # Use default S3 endpoint

  volumeSnapshotLocation:
    - name: aws-primary
      provider: aws
      config:
        region: us-east-1

  defaultBackupStorageLocation: aws-primary
  defaultVolumeSnapshotLocations: aws:aws-primary

credentials:
  useSecret: true
  existingSecret: velero-credentials

initContainers:
  - name: velero-plugin-for-aws
    image: velero/velero-plugin-for-aws:v1.10.0
    volumeMounts:
      - mountPath: /target
        name: plugins

nodeAgent:
  enabled: true
  podVolumePath: /var/lib/kubelet/pods
  privileged: false
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1
      memory: 1Gi

resources:
  requests:
    cpu: 500m
    memory: 128Mi
  limits:
    cpu: 1
    memory: 512Mi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    additionalLabels:
      release: prometheus
```

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm repo update

# Create credentials secret
kubectl create secret generic velero-credentials \
  --namespace velero \
  --from-file=cloud=./credentials-velero

helm install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --version 7.0.0 \
  --values velero-values.yaml
```

## Configuring Multiple Backup Storage Locations

```yaml
# backup-storage-locations.yaml
# Primary: AWS S3
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-backups-primary
    prefix: cluster-1
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
  credential:
    name: aws-credentials
    key: cloud
  default: true
  accessMode: ReadWrite

---
# Secondary: different region for disaster recovery
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-dr
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-backups-dr
    prefix: cluster-1
  config:
    region: us-west-2
  credential:
    name: aws-credentials-dr
    key: cloud
  accessMode: ReadWrite
```

## Scheduled Backups

```yaml
# velero-schedules.yaml
# Daily full cluster backup
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM UTC daily
  template:
    ttl: 720h              # Keep for 30 days
    storageLocation: aws-primary
    includeClusterResources: true
    includedNamespaces:
      - "*"               # All namespaces
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
      - velero
    excludedResources:
      - nodes
      - events
      - events.events.k8s.io
      - backups.velero.io
      - restores.velero.io
      - resticrepositories.velero.io
    snapshotVolumes: true
    storageLocation: aws-primary
    volumeSnapshotLocations:
      - aws-primary
    metadata:
      labels:
        backup-type: full
        environment: production

---
# Hourly namespace backup for critical namespaces
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-critical-namespaces
  namespace: velero
spec:
  schedule: "0 * * * *"  # Every hour
  useOwnerReferencesInBackup: false
  template:
    ttl: 168h             # Keep for 7 days
    storageLocation: aws-primary
    includedNamespaces:
      - payments
      - orders
      - customer-data
    snapshotVolumes: true
    volumeSnapshotLocations:
      - aws-primary
    metadata:
      labels:
        backup-type: critical-namespaces

---
# Weekly backup to DR region
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-dr-backup
  namespace: velero
spec:
  schedule: "0 3 * * 0"  # 3 AM UTC every Sunday
  template:
    ttl: 2160h             # Keep for 90 days
    storageLocation: aws-dr
    includeClusterResources: true
    snapshotVolumes: false  # No volume snapshots to DR (replicate separately)
    metadata:
      labels:
        backup-type: dr
```

## Backup Hooks for Application Consistency

Backup hooks run commands inside containers before and after snapshot to quiesce application state.

```yaml
# backup-with-hooks.yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: postgres-consistent-backup
  namespace: velero
spec:
  includedNamespaces:
    - database
  snapshotVolumes: true
  storageLocation: aws-primary
  hooks:
    resources:
      # Pre-backup: quiesce the database
      - name: postgres-freeze
        includedNamespaces:
          - database
        labelSelector:
          matchLabels:
            app: postgres
        pre:
          - exec:
              container: postgres
              command:
                - /bin/bash
                - -c
                - |
                  psql -U postgres -c "SELECT pg_start_backup('velero-backup', true);"
              onError: Fail
              timeout: 30s
        post:
          - exec:
              container: postgres
              command:
                - /bin/bash
                - -c
                - |
                  psql -U postgres -c "SELECT pg_stop_backup();"
              onError: Continue
              timeout: 30s

      # Pre-backup: flush Redis to disk
      - name: redis-flush
        includedNamespaces:
          - database
        labelSelector:
          matchLabels:
            app: redis
        pre:
          - exec:
              container: redis
              command:
                - /bin/sh
                - -c
                - redis-cli BGSAVE && sleep 2
              onError: Fail
              timeout: 60s
```

## Annotation-Based Hooks

Alternatively, add hooks via pod annotations so application teams control them:

```yaml
# Deployment with backup hooks via annotations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: database
spec:
  template:
    metadata:
      annotations:
        # Pre-backup hook: flush tables
        pre.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c",
           "mysqladmin -u root -p${MYSQL_ROOT_PASSWORD} flush-tables"]
        pre.hook.backup.velero.io/timeout: "60s"
        pre.hook.backup.velero.io/on-error: "Fail"

        # Post-backup hook: log completion
        post.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c", "echo 'Backup complete at $(date)'"]
        post.hook.backup.velero.io/timeout: "30s"
        post.hook.backup.velero.io/on-error: "Continue"
    spec:
      containers:
        - name: mysql
          image: mysql:8.0
```

## Namespace-Scoped Backups

```bash
# Backup a single namespace
velero backup create payments-backup \
  --include-namespaces payments \
  --snapshot-volumes \
  --storage-location aws-primary \
  --ttl 168h \
  --wait

# Backup multiple specific namespaces
velero backup create app-tier-backup \
  --include-namespaces "payments,orders,inventory" \
  --exclude-resources "events,events.events.k8s.io" \
  --snapshot-volumes \
  --wait

# Check backup status
velero backup get
velero backup describe payments-backup --details

# View backup logs
velero backup logs payments-backup
```

## Cluster-Scoped Resources

```bash
# Backup cluster-scoped resources (CRDs, ClusterRoles, etc.)
velero backup create cluster-resources-backup \
  --include-cluster-resources=true \
  --include-namespaces "" \
  --snapshot-volumes=false \
  --wait

# Backup everything including cluster-scoped
velero backup create full-cluster-backup \
  --include-cluster-resources=true \
  --include-namespaces="*" \
  --snapshot-volumes \
  --wait
```

## Restore Operations

### Basic Namespace Restore

```bash
# List available backups
velero backup get

# Restore a namespace from backup
velero restore create \
  --from-backup payments-backup \
  --include-namespaces payments \
  --wait

# Restore with namespace remapping (restore to a different namespace)
velero restore create \
  --from-backup payments-backup \
  --namespace-mappings "payments:payments-restore" \
  --wait

# Check restore status
velero restore get
velero restore describe payments-backup-restore --details

# View restore logs
velero restore logs payments-backup-restore
```

### Selective Resource Restore

```bash
# Restore only ConfigMaps and Secrets (no deployments)
velero restore create \
  --from-backup full-cluster-backup \
  --include-resources "configmaps,secrets" \
  --include-namespaces payments \
  --wait

# Restore a specific resource by name
velero restore create \
  --from-backup full-cluster-backup \
  --include-resources "deployments" \
  --selector "app=payment-service" \
  --include-namespaces payments \
  --wait

# Exclude resources from restore
velero restore create \
  --from-backup full-cluster-backup \
  --exclude-resources "events,events.events.k8s.io" \
  --wait
```

### Restore with Resource Modifications

Use a `RestoreItemAction` plugin or the `--existing-resource-policy` flag:

```yaml
# restore-with-modifications.yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: payments-restore-modified
  namespace: velero
spec:
  backupName: payments-backup
  includedNamespaces:
    - payments
  existingResourcePolicy: update  # update | none (default: none, skip existing)
  restorePVs: true
  preserveNodePorts: false         # Let Kubernetes assign new NodePorts
  namespaceMapping:
    payments: payments-v2
  # Exclude resources with specific labels (e.g., don't restore monitoring configs)
  labelSelector:
    matchExpressions:
      - key: do-not-restore
        operator: DoesNotExist
```

## Cross-Cluster Migration

Migration uses a shared BSL — both source and destination clusters access the same backup bucket.

### Migration Workflow

```bash
# === SOURCE CLUSTER ===

# 1. Create a migration backup (no TTL so it persists)
velero backup create migration-20250115 \
  --include-namespaces "payments,orders,inventory" \
  --include-cluster-resources=true \
  --snapshot-volumes \
  --storage-location aws-primary \
  --ttl 720h \
  --wait

# 2. Verify backup completeness
velero backup describe migration-20250115 --details

# 3. If using EBS volumes, wait for snapshots to complete
aws ec2 describe-snapshots \
  --filters "Name=tag:velero.io/backup,Values=migration-20250115" \
  --query 'Snapshots[*].{ID:SnapshotId,State:State}'


# === DESTINATION CLUSTER ===

# 4. Install Velero on destination cluster pointing to the SAME bucket
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket my-cluster-backups-primary \
  --prefix cluster-1 \
  --backup-location-config "region=us-east-1" \
  --snapshot-location-config "region=us-east-1" \
  --secret-file ./credentials-velero \
  --use-node-agent \
  --wait

# 5. Sync backup metadata from the bucket
velero backup-location get
# Velero discovers backups from the shared bucket

# 6. Restore the migration backup
velero restore create migration-restore \
  --from-backup migration-20250115 \
  --include-namespaces "payments,orders,inventory" \
  --include-cluster-resources=true \
  --wait

# 7. Verify the restore
velero restore describe migration-restore --details

# 8. Validate application health
kubectl get pods -n payments
kubectl get svc -n payments
```

### Cross-Region Volume Migration

EBS snapshots are region-specific. For cross-region migration, copy snapshots first:

```bash
# Get snapshot IDs from the backup
SNAPSHOT_IDS=$(velero backup describe migration-20250115 --details | \
  grep "Snapshot ID" | awk '{print $NF}')

# Copy snapshots to destination region
for SNAP_ID in $SNAPSHOT_IDS; do
  aws ec2 copy-snapshot \
    --source-region us-east-1 \
    --destination-region us-west-2 \
    --source-snapshot-id "$SNAP_ID" \
    --description "Velero migration copy"
done

# The restore will use the copied snapshots in the destination region
```

## Backup Encryption

```yaml
# Encrypt backups at the Velero level (in addition to S3 SSE)
# Install the velero-encryption-plugin (third-party)
# Or use client-side encryption with KMS

# BackupStorageLocation with KMS encryption config
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: aws-encrypted
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-encrypted-backups
    prefix: cluster-1
  config:
    region: us-east-1
    kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/my-kms-key-id"
    serverSideEncryption: "aws:kms"
    # Enforce encrypted uploads
    checksumAlgorithm: ""
```

## Testing Restore Procedures

A backup that has never been restored is not a backup — it is hope. Automate restore testing:

```bash
#!/bin/bash
# restore-test.sh — Run from a CI pipeline or on a schedule

set -euo pipefail

BACKUP_NAME="daily-full-backup-$(date +%Y%m%d)"
TEST_NAMESPACE_SUFFIX="-restore-test-$(date +%Y%m%d%H%M)"
TEST_NAMESPACES="payments orders"

echo "=== Starting restore test for ${BACKUP_NAME} ==="

# Wait for backup to exist
MAX_WAIT=300
ELAPSED=0
while ! velero backup get "${BACKUP_NAME}" &>/dev/null; do
  if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo "ERROR: Backup ${BACKUP_NAME} not found after ${MAX_WAIT}s"
    exit 1
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

# Check backup status
STATUS=$(velero backup get "${BACKUP_NAME}" -o json | jq -r '.status.phase')
if [ "$STATUS" != "Completed" ]; then
  echo "ERROR: Backup status is ${STATUS}, expected Completed"
  exit 1
fi

echo "Backup ${BACKUP_NAME} is complete. Starting restore test..."

# Build namespace mapping (restore to test namespaces)
NS_MAPPING=""
for NS in $TEST_NAMESPACES; do
  NS_MAPPING="${NS_MAPPING}${NS}:${NS}${TEST_NAMESPACE_SUFFIX},"
done
NS_MAPPING="${NS_MAPPING%,}"

RESTORE_NAME="restore-test-$(date +%Y%m%d%H%M)"

# Execute restore
velero restore create "${RESTORE_NAME}" \
  --from-backup "${BACKUP_NAME}" \
  --namespace-mappings "${NS_MAPPING}" \
  --wait

# Check restore status
RESTORE_STATUS=$(velero restore get "${RESTORE_NAME}" -o json | jq -r '.status.phase')
if [ "$RESTORE_STATUS" != "Completed" ]; then
  echo "ERROR: Restore status is ${RESTORE_STATUS}"
  velero restore describe "${RESTORE_NAME}" --details
  exit 1
fi

echo "Restore completed. Validating restored resources..."

# Validate restored resources are healthy
for NS in $TEST_NAMESPACES; do
  TEST_NS="${NS}${TEST_NAMESPACE_SUFFIX}"
  echo "Checking namespace: ${TEST_NS}"

  # Wait for pods to be running
  kubectl wait pod \
    --namespace "${TEST_NS}" \
    --all \
    --for=condition=Ready \
    --timeout=300s || {
    echo "ERROR: Pods in ${TEST_NS} did not become ready"
    kubectl get pods -n "${TEST_NS}"
    exit 1
  }

  POD_COUNT=$(kubectl get pods -n "${TEST_NS}" --no-headers | wc -l)
  echo "  ${POD_COUNT} pods running in ${TEST_NS}"
done

echo "=== Restore test PASSED ==="

# Cleanup test namespaces
for NS in $TEST_NAMESPACES; do
  TEST_NS="${NS}${TEST_NAMESPACE_SUFFIX}"
  kubectl delete namespace "${TEST_NS}" --wait=false
  echo "Scheduled deletion of ${TEST_NS}"
done

# Delete the restore object
velero restore delete "${RESTORE_NAME}" --confirm

echo "=== Test cleanup complete ==="
```

## Monitoring and Alerting

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: velero
  labels:
    release: prometheus
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
            description: "{{ $labels.schedule }} backup has failed {{ $value }} times"

        - alert: VeleroBackupNotTaken
          expr: |
            time() - velero_backup_last_successful_timestamp{schedule="daily-full-backup"} > 86400
          for: 30m
          labels:
            severity: critical
          annotations:
            summary: "No successful daily backup in 24 hours"

        - alert: VeleroBackupStorageNotAvailable
          expr: |
            velero_backup_storage_location_info{available="false"} == 1
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup storage location unavailable"
            description: "BSL {{ $labels.backup_storage_location }} is not available"

        - alert: VeleroNodeAgentDown
          expr: |
            kube_daemonset_status_number_ready{namespace="velero", daemonset="node-agent"}
            < kube_daemonset_status_desired_number_scheduled{namespace="velero", daemonset="node-agent"}
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Velero node agent pods not fully ready"
```

```bash
# Check Velero metrics
kubectl port-forward -n velero svc/velero 8085:8085 &
curl http://localhost:8085/metrics | grep velero_backup

# Key metrics to monitor:
# velero_backup_total
# velero_backup_failure_total
# velero_backup_success_total
# velero_backup_last_successful_timestamp
# velero_restore_total
# velero_restore_failed_total
# velero_backup_storage_location_info
```

## Summary

Velero provides a complete Kubernetes backup and restore capability with minimal operational overhead. Key operational patterns:

- **BackupStorageLocation** with S3 SSE-KMS for at-rest encryption; never store backups in the same account as the cluster without cross-account access controls
- **Scheduled backups** with appropriate TTLs: hourly for critical namespaces (7-day retention), daily for full cluster (30-day retention), weekly to a DR region (90-day retention)
- **Backup hooks** for application consistency; always quiesce databases and caches before snapshotting their volumes
- **Test restores automatically** — pipe restore tests into your CI pipeline or run them on a schedule; untested restores are not real backups
- **Cross-cluster migration** requires a shared BSL; volume snapshots must be copied to the destination region before restore when migrating across regions
- **Monitoring**: alert on backup failures and on the absence of a successful backup within the expected window
