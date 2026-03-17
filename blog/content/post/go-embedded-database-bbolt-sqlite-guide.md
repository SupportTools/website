---
title: "Embedded Databases in Go: bbolt, SQLite, and DuckDB for Local State"
date: 2028-11-06T00:00:00-05:00
draft: false
tags: ["Go", "Database", "bbolt", "SQLite", "Embedded"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Practical guide to embedded databases in Go: bbolt for ACID key-value storage, SQLite with CGO-free modernc.org/sqlite, WAL mode for concurrent reads, DuckDB for analytical queries, and choosing the right embedded database for CLI tools, agents, and caching."
more_link: "yes"
url: "/go-embedded-database-bbolt-sqlite-guide/"
---

Not every application needs a separate database server. CLI tools, edge agents, caches, and local development environments often benefit from embedded databases that ship as part of the binary, require zero operational overhead, and persist state reliably across restarts. Go has three excellent options for different use cases: bbolt for fast key-value storage with ACID transactions, SQLite for relational queries, and DuckDB for analytical workloads.

This guide covers all three in depth: the API patterns, transaction models, performance characteristics, and when each is the right choice.

<!--more-->

# Embedded Databases in Go: bbolt, SQLite, and DuckDB for Local State

## bbolt: ACID Key-Value Store

bbolt (formerly BoltDB) is a pure Go key-value store built on a B+tree structure with memory-mapped files. It uses a copy-on-write model that provides ACID transactions without a write-ahead log:

- **Single file storage**: The entire database is one `.db` file
- **ACID transactions**: Full atomicity, consistency, isolation, and durability
- **Read concurrency**: Multiple goroutines can read concurrently
- **Single writer**: Only one write transaction at a time (no concurrent writes)
- **Memory-mapped**: Reads access data directly from the mmap, avoiding copies
- **Pure Go**: No CGO, no external dependencies

```bash
go get go.etcd.io/bbolt@v1.3.11
```

### Opening the Database

```go
// pkg/store/bbolt.go
package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	ErrNotFound = errors.New("key not found")
)

// Store is a bbolt-backed key-value store with typed access patterns.
type Store struct {
	db *bolt.DB
}

// Open opens or creates a bbolt database at the given path.
// The timeout prevents blocking indefinitely if another process holds the lock.
func Open(path string) (*Store, error) {
	opts := &bolt.Options{
		Timeout:        5 * time.Second,
		NoGrowSync:     false,  // Ensure fsync on grow
		FreelistType:   bolt.FreelistArrayType, // Faster for most workloads
	}

	db, err := bolt.Open(path, 0600, opts)
	if err != nil {
		return nil, fmt.Errorf("opening bbolt database at %s: %w", path, err)
	}

	s := &Store{db: db}
	if err := s.initBuckets(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// initBuckets creates required top-level buckets if they don't exist.
// This is idempotent and safe to call on every open.
func (s *Store) initBuckets() error {
	return s.db.Update(func(tx *bolt.Tx) error {
		buckets := []string{"events", "cache", "state", "indexes"}
		for _, name := range buckets {
			if _, err := tx.CreateBucketIfNotExists([]byte(name)); err != nil {
				return fmt.Errorf("creating bucket %q: %w", name, err)
			}
		}
		return nil
	})
}

func (s *Store) Close() error {
	return s.db.Close()
}
```

### Put, Get, Delete Operations

```go
// Put stores a value under the given key in the specified bucket.
func (s *Store) Put(bucket, key string, value []byte) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return fmt.Errorf("bucket %q does not exist", bucket)
		}
		return b.Put([]byte(key), value)
	})
}

// PutJSON serializes value as JSON and stores it.
func (s *Store) PutJSON(bucket, key string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshaling value: %w", err)
	}
	return s.Put(bucket, key, data)
}

// Get retrieves the value for the given key. Returns ErrNotFound if absent.
func (s *Store) Get(bucket, key string) ([]byte, error) {
	var result []byte
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return fmt.Errorf("bucket %q does not exist", bucket)
		}
		v := b.Get([]byte(key))
		if v == nil {
			return ErrNotFound
		}
		// Copy the value — it's only valid within the transaction.
		result = make([]byte, len(v))
		copy(result, v)
		return nil
	})
	return result, err
}

// GetJSON retrieves and deserializes a JSON value.
func (s *Store) GetJSON(bucket, key string, dest interface{}) error {
	data, err := s.Get(bucket, key)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dest)
}

// Delete removes a key from the bucket. Returns nil if the key doesn't exist.
func (s *Store) Delete(bucket, key string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return fmt.Errorf("bucket %q does not exist", bucket)
		}
		return b.Delete([]byte(key))
	})
}
```

### Cursor Iteration and Range Scans

The bbolt cursor API provides efficient ordered iteration over keys:

```go
// List returns all keys in the bucket with an optional prefix filter.
func (s *Store) List(bucket, prefix string) ([]string, error) {
	var keys []string
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return fmt.Errorf("bucket %q does not exist", bucket)
		}

		c := b.Cursor()
		prefixBytes := []byte(prefix)

		var k, _ []byte
		if prefix != "" {
			// Seek to the first key with this prefix.
			k, _ = c.Seek(prefixBytes)
		} else {
			k, _ = c.First()
		}

		for ; k != nil; k, _ = c.Next() {
			if prefix != "" && !bytes.HasPrefix(k, prefixBytes) {
				break
			}
			keys = append(keys, string(k))
		}
		return nil
	})
	return keys, err
}

// Scan iterates over all key-value pairs in a bucket, calling fn for each.
// Return false from fn to stop iteration.
func (s *Store) Scan(bucket string, fn func(key, value []byte) bool) error {
	return s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return fmt.Errorf("bucket %q does not exist", bucket)
		}
		return b.ForEach(func(k, v []byte) error {
			if !fn(k, v) {
				return errors.New("stop") // ForEach has no built-in stop mechanism
			}
			return nil
		})
	})
}
```

### Auto-Incrementing Keys for Event Log

bbolt's `NextSequence()` method provides atomic auto-incrementing keys, perfect for event logs:

```go
type Event struct {
	ID        uint64    `json:"id"`
	Type      string    `json:"type"`
	Payload   []byte    `json:"payload"`
	Timestamp time.Time `json:"timestamp"`
}

// AppendEvent adds an event to the event log with an auto-assigned ID.
func (s *Store) AppendEvent(eventType string, payload []byte) (uint64, error) {
	var id uint64

	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("events"))

		var err error
		id, err = b.NextSequence()
		if err != nil {
			return fmt.Errorf("generating sequence: %w", err)
		}

		event := Event{
			ID:        id,
			Type:      eventType,
			Payload:   payload,
			Timestamp: time.Now().UTC(),
		}

		data, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("marshaling event: %w", err)
		}

		// Store with a big-endian uint64 key for natural sort order.
		key := make([]byte, 8)
		binary.BigEndian.PutUint64(key, id)
		return b.Put(key, data)
	})

	return id, err
}

// GetRecentEvents returns the last N events from the log.
func (s *Store) GetRecentEvents(n int) ([]Event, error) {
	var events []Event

	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("events"))
		c := b.Cursor()

		count := 0
		for k, v := c.Last(); k != nil && count < n; k, v = c.Prev() {
			var event Event
			if err := json.Unmarshal(v, &event); err != nil {
				return err
			}
			events = append([]Event{event}, events...) // Prepend to maintain order
			count++
		}
		return nil
	})

	return events, err
}
```

### Batch Writes for Performance

Single writes commit a transaction per operation. For high-volume writes, use `db.Batch()`:

```go
// BatchWrite executes multiple writes in a single transaction, improving
// throughput significantly compared to individual writes.
func (s *Store) BatchWrite(entries map[string][]byte, bucket string) error {
	return s.db.Batch(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return fmt.Errorf("bucket %q does not exist", bucket)
		}
		for k, v := range entries {
			if err := b.Put([]byte(k), v); err != nil {
				return err
			}
		}
		return nil
	})
}

// BenchmarkWrite illustrates the performance difference:
// Individual writes: ~200 writes/second (transaction per write)
// Batch writes: ~50,000 writes/second (all writes in one transaction)
```

## SQLite: Relational Queries Without a Server

SQLite is the world's most deployed database. For Go applications, there are two options:

1. **`github.com/mattn/go-sqlite3`**: CGO-based, best performance, requires a C compiler
2. **`modernc.org/sqlite`**: Pure Go (transpiled from C), no CGO, slightly slower, simpler cross-compilation

```bash
# CGO-based (requires gcc)
go get github.com/mattn/go-sqlite3@v1.14.22

# CGO-free (simpler cross-compilation)
go get modernc.org/sqlite@v1.32.0
```

### Opening SQLite with WAL Mode

WAL (Write-Ahead Log) mode enables concurrent readers with a single writer, which dramatically improves read performance in multi-goroutine applications:

```go
// pkg/sqlite/db.go
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"  // Register the driver; use _ "github.com/mattn/go-sqlite3" for CGO version
)

// Open creates or opens a SQLite database with production-recommended settings.
func Open(path string) (*sql.DB, error) {
	// For in-memory: use "file::memory:?cache=shared&mode=memory"
	// The URI query parameters configure SQLite pragmas at connection time.
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000&_foreign_keys=on&_cache_size=-64000", path)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite: %w", err)
	}

	// SQLite does not support concurrent writes — limit to one writer at a time.
	// Multiple readers are fine with WAL mode.
	db.SetMaxOpenConns(1)        // One write connection
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)     // Keep connection open

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("pinging sqlite: %w", err)
	}

	if err := runMigrations(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	return db, nil
}

// OpenReadOnly opens a SQLite database in read-only mode.
// Multiple read-only connections can run concurrently with WAL mode.
func OpenReadOnly(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?mode=ro&_journal_mode=WAL&_busy_timeout=5000", path)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite read-only: %w", err)
	}

	// Read-only connections can be pooled freely.
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)

	return db, nil
}
```

### Migrations

```go
// pkg/sqlite/migrations.go
package sqlite

import (
	"database/sql"
	"fmt"
)

func runMigrations(db *sql.DB) error {
	// Create migrations table to track applied migrations
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return fmt.Errorf("creating migrations table: %w", err)
	}

	migrations := []struct {
		version int
		sql     string
	}{
		{1, `
			CREATE TABLE IF NOT EXISTS cache_entries (
				key TEXT PRIMARY KEY,
				value BLOB NOT NULL,
				expires_at DATETIME,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
		`},
		{2, `
			CREATE TABLE IF NOT EXISTS agent_state (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				agent_id TEXT NOT NULL,
				key TEXT NOT NULL,
				value TEXT,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(agent_id, key)
			);
			CREATE INDEX IF NOT EXISTS idx_agent_state_agent ON agent_state(agent_id);
		`},
	}

	for _, m := range migrations {
		var applied bool
		err := db.QueryRow(
			"SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)",
			m.version,
		).Scan(&applied)
		if err != nil {
			return fmt.Errorf("checking migration %d: %w", m.version, err)
		}
		if applied {
			continue
		}

		if _, err := db.Exec(m.sql); err != nil {
			return fmt.Errorf("applying migration %d: %w", m.version, err)
		}
		if _, err := db.Exec(
			"INSERT INTO schema_migrations (version) VALUES (?)", m.version,
		); err != nil {
			return fmt.Errorf("recording migration %d: %w", m.version, err)
		}
	}

	return nil
}
```

### Typed Repository Pattern

```go
// pkg/sqlite/cache.go
package sqlite

import (
	"context"
	"database/sql"
	"time"
)

type CacheEntry struct {
	Key       string
	Value     []byte
	ExpiresAt *time.Time
}

type CacheRepository struct {
	db *sql.DB
}

func NewCacheRepository(db *sql.DB) *CacheRepository {
	return &CacheRepository{db: db}
}

func (r *CacheRepository) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	var expiresAt *time.Time
	if ttl > 0 {
		t := time.Now().Add(ttl)
		expiresAt = &t
	}

	_, err := r.db.ExecContext(ctx, `
		INSERT INTO cache_entries (key, value, expires_at, accessed_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			expires_at = excluded.expires_at,
			accessed_at = CURRENT_TIMESTAMP
	`, key, value, expiresAt)
	return err
}

func (r *CacheRepository) Get(ctx context.Context, key string) ([]byte, bool, error) {
	var value []byte
	var expiresAt sql.NullTime

	err := r.db.QueryRowContext(ctx, `
		SELECT value, expires_at FROM cache_entries
		WHERE key = ?
	`, key).Scan(&value, &expiresAt)

	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	// Check expiry
	if expiresAt.Valid && time.Now().After(expiresAt.Time) {
		// Async delete (fire and forget)
		go r.db.ExecContext(context.Background(),
			"DELETE FROM cache_entries WHERE key = ?", key)
		return nil, false, nil
	}

	// Update access time
	go r.db.ExecContext(context.Background(),
		"UPDATE cache_entries SET accessed_at = CURRENT_TIMESTAMP WHERE key = ?", key)

	return value, true, nil
}

// Evict removes entries that have expired or are oldest if over capacity.
func (r *CacheRepository) Evict(ctx context.Context, maxEntries int) (int64, error) {
	// Remove expired entries
	result, err := r.db.ExecContext(ctx,
		"DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP")
	if err != nil {
		return 0, err
	}

	deleted, _ := result.RowsAffected()

	// Enforce maximum entry count by removing oldest accessed
	if maxEntries > 0 {
		r2, err := r.db.ExecContext(ctx, `
			DELETE FROM cache_entries WHERE key IN (
				SELECT key FROM cache_entries
				ORDER BY accessed_at ASC
				LIMIT MAX(0, (SELECT COUNT(*) FROM cache_entries) - ?)
			)
		`, maxEntries)
		if err != nil {
			return deleted, err
		}
		d2, _ := r2.RowsAffected()
		deleted += d2
	}

	return deleted, nil
}
```

### ATTACH for Multi-File SQLite Databases

SQLite can attach multiple database files in a single connection, enabling cross-file queries:

```go
// OpenWithAttached opens a primary SQLite database and attaches additional databases.
// This enables queries that join tables across different database files.
func OpenWithAttached(primaryPath string, attached map[string]string) (*sql.DB, error) {
	db, err := Open(primaryPath)
	if err != nil {
		return nil, err
	}

	for schemaName, path := range attached {
		_, err := db.Exec(fmt.Sprintf(`ATTACH DATABASE ? AS %q`, schemaName), path)
		if err != nil {
			db.Close()
			return nil, fmt.Errorf("attaching %q at %s: %w", schemaName, path, err)
		}
	}

	return db, nil
}

// Example usage:
// db, err := OpenWithAttached("main.db", map[string]string{
//     "archive": "/data/archive-2027.db",
//     "config":  "/etc/app/config.db",
// })
//
// Then query across both:
// SELECT m.*, a.historical_data
// FROM main.records m
// LEFT JOIN archive.records a ON m.id = a.id
```

## DuckDB: Analytical Queries in Go

DuckDB is an OLAP database designed for analytical queries on columnar data. It excels at aggregations over large datasets — think log analysis, telemetry processing, and data pipelines in embedded contexts:

```bash
go get github.com/marcboeker/go-duckdb@v1.8.1
```

```go
// pkg/analytics/duckdb.go
package analytics

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/marcboeker/go-duckdb"
)

type AnalyticsDB struct {
	db *sql.DB
}

func NewAnalyticsDB(path string) (*AnalyticsDB, error) {
	db, err := sql.Open("duckdb", path)
	if err != nil {
		return nil, fmt.Errorf("opening duckdb: %w", err)
	}

	// Configure DuckDB for the workload
	queries := []string{
		"SET memory_limit='2GB'",
		"SET threads=4",
		"SET enable_progress_bar=false",
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			db.Close()
			return nil, fmt.Errorf("configuring duckdb: %w", err)
		}
	}

	return &AnalyticsDB{db: db}, nil
}

// QueryParquet queries Parquet files directly — no import needed.
// DuckDB can read Parquet, CSV, JSON, and Arrow files natively.
func (a *AnalyticsDB) QueryParquet(ctx context.Context, parquetGlob string) (*sql.Rows, error) {
	return a.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT
			date_trunc('hour', timestamp) AS hour,
			service_name,
			COUNT(*) AS request_count,
			AVG(duration_ms) AS avg_latency_ms,
			PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_latency_ms,
			SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS error_count
		FROM read_parquet('%s')
		WHERE timestamp >= NOW() - INTERVAL 24 HOURS
		GROUP BY 1, 2
		ORDER BY 1, 2
	`, parquetGlob))
}

// AnalyzeCSVLogs reads and analyzes a CSV log file without importing it.
func (a *AnalyticsDB) AnalyzeCSVLogs(ctx context.Context, csvPath string) ([]LogSummary, error) {
	rows, err := a.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT
			level,
			COUNT(*) AS count,
			MIN(timestamp) AS first_seen,
			MAX(timestamp) AS last_seen
		FROM read_csv_auto('%s',
			header=true,
			columns={'timestamp': 'TIMESTAMP', 'level': 'VARCHAR', 'message': 'VARCHAR'}
		)
		GROUP BY level
		ORDER BY count DESC
	`, csvPath))
	if err != nil {
		return nil, fmt.Errorf("querying logs: %w", err)
	}
	defer rows.Close()

	var summaries []LogSummary
	for rows.Next() {
		var s LogSummary
		if err := rows.Scan(&s.Level, &s.Count, &s.FirstSeen, &s.LastSeen); err != nil {
			return nil, err
		}
		summaries = append(summaries, s)
	}
	return summaries, rows.Err()
}

type LogSummary struct {
	Level     string
	Count     int64
	FirstSeen time.Time
	LastSeen  time.Time
}

// AggregateTelemetry performs OLAP-style aggregation on telemetry data.
// DuckDB is 10-100x faster than SQLite for this type of query.
func (a *AnalyticsDB) AggregateTelemetry(ctx context.Context, tableName string) error {
	_, err := a.db.ExecContext(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS telemetry_hourly AS
		SELECT
			date_trunc('hour', timestamp) AS bucket,
			host,
			metric_name,
			AVG(value) AS avg_value,
			MIN(value) AS min_value,
			MAX(value) AS max_value,
			COUNT(*) AS sample_count
		FROM %s
		GROUP BY 1, 2, 3
	`, tableName))
	return err
}
```

## Choosing the Right Embedded Database

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Decision Matrix                                    │
├──────────────────┬─────────────┬──────────────┬─────────────────────┤
│ Use Case         │ bbolt       │ SQLite       │ DuckDB              │
├──────────────────┼─────────────┼──────────────┼─────────────────────┤
│ Simple KV store  │ Best        │ Possible     │ Overkill            │
│ Event log        │ Best        │ Good         │ Good                │
│ CLI tool state   │ Good        │ Better       │ Overkill            │
│ Structured data  │ Awkward     │ Best         │ Good                │
│ Complex queries  │ No          │ Good         │ Best                │
│ Aggregations     │ No          │ OK (<10M)    │ Best (>10M)         │
│ Concurrent reads │ Yes (mmap)  │ Yes (WAL)    │ Yes                 │
│ Concurrent write │ No          │ No           │ Yes (MVCC)          │
│ CGO required     │ No          │ Optional     │ Yes                 │
│ File size        │ Small       │ Small        │ Small-Medium        │
│ Query language   │ Go API      │ SQL          │ SQL (PostgreSQL-ish)│
│ Best for         │ Caches,     │ Config, CRUD │ Analytics, logs,    │
│                  │ indexes,    │ state mgmt   │ data pipelines      │
│                  │ event logs  │              │                     │
└──────────────────┴─────────────┴──────────────┴─────────────────────┘
```

### Real-World Use Cases

**CLI Tools (bbolt or SQLite)**:
```go
// git-style tool that caches remote repository metadata
type RepoCache struct {
	store *store.Store
}

func (c *RepoCache) GetMetadata(remote string) (*RepoMetadata, bool) {
	var meta RepoMetadata
	err := c.store.GetJSON("repos", remote, &meta)
	if errors.Is(err, store.ErrNotFound) {
		return nil, false
	}
	return &meta, err == nil
}
```

**Agent State (SQLite)**:
```go
// Kubernetes controller agent that tracks reconciliation state
type ReconcileStateDB struct {
	db *sql.DB
}

func (r *ReconcileStateDB) RecordReconcile(ctx context.Context, resource, status string, duration time.Duration) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT OR REPLACE INTO reconcile_state
			(resource_id, last_status, last_duration_ms, reconcile_count, last_at)
		VALUES (?, ?, ?, COALESCE(
			(SELECT reconcile_count + 1 FROM reconcile_state WHERE resource_id = ?),
			1
		), CURRENT_TIMESTAMP)
	`, resource, status, duration.Milliseconds(), resource)
	return err
}
```

**Log Analysis Tool (DuckDB)**:
```go
// Analyze access logs from S3
func analyzeS3Logs(ctx context.Context, s3Path string) error {
	db, _ := analytics.NewAnalyticsDB(":memory:")
	rows, err := db.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT
			strftime(timestamp, '%%Y-%%m-%%d %%H:00') AS hour,
			COUNT(*) AS requests,
			SUM(bytes_sent) / 1024.0 / 1024.0 AS mb_transferred,
			AVG(response_time_ms) AS avg_response_ms
		FROM read_parquet('s3://%s/*.parquet',
			hive_partitioning=true
		)
		GROUP BY 1
		ORDER BY 1
	`, s3Path))
	// ...
}
```

## Summary

Embedded databases eliminate the operational overhead of a separate database server while providing full ACID guarantees:

1. **bbolt** is the best choice for key-value caching, event logs, and indexes where you need fast ordered iteration and pure Go compilation. Its single-writer model is a strength for most CLI and agent use cases where writes are infrequent.

2. **SQLite** with WAL mode handles anything relational: user configuration, CRUD state management, and structured data with complex queries. Use `modernc.org/sqlite` for zero-CGO cross-compilation; use `mattn/go-sqlite3` when you need maximum performance on a target platform.

3. **DuckDB** handles analytical queries at scale — aggregating millions of rows in seconds — with native Parquet, CSV, and JSON file reading. Ideal when your application needs to answer analytical questions without a separate data warehouse.

The winning pattern for production CLI tools is to use SQLite for structured state and bbolt for high-frequency KV caching, with DuckDB available for any analytics subcommands that need to process large datasets.
