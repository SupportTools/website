---
title: "Velero Backup Strategies: Volume Snapshots, Restic, and Cross-Cluster Migration"
date: 2028-12-19T00:00:00-05:00
draft: false
tags: ["Velero", "Kubernetes", "Backup", "Disaster Recovery", "Volume Snapshots", "Migration"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Velero backup strategies covering CSI volume snapshots, Kopia-based file system backups, backup schedules, retention policies, and production cross-cluster migration patterns for Kubernetes workloads."
more_link: "yes"
url: "/velero-backup-strategies-volume-snapshots-restic-cross-cluster-guide/"
---

Kubernetes cluster backup and disaster recovery is a deceptively complex problem. Unlike traditional VM snapshots that capture an entire host, Kubernetes workloads are distributed across cluster resources: application state in PersistentVolumes, configuration in ConfigMaps and Secrets, custom resources from dozens of operators, and inter-resource dependencies that must be restored in the correct order. Velero addresses this complexity by providing namespace-aware, application-consistent backup with pluggable storage backends and volume snapshot integrations.

This guide covers the complete Velero operational picture: installation and configuration for AWS, GCP, and bare-metal environments, CSI snapshot-based volume backup, Kopia file-level backup for volumes without snapshot support, backup schedules and retention policies, backup hooks for application consistency, and tested cross-cluster migration procedures for production workloads.

<!--more-->

## Velero Architecture

Velero consists of:

- **Server**: A Deployment running in the `velero` namespace that watches for `Backup`, `Restore`, `Schedule`, and related CRD objects
- **Plugins**: Provider-specific plugins for object storage (S3, GCS, Azure Blob) and volume snapshots (AWS EBS, GCP PD, Azure Disk, CSI)
- **Node Agent**: A DaemonSet (formerly Restic) that runs file-level backups using Kopia for volumes that cannot use CSI snapshots

### Backup Workflow

1. User creates a `Backup` object (or a `Schedule` creates one automatically)
2. Velero server queries the Kubernetes API for all resources in the target namespace(s)
3. Resource manifests are serialized to JSON and uploaded to object storage
4. For each PersistentVolumeClaim, Velero either:
   a. Creates a CSI VolumeSnapshot (if using CSI snapshot integration), or
   b. Invokes the node agent to copy volume contents to object storage (Kopia mode)
5. A `BackupStorageLocation` manifest is created in object storage pointing to the backup contents

### Restore Workflow

1. User creates a `Restore` object referencing a specific backup
2. Velero downloads resource manifests from object storage
3. Resources are recreated in the cluster, skipping excluded resources (namespaces, nodes, etc.)
4. For volumes: either restores from VolumeSnapshot or downloads from object storage via the node agent

## Installation and Configuration

### AWS S3 + EBS Snapshot Setup

```bash
# Install Velero CLI
curl -L https://github.com/vmware-tanzu/velero/releases/download/v1.14.0/velero-v1.14.0-linux-amd64.tar.gz | tar xz
sudo mv velero-v1.14.0-linux-amd64/velero /usr/local/bin/
velero version --client-only

# Create S3 bucket for backups
aws s3api create-bucket \
  --bucket velero-backups-prod-$(aws sts get-caller-identity --query Account --output text) \
  --region us-east-1

# Enable versioning for additional protection
aws s3api put-bucket-versioning \
  --bucket velero-backups-prod-123456789012 \
  --versioning-configuration Status=Enabled

# Create IAM policy for Velero
cat > velero-iam-policy.json << 'EOF'
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
      "Resource": "arn:aws:s3:::velero-backups-prod-123456789012/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::velero-backups-prod-123456789012"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name VeleroBackupPolicy \
  --policy-document file://velero-iam-policy.json
```

```bash
# Install Velero with IRSA (IAM Roles for Service Accounts)
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-backups-prod-123456789012 \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --pod-annotations iam.amazonaws.com/role=arn:aws:iam::123456789012:role/VeleroRole \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --uploader-type kopia \
  --namespace velero \
  --features=EnableCSI
```

### GCP Setup

```bash
# Create GCS bucket
gsutil mb -p my-gcp-project -c STANDARD -l us-central1 gs://velero-backups-prod-my-gcp-project/

# Create service account
gcloud iam service-accounts create velero \
  --display-name "Velero service account" \
  --project my-gcp-project

# Grant required permissions
gcloud projects add-iam-policy-binding my-gcp-project \
  --member serviceAccount:velero@my-gcp-project.iam.gserviceaccount.com \
  --role roles/compute.storageAdmin

gsutil iam ch serviceAccount:velero@my-gcp-project.iam.gserviceaccount.com:objectAdmin \
  gs://velero-backups-prod-my-gcp-project/

# Create and download service account key
gcloud iam service-accounts keys create credentials-velero.json \
  --iam-account velero@my-gcp-project.iam.gserviceaccount.com

# Install Velero for GCP
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.10.0 \
  --bucket velero-backups-prod-my-gcp-project \
  --secret-file ./credentials-velero.json \
  --use-node-agent \
  --uploader-type kopia \
  --features=EnableCSI
```

### Bare-Metal with MinIO

```yaml
# MinIO deployment for on-premises backup storage
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: velero-storage
spec:
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    spec:
      containers:
      - name: minio
        image: minio/minio:RELEASE.2028-01-01T00-00-00Z
        command:
        - /bin/bash
        - -c
        args:
        - minio server /data --console-address :9001
        env:
        - name: MINIO_ROOT_USER
          valueFrom:
            secretKeyRef:
              name: minio-credentials
              key: access-key
        - name: MINIO_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: minio-credentials
              key: secret-key
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: minio-data
```

```bash
# Install Velero with MinIO backend
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-backups \
  --secret-file ./minio-credentials.txt \
  --backup-location-config \
    region=minio,s3ForcePathStyle=true,s3Url=http://minio.velero-storage.svc.cluster.local:9000 \
  --use-node-agent \
  --uploader-type kopia \
  --features=EnableCSI
```

## CSI Volume Snapshots

CSI volume snapshots create point-in-time copies of PersistentVolumes at the storage layer, providing near-zero RPO for supported storage drivers.

### Prerequisites

```bash
# Install CSI snapshot controller and CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.0/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.0/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### VolumeSnapshotClass Configuration

```yaml
# For AWS EBS CSI driver
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-aws-vsc
  labels:
    # This label tells Velero to use this class for CSI snapshots
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Delete
parameters:
  tagSpecification_1: "key=velero.io/backup-name,value={{ .VolumeSnapshotName }}"
---
# For GCP Persistent Disk CSI driver
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-gcp-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Delete
---
# For Longhorn
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

## Backup Schedules and Retention

### Production Backup Schedule Strategy

```yaml
# Hourly backup of critical namespaces, retain 48 hours
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: critical-namespaces-hourly
  namespace: velero
spec:
  schedule: "0 * * * *"  # Every hour
  useOwnerReferencesInBackup: false
  template:
    includedNamespaces:
    - payments
    - orders
    - inventory
    labelSelector:
      matchExpressions:
      - key: backup-tier
        operator: In
        values: ["critical"]
    storageLocation: default
    volumeSnapshotLocations:
    - default
    ttl: 48h0m0s
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    hooks:
      resources:
      - name: postgres-backup-hook
        includedNamespaces:
        - payments
        labelSelector:
          matchLabels:
            app: postgres
        pre:
        - exec:
            container: postgres
            command:
            - /bin/bash
            - -c
            - "pg_dump -U $POSTGRES_USER $POSTGRES_DB > /backup/pre-backup.sql && echo 'Pre-backup dump complete'"
            timeout: 5m
            onError: Fail
        post:
        - exec:
            container: postgres
            command:
            - /bin/bash
            - -c
            - "rm -f /backup/pre-backup.sql && echo 'Cleaned up pre-backup dump'"
            timeout: 1m
            onError: Continue
---
# Daily backup of all namespaces, retain 30 days
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: all-namespaces-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  template:
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    storageLocation: default
    volumeSnapshotLocations:
    - default
    ttl: 720h0m0s  # 30 days
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    metadata:
      labels:
        backup-type: "daily"
        cluster: "prod-us-east-1"
---
# Weekly backup to secondary storage location for offsite retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-offsite
  namespace: velero
spec:
  schedule: "0 3 * * 0"  # 3 AM Sunday
  template:
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    storageLocation: offsite-s3  # Different bucket/region
    volumeSnapshotLocations:
    - offsite
    ttl: 8760h0m0s  # 1 year
    snapshotVolumes: true
    defaultVolumesToFsBackup: true  # Full file-level backup for offsite
```

### Multiple Backup Storage Locations

```yaml
# Primary storage location (same region)
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-prod-123456789012
    prefix: cluster-prod-us-east-1
  config:
    region: us-east-1
  default: true
  accessMode: ReadWrite
---
# Offsite storage location (different region for DR)
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: offsite-s3
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-dr-backups-123456789012
    prefix: cluster-prod-us-east-1
  config:
    region: us-west-2
  accessMode: ReadWrite
```

## Kopia File-Level Backup (Node Agent)

For volumes that cannot use CSI snapshots (e.g., NFS, in-tree provisioners, or when consistent snapshots are not available), Velero uses the node agent with Kopia to perform file-level backup:

### Enabling per-Volume File Backup

```yaml
# Opt in a specific PVC to file-level backup via annotation
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: elasticsearch-data
  namespace: logging
  annotations:
    # Force file-level backup even if CSI snapshots are available
    backup.velero.io/backup-volumes: elasticsearch-data
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3
  resources:
    requests:
      storage: 500Gi
```

```yaml
# Pod annotation to include all volumes in file backup
apiVersion: v1
kind: Pod
metadata:
  name: elasticsearch-0
  namespace: logging
  annotations:
    backup.velero.io/backup-volumes: elasticsearch-data,elasticsearch-logs
```

### Kopia Repository Configuration

```yaml
# Node Agent configuration for Kopia
apiVersion: v1
kind: ConfigMap
metadata:
  name: velero-node-agent
  namespace: velero
data:
  # Kopia compression for volume backups
  compression: "zstd"
  # Parallel uploads
  uploaderConcurrency: "4"
```

## Application-Consistent Backups with Hooks

For stateful applications, backup hooks ensure consistency by quiescing writes before snapshot creation:

### MySQL Backup Hook

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: mysql-consistent-backup
  namespace: velero
spec:
  includedNamespaces:
  - databases
  labelSelector:
    matchLabels:
      app: mysql
  hooks:
    resources:
    - name: mysql-quiesce
      includedNamespaces:
      - databases
      labelSelector:
        matchLabels:
          app: mysql
      pre:
      - exec:
          container: mysql
          command:
          - /bin/bash
          - -c
          - |
            mysql -u root -p$MYSQL_ROOT_PASSWORD \
              -e "FLUSH TABLES WITH READ LOCK; FLUSH LOGS;" && \
            echo "MySQL quiesced"
          timeout: 2m
          onError: Fail
      post:
      - exec:
          container: mysql
          command:
          - /bin/bash
          - -c
          - |
            mysql -u root -p$MYSQL_ROOT_PASSWORD \
              -e "UNLOCK TABLES;" && \
            echo "MySQL unlocked"
          timeout: 30s
          onError: Continue
```

### MongoDB Backup Hook

```yaml
hooks:
  resources:
  - name: mongodb-fsync
    pre:
    - exec:
        container: mongodb
        command:
        - /bin/bash
        - -c
        - |
          mongosh --quiet --eval \
            'db.adminCommand({fsync: 1, lock: true})' \
          admin --username $MONGO_INITDB_ROOT_USERNAME \
               --password $MONGO_INITDB_ROOT_PASSWORD && \
          echo "MongoDB fsync lock acquired"
        timeout: 3m
        onError: Fail
    post:
    - exec:
        container: mongodb
        command:
        - /bin/bash
        - -c
        - |
          mongosh --quiet --eval \
            'db.adminCommand({fsyncUnlock: 1})' \
          admin --username $MONGO_INITDB_ROOT_USERNAME \
               --password $MONGO_INITDB_ROOT_PASSWORD && \
          echo "MongoDB fsync lock released"
        timeout: 30s
        onError: Continue
```

## Cross-Cluster Migration

Migrating workloads between clusters (cloud-to-cloud, region-to-region, or on-prem to cloud) is one of Velero's most powerful use cases.

### Step 1: Configure Shared Object Storage

Both source and destination clusters must read from the same object storage location:

```bash
# On source cluster: create backup
velero backup create migration-payments-ns \
  --include-namespaces payments \
  --storage-location default \
  --snapshot-volumes \
  --wait

# Verify backup completed successfully
velero backup describe migration-payments-ns --details

# Check backup phase
velero backup get migration-payments-ns
# NAME                      STATUS     ERRORS   WARNINGS   CREATED   EXPIRES   STORAGE LOCATION
# migration-payments-ns     Completed  0        0          ...       ...       default
```

```bash
# On destination cluster: configure same storage location
# The destination cluster reads from the same S3 bucket
velero backup-location create source-cluster \
  --provider aws \
  --bucket velero-backups-prod-123456789012 \
  --config region=us-east-1 \
  --prefix cluster-prod-us-east-1 \
  --access-mode ReadOnly  # Read-only to prevent accidental writes

# Sync available backups from the source location
velero backup-location sync source-cluster

# Verify the migration backup is visible on the destination cluster
velero backup get
```

### Step 2: Restore with Namespace Remapping

```yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: migrate-payments-to-new-cluster
  namespace: velero
spec:
  backupName: migration-payments-ns

  # Remap namespaces: source namespace name -> destination namespace name
  namespaceMapping:
    payments: payments-migrated

  # Exclude resources that should not be migrated
  excludedResources:
  - nodes
  - events
  - events.events.k8s.io
  - backups.velero.io
  - restores.velero.io
  - resticrepositories.velero.io

  # Include only specific resource types (alternative to exclude list)
  # includedResources:
  # - deployments
  # - services
  # - configmaps
  # - secrets
  # - persistentvolumeclaims

  # Restore PV data
  restorePVs: true
  preserveNodePorts: false  # Reassign NodePorts to avoid conflicts

  # Label selector to migrate only a subset of resources
  # labelSelector:
  #   matchLabels:
  #     migrate: "true"

  hooks:
    resources:
    - name: post-restore-validation
      includedNamespaces:
      - payments-migrated
      post:
      - init:
          initContainers:
          - name: validate-db-connection
            image: postgres:16-alpine
            command:
            - /bin/sh
            - -c
            - |
              until pg_isready -h postgres -U $POSTGRES_USER; do
                echo "Waiting for PostgreSQL..."
                sleep 2
              done
              echo "Database is ready"
```

### Step 3: Validate the Migration

```bash
# Monitor restore progress
velero restore describe migrate-payments-to-new-cluster --details

# Check restore status
velero restore get

# Verify resources were created in the destination namespace
kubectl get all -n payments-migrated

# Verify PVCs are bound
kubectl get pvc -n payments-migrated

# Check for any failed resource restores
velero restore describe migrate-payments-to-new-cluster \
  --details 2>&1 | grep -A3 "Phase: PartiallyFailed\|Errors:"
```

## Monitoring Velero Operations

### Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: velero-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: velero
  namespaceSelector:
    matchNames:
    - velero
  endpoints:
  - port: monitoring
    interval: 30s
    path: /metrics
```

### Critical Alerts

```yaml
groups:
- name: velero-backup-health
  rules:
  - alert: VeleroBackupFailed
    expr: |
      velero_backup_failure_total > 0
    labels:
      severity: critical
    annotations:
      summary: "Velero backup failed"
      description: "{{ $labels.schedule }} backup has failures: {{ $value }}"

  - alert: VeleroBackupNotRecent
    expr: |
      (time() - velero_backup_last_successful_timestamp) > 86400
    labels:
      severity: warning
    annotations:
      summary: "No successful Velero backup in 24 hours for {{ $labels.schedule }}"
      description: "Last successful backup was {{ $value | humanizeDuration }} ago"

  - alert: VeleroStorageLocationUnavailable
    expr: |
      velero_backup_storage_location_info{phase="Unavailable"} == 1
    labels:
      severity: critical
    annotations:
      summary: "Velero backup storage location {{ $labels.backup_storage_location }} is unavailable"

  - alert: VeleroNodeAgentNotReady
    expr: |
      kube_daemonset_status_number_ready{daemonset="node-agent", namespace="velero"}
      /
      kube_daemonset_status_desired_number_scheduled{daemonset="node-agent", namespace="velero"}
      < 1
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Not all Velero node-agent pods are ready"
```

## Backup Validation and Recovery Testing

A backup that has never been tested is not a backup. Implement automated restore validation:

```bash
#!/usr/bin/env bash
# validate-backup.sh — Test backup restorability on a schedule

set -euo pipefail

BACKUP_NAME="${1:?backup name required}"
TEST_NAMESPACE="velero-restore-test-$(date +%Y%m%d-%H%M%S)"
VELERO_NS="velero"
TIMEOUT="30m"

echo "=== Starting backup validation for: $BACKUP_NAME ==="

# Create a test restore to a disposable namespace
velero restore create "validate-${BACKUP_NAME}" \
  --from-backup "$BACKUP_NAME" \
  --namespace-mappings "$(velero backup describe $BACKUP_NAME --details | \
    grep 'Namespaces:' -A5 | grep -v 'Namespaces:' | tr -d ' ' | head -1):${TEST_NAMESPACE}" \
  --restore-volumes=true \
  --wait \
  --timeout "$TIMEOUT"

RESTORE_STATUS=$(velero restore get "validate-${BACKUP_NAME}" \
  -o jsonpath='{.status.phase}')

if [ "$RESTORE_STATUS" != "Completed" ]; then
  echo "FAIL: Restore completed with status: $RESTORE_STATUS"
  velero restore describe "validate-${BACKUP_NAME}" --details
  exit 1
fi

echo "PASS: Restore completed successfully"

# Run application-specific validation
kubectl wait deployment --all -n "$TEST_NAMESPACE" \
  --for=condition=Available \
  --timeout=10m || {
  echo "WARN: Not all deployments became available within 10 minutes"
  kubectl get all -n "$TEST_NAMESPACE"
}

# Cleanup test namespace
kubectl delete namespace "$TEST_NAMESPACE" --wait=false
velero restore delete "validate-${BACKUP_NAME}" --confirm

echo "=== Backup validation complete: PASS ==="
```

## Conclusion

Velero provides a comprehensive Kubernetes backup solution when operated with the right configuration and validation practices. The key operational guidelines:

1. **Use CSI snapshots** for stateful applications on supported storage classes — they are application-consistent and fast
2. **Configure backup hooks** for databases that require quiescing (MySQL FLUSH TABLES, MongoDB fsync lock, PostgreSQL pg_start_backup)
3. **Maintain offsite backups** in a different region or cloud provider to protect against regional failures
4. **Test restores regularly** — monthly automated restore validation into a staging namespace with deployment readiness checks
5. **Set TTL based on RPO/RTO requirements**: hourly backups for critical data, daily for everything else, weekly long-term offsite retention
6. **Monitor `velero_backup_last_successful_timestamp`** with a 24-hour threshold alert to detect silently failing schedules
7. **Document the cross-cluster migration procedure** and rehearse it at least quarterly to ensure the team can execute it under pressure during an actual disaster
