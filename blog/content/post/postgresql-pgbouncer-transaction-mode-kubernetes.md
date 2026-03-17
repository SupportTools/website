---
title: "PostgreSQL Connection Pooling with PgBouncer: Transaction Mode and Kubernetes"
date: 2029-02-04T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "PgBouncer", "Kubernetes", "Database", "Performance"]
categories:
- PostgreSQL
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise production guide to deploying PgBouncer in transaction pooling mode on Kubernetes, covering pool sizing, prepared statement handling, monitoring, and high-availability configuration for PostgreSQL clusters."
more_link: "yes"
url: "/postgresql-pgbouncer-transaction-mode-kubernetes/"
---

PostgreSQL maintains one process per client connection, each consuming 5-10MB of RAM and a file descriptor. A Kubernetes deployment with 20 replicas each holding a 10-connection pool means 200 client connections to PostgreSQL — sustainable. At 100 replicas with Go's default `database/sql` pool of 25 connections, that's 2500 connections, easily overwhelming a production PostgreSQL instance. PgBouncer solves this by multiplexing thousands of application connections onto a small pool of server connections.

This guide covers PgBouncer transaction mode deployment on Kubernetes — the most aggressive pooling mode that enables the highest multiplexing ratios — including configuration for prepared statements, `SET` commands, advisory locks, and the monitoring setup required to observe pool health.

<!--more-->

## Connection Pooling Modes

PgBouncer provides three pooling modes with different compatibility/efficiency trade-offs:

| Mode | When server connection released | Multiplexing ratio | Compatibility |
|---|---|---|---|
| Session | When client disconnects | 1:1 | Full |
| Transaction | After each transaction | High (10:1 to 100:1) | Most features |
| Statement | After each statement | Highest | Limited (no multi-statement txns) |

**Transaction mode** is the production choice for microservices. Each transaction gets a server connection from the pool; between transactions, the server connection is available for other clients. A service with 1000 concurrent connections but 10 concurrent transactions uses only 10 server connections.

### Transaction Mode Incompatibilities

Transaction mode breaks features that maintain per-session state:

- `SET` commands: settings do not persist across transactions (use `SET LOCAL` instead)
- Prepared statements: must use protocol-level prepared statements or the `plan_cache_mode=force_generic_plan` workaround
- Advisory locks: released when the server connection is returned to pool
- `NOTIFY` / `LISTEN`: require dedicated session-mode connections
- `COPY` operations: require a dedicated connection or statement mode

## PgBouncer Configuration

```ini
# /etc/pgbouncer/pgbouncer.ini

[databases]
; Main application database
payments_db = host=postgres-primary.payments.svc.cluster.local \
              port=5432 \
              dbname=payments \
              auth_user=pgbouncer_auth \
              pool_size=25 \
              min_pool_size=5 \
              max_db_connections=50

; Read replica for read-heavy workloads
payments_db_ro = host=postgres-replica.payments.svc.cluster.local \
                 port=5432 \
                 dbname=payments \
                 auth_user=pgbouncer_auth \
                 pool_size=40 \
                 min_pool_size=10 \
                 max_db_connections=80

; Wildcard entry for migrations (session mode, bypasses pooling)
; Application connects to payments_admin for migrations only
payments_admin = host=postgres-primary.payments.svc.cluster.local \
                 port=5432 \
                 dbname=payments \
                 pool_mode=session \
                 pool_size=5

[pgbouncer]
; Listening
listen_addr = 0.0.0.0
listen_port = 5432

; Authentication
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
; Use auth_query for dynamic user lookup (avoids maintaining userlist.txt)
; auth_user must be able to run: SELECT usename, passwd FROM pg_shadow WHERE usename=$1
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1

; Pool settings
pool_mode = transaction
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3.0
max_client_conn = 5000
max_db_connections = 100
max_user_connections = 0

; Timeouts
server_connect_timeout = 10
server_login_retry = 15
client_login_timeout = 60
server_idle_timeout = 600
client_idle_timeout = 0
server_lifetime = 3600
server_reset_query = DISCARD ALL
server_reset_query_always = 0

; Prepared statements — enable for applications that use protocol-level prepares
max_prepared_statements = 100

; Logging
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
stats_period = 60

; Admin interface
admin_users = pgbouncer_admin
stats_users = pgbouncer_monitor, pgbouncer_admin

; TLS (server side — application → PgBouncer)
client_tls_sslmode = require
client_tls_ca_file = /etc/pgbouncer/certs/ca.crt
client_tls_cert_file = /etc/pgbouncer/certs/tls.crt
client_tls_key_file = /etc/pgbouncer/certs/tls.key
client_tls_protocols = tlsv1.3

; TLS (client side — PgBouncer → PostgreSQL)
server_tls_sslmode = verify-ca
server_tls_ca_file = /etc/pgbouncer/certs/ca.crt
server_tls_protocols = tlsv1.3

; Performance tuning
tcp_keepalive = 1
tcp_keepidle = 60
tcp_keepintvl = 30
tcp_keepcnt = 5
tcp_user_timeout = 60000
```

### User List and Auth Query Setup

```sql
-- Create the PgBouncer auth user in PostgreSQL
-- This user needs only the ability to query pg_shadow
CREATE ROLE pgbouncer_auth LOGIN PASSWORD 'use-a-strong-random-password-here';
GRANT SELECT ON pg_shadow TO pgbouncer_auth;

-- Create the monitoring user
CREATE ROLE pgbouncer_monitor LOGIN PASSWORD 'another-strong-password';

-- Create the application user
CREATE ROLE payments_app LOGIN PASSWORD 'app-password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE payments TO payments_app;
GRANT USAGE ON SCHEMA public TO payments_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO payments_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO payments_app;
```

```bash
# userlist.txt format: "username" "hashed_password"
# Passwords must match pg_shadow format (md5 or scram-sha-256)
# Generate scram-sha-256 hash using PostgreSQL
psql -c "SELECT concat('\"', usename, '\" \"', passwd, '\"') FROM pg_shadow WHERE usename IN ('payments_app', 'pgbouncer_admin');"
# Paste output into /etc/pgbouncer/userlist.txt
```

## Kubernetes Deployment

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbouncer-config
  namespace: payments
data:
  pgbouncer.ini: |
    [databases]
    payments_db = host=postgres-primary.payments.svc.cluster.local port=5432 dbname=payments auth_user=pgbouncer_auth pool_size=25 min_pool_size=5
    payments_db_ro = host=postgres-replica.payments.svc.cluster.local port=5432 dbname=payments auth_user=pgbouncer_auth pool_size=40 min_pool_size=10

    [pgbouncer]
    listen_addr = 0.0.0.0
    listen_port = 5432
    auth_type = scram-sha-256
    auth_file = /etc/pgbouncer/userlist.txt
    auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1
    pool_mode = transaction
    default_pool_size = 20
    min_pool_size = 5
    reserve_pool_size = 5
    max_client_conn = 5000
    max_db_connections = 100
    server_idle_timeout = 600
    server_lifetime = 3600
    server_reset_query = DISCARD ALL
    max_prepared_statements = 100
    stats_period = 60
    admin_users = pgbouncer_admin
    stats_users = pgbouncer_monitor
    log_connections = 0
    log_disconnections = 0
    log_pooler_errors = 1
    client_tls_sslmode = prefer
    server_tls_sslmode = verify-ca
    server_tls_ca_file = /etc/pgbouncer/certs/ca.crt
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
  namespace: payments
  labels:
    app: pgbouncer
spec:
  replicas: 3
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
        prometheus.io/port: "9127"
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
            - name: pgbouncer
              containerPort: 5432
              protocol: TCP
          env:
            - name: PGBOUNCER_AUTH_FILE
              value: /etc/pgbouncer/userlist.txt
            - name: PGBOUNCER_AUTH_TYPE
              value: scram-sha-256
          volumeMounts:
            - name: config
              mountPath: /etc/pgbouncer/pgbouncer.ini
              subPath: pgbouncer.ini
            - name: userlist
              mountPath: /etc/pgbouncer/userlist.txt
              subPath: userlist.txt
            - name: tls-certs
              mountPath: /etc/pgbouncer/certs
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          livenessProbe:
            tcpSocket:
              port: 5432
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - PGPASSWORD=$PGBOUNCER_ADMIN_PASSWORD psql -h 127.0.0.1 -p 5432 -U pgbouncer_admin pgbouncer -c "SHOW POOLS;" > /dev/null 2>&1
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3

        # Prometheus exporter sidecar
        - name: pgbouncer-exporter
          image: prometheuscommunity/pgbouncer-exporter:v0.7.0
          args:
            - --pgBouncer.connectionString=postgresql://pgbouncer_monitor:$(MONITOR_PASSWORD)@127.0.0.1:5432/pgbouncer?sslmode=disable
            - --web.listen-address=:9127
            - --web.telemetry-path=/metrics
            - --log.level=info
          ports:
            - name: metrics
              containerPort: 9127
          env:
            - name: MONITOR_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: pgbouncer-credentials
                  key: monitor-password
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 50m
              memory: 64Mi

      volumes:
        - name: config
          configMap:
            name: pgbouncer-config
        - name: userlist
          secret:
            secretName: pgbouncer-userlist
        - name: tls-certs
          secret:
            secretName: pgbouncer-tls
---
apiVersion: v1
kind: Service
metadata:
  name: pgbouncer
  namespace: payments
  labels:
    app: pgbouncer
spec:
  selector:
    app: pgbouncer
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
      protocol: TCP
  type: ClusterIP
```

## Application Configuration for Transaction Mode

Go applications using `database/sql` need specific pool configuration to work well with PgBouncer in transaction mode.

```go
package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type Config struct {
	Host            string
	Port            int
	Database        string
	User            string
	Password        string
	SSLMode         string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

func NewDB(cfg Config) (*sql.DB, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d dbname=%s user=%s password=%s sslmode=%s "+
			"application_name=payments-api "+
			// Disable pgx's prepared statement cache — PgBouncer in transaction mode
			// cannot share prepared statements across connections
			"default_query_exec_mode=simple_protocol",
		cfg.Host, cfg.Port, cfg.Database, cfg.User, cfg.Password, cfg.SSLMode,
	)

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	// Pool sizing: match PgBouncer's pool_size for this application tier
	// Excess connections beyond pool_size will queue in PgBouncer
	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)

	// Lifetime: must be less than PgBouncer's server_lifetime (3600s)
	// to avoid connection errors when PgBouncer recycles server connections
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

	// Idle timeout: must be less than PgBouncer's client_idle_timeout
	db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return db, nil
}

// ProductionConfig returns safe defaults for transaction mode PgBouncer
func ProductionConfig(host string) Config {
	return Config{
		Host:            host,
		Port:            5432,
		Database:        "payments_db",
		SSLMode:         "require",
		MaxOpenConns:    25,  // matches pgbouncer pool_size
		MaxIdleConns:    10,
		ConnMaxLifetime: 30 * time.Minute, // less than pgbouncer server_lifetime (60m)
		ConnMaxIdleTime: 5 * time.Minute,  // close idle app connections proactively
	}
}
```

### Handling Transaction Mode Limitations

```go
package repository

import (
	"context"
	"database/sql"
	"fmt"
)

type PaymentRepository struct {
	db *sql.DB
}

// WRONG: SET commands do not persist in transaction mode
func (r *PaymentRepository) BadSetExample(ctx context.Context) error {
	// This SET will not persist after the transaction ends
	// The next transaction may get a different server connection
	_, err := r.db.ExecContext(ctx, "SET search_path TO payments_schema, public")
	return err // setting is lost immediately in transaction mode
}

// CORRECT: Use SET LOCAL within a transaction — scoped to the transaction
func (r *PaymentRepository) ProcessPaymentWithSchema(ctx context.Context, paymentID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()

	// SET LOCAL: valid only within this transaction — safe with transaction mode pooling
	if _, err = tx.ExecContext(ctx, "SET LOCAL search_path TO payments_schema, public"); err != nil {
		return fmt.Errorf("setting search_path: %w", err)
	}

	if _, err = tx.ExecContext(ctx, `
		UPDATE payment SET status = 'processing', updated_at = now()
		WHERE id = $1 AND status = 'pending'
	`, paymentID); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	return tx.Commit()
}

// Advisory locks require session mode — route these through a dedicated pool
// or use a separate PgBouncer database entry with pool_mode=session
func (r *PaymentRepository) AcquireAdvisoryLock(ctx context.Context, lockID int64) error {
	// This will NOT work reliably in transaction mode:
	// pg_try_advisory_lock acquires a session-level lock
	// which is released when the server connection returns to the pool,
	// not when your transaction/session ends
	//
	// Solution: use pg_try_advisory_xact_lock (transaction-scoped) instead
	var acquired bool
	err := r.db.QueryRowContext(ctx,
		"SELECT pg_try_advisory_xact_lock($1)", lockID,
	).Scan(&acquired)
	if err != nil {
		return fmt.Errorf("acquiring advisory lock: %w", err)
	}
	if !acquired {
		return fmt.Errorf("could not acquire advisory lock %d", lockID)
	}
	return nil
}
```

## Monitoring PgBouncer

```bash
# Connect to PgBouncer admin interface
psql -h pgbouncer.payments.svc.cluster.local -p 5432 -U pgbouncer_admin pgbouncer

# Show pool status
SHOW POOLS;
# database  | user         | cl_active | cl_waiting | sv_active | sv_idle | sv_used | sv_tested | sv_login | maxwait
# payments_db | payments_app | 45        | 0          | 20        | 5       | 0       | 0         | 0        | 0

# Key metrics to watch:
# cl_waiting > 0: clients are waiting for a server connection — pool exhausted
# maxwait > 1s:   significant queuing — increase pool_size or add connections
# sv_idle = 0:    all server connections in use — at capacity

SHOW STATS;
# Shows: total requests, total received bytes, total query time, avg wait time

SHOW SERVERS;
# Shows: each server connection with state (active/idle/used) and age

SHOW CLIENTS;
# Shows: each client connection with state and wait time

# Prometheus metrics from exporter
curl -s http://pgbouncer:9127/metrics | grep -E "(cl_waiting|sv_active|maxwait|avg_query)"
```

### Grafana Alert Rules

```yaml
# PrometheusRule for PgBouncer alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pgbouncer-alerts
  namespace: payments
spec:
  groups:
    - name: pgbouncer
      interval: 30s
      rules:
        - alert: PgBouncerClientWaiting
          expr: pgbouncer_pools_cl_waiting{namespace="payments"} > 5
          for: 1m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "PgBouncer pool {{ $labels.database }} has {{ $value }} waiting clients"
            runbook: "https://runbooks.company.com/pgbouncer-pool-exhaustion"

        - alert: PgBouncerMaxWaitExceeded
          expr: pgbouncer_pools_maxwait_us{namespace="payments"} > 500000
          for: 30s
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "PgBouncer max wait time is {{ $value }}µs (>500ms)"

        - alert: PgBouncerServerConnectionsAtLimit
          expr: |
            (pgbouncer_pools_sv_active{namespace="payments"} + pgbouncer_pools_sv_idle{namespace="payments"})
            / pgbouncer_config_max_db_connections{namespace="payments"} > 0.9
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PgBouncer is using >90% of max_db_connections"
```

## Pool Sizing Calculator

```bash
# Formula for transaction mode pool sizing:
# max_server_connections = max_concurrent_transactions * 1.2 (20% headroom)
#
# Example:
# Application: 50 pods, each with 20 connections to PgBouncer
# Peak concurrent transactions: ~15 per pod = 750 concurrent transactions
# PgBouncer pool_size target: 750 * 1.2 = 900 (across all PgBouncer instances)
# PostgreSQL max_connections target: 900 + (3 PgBouncer instances * 5 reserve) = 915

# Check current PostgreSQL connection usage
psql -c "SELECT count(*), state, wait_event_type, wait_event
         FROM pg_stat_activity
         GROUP BY state, wait_event_type, wait_event
         ORDER BY count DESC;"

# Monitor connection usage over time
psql -c "SELECT now(), count(*) FROM pg_stat_activity;" -t -A \
  | awk '{print $1, $2}' >> /tmp/conn-history.log
```

PgBouncer in transaction mode with proper `database/sql` configuration reduces PostgreSQL connections by 10-50x in typical microservice deployments, deferring the need to scale PostgreSQL hardware and making horizontal application scaling no longer a database connection capacity concern.
