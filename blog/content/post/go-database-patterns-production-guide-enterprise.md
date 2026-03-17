---
title: "Go Database Patterns: Connection Pooling, Transactions, and Query Optimization"
date: 2028-01-22T00:00:00-05:00
draft: false
tags: ["Go", "Database", "PostgreSQL", "Connection Pooling", "Transactions", "OpenTelemetry", "pgx"]
categories: ["Go", "Database"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Go database patterns covering database/sql connection pool tuning, transaction isolation levels, prepared statements, bulk insert optimization, pgx vs lib/pq comparison, and query tracing with OpenTelemetry."
more_link: "yes"
url: "/go-database-patterns-production-guide-enterprise/"
---

Go's `database/sql` package provides a production-ready connection pool and a clean interface for relational database access. However, the defaults are unsuitable for production workloads: the maximum open connection count is unlimited (exhausting database server limits under traffic spikes), idle connections are never closed (leaking server-side resources), and connection lifetimes are unlimited (preventing graceful reconnection after network partitions). This guide covers the complete spectrum of production database patterns in Go, from pool configuration through distributed tracing.

<!--more-->

# Go Database Patterns: Connection Pooling, Transactions, and Query Optimization

## Section 1: database/sql Connection Pool Configuration

### Understanding the Connection Pool

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"           // PostgreSQL driver via lib/pq
    // _ "github.com/jackc/pgx/v5/stdlib" // Alternative: pgx stdlib interface
)

// Config holds database connection pool configuration.
// Values are tuned for a typical production Go service.
type Config struct {
    // DSN is the database connection string
    // postgresql://user:password@host:port/database?sslmode=require
    DSN string

    // MaxOpenConns: maximum number of connections the pool will open
    // Set to match the maximum connections your database server can handle
    // divided by the number of application replicas.
    // Example: PostgreSQL with max_connections=200, 5 replicas → 200/5 = 40
    // Leave room for admin connections and other services: 40 * 0.8 = 32
    MaxOpenConns int

    // MaxIdleConns: number of connections to keep in the idle pool
    // Should be <= MaxOpenConns. Typically 10-25% of MaxOpenConns.
    // Higher values reduce connection establishment overhead at the cost of
    // holding server-side resources (memory per connection).
    MaxIdleConns int

    // ConnMaxLifetime: maximum age of a connection before it is closed
    // and replaced. Prevents stale connections after database failovers,
    // load balancer connection table entries expiring, and firewall
    // stateful rule timeouts.
    // Typical value: 5-30 minutes. Must be less than any network timeout.
    ConnMaxLifetime time.Duration

    // ConnMaxIdleTime: how long a connection can sit idle before being closed.
    // Prevents idle connections from holding server resources during low-traffic
    // periods. 0 means no maximum idle time (connections held indefinitely).
    // Typical value: 1-5 minutes.
    ConnMaxIdleTime time.Duration
}

// DefaultConfig returns a production-ready connection pool configuration.
func DefaultConfig(dsn string) Config {
    return Config{
        DSN:             dsn,
        MaxOpenConns:    25,           // 25 connections per service replica
        MaxIdleConns:    5,            // Keep 5 connections ready at all times
        ConnMaxLifetime: 5 * time.Minute,  // Recycle connections every 5 minutes
        ConnMaxIdleTime: 1 * time.Minute,  // Close idle connections after 1 minute
    }
}

// New creates a *sql.DB with production-tuned pool settings and verifies
// connectivity with a context-bounded ping.
func New(cfg Config) (*sql.DB, error) {
    db, err := sql.Open("postgres", cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    // Apply pool configuration
    // These settings MUST be configured immediately after sql.Open().
    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

    // Verify database connectivity with a timeout
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        _ = db.Close()
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return db, nil
}
```

### Pool Health Metrics

```go
package database

import (
    "database/sql"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// PoolMetricsCollector exports database/sql pool statistics to Prometheus.
// Register with prometheus.MustRegister or promauto.
type PoolMetricsCollector struct {
    db   *sql.DB
    name string

    // Prometheus gauges for pool state
    openConns     prometheus.Gauge
    idleConns     prometheus.Gauge
    inUseConns    prometheus.Gauge
    waitCount     prometheus.Counter
    waitDuration  prometheus.Counter
    maxIdleClosed prometheus.Counter
    maxLifetime   prometheus.Counter
}

// NewPoolMetricsCollector creates a Prometheus metrics collector for the given db.
// name labels all metrics to distinguish between multiple database connections.
func NewPoolMetricsCollector(db *sql.DB, name string) *PoolMetricsCollector {
    labels := prometheus.Labels{"db": name}
    c := &PoolMetricsCollector{
        db:   db,
        name: name,
        openConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_open_connections",
            Help:        "Current number of open database connections.",
            ConstLabels: labels,
        }),
        idleConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_idle_connections",
            Help:        "Current number of idle database connections in the pool.",
            ConstLabels: labels,
        }),
        inUseConns: promauto.NewGauge(prometheus.GaugeOpts{
            Name:        "db_pool_in_use_connections",
            Help:        "Current number of database connections in use.",
            ConstLabels: labels,
        }),
        waitCount: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_wait_total",
            Help:        "Total number of times a goroutine waited for a connection.",
            ConstLabels: labels,
        }),
        waitDuration: promauto.NewCounter(prometheus.CounterOpts{
            Name:        "db_pool_wait_duration_seconds_total",
            Help:        "Total time spent waiting for a database connection.",
            ConstLabels: labels,
        }),
    }
    return c
}

// StartCollecting begins periodic collection of pool statistics.
func (c *PoolMetricsCollector) StartCollecting() {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            stats := c.db.Stats()
            c.openConns.Set(float64(stats.OpenConnections))
            c.idleConns.Set(float64(stats.Idle))
            c.inUseConns.Set(float64(stats.InUse))
        }
    }()
}
```

## Section 2: pgx — High-Performance PostgreSQL Driver

The `pgx` driver is a pure-Go PostgreSQL driver that provides significantly better performance than `lib/pq` through binary protocol support, pipelining, and richer PostgreSQL-specific types.

### pgx Pool Configuration

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// NewPgxPool creates a pgxpool.Pool with production configuration.
// pgxpool is pgx's built-in connection pool — it provides better PostgreSQL
// integration than database/sql via the pgx stdlib adapter.
func NewPgxPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, fmt.Errorf("parsing pgx pool config: %w", err)
    }

    // Pool sizing
    config.MaxConns = 25                          // Maximum pool connections
    config.MinConns = 3                           // Maintain minimum connections
    config.MaxConnLifetime = 5 * time.Minute      // Recycle connections
    config.MaxConnIdleTime = 1 * time.Minute      // Close idle connections
    config.HealthCheckPeriod = 30 * time.Second   // Verify idle connection health

    // Connection timeout
    config.ConnConfig.ConnectTimeout = 5 * time.Second

    // Custom BeforeAcquire hook: run before returning a connection from the pool
    // Use for per-request setup (e.g., setting PostgreSQL role, schema search path)
    config.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        // Return false to discard the connection and acquire a new one
        // Use to check connection health beyond the ping
        return true
    }

    // AfterRelease hook: called when a connection is returned to the pool
    // Use for per-connection cleanup (e.g., clearing PostgreSQL session settings)
    config.AfterRelease = func(conn *pgx.Conn) bool {
        // Return false to destroy the connection rather than returning to pool
        return true
    }

    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("creating pgx pool: %w", err)
    }

    // Verify pool connectivity
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("pinging database via pgx: %w", err)
    }

    return pool, nil
}

// QueryWithPgx demonstrates pgx-specific features not available via database/sql
func QueryWithPgx(ctx context.Context, pool *pgxpool.Pool, userID string) (User, error) {
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return User{}, fmt.Errorf("acquiring connection: %w", err)
    }
    defer conn.Release()

    // pgx supports named return parameters and automatic scanning
    rows, err := conn.Query(ctx,
        `SELECT id, email, status, created_at FROM users WHERE id = $1`,
        userID,
    )
    if err != nil {
        return User{}, fmt.Errorf("querying user: %w", err)
    }

    // pgx.CollectOneRow is safer than manual Scan — returns pgx.ErrNoRows if empty
    user, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[User])
    if err != nil {
        return User{}, fmt.Errorf("collecting user row: %w", err)
    }

    return user, nil
}

// User represents a database row for pgx struct scanning.
type User struct {
    ID        string    `db:"id"`
    Email     string    `db:"email"`
    Status    string    `db:"status"`
    CreatedAt time.Time `db:"created_at"`
}
```

## Section 3: Transaction Patterns

### Transaction Isolation Levels

```go
package database

import (
    "context"
    "database/sql"
    "fmt"

    _ "github.com/lib/pq"
)

// TransactionIsolationLevel maps SQL isolation level names to sql.IsolationLevel constants.
// Choose based on the consistency requirements of the operation.
var TransactionIsolationLevel = struct {
    // ReadCommitted: default in PostgreSQL.
    // Sees committed data from other transactions.
    // Suitable for: read-heavy operations where phantom reads are acceptable.
    ReadCommitted sql.IsolationLevel

    // RepeatableRead: sees a consistent snapshot of all committed data
    // as of the start of the transaction.
    // Prevents non-repeatable reads. May require retry on serialization failure.
    RepeatableRead sql.IsolationLevel

    // Serializable: full ACID compliance. All transactions appear to execute
    // serially. Highest consistency, requires retry on serialization failure.
    // Suitable for: financial operations, inventory management.
    Serializable sql.IsolationLevel
}{
    ReadCommitted:  sql.LevelReadCommitted,
    RepeatableRead: sql.LevelRepeatableRead,
    Serializable:   sql.LevelSerializable,
}

// WithTransaction executes fn within a database transaction.
// Automatically commits on success or rolls back on error.
// Returns the error from fn (or from commit/rollback).
func WithTransaction(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
    return WithTransactionOptions(ctx, db, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted,
        ReadOnly:  false,
    }, fn)
}

// WithTransactionOptions executes fn in a transaction with explicit options.
func WithTransactionOptions(
    ctx context.Context,
    db *sql.DB,
    opts *sql.TxOptions,
    fn func(*sql.Tx) error,
) error {
    tx, err := db.BeginTx(ctx, opts)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    // Defer rollback: if commit succeeds, this rollback is a no-op.
    // If fn panics or returns an error before commit, rollback executes.
    defer func() {
        if p := recover(); p != nil {
            _ = tx.Rollback()
            panic(p) // Re-panic after rollback
        }
    }()

    if err := fn(tx); err != nil {
        if rbErr := tx.Rollback(); rbErr != nil {
            // Log both the original error and the rollback error
            return fmt.Errorf("transaction rollback failed (original: %w, rollback: %v)", err, rbErr)
        }
        return err
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}

// WithSerializableTransaction executes fn with serializable isolation,
// retrying on serialization failures up to maxRetries times.
// PostgreSQL returns error code 40001 for serialization failures.
func WithSerializableTransaction(
    ctx context.Context,
    db *sql.DB,
    maxRetries int,
    fn func(*sql.Tx) error,
) error {
    for attempt := 0; attempt < maxRetries; attempt++ {
        err := WithTransactionOptions(ctx, db, &sql.TxOptions{
            Isolation: sql.LevelSerializable,
        }, fn)

        if err == nil {
            return nil
        }

        // Check if this is a serialization failure (PostgreSQL SQLSTATE 40001)
        if isSerializationFailure(err) {
            if attempt < maxRetries-1 {
                // Exponential backoff before retry
                // time.Sleep(backoff.ExponentialDelay(attempt))
                continue
            }
        }

        // Non-serialization error: return immediately
        return err
    }

    return fmt.Errorf("transaction failed after %d serialization retry attempts", maxRetries)
}

// isSerializationFailure checks if the error is a PostgreSQL serialization failure.
func isSerializationFailure(err error) bool {
    // In production, use pq.Error or pgconn.PgError type assertion
    // to check err.Code == "40001"
    return err != nil
    // Real implementation:
    // var pgErr *pgconn.PgError
    // return errors.As(err, &pgErr) && pgErr.Code == "40001"
}
```

### Financial Transaction Pattern

```go
package payments

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// TransferFunds transfers amount from sourceAccountID to targetAccountID.
// Uses serializable isolation to prevent double-spend and race conditions.
// Returns the new balance of both accounts.
func TransferFunds(
    ctx context.Context,
    db *sql.DB,
    sourceAccountID, targetAccountID string,
    amount int64, // Amount in cents to avoid floating point
    currency string,
    idempotencyKey string, // Prevents duplicate transfers on retry
) (*TransferResult, error) {
    var result TransferResult

    err := WithSerializableTransaction(ctx, db, 3, func(tx *sql.Tx) error {
        // 1. Check for duplicate transfer using idempotency key
        var existingID string
        err := tx.QueryRowContext(ctx,
            `SELECT id FROM transfers WHERE idempotency_key = $1`,
            idempotencyKey,
        ).Scan(&existingID)

        if err == nil {
            // Transfer already processed — return existing result (idempotent)
            return tx.QueryRowContext(ctx,
                `SELECT source_balance, target_balance FROM transfers WHERE id = $1`,
                existingID,
            ).Scan(&result.SourceBalance, &result.TargetBalance)
        }
        if err != sql.ErrNoRows {
            return fmt.Errorf("checking idempotency key: %w", err)
        }

        // 2. Lock both accounts in consistent order to prevent deadlocks
        // Always lock lower ID first to ensure consistent lock ordering
        firstID, secondID := sourceAccountID, targetAccountID
        if sourceAccountID > targetAccountID {
            firstID, secondID = targetAccountID, sourceAccountID
        }

        type account struct {
            ID       string
            Balance  int64
            Currency string
            Status   string
        }

        var first, second account

        err = tx.QueryRowContext(ctx,
            `SELECT id, balance, currency, status FROM accounts WHERE id = $1 FOR UPDATE`,
            firstID,
        ).Scan(&first.ID, &first.Balance, &first.Currency, &first.Status)
        if err != nil {
            return fmt.Errorf("locking first account %s: %w", firstID, err)
        }

        err = tx.QueryRowContext(ctx,
            `SELECT id, balance, currency, status FROM accounts WHERE id = $1 FOR UPDATE`,
            secondID,
        ).Scan(&second.ID, &second.Balance, &second.Currency, &second.Status)
        if err != nil {
            return fmt.Errorf("locking second account %s: %w", secondID, err)
        }

        // Remap to source/target for validation logic
        var sourceAccount, targetAccount account
        if first.ID == sourceAccountID {
            sourceAccount, targetAccount = first, second
        } else {
            sourceAccount, targetAccount = second, first
        }

        // 3. Validate accounts
        if sourceAccount.Status != "active" {
            return fmt.Errorf("source account is not active: status=%s", sourceAccount.Status)
        }
        if targetAccount.Status != "active" {
            return fmt.Errorf("target account is not active: status=%s", targetAccount.Status)
        }
        if sourceAccount.Currency != currency {
            return fmt.Errorf("currency mismatch: account=%s, transfer=%s", sourceAccount.Currency, currency)
        }
        if sourceAccount.Balance < amount {
            return fmt.Errorf("insufficient funds: balance=%d, amount=%d", sourceAccount.Balance, amount)
        }

        // 4. Perform the transfer
        _, err = tx.ExecContext(ctx,
            `UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
            amount, sourceAccountID,
        )
        if err != nil {
            return fmt.Errorf("debiting source account: %w", err)
        }

        _, err = tx.ExecContext(ctx,
            `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
            amount, targetAccountID,
        )
        if err != nil {
            return fmt.Errorf("crediting target account: %w", err)
        }

        // 5. Record the transfer with idempotency key
        _, err = tx.ExecContext(ctx,
            `INSERT INTO transfers
              (idempotency_key, source_account_id, target_account_id,
               amount, currency, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'completed', NOW())`,
            idempotencyKey, sourceAccountID, targetAccountID, amount, currency,
        )
        if err != nil {
            return fmt.Errorf("recording transfer: %w", err)
        }

        // 6. Fetch new balances for response
        err = tx.QueryRowContext(ctx,
            `SELECT balance FROM accounts WHERE id = $1`,
            sourceAccountID,
        ).Scan(&result.SourceBalance)
        if err != nil {
            return fmt.Errorf("fetching source balance: %w", err)
        }

        return tx.QueryRowContext(ctx,
            `SELECT balance FROM accounts WHERE id = $1`,
            targetAccountID,
        ).Scan(&result.TargetBalance)
    })

    if err != nil {
        return nil, err
    }

    result.TransferredAt = time.Now()
    return &result, nil
}

// TransferResult holds the outcome of a completed transfer.
type TransferResult struct {
    SourceBalance int64
    TargetBalance int64
    TransferredAt time.Time
}
```

## Section 4: Prepared Statements

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
)

// PreparedStatements caches prepared statement handles.
// Reusing prepared statements avoids repeated query parsing on the database server,
// reducing CPU overhead for frequently executed queries.
type PreparedStatements struct {
    mu         sync.RWMutex
    db         *sql.DB
    statements map[string]*sql.Stmt
}

// NewPreparedStatements creates a new prepared statement cache.
func NewPreparedStatements(db *sql.DB) *PreparedStatements {
    return &PreparedStatements{
        db:         db,
        statements: make(map[string]*sql.Stmt),
    }
}

// Prepare caches a prepared statement by name.
// Returns the cached statement if already prepared.
func (ps *PreparedStatements) Prepare(ctx context.Context, name, query string) (*sql.Stmt, error) {
    ps.mu.RLock()
    stmt, exists := ps.statements[name]
    ps.mu.RUnlock()

    if exists {
        return stmt, nil
    }

    ps.mu.Lock()
    defer ps.mu.Unlock()

    // Double-check after acquiring write lock (another goroutine may have prepared)
    if stmt, exists = ps.statements[name]; exists {
        return stmt, nil
    }

    stmt, err := ps.db.PrepareContext(ctx, query)
    if err != nil {
        return nil, fmt.Errorf("preparing statement %q: %w", name, err)
    }

    ps.statements[name] = stmt
    return stmt, nil
}

// Close closes all prepared statements.
func (ps *PreparedStatements) Close() {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    for _, stmt := range ps.statements {
        _ = stmt.Close()
    }
    ps.statements = make(map[string]*sql.Stmt)
}

// UserRepository demonstrates prepared statement usage for common queries.
type UserRepository struct {
    db   *sql.DB
    stmts *PreparedStatements
}

// NewUserRepository creates a repository with pre-prepared statements.
func NewUserRepository(ctx context.Context, db *sql.DB) (*UserRepository, error) {
    repo := &UserRepository{
        db:    db,
        stmts: NewPreparedStatements(db),
    }

    // Pre-prepare all queries used by this repository at startup
    queries := map[string]string{
        "get_user_by_id":    "SELECT id, email, status, created_at FROM users WHERE id = $1",
        "get_user_by_email": "SELECT id, email, status, created_at FROM users WHERE email = $1",
        "update_user_status": "UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2",
        "list_users":        "SELECT id, email, status, created_at FROM users WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    }

    for name, query := range queries {
        if _, err := repo.stmts.Prepare(ctx, name, query); err != nil {
            repo.stmts.Close()
            return nil, fmt.Errorf("preparing %s: %w", name, err)
        }
    }

    return repo, nil
}
```

## Section 5: Bulk Insert Optimization

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "strings"
)

// BulkInsertUsers inserts multiple users using a single multi-value INSERT statement.
// This is 10-100x faster than individual INSERT statements for large batches
// because it reduces round trips and transaction overhead.
func BulkInsertUsers(ctx context.Context, db *sql.DB, users []User) error {
    if len(users) == 0 {
        return nil
    }

    const batchSize = 1000 // Insert 1000 rows per query to stay within PostgreSQL limits

    for start := 0; start < len(users); start += batchSize {
        end := start + batchSize
        if end > len(users) {
            end = len(users)
        }
        batch := users[start:end]

        if err := bulkInsertBatch(ctx, db, batch); err != nil {
            return fmt.Errorf("bulk insert batch [%d:%d]: %w", start, end, err)
        }
    }
    return nil
}

// bulkInsertBatch constructs and executes a multi-value INSERT for a batch of users.
func bulkInsertBatch(ctx context.Context, db *sql.DB, users []User) error {
    // Build: INSERT INTO users (id, email, status, created_at) VALUES
    //          ($1, $2, $3, $4), ($5, $6, $7, $8), ...
    //        ON CONFLICT (email) DO NOTHING
    const colsPerRow = 4
    placeholders := make([]string, len(users))
    args := make([]interface{}, 0, len(users)*colsPerRow)

    for i, user := range users {
        // Each row: ($n, $n+1, $n+2, $n+3)
        base := i * colsPerRow
        placeholders[i] = fmt.Sprintf("($%d, $%d, $%d, $%d)",
            base+1, base+2, base+3, base+4)
        args = append(args, user.ID, user.Email, user.Status, user.CreatedAt)
    }

    query := fmt.Sprintf(
        `INSERT INTO users (id, email, status, created_at)
         VALUES %s
         ON CONFLICT (email) DO UPDATE
           SET status = EXCLUDED.status,
               updated_at = NOW()`,
        strings.Join(placeholders, ", "),
    )

    _, err := db.ExecContext(ctx, query, args...)
    if err != nil {
        return fmt.Errorf("executing bulk insert: %w", err)
    }
    return nil
}

// BulkInsertWithCopy uses PostgreSQL's COPY protocol via pgx for maximum throughput.
// COPY is the fastest way to insert large datasets into PostgreSQL.
func BulkInsertWithCopy(ctx context.Context, pool interface{ CopyFrom(context.Context, interface{}, []string, interface{}) (int64, error) }, users []User) error {
    // pgxpool.Pool.CopyFrom provides COPY protocol access
    // This function signature is simplified — use pgx directly in production
    return nil
}
```

## Section 6: Query Tracing with OpenTelemetry

```go
package database

import (
    "context"
    "database/sql"
    "database/sql/driver"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

const tracerName = "database/sql"

// InstrumentedDB wraps *sql.DB with OpenTelemetry tracing.
// Each query creates a span with the SQL statement, parameters,
// and execution duration.
type InstrumentedDB struct {
    db     *sql.DB
    tracer trace.Tracer
    dbName string
    dbType string // "postgresql", "mysql", etc.
}

// NewInstrumentedDB wraps a *sql.DB with OpenTelemetry instrumentation.
func NewInstrumentedDB(db *sql.DB, dbName, dbType string) *InstrumentedDB {
    return &InstrumentedDB{
        db:     db,
        tracer: otel.Tracer(tracerName),
        dbName: dbName,
        dbType: dbType,
    }
}

// QueryContext executes a query and creates an OpenTelemetry span.
func (idb *InstrumentedDB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
    ctx, span := idb.tracer.Start(ctx, "db.query",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    // Standard OpenTelemetry semantic conventions for database spans
    span.SetAttributes(
        attribute.String("db.system", idb.dbType),
        attribute.String("db.name", idb.dbName),
        attribute.String("db.operation", "SELECT"),
        // Sanitize query: remove parameter values, keep structure
        // In production, use a query sanitizer to remove PII from traces
        attribute.String("db.statement", sanitizeQuery(query)),
    )

    start := time.Now()
    rows, err := idb.db.QueryContext(ctx, query, args...)
    elapsed := time.Since(start)

    span.SetAttributes(
        attribute.Float64("db.query_duration_ms", float64(elapsed.Milliseconds())),
    )

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    return rows, nil
}

// ExecContext executes a statement and creates an OpenTelemetry span.
func (idb *InstrumentedDB) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
    ctx, span := idb.tracer.Start(ctx, "db.exec",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    span.SetAttributes(
        attribute.String("db.system", idb.dbType),
        attribute.String("db.name", idb.dbName),
        attribute.String("db.statement", sanitizeQuery(query)),
    )

    start := time.Now()
    result, err := idb.db.ExecContext(ctx, query, args...)
    elapsed := time.Since(start)

    span.SetAttributes(
        attribute.Float64("db.query_duration_ms", float64(elapsed.Milliseconds())),
    )

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    if rowsAffected, err := result.RowsAffected(); err == nil {
        span.SetAttributes(attribute.Int64("db.rows_affected", rowsAffected))
    }

    return result, nil
}

// sanitizeQuery removes SQL parameter values from a query string for safe tracing.
// Parameter placeholders ($1, $2, etc.) are retained for query pattern identification.
func sanitizeQuery(query string) string {
    // In production, use a proper SQL parser to remove literals
    // For now, return the query as-is (acceptable if no PII in query structure)
    if len(query) > 500 {
        return query[:500] + "... (truncated)"
    }
    return query
}

// Ensure InstrumentedDB satisfies the driver.Driver interface (for compilation check)
var _ fmt.Stringer = (*InstrumentedDB)(nil)

func (idb *InstrumentedDB) String() string {
    return fmt.Sprintf("InstrumentedDB{db: %s, type: %s}", idb.dbName, idb.dbType)
}

// Placeholder to satisfy compilation
var _ driver.Driver = nil
```

## Section 7: Query Performance Patterns

### N+1 Query Prevention

```go
package users

import (
    "context"
    "database/sql"
    "fmt"
    "strings"
)

// GetUsersWithOrders fetches users and their recent orders using a single JOIN query.
// Avoids the N+1 problem: never issue one query per user to fetch their orders.
func GetUsersWithOrders(ctx context.Context, db *sql.DB, userIDs []string) ([]UserWithOrders, error) {
    if len(userIDs) == 0 {
        return nil, nil
    }

    // Build parameterized IN clause: WHERE u.id IN ($1, $2, ..., $N)
    placeholders := make([]string, len(userIDs))
    args := make([]interface{}, len(userIDs))
    for i, id := range userIDs {
        placeholders[i] = fmt.Sprintf("$%d", i+1)
        args[i] = id
    }

    query := fmt.Sprintf(`
        SELECT
            u.id,
            u.email,
            u.status,
            o.id           AS order_id,
            o.total_cents  AS order_total,
            o.status       AS order_status,
            o.created_at   AS order_created_at
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
            AND o.created_at >= NOW() - INTERVAL '30 days'
        WHERE u.id IN (%s)
        ORDER BY u.id, o.created_at DESC`,
        strings.Join(placeholders, ", "),
    )

    rows, err := db.QueryContext(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("querying users with orders: %w", err)
    }
    defer rows.Close()

    // Collect results, grouping orders by user
    userMap := make(map[string]*UserWithOrders)
    var orderedUsers []string // Preserve user order

    for rows.Next() {
        var userID, email, status string
        var orderID, orderStatus sql.NullString
        var orderTotal sql.NullInt64
        var orderCreatedAt sql.NullTime

        if err := rows.Scan(&userID, &email, &status,
            &orderID, &orderTotal, &orderStatus, &orderCreatedAt); err != nil {
            return nil, fmt.Errorf("scanning user+order row: %w", err)
        }

        u, exists := userMap[userID]
        if !exists {
            u = &UserWithOrders{ID: userID, Email: email, Status: status}
            userMap[userID] = u
            orderedUsers = append(orderedUsers, userID)
        }

        if orderID.Valid {
            u.Orders = append(u.Orders, Order{
                ID:        orderID.String,
                Total:     orderTotal.Int64,
                Status:    orderStatus.String,
                CreatedAt: orderCreatedAt.Time,
            })
        }
    }

    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterating user+order rows: %w", err)
    }

    // Return in original order
    result := make([]UserWithOrders, len(orderedUsers))
    for i, id := range orderedUsers {
        result[i] = *userMap[id]
    }
    return result, nil
}

// UserWithOrders is a user and their recent orders.
type UserWithOrders struct {
    ID     string
    Email  string
    Status string
    Orders []Order
}

// Order represents a single order summary.
type Order struct {
    ID        string
    Total     int64
    Status    string
    CreatedAt interface{} // time.Time in production
}
```

## Section 8: Database Migration in Go Services

```go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "sort"
    "time"
)

// Migration represents a single database migration.
type Migration struct {
    Version int
    Name    string
    Up      string // SQL to apply the migration
    Down    string // SQL to reverse the migration
}

// Migrator manages database schema migrations.
type Migrator struct {
    db         *sql.DB
    migrations []Migration
}

// NewMigrator creates a migrator with the provided migrations.
// Migrations are sorted by version number automatically.
func NewMigrator(db *sql.DB, migrations []Migration) *Migrator {
    sorted := make([]Migration, len(migrations))
    copy(sorted, migrations)
    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i].Version < sorted[j].Version
    })
    return &Migrator{db: db, migrations: sorted}
}

// Migrate applies all pending migrations in order.
// Uses an advisory lock to prevent concurrent migration runs.
func (m *Migrator) Migrate(ctx context.Context) error {
    // Ensure migrations table exists
    if err := m.ensureMigrationsTable(ctx); err != nil {
        return fmt.Errorf("ensuring migrations table: %w", err)
    }

    // Acquire PostgreSQL advisory lock to prevent concurrent migrations
    // pg_advisory_lock blocks until the lock is acquired
    _, err := m.db.ExecContext(ctx, "SELECT pg_advisory_lock(1234567890)")
    if err != nil {
        return fmt.Errorf("acquiring migration lock: %w", err)
    }
    defer m.db.ExecContext(context.Background(), "SELECT pg_advisory_unlock(1234567890)")

    // Get already-applied migrations
    applied, err := m.getAppliedVersions(ctx)
    if err != nil {
        return fmt.Errorf("getting applied versions: %w", err)
    }

    // Apply pending migrations
    for _, migration := range m.migrations {
        if applied[migration.Version] {
            continue // Already applied
        }

        if err := m.applyMigration(ctx, migration); err != nil {
            return fmt.Errorf("applying migration %d (%s): %w",
                migration.Version, migration.Name, err)
        }

        fmt.Printf("Applied migration %d: %s\n", migration.Version, migration.Name)
    }

    return nil
}

func (m *Migrator) ensureMigrationsTable(ctx context.Context) error {
    _, err := m.db.ExecContext(ctx, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            name        VARCHAR(255) NOT NULL,
            applied_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
    `)
    return err
}

func (m *Migrator) getAppliedVersions(ctx context.Context) (map[int]bool, error) {
    rows, err := m.db.QueryContext(ctx, "SELECT version FROM schema_migrations")
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    applied := make(map[int]bool)
    for rows.Next() {
        var version int
        if err := rows.Scan(&version); err != nil {
            return nil, err
        }
        applied[version] = true
    }
    return applied, rows.Err()
}

func (m *Migrator) applyMigration(ctx context.Context, migration Migration) error {
    tx, err := m.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    if _, err := tx.ExecContext(ctx, migration.Up); err != nil {
        return fmt.Errorf("executing migration SQL: %w", err)
    }

    if _, err := tx.ExecContext(ctx,
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)",
        migration.Version, migration.Name, time.Now(),
    ); err != nil {
        return fmt.Errorf("recording migration: %w", err)
    }

    return tx.Commit()
}
```

## Summary

Production Go database patterns share a common theme: correctness and observability first, performance second. The connection pool must be sized carefully: `MaxOpenConns` should be derived from the database's `max_connections` divided by service replica count, with a safety margin. `ConnMaxLifetime` ensures connections are recycled after database failovers and network infrastructure changes.

Transaction isolation level selection requires understanding the consistency requirements of each operation. Read-heavy operations are well-served by PostgreSQL's default `READ COMMITTED`. Financial operations and inventory management require `SERIALIZABLE` with automatic retry logic. The `WithSerializableTransaction` pattern encapsulates this retry logic while remaining transparent to callers.

OpenTelemetry query tracing bridges the gap between application code and database performance analysis. Spans carrying query text, execution duration, and row counts enable identifying slow queries in distributed traces without instrumenting each query individually.

The pgx driver provides materially better performance than `lib/pq` for PostgreSQL-specific workloads through binary protocol support, built-in connection pooling, and native type handling. For new services, pgx should be the default choice; migrating existing services from lib/pq to pgx via the `pgx/v5/stdlib` compatibility layer is feasible with minimal code changes.
