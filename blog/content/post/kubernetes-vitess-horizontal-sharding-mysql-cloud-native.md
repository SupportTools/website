---
title: "Kubernetes Vitess: Horizontally Sharding MySQL for Cloud-Native Applications"
date: 2031-03-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Vitess", "MySQL", "Sharding", "Database", "Cloud-Native", "Operator"]
categories:
- Kubernetes
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Vitess architecture on Kubernetes: VTGate, VTTablet, etcd topology, VSchema design, MoveTables online migration, and production deployment with the Vitess Operator."
more_link: "yes"
url: "/kubernetes-vitess-horizontal-sharding-mysql-cloud-native/"
---

Vitess is the battle-tested database clustering system that powers YouTube and dozens of other hyperscale deployments. It wraps MySQL with a horizontally scalable sharding layer that presents a single logical database to applications while distributing data and queries across hundreds of underlying MySQL instances. This guide walks through every layer of Vitess running on Kubernetes, from topology management in etcd to online resharding with MoveTables.

<!--more-->

# Kubernetes Vitess: Horizontally Sharding MySQL for Cloud-Native Applications

## Section 1: Vitess Architecture Overview

Vitess consists of several cooperating components. Understanding each one and its relationship to the others is prerequisite to operating a production cluster.

### Core Components

**VTGate** is the stateless query router. Every application connects to VTGate using standard MySQL protocol. VTGate parses the SQL, consults the VSchema to determine which keyspace and shards own the relevant rows, then fans the query out to the appropriate VTTablet instances. Because VTGate is stateless, you can run as many replicas as needed and load-balance with a standard Kubernetes Service.

**VTTablet** is a sidecar process that runs alongside every MySQL instance. It manages the MySQL process lifecycle, provides connection pooling, and enforces query rules. VTTablet also handles replication lag awareness, health checking, and tablet type transitions (primary/replica/rdonly).

**VTorc** is the Vitess orchestrator, responsible for automatic failure detection and promotion of a replica to primary when the current primary fails.

**etcd** stores the cluster topology: which keyspaces exist, how each keyspace is sharded, which tablets serve each shard, and the current primary for each shard.

**vtctld** is the Vitess cluster management daemon. It provides the vtctlclient CLI and a web UI, and executes administrative operations like InitShardPrimary, PlannedReparentShard, and MoveTables.

### Keyspace and Shard Concepts

A **keyspace** is a logical database, roughly equivalent to a MySQL database name. A keyspace can be either:

- **Unsharded**: a single shard (single MySQL instance or HA pair) serves all data.
- **Sharded**: data is partitioned across multiple shards using a sharding key.

Each **shard** is identified by a key range, expressed in hexadecimal. An unsharded keyspace has a single shard with range `-` (all keys). A two-shard keyspace might have shards `-80` and `80-`. An eight-shard keyspace would have `-20`, `20-40`, `40-60`, `60-80`, `80-a0`, `a0-c0`, `c0-e0`, `e0-`.

The **keyspace ID** is a 64-bit value derived from the sharding key via a VIndex (Vitess index). The VIndex function maps an application column value to a keyspace ID, which then falls into exactly one shard's range.

## Section 2: VSchema Design

The VSchema is the heart of Vitess routing. It describes every table in a keyspace, how each table is sharded, and what secondary indexes (VIndexes) exist for cross-shard lookups.

### Sharded Keyspace VSchema

```json
{
  "sharded": true,
  "vindexes": {
    "hash": {
      "type": "hash"
    },
    "lookup_user_email": {
      "type": "consistent_lookup_unique",
      "params": {
        "table": "user_email_idx",
        "from": "email",
        "to": "user_id"
      },
      "owner": "users"
    },
    "lookup_order_user": {
      "type": "consistent_lookup",
      "params": {
        "table": "order_user_idx",
        "from": "order_id",
        "to": "user_id"
      },
      "owner": "orders"
    }
  },
  "tables": {
    "users": {
      "columnVindexes": [
        {
          "column": "user_id",
          "name": "hash"
        },
        {
          "column": "email",
          "name": "lookup_user_email"
        }
      ]
    },
    "orders": {
      "columnVindexes": [
        {
          "column": "user_id",
          "name": "hash"
        },
        {
          "column": "order_id",
          "name": "lookup_order_user"
        }
      ]
    },
    "order_items": {
      "columnVindexes": [
        {
          "column": "user_id",
          "name": "hash"
        }
      ]
    },
    "user_email_idx": {
      "type": "lookup",
      "columnVindexes": [
        {
          "column": "email",
          "name": "hash"
        }
      ]
    },
    "order_user_idx": {
      "type": "lookup",
      "columnVindexes": [
        {
          "column": "order_id",
          "name": "hash"
        }
      ]
    }
  }
}
```

Key design decisions in this VSchema:

1. `users`, `orders`, and `order_items` all shard on `user_id`, which means a `JOIN` between these tables for a specific user can be routed to a single shard (a scatter join is avoided).
2. A `consistent_lookup_unique` VIndex on `email` enables looking up a user by email without scattering to all shards.
3. The lookup tables (`user_email_idx`, `order_user_idx`) are themselves sharded on the lookup key, making the lookup scalable.

### Unsharded Keyspace VSchema

Reference tables and configuration data often belong in an unsharded keyspace:

```json
{
  "sharded": false,
  "tables": {
    "product_catalog": {},
    "regions": {},
    "shipping_methods": {}
  }
}
```

VTGate can JOIN across keyspaces in many cases, making it practical to keep truly global lookup tables in an unsharded keyspace.

## Section 3: Installing Vitess on Kubernetes with the Operator

The PlanetScale Vitess Operator is the recommended way to run Vitess on Kubernetes. It manages VitessCluster custom resources and handles the full lifecycle of cells, keyspaces, shards, and tablets.

### Installing the Operator

```bash
# Add the Vitess Helm repository
helm repo add vitess https://vitess.io/helm-charts
helm repo update

# Install the operator into its own namespace
kubectl create namespace vitess
helm install vitess-operator vitess/vitess-operator \
  --namespace vitess \
  --set image.tag=v2.13.0 \
  --wait
```

Verify the operator is running:

```bash
kubectl -n vitess get pods
# NAME                               READY   STATUS    RESTARTS   AGE
# vitess-operator-7d4b9f8c6d-xk9pz   1/1     Running   0          45s
```

### Deploying a VitessCluster

The following manifest deploys a production-ready two-cell cluster with a sharded `commerce` keyspace. Save this as `vitesscluster.yaml`:

```yaml
apiVersion: planetscale.dev/v2
kind: VitessCluster
metadata:
  name: commerce
  namespace: vitess
spec:
  images:
    vtgate: vitess/lite:v20.0.0
    vttablet: vitess/lite:v20.0.0
    vtbackup: vitess/lite:v20.0.0
    mysqld:
      mysql80Compatible: mysql:8.0.32
    mysqldExporter: prom/mysqld-exporter:v0.14.0

  # Global etcd for topology storage
  globalLockserver:
    etcd:
      replicas: 3
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
      dataVolumeClaimTemplate:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
        storageClassName: fast-ssd

  cells:
  - name: us-east
    lockserver:
      etcd:
        replicas: 3
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        dataVolumeClaimTemplate:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi
          storageClassName: fast-ssd
    gateway:
      replicas: 2
      resources:
        requests:
          cpu: 500m
          memory: 512Mi
        limits:
          cpu: 2000m
          memory: 2Gi
      extraFlags:
        mysql_server_port: "3306"
        mysql_auth_server_impl: none
        normalize_queries: "true"
        queryserver-config-query-timeout: "30"
        queryserver-config-transaction-timeout: "30"
        warn_sharded_only: "true"

  keyspaces:
  - name: commerce
    turndownPolicy: Immediate
    vitessOrchestrator:
      active: true
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
    partitionings:
    - equal:
        parts: 2
        shardTemplate:
          databaseInitScriptSecret:
            name: commerce-init-db
            key: init_db.sql
          replication:
            enforceSemiSync: true
          tablets:
          - type: primary
            replicas: 1
            vttablet:
              extraFlags:
                db-credentials-server: secret
                db-credentials-server-type: vault
                queryserver-config-pool-size: "24"
                queryserver-config-stream-pool-size: "200"
                queryserver-config-transaction-cap: "300"
                queryserver-config-query-timeout: "30"
                queryserver-config-transaction-timeout: "30"
                heartbeat-enable: "true"
                heartbeat-interval: "1s"
              resources:
                requests:
                  cpu: 500m
                  memory: 1Gi
                limits:
                  cpu: 2000m
                  memory: 4Gi
            mysqld:
              resources:
                requests:
                  cpu: 1000m
                  memory: 4Gi
                limits:
                  cpu: 4000m
                  memory: 8Gi
            dataVolumeClaimTemplate:
              accessModes: ["ReadWriteOnce"]
              resources:
                requests:
                  storage: 100Gi
              storageClassName: fast-ssd
          - type: replica
            replicas: 2
            vttablet:
              extraFlags:
                queryserver-config-pool-size: "24"
                queryserver-config-stream-pool-size: "200"
              resources:
                requests:
                  cpu: 500m
                  memory: 1Gi
                limits:
                  cpu: 2000m
                  memory: 4Gi
            mysqld:
              resources:
                requests:
                  cpu: 1000m
                  memory: 4Gi
                limits:
                  cpu: 4000m
                  memory: 8Gi
            dataVolumeClaimTemplate:
              accessModes: ["ReadWriteOnce"]
              resources:
                requests:
                  storage: 100Gi
              storageClassName: fast-ssd
          - type: rdonly
            replicas: 1
            vttablet:
              extraFlags:
                queryserver-config-pool-size: "16"
                queryserver-config-stream-pool-size: "400"
              resources:
                requests:
                  cpu: 500m
                  memory: 1Gi
                limits:
                  cpu: 2000m
                  memory: 4Gi
            mysqld:
              resources:
                requests:
                  cpu: 500m
                  memory: 2Gi
                limits:
                  cpu: 2000m
                  memory: 4Gi
            dataVolumeClaimTemplate:
              accessModes: ["ReadWriteOnce"]
              resources:
                requests:
                  storage: 100Gi
              storageClassName: fast-ssd
```

Apply the manifest:

```bash
kubectl apply -f vitesscluster.yaml

# Watch pods come up
kubectl -n vitess get pods -w

# Check cluster status
kubectl -n vitess get vitesscluster commerce -o yaml | \
  grep -A 20 "status:"
```

### Database Initialization Secret

Vitess needs an init script to create the application schema:

```bash
cat > init_db.sql << 'EOF'
CREATE TABLE IF NOT EXISTS users (
  user_id   BIGINT      NOT NULL,
  email     VARCHAR(255) NOT NULL,
  username  VARCHAR(100) NOT NULL,
  created   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY ux_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  order_id  BIGINT       NOT NULL AUTO_INCREMENT,
  user_id   BIGINT       NOT NULL,
  status    VARCHAR(20)  NOT NULL DEFAULT 'pending',
  total     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  created   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id),
  KEY ix_user_id (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  item_id    BIGINT        NOT NULL AUTO_INCREMENT,
  order_id   BIGINT        NOT NULL,
  user_id    BIGINT        NOT NULL,
  product_id BIGINT        NOT NULL,
  quantity   INT           NOT NULL DEFAULT 1,
  price      DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (item_id),
  KEY ix_order_id (order_id),
  KEY ix_user_id (user_id)
) ENGINE=InnoDB;

-- Lookup tables for VIndexes
CREATE TABLE IF NOT EXISTS user_email_idx (
  email   VARCHAR(255) NOT NULL,
  user_id BIGINT       NOT NULL,
  PRIMARY KEY (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_user_idx (
  order_id BIGINT NOT NULL,
  user_id  BIGINT NOT NULL,
  PRIMARY KEY (order_id)
) ENGINE=InnoDB;
EOF

kubectl create secret generic commerce-init-db \
  --from-file=init_db.sql \
  -n vitess
```

## Section 4: VTGate Connection Pooling and Routing

VTGate's connection pooling operates at two levels:

1. **Client-facing pool**: Manages inbound connections from applications. VTGate is lightweight and can handle tens of thousands of connections.
2. **Backend pool**: Manages connections from VTGate to each VTTablet. This is the critical pool to tune.

### VTGate Configuration Flags

Key flags for VTGate in production:

```bash
# Connection limits
--queryserver-config-pool-size=300        # Connections per tablet for OLTP
--queryserver-config-stream-pool-size=200 # Connections for streaming queries
--queryserver-config-transaction-cap=300  # Max concurrent transactions

# Timeouts
--queryserver-config-query-timeout=30     # Query timeout (seconds)
--queryserver-config-transaction-timeout=30  # Transaction timeout

# Routing
--normalize_queries=true                  # Normalize SQL for plan caching
--warn_sharded_only=false                 # Warn on cross-shard queries
--enable_system_settings=true             # Allow SET statements

# Observability
--emit_stats=true
--stats_emit_period=60s
--querylog-filter-tag=vttablet
```

### Application Connection String

Applications connect to VTGate exactly as if connecting to MySQL:

```go
package main

import (
    "database/sql"
    "fmt"
    "log"

    _ "github.com/go-sql-driver/mysql"
)

func main() {
    // VTGate Service in Kubernetes exposes port 3306
    dsn := "app_user:@tcp(vitess-commerce-vtgate.vitess.svc.cluster.local:3306)/commerce@primary"

    db, err := sql.Open("mysql", dsn)
    if err != nil {
        log.Fatalf("failed to open: %v", err)
    }
    defer db.Close()

    // Connection pool settings
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(300)

    // Insert respects sharding automatically - user_id routes to correct shard
    result, err := db.Exec(
        "INSERT INTO users (user_id, email, username) VALUES (?, ?, ?)",
        12345, "alice@example.com", "alice",
    )
    if err != nil {
        log.Fatalf("insert failed: %v", err)
    }

    id, _ := result.LastInsertId()
    fmt.Printf("inserted user_id=%d\n", id)

    // This query routes to a single shard because user_id is the sharding key
    rows, err := db.Query(
        `SELECT o.order_id, o.total, oi.product_id
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.order_id AND oi.user_id = o.user_id
         WHERE o.user_id = ?
         ORDER BY o.created DESC LIMIT 10`,
        12345,
    )
    if err != nil {
        log.Fatalf("query failed: %v", err)
    }
    defer rows.Close()

    for rows.Next() {
        var orderID int64
        var total float64
        var productID int64
        if err := rows.Scan(&orderID, &total, &productID); err != nil {
            log.Printf("scan: %v", err)
        }
        fmt.Printf("order=%d total=%.2f product=%d\n", orderID, total, productID)
    }
}
```

### Target Annotations

For fine-grained routing, use target annotations in the connection or per-query:

```sql
-- Route to read-only replicas for analytics
USE `commerce@replica`;
SELECT COUNT(*) FROM orders WHERE status = 'completed';

-- Route to rdonly tablets (batch analytics without affecting replication lag on replicas)
USE `commerce@rdonly`;
SELECT user_id, SUM(total) FROM orders GROUP BY user_id;

-- Route to primary for writes
USE `commerce@primary`;
UPDATE orders SET status = 'shipped' WHERE order_id = 999 AND user_id = 12345;
```

## Section 5: MoveTables — Online Schema and Data Migration

MoveTables is Vitess's mechanism for migrating tables between keyspaces online without downtime. The typical use case is moving a table from an unsharded keyspace to a sharded one, or resharding an existing keyspace.

### Resharding Workflow: 2 Shards to 4 Shards

The following example reshards the `commerce` keyspace from 2 shards (`-80`, `80-`) to 4 shards (`-40`, `40-80`, `80-c0`, `c0-`).

**Step 1: Create the target shards**

```bash
# Access vtctldclient
kubectl -n vitess exec -it deploy/vitess-operator -- bash

vtctldclient --server=vitess-commerce-vtctld.vitess.svc.cluster.local:15999 \
  CreateShard commerce/-40
vtctldclient --server=... CreateShard commerce/40-80
vtctldclient --server=... CreateShard commerce/80-c0
vtctldclient --server=... CreateShard commerce/c0-
```

**Step 2: Initialize primary tablets on new shards**

```bash
for shard in -40 40-80 80-c0 c0-; do
  vtctldclient --server=... \
    InitShardPrimary \
    --force \
    commerce/${shard} \
    us-east-0000000100
done
```

**Step 3: Start the Reshard workflow**

```bash
vtctldclient --server=... \
  Reshard \
  --source-shards=-80,80- \
  --target-shards=-40,40-80,80-c0,c0- \
  commerce.reshard_2to4 \
  create
```

**Step 4: Monitor VReplication progress**

```bash
# Check VReplication status
vtctldclient --server=... \
  Reshard \
  commerce.reshard_2to4 \
  status

# Sample output:
# Workflow: reshard_2to4
# Source: commerce/-80, commerce/80-
# Target: commerce/-40, commerce/40-80, commerce/80-c0, commerce/c0-
# State: Copying
# Table: users   Rows Copied: 4523891  Rows Total: 4523891  ETA: done
# Table: orders  Rows Copied: 18923440 Rows Total: 18924120 ETA: 2s
# Table: order_items Rows Copied: 71233441 Rows Total: 71240000 ETA: 8s
```

**Step 5: SwitchTraffic**

Once all rows are copied and VReplication is in steady state (lag near zero):

```bash
# Switch reads first (non-disruptive)
vtctldclient --server=... \
  Reshard \
  commerce.reshard_2to4 \
  SwitchTraffic \
  --tablet-type=rdonly

vtctldclient --server=... \
  Reshard \
  commerce.reshard_2to4 \
  SwitchTraffic \
  --tablet-type=replica

# Switch primary traffic (brief write pause of ~1-2 seconds)
vtctldclient --server=... \
  Reshard \
  commerce.reshard_2to4 \
  SwitchTraffic \
  --tablet-type=primary
```

**Step 6: Complete and clean up**

```bash
# Verify application is working on new shards
# Then complete the workflow (removes old shard data)
vtctldclient --server=... \
  Reshard \
  commerce.reshard_2to4 \
  complete

# Drop old shards
vtctldclient --server=... DeleteShard --recursive commerce/-80
vtctldclient --server=... DeleteShard --recursive commerce/80-
```

### Moving Tables Between Keyspaces

Moving the `product_catalog` table from an unsharded `reference` keyspace to the `commerce` keyspace:

```bash
vtctldclient --server=... \
  MoveTables \
  --source=reference \
  --tables=product_catalog \
  commerce.move_catalog \
  create

# Monitor
vtctldclient --server=... \
  MoveTables \
  commerce.move_catalog \
  status

# Switch all traffic
vtctldclient --server=... \
  MoveTables \
  commerce.move_catalog \
  SwitchTraffic

# Complete
vtctldclient --server=... \
  MoveTables \
  commerce.move_catalog \
  complete
```

## Section 6: Online DDL

Vitess supports online schema changes without locking tables, using gh-ost or pt-online-schema-change under the covers.

```sql
-- Set the DDL strategy
SET @@ddl_strategy='vitess';

-- Add a column online (non-blocking)
ALTER TABLE orders ADD COLUMN tracking_number VARCHAR(100) AFTER status;

-- Check migration status
SHOW VITESS_MIGRATIONS LIKE 'orders';

-- Cancel a running migration
ALTER VITESS_MIGRATION '<uuid>' CANCEL;

-- Retry a failed migration
ALTER VITESS_MIGRATION '<uuid>' RETRY;
```

For complex migrations via the CLI:

```bash
vtctldclient --server=... \
  ApplySchema \
  --ddl-strategy="vitess --prefer-instant-ddl" \
  --sql="ALTER TABLE orders ADD INDEX ix_status_created (status, created)" \
  commerce
```

## Section 7: Monitoring and Observability

### VTTablet Prometheus Metrics

VTTablet exposes comprehensive metrics on port 15100. Key metrics to alert on:

```yaml
# Prometheus alerts for Vitess
groups:
- name: vitess.rules
  rules:
  - alert: VTTabletQueryErrors
    expr: |
      rate(vttablet_query_counts{error!=""}[5m]) > 0.01
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "VTTablet query error rate elevated on {{ $labels.keyspace }}/{{ $labels.shard }}"

  - alert: VTTabletReplicationLag
    expr: |
      vttablet_replication_lag_seconds > 30
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Replication lag {{ $value }}s on {{ $labels.keyspace }}/{{ $labels.shard }}"

  - alert: VTTabletConnectionPoolExhausted
    expr: |
      vttablet_conn_pool_wait_count > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Connection pool exhausted on {{ $labels.instance }}"

  - alert: VTGateQueryTimeout
    expr: |
      rate(vtgate_query_counts{error="DeadlineExceeded"}[5m]) > 0.001
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "VTGate query timeouts detected"

  - alert: VReplicationLag
    expr: |
      vreplication_source_replication_lag_seconds > 60
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "VReplication lag {{ $value }}s — reshard may be stalled"
```

### Grafana Dashboard Queries

```promql
# Query latency p99 per keyspace
histogram_quantile(0.99,
  sum(rate(vttablet_query_durations_nanoseconds_bucket[5m]))
  by (keyspace, shard, le)
) / 1e9

# Queries per second by type
sum(rate(vttablet_query_counts[1m])) by (keyspace, plan_type)

# Connection pool utilization
vttablet_conn_pool_size / vttablet_conn_pool_capacity

# Replication lag heatmap
vttablet_replication_lag_seconds
```

## Section 8: Backup and Restore

Vitess uses vtbackup for online backups to object storage:

```yaml
# VitessCluster backup configuration
spec:
  backup:
    engine: xtrabackup
    locations:
    - s3:
        bucket: my-vitess-backups
        keyPrefix: commerce
        region: us-east-1
        authSecret:
          name: vitess-s3-credentials
          key: credentials
  keyspaces:
  - name: commerce
    partitionings:
    - equal:
        parts: 2
        shardTemplate:
          tabletPools:
          - type: backup
            replicas: 1
            vttablet:
              extraFlags:
                backup-engine-implementation: xtrabackup
                xtrabackup-stream-mode: xbstream
                xtrabackup-stripe-count: "4"
```

Restore from backup:

```bash
vtctldclient --server=... \
  RestoreFromBackup \
  --backup-timestamp=2031-02-28.023045 \
  us-east-0000000101
```

## Section 9: Production Tuning Checklist

Before going to production, verify these settings:

**MySQL Configuration** (applied via ConfigMap to each VTTablet):

```ini
[mysqld]
# InnoDB settings
innodb_buffer_pool_size = 6G          # ~75% of available RAM
innodb_buffer_pool_instances = 8
innodb_log_file_size = 1G
innodb_flush_log_at_trx_commit = 1    # ACID compliance
innodb_flush_method = O_DIRECT
innodb_io_capacity = 2000
innodb_io_capacity_max = 4000
innodb_read_io_threads = 8
innodb_write_io_threads = 8

# Replication
gtid_mode = ON
enforce_gtid_consistency = ON
binlog_format = ROW
binlog_row_image = MINIMAL
sync_binlog = 1                        # Durability
relay_log_recovery = ON

# Connections
max_connections = 500
wait_timeout = 28800
interactive_timeout = 28800

# Query cache (disabled for MySQL 8.0)
# Performance schema
performance_schema = ON
performance_schema_events_statements_history_long_size = 10000
```

**VTTablet Connection Pool Sizing**:

```
OLTP pool size = (CPU cores * 2) + 2
Stream pool size = 2 * OLTP pool size
Transaction cap = OLTP pool size * 1.5
```

For a 4-core VTTablet: pool=10, stream=20, transaction-cap=15.

**Kubernetes Resource Requests vs Limits**:

Always set requests equal to limits for MySQL pods to guarantee QoS class `Guaranteed`. This prevents MySQL from being throttled or OOM-killed during write spikes.

```yaml
resources:
  requests:
    cpu: 4000m
    memory: 8Gi
  limits:
    cpu: 4000m
    memory: 8Gi
```

## Section 10: Common Operational Procedures

### Planned Primary Failover

```bash
# Graceful reparent — zero data loss
vtctldclient --server=... \
  PlannedReparentShard \
  --new-primary=us-east-0000000102 \
  commerce/-40
```

### Emergency Failover

```bash
# Emergency reparent — possible data loss, use only when primary is dead
vtctldclient --server=... \
  EmergencyReparentShard \
  --new-primary=us-east-0000000102 \
  commerce/-40
```

### Tablet Maintenance

```bash
# Set tablet to drained (stop routing traffic to it)
vtctldclient --server=... \
  ChangeTabletType \
  us-east-0000000103 \
  spare

# Perform maintenance (patch node, upgrade MySQL, etc.)

# Return to service
vtctldclient --server=... \
  ChangeTabletType \
  us-east-0000000103 \
  replica
```

### Query Analysis

```bash
# Find expensive queries
vtctldclient --server=... \
  ExecuteFetchAsDBA \
  --max-rows=50 \
  us-east-0000000100 \
  "SELECT digest_text, count_star, avg_timer_wait/1e9 AS avg_ms
   FROM performance_schema.events_statements_summary_by_digest
   ORDER BY avg_timer_wait DESC LIMIT 20"
```

## Summary

Vitess on Kubernetes delivers genuinely elastic MySQL at any scale. The key operational primitives are:

- **VSchema** defines routing without application changes
- **MoveTables / Reshard** enables zero-downtime data migration
- **VTGate** provides protocol compatibility with the MySQL ecosystem
- **The Vitess Operator** automates all Day 2 operations in Kubernetes
- **VReplication** underpins all online migration workflows and must be monitored closely

With proper VSchema design (co-locating related tables on the same shard key) and connection pool tuning, Vitess clusters have been shown to handle millions of QPS across thousands of MySQL shards while maintaining sub-millisecond p99 query latency.
