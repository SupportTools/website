---
title: "Go Database Connection Pool Tuning: pgxpool, sqlx, and Connection Lifecycle"
date: 2028-04-20T00:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "pgx", "sqlx", "Connection Pooling", "Performance"]
categories: ["Go", "Databases"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed guide to configuring and tuning PostgreSQL connection pools in Go using pgxpool and sqlx/database/sql, including connection lifecycle management, health checks, observability, and avoiding common pool exhaustion patterns."
more_link: "yes"
url: "/go-database-connection-pool-guide/"
---

The database connection pool is one of the highest-leverage performance tuning surfaces in a Go service. A misconfigured pool causes everything from intermittent timeouts to cascading failures that take down an entire cluster. This guide covers the two most common PostgreSQL pooling libraries in Go — `pgxpool` and `database/sql` with `sqlx` — their tuning parameters, observability patterns, and the operational anti-patterns that silently degrade performance.

<!--more-->

# Go Database Connection Pool Tuning

## Why Connection Pools Matter

Opening a PostgreSQL connection takes 10–50ms due to TCP handshake, TLS negotiation, and authentication. At 100 requests per second, creating a connection per request would spend 1–5 seconds per second just on connection setup — equivalent to your entire CPU budget.

Connection pools maintain a set of warm connections, amortizing setup cost across thousands of requests. The tradeoff is resource consumption: each PostgreSQL connection consumes approximately 10MB of server memory and a file descriptor.

The goal: keep the pool large enough that requests rarely wait for a connection, but small enough that PostgreSQL is not overwhelmed.

## pgxpool: The Native Driver

`pgxpool` is the connection pool bundled with the `pgx` PostgreSQL driver. It bypasses `database/sql` entirely and exposes PostgreSQL-native types, binary protocol encoding, and LISTEN/NOTIFY — making it the best choice for new Go services.

```bash
go get github.com/jackc/pgx/v5
```

### Configuration

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
    Host            string
    Port            int
    User            string
    Password        string
    Database        string
    SSLMode         string

    // Pool sizing
    MaxConns        int32
    MinConns        int32
    MaxConnLifetime time.Duration
    MaxConnIdleTime time.Duration

    // Timeouts
    ConnectTimeout    time.Duration
    AcquireTimeout    time.Duration
    HealthCheckPeriod time.Duration
}

func DefaultConfig() Config {
    return Config{
        MaxConns:          25,               // See sizing section below
        MinConns:          5,
        MaxConnLifetime:   30 * time.Minute, // Recycle connections to pick up config changes
        MaxConnIdleTime:   10 * time.Minute, // Close idle connections
        ConnectTimeout:    5 * time.Second,
        AcquireTimeout:    10 * time.Second, // How long to wait for a free connection
        HealthCheckPeriod: 1 * time.Minute,
    }
}

func New(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
    connStr := fmt.Sprintf(
        "host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
        cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database, cfg.SSLMode,
    )

    poolCfg, err := pgxpool.ParseConfig(connStr)
    if err != nil {
        return nil, fmt.Errorf("parsing connection string: %w", err)
    }

    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns
    poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
    poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

    // Set per-connection timeouts
    poolCfg.ConnConfig.ConnectTimeout = cfg.ConnectTimeout

    // Customize the connection after it is created
    poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
        // Set statement timeout to prevent runaway queries
        _, err := conn.Exec(ctx, "SET statement_timeout = '30s'")
        if err != nil {
            return fmt.Errorf("setting statement_timeout: %w", err)
        }
        // Set application name for pg_stat_activity visibility
        _, err = conn.Exec(ctx, fmt.Sprintf(
            "SET application_name = '%s'", "my-service",
        ))
        return err
    }

    // Called just before a connection is reused
    poolCfg.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Return false to discard the connection if unhealthy
        return conn.Ping(ctx) == nil
    }

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    // Eagerly establish MinConns connections
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return pool, nil
}
```

### Acquire Timeout vs. Connect Timeout

Two separate timeouts govern different phases:

- **`ConnectTimeout`**: Maximum time to establish a new TCP+TLS+auth connection to PostgreSQL. Keep this short (3–5s). A slow connect usually means the database is unreachable.
- **`AcquireTimeout`** (set via `context.WithTimeout` on `Acquire`): Maximum time to wait for a connection from the pool. This is what limits the blast radius of pool exhaustion.

```go
// Use a context deadline when acquiring connections in handlers
func (r *OrderRepository) CreateOrder(ctx context.Context, order *Order) error {
    // If pool is exhausted, fail fast after 5 seconds rather than queueing indefinitely
    acquireCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    conn, err := r.pool.Acquire(acquireCtx)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            return fmt.Errorf("database pool exhausted: %w", ErrServiceUnavailable)
        }
        return fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    // Use conn.Exec, conn.QueryRow, etc.
    _, err = conn.Exec(ctx,
        `INSERT INTO orders (id, user_id, amount) VALUES ($1, $2, $3)`,
        order.ID, order.UserID, order.Amount,
    )
    return err
}
```

For most queries, use `pool.Exec`/`pool.QueryRow` directly — these acquire and release automatically:

```go
// Preferred: pool manages acquire/release automatically
row := r.pool.QueryRow(ctx,
    "SELECT id, email, name FROM users WHERE id = $1", userID)
var u User
if err := row.Scan(&u.ID, &u.Email, &u.Name); err != nil {
    if errors.Is(err, pgx.ErrNoRows) {
        return nil, ErrNotFound
    }
    return nil, fmt.Errorf("querying user: %w", err)
}
```

### Transactions

```go
func (r *PaymentRepository) ProcessPayment(
    ctx context.Context, payment *Payment,
) error {
    tx, err := r.pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer func() {
        if err != nil {
            // Rollback on any error; ignore rollback error (connection may be dead)
            tx.Rollback(ctx)
        }
    }()

    _, err = tx.Exec(ctx,
        "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
        payment.Amount, payment.FromAccountID,
    )
    if err != nil {
        return fmt.Errorf("debiting account: %w", err)
    }

    _, err = tx.Exec(ctx,
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
        payment.Amount, payment.ToAccountID,
    )
    if err != nil {
        return fmt.Errorf("crediting account: %w", err)
    }

    if err = tx.Commit(ctx); err != nil {
        return fmt.Errorf("committing payment: %w", err)
    }
    return nil
}
```

## database/sql with sqlx

`database/sql` is the standard library interface. `sqlx` adds struct scanning, named queries, and `In` queries without changing the pool model.

```bash
go get github.com/jmoiron/sqlx
go get github.com/jackc/pgx/v5/stdlib   # pgx stdlib adapter for database/sql
```

### Configuration

```go
package database

import (
    "database/sql"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/stdlib"
    "github.com/jmoiron/sqlx"
)

type SQLXConfig struct {
    DSN             string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
    ConnMaxIdleTime time.Duration
}

func NewSQLX(cfg SQLXConfig) (*sqlx.DB, error) {
    db, err := sqlx.Open("pgx", cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("opening db: %w", err)
    }

    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

    if err := db.Ping(); err != nil {
        db.Close()
        return nil, fmt.Errorf("pinging db: %w", err)
    }

    return db, nil
}
```

### sqlx Named Queries and Struct Scanning

```go
type User struct {
    ID        string    `db:"id"`
    Email     string    `db:"email"`
    Name      string    `db:"name"`
    CreatedAt time.Time `db:"created_at"`
}

// Get a single row into a struct
func (r *UserRepository) FindByID(ctx context.Context, id string) (*User, error) {
    var u User
    err := r.db.GetContext(ctx, &u,
        "SELECT id, email, name, created_at FROM users WHERE id = $1", id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("finding user: %w", err)
    }
    return &u, nil
}

// Get multiple rows into a slice of structs
func (r *UserRepository) ListByIDs(ctx context.Context, ids []string) ([]*User, error) {
    // Build an IN clause with sqlx
    query, args, err := sqlx.In(
        "SELECT id, email, name, created_at FROM users WHERE id IN (?)", ids)
    if err != nil {
        return nil, err
    }
    // Rebind for PostgreSQL ($1, $2 ... instead of ?)
    query = r.db.Rebind(query)

    var users []*User
    if err := r.db.SelectContext(ctx, &users, query, args...); err != nil {
        return nil, fmt.Errorf("listing users: %w", err)
    }
    return users, nil
}

// Named query with struct binding
func (r *UserRepository) Insert(ctx context.Context, u *User) error {
    _, err := r.db.NamedExecContext(ctx,
        `INSERT INTO users (id, email, name, created_at)
         VALUES (:id, :email, :name, :created_at)
         ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email, name = EXCLUDED.name`,
        u,
    )
    return err
}
```

## Pool Sizing: The Formula

PostgreSQL's recommended maximum connections formula:

```
MaxConns = min(
    (num_cpu_cores * 2) + effective_spindle_count,
    max_connections - reserved_connections
)
```

In Kubernetes, where each pod instance has its own pool:

```
total_connections = max_conns_per_pod * num_pod_replicas

// Must be less than PostgreSQL's max_connections (default: 100)
// minus connections for pgbouncer, monitoring, admin sessions
```

**Example**: 5-replica service, PostgreSQL `max_connections = 200`:

```
Available connections: 200 - 20 (reserved) = 180
Per-pod max: 180 / 5 = 36 → use 30 (leave headroom for scaling)
```

Set `MaxConns` lower than you think necessary. Pool exhaustion is rare; most services idle 90% of their connections.

## PgBouncer: Database-Side Connection Pooling

For high-replica-count deployments, add PgBouncer between Go services and PostgreSQL. PgBouncer manages a smaller number of actual PostgreSQL connections while serving many more application connections.

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
mydb = host=postgres-primary port=5432 dbname=mydb pool_size=50

[pgbouncer]
listen_port = 5432
listen_addr = 0.0.0.0
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Transaction pooling reuses connections between transactions
# (most efficient but incompatible with advisory locks, SET LOCAL, LISTEN)
pool_mode = transaction

max_client_conn = 1000
default_pool_size = 50
reserve_pool_size = 10
reserve_pool_timeout = 5

log_connections = 1
log_disconnections = 1
log_pooler_errors = 1

# Health check
server_check_query = SELECT 1
server_check_delay = 30
```

With PgBouncer in transaction mode:
- Set Go pool `MaxConns` to a high value (100+) — these are PgBouncer client slots, not PostgreSQL connections.
- Disable `BeforeAcquire` ping checks — PgBouncer handles connection health.
- Avoid `SET` statements outside transactions — they will affect the next user's connection.

## Observability

### pgxpool Stats

```go
package metrics

import (
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    poolAcquireCount = promauto.NewCounter(prometheus.CounterOpts{
        Name: "pgxpool_acquire_count_total",
        Help: "Total number of successful connection acquisitions.",
    })
    poolAcquireDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "pgxpool_acquire_duration_seconds",
        Help:    "Duration of connection acquisition.",
        Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
    })
    poolIdleConns = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "pgxpool_idle_connections",
        Help: "Number of idle connections in the pool.",
    })
    poolTotalConns = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "pgxpool_total_connections",
        Help: "Total number of connections in the pool.",
    })
    poolMaxConns = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "pgxpool_max_connections",
        Help: "Maximum number of connections in the pool.",
    })
    poolConstructingConns = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "pgxpool_constructing_connections",
        Help: "Number of connections being created.",
    })
)

// RecordPoolStats pushes pool statistics to Prometheus.
// Call this in a goroutine: go RecordPoolStats(pool)
func RecordPoolStats(pool *pgxpool.Pool) {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    for range ticker.C {
        stats := pool.Stat()
        poolIdleConns.Set(float64(stats.IdleConns()))
        poolTotalConns.Set(float64(stats.TotalConns()))
        poolMaxConns.Set(float64(stats.MaxConns()))
        poolConstructingConns.Set(float64(stats.ConstructingConns()))
        poolAcquireCount.Add(float64(stats.AcquireCount()))
    }
}
```

### database/sql Stats

```go
func RecordSQLStats(db *sql.DB, dbName string) {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    for range ticker.C {
        stats := db.Stats()
        labels := prometheus.Labels{"db": dbName}
        sqlOpenConnections.With(labels).Set(float64(stats.OpenConnections))
        sqlInUse.With(labels).Set(float64(stats.InUse))
        sqlIdle.With(labels).Set(float64(stats.Idle))
        sqlWaitCount.With(labels).Add(float64(stats.WaitCount))
        sqlWaitDuration.With(labels).Add(stats.WaitDuration.Seconds())
        sqlMaxIdleClosed.With(labels).Add(float64(stats.MaxIdleClosed))
        sqlMaxLifetimeClosed.With(labels).Add(float64(stats.MaxLifetimeClosed))
    }
}
```

### Grafana Dashboard Queries

```promql
# Connection pool utilization
pgxpool_total_connections / pgxpool_max_connections

# Pool wait rate (requests waiting for a connection)
rate(pgxpool_acquire_count_total[5m])

# Average acquisition time
rate(pgxpool_acquire_duration_seconds_sum[5m])
  / rate(pgxpool_acquire_duration_seconds_count[5m])

# database/sql wait time (signals pool exhaustion)
rate(go_sql_wait_duration_seconds_sum[5m])
```

## Prepared Statements

pgx automatically caches prepared statements per connection. This is transparent but important:

```go
// pgx caches this automatically after first execution per connection
row := pool.QueryRow(ctx, "SELECT id FROM users WHERE email = $1", email)

// To disable caching for a specific query (e.g., queries with variable IN lists):
conn, _ := pool.Acquire(ctx)
defer conn.Release()
conn.Conn().Exec(ctx, "DEALLOCATE ALL")

// Or use pgx.QuerySimpleProtocol for one-off queries
conn.Conn().QueryRow(ctx, "SELECT ...", pgx.QuerySimpleProtocol(true))
```

Watch for the "prepared statement already exists" error during rolling deployments. This happens when a new version uses different query text for the same query. Force a connection recycle on deploy by setting `MaxConnLifetime` and restarting the pool.

## Common Anti-Patterns

### Holding Connections Too Long

```go
// BAD: Holds a connection for the entire HTTP handler lifetime
func badHandler(w http.ResponseWriter, r *http.Request) {
    conn, _ := pool.Acquire(r.Context())
    defer conn.Release()

    // This does some computation that takes 200ms before the first query...
    processRequest(r)  // Does not use the DB

    // ...then makes the DB call
    row := conn.QueryRow(r.Context(), "SELECT ...", id)
}

// GOOD: Acquire only when needed, release immediately
func goodHandler(w http.ResponseWriter, r *http.Request) {
    // No connection acquired yet
    result := processRequest(r)

    // Acquire only for the DB operation
    row := pool.QueryRow(r.Context(), "SELECT ...", result.ID)
}
```

### Ignoring Context Cancellation

```go
// BAD: Long query with no timeout
rows, err := pool.Query(context.Background(), "SELECT * FROM large_table")

// GOOD: Use request context + deadline
func handler(w http.ResponseWriter, r *http.Request) {
    // r.Context() is cancelled when the client disconnects
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    rows, err := pool.Query(ctx, "SELECT * FROM large_table WHERE ...")
    if err != nil {
        if errors.Is(err, context.Canceled) {
            // Client disconnected; log but don't report as an error
            return
        }
        http.Error(w, "query failed", http.StatusInternalServerError)
        return
    }
    defer rows.Close()
}
```

### Not Closing Rows

```go
// BAD: rows is never closed — connection is not released
rows, err := pool.Query(ctx, "SELECT id FROM users")
if err != nil {
    return err
}
for rows.Next() {
    // ...
}

// GOOD: Always defer rows.Close()
rows, err := pool.Query(ctx, "SELECT id FROM users")
if err != nil {
    return err
}
defer rows.Close()
for rows.Next() {
    // ...
}
if err := rows.Err(); err != nil {
    return fmt.Errorf("iterating rows: %w", err)
}
```

### Pool Exhaustion During Startup

Services that open DB connections at startup and then make N concurrent requests before the pool is warmed up can exhaust `max_connections` on the PostgreSQL server. Use an exponential backoff retry on initial connection and establish `MinConns` eagerly.

## Health Checks

```go
type HealthChecker struct {
    pool *pgxpool.Pool
}

func (h *HealthChecker) Healthy(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    var result int
    err := h.pool.QueryRow(ctx, "SELECT 1").Scan(&result)
    if err != nil {
        return fmt.Errorf("database health check failed: %w", err)
    }
    return nil
}

// Register as Kubernetes readiness probe
http.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
    if err := checker.Healthy(r.Context()); err != nil {
        http.Error(w, err.Error(), http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
})
```

## Graceful Shutdown

```go
func main() {
    pool, _ := database.New(ctx, cfg)

    srv := &http.Server{Addr: ":8080", Handler: mux}

    // Shutdown channel
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

    go func() { srv.ListenAndServe() }()

    <-stop

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Stop accepting new requests
    srv.Shutdown(shutdownCtx)

    // Close the pool after all in-flight requests complete
    // (pool.Close() waits for connections to be returned)
    pool.Close()

    log.Println("shutdown complete")
}
```

## Summary

The connection pool is infrastructure, not application logic. Treat it as such:

- Use **pgxpool** for new services; it provides better control and PostgreSQL-native features.
- Use **sqlx + database/sql** when you need compatibility with the standard library or multiple database backends.
- Set `MaxConns` conservatively (20–50 per pod) and monitor utilization before increasing.
- Always pass a context with a deadline to every database operation.
- Instrument pool statistics with Prometheus and alert when `wait_duration` spikes.
- Add PgBouncer at scale (>10 pod replicas) to avoid hitting PostgreSQL's `max_connections`.

The difference between a service that handles 10x traffic spikes gracefully and one that falls over at 2x load is often a single configuration parameter in the connection pool.
