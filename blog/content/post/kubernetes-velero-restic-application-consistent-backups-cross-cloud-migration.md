---
title: "Kubernetes Velero with Restic: Application-Consistent Backups and Cross-Cloud Migration"
date: 2030-12-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Restic", "Kopia", "Backup", "Disaster Recovery", "Migration", "CSI"]
categories:
- Kubernetes
- Disaster Recovery
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes backup and migration using Velero with Restic and Kopia, covering application-consistent backups with pre/post hooks, CSI snapshot integration, backup schedules and retention, and cross-cloud cluster migration workflows."
more_link: "yes"
url: "/kubernetes-velero-restic-application-consistent-backups-cross-cloud-migration/"
---

Data protection in Kubernetes requires more than just snapshotting PersistentVolumes. Application consistency - ensuring that in-flight transactions are committed and application state is coherent at the moment of backup - requires coordinated quiescing at the application layer. Velero, combined with Restic or Kopia for file-level backup, provides this coordination through lifecycle hooks while also enabling cross-cloud migration without vendor lock-in. This guide covers production-ready backup architectures for stateful Kubernetes workloads.

<!--more-->

# Kubernetes Velero with Restic: Application-Consistent Backups and Cross-Cloud Migration

## Understanding Velero Architecture

Velero consists of several components working together:

1. **Velero server**: Runs as a Deployment in the cluster, orchestrates backups and restores
2. **Node-Agent (formerly Restic/Kopia)**: DaemonSet that runs on each node to access pod volumes
3. **Backup Storage Location (BSL)**: Where backup metadata and volume data are stored (S3, GCS, Azure Blob)
4. **Volume Snapshot Location (VSL)**: Where CSI snapshots are stored (cloud provider native)
5. **Plugins**: Provider-specific integration (AWS, GCP, Azure, vSphere, etc.)

The critical insight is that Velero has two distinct mechanisms for backing up persistent data:
- **CSI snapshots**: Fast, crash-consistent volume snapshots via the storage provider
- **Restic/Kopia file backup**: Slower, application-consistent file-level backup with hook support

For most production stateful workloads, you want CSI snapshots for speed combined with application hooks for consistency.

## Installation

### Installing Velero CLI

```bash
# Download the latest Velero CLI
VELERO_VERSION="v1.13.0"
curl -LO "https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-amd64.tar.gz"
tar -xzf "velero-${VELERO_VERSION}-linux-amd64.tar.gz"
mv "velero-${VELERO_VERSION}-linux-amd64/velero" /usr/local/bin/

velero version --client-only
```

### Installing Velero on AWS with Kopia

```bash
# Create AWS S3 bucket for backups
aws s3 mb s3://my-cluster-velero-backups --region us-east-1

# Create the IAM policy
cat > velero-policy.json << 'EOF'
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
      "Resource": "arn:aws:s3:::my-cluster-velero-backups/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::my-cluster-velero-backups"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name VeleroPolicy \
  --policy-document file://velero-policy.json

# For IRSA (EKS)
eksctl create iamserviceaccount \
  --cluster=my-cluster \
  --namespace=velero \
  --name=velero-server \
  --attach-policy-arn=arn:aws:iam::123456789012:policy/VeleroPolicy \
  --approve
```

```bash
# Install Velero with Kopia (recommended over Restic for performance)
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-cluster-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --service-account-name velero-server \
  --no-secret \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --uploader-type=kopia \
  --pod-annotations=iam.amazonaws.com/role=arn:aws:iam::123456789012:role/VeleroRole \
  --wait
```

### Installing Velero on GKE

```bash
# Create GCS bucket
gsutil mb -l us-central1 gs://my-cluster-velero-backups

# Create service account and grant permissions
gcloud iam service-accounts create velero \
  --display-name "Velero service account"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member serviceAccount:velero@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/compute.storageAdmin

gsutil iam ch serviceAccount:velero@PROJECT_ID.iam.gserviceaccount.com:objectAdmin \
  gs://my-cluster-velero-backups

# For Workload Identity
gcloud iam service-accounts add-iam-policy-binding \
  velero@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:PROJECT_ID.svc.id.goog[velero/velero-server]"

kubectl annotate serviceaccount velero-server \
  --namespace velero \
  iam.gke.io/gcp-service-account=velero@PROJECT_ID.iam.gserviceaccount.com

# Install Velero for GCP
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.9.0 \
  --bucket my-cluster-velero-backups \
  --no-secret \
  --use-node-agent \
  --uploader-type=kopia \
  --wait
```

## Application-Consistent Backups with Hooks

Velero supports pre and post backup hooks that execute commands within pod containers before and after backup operations. This is essential for databases that need to flush their write-ahead log or freeze writes during backup.

### PostgreSQL Application-Consistent Backup

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgresql
  namespace: production
  annotations:
    # Pre-backup hook: create a checkpoint to ensure WAL is flushed
    pre.hook.backup.velero.io/container: postgresql
    pre.hook.backup.velero.io/command: |
      ["/bin/sh", "-c",
       "psql -U postgres -c 'CHECKPOINT;' && echo 'Checkpoint created'"]
    pre.hook.backup.velero.io/timeout: "60s"
    pre.hook.backup.velero.io/on-error: Fail

    # Post-backup hook: verify backup completed
    post.hook.backup.velero.io/container: postgresql
    post.hook.backup.velero.io/command: |
      ["/bin/sh", "-c",
       "echo 'Backup completed at '$(date)"]
    post.hook.backup.velero.io/timeout: "30s"
    post.hook.backup.velero.io/on-error: Continue
spec:
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      containers:
      - name: postgresql
        image: postgres:15
        env:
        - name: PGPASSWORD
          valueFrom:
            secretKeyRef:
              name: postgresql-secret
              key: password
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: postgresql-pvc
```

### MySQL InnoDB Hot Backup

For MySQL, you need to flush tables with read lock or use `mysqldump --single-transaction`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: production
spec:
  serviceName: mysql
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
      annotations:
        # Flush tables and create a consistent snapshot point
        pre.hook.backup.velero.io/container: mysql
        pre.hook.backup.velero.io/command: >
          ["/bin/sh", "-c",
           "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e \"FLUSH TABLES WITH READ LOCK; SYSTEM sync;\""]
        pre.hook.backup.velero.io/timeout: "90s"
        pre.hook.backup.velero.io/on-error: Fail

        # Release lock after backup
        post.hook.backup.velero.io/container: mysql
        post.hook.backup.velero.io/command: >
          ["/bin/sh", "-c",
           "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e \"UNLOCK TABLES;\""]
        post.hook.backup.velero.io/timeout: "30s"
        post.hook.backup.velero.io/on-error: Fail
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mysql-secret
              key: root-password
```

### MongoDB Snapshot with WiredTiger Checkpoint

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
  namespace: production
spec:
  serviceName: mongodb
  selector:
    matchLabels:
      app: mongodb
  template:
    metadata:
      labels:
        app: mongodb
      annotations:
        # Trigger a WiredTiger checkpoint for consistency
        pre.hook.backup.velero.io/container: mongodb
        pre.hook.backup.velero.io/command: |
          ["/bin/sh", "-c",
           "mongosh --eval 'db.adminCommand({fsync: 1, lock: false})' admin"]
        pre.hook.backup.velero.io/timeout: "60s"
        pre.hook.backup.velero.io/on-error: Fail

        post.hook.backup.velero.io/container: mongodb
        post.hook.backup.velero.io/command: |
          ["/bin/sh", "-c", "echo 'MongoDB backup complete'"]
        post.hook.backup.velero.io/timeout: "30s"
    spec:
      containers:
      - name: mongodb
        image: mongo:7
```

### Redis BGSAVE Consistency

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: production
spec:
  serviceName: redis
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
      annotations:
        pre.hook.backup.velero.io/container: redis
        pre.hook.backup.velero.io/command: |
          ["/bin/sh", "-c",
           "redis-cli BGSAVE && while [ $(redis-cli LASTSAVE) -eq $(redis-cli LASTSAVE) ]; do sleep 1; done && echo 'RDB save complete'"]
        pre.hook.backup.velero.io/timeout: "120s"
        pre.hook.backup.velero.io/on-error: Fail
    spec:
      containers:
      - name: redis
        image: redis:7
```

## Backup Schedules and Retention

### Creating Backup Schedules

```bash
# Daily backup of production namespace, retain for 30 days
velero schedule create production-daily \
  --schedule="0 2 * * *" \
  --include-namespaces production \
  --ttl 720h \
  --storage-location default \
  --snapshot-volumes \
  --default-volumes-to-fs-backup=false

# Hourly backup of critical databases, retain for 7 days
velero schedule create databases-hourly \
  --schedule="0 * * * *" \
  --include-namespaces databases \
  --ttl 168h \
  --include-resources statefulsets,persistentvolumeclaims,persistentvolumes,secrets,configmaps \
  --storage-location default

# Weekly full cluster backup, retain for 90 days
velero schedule create cluster-weekly \
  --schedule="0 1 * * 0" \
  --ttl 2160h \
  --storage-location long-term \
  --snapshot-volumes
```

### Schedule via CRD (GitOps-friendly)

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    includedNamespaces:
    - production
    - staging
    excludedNamespaces:
    - kube-system
    - kube-public
    includedResources: []   # Empty = all resources
    excludedResources:
    - events
    - events.events.k8s.io
    labelSelector: {}
    storageLocation: default
    volumeSnapshotLocations:
    - default
    defaultVolumesToFsBackup: false
    snapshotVolumes: true
    ttl: 720h0m0s
    hooks:
      resources: []
    includeClusterResources: true
    metadata:
      labels:
        backup-type: scheduled
        environment: production
```

### Multi-Tier Retention Strategy

```yaml
---
# Tier 1: Hourly backups of databases (24-hour retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: databases-hourly
  namespace: velero
spec:
  schedule: "30 * * * *"
  template:
    includedNamespaces:
    - databases
    ttl: 24h0m0s
    defaultVolumesToFsBackup: true   # Use Kopia for file-level backup
    snapshotVolumes: false
---
# Tier 2: Daily backups (30-day retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: production-daily
  namespace: velero
spec:
  schedule: "0 1 * * *"
  template:
    includedNamespaces:
    - production
    - databases
    ttl: 720h0m0s
    snapshotVolumes: true
    storageLocation: default
---
# Tier 3: Weekly backups to cold storage (1-year retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-cluster-weekly
  namespace: velero
spec:
  schedule: "0 0 * * 0"
  template:
    ttl: 8760h0m0s
    snapshotVolumes: true
    storageLocation: long-term
    includeClusterResources: true
```

### Configuring Multiple Backup Storage Locations

```yaml
---
# Primary storage: local region
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-backups
    prefix: primary
  config:
    region: us-east-1
    serverSideEncryption: aws:kms
    kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
  credential:
    name: velero-credentials
    key: cloud
  accessMode: ReadWrite
---
# Secondary storage: cross-region for DR
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: dr-region
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-backups-dr
    prefix: dr
  config:
    region: us-west-2
    serverSideEncryption: aws:kms
  accessMode: ReadWrite
---
# Long-term storage: with Glacier tier
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: long-term
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-cluster-velero-longterm
    prefix: longterm
  config:
    region: us-east-1
    storageClass: GLACIER_IR
  accessMode: ReadWrite
```

## CSI Snapshot Integration

CSI snapshots provide near-instantaneous, crash-consistent volume snapshots at the storage layer, which is much faster than Restic/Kopia file-level backup:

### Installing CSI Snapshot Controller

```bash
# Install snapshot CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Install snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### Creating VolumeSnapshotClass

```yaml
# For AWS EBS CSI driver
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: aws-ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"  # Used by Velero
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Delete
parameters:
  csi.storage.k8s.io/snapshotter-secret-name: aws-secret
  csi.storage.k8s.io/snapshotter-secret-namespace: velero
```

```yaml
# For GCE Persistent Disk
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: gce-pd-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Delete
```

### CSI Snapshot-Enabled Backup

```bash
# Enable CSI snapshot feature flag in Velero
velero install \
  --features=EnableCSI \
  --plugins velero/velero-plugin-for-aws:v1.9.0,velero/velero-plugin-for-csi:v0.7.0 \
  ...

# Take a CSI snapshot backup
velero backup create my-csi-backup \
  --include-namespaces production \
  --snapshot-volumes \
  --features=EnableCSI
```

## Cross-Cluster and Cross-Cloud Migration

### Scenario: Migrating from AWS EKS to GKE

Migration workflow for moving workloads from one cloud to another:

```bash
# Step 1: Create a backup on the source cluster (AWS EKS)
# Ensure both clusters can access the same backup storage
velero backup create pre-migration-backup \
  --include-namespaces production \
  --default-volumes-to-fs-backup=true \
  --storage-location default \
  --wait

# Verify backup completed
velero backup describe pre-migration-backup --details

# Step 2: Set up Velero on the target cluster (GKE) pointing to the same S3 bucket
# On GKE cluster:
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket my-cluster-velero-backups \
  --backup-location-config region=us-east-1 \
  --no-secret \
  --credentials-file /tmp/aws-credentials \
  --wait

# Step 3: Verify Velero can see the source cluster's backups
velero backup get

# Step 4: Restore to the target cluster
velero restore create production-migration \
  --from-backup pre-migration-backup \
  --include-namespaces production \
  --namespace-mappings production:production-migrated \
  --wait

# Step 5: Verify the restore
velero restore describe production-migration --details
kubectl get all -n production-migrated
```

### Handling Storage Class Mapping

Different clouds have different storage classes. Use Velero's remapping capability:

```bash
# Restore with storage class remapping
velero restore create cross-cloud-restore \
  --from-backup pre-migration-backup \
  --namespace-mappings production:production \
  --restore-volumes=true

# Using a config map for storage class remapping
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storageclass-config
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  # Map AWS gp2 to GKE standard SSD
  gp2: standard-rwo
  # Map AWS gp3 to GKE standard SSD
  gp3: standard-rwo
  # Map AWS io1 to GKE performance SSD
  io1: premium-rwo
EOF
```

### Migrating PersistentVolumes with Data

```bash
# For volumes with data that cannot use CSI snapshots
# Use Velero's file-level backup (Kopia) for the migration

# 1. Scale down the application to ensure data consistency
kubectl scale deployment my-app --replicas=0 -n production

# 2. Take a backup with file-level volume backup
velero backup create migration-with-pv \
  --include-namespaces production \
  --default-volumes-to-fs-backup=true \
  --wait

# 3. Verify backup
velero backup describe migration-with-pv

# 4. Restore to the target cluster
velero restore create migration-restore \
  --from-backup migration-with-pv \
  --include-namespaces production \
  --wait

# 5. Scale up the application on the target cluster
kubectl scale deployment my-app --replicas=3 -n production
```

### Migration Validation Script

```bash
#!/bin/bash
# validate-migration.sh - Compare source and target namespace resource counts

SOURCE_KUBECONFIG="$1"
TARGET_KUBECONFIG="$2"
NAMESPACE="${3:-production}"

echo "=== Migration Validation Report ==="
echo "Namespace: $NAMESPACE"
echo ""

for resource in deployment statefulset daemonset service configmap secret persistentvolumeclaim; do
    SOURCE_COUNT=$(kubectl --kubeconfig="$SOURCE_KUBECONFIG" \
        get "$resource" -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l)
    TARGET_COUNT=$(kubectl --kubeconfig="$TARGET_KUBECONFIG" \
        get "$resource" -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l)

    STATUS="OK"
    if [ "$SOURCE_COUNT" != "$TARGET_COUNT" ]; then
        STATUS="MISMATCH"
    fi

    printf "%-25s Source: %-5s Target: %-5s Status: %s\n" \
        "$resource" "$SOURCE_COUNT" "$TARGET_COUNT" "$STATUS"
done

echo ""
echo "=== Pod Status on Target ==="
kubectl --kubeconfig="$TARGET_KUBECONFIG" get pods -n "$NAMESPACE"

echo ""
echo "=== PVC Status on Target ==="
kubectl --kubeconfig="$TARGET_KUBECONFIG" get pvc -n "$NAMESPACE"
```

## Backup Monitoring and Alerting

### Prometheus Metrics from Velero

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: monitoring
spec:
  groups:
  - name: velero
    rules:
    - alert: VeleroBackupFailed
      expr: |
        increase(velero_backup_failure_total[1h]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero backup failed"
        description: "Velero backup has failed. Check velero logs."

    - alert: VeleroScheduleMissed
      expr: |
        time() - velero_backup_last_successful_timestamp{schedule!=""} > 86400
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Velero scheduled backup missed"
        description: "Schedule {{ $labels.schedule }} has not completed a successful backup in 24 hours"

    - alert: VeleroRestoreFailed
      expr: |
        increase(velero_restore_failure_total[1h]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero restore failed"

    - alert: VeleroBackupStorageLocationUnhealthy
      expr: |
        velero_backup_storage_location_info{phase!="Available"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero backup storage location {{ $labels.backup_storage_location }} is unavailable"

    - alert: VeleroNodeAgentNotRunning
      expr: |
        kube_daemonset_status_number_unavailable{daemonset="node-agent",namespace="velero"} > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Velero node-agent is not running on some nodes"
```

### Backup Health Check CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: velero-backup-health-check
  namespace: velero
spec:
  schedule: "0 8 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero
          restartPolicy: OnFailure
          containers:
          - name: health-check
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              #!/bin/sh

              FAILED_BACKUPS=$(kubectl get backup -n velero \
                --field-selector=status.phase=Failed \
                -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)

              if [ -n "$FAILED_BACKUPS" ]; then
                echo "WARNING: Failed backups found: $FAILED_BACKUPS"
                exit 1
              fi

              # Check last successful backup age
              LAST_BACKUP=$(kubectl get backup -n velero \
                -l velero.io/schedule-name=production-daily \
                --sort-by='.metadata.creationTimestamp' \
                -o jsonpath='{.items[-1].status.completionTimestamp}')

              if [ -z "$LAST_BACKUP" ]; then
                echo "ERROR: No successful backups found"
                exit 1
              fi

              echo "Last successful backup: $LAST_BACKUP"
              echo "All backup checks passed"
```

## Troubleshooting Common Issues

### Backup Stuck in Progress

```bash
# Check backup status
velero backup describe my-backup

# Check node-agent logs on relevant nodes
kubectl logs -n velero -l app.kubernetes.io/name=velero-node-agent -f

# Check if pod volumes are being uploaded
kubectl get podvolumebackups -n velero

# Delete a stuck backup and retry
velero backup delete my-backup
velero backup create my-backup --include-namespaces production --wait
```

### Volume Backup Fails with "No volume data found"

```bash
# Verify node-agent is running on all nodes
kubectl get pods -n velero -l app.kubernetes.io/name=velero-node-agent

# Check if volume is mounted by the pod
kubectl get pod my-pod -n production -o jsonpath='{.spec.volumes}'

# Verify the PVC is bound
kubectl get pvc -n production

# Check if the volume path is accessible
kubectl exec -n velero node-agent-xxxxx -- ls /host_pods/POD_UID/volumes/
```

### Restore Missing Resources

```bash
# Check if resources are excluded
velero restore describe my-restore | grep -E "(Included|Excluded)"

# Check for restore errors
velero restore logs my-restore | grep -i error

# Restore specific missing resource
velero restore create targeted-restore \
  --from-backup my-backup \
  --include-resources deployments \
  --include-namespaces production
```

## Advanced Configuration: Backup Hooks via CRD

For complex applications, define hooks in a separate resource instead of pod annotations:

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
---
# Use pod spec annotations for hooks in StatefulSets
# For backup hooks defined via Backup CRD:
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: production-backup-with-hooks
  namespace: velero
spec:
  includedNamespaces:
  - production
  storageLocation: default
  hooks:
    resources:
    - name: postgresql-backup
      includedNamespaces:
      - production
      labelSelector:
        matchLabels:
          app: postgresql
      pre:
      - exec:
          container: postgresql
          command:
          - /bin/sh
          - -c
          - psql -U postgres -c "CHECKPOINT;" -c "SELECT pg_start_backup('velero', true);"
          onError: Fail
          timeout: 60s
      post:
      - exec:
          container: postgresql
          command:
          - /bin/sh
          - -c
          - psql -U postgres -c "SELECT pg_stop_backup();"
          onError: Continue
          timeout: 30s
```

## Summary

A production Velero deployment provides both point-in-time recovery and cross-cloud portability. Key operational practices:

- Use Kopia over Restic for significantly better deduplication and performance
- Always implement application-specific pre/post hooks for databases - crash-consistent snapshots alone are insufficient for PostgreSQL and MySQL
- Design a multi-tier backup schedule (hourly/daily/weekly) with appropriate retention for each tier
- Configure backup storage in a different region from your cluster for DR resilience
- Use CSI snapshots for fast RTO and Kopia file backup for RPO precision
- Test restores regularly - monthly restore drills are the minimum acceptable frequency
- Monitor backup completion with Prometheus alerts and automated health checks
- Store the migration runbook as code in your GitOps repository alongside Velero Schedule CRDs
