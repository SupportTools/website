---
title: "Go Database Migration: golang-migrate, Atlas, and Schema-First Development"
date: 2031-05-10T00:00:00-05:00
draft: false
tags: ["Go", "Database", "Migrations", "golang-migrate", "Atlas", "PostgreSQL", "DevOps"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go database migrations covering golang-migrate for SQL files, Atlas declarative schema management, migration testing, rollback strategies, zero-downtime expand-contract patterns, and CI enforcement."
more_link: "yes"
url: "/go-database-migration-golang-migrate-atlas-schema-first/"
---

Database migrations are the most dangerous routine operation in application lifecycle management. Unlike stateless application upgrades, a botched migration can destroy data, bring down production, or leave your schema in an inconsistent state that requires hours of manual recovery. Go projects have traditionally relied on hand-rolled migration runners or heavy ORM tools, but the ecosystem has matured significantly. golang-migrate provides battle-tested SQL file management, while Atlas brings declarative schema-first development with drift detection and automatic migration generation.

This guide covers both tools in depth, including migration testing with ephemeral databases, safe rollback strategies, zero-downtime patterns, and automated CI enforcement to prevent schema drift from reaching production.

<!--more-->

# Go Database Migration: golang-migrate, Atlas, and Schema-First Development

## Section 1: golang-migrate Foundations

golang-migrate is a minimal, reliable migration runner that manages versioned SQL files. It supports 40+ database drivers, works from CLI and as a Go library, and uses a simple version table to track applied migrations.

### 1.1 Installation and Setup

```bash
# Install the CLI
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# Verify installation
migrate -version

# For multiple database support
go install -tags 'postgres mysql sqlite3' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
```

Add to your Go module:

```bash
go get github.com/golang-migrate/migrate/v4
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/file
```

### 1.2 Migration File Structure

golang-migrate uses numbered SQL files with up/down variants:

```
db/migrations/
├── 000001_create_users_table.up.sql
├── 000001_create_users_table.down.sql
├── 000002_add_user_roles.up.sql
├── 000002_add_user_roles.down.sql
├── 000003_create_orders_table.up.sql
├── 000003_create_orders_table.down.sql
└── 000004_add_order_indexes.up.sql
    000004_add_order_indexes.down.sql
```

```sql
-- 000001_create_users_table.up.sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL UNIQUE,
    username    TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NULL;

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();
```

```sql
-- 000001_create_users_table.down.sql
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS users;
```

```sql
-- 000002_add_user_roles.up.sql
CREATE TYPE user_role AS ENUM ('admin', 'user', 'viewer');

ALTER TABLE users
    ADD COLUMN role user_role NOT NULL DEFAULT 'user',
    ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN verified_at TIMESTAMPTZ;

CREATE INDEX idx_users_role ON users(role);
```

```sql
-- 000002_add_user_roles.down.sql
ALTER TABLE users
    DROP COLUMN IF EXISTS role,
    DROP COLUMN IF EXISTS is_verified,
    DROP COLUMN IF EXISTS verified_at;

DROP TYPE IF EXISTS user_role;
```

### 1.3 Running Migrations from CLI

```bash
# Database URL format
export DATABASE_URL="postgres://user:password@localhost:5432/mydb?sslmode=disable"

# Apply all pending migrations
migrate -path db/migrations -database "$DATABASE_URL" up

# Apply exactly N migrations
migrate -path db/migrations -database "$DATABASE_URL" up 2

# Roll back N migrations
migrate -path db/migrations -database "$DATABASE_URL" down 1

# Roll back all migrations
migrate -path db/migrations -database "$DATABASE_URL" down

# Check current version
migrate -path db/migrations -database "$DATABASE_URL" version

# Force a version (use after manually fixing dirty state)
migrate -path db/migrations -database "$DATABASE_URL" force 3

# Check migration status
migrate -path db/migrations -database "$DATABASE_URL" status
```

### 1.4 Go Library Integration

Embed migrations in your application binary and run them at startup:

```go
// internal/database/migrate.go
package database

import (
    "embed"
    "fmt"
    "log/slog"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
    "github.com/jmoiron/sqlx"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type MigrationConfig struct {
    // LockTimeout for acquiring the advisory lock
    LockTimeout int
    // StatementTimeout for individual migration statements
    StatementTimeout int
}

func RunMigrations(db *sqlx.DB, cfg MigrationConfig) error {
    driver, err := postgres.WithInstance(db.DB, &postgres.Config{
        MigrationsTable:       "schema_migrations",
        MultiStatementEnabled: true,
        MultiStatementMaxSize: 10 * 1024 * 1024, // 10MB
    })
    if err != nil {
        return fmt.Errorf("creating postgres driver: %w", err)
    }

    source, err := iofs.New(migrationFiles, "migrations")
    if err != nil {
        return fmt.Errorf("creating migration source: %w", err)
    }

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    if err != nil {
        return fmt.Errorf("creating migrator: %w", err)
    }
    defer m.Close()

    // Log migration version before and after
    versionBefore, dirty, err := m.Version()
    if err != nil && err != migrate.ErrNilVersion {
        return fmt.Errorf("checking current version: %w", err)
    }

    if dirty {
        return fmt.Errorf("database is in dirty state at version %d, manual intervention required", versionBefore)
    }

    slog.Info("starting database migrations", "current_version", versionBefore)

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("running migrations: %w", err)
    }

    versionAfter, _, _ := m.Version()
    if versionAfter != versionBefore {
        slog.Info("migrations applied successfully",
            "from_version", versionBefore,
            "to_version", versionAfter)
    } else {
        slog.Info("database schema is up to date", "version", versionAfter)
    }

    return nil
}

// RollbackN rolls back exactly N migrations (for testing and CI)
func RollbackN(db *sqlx.DB, n int) error {
    driver, err := postgres.WithInstance(db.DB, &postgres.Config{
        MigrationsTable: "schema_migrations",
    })
    if err != nil {
        return fmt.Errorf("creating postgres driver: %w", err)
    }

    source, err := iofs.New(migrationFiles, "migrations")
    if err != nil {
        return fmt.Errorf("creating migration source: %w", err)
    }

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    if err != nil {
        return fmt.Errorf("creating migrator: %w", err)
    }
    defer m.Close()

    return m.Steps(-n)
}
```

## Section 2: Atlas for Declarative Schema Management

Atlas takes a fundamentally different approach from golang-migrate. Instead of writing migration files manually, you define the desired schema state and Atlas computes the migration diff automatically.

### 2.1 Installation

```bash
# Install Atlas CLI
curl -sSf https://atlasgo.sh | sh

# Or via Homebrew
brew install ariga/tap/atlas

# Verify
atlas version
```

Add the Go library:

```bash
go get ariga.io/atlas
go get ariga.io/atlas-go-sdk
go get entgo.io/ent/dialect/sql/schema   # Optional: for Ent integration
```

### 2.2 Atlas Project Structure

```
db/
├── schema.hcl          # Desired schema state (HCL format)
├── schema.sql          # Alternative: desired state in SQL
├── migrations/         # Generated migration files
│   ├── atlas.sum       # Integrity checksum
│   ├── 20310101000001.sql
│   └── 20310201000001.sql
└── atlas.hcl           # Atlas project configuration
```

### 2.3 Schema Definition in HCL

```hcl
# db/schema.hcl
variable "tenant" {
  type    = string
  default = "public"
}

schema "public" {}

table "users" {
  schema = schema.public
  column "id" {
    null    = false
    type    = uuid
    default = sql("gen_random_uuid()")
  }
  column "email" {
    null = false
    type = text
  }
  column "username" {
    null = false
    type = text
  }
  column "password_hash" {
    null = false
    type = text
  }
  column "role" {
    null    = false
    type    = enum.user_role
    default = "user"
  }
  column "is_verified" {
    null    = false
    type    = boolean
    default = false
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  index "idx_users_email" {
    unique  = true
    columns = [column.email]
  }
  index "idx_users_role" {
    columns = [column.role]
  }
}

table "orders" {
  schema = schema.public
  column "id" {
    null    = false
    type    = bigserial
  }
  column "user_id" {
    null = false
    type = uuid
  }
  column "status" {
    null    = false
    type    = enum.order_status
    default = "pending"
  }
  column "total_cents" {
    null = false
    type = bigint
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "fk_orders_user" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete   = NO_ACTION
    on_update   = NO_ACTION
  }
  index "idx_orders_user_id" {
    columns = [column.user_id]
  }
  index "idx_orders_status" {
    columns = [column.status]
  }
}

enum "user_role" {
  schema = schema.public
  values = ["admin", "user", "viewer"]
}

enum "order_status" {
  schema = schema.public
  values = ["pending", "processing", "completed", "cancelled"]
}
```

### 2.4 Atlas Project Configuration

```hcl
# db/atlas.hcl
env "local" {
  src = "file://db/schema.hcl"
  url = "postgres://postgres:password@localhost:5432/mydb?sslmode=disable"
  dev = "docker://postgres/16/dev"
  migration {
    dir = "file://db/migrations"
  }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}

env "ci" {
  src = "file://db/schema.hcl"
  url = getenv("DATABASE_URL")
  dev = "docker://postgres/16/dev"
  migration {
    dir = "file://db/migrations"
  }
}

env "production" {
  src = "file://db/schema.hcl"
  url = getenv("DATABASE_URL")
  migration {
    dir    = "file://db/migrations"
    format = golang-migrate
  }
}
```

### 2.5 Atlas Workflow

```bash
# Inspect current database schema
atlas schema inspect --env local --format '{{ hcl . }}'

# Dry run: see what changes would be made
atlas schema diff \
  --from "postgres://postgres:password@localhost:5432/mydb?sslmode=disable" \
  --to "file://db/schema.hcl" \
  --dev-url "docker://postgres/16/dev"

# Apply schema directly (development only)
atlas schema apply --env local

# Generate a versioned migration file (recommended for production)
atlas migrate diff add_profile_columns \
  --env local

# This creates: db/migrations/20310101120000_add_profile_columns.sql
# With content like:
# -- Modify "users" table
# ALTER TABLE "public"."users" ADD COLUMN "bio" text NULL,
#   ADD COLUMN "avatar_url" text NULL;

# Validate migration files integrity
atlas migrate validate --env local

# Apply pending migrations to a database
atlas migrate apply --env local

# Check migration status
atlas migrate status --env local
```

### 2.6 Atlas Go SDK Integration

```go
// internal/database/atlas_migrate.go
package database

import (
    "context"
    "embed"
    "fmt"
    "log/slog"

    "ariga.io/atlas-go-sdk/atlasexec"
)

//go:embed migrations
var migrationsDir embed.FS

type AtlasMigrator struct {
    workdir *atlasexec.WorkingDir
    client  *atlasexec.Client
}

func NewAtlasMigrator(databaseURL string) (*AtlasMigrator, error) {
    // Write embedded migrations to a temp directory
    workdir, err := atlasexec.NewWorkingDir(
        atlasexec.WithMigrations(migrationsDir, "migrations"),
    )
    if err != nil {
        return nil, fmt.Errorf("creating atlas working dir: %w", err)
    }

    client, err := atlasexec.NewClient(workdir.Path(), "atlas")
    if err != nil {
        return nil, fmt.Errorf("creating atlas client: %w", err)
    }

    return &AtlasMigrator{workdir: workdir, client: client}, nil
}

func (m *AtlasMigrator) Close() {
    m.workdir.Close()
}

func (m *AtlasMigrator) Apply(ctx context.Context, databaseURL string) error {
    res, err := m.client.MigrateApply(ctx, &atlasexec.MigrateApplyParams{
        URL: databaseURL,
    })
    if err != nil {
        return fmt.Errorf("applying migrations: %w", err)
    }

    for _, applied := range res.Applied {
        slog.Info("applied migration",
            "version", applied.Version,
            "description", applied.Description,
            "duration_ms", applied.ExecutionTime.Milliseconds())
    }

    if len(res.Applied) == 0 {
        slog.Info("no pending migrations")
    }

    return nil
}

func (m *AtlasMigrator) Status(ctx context.Context, databaseURL string) (*atlasexec.MigrateStatusReport, error) {
    return m.client.MigrateStatus(ctx, &atlasexec.MigrateStatusParams{
        URL: databaseURL,
    })
}

func (m *AtlasMigrator) Lint(ctx context.Context) error {
    res, err := m.client.MigrateLint(ctx, &atlasexec.MigrateLintParams{
        Latest: 1,
    })
    if err != nil {
        return fmt.Errorf("linting migrations: %w", err)
    }

    for _, report := range res.Files {
        for _, diag := range report.Reports {
            for _, d := range diag.Diagnostics {
                slog.Warn("migration lint warning",
                    "file", report.Name,
                    "code", d.Code,
                    "message", d.Text)
            }
        }
    }

    return nil
}
```

## Section 3: Migration Testing

### 3.1 Test Database Setup with Testcontainers

```go
// internal/database/testdb_test.go
package database_test

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
    "time"

    "github.com/stretchr/testify/require"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
    _ "github.com/lib/pq"
)

type TestDB struct {
    Container testcontainers.Container
    DSN       string
    DB        *sql.DB
}

func NewTestDB(t *testing.T) *TestDB {
    t.Helper()
    ctx := context.Background()

    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpass"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(30*time.Second),
        ),
    )
    require.NoError(t, err)

    t.Cleanup(func() {
        if err := pgContainer.Terminate(ctx); err != nil {
            t.Logf("failed to terminate test container: %v", err)
        }
    })

    dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    require.NoError(t, err)

    db, err := sql.Open("postgres", dsn)
    require.NoError(t, err)

    t.Cleanup(func() { db.Close() })

    require.NoError(t, db.PingContext(ctx))

    return &TestDB{
        Container: pgContainer,
        DSN:       dsn,
        DB:        db,
    }
}
```

### 3.2 Migration Up/Down Test

```go
// internal/database/migrations_test.go
package database_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"

    "myapp/internal/database"
)

func TestMigrations_UpDown(t *testing.T) {
    tdb := NewTestDB(t)

    source, err := iofs.New(database.MigrationFiles, "migrations")
    require.NoError(t, err)

    driver, err := postgres.WithInstance(tdb.DB, &postgres.Config{})
    require.NoError(t, err)

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    require.NoError(t, err)
    defer m.Close()

    // Apply all migrations
    err = m.Up()
    require.NoError(t, err, "applying all migrations should succeed")

    // Verify schema exists
    verifySchema(t, tdb.DB)

    // Roll back all migrations one by one
    version, _, _ := m.Version()
    for i := int(version); i > 0; i-- {
        err = m.Steps(-1)
        require.NoErrorf(t, err, "rolling back step %d should succeed", i)
    }

    // Verify we're back to a clean state
    version, _, _ = m.Version()
    assert.Equal(t, uint(0), version, "should be at version 0 after full rollback")

    // Apply again to ensure idempotency
    err = m.Up()
    require.NoError(t, err, "re-applying all migrations should succeed")
}

func TestMigrations_EachStep(t *testing.T) {
    tdb := NewTestDB(t)

    source, err := iofs.New(database.MigrationFiles, "migrations")
    require.NoError(t, err)

    driver, err := postgres.WithInstance(tdb.DB, &postgres.Config{})
    require.NoError(t, err)

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    require.NoError(t, err)
    defer m.Close()

    // Apply and test each migration step
    stepTests := []struct {
        name   string
        verify func(t *testing.T)
    }{
        {
            name: "create users table",
            verify: func(t *testing.T) {
                var count int
                err := tdb.DB.QueryRowContext(context.Background(),
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'users'",
                ).Scan(&count)
                require.NoError(t, err)
                assert.Equal(t, 1, count, "users table should exist")
            },
        },
        {
            name: "add user roles",
            verify: func(t *testing.T) {
                var count int
                err := tdb.DB.QueryRowContext(context.Background(),
                    "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'",
                ).Scan(&count)
                require.NoError(t, err)
                assert.Equal(t, 1, count, "role column should exist")
            },
        },
        {
            name: "create orders table",
            verify: func(t *testing.T) {
                var count int
                err := tdb.DB.QueryRowContext(context.Background(),
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'orders'",
                ).Scan(&count)
                require.NoError(t, err)
                assert.Equal(t, 1, count, "orders table should exist")
            },
        },
    }

    for i, test := range stepTests {
        t.Run(test.name, func(t *testing.T) {
            err := m.Steps(1)
            require.NoErrorf(t, err, "step %d should apply cleanly", i+1)
            test.verify(t)
        })
    }
}

func verifySchema(t *testing.T, db *sql.DB) {
    t.Helper()
    tables := []string{"users", "orders"}
    for _, table := range tables {
        var exists bool
        err := db.QueryRowContext(context.Background(),
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)", table,
        ).Scan(&exists)
        require.NoError(t, err)
        assert.Truef(t, exists, "table %s should exist", table)
    }
}
```

### 3.3 Atlas Migration Lint Test

```go
// internal/database/atlas_lint_test.go
package database_test

import (
    "context"
    "os/exec"
    "strings"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestAtlasMigrations_Lint(t *testing.T) {
    if _, err := exec.LookPath("atlas"); err != nil {
        t.Skip("atlas CLI not installed")
    }

    tdb := NewTestDB(t)

    // Run atlas migrate lint against the test database
    cmd := exec.CommandContext(context.Background(),
        "atlas", "migrate", "lint",
        "--dir", "file://../../db/migrations",
        "--dev-url", tdb.DSN,
        "--latest", "1",
    )
    out, err := cmd.CombinedOutput()
    if err != nil {
        t.Logf("atlas lint output:\n%s", string(out))
        require.NoError(t, err, "atlas migrate lint should pass")
    }
}

func TestAtlasMigrations_NoDestructiveChanges(t *testing.T) {
    if _, err := exec.LookPath("atlas"); err != nil {
        t.Skip("atlas CLI not installed")
    }

    tdb := NewTestDB(t)

    // Apply all migrations
    applyCmd := exec.CommandContext(context.Background(),
        "atlas", "migrate", "apply",
        "--dir", "file://../../db/migrations",
        "--url", tdb.DSN,
    )
    out, err := applyCmd.CombinedOutput()
    require.NoError(t, err, "should apply all migrations: %s", string(out))

    // Lint with destructive check
    lintCmd := exec.CommandContext(context.Background(),
        "atlas", "migrate", "lint",
        "--dir", "file://../../db/migrations",
        "--dev-url", tdb.DSN,
        "--format", "{{ range .Files }}{{ range .Reports }}{{ range .Diagnostics }}{{ .Code }}: {{ .Text }}\n{{ end }}{{ end }}{{ end }}",
        "--latest", "10",
    )
    out, err = lintCmd.CombinedOutput()
    output := string(out)

    // Fail if destructive diagnostics are present
    destructiveCodes := []string{"DS101", "DS102", "DS103"}
    for _, code := range destructiveCodes {
        if strings.Contains(output, code) {
            t.Fatalf("destructive schema change detected: %s", output)
        }
    }
}
```

## Section 4: Rollback Strategies

### 4.1 The Dirty State Problem

golang-migrate marks a migration version as "dirty" if it fails partway through. This requires manual intervention:

```bash
# Check if database is dirty
migrate -path db/migrations -database "$DATABASE_URL" version
# 3 (dirty)

# The failed migration was version 4. Manually fix and then:
# Option 1: Force to last good version and re-run
migrate -path db/migrations -database "$DATABASE_URL" force 3
migrate -path db/migrations -database "$DATABASE_URL" up

# Option 2: If the migration partially applied, manually undo it
psql "$DATABASE_URL" -c "DROP TABLE IF EXISTS problematic_table;"
migrate -path db/migrations -database "$DATABASE_URL" force 3
```

### 4.2 Using Transactions for Safe Rollback

Wrap migrations in transactions when possible:

```sql
-- 000005_add_complex_feature.up.sql
BEGIN;

CREATE TABLE feature_flags (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    enabled  BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB
);

ALTER TABLE users ADD COLUMN feature_flags_override JSONB;

CREATE INDEX idx_feature_flags_name ON feature_flags(name);

COMMIT;
```

```sql
-- 000005_add_complex_feature.down.sql
BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS feature_flags_override;
DROP TABLE IF EXISTS feature_flags;

COMMIT;
```

### 4.3 Point-in-Time Recovery as Ultimate Rollback

For critical production migrations, take a database snapshot before applying:

```bash
#!/bin/bash
# pre-migration-snapshot.sh
set -euo pipefail

DB_NAME="${1:-mydb}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_FILE="snapshots/${DB_NAME}_pre_migration_${TIMESTAMP}.dump"

mkdir -p snapshots

echo "Creating pre-migration snapshot: $SNAPSHOT_FILE"
pg_dump \
  --format=custom \
  --compress=9 \
  --jobs=4 \
  "$DATABASE_URL" \
  --file="$SNAPSHOT_FILE"

echo "Snapshot created: $SNAPSHOT_FILE ($(du -sh "$SNAPSHOT_FILE" | cut -f1))"

# Store snapshot location for rollback reference
echo "$SNAPSHOT_FILE" > snapshots/latest_pre_migration.txt
```

```bash
#!/bin/bash
# rollback-from-snapshot.sh
set -euo pipefail

SNAPSHOT_FILE=$(cat snapshots/latest_pre_migration.txt)
echo "WARNING: This will DESTROY all data since $SNAPSHOT_FILE was taken!"
read -rp "Type 'CONFIRM ROLLBACK' to proceed: " confirm

if [ "$confirm" != "CONFIRM ROLLBACK" ]; then
    echo "Rollback cancelled."
    exit 1
fi

pg_restore \
  --clean \
  --if-exists \
  --jobs=4 \
  --dbname="$DATABASE_URL" \
  "$SNAPSHOT_FILE"

echo "Rollback complete from $SNAPSHOT_FILE"
```

## Section 5: Zero-Downtime Expand-Contract Pattern

The expand-contract (also called parallel-change) pattern ensures backward compatibility across deployments.

### 5.1 The Problem with Direct Column Renames

A direct column rename is an atomic breaking change — the old application code can't read the new column name:

```sql
-- DO NOT DO THIS for zero-downtime deployments
ALTER TABLE users RENAME COLUMN username TO user_handle;
```

Instead, use expand-contract:

```
Phase 1: EXPAND    - Add new column (both old and new code work)
Phase 2: MIGRATE   - Backfill data from old to new column
Phase 3: SWITCH    - Deploy new code that uses new column
Phase 4: CONTRACT  - Drop old column (after verifying new code works)
```

### 5.2 Implementing Expand-Contract

**Step 1 (Expand): Add the new column**

```sql
-- 000010_expand_rename_username.up.sql
-- Phase 1: EXPAND - Add new column alongside old
ALTER TABLE users ADD COLUMN user_handle TEXT;

-- Create index on new column (CONCURRENTLY to avoid lock)
CREATE INDEX CONCURRENTLY idx_users_user_handle ON users(user_handle);
```

**Step 2 (Migrate): Backfill with batched updates**

```go
// cmd/migrate-username/main.go
// Run as a background job after the EXPAND migration

package main

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"

    _ "github.com/lib/pq"
)

func main() {
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        slog.Error("failed to open database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    if err := backfillUserHandle(context.Background(), db); err != nil {
        slog.Error("backfill failed", "error", err)
        os.Exit(1)
    }
}

func backfillUserHandle(ctx context.Context, db *sql.DB) error {
    const batchSize = 1000
    const sleepBetweenBatches = 100 * time.Millisecond

    for {
        result, err := db.ExecContext(ctx, `
            UPDATE users SET user_handle = username
            WHERE user_handle IS NULL
            AND id IN (
                SELECT id FROM users
                WHERE user_handle IS NULL
                ORDER BY id
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
        `, batchSize)
        if err != nil {
            return fmt.Errorf("batch update: %w", err)
        }

        rowsAffected, _ := result.RowsAffected()
        if rowsAffected == 0 {
            slog.Info("backfill complete")
            return nil
        }

        slog.Info("batch backfilled", "rows", rowsAffected)
        time.Sleep(sleepBetweenBatches)
    }
}
```

**Step 3 (Switch): Deploy new application code**

Deploy the application version that reads `user_handle` instead of `username`. Both columns exist so rollback is still possible.

**Step 4 (Contract): Add NOT NULL constraint and drop old column**

```sql
-- 000011_contract_rename_username.up.sql
-- Phase 4: CONTRACT - after new code is verified
-- First add NOT NULL constraint with existing data validated
ALTER TABLE users ALTER COLUMN user_handle SET NOT NULL;

-- Add unique constraint (also CONCURRENTLY if table is large)
ALTER TABLE users ADD CONSTRAINT users_user_handle_unique UNIQUE (user_handle);

-- Remove old column
ALTER TABLE users DROP COLUMN username;

-- Drop old index (it was on username which no longer exists)
DROP INDEX IF EXISTS idx_users_username;
```

```sql
-- 000011_contract_rename_username.down.sql
-- Restore old column for emergency rollback
ALTER TABLE users ADD COLUMN username TEXT;
UPDATE users SET username = user_handle;
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
CREATE INDEX idx_users_username ON users(username);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_handle_unique;
ALTER TABLE users ALTER COLUMN user_handle DROP NOT NULL;
```

### 5.3 Online Index Creation

For large tables, create indexes concurrently to avoid locking:

```sql
-- Standard CREATE INDEX takes an exclusive lock (blocks all reads/writes)
-- Use CONCURRENTLY for zero-downtime (takes longer but non-blocking)

-- 000012_add_orders_indexes.up.sql
-- These run non-blocking
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created_at
  ON orders(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at DESC)
  WHERE status IN ('pending', 'processing');
```

Note: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Keep these in separate migration files or ensure `MultiStatementEnabled` handles them correctly.

## Section 6: CI Pipeline Enforcement

### 6.1 GitHub Actions Workflow

```yaml
# .github/workflows/db-migrations.yml
name: Database Migration Checks

on:
  pull_request:
    paths:
      - 'db/migrations/**'
      - 'db/schema.hcl'

jobs:
  migration-lint:
    name: Lint Migrations
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
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

      - name: Install Atlas
        run: |
          curl -sSf https://atlasgo.sh | sh
          echo "$HOME/.atlas/bin" >> "$GITHUB_PATH"

      - name: Validate migration files integrity
        run: |
          atlas migrate validate \
            --dir "file://db/migrations" \
            --dev-url "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"

      - name: Lint for destructive changes
        run: |
          atlas migrate lint \
            --dir "file://db/migrations" \
            --dev-url "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable" \
            --latest 5 \
            --format "{{ range .Files }}{{ range .Reports }}{{ range .Diagnostics }}::error file={{ $.Name }},title=Atlas Lint::{{ .Code }}: {{ .Text }}\n{{ end }}{{ end }}{{ end }}"

      - name: Apply all migrations
        env:
          DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: |
          go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
          migrate -path db/migrations -database "$DATABASE_URL" up

      - name: Test rollback of last migration
        env:
          DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: |
          # Rollback the newest migration
          migrate -path db/migrations -database "$DATABASE_URL" down 1
          # Re-apply to ensure idempotency
          migrate -path db/migrations -database "$DATABASE_URL" up

      - name: Run migration tests
        env:
          DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: go test ./internal/database/... -v -run TestMigration

  schema-drift-check:
    name: Schema Drift Detection
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: driftcheck
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
        ports:
          - 5433:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Install Atlas
        run: |
          curl -sSf https://atlasgo.sh | sh
          echo "$HOME/.atlas/bin" >> "$GITHUB_PATH"

      - name: Apply migrations
        run: |
          go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
          migrate -path db/migrations \
            -database "postgres://testuser:testpass@localhost:5433/driftcheck?sslmode=disable" up

      - name: Check schema drift (migrations vs HCL schema)
        run: |
          atlas schema diff \
            --from "postgres://testuser:testpass@localhost:5433/driftcheck?sslmode=disable" \
            --to "file://db/schema.hcl" \
            --dev-url "docker://postgres/16/dev" \
            --format '{{ if . }}Schema drift detected:\n{{ sql . }}\n{{ end }}' \
            | tee drift_report.txt

          if [ -s drift_report.txt ]; then
            echo "::error::Schema drift detected between migrations and schema.hcl"
            cat drift_report.txt
            exit 1
          fi
```

### 6.2 Pre-commit Hook for Migration Validation

```bash
#!/bin/bash
# .git/hooks/pre-commit (or managed via pre-commit framework)
# Install: cp hooks/pre-migration-check .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -euo pipefail

MIGRATION_DIR="db/migrations"

# Check if any migration files are being committed
CHANGED_MIGRATIONS=$(git diff --cached --name-only | grep "^${MIGRATION_DIR}/" || true)

if [ -z "$CHANGED_MIGRATIONS" ]; then
    exit 0
fi

echo "Migration files changed, running validation..."

# Check that new migration files follow naming convention
echo "$CHANGED_MIGRATIONS" | grep -E "\.sql$" | while read file; do
    filename=$(basename "$file")
    if ! echo "$filename" | grep -qE '^[0-9]{6}_.+\.(up|down)\.sql$'; then
        echo "ERROR: Migration file $filename does not follow naming convention: NNNNNN_description.(up|down).sql"
        exit 1
    fi
done

# Check that each up migration has a corresponding down migration
echo "$CHANGED_MIGRATIONS" | grep "\.up\.sql$" | while read upfile; do
    downfile="${upfile/.up.sql/.down.sql}"
    if ! git diff --cached --name-only | grep -q "$downfile" && ! [ -f "$downfile" ]; then
        echo "ERROR: Migration $upfile is missing corresponding down migration $downfile"
        exit 1
    fi
done

echo "Migration validation passed."
```

Database migrations are infrastructure-as-code. Treat them with the same rigor as application code: test them, lint them, review them in PRs, and automate their validation in CI before they ever reach a production database.
