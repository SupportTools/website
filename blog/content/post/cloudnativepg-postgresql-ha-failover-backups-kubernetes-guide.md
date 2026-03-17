---
title: "Kubernetes CloudNativePG Operator: PostgreSQL High Availability, Automated Failover, and Backups"
date: 2031-08-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PostgreSQL", "CloudNativePG", "High Availability", "Backups", "Operators", "Database"]
categories: ["Kubernetes", "Database"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying PostgreSQL on Kubernetes with CloudNativePG: cluster architecture, automated failover, WAL streaming, continuous archiving to S3, point-in-time recovery, and production monitoring."
more_link: "yes"
url: "/cloudnativepg-postgresql-ha-failover-backups-kubernetes-guide/"
---

CloudNativePG is the most mature PostgreSQL operator for Kubernetes and the only one that has achieved CNCF sandbox status. Unlike operators that wrap an external HA tool (Patroni, repmgr) inside a container, CloudNativePG implements PostgreSQL HA logic natively in Go, using the operator pattern to manage the full lifecycle: primary election, replication slot management, WAL archiving, automated failover, switchover, and point-in-time recovery. This guide covers a production CloudNativePG deployment from initial installation through backup recovery testing.

<!--more-->

# Kubernetes CloudNativePG Operator: PostgreSQL High Availability, Automated Failover, and Backups

## Why CloudNativePG

Key differentiators from other PostgreSQL Kubernetes operators:

- **No sidecar HA daemon**: cluster management runs in the operator controller, not in a sidecar in each PostgreSQL pod
- **Native streaming replication**: uses PostgreSQL's built-in streaming replication without an additional coordinator
- **Replication slots for WAL retention**: ensures WAL files are not recycled before replicas consume them
- **Declarative cluster management**: all configuration via the `Cluster` CRD; no operator-specific SQL commands required
- **Built-in backup and PITR**: WAL archiving and base backups to S3-compatible storage, including Azure Blob and GCS
- **Native Prometheus metrics**: exposes a rich set of PostgreSQL metrics without a separate exporter

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  CloudNativePG Cluster "postgres-prod"                       │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                  │
│  │  postgres-prod-1│    │  postgres-prod-2│                  │
│  │  (Primary)      │───▶│  (Standby)      │                  │
│  │                 │    │                 │                  │
│  │  Streaming Repl │    │  Streaming Repl │                  │
│  └────────┬────────┘    └────────┬────────┘                  │
│           │                     │                            │
│           ▼                     ▼                            │
│  ┌─────────────────────────────────────┐                     │
│  │  WAL Archiving to S3                │                     │
│  │  (barman-cloud-wal-archive)         │                     │
│  └─────────────────────────────────────┘                     │
│                                                              │
│  Services:                                                   │
│  postgres-prod-rw  → primary (read/write)                    │
│  postgres-prod-ro  → any standby (read-only)                 │
│  postgres-prod-r   → any instance (read)                     │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
# Install the CloudNativePG operator
kubectl apply -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.22/releases/cnpg-1.22.0.yaml

# Wait for operator readiness
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=cloudnative-pg \
  -n cnpg-system \
  --timeout=120s

# Verify installation
kubectl get pods -n cnpg-system
# NAME                                  READY   STATUS    RESTARTS   AGE
# cnpg-controller-manager-xxxx-yyyy     1/1     Running   0          45s

# Install the kubectl plugin for convenient cluster management
curl -sSfL \
  https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.22.0/kubectl-cnpg_1.22.0_linux_x86_64.tar.gz | \
  tar -xzf - -C /usr/local/bin kubectl-cnpg
```

## S3 Backup Configuration

Before creating a cluster, configure the backup credentials. CloudNativePG uses barman-cloud tools for WAL archiving and base backups.

```yaml
# backup-credentials.yaml
apiVersion: v1
kind: Secret
metadata:
  name: s3-backup-credentials
  namespace: production
type: Opaque
stringData:
  ACCESS_KEY_ID: "<aws-access-key-id>"
  ACCESS_SECRET_KEY: "<aws-secret-access-key>"
```

For production, use IAM Roles for Service Accounts (IRSA) instead of static credentials:

```yaml
# Service account with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: postgres-backup
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/postgres-backup-role
```

The IAM role needs this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::my-postgres-backups",
        "arn:aws:s3:::my-postgres-backups/*"
      ]
    }
  ]
}
```

## Creating a Production Cluster

```yaml
# cluster-production.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod
  namespace: production
spec:
  # PostgreSQL version
  imageName: ghcr.io/cloudnative-pg/postgresql:16.2

  # Number of instances (1 primary + N-1 standbys)
  instances: 3

  # PostgreSQL configuration
  postgresql:
    parameters:
      # Memory settings (adjust for your node size)
      shared_buffers: "2GB"
      effective_cache_size: "6GB"
      maintenance_work_mem: "512MB"
      work_mem: "32MB"

      # WAL settings
      wal_level: "logical"          # Enable logical replication
      max_wal_size: "4GB"
      min_wal_size: "1GB"
      wal_compression: "zstd"       # Reduce WAL size

      # Replication
      max_replication_slots: "20"
      max_wal_senders: "20"

      # Query performance
      random_page_cost: "1.1"       # SSD-optimized
      effective_io_concurrency: "200"

      # Logging
      log_checkpoints: "on"
      log_connections: "on"
      log_disconnections: "on"
      log_lock_waits: "on"
      log_temp_files: "0"
      log_autovacuum_min_duration: "0"
      log_error_verbosity: "default"

      # Autovacuum tuning
      autovacuum_max_workers: "5"
      autovacuum_naptime: "20s"
      autovacuum_vacuum_cost_delay: "2ms"

    # Shared preload libraries
    shared_preload_libraries:
      - pg_stat_statements
      - auto_explain

    # HBA configuration (overrides default)
    pg_hba:
      - host all all 10.0.0.0/8 scram-sha-256
      - hostssl replication streaming_replica 10.0.0.0/8 scram-sha-256

  # Bootstrap from a new cluster or a backup
  bootstrap:
    initdb:
      database: app
      owner: app
      secret:
        name: postgres-app-credentials
      # PostgreSQL data checksums (highly recommended)
      dataChecksums: true
      # WAL segment size
      walSegmentSize: 64

  # Enable superuser access for administration
  enableSuperuserAccess: true
  superuserSecret:
    name: postgres-superuser-credentials

  # Primary update strategy
  primaryUpdateStrategy: unsupervised
  primaryUpdateMethod: switchover  # switchover is safer than restart

  # Storage configuration
  storage:
    size: 100Gi
    storageClass: gp3-encrypted

  walStorage:
    size: 20Gi
    storageClass: gp3-encrypted

  # Resource requests and limits
  resources:
    requests:
      memory: "4Gi"
      cpu: "1"
    limits:
      memory: "8Gi"
      cpu: "4"

  # Affinity: spread instances across availability zones
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          cnpg.io/cluster: postgres-prod

  # Pod anti-affinity: no two instances on the same node
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: cnpg.io/cluster
                operator: In
                values:
                  - postgres-prod
          topologyKey: kubernetes.io/hostname

  # Backup configuration
  backup:
    barmanObjectStore:
      destinationPath: "s3://my-postgres-backups/postgres-prod"
      s3Credentials:
        accessKeyId:
          name: s3-backup-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: s3-backup-credentials
          key: ACCESS_SECRET_KEY
      wal:
        compression: gzip
        maxParallel: 4
      data:
        compression: gzip
        immediateCheckpoint: false
        jobs: 4
    retentionPolicy: "30d"

  # Monitoring: expose metrics for Prometheus
  monitoring:
    enablePodMonitor: true
    customQueriesConfigMap:
      - name: postgres-custom-metrics
        key: queries.yaml

  # Managed roles - create application users declaratively
  managed:
    roles:
      - name: app
        ensure: present
        login: true
        inherit: true
        replication: false
        superuser: false
        comment: "Application user"
        passwordSecret:
          name: postgres-app-credentials
      - name: readonly
        ensure: present
        login: true
        inherit: true
        replication: false
        superuser: false
        comment: "Read-only user for analytics"
        passwordSecret:
          name: postgres-readonly-credentials
```

## Scheduled Backups

```yaml
# scheduled-backup.yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: postgres-prod-daily
  namespace: production
spec:
  schedule: "0 2 * * *"  # 2 AM UTC daily
  backupOwnerReference: self
  cluster:
    name: postgres-prod
  # Take backup from a standby to avoid primary load
  target: prefer-standby
  method: barmanObjectStore
```

## Monitoring and Alerting

### Custom Queries ConfigMap

```yaml
# postgres-custom-metrics.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-custom-metrics
  namespace: production
data:
  queries.yaml: |
    pg_replication_lag:
      query: |
        SELECT
          CASE
            WHEN pg_is_in_recovery() THEN
              EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
            ELSE 0
          END AS lag_seconds
      metrics:
        - lag_seconds:
            usage: "GAUGE"
            description: "Replication lag in seconds"

    pg_database_size:
      query: |
        SELECT
          datname,
          pg_database_size(datname) AS size_bytes
        FROM pg_database
        WHERE datname NOT IN ('template0', 'template1', 'postgres')
      metrics:
        - datname:
            usage: "LABEL"
            description: "Database name"
        - size_bytes:
            usage: "GAUGE"
            description: "Database size in bytes"

    pg_long_running_queries:
      query: |
        SELECT
          count(*) AS count
        FROM pg_stat_activity
        WHERE state = 'active'
          AND query_start < now() - interval '30 seconds'
          AND query NOT LIKE 'COPY%'
          AND query NOT LIKE 'autovacuum%'
      metrics:
        - count:
            usage: "GAUGE"
            description: "Number of queries running longer than 30 seconds"

    pg_table_bloat:
      query: |
        SELECT
          schemaname,
          tablename,
          pg_total_relation_size(schemaname || '.' || tablename) AS total_bytes,
          (pg_total_relation_size(schemaname || '.' || tablename) -
           pg_relation_size(schemaname || '.' || tablename)) AS bloat_bytes
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        LIMIT 20
      metrics:
        - schemaname:
            usage: "LABEL"
        - tablename:
            usage: "LABEL"
        - total_bytes:
            usage: "GAUGE"
            description: "Total size including TOAST and indexes"
        - bloat_bytes:
            usage: "GAUGE"
            description: "Estimated bloat bytes"
```

### PrometheusRule for Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cloudnativepg-alerts
  namespace: monitoring
spec:
  groups:
    - name: cloudnativepg.cluster
      rules:
        - alert: CNPGClusterNotReady
          expr: |
            cnpg_collector_up{} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "CloudNativePG cluster {{ $labels.cluster }} is not ready"

        - alert: CNPGReplicationLagHigh
          expr: |
            pg_replication_lag_lag_seconds > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL replication lag is {{ $value | humanizeDuration }}"
            description: "Instance {{ $labels.pod }} in cluster {{ $labels.cluster }} has {{ $value }}s replication lag"

        - alert: CNPGReplicationLagCritical
          expr: |
            pg_replication_lag_lag_seconds > 300
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "PostgreSQL replication lag critical: {{ $value | humanizeDuration }}"

        - alert: CNPGBackupFailed
          expr: |
            cnpg_collector_last_backup_succeeded == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Last backup failed for cluster {{ $labels.cluster }}"

        - alert: CNPGBackupTooOld
          expr: |
            (time() - cnpg_collector_last_backup_timestamp) > 86400
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "No successful backup in the last 24 hours"

        - alert: CNPGLongRunningQuery
          expr: |
            pg_long_running_queries_count > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "{{ $value }} long-running queries on {{ $labels.pod }}"

        - alert: CNPGConnectionsNearLimit
          expr: |
            (pg_stat_database_numbackends{datname="app"} /
             pg_settings_max_connections) > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL connections at {{ $value | humanizePercentage }} of limit"
```

## Automated Failover

CloudNativePG handles failover automatically. Understanding the process helps with RTO planning:

### Failover Process

1. **Detection**: the operator detects the primary is unhealthy via the Pod's readiness probe (typically within 30-60 seconds with default settings)
2. **Election**: the operator selects the standby with the lowest replication lag (most up-to-date data)
3. **Promotion**: the selected standby is promoted to primary via `pg_promote()`
4. **Service update**: the `postgres-prod-rw` Service endpoint is updated to point to the new primary
5. **Cascade replication**: other standbys re-establish streaming replication to the new primary

Typical RTO: 30-90 seconds, depending on probe intervals.

```bash
# Monitor a failover in progress
kubectl cnpg status postgres-prod -n production --watch

# The status output shows:
# Cluster Summary
# Primary server is initializing
# Primary server: postgres-prod-2
# ...

# Check cluster events for failover details
kubectl get events -n production \
  --field-selector reason=FailoverTriggered \
  --sort-by='.lastTimestamp'
```

### Adjusting Probe Timing

The default probe settings may be too slow for latency-sensitive applications:

```yaml
# In the Cluster spec
spec:
  # Reduce failover detection time
  failoverDelay: 0  # Failover immediately (default: 0)

  # Primary probe settings are derived from the Pod spec
  # Override them via the pods spec
  pods:
    livenessProbeTimeout: 5
    readinessProbeTimeout: 5
```

For the readiness probe, CloudNativePG checks that PostgreSQL accepts connections. Reducing `periodSeconds` accelerates detection:

```yaml
# These settings are controlled by the operator but can be guided
# by setting the cluster's startupProbe settings
spec:
  startDelay: 30  # Seconds to wait after pod start before checking health
```

## Manual Switchover

For planned maintenance (OS patching, node draining), perform a controlled switchover:

```bash
# Perform a controlled switchover to a specific instance
kubectl cnpg promote postgres-prod postgres-prod-2 -n production

# Or let the operator choose the best standby
kubectl cnpg switchover postgres-prod -n production

# Monitor the switchover progress
kubectl cnpg status postgres-prod -n production --watch
```

During a switchover (versus a failover):
- The current primary gracefully steps down
- WAL is fully flushed before promotion
- Zero data loss is guaranteed
- Downtime is typically under 10 seconds

## Point-in-Time Recovery

CloudNativePG's PITR restores a cluster from WAL archives to any point in time within your retention window:

```yaml
# pitr-recovery.yaml - Restore to a specific timestamp
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod-recovery
  namespace: recovery
spec:
  instances: 1  # Start with 1 instance for recovery, scale up after verification
  imageName: ghcr.io/cloudnative-pg/postgresql:16.2

  bootstrap:
    recovery:
      source: postgres-prod
      recoveryTarget:
        # Recover to a specific point in time (UTC)
        targetTime: "2031-08-19 14:30:00"
        # Alternative: recover to a specific transaction ID
        # targetXID: "12345678"
        # Alternative: recover to a named restore point created with pg_create_restore_point()
        # targetName: "before-bad-migration"
        # Alternative: recover to the latest available WAL
        # targetImmediate: true

  externalClusters:
    - name: postgres-prod
      barmanObjectStore:
        destinationPath: "s3://my-postgres-backups/postgres-prod"
        s3Credentials:
          accessKeyId:
            name: s3-backup-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: s3-backup-credentials
            key: ACCESS_SECRET_KEY
        wal:
          maxParallel: 8

  storage:
    size: 100Gi
    storageClass: gp3-encrypted
```

```bash
# Apply the recovery cluster
kubectl apply -f pitr-recovery.yaml

# Watch the recovery progress
kubectl cnpg status postgres-prod-recovery -n recovery --watch

# The status will show:
# Recovery status: in progress / completed
# Recovery point: 2031-08-19 14:30:00

# Once complete, connect and verify data
kubectl cnpg psql postgres-prod-recovery -n recovery -- \
  -c "SELECT pg_last_xact_replay_timestamp();"

# If data looks correct, scale up and promote to a new production cluster
kubectl patch cluster postgres-prod-recovery -n recovery \
  --type=merge --patch '{"spec":{"instances":3}}'
```

## Connection Pooling with PgBouncer

CloudNativePG includes a `Pooler` CRD that deploys PgBouncer alongside your cluster:

```yaml
# pooler.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres-prod-pooler-rw
  namespace: production
spec:
  cluster:
    name: postgres-prod
  instances: 3
  type: rw  # 'rw' for primary, 'ro' for standby

  pgbouncer:
    poolMode: transaction  # transaction mode for most web apps
    authQuerySecret:
      name: postgres-superuser-credentials
    authQuery: "SELECT usename, passwd FROM pg_shadow WHERE usename=$1"
    parameters:
      max_client_conn: "1000"
      default_pool_size: "25"
      reserve_pool_size: "5"
      reserve_pool_timeout: "5"
      server_idle_timeout: "600"
      client_idle_timeout: "0"
      max_prepared_statements: "0"  # Disable in transaction mode
      log_connections: "1"
      log_disconnections: "1"
      log_pooler_errors: "1"

  # PgBouncer pod anti-affinity
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                cnpg.io/poolerName: postgres-prod-pooler-rw
            topologyKey: kubernetes.io/hostname

  resources:
    requests:
      memory: "64Mi"
      cpu: "50m"
    limits:
      memory: "256Mi"
      cpu: "500m"
```

The Pooler creates a Service `postgres-prod-pooler-rw` that applications connect to. PgBouncer maintains a pool of actual PostgreSQL connections, allowing thousands of application connections with far fewer backend connections.

## Cluster Upgrade

CloudNativePG supports in-place minor version upgrades. Major version upgrades require a logical replication-based migration.

### Minor Version Upgrade

```bash
# Upgrade to a new patch version
kubectl patch cluster postgres-prod -n production \
  --type=merge \
  --patch '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:16.3"}}'

# CloudNativePG performs a rolling upgrade:
# 1. Update standbys one at a time
# 2. Perform a switchover to a standby
# 3. Update the old primary

# Monitor the upgrade
kubectl cnpg status postgres-prod -n production --watch
```

### Major Version Upgrade (13 → 14 → 15 → 16)

```yaml
# Create a new cluster as a logical replica of the current production cluster
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod-v16
  namespace: production
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.2

  bootstrap:
    pg_basebackup:
      source: postgres-prod-v15

  externalClusters:
    - name: postgres-prod-v15
      connectionParameters:
        host: postgres-prod-rw.production.svc.cluster.local
        user: streaming_replica
        dbname: app
        sslmode: require
      password:
        name: postgres-replica-credentials
        key: password

  # ... rest of cluster spec
```

## Production Operations Runbook

### Daily Health Check

```bash
#!/bin/bash
# cloudnativepg-health-check.sh

NAMESPACE=${1:-production}
CLUSTER=${2:-postgres-prod}

echo "=== CloudNativePG Health Check: $CLUSTER ==="
echo ""

# Cluster overview
echo "--- Cluster Status ---"
kubectl cnpg status $CLUSTER -n $NAMESPACE
echo ""

# Check all pods are running
echo "--- Pod Status ---"
kubectl get pods -n $NAMESPACE \
  -l cnpg.io/cluster=$CLUSTER \
  -o custom-columns=\
"NAME:.metadata.name,STATUS:.status.phase,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount"
echo ""

# Check replication lag
echo "--- Replication Status ---"
kubectl cnpg psql $CLUSTER -n $NAMESPACE -- \
  -c "SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
             (sent_lsn - replay_lsn) AS replication_lag_bytes
      FROM pg_stat_replication;"
echo ""

# Check last backup
echo "--- Backup Status ---"
kubectl get backups -n $NAMESPACE \
  -l cnpg.io/cluster=$CLUSTER \
  --sort-by='.metadata.creationTimestamp' | tail -5
echo ""

# Check for long-running queries
echo "--- Long-Running Queries (>30s) ---"
kubectl cnpg psql $CLUSTER -n $NAMESPACE -- \
  -c "SELECT pid, now() - query_start AS duration, state, query
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND query_start < now() - interval '30 seconds'
      ORDER BY duration DESC
      LIMIT 10;"
echo ""

echo "=== Check Complete ==="
```

### Disk Space Investigation

```bash
# Check tablespace usage
kubectl cnpg psql postgres-prod -n production -- \
  -c "SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
        pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
        pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) AS index_size
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
      LIMIT 20;"

# Check WAL archive lag
kubectl cnpg psql postgres-prod -n production -- \
  -c "SELECT
        archived_count,
        last_archived_wal,
        last_archived_time,
        failed_count,
        last_failed_wal,
        last_failed_time
      FROM pg_stat_archiver;"
```

## Summary

CloudNativePG brings genuine PostgreSQL expertise to the Kubernetes operator model. The combination of streaming replication with replication slots (preventing WAL recycling), continuous WAL archiving to object storage, and automated failover with service-level endpoint management gives production teams a reliable PostgreSQL HA solution that integrates naturally with Kubernetes workflows.

The key operational advantages: all cluster state is in the `Cluster` CRD (GitOps friendly), backup and PITR are first-class features rather than an afterthought, and the PodMonitor integration with Prometheus means you get rich database metrics without deploying a separate exporter. For teams running PostgreSQL on Kubernetes, CloudNativePG is the operator to default to in 2031.
