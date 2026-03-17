---
title: "Go Database Migrations: Atlas, golang-migrate, and Schema Version Management"
date: 2029-12-22T00:00:00-05:00
draft: false
tags: ["Go", "Database", "Migrations", "Atlas", "golang-migrate", "PostgreSQL", "Schema Management", "DevOps"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Atlas schema management and golang-migrate library in Go: schema versioning, migration testing, rollback strategies, blue-green schema changes, and CI/CD integration."
more_link: "yes"
url: "/go-database-migrations-atlas-golang-migrate-schema-version-management/"
---

Database schema migrations are the most dangerous code you deploy — they modify shared state that affects every running instance simultaneously and cannot be rolled back trivially once applied. Two tools dominate the Go database migration space: golang-migrate for sequential, file-based migration management, and Atlas for declarative schema state management with automatic migration generation. This guide covers both, plus production patterns for zero-downtime schema changes, migration testing, and CI/CD integration.

<!--more-->

## golang-migrate: Sequential File-Based Migrations

`golang-migrate` implements the classic migration pattern: numbered SQL files, a migrations table tracking which files have been applied, and simple up/down semantics.

### Installation

```bash
# CLI tool
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# Library
go get github.com/golang-migrate/migrate/v4
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/file
```

### Migration File Conventions

```
db/migrations/
├── 000001_create_users.up.sql
├── 000001_create_users.down.sql
├── 000002_create_posts.up.sql
├── 000002_create_posts.down.sql
├── 000003_add_users_email_index.up.sql
├── 000003_add_users_email_index.down.sql
└── 000004_add_posts_published_at.up.sql
    000004_add_posts_published_at.down.sql
```

### Migration Files

```sql
-- 000001_create_users.up.sql
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT        NOT NULL,
    username    TEXT        NOT NULL,
    password_hash TEXT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX CONCURRENTLY users_email_unique
    ON users (email)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX CONCURRENTLY users_username_unique
    ON users (username)
    WHERE deleted_at IS NULL;
```

```sql
-- 000001_create_users.down.sql
DROP INDEX IF EXISTS users_email_unique;
DROP INDEX IF EXISTS users_username_unique;
DROP TABLE IF EXISTS users;
```

```sql
-- 000003_add_users_email_index.up.sql
-- CONCURRENTLY avoids table lock on production
-- Must be run outside a transaction (golang-migrate handles this with DisableTransactions)
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_email_lower_idx
    ON users (LOWER(email));
```

```sql
-- 000003_add_users_email_index.down.sql
DROP INDEX CONCURRENTLY IF EXISTS users_email_lower_idx;
```

### Embedded Migrations in Go Binary

```go
// db/migrations.go
package db

import "embed"

//go:embed migrations/*.sql
var MigrationFiles embed.FS
```

### Migration Runner

```go
// internal/database/migrate.go
package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

func RunMigrations(ctx context.Context, db *sql.DB, migrationFiles embed.FS) error {
	sourceDriver, err := iofs.New(migrationFiles, "migrations")
	if err != nil {
		return fmt.Errorf("create migration source: %w", err)
	}

	dbDriver, err := postgres.WithInstance(db, &postgres.Config{
		MigrationsTable: "schema_migrations",
		DatabaseName:    "myapp",
	})
	if err != nil {
		return fmt.Errorf("create migration driver: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", dbDriver)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}
	defer m.Close()

	version, dirty, err := m.Version()
	if err != nil && err != migrate.ErrNilVersion {
		return fmt.Errorf("get migration version: %w", err)
	}

	if dirty {
		return fmt.Errorf("database is in a dirty state at version %d — manual intervention required", version)
	}

	slog.Info("running database migrations", "current_version", version)

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("run migrations: %w", err)
	}

	newVersion, _, _ := m.Version()
	slog.Info("migrations complete", "version", newVersion)
	return nil
}

func MigrateDown(db *sql.DB, migrationFiles embed.FS, steps int) error {
	sourceDriver, err := iofs.New(migrationFiles, "migrations")
	if err != nil {
		return err
	}
	dbDriver, err := postgres.WithInstance(db, &postgres.Config{})
	if err != nil {
		return err
	}
	m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", dbDriver)
	if err != nil {
		return err
	}
	defer m.Close()

	return m.Steps(-steps)
}
```

### CLI Usage

```bash
# Run all pending migrations
migrate -path ./db/migrations \
  -database "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  up

# Run exactly N migrations up
migrate -path ./db/migrations \
  -database "postgres://..." up 3

# Roll back the last migration
migrate -path ./db/migrations \
  -database "postgres://..." down 1

# Check current version
migrate -path ./db/migrations \
  -database "postgres://..." version

# Force a specific version (use to clear dirty state)
migrate -path ./db/migrations \
  -database "postgres://..." force 5
```

## Atlas: Declarative Schema Management

Atlas takes a different approach: you define the *desired* schema state in HCL or SQL, and Atlas diffs the current database state against the desired state to generate a migration plan automatically.

### Installation

```bash
# Install Atlas CLI
curl -sSf https://atlasgo.sh | sh

# Go library
go get ariga.io/atlas
go get ariga.io/atlas/sql/postgres
go get entgo.io/ent/dialect/sql/schema
```

### Schema Definition in HCL

```hcl
# schema.hcl
table "users" {
  schema = schema.public

  column "id" {
    type = bigserial
    null = false
  }
  column "email" {
    type = text
    null = false
  }
  column "username" {
    type = text
    null = false
  }
  column "password_hash" {
    type = text
    null = false
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("NOW()")
  }
  column "updated_at" {
    type    = timestamptz
    null    = false
    default = sql("NOW()")
  }
  column "deleted_at" {
    type = timestamptz
    null = true
  }

  primary_key {
    columns = [column.id]
  }

  index "users_email_unique" {
    unique  = true
    columns = [column.email]
    where   = "deleted_at IS NULL"
  }
}

table "posts" {
  schema = schema.public

  column "id" {
    type = bigserial
  }
  column "user_id" {
    type = bigint
    null = false
  }
  column "title" {
    type = varchar(500)
    null = false
  }
  column "body" {
    type = text
    null = false
  }
  column "published_at" {
    type = timestamptz
    null = true
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("NOW()")
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "posts_user_id_fk" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete   = CASCADE
  }

  index "posts_user_id_idx" {
    columns = [column.user_id]
  }
}
```

### Atlas Workflow

```bash
# Inspect the current database schema into HCL
atlas schema inspect \
  -u "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  > current_schema.hcl

# Diff desired schema against current state (dry run)
atlas schema diff \
  --from "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  --to "file://schema.hcl"

# Apply schema changes (interactive approval)
atlas schema apply \
  -u "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  --to "file://schema.hcl" \
  --dev-url "docker://postgres/15/dev?search_path=public"

# Generate a versioned migration file from the diff (hybrid workflow)
atlas migrate diff add_published_at \
  --dir "file://db/migrations" \
  --to "file://schema.hcl" \
  --dev-url "docker://postgres/15/dev?search_path=public"

# Validate migration directory consistency
atlas migrate validate \
  --dir "file://db/migrations" \
  --dev-url "docker://postgres/15/dev?search_path=public"

# Apply versioned migrations
atlas migrate apply \
  -u "postgres://user:pass@localhost:5432/myapp?sslmode=disable" \
  --dir "file://db/migrations"
```

### Atlas in Go Code

```go
// internal/database/atlas.go
package database

import (
	"context"
	"fmt"

	"ariga.io/atlas/sql/migrate"
	"ariga.io/atlas/sql/postgres"
	"database/sql"
)

func RunAtlasMigrations(ctx context.Context, db *sql.DB, migrationsDir string) error {
	// Open Atlas driver for the existing *sql.DB
	driver, err := postgres.Open(db)
	if err != nil {
		return fmt.Errorf("open atlas driver: %w", err)
	}

	// Read migration directory
	dir, err := migrate.NewLocalDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("open migrations dir: %w", err)
	}

	// Create executor
	ex, err := migrate.NewExecutor(driver, dir, migrate.NopRevisionReadWriter{})
	if err != nil {
		return fmt.Errorf("create executor: %w", err)
	}

	// Execute pending migrations
	if err := ex.ExecuteN(ctx, 0); err != nil && err != migrate.ErrNoPendingFiles {
		return fmt.Errorf("execute migrations: %w", err)
	}

	return nil
}
```

## Migration Testing

Testing migrations prevents the silent breakage that occurs when a migration is valid SQL but destroys data or violates application expectations.

### Test Infrastructure with testcontainers

```go
// db/migrations_test.go
package db_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	_ "github.com/lib/pq"
)

func TestMigrationsUpDown(t *testing.T) {
	ctx := context.Background()

	container, err := tcpostgres.RunContainer(ctx,
		testcontainers.WithImage("postgres:16-alpine"),
		tcpostgres.WithDatabase("testdb"),
		tcpostgres.WithUsername("testuser"),
		tcpostgres.WithPassword("testpass"),
		tcpostgres.WithInitScripts(),
	)
	require.NoError(t, err)
	t.Cleanup(func() { container.Terminate(ctx) })

	connStr, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	db, err := sql.Open("postgres", connStr)
	require.NoError(t, err)
	defer db.Close()

	require.Eventually(t, func() bool {
		return db.PingContext(ctx) == nil
	}, 30*time.Second, 500*time.Millisecond)

	// Run all UP migrations
	m := newMigrator(t, db)
	require.NoError(t, m.Up())

	// Verify schema state
	assertTableExists(t, db, "users")
	assertTableExists(t, db, "posts")
	assertColumnExists(t, db, "users", "email")

	// Get final version
	version, _, err := m.Version()
	require.NoError(t, err)
	t.Logf("Final migration version: %d", version)

	// Roll back all migrations
	require.NoError(t, m.Down())

	// Verify tables are gone
	assertTableNotExists(t, db, "users")
	assertTableNotExists(t, db, "posts")
}

func TestMigrationsIdempotent(t *testing.T) {
	ctx := context.Background()
	// ... (container setup as above)

	m := newMigrator(t, db)
	require.NoError(t, m.Up())

	// Running Up again should be a no-op
	err := m.Up()
	require.ErrorIs(t, err, migrate.ErrNoChange)
}

func newMigrator(t *testing.T, db *sql.DB) *migrate.Migrate {
	t.Helper()
	source, err := iofs.New(MigrationFiles, "migrations")
	require.NoError(t, err)
	driver, err := postgres.WithInstance(db, &postgres.Config{})
	require.NoError(t, err)
	m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
	require.NoError(t, err)
	t.Cleanup(func() { m.Close() })
	return m
}

func assertTableExists(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var exists bool
	err := db.QueryRow(
		`SELECT EXISTS (
			SELECT FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`, table).Scan(&exists)
	require.NoError(t, err)
	require.True(t, exists, "expected table %q to exist", table)
}

func assertTableNotExists(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var exists bool
	err := db.QueryRow(
		`SELECT EXISTS (
			SELECT FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`, table).Scan(&exists)
	require.NoError(t, err)
	require.False(t, exists, "expected table %q to not exist", table)
}

func assertColumnExists(t *testing.T, db *sql.DB, table, column string) {
	t.Helper()
	var exists bool
	err := db.QueryRow(
		`SELECT EXISTS (
			SELECT FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = $1
			  AND column_name = $2
		)`, table, column).Scan(&exists)
	require.NoError(t, err)
	require.True(t, exists, "expected column %q.%q to exist", table, column)
}
```

## Zero-Downtime Schema Change Patterns

### The Expand-Contract Pattern

Never drop a column or rename a column in a single deployment. Use the three-phase expand-contract pattern:

**Phase 1 (Expand): Add new column, keep old column**
```sql
-- 000010_expand_rename_email.up.sql
ALTER TABLE users ADD COLUMN email_address TEXT;

-- Backfill: copy existing data to new column
UPDATE users SET email_address = email WHERE email_address IS NULL;

-- Add constraint after backfill
ALTER TABLE users ALTER COLUMN email_address SET NOT NULL;

-- Create index on new column
CREATE INDEX CONCURRENTLY users_email_address_idx ON users (email_address);
```

Deploy the application version that reads from the new column and writes to both.

**Phase 2 (Deploy): Application reads new column, writes both**

Application code writes to both `email` and `email_address`.

**Phase 3 (Contract): Drop old column**
```sql
-- 000011_contract_remove_email.up.sql
ALTER TABLE users DROP COLUMN email;
```

### Non-Blocking Index Creation

```sql
-- Always use CONCURRENTLY for new indexes on production tables
-- Cannot be run inside a transaction — golang-migrate handles this
-- by setting DisableTransactions on the migration

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    users_created_at_idx ON users (created_at DESC);
```

Mark the migration file to run outside a transaction:

```sql
-- 000012_add_users_created_at_idx.up.sql
-- atlas:nontransactional

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    users_created_at_idx ON users (created_at DESC);
```

### Adding NOT NULL Columns to Large Tables

```sql
-- 000013_add_users_timezone.up.sql
-- Step 1: Add nullable column with default
ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC';

-- Step 2: Backfill in batches to avoid long locks
DO $$
DECLARE
    batch_size INT := 10000;
    last_id    BIGINT := 0;
    max_id     BIGINT;
BEGIN
    SELECT MAX(id) INTO max_id FROM users;
    LOOP
        UPDATE users
        SET timezone = 'UTC'
        WHERE id > last_id
          AND id <= last_id + batch_size
          AND timezone IS NULL;

        last_id := last_id + batch_size;
        EXIT WHEN last_id > max_id;
        PERFORM pg_sleep(0.05); -- brief pause to reduce lock pressure
    END LOOP;
END $$;

-- Step 3: Add NOT NULL constraint (fast on PostgreSQL 12+ with CHECK NOT VALID)
ALTER TABLE users ADD CONSTRAINT users_timezone_not_null
    CHECK (timezone IS NOT NULL) NOT VALID;

-- Validate in background (no lock required)
ALTER TABLE users VALIDATE CONSTRAINT users_timezone_not_null;
```

## CI/CD Integration

### GitHub Actions Pipeline

```yaml
# .github/workflows/db-migrations.yaml
name: Database Migration CI

on:
  pull_request:
    paths:
      - 'db/migrations/**'
      - 'schema.hcl'

jobs:
  validate:
    name: Validate Migrations
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"

      - name: Install Atlas CLI
        run: curl -sSf https://atlasgo.sh | sh

      - name: Install golang-migrate
        run: |
          go install -tags 'postgres' \
            github.com/golang-migrate/migrate/v4/cmd/migrate@latest

      - name: Validate migration directory integrity
        run: |
          atlas migrate validate \
            --dir "file://db/migrations" \
            --dev-url "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"

      - name: Run migrations up
        run: |
          migrate \
            -path ./db/migrations \
            -database "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable" \
            up

      - name: Run migrations down (rollback test)
        run: |
          migrate \
            -path ./db/migrations \
            -database "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable" \
            down -all

      - name: Run migration unit tests
        run: go test ./db/... -v -timeout 120s
        env:
          DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable
```

## Summary

golang-migrate and Atlas address database schema evolution from complementary angles. golang-migrate excels with explicit, auditable SQL files where every migration is hand-crafted and the history is crystal clear. Atlas excels when you want to declare the target schema state and let the tool figure out the diff, especially paired with code-generated schemas from sqlc or ent. In production, the expand-contract pattern eliminates downtime from column renames and removals. `CREATE INDEX CONCURRENTLY` prevents table locks on large tables. Migration testing with testcontainers catches schema regressions before they reach production.
