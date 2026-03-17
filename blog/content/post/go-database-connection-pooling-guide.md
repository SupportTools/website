---
title: "Go Database Connection Pooling: pgx, sqlx, GORM Tuning, and Connection Leak Detection"
date: 2028-07-01T00:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "pgx", "GORM", "Connection Pooling", "Performance"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go database connection pooling covering pgx pool configuration, sqlx and GORM pool settings, detecting connection leaks with pprof and pgstat, and optimizing pool parameters for high-throughput services."
more_link: "yes"
url: "/go-database-connection-pooling-guide/"
---

Database connection pool misconfiguration is one of the most common causes of production incidents in Go services. The symptoms are predictable: everything looks fine at low traffic, then at 3x peak load the service starts timing out with "connection refused" or "too many connections" errors. By the time you're paging through PostgreSQL logs at 2 AM, you wish you had spent thirty minutes understanding your connection pool settings.

This guide covers everything you need: pgx pool configuration and behavioral deep-dive, sqlx and GORM pool tuning, how to detect connection leaks before they cause outages, and the PostgreSQL-side monitoring to correlate application pool metrics with server state.

<!--more-->

# Go Database Connection Pooling: pgx, sqlx, GORM Tuning, and Connection Leak Detection

## Section 1: How Go Database Connection Pools Work

### database/sql Pool Architecture

The standard library's `database/sql` package manages a pool internally. Connections are acquired from the pool, used for a query, then returned. Understanding the lifecycle is essential for tuning:

```
Application calls db.QueryContext(ctx, ...)
    ↓
database/sql checks pool for idle connection
    ├── Idle connection available → use it
    ├── Pool not at max → open new connection
    └── Pool at max → wait for idle connection (respects ctx deadline)
Query executes
    ↓
Connection returned to pool
    ├── Below MaxIdleConns threshold → stays idle in pool
    └── Above threshold → connection closed
```

### pool parameters

```go
import (
    "database/sql"
    "time"
    _ "github.com/jackc/pgx/v5/stdlib"
)

func newDB(dsn string) (*sql.DB, error) {
    db, err := sql.Open("pgx", dsn)
    if err != nil {
        return nil, err
    }

    // Maximum number of open connections (default: unlimited = dangerous!)
    // Rule of thumb: (number_of_cores * 2) + effective_spindle_count
    // For a 4-core machine with SSD: 10-20
    db.SetMaxOpenConns(25)

    // Maximum idle connections kept in pool
    // Set equal to MaxOpenConns unless you have connection setup overhead
    db.SetMaxIdleConns(25)

    // Maximum time a connection can be reused
    // Force connection refresh to handle PostgreSQL failover, credential rotation
    db.SetConnMaxLifetime(30 * time.Minute)

    // Maximum time a connection can sit idle before being closed
    // Prevents holding connections during traffic valleys
    db.SetConnMaxIdleTime(5 * time.Minute)

    // Verify pool settings with Ping
    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("database connection failed: %w", err)
    }

    return db, nil
}
```

### Reading Pool Stats

```go
func logPoolStats(db *sql.DB, logger *slog.Logger) {
    stats := db.Stats()
    logger.Info("database pool stats",
        slog.Int("open_connections", stats.OpenConnections),
        slog.Int("in_use", stats.InUse),
        slog.Int("idle", stats.Idle),
        slog.Int64("wait_count", stats.WaitCount),
        slog.Duration("wait_duration", stats.WaitDuration),
        slog.Int64("max_idle_closed", stats.MaxIdleClosed),
        slog.Int64("max_idle_time_closed", stats.MaxIdleTimeClosed),
        slog.Int64("max_lifetime_closed", stats.MaxLifetimeClosed),
    )
}

// Expose as Prometheus metrics
func registerDBMetrics(db *sql.DB, reg prometheus.Registerer, dbName string) {
    labels := prometheus.Labels{"db": dbName}

    prometheus.MustRegister(prometheus.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name:        "db_pool_open_connections",
            Help:        "Number of open database connections",
            ConstLabels: labels,
        },
        func() float64 { return float64(db.Stats().OpenConnections) },
    ))

    prometheus.MustRegister(prometheus.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name:        "db_pool_idle_connections",
            Help:        "Number of idle database connections",
            ConstLabels: labels,
        },
        func() float64 { return float64(db.Stats().Idle) },
    ))

    prometheus.MustRegister(prometheus.NewCounterFunc(
        prometheus.CounterOpts{
            Name:        "db_pool_wait_total",
            Help:        "Total number of times waited for a connection",
            ConstLabels: labels,
        },
        func() float64 { return float64(db.Stats().WaitCount) },
    ))
}
```

## Section 2: pgx Native Pool (pgxpool)

pgxpool is the recommended connection pool for Go services that use PostgreSQL exclusively. It has better performance than `database/sql` because it avoids the reflection-based row scanning and provides direct access to PostgreSQL-specific features.

### Basic pgxpool Setup

```go
package db

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

func NewPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, fmt.Errorf("parse config: %w", err)
    }

    // Pool sizing
    config.MaxConns = 25
    config.MinConns = 5     // Maintain minimum connections (avoids cold-start latency)

    // Connection lifetime management
    config.MaxConnLifetime = 30 * time.Minute
    config.MaxConnIdleTime = 5 * time.Minute
    config.MaxConnLifetimeJitter = 30 * time.Second  // Prevents thundering herd on reconnect

    // Health check interval
    config.HealthCheckPeriod = 30 * time.Second

    // Connection acquisition timeout
    // Applied when pool is at MaxConns
    config.ConnConfig.ConnectTimeout = 5 * time.Second

    // Hooks for connection lifecycle events
    config.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Return false to discard this connection and try another
        // Useful to check custom application-level health
        return true
    }

    config.AfterRelease = func(conn *pgx.Conn) bool {
        // Return false to destroy the connection after release
        // Useful to reset connection state
        return true
    }

    config.BeforeConnect = func(ctx context.Context, connConfig *pgx.ConnConfig) error {
        // Modify connection config before each new connection is established
        // Useful for dynamic credential rotation
        return nil
    }

    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("create pool: %w", err)
    }

    // Verify connectivity
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("ping failed: %w", err)
    }

    return pool, nil
}
```

### Advanced pgxpool Configuration

```go
// DSN-based configuration with all parameters
func NewPoolFromDSN(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
    // DSN format: postgresql://user:password@host:port/dbname?pool_max_conns=25&pool_min_conns=5
    // Parameters can be in DSN:
    // pool_max_conns, pool_min_conns, pool_max_conn_lifetime, pool_max_conn_idle_time

    config, err := pgxpool.ParseConfig(dsn)
    if err != nil {
        return nil, err
    }

    // pgx-specific PostgreSQL settings
    config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
    // QueryExecModeCacheStatement: prepare statements once, cache them
    // QueryExecModeSimpleProtocol: no prepared statements (use with PgBouncer in transaction mode)
    // QueryExecModeDescribeExec: always describe before execute (slowest but most flexible)

    // Statement cache size per connection
    config.ConnConfig.StatementCacheCapacity = 512

    // Trace queries (development/debugging only)
    if os.Getenv("DB_TRACE") == "true" {
        config.ConnConfig.Tracer = &pgxTracer{}
    }

    return pgxpool.NewWithConfig(ctx, config)
}

// pgxTracer implements pgx.QueryTracer for query logging
type pgxTracer struct{}

func (t *pgxTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
    return context.WithValue(ctx, "query_start", time.Now())
}

func (t *pgxTracer) TraceQueryEnd(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData) {
    start := ctx.Value("query_start").(time.Time)
    duration := time.Since(start)
    if duration > 100*time.Millisecond {
        log.Printf("SLOW QUERY (%v): %s", duration, data.SQL)
    }
}
```

### pgxpool Monitoring

```go
func RegisterPgxPoolMetrics(pool *pgxpool.Pool, reg prometheus.Registerer) {
    reg.MustRegister(prometheus.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name: "pgxpool_acquired_conns",
            Help: "Number of currently acquired connections",
        },
        func() float64 {
            return float64(pool.Stat().AcquiredConns())
        },
    ))

    reg.MustRegister(prometheus.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name: "pgxpool_idle_conns",
            Help: "Number of idle connections",
        },
        func() float64 {
            return float64(pool.Stat().IdleConns())
        },
    ))

    reg.MustRegister(prometheus.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name: "pgxpool_total_conns",
            Help: "Total number of connections in pool",
        },
        func() float64 {
            return float64(pool.Stat().TotalConns())
        },
    ))

    reg.MustRegister(prometheus.NewCounterFunc(
        prometheus.CounterOpts{
            Name: "pgxpool_acquire_count_total",
            Help: "Total number of connection acquisitions",
        },
        func() float64 {
            return float64(pool.Stat().AcquireCount())
        },
    ))

    reg.MustRegister(prometheus.NewCounterFunc(
        prometheus.CounterOpts{
            Name: "pgxpool_acquire_duration_ns_total",
            Help: "Total duration spent waiting for connections (nanoseconds)",
        },
        func() float64 {
            return float64(pool.Stat().AcquireDuration())
        },
    ))

    reg.MustRegister(prometheus.NewCounterFunc(
        prometheus.CounterOpts{
            Name: "pgxpool_empty_acquire_count_total",
            Help: "Number of acquisitions that waited due to empty pool",
        },
        func() float64 {
            return float64(pool.Stat().EmptyAcquireCount())
        },
    ))
}
```

## Section 3: GORM Connection Pool Configuration

### GORM with PostgreSQL

```go
package db

import (
    "fmt"
    "time"

    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/gorm/logger"
)

func NewGORMDB(dsn string) (*gorm.DB, error) {
    // GORM logger configuration
    gormLogger := logger.New(
        log.New(os.Stdout, "\r\n", log.LstdFlags),
        logger.Config{
            SlowThreshold:             200 * time.Millisecond,
            LogLevel:                  logger.Error,
            IgnoreRecordNotFoundError: true,
            Colorful:                  false,
        },
    )

    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
        Logger:                                   gormLogger,
        PrepareStmt:                              true,    // Cache prepared statements
        DisableAutomaticPing:                     false,
        DisableForeignKeyConstraintWhenMigrating: true,
        NowFunc: func() time.Time {
            return time.Now().UTC()
        },
    })
    if err != nil {
        return nil, fmt.Errorf("open gorm db: %w", err)
    }

    // Get underlying sql.DB to configure pool
    sqlDB, err := db.DB()
    if err != nil {
        return nil, fmt.Errorf("get sql.DB from gorm: %w", err)
    }

    // Pool configuration - same as database/sql
    sqlDB.SetMaxOpenConns(25)
    sqlDB.SetMaxIdleConns(25)
    sqlDB.SetConnMaxLifetime(30 * time.Minute)
    sqlDB.SetConnMaxIdleTime(5 * time.Minute)

    return db, nil
}

// GORMdb wraps gorm.DB with additional functionality
type GORMdb struct {
    db *gorm.DB
}

// WithContext returns a gorm.DB scoped to the context (important for tracing)
func (g *GORMdb) WithContext(ctx context.Context) *gorm.DB {
    return g.db.WithContext(ctx)
}

// Common operations with proper context usage
func (g *GORMdb) FindUserByEmail(ctx context.Context, email string) (*User, error) {
    var user User
    result := g.db.WithContext(ctx).
        Where("email = ?", email).
        First(&user)

    if result.Error != nil {
        if errors.Is(result.Error, gorm.ErrRecordNotFound) {
            return nil, ErrUserNotFound
        }
        return nil, fmt.Errorf("find user by email: %w", result.Error)
    }
    return &user, nil
}

// Transaction with context
func (g *GORMdb) CreateOrderWithItems(ctx context.Context, order *Order, items []OrderItem) error {
    return g.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
        if err := tx.Create(order).Error; err != nil {
            return fmt.Errorf("create order: %w", err)
        }

        for i := range items {
            items[i].OrderID = order.ID
        }

        if err := tx.CreateInBatches(items, 100).Error; err != nil {
            return fmt.Errorf("create order items: %w", err)
        }

        return nil
    })
}
```

## Section 4: sqlx Configuration

```go
package db

import (
    "fmt"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

func NewSqlxDB(dsn string) (*sqlx.DB, error) {
    db, err := sqlx.Connect("pgx", dsn)
    if err != nil {
        return nil, fmt.Errorf("connect: %w", err)
    }

    // Same pool settings as database/sql (sqlx wraps sql.DB)
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    db.SetConnMaxLifetime(30 * time.Minute)
    db.SetConnMaxIdleTime(5 * time.Minute)

    return db, nil
}

// sqlx enables named queries and struct scanning
type UserRepository struct {
    db *sqlx.DB
}

func (r *UserRepository) FindByID(ctx context.Context, id string) (*User, error) {
    var user User
    // Named query with struct parameter
    query := `SELECT id, email, name, created_at FROM users WHERE id = :id AND deleted_at IS NULL`
    rows, err := r.db.NamedQueryContext(ctx, query, map[string]interface{}{"id": id})
    if err != nil {
        return nil, fmt.Errorf("find user by id: %w", err)
    }
    defer rows.Close()

    if rows.Next() {
        if err := rows.StructScan(&user); err != nil {
            return nil, fmt.Errorf("scan user: %w", err)
        }
        return &user, nil
    }

    return nil, ErrNotFound
}

// Bulk insert using sqlx
func (r *UserRepository) BulkInsert(ctx context.Context, users []User) error {
    if len(users) == 0 {
        return nil
    }

    // Chunk to avoid parameter limit (PostgreSQL max: 65535)
    const chunkSize = 1000
    for i := 0; i < len(users); i += chunkSize {
        end := i + chunkSize
        if end > len(users) {
            end = len(users)
        }
        chunk := users[i:end]

        _, err := r.db.NamedExecContext(ctx,
            `INSERT INTO users (id, email, name, created_at)
             VALUES (:id, :email, :name, :created_at)
             ON CONFLICT (id) DO UPDATE SET
             email = EXCLUDED.email,
             name = EXCLUDED.name`,
            chunk,
        )
        if err != nil {
            return fmt.Errorf("bulk insert chunk %d-%d: %w", i, end, err)
        }
    }

    return nil
}
```

## Section 5: Connection Leak Detection

Connection leaks are silent killers. A leaked connection stays in use until it times out or is manually killed, reducing pool capacity with each leak until the pool is exhausted.

### Common Leak Patterns

```go
// LEAK 1: Forgetting to close rows
func badQuery(db *sql.DB) error {
    rows, err := db.Query("SELECT id FROM users")
    if err != nil {
        return err
    }
    // rows.Close() never called - connection is held until garbage collection
    for rows.Next() {
        // process...
    }
    // Missing: rows.Close()
    return rows.Err()
}

// FIXED: Always defer rows.Close()
func goodQuery(db *sql.DB) error {
    rows, err := db.Query("SELECT id FROM users")
    if err != nil {
        return err
    }
    defer rows.Close()  // Always called

    for rows.Next() {
        // process...
    }
    return rows.Err()
}

// LEAK 2: Not calling rows.Close() when breaking out of loop
func leakyLoopQuery(db *sql.DB, limit int) ([]User, error) {
    rows, err := db.Query("SELECT * FROM users")
    if err != nil {
        return nil, err
    }
    defer rows.Close()  // Defer handles all exit paths

    var users []User
    for rows.Next() {
        if len(users) >= limit {
            break  // rows.Close() via defer handles this case
        }
        var u User
        if err := rows.Scan(&u.ID, &u.Email); err != nil {
            return nil, err  // rows.Close() via defer handles this too
        }
        users = append(users, u)
    }
    return users, rows.Err()
}

// LEAK 3: Transaction not rolled back on error path
func leakyTransaction(db *sql.DB) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }

    if _, err := tx.Exec("UPDATE accounts SET balance = balance - 100 WHERE id = 1"); err != nil {
        // Missing tx.Rollback() - connection stays in transaction state
        return err
    }

    return tx.Commit()
}

// FIXED: Always defer rollback
func goodTransaction(db *sql.DB) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()  // No-op if Commit succeeds

    if _, err := tx.Exec("UPDATE accounts SET balance = balance - 100 WHERE id = 1"); err != nil {
        return err  // Rollback happens via defer
    }

    return tx.Commit()
}

// LEAK 4: pgx Conn not released back to pool
func leakyPgx(pool *pgxpool.Pool, ctx context.Context) error {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return err
    }
    // Missing: conn.Release() - connection is held in pool.acquired state

    _, err = conn.Exec(ctx, "UPDATE users SET last_seen = NOW() WHERE id = $1", "user-123")
    return err
}

// FIXED: Always defer Release
func goodPgx(pool *pgxpool.Pool, ctx context.Context) error {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return err
    }
    defer conn.Release()  // Always called

    _, err = conn.Exec(ctx, "UPDATE users SET last_seen = NOW() WHERE id = $1", "user-123")
    return err
}
```

### Detecting Leaks with pprof

```go
package main

import (
    "net/http"
    _ "net/http/pprof"
    "runtime"
)

func main() {
    // Enable pprof endpoint
    go func() {
        http.ListenAndServe("localhost:6060", nil)
    }()

    // Your application...
}

// Check goroutine count over time for connection-holding goroutines
// curl http://localhost:6060/debug/pprof/goroutine?debug=1
// Look for goroutines blocked on:
// - database/sql.(*DB).conn
// - database/sql.(*DB).waitForConn
// - pgxpool.(*Pool).Acquire
```

### Automated Leak Detection Script

```bash
#!/bin/bash
# detect-db-connection-leaks.sh
# Monitor connection counts from PostgreSQL side

DB_HOST="${1:-localhost}"
DB_NAME="${2:-myapp}"
DB_USER="${3:-postgres}"

echo "=== PostgreSQL Connection Analysis ==="
echo ""

# Connection counts by application
psql -h ${DB_HOST} -U ${DB_USER} -d ${DB_NAME} -c "
SELECT
    application_name,
    state,
    count(*) as count,
    max(age(clock_timestamp(), query_start)) as oldest_query_age,
    max(age(clock_timestamp(), state_change)) as oldest_state_age
FROM pg_stat_activity
WHERE datname = '${DB_NAME}'
GROUP BY application_name, state
ORDER BY count DESC;
"

echo ""
echo "=== Long-Running Connections ==="
psql -h ${DB_HOST} -U ${DB_USER} -d ${DB_NAME} -c "
SELECT
    pid,
    application_name,
    state,
    age(clock_timestamp(), query_start) as query_age,
    age(clock_timestamp(), state_change) as state_age,
    left(query, 100) as query_snippet
FROM pg_stat_activity
WHERE datname = '${DB_NAME}'
  AND age(clock_timestamp(), state_change) > interval '5 minutes'
ORDER BY state_age DESC;
"

echo ""
echo "=== Idle Transactions (potential leaks) ==="
psql -h ${DB_HOST} -U ${DB_USER} -d ${DB_NAME} -c "
SELECT
    pid,
    application_name,
    state,
    age(clock_timestamp(), xact_start) as transaction_age,
    left(query, 100) as last_query
FROM pg_stat_activity
WHERE datname = '${DB_NAME}'
  AND state = 'idle in transaction'
  AND age(clock_timestamp(), xact_start) > interval '1 minute'
ORDER BY transaction_age DESC;
"
```

### Leak Detection in Go Tests

```go
package db_test

import (
    "database/sql"
    "testing"
    "time"
)

// TestNoConnectionLeaks verifies a function doesn't leak connections
func TestNoConnectionLeaks(t *testing.T) {
    db, err := sql.Open("pgx", testDSN)
    require.NoError(t, err)
    defer db.Close()

    db.SetMaxOpenConns(10)
    db.SetMaxIdleConns(10)

    // Record stats before
    statsBefore := db.Stats()

    // Run the function under test
    err = functionUnderTest(db)
    require.NoError(t, err)

    // Wait for any async cleanup
    time.Sleep(100 * time.Millisecond)

    // Check stats after - open connections should be same as before
    statsAfter := db.Stats()

    if statsAfter.OpenConnections > statsBefore.OpenConnections {
        t.Errorf("connection leak detected: before=%d, after=%d",
            statsBefore.OpenConnections, statsAfter.OpenConnections)
    }

    if statsAfter.InUse > 0 {
        t.Errorf("connections still in use after function returned: %d",
            statsAfter.InUse)
    }
}
```

## Section 6: PgBouncer Integration

For high-connection-count services, PgBouncer acts as a connection pooler in front of PostgreSQL, multiplexing thousands of application connections into a smaller number of PostgreSQL connections.

### Connection Modes

```
Transaction pooling (recommended): Connection returned to pool after each transaction
Session pooling: Connection held for entire session
Statement pooling: Not recommended, incompatible with prepared statements
```

### Configuring Go for PgBouncer Transaction Mode

```go
// PgBouncer in transaction mode is incompatible with:
// 1. Prepared statements (pgx QueryExecModeCacheStatement)
// 2. Session-level settings (SET LOCAL, LISTEN/NOTIFY)
// 3. Explicit advisory locks

func newPgBouncerPool(ctx context.Context, bouncer string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(bouncer)
    if err != nil {
        return nil, err
    }

    // REQUIRED for PgBouncer transaction mode:
    // Disable prepared statement caching
    config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

    // Disable statement cache
    config.ConnConfig.StatementCacheCapacity = 0

    // With PgBouncer, MaxConns should be much higher since PgBouncer
    // handles the actual PostgreSQL connection limits
    config.MaxConns = 100

    return pgxpool.NewWithConfig(ctx, config)
}
```

### PgBouncer Configuration

```ini
# pgbouncer.ini
[databases]
myapp = host=postgres-primary port=5432 dbname=myapp

[pgbouncer]
pool_mode = transaction
max_client_conn = 10000     # Application connections allowed
default_pool_size = 25      # PostgreSQL connections per database
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

# Authentication
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

# Timeouts
server_connect_timeout = 15
client_idle_timeout = 600
server_idle_timeout = 300
query_wait_timeout = 120

# Logging
log_connections = 0    # Set to 1 for debugging
log_disconnections = 0
log_stats = 1
stats_period = 60

listen_addr = 0.0.0.0
listen_port = 5432
```

## Section 7: PostgreSQL Side Monitoring

### pg_stat_activity Queries

```sql
-- Current connection utilization
SELECT
    max_conn,
    used,
    res_for_super,
    (max_conn - used - res_for_super) AS available
FROM
    (SELECT count(*) used FROM pg_stat_activity) t1,
    (SELECT setting::int res_for_super FROM pg_settings WHERE name = 'superuser_reserved_connections') t2,
    (SELECT setting::int max_conn FROM pg_settings WHERE name = 'max_connections') t3;

-- Connection breakdown by state and application
SELECT
    state,
    application_name,
    count(*),
    min(age(now(), state_change)) AS min_age,
    max(age(now(), state_change)) AS max_age
FROM pg_stat_activity
WHERE state IS NOT NULL
GROUP BY state, application_name
ORDER BY count DESC;

-- Queries running longer than 30 seconds
SELECT
    pid,
    now() - pg_stat_activity.query_start AS duration,
    query,
    state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
ORDER BY duration DESC;

-- Terminate idle connections older than 5 minutes
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
  AND state_change < now() - interval '5 minutes'
  AND application_name != 'pgbouncer';
```

### Prometheus Postgres Exporter Queries

```yaml
# postgres_exporter custom queries
# /etc/postgres_exporter/queries.yaml
pg_connections:
  query: |
    SELECT
      state,
      count(*) as count
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
  metrics:
  - state:
      usage: LABEL
      description: Connection state
  - count:
      usage: GAUGE
      description: Number of connections in this state

pg_idle_transactions:
  query: |
    SELECT count(*) as count,
           max(extract(epoch from (now() - xact_start))) as max_age_seconds
    FROM pg_stat_activity
    WHERE state = 'idle in transaction'
      AND datname = current_database()
  metrics:
  - count:
      usage: GAUGE
      description: Number of idle-in-transaction connections
  - max_age_seconds:
      usage: GAUGE
      description: Age of oldest idle-in-transaction connection
```

## Section 8: Pool Sizing Formulas

### Calculating Optimal Pool Size

```
# Formula from the HikariCP documentation (PostgreSQL-appropriate)
pool_size = ((core_count * 2) + effective_spindle_count)

# For a containerized service with 2 CPUs and SSD storage:
pool_size = (2 * 2) + 1 = 5

# But this is per-instance. If you run 10 replicas:
total_connections = 10 * 5 = 50

# PostgreSQL max_connections should be > total + admin buffer
# max_connections = 100 (allows 50 app + 50 for tools, DBA, replication)
```

```go
// Dynamic pool sizing based on container limits
func calculatePoolSize() int {
    // Read from cgroup if available (Kubernetes)
    cpuQuota := getCPUQuota() // e.g., 2.0 for 2 CPU limit

    if cpuQuota <= 0 {
        cpuQuota = float64(runtime.NumCPU())
    }

    // Base formula: (cpus * 2) + 1 for SSD
    size := int(cpuQuota*2) + 1

    // Clamp to reasonable bounds
    if size < 5 {
        size = 5
    }
    if size > 50 {
        size = 50
    }

    return size
}

func getCPUQuota() float64 {
    // Read from cgroups v2
    quotaBytes, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
    if err != nil {
        return 0
    }

    parts := strings.Fields(strings.TrimSpace(string(quotaBytes)))
    if len(parts) != 2 || parts[0] == "max" {
        return 0
    }

    quota, _ := strconv.ParseFloat(parts[0], 64)
    period, _ := strconv.ParseFloat(parts[1], 64)

    if period == 0 {
        return 0
    }

    return quota / period
}
```

## Section 9: Production Checklist

### Pool Configuration Checklist

```bash
# 1. Verify pool settings are not defaults
# Default MaxOpenConns = 0 (unlimited!) - ALWAYS SET THIS

# 2. Check connection count from PostgreSQL side
psql -c "SELECT count(*) FROM pg_stat_activity WHERE datname='myapp';"

# 3. Monitor pool utilization over time
# Alert thresholds:
# - InUse / MaxOpenConns > 0.8 = warning (pool under pressure)
# - InUse / MaxOpenConns > 0.95 = critical (pool exhausted, requests queuing)
# - WaitCount increasing = requests waiting for connections

# 4. Check for idle-in-transaction (leaked transactions)
psql -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction';"

# 5. Verify ConnMaxLifetime is set (important for HA failover)
# Without this, connections may hold to a dead node after failover
```

### Key Production Rules

1. **Always set MaxOpenConns** - the default is unlimited which lets your application exhaust PostgreSQL `max_connections`
2. **Set MaxIdleConns = MaxOpenConns** - reduces connection setup overhead
3. **Set ConnMaxLifetime** - forces connection refresh enabling credential rotation and HA failover
4. **Set ConnMaxIdleTime** - releases connections during traffic valleys
5. **Always defer rows.Close()** and **defer tx.Rollback()** - prevents leaks on error paths
6. **For pgx with PgBouncer transaction mode**, disable prepared statement cache: `QueryExecModeSimpleProtocol`
7. **Monitor db.Stats()** via Prometheus - alert when InUse/MaxOpenConns > 80%
8. **Test for leaks**: record `db.Stats()` before and after operations in integration tests
9. **Use pgxpool.MinConns** to pre-warm connections and reduce latency on startup
10. **Size pools per instance, not total** - each Pod has its own pool contributing to the total
