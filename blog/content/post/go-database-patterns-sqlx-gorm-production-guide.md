---
title: "Go Database Patterns: sqlx, GORM, and Connection Pool Optimization"
date: 2027-07-22T00:00:00-05:00
draft: false
tags: ["Go", "Database", "PostgreSQL", "GORM", "Performance"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go database access patterns covering sqlx vs GORM trade-offs, connection pool tuning, pgx direct usage, transaction patterns, bulk upserts, migration strategies, and read replica routing."
more_link: "yes"
url: "/go-database-patterns-sqlx-gorm-production-guide/"
---

Database access patterns have an outsized influence on the reliability and performance of Go services. The wrong library choice, poorly tuned connection pool, or absent timeout context can silently degrade throughput or cause cascading failures under load. This guide examines the full spectrum of Go database tooling from raw `database/sql` to GORM, provides concrete connection pool calculations, and covers the operational patterns that keep database-backed services stable in production.

<!--more-->

# [Go Database Patterns](#go-database-patterns)

## Section 1: The database/sql Foundation

Every Go database library sits on top of `database/sql`. Understanding it prevents surprises when higher-level abstractions behave unexpectedly.

### Core Concepts

- **DB**: The connection pool. It is safe for concurrent use. Create one per DSN and share it.
- **Tx**: A transaction. It borrows exactly one connection from the pool for its lifetime.
- **Stmt**: A prepared statement. It may hold prepared handles on multiple connections in the pool.
- **Rows**: An open result set. It holds a connection until `Close` or full iteration.

The most common production bug is failing to close `Rows`, which leaks pool connections:

```go
rows, err := db.QueryContext(ctx, "SELECT id, name FROM items WHERE active = true")
if err != nil {
    return err
}
defer rows.Close() // MUST always be deferred; never omit.

for rows.Next() {
    var id, name string
    if err := rows.Scan(&id, &name); err != nil {
        return err
    }
    // process
}
// Check for iteration errors — rows.Next() swallows errors until here.
return rows.Err()
```

## Section 2: sqlx — Pragmatic Enhancement

`sqlx` extends `database/sql` with struct scanning, named queries, and `IN` clause helpers without introducing a full ORM abstraction.

### Installation

```bash
go get github.com/jmoiron/sqlx
go get github.com/lib/pq       # PostgreSQL driver
# Or use pgx in stdlib mode:
go get github.com/jackc/pgx/v5/stdlib
```

### Struct Mapping

```go
package store

import (
    "context"
    "time"

    "github.com/jmoiron/sqlx"
)

// Item mirrors the database schema with db struct tags.
type Item struct {
    ID        string    `db:"id"`
    SKU       string    `db:"sku"`
    Name      string    `db:"name"`
    Quantity  int64     `db:"quantity"`
    Location  string    `db:"location"`
    CreatedAt time.Time `db:"created_at"`
    UpdatedAt time.Time `db:"updated_at"`
}

type ItemStore struct {
    db *sqlx.DB
}

func NewItemStore(db *sqlx.DB) *ItemStore {
    return &ItemStore{db: db}
}

// GetByID retrieves a single item. Returns sql.ErrNoRows if absent.
func (s *ItemStore) GetByID(ctx context.Context, id string) (*Item, error) {
    var item Item
    err := s.db.GetContext(ctx, &item,
        "SELECT id, sku, name, quantity, location, created_at, updated_at FROM items WHERE id = $1",
        id,
    )
    if err != nil {
        return nil, err
    }
    return &item, nil
}

// ListByLocation retrieves all items at a warehouse location.
func (s *ItemStore) ListByLocation(ctx context.Context, location string) ([]Item, error) {
    var items []Item
    err := s.db.SelectContext(ctx, &items,
        "SELECT id, sku, name, quantity, location, created_at, updated_at FROM items WHERE location = $1 ORDER BY sku",
        location,
    )
    return items, err
}
```

### Named Queries

Named queries use `:field` placeholders bound to struct fields or map keys — they are especially readable for INSERT/UPDATE statements:

```go
const upsertQuery = `
INSERT INTO items (id, sku, name, quantity, location, updated_at)
VALUES (:id, :sku, :name, :quantity, :location, NOW())
ON CONFLICT (id) DO UPDATE SET
    sku       = EXCLUDED.sku,
    name      = EXCLUDED.name,
    quantity  = EXCLUDED.quantity,
    location  = EXCLUDED.location,
    updated_at = NOW()
`

func (s *ItemStore) Upsert(ctx context.Context, item *Item) error {
    _, err := s.db.NamedExecContext(ctx, upsertQuery, item)
    return err
}
```

### IN Clause Expansion

`sqlx.In` expands a variadic argument into positional placeholders:

```go
func (s *ItemStore) GetManyByID(ctx context.Context, ids []string) ([]Item, error) {
    if len(ids) == 0 {
        return nil, nil
    }
    query, args, err := sqlx.In(
        "SELECT id, sku, name, quantity FROM items WHERE id IN (?)",
        ids,
    )
    if err != nil {
        return nil, err
    }
    // Rebind converts ? placeholders to $1, $2... for PostgreSQL.
    query = s.db.Rebind(query)

    var items []Item
    return items, s.db.SelectContext(ctx, &items, query, args...)
}
```

## Section 3: GORM — Full ORM Trade-offs

GORM provides auto-migration, associations, hooks, and a fluent query builder. The trade-off is magic that can surprise in production.

### When to Choose GORM

- Rapid prototyping where schema and code evolve together.
- CRUD-heavy services with simple query patterns.
- Teams that prefer convention over hand-written SQL.

### When to Avoid GORM

- Complex queries requiring window functions, CTEs, or lateral joins.
- Performance-critical hot paths where query predictability matters.
- Services that need fine-grained control over query plans.

### Basic GORM Usage

```go
package store

import (
    "context"
    "time"

    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/gorm/logger"
)

type Item struct {
    ID        string    `gorm:"primaryKey"`
    SKU       string    `gorm:"uniqueIndex;not null"`
    Name      string    `gorm:"not null"`
    Quantity  int64
    Location  string    `gorm:"index"`
    CreatedAt time.Time
    UpdatedAt time.Time
}

func NewGORMDB(dsn string) (*gorm.DB, error) {
    return gorm.Open(postgres.Open(dsn), &gorm.Config{
        Logger: logger.Default.LogMode(logger.Warn),
        // Disable automatic creation of created_at/updated_at unless you want GORM to manage them.
        NowFunc: func() time.Time { return time.Now().UTC() },
    })
}

type GORMItemStore struct {
    db *gorm.DB
}

func (s *GORMItemStore) GetByID(ctx context.Context, id string) (*Item, error) {
    var item Item
    result := s.db.WithContext(ctx).First(&item, "id = ?", id)
    if result.Error != nil {
        return nil, result.Error
    }
    return &item, nil
}

func (s *GORMItemStore) ListByLocation(ctx context.Context, location string) ([]Item, error) {
    var items []Item
    result := s.db.WithContext(ctx).
        Where("location = ?", location).
        Order("sku ASC").
        Find(&items)
    return items, result.Error
}

func (s *GORMItemStore) Upsert(ctx context.Context, item *Item) error {
    return s.db.WithContext(ctx).Save(item).Error
}
```

### Accessing the Underlying sql.DB from GORM

GORM wraps `database/sql`, so connection pool settings must be applied through the underlying `*sql.DB`:

```go
sqlDB, err := db.DB()
if err != nil {
    return err
}
sqlDB.SetMaxOpenConns(25)
sqlDB.SetMaxIdleConns(10)
sqlDB.SetConnMaxLifetime(5 * time.Minute)
```

## Section 4: Connection Pool Tuning

Connection pool misconfiguration is the root cause of most database-related production incidents in Go services.

### The Four Settings

```go
db.SetMaxOpenConns(n)   // maximum concurrent connections to the database
db.SetMaxIdleConns(m)   // connections kept open when idle
db.SetConnMaxLifetime(d) // maximum age of any connection before forced close
db.SetConnMaxIdleTime(t) // close idle connections older than this
```

### Calculating MaxOpenConns

The right value is the minimum of:

1. What the database can sustain: `db_max_connections / number_of_service_instances`
2. What the service needs: `expected_concurrent_queries * 1.25` (25% headroom)

For a PostgreSQL instance with `max_connections = 200` and 4 service replicas:

```
per_instance_max = 200 / 4 = 50
```

If each request makes at most 3 concurrent queries and the service handles 100 RPS:

```
peak_queries = 100 * 3 * avg_query_duration_s
             = 100 * 3 * 0.010  (10ms avg)
             = 3 connections needed at steady state
```

Set `MaxOpenConns = 10` to `20` — well within the per-instance budget.

### Production Pool Configuration

```go
func ConfigurePool(db *sql.DB, cfg PoolConfig) {
    // Never allow unlimited connections.
    if cfg.MaxOpen <= 0 {
        cfg.MaxOpen = 25
    }
    // Idle pool should be at most half of max open.
    if cfg.MaxIdle <= 0 || cfg.MaxIdle > cfg.MaxOpen/2 {
        cfg.MaxIdle = cfg.MaxOpen / 2
    }
    // Recycle connections to avoid hitting server-side timeouts.
    if cfg.MaxLifetime == 0 {
        cfg.MaxLifetime = 5 * time.Minute
    }
    // Close connections that have been idle for more than 1 minute.
    if cfg.MaxIdleTime == 0 {
        cfg.MaxIdleTime = time.Minute
    }

    db.SetMaxOpenConns(cfg.MaxOpen)
    db.SetMaxIdleConns(cfg.MaxIdle)
    db.SetConnMaxLifetime(cfg.MaxLifetime)
    db.SetConnMaxIdleTime(cfg.MaxIdleTime)
}
```

### Monitoring Pool Health

Expose `db.Stats()` as Prometheus metrics:

```go
package dbmetrics

import (
    "database/sql"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

func Register(db *sql.DB, name string) {
    promauto.NewGaugeFunc(prometheus.GaugeOpts{
        Name:        "db_pool_open_connections",
        Help:        "Number of open connections to the database.",
        ConstLabels: prometheus.Labels{"db": name},
    }, func() float64 { return float64(db.Stats().OpenConnections) })

    promauto.NewGaugeFunc(prometheus.GaugeOpts{
        Name:        "db_pool_in_use_connections",
        Help:        "Number of connections currently in use.",
        ConstLabels: prometheus.Labels{"db": name},
    }, func() float64 { return float64(db.Stats().InUse) })

    promauto.NewGaugeFunc(prometheus.GaugeOpts{
        Name:        "db_pool_idle_connections",
        Help:        "Number of idle connections in the pool.",
        ConstLabels: prometheus.Labels{"db": name},
    }, func() float64 { return float64(db.Stats().Idle) })

    promauto.NewCounterFunc(prometheus.CounterOpts{
        Name:        "db_pool_wait_total",
        Help:        "Total number of times a goroutine waited for a connection.",
        ConstLabels: prometheus.Labels{"db": name},
    }, func() float64 { return float64(db.Stats().WaitCount) })

    promauto.NewCounterFunc(prometheus.CounterOpts{
        Name:        "db_pool_wait_duration_seconds_total",
        Help:        "Total time goroutines have spent waiting for a connection.",
        ConstLabels: prometheus.Labels{"db": name},
    }, func() float64 { return db.Stats().WaitDuration.Seconds() })
}
```

Alert on `db_pool_in_use_connections / db_pool_max_open_connections > 0.8` — a pool utilization above 80% indicates pending contention.

## Section 5: Transaction Patterns

### Generic Transaction Helper

```go
// WithTx executes fn within a transaction, rolling back on error.
func WithTx(ctx context.Context, db *sqlx.DB, fn func(tx *sqlx.Tx) error) error {
    tx, err := db.BeginTxx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }

    if err := fn(tx); err != nil {
        if rbErr := tx.Rollback(); rbErr != nil {
            return fmt.Errorf("rollback error: %v (original: %w)", rbErr, err)
        }
        return err
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit tx: %w", err)
    }
    return nil
}
```

Usage:

```go
err := WithTx(ctx, db, func(tx *sqlx.Tx) error {
    if _, err := tx.ExecContext(ctx,
        "UPDATE items SET quantity = quantity - $1 WHERE id = $2",
        delta, itemID,
    ); err != nil {
        return fmt.Errorf("decrement quantity: %w", err)
    }

    if _, err := tx.ExecContext(ctx,
        "INSERT INTO inventory_events (item_id, delta, reason) VALUES ($1, $2, $3)",
        itemID, -delta, "order_fulfillment",
    ); err != nil {
        return fmt.Errorf("insert event: %w", err)
    }
    return nil
})
```

### Serializable Transactions

For financial or inventory operations where phantom reads are intolerable:

```go
tx, err := db.BeginTxx(ctx, &sql.TxOptions{
    Isolation: sql.LevelSerializable,
})
```

Serializable transactions may fail with `40001 serialization_failure`. Retry with exponential backoff:

```go
func withSerializableTx(ctx context.Context, db *sqlx.DB, fn func(*sqlx.Tx) error) error {
    var err error
    for attempt := 0; attempt < 5; attempt++ {
        err = doTx(ctx, db, sql.LevelSerializable, fn)
        if err == nil {
            return nil
        }
        var pgErr *pgconn.PgError
        if errors.As(err, &pgErr) && pgErr.Code == "40001" {
            // Serialization failure — retry after backoff.
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(time.Duration(attempt*attempt) * 5 * time.Millisecond):
                continue
            }
        }
        return err // non-retryable error
    }
    return err
}
```

## Section 6: Using pgx Directly

For maximum performance and access to PostgreSQL-specific features (COPY, notify/listen, large objects), use `pgx/v5` directly rather than through `database/sql`.

### pgx Pool Setup

```go
package pgxstore

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5/pgxpool"
)

func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
    cfg, err := pgxpool.ParseConfig(dsn)
    if err != nil {
        return nil, fmt.Errorf("parse dsn: %w", err)
    }

    cfg.MaxConns = 25
    cfg.MinConns = 2
    cfg.MaxConnLifetime = 5 * time.Minute
    cfg.MaxConnIdleTime = time.Minute
    cfg.HealthCheckPeriod = 30 * time.Second

    // Prepare statements on acquisition to avoid per-query round trips.
    cfg.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        return conn.Ping(ctx) == nil
    }

    pool, err := pgxpool.NewWithConfig(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("create pool: %w", err)
    }

    if err := pool.Ping(ctx); err != nil {
        return nil, fmt.Errorf("ping database: %w", err)
    }
    return pool, nil
}
```

### Bulk COPY INSERT

The PostgreSQL COPY protocol is orders of magnitude faster than batched INSERTs for large data loads:

```go
func (s *PgxItemStore) BulkInsert(ctx context.Context, items []Item) error {
    rows := make([][]any, len(items))
    for i, item := range items {
        rows[i] = []any{item.ID, item.SKU, item.Name, item.Quantity, item.Location}
    }

    copyCount, err := s.pool.CopyFrom(
        ctx,
        pgx.Identifier{"items"},
        []string{"id", "sku", "name", "quantity", "location"},
        pgx.CopyFromRows(rows),
    )
    if err != nil {
        return fmt.Errorf("copy from: %w", err)
    }
    if int(copyCount) != len(items) {
        return fmt.Errorf("expected %d rows inserted, got %d", len(items), copyCount)
    }
    return nil
}
```

### Batch Queries

pgx batches multiple queries into a single network round trip:

```go
func (s *PgxItemStore) GetManyByID(ctx context.Context, ids []string) ([]Item, error) {
    batch := &pgx.Batch{}
    for _, id := range ids {
        batch.Queue("SELECT id, sku, name, quantity FROM items WHERE id = $1", id)
    }

    results := s.pool.SendBatch(ctx, batch)
    defer results.Close()

    items := make([]Item, 0, len(ids))
    for range ids {
        var item Item
        if err := results.QueryRow().Scan(&item.ID, &item.SKU, &item.Name, &item.Quantity); err != nil {
            if errors.Is(err, pgx.ErrNoRows) {
                continue
            }
            return nil, err
        }
        items = append(items, item)
    }
    return items, results.Close()
}
```

## Section 7: Query Timeout Context

Every database call in production must carry a deadline. An absent timeout allows a slow query to hold a pool connection indefinitely.

```go
const defaultQueryTimeout = 5 * time.Second

func (s *ItemStore) GetByID(ctx context.Context, id string) (*Item, error) {
    ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
    defer cancel()

    var item Item
    err := s.db.GetContext(ctx, &item,
        "SELECT id, sku, name, quantity, location, created_at, updated_at FROM items WHERE id = $1",
        id,
    )
    if errors.Is(err, context.DeadlineExceeded) {
        return nil, fmt.Errorf("query timeout after %s: %w", defaultQueryTimeout, err)
    }
    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrNotFound
    }
    return &item, err
}

// ErrNotFound is a sentinel for missing rows, distinct from database errors.
var ErrNotFound = errors.New("item not found")
```

## Section 8: Migration Strategies

### golang-migrate

```bash
go get -tool github.com/golang-migrate/migrate/v4/cmd/migrate
```

Migration file naming convention: `{version}_{description}.{up|down}.sql`

```
migrations/
  000001_create_items.up.sql
  000001_create_items.down.sql
  000002_add_location_index.up.sql
  000002_add_location_index.down.sql
```

```sql
-- 000001_create_items.up.sql
CREATE TABLE items (
    id          TEXT PRIMARY KEY,
    sku         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    quantity    BIGINT NOT NULL DEFAULT 0,
    location    TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_items_location ON items (location);
```

Programmatic migration at startup:

```go
import (
    "github.com/golang-migrate/migrate/v4"
    _ "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
)

func RunMigrations(dsn, migrationsPath string) error {
    m, err := migrate.New("file://"+migrationsPath, dsn)
    if err != nil {
        return fmt.Errorf("create migrator: %w", err)
    }
    defer m.Close()

    if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
        return fmt.Errorf("run migrations: %w", err)
    }
    return nil
}
```

### Zero-Downtime Schema Changes

Follow the expand-contract pattern for columns:

1. **Expand**: Add the new column as nullable, deploy.
2. **Migrate**: Backfill existing rows in batches.
3. **Contract**: Add NOT NULL constraint, remove old column, deploy.

```sql
-- Step 1: Add nullable column (safe to deploy while old code runs).
ALTER TABLE items ADD COLUMN warehouse_zone TEXT;

-- Step 2 (next release): Backfill in batches to avoid table locks.
DO $$
DECLARE
    batch_size INT := 1000;
    offset_val INT := 0;
BEGIN
    LOOP
        UPDATE items
        SET warehouse_zone = SPLIT_PART(location, '-', 1)
        WHERE id IN (
            SELECT id FROM items
            WHERE warehouse_zone IS NULL
            ORDER BY id
            LIMIT batch_size
        );
        EXIT WHEN NOT FOUND;
        PERFORM pg_sleep(0.01);
    END LOOP;
END $$;

-- Step 3 (following release): Make it NOT NULL after backfill confirmed.
ALTER TABLE items ALTER COLUMN warehouse_zone SET NOT NULL;
```

## Section 9: Read Replica Routing

Separate read-heavy queries to read replicas to reduce load on the primary.

```go
package store

import (
    "context"

    "github.com/jmoiron/sqlx"
)

// DB wraps primary and replica connections.
type DB struct {
    primary  *sqlx.DB
    replicas []*sqlx.DB
    rr       uint64 // round-robin counter
}

func NewDB(primary *sqlx.DB, replicas ...*sqlx.DB) *DB {
    return &DB{
        primary:  primary,
        replicas: replicas,
    }
}

// Primary returns the primary connection for writes.
func (d *DB) Primary() *sqlx.DB { return d.primary }

// Replica returns a replica using round-robin selection.
// Falls back to primary if no replicas are configured.
func (d *DB) Replica() *sqlx.DB {
    if len(d.replicas) == 0 {
        return d.primary
    }
    idx := atomic.AddUint64(&d.rr, 1) % uint64(len(d.replicas))
    return d.replicas[idx]
}

// ItemStore uses the right connection based on operation type.
type ItemStore struct {
    db *DB
}

func (s *ItemStore) GetByID(ctx context.Context, id string) (*Item, error) {
    var item Item
    // Read — use replica.
    err := s.db.Replica().GetContext(ctx, &item,
        "SELECT id, sku, name, quantity, location FROM items WHERE id = $1", id,
    )
    return &item, err
}

func (s *ItemStore) Upsert(ctx context.Context, item *Item) error {
    // Write — use primary.
    _, err := s.db.Primary().NamedExecContext(ctx, upsertQuery, item)
    return err
}
```

### Kubernetes ConfigMap for Connection Strings

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: inventory-db-config
data:
  primary_dsn: "postgres://inventory_user@postgres-primary.db:5432/inventory?sslmode=require"
  replica_dsn: "postgres://inventory_user@postgres-replica.db:5432/inventory?sslmode=require"
```

```yaml
env:
  - name: DB_PRIMARY_DSN
    valueFrom:
      secretKeyRef:
        name: inventory-db-credentials
        key: primary_dsn
  - name: DB_REPLICA_DSN
    valueFrom:
      secretKeyRef:
        name: inventory-db-credentials
        key: replica_dsn
```

## Section 10: Prepared Statements

Prepared statements reduce per-query parsing overhead on PostgreSQL but require care in a connection pool:

- A statement prepared on one connection is not automatically available on another.
- `sqlx` and `database/sql` handle re-preparation transparently across connections, but this adds one round trip on first use per connection.

```go
// Prepare high-frequency queries at startup.
type Statements struct {
    getItem    *sqlx.Stmt
    updateQty  *sqlx.Stmt
}

func PrepareStatements(ctx context.Context, db *sqlx.DB) (*Statements, error) {
    s := &Statements{}
    var err error

    s.getItem, err = db.PreparexContext(ctx,
        "SELECT id, sku, name, quantity, location FROM items WHERE id = $1",
    )
    if err != nil {
        return nil, fmt.Errorf("prepare getItem: %w", err)
    }

    s.updateQty, err = db.PreparexContext(ctx,
        "UPDATE items SET quantity = $1, updated_at = NOW() WHERE id = $2",
    )
    if err != nil {
        return nil, fmt.Errorf("prepare updateQty: %w", err)
    }

    return s, nil
}

func (s *Statements) Close() {
    s.getItem.Close()
    s.updateQty.Close()
}
```

## Section 11: sqlx vs GORM — Decision Matrix

| Criterion | sqlx | GORM |
|---|---|---|
| Query transparency | Full — you write SQL | Limited — generated SQL |
| Complex queries | Natural | Requires Raw() escape hatch |
| Learning curve | Low (SQL knowledge) | Medium (GORM conventions) |
| Auto-migration | No | Yes |
| Associations | Manual JOIN | Built-in |
| Performance | Near-raw | 10-30% overhead |
| Code generation | Optional | Built-in |
| Schema evolution | Explicit migrations | AutoMigrate (dev only) |

**Recommendation**: Use `sqlx` for services where query correctness and performance are paramount. Use GORM for internal tooling, admin services, and prototypes. Never use `gorm.AutoMigrate` in production.

## Section 12: Testing Database Code

### Integration Tests with testcontainers

```go
package store_test

import (
    "context"
    "testing"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
)

func TestMain(m *testing.M) {
    ctx := context.Background()

    pg, err := postgres.Run(ctx,
        "postgres:16-alpine",
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").WithOccurrence(2),
        ),
    )
    if err != nil {
        log.Fatalf("start postgres container: %v", err)
    }
    defer pg.Terminate(ctx)

    dsn, _ := pg.ConnectionString(ctx, "sslmode=disable")
    testDB = setupTestDB(dsn)

    os.Exit(m.Run())
}

func TestItemStore_UpsertAndGet(t *testing.T) {
    store := NewItemStore(testDB)
    ctx := context.Background()

    item := &Item{ID: "test-1", SKU: "SKU-100", Name: "Test Widget", Quantity: 50}
    if err := store.Upsert(ctx, item); err != nil {
        t.Fatalf("Upsert: %v", err)
    }

    got, err := store.GetByID(ctx, "test-1")
    if err != nil {
        t.Fatalf("GetByID: %v", err)
    }
    if got.Quantity != 50 {
        t.Errorf("expected quantity 50, got %d", got.Quantity)
    }
}
```

## Section 13: Summary

Reliable Go database access requires deliberate choices at every layer:

- **sql vs sqlx vs GORM**: prefer sqlx for production services needing SQL transparency; use GORM for rapid iteration on internal tools.
- **Named queries**: make INSERT/UPDATE statements self-documenting and resistant to column-order bugs.
- **Connection pool**: calculate `MaxOpenConns` from database capacity and service replica count; always set `MaxIdleConns` and `ConnMaxLifetime`.
- **Monitoring**: expose `db.Stats()` metrics; alert when pool utilization exceeds 80%.
- **Timeouts**: every query call site must carry a `context.WithTimeout`.
- **pgx**: use the native driver for COPY bulk loads and batch queries on hot paths.
- **Migrations**: golang-migrate for version-controlled changes; follow expand-contract for zero-downtime column changes.
- **Replicas**: route reads to replicas using a lightweight round-robin wrapper.
- **Testing**: testcontainers provides real PostgreSQL for integration tests without a persistent test database dependency.

These patterns, applied consistently, produce database-backed services that remain stable under load and degrade gracefully when the database is under pressure.
