---
title: "Go Context Patterns: Deadlines, Values, and Context-Aware Libraries"
date: 2030-04-22T00:00:00-05:00
draft: false
tags: ["Go", "Context", "Concurrency", "Deadlines", "Middleware", "Production", "Best Practices"]
categories: ["Go", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Go context.Context deep dive: deadline propagation across service boundaries, context values best practices, building context-aware database clients, context leak detection, and production patterns for timeout budget management."
more_link: "yes"
url: "/go-context-patterns-deadlines-values-context-aware-libraries/"
---

`context.Context` is one of Go's most important abstractions — and most frequently misused. It appears in virtually every production Go function signature, yet many developers treat it as a formality: they pass `context.Background()` everywhere, ignore cancellation signals, and wonder why their services accumulate goroutine leaks and slow request queues. This guide covers the production patterns that make context work for you: deadline propagation across distributed service boundaries, context values that carry request-scoped state without becoming a hidden parameter bag, building context-aware database clients that respect cancellation, and detecting context leaks before they reach production.

<!--more-->

## Context Fundamentals

### The Context Tree

Every context is a node in a tree. Child contexts derive from parents; cancellation propagates downward.

```go
package main

import (
    "context"
    "fmt"
    "time"
)

func demonstrateContextTree() {
    // Root: never cancelled, no deadline, no values
    root := context.Background()

    // Child with cancel: can be cancelled manually
    ctx1, cancel1 := context.WithCancel(root)
    defer cancel1()

    // Grandchild with deadline: cancelled at deadline or when parent is cancelled
    deadline := time.Now().Add(5 * time.Second)
    ctx2, cancel2 := context.WithDeadline(ctx1, deadline)
    defer cancel2()

    // Great-grandchild with value
    ctx3 := context.WithValue(ctx2, "requestID", "req-abc123")

    // Cancelling ctx1 propagates down to ctx2 and ctx3
    // ctx3.Done() closes when: ctx1 cancelled, ctx2 deadline exceeded, or ctx2 cancelled

    fmt.Printf("ctx1 deadline: %v\n", hasDeadline(ctx1))
    fmt.Printf("ctx2 deadline: %v\n", hasDeadline(ctx2))
    fmt.Printf("ctx3 value: %v\n", ctx3.Value("requestID"))

    // Cancel root-level, propagates down
    cancel1()
    time.Sleep(1 * time.Millisecond) // let goroutines notice

    select {
    case <-ctx3.Done():
        fmt.Printf("ctx3 cancelled: %v\n", ctx3.Err())
    default:
        fmt.Println("ctx3 still alive")
    }
}

func hasDeadline(ctx context.Context) string {
    dl, ok := ctx.Deadline()
    if !ok {
        return "none"
    }
    return fmt.Sprintf("%v (in %v)", dl, time.Until(dl).Truncate(time.Millisecond))
}
```

### When to Use Each Context Constructor

```go
// context.Background() - the root context
// Use at: main(), top-level goroutines, test setup
// Never use deep in a call stack

// context.TODO() - placeholder context
// Use when: you know a context is needed but haven't threaded one through yet
// Acts as a grep target: TODO() calls = tech debt to fix

// context.WithCancel() - manual cancellation
// Use when: you need to cancel a tree of goroutines from outside
// Example: user cancels a long-running export job

// context.WithTimeout(parent, duration) - relative deadline
// Use when: you have a per-operation time budget
// Example: each HTTP request handler gets 30s total

// context.WithDeadline(parent, time.Time) - absolute deadline
// Use when: you need to coordinate across multiple budget-consuming calls
// Example: database call must complete before 10:30:00.000

// context.WithValue() - request-scoped data
// Use sparingly: only for cross-cutting concerns (trace IDs, auth tokens)
// Never use for: function parameters, business logic data
```

## Deadline Propagation Across Service Boundaries

### The Timeout Budget Problem

When service A calls service B which calls service C, each hop consumes time. Without budget propagation, each service applies its own full timeout independently, allowing the total latency to be 3x the budget:

```
Request arrives at A: budget=5s
A calls B: B uses its own 5s timeout
B calls C: C uses its own 5s timeout
Total: 15s possible wait for a 5s budget
```

With budget propagation, the remaining deadline flows through each call:

```go
package budget

import (
    "context"
    "fmt"
    "time"
)

// SpendBudget carves a portion of the parent's deadline for one operation
func SpendBudget(ctx context.Context, maxDuration time.Duration) (context.Context, context.CancelFunc, error) {
    remaining, hasDeadline := timeRemaining(ctx)

    if hasDeadline && remaining <= 0 {
        return ctx, func() {}, fmt.Errorf("deadline already exceeded: %w", context.DeadlineExceeded)
    }

    if hasDeadline && remaining < 10*time.Millisecond {
        return ctx, func() {}, fmt.Errorf("insufficient budget: %v remaining", remaining)
    }

    var spend time.Duration
    if hasDeadline {
        // Leave 5ms headroom for cleanup
        available := remaining - 5*time.Millisecond
        if maxDuration > 0 && maxDuration < available {
            spend = maxDuration
        } else {
            spend = available
        }
    } else {
        spend = maxDuration
    }

    ctx2, cancel := context.WithTimeout(ctx, spend)
    return ctx2, cancel, nil
}

func timeRemaining(ctx context.Context) (time.Duration, bool) {
    dl, ok := ctx.Deadline()
    if !ok {
        return 0, false
    }
    return time.Until(dl), true
}

// Example: API handler with budget propagation
func HandleRequest(ctx context.Context, userID string) error {
    // Total request budget: 5 seconds
    requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    // Database lookup: max 2s of the budget
    dbCtx, dbCancel, err := SpendBudget(requestCtx, 2*time.Second)
    if err != nil {
        return fmt.Errorf("budget exhausted before DB call: %w", err)
    }
    defer dbCancel()

    user, err := fetchUser(dbCtx, userID)
    if err != nil {
        return fmt.Errorf("fetch user: %w", err)
    }

    // External service call: max 1s of remaining budget
    extCtx, extCancel, err := SpendBudget(requestCtx, 1*time.Second)
    if err != nil {
        return fmt.Errorf("budget exhausted before external call: %w", err)
    }
    defer extCancel()

    _, err = fetchExternalData(extCtx, user)
    return err
}

func fetchUser(ctx context.Context, id string) (interface{}, error) {
    // Simulated DB call that respects context
    select {
    case <-time.After(50 * time.Millisecond):
        return struct{ ID string }{ID: id}, nil
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

func fetchExternalData(ctx context.Context, user interface{}) (interface{}, error) {
    select {
    case <-time.After(200 * time.Millisecond):
        return nil, nil
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}
```

### Propagating Deadlines Over HTTP

```go
package httpclient

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "time"
)

const (
    // Header name for propagating deadline over HTTP
    // gRPC uses grpc-timeout; for HTTP/JSON use this convention
    HeaderDeadline     = "X-Request-Deadline"
    HeaderTimeout      = "X-Request-Timeout-Ms"
)

// OutboundMiddleware adds deadline information to outgoing HTTP requests
func OutboundMiddleware(next http.RoundTripper) http.RoundTripper {
    return roundTripFunc(func(req *http.Request) (*http.Response, error) {
        ctx := req.Context()

        if dl, ok := ctx.Deadline(); ok {
            // Add absolute deadline as Unix millisecond timestamp
            req.Header.Set(HeaderDeadline,
                strconv.FormatInt(dl.UnixMilli(), 10))

            // Also add remaining milliseconds for convenience
            remaining := time.Until(dl).Milliseconds()
            req.Header.Set(HeaderTimeout, strconv.FormatInt(remaining, 10))
        }

        return next.RoundTrip(req)
    })
}

type roundTripFunc func(*http.Request) (*http.Response, error)
func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
    return f(req)
}

// InboundMiddleware extracts and applies deadline from incoming requests
func InboundMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Prefer absolute deadline over timeout
        if dlHeader := r.Header.Get(HeaderDeadline); dlHeader != "" {
            dlMs, err := strconv.ParseInt(dlHeader, 10, 64)
            if err == nil {
                dl := time.UnixMilli(dlMs)
                if time.Until(dl) > 0 {
                    var cancel context.CancelFunc
                    ctx, cancel = context.WithDeadline(ctx, dl)
                    defer cancel()
                } else {
                    // Deadline already exceeded
                    http.Error(w, "request deadline exceeded", http.StatusGatewayTimeout)
                    return
                }
            }
        } else if toHeader := r.Header.Get(HeaderTimeout); toHeader != "" {
            toMs, err := strconv.ParseInt(toHeader, 10, 64)
            if err == nil && toMs > 0 {
                var cancel context.CancelFunc
                ctx, cancel = context.WithTimeout(ctx, time.Duration(toMs)*time.Millisecond)
                defer cancel()
            }
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Client that propagates deadlines
func NewHTTPClient() *http.Client {
    return &http.Client{
        Transport: OutboundMiddleware(http.DefaultTransport),
    }
}

// Example usage
func CallDownstreamService(ctx context.Context, url string) error {
    client := NewHTTPClient()

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return fmt.Errorf("create request: %w", err)
    }

    resp, err := client.Do(req)
    if err != nil {
        return fmt.Errorf("do request: %w", err)
    }
    defer resp.Body.Close()

    return nil
}
```

## Context Values Best Practices

### The Type-Safe Key Pattern

```go
package requestctx

import (
    "context"
    "net/http"
)

// Use unexported struct types as context keys to prevent key collisions
// across packages. This is the ONLY correct way to use context.WithValue.
type (
    requestIDKey    struct{}
    traceIDKey      struct{}
    userIDKey       struct{}
    authTokenKey    struct{}
    loggerKey       struct{}
)

// RequestID carries a unique request identifier
func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey{}, id)
}

func RequestID(ctx context.Context) (string, bool) {
    v, ok := ctx.Value(requestIDKey{}).(string)
    return v, ok
}

// MustRequestID panics if no request ID is set (use in tests or trusted paths)
func MustRequestID(ctx context.Context) string {
    id, ok := RequestID(ctx)
    if !ok {
        panic("requestctx: no request ID in context - did you forget to add the logging middleware?")
    }
    return id
}

// TraceContext carries distributed tracing IDs
type TraceContext struct {
    TraceID  string
    SpanID   string
    ParentID string
    Flags    byte
}

func WithTrace(ctx context.Context, tc TraceContext) context.Context {
    return context.WithValue(ctx, traceIDKey{}, tc)
}

func Trace(ctx context.Context) (TraceContext, bool) {
    v, ok := ctx.Value(traceIDKey{}).(TraceContext)
    return v, ok
}

// User carries authenticated user information
type User struct {
    ID       string
    Email    string
    Roles    []string
    TenantID string
}

func WithUser(ctx context.Context, user User) context.Context {
    return context.WithValue(ctx, userIDKey{}, user)
}

func UserFromContext(ctx context.Context) (User, bool) {
    v, ok := ctx.Value(userIDKey{}).(User)
    return v, ok
}

// Middleware that populates context values from HTTP headers
func RequestContextMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract request ID
        if id := r.Header.Get("X-Request-ID"); id != "" {
            ctx = WithRequestID(ctx, id)
        }

        // Extract trace context (W3C traceparent format)
        if tp := r.Header.Get("traceparent"); tp != "" {
            // Parse "00-traceId-spanId-flags"
            // Simplified parsing here
            ctx = WithTrace(ctx, TraceContext{TraceID: tp})
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### What NOT to Put in Context Values

```go
// BAD: Using context to pass function parameters
// This makes function signatures misleading and testing hard
func ProcessOrder(ctx context.Context, orderID string) error {
    // DON'T DO THIS:
    price := ctx.Value("order_price").(float64)  // bad - this is a function parameter
    currency := ctx.Value("currency").(string)    // bad - this is a function parameter

    // DO THIS instead:
    // func ProcessOrder(ctx context.Context, orderID string, price float64, currency string) error
    _, _ = price, currency
    return nil
}

// BAD: Mutable values in context (race condition)
type MutableData struct {
    Counter int
}

func WithMutableData(ctx context.Context) context.Context {
    // DON'T do this - multiple goroutines may access the same map/pointer
    return context.WithValue(ctx, struct{}{}, &MutableData{})
}

// GOOD: Immutable values in context
type ImmutableConfig struct {
    MaxRetries int
    Timeout    int
    Features   []string  // should be a copy, not a reference
}

func WithConfig(ctx context.Context, cfg ImmutableConfig) context.Context {
    // Make a defensive copy of the features slice
    features := make([]string, len(cfg.Features))
    copy(features, cfg.Features)
    cfg.Features = features
    return context.WithValue(ctx, struct{}{}, cfg)
}
```

## Context-Aware Database Client

Building a context-aware database client that propagates cancellation, traces, and timeout budgets is one of the most practical applications of Go context patterns.

```go
package dbclient

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// DBClient wraps database/sql with context-aware patterns
type DBClient struct {
    db *sql.DB
}

func New(dsn string) (*DBClient, error) {
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("open db: %w", err)
    }

    // Configure connection pool
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(30 * time.Second)

    return &DBClient{db: db}, nil
}

// Query executes a query with context-derived timeout
func (c *DBClient) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
    // Apply max query timeout: 30s or remaining context deadline, whichever is smaller
    ctx, cancel, err := applyQueryTimeout(ctx, 30*time.Second)
    if err != nil {
        return nil, fmt.Errorf("db query: budget exhausted: %w", err)
    }
    defer cancel()

    rows, err := c.db.QueryContext(ctx, query, args...)
    if err != nil {
        if ctx.Err() != nil {
            return nil, fmt.Errorf("db query cancelled: %w", ctx.Err())
        }
        return nil, fmt.Errorf("db query: %w", err)
    }
    return rows, nil
}

// QueryRow executes a single-row query with context awareness
func (c *DBClient) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
    ctx2, cancel, err := applyQueryTimeout(ctx, 10*time.Second)
    if err != nil {
        // Return a "pre-cancelled" context so the caller handles the error
        ctx2, cancel = context.WithCancel(ctx)
        cancel() // immediately cancel
        _ = cancel
        return c.db.QueryRowContext(ctx2, query, args...)
    }
    _ = cancel // caller must check row.Scan() error to detect timeout
    // Note: leaking the cancel here is intentional for QueryRow - 
    // use Exec/Query for patterns that need explicit cancel
    return c.db.QueryRowContext(ctx2, query, args...)
}

// Exec executes a write statement with context awareness
func (c *DBClient) Exec(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
    ctx2, cancel, err := applyQueryTimeout(ctx, 60*time.Second)
    if err != nil {
        return nil, fmt.Errorf("db exec: budget exhausted: %w", err)
    }
    defer cancel()

    result, err := c.db.ExecContext(ctx2, query, args...)
    if err != nil {
        if ctx.Err() != nil {
            return nil, fmt.Errorf("db exec cancelled: %w", ctx.Err())
        }
        return nil, fmt.Errorf("db exec: %w", err)
    }
    return result, nil
}

// BeginTx starts a transaction with context deadline
func (c *DBClient) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, context.CancelFunc, error) {
    // Apply a transaction timeout (distinct from query timeout)
    ctx2, cancel, err := applyQueryTimeout(ctx, 5*time.Minute)
    if err != nil {
        return nil, nil, fmt.Errorf("begin tx: budget exhausted: %w", err)
    }

    tx, err := c.db.BeginTx(ctx2, opts)
    if err != nil {
        cancel()
        return nil, nil, fmt.Errorf("begin tx: %w", err)
    }

    // Return cancel so the caller can close the transaction context
    return tx, cancel, nil
}

// WithTransaction executes fn within a database transaction
// Automatically commits on success, rolls back on error or panic
func (c *DBClient) WithTransaction(ctx context.Context, fn func(context.Context, *sql.Tx) error) error {
    tx, cancel, err := c.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer cancel()

    defer func() {
        if p := recover(); p != nil {
            tx.Rollback()
            panic(p) // re-panic
        }
    }()

    if err := fn(ctx, tx); err != nil {
        if rbErr := tx.Rollback(); rbErr != nil {
            return fmt.Errorf("fn error: %v; rollback error: %w", err, rbErr)
        }
        return err
    }

    return tx.Commit()
}

func applyQueryTimeout(ctx context.Context, maxDuration time.Duration) (context.Context, context.CancelFunc, error) {
    if dl, ok := ctx.Deadline(); ok {
        remaining := time.Until(dl)
        if remaining <= 0 {
            return ctx, func() {}, fmt.Errorf("deadline already exceeded")
        }
        // Use the smaller of remaining budget and maxDuration
        if maxDuration > 0 && maxDuration < remaining {
            return context.WithTimeout(ctx, maxDuration)
        }
        // Use context deadline as-is (it's already tighter)
        return ctx, func() {}, nil
    }
    // No deadline in context: apply maxDuration
    return context.WithTimeout(ctx, maxDuration)
}
```

## Context Leak Detection

Context leaks occur when a derived context is created but its cancel function is never called. This leaks the goroutine and timer resources associated with the context.

```go
package leakdetect

import (
    "context"
    "fmt"
    "runtime"
    "sync/atomic"
    "testing"
    "time"
)

// LeakDetector wraps context creation to detect uncancelled contexts
type LeakDetector struct {
    activeContexts atomic.Int64
}

// WithCancel wraps context.WithCancel with leak tracking
func (d *LeakDetector) WithCancel(parent context.Context) (context.Context, context.CancelFunc) {
    d.activeContexts.Add(1)

    // Capture stack trace at creation point for debugging
    var buf [4096]byte
    n := runtime.Stack(buf[:], false)
    creationStack := string(buf[:n])

    ctx, cancel := context.WithCancel(parent)

    wrapped := func() {
        cancel()
        d.activeContexts.Add(-1)
    }

    // Set up a goroutine to warn if context is not cancelled within a timeout
    go func() {
        timer := time.NewTimer(60 * time.Second) // warn after 60s
        defer timer.Stop()

        select {
        case <-ctx.Done():
            // Context was properly cancelled
        case <-timer.C:
            fmt.Printf("CONTEXT LEAK DETECTED\n"+
                "Active contexts: %d\n"+
                "Created at:\n%s\n",
                d.activeContexts.Load(), creationStack)
        }
    }()

    return ctx, wrapped
}

// Active returns the number of currently active contexts
func (d *LeakDetector) Active() int64 {
    return d.activeContexts.Load()
}

// TestContextLeak verifies no contexts are leaked in tests
func TestContextLeak(t *testing.T) {
    detector := &LeakDetector{}

    // Correct usage: cancel is deferred
    func() {
        ctx, cancel := detector.WithCancel(context.Background())
        defer cancel()
        _ = ctx
    }()

    time.Sleep(10 * time.Millisecond) // let goroutines settle
    if active := detector.Active(); active != 0 {
        t.Errorf("context leak: %d contexts still active", active)
    }
}
```

### Detecting Leaks with goleak

```go
// In your test files: use goleak to detect goroutine leaks
// go get go.uber.org/goleak

package myapp_test

import (
    "testing"
    "go.uber.org/goleak"
)

// Run at the start of TestMain to detect goroutine leaks across all tests
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// Or per-test:
func TestMyFunction(t *testing.T) {
    defer goleak.VerifyNone(t)

    // Any goroutines started here must be cleaned up by the end
    // of the test, or goleak will fail the test
}
```

## HTTP Server Context Patterns

```go
package server

import (
    "context"
    "log"
    "net/http"
    "time"
)

// TimeoutMiddleware applies a per-request timeout
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            // Detect if client disconnected
            done := make(chan struct{})
            go func() {
                next.ServeHTTP(w, r.WithContext(ctx))
                close(done)
            }()

            select {
            case <-done:
                // Handler completed normally
            case <-ctx.Done():
                if ctx.Err() == context.DeadlineExceeded {
                    // Write 503 if headers haven't been sent yet
                    http.Error(w, "request timeout", http.StatusServiceUnavailable)
                }
            }
        })
    }
}

// CancellationMiddleware propagates client disconnection to handlers
func CancellationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // The request context is already cancelled when the client disconnects
        // Just ensure your handlers check ctx.Done() in long operations
        next.ServeHTTP(w, r)
    })
}

// Example handler that respects context cancellation
func DataExportHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    rows := make(chan interface{}, 100)
    go func() {
        defer close(rows)
        for i := 0; i < 10000; i++ {
            select {
            case rows <- struct{ ID int }{ID: i}:
            case <-ctx.Done():
                log.Printf("export cancelled at row %d: %v", i, ctx.Err())
                return
            }
            // Simulate processing time
            time.Sleep(time.Millisecond)
        }
    }()

    w.Header().Set("Content-Type", "application/json")
    w.Write([]byte("["))

    first := true
    for row := range rows {
        // Check context in the consume loop too
        if ctx.Err() != nil {
            break
        }
        if !first {
            w.Write([]byte(","))
        }
        first = false
        _ = row
        w.Write([]byte(`{"id":0}`)) // simplified
    }
    w.Write([]byte("]"))
}
```

## Testing Context Behavior

```go
package context_test

import (
    "context"
    "errors"
    "testing"
    "time"
)

// TestDeadlinePropagation verifies that child deadlines never exceed parent
func TestDeadlinePropagation(t *testing.T) {
    parent, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    // Child with a longer timeout - should be capped by parent
    child, childCancel := context.WithTimeout(parent, 10*time.Second)
    defer childCancel()

    dl, ok := child.Deadline()
    if !ok {
        t.Fatal("expected child to have deadline")
    }

    parentDl, _ := parent.Deadline()
    if dl.After(parentDl) {
        t.Errorf("child deadline %v is after parent deadline %v", dl, parentDl)
    }
}

// TestContextCancellationPropagation verifies parent cancellation reaches children
func TestContextCancellationPropagation(t *testing.T) {
    parent, cancelParent := context.WithCancel(context.Background())
    child, cancelChild := context.WithCancel(parent)
    grandchild, cancelGrandchild := context.WithCancel(child)
    defer cancelChild()
    defer cancelGrandchild()

    // Cancel the parent
    cancelParent()

    // All descendants should be done
    select {
    case <-grandchild.Done():
        // Expected
    case <-time.After(10 * time.Millisecond):
        t.Error("grandchild was not cancelled when parent was cancelled")
    }

    if !errors.Is(grandchild.Err(), context.Canceled) {
        t.Errorf("expected Canceled, got %v", grandchild.Err())
    }
}

// TestContextValueScoping verifies values are scoped correctly
func TestContextValueScoping(t *testing.T) {
    type key struct{}

    parent := context.WithValue(context.Background(), key{}, "parent-value")
    child := context.WithValue(parent, key{}, "child-value")

    // Child overrides parent value
    if v := child.Value(key{}); v != "child-value" {
        t.Errorf("expected child-value, got %v", v)
    }

    // Parent is not affected by child override
    if v := parent.Value(key{}); v != "parent-value" {
        t.Errorf("expected parent-value, got %v", v)
    }
}

// BenchmarkContextWithValue measures the cost of value lookup
func BenchmarkContextWithValue(b *testing.B) {
    type k struct{}
    ctx := context.Background()
    for i := 0; i < 10; i++ {
        ctx = context.WithValue(ctx, k{}, i)
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = ctx.Value(k{})
    }
}
```

## Key Takeaways

`context.Context` is a first-class design element, not plumbing. The patterns here represent the production consensus on how to use it correctly:

**Deadline propagation**: Every downstream call should receive at most the remaining context deadline. The `SpendBudget` pattern prevents any single downstream call from consuming more than its fair share of the total request budget.

**HTTP deadline headers**: Propagate deadlines across HTTP boundaries using `X-Request-Deadline` (absolute epoch milliseconds) or `X-Request-Timeout-Ms` (relative). The inbound middleware converts these back to context deadlines, ensuring the entire distributed call chain respects the original SLA.

**Type-safe context keys**: Always use unexported struct types as context keys. String keys collide across packages; struct types are unique per package. This is not optional — the Go standard library uses this pattern exclusively.

**Context values are for cross-cutting concerns only**: Request ID, trace context, authentication token, feature flags. Not for business logic parameters. If a function needs a value, it should receive it as a function parameter — context values make function behavior implicit and testing hard.

**Database clients**: The `database/sql` package is fully context-aware. Always use `*Context` variants (`QueryContext`, `ExecContext`, `BeginTx`). Apply per-query timeouts that are bounded by the remaining context deadline. This ensures long-running queries are cancelled when clients disconnect.

**Leak detection**: Every `context.With*` call that creates a cancel function must have a corresponding call to that cancel function, typically via `defer cancel()`. Use `go.uber.org/goleak` in your test suite to catch goroutine leaks introduced by missing cancel calls.

**Never store `context.Context`**: Do not store context in struct fields. Pass it as the first parameter to every function that needs it. A context stored in a struct will outlive the request it was created for, violating the deadline and cancellation semantics.
