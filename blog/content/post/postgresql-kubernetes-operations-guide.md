---
title: "PostgreSQL on Kubernetes: CloudNativePG Production Operations"
date: 2028-01-31T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "Kubernetes", "CloudNativePG", "CNPG", "Databases", "High Availability", "Backup"]
categories: ["Kubernetes", "Databases", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production operations guide for PostgreSQL on Kubernetes using CloudNativePG (CNPG), covering Cluster CRD configuration, primary/replica setup, scheduled backups to S3/GCS, point-in-time recovery, PgBouncer pooling, and cross-cluster replication."
more_link: "yes"
url: "/postgresql-kubernetes-operations-guide/"
---

PostgreSQL on Kubernetes requires a purpose-built operator to manage the replication topology, WAL archiving, backup lifecycle, and failover choreography that production workloads demand. CloudNativePG (CNPG) is the CNCF sandbox project that codifies these PostgreSQL operational patterns into Kubernetes-native custom resources. Unlike generic StatefulSet approaches, CNPG understands PostgreSQL internals: it manages pg_rewind for standbys that fall behind, handles replica promotion with the proper synchronization order, and integrates WAL archiving directly with the cluster lifecycle.

<!--more-->

# PostgreSQL on Kubernetes: CloudNativePG Production Operations

## CloudNativePG Architecture

CNPG manages a PostgreSQL cluster as a set of coordinated Kubernetes resources:

```
CNPG Cluster "postgres-production"
├── Pod: postgres-production-1  (Primary)
│     ├── Container: postgres
│     ├── Container: bootstrap (init)
│     └── PVC: postgres-production-1 (500Gi)
├── Pod: postgres-production-2  (Replica)
│     └── Streaming replication from primary
├── Pod: postgres-production-3  (Replica)
│     └── Streaming replication from primary
├── Service: postgres-production-rw   → Primary (writes)
├── Service: postgres-production-ro   → Replicas (reads)
├── Service: postgres-production-r    → All instances
└── Secret: postgres-production-app   (application credentials)
```

The operator watches the Cluster CRD and continuously reconciles the actual state toward the desired state — including automatic failover when the primary becomes unavailable.

## Installing CloudNativePG

```bash
# Install the CNPG operator
kubectl apply -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.23/releases/cnpg-1.23.0.yaml

# Verify the operator is running
kubectl get pods -n cnpg-system

# Install the CNPG plugin for kubectl
curl -sSfL \
  https://github.com/cloudnative-pg/cloudnative-pg/raw/main/hack/install-cnpg-plugin.sh | \
  sh -s -- -b /usr/local/bin

# Verify the plugin
kubectl cnpg version
```

## Cluster CRD: Production Configuration

```yaml
# postgres/cluster-production.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-production
  namespace: database
spec:
  # PostgreSQL version
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3
  # Number of instances: 1 primary + 2 replicas
  instances: 3

  # PostgreSQL parameters (equivalent to postgresql.conf)
  postgresql:
    parameters:
      # Memory configuration
      # shared_buffers: typically 25% of RAM
      shared_buffers: "2GB"
      # effective_cache_size: estimate of available OS cache (75% of RAM)
      effective_cache_size: "6GB"
      # work_mem: per-operation memory for sorts and hash joins
      # Total memory usage = work_mem * max_connections * 2-3
      work_mem: "64MB"
      # maintenance_work_mem: for VACUUM, CREATE INDEX operations
      maintenance_work_mem: "512MB"
      # WAL configuration
      wal_level: "replica"       # Required for streaming replication
      max_wal_senders: "20"      # Maximum concurrent WAL sender processes
      max_replication_slots: "20" # Maximum replication slots
      wal_keep_size: "1GB"       # Keep 1GB of WAL for replica catchup
      # Checkpoint tuning (reduce I/O spikes)
      checkpoint_completion_target: "0.9"
      checkpoint_timeout: "5min"
      # Autovacuum tuning
      autovacuum_vacuum_scale_factor: "0.01"    # Vacuum when 1% of rows changed
      autovacuum_analyze_scale_factor: "0.005"  # Analyze when 0.5% of rows changed
      autovacuum_vacuum_cost_delay: "2ms"       # Throttle autovacuum I/O
      # Query statistics
      shared_preload_libraries: "pg_stat_statements"
      pg_stat_statements.max: "10000"
      pg_stat_statements.track: "all"
      # Connection limits
      max_connections: "200"
      # Logging
      log_min_duration_statement: "1000"  # Log queries slower than 1 second
      log_line_prefix: "%m [%p] %q%u@%d "
      log_checkpoints: "on"
      log_lock_waits: "on"
      log_temp_files: "0"  # Log all temporary file creation
    # pg_hba.conf rules for client authentication
    pg_hba:
      - "host all all 10.0.0.0/8 scram-sha-256"
      - "host replication replication 10.0.0.0/8 scram-sha-256"

  # Primary update strategy: when the cluster spec changes,
  # how should the primary be updated?
  primaryUpdateStrategy: unsupervised  # Automatic failover during updates
  primaryUpdateMethod: switchover      # Use switchover (planned, no data loss)

  # Replication slots for replicas
  replicationSlots:
    highAvailability:
      enabled: true  # Create a replication slot per replica
    updateInterval: 30

  # Storage configuration
  storage:
    size: 500Gi
    storageClass: premium-ssd

  # WAL storage on a separate volume (recommended for performance)
  walStorage:
    size: 50Gi
    storageClass: premium-ssd

  # Resources for the PostgreSQL pods
  resources:
    requests:
      cpu: "2"
      memory: 8Gi
    limits:
      memory: 10Gi

  # PostgreSQL superuser password
  superuserSecret:
    name: postgres-superuser-secret

  # Application database and user
  bootstrap:
    initdb:
      database: appdb
      owner: app_user
      secret:
        name: postgres-app-secret
      # Additional SQL to run during initialization
      postInitSQL:
        - "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
        - "CREATE EXTENSION IF NOT EXISTS pg_trgm"
        - "ALTER DATABASE appdb SET log_min_duration_statement = '1000'"

  # Affinity rules to spread pods across nodes and zones
  affinity:
    enablePodAntiAffinity: true
    topologyKey: topology.kubernetes.io/zone
    podAntiAffinityType: required  # Hard requirement — no two pods in same zone
    # Node selector for database nodes
    additionalPodAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                workload: database
            topologyKey: kubernetes.io/hostname

  # Pod Disruption Budget
  # CNPG creates this automatically but can be customized
  minSyncReplicas: 1  # At least 1 replica must be in sync for writes to proceed
  maxSyncReplicas: 2  # Synchronous replication to up to 2 replicas

  # Monitoring: expose Prometheus metrics
  monitoring:
    enablePodMonitor: true
    # Custom queries for PodMonitor
    customQueriesConfigMap:
      - name: cnpg-custom-queries
        key: queries.yaml
```

### Application Secret

```bash
# Create the application database credentials secret
kubectl create secret generic postgres-app-secret \
  --namespace database \
  --from-literal=username=app_user \
  --from-literal=password="$(openssl rand -base64 32)"

# Create the superuser secret
kubectl create secret generic postgres-superuser-secret \
  --namespace database \
  --from-literal=username=postgres \
  --from-literal=password="$(openssl rand -base64 32)"
```

## Backup Configuration with WAL Archiving

CNPG uses Barman (a PostgreSQL backup manager) under the hood for WAL archiving and base backups. Backups can be stored in S3, GCS, or Azure Blob Storage.

```yaml
# postgres/cluster-with-backup.yaml
# Add to the Cluster spec
spec:
  # ... existing configuration ...
  backup:
    # Barman object store configuration
    barmanObjectStore:
      # S3-compatible storage
      destinationPath: "s3://my-postgres-backups/production/postgres-production"
      s3Credentials:
        accessKeyId:
          name: aws-s3-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: aws-s3-credentials
          key: SECRET_ACCESS_KEY
        region:
          name: aws-s3-credentials
          key: AWS_REGION
      # WAL archiving configuration
      wal:
        compression: gzip    # Compress WAL files before archiving
        maxParallel: 4       # Upload 4 WAL files concurrently
      # Base backup configuration
      data:
        compression: gzip
        immediateCheckpoint: false  # Allow normal checkpoint timing
        jobs: 4                     # Parallel backup jobs
    # Retention policy: keep 30 days of backups
    retentionPolicy: "30d"
    # Backup volumes: target PVCs directly (faster than filesystem copy)
    target: prefer-standby  # Take backup from a replica to reduce primary load
```

### Scheduled Backups

```yaml
# postgres/scheduled-backup.yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: postgres-production-daily
  namespace: database
spec:
  # Cron expression: daily at 02:00 UTC
  schedule: "0 2 * * *"
  # Reference to the cluster
  cluster:
    name: postgres-production
  # Backup method: barmanObjectStore or volumeSnapshot
  method: barmanObjectStore
  # Backup target: prefer standby to avoid impacting the primary
  target: prefer-standby
  # Whether to immediately trigger a backup when the ScheduledBackup is created
  immediate: false
  # Keep at most 7 backups (overrides retention policy for this schedule)
  backupOwnerReference: self
```

```bash
# List available backups
kubectl get backup -n database

# Describe a specific backup to see its status and storage location
kubectl describe backup postgres-production-20240115-020000 -n database

# Trigger a manual backup immediately
kubectl cnpg backup postgres-production -n database

# Watch backup progress
kubectl get backup -n database -w
```

## Point-in-Time Recovery (PITR)

PITR restores the database to a specific point in time using the WAL archive. This is the primary recovery mechanism for data corruption or accidental deletion.

```yaml
# postgres/cluster-pitr-restore.yaml
# Create a NEW cluster restored from a specific point in time
# The original cluster continues running during the restore
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-production-restored
  namespace: database
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3
  storage:
    size: 500Gi
    storageClass: premium-ssd
  walStorage:
    size: 50Gi
    storageClass: premium-ssd

  # Bootstrap from an existing backup
  bootstrap:
    recovery:
      # Source backup information
      backup:
        name: postgres-production-20240115-020000
      # The recoveryTarget specifies the point in time to restore to
      recoveryTarget:
        # Restore to a specific timestamp (format: YYYY-MM-DD HH:MM:SS TZ)
        targetTime: "2024-01-15 14:30:00 UTC"
        # Alternative: restore to a specific LSN
        # targetLSN: "0/3000000"
        # Alternative: restore to a named restore point
        # targetName: "before_batch_delete"
        # Exclusive: whether to stop BEFORE (true) or AFTER (false) the target
        exclusive: false

  # External cluster reference — where to get the WAL archive
  externalClusters:
    - name: original-cluster
      barmanObjectStore:
        destinationPath: "s3://my-postgres-backups/production/postgres-production"
        s3Credentials:
          accessKeyId:
            name: aws-s3-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: aws-s3-credentials
            key: SECRET_ACCESS_KEY
          region:
            name: aws-s3-credentials
            key: AWS_REGION
        wal:
          maxParallel: 4
```

```bash
# Monitor the recovery progress
kubectl cnpg status postgres-production-restored -n database

# Check detailed recovery logs
kubectl logs postgres-production-restored-1 -n database -c bootstrap | tail -50

# Once the recovery cluster is ready and verified,
# update application connection strings to point to the new cluster
kubectl get secret postgres-production-restored-app -n database \
  -o jsonpath='{.data.uri}' | base64 -d
```

## PgBouncer Connection Pooling

CNPG has native PgBouncer support via the `Pooler` CRD. This is preferable to the ambassador sidecar pattern for PostgreSQL because CNPG can automatically update PgBouncer's connection strings when the primary changes.

```yaml
# postgres/pooler-rw.yaml
# PgBouncer pooler for write traffic (connects to primary)
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres-production-pooler-rw
  namespace: database
spec:
  # Reference the cluster this pooler serves
  cluster:
    name: postgres-production
  # Route to read-write (primary) service
  type: rw
  # Number of PgBouncer instances
  instances: 3
  # PgBouncer configuration
  pgbouncer:
    poolMode: transaction  # transaction pooling is most efficient
    # Maximum connections from the pooler to PostgreSQL
    maxClientConn: 1000
    # Connections maintained in the pool per database+user combination
    defaultPoolSize: 25
    # Minimum pool size (pre-warmed connections)
    minPoolSize: 5
    # Maximum connections reserved for administrative queries
    reservePoolSize: 5
    # Idle timeout: close connections idle for more than this duration
    serverIdleTimeout: 600
    # Maximum time a connection can live (forces reconnection to pick up config changes)
    serverLifetime: 3600
    # Authentication type
    authType: scram-sha-256
    # Parameters to be set on each new server connection
    serverLoginRetry: 15
  # Resource limits for PgBouncer pods
  template:
    spec:
      containers:
        - name: pgbouncer
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 128Mi
---
# PgBouncer pooler for read-only traffic (connects to replicas)
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres-production-pooler-ro
  namespace: database
spec:
  cluster:
    name: postgres-production
  type: ro  # Routes to read-only (replica) service
  instances: 3
  pgbouncer:
    poolMode: transaction
    maxClientConn: 2000
    defaultPoolSize: 50
```

## pg_stat_statements Monitoring

```yaml
# postgres/custom-queries.yaml
# Custom Prometheus queries for CNPG PodMonitor
apiVersion: v1
kind: ConfigMap
metadata:
  name: cnpg-custom-queries
  namespace: database
data:
  queries.yaml: |
    # Slow query detection
    pg_slow_queries:
      query: |
        SELECT
          left(query, 60) as query_sample,
          calls,
          total_exec_time / calls AS avg_duration_ms,
          (total_exec_time / calls) * calls AS total_duration_ms,
          rows / calls AS avg_rows
        FROM pg_stat_statements
        WHERE calls > 100
          AND total_exec_time / calls > 100
        ORDER BY avg_duration_ms DESC
        LIMIT 20
      metrics:
        - query_sample:
            usage: LABEL
            description: "First 60 characters of the query"
        - calls:
            usage: COUNTER
            description: "Number of times this query was executed"
        - avg_duration_ms:
            usage: GAUGE
            description: "Average execution time in milliseconds"

    # Table bloat
    pg_table_bloat:
      query: |
        SELECT
          schemaname,
          tablename,
          pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
          n_dead_tup,
          n_live_tup,
          ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct
        FROM pg_stat_user_tables
        WHERE n_live_tup + n_dead_tup > 1000
        ORDER BY n_dead_tup DESC
        LIMIT 20
      metrics:
        - schemaname:
            usage: LABEL
        - tablename:
            usage: LABEL
        - n_dead_tup:
            usage: GAUGE
            description: "Number of dead tuples (unfragmented rows)"
        - dead_pct:
            usage: GAUGE
            description: "Percentage of dead tuples"

    # Replication lag monitoring
    pg_replication_lag:
      query: |
        SELECT
          client_addr,
          application_name,
          state,
          EXTRACT(EPOCH FROM (now() - write_lag)) AS write_lag_seconds,
          EXTRACT(EPOCH FROM (now() - replay_lag)) AS replay_lag_seconds,
          pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) AS pending_wal
        FROM pg_stat_replication
      metrics:
        - client_addr:
            usage: LABEL
        - application_name:
            usage: LABEL
        - write_lag_seconds:
            usage: GAUGE
            description: "Write lag to replica in seconds"
        - replay_lag_seconds:
            usage: GAUGE
            description: "Replay lag on replica in seconds"
```

## Cross-Cluster Replication for Disaster Recovery

CNPG supports designating a cluster as a replica of another cluster in a different Kubernetes cluster or region, enabling active-passive disaster recovery.

```yaml
# postgres/cluster-replica-dr.yaml
# Standby cluster in a DR region — receives WAL from the primary cluster
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-dr-standby
  namespace: database
spec:
  instances: 2
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3
  storage:
    size: 500Gi
    storageClass: premium-ssd

  # Replica cluster mode: this cluster follows the primary
  replica:
    enabled: true
    # Source cluster WAL archive
    source: primary-cluster

  # When replica.enabled is true, the cluster recovers from
  # the source and then continuously applies WAL
  bootstrap:
    recovery:
      # Recover from the latest backup
      backup:
        name: postgres-production-20240115-020000
      # Do not specify recoveryTarget for continuous replica mode

  # Reference to the primary cluster's WAL archive
  externalClusters:
    - name: primary-cluster
      barmanObjectStore:
        destinationPath: "s3://my-postgres-backups/production/postgres-production"
        s3Credentials:
          accessKeyId:
            name: aws-s3-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: aws-s3-credentials
            key: SECRET_ACCESS_KEY
          region:
            name: aws-s3-credentials
            key: AWS_REGION
        wal:
          maxParallel: 4
```

### Promoting the DR Standby to Primary

```bash
# In a disaster scenario, promote the standby cluster to primary
# This stops WAL replay and allows the cluster to accept writes

# Check current standby status
kubectl cnpg status postgres-dr-standby -n database

# Promote the standby to primary
# WARNING: This is irreversible — the standby can no longer receive WAL
#          from the original primary after promotion
kubectl cnpg promote postgres-dr-standby -n database

# Verify the promotion
kubectl cnpg status postgres-dr-standby -n database
# Status should change from "Replica cluster" to "Primary"

# Update application connection strings to point to the DR cluster
kubectl get secret postgres-dr-standby-app -n database \
  -o jsonpath='{.data.host}' | base64 -d
```

## Operational Commands

```bash
# Check cluster status (replicas, replication lag, primary)
kubectl cnpg status postgres-production -n database

# Switch the primary to a different instance (planned failover)
# This is zero-data-loss: CNPG waits for replica to catch up
kubectl cnpg switchover postgres-production postgres-production-2 -n database

# Trigger a manual failover (for testing)
kubectl cnpg fence postgres-production-1 -n database

# Pause reconciliation (maintenance window)
kubectl patch cluster postgres-production -n database \
  --type merge --patch '{"spec":{"enableSuperuserAccess":true}}'

# Connect to the primary as superuser (for administrative tasks)
kubectl cnpg psql postgres-production -n database

# Check WAL archiving status
kubectl cnpg maintenance set --reusePVC postgres-production -n database

# Check the number of WAL files accumulating (archiving backlog)
kubectl exec postgres-production-1 -n database -c postgres -- \
  psql -U postgres -c "SELECT count(*) FROM pg_ls_waldir() WHERE name ~ '^[0-9A-F]{24}$';"

# Check replication lag from psql
kubectl cnpg psql postgres-production -n database -- \
  -c "SELECT application_name, client_addr, state, write_lag, replay_lag FROM pg_stat_replication;"

# VacuumWorker: trigger autovacuum on a specific table
kubectl cnpg psql postgres-production -n database -- \
  -c "VACUUM ANALYZE VERBOSE appdb.orders;"

# Check table sizes and bloat
kubectl cnpg psql postgres-production -n database -- \
  -c "SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::text)) FROM pg_tables WHERE schemaname='public' ORDER BY pg_total_relation_size(tablename::text) DESC LIMIT 10;"
```

## Prometheus Alerting for PostgreSQL

```yaml
# alerting/rules/postgresql-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cnpg-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: cnpg.rules
      rules:
        # Alert when replication lag exceeds 30 seconds
        - alert: PostgreSQLReplicationLagHigh
          expr: |
            pg_replication_lag_replay_lag_seconds > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL replica {{ $labels.application_name }} lag is {{ $value }}s"

        # Alert when WAL archiving fails
        - alert: PostgreSQLWALArchivingFailed
          expr: |
            cnpg_collector_pg_wal_archive_status{last_failed_wal!=""} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "WAL archiving is failing on {{ $labels.pod }}"

        # Alert when connections are near the max
        - alert: PostgreSQLConnectionsNearLimit
          expr: |
            (cnpg_collector_backends_total / cnpg_collector_pg_settings_max_connections) > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL connection usage is {{ $value | humanizePercentage }}"

        # Alert on high dead tuple percentage (needs VACUUM)
        - alert: PostgreSQLTableBloatHigh
          expr: |
            pg_table_bloat_dead_pct > 20
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Table {{ $labels.schemaname }}.{{ $labels.tablename }} has {{ $value }}% dead tuples"

        # Alert when backup has not run in 25 hours (missed daily backup)
        - alert: PostgreSQLBackupMissed
          expr: |
            time() - cnpg_collector_last_available_backup_timestamp > 90000
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "No successful PostgreSQL backup in the last 25 hours"
```

## Summary

CloudNativePG transforms PostgreSQL operations on Kubernetes from a complex manual process into a declarative, operator-managed workflow. The Cluster CRD encodes production-grade configuration including synchronous replication constraints, storage separation for WAL files, PostgreSQL parameter tuning, and zone-aware pod anti-affinity. Integrated Barman-based backup with S3/GCS archiving provides both scheduled base backups and continuous WAL archiving for point-in-time recovery to any second within the retention window. The Pooler CRD deploys PgBouncer instances that automatically update their connection strings during planned failovers and switchovers, ensuring connection pooling remains functional through topology changes. Cross-cluster replication via the replica cluster mode enables active-passive disaster recovery across regions. The combination of pg_stat_statements monitoring, custom Prometheus queries, and alerting on replication lag, WAL archiving, and connection exhaustion gives operations teams comprehensive visibility into database health without requiring deep PostgreSQL expertise.
