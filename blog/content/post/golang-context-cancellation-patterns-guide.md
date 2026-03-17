---
title: "Go Context Cancellation: Production Patterns for Graceful Shutdown"
date: 2027-11-16T00:00:00-05:00
draft: false
tags: ["Go", "Context", "Concurrency", "Graceful Shutdown", "Production"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go context cancellation patterns including propagation chains, deadline vs timeout tradeoffs, graceful HTTP server shutdown, database query cancellation, goroutine leak detection, and production shutdown sequences."
more_link: "yes"
url: "/golang-context-cancellation-patterns-guide/"
---

Context cancellation is one of the most misunderstood and misused features in Go. Get it wrong in production and you end up with goroutine leaks, hung requests, zombie database connections, and services that refuse to shut down cleanly. Get it right and you have a system that responds predictably to pressure, cancels work efficiently, and drains gracefully under rolling deploys.

This guide covers the full spectrum of context usage in production Go services: propagation chains, deadline versus timeout tradeoffs, HTTP handler integration, database cancellation, goroutine leak detection, and the shutdown sequence that actually works.

<!--more-->

# Go Context Cancellation: Production Patterns for Graceful Shutdown

## Section 1: Context Fundamentals and the Propagation Model

The `context.Context` interface is deceptively simple:

```go
type Context interface {
    Deadline() (deadline time.Time, ok bool)
    Done() <-chan struct{}
    Err() error
    Value(key any) any
}
```

Behind this simplicity is a tree structure. Every context has a parent. Cancellation flows downward: cancelling a parent cancels all children, but cancelling a child has no effect on the parent. This directional property is the foundation of all context patterns.

```go
package main

import (
    "context"
    "fmt"
    "time"
)

func demonstratePropagation() {
    root := context.Background()

    // First level child with cancellation
    level1, cancel1 := context.WithCancel(root)
    defer cancel1()

    // Second level child with timeout
    level2, cancel2 := context.WithTimeout(level1, 5*time.Second)
    defer cancel2()

    // Third level child with value
    level3 := context.WithValue(level2, "requestID", "abc-123")

    // Cancelling level1 propagates to level2 and level3
    cancel1()

    select {
    case <-level3.Done():
        fmt.Println("level3 cancelled:", level3.Err())
        // Output: level3 cancelled: context canceled
    case <-time.After(100 * time.Millisecond):
        fmt.Println("timeout waiting for cancellation")
    }
}
```

Understanding the tree structure prevents a common mistake: passing a background context to long-lived operations that should respect request lifecycle cancellation.

### The Four Context Constructors

**context.Background()** - The root of all context trees. Use it at the top of main(), in tests, and in initialization code. Never pass it into request handlers.

**context.TODO()** - A placeholder indicating you know you need a context but haven't decided which one yet. It signals to reviewers that this is incomplete. Use it during refactoring, never in final production code.

**context.WithCancel(parent)** - Returns a copy of parent with a new Done channel. The returned cancel function must be called, typically via defer, to release resources.

**context.WithDeadline(parent, time.Time) / context.WithTimeout(parent, duration)** - Returns a copy that is cancelled when the deadline arrives or the timeout expires, whichever comes first. Both also return a cancel function that should still be called to release resources early when work completes before the deadline.

```go
package contexts

import (
    "context"
    "fmt"
    "time"
)

// LeakyVersion demonstrates what NOT to do
func LeakyVersion() {
    for i := 0; i < 1000; i++ {
        // BUG: cancel is never called, timer goroutine leaks for 30 seconds
        ctx, _ := context.WithTimeout(context.Background(), 30*time.Second)
        go doWork(ctx)
    }
}

// CorrectVersion properly handles cleanup
func CorrectVersion() {
    for i := 0; i < 1000; i++ {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        go func() {
            defer cancel() // Always cancel, even if context expires naturally
            doWork(ctx)
        }()
    }
}

func doWork(ctx context.Context) error {
    select {
    case <-time.After(100 * time.Millisecond):
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// DeadlineVsTimeout illustrates when to use each
func DeadlineVsTimeout() {
    // Use Timeout when you want work to complete within N duration from now
    ctx1, cancel1 := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel1()
    fmt.Println("Timeout context deadline:", ctx1)

    // Use Deadline when you have an absolute time constraint
    // e.g., all processing must complete before end-of-batch at midnight
    midnight := time.Now().Truncate(24*time.Hour).Add(24 * time.Hour)
    ctx2, cancel2 := context.WithDeadline(context.Background(), midnight)
    defer cancel2()
    fmt.Println("Deadline context:", ctx2)

    // Propagated timeout: child cannot extend parent deadline
    // If parent has 2s left and child requests 5s, child gets 2s
    parentCtx, parentCancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer parentCancel()

    childCtx, childCancel := context.WithTimeout(parentCtx, 5*time.Second)
    defer childCancel()

    deadline, _ := childCtx.Deadline()
    remaining := time.Until(deadline)
    fmt.Printf("Child context remaining: %v (capped by parent)\n", remaining)
}
```

## Section 2: Context Propagation Across Service Boundaries

In a microservices architecture, context must cross network boundaries. The standard approach is to serialize the trace context into HTTP headers or gRPC metadata and reconstruct it on the receiving side.

```go
package propagation

import (
    "context"
    "fmt"
    "net/http"
    "time"
)

// ContextKey is a typed key to avoid collisions in context values
type ContextKey string

const (
    RequestIDKey   ContextKey = "requestID"
    UserIDKey      ContextKey = "userID"
    TenantIDKey    ContextKey = "tenantID"
    DeadlineKey    ContextKey = "originalDeadline"
)

// RequestMetadata holds request-scoped values
type RequestMetadata struct {
    RequestID string
    UserID    string
    TenantID  string
    StartTime time.Time
}

// InjectMetadata creates a context with request metadata
func InjectMetadata(parent context.Context, meta RequestMetadata) context.Context {
    ctx := context.WithValue(parent, RequestIDKey, meta.RequestID)
    ctx = context.WithValue(ctx, UserIDKey, meta.UserID)
    ctx = context.WithValue(ctx, TenantIDKey, meta.TenantID)
    return ctx
}

// ExtractMetadata retrieves request metadata from context
func ExtractMetadata(ctx context.Context) (RequestMetadata, bool) {
    requestID, ok1 := ctx.Value(RequestIDKey).(string)
    userID, ok2 := ctx.Value(UserIDKey).(string)
    tenantID, ok3 := ctx.Value(TenantIDKey).(string)

    if !ok1 || !ok2 || !ok3 {
        return RequestMetadata{}, false
    }

    return RequestMetadata{
        RequestID: requestID,
        UserID:    userID,
        TenantID:  tenantID,
    }, true
}

// OutboundMiddleware propagates context to outbound HTTP requests
func OutboundMiddleware(next http.RoundTripper) http.RoundTripper {
    return roundTripperFunc(func(req *http.Request) (*http.Response, error) {
        ctx := req.Context()
        meta, ok := ExtractMetadata(ctx)
        if ok {
            req = req.Clone(ctx)
            req.Header.Set("X-Request-ID", meta.RequestID)
            req.Header.Set("X-User-ID", meta.UserID)
            req.Header.Set("X-Tenant-ID", meta.TenantID)

            // Propagate remaining deadline as a header so downstream
            // services can understand the time budget
            if deadline, hasDeadline := ctx.Deadline(); hasDeadline {
                remaining := time.Until(deadline)
                req.Header.Set("X-Deadline-Remaining-Ms",
                    fmt.Sprintf("%d", remaining.Milliseconds()))
            }
        }
        return next.RoundTrip(req)
    })
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
    return f(req)
}

// InboundMiddleware reconstructs context from incoming HTTP request headers
func InboundMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = generateRequestID()
        }

        meta := RequestMetadata{
            RequestID: requestID,
            UserID:    r.Header.Get("X-User-ID"),
            TenantID:  r.Header.Get("X-Tenant-ID"),
            StartTime: time.Now(),
        }

        ctx := InjectMetadata(r.Context(), meta)

        // Apply downstream deadline hint if present
        remainingMs := r.Header.Get("X-Deadline-Remaining-Ms")
        if remainingMs != "" {
            var ms int64
            fmt.Sscanf(remainingMs, "%d", &ms)
            if ms > 0 {
                deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
                var cancel context.CancelFunc
                ctx, cancel = context.WithDeadline(ctx, deadline)
                defer cancel()
            }
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func generateRequestID() string {
    return fmt.Sprintf("req-%d", time.Now().UnixNano())
}
```

### Anti-Patterns: Context Values

Context values are frequently misused. The rule is simple: context values are for request-scoped data that crosses API boundaries, not for optional function parameters.

```go
package antipatterns

import (
    "context"
    "database/sql"
    "errors"
)

// ANTI-PATTERN: Using context to pass dependencies
// This makes functions unpredictable and untestable
type dbKey struct{}

func BadInjectDB(parent context.Context, db *sql.DB) context.Context {
    return context.WithValue(parent, dbKey{}, db)
}

func BadGetUser(ctx context.Context, userID string) (*User, error) {
    db, ok := ctx.Value(dbKey{}).(*sql.DB)
    if !ok {
        return nil, errors.New("no database in context")
    }
    // This is fragile - what if caller forgot to inject?
    return queryUser(ctx, db, userID)
}

// CORRECT: Pass dependencies explicitly as function parameters
func GoodGetUser(ctx context.Context, db *sql.DB, userID string) (*User, error) {
    return queryUser(ctx, db, userID)
}

// ANTI-PATTERN: Using context to pass configuration
func BadSetPageSize(parent context.Context, size int) context.Context {
    return context.WithValue(parent, "pageSize", size)
}

// CORRECT: Use explicit parameters or a config struct
type ListOptions struct {
    PageSize int
    Offset   int
    SortBy   string
}

func GoodListUsers(ctx context.Context, db *sql.DB, opts ListOptions) ([]*User, error) {
    // Options are explicit, testable, and documented
    return nil, nil
}

// ANTI-PATTERN: Using string keys (collision risk)
func BadStringKey(parent context.Context) context.Context {
    return context.WithValue(parent, "userID", "12345")
    // Any package can accidentally use the same key
}

// CORRECT: Use typed unexported keys
type contextKey struct{ name string }

var userIDKey = &contextKey{"userID"}

func GoodTypedKey(parent context.Context, userID string) context.Context {
    return context.WithValue(parent, userIDKey, userID)
}

type User struct {
    ID   string
    Name string
}

func queryUser(ctx context.Context, db *sql.DB, userID string) (*User, error) {
    return nil, nil
}
```

## Section 3: Graceful HTTP Server Shutdown

The HTTP server shutdown pattern requires coordinating three concerns: stopping the listener from accepting new connections, draining in-flight requests, and unblocking the main goroutine to exit cleanly.

```go
package server

import (
    "context"
    "errors"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

// Config holds server configuration
type Config struct {
    Addr            string
    ReadTimeout     time.Duration
    WriteTimeout    time.Duration
    IdleTimeout     time.Duration
    ShutdownTimeout time.Duration
    MaxHeaderBytes  int
}

// DefaultConfig returns production-safe defaults
func DefaultConfig() Config {
    return Config{
        Addr:            ":8080",
        ReadTimeout:     10 * time.Second,
        WriteTimeout:    30 * time.Second,
        IdleTimeout:     120 * time.Second,
        ShutdownTimeout: 30 * time.Second,
        MaxHeaderBytes:  1 << 20, // 1MB
    }
}

// Server wraps http.Server with graceful shutdown
type Server struct {
    httpServer *http.Server
    config     Config
    logger     *slog.Logger
}

// New creates a new Server instance
func New(handler http.Handler, config Config, logger *slog.Logger) *Server {
    return &Server{
        httpServer: &http.Server{
            Addr:           config.Addr,
            Handler:        handler,
            ReadTimeout:    config.ReadTimeout,
            WriteTimeout:   config.WriteTimeout,
            IdleTimeout:    config.IdleTimeout,
            MaxHeaderBytes: config.MaxHeaderBytes,
        },
        config: config,
        logger: logger,
    }
}

// Run starts the server and blocks until shutdown is complete.
// It returns nil on clean shutdown, or an error if the server
// failed to start or shut down properly.
func (s *Server) Run(ctx context.Context) error {
    // Channel to receive server errors from the background goroutine
    serverErr := make(chan error, 1)

    go func() {
        s.logger.Info("server starting", "addr", s.config.Addr)
        if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            serverErr <- err
        }
        close(serverErr)
    }()

    // Wait for either a signal, a context cancellation, or a server error
    select {
    case err := <-serverErr:
        return fmt.Errorf("server failed to start: %w", err)
    case <-ctx.Done():
        s.logger.Info("context cancelled, initiating shutdown")
    }

    return s.shutdown()
}

// RunWithSignals starts the server and handles OS signals for shutdown.
// This is the typical entry point for main().
func (s *Server) RunWithSignals() error {
    // Create a context that is cancelled on SIGINT or SIGTERM
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT,
        syscall.SIGTERM,
    )
    defer stop()

    return s.Run(ctx)
}

func (s *Server) shutdown() error {
    s.logger.Info("shutting down server", "timeout", s.config.ShutdownTimeout)

    ctx, cancel := context.WithTimeout(context.Background(), s.config.ShutdownTimeout)
    defer cancel()

    // Shutdown stops the server from accepting new connections
    // and waits for active requests to complete
    if err := s.httpServer.Shutdown(ctx); err != nil {
        s.logger.Error("shutdown error", "error", err)
        return fmt.Errorf("shutdown failed: %w", err)
    }

    s.logger.Info("server shutdown complete")
    return nil
}

// ExampleMain shows how to use the server in a real main function
func ExampleMain() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    mux := http.NewServeMux()
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"status":"ok"}`))
    })

    config := DefaultConfig()
    srv := New(mux, config, logger)

    if err := srv.RunWithSignals(); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}
```

### Tracking In-Flight Requests

For services that need to wait for all requests to complete before releasing shared resources (database pools, message brokers), use a WaitGroup to track active requests:

```go
package server

import (
    "context"
    "net/http"
    "sync"
    "sync/atomic"
)

// RequestTracker counts in-flight requests and provides a way to wait
// for all of them to complete during shutdown.
type RequestTracker struct {
    wg      sync.WaitGroup
    count   atomic.Int64
    draining atomic.Bool
}

// Middleware wraps handlers to track request lifecycle
func (rt *RequestTracker) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if rt.draining.Load() {
            // Reject new requests during drain phase
            http.Error(w, "service unavailable", http.StatusServiceUnavailable)
            return
        }

        rt.wg.Add(1)
        rt.count.Add(1)
        defer func() {
            rt.wg.Done()
            rt.count.Add(-1)
        }()

        next.ServeHTTP(w, r)
    })
}

// Drain signals no new requests should be accepted and waits for
// all in-flight requests to complete or ctx to be cancelled.
func (rt *RequestTracker) Drain(ctx context.Context) error {
    rt.draining.Store(true)

    done := make(chan struct{})
    go func() {
        rt.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// ActiveRequests returns the current count of in-flight requests
func (rt *RequestTracker) ActiveRequests() int64 {
    return rt.count.Load()
}
```

## Section 4: Database Query Cancellation

Database drivers in Go fully support context cancellation. When a context is cancelled, the driver cancels the query at the network level. This is critical for preventing database resource exhaustion when upstream clients disconnect.

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
)

// Repository demonstrates proper context usage with database operations
type Repository struct {
    db *sql.DB
}

// NewRepository creates a repository with a connection pool
func NewRepository(dsn string) (*Repository, error) {
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    // Configure connection pool for production
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(1 * time.Minute)

    return &Repository{db: db}, nil
}

// User represents a user record
type User struct {
    ID        int64
    Email     string
    Name      string
    CreatedAt time.Time
}

// GetUser demonstrates context-aware query execution.
// If ctx is cancelled while the query is running, the database
// driver sends a cancellation to PostgreSQL and returns ctx.Err().
func (r *Repository) GetUser(ctx context.Context, userID int64) (*User, error) {
    query := `
        SELECT id, email, name, created_at
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
    `

    var u User
    err := r.db.QueryRowContext(ctx, query, userID).Scan(
        &u.ID, &u.Email, &u.Name, &u.CreatedAt,
    )
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("user %d not found", userID)
    }
    if err != nil {
        return nil, fmt.Errorf("querying user: %w", err)
    }

    return &u, nil
}

// ListUsersPaginated demonstrates context cancellation with streaming results.
// For large result sets, check ctx.Done() inside the scan loop.
func (r *Repository) ListUsersPaginated(ctx context.Context, offset, limit int) ([]*User, error) {
    query := `
        SELECT id, email, name, created_at
        FROM users
        WHERE deleted_at IS NULL
        ORDER BY id
        OFFSET $1
        LIMIT $2
    `

    rows, err := r.db.QueryContext(ctx, query, offset, limit)
    if err != nil {
        return nil, fmt.Errorf("querying users: %w", err)
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        // Check context before processing each row.
        // This is important for large result sets where iteration
        // takes significant time.
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
        }

        var u User
        if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt); err != nil {
            return nil, fmt.Errorf("scanning user: %w", err)
        }
        users = append(users, &u)
    }

    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterating rows: %w", err)
    }

    return users, nil
}

// WithTransaction demonstrates context-aware transaction management.
// The transaction is automatically rolled back if ctx is cancelled.
func (r *Repository) WithTransaction(ctx context.Context, fn func(context.Context, *sql.Tx) error) error {
    tx, err := r.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelSerializable,
        ReadOnly:  false,
    })
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    // Ensure rollback on any error path
    defer func() {
        if p := recover(); p != nil {
            tx.Rollback()
            panic(p) // re-panic after rollback
        }
    }()

    if err := fn(ctx, tx); err != nil {
        if rbErr := tx.Rollback(); rbErr != nil {
            return fmt.Errorf("transaction failed: %w (rollback error: %v)", err, rbErr)
        }
        return err
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}

// BulkInsert demonstrates context cancellation during batch operations
func (r *Repository) BulkInsert(ctx context.Context, users []*User) error {
    return r.WithTransaction(ctx, func(ctx context.Context, tx *sql.Tx) error {
        stmt, err := tx.PrepareContext(ctx, `
            INSERT INTO users (email, name, created_at)
            VALUES ($1, $2, $3)
        `)
        if err != nil {
            return fmt.Errorf("preparing statement: %w", err)
        }
        defer stmt.Close()

        for i, u := range users {
            // Check for cancellation every 100 rows during large batches
            if i%100 == 0 {
                select {
                case <-ctx.Done():
                    return ctx.Err()
                default:
                }
            }

            if _, err := stmt.ExecContext(ctx, u.Email, u.Name, u.CreatedAt); err != nil {
                return fmt.Errorf("inserting user %s: %w", u.Email, err)
            }
        }

        return nil
    })
}
```

## Section 5: Goroutine Leak Detection

Goroutine leaks are context bugs in disguise. A goroutine that blocks forever on a channel it never receives from, or that loops checking a condition that never becomes true, typically should have been checking ctx.Done(). The goleak library from Uber makes detecting these leaks easy in tests.

```go
package leakdetection_test

import (
    "context"
    "testing"
    "time"

    "go.uber.org/goleak"
)

// TestMain configures goleak for all tests in this package.
// Any test that leaks goroutines will fail.
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// BuggyWorker leaks a goroutine when context is cancelled
func BuggyWorker(ctx context.Context, work <-chan string) <-chan string {
    results := make(chan string)
    go func() {
        defer close(results)
        for {
            select {
            case item, ok := <-work:
                if !ok {
                    return
                }
                // BUG: If processing takes a long time and ctx is cancelled,
                // this goroutine continues running
                result := processSlowly(item)
                results <- result // BLOCKS: no ctx check
            }
        }
    }()
    return results
}

// CorrectWorker respects context cancellation throughout
func CorrectWorker(ctx context.Context, work <-chan string) <-chan string {
    results := make(chan string, 10) // buffered to reduce blocking
    go func() {
        defer close(results)
        for {
            select {
            case <-ctx.Done():
                return
            case item, ok := <-work:
                if !ok {
                    return
                }
                result := processSlowly(item)
                // Also check ctx when sending results
                select {
                case results <- result:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()
    return results
}

func processSlowly(s string) string {
    time.Sleep(10 * time.Millisecond)
    return s + "_processed"
}

func TestCorrectWorkerNoLeak(t *testing.T) {
    defer goleak.VerifyNone(t)

    ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
    defer cancel()

    work := make(chan string, 5)
    work <- "item1"
    work <- "item2"
    close(work)

    results := CorrectWorker(ctx, work)
    for range results {
    }
    // goleak.VerifyNone will confirm no goroutines leaked
}

// TestBuggyWorkerLeaks demonstrates that goleak catches the bug
func TestBuggyWorkerDetectsLeak(t *testing.T) {
    // This test uses IgnoreCurrent to show that the buggy version WOULD leak
    // In real tests, you'd just run it without IgnoreCurrent and see failure
    before := goleak.IgnoreCurrent()

    ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
    defer cancel()

    work := make(chan string, 1)
    work <- "item1"
    // Don't close work channel - simulates real-world partial consumption

    _ = BuggyWorker(ctx, work)
    <-ctx.Done()

    // goleak.VerifyNone(t, before) would detect the leaked goroutine here
    _ = before
}
```

### Runtime Goroutine Stack Inspection

For production goroutine leak investigation, use runtime/pprof or the expvar endpoint:

```go
package diagnostics

import (
    "fmt"
    "net/http"
    _ "net/http/pprof" // registers /debug/pprof/ endpoints
    "runtime"
    "sort"
    "strings"
)

// GoroutineReport generates a summary of goroutine states
// useful for diagnosing leaks in production
func GoroutineReport() string {
    buf := make([]byte, 1<<20) // 1MB buffer
    n := runtime.Stack(buf, true)
    stacks := string(buf[:n])

    // Count goroutines by function prefix
    lines := strings.Split(stacks, "\n")
    counts := make(map[string]int)

    for _, line := range lines {
        line = strings.TrimSpace(line)
        if strings.HasPrefix(line, "goroutine ") && strings.Contains(line, "[") {
            // Extract state: goroutine 42 [chan receive]:
            start := strings.Index(line, "[")
            end := strings.Index(line, "]")
            if start != -1 && end != -1 {
                state := line[start+1 : end]
                counts[state]++
            }
        }
    }

    // Sort for consistent output
    states := make([]string, 0, len(counts))
    for s := range counts {
        states = append(states, s)
    }
    sort.Strings(states)

    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("Total goroutines: %d\n", runtime.NumGoroutine()))
    for _, state := range states {
        sb.WriteString(fmt.Sprintf("  %-30s %d\n", state+":", counts[state]))
    }

    return sb.String()
}

// RegisterDiagnosticsHandler registers HTTP handlers for runtime diagnostics
func RegisterDiagnosticsHandler(mux *http.ServeMux) {
    // pprof is already registered via blank import above
    mux.HandleFunc("/debug/goroutines", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/plain")
        fmt.Fprint(w, GoroutineReport())
    })
}
```

## Section 6: Production Shutdown Sequence

A production service has more than just an HTTP server to shut down. Database connections, message consumer goroutines, background workers, and metrics collectors all need to drain in the right order.

```go
package lifecycle

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

// ShutdownFunc is a function called during shutdown with a time budget
type ShutdownFunc func(ctx context.Context) error

// Lifecycle manages the startup and shutdown of application components
// in the correct dependency order.
type Lifecycle struct {
    logger    *slog.Logger
    mu        sync.Mutex
    hooks     []shutdownHook
    startFns  []func(ctx context.Context) error
}

type shutdownHook struct {
    name     string
    fn       ShutdownFunc
    timeout  time.Duration
    required bool // if true, shutdown fails on error
}

// New creates a new Lifecycle manager
func New(logger *slog.Logger) *Lifecycle {
    return &Lifecycle{
        logger: logger,
    }
}

// OnStart registers a function to run during startup
func (l *Lifecycle) OnStart(fn func(ctx context.Context) error) {
    l.mu.Lock()
    defer l.mu.Unlock()
    l.startFns = append(l.startFns, fn)
}

// OnStop registers a shutdown hook with a name and timeout.
// Hooks are executed in reverse registration order (LIFO).
func (l *Lifecycle) OnStop(name string, timeout time.Duration, required bool, fn ShutdownFunc) {
    l.mu.Lock()
    defer l.mu.Unlock()
    l.hooks = append(l.hooks, shutdownHook{
        name:     name,
        fn:       fn,
        timeout:  timeout,
        required: required,
    })
}

// Run starts all registered start functions, then blocks until
// a shutdown signal is received or the provided context is cancelled.
func (l *Lifecycle) Run(ctx context.Context) error {
    // Run all startup functions
    startCtx, startCancel := context.WithTimeout(ctx, 30*time.Second)
    defer startCancel()

    for _, fn := range l.startFns {
        if err := fn(startCtx); err != nil {
            return fmt.Errorf("startup failed: %w", err)
        }
    }

    l.logger.Info("all components started")

    // Block until context is done
    <-ctx.Done()
    l.logger.Info("shutdown signal received")

    return l.runShutdownHooks()
}

// RunWithSignals is the top-level entry point. It sets up signal handling
// and delegates to Run.
func (l *Lifecycle) RunWithSignals() error {
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT,
        syscall.SIGTERM,
        syscall.SIGHUP,
    )
    defer stop()

    return l.Run(ctx)
}

// runShutdownHooks executes hooks in LIFO order with individual timeouts
func (l *Lifecycle) runShutdownHooks() error {
    l.mu.Lock()
    hooks := make([]shutdownHook, len(l.hooks))
    copy(hooks, l.hooks)
    l.mu.Unlock()

    // Reverse order: last registered is first to shut down
    for i := len(hooks) - 1; i >= 0; i-- {
        hook := hooks[i]
        l.logger.Info("stopping component", "name", hook.name, "timeout", hook.timeout)

        ctx, cancel := context.WithTimeout(context.Background(), hook.timeout)
        err := hook.fn(ctx)
        cancel()

        if err != nil {
            l.logger.Error("component shutdown failed",
                "name", hook.name,
                "error", err,
            )
            if hook.required {
                return fmt.Errorf("required component %q failed shutdown: %w", hook.name, err)
            }
        } else {
            l.logger.Info("component stopped", "name", hook.name)
        }
    }

    return nil
}

// ExampleApplication shows how to wire up a real service
type ExampleApplication struct {
    lifecycle *Lifecycle
    server    *Server
    db        *Repository
    consumer  *MessageConsumer
}

// NewExampleApplication wires up the application
func NewExampleApplication(logger *slog.Logger) *ExampleApplication {
    lc := New(logger)
    db := &Repository{}
    consumer := &MessageConsumer{}
    server := &Server{}

    app := &ExampleApplication{
        lifecycle: lc,
        server:    server,
        db:        db,
        consumer:  consumer,
    }

    // Register startup in dependency order
    lc.OnStart(func(ctx context.Context) error {
        return db.Connect(ctx)
    })
    lc.OnStart(func(ctx context.Context) error {
        return consumer.Start(ctx, db)
    })
    lc.OnStart(func(ctx context.Context) error {
        return server.Start(ctx)
    })

    // Register shutdown in reverse order:
    // 1. Stop accepting new HTTP requests first
    lc.OnStop("http-server", 30*time.Second, true, func(ctx context.Context) error {
        return server.GracefulStop(ctx)
    })

    // 2. Stop message consumer (may have in-flight message processing)
    lc.OnStop("message-consumer", 60*time.Second, true, func(ctx context.Context) error {
        return consumer.Stop(ctx)
    })

    // 3. Close database last (needed by both server and consumer during drain)
    lc.OnStop("database", 10*time.Second, true, func(ctx context.Context) error {
        return db.Close()
    })

    return app
}

func (a *ExampleApplication) Run() error {
    return a.lifecycle.RunWithSignals()
}

// Stub types to make the example compile
type MessageConsumer struct{}

func (m *MessageConsumer) Start(ctx context.Context, db *Repository) error { return nil }
func (m *MessageConsumer) Stop(ctx context.Context) error                   { return nil }

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    app := NewExampleApplication(logger)
    if err := app.Run(); err != nil {
        logger.Error("application error", "error", err)
        os.Exit(1)
    }
}
```

## Section 7: Context-Aware Worker Pools

Worker pools need to handle context cancellation both when submitting work and when workers are processing it.

```go
package workerpool

import (
    "context"
    "fmt"
    "sync"
)

// Job represents a unit of work
type Job[T any] struct {
    ID      string
    Payload T
}

// Result represents the outcome of processing a job
type Result[T, R any] struct {
    JobID  string
    Value  R
    Err    error
}

// Pool is a generic, context-aware worker pool
type Pool[T, R any] struct {
    workers int
    process func(ctx context.Context, job Job[T]) (R, error)
    jobs    chan Job[T]
    results chan Result[T, R]
    wg      sync.WaitGroup
}

// NewPool creates a worker pool with the given concurrency
func NewPool[T, R any](workers int, process func(ctx context.Context, job Job[T]) (R, error)) *Pool[T, R] {
    return &Pool[T, R]{
        workers: workers,
        process: process,
        jobs:    make(chan Job[T], workers*2), // buffered to reduce contention
        results: make(chan Result[T, R], workers*2),
    }
}

// Start launches worker goroutines that stop when ctx is cancelled
func (p *Pool[T, R]) Start(ctx context.Context) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func(workerID int) {
            defer p.wg.Done()
            p.runWorker(ctx, workerID)
        }(i)
    }

    // Close results when all workers are done
    go func() {
        p.wg.Wait()
        close(p.results)
    }()
}

func (p *Pool[T, R]) runWorker(ctx context.Context, id int) {
    for {
        select {
        case <-ctx.Done():
            return
        case job, ok := <-p.jobs:
            if !ok {
                return
            }

            // Process with a per-job context derived from the pool context.
            // This allows individual jobs to have their own deadlines.
            value, err := p.process(ctx, job)

            result := Result[T, R]{
                JobID: job.ID,
                Value: value,
                Err:   err,
            }

            // Send result or respect cancellation
            select {
            case p.results <- result:
            case <-ctx.Done():
                return
            }
        }
    }
}

// Submit adds a job to the pool. Returns an error if ctx is cancelled
// before the job can be enqueued.
func (p *Pool[T, R]) Submit(ctx context.Context, job Job[T]) error {
    select {
    case p.jobs <- job:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("submit cancelled: %w", ctx.Err())
    }
}

// Close signals no more jobs will be submitted and waits for workers to finish
func (p *Pool[T, R]) Close() {
    close(p.jobs)
}

// Results returns the channel of results. Drain it to prevent worker blocking.
func (p *Pool[T, R]) Results() <-chan Result[T, R] {
    return p.results
}

// ProcessAll is a convenience function that submits all jobs, closes the pool,
// and collects results. Returns the first error encountered.
func ProcessAll[T, R any](
    ctx context.Context,
    jobs []Job[T],
    workers int,
    process func(ctx context.Context, job Job[T]) (R, error),
) ([]Result[T, R], error) {
    pool := NewPool[T, R](workers, process)
    pool.Start(ctx)

    // Submit jobs in a goroutine to avoid blocking if the pool is full
    submitErr := make(chan error, 1)
    go func() {
        defer pool.Close()
        for _, job := range jobs {
            if err := pool.Submit(ctx, job); err != nil {
                submitErr <- err
                return
            }
        }
        close(submitErr)
    }()

    // Collect results
    var results []Result[T, R]
    for result := range pool.Results() {
        results = append(results, result)
    }

    if err := <-submitErr; err != nil {
        return results, err
    }

    return results, nil
}
```

## Section 8: Testing Context Cancellation

Context cancellation logic must be tested explicitly. Standard unit tests often miss timing-dependent cancellation paths.

```go
package context_test

import (
    "context"
    "errors"
    "testing"
    "time"
)

// simulateSlowOperation mimics a database call or external API call
func simulateSlowOperation(ctx context.Context, duration time.Duration) error {
    select {
    case <-time.After(duration):
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func TestCancellationPropagation(t *testing.T) {
    t.Run("operation completes before timeout", func(t *testing.T) {
        ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
        defer cancel()

        err := simulateSlowOperation(ctx, 10*time.Millisecond)
        if err != nil {
            t.Errorf("expected no error, got %v", err)
        }
    })

    t.Run("operation is cancelled by timeout", func(t *testing.T) {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
        defer cancel()

        err := simulateSlowOperation(ctx, 500*time.Millisecond)
        if !errors.Is(err, context.DeadlineExceeded) {
            t.Errorf("expected DeadlineExceeded, got %v", err)
        }
    })

    t.Run("operation is cancelled by explicit cancel", func(t *testing.T) {
        ctx, cancel := context.WithCancel(context.Background())

        // Cancel after a short delay
        go func() {
            time.Sleep(10 * time.Millisecond)
            cancel()
        }()

        err := simulateSlowOperation(ctx, 500*time.Millisecond)
        if !errors.Is(err, context.Canceled) {
            t.Errorf("expected Canceled, got %v", err)
        }
    })

    t.Run("parent cancellation propagates to child", func(t *testing.T) {
        parent, parentCancel := context.WithCancel(context.Background())
        child, childCancel := context.WithTimeout(parent, 5*time.Second)
        defer childCancel()

        parentCancel() // Cancel parent, should propagate to child

        select {
        case <-child.Done():
            if !errors.Is(child.Err(), context.Canceled) {
                t.Errorf("expected Canceled from parent, got %v", child.Err())
            }
        case <-time.After(100 * time.Millisecond):
            t.Error("child context did not get cancelled when parent was cancelled")
        }
    })
}

// TestContextValues verifies typed key extraction
func TestContextValues(t *testing.T) {
    type key struct{}

    ctx := context.WithValue(context.Background(), key{}, "hello")

    val, ok := ctx.Value(key{}).(string)
    if !ok {
        t.Fatal("expected string value from context")
    }
    if val != "hello" {
        t.Errorf("expected 'hello', got %q", val)
    }

    // Wrong key type returns nil
    type otherKey struct{}
    nilVal := ctx.Value(otherKey{})
    if nilVal != nil {
        t.Errorf("expected nil for wrong key, got %v", nilVal)
    }
}
```

## Section 9: Kubernetes Deployment Considerations

When deploying Go services on Kubernetes, context timeout values must align with Kubernetes probe and termination configurations.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      # terminationGracePeriodSeconds must exceed your shutdown timeout
      # In our example: 30s HTTP drain + 60s consumer + 10s DB = 100s minimum
      terminationGracePeriodSeconds: 120
      containers:
      - name: api
        image: myregistry/api-service:1.4.2
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: HTTP_SHUTDOWN_TIMEOUT
          value: "30s"
        - name: CONSUMER_SHUTDOWN_TIMEOUT
          value: "60s"
        - name: DB_SHUTDOWN_TIMEOUT
          value: "10s"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
          failureThreshold: 3
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 2
          periodSeconds: 5
          failureThreshold: 2
          timeoutSeconds: 3
        lifecycle:
          preStop:
            # preStop runs before SIGTERM, giving the load balancer time
            # to stop routing traffic before we start shutting down
            exec:
              command: ["/bin/sleep", "5"]
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
```

The `preStop` hook with a sleep gives the Kubernetes endpoints controller time to remove the pod from service before SIGTERM arrives, preventing requests from being routed to a draining pod.

## Section 10: Context Timeout Budget Propagation

In a request chain spanning multiple services, the original request timeout must be respected throughout. A useful pattern is computing remaining budget and propagating it as a header.

```go
package budget

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "time"
)

// RemainingBudget returns the time remaining on a context's deadline.
// Returns a large duration if no deadline is set.
func RemainingBudget(ctx context.Context) time.Duration {
    deadline, ok := ctx.Deadline()
    if !ok {
        return 30 * time.Second // default budget when no deadline set
    }
    remaining := time.Until(deadline)
    if remaining < 0 {
        return 0
    }
    return remaining
}

// BudgetAwareClient wraps http.Client to propagate deadline budgets
type BudgetAwareClient struct {
    base    *http.Client
    reserve time.Duration // keep N ms in reserve for overhead
}

// NewBudgetAwareClient creates a client that respects context deadlines
func NewBudgetAwareClient(reserve time.Duration) *BudgetAwareClient {
    return &BudgetAwareClient{
        base:    &http.Client{},
        reserve: reserve,
    }
}

// Do executes the request with a timeout derived from the context budget
func (c *BudgetAwareClient) Do(req *http.Request) (*http.Response, error) {
    ctx := req.Context()
    budget := RemainingBudget(ctx) - c.reserve

    if budget <= 0 {
        return nil, fmt.Errorf("insufficient time budget: %w", context.DeadlineExceeded)
    }

    // Apply budget as timeout on the outbound request
    timeoutCtx, cancel := context.WithTimeout(ctx, budget)
    defer cancel()

    req = req.Clone(timeoutCtx)
    req.Header.Set("X-Budget-Ms", strconv.FormatInt(budget.Milliseconds(), 10))

    return c.base.Do(req)
}

// BudgetMiddleware extracts inbound budget headers and applies them as deadlines
func BudgetMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        budgetHeader := r.Header.Get("X-Budget-Ms")
        if budgetHeader == "" {
            next.ServeHTTP(w, r)
            return
        }

        budgetMs, err := strconv.ParseInt(budgetHeader, 10, 64)
        if err != nil || budgetMs <= 0 {
            next.ServeHTTP(w, r)
            return
        }

        ctx, cancel := context.WithTimeout(r.Context(),
            time.Duration(budgetMs)*time.Millisecond)
        defer cancel()

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

## Summary

Context cancellation in production Go services requires attention at multiple levels:

**Propagation correctness**: Always pass ctx as the first argument to every I/O operation. Never use context.Background() inside a handler or worker that should respect request cancellation.

**Cancel function discipline**: Always call cancel functions via defer. Failing to call cancel causes timer goroutine leaks even when the deadline expires naturally.

**Deadline inheritance**: Child contexts inherit parent deadlines. A 5-second child of a 2-second parent gets 2 seconds, not 5. Always check `ctx.Deadline()` before setting a timeout if you want to know the effective remaining time.

**Context values**: Use typed unexported keys. Store only request-scoped data (trace IDs, user identity), never dependencies or configuration.

**Goroutine leak discipline**: Every goroutine that reads from a channel must also select on `ctx.Done()`. Every goroutine that writes to a channel must also select on `ctx.Done()`.

**Shutdown ordering**: HTTP server stops first (stops accepting), workers drain second, database closes last. Register hooks in the Lifecycle manager in this order and set `terminationGracePeriodSeconds` to cover the full shutdown budget.

**Testing**: Test both success paths and cancellation paths explicitly. Use `goleak` to detect goroutine leaks in your test suite.

These patterns collectively eliminate the most common categories of production incidents in Go services: hung deploys, zombie goroutines, database connection pool exhaustion, and cascading timeout failures in request chains.
