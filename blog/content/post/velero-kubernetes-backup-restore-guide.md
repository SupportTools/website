---
title: "Velero Kubernetes Backup and Restore: Cluster Migration and DR Automation"
date: 2027-07-25T00:00:00-05:00
draft: false
tags: ["Velero", "Kubernetes", "Backup", "Disaster Recovery"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Velero for Kubernetes backup, restore, and cluster migration. Covers BackupStorageLocation, CSI snapshots, hooks for database consistency, schedule TTLs, and GitOps-compatible DR workflows."
more_link: "yes"
url: "/velero-kubernetes-backup-restore-guide/"
---

Losing a Kubernetes cluster without a tested restore path is not a hypothetical risk — it is an operational certainty waiting for the wrong moment. Velero addresses this by providing a Kubernetes-native backup and restore framework that integrates with object storage, CSI volume snapshot APIs, and workload-level hooks. This guide covers every layer of a production Velero deployment: storage configuration, schedule management, namespace and resource filtering, CSI integration, restore workflows, cluster migration patterns, and monitoring.

<!--more-->

## Velero Architecture

Velero runs as a Deployment inside the cluster being protected. When a Backup object is created, the Velero server serializes all selected Kubernetes API objects to JSON, uploads them to an object storage bucket, and optionally triggers volume snapshots through either the legacy restic/kopia integration or the modern CSI VolumeSnapshot API.

```
┌─────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                      │
│                                                          │
│  ┌──────────────┐     ┌────────────────────────────┐    │
│  │ Velero Server│────▶│ Kubernetes API Server       │    │
│  │ (Deployment) │     │ (list/watch all resources)  │    │
│  └──────┬───────┘     └────────────────────────────┘    │
│         │                                                │
│         │ Upload JSON                                    │
│         ▼                                                │
│  ┌──────────────┐     ┌────────────────────────────┐    │
│  │ BackupStorage│     │ CSI Snapshot Controller     │    │
│  │ Location     │     │ (VolumeSnapshot CRDs)       │    │
│  └──────┬───────┘     └────────────────────────────┘    │
└─────────┼────────────────────────────────────────────────┘
          │
          ▼
   ┌──────────────┐
   │ Object Store │   (S3, GCS, Azure Blob, MinIO)
   │  - manifests │
   │  - logs      │
   └──────────────┘
```

The key custom resources are:

- **BackupStorageLocation (BSL)** — points to a bucket and credentials
- **VolumeSnapshotLocation (VSL)** — points to a snapshot provider
- **Backup** — represents one backup execution
- **Restore** — drives a restore from a named backup
- **Schedule** — a cron-driven Backup factory

## Installation

### Prerequisites

```bash
# Velero CLI installation (Linux amd64)
curl -L https://github.com/vmware-tanzu/velero/releases/download/v1.13.2/velero-v1.13.2-linux-amd64.tar.gz \
  | tar -xz -C /usr/local/bin --strip-components=1 velero-v1.13.2-linux-amd64/velero

velero version --client-only
```

### Installing Velero with the AWS Plugin

```bash
# Create credentials file — replace with real credentials via sealed secret or IRSA
cat <<'EOF' > /tmp/credentials-velero
[default]
aws_access_key_id=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME
aws_secret_access_key=REPLACE_WITH_YOUR_SECRET_ACCESS_KEY
EOF

velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-cluster-backups \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --secret-file /tmp/credentials-velero \
  --use-node-agent \
  --default-volumes-to-fs-backup=false \
  --wait
```

### Using IRSA (Recommended for EKS)

Rather than static credentials, use IAM Roles for Service Accounts:

```yaml
# velero-irsa-patch.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: velero
  namespace: velero
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/velero-backup-role
```

```bash
kubectl apply -f velero-irsa-patch.yaml

# Reinstall without --secret-file
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-cluster-backups \
  --backup-location-config region=us-east-1 \
  --no-secret \
  --sa-annotations eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/velero-backup-role \
  --use-node-agent \
  --wait
```

## BackupStorageLocation Configuration

A cluster can have multiple BSLs pointing to different buckets or regions. The `default` BSL is used when no location is specified.

```yaml
# bsl-primary.yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: primary
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-cluster-backups
    prefix: prod-cluster
  config:
    region: us-east-1
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/REPLACE_WITH_KMS_KEY_ID
  credential:
    name: velero-credentials
    key: cloud
  default: true
  accessMode: ReadWrite
  validationFrequency: 1m
```

```yaml
# bsl-dr.yaml — secondary BSL in different region
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: dr-region
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: velero-cluster-backups-dr
    prefix: prod-cluster
  config:
    region: us-west-2
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-west-2:123456789012:key/REPLACE_WITH_DR_KMS_KEY_ID
  credential:
    name: velero-credentials-dr
    key: cloud
  accessMode: ReadWrite
```

```bash
# Verify BSL status
kubectl get backupstoragelocation -n velero
# NAME       PHASE       LAST VALIDATED   AGE   DEFAULT
# primary    Available   10s              5m    true
# dr-region  Available   12s              2m    false
```

## VolumeSnapshotLocation Configuration

```yaml
# vsl-aws.yaml
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: aws-ebs
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
    tagSnapshots: "true"
```

## Backup Schedules and TTLs

### Defining a Schedule

```yaml
# schedule-full-daily.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: full-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"    # 02:00 UTC daily
  useOwnerReferencesInBackup: false
  template:
    ttl: 720h               # 30 days retention
    storageLocation: primary
    volumeSnapshotLocations:
      - aws-ebs
    includedNamespaces:
      - "*"
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
      - monitoring
    excludedResources:
      - events
      - events.events.k8s.io
    snapshotVolumes: true
    labelSelector:
      matchExpressions:
        - key: velero.io/exclude-from-backup
          operator: DoesNotExist
    metadata:
      labels:
        backup-type: full
        cluster: prod
```

```yaml
# schedule-namespaces-hourly.yaml — frequent backup for critical namespaces
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: critical-hourly
  namespace: velero
spec:
  schedule: "0 * * * *"
  template:
    ttl: 48h
    storageLocation: primary
    includedNamespaces:
      - payments
      - orders
      - user-data
    snapshotVolumes: true
    metadata:
      labels:
        backup-type: critical-hourly
```

### TTL Strategy

| Backup Type | Frequency | TTL | Use Case |
|---|---|---|---|
| Critical namespaces | Hourly | 48h | RPO < 1 hour for key workloads |
| Full cluster | Daily | 30 days | Standard DR baseline |
| Pre-upgrade snapshot | On-demand | 72h | Cluster upgrade safety net |
| Migration export | On-demand | 168h | Cluster migration source |

## Include and Exclude Filters

### Namespace Filtering

```bash
# Back up only specific namespaces
velero backup create app-backup \
  --include-namespaces payments,orders,user-data \
  --ttl 24h

# Exclude specific namespaces from full backup
velero backup create cluster-backup \
  --exclude-namespaces kube-system,monitoring,cert-manager \
  --ttl 720h
```

### Resource-Level Filtering

```bash
# Exclude non-essential resource types
velero backup create app-backup \
  --include-namespaces production \
  --exclude-resources events,events.events.k8s.io,endpointslices \
  --ttl 168h

# Include only specific resource types
velero backup create secrets-only \
  --include-resources secrets,configmaps \
  --include-namespaces production,staging \
  --ttl 48h
```

### Label Selector Filtering

```bash
# Back up workloads with a specific label
velero backup create tier-backend \
  --selector "tier=backend,backup=true" \
  --ttl 168h
```

Mark resources to exclude using a label:

```bash
kubectl label namespace monitoring velero.io/exclude-from-backup=true
kubectl label deployment prometheus -n monitoring velero.io/exclude-from-backup=true
```

## CSI Volume Snapshots

The CSI-based approach is preferred over the legacy Restic/Kopia file-system backup for performance and consistency.

### Enable CSI Integration

```bash
# Ensure the CSI snapshot CRDs are installed
kubectl get crd volumesnapshotclasses.snapshot.storage.k8s.io

# Enable CSI feature flags in Velero
velero install \
  --features=EnableCSI \
  --plugins velero/velero-plugin-for-aws:v1.10.0,velero/velero-plugin-for-csi:v0.7.1 \
  ...
```

### VolumeSnapshotClass Annotation

```yaml
# annotate the VolumeSnapshotClass used by EBS CSI driver
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-vsc
  annotations:
    velero.io/csi-volumesnapshot-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain
```

### PVC-Level Opt-In

```yaml
# annotate a PVC to use CSI snapshots
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
  annotations:
    backup.velero.io/backup-volumes: postgres-data
```

## Velero Hooks for Database Consistency

Pre- and post-backup hooks quiesce databases before snapshots are taken.

### PostgreSQL Hook

```yaml
# postgres-deployment-with-hooks.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: production
  annotations:
    pre.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c",
       "psql -U postgres -c 'CHECKPOINT;' && psql -U postgres -c 'SELECT pg_start_backup(now()::text, true, false);'"]
    pre.hook.backup.velero.io/container: postgres
    pre.hook.backup.velero.io/on-error: Fail
    pre.hook.backup.velero.io/timeout: 60s
    post.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c",
       "psql -U postgres -c 'SELECT pg_stop_backup();'"]
    post.hook.backup.velero.io/container: postgres
    post.hook.backup.velero.io/on-error: Fail
    post.hook.backup.velero.io/timeout: 30s
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
```

### MySQL Hook

```yaml
# mysql-hooks annotation on Deployment
annotations:
  pre.hook.backup.velero.io/command: >-
    ["/bin/bash", "-c",
     "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'FLUSH TABLES WITH READ LOCK; FLUSH LOGS;'"]
  pre.hook.backup.velero.io/container: mysql
  pre.hook.backup.velero.io/on-error: Fail
  pre.hook.backup.velero.io/timeout: 60s
  post.hook.backup.velero.io/command: >-
    ["/bin/bash", "-c",
     "mysql -u root -p${MYSQL_ROOT_PASSWORD} -e 'UNLOCK TABLES;'"]
  post.hook.backup.velero.io/container: mysql
  post.hook.backup.velero.io/on-error: Fail
```

### Hook Error Policies

| Value | Behavior |
|---|---|
| `Fail` | Mark backup as failed if hook fails |
| `Continue` | Log the error but continue the backup |

Use `Fail` for databases. Use `Continue` for non-critical pre/post tasks like cache invalidation.

## Restore Workflows

### Restore to the Same Cluster

```bash
# List available backups
velero backup get

# Restore a full backup
velero restore create \
  --from-backup full-daily-20270724000000 \
  --wait

# Restore only specific namespaces
velero restore create \
  --from-backup full-daily-20270724000000 \
  --include-namespaces payments,orders \
  --wait

# Restore without PVs (manifests only)
velero restore create \
  --from-backup full-daily-20270724000000 \
  --restore-volumes=false \
  --wait
```

### Restore to a Different Namespace

```bash
velero restore create \
  --from-backup full-daily-20270724000000 \
  --namespace-mappings "production:production-restore-test" \
  --wait
```

### Restore Status Monitoring

```bash
velero restore describe production-restore-20270724 --details

# Check events for failures
kubectl get events -n velero \
  --field-selector reason=RestoreFailed \
  --sort-by='.lastTimestamp'
```

## Cluster Migration Use Case

Cluster migration is one of the most valuable Velero use cases: move all workloads from an old cluster to a new one with minimal downtime.

### Migration Procedure

```bash
# Step 1: Take a migration backup on the SOURCE cluster
velero backup create cluster-migration \
  --exclude-namespaces kube-system,kube-public,kube-node-lease \
  --storage-location primary \
  --ttl 168h \
  --wait

# Verify backup completed
velero backup describe cluster-migration

# Step 2: Install Velero on the TARGET cluster pointing to the SAME bucket
# The target cluster's Velero reads the backup from the shared BSL

# Step 3: Sync BSL on target cluster
velero backup-location get

# Step 4: Restore on target cluster
velero restore create migrate-from-old \
  --from-backup cluster-migration \
  --wait

# Step 5: Verify workloads on target cluster
kubectl get pods --all-namespaces | grep -v Running
```

### Post-Migration Checklist

```bash
# Verify PVCs are bound
kubectl get pvc --all-namespaces | grep -v Bound

# Verify services have endpoints
kubectl get endpoints --all-namespaces | grep "<none>"

# Verify ingresses have addresses
kubectl get ingress --all-namespaces

# Verify secrets are present
kubectl get secrets --all-namespaces | grep -v 'kubernetes.io/service-account'
```

## Monitoring Backup Status

### Prometheus Metrics

Velero exposes metrics on port 8085 at `/metrics`. Key metrics:

```promql
# Backup success/failure counts
velero_backup_success_total{schedule="full-daily"}
velero_backup_failure_total{schedule="full-daily"}
velero_backup_partial_failure_total

# Last successful backup time (Unix timestamp)
velero_backup_last_successful_timestamp{schedule="full-daily"}

# Duration of last backup
velero_backup_duration_seconds{schedule="full-daily"}

# Number of items backed up
velero_backup_items_total{backup="full-daily-20270724000000"}

# CSI snapshot status
velero_csi_snapshot_success_total
velero_csi_snapshot_failure_total
```

### Alerting Rules

```yaml
# velero-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
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
            team: platform
          annotations:
            summary: "Velero backup failed"
            description: "Backup schedule {{ $labels.schedule }} has failed in the last hour."

        - alert: VeleroBackupNotRun
          expr: |
            (time() - velero_backup_last_successful_timestamp{schedule="full-daily"}) > 90000
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Velero daily backup is overdue"
            description: "No successful backup for full-daily schedule in the last 25 hours."

        - alert: VeleroBackupStorageUnavailable
          expr: |
            velero_backup_storage_location_phase{phase!="Available"} == 1
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Velero BackupStorageLocation unavailable"
            description: "BSL {{ $labels.backuplocation }} is not in Available phase."

        - alert: VeleroCSISnapshotFailed
          expr: |
            increase(velero_csi_snapshot_failure_total[1h]) > 0
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Velero CSI snapshot failure"
            description: "One or more CSI volume snapshots failed in the last hour."
```

### Grafana Dashboard (Key Panels)

```bash
# Import the official Velero dashboard
# Dashboard ID: 11055 on grafana.com
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: velero-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  velero.json: |
    {"id":null,"title":"Velero","uid":"velero-overview","panels":[]}
EOF
```

## Migration from Heptio Ark

Velero was previously named Heptio Ark. Organizations still running Ark need to migrate:

```bash
# Check current Ark version
kubectl get deployment ark -n heptio-ark -o jsonpath='{.spec.template.spec.containers[0].image}'

# Migration path:
# 1. Upgrade Ark to the last 0.11.x release
# 2. Install Velero 1.0+ in parallel (different namespace)
# 3. Migrate BackupStorageLocations to Velero format
# 4. Remove Ark after validation
```

### CRD Migration

Ark CRDs map to Velero CRDs as follows:

| Ark CRD | Velero CRD |
|---|---|
| `backups.ark.heptio.com` | `backups.velero.io` |
| `schedules.ark.heptio.com` | `schedules.velero.io` |
| `restores.ark.heptio.com` | `restores.velero.io` |
| `downloadrequests.ark.heptio.com` | `downloadrequests.velero.io` |
| `config.ark.heptio.com` | `BackupStorageLocation` + `VolumeSnapshotLocation` |

## Production Best Practices

### Encryption

Always encrypt backups at rest and in transit:

```yaml
# BSL with S3 SSE-KMS
spec:
  config:
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/REPLACE_WITH_KMS_KEY_ID
```

### Backup Validation

```bash
# Run a partial restore to a test namespace monthly
velero restore create validation-test \
  --from-backup full-daily-$(date -d 'yesterday' +%Y%m%d)000000 \
  --include-namespaces payments \
  --namespace-mappings "payments:velero-validation" \
  --wait

# Clean up test namespace
kubectl delete namespace velero-validation
```

### Resource Quotas for Velero Namespace

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: velero-quota
  namespace: velero
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
```

### Node Affinity for Velero Server

```yaml
# Pin Velero server to control-plane adjacent nodes
spec:
  template:
    spec:
      nodeSelector:
        node-role.kubernetes.io/infra: "true"
      tolerations:
        - key: "node-role.kubernetes.io/infra"
          operator: "Exists"
          effect: "NoSchedule"
```

## Troubleshooting

### Backup Stuck in InProgress

```bash
# Check Velero server logs
kubectl logs -n velero deployment/velero -f

# Describe the backup
velero backup describe <backup-name> --details

# Common causes:
# 1. BSL credentials expired
kubectl get secret velero-credentials -n velero -o yaml

# 2. PVC snapshot timeout — increase timeout
velero backup create ... --item-operation-timeout 4h

# 3. Hook timeout — check hook logs
velero backup logs <backup-name> | grep -i hook
```

### Restore Missing Resources

```bash
# Check restore warnings
velero restore describe <restore-name> --details | grep Warning

# Common causes:
# 1. CRDs not present on target cluster
# 2. API version mismatch (v1beta1 vs v1)
# 3. Namespace pre-existing with conflicting resources

# Fix: restore CRDs first
velero restore create crds-only \
  --from-backup cluster-migration \
  --include-resources customresourcedefinitions \
  --wait
```

### BSL Shows Phase: Unavailable

```bash
# Check connectivity and credentials
kubectl logs -n velero deployment/velero | grep "BackupStorageLocation"

# Manually validate bucket access
aws s3 ls s3://velero-cluster-backups/prod-cluster/ \
  --region us-east-1

# Check BSL validation frequency
kubectl get backupstoragelocation primary -n velero -o yaml | grep validationFrequency
```

## Summary

Velero provides production-grade backup and restore capabilities for Kubernetes clusters through a clean set of CRDs, plugin architecture, and deep integration with cloud-native snapshot APIs. Key implementation points:

- Configure both a primary and DR BackupStorageLocation for resilience
- Use CSI VolumeSnapshot integration over Restic for stateful workloads
- Implement database consistency hooks for PostgreSQL and MySQL
- Define schedule-based backups with appropriate TTLs per criticality tier
- Monitor backup success via Prometheus metrics and alert on failures
- Test restores to isolated namespaces monthly to validate DR readiness
- Use the cluster migration workflow for zero-risk Kubernetes upgrades

With these patterns in place, Velero becomes the foundation of a verifiable, automatable disaster recovery posture for Kubernetes infrastructure.
