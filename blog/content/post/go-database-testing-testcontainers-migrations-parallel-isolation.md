---
title: "Go Database Testing: testcontainers-go, Migrations, and Parallel Test Isolation"
date: 2029-03-21T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "PostgreSQL", "testcontainers", "Database Migrations", "CI/CD"]
categories:
- Go
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to database integration testing in Go using testcontainers-go, covering schema migration workflows, per-test database isolation, and strategies for fast parallel execution in CI pipelines."
more_link: "yes"
url: "/go-database-testing-testcontainers-migrations-parallel-isolation/"
---

Integration tests that exercise real SQL behavior are among the most valuable tests in a backend service. They catch query plan differences, constraint violations, and migration ordering bugs that unit tests with mock repositories cannot detect. The challenge has always been infrastructure: spinning up a real database in CI without flakiness, isolation between parallel tests, and predictable schema state.

The `testcontainers-go` library solves the infrastructure problem by starting actual Docker containers from test code. Combined with a disciplined migration workflow and per-test database cloning, Go services can run hundreds of database integration tests in under 60 seconds on standard CI hardware.

<!--more-->

## Prerequisites and Module Setup

```bash
go get github.com/testcontainers/testcontainers-go@v0.31.0
go get github.com/testcontainers/testcontainers-go/modules/postgres@v0.31.0
go get github.com/jackc/pgx/v5@v5.6.0
go get github.com/golang-migrate/migrate/v4@v4.17.1
go get github.com/golang-migrate/migrate/v4/database/postgres@v4.17.1
go get github.com/golang-migrate/migrate/v4/source/file@v4.17.1
```

Docker must be available in the CI environment. GitHub Actions runners include Docker by default; self-hosted runners need `docker` in `PATH` and the test user in the `docker` group.

---

## Architecture: Template Database Pattern

The naive approach—one container per test—is too slow. Starting a PostgreSQL container takes 2–4 seconds. With 200 tests that is over 10 minutes.

The optimal pattern is:

1. Start **one** PostgreSQL container per test binary (`TestMain`).
2. Run all migrations once on a **template database**.
3. For each test, create a new database using `CREATE DATABASE testdb_N TEMPLATE template_db`. This copies the schema instantly (under 10ms) without re-running migrations.
4. Drop the per-test database in cleanup.

This gives full isolation at near-zero overhead.

```
TestMain
  └── Start postgres container (once)
  └── Apply migrations to "template_tests" database (once)
  └── Run tests in parallel
        ├── TestCreateUser      → CREATE DATABASE test_abc TEMPLATE template_tests
        ├── TestUpdateAccount   → CREATE DATABASE test_def TEMPLATE template_tests
        └── TestDeleteOrder     → CREATE DATABASE test_ghi TEMPLATE template_tests
```

---

## TestMain: Container Lifecycle

```go
// internal/testutil/dbtest/main_test.go
package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/golang-migrate/migrate/v4"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	pgContainer    *postgres.PostgresContainer
	templateDSN    string
	containerDSN   string
	dbCounter      atomic.Int64
)

const templateDBName = "template_tests"

func TestMain(m *testing.M) {
	ctx := context.Background()

	var err error
	pgContainer, err = postgres.RunContainer(ctx,
		testcontainers.WithImage("postgres:16.3-alpine"),
		postgres.WithDatabase(templateDBName),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start postgres container: %v\n", err)
		os.Exit(1)
	}

	containerDSN, err = pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Fprintf(os.Stderr, "connection string: %v\n", err)
		_ = pgContainer.Terminate(ctx)
		os.Exit(1)
	}
	templateDSN = containerDSN

	if err := runMigrations(templateDSN); err != nil {
		fmt.Fprintf(os.Stderr, "migrations: %v\n", err)
		_ = pgContainer.Terminate(ctx)
		os.Exit(1)
	}

	// Make template_tests a real PostgreSQL template database so it can be cloned.
	if err := setAsTemplate(containerDSN, templateDBName); err != nil {
		fmt.Fprintf(os.Stderr, "set template: %v\n", err)
		_ = pgContainer.Terminate(ctx)
		os.Exit(1)
	}

	code := m.Run()

	_ = pgContainer.Terminate(ctx)
	os.Exit(code)
}

func runMigrations(dsn string) error {
	m, err := migrate.New("file://../../migrations", dsn)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}
	defer m.Close()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}

func setAsTemplate(dsn, dbName string) error {
	// Connect to the postgres maintenance database to alter the template flag.
	maintDSN := replaceDatabaseInDSN(dsn, "postgres")
	db, err := sql.Open("pgx", maintDSN)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(fmt.Sprintf("UPDATE pg_database SET datistemplate = true WHERE datname = '%s'", dbName))
	return err
}

func replaceDatabaseInDSN(dsn, newDB string) string {
	// Simple replacement — works for the testcontainers-generated DSN format.
	// In production code use url.Parse for safety.
	import "strings"
	return strings.Replace(dsn, "/"+templateDBName, "/"+newDB, 1)
}
```

---

## Per-Test Database Helper

```go
// internal/testutil/dbtest/testdb.go
package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewTestDB creates an isolated database for a single test.
// It is cloned from the template and dropped in t.Cleanup.
func NewTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()

	n := dbCounter.Add(1)
	dbName := fmt.Sprintf("test_%d_%d", n, time.Now().UnixNano()%10000)

	// Connect to maintenance database to create the clone.
	maintDSN := strings.Replace(containerDSN, "/"+templateDBName, "/postgres", 1)
	adminDB, err := sql.Open("pgx", maintDSN)
	if err != nil {
		t.Fatalf("open admin db: %v", err)
	}
	defer adminDB.Close()

	if _, err := adminDB.ExecContext(context.Background(),
		fmt.Sprintf("CREATE DATABASE %s TEMPLATE %s", dbName, templateDBName),
	); err != nil {
		t.Fatalf("create test db %s: %v", dbName, err)
	}

	testDSN := strings.Replace(containerDSN, "/"+templateDBName, "/"+dbName, 1)
	pool, err := pgxpool.New(context.Background(), testDSN)
	if err != nil {
		t.Fatalf("connect to test db %s: %v", dbName, err)
	}

	t.Cleanup(func() {
		pool.Close()
		dropDB, _ := sql.Open("pgx", maintDSN)
		defer dropDB.Close()
		_, _ = dropDB.ExecContext(context.Background(),
			fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", dbName),
		)
	})

	return pool
}
```

---

## Migration Files

Migrations live in `migrations/` using the `golang-migrate` convention:

```
migrations/
  000001_create_users.up.sql
  000001_create_users.down.sql
  000002_create_accounts.up.sql
  000002_create_accounts.down.sql
  000003_add_user_email_index.up.sql
  000003_add_user_email_index.down.sql
```

```sql
-- migrations/000001_create_users.up.sql
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    external_id UUID        NOT NULL DEFAULT gen_random_uuid(),
    email       TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX idx_users_external_id ON users (external_id);
CREATE INDEX idx_users_deleted_at  ON users (deleted_at) WHERE deleted_at IS NULL;
```

```sql
-- migrations/000002_create_accounts.up.sql
CREATE TABLE accounts (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    balance     NUMERIC(18,6) NOT NULL DEFAULT 0,
    currency    CHAR(3)     NOT NULL DEFAULT 'USD',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_user_id ON accounts (user_id);
```

---

## Writing Parallel Integration Tests

```go
// internal/repository/user_repo_test.go
package repository_test

import (
	"context"
	"testing"
	"time"

	"github.com/example/service/internal/repository"
	"github.com/example/service/internal/testutil/dbtest"
)

func TestUserRepository_CreateAndFind(t *testing.T) {
	t.Parallel()
	pool := dbtest.NewTestDB(t)
	repo := repository.NewUserRepository(pool)
	ctx := context.Background()

	user, err := repo.Create(ctx, repository.CreateUserParams{
		Email: "alice@example.com",
		Name:  "Alice Nguyen",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if user.ID == 0 {
		t.Fatal("expected non-zero ID")
	}

	found, err := repo.FindByEmail(ctx, "alice@example.com")
	if err != nil {
		t.Fatalf("FindByEmail: %v", err)
	}
	if found.ID != user.ID {
		t.Errorf("ID mismatch: created=%d found=%d", user.ID, found.ID)
	}
}

func TestUserRepository_DuplicateEmail(t *testing.T) {
	t.Parallel()
	pool := dbtest.NewTestDB(t)
	repo := repository.NewUserRepository(pool)
	ctx := context.Background()

	params := repository.CreateUserParams{Email: "bob@example.com", Name: "Bob Smith"}
	if _, err := repo.Create(ctx, params); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	_, err := repo.Create(ctx, params)
	if err == nil {
		t.Fatal("expected duplicate email error, got nil")
	}
	if !repository.IsDuplicateKeyError(err) {
		t.Errorf("expected duplicate key error, got: %v", err)
	}
}

func TestUserRepository_SoftDelete(t *testing.T) {
	t.Parallel()
	pool := dbtest.NewTestDB(t)
	repo := repository.NewUserRepository(pool)
	ctx := context.Background()

	user, _ := repo.Create(ctx, repository.CreateUserParams{
		Email: "carol@example.com",
		Name:  "Carol Jones",
	})

	if err := repo.SoftDelete(ctx, user.ID); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}

	_, err := repo.FindByEmail(ctx, "carol@example.com")
	if err == nil {
		t.Fatal("expected not-found error after soft delete, got nil")
	}

	withDeleted, err := repo.FindByEmailIncludeDeleted(ctx, "carol@example.com")
	if err != nil {
		t.Fatalf("FindByEmailIncludeDeleted: %v", err)
	}
	if withDeleted.DeletedAt == nil {
		t.Error("DeletedAt should be set after soft delete")
	}
	if time.Since(*withDeleted.DeletedAt) > 5*time.Second {
		t.Errorf("DeletedAt too old: %v", withDeleted.DeletedAt)
	}
}
```

---

## Transaction Rollback Pattern for Read-Only Tests

For tests that only read data, a transaction rollback pattern avoids the clone overhead entirely:

```go
// TxTest opens a transaction, runs the test function, and rolls back unconditionally.
// This is appropriate for read-only tests or tests that should not persist data.
func TxTest(t *testing.T, pool *pgxpool.Pool, fn func(tx pgx.Tx)) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(ctx)
	})
	fn(tx)
}
```

Usage:

```go
func TestAccountBalance_ReadOnly(t *testing.T) {
	t.Parallel()
	pool := dbtest.NewTestDB(t)

	// Seed once with the pool directly.
	seedAccounts(t, pool)

	// Read-only assertions use the rollback helper.
	dbtest.TxTest(t, pool, func(tx pgx.Tx) {
		var balance float64
		err := tx.QueryRow(context.Background(),
			"SELECT balance FROM accounts WHERE user_id = $1", 42).Scan(&balance)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		if balance != 0.0 {
			t.Errorf("expected zero balance for new account, got %f", balance)
		}
	})
}
```

---

## CI Pipeline Configuration

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main, release/*]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Verify Docker is available
        run: docker info

      - name: Run unit tests
        run: go test ./... -short -count=1 -timeout 120s

      - name: Run integration tests
        run: |
          go test ./... -run Integration -count=1 -timeout 300s -parallel 8
        env:
          TESTCONTAINERS_RYUK_DISABLED: "false"
          TESTCONTAINERS_RYUK_RECONNECTION_TIMEOUT: "30s"

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage.out
```

Set `TESTCONTAINERS_RYUK_DISABLED=false` to ensure the Ryuk container (reaper) cleans up leftover containers if the test process crashes. On self-hosted runners without internet access, pre-pull the Ryuk image:

```bash
docker pull testcontainers/ryuk:0.7.0
```

---

## Debugging Slow Migrations

Track migration performance in CI to detect regressions:

```go
func runMigrationsWithTiming(dsn string) error {
	start := time.Now()
	m, err := migrate.New("file://../../migrations", dsn)
	if err != nil {
		return err
	}
	defer m.Close()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}
	elapsed := time.Since(start)
	fmt.Printf("migrations completed in %s\n", elapsed.Round(time.Millisecond))
	if elapsed > 10*time.Second {
		fmt.Printf("WARNING: migrations took %s, consider optimizing schema setup\n", elapsed)
	}
	return nil
}
```

---

## Testing Migration Rollbacks

Every `down` migration must be tested as part of the CI suite to prevent accumulation of broken rollback scripts:

```go
func TestMigrationRollback(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping migration rollback test in short mode")
	}

	pool := dbtest.NewTestDB(t)
	dsn := pool.Config().ConnString()
	pool.Close() // Close pool; migrate opens its own connection.

	m, err := migrate.New("file://../../migrations", dsn)
	if err != nil {
		t.Fatalf("create migrator: %v", err)
	}
	defer m.Close()

	// Apply all migrations.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}

	version, dirty, err := m.Version()
	if err != nil {
		t.Fatalf("version: %v", err)
	}
	if dirty {
		t.Fatal("database is in dirty state after up migration")
	}
	t.Logf("migrated to version %d", version)

	// Roll back one step at a time to version 1.
	for v := version; v > 1; v-- {
		if err := m.Steps(-1); err != nil {
			t.Fatalf("rollback step from %d: %v", v, err)
		}
	}

	// Reapply.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-migrate up after rollback: %v", err)
	}
}
```

---

## Summary

The testcontainers-go + template database pattern provides true database isolation for parallel Go tests without the startup cost of per-test containers. Key practices:

- One container per test binary, started in `TestMain`.
- Migrations run once on a template database; per-test databases are created via `CREATE DATABASE ... TEMPLATE`.
- Use `t.Parallel()` freely — each test has its own isolated schema state.
- Test rollback paths (`down` migrations) in CI to prevent accumulation of broken scripts.
- Use the transaction rollback pattern for read-only assertions to reduce clone overhead further.

With this setup, 200 integration tests against PostgreSQL complete in under 30 seconds on GitHub Actions, making database integration testing a routine part of every pull request cycle.
