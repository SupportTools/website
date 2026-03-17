---
title: "Go Database Testing: sqlmock, pgx Testing, and Database Integration Test Patterns"
date: 2030-04-04T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Database", "PostgreSQL", "sqlmock", "pgx", "testcontainers", "Integration Testing"]
categories: ["Go", "Testing", "Database Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go database testing: sqlmock for unit tests, pgx integration tests with testcontainers, gomock for repository interfaces, and transaction rollback patterns for fast, reliable test suites."
more_link: "yes"
url: "/go-database-testing-sqlmock-pgx-testcontainers/"
---

Database testing in Go is one of the most critical and often mishandled aspects of production service development. Most teams fall into two failure modes: either they skip database tests entirely (trusting that SQL strings are correct until production proves otherwise) or they write integration tests that are slow, flaky, and dependent on shared infrastructure. Neither approach scales.

This guide covers a layered testing strategy: fast sqlmock-based unit tests for repository logic, testcontainers-driven integration tests against real PostgreSQL, and gomock for isolating service layer behavior. Every pattern shown here is production-tested and optimized for CI pipeline performance.

<!--more-->

## The Database Testing Pyramid

A well-structured Go service has three layers of database testing, each serving a different purpose:

- **Unit tests with sqlmock**: Test SQL query construction, error handling, and result mapping without a real database. Runs in milliseconds.
- **Integration tests with testcontainers**: Test actual SQL against a real PostgreSQL instance in Docker. Catches driver quirks, constraint violations, and index behavior.
- **Contract tests**: Verify that the database schema matches what the application expects.

Understanding when to use each layer prevents over-testing at expensive layers and under-testing at cheap layers.

## Setting Up the Test Infrastructure

### Project Structure

```
internal/
  repository/
    user_repository.go
    user_repository_test.go          # sqlmock unit tests
    user_repository_integration_test.go  # testcontainers integration tests
  service/
    user_service.go
    user_service_test.go             # gomock tests
testutil/
  db.go                              # shared test helpers
  fixtures.go                        # test data factories
```

### Dependencies

```bash
go get github.com/DATA-DOG/go-sqlmock/v2
go get github.com/testcontainers/testcontainers-go
go get github.com/testcontainers/testcontainers-go/modules/postgres
go get go.uber.org/mock/gomock
go get go.uber.org/mock/mockgen
go get github.com/jackc/pgx/v5
go get github.com/jackc/pgx/v5/stdlib
go get github.com/stretchr/testify
```

### Repository Interface Design

The foundation of testable database code is a clean interface that can be mocked:

```go
// internal/repository/user_repository.go
package repository

import (
    "context"
    "time"
)

// User represents the domain model
type User struct {
    ID        int64
    Email     string
    Name      string
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt *time.Time
}

// UserFilter holds query parameters for listing users
type UserFilter struct {
    Email     *string
    Name      *string
    Active    *bool
    Limit     int
    Offset    int
    OrderBy   string
    OrderDesc bool
}

// UserRepository defines the database operations for users
type UserRepository interface {
    Create(ctx context.Context, user *User) error
    GetByID(ctx context.Context, id int64) (*User, error)
    GetByEmail(ctx context.Context, email string) (*User, error)
    List(ctx context.Context, filter UserFilter) ([]*User, int64, error)
    Update(ctx context.Context, user *User) error
    Delete(ctx context.Context, id int64) error
    BulkCreate(ctx context.Context, users []*User) error
}

// PostgresUserRepository implements UserRepository using PostgreSQL
type PostgresUserRepository struct {
    db DBTX
}

// DBTX abstracts both *sql.DB and *sql.Tx, allowing the repository to work in transactions
type DBTX interface {
    ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
    PrepareContext(ctx context.Context, query string) (*sql.Stmt, error)
    QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
    QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row
}

func NewPostgresUserRepository(db DBTX) *PostgresUserRepository {
    return &PostgresUserRepository{db: db}
}
```

### The Full Repository Implementation

```go
// internal/repository/user_repository_impl.go
package repository

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "strings"
    "time"
)

var (
    ErrNotFound      = errors.New("record not found")
    ErrDuplicate     = errors.New("duplicate record")
    ErrInvalidFilter = errors.New("invalid filter parameters")
)

const (
    createUserQuery = `
        INSERT INTO users (email, name, created_at, updated_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id`

    getUserByIDQuery = `
        SELECT id, email, name, created_at, updated_at, deleted_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL`

    getUserByEmailQuery = `
        SELECT id, email, name, created_at, updated_at, deleted_at
        FROM users
        WHERE email = $1 AND deleted_at IS NULL`

    updateUserQuery = `
        UPDATE users
        SET email = $1, name = $2, updated_at = $3
        WHERE id = $4 AND deleted_at IS NULL`

    deleteUserQuery = `
        UPDATE users
        SET deleted_at = $1
        WHERE id = $2 AND deleted_at IS NULL`
)

func (r *PostgresUserRepository) Create(ctx context.Context, user *User) error {
    now := time.Now().UTC()
    user.CreatedAt = now
    user.UpdatedAt = now

    row := r.db.QueryRowContext(ctx, createUserQuery,
        user.Email, user.Name, user.CreatedAt, user.UpdatedAt)

    if err := row.Scan(&user.ID); err != nil {
        if isUniqueViolation(err) {
            return fmt.Errorf("%w: email %s already exists", ErrDuplicate, user.Email)
        }
        return fmt.Errorf("create user: %w", err)
    }
    return nil
}

func (r *PostgresUserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
    user := &User{}
    row := r.db.QueryRowContext(ctx, getUserByIDQuery, id)

    err := row.Scan(
        &user.ID, &user.Email, &user.Name,
        &user.CreatedAt, &user.UpdatedAt, &user.DeletedAt,
    )
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, fmt.Errorf("%w: user id %d", ErrNotFound, id)
        }
        return nil, fmt.Errorf("get user by id: %w", err)
    }
    return user, nil
}

func (r *PostgresUserRepository) GetByEmail(ctx context.Context, email string) (*User, error) {
    user := &User{}
    row := r.db.QueryRowContext(ctx, getUserByEmailQuery, email)

    err := row.Scan(
        &user.ID, &user.Email, &user.Name,
        &user.CreatedAt, &user.UpdatedAt, &user.DeletedAt,
    )
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, fmt.Errorf("%w: email %s", ErrNotFound, email)
        }
        return nil, fmt.Errorf("get user by email: %w", err)
    }
    return user, nil
}

func (r *PostgresUserRepository) List(ctx context.Context, filter UserFilter) ([]*User, int64, error) {
    if filter.Limit <= 0 {
        filter.Limit = 20
    }
    if filter.Limit > 1000 {
        return nil, 0, fmt.Errorf("%w: limit cannot exceed 1000", ErrInvalidFilter)
    }

    // Build dynamic query
    conditions := []string{"deleted_at IS NULL"}
    args := []interface{}{}
    argIdx := 1

    if filter.Email != nil {
        conditions = append(conditions, fmt.Sprintf("email ILIKE $%d", argIdx))
        args = append(args, "%"+*filter.Email+"%")
        argIdx++
    }

    if filter.Name != nil {
        conditions = append(conditions, fmt.Sprintf("name ILIKE $%d", argIdx))
        args = append(args, "%"+*filter.Name+"%")
        argIdx++
    }

    whereClause := strings.Join(conditions, " AND ")

    // Count query
    countQuery := fmt.Sprintf("SELECT COUNT(*) FROM users WHERE %s", whereClause)
    var total int64
    if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
        return nil, 0, fmt.Errorf("count users: %w", err)
    }

    // Build ORDER BY
    orderBy := "id"
    if filter.OrderBy != "" {
        // Whitelist allowed sort columns to prevent SQL injection
        allowed := map[string]bool{"id": true, "email": true, "name": true, "created_at": true}
        if !allowed[filter.OrderBy] {
            return nil, 0, fmt.Errorf("%w: invalid order_by column: %s", ErrInvalidFilter, filter.OrderBy)
        }
        orderBy = filter.OrderBy
    }
    direction := "ASC"
    if filter.OrderDesc {
        direction = "DESC"
    }

    listQuery := fmt.Sprintf(`
        SELECT id, email, name, created_at, updated_at, deleted_at
        FROM users
        WHERE %s
        ORDER BY %s %s
        LIMIT $%d OFFSET $%d`,
        whereClause, orderBy, direction, argIdx, argIdx+1)

    args = append(args, filter.Limit, filter.Offset)

    rows, err := r.db.QueryContext(ctx, listQuery, args...)
    if err != nil {
        return nil, 0, fmt.Errorf("list users: %w", err)
    }
    defer rows.Close()

    users := make([]*User, 0)
    for rows.Next() {
        user := &User{}
        if err := rows.Scan(
            &user.ID, &user.Email, &user.Name,
            &user.CreatedAt, &user.UpdatedAt, &user.DeletedAt,
        ); err != nil {
            return nil, 0, fmt.Errorf("scan user row: %w", err)
        }
        users = append(users, user)
    }

    if err := rows.Err(); err != nil {
        return nil, 0, fmt.Errorf("iterate user rows: %w", err)
    }

    return users, total, nil
}

func (r *PostgresUserRepository) Update(ctx context.Context, user *User) error {
    user.UpdatedAt = time.Now().UTC()
    result, err := r.db.ExecContext(ctx, updateUserQuery,
        user.Email, user.Name, user.UpdatedAt, user.ID)
    if err != nil {
        if isUniqueViolation(err) {
            return fmt.Errorf("%w: email %s already exists", ErrDuplicate, user.Email)
        }
        return fmt.Errorf("update user: %w", err)
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }
    if rowsAffected == 0 {
        return fmt.Errorf("%w: user id %d", ErrNotFound, user.ID)
    }
    return nil
}

func (r *PostgresUserRepository) Delete(ctx context.Context, id int64) error {
    result, err := r.db.ExecContext(ctx, deleteUserQuery, time.Now().UTC(), id)
    if err != nil {
        return fmt.Errorf("delete user: %w", err)
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }
    if rowsAffected == 0 {
        return fmt.Errorf("%w: user id %d", ErrNotFound, id)
    }
    return nil
}

func (r *PostgresUserRepository) BulkCreate(ctx context.Context, users []*User) error {
    if len(users) == 0 {
        return nil
    }

    // Build bulk insert using unnest for performance
    query := `
        INSERT INTO users (email, name, created_at, updated_at)
        SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
        RETURNING id`

    now := time.Now().UTC()
    emails := make([]string, len(users))
    names := make([]string, len(users))
    createdAts := make([]time.Time, len(users))
    updatedAts := make([]time.Time, len(users))

    for i, u := range users {
        emails[i] = u.Email
        names[i] = u.Name
        createdAts[i] = now
        updatedAts[i] = now
    }

    rows, err := r.db.QueryContext(ctx, query, emails, names, createdAts, updatedAts)
    if err != nil {
        return fmt.Errorf("bulk create users: %w", err)
    }
    defer rows.Close()

    i := 0
    for rows.Next() {
        if err := rows.Scan(&users[i].ID); err != nil {
            return fmt.Errorf("scan created user id: %w", err)
        }
        users[i].CreatedAt = now
        users[i].UpdatedAt = now
        i++
    }
    return rows.Err()
}

// isUniqueViolation checks for PostgreSQL unique constraint violation (error code 23505)
func isUniqueViolation(err error) bool {
    if err == nil {
        return false
    }
    // Check for pgx specific error
    var pgErr interface{ SQLState() string }
    if errors.As(err, &pgErr) {
        return pgErr.SQLState() == "23505"
    }
    return strings.Contains(err.Error(), "23505") ||
        strings.Contains(err.Error(), "unique constraint")
}
```

## Unit Testing with sqlmock

### Basic sqlmock Setup

```go
// internal/repository/user_repository_test.go
package repository_test

import (
    "context"
    "database/sql"
    "errors"
    "regexp"
    "testing"
    "time"

    "github.com/DATA-DOG/go-sqlmock/v2"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/yourorg/yourapp/internal/repository"
)

// testRepo creates a repository backed by sqlmock
func testRepo(t *testing.T) (*repository.PostgresUserRepository, sqlmock.Sqlmock) {
    t.Helper()
    db, mock, err := sqlmock.New()
    require.NoError(t, err)
    t.Cleanup(func() {
        db.Close()
        // Ensure all expected calls were made
        assert.NoError(t, mock.ExpectationsWereMet())
    })
    return repository.NewPostgresUserRepository(db), mock
}

// testUser returns a consistent test user
func testUser() *repository.User {
    return &repository.User{
        Email: "test@example.com",
        Name:  "Test User",
    }
}
```

### Testing Create Operations

```go
func TestPostgresUserRepository_Create(t *testing.T) {
    t.Run("successful creation returns user with ID", func(t *testing.T) {
        repo, mock := testRepo(t)
        user := testUser()

        // Use sqlmock.AnyArg() for timestamps since they're generated at call time
        mock.ExpectQuery(regexp.QuoteMeta(
            `INSERT INTO users (email, name, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        )).
            WithArgs(user.Email, user.Name, sqlmock.AnyArg(), sqlmock.AnyArg()).
            WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))

        err := repo.Create(context.Background(), user)

        require.NoError(t, err)
        assert.Equal(t, int64(42), user.ID)
        assert.False(t, user.CreatedAt.IsZero(), "CreatedAt should be set")
        assert.False(t, user.UpdatedAt.IsZero(), "UpdatedAt should be set")
    })

    t.Run("duplicate email returns ErrDuplicate", func(t *testing.T) {
        repo, mock := testRepo(t)
        user := testUser()

        // Simulate PostgreSQL unique violation error code 23505
        mock.ExpectQuery(regexp.QuoteMeta(
            `INSERT INTO users (email, name, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        )).
            WithArgs(user.Email, user.Name, sqlmock.AnyArg(), sqlmock.AnyArg()).
            WillReturnError(&mockPGError{code: "23505", message: "unique constraint"})

        err := repo.Create(context.Background(), user)

        require.Error(t, err)
        assert.True(t, errors.Is(err, repository.ErrDuplicate),
            "expected ErrDuplicate, got: %v", err)
    })

    t.Run("database error is wrapped and returned", func(t *testing.T) {
        repo, mock := testRepo(t)
        user := testUser()
        dbErr := errors.New("connection reset by peer")

        mock.ExpectQuery(regexp.QuoteMeta(
            `INSERT INTO users (email, name, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        )).
            WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
            WillReturnError(dbErr)

        err := repo.Create(context.Background(), user)

        require.Error(t, err)
        assert.ErrorContains(t, err, "create user")
        assert.ErrorContains(t, err, "connection reset by peer")
    })
}

// mockPGError simulates a PostgreSQL error with SQL state code
type mockPGError struct {
    code    string
    message string
}

func (e *mockPGError) Error() string  { return fmt.Sprintf("pq: %s", e.message) }
func (e *mockPGError) SQLState() string { return e.code }
```

### Testing Read Operations

```go
func TestPostgresUserRepository_GetByID(t *testing.T) {
    fixedTime := time.Date(2025, 1, 15, 12, 0, 0, 0, time.UTC)

    userColumns := []string{"id", "email", "name", "created_at", "updated_at", "deleted_at"}

    t.Run("found user is returned", func(t *testing.T) {
        repo, mock := testRepo(t)

        expectedUser := &repository.User{
            ID:        1,
            Email:     "alice@example.com",
            Name:      "Alice",
            CreatedAt: fixedTime,
            UpdatedAt: fixedTime,
        }

        mock.ExpectQuery(regexp.QuoteMeta(getUserByIDQuery)).
            WithArgs(int64(1)).
            WillReturnRows(
                sqlmock.NewRows(userColumns).
                    AddRow(1, "alice@example.com", "Alice", fixedTime, fixedTime, nil),
            )

        result, err := repo.GetByID(context.Background(), 1)

        require.NoError(t, err)
        assert.Equal(t, expectedUser.ID, result.ID)
        assert.Equal(t, expectedUser.Email, result.Email)
        assert.Equal(t, expectedUser.Name, result.Name)
        assert.Nil(t, result.DeletedAt)
    })

    t.Run("missing user returns ErrNotFound", func(t *testing.T) {
        repo, mock := testRepo(t)

        mock.ExpectQuery(regexp.QuoteMeta(getUserByIDQuery)).
            WithArgs(int64(999)).
            WillReturnError(sql.ErrNoRows)

        result, err := repo.GetByID(context.Background(), 999)

        require.Error(t, err)
        assert.Nil(t, result)
        assert.True(t, errors.Is(err, repository.ErrNotFound))
    })

    t.Run("soft-deleted users are not returned", func(t *testing.T) {
        // The query already filters deleted_at IS NULL so sql.ErrNoRows is returned
        repo, mock := testRepo(t)

        mock.ExpectQuery(regexp.QuoteMeta(getUserByIDQuery)).
            WithArgs(int64(5)).
            WillReturnError(sql.ErrNoRows)

        _, err := repo.GetByID(context.Background(), 5)
        assert.True(t, errors.Is(err, repository.ErrNotFound))
    })
}
```

### Testing Dynamic Query Building (List)

```go
func TestPostgresUserRepository_List(t *testing.T) {
    fixedTime := time.Date(2025, 1, 15, 12, 0, 0, 0, time.UTC)
    userColumns := []string{"id", "email", "name", "created_at", "updated_at", "deleted_at"}

    t.Run("list without filters returns all active users", func(t *testing.T) {
        repo, mock := testRepo(t)

        mock.ExpectQuery(`SELECT COUNT\(\*\) FROM users WHERE`).
            WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

        mock.ExpectQuery(`SELECT id, email, name, created_at, updated_at, deleted_at FROM users WHERE`).
            WillReturnRows(
                sqlmock.NewRows(userColumns).
                    AddRow(1, "alice@example.com", "Alice", fixedTime, fixedTime, nil).
                    AddRow(2, "bob@example.com", "Bob", fixedTime, fixedTime, nil),
            )

        users, total, err := repo.List(context.Background(), repository.UserFilter{Limit: 20})

        require.NoError(t, err)
        assert.Equal(t, int64(2), total)
        assert.Len(t, users, 2)
    })

    t.Run("list with email filter passes correct args", func(t *testing.T) {
        repo, mock := testRepo(t)
        email := "alice"

        mock.ExpectQuery(`SELECT COUNT\(\*\) FROM users WHERE`).
            WithArgs("%alice%").
            WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

        mock.ExpectQuery(`SELECT id, email, name`).
            WithArgs("%alice%", 20, 0).
            WillReturnRows(
                sqlmock.NewRows(userColumns).
                    AddRow(1, "alice@example.com", "Alice", fixedTime, fixedTime, nil),
            )

        users, total, err := repo.List(context.Background(), repository.UserFilter{
            Email:  &email,
            Limit:  20,
            Offset: 0,
        })

        require.NoError(t, err)
        assert.Equal(t, int64(1), total)
        assert.Len(t, users, 1)
    })

    t.Run("limit exceeding 1000 returns error", func(t *testing.T) {
        repo, _ := testRepo(t)

        _, _, err := repo.List(context.Background(), repository.UserFilter{Limit: 1001})

        require.Error(t, err)
        assert.True(t, errors.Is(err, repository.ErrInvalidFilter))
    })

    t.Run("invalid order_by column returns error", func(t *testing.T) {
        repo, _ := testRepo(t)

        _, _, err := repo.List(context.Background(), repository.UserFilter{
            Limit:   20,
            OrderBy: "password_hash; DROP TABLE users; --",
        })

        require.Error(t, err)
        assert.True(t, errors.Is(err, repository.ErrInvalidFilter))
    })
}
```

### Testing Transaction Behavior

```go
func TestPostgresUserRepository_Transactions(t *testing.T) {
    t.Run("repository works with transaction", func(t *testing.T) {
        db, mock, err := sqlmock.New()
        require.NoError(t, err)
        defer db.Close()

        // Set up transaction expectations
        mock.ExpectBegin()
        mock.ExpectQuery(regexp.QuoteMeta(
            `INSERT INTO users (email, name, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        )).
            WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
            WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
        mock.ExpectCommit()

        ctx := context.Background()
        tx, err := db.BeginTx(ctx, nil)
        require.NoError(t, err)

        // Repository uses the transaction, not the DB pool
        txRepo := repository.NewPostgresUserRepository(tx)
        user := &repository.User{Email: "tx@example.com", Name: "TX User"}

        err = txRepo.Create(ctx, user)
        require.NoError(t, err)

        err = tx.Commit()
        require.NoError(t, err)

        assert.NoError(t, mock.ExpectationsWereMet())
    })

    t.Run("rollback on error leaves database unchanged", func(t *testing.T) {
        db, mock, err := sqlmock.New()
        require.NoError(t, err)
        defer db.Close()

        mock.ExpectBegin()
        mock.ExpectQuery(regexp.QuoteMeta(
            `INSERT INTO users (email, name, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        )).
            WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
            WillReturnError(errors.New("deadlock detected"))
        mock.ExpectRollback()

        ctx := context.Background()
        tx, err := db.BeginTx(ctx, nil)
        require.NoError(t, err)

        txRepo := repository.NewPostgresUserRepository(tx)
        user := &repository.User{Email: "fail@example.com", Name: "Fail User"}

        createErr := txRepo.Create(ctx, user)
        require.Error(t, createErr)

        rollbackErr := tx.Rollback()
        require.NoError(t, rollbackErr)

        assert.NoError(t, mock.ExpectationsWereMet())
    })
}
```

## Integration Testing with Testcontainers

### Setting Up the PostgreSQL Test Container

```go
// testutil/db.go
package testutil

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
    _ "github.com/jackc/pgx/v5/stdlib"
)

// TestDatabase holds a test database connection
type TestDatabase struct {
    DB        *sql.DB
    Container testcontainers.Container
    DSN       string
}

// NewTestDatabase creates a PostgreSQL container for integration tests.
// The container is automatically terminated when the test completes.
func NewTestDatabase(t *testing.T) *TestDatabase {
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
                WithStartupTimeout(60*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("failed to start postgres container: %v", err)
    }

    t.Cleanup(func() {
        if err := pgContainer.Terminate(ctx); err != nil {
            t.Logf("failed to terminate postgres container: %v", err)
        }
    })

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("failed to get connection string: %v", err)
    }

    db, err := sql.Open("pgx", connStr)
    if err != nil {
        t.Fatalf("failed to open database: %v", err)
    }

    // Configure connection pool for tests
    db.SetMaxOpenConns(5)
    db.SetMaxIdleConns(2)
    db.SetConnMaxLifetime(5 * time.Minute)

    // Wait for connection
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        t.Fatalf("failed to ping database: %v", err)
    }

    tdb := &TestDatabase{
        DB:        db,
        Container: pgContainer,
        DSN:       connStr,
    }

    // Run migrations
    if err := tdb.runMigrations(ctx); err != nil {
        t.Fatalf("failed to run migrations: %v", err)
    }

    t.Cleanup(func() { db.Close() })

    return tdb
}

// runMigrations applies the test schema
func (tdb *TestDatabase) runMigrations(ctx context.Context) error {
    schema := `
        CREATE TABLE IF NOT EXISTS users (
            id          BIGSERIAL PRIMARY KEY,
            email       VARCHAR(255) NOT NULL UNIQUE,
            name        VARCHAR(255) NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at  TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);
    `
    _, err := tdb.DB.ExecContext(ctx, schema)
    return err
}

// BeginTx starts a transaction for test isolation
func (tdb *TestDatabase) BeginTx(ctx context.Context, t *testing.T) *sql.Tx {
    t.Helper()
    tx, err := tdb.DB.BeginTx(ctx, nil)
    if err != nil {
        t.Fatalf("failed to begin transaction: %v", err)
    }
    t.Cleanup(func() {
        if err := tx.Rollback(); err != nil && err != sql.ErrTxDone {
            t.Logf("failed to rollback test transaction: %v", err)
        }
    })
    return tx
}

// TruncateTable clears a table for test isolation
func (tdb *TestDatabase) TruncateTable(ctx context.Context, t *testing.T, table string) {
    t.Helper()
    // Whitelist table names to prevent injection
    allowed := map[string]bool{"users": true, "orders": true, "products": true}
    if !allowed[table] {
        t.Fatalf("truncate: table %q not in whitelist", table)
    }
    _, err := tdb.DB.ExecContext(ctx, fmt.Sprintf("TRUNCATE TABLE %s RESTART IDENTITY CASCADE", table))
    if err != nil {
        t.Fatalf("failed to truncate table %s: %v", table, err)
    }
}
```

### Shared Container Pattern for Test Suites

```go
// testutil/suite.go
package testutil

import (
    "sync"
    "testing"
)

// sharedDB is a single PostgreSQL container shared across all integration tests
// in a package. This dramatically reduces test time versus per-test containers.
var (
    sharedDB   *TestDatabase
    sharedOnce sync.Once
)

// GetSharedDB returns the package-wide test database, creating it if needed.
// Use this for tests that need fast startup and use transaction rollback for isolation.
func GetSharedDB(t *testing.T) *TestDatabase {
    t.Helper()
    sharedOnce.Do(func() {
        // This runs once per package test binary invocation
        sharedDB = NewTestDatabase(t)
    })
    return sharedDB
}
```

### Integration Tests with Transaction Rollback

```go
// internal/repository/user_repository_integration_test.go
//go:build integration

package repository_test

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/yourorg/yourapp/internal/repository"
    "github.com/yourorg/yourapp/testutil"
)

// integrationRepo creates a repository that operates within a test transaction.
// The transaction is automatically rolled back when the test ends, keeping tests isolated.
func integrationRepo(t *testing.T) *repository.PostgresUserRepository {
    t.Helper()
    tdb := testutil.GetSharedDB(t)
    tx := tdb.BeginTx(context.Background(), t)
    return repository.NewPostgresUserRepository(tx)
}

func TestIntegration_UserRepository_Create(t *testing.T) {
    t.Run("creates user and assigns sequential ID", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        user := &repository.User{
            Email: "integration@example.com",
            Name:  "Integration Test",
        }

        err := repo.Create(ctx, user)

        require.NoError(t, err)
        assert.Greater(t, user.ID, int64(0), "ID should be assigned by database")
        assert.False(t, user.CreatedAt.IsZero())
    })

    t.Run("duplicate email within same transaction fails", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        user1 := &repository.User{Email: "dup@example.com", Name: "First"}
        user2 := &repository.User{Email: "dup@example.com", Name: "Second"}

        require.NoError(t, repo.Create(ctx, user1))

        err := repo.Create(ctx, user2)
        require.Error(t, err)
        assert.True(t, errors.Is(err, repository.ErrDuplicate))
    })
}

func TestIntegration_UserRepository_GetByID(t *testing.T) {
    t.Run("retrieves created user", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        created := &repository.User{Email: "get@example.com", Name: "Get Test"}
        require.NoError(t, repo.Create(ctx, created))

        fetched, err := repo.GetByID(ctx, created.ID)
        require.NoError(t, err)
        assert.Equal(t, created.ID, fetched.ID)
        assert.Equal(t, created.Email, fetched.Email)
        assert.Equal(t, created.Name, fetched.Name)
    })

    t.Run("deleted user is not returned", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        user := &repository.User{Email: "todelete@example.com", Name: "Delete Me"}
        require.NoError(t, repo.Create(ctx, user))
        require.NoError(t, repo.Delete(ctx, user.ID))

        _, err := repo.GetByID(ctx, user.ID)
        require.Error(t, err)
        assert.True(t, errors.Is(err, repository.ErrNotFound))
    })
}

func TestIntegration_UserRepository_List(t *testing.T) {
    t.Run("pagination works correctly", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        // Create 5 users
        for i := 0; i < 5; i++ {
            user := &repository.User{
                Email: fmt.Sprintf("paginate%d@example.com", i),
                Name:  fmt.Sprintf("User %d", i),
            }
            require.NoError(t, repo.Create(ctx, user))
        }

        // First page
        page1, total, err := repo.List(ctx, repository.UserFilter{Limit: 2, Offset: 0})
        require.NoError(t, err)
        assert.Equal(t, int64(5), total)
        assert.Len(t, page1, 2)

        // Second page
        page2, _, err := repo.List(ctx, repository.UserFilter{Limit: 2, Offset: 2})
        require.NoError(t, err)
        assert.Len(t, page2, 2)

        // IDs should not overlap
        assert.NotEqual(t, page1[0].ID, page2[0].ID)
        assert.NotEqual(t, page1[1].ID, page2[1].ID)
    })

    t.Run("email filter performs case-insensitive search", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        require.NoError(t, repo.Create(ctx, &repository.User{Email: "alice@company.com", Name: "Alice"}))
        require.NoError(t, repo.Create(ctx, &repository.User{Email: "bob@company.com", Name: "Bob"}))

        email := "ALICE"
        results, total, err := repo.List(ctx, repository.UserFilter{
            Email: &email,
            Limit: 20,
        })

        require.NoError(t, err)
        assert.Equal(t, int64(1), total)
        assert.Len(t, results, 1)
        assert.Equal(t, "alice@company.com", results[0].Email)
    })
}

func TestIntegration_UserRepository_BulkCreate(t *testing.T) {
    t.Run("bulk creates multiple users efficiently", func(t *testing.T) {
        repo := integrationRepo(t)
        ctx := context.Background()

        users := make([]*repository.User, 100)
        for i := range users {
            users[i] = &repository.User{
                Email: fmt.Sprintf("bulk%d@example.com", i),
                Name:  fmt.Sprintf("Bulk User %d", i),
            }
        }

        start := time.Now()
        err := repo.BulkCreate(ctx, users)
        elapsed := time.Since(start)

        require.NoError(t, err)
        t.Logf("BulkCreate of 100 users took %v", elapsed)

        // Verify all IDs were set
        for i, u := range users {
            assert.Greater(t, u.ID, int64(0), "user[%d] should have ID set", i)
        }
    })
}
```

## Mocking the Repository for Service Tests

### Generating the Mock

```go
// Generate the mock using mockgen
//go:generate mockgen -source=user_repository.go -destination=mock_user_repository.go -package=repository

// Or using the newer uber/mock:
//go:generate mockgen -source=user_repository.go -destination=../mocks/mock_user_repository.go -package=mocks
```

### Service Layer Using the Repository Interface

```go
// internal/service/user_service.go
package service

import (
    "context"
    "fmt"

    "github.com/yourorg/yourapp/internal/repository"
)

type UserService struct {
    repo   repository.UserRepository
    events EventPublisher
}

type EventPublisher interface {
    Publish(ctx context.Context, event interface{}) error
}

type UserCreatedEvent struct {
    UserID int64
    Email  string
}

func (s *UserService) CreateUser(ctx context.Context, email, name string) (*repository.User, error) {
    // Validate
    if email == "" {
        return nil, fmt.Errorf("email is required")
    }
    if name == "" {
        return nil, fmt.Errorf("name is required")
    }

    // Check for existing user
    existing, err := s.repo.GetByEmail(ctx, email)
    if err != nil && !errors.Is(err, repository.ErrNotFound) {
        return nil, fmt.Errorf("check existing user: %w", err)
    }
    if existing != nil {
        return nil, fmt.Errorf("user with email %s already exists", email)
    }

    user := &repository.User{Email: email, Name: name}
    if err := s.repo.Create(ctx, user); err != nil {
        return nil, fmt.Errorf("create user: %w", err)
    }

    // Publish event (non-blocking, don't fail the request)
    _ = s.events.Publish(ctx, UserCreatedEvent{UserID: user.ID, Email: user.Email})

    return user, nil
}
```

### Service Tests with gomock

```go
// internal/service/user_service_test.go
package service_test

import (
    "context"
    "errors"
    "testing"

    "go.uber.org/mock/gomock"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/yourorg/yourapp/internal/mocks"
    "github.com/yourorg/yourapp/internal/repository"
    "github.com/yourorg/yourapp/internal/service"
)

func TestUserService_CreateUser(t *testing.T) {
    t.Run("creates user when email is unique", func(t *testing.T) {
        ctrl := gomock.NewController(t)
        mockRepo := mocks.NewMockUserRepository(ctrl)
        mockEvents := mocks.NewMockEventPublisher(ctrl)
        svc := service.NewUserService(mockRepo, mockEvents)

        ctx := context.Background()
        email := "new@example.com"
        name := "New User"

        // First call: check existing returns not found
        mockRepo.EXPECT().
            GetByEmail(ctx, email).
            Return(nil, fmt.Errorf("%w: email %s", repository.ErrNotFound, email))

        // Second call: create succeeds
        mockRepo.EXPECT().
            Create(ctx, gomock.Any()).
            DoAndReturn(func(_ context.Context, u *repository.User) error {
                u.ID = 42
                return nil
            })

        // Event published (we don't care about the return value)
        mockEvents.EXPECT().
            Publish(ctx, gomock.Any()).
            Return(nil)

        user, err := svc.CreateUser(ctx, email, name)

        require.NoError(t, err)
        assert.Equal(t, int64(42), user.ID)
        assert.Equal(t, email, user.Email)
    })

    t.Run("returns error when email already exists", func(t *testing.T) {
        ctrl := gomock.NewController(t)
        mockRepo := mocks.NewMockUserRepository(ctrl)
        mockEvents := mocks.NewMockEventPublisher(ctrl)
        svc := service.NewUserService(mockRepo, mockEvents)

        ctx := context.Background()
        existingUser := &repository.User{ID: 1, Email: "existing@example.com"}

        mockRepo.EXPECT().
            GetByEmail(ctx, "existing@example.com").
            Return(existingUser, nil)

        // Create and Publish should NOT be called
        // gomock verifies this automatically when ctrl.Finish() is called

        _, err := svc.CreateUser(ctx, "existing@example.com", "Duplicate")
        require.Error(t, err)
        assert.ErrorContains(t, err, "already exists")
    })

    t.Run("empty email returns validation error without calling repo", func(t *testing.T) {
        ctrl := gomock.NewController(t)
        mockRepo := mocks.NewMockUserRepository(ctrl)
        mockEvents := mocks.NewMockEventPublisher(ctrl)
        svc := service.NewUserService(mockRepo, mockEvents)

        // No expectations set — if repo is called, the test will fail

        _, err := svc.CreateUser(context.Background(), "", "Name")
        require.Error(t, err)
        assert.ErrorContains(t, err, "email is required")
    })

    t.Run("repository error is wrapped and returned", func(t *testing.T) {
        ctrl := gomock.NewController(t)
        mockRepo := mocks.NewMockUserRepository(ctrl)
        mockEvents := mocks.NewMockEventPublisher(ctrl)
        svc := service.NewUserService(mockRepo, mockEvents)

        ctx := context.Background()
        dbErr := errors.New("connection pool exhausted")

        mockRepo.EXPECT().
            GetByEmail(ctx, gomock.Any()).
            Return(nil, dbErr)

        _, err := svc.CreateUser(ctx, "test@example.com", "Test")
        require.Error(t, err)
        assert.ErrorContains(t, err, "connection pool exhausted")
    })
}
```

## Advanced Patterns

### Testing Complex Transactions with SAVEPOINT

```go
// testutil/tx_helper.go
package testutil

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
)

// NestedTxHelper wraps savepoints for nested transaction testing in PostgreSQL
type NestedTxHelper struct {
    tx        *sql.Tx
    savepoint string
    t         *testing.T
}

func NewNestedTx(ctx context.Context, t *testing.T, tx *sql.Tx, name string) *NestedTxHelper {
    t.Helper()
    sp := fmt.Sprintf("sp_%s", name)
    _, err := tx.ExecContext(ctx, fmt.Sprintf("SAVEPOINT %s", sp))
    if err != nil {
        t.Fatalf("failed to create savepoint %s: %v", sp, err)
    }
    h := &NestedTxHelper{tx: tx, savepoint: sp, t: t}
    t.Cleanup(func() {
        // Rollback to savepoint on test cleanup
        _, _ = tx.ExecContext(ctx, fmt.Sprintf("ROLLBACK TO SAVEPOINT %s", sp))
    })
    return h
}

func (h *NestedTxHelper) Commit(ctx context.Context) error {
    _, err := h.tx.ExecContext(ctx, fmt.Sprintf("RELEASE SAVEPOINT %s", h.savepoint))
    return err
}
```

### Custom sqlmock Matcher for Complex Arguments

```go
// testutil/matchers.go
package testutil

import (
    "database/sql/driver"
    "fmt"
    "time"
)

// TimeWithinDuration is a sqlmock argument matcher for timestamps
// that should be close to the current time
type TimeWithinDuration struct {
    Expected time.Time
    Delta    time.Duration
}

func (t TimeWithinDuration) Match(v driver.Value) bool {
    ts, ok := v.(time.Time)
    if !ok {
        return false
    }
    diff := ts.Sub(t.Expected)
    if diff < 0 {
        diff = -diff
    }
    return diff <= t.Delta
}

func AnyRecentTimestamp() TimeWithinDuration {
    return TimeWithinDuration{
        Expected: time.Now(),
        Delta:    5 * time.Second,
    }
}

// JSONMatcher matches a JSON string argument
type JSONMatcher struct {
    ExpectedKeys []string
}

func (j JSONMatcher) Match(v driver.Value) bool {
    str, ok := v.(string)
    if !ok {
        return false
    }
    for _, key := range j.ExpectedKeys {
        if !strings.Contains(str, key) {
            return false
        }
    }
    return true
}

func (j JSONMatcher) String() string {
    return fmt.Sprintf("JSON containing keys: %v", j.ExpectedKeys)
}
```

### Benchmarking Repository Operations

```go
// internal/repository/user_repository_bench_test.go
//go:build integration

package repository_test

import (
    "context"
    "fmt"
    "testing"

    "github.com/yourorg/yourapp/testutil"
    "github.com/yourorg/yourapp/internal/repository"
)

func BenchmarkUserRepository_Create(b *testing.B) {
    tdb := testutil.NewTestDatabase(b.(testing.TB).(*testing.T))
    repo := repository.NewPostgresUserRepository(tdb.DB)
    ctx := context.Background()

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            user := &repository.User{
                Email: fmt.Sprintf("bench%d@example.com", i),
                Name:  fmt.Sprintf("Bench User %d", i),
            }
            if err := repo.Create(ctx, user); err != nil {
                b.Errorf("Create failed: %v", err)
            }
            i++
        }
    })
}

func BenchmarkUserRepository_GetByID(b *testing.B) {
    tdb := testutil.NewTestDatabase(b.(testing.TB).(*testing.T))
    repo := repository.NewPostgresUserRepository(tdb.DB)
    ctx := context.Background()

    // Pre-create a user to fetch
    user := &repository.User{Email: "bench-get@example.com", Name: "Bench Get"}
    if err := repo.Create(ctx, user); err != nil {
        b.Fatalf("setup failed: %v", err)
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        if _, err := repo.GetByID(ctx, user.ID); err != nil {
            b.Errorf("GetByID failed: %v", err)
        }
    }
}
```

## Running the Tests

### Makefile Targets

```makefile
# Makefile

.PHONY: test test-unit test-integration test-coverage

# Run unit tests only (fast, no external dependencies)
test-unit:
	go test ./... -short -race -count=1 -timeout 60s

# Run integration tests (requires Docker)
test-integration:
	go test ./... -tags=integration -race -count=1 -timeout 300s

# Run all tests with coverage
test-coverage:
	go test ./... -tags=integration -race -coverprofile=coverage.out -covermode=atomic
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# Run tests and output junit-compatible XML for CI
test-ci:
	go test ./... -tags=integration -v -json 2>&1 | tee test-output.json
```

### CI Pipeline Configuration

```yaml
# .github/workflows/test.yml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          cache: true

      - name: Run unit tests
        run: make test-unit

      - name: Upload coverage
        uses: codecov/codecov-action@v4

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          cache: true

      # testcontainers handles Docker automatically
      - name: Run integration tests
        run: make test-integration
        env:
          TESTCONTAINERS_RYUK_DISABLED: false
          DOCKER_HOST: unix:///var/run/docker.sock
```

## Key Takeaways

Effective Go database testing requires discipline at each layer:

1. **Unit tests with sqlmock** test your SQL construction, error handling, and result mapping. They run in under a second and catch logic errors before you ever touch a database. Use `regexp.QuoteMeta` for exact query matching and `sqlmock.AnyArg()` for timestamps generated at call time.

2. **The DBTX interface** pattern enables both `*sql.DB` and `*sql.Tx` to be passed to repositories, making transaction testing natural. Every repository test can use a transaction that rolls back at cleanup, providing perfect isolation without table truncation.

3. **Testcontainers integration tests** catch what sqlmock cannot: constraint violations, index performance, PostgreSQL-specific behaviors, and bulk operation correctness. The shared container pattern with per-test transaction rollback gives you real database testing at near-unit-test speeds.

4. **gomock for service tests** ensures the service layer is tested in complete isolation. Unexpected calls fail the test immediately, preventing you from writing services that accidentally query the database in unnecessary ways.

5. **Never share state between tests** without transaction rollback or explicit cleanup. Flaky integration tests are almost always caused by test ordering dependencies.

The investment in this testing infrastructure pays dividends every time a SQL change is caught before deployment rather than after.
