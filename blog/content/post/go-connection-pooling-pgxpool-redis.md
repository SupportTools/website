---
title: "Go Connection Pooling: pgxpool, sql.DB, and Redis Pool Optimization"
date: 2029-01-13T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "PostgreSQL", "Redis", "Connection Pooling", "pgxpool", "Performance"]
categories:
- Go
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise guide to Go database connection pooling covering pgxpool for PostgreSQL, database/sql configuration, and Redis pool optimization, with production sizing formulas, health checking, and observability patterns."
more_link: "yes"
url: "/go-connection-pooling-pgxpool-redis/"
---

Connection pooling is among the most impactful performance optimizations available to Go backend services. Opening a new database connection involves TCP handshakes, TLS negotiation, and database-side authentication — a process that can take 5–50 milliseconds. Under load, connection establishment overhead dominates latency unless connections are reused. This guide covers the full depth of connection pool configuration for PostgreSQL via `pgxpool` and the standard `database/sql`, plus Redis pool optimization with `go-redis/v9`, including sizing formulas, health checking, and Prometheus observability integration.

<!--more-->

## database/sql Connection Pooling

Go's `database/sql` package provides a built-in connection pool. Understanding its parameters is essential before examining specialized pool implementations.

### Core Configuration Parameters

```go
package db

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"

    _ "github.com/lib/pq"  // PostgreSQL driver
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

func NewSQLDB(cfg Config) (*sql.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d dbname=%s user=%s password=%s sslmode=%s",
        cfg.Host, cfg.Port, cfg.Database, cfg.User, cfg.Password, cfg.SSLMode,
    )

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    // MaxOpenConns: Maximum number of open connections (idle + in-use).
    // Default: 0 (unlimited). ALWAYS set this to avoid overwhelming the database.
    // Rule of thumb: min(PostgreSQL max_connections * 0.8 / service_instances, 25)
    db.SetMaxOpenConns(cfg.MaxOpenConns)

    // MaxIdleConns: Maximum number of connections to keep idle in the pool.
    // Default: 2. Should be <= MaxOpenConns.
    // For a stateless service processing bursty traffic: MaxOpenConns / 2
    // For a service with steady traffic: equal to MaxOpenConns
    db.SetMaxIdleConns(cfg.MaxIdleConns)

    // ConnMaxLifetime: Maximum time a connection may be reused.
    // Default: 0 (unlimited). Set to rotate connections and handle
    // load balancer connection cutoffs, certificate rotation, etc.
    // Typical value: 30–60 minutes
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

    // ConnMaxIdleTime: Maximum time a connection may sit idle in the pool.
    // Default: 0 (unlimited). Prevents accumulation of stale connections.
    // Typical value: 5–10 minutes
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

    // Verify connectivity immediately
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        _ = db.Close()
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    slog.Info("database connection pool initialized",
        "host", cfg.Host,
        "database", cfg.Database,
        "max_open", cfg.MaxOpenConns,
        "max_idle", cfg.MaxIdleConns,
    )

    return db, nil
}

// ProductionConfig returns pool settings appropriate for a
// production API server with moderate traffic.
func ProductionConfig() Config {
    return Config{
        Host:            "postgres.corp.example.com",
        Port:            5432,
        Database:        "appdb",
        User:            "appuser",
        SSLMode:         "verify-full",
        MaxOpenConns:    20,
        MaxIdleConns:    10,
        ConnMaxLifetime: 30 * time.Minute,
        ConnMaxIdleTime: 5 * time.Minute,
    }
}
```

### Pool Sizing Formula

```go
// pool_sizing.go
package db

// CalculatePoolSize returns recommended pool settings based on infrastructure
// and workload characteristics.
//
// Parameters:
//   pgMaxConnections: PostgreSQL max_connections parameter
//   serviceInstances: Number of service replicas (horizontal pods)
//   avgQueryDuration: Average query duration in milliseconds
//   targetRPS:        Target requests per second per instance
//
// Returns recommended MaxOpenConns and MaxIdleConns.
func CalculatePoolSize(
    pgMaxConnections int,
    serviceInstances int,
    avgQueryDurationMS float64,
    targetRPS float64,
) (maxOpen, maxIdle int) {
    // Reserve 20% of PostgreSQL connections for admin/monitoring
    availableConns := int(float64(pgMaxConnections) * 0.80)

    // Distribute evenly across service instances with safety margin
    connsPerInstance := availableConns / serviceInstances
    if connsPerInstance > 25 {
        // Cap per-instance pool to avoid single service overwhelming DB
        connsPerInstance = 25
    }

    // Little's Law: concurrent_connections = RPS * avg_latency_seconds
    // Add 30% headroom for bursts
    theoreticalConns := int(targetRPS * (avgQueryDurationMS / 1000) * 1.3)

    maxOpen = min(connsPerInstance, theoreticalConns)
    if maxOpen < 5 {
        maxOpen = 5 // Minimum for liveness
    }

    // Idle connections: 50% of max for bursty traffic,
    // or full max for steady workloads
    maxIdle = maxOpen / 2

    return maxOpen, maxIdle
}

// Example sizing calculation:
// PostgreSQL max_connections = 200
// Service instances = 4
// Average query duration = 5ms
// Target RPS per instance = 500
//
// availableConns = 160
// connsPerInstance = 40 → capped at 25
// theoreticalConns = 500 * 0.005 * 1.3 = 3.25 → 4
// maxOpen = min(25, 4) = 4
//
// In this scenario, the query is very fast (5ms) and RPS is high,
// so 4 connections can handle 500 RPS (500 * 0.005 = 2.5 concurrent)
```

## pgxpool: Native PostgreSQL Connection Pooling

`pgxpool` (from `github.com/jackc/pgx/v5/pgxpool`) is the connection pool for the `pgx` PostgreSQL driver. It provides richer functionality than `database/sql` pooling, including connection health checks, before-connect hooks, and per-connection configuration.

### pgxpool Configuration

```go
package db

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

func NewPgxPool(ctx context.Context) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(
        "postgres://appuser:secretpass@postgres.corp.example.com:5432/appdb?sslmode=verify-full",
    )
    if err != nil {
        return nil, fmt.Errorf("parsing pool config: %w", err)
    }

    // Pool sizing
    config.MaxConns = 20
    config.MinConns = 2  // Pre-warm connections; reduces cold-start latency
    config.MaxConnLifetime = 30 * time.Minute
    config.MaxConnLifetimeJitter = 5 * time.Minute  // Avoid synchronized reconnects
    config.MaxConnIdleTime = 5 * time.Minute
    config.HealthCheckPeriod = 30 * time.Second

    // BeforeAcquire: Called before a connection is returned to the caller.
    // Return false to reject and destroy the connection, triggering a new one.
    config.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Optional: verify connection-level settings are still valid
        // For most workloads, rely on HealthCheckPeriod instead
        return true
    }

    // AfterRelease: Called after a connection is returned to the pool.
    // Return false to destroy the connection instead of returning it.
    config.AfterRelease = func(conn *pgx.Conn) bool {
        // Check for any connection-level state that should not be reused
        // e.g., if a transaction was left open (should not happen in correct code)
        if conn.PgConn().TxStatus() != 'I' {
            slog.Warn("releasing connection with unexpected transaction status",
                "status", string(conn.PgConn().TxStatus()))
            return false  // Destroy this connection
        }
        return true
    }

    // BeforeConnect: Configure the raw pgx connection before it joins the pool.
    config.BeforeConnect = func(ctx context.Context, connConfig *pgx.ConnConfig) error {
        // Register custom types, codecs, etc.
        return nil
    }

    // ConnConfig: Low-level connection parameters
    config.ConnConfig.ConnectTimeout = 10 * time.Second

    // Statement caching: LRU cache of prepared statements per connection
    // Default: 512 entries. Set to 0 to disable (useful with PgBouncer in
    // transaction mode, which does not support prepared statements).
    config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement

    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    // Warm the pool by acquiring MinConns connections
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("pinging pool: %w", err)
    }

    slog.Info("pgxpool initialized",
        "host", config.ConnConfig.Host,
        "database", config.ConnConfig.Database,
        "max_conns", config.MaxConns,
        "min_conns", config.MinConns,
    )

    return pool, nil
}
```

### pgxpool with PgBouncer

When deploying behind PgBouncer in transaction pooling mode, prepared statements must be disabled because PgBouncer does not route prepared statement messages to the same backend connection.

```go
func NewPgxPoolWithPgBouncer(ctx context.Context, pgBouncerURL string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(pgBouncerURL)
    if err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }

    // CRITICAL: Disable prepared statements for PgBouncer transaction mode
    config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

    // PgBouncer manages the actual connection pool to PostgreSQL,
    // so keep the pgxpool size small — just enough for connection reuse
    config.MaxConns = 10
    config.MinConns = 1
    config.MaxConnLifetime = 5 * time.Minute
    config.MaxConnIdleTime = 60 * time.Second

    // PgBouncer does not support advisory locks, LISTEN/NOTIFY across
    // transaction boundaries, or session variables. Verify your queries
    // do not rely on session state.

    return pgxpool.NewWithConfig(ctx, config)
}
```

### Batch Operations with pgxpool

```go
// BatchInsert demonstrates efficient bulk inserts using pgx's SendBatch.
func BatchInsert(ctx context.Context, pool *pgxpool.Pool, events []Event) error {
    const batchSize = 500
    for i := 0; i < len(events); i += batchSize {
        end := i + batchSize
        if end > len(events) {
            end = len(events)
        }
        batch := events[i:end]

        if err := insertBatch(ctx, pool, batch); err != nil {
            return fmt.Errorf("inserting batch starting at %d: %w", i, err)
        }
    }
    return nil
}

func insertBatch(ctx context.Context, pool *pgxpool.Pool, events []Event) error {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    batch := &pgx.Batch{}
    for _, e := range events {
        batch.Queue(
            `INSERT INTO events (id, user_id, type, payload, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING`,
            e.ID, e.UserID, e.Type, e.Payload, e.CreatedAt,
        )
    }

    results := conn.SendBatch(ctx, batch)
    defer results.Close()

    for range events {
        if _, err := results.Exec(); err != nil {
            return fmt.Errorf("executing batch item: %w", err)
        }
    }

    return results.Close()
}
```

## Redis Connection Pool with go-redis/v9

```go
package cache

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisPoolConfig struct {
    Addrs          []string      // For cluster: multiple addresses
    Password       string
    DB             int           // For standalone only (0-15)
    PoolSize       int           // Connections per node
    MinIdleConns   int
    MaxIdleConns   int
    ConnMaxIdleTime time.Duration
    ConnMaxLifetime time.Duration
    DialTimeout    time.Duration
    ReadTimeout    time.Duration
    WriteTimeout   time.Duration
}

// NewRedisClusterClient creates a Redis Cluster client with optimized pool settings.
func NewRedisClusterClient(cfg RedisPoolConfig) (*redis.ClusterClient, error) {
    client := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:    cfg.Addrs,
        Password: cfg.Password,

        // Pool configuration
        PoolSize:        cfg.PoolSize,      // Per-node pool size (default: 10 * GOMAXPROCS)
        MinIdleConns:    cfg.MinIdleConns,  // Pre-warmed connections per node
        MaxIdleConns:    cfg.MaxIdleConns,  // Max idle per node
        ConnMaxIdleTime: cfg.ConnMaxIdleTime,
        ConnMaxLifetime: cfg.ConnMaxLifetime,

        // Timeouts
        DialTimeout:  cfg.DialTimeout,
        ReadTimeout:  cfg.ReadTimeout,
        WriteTimeout: cfg.WriteTimeout,
        PoolTimeout:  cfg.ReadTimeout + 1*time.Second, // Wait for connection from pool

        // Retry configuration
        MaxRetries:      3,
        MinRetryBackoff: 8 * time.Millisecond,
        MaxRetryBackoff: 512 * time.Millisecond,

        // TLS for production
        TLSConfig: productionTLSConfig(),

        // Hook for connection setup
        OnConnect: func(ctx context.Context, cn *redis.Conn) error {
            // Set client name for server-side identification
            return cn.ClientSetName(ctx, "myapp").Err()
        },
    })

    // Verify connectivity and cluster topology
    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()

    if err := client.Ping(ctx).Err(); err != nil {
        _ = client.Close()
        return nil, fmt.Errorf("pinging Redis cluster: %w", err)
    }

    // Verify cluster info
    info, err := client.ClusterInfo(ctx).Result()
    if err != nil {
        _ = client.Close()
        return nil, fmt.Errorf("getting cluster info: %w", err)
    }
    slog.Info("Redis cluster connected", "cluster_info", info[:100])

    return client, nil
}

// NewRedisStandaloneClient creates a single-instance Redis client.
// Use this for development environments or single-node deployments.
func NewRedisStandaloneClient(cfg RedisPoolConfig) (*redis.Client, error) {
    client := redis.NewClient(&redis.Options{
        Addr:     cfg.Addrs[0],
        Password: cfg.Password,
        DB:       cfg.DB,

        PoolSize:        cfg.PoolSize,
        MinIdleConns:    cfg.MinIdleConns,
        MaxIdleConns:    cfg.MaxIdleConns,
        ConnMaxIdleTime: cfg.ConnMaxIdleTime,
        ConnMaxLifetime: cfg.ConnMaxLifetime,

        DialTimeout:  cfg.DialTimeout,
        ReadTimeout:  cfg.ReadTimeout,
        WriteTimeout: cfg.WriteTimeout,
        PoolTimeout:  4 * time.Second,

        MaxRetries:      3,
        MinRetryBackoff: 8 * time.Millisecond,
        MaxRetryBackoff: 256 * time.Millisecond,

        OnConnect: func(ctx context.Context, cn *redis.Conn) error {
            return cn.ClientSetName(ctx, "myapp").Err()
        },
    })

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    if err := client.Ping(ctx).Err(); err != nil {
        _ = client.Close()
        return nil, fmt.Errorf("pinging Redis: %w", err)
    }

    return client, nil
}

// ProductionRedisPoolConfig returns production-tuned pool settings.
// Assumptions: 6-node Redis Cluster, 4 service instances, ~2000 Redis ops/s per instance
func ProductionRedisPoolConfig() RedisPoolConfig {
    return RedisPoolConfig{
        Addrs: []string{
            "redis-node-1.corp.example.com:6379",
            "redis-node-2.corp.example.com:6379",
            "redis-node-3.corp.example.com:6379",
        },
        PoolSize:        20,              // 20 connections per node per instance
        MinIdleConns:    5,               // Pre-warm 5 connections per node
        MaxIdleConns:    10,
        ConnMaxIdleTime: 5 * time.Minute,
        ConnMaxLifetime: 30 * time.Minute,
        DialTimeout:     5 * time.Second,
        ReadTimeout:     3 * time.Second,
        WriteTimeout:    3 * time.Second,
    }
}
```

## Pool Observability with Prometheus

```go
// internal/metrics/db_metrics.go
package metrics

import (
    "database/sql"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/redis/go-redis/v9"
)

var (
    // PostgreSQL pool metrics
    pgPoolAcquireCount = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "db_pool_acquire_total",
        Help: "Total number of connection acquisitions from the pool",
    }, []string{"database"})

    pgPoolAcquireDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "db_pool_acquire_duration_seconds",
        Help:    "Duration of connection acquisition from the pool",
        Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
    }, []string{"database"})

    pgPoolOpenConnections = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "db_pool_open_connections",
        Help: "Number of open connections in the pool",
    }, []string{"database", "state"})

    pgPoolMaxConnections = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "db_pool_max_connections",
        Help: "Maximum number of connections configured in the pool",
    }, []string{"database"})

    // Redis pool metrics
    redisPoolHits = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "redis_pool_hits_total",
        Help: "Total number of times a free connection was found in the pool",
    }, []string{"addr"})

    redisPoolMisses = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "redis_pool_misses_total",
        Help: "Total number of times a free connection was NOT found in the pool",
    }, []string{"addr"})

    redisPoolTimeouts = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "redis_pool_timeouts_total",
        Help: "Total number of pool timeouts",
    }, []string{"addr"})
)

// CollectPgxPoolStats records pgxpool statistics to Prometheus.
func CollectPgxPoolStats(pool *pgxpool.Pool, dbName string) {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            stats := pool.Stat()
            pgPoolOpenConnections.WithLabelValues(dbName, "idle").
                Set(float64(stats.IdleConns()))
            pgPoolOpenConnections.WithLabelValues(dbName, "in_use").
                Set(float64(stats.AcquiredConns()))
            pgPoolOpenConnections.WithLabelValues(dbName, "total").
                Set(float64(stats.TotalConns()))
            pgPoolMaxConnections.WithLabelValues(dbName).
                Set(float64(stats.MaxConns()))
            pgPoolAcquireCount.WithLabelValues(dbName).
                Add(float64(stats.EmptyAcquireCount()))
        }
    }()
}

// CollectSQLDBStats records database/sql pool statistics to Prometheus.
func CollectSQLDBStats(db *sql.DB, dbName string) {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            stats := db.Stats()
            pgPoolOpenConnections.WithLabelValues(dbName, "idle").
                Set(float64(stats.Idle))
            pgPoolOpenConnections.WithLabelValues(dbName, "in_use").
                Set(float64(stats.InUse))
            pgPoolOpenConnections.WithLabelValues(dbName, "total").
                Set(float64(stats.OpenConnections))
            pgPoolMaxConnections.WithLabelValues(dbName).
                Set(float64(stats.MaxOpenConnections))
        }
    }()
}

// CollectRedisPoolStats records Redis pool statistics to Prometheus.
func CollectRedisPoolStats(client *redis.Client, addr string) {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            stats := client.PoolStats()
            redisPoolHits.WithLabelValues(addr).Add(float64(stats.Hits))
            redisPoolMisses.WithLabelValues(addr).Add(float64(stats.Misses))
            redisPoolTimeouts.WithLabelValues(addr).Add(float64(stats.Timeouts))
        }
    }()
}
```

## Context-Aware Query Patterns

Proper context propagation through the pool is critical for graceful request cancellation and timeout enforcement.

```go
package repository

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type UserRepository struct {
    pool *pgxpool.Pool
}

type User struct {
    ID        int64
    Email     string
    CreatedAt time.Time
}

// GetByID retrieves a user within the given context's deadline.
// The pool honors context cancellation — if the caller times out,
// the connection acquisition and query are both cancelled.
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
    // Add a query-specific timeout if one is not already set
    // This prevents individual slow queries from holding connections indefinitely
    queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    var u User
    err := r.pool.QueryRow(queryCtx,
        `SELECT id, email, created_at FROM users WHERE id = $1`,
        id,
    ).Scan(&u.ID, &u.Email, &u.CreatedAt)

    if err == pgx.ErrNoRows {
        return nil, nil
    }
    if err != nil {
        return nil, fmt.Errorf("querying user %d: %w", id, err)
    }
    return &u, nil
}

// GetByIDs fetches multiple users in a single query, avoiding N+1 patterns.
func (r *UserRepository) GetByIDs(ctx context.Context, ids []int64) ([]*User, error) {
    queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    rows, err := r.pool.Query(queryCtx,
        `SELECT id, email, created_at FROM users WHERE id = ANY($1)`,
        ids,
    )
    if err != nil {
        return nil, fmt.Errorf("querying users: %w", err)
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Email, &u.CreatedAt); err != nil {
            return nil, fmt.Errorf("scanning user: %w", err)
        }
        users = append(users, &u)
    }
    return users, rows.Err()
}

// WithTransaction executes fn within a transaction, automatically
// rolling back on error or panic.
func (r *UserRepository) WithTransaction(
    ctx context.Context,
    fn func(ctx context.Context, tx pgx.Tx) error,
) error {
    conn, err := r.pool.Acquire(ctx)
    if err != nil {
        return fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    tx, err := conn.BeginTx(ctx, pgx.TxOptions{
        IsoLevel:   pgx.Serializable,
        AccessMode: pgx.ReadWrite,
    })
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    defer func() {
        if p := recover(); p != nil {
            _ = tx.Rollback(ctx)
            panic(p)
        }
    }()

    if err := fn(ctx, tx); err != nil {
        if rbErr := tx.Rollback(ctx); rbErr != nil {
            return fmt.Errorf("fn error: %w; rollback error: %v", err, rbErr)
        }
        return err
    }

    return tx.Commit(ctx)
}
```

## Prometheus Alert Rules for Pool Exhaustion

```yaml
# prometheus/rules/connection-pool-alerts.yaml
groups:
  - name: connection_pools
    rules:
      - alert: DatabasePoolNearlyExhausted
        expr: |
          (db_pool_open_connections{state="in_use"} /
           db_pool_max_connections) > 0.85
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Database pool {{ $labels.database }} nearly exhausted"
          description: >
            {{ $value | humanizePercentage }} of connections in use.
            Consider increasing MaxOpenConns or adding read replicas.

      - alert: DatabasePoolExhausted
        expr: |
          (db_pool_open_connections{state="in_use"} /
           db_pool_max_connections) > 0.99
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Database pool {{ $labels.database }} exhausted"
          description: >
            Connection pool is exhausted. Requests are queuing or failing.

      - alert: RedisPoolHighMissRate
        expr: |
          rate(redis_pool_misses_total[5m]) /
          (rate(redis_pool_hits_total[5m]) + rate(redis_pool_misses_total[5m]))
          > 0.20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis pool miss rate high on {{ $labels.addr }}"
          description: >
            Redis pool miss rate is {{ $value | humanizePercentage }}.
            New connections are being created frequently. Consider increasing PoolSize.

      - alert: RedisPoolTimeouts
        expr: rate(redis_pool_timeouts_total[5m]) > 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Redis pool timeouts on {{ $labels.addr }}"
          description: >
            Redis connections are timing out at {{ $value }}/s.
            Pool may be exhausted or Redis is overloaded.
```

## Connection Pool Diagnostic Queries

```bash
# Check active connections per application on PostgreSQL
psql -U postgres -c "
SELECT
    application_name,
    state,
    COUNT(*) AS connection_count,
    MAX(EXTRACT(EPOCH FROM (NOW() - state_change))) AS oldest_state_seconds
FROM pg_stat_activity
WHERE datname = 'appdb'
GROUP BY application_name, state
ORDER BY connection_count DESC;
"

# Check for idle connections holding locks
psql -U postgres -c "
SELECT pid, application_name, state, wait_event_type, wait_event,
       LEFT(query, 100) AS query,
       EXTRACT(EPOCH FROM (NOW() - query_start)) AS query_seconds
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND query_start < NOW() - INTERVAL '1 minute'
ORDER BY query_seconds DESC;
"

# Redis pool stats via redis-cli
redis-cli -h redis.corp.example.com -p 6379 CLIENT LIST | \
  awk '{for(i=1;i<=NF;i++) if($i ~ /name=/) print $i}' | \
  sort | uniq -c | sort -rn | head -20

# Redis connection count by client type
redis-cli -h redis.corp.example.com -p 6379 INFO clients
```

## Summary

Effective connection pooling requires understanding the interaction between pool configuration, database server limits, and workload characteristics. Key production recommendations:

- Always set `MaxOpenConns` on `database/sql`; the default of unlimited can exhaust database server connection limits
- Use `pgxpool` over `database/sql` for PostgreSQL when using `pgx` driver features; it provides richer pool lifecycle hooks and statistics
- Disable prepared statement caching (`QueryExecModeSimpleProtocol`) when running behind PgBouncer in transaction mode
- Set `ConnMaxLifetime` with jitter (`MaxConnLifetimeJitter` in pgxpool) to prevent synchronized reconnection storms
- Monitor pool utilization with Prometheus; alert at 85% utilization to provide actionable lead time before exhaustion
- Pre-warm connections with `MinIdleConns`/`MinConns` on services where cold-start latency matters
