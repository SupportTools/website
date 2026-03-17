---
title: "Go SQLite in Production: Embedded Databases, WAL Mode, and Multi-Process Access"
date: 2028-05-13T00:00:00-05:00
draft: false
tags: ["Go", "SQLite", "Embedded Database", "WAL", "Production"]
categories: ["Go", "Databases"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to running SQLite in production with Go, covering WAL mode configuration, connection pool management, multi-process access patterns, backup strategies, and when SQLite is the right choice over PostgreSQL or other databases."
more_link: "yes"
url: "/go-sqlite-production-patterns-guide/"
---

SQLite has a reputation as a toy database, but this reputation is undeserved. SQLite powers the vast majority of browsers, mobile devices, and embedded systems in existence. With modern WAL mode and proper connection pool configuration, SQLite can handle thousands of writes per second and support hundreds of concurrent readers on commodity hardware. In Go, SQLite enables a class of applications — CLI tools, edge servers, local-first applications, and microservices with local state — that would be over-engineered with PostgreSQL. This guide covers production-ready SQLite patterns in Go.

<!--more-->

# Go SQLite in Production: Embedded Databases, WAL Mode, and Multi-Process Access

## When to Use SQLite

SQLite is the right tool when:

- **Single-server deployment**: Your application runs on one server (or pod) and doesn't need horizontal scaling at the database layer
- **Local-first applications**: Desktop apps, CLI tools, mobile applications
- **Edge computing**: Functions or microservices at the edge where a full database server is too heavy
- **Testing**: Fast, isolated, no-setup database for integration tests
- **Read-heavy workloads**: Analytics queries, caching, configuration storage
- **Audit logs / event stores**: Write-once, read-many data patterns

SQLite is the wrong tool when:
- Multiple servers need concurrent write access (use PostgreSQL)
- Dataset exceeds available RAM (SQLite performs best when the DB fits in memory)
- High write concurrency from multiple processes
- You need row-level security or PostgreSQL extensions

## Choosing a Go SQLite Driver

Three main options exist for Go:

1. **modernc.org/sqlite**: Pure Go, no cgo, works on all platforms. Best for portability.
2. **github.com/mattn/go-sqlite3**: cgo-based, battle-tested, requires gcc at build time
3. **github.com/ncruces/go-sqlite3**: Pure Go with WASM, newer but clean API

```go
// go.mod
module github.com/acme/myapp

go 1.22

require (
    // Pure Go - recommended for portability and cross-compilation
    modernc.org/sqlite v1.31.0

    // Or: cgo-based with more features
    // github.com/mattn/go-sqlite3 v1.14.22
)
```

```go
// Using modernc.org/sqlite
import (
    "database/sql"
    _ "modernc.org/sqlite"  // Register the driver
)

db, err := sql.Open("sqlite", "/data/myapp.db")

// Using mattn/go-sqlite3 with DSN options
import (
    "database/sql"
    _ "github.com/mattn/go-sqlite3"
)

db, err := sql.Open("sqlite3", "/data/myapp.db?_journal=WAL&_busy_timeout=5000")
```

## Database Initialization and WAL Mode

WAL (Write-Ahead Logging) mode is essential for any production SQLite deployment with concurrent access:

```go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	_ "modernc.org/sqlite"
)

// Config holds database configuration
type Config struct {
	Path            string
	WALMode         bool
	BusyTimeout     time.Duration
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	Pragmas         map[string]string
}

func DefaultConfig(path string) Config {
	return Config{
		Path:            path,
		WALMode:         true,
		BusyTimeout:     5 * time.Second,
		MaxOpenConns:    1,  // One writer, see below
		MaxIdleConns:    1,
		ConnMaxLifetime: 0, // Don't cycle connections
		Pragmas:         make(map[string]string),
	}
}

// Open initializes a SQLite database with production settings
func Open(cfg Config) (*sql.DB, error) {
	// Build DSN with pragmas as URI parameters
	dsn := fmt.Sprintf("file:%s?_busy_timeout=%d",
		cfg.Path,
		cfg.BusyTimeout.Milliseconds(),
	)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening SQLite database %s: %w", cfg.Path, err)
	}

	// CRITICAL: For single-writer mode, use exactly 1 connection
	// This prevents SQLITE_BUSY errors and database corruption
	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

	// Apply pragmas via a dedicated setup connection
	if err := setupPragmas(db, cfg); err != nil {
		db.Close()
		return nil, fmt.Errorf("setting up pragmas: %w", err)
	}

	return db, nil
}

func setupPragmas(db *sql.DB, cfg Config) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pragmas := []struct {
		key   string
		value string
	}{
		// WAL mode: readers don't block writers, writers don't block readers
		{"journal_mode", "WAL"},

		// Synchronous mode: NORMAL provides crash safety with WAL, faster than FULL
		// FULL: flush WAL on every commit (slowest, safest)
		// NORMAL: flush at WAL checkpoints (fast, safe with WAL)
		// OFF: no flushes (fastest, data loss on OS crash)
		{"synchronous", "NORMAL"},

		// Cache size: 64MB of page cache (positive = pages, negative = kibibytes)
		{"cache_size", "-65536"},

		// Temp directory for sorting large result sets
		{"temp_store", "MEMORY"},

		// Memory-mapped I/O for reads: 1GB
		// Allows the OS to directly access the database file via mmap
		{"mmap_size", "1073741824"},

		// Foreign key enforcement (disabled by default in SQLite!)
		{"foreign_keys", "ON"},

		// WAL autocheckpoint: checkpoint when WAL reaches this many pages
		// Default 1000, higher = better write performance, more recovery time
		{"wal_autocheckpoint", "2000"},

		// Page size: must be set before database creation
		// 4096 is optimal for SSDs; 8192 for large blobs
		{"page_size", "4096"},

		// Busy handler timeout (milliseconds) - how long to wait on SQLITE_BUSY
		{"busy_timeout", fmt.Sprintf("%d", cfg.BusyTimeout.Milliseconds())},

		// Locking mode: NORMAL (default) or EXCLUSIVE
		// EXCLUSIVE prevents other processes from accessing the database
		{"locking_mode", "NORMAL"},
	}

	// Add any custom pragmas
	for k, v := range cfg.Pragmas {
		pragmas = append(pragmas, struct{ key, value string }{k, v})
	}

	for _, p := range pragmas {
		if _, err := db.ExecContext(ctx, fmt.Sprintf("PRAGMA %s = %s", p.key, p.value)); err != nil {
			return fmt.Errorf("setting pragma %s=%s: %w", p.key, p.value, err)
		}
	}

	// Verify WAL mode was applied
	var journalMode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		return fmt.Errorf("checking journal_mode: %w", err)
	}
	if journalMode != "wal" {
		return fmt.Errorf("failed to enable WAL mode: got %s", journalMode)
	}

	slog.Info("SQLite configured",
		"path", cfg.Path,
		"journal_mode", journalMode,
	)

	return nil
}
```

## Connection Pool Configuration

The most important SQLite configuration decision in Go is the connection pool:

```go
package db

// OpenWithSeparateReadPool creates two connection pools:
// 1. A single-connection write pool (serialized writes)
// 2. A multi-connection read pool (concurrent reads via WAL)
func OpenWithSeparateReadPool(path string) (writeDB *sql.DB, readDB *sql.DB, err error) {
	// Writer: exactly one connection to serialize writes
	writeDB, err = openWriter(path)
	if err != nil {
		return nil, nil, fmt.Errorf("opening write pool: %w", err)
	}

	// Reader: multiple connections for concurrent reads
	readDB, err = openReader(path)
	if err != nil {
		writeDB.Close()
		return nil, nil, fmt.Errorf("opening read pool: %w", err)
	}

	return writeDB, readDB, nil
}

func openWriter(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_busy_timeout=10000&_journal=WAL&_synchronous=NORMAL", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	// CRITICAL: Single connection for writer prevents concurrent write conflicts
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0) // Keep connection alive

	return db, setupPragmas(db, Config{BusyTimeout: 10 * time.Second})
}

func openReader(path string) (*sql.DB, error) {
	// mode=ro opens the database read-only (prevents accidental writes)
	dsn := fmt.Sprintf("file:%s?mode=ro&_busy_timeout=5000", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	// Multiple readers are fine with WAL mode
	// Each reader gets a consistent snapshot of committed data
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(1 * time.Hour)

	return db, nil
}
```

## Schema Management with Migrations

```go
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"sort"
	"strings"
)

//go:embed *.sql
var migrationFiles embed.FS

// Migrator manages schema migrations
type Migrator struct {
	db *sql.DB
}

func New(db *sql.DB) *Migrator {
	return &Migrator{db: db}
}

// Migrate applies all pending migrations
func (m *Migrator) Migrate(ctx context.Context) error {
	if err := m.createMigrationsTable(ctx); err != nil {
		return err
	}

	applied, err := m.appliedMigrations(ctx)
	if err != nil {
		return fmt.Errorf("loading applied migrations: %w", err)
	}

	files, err := migrationFiles.ReadDir(".")
	if err != nil {
		return fmt.Errorf("reading migration files: %w", err)
	}

	// Sort migrations by filename (format: 001_initial_schema.sql)
	var pending []string
	for _, f := range files {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".sql") {
			if !applied[f.Name()] {
				pending = append(pending, f.Name())
			}
		}
	}
	sort.Strings(pending)

	for _, filename := range pending {
		slog.Info("applying migration", "file", filename)
		if err := m.applyMigration(ctx, filename); err != nil {
			return fmt.Errorf("applying %s: %w", filename, err)
		}
	}

	return nil
}

func (m *Migrator) createMigrationsTable(ctx context.Context) error {
	_, err := m.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename    TEXT PRIMARY KEY,
			applied_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			checksum    TEXT NOT NULL
		)
	`)
	return err
}

func (m *Migrator) appliedMigrations(ctx context.Context) (map[string]bool, error) {
	rows, err := m.db.QueryContext(ctx, "SELECT filename FROM schema_migrations")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	applied := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		applied[name] = true
	}
	return applied, rows.Err()
}

func (m *Migrator) applyMigration(ctx context.Context, filename string) error {
	content, err := migrationFiles.ReadFile(filename)
	if err != nil {
		return err
	}

	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, string(content)); err != nil {
		return fmt.Errorf("executing migration SQL: %w", err)
	}

	checksum := fmt.Sprintf("%x", sha256sum(content))
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)",
		filename, checksum,
	); err != nil {
		return fmt.Errorf("recording migration: %w", err)
	}

	return tx.Commit()
}
```

Example migration files:

```sql
-- 001_initial_schema.sql
CREATE TABLE users (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at)
    WHERE expires_at > datetime('now');  -- Partial index for active sessions

-- Automatic updated_at trigger
CREATE TRIGGER users_updated_at
    AFTER UPDATE ON users
    FOR EACH ROW
BEGIN
    UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;
```

## Production Query Patterns

```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var ErrNotFound = errors.New("not found")

type User struct {
	ID        string
	Email     string
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type UserStore struct {
	db *sql.DB
}

// GetUserByID demonstrates proper SQLite query patterns
func (s *UserStore) GetUserByID(ctx context.Context, id string) (*User, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, name, created_at, updated_at
		 FROM users
		 WHERE id = ?`,
		id,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.UpdatedAt)

	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("querying user %s: %w", id, err)
	}
	return &u, nil
}

// ListUsers with cursor-based pagination (more efficient than OFFSET for SQLite)
func (s *UserStore) ListUsers(ctx context.Context, afterID string, limit int) ([]*User, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}

	query := `
		SELECT id, email, name, created_at, updated_at
		FROM users
		WHERE (? = '' OR id > ?)
		ORDER BY id ASC
		LIMIT ?`

	rows, err := s.db.QueryContext(ctx, query, afterID, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("listing users: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scanning user: %w", err)
		}
		users = append(users, &u)
	}

	return users, rows.Err()
}

// CreateUser demonstrates INSERT with conflict handling
func (s *UserStore) CreateUser(ctx context.Context, email, name string) (*User, error) {
	user := &User{
		Email: email,
		Name:  name,
	}

	err := s.db.QueryRowContext(ctx,
		`INSERT INTO users (email, name)
		 VALUES (?, ?)
		 ON CONFLICT (email) DO UPDATE SET
		   name = excluded.name,
		   updated_at = datetime('now')
		 RETURNING id, email, name, created_at, updated_at`,
		email, name,
	).Scan(&user.ID, &user.Email, &user.Name, &user.CreatedAt, &user.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("creating user %s: %w", email, err)
	}

	return user, nil
}

// BatchInsert demonstrates efficient bulk inserts with prepared statements
func (s *UserStore) BatchInsert(ctx context.Context, users []User) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		"INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)")
	if err != nil {
		return fmt.Errorf("preparing statement: %w", err)
	}
	defer stmt.Close()

	for _, u := range users {
		if _, err := stmt.ExecContext(ctx, u.ID, u.Email, u.Name); err != nil {
			return fmt.Errorf("inserting user %s: %w", u.Email, err)
		}
	}

	return tx.Commit()
}
```

## WAL Mode Checkpointing and Maintenance

```go
package maintenance

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// CheckpointResult holds WAL checkpoint metrics
type CheckpointResult struct {
	NumFrames     int // Number of frames in WAL
	NumCheckpointed int // Number of frames checkpointed
}

// Checkpoint performs a WAL checkpoint operation
// mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"
func Checkpoint(ctx context.Context, db *sql.DB, mode string) (*CheckpointResult, error) {
	var busy, total, written int
	err := db.QueryRowContext(ctx,
		fmt.Sprintf("PRAGMA wal_checkpoint(%s)", mode),
	).Scan(&busy, &total, &written)
	if err != nil {
		return nil, fmt.Errorf("WAL checkpoint: %w", err)
	}

	if busy != 0 {
		slog.Warn("WAL checkpoint blocked by readers",
			"mode", mode,
			"blocked_frames", busy,
		)
	}

	return &CheckpointResult{
		NumFrames:       total,
		NumCheckpointed: written,
	}, nil
}

// MaintenanceWorker runs periodic SQLite maintenance
type MaintenanceWorker struct {
	db       *sql.DB
	interval time.Duration
}

func NewMaintenanceWorker(db *sql.DB, interval time.Duration) *MaintenanceWorker {
	return &MaintenanceWorker{db: db, interval: interval}
}

func (w *MaintenanceWorker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Final checkpoint on shutdown
			w.performMaintenance(context.Background(), true)
			return
		case <-ticker.C:
			w.performMaintenance(ctx, false)
		}
	}
}

func (w *MaintenanceWorker) performMaintenance(ctx context.Context, final bool) {
	// Check WAL size
	var walSize int64
	_ = w.db.QueryRowContext(ctx, "PRAGMA wal_size").Scan(&walSize)

	slog.Debug("performing SQLite maintenance", "wal_size", walSize, "final", final)

	// Checkpoint: move WAL data back to main database file
	mode := "PASSIVE" // Non-blocking: doesn't wait for readers
	if final {
		mode = "TRUNCATE" // Truncates WAL file after checkpointing
	} else if walSize > 50*1024*1024 { // > 50MB WAL
		mode = "RESTART" // Restarts writers to allow full checkpoint
	}

	result, err := Checkpoint(ctx, w.db, mode)
	if err != nil {
		slog.Error("checkpoint failed", "error", err)
		return
	}

	if result.NumCheckpointed < result.NumFrames {
		slog.Debug("partial checkpoint",
			"checkpointed", result.NumCheckpointed,
			"total", result.NumFrames,
		)
	}

	// Periodic ANALYZE to update query planner statistics
	// Run weekly or when significant data changes
	if _, err := w.db.ExecContext(ctx, "ANALYZE"); err != nil {
		slog.Warn("ANALYZE failed", "error", err)
	}
}

// Vacuum reclaims space and defragments the database
// Run during maintenance windows — this locks the database
func Vacuum(ctx context.Context, db *sql.DB) error {
	slog.Info("starting SQLite VACUUM")
	start := time.Now()

	if _, err := db.ExecContext(ctx, "VACUUM"); err != nil {
		return fmt.Errorf("VACUUM failed: %w", err)
	}

	slog.Info("SQLite VACUUM complete", "duration", time.Since(start))
	return nil
}

// VacuumInto creates a defragmented copy of the database
// Doesn't lock the source database — safe for production
func VacuumInto(ctx context.Context, db *sql.DB, destPath string) error {
	slog.Info("creating VACUUM copy", "dest", destPath)
	start := time.Now()

	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", destPath); err != nil {
		return fmt.Errorf("VACUUM INTO %s: %w", destPath, err)
	}

	slog.Info("VACUUM INTO complete", "dest", destPath, "duration", time.Since(start))
	return nil
}
```

## Backup Strategies

```go
package backup

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// BackupConfig holds backup configuration
type BackupConfig struct {
	SourcePath  string
	BackupDir   string
	MaxBackups  int
	Compress    bool
}

// BackupManager handles database backup operations
type BackupManager struct {
	db     *sql.DB
	config BackupConfig
}

// CreateBackup creates a consistent backup using VACUUM INTO
// This is the recommended approach as it:
// 1. Creates a consistent point-in-time copy
// 2. Doesn't lock the source database
// 3. Produces a defragmented copy
func (b *BackupManager) CreateBackup(ctx context.Context) (string, error) {
	timestamp := time.Now().Format("20060102-150405")
	backupName := fmt.Sprintf("backup-%s.db", timestamp)
	backupPath := filepath.Join(b.config.BackupDir, backupName)

	if err := os.MkdirAll(b.config.BackupDir, 0750); err != nil {
		return "", fmt.Errorf("creating backup directory: %w", err)
	}

	slog.Info("creating database backup", "dest", backupPath)
	start := time.Now()

	// VACUUM INTO creates a clean, consistent copy
	if _, err := b.db.ExecContext(ctx, "VACUUM INTO ?", backupPath); err != nil {
		return "", fmt.Errorf("creating backup: %w", err)
	}

	info, _ := os.Stat(backupPath)
	slog.Info("backup created",
		"path", backupPath,
		"size_mb", info.Size()/(1024*1024),
		"duration", time.Since(start),
	)

	// Rotate old backups
	if err := b.rotateBackups(); err != nil {
		slog.Warn("failed to rotate backups", "error", err)
	}

	return backupPath, nil
}

// RestoreFromBackup restores from a backup file
// The service must be stopped before restoring
func RestoreFromBackup(backupPath, targetPath string) error {
	// Verify backup is valid
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro", backupPath))
	if err != nil {
		return fmt.Errorf("opening backup for verification: %w", err)
	}

	var integrity string
	err = db.QueryRow("PRAGMA integrity_check").Scan(&integrity)
	db.Close()

	if err != nil {
		return fmt.Errorf("integrity check failed: %w", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("backup integrity check failed: %s", integrity)
	}

	// Copy backup to target
	return copyFile(backupPath, targetPath)
}

func (b *BackupManager) rotateBackups() error {
	entries, err := os.ReadDir(b.config.BackupDir)
	if err != nil {
		return err
	}

	var backups []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".db" {
			backups = append(backups, filepath.Join(b.config.BackupDir, e.Name()))
		}
	}

	// Remove oldest backups beyond MaxBackups
	if len(backups) > b.config.MaxBackups {
		// Sort by name (timestamp-based names sort chronologically)
		for _, old := range backups[:len(backups)-b.config.MaxBackups] {
			if err := os.Remove(old); err != nil {
				slog.Warn("failed to remove old backup", "path", old, "error", err)
			}
		}
	}

	return nil
}
```

## Performance Tuning and EXPLAIN QUERY PLAN

```go
package analysis

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
)

// ExplainQuery prints the query plan for a SQL statement
func ExplainQuery(ctx context.Context, db *sql.DB, query string, args ...interface{}) error {
	explainQuery := "EXPLAIN QUERY PLAN " + query

	rows, err := db.QueryContext(ctx, explainQuery, args...)
	if err != nil {
		return fmt.Errorf("explain query: %w", err)
	}
	defer rows.Close()

	slog.Info("query plan", "query", query)
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			continue
		}

		// Warn on full table scans
		if strings.Contains(detail, "SCAN") && !strings.Contains(detail, "INDEX") {
			slog.Warn("full table scan detected",
				"detail", detail,
				"query", query,
			)
		}

		fmt.Printf("  %d %d %s\n", id, parent, detail)
	}

	return rows.Err()
}

// AnalyzeIndexUsage checks if queries are using indexes effectively
func AnalyzeIndexUsage(ctx context.Context, db *sql.DB) error {
	// Get all tables
	rows, err := db.QueryContext(ctx,
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
	if err != nil {
		return err
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		tables = append(tables, name)
	}

	for _, table := range tables {
		var count int64
		db.QueryRowContext(ctx,
			fmt.Sprintf("SELECT COUNT(*) FROM %s", table),
		).Scan(&count)

		slog.Info("table statistics",
			"table", table,
			"rows", count,
		)
	}

	return nil
}
```

## SQLite with High Concurrency: Connection Isolation Levels

```go
package txpatterns

import (
	"context"
	"database/sql"
	"fmt"
)

// For write-intensive workloads, use IMMEDIATE or EXCLUSIVE transactions
// to prevent write conflicts without retrying

// WriteWithImmediate uses IMMEDIATE isolation for predictable write behavior
// IMMEDIATE: acquires a reserved lock, preventing other writers
func WriteWithImmediate(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Upgrade to IMMEDIATE immediately
	if _, err := tx.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		// Note: BeginTx already started an implicit transaction
		// For mattn/go-sqlite3, use sql.TxOptions or connection pragmas
	}

	if err := fn(tx); err != nil {
		return err
	}

	return tx.Commit()
}

// For read transactions, use DEFERRED (default) or explicit read-only
func ReadOnly(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{
		ReadOnly: true,
		// Use READ COMMITTED to see the latest committed data
		Isolation: sql.LevelReadCommitted,
	})
	if err != nil {
		return fmt.Errorf("beginning read transaction: %w", err)
	}
	defer tx.Rollback()

	return fn(tx)
}
```

## SQLite Monitoring with Prometheus

```go
package metrics

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	dbSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sqlite_database_size_bytes",
		Help: "Size of the SQLite database file",
	})

	walSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sqlite_wal_size_bytes",
		Help: "Size of the SQLite WAL file",
	})

	pageCount = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sqlite_page_count",
		Help: "Number of pages in the database",
	})

	cacheHitRatio = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sqlite_cache_hit_ratio",
		Help: "Page cache hit ratio (0.0-1.0)",
	})
)

type MetricsCollector struct {
	db   *sql.DB
	path string
}

func (c *MetricsCollector) Collect(ctx context.Context) {
	// Page count and free pages
	var pages, freePages int64
	c.db.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages)
	c.db.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&freePages)
	pageCount.Set(float64(pages))

	// Cache statistics
	var cacheHits, cacheMisses int64
	rows, _ := c.db.QueryContext(ctx, "PRAGMA cache_stats")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var key string
			var value int64
			if err := rows.Scan(&key, &value); err != nil {
				continue
			}
			switch key {
			case "PageCacheHits":
				cacheHits = value
			case "PageCacheMisses":
				cacheMisses = value
			}
		}
		total := cacheHits + cacheMisses
		if total > 0 {
			cacheHitRatio.Set(float64(cacheHits) / float64(total))
		}
	}
}

func RunMetricsCollector(ctx context.Context, db *sql.DB, path string) {
	collector := &MetricsCollector{db: db, path: path}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collector.Collect(ctx)
		}
	}
}
```

## Multi-Process Access Patterns

When multiple processes need access to the same SQLite database, WAL mode and proper locking are essential:

```bash
# File-level locking with flock for external coordination
# (When you need to run maintenance while the application is stopped)
flock -x /data/myapp.db.lock vacuumdb.sh

# Check who holds locks on the database
fuser /data/myapp.db
lsof /data/myapp.db
```

```go
// Graceful shutdown: ensure all transactions complete before exit
func (app *App) Shutdown(ctx context.Context) error {
	slog.Info("shutting down database")

	// Stop accepting new requests
	// ... signal HTTP server to stop

	// Perform final checkpoint to minimize recovery time on restart
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	if _, err := app.db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		slog.Warn("final checkpoint failed", "error", err)
	}

	return app.db.Close()
}
```

## Conclusion

SQLite with WAL mode is a genuinely production-capable database for the right use cases. The keys to success are: enabling WAL mode (dramatically improves concurrent access), using a single writer connection to avoid locking issues, using VACUUM INTO for non-blocking backups, and running periodic ANALYZE to keep the query planner statistics fresh.

For Go applications, the modernc.org/sqlite pure-Go driver eliminates cgo complexity and enables easy cross-compilation. Separating read and write connection pools lets you scale read concurrency while maintaining the single-writer serialization guarantee that makes SQLite reliable.

SQLite is not PostgreSQL. It won't handle thousands of concurrent writers or distributed deployments. But for the vast class of applications that need a reliable, zero-maintenance, embedded database — CLI tools, edge functions, single-server web applications, local caches, audit logs — SQLite with proper configuration is an excellent choice that avoids the operational overhead of a separate database server.
