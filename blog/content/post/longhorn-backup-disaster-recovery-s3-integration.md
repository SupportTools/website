---
title: "Longhorn Backup and Disaster Recovery: S3-Compatible Storage Integration"
date: 2029-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Backup", "Disaster Recovery", "S3"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to configuring Longhorn backup targets with S3-compatible object storage, automating recurring backups, implementing disaster recovery procedures, and restoring workloads across clusters."
more_link: "yes"
url: "/longhorn-backup-disaster-recovery-s3-integration/"
---

Longhorn's distributed block storage provides persistent volumes for stateful Kubernetes workloads, but local redundancy alone is insufficient for disaster recovery. When an entire cluster fails, or when data needs to be migrated to a different region or provider, backup data stored in external S3-compatible object storage becomes the only recovery path.

This guide covers the complete backup and disaster recovery workflow for Longhorn: configuring S3 backup targets, creating recurring backup schedules, restoring individual volumes, and performing full cluster disaster recovery procedures for enterprise environments.

<!--more-->

## Longhorn Backup Architecture

Longhorn implements backups as incremental snapshots of volume data stored in an external backup target. The backup process works as follows:

1. Longhorn takes a volume snapshot on the source cluster node
2. The backup controller reads changed blocks since the last backup (using a backup increment bitmap)
3. Changed blocks are compressed, chunked, and uploaded to the backup target
4. A backup manifest records the chunk locations, allowing future restores

This architecture enables space-efficient incremental backups while maintaining the ability to restore to any prior backup point without storing full copies.

### Supported Backup Targets

Longhorn supports the following backup target types:

- **S3**: AWS S3, MinIO, Ceph RGW, Backblaze B2, Wasabi, or any S3-compatible endpoint
- **NFS**: NFS v4 shares (useful for on-premises environments)

S3 is recommended for production due to its geographic redundancy options, versioning support, and lifecycle management capabilities.

## Configuring S3 Backup Targets

### AWS S3 Bucket Setup

Create a dedicated S3 bucket with appropriate lifecycle policies:

```bash
# Create the backup bucket
aws s3api create-bucket \
  --bucket k8s-longhorn-backups-prod \
  --region us-east-1

# Enable versioning for additional data protection
aws s3api put-bucket-versioning \
  --bucket k8s-longhorn-backups-prod \
  --versioning-configuration Status=Enabled

# Apply lifecycle policy to transition old backups to cheaper storage
cat > lifecycle-policy.json << 'EOF'
{
  "Rules": [
    {
      "ID": "longhorn-backup-lifecycle",
      "Status": "Enabled",
      "Filter": {"Prefix": "backupstore/"},
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER_IR"
        }
      ],
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 7
      }
    }
  ]
}
EOF
aws s3api put-bucket-lifecycle-configuration \
  --bucket k8s-longhorn-backups-prod \
  --lifecycle-configuration file://lifecycle-policy.json

# Create IAM policy for Longhorn
cat > longhorn-s3-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::k8s-longhorn-backups-prod",
        "arn:aws:s3:::k8s-longhorn-backups-prod/*"
      ]
    }
  ]
}
EOF
aws iam create-policy \
  --policy-name LonghornBackupPolicy \
  --policy-document file://longhorn-s3-policy.json
```

### MinIO Setup (On-Premises)

For air-gapped or on-premises environments, MinIO provides S3-compatible object storage:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: minio-system
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: minio
  namespace: minio-system
spec:
  serviceName: minio
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
        - name: minio
          image: quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z
          args:
            - server
            - /data
            - --console-address
            - ":9001"
          env:
            - name: MINIO_ROOT_USER
              valueFrom:
                secretKeyRef:
                  name: minio-credentials
                  key: root-user
            - name: MINIO_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: minio-credentials
                  key: root-password
          ports:
            - containerPort: 9000
              name: api
            - containerPort: 9001
              name: console
          volumeMounts:
            - name: data
              mountPath: /data
          livenessProbe:
            httpGet:
              path: /minio/health/live
              port: 9000
            initialDelaySeconds: 30
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 500Gi
```

### Creating the Backup Target Secret

Longhorn reads S3 credentials from a Kubernetes secret in the `longhorn-system` namespace:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-backup-target-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE"
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  AWS_DEFAULT_REGION: "us-east-1"
  # For MinIO or other S3-compatible endpoints:
  # AWS_ENDPOINTS: "https://minio.minio-system.svc.cluster.local:9000"
  # AWS_CERT: |
  #   -----BEGIN CERTIFICATE-----
  #   ... (CA certificate for TLS verification)
  #   -----END CERTIFICATE-----
```

For virtual-hosted-style bucket addressing (required for AWS, optional for MinIO):

```bash
# Verify MinIO bucket access with virtual-hosted style
mc alias set minio-prod https://minio.example.com AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI
mc mb minio-prod/longhorn-backups
mc ls minio-prod/longhorn-backups
```

### Configuring the Backup Target via Longhorn Settings

```yaml
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-target
  namespace: longhorn-system
value: "s3://k8s-longhorn-backups-prod@us-east-1/"
---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-target-credential-secret
  namespace: longhorn-system
value: "longhorn-backup-target-secret"
---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backupstore-poll-interval
  namespace: longhorn-system
value: "300"
```

Alternatively, configure via the Longhorn UI or Helm values:

```yaml
# In longhorn Helm chart values.yaml
defaultSettings:
  backupTarget: "s3://k8s-longhorn-backups-prod@us-east-1/"
  backupTargetCredentialSecret: "longhorn-backup-target-secret"
  backupstorePollInterval: 300
  allowRecurringJobWhileVolumeDetached: false
  concurrentAutomaticEngineUpgradePerNodeLimit: 1
```

## Recurring Backup Schedules

### RecurringJob Custom Resource

Longhorn 1.2+ uses the `RecurringJob` CRD for scheduling recurring snapshots and backups:

```yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 2 * * *"      # 2:00 AM UTC daily
  task: "backup"
  groups:
    - default
  retain: 14              # Keep 14 daily backups
  concurrency: 2          # Process 2 volumes simultaneously
  labels:
    backup-type: daily
    managed-by: longhorn
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot
  namespace: longhorn-system
spec:
  cron: "0 * * * *"      # Top of every hour
  task: "snapshot"
  groups:
    - default
  retain: 24              # Keep last 24 hourly snapshots
  concurrency: 4
  labels:
    snapshot-type: hourly
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: weekly-backup-critical
  namespace: longhorn-system
spec:
  cron: "0 3 * * 0"      # Sunday 3:00 AM UTC
  task: "backup"
  groups:
    - critical
  retain: 8               # Keep 8 weekly backups (2 months)
  concurrency: 1
```

### Assigning Volumes to Recurring Job Groups

Assign volumes to recurring job groups via PVC annotations:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgresql-data
  namespace: production
  annotations:
    longhorn.io/recurring-job-group.default: enabled
    longhorn.io/recurring-job.daily-backup: enabled
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 100Gi
```

For critical databases requiring both daily and weekly backups:

```bash
# Add a volume to multiple recurring job groups
kubectl -n production annotate pvc postgresql-data \
  "longhorn.io/recurring-job-group.critical=enabled" \
  "longhorn.io/recurring-job-group.default=enabled" \
  --overwrite
```

## Manual Backup Operations

### Creating an Ad-Hoc Backup

```bash
# Trigger a manual backup for a specific volume
kubectl -n longhorn-system create -f - <<EOF
apiVersion: longhorn.io/v1beta2
kind: Backup
metadata:
  name: postgresql-data-manual-$(date +%Y%m%d-%H%M%S)
  namespace: longhorn-system
spec:
  snapshotName: ""    # Empty means create a new snapshot
  labels:
    trigger: manual
    operator: mmattox
  backupMode: ""      # incremental by default
EOF
```

### Listing Available Backups

```bash
# List all backups in the backup store
kubectl -n longhorn-system get backups

# Get details for a specific backup
kubectl -n longhorn-system get backup postgresql-data-backup-20241115-020000 -o yaml

# List backups via Longhorn CLI (longhorn-manager pod)
kubectl -n longhorn-system exec -it \
  $(kubectl -n longhorn-system get pod -l app=longhorn-manager -o jsonpath='{.items[0].metadata.name}') \
  -- longhorn-manager backup list --backup-target s3://k8s-longhorn-backups-prod@us-east-1/
```

## Restoring Volumes from Backup

### Restoring to the Same Cluster

```yaml
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: postgresql-data-restored
  namespace: longhorn-system
spec:
  fromBackup: "s3://k8s-longhorn-backups-prod@us-east-1/?backup=backup-postgresql-data-20241115020000&volume=postgresql-data"
  numberOfReplicas: 3
  size: "107374182400"   # 100Gi in bytes
  accessMode: rwo
  storageClassName: longhorn
  dataLocality: best-effort
  replicaAutoBalance: best-effort
```

After the volume is restored and reaches Running state, create a PV/PVC pair to bind it to a workload:

```bash
# Get the restored volume details
kubectl -n longhorn-system get volume postgresql-data-restored -o jsonpath='{.status.state}'

# Create a PV pointing to the restored volume
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgresql-data-restored-pv
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: longhorn
  csi:
    driver: driver.longhorn.io
    volumeHandle: postgresql-data-restored
    fsType: ext4
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgresql-data-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: longhorn
  volumeName: postgresql-data-restored-pv
EOF
```

## Cross-Cluster Disaster Recovery

### Full Cluster Recovery Procedure

When the source cluster is lost entirely, recovery proceeds on the destination cluster by pointing Longhorn at the same backup store:

```bash
# Step 1: Install Longhorn on the destination cluster
helm repo add longhorn https://charts.longhorn.io
helm repo update
helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --set defaultSettings.backupTarget="s3://k8s-longhorn-backups-prod@us-east-1/" \
  --set defaultSettings.backupTargetCredentialSecret="longhorn-backup-target-secret" \
  --version 1.7.2

# Step 2: Create the backup target credentials secret
kubectl -n longhorn-system create secret generic longhorn-backup-target-secret \
  --from-literal=AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE \
  --from-literal=AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  --from-literal=AWS_DEFAULT_REGION=us-east-1

# Step 3: Wait for Longhorn to sync the backup catalog
kubectl -n longhorn-system rollout status deployment/longhorn-manager --timeout=300s

# Step 4: List available backups from the backup store
kubectl -n longhorn-system get backupvolumes
```

### Automated DR Script

```bash
#!/usr/bin/env bash
# longhorn-dr-restore.sh: Restore all volumes from a Longhorn backup store
# Usage: ./longhorn-dr-restore.sh <backup-store-url> <namespace>

set -euo pipefail

BACKUP_STORE="${1:-s3://k8s-longhorn-backups-prod@us-east-1/}"
NAMESPACE="${2:-production}"
LONGHORN_NS="longhorn-system"
REPLICAS="${REPLICAS:-3}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Verify backup target is reachable
log "Verifying backup target connectivity..."
kubectl -n "${LONGHORN_NS}" get setting backup-target -o jsonpath='{.value}'
echo

# Get all backup volumes from the backup store
log "Discovering backup volumes in ${BACKUP_STORE}..."
BACKUP_VOLUMES=$(kubectl -n "${LONGHORN_NS}" get backupvolumes -o jsonpath='{.items[*].metadata.name}')

if [[ -z "${BACKUP_VOLUMES}" ]]; then
  log "ERROR: No backup volumes found. Check backup target configuration."
  exit 1
fi

log "Found backup volumes: ${BACKUP_VOLUMES}"

for VOLUME_NAME in ${BACKUP_VOLUMES}; do
  log "Processing volume: ${VOLUME_NAME}"

  # Get the latest backup for this volume
  LATEST_BACKUP=$(kubectl -n "${LONGHORN_NS}" get backups \
    --field-selector="spec.volumeName=${VOLUME_NAME}" \
    --sort-by='.metadata.creationTimestamp' \
    -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null || echo "")

  if [[ -z "${LATEST_BACKUP}" ]]; then
    log "WARNING: No backups found for volume ${VOLUME_NAME}, skipping"
    continue
  fi

  BACKUP_URL=$(kubectl -n "${LONGHORN_NS}" get backup "${LATEST_BACKUP}" \
    -o jsonpath='{.status.url}')
  VOLUME_SIZE=$(kubectl -n "${LONGHORN_NS}" get backup "${LATEST_BACKUP}" \
    -o jsonpath='{.status.size}')

  log "Restoring ${VOLUME_NAME} from backup ${LATEST_BACKUP} (${BACKUP_URL})"

  # Create the restored volume
  kubectl apply -f - <<EOF
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: ${VOLUME_NAME}
  namespace: ${LONGHORN_NS}
spec:
  fromBackup: "${BACKUP_URL}"
  numberOfReplicas: ${REPLICAS}
  size: "${VOLUME_SIZE}"
  accessMode: rwo
  storageClassName: longhorn
EOF

  # Wait for volume to become healthy
  log "Waiting for volume ${VOLUME_NAME} to become available..."
  timeout 600 bash -c "
    until kubectl -n ${LONGHORN_NS} get volume ${VOLUME_NAME} \
      -o jsonpath='{.status.state}' 2>/dev/null | grep -q 'detached\|attached'; do
      sleep 10
    done
  " || log "WARNING: Timeout waiting for ${VOLUME_NAME}"

  log "Volume ${VOLUME_NAME} restored successfully"
done

log "Disaster recovery restore complete"
```

## Backup Validation

Regularly validate that backups can be restored successfully:

```bash
#!/usr/bin/env bash
# validate-backup.sh: Test restore of a volume to confirm backup integrity

VOLUME_NAME="postgresql-data"
TEST_NAMESPACE="backup-validation"
LONGHORN_NS="longhorn-system"

# Get latest backup URL
LATEST_BACKUP_URL=$(kubectl -n "${LONGHORN_NS}" get backups \
  --sort-by='.metadata.creationTimestamp' \
  -o jsonpath='{.items[-1].status.url}')

echo "Testing restore from: ${LATEST_BACKUP_URL}"

# Create test namespace
kubectl create namespace "${TEST_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# Restore to test volume
kubectl -n "${LONGHORN_NS}" apply -f - <<EOF
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: ${VOLUME_NAME}-validation-$(date +%Y%m%d)
  namespace: ${LONGHORN_NS}
spec:
  fromBackup: "${LATEST_BACKUP_URL}"
  numberOfReplicas: 1
  size: "107374182400"
  accessMode: rwo
EOF

# Wait for restore
timeout 300 bash -c "
  until kubectl -n ${LONGHORN_NS} get volume ${VOLUME_NAME}-validation-$(date +%Y%m%d) \
    -o jsonpath='{.status.state}' | grep -q detached; do
    sleep 10
  done
"

echo "Backup validation successful - volume restored successfully"

# Cleanup
kubectl -n "${LONGHORN_NS}" delete volume "${VOLUME_NAME}-validation-$(date +%Y%m%d)"
kubectl delete namespace "${TEST_NAMESPACE}"
```

## Monitoring Backup Health

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-backup-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: longhorn.backup
      interval: 60s
      rules:
        - alert: LonghornBackupFailed
          expr: |
            longhorn_backup_state{state="Error"} > 0
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Longhorn backup failed"
            description: "Backup {{ $labels.backup }} for volume {{ $labels.volume }} has been in error state for 5 minutes."

        - alert: LonghornBackupTargetUnreachable
          expr: |
            longhorn_setting_value{setting="backup-target"} == 0
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn backup target unreachable"
            description: "Longhorn cannot reach the backup target. Check S3 credentials and network connectivity."

        - alert: LonghornVolumeNotBackedUp
          expr: |
            (time() - longhorn_volume_last_backup_at) > 86400 * 2
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Longhorn volume has not been backed up in 48 hours"
            description: "Volume {{ $labels.volume }} in namespace {{ $labels.namespace }} has not been backed up in the last 48 hours."

        - alert: LonghornBackupStorageUsageHigh
          expr: |
            longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes > 0.85
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn backup storage usage is high"
            description: "Storage node {{ $labels.node }} is using {{ $value | humanizePercentage }} of capacity."
```

## Performance Tuning

### Backup Throughput Optimization

```yaml
# Increase backup concurrency for faster completion
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-compression-method
  namespace: longhorn-system
value: "lz4"     # lz4 for speed, gz for compression ratio
---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: concurrent-volume-backup-restore-per-node-limit
  namespace: longhorn-system
value: "5"        # Increase from default 2 if node I/O allows
---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: v2-data-engine-log-level
  namespace: longhorn-system
value: "warn"     # Reduce log verbosity during bulk backup operations
```

### Network Bandwidth Limiting

To prevent backups from saturating cluster network during business hours:

```bash
# Apply tc (traffic control) on backup traffic during peak hours
# Run on each Longhorn manager node
tc qdisc add dev eth0 root handle 1: htb default 30
tc class add dev eth0 parent 1: classid 1:1 htb rate 1000mbit
tc class add dev eth0 parent 1:1 classid 1:10 htb rate 1000mbit ceil 1000mbit
tc class add dev eth0 parent 1:1 classid 1:30 htb rate 100mbit ceil 200mbit

# Schedule bandwidth reduction for business hours (9 AM - 6 PM)
echo "0 9 * * 1-5 root tc class change dev eth0 parent 1:1 classid 1:30 htb rate 50mbit ceil 100mbit" \
  >> /etc/cron.d/longhorn-backup-throttle
echo "0 18 * * 1-5 root tc class change dev eth0 parent 1:1 classid 1:30 htb rate 100mbit ceil 200mbit" \
  >> /etc/cron.d/longhorn-backup-throttle
```

## RPO and RTO Planning

For enterprise environments, define Recovery Point Objective (RPO) and Recovery Time Objective (RTO) targets and configure Longhorn accordingly:

| Tier | RPO | RTO | Backup Schedule | Retain Count | Storage Class |
|------|-----|-----|-----------------|--------------|---------------|
| Critical (databases) | 1 hour | 30 min | Hourly backup | 72 | S3 Standard |
| Important (app state) | 4 hours | 2 hours | 6-hourly backup | 28 | S3 Standard-IA |
| Standard (logs, temp) | 24 hours | 4 hours | Daily backup | 14 | S3 Standard-IA |
| Archive (compliance) | 24 hours | 48 hours | Weekly backup | 52 | S3 Glacier IR |

Achieve 1-hour RPO for critical volumes using the hourly RecurringJob pattern shown earlier, combined with Longhorn's incremental backup capability to minimize upload time.

## Summary

Longhorn's S3-compatible backup integration provides a complete data protection solution for Kubernetes stateful workloads. Key operational practices include:

- Configure dedicated S3 buckets with lifecycle policies to manage backup storage costs
- Use RecurringJob groups to assign different backup schedules based on data criticality
- Maintain separate credentials with least-privilege IAM policies
- Run quarterly DR drills using the automated restore script to validate backup integrity
- Monitor backup health with Prometheus alerting to detect failures before they become incidents
- Document and test cross-cluster recovery procedures before a disaster occurs
