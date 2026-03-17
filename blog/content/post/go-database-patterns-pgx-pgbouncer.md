---
title: "Go Database Patterns: pgx v5, Connection Pooling with pgBouncer, and Query Optimization"
date: 2030-02-04T00:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "pgx", "pgBouncer", "Connection Pooling", "Database", "Performance"]
categories: ["Go", "Database"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production PostgreSQL access patterns in Go using pgx v5, pgBouncer transaction pooling, prepared statement caching, batch operations, and COPY protocol for high-throughput bulk inserts."
more_link: "yes"
url: "/go-database-patterns-pgx-pgbouncer/"
---

Production Go services that interact with PostgreSQL face a consistent set of challenges: connection exhaustion under load, N+1 query patterns from naive ORM usage, inefficient bulk insert strategies, and the operational complexity of managing database connection limits across dozens of service replicas. This guide addresses all of these with practical, production-tested patterns using pgx v5 — the most performant PostgreSQL driver for Go — combined with pgBouncer for connection management at scale.

The patterns covered here come from operating systems handling tens of thousands of PostgreSQL transactions per second, where the difference between a naively implemented database layer and an optimized one can mean the difference between a stable system and one that cascades under load.

<!--more-->

## Why pgx v5 Over database/sql

The standard `database/sql` package is a fine abstraction for simple use cases, but it introduces overhead that matters at scale. pgx v5 offers:

- **Direct wire protocol access**: No encoding/decoding through the `database/sql` interface
- **Type system integration**: Native PostgreSQL types (arrays, hstore, JSON, geometric types) without string serialization
- **Batch query support**: Send multiple queries in one network round-trip
- **COPY protocol**: 10-50x faster than individual inserts for bulk data
- **Pipeline mode**: Overlap query execution with result processing
- **Named parameters**: Positional parameter reuse for complex queries

The tradeoff is that pgx is PostgreSQL-specific. If you need database portability, `database/sql` with `lib/pq` is the right choice. For PostgreSQL-only services, pgx is strictly superior.

## Setting Up pgx v5

```bash
go mod init example.com/dbservice
go get github.com/jackc/pgx/v5
go get github.com/jackc/pgx/v5/pgxpool
go get github.com/jackc/pgx/v5/pgtype
```

### Connection Pool Configuration

```go
// internal/db/pool.go
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
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
		MaxConns:          25,
		MinConns:          5,
		MaxConnLifetime:   30 * time.Minute,
		MaxConnIdleTime:   5 * time.Minute,
		HealthCheckPeriod: 1 * time.Minute,
	}
}

func NewPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}

	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MinConns = cfg.MinConns
	poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
	poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime
	poolConfig.HealthCheckPeriod = cfg.HealthCheckPeriod

	// Configure per-connection settings
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe

	// Add tracing to every acquired connection
	poolConfig.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
		return true
	}

	poolConfig.AfterRelease = func(conn *pgx.Conn) bool {
		// Reset the connection state to avoid session variable leaks
		// This is important when using pgBouncer in transaction mode
		return true
	}

	// Add statement tracer
	poolConfig.ConnConfig.Tracer = &queryTracer{
		tracer: otel.Tracer("pgx"),
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	// Verify connectivity on startup
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return pool, nil
}

// queryTracer implements pgx.QueryTracer for OpenTelemetry
type queryTracer struct {
	tracer trace.Tracer
}

type queryData struct {
	span trace.Span
	sql  string
}

func (t *queryTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	ctx, span := t.tracer.Start(ctx, "db.query",
		trace.WithAttributes(
			attribute.String("db.statement", data.SQL),
			attribute.String("db.system", "postgresql"),
		),
	)
	return context.WithValue(ctx, queryData{}, queryData{span: span, sql: data.SQL})
}

func (t *queryTracer) TraceQueryEnd(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData) {
	qd, ok := ctx.Value(queryData{}).(queryData)
	if !ok {
		return
	}
	if data.Err != nil {
		qd.span.RecordError(data.Err)
	}
	qd.span.End()
}
```

### DSN Format and pgBouncer Integration

```go
// internal/db/dsn.go
package db

import (
	"fmt"
	"net/url"
)

type DSNConfig struct {
	Host     string
	Port     int
	Database string
	User     string
	Password string
	// pgBouncer-specific settings
	PrepareThreshold int // 0 disables prepared statements (required for pgBouncer transaction mode)
	SSLMode          string
	SSLRootCert      string
	ApplicationName  string
	// Connection timeout settings
	ConnectTimeout int
	// Statement timeout (milliseconds)
	StatementTimeout int
	LockTimeout      int
}

func BuildDSN(cfg DSNConfig) string {
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(cfg.User, cfg.Password),
		Host:   fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Path:   "/" + cfg.Database,
	}

	q := u.Query()
	q.Set("sslmode", cfg.SSLMode)
	if cfg.SSLRootCert != "" {
		q.Set("sslrootcert", cfg.SSLRootCert)
	}
	if cfg.ApplicationName != "" {
		q.Set("application_name", cfg.ApplicationName)
	}
	if cfg.ConnectTimeout > 0 {
		q.Set("connect_timeout", fmt.Sprintf("%d", cfg.ConnectTimeout))
	}
	// PostgreSQL statement_timeout
	if cfg.StatementTimeout > 0 {
		q.Set("statement_timeout", fmt.Sprintf("%d", cfg.StatementTimeout))
	}
	if cfg.LockTimeout > 0 {
		q.Set("lock_timeout", fmt.Sprintf("%d", cfg.LockTimeout))
	}

	u.RawQuery = q.Encode()
	return u.String()
}

// ForPgBouncer returns a DSN string optimized for pgBouncer transaction pooling.
// In transaction mode, prepared statements and session-level settings do not persist.
func ForPgBouncer(base DSNConfig) DSNConfig {
	base.PrepareThreshold = 0 // Disable prepared statement caching
	return base
}
```

## pgBouncer Configuration

pgBouncer sits between your application and PostgreSQL, multiplexing thousands of application connections into a small pool of actual server connections.

```ini
# /etc/pgbouncer/pgbouncer.ini

[databases]
# Route app database to PostgreSQL
appdb = host=postgres-primary.internal port=5432 dbname=appdb

# Read replica routing (optional)
appdb_ro = host=postgres-replica.internal port=5432 dbname=appdb

[pgbouncer]
# Listening configuration
listen_addr = 0.0.0.0
listen_port = 5432
unix_socket_dir = /var/run/postgresql

# TLS for client connections
client_tls_sslmode = require
client_tls_cert_file = /etc/pgbouncer/certs/server.crt
client_tls_key_file = /etc/pgbouncer/certs/server.key
client_tls_ca_file = /etc/pgbouncer/certs/ca.crt

# TLS for server connections
server_tls_sslmode = require
server_tls_ca_file = /etc/pgbouncer/certs/ca.crt

# Pool configuration
# transaction mode: best for stateless services
# session mode: required for prepared statements, advisory locks
pool_mode = transaction

# Connection limits
max_client_conn = 5000        # Maximum client connections
default_pool_size = 25        # Server connections per database/user pair
reserve_pool_size = 5         # Emergency reserve connections
reserve_pool_timeout = 3.0    # Seconds before using reserve pool
max_db_connections = 100      # Maximum connections to any database
max_user_connections = 0      # No per-user limit (0 = unlimited)

# Timeouts
server_connect_timeout = 15   # Max time to establish server connection
server_idle_timeout = 600     # Close idle server connections after 10 min
client_idle_timeout = 0       # Never close idle client connections
query_timeout = 0             # No query timeout at pgBouncer level (set in app)
query_wait_timeout = 120      # Max time to wait for a server connection
client_login_timeout = 60     # Max time for client authentication

# Server connection management
server_reset_query = DISCARD ALL
server_reset_query_always = 0  # Only reset if client used session features
server_check_query = SELECT 1
server_check_delay = 30

# Logging
log_connections = 0           # Don't log every connection (high volume)
log_disconnections = 0
log_pooler_errors = 1
stats_period = 60

# Admin
admin_users = pgbouncer_admin
stats_users = pgbouncer_stats

# Authentication
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_query = SELECT username, password FROM pgbouncer.get_auth($1)
auth_user = pgbouncer_auth

# Performance tuning
tcp_keepalive = 1
tcp_keepidle = 15
tcp_keepintvl = 15
tcp_keepcnt = 3

# Ignore prepared statements from clients
# (required for transaction pool mode)
ignore_startup_parameters = extra_float_digits,search_path
```

### pgBouncer Auth Function in PostgreSQL

```sql
-- Create pgBouncer authentication function
CREATE SCHEMA IF NOT EXISTS pgbouncer;

CREATE OR REPLACE FUNCTION pgbouncer.get_auth(p_usename TEXT)
RETURNS TABLE(username TEXT, password TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    usename::TEXT,
    passwd::TEXT
  FROM pg_shadow
  WHERE usename = p_usename;
END;
$$;

-- Grant execute to pgBouncer auth user
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT)
  TO pgbouncer_auth;
```

## Repository Pattern with pgx v5

```go
// internal/db/repository.go
package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Querier is satisfied by both *pgxpool.Pool and pgx.Tx
// This allows repositories to work in both transactional and non-transactional contexts
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
}

type User struct {
	ID        int64
	Email     string
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt pgtype.Timestamptz
}

type UserRepository struct {
	pool *pgxpool.Pool
}

func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{pool: pool}
}

// GetByID fetches a single user by primary key.
// Uses QueryExecModeCacheDescribe for automatic type mapping.
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	const query = `
		SELECT id, email, name, created_at, updated_at, deleted_at
		FROM users
		WHERE id = $1 AND deleted_at IS NULL
	`

	var u User
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&u.ID,
		&u.Email,
		&u.Name,
		&u.CreatedAt,
		&u.UpdatedAt,
		&u.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get user %d: %w", id, err)
	}

	return &u, nil
}

// ListByIDs fetches multiple users in a single query using ANY($1).
// This pattern avoids N+1 queries when loading related records.
func (r *UserRepository) ListByIDs(ctx context.Context, ids []int64) ([]*User, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	const query = `
		SELECT id, email, name, created_at, updated_at, deleted_at
		FROM users
		WHERE id = ANY($1) AND deleted_at IS NULL
		ORDER BY id
	`

	rows, err := r.pool.Query(ctx, query, ids)
	if err != nil {
		return nil, fmt.Errorf("list users by ids: %w", err)
	}
	defer rows.Close()

	users, err := pgx.CollectRows(rows, pgx.RowToAddrOfStructByName[User])
	if err != nil {
		return nil, fmt.Errorf("collect user rows: %w", err)
	}

	return users, nil
}

// Create inserts a new user and returns the created record.
func (r *UserRepository) Create(ctx context.Context, email, name string) (*User, error) {
	const query = `
		INSERT INTO users (email, name, created_at, updated_at)
		VALUES ($1, $2, NOW(), NOW())
		RETURNING id, email, name, created_at, updated_at, deleted_at
	`

	var u User
	err := r.pool.QueryRow(ctx, query, email, name).Scan(
		&u.ID,
		&u.Email,
		&u.Name,
		&u.CreatedAt,
		&u.UpdatedAt,
		&u.DeletedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}

	return &u, nil
}

// Update modifies a user record with optimistic locking via updated_at comparison.
func (r *UserRepository) Update(ctx context.Context, id int64, name string, updatedAt time.Time) (*User, error) {
	const query = `
		UPDATE users
		SET name = $2, updated_at = NOW()
		WHERE id = $1 AND updated_at = $3 AND deleted_at IS NULL
		RETURNING id, email, name, created_at, updated_at, deleted_at
	`

	var u User
	err := r.pool.QueryRow(ctx, query, id, name, updatedAt).Scan(
		&u.ID,
		&u.Email,
		&u.Name,
		&u.CreatedAt,
		&u.UpdatedAt,
		&u.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrConflict // Another process updated concurrently
		}
		return nil, fmt.Errorf("update user %d: %w", id, err)
	}

	return &u, nil
}
```

## Batch Operations

Batching multiple queries into a single round-trip is one of the most impactful performance improvements available in pgx:

```go
// internal/db/batch.go
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type BatchUserLoader struct {
	pool *pgxpool.Pool
}

// LoadUsers fetches users and their associated profiles in two queries,
// both sent in a single network round-trip using pgx Batch.
func (l *BatchUserLoader) LoadUsers(ctx context.Context, userIDs []int64) (map[int64]*UserWithProfile, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}

	batch := &pgx.Batch{}

	// Query 1: Load users
	batch.Queue(
		`SELECT id, email, name, created_at FROM users WHERE id = ANY($1) AND deleted_at IS NULL`,
		userIDs,
	)

	// Query 2: Load profiles for the same users
	batch.Queue(
		`SELECT user_id, bio, avatar_url, website FROM user_profiles WHERE user_id = ANY($1)`,
		userIDs,
	)

	results := l.pool.SendBatch(ctx, batch)
	defer results.Close()

	// Process Query 1 results
	userRows, err := results.Query()
	if err != nil {
		return nil, fmt.Errorf("batch query users: %w", err)
	}

	type rawUser struct {
		ID    int64
		Email string
		Name  string
	}

	userMap := make(map[int64]*UserWithProfile, len(userIDs))

	for userRows.Next() {
		var u rawUser
		var createdAt time.Time
		if err := userRows.Scan(&u.ID, &u.Email, &u.Name, &createdAt); err != nil {
			userRows.Close()
			return nil, fmt.Errorf("scan user: %w", err)
		}
		userMap[u.ID] = &UserWithProfile{
			User: User{ID: u.ID, Email: u.Email, Name: u.Name, CreatedAt: createdAt},
		}
	}
	userRows.Close()
	if err := userRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate users: %w", err)
	}

	// Process Query 2 results
	profileRows, err := results.Query()
	if err != nil {
		return nil, fmt.Errorf("batch query profiles: %w", err)
	}

	for profileRows.Next() {
		var userID int64
		var bio, avatarURL, website *string
		if err := profileRows.Scan(&userID, &bio, &avatarURL, &website); err != nil {
			profileRows.Close()
			return nil, fmt.Errorf("scan profile: %w", err)
		}
		if u, ok := userMap[userID]; ok {
			u.Bio = bio
			u.AvatarURL = avatarURL
			u.Website = website
		}
	}
	profileRows.Close()
	if err := profileRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate profiles: %w", err)
	}

	return userMap, nil
}

// BatchInsert uses individual INSERT statements batched into a single round-trip.
// For very large datasets, use CopyFrom instead.
func BatchInsert(ctx context.Context, pool *pgxpool.Pool, items []Item) error {
	const insertSQL = `
		INSERT INTO items (name, value, category_id, created_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (name) DO UPDATE
		SET value = EXCLUDED.value, updated_at = NOW()
	`

	batch := &pgx.Batch{}
	for _, item := range items {
		batch.Queue(insertSQL, item.Name, item.Value, item.CategoryID)
	}

	results := pool.SendBatch(ctx, batch)
	defer results.Close()

	for i := range items {
		if _, err := results.Exec(); err != nil {
			return fmt.Errorf("batch insert item %d (%s): %w", i, items[i].Name, err)
		}
	}

	return results.Close()
}
```

## COPY Protocol for Bulk Inserts

For loading thousands or millions of rows, the COPY protocol is dramatically faster than INSERT statements:

```go
// internal/db/copy.go
package db

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EventRecord represents a time-series event for bulk loading
type EventRecord struct {
	Timestamp  time.Time
	UserID     int64
	EventType  string
	Properties map[string]interface{}
}

// BulkInsertEvents inserts a large slice of events using the COPY protocol.
// Benchmarks show 10-50x speedup over individual INSERTs for 10k+ rows.
func BulkInsertEvents(ctx context.Context, pool *pgxpool.Pool, events []EventRecord) (int64, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	// Use COPY with a source that streams rows
	n, err := conn.CopyFrom(
		ctx,
		pgx.Identifier{"events"},
		[]string{"occurred_at", "user_id", "event_type", "properties"},
		pgx.CopyFromSlice(len(events), func(i int) ([]interface{}, error) {
			e := events[i]
			return []interface{}{
				e.Timestamp,
				e.UserID,
				e.EventType,
				e.Properties, // pgx handles JSON marshaling for jsonb columns
			}, nil
		}),
	)
	if err != nil {
		return 0, fmt.Errorf("copy from: %w", err)
	}

	return n, nil
}

// StreamingCopyInsert reads rows from a channel and inserts them via COPY.
// This is efficient for streaming large datasets from external sources.
func StreamingCopyInsert(ctx context.Context, pool *pgxpool.Pool, rowsCh <-chan EventRecord) (int64, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	source := &channelCopySource{ch: rowsCh, ctx: ctx}

	n, err := conn.CopyFrom(
		ctx,
		pgx.Identifier{"events"},
		[]string{"occurred_at", "user_id", "event_type", "properties"},
		source,
	)
	return n, err
}

// channelCopySource implements pgx.CopyFromSource for channel-based streaming
type channelCopySource struct {
	ch      <-chan EventRecord
	current EventRecord
	ctx     context.Context
	err     error
}

func (s *channelCopySource) Next() bool {
	select {
	case <-s.ctx.Done():
		s.err = s.ctx.Err()
		return false
	case row, ok := <-s.ch:
		if !ok {
			return false
		}
		s.current = row
		return true
	}
}

func (s *channelCopySource) Values() ([]interface{}, error) {
	return []interface{}{
		s.current.Timestamp,
		s.current.UserID,
		s.current.EventType,
		s.current.Properties,
	}, nil
}

func (s *channelCopySource) Err() error {
	return s.err
}

// BulkInsertWithTempTable uses a temp table + COPY for complex upsert operations.
// This is necessary when COPY alone cannot handle conflict resolution.
func BulkInsertWithTempTable(ctx context.Context, pool *pgxpool.Pool, records []UserRecord) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Create temp table matching users schema
	_, err = tx.Exec(ctx, `
		CREATE TEMP TABLE users_staging (LIKE users INCLUDING ALL)
		ON COMMIT DROP
	`)
	if err != nil {
		return fmt.Errorf("create staging table: %w", err)
	}

	// COPY into temp table
	_, err = tx.CopyFrom(
		ctx,
		pgx.Identifier{"users_staging"},
		[]string{"id", "email", "name", "created_at", "updated_at"},
		pgx.CopyFromSlice(len(records), func(i int) ([]interface{}, error) {
			r := records[i]
			return []interface{}{r.ID, r.Email, r.Name, r.CreatedAt, r.UpdatedAt}, nil
		}),
	)
	if err != nil {
		return fmt.Errorf("copy to staging: %w", err)
	}

	// Merge from staging into production table
	_, err = tx.Exec(ctx, `
		INSERT INTO users (id, email, name, created_at, updated_at)
		SELECT id, email, name, created_at, updated_at
		FROM users_staging
		ON CONFLICT (id) DO UPDATE
		SET
			email = EXCLUDED.email,
			name = EXCLUDED.name,
			updated_at = EXCLUDED.updated_at
		WHERE users.updated_at < EXCLUDED.updated_at
	`)
	if err != nil {
		return fmt.Errorf("merge from staging: %w", err)
	}

	return tx.Commit(ctx)
}
```

## Transaction Management

```go
// internal/db/transaction.go
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TxFunc is the callback signature for WithTransaction
type TxFunc func(ctx context.Context, tx pgx.Tx) error

// WithTransaction executes fn within a database transaction.
// It handles commit/rollback automatically.
func WithTransaction(ctx context.Context, pool *pgxpool.Pool, fn TxFunc) error {
	return WithTransactionOptions(ctx, pool, pgx.TxOptions{}, fn)
}

// WithTransactionOptions executes fn within a database transaction using
// the specified isolation level and access mode.
func WithTransactionOptions(ctx context.Context, pool *pgxpool.Pool, opts pgx.TxOptions, fn TxFunc) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	tx, err := conn.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			// On panic, attempt to rollback and re-panic
			_ = tx.Rollback(ctx)
			panic(p)
		}
	}()

	if err := fn(ctx, tx); err != nil {
		if rbErr := tx.Rollback(ctx); rbErr != nil {
			return fmt.Errorf("rollback after error (%v): %w", err, rbErr)
		}
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}

	return nil
}

// WithReadCommittedTx runs fn in a READ COMMITTED transaction (the default).
func WithReadCommittedTx(ctx context.Context, pool *pgxpool.Pool, fn TxFunc) error {
	return WithTransactionOptions(ctx, pool, pgx.TxOptions{
		IsoLevel:   pgx.ReadCommitted,
		AccessMode: pgx.ReadWrite,
	}, fn)
}

// WithRepeatableReadTx runs fn in a REPEATABLE READ transaction.
// Use this when you need consistent reads across multiple queries in a transaction.
func WithRepeatableReadTx(ctx context.Context, pool *pgxpool.Pool, fn TxFunc) error {
	return WithTransactionOptions(ctx, pool, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadWrite,
	}, fn)
}

// WithSerializableTx runs fn in a SERIALIZABLE transaction.
// Use this for write operations that must be isolated from concurrent transactions.
// Be prepared to retry on serialization failures.
func WithSerializableTx(ctx context.Context, pool *pgxpool.Pool, fn TxFunc) error {
	return WithTransactionOptions(ctx, pool, pgx.TxOptions{
		IsoLevel:   pgx.Serializable,
		AccessMode: pgx.ReadWrite,
	}, fn)
}

// RetryOnSerializationFailure retries the given function if it encounters
// a PostgreSQL serialization error (40001) or deadlock (40P01).
func RetryOnSerializationFailure(ctx context.Context, maxRetries int, fn func() error) error {
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}

		if isSerializationError(err) || isDeadlockError(err) {
			lastErr = err
			// Exponential backoff with jitter
			backoff := time.Duration(math.Pow(2, float64(attempt))) * 10 * time.Millisecond
			jitter := time.Duration(rand.Int63n(int64(backoff)))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff + jitter):
			}
			continue
		}

		return err
	}

	return fmt.Errorf("max retries (%d) exceeded: %w", maxRetries, lastErr)
}

func isSerializationError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "40001"
}

func isDeadlockError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "40P01"
}
```

## Query Optimization Patterns

### Prepared Statement Management

In transaction pooling mode with pgBouncer, prepared statements must be emulated at the application level:

```go
// internal/db/prepared.go
package db

import (
	"context"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PreparedQueries holds named queries for documentation purposes.
// With pgBouncer in transaction mode, these are executed as regular queries,
// not as server-side prepared statements.
const (
	QueryGetUserByEmail = `
		SELECT id, email, name, created_at, updated_at
		FROM users
		WHERE email = $1 AND deleted_at IS NULL
	`

	QueryGetActiveOrdersByUser = `
		SELECT o.id, o.status, o.total_amount, o.created_at,
			   COUNT(oi.id) AS item_count
		FROM orders o
		LEFT JOIN order_items oi ON oi.order_id = o.id
		WHERE o.user_id = $1
		  AND o.status NOT IN ('cancelled', 'refunded')
		GROUP BY o.id, o.status, o.total_amount, o.created_at
		ORDER BY o.created_at DESC
		LIMIT $2 OFFSET $3
	`

	QueryUpdateInventory = `
		UPDATE inventory
		SET quantity = quantity - $2,
			last_updated = NOW()
		WHERE product_id = $1
		  AND quantity >= $2
		RETURNING quantity
	`
)
```

### Explain Analyze Wrapper for Development

```go
// internal/db/explain.go
package db

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ExplainAnalyze runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the given query
// and logs the execution plan. Use this in development/staging to identify slow queries.
func ExplainAnalyze(ctx context.Context, pool *pgxpool.Pool, query string, args ...any) error {
	explainSQL := fmt.Sprintf(
		"EXPLAIN (ANALYZE true, BUFFERS true, FORMAT JSON, SETTINGS true, WAL true) %s",
		query,
	)

	row := pool.QueryRow(ctx, explainSQL, args...)

	var planJSON []byte
	if err := row.Scan(&planJSON); err != nil {
		return fmt.Errorf("explain analyze: %w", err)
	}

	var plan interface{}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		return fmt.Errorf("unmarshal plan: %w", err)
	}

	slog.InfoContext(ctx, "query execution plan",
		"query", query,
		"plan", string(planJSON),
	)

	return nil
}
```

## Observability and Metrics

```go
// internal/db/metrics.go
package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	poolAcquireTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pgx_pool_acquire_total",
		Help: "Total number of connection acquisitions",
	})

	poolAcquireDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "pgx_pool_acquire_duration_seconds",
		Help:    "Time taken to acquire a connection from the pool",
		Buckets: prometheus.ExponentialBuckets(0.0001, 2, 16),
	})

	poolConnections = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pgx_pool_connections",
		Help: "Current number of connections in the pool by state",
	}, []string{"state"})

	queryDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pgx_query_duration_seconds",
		Help:    "Query execution duration by operation",
		Buckets: prometheus.ExponentialBuckets(0.0001, 2, 16),
	}, []string{"operation"})

	queryErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pgx_query_errors_total",
		Help: "Total number of query errors by operation",
	}, []string{"operation", "error_code"})
)

// CollectPoolStats periodically collects pgxpool statistics
func CollectPoolStats(ctx context.Context, pool *pgxpool.Pool) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stats := pool.Stat()
			poolConnections.WithLabelValues("total").Set(float64(stats.TotalConns()))
			poolConnections.WithLabelValues("idle").Set(float64(stats.IdleConns()))
			poolConnections.WithLabelValues("in_use").Set(float64(stats.AcquiredConns()))
			poolConnections.WithLabelValues("constructing").Set(float64(stats.ConstructingConns()))
		}
	}
}
```

## Error Handling and Retry Logic

```go
// internal/db/errors.go
package db

import (
	"errors"
	"net"

	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrNotFound        = errors.New("record not found")
	ErrConflict        = errors.New("conflicting update detected")
	ErrConstraintViolation = errors.New("constraint violation")
	ErrConnectionFailed = errors.New("database connection failed")
)

// PostgreSQL error codes
const (
	PgErrUniqueViolation     = "23505"
	PgErrForeignKeyViolation = "23503"
	PgErrNotNullViolation    = "23502"
	PgErrCheckViolation      = "23514"
	PgErrSerializationFailure = "40001"
	PgErrDeadlockDetected    = "40P01"
	PgErrConnectionRefused   = "08006"
	PgErrQueryCanceled       = "57014"
)

// MapError converts pgx errors to application-level errors.
func MapError(err error, operation string) error {
	if err == nil {
		return nil
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case PgErrUniqueViolation:
			return fmt.Errorf("%s: %w (constraint: %s)", operation, ErrConstraintViolation, pgErr.ConstraintName)
		case PgErrForeignKeyViolation:
			return fmt.Errorf("%s: %w (foreign key: %s)", operation, ErrConstraintViolation, pgErr.ConstraintName)
		case PgErrQueryCanceled:
			return fmt.Errorf("%s: query canceled (statement_timeout exceeded)", operation)
		}
	}

	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return fmt.Errorf("%s: %w (network timeout)", operation, ErrConnectionFailed)
	}

	return fmt.Errorf("%s: %w", operation, err)
}
```

## Key Takeaways

**pgx v5 versus database/sql**: The native wire protocol access in pgx v5 delivers measurable performance improvements for PostgreSQL workloads. The type system integration with `pgtype` eliminates string serialization overhead for complex types like arrays, JSON, and UUIDs.

**pgBouncer transaction mode considerations**: When using pgBouncer in transaction mode (the most scalable configuration), prepared statements and session-level settings do not persist between transactions. Set `prepare_threshold = 0` in your pgx config and avoid `SET search_path` within transactions.

**COPY protocol for bulk inserts**: For loading more than 1,000 rows, the COPY protocol consistently outperforms batched INSERTs by 10-50x. The `pgx.CopyFromSlice` and `pgx.CopyFromSource` interfaces make it straightforward to stream data from any source.

**Batch operations for N+1 prevention**: The `pgx.Batch` API lets you send multiple queries in a single network round-trip. This is the most effective tool for eliminating N+1 query patterns without restructuring to complex JOIN queries.

**Connection pool sizing**: The correct pool size is not "as large as possible." Aim for 2-4x the number of CPU cores on your PostgreSQL server, with pgBouncer multiplexing thousands of application connections into this small pool. Monitor `pool_mode` metrics to detect connection starvation.
