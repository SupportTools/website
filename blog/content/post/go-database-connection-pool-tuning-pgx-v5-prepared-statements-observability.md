---
title: "Go Database Connection Pool Tuning: pgx v5, Connection Lifecycle, Prepared Statements, and Observability"
date: 2032-04-14T00:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "pgx", "Connection Pool", "Database", "Observability", "Performance"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to tuning PostgreSQL connection pools in Go using pgx v5, covering pool configuration, connection lifecycle management, prepared statement caching, transaction handling, and full observability with Prometheus metrics."
more_link: "yes"
url: "/go-database-connection-pool-tuning-pgx-v5-prepared-statements-observability/"
---

Poorly tuned database connection pools are one of the most common causes of latency spikes and cascading failures in production Go services. The pgx v5 library provides a highly capable PostgreSQL driver and connection pool, but extracting maximum performance requires understanding pool sizing, connection lifecycle, prepared statement caching, and how to surface pool metrics for observability.

<!--more-->

## pgx v5 Architecture

pgx v5 introduced significant architectural changes from v4. The major components are:

- **`pgx/v5`**: Core driver with `pgx.Conn` for single connections
- **`pgx/v5/pgxpool`**: Built-in connection pool using `pgxpool.Pool`
- **`pgx/v5/pgconn`**: Low-level connection abstraction
- **`pgx/v5/stdlib`**: `database/sql` compatibility layer

For production services, `pgxpool` is the correct choice. The `database/sql` compatibility layer adds overhead and loses pgx-specific features like `pgx.Rows.RawValues()`, named arguments, and batch queries.

### Installation

```bash
go get github.com/jackc/pgx/v5
go get github.com/jackc/pgx/v5/pgxpool
```

---

## Pool Configuration

### Core Pool Parameters

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

// Config holds all pool configuration for a PostgreSQL connection pool.
type Config struct {
    DSN              string
    MaxConns         int32
    MinConns         int32
    MaxConnLifetime  time.Duration
    MaxConnIdleTime  time.Duration
    HealthCheckPeriod time.Duration
    ConnectTimeout   time.Duration
}

// DefaultConfig returns a production-ready default configuration.
// Callers should override MaxConns based on workload profiling.
func DefaultConfig(dsn string) Config {
    return Config{
        DSN:               dsn,
        MaxConns:          25,
        MinConns:          5,
        MaxConnLifetime:   30 * time.Minute,
        MaxConnIdleTime:   5 * time.Minute,
        HealthCheckPeriod: 1 * time.Minute,
        ConnectTimeout:    5 * time.Second,
    }
}

// NewPool creates a configured pgxpool.Pool with the given Config.
func NewPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
    poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("parsing pool config: %w", err)
    }

    // Pool sizing
    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns

    // Connection lifecycle
    poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
    poolCfg.MaxConnLifetimeJitter = 30 * time.Second // Prevent thundering herd on mass expiry
    poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

    // Connect timeout
    poolCfg.ConnConfig.ConnectConfig.Fallbacks = nil // disable multi-host fallback latency
    poolCfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    // Verify connectivity
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("initial ping failed: %w", err)
    }

    return pool, nil
}
```

### Pool Sizing Calculations

The formula for optimal MaxConns is empirical, but the following guidelines apply to most OLTP workloads:

```
MaxConns = (num_cores * 2) + effective_spindle_count

For SSDs and NVMe:
MaxConns = num_cores + 1  (often sufficient)

For cloud PostgreSQL (RDS, Cloud SQL, AlloyDB):
MaxConns = min(db_max_connections * 0.8 / num_app_instances, 25)
```

For a service with 4 instances connecting to an RDS db.r6g.2xlarge (max_connections=1000):

```
MaxConns per instance = (1000 * 0.8) / 4 = 200
// But 200 is too high for most OLTP patterns
// Cap at 25-50 and use pgBouncer or RDS Proxy for >100 connections
```

### Pool Configuration via Environment Variables

```go
package database

import (
    "fmt"
    "os"
    "strconv"
    "time"
)

// ConfigFromEnv reads pool configuration from environment variables.
// Required env vars:
//   DB_DSN - full connection string
// Optional env vars (with defaults):
//   DB_MAX_CONNS       (default: 25)
//   DB_MIN_CONNS       (default: 5)
//   DB_MAX_CONN_LIFE   (default: 30m)
//   DB_MAX_CONN_IDLE   (default: 5m)
func ConfigFromEnv() (Config, error) {
    dsn := os.Getenv("DB_DSN")
    if dsn == "" {
        return Config{}, fmt.Errorf("DB_DSN is required")
    }

    cfg := DefaultConfig(dsn)

    if v := os.Getenv("DB_MAX_CONNS"); v != "" {
        n, err := strconv.ParseInt(v, 10, 32)
        if err != nil {
            return Config{}, fmt.Errorf("parsing DB_MAX_CONNS: %w", err)
        }
        cfg.MaxConns = int32(n)
    }

    if v := os.Getenv("DB_MIN_CONNS"); v != "" {
        n, err := strconv.ParseInt(v, 10, 32)
        if err != nil {
            return Config{}, fmt.Errorf("parsing DB_MIN_CONNS: %w", err)
        }
        cfg.MinConns = int32(n)
    }

    if v := os.Getenv("DB_MAX_CONN_LIFE"); v != "" {
        d, err := time.ParseDuration(v)
        if err != nil {
            return Config{}, fmt.Errorf("parsing DB_MAX_CONN_LIFE: %w", err)
        }
        cfg.MaxConnLifetime = d
    }

    if v := os.Getenv("DB_MAX_CONN_IDLE"); v != "" {
        d, err := time.ParseDuration(v)
        if err != nil {
            return Config{}, fmt.Errorf("parsing DB_MAX_CONN_IDLE: %w", err)
        }
        cfg.MaxConnIdleTime = d
    }

    return cfg, nil
}
```

---

## Connection Lifecycle Hooks

pgxpool provides hooks for connection creation, acquisition, and release. These are essential for setting session-level parameters and tracing.

### BeforeConnect and AfterConnect Hooks

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

// NewPoolWithHooks creates a pool with full lifecycle hooks.
func NewPoolWithHooks(ctx context.Context, cfg Config, tracer trace.Tracer) (*pgxpool.Pool, error) {
    poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }

    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns
    poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
    poolCfg.MaxConnLifetimeJitter = 30 * time.Second
    poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

    // AfterConnect is called every time a new connection is established.
    // Use this to set session-level parameters that must be set per connection.
    poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
        // Set statement timeout to prevent runaway queries
        _, err := conn.Exec(ctx, "SET statement_timeout = '30s'")
        if err != nil {
            return fmt.Errorf("setting statement_timeout: %w", err)
        }

        // Set lock timeout
        _, err = conn.Exec(ctx, "SET lock_timeout = '5s'")
        if err != nil {
            return fmt.Errorf("setting lock_timeout: %w", err)
        }

        // Set application_name for pg_stat_activity visibility
        _, err = conn.Exec(ctx, "SET application_name = 'api-server'")
        if err != nil {
            return fmt.Errorf("setting application_name: %w", err)
        }

        // Set work_mem for complex queries (override per-query as needed)
        _, err = conn.Exec(ctx, "SET work_mem = '16MB'")
        if err != nil {
            return fmt.Errorf("setting work_mem: %w", err)
        }

        return nil
    }

    // BeforeAcquire is called before a connection is returned from the pool.
    // Return false to discard the connection and get another.
    poolCfg.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Verify the connection is still alive
        // This adds latency but catches stale connections early
        return conn.Ping(ctx) == nil
    }

    // AfterRelease is called when a connection is returned to the pool.
    // Return false to destroy the connection instead of returning it.
    poolCfg.AfterRelease = func(conn *pgx.Conn) bool {
        // Discard connections that have been idle too long
        // pgxpool handles MaxConnIdleTime, but custom logic can go here
        return true
    }

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    return pool, nil
}
```

### Connection Reset Between Requests

For multi-tenant applications where session state must not leak between requests:

```go
// ResetSession resets session state that could leak between requests.
// Call this in your middleware or at the start of each request handler
// when using a long-lived connection.
func ResetSession(ctx context.Context, conn *pgxpool.Conn) error {
    queries := []string{
        "RESET search_path",
        "RESET application_name",
        "DISCARD SEQUENCES",
        // Do NOT discard prepared statements - they are connection-scoped and beneficial
    }

    for _, q := range queries {
        if _, err := conn.Exec(ctx, q); err != nil {
            return fmt.Errorf("resetting session with %q: %w", q, err)
        }
    }

    return nil
}

// WithTenantContext acquires a connection and sets the tenant search path.
func WithTenantContext(ctx context.Context, pool *pgxpool.Pool, tenantSchema string, fn func(*pgxpool.Conn) error) error {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    // Set tenant-specific search path
    if _, err := conn.Exec(ctx, fmt.Sprintf("SET search_path = %s, public", pgx.Identifier{tenantSchema}.Sanitize())); err != nil {
        return fmt.Errorf("setting search_path: %w", err)
    }

    return fn(conn)
}
```

---

## Prepared Statement Caching

pgx v5 offers three query execution modes with different prepared statement behaviors:

| Mode | Description | Use Case |
|---|---|---|
| `QueryExecModeSimpleProtocol` | No prepared statements | pgBouncer transaction mode |
| `QueryExecModeCacheDescribe` | Caches column descriptions, no server-side prepare | PgBouncer session mode |
| `QueryExecModeDescribeExec` | Describes then executes, per-query | Dynamic queries |
| `QueryExecModeCachedPlan` | Server-side prepared statements, cached | Repeated queries with same structure |

### Explicit Prepared Statements

For hot query paths, explicitly prepared statements eliminate parsing overhead on every execution:

```go
package repository

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// UserRepository manages user data with prepared statements.
type UserRepository struct {
    pool *pgxpool.Pool
}

// Prepared statement names - use constants to prevent typos
const (
    stmtGetUserByID    = "get_user_by_id"
    stmtGetUsersByTeam = "get_users_by_team"
    stmtUpdateUserRole = "update_user_role"
    stmtInsertUser     = "insert_user"
)

// NewUserRepository creates the repository and prepares statements.
// Note: with pgxpool, statements must be prepared per-connection.
// Use BeforeAcquire hook or prepare lazily on first use.
func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
    return &UserRepository{pool: pool}
}

// GetUserByID retrieves a user by ID using a prepared statement.
// pgx caches the statement description for the connection.
func (r *UserRepository) GetUserByID(ctx context.Context, id int64) (*User, error) {
    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return nil, fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    // Prepare statement on this specific connection if not already prepared
    // pgx tracks prepared statements per connection
    _, err = conn.Conn().Prepare(ctx, stmtGetUserByID,
        `SELECT id, email, name, role, created_at, updated_at
         FROM users
         WHERE id = $1 AND deleted_at IS NULL`)
    if err != nil {
        // ErrAlreadyPrepared is fine - statement exists on this connection
        if !isPreparedStatementAlreadyExists(err) {
            return nil, fmt.Errorf("preparing statement: %w", err)
        }
    }

    row := conn.Conn().QueryRow(ctx, stmtGetUserByID, id)
    user := &User{}
    if err := row.Scan(&user.ID, &user.Email, &user.Name, &user.Role,
        &user.CreatedAt, &user.UpdatedAt); err != nil {
        if err == pgx.ErrNoRows {
            return nil, ErrUserNotFound
        }
        return nil, fmt.Errorf("scanning user: %w", err)
    }

    return user, nil
}

func isPreparedStatementAlreadyExists(err error) bool {
    // pgconn error code 42P05 = prepared statement already exists
    if pgErr, ok := err.(*pgconn.PgError); ok {
        return pgErr.Code == "42P05"
    }
    return false
}
```

### Batch Queries

pgx v5 batch queries send multiple queries in a single network round-trip:

```go
// GetUsersByIDs retrieves multiple users in a single round-trip.
func (r *UserRepository) GetUsersByIDs(ctx context.Context, ids []int64) ([]*User, error) {
    if len(ids) == 0 {
        return nil, nil
    }

    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return nil, fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    batch := &pgx.Batch{}
    for _, id := range ids {
        batch.Queue(
            `SELECT id, email, name, role, created_at, updated_at
             FROM users WHERE id = $1 AND deleted_at IS NULL`,
            id,
        )
    }

    results := conn.Conn().SendBatch(ctx, batch)
    defer results.Close()

    users := make([]*User, 0, len(ids))
    for range ids {
        row := results.QueryRow()
        user := &User{}
        err := row.Scan(&user.ID, &user.Email, &user.Name, &user.Role,
            &user.CreatedAt, &user.UpdatedAt)
        if err == pgx.ErrNoRows {
            continue // Skip not-found users
        }
        if err != nil {
            return nil, fmt.Errorf("scanning batch result: %w", err)
        }
        users = append(users, user)
    }

    if err := results.Close(); err != nil {
        return nil, fmt.Errorf("closing batch results: %w", err)
    }

    return users, nil
}
```

### COPY Protocol for Bulk Inserts

For bulk data ingestion, pgx supports the PostgreSQL COPY protocol which is dramatically faster than individual INSERTs:

```go
// BulkInsertUsers inserts a large number of users using COPY protocol.
// Throughput is typically 10-100x faster than individual INSERTs.
func (r *UserRepository) BulkInsertUsers(ctx context.Context, users []*User) (int64, error) {
    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return 0, fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    // Use COPY FROM STDIN for maximum throughput
    copyCount, err := conn.Conn().CopyFrom(
        ctx,
        pgx.Identifier{"users"},
        []string{"email", "name", "role", "created_at"},
        pgx.CopyFromSlice(len(users), func(i int) ([]any, error) {
            u := users[i]
            return []any{
                u.Email,
                u.Name,
                u.Role,
                u.CreatedAt,
            }, nil
        }),
    )
    if err != nil {
        return 0, fmt.Errorf("copy from: %w", err)
    }

    return copyCount, nil
}
```

---

## Transaction Handling

### Transaction Patterns

```go
package repository

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// TxFunc is a function that executes within a transaction.
type TxFunc func(ctx context.Context, tx pgx.Tx) error

// WithTransaction executes fn within a transaction, automatically
// rolling back on error and committing on success.
func WithTransaction(ctx context.Context, pool *pgxpool.Pool, fn TxFunc) error {
    tx, err := pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    defer func() {
        if p := recover(); p != nil {
            _ = tx.Rollback(ctx)
            panic(p) // Re-panic after rollback
        }
    }()

    if err := fn(ctx, tx); err != nil {
        if rbErr := tx.Rollback(ctx); rbErr != nil {
            return fmt.Errorf("rollback failed (%v) after error: %w", rbErr, err)
        }
        return err
    }

    if err := tx.Commit(ctx); err != nil {
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}

// WithSerializableTransaction executes fn with SERIALIZABLE isolation.
// Automatically retries on serialization failures (SQLSTATE 40001).
func WithSerializableTransaction(ctx context.Context, pool *pgxpool.Pool, maxRetries int, fn TxFunc) error {
    var lastErr error

    for attempt := 0; attempt < maxRetries; attempt++ {
        tx, err := pool.BeginTx(ctx, pgx.TxOptions{
            IsoLevel:   pgx.Serializable,
            AccessMode: pgx.ReadWrite,
        })
        if err != nil {
            return fmt.Errorf("beginning serializable tx: %w", err)
        }

        err = fn(ctx, tx)
        if err != nil {
            _ = tx.Rollback(ctx)

            // Check for serialization failure - retry
            if isSerializationFailure(err) {
                lastErr = err
                continue
            }

            return err
        }

        if err := tx.Commit(ctx); err != nil {
            if isSerializationFailure(err) {
                lastErr = err
                continue
            }
            return fmt.Errorf("committing: %w", err)
        }

        return nil
    }

    return fmt.Errorf("transaction failed after %d retries: %w", maxRetries, lastErr)
}

func isSerializationFailure(err error) bool {
    if pgErr, ok := err.(*pgconn.PgError); ok {
        // 40001 = serialization_failure
        // 40P01 = deadlock_detected
        return pgErr.Code == "40001" || pgErr.Code == "40P01"
    }
    return false
}
```

### Savepoint-Based Nested Transactions

```go
// TransferFunds performs a bank transfer with savepoints for partial rollback.
func (r *AccountRepository) TransferFunds(ctx context.Context, fromID, toID int64, amount decimal.Decimal) error {
    return WithTransaction(ctx, r.pool, func(ctx context.Context, tx pgx.Tx) error {
        // Debit source account
        sp, err := tx.Begin(ctx) // Creates SAVEPOINT
        if err != nil {
            return fmt.Errorf("creating savepoint: %w", err)
        }

        var balance decimal.Decimal
        if err := sp.QueryRow(ctx,
            `UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance`,
            amount, fromID,
        ).Scan(&balance); err != nil {
            _ = sp.Rollback(ctx)
            return fmt.Errorf("debiting account %d: %w", fromID, err)
        }

        if balance.IsNegative() {
            _ = sp.Rollback(ctx)
            return ErrInsufficientFunds
        }

        if err := sp.Commit(ctx); err != nil {
            return fmt.Errorf("committing debit: %w", err)
        }

        // Credit destination account
        if _, err := tx.Exec(ctx,
            `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
            amount, toID,
        ); err != nil {
            return fmt.Errorf("crediting account %d: %w", toID, err)
        }

        // Record transfer in audit log
        if _, err := tx.Exec(ctx,
            `INSERT INTO transfer_log (from_account_id, to_account_id, amount, created_at)
             VALUES ($1, $2, $3, NOW())`,
            fromID, toID, amount,
        ); err != nil {
            return fmt.Errorf("inserting transfer log: %w", err)
        }

        return nil
    })
}
```

---

## Pool Observability

### Prometheus Metrics Integration

```go
package database

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// PoolMetrics collects pgxpool statistics as Prometheus metrics.
type PoolMetrics struct {
    pool *pgxpool.Pool

    acquireCount         prometheus.Counter
    acquireDuration      prometheus.Histogram
    acquiredConns        prometheus.Gauge
    canceledAcquireCount prometheus.Counter
    constructingConns    prometheus.Gauge
    emptyAcquireCount    prometheus.Counter
    idleConns            prometheus.Gauge
    maxConns             prometheus.Gauge
    totalConns           prometheus.Gauge
}

// NewPoolMetrics registers and returns pool metrics for the given pool.
// poolName should be a label-safe string identifying the pool.
func NewPoolMetrics(reg prometheus.Registerer, pool *pgxpool.Pool, poolName string) *PoolMetrics {
    labels := prometheus.Labels{"pool": poolName}

    factory := promauto.With(reg)

    m := &PoolMetrics{
        pool: pool,
        acquireCount: factory.NewCounter(prometheus.CounterOpts{
            Name:        "pgxpool_acquire_total",
            Help:        "Total number of successful connection acquisitions",
            ConstLabels: labels,
        }),
        acquireDuration: factory.NewHistogram(prometheus.HistogramOpts{
            Name:        "pgxpool_acquire_duration_seconds",
            Help:        "Duration of connection acquisition",
            ConstLabels: labels,
            Buckets:     []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
        }),
        acquiredConns: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "pgxpool_acquired_connections",
            Help:        "Number of currently acquired connections",
            ConstLabels: labels,
        }),
        canceledAcquireCount: factory.NewCounter(prometheus.CounterOpts{
            Name:        "pgxpool_canceled_acquire_total",
            Help:        "Total number of canceled connection acquisitions",
            ConstLabels: labels,
        }),
        constructingConns: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "pgxpool_constructing_connections",
            Help:        "Number of connections being constructed",
            ConstLabels: labels,
        }),
        emptyAcquireCount: factory.NewCounter(prometheus.CounterOpts{
            Name:        "pgxpool_empty_acquire_total",
            Help:        "Total number of acquisitions from empty pool",
            ConstLabels: labels,
        }),
        idleConns: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "pgxpool_idle_connections",
            Help:        "Number of idle connections",
            ConstLabels: labels,
        }),
        maxConns: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "pgxpool_max_connections",
            Help:        "Maximum number of connections",
            ConstLabels: labels,
        }),
        totalConns: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "pgxpool_total_connections",
            Help:        "Total number of connections (idle + acquired + constructing)",
            ConstLabels: labels,
        }),
    }

    return m
}

// Collect reads pool stats and updates all metrics.
// Call this periodically (e.g., in a goroutine every 15 seconds).
func (m *PoolMetrics) Collect() {
    stats := m.pool.Stat()

    m.acquireCount.Add(float64(stats.AcquireCount()))
    m.acquiredConns.Set(float64(stats.AcquiredConns()))
    m.canceledAcquireCount.Add(float64(stats.CanceledAcquireCount()))
    m.constructingConns.Set(float64(stats.ConstructingConns()))
    m.emptyAcquireCount.Add(float64(stats.EmptyAcquireCount()))
    m.idleConns.Set(float64(stats.IdleConns()))
    m.maxConns.Set(float64(stats.MaxConns()))
    m.totalConns.Set(float64(stats.TotalConns()))

    // Acquire duration from pool stats
    if stats.AcquireCount() > 0 {
        avgAcquireDuration := time.Duration(stats.AcquireDuration().Nanoseconds()/
            max(stats.AcquireCount(), 1)) * time.Nanosecond
        m.acquireDuration.Observe(avgAcquireDuration.Seconds())
    }
}

// StartCollecting starts a background goroutine that collects metrics.
func (m *PoolMetrics) StartCollecting(ctx context.Context, interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                m.Collect()
            case <-ctx.Done():
                return
            }
        }
    }()
}

func max(a, b int64) int64 {
    if a > b {
        return a
    }
    return b
}
```

### Query-Level Tracing with OpenTelemetry

```go
package database

import (
    "context"

    "github.com/jackc/pgx/v5"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

// QueryTracer implements pgx.QueryTracer for OpenTelemetry span creation.
type QueryTracer struct {
    tracer trace.Tracer
}

// NewQueryTracer creates a tracer that creates OTel spans for each pgx query.
func NewQueryTracer() *QueryTracer {
    return &QueryTracer{
        tracer: otel.Tracer("pgx"),
    }
}

type tracerContextKey struct{}

func (t *QueryTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
    ctx, span := t.tracer.Start(ctx, "db.query",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.statement", data.SQL),
        ),
    )

    return context.WithValue(ctx, tracerContextKey{}, span)
}

func (t *QueryTracer) TraceQueryEnd(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData) {
    span, ok := ctx.Value(tracerContextKey{}).(trace.Span)
    if !ok {
        return
    }
    defer span.End()

    if data.Err != nil {
        span.RecordError(data.Err)
        span.SetStatus(codes.Error, data.Err.Error())
    } else {
        span.SetStatus(codes.Ok, "")
    }

    span.SetAttributes(
        attribute.Int64("db.rows_affected", data.CommandTag.RowsAffected()),
    )
}

// Attach the tracer to pool config
func applyTracer(poolCfg *pgxpool.Config, tracer *QueryTracer) {
    poolCfg.ConnConfig.Tracer = tracer
}
```

### Grafana Dashboard Queries

```promql
# Pool utilization percentage
(pgxpool_acquired_connections{pool="primary"} / pgxpool_max_connections{pool="primary"}) * 100

# Connection acquisition rate
rate(pgxpool_acquire_total{pool="primary"}[5m])

# Empty acquire rate (pool saturation indicator)
rate(pgxpool_empty_acquire_total{pool="primary"}[5m])

# P99 acquisition latency
histogram_quantile(0.99, rate(pgxpool_acquire_duration_seconds_bucket{pool="primary"}[5m]))

# Canceled acquisitions (timeout indicator)
rate(pgxpool_canceled_acquire_total{pool="primary"}[5m])
```

---

## Read Replica Routing

For read-heavy workloads, route read queries to replicas:

```go
package database

import (
    "context"
    "fmt"
    "sync/atomic"

    "github.com/jackc/pgx/v5/pgxpool"
)

// MultiPool manages a primary and multiple read replica pools.
type MultiPool struct {
    primary  *pgxpool.Pool
    replicas []*pgxpool.Pool
    counter  atomic.Uint64
}

// NewMultiPool creates a multi-pool with one primary and multiple replicas.
func NewMultiPool(ctx context.Context, primaryDSN string, replicaDSNs []string, cfg Config) (*MultiPool, error) {
    cfg.DSN = primaryDSN
    primary, err := NewPool(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("creating primary pool: %w", err)
    }

    // Replicas can have higher MaxConns since they handle read traffic
    replicaCfg := cfg
    replicaCfg.MaxConns = cfg.MaxConns * 2

    replicas := make([]*pgxpool.Pool, 0, len(replicaDSNs))
    for i, dsn := range replicaDSNs {
        replicaCfg.DSN = dsn
        pool, err := NewPool(ctx, replicaCfg)
        if err != nil {
            // Clean up already-created pools
            for _, p := range replicas {
                p.Close()
            }
            primary.Close()
            return nil, fmt.Errorf("creating replica %d pool: %w", i, err)
        }
        replicas = append(replicas, pool)
    }

    return &MultiPool{
        primary:  primary,
        replicas: replicas,
    }, nil
}

// Primary returns the primary (write) pool.
func (m *MultiPool) Primary() *pgxpool.Pool {
    return m.primary
}

// Replica returns a replica pool using round-robin selection.
// Falls back to primary if no replicas are configured.
func (m *MultiPool) Replica() *pgxpool.Pool {
    if len(m.replicas) == 0 {
        return m.primary
    }
    idx := m.counter.Add(1) % uint64(len(m.replicas))
    return m.replicas[idx]
}

// Close closes all pools.
func (m *MultiPool) Close() {
    m.primary.Close()
    for _, r := range m.replicas {
        r.Close()
    }
}
```

---

## Alerting Rules

```yaml
# PrometheusRule for database pool alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pgx-pool-alerts
  namespace: monitoring
spec:
  groups:
    - name: pgxpool
      rules:
        - alert: DatabasePoolHighUtilization
          expr: |
            (pgxpool_acquired_connections / pgxpool_max_connections) > 0.8
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Database pool utilization > 80%"
            description: "Pool {{ $labels.pool }} is at {{ $value | humanizePercentage }} utilization"

        - alert: DatabasePoolSaturated
          expr: |
            rate(pgxpool_empty_acquire_total[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Database pool is saturated"
            description: "Pool {{ $labels.pool }} is returning empty acquisitions, indicating pool exhaustion"

        - alert: DatabaseAcquisitionLatencyHigh
          expr: |
            histogram_quantile(0.99, rate(pgxpool_acquire_duration_seconds_bucket[5m])) > 0.1
          for: 3m
          labels:
            severity: warning
          annotations:
            summary: "Database connection acquisition P99 latency > 100ms"
```

---

## Production Checklist

### Deployment Configuration Validation

```go
// ValidatePoolConfig checks pool configuration for common production issues.
func ValidatePoolConfig(cfg Config) []string {
    var warnings []string

    if cfg.MaxConns > 100 {
        warnings = append(warnings, fmt.Sprintf(
            "MaxConns=%d is very high; consider pgBouncer for connection multiplexing", cfg.MaxConns))
    }

    if cfg.MinConns == 0 {
        warnings = append(warnings, "MinConns=0: cold start latency will be high for new pods")
    }

    if cfg.MaxConnLifetime > 1*time.Hour {
        warnings = append(warnings, "MaxConnLifetime > 1h: connections may become stale after PostgreSQL restarts or network interruptions")
    }

    if cfg.MaxConnIdleTime > 10*time.Minute {
        warnings = append(warnings, "MaxConnIdleTime > 10m: idle connections consume server resources unnecessarily")
    }

    if cfg.MaxConnLifetimeJitter == 0 {
        warnings = append(warnings, "MaxConnLifetimeJitter=0: thundering herd possible when all connections expire simultaneously")
    }

    return warnings
}
```

The combination of proper pool sizing, connection lifecycle hooks, prepared statement caching, and Prometheus observability provides the foundation for high-performance, maintainable database access in production Go services.
