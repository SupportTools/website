---
title: "Kubernetes Backup Strategy with CloudNativePG: PostgreSQL PITR and Barman Integration"
date: 2030-11-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PostgreSQL", "CloudNativePG", "Barman", "Backup", "PITR", "S3", "Disaster Recovery"]
categories:
- Kubernetes
- PostgreSQL
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise CloudNativePG backup guide covering WAL archiving to S3/GCS/Azure Blob, scheduled base backups, point-in-time recovery procedures, backup verification testing, cross-cluster recovery, and monitoring backup health with Prometheus metrics."
more_link: "yes"
url: "/cloudnativepg-backup-pitr-barman-s3-enterprise-guide/"
---

CloudNativePG has become the dominant Kubernetes-native operator for running production PostgreSQL clusters, and its deep integration with Barman Cloud for backup and WAL archiving makes it a compelling choice for teams that need genuine point-in-time recovery (PITR) guarantees. This guide walks through the full backup lifecycle: configuring WAL archiving to object storage, scheduling base backups, executing PITR restores, verifying backup integrity, and exposing backup health through Prometheus.

<!--more-->

## Understanding the CloudNativePG Backup Architecture

CloudNativePG delegates all backup and WAL archiving work to `barman-cloud`, a set of Python utilities that ship inside the operator-managed container image. Every standby and primary write the WAL segments to object storage continuously; base backups are taken with `barman-cloud-backup` on a schedule defined in the `Cluster` spec.

The architecture separates three concerns:

- **WAL archiving**: Continuous, low-latency upload of 16 MB WAL segments from the primary.
- **Base backups**: Periodic full or incremental filesystem snapshots that provide the starting point for recovery.
- **Recovery catalog**: A JSON manifest (`backup.info`) written by Barman that enumerates all available backups and their WAL coverage windows.

Point-in-time recovery works by restoring the nearest base backup that precedes the target time, then replaying WAL until the target LSN is reached.

## Prerequisites and Environment Setup

The examples in this guide use the following environment:

- Kubernetes 1.29+
- CloudNativePG operator 1.23+
- An S3-compatible object store (AWS S3, MinIO, or Ceph RGW)
- A GCS bucket or Azure Blob container for cross-cloud DR examples

Install the CloudNativePG operator via the official Helm chart:

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update

helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version 0.21.0 \
  --set monitoring.enablePodMonitor=true
```

Verify the operator is running:

```bash
kubectl -n cnpg-system get pods
# NAME                                  READY   STATUS    RESTARTS   AGE
# cnpg-cloudnative-pg-7d9f8c6b5-xkqvt  1/1     Running   0          2m
```

## Configuring Object Storage Credentials

### AWS S3 Credentials

Create a Kubernetes Secret containing the IAM credentials for the backup bucket. Using IAM Roles for Service Accounts (IRSA) is preferred in EKS environments, but static credentials work for any cluster.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: backup-storage-credentials
  namespace: postgres
type: Opaque
stringData:
  ACCESS_KEY_ID: "<aws-access-key-id>"
  ACCESS_SECRET_KEY: "<aws-secret-access-key>"
```

For IRSA-based authentication, annotate the ServiceAccount that CloudNativePG creates for the cluster:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: postgres-prod
  namespace: postgres
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/cnpg-backup-role"
```

### GCS Credentials

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gcs-backup-credentials
  namespace: postgres
type: Opaque
stringData:
  APPLICATION_CREDENTIALS: |
    {
      "type": "service_account",
      "project_id": "my-project-id",
      "private_key_id": "<key-id>",
      "private_key": "<base64-encoded-private-key>",
      "client_email": "cnpg-backup@my-project-id.iam.gserviceaccount.com",
      "client_id": "123456789012345678901",
      "auth_uri": "https://accounts.google.com/o/oauth2/auth",
      "token_uri": "https://oauth2.googleapis.com/token"
    }
```

### Azure Blob Storage

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: azure-backup-credentials
  namespace: postgres
type: Opaque
stringData:
  AZURE_STORAGE_ACCOUNT: "mypostgresbackups"
  AZURE_STORAGE_KEY: "<azure-storage-account-key>"
```

## Defining the Cluster with Backup Configuration

The following `Cluster` manifest configures a three-node PostgreSQL 16 cluster with WAL archiving to S3 and daily base backups:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod
  namespace: postgres
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
      effective_cache_size: "2GB"
      work_mem: "16MB"
      maintenance_work_mem: "128MB"
      wal_level: "replica"
      archive_mode: "on"
      # wal_compression is handled by barman-cloud arguments
      log_checkpoints: "on"
      log_connections: "on"
      log_disconnections: "on"
      log_lock_waits: "on"
      log_temp_files: "1kB"
      log_autovacuum_min_duration: "250ms"
      pg_stat_statements.max: "10000"
      pg_stat_statements.track: "all"

  storage:
    size: 100Gi
    storageClass: gp3-encrypted

  walStorage:
    size: 20Gi
    storageClass: gp3-encrypted

  resources:
    requests:
      memory: "2Gi"
      cpu: "1"
    limits:
      memory: "4Gi"
      cpu: "2"

  backup:
    # Barman Cloud configuration for WAL archiving and base backups
    barmanObjectStore:
      destinationPath: "s3://my-postgres-backups/postgres-prod/"
      serverName: "postgres-prod"
      s3Credentials:
        accessKeyId:
          name: backup-storage-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-storage-credentials
          key: ACCESS_SECRET_KEY
      # Optional: specify AWS region explicitly
      endpointURL: ""
      data:
        compression: gzip
        encryption: AES256
        # Number of parallel upload jobs
        jobs: 4
        # Immediate checkpoint to reduce backup duration
        immediateCheckpoint: true
      wal:
        compression: gzip
        encryption: AES256
        maxParallel: 8
    # Retain the last 7 base backups
    retentionPolicy: "7d"

  # Bootstrap from scratch for the initial cluster
  bootstrap:
    initdb:
      database: appdb
      owner: appuser
      secret:
        name: postgres-app-user-secret
      postInitApplicationSQL:
        - CREATE EXTENSION IF NOT EXISTS pg_stat_statements
        - CREATE EXTENSION IF NOT EXISTS pgcrypto

  monitoring:
    enablePodMonitor: true
```

Apply the manifest:

```bash
kubectl apply -f postgres-prod-cluster.yaml
kubectl -n postgres get cluster postgres-prod --watch
```

## Scheduling Automated Base Backups

CloudNativePG uses the `ScheduledBackup` resource to trigger periodic base backups. The schedule follows standard cron syntax.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: postgres-prod-daily
  namespace: postgres
spec:
  schedule: "0 2 * * *"   # 02:00 UTC every day
  backupOwnerReference: self
  cluster:
    name: postgres-prod
  method: barmanObjectStore
  # Immediately take a backup when the ScheduledBackup is created
  immediate: true
  # Suspend the schedule without deleting this resource
  suspend: false
```

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: postgres-prod-weekly-full
  namespace: postgres
spec:
  # Sunday at 01:00 UTC — weekly full backup
  schedule: "0 1 * * 0"
  backupOwnerReference: self
  cluster:
    name: postgres-prod
  method: barmanObjectStore
  immediate: false
  suspend: false
```

Check scheduled backup status:

```bash
kubectl -n postgres get scheduledbackup
# NAME                       SCHEDULE    SUSPEND   ACTIVE   LASTSCHEDULETIME
# postgres-prod-daily        0 2 * * *   false     false    2030-11-11T02:00:00Z
# postgres-prod-weekly-full  0 1 * * 0   false     false    2030-11-10T01:00:00Z

kubectl -n postgres get backup
# NAME                              AGE   CLUSTER        METHOD              PHASE       ERROR
# postgres-prod-daily-20301111      10m   postgres-prod  barmanObjectStore   completed
# postgres-prod-daily-20301110      1d    postgres-prod  barmanObjectStore   completed
```

## Triggering an On-Demand Backup

For pre-maintenance snapshots or ad-hoc backups, create a `Backup` object directly:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: postgres-prod-premaint-20301111
  namespace: postgres
spec:
  cluster:
    name: postgres-prod
  method: barmanObjectStore
```

Monitor progress:

```bash
kubectl -n postgres describe backup postgres-prod-premaint-20301111
# Events:
#   Normal  Starting  3s  cloudnative-pg  Starting backup
#   Normal  Running   2s  cloudnative-pg  Backup in progress
#   Normal  Completed 45s cloudnative-pg  Backup completed, size: 4.2GB
```

## Point-in-Time Recovery Procedures

### Scenario: Recovering to a Specific Timestamp

The most common PITR use case is recovering after an accidental `DROP TABLE` or corrupt data load. Identify the latest timestamp before the incident, then create a new `Cluster` bootstrapped from the backup.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod-recovery
  namespace: postgres
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  storage:
    size: 100Gi
    storageClass: gp3-encrypted

  walStorage:
    size: 20Gi
    storageClass: gp3-encrypted

  bootstrap:
    recovery:
      # Reference the source cluster's backup store
      source: postgres-prod-backup-source
      recoveryTarget:
        # Recover to 09:14:00 UTC on 2030-11-11 — just before the incident
        targetTime: "2030-11-11T09:14:00Z"
        # Alternatively recover to a specific LSN:
        # targetLSN: "0/5000000"
        # Or to a named restore point created with pg_create_restore_point():
        # targetName: "before-data-migration"
        # targetImmediate: true  # stop at the end of the base backup
        exclusive: false

  externalClusters:
    - name: postgres-prod-backup-source
      barmanObjectStore:
        destinationPath: "s3://my-postgres-backups/postgres-prod/"
        serverName: "postgres-prod"
        s3Credentials:
          accessKeyId:
            name: backup-storage-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: backup-storage-credentials
            key: ACCESS_SECRET_KEY
        wal:
          maxParallel: 8
```

Apply and monitor the recovery:

```bash
kubectl apply -f postgres-prod-recovery.yaml
kubectl -n postgres get cluster postgres-prod-recovery --watch

# Check the recovery progress in pod logs
kubectl -n postgres logs postgres-prod-recovery-1 -c postgres | grep -E "(recovery|PITR|consistent)"
# LOG:  starting point-in-time recovery to 2030-11-11 09:14:00+00
# LOG:  restored log file "000000010000000000000001" from archive
# LOG:  redo starts at 0/1000028
# LOG:  consistent recovery state reached at 0/10000A0
# LOG:  recovery stopping before commit of transaction 489, time 2030-11-11 09:14:03.217441+00
# LOG:  pausing at the end of recovery
```

### Recovering to a Named Restore Point

Named restore points must be created before the incident:

```sql
-- Run this before any risky migration
SELECT pg_create_restore_point('before-schema-v2-migration');
```

Then reference it in the recovery spec:

```yaml
bootstrap:
  recovery:
    source: postgres-prod-backup-source
    recoveryTarget:
      targetName: "before-schema-v2-migration"
      exclusive: false
```

### Cross-Cluster Recovery (DR Site)

For cross-region or cross-cloud DR, create a replica cluster that streams WAL from the object store used by the primary cluster:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-dr-replica
  namespace: postgres-dr
spec:
  instances: 2
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  storage:
    size: 100Gi
    storageClass: gp3-encrypted

  walStorage:
    size: 20Gi
    storageClass: gp3-encrypted

  # Replica cluster continuously applies WAL from the primary's object store
  replica:
    enabled: true
    source: primary-cluster-store

  bootstrap:
    recovery:
      source: primary-cluster-store

  externalClusters:
    - name: primary-cluster-store
      barmanObjectStore:
        destinationPath: "s3://my-postgres-backups/postgres-prod/"
        serverName: "postgres-prod"
        s3Credentials:
          accessKeyId:
            name: backup-storage-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: backup-storage-credentials
            key: ACCESS_SECRET_KEY
        wal:
          maxParallel: 4
```

Promoting the DR cluster to primary:

```bash
# Patch the replica cluster to disable replica mode (triggers promotion)
kubectl -n postgres-dr patch cluster postgres-dr-replica \
  --type='merge' \
  -p '{"spec":{"replica":{"enabled":false}}}'

# Verify promotion
kubectl -n postgres-dr get cluster postgres-dr-replica
# STATUS: Cluster in healthy state — primary instance: postgres-dr-replica-1
```

## Backup Verification and Testing

Automated backup verification is critical. CloudNativePG does not natively run restore tests, so a CronJob-based verification pipeline is necessary.

### Verification CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-verify-postgres-prod
  namespace: postgres
spec:
  schedule: "0 4 * * 1"   # Every Monday at 04:00 UTC
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          serviceAccountName: backup-verifier
          containers:
            - name: verifier
              image: ghcr.io/cloudnative-pg/postgresql:16.3
              env:
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: backup-storage-credentials
                      key: ACCESS_KEY_ID
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: backup-storage-credentials
                      key: ACCESS_SECRET_KEY
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail

                  BACKUP_PATH="s3://my-postgres-backups/postgres-prod/"
                  BACKUP_ID=$(barman-cloud-backup-list \
                    --cloud-provider aws-s3 \
                    "${BACKUP_PATH}" postgres-prod \
                    | tail -1 | awk '{print $1}')

                  echo "Verifying backup: ${BACKUP_ID}"

                  # Create a temporary data directory
                  PGDATA=$(mktemp -d)
                  export PGDATA

                  # Restore the most recent base backup
                  barman-cloud-restore \
                    --cloud-provider aws-s3 \
                    "${BACKUP_PATH}" postgres-prod "${BACKUP_ID}" "${PGDATA}"

                  # Start PostgreSQL in single-user mode for a basic check
                  pg_ctl -D "${PGDATA}" -o "-p 5433" start

                  # Run a connectivity check
                  psql -p 5433 -d postgres -c "SELECT version();" > /dev/null

                  pg_ctl -D "${PGDATA}" stop

                  echo "Backup ${BACKUP_ID} verified successfully"
                  rm -rf "${PGDATA}"
```

### Listing Available Backups with barman-cloud-backup-list

```bash
# Run from a pod with barman-cloud tools installed
barman-cloud-backup-list \
  --cloud-provider aws-s3 \
  s3://my-postgres-backups/postgres-prod/ postgres-prod

# Output:
# Backup ID              End Time                    Size       WAL Start    WAL End
# 20301111T020000        2030-11-11T02:15:43+00:00   4.2 GB     0/40000028   0/4000A0F8
# 20301110T020000        2030-11-10T02:13:21+00:00   4.1 GB     0/30000028   0/3000A0F8
# 20301109T020000        2030-11-09T02:14:05+00:00   4.0 GB     0/20000028   0/2000A0F8
```

## Retention Policy Management

CloudNativePG applies retention policies during the next scheduled backup run. The `retentionPolicy` field supports two formats:

- `"Xd"` — keep backups from the last X days
- `"Xw"` — keep backups from the last X weeks

For teams needing fine-grained control, combine a short retention on the `Cluster` resource with a lifecycle policy on the S3 bucket:

```json
{
  "Rules": [
    {
      "ID": "postgres-wal-archive-lifecycle",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "postgres-prod/wals/"
      },
      "Expiration": {
        "Days": 30
      }
    },
    {
      "ID": "postgres-base-backup-lifecycle",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "postgres-prod/data/"
      },
      "Expiration": {
        "Days": 90
      }
    }
  ]
}
```

Apply to the bucket:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-postgres-backups \
  --lifecycle-configuration file://lifecycle.json
```

## Monitoring Backup Health with Prometheus

CloudNativePG exposes a `PodMonitor` resource when `monitoring.enablePodMonitor: true` is set. The following metrics are relevant for backup health:

| Metric | Type | Description |
|--------|------|-------------|
| `cnpg_collector_last_collection_error` | Gauge | 1 if the last metrics collection failed |
| `cnpg_pg_wal_archive_status` | Gauge | Number of WAL files pending archiving |
| `cnpg_collector_collection_duration_seconds` | Histogram | Metrics collection latency |
| `cnpg_pg_stat_bgwriter_buffers_checkpoint` | Counter | Buffers written during checkpoints |

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cloudnativepg-backup-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: cloudnativepg.backup
      interval: 60s
      rules:
        - alert: CloudNativePGWALArchivingFailing
          expr: |
            cnpg_pg_wal_archive_status{type="fail"} > 0
          for: 5m
          labels:
            severity: critical
            team: database
          annotations:
            summary: "WAL archiving failing on {{ $labels.cluster }}"
            description: |
              Cluster {{ $labels.cluster }} has {{ $value }} WAL segments that failed
              to archive. Point-in-time recovery capability may be compromised.
              Check barman-cloud-wal-archive logs on pod {{ $labels.pod }}.

        - alert: CloudNativePGWALArchivingPending
          expr: |
            cnpg_pg_wal_archive_status{type="ready"} > 20
          for: 15m
          labels:
            severity: warning
            team: database
          annotations:
            summary: "WAL archive backlog on {{ $labels.cluster }}"
            description: |
              Cluster {{ $labels.cluster }} has {{ $value }} WAL segments waiting
              to be archived. This may indicate object storage connectivity issues.

        - alert: CloudNativePGBackupMissing
          expr: |
            (time() - cnpg_collector_last_backup_duration_seconds) > 90000
          for: 0m
          labels:
            severity: warning
            team: database
          annotations:
            summary: "No recent backup for {{ $labels.cluster }}"
            description: |
              Cluster {{ $labels.cluster }} has not completed a successful base
              backup in the last 25 hours. Verify ScheduledBackup resource and
              object storage access.

        - alert: CloudNativePGCollectionErrors
          expr: |
            cnpg_collector_last_collection_error > 0
          for: 10m
          labels:
            severity: warning
            team: database
          annotations:
            summary: "Metrics collection failing on {{ $labels.cluster }}"
            description: |
              CloudNativePG metrics exporter is failing on cluster {{ $labels.cluster }}.
              Backup health monitoring may be unreliable.
```

### Grafana Dashboard Queries

Key PromQL queries for a backup health dashboard:

```promql
# WAL files pending archiving
cnpg_pg_wal_archive_status{cluster="postgres-prod", type="ready"}

# WAL archiving failures
cnpg_pg_wal_archive_status{cluster="postgres-prod", type="fail"}

# Time since last successful backup (hours)
(time() - cnpg_collector_last_backup_duration_seconds) / 3600

# Replication lag on standby instances (bytes behind primary)
pg_replication_slots_confirmed_flush_lsn - pg_current_wal_lsn
```

## Backup Encryption at Rest

CloudNativePG supports server-side encryption through Barman Cloud. Use AWS KMS for envelope encryption:

```yaml
backup:
  barmanObjectStore:
    destinationPath: "s3://my-postgres-backups/postgres-prod/"
    s3Credentials:
      accessKeyId:
        name: backup-storage-credentials
        key: ACCESS_KEY_ID
      secretAccessKey:
        name: backup-storage-credentials
        key: ACCESS_SECRET_KEY
    data:
      encryption: aws:kms
      # ARN of the CMK to use for encryption
      # Pass via an environment variable or operator annotation
    wal:
      encryption: aws:kms
```

For AES256 with S3-managed keys (SSE-S3), use `encryption: AES256` as shown in the main cluster manifest.

## Volume Snapshot Backups

CloudNativePG 1.22+ supports Kubernetes VolumeSnapshot-based backups as an alternative to Barman Cloud base backups. This is faster for large databases because it avoids streaming data through the pod.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod
  namespace: postgres
spec:
  # ... (other fields as before)
  backup:
    volumeSnapshot:
      className: csi-aws-ebs-snapshotter
      snapshotOwnerReference: cluster
      online: true
      onlineConfiguration:
        waitForArchive: true
    barmanObjectStore:
      # WAL archiving is still required for PITR even with volume snapshots
      destinationPath: "s3://my-postgres-backups/postgres-prod/"
      s3Credentials:
        accessKeyId:
          name: backup-storage-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-storage-credentials
          key: ACCESS_SECRET_KEY
      wal:
        compression: gzip
```

Create a VolumeSnapshot-based backup:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: postgres-prod-snapshot-20301111
  namespace: postgres
spec:
  cluster:
    name: postgres-prod
  method: volumeSnapshot
```

## Operational Runbooks

### Checking WAL Archive Status

```bash
# Connect to the primary pod
kubectl -n postgres exec -it postgres-prod-1 -- psql -U postgres

-- Check archive status
SELECT archived_count, failed_count, last_archived_wal,
       last_archived_time, last_failed_wal, last_failed_time
FROM pg_stat_archiver;

-- Check WAL files waiting to be archived
SELECT count(*) FROM pg_ls_waldir()
WHERE name ~ '^[0-9A-F]{24}$'
AND modification < now() - interval '5 minutes';
```

### Forcing WAL Segment Archival

```bash
# Switch WAL segment to trigger archival of the current segment
kubectl -n postgres exec -it postgres-prod-1 -- \
  psql -U postgres -c "SELECT pg_switch_wal();"

# Verify archival
kubectl -n postgres exec -it postgres-prod-1 -- \
  psql -U postgres -c "SELECT last_archived_wal, last_archived_time FROM pg_stat_archiver;"
```

### Verifying Recovery Window Coverage

```bash
barman-cloud-backup-list \
  --cloud-provider aws-s3 \
  --format json \
  s3://my-postgres-backups/postgres-prod/ postgres-prod | \
  python3 -c "
import json, sys
from datetime import datetime, timezone

backups = json.load(sys.stdin)
for b in backups.get('backups_list', []):
    begin = b.get('begin_time', 'unknown')
    end = b.get('end_time', 'unknown')
    size = b.get('size', 0) / (1024**3)
    print(f\"Backup: {b['backup_id']:25s}  Begin: {begin}  End: {end}  Size: {size:.2f}GB\")
"
```

## Troubleshooting Common Issues

### WAL Archiving Stuck

**Symptoms**: `cnpg_pg_wal_archive_status{type="ready"}` is growing; `last_archived_time` is stale.

**Diagnosis**:
```bash
# Check the archiver process logs
kubectl -n postgres logs postgres-prod-1 -c postgres | grep -i "archive"

# Check object storage connectivity from the pod
kubectl -n postgres exec -it postgres-prod-1 -- \
  barman-cloud-wal-archive --test \
  s3://my-postgres-backups/postgres-prod/ postgres-prod 000000010000000000000001
```

**Resolution**: Verify IAM permissions include `s3:PutObject` and `s3:GetObject` on the target prefix. Confirm the Secret containing credentials is mounted correctly.

### Recovery Cluster Stuck in Recovering State

**Symptoms**: Recovery cluster stays in `Recovering` phase for more than an hour.

**Diagnosis**:
```bash
kubectl -n postgres describe cluster postgres-prod-recovery
kubectl -n postgres logs postgres-prod-recovery-1 -c postgres | tail -50
```

**Common causes**:
1. WAL file missing from archive: check that the WAL range between the base backup and the target time is complete.
2. Wrong `serverName` in `externalClusters`: must match the `serverName` used when the backup was taken.
3. Target time is before the oldest available base backup: adjust `targetTime` or restore a different backup.

### Backup Job Failing with Access Denied

```bash
kubectl -n postgres describe backup postgres-prod-daily-20301111
# Events:
#   Warning  Failed  10m  cloudnative-pg  Backup failed: AccessDenied: ...

# Verify the credentials Secret is present and has correct keys
kubectl -n postgres get secret backup-storage-credentials -o yaml
kubectl -n postgres exec -it postgres-prod-1 -- env | grep AWS
```

## Summary

CloudNativePG with Barman Cloud delivers enterprise-grade PostgreSQL backup capabilities on Kubernetes with minimal operational overhead. The key operational practices are: configure WAL archiving before the cluster receives any writes, schedule daily base backups and test them weekly with automated restore jobs, set up Prometheus alerts for WAL archive failures and missing recent backups, and maintain a documented PITR runbook that the on-call team can execute in under 30 minutes.

The combination of continuous WAL archiving and periodic base backups provides recovery point objectives measured in seconds, while volume snapshot integration reduces recovery time objectives for large databases by enabling faster restore operations.
