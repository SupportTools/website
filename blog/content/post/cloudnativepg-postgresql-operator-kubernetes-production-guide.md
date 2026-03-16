---
title: "CloudNativePG: Production PostgreSQL on Kubernetes with the CNPG Operator"
date: 2026-12-21T00:00:00-05:00
draft: false
tags: ["CloudNativePG", "PostgreSQL", "Kubernetes", "Database Operator", "High Availability", "Backup", "Production"]
categories:
- Databases
- Kubernetes
- Production Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to CloudNativePG operator: cluster configuration, streaming replication, automated backups with Barman, point-in-time recovery, connection pooling with PgBouncer, and monitoring."
more_link: "yes"
url: "/cloudnativepg-postgresql-operator-kubernetes-production-guide/"
---

**CloudNativePG (CNPG)** is the CNCF-accepted PostgreSQL operator for Kubernetes that treats the database cluster as a first-class Kubernetes resource rather than a stateful application bolted onto a StatefulSet. Where a hand-crafted StatefulSet deployment leaves operational concerns — failover, replication lag handling, backup orchestration, version upgrades — entirely to the operator's manual intervention, CNPG encodes all of these behaviors into the controller loop.

The result is a PostgreSQL cluster that self-heals primary failures, manages streaming replication automatically, integrates with Barman for object-store-backed continuous WAL archiving, and supports point-in-time recovery as a first-class cluster bootstrap operation. For teams that need production-grade PostgreSQL on Kubernetes without running a separate managed database service, CNPG represents the current state of the art.

<!--more-->

## Why CNPG Over Manual StatefulSets

### The Operator Pattern Advantage

A **Kubernetes Operator** extends the API server with custom resources and implements domain-specific logic in a controller that reconciles the desired state with the actual state. For PostgreSQL, this means:

- Automatic primary election and promotion when the current primary fails
- Replica lagging detection with configurable lag thresholds
- Coordinated rolling upgrades that respect replication topology
- Backup scheduling and retention management without cron jobs
- Connection pooler (PgBouncer) lifecycle tied to cluster lifecycle

A StatefulSet deployment cannot perform these operations autonomously. When a primary pod dies, a StatefulSet will restart it but cannot promote a replica to primary, redirect traffic, or notify application connection pools.

### CNPG Reconciliation Model

CNPG continuously reconciles the `Cluster` custom resource. When `spec.instances: 3` is declared:
1. One instance is elected primary based on a Raft-like consensus
2. Two replicas receive streaming replication via PostgreSQL's native replication protocol
3. Services (`-rw`, `-ro`, `-r`) are maintained pointing to the correct endpoints
4. WAL segments are continuously shipped to the configured object store

When a primary fails, CNPG performs a controlled failover: the most advanced replica is promoted, the old primary is fenced from accepting writes, and the service endpoints are updated — all within seconds and without human intervention.

## CNPG Operator Installation

```bash
# Install the CNPG operator via kubectl
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml

# Verify the operator is running
kubectl get pods -n cnpg-system

# Wait for the controller to be ready
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=120s
```

Alternatively, install via Helm for version-pinned deployments:

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update

helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version 0.22.0 \
  --set config.clusterWideRBAC=true
```

Create the target namespace and required secrets:

```bash
kubectl create namespace databases

# PostgreSQL superuser credentials
kubectl create secret generic postgres-superuser-secret \
  --from-literal=username=postgres \
  --from-literal=password="$(openssl rand -base64 32)" \
  -n databases

# Application database credentials
kubectl create secret generic postgres-app-secret \
  --from-literal=username=appuser \
  --from-literal=password="$(openssl rand -base64 32)" \
  -n databases

# S3 backup credentials
kubectl create secret generic postgres-s3-secret \
  --from-literal=ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
  --from-literal=ACCESS_SECRET_KEY="${AWS_SECRET_ACCESS_KEY}" \
  -n databases
```

## Cluster Manifest: Primary Plus Two Replicas

The `Cluster` resource is the central declaration of the PostgreSQL topology, storage configuration, and backup policy:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod
  namespace: databases
  labels:
    environment: production
    team: platform
    app: postgres
  annotations:
    cnpg.io/hibernation: "off"
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.2

  primaryUpdateStrategy: unsupervised
  primaryUpdateMethod: switchover

  storage:
    storageClass: fast-ssd
    size: 100Gi

  walStorage:
    storageClass: fast-ssd
    size: 20Gi

  resources:
    requests:
      cpu: "2"
      memory: 4Gi
    limits:
      cpu: "4"
      memory: 8Gi

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: 1GB
      effective_cache_size: 3GB
      maintenance_work_mem: 256MB
      checkpoint_completion_target: "0.9"
      wal_buffers: 16MB
      default_statistics_target: "100"
      random_page_cost: "1.1"
      effective_io_concurrency: "200"
      work_mem: 5242kB
      huge_pages: "off"
      min_wal_size: 1GB
      max_wal_size: 4GB
      max_worker_processes: "8"
      max_parallel_workers_per_gather: "4"
      max_parallel_workers: "8"
      max_parallel_maintenance_workers: "4"
      log_min_duration_statement: "1000"
      log_checkpoints: "on"
      log_connections: "on"
      log_disconnections: "on"
      log_lock_waits: "on"
    pg_hba:
    - host all all 10.0.0.0/8 scram-sha-256
    - host replication streaming_replica 10.0.0.0/8 scram-sha-256

  bootstrap:
    initdb:
      database: appdb
      owner: appuser
      secret:
        name: postgres-app-secret
      encoding: UTF8
      localeCType: C
      localeCollate: C

  superuserSecret:
    name: postgres-superuser-secret

  backup:
    retentionPolicy: 30d
    barmanObjectStore:
      destinationPath: s3://my-postgres-backups/prod
      s3Credentials:
        accessKeyId:
          name: postgres-s3-secret
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: postgres-s3-secret
          key: ACCESS_SECRET_KEY
      wal:
        compression: gzip
        maxParallel: 8
      data:
        compression: gzip
        immediateCheckpoint: false
        jobs: 4

  monitoring:
    enablePodMonitor: true

  affinity:
    enablePodAntiAffinity: true
    topologyKey: kubernetes.io/hostname
    podAntiAffinityType: required
    additionalPodAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app
              operator: In
              values:
              - postgres
          topologyKey: topology.kubernetes.io/zone

  startDelay: 30
  stopDelay: 30
  smartShutdownTimeout: 120
  failoverDelay: 0
  switchoverDelay: 60
```

### Service Endpoints Created by CNPG

CNPG automatically maintains three Services per cluster:

```bash
kubectl get services -n databases
# NAME                   TYPE        CLUSTER-IP       PORT(S)
# postgres-prod-r        ClusterIP   10.96.x.x        5432/TCP  # any instance (load balanced reads)
# postgres-prod-ro       ClusterIP   10.96.x.x        5432/TCP  # replicas only (read-only)
# postgres-prod-rw       ClusterIP   10.96.x.x        5432/TCP  # primary only (read-write)
```

Application connection strings should use:
- `postgres-prod-rw:5432` for write operations
- `postgres-prod-ro:5432` for read-only analytics queries

## Backup Configuration with Barman

**Barman** (Backup and Recovery Manager) is integrated directly into the CNPG container image. The `backup.barmanObjectStore` configuration in the Cluster manifest enables continuous WAL archiving. This provides the foundation for both full backups and point-in-time recovery.

Verify WAL archiving is working:

```bash
#!/usr/bin/env bash
# Check WAL archiving status on the primary
PRIMARY=$(kubectl get pod -n databases \
  -l cnpg.io/cluster=postgres-prod,cnpg.io/instanceRole=primary \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

echo "Primary pod: ${PRIMARY}"

# Check archive status
kubectl exec -n databases "${PRIMARY}" -- \
  psql -U postgres -c "SELECT archived_count, failed_count, last_archived_wal, last_failed_wal FROM pg_stat_archiver;"

# Check replication lag on replicas
kubectl exec -n databases "${PRIMARY}" -- \
  psql -U postgres -c "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, write_lag, flush_lag, replay_lag FROM pg_stat_replication;"
```

## Scheduled Backup

The `ScheduledBackup` resource creates full base backups on a configurable schedule:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: postgres-prod-backup
  namespace: databases
  labels:
    environment: production
spec:
  schedule: "0 2 * * *"
  backupOwnerReference: self
  cluster:
    name: postgres-prod
  target: primary
  method: barmanObjectStore
  immediate: false
```

Monitor backup status:

```bash
#!/usr/bin/env bash
# List recent backups and their status
kubectl get backup -n databases \
  -l cnpg.io/cluster=postgres-prod \
  --sort-by=.metadata.creationTimestamp | \
  awk '{print $1, $2, $3, $4}'

# Get details on the most recent backup
kubectl describe backup \
  -n databases \
  "$(kubectl get backup -n databases \
    -l cnpg.io/cluster=postgres-prod \
    --sort-by=.metadata.creationTimestamp \
    -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null)"
```

## Point-in-Time Recovery

PITR restores a cluster to a specific timestamp using the WAL archive. The recovery cluster reads WAL segments from the object store, replaying them until the target timestamp.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod-restored
  namespace: databases
  labels:
    environment: recovery
    source-cluster: postgres-prod
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.2

  storage:
    storageClass: fast-ssd
    size: 100Gi

  walStorage:
    storageClass: fast-ssd
    size: 20Gi

  bootstrap:
    recovery:
      recoveryTarget:
        targetTime: "2026-12-20 14:30:00.000000+00"
      source: postgres-prod-source

  externalClusters:
  - name: postgres-prod-source
    barmanObjectStore:
      destinationPath: s3://my-postgres-backups/prod
      s3Credentials:
        accessKeyId:
          name: postgres-s3-secret
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: postgres-s3-secret
          key: ACCESS_SECRET_KEY
      wal:
        maxParallel: 8

  superuserSecret:
    name: postgres-superuser-secret
```

Monitor recovery progress:

```bash
#!/usr/bin/env bash
# Watch recovery progress
kubectl get cluster postgres-prod-restored -n databases -w

# Check the recovery target reached
kubectl logs -n databases \
  "$(kubectl get pods -n databases \
    -l cnpg.io/cluster=postgres-prod-restored,cnpg.io/instanceRole=primary \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)" \
  | grep -E "recovery|PITR|target|restore"
```

## PgBouncer Connection Pooling

PostgreSQL's process-per-connection model limits the practical number of simultaneous connections before CPU overhead from context switching degrades performance. **PgBouncer** in transaction-mode pooling allows thousands of application connections to be multiplexed across a small pool of actual PostgreSQL backend connections.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres-prod-pooler-rw
  namespace: databases
  labels:
    environment: production
spec:
  cluster:
    name: postgres-prod
  instances: 3
  type: rw
  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "1000"
      default_pool_size: "25"
      reserve_pool_size: "5"
      reserve_pool_timeout: "5"
      max_db_connections: "100"
      max_user_connections: "100"
      server_idle_timeout: "600"
      client_idle_timeout: "0"
      log_connections: "1"
      log_disconnections: "1"
      server_check_query: "SELECT 1"
      server_check_delay: "30"
  template:
    metadata:
      labels:
        app: pgbouncer
    spec:
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - pgbouncer
              topologyKey: kubernetes.io/hostname
```

The Pooler creates its own Service. Applications connect to `postgres-prod-pooler-rw:5432` for pooled write connections:

```bash
kubectl get service postgres-prod-pooler-rw -n databases
```

## Monitoring with PodMonitor

CNPG embeds a Prometheus exporter in each instance. The `monitoring.enablePodMonitor: true` field in the Cluster spec creates the PodMonitor automatically when the Prometheus Operator CRD is present. For manual configuration:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: postgres-prod-monitor
  namespace: databases
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      cnpg.io/cluster: postgres-prod
  podMetricsEndpoints:
  - port: metrics
    scheme: http
    interval: 30s
    scrapeTimeout: 25s
    relabelings:
    - sourceLabels:
      - __meta_kubernetes_pod_label_cnpg_io_instanceRole
      targetLabel: role
    - sourceLabels:
      - __meta_kubernetes_namespace
      targetLabel: namespace
    - sourceLabels:
      - __meta_kubernetes_pod_name
      targetLabel: pod
    - sourceLabels:
      - __meta_kubernetes_pod_label_cnpg_io_cluster
      targetLabel: cluster
```

Key Prometheus metrics to alert on:

| Metric | Alert Condition | Severity |
|--------|----------------|----------|
| `cnpg_pg_stat_replication_pg_wal_lsn_diff` | > 52428800 (50 MB) for 5m | Warning |
| `cnpg_backends_total` | > 180 (90% of max_connections) | Warning |
| `cnpg_pg_postmaster_start_time_seconds` | Changed unexpectedly | Critical |
| `cnpg_collector_up` | == 0 for 2m | Critical |
| `cnpg_pg_database_size_bytes` | > 85% of storage limit | Warning |

## Maintenance Windows and Minor Version Upgrades

### Configuring Maintenance Windows

Maintenance windows prevent CNPG from performing operations that might cause brief interruptions (such as switchovers) during critical business hours:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-prod
  namespace: databases
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.2
  storage:
    storageClass: fast-ssd
    size: 100Gi
  nodeMaintenanceWindow:
    inProgress: false
    reusePVC: true
```

### Performing a Minor Version Upgrade

CNPG rolling upgrades update the image tag while maintaining replication continuity:

```bash
#!/usr/bin/env bash
# Trigger a rolling upgrade to a new PostgreSQL minor version
NEW_IMAGE="${1:-ghcr.io/cloudnative-pg/postgresql:16.3}"
CLUSTER_NAME="${2:-postgres-prod}"
NAMESPACE="${3:-databases}"

echo "Upgrading cluster ${CLUSTER_NAME} to ${NEW_IMAGE}..."

kubectl patch cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" \
  --type merge \
  -p "{\"spec\":{\"imageName\":\"${NEW_IMAGE}\"}}"

echo "Watching rollout progress..."
kubectl get pods -n "${NAMESPACE}" -l "cnpg.io/cluster=${CLUSTER_NAME}" -w
```

The upgrade proceeds replica-by-replica, with a final controlled switchover to promote the updated replica to primary before updating the last instance.

## Operational Runbook

### OOM Kill Recovery

When a PostgreSQL pod is OOM-killed, CNPG will restart the pod. If the primary is OOM-killed repeatedly, it indicates `shared_buffers` or other memory parameters are consuming more than the pod's memory limit:

```bash
#!/usr/bin/env bash
# Diagnose OOM events in the postgres cluster
kubectl describe pods -n databases \
  -l cnpg.io/cluster=postgres-prod | \
  grep -A5 "OOM\|Reason\|Exit Code\|Last State"

# Check current memory usage
kubectl top pods -n databases -l cnpg.io/cluster=postgres-prod

# Review recent kernel OOM events
kubectl exec -n databases postgres-prod-1 -- \
  dmesg | grep -i "oom\|killed" | tail -20
```

Resolution: increase the pod memory limit and reduce `shared_buffers` proportionally, or add more RAM to the node.

### Replication Lag Investigation

```bash
#!/usr/bin/env bash
# Check replication lag from the primary
PRIMARY=$(kubectl get pod -n databases \
  -l cnpg.io/cluster=postgres-prod,cnpg.io/instanceRole=primary \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

kubectl exec -n databases "${PRIMARY}" -- \
  psql -U postgres -x -c "
    SELECT
      client_addr,
      state,
      pg_size_pretty(sent_lsn - replay_lsn) AS replay_lag_bytes,
      write_lag,
      flush_lag,
      replay_lag
    FROM pg_stat_replication;
  "
```

High replication lag typically indicates network throughput constraints between primary and replica pods, or the replica's I/O subsystem cannot keep up with WAL write rate. Check storage IOPS utilization on replica nodes.

### Manual Failover

For planned maintenance requiring primary replacement:

```bash
#!/usr/bin/env bash
# Trigger a manual switchover (graceful primary promotion of a replica)
kubectl cnpg promote postgres-prod-2 -n databases

# Or using the CNPG kubectl plugin
kubectl cnpg switchover postgres-prod postgres-prod-2 -n databases
```

### Emergency Fencing

If a primary pod becomes unresponsive but has not yet been terminated by Kubernetes (network partition scenario), CNPG's fencing mechanism prevents split-brain:

```bash
#!/usr/bin/env bash
# Fence a specific instance to prevent it writing to storage
kubectl annotate pod postgres-prod-1 -n databases \
  cnpg.io/fencedInstances='["postgres-prod-1"]'

# Remove fencing after the situation is resolved
kubectl annotate pod postgres-prod-1 -n databases \
  cnpg.io/fencedInstances-
```

### Cluster Health Check Script

```bash
#!/usr/bin/env bash
# Complete health check for a CNPG cluster
CLUSTER="${1:-postgres-prod}"
NAMESPACE="${2:-databases}"

echo "=== CNPG Cluster Health: ${NAMESPACE}/${CLUSTER} ==="

echo ""
echo "--- Cluster Status ---"
kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.phase}{"\n"}' 2>/dev/null

echo ""
echo "--- Instance Status ---"
kubectl get pods -n "${NAMESPACE}" \
  -l "cnpg.io/cluster=${CLUSTER}" \
  -o custom-columns=\
'NAME:.metadata.name,ROLE:.metadata.labels.cnpg\.io/instanceRole,STATUS:.status.phase,READY:.status.containerStatuses[0].ready'

echo ""
echo "--- Recent Events ---"
kubectl get events -n "${NAMESPACE}" \
  --field-selector "involvedObject.name=${CLUSTER}" \
  --sort-by=.lastTimestamp | tail -10

echo ""
echo "--- Backup Status ---"
kubectl get backup -n "${NAMESPACE}" \
  -l "cnpg.io/cluster=${CLUSTER}" \
  --sort-by=.metadata.creationTimestamp | tail -5
```

CloudNativePG delivers on the promise of database-as-code: a PostgreSQL cluster with streaming replication, continuous WAL archiving, PITR capability, and automatic failover that behaves as a first-class Kubernetes resource. Teams that have previously managed PostgreSQL on Kubernetes through StatefulSets and manual operational runbooks find that CNPG substantially reduces the operational burden while simultaneously improving the reliability and recoverability of their database tier.
