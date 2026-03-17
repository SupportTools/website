---
title: "Go Database Migrations: golang-migrate, Atlas, and goose — Schema Versioning and Zero-Downtime Migrations"
date: 2028-08-12T00:00:00-05:00
draft: false
tags: ["Go", "Database", "Migrations", "golang-migrate", "Atlas", "PostgreSQL"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Go database migrations using golang-migrate, Atlas, and goose. Covers schema versioning, zero-downtime migrations, rollback strategies, and CI/CD integration with PostgreSQL."
more_link: "yes"
url: "/go-database-migrations-golang-migrate-atlas-guide/"
---

Database migrations are one of the most operationally sensitive parts of running a production service. A bad migration can take down your entire application, corrupt data, or leave your schema in an inconsistent state across replicas. In the Go ecosystem, three tools dominate this space: `golang-migrate`, `Atlas`, and `goose`. Each has different philosophies around schema management, and choosing the wrong one for your scale or workflow can create long-term pain.

This guide walks through all three tools in depth, including zero-downtime migration strategies, rollback handling, and how to wire migrations into CI/CD pipelines safely.

<!--more-->

# [Go Database Migrations: golang-migrate, Atlas, and goose](#go-database-migrations)

## Section 1: Why Migrations Are Hard in Production

Before choosing a tool, it is worth understanding why database migrations cause incidents. The core tension is that your application code and your database schema must be compatible at all times — but during a deployment, you are changing both simultaneously.

The classic failure modes are:

1. **Lock contention**: `ALTER TABLE` on a large table acquires an `AccessExclusiveLock` in PostgreSQL, blocking all reads and writes.
2. **Column rename/drop before code update**: New code references a column that does not exist yet (or old code references a column that was just dropped).
3. **Constraint violations**: Adding a `NOT NULL` constraint to a column that has existing null rows fails immediately.
4. **Index creation timeouts**: Building an index on a 200-million-row table takes 30 minutes while your app waits.
5. **Failed rollback**: Your migration ran half-way and your rollback script is untested.

Zero-downtime migrations require a specific deployment pattern:

```
Phase 1: Deploy migration that adds new columns/tables (backward-compatible)
Phase 2: Deploy new application code that writes to both old and new columns
Phase 3: Backfill existing data to new columns
Phase 4: Deploy application code that reads from new columns only
Phase 5: Deploy migration that drops old columns
```

This is the expand-contract pattern and it is the foundation of safe schema changes.

## Section 2: golang-migrate

`golang-migrate` is the most widely used migration tool in the Go ecosystem. It uses numbered SQL files and a simple up/down model.

### Installation

```bash
# CLI installation
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# As a Go library
go get github.com/golang-migrate/migrate/v4
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/file
```

### Migration File Structure

```
migrations/
  000001_create_users.up.sql
  000001_create_users.down.sql
  000002_add_user_email_index.up.sql
  000002_add_user_email_index.down.sql
  000003_create_sessions.up.sql
  000003_create_sessions.down.sql
```

### Example Migration Files

```sql
-- 000001_create_users.up.sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
CREATE INDEX CONCURRENTLY idx_users_created_at ON users(created_at DESC);
```

```sql
-- 000001_create_users.down.sql
DROP TABLE IF EXISTS users;
```

```sql
-- 000002_add_user_email_index.up.sql
-- Add a partial index for active users only
CREATE INDEX CONCURRENTLY idx_users_active_email
    ON users(email)
    WHERE deleted_at IS NULL;
```

```sql
-- 000002_add_user_email_index.down.sql
DROP INDEX CONCURRENTLY IF EXISTS idx_users_active_email;
```

### Programmatic Usage in Go

```go
package migrations

import (
    "database/sql"
    "fmt"
    "log"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
    _ "github.com/lib/pq"
)

type Config struct {
    DatabaseURL    string
    MigrationsPath string
    LockTimeout    string // e.g., "3s"
}

func RunMigrations(cfg Config) error {
    db, err := sql.Open("postgres", cfg.DatabaseURL)
    if err != nil {
        return fmt.Errorf("opening database: %w", err)
    }
    defer db.Close()

    // Set lock timeout to avoid blocking forever
    if cfg.LockTimeout != "" {
        _, err = db.Exec(fmt.Sprintf("SET lock_timeout = '%s'", cfg.LockTimeout))
        if err != nil {
            return fmt.Errorf("setting lock timeout: %w", err)
        }
    }

    driver, err := postgres.WithInstance(db, &postgres.Config{
        MigrationsTable: "schema_migrations",
        DatabaseName:    "myapp",
    })
    if err != nil {
        return fmt.Errorf("creating postgres driver: %w", err)
    }

    m, err := migrate.NewWithDatabaseInstance(
        fmt.Sprintf("file://%s", cfg.MigrationsPath),
        "postgres",
        driver,
    )
    if err != nil {
        return fmt.Errorf("creating migrator: %w", err)
    }

    m.Log = &migrateLogger{}

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("running migrations: %w", err)
    }

    version, dirty, err := m.Version()
    if err != nil {
        return fmt.Errorf("getting version: %w", err)
    }

    if dirty {
        return fmt.Errorf("database is in dirty state at version %d", version)
    }

    log.Printf("Database migrated to version %d", version)
    return nil
}

type migrateLogger struct{}

func (l *migrateLogger) Printf(format string, v ...interface{}) {
    log.Printf("[migrate] "+format, v...)
}

func (l *migrateLogger) Verbose() bool {
    return true
}
```

### Embedding Migrations in the Binary

```go
package migrations

import (
    "embed"
    "fmt"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
    "database/sql"
)

//go:embed sql/*.sql
var sqlFiles embed.FS

func RunEmbeddedMigrations(db *sql.DB) error {
    sourceDriver, err := iofs.New(sqlFiles, "sql")
    if err != nil {
        return fmt.Errorf("creating iofs source: %w", err)
    }

    dbDriver, err := postgres.WithInstance(db, &postgres.Config{})
    if err != nil {
        return fmt.Errorf("creating postgres driver: %w", err)
    }

    m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", dbDriver)
    if err != nil {
        return fmt.Errorf("creating migrator: %w", err)
    }

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("running migrations: %w", err)
    }

    return nil
}
```

### Dirty State Recovery

When a migration fails mid-run, `golang-migrate` marks the database as dirty. You need to fix the schema manually and then clear the dirty state:

```go
func ForceVersion(db *sql.DB, version int) error {
    driver, err := postgres.WithInstance(db, &postgres.Config{})
    if err != nil {
        return err
    }

    m, err := migrate.NewWithDatabaseInstance(
        "file://migrations",
        "postgres",
        driver,
    )
    if err != nil {
        return err
    }

    // Force version without running migrations (clears dirty state)
    return m.Force(version)
}
```

## Section 3: goose

`goose` supports SQL and Go-based migrations. The Go migration support is its differentiating feature — you can write migration logic in Go when SQL alone is insufficient.

### Installation

```bash
go install github.com/pressly/goose/v3/cmd/goose@latest
go get github.com/pressly/goose/v3
```

### SQL Migrations with goose

```sql
-- 20240812000000_create_products.sql

-- +goose Up
-- +goose StatementBegin
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    sku         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    price_cents BIGINT NOT NULL DEFAULT 0,
    inventory   INTEGER NOT NULL DEFAULT 0,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX CONCURRENTLY idx_products_sku ON products(sku);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS products;
-- +goose StatementEnd
```

### Go-Based Migrations

```go
// 20240812000001_backfill_product_slugs.go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "strings"
    "unicode"

    "github.com/pressly/goose/v3"
)

func init() {
    goose.AddMigrationContext(upBackfillProductSlugs, downBackfillProductSlugs)
}

func upBackfillProductSlugs(ctx context.Context, tx *sql.Tx) error {
    rows, err := tx.QueryContext(ctx, "SELECT id, name FROM products WHERE slug IS NULL")
    if err != nil {
        return fmt.Errorf("querying products: %w", err)
    }
    defer rows.Close()

    type product struct {
        ID   int64
        Name string
    }

    var products []product
    for rows.Next() {
        var p product
        if err := rows.Scan(&p.ID, &p.Name); err != nil {
            return err
        }
        products = append(products, p)
    }

    for _, p := range products {
        slug := toSlug(p.Name)
        _, err := tx.ExecContext(ctx,
            "UPDATE products SET slug = $1 WHERE id = $2",
            slug, p.ID,
        )
        if err != nil {
            return fmt.Errorf("updating product %d: %w", p.ID, err)
        }
    }

    return nil
}

func downBackfillProductSlugs(ctx context.Context, tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, "UPDATE products SET slug = NULL")
    return err
}

func toSlug(s string) string {
    var b strings.Builder
    for _, r := range strings.ToLower(s) {
        if unicode.IsLetter(r) || unicode.IsDigit(r) {
            b.WriteRune(r)
        } else if unicode.IsSpace(r) || r == '-' {
            b.WriteRune('-')
        }
    }
    return strings.Trim(b.String(), "-")
}
```

### Programmatic goose Usage

```go
package db

import (
    "context"
    "database/sql"
    "embed"
    "fmt"
    "log/slog"

    "github.com/pressly/goose/v3"
    _ "github.com/lib/pq"
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

type MigrationRunner struct {
    db     *sql.DB
    logger *slog.Logger
}

func NewMigrationRunner(db *sql.DB, logger *slog.Logger) *MigrationRunner {
    return &MigrationRunner{db: db, logger: logger}
}

func (r *MigrationRunner) Run(ctx context.Context) error {
    goose.SetBaseFS(embedMigrations)

    if err := goose.SetDialect("postgres"); err != nil {
        return fmt.Errorf("setting goose dialect: %w", err)
    }

    // Get current version before migration
    currentVersion, err := goose.GetDBVersion(r.db)
    if err != nil {
        return fmt.Errorf("getting db version: %w", err)
    }
    r.logger.Info("current database version", "version", currentVersion)

    if err := goose.Up(r.db, "migrations"); err != nil {
        return fmt.Errorf("running migrations: %w", err)
    }

    newVersion, err := goose.GetDBVersion(r.db)
    if err != nil {
        return fmt.Errorf("getting new db version: %w", err)
    }
    r.logger.Info("migration complete", "from", currentVersion, "to", newVersion)

    return nil
}

func (r *MigrationRunner) Status(ctx context.Context) error {
    return goose.Status(r.db, "migrations")
}

func (r *MigrationRunner) RollbackOne(ctx context.Context) error {
    return goose.Down(r.db, "migrations")
}
```

## Section 4: Atlas — Declarative Schema Management

Atlas takes a different approach: instead of writing imperative migration scripts, you declare the desired schema state and Atlas generates the migration SQL automatically.

### Installation

```bash
# macOS
brew install ariga/tap/atlas

# Linux
curl -sSf https://atlasgo.sh | sh

# Go package
go get ariga.io/atlas
go get ariga.io/atlas/sql/postgres
go get entgo.io/ent/entc/gen
```

### Declarative Schema Definition

```hcl
# schema.hcl

table "users" {
  schema = schema.public
  column "id" {
    null = false
    type = uuid
    default = sql("gen_random_uuid()")
  }
  column "username" {
    null = false
    type = varchar(255)
  }
  column "email" {
    null = false
    type = varchar(255)
  }
  column "password_hash" {
    null = false
    type = text
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("NOW()")
  }
  column "deleted_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  index "idx_users_email" {
    unique  = true
    columns = [column.email]
    where   = "deleted_at IS NULL"
  }
  index "idx_users_username" {
    unique  = true
    columns = [column.username]
  }
}

table "sessions" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_random_uuid()")
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "token_hash" {
    null = false
    type = text
  }
  column "expires_at" {
    null = false
    type = timestamptz
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("NOW()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "fk_sessions_user" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete   = CASCADE
  }
  index "idx_sessions_user_id" {
    columns = [column.user_id]
  }
  index "idx_sessions_token_hash" {
    unique  = true
    columns = [column.token_hash]
  }
}
```

### Atlas Project Configuration

```yaml
# atlas.yaml
version: "1"
lint:
  destructive:
    error: true  # Fail on destructive changes (DROP TABLE, DROP COLUMN)
  data_depend:
    error: true  # Fail on changes that depend on existing data

env "local" {
  src = "schema.hcl"
  url = "postgres://user:pass@localhost:5432/myapp?sslmode=disable"
  migration {
    dir = "migrations"
  }
}

env "production" {
  src  = "schema.hcl"
  url  = env("DATABASE_URL")
  migration {
    dir     = "migrations"
    format  = atlas
    baseline = "20240101000000"
  }
}
```

### Generating Migrations with Atlas

```bash
# Inspect current schema state
atlas schema inspect -u "postgres://user:pass@localhost:5432/myapp" > current.hcl

# Generate migration from schema diff
atlas migrate diff --env local

# Apply pending migrations
atlas migrate apply --env local

# Dry-run to see what would be applied
atlas migrate apply --env local --dry-run

# Lint migrations for safety issues
atlas migrate lint --env local --latest 3

# Validate migration directory checksum
atlas migrate validate --env local
```

### Atlas in Go Code

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"

    "ariga.io/atlas/sql/postgres"
    "ariga.io/atlas/sql/schema"
    "database/sql"
    _ "github.com/lib/pq"
)

func inspectAndDiff(ctx context.Context, db *sql.DB) error {
    // Open atlas postgres driver
    drv, err := postgres.Open(db)
    if err != nil {
        return fmt.Errorf("opening atlas driver: %w", err)
    }

    // Inspect current schema
    current, err := drv.InspectSchema(ctx, "public", &schema.InspectSchemaOptions{})
    if err != nil {
        return fmt.Errorf("inspecting schema: %w", err)
    }

    for _, t := range current.Tables {
        log.Printf("Table: %s (%d columns)", t.Name, len(t.Columns))
        for _, c := range t.Columns {
            log.Printf("  Column: %s %T", c.Name, c.Type.Type)
        }
    }

    return nil
}

func applyMigration(ctx context.Context, db *sql.DB, targetHCL string) error {
    drv, err := postgres.Open(db)
    if err != nil {
        return err
    }

    // Parse target schema from HCL
    realm := &schema.Realm{}
    if err := drv.UnmarshalSpec([]byte(targetHCL), realm); err != nil {
        return fmt.Errorf("parsing target schema: %w", err)
    }

    // Inspect current state
    current, err := drv.InspectRealm(ctx, nil)
    if err != nil {
        return fmt.Errorf("inspecting current realm: %w", err)
    }

    // Compute changes
    changes, err := drv.RealmDiff(current, realm)
    if err != nil {
        return fmt.Errorf("computing diff: %w", err)
    }

    if len(changes) == 0 {
        log.Println("Schema is up to date")
        return nil
    }

    log.Printf("Applying %d schema changes", len(changes))

    // Apply changes
    return drv.ApplyChanges(ctx, changes)
}
```

## Section 5: Zero-Downtime Migration Patterns

### Pattern 1: Adding a New Column with a Default

**Wrong approach** (locks the table):
```sql
-- This acquires AccessExclusiveLock and blocks all traffic
ALTER TABLE users ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
```

**Correct approach**:
```sql
-- Step 1: Add nullable column (fast, no lock)
ALTER TABLE users ADD COLUMN score INTEGER;

-- Step 2: Set default at the storage level without rewrite
ALTER TABLE users ALTER COLUMN score SET DEFAULT 0;

-- Step 3: Backfill in batches (no table lock)
DO $$
DECLARE
    batch_size  INTEGER := 10000;
    last_id     BIGINT  := 0;
    max_id      BIGINT;
BEGIN
    SELECT MAX(id) INTO max_id FROM users;
    WHILE last_id <= max_id LOOP
        UPDATE users SET score = 0
        WHERE id > last_id
          AND id <= last_id + batch_size
          AND score IS NULL;
        last_id := last_id + batch_size;
        PERFORM pg_sleep(0.01); -- Small pause between batches
    END LOOP;
END $$;

-- Step 4: Add NOT NULL constraint (fast in PG 12+ with valid check)
ALTER TABLE users ADD CONSTRAINT users_score_not_null
    CHECK (score IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_score_not_null;

-- Step 5: In a future migration, replace CHECK with NOT NULL
ALTER TABLE users ALTER COLUMN score SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_score_not_null;
```

### Pattern 2: Renaming a Column

```sql
-- Migration 001: Add new column (backward compatible)
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Application code: write to both username and display_name
-- Backfill: UPDATE users SET display_name = username WHERE display_name IS NULL;

-- Migration 002: (after code is deployed and writing to new column)
-- Drop old column
ALTER TABLE users DROP COLUMN username;
```

### Pattern 3: Safe Index Creation

```sql
-- ALWAYS use CONCURRENTLY for production indexes
-- This does not block reads or writes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user_created
    ON orders(user_id, created_at DESC)
    WHERE status != 'deleted';

-- Drop index safely
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_old_column;
```

### Pattern 4: Table Partitioning Migration

```go
// migration_partitioning.go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "github.com/pressly/goose/v3"
)

func init() {
    goose.AddMigrationContext(upPartitionOrders, downPartitionOrders)
}

func upPartitionOrders(ctx context.Context, tx *sql.Tx) error {
    // Step 1: Create partitioned table
    _, err := tx.ExecContext(ctx, `
        CREATE TABLE orders_partitioned (
            LIKE orders INCLUDING ALL
        ) PARTITION BY RANGE (created_at);
    `)
    if err != nil {
        return fmt.Errorf("creating partitioned table: %w", err)
    }

    // Step 2: Create initial partitions
    now := time.Now()
    for i := 0; i < 3; i++ {
        month := now.AddDate(0, i-1, 0)
        start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
        end := start.AddDate(0, 1, 0)

        partitionName := fmt.Sprintf("orders_%s", start.Format("2006_01"))
        _, err = tx.ExecContext(ctx, fmt.Sprintf(`
            CREATE TABLE %s PARTITION OF orders_partitioned
                FOR VALUES FROM ('%s') TO ('%s');
        `, partitionName, start.Format("2006-01-02"), end.Format("2006-01-02")))
        if err != nil {
            return fmt.Errorf("creating partition %s: %w", partitionName, err)
        }
    }

    return nil
}

func downPartitionOrders(ctx context.Context, tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, "DROP TABLE IF EXISTS orders_partitioned CASCADE")
    return err
}
```

## Section 6: CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/migrate.yml
name: Database Migrations

on:
  push:
    branches: [main]
    paths:
      - 'migrations/**'
  pull_request:
    paths:
      - 'migrations/**'

jobs:
  lint:
    name: Lint Migrations
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Setup Atlas
        uses: ariga/setup-atlas@v0

      - name: Lint migrations
        run: |
          atlas migrate lint \
            --dir "file://migrations" \
            --url "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable" \
            --latest 1

      - name: Validate migration checksum
        run: |
          atlas migrate validate \
            --dir "file://migrations"

  test-apply:
    name: Test Migration Apply
    runs-on: ubuntu-latest
    needs: lint
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23'

      - name: Run migrations
        env:
          DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable
        run: go run ./cmd/migrate/main.go

      - name: Test rollback
        env:
          DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable
        run: go run ./cmd/migrate/main.go rollback

  deploy-staging:
    name: Apply to Staging
    runs-on: ubuntu-latest
    needs: test-apply
    if: github.ref == 'refs/heads/main'
    environment: staging
    steps:
      - uses: actions/checkout@v4

      - name: Setup Atlas
        uses: ariga/setup-atlas@v0

      - name: Apply migrations to staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
        run: |
          atlas migrate apply \
            --dir "file://migrations" \
            --url "${DATABASE_URL}" \
            --allow-dirty
```

### Migration CLI Tool

```go
// cmd/migrate/main.go
package main

import (
    "context"
    "flag"
    "fmt"
    "log/slog"
    "os"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
    "database/sql"
    _ "github.com/lib/pq"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelDebug,
    }))

    cmd := flag.String("cmd", "up", "Migration command: up, down, status, force")
    version := flag.Int("version", -1, "Target version for force command")
    steps := flag.Int("steps", 1, "Number of steps for up/down")
    flag.Parse()

    dbURL := os.Getenv("DATABASE_URL")
    if dbURL == "" {
        logger.Error("DATABASE_URL environment variable is required")
        os.Exit(1)
    }

    db, err := sql.Open("postgres", dbURL)
    if err != nil {
        logger.Error("failed to open database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    if err := db.Ping(); err != nil {
        logger.Error("failed to ping database", "error", err)
        os.Exit(1)
    }

    driver, err := postgres.WithInstance(db, &postgres.Config{
        MigrationsTable: "schema_migrations",
    })
    if err != nil {
        logger.Error("failed to create driver", "error", err)
        os.Exit(1)
    }

    m, err := migrate.NewWithDatabaseInstance("file://migrations", "postgres", driver)
    if err != nil {
        logger.Error("failed to create migrator", "error", err)
        os.Exit(1)
    }
    m.Log = &slogMigrateLogger{logger: logger}

    ctx := context.Background()
    _ = ctx

    switch *cmd {
    case "up":
        if *steps > 0 {
            err = m.Steps(*steps)
        } else {
            err = m.Up()
        }
        if err == migrate.ErrNoChange {
            logger.Info("no migrations to apply")
            return
        }

    case "down":
        err = m.Steps(-*steps)

    case "rollback":
        err = m.Steps(-1)

    case "force":
        if *version < 0 {
            logger.Error("version flag required for force command")
            os.Exit(1)
        }
        err = m.Force(*version)

    case "status":
        version, dirty, verErr := m.Version()
        if verErr != nil {
            logger.Error("failed to get version", "error", verErr)
            os.Exit(1)
        }
        logger.Info("migration status", "version", version, "dirty", dirty)
        return

    default:
        logger.Error("unknown command", "cmd", *cmd)
        os.Exit(1)
    }

    if err != nil {
        logger.Error("migration failed", "cmd", *cmd, "error", err)
        os.Exit(1)
    }

    version, dirty, _ := m.Version()
    logger.Info("migration complete",
        "cmd", *cmd,
        "version", version,
        "dirty", dirty,
    )
}

type slogMigrateLogger struct {
    logger *slog.Logger
}

func (l *slogMigrateLogger) Printf(format string, v ...interface{}) {
    l.logger.Debug(fmt.Sprintf(format, v...))
}

func (l *slogMigrateLogger) Verbose() bool { return true }
```

## Section 7: Testing Migrations

### Integration Tests with testcontainers

```go
// migrations_test.go
package migrations_test

import (
    "context"
    "testing"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
    "database/sql"
    _ "github.com/lib/pq"
)

func TestMigrationsApplyAndRollback(t *testing.T) {
    ctx := context.Background()

    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpass"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2),
        ),
    )
    if err != nil {
        t.Fatalf("starting postgres container: %v", err)
    }
    defer pgContainer.Terminate(ctx)

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("getting connection string: %v", err)
    }

    db, err := sql.Open("postgres", connStr)
    if err != nil {
        t.Fatalf("opening database: %v", err)
    }
    defer db.Close()

    t.Run("apply all migrations", func(t *testing.T) {
        if err := RunMigrations(Config{
            DatabaseURL:    connStr,
            MigrationsPath: "../../migrations",
        }); err != nil {
            t.Fatalf("applying migrations: %v", err)
        }
    })

    t.Run("schema has expected tables", func(t *testing.T) {
        tables := []string{"users", "sessions", "products"}
        for _, table := range tables {
            var exists bool
            err := db.QueryRowContext(ctx, `
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'public'
                    AND table_name = $1
                )
            `, table).Scan(&exists)
            if err != nil {
                t.Fatalf("checking table %s: %v", table, err)
            }
            if !exists {
                t.Errorf("expected table %s to exist", table)
            }
        }
    })

    t.Run("idempotent apply", func(t *testing.T) {
        // Running migrations again should be a no-op
        if err := RunMigrations(Config{
            DatabaseURL:    connStr,
            MigrationsPath: "../../migrations",
        }); err != nil {
            t.Fatalf("second apply failed: %v", err)
        }
    })
}
```

## Section 8: Choosing the Right Tool

| Feature | golang-migrate | goose | Atlas |
|---|---|---|---|
| SQL migrations | Yes | Yes | Generated |
| Go migrations | No | Yes | No |
| Declarative schema | No | No | Yes |
| Auto-diff generation | No | No | Yes |
| Embedded migrations | Yes | Yes | Yes |
| Lint/safety checks | No | No | Yes |
| Rollback support | Yes | Yes | Yes |
| Lock timeout | Manual SQL | Manual SQL | Configurable |
| Best for | Simple apps | Complex logic | Schema-first |

**Recommendation matrix:**

- Use **golang-migrate** if you want the simplest possible setup and your migrations are pure SQL.
- Use **goose** if you need to run Go code during migrations (data transformations, API calls, complex backfills).
- Use **Atlas** if you work schema-first, want automatic diff generation, and want linting to catch destructive changes before they hit production.

For most production services, combining Atlas for schema linting in CI with golang-migrate for actual execution provides the best balance of safety and simplicity.

## Conclusion

Database migrations require careful thought about locking, deployment ordering, and rollback procedures. The expand-contract pattern is the foundation of zero-downtime migrations. Pair it with `CREATE INDEX CONCURRENTLY`, batch backfills, and `NOT VALID` constraints to avoid lock contention on large tables.

Embed your migrations in your binary so they are versioned alongside your code. Always test migrations in CI against a real Postgres instance using testcontainers. And never deploy a migration that drops a column on the same day you deploy code that stops reading it — give it at least one full deployment cycle.
