---
title: "PostgreSQL Logical Replication on Kubernetes: CNPG Streaming Replicas"
date: 2029-01-07T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "CNPG", "Kubernetes", "Replication", "CloudNativePG"]
categories:
- Databases
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to configuring PostgreSQL logical replication with CloudNativePG (CNPG) on Kubernetes, covering streaming replicas, publication/subscription setup, cross-cluster replication, and monitoring patterns."
more_link: "yes"
url: "/postgresql-logical-replication-cnpg-streaming-replicas/"
---

PostgreSQL's logical replication enables selective, row-level data synchronization between database instances—independent of physical storage layout. Combined with CloudNativePG (CNPG), the Kubernetes-native PostgreSQL operator, logical replication becomes a first-class feature for read scaling, zero-downtime major version upgrades, and cross-cluster data distribution.

This guide covers CNPG cluster deployment with streaming physical replicas, the configuration of logical replication publications and subscriptions, cross-cluster replication patterns, and operational procedures for managing replication lag and failover.

<!--more-->

## Physical vs Logical Replication

Understanding the distinction between physical and logical replication is essential before configuring either:

**Physical (streaming) replication** copies WAL segments at the byte level. The standby is an exact binary replica of the primary. Standby nodes serve read-only queries. CNPG uses physical replication for its built-in high availability (primary + standby pods).

**Logical replication** copies changes as logical operations (INSERT, UPDATE, DELETE) for specific tables or publications. Subscribers can be:
- A different PostgreSQL version (enabling major version upgrades with minimal downtime)
- A different operating system or hardware architecture
- A partial replica (subset of tables)
- An external system consuming the logical change stream via `pgoutput` or `wal2json`

CNPG clusters use physical replication internally for HA, and logical replication for cross-cluster data distribution and external subscriber integration.

## Deploying a CNPG Cluster

### Installing CloudNativePG

```bash
# Install CNPG operator
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update

helm install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version 0.22.1

# Verify operator is running
kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg
```

### Primary Cluster with Logical Replication Enabled

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-primary
  namespace: production
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.4

  # PostgreSQL configuration for logical replication
  postgresql:
    parameters:
      wal_level: "logical"              # Required for logical replication
      max_replication_slots: "20"       # Slots for logical subscribers
      max_wal_senders: "20"             # Connections from replicas/subscribers
      wal_keep_size: "1GB"              # Retain WAL for slow subscribers
      hot_standby: "on"
      hot_standby_feedback: "on"
      # Performance tuning
      max_connections: "200"
      shared_buffers: "2GB"
      effective_cache_size: "6GB"
      work_mem: "16MB"
      maintenance_work_mem: "512MB"
      wal_buffers: "64MB"
      checkpoint_completion_target: "0.9"
      max_worker_processes: "16"
      max_parallel_workers: "8"

    pg_hba:
      - host replication all all scram-sha-256
      - host all all all scram-sha-256

  # Primary service for read-write connections
  primaryUpdateStrategy: unsupervised
  primaryUpdateMethod: restart

  storage:
    size: 200Gi
    storageClass: fast-nvme

  walStorage:
    size: 20Gi
    storageClass: fast-nvme

  resources:
    requests:
      cpu: "2"
      memory: 8Gi
    limits:
      cpu: "8"
      memory: 16Gi

  affinity:
    enablePodAntiAffinity: true
    topologyKey: topology.kubernetes.io/zone

  monitoring:
    enablePodMonitor: true

  backup:
    barmanObjectStore:
      destinationPath: s3://pg-backups-prod/pg-primary
      s3Credentials:
        accessKeyId:
          name: pg-backup-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: pg-backup-credentials
          key: ACCESS_SECRET_KEY
      wal:
        compression: gzip
        maxParallel: 4
      data:
        compression: gzip
        immediateCheckpoint: false
        jobs: 4
    retentionPolicy: "30d"
```

### Configuring Logical Replication Publications

After the cluster is running, create publications on the primary:

```bash
# Connect to the primary
kubectl -n production exec -it pg-primary-1 -- psql -U postgres

# Create a publication for all tables in a schema
CREATE PUBLICATION app_publication FOR TABLES IN SCHEMA public;

# Or for specific tables
CREATE PUBLICATION orders_publication FOR TABLE orders, order_items, customers;

# Publication with row filter (PostgreSQL 15+)
CREATE PUBLICATION active_orders_pub FOR TABLE orders WHERE (status != 'archived');

# Verify publications
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
FROM pg_publication;

# List tables in a publication
SELECT * FROM pg_publication_tables WHERE pubname = 'app_publication';
```

## Read Replica with Logical Subscription

### Deploying a Read-Scale Subscriber Cluster

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-read-replica
  namespace: production
spec:
  instances: 2
  imageName: ghcr.io/cloudnative-pg/postgresql:16.4

  postgresql:
    parameters:
      wal_level: "logical"
      max_connections: "500"          # Higher connections for read workloads
      shared_buffers: "4GB"
      effective_cache_size: "12GB"
      work_mem: "32MB"
      max_parallel_workers_per_gather: "4"

  storage:
    size: 200Gi
    storageClass: fast-ssd

  resources:
    requests:
      cpu: "4"
      memory: 16Gi
    limits:
      cpu: "16"
      memory: 32Gi
```

### Creating the Subscription

```bash
# First, ensure the schema exists on the subscriber
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres

-- Create the database and schema structure on subscriber
CREATE DATABASE appdb;
\c appdb

-- Create tables matching the publication (schema must match)
-- In production, use pg_dump --schema-only to copy schema
\i /tmp/schema.sql

-- Create the subscription
CREATE SUBSCRIPTION app_subscription
  CONNECTION 'host=pg-primary-rw.production.svc.cluster.local
              port=5432
              dbname=appdb
              user=replication_user
              password=replpassword123
              sslmode=require'
  PUBLICATION app_publication
  WITH (
    copy_data = true,             -- Initial data sync
    synchronous_commit = off,     -- Async for performance
    connect = true,
    enabled = true,
    create_slot = true
  );

-- Verify subscription status
SELECT subname, subenabled, subslotname, subsynccommit
FROM pg_subscription;

-- Check subscription statistics
SELECT subname, received_lsn, latest_end_lsn,
       extract(epoch from (now() - latest_end_time)) as lag_seconds
FROM pg_stat_subscription;
```

### Creating the Replication User

```bash
# On the primary, create a dedicated replication user
kubectl -n production exec -it pg-primary-1 -- psql -U postgres

CREATE ROLE replication_user WITH LOGIN REPLICATION PASSWORD 'replpassword123';

-- Grant SELECT on all tables in the published schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO replication_user;
GRANT USAGE ON SCHEMA public TO replication_user;

-- Grant pg_read_all_data for future tables (PostgreSQL 14+)
GRANT pg_read_all_data TO replication_user;

-- Verify slot was created
SELECT slot_name, plugin, slot_type, active, restart_lsn, confirmed_flush_lsn
FROM pg_replication_slots
WHERE slot_name = 'app_subscription';
```

## Cross-Cluster Logical Replication

For multi-region deployments, logical replication can span Kubernetes clusters using an external service or VPN tunnel:

### Publishing Cluster Configuration

```yaml
# Expose the PostgreSQL primary via a LoadBalancer for cross-cluster access
apiVersion: v1
kind: Service
metadata:
  name: pg-primary-replication-lb
  namespace: production
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-internal: "true"
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
spec:
  type: LoadBalancer
  selector:
    cnpg.io/cluster: pg-primary
    role: primary
  ports:
    - port: 5432
      targetPort: 5432
```

### External Publication with TLS

```bash
# On primary cluster: configure SSL for external subscribers
kubectl -n production exec -it pg-primary-1 -- psql -U postgres

-- Allow the external subscriber's IP in pg_hba
-- (CNPG configures pg_hba via postgresql.pg_hba configuration)

-- Create publication with replication identity for UPDATE/DELETE support
ALTER TABLE orders REPLICA IDENTITY FULL;
ALTER TABLE customers REPLICA IDENTITY FULL;

CREATE PUBLICATION cross_region_pub
  FOR TABLE orders, customers, products
  WITH (publish = 'insert, update, delete, truncate');
```

### Subscriber in Remote Cluster

```bash
# On the subscriber cluster, create subscription with SSL
kubectl -n production exec -it pg-dr-replica-1 -- psql -U postgres

\c appdb

CREATE SUBSCRIPTION cross_region_sub
  CONNECTION 'host=10.200.15.42
              port=5432
              dbname=appdb
              user=replication_user
              password=replpassword123
              sslmode=verify-full
              sslrootcert=/var/run/secrets/postgresql-ca.crt'
  PUBLICATION cross_region_pub
  WITH (
    copy_data = true,
    synchronous_commit = off,
    slot_name = cross_region_sub_slot
  );
```

## Zero-Downtime Major Version Upgrade

Logical replication enables PostgreSQL major version upgrades with minimal downtime:

```bash
# Step 1: Deploy PG 17 cluster (subscriber)
# Step 2: Create subscription pointing to PG 16 primary
# Step 3: Wait for initial sync to complete
# Step 4: Monitor replication lag
# Step 5: When lag is < 1 second, coordinate cutover:

# On PG 16 primary - prevent new writes
BEGIN;
LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
-- Wait for replication to catch up (check pg_stat_subscription lag)
SELECT pg_sleep(2);
COMMIT;

# On PG 17 subscriber - promote
SELECT pg_promote();

# Update application connection strings to PG 17
# Verify data integrity

# Step 6: Remove subscription (now PG 17 is the new primary)
DROP SUBSCRIPTION cross_region_sub;
```

## Monitoring Replication Lag

### CNPG PodMonitor and Prometheus Metrics

CNPG automatically exposes a `/metrics` endpoint via the `cnpg-sandbox` container. Enable monitoring:

```yaml
# Already enabled via monitoring.enablePodMonitor: true in the Cluster spec
# Verify ServiceMonitor/PodMonitor was created
kubectl -n production get podmonitors

# Key metrics exported by CNPG
# cnpg_pg_replication_in_recovery: 0 for primary, 1 for standby
# cnpg_pg_replication_lag: lag in seconds for physical replicas
# cnpg_pg_stat_replication_write_lag_seconds: WAL write lag
# cnpg_pg_stat_replication_flush_lag_seconds: WAL flush lag
# cnpg_pg_stat_replication_replay_lag_seconds: WAL replay lag
```

### Logical Replication Monitoring Queries

```sql
-- Replication slot lag (risk of WAL retention bloat)
SELECT slot_name,
       slot_type,
       active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       extract(epoch from (now() - last_activity)) AS inactive_seconds
FROM pg_replication_slots
ORDER BY retained_wal DESC;

-- Subscription apply lag
SELECT subname,
       pid,
       received_lsn,
       latest_end_lsn,
       pg_size_pretty(pg_wal_lsn_diff(latest_end_lsn, received_lsn)) AS pending_bytes,
       extract(epoch from (now() - latest_end_time)) AS lag_seconds
FROM pg_stat_subscription;

-- Worker status
SELECT pid, relid::regclass, state, sent_lsn, write_lsn, flush_lsn, replay_lsn
FROM pg_stat_replication;
```

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: postgresql-replication-alerts
  namespace: monitoring
spec:
  groups:
    - name: postgresql.replication
      rules:
        - alert: PostgreSQLReplicationLagHigh
          expr: |
            cnpg_pg_replication_lag > 30
          for: 5m
          labels:
            severity: warning
            team: data-platform
          annotations:
            summary: "PostgreSQL physical replication lag is high"
            description: "Cluster {{ $labels.cluster }} replica lag is {{ $value }}s. Failover RTO may be impacted."

        - alert: PostgreSQLReplicationSlotInactive
          expr: |
            cnpg_pg_replication_slots_inactive > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL replication slot is inactive"
            description: "An inactive replication slot is preventing WAL cleanup. This can cause disk exhaustion."

        - alert: PostgreSQLWALRetentionExcessive
          expr: |
            cnpg_pg_wal_size_bytes > 10 * 1024 * 1024 * 1024
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "PostgreSQL WAL retention is excessive (>10GB)"
            description: "WAL is being retained at {{ $value | humanize1024 }}. Check for slow or stalled replication slots."

        - alert: PostgreSQLLogicalSubscriptionLagHigh
          expr: |
            pg_stat_subscription_lag_seconds > 60
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "PostgreSQL logical subscription lag exceeds 60 seconds"
            description: "Subscription {{ $labels.subname }} is {{ $value }}s behind. Data in subscriber is stale."
```

## Handling Schema Changes

Logical replication does not automatically replicate DDL changes. Schema changes must be applied to subscribers before or after applying them to the publisher, depending on the change type:

```bash
# For additive changes (adding columns with defaults):
# 1. Apply to subscriber first
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres appdb
ALTER TABLE orders ADD COLUMN customer_segment TEXT DEFAULT 'standard';

# 2. Then apply to publisher
kubectl -n production exec -it pg-primary-1 -- psql -U postgres appdb
ALTER TABLE orders ADD COLUMN customer_segment TEXT DEFAULT 'standard';
# Replication continues without interruption

# For destructive changes (dropping columns):
# 1. Apply to publisher first
# 2. Update application to not write to the column
# 3. Apply to subscriber

# For table renames or drops:
# 1. Remove the table from the publication temporarily
ALTER PUBLICATION app_publication DROP TABLE old_table_name;
# 2. Apply DDL changes to both sides
# 3. Re-add to publication if needed
```

## CNPG Declarative Publication Management

CNPG 1.22+ supports managing publications and subscriptions declaratively via the `Publication` and `Subscription` CRDs:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Publication
metadata:
  name: app-publication
  namespace: production
spec:
  cluster:
    name: pg-primary
  dbname: appdb
  name: app_publication
  target:
    allTablesInSchema:
      - schema: public
      - schema: analytics
  parameters:
    publish: "insert, update, delete"
---
apiVersion: postgresql.cnpg.io/v1
kind: Subscription
metadata:
  name: app-subscription
  namespace: production
spec:
  cluster:
    name: pg-read-replica
  dbname: appdb
  name: app_subscription
  publicationName: app_publication
  externalClusterName: pg-primary-external
  parameters:
    synchronous_commit: "off"
    copy_data: "true"
```

## Troubleshooting Replication Issues

### Diagnosing Stalled Replication

```bash
# Check subscriber worker status
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres appdb \
  -c "SELECT * FROM pg_stat_subscription_stats;"

# Check for conflicting transactions on subscriber
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres appdb \
  -c "SELECT * FROM pg_replication_origin_status;"

# Check for replication errors in PostgreSQL logs
kubectl -n production logs pg-read-replica-1 | grep -i "conflict\|error\|replication"

# Manually resolve a replication conflict by skipping a transaction
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres appdb \
  -c "SELECT pg_replication_origin_advance('pg_16384', '0/DEADBEEF');"

# Disable and re-enable subscription to force resync
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres appdb \
  -c "ALTER SUBSCRIPTION app_subscription DISABLE;"
kubectl -n production exec -it pg-read-replica-1 -- psql -U postgres appdb \
  -c "ALTER SUBSCRIPTION app_subscription ENABLE;"
```

### Replication Slot Cleanup

Orphaned replication slots that are no longer consumed will prevent WAL cleanup and cause disk exhaustion:

```bash
# Identify inactive slots older than 1 hour
kubectl -n production exec -it pg-primary-1 -- psql -U postgres appdb \
  -c "SELECT slot_name, slot_type, active,
             pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
      FROM pg_replication_slots
      WHERE NOT active AND restart_lsn IS NOT NULL
      ORDER BY retained_wal DESC;"

# Drop an orphaned slot (only if the subscriber is truly gone)
kubectl -n production exec -it pg-primary-1 -- psql -U postgres appdb \
  -c "SELECT pg_drop_replication_slot('orphaned_slot_name');"
```

## Summary

PostgreSQL logical replication with CloudNativePG provides enterprise-grade data distribution, read scaling, and major version upgrade capabilities within Kubernetes. The key operational considerations are:

- Enable `wal_level = logical` and set appropriate `max_replication_slots` before enabling logical replication
- Monitor replication slot lag aggressively to prevent WAL disk exhaustion
- Apply schema changes in the correct order (subscriber first for additive changes, publisher first for destructive changes)
- Use replication identities (`REPLICA IDENTITY FULL`) for tables that require UPDATE and DELETE replication
- Implement Prometheus alerting for subscription lag to catch divergence before it impacts application data freshness
- Test the cross-cluster subscription process in staging before relying on it for production DR
