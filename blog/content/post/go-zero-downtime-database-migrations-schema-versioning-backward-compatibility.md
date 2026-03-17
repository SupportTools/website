---
title: "Go: Implementing Zero-Downtime Database Migrations with Schema Versioning and Backward Compatibility"
date: 2031-07-15T00:00:00-05:00
draft: false
tags: ["Go", "Database", "Migrations", "PostgreSQL", "Zero-Downtime", "Schema", "Golang"]
categories: ["Go", "Databases"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing zero-downtime database schema migrations in Go using a multi-phase approach with backward compatibility, covering expand-contract patterns, migration tooling, distributed locking, and production deployment strategies."
more_link: "yes"
url: "/go-zero-downtime-database-migrations-schema-versioning-backward-compatibility/"
---

Database schema migrations are among the riskiest operations in production software delivery. A naive migration that locks a table for minutes while backfilling data can cause complete application downtime. This guide presents the production-proven patterns for zero-downtime migrations in Go: the expand-contract (also known as parallel change) pattern, migration tooling with Atlas and golang-migrate, distributed migration locks, backward-compatible schema design, and the operational procedures for deploying schema changes to production systems serving live traffic.

<!--more-->

# Go Zero-Downtime Database Migrations

## Section 1: Why Naive Migrations Cause Downtime

Understanding why migrations cause downtime requires understanding how PostgreSQL (and most relational databases) handle concurrent access during schema changes.

### Lock Types That Cause Downtime

PostgreSQL's DDL operations acquire an `AccessExclusiveLock` on the target table, which blocks ALL other operations (reads and writes) for the duration:

```sql
-- These operations acquire AccessExclusiveLock and block all reads/writes:
ALTER TABLE orders ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'pending';
-- On a 100M-row table: this can take 30+ seconds while building default values

ALTER TABLE orders DROP COLUMN legacy_field;
-- Relatively fast, but still blocks

CREATE INDEX ON orders (customer_id);
-- Extremely slow on large tables: hours for 100M rows
-- Solution: CREATE INDEX CONCURRENTLY (only holds ShareUpdateExclusiveLock)
```

### The Safe Migration Principle

**Never deploy application code and schema changes simultaneously.** Instead:

1. Deploy migration that is backward-compatible with the old application code.
2. Deploy new application code that uses the new schema.
3. (Optional) Deploy cleanup migration that removes compatibility shims.

This is the **expand-contract** pattern, also called the **parallel change pattern**.

## Section 2: The Expand-Contract Pattern

### Phase 1: Expand (Backward Compatible)

The expand phase adds new columns, indexes, or tables without removing old ones. The old application code continues to work.

### Phase 2: Migrate (Application Code Deployment)

New application code is deployed. It reads/writes both old and new structures during a transition period.

### Phase 3: Contract (Cleanup)

Old columns, indexes, and code paths are removed after all application instances have updated.

### Example: Renaming a Column

```
Bad approach (causes downtime):
ALTER TABLE orders RENAME COLUMN user_id TO customer_id;
-- Breaks old application code instantly

Good approach (expand-contract):

Phase 1 (Expand):
  - Add new column: ALTER TABLE orders ADD COLUMN customer_id BIGINT;
  - Add trigger to keep columns in sync
  - Backfill: UPDATE orders SET customer_id = user_id;
  - Add NOT NULL constraint (see below for zero-downtime technique)

Phase 2 (Application):
  - Deploy new code that reads/writes customer_id
  - New code writes to both columns during transition

Phase 3 (Contract):
  - Drop trigger
  - Drop old column: ALTER TABLE orders DROP COLUMN user_id;
```

## Section 3: Migration Tooling Setup

### golang-migrate

```go
// go.mod dependencies
require (
    github.com/golang-migrate/migrate/v4 v4.17.x
    github.com/lib/pq v1.10.x
    // or
    github.com/jackc/pgx/v5 v5.x.x
)
```

```go
// internal/database/migrate.go
package database

import (
    "database/sql"
    "embed"
    "fmt"
    "log/slog"
    "time"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// MigrationConfig holds configuration for database migrations.
type MigrationConfig struct {
    LockTimeout      time.Duration // Maximum time to wait for migration lock
    StatementTimeout time.Duration // Maximum time for any single SQL statement
    DryRun           bool          // Print SQL without executing
}

// RunMigrations runs all pending migrations against the database.
func RunMigrations(db *sql.DB, cfg MigrationConfig, logger *slog.Logger) error {
    // Load migrations from embedded filesystem
    source, err := iofs.New(migrationsFS, "migrations")
    if err != nil {
        return fmt.Errorf("failed to create migration source: %w", err)
    }

    driver, err := postgres.WithInstance(db, &postgres.Config{
        MigrationsTable:       "schema_migrations",
        MultiStatementEnabled: false, // Run one statement at a time for better error attribution
        MultiStatementMaxSize: 0,
    })
    if err != nil {
        return fmt.Errorf("failed to create migration driver: %w", err)
    }

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    if err != nil {
        return fmt.Errorf("failed to create migration instance: %w", err)
    }

    m.Log = &migrateLogger{logger: logger}

    // Set statement timeout for all migration statements
    if cfg.StatementTimeout > 0 {
        if _, err := db.Exec(fmt.Sprintf(
            "SET statement_timeout = '%d'",
            cfg.StatementTimeout.Milliseconds(),
        )); err != nil {
            return fmt.Errorf("failed to set statement timeout: %w", err)
        }
    }

    // Get current version before migration
    currentVersion, dirty, err := m.Version()
    if err != nil && err != migrate.ErrNilVersion {
        return fmt.Errorf("failed to get migration version: %w", err)
    }

    if dirty {
        return fmt.Errorf("database is in a dirty state at version %d; manual intervention required", currentVersion)
    }

    logger.Info("starting database migrations",
        "current_version", currentVersion,
        "dry_run", cfg.DryRun,
    )

    if cfg.DryRun {
        // In dry-run mode, just show what would be run
        return showPendingMigrations(m, currentVersion, logger)
    }

    if err := m.Up(); err != nil {
        if err == migrate.ErrNoChange {
            logger.Info("no pending migrations")
            return nil
        }
        return fmt.Errorf("migration failed: %w", err)
    }

    newVersion, _, err := m.Version()
    if err != nil {
        return fmt.Errorf("failed to get post-migration version: %w", err)
    }

    logger.Info("migrations completed successfully",
        "previous_version", currentVersion,
        "new_version", newVersion,
    )

    return nil
}

// RollbackMigration rolls back the last migration.
func RollbackMigration(db *sql.DB, logger *slog.Logger) error {
    source, err := iofs.New(migrationsFS, "migrations")
    if err != nil {
        return fmt.Errorf("failed to create migration source: %w", err)
    }

    driver, err := postgres.WithInstance(db, &postgres.Config{
        MigrationsTable: "schema_migrations",
    })
    if err != nil {
        return fmt.Errorf("failed to create migration driver: %w", err)
    }

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    if err != nil {
        return fmt.Errorf("failed to create migration instance: %w", err)
    }

    if err := m.Steps(-1); err != nil {
        return fmt.Errorf("rollback failed: %w", err)
    }

    version, _, _ := m.Version()
    logger.Info("migration rolled back", "new_version", version)
    return nil
}

type migrateLogger struct {
    logger *slog.Logger
}

func (l *migrateLogger) Printf(format string, v ...interface{}) {
    l.logger.Info(fmt.Sprintf(format, v...))
}

func (l *migrateLogger) Verbose() bool { return true }
```

### Migration File Naming Convention

```
migrations/
├── 000001_create_users_table.up.sql
├── 000001_create_users_table.down.sql
├── 000002_add_email_index.up.sql
├── 000002_add_email_index.down.sql
├── 000003_expand_add_customer_id.up.sql
├── 000003_expand_add_customer_id.down.sql
├── 000004_contract_drop_user_id.up.sql
└── 000004_contract_drop_user_id.down.sql
```

## Section 4: Zero-Downtime SQL Patterns

### Adding a NOT NULL Column Without Locking

The naive approach of `ADD COLUMN name TYPE NOT NULL DEFAULT value` in PostgreSQL < 11 rewrites the entire table. In PostgreSQL 11+, adding a column with a constant default is safe and instantaneous. However, for non-constant defaults:

```sql
-- migrations/000010_expand_add_customer_tier.up.sql

-- Step 1: Add column as nullable (no table rewrite, no lock)
ALTER TABLE customers ADD COLUMN tier VARCHAR(20);

-- Step 2: Set a valid check constraint (not yet enforced, NOT VALID)
ALTER TABLE customers ADD CONSTRAINT customers_tier_check
  CHECK (tier IN ('free', 'pro', 'enterprise'))
  NOT VALID;

-- Step 3: Backfill in batches (does NOT lock the table)
-- This will be handled by the application migration job
-- See Go code below for batch backfill implementation

-- The NOT NULL constraint is added later after backfill
-- (migrations/000011_contract_not_null_customer_tier.up.sql)
```

```sql
-- migrations/000010_expand_add_customer_tier.down.sql
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tier_check;
ALTER TABLE customers DROP COLUMN IF EXISTS tier;
```

### Batch Backfill in Go

```go
// internal/database/backfill.go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"
)

// BatchBackfillConfig configures the batch backfill operation.
type BatchBackfillConfig struct {
    BatchSize    int           // Number of rows per batch
    SleepBetween time.Duration // Sleep between batches to reduce load
    MaxBatches   int           // Safety limit (0 = unlimited)
    Timeout      time.Duration // Total timeout for the entire backfill
}

// BackfillCustomerTier sets the tier column for all existing customers
// in batches to avoid locking the table.
func BackfillCustomerTier(ctx context.Context, db *sql.DB, cfg BatchBackfillConfig, logger *slog.Logger) error {
    if cfg.BatchSize == 0 {
        cfg.BatchSize = 1000
    }
    if cfg.SleepBetween == 0 {
        cfg.SleepBetween = 10 * time.Millisecond
    }

    if cfg.Timeout > 0 {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, cfg.Timeout)
        defer cancel()
    }

    totalUpdated := 0
    batchCount := 0

    for {
        if cfg.MaxBatches > 0 && batchCount >= cfg.MaxBatches {
            logger.Warn("reached max batch limit", "max_batches", cfg.MaxBatches, "total_updated", totalUpdated)
            return nil
        }

        // Find and update a batch of rows where tier is NULL
        // Using ctid-based batching for performance
        result, err := db.ExecContext(ctx, `
            UPDATE customers
            SET tier = CASE
                WHEN subscription_plan = 'basic'    THEN 'free'
                WHEN subscription_plan = 'standard' THEN 'pro'
                WHEN subscription_plan = 'premium'  THEN 'enterprise'
                ELSE 'free'
            END
            WHERE id IN (
                SELECT id FROM customers
                WHERE tier IS NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
        `, cfg.BatchSize)

        if err != nil {
            return fmt.Errorf("batch update failed at batch %d: %w", batchCount, err)
        }

        rowsAffected, err := result.RowsAffected()
        if err != nil {
            return fmt.Errorf("failed to get rows affected: %w", err)
        }

        totalUpdated += int(rowsAffected)
        batchCount++

        logger.Debug("backfill batch completed",
            "batch", batchCount,
            "rows_in_batch", rowsAffected,
            "total_updated", totalUpdated,
        )

        // If no rows were updated, we're done
        if rowsAffected == 0 {
            break
        }

        // Check for context cancellation before sleeping
        select {
        case <-ctx.Done():
            return fmt.Errorf("backfill cancelled after %d rows: %w", totalUpdated, ctx.Err())
        default:
        }

        // Sleep between batches to reduce database load
        time.Sleep(cfg.SleepBetween)
    }

    logger.Info("backfill completed", "total_rows_updated", totalUpdated, "batches", batchCount)
    return nil
}
```

### Adding a NOT NULL Constraint Without Locking

After backfill, adding NOT NULL with `NOT VALID` first, then validating, avoids a full table scan under lock:

```sql
-- migrations/000011_contract_not_null_customer_tier.up.sql

-- Step 1: Add NOT NULL constraint as NOT VALID (only checks new writes, no table scan)
-- This acquires only a ShareUpdateExclusiveLock, not AccessExclusiveLock
ALTER TABLE customers ALTER COLUMN tier SET DEFAULT 'free';

ALTER TABLE customers ADD CONSTRAINT customers_tier_not_null
  CHECK (tier IS NOT NULL)
  NOT VALID;

-- Step 2: Validate the constraint (scans the table but only holds ShareUpdateExclusiveLock)
-- This allows concurrent reads and writes while validating!
ALTER TABLE customers VALIDATE CONSTRAINT customers_tier_not_null;

-- Step 3: Set actual NOT NULL (fast because constraint already validates it)
ALTER TABLE customers ALTER COLUMN tier SET NOT NULL;

-- Step 4: Drop the check constraint (was just a stepping stone)
ALTER TABLE customers DROP CONSTRAINT customers_tier_not_null;
```

### Creating Indexes Without Downtime

```sql
-- migrations/000012_add_customer_email_index.up.sql

-- CONCURRENTLY builds the index without holding AccessExclusiveLock
-- Allows concurrent reads and writes during index build
-- NOTE: CONCURRENTLY cannot run inside a transaction block
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_email
  ON customers (email)
  WHERE deleted_at IS NULL;
```

```go
// Important: golang-migrate runs SQL inside transactions by default
// For CONCURRENTLY indexes, you must disable transactions for this migration
// Use the --no-lock flag or configure the driver:

driver, err := postgres.WithInstance(db, &postgres.Config{
    MigrationsTable: "schema_migrations",
    // Disable transaction for CREATE INDEX CONCURRENTLY
    MultiStatementEnabled: false,
})
```

To run non-transactional migrations with golang-migrate, use a special comment:

```sql
-- migrations/000012_add_customer_email_index.up.sql
-- migrate:disable-tx

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_email
  ON customers (email)
  WHERE deleted_at IS NULL;
```

### Renaming a Table with Zero Downtime

```sql
-- Phase 1: Create new table, keep old
-- migrations/000020_expand_rename_orders_to_purchases.up.sql

CREATE TABLE purchases (LIKE orders INCLUDING ALL);

-- Create triggers to sync inserts/updates/deletes from orders to purchases
CREATE OR REPLACE FUNCTION sync_orders_to_purchases()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO purchases VALUES (NEW.*) ON CONFLICT (id) DO NOTHING;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE purchases SET (column1, column2) = (NEW.column1, NEW.column2)
        WHERE id = NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM purchases WHERE id = OLD.id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_orders_trigger
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION sync_orders_to_purchases();

-- Backfill purchases from orders
INSERT INTO purchases SELECT * FROM orders;
```

## Section 5: Distributed Migration Locking

In a microservice deployment, multiple application instances may start simultaneously and each attempt to run migrations. Without coordination, this causes race conditions and data corruption.

### Advisory Lock-Based Coordination

PostgreSQL advisory locks provide a mechanism for coordinating distributed processes:

```go
// internal/database/lock.go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"
)

const (
    // MigrationLockID is a unique integer for the migration advisory lock.
    // Use a consistent value across all services in the same database.
    MigrationLockID = 7281946302847382
)

// AcquireMigrationLock acquires a PostgreSQL advisory lock for running migrations.
// It blocks until the lock is acquired or the context is cancelled.
func AcquireMigrationLock(ctx context.Context, db *sql.DB, logger *slog.Logger) (func(), error) {
    logger.Info("acquiring database migration lock", "lock_id", MigrationLockID)

    // Use a session-level advisory lock that auto-releases when connection closes
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    for {
        var acquired bool
        err := db.QueryRowContext(ctx,
            "SELECT pg_try_advisory_lock($1)",
            MigrationLockID,
        ).Scan(&acquired)

        if err != nil {
            return nil, fmt.Errorf("failed to attempt advisory lock: %w", err)
        }

        if acquired {
            logger.Info("database migration lock acquired")
            release := func() {
                if _, err := db.ExecContext(context.Background(),
                    "SELECT pg_advisory_unlock($1)",
                    MigrationLockID,
                ); err != nil {
                    logger.Error("failed to release migration lock", "error", err)
                }
                logger.Info("database migration lock released")
            }
            return release, nil
        }

        logger.Debug("migration lock held by another process, waiting")

        select {
        case <-ctx.Done():
            return nil, fmt.Errorf("timed out waiting for migration lock: %w", ctx.Err())
        case <-ticker.C:
            // Try again
        }
    }
}

// RunMigrationsWithLock acquires a distributed lock, runs migrations, then releases.
func RunMigrationsWithLock(ctx context.Context, db *sql.DB, cfg MigrationConfig, logger *slog.Logger) error {
    lockCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
    defer cancel()

    release, err := AcquireMigrationLock(lockCtx, db, logger)
    if err != nil {
        return fmt.Errorf("failed to acquire migration lock: %w", err)
    }
    defer release()

    return RunMigrations(db, cfg, logger)
}
```

## Section 6: Schema Versioning API

Expose the database schema version as an API endpoint for deployment tooling to verify migration status:

```go
// internal/handlers/schema_version.go
package handlers

import (
    "database/sql"
    "encoding/json"
    "net/http"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
)

type SchemaVersionHandler struct {
    db *sql.DB
}

type SchemaVersionResponse struct {
    CurrentVersion uint   `json:"current_version"`
    LatestVersion  uint   `json:"latest_version"`
    IsCurrent      bool   `json:"is_current"`
    IsDirty        bool   `json:"is_dirty"`
}

func (h *SchemaVersionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    source, _ := iofs.New(migrationsFS, "migrations")
    driver, _ := postgres.WithInstance(h.db, &postgres.Config{
        MigrationsTable: "schema_migrations",
    })

    m, err := migrate.NewWithInstance("iofs", source, "postgres", driver)
    if err != nil {
        http.Error(w, "failed to initialize migrator", http.StatusInternalServerError)
        return
    }

    currentVersion, dirty, err := m.Version()
    if err != nil && err != migrate.ErrNilVersion {
        http.Error(w, "failed to get version", http.StatusInternalServerError)
        return
    }

    // Get latest version by counting migration files
    // (simplified implementation)
    latestVersion := getLatestMigrationVersion()

    resp := SchemaVersionResponse{
        CurrentVersion: currentVersion,
        LatestVersion:  latestVersion,
        IsCurrent:      currentVersion == latestVersion,
        IsDirty:        dirty,
    }

    w.Header().Set("Content-Type", "application/json")
    if !resp.IsCurrent || resp.IsDirty {
        w.WriteHeader(http.StatusServiceUnavailable)
    }
    json.NewEncoder(w).Encode(resp)
}
```

## Section 7: Atlas for Schema-as-Code

Atlas provides a declarative schema management approach where you define the desired schema state and Atlas generates the migration plan.

```bash
# Install Atlas
curl -sSf https://atlasgo.sh | sh

# Initialize Atlas with your database
atlas schema inspect \
  -u "postgres://<user>:<password>@localhost:5432/mydb?sslmode=disable" \
  > schema.hcl

# Define desired schema state
cat > desired_schema.hcl <<EOF
table "customers" {
  schema = schema.public
  column "id" {
    type = bigserial
  }
  column "email" {
    type = varchar(255)
    null = false
  }
  column "tier" {
    type    = varchar(20)
    null    = false
    default = "free"
  }
  column "created_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  index "idx_customers_email" {
    columns = [column.email]
    unique  = true
  }
  check "tier_check" {
    expr = "tier IN ('free', 'pro', 'enterprise')"
  }
}
EOF

# Generate migration plan (dry run)
atlas schema apply \
  -u "postgres://<user>:<password>@localhost:5432/mydb?sslmode=disable" \
  --to file://desired_schema.hcl \
  --dry-run

# Generate versioned migration files
atlas migrate diff add_customer_tier \
  --dir "file://migrations" \
  --to file://desired_schema.hcl \
  --dev-url "docker://postgres/15/mydb"
```

## Section 8: Application Startup Migration Strategy

### Startup Sequence with Migration Coordination

```go
// cmd/server/main.go
package main

import (
    "context"
    "database/sql"
    "log/slog"
    "os"
    "time"

    _ "github.com/jackc/pgx/v5/stdlib"

    "github.com/your-org/your-app/internal/database"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    ctx := context.Background()

    // Connect to database
    db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Error("failed to open database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    // Wait for database to be ready
    if err := waitForDatabase(ctx, db, 30*time.Second, logger); err != nil {
        logger.Error("database not ready", "error", err)
        os.Exit(1)
    }

    // Determine if this instance should run migrations
    // In Kubernetes, use an init container or job for migrations
    // In simple deployments, use a leader election mechanism
    shouldMigrate := os.Getenv("RUN_MIGRATIONS") == "true"

    if shouldMigrate {
        migrationCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
        defer cancel()

        if err := database.RunMigrationsWithLock(migrationCtx, db, database.MigrationConfig{
            StatementTimeout: 2 * time.Minute,
        }, logger); err != nil {
            logger.Error("database migration failed", "error", err)
            os.Exit(1)
        }
    } else {
        // Non-migration instances: wait for schema to be current
        if err := waitForCurrentSchema(ctx, db, 5*time.Minute, logger); err != nil {
            logger.Error("schema not current", "error", err)
            os.Exit(1)
        }
    }

    // Start application server
    startServer(ctx, db, logger)
}

func waitForDatabase(ctx context.Context, db *sql.DB, timeout time.Duration, logger *slog.Logger) error {
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        if err := db.PingContext(ctx); err == nil {
            return nil
        }
        logger.Info("waiting for database connection")
        time.Sleep(2 * time.Second)
    }
    return fmt.Errorf("database not available after %s", timeout)
}
```

### Kubernetes Deployment with Migration Job

The safest pattern for Kubernetes: run migrations as a Job before deploying the application Deployment.

```yaml
# migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate-v1-30-0
  namespace: my-app
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 600
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
        - name: wait-for-db
          image: postgres:16
          command:
            - sh
            - -c
            - |
              until pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER; do
                echo "Waiting for database..."
                sleep 2
              done
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
            - name: DB_PORT
              value: "5432"
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: username
      containers:
        - name: migrate
          image: your-org/your-app:v1.30.0
          command: ["/app/migrate"]
          args: ["--action=up", "--dry-run=false"]
          env:
            - name: RUN_MIGRATIONS
              value: "true"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

## Section 9: Backward-Compatible Schema Design Principles

### Principles for Zero-Downtime Schema Evolution

1. **New columns must be nullable or have a server-side default**: `ADD COLUMN status VARCHAR(20) DEFAULT 'active'` is safe in PostgreSQL 11+.

2. **Never rename columns in a single step**: Use expand-contract.

3. **Never change a column's type in place on large tables**: Add new column, backfill, switch application, drop old column.

4. **Dropping a column requires a multi-deployment process**:
   - Deployment N: Stop writing to the column.
   - Deployment N+1: Drop the column.

5. **Adding UNIQUE constraints on large tables**:
   ```sql
   -- Safe approach:
   CREATE UNIQUE INDEX CONCURRENTLY idx_customers_email_unique ON customers(email);
   ALTER TABLE customers ADD CONSTRAINT customers_email_unique
     UNIQUE USING INDEX idx_customers_email_unique;
   ```

6. **Changing NOT NULL to NULL is always safe**.

7. **Adding NOT NULL to existing column requires the expand-validate-constrain pattern**.

8. **Foreign keys on large tables**: Add with `NOT VALID` first, then validate separately.

```sql
-- Add FK without full table scan
ALTER TABLE orders ADD CONSTRAINT fk_orders_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id)
  NOT VALID;

-- Validate in a separate transaction (allows concurrent operations)
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_customer;
```

## Section 10: Testing Migrations

### Testing Migration Correctness

```go
// internal/database/migrate_test.go
package database_test

import (
    "context"
    "database/sql"
    "testing"

    _ "github.com/jackc/pgx/v5/stdlib"
    "github.com/stretchr/testify/require"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"

    "github.com/your-org/your-app/internal/database"
)

func TestMigrationsUpAndDown(t *testing.T) {
    ctx := context.Background()

    // Start a real PostgreSQL container
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    require.NoError(t, err)
    defer pgContainer.Terminate(ctx)

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    require.NoError(t, err)

    db, err := sql.Open("pgx", connStr)
    require.NoError(t, err)
    defer db.Close()

    // Run all migrations up
    err = database.RunMigrations(db, database.MigrationConfig{}, nil)
    require.NoError(t, err, "migrations up should succeed")

    // Verify schema is correct
    var tableExists bool
    err = db.QueryRowContext(ctx, `
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'customers'
        )
    `).Scan(&tableExists)
    require.NoError(t, err)
    require.True(t, tableExists, "customers table should exist after migration")

    // Run all migrations down
    err = database.RollbackAllMigrations(db)
    require.NoError(t, err, "migrations down should succeed")

    // Verify schema is clean
    err = db.QueryRowContext(ctx, `
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'customers'
        )
    `).Scan(&tableExists)
    require.NoError(t, err)
    require.False(t, tableExists, "customers table should not exist after rollback")
}

func TestMigrationIdempotency(t *testing.T) {
    // Running migrations twice should be a no-op
    ctx := context.Background()
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    require.NoError(t, err)
    defer pgContainer.Terminate(ctx)

    connStr, _ := pgContainer.ConnectionString(ctx, "sslmode=disable")
    db, _ := sql.Open("pgx", connStr)
    defer db.Close()

    require.NoError(t, database.RunMigrations(db, database.MigrationConfig{}, nil))
    // Second run should also succeed (no-op)
    require.NoError(t, database.RunMigrations(db, database.MigrationConfig{}, nil))
}
```

## Conclusion

Zero-downtime database migrations are achievable in Go through disciplined application of the expand-contract pattern, proper use of PostgreSQL's non-blocking DDL operations (CONCURRENTLY indexes, NOT VALID constraints), batch backfill strategies, and distributed migration locking. The combination of golang-migrate for versioned migration management, advisory locks for distributed coordination, and Kubernetes Jobs for isolated migration execution provides a production-grade foundation. The most important operational rule is to never deploy application code and schema changes simultaneously — always ensure the database schema is backward compatible with both the old and new application code during the transition period.
