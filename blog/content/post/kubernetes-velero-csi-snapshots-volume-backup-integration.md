---
title: "Kubernetes Velero CSI Snapshots: Volume Backup Integration with StorageClass Providers"
date: 2031-03-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "CSI", "Backup", "Storage", "AWS EBS", "GCP", "Azure"]
categories:
- Kubernetes
- Storage
- Backup
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to integrating Velero with CSI VolumeSnapshot APIs for consistent application backup across AWS EBS, GCP Persistent Disk, and Azure Disk providers, including pre/post hooks and cross-zone restore."
more_link: "yes"
url: "/kubernetes-velero-csi-snapshots-volume-backup-integration/"
---

Production Kubernetes clusters running stateful workloads require backup strategies that go beyond simple etcd snapshots. Velero's CSI snapshot integration provides a standardized mechanism for capturing consistent point-in-time volume state across cloud providers, leveraging the Container Storage Interface's VolumeSnapshot API to eliminate the impedance mismatch between backup tooling and storage backends.

This guide covers the complete implementation: CSI snapshot class configuration per provider, Velero plugin setup, application quiescing hooks, backup verification workflows, and the operational procedures for cross-zone restores that production teams actually need.

<!--more-->

# Kubernetes Velero CSI Snapshots: Volume Backup Integration with StorageClass Providers

## Section 1: Architecture and Prerequisites

### How Velero CSI Integration Works

The Velero CSI plugin bridges Velero's backup orchestration with the Kubernetes VolumeSnapshot API. When Velero executes a backup that includes PersistentVolumeClaims, the CSI plugin:

1. Creates a `VolumeSnapshot` object referencing the PVC
2. The CSI driver (EBS CSI, GCP PD CSI, Azure Disk CSI) provisions a `VolumeSnapshotContent` and triggers a cloud-side snapshot
3. Velero stores the `VolumeSnapshot` metadata in its object store backup
4. On restore, Velero creates a new PVC from the snapshot via `dataSource` reference

The critical advantage over the legacy Velero AWS/GCP/Azure plugins is portability — the same Velero backup spec works across providers, and the VolumeSnapshot lifecycle is managed by Kubernetes-native objects rather than provider-specific Velero plugins.

### Cluster Requirements

Before configuring Velero CSI snapshots, verify these prerequisites:

```bash
# Check Kubernetes version (1.20+ required for stable CSI snapshots)
kubectl version --short

# Verify VolumeSnapshot CRDs are installed
kubectl get crd | grep snapshot.storage.k8s.io
# Expected output:
# volumesnapshotclasses.snapshot.storage.k8s.io
# volumesnapshotcontents.snapshot.storage.k8s.io
# volumesnapshots.snapshot.storage.k8s.io

# Check snapshot controller is running
kubectl get pods -n kube-system | grep snapshot-controller

# Verify CSI driver is deployed and registered
kubectl get csidrivers
```

If the VolumeSnapshot CRDs are missing, install them:

```bash
# Install snapshot CRDs (use version matching your Kubernetes version)
SNAPSHOTTER_VERSION=v6.3.0

kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Deploy the snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

## Section 2: VolumeSnapshotClass Configuration per Provider

### AWS EBS CSI VolumeSnapshotClass

The AWS EBS CSI driver requires a VolumeSnapshotClass that specifies snapshot creation behavior:

```yaml
# aws-ebs-volumesnapshotclass.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: aws-ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
  annotations:
    # Mark as default for Velero if desired
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  # Optional: add tags to EBS snapshots
  tagSpecification_1: "key=Environment,value=production"
  tagSpecification_2: "key=BackupTool,value=velero"
  tagSpecification_3: "key=ManagedBy,value=kubernetes"
  # CSI snapshot type (standard or archive for cost optimization)
  type: standard
```

```bash
kubectl apply -f aws-ebs-volumesnapshotclass.yaml

# Verify
kubectl get volumesnapshotclass aws-ebs-vsc -o yaml
```

For encrypted EBS volumes, ensure the IAM role attached to the EBS CSI driver has the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateSnapshot",
        "ec2:CreateSnapshots",
        "ec2:DeleteSnapshot",
        "ec2:DescribeSnapshots",
        "ec2:DescribeSnapshotAttribute",
        "ec2:ModifySnapshotAttribute",
        "ec2:CopySnapshot"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:GenerateDataKeyWithoutPlaintext",
        "kms:CreateGrant"
      ],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<kms-key-id>"
    }
  ]
}
```

### GCP Persistent Disk CSI VolumeSnapshotClass

```yaml
# gcp-pd-volumesnapshotclass.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: gcp-pd-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Retain
parameters:
  # Snapshot storage location
  storage-locations: us-central1
  # Labels applied to GCP snapshots
  labels: '{"environment":"production","backup-tool":"velero"}'
```

For GKE Autopilot or Workload Identity, ensure the Kubernetes service account used by the PD CSI driver has the necessary GCP permissions:

```bash
# Bind the required role to the CSI driver service account
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:PROJECT_ID.svc.id.goog[kube-system/pdcsi-node-sa]" \
  --role="roles/compute.storageAdmin"

# Verify snapshot class
kubectl get volumesnapshotclass gcp-pd-vsc -o yaml
```

### Azure Disk CSI VolumeSnapshotClass

```yaml
# azure-disk-volumesnapshotclass.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: azure-disk-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: disk.csi.azure.com
deletionPolicy: Retain
parameters:
  # Incremental snapshots (recommended for cost efficiency)
  incremental: "true"
  # Resource group for snapshots (optional, defaults to node resource group)
  resourceGroup: "my-snapshot-rg"
  # Tags applied to Azure snapshots
  tags: "environment=production,backup-tool=velero"
```

```bash
# Verify Azure CSI driver supports snapshots
kubectl get csidrivers disk.csi.azure.com -o jsonpath='{.spec.volumeLifecycleModes}'

kubectl apply -f azure-disk-volumesnapshotclass.yaml
```

## Section 3: Velero Installation with CSI Plugin

### Installing Velero with the CSI Plugin

```bash
# Install Velero CLI
VELERO_VERSION=v1.13.0
curl -L "https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-amd64.tar.gz" | tar xz
sudo mv velero-${VELERO_VERSION}-linux-amd64/velero /usr/local/bin/

# Create credentials file for AWS (example)
cat > /tmp/velero-credentials << 'EOF'
[default]
aws_access_key_id = <aws-access-key-id>
aws_secret_access_key = <aws-secret-access-key>
EOF

# Install Velero on AWS EKS with CSI plugin enabled
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0,velero/velero-plugin-for-csi:v0.7.0 \
  --bucket my-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --secret-file /tmp/velero-credentials \
  --features=EnableCSI \
  --use-node-agent \
  --default-volumes-to-fs-backup=false
```

For GKE with Workload Identity:

```bash
# Create GCS bucket for Velero backup storage
gsutil mb -p PROJECT_ID -c STANDARD -l US-CENTRAL1 gs://my-velero-backups/

# Create service account for Velero
gcloud iam service-accounts create velero \
  --display-name "Velero service account"

# Bind permissions
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member serviceAccount:velero@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/storage.admin

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member serviceAccount:velero@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/compute.storageAdmin

# Annotate the Velero service account for Workload Identity
kubectl annotate serviceaccount velero \
  -n velero \
  iam.gke.io/gcp-service-account=velero@PROJECT_ID.iam.gserviceaccount.com

# Install
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.9.0,velero/velero-plugin-for-csi:v0.7.0 \
  --bucket my-velero-backups \
  --no-secret \
  --features=EnableCSI \
  --use-node-agent
```

### Verifying the Installation

```bash
# Check Velero pods
kubectl get pods -n velero

# Verify CSI plugin is loaded
kubectl logs deployment/velero -n velero | grep -i csi

# Check BackupStorageLocation status
kubectl get backupstoragelocation -n velero

# Test connectivity
velero backup-location get
```

### Configuring BackupStorageLocation and VolumeSnapshotLocation

```yaml
# velero-storage-locations.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-velero-backups
    prefix: cluster-prod
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
    checksumAlgorithm: ""
---
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
```

## Section 4: Backup Schedules with CSI Snapshots

### Basic PVC Backup with CSI

Create a backup that explicitly uses CSI snapshots:

```yaml
# velero-backup-csi.yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: production-backup-csi
  namespace: velero
spec:
  # Namespaces to back up
  includedNamespaces:
    - production
    - databases
  # Exclude system namespaces
  excludedNamespaces:
    - kube-system
    - kube-public
  # Include all resources
  includedResources: []
  # CSI snapshot configuration
  snapshotVolumes: true
  # Do NOT use file system backup for volumes with CSI snapshots
  defaultVolumesToFsBackup: false
  # TTL for the backup
  ttl: 720h0m0s
  # Labels for organization
  labels:
    backup-type: csi-snapshot
    environment: production
  # Storage location
  storageLocation: default
  volumeSnapshotLocations:
    - default
```

```bash
velero backup create production-csi-backup \
  --include-namespaces production,databases \
  --snapshot-volumes \
  --default-volumes-to-fs-backup=false \
  --ttl 720h \
  --wait

# Monitor backup progress
velero backup describe production-csi-backup --details

# Check VolumeSnapshot objects created
kubectl get volumesnapshots -n production
kubectl get volumesnapshots -n databases
```

### Scheduled Backups

```yaml
# velero-schedule.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-daily-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  useOwnerReferencesInBackup: false
  template:
    includedNamespaces:
      - production
      - databases
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    ttl: 720h0m0s
    storageLocation: default
    volumeSnapshotLocations:
      - default
    hooks:
      resources:
        - name: postgres-backup-hook
          includedNamespaces:
            - databases
          labelSelector:
            matchLabels:
              app: postgresql
          pre:
            - exec:
                container: postgres
                command:
                  - /bin/bash
                  - -c
                  - psql -U postgres -c "CHECKPOINT;"
                onError: Fail
                timeout: 60s
          post:
            - exec:
                container: postgres
                command:
                  - /bin/bash
                  - -c
                  - echo "Snapshot complete"
                onError: Continue
                timeout: 30s
---
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-weekly-backup
  namespace: velero
spec:
  schedule: "0 1 * * 0"  # 1 AM every Sunday
  template:
    includedNamespaces:
      - production
      - databases
      - monitoring
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    ttl: 2160h0m0s  # 90 days
    storageLocation: default
    volumeSnapshotLocations:
      - default
```

```bash
kubectl apply -f velero-schedule.yaml

# Verify schedules
velero schedule get

# Manually trigger a scheduled backup
velero backup create --from-schedule production-daily-backup
```

## Section 5: Pre and Post Hooks for Application Quiescing

### Understanding Hook Execution Model

Velero hooks run inside the application containers before (pre) and after (post) snapshot creation. This is critical for stateful applications where in-memory state must be flushed to disk before a consistent snapshot can be taken.

The hook execution order is:
1. Pre-hooks execute in all matching pods
2. Velero creates the VolumeSnapshot object
3. CSI driver triggers cloud snapshot (typically async)
4. Post-hooks execute in all matching pods
5. Backup completes once snapshot is confirmed ready

### PostgreSQL Quiescing Hooks

For PostgreSQL, the pre-hook should issue a `CHECKPOINT` to flush WAL buffers:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgresql-0
  namespace: databases
  annotations:
    # Pre-backup hook: flush to disk
    pre.hook.backup.velero.io/container: postgres
    pre.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c", "psql -U postgres -c 'CHECKPOINT;' && psql -U postgres -c 'SELECT pg_start_backup(''velero'', true);'"]
    pre.hook.backup.velero.io/on-error: Fail
    pre.hook.backup.velero.io/timeout: 120s
    # Post-backup hook: resume normal operation
    post.hook.backup.velero.io/container: postgres
    post.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c", "psql -U postgres -c 'SELECT pg_stop_backup();'"]
    post.hook.backup.velero.io/on-error: Continue
    post.hook.backup.velero.io/timeout: 60s
spec:
  containers:
    - name: postgres
      image: postgres:16
```

For StatefulSet deployments, annotate the pod template:

```yaml
# postgres-statefulset-with-hooks.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
      annotations:
        pre.hook.backup.velero.io/container: postgres
        pre.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c", "PGPASSWORD=$POSTGRES_PASSWORD psql -U postgres -c 'CHECKPOINT;'"]
        pre.hook.backup.velero.io/on-error: Fail
        pre.hook.backup.velero.io/timeout: 90s
        post.hook.backup.velero.io/container: postgres
        post.hook.backup.velero.io/command: >-
          ["/bin/bash", "-c", "echo 'Backup snapshot complete at $(date)'"]
        post.hook.backup.velero.io/on-error: Continue
        post.hook.backup.velero.io/timeout: 30s
    spec:
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
```

### MySQL/MariaDB Quiescing Hooks

```yaml
# mysql-hooks-annotation.yaml
# Applied to MySQL pod/StatefulSet template
annotations:
  pre.hook.backup.velero.io/container: mysql
  pre.hook.backup.velero.io/command: >-
    ["/bin/bash", "-c",
    "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'FLUSH TABLES WITH READ LOCK; FLUSH LOGS;'"]
  pre.hook.backup.velero.io/on-error: Fail
  pre.hook.backup.velero.io/timeout: 120s
  post.hook.backup.velero.io/container: mysql
  post.hook.backup.velero.io/command: >-
    ["/bin/bash", "-c",
    "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'UNLOCK TABLES;'"]
  post.hook.backup.velero.io/on-error: Continue
  post.hook.backup.velero.io/timeout: 30s
```

### Elasticsearch Quiescing Hooks

```yaml
annotations:
  pre.hook.backup.velero.io/container: elasticsearch
  pre.hook.backup.velero.io/command: >-
    ["/bin/bash", "-c",
    "curl -s -X PUT 'localhost:9200/_cluster/settings' -H 'Content-Type: application/json' -d '{\"persistent\":{\"cluster.routing.allocation.enable\":\"primaries\"}}' && curl -s -X POST 'localhost:9200/_flush/synced'"]
  pre.hook.backup.velero.io/on-error: Fail
  pre.hook.backup.velero.io/timeout: 180s
  post.hook.backup.velero.io/container: elasticsearch
  post.hook.backup.velero.io/command: >-
    ["/bin/bash", "-c",
    "curl -s -X PUT 'localhost:9200/_cluster/settings' -H 'Content-Type: application/json' -d '{\"persistent\":{\"cluster.routing.allocation.enable\":\"all\"}}'"]
  post.hook.backup.velero.io/on-error: Continue
  post.hook.backup.velero.io/timeout: 30s
```

### Hook-Based Backup via BackupSpec

Alternatively, define hooks at the Backup or Schedule level rather than annotating individual pods:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: databases-backup-with-hooks
  namespace: velero
spec:
  includedNamespaces:
    - databases
  snapshotVolumes: true
  defaultVolumesToFsBackup: false
  hooks:
    resources:
      - name: postgres-quiesce
        includedNamespaces:
          - databases
        labelSelector:
          matchLabels:
            app: postgresql
            role: primary
        pre:
          - exec:
              container: postgres
              command:
                - /bin/bash
                - -c
                - |
                  PGPASSWORD="${POSTGRES_PASSWORD}" psql -U postgres << 'EOSQL'
                  CHECKPOINT;
                  EOSQL
              onError: Fail
              timeout: 90s
        post:
          - exec:
              container: postgres
              command:
                - /bin/bash
                - -c
                - echo "CSI snapshot triggered at $(date)"
              onError: Continue
              timeout: 30s
      - name: redis-bgsave
        includedNamespaces:
          - databases
        labelSelector:
          matchLabels:
            app: redis
        pre:
          - exec:
              container: redis
              command:
                - redis-cli
                - BGSAVE
              onError: Fail
              timeout: 120s
```

## Section 6: Backup Verification Workflow

### Automated Backup Verification

Production environments require verification that backups are actually restorable. This involves restoring to a test namespace and validating the data:

```bash
#!/bin/bash
# backup-verification.sh
# Automated backup verification script for Velero CSI backups

set -euo pipefail

BACKUP_NAME="${1:-}"
VERIFY_NAMESPACE="velero-verify-$(date +%Y%m%d%H%M%S)"
TIMEOUT=600

if [[ -z "${BACKUP_NAME}" ]]; then
  # Use most recent backup
  BACKUP_NAME=$(velero backup get --output json | \
    jq -r '[.items[] | select(.status.phase == "Completed")] | sort_by(.metadata.creationTimestamp) | last | .metadata.name')
fi

echo "Verifying backup: ${BACKUP_NAME}"
echo "Target namespace: ${VERIFY_NAMESPACE}"

# Step 1: Check backup status
BACKUP_STATUS=$(velero backup describe "${BACKUP_NAME}" --output json | jq -r '.status.phase')
if [[ "${BACKUP_STATUS}" != "Completed" ]]; then
  echo "ERROR: Backup ${BACKUP_NAME} is in state ${BACKUP_STATUS}, not Completed"
  exit 1
fi

# Step 2: Verify VolumeSnapshots are ready
echo "Checking VolumeSnapshot readiness..."
SNAPSHOTS=$(kubectl get volumesnapshot -A -l \
  "velero.io/backup-name=${BACKUP_NAME}" \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}={.status.readyToUse}{"\n"}{end}')

echo "${SNAPSHOTS}"
FAILED_SNAPS=$(echo "${SNAPSHOTS}" | grep "=false" || true)
if [[ -n "${FAILED_SNAPS}" ]]; then
  echo "ERROR: Some VolumeSnapshots are not ready:"
  echo "${FAILED_SNAPS}"
  exit 1
fi

# Step 3: Perform test restore to isolated namespace
echo "Initiating test restore to ${VERIFY_NAMESPACE}..."
velero restore create "verify-${BACKUP_NAME}" \
  --from-backup "${BACKUP_NAME}" \
  --namespace-mappings "production:${VERIFY_NAMESPACE}" \
  --restore-volumes \
  --wait

# Step 4: Verify restore status
RESTORE_STATUS=$(velero restore describe "verify-${BACKUP_NAME}" --output json | jq -r '.status.phase')
if [[ "${RESTORE_STATUS}" != "Completed" ]]; then
  echo "ERROR: Restore failed with status: ${RESTORE_STATUS}"
  velero restore describe "verify-${BACKUP_NAME}" --details
  exit 1
fi

# Step 5: Verify PVCs are bound in test namespace
echo "Checking PVC status in ${VERIFY_NAMESPACE}..."
UNBOUND_PVCS=$(kubectl get pvc -n "${VERIFY_NAMESPACE}" \
  -o jsonpath='{range .items[*]}{.metadata.name}: {.status.phase}{"\n"}{end}' | \
  grep -v "Bound" || true)

if [[ -n "${UNBOUND_PVCS}" ]]; then
  echo "WARNING: Some PVCs are not bound:"
  echo "${UNBOUND_PVCS}"
fi

# Step 6: Run application-specific data validation
echo "Running data validation..."
# Example: Check PostgreSQL can start and query
if kubectl get pods -n "${VERIFY_NAMESPACE}" -l app=postgresql &>/dev/null; then
  # Wait for pods to be ready
  kubectl wait --for=condition=Ready pods \
    -l app=postgresql \
    -n "${VERIFY_NAMESPACE}" \
    --timeout="${TIMEOUT}s"

  # Run a simple query to validate data integrity
  kubectl exec -n "${VERIFY_NAMESPACE}" \
    deployment/postgresql -- \
    psql -U postgres -c "SELECT count(*) FROM pg_stat_user_tables;" || \
    echo "WARNING: PostgreSQL validation query failed"
fi

# Step 7: Cleanup test namespace
echo "Cleaning up test namespace ${VERIFY_NAMESPACE}..."
kubectl delete namespace "${VERIFY_NAMESPACE}" --wait=false

echo "Backup verification completed successfully for: ${BACKUP_NAME}"
```

### VolumeSnapshot Readiness Check

```bash
# check-snapshot-readiness.sh
# Monitor CSI VolumeSnapshot readiness after backup

BACKUP_NAME="$1"
TIMEOUT=300
INTERVAL=10
ELAPSED=0

echo "Waiting for VolumeSnapshots from backup ${BACKUP_NAME} to be ready..."

while [[ ${ELAPSED} -lt ${TIMEOUT} ]]; do
  TOTAL=$(kubectl get volumesnapshot -A \
    -l "velero.io/backup-name=${BACKUP_NAME}" \
    --no-headers | wc -l)

  READY=$(kubectl get volumesnapshot -A \
    -l "velero.io/backup-name=${BACKUP_NAME}" \
    -o jsonpath='{range .items[*]}{.status.readyToUse}{"\n"}{end}' | \
    grep -c "true" || true)

  echo "Progress: ${READY}/${TOTAL} VolumeSnapshots ready (${ELAPSED}s elapsed)"

  if [[ "${READY}" -eq "${TOTAL}" ]] && [[ "${TOTAL}" -gt 0 ]]; then
    echo "All ${TOTAL} VolumeSnapshots are ready!"

    # Print snapshot details
    kubectl get volumesnapshot -A \
      -l "velero.io/backup-name=${BACKUP_NAME}" \
      -o custom-columns=\
"NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
READY:.status.readyToUse,\
SIZE:.status.restoreSize,\
CREATED:.metadata.creationTimestamp"
    exit 0
  fi

  sleep ${INTERVAL}
  ELAPSED=$((ELAPSED + INTERVAL))
done

echo "ERROR: Timeout waiting for VolumeSnapshots to be ready"
kubectl get volumesnapshot -A \
  -l "velero.io/backup-name=${BACKUP_NAME}" \
  -o yaml
exit 1
```

## Section 7: Cross-Zone and Cross-Region Restore Procedures

### Understanding Snapshot Portability Constraints

EBS snapshots are region-scoped, not zone-scoped. GCP PD snapshots are global within a project. Azure Disk snapshots exist in a resource group. For cross-zone restores within the same region, no additional configuration is needed — the CSI driver handles zone selection. Cross-region restores require explicit snapshot copying.

### Cross-Zone Restore (Same Region)

For cross-zone restore within a region, the StorageClass must allow dynamic zone selection:

```yaml
# cross-zone-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3-cross-zone
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
# No zone restrictions - let scheduler pick
```

When performing a cross-zone restore with Velero, use namespace mapping and specify the target zone via node affinity in a PVC override:

```bash
# Restore to a different availability zone
velero restore create cross-zone-restore \
  --from-backup production-backup-csi \
  --include-namespaces production \
  --namespace-mappings "production:production-restored" \
  --restore-volumes \
  --wait

# After restore, verify PVCs are in target zone
kubectl get pvc -n production-restored \
  -o jsonpath='{range .items[*]}{.metadata.name}: {.metadata.annotations.volume\.beta\.kubernetes\.io/storage-provisioner}{"\n"}{end}'
```

### Cross-Region Restore Procedure

For AWS cross-region restores:

```bash
#!/bin/bash
# cross-region-restore.sh
# Copies EBS snapshots to a different region and configures Velero for restore

SOURCE_REGION="us-east-1"
TARGET_REGION="us-west-2"
SOURCE_BACKUP="production-backup-csi"
TARGET_BUCKET="my-velero-backups-west"

# Step 1: Copy backup metadata to target region's S3 bucket
aws s3 sync \
  "s3://my-velero-backups/cluster-prod/${SOURCE_BACKUP}" \
  "s3://${TARGET_BUCKET}/cluster-prod/${SOURCE_BACKUP}" \
  --source-region "${SOURCE_REGION}" \
  --region "${TARGET_REGION}"

# Step 2: Get VolumeSnapshotContent snapshot handles from backup
SNAPSHOT_IDS=$(kubectl get volumesnapshotcontent -A \
  -l "velero.io/backup-name=${SOURCE_BACKUP}" \
  -o jsonpath='{range .items[*]}{.status.snapshotHandle}{"\n"}{end}')

# Step 3: Copy each EBS snapshot to target region
for SNAPSHOT_ID in ${SNAPSHOT_IDS}; do
  echo "Copying snapshot ${SNAPSHOT_ID} to ${TARGET_REGION}..."
  NEW_SNAPSHOT_ID=$(aws ec2 copy-snapshot \
    --source-region "${SOURCE_REGION}" \
    --source-snapshot-id "${SNAPSHOT_ID}" \
    --destination-region "${TARGET_REGION}" \
    --description "Cross-region copy for Velero restore" \
    --query 'SnapshotId' \
    --output text)

  echo "New snapshot in ${TARGET_REGION}: ${NEW_SNAPSHOT_ID}"

  # Wait for copy to complete
  aws ec2 wait snapshot-completed \
    --region "${TARGET_REGION}" \
    --snapshot-ids "${NEW_SNAPSHOT_ID}"

  echo "Snapshot ${NEW_SNAPSHOT_ID} is ready in ${TARGET_REGION}"
done

echo "Cross-region snapshot copy complete. Configure target cluster Velero to use ${TARGET_BUCKET}"
```

### Restore with Resource Modifications

Use RestoreItemAction plugins to modify resources during restore (e.g., changing StorageClass for a different region):

```yaml
# velero-restore-cross-region.yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: cross-region-production-restore
  namespace: velero
spec:
  backupName: production-backup-csi
  includedNamespaces:
    - production
  restorePVs: true
  # Preserve node ports if needed
  preserveNodePorts: false
  # Map old StorageClass to new region's StorageClass
  restoreStatus:
    includedResources: []
  # Exclude objects that should not be restored
  excludedResources:
    - nodes
    - events
    - events.events.k8s.io
    - backups.velero.io
    - restores.velero.io
    - resticrepositories.velero.io
  # Overwrite existing resources
  existingResourcePolicy: update
```

## Section 8: Troubleshooting CSI Snapshot Issues

### Common Issues and Resolutions

**VolumeSnapshot stuck in "ReadyToUse: false"**

```bash
# Check VolumeSnapshot status
kubectl describe volumesnapshot <snapshot-name> -n <namespace>

# Check VolumeSnapshotContent
kubectl describe volumesnapshotcontent <content-name>

# Check CSI driver logs
kubectl logs -n kube-system -l app=ebs-csi-controller -c csi-snapshotter --tail=100

# For AWS EBS: check if snapshot exists in AWS
aws ec2 describe-snapshots \
  --filters "Name=tag:kubernetes.io/created-for/pvc/name,Values=<pvc-name>" \
  --region us-east-1
```

**Velero backup shows "PartiallyFailed"**

```bash
# Get detailed backup description
velero backup describe <backup-name> --details

# Check Velero logs
kubectl logs deployment/velero -n velero --tail=200 | grep -E "ERROR|WARN|snapshot"

# Check VolumeSnapshotLocation accessibility
velero snapshot-location get

# Validate CSI feature flag is enabled
kubectl get deployment velero -n velero -o yaml | grep -A5 features
```

**Restore PVC fails to bind**

```bash
# Check restore status
velero restore describe <restore-name> --details

# Check VolumeSnapshotContent created during restore
kubectl get volumesnapshotcontent -A | grep restore

# Check PVC events
kubectl describe pvc <pvc-name> -n <namespace>

# Verify the VolumeSnapshotClass driver matches the StorageClass provisioner
kubectl get volumesnapshotclass
kubectl get storageclass
```

### Velero CSI Snapshot Metrics

```yaml
# prometheus-velero-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-backup-alerts
  namespace: monitoring
spec:
  groups:
    - name: velero.backup
      interval: 60s
      rules:
        - alert: VeleroBackupFailure
          expr: |
            velero_backup_failure_total > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failure detected"
            description: "Backup {{ $labels.schedule }} has failed {{ $value }} times"

        - alert: VeleroBackupMissing
          expr: |
            time() - velero_backup_last_successful_timestamp > 86400
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "No successful Velero backup in 24 hours"
            description: "Schedule {{ $labels.schedule }} last succeeded over 24h ago"

        - alert: VolumeSnapshotNotReady
          expr: |
            kube_volumesnapshot_info{ready_to_use="false"} > 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "VolumeSnapshot not ready"
            description: "VolumeSnapshot {{ $labels.volumesnapshot }} in {{ $labels.namespace }} is not ready"
```

## Section 9: Production Best Practices

### Backup Retention Policies

```yaml
# velero-schedule-tiered-retention.yaml
# Hot backup: hourly, 24h retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: prod-hourly
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    includedNamespaces: [production]
    snapshotVolumes: true
    ttl: 24h0m0s
    storageLocation: default
---
# Warm backup: daily, 7-day retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: prod-daily
  namespace: velero
spec:
  schedule: "0 3 * * *"
  template:
    includedNamespaces: [production, databases]
    snapshotVolumes: true
    ttl: 168h0m0s  # 7 days
    storageLocation: default
---
# Cold backup: weekly, 90-day retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: prod-weekly
  namespace: velero
spec:
  schedule: "0 1 * * 0"
  template:
    includedNamespaces: [production, databases, monitoring]
    snapshotVolumes: true
    ttl: 2160h0m0s  # 90 days
    storageLocation: default
```

### Resource Annotations for Selective Backup

```yaml
# Opt out specific PVCs from snapshot backup
# (use filesystem backup instead for these)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cache-volume
  namespace: production
  annotations:
    # Skip CSI snapshot for this PVC, use restic/kopia instead
    backup.velero.io/backup-volumes-excludes: cache-volume
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ebs-gp3
  resources:
    requests:
      storage: 10Gi
```

### Namespace-Level Backup Configuration

```yaml
# Apply to namespace for cluster-wide backup defaults
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    velero.io/backup: "true"
  annotations:
    # Default backup schedule
    velero.io/backup-schedule: prod-daily
    # Use CSI snapshots for all PVCs in this namespace
    velero.io/snapshot-volumes: "true"
```

### Monitoring Dashboard Configuration

```bash
# Import Velero Grafana dashboard
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: velero-grafana-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  velero-dashboard.json: |
    {
      "title": "Velero Backup Status",
      "panels": [
        {
          "title": "Backup Success Rate",
          "type": "stat",
          "targets": [
            {
              "expr": "rate(velero_backup_success_total[1h]) / (rate(velero_backup_success_total[1h]) + rate(velero_backup_failure_total[1h])) * 100"
            }
          ]
        },
        {
          "title": "Last Backup Duration",
          "type": "gauge",
          "targets": [
            {
              "expr": "velero_backup_duration_seconds{quantile=\"0.99\"}"
            }
          ]
        }
      ]
    }
EOF
```

## Conclusion

Velero CSI snapshot integration provides a robust, provider-agnostic backup mechanism for Kubernetes stateful workloads. The key operational elements are: proper VolumeSnapshotClass configuration per provider with appropriate deletion policies, application quiescing via pre/post hooks to ensure data consistency, automated verification workflows that test actual restorability rather than just backup completion, and tiered retention schedules that balance cost with recovery point objectives.

The most common production failures stem from missing pre-hooks on databases (leading to inconsistent snapshots), insufficient IAM permissions for the CSI driver to create cloud-side snapshots, and missing verification that snapshots are actually in a `readyToUse: true` state before marking backups as successful. Investing in the verification automation described in Section 6 pays dividends when a real disaster strikes.
