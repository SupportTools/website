---
title: "Kubernetes Backup and Recovery with Velero: Enterprise Strategies"
date: 2028-03-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "Disaster Recovery", "Storage", "Restic", "Kopia"]
categories: ["Kubernetes", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Velero backup architecture, S3-compatible storage backends, CSI volume snapshots, schedule CRDs, and enterprise disaster recovery runbooks for Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-velero-backup-strategies-guide/"
---

Enterprise Kubernetes clusters hold stateful workloads whose data must survive node failures, accidental deletions, ransomware events, and full cluster loss. Velero provides a Kubernetes-native backup and restore framework that operates at the resource level — serializing API objects to object storage — while also capturing persistent volume data through either file-system-level copy (Restic/Kopia) or CSI volume snapshots. This guide covers every layer of a production-grade Velero deployment, from storage backend configuration through cross-cluster restore procedures.

<!--more-->

## Architecture Overview

Velero runs as a Deployment inside the cluster it protects. The core components are:

- **Backup controller**: Watches `Backup` CRs, serializes matching resources to JSON, uploads to object storage, and updates the `Backup` status.
- **Restore controller**: Watches `Restore` CRs, downloads objects from storage, applies them to the target cluster, and remaps storage classes and namespaces as instructed.
- **Schedule controller**: Watches `Schedule` CRs and creates `Backup` objects on a cron schedule with automatic TTL-based pruning.
- **Volume snapshotter plugins**: Cloud-provider or CSI plugins that create and restore persistent volume snapshots.
- **File-system backup daemon** (node-agent): A DaemonSet running Restic or Kopia that performs pod-volume backups when CSI snapshots are unavailable or insufficient.

```
┌──────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                │
│                                                      │
│  ┌──────────────────┐     ┌───────────────────────┐  │
│  │  Velero Server   │     │  node-agent DaemonSet │  │
│  │  (backup ctrl)   │     │  (restic / kopia)     │  │
│  │  (restore ctrl)  │     └────────────┬──────────┘  │
│  │  (schedule ctrl) │                  │              │
│  └────────┬─────────┘          mounts PV data        │
│           │                            │              │
│     CRD watch                         │              │
│           │                            │              │
│  ┌────────▼──────────────────────────▼────────────┐  │
│  │              Object Storage (S3 / GCS / Azure) │  │
│  │         backups/  restores/  restic-repo/      │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Storage Backend Configuration

### S3-Compatible Backend (MinIO, Ceph RGW, AWS S3)

Create an IAM policy granting Velero the minimum required permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::velero-backups/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::velero-backups"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeVolumes",
        "ec2:DescribeSnapshots",
        "ec2:CreateTags",
        "ec2:CreateSnapshot",
        "ec2:DeleteSnapshot",
        "ec2:DescribeRegions"
      ],
      "Resource": "*"
    }
  ]
}
```

Store credentials in a Kubernetes Secret:

```bash
cat > /tmp/credentials-velero <<EOF
[default]
aws_access_key_id=<ACCESS_KEY_ID>
aws_secret_access_key=<SECRET_ACCESS_KEY>
EOF

kubectl create secret generic velero-s3-credentials \
  --namespace velero \
  --from-file=cloud=/tmp/credentials-velero
```

Install Velero with the AWS plugin and configure a `BackupStorageLocation`:

```bash
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket velero-backups \
  --secret-file /tmp/credentials-velero \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --use-node-agent \
  --uploader-type kopia \
  --namespace velero
```

Verify the backup storage location becomes `Available`:

```bash
kubectl get backupstoragelocation -n velero
# NAME      PHASE       LAST VALIDATED   AGE   DEFAULT
# default   Available   10s              2m    true
```

### Multi-Region Redundancy

Configure a secondary `BackupStorageLocation` pointing to a bucket in a different region for cross-region DR:

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: secondary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-backups-dr
    prefix: cluster-prod
  config:
    region: us-west-2
    profile: velero-dr
  credential:
    name: velero-s3-credentials-dr
    key: cloud
  default: false
  accessMode: ReadWrite
```

## Schedule CRD with TTL

### Nightly Full Backup Schedule

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: nightly-full
  namespace: velero
spec:
  schedule: "0 2 * * *"
  useOwnerReferencesInBackup: false
  template:
    ttl: 720h0m0s      # 30 days retention
    storageLocation: default
    volumeSnapshotLocations:
      - default
    includedNamespaces:
      - "*"
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
    includedResources:
      - "*"
    excludedResources:
      - events
      - events.events.k8s.io
    labelSelector: {}
    defaultVolumesToFsBackup: false
    snapshotVolumes: true
    hooks:
      resources:
        - name: freeze-postgres
          includedNamespaces:
            - databases
          labelSelector:
            matchLabels:
              app: postgresql
          pre:
            - exec:
                container: postgresql
                command:
                  - /bin/bash
                  - -c
                  - psql -U postgres -c "SELECT pg_start_backup('velero', true);"
                onError: Fail
                timeout: 60s
          post:
            - exec:
                container: postgresql
                command:
                  - /bin/bash
                  - -c
                  - psql -U postgres -c "SELECT pg_stop_backup();"
                onError: Continue
                timeout: 60s
```

### Hourly Critical Namespace Schedule

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-critical
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    ttl: 48h0m0s
    storageLocation: default
    includedNamespaces:
      - production
      - payments
      - auth
    defaultVolumesToFsBackup: false
    snapshotVolumes: true
    labelSelector:
      matchLabels:
        backup-tier: critical
```

## Volume Snapshot Integration (CSI)

### Enabling CSI Snapshots

Install the CSI snapshot controller and CRDs if not already present:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v7.0.1/deploy/kubernetes/snapshot-controller/
```

Create a `VolumeSnapshotClass` with the Velero annotation:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-aws-ebs-snapshots
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  tagSpecification_1: "velero.io/backup-name={{.Backup.Name}}"
  tagSpecification_2: "velero.io/namespace={{.Namespace}}"
```

Enable the CSI plugin in Velero:

```bash
velero plugin add velero/velero-plugin-for-csi:v0.7.0 -n velero
```

Create a `VolumeSnapshotLocation`:

```yaml
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: velero.io/aws
  config:
    region: us-east-1
```

### Opting Into CSI Snapshots Per PVC

Annotate PVCs to use CSI snapshots instead of file-system backup:

```bash
kubectl annotate pvc postgres-data \
  -n databases \
  backup.velero.io/backup-volumes=postgres-data \
  velero.io/csi-volumesnapshot-class=csi-aws-ebs-snapshots
```

Or configure at the backup level to use CSI for all eligible volumes:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: manual-csi-backup
  namespace: velero
spec:
  snapshotMoveData: false
  csiSnapshotTimeout: 10m0s
  itemOperationTimeout: 4h0m0s
  snapshotVolumes: true
```

## Namespace Filtering and Label Selectors

### Selective Namespace Backup

Back up only namespaces matching a label:

```bash
velero backup create selective-backup \
  --selector environment=production \
  --include-namespaces production,staging \
  --exclude-resources events,events.events.k8s.io \
  --snapshot-volumes
```

Using the CRD directly for fine-grained control:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: app-team-backup
  namespace: velero
spec:
  includedNamespaces:
    - app-team-*
  excludedNamespaces:
    - app-team-sandbox
  labelSelector:
    matchExpressions:
      - key: backup-exclude
        operator: DoesNotExist
      - key: tier
        operator: In
        values:
          - frontend
          - backend
          - database
  orLabelSelectors:
    - matchLabels:
        backup-critical: "true"
  includedClusterScopedResources:
    - persistentvolumes
    - storageclasses
  excludedClusterScopedResources:
    - nodes
    - componentstatuses
```

### Resource-Level Exclusion Annotations

Exclude specific resources from all backups using annotations:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ephemeral-worker
  annotations:
    backup.velero.io/backup-volumes-excludes: work-dir,tmp-storage
    velero.io/exclude-from-backup: "true"
```

## Restic and Kopia Integration

### Kopia (Recommended for New Deployments)

Kopia replaces Restic as the preferred file-system backup uploader. It offers better performance through parallel uploads and content-addressed deduplication. Enable it during install with `--uploader-type kopia`.

Configure Kopia repository password:

```bash
kubectl create secret generic velero-repo-credentials \
  --namespace velero \
  --from-literal=repository-password='<STRONG-RANDOM-PASSWORD>'
```

Monitor node-agent pod health:

```bash
kubectl get pods -n velero -l name=node-agent
kubectl logs -n velero -l name=node-agent --tail=50
```

Trigger a pod-volume backup explicitly:

```bash
velero backup create pv-backup \
  --default-volumes-to-fs-backup \
  --include-namespaces databases
```

### Restic (Legacy Compatibility)

If Restic is still in use, configure the node-agent with appropriate resource limits to prevent node pressure during large backups:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
  namespace: velero
spec:
  template:
    spec:
      containers:
        - name: node-agent
          resources:
            limits:
              cpu: "2"
              memory: 4Gi
            requests:
              cpu: 500m
              memory: 512Mi
          env:
            - name: VELERO_SCRATCH_DIR
              value: /scratch
          volumeMounts:
            - name: scratch
              mountPath: /scratch
      volumes:
        - name: scratch
          emptyDir:
            sizeLimit: 10Gi
```

## Disaster Recovery Runbook

### Scenario 1: Namespace Accidental Deletion

```bash
# Step 1: Identify the most recent backup covering the namespace
velero backup get --output json | \
  jq -r '.items[] | select(.status.phase=="Completed") |
    "\(.metadata.name) \(.status.completionTimestamp)"' | \
  sort -k2 -r | head -10

# Step 2: Describe the backup to confirm namespace presence
velero backup describe <BACKUP_NAME> --details | grep -A20 "Namespaces:"

# Step 3: Restore the namespace
velero restore create restore-production \
  --from-backup <BACKUP_NAME> \
  --include-namespaces production \
  --restore-volumes

# Step 4: Monitor restore progress
velero restore describe restore-production --details

# Step 5: Verify resources are healthy
kubectl get all -n production
kubectl get pvc -n production
```

### Scenario 2: etcd Corruption — Cluster-Level Recovery

When the control plane is lost, restore to a new cluster:

```bash
# On the NEW cluster — install Velero pointing to the same backup bucket
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket velero-backups \
  --secret-file /tmp/credentials-velero \
  --backup-location-config region=us-east-1 \
  --use-node-agent \
  --uploader-type kopia \
  --namespace velero

# Wait for backup sync (Velero reads metadata from bucket)
kubectl wait --for=condition=Available \
  backupstoragelocation/default \
  -n velero \
  --timeout=120s

# List available backups synced from bucket
velero backup get

# Restore all namespaces, remapping storage class if needed
velero restore create full-cluster-restore \
  --from-backup nightly-full-20260315020000 \
  --restore-volumes \
  --namespace-mappings "" \
  --existing-resource-policy update

# For storage class remapping (new cluster uses different provisioner)
velero restore create full-cluster-restore \
  --from-backup nightly-full-20260315020000 \
  --restore-volumes \
  --existing-resource-policy update \
  --additional-config storageClassMapping=ebs.csi.aws.com/gp2:ebs.csi.aws.com/gp3
```

### Scenario 3: Single Stateful Workload Recovery

```bash
# Restore only the stateful set and its PVCs into a new namespace for validation
velero restore create postgres-restore-validation \
  --from-backup nightly-full-20260315020000 \
  --include-namespaces databases \
  --include-resources statefulsets,persistentvolumeclaims,services,configmaps,secrets \
  --namespace-mappings databases:databases-restore-test \
  --restore-volumes

# After validation, delete test namespace
kubectl delete namespace databases-restore-test
```

## Backup Validation Testing

Backup files in object storage are useless if they cannot be restored. Automate validation as part of a regular testing cadence.

### Automated Restore Validation CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-validation
  namespace: velero
spec:
  schedule: "0 6 * * 0"  # Every Sunday at 06:00
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: velero
          restartPolicy: Never
          containers:
            - name: validator
              image: bitnami/kubectl:1.29
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail

                  # Find the latest completed backup
                  BACKUP=$(kubectl get backup -n velero \
                    --sort-by='.status.completionTimestamp' \
                    -o jsonpath='{.items[-1].metadata.name}')

                  echo "Validating backup: ${BACKUP}"

                  # Create restore to isolated namespace
                  RESTORE_NS="validation-$(date +%Y%m%d)"
                  kubectl create namespace "${RESTORE_NS}" --dry-run=client -o yaml | kubectl apply -f -

                  velero restore create "validate-${BACKUP}" \
                    --from-backup "${BACKUP}" \
                    --include-namespaces production \
                    --namespace-mappings "production:${RESTORE_NS}" \
                    --restore-volumes=false \
                    -n velero

                  # Wait for restore completion (max 30 min)
                  for i in $(seq 1 60); do
                    STATUS=$(kubectl get restore "validate-${BACKUP}" \
                      -n velero \
                      -o jsonpath='{.status.phase}')
                    echo "Restore status: ${STATUS}"
                    if [ "${STATUS}" = "Completed" ]; then
                      echo "VALIDATION PASSED"
                      kubectl delete namespace "${RESTORE_NS}"
                      exit 0
                    elif [ "${STATUS}" = "Failed" ] || [ "${STATUS}" = "PartiallyFailed" ]; then
                      echo "VALIDATION FAILED"
                      kubectl delete namespace "${RESTORE_NS}"
                      exit 1
                    fi
                    sleep 30
                  done

                  echo "VALIDATION TIMED OUT"
                  kubectl delete namespace "${RESTORE_NS}"
                  exit 1
```

### Backup Integrity Checks

```bash
#!/bin/bash
# validate-backup-integrity.sh
# Checks backup metadata, size, and object count against expected thresholds

set -euo pipefail

NAMESPACE="velero"
MIN_RESOURCE_COUNT=500
MIN_BACKUP_SIZE_MB=100

LATEST_BACKUP=$(kubectl get backup -n "${NAMESPACE}" \
  --sort-by='.status.completionTimestamp' \
  -o jsonpath='{.items[-1].metadata.name}')

echo "Checking backup: ${LATEST_BACKUP}"

# Extract metrics
PHASE=$(kubectl get backup "${LATEST_BACKUP}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.phase}')
RESOURCE_COUNT=$(kubectl get backup "${LATEST_BACKUP}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.progress.itemsBackedUp}')
WARNINGS=$(kubectl get backup "${LATEST_BACKUP}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.warnings}')
ERRORS=$(kubectl get backup "${LATEST_BACKUP}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.errors}')

echo "Phase: ${PHASE}"
echo "Resources backed up: ${RESOURCE_COUNT}"
echo "Warnings: ${WARNINGS}"
echo "Errors: ${ERRORS}"

if [ "${PHASE}" != "Completed" ]; then
  echo "ERROR: Backup phase is ${PHASE}, expected Completed"
  exit 1
fi

if [ "${RESOURCE_COUNT}" -lt "${MIN_RESOURCE_COUNT}" ]; then
  echo "ERROR: Resource count ${RESOURCE_COUNT} below minimum ${MIN_RESOURCE_COUNT}"
  exit 1
fi

if [ "${ERRORS}" -gt 0 ]; then
  echo "WARNING: Backup completed with ${ERRORS} errors"
  velero backup describe "${LATEST_BACKUP}" --details | grep -A5 "Errors:"
fi

echo "Backup integrity check PASSED"
```

## Cross-Cluster Restore Procedures

### Migrating Workloads Between Clusters

Cross-cluster migration requires that both clusters share access to the same backup bucket, with potentially different infrastructure (storage classes, node selectors, cloud providers).

```bash
# On SOURCE cluster: create a migration-specific backup
velero backup create migration-snapshot \
  --include-namespaces app-namespace \
  --snapshot-move-data \
  --data-mover velero \
  --storage-location default

# Verify the backup is complete and data has been moved to object storage
velero backup describe migration-snapshot --details

# On TARGET cluster: point Velero to the same bucket
# (Velero will sync backup metadata automatically)
velero backup get

# Restore with storage class mapping and node selector removal
velero restore create migration-restore \
  --from-backup migration-snapshot \
  --restore-volumes \
  --existing-resource-policy update \
  --additional-config nodeSelector={}
```

### Storage Class Remapping ConfigMap

When the target cluster uses different storage provisioners, define the mapping:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storage-class-config
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  # Source SC: Target SC
  gp2: gp3
  standard: premium-rwo
  nfs-client: longhorn
```

### Namespace Remapping for Multi-Tenant Migration

```bash
velero restore create tenant-migration \
  --from-backup nightly-full-20260315020000 \
  --namespace-mappings \
    "tenant-a-prod:tenant-a,tenant-b-prod:tenant-b,shared-services-prod:shared-services" \
  --restore-volumes
```

## Monitoring Velero with Prometheus

Velero exposes Prometheus metrics on port 8085. Configure scraping and alerting:

```yaml
# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: velero
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - velero
  selector:
    matchLabels:
      app.kubernetes.io/name: velero
  endpoints:
    - port: monitoring
      interval: 30s
      path: /metrics
```

Essential Prometheus alerting rules:

```yaml
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
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failure detected"
            description: "Backup {{ $labels.schedule }} has failed {{ $value }} times."

        - alert: VeleroBackupMissing
          expr: |
            time() - velero_backup_last_successful_timestamp{schedule="nightly-full"} > 90000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "No successful Velero backup in 25 hours"
            description: "The nightly-full schedule has not produced a successful backup recently."

        - alert: VeleroBackupStorageNotAvailable
          expr: |
            velero_backup_storage_location_phase{phase="Unavailable"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup storage location unavailable"
            description: "Storage location {{ $labels.backupstoragelocation }} is unavailable."

        - alert: VeleroNodeAgentDown
          expr: |
            kube_daemonset_status_number_ready{daemonset="node-agent",namespace="velero"} <
            kube_daemonset_status_desired_number_scheduled{daemonset="node-agent",namespace="velero"}
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Velero node-agent pods are not all ready"
```

## Operational Best Practices

### Backup Labeling Strategy

Apply consistent labels to inform backup scope and retention:

```bash
# Label all critical workloads
kubectl label deployment payment-service -n production \
  backup-tier=critical \
  backup-schedule=hourly

# Label ephemeral/non-critical workloads for exclusion
kubectl label deployment log-aggregator -n production \
  velero.io/exclude-from-backup=true
```

### Backup Lifecycle Policy

```yaml
# Long-term archive schedule (weekly, 1 year retention)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-archive
  namespace: velero
spec:
  schedule: "0 3 * * 0"
  template:
    ttl: 8760h0m0s  # 365 days
    storageLocation: secondary  # DR bucket in second region
    snapshotVolumes: false      # Archive excludes volume snapshots (cost)
    defaultVolumesToFsBackup: false
    includedNamespaces:
      - production
      - payments
    excludedResources:
      - events
      - events.events.k8s.io
      - pods
      - replicasets
      - endpointslices
```

### Pre-Backup Hooks for Database Consistency

Define hooks in the Deployment annotation rather than the backup spec for portability:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: databases
  annotations:
    pre.hook.backup.velero.io/container: mysql
    pre.hook.backup.velero.io/command: >
      ["/bin/bash", "-c",
       "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'FLUSH TABLES WITH READ LOCK;'"]
    pre.hook.backup.velero.io/on-error: Fail
    pre.hook.backup.velero.io/timeout: 60s
    post.hook.backup.velero.io/container: mysql
    post.hook.backup.velero.io/command: >
      ["/bin/bash", "-c",
       "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'UNLOCK TABLES;'"]
    post.hook.backup.velero.io/on-error: Continue
    post.hook.backup.velero.io/timeout: 30s
```

### Cleanup and Retention Enforcement

Manually trigger cleanup of expired backups:

```bash
# List all backups with expiration status
kubectl get backup -n velero -o custom-columns=\
  NAME:.metadata.name,\
  STATUS:.status.phase,\
  EXPIRES:.status.expiration,\
  CREATED:.metadata.creationTimestamp

# Force-delete a specific backup (also removes object storage contents)
velero backup delete <BACKUP_NAME> --confirm

# Delete all failed backups
velero backup get | grep Failed | awk '{print $1}' | \
  xargs -I{} velero backup delete {} --confirm
```

## RTO and RPO Planning

| Scenario | Target RPO | Target RTO | Strategy |
|---|---|---|---|
| Namespace deletion | 1 hour | 30 minutes | Hourly schedule + fast restore |
| Stateful workload corruption | 24 hours | 2 hours | Nightly schedule + CSI snapshots |
| Full cluster loss | 24 hours | 4 hours | Nightly to DR bucket + runbook |
| Cross-region migration | 48 hours | 8 hours | Weekly archive + data mover |

## Upgrade Path

Velero follows a N-1 Kubernetes version support policy. When upgrading Velero itself:

```bash
# 1. Verify current version
velero version

# 2. Review breaking changes in release notes
# 3. Update the Velero Deployment image
kubectl set image deployment/velero \
  velero=velero/velero:v1.13.0 \
  -n velero

# 4. Update plugins to matching versions
velero plugin add velero/velero-plugin-for-aws:v1.9.0 -n velero

# 5. Restart to apply
kubectl rollout restart deployment/velero -n velero
kubectl rollout status deployment/velero -n velero
```

Backup CRD schemas evolve between major versions. Run the migration tool when upgrading across major versions to convert existing `Backup` and `Restore` objects to the new API format.

## Summary

A production-grade Velero deployment requires attention across four domains: storage backend resilience (multi-region, access-controlled buckets), data capture completeness (CSI snapshots for block volumes, Kopia for file-system backups, pre/post hooks for database consistency), operational discipline (scheduled backups with TTL, monitoring alerts, weekly validation restores), and documented recovery runbooks that teams have actually practiced. The configurations above provide a functional baseline for enterprise clusters; adapt schedule frequency, TTL values, and namespace inclusions to match organizational RTO/RPO commitments.
