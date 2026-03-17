---
title: "Go Context Propagation: Deadlines, Cancellation, Value Chaining, and Context-Aware Libraries"
date: 2028-08-17T00:00:00-05:00
draft: false
tags: ["Go", "Context", "Concurrency", "Cancellation", "Deadlines"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go's context package for production systems. Covers deadline and timeout propagation, cancellation patterns, value chaining anti-patterns, context-aware library design, and debugging context leaks."
more_link: "yes"
url: "/go-context-propagation-deadlines-guide/"
---

The `context` package is Go's mechanism for propagating deadlines, cancellation signals, and request-scoped values across API boundaries. Every production Go service uses context — or should. Misusing it is one of the most common sources of goroutine leaks, deadline violations, and silent failures. This guide covers everything from basic deadline propagation to advanced patterns like middleware chaining, context-aware library design, and tracing context leaks in production.

<!--more-->

# [Go Context Propagation](#go-context-propagation)

## Section 1: Context Fundamentals

A `context.Context` is an immutable value that carries:
1. A cancellation signal (from `context.WithCancel`, `WithTimeout`, `WithDeadline`)
2. A deadline — the absolute time at which the context expires
3. Key-value pairs (`context.WithValue`)

Every `Context` forms a tree. Cancelling a parent context cancels all descendant contexts. This is how HTTP request cancellation propagates through every layer of your service.

```go
// The Context interface
type Context interface {
    Deadline() (deadline time.Time, ok bool)
    Done() <-chan struct{}     // closed when context is cancelled
    Err() error               // context.Canceled or context.DeadlineExceeded
    Value(key any) any
}
```

### Context Lifecycle

```go
package main

import (
    "context"
    "fmt"
    "time"
)

func demonstrateContextLifecycle() {
    // Root context — never cancelled, no deadline
    root := context.Background()

    // Timeout context — cancelled after 5 seconds
    ctx, cancel := context.WithTimeout(root, 5*time.Second)
    defer cancel() // ALWAYS defer cancel to release resources

    // Check deadline
    if deadline, ok := ctx.Deadline(); ok {
        fmt.Printf("Deadline: %v (in %v)\n", deadline, time.Until(deadline))
    }

    // Non-blocking check
    select {
    case <-ctx.Done():
        fmt.Println("Context done:", ctx.Err())
    default:
        fmt.Println("Context still active")
    }

    // Simulate work
    time.Sleep(6 * time.Second)

    // Now context is expired
    select {
    case <-ctx.Done():
        fmt.Println("Context expired:", ctx.Err()) // context.DeadlineExceeded
    default:
        fmt.Println("Should not reach here")
    }
}
```

## Section 2: Deadline and Timeout Patterns

### The Golden Rule: Always Pass Context Downward

```go
// WRONG: Creating a new background context loses deadline propagation
func (s *Service) HandleRequest(ctx context.Context, req Request) error {
    // This ignores the incoming deadline!
    result, err := s.db.QueryContext(context.Background(), "SELECT ...")
    return err
}

// CORRECT: Thread the context through every call
func (s *Service) HandleRequest(ctx context.Context, req Request) error {
    result, err := s.db.QueryContext(ctx, "SELECT ...")
    return err
}
```

### Tightening Deadlines

Child contexts can only reduce deadlines, never extend them:

```go
func processOrder(ctx context.Context, orderID string) error {
    // The incoming ctx might have a 30s deadline from the HTTP handler.
    // We want inventory check to have at most 5 seconds.
    inventoryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    if err := reserveInventory(inventoryCtx, orderID); err != nil {
        return fmt.Errorf("reserving inventory: %w", err)
    }

    // Payment gets whatever is left of the original 30s deadline,
    // minus the time spent on inventory.
    if err := chargePayment(ctx, orderID); err != nil {
        return fmt.Errorf("charging payment: %w", err)
    }

    return nil
}
```

### Checking Remaining Time Before Expensive Operations

```go
func callExternalAPI(ctx context.Context, payload []byte) error {
    // Don't bother making the call if less than 100ms remains
    if deadline, ok := ctx.Deadline(); ok {
        remaining := time.Until(deadline)
        if remaining < 100*time.Millisecond {
            return fmt.Errorf("insufficient time remaining (%v): %w",
                remaining, context.DeadlineExceeded)
        }
    }

    // Make the call...
    req, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewReader(payload))
    if err != nil {
        return err
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    return nil
}
```

### Timeout Budgets

A timeout budget tracks remaining time across multiple operations:

```go
// internal/timeout/budget.go
package timeout

import (
    "context"
    "fmt"
    "time"
)

type Budget struct {
    deadline time.Time
    ops      []operationRecord
}

type operationRecord struct {
    name     string
    duration time.Duration
}

func NewBudget(ctx context.Context) *Budget {
    b := &Budget{}
    if deadline, ok := ctx.Deadline(); ok {
        b.deadline = deadline
    }
    return b
}

func (b *Budget) Remaining() time.Duration {
    if b.deadline.IsZero() {
        return time.Duration(1<<63 - 1) // No deadline
    }
    return time.Until(b.deadline)
}

func (b *Budget) Reserve(name string, desired time.Duration) (time.Duration, error) {
    remaining := b.Remaining()
    if remaining <= 0 {
        return 0, fmt.Errorf("timeout budget exhausted during %s", name)
    }
    if desired > remaining {
        return remaining, nil // Give it what we have
    }
    return desired, nil
}

func (b *Budget) Record(name string, duration time.Duration) {
    b.ops = append(b.ops, operationRecord{name: name, duration: duration})
}

func (b *Budget) Summary() string {
    if len(b.ops) == 0 {
        return "no operations recorded"
    }
    var total time.Duration
    result := "timeout budget summary:\n"
    for _, op := range b.ops {
        result += fmt.Sprintf("  %s: %v\n", op.name, op.duration)
        total += op.duration
    }
    result += fmt.Sprintf("  total: %v, remaining: %v\n", total, b.Remaining())
    return result
}

// Usage
func processWithBudget(ctx context.Context, req Request) error {
    budget := timeout.NewBudget(ctx)

    // Reserve time for each operation
    dbTimeout, err := budget.Reserve("database", 100*time.Millisecond)
    if err != nil {
        return err
    }

    start := time.Now()
    dbCtx, cancel := context.WithTimeout(ctx, dbTimeout)
    defer cancel()

    if err := queryDatabase(dbCtx, req.ID); err != nil {
        return err
    }
    budget.Record("database", time.Since(start))

    // Reserve time for API call
    apiTimeout, err := budget.Reserve("external-api", 200*time.Millisecond)
    if err != nil {
        return fmt.Errorf("no time left for API call: %w", err)
    }

    start = time.Now()
    apiCtx, cancel2 := context.WithTimeout(ctx, apiTimeout)
    defer cancel2()

    if err := callAPI(apiCtx, req); err != nil {
        return err
    }
    budget.Record("external-api", time.Since(start))

    return nil
}
```

## Section 3: Cancellation Patterns

### Fan-Out with Cancellation

```go
// parallel_fetch.go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type Result struct {
    Source string
    Data   []byte
    Err    error
}

// FetchAll fetches from multiple sources concurrently.
// If any source fails with a non-retryable error, all others are cancelled.
func FetchAll(ctx context.Context, sources []string) ([]Result, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    results := make(chan Result, len(sources))
    var wg sync.WaitGroup

    for _, source := range sources {
        wg.Add(1)
        go func(src string) {
            defer wg.Done()
            data, err := fetch(ctx, src)
            results <- Result{Source: src, Data: data, Err: err}

            // Cancel all others on critical error
            if err != nil && isCriticalError(err) {
                cancel()
            }
        }(source)
    }

    // Close results channel when all goroutines finish
    go func() {
        wg.Wait()
        close(results)
    }()

    var allResults []Result
    for r := range results {
        allResults = append(allResults, r)
    }

    // Check if context was cancelled
    if ctx.Err() != nil {
        for _, r := range allResults {
            if r.Err != nil && isCriticalError(r.Err) {
                return nil, fmt.Errorf("fetch cancelled due to error in %s: %w", r.Source, r.Err)
            }
        }
    }

    return allResults, nil
}

func isCriticalError(err error) bool {
    return err != nil && err.Error() == "critical"
}

func fetch(ctx context.Context, url string) ([]byte, error) {
    // Simulated fetch
    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    case <-time.After(100 * time.Millisecond):
        return []byte("data"), nil
    }
}
```

### First-Success Pattern

```go
// Return the first successful result, cancel the rest
func FirstSuccess(ctx context.Context, fns []func(context.Context) (string, error)) (string, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    type result struct {
        val string
        err error
    }

    ch := make(chan result, len(fns))

    for _, fn := range fns {
        go func(f func(context.Context) (string, error)) {
            val, err := f(ctx)
            ch <- result{val, err}
        }(fn)
    }

    var lastErr error
    for i := 0; i < len(fns); i++ {
        r := <-ch
        if r.err == nil {
            cancel() // Cancel remaining goroutines
            return r.val, nil
        }
        lastErr = r.err
    }

    return "", fmt.Errorf("all attempts failed, last error: %w", lastErr)
}
```

### Graceful Shutdown with Context

```go
// server.go
package server

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
    "log/slog"
)

type Server struct {
    http    *http.Server
    logger  *slog.Logger
    cleanup []func(context.Context) error
}

func (s *Server) RegisterCleanup(fn func(context.Context) error) {
    s.cleanup = append(s.cleanup, fn)
}

func (s *Server) Run(ctx context.Context) error {
    // Trap shutdown signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    defer signal.Stop(sigCh)

    // Start HTTP server
    errCh := make(chan error, 1)
    go func() {
        s.logger.Info("server starting", "addr", s.http.Addr)
        if err := s.http.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            errCh <- err
        }
    }()

    // Wait for signal or error
    select {
    case sig := <-sigCh:
        s.logger.Info("received signal", "signal", sig)
    case err := <-errCh:
        return fmt.Errorf("server error: %w", err)
    case <-ctx.Done():
        s.logger.Info("context cancelled")
    }

    // Graceful shutdown with 30s timeout
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    s.logger.Info("shutting down HTTP server")
    if err := s.http.Shutdown(shutdownCtx); err != nil {
        s.logger.Error("HTTP server shutdown error", "error", err)
    }

    // Run cleanup functions
    for _, fn := range s.cleanup {
        if err := fn(shutdownCtx); err != nil {
            s.logger.Error("cleanup error", "error", err)
        }
    }

    s.logger.Info("shutdown complete")
    return nil
}
```

## Section 4: Context Values — Patterns and Anti-Patterns

### What Belongs in Context

Context values are appropriate for **request-scoped** data that crosses API boundaries:
- Request ID / Trace ID
- Authenticated user identity
- Authorization claims
- Tenant/organization ID
- Feature flags for this request

Context values are NOT appropriate for:
- Optional function parameters
- Configuration
- Database connections
- Logger instances (pass as struct fields or function parameters)

### Type-Safe Context Keys

```go
// internal/ctxkeys/keys.go
package ctxkeys

import "context"

// Use unexported types to prevent collisions with other packages
type contextKey int

const (
    keyRequestID contextKey = iota
    keyUserID
    keyTenantID
    keyTraceFlags
)

// RequestID
type RequestID string

func WithRequestID(ctx context.Context, id RequestID) context.Context {
    return context.WithValue(ctx, keyRequestID, id)
}

func GetRequestID(ctx context.Context) (RequestID, bool) {
    id, ok := ctx.Value(keyRequestID).(RequestID)
    return id, ok
}

func MustGetRequestID(ctx context.Context) RequestID {
    id, ok := GetRequestID(ctx)
    if !ok {
        return "unknown"
    }
    return id
}

// UserID
type UserID string

func WithUserID(ctx context.Context, id UserID) context.Context {
    return context.WithValue(ctx, keyUserID, id)
}

func GetUserID(ctx context.Context) (UserID, bool) {
    id, ok := ctx.Value(keyUserID).(UserID)
    return id, ok
}

// TenantID
type TenantID string

func WithTenantID(ctx context.Context, id TenantID) context.Context {
    return context.WithValue(ctx, keyTenantID, id)
}

func GetTenantID(ctx context.Context) (TenantID, bool) {
    id, ok := ctx.Value(keyTenantID).(TenantID)
    return id, ok
}

// Usage in middleware
func AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        claims, err := validateToken(token)
        if err != nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }

        ctx := r.Context()
        ctx = ctxkeys.WithUserID(ctx, ctxkeys.UserID(claims.UserID))
        ctx = ctxkeys.WithTenantID(ctx, ctxkeys.TenantID(claims.TenantID))

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Context Value Anti-Patterns

```go
// ANTI-PATTERN 1: Using context to pass optional parameters
// This hides dependencies and makes code harder to test

// BAD
func HandleRequest(ctx context.Context) error {
    db := ctx.Value("db").(*sql.DB) // Fails at runtime if not set
    return nil
}

// GOOD — pass db explicitly
func HandleRequest(ctx context.Context, db *sql.DB) error {
    return nil
}

// ANTI-PATTERN 2: Using string keys (collision risk)
ctx = context.WithValue(ctx, "userID", "123") // BAD: any package can read/overwrite this

// GOOD — use unexported typed key
ctx = ctxkeys.WithUserID(ctx, "123")

// ANTI-PATTERN 3: Storing mutable state in context
// Context values are read-only by convention, never mutate them
type RequestStats struct {
    mu       sync.Mutex
    DBCalls  int
    CacheMiss int
}
// BAD: mutating context value
stats := ctx.Value(keyStats).(*RequestStats)
stats.mu.Lock()
stats.DBCalls++ // This works but is confusing and error-prone
stats.mu.Unlock()
```

## Section 5: Context-Aware Library Design

### Designing Cancellable Operations

```go
// internal/worker/processor.go
package worker

import (
    "context"
    "fmt"
    "log/slog"
    "sync"
    "time"
)

type Job struct {
    ID      string
    Payload []byte
}

type Processor struct {
    concurrency int
    logger      *slog.Logger
    process     func(context.Context, Job) error
}

func NewProcessor(
    concurrency int,
    process func(context.Context, Job) error,
    logger *slog.Logger,
) *Processor {
    return &Processor{
        concurrency: concurrency,
        logger:      logger,
        process:     process,
    }
}

func (p *Processor) Run(ctx context.Context, jobs <-chan Job) error {
    var wg sync.WaitGroup
    semaphore := make(chan struct{}, p.concurrency)

    for {
        select {
        case <-ctx.Done():
            // Stop accepting new jobs, wait for in-flight jobs
            wg.Wait()
            return ctx.Err()

        case job, ok := <-jobs:
            if !ok {
                // Channel closed — drain all in-flight jobs
                wg.Wait()
                return nil
            }

            semaphore <- struct{}{} // Acquire slot
            wg.Add(1)

            go func(j Job) {
                defer wg.Done()
                defer func() { <-semaphore }()

                // Each job gets a per-job timeout derived from parent context
                jobCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
                defer cancel()

                start := time.Now()
                err := p.process(jobCtx, j)
                duration := time.Since(start)

                if err != nil {
                    p.logger.Error("job failed",
                        "job_id", j.ID,
                        "duration", duration,
                        "error", err,
                    )
                } else {
                    p.logger.Debug("job completed",
                        "job_id", j.ID,
                        "duration", duration,
                    )
                }
            }(job)
        }
    }
}
```

### Retry with Context Awareness

```go
// internal/retry/retry.go
package retry

import (
    "context"
    "errors"
    "fmt"
    "math"
    "time"
)

type Config struct {
    MaxAttempts int
    InitialWait time.Duration
    MaxWait     time.Duration
    Multiplier  float64
    Jitter      time.Duration
}

func DefaultConfig() Config {
    return Config{
        MaxAttempts: 5,
        InitialWait: 100 * time.Millisecond,
        MaxWait:     30 * time.Second,
        Multiplier:  2.0,
        Jitter:      50 * time.Millisecond,
    }
}

type PermanentError struct {
    Err error
}

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error  { return e.Err }

func Permanent(err error) error {
    return &PermanentError{Err: err}
}

func Do(ctx context.Context, cfg Config, fn func(ctx context.Context) error) error {
    var lastErr error

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        // Check context before each attempt
        if ctx.Err() != nil {
            return fmt.Errorf("context cancelled after %d attempts: %w", attempt, ctx.Err())
        }

        err := fn(ctx)
        if err == nil {
            return nil
        }

        // Don't retry permanent errors
        var permErr *PermanentError
        if errors.As(err, &permErr) {
            return permErr.Err
        }

        lastErr = err

        if attempt == cfg.MaxAttempts-1 {
            break
        }

        // Calculate backoff with jitter
        wait := time.Duration(float64(cfg.InitialWait) * math.Pow(cfg.Multiplier, float64(attempt)))
        if wait > cfg.MaxWait {
            wait = cfg.MaxWait
        }
        // Add jitter
        if cfg.Jitter > 0 {
            wait += time.Duration(float64(cfg.Jitter) * (2*randFloat() - 1))
        }

        // Check if we have enough time left
        if deadline, ok := ctx.Deadline(); ok {
            remaining := time.Until(deadline)
            if remaining < wait {
                return fmt.Errorf("insufficient time for retry (need %v, have %v): %w",
                    wait, remaining, lastErr)
            }
        }

        timer := time.NewTimer(wait)
        select {
        case <-ctx.Done():
            timer.Stop()
            return fmt.Errorf("cancelled during retry wait: %w", ctx.Err())
        case <-timer.C:
        }
    }

    return fmt.Errorf("max attempts (%d) exceeded: %w", cfg.MaxAttempts, lastErr)
}

func randFloat() float64 {
    // Simple pseudo-random for brevity; use math/rand in production
    return 0.5
}
```

### Rate Limiter with Context

```go
// internal/ratelimit/limiter.go
package ratelimit

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type TokenBucket struct {
    mu         sync.Mutex
    tokens     float64
    maxTokens  float64
    refillRate float64 // tokens per second
    lastRefill time.Time
}

func NewTokenBucket(rps float64, burst float64) *TokenBucket {
    return &TokenBucket{
        tokens:     burst,
        maxTokens:  burst,
        refillRate: rps,
        lastRefill: time.Now(),
    }
}

func (b *TokenBucket) Wait(ctx context.Context) error {
    return b.WaitN(ctx, 1)
}

func (b *TokenBucket) WaitN(ctx context.Context, n float64) error {
    for {
        b.mu.Lock()
        b.refill()

        if b.tokens >= n {
            b.tokens -= n
            b.mu.Unlock()
            return nil
        }

        // Calculate wait time
        deficit := n - b.tokens
        wait := time.Duration(deficit/b.refillRate) * time.Second
        b.mu.Unlock()

        // Check if deadline allows waiting
        if deadline, ok := ctx.Deadline(); ok {
            if time.Until(deadline) < wait {
                return fmt.Errorf("context deadline would expire before rate limit token available: %w",
                    context.DeadlineExceeded)
            }
        }

        timer := time.NewTimer(wait)
        select {
        case <-ctx.Done():
            timer.Stop()
            return ctx.Err()
        case <-timer.C:
            // Loop and try again
        }
    }
}

func (b *TokenBucket) TryAcquire() bool {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.refill()
    if b.tokens >= 1 {
        b.tokens--
        return true
    }
    return false
}

func (b *TokenBucket) refill() {
    now := time.Now()
    elapsed := now.Sub(b.lastRefill).Seconds()
    b.tokens = min(b.maxTokens, b.tokens+elapsed*b.refillRate)
    b.lastRefill = now
}

func min(a, b float64) float64 {
    if a < b {
        return a
    }
    return b
}
```

## Section 6: Context in HTTP Middleware Chains

### Request Context Middleware

```go
// internal/middleware/context.go
package middleware

import (
    "context"
    "net/http"
    "time"

    "github.com/google/uuid"
    "go.opentelemetry.io/otel/trace"

    "github.com/myorg/myapp/internal/ctxkeys"
)

// RequestID adds a unique request ID to the context
func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Prefer incoming ID from upstream proxy
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }

        ctx := ctxkeys.WithRequestID(r.Context(), ctxkeys.RequestID(requestID))
        w.Header().Set("X-Request-ID", requestID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// TraceID adds the OTel trace ID to the context and response headers
func TraceID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        span := trace.SpanFromContext(r.Context())
        if span.SpanContext().IsValid() {
            traceID := span.SpanContext().TraceID().String()
            w.Header().Set("X-Trace-ID", traceID)
        }
        next.ServeHTTP(w, r)
    })
}

// RequestTimeout limits the lifetime of each request context
func RequestTimeout(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            // Run handler in goroutine to detect context cancellation
            done := make(chan struct{})
            panicCh := make(chan interface{}, 1)

            go func() {
                defer func() {
                    if p := recover(); p != nil {
                        panicCh <- p
                    }
                    close(done)
                }()
                next.ServeHTTP(w, r.WithContext(ctx))
            }()

            select {
            case <-done:
                // Handler completed normally
            case p := <-panicCh:
                panic(p)
            case <-ctx.Done():
                // Timeout — but we cannot write headers if already sent
                w.WriteHeader(http.StatusGatewayTimeout)
            }
        })
    }
}

// UserContext extracts authenticated user from JWT and adds to context
func UserContext(validator TokenValidator) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := extractBearerToken(r)
            if token == "" {
                http.Error(w, "missing authorization", http.StatusUnauthorized)
                return
            }

            claims, err := validator.ValidateToken(r.Context(), token)
            if err != nil {
                http.Error(w, "invalid token", http.StatusUnauthorized)
                return
            }

            ctx := r.Context()
            ctx = ctxkeys.WithUserID(ctx, ctxkeys.UserID(claims.UserID))
            ctx = ctxkeys.WithTenantID(ctx, ctxkeys.TenantID(claims.TenantID))

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func extractBearerToken(r *http.Request) string {
    auth := r.Header.Get("Authorization")
    if len(auth) > 7 && auth[:7] == "Bearer " {
        return auth[7:]
    }
    return ""
}

type TokenValidator interface {
    ValidateToken(ctx context.Context, token string) (*Claims, error)
}

type Claims struct {
    UserID   string
    TenantID string
}
```

## Section 7: Detecting Context Leaks

### Goroutine Leak Detection

Context cancellation is the primary mechanism for goroutine lifecycle management. Goroutine leaks are usually caused by forgetting to cancel a context.

```go
// internal/testing/goroutine_leak.go
package testutil

import (
    "fmt"
    "runtime"
    "strings"
    "testing"
    "time"
)

// LeakDetector checks for goroutine leaks in tests
type LeakDetector struct {
    before []goroutine
}

type goroutine struct {
    id    int
    stack string
}

func NewLeakDetector() *LeakDetector {
    return &LeakDetector{
        before: captureGoroutines(),
    }
}

func (d *LeakDetector) Check(t *testing.T) {
    t.Helper()

    // Give goroutines time to finish
    time.Sleep(100 * time.Millisecond)

    after := captureGoroutines()
    leaked := findLeaked(d.before, after)

    if len(leaked) > 0 {
        t.Errorf("goroutine leak detected: %d goroutines still running:\n%s",
            len(leaked),
            formatGoroutines(leaked),
        )
    }
}

func captureGoroutines() []goroutine {
    buf := make([]byte, 1<<20)
    n := runtime.Stack(buf, true)
    stack := string(buf[:n])

    var goroutines []goroutine
    for _, entry := range strings.Split(stack, "\n\n") {
        if entry == "" {
            continue
        }
        var id int
        fmt.Sscanf(entry, "goroutine %d [", &id)
        goroutines = append(goroutines, goroutine{id: id, stack: entry})
    }
    return goroutines
}

func findLeaked(before, after []goroutine) []goroutine {
    beforeIDs := make(map[int]bool)
    for _, g := range before {
        beforeIDs[g.id] = true
    }

    var leaked []goroutine
    for _, g := range after {
        if !beforeIDs[g.id] {
            leaked = append(leaked, g)
        }
    }
    return leaked
}

func formatGoroutines(gs []goroutine) string {
    var sb strings.Builder
    for _, g := range gs {
        sb.WriteString(g.stack)
        sb.WriteString("\n\n")
    }
    return sb.String()
}

// Usage in tests
func TestSomething(t *testing.T) {
    leakDet := testutil.NewLeakDetector()
    defer leakDet.Check(t)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Run test...
}
```

### Context Timeout Histogram

```go
// internal/metrics/context_metrics.go
package metrics

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    contextTimeoutTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "context_timeout_total",
            Help: "Total context deadline exceeded errors",
        },
        []string{"operation"},
    )

    contextCancelTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "context_cancel_total",
            Help: "Total context cancelled errors",
        },
        []string{"operation"},
    )

    operationDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "operation_duration_seconds",
            Help:    "Duration of operations with context tracking",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"operation", "result"},
    )
)

// TrackOperation wraps an operation with context-aware metrics
func TrackOperation(ctx context.Context, name string, fn func() error) error {
    start := time.Now()

    err := fn()
    duration := time.Since(start)

    var result string
    switch {
    case err == nil:
        result = "success"
    case ctx.Err() == context.DeadlineExceeded:
        result = "timeout"
        contextTimeoutTotal.WithLabelValues(name).Inc()
    case ctx.Err() == context.Canceled:
        result = "cancelled"
        contextCancelTotal.WithLabelValues(name).Inc()
    default:
        result = "error"
    }

    operationDuration.WithLabelValues(name, result).Observe(duration.Seconds())
    return err
}
```

## Section 8: Common Mistakes and How to Avoid Them

### Mistake 1: Ignoring Cancel Return

```go
// WRONG: cancel is never called — goroutine and timer leak
ctx, _ = context.WithTimeout(parent, 5*time.Second)

// CORRECT
ctx, cancel := context.WithTimeout(parent, 5*time.Second)
defer cancel()
```

### Mistake 2: Using context.Background() Inside a Handler

```go
// WRONG: Creates a new background context that ignores the request's deadline
func (h *Handler) ProcessPayment(w http.ResponseWriter, r *http.Request) {
    // If client disconnects, this still runs!
    result, err := h.paymentSvc.Charge(context.Background(), r)
    ...
}

// CORRECT
func (h *Handler) ProcessPayment(w http.ResponseWriter, r *http.Request) {
    result, err := h.paymentSvc.Charge(r.Context(), r)
    ...
}
```

### Mistake 3: Storing context in struct fields

```go
// WRONG
type Request struct {
    ctx    context.Context  // BAD: context stored in struct
    UserID string
}

// CORRECT: Pass context to methods, not constructors
type Request struct {
    UserID string
}

func (r *Request) Process(ctx context.Context) error {
    return doSomething(ctx, r.UserID)
}
```

### Mistake 4: Not Propagating Cancellation Through Channels

```go
// WRONG: Can block forever if context is cancelled
func sendToChannel(ctx context.Context, ch chan<- Work, work Work) error {
    ch <- work  // Blocks if channel is full, ignores ctx cancellation
    return nil
}

// CORRECT
func sendToChannel(ctx context.Context, ch chan<- Work, work Work) error {
    select {
    case ch <- work:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

## Conclusion

Context is Go's answer to request lifecycle management. The three rules to follow are: always thread context through every function that does I/O; always `defer cancel()` immediately after creating a cancelable context; and only store request-scoped, immutable values in context.

For production services, add context-aware metrics to track deadline exceeded rates. Spikes in `context.DeadlineExceeded` indicate either that your timeouts are too tight for current load or that an upstream dependency is slow. This signal is far more actionable than a generic "request failed" error counter.
