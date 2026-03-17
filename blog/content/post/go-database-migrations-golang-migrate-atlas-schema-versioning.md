---
title: "Go Database Migrations: golang-migrate, Atlas, and Schema Versioning"
date: 2029-10-06T00:00:00-05:00
draft: false
tags: ["Go", "Database", "Migrations", "golang-migrate", "Atlas", "PostgreSQL", "CI/CD"]
categories:
- Go
- Database
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go database migrations using golang-migrate and Atlas, covering migration locking, rollback patterns, schema versioning, and CI/CD integration for production environments."
more_link: "yes"
url: "/go-database-migrations-golang-migrate-atlas-schema-versioning/"
---

Database schema management is one of the most operationally sensitive areas in any production system. A botched migration can cause extended downtime, data corruption, or application failures that are difficult to recover from. This guide covers two dominant tools in the Go ecosystem — golang-migrate and Atlas — and provides production-grade patterns for migration locking, rollback strategies, and CI/CD integration.

<!--more-->

# Go Database Migrations: golang-migrate, Atlas, and Schema Versioning

## The Problem with Ad Hoc Schema Changes

Many teams start by applying schema changes manually, running SQL scripts directly against production databases. This approach collapses under the weight of multiple environments, multiple developers, and deployment automation. The core problems are repeatability, ordering, and auditability.

A proper migration system provides:
- Sequential, versioned change sets applied exactly once per environment
- Distributed locking so concurrent deployments do not double-apply migrations
- Rollback capability for failed or problematic changes
- Audit trail of what changed, when, and in what order

## Section 1: golang-migrate — The Surgical Tool

golang-migrate is a battle-tested library and CLI that manages migrations as numbered SQL files. It tracks applied migrations in a metadata table and uses advisory locks to prevent concurrent execution.

### Installation

```bash
# CLI via go install
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# Or via brew
brew install golang-migrate

# Verify
migrate -version
```

### Project Structure

```
db/
  migrations/
    000001_create_users.up.sql
    000001_create_users.down.sql
    000002_add_email_index.up.sql
    000002_add_email_index.down.sql
    000003_create_sessions.up.sql
    000003_create_sessions.down.sql
```

The file naming convention `NNNNNN_description.up.sql` / `NNNNNN_description.down.sql` is critical. The numeric prefix determines execution order. Gaps are allowed but not recommended. The description must match between up and down files.

### Creating Your First Migration

```bash
# Create a new migration pair
migrate create -ext sql -dir db/migrations -seq create_users

# Output:
# db/migrations/000001_create_users.up.sql
# db/migrations/000001_create_users.down.sql
```

```sql
-- 000001_create_users.up.sql
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;
```

```sql
-- 000001_create_users.down.sql
DROP TABLE IF EXISTS users;
```

### CLI Usage

```bash
# Apply all pending migrations
migrate -path db/migrations -database "postgres://user:pass@localhost:5432/mydb?sslmode=disable" up

# Apply exactly N migrations
migrate -path db/migrations -database "..." up 2

# Roll back exactly N migrations
migrate -path db/migrations -database "..." down 1

# Roll back all applied migrations
migrate -path db/migrations -database "..." down

# Show current version
migrate -path db/migrations -database "..." version

# Force a specific version (use after fixing a dirty state)
migrate -path db/migrations -database "..." force 3
```

### Embedding golang-migrate in Your Application

Running migrations as part of application startup is a common pattern. It ensures that by the time your application accepts traffic, the schema is current.

```go
package database

import (
    "database/sql"
    "embed"
    "fmt"
    "log"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
    _ "github.com/lib/pq"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// MigrateDB applies all pending migrations to the database.
// It uses an advisory lock to prevent concurrent execution.
func MigrateDB(db *sql.DB) error {
    driver, err := postgres.WithInstance(db, &postgres.Config{
        // Table to track applied migrations. Defaults to schema_migrations.
        MigrationsTable: "schema_migrations",
        // Lock timeout for the advisory lock (milliseconds).
        LockTimeout: 30000,
        // Statement timeout per migration statement.
        StatementTimeout: 300000,
    })
    if err != nil {
        return fmt.Errorf("creating postgres driver: %w", err)
    }

    sourceDriver, err := iofs.New(migrationsFS, "migrations")
    if err != nil {
        return fmt.Errorf("creating iofs source driver: %w", err)
    }

    m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", driver)
    if err != nil {
        return fmt.Errorf("creating migrate instance: %w", err)
    }
    defer m.Close()

    // Log migration activity
    m.Log = &migrateLogger{}

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("running migrations: %w", err)
    }

    version, dirty, err := m.Version()
    if err != nil {
        return fmt.Errorf("getting migration version: %w", err)
    }

    log.Printf("database schema at version %d (dirty=%v)", version, dirty)
    return nil
}

// migrateLogger implements migrate.Logger.
type migrateLogger struct{}

func (l *migrateLogger) Printf(format string, v ...interface{}) {
    log.Printf("[migrate] "+format, v...)
}

func (l *migrateLogger) Verbose() bool {
    return false
}
```

### Handling the Dirty State

When a migration fails mid-execution, golang-migrate marks the version as "dirty". This prevents subsequent migrations from running until the issue is resolved.

```go
// CheckAndRepairDirtyState inspects the migration state and attempts repair.
func CheckAndRepairDirtyState(db *sql.DB) error {
    driver, err := postgres.WithInstance(db, &postgres.Config{})
    if err != nil {
        return err
    }

    m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", driver)
    if err != nil {
        return err
    }
    defer m.Close()

    version, dirty, err := m.Version()
    if err == migrate.ErrNilVersion {
        // No migrations applied yet, clean state
        return nil
    }
    if err != nil {
        return fmt.Errorf("checking version: %w", err)
    }

    if dirty {
        log.Printf("WARNING: migration version %d is dirty, attempting rollback", version)
        // Roll back the failed migration
        if err := m.Steps(-1); err != nil {
            return fmt.Errorf(
                "rollback of dirty version %d failed: %w — manual intervention required",
                version, err,
            )
        }
        log.Printf("rolled back dirty migration, schema now at version %d", version-1)
    }

    return nil
}
```

### Migration Locking Strategies

golang-migrate's PostgreSQL driver uses `pg_try_advisory_lock` to prevent concurrent migration runs. The lock key is derived from the database name. This works well for single-database scenarios. For multi-tenant systems where multiple application instances share a database, you may need additional coordination.

```sql
-- Check if a migration lock is held
SELECT pid, query, state, wait_event_type, wait_event
FROM pg_stat_activity
WHERE query LIKE '%advisory%'
  AND state != 'idle';

-- Check the schema_migrations table
SELECT version, dirty FROM schema_migrations;
```

For Kubernetes deployments, use an init container or a Kubernetes Job to run migrations before the main application pods start:

```yaml
# db-migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate-{{ .Release.Revision }}
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migrate
          image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
          command: ["/app/migrate"]
          args: ["-path", "/app/migrations", "-database", "$(DATABASE_URL)", "up"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
```

## Section 2: Atlas — Declarative Schema Management

Atlas takes a different approach. Instead of writing up/down migration scripts, you describe the desired schema state and Atlas computes the diff automatically. This is more maintainable for complex schemas but requires more upfront configuration.

### Installation

```bash
# macOS / Linux
curl -sSf https://atlasgo.sh | sh

# Verify
atlas version
```

### Project Structure with Atlas

```
atlas.hcl          # Atlas project configuration
schema/
  schema.hcl       # Desired schema definition (HCL format)
  # OR
  schema.sql       # Desired schema definition (SQL format)
migrations/
  20231001120000.sql   # Auto-generated migration files
  atlas.sum          # Migration integrity checksum file
```

### Defining Schema in HCL

```hcl
# schema/schema.hcl

table "users" {
  schema = schema.public
  column "id" {
    null = false
    type = bigserial
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
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("NOW()")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("NOW()")
  }
  primary_key {
    columns = [column.id]
  }
  index "idx_users_email" {
    unique  = true
    columns = [column.email]
  }
}

table "sessions" {
  schema = schema.public
  column "id" {
    null = false
    type = uuid
    default = sql("gen_random_uuid()")
  }
  column "user_id" {
    null = false
    type = bigint
  }
  column "expires_at" {
    null = false
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "fk_sessions_user" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete   = CASCADE
  }
}
```

### Atlas Project Configuration

```hcl
# atlas.hcl
env "local" {
  src = "file://schema/schema.hcl"
  url = "postgres://user:pass@localhost:5432/mydb?sslmode=disable"
  migration {
    dir = "file://migrations"
  }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}

env "production" {
  src = "file://schema/schema.hcl"
  url = getenv("DATABASE_URL")
  migration {
    dir    = "file://migrations"
    format = atlas
  }
}
```

### Generating Migrations with Atlas

```bash
# Inspect the current live schema
atlas schema inspect -u "postgres://user:pass@localhost:5432/mydb" > current_schema.hcl

# Generate a migration from current state to desired schema
atlas migrate diff add_sessions \
  --dir "file://migrations" \
  --to "file://schema/schema.hcl" \
  --dev-url "docker://postgres/15/dev"

# Apply pending migrations
atlas migrate apply \
  --dir "file://migrations" \
  --url "postgres://user:pass@localhost:5432/mydb"

# Show pending migrations without applying
atlas migrate status \
  --dir "file://migrations" \
  --url "postgres://user:pass@localhost:5432/mydb"
```

Atlas generates a migration file like:

```sql
-- Add new "sessions" table
CREATE TABLE "public"."sessions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" bigint NOT NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_sessions_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE
);
```

### Atlas Go SDK Integration

```go
package database

import (
    "context"
    "database/sql"
    "fmt"

    "ariga.io/atlas/sql/migrate"
    "ariga.io/atlas/sql/postgres"
    _ "github.com/lib/pq"
)

// ApplyAtlasMigrations applies pending Atlas migrations.
func ApplyAtlasMigrations(ctx context.Context, db *sql.DB, migrationsDir string) error {
    // Open an Atlas driver for PostgreSQL
    drv, err := postgres.Open(db)
    if err != nil {
        return fmt.Errorf("opening atlas postgres driver: %w", err)
    }

    // Create a migration executor
    dir, err := migrate.NewLocalDir(migrationsDir)
    if err != nil {
        return fmt.Errorf("opening migrations dir: %w", err)
    }

    executor, err := migrate.NewExecutor(drv, dir, migrate.NopRevisionReadWriter{})
    if err != nil {
        return fmt.Errorf("creating migration executor: %w", err)
    }

    // Apply all pending migrations
    if err := executor.ExecuteN(ctx, 0); err != nil && err != migrate.ErrNoPendingFiles {
        return fmt.Errorf("executing migrations: %w", err)
    }

    return nil
}
```

## Section 3: Rollback Patterns

Rollback strategy depends on the type of change. Not all schema changes are safely reversible.

### Safe Rollbacks: Additive Changes

Adding columns, tables, and indexes are the safest operations. Rollback is straightforward.

```sql
-- up: add a column with a default
ALTER TABLE users ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}';

-- down: remove the column
ALTER TABLE users DROP COLUMN preferences;
```

### Unsafe Rollbacks: Destructive Changes

Removing columns or tables permanently destroys data. Use the expand-contract pattern instead.

```sql
-- Phase 1 (up): deprecate the old column, add the new one
ALTER TABLE users ADD COLUMN email_normalized TEXT;
UPDATE users SET email_normalized = LOWER(TRIM(email));

-- Phase 2 (after all app instances are deployed): enforce not-null and drop old
-- This becomes a separate migration deployed later
ALTER TABLE users ALTER COLUMN email_normalized SET NOT NULL;
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users RENAME COLUMN email_normalized TO email;
```

### Zero-Downtime Index Creation

Creating indexes on large tables locks writes. Use `CONCURRENTLY`:

```sql
-- up: non-blocking index creation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_username ON users(username);

-- down: non-blocking index removal
DROP INDEX CONCURRENTLY IF EXISTS idx_users_username;
```

Note: golang-migrate wraps each migration in a transaction by default. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Disable transactions for this migration by adding the magic comment:

```sql
-- migrate: no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_username ON users(username);
```

## Section 4: CI/CD Integration

### GitHub Actions Pipeline

```yaml
# .github/workflows/migrate.yml
name: Database Migration

on:
  push:
    branches: [main]
    paths: ['db/migrations/**']

jobs:
  migrate-test:
    name: Run migrations against test database
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - name: Install golang-migrate
        run: |
          curl -L https://github.com/golang-migrate/migrate/releases/download/v4.17.0/migrate.linux-amd64.tar.gz | tar xvz
          sudo mv migrate /usr/local/bin/migrate

      - name: Run migrations up
        env:
          DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: |
          migrate -path db/migrations -database "$DATABASE_URL" up

      - name: Verify schema version
        env:
          DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: |
          VERSION=$(migrate -path db/migrations -database "$DATABASE_URL" version 2>&1)
          echo "Current schema version: $VERSION"

      - name: Test rollback
        env:
          DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: |
          # Roll back last migration
          migrate -path db/migrations -database "$DATABASE_URL" down 1
          # Apply it back
          migrate -path db/migrations -database "$DATABASE_URL" up 1

  migrate-production:
    name: Apply migrations to production
    runs-on: ubuntu-latest
    needs: [migrate-test]
    environment: production
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Install golang-migrate
        run: |
          curl -L https://github.com/golang-migrate/migrate/releases/download/v4.17.0/migrate.linux-amd64.tar.gz | tar xvz
          sudo mv migrate /usr/local/bin/migrate

      - name: Apply migrations
        env:
          DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}
        run: |
          migrate -path db/migrations -database "$DATABASE_URL" up
```

### Makefile Targets

```makefile
# db/Makefile

.PHONY: migrate-up migrate-down migrate-create migrate-version migrate-force

MIGRATE_CMD := migrate -path db/migrations -database "$(DATABASE_URL)"

migrate-up:
	$(MIGRATE_CMD) up

migrate-down:
	$(MIGRATE_CMD) down 1

migrate-down-all:
	$(MIGRATE_CMD) down

migrate-create:
	@read -p "Migration name: " name; \
	migrate create -ext sql -dir db/migrations -seq $$name

migrate-version:
	$(MIGRATE_CMD) version

migrate-force:
	@read -p "Force to version: " version; \
	$(MIGRATE_CMD) force $$version

# Verify all migration files can be parsed
migrate-lint:
	@for f in db/migrations/*.up.sql; do \
		echo "Checking $$f"; \
		psql $(DATABASE_URL) -f $$f --dry-run 2>&1 | head -5; \
	done
```

## Section 5: Schema Versioning Best Practices

### Version Numbering Strategy

Use sequential integers padded to 6 digits (`000001`, `000002`, ...). Avoid timestamps as version numbers when using golang-migrate — they cause merge conflicts on busy teams. Atlas uses timestamps in its auto-generated migration names, which is fine since Atlas handles ordering differently.

### One Change Per Migration

Each migration file should do one logical thing. Avoid bundling DDL and DML changes in the same migration. This simplifies debugging and makes rollbacks more granular.

```
-- BAD: bundled migration
000010_big_refactor.up.sql  (creates table, backfills data, adds index, drops old column)

-- GOOD: separate migrations
000010_add_new_status_column.up.sql
000011_backfill_status_data.up.sql
000012_add_status_index.up.sql
000013_drop_old_status_column.up.sql
```

### Idempotent Migrations

Write migrations to be safely re-runnable where possible:

```sql
-- Use IF NOT EXISTS / IF EXISTS for safety
CREATE TABLE IF NOT EXISTS feature_flags (
    id      BIGSERIAL PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags(name);

-- For enum changes, check existence first
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'user_status'
    ) THEN
        CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');
    END IF;
END $$;
```

### Migration Testing Pattern

```go
// migration_test.go
package database_test

import (
    "database/sql"
    "testing"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
    _ "github.com/lib/pq"
    "github.com/stretchr/testify/require"
)

func TestMigrationsUpDown(t *testing.T) {
    db, err := sql.Open("postgres", "postgres://test:test@localhost:5432/testdb?sslmode=disable")
    require.NoError(t, err)
    defer db.Close()

    driver, err := postgres.WithInstance(db, &postgres.Config{})
    require.NoError(t, err)

    src, err := iofs.New(migrationsFS, "migrations")
    require.NoError(t, err)

    m, err := migrate.NewWithInstance("iofs", src, "postgres", driver)
    require.NoError(t, err)
    defer m.Close()

    // Apply all migrations
    err = m.Up()
    require.NoError(t, err)

    // Get the version
    version, dirty, err := m.Version()
    require.NoError(t, err)
    require.False(t, dirty, "migrations should not be dirty")
    t.Logf("Applied migrations up to version %d", version)

    // Roll back one migration at a time and verify
    for i := int(version); i > 0; i-- {
        err = m.Steps(-1)
        require.NoError(t, err, "rollback of step %d should succeed", i)
    }

    // Apply again from zero
    err = m.Up()
    require.NoError(t, err)
}
```

## Section 6: Comparing golang-migrate and Atlas

| Feature | golang-migrate | Atlas |
|---|---|---|
| Migration style | Imperative (SQL files) | Declarative (schema diff) |
| Rollback | Manual down files | Auto-generated |
| CI/CD fit | Excellent | Excellent |
| Learning curve | Low | Medium |
| Schema drift detection | No | Yes |
| Cross-DB support | Excellent | Good |
| HCL DSL | No | Yes |
| Go SDK | Yes | Yes |
| Checksums / integrity | No | Yes (atlas.sum) |

Choose golang-migrate when you need fine-grained control over every SQL statement and your team is comfortable writing raw SQL. Choose Atlas when you want schema-as-code semantics and automatic diff generation, especially for large schemas that evolve frequently.

## Conclusion

Robust database migration tooling is non-negotiable for production Go applications. golang-migrate provides a simple, reliable foundation for teams that prefer writing explicit SQL. Atlas offers a more modern, declarative approach that reduces the cognitive load of writing diffs by hand. Both integrate cleanly into Kubernetes-based deployment pipelines via pre-upgrade Helm hooks or dedicated migration Jobs. The patterns covered here — migration locking, zero-downtime index creation, the expand-contract pattern, and CI/CD gating — apply regardless of which tool you choose.
