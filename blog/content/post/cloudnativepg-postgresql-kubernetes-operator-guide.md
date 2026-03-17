---
title: "CloudNativePG: Production PostgreSQL on Kubernetes with Streaming Replication"
date: 2028-09-15T00:00:00-05:00
draft: false
tags: ["CloudNativePG", "PostgreSQL", "Kubernetes", "Database", "High Availability"]
categories:
- CloudNativePG
- PostgreSQL
author: "Matthew Mattox - mmattox@support.tools"
description: "CloudNativePG operator deployment, Cluster CRD configuration, streaming replication, WAL archiving to S3 with Barman, automated failover, PgBouncer connection pooling, PITR restore, and monitoring with Prometheus."
more_link: "yes"
url: "/cloudnativepg-postgresql-kubernetes-operator-guide/"
---

Running PostgreSQL on Kubernetes has historically required significant operational knowledge spread across StatefulSets, init containers, Patroni configurations, and custom backup scripts. CloudNativePG changes this fundamentally by implementing PostgreSQL's native streaming replication, WAL archiving, and automated failover as a Kubernetes operator with a clean CRD API. The result is a Cluster object that describes your entire PostgreSQL topology — number of replicas, backup schedule, connection pooling, TLS configuration — and the operator reconciles reality to match. This guide builds a production-grade PostgreSQL cluster from scratch including S3 WAL archiving, point-in-time recovery, PgBouncer, and Prometheus monitoring.

<!--more-->

# CloudNativePG: Production PostgreSQL on Kubernetes with Streaming Replication

## Understanding CloudNativePG Architecture

CloudNativePG runs one PostgreSQL instance per pod. The primary handles writes; replicas use streaming replication to stay current. Failover is automatic: when the primary fails, the operator promotes the most up-to-date replica. Unlike solutions that wrap an external consensus layer, CNPG leverages PostgreSQL's built-in replication mechanisms and Kubernetes for coordination.

Key components:
- **Cluster CRD**: Describes the desired topology (instances, storage, backup, TLS)
- **Barman Cloud**: Handles WAL archiving and base backups to object storage
- **Pooler CRD**: Deploys PgBouncer as a connection pooler alongside the cluster
- **Plugin Framework**: Extensible backup destinations and monitoring integrations

## Section 1: Installing the Operator

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update

helm upgrade --install cloudnative-pg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version 0.22.0 \
  --set config.create=true \
  --set config.data.INHERITED_ANNOTATIONS='kubectl.kubernetes.io/last-applied-configuration' \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=256Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=512Mi \
  --wait
```

Verify the operator is running:

```bash
kubectl get pods -n cnpg-system
# NAME                                   READY   STATUS    RESTARTS   AGE
# cloudnative-pg-5d9f7b6d8c-4kwx9       1/1     Running   0          2m

kubectl get crd | grep postgresql.cnpg.io
# clusters.postgresql.cnpg.io
# poolers.postgresql.cnpg.io
# scheduledbackups.postgresql.cnpg.io
# backups.postgresql.cnpg.io
```

## Section 2: S3 Backup Configuration

Create an IAM role for Barman Cloud (or use a Kubernetes secret for simpler setups):

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
        "arn:aws:s3:::acme-postgresql-backups",
        "arn:aws:s3:::acme-postgresql-backups/*"
      ]
    }
  ]
}
```

```bash
# Create the backup credentials secret
kubectl create namespace payments-db

kubectl create secret generic aws-backup-credentials \
  --namespace payments-db \
  --from-literal=ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE \
  --from-literal=ACCESS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# Create the superuser password secret
kubectl create secret generic payments-db-superuser \
  --namespace payments-db \
  --from-literal=username=postgres \
  --from-literal=password=$(openssl rand -base64 32)

# Create the application user secret
kubectl create secret generic payments-db-app \
  --namespace payments-db \
  --from-literal=username=payments_app \
  --from-literal=password=$(openssl rand -base64 32)
```

## Section 3: Cluster CRD — Primary and Replicas

```yaml
# payments-cluster.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: payments-db
  namespace: payments-db
  labels:
    app: payments
    env: production
spec:
  # 1 primary + 2 replicas
  instances: 3

  # PostgreSQL version and parameters
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  postgresql:
    parameters:
      max_connections: "300"
      shared_buffers: "2GB"
      effective_cache_size: "6GB"
      maintenance_work_mem: "512MB"
      checkpoint_completion_target: "0.9"
      wal_buffers: "16MB"
      default_statistics_target: "100"
      random_page_cost: "1.1"       # SSD storage
      effective_io_concurrency: "200"
      work_mem: "6553kB"
      min_wal_size: "1GB"
      max_wal_size: "4GB"
      max_worker_processes: "8"
      max_parallel_workers_per_gather: "4"
      max_parallel_workers: "8"
      max_parallel_maintenance_workers: "4"
      wal_level: "logical"
      log_min_duration_statement: "1000"  # Log queries > 1s
      log_checkpoints: "on"
      log_connections: "on"
      log_lock_waits: "on"
      log_temp_files: "0"
      track_io_timing: "on"
      track_functions: "all"

    pg_hba:
      # Allow replication connections
      - host replication all 10.0.0.0/8 scram-sha-256
      # Application connections require SSL
      - hostssl all all 0.0.0.0/0 scram-sha-256
      # Local connections (for superuser)
      - local all all peer

  # Bootstrap with initdb
  bootstrap:
    initdb:
      database: payments
      owner: payments_app
      secret:
        name: payments-db-app
      # Run setup SQL after cluster creation
      postInitSQL:
        - CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
        - CREATE EXTENSION IF NOT EXISTS pgcrypto;
        - CREATE EXTENSION IF NOT EXISTS uuid-ossp;
        - ALTER SYSTEM SET pg_stat_statements.track = 'all';

  # Superuser credentials
  superuserSecret:
    name: payments-db-superuser

  # TLS — use cert-manager issued certificate
  certificates:
    serverCASecret: payments-db-ca
    serverTLSSecret: payments-db-tls
    clientCASecret: payments-db-ca
    replicationTLSSecret: payments-db-replication-tls

  # Storage
  storage:
    size: 100Gi
    storageClass: gp3-high-iops

  # WAL storage on separate volume
  walStorage:
    size: 20Gi
    storageClass: gp3-high-iops

  # Resources
  resources:
    requests:
      cpu: 2
      memory: 8Gi
    limits:
      cpu: 8
      memory: 16Gi

  # Pod anti-affinity to spread across AZs
  affinity:
    topologyKey: topology.kubernetes.io/zone
    podAntiAffinityType: required

  # Backup configuration using Barman Cloud (S3)
  backup:
    barmanObjectStore:
      destinationPath: s3://acme-postgresql-backups/payments-db
      s3Credentials:
        accessKeyId:
          name: aws-backup-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: aws-backup-credentials
          key: ACCESS_SECRET_KEY
      endpointURL: https://s3.us-east-1.amazonaws.com
      s3Credentials:
        region: us-east-1
      wal:
        compression: gzip
        encryption: AES256
        maxParallel: 8
      data:
        compression: gzip
        encryption: AES256
        immediateCheckpoint: true
        jobs: 4
    retentionPolicy: "30d"

  # Promote the replica with the most WAL on primary failure
  failoverDelay: 0

  # Topology spread across availability zones
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          cnpg.io/cluster: payments-db

  # Monitoring
  monitoring:
    enablePodMonitor: true
    customQueriesConfigMap:
      - name: cnpg-custom-queries
        key: queries.yaml

  # Maintenance window — avoid failover during business hours
  nodeMaintenanceWindow:
    inProgress: false
    reusePVC: true
```

## Section 4: Scheduled Backups

```yaml
# payments-scheduled-backup.yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: payments-db-daily
  namespace: payments-db
spec:
  schedule: "0 2 * * *"   # 2 AM UTC daily
  backupOwnerReference: self
  cluster:
    name: payments-db
  target: primary           # Take base backup from primary
  method: barmanObjectStore
  immediate: true           # Take a backup immediately on creation
---
# Weekly full backup
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: payments-db-weekly
  namespace: payments-db
spec:
  schedule: "0 1 * * 0"   # 1 AM UTC Sunday
  backupOwnerReference: self
  cluster:
    name: payments-db
  target: primary
  method: barmanObjectStore
```

## Section 5: PgBouncer Connection Pooler

For applications with many short-lived connections, PgBouncer reduces connection overhead dramatically.

```yaml
# payments-pooler.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: payments-db-pooler-rw
  namespace: payments-db
spec:
  cluster:
    name: payments-db
  instances: 3
  type: rw        # Route to primary (use 'ro' for replicas)
  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "1000"
      default_pool_size: "25"
      min_pool_size: "5"
      reserve_pool_size: "10"
      reserve_pool_timeout: "5"
      max_db_connections: "100"
      server_idle_timeout: "600"
      client_idle_timeout: "0"
      tcp_keepalive: "1"
      tcp_keepidle: "10"
      tcp_keepintvl: "5"
      tcp_keepcnt: "3"
  template:
    metadata:
      labels:
        app: payments-pooler
    spec:
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
---
# Read-only pooler targeting replicas
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: payments-db-pooler-ro
  namespace: payments-db
spec:
  cluster:
    name: payments-db
  instances: 3
  type: ro        # Route to replicas
  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "2000"
      default_pool_size: "50"
```

Application connection strings:

```bash
# Read-write via PgBouncer
psql "host=payments-db-pooler-rw.payments-db.svc.cluster.local \
      port=5432 \
      dbname=payments \
      user=payments_app \
      sslmode=require"

# Read-only via PgBouncer (for analytics, reporting)
psql "host=payments-db-pooler-ro.payments-db.svc.cluster.local \
      port=5432 \
      dbname=payments \
      user=payments_app \
      sslmode=require"
```

## Section 6: Point-in-Time Recovery (PITR)

When you need to recover from data corruption or accidental deletions, PITR allows recovery to any point covered by your WAL archive.

```yaml
# pitr-cluster.yaml — create a new cluster from PITR
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: payments-db-recovery
  namespace: payments-db-recovery
spec:
  instances: 1  # Start with a single instance for recovery validation

  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  bootstrap:
    recovery:
      source: payments-db-backup
      recoveryTarget:
        # Recover to just before the bad transaction
        targetTime: "2028-09-15 14:22:00.000000+00"
        # Alternative: recover to specific LSN
        # targetLSN: "0/7000060"
        # Alternative: recover to named restore point
        # targetName: "before_data_migration"
        targetInclusive: false

  externalClusters:
    - name: payments-db-backup
      barmanObjectStore:
        destinationPath: s3://acme-postgresql-backups/payments-db
        s3Credentials:
          accessKeyId:
            name: aws-backup-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: aws-backup-credentials
            key: ACCESS_SECRET_KEY
        wal:
          maxParallel: 8

  storage:
    size: 100Gi
    storageClass: gp3-high-iops

  superuserSecret:
    name: payments-db-superuser
```

Monitor recovery progress:

```bash
kubectl logs -n payments-db-recovery \
  payments-db-recovery-1 -f | grep -E "recovery|WAL|checkpoint"

# Verify the recovery timeline
kubectl exec -n payments-db-recovery payments-db-recovery-1 -- \
  psql -U postgres -c "SELECT pg_is_in_recovery(), now();"

# Check recovered data
kubectl exec -n payments-db-recovery payments-db-recovery-1 -- \
  psql -U postgres -d payments -c "SELECT COUNT(*) FROM transactions WHERE created_at < '2028-09-15 14:22:00';"
```

## Section 7: Custom Prometheus Queries

```yaml
# cnpg-custom-queries.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cnpg-custom-queries
  namespace: payments-db
data:
  queries.yaml: |
    pg_replication:
      query: "SELECT CASE WHEN NOT pg_is_in_recovery() THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))) END AS lag"
      master: true
      metrics:
        - lag:
            usage: GAUGE
            description: "Replication lag behind primary in seconds"

    pg_connections:
      query: "SELECT datname, count(*) AS count, max_conn FROM pg_stat_activity JOIN (SELECT datname AS db, setting::int AS max_conn FROM pg_settings CROSS JOIN pg_database WHERE name = 'max_connections') cfg ON cfg.db = datname GROUP BY datname, max_conn"
      metrics:
        - datname:
            usage: LABEL
            description: "Database name"
        - count:
            usage: GAUGE
            description: "Number of active connections"
        - max_conn:
            usage: GAUGE
            description: "Max allowed connections"

    pg_long_running_queries:
      query: "SELECT count(*) AS count FROM pg_stat_activity WHERE state != 'idle' AND query_start < now() - interval '5 minutes' AND pid != pg_backend_pid()"
      master: true
      metrics:
        - count:
            usage: GAUGE
            description: "Number of queries running longer than 5 minutes"

    pg_bloat:
      query: |
        SELECT schemaname, tablename,
               n_dead_tup, n_live_tup,
               CASE WHEN n_live_tup > 0
                 THEN round(100 * n_dead_tup::numeric / n_live_tup, 2)
                 ELSE 0
               END AS bloat_ratio
        FROM pg_stat_user_tables
        WHERE n_dead_tup > 10000
        ORDER BY n_dead_tup DESC
        LIMIT 10
      metrics:
        - schemaname:
            usage: LABEL
        - tablename:
            usage: LABEL
        - n_dead_tup:
            usage: GAUGE
            description: "Dead tuples"
        - bloat_ratio:
            usage: GAUGE
            description: "Dead tuples as percentage of live tuples"
```

## Section 8: PrometheusRule for Database Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cloudnativepg-alerts
  namespace: payments-db
  labels:
    release: prometheus
spec:
  groups:
    - name: cnpg.cluster
      rules:
        - alert: CNPGClusterNotHealthy
          expr: cnpg_collector_pg_collector_collection_errors > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "CloudNativePG cluster {{ $labels.cluster }} is not healthy"

        - alert: CNPGReplicationLagHigh
          expr: pg_replication_lag > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL replication lag is {{ $value }}s on {{ $labels.pod }}"

        - alert: CNPGReplicationLagCritical
          expr: pg_replication_lag > 120
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "PostgreSQL replication lag exceeds 2 minutes on {{ $labels.pod }}"

        - alert: CNPGConnectionsNearLimit
          expr: |
            (pg_connections_count / pg_connections_max_conn) * 100 > 80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL connections at {{ $value }}% of limit on {{ $labels.pod }}"

        - alert: CNPGBackupFailed
          expr: |
            time() - cnpg_collector_last_successful_backup_time > 86400
          for: 1h
          labels:
            severity: critical
          annotations:
            summary: "PostgreSQL backup has not succeeded in over 24 hours"
            description: "Cluster {{ $labels.cluster }} last successful backup was more than 24 hours ago."

        - alert: CNPGLongRunningQueries
          expr: pg_long_running_queries_count > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "{{ $value }} long-running queries on {{ $labels.pod }}"
```

## Section 9: Major Version Upgrades

CloudNativePG handles major PostgreSQL version upgrades via pg_upgrade in-place:

```yaml
# Initiate an in-place upgrade by updating imageName
# First: create a backup
kubectl cnpg backup payments-db --name pre-upgrade-backup -n payments-db

# Verify backup completed
kubectl get backup -n payments-db pre-upgrade-backup

# Apply the new version
kubectl patch cluster payments-db -n payments-db \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/imageName", "value": "ghcr.io/cloudnative-pg/postgresql:17.0"}]'

# Monitor the upgrade
kubectl get cluster payments-db -n payments-db -w
```

For zero-downtime upgrades between minor versions (16.2 to 16.3), simply update the imageName and the operator performs rolling updates.

## Section 10: Operational Runbook

```bash
#!/bin/bash
# cnpg-ops.sh — common operational commands

NAMESPACE="${1:-payments-db}"
CLUSTER="${2:-payments-db}"

# Status overview
echo "=== Cluster Status ==="
kubectl cnpg status "${CLUSTER}" -n "${NAMESPACE}"

# Which pod is the primary?
echo ""
echo "=== Primary Pod ==="
kubectl get pods -n "${NAMESPACE}" -l "cnpg.io/cluster=${CLUSTER},cnpg.io/instanceRole=primary" \
  -o jsonpath='{.items[0].metadata.name}'

# Trigger a manual failover (switchover)
echo ""
echo "=== Triggering Switchover ==="
kubectl cnpg promote "${CLUSTER}" "${CLUSTER}-2" -n "${NAMESPACE}"

# Take an on-demand backup
echo ""
echo "=== Taking On-Demand Backup ==="
kubectl cnpg backup "${CLUSTER}" \
  --name "manual-$(date +%Y%m%d-%H%M%S)" \
  -n "${NAMESPACE}"

# Check WAL archiving status
echo ""
echo "=== WAL Archive Status ==="
kubectl exec -n "${NAMESPACE}" "${CLUSTER}-1" -- \
  psql -U postgres -c "SELECT * FROM pg_stat_archiver;"

# Reload PostgreSQL configuration (no restart)
echo ""
echo "=== Reloading Configuration ==="
kubectl cnpg reload "${CLUSTER}" -n "${NAMESPACE}"

# Check replication lag on all replicas
echo ""
echo "=== Replication Lag ==="
kubectl exec -n "${NAMESPACE}" "${CLUSTER}-1" -- \
  psql -U postgres -c "
    SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
           write_lag, flush_lag, replay_lag
    FROM pg_stat_replication;
  "
```

## Conclusion

CloudNativePG represents the maturation of PostgreSQL on Kubernetes. The operator handles the hard problems — streaming replication topology, WAL archiving, automated failover, TLS certificate rotation — through a declarative API that your GitOps pipeline can manage. The PgBouncer Pooler CRD gives you connection pooling without a separate deployment to manage. Combined with the built-in Prometheus metrics and scheduled backups, you have a production-grade PostgreSQL deployment that meets enterprise requirements without the operational burden of self-managed Patroni or external database services.
