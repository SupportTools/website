---
title: "Go Circuit Breaker and Retry Patterns: Resilience for Distributed Systems"
date: 2030-07-20T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Circuit Breaker", "Retry", "Resilience", "Distributed Systems", "gRPC"]
categories:
- Go
- Architecture
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise resilience patterns in Go covering gobreaker circuit breaker, exponential backoff with jitter, retry budgets, bulkhead pattern, timeout propagation with context, and integrating resilience patterns with service meshes."
more_link: "yes"
url: "/go-circuit-breaker-retry-patterns-distributed-systems-resilience/"
---

Distributed systems fail in partial and unpredictable ways. A downstream service that experiences elevated latency or error rates can cascade failures to every upstream caller without proper resilience controls. The circuit breaker pattern prevents repeated calls to a failing service, exponential backoff with jitter prevents thundering herds during recovery, and bulkheads limit the blast radius of a single dependency failure. These patterns work together to build services that degrade gracefully and recover automatically from transient failures.

<!--more-->

## Circuit Breaker Pattern

The circuit breaker has three states:

- **Closed**: Requests pass through normally; failures are tracked
- **Open**: Requests are immediately rejected without calling the downstream service
- **Half-Open**: A probe request is allowed through to test if the service has recovered

### gobreaker Circuit Breaker

```go
package resilience

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/sony/gobreaker/v2"
)

// CircuitBreakerConfig holds configuration for a circuit breaker
type CircuitBreakerConfig struct {
    Name            string
    MaxRequests     uint32        // Half-open probe requests allowed
    Interval        time.Duration // Counts are reset after this interval in closed state
    Timeout         time.Duration // How long to stay open before transitioning to half-open
    ReadyToTrip     func(counts gobreaker.Counts) bool
    OnStateChange   func(name string, from gobreaker.State, to gobreaker.State)
    IsSuccessful    func(err error) bool
}

// DefaultReadyToTrip opens the circuit after 5 consecutive failures
// or when the failure rate exceeds 60% with at least 10 requests
func DefaultReadyToTrip(counts gobreaker.Counts) bool {
    failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
    return counts.ConsecutiveFailures > 5 ||
        (counts.Requests >= 10 && failureRatio >= 0.6)
}

// NewCircuitBreaker creates a circuit breaker with the given configuration
func NewCircuitBreaker[T any](cfg CircuitBreakerConfig) *gobreaker.CircuitBreaker[T] {
    settings := gobreaker.Settings{
        Name:        cfg.Name,
        MaxRequests: cfg.MaxRequests,
        Interval:    cfg.Interval,
        Timeout:     cfg.Timeout,
        ReadyToTrip: cfg.ReadyToTrip,
        OnStateChange: func(name string, from, to gobreaker.State) {
            if cfg.OnStateChange != nil {
                cfg.OnStateChange(name, from, to)
            }
        },
        IsSuccessful: cfg.IsSuccessful,
    }
    if settings.MaxRequests == 0 {
        settings.MaxRequests = 1
    }
    if settings.Timeout == 0 {
        settings.Timeout = 60 * time.Second
    }
    if settings.Interval == 0 {
        settings.Interval = 30 * time.Second
    }
    if settings.ReadyToTrip == nil {
        settings.ReadyToTrip = DefaultReadyToTrip
    }
    return gobreaker.NewCircuitBreaker[T](settings)
}

// ErrCircuitOpen is returned when the circuit is open
var ErrCircuitOpen = errors.New("circuit breaker is open")

// CallWithBreaker wraps a function call with circuit breaker protection
func CallWithBreaker[T any](
    ctx context.Context,
    cb *gobreaker.CircuitBreaker[T],
    fn func(ctx context.Context) (T, error),
) (T, error) {
    result, err := cb.Execute(func() (T, error) {
        return fn(ctx)
    })

    if err != nil {
        var zero T
        if errors.Is(err, gobreaker.ErrOpenState) {
            return zero, fmt.Errorf("%w: %s", ErrCircuitOpen, cb.Name())
        }
        if errors.Is(err, gobreaker.ErrTooManyRequests) {
            return zero, fmt.Errorf("circuit half-open probe rejected: %s", cb.Name())
        }
        return zero, err
    }
    return result, nil
}
```

### Circuit Breaker with Prometheus Metrics

```go
package resilience

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/sony/gobreaker/v2"
)

var (
    circuitBreakerState = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "circuit_breaker_state",
        Help: "Current state of the circuit breaker (0=closed, 1=open, 2=half-open)",
    }, []string{"name"})

    circuitBreakerRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "circuit_breaker_requests_total",
        Help: "Total requests through the circuit breaker",
    }, []string{"name", "result"})

    circuitBreakerTransitions = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "circuit_breaker_state_transitions_total",
        Help: "Total state transitions of circuit breakers",
    }, []string{"name", "from", "to"})
)

// InstrumentedCircuitBreaker wraps gobreaker with Prometheus metrics
type InstrumentedCircuitBreaker[T any] struct {
    cb   *gobreaker.CircuitBreaker[T]
    name string
}

func NewInstrumentedCircuitBreaker[T any](cfg CircuitBreakerConfig) *InstrumentedCircuitBreaker[T] {
    // Initialize state metric
    circuitBreakerState.WithLabelValues(cfg.Name).Set(0)

    origOnStateChange := cfg.OnStateChange
    cfg.OnStateChange = func(name string, from, to gobreaker.State) {
        stateValue := float64(to)
        circuitBreakerState.WithLabelValues(name).Set(stateValue)
        circuitBreakerTransitions.WithLabelValues(name,
            from.String(), to.String()).Inc()
        if origOnStateChange != nil {
            origOnStateChange(name, from, to)
        }
    }

    return &InstrumentedCircuitBreaker[T]{
        cb:   NewCircuitBreaker[T](cfg),
        name: cfg.Name,
    }
}

func (icb *InstrumentedCircuitBreaker[T]) Execute(
    ctx context.Context,
    fn func(ctx context.Context) (T, error),
) (T, error) {
    result, err := icb.cb.Execute(func() (T, error) {
        return fn(ctx)
    })

    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            circuitBreakerRequests.WithLabelValues(icb.name, "rejected_open").Inc()
        } else {
            circuitBreakerRequests.WithLabelValues(icb.name, "failure").Inc()
        }
    } else {
        circuitBreakerRequests.WithLabelValues(icb.name, "success").Inc()
    }

    return result, err
}
```

## Exponential Backoff with Jitter

Exponential backoff prevents thundering herds by spacing out retries over increasing intervals. Adding random jitter prevents synchronized retries from multiple clients.

### Backoff Implementation

```go
package resilience

import (
    "context"
    "math"
    "math/rand"
    "time"
)

// BackoffConfig configures the backoff behavior
type BackoffConfig struct {
    InitialInterval time.Duration
    MaxInterval     time.Duration
    Multiplier      float64
    MaxElapsedTime  time.Duration
    // Jitter fraction: 0 = no jitter, 1 = full jitter
    Jitter float64
}

// DefaultBackoffConfig returns a production-ready backoff configuration
var DefaultBackoffConfig = BackoffConfig{
    InitialInterval: 500 * time.Millisecond,
    MaxInterval:     30 * time.Second,
    Multiplier:      2.0,
    MaxElapsedTime:  2 * time.Minute,
    Jitter:          0.3,
}

// Backoff calculates the next backoff duration for a given attempt
// attempt starts at 0
func (c BackoffConfig) Backoff(attempt int) time.Duration {
    if c.Multiplier <= 0 {
        c.Multiplier = 2.0
    }

    // Calculate base interval using exponential growth
    interval := float64(c.InitialInterval) * math.Pow(c.Multiplier, float64(attempt))

    // Apply full jitter: random value between [0, interval * jitter]
    if c.Jitter > 0 {
        jitterRange := interval * c.Jitter
        jitter := rand.Float64() * jitterRange
        // Equal jitter: keep half the interval, jitter the other half
        interval = interval*(1-c.Jitter/2) + jitter
    }

    // Cap at maximum interval
    if c.MaxInterval > 0 && time.Duration(interval) > c.MaxInterval {
        interval = float64(c.MaxInterval)
        // Still apply jitter to max interval to prevent synchronization
        if c.Jitter > 0 {
            interval += rand.Float64() * float64(c.MaxInterval) * c.Jitter
        }
    }

    return time.Duration(interval)
}

// BackoffSequence generates successive backoff durations
func (c BackoffConfig) BackoffSequence() []time.Duration {
    var durations []time.Duration
    var elapsed time.Duration
    for i := 0; ; i++ {
        d := c.Backoff(i)
        elapsed += d
        if c.MaxElapsedTime > 0 && elapsed > c.MaxElapsedTime {
            break
        }
        durations = append(durations, d)
        if i > 100 { // safety limit
            break
        }
    }
    return durations
}
```

### Retry with Backoff

```go
package resilience

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "time"
)

// RetryableError marks an error as retryable
type RetryableError struct {
    Err error
}

func (e *RetryableError) Error() string { return e.Err.Error() }
func (e *RetryableError) Unwrap() error { return e.Err }

// IsRetryable returns true if the error should trigger a retry
func IsRetryable(err error) bool {
    if err == nil {
        return false
    }
    var retryable *RetryableError
    if errors.As(err, &retryable) {
        return true
    }
    // Context errors are not retryable
    if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
        return false
    }
    // Circuit breaker errors are not retryable
    if errors.Is(err, ErrCircuitOpen) {
        return false
    }
    return false
}

// RetryConfig holds retry behavior configuration
type RetryConfig struct {
    MaxAttempts    int
    Backoff        BackoffConfig
    IsRetryable    func(err error) bool
    OnRetry        func(attempt int, err error, nextDelay time.Duration)
    Logger         *slog.Logger
}

// DefaultRetryConfig returns a sensible default retry configuration
var DefaultRetryConfig = RetryConfig{
    MaxAttempts: 3,
    Backoff:     DefaultBackoffConfig,
    IsRetryable: IsRetryable,
}

// Do executes fn with retry and backoff
func (rc *RetryConfig) Do(ctx context.Context, fn func(ctx context.Context) error) error {
    isRetryable := rc.IsRetryable
    if isRetryable == nil {
        isRetryable = IsRetryable
    }

    var lastErr error
    for attempt := 0; attempt < rc.MaxAttempts; attempt++ {
        // Check context before each attempt
        if ctx.Err() != nil {
            return fmt.Errorf("context cancelled before attempt %d: %w", attempt+1, ctx.Err())
        }

        err := fn(ctx)
        if err == nil {
            return nil
        }

        lastErr = err

        // Check if this is the last attempt
        if attempt >= rc.MaxAttempts-1 {
            break
        }

        // Check if error is retryable
        if !isRetryable(err) {
            return fmt.Errorf("non-retryable error on attempt %d: %w", attempt+1, err)
        }

        delay := rc.Backoff.Backoff(attempt)

        if rc.OnRetry != nil {
            rc.OnRetry(attempt+1, err, delay)
        }
        if rc.Logger != nil {
            rc.Logger.Warn("retrying after error",
                "attempt", attempt+1,
                "max_attempts", rc.MaxAttempts,
                "delay", delay,
                "error", err,
            )
        }

        // Wait for backoff duration or context cancellation
        select {
        case <-ctx.Done():
            return fmt.Errorf("context cancelled during backoff: %w", ctx.Err())
        case <-time.After(delay):
        }
    }

    return fmt.Errorf("all %d attempts failed, last error: %w", rc.MaxAttempts, lastErr)
}

// DoWithResult executes fn with retry and backoff, returning a result
func DoWithResult[T any](
    ctx context.Context,
    rc RetryConfig,
    fn func(ctx context.Context) (T, error),
) (T, error) {
    var result T
    err := rc.Do(ctx, func(ctx context.Context) error {
        var err error
        result, err = fn(ctx)
        return err
    })
    return result, err
}
```

### Retry Budget

Retry budgets limit the total percentage of retried requests to prevent retry storms:

```go
package resilience

import (
    "sync/atomic"
    "time"
)

// RetryBudget tracks the ratio of retried requests to prevent retry amplification
type RetryBudget struct {
    totalRequests  atomic.Int64
    retriedRequests atomic.Int64
    maxRetryRatio  float64
    // Window for resetting counters
    window         time.Duration
    lastReset      atomic.Int64
}

// NewRetryBudget creates a retry budget allowing up to maxRetryRatio fraction of retries
// E.g., maxRetryRatio=0.2 means at most 20% of requests can be retries
func NewRetryBudget(maxRetryRatio float64, window time.Duration) *RetryBudget {
    rb := &RetryBudget{
        maxRetryRatio: maxRetryRatio,
        window:        window,
    }
    rb.lastReset.Store(time.Now().UnixNano())
    return rb
}

// CanRetry returns true if another retry is within budget
func (rb *RetryBudget) CanRetry() bool {
    rb.maybeReset()

    total := rb.totalRequests.Load()
    retried := rb.retriedRequests.Load()

    if total == 0 {
        return true
    }

    currentRatio := float64(retried) / float64(total)
    return currentRatio < rb.maxRetryRatio
}

// RecordRequest records a new original request
func (rb *RetryBudget) RecordRequest() {
    rb.totalRequests.Add(1)
}

// RecordRetry records a retry attempt
func (rb *RetryBudget) RecordRetry() {
    rb.retriedRequests.Add(1)
}

// CurrentRatio returns the current retry ratio
func (rb *RetryBudget) CurrentRatio() float64 {
    rb.maybeReset()
    total := rb.totalRequests.Load()
    if total == 0 {
        return 0
    }
    return float64(rb.retriedRequests.Load()) / float64(total)
}

func (rb *RetryBudget) maybeReset() {
    now := time.Now().UnixNano()
    lastReset := rb.lastReset.Load()
    if time.Duration(now-lastReset) > rb.window {
        if rb.lastReset.CompareAndSwap(lastReset, now) {
            rb.totalRequests.Store(0)
            rb.retriedRequests.Store(0)
        }
    }
}
```

## Bulkhead Pattern

The bulkhead pattern isolates failures by limiting concurrent calls to each dependency independently:

```go
package resilience

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Bulkhead limits concurrent calls to a resource
type Bulkhead struct {
    name       string
    semaphore  chan struct{}
    waitQueue  int
    mu         sync.Mutex
    waiting    int
    maxWait    time.Duration
}

// NewBulkhead creates a bulkhead with maxConcurrent slots and maxWait queue depth
func NewBulkhead(name string, maxConcurrent int, maxWait int, waitTimeout time.Duration) *Bulkhead {
    b := &Bulkhead{
        name:      name,
        semaphore: make(chan struct{}, maxConcurrent),
        waitQueue: maxWait,
        maxWait:   waitTimeout,
    }
    // Pre-fill the semaphore
    for i := 0; i < maxConcurrent; i++ {
        b.semaphore <- struct{}{}
    }
    return b
}

// Execute runs fn within the bulkhead constraints
func (b *Bulkhead) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    b.mu.Lock()
    if b.waiting >= b.waitQueue {
        b.mu.Unlock()
        return fmt.Errorf("bulkhead %s: queue full (%d waiting)", b.name, b.waitQueue)
    }
    b.waiting++
    b.mu.Unlock()

    defer func() {
        b.mu.Lock()
        b.waiting--
        b.mu.Unlock()
    }()

    waitCtx, cancel := context.WithTimeout(ctx, b.maxWait)
    defer cancel()

    select {
    case <-b.semaphore:
        // Acquired slot
    case <-waitCtx.Done():
        return fmt.Errorf("bulkhead %s: timeout waiting for slot: %w", b.name, waitCtx.Err())
    }

    defer func() {
        b.semaphore <- struct{}{}
    }()

    return fn(ctx)
}

// Available returns the number of available concurrent slots
func (b *Bulkhead) Available() int {
    return len(b.semaphore)
}
```

## Context-Based Timeout Propagation

```go
package resilience

import (
    "context"
    "fmt"
    "time"
)

// TimeoutConfig defines per-operation timeout budgets
type TimeoutConfig struct {
    Default   time.Duration
    Overrides map[string]time.Duration
}

// WithTimeout applies a timeout to the context, respecting existing deadlines
func WithTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
    if deadline, ok := ctx.Deadline(); ok {
        remaining := time.Until(deadline)
        if remaining < timeout {
            // Parent deadline is tighter, do not extend it
            return context.WithCancel(ctx)
        }
    }
    return context.WithTimeout(ctx, timeout)
}

// PropagateDeadline creates a child context that shares the parent deadline
// but adds metadata for tracing and logging
func PropagateDeadline(parent context.Context, operation string) (context.Context, context.CancelFunc, error) {
    deadline, ok := parent.Deadline()
    if !ok {
        return nil, nil, fmt.Errorf("parent context has no deadline for operation %s", operation)
    }

    remaining := time.Until(deadline)
    if remaining <= 0 {
        return nil, nil, fmt.Errorf("parent deadline already exceeded for operation %s", operation)
    }

    // Reserve 10% for overhead, minimum 50ms
    overhead := remaining / 10
    if overhead < 50*time.Millisecond {
        overhead = 50 * time.Millisecond
    }

    childTimeout := remaining - overhead
    if childTimeout <= 0 {
        return nil, nil, fmt.Errorf("insufficient time remaining for operation %s: %v", operation, remaining)
    }

    ctx, cancel := context.WithTimeout(parent, childTimeout)
    ctx = context.WithValue(ctx, "operation", operation)
    return ctx, cancel, nil
}
```

## Composing Resilience Patterns

### Complete Resilience Layer

```go
package resilience

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/sony/gobreaker/v2"
)

// ResilienceConfig composes all resilience patterns
type ResilienceConfig struct {
    Name             string
    Timeout          time.Duration
    CircuitBreaker   CircuitBreakerConfig
    Retry            RetryConfig
    Bulkhead         *BulkheadConfig
    RetryBudgetRatio float64
    Logger           *slog.Logger
}

type BulkheadConfig struct {
    MaxConcurrent int
    MaxWait       int
    WaitTimeout   time.Duration
}

// ResilienceLayer wraps service calls with circuit breaker, retry, bulkhead, and timeout
type ResilienceLayer struct {
    cfg        ResilienceConfig
    cb         *InstrumentedCircuitBreaker[interface{}]
    bulkhead   *Bulkhead
    retryBudget *RetryBudget
}

func NewResilienceLayer(cfg ResilienceConfig) *ResilienceLayer {
    rl := &ResilienceLayer{
        cfg: cfg,
        cb:  NewInstrumentedCircuitBreaker[interface{}](cfg.CircuitBreaker),
    }
    if cfg.Bulkhead != nil {
        rl.bulkhead = NewBulkhead(
            cfg.Name,
            cfg.Bulkhead.MaxConcurrent,
            cfg.Bulkhead.MaxWait,
            cfg.Bulkhead.WaitTimeout,
        )
    }
    if cfg.RetryBudgetRatio > 0 {
        rl.retryBudget = NewRetryBudget(cfg.RetryBudgetRatio, 30*time.Second)
    }
    return rl
}

// Execute runs fn through the full resilience stack
func (rl *ResilienceLayer) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    // Apply timeout
    if rl.cfg.Timeout > 0 {
        var cancel context.CancelFunc
        ctx, cancel = WithTimeout(ctx, rl.cfg.Timeout)
        defer cancel()
    }

    // Track for retry budget
    if rl.retryBudget != nil {
        rl.retryBudget.RecordRequest()
    }

    // Build retry-aware function
    callFn := func(ctx context.Context) error {
        // Apply bulkhead
        if rl.bulkhead != nil {
            return rl.bulkhead.Execute(ctx, func(ctx context.Context) error {
                // Apply circuit breaker
                _, cbErr := rl.cb.Execute(ctx, func(ctx context.Context) (interface{}, error) {
                    return nil, fn(ctx)
                })
                return cbErr
            })
        }
        // No bulkhead, just circuit breaker
        _, cbErr := rl.cb.Execute(ctx, func(ctx context.Context) (interface{}, error) {
            return nil, fn(ctx)
        })
        return cbErr
    }

    // Apply retry with budget check
    retryCfg := rl.cfg.Retry
    if rl.retryBudget != nil {
        originalIsRetryable := retryCfg.IsRetryable
        retryCfg.IsRetryable = func(err error) bool {
            if !originalIsRetryable(err) {
                return false
            }
            if !rl.retryBudget.CanRetry() {
                if rl.cfg.Logger != nil {
                    rl.cfg.Logger.Warn("retry budget exhausted",
                        "name", rl.cfg.Name,
                        "ratio", rl.retryBudget.CurrentRatio(),
                    )
                }
                return false
            }
            rl.retryBudget.RecordRetry()
            return true
        }
    }

    return retryCfg.Do(ctx, callFn)
}
```

### HTTP Client with Full Resilience

```go
package client

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/example/resilience"
)

// ResilientHTTPClient wraps http.Client with resilience patterns
type ResilientHTTPClient struct {
    httpClient *http.Client
    layer      *resilience.ResilienceLayer
    baseURL    string
}

func NewResilientHTTPClient(baseURL string) *ResilientHTTPClient {
    layer := resilience.NewResilienceLayer(resilience.ResilienceConfig{
        Name:    "http-client-" + baseURL,
        Timeout: 5 * time.Second,
        CircuitBreaker: resilience.CircuitBreakerConfig{
            Name:        "http-cb-" + baseURL,
            MaxRequests: 1,
            Interval:    30 * time.Second,
            Timeout:     60 * time.Second,
            ReadyToTrip: resilience.DefaultReadyToTrip,
            IsSuccessful: func(err error) bool {
                return err == nil
            },
        },
        Retry: resilience.RetryConfig{
            MaxAttempts: 3,
            Backoff:     resilience.DefaultBackoffConfig,
            IsRetryable: func(err error) bool {
                var httpErr *HTTPError
                if errors.As(err, &httpErr) {
                    // Retry on 429, 503, 504
                    switch httpErr.StatusCode {
                    case http.StatusTooManyRequests,
                        http.StatusServiceUnavailable,
                        http.StatusGatewayTimeout:
                        return true
                    }
                    return false
                }
                return resilience.IsRetryable(err)
            },
        },
        Bulkhead: &resilience.BulkheadConfig{
            MaxConcurrent: 50,
            MaxWait:       100,
            WaitTimeout:   2 * time.Second,
        },
        RetryBudgetRatio: 0.1, // at most 10% of requests can be retries
    })

    return &ResilientHTTPClient{
        httpClient: &http.Client{
            Timeout:   10 * time.Second,
            Transport: &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 10,
                IdleConnTimeout:     90 * time.Second,
            },
        },
        layer:   layer,
        baseURL: baseURL,
    }
}

// HTTPError represents an HTTP error response
type HTTPError struct {
    StatusCode int
    Body       string
}

func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Body)
}

func (c *ResilientHTTPClient) Get(ctx context.Context, path string, result interface{}) error {
    return c.layer.Execute(ctx, func(ctx context.Context) error {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
        if err != nil {
            return fmt.Errorf("creating request: %w", err)
        }
        req.Header.Set("Accept", "application/json")

        resp, err := c.httpClient.Do(req)
        if err != nil {
            return &resilience.RetryableError{Err: err}
        }
        defer resp.Body.Close()

        if resp.StatusCode >= 500 || resp.StatusCode == 429 {
            return &resilience.RetryableError{
                Err: &HTTPError{StatusCode: resp.StatusCode},
            }
        }
        if resp.StatusCode >= 400 {
            return &HTTPError{StatusCode: resp.StatusCode}
        }

        return json.NewDecoder(resp.Body).Decode(result)
    })
}
```

## gRPC Client Resilience

```go
package grpcclient

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/credentials/insecure"

    "github.com/example/resilience"
)

// isGRPCRetryable returns true for gRPC errors that should be retried
func isGRPCRetryable(err error) bool {
    if err == nil {
        return false
    }
    st, ok := status.FromError(err)
    if !ok {
        return resilience.IsRetryable(err)
    }
    switch st.Code() {
    case codes.Unavailable,
        codes.ResourceExhausted,
        codes.DeadlineExceeded,
        codes.Internal:
        return true
    }
    return false
}

// NewResilientGRPCConn creates a gRPC connection with resilience patterns
func NewResilientGRPCConn(target string) (*grpc.ClientConn, resilience.ResilienceLayer, error) {
    // gRPC built-in retry policy
    serviceConfig := `{
        "methodConfig": [{
            "name": [{"service": ""}],
            "waitForReady": true,
            "retryPolicy": {
                "MaxAttempts": 3,
                "InitialBackoff": "0.5s",
                "MaxBackoff": "30s",
                "BackoffMultiplier": 2.0,
                "RetryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
            },
            "timeout": "5s"
        }]
    }`

    conn, err := grpc.Dial(target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(serviceConfig),
        grpc.WithBlock(),
        grpc.WithTimeout(10*time.Second),
    )
    if err != nil {
        return nil, resilience.ResilienceLayer{}, err
    }

    layer := resilience.ResilienceLayer{}
    // Use gobreaker on top of gRPC's built-in retry for additional protection
    // ...

    return conn, layer, nil
}

// ClientWithResilience demonstrates combining gRPC client with circuit breaker
type ClientWithResilience struct {
    // grpc client would be here
    cb *resilience.InstrumentedCircuitBreaker[*SomeResponse]
}

type SomeResponse struct {
    Data string
}

func (c *ClientWithResilience) Call(ctx context.Context, req *SomeRequest) (*SomeResponse, error) {
    return c.cb.Execute(ctx, func(ctx context.Context) (*SomeResponse, error) {
        // Make gRPC call here
        return &SomeResponse{}, nil
    })
}

type SomeRequest struct{}
```

## Service Mesh Integration

When running with a service mesh like Istio or Linkerd, resilience patterns should be coordinated to avoid double-retrying:

```yaml
# Istio VirtualService with retry and timeout configuration
# Application-level circuit breakers should still be used for fast-fail behavior
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-service
  namespace: production
spec:
  hosts:
    - payment-service
  http:
    - route:
        - destination:
            host: payment-service
            port:
              number: 8080
      timeout: 10s
      retries:
        attempts: 2           # Keep low to avoid amplifying with app-level retries
        perTryTimeout: 4s
        retryOn: "5xx,reset,connect-failure,retriable-4xx"
---
# Istio DestinationRule for circuit breaking
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-service
  namespace: production
spec:
  host: payment-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: UPGRADE
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 30
```

When using a service mesh, set the application-level retry count to 1 (no retries) and rely on the mesh for retry logic. Keep the circuit breaker at the application level for fast-fail behavior that avoids even reaching the mesh proxy:

```go
// With service mesh: reduce application retries to avoid amplification
var servicesMeshAwareConfig = resilience.RetryConfig{
    MaxAttempts: 1, // Mesh handles retries
    IsRetryable: isGRPCRetryable,
}
```

## Testing Resilience Patterns

```go
package resilience_test

import (
    "context"
    "errors"
    "sync/atomic"
    "testing"
    "time"

    "github.com/example/resilience"
)

func TestRetryExhaustion(t *testing.T) {
    var attempts atomic.Int32
    cfg := resilience.RetryConfig{
        MaxAttempts: 3,
        Backoff: resilience.BackoffConfig{
            InitialInterval: 1 * time.Millisecond,
            MaxInterval:     10 * time.Millisecond,
            Multiplier:      2.0,
        },
        IsRetryable: func(err error) bool { return true },
    }

    err := cfg.Do(context.Background(), func(_ context.Context) error {
        attempts.Add(1)
        return &resilience.RetryableError{Err: errors.New("transient error")}
    })

    if err == nil {
        t.Fatal("expected error after exhausting retries")
    }
    if attempts.Load() != 3 {
        t.Errorf("expected 3 attempts, got %d", attempts.Load())
    }
}

func TestCircuitBreakerOpens(t *testing.T) {
    cb := resilience.NewInstrumentedCircuitBreaker[string](resilience.CircuitBreakerConfig{
        Name:        "test-cb",
        MaxRequests: 1,
        Timeout:     100 * time.Millisecond,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures >= 3
        },
    })

    ctx := context.Background()
    failErr := errors.New("service error")

    // Trigger 3 consecutive failures to open the circuit
    for i := 0; i < 3; i++ {
        _, err := cb.Execute(ctx, func(_ context.Context) (string, error) {
            return "", failErr
        })
        if err == nil {
            t.Errorf("expected error on attempt %d", i+1)
        }
    }

    // Circuit should now be open
    _, err := cb.Execute(ctx, func(_ context.Context) (string, error) {
        return "success", nil
    })
    if !errors.Is(err, gobreaker.ErrOpenState) {
        t.Errorf("expected circuit open error, got %v", err)
    }
}

func TestBulkheadRejectsWhenFull(t *testing.T) {
    bh := resilience.NewBulkhead("test-bh", 2, 0, 100*time.Millisecond)
    ctx := context.Background()

    // Saturate the bulkhead with slow functions
    var wg sync.WaitGroup
    for i := 0; i < 2; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            bh.Execute(ctx, func(ctx context.Context) error {
                time.Sleep(200 * time.Millisecond)
                return nil
            })
        }()
    }

    time.Sleep(10 * time.Millisecond) // Let goroutines acquire slots

    // This request should be rejected
    err := bh.Execute(ctx, func(_ context.Context) error {
        return nil
    })
    if err == nil {
        t.Error("expected bulkhead rejection error")
    }

    wg.Wait()
}
```

## Summary

Distributed system resilience in Go requires layering complementary patterns. Circuit breakers stop cascading failures by fast-failing requests when a dependency is unhealthy, allowing it time to recover. Exponential backoff with jitter prevents clients from overwhelming a recovering service with synchronized retries. Retry budgets limit the amplification effect of retries across many clients. Bulkheads prevent one slow or failing dependency from consuming all available goroutines or connections. Context-based timeout propagation ensures bounded operation time end-to-end. When deployed with a service mesh, these patterns should be coordinated to avoid retry amplification, keeping application-level circuit breakers for fast-fail and delegating retry logic to the mesh layer.
