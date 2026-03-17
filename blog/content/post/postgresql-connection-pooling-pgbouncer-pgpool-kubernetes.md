---
title: "PostgreSQL Connection Pooling: PgBouncer and PgPool-II in Kubernetes"
date: 2029-04-07T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "PgBouncer", "PgPool", "Kubernetes", "Database", "Connection Pooling", "CloudNativePG"]
categories: ["Databases", "Kubernetes", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to PostgreSQL connection pooling with PgBouncer and PgPool-II in Kubernetes: pooling modes (session/transaction/statement), configuration, HPA for poolers, and CloudNativePG integration."
more_link: "yes"
url: "/postgresql-connection-pooling-pgbouncer-pgpool-kubernetes/"
---

PostgreSQL's process-per-connection model is a fundamental architectural constraint that becomes a scalability ceiling at production scale. Each database connection requires 5-10MB of server memory, a dedicated backend process, and non-trivial connection overhead. An application with 100 pods each opening 20 connections consumes 2000 PostgreSQL backend processes - far beyond what even a well-tuned PostgreSQL server can handle efficiently. Connection poolers solve this by multiplexing hundreds of application connections onto a small pool of long-lived server connections.

<!--more-->

# PostgreSQL Connection Pooling: PgBouncer and PgPool-II in Kubernetes

## Section 1: Connection Pooling Fundamentals

### Why PostgreSQL Needs a Pooler

```bash
# Check current connections in PostgreSQL
psql -U postgres -c "
SELECT
    state,
    count(*) as count,
    max(now() - state_change) as max_duration
FROM pg_stat_activity
GROUP BY state
ORDER BY count DESC;
"

# state            | count | max_duration
# -----------------+-------+--------------
# idle             | 1450  | 02:14:33.123
# active           | 23    | 00:00:00.045
# idle in transaction| 12  | 00:03:45.234

# 1450 idle connections consuming memory and process slots
# This is the connection explosion problem
```

PostgreSQL's `max_connections` limit is typically 100-500. Beyond this:
- Memory exhaustion from idle backend processes
- Lock contention during authentication
- Context switching overhead reducing throughput

### Pooling Modes Compared

| Mode | Session Scope | State Preserved | Prepared Statements | Use Case |
|------|--------------|-----------------|---------------------|----------|
| Session | Per connection | Yes | Yes | Legacy apps, SET, advisory locks |
| Transaction | Per transaction | No | No (unless protocol-level) | OLTP, microservices |
| Statement | Per statement | No | No | Simple read queries only |

**Transaction pooling** is the most valuable mode for modern applications. A pool of 20 server connections can serve hundreds of concurrent application connections as long as individual transactions are short.

## Section 2: PgBouncer Overview

PgBouncer is a lightweight single-purpose connection pooler. It handles TLS, authentication, and connection multiplexing with minimal overhead.

### PgBouncer Architecture

```
Application Pods (100 replicas × 5 conns = 500 app connections)
         │
    PgBouncer (pool_size=20 server connections)
         │
    PostgreSQL (max_connections=100, only 20 used)
```

## Section 3: PgBouncer on Kubernetes - Standalone Deployment

### ConfigMap for PgBouncer Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbouncer-config
  namespace: database
data:
  pgbouncer.ini: |
    [databases]
    # Pool configuration per database
    myapp = host=postgres-primary.database.svc.cluster.local port=5432 \
            dbname=myapp pool_size=20 max_db_connections=25

    myapp_ro = host=postgres-replica.database.svc.cluster.local port=5432 \
               dbname=myapp pool_size=10 max_db_connections=15

    # Wildcard: all databases use defaults
    * = host=postgres-primary.database.svc.cluster.local port=5432

    [pgbouncer]
    # Listening
    listen_addr = 0.0.0.0
    listen_port = 5432

    # Authentication
    auth_type = scram-sha-256
    auth_file = /etc/pgbouncer/userlist.txt
    # Alternative: use PostgreSQL for auth_query
    auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1

    # Pooling mode
    # session: connection held for entire session
    # transaction: connection held for transaction duration (recommended)
    # statement: connection held for single statement (very restrictive)
    pool_mode = transaction

    # Pool sizes
    # Maximum connections from clients
    max_client_conn = 1000
    # Default pool size (server connections per database/user combo)
    default_pool_size = 20
    # Reserve connections for superuser emergencies
    reserve_pool_size = 5
    # How long to wait before emergency pool activation
    reserve_pool_timeout = 5

    # Timeouts
    server_connect_timeout = 15
    server_login_retry = 15
    client_login_timeout = 60
    query_timeout = 0  # 0 = disabled (let PostgreSQL handle it)
    query_wait_timeout = 120
    client_idle_timeout = 0
    server_idle_timeout = 600
    server_lifetime = 3600

    # Connection handling
    server_reset_query = DISCARD ALL
    server_reset_query_always = 0
    ignore_startup_parameters = extra_float_digits,geqo,geqo_threshold

    # TLS to PostgreSQL
    server_tls_sslmode = require
    server_tls_protocols = secure

    # TLS for clients
    client_tls_sslmode = prefer
    client_tls_ca_file = /etc/pgbouncer/ca.crt
    client_tls_cert_file = /etc/pgbouncer/server.crt
    client_tls_key_file = /etc/pgbouncer/server.key

    # Logging
    log_connections = 0
    log_disconnections = 0
    log_pooler_errors = 1
    stats_period = 60

    # Admin interface
    admin_users = pgbouncer
    stats_users = pgbouncer,monitoring

    # unix socket for local admin access
    unix_socket_dir = /var/run/postgresql

  userlist.txt: |
    # Format: "username" "password-hash"
    # Generate with: echo -n "PASSWORDusername" | md5sum
    # Or with SCRAM: generate via psql \password command
    "appuser" "SCRAM-SHA-256$4096:..."
    "readonly" "SCRAM-SHA-256$4096:..."
```

### PgBouncer Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
  namespace: database
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pgbouncer
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: pgbouncer
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9187"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: pgbouncer
              topologyKey: kubernetes.io/hostname

      containers:
        - name: pgbouncer
          image: bitnami/pgbouncer:1.22.1
          ports:
            - containerPort: 5432
              name: postgres
          env:
            - name: POSTGRESQL_HOST
              value: "postgres-primary.database.svc.cluster.local"
            - name: POSTGRESQL_PORT
              value: "5432"
            - name: PGBOUNCER_DATABASE
              value: "myapp"
            - name: PGBOUNCER_POOL_MODE
              value: "transaction"
            - name: PGBOUNCER_MAX_CLIENT_CONN
              value: "1000"
            - name: PGBOUNCER_DEFAULT_POOL_SIZE
              value: "20"
          volumeMounts:
            - name: config
              mountPath: /etc/pgbouncer
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          readinessProbe:
            tcpSocket:
              port: 5432
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 5432
            initialDelaySeconds: 10
            periodSeconds: 30

        # Sidecar: PgBouncer exporter for Prometheus
        - name: pgbouncer-exporter
          image: spreaker/prometheus-pgbouncer-exporter:latest
          ports:
            - containerPort: 9127
              name: metrics
          env:
            - name: PGBOUNCER_EXPORTER_HOST
              value: "127.0.0.1"
            - name: PGBOUNCER_EXPORTER_PORT
              value: "6432"
            - name: PGBOUNCER_EXPORTER_USER
              value: "monitoring"
          resources:
            requests:
              cpu: 5m
              memory: 16Mi
            limits:
              cpu: 50m
              memory: 32Mi

      volumes:
        - name: config
          configMap:
            name: pgbouncer-config

---
apiVersion: v1
kind: Service
metadata:
  name: pgbouncer
  namespace: database
  labels:
    app: pgbouncer
spec:
  selector:
    app: pgbouncer
  ports:
    - port: 5432
      targetPort: 5432
      name: postgres
    - port: 9127
      targetPort: 9127
      name: metrics
```

## Section 4: PgBouncer Pool Mode Deep Dive

### Session Pooling

```ini
pool_mode = session
```

In session mode, the server connection is held for the entire client session. This provides the full PostgreSQL session semantics: `SET` commands persist, prepared statements work, advisory locks work. The only benefit over direct connection is fewer total PostgreSQL backend processes.

**When to use**: Legacy applications using session state, applications using `SET LOCAL`, applications using advisory locks, applications requiring PostgreSQL-level prepared statements.

### Transaction Pooling

```ini
pool_mode = transaction
server_reset_query = DISCARD ALL
```

The server connection is returned to the pool after each transaction. This provides maximum connection multiplexing but has important limitations:

**Incompatible features in transaction mode**:
- `SET` commands persist only within the transaction (or use `SET LOCAL`)
- Session-level prepared statements (`PREPARE`/`EXECUTE`) do not work
- Advisory locks are session-scoped and may transfer to another client
- `LISTEN`/`NOTIFY` requires session mode

**Workarounds**:
```sql
-- Instead of SET:
SET LOCAL search_path = myschema;  -- Transaction-scoped

-- Instead of PREPARE/EXECUTE, use protocol-level prepared statements
-- (driver-level prepared statements using the PostgreSQL extended query protocol)
-- These work in transaction mode with: prepare_threshold = N in PgBouncer
```

### Statement Pooling

```ini
pool_mode = statement
```

The most aggressive mode - server connection returned after each SQL statement. This means no multi-statement transactions. Only useful for analytics workloads with simple, atomic queries.

## Section 5: Optimizing PgBouncer Configuration

### Sizing the Pool

The optimal pool size per server:

```
optimal_pool_size = num_cores × 2 + effective_spindle_count
```

For a PostgreSQL server with 8 cores and SSD storage:

```ini
default_pool_size = 20  # 8 × 2 + 4 (SSD equivalent spindles)
max_db_connections = 25  # Allow some headroom
```

### Per-Database and Per-User Pools

```ini
[databases]
# Write database: smaller pool, primary
myapp_write = host=pg-primary port=5432 dbname=myapp \
              pool_size=10 max_db_connections=15

# Read database: larger pool, replica
myapp_read = host=pg-replica port=5432 dbname=myapp \
             pool_size=30 max_db_connections=40

# Batch processing: separate pool to not starve OLTP
myapp_batch = host=pg-primary port=5432 dbname=myapp \
              pool_size=5 max_db_connections=5 pool_mode=session
```

### Monitoring Pool Utilization

```sql
-- Connect to PgBouncer admin console
-- psql -h pgbouncer -p 6432 -U pgbouncer pgbouncer

-- Show pool statistics
SHOW POOLS;
-- database | user | cl_active | cl_waiting | sv_active | sv_idle | sv_login | maxwait
-- myapp    | app  | 45        | 2          | 20        | 0       | 0        | 1.2

-- cl_active: client connections currently executing queries
-- cl_waiting: clients waiting for a server connection
-- sv_active: server connections in use
-- sv_idle: server connections in pool but idle
-- maxwait: seconds the longest waiting client has been waiting

-- Show statistics
SHOW STATS;

-- Show configuration
SHOW CONFIG;

-- Live reload after config change
RELOAD;
```

## Section 6: HPA for PgBouncer Replicas

PgBouncer itself can be horizontally scaled. Use HPA based on connection count metrics:

```yaml
# ServiceMonitor for PgBouncer metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: pgbouncer
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: pgbouncer
  endpoints:
    - port: metrics
      interval: 30s

---
# Custom metrics adapter configuration
# Uses prometheus-adapter to expose PgBouncer metrics to HPA
apiVersion: custom.metrics.k8s.io/v1beta1
kind: MetricValue
# This is virtual - the actual configuration is in prometheus-adapter ConfigMap
---
# HPA based on waiting client connections
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pgbouncer-hpa
  namespace: database
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pgbouncer
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Pods
      pods:
        metric:
          name: pgbouncer_clients_waiting
        target:
          type: AverageValue
          averageValue: "5"  # Scale up when average waiting > 5

    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # Slow scale-down
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

### prometheus-adapter Configuration for PgBouncer

```yaml
# prometheus-adapter configmap
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
      - seriesQuery: 'pgbouncer_stats_clients_waiting{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace:
              resource: namespace
            pod:
              resource: pod
        name:
          matches: "^pgbouncer_stats_clients_waiting$"
          as: "pgbouncer_clients_waiting"
        metricsQuery: |
          sum(pgbouncer_stats_clients_waiting{<<.LabelMatchers>>}) by (<<.GroupBy>>)
```

## Section 7: PgPool-II for Read/Write Splitting

PgPool-II provides connection pooling plus read/write splitting, load balancing across replicas, and query cache. It is more complex than PgBouncer but adds value for read-heavy workloads.

### PgPool-II Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgpool-config
  namespace: database
data:
  pgpool.conf: |
    # Connection
    listen_addresses = '*'
    port = 5432

    # Backend nodes (PostgreSQL servers)
    backend_hostname0 = 'pg-primary.database.svc.cluster.local'
    backend_port0 = 5432
    backend_weight0 = 1
    backend_data_directory0 = '/data'
    backend_flag0 = 'ALLOW_TO_FAILOVER'
    backend_application_name0 = 'primary'

    backend_hostname1 = 'pg-replica-1.database.svc.cluster.local'
    backend_port1 = 5432
    backend_weight1 = 2  # Gets 2x the read traffic
    backend_flag1 = 'ALLOW_TO_FAILOVER'
    backend_application_name1 = 'replica-1'

    backend_hostname2 = 'pg-replica-2.database.svc.cluster.local'
    backend_port2 = 5432
    backend_weight2 = 2
    backend_flag2 = 'ALLOW_TO_FAILOVER'
    backend_application_name2 = 'replica-2'

    # Connection pooling
    connection_cache = on
    max_pool = 4
    num_init_children = 32

    # Load balancing
    load_balance_mode = on
    ignore_leading_white_space = on

    # Write to primary, reads load-balanced to replicas
    # Functions not in white list always go to primary
    read_only_function_list = ''
    white_function_list = ''
    black_function_list = 'currval,lastval,nextval,setval'

    # Statement-level load balancing
    statement_level_load_balance = off

    # Replication lag awareness
    prefer_lower_delay_standby = on
    delay_threshold = 0  # 0 = no threshold, use best replica

    # Health check
    health_check_period = 10
    health_check_timeout = 20
    health_check_user = 'pgpool_health'
    health_check_database = 'postgres'
    health_check_max_retries = 3
    health_check_retry_delay = 1

    # Failover
    failover_command = '/etc/pgpool/failover.sh %d %H %R'
    failback_command = ''
    fail_over_on_backend_error = on
    search_primary_node_timeout = 300

    # Watchdog (HA for PgPool itself)
    use_watchdog = on
    wd_hostname = ''  # Auto-detected
    wd_port = 9000
    wd_priority = 1
    delegate_ip = ''  # VIP if needed

    # Logging
    log_destination = 'stderr'
    log_line_prefix = '%t: pid %p: '
    log_connections = off
    log_disconnections = off
    log_hostname = off
    log_statement = off
    log_per_node_statement = off
    log_client_messages = off
    log_standby_delay = none
    syslog_facility = 'LOCAL0'
    syslog_ident = 'pgpool'

    # SSL
    ssl = on
    ssl_cert = '/etc/pgpool/server.crt'
    ssl_key = '/etc/pgpool/server.key'
    ssl_ca_cert = '/etc/pgpool/ca.crt'

    # Authentication
    enable_pool_hba = on
    pool_passwd = 'pool_passwd'
    authentication_timeout = 60

  pool_hba.conf: |
    # TYPE  DATABASE  USER  ADDRESS       METHOD
    host    all       all   10.0.0.0/8    scram-sha-256
    local   all       all                 trust
```

## Section 8: CloudNativePG with PgBouncer Integration

CloudNativePG (CNPG) is the recommended PostgreSQL operator for Kubernetes and has built-in PgBouncer support via the `Pooler` CRD:

```yaml
# Deploy PostgreSQL cluster with CloudNativePG
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres-cluster
  namespace: database
spec:
  instances: 3

  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "2GB"
      effective_cache_size: "6GB"
      maintenance_work_mem: "512MB"
      checkpoint_completion_target: "0.9"
      wal_buffers: "16MB"
      default_statistics_target: "100"
      random_page_cost: "1.1"
      effective_io_concurrency: "200"
      work_mem: "8MB"
      huge_pages: "off"
      min_wal_size: "1GB"
      max_wal_size: "4GB"
      max_worker_processes: "8"
      max_parallel_workers_per_gather: "4"
      max_parallel_workers: "8"
      max_parallel_maintenance_workers: "4"

  storage:
    size: 100Gi
    storageClass: fast-ssd

  resources:
    requests:
      cpu: "2"
      memory: 8Gi
    limits:
      cpu: "4"
      memory: 16Gi

  monitoring:
    enablePodMonitor: true

---
# CloudNativePG Pooler (PgBouncer managed by CNPG)
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres-rw-pooler
  namespace: database
spec:
  cluster:
    name: postgres-cluster

  # RW pooler connects to primary
  type: rw

  instances: 3

  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "1000"
      default_pool_size: "25"
      reserve_pool_size: "5"
      server_idle_timeout: "600"
      server_lifetime: "3600"
      query_wait_timeout: "120"

  # Resource limits for pooler pods
  template:
    spec:
      containers:
        - name: pgbouncer
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  cnpg.io/poolerName: postgres-rw-pooler
              topologyKey: kubernetes.io/hostname

---
# RO pooler connects to replicas for read scaling
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres-ro-pooler
  namespace: database
spec:
  cluster:
    name: postgres-cluster

  # RO pooler connects to replicas
  type: ro

  instances: 2

  pgbouncer:
    poolMode: transaction
    parameters:
      max_client_conn: "2000"
      default_pool_size: "40"
      reserve_pool_size: "5"
```

### Using the CNPG Pooler Service

```python
# Application connection string
# RW operations go to the pooler's RW service
# RO operations go to the pooler's RO service

import psycopg2
import os

# Primary (write) connection via pooler
write_conn_params = {
    "host": "postgres-rw-pooler.database.svc.cluster.local",
    "port": 5432,
    "dbname": "myapp",
    "user": "appuser",
    "password": os.environ["DB_PASSWORD"],
    "sslmode": "require",
    # Transaction pooling: disable keepalives to detect dead connections
    "keepalives": 0,
    # Disable prepared statements for transaction pooling mode
    "prepare_threshold": 0,
}

# Replica (read) connection via pooler
read_conn_params = {
    "host": "postgres-ro-pooler.database.svc.cluster.local",
    "port": 5432,
    "dbname": "myapp",
    "user": "readonly",
    "password": os.environ["DB_READONLY_PASSWORD"],
    "sslmode": "require",
    "keepalives": 0,
    "prepare_threshold": 0,
}
```

## Section 9: Application-Side Configuration

### Connection Pool Settings in Applications

```python
# SQLAlchemy with proper PgBouncer transaction mode settings
from sqlalchemy import create_engine
from sqlalchemy.pool import QueuePool

engine = create_engine(
    "postgresql+psycopg2://appuser:password@pgbouncer:5432/myapp",
    # Pool configuration at application level
    poolclass=QueuePool,
    pool_size=5,           # Keep 5 connections per pod
    max_overflow=10,       # Allow up to 10 additional on burst
    pool_pre_ping=True,    # Verify connection before use
    pool_recycle=1800,     # Recycle connections every 30 minutes
    # PgBouncer transaction mode compatibility
    execution_options={
        "isolation_level": "AUTOCOMMIT"  # Or manage transactions explicitly
    },
    connect_args={
        "keepalives": 0,
        "options": "-c statement_timeout=30000"  # 30s statement timeout
    }
)
```

### Go Database Connection Pool

```go
package database

import (
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
)

func NewDBPool(host, port, dbname, user, password string) (*sql.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%s dbname=%s user=%s password=%s sslmode=require",
        host, port, dbname, user, password,
    )

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    // Application-level connection pool settings
    // Keep 5 connections per pod × 100 pods = 500 total to PgBouncer
    // PgBouncer multiplexes these to 20 server connections
    db.SetMaxOpenConns(5)
    db.SetMaxIdleConns(2)

    // Connection lifetime: shorter than PgBouncer's server_lifetime
    // to avoid holding stale server connections
    db.SetConnMaxLifetime(30 * time.Minute)
    db.SetConnMaxIdleTime(5 * time.Minute)

    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return db, nil
}
```

## Section 10: Observability and Alerting

### Prometheus Alerts for PgBouncer

```yaml
groups:
  - name: pgbouncer_alerts
    rules:
      # Alert when clients are waiting too long for connections
      - alert: PgBouncerClientsWaiting
        expr: pgbouncer_stats_clients_waiting > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "PgBouncer has {{ $value }} clients waiting for connections"
          description: |
            PgBouncer pool {{ $labels.database }}/{{ $labels.user }} has clients
            waiting. Consider increasing pool_size or adding pooler replicas.

      # Alert when pool is exhausted (maxwait is high)
      - alert: PgBouncerPoolExhausted
        expr: pgbouncer_stats_maxwait_us > 5000000  # 5 seconds
        for: 1m
        labels:
          severity: page
        annotations:
          summary: "PgBouncer maxwait exceeds 5 seconds"

      # Alert on connection errors
      - alert: PgBouncerConnectionErrors
        expr: increase(pgbouncer_stats_total_query_count[5m]) == 0
          and pgbouncer_stats_clients_active > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PgBouncer not processing queries despite active clients"

      # PostgreSQL connection count approaching limit
      - alert: PostgreSQLConnectionsNearLimit
        expr: |
          sum(pg_stat_activity_count) /
          pg_settings_max_connections > 0.80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL connections at {{ $value | humanizePercentage }} of max"
```

## Section 11: PgBouncer vs PgPool-II Decision Matrix

| Feature | PgBouncer | PgPool-II |
|---------|-----------|-----------|
| Connection pooling | Excellent | Good |
| Operational complexity | Low | High |
| Read/write splitting | No (use service DNS) | Yes (automatic) |
| Load balancing replicas | No | Yes |
| Query cache | No | Yes (limited value) |
| HA failover | No (use Patroni/CNPG) | Yes (limited) |
| Memory footprint | Very low (~1MB) | Higher |
| Transaction mode support | Full | Limited |
| Kubernetes support | Native | Complex |
| Recommended for OLTP | Yes | Situational |

### Recommendation

For most Kubernetes deployments:

1. **Use PgBouncer** in transaction mode for OLTP workloads. Deploy via CloudNativePG's Pooler CRD for zero-effort management, or as a standalone Deployment.

2. **Use separate services for read/write routing** instead of PgPool-II's routing: one service points to the pooler connected to primary, another points to the pooler connected to replicas. Your application or service mesh handles routing.

3. **Use PgPool-II** only if you need session-level load balancing without application-side changes to implement read/write splitting.

## Summary

PostgreSQL connection pooling is not optional at scale - it is a necessity. The operational tradeoffs are:

- **Transaction pooling** with PgBouncer provides the highest connection multiplexing ratio but requires applications to avoid session-scoped features
- **Session pooling** preserves full PostgreSQL semantics but provides less multiplexing
- **CloudNativePG's Pooler CRD** provides the best Kubernetes-native PgBouncer management with automatic TLS, monitoring, and lifecycle management
- **Application-side pool settings** must be tuned to avoid overwhelming PgBouncer: 5-10 connections per pod is typically sufficient when PgBouncer is handling the multiplexing
- **HPA based on waiting client count** provides dynamic scaling of PgBouncer capacity under load spikes
