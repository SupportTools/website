---
title: "CloudNativePG: Production PostgreSQL on Kubernetes with Automated Failover"
date: 2027-06-24T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "CloudNativePG", "Kubernetes", "Database", "High Availability"]
categories:
- PostgreSQL
- Kubernetes
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to running production-grade PostgreSQL on Kubernetes using CloudNativePG, covering cluster topology, automated failover, WAL archiving, backup to S3/GCS, point-in-time recovery, PgBouncer connection pooling, and monitoring."
more_link: "yes"
url: "/cloudnativepg-postgresql-kubernetes-guide/"
---

CloudNativePG is a CNCF-hosted Kubernetes operator that brings production-grade PostgreSQL cluster management into the native Kubernetes control plane. Unlike legacy database-on-Kubernetes approaches that wrap external tools in containers, CloudNativePG treats every database cluster as a first-class Kubernetes resource — managing replication, failover, backup, recovery, and connection pooling through declarative CRDs. This guide walks through the full operational lifecycle: from initial cluster deployment to automated failover with `pg_rewind`, WAL archiving to object storage, point-in-time recovery, and continuous monitoring with Prometheus.

<!--more-->

# CloudNativePG: Production PostgreSQL on Kubernetes with Automated Failover

## Section 1: CloudNativePG Architecture Overview

CloudNativePG implements the PostgreSQL operator pattern with a controller that reconciles `Cluster`, `Backup`, `ScheduledBackup`, `Pooler`, and `DatabaseCatalog` custom resources. Each `Cluster` object maps to a StatefulSet-backed primary instance and zero or more streaming replicas, all managed through a sidecar architecture.

### Control Plane Components

The operator runs as a Deployment in its own namespace and watches all namespaces (or a scoped subset) for CloudNativePG CRDs. Three key binaries run inside every cluster pod:

- `postgres` — the PostgreSQL process itself
- `instance-manager` — the CloudNativePG sidecar that handles lifecycle events, WAL archiving, and health reporting
- `barman-cloud-*` — the Barman Cloud utilities for backup and WAL upload

The instance manager intercepts `pg_ctl` signals and coordinates with the operator API before executing failover or switchover operations. This design ensures that PostgreSQL state transitions are always visible to Kubernetes and never occur outside the operator's knowledge.

### Primary/Replica Topology

Every CloudNativePG cluster maintains exactly one primary and N replicas connected via synchronous or asynchronous streaming replication. The operator enforces topology through pod labels:

```
cnpg.io/instanceRole: primary
cnpg.io/instanceRole: replica
```

Two services are created automatically:

- `<cluster-name>-rw` — routes to the current primary (read/write)
- `<cluster-name>-ro` — routes to replicas only (read-only)
- `<cluster-name>-r`  — routes to any instance (read)

Applications connect through these stable service names. During failover the operator updates label selectors so `<cluster-name>-rw` immediately points to the promoted replica without DNS TTL delays.

### Operator Installation

Install CloudNativePG via the official manifest or Helm chart:

```bash
# Manifest install (recommended for air-gapped environments)
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.23/releases/cnpg-1.23.0.yaml

# Helm install
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --set monitoring.podMonitorEnabled=true \
  --version 0.23.0
```

Verify the operator is running:

```bash
kubectl -n cnpg-system get pods
kubectl get crd | grep postgresql
```

---

## Section 2: Cluster CRD — Declarative Cluster Definition

The `Cluster` CRD is the central resource. A minimal production cluster with three instances looks like this:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-prod
  namespace: database
spec:
  instances: 3

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
      effective_cache_size: "1536MB"
      work_mem: "4MB"
      maintenance_work_mem: "128MB"
      wal_level: "replica"
      max_wal_senders: "10"
      max_replication_slots: "10"
      wal_keep_size: "2GB"
      log_min_duration_statement: "1000"
      log_checkpoints: "on"
      log_connections: "on"
      log_disconnections: "on"
      log_lock_waits: "on"
      log_autovacuum_min_duration: "250ms"
      autovacuum_vacuum_cost_delay: "2ms"
      checkpoint_completion_target: "0.9"
      random_page_cost: "1.1"

  primaryUpdateStrategy: unsupervised

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
      cpu: "4"

  affinity:
    enablePodAntiAffinity: true
    topologyKey: kubernetes.io/hostname
    podAntiAffinityType: required

  monitoring:
    enablePodMonitor: true

  superuserSecret:
    name: pg-prod-superuser

  bootstrap:
    initdb:
      database: appdb
      owner: appuser
      secret:
        name: pg-prod-app-credentials
      encoding: UTF8
      localeCType: C
      localeCollate: C
```

### Separate WAL Storage

Separating WAL from data on distinct PVCs reduces I/O contention and simplifies backup size estimation. The `walStorage` field provisions a dedicated PVC mounted at `/var/lib/postgresql/wal`.

### Anti-Affinity Configuration

Setting `podAntiAffinityType: required` ensures no two PostgreSQL pods land on the same node. For clusters spanning availability zones, extend the topology key:

```yaml
affinity:
  enablePodAntiAffinity: true
  topologyKey: topology.kubernetes.io/zone
  podAntiAffinityType: preferred
  additionalPodAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          cnpg.io/cluster: pg-prod
      topologyKey: kubernetes.io/hostname
```

### Creating Credentials Secrets

```bash
# Superuser secret
kubectl -n database create secret generic pg-prod-superuser \
  --from-literal=username=postgres \
  --from-literal=password="$(openssl rand -base64 32)"

# Application user secret
kubectl -n database create secret generic pg-prod-app-credentials \
  --from-literal=username=appuser \
  --from-literal=password="$(openssl rand -base64 32)"
```

---

## Section 3: Automated Failover with pg_rewind

CloudNativePG performs automated failover when the primary instance becomes unavailable. The operator uses `pg_rewind` to reconcile the former primary's timeline before rejoining it as a replica, preventing split-brain scenarios.

### Failover Process

1. The operator detects the primary pod is not responding to health checks (typically within 30–60 seconds depending on `livenessProbe` settings).
2. The operator selects the most advanced replica (highest LSN) as the new primary.
3. The selected replica is promoted using `pg_ctl promote`.
4. The `<cluster-name>-rw` service selector is updated to the new primary's pod.
5. The old primary pod is terminated and rescheduled.
6. On restart, `pg_rewind` synchronizes the old primary's data directory against the new primary before replay begins.

### Monitoring Failover Events

```bash
# Watch cluster status during failover
kubectl -n database get cluster pg-prod -w

# View operator events
kubectl -n database get events \
  --field-selector involvedObject.name=pg-prod \
  --sort-by='.lastTimestamp'

# Check instance roles
kubectl -n database get pods -l cnpg.io/cluster=pg-prod \
  -o custom-columns='NAME:.metadata.name,ROLE:.metadata.labels.cnpg\.io/instanceRole'
```

### Switchover (Planned Failover)

For maintenance operations, use a controlled switchover rather than waiting for failure detection:

```bash
# Install the cnpg kubectl plugin
kubectl krew install cnpg

# Promote a specific replica to primary
kubectl cnpg promote pg-prod pg-prod-2 -n database

# Or trigger a generic switchover
kubectl cnpg switchover pg-prod -n database
```

### Synchronous Replication

For zero data loss configurations, configure synchronous replication:

```yaml
spec:
  postgresql:
    synchronous:
      method: quorum
      number: 1
```

This sets `synchronous_standby_names = 'ANY 1 (*)'` in `postgresql.conf`. Note that synchronous replication increases write latency; measure the impact before enabling in production.

---

## Section 4: WAL Archiving and Backup to S3/GCS

CloudNativePG uses Barman Cloud utilities (`barman-cloud-wal-archive`, `barman-cloud-backup`) for continuous WAL archiving and base backups. Archived WALs are the foundation for point-in-time recovery.

### S3 Backup Configuration

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-prod
  namespace: database
spec:
  # ... cluster config above ...

  backup:
    retentionPolicy: "30d"
    barmanObjectStore:
      destinationPath: "s3://my-pg-backups/pg-prod"
      s3Credentials:
        accessKeyId:
          name: s3-backup-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: s3-backup-credentials
          key: SECRET_ACCESS_KEY
        region:
          name: s3-backup-credentials
          key: AWS_REGION
      wal:
        compression: gzip
        maxParallel: 8
      data:
        compression: gzip
        immediateCheckpoint: false
        jobs: 4
```

Create the S3 credentials secret:

```bash
kubectl -n database create secret generic s3-backup-credentials \
  --from-literal=ACCESS_KEY_ID="<your-access-key>" \
  --from-literal=SECRET_ACCESS_KEY="<your-secret-key>" \
  --from-literal=AWS_REGION="us-east-1"
```

### Using IAM Roles for Service Accounts (IRSA) on EKS

On EKS, avoid long-lived credentials by using IRSA:

```yaml
spec:
  backup:
    barmanObjectStore:
      destinationPath: "s3://my-pg-backups/pg-prod"
      s3Credentials:
        inheritFromIAMRole: true
      wal:
        compression: gzip
```

Annotate the service account:

```bash
kubectl -n database annotate serviceaccount pg-prod \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/cnpg-s3-backup-role
```

### GCS Backup Configuration

```yaml
spec:
  backup:
    barmanObjectStore:
      destinationPath: "gs://my-pg-backups/pg-prod"
      googleCredentials:
        applicationCredentials:
          name: gcs-backup-credentials
          key: credentials.json
        gkeEnvironment: false
      wal:
        compression: gzip
```

### Scheduled Backups

The `ScheduledBackup` resource triggers base backups on a cron schedule:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: pg-prod-daily
  namespace: database
spec:
  schedule: "0 2 * * *"
  backupOwnerReference: self
  cluster:
    name: pg-prod
  target: prefer-standby
  method: barmanObjectStore
```

Setting `target: prefer-standby` runs the backup from a replica, reducing I/O impact on the primary.

### Triggering an On-Demand Backup

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: pg-prod-manual-20270624
  namespace: database
spec:
  method: barmanObjectStore
  cluster:
    name: pg-prod
  target: prefer-standby
```

```bash
kubectl apply -f backup-manual.yaml
kubectl -n database get backup pg-prod-manual-20270624 -w
```

---

## Section 5: Point-in-Time Recovery

PITR restores a cluster to a specific timestamp by replaying archived WAL segments on top of a base backup. CloudNativePG performs PITR by bootstrapping a new cluster from an existing backup store.

### PITR Bootstrap Configuration

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-prod-restored
  namespace: database
spec:
  instances: 1

  storage:
    size: 100Gi
    storageClass: gp3-encrypted

  walStorage:
    size: 20Gi
    storageClass: gp3-encrypted

  bootstrap:
    recovery:
      source: pg-prod-backup
      recoveryTarget:
        targetTime: "2027-06-24 01:30:00"
        # targetLSN: "0/5000060"
        # targetXID: "12345"
        # targetName: "pre-migration"

  externalClusters:
  - name: pg-prod-backup
    barmanObjectStore:
      destinationPath: "s3://my-pg-backups/pg-prod"
      s3Credentials:
        accessKeyId:
          name: s3-backup-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: s3-backup-credentials
          key: SECRET_ACCESS_KEY
        region:
          name: s3-backup-credentials
          key: AWS_REGION
      wal:
        maxParallel: 8
```

### Recovery Targets

CloudNativePG supports four recovery target types:

| Target Type | Example | Description |
|---|---|---|
| `targetTime` | `"2027-06-24 01:30:00"` | Recover to a specific timestamp |
| `targetLSN` | `"0/5000060"` | Recover to a specific WAL location |
| `targetXID` | `"12345"` | Recover to a specific transaction ID |
| `targetName` | `"pre-migration"` | Recover to a named restore point |

### Validating Recovery

```bash
# Monitor recovery progress
kubectl -n database get cluster pg-prod-restored -w

# Connect and verify data
kubectl -n database exec -it pg-prod-restored-1 -- \
  psql -U postgres -c "SELECT pg_is_in_recovery(), now();"

# Check current LSN after recovery
kubectl -n database exec -it pg-prod-restored-1 -- \
  psql -U postgres -c "SELECT pg_current_wal_lsn();"
```

---

## Section 6: Connection Pooling with PgBouncer

CloudNativePG provides a native `Pooler` CRD that deploys PgBouncer as a Kubernetes Deployment fronting the cluster. This avoids the overhead of per-connection process spawning in PostgreSQL.

### Pooler Configuration

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: pg-prod-pooler-rw
  namespace: database
spec:
  cluster:
    name: pg-prod
  instances: 3
  type: rw

  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "1000"
      default_pool_size: "25"
      reserve_pool_size: "5"
      reserve_pool_timeout: "5"
      server_idle_timeout: "600"
      client_idle_timeout: "0"
      server_connect_timeout: "15"
      server_login_retry: "15"
      query_wait_timeout: "120"
      client_login_timeout: "60"
      autodb_idle_timeout: "3600"
      log_connections: "0"
      log_disconnections: "0"
      log_pooler_errors: "1"
      stats_period: "60"
      ignore_startup_parameters: "extra_float_digits"

  template:
    spec:
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
        limits:
          cpu: "500m"
          memory: "256Mi"
```

### Read-Only Pooler

Create a separate pooler for read replicas:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: pg-prod-pooler-ro
  namespace: database
spec:
  cluster:
    name: pg-prod
  instances: 2
  type: ro

  pgbouncer:
    poolMode: session
    parameters:
      max_client_conn: "500"
      default_pool_size: "20"
```

### Pool Mode Selection

| Mode | Use Case | Caveat |
|---|---|---|
| `transaction` | Most web applications, ORM frameworks | Cannot use session-level features (prepared statements, advisory locks) |
| `session` | Applications using SET, prepared statements | One server connection per client connection |
| `statement` | Autocommit-only workloads | Transactions spanning multiple statements are not supported |

### Connecting Through PgBouncer

```bash
# Get the pooler service endpoint
kubectl -n database get svc pg-prod-pooler-rw

# Test connection
kubectl -n database exec -it pg-prod-pooler-rw-<pod> -- \
  psql -h pg-prod-pooler-rw -p 5432 -U appuser -d appdb -c "SHOW pools;"
```

---

## Section 7: Monitoring with PodMonitor and Grafana

CloudNativePG exposes Prometheus metrics on port 9187 via the built-in PostgreSQL exporter. When `monitoring.enablePodMonitor: true` is set on the cluster, a `PodMonitor` resource is created automatically.

### Metrics Exposed

Key metrics available from CloudNativePG:

```
# Cluster health
cnpg_collector_up
cnpg_collector_postgres_version

# Replication lag
cnpg_collector_pg_replication_lag
cnpg_collector_pg_replication_in_recovery

# Database size
cnpg_collector_pg_database_size_bytes

# Connections
cnpg_collector_backends_total
cnpg_collector_backends_waiting_total

# WAL
cnpg_collector_pg_stat_bgwriter_checkpoint_write_time_total
cnpg_collector_pg_wal_current_lsn

# Cache hit ratio
cnpg_collector_pg_stat_user_tables_seq_tup_read_total
cnpg_collector_pg_stat_user_tables_idx_tup_fetch_total

# Locks
cnpg_collector_pg_locks_count

# Autovacuum
cnpg_collector_pg_stat_user_tables_last_autovacuum
cnpg_collector_pg_stat_user_tables_n_dead_tup
```

### Custom PodMonitor

If the automatic PodMonitor needs adjustment (e.g., adding labels for your Prometheus selector):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: pg-prod
  namespace: database
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      cnpg.io/cluster: pg-prod
  podMetricsEndpoints:
  - port: metrics
    interval: 30s
    scrapeTimeout: 25s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_label_cnpg_io_instanceRole]
      targetLabel: role
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
```

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cnpg-alerts
  namespace: database
spec:
  groups:
  - name: cloudnativepg
    rules:
    - alert: CNPGClusterNotHealthy
      expr: cnpg_collector_up == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "CloudNativePG cluster {{ $labels.cluster }} is not healthy"
        description: "The CloudNativePG collector for cluster {{ $labels.cluster }} has been down for 5 minutes."

    - alert: CNPGReplicationLagHigh
      expr: cnpg_collector_pg_replication_lag > 300
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Replication lag high on {{ $labels.pod }}"
        description: "Replication lag is {{ $value }}s on pod {{ $labels.pod }}."

    - alert: CNPGHighConnectionUsage
      expr: |
        cnpg_collector_backends_total /
        cnpg_collector_pg_settings_max_connections > 0.8
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High connection usage on {{ $labels.cluster }}"
        description: "Connection pool is {{ $value | humanizePercentage }} utilized."

    - alert: CNPGDeadTuplesHigh
      expr: cnpg_collector_pg_stat_user_tables_n_dead_tup > 1000000
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "High dead tuples on {{ $labels.cluster }}"
        description: "Table {{ $labels.relname }} has {{ $value }} dead tuples."
```

### Grafana Dashboard

Import the official CloudNativePG dashboard (ID: 20423) into Grafana, or deploy it via ConfigMap:

```bash
kubectl -n monitoring create configmap cnpg-dashboard \
  --from-file=cnpg-dashboard.json \
  --dry-run=client -o yaml | \
  kubectl label --local -f - grafana_dashboard=1 -o yaml | \
  kubectl apply -f -
```

---

## Section 8: Rolling Updates and Major Version Upgrades

### Minor Version Updates

CloudNativePG handles minor version updates (e.g., 16.1 to 16.2) through rolling restarts. Update the image reference in the Cluster spec:

```yaml
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3
```

With `primaryUpdateStrategy: unsupervised`, the operator automatically performs:
1. Restart all replicas one by one
2. Switchover the primary to an already-updated replica
3. Restart the old primary as a replica

### Monitoring Update Progress

```bash
# Watch the rolling update
kubectl -n database get cluster pg-prod -w

# Check image versions per pod
kubectl -n database get pods -l cnpg.io/cluster=pg-prod \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

### In-Place Minor Upgrade Example

```bash
# Patch the cluster image
kubectl -n database patch cluster pg-prod \
  --type=merge \
  -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:16.4"}}'

# Observe the switchover event
kubectl -n database get events --sort-by='.lastTimestamp' | grep pg-prod
```

### Major Version Upgrades

Major version upgrades (e.g., PostgreSQL 15 to 16) require a new cluster bootstrapped from the existing one via `pg_upgrade` or logical replication. The recommended approach is to create a new cluster with the new major version and bootstrap it from the old cluster using logical replication through the `externalClusters` mechanism with publication/subscription pairs.

---

## Section 9: Troubleshooting Common Issues

### Diagnosing Cluster Status

```bash
# Get full cluster status
kubectl -n database describe cluster pg-prod

# Check operator logs
kubectl -n cnpg-system logs deployment/cnpg-controller-manager -f

# Check instance manager logs on a specific pod
kubectl -n database logs pg-prod-1 -c postgres

# Exec into a pod for manual inspection
kubectl -n database exec -it pg-prod-1 -- bash
psql -U postgres -c "SELECT * FROM pg_stat_replication;"
psql -U postgres -c "SELECT * FROM pg_replication_slots;"
```

### WAL Archiving Failures

```bash
# Check WAL archiving status
kubectl -n database exec -it pg-prod-1 -- \
  psql -U postgres -c "SELECT * FROM pg_stat_archiver;"

# Check barman-cloud-wal-archive logs
kubectl -n database logs pg-prod-1 -c postgres | grep barman
```

Common causes of WAL archiving failures:
- Incorrect S3/GCS credentials
- Bucket permissions missing for the IAM role
- Network connectivity to object storage endpoint
- Insufficient disk space causing WAL accumulation

### Replication Slot Bloat

```bash
# Check replication slot usage
kubectl -n database exec -it pg-prod-1 -- \
  psql -U postgres -c "
  SELECT slot_name, active, restart_lsn,
         pg_size_pretty(
           pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
         ) AS retained_wal
  FROM pg_replication_slots
  ORDER BY retained_wal DESC;"
```

Drop inactive slots that are blocking WAL cleanup:

```bash
kubectl -n database exec -it pg-prod-1 -- \
  psql -U postgres -c "SELECT pg_drop_replication_slot('stale_slot_name');"
```

### Recovering from a Failed Cluster

If the operator marks a cluster as needing manual intervention:

```bash
# Check cluster conditions
kubectl -n database get cluster pg-prod \
  -o jsonpath='{.status.conditions}' | jq .

# Force re-reconciliation
kubectl -n database annotate cluster pg-prod \
  cnpg.io/reconcile-now="$(date +%s)" --overwrite
```

---

## Section 10: Production Hardening Checklist

Before running CloudNativePG in production, validate the following:

```bash
# 1. Verify all pods are on separate nodes
kubectl -n database get pods -l cnpg.io/cluster=pg-prod \
  -o wide | awk '{print $7}' | sort | uniq -d

# 2. Confirm WAL archiving is active
kubectl -n database exec -it pg-prod-1 -- \
  psql -U postgres -c "
  SELECT archived_count, failed_count, last_archived_wal,
         last_failed_wal, last_archived_time, last_failed_time
  FROM pg_stat_archiver;"

# 3. List recent backups
kubectl -n database get backup -l cnpg.io/cluster=pg-prod \
  --sort-by='.metadata.creationTimestamp'

# 4. Verify PgBouncer health
kubectl -n database exec -it pg-prod-pooler-rw-0 -- \
  psql -p 5432 -U pgbouncer pgbouncer -c "SHOW STATS;"

# 5. Confirm monitoring is scraping
kubectl -n database get podmonitor pg-prod -o yaml

# 6. Test failover in staging (do not run on production primary)
kubectl cnpg switchover pg-prod -n staging

# 7. Verify PITR restore capability (in isolated environment)
kubectl apply -f pitr-test-cluster.yaml
```

### Resource Sizing Guidelines

| Workload Type | Instances | CPU Request | Memory Request | Storage |
|---|---|---|---|---|
| Development | 1 | 0.5 | 1Gi | 20Gi |
| Small Production | 3 | 2 | 4Gi | 100Gi |
| Medium Production | 3 | 4 | 8Gi | 500Gi |
| Large Production | 3+ | 8 | 16Gi | 1Ti+ |

Always set `shared_buffers` to 25% of available memory and `effective_cache_size` to 75%.

CloudNativePG represents a mature, CNCF-backed approach to running PostgreSQL on Kubernetes. Its tight integration with the Kubernetes API, native Barman Cloud support, and automated failover with `pg_rewind` make it the preferred operator for production PostgreSQL workloads on Kubernetes platforms.
