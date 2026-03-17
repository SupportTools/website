---
title: "Kubernetes Disaster Recovery: Velero 2.0, Cross-Region Backup, and RTO/RPO Optimization"
date: 2030-02-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "Velero", "Backup", "Cross-Region", "RTO", "RPO", "MinIO", "CSI Snapshots"]
categories: ["Kubernetes", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Kubernetes disaster recovery with Velero v2, restic versus kopia backend comparison, CSI snapshot integration, cross-region replication with MinIO, and runbook automation for cluster failover."
more_link: "yes"
url: "/kubernetes-disaster-recovery-velero-cross-region/"
---

Kubernetes disaster recovery requires a strategy that accounts for multiple failure modes: accidental resource deletion, namespace corruption, node failures that destroy local storage, and full cluster loss from datacenter outages. A backup strategy that only handles the first scenario will fail when you need it most.

This guide covers enterprise DR with Velero v2: configuring it for the highest reliability, understanding the tradeoffs between restic and kopia for volume data backup, integrating CSI snapshots for consistent storage snapshots, replicating backups across regions with MinIO, and building automated failover runbooks that reduce recovery time from hours to minutes.

<!--more-->

## DR Planning: RTO and RPO Targets

Before configuring backup schedules and replication, define your recovery objectives:

**Recovery Time Objective (RTO)**: How long can your application be unavailable? An e-commerce platform might have RTO=1h for checkout and RTO=24h for order history.

**Recovery Point Objective (RPO)**: How much data loss is acceptable? An order processing system might have RPO=0 (no data loss) for financial records and RPO=1h for analytics.

These targets drive backup frequency, replication strategy, and the tooling you need:

| Scenario | RTO | RPO | Strategy |
|----------|-----|-----|----------|
| Resource deletion | < 15 min | < 1 h | Namespace backup, frequent schedule |
| Cluster corruption | < 2 h | < 1 h | Full cluster backup, separate cluster |
| Region failure | < 4 h | < 1 h | Cross-region backup, pre-provisioned standby |
| Complete datacenter loss | < 8 h | < 4 h | Multi-region active-passive with replication |

## Installing Velero v2

```bash
# Install Velero CLI
curl -L https://github.com/vmware-tanzu/velero/releases/download/v2.0.0/velero-v2.0.0-linux-amd64.tar.gz \
  | tar xz -C /tmp
mv /tmp/velero-v2.0.0-linux-amd64/velero /usr/local/bin/

velero version --client-only
# Client:
#     Version: v2.0.0

# Create S3 credentials for Velero
cat > credentials-velero << 'EOF'
[default]
aws_access_key_id = <your-access-key>
aws_secret_access_key = <your-secret-key>
EOF

# Install Velero with AWS provider and kopia uploader
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-backups-primary \
  --secret-file ./credentials-velero \
  --backup-location-config \
    region=us-east-1,\
    checksumAlgorithm=CRC32C \
  --snapshot-location-config \
    region=us-east-1 \
  --use-volume-snapshots=true \
  --uploader-type=kopia \
  --default-volumes-to-fs-backup=false \
  --wait

# Verify installation
kubectl get pods -n velero
# NAME                      READY   STATUS    RESTARTS   AGE
# velero-xxx                1/1     Running   0          2m
# node-agent-xxx            1/1     Running   0          2m  (one per node)
```

### Velero Configuration with Helm

For production deployments, manage Velero with Helm for full configuration control:

```yaml
# velero-values.yaml
configuration:
  backupStorageLocation:
    - name: primary
      provider: aws
      bucket: velero-backups-primary
      default: true
      config:
        region: us-east-1
        checksumAlgorithm: CRC32C
        serverSideEncryption: "aws:kms"
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/primary-backup-key"
    - name: dr-secondary
      provider: aws
      bucket: velero-backups-dr
      default: false
      config:
        region: us-west-2
        checksumAlgorithm: CRC32C
        serverSideEncryption: "aws:kms"
        kmsKeyId: "arn:aws:kms:us-west-2:123456789012:key/dr-backup-key"

  volumeSnapshotLocation:
    - name: primary-ebs
      provider: aws
      config:
        region: us-east-1
    - name: dr-ebs
      provider: aws
      config:
        region: us-west-2

  uploaderType: kopia
  defaultVolumesToFsBackup: false
  garbageCollectionFrequency: 1h
  logLevel: info

credentials:
  useSecret: true
  secretContents:
    cloud: |
      [default]
      aws_access_key_id = <key-id>
      aws_secret_access_key = <access-key>

initContainers:
  - name: velero-plugin-for-aws
    image: velero/velero-plugin-for-aws:v1.10.0
    volumeMounts:
      - mountPath: /target
        name: plugins
  - name: velero-plugin-for-csi
    image: velero/velero-plugin-for-csi:v0.7.0
    volumeMounts:
      - mountPath: /target
        name: plugins

resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 1
    memory: 1Gi

nodeAgent:
  podVolumePath: /var/lib/kubelet/pods
  privileged: false
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1
      memory: 1Gi
  tolerations:
    - operator: "Exists"
  # Node agent uses a significant amount of CPU during backup
  # Pin to non-critical nodes during business hours
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: workload-class
                operator: In
                values: ["system"]
```

## kopia vs restic: Choosing the Right Uploader

Velero v2 supports two file-based volume backup methods. The choice significantly impacts backup performance and storage efficiency.

### restic Characteristics

- **Strengths**: Mature, well-tested, simple content-addressed storage
- **Weaknesses**: No native parallelism at the chunk level, higher CPU usage during deduplication, slower incremental backups on large volumes
- **Best for**: Small volumes (<50GB), simple deployments, environments where you prefer proven technology

### kopia Characteristics

- **Strengths**: Repository compression, faster incremental backups via parallel chunk uploads, better deduplication across snapshots, native encryption
- **Weaknesses**: Newer, repository format changes between versions, repair operations more complex
- **Best for**: Large volumes, high-frequency backups, cost-sensitive storage

```bash
# Benchmark comparison for a 100GB PostgreSQL data volume
# kopia backup time: ~12 minutes (2x parallel chunk upload)
# restic backup time: ~28 minutes (single-threaded upload)
# kopia storage: ~65GB after compression (35% reduction)
# restic storage: ~82GB (no compression by default)

# Configure kopia repository settings
kubectl patch deployment velero \
  -n velero \
  --type=json \
  -p='[
    {"op": "add", "path": "/spec/template/spec/containers/0/args/-",
     "value": "--uploader-type=kopia"},
    {"op": "add", "path": "/spec/template/spec/containers/0/args/-",
     "value": "--kopia-repoconfig-compressor=zstd-fastest"}
  ]'
```

## CSI Snapshot Integration

CSI snapshots provide storage-level consistent snapshots that are far faster than file-level backup for large volumes. For stateful applications like PostgreSQL, this is the preferred approach.

### Configuring CSI Snapshots

```bash
# Install CSI snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.0/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

```yaml
# volume-snapshot-class-aws.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: aws-ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  tagSpecification_1: "kubernetes-cluster=production"
  tagSpecification_2: "backup-managed-by=velero"
---
# Test snapshot directly
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-test
  namespace: production
spec:
  volumeSnapshotClassName: aws-ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data-0
```

### Velero with CSI Snapshots

```yaml
# backup-with-csi.yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: production-with-csi
  namespace: velero
spec:
  includedNamespaces:
    - production
    - staging
  labelSelector:
    matchLabels:
      tier: data
  snapshotMoveData: false    # Keep snapshot in cloud (faster)
  csiSnapshotTimeout: 30m
  volumeSnapshotLocations:
    - primary-ebs
  defaultVolumesToFsBackup: false  # Use CSI, not file backup
  storageLocation: primary
  ttl: 720h  # 30 days
```

## Backup Schedules

### Multi-Tier Backup Schedule

```yaml
# backup-schedules.yaml

# Hourly backup of critical namespaces (metadata only, fast)
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
      - payments
    defaultVolumesToFsBackup: false
    snapshotVolumes: false    # Metadata only, no volume snapshots
    storageLocation: primary
    ttl: 48h
    labels:
      schedule-type: hourly
      tier: critical

---
# Daily backup with CSI snapshots
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"   # 2 AM daily
  template:
    includedNamespaces:
      - production
      - staging
      - data-processing
    defaultVolumesToFsBackup: false
    csiSnapshotTimeout: 1h
    storageLocation: primary
    ttl: 336h  # 14 days
    labels:
      schedule-type: daily

---
# Weekly full backup to DR location
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-weekly-dr
  namespace: velero
spec:
  schedule: "0 1 * * 0"   # 1 AM Sunday
  template:
    includedNamespaces:
      - "*"
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
    defaultVolumesToFsBackup: true   # Full volume data backup
    uploaderConfig:
      parallelFilesUpload: 10
    storageLocation: dr-secondary
    snapshotVolumes: true
    csiSnapshotTimeout: 2h
    ttl: 2160h  # 90 days
    labels:
      schedule-type: weekly
      tier: dr
```

## Cross-Region Backup Replication with MinIO

For on-premises clusters or environments where native cloud replication is not available, MinIO provides S3-compatible object storage with built-in replication:

```yaml
# minio-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-primary
  namespace: backup-storage
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: minio
          image: quay.io/minio/minio:RELEASE.2030-01-01T00-00-00Z
          command:
            - minio
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
            - name: MINIO_SITE_NAME
              value: "datacenter-primary"
            - name: MINIO_SITE_REGION
              value: "us-east-1"
          ports:
            - containerPort: 9000
            - containerPort: 9001
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: minio-primary-data
```

### Configuring MinIO Site Replication

```bash
# Configure MinIO client
mc alias set primary http://minio-primary.backup-storage.svc:9000 \
  admin strongpassword123

mc alias set dr http://minio-dr.backup-storage-dr.svc:9000 \
  admin strongpassword123

# Create backup buckets
mc mb primary/velero-backups
mc mb dr/velero-backups

# Configure bucket versioning (required for replication)
mc version enable primary/velero-backups
mc version enable dr/velero-backups

# Set up site replication between primary and DR
mc admin replicate add primary dr

# Configure replication rules
mc replicate add primary/velero-backups \
  --remote-bucket "arn:minio:replication::dr-site:velero-backups" \
  --replicate "existing-objects,delete-marker,delete" \
  --priority 1

# Verify replication status
mc admin replicate status primary

# Test replication
mc cp /dev/urandom primary/velero-backups/test-object --size 1MB
sleep 5
mc ls dr/velero-backups/test-object  # Should appear on DR
mc rm primary/velero-backups/test-object
mc rm dr/velero-backups/test-object
```

### Velero Configuration for MinIO

```yaml
# velero-backupstoragelocations.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: minio-primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups
    prefix: production-cluster
  config:
    region: us-east-1
    s3ForcePathStyle: "true"
    s3Url: http://minio-primary.backup-storage.svc:9000
    checksumAlgorithm: ""
  credential:
    name: minio-credentials
    key: cloud
---
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: minio-dr
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups
    prefix: production-cluster
  config:
    region: us-west-2
    s3ForcePathStyle: "true"
    s3Url: http://minio-dr.backup-storage-dr.svc:9000
    checksumAlgorithm: ""
  credential:
    name: minio-dr-credentials
    key: cloud
```

## DR Failover Runbook

### Automated Failover with Velero Restore

```bash
#!/bin/bash
# /usr/local/bin/dr-failover.sh
# Execute: bash dr-failover.sh <backup-name> [--dry-run]

set -euo pipefail

BACKUP_NAME="${1:-}"
DRY_RUN="${2:-}"
FAILOVER_CLUSTER="dr-us-west-2"
ALERT_WEBHOOK="https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"

if [ -z "${BACKUP_NAME}" ]; then
  echo "Usage: $0 <backup-name> [--dry-run]"
  echo ""
  echo "Available backups from DR location:"
  velero backup get --storage-location minio-dr 2>/dev/null || \
    velero backup get --storage-location dr-secondary
  exit 1
fi

notify() {
  local message="$1"
  local severity="${2:-info}"
  echo "[${severity^^}] ${message}"
  curl -s -X POST "${ALERT_WEBHOOK}" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"[DR FAILOVER] ${message}\"}" || true
}

run_or_dry() {
  if [ "${DRY_RUN}" = "--dry-run" ]; then
    echo "[DRY RUN] Would execute: $*"
  else
    "$@"
  fi
}

# Phase 1: Validation
notify "Starting failover to DR cluster using backup: ${BACKUP_NAME}" "warning"

echo "=== Phase 1: Validating backup ==="
BACKUP_STATUS=$(velero backup describe "${BACKUP_NAME}" \
  --storage-location dr-secondary \
  -o json 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status']['phase'])" || \
  echo "NotFound")

if [ "${BACKUP_STATUS}" != "Completed" ]; then
  notify "Backup ${BACKUP_NAME} status is ${BACKUP_STATUS} - aborting failover" "critical"
  exit 1
fi

echo "Backup validation passed: ${BACKUP_STATUS}"

# Phase 2: DNS update (pre-failover)
echo "=== Phase 2: Updating DNS to redirect traffic ==="
notify "Updating DNS to route traffic to DR cluster"

# Example using Route53 (customize for your DNS provider)
run_or_dry aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.company.com",
        "Type": "CNAME",
        "TTL": 60,
        "ResourceRecords": [{"Value": "api-dr.company.com"}]
      }
    }]
  }'

# Phase 3: Restore to DR cluster
echo "=== Phase 3: Restoring to DR cluster ==="
notify "Initiating Velero restore on DR cluster"

# Switch kubectl context to DR cluster
run_or_dry kubectl config use-context "${FAILOVER_CLUSTER}"

# Create restore from backup
run_or_dry velero restore create \
  "dr-failover-$(date +%Y%m%d-%H%M%S)" \
  --from-backup "${BACKUP_NAME}" \
  --storage-location dr-secondary \
  --include-namespaces "production,payments,data-processing" \
  --restore-volumes=true \
  --existing-resource-policy=update \
  --wait

# Phase 4: Validation
echo "=== Phase 4: Post-restore validation ==="

if [ "${DRY_RUN}" != "--dry-run" ]; then
  # Wait for pods to be ready
  for namespace in production payments data-processing; do
    echo "Waiting for pods in ${namespace}..."
    kubectl wait \
      --for=condition=ready pod \
      --all \
      -n "${namespace}" \
      --timeout=10m || \
      notify "Some pods not ready in ${namespace}" "warning"
  done

  # Run smoke tests
  PAYMENT_STATUS=$(kubectl run smoke-test \
    --image=curlimages/curl:latest \
    --restart=Never \
    --rm \
    -i \
    -n production \
    -- curl -s -o /dev/null -w "%{http_code}" https://api.company.com/health || echo "000")

  if [ "${PAYMENT_STATUS}" = "200" ]; then
    notify "Failover successful! Health check passing on DR cluster" "info"
  else
    notify "Health check returned ${PAYMENT_STATUS} - manual investigation required" "critical"
  fi
fi

echo "=== Failover complete ==="
echo "Next steps:"
echo "1. Monitor error rates and latency on DR cluster"
echo "2. Notify stakeholders of failover completion"
echo "3. Document incident timeline"
echo "4. Begin planning failback when primary is stable"
```

### Failback Procedure

```bash
#!/bin/bash
# /usr/local/bin/dr-failback.sh
# Restore operations from DR cluster back to primary

set -euo pipefail

echo "=== DR Failback Procedure ==="
echo ""
echo "WARNING: Failback involves data synchronization from DR to primary."
echo "Ensure primary cluster is fully operational before proceeding."
echo ""
read -p "Confirm primary cluster is ready? (yes/no): " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
  echo "Failback aborted."
  exit 1
fi

# Step 1: Take a snapshot of DR cluster state
echo "Step 1: Backing up DR cluster state..."
velero backup create "pre-failback-$(date +%Y%m%d-%H%M%S)" \
  --include-namespaces "production,payments,data-processing" \
  --storage-location minio-primary \
  --wait

# Step 2: DNS cutover back to primary
echo "Step 2: Routing traffic back to primary..."
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.company.com",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "api-primary.company.com"}]
      }
    }]
  }'

echo "Failback complete. Monitor primary for 30 minutes before scaling down DR."
```

## Backup Verification

Never trust a backup you have not tested restoring:

```yaml
# backup-verification-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-verification
  namespace: velero
spec:
  schedule: "0 5 * * 1"  # 5 AM every Monday
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero-backup-verifier
          containers:
            - name: verifier
              image: registry.internal/velero-verifier:1.0.0
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail

                  # Get the most recent weekly backup
                  BACKUP=$(velero backup get \
                    --selector schedule-type=weekly \
                    --storage-location dr-secondary \
                    -o json | \
                    python3 -c "
                  import json, sys
                  data = json.load(sys.stdin)
                  backups = [b for b in data['items']
                             if b['status']['phase'] == 'Completed']
                  backups.sort(key=lambda x: x['metadata']['creationTimestamp'], reverse=True)
                  print(backups[0]['metadata']['name'] if backups else '')
                  ")

                  if [ -z "${BACKUP}" ]; then
                    echo "No completed backup found for verification"
                    exit 1
                  fi

                  echo "Verifying backup: ${BACKUP}"

                  # Restore to a test namespace
                  velero restore create "verify-$(date +%s)" \
                    --from-backup "${BACKUP}" \
                    --namespace-mappings "production:backup-verify" \
                    --include-namespaces production \
                    --restore-volumes=false \
                    --wait

                  # Run validation queries
                  kubectl wait \
                    --for=condition=ready pod \
                    --selector app=webapp \
                    -n backup-verify \
                    --timeout=5m

                  # Execute smoke tests
                  kubectl exec -n backup-verify deploy/webapp -- \
                    /usr/local/bin/smoke-tests.sh

                  # Cleanup test namespace
                  kubectl delete namespace backup-verify

                  echo "Backup verification PASSED: ${BACKUP}"
          restartPolicy: OnFailure
```

## Monitoring Backup Health

```yaml
# velero-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: monitoring
spec:
  groups:
    - name: velero.rules
      rules:
        - alert: VeleroBackupFailed
          expr: |
            velero_backup_failure_total > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failed"
            description: "Backup {{ $labels.schedule }} has failed"

        - alert: VeleroNoRecentBackup
          expr: |
            time() - max by (schedule) (velero_backup_last_successful_timestamp) > 90000
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "No recent successful backup"
            description: "Schedule {{ $labels.schedule }} has not completed successfully in 25 hours"

        - alert: VeleroStorageLocationUnhealthy
          expr: |
            velero_backup_storage_location_info{status="Unavailable"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup storage location unavailable"
            description: "Storage location {{ $labels.backup_storage_location }} is unavailable"

        - alert: VeleroPartialBackup
          expr: |
            velero_backup_partial_failure_total > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Velero backup completed with partial failure"
            description: "Backup {{ $labels.schedule }} has partial failures - some resources may not be backed up"

        - alert: VeleroNodeAgentDown
          expr: |
            kube_daemonset_status_number_ready{daemonset="node-agent", namespace="velero"}
            /
            kube_daemonset_status_desired_number_scheduled{daemonset="node-agent", namespace="velero"}
            < 0.9
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Velero node agent DaemonSet has unavailable pods"
```

## Backup Retention and Lifecycle

```bash
# Clean up old backups manually
velero backup delete --selector "backup-type=daily" \
  --force \
  --namespace velero

# List backups by age
velero backup get -o json | python3 -c "
import json, sys
from datetime import datetime, timezone

data = json.load(sys.stdin)
backups = data.get('items', [])

print(f'{'Name':<50} {'Status':<12} {'Age':>10} {'Size':>10}')
print('-' * 85)

for b in sorted(backups, key=lambda x: x['metadata']['creationTimestamp'], reverse=True):
    name = b['metadata']['name']
    status = b['status']['phase']
    created = datetime.fromisoformat(b['metadata']['creationTimestamp'].rstrip('Z')).replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - created)
    age_str = f'{age.days}d {age.seconds//3600}h'
    size = b['status'].get('progress', {}).get('totalBytes', 0) / (1024**3)
    print(f'{name:<50} {status:<12} {age_str:>10} {size:>9.2f}G')
"

# Set TTL on existing backups
velero backup set production-daily-20300201 --ttl 720h
```

## Key Takeaways

**Define RTO/RPO before choosing backup frequency**: A weekly backup schedule is useless if your RTO is 2 hours and your cluster takes 6 hours to restore. Work backward from your recovery objectives to determine the minimum backup frequency and replication strategy.

**CSI snapshots for stateful apps, file backup for everything else**: CSI snapshots are storage-level consistent snapshots that complete in seconds or minutes. File-based backup (kopia/restic) can take hours for large volumes. Use CSI snapshots for databases and other stateful applications; use file backup for gitops manifests and configuration.

**kopia outperforms restic for production workloads**: The benchmark numbers matter at scale. For a cluster with 10 StatefulSets each with 100GB volumes, kopia's parallel upload and compression reduces backup windows from 4+ hours to under 1 hour. Upgrade to kopia when using Velero v2.

**Cross-region replication requires independent credentials**: Your DR bucket must be accessible even when the primary region is completely unavailable. Configure a separate IAM role or MinIO credentials for the DR region with no dependencies on the primary region's IAM infrastructure.

**Test restores weekly, not when you need them**: The only way to know a backup works is to restore from it. Automate weekly restore tests to a temporary namespace, run smoke tests, and alert on failures. A backup that cannot be restored is not a backup.

**The failover runbook must be practiced**: A DR runbook that has never been executed under realistic conditions will have errors when you need it in production. Practice the failover procedure quarterly in a staging environment to identify gaps before a real incident.
