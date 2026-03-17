---
title: "Velero Disaster Recovery: Full Cluster Backup, CSI Snapshots, and Cross-Cluster Migration"
date: 2028-05-26T00:00:00-05:00
draft: false
tags: ["Velero", "Kubernetes", "Disaster Recovery", "Backup", "CSI", "Migration"]
categories: ["Kubernetes", "Operations", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Velero disaster recovery covering full cluster backup, selective namespace restore, cross-cluster migration, CSI volume snapshots, schedule policies, and restore testing procedures."
more_link: "yes"
url: "/kubernetes-velero-disaster-recovery-guide/"
---

Velero provides Kubernetes-native backup and restore capabilities that go beyond etcd snapshots. While etcd backups capture cluster state, Velero integrates with cloud provider snapshot APIs for persistent volume data, supports granular namespace-level restores, and enables complete cluster migrations across providers. This guide covers the full operational picture for running Velero in enterprise production environments.

<!--more-->

## Architecture Overview

Velero operates as a Kubernetes controller that watches for Backup and Restore custom resources. When a backup runs:

1. The Velero server serializes Kubernetes API objects to JSON
2. For persistent volumes, it either invokes CSI snapshot APIs or restic/kopia for file-level backup
3. Serialized objects and volume data are uploaded to object storage (S3, GCS, Azure Blob)

```
Kubernetes API Server
        ↓
  Velero Controller
    ↙         ↘
API Objects    Volume Data
    ↓              ↓
Object Storage  CSI Snapshot / Restic
(S3/GCS/Blob)   (+ copy to object storage)
```

Two volume backup methods are supported:

- **CSI Volume Snapshots**: Native snapshot API, fast, incremental-capable, cloud-provider dependent
- **File system backup (restic/kopia)**: Filesystem-level backup, provider-agnostic, slower but portable

## Installation

### Prerequisites

```bash
# Install Velero CLI
VERSION=v1.13.2
OS=linux
ARCH=amd64
curl -L "https://github.com/vmware-tanzu/velero/releases/download/${VERSION}/velero-${VERSION}-${OS}-${ARCH}.tar.gz" \
  | tar xzf - velero-${VERSION}-${OS}-${ARCH}/velero
sudo mv velero-${VERSION}-${OS}-${ARCH}/velero /usr/local/bin/
velero version --client-only

# Verify S3 bucket exists and is accessible
aws s3 ls s3://my-cluster-velero-backups --region us-east-1
```

### Install with AWS S3

```bash
# Create credentials file
cat > /tmp/velero-credentials <<EOF
[default]
aws_access_key_id=AKIAIOSFODNN7EXAMPLE
aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
EOF

velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-cluster-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --secret-file /tmp/velero-credentials \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --features=EnableCSI \
  --wait

shred -u /tmp/velero-credentials
```

For production, use IAM roles instead of static credentials:

```bash
# IAM role-based installation (IRSA on EKS)
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-cluster-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --no-secret \
  --sa-annotations eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/velero \
  --use-node-agent \
  --features=EnableCSI \
  --wait
```

### Required IAM Policy

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
      "Resource": [
        "arn:aws:s3:::my-cluster-velero-backups/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::my-cluster-velero-backups"
      ]
    }
  ]
}
```

### GCS Installation

```bash
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.9.0 \
  --bucket my-cluster-velero-gcs \
  --secret-file /tmp/gcp-service-account-key.json \
  --backup-location-config serviceAccount=velero@my-project.iam.gserviceaccount.com \
  --use-node-agent \
  --features=EnableCSI \
  --wait
```

## Backup Location Configuration

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
    bucket: my-cluster-velero-backups
    prefix: production-cluster
  config:
    region: us-east-1
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
    checksumAlgorithm: ""
  credential:
    name: cloud-credentials
    key: cloud
  accessMode: ReadWrite
  default: true
---
# Secondary location in different region
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: secondary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-backups-dr
    prefix: production-cluster
  config:
    region: us-west-2
    serverSideEncryption: aws:kms
  accessMode: ReadWrite
```

```bash
# Verify backup storage location is available
kubectl get backupstoragelocation -n velero
# NAME        PHASE       LAST VALIDATED   AGE   DEFAULT
# primary     Available   13s              2m    true
# secondary   Available   8s               1m    false
```

## CSI Snapshot Integration

### VolumeSnapshotClass Configuration

```yaml
# volumesnapshotclass-ebs.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-aws-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"  # Velero will use this class
driver: ebs.csi.aws.com
deletionPolicy: Retain  # Keep snapshots when VolumeSnapshot is deleted
parameters:
  type: gp3
---
# For GKE
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-gce-pd-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Retain
```

```bash
# Verify CSI snapshot controller is installed
kubectl get pods -n kube-system | grep snapshot-controller
# snapshot-controller-7f9c8b4c6-x9k2m   1/1   Running   0   5m

# Check VolumeSnapshotClasses
kubectl get volumesnapshotclass
# NAME              DRIVER             DELETIONPOLICY   AGE
# csi-aws-vsc       ebs.csi.aws.com    Retain           2m
```

## Creating Backups

### Full Cluster Backup

```bash
# Full cluster backup with all namespaces
velero backup create full-cluster-$(date +%Y%m%d-%H%M%S) \
  --include-cluster-resources=true \
  --storage-location primary \
  --snapshot-location default \
  --ttl 720h \
  --wait

# Check backup status
velero backup describe full-cluster-20240315-143022 --details
```

### Namespace-Selective Backup

```bash
# Backup specific namespaces
velero backup create production-apps-20240315 \
  --include-namespaces production,monitoring,logging \
  --exclude-resources secrets \
  --storage-location primary \
  --snapshot-move-data=true \
  --ttl 168h \
  --wait

# Backup excluding certain namespaces
velero backup create cluster-minus-test-20240315 \
  --exclude-namespaces test,development,ci \
  --include-cluster-resources=true \
  --ttl 720h
```

### Label-Based Backup

```bash
# Only backup resources with specific labels
velero backup create critical-services-20240315 \
  --selector "backup-tier=critical" \
  --include-cluster-resources=true \
  --ttl 720h
```

### Backup as Kubernetes Object

```yaml
# backup-production.yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: production-full-20240315
  namespace: velero
spec:
  includedNamespaces:
    - production
    - monitoring
    - logging
  excludedResources:
    - events
    - events.events.k8s.io
  includeClusterResources: true
  storageLocation: primary
  volumeSnapshotLocations:
    - default
  snapshotMoveData: false
  defaultVolumesToFsBackup: false
  ttl: 720h0m0s
  hooks:
    resources:
      - name: postgresql-quiesce
        includedNamespaces:
          - production
        labelSelector:
          matchLabels:
            app: postgresql
        pre:
          - exec:
              container: postgresql
              command:
                - /bin/bash
                - -c
                - psql -U postgres -c "CHECKPOINT;"
              onError: Fail
              timeout: 60s
```

## Scheduled Backups

```yaml
# schedule-daily-backup.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-production
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  template:
    includedNamespaces:
      - production
      - monitoring
    includeClusterResources: true
    storageLocation: primary
    ttl: 720h0m0s
    snapshotMoveData: false
    hooks:
      resources:
        - name: app-backup-hook
          includedNamespaces:
            - production
          labelSelector:
            matchLabels:
              backup-hook: "true"
          pre:
            - exec:
                container: app
                command: ["/scripts/pre-backup.sh"]
                onError: Continue
                timeout: 30s
          post:
            - exec:
                container: app
                command: ["/scripts/post-backup.sh"]
                onError: Continue
                timeout: 30s
  useOwnerReferencesInBackup: false
---
# Weekly full cluster backup with longer retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-full-cluster
  namespace: velero
spec:
  schedule: "0 1 * * 0"  # 1 AM every Sunday
  template:
    includeClusterResources: true
    storageLocation: primary
    snapshotMoveData: true  # Copy snapshot data to object storage for portability
    ttl: 2160h0m0s  # 90 days
---
# Hourly backup for critical stateful apps
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-databases
  namespace: velero
spec:
  schedule: "5 * * * *"
  template:
    includedNamespaces:
      - production
    labelSelector:
      matchLabels:
        backup-frequency: hourly
    storageLocation: primary
    ttl: 168h0m0s  # 7 days
```

```bash
# List schedules
kubectl get schedule -n velero
# NAME                    STATUS    SCHEDULE    BACKUP TTL   LAST BACKUP   AGE
# daily-production        Enabled   0 2 * * *   720h0m0s    2h ago        30d
# weekly-full-cluster     Enabled   0 1 * * 0   2160h0m0s   6d ago        30d
# hourly-databases        Enabled   5 * * * *   168h0m0s    55m ago       30d

# Trigger schedule manually
velero backup create --from-schedule daily-production
```

## Restore Operations

### Full Namespace Restore

```bash
# List available backups
velero backup get
# NAME                         STATUS      STARTED                   COMPLETED   EXPIRATION   STORAGE LOCATION
# full-cluster-20240315-143022 Completed   2024-03-15 14:30:22 UTC   14:31:45    2024-04-14   primary
# production-apps-20240315     Completed   2024-03-15 09:00:01 UTC   09:02:15    2024-03-22   primary

# Restore entire backup
velero restore create --from-backup full-cluster-20240315-143022 \
  --wait

# Check restore status
velero restore describe full-cluster-20240315-143022-20240316-083000 --details
```

### Selective Namespace Restore

```bash
# Restore only specific namespaces from a full backup
velero restore create production-restore-20240316 \
  --from-backup full-cluster-20240315-143022 \
  --include-namespaces production \
  --wait

# Restore with namespace remapping
velero restore create staging-from-production \
  --from-backup full-cluster-20240315-143022 \
  --include-namespaces production \
  --namespace-mappings production:staging-restored \
  --wait
```

### Selective Resource Restore

```bash
# Restore only ConfigMaps and Secrets
velero restore create config-restore-20240316 \
  --from-backup full-cluster-20240315-143022 \
  --include-namespaces production \
  --include-resources configmaps,secrets \
  --wait

# Restore a specific deployment
velero restore create orders-api-restore \
  --from-backup full-cluster-20240315-143022 \
  --include-namespaces production \
  --selector "app=orders-api" \
  --wait
```

### Restore as Kubernetes Object

```yaml
# restore-production.yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: production-full-restore-20240316
  namespace: velero
spec:
  backupName: full-cluster-20240315-143022
  includedNamespaces:
    - production
    - monitoring
  excludedResources:
    - nodes
    - events
    - events.events.k8s.io
    - backups.velero.io
    - restores.velero.io
    - resticrepositories.velero.io
  restorePVs: true
  preserveNodePorts: false
  includeClusterResources: true
  # Restore hooks for post-restore actions
  hooks:
    resources:
      - name: database-restore-hook
        includedNamespaces:
          - production
        labelSelector:
          matchLabels:
            app: postgresql
        postHooks:
          - exec:
              container: postgresql
              command:
                - /bin/bash
                - -c
                - psql -U postgres -f /scripts/post-restore.sql
              waitTimeout: 5m
              execTimeout: 5m
              onError: Continue
```

## Cross-Cluster Migration

Migrating a workload from one cluster to another is a three-phase operation:

### Phase 1: Backup on Source Cluster

```bash
# On source cluster

# Ensure snapshot data is moved to object storage (snapshotMoveData=true)
# This makes the backup portable across providers
velero backup create migration-batch-1 \
  --include-namespaces orders-service,payment-service \
  --include-cluster-resources=true \
  --snapshot-move-data=true \
  --storage-location primary \
  --ttl 168h \
  --wait

velero backup describe migration-batch-1 --details
# Verify: Phase: Completed
# Verify: CSI Volume Snapshots: 4 of 4 snapshots successfully completed
```

### Phase 2: Configure Target Cluster

```bash
# On target cluster

# Install Velero pointing to the SAME backup storage location
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-cluster-velero-backups \
  --backup-location-config region=us-east-1 \
  --no-secret \
  --sa-annotations eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/velero-target \
  --use-node-agent \
  --features=EnableCSI \
  --wait

# Sync backup metadata from object storage
velero backup-location get
# NAME      PHASE       LAST VALIDATED
# default   Available   10s

# Force sync to import backups from source cluster
velero backup sync

# Verify backup is visible
velero backup get | grep migration-batch-1
# migration-batch-1   Completed   2024-03-15 ...
```

### Phase 3: Restore on Target Cluster

```bash
# On target cluster

# Restore with any necessary resource transformations
velero restore create migration-batch-1-restore \
  --from-backup migration-batch-1 \
  --include-namespaces orders-service,payment-service \
  --restore-resource-priorities pods,services,deployments \
  --existing-resource-policy update \
  --wait

# Monitor restore progress
kubectl get restore -n velero migration-batch-1-restore -w

# Check for any warnings or errors
velero restore describe migration-batch-1-restore --details
velero restore logs migration-batch-1-restore | grep -E "level=error|level=warning"
```

### Post-Migration Verification

```bash
# Verify pods are running
kubectl get pods -n orders-service
kubectl get pods -n payment-service

# Verify PVCs are bound
kubectl get pvc -n orders-service
# NAME               STATUS   VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# orders-data        Bound    ...      100Gi      RWO            gp3            2m

# Verify services have correct endpoints
kubectl get endpoints -n orders-service

# Run application health checks
kubectl exec -n orders-service deploy/orders-api -- curl -s http://localhost:8080/health
```

## Volume Data Migration with Data Mover

Velero's data mover uses the Container Storage Interface Data Mover (VGDP) to copy volume data directly to object storage, enabling cross-provider migrations.

```yaml
# Configure data mover credentials
apiVersion: v1
kind: Secret
metadata:
  name: dm-credential
  namespace: velero
type: Opaque
stringData:
  credential: |
    [default]
    aws_access_key_id=AKIAIOSFODNN7EXAMPLE
    aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
---
# Data mover configuration
apiVersion: velero.io/v2alpha1
kind: DataUpload
metadata:
  name: test-data-upload
  namespace: velero
spec:
  snapshotType: CSI
  csiSnapshot:
    volumeSnapshot: pvc-snapshot-abc123
    volumeSnapshotClass: csi-aws-vsc
    storageClass: gp3
  sourceNamespace: production
  sourcePVC: orders-data
  backupStorageLocation: primary
  cancel: false
```

## Restore Testing Procedures

Regular restore testing is critical. A backup that has never been tested is not a backup.

### Automated Restore Test Script

```bash
#!/bin/bash
# restore-test.sh — Run in a dedicated test namespace

set -euo pipefail

BACKUP_NAME="${1:-$(velero backup get --output json | jq -r '.items[0].metadata.name')}"
TEST_NAMESPACE="restore-test-$(date +%s)"
TIMEOUT=600

log() { echo "[$(date +'%Y-%m-%dT%H:%M:%S')] $*"; }

# Create isolated test namespace
log "Creating test namespace: $TEST_NAMESPACE"
kubectl create namespace "$TEST_NAMESPACE"

# Perform restore with namespace remapping
log "Restoring backup $BACKUP_NAME into $TEST_NAMESPACE"
velero restore create "test-$(date +%s)" \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces production \
  --namespace-mappings "production:$TEST_NAMESPACE" \
  --restore-resource-priorities "persistentvolumeclaims,pods,deployments" \
  --wait

# Wait for pods to be ready
log "Waiting for pods to be ready"
DEADLINE=$(($(date +%s) + TIMEOUT))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  NOT_READY=$(kubectl get pods -n "$TEST_NAMESPACE" \
    --no-headers \
    -o custom-columns=STATUS:.status.phase \
    | grep -vc Running || true)

  if [[ $NOT_READY -eq 0 ]]; then
    log "All pods are running"
    break
  fi
  log "Waiting for $NOT_READY pods... ($(($DEADLINE - $(date +%s)))s remaining)"
  sleep 15
done

# Run health checks
log "Running application health checks"
FAILED=0
for deploy in $(kubectl get deploy -n "$TEST_NAMESPACE" -o name); do
  NAME=$(echo "$deploy" | cut -d/ -f2)
  if ! kubectl exec -n "$TEST_NAMESPACE" "deploy/$NAME" \
    -- curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    log "FAIL: $NAME health check failed"
    FAILED=$((FAILED + 1))
  else
    log "PASS: $NAME health check OK"
  fi
done

# Verify PVC data integrity
log "Checking PVC data checksums"
for pvc in $(kubectl get pvc -n "$TEST_NAMESPACE" -o name); do
  PVC_NAME=$(echo "$pvc" | cut -d/ -f2)
  CHECKSUM=$(kubectl exec -n "$TEST_NAMESPACE" \
    -l "pvc=$PVC_NAME" \
    -- sha256sum /data/.integrity_marker 2>/dev/null || echo "missing")
  log "PVC $PVC_NAME checksum: $CHECKSUM"
done

# Cleanup
log "Cleaning up test namespace"
kubectl delete namespace "$TEST_NAMESPACE" --grace-period=0 --force

if [[ $FAILED -gt 0 ]]; then
  log "RESTORE TEST FAILED: $FAILED health checks failed"
  exit 1
fi

log "RESTORE TEST PASSED"
```

### Monthly Restore Test Schedule

```yaml
# cronjob-restore-test.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: velero-restore-test
  namespace: velero
spec:
  schedule: "0 6 1 * *"  # First of each month at 6 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero-restore-tester
          containers:
            - name: restore-tester
              image: bitnami/kubectl:1.29
              command: ["/scripts/restore-test.sh"]
              env:
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: alerting-secrets
                      key: slack-webhook
          restartPolicy: Never
```

## Monitoring Velero

```yaml
# servicemonitor-velero.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: velero
  namespace: velero
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: velero
  endpoints:
    - port: monitoring
      interval: 30s
```

### Key Prometheus Alerts

```yaml
# velero-alerts.yaml
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
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failed"
            description: "{{ $labels.schedule }} backup has failed. Check velero logs."

        - alert: VeleroBackupPartialFailure
          expr: |
            velero_backup_partial_failure_total > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Velero backup partially failed"

        - alert: VeleroBackupStorageNotAvailable
          expr: |
            velero_backup_storage_location_available == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup storage location unavailable"
            description: "Storage location {{ $labels.backup_storage_location }} is not available."

        - alert: VeleroBackupMissing
          expr: |
            (time() - velero_backup_last_successful_timestamp{schedule="daily-production"}) > 86400 * 1.5
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "Velero daily backup not completed in 36 hours"

        - alert: VeleroRestoreFailed
          expr: |
            velero_restore_failed_total > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Velero restore operation failed"
```

## Backup Encryption

```yaml
# encryption-config for sensitive backup data
apiVersion: v1
kind: ConfigMap
metadata:
  name: velero-restic-config
  namespace: velero
data:
  # Configure restic/kopia repository with encryption
  repositoryType: kopia
---
# The encryption key is set via the VELERO_ENCRYPT_KEY environment variable
# or through a Kubernetes secret reference
apiVersion: v1
kind: Secret
metadata:
  name: velero-encryption-key
  namespace: velero
type: Opaque
stringData:
  # Use a 256-bit key generated with: openssl rand -base64 32
  key: "dGhpcyBpcyBhIDMyLWJ5dGUgZW5jcnlwdGlvbiBrZXkhISE="
```

## Backup Validation

```bash
# Validate backup consistency
velero backup describe production-apps-20240315 --details

# Check for any validation warnings
velero backup logs production-apps-20240315 | grep -E "level=warning|level=error"

# Verify all expected resources were captured
velero backup describe production-apps-20240315 | grep "Resource List"

# Count resources by type in the backup
velero backup describe production-apps-20240315 --details | \
  grep -E "^\s+[a-z]" | \
  awk '{print $1}' | \
  sort | uniq -c | sort -rn | head -20
```

## Disaster Recovery Runbook

### RTO/RPO Planning

| Scenario | RPO | RTO | Backup Strategy |
|----------|-----|-----|-----------------|
| Single namespace failure | 1 hour | 30 min | Hourly schedule |
| Full cluster failure | 24 hours | 2 hours | Daily schedule with CSI snapshots |
| Region failure | 24 hours | 4 hours | Cross-region backup sync |
| Complete data corruption | 7 days | 8 hours | Weekly full with data mover |

### Cluster Recovery Checklist

```bash
#!/bin/bash
# dr-checklist.sh

echo "=== DISASTER RECOVERY CHECKLIST ==="
echo ""
echo "1. New cluster provisioned and kubectl configured: [ ]"
echo "2. Velero installed on new cluster: [ ]"
echo "3. Backup storage location validated: [ ]"
echo ""

# Auto-check backup visibility
echo "Checking backup visibility..."
velero backup get | grep Completed | head -5

echo ""
echo "4. Select backup to restore from above list: [ ]"
echo "5. Run restore command: [ ]"
echo "   velero restore create dr-restore-\$(date +%s) --from-backup <BACKUP_NAME> --wait"
echo ""
echo "6. Verify all pods running: [ ]"
echo "   kubectl get pods --all-namespaces | grep -v Running | grep -v Completed"
echo ""
echo "7. Verify PVCs bound: [ ]"
echo "   kubectl get pvc --all-namespaces | grep -v Bound"
echo ""
echo "8. Run application smoke tests: [ ]"
echo "9. Update DNS/load balancer to point to new cluster: [ ]"
echo "10. Notify stakeholders of recovery completion: [ ]"
```

## Summary

Velero provides the foundation for Kubernetes disaster recovery across all major cloud providers. The key operational practices:

- Enable CSI snapshot integration for fast, incremental volume backups
- Use `snapshotMoveData=true` for cross-cluster migration scenarios where the target may lack access to the source cloud's snapshot API
- Schedule backups at multiple frequencies based on workload criticality
- Test restores monthly in isolated namespaces — automated restore tests catch configuration drift
- Monitor backup freshness and storage availability with Prometheus alerts
- Maintain separate backup storage in a second region for regional failure scenarios
- Use pre/post hooks to coordinate application-consistent backups with stateful workloads
