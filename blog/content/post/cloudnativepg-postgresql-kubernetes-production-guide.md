---
title: "CloudNativePG: Production PostgreSQL Operator on Kubernetes"
date: 2027-03-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PostgreSQL", "CloudNativePG", "Database", "Operator"]
categories: ["Kubernetes", "Databases", "Operators"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise deployment guide for CloudNativePG PostgreSQL operator on Kubernetes, covering Cluster CRD configuration, streaming replication, automated failover, backup to S3 with Barman, point-in-time recovery, connection pooling with PgBouncer, and Prometheus monitoring."
more_link: "yes"
url: "/cloudnativepg-postgresql-kubernetes-production-guide/"
---

CloudNativePG is the only PostgreSQL operator designed from the ground up to run natively on Kubernetes, developed and maintained by EDB. Unlike operators that wrap an existing PostgreSQL HA tool like Patroni, CloudNativePG uses the Kubernetes control plane itself as the distributed consensus and state management layer. The result is a leaner, more Kubernetes-idiomatic operator that maps PostgreSQL concepts directly to Kubernetes primitives: Pods carry PostgreSQL instances, PVCs hold data volumes, Services expose read/write and read-only endpoints, and the operator reconciles the desired state expressed in a single `Cluster` custom resource.

This guide covers a full production deployment: operator installation, `Cluster` CRD configuration, streaming replication modes, WAL archiving and S3 backup via Barman Cloud, point-in-time recovery, the PgBouncer `Pooler` CRD, TLS certificate management, Prometheus monitoring, rolling updates, and major version upgrades.

<!--more-->

## Section 1: Architecture Overview

CloudNativePG runs as a single operator Deployment in a dedicated namespace. It manages `Cluster`, `Backup`, `ScheduledBackup`, `Pooler`, and `ImageCatalog` custom resources cluster-wide.

### Component Roles

```
┌─────────────────────────────────────────────────────────────┐
│  Kubernetes Control Plane                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  cloudnative-pg operator (Deployment, 1 replica)      │  │
│  │  - Reconciles Cluster CRD                             │  │
│  │  - Manages Pod identity and primary election          │  │
│  │  - Triggers backups via ScheduledBackup               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  Per-Cluster Resources                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  pg-1    │  │  pg-2    │  │  pg-3    │                  │
│  │ Primary  │  │ Replica  │  │ Replica  │  (StatefulSet-   │
│  │ Pod      │  │ Pod      │  │ Pod      │   like semantics) │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       │WAL stream   │             │                         │
│  ┌────▼──────────────────────────▼─────────────────────┐   │
│  │  Streaming Replication (pg_basebackup / WAL sender)  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Services                                                    │
│  pg-cluster-rw  → primary (read-write)                      │
│  pg-cluster-ro  → replicas (read-only, load-balanced)       │
│  pg-cluster-r   → any instance                              │
└─────────────────────────────────────────────────────────────┘
```

Each PostgreSQL instance runs as a single container inside a Pod. The operator injects a bootstrap container that initialises the cluster on first start or recovers from a backup. The primary election is managed through a lease mechanism: the operator grants a lease to exactly one Pod, which then promotes itself to primary.

### Networking Model

Three `ClusterIP` Services are created per `Cluster`:

- `<cluster>-rw`: Always points to the current primary. Applications performing writes connect here.
- `<cluster>-ro`: Points to replicas only, used for read-scaling.
- `<cluster>-r`: Points to all instances; useful for administrative connections.

After a failover the operator updates the selector labels on `<cluster>-rw` to point to the newly promoted primary without any external involvement.

---

## Section 2: Operator Installation

### Prerequisites

```bash
# Verify cert-manager is installed (required for TLS)
kubectl get pods -n cert-manager

# Verify storage class with volumeBindingMode: WaitForFirstConsumer
kubectl get storageclass
```

### Install via Helm

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update

helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version 0.22.0 \
  --set monitoring.podMonitorEnabled=true \
  --set monitoring.grafanaDashboard.create=true \
  --wait
```

### Verify Operator Health

```bash
# Confirm operator Pod is running
kubectl get pods -n cnpg-system

# Confirm CRDs are registered
kubectl get crd | grep postgresql
# Expected output includes:
# clusters.postgresql.cnpg.io
# backups.postgresql.cnpg.io
# scheduledbackups.postgresql.cnpg.io
# poolers.postgresql.cnpg.io
```

### Install the cnpg kubectl Plugin

```bash
# Via Krew plugin manager
kubectl krew install cnpg

# Verify plugin
kubectl cnpg version
```

---

## Section 3: Cluster CRD Configuration

### Basic Three-Instance Cluster

```yaml
# cluster-production.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-production
  namespace: databases
spec:
  # Number of PostgreSQL instances (1 primary + N-1 replicas)
  instances: 3

  # PostgreSQL version (minor version managed by operator)
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  # PostgreSQL parameter tuning
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
      effective_cache_size: "1536MB"
      maintenance_work_mem: "128MB"
      checkpoint_completion_target: "0.9"
      wal_buffers: "16MB"
      default_statistics_target: "100"
      random_page_cost: "1.1"        # SSD-optimised
      effective_io_concurrency: "200"
      work_mem: "4MB"
      huge_pages: "off"
      min_wal_size: "1GB"
      max_wal_size: "4GB"
      max_worker_processes: "4"
      max_parallel_workers_per_gather: "2"
      max_parallel_workers: "4"
      wal_level: "logical"           # Required for logical replication / CDC
      hot_standby_feedback: "on"     # Prevent vacuum cancelling long queries on replica

    # pg_hba.conf additions (appended after operator-managed entries)
    pg_hba:
      - "host all all 10.0.0.0/8 scram-sha-256"
      - "hostssl replication replicator 10.0.0.0/8 scram-sha-256"

  # Primary storage
  storage:
    storageClass: premium-rwo        # ReadWriteOnce SSD storage class
    size: 100Gi

  # Separate WAL volume improves I/O isolation
  walStorage:
    storageClass: premium-rwo
    size: 20Gi

  # Bootstrap: initialise a new cluster from scratch
  bootstrap:
    initdb:
      database: appdb
      owner: appuser
      secret:
        name: pg-production-credentials  # Contains 'username' and 'password' keys
      encoding: "UTF8"
      localeCType: "en_US.UTF-8"
      localeCollate: "en_US.UTF-8"

  # Superuser secret (operator creates a 'postgres' superuser)
  superuserSecret:
    name: pg-production-superuser

  # Resource allocation
  resources:
    requests:
      cpu: "2"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "8Gi"

  # Pod affinity: spread instances across nodes
  affinity:
    topologyKey: kubernetes.io/hostname
    podAntiAffinityType: required    # Hard anti-affinity

  # Enable monitoring (creates ServiceMonitor)
  monitoring:
    enablePodMonitor: true
```

### Creating Required Secrets

```bash
# Application user credentials
kubectl create secret generic pg-production-credentials \
  --namespace databases \
  --from-literal=username=appuser \
  --from-literal=password='StrongAppPassword2024!'

# Superuser credentials
kubectl create secret generic pg-production-superuser \
  --namespace databases \
  --from-literal=username=postgres \
  --from-literal=password='StrongSuperuserPassword2024!'
```

### Apply and Verify

```bash
kubectl apply -f cluster-production.yaml

# Watch cluster initialise (takes 2-5 minutes)
kubectl cnpg status pg-production -n databases

# Check Pod status
kubectl get pods -n databases -l cnpg.io/cluster=pg-production
```

---

## Section 4: Streaming Replication Modes

CloudNativePG supports both asynchronous and synchronous replication, configurable at the `Cluster` level.

### Asynchronous Replication (Default)

In asynchronous mode, the primary commits transactions without waiting for replicas to confirm WAL receipt. This maximises write throughput at the cost of potential data loss in catastrophic failure scenarios.

```yaml
# No additional configuration needed — async is the default
spec:
  instances: 3
```

### Synchronous Replication

Synchronous replication ensures that at least one (or more) replicas have received and written WAL before the primary acknowledges a commit. This eliminates data loss at the cost of additional write latency.

```yaml
# cluster-sync.yaml (partial)
spec:
  instances: 3

  postgresql:
    synchronous:
      method: any           # 'any' = at least N replicas from the list
      number: 1             # At least 1 synchronous standby required
      maxStandbyDelay: 30   # Fall back to async if replica lags > 30 seconds
```

### Checking Replication Lag

```bash
# Connect to primary via the cnpg plugin
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
             write_lag, flush_lag, replay_lag, sync_state
      FROM pg_stat_replication;"
```

### Replica Slot Management

CloudNativePG automatically creates and manages replication slots to prevent WAL from being removed before replicas consume it.

```bash
# View replication slots on primary
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT slot_name, slot_type, active, restart_lsn FROM pg_replication_slots;"
```

---

## Section 5: WAL Archiving and S3 Backup with Barman Cloud

### Create S3 Credentials Secret

```bash
# AWS credentials for Barman Cloud backup
kubectl create secret generic pg-backup-s3-credentials \
  --namespace databases \
  --from-literal=ACCESS_KEY_ID=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME \
  --from-literal=ACCESS_SECRET_KEY=EXAMPLE_SECRET_KEY_REPLACE_ME
```

### Cluster with Backup Configuration

```yaml
# cluster-with-backup.yaml (partial)
spec:
  backup:
    # Barman Cloud configuration for S3
    barmanObjectStore:
      destinationPath: "s3://company-pg-backups/pg-production"
      endpointURL: "https://s3.us-east-1.amazonaws.com"  # Omit for default AWS endpoint

      s3Credentials:
        accessKeyId:
          name: pg-backup-s3-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: pg-backup-s3-credentials
          key: ACCESS_SECRET_KEY

      wal:
        compression: gzip             # Compress WAL files before uploading
        encryption: AES256            # Server-side encryption at rest
        maxParallel: 8                # Parallel WAL upload workers

      data:
        compression: gzip
        encryption: AES256
        immediateCheckpoint: false    # Do not force a checkpoint before backup
        jobs: 4                       # Parallel data upload workers

    # Retention policy: keep 30 days of backups
    retentionPolicy: "30d"
```

### ScheduledBackup CRD

```yaml
# scheduled-backup.yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: pg-production-daily
  namespace: databases
spec:
  # Cron schedule: daily at 02:00 UTC
  schedule: "0 2 * * *"

  backupOwnerReference: self

  cluster:
    name: pg-production

  # Target: prefer replica to reduce primary I/O
  target: PreferStandby

  method: barmanObjectStore
```

### Taking an On-Demand Backup

```bash
# Trigger an immediate backup
kubectl cnpg backup pg-production \
  --namespace databases \
  --backup-name pg-production-manual-$(date +%Y%m%d)

# List all backups
kubectl get backups -n databases

# Inspect a specific backup
kubectl describe backup pg-production-manual-20270323 -n databases
```

### Verifying WAL Archiving Status

```bash
# Check WAL archiving status from within the primary
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT last_archived_wal, last_archived_time,
             last_failed_wal, last_failed_time,
             archived_count, failed_count
      FROM pg_stat_archiver;"
```

---

## Section 6: Point-in-Time Recovery (PITR)

PITR allows restoring a cluster to any point in time covered by available WAL archives.

### PITR Recovery Cluster

```yaml
# pitr-recovery.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-production-pitr
  namespace: databases
spec:
  instances: 1                       # Start with 1 instance for recovery

  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  storage:
    storageClass: premium-rwo
    size: 100Gi

  walStorage:
    storageClass: premium-rwo
    size: 20Gi

  superuserSecret:
    name: pg-production-superuser

  # Bootstrap from PITR rather than initdb
  bootstrap:
    recovery:
      backup:
        name: pg-production-manual-20270323   # Named backup as the base

      # Recover to a specific timestamp
      recoveryTarget:
        targetTime: "2027-03-23T08:45:00+00:00"
        # Exclusive: stop BEFORE the target (do not apply the event at that exact LSN)
        exclusive: false

  # Point to the same object store as the source cluster
  externalClusters:
    - name: pg-production
      barmanObjectStore:
        destinationPath: "s3://company-pg-backups/pg-production"
        s3Credentials:
          accessKeyId:
            name: pg-backup-s3-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: pg-backup-s3-credentials
            key: ACCESS_SECRET_KEY
        wal:
          maxParallel: 8
```

### Monitor Recovery Progress

```bash
# Watch recovery cluster status
kubectl cnpg status pg-production-pitr -n databases

# Stream logs from the recovery Pod
kubectl logs -n databases -l cnpg.io/cluster=pg-production-pitr -f

# Verify recovery timestamp after cluster becomes ready
kubectl cnpg psql pg-production-pitr -n databases -- \
  -c "SELECT pg_is_in_recovery(), now();"
```

### Promote Recovery Cluster

Once the recovery cluster is validated, it can be promoted to primary and scaled up to the desired number of instances by updating the `Cluster` spec.

```bash
# Scale up recovered cluster
kubectl patch cluster pg-production-pitr -n databases \
  --type merge \
  --patch '{"spec":{"instances":3}}'
```

---

## Section 7: PgBouncer Connection Pooler

CloudNativePG provides a `Pooler` CRD that deploys PgBouncer as a connection pooler in front of the PostgreSQL cluster.

### Pooler CRD for Read-Write Traffic

```yaml
# pooler-rw.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: pg-production-pooler-rw
  namespace: databases
spec:
  cluster:
    name: pg-production

  # Route pooled connections to the primary
  type: rw

  # Number of PgBouncer Pods
  instances: 2

  pgbouncer:
    # Pool mode: transaction (recommended for most web applications)
    poolMode: transaction

    parameters:
      max_client_conn: "1000"         # Max incoming client connections
      default_pool_size: "25"         # Server connections per database/user pair
      min_pool_size: "5"
      reserve_pool_size: "5"
      reserve_pool_timeout: "5"
      max_db_connections: "200"       # Total server connections cap
      max_user_connections: "200"
      server_idle_timeout: "600"
      client_idle_timeout: "0"
      log_connections: "0"
      log_disconnections: "0"
      log_pooler_errors: "1"

  # Resource limits for PgBouncer Pods
  resources:
    requests:
      cpu: "250m"
      memory: "128Mi"
    limits:
      cpu: "1"
      memory: "256Mi"
```

### Pooler CRD for Read-Only Traffic

```yaml
# pooler-ro.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: pg-production-pooler-ro
  namespace: databases
spec:
  cluster:
    name: pg-production

  # Route pooled connections to replicas
  type: ro

  instances: 2

  pgbouncer:
    poolMode: transaction

    parameters:
      max_client_conn: "2000"
      default_pool_size: "50"
      min_pool_size: "10"
```

### Connection Strings for Applications

```bash
# Read-write via PgBouncer
# Host: pg-production-pooler-rw.<namespace>.svc.cluster.local:5432

# Read-only via PgBouncer
# Host: pg-production-pooler-ro.<namespace>.svc.cluster.local:5432

# Direct to primary (bypassing pooler, for admin work)
# Host: pg-production-rw.<namespace>.svc.cluster.local:5432
```

---

## Section 8: TLS Certificate Management

CloudNativePG generates a self-signed CA and server certificates by default. For production, integrate with cert-manager to use a trusted CA.

### cert-manager Integration

```yaml
# pg-tls-issuer.yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: pg-selfsigned-issuer
  namespace: databases
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: pg-ca-cert
  namespace: databases
spec:
  isCA: true
  commonName: pg-production-ca
  secretName: pg-production-ca-secret
  duration: 87600h    # 10 years
  renewBefore: 720h   # Renew 30 days before expiry
  subject:
    organizations:
      - "company.internal"
  issuerRef:
    name: pg-selfsigned-issuer
    kind: Issuer
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: pg-ca-issuer
  namespace: databases
spec:
  ca:
    secretName: pg-production-ca-secret
```

### Reference CA in Cluster Spec

```yaml
# cluster-tls.yaml (partial)
spec:
  certificates:
    serverCASecret: pg-production-ca-secret      # CA used to sign server cert
    serverTLSSecret: pg-production-server-tls    # Generated server cert/key
    replicationTLSSecret: pg-production-repl-tls # Replication client cert
    clientCASecret: pg-production-ca-secret      # CA for client cert auth
    serverAltDNSNames:
      - "pg-production-rw.databases.svc.cluster.local"
      - "pg-production-ro.databases.svc.cluster.local"
      - "pg-production-pooler-rw.databases.svc.cluster.local"
```

### Verify TLS Connection

```bash
# Test TLS connection from a debug Pod
kubectl run pg-tls-test \
  --image=postgres:16 \
  --rm -it \
  --restart=Never \
  -- psql \
    "host=pg-production-rw.databases.svc.cluster.local \
     dbname=appdb \
     user=appuser \
     sslmode=verify-full \
     sslrootcert=/etc/ssl/certs/ca-certificates.crt"
```

---

## Section 9: Prometheus Monitoring

### ServiceMonitor for Operator Metrics

```yaml
# cnpg-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cnpg-operator
  namespace: cnpg-system
  labels:
    app.kubernetes.io/name: cloudnative-pg
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cloudnative-pg
  namespaceSelector:
    matchNames:
      - cnpg-system
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### PodMonitor for Per-Instance Metrics

CloudNativePG exposes PostgreSQL metrics via an integrated exporter on port 9187 of each PostgreSQL Pod.

```yaml
# pg-pod-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: pg-production-metrics
  namespace: databases
  labels:
    release: kube-prometheus-stack   # Match Prometheus operator selector
spec:
  selector:
    matchLabels:
      cnpg.io/cluster: pg-production
  namespaceSelector:
    matchNames:
      - databases
  podMetricsEndpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_cnpg_io_instanceRole]
          targetLabel: role
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
```

### Key Prometheus Alerting Rules

```yaml
# pg-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cloudnativepg-alerts
  namespace: databases
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: cloudnativepg
      interval: 30s
      rules:
        # Primary is unavailable
        - alert: CNPGPrimaryNotReady
          expr: |
            cnpg_pg_replication_in_recovery == 1
            and on(pod) kube_pod_status_ready{condition="true"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "CloudNativePG primary Pod {{ $labels.pod }} not ready"
            description: "The primary PostgreSQL Pod has been not-ready for more than 2 minutes."

        # Replication lag exceeds threshold
        - alert: CNPGReplicationLagHigh
          expr: |
            cnpg_pg_replication_lag > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL replication lag high on {{ $labels.pod }}"
            description: "Replica {{ $labels.pod }} is {{ $value }}s behind the primary."

        # WAL archiving failures
        - alert: CNPGWALArchivingFailing
          expr: |
            increase(cnpg_pg_stat_archiver_failed_count[10m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "WAL archiving failures on {{ $labels.pod }}"
            description: "{{ $value }} WAL files failed to archive in the last 10 minutes."

        # Connection count approaching max_connections
        - alert: CNPGConnectionExhaustion
          expr: |
            cnpg_pg_stat_activity_count / cnpg_pg_settings_max_connections > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL connections near limit on {{ $labels.pod }}"
            description: "{{ $value | humanizePercentage }} of max_connections in use."

        # Backup not completed in 25 hours
        - alert: CNPGBackupStale
          expr: |
            time() - cnpg_backup_last_success_timestamp > 90000
          labels:
            severity: critical
          annotations:
            summary: "PostgreSQL backup stale for cluster {{ $labels.cluster }}"
            description: "Last successful backup was more than 25 hours ago."
```

---

## Section 10: Rolling Updates and Minor Version Upgrades

CloudNativePG performs rolling updates with zero downtime by updating replicas first, then triggering a controlled switchover before updating the old primary.

### Trigger a Minor Version Update

```bash
# Update the image in the Cluster spec
kubectl patch cluster pg-production -n databases \
  --type merge \
  --patch '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:16.4"}}'

# Watch the rolling update progress
kubectl cnpg status pg-production -n databases --watch

# The operator will:
# 1. Delete replica Pods one-by-one, pulling the new image
# 2. Perform a switchover: promote a replica to primary
# 3. Update the old primary Pod
```

### Rolling Update with the cnpg Plugin

```bash
# Initiate a manual switchover (useful for maintenance)
kubectl cnpg promote pg-production pg-production-2 -n databases

# Check current primary
kubectl cnpg status pg-production -n databases | grep -i primary
```

---

## Section 11: Major Version Upgrades

Major PostgreSQL version upgrades (e.g., 15 to 16) require a different approach because `pg_upgrade` must run. CloudNativePG performs in-place major upgrades via the `pg_upgrade` process.

### Pre-Upgrade Checklist

```bash
# 1. Verify all extensions are compatible with target version
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT name, installed_version, default_version FROM pg_available_extensions
      WHERE installed_version IS NOT NULL
      ORDER BY name;"

# 2. Run pg_upgrade dry-run check (outside cluster, in a test container)
kubectl run pg-upgrade-check \
  --image=ghcr.io/cloudnative-pg/postgresql:16.3 \
  --restart=Never \
  --rm -it \
  -- pg_upgrade \
    --old-datadir=/var/lib/postgresql/data \
    --new-datadir=/tmp/new-data \
    --old-bindir=/usr/lib/postgresql/15/bin \
    --new-bindir=/usr/lib/postgresql/16/bin \
    --check

# 3. Take a full on-demand backup before upgrade
kubectl cnpg backup pg-production \
  --namespace databases \
  --backup-name pg-production-pre-upgrade-$(date +%Y%m%d)
```

### Perform the Major Upgrade

```bash
# Update the imageName to the new major version
# CloudNativePG detects the major version change and uses pg_upgrade
kubectl patch cluster pg-production -n databases \
  --type merge \
  --patch '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:16.3"}}'

# Monitor upgrade logs
kubectl logs -n databases -l cnpg.io/cluster=pg-production -c postgres -f
```

### Post-Upgrade Tasks

```bash
# Run ANALYZE on all databases after major upgrade
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT datname FROM pg_database WHERE datallowconn = true;" \
  | tail -n +3 | head -n -2 \
  | xargs -I{} kubectl cnpg psql pg-production -n databases -- \
    -d {} -c "ANALYZE;"

# Verify all extensions updated correctly
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT name, installed_version, default_version FROM pg_available_extensions
      WHERE installed_version IS NOT NULL;"
```

---

## Section 12: Operational Runbooks

### Runbook: Manual Failover

```bash
# Force a switchover to a named replica
kubectl cnpg promote pg-production pg-production-2 -n databases

# Verify the new primary
kubectl cnpg status pg-production -n databases
kubectl get pods -n databases -l cnpg.io/cluster=pg-production,cnpg.io/instanceRole=primary
```

### Runbook: Pause and Resume the Cluster

```bash
# Pause the cluster (stops all reconciliation, useful for emergency maintenance)
kubectl patch cluster pg-production -n databases \
  --type merge \
  --patch '{"spec":{"overrideConfiguration":{"stopDelay":300}}}'

# Hibernate (scales down all Pods, preserving PVCs)
kubectl cnpg hibernate on pg-production -n databases

# Resume from hibernation
kubectl cnpg hibernate off pg-production -n databases
```

### Runbook: Fencing a Node

Fencing prevents a PostgreSQL Pod on a suspect node from writing to storage while the operator promotes a new primary.

```bash
# Fence a specific instance
kubectl cnpg fencing on pg-production pg-production-3 -n databases

# List fenced instances
kubectl cnpg status pg-production -n databases | grep -i fenc

# Remove fence after node issue is resolved
kubectl cnpg fencing off pg-production pg-production-3 -n databases
```

### Runbook: Storage Expansion

```bash
# Expand PVC for all instances (requires storage class to support volume expansion)
kubectl patch cluster pg-production -n databases \
  --type merge \
  --patch '{"spec":{"storage":{"size":"200Gi"}}}'

# Verify PVC expansion
kubectl get pvc -n databases -l cnpg.io/cluster=pg-production
```

### Runbook: Checking Database Size

```bash
# Database and table sizes
kubectl cnpg psql pg-production -n databases -- \
  -c "SELECT datname,
             pg_size_pretty(pg_database_size(datname)) AS size
      FROM pg_database
      ORDER BY pg_database_size(datname) DESC;"

# Largest tables in appdb
kubectl cnpg psql pg-production -n databases -d appdb -- \
  -c "SELECT schemaname, tablename,
             pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size
      FROM pg_tables
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
      LIMIT 20;"
```

---

## Section 13: Multi-Namespace and Multi-Cluster Patterns

### Deploying Clusters Across Multiple Namespaces

The CloudNativePG operator can be configured to watch all namespaces or a specific set.

```bash
# Install operator watching specific namespaces only
helm upgrade cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --set watchNamespaces="{databases,analytics,reporting}"
```

### Cross-Namespace Backup Restore

```yaml
# restore-cross-namespace.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-analytics
  namespace: analytics            # Different namespace from source
spec:
  instances: 2
  imageName: ghcr.io/cloudnative-pg/postgresql:16.3

  storage:
    storageClass: premium-rwo
    size: 200Gi

  bootstrap:
    recovery:
      source: pg-production       # Reference to externalClusters entry

  externalClusters:
    - name: pg-production
      barmanObjectStore:
        destinationPath: "s3://company-pg-backups/pg-production"
        s3Credentials:
          accessKeyId:
            name: pg-backup-s3-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: pg-backup-s3-credentials
            key: ACCESS_SECRET_KEY
```

---

## Section 14: Security Hardening

### Pod Security Context

```yaml
# cluster-security.yaml (partial)
spec:
  # Override default Pod security context
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 26                   # PostgreSQL uid in official images
    fsGroup: 26
    seccompProfile:
      type: RuntimeDefault

  # Container security context
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - ALL
    readOnlyRootFilesystem: true
```

### NetworkPolicy for Database Isolation

```yaml
# pg-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: pg-production-allow
  namespace: databases
spec:
  podSelector:
    matchLabels:
      cnpg.io/cluster: pg-production
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow PostgreSQL from application namespaces
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: application
      ports:
        - protocol: TCP
          port: 5432
    # Allow metrics scraping from monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 9187
  egress:
    # Allow inter-cluster replication
    - to:
        - podSelector:
            matchLabels:
              cnpg.io/cluster: pg-production
      ports:
        - protocol: TCP
          port: 5432
    # Allow S3 backup uploads
    - to: []
      ports:
        - protocol: TCP
          port: 443
    # Allow DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
```

---

## Section 15: Resource Planning and Sizing Reference

### Sizing Guidelines

The following table provides baseline sizing for common workload tiers. Adjust based on observed `shared_buffers` hit rate (target > 99%) and connection patterns.

```
Workload Tier | CPU Request | CPU Limit | Memory Request | Memory Limit | Storage
------------- | ----------- | --------- | -------------- | ------------ | -------
Development   | 0.5         | 1         | 512Mi          | 1Gi          | 10Gi
Small Prod    | 1           | 2         | 2Gi            | 4Gi          | 50Gi
Medium Prod   | 2           | 4         | 4Gi            | 8Gi          | 100Gi
Large Prod    | 4           | 8         | 8Gi            | 16Gi         | 500Gi
XL Prod       | 8           | 16        | 16Gi           | 32Gi         | 2Ti
```

### PostgreSQL Parameter Scaling Rule of Thumb

```bash
# shared_buffers: 25% of total memory (up to 8GB for most workloads)
# effective_cache_size: 75% of total memory
# work_mem: (total_memory / max_connections / 4) — conservative estimate
# maintenance_work_mem: 5-10% of total memory, capped at 2GB
# max_connections: use PgBouncer, keep this value ≤ 200

# Example for 8Gi memory, 200 max_connections:
# shared_buffers = 2GB
# effective_cache_size = 6GB
# work_mem = 8192MB / 200 / 4 = 10MB
# maintenance_work_mem = 512MB
```

---

CloudNativePG represents the most Kubernetes-native approach to running production PostgreSQL. By mapping cluster topology, failover, backup, and monitoring to Kubernetes primitives, it eliminates the need for an external HA coordinator and integrates cleanly with the broader cloud-native ecosystem. The combination of automated WAL archiving, PITR, PgBouncer connection pooling, and Prometheus observability provides a complete production-grade data layer on Kubernetes without reaching for external tooling.
