---
title: "Go Context Patterns: Cancellation, Timeouts, and Value Propagation in Production"
date: 2028-04-08T00:00:00-05:00
draft: false
tags: ["Go", "Context", "Concurrency", "Cancellation", "Production"]
categories: ["Go", "Backend Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go context patterns for production systems covering cancellation propagation, deadline management, context value best practices, and common pitfalls that cause goroutine leaks."
more_link: "yes"
url: "/go-context-patterns-production-guide/"
---

Go's `context` package is deceptively simple in its API but requires disciplined usage patterns to avoid goroutine leaks, cascading failures, and subtle bugs in production systems. This guide covers production-grade context patterns including cancellation propagation, deadline cascades, value key design, and common anti-patterns that cause incidents in real systems.

<!--more-->

# Go Context Patterns: Cancellation, Timeouts, and Value Propagation in Production

## The Context Contract

Every function that performs I/O, calls external services, or runs for an unbounded time should accept a `context.Context` as its first parameter. This is the standard Go convention, not a suggestion. The context enables:

1. **Cancellation**: The caller can cancel work that is no longer needed
2. **Deadlines**: Work is automatically abandoned after a time limit
3. **Value propagation**: Request-scoped values (trace IDs, user auth) flow through the call chain

The fundamental rule: **contexts flow downstream and are never stored in structs**.

```go
// Correct: context as first parameter
func FetchUser(ctx context.Context, userID string) (*User, error) {
    // Pass context to all downstream calls
    return db.QueryContext(ctx, "SELECT * FROM users WHERE id = ?", userID)
}

// Wrong: context stored in struct
type UserService struct {
    ctx context.Context  // Never do this
}
```

## Cancellation: The Most Important Pattern

### Basic Cancellation

```go
func ProcessOrders(ctx context.Context, orders []Order) error {
    for _, order := range orders {
        // Check for cancellation before each expensive operation
        select {
        case <-ctx.Done():
            return fmt.Errorf("processing cancelled after %d orders: %w",
                processedCount, ctx.Err())
        default:
        }

        if err := processOrder(ctx, order); err != nil {
            return fmt.Errorf("processing order %s: %w", order.ID, err)
        }
    }
    return nil
}
```

### Cancellation in Goroutines

```go
// Worker pool with proper cancellation
func RunWorkerPool(ctx context.Context, jobs <-chan Job, numWorkers int) error {
    var wg sync.WaitGroup
    errCh := make(chan error, numWorkers)

    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()
            for {
                select {
                case <-ctx.Done():
                    // Context cancelled — worker exits cleanly
                    return

                case job, ok := <-jobs:
                    if !ok {
                        // Channel closed — no more work
                        return
                    }

                    if err := processJob(ctx, job); err != nil {
                        select {
                        case errCh <- fmt.Errorf("worker %d: %w", workerID, err):
                        default:
                            // Error channel full — first error wins
                        }
                        return
                    }
                }
            }
        }(i)
    }

    // Wait for all workers then close error channel
    go func() {
        wg.Wait()
        close(errCh)
    }()

    // Return first error encountered
    return <-errCh
}
```

### Derived Contexts for Sub-operations

Create derived contexts for sub-operations that should be cancelled independently:

```go
func HandleRequest(ctx context.Context, req *Request) (*Response, error) {
    // Main request context — tied to client connection
    // If client disconnects, this context is cancelled

    // Create a child context for the database query with a shorter timeout
    dbCtx, dbCancel := context.WithTimeout(ctx, 5*time.Second)
    defer dbCancel()  // Always defer cancel — prevents context leak

    user, err := db.GetUser(dbCtx, req.UserID)
    if err != nil {
        return nil, fmt.Errorf("fetching user: %w", err)
    }

    // Create a child context for an external API call
    apiCtx, apiCancel := context.WithTimeout(ctx, 3*time.Second)
    defer apiCancel()

    enrichedData, err := externalAPI.Enrich(apiCtx, user)
    if err != nil {
        // Degraded response — log but don't fail
        log.WarnContext(ctx, "enrichment failed, continuing", "error", err)
        enrichedData = &EnrichedData{}
    }

    return buildResponse(user, enrichedData), nil
}
```

## Timeout Patterns

### Hierarchy of Timeouts

Production systems use layered timeouts. Outer timeouts should be larger than inner timeouts:

```go
// Timeout hierarchy for an API handler
// Total: 30s budget
// ├── DB query: 5s
// ├── Cache lookup: 1s
// └── External API: 3s

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Total request budget — set by HTTP server or middleware
    ctx := r.Context()  // Already has request deadline from http.Server.ReadTimeout

    // Or add an explicit total budget
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    result, err := h.processRequest(ctx, r)
    // ...
}

func (h *Handler) processRequest(ctx context.Context, r *http.Request) (*Result, error) {
    // Budget: allocate sub-timeouts that sum to less than parent
    type queryResult struct {
        data *Data
        err  error
    }

    // Parallel operations with individual timeouts
    var wg sync.WaitGroup
    results := make([]queryResult, 3)

    // Query 1: database
    wg.Add(1)
    go func() {
        defer wg.Done()
        ctx1, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
        data, err := h.db.Query(ctx1, "...")
        results[0] = queryResult{data, err}
    }()

    // Query 2: cache
    wg.Add(1)
    go func() {
        defer wg.Done()
        ctx2, cancel := context.WithTimeout(ctx, 1*time.Second)
        defer cancel()
        data, err := h.cache.Get(ctx2, r.URL.Path)
        results[1] = queryResult{data, err}
    }()

    // Query 3: external API
    wg.Add(1)
    go func() {
        defer wg.Done()
        ctx3, cancel := context.WithTimeout(ctx, 3*time.Second)
        defer cancel()
        data, err := h.api.Fetch(ctx3, r.URL.Path)
        results[2] = queryResult{data, err}
    }()

    wg.Wait()
    return mergeResults(results)
}
```

### Detecting Which Timeout Fired

```go
func classifyContextError(ctx context.Context, err error) string {
    if err == nil {
        return "success"
    }

    if ctx.Err() == nil {
        return "operation-error"  // Our code returned an error, not timeout
    }

    switch ctx.Err() {
    case context.DeadlineExceeded:
        if deadline, ok := ctx.Deadline(); ok {
            remaining := time.Until(deadline)
            if remaining > 0 {
                return "child-deadline-exceeded"
            }
            return "parent-deadline-exceeded"
        }
        return "deadline-exceeded"

    case context.Canceled:
        return "cancelled"

    default:
        return "unknown-context-error"
    }
}

// Structured logging with context error classification
func processWithLogging(ctx context.Context, id string) error {
    err := process(ctx, id)
    if err != nil {
        category := classifyContextError(ctx, err)
        slog.ErrorContext(ctx, "processing failed",
            "id", id,
            "error", err,
            "error_category", category,
            "deadline_exceeded", ctx.Err() == context.DeadlineExceeded,
        )
    }
    return err
}
```

## Context Values: Best Practices

Context values should be used sparingly — only for request-scoped data that must cross API boundaries. They are not a replacement for function parameters.

### Type-Safe Context Keys

```go
// pkg/ctxkeys/keys.go
package ctxkeys

// Unexported key type prevents external packages from creating the same key
// This is the correct pattern — never use string keys for context values
type contextKey string

const (
    keyRequestID   contextKey = "request_id"
    keyUserID      contextKey = "user_id"
    keyTraceID     contextKey = "trace_id"
    keyTenantID    contextKey = "tenant_id"
    keyPermissions contextKey = "permissions"
)

// RequestID stores and retrieves the request ID from context
func WithRequestID(ctx context.Context, requestID string) context.Context {
    return context.WithValue(ctx, keyRequestID, requestID)
}

func RequestIDFrom(ctx context.Context) (string, bool) {
    v, ok := ctx.Value(keyRequestID).(string)
    return v, ok
}

// MustRequestID panics if no request ID — use only in code where it is guaranteed
func MustRequestID(ctx context.Context) string {
    id, ok := RequestIDFrom(ctx)
    if !ok {
        panic("request ID not found in context — was middleware applied?")
    }
    return id
}

// UserClaims holds authentication context
type UserClaims struct {
    UserID      string
    TenantID    string
    Roles       []string
    Permissions map[string]bool
}

func WithUserClaims(ctx context.Context, claims *UserClaims) context.Context {
    return context.WithValue(ctx, keyPermissions, claims)
}

func UserClaimsFrom(ctx context.Context) (*UserClaims, bool) {
    claims, ok := ctx.Value(keyPermissions).(*UserClaims)
    return claims, ok
}
```

### Middleware Pattern: Adding Context Values

```go
// middleware/context.go
package middleware

import (
    "net/http"

    "github.com/google/uuid"

    "github.com/example/app/pkg/ctxkeys"
)

// RequestIDMiddleware adds a unique request ID to every request context
func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }

        ctx := ctxkeys.WithRequestID(r.Context(), requestID)
        w.Header().Set("X-Request-ID", requestID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// AuthMiddleware validates JWT and adds user claims to context
func AuthMiddleware(validator TokenValidator) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := extractBearerToken(r)
            if token == "" {
                http.Error(w, "unauthorized", http.StatusUnauthorized)
                return
            }

            claims, err := validator.Validate(r.Context(), token)
            if err != nil {
                http.Error(w, "invalid token", http.StatusUnauthorized)
                return
            }

            ctx := ctxkeys.WithUserClaims(r.Context(), claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

## Common Anti-patterns and How to Fix Them

### Anti-pattern 1: Ignoring Context in Loops

```go
// WRONG: context not checked in long-running loop
func processItems(ctx context.Context, items []Item) error {
    for _, item := range items {
        result, err := expensiveOperation(item)  // Context not passed!
        if err != nil {
            return err
        }
        storeResult(result)
    }
    return nil
}

// CORRECT: check context and pass to all operations
func processItems(ctx context.Context, items []Item) error {
    for i, item := range items {
        if err := ctx.Err(); err != nil {
            return fmt.Errorf("cancelled at item %d: %w", i, err)
        }

        result, err := expensiveOperation(ctx, item)
        if err != nil {
            return fmt.Errorf("item %s: %w", item.ID, err)
        }

        if err := storeResult(ctx, result); err != nil {
            return fmt.Errorf("storing result for %s: %w", item.ID, err)
        }
    }
    return nil
}
```

### Anti-pattern 2: Goroutine Leaks from Missing Cancellation

```go
// WRONG: goroutine never exits if ctx is cancelled before channel receive
func startWorker(ctx context.Context) <-chan Result {
    ch := make(chan Result)
    go func() {
        result := doWork()
        ch <- result  // BLOCKS FOREVER if context cancelled before this runs
    }()
    return ch
}

// CORRECT: goroutine handles cancellation
func startWorker(ctx context.Context) <-chan Result {
    ch := make(chan Result, 1)  // Buffer of 1 prevents leak even if caller abandons
    go func() {
        result := doWork(ctx)  // Pass context to doWork
        select {
        case ch <- result:
        case <-ctx.Done():
            // Caller gave up — discard result
        }
    }()
    return ch
}
```

### Anti-pattern 3: context.Background() in Library Code

```go
// WRONG: ignores caller's deadline
func (s *Store) SaveUser(user *User) error {
    // context.Background() has no deadline — ignores caller's context
    _, err := s.db.ExecContext(context.Background(), "INSERT INTO users...", user)
    return err
}

// CORRECT: accept and use context from caller
func (s *Store) SaveUser(ctx context.Context, user *User) error {
    _, err := s.db.ExecContext(ctx, "INSERT INTO users...", user)
    return err
}
```

### Anti-pattern 4: Passing context.TODO() Everywhere

```go
// WRONG: TODO left in production code
func (s *Server) handleRequest() {
    s.db.Query(context.TODO(), "SELECT 1")  // TODO should never reach production
}

// CORRECT: propagate the real context
func (s *Server) handleRequest(ctx context.Context) {
    s.db.Query(ctx, "SELECT 1")
}
```

### Anti-pattern 5: Cancelled Context in Defer (Cleanup Bug)

```go
// WRONG: cleanup runs with a cancelled context
func processPayment(ctx context.Context, paymentID string) error {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    if err := beginTransaction(ctx); err != nil {
        return err
    }

    defer func() {
        // BUG: ctx may be cancelled here, causing rollback to fail
        if err := rollbackTransaction(ctx, paymentID); err != nil {
            log.Error("rollback failed", "error", err)
        }
    }()

    return executePayment(ctx, paymentID)
}

// CORRECT: use a fresh context for cleanup operations
func processPayment(ctx context.Context, paymentID string) error {
    opCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    if err := beginTransaction(opCtx); err != nil {
        return err
    }

    var txErr error
    defer func() {
        if txErr != nil {
            // Create a new detached context for cleanup
            // Use the parent context's values but a new deadline
            cleanupCtx, cleanupCancel := context.WithTimeout(
                context.Background(),
                5*time.Second,
            )
            defer cleanupCancel()

            if err := rollbackTransaction(cleanupCtx, paymentID); err != nil {
                log.ErrorContext(ctx, "rollback failed",
                    "payment_id", paymentID,
                    "error", err,
                )
            }
        }
    }()

    txErr = executePayment(opCtx, paymentID)
    return txErr
}
```

## Context-Aware Retry Logic

```go
// pkg/retry/retry.go
package retry

import (
    "context"
    "fmt"
    "math/rand"
    "time"
)

// Config holds retry parameters
type Config struct {
    MaxAttempts    int
    InitialBackoff time.Duration
    MaxBackoff     time.Duration
    Multiplier     float64
    Jitter         float64
}

// DefaultConfig provides sensible production defaults
var DefaultConfig = Config{
    MaxAttempts:    3,
    InitialBackoff: 100 * time.Millisecond,
    MaxBackoff:     30 * time.Second,
    Multiplier:     2.0,
    Jitter:         0.1,
}

// IsRetryable determines if an error should trigger a retry
type IsRetryable func(err error) bool

// Do executes fn with retries, respecting context cancellation
func Do(ctx context.Context, cfg Config, isRetryable IsRetryable, fn func(ctx context.Context) error) error {
    var lastErr error

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        // Check for context cancellation before each attempt
        if ctx.Err() != nil {
            return fmt.Errorf("context cancelled before attempt %d: %w", attempt+1, ctx.Err())
        }

        lastErr = fn(ctx)
        if lastErr == nil {
            return nil
        }

        // Don't retry non-retryable errors
        if isRetryable != nil && !isRetryable(lastErr) {
            return lastErr
        }

        // Don't sleep after the last attempt
        if attempt == cfg.MaxAttempts-1 {
            break
        }

        // Calculate backoff with jitter
        backoff := cfg.InitialBackoff
        for i := 0; i < attempt; i++ {
            backoff = time.Duration(float64(backoff) * cfg.Multiplier)
            if backoff > cfg.MaxBackoff {
                backoff = cfg.MaxBackoff
                break
            }
        }

        // Add jitter: backoff ± jitter*backoff
        jitterDelta := time.Duration(float64(backoff) * cfg.Jitter)
        backoff += time.Duration(rand.Int63n(int64(2*jitterDelta+1))) - jitterDelta

        // Wait for backoff or context cancellation
        timer := time.NewTimer(backoff)
        select {
        case <-ctx.Done():
            timer.Stop()
            return fmt.Errorf("context cancelled during retry backoff: %w", ctx.Err())
        case <-timer.C:
        }
    }

    return fmt.Errorf("all %d attempts failed, last error: %w", cfg.MaxAttempts, lastErr)
}
```

## Propagating Context Through HTTP Clients

```go
// pkg/httpclient/client.go
package httpclient

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/example/app/pkg/ctxkeys"
)

// Client wraps http.Client with context propagation
type Client struct {
    httpClient *http.Client
}

func New() *Client {
    return &Client{
        httpClient: &http.Client{
            Timeout: 30 * time.Second,
            Transport: &http.Transport{
                MaxIdleConns:          100,
                MaxIdleConnsPerHost:   10,
                IdleConnTimeout:       90 * time.Second,
                DisableCompression:    false,
                ForceAttemptHTTP2:     true,
            },
        },
    }
}

// Do performs an HTTP request, propagating context values as headers
func (c *Client) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Propagate trace and request ID headers
    if requestID, ok := ctxkeys.RequestIDFrom(ctx); ok {
        req.Header.Set("X-Request-ID", requestID)
    }

    if traceID, ok := ctxkeys.TraceIDFrom(ctx); ok {
        req.Header.Set("X-Trace-ID", traceID)
    }

    // Attach the context to the request
    req = req.WithContext(ctx)

    resp, err := c.httpClient.Do(req)
    if err != nil {
        // Classify the error
        if ctx.Err() != nil {
            return nil, fmt.Errorf("request cancelled/timed out: %w", ctx.Err())
        }
        return nil, fmt.Errorf("http request failed: %w", err)
    }

    return resp, nil
}
```

## Context in Database Operations

```go
// pkg/db/db.go
package db

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

type Store struct {
    db *sql.DB
}

// GetUserWithContext demonstrates proper context usage in database operations
func (s *Store) GetUser(ctx context.Context, userID string) (*User, error) {
    // QueryContext respects the context deadline
    row := s.db.QueryRowContext(ctx,
        `SELECT id, email, created_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
        userID,
    )

    var user User
    if err := row.Scan(&user.ID, &user.Email, &user.CreatedAt); err != nil {
        if err == sql.ErrNoRows {
            return nil, fmt.Errorf("user %q: %w", userID, ErrNotFound)
        }
        // Distinguish between database error and context error
        if ctx.Err() != nil {
            return nil, fmt.Errorf("query cancelled: %w", ctx.Err())
        }
        return nil, fmt.Errorf("scanning user row: %w", err)
    }

    return &user, nil
}

// TransactionWithContext executes a function within a transaction
func (s *Store) WithTransaction(ctx context.Context, fn func(ctx context.Context, tx *sql.Tx) error) error {
    tx, err := s.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted,
    })
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    if err := fn(ctx, tx); err != nil {
        // Rollback using a detached context in case the original is cancelled
        rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()

        // BeginTx with the rollback context
        if rbErr := tx.Rollback(); rbErr != nil {
            _ = rollbackCtx  // used for clarity
            return fmt.Errorf("rollback after error (%v): %w", err, rbErr)
        }
        return err
    }

    if err := tx.Commit(); err != nil {
        if ctx.Err() != nil {
            return fmt.Errorf("commit cancelled: %w", ctx.Err())
        }
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}
```

## Testing Context Behavior

```go
// Testing cancellation handling
func TestProcessOrders_CancellationRespected(t *testing.T) {
    orders := make([]Order, 1000)
    for i := range orders {
        orders[i] = Order{ID: fmt.Sprintf("order-%d", i)}
    }

    ctx, cancel := context.WithCancel(context.Background())

    // Cancel after a short delay
    go func() {
        time.Sleep(10 * time.Millisecond)
        cancel()
    }()

    err := ProcessOrders(ctx, orders)

    assert.Error(t, err)
    assert.True(t, errors.Is(err, context.Canceled),
        "expected context.Canceled, got %v", err)
}

func TestProcessOrders_TimeoutRespected(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
    defer cancel()

    // Simulate slow work
    orders := []Order{{ID: "slow-order"}}

    err := ProcessOrders(ctx, orders)

    // May return either DeadlineExceeded or Canceled depending on timing
    assert.True(t,
        errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled),
        "expected context error, got %v", err)
}

func TestContextValues_PropagatedCorrectly(t *testing.T) {
    ctx := context.Background()
    ctx = ctxkeys.WithRequestID(ctx, "test-request-123")
    ctx = ctxkeys.WithUserClaims(ctx, &ctxkeys.UserClaims{
        UserID: "user-456",
        Roles:  []string{"admin"},
    })

    // Verify values accessible in downstream code
    requestID, ok := ctxkeys.RequestIDFrom(ctx)
    assert.True(t, ok)
    assert.Equal(t, "test-request-123", requestID)

    claims, ok := ctxkeys.UserClaimsFrom(ctx)
    assert.True(t, ok)
    assert.Equal(t, "user-456", claims.UserID)
}
```

## Context Propagation Checklist

Use this checklist when reviewing code for context issues:

- Every function performing I/O accepts `context.Context` as first parameter
- All `context.WithCancel` / `context.WithTimeout` / `context.WithDeadline` calls have `defer cancel()`
- Context is passed to all downstream function calls and library operations
- Goroutines spawned by context-aware code handle `ctx.Done()` channel
- Cleanup operations (rollbacks, resource release) use fresh contexts when needed
- No `context.Background()` or `context.TODO()` in non-main/non-test code paths
- Context values use unexported typed keys (never strings or other builtin types)
- Error messages include context error information for debugging

Proper context usage is the difference between a service that degrades gracefully under load and one that accumulates goroutine leaks and cascades failures to upstream callers. The patterns here represent battle-tested approaches from high-traffic production systems.
