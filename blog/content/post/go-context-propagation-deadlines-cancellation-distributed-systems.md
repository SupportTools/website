---
title: "Go Context Propagation: Deadlines, Cancellation, and Value Passing in Distributed Systems"
date: 2031-02-10T00:00:00-05:00
draft: false
tags: ["Go", "Context", "gRPC", "Distributed Systems", "Concurrency", "HTTP"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go context propagation covering context creation and cancellation trees, deadline vs timeout propagation, gRPC metadata, HTTP request contexts, and preventing context leaks in production services."
more_link: "yes"
url: "/go-context-propagation-deadlines-cancellation-distributed-systems/"
---

Context propagation is the invisible infrastructure that holds distributed Go services together. Mismanaged contexts cause goroutine leaks, hung requests, cascading timeouts, and subtle data races. This guide covers the complete context lifecycle from creation through cancellation, with production-ready patterns for gRPC, HTTP, and multi-service call chains.

<!--more-->

# Go Context Propagation: Deadlines, Cancellation, and Value Passing in Distributed Systems

## Understanding the Context Contract

The `context.Context` interface defines a contract between a function and its callers:

```go
type Context interface {
    Deadline() (deadline time.Time, ok bool)
    Done() <-chan struct{}
    Err() error
    Value(key any) any
}
```

This interface is intentionally minimal. It answers four questions a function needs to know about its execution environment:

1. **Deadline**: Is there a point in time after which I should stop working?
2. **Done**: Has cancellation been signaled?
3. **Err**: Why was I cancelled?
4. **Value**: What request-scoped data is available to me?

Every function that performs I/O, calls another service, or runs for a non-trivial duration should accept a context as its first parameter.

## Section 1: The Context Cancellation Tree

### How the Cancellation Tree Works

Contexts form a tree. When a parent context is cancelled, all children are cancelled simultaneously. This enables a caller to abort an entire call subtree with a single cancellation.

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

func demonstrateCancellationTree() {
    // Root context — never cancelled (use context.Background() at service entry points)
    root := context.Background()

    // Level 1: request-scoped context with 5 second timeout
    reqCtx, reqCancel := context.WithTimeout(root, 5*time.Second)
    defer reqCancel()

    // Level 2: downstream call context with 2 second timeout
    // The effective deadline is min(reqCtx deadline, 2s from now)
    dbCtx, dbCancel := context.WithTimeout(reqCtx, 2*time.Second)
    defer dbCancel()

    // Level 2: separate downstream call
    cacheCtx, cacheCancel := context.WithTimeout(reqCtx, 500*time.Millisecond)
    defer cacheCancel()

    var wg sync.WaitGroup
    wg.Add(2)

    go func() {
        defer wg.Done()
        // If dbCtx expires OR reqCtx expires, this goroutine sees cancellation
        select {
        case <-time.After(3 * time.Second):
            fmt.Println("DB query completed")
        case <-dbCtx.Done():
            fmt.Printf("DB query cancelled: %v\n", dbCtx.Err())
        }
    }()

    go func() {
        defer wg.Done()
        select {
        case <-time.After(100 * time.Millisecond):
            fmt.Println("Cache lookup completed")
        case <-cacheCtx.Done():
            fmt.Printf("Cache lookup cancelled: %v\n", cacheCtx.Err())
        }
    }()

    wg.Wait()
}
```

### Cancellation Propagation Semantics

```go
package contexts

import (
    "context"
    "errors"
    "fmt"
    "time"
)

// PropagationDemo shows how cancellation propagates through a context tree
func PropagationDemo() {
    parent, parentCancel := context.WithCancel(context.Background())

    child1, child1Cancel := context.WithCancel(parent)
    defer child1Cancel()

    child2, child2Cancel := context.WithTimeout(parent, 10*time.Second)
    defer child2Cancel()

    grandchild, grandchildCancel := context.WithCancel(child1)
    defer grandchildCancel()

    // Cancel the parent — all descendants are immediately cancelled
    parentCancel()

    // Verify propagation
    fmt.Println("parent.Err():", parent.Err())         // context.Canceled
    fmt.Println("child1.Err():", child1.Err())         // context.Canceled
    fmt.Println("child2.Err():", child2.Err())         // context.Canceled
    fmt.Println("grandchild.Err():", grandchild.Err()) // context.Canceled
}

// CheckContextError distinguishes between cancellation and deadline exceeded
func CheckContextError(ctx context.Context) string {
    select {
    case <-ctx.Done():
        switch {
        case errors.Is(ctx.Err(), context.Canceled):
            return "cancelled by caller"
        case errors.Is(ctx.Err(), context.DeadlineExceeded):
            return "deadline exceeded"
        default:
            return fmt.Sprintf("unknown: %v", ctx.Err())
        }
    default:
        return "still active"
    }
}
```

## Section 2: Deadline vs Timeout Propagation

### Understanding the Difference

`WithDeadline` takes an absolute time. `WithTimeout` takes a duration and computes `time.Now().Add(duration)`. Internally, both produce the same context type. The critical difference in practice is how they compose across service boundaries.

```go
package timeouts

import (
    "context"
    "time"
)

// PropagateDeadline demonstrates how to propagate a deadline downstream
// while respecting the caller's deadline.
func PropagateDeadline(ctx context.Context, downstreamTimeout time.Duration) (context.Context, context.CancelFunc) {
    // Determine the effective deadline for the downstream call:
    // it is the minimum of (caller's deadline) and (now + downstreamTimeout)
    deadline, hasDeadline := ctx.Deadline()
    downstreamDeadline := time.Now().Add(downstreamTimeout)

    if hasDeadline && deadline.Before(downstreamDeadline) {
        // Parent deadline is tighter; use it (WithTimeout would set a looser deadline)
        return context.WithDeadline(ctx, deadline)
    }

    // Our downstream timeout is tighter
    return context.WithTimeout(ctx, downstreamTimeout)
}

// TimeoutBudget computes the remaining time budget from a context
func TimeoutBudget(ctx context.Context) (remaining time.Duration, hasDeadline bool) {
    deadline, ok := ctx.Deadline()
    if !ok {
        return 0, false
    }
    return time.Until(deadline), true
}

// EnsureMinimumBudget returns an error if the remaining context budget
// is less than the minimum required for the operation.
func EnsureMinimumBudget(ctx context.Context, minimum time.Duration) error {
    remaining, hasDeadline := TimeoutBudget(ctx)
    if !hasDeadline {
        return nil // No deadline means unlimited budget
    }
    if remaining < minimum {
        return fmt.Errorf("insufficient time budget: %v remaining, need %v", remaining, minimum)
    }
    return nil
}
```

### Cascading Timeouts Across a Service Call Chain

```go
package service

import (
    "context"
    "fmt"
    "time"
)

// ServiceCallChain demonstrates proper timeout propagation across
// a chain of microservice calls.
type ServiceCallChain struct {
    ServiceA *ClientA
    ServiceB *ClientB
    ServiceC *ClientC
}

// ProcessRequest handles an incoming request with appropriate timeout budgets
// allocated to each downstream service.
func (s *ServiceCallChain) ProcessRequest(ctx context.Context, req *Request) (*Response, error) {
    // Total budget already set by the HTTP handler or gRPC interceptor
    // Allocate sub-budgets to each downstream call

    // Service A: critical path, allocate up to 1 second
    ctxA, cancelA := PropagateDeadline(ctx, 1*time.Second)
    defer cancelA()

    resultA, err := s.ServiceA.Call(ctxA, req.PartA)
    if err != nil {
        return nil, fmt.Errorf("service A: %w", err)
    }

    // Service B: depends on A's result, allocate remaining time minus buffer
    remaining, hasDeadline := TimeoutBudget(ctx)
    if hasDeadline && remaining < 200*time.Millisecond {
        return nil, fmt.Errorf("insufficient time budget after service A: %v", remaining)
    }

    bTimeout := 500 * time.Millisecond
    if hasDeadline {
        bTimeout = remaining - 100*time.Millisecond // Reserve 100ms buffer
    }
    ctxB, cancelB := context.WithTimeout(ctx, bTimeout)
    defer cancelB()

    resultB, err := s.ServiceB.Call(ctxB, resultA)
    if err != nil {
        return nil, fmt.Errorf("service B: %w", err)
    }

    // Service C: best-effort, short timeout (not on critical path)
    ctxC, cancelC := context.WithTimeout(ctx, 200*time.Millisecond)
    defer cancelC()

    resultC, _ := s.ServiceC.Call(ctxC, req.PartC) // Ignore error — best-effort

    return buildResponse(resultA, resultB, resultC), nil
}
```

## Section 3: Context Value Passing — Patterns and Anti-Patterns

### The Case For and Against context.Value

`context.Value` is a legitimate tool for passing request-scoped data that crosses API boundaries — but only for data that is truly request-scoped, not for passing optional function parameters.

**Appropriate uses:**
- Request trace IDs
- Authentication principals
- Request-scoped loggers
- Locale/language preferences

**Inappropriate uses:**
- Database connections
- Optional function parameters
- Configuration values
- Anything that should be a function parameter

### Production Pattern: Typed Context Keys

```go
package contextkeys

import (
    "context"
    "fmt"
)

// Define private key types to prevent collision across packages.
// Using unexported types means only this package can create keys of this type.
type contextKey int

const (
    traceIDKey contextKey = iota
    userPrincipalKey
    requestIDKey
    loggerKey
)

// TraceID operations
type TraceID string

func WithTraceID(ctx context.Context, id TraceID) context.Context {
    return context.WithValue(ctx, traceIDKey, id)
}

func TraceIDFrom(ctx context.Context) (TraceID, bool) {
    id, ok := ctx.Value(traceIDKey).(TraceID)
    return id, ok
}

func MustTraceIDFrom(ctx context.Context) TraceID {
    id, ok := TraceIDFrom(ctx)
    if !ok {
        return TraceID("unknown")
    }
    return id
}

// UserPrincipal operations
type UserPrincipal struct {
    UserID   string
    Email    string
    Roles    []string
    TenantID string
}

func (u *UserPrincipal) HasRole(role string) bool {
    for _, r := range u.Roles {
        if r == role {
            return true
        }
    }
    return false
}

func WithUserPrincipal(ctx context.Context, user *UserPrincipal) context.Context {
    return context.WithValue(ctx, userPrincipalKey, user)
}

func UserPrincipalFrom(ctx context.Context) (*UserPrincipal, bool) {
    user, ok := ctx.Value(userPrincipalKey).(*UserPrincipal)
    return user, ok
}

// Logger operations — request-scoped logger with trace context pre-populated
type Logger interface {
    Info(msg string, keysAndValues ...interface{})
    Error(err error, msg string, keysAndValues ...interface{})
    With(keysAndValues ...interface{}) Logger
}

func WithLogger(ctx context.Context, logger Logger) context.Context {
    return context.WithValue(ctx, loggerKey, logger)
}

func LoggerFrom(ctx context.Context) Logger {
    logger, ok := ctx.Value(loggerKey).(Logger)
    if !ok {
        return &noopLogger{}
    }
    return logger
}

type noopLogger struct{}

func (n *noopLogger) Info(msg string, keysAndValues ...interface{})              {}
func (n *noopLogger) Error(err error, msg string, keysAndValues ...interface{})  {}
func (n *noopLogger) With(keysAndValues ...interface{}) Logger                   { return n }
```

### Anti-Pattern: Using context.Value for Configuration

```go
// WRONG: Passing a database pool via context
type dbKey struct{}

func WithDB(ctx context.Context, db *sql.DB) context.Context {
    return context.WithValue(ctx, dbKey{}, db)
}

func DBFrom(ctx context.Context) *sql.DB {
    db, _ := ctx.Value(dbKey{}).(*sql.DB)
    return db
}

// This hides dependencies, makes functions hard to test, and
// makes the call graph opaque. Instead, use explicit dependency injection:

// CORRECT: Explicit dependency injection
type UserRepository struct {
    db *sql.DB
}

func (r *UserRepository) FindByID(ctx context.Context, id string) (*User, error) {
    // db is explicitly available via the receiver — no context magic needed
    row := r.db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)
    // ...
}
```

## Section 4: gRPC Context and Metadata

### Propagating Context Through gRPC

gRPC uses context for both cancellation propagation and metadata (the gRPC equivalent of HTTP headers). Metadata is sent in-band with the request:

```go
package grpc

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// UnaryClientInterceptor propagates trace IDs and auth tokens in gRPC metadata
func TraceIDClientInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Extract trace ID from context and inject into gRPC metadata
        if traceID, ok := contextkeys.TraceIDFrom(ctx); ok {
            ctx = metadata.AppendToOutgoingContext(ctx,
                "x-trace-id", string(traceID),
            )
        }

        // Extract user principal and inject auth header
        if user, ok := contextkeys.UserPrincipalFrom(ctx); ok {
            ctx = metadata.AppendToOutgoingContext(ctx,
                "x-user-id", user.UserID,
                "x-tenant-id", user.TenantID,
            )
        }

        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// UnaryServerInterceptor extracts metadata and populates context on the server side
func TraceIDServerInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            md = metadata.MD{}
        }

        // Extract and inject trace ID
        if traceIDs := md.Get("x-trace-id"); len(traceIDs) > 0 {
            ctx = contextkeys.WithTraceID(ctx, contextkeys.TraceID(traceIDs[0]))
        } else {
            // Generate a new trace ID if not present
            ctx = contextkeys.WithTraceID(ctx, contextkeys.TraceID(generateTraceID()))
        }

        return handler(ctx, req)
    }
}

// ExtractMetadata demonstrates reading gRPC metadata in service handlers
func ExtractMetadata(ctx context.Context) map[string]string {
    result := make(map[string]string)

    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return result
    }

    for key, values := range md {
        if len(values) > 0 {
            result[key] = values[0]
        }
    }

    return result
}

// gRPC server setup with interceptors
func NewGRPCServer() *grpc.Server {
    return grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            TraceIDServerInterceptor(),
            AuthServerInterceptor(),
            TimeoutServerInterceptor(30*time.Second),
        ),
        grpc.ChainStreamInterceptor(
            TraceIDStreamServerInterceptor(),
        ),
    )
}

// TimeoutServerInterceptor enforces a maximum deadline on incoming gRPC requests
func TimeoutServerInterceptor(maxTimeout time.Duration) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {

        // If the client sent a deadline, respect the shorter of client vs server limit
        if deadline, ok := ctx.Deadline(); ok {
            remaining := time.Until(deadline)
            if remaining > maxTimeout {
                // Client deadline is too generous; enforce server maximum
                var cancel context.CancelFunc
                ctx, cancel = context.WithTimeout(ctx, maxTimeout)
                defer cancel()
            }
        } else {
            // Client sent no deadline; apply server default
            var cancel context.CancelFunc
            ctx, cancel = context.WithTimeout(ctx, maxTimeout)
            defer cancel()
        }

        return handler(ctx, req)
    }
}
```

### Streaming gRPC and Context Cancellation

```go
// StreamServer demonstrates context handling in streaming gRPC
func (s *DataStreamServer) StreamData(
    req *StreamRequest,
    stream pb.DataService_StreamDataServer,
) error {

    ctx := stream.Context()

    for {
        // Always check context before each send
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        data, err := s.dataSource.Next(ctx)
        if err != nil {
            return status.Errorf(codes.Internal, "reading data: %v", err)
        }
        if data == nil {
            return nil // Stream complete
        }

        if err := stream.Send(&pb.DataChunk{Data: data}); err != nil {
            // Send error usually means the client disconnected
            return err
        }
    }
}
```

## Section 5: HTTP Request Context

### Attaching Context to HTTP Requests

```go
package httpcontext

import (
    "context"
    "net/http"
    "time"
)

// RequestContextMiddleware enriches the request context with
// trace IDs, auth principals, and request IDs.
func RequestContextMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract or generate trace ID
        traceID := r.Header.Get("X-Trace-Id")
        if traceID == "" {
            traceID = generateTraceID()
        }
        ctx = contextkeys.WithTraceID(ctx, contextkeys.TraceID(traceID))

        // Set trace ID in response header for the client
        w.Header().Set("X-Trace-Id", traceID)

        // Attach request-scoped logger
        logger := baseLogger.With(
            "traceID", traceID,
            "method", r.Method,
            "path", r.URL.Path,
        )
        ctx = contextkeys.WithLogger(ctx, logger)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// TimeoutMiddleware enforces a per-request timeout
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            // Run the handler in a goroutine so we can select on ctx.Done()
            done := make(chan struct{})
            var panicValue interface{}

            go func() {
                defer func() {
                    if p := recover(); p != nil {
                        panicValue = p
                    }
                    close(done)
                }()
                next.ServeHTTP(w, r.WithContext(ctx))
            }()

            select {
            case <-done:
                if panicValue != nil {
                    panic(panicValue) // Re-panic on the calling goroutine
                }
            case <-ctx.Done():
                w.WriteHeader(http.StatusGatewayTimeout)
            }
        })
    }
}

// OutgoingHTTPClient creates an HTTP client that propagates context headers
func OutgoingHTTPRequest(ctx context.Context, method, url string, body io.Reader) (*http.Request, error) {
    req, err := http.NewRequestWithContext(ctx, method, url, body)
    if err != nil {
        return nil, err
    }

    // Propagate trace ID to downstream services
    if traceID, ok := contextkeys.TraceIDFrom(ctx); ok {
        req.Header.Set("X-Trace-Id", string(traceID))
    }

    // Propagate auth principal if present
    if user, ok := contextkeys.UserPrincipalFrom(ctx); ok {
        req.Header.Set("X-User-Id", user.UserID)
        req.Header.Set("X-Tenant-Id", user.TenantID)
    }

    return req, nil
}
```

### HTTP Server Shutdown with Context

```go
// GracefulServer manages HTTP server lifecycle with context-based shutdown
type GracefulServer struct {
    server *http.Server
}

func NewGracefulServer(addr string, handler http.Handler) *GracefulServer {
    return &GracefulServer{
        server: &http.Server{
            Addr:         addr,
            Handler:      handler,
            ReadTimeout:  15 * time.Second,
            WriteTimeout: 30 * time.Second,
            IdleTimeout:  60 * time.Second,
        },
    }
}

func (s *GracefulServer) Run(ctx context.Context) error {
    serverErr := make(chan error, 1)

    go func() {
        if err := s.server.ListenAndServeTLS("", ""); err != http.ErrServerClosed {
            serverErr <- err
        }
    }()

    select {
    case err := <-serverErr:
        return fmt.Errorf("server error: %w", err)
    case <-ctx.Done():
        // Context cancelled — begin graceful shutdown
        shutdownCtx, shutdownCancel := context.WithTimeout(
            context.Background(), // Use background — parent ctx is already cancelled
            30*time.Second,
        )
        defer shutdownCancel()

        return s.server.Shutdown(shutdownCtx)
    }
}
```

## Section 6: Preventing Context Leaks

### The Goroutine Leak Pattern

The most common context-related bug is a goroutine that is never terminated because no one cancels the context it is waiting on:

```go
// WRONG: goroutine leaks if no one calls the cancel function
func startWorker(ctx context.Context) {
    // This context is derived but cancel is never called if the
    // function returns without cancellation
    workerCtx, _ := context.WithCancel(ctx) // Lost cancel function!

    go func() {
        for {
            select {
            case <-workerCtx.Done():
                return
            case work := <-workChan:
                process(workerCtx, work)
            }
        }
    }()
}

// CORRECT: Always defer cancel
func startWorker(ctx context.Context) {
    workerCtx, cancel := context.WithCancel(ctx)
    defer cancel() // This cancels when the outer function returns

    // But if the goroutine should outlive this function, pass the cancel
    // through a struct or a channel for explicit lifecycle management
}

// CORRECT: Explicit lifecycle management for long-running workers
type Worker struct {
    cancel context.CancelFunc
    done   chan struct{}
}

func StartWorker(ctx context.Context) *Worker {
    workerCtx, cancel := context.WithCancel(ctx)
    w := &Worker{
        cancel: cancel,
        done:   make(chan struct{}),
    }

    go func() {
        defer close(w.done)
        w.run(workerCtx)
    }()

    return w
}

func (w *Worker) Stop() {
    w.cancel()
    <-w.done // Wait for clean shutdown
}

func (w *Worker) run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case work := <-workChan:
            process(ctx, work)
        }
    }
}
```

### Detecting Context Leaks in Tests

```go
package leak_test

import (
    "context"
    "testing"
    "time"

    "go.uber.org/goleak"
)

func TestNoGoroutineLeaks(t *testing.T) {
    // goleak checks that no goroutines are leaked after the test completes
    defer goleak.VerifyNone(t)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    worker := StartWorker(ctx)
    // Do work...
    worker.Stop()
}

// ContextLeak demonstrates a detected leak
func TestContextLeak_WouldFail(t *testing.T) {
    defer goleak.VerifyNone(t, goleak.IgnoreCurrent()) // Ignores pre-existing goroutines

    ctx, cancel := context.WithCancel(context.Background())
    _ = cancel // Forgot to call cancel — goleak would detect the leaked goroutine

    go func() {
        <-ctx.Done() // This goroutine will never exit in this test
    }()

    // goleak.VerifyNone will fail because the goroutine is still running
}
```

### Channel and Context Coordination

```go
// SafeChannel wraps a channel with context-aware send and receive
type SafeChannel[T any] struct {
    ch chan T
}

func NewSafeChannel[T any](size int) *SafeChannel[T] {
    return &SafeChannel[T]{ch: make(chan T, size)}
}

// Send sends a value or returns if the context is cancelled
func (sc *SafeChannel[T]) Send(ctx context.Context, value T) error {
    select {
    case sc.ch <- value:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Receive receives a value or returns if the context is cancelled
func (sc *SafeChannel[T]) Receive(ctx context.Context) (T, error) {
    var zero T
    select {
    case value := <-sc.ch:
        return value, nil
    case <-ctx.Done():
        return zero, ctx.Err()
    }
}

// Fan-out with context cancellation
func FanOut[T any, R any](
    ctx context.Context,
    inputs []T,
    fn func(context.Context, T) (R, error),
    concurrency int,
) ([]R, error) {

    sem := make(chan struct{}, concurrency)
    results := make([]R, len(inputs))
    errCh := make(chan error, 1)

    var wg sync.WaitGroup
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    for i, input := range inputs {
        i, input := i, input // Capture loop variables
        wg.Add(1)

        go func() {
            defer wg.Done()

            // Acquire semaphore slot
            select {
            case sem <- struct{}{}:
                defer func() { <-sem }()
            case <-ctx.Done():
                select {
                case errCh <- ctx.Err():
                default:
                }
                return
            }

            result, err := fn(ctx, input)
            if err != nil {
                cancel() // Cancel all other goroutines on first error
                select {
                case errCh <- err:
                default:
                }
                return
            }
            results[i] = result
        }()
    }

    wg.Wait()

    select {
    case err := <-errCh:
        return nil, err
    default:
        return results, nil
    }
}
```

## Section 7: Context in Database Operations

### Database Connection Pool with Context

```go
package db

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// Repository wraps sql.DB with proper context propagation
type Repository struct {
    db *sql.DB
}

// FindUserByID demonstrates proper context usage with database operations
func (r *Repository) FindUserByID(ctx context.Context, id string) (*User, error) {
    // The context deadline is automatically respected by database/sql
    // If ctx is cancelled or expires, the query is interrupted
    row := r.db.QueryRowContext(ctx,
        "SELECT id, email, created_at FROM users WHERE id = $1",
        id,
    )

    var user User
    if err := row.Scan(&user.ID, &user.Email, &user.CreatedAt); err != nil {
        if err == sql.ErrNoRows {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("scanning user row: %w", err)
    }

    return &user, nil
}

// TransactWithContext executes a function within a database transaction,
// respecting the context deadline for the entire transaction.
func (r *Repository) TransactWithContext(
    ctx context.Context,
    fn func(ctx context.Context, tx *sql.Tx) error,
) error {

    tx, err := r.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted,
    })
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    if err := fn(ctx, tx); err != nil {
        if rbErr := tx.Rollback(); rbErr != nil {
            return fmt.Errorf("rollback failed: %v (original: %w)", rbErr, err)
        }
        return err
    }

    return tx.Commit()
}

// BatchInsert demonstrates context-aware batch operations
func (r *Repository) BatchInsert(ctx context.Context, users []*User) error {
    return r.TransactWithContext(ctx, func(ctx context.Context, tx *sql.Tx) error {
        stmt, err := tx.PrepareContext(ctx,
            "INSERT INTO users (id, email) VALUES ($1, $2)",
        )
        if err != nil {
            return err
        }
        defer stmt.Close()

        for _, user := range users {
            // Check context before each insert for large batches
            if err := ctx.Err(); err != nil {
                return err
            }

            if _, err := stmt.ExecContext(ctx, user.ID, user.Email); err != nil {
                return fmt.Errorf("inserting user %s: %w", user.ID, err)
            }
        }

        return nil
    })
}
```

## Section 8: Testing Context Behavior

```go
package context_test

import (
    "context"
    "errors"
    "testing"
    "time"
)

// TestDeadlinePropagation verifies that child context deadline does not
// exceed parent deadline.
func TestDeadlinePropagation(t *testing.T) {
    parent, parentCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer parentCancel()

    // Try to set a child deadline that exceeds the parent — should be clamped
    child, childCancel := context.WithTimeout(parent, 10*time.Second)
    defer childCancel()

    childDeadline, _ := child.Deadline()
    parentDeadline, _ := parent.Deadline()

    if childDeadline.After(parentDeadline) {
        t.Errorf("child deadline %v should not exceed parent deadline %v",
            childDeadline, parentDeadline)
    }
}

// TestCancellationPropagation verifies that cancelling a parent
// cancels all children.
func TestCancellationPropagation(t *testing.T) {
    parent, parentCancel := context.WithCancel(context.Background())

    children := make([]context.Context, 5)
    for i := range children {
        var cancel context.CancelFunc
        children[i], cancel = context.WithCancel(parent)
        defer cancel()
    }

    // Cancel the parent
    parentCancel()

    // All children should be cancelled
    for i, child := range children {
        select {
        case <-child.Done():
            if !errors.Is(child.Err(), context.Canceled) {
                t.Errorf("child[%d]: expected Canceled, got %v", i, child.Err())
            }
        case <-time.After(100 * time.Millisecond):
            t.Errorf("child[%d] not cancelled within timeout", i)
        }
    }
}

// TestContextValueTypeSafety verifies type-safe context value retrieval
func TestContextValueTypeSafety(t *testing.T) {
    ctx := context.Background()

    // Store a TraceID
    ctx = contextkeys.WithTraceID(ctx, contextkeys.TraceID("test-trace-123"))

    // Retrieve it correctly
    id, ok := contextkeys.TraceIDFrom(ctx)
    if !ok {
        t.Fatal("expected TraceID to be present")
    }
    if id != "test-trace-123" {
        t.Errorf("expected 'test-trace-123', got %q", id)
    }

    // Verify that accessing a different key type returns zero value
    _, ok = contextkeys.UserPrincipalFrom(ctx)
    if ok {
        t.Error("expected UserPrincipal to be absent")
    }
}
```

## Section 9: Production Patterns Reference

```go
// Production context setup at service entry points

// HTTP Handler entry point
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context() // Already has cancellation from the server

    // Apply server-side timeout
    ctx, cancel := context.WithTimeout(ctx, h.config.RequestTimeout)
    defer cancel() // ALWAYS defer cancel

    // Enrich with request-scoped data
    ctx = contextkeys.WithTraceID(ctx, contextkeys.TraceID(extractOrGenerateTraceID(r)))
    ctx = contextkeys.WithLogger(ctx, h.logger.With("traceID", extractOrGenerateTraceID(r)))

    h.handleRequest(ctx, w, r.WithContext(ctx))
}

// Background worker entry point
func (w *Worker) processJob(job *Job) {
    // Workers use context.Background() as root — they are not request-scoped
    ctx, cancel := context.WithTimeout(context.Background(), w.config.JobTimeout)
    defer cancel()

    // Attach job-scoped logging
    ctx = contextkeys.WithTraceID(ctx, contextkeys.TraceID(job.ID))

    if err := w.execute(ctx, job); err != nil {
        w.logger.Error(err, "job failed", "jobID", job.ID)
    }
}

// Startup/initialization entry point
func (app *Application) Start(ctx context.Context) error {
    // Use the provided context — caller controls shutdown
    // (typically a signal-based context from main)

    if err := app.db.Ping(ctx); err != nil {
        return fmt.Errorf("database health check: %w", err)
    }

    return app.server.Run(ctx)
}
```

## Conclusion

Context is Go's primary mechanism for managing the lifecycle of operations across goroutine and service boundaries. The golden rules for production code are: always accept context as the first parameter, always defer cancel for every WithCancel/WithTimeout/WithDeadline call, use typed private keys for context values, respect parent deadlines when computing child deadlines, and treat context.Value as a transport for request-scoped metadata rather than a dependency injection mechanism. With these practices in place, your distributed Go services will handle cancellation, timeouts, and request tracing reliably at any scale.
