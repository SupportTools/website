---
title: "Kubernetes Persistent Volume Snapshots: CSI Snapshot API, Velero Integration, and Cross-Cluster Recovery"
date: 2028-06-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CSI", "Snapshots", "Storage", "Velero", "Backup"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes persistent volume snapshots using the CSI Snapshot API, Velero integration for application-consistent backups, and cross-cluster disaster recovery procedures."
more_link: "yes"
url: "/kubernetes-persistent-volume-snapshots-csi-guide/"
---

Persistent volume snapshots are one of the most underutilized features in production Kubernetes environments. Most teams reach for Velero or a cloud-native backup tool and treat it as a black box, but understanding what happens at the CSI layer—how snapshot classes map to driver behaviors, how application consistency is enforced, and how cross-cluster restores actually work—is critical when you need to recover from a real incident under pressure.

This guide covers the full stack: CSI VolumeSnapshot API objects, snapshot class configuration per driver, Velero's CSI plugin integration, and the runbook you need to restore a stateful workload into a different cluster entirely.

<!--more-->

# Kubernetes Persistent Volume Snapshots: CSI Snapshot API, Velero Integration, and Cross-Cluster Recovery

## Section 1: CSI Snapshot Architecture Overview

The CSI (Container Storage Interface) snapshot capability is split across three Kubernetes API objects:

- **VolumeSnapshotClass**: Cluster-scoped, maps to a CSI driver and defines snapshot deletion policy
- **VolumeSnapshot**: Namespace-scoped, user-created request for a snapshot
- **VolumeSnapshotContent**: Cluster-scoped, the actual snapshot resource (like PVC/PV)

The external-snapshotter sidecar watches for VolumeSnapshot objects and calls the CSI driver's `CreateSnapshot` RPC. Importantly, snapshot support requires three feature gates that are now GA in Kubernetes 1.20+: `VolumeSnapshotDataSource`, `CSIBlockVolume`, and the external-snapshotter controller running in your cluster.

### Installing the Snapshot CRDs and Controller

The snapshot CRDs and controller are NOT bundled with Kubernetes. You install them separately:

```bash
# Install snapshot CRDs (v6.x for Kubernetes 1.24+)
SNAPSHOTTER_VERSION=v6.3.3

kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Install the snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${SNAPSHOTTER_VERSION}/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml

# Verify
kubectl get pods -n kube-system | grep snapshot-controller
```

Verify that the CRDs are installed correctly:

```bash
kubectl get crd | grep snapshot
# Expected output:
# volumesnapshotclasses.snapshot.storage.k8s.io   2024-01-15T10:00:00Z
# volumesnapshotcontents.snapshot.storage.k8s.io  2024-01-15T10:00:00Z
# volumesnapshots.snapshot.storage.k8s.io         2024-01-15T10:00:00Z
```

## Section 2: VolumeSnapshotClass Configuration

### AWS EBS CSI Driver

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  # AWS-specific parameters
  tagSpecification_1: "key=Environment,value=production"
  tagSpecification_2: "key=ManagedBy,value=kubernetes"
```

The `deletionPolicy: Retain` setting is critical for production. With `Delete`, removing the VolumeSnapshot also removes the underlying cloud snapshot. With `Retain`, you have to clean up manually, but you won't accidentally delete your only backup.

### GCP Persistent Disk CSI Driver

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: pd-vsc
  annotations:
    # Required for Velero CSI plugin to use this class
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Retain
parameters:
  storage-locations: us-central1
  snapshot-type: STANDARD
```

### Longhorn CSI Driver

```yaml
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

Note that Longhorn snapshots are local to the cluster. For cross-cluster recovery you need Velero's filesystem backup or Longhorn's backup-to-S3 feature.

### Azure Disk CSI Driver

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: azuredisk-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: disk.csi.azure.com
deletionPolicy: Retain
parameters:
  incremental: "true"  # Incremental snapshots cost significantly less
  resourceGroup: my-resource-group
  tags: Environment=production,ManagedBy=kubernetes
```

## Section 3: Taking Manual Volume Snapshots

### Basic Snapshot Creation

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-snapshot-20240115
  namespace: databases
  labels:
    app: postgres
    snapshot-type: manual
    created-by: ops-team
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: postgres-data
```

Apply and monitor the snapshot progress:

```bash
kubectl apply -f snapshot.yaml

# Watch snapshot progress
kubectl get volumesnapshot -n databases -w

# Check detailed status
kubectl describe volumesnapshot postgres-data-snapshot-20240115 -n databases
```

Example output showing a ready snapshot:

```
Name:         postgres-data-snapshot-20240115
Namespace:    databases
API Version:  snapshot.storage.k8s.io/v1
Kind:         VolumeSnapshot
Status:
  Bound Volume Snapshot Content Name:  snapcontent-abc123
  Creation Time:                       2024-01-15T14:30:00Z
  Ready To Use:                        true
  Restore Size:                        100Gi
```

### Automated Snapshot Script

For production environments, automate snapshots with a CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-snapshot
  namespace: databases
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          serviceAccountName: snapshot-manager
          restartPolicy: OnFailure
          containers:
          - name: snapshot-creator
            image: bitnami/kubectl:1.28
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              TIMESTAMP=$(date +%Y%m%d%H%M%S)
              SNAPSHOT_NAME="postgres-data-snapshot-${TIMESTAMP}"
              NAMESPACE="databases"
              PVC_NAME="postgres-data"
              SNAPSHOT_CLASS="ebs-vsc"

              # Clean up snapshots older than 7 days
              kubectl get volumesnapshot -n ${NAMESPACE} \
                -l app=postgres,snapshot-type=scheduled \
                --sort-by=.metadata.creationTimestamp \
                -o json | jq -r '.items[:-7] | .[].metadata.name' | \
                xargs -r kubectl delete volumesnapshot -n ${NAMESPACE}

              # Create new snapshot
              cat <<EOF | kubectl apply -f -
              apiVersion: snapshot.storage.k8s.io/v1
              kind: VolumeSnapshot
              metadata:
                name: ${SNAPSHOT_NAME}
                namespace: ${NAMESPACE}
                labels:
                  app: postgres
                  snapshot-type: scheduled
              spec:
                volumeSnapshotClassName: ${SNAPSHOT_CLASS}
                source:
                  persistentVolumeClaimName: ${PVC_NAME}
              EOF

              # Wait for snapshot to be ready (max 10 minutes)
              TIMEOUT=600
              ELAPSED=0
              while true; do
                READY=$(kubectl get volumesnapshot ${SNAPSHOT_NAME} -n ${NAMESPACE} \
                  -o jsonpath='{.status.readyToUse}')
                if [ "${READY}" = "true" ]; then
                  echo "Snapshot ${SNAPSHOT_NAME} is ready"
                  break
                fi
                if [ ${ELAPSED} -ge ${TIMEOUT} ]; then
                  echo "Timeout waiting for snapshot to be ready"
                  exit 1
                fi
                sleep 10
                ELAPSED=$((ELAPSED + 10))
              done
```

### RBAC for Snapshot Operations

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: snapshot-manager
  namespace: databases

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: snapshot-manager
  namespace: databases
rules:
- apiGroups: ["snapshot.storage.k8s.io"]
  resources: ["volumesnapshots"]
  verbs: ["get", "list", "create", "delete", "watch"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims"]
  verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: snapshot-manager
  namespace: databases
subjects:
- kind: ServiceAccount
  name: snapshot-manager
  namespace: databases
roleRef:
  kind: Role
  name: snapshot-manager
  apiGroup: rbac.authorization.k8s.io
```

## Section 4: Restoring from a Snapshot

### Creating a PVC from a Snapshot

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: databases
spec:
  dataSource:
    name: postgres-data-snapshot-20240115
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  storageClassName: gp3-encrypted
  resources:
    requests:
      storage: 100Gi  # Must be >= snapshot restore size
```

The restore process is asynchronous. The PVC will be in `Pending` state while the CSI driver creates the volume from the snapshot:

```bash
kubectl get pvc postgres-data-restored -n databases -w
# NAME                      STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS    AGE
# postgres-data-restored    Pending                                       gp3-encrypted   5s
# postgres-data-restored    Pending                                       gp3-encrypted   15s
# postgres-data-restored    Bound     pvc-xyz   100Gi     RWO            gp3-encrypted   45s
```

### In-Place Recovery (Swap PVC)

For a full database recovery replacing the existing PVC:

```bash
#!/bin/bash
set -euo pipefail

NAMESPACE="databases"
DEPLOYMENT="postgres"
ORIGINAL_PVC="postgres-data"
SNAPSHOT_NAME="postgres-data-snapshot-20240115"
RECOVERY_PVC="postgres-data-recovery"

echo "=== Step 1: Scale down workload ==="
kubectl scale deployment/${DEPLOYMENT} --replicas=0 -n ${NAMESPACE}
kubectl rollout status deployment/${DEPLOYMENT} -n ${NAMESPACE} --timeout=120s

echo "=== Step 2: Create PVC from snapshot ==="
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${RECOVERY_PVC}
  namespace: ${NAMESPACE}
spec:
  dataSource:
    name: ${SNAPSHOT_NAME}
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  storageClassName: gp3-encrypted
  resources:
    requests:
      storage: 100Gi
EOF

echo "=== Step 3: Wait for PVC to be bound ==="
kubectl wait pvc/${RECOVERY_PVC} -n ${NAMESPACE} \
  --for=jsonpath='{.status.phase}'=Bound \
  --timeout=300s

echo "=== Step 4: Patch deployment to use recovery PVC ==="
kubectl patch deployment/${DEPLOYMENT} -n ${NAMESPACE} \
  --type=json \
  -p="[{\"op\": \"replace\", \"path\": \"/spec/template/spec/volumes/0/persistentVolumeClaim/claimName\", \"value\": \"${RECOVERY_PVC}\"}]"

echo "=== Step 5: Scale back up ==="
kubectl scale deployment/${DEPLOYMENT} --replicas=1 -n ${NAMESPACE}
kubectl rollout status deployment/${DEPLOYMENT} -n ${NAMESPACE} --timeout=300s

echo "=== Recovery complete ==="
```

## Section 5: Velero CSI Plugin Integration

Velero's CSI plugin integrates with the VolumeSnapshot API to create application-consistent backups. When you back up a namespace with Velero and the CSI plugin enabled, Velero:

1. Quiesces application I/O (if using pre/post hooks)
2. Creates VolumeSnapshot objects for all PVCs in scope
3. Waits for snapshots to be `readyToUse: true`
4. Stores snapshot metadata in the backup object store

### Installing Velero with CSI Plugin

```bash
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.8.0,velero/velero-plugin-for-csi:v0.7.0 \
  --bucket my-velero-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --use-node-agent \
  --features=EnableCSIVolumeData \
  --secret-file ./credentials-velero
```

The `--features=EnableCSIVolumeData` flag is required for Velero 1.11+.

### Velero BackupStorageLocation and VolumeSnapshotLocation

```yaml
---
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-velero-backups
    prefix: cluster-prod-01
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-east-1:123456789:key/abc-123

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

### Application-Consistent Backup with Hooks

For databases, you need to flush and quiesce I/O before taking a snapshot. Velero supports pre/post hooks via pod annotations:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: databases
spec:
  template:
    metadata:
      annotations:
        # Pre-backup hook: flush and checkpoint
        pre.hook.backup.velero.io/container: postgres
        pre.hook.backup.velero.io/command: '["/bin/bash", "-c", "psql -U postgres -c \"CHECKPOINT;\""]'
        pre.hook.backup.velero.io/timeout: 60s
        pre.hook.backup.velero.io/on-error: Fail
        # Post-backup hook: resume normal operation
        post.hook.backup.velero.io/container: postgres
        post.hook.backup.velero.io/command: '["/bin/bash", "-c", "echo backup complete"]'
        post.hook.backup.velero.io/timeout: 30s
```

For MySQL:

```yaml
annotations:
  pre.hook.backup.velero.io/container: mysql
  pre.hook.backup.velero.io/command: '["/bin/bash", "-c", "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e \"FLUSH TABLES WITH READ LOCK;\""]'
  pre.hook.backup.velero.io/timeout: 120s
  post.hook.backup.velero.io/container: mysql
  post.hook.backup.velero.io/command: '["/bin/bash", "-c", "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e \"UNLOCK TABLES;\""]'
  post.hook.backup.velero.io/timeout: 30s
```

### Creating Scheduled Backups

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: databases-daily
  namespace: velero
spec:
  schedule: "0 1 * * *"  # 1 AM daily
  useOwnerReferencesInBackup: false
  template:
    includedNamespaces:
    - databases
    - redis
    excludedResources:
    - events
    - events.events.k8s.io
    snapshotVolumes: true
    volumeSnapshotLocations:
    - default
    storageLocation: default
    ttl: 720h  # 30 days
    hooks:
      resources:
      - name: postgres-backup-hooks
        includedNamespaces:
        - databases
        labelSelector:
          matchLabels:
            app: postgres
        pre:
        - exec:
            container: postgres
            command:
            - /bin/bash
            - -c
            - psql -U postgres -c "CHECKPOINT;"
            timeout: 60s
            onError: Fail
        post:
        - exec:
            container: postgres
            command:
            - /bin/bash
            - -c
            - echo "backup hooks complete"
            timeout: 30s
```

## Section 6: Cross-Cluster Recovery Procedure

Cross-cluster recovery is where most teams get surprised. The VolumeSnapshot objects in the source cluster only contain metadata references to cloud snapshots. The actual data lives in your cloud provider's snapshot service (EBS snapshots, GCP PD snapshots, etc.). Velero handles the translation during restore.

### Prerequisites for Cross-Cluster Restore

1. Destination cluster must have the same CSI driver installed
2. Destination cluster must have Velero installed with same provider plugin
3. BackupStorageLocation must point to the same S3 bucket
4. VolumeSnapshotClass with matching driver must exist in destination cluster

### Configuring Destination Cluster

```bash
# On destination cluster
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.8.0,velero/velero-plugin-for-csi:v0.7.0 \
  --bucket my-velero-backups \
  --backup-location-config region=us-east-1 \
  --use-node-agent \
  --features=EnableCSIVolumeData \
  --secret-file ./credentials-velero \
  --no-default-backup-location  # Don't create a new location

# Create BSL pointing to existing backups
cat <<EOF | kubectl apply -f -
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-velero-backups
    prefix: cluster-prod-01  # Same prefix as source cluster
  config:
    region: us-east-1
EOF

# Wait for BSL to sync and list available backups
kubectl get backupstoragelocation -n velero
velero backup get
```

### Executing the Cross-Cluster Restore

```bash
#!/bin/bash
set -euo pipefail

BACKUP_NAME="databases-daily-20240115010000"
TARGET_NAMESPACE="databases"
SNAPSHOT_CLASS="ebs-vsc"  # Must exist in destination cluster

# Restore from backup
velero restore create \
  --from-backup ${BACKUP_NAME} \
  --include-namespaces ${TARGET_NAMESPACE} \
  --restore-volumes=true \
  --existing-resource-policy=update \
  --wait

# Check restore status
velero restore get
velero restore describe ${BACKUP_NAME}-<timestamp>

# Watch PVCs come up
kubectl get pvc -n ${TARGET_NAMESPACE} -w
```

### Restore with Namespace Remapping

When recovering into a different namespace or cluster with different naming:

```bash
velero restore create disaster-recovery-restore \
  --from-backup databases-daily-20240115010000 \
  --namespace-mappings databases:databases-dr \
  --restore-volumes=true \
  --wait
```

### VolumeSnapshotContent Import for Manual Recovery

When Velero is not available, you can manually import cloud snapshots into the Kubernetes VolumeSnapshot system:

```yaml
# Pre-provision a VolumeSnapshotContent referencing the cloud snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: imported-snapshot-content
spec:
  deletionPolicy: Retain
  driver: ebs.csi.aws.com
  source:
    snapshotHandle: snap-0abc123def456789  # AWS snapshot ID
  volumeSnapshotRef:
    name: imported-snapshot
    namespace: databases

---
# Reference it from a VolumeSnapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: imported-snapshot
  namespace: databases
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    volumeSnapshotContentName: imported-snapshot-content
```

Then create a PVC from this VolumeSnapshot:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-imported
  namespace: databases
spec:
  dataSource:
    name: imported-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  storageClassName: gp3-encrypted
  resources:
    requests:
      storage: 100Gi
```

## Section 7: Monitoring Snapshot Health

### Prometheus Metrics for Snapshot Controller

The external-snapshotter exposes Prometheus metrics. Create alerts for snapshot failures:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: volume-snapshot-alerts
  namespace: monitoring
spec:
  groups:
  - name: volume-snapshots
    interval: 60s
    rules:
    - alert: VolumeSnapshotFailed
      expr: |
        kube_volumesnapshot_info{ready_to_use="false"} == 1
        and
        (time() - kube_volumesnapshot_created) > 600
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "VolumeSnapshot {{ $labels.volumesnapshot }} in namespace {{ $labels.namespace }} failed to become ready"
        description: "VolumeSnapshot has been in non-ready state for more than 10 minutes"

    - alert: VolumeSnapshotTooOld
      expr: |
        (time() - kube_volumesnapshot_created{snapshot_type="scheduled"}) > 86400 * 2
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Scheduled snapshots for {{ $labels.volumesnapshot }} are more than 2 days old"

    - alert: SnapshotControllerDown
      expr: up{job="snapshot-controller"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VolumeSnapshot controller is down"
```

### Snapshot Inventory Script

```bash
#!/bin/bash
# Generate a snapshot inventory report

echo "=== Volume Snapshot Inventory ==="
echo "Generated: $(date)"
echo ""

echo "--- VolumeSnapshots by Namespace ---"
kubectl get volumesnapshot -A \
  -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.readyToUse,SIZE:.status.restoreSize,AGE:.metadata.creationTimestamp,CLASS:.spec.volumeSnapshotClassName' \
  --sort-by=.metadata.namespace

echo ""
echo "--- VolumeSnapshotContents ---"
kubectl get volumesnapshotcontent \
  -o custom-columns=\
'NAME:.metadata.name,READY:.status.readyToUse,SIZE:.status.restoreSize,SNAPSHOT_HANDLE:.status.snapshotHandle,POLICY:.spec.deletionPolicy'

echo ""
echo "--- Summary ---"
TOTAL=$(kubectl get volumesnapshot -A --no-headers | wc -l)
READY=$(kubectl get volumesnapshot -A -o json | jq '[.items[] | select(.status.readyToUse == true)] | length')
FAILED=$((TOTAL - READY))

echo "Total snapshots: ${TOTAL}"
echo "Ready: ${READY}"
echo "Not ready/failed: ${FAILED}"
```

## Section 8: Troubleshooting Common Issues

### Snapshot Stuck in `readyToUse: false`

```bash
# Check snapshot controller logs
kubectl logs -n kube-system -l app=snapshot-controller --tail=100 | grep -i error

# Check the VolumeSnapshotContent for errors
kubectl describe volumesnapshotcontent $(kubectl get volumesnapshot <name> -n <ns> \
  -o jsonpath='{.status.boundVolumeSnapshotContentName}')

# Common causes:
# 1. CSI driver doesn't support snapshots - check driver capabilities
kubectl get csidrivers
kubectl describe csidriver ebs.csi.aws.com | grep Snapshot

# 2. IAM permissions missing (AWS)
# Required: ec2:CreateSnapshot, ec2:DescribeSnapshots, ec2:DeleteSnapshot

# 3. Snapshot class not found
kubectl get volumesnapshotclass
```

### PVC Restore Stuck in Pending

```bash
# Check PVC events
kubectl describe pvc <restored-pvc-name> -n <namespace>

# Check the CSI driver node plugin
kubectl logs -n kube-system -l app=ebs-csi-node -c ebs-plugin --tail=100

# Check storage class exists and matches
kubectl get storageclass

# Common issue: storage class in snapshot doesn't exist in destination cluster
# Fix: create matching storage class before restore
```

### Velero CSI Backup Shows "VolumeSnapshot not found"

```bash
# Check Velero CSI plugin is running
kubectl get pods -n velero

# Verify feature flag is set
kubectl get deployment velero -n velero -o yaml | grep -A5 "EnableCSIVolumeData"

# Check backup logs
velero backup logs <backup-name> | grep -i "csi\|snapshot\|error"

# Ensure VolumeSnapshotClass has velero label
kubectl get volumesnapshotclass -o yaml | grep "velero.io/csi-volumesnapshot-class"
```

## Section 9: Production Best Practices

### Snapshot Retention Policy

Implement a tiered retention strategy matching your RPO requirements:

```yaml
# Hourly snapshots, kept for 24 hours
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: databases-hourly
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    includedNamespaces: ["databases"]
    snapshotVolumes: true
    ttl: 24h

---
# Daily snapshots, kept for 30 days
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: databases-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    includedNamespaces: ["databases"]
    snapshotVolumes: true
    ttl: 720h

---
# Weekly snapshots, kept for 1 year
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: databases-weekly
  namespace: velero
spec:
  schedule: "0 3 * * 0"
  template:
    includedNamespaces: ["databases"]
    snapshotVolumes: true
    ttl: 8760h
```

### Testing Your Recovery Procedure

Never trust untested backups. Run restore tests regularly:

```bash
#!/bin/bash
# Monthly restore validation script

BACKUP_NAME=$(velero backup get --output json | \
  jq -r '.items | sort_by(.metadata.creationTimestamp) | last | .metadata.name')

echo "Testing restore of backup: ${BACKUP_NAME}"

# Restore to a test namespace
velero restore create restore-test-$(date +%Y%m%d) \
  --from-backup ${BACKUP_NAME} \
  --namespace-mappings databases:databases-test \
  --restore-volumes=true \
  --wait

# Verify the restored PVCs are bound
kubectl get pvc -n databases-test
kubectl get pods -n databases-test

# Run basic connectivity test
kubectl run pg-test --image=postgres:15 --rm -it --restart=Never \
  -n databases-test \
  --env=PGPASSWORD=<password> \
  -- psql -h postgres-svc -U postgres -c "SELECT count(*) FROM pg_database;"

# Clean up test namespace
kubectl delete namespace databases-test

echo "Restore test complete"
```

### Key Takeaways

- Always use `deletionPolicy: Retain` for production VolumeSnapshotClasses
- Label your VolumeSnapshotClass with `velero.io/csi-volumesnapshot-class: "true"` for Velero integration
- Use application-consistent hooks for databases (CHECKPOINT for PostgreSQL, FLUSH TABLES for MySQL)
- Test cross-cluster restores monthly, not just before an incident
- Monitor snapshot age and alert when scheduled snapshots are stale
- For cross-cluster recovery without Velero, use VolumeSnapshotContent import with the cloud provider's snapshot handle
- Keep the external-snapshotter controller version aligned with your Kubernetes version
