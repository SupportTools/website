---
title: "Golang and PostgreSQL: Advanced Patterns for Production Applications"
date: 2026-08-06T09:00:00-05:00
draft: false
tags: ["Go", "PostgreSQL", "Database", "Connection Pooling", "Transactions", "Performance"]
categories: ["Database Optimization", "Go Programming"]
---

Go and PostgreSQL form a powerful foundation for building robust, high-performance applications. This combination delivers exceptional concurrency, reliability, and developer productivity when implemented correctly. However, building production-ready applications requires a deeper understanding of how these technologies interact, particularly around connection management, transaction handling, and performance tuning.

This comprehensive guide explores advanced patterns for working with PostgreSQL in Go applications, with a focus on real-world scenarios and production-ready implementations.

## Table of Contents

1. [Understanding the Go-PostgreSQL Relationship](#understanding-the-go-postgresql-relationship)
2. [Connection Pool Management](#connection-pool-management)
3. [Transaction Patterns](#transaction-patterns)
4. [Advanced Query Techniques](#advanced-query-techniques)
5. [Concurrency and Race Conditions](#concurrency-and-race-conditions)
6. [Error Handling and Retries](#error-handling-and-retries)
7. [Performance Monitoring and Optimization](#performance-monitoring-and-optimization)
8. [Migration and Schema Management](#migration-and-schema-management)
9. [Testing Database Code](#testing-database-code)
10. [Production Checklist](#production-checklist)

## Understanding the Go-PostgreSQL Relationship

Go and PostgreSQL complement each other remarkably well. Go's concurrency model and efficient resource utilization align with PostgreSQL's robust multi-version concurrency control (MVCC) system.

### Why This Combination Works

Go's strengths:
- Lightweight goroutines for managing concurrent database operations
- Built-in support for connection pooling via `database/sql`
- Strong static typing that helps prevent SQL errors
- Excellent performance characteristics for I/O-bound applications

PostgreSQL's strengths:
- Advanced transaction isolation levels
- Robust concurrency without excessive locking
- Rich feature set including JSON support, full-text search, and extensibility
- Strong data integrity guarantees

### Driver Options

Two main libraries dominate the Go-PostgreSQL landscape:

1. **`lib/pq`**: The original PostgreSQL driver for Go's `database/sql`
   - Stable and widely adopted
   - Pure Go implementation
   - Being gradually replaced by pgx

2. **`pgx`**: Modern PostgreSQL driver with advanced features
   - Better performance
   - Support for PostgreSQL-specific features
   - Can be used with or without the standard `database/sql` interface

For most new projects, `pgx` is the recommended choice:

```go
import (
    "context"
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// Using pgx directly (without database/sql)
func connectWithPgx() (*pgxpool.Pool, error) {
    ctx := context.Background()
    connString := "postgres://username:password@localhost:5432/database_name"
    
    config, err := pgxpool.ParseConfig(connString)
    if err != nil {
        return nil, err
    }
    
    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, err
    }
    
    return pool, nil
}
```

Or with the standard `database/sql` interface:

```go
import (
    "database/sql"
    _ "github.com/jackc/pgx/v5/stdlib"
)

// Using pgx with database/sql interface
func connectWithDatabaseSQL() (*sql.DB, error) {
    connString := "postgres://username:password@localhost:5432/database_name"
    
    db, err := sql.Open("pgx", connString)
    if err != nil {
        return nil, err
    }
    
    // Configure pool settings
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    db.SetConnMaxLifetime(5 * time.Minute)
    
    return db, nil
}
```

## Connection Pool Management

Connection pool management is critical for application performance and stability. Both PostgreSQL and your application have limits on how many concurrent connections they can handle effectively.

### Understanding `sql.Open()`

A common misconception: `sql.Open()` doesn't establish a connection immediately. It creates a pool manager that will establish connections on demand:

```go
// This doesn't connect yet - it just sets up the pool
db, err := sql.Open("pgx", connString)
if err != nil {
    log.Fatalf("Failed to create database pool: %v", err)
}

// The first actual connection is established here
err = db.Ping()
if err != nil {
    log.Fatalf("Failed to ping database: %v", err)
}
```

### Optimal Pool Configuration

The right pool size depends on your application's requirements, but a good starting point is:

```go
// Configure connection pool
db.SetMaxOpenConns(25)     // Maximum number of open connections to the database
db.SetMaxIdleConns(25)     // Maximum number of idle connections in the pool
db.SetConnMaxLifetime(5 * time.Minute) // Maximum lifetime of a connection
```

These settings should align with:

1. **PostgreSQL's `max_connections`**: Typically 100-200 in default configurations
2. **Application instance count**: If you have 4 app instances, each should use at most 25% of Postgres's max connections
3. **Request patterns**: Spiky vs. consistent traffic

### Connection Pool Math

Calculating optimal connection pool size:

```
Optimal Pool Size = C / (R * L)

Where:
C = Number of CPU cores on the database server
R = Request time spent in database (ratio between 0 and 1)
L = Number of application instances
```

For example:
- 8 CPU cores
- Requests spend ~30% of time in database (R = 0.3)
- 4 application instances

Optimal pool size = 8 / (0.3 * 4) ≈ 6-7 connections per instance

### Advanced Pool Configuration with pgx

For more control, use `pgxpool` directly:

```go
config, _ := pgxpool.ParseConfig(connString)

// Fine-tune connection pool
config.MaxConns = 25
config.MinConns = 5  // Maintain at least 5 connections
config.MaxConnLifetime = 5 * time.Minute
config.MaxConnIdleTime = 30 * time.Second
config.HealthCheckPeriod = 1 * time.Minute

// Create pool with context
pool, err := pgxpool.NewWithConfig(context.Background(), config)
```

### Connection Pool Antipatterns

Avoid these common mistakes:

1. **Setting `MaxOpenConns` too high**: Leads to excessive database server load
2. **Setting `MaxIdleConns` too low**: Causes frequent connection creation/teardown
3. **Not setting `ConnMaxLifetime`**: Can lead to stale connections
4. **Using a global transaction for long operations**: Ties up connections unnecessarily

## Transaction Patterns

Handling transactions correctly is essential for data integrity. Let's explore several transaction patterns.

### Basic Transaction Pattern

The standard Go transaction pattern:

```go
tx, err := db.BeginTx(ctx, nil)
if err != nil {
    return err
}
defer tx.Rollback() // Rollback if not committed

// Execute multiple statements...
_, err = tx.ExecContext(ctx, "UPDATE accounts SET balance = balance - $1 WHERE id = $2", amount, fromID)
if err != nil {
    return err
}

_, err = tx.ExecContext(ctx, "UPDATE accounts SET balance = balance + $1 WHERE id = $2", amount, toID)
if err != nil {
    return err
}

// Commit the transaction
return tx.Commit()
```

Note the important `defer tx.Rollback()` - this ensures the transaction is rolled back if not explicitly committed, preventing connection leaks.

### Transaction Helper Function

A more elegant approach is to create a transaction helper:

```go
// WithTransaction executes a function within a transaction
func WithTransaction(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    
    defer func() {
        if p := recover(); p != nil {
            tx.Rollback()
            panic(p) // Re-throw panic after rollback
        } else if err != nil {
            tx.Rollback() // Rollback on error
        } else {
            err = tx.Commit() // Commit if no error
        }
    }()
    
    err = fn(tx)
    return err
}
```

This simplifies transaction usage:

```go
err := WithTransaction(ctx, db, func(tx *sql.Tx) error {
    // Execute operations within the transaction
    _, err := tx.ExecContext(ctx, "UPDATE accounts SET balance = balance - $1 WHERE id = $2", amount, fromID)
    if err != nil {
        return err
    }
    
    _, err = tx.ExecContext(ctx, "UPDATE accounts SET balance = balance + $1 WHERE id = $2", amount, toID)
    if err != nil {
        return err
    }
    
    return nil
})
```

### Transactions with pgx

With pgx, transactions are even cleaner:

```go
err := pool.BeginTxFunc(ctx, pgx.TxOptions{}, func(tx pgx.Tx) error {
    // Execute operations within the transaction
    _, err := tx.Exec(ctx, "UPDATE accounts SET balance = balance - $1 WHERE id = $2", amount, fromID)
    if err != nil {
        return err
    }
    
    _, err = tx.Exec(ctx, "UPDATE accounts SET balance = balance + $1 WHERE id = $2", amount, toID)
    if err != nil {
        return err
    }
    
    return nil
})
```

### Transaction Isolation Levels

PostgreSQL supports different isolation levels, which you can specify:

```go
// With database/sql
tx, err := db.BeginTx(ctx, &sql.TxOptions{
    Isolation: sql.LevelSerializable,
    ReadOnly:  false,
})

// With pgx
tx, err := pool.BeginTx(ctx, pgx.TxOptions{
    IsoLevel: pgx.Serializable,
    AccessMode: pgx.ReadWrite,
})
```

Common isolation levels:
- `LevelDefault` (READ COMMITTED in PostgreSQL)
- `LevelReadUncommitted` (Treated as READ COMMITTED in PostgreSQL)
- `LevelReadCommitted`
- `LevelRepeatableRead`
- `LevelSerializable`

### Savepoints for Nested Transactions

PostgreSQL supports savepoints for partial rollbacks:

```go
// Begin the main transaction
tx, err := db.BeginTx(ctx, nil)
if err != nil {
    return err
}
defer tx.Rollback()

// Execute first operation
_, err = tx.ExecContext(ctx, "UPDATE users SET status = 'active' WHERE id = $1", userID)
if err != nil {
    return err
}

// Create a savepoint
_, err = tx.ExecContext(ctx, "SAVEPOINT user_update")
if err != nil {
    return err
}

// Execute additional operations that might fail
_, err = tx.ExecContext(ctx, "UPDATE user_stats SET login_count = login_count + 1 WHERE user_id = $1", userID)
if err != nil {
    // Roll back to savepoint only, keeping the status update
    _, rbErr := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT user_update")
    if rbErr != nil {
        return fmt.Errorf("failed to rollback to savepoint: %v (original error: %w)", rbErr, err)
    }
    // Continue with the transaction, ignoring the stats update error
}

// Commit the transaction
return tx.Commit()
```

## Advanced Query Techniques

Beyond basic CRUD operations, PostgreSQL offers powerful features that Go can leverage.

### Batch Operations

For bulk operations, use parameter arrays with the pgx driver:

```go
// Bulk insert with pgx
rows := [][]interface{}{
    {"John", "john@example.com"},
    {"Alice", "alice@example.com"},
    {"Bob", "bob@example.com"},
}

// Execute batch insert
batch := &pgx.Batch{}
for _, row := range rows {
    batch.Queue("INSERT INTO users(name, email) VALUES($1, $2)", row[0], row[1])
}

br := pool.SendBatch(ctx, batch)
defer br.Close()

// Check each result
for i := 0; i < batch.Len(); i++ {
    if _, err := br.Exec(); err != nil {
        log.Printf("Error inserting row %d: %v", i, err)
    }
}
```

For `database/sql`, use multiple value expressions in a single query:

```go
// Build the query
valueStrings := make([]string, len(users))
valueArgs := make([]interface{}, len(users) * 2)
for i, user := range users {
    valueStrings[i] = fmt.Sprintf("($%d, $%d)", i*2+1, i*2+2)
    valueArgs[i*2] = user.Name
    valueArgs[i*2+1] = user.Email
}
stmt := fmt.Sprintf("INSERT INTO users(name, email) VALUES %s", 
    strings.Join(valueStrings, ","))

// Execute the query
_, err := db.ExecContext(ctx, stmt, valueArgs...)
```

### Working with JSONB

PostgreSQL's JSONB type is perfect for semi-structured data:

```go
type User struct {
    ID       int            `json:"id"`
    Name     string         `json:"name"`
    Email    string         `json:"email"`
    Metadata json.RawMessage `json:"metadata"`
}

// Insert user with JSONB metadata
metadata := json.RawMessage(`{"preferences":{"theme":"dark","notifications":true}}`)
_, err := db.ExecContext(ctx, 
    "INSERT INTO users(name, email, metadata) VALUES($1, $2, $3)",
    "John", "john@example.com", metadata)

// Query with JSONB conditions
rows, err := db.QueryContext(ctx, 
    "SELECT id, name, email, metadata FROM users WHERE metadata->>'preferences'->>'theme' = $1",
    "dark")
defer rows.Close()

var users []User
for rows.Next() {
    var user User
    if err := rows.Scan(&user.ID, &user.Name, &user.Email, &user.Metadata); err != nil {
        log.Printf("Error scanning user: %v", err)
        continue
    }
    users = append(users, user)
}
```

### Streaming Large Result Sets

For large result sets, process rows as they arrive rather than loading everything into memory:

```go
rows, err := db.QueryContext(ctx, "SELECT id, data FROM large_table")
if err != nil {
    return err
}
defer rows.Close()

// Process rows one at a time
for rows.Next() {
    var id int
    var data []byte
    if err := rows.Scan(&id, &data); err != nil {
        return err
    }
    
    // Process each row without storing all in memory
    processData(id, data)
}

// Check for errors from iterating over rows
if err := rows.Err(); err != nil {
    return err
}
```

### Using COPY for Bulk Data

For massive imports, use PostgreSQL's COPY protocol with pgx:

```go
// Open a COPY stream
copyCount, err := pool.CopyFrom(
    ctx,
    pgx.Identifier{"users"},
    []string{"name", "email"},
    pgx.CopyFromSlice(len(users), func(i int) ([]interface{}, error) {
        return []interface{}{users[i].Name, users[i].Email}, nil
    }),
)
```

## Concurrency and Race Conditions

Go's concurrency model and PostgreSQL's MVCC make a great combination, but careful handling is still required.

### Understanding Concurrency Challenges

Common race conditions with databases:
1. **Lost updates**: Two transactions read and update the same row simultaneously
2. **Dirty reads**: Reading uncommitted data (prevented by PostgreSQL's isolation)
3. **Non-repeatable reads**: Getting different results within the same transaction
4. **Phantom reads**: New rows appearing in repeated queries

### Optimistic Concurrency Control

Use version numbers or timestamps to detect conflicts:

```go
// Optimistic locking with a version column
func updateUserOptimistic(ctx context.Context, db *sql.DB, user User) error {
    return WithTransaction(ctx, db, func(tx *sql.Tx) error {
        // Try to update with version check
        result, err := tx.ExecContext(ctx,
            "UPDATE users SET name = $1, email = $2, version = version + 1 "+
            "WHERE id = $3 AND version = $4",
            user.Name, user.Email, user.ID, user.Version)
        if err != nil {
            return err
        }
        
        // Check if the update succeeded
        affected, err := result.RowsAffected()
        if err != nil {
            return err
        }
        
        if affected == 0 {
            return fmt.Errorf("optimistic lock failure: user %d was modified", user.ID)
        }
        
        // Update succeeded, increment version locally
        user.Version++
        return nil
    })
}
```

### Pessimistic Locking with SELECT FOR UPDATE

Lock rows explicitly before modifying them:

```go
func transferFunds(ctx context.Context, db *sql.DB, fromID, toID int, amount float64) error {
    return WithTransaction(ctx, db, func(tx *sql.Tx) error {
        // Lock both accounts in a consistent order to prevent deadlocks
        // Always lock lowest ID first
        firstID, secondID := fromID, toID
        if toID < fromID {
            firstID, secondID = toID, fromID
        }
        
        // Lock the rows for update
        var balance1, balance2 float64
        err := tx.QueryRowContext(ctx, 
            "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE", 
            firstID).Scan(&balance1)
        if err != nil {
            return err
        }
        
        err = tx.QueryRowContext(ctx, 
            "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE", 
            secondID).Scan(&balance2)
        if err != nil {
            return err
        }
        
        // Now we have exclusive locks on both rows
        // Check sufficient funds
        if fromID == firstID {
            if balance1 < amount {
                return fmt.Errorf("insufficient funds")
            }
        } else {
            if balance2 < amount {
                return fmt.Errorf("insufficient funds")
            }
        }
        
        // Perform the transfers
        _, err = tx.ExecContext(ctx, 
            "UPDATE accounts SET balance = balance - $1 WHERE id = $2", 
            amount, fromID)
        if err != nil {
            return err
        }
        
        _, err = tx.ExecContext(ctx, 
            "UPDATE accounts SET balance = balance + $1 WHERE id = $2", 
            amount, toID)
        if err != nil {
            return err
        }
        
        return nil
    })
}
```

### Advisory Locks for Application-Level Locking

PostgreSQL's advisory locks can coordinate processes across multiple application instances:

```go
func acquireJobExclusively(ctx context.Context, db *sql.DB, jobID int) error {
    // Try to acquire an advisory lock
    var acquired bool
    err := db.QueryRowContext(ctx, 
        "SELECT pg_try_advisory_lock($1)", jobID).Scan(&acquired)
    if err != nil {
        return err
    }
    
    if !acquired {
        return fmt.Errorf("job %d is already being processed", jobID)
    }
    
    // We have the lock, do work here...
    
    // When done, release the lock
    _, err = db.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", jobID)
    return err
}
```

## Error Handling and Retries

Robust error handling is essential for production applications.

### Categorizing Database Errors

Different errors require different handling:

```go
// With pgx v5
import (
    "github.com/jackc/pgx/v5/pgconn"
)

// Handle different PostgreSQL errors
func handleDBError(err error) error {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        switch pgErr.Code {
        case "23505": // unique_violation
            return fmt.Errorf("record already exists: %w", err)
        case "23503": // foreign_key_violation
            return fmt.Errorf("related record not found: %w", err)
        case "23502": // not_null_violation
            return fmt.Errorf("missing required field: %w", err)
        case "42P01": // undefined_table
            return fmt.Errorf("database schema error: %w", err)
        case "40001": // serialization_failure
            return fmt.Errorf("transaction conflict, please retry: %w", err)
        default:
            return fmt.Errorf("database error: %w", err)
        }
    }
    
    // Handle other error types
    if errors.Is(err, context.DeadlineExceeded) {
        return fmt.Errorf("database timeout: %w", err)
    }
    if errors.Is(err, context.Canceled) {
        return fmt.Errorf("operation canceled: %w", err)
    }
    
    return fmt.Errorf("unexpected error: %w", err)
}
```

### Implementing Retry Logic

Some errors are transient and benefit from retry logic:

```go
func withRetry(maxAttempts int, fn func() error) error {
    var err error
    for attempt := 1; attempt <= maxAttempts; attempt++ {
        err = fn()
        if err == nil {
            return nil
        }
        
        // Check if error is retryable
        var pgErr *pgconn.PgError
        if errors.As(err, &pgErr) && pgErr.Code == "40001" { // serialization_failure
            // Exponential backoff with jitter
            backoff := time.Duration(math.Pow(2, float64(attempt))) * time.Millisecond * 50
            jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
            backoff = backoff + jitter
            
            log.Printf("Retrying after serialization failure (attempt %d/%d) in %v", 
                attempt, maxAttempts, backoff)
            time.Sleep(backoff)
            continue
        }
        
        // Non-retryable error
        return err
    }
    
    return fmt.Errorf("operation failed after %d attempts: %w", maxAttempts, err)
}

// Usage
err := withRetry(3, func() error {
    return WithTransaction(ctx, db, func(tx *sql.Tx) error {
        // Transaction logic here...
    })
})
```

### Context Timeout for Query Limits

Always use contexts with timeouts for database operations:

```go
func getUserWithTimeout(userID int) (User, error) {
    // Create a timeout context
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel()
    
    var user User
    err := db.QueryRowContext(ctx, 
        "SELECT id, name, email FROM users WHERE id = $1", userID).
        Scan(&user.ID, &user.Name, &user.Email)
    if err != nil {
        return User{}, err
    }
    
    return user, nil
}
```

## Performance Monitoring and Optimization

Understanding database performance requires proper instrumentation.

### Instrumenting Database Calls

Track database metrics in your application:

```go
func queryWithMetrics(ctx context.Context, db *sql.DB, query string, args ...interface{}) (*sql.Rows, error) {
    // Start timer
    startTime := time.Now()
    
    // Execute query
    rows, err := db.QueryContext(ctx, query, args...)
    
    // Record metrics
    duration := time.Since(startTime)
    metrics.RecordDBQuery(query, duration, err != nil)
    
    // Log slow queries
    if duration > 100*time.Millisecond {
        log.Printf("SLOW QUERY (%s): %s %v", duration, query, args)
    }
    
    return rows, err
}
```

### Monitoring Connection Pool Usage

Track connection pool statistics:

```go
func logDBStats(db *sql.DB) {
    stats := db.Stats()
    log.Printf("DB Stats: Open=%d, InUse=%d, Idle=%d, WaitCount=%d, WaitDuration=%s",
        stats.OpenConnections,
        stats.InUse,
        stats.Idle,
        stats.WaitCount,
        stats.WaitDuration,
    )
}

func monitorDBPool(db *sql.DB, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    
    for range ticker.C {
        logDBStats(db)
    }
}

// Start monitoring
go monitorDBPool(db, 30*time.Second)
```

### Identifying Slow Queries

Enable query logging in PostgreSQL:

```sql
-- In postgresql.conf
log_min_duration_statement = 200  -- Log queries taking longer than 200ms
```

Use `pg_stat_statements` to identify frequently slow queries:

```sql
-- Install the extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Query to find slow queries
SELECT 
    query,
    calls,
    total_exec_time / calls as avg_exec_time_ms,
    rows / calls as avg_rows,
    shared_blks_hit + shared_blks_read as io_blocks
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

## Migration and Schema Management

Managing database schema changes is a critical aspect of application maintenance.

### Using Migration Tools

Several excellent migration tools work well with Go:

1. **golang-migrate/migrate**:

```go
import (
    "github.com/golang-migrate/migrate/v4"
    _ "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
)

func runMigrations(dbURL, migrationsPath string) error {
    m, err := migrate.New(
        "file://"+migrationsPath,
        dbURL,
    )
    if err != nil {
        return err
    }
    
    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return err
    }
    
    return nil
}
```

2. **pressly/goose**:

```go
import (
    "database/sql"
    "github.com/pressly/goose/v3"
)

func runGooseMigrations(db *sql.DB, migrationsDir string) error {
    goose.SetBaseFS(embedMigrations)
    
    if err := goose.SetDialect("postgres"); err != nil {
        return err
    }
    
    if err := goose.Up(db, migrationsDir); err != nil {
        return err
    }
    
    return nil
}
```

### Schema Change Best Practices

When deploying schema changes:

1. **Make additive changes first**: Add columns before requiring them
2. **Use transactions for consistency**: Multiple related changes should be atomic
3. **Consider downtime requirements**: Some changes can be made online, others require downtime
4. **Separate data migration from schema changes**: Change schema first, then migrate data

Example migration files:

```sql
-- 001_create_users.sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 002_add_user_status.sql
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';

-- 003_add_status_index.sql
CREATE INDEX idx_users_status ON users(status);
```

## Testing Database Code

Proper testing of database code ensures reliability.

### Using Test Containers

Use temporary containers for integration tests:

```go
import (
    "context"
    "database/sql"
    "testing"
    
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

func setupTestDatabase(t *testing.T) (*sql.DB, func()) {
    t.Helper()
    
    ctx := context.Background()
    
    // Create container request
    req := testcontainers.ContainerRequest{
        Image:        "postgres:14",
        ExposedPorts: []string{"5432/tcp"},
        Env: map[string]string{
            "POSTGRES_PASSWORD": "testpassword",
            "POSTGRES_USER":     "testuser",
            "POSTGRES_DB":       "testdb",
        },
        WaitingFor: wait.ForLog("database system is ready to accept connections"),
    }
    
    // Start container
    container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: req,
        Started:          true,
    })
    if err != nil {
        t.Fatalf("Failed to start container: %v", err)
    }
    
    // Get host and port
    host, err := container.Host(ctx)
    if err != nil {
        t.Fatalf("Failed to get container host: %v", err)
    }
    
    port, err := container.MappedPort(ctx, "5432")
    if err != nil {
        t.Fatalf("Failed to get container port: %v", err)
    }
    
    // Create connection string and connect
    connString := fmt.Sprintf("postgres://testuser:testpassword@%s:%s/testdb?sslmode=disable", 
        host, port.Port())
    
    db, err := sql.Open("pgx", connString)
    if err != nil {
        t.Fatalf("Failed to connect to database: %v", err)
    }
    
    // Return database connection and cleanup function
    cleanup := func() {
        db.Close()
        container.Terminate(ctx)
    }
    
    return db, cleanup
}

func TestUserRepository(t *testing.T) {
    db, cleanup := setupTestDatabase(t)
    defer cleanup()
    
    // Create schema
    _, err := db.Exec(`
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL
        )
    `)
    if err != nil {
        t.Fatalf("Failed to create test table: %v", err)
    }
    
    // Run tests using the database...
    repo := NewUserRepository(db)
    
    // Test creating a user
    user, err := repo.Create(context.Background(), User{Name: "Test User", Email: "test@example.com"})
    if err != nil {
        t.Fatalf("Failed to create user: %v", err)
    }
    
    if user.ID == 0 {
        t.Error("Expected user ID to be set")
    }
    
    // More test assertions...
}
```

### Using Database Mocks

For unit tests, consider mocking the database:

```go
import (
    "github.com/DATA-DOG/go-sqlmock"
)

func TestUserService_GetUser(t *testing.T) {
    // Create SQL mock
    db, mock, err := sqlmock.New()
    if err != nil {
        t.Fatalf("Failed to create mock: %v", err)
    }
    defer db.Close()
    
    // Set up expectations
    rows := sqlmock.NewRows([]string{"id", "name", "email"}).
        AddRow(1, "Test User", "test@example.com")
    
    mock.ExpectQuery("SELECT id, name, email FROM users WHERE id = \\$1").
        WithArgs(1).
        WillReturnRows(rows)
    
    // Create repository with mock DB
    repo := NewUserRepository(db)
    service := NewUserService(repo)
    
    // Test the service
    user, err := service.GetUser(context.Background(), 1)
    if err != nil {
        t.Fatalf("Failed to get user: %v", err)
    }
    
    // Verify results
    if user.ID != 1 || user.Name != "Test User" || user.Email != "test@example.com" {
        t.Errorf("Unexpected user: %+v", user)
    }
    
    // Verify all expectations were met
    if err := mock.ExpectationsWereMet(); err != nil {
        t.Errorf("Unfulfilled expectations: %v", err)
    }
}
```

### Transaction Testing

Test transaction behavior with a real database:

```go
func TestTransactionRollback(t *testing.T) {
    db, cleanup := setupTestDatabase(t)
    defer cleanup()
    
    // Create test schema
    _, err := db.Exec(`
        CREATE TABLE accounts (
            id SERIAL PRIMARY KEY,
            balance DECIMAL NOT NULL
        )
    `)
    if err != nil {
        t.Fatalf("Failed to create test table: %v", err)
    }
    
    // Insert test data
    _, err = db.Exec("INSERT INTO accounts (balance) VALUES (100), (100)")
    if err != nil {
        t.Fatalf("Failed to insert test data: %v", err)
    }
    
    // Test transaction with intentional error
    err = WithTransaction(context.Background(), db, func(tx *sql.Tx) error {
        // First update succeeds
        _, err := tx.Exec("UPDATE accounts SET balance = balance - 50 WHERE id = 1")
        if err != nil {
            return err
        }
        
        // Check balance of first account (should be 50 within transaction)
        var balance float64
        err = tx.QueryRow("SELECT balance FROM accounts WHERE id = 1").Scan(&balance)
        if err != nil {
            return err
        }
        
        if balance != 50 {
            t.Errorf("Expected balance to be 50, got %f", balance)
        }
        
        // Return error to trigger rollback
        return errors.New("intentional error to trigger rollback")
    })
    
    // Verify error was returned
    if err == nil {
        t.Fatal("Expected error, got nil")
    }
    
    // Verify that changes were rolled back
    var balance float64
    err = db.QueryRow("SELECT balance FROM accounts WHERE id = 1").Scan(&balance)
    if err != nil {
        t.Fatalf("Failed to query balance: %v", err)
    }
    
    if balance != 100 {
        t.Errorf("Expected balance to be rolled back to 100, got %f", balance)
    }
}
```

## Production Checklist

Before deploying to production, ensure your Go-PostgreSQL integration is properly configured:

### Connection Pool Configuration

- [ ] **Maximum connections are set** appropriate to your workload
- [ ] **Connection lifetimes are limited** to avoid stale connections
- [ ] **Health checks are enabled** to detect and remove bad connections

### Query Performance and Safety

- [ ] **Prepared statements** are used for repeated queries
- [ ] **Transaction helper functions** are implemented
- [ ] **Parametrized queries** are used to prevent SQL injection
- [ ] **Complex queries are optimized** and verified with EXPLAIN
- [ ] **Index usage is verified** for common queries

### Error Handling and Resilience

- [ ] **Connection failures are handled gracefully** with reconnection logic
- [ ] **Deadlock and serialization errors** have retry mechanisms
- [ ] **Context timeouts** are implemented for all database operations
- [ ] **Panic recovery** is implemented for database operations

### Monitoring and Observability

- [ ] **Query performance is tracked** with timing metrics
- [ ] **Slow query logging** is enabled
- [ ] **Connection pool statistics** are monitored
- [ ] **Error rates** are tracked and alerted on

### Schema and Migration

- [ ] **Database migrations** are versioned and automated
- [ ] **Backward compatibility** is maintained for rolling deployments
- [ ] **Schema changes** are tested with production-like data volumes

### Testing

- [ ] **Unit tests** cover repository logic
- [ ] **Integration tests** verify database interaction
- [ ] **Performance tests** validate query efficiency
- [ ] **Concurrency tests** check for race conditions

## Conclusion

The relationship between Go and PostgreSQL can indeed be considered a "love story" when implemented correctly. Both technologies prioritize performance, reliability, and developer productivity, making them an excellent match for modern backend applications.

By following the patterns and practices outlined in this guide, you can build Go applications that leverage PostgreSQL's rich feature set while maintaining excellent performance characteristics. The key takeaways are:

1. **Properly manage connection pools** to avoid resource exhaustion
2. **Implement robust transaction patterns** to ensure data integrity
3. **Handle errors appropriately** with proper categorization and retry logic
4. **Monitor performance** to identify and address bottlenecks
5. **Test thoroughly** using both unit and integration tests

When these principles are applied, Go and PostgreSQL form a solid foundation that can scale to handle enterprise-level workloads while remaining maintainable and efficient.

---

*What are your experiences with Go and PostgreSQL in production? Share your insights, challenges, or additional patterns in the comments below!*