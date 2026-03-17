---
title: "Kubernetes Velero 2.x: Incremental Backups, CSI Snapshots, and Cross-Cluster Migration"
date: 2031-07-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "CSI", "Disaster Recovery", "Migration"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Velero 2.x covering incremental backups with Kopia, CSI volume snapshots, and production-grade cross-cluster migration strategies for enterprise Kubernetes environments."
more_link: "yes"
url: "/kubernetes-velero-2x-backup-restore-incremental-csi-snapshots-cross-cluster-migration/"
---

Kubernetes backup and restore has matured significantly with Velero 2.x. The introduction of Kopia-based incremental backups, first-class CSI snapshot support, and improved cross-cluster migration tooling means enterprise teams no longer need to cobble together separate tools for cluster-level data protection. This guide walks through a production-ready Velero 2.x deployment covering all three of these capabilities in depth.

<!--more-->

# Kubernetes Velero 2.x: Incremental Backups, CSI Snapshots, and Cross-Cluster Migration

## Why Velero 2.x Changes the Backup Equation

Prior to Velero 2.x, the backup story for Kubernetes workloads with persistent data required either accepting full-snapshot overhead on every backup run, or running a separate file-level backup tool alongside Velero for volume data. The Restic integration, while functional, suffered from performance problems at scale and lacked true incremental capability at the block level.

Velero 2.x ships with Kopia as the default uploader, replacing Restic. Kopia implements content-defined chunking (CDC) for true incremental file-level backups, supports parallel upload workers, and integrates with Velero's CSI snapshot workflow. Combined with the VolumeSnapshotClass integration and the BackupItemAction v2 plugin API, Velero 2.x provides a coherent data protection platform for production Kubernetes.

Key improvements in 2.x:
- Kopia uploader replaces Restic as the default, with parallel chunk uploads and repository compression
- CSI snapshot lifecycle management with pre/post hooks
- BackupStorageLocation credential rotation without downtime
- Improved cross-namespace and cross-cluster restore with resource mapping
- Node-agent DaemonSet tuning for large-scale deployments

## Architecture Overview

A Velero 2.x deployment consists of the following components:

```
┌──────────────────────────────────────────────────────────┐
│ Kubernetes Cluster                                        │
│                                                          │
│  ┌─────────────────┐     ┌────────────────────────────┐  │
│  │ Velero Server   │────▶│ BackupStorageLocation (BSL)│  │
│  │ (Deployment)    │     │ S3 / GCS / Azure Blob      │  │
│  └────────┬────────┘     └────────────────────────────┘  │
│           │                                              │
│  ┌────────▼────────┐     ┌────────────────────────────┐  │
│  │ Node Agent      │────▶│ VolumeSnapshotLocation     │  │
│  │ (DaemonSet)     │     │ (VSL) - CSI Driver         │  │
│  └─────────────────┘     └────────────────────────────┘  │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Kopia Repository (stored in BSL)                    │ │
│  │  - Content-Addressed Storage                        │ │
│  │  - Dedup + Compression + Encryption                 │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Prerequisites

Before installing Velero 2.x, ensure:

- Kubernetes 1.27 or later
- CSI driver installed with VolumeSnapshot CRDs (snapshot.storage.k8s.io/v1)
- Object storage bucket with versioning enabled (for BSL)
- `velero` CLI 2.x installed locally

Verify CSI snapshot support:

```bash
kubectl get crd volumesnapshotclasses.snapshot.storage.k8s.io
kubectl get crd volumesnapshots.snapshot.storage.k8s.io
kubectl get crd volumesnapshotcontents.snapshot.storage.k8s.io
```

If the CRDs are missing, install the external-snapshotter:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.0.1/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

## Installing Velero 2.x with Helm

The Helm chart is the recommended production installation method for Velero 2.x.

### Create the credentials secret

For AWS S3 as the BSL:

```bash
cat > /tmp/credentials-velero <<EOF
[default]
aws_access_key_id=<aws-access-key-id>
aws_secret_access_key=<aws-secret-access-key>
EOF

kubectl create namespace velero

kubectl create secret generic velero-credentials \
  --namespace velero \
  --from-file=cloud=/tmp/credentials-velero
```

### Helm values for production deployment

```yaml
# velero-values.yaml
image:
  repository: velero/velero
  tag: v2.2.0
  pullPolicy: IfNotPresent

initContainers:
  - name: velero-plugin-for-aws
    image: velero/velero-plugin-for-aws:v1.10.0
    volumeMounts:
      - mountPath: /target
        name: plugins

configuration:
  backupStorageLocation:
    - name: default
      provider: aws
      bucket: my-velero-backups
      prefix: cluster-prod
      credential:
        name: velero-credentials
        key: cloud
      config:
        region: us-east-1
        s3ForcePathStyle: "false"
        s3Url: ""

  volumeSnapshotLocation:
    - name: default
      provider: aws
      credential:
        name: velero-credentials
        key: cloud
      config:
        region: us-east-1

  uploaderType: kopia
  defaultVolumesToFsBackup: false
  defaultSnapshotMoveData: false

  # Kopia repository configuration
  repositoryMaintenanceFrequency: 1h
  garbageCollectionFrequency: 1h

credentials:
  useSecret: true
  existingSecret: velero-credentials

deployNodeAgent: true

nodeAgent:
  podVolumePath: /var/lib/kubelet/pods
  tolerations:
    - operator: Exists
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: "2"
      memory: 2Gi
  # Kopia uploader parallelism
  extraEnvVars:
    - name: KOPIA_PARALLEL_UPLOADS
      value: "4"
    - name: KOPIA_COMPRESSION_ALGORITHM
      value: "zstd-fastest"

resources:
  requests:
    cpu: 500m
    memory: 128Mi
  limits:
    cpu: "1"
    memory: 512Mi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring

schedules:
  daily-backup:
    disabled: false
    schedule: "0 2 * * *"
    useOwnerReferencesInBackup: false
    template:
      ttl: "720h"
      storageLocation: default
      volumeSnapshotLocations:
        - default
      snapshotMoveData: true
      defaultVolumesToFsBackup: false
      includedNamespaces:
        - "*"
      excludedNamespaces:
        - kube-system
        - velero
        - cert-manager
      labelSelector: {}
      hooks: {}
```

Install via Helm:

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm repo update

helm upgrade --install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --version 7.2.0 \
  --values velero-values.yaml \
  --wait
```

## Configuring VolumeSnapshotClass for CSI Integration

Velero needs a VolumeSnapshotClass labeled so it knows which class to use for snapshots:

```yaml
# aws-ebs-vsc.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-aws-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
parameters:
  tagSpecification_1: "Name={{ .VolumeSnapshotNamespace }}/{{ .VolumeSnapshotName }}"
```

```bash
kubectl apply -f aws-ebs-vsc.yaml
```

For GKE with the GCE PD CSI driver:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-gce-pd-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: pd.csi.storage.gke.io
deletionPolicy: Retain
```

For Longhorn:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-snapshot-vsc
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

## Incremental Backups with Kopia

Kopia operates as a content-addressed store. When a backup runs, Kopia:

1. Scans the source files and computes content hashes using CDC
2. Compares hashes against the repository index
3. Uploads only new or changed content chunks
4. Updates the snapshot manifest

This is fundamentally different from Restic's approach, which required scanning the entire repository to determine what was new. Kopia's index is maintained in a compact, fast-to-query format.

### Kopia Repository Maintenance

Velero manages Kopia repository maintenance automatically, but you can inspect the state:

```bash
# Get repository details
kubectl exec -n velero deploy/velero -- velero repo get

# Trigger maintenance manually
kubectl exec -n velero deploy/velero -- velero repo maintenance run --repo-id <repo-id>
```

The Kopia repository stores data in the BSL under a path like:
```
s3://my-velero-backups/cluster-prod/kopia/<repo-id>/
```

Within this path you'll find:
- `p/` - Pack files (compressed, encrypted data chunks)
- `q/` - Quick ID files for deduplication
- `n/` - Index files
- `m/` - Manifest files (snapshot metadata)

### Monitoring Kopia Backup Progress

During a backup with volume data, monitor the node-agent logs:

```bash
kubectl logs -n velero -l app.kubernetes.io/name=node-agent -f --prefix
```

Sample output showing incremental behavior:

```
node-agent/velero-node-agent-abc123 Kopia uploader: found 1247 files, 8.3 GB total
node-agent/velero-node-agent-abc123 Kopia uploader: uploading 47 new files (234 MB), 1200 unchanged
node-agent/velero-node-agent-abc123 Kopia uploader: upload complete, 47 files uploaded
```

## CSI Snapshot Workflow

### How Velero Uses CSI Snapshots

When a backup is triggered for a namespace containing PVCs backed by a CSI driver:

1. Velero's BackupItemAction for PVCs pauses I/O (via pre-hooks if configured)
2. Velero creates a VolumeSnapshot object referencing the PVC
3. The CSI external-snapshotter watches for VolumeSnapshot creation
4. The CSI driver creates a point-in-time snapshot of the underlying storage
5. Velero waits for the VolumeSnapshot to reach `readyToUse: true`
6. Velero backs up the VolumeSnapshot, VolumeSnapshotContent, and VolumeSnapshotClass metadata to the BSL
7. Optionally, Velero can move the snapshot data to the BSL using the `snapshotMoveData` feature

### Snapshot Data Movement (CSI to Object Storage)

With `snapshotMoveData: true`, Velero goes further than just recording snapshot metadata. It reads the snapshot contents and uploads them to the BSL via Kopia. This enables restoring the data to a cluster with a different CSI driver or cloud provider.

```yaml
# backup with snapshot data movement
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: app-backup-with-data-movement
  namespace: velero
spec:
  includedNamespaces:
    - production
  snapshotMoveData: true
  storageLocation: default
  volumeSnapshotLocations:
    - default
  ttl: 720h0m0s
```

Monitor the DataUpload objects created during this process:

```bash
kubectl get datauploads -n velero -w
```

### Pre and Post Hooks for Application Consistency

For databases and stateful applications, use pre/post hooks to quiesce I/O before snapshotting:

```yaml
# postgres-backup-example.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: production
  annotations:
    pre.hook.backup.velero.io/command: >
      ["/bin/bash", "-c", "psql -U $POSTGRES_USER -c 'CHECKPOINT;'"]
    pre.hook.backup.velero.io/container: postgres
    pre.hook.backup.velero.io/on-error: Fail
    pre.hook.backup.velero.io/timeout: 60s
    post.hook.backup.velero.io/command: >
      ["/bin/bash", "-c", "echo 'Backup complete'"]
    post.hook.backup.velero.io/container: postgres
    post.hook.backup.velero.io/timeout: 30s
```

For MySQL with InnoDB:

```yaml
annotations:
  pre.hook.backup.velero.io/command: >
    ["/bin/bash", "-c", "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'FLUSH TABLES WITH READ LOCK; FLUSH LOGS;'"]
  pre.hook.backup.velero.io/container: mysql
  pre.hook.backup.velero.io/on-error: Fail
  pre.hook.backup.velero.io/timeout: 120s
  post.hook.backup.velero.io/command: >
    ["/bin/bash", "-c", "mysql -u root -p$MYSQL_ROOT_PASSWORD -e 'UNLOCK TABLES;'"]
  post.hook.backup.velero.io/container: mysql
```

## Backup Schedules and Retention

### Tiered Backup Schedule

Production environments typically need a tiered approach:

```yaml
# hourly-backup.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: hourly-critical-apps
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    ttl: 48h
    includedNamespaces:
      - payments
      - auth
    snapshotMoveData: false
    storageLocation: default
    volumeSnapshotLocations:
      - default
---
# daily-backup.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-cluster
  namespace: velero
spec:
  schedule: "0 3 * * *"
  template:
    ttl: 720h
    excludedNamespaces:
      - kube-system
      - velero
    snapshotMoveData: true
    storageLocation: default
    volumeSnapshotLocations:
      - default
---
# weekly-backup.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-archive
  namespace: velero
spec:
  schedule: "0 4 * * 0"
  template:
    ttl: 8760h
    excludedNamespaces:
      - kube-system
      - velero
    snapshotMoveData: true
    storageLocation: archive
    volumeSnapshotLocations:
      - default
```

### Backup Status Verification

Always verify backup completion and health:

```bash
# List recent backups
velero backup get

# Describe a specific backup
velero backup describe daily-full-cluster-20310718020000 --details

# Check for warnings or errors
velero backup logs daily-full-cluster-20310718020000 | grep -E "error|warning"
```

A healthy backup output:

```
Name:         daily-full-cluster-20310718020000
Namespace:    velero
Labels:       velero.io/schedule-name=daily-full-cluster
Annotations:  velero.io/source-cluster-k8s-gitversion=v1.32.0

Phase:  Completed

Errors:    0
Warnings:  0

Namespaces:
  Included:  *
  Excluded:  kube-system, velero

Resources:
  Included:        *
  Excluded:        <none>
  Cluster-scoped:  auto

Label selector:  <none>

Storage Location:  default

Velero-Native Snapshot PVs:  auto
Snapshot Move Data:          true

TTL:  720h0m0s

CSI Snapshots: 14 of 14 snapshots completed successfully
```

## Restore Operations

### Standard Namespace Restore

```bash
# Restore entire namespace from latest backup
velero restore create --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces production \
  --wait

# Restore with namespace mapping (to a different namespace)
velero restore create --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces production \
  --namespace-mappings production:production-restored \
  --wait
```

### Restore with Resource Filtering

```bash
# Restore only ConfigMaps and Secrets
velero restore create --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces production \
  --include-resources configmaps,secrets \
  --wait

# Restore by label selector
velero restore create --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces production \
  --selector "app=payments" \
  --wait
```

### Selective PVC Restore

When restoring PVCs from CSI snapshots, Velero creates VolumeSnapshot objects and then creates PVCs from those snapshots via a VolumeSnapshotContent restore:

```yaml
# partial-restore.yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: payments-pvc-restore
  namespace: velero
spec:
  backupName: daily-full-cluster-20310718020000
  includedNamespaces:
    - production
  includedResources:
    - persistentvolumeclaims
    - persistentvolumes
    - volumesnapshots
    - volumesnapshotcontents
  restorePVs: true
  preserveNodePorts: false
```

Monitor DataDownload objects created during restore:

```bash
kubectl get datadownloads -n velero -w
```

## Cross-Cluster Migration

Cross-cluster migration is one of the most powerful use cases for Velero 2.x. The `snapshotMoveData: true` feature is critical here — without it, CSI snapshots are provider-specific and cannot cross cloud boundaries.

### Migration Architecture

```
Source Cluster                    Destination Cluster
──────────────                    ───────────────────
Velero + Node Agent               Velero + Node Agent
    │                                     │
    │    Shared S3 Bucket (BSL)           │
    └──────────────┬──────────────────────┘
                   │
           Kopia Repository
           (portable data)
```

### Step 1: Configure Shared BSL on Both Clusters

Both clusters must point to the same BSL bucket:

```bash
# On source cluster - already configured
velero backup-location get

# On destination cluster - add the same BSL
velero backup-location create shared-bsl \
  --provider aws \
  --bucket my-velero-backups \
  --prefix cluster-prod \
  --credential velero-credentials:cloud \
  --config region=us-east-1
```

### Step 2: Trigger Migration Backup on Source

```bash
velero backup create migration-$(date +%Y%m%d) \
  --include-namespaces production,staging \
  --snapshot-move-data \
  --storage-location default \
  --wait
```

### Step 3: Verify Backup Accessibility on Destination

```bash
# Switch context to destination cluster
kubectl config use-context destination-cluster

# List backups (destination Velero can see source backups via shared BSL)
velero backup get

# The migration backup should appear
```

### Step 4: Restore on Destination with Resource Mapping

Cross-cluster restores often require mapping storage classes and resource adjustments:

```yaml
# restore-config.yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: production-migration
  namespace: velero
spec:
  backupName: migration-20310718
  includedNamespaces:
    - production
  restorePVs: true
  # Map old storage class to new one
  restoreStatus:
    includedResources: []
  itemOperationTimeout: 4h0m0s
```

For storage class mapping, use a ConfigMap:

```yaml
# storage-class-map.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: change-storage-class-config
  namespace: velero
  labels:
    velero.io/plugin-config: ""
    velero.io/change-storage-class: RestoreItemAction
data:
  # Source storage class: destination storage class
  gp2: gp3
  standard: premium-rwo
```

Apply and trigger the restore:

```bash
kubectl apply -f storage-class-map.yaml

velero restore create production-migration \
  --from-backup migration-20310718 \
  --include-namespaces production \
  --wait
```

### Step 5: Validate Migration

```bash
# Check restore status
velero restore describe production-migration --details

# Verify pods are running on destination
kubectl get pods -n production

# Check PVC binding
kubectl get pvc -n production

# Verify data integrity (application-specific)
kubectl exec -n production deploy/payments-api -- /health-check.sh
```

## Advanced Velero Configuration

### Multiple Backup Storage Locations

Enterprise deployments often require multiple BSLs for different retention tiers or geographic redundancy:

```yaml
# additional-bsl.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: secondary-region
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: my-velero-backups-eu
    prefix: cluster-prod
  credential:
    name: velero-eu-credentials
    key: cloud
  config:
    region: eu-west-1
  default: false
  accessMode: ReadWrite
  backupSyncPeriod: 1m
```

Rotating credentials for a BSL without downtime:

```bash
# Update the secret
kubectl patch secret velero-credentials -n velero \
  --type='json' \
  -p='[{"op":"replace","path":"/data/cloud","value":"<base64-encoded-new-credentials>"}]'

# Velero will pick up the new credentials at the next backup sync
```

### Node Agent Resource Tuning

For large clusters with many PVCs, tune the node-agent DaemonSet:

```yaml
# node-agent-patch.yaml
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
            requests:
              cpu: "1"
              memory: 1Gi
            limits:
              cpu: "4"
              memory: 4Gi
          env:
            - name: KOPIA_PARALLEL_UPLOADS
              value: "8"
            - name: KOPIA_PARALLEL_RESTORE
              value: "8"
            - name: KOPIA_CONTENT_CACHE_SIZE_MB
              value: "2048"
            - name: KOPIA_METADATA_CACHE_SIZE_MB
              value: "512"
```

### Backup Hooks for StatefulSets

For StatefulSets where each pod has its own PVC, use pod-level hooks:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: elastic
spec:
  template:
    metadata:
      annotations:
        pre.hook.backup.velero.io/command: >
          ["/bin/bash", "-c",
           "curl -s -X POST 'http://localhost:9200/_flush/synced'"]
        pre.hook.backup.velero.io/container: elasticsearch
        pre.hook.backup.velero.io/on-error: Fail
        pre.hook.backup.velero.io/timeout: 120s
```

## Prometheus Monitoring Integration

Velero exposes Prometheus metrics on port 8085. A comprehensive alerting setup:

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
      rules:
        - alert: VeleroBackupFailure
          expr: |
            increase(velero_backup_failure_total[1h]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Velero backup failed"
            description: "Backup {{ $labels.schedule }} has failed in the last hour."

        - alert: VeleroBackupPartialFailure
          expr: |
            increase(velero_backup_partial_failure_total[1h]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Velero backup completed with partial failure"

        - alert: VeleroBackupMissed
          expr: |
            time() - velero_backup_last_successful_timestamp > 86400
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Velero backup has not completed in 24 hours"
            description: "Schedule {{ $labels.schedule }} last succeeded over 24h ago."

        - alert: VeleroCSISnapshotFailed
          expr: |
            increase(velero_csi_snapshot_failure_total[1h]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Velero CSI snapshot failed"

        - alert: VeleroNodeAgentDown
          expr: |
            kube_daemonset_status_number_ready{daemonset="node-agent",namespace="velero"}
            < kube_daemonset_status_desired_number_scheduled{daemonset="node-agent",namespace="velero"}
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Velero node-agent pods not ready"
```

## Disaster Recovery Runbook

### Scenario: Complete Cluster Loss

```bash
# 1. Provision new cluster with same or compatible Kubernetes version
# 2. Install CSI driver and snapshot CRDs
# 3. Install Velero with BSL pointing to existing backup bucket

helm upgrade --install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --values velero-dr-values.yaml \
  --wait

# 4. Wait for Velero to sync backup list from BSL
kubectl get backups -n velero --watch

# 5. Restore infrastructure namespaces first
velero restore create dr-infra \
  --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces cert-manager,external-dns,ingress-nginx \
  --wait

# 6. Restore application namespaces
velero restore create dr-apps \
  --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces production,staging \
  --restore-volumes=true \
  --wait

# 7. Verify
kubectl get nodes
kubectl get pods -A | grep -v Running | grep -v Completed
```

### Scenario: Accidental Namespace Deletion

```bash
# Find the most recent backup containing the namespace
velero backup get | head -5

# Restore just the deleted namespace
velero restore create accidental-delete-recovery \
  --from-backup daily-full-cluster-20310718020000 \
  --include-namespaces deleted-namespace \
  --existing-resource-policy update \
  --wait

# Verify
kubectl get all -n deleted-namespace
```

## Troubleshooting Common Issues

### Issue: CSI Snapshot Stuck in Pending

```bash
# Check VolumeSnapshot status
kubectl describe volumesnapshot -n production

# Check VolumeSnapshotContent
kubectl get volumesnapshotcontents

# Check external-snapshotter logs
kubectl logs -n kube-system -l app=snapshot-controller --tail=50
```

Common cause: The VolumeSnapshotClass `deletionPolicy` is set to `Delete` but the snapshot driver requires `Retain`. Always use `Retain` for Velero snapshots.

### Issue: Kopia Upload Stalled

```bash
# Check node-agent pod on the node where the PVC lives
kubectl get pod -n production <pod-name> -o wide
kubectl logs -n velero <node-agent-pod-on-same-node> --tail=100 | grep -E "error|stall|timeout"

# Check for disk pressure on the node
kubectl describe node <node-name> | grep -A5 Conditions
```

### Issue: Restore PVC Stuck in Pending

```bash
# Check DataDownload status
kubectl get datadownloads -n velero -o wide

# Describe the stuck DataDownload
kubectl describe dataddownload -n velero <name>

# Verify the BSL is accessible from the node
kubectl exec -n velero <node-agent-pod> -- velero repo list
```

### Issue: Cross-Cluster Restore Fails with StorageClass Not Found

```bash
# Apply the storage class mapping ConfigMap before restore
kubectl apply -f storage-class-map.yaml

# Verify the mapping is loaded
kubectl get cm change-storage-class-config -n velero -o yaml
```

## Summary

Velero 2.x represents a significant maturation in Kubernetes backup and restore. The combination of Kopia's incremental, content-addressed backups with CSI snapshot integration and cross-cluster data movement provides a platform that can meet enterprise RPO/RTO requirements without additional tooling.

Key takeaways:
- Use `snapshotMoveData: true` for any backup intended for cross-cluster or cross-provider restore
- Configure pre/post hooks for all stateful workloads to ensure crash-consistent backups
- Tune node-agent resources and Kopia parallelism for large PVC environments
- Monitor Velero Prometheus metrics with structured alerting
- Test restore procedures regularly in a staging environment — backups are only as good as your last successful restore test

The tiered schedule approach (hourly for critical apps, daily for full cluster, weekly for archives) provides comprehensive coverage with manageable storage costs when combined with Kopia's deduplication and compression.
