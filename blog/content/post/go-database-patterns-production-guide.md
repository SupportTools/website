---
title: "Go Database Patterns: Connection Pooling, Migrations, and Query Building"
date: 2027-10-18T00:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "Database", "sqlc", "pgx"]
categories:
- Go
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "Production database patterns in Go covering pgx vs database/sql, connection pool tuning, sqlc for type-safe queries, golang-migrate, transaction patterns, testcontainers-go, and circuit breaker patterns."
more_link: "yes"
url: "/go-database-patterns-production-guide/"
---

Production Go services live or die by their database layer. A misconfigured connection pool causes cascading timeouts under load. Handwritten SQL drifts from the schema. Migrations run in the wrong order and corrupt data. This guide documents the patterns that hold up when the query count reaches millions per minute.

<!--more-->

# Go Database Patterns: Connection Pooling, Migrations, and Query Building

## Section 1: pgx vs database/sql

The two dominant approaches for PostgreSQL in Go are the standard `database/sql` package with a pgx driver, and pgx's native interface directly. The choice matters for performance and capability.

### database/sql + pgx Driver

```go
// Using pgx as a database/sql driver
package main

import (
	"database/sql"
	"fmt"
	"log"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	db, err := sql.Open("pgx", "postgres://app:secret@localhost:5432/myapp?sslmode=require")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	// database/sql manages its own pool via these settings.
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(1 * time.Minute)

	var greeting string
	err = db.QueryRow("SELECT 'Hello, database/sql'").Scan(&greeting)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(greeting)
}
```

The `database/sql` approach works well when:
- The codebase targets multiple database backends.
- Existing tooling assumes the standard interface.
- Libraries like `sqlx` or `scany` are used for struct scanning.

### pgx Native Pool

```go
// Using pgxpool for direct PostgreSQL access
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config holds all pool tuning parameters.
type Config struct {
	DSN             string
	MaxConns        int32
	MinConns        int32
	MaxConnLifetime time.Duration
	MaxConnIdleTime time.Duration
	HealthCheckPeriod time.Duration
}

// DefaultConfig returns production-appropriate defaults.
func DefaultConfig(dsn string) Config {
	return Config{
		DSN:               dsn,
		MaxConns:          25,
		MinConns:          5,
		MaxConnLifetime:   30 * time.Minute,
		MaxConnIdleTime:   5 * time.Minute,
		HealthCheckPeriod: 1 * time.Minute,
	}
}

// NewPool creates and validates a pgxpool with the given config.
func NewPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}

	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns
	poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
	poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
	poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

	// BeforeAcquire fires before a connection is handed to the caller.
	poolCfg.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
		// Reject connections with any pending async notifications
		// that would confuse the caller.
		return conn.PgConn().IsBusy() == false
	}

	// AfterRelease fires after a connection is returned to the pool.
	poolCfg.AfterRelease = func(conn *pgx.Conn) bool {
		// Discard connections with error state.
		return conn.PgConn().TxStatus() == 'I'
	}

	// Register custom type codecs for domain types.
	poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		// Register pgvector, HSTORE, or other custom types here.
		return nil
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	// Eagerly verify connectivity.
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return pool, nil
}
```

### Pool Tuning Reference

```go
// pool_sizing.go — calculate recommended pool size
package db

import "runtime"

// RecommendedMaxConns returns a sensible upper bound for the pool.
// Formula: (number of CPU cores * 2) + number of spinning disks.
// For a 4-core machine with SSD storage: (4 * 2) + 1 = 9.
// PostgreSQL's own recommendation: keep total server connections < (2 * server cores).
func RecommendedMaxConns() int32 {
	cores := runtime.NumCPU()
	// Assume SSD, no spinning disk penalty.
	return int32(cores*2 + 1)
}
```

---

## Section 2: sqlc — Type-Safe Query Generation

`sqlc` compiles annotated SQL into type-safe Go code. The SQL is validated against the schema at generation time, so type mismatches surface before the binary is built.

### Schema and Query Files

```sql
-- schema.sql
CREATE TABLE users (
    id         BIGSERIAL    PRIMARY KEY,
    email      TEXT         NOT NULL UNIQUE,
    name       TEXT         NOT NULL,
    role       TEXT         NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_role  ON users (role)  WHERE deleted_at IS NULL;
```

```sql
-- queries/users.sql
-- name: GetUser :one
SELECT id, email, name, role, created_at, updated_at
FROM   users
WHERE  id = $1 AND deleted_at IS NULL;

-- name: ListUsersByRole :many
SELECT id, email, name, role, created_at, updated_at
FROM   users
WHERE  role = $1 AND deleted_at IS NULL
ORDER  BY created_at DESC
LIMIT  $2 OFFSET $3;

-- name: CreateUser :one
INSERT INTO users (email, name, role)
VALUES ($1, $2, $3)
RETURNING id, email, name, role, created_at, updated_at;

-- name: UpdateUserRole :one
UPDATE users
SET    role = $2, updated_at = NOW()
WHERE  id = $1 AND deleted_at IS NULL
RETURNING id, email, name, role, created_at, updated_at;

-- name: SoftDeleteUser :exec
UPDATE users
SET    deleted_at = NOW()
WHERE  id = $1 AND deleted_at IS NULL;
```

### sqlc Configuration

```yaml
# sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "./queries"
    schema:  "./migrations"
    gen:
      go:
        package:            "dbstore"
        out:                "./internal/dbstore"
        emit_json_tags:     true
        emit_pointers_for_null_types: true
        emit_methods_with_db_argument: false
        overrides:
          - db_type: "pg_catalog.timestamptz"
            go_type: "time.Time"
```

Generate code:

```bash
sqlc generate
```

The generated code provides:

```go
// Usage of generated sqlc code — internal/dbstore/users.sql.go (auto-generated)
// Callers use the Queries struct directly.

package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"myapp/internal/dbstore"
)

type UserService struct {
	q *dbstore.Queries
}

func NewUserService(pool *pgxpool.Pool) *UserService {
	return &UserService{q: dbstore.New(pool)}
}

func (s *UserService) GetByID(ctx context.Context, id int64) (*dbstore.User, error) {
	user, err := s.q.GetUser(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("get user %d: %w", err, id)
	}
	return &user, nil
}

func (s *UserService) Create(ctx context.Context, email, name, role string) (*dbstore.User, error) {
	user, err := s.q.CreateUser(ctx, dbstore.CreateUserParams{
		Email: email,
		Name:  name,
		Role:  role,
	})
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return &user, nil
}
```

---

## Section 3: golang-migrate for Schema Migrations

`golang-migrate` manages database schema versions with up/down migration files.

### Migration File Structure

```
migrations/
  000001_create_users.up.sql
  000001_create_users.down.sql
  000002_add_user_preferences.up.sql
  000002_add_user_preferences.down.sql
  000003_create_audit_log.up.sql
  000003_create_audit_log.down.sql
```

```sql
-- migrations/000001_create_users.up.sql
CREATE TABLE users (
    id         BIGSERIAL    PRIMARY KEY,
    email      TEXT         NOT NULL UNIQUE,
    name       TEXT         NOT NULL,
    role       TEXT         NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
```

```sql
-- migrations/000001_create_users.down.sql
DROP TABLE IF EXISTS users;
```

```sql
-- migrations/000002_add_user_preferences.up.sql
CREATE TABLE user_preferences (
    user_id    BIGINT       PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings   JSONB        NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

```sql
-- migrations/000002_add_user_preferences.down.sql
DROP TABLE IF EXISTS user_preferences;
```

### Running Migrations in Code

```go
// migrate/runner.go
package migrate

import (
	"errors"
	"fmt"
	"log/slog"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	_ "github.com/golang-migrate/migrate/v4/source/iofs"
	"io/fs"
)

// Run applies all pending up migrations from the given directory.
func Run(dsn, migrationsPath string) error {
	m, err := migrate.New(
		fmt.Sprintf("file://%s", migrationsPath),
		dsn,
	)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil {
			slog.Error("close migration source", "err", srcErr)
		}
		if dbErr != nil {
			slog.Error("close migration db", "err", dbErr)
		}
	}()

	if err := m.Up(); err != nil {
		if errors.Is(err, migrate.ErrNoChange) {
			slog.Info("database schema is up to date")
			return nil
		}
		return fmt.Errorf("migrate up: %w", err)
	}

	v, dirty, _ := m.Version()
	slog.Info("migrations applied", "version", v, "dirty", dirty)
	return nil
}

// RunWithEmbedFS uses an embedded filesystem for migrations (single binary deployment).
func RunWithEmbedFS(dsn string, fsys fs.FS, root string) error {
	source, err := iofs.New(fsys, root)
	if err != nil {
		return fmt.Errorf("create iofs source: %w", err)
	}

	m, err := migrate.NewWithSourceInstance("iofs", source, dsn)
	if err != nil {
		return fmt.Errorf("create migrator with embed: %w", err)
	}
	defer func() {
		m.Close()
	}()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}
```

### Migration Lock Handling in Kubernetes

In a multi-replica Kubernetes deployment, multiple pods start simultaneously and all attempt migrations:

```go
// migrate/leader.go
package migrate

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// WithAdvisoryLock runs fn while holding a PostgreSQL advisory lock.
// This ensures only one replica runs migrations at startup.
func WithAdvisoryLock(ctx context.Context, pool *pgxpool.Pool, fn func() error) error {
	const lockKey = 8765432109876 // arbitrary stable int64

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn: %w", err)
	}
	defer conn.Release()

	// pg_try_advisory_lock returns false immediately if lock is taken.
	// pg_advisory_lock blocks until acquired.
	var locked bool
	err = conn.QueryRow(ctx,
		"SELECT pg_try_advisory_lock($1)", lockKey,
	).Scan(&locked)
	if err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	if !locked {
		// Another replica holds the lock; wait for it to finish.
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
			err = conn.QueryRow(ctx,
				"SELECT pg_try_advisory_lock($1)", lockKey,
			).Scan(&locked)
			if err != nil {
				return err
			}
			if locked {
				break
			}
		}
	}

	defer conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", lockKey)
	return fn()
}
```

---

## Section 4: Transaction Patterns with Context Propagation

### The Repository Transaction Pattern

```go
// store/store.go
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"myapp/internal/dbstore"
)

type Store struct {
	pool *pgxpool.Pool
	q    *dbstore.Queries
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool, q: dbstore.New(pool)}
}

// WithTx executes fn inside a transaction. If fn returns an error,
// the transaction is rolled back. Otherwise it is committed.
func (s *Store) WithTx(ctx context.Context, fn func(q *dbstore.Queries) error) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.ReadCommitted,
		AccessMode: pgx.ReadWrite,
	})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}

	q := s.q.WithTx(tx)
	if err := fn(q); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

// TransferBalance atomically moves amount from one account to another.
func (s *Store) TransferBalance(ctx context.Context, fromID, toID int64, amount int64) error {
	return s.WithTx(ctx, func(q *dbstore.Queries) error {
		if err := q.DebitAccount(ctx, dbstore.DebitAccountParams{
			ID:     fromID,
			Amount: amount,
		}); err != nil {
			return fmt.Errorf("debit account %d: %w", fromID, err)
		}
		if err := q.CreditAccount(ctx, dbstore.CreditAccountParams{
			ID:     toID,
			Amount: amount,
		}); err != nil {
			return fmt.Errorf("credit account %d: %w", toID, err)
		}
		return nil
	})
}
```

### Savepoints for Nested Transactions

```go
// store/savepoint.go
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// NestedTx provides savepoint-based nested transaction support.
type NestedTx struct {
	tx        pgx.Tx
	savepoint string
}

func (t *NestedTx) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := t.tx.Exec(ctx, sql, args...)
	return err
}

func (t *NestedTx) Commit(ctx context.Context) error {
	_, err := t.tx.Exec(ctx, fmt.Sprintf("RELEASE SAVEPOINT %s", t.savepoint))
	return err
}

func (t *NestedTx) Rollback(ctx context.Context) error {
	_, err := t.tx.Exec(ctx, fmt.Sprintf("ROLLBACK TO SAVEPOINT %s", t.savepoint))
	return err
}

// Savepoint creates a savepoint within an existing transaction.
func Savepoint(ctx context.Context, tx pgx.Tx, name string) (*NestedTx, error) {
	if _, err := tx.Exec(ctx, fmt.Sprintf("SAVEPOINT %s", name)); err != nil {
		return nil, fmt.Errorf("create savepoint %s: %w", name, err)
	}
	return &NestedTx{tx: tx, savepoint: name}, nil
}
```

---

## Section 5: Prepared Statement Management

Prepared statements reduce parse/plan overhead for repeated queries. pgx handles them transparently, but explicit management gives finer control:

```go
// store/prepared.go
package store

import (
	"context"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PreparedStatements caches named prepared statements per connection.
// pgxpool.Pool does not cache prepared statements across connections
// by default, so this wrapper handles re-preparation on new connections.
type PreparedStatements struct {
	pool       *pgxpool.Pool
	statements map[string]string
	mu         sync.RWMutex
}

func NewPreparedStatements(pool *pgxpool.Pool) *PreparedStatements {
	return &PreparedStatements{
		pool:       pool,
		statements: make(map[string]string),
	}
}

// Register adds a named statement. The statement is prepared lazily.
func (ps *PreparedStatements) Register(name, sql string) {
	ps.mu.Lock()
	ps.statements[name] = sql
	ps.mu.Unlock()
}

// Query executes a registered prepared statement.
func (ps *PreparedStatements) Query(
	ctx context.Context,
	name string,
	args ...any,
) (pgx.Rows, error) {
	ps.mu.RLock()
	sql, ok := ps.statements[name]
	ps.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("prepared statement %q not registered", name)
	}
	return ps.pool.Query(ctx, sql, args...)
}
```

For high-volume queries, use `pgx.CachedPlan` which automatically re-prepares when PostgreSQL invalidates the plan:

```go
// In the pool AfterConnect callback, set the preferred describe method.
poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
	conn.Config().DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe
	return nil
}
```

---

## Section 6: Read Replica Routing

Distribute read-heavy workloads to read replicas without changing query logic:

```go
// store/replica_router.go
package store

import (
	"context"
	"math/rand"

	"github.com/jackc/pgx/v5/pgxpool"
)

// contextKey is an unexported type for context keys in this package.
type contextKey int

const (
	// keyPreferReplica signals that read replicas are acceptable.
	keyPreferReplica contextKey = iota
)

// PreferReplica returns a context that signals read replica preference.
func PreferReplica(ctx context.Context) context.Context {
	return context.WithValue(ctx, keyPreferReplica, true)
}

// ReplicaRouter wraps a primary and a set of read replicas.
type ReplicaRouter struct {
	primary  *pgxpool.Pool
	replicas []*pgxpool.Pool
}

func NewReplicaRouter(primary *pgxpool.Pool, replicas ...*pgxpool.Pool) *ReplicaRouter {
	return &ReplicaRouter{primary: primary, replicas: replicas}
}

// Pool returns the appropriate pool for the context.
// Callers that called PreferReplica get a random replica (or primary if no replicas).
func (r *ReplicaRouter) Pool(ctx context.Context) *pgxpool.Pool {
	if ctx.Value(keyPreferReplica) != true || len(r.replicas) == 0 {
		return r.primary
	}
	return r.replicas[rand.Intn(len(r.replicas))]
}

// Usage:
//   ctx := store.PreferReplica(ctx)
//   rows, err := router.Pool(ctx).Query(ctx, "SELECT ...")
```

---

## Section 7: Database Testing with testcontainers-go

`testcontainers-go` starts a real PostgreSQL container for integration tests, eliminating mock drift:

```go
// store/store_test.go
package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	"myapp/migrate"
	"myapp/store"
)

func setupTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	pgContainer, err := postgres.Run(ctx,
		"postgres:16-alpine",
		postgres.WithDatabase("testdb"),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(30*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("start postgres container: %v", err)
	}
	t.Cleanup(func() {
		if err := pgContainer.Terminate(ctx); err != nil {
			t.Logf("terminate container: %v", err)
		}
	})

	dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}

	// Run migrations against the test database.
	if err := migrate.Run(dsn, "../../migrations"); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect pool: %v", err)
	}
	t.Cleanup(pool.Close)

	return pool
}

func TestUserStore_CreateAndGet(t *testing.T) {
	pool := setupTestDB(t)
	s := store.New(pool)
	ctx := context.Background()

	created, err := s.CreateUser(ctx, "alice@example.com", "Alice", "admin")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if created.Email != "alice@example.com" {
		t.Errorf("email = %q, want %q", created.Email, "alice@example.com")
	}

	got, err := s.GetUser(ctx, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}

	if got.ID != created.ID {
		t.Errorf("id = %d, want %d", got.ID, created.ID)
	}
}

func TestUserStore_TransactionRollback(t *testing.T) {
	pool := setupTestDB(t)
	s := store.New(pool)
	ctx := context.Background()

	err := s.WithTx(ctx, func(q interface{ CreateUser(...) error }) error {
		return fmt.Errorf("intentional failure")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	// Verify no partial writes persisted.
	count, err := s.CountUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Errorf("user count = %d after rollback, want 0", count)
	}
}
```

---

## Section 8: Circuit Breaker Pattern for Database Connections

When PostgreSQL becomes temporarily unavailable, circuit breaking prevents thundering-herd reconnection storms:

```go
// store/circuit_breaker.go
package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// State represents the circuit breaker state.
type State int

const (
	StateClosed   State = iota // Normal operation
	StateOpen                  // Rejecting all requests
	StateHalfOpen              // Probing for recovery
)

// ErrCircuitOpen is returned when the circuit breaker is open.
var ErrCircuitOpen = errors.New("circuit breaker: database circuit open")

// CircuitBreaker wraps a pool with failure tracking.
type CircuitBreaker struct {
	pool         *pgxpool.Pool
	mu           sync.RWMutex
	state        State
	failures     int
	threshold    int
	lastFailTime time.Time
	resetTimeout time.Duration
}

// NewCircuitBreaker creates a breaker that opens after threshold consecutive failures
// and attempts to recover after resetTimeout.
func NewCircuitBreaker(pool *pgxpool.Pool, threshold int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		pool:         pool,
		state:        StateClosed,
		threshold:    threshold,
		resetTimeout: resetTimeout,
	}
}

// Exec runs fn against the pool, tracking failures.
func (cb *CircuitBreaker) Exec(ctx context.Context, fn func(*pgxpool.Pool) error) error {
	if err := cb.allow(); err != nil {
		return err
	}

	err := fn(cb.pool)
	cb.record(err)
	return err
}

func (cb *CircuitBreaker) allow() error {
	cb.mu.RLock()
	state := cb.state
	lastFail := cb.lastFailTime
	cb.mu.RUnlock()

	switch state {
	case StateClosed:
		return nil
	case StateOpen:
		if time.Since(lastFail) > cb.resetTimeout {
			cb.mu.Lock()
			cb.state = StateHalfOpen
			cb.mu.Unlock()
			return nil // allow the probe
		}
		return ErrCircuitOpen
	case StateHalfOpen:
		return nil
	}
	return nil
}

func (cb *CircuitBreaker) record(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err == nil {
		cb.failures = 0
		cb.state = StateClosed
		return
	}

	// Only count connectivity errors, not query errors.
	if !isConnectivityError(err) {
		return
	}

	cb.failures++
	cb.lastFailTime = time.Now()
	if cb.failures >= cb.threshold {
		cb.state = StateOpen
	}
}

func (cb *CircuitBreaker) State() State {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

// isConnectivityError returns true for errors that indicate the database
// is unreachable rather than a query-level error.
func isConnectivityError(err error) bool {
	if err == nil {
		return false
	}
	// Check for pgx connection-level errors.
	var pgErr *pgconn.ConnectError
	return errors.As(err, &pgErr) || errors.Is(err, pgx.ErrTxClosed)
}
```

---

## Section 9: Observability for Database Operations

Instrument every database call with traces and metrics:

```go
// store/instrumented.go
package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var (
	dbQueryDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "db_query_duration_seconds",
			Help:    "Duration of database queries.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"operation", "status"},
	)
	dbPoolSize = promauto.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "db_pool_total_conns",
			Help: "Total connections in the pool.",
		},
		func() float64 { return 0 }, // replaced at init
	)
)

var tracer = otel.Tracer("myapp/store")

// observe wraps a database operation with metrics and tracing.
func observe(ctx context.Context, operation string, fn func() error) error {
	ctx, span := tracer.Start(ctx, "db."+operation)
	defer span.End()
	span.SetAttributes(attribute.String("db.operation", operation))

	start := time.Now()
	err := fn()
	dur := time.Since(start)

	status := "ok"
	if err != nil {
		status = "error"
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}

	dbQueryDuration.WithLabelValues(operation, status).Observe(dur.Seconds())
	return err
}

// Example usage wrapping the store methods:
func (s *Store) GetUserInstrumented(ctx context.Context, id int64) (*User, error) {
	var user *User
	err := observe(ctx, "GetUser", func() error {
		u, err := s.q.GetUser(ctx, id)
		if err != nil {
			return err
		}
		user = &u
		return nil
	})
	return user, err
}
```

---

## Section 10: Production Checklist

Before deploying a Go service with a PostgreSQL database to production, verify:

```bash
# Verify pool stats are being exported to Prometheus
curl -s http://localhost:9090/metrics | grep db_pool

# Check for slow queries in PostgreSQL
psql -c "
  SELECT query, calls, mean_exec_time, rows
  FROM   pg_stat_statements
  ORDER  BY mean_exec_time DESC
  LIMIT  10;
"

# Verify connection count stays within limits
psql -c "
  SELECT count(*), state
  FROM   pg_stat_activity
  WHERE  datname = 'myapp'
  GROUP  BY state;
"

# Run migration status check
migrate -source file://migrations -database "${DATABASE_URL}" version
```

Key production settings summary:

| Parameter | Development | Production |
|---|---|---|
| MaxConns | 5 | `(CPUs * 2) + 1` |
| MinConns | 1 | 5 |
| MaxConnLifetime | None | 30 min |
| MaxConnIdleTime | None | 5 min |
| HealthCheckPeriod | None | 1 min |
| SSL Mode | disable | require |
| Prepared Statements | Optional | Enabled |
| Circuit Breaker | Disabled | threshold=5, timeout=30s |
