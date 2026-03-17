---
title: "Go: Implementing Retry Logic with Exponential Backoff, Jitter, and Deadline Propagation"
date: 2031-08-14T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Resilience", "Retry", "Backoff", "Context", "Distributed Systems"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing production-grade retry logic in Go with exponential backoff, full jitter, deadline propagation, circuit breakers, and composable retry policies for resilient distributed systems."
more_link: "yes"
url: "/go-retry-logic-exponential-backoff-jitter-deadline-propagation/"
---

Transient failures are inevitable in distributed systems. Network timeouts, temporary service unavailability, and rate limiting are normal operational events. The difference between a brittle and a resilient service often comes down to how — not whether — you retry failed operations. This post builds a complete, production-grade retry library in Go with exponential backoff, full jitter, context-aware deadline propagation, and composable policies.

<!--more-->

# Go: Implementing Retry Logic with Exponential Backoff, Jitter, and Deadline Propagation

## Overview

Good retry logic is more nuanced than "try 3 times with a 1 second sleep." A production retry implementation must:

- **Respect deadlines** — if the caller's context expires at t+5s, don't retry past t+5s
- **Apply jitter** — spread retry attempts to prevent thundering herd
- **Distinguish error types** — only retry transient errors, never retry permanent failures
- **Honor rate limits** — respect `Retry-After` headers
- **Report metrics** — expose retry attempt counts and backoff durations
- **Support circuit breaking** — stop retrying when a dependency is clearly down

---

## Section 1: Core Backoff Algorithms

### 1.1 Algorithm Overview

```
Constant:         |---|---|---|---|---| (fixed delay)
Linear:           |---|-----|---------|---| (grows linearly)
Exponential:      |---|-----|-----------|---------------|
Exponential+Jitter: |-|--^--|----^-----|----^--------| (+ random spread)
Full Jitter:      |^--|--^--|-----^---|---------^----|
```

The "Full Jitter" algorithm (rand between 0 and cap) is recommended by AWS for distributed systems because it maximally spreads retries across the retry window.

### 1.2 Backoff Implementation

```go
// pkg/retry/backoff.go
package retry

import (
    "math"
    "math/rand"
    "time"
)

// BackoffFunc returns the duration to wait before the next attempt.
// attempt starts at 1 for the first retry (attempt 0 = first try).
type BackoffFunc func(attempt int) time.Duration

// Constant returns a BackoffFunc that always returns the same duration.
func Constant(d time.Duration) BackoffFunc {
    return func(_ int) time.Duration {
        return d
    }
}

// Linear returns a BackoffFunc that increases delay linearly.
// delay = base * attempt
func Linear(base time.Duration) BackoffFunc {
    return func(attempt int) time.Duration {
        return base * time.Duration(attempt)
    }
}

// Exponential returns a BackoffFunc that doubles delay each attempt.
// delay = min(base * 2^attempt, max)
func Exponential(base, max time.Duration) BackoffFunc {
    return func(attempt int) time.Duration {
        delay := float64(base) * math.Pow(2, float64(attempt-1))
        if delay > float64(max) {
            delay = float64(max)
        }
        return time.Duration(delay)
    }
}

// ExponentialWithJitter implements the "full jitter" algorithm.
// delay = rand(0, min(base * 2^attempt, max))
// This is the recommended algorithm for distributed systems.
func ExponentialWithJitter(base, max time.Duration) BackoffFunc {
    return ExponentialWithJitterAndSeed(base, max, rand.New(rand.NewSource(time.Now().UnixNano())))
}

// ExponentialWithJitterAndSeed allows providing a custom random source (for testing).
func ExponentialWithJitterAndSeed(base, max time.Duration, r *rand.Rand) BackoffFunc {
    return func(attempt int) time.Duration {
        // Compute the exponential cap
        cap := float64(base) * math.Pow(2, float64(attempt-1))
        if cap > float64(max) {
            cap = float64(max)
        }
        // Full jitter: uniform random between 0 and cap
        jittered := r.Float64() * cap
        return time.Duration(jittered)
    }
}

// DecorrelatedJitter implements the decorrelated jitter algorithm.
// Slightly different spread characteristics from full jitter.
// sleep = rand(base, min(cap, prev_sleep * 3))
func DecorrelatedJitter(base, max time.Duration) BackoffFunc {
    prev := base
    r := rand.New(rand.NewSource(time.Now().UnixNano()))
    return func(_ int) time.Duration {
        cap := float64(prev) * 3
        if cap > float64(max) {
            cap = float64(max)
        }
        min := float64(base)
        delay := min + r.Float64()*(cap-min)
        prev = time.Duration(delay)
        return prev
    }
}

// WithMinimum ensures the backoff is at least min duration.
func WithMinimum(b BackoffFunc, min time.Duration) BackoffFunc {
    return func(attempt int) time.Duration {
        d := b(attempt)
        if d < min {
            return min
        }
        return d
    }
}
```

---

## Section 2: Error Classification

### 2.1 Retryable Error Interface

```go
// pkg/retry/errors.go
package retry

import (
    "errors"
    "net"
    "net/http"
    "time"
)

// RetryableError wraps an error with retry metadata.
type RetryableError struct {
    Err        error
    RetryAfter time.Duration  // From Retry-After header
    Permanent  bool           // If true, never retry
}

func (e *RetryableError) Error() string { return e.Err.Error() }
func (e *RetryableError) Unwrap() error { return e.Err }

// Permanent marks an error as permanent (should never be retried).
func Permanent(err error) error {
    return &RetryableError{Err: err, Permanent: true}
}

// WithRetryAfter creates an error with a specific retry-after duration.
func WithRetryAfter(err error, after time.Duration) error {
    return &RetryableError{Err: err, RetryAfter: after}
}

// IsPermanent returns true if the error should not be retried.
func IsPermanent(err error) bool {
    var re *RetryableError
    if errors.As(err, &re) {
        return re.Permanent
    }
    return false
}

// GetRetryAfter returns the retry-after duration if specified in the error.
func GetRetryAfter(err error) (time.Duration, bool) {
    var re *RetryableError
    if errors.As(err, &re) && re.RetryAfter > 0 {
        return re.RetryAfter, true
    }
    return 0, false
}

// DefaultIsRetryable is the default function that determines if an error should
// trigger a retry. It handles common network and HTTP errors.
func DefaultIsRetryable(err error) bool {
    if err == nil {
        return false
    }

    // Never retry permanent errors
    if IsPermanent(err) {
        return false
    }

    // Check for known retryable error types
    var netErr net.Error
    if errors.As(err, &netErr) {
        return netErr.Timeout() || netErr.Temporary()
    }

    // Retry on connection reset or refused
    var opErr *net.OpError
    if errors.As(err, &opErr) {
        return true
    }

    return true // Default: retry all non-permanent errors
}

// HTTPIsRetryable returns a function that determines if an HTTP status code
// should trigger a retry.
func HTTPIsRetryable(resp *http.Response) bool {
    if resp == nil {
        return true
    }
    switch resp.StatusCode {
    case http.StatusTooManyRequests,      // 429: rate limited
        http.StatusServiceUnavailable,    // 503: service down
        http.StatusGatewayTimeout,        // 504: upstream timeout
        http.StatusBadGateway,            // 502: bad gateway
        http.StatusInternalServerError:   // 500: transient server error
        return true
    }
    return false
}
```

---

## Section 3: Core Retry Function

### 3.1 Options Pattern

```go
// pkg/retry/retry.go
package retry

import (
    "context"
    "errors"
    "time"
)

// Config holds the configuration for a retry operation.
type Config struct {
    // MaxAttempts is the maximum number of total attempts (including the first).
    // 0 means unlimited.
    MaxAttempts int

    // Backoff computes the wait duration before each retry attempt.
    Backoff BackoffFunc

    // IsRetryable determines if an error should trigger a retry.
    // If nil, DefaultIsRetryable is used.
    IsRetryable func(error) bool

    // OnRetry is called before each retry attempt with the attempt number and error.
    OnRetry func(attempt int, err error)

    // MaxDelay caps the total elapsed time for all attempts.
    // If 0, no additional cap beyond the context deadline is applied.
    MaxDelay time.Duration
}

// DefaultConfig provides sensible defaults for most use cases.
var DefaultConfig = Config{
    MaxAttempts: 5,
    Backoff:     ExponentialWithJitter(100*time.Millisecond, 30*time.Second),
    IsRetryable: DefaultIsRetryable,
}

// Option is a functional option for configuring retry behavior.
type Option func(*Config)

// WithMaxAttempts sets the maximum number of attempts.
func WithMaxAttempts(n int) Option {
    return func(c *Config) { c.MaxAttempts = n }
}

// WithBackoff sets the backoff strategy.
func WithBackoff(b BackoffFunc) Option {
    return func(c *Config) { c.Backoff = b }
}

// WithIsRetryable sets the error classification function.
func WithIsRetryable(f func(error) bool) Option {
    return func(c *Config) { c.IsRetryable = f }
}

// WithOnRetry sets a callback invoked before each retry.
func WithOnRetry(f func(attempt int, err error)) Option {
    return func(c *Config) { c.OnRetry = f }
}

// WithMaxDelay sets a hard cap on total retry time.
func WithMaxDelay(d time.Duration) Option {
    return func(c *Config) { c.MaxDelay = d }
}
```

### 3.2 Do — The Core Retry Function

```go
// Do executes fn with retry logic based on the provided options.
// The context deadline is always respected — retries stop if the context expires.
func Do(ctx context.Context, fn func(ctx context.Context) error, opts ...Option) error {
    cfg := DefaultConfig
    for _, o := range opts {
        o(&cfg)
    }

    if cfg.IsRetryable == nil {
        cfg.IsRetryable = DefaultIsRetryable
    }

    if cfg.Backoff == nil {
        cfg.Backoff = ExponentialWithJitter(100*time.Millisecond, 30*time.Second)
    }

    // If MaxDelay is set, create a deadline-bounded context
    if cfg.MaxDelay > 0 {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, cfg.MaxDelay)
        defer cancel()
    }

    var lastErr error
    for attempt := 1; ; attempt++ {
        // Check context before each attempt
        if err := ctx.Err(); err != nil {
            if lastErr != nil {
                return &AttemptError{
                    Attempts: attempt - 1,
                    Err:      lastErr,
                    CtxErr:   err,
                }
            }
            return err
        }

        // Execute the function
        lastErr = fn(ctx)

        // Success
        if lastErr == nil {
            return nil
        }

        // Permanent error — don't retry
        if !cfg.IsRetryable(lastErr) {
            return lastErr
        }

        // Max attempts reached
        if cfg.MaxAttempts > 0 && attempt >= cfg.MaxAttempts {
            return &AttemptError{
                Attempts: attempt,
                Err:      lastErr,
            }
        }

        // Compute wait duration
        wait := cfg.Backoff(attempt)

        // Honor Retry-After if specified in the error
        if after, ok := GetRetryAfter(lastErr); ok && after > wait {
            wait = after
        }

        // Notify caller about the retry
        if cfg.OnRetry != nil {
            cfg.OnRetry(attempt, lastErr)
        }

        // Wait with context cancellation support
        timer := time.NewTimer(wait)
        select {
        case <-ctx.Done():
            timer.Stop()
            return &AttemptError{
                Attempts: attempt,
                Err:      lastErr,
                CtxErr:   ctx.Err(),
            }
        case <-timer.C:
        }
    }
}

// AttemptError provides information about a failed retry sequence.
type AttemptError struct {
    Attempts int
    Err      error   // The last operation error
    CtxErr   error   // The context error (if context expired)
}

func (e *AttemptError) Error() string {
    if e.CtxErr != nil {
        return fmt.Sprintf("retry: context cancelled after %d attempts: %v (last error: %v)",
            e.Attempts, e.CtxErr, e.Err)
    }
    return fmt.Sprintf("retry: failed after %d attempts: %v", e.Attempts, e.Err)
}

func (e *AttemptError) Unwrap() error { return e.Err }
func (e *AttemptError) Is(target error) bool {
    _, ok := target.(*AttemptError)
    return ok
}
```

---

## Section 4: Specialized Retry Patterns

### 4.1 HTTP Client with Retry

```go
// pkg/retry/http.go
package retry

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "strconv"
    "time"
)

// HTTPDoer is an interface that http.Client implements.
type HTTPDoer interface {
    Do(req *http.Request) (*http.Response, error)
}

// RetryableHTTPClient wraps an http.Client with retry logic.
type RetryableHTTPClient struct {
    Client HTTPDoer
    opts   []Option
}

// NewRetryableHTTPClient creates an HTTP client that retries on transient errors.
func NewRetryableHTTPClient(client HTTPDoer, opts ...Option) *RetryableHTTPClient {
    if client == nil {
        client = &http.Client{Timeout: 30 * time.Second}
    }
    return &RetryableHTTPClient{Client: client, opts: opts}
}

// Do executes an HTTP request with retry logic.
// The request body must be re-readable if retries are needed.
func (c *RetryableHTTPClient) Do(req *http.Request) (*http.Response, error) {
    var resp *http.Response

    // Buffer the request body so it can be replayed
    var bodyBytes []byte
    if req.Body != nil && req.Body != http.NoBody {
        var err error
        bodyBytes, err = io.ReadAll(req.Body)
        if err != nil {
            return nil, fmt.Errorf("reading request body: %w", err)
        }
        req.Body.Close()
    }

    opts := append(c.opts,
        WithIsRetryable(func(err error) bool {
            if resp != nil {
                return HTTPIsRetryable(resp)
            }
            return DefaultIsRetryable(err)
        }),
        WithOnRetry(func(attempt int, err error) {
            // Restore body for retry
            if bodyBytes != nil {
                req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
            }
            // Close previous response body to avoid leaks
            if resp != nil {
                resp.Body.Close()
                resp = nil
            }
        }),
    )

    err := Do(req.Context(), func(ctx context.Context) error {
        // Restore body before each attempt
        if bodyBytes != nil {
            req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
        }

        req = req.WithContext(ctx)
        var doErr error
        resp, doErr = c.Client.Do(req)
        if doErr != nil {
            return doErr
        }

        // Check for retryable HTTP status codes
        if HTTPIsRetryable(resp) {
            // Extract Retry-After header if present
            retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
            resp.Body.Close()
            resp = nil
            if retryAfter > 0 {
                return WithRetryAfter(
                    fmt.Errorf("HTTP %d: service unavailable", resp.StatusCode),
                    retryAfter,
                )
            }
            return fmt.Errorf("HTTP %d: retryable error", resp.StatusCode)
        }

        return nil
    }, opts...)

    return resp, err
}

// parseRetryAfter parses the Retry-After header value.
// Returns 0 if the header is absent or invalid.
func parseRetryAfter(header string) time.Duration {
    if header == "" {
        return 0
    }
    // Try seconds format first
    if seconds, err := strconv.Atoi(header); err == nil {
        return time.Duration(seconds) * time.Second
    }
    // Try HTTP-date format
    if t, err := http.ParseTime(header); err == nil {
        until := time.Until(t)
        if until > 0 {
            return until
        }
    }
    return 0
}
```

### 4.2 Database Query Retry

```go
// pkg/retry/db.go
package retry

import (
    "context"
    "database/sql"
    "errors"
    "time"

    "github.com/lib/pq"
)

// PostgresIsRetryable returns true for PostgreSQL errors that should be retried.
func PostgresIsRetryable(err error) bool {
    if err == nil {
        return false
    }

    // Connection errors
    if errors.Is(err, sql.ErrConnDone) {
        return true
    }

    // PostgreSQL-specific error codes
    var pqErr *pq.Error
    if errors.As(err, &pqErr) {
        switch pqErr.Code {
        case "40001": // serialization failure (concurrent transaction conflict)
            return true
        case "40P01": // deadlock detected
            return true
        case "08000", "08003", "08006", "08001": // connection errors
            return true
        case "57P01": // admin shutdown
            return true
        case "57P02": // crash shutdown
            return true
        case "57P03": // cannot connect now
            return true
        }
        return false
    }

    return DefaultIsRetryable(err)
}

// WithTx executes fn within a database transaction with retry on serialization failure.
// The transaction is automatically rolled back and retried on serializable conflicts.
func WithTx(ctx context.Context, db *sql.DB, opts *sql.TxOptions, fn func(*sql.Tx) error) error {
    return Do(ctx, func(ctx context.Context) error {
        tx, err := db.BeginTx(ctx, opts)
        if err != nil {
            return err
        }

        if err := fn(tx); err != nil {
            tx.Rollback()
            return err
        }

        return tx.Commit()
    },
        WithMaxAttempts(5),
        WithBackoff(ExponentialWithJitter(50*time.Millisecond, 5*time.Second)),
        WithIsRetryable(PostgresIsRetryable),
    )
}
```

### 4.3 gRPC Retry with Status Codes

```go
// pkg/retry/grpc.go
package retry

import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// GRPCIsRetryable returns true for gRPC status codes that indicate transient failures.
func GRPCIsRetryable(err error) bool {
    if err == nil {
        return false
    }

    if IsPermanent(err) {
        return false
    }

    s, ok := status.FromError(err)
    if !ok {
        return DefaultIsRetryable(err)
    }

    switch s.Code() {
    case codes.Unavailable:      // Service temporarily unavailable
        return true
    case codes.DeadlineExceeded: // Request timed out
        return true
    case codes.ResourceExhausted: // Rate limited
        return true
    case codes.Aborted:          // Conflict (retry for idempotent ops)
        return true
    case codes.Internal:         // May be transient
        return true
    case codes.Unknown:          // Unknown errors may be transient
        return true
    // These are never retryable:
    case codes.InvalidArgument,
        codes.NotFound,
        codes.AlreadyExists,
        codes.PermissionDenied,
        codes.Unauthenticated,
        codes.Unimplemented:
        return false
    }
    return false
}
```

---

## Section 5: Circuit Breaker Integration

### 5.1 Circuit Breaker Implementation

```go
// pkg/retry/circuit.go
package retry

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"
)

// State represents the circuit breaker state.
type State int32

const (
    StateClosed   State = iota // Normal operation
    StateOpen                  // Failing — reject requests
    StateHalfOpen              // Testing — allow one request
)

// ErrCircuitOpen is returned when the circuit breaker is open.
var ErrCircuitOpen = errors.New("circuit breaker: circuit is open")

// CircuitBreaker implements the circuit breaker pattern.
type CircuitBreaker struct {
    state       int32  // atomic State
    failures    int64  // atomic failure counter
    lastFailure int64  // atomic unix nanoseconds

    threshold    int           // failures before opening
    resetTimeout time.Duration // time before half-open test
    successCount int64         // atomic successes in half-open
    successThreshold int       // successes to close from half-open

    mu     sync.Mutex
    onOpen func(err error)
}

// NewCircuitBreaker creates a new circuit breaker.
func NewCircuitBreaker(threshold int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        threshold:        threshold,
        resetTimeout:     resetTimeout,
        successThreshold: 2,
    }
}

// Execute runs fn with circuit breaker protection.
func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    if err := cb.allow(); err != nil {
        return err
    }

    err := fn(ctx)

    if err != nil {
        cb.recordFailure()
    } else {
        cb.recordSuccess()
    }

    return err
}

func (cb *CircuitBreaker) allow() error {
    state := State(atomic.LoadInt32(&cb.state))

    switch state {
    case StateClosed:
        return nil

    case StateOpen:
        // Check if reset timeout has elapsed
        lastFail := time.Unix(0, atomic.LoadInt64(&cb.lastFailure))
        if time.Since(lastFail) > cb.resetTimeout {
            // Transition to half-open
            atomic.StoreInt32(&cb.state, int32(StateHalfOpen))
            atomic.StoreInt64(&cb.successCount, 0)
            return nil
        }
        return ErrCircuitOpen

    case StateHalfOpen:
        return nil
    }

    return nil
}

func (cb *CircuitBreaker) recordFailure() {
    atomic.StoreInt64(&cb.lastFailure, time.Now().UnixNano())
    failures := atomic.AddInt64(&cb.failures, 1)

    state := State(atomic.LoadInt32(&cb.state))

    if state == StateHalfOpen {
        // Failure in half-open — go back to open
        atomic.StoreInt32(&cb.state, int32(StateOpen))
        atomic.StoreInt64(&cb.failures, 0)
        return
    }

    if state == StateClosed && int(failures) >= cb.threshold {
        atomic.StoreInt32(&cb.state, int32(StateOpen))
        if cb.onOpen != nil {
            cb.onOpen(errors.New("circuit breaker: opened due to failure threshold"))
        }
    }
}

func (cb *CircuitBreaker) recordSuccess() {
    state := State(atomic.LoadInt32(&cb.state))

    if state == StateHalfOpen {
        successes := atomic.AddInt64(&cb.successCount, 1)
        if int(successes) >= cb.successThreshold {
            // Enough successes — close the circuit
            atomic.StoreInt32(&cb.state, int32(StateClosed))
            atomic.StoreInt64(&cb.failures, 0)
        }
        return
    }

    // Reset failure count on success in closed state
    atomic.StoreInt64(&cb.failures, 0)
}

// State returns the current circuit breaker state.
func (cb *CircuitBreaker) State() State {
    return State(atomic.LoadInt32(&cb.state))
}

// WithCircuitBreaker wraps a retry operation with circuit breaker protection.
func WithCircuitBreaker(cb *CircuitBreaker, fn func(ctx context.Context) error) func(ctx context.Context) error {
    return func(ctx context.Context) error {
        return cb.Execute(ctx, fn)
    }
}
```

### 5.2 Combined Retry + Circuit Breaker

```go
// Combining retry and circuit breaker
func callExternalService(ctx context.Context, client *http.Client, url string) error {
    cb := NewCircuitBreaker(5, 30*time.Second)

    return Do(ctx,
        WithCircuitBreaker(cb, func(ctx context.Context) error {
            req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
            resp, err := client.Do(req)
            if err != nil {
                return err
            }
            defer resp.Body.Close()

            if resp.StatusCode >= 500 {
                return fmt.Errorf("server error: %d", resp.StatusCode)
            }
            return nil
        }),
        WithMaxAttempts(3),
        WithBackoff(ExponentialWithJitter(100*time.Millisecond, 10*time.Second)),
        WithIsRetryable(func(err error) bool {
            // Don't retry if circuit is open
            if errors.Is(err, ErrCircuitOpen) {
                return false
            }
            return DefaultIsRetryable(err)
        }),
        WithOnRetry(func(attempt int, err error) {
            log.Printf("retry attempt %d after error: %v", attempt, err)
        }),
    )
}
```

---

## Section 6: Metrics and Observability

### 6.1 Prometheus Metrics Integration

```go
// pkg/retry/metrics.go
package retry

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    retryAttempts = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "retry_attempts_total",
        Help: "Total number of retry attempts by operation and outcome",
    }, []string{"operation", "outcome"})

    retryDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "retry_duration_seconds",
        Help:    "Total time spent in retry attempts",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
    }, []string{"operation"})

    circuitState = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "circuit_breaker_state",
        Help: "Current circuit breaker state (0=closed, 1=open, 2=half-open)",
    }, []string{"circuit"})
)

// InstrumentedDo wraps Do with Prometheus metrics.
func InstrumentedDo(ctx context.Context, operation string, fn func(ctx context.Context) error, opts ...Option) error {
    start := time.Now()
    attempts := 0

    opts = append(opts, WithOnRetry(func(attempt int, err error) {
        attempts = attempt
        retryAttempts.WithLabelValues(operation, "retry").Inc()
    }))

    err := Do(ctx, fn, opts...)

    duration := time.Since(start)
    retryDuration.WithLabelValues(operation).Observe(duration.Seconds())

    if err != nil {
        retryAttempts.WithLabelValues(operation, "failed").Inc()
    } else {
        retryAttempts.WithLabelValues(operation, "success").Inc()
    }

    return err
}
```

---

## Section 7: Testing Retry Logic

### 7.1 Deterministic Testing with Fake Clock

```go
// pkg/retry/retry_test.go
package retry_test

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/yourorg/service/pkg/retry"
)

// mockBackoff records calls and returns preset durations.
type mockBackoff struct {
    durations []time.Duration
    calls     []int
}

func (m *mockBackoff) Backoff(attempt int) time.Duration {
    m.calls = append(m.calls, attempt)
    if attempt-1 < len(m.durations) {
        return m.durations[attempt-1]
    }
    return 0
}

func TestDoSucceedsOnThirdAttempt(t *testing.T) {
    attempts := 0
    err := retry.Do(context.Background(),
        func(_ context.Context) error {
            attempts++
            if attempts < 3 {
                return errors.New("transient error")
            }
            return nil
        },
        retry.WithMaxAttempts(5),
        retry.WithBackoff(retry.Constant(0)), // No delay in tests
    )

    if err != nil {
        t.Fatalf("expected success, got: %v", err)
    }
    if attempts != 3 {
        t.Errorf("expected 3 attempts, got %d", attempts)
    }
}

func TestDoRespectsMaxAttempts(t *testing.T) {
    attempts := 0
    err := retry.Do(context.Background(),
        func(_ context.Context) error {
            attempts++
            return errors.New("always fails")
        },
        retry.WithMaxAttempts(3),
        retry.WithBackoff(retry.Constant(0)),
    )

    if err == nil {
        t.Fatal("expected error, got nil")
    }
    if attempts != 3 {
        t.Errorf("expected exactly 3 attempts, got %d", attempts)
    }

    var ae *retry.AttemptError
    if !errors.As(err, &ae) {
        t.Errorf("expected AttemptError, got %T", err)
    }
    if ae.Attempts != 3 {
        t.Errorf("AttemptError.Attempts = %d, want 3", ae.Attempts)
    }
}

func TestDoPermanentErrorNotRetried(t *testing.T) {
    attempts := 0
    err := retry.Do(context.Background(),
        func(_ context.Context) error {
            attempts++
            return retry.Permanent(errors.New("invalid input"))
        },
        retry.WithMaxAttempts(5),
        retry.WithBackoff(retry.Constant(0)),
    )

    if err == nil {
        t.Fatal("expected error, got nil")
    }
    if attempts != 1 {
        t.Errorf("permanent error should not be retried, got %d attempts", attempts)
    }
}

func TestDoContextCancellation(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
    defer cancel()

    attempts := 0
    err := retry.Do(ctx,
        func(_ context.Context) error {
            attempts++
            return errors.New("always fails")
        },
        retry.WithMaxAttempts(0),  // Unlimited attempts
        retry.WithBackoff(retry.Constant(20*time.Millisecond)),
    )

    if err == nil {
        t.Fatal("expected context cancellation error")
    }
    if attempts == 0 {
        t.Error("expected at least one attempt")
    }
    // Should have stopped due to context, not max attempts
    var ae *retry.AttemptError
    if errors.As(err, &ae) && ae.CtxErr == nil {
        t.Error("expected context error to be set in AttemptError")
    }
}

func TestExponentialBackoffDistribution(t *testing.T) {
    // Verify that jittered backoff produces values within expected range
    backoff := retry.ExponentialWithJitter(100*time.Millisecond, 30*time.Second)

    for attempt := 1; attempt <= 10; attempt++ {
        max := 100 * time.Millisecond * time.Duration(1<<(attempt-1))
        if max > 30*time.Second {
            max = 30 * time.Second
        }

        for i := 0; i < 100; i++ {
            d := backoff(attempt)
            if d < 0 || d > max {
                t.Errorf("attempt %d: backoff %v out of range [0, %v]", attempt, d, max)
            }
        }
    }
}

func TestCircuitBreaker(t *testing.T) {
    cb := retry.NewCircuitBreaker(3, 100*time.Millisecond)

    // Trigger threshold failures
    for i := 0; i < 3; i++ {
        cb.Execute(context.Background(), func(_ context.Context) error {
            return errors.New("failure")
        })
    }

    // Circuit should now be open
    err := cb.Execute(context.Background(), func(_ context.Context) error {
        return nil
    })
    if !errors.Is(err, retry.ErrCircuitOpen) {
        t.Errorf("expected circuit open error, got: %v", err)
    }

    // Wait for reset timeout
    time.Sleep(150 * time.Millisecond)

    // Circuit should allow one test request (half-open)
    err = cb.Execute(context.Background(), func(_ context.Context) error {
        return nil // success
    })
    if err != nil {
        t.Errorf("expected success in half-open state, got: %v", err)
    }
}
```

---

## Section 8: Real-World Usage Patterns

### 8.1 Kubernetes Controller Pattern

```go
// Retry in a Kubernetes controller reconcile loop
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    err := retry.Do(ctx,
        func(ctx context.Context) error {
            return r.doReconcile(ctx, req)
        },
        retry.WithMaxAttempts(3),
        retry.WithBackoff(retry.ExponentialWithJitter(
            500*time.Millisecond,
            10*time.Second,
        )),
        retry.WithIsRetryable(func(err error) bool {
            // Retry on conflict (optimistic locking) and unavailable
            if apierrors.IsConflict(err) || apierrors.IsServiceUnavailable(err) {
                return true
            }
            return false
        }),
    )

    if err != nil {
        return ctrl.Result{}, err
    }
    return ctrl.Result{}, nil
}
```

### 8.2 API Gateway Forwarding

```go
// Retry with deadline budget in API gateway
func (gw *Gateway) Forward(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Reserve 10% of the deadline budget for our own overhead
    if deadline, ok := ctx.Deadline(); ok {
        budget := time.Until(deadline)
        reserved := budget / 10
        var cancel context.CancelFunc
        ctx, cancel = context.WithDeadline(ctx, deadline.Add(-reserved))
        defer cancel()
    }

    client := retry.NewRetryableHTTPClient(
        &http.Client{Timeout: 5 * time.Second},
        retry.WithMaxAttempts(3),
        retry.WithBackoff(retry.ExponentialWithJitter(
            100*time.Millisecond,
            2*time.Second,
        )),
    )

    return client.Do(req.WithContext(ctx))
}
```

---

## Summary

Production-grade retry logic in Go requires careful attention to several concerns:

1. **Full jitter** (`ExponentialWithJitter`) is the right default — it maximally spreads retries and avoids thundering herd problems
2. **Context propagation** — always accept a context and respect its deadline without exception
3. **Error classification** — distinguish permanent from transient failures; never retry on auth failures, validation errors, or permanent resource states
4. **Retry-After headers** — respect rate limiting hints from upstream services
5. **Circuit breakers** — combine with retry to avoid wasting resources on clearly-down dependencies
6. **Observe your retries** — export retry attempt counts and success rates; spikes indicate upstream instability
7. **Test deterministically** — use `Constant(0)` backoff in unit tests; use fake clocks for timing tests

The composable option-based API makes it easy to apply the right retry policy for each operation type: aggressive retries for database conflicts, conservative retries for external APIs, and no retries for user-input validation.
