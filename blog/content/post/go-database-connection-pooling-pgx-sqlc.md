---
title: "Go Database Connection Pooling: pgx, database/sql, and sqlc"
date: 2029-06-22T00:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "pgx", "sqlc", "Database", "Performance", "Connection Pooling"]
categories: ["Go", "Database"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go database connection pooling covering pgx v5 pool configuration, database/sql maxOpenConns tuning, sqlc type-safe query generation, connection lifetime management, and health checking strategies for production systems."
more_link: "yes"
url: "/go-database-connection-pooling-pgx-sqlc/"
---

Database connection pooling is one of the most impactful performance and reliability factors in Go services that interact with PostgreSQL. Misconfigured connection pools cause connection exhaustion under load, excessive reconnect overhead during traffic spikes, and stale connections that fail without useful diagnostics. This guide covers the three primary patterns used in production Go services: `pgx/v5` pool directly, `database/sql` with pgx driver, and `sqlc` for type-safe queries — with concrete tuning numbers drawn from real workloads.

<!--more-->

# Go Database Connection Pooling: pgx, database/sql, and sqlc

## Section 1: Understanding PostgreSQL Connection Limits

Before configuring your pool, understand what PostgreSQL can handle. Each connection consumes approximately 10MB of RAM in PostgreSQL plus operating system resources.

```sql
-- Check current connection limits
SHOW max_connections;
-- Typical production value: 200-500

-- Check connection memory parameters
SHOW work_mem;           -- Per-sort memory: 4MB default
SHOW shared_buffers;     -- Shared cache: 128MB default, should be 25% of RAM

-- Monitor current connections
SELECT count(*), state, wait_event_type, wait_event
FROM pg_stat_activity
GROUP BY state, wait_event_type, wait_event
ORDER BY count DESC;

-- Check connections per database
SELECT datname, count(*) as connections,
       max_conn, max_conn - count(*) as available
FROM pg_stat_activity
JOIN pg_database ON pg_database.datname = pg_stat_activity.datname
GROUP BY datname, max_conn;
```

### Connection Budget Calculation

```
Total PostgreSQL max_connections: 200

Allocate:
  - 5 for superuser connections (reserved)
  - 10 for monitoring/metrics (Prometheus, pgBouncer)
  - 10 for migrations/admin tools
  - Remaining 175 for application pools

With 3 application replicas:
  - 175 / 3 = ~58 connections per replica
  - Use 50 max to leave headroom for restart overlap
  - Set min/idle to 10-20

With PgBouncer in transaction mode:
  - Connections to PostgreSQL: 100-150 (pgBouncer server_pool_size)
  - Application to PgBouncer: Can be much higher (1000+)
```

---

## Section 2: pgx v5 Pool Configuration

`pgx/v5/pgxpool` is the highest-performance option for PostgreSQL-specific workloads. It provides native PostgreSQL protocol support without the `database/sql` abstraction overhead.

### Basic Pool Setup

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/jackc/pgx/v5/tracelog"
)

type Config struct {
    DSN             string
    MaxConns        int32
    MinConns        int32
    MaxConnLifetime time.Duration
    MaxConnIdleTime time.Duration
    HealthCheckPeriod time.Duration
}

func DefaultConfig(dsn string) Config {
    return Config{
        DSN:               dsn,
        MaxConns:          50,
        MinConns:          10,
        MaxConnLifetime:   30 * time.Minute,
        MaxConnIdleTime:   5 * time.Minute,
        HealthCheckPeriod: 1 * time.Minute,
    }
}

func NewPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
    poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("parse database config: %w", err)
    }

    // Pool sizing
    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns

    // Connection lifetime management
    poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
    poolCfg.MaxConnLifetimeJitter = 30 * time.Second  // Prevent thundering herd
    poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

    // Connection setup hook: set session parameters
    poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
        // Set application name for pg_stat_activity
        _, err := conn.Exec(ctx,
            "SET application_name = 'my-service'")
        if err != nil {
            return fmt.Errorf("set application_name: %w", err)
        }

        // Set statement timeout to prevent runaway queries
        _, err = conn.Exec(ctx,
            "SET statement_timeout = '30s'")
        if err != nil {
            return fmt.Errorf("set statement_timeout: %w", err)
        }

        // Set lock timeout
        _, err = conn.Exec(ctx,
            "SET lock_timeout = '5s'")
        return err
    }

    // BeforeAcquire: validate connection before giving to caller
    poolCfg.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Return false to discard the connection (triggers reconnect)
        return conn.Ping(ctx) == nil
    }

    // AfterRelease: reset connection state before returning to pool
    poolCfg.AfterRelease = func(conn *pgx.Conn) bool {
        // If connection is in error state, discard it
        if conn.IsClosed() {
            return false
        }
        return true
    }

    // Connect tracer for debugging (disable in production or use sampling)
    if false { // Enable only when debugging connection issues
        poolCfg.ConnConfig.Tracer = &tracelog.TraceLog{
            Logger:   tracelog.LoggerFunc(func(ctx context.Context, level tracelog.LogLevel, msg string, data map[string]interface{}) {
                fmt.Printf("[pgx] %s %v\n", msg, data)
            }),
            LogLevel: tracelog.LogLevelDebug,
        }
    }

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil {
        return nil, fmt.Errorf("create pool: %w", err)
    }

    // Verify connectivity
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("ping database: %w", err)
    }

    return pool, nil
}
```

### Pool Monitoring

```go
package database

import (
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

type PoolMetrics struct {
    totalConns    prometheus.Gauge
    idleConns     prometheus.Gauge
    acquiredConns prometheus.Gauge
    waitingConns  prometheus.Gauge
    maxConns      prometheus.Gauge
    acquireCount  prometheus.Counter
    acquireDuration prometheus.Histogram
}

func NewPoolMetrics(pool *pgxpool.Pool, serviceName string) *PoolMetrics {
    labels := prometheus.Labels{"service": serviceName}

    m := &PoolMetrics{
        totalConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_total_connections",
            Help:        "Total number of connections in the pool",
            ConstLabels: labels,
        }),
        idleConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_idle_connections",
            Help:        "Number of idle connections",
            ConstLabels: labels,
        }),
        acquiredConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_acquired_connections",
            Help:        "Number of currently acquired connections",
            ConstLabels: labels,
        }),
        acquireCount: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_acquire_total",
            Help:        "Total number of connection acquisitions",
            ConstLabels: labels,
        }),
        acquireDuration: promauto.NewHistogram(prometheus.HistogramOpts{
            Name:        "db_pool_acquire_duration_seconds",
            Help:        "Time spent waiting to acquire a connection",
            ConstLabels: labels,
            Buckets:     []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
        }),
    }

    // Start background metrics collection
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            stats := pool.Stat()
            m.totalConns.Set(float64(stats.TotalConns()))
            m.idleConns.Set(float64(stats.IdleConns()))
            m.acquiredConns.Set(float64(stats.AcquiredConns()))
        }
    }()

    return m
}
```

---

## Section 3: database/sql with pgx Driver

`database/sql` is the standard interface, compatible with any tool that accepts `*sql.DB`. Use it when you need compatibility with sqlx, GORM, or other ORMs.

```go
package database

import (
    "database/sql"
    "fmt"
    "time"

    _ "github.com/jackc/pgx/v5/stdlib"  // pgx stdlib driver
)

type SQLConfig struct {
    DSN                string
    MaxOpenConns       int
    MaxIdleConns       int
    ConnMaxLifetime    time.Duration
    ConnMaxIdleTime    time.Duration
}

func DefaultSQLConfig(dsn string) SQLConfig {
    return SQLConfig{
        DSN:             dsn,
        MaxOpenConns:    50,
        MaxIdleConns:    25,
        ConnMaxLifetime: 30 * time.Minute,
        ConnMaxIdleTime: 5 * time.Minute,
    }
}

func NewDB(cfg SQLConfig) (*sql.DB, error) {
    db, err := sql.Open("pgx", cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("open database: %w", err)
    }

    // CRITICAL: Always set these. Defaults (unlimited) will exhaust PostgreSQL.
    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

    // Verify connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return nil, fmt.Errorf("ping database: %w", err)
    }

    return db, nil
}
```

### Understanding database/sql Pool Behavior

```go
// MaxOpenConns vs MaxIdleConns interaction
//
// MaxOpenConns: Hard limit on total connections (in-use + idle)
// MaxIdleConns: How many idle connections to keep warm
//
// If MaxIdleConns > MaxOpenConns, MaxIdleConns is reduced to MaxOpenConns
//
// Recommended: MaxIdleConns = MaxOpenConns / 2
//
// ConnMaxLifetime: Forces connection close after N time from creation
//   - Prevents stale connections after network config changes
//   - Should be less than PostgreSQL's tcp_keepalives_idle
//   - Recommended: 30 minutes
//
// ConnMaxIdleTime: Forces close of idle connections after N time
//   - Reduces connection count during low traffic
//   - Recommended: 5-10 minutes

package main

import (
    "database/sql"
    "expvar"
    "time"
)

// Export pool stats to expvar for debugging
func exportPoolStats(db *sql.DB, name string) {
    stats := expvar.NewMap(name)

    go func() {
        for {
            s := db.Stats()
            stats.Set("open_connections", expvar.Func(func() interface{} {
                return db.Stats().OpenConnections
            }))
            stats.Set("in_use", expvar.Func(func() interface{} {
                return db.Stats().InUse
            }))
            stats.Set("idle", expvar.Func(func() interface{} {
                return db.Stats().Idle
            }))
            stats.Set("wait_count", expvar.Func(func() interface{} {
                return db.Stats().WaitCount
            }))
            stats.Set("wait_duration_ms", expvar.Func(func() interface{} {
                return db.Stats().WaitDuration.Milliseconds()
            }))
            stats.Set("max_idle_closed", expvar.Func(func() interface{} {
                return db.Stats().MaxIdleClosed
            }))
            stats.Set("max_lifetime_closed", expvar.Func(func() interface{} {
                return db.Stats().MaxLifetimeClosed
            }))
            _ = s
            time.Sleep(15 * time.Second)
        }
    }()
}
```

### Diagnosing Pool Problems via Stats

```go
func diagnosePool(db *sql.DB) {
    stats := db.Stats()

    fmt.Printf("Pool Statistics:\n")
    fmt.Printf("  OpenConnections: %d (MaxOpenConns: %d)\n",
        stats.OpenConnections, stats.MaxOpenConns)
    fmt.Printf("  InUse: %d\n", stats.InUse)
    fmt.Printf("  Idle: %d\n", stats.Idle)
    fmt.Printf("  WaitCount: %d\n", stats.WaitCount)
    fmt.Printf("  WaitDuration: %v\n", stats.WaitDuration)

    // Diagnose issues
    if stats.OpenConnections == stats.MaxOpenConns {
        fmt.Println("WARNING: Pool is at maximum capacity — consider increasing MaxOpenConns")
    }

    if stats.WaitCount > 0 {
        avgWait := time.Duration(0)
        if stats.WaitCount > 0 {
            avgWait = stats.WaitDuration / time.Duration(stats.WaitCount)
        }
        fmt.Printf("WARNING: %d requests waited for connection, avg wait: %v\n",
            stats.WaitCount, avgWait)
    }

    if float64(stats.MaxLifetimeClosed)/float64(stats.OpenConnections+stats.MaxLifetimeClosed) > 0.1 {
        fmt.Println("INFO: High lifetime-close rate — consider increasing ConnMaxLifetime")
    }

    if float64(stats.MaxIdleClosed)/float64(stats.OpenConnections+stats.MaxIdleClosed) > 0.3 {
        fmt.Println("INFO: High idle-close rate — consider reducing MaxIdleConns")
    }
}
```

---

## Section 4: sqlc — Type-Safe SQL Queries

`sqlc` generates Go code from SQL query files, providing compile-time type safety without the overhead of an ORM or the danger of hand-written query builders.

### Installation and Setup

```bash
# Install sqlc
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

# Project structure
mkdir -p db/queries db/migrations

# Create sqlc.yaml
cat > sqlc.yaml <<'EOF'
version: "2"
sql:
- engine: "postgresql"
  queries: "db/queries/"
  schema: "db/migrations/"
  gen:
    go:
      package: "store"
      out: "internal/store"
      emit_json_tags: true
      emit_db_tags: true
      emit_interface: true
      emit_exact_table_names: false
      emit_empty_slices: true
      overrides:
      - db_type: "uuid"
        go_type: "github.com/google/uuid.UUID"
      - db_type: "timestamptz"
        go_type: "time.Time"
      - db_type: "jsonb"
        go_type: "encoding/json.RawMessage"
EOF
```

### Schema Definition

```sql
-- db/migrations/001_users.sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       VARCHAR(255) NOT NULL UNIQUE,
    name        VARCHAR(255) NOT NULL,
    role        VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_role ON users(role) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  BYTEA NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address  INET
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Query Definitions

```sql
-- db/queries/users.sql

-- name: CreateUser :one
INSERT INTO users (email, name, role)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users
WHERE id = $1 AND deleted_at IS NULL;

-- name: GetUserByEmail :one
SELECT * FROM users
WHERE email = $1 AND deleted_at IS NULL;

-- name: ListUsers :many
SELECT * FROM users
WHERE deleted_at IS NULL
  AND ($1::varchar IS NULL OR role = $1)
ORDER BY created_at DESC
LIMIT $2
OFFSET $3;

-- name: CountUsers :one
SELECT COUNT(*) FROM users
WHERE deleted_at IS NULL
  AND ($1::varchar IS NULL OR role = $1);

-- name: UpdateUser :one
UPDATE users
SET name = $2,
    role = $3,
    updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: SoftDeleteUser :exec
UPDATE users
SET deleted_at = NOW()
WHERE id = $1 AND deleted_at IS NULL;

-- name: GetUserWithSessions :many
SELECT
    u.id as user_id,
    u.email,
    u.name,
    u.role,
    s.id as session_id,
    s.expires_at,
    s.ip_address
FROM users u
LEFT JOIN sessions s ON s.user_id = u.id
    AND s.expires_at > NOW()
WHERE u.id = $1 AND u.deleted_at IS NULL;

-- name: BatchCreateUsers :copyfrom
INSERT INTO users (email, name, role)
VALUES ($1, $2, $3);
```

### Generated Code Usage

```bash
# Generate Go code from SQL
sqlc generate

# This creates:
# internal/store/db.go         - DBTX interface
# internal/store/models.go     - Struct types matching tables
# internal/store/users.sql.go  - Type-safe query functions
# internal/store/querier.go    - Interface for mocking
```

### Repository Pattern with sqlc

```go
package repository

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v5/pgxpool"

    "myapp/internal/store"
)

type UserRepository struct {
    pool    *pgxpool.Pool
    queries *store.Queries
}

func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
    return &UserRepository{
        pool:    pool,
        queries: store.New(pool),
    }
}

func (r *UserRepository) Create(ctx context.Context, email, name, role string) (store.User, error) {
    user, err := r.queries.CreateUser(ctx, store.CreateUserParams{
        Email: email,
        Name:  name,
        Role:  role,
    })
    if err != nil {
        return store.User{}, fmt.Errorf("create user: %w", err)
    }
    return user, nil
}

func (r *UserRepository) FindByID(ctx context.Context, id uuid.UUID) (store.User, error) {
    user, err := r.queries.GetUserByID(ctx, id)
    if err != nil {
        return store.User{}, fmt.Errorf("find user %s: %w", id, err)
    }
    return user, nil
}

func (r *UserRepository) List(ctx context.Context, role *string, limit, offset int) ([]store.User, int64, error) {
    users, err := r.queries.ListUsers(ctx, store.ListUsersParams{
        Column1: role, // nullable role filter
        Limit:   int32(limit),
        Offset:  int32(offset),
    })
    if err != nil {
        return nil, 0, fmt.Errorf("list users: %w", err)
    }

    count, err := r.queries.CountUsers(ctx, role)
    if err != nil {
        return nil, 0, fmt.Errorf("count users: %w", err)
    }

    return users, count, nil
}

// WithTransaction runs operations in a transaction
func (r *UserRepository) WithTransaction(ctx context.Context, fn func(ctx context.Context, q *store.Queries) error) error {
    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return fmt.Errorf("acquire connection: %w", err)
    }
    defer conn.Release()

    tx, err := conn.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer func() {
        if err != nil {
            _ = tx.Rollback(ctx)
        }
    }()

    qtx := r.queries.WithTx(tx)
    if err = fn(ctx, qtx); err != nil {
        return err
    }

    if err = tx.Commit(ctx); err != nil {
        return fmt.Errorf("commit transaction: %w", err)
    }
    return nil
}
```

---

## Section 5: Health Checks and Connection Recovery

```go
package database

import (
    "context"
    "sync/atomic"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

type HealthChecker struct {
    pool      *pgxpool.Pool
    healthy   atomic.Bool
    lastCheck atomic.Value // time.Time
    lastError atomic.Value // error
}

func NewHealthChecker(pool *pgxpool.Pool) *HealthChecker {
    hc := &HealthChecker{pool: pool}
    hc.healthy.Store(true)
    hc.lastCheck.Store(time.Now())
    go hc.runChecks()
    return hc
}

func (hc *HealthChecker) runChecks() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    for range ticker.C {
        hc.check()
    }
}

func (hc *HealthChecker) check() {
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel()

    err := hc.pool.Ping(ctx)
    hc.lastCheck.Store(time.Now())

    if err != nil {
        hc.healthy.Store(false)
        hc.lastError.Store(err)
        return
    }

    // Check pool stats — if all connections are in-use, we're under stress
    stats := hc.pool.Stat()
    if stats.IdleConns() == 0 && stats.AcquiredConns() >= stats.MaxConns() {
        // Pool exhausted, but connections still work
        hc.healthy.Store(false)
        hc.lastError.Store(fmt.Errorf("pool exhausted: %d/%d connections in use",
            stats.AcquiredConns(), stats.MaxConns()))
        return
    }

    hc.healthy.Store(true)
    hc.lastError.Store(nil)
}

func (hc *HealthChecker) IsHealthy() bool {
    return hc.healthy.Load()
}

func (hc *HealthChecker) LastError() error {
    if err := hc.lastError.Load(); err != nil {
        if e, ok := err.(error); ok {
            return e
        }
    }
    return nil
}

// HTTP handler for Kubernetes readiness probe
func (hc *HealthChecker) ReadinessHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if hc.IsHealthy() {
            w.WriteHeader(http.StatusOK)
            w.Write([]byte("ok"))
            return
        }
        w.WriteHeader(http.StatusServiceUnavailable)
        if err := hc.LastError(); err != nil {
            w.Write([]byte(err.Error()))
        }
    }
}
```

---

## Section 6: Retry Logic for Transient Failures

```go
package database

import (
    "context"
    "errors"
    "time"

    "github.com/jackc/pgx/v5/pgconn"
    "github.com/jackc/pgx/v5/pgxpool"
)

// IsRetryable returns true for PostgreSQL errors that warrant a retry.
func IsRetryable(err error) bool {
    if err == nil {
        return false
    }

    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        switch pgErr.Code {
        case "40001": // serialization_failure
            return true
        case "40P01": // deadlock_detected
            return true
        case "57P01": // admin_shutdown
            return true
        case "57P02": // crash_shutdown
            return true
        case "57P03": // cannot_connect_now (startup)
            return true
        case "08000", "08003", "08006", "08001", "08004": // connection errors
            return true
        }
    }

    // Context errors are not retryable
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        return false
    }

    return false
}

// RetryableOperation runs fn with exponential backoff for retryable errors.
func RetryableOperation(ctx context.Context, maxAttempts int, fn func(ctx context.Context) error) error {
    backoff := 100 * time.Millisecond
    for attempt := 1; attempt <= maxAttempts; attempt++ {
        err := fn(ctx)
        if err == nil {
            return nil
        }

        if !IsRetryable(err) || attempt == maxAttempts {
            return fmt.Errorf("after %d attempt(s): %w", attempt, err)
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(backoff):
        }

        backoff *= 2
        if backoff > 5*time.Second {
            backoff = 5 * time.Second
        }
    }
    return nil
}
```

---

## Section 7: PgBouncer Integration

For high-connection-count scenarios, add PgBouncer as a connection multiplexer:

```ini
# pgbouncer.ini
[databases]
myapp = host=postgres.production.svc.cluster.local port=5432 dbname=myapp

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Transaction pooling: best performance, but no session-level features
pool_mode = transaction

# Server connections (to PostgreSQL)
max_client_conn = 1000
default_pool_size = 100
min_pool_size = 20
reserve_pool_size = 10

# Connection lifetime
server_lifetime = 1800    # 30 minutes
server_idle_timeout = 600 # 10 minutes
client_idle_timeout = 0   # No client timeout

# Log
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
stats_period = 60
```

With PgBouncer in transaction mode, your Go pool settings change:

```go
// Application pool settings when using PgBouncer (transaction mode)
cfg := SQLConfig{
    DSN:             "postgres://user:pass@pgbouncer:5432/myapp",
    MaxOpenConns:    100,  // Can be higher, PgBouncer manages the real limit
    MaxIdleConns:    50,
    ConnMaxLifetime: 5 * time.Minute,   // Shorter — PgBouncer recycles
    ConnMaxIdleTime: 2 * time.Minute,
}

// IMPORTANT: In transaction mode, these CANNOT be used:
// - Prepared statements (unless tracked by PgBouncer with prepared_statement_cache_queries)
// - SET session parameters
// - LISTEN/NOTIFY
// - Advisory locks
// - Temporary tables
```

---

## Section 8: Query Timeout and Context Management

```go
package middleware

import (
    "context"
    "net/http"
    "time"
)

// DatabaseTimeout adds a query timeout to the context.
// Use this as HTTP middleware or wrap database calls directly.
func DatabaseTimeout(timeout time.Duration, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx, cancel := context.WithTimeout(r.Context(), timeout)
        defer cancel()
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Usage in query:
func (r *UserRepository) FindByIDWithTimeout(ctx context.Context, id uuid.UUID) (store.User, error) {
    // Add per-query deadline on top of any existing context deadline
    queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    user, err := r.queries.GetUserByID(queryCtx, id)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            return store.User{}, fmt.Errorf("query timed out after 5s: %w", err)
        }
        return store.User{}, err
    }
    return user, nil
}
```

### Connection Pool Tuning Reference

| Scenario | MaxOpenConns | MaxIdleConns | MaxLifetime | MaxIdleTime |
|---|---|---|---|---|
| Low traffic (< 50 RPS) | 10 | 5 | 30m | 5m |
| Medium traffic (50-500 RPS) | 25-50 | 10-25 | 30m | 5m |
| High traffic (500+ RPS) | 50-100 | 25-50 | 15m | 2m |
| Batch processor | 5-10 | 2-5 | 1h | 15m |
| With PgBouncer | 50-200 | 25-100 | 5m | 1m |

The most common mistake is leaving MaxOpenConns at the default (unlimited), which allows a sudden traffic spike to open hundreds of connections to PostgreSQL simultaneously, overwhelming it. Always set an explicit limit based on your PostgreSQL connection budget.
