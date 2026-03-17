---
title: "Kubernetes Backup and Restore: Velero with CSI Snapshots, etcd Backup, and DR Testing"
date: 2030-04-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "CSI", "etcd", "Disaster Recovery"]
categories: ["Kubernetes", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive Kubernetes backup strategy combining Velero resource backup with CSI volume snapshots, automated etcd snapshot procedures, cross-cluster restore testing, backup retention policies, and a complete DR runbook for enterprise production environments."
more_link: "yes"
url: "/kubernetes-backup-restore-velero-csi-snapshots-etcd/"
---

Most teams discover their Kubernetes backup strategy is inadequate during an actual incident. The backup job ran. The retention policy is configured. But when the moment arrives to restore a production namespace or recover from a deleted StatefulSet, the process reveals gaps: snapshots that exist but cannot be mounted, PVC data that was captured separately from the pod manifests that reference it, or etcd backups that were created for a different Kubernetes version.

This guide builds a complete, tested backup strategy that covers Kubernetes resource state (Velero), persistent volume data (CSI snapshots), and cluster state (etcd), with explicit DR testing procedures.

<!--more-->

# Kubernetes Backup and Restore: Velero with CSI Snapshots, etcd Backup, and DR Testing

## Architecture Overview

A production Kubernetes backup strategy requires three independent layers:

1. **Kubernetes resource backup (Velero)**: Captures all Kubernetes API objects — Deployments, Services, ConfigMaps, Secrets, PVCs, RBAC policies, CRDs, and their associated data.
2. **Volume snapshot backup (CSI VolumeSnapshot)**: Creates consistent point-in-time snapshots of persistent volumes directly through the storage driver, independent of whether a workload is running.
3. **etcd backup**: Captures the entire cluster state as a single etcd snapshot, enabling full cluster recovery from infrastructure failures.

These layers complement each other: Velero without CSI snapshots loses PVC data on deletion; CSI snapshots without resource manifests leave you with volumes but no knowledge of how to use them; etcd backup without application-level backups cannot restore into a different cluster version or cloud region.

## Velero Installation

### Installing Velero with CSI Plugin

```bash
# Install Velero CLI
curl -L https://github.com/vmware-tanzu/velero/releases/latest/download/velero-linux-amd64.tar.gz | tar -xz
sudo mv velero-*/velero /usr/local/bin/
velero version --client-only

# Create S3 bucket for backups (AWS example)
aws s3 mb s3://my-cluster-velero-backups --region us-east-1
aws s3api put-bucket-versioning \
  --bucket my-cluster-velero-backups \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-cluster-velero-backups \
  --lifecycle-configuration file://lifecycle.json
```

```json
// lifecycle.json — S3 lifecycle policy for backup retention
{
  "Rules": [
    {
      "ID": "velero-backup-retention",
      "Status": "Enabled",
      "Filter": {"Prefix": "backups/"},
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER"
        }
      ],
      "Expiration": {
        "Days": 365
      }
    }
  ]
}
```

```bash
# Create Velero IAM credentials
# The IAM policy should allow s3:GetObject, s3:PutObject, s3:DeleteObject, s3:ListBucket
# Store as Kubernetes secret
kubectl create namespace velero

kubectl create secret generic velero-credentials \
  --namespace velero \
  --from-literal=cloud="[default]
aws_access_key_id=<aws-access-key-id>
aws_secret_access_key=<aws-secret-access-key>"

# Install Velero with CSI plugin
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0,velero/velero-plugin-for-csi:v0.7.0 \
  --bucket my-cluster-velero-backups \
  --secret-file ./credentials-velero \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --features=EnableCSI \
  --use-node-agent \
  --use-volume-snapshots=true \
  --wait

# Verify Velero is running
kubectl get pods -n velero
velero backup-location get
```

### Velero with GCP GCS Backend

```bash
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.9.0,velero/velero-plugin-for-csi:v0.7.0 \
  --bucket my-cluster-velero-backups-gcp \
  --secret-file ./gcp-credentials.json \
  --features=EnableCSI \
  --use-node-agent \
  --wait
```

## CSI VolumeSnapshot Configuration

### Setting Up CSI Snapshot Infrastructure

```bash
# Install CSI snapshot CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Install snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/main/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### VolumeSnapshotClass Definition

```yaml
# snapshot-classes.yaml
# AWS EBS
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"  # Required for Velero CSI integration
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain   # Retain snapshots even if VolumeSnapshotContent is deleted
parameters:
  tagSpecification_1: "backup-source=velero"
  tagSpecification_2: "cluster=production"
---
# GCP PD
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: pd-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Retain
---
# Azure Disk
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: azure-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: disk.csi.azure.com
deletionPolicy: Retain
parameters:
  incremental: "true"   # Azure supports incremental snapshots
```

```bash
kubectl apply -f snapshot-classes.yaml

# Verify
kubectl get volumesnapshotclass
```

### Manual VolumeSnapshot

```yaml
# manual-snapshot.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-snapshot-$(date +%Y%m%d%H%M)
  namespace: databases
  annotations:
    backup.support.tools/created-by: "manual"
    backup.support.tools/purpose: "pre-migration"
spec:
  volumeSnapshotClassName: ebs-vsc
  source:
    persistentVolumeClaimName: data-postgres-0
```

## Velero Backup Schedules

### Namespace-Level Backups

```yaml
# velero-schedules.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"   # 2 AM daily
  template:
    ttl: 720h              # 30 days retention
    snapshotVolumes: true
    storageLocation: default
    volumeSnapshotLocations:
    - default
    includedNamespaces:
    - "*"
    excludedNamespaces:
    - kube-system
    - monitoring
    - velero
    labelSelector:
      matchExpressions:
      - key: backup.support.tools/exclude
        operator: DoesNotExist
    hooks:
      resources: []
    defaultVolumesToFsBackup: false   # Use CSI snapshots, not fsbackup
---
# Hourly backup for critical databases namespace
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-databases-backup
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    ttl: 168h              # 7 days retention
    snapshotVolumes: true
    storageLocation: default
    includedNamespaces:
    - databases
    hooks:
      resources:
      - name: postgres-pre-backup
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
            - "psql -U postgres -c 'CHECKPOINT;'"
            onError: Continue
            timeout: 60s
---
# Weekly backup with long retention for compliance
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-compliance-backup
  namespace: velero
spec:
  schedule: "0 3 * * 0"   # 3 AM Sunday
  template:
    ttl: 2160h             # 90 days retention
    snapshotVolumes: true
    storageLocation: secondary-location   # Different S3 bucket/region
    includedNamespaces:
    - "*"
    excludedNamespaces:
    - kube-system
    - velero
```

```bash
kubectl apply -f velero-schedules.yaml

# List schedules
velero schedule get

# Trigger an immediate backup from a schedule
velero backup create emergency-backup-$(date +%Y%m%d) \
  --from-schedule=daily-full-backup \
  --wait
```

### Backup with Pre/Post Hooks

Pre-backup hooks allow flushing application buffers or pausing writes before the snapshot is taken:

```yaml
# mysql-backup-with-hooks.yaml
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
  snapshotVolumes: true
  hooks:
    resources:
    - name: mysql-flush
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
            mysql -u root -p${MYSQL_ROOT_PASSWORD} \
              -e "FLUSH TABLES WITH READ LOCK; FLUSH LOGS;" || true
          onError: Fail
          timeout: 30s
      post:
      - exec:
          container: mysql
          command:
          - /bin/bash
          - -c
          - |
            mysql -u root -p${MYSQL_ROOT_PASSWORD} \
              -e "UNLOCK TABLES;" || true
          onError: Continue
          timeout: 30s
```

## etcd Backup Automation

### Automated etcd Snapshot CronJob

```yaml
# etcd-backup-cronjob.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: etcd-backup
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: etcd-backup
rules:
- apiGroups: [""]
  resources: ["pods", "pods/exec"]
  verbs: ["get", "list", "create"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: etcd-backup
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: etcd-backup
subjects:
- kind: ServiceAccount
  name: etcd-backup
  namespace: kube-system
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "*/15 * * * *"   # Every 15 minutes
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          serviceAccountName: etcd-backup
          restartPolicy: OnFailure
          hostNetwork: true  # Required to reach etcd on host network
          tolerations:
          - key: "node-role.kubernetes.io/control-plane"
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: etcd-backup
            image: bitnami/etcd:3.5.12
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              TIMESTAMP=$(date +%Y%m%d_%H%M%S)
              BACKUP_FILE="/backup/etcd-snapshot-${TIMESTAMP}.db"
              LATEST_LINK="/backup/etcd-snapshot-latest.db"

              echo "Taking etcd snapshot at ${TIMESTAMP}"

              ETCDCTL_API=3 etcdctl snapshot save "${BACKUP_FILE}" \
                --endpoints=https://127.0.0.1:2379 \
                --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
                --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

              # Verify snapshot
              ETCDCTL_API=3 etcdctl snapshot status "${BACKUP_FILE}" \
                --write-out=table

              # Update latest symlink
              ln -sf "${BACKUP_FILE}" "${LATEST_LINK}"

              # Upload to S3
              aws s3 cp "${BACKUP_FILE}" \
                "s3://my-cluster-etcd-backups/etcd/${TIMESTAMP}/snapshot.db" \
                --storage-class STANDARD_IA

              # Also upload Kubernetes PKI certs (required for restore)
              tar czf /tmp/pki-${TIMESTAMP}.tar.gz /etc/kubernetes/pki/
              aws s3 cp /tmp/pki-${TIMESTAMP}.tar.gz \
                "s3://my-cluster-etcd-backups/pki/${TIMESTAMP}/pki.tar.gz"

              # Cleanup local backups older than 24 hours
              find /backup -name "etcd-snapshot-*.db" -mtime +1 -delete

              echo "Backup complete: ${BACKUP_FILE}"
            env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: etcd-backup-credentials
                  key: aws-access-key-id
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: etcd-backup-credentials
                  key: aws-secret-access-key
            volumeMounts:
            - name: etcd-certs
              mountPath: /etc/kubernetes/pki/etcd
              readOnly: true
            - name: backup-storage
              mountPath: /backup
          volumes:
          - name: etcd-certs
            hostPath:
              path: /etc/kubernetes/pki/etcd
              type: Directory
          - name: backup-storage
            hostPath:
              path: /var/lib/etcd-backup
              type: DirectoryOrCreate
```

```bash
kubectl apply -f etcd-backup-cronjob.yaml

# Trigger manual etcd backup
kubectl create job --from=cronjob/etcd-backup manual-etcd-backup-$(date +%s) \
  -n kube-system

# Monitor
kubectl logs -n kube-system -l job-name=manual-etcd-backup-$(date +%s) -f
```

## Restore Procedures

### Velero Namespace Restore

```bash
# List available backups
velero backup get

# Describe backup details including PVCs
velero backup describe daily-full-backup-20260317 --details

# Restore a single namespace
velero restore create \
  --from-backup=daily-full-backup-20260317 \
  --include-namespaces=databases \
  --restore-volumes=true \
  --wait

# Check restore status
velero restore describe <restore-name> --details
velero restore logs <restore-name>

# Restore with namespace remapping (cross-cluster or cross-environment)
velero restore create \
  --from-backup=daily-full-backup-20260317 \
  --include-namespaces=databases \
  --namespace-mappings=databases:databases-restored \
  --restore-volumes=true \
  --wait
```

### Restoring Individual Resources

```bash
# Restore only a specific Deployment
velero restore create \
  --from-backup=daily-full-backup-20260317 \
  --include-resources=deployment \
  --selector=app=api-gateway \
  --restore-volumes=false

# Restore PVCs and their data
velero restore create \
  --from-backup=daily-full-backup-20260317 \
  --include-resources=persistentvolumeclaims,pods \
  --include-namespaces=databases \
  --restore-volumes=true
```

### etcd Restore Procedure

etcd restore is a last-resort operation for full cluster recovery:

```bash
#!/bin/bash
# etcd-restore.sh — full etcd restore procedure
# WARNING: This is destructive — it replaces all cluster state

set -euo pipefail

SNAPSHOT_FILE=${1:?Usage: $0 <snapshot-file>}
ETCD_DATA_DIR="/var/lib/etcd"
BACKUP_DATA_DIR="/var/lib/etcd-backup-$(date +%s)"

# On ALL control plane nodes:

# 1. Stop all control plane components
echo "Stopping control plane..."
systemctl stop kubelet || true
crictl pods | grep -E "etcd|kube-apiserver|kube-controller|kube-scheduler" | \
  awk '{print $1}' | xargs crictl stopp || true

# 2. Backup current etcd data
echo "Backing up current etcd data..."
mv "${ETCD_DATA_DIR}" "${BACKUP_DATA_DIR}"

# 3. Restore from snapshot (run on EACH control plane node)
# Get endpoint info from existing etcd configuration
ETCD_INITIAL_CLUSTER=$(grep "initial-cluster:" /etc/kubernetes/manifests/etcd.yaml | \
  awk '{print $2}')
NODE_NAME=$(hostname)

ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_FILE}" \
  --name="${NODE_NAME}" \
  --initial-cluster="${ETCD_INITIAL_CLUSTER}" \
  --initial-cluster-token="etcd-cluster-1" \
  --initial-advertise-peer-urls="https://$(hostname -I | awk '{print $1}'):2380" \
  --data-dir="${ETCD_DATA_DIR}" \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# 4. Fix permissions
chown -R etcd:etcd "${ETCD_DATA_DIR}" 2>/dev/null || true

# 5. Restart kubelet (which restarts the static pods)
echo "Restarting kubelet..."
systemctl start kubelet

# 6. Verify etcd is healthy
sleep 30
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

echo "etcd restore complete"
```

## DR Testing Runbook

### Monthly DR Test Procedure

```bash
#!/bin/bash
# dr-test.sh — monthly disaster recovery test procedure

DR_CLUSTER_CONTEXT="dr-cluster"
PROD_CLUSTER_CONTEXT="prod-cluster"
TEST_NAMESPACE="dr-test-$(date +%Y%m)"
BACKUP_NAME="daily-full-backup-$(date +%Y%m%d)"
LOG_FILE="/tmp/dr-test-$(date +%Y%m%d).log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== DR Test Started: $(date) ==="

# 1. Get latest backup
echo "Step 1: Identifying latest backup..."
LATEST_BACKUP=$(velero backup get --context="$PROD_CLUSTER_CONTEXT" \
  -o json | jq -r '.items | sort_by(.metadata.creationTimestamp) | last | .metadata.name')
echo "Latest backup: $LATEST_BACKUP"

# Verify backup is complete
STATUS=$(velero backup describe "$LATEST_BACKUP" \
  --context="$PROD_CLUSTER_CONTEXT" -o json | jq -r '.status.phase')
if [ "$STATUS" != "Completed" ]; then
    echo "FAIL: Backup $LATEST_BACKUP is in status $STATUS, not Completed"
    exit 1
fi

# 2. Switch to DR cluster
echo "Step 2: Configuring DR cluster backup location..."
kubectl config use-context "$DR_CLUSTER_CONTEXT"

# 3. Create test namespace
kubectl create namespace "$TEST_NAMESPACE"

# 4. Restore into test namespace
echo "Step 3: Restoring backup to DR cluster test namespace..."
velero restore create "dr-test-$(date +%Y%m%d%H%M)" \
  --from-backup="$LATEST_BACKUP" \
  --include-namespaces=databases \
  --namespace-mappings="databases:${TEST_NAMESPACE}" \
  --restore-volumes=true \
  --wait

RESTORE_STATUS=$(velero restore get "dr-test-$(date +%Y%m%d%H%M)" -o json | \
  jq -r '.status.phase')
echo "Restore status: $RESTORE_STATUS"

if [ "$RESTORE_STATUS" != "Completed" ]; then
    echo "FAIL: Restore did not complete successfully"
    exit 1
fi

# 5. Validate application health in test namespace
echo "Step 4: Validating restored applications..."

# Wait for pods to be ready
kubectl wait --for=condition=Ready pods \
  --all -n "$TEST_NAMESPACE" \
  --timeout=300s

# Run application-specific validation
kubectl exec -n "$TEST_NAMESPACE" \
  "$(kubectl get pods -n "$TEST_NAMESPACE" -l app=postgres -o name | head -1)" \
  -- psql -U postgres -c "SELECT count(*) FROM information_schema.tables;"

# 6. Report results
echo ""
echo "=== DR Test Results: $(date) ==="
echo "Backup: $LATEST_BACKUP"
echo "Restore: dr-test-$(date +%Y%m%d%H%M)"
echo "Status: SUCCESS"
echo "RTO: $(( $(date +%s) - $(date -d "$(velero restore describe dr-test-$(date +%Y%m%d%H%M) -o json | jq -r '.metadata.creationTimestamp')" +%s) )) seconds"

# 7. Cleanup
kubectl delete namespace "$TEST_NAMESPACE"
```

### Monitoring Backup Health

```yaml
# prometheusrule-velero.yaml
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
      expr: velero_backup_failure_total > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero backup failed"
        description: "Velero backup has failed {{ $value }} times"

    - alert: VeleroBackupMissing
      expr: time() - velero_backup_last_successful_timestamp > 86400
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "No successful Velero backup in 24 hours"

    - alert: VeleroCSISnapshotFailed
      expr: velero_csi_snapshot_attempt_total - velero_csi_snapshot_success_total > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "CSI snapshot failures detected"
```

## Key Takeaways

- Velero without CSI snapshots is incomplete for StatefulSet workloads — the resource manifests exist in the backup but PVC data is missing unless you enable `--snapshot-volumes=true` and configure a VolumeSnapshotClass with the `velero.io/csi-volumesnapshot-class: "true"` label.
- Pre-backup hooks are essential for database consistency — a filesystem snapshot taken while PostgreSQL has unflushed WAL records may restore to an inconsistent state; always issue a `CHECKPOINT` or `FLUSH TABLES WITH READ LOCK` before the storage snapshot.
- etcd snapshots should be taken every 15 minutes and uploaded to a second cloud region; a 15-minute RPO is achievable and dramatically reduces the blast radius of accidental cluster-wide operations.
- Store the Kubernetes PKI directory alongside every etcd snapshot — restoring etcd into a new cluster without the original PKI requires regenerating all certificates, which is significantly more work than keeping a PKI archive.
- VolumeSnapshotClass `deletionPolicy: Retain` prevents the underlying cloud snapshot from being deleted when the VolumeSnapshotContent object is deleted in Kubernetes — always set `Retain` for production backup snapshots.
- Run DR tests monthly and time them — your actual RTO is the restore time plus application validation time, not the time the restore job reports as complete; applications often need additional minutes to become healthy after storage is restored.
