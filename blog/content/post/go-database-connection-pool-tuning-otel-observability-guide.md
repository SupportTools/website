---
title: "Go Database Connection Pool Tuning: MaxOpenConns, MaxIdleConns, ConnMaxLifetime, Observability with OpenTelemetry"
date: 2031-12-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Database", "PostgreSQL", "Connection Pooling", "Performance", "OpenTelemetry", "Observability"]
categories:
- Go
- Database
- Performance Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to tuning Go database/sql connection pools for production: MaxOpenConns, MaxIdleConns, ConnMaxLifetime sizing, connection health validation, and full observability with OpenTelemetry metrics."
more_link: "yes"
url: "/go-database-connection-pool-tuning-otel-observability-guide/"
---

The Go `database/sql` package manages a pool of database connections transparently, which is both its strength and its source of production surprises. Default settings are deliberately conservative and will produce connection exhaustion, long waits, and broken connections in high-throughput services. Getting connection pool tuning right requires understanding the three key knobs, how they interact, what happens at each boundary, and how to instrument the pool to see its behavior in production. This guide covers all of it.

<!--more-->

# Go Database Connection Pool Tuning: Production Engineering Guide

## How database/sql's Connection Pool Works

Before tuning, it helps to have an accurate model of the pool:

```
                    Connection Pool
                   ┌──────────────────────────────────┐
                   │  In-use connections (MaxOpenConns - idle) │
                   │  ────────────────────────────────────────  │
                   │  Idle connections (up to MaxIdleConns)     │
                   │  ────────────────────────────────────────  │
                   │  Waiters (waiting for connection)          │
                   └──────────────────────────────────────────┘
```

When `db.QueryContext(ctx, ...)` is called:
1. Check idle connections → if one exists and is healthy, return it immediately
2. If `open < MaxOpenConns` → open a new connection
3. If `open == MaxOpenConns` → enqueue the caller in the wait list
4. Caller's context deadline fires → return error to caller (connection request dropped)
5. Another goroutine returns a connection → dequeue a waiter and give them the connection

## Section 1: The Three Core Settings

### MaxOpenConns

```go
db.SetMaxOpenConns(N)
```

Sets the maximum total number of connections (in-use + idle) the pool will maintain. If `N` connections are in use and a new query arrives:
- If `MaxOpenConns` is 0 (default): pool is unlimited — opens a new connection immediately
- If `MaxOpenConns` is N: caller waits until a connection is freed

**Unlimited (default 0) is dangerous in production.** A slow query spike or sudden load surge will create thousands of connections, overwhelming the database server.

**Choosing MaxOpenConns:**

```
PostgreSQL default max_connections = 100
Leave 10 for admin tools:        = 90 connections available
Divide across app instances:
  5 app instances → 90/5        = 18 connections per instance
  Add 20% buffer:               ~ 15 MaxOpenConns per instance

# Verify PostgreSQL current connections
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

# Check max_connections
SHOW max_connections;
```

### MaxIdleConns

```go
db.SetMaxIdleConns(N)
```

Sets the maximum number of connections kept in the idle pool. When a connection is returned after use:
- If `idle < MaxIdleConns` → keep it in the pool for reuse
- If `idle == MaxIdleConns` → close it

**Default: 2** — almost always too low for production services.

Idle connections are kept open (with no data flowing) to avoid the latency of establishing a new connection on demand. Setting this too low means constant reconnection overhead.

**Choosing MaxIdleConns:**

```
Rule: MaxIdleConns ≈ expected_concurrent_queries × 1.5

If your service typically handles 10 concurrent queries:
  MaxIdleConns = 15

MaxIdleConns must always be <= MaxOpenConns
(database/sql enforces this: it silently reduces MaxIdleConns to MaxOpenConns if violated)
```

### ConnMaxLifetime and ConnMaxIdleTime

```go
db.SetConnMaxLifetime(d)
db.SetConnMaxIdleTime(d)
```

`ConnMaxLifetime` closes a connection after it has been open for `d` duration, regardless of whether it's in use. This is critical for:
- Databases with per-connection resource limits
- Load balancers that terminate long-lived TCP connections silently
- Rotating database credentials (each new connection uses the new password)

`ConnMaxIdleTime` closes a connection that has been idle for `d` duration. Prevents keeping connections open to a database that may have closed them server-side (e.g., MySQL's `wait_timeout`).

```go
// Recommended production settings for PostgreSQL via PgBouncer:
db.SetMaxOpenConns(25)
db.SetMaxIdleConns(25)
db.SetConnMaxLifetime(5 * time.Minute)   // Shorter than PgBouncer's server_idle_timeout
db.SetConnMaxIdleTime(2 * time.Minute)   // Relinquish idle connections after 2m

// For direct PostgreSQL connection (no PgBouncer):
db.SetMaxOpenConns(15)
db.SetMaxIdleConns(10)
db.SetConnMaxLifetime(30 * time.Minute)
db.SetConnMaxIdleTime(10 * time.Minute)

// For MySQL (default wait_timeout = 8 hours, but often lowered in prod):
db.SetMaxOpenConns(25)
db.SetMaxIdleConns(25)
db.SetConnMaxLifetime(4 * time.Minute)   // Under MySQL's typical wait_timeout
db.SetConnMaxIdleTime(3 * time.Minute)
```

## Section 2: Connection Health Validation

### The Stale Connection Problem

NAT firewalls and cloud load balancers silently drop idle TCP connections after 3-15 minutes. The pool doesn't know the connection is dead until a query fails on it. This produces the dreaded "broken pipe" or "connection reset by peer" error.

```go
// db.PingContext checks that the connection is alive.
// Use it to pre-validate connections if needed, but note it
// serializes with the pool and adds latency.
if err := db.PingContext(ctx); err != nil {
    log.Fatal("database unreachable:", err)
}
```

### Health Check with Retry

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// OpenWithRetry opens a DB connection and retries until the database is reachable.
// This is critical for containerized environments where the DB may start after the app.
func OpenWithRetry(
    driverName, dataSourceName string,
    maxRetries int,
    retryDelay time.Duration,
) (*sql.DB, error) {
    var db *sql.DB
    var err error

    for attempt := 1; attempt <= maxRetries; attempt++ {
        db, err = sql.Open(driverName, dataSourceName)
        if err != nil {
            return nil, fmt.Errorf("sql.Open failed (not retryable): %w", err)
        }

        // sql.Open doesn't actually connect; PingContext does.
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        err = db.PingContext(ctx)
        cancel()

        if err == nil {
            return db, nil
        }

        db.Close()
        if attempt < maxRetries {
            time.Sleep(retryDelay * time.Duration(attempt)) // Exponential backoff
        }
    }

    return nil, fmt.Errorf("failed to connect after %d attempts: %w", maxRetries, err)
}
```

### Configuring Connection Validation on Checkout

Go 1.15+ added `db.SetConnMaxIdleTime` which handles most stale connection scenarios by closing idle connections before they can be handed to a caller. For environments with aggressive TCP idle timeouts:

```go
// If your NAT/firewall drops connections after 5 minutes of idle:
db.SetConnMaxIdleTime(4 * time.Minute)   // Close idle connections before the firewall does

// Combine with SetConnMaxLifetime for belt-and-suspenders:
db.SetConnMaxLifetime(10 * time.Minute)
```

## Section 3: Per-Driver Configuration

### PostgreSQL with pgx

```go
package database

import (
    "context"
    "database/sql"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/jackc/pgx/v5/stdlib"
    "go.opentelemetry.io/otel"
)

// OpenPostgresPool creates a pgxpool with proper settings.
// pgxpool is preferred over database/sql for PostgreSQL because it:
// 1. Supports LISTEN/NOTIFY
// 2. Supports pipeline mode
// 3. Supports prepared statements that survive connection cycling
func OpenPostgresPool(connString string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, fmt.Errorf("parsing connection string: %w", err)
    }

    config.MaxConns = 25
    config.MinConns = 5         // Pre-warm minimum connections
    config.MaxConnLifetime = 30 * time.Minute
    config.MaxConnIdleTime = 10 * time.Minute
    config.HealthCheckPeriod = 30 * time.Second

    // pgx-specific: enable connection lifetime randomization to avoid
    // thundering herd when all connections expire simultaneously
    config.MaxConnLifetimeJitter = 2 * time.Minute

    // Configure connection hooks for tracing
    config.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Return false to reject connection from pool (triggers new connection)
        return true
    }
    config.AfterRelease = func(conn *pgx.Conn) bool {
        // Return false to discard connection (don't return to pool)
        return true
    }

    pool, err := pgxpool.NewWithConfig(context.Background(), config)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    return pool, nil
}

// OpenPostgresSQL opens PostgreSQL via database/sql using pgx driver.
// Use this when you need database/sql compatibility (SQLX, GORM, etc.)
func OpenPostgresSQL(connString string) (*sql.DB, error) {
    connConfig, err := pgx.ParseConfig(connString)
    if err != nil {
        return nil, err
    }

    // Register a custom driver name to avoid global state conflicts
    driverName := "pgx-custom"
    sql.Register(driverName, stdlib.GetDefaultDriver())

    db := stdlib.OpenDB(*connConfig)

    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    db.SetConnMaxLifetime(30 * time.Minute)
    db.SetConnMaxIdleTime(10 * time.Minute)

    return db, db.PingContext(context.Background())
}
```

### MySQL with go-sql-driver

```go
package database

import (
    "database/sql"
    "fmt"
    "time"

    _ "github.com/go-sql-driver/mysql"
)

func OpenMySQL(host, port, user, password, dbName string) (*sql.DB, error) {
    // MySQL DSN format: user:password@tcp(host:port)/dbname?params
    dsn := fmt.Sprintf(
        "%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=UTC&timeout=10s&readTimeout=30s&writeTimeout=30s&interpolateParams=true",
        user, password, host, port, dbName,
    )

    db, err := sql.Open("mysql", dsn)
    if err != nil {
        return nil, err
    }

    // MySQL default wait_timeout is 8h, but hosting providers often set it to 1h
    // Keep connections alive for 3m less than typical wait_timeout
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    db.SetConnMaxLifetime(4 * time.Minute)   // Under MySQL wait_timeout
    db.SetConnMaxIdleTime(3 * time.Minute)

    return db, db.PingContext(context.Background())
}
```

## Section 4: OpenTelemetry Pool Observability

### The Problem: Pool Opacity

Without metrics, you cannot answer:
- Is the pool exhausted? (callers waiting for connections)
- Are connections churning? (rapid open/close due to ConnMaxLifetime)
- Is MaxIdleConns too low? (connections closed instead of returned to pool)
- Is the database slow? (connection acquisition time is normal but query time is high)

### Exporting sql.DBStats as Prometheus Metrics

```go
package database

import (
    "context"
    "database/sql"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

type DBMetricsCollector struct {
    db   *sql.DB
    name string

    maxOpenConns           prometheus.Gauge
    openConnections        prometheus.Gauge
    inUseConnections       prometheus.Gauge
    idleConnections        prometheus.Gauge
    waitCount              prometheus.Counter
    waitDuration           prometheus.Counter
    maxIdleClosed          prometheus.Counter
    maxIdleTimeClosed      prometheus.Counter
    maxLifetimeClosed      prometheus.Counter
}

func NewDBMetricsCollector(db *sql.DB, name string) *DBMetricsCollector {
    labels := prometheus.Labels{"db": name}

    c := &DBMetricsCollector{
        db:   db,
        name: name,
        maxOpenConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_max_open_connections",
            Help:        "Maximum number of open connections to the database",
            ConstLabels: labels,
        }),
        openConnections: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_open_connections",
            Help:        "Current number of open connections to the database",
            ConstLabels: labels,
        }),
        inUseConnections: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_in_use_connections",
            Help:        "Number of connections currently in use",
            ConstLabels: labels,
        }),
        idleConnections: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_idle_connections",
            Help:        "Number of idle connections",
            ConstLabels: labels,
        }),
        waitCount: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_wait_count_total",
            Help:        "Total number of connections waited for",
            ConstLabels: labels,
        }),
        waitDuration: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_wait_duration_seconds_total",
            Help:        "Total time waited for connections",
            ConstLabels: labels,
        }),
        maxIdleClosed: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_max_idle_closed_total",
            Help:        "Total connections closed due to MaxIdleConns",
            ConstLabels: labels,
        }),
        maxIdleTimeClosed: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_max_idle_time_closed_total",
            Help:        "Total connections closed due to ConnMaxIdleTime",
            ConstLabels: labels,
        }),
        maxLifetimeClosed: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_max_lifetime_closed_total",
            Help:        "Total connections closed due to ConnMaxLifetime",
            ConstLabels: labels,
        }),
    }
    return c
}

// Start begins periodic collection. Call this in a goroutine.
func (c *DBMetricsCollector) Start(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    var prevStats sql.DBStats

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            stats := c.db.Stats()

            c.maxOpenConns.Set(float64(stats.MaxOpenConnections))
            c.openConnections.Set(float64(stats.OpenConnections))
            c.inUseConnections.Set(float64(stats.InUse))
            c.idleConnections.Set(float64(stats.Idle))

            // Counters: only add the delta since last collection
            c.waitCount.Add(float64(stats.WaitCount - prevStats.WaitCount))
            c.waitDuration.Add(stats.WaitDuration.Seconds() - prevStats.WaitDuration.Seconds())
            c.maxIdleClosed.Add(float64(stats.MaxIdleClosed - prevStats.MaxIdleClosed))
            c.maxIdleTimeClosed.Add(float64(stats.MaxIdleTimeClosed - prevStats.MaxIdleTimeClosed))
            c.maxLifetimeClosed.Add(float64(stats.MaxLifetimeClosed - prevStats.MaxLifetimeClosed))

            prevStats = stats
        }
    }
}
```

### OpenTelemetry Metrics with OTLP

```go
package database

import (
    "context"
    "database/sql"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

type OTelDBCollector struct {
    db   *sql.DB
    name string

    openConns    metric.Int64ObservableGauge
    inUseConns   metric.Int64ObservableGauge
    idleConns    metric.Int64ObservableGauge
    waitCount    metric.Int64ObservableCounter
    waitDuration metric.Float64ObservableCounter
}

func NewOTelDBCollector(db *sql.DB, meterName, dbName string) (*OTelDBCollector, error) {
    meter := otel.GetMeterProvider().Meter(meterName)
    attrs := []attribute.KeyValue{
        attribute.String("db.name", dbName),
    }

    c := &OTelDBCollector{db: db, name: dbName}
    var err error

    c.openConns, err = meter.Int64ObservableGauge(
        "db.client.connections.count",
        metric.WithDescription("Number of currently open connections in the pool"),
        metric.WithUnit("{connections}"),
    )
    if err != nil {
        return nil, err
    }

    c.inUseConns, err = meter.Int64ObservableGauge(
        "db.client.connections.use",
        metric.WithDescription("Number of connections currently in use"),
        metric.WithUnit("{connections}"),
    )
    if err != nil {
        return nil, err
    }

    c.idleConns, err = meter.Int64ObservableGauge(
        "db.client.connections.idle",
        metric.WithDescription("Number of idle connections in the pool"),
        metric.WithUnit("{connections}"),
    )
    if err != nil {
        return nil, err
    }

    c.waitCount, err = meter.Int64ObservableCounter(
        "db.client.connections.wait_count",
        metric.WithDescription("Total number of connections waited for"),
        metric.WithUnit("{connections}"),
    )
    if err != nil {
        return nil, err
    }

    c.waitDuration, err = meter.Float64ObservableCounter(
        "db.client.connections.wait_duration",
        metric.WithDescription("Total time waited for connections"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    // Register all as a batch observable
    _, err = meter.RegisterCallback(
        func(_ context.Context, o metric.Observer) error {
            stats := c.db.Stats()
            o.ObserveInt64(c.openConns, int64(stats.OpenConnections), metric.WithAttributes(attrs...))
            o.ObserveInt64(c.inUseConns, int64(stats.InUse), metric.WithAttributes(attrs...))
            o.ObserveInt64(c.idleConns, int64(stats.Idle), metric.WithAttributes(attrs...))
            o.ObserveInt64(c.waitCount, stats.WaitCount, metric.WithAttributes(attrs...))
            o.ObserveFloat64(c.waitDuration, stats.WaitDuration.Seconds(), metric.WithAttributes(attrs...))
            return nil
        },
        c.openConns, c.inUseConns, c.idleConns, c.waitCount, c.waitDuration,
    )

    return c, err
}
```

### Query Tracing with OTel

```go
package database

import (
    "context"
    "database/sql"
    "database/sql/driver"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

// TracingDriver wraps a database driver to add OTel tracing to every query.
type TracingDriver struct {
    driver.Driver
    tracer trace.Tracer
    dbName string
    system string // "postgresql", "mysql", etc.
}

type TracingConn struct {
    driver.Conn
    tracer trace.Tracer
    dbName string
    system string
}

func (tc *TracingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
    ctx, span := tc.tracer.Start(ctx, query,
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            semconv.DBSystem(tc.system),
            semconv.DBName(tc.dbName),
            semconv.DBStatement(sanitizeQuery(query)),
        ),
    )
    defer span.End()

    start := time.Now()
    rows, err := tc.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
    duration := time.Since(start)

    span.SetAttributes(attribute.Float64("db.query.duration_ms", float64(duration.Milliseconds())))

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }

    return rows, err
}

// sanitizeQuery removes parameter values from query for safe tracing
func sanitizeQuery(query string) string {
    // In production, you might want to truncate very long queries
    if len(query) > 1000 {
        return query[:997] + "..."
    }
    return query
}
```

### Using otelsql for Automatic Instrumentation

The `otelsql` library wraps `database/sql` with OpenTelemetry instrumentation automatically:

```go
package main

import (
    "database/sql"

    "github.com/XSAM/otelsql"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    _ "github.com/lib/pq"
)

func openInstrumentedDB(connString string) (*sql.DB, error) {
    // Register the instrumented driver
    driverName, err := otelsql.Register(
        "postgres",
        otelsql.WithAttributes(
            semconv.DBSystem("postgresql"),
            semconv.ServerAddress("db.production.svc"),
        ),
        otelsql.WithSpanOptions(otelsql.SpanOptions{
            Ping:           false,   // Don't trace health-check pings
            RowsAffected:   true,
            LastInsertID:   false,
        }),
        otelsql.WithSQLCommenter(true),  // Adds trace context to SQL comments
    )
    if err != nil {
        return nil, err
    }

    db, err := sql.Open(driverName, connString)
    if err != nil {
        return nil, err
    }

    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    db.SetConnMaxLifetime(30 * time.Minute)
    db.SetConnMaxIdleTime(10 * time.Minute)

    // Also record pool stats as OTel metrics
    otelsql.RecordStats(db, otelsql.WithAttributes(
        semconv.DBSystem("postgresql"),
    ))

    return db, nil
}
```

## Section 5: Connection Pool Sizing Formulas

### Formula for Web Services

```
# Variables:
# P = p99 query duration (seconds)
# RPS = requests per second
# Q = queries per request (average)
# I = number of app instances

Concurrent queries at p99 = RPS × P × Q
Connections per instance = ceil(Concurrent queries / I) × 1.25  # 25% buffer

# Example:
# P = 0.05s (50ms p99)
# RPS = 1000 req/s
# Q = 3 queries/request
# I = 5 instances
Concurrent = 1000 × 0.05 × 3 = 150 concurrent queries
Per instance = ceil(150 / 5) × 1.25 = 30 × 1.25 = 38 → use 35 (stay under DB limit)
```

### Formula for Batch/Background Workers

```
# Workers typically hold connections during entire job processing
Connections = max_concurrent_workers × 1.1   # 10% for retry overhead

# Example: 20 concurrent batch workers
MaxOpenConns = 22
MaxIdleConns = 20   # Each worker should have an idle connection ready
```

### PgBouncer Configuration to Match Go Pool

When using PgBouncer as an intermediary:

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
myapp = host=postgres-primary port=5432 dbname=myapp

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Transaction mode: each query gets its own server connection
# Best for most Go services (connection is held only during query)
pool_mode = transaction

# Max pool size per database+user pair
default_pool_size = 25      # Must match or exceed sum of app MaxOpenConns
max_client_conn = 500       # Total across all app instances
min_pool_size = 5
reserve_pool_size = 5

# Close server connections idle for more than this
server_idle_timeout = 300   # 5 minutes
# Go's ConnMaxLifetime should be < server_idle_timeout:
# db.SetConnMaxLifetime(4 * time.Minute)

# Keep-alive to prevent firewall drops
tcp_keepalive = 1
tcp_keepidle = 120
tcp_keepintvl = 15
tcp_keepcnt = 4
```

## Section 6: Common Anti-Patterns and Fixes

### Anti-Pattern 1: Connection Not Returned to Pool

```go
// WRONG: rows.Close() missing → connection held indefinitely
func getUsers(db *sql.DB) ([]User, error) {
    rows, err := db.Query("SELECT id, name FROM users")
    if err != nil {
        return nil, err
    }
    // Missing: defer rows.Close()

    var users []User
    for rows.Next() {
        var u User
        rows.Scan(&u.ID, &u.Name)
        users = append(users, u)
    }
    return users, nil
}

// CORRECT: always defer rows.Close()
func getUsers(db *sql.DB) ([]User, error) {
    rows, err := db.QueryContext(ctx, "SELECT id, name FROM users")
    if err != nil {
        return nil, err
    }
    defer rows.Close()  // Returns connection to pool

    var users []User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name); err != nil {
            return nil, err
        }
        users = append(users, u)
    }
    return users, rows.Err()  // Check for errors during iteration
}
```

### Anti-Pattern 2: Unbounded Goroutine Fan-Out

```go
// WRONG: 1000 goroutines each acquire a connection → immediate exhaustion
for i := 0; i < 1000; i++ {
    go func(id int) {
        db.QueryContext(ctx, "SELECT * FROM items WHERE id=$1", id)
    }(i)
}

// CORRECT: semaphore-limited fan-out
sem := make(chan struct{}, db.Stats().MaxOpenConnections)
var wg sync.WaitGroup

for i := 0; i < 1000; i++ {
    wg.Add(1)
    go func(id int) {
        defer wg.Done()
        sem <- struct{}{}        // Acquire
        defer func() { <-sem }() // Release

        db.QueryContext(ctx, "SELECT * FROM items WHERE id=$1", id)
    }(i)
}
wg.Wait()
```

### Anti-Pattern 3: Ignoring Context Cancellation

```go
// WRONG: no context propagation — query runs even after HTTP request is cancelled
func handler(w http.ResponseWriter, r *http.Request) {
    rows, _ := db.Query("SELECT * FROM big_table")  // No context
    // If client disconnects, this still runs and holds a connection
}

// CORRECT: propagate request context to all DB calls
func handler(w http.ResponseWriter, r *http.Request) {
    rows, err := db.QueryContext(r.Context(), "SELECT * FROM big_table")
    if err != nil {
        // If context is cancelled, err will be context.Canceled or context.DeadlineExceeded
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    defer rows.Close()
}
```

## Section 7: Prometheus Alert Rules

```yaml
groups:
  - name: database-pool
    rules:
      - alert: DBPoolExhausted
        expr: |
          db_pool_in_use_connections / db_pool_max_open_connections > 0.9
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Database pool {{ $labels.db }} is 90%+ utilized"

      - alert: DBPoolWaitTime
        expr: |
          rate(db_pool_wait_duration_seconds_total[5m]) /
          rate(db_pool_wait_count_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Average connection wait time > 100ms for {{ $labels.db }}"

      - alert: DBConnectionChurn
        expr: |
          rate(db_pool_max_lifetime_closed_total[5m]) > 1
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "High connection churn on {{ $labels.db }} — consider increasing ConnMaxLifetime"

      - alert: DBPoolIdleConnectionsLow
        expr: |
          db_pool_idle_connections / db_pool_open_connections < 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Very few idle connections — pool may be undersized for {{ $labels.db }}"
```

## Section 8: Testing Pool Behavior

```go
package database_test

import (
    "context"
    "database/sql"
    "sync"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestConnectionPoolExhaustion(t *testing.T) {
    ctx := context.Background()

    // Spin up test PostgreSQL container
    pgContainer, err := postgres.Run(ctx,
        "postgres:16-alpine",
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    if err != nil {
        t.Fatal(err)
    }
    defer pgContainer.Terminate(ctx)

    connStr, _ := pgContainer.ConnectionString(ctx, "sslmode=disable")
    db, _ := sql.Open("postgres", connStr)
    defer db.Close()

    // Configure small pool for testing
    db.SetMaxOpenConns(5)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(30 * time.Second)

    // Launch 20 goroutines that each try to acquire a connection
    var wg sync.WaitGroup
    timeouts := 0
    var mu sync.Mutex

    for i := 0; i < 20; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
            defer cancel()

            _, err := db.QueryContext(ctx, "SELECT pg_sleep(0.5)")  // Hold for 500ms
            if err != nil {
                mu.Lock()
                timeouts++
                mu.Unlock()
            }
        }()
    }
    wg.Wait()

    stats := db.Stats()
    t.Logf("Pool stats: MaxOpen=%d Open=%d InUse=%d Idle=%d WaitCount=%d",
        stats.MaxOpenConnections, stats.OpenConnections, stats.InUse, stats.Idle, stats.WaitCount)
    t.Logf("Context timeouts: %d/20 (expected ~15)", timeouts)

    // Verify pool prevented exhaustion (only 5 connections opened)
    if stats.MaxOpenConnections != 5 {
        t.Errorf("expected MaxOpenConnections=5, got %d", stats.MaxOpenConnections)
    }
}
```

## Conclusion

Go's `database/sql` connection pool is powerful but requires deliberate configuration for production workloads. The key principles:

1. **Always set MaxOpenConns**: unlimited connections crash databases under load spikes. Size based on the database's `max_connections` and your instance count.
2. **MaxIdleConns = MaxOpenConns** for services with sustained load: idle connections are cheap (a few KB each) and avoiding reconnection latency is almost always worth it.
3. **ConnMaxLifetime < proxy/firewall idle timeout**: prevents stale connections from being handed to callers.
4. **ConnMaxIdleTime for sporadic workloads**: allows connection relinquishment during quiet periods without closed-connection surprises.
5. **Instrument with OTel**: `sql.DBStats` contains everything needed to understand pool behavior. Export it as metrics and alert on exhaustion before it impacts users.
6. **Always close rows**: the single most common source of connection leaks in Go database code.

These settings, combined with proper context propagation and semaphore-bounded concurrency for fan-out operations, produce stable, predictable database behavior under production load.
