---
title: "Go Database Connection Pooling: pgx, sqlx, and GORM Performance at Scale"
date: 2030-12-25T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "PostgreSQL", "pgx", "sqlx", "GORM", "Database", "Connection Pooling", "Performance"]
categories:
- Go
- Database
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go database connection pooling with pgx, sqlx, and GORM, covering pool configuration, connection lifecycle management, prepared statements, query timeouts, read replica routing, and eliminating N+1 query patterns in production PostgreSQL deployments."
more_link: "yes"
url: "/go-database-connection-pooling-pgx-sqlx-gorm-performance/"
---

Database connection management is one of the most consequential performance decisions in a Go application. A misconfigured connection pool causes cascading failures under load: connection exhaustion leads to request timeouts, which causes retries, which exhausts the pool further. Getting connection pooling right requires understanding the difference between application-level pools (pgx, database/sql) and database-level connection limits, how to tune each, and how to route read traffic to replicas. This guide covers production patterns for all three major Go database libraries.

<!--more-->

# Go Database Connection Pooling: pgx, sqlx, and GORM Performance at Scale

## The Connection Pooling Fundamentals

Every database connection has a cost: TCP handshake, TLS negotiation, authentication, and memory on both the client and server side. PostgreSQL allocates roughly 5-10MB of shared memory per connection. A PostgreSQL server configured with `max_connections=200` supports 200 concurrent connections total across all application instances.

The key insight is that connection pools work at two levels:
1. **Application pool**: Managed by pgx or database/sql, reuses connections within a single process
2. **Database pool** (PgBouncer, RDS Proxy): Multiplexes many application connections to fewer database connections

For Go microservices running in Kubernetes with 10 pods each holding 20 connections, you have 200 connections from a single service - often hitting `max_connections` before accounting for other services, monitoring agents, or replica connections.

## pgx: Native PostgreSQL Driver

pgx is the highest-performance option for Go and PostgreSQL. Unlike the `database/sql` driver interface (which pgx also implements), the native `pgxpool` provides direct access to PostgreSQL-specific features.

### pgxpool Configuration

```go
package database

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

// Config holds database connection pool configuration
type Config struct {
    Host            string
    Port            int
    Database        string
    Username        string
    Password        string
    SSLMode         string

    // Pool sizing
    MaxConns        int32         // Maximum connections in pool
    MinConns        int32         // Minimum idle connections maintained
    MaxConnLifetime time.Duration // Max lifetime before connection is closed
    MaxConnIdleTime time.Duration // Max idle time before connection is closed

    // Health checking
    HealthCheckPeriod time.Duration

    // Query defaults
    StatementCacheCapacity int   // How many prepared statements to cache
    DescriptionCacheCapacity int // How many type descriptions to cache
}

// DefaultConfig returns production-appropriate defaults
func DefaultConfig() Config {
    return Config{
        SSLMode:                  "require",
        MaxConns:                 20,
        MinConns:                 5,
        MaxConnLifetime:          30 * time.Minute,
        MaxConnIdleTime:          5 * time.Minute,
        HealthCheckPeriod:        1 * time.Minute,
        StatementCacheCapacity:   512,
        DescriptionCacheCapacity: 512,
    }
}

// NewPool creates a configured pgxpool.Pool
func NewPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d dbname=%s user=%s password=%s sslmode=%s",
        cfg.Host, cfg.Port, cfg.Database, cfg.Username, cfg.Password, cfg.SSLMode,
    )

    poolCfg, err := pgxpool.ParseConfig(dsn)
    if err != nil {
        return nil, fmt.Errorf("parsing pool config: %w", err)
    }

    // Pool sizing
    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns
    poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
    poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

    // Connection lifecycle hooks for observability
    poolCfg.BeforeAcquire = func(ctx context.Context, conn *pgxpool.Conn) bool {
        // Called before a connection is given to a caller
        // Return false to destroy the connection instead of acquiring it
        return true
    }

    poolCfg.AfterRelease = func(conn *pgxpool.Conn) bool {
        // Called after a connection is released back to the pool
        // Return false to destroy the connection instead of returning it to the pool
        return true
    }

    poolCfg.BeforeClose = func(conn *pgxpool.Conn) {
        // Called before a connection is closed and removed from the pool
        slog.Debug("closing database connection",
            "pid", conn.Conn().PgConn().PID())
    }

    // Configure connection settings on acquisition
    poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
        // Set session parameters for each new connection
        _, err := conn.Exec(ctx, `
            SET application_name = 'myapp';
            SET statement_timeout = '30s';
            SET lock_timeout = '10s';
            SET idle_in_transaction_session_timeout = '60s';
        `)
        return err
    }

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil {
        return nil, fmt.Errorf("creating connection pool: %w", err)
    }

    // Verify connectivity
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return pool, nil
}
```

### Pool Sizing Strategy

Connection pool sizing is not one-size-fits-all. Use this formula as a starting point:

```
MaxConns = (numCPUs * 2) + numPods + headroom
```

For a PostgreSQL server with 16 vCPUs and 5 application pods:
```
MaxConns per pod = (16 * 2 + 5 + 5) / 5 = ~7-10 per pod
```

Total server connections used: 5 pods × 10 connections = 50 connections

```go
package database

import (
    "runtime"
    "strconv"
)

// CalculatePoolSize determines optimal pool size based on environment
func CalculatePoolSize(maxServerConns int, podCount int) int32 {
    cpus := runtime.NumCPU()

    // Per-pool maximum: server limit divided by pods, with buffer for overhead
    perPodMax := maxServerConns / podCount
    if perPodMax < 5 {
        perPodMax = 5 // Minimum viable pool size
    }

    // Practical limit: 2x CPUs works well for I/O-bound workloads
    cpuBased := cpus * 2

    if int32(cpuBased) < int32(perPodMax) {
        return int32(cpuBased)
    }
    return int32(perPodMax)
}
```

### Query Execution with pgxpool

```go
package repository

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
    ID        int64
    Username  string
    Email     string
    CreatedAt time.Time
    UpdatedAt time.Time
}

type UserRepository struct {
    pool *pgxpool.Pool
}

func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
    return &UserRepository{pool: pool}
}

// FindByID retrieves a user by ID with proper timeout handling
func (r *UserRepository) FindByID(ctx context.Context, id int64) (*User, error) {
    // Derive a query-specific timeout from the request context
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    user := &User{}
    err := r.pool.QueryRow(ctx, `
        SELECT id, username, email, created_at, updated_at
        FROM users
        WHERE id = $1
        AND deleted_at IS NULL
    `, id).Scan(
        &user.ID,
        &user.Username,
        &user.Email,
        &user.CreatedAt,
        &user.UpdatedAt,
    )

    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("querying user %d: %w", id, err)
    }

    return user, nil
}

// FindByIDs demonstrates batch loading to avoid N+1 queries
func (r *UserRepository) FindByIDs(ctx context.Context, ids []int64) (map[int64]*User, error) {
    if len(ids) == 0 {
        return map[int64]*User{}, nil
    }

    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    rows, err := r.pool.Query(ctx, `
        SELECT id, username, email, created_at, updated_at
        FROM users
        WHERE id = ANY($1)
        AND deleted_at IS NULL
    `, ids)
    if err != nil {
        return nil, fmt.Errorf("querying users by ids: %w", err)
    }
    defer rows.Close()

    users := make(map[int64]*User, len(ids))
    for rows.Next() {
        user := &User{}
        if err := rows.Scan(
            &user.ID,
            &user.Username,
            &user.Email,
            &user.CreatedAt,
            &user.UpdatedAt,
        ); err != nil {
            return nil, fmt.Errorf("scanning user row: %w", err)
        }
        users[user.ID] = user
    }

    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterating user rows: %w", err)
    }

    return users, nil
}

// CreateBatch inserts multiple users efficiently using COPY protocol
func (r *UserRepository) CreateBatch(ctx context.Context, users []*User) error {
    if len(users) == 0 {
        return nil
    }

    // Use pgx.CopyFrom for high-throughput inserts
    rows := make([][]interface{}, len(users))
    for i, u := range users {
        rows[i] = []interface{}{u.Username, u.Email}
    }

    _, err := r.pool.CopyFrom(
        ctx,
        pgx.Identifier{"users"},
        []string{"username", "email"},
        pgx.CopyFromRows(rows),
    )
    if err != nil {
        return fmt.Errorf("batch inserting users: %w", err)
    }

    return nil
}
```

### Prepared Statements with pgx

pgx automatically caches prepared statements (controlled by `StatementCacheCapacity`), but you can also manage them explicitly:

```go
package database

import (
    "context"

    "github.com/jackc/pgx/v5"
)

const (
    getUserByIDQuery    = "SELECT id, username, email FROM users WHERE id = $1"
    getUserByEmailQuery = "SELECT id, username, email FROM users WHERE email = $1"
    updateUserQuery     = "UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2"
)

// PrepareStatements pre-compiles frequently-used queries
// Call this after acquiring a connection, before using it
func PrepareStatements(ctx context.Context, conn *pgx.Conn) error {
    statements := []struct {
        name  string
        query string
    }{
        {"get_user_by_id", getUserByIDQuery},
        {"get_user_by_email", getUserByEmailQuery},
        {"update_user", updateUserQuery},
    }

    for _, s := range statements {
        if _, err := conn.Prepare(ctx, s.name, s.query); err != nil {
            return fmt.Errorf("preparing statement %s: %w", s.name, err)
        }
    }

    return nil
}
```

## database/sql with pgx Driver

For codebases that use `database/sql` (e.g., for compatibility with GORM or sqlx), pgx provides a `stdlib` adapter:

```go
package database

import (
    "database/sql"
    "time"

    "github.com/jackc/pgx/v5/stdlib"
)

// NewSQLDB creates a database/sql.DB with pgx driver and optimal pool settings
func NewSQLDB(dsn string) (*sql.DB, error) {
    db, err := sql.Open("pgx", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    // These settings are critical and often misconfigured
    db.SetMaxOpenConns(20)          // Maximum connections in pool
    db.SetMaxIdleConns(10)          // Keep connections warm
    db.SetConnMaxLifetime(30 * time.Minute) // Prevent stale connections
    db.SetConnMaxIdleTime(5 * time.Minute)  // Release unused connections

    if err := db.Ping(); err != nil {
        db.Close()
        return nil, fmt.Errorf("connecting to database: %w", err)
    }

    return db, nil
}
```

**Important**: The default `database/sql` pool settings are inappropriate for production:
- `MaxOpenConns` defaults to 0 (unlimited) - can overwhelm PostgreSQL
- `MaxIdleConns` defaults to 2 - wastes connection setup overhead
- `ConnMaxLifetime` defaults to 0 (forever) - causes issues with load balancers and firewalls

## sqlx: Enhanced database/sql

sqlx extends `database/sql` with struct scanning, named queries, and in-clause expansion:

```go
package repository

import (
    "context"
    "database/sql"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

// DB wraps sqlx.DB with application-specific behavior
type DB struct {
    primary  *sqlx.DB
    replicas []*sqlx.DB
    current  uint64 // For round-robin read distribution
}

func NewDB(primaryDSN string, replicaDSNs []string) (*DB, error) {
    primary, err := sqlx.Connect("pgx", primaryDSN)
    if err != nil {
        return nil, fmt.Errorf("connecting to primary: %w", err)
    }

    configureSQLPool(primary.DB)

    replicas := make([]*sqlx.DB, 0, len(replicaDSNs))
    for _, dsn := range replicaDSNs {
        replica, err := sqlx.Connect("pgx", dsn)
        if err != nil {
            return nil, fmt.Errorf("connecting to replica: %w", err)
        }
        configureSQLPool(replica.DB)
        replicas = append(replicas, replica)
    }

    return &DB{
        primary:  primary,
        replicas: replicas,
    }, nil
}

func configureSQLPool(db *sql.DB) {
    db.SetMaxOpenConns(20)
    db.SetMaxIdleConns(10)
    db.SetConnMaxLifetime(30 * time.Minute)
    db.SetConnMaxIdleTime(5 * time.Minute)
}

// ReadDB returns a replica for read operations with round-robin selection
func (db *DB) ReadDB() *sqlx.DB {
    if len(db.replicas) == 0 {
        return db.primary
    }
    n := atomic.AddUint64(&db.current, 1)
    return db.replicas[n%uint64(len(db.replicas))]
}

// WriteDB returns the primary for write operations
func (db *DB) WriteDB() *sqlx.DB {
    return db.primary
}

// User model with sqlx struct tags
type User struct {
    ID        int64     `db:"id"`
    Username  string    `db:"username"`
    Email     string    `db:"email"`
    Age       int       `db:"age"`
    Active    bool      `db:"active"`
    CreatedAt time.Time `db:"created_at"`
}

type UserRepositorySQLX struct {
    db *DB
}

// FindByID uses the read replica for a single user lookup
func (r *UserRepositorySQLX) FindByID(ctx context.Context, id int64) (*User, error) {
    user := &User{}
    err := r.db.ReadDB().GetContext(ctx, user, `
        SELECT id, username, email, age, active, created_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
    `, id)

    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("finding user by id: %w", err)
    }

    return user, nil
}

// FindActive uses the read replica with struct scanning
func (r *UserRepositorySQLX) FindActive(ctx context.Context, limit, offset int) ([]*User, error) {
    users := []*User{}
    err := r.db.ReadDB().SelectContext(ctx, &users, `
        SELECT id, username, email, age, active, created_at
        FROM users
        WHERE active = true AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
    `, limit, offset)

    if err != nil {
        return nil, fmt.Errorf("finding active users: %w", err)
    }

    return users, nil
}

// FindByIDs uses IN clause expansion via sqlx to avoid N+1
func (r *UserRepositorySQLX) FindByIDs(ctx context.Context, ids []int64) ([]*User, error) {
    if len(ids) == 0 {
        return []*User{}, nil
    }

    // sqlx.In expands the IN clause correctly
    query, args, err := sqlx.In(`
        SELECT id, username, email, age, active, created_at
        FROM users
        WHERE id IN (?) AND deleted_at IS NULL
    `, ids)
    if err != nil {
        return nil, fmt.Errorf("building IN query: %w", err)
    }

    // Rebind converts '?' to '$1, $2, ...' for PostgreSQL
    query = r.db.ReadDB().Rebind(query)

    users := []*User{}
    if err := r.db.ReadDB().SelectContext(ctx, &users, query, args...); err != nil {
        return nil, fmt.Errorf("querying users by ids: %w", err)
    }

    return users, nil
}

// CreateUser inserts with named parameters for clarity
func (r *UserRepositorySQLX) CreateUser(ctx context.Context, user *User) error {
    result, err := r.db.WriteDB().NamedExecContext(ctx, `
        INSERT INTO users (username, email, age, active)
        VALUES (:username, :email, :age, :active)
        RETURNING id, created_at
    `, user)

    if err != nil {
        return fmt.Errorf("inserting user: %w", err)
    }

    id, err := result.LastInsertId()
    if err != nil {
        return fmt.Errorf("getting insert id: %w", err)
    }
    user.ID = id
    return nil
}
```

## GORM Performance Optimization

GORM is the most popular Go ORM, but its default usage patterns lead to N+1 queries and inefficient connection usage. Here is how to use it correctly at scale:

### GORM Pool Configuration

```go
package database

import (
    "time"

    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/gorm/logger"
)

// NewGORMDB creates a production-configured GORM database
func NewGORMDB(dsn string) (*gorm.DB, error) {
    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
        // Custom logger that integrates with structured logging
        Logger: logger.New(
            slog.NewLogLogger(slog.Default().Handler(), slog.LevelWarn),
            logger.Config{
                SlowThreshold:             200 * time.Millisecond,
                LogLevel:                  logger.Warn,
                IgnoreRecordNotFoundError: true,
                ParameterizedQueries:      true, // Don't log parameter values
                Colorful:                  false,
            },
        ),

        // Performance options
        PrepareStmt:                              true, // Cache prepared statements
        DisableForeignKeyConstraintWhenMigrating: false,
        SkipDefaultTransaction:                   true, // Don't wrap queries in transactions
        QueryFields:                              false, // Don't use SELECT *
        CreateBatchSize:                          100,  // Batch inserts
    })

    if err != nil {
        return nil, fmt.Errorf("opening gorm database: %w", err)
    }

    // Configure the underlying sql.DB pool
    sqlDB, err := db.DB()
    if err != nil {
        return nil, fmt.Errorf("getting underlying sql.DB: %w", err)
    }

    sqlDB.SetMaxOpenConns(20)
    sqlDB.SetMaxIdleConns(10)
    sqlDB.SetConnMaxLifetime(30 * time.Minute)
    sqlDB.SetConnMaxIdleTime(5 * time.Minute)

    return db, nil
}
```

### Avoiding N+1 with Preloading

The most common GORM performance problem is N+1 queries - fetching N related records with N individual queries instead of one JOIN:

```go
package repository

import (
    "context"
    "time"

    "gorm.io/gorm"
)

type Post struct {
    gorm.Model
    Title    string
    Body     string
    AuthorID int64
    Author   User     `gorm:"foreignKey:AuthorID"`
    Tags     []Tag    `gorm:"many2many:post_tags;"`
    Comments []Comment `gorm:"foreignKey:PostID"`
}

type PostRepository struct {
    db *gorm.DB
}

// BAD: This causes N+1 queries
func (r *PostRepository) FindRecentPostsBad(ctx context.Context, limit int) ([]*Post, error) {
    var posts []*Post
    // This fetches posts in one query...
    if err := r.db.WithContext(ctx).Limit(limit).Find(&posts).Error; err != nil {
        return nil, err
    }
    // ...but GORM loads Author lazily, causing N queries for N posts!
    // Access to post.Author here triggers additional queries
    return posts, nil
}

// GOOD: Preload all associations in one or a few queries
func (r *PostRepository) FindRecentPosts(ctx context.Context, limit int) ([]*Post, error) {
    var posts []*Post
    err := r.db.WithContext(ctx).
        Preload("Author", func(db *gorm.DB) *gorm.DB {
            return db.Select("id, username, email") // Only load needed fields
        }).
        Preload("Tags").
        // DON'T preload Comments if you don't need them for this use case
        Order("created_at DESC").
        Limit(limit).
        Find(&posts).Error

    if err != nil {
        return nil, fmt.Errorf("finding recent posts: %w", err)
    }

    return posts, nil
}

// Joins is even more efficient for simple cases
func (r *PostRepository) FindPostsWithAuthor(ctx context.Context, limit int) ([]*Post, error) {
    var posts []*Post
    err := r.db.WithContext(ctx).
        Joins("Author").   // Single JOIN query instead of separate preload
        Order("posts.created_at DESC").
        Limit(limit).
        Find(&posts).Error

    return posts, err
}
```

### GORM with Read Replicas

```go
package database

import (
    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/plugin/dbresolver"
)

// NewGORMWithReplicas sets up primary/replica routing in GORM
func NewGORMWithReplicas(primaryDSN string, replicaDSNs []string) (*gorm.DB, error) {
    db, err := gorm.Open(postgres.Open(primaryDSN), &gorm.Config{
        PrepareStmt:            true,
        SkipDefaultTransaction: true,
    })
    if err != nil {
        return nil, err
    }

    // Build replica dialectors
    replicas := make([]gorm.Dialector, len(replicaDSNs))
    for i, dsn := range replicaDSNs {
        replicas[i] = postgres.Open(dsn)
    }

    // Configure DBResolver plugin for read/write splitting
    err = db.Use(dbresolver.Register(dbresolver.Config{
        Sources:           []gorm.Dialector{postgres.Open(primaryDSN)},
        Replicas:          replicas,
        Policy:            dbresolver.RandomPolicy{},
        TraceResolverMode: true,
    }).
        SetMaxIdleConns(10).
        SetMaxOpenConns(20).
        SetConnMaxLifetime(30 * time.Minute).
        SetConnMaxIdleTime(5 * time.Minute),
    )

    return db, err
}

// Forcing primary use for consistent reads after writes
func (r *PostRepository) CreateAndFetch(ctx context.Context, post *Post) (*Post, error) {
    // Write to primary
    if err := r.db.WithContext(ctx).Create(post).Error; err != nil {
        return nil, err
    }

    // Force primary read to avoid replication lag
    var created Post
    err := r.db.WithContext(ctx).
        Clauses(dbresolver.Write). // Force primary
        Preload("Author").
        First(&created, post.ID).Error

    return &created, err
}
```

### Batch Operations to Avoid N+1 Writes

```go
// Batch insert with GORM
func (r *PostRepository) CreateBatch(ctx context.Context, posts []*Post) error {
    // GORM's CreateInBatches uses multiple smaller INSERT statements
    return r.db.WithContext(ctx).
        CreateInBatches(posts, 100). // 100 records per batch
        Error
}

// Batch update using a single query
func (r *PostRepository) ArchivePosts(ctx context.Context, ids []int64) error {
    return r.db.WithContext(ctx).
        Model(&Post{}).
        Where("id IN ?", ids).
        Updates(map[string]interface{}{
            "archived":   true,
            "updated_at": time.Now(),
        }).Error
}

// Upsert to avoid separate SELECT + INSERT/UPDATE
func (r *PostRepository) UpsertPost(ctx context.Context, post *Post) error {
    return r.db.WithContext(ctx).
        Where(Post{Title: post.Title, AuthorID: post.AuthorID}).
        Assign(Post{Body: post.Body, UpdatedAt: time.Now()}).
        FirstOrCreate(post).Error
}
```

## Query Timeouts and Cancellation

### Context-Based Timeouts

```go
package repository

import (
    "context"
    "database/sql"
    "time"
)

// TimeoutMiddleware adds per-query timeouts based on query type
type TimeoutMiddleware struct {
    db *pgxpool.Pool
}

const (
    ReadTimeout      = 5 * time.Second
    WriteTimeout     = 10 * time.Second
    TransactionTimeout = 30 * time.Second
    BulkOperationTimeout = 120 * time.Second
)

// WithReadTimeout creates a context appropriate for read operations
func WithReadTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
    return context.WithTimeout(ctx, ReadTimeout)
}

// Transaction executes a function within a database transaction with timeout
func (m *TimeoutMiddleware) Transaction(
    ctx context.Context,
    fn func(ctx context.Context, tx pgx.Tx) error,
) error {
    txCtx, cancel := context.WithTimeout(ctx, TransactionTimeout)
    defer cancel()

    tx, err := m.db.Begin(txCtx)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    if err := fn(txCtx, tx); err != nil {
        if rbErr := tx.Rollback(txCtx); rbErr != nil {
            return fmt.Errorf("rolling back transaction after error %v: %w", err, rbErr)
        }
        return err
    }

    if err := tx.Commit(txCtx); err != nil {
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}
```

### Handling Query Cancellation

```go
package repository

import (
    "context"
    "errors"

    "github.com/jackc/pgx/v5/pgconn"
)

// IsQueryCanceled returns true if the error is due to context cancellation
func IsQueryCanceled(err error) bool {
    if err == nil {
        return false
    }
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        return true
    }
    // Check PostgreSQL error code for query_canceled
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        return pgErr.Code == "57014" // query_canceled
    }
    return false
}

// ExecuteWithRetry retries queries on transient errors
func ExecuteWithRetry(
    ctx context.Context,
    maxRetries int,
    fn func(ctx context.Context) error,
) error {
    var lastErr error
    for attempt := 0; attempt < maxRetries; attempt++ {
        if attempt > 0 {
            // Exponential backoff: 100ms, 200ms, 400ms...
            backoff := time.Duration(100*(1<<attempt)) * time.Millisecond
            select {
            case <-time.After(backoff):
            case <-ctx.Done():
                return ctx.Err()
            }
        }

        err := fn(ctx)
        if err == nil {
            return nil
        }

        // Don't retry on context cancellation
        if IsQueryCanceled(err) {
            return err
        }

        // Check for retryable PostgreSQL errors
        var pgErr *pgconn.PgError
        if errors.As(err, &pgErr) {
            switch pgErr.Code {
            case "40001": // serialization_failure (retry for serializable txns)
                lastErr = err
                continue
            case "40P01": // deadlock_detected
                lastErr = err
                continue
            }
        }

        // Non-retryable error
        return err
    }

    return fmt.Errorf("max retries exceeded: %w", lastErr)
}
```

## Connection Pool Observability

### Prometheus Metrics for Pool Monitoring

```go
package database

import (
    "database/sql"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    dbOpenConns = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "db_pool_open_connections",
        Help: "Number of open database connections",
    }, []string{"database"})

    dbInUseConns = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "db_pool_in_use_connections",
        Help: "Number of connections currently in use",
    }, []string{"database"})

    dbIdleConns = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "db_pool_idle_connections",
        Help: "Number of idle connections",
    }, []string{"database"})

    dbWaitCount = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "db_pool_wait_total",
        Help: "Total number of connections waited for",
    }, []string{"database"})

    dbWaitDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "db_pool_wait_duration_seconds",
        Help:    "Time spent waiting for a database connection",
        Buckets: []float64{.001, .005, .01, .05, .1, .5, 1, 2.5, 5, 10},
    }, []string{"database"})
)

// StartPoolMetricsCollector starts a goroutine that exports pool metrics
func StartPoolMetricsCollector(db *sql.DB, dbName string) func() {
    ticker := time.NewTicker(15 * time.Second)
    stop := make(chan struct{})

    go func() {
        for {
            select {
            case <-ticker.C:
                stats := db.Stats()
                dbOpenConns.WithLabelValues(dbName).Set(float64(stats.OpenConnections))
                dbInUseConns.WithLabelValues(dbName).Set(float64(stats.InUse))
                dbIdleConns.WithLabelValues(dbName).Set(float64(stats.Idle))
                dbWaitCount.WithLabelValues(dbName).Add(float64(stats.WaitCount))
                if stats.WaitDuration > 0 {
                    dbWaitDuration.WithLabelValues(dbName).Observe(stats.WaitDuration.Seconds())
                }
            case <-stop:
                ticker.Stop()
                return
            }
        }
    }()

    return func() { close(stop) }
}
```

### PgBouncer for Database-Side Pooling

For high-connection-count scenarios, deploy PgBouncer between Go services and PostgreSQL:

```ini
# /etc/pgbouncer/pgbouncer.ini

[databases]
myapp = host=postgresql.internal port=5432 dbname=myapp pool_size=10

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Transaction pooling: most aggressive, works for most Go applications
# Do NOT use session pooling with named prepared statements
pool_mode = transaction

# Connection limits
max_client_conn = 1000
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

# Timeout settings
server_idle_timeout = 600
client_idle_timeout = 60
query_timeout = 30
query_wait_timeout = 120

# Logging
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
stats_period = 60
```

**Critical note**: PgBouncer in transaction pooling mode does not support session-level features like `SET` commands that persist across queries, temporary tables, advisory locks, or LISTEN/NOTIFY. Audit your application code before switching to transaction pooling.

## Summary

Database connection pooling in Go requires careful attention at multiple levels:

- Use pgxpool directly when maximum PostgreSQL performance is needed - it avoids the interface overhead of database/sql
- For GORM and sqlx, always configure `SetMaxOpenConns`, `SetMaxIdleConns`, `SetConnMaxLifetime`, and `SetConnMaxIdleTime` explicitly
- Size MaxOpenConns using the formula: total server max_connections divided by number of application pods
- Route reads to replicas to reduce primary load - this is the highest-value scaling technique
- Use batch operations (pgx.CopyFrom, GORM CreateInBatches, sqlx.In) to eliminate N+1 patterns
- Always pass context with timeouts to every database call
- Monitor pool utilization with Prometheus; pool exhaustion before optimization is possible is a common production incident root cause
- Deploy PgBouncer when total application connections exceed PostgreSQL's practical max_connections limit
