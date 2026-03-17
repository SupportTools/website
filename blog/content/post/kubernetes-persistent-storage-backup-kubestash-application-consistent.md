---
title: "Kubernetes Persistent Storage Backup with Stash/Kubestash: Application-Consistent Backups"
date: 2030-05-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KubeStash", "Stash", "Backup", "Storage", "Databases", "Disaster Recovery"]
categories: ["Kubernetes", "Storage", "Disaster Recovery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to KubeStash (Stash v2) for application-consistent Kubernetes backups including pre/post backup hooks for databases, incremental backup strategies, backup verification, cross-namespace restore procedures, and backup encryption using Restic."
more_link: "yes"
url: "/kubernetes-persistent-storage-backup-kubestash-application-consistent/"
---

The difference between a backup and an application-consistent backup is the difference between a file-system snapshot and a recoverable database. A raw volume snapshot taken while PostgreSQL is mid-transaction captures a consistent storage state at the block level, but the database WAL may be inconsistent. Recovering from such a snapshot requires PostgreSQL to perform crash recovery — possible, but not guaranteed to succeed if the buffer pool was partially flushed.

KubeStash (the Stash v2 project from AppsCode) solves this by integrating backup hooks directly into the Kubernetes operator lifecycle: it can pause MySQL replication, trigger PostgreSQL checkpoints, flush Redis AOF files, and then take the snapshot — all without requiring custom scripts scattered across ConfigMaps.

<!--more-->

# Kubernetes Persistent Storage Backup with Stash/Kubestash: Application-Consistent Backups

## Architecture Overview

KubeStash introduces several new CRD abstractions over the original Stash project:

| CRD | Purpose |
|---|---|
| `BackupStorage` | Defines where backups are stored (S3, GCS, Azure Blob) |
| `BackupConfiguration` | Defines what to back up, with schedule and retention |
| `BackupSession` | Represents one backup execution |
| `RestoreSession` | Represents one restore execution |
| `RetentionPolicy` | Named retention rules referenced by BackupConfigurations |
| `HookTemplate` | Reusable pre/post hook definitions |
| `BackupBlueprint` | Template for auto-creating BackupConfigurations for labeled resources |

## Installation

### Installing KubeStash

```bash
# Add the AppsCode Helm repository
helm repo add appscode https://charts.appscode.com/stable/
helm repo update

# Install KubeStash operator
helm install kubestash appscode/kubestash \
  --version v2024.9.30 \
  --namespace kubestash \
  --create-namespace \
  --set-file global.license=/path/to/kubestash-license.txt \
  --wait

# Verify operator is running
kubectl get pods -n kubestash
# kubestash-kubestash-operator-xxx  2/2  Running
```

### BackupStorage Configuration

```yaml
# backup-storage.yaml
# AWS S3 Backend
apiVersion: storage.kubestash.com/v1alpha1
kind: BackupStorage
metadata:
  name: s3-backup-storage
  namespace: kubestash
spec:
  storage:
    provider: s3
    s3:
      endpoint: s3.amazonaws.com
      bucket: my-cluster-kubestash-backups
      region: us-east-1
      prefix: "production"
      secretName: s3-backup-credentials
  usagePolicy:
    allowedNamespaces:
      from: All
  default: true
  deletionPolicy: WipeOut  # Delete backup data when BackupStorage is deleted
---
# GCS Backend
apiVersion: storage.kubestash.com/v1alpha1
kind: BackupStorage
metadata:
  name: gcs-backup-storage
  namespace: kubestash
spec:
  storage:
    provider: gcs
    gcs:
      bucket: my-cluster-kubestash-backups-gcs
      prefix: "production"
      secretName: gcs-backup-credentials
  usagePolicy:
    allowedNamespaces:
      from: All
  default: false
---
# Credentials for S3
apiVersion: v1
kind: Secret
metadata:
  name: s3-backup-credentials
  namespace: kubestash
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "<aws-access-key-id>"
  AWS_SECRET_ACCESS_KEY: "<aws-secret-access-key>"
```

```bash
kubectl apply -f backup-storage.yaml

# Verify storage is accessible
kubectl get backupstorage -n kubestash
```

## Retention Policies

```yaml
# retention-policies.yaml
apiVersion: storage.kubestash.com/v1alpha1
kind: RetentionPolicy
metadata:
  name: databases-retention
  namespace: kubestash
spec:
  maxRetentionPeriod: 30d
  successfulSnapshots:
    last: 30        # Keep last 30 successful snapshots
  failedSnapshots:
    last: 5         # Keep last 5 failed snapshots (for diagnosis)
---
apiVersion: storage.kubestash.com/v1alpha1
kind: RetentionPolicy
metadata:
  name: compliance-retention
  namespace: kubestash
spec:
  maxRetentionPeriod: 2555d  # 7 years
  successfulSnapshots:
    last: 2555
  failedSnapshots:
    last: 10
---
apiVersion: storage.kubestash.com/v1alpha1
kind: RetentionPolicy
metadata:
  name: short-term-retention
  namespace: kubestash
spec:
  maxRetentionPeriod: 7d
  successfulSnapshots:
    last: 7
  failedSnapshots:
    last: 3
```

## PostgreSQL Application-Consistent Backup

### BackupConfiguration with Database Hooks

```yaml
# postgres-backup.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: BackupConfiguration
metadata:
  name: postgres-backup
  namespace: databases
spec:
  target:
    apiGroup: apps
    kind: StatefulSet
    name: postgres
    namespace: databases

  backends:
  - name: s3-backend
    storageRef:
      namespace: kubestash
      name: s3-backup-storage
    retentionPolicy:
      name: databases-retention
      namespace: kubestash

  sessions:
  - name: frequent-backup
    scheduler:
      schedule: "*/30 * * * *"  # Every 30 minutes
      jobTemplate:
        spec:
          backoffLimit: 2
    repositories:
    - name: postgres-frequent
      backend: s3-backend
      directory: /databases/postgres/frequent
      encryptionSecret:
        name: encryption-secret
        namespace: kubestash
    addon:
      name: postgres-addon
      tasks:
      - name: logical-backup
    hooks:
      preBackup:
      - name: checkpoint
        hookTemplate:
          name: postgres-checkpoint
          namespace: databases

  - name: daily-backup
    scheduler:
      schedule: "0 2 * * *"
      jobTemplate:
        spec:
          backoffLimit: 1
    repositories:
    - name: postgres-daily
      backend: s3-backend
      directory: /databases/postgres/daily
      encryptionSecret:
        name: encryption-secret
        namespace: kubestash
    addon:
      name: postgres-addon
      tasks:
      - name: logical-backup
      - name: manifest-backup
```

### PostgreSQL HookTemplate

```yaml
# postgres-hooks.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: HookTemplate
metadata:
  name: postgres-checkpoint
  namespace: databases
spec:
  usagePolicy:
    allowedNamespaces:
      from: Same
  action:
    exec:
      command:
      - /bin/bash
      - -c
      - |
        set -euo pipefail
        echo "Executing PostgreSQL checkpoint..."

        # Force a WAL checkpoint to ensure all dirty pages are flushed
        psql -U postgres -c "CHECKPOINT;" || {
            echo "CHECKPOINT failed - aborting backup"
            exit 1
        }

        # Switch WAL segment to ensure last WAL file is archived
        psql -U postgres -c "SELECT pg_switch_wal();"

        echo "PostgreSQL checkpoint complete"
    containerRef:
      name: postgres
    timeout: 60s
    onError: Fail
---
# Pre-backup hook for pg_basebackup method
apiVersion: core.kubestash.com/v1alpha1
kind: HookTemplate
metadata:
  name: postgres-start-backup
  namespace: databases
spec:
  action:
    exec:
      command:
      - /bin/bash
      - -c
      - |
        psql -U postgres -c "SELECT pg_backup_start('kubestash-backup', fast := true);"
    containerRef:
      name: postgres
    timeout: 30s
    onError: Fail
---
apiVersion: core.kubestash.com/v1alpha1
kind: HookTemplate
metadata:
  name: postgres-stop-backup
  namespace: databases
spec:
  action:
    exec:
      command:
      - /bin/bash
      - -c
      - |
        psql -U postgres -c "SELECT * FROM pg_backup_stop();"
    containerRef:
      name: postgres
    timeout: 30s
    onError: Continue  # Even if this fails, don't prevent backup from completing
```

## MySQL Application-Consistent Backup

```yaml
# mysql-backup.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: BackupConfiguration
metadata:
  name: mysql-backup
  namespace: databases
spec:
  target:
    apiGroup: apps
    kind: StatefulSet
    name: mysql
    namespace: databases

  backends:
  - name: s3-backend
    storageRef:
      namespace: kubestash
      name: s3-backup-storage
    retentionPolicy:
      name: databases-retention
      namespace: kubestash

  sessions:
  - name: hourly-backup
    scheduler:
      schedule: "0 * * * *"
    repositories:
    - name: mysql-hourly
      backend: s3-backend
      directory: /databases/mysql/hourly
      encryptionSecret:
        name: encryption-secret
        namespace: kubestash
    hooks:
      preBackup:
      - name: flush-tables
        hookTemplate:
          name: mysql-flush
          namespace: databases
      postBackup:
      - name: unlock-tables
        hookTemplate:
          name: mysql-unlock
          namespace: databases
---
apiVersion: core.kubestash.com/v1alpha1
kind: HookTemplate
metadata:
  name: mysql-flush
  namespace: databases
spec:
  action:
    exec:
      command:
      - /bin/bash
      - -c
      - |
        mysql -u root -p"${MYSQL_ROOT_PASSWORD}" \
          -e "FLUSH TABLES WITH READ LOCK; FLUSH LOGS;"
        echo "Tables flushed and locked"
    containerRef:
      name: mysql
    timeout: 30s
    onError: Fail
---
apiVersion: core.kubestash.com/v1alpha1
kind: HookTemplate
metadata:
  name: mysql-unlock
  namespace: databases
spec:
  action:
    exec:
      command:
      - /bin/bash
      - -c
      - |
        mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "UNLOCK TABLES;"
        echo "Tables unlocked"
    containerRef:
      name: mysql
    timeout: 30s
    onError: Continue
```

## Redis Application-Consistent Backup

```yaml
# redis-hooks.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: HookTemplate
metadata:
  name: redis-bgsave
  namespace: databases
spec:
  action:
    exec:
      command:
      - /bin/bash
      - -c
      - |
        set -euo pipefail
        echo "Triggering Redis BGSAVE..."

        # Trigger background save
        redis-cli -a "${REDIS_PASSWORD}" BGSAVE

        # Wait for save to complete
        for i in $(seq 1 60); do
            STATUS=$(redis-cli -a "${REDIS_PASSWORD}" LASTSAVE)
            BGSAVE_STATUS=$(redis-cli -a "${REDIS_PASSWORD}" INFO persistence | \
                grep "rdb_bgsave_in_progress" | cut -d: -f2 | tr -d '\r')

            if [ "$BGSAVE_STATUS" = "0" ]; then
                echo "Redis BGSAVE completed successfully"
                exit 0
            fi
            echo "Waiting for BGSAVE... attempt $i"
            sleep 2
        done

        echo "ERROR: Redis BGSAVE did not complete within 120 seconds"
        exit 1
    containerRef:
      name: redis
    timeout: 150s
    onError: Fail
```

## Incremental Backups with Restic

KubeStash uses Restic under the hood for file-level backups, which natively supports incremental deduplication:

```yaml
# incremental-backup-config.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: BackupConfiguration
metadata:
  name: app-data-incremental
  namespace: production
spec:
  target:
    apiGroup: v1
    kind: PersistentVolumeClaim
    name: app-data
    namespace: production

  backends:
  - name: s3-backend
    storageRef:
      namespace: kubestash
      name: s3-backup-storage
    retentionPolicy:
      name: short-term-retention
      namespace: kubestash

  sessions:
  - name: incremental-hourly
    scheduler:
      schedule: "15 * * * *"  # Every hour at :15
    repositories:
    - name: app-data-repo
      backend: s3-backend
      directory: /production/app-data
      encryptionSecret:
        name: encryption-secret
        namespace: kubestash
    addon:
      name: workload-addon
      tasks:
      - name: volume-snapshot
        params:
          volumeSnapshotClassName: ebs-vsc
    # Restic automatically handles deduplication across backups
    # First backup is full; subsequent are incremental
```

## Backup Encryption

```yaml
# encryption-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: encryption-secret
  namespace: kubestash
type: Opaque
stringData:
  RESTIC_PASSWORD: "your-strong-encryption-password-minimum-16-chars"
  # In production, use a secret management system and inject at runtime
  # Never store real passwords in YAML files committed to git
```

For production, use External Secrets Operator to populate the encryption secret from HashiCorp Vault:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: kubestash-encryption-secret
  namespace: kubestash
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-secret-store
    kind: SecretStore
  target:
    name: encryption-secret
    creationPolicy: Owner
  data:
  - secretKey: RESTIC_PASSWORD
    remoteRef:
      key: secret/kubestash/encryption
      property: password
```

## Backup Verification

KubeStash supports backup verification by restoring to an ephemeral volume and running validation:

```yaml
# backup-verification.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: BackupConfiguration
metadata:
  name: postgres-verified-backup
  namespace: databases
spec:
  target:
    apiGroup: apps
    kind: StatefulSet
    name: postgres
    namespace: databases

  backends:
  - name: s3-backend
    storageRef:
      namespace: kubestash
      name: s3-backup-storage
    retentionPolicy:
      name: databases-retention
      namespace: kubestash

  sessions:
  - name: daily-verified
    scheduler:
      schedule: "0 3 * * *"
    repositories:
    - name: postgres-daily
      backend: s3-backend
      directory: /databases/postgres/daily-verified
      encryptionSecret:
        name: encryption-secret
        namespace: kubestash
    addon:
      name: postgres-addon
      tasks:
      - name: logical-backup
    verificationPolicies:
    - name: verify-restore
      rules:
      - name: check-table-count
        type: restoredData
        restoredDataVerification:
          query: "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
          expectedResultType: countComparison
          expectedCountOperator: GreaterThan
          expectedCount: 0
```

### Manual Backup Verification Script

```bash
#!/bin/bash
# verify-backup.sh — verify a KubeStash backup by test restore

BACKUP_REPO=${1:?Usage: $0 <backup-repo-name> <backup-snapshot> <target-namespace>}
SNAPSHOT=${2:?}
TARGET_NS=${3:?}

# Create test namespace
kubectl create namespace "$TARGET_NS" --dry-run=client -o yaml | kubectl apply -f -

# Trigger restore session
cat << EOF | kubectl apply -f -
apiVersion: core.kubestash.com/v1alpha1
kind: RestoreSession
metadata:
  name: verify-restore-$(date +%s)
  namespace: $TARGET_NS
spec:
  target:
    apiGroup: apps
    kind: StatefulSet
    name: postgres-verify
    namespace: $TARGET_NS
  dataSource:
    namespace: databases
    repository: $BACKUP_REPO
    snapshot: $SNAPSHOT
    encryptionSecret:
      name: encryption-secret
      namespace: kubestash
  addon:
    name: postgres-addon
    tasks:
    - name: logical-restore
EOF

# Wait for restore to complete
kubectl wait --for=condition=Succeeded \
  restoresession -l "app.kubernetes.io/managed-by=kubestash" \
  -n "$TARGET_NS" \
  --timeout=600s

# Verify PostgreSQL is accessible
kubectl exec -n "$TARGET_NS" postgres-verify-0 -- \
  psql -U postgres -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

# Cleanup
kubectl delete namespace "$TARGET_NS"
echo "Verification complete"
```

## Cross-Namespace Restore

```yaml
# cross-namespace-restore.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: RestoreSession
metadata:
  name: cross-ns-restore
  namespace: staging  # Target namespace (different from source)
spec:
  target:
    apiGroup: apps
    kind: StatefulSet
    name: postgres-staging
    namespace: staging

  dataSource:
    namespace: databases  # Source namespace where backup was taken
    repository: postgres-daily
    snapshot: latest       # Or specify a specific snapshot ID
    encryptionSecret:
      name: encryption-secret
      namespace: kubestash

  addon:
    name: postgres-addon
    tasks:
    - name: logical-restore

  # Transform resource names and labels during restore
  manifest:
    restoreNamespace: staging
    overwriteNamespace: true
```

## BackupBlueprint for Auto-Backup

BackupBlueprints create BackupConfigurations automatically for any namespace or resource that matches a selector:

```yaml
# backup-blueprint.yaml
apiVersion: core.kubestash.com/v1alpha1
kind: BackupBlueprint
metadata:
  name: database-auto-backup
  namespace: kubestash
spec:
  usagePolicy:
    allowedNamespaces:
      from: Selector
      selector:
        matchLabels:
          kubestash.com/auto-backup: "true"

  backupConfigurationTemplate:
    backends:
    - name: s3-backend
      storageRef:
        namespace: kubestash
        name: s3-backup-storage
      retentionPolicy:
        name: databases-retention
        namespace: kubestash

    sessions:
    - name: auto-backup-session
      scheduler:
        schedule: "0 * * * *"
      repositories:
      - name: ${TARGET_RESOURCE_NAME}-repo
        backend: s3-backend
        directory: /auto-backup/${TARGET_NAMESPACE}/${TARGET_RESOURCE_NAME}
        encryptionSecret:
          name: encryption-secret
          namespace: kubestash
      addon:
        name: workload-addon
        tasks:
        - name: volume-snapshot
```

```bash
# Enable auto-backup for a namespace
kubectl label namespace production kubestash.com/auto-backup="true"

# Enable auto-backup for a specific StatefulSet
kubectl annotate statefulset postgres -n databases \
  kubestash.com/backup-blueprint="database-auto-backup"
```

## Monitoring Backup Health

```yaml
# prometheusrule-kubestash.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubestash-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubestash.rules
    rules:
    - alert: KubeStashBackupFailed
      expr: |
        kubestash_backup_session_failed_total > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "KubeStash backup session failed"
        description: "BackupConfiguration {{ $labels.backupconfiguration }} has failed backups"

    - alert: KubeStashBackupMissed
      expr: |
        time() - kubestash_backup_session_last_success_timestamp > 7200
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "KubeStash backup not successful for 2+ hours"

    - alert: KubeStashEncryptionSecretMissing
      expr: |
        kubestash_backup_configuration_missing_encryption_secret > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "KubeStash encryption secret missing"
```

```bash
# Check backup session status
kubectl get backupsession -A

# Describe a specific backup session
kubectl describe backupsession <session-name> -n databases

# Check backup repository snapshots
kubectl get snapshot -A

# List backup storage usage
kubectl get backupstorage -n kubestash -o wide

# Get backup configuration status
kubectl get backupconfiguration -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,LAST:.status.lastBackupTime'
```

## Key Takeaways

- Application-consistent backups require coordinating with the running application — a filesystem snapshot is only as good as the application's ability to recover from it, and for databases this means explicit flush/checkpoint operations before the snapshot is taken.
- KubeStash's HookTemplate CRD externalizes pre/post backup logic from your application containers, enabling reuse across multiple BackupConfiguration objects and consistent behavior across environments.
- Restic's deduplication engine stores only changed chunks between backup runs — with 30-minute backup intervals, typical incremental sizes for a 100 GB PostgreSQL database are 50-200 MB after the initial full backup.
- Always store the Restic/KubeStash encryption password in a secret management system (HashiCorp Vault, AWS Secrets Manager) and inject it via External Secrets Operator — losing the encryption password is equivalent to losing the backup.
- BackupBlueprints enable GitOps-driven backup adoption: label a namespace and every new StatefulSet automatically gets a backup configuration, preventing the "we thought it was being backed up" failure mode.
- Run restore verification tests monthly in an isolated namespace — the only backup that matters is one from which you can successfully restore; untested backups should be treated as non-backups.
- Cross-namespace restore with `overwriteNamespace: true` enables promoting a staging environment from a production backup — a powerful pattern for reproducing production bugs in non-production infrastructure.
