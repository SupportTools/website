---
title: "Kubernetes Longhorn Backup and Restore: S3-Compatible Disaster Recovery"
date: 2030-12-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Longhorn", "Backup", "Disaster Recovery", "S3", "Storage", "Restore", "Rancher"]
categories:
- Kubernetes
- Storage
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Longhorn disaster recovery: configuring S3 and NFS backup targets, recurring backup schedules, volume restoration to same and different namespaces, backup compression and encryption, cross-cluster restore procedures, and complete disaster recovery runbooks for production Kubernetes environments."
more_link: "yes"
url: "/kubernetes-longhorn-backup-restore-s3-disaster-recovery/"
---

Longhorn's backup system provides continuous data protection for Kubernetes persistent volumes. Unlike snapshot-only solutions, Longhorn's incremental backups to S3-compatible object storage give you off-cluster copies that survive cluster-level failures. This guide covers production backup configuration, scheduling, and the complete disaster recovery procedures needed to restore data after catastrophic failures.

<!--more-->

# Kubernetes Longhorn Backup and Restore: S3-Compatible Disaster Recovery

## Section 1: Longhorn Backup Architecture

Longhorn's backup architecture uses a two-tier approach:

**Tier 1: Volume Snapshots** — Point-in-time snapshots stored on the same cluster nodes as the volume data. Fast to create and restore, but not protected against node or cluster failure.

**Tier 2: Backups to Secondary Storage** — Incremental backups of snapshot data pushed to S3, NFS, or CIFS. Protected against cluster-level failures. Slower to restore but available even if the cluster is completely destroyed.

### Backup Data Format

Longhorn backups use a custom incremental block format:
- Each backup stores only changed 2MB blocks since the last backup (deduplication)
- Blocks are checksummed for integrity verification
- A backup volume can have multiple backup chains (retain N backups)
- The backup target stores metadata and data blocks separately

### Backup Component Flow

```
Application writes to PVC
    ↓
Longhorn Volume
    ↓ (snapshot)
Volume Snapshot (on-cluster)
    ↓ (backup job)
Longhorn Backup Engine
    ↓ (incremental blocks + metadata)
S3 Backup Target
    └── volumes/
        └── pvc-abc123/
            ├── volume.cfg          # Volume metadata
            └── backups/
                ├── backup-2030-12-20T00:00:00Z/
                │   ├── backup.cfg  # Backup metadata
                │   └── blocks/     # Changed data blocks
                └── backup-2030-12-19T00:00:00Z/
```

## Section 2: S3 Backup Target Configuration

### AWS S3 Bucket Setup

```bash
# Create S3 bucket
aws s3api create-bucket \
    --bucket longhorn-backups-prod \
    --region us-east-1 \
    --create-bucket-configuration LocationConstraint=us-east-1

# Enable versioning (recommended for backup metadata protection)
aws s3api put-bucket-versioning \
    --bucket longhorn-backups-prod \
    --versioning-configuration Status=Enabled

# Configure lifecycle rule to expire old backup blocks
aws s3api put-bucket-lifecycle-configuration \
    --bucket longhorn-backups-prod \
    --lifecycle-configuration '{
      "Rules": [
        {
          "ID": "expire-old-versions",
          "Status": "Enabled",
          "NoncurrentVersionExpiration": {
            "NoncurrentDays": 30
          }
        }
      ]
    }'

# Block public access
aws s3api put-public-access-block \
    --bucket longhorn-backups-prod \
    --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Enable server-side encryption
aws s3api put-bucket-encryption \
    --bucket longhorn-backups-prod \
    --server-side-encryption-configuration '{
      "Rules": [
        {
          "ApplyServerSideEncryptionByDefault": {
            "SSEAlgorithm": "aws:kms",
            "KMSMasterKeyID": "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
          }
        }
      ]
    }'
```

### IAM Policy for Longhorn Backup

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::longhorn-backups-prod",
        "arn:aws:s3:::longhorn-backups-prod/*"
      ]
    }
  ]
}
```

### Longhorn Backup Secret

```yaml
# longhorn-backup-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-backup-secret
  namespace: longhorn-system
type: Opaque
stringData:
  # AWS credentials for S3 backup target
  AWS_ACCESS_KEY_ID: <aws-access-key-id>
  AWS_SECRET_ACCESS_KEY: <aws-secret-access-key>
  # For AWS STS/IRSA, leave credentials empty and use node IAM role
  # Virtual-hosted-style URL (recommended)
  AWS_ENDPOINTS: ""
  # For custom S3-compatible endpoints (MinIO, Ceph, etc.)
  # AWS_ENDPOINTS: "https://minio.storage.svc.cluster.local:9000"
  # Disable SSL verification for self-signed certs (not recommended for production)
  # AWS_CERT: ""
```

### Configuring the Backup Target

```yaml
# Set backup target via Longhorn Settings
# Method 1: Longhorn UI → Settings → Backup
# Method 2: Helm values
# Method 3: Direct Settings resource

# Via Longhorn Settings CRD
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-target
  namespace: longhorn-system
spec:
  value: "s3://longhorn-backups-prod@us-east-1/"
  # For MinIO or other S3-compatible: s3://bucket@region/path?endpoint=https://minio:9000

---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-target-credential-secret
  namespace: longhorn-system
spec:
  value: "longhorn-backup-secret"
```

### Alternative: MinIO S3-Compatible Target

```yaml
# MinIO configuration for on-premises backup
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-minio-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: minioadmin
  AWS_SECRET_ACCESS_KEY: <minio-password>
  AWS_ENDPOINTS: "https://minio.storage.example.com:9000"
  # If using self-signed certificates, base64-encode the CA cert:
  # AWS_CERT: <base64-encoded-tls-certificate>

---
# Backup target for MinIO
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-target
  namespace: longhorn-system
spec:
  # Path format: s3://bucket@region/optional-prefix/
  # For MinIO, region is arbitrary (often "us-east-1" or "local")
  value: "s3://longhorn-backups@us-east-1/"
```

## Section 3: Recurring Backup Schedules

### RecurringJob CRD

```yaml
# recurring-backup-daily.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  # Cron expression: At midnight every day
  cron: "0 0 * * *"
  task: backup
  groups:
    - default    # Apply to volumes in the "default" group
  retain: 14     # Keep 14 daily backups
  concurrency: 2 # Run up to 2 backup jobs simultaneously
  labels:
    backup-type: daily
    managed-by: longhorn

---
# Weekly backup with longer retention
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: weekly-backup
  namespace: longhorn-system
spec:
  cron: "0 2 * * 0"  # 2 AM every Sunday
  task: backup
  groups:
    - default
  retain: 52     # Keep 52 weekly backups (1 year)
  concurrency: 1
  labels:
    backup-type: weekly

---
# Hourly snapshot (on-cluster, fast)
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot
  namespace: longhorn-system
spec:
  cron: "0 * * * *"
  task: snapshot
  groups:
    - default
  retain: 24     # Keep 24 hourly snapshots
  concurrency: 5
  labels:
    backup-type: hourly-snapshot

---
# Critical database backup — every 4 hours
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: database-frequent-backup
  namespace: longhorn-system
spec:
  cron: "0 */4 * * *"  # Every 4 hours
  task: backup
  groups:
    - database-critical
  retain: 30
  concurrency: 1
```

### Assigning Volumes to RecurringJob Groups

```yaml
# Assign PVC/Volume to recurring job groups via annotations
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
  annotations:
    # Assign to both default and database-critical groups
    recurring-job-group.longhorn.io/default: enabled
    recurring-job-group.longhorn.io/database-critical: enabled
    # Or assign to a specific recurring job directly:
    # recurring-job.longhorn.io/daily-backup: enabled
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 100Gi
```

### Setting Backup Retention via StorageClass

```yaml
# longhorn-storageclass-with-backup.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-backup
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"  # 48 hours
  fromBackup: ""
  fsType: "ext4"
  # Disk selector for placement
  diskSelector: "ssd"
  nodeSelector: ""
  # Recurring job group
  recurringJobSelector: '[{"name":"daily-backup","isGroup":true}]'
  # Data locality
  dataLocality: "best-effort"
  # Backup compression
  backupCompressionMethod: "lz4"
```

## Section 4: Backup Compression and Encryption

### Backup Compression

```yaml
# Configure compression for all backups
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-compression-method
  namespace: longhorn-system
spec:
  # Options: none, lz4, gzip, zstd
  # lz4: fastest, moderate compression (~40%)
  # zstd: best compression (~60%), moderate speed
  # gzip: good compression, slower
  value: "lz4"
```

### Volume-Level Encryption

Longhorn encrypts volumes at rest using LUKS. The encryption key is stored in a Kubernetes Secret:

```yaml
# volume-encryption-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-crypto-global
  namespace: longhorn-system
type: Opaque
stringData:
  # CRYPTO_KEY_VALUE is the passphrase used for LUKS encryption
  # Use a strong, randomly generated key
  CRYPTO_KEY_VALUE: <crypto-key-passphrase>
  CRYPTO_KEY_PROVIDER: secret
  CRYPTO_KEY_CIPHER: aes-xts-plain64
  CRYPTO_KEY_HASH: sha256
  CRYPTO_KEY_SIZE: "256"
  CRYPTO_PBKDF: argon2i
```

```yaml
# Encrypted StorageClass
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-crypto
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"
  fromBackup: ""
  encrypted: "true"
  # Reference the encryption secret
  csi.storage.k8s.io/provisioner-secret-name: longhorn-crypto-global
  csi.storage.k8s.io/provisioner-secret-namespace: longhorn-system
  csi.storage.k8s.io/node-publish-secret-name: longhorn-crypto-global
  csi.storage.k8s.io/node-publish-secret-namespace: longhorn-system
  csi.storage.k8s.io/node-stage-secret-name: longhorn-crypto-global
  csi.storage.k8s.io/node-stage-secret-namespace: longhorn-system
```

## Section 5: Volume Restore — Same Namespace

### Triggering a Manual Restore

```bash
# List available backups for a volume
# Via Longhorn UI: Backup → Select Volume → List backups

# Via kubectl
kubectl -n longhorn-system get backups.longhorn.io | grep postgres-data

# Get backup details
BACKUP_NAME="backup-2030-12-19T22:00:00Z"
kubectl -n longhorn-system get backup.longhorn.io $BACKUP_NAME -o yaml
```

### Creating a PVC from Backup

```yaml
# restore-from-backup.yaml
# Creates a new PVC populated with data from a Longhorn backup
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
  annotations:
    # Point to the Longhorn backup
    # Format: s3://bucket@region/path?backupName=BACKUP_NAME&volumeName=VOLUME_NAME
    longhorn.io/data-source: "backup"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 100Gi
  # DataSource is the Kubernetes-native way (requires volume snapshot support)
  dataSource:
    name: postgres-snapshot-restore
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

### Direct Longhorn Volume Restore

```yaml
# Create a Longhorn volume directly from backup
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: postgres-data-restored
  namespace: longhorn-system
spec:
  size: "107374182400"  # 100Gi in bytes
  numberOfReplicas: 3
  staleReplicaTimeout: 2880
  fromBackup: "s3://longhorn-backups-prod@us-east-1/?backupName=backup-2030-12-19T22%3A00%3A00Z&volumeName=pvc-abc123"
  encrypted: false
  accessMode: rwo
  dataLocality: best-effort
```

After the volume is created and attached, create a PV/PVC pair:

```yaml
# Create PV for the restored volume
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-data-restored-pv
spec:
  capacity:
    storage: 100Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: longhorn
  csi:
    driver: driver.longhorn.io
    fsType: ext4
    volumeHandle: postgres-data-restored
    volumeAttributes:
      numberOfReplicas: "3"
      staleReplicaTimeout: "2880"

---
# Bind PVC to the restored PV
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  volumeName: postgres-data-restored-pv
  resources:
    requests:
      storage: 100Gi
```

## Section 6: Cross-Namespace Restore

Restoring to a different namespace follows the same approach but requires attention to RBAC and namespace-specific secrets.

```bash
# Step 1: Find the backup in Longhorn
kubectl -n longhorn-system get backups.longhorn.io -l "longhorn.io/volume-name=pvc-abc123"

# Step 2: Create the Longhorn volume in longhorn-system namespace
kubectl -n longhorn-system apply -f - << 'EOF'
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: postgres-restored-new-ns
  namespace: longhorn-system
spec:
  size: "107374182400"
  numberOfReplicas: 3
  fromBackup: "s3://longhorn-backups-prod@us-east-1/?backupName=backup-2030-12-19T22%3A00%3A00Z&volumeName=pvc-abc123"
  accessMode: rwo
EOF

# Step 3: Wait for volume to be ready
kubectl -n longhorn-system wait \
    --for=condition=ready \
    --timeout=300s \
    volume/postgres-restored-new-ns

# Step 4: Create PV/PVC in the new namespace
kubectl apply -f - << 'EOF'
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-restored-new-ns-pv
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: longhorn
  claimRef:
    name: postgres-restored
    namespace: staging        # Different namespace
  csi:
    driver: driver.longhorn.io
    fsType: ext4
    volumeHandle: postgres-restored-new-ns
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-restored
  namespace: staging          # Restore to staging namespace
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  volumeName: postgres-restored-new-ns-pv
  resources:
    requests:
      storage: 100Gi
EOF
```

## Section 7: Cross-Cluster Restore

The most critical DR scenario: the source cluster is destroyed, and you need to restore to a completely new cluster.

### Prerequisites for Cross-Cluster Restore

```bash
# On the new cluster, install Longhorn with the same backup target configuration
helm repo add longhorn https://charts.longhorn.io
helm repo update

# Configure backup target credentials
kubectl create namespace longhorn-system

kubectl create secret generic longhorn-backup-secret \
    --namespace longhorn-system \
    --from-literal=AWS_ACCESS_KEY_ID=<aws-access-key-id> \
    --from-literal=AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>

# Install Longhorn
helm install longhorn longhorn/longhorn \
    --namespace longhorn-system \
    --set defaultSettings.backupTarget="s3://longhorn-backups-prod@us-east-1/" \
    --set defaultSettings.backupTargetCredentialSecret="longhorn-backup-secret" \
    --set defaultSettings.defaultReplicaCount=3 \
    --wait

# Verify backup target is accessible
kubectl -n longhorn-system exec \
    $(kubectl -n longhorn-system get pod -l app=longhorn-manager -o name | head -1) \
    -- curl -s http://longhorn-backend:9500/v1/settings/backup-target \
    | python3 -m json.tool
```

### Discovering Backups on New Cluster

```bash
# Longhorn automatically discovers backups from the configured S3 target
# Watch for backup volume list to populate
kubectl -n longhorn-system get backupvolumes.longhorn.io

# Example output:
# NAME         LASTBACKUPAT                CREATED   AGE    URL
# pvc-abc123   2030-12-19T22:00:00Z        ...       ...    s3://longhorn-backups-prod@us-east-1/

# List backups for a specific volume
kubectl -n longhorn-system get backups.longhorn.io -l "longhorn.io/backup-volume=pvc-abc123"
```

### Complete DR Restore Script

```bash
#!/bin/bash
# longhorn-dr-restore.sh
# Restores all Longhorn volumes from S3 backup to a new cluster

set -euo pipefail

BACKUP_TARGET="s3://longhorn-backups-prod@us-east-1/"
NAMESPACE_MAPPING_FILE="namespace-mapping.yaml"
OUTPUT_DIR="./dr-restore-manifests"

mkdir -p "$OUTPUT_DIR"

# Parse namespace mapping (old namespace → new namespace)
# Format: old_namespace:new_namespace
declare -A NS_MAP
while IFS=: read -r old_ns new_ns; do
    NS_MAP["$old_ns"]="$new_ns"
done < <(yq e '.[]' $NAMESPACE_MAPPING_FILE 2>/dev/null || cat << 'EOF'
production:production
staging:staging
EOF
)

echo "=== Longhorn Cross-Cluster DR Restore ==="
echo "Backup target: $BACKUP_TARGET"

# Get list of all backup volumes
BACKUP_VOLUMES=$(kubectl -n longhorn-system get backupvolumes.longhorn.io \
    -o jsonpath='{.items[*].metadata.name}')

echo "Found backup volumes: $BACKUP_VOLUMES"

for vol_name in $BACKUP_VOLUMES; do
    echo ""
    echo "--- Processing volume: $vol_name ---"

    # Get latest backup
    LATEST_BACKUP=$(kubectl -n longhorn-system get backups.longhorn.io \
        -l "longhorn.io/backup-volume=$vol_name" \
        --sort-by='.spec.snapshotCreatedAt' \
        -o jsonpath='{.items[-1].metadata.name}')

    if [ -z "$LATEST_BACKUP" ]; then
        echo "No backups found for $vol_name, skipping"
        continue
    fi

    # Get backup details
    BACKUP_SIZE=$(kubectl -n longhorn-system get backup.longhorn.io "$LATEST_BACKUP" \
        -o jsonpath='{.status.size}')
    BACKUP_URL=$(kubectl -n longhorn-system get backup.longhorn.io "$LATEST_BACKUP" \
        -o jsonpath='{.status.url}')

    echo "Latest backup: $LATEST_BACKUP"
    echo "Backup size: $BACKUP_SIZE"

    # Get original PVC namespace and name from backup labels
    ORIG_NS=$(kubectl -n longhorn-system get backup.longhorn.io "$LATEST_BACKUP" \
        -o jsonpath='{.status.labels.longhorn\.io/pvc-namespace}' 2>/dev/null || echo "unknown")
    ORIG_PVC=$(kubectl -n longhorn-system get backup.longhorn.io "$LATEST_BACKUP" \
        -o jsonpath='{.status.labels.longhorn\.io/pvc-name}' 2>/dev/null || echo "$vol_name")

    # Determine target namespace
    TARGET_NS="${NS_MAP[$ORIG_NS]:-$ORIG_NS}"
    echo "Restoring to namespace: $TARGET_NS (original: $ORIG_NS)"

    # Create target namespace if needed
    kubectl create namespace "$TARGET_NS" --dry-run=client -o yaml | kubectl apply -f -

    # Generate restore manifest
    cat > "$OUTPUT_DIR/restore-${vol_name}.yaml" << EOF
---
# Longhorn Volume restore from backup
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: dr-restore-${vol_name}
  namespace: longhorn-system
  labels:
    dr-restore: "true"
    original-volume: "${vol_name}"
spec:
  size: "${BACKUP_SIZE}"
  numberOfReplicas: 3
  staleReplicaTimeout: 2880
  fromBackup: "${BACKUP_URL}"
  accessMode: rwo
  dataLocality: best-effort
---
# PersistentVolume
apiVersion: v1
kind: PersistentVolume
metadata:
  name: dr-restore-${vol_name}-pv
  labels:
    dr-restore: "true"
    original-volume: "${vol_name}"
spec:
  capacity:
    storage: "${BACKUP_SIZE}"
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: longhorn
  claimRef:
    name: ${ORIG_PVC}
    namespace: ${TARGET_NS}
  csi:
    driver: driver.longhorn.io
    fsType: ext4
    volumeHandle: dr-restore-${vol_name}
---
# PersistentVolumeClaim
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${ORIG_PVC}
  namespace: ${TARGET_NS}
  labels:
    dr-restore: "true"
    original-volume: "${vol_name}"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  volumeName: dr-restore-${vol_name}-pv
  resources:
    requests:
      storage: "${BACKUP_SIZE}"
EOF

    echo "Generated: $OUTPUT_DIR/restore-${vol_name}.yaml"
done

echo ""
echo "=== Generated restore manifests ==="
ls -la "$OUTPUT_DIR/"

echo ""
echo "To apply all restores:"
echo "  kubectl apply -f $OUTPUT_DIR/"
echo ""
echo "To monitor restore progress:"
echo "  kubectl -n longhorn-system get volumes.longhorn.io -w"
```

## Section 8: Monitoring Backup Health

### Prometheus Alerts for Backup Failures

```yaml
# longhorn-backup-alerts.yaml
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
    - name: longhorn.backup.alerts
      rules:
        - alert: LonghornVolumeBackupFailed
          expr: |
            longhorn_volume_robustness == 3
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn volume {{ $labels.volume }} backup failed"
            description: "Longhorn volume {{ $labels.volume }} in namespace {{ $labels.node }} is in a faulted state."
            runbook_url: "https://runbooks.support.tools/longhorn-volume-fault"

        - alert: LonghornBackupStale
          expr: |
            time() - longhorn_volume_last_backup_timestamp_seconds > 86400
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Longhorn volume {{ $labels.volume }} backup is older than 24 hours"
            description: |
              Volume {{ $labels.volume }} last backed up {{ $value | humanizeDuration }} ago.
              Expected maximum age: 24 hours.

        - alert: LonghornBackupTargetUnreachable
          expr: |
            longhorn_backup_target_available == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn backup target is unreachable"
            description: "Longhorn cannot reach the S3 backup target. All backups are failing."
            runbook_url: "https://runbooks.support.tools/longhorn-backup-target"

        - alert: LonghornVolumeNearFull
          expr: |
            (longhorn_volume_usage_bytes / longhorn_volume_capacity_bytes) > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn volume {{ $labels.volume }} is 85% full"
            description: |
              Volume {{ $labels.volume }} is {{ $value | humanizePercentage }} full.
```

### ServiceMonitor for Longhorn Metrics

```yaml
# longhorn-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: longhorn-metrics
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - longhorn-system
  selector:
    matchLabels:
      app: longhorn-manager
  endpoints:
    - port: manager
      path: /metrics
      interval: 30s
```

## Section 9: Disaster Recovery Runbook

### DR Runbook: Cluster Failure Recovery

```markdown
# Longhorn Disaster Recovery Runbook
## Scenario: Complete Cluster Loss

### RTO Target: 4 hours
### RPO Target: 24 hours (last daily backup)

## Phase 1: Assessment (15 minutes)
1. Confirm cluster is unrecoverable
2. Identify last known-good backup time from monitoring/S3
3. Determine which namespaces/PVCs need recovery
4. Provision new cluster infrastructure

## Phase 2: New Cluster Setup (30 minutes)
1. Install Kubernetes on new infrastructure
2. Install Longhorn with backup target credentials
3. Verify backup target connectivity:
   ```
   kubectl -n longhorn-system exec deploy/longhorn-manager -- \
       longhorn-manager backup-list
   ```

## Phase 3: Application Manifests (30 minutes)
1. Restore non-storage Kubernetes manifests from Git
2. DO NOT start application pods yet — wait for storage restore

## Phase 4: Storage Restore (2-3 hours depending on data size)
1. Run the DR restore script:
   ```
   ./longhorn-dr-restore.sh
   kubectl apply -f dr-restore-manifests/
   ```
2. Monitor volume creation:
   ```
   watch kubectl -n longhorn-system get volumes.longhorn.io
   ```
3. Verify volumes reach "ready" state

## Phase 5: Application Restart
1. Apply application deployments
2. Verify database integrity after restore
3. Run smoke tests
4. Update DNS to point to new cluster

## Verification Checklist
- [ ] All PVCs in Bound state
- [ ] Application pods Running
- [ ] Database queries return expected data
- [ ] Write operations succeeding
- [ ] Backup jobs scheduled and running
```

### Testing Backup Restorability

```bash
#!/bin/bash
# test-backup-restore.sh
# Monthly test: restore a volume and verify data integrity

TEST_VOLUME="postgres-data"
TEST_NAMESPACE="production"
RESTORE_NAMESPACE="dr-test"
VERIFICATION_QUERY="SELECT COUNT(*) FROM users;"

echo "=== Monthly DR Restore Test ==="
echo "Testing restore of $TEST_VOLUME"
echo "Date: $(date -u)"

# Create test namespace
kubectl create namespace $RESTORE_NAMESPACE --dry-run=client -o yaml | kubectl apply -f -

# Get latest backup
LATEST_BACKUP=$(kubectl -n longhorn-system get backups.longhorn.io \
    -l "longhorn.io/backup-volume=$(kubectl get pvc $TEST_VOLUME -n $TEST_NAMESPACE \
        -o jsonpath='{.spec.volumeName}')" \
    --sort-by='.spec.snapshotCreatedAt' \
    -o jsonpath='{.items[-1].metadata.name}')

echo "Restoring backup: $LATEST_BACKUP"

# Trigger restore (see earlier restore manifests)
# ... (restore procedure)

# After restore, run verification
kubectl run dr-test-verify \
    --image=postgres:16 \
    --rm \
    --restart=Never \
    --namespace=$RESTORE_NAMESPACE \
    --overrides='{
        "spec": {
            "volumes": [{
                "name": "data",
                "persistentVolumeClaim": {"claimName": "postgres-restored"}
            }],
            "containers": [{
                "name": "verify",
                "image": "postgres:16",
                "env": [{"name": "PGPASSWORD", "value": "testpass"}],
                "command": ["psql", "-h", "localhost", "-U", "postgres", "-c", "SELECT COUNT(*) FROM users;"],
                "volumeMounts": [{"name": "data", "mountPath": "/var/lib/postgresql/data"}]
            }]
        }
    }' \
    -- echo "DR restore test complete"

# Cleanup test namespace
echo "Cleaning up test restore..."
kubectl delete namespace $RESTORE_NAMESPACE

echo "=== DR Test Complete ==="
```

A robust Longhorn backup strategy with S3-compatible off-cluster storage provides comprehensive protection against both application-level data corruption and complete cluster failures. The key operational practices are: testing restores regularly (not just backup success), maintaining backup target connectivity monitoring, and rehearsing the cross-cluster DR procedure before you need it in a real incident.
