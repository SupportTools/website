---
title: "Go Circuit Breaker Patterns: State Machines, Metrics Integration, and Resilience Composition"
date: 2028-05-28T00:00:00-05:00
draft: false
tags: ["Go", "Circuit Breaker", "Resilience", "Distributed Systems", "sony/gobreaker", "Production"]
categories: ["Go", "Backend Engineering", "Resilience Patterns"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go circuit breaker patterns covering sony/gobreaker, Netflix Hystrix patterns in Go, state machines, Prometheus metrics integration, and composing circuit breakers with retry and timeout strategies."
more_link: "yes"
url: "/go-circuit-breaker-patterns-production-guide/"
---

Circuit breakers prevent cascading failures in distributed systems by detecting when a downstream dependency is failing and temporarily short-circuiting calls to it, allowing the system to recover. Unlike simple retry logic, circuit breakers maintain state across calls, transitioning through closed, open, and half-open states based on observed failure rates. This guide covers production circuit breaker implementation in Go using the `sony/gobreaker` library, manual implementation for custom requirements, and composing circuit breakers with retry and timeout strategies.

<!--more-->

## Circuit Breaker State Machine

A circuit breaker operates as a three-state machine:

```
              failure threshold exceeded
    ┌──────────────────────────────────────┐
    │                                      │
    ▼                                      │
┌────────┐                          ┌──────────┐
│ CLOSED │  ─── failures exceed ──▶ │  OPEN    │
│(normal)│     threshold            │(blocking)│
└────────┘                          └──────────┘
    ▲                                      │
    │                                      │ timeout expires
    │                              ┌───────────────┐
    │  probe succeeds              │  HALF-OPEN    │
    └──────────────────────────────│ (testing)     │
                                   └───────────────┘
                                          │
                                          │ probe fails
                                          ▼
                                     back to OPEN
```

- **Closed**: Normal operation. Failures are counted. If failures exceed the threshold within the counting window, the breaker opens.
- **Open**: All calls fail immediately without reaching the downstream service. After a timeout, the breaker moves to half-open.
- **Half-Open**: A limited number of probe calls are allowed through. Successes close the breaker; failures reopen it.

## Using sony/gobreaker

`sony/gobreaker` is the most widely used circuit breaker library for Go.

```bash
go get github.com/sony/gobreaker/v2@latest
```

### Basic Configuration

```go
package breaker

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/sony/gobreaker/v2"
)

type DatabaseClient struct {
    cb     *gobreaker.CircuitBreaker[[]byte]
    client *sql.DB
}

func NewDatabaseClient(db *sql.DB) *DatabaseClient {
    settings := gobreaker.Settings{
        Name: "database",

        // Maximum number of consecutive failures before opening
        MaxRequests: 3,

        // Time to wait in Open state before moving to Half-Open
        Timeout: 30 * time.Second,

        // Rolling window for counting failures
        // If nil, uses ConsecutiveFailed
        Interval: 60 * time.Second,

        // ReadyToTrip determines when to transition Closed -> Open
        // counts contains: requests, total successes, total failures,
        // consecutive successes, consecutive failures
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            // Open if failure rate > 60% with at least 10 requests in window
            return counts.Requests >= 10 && failureRatio >= 0.6
        },

        // OnStateChange is called when the circuit breaker changes state
        OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
            slog.Warn("circuit breaker state change",
                "breaker", name,
                "from", from.String(),
                "to", to.String(),
            )
            // Emit metrics on state change
            circuitBreakerStateGauge.WithLabelValues(name, to.String()).Set(1)
            circuitBreakerStateGauge.WithLabelValues(name, from.String()).Set(0)
        },

        // IsSuccessful determines if a response counts as a success
        // Default: err == nil
        IsSuccessful: func(err error) bool {
            // Don't count context cancellation as a circuit failure
            // The client cancelled — the server didn't fail
            if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
                return true
            }
            // Don't count 4xx errors as circuit failures
            var httpErr *HTTPError
            if errors.As(err, &httpErr) && httpErr.StatusCode < 500 {
                return true
            }
            return err == nil
        },
    }

    cb := gobreaker.NewCircuitBreaker[[]byte](settings)
    return &DatabaseClient{cb: cb, client: db}
}

func (c *DatabaseClient) Query(ctx context.Context, query string, args ...interface{}) ([]byte, error) {
    result, err := c.cb.Execute(func() ([]byte, error) {
        rows, err := c.client.QueryContext(ctx, query, args...)
        if err != nil {
            return nil, fmt.Errorf("query: %w", err)
        }
        defer rows.Close()
        return serializeRows(rows)
    })

    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            // Circuit is open — return a cached or degraded response
            return c.getFallback(ctx, query)
        }
        if errors.Is(err, gobreaker.ErrTooManyRequests) {
            // Circuit is half-open and quota is exhausted
            return nil, fmt.Errorf("circuit breaker half-open quota exceeded: %w", err)
        }
        return nil, err
    }

    return result, nil
}

func (c *DatabaseClient) getFallback(ctx context.Context, query string) ([]byte, error) {
    // Return cached data or an empty result rather than failing hard
    slog.Warn("circuit open, returning fallback response", "query", query)
    return []byte("[]"), nil
}
```

### Two-Phase Backoff

For services with variable recovery time, implement adaptive timeout:

```go
type AdaptiveCircuitBreaker struct {
    cb          *gobreaker.CircuitBreaker[interface{}]
    openedAt    time.Time
    baseTimeout time.Duration
    maxTimeout  time.Duration
}

func (a *AdaptiveCircuitBreaker) getTimeout() time.Duration {
    if a.openedAt.IsZero() {
        return a.baseTimeout
    }
    // Exponential backoff on the open timeout
    elapsed := time.Since(a.openedAt)
    attempts := int(elapsed / a.baseTimeout)
    timeout := a.baseTimeout * time.Duration(1<<min(attempts, 5))
    if timeout > a.maxTimeout {
        return a.maxTimeout
    }
    return timeout
}
```

## Manual Circuit Breaker Implementation

For precise control over behavior, implementing the state machine directly provides maximum flexibility:

```go
package circuitbreaker

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

var (
    ErrCircuitOpen     = errors.New("circuit breaker is open")
    ErrCircuitHalfOpen = errors.New("circuit breaker is half-open, probe limit reached")
)

type State int32

const (
    StateClosed   State = 0
    StateOpen     State = 1
    StateHalfOpen State = 2
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "closed"
    case StateOpen:
        return "open"
    case StateHalfOpen:
        return "half-open"
    default:
        return "unknown"
    }
}

type Config struct {
    Name string

    // Closed state settings
    FailureThreshold      int           // failures in window to open
    FailureWindow         time.Duration // rolling window duration
    MinimumRequestVolume  int           // minimum requests before evaluating

    // Open state settings
    OpenTimeout time.Duration // time to wait before testing

    // Half-open state settings
    HalfOpenMaxProbes  int           // max concurrent probes
    HalfOpenSuccesses  int           // successes needed to close
    HalfOpenTimeout    time.Duration // timeout for each probe

    // Callbacks
    OnStateChange func(name string, from, to State)
    IsSuccessful  func(error) bool
}

type CircuitBreaker struct {
    cfg Config

    state     atomic.Int32
    mu        sync.Mutex

    // Sliding window for failure counting
    window    *slidingWindow

    // Open state tracking
    openedAt  time.Time

    // Half-open state tracking
    probeCount    atomic.Int32
    probeSucc     atomic.Int32

    // Metrics
    requestsTotal   *prometheus.CounterVec
    stateGauge      *prometheus.GaugeVec
    openDuration    prometheus.Histogram
}

func New(cfg Config, reg prometheus.Registerer) *CircuitBreaker {
    if cfg.IsSuccessful == nil {
        cfg.IsSuccessful = func(err error) bool { return err == nil }
    }

    cb := &CircuitBreaker{
        cfg:    cfg,
        window: newSlidingWindow(cfg.FailureWindow),
    }

    if reg != nil {
        cb.requestsTotal = promauto.With(reg).NewCounterVec(prometheus.CounterOpts{
            Name: "circuit_breaker_requests_total",
            Help: "Total requests through the circuit breaker",
        }, []string{"name", "state", "result"})

        cb.stateGauge = promauto.With(reg).NewGaugeVec(prometheus.GaugeOpts{
            Name: "circuit_breaker_state",
            Help: "Current state of circuit breaker (1=active, 0=inactive)",
        }, []string{"name", "state"})

        cb.openDuration = promauto.With(reg).NewHistogram(prometheus.HistogramOpts{
            Name:    "circuit_breaker_open_duration_seconds",
            Help:    "Duration circuit breaker spends in open state",
            Buckets: prometheus.ExponentialBuckets(0.5, 2, 10),
        })

        // Initialize state metric
        for _, s := range []string{"closed", "open", "half-open"} {
            cb.stateGauge.WithLabelValues(cfg.Name, s).Set(0)
        }
        cb.stateGauge.WithLabelValues(cfg.Name, "closed").Set(1)
    }

    return cb
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    state := State(cb.state.Load())

    switch state {
    case StateClosed:
        return cb.executeClosed(fn)
    case StateOpen:
        return cb.executeOpen(fn)
    case StateHalfOpen:
        return cb.executeHalfOpen(fn)
    default:
        return fn()
    }
}

func (cb *CircuitBreaker) executeClosed(fn func() error) error {
    err := fn()
    cb.recordResult(err, StateClosed)
    cb.evaluateTransition()
    return err
}

func (cb *CircuitBreaker) executeOpen(fn func() error) error {
    cb.mu.Lock()
    openedAt := cb.openedAt
    timeout := cb.cfg.OpenTimeout
    cb.mu.Unlock()

    if time.Since(openedAt) < timeout {
        cb.requestsTotal.WithLabelValues(cb.cfg.Name, "open", "rejected").Inc()
        return ErrCircuitOpen
    }

    // Timeout expired, transition to half-open
    cb.transitionTo(StateOpen, StateHalfOpen)
    return cb.executeHalfOpen(fn)
}

func (cb *CircuitBreaker) executeHalfOpen(fn func() error) error {
    probeCount := cb.probeCount.Add(1)
    if probeCount > int32(cb.cfg.HalfOpenMaxProbes) {
        cb.probeCount.Add(-1)
        return ErrCircuitHalfOpen
    }

    defer cb.probeCount.Add(-1)

    err := fn()
    cb.recordResult(err, StateHalfOpen)

    if cb.cfg.IsSuccessful(err) {
        successes := cb.probeSucc.Add(1)
        if int(successes) >= cb.cfg.HalfOpenSuccesses {
            cb.transitionTo(StateHalfOpen, StateClosed)
        }
    } else {
        // Any failure in half-open re-opens the circuit
        cb.transitionTo(StateHalfOpen, StateOpen)
    }

    return err
}

func (cb *CircuitBreaker) evaluateTransition() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if State(cb.state.Load()) != StateClosed {
        return
    }

    failures, total := cb.window.counts()
    if total < cb.cfg.MinimumRequestVolume {
        return
    }

    if failures >= cb.cfg.FailureThreshold {
        cb.transitionToLocked(StateClosed, StateOpen)
    }
}

func (cb *CircuitBreaker) transitionTo(from, to State) {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    cb.transitionToLocked(from, to)
}

func (cb *CircuitBreaker) transitionToLocked(from, to State) {
    if !cb.state.CompareAndSwap(int32(from), int32(to)) {
        return // Someone else already transitioned
    }

    switch to {
    case StateOpen:
        now := time.Now()
        if !cb.openedAt.IsZero() {
            // Record time this circuit was open
            if cb.openDuration != nil {
                cb.openDuration.Observe(now.Sub(cb.openedAt).Seconds())
            }
        }
        cb.openedAt = now
        cb.window.reset()
    case StateClosed:
        cb.window.reset()
        cb.probeSucc.Store(0)
    case StateHalfOpen:
        cb.probeCount.Store(0)
        cb.probeSucc.Store(0)
    }

    if cb.stateGauge != nil {
        cb.stateGauge.WithLabelValues(cb.cfg.Name, from.String()).Set(0)
        cb.stateGauge.WithLabelValues(cb.cfg.Name, to.String()).Set(1)
    }

    if cb.cfg.OnStateChange != nil {
        go cb.cfg.OnStateChange(cb.cfg.Name, from, to)
    }
}

func (cb *CircuitBreaker) recordResult(err error, state State) {
    result := "success"
    if !cb.cfg.IsSuccessful(err) {
        result = "failure"
        cb.window.record(false)
    } else {
        cb.window.record(true)
    }

    if cb.requestsTotal != nil {
        cb.requestsTotal.WithLabelValues(cb.cfg.Name, state.String(), result).Inc()
    }
}

// State returns the current circuit breaker state
func (cb *CircuitBreaker) State() State {
    return State(cb.state.Load())
}
```

### Sliding Window Implementation

```go
// slidingWindow implements a time-based sliding window for failure counting
type slidingWindow struct {
    mu       sync.Mutex
    duration time.Duration
    buckets  []bucket
    numBuckets int
    bucketDur  time.Duration
    startTime  time.Time
}

type bucket struct {
    successes int
    failures  int
}

func newSlidingWindow(duration time.Duration) *slidingWindow {
    numBuckets := 10
    return &slidingWindow{
        duration:   duration,
        numBuckets: numBuckets,
        bucketDur:  duration / time.Duration(numBuckets),
        buckets:    make([]bucket, numBuckets),
        startTime:  time.Now(),
    }
}

func (w *slidingWindow) record(success bool) {
    w.mu.Lock()
    defer w.mu.Unlock()

    idx := w.currentBucket()
    if success {
        w.buckets[idx].successes++
    } else {
        w.buckets[idx].failures++
    }
}

func (w *slidingWindow) counts() (failures, total int) {
    w.mu.Lock()
    defer w.mu.Unlock()

    for _, b := range w.buckets {
        failures += b.failures
        total += b.successes + b.failures
    }
    return failures, total
}

func (w *slidingWindow) currentBucket() int {
    elapsed := time.Since(w.startTime)
    return int(elapsed/w.bucketDur) % w.numBuckets
}

func (w *slidingWindow) reset() {
    w.mu.Lock()
    defer w.mu.Unlock()
    w.buckets = make([]bucket, w.numBuckets)
    w.startTime = time.Now()
}
```

## Combining Circuit Breaker with Retry and Timeout

The power of circuit breakers comes from composing them with other resilience patterns:

```go
package resilience

import (
    "context"
    "errors"
    "math"
    "math/rand"
    "time"
)

// RetryConfig configures retry behavior
type RetryConfig struct {
    MaxAttempts    int
    InitialDelay   time.Duration
    MaxDelay       time.Duration
    Multiplier     float64
    Jitter         bool
    RetryableError func(error) bool
}

// TimeoutConfig configures per-call timeouts
type TimeoutConfig struct {
    Timeout time.Duration
}

// ResilientClient wraps a function call with circuit breaker, retry, and timeout
type ResilientClient struct {
    breaker *CircuitBreaker
    retry   RetryConfig
    timeout TimeoutConfig
}

func NewResilientClient(breaker *CircuitBreaker, retry RetryConfig, timeout TimeoutConfig) *ResilientClient {
    return &ResilientClient{
        breaker: breaker,
        retry:   retry,
        timeout: timeout,
    }
}

// Execute runs fn with circuit breaker protection, retries, and per-call timeout
// Order of application: timeout wraps the call, retry wraps timeout, circuit breaker wraps retry
func (c *ResilientClient) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    return c.breaker.Execute(func() error {
        return c.withRetry(ctx, fn)
    })
}

func (c *ResilientClient) withRetry(ctx context.Context, fn func(ctx context.Context) error) error {
    var lastErr error

    for attempt := 0; attempt < c.retry.MaxAttempts; attempt++ {
        if attempt > 0 {
            delay := c.backoffDelay(attempt)
            select {
            case <-time.After(delay):
            case <-ctx.Done():
                return ctx.Err()
            }
        }

        err := c.withTimeout(ctx, fn)

        // Don't retry if the circuit breaker opened
        if errors.Is(err, ErrCircuitOpen) || errors.Is(err, ErrCircuitHalfOpen) {
            return err
        }

        // Don't retry context cancellation/deadline from the outer context
        if errors.Is(err, context.Canceled) {
            return err
        }

        if err == nil {
            return nil
        }

        lastErr = err

        // Only retry if the error is retryable
        if c.retry.RetryableError != nil && !c.retry.RetryableError(err) {
            return err
        }
    }

    return fmt.Errorf("after %d attempts: %w", c.retry.MaxAttempts, lastErr)
}

func (c *ResilientClient) withTimeout(ctx context.Context, fn func(ctx context.Context) error) error {
    if c.timeout.Timeout <= 0 {
        return fn(ctx)
    }

    timeoutCtx, cancel := context.WithTimeout(ctx, c.timeout.Timeout)
    defer cancel()
    return fn(timeoutCtx)
}

func (c *ResilientClient) backoffDelay(attempt int) time.Duration {
    delay := float64(c.retry.InitialDelay) * math.Pow(c.retry.Multiplier, float64(attempt-1))
    maxDelay := float64(c.retry.MaxDelay)
    if delay > maxDelay {
        delay = maxDelay
    }

    if c.retry.Jitter {
        // Add ±25% jitter to prevent thundering herd
        jitter := delay * 0.25
        delay = delay - jitter + rand.Float64()*jitter*2
    }

    return time.Duration(delay)
}
```

### Usage Example

```go
func NewPaymentServiceClient(addr string, reg prometheus.Registerer) *PaymentClient {
    httpClient := &http.Client{
        Transport: &http.Transport{
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 20,
            IdleConnTimeout:     90 * time.Second,
        },
    }

    breaker := circuitbreaker.New(circuitbreaker.Config{
        Name:                 "payment-service",
        FailureThreshold:     5,
        FailureWindow:        30 * time.Second,
        MinimumRequestVolume: 10,
        OpenTimeout:          30 * time.Second,
        HalfOpenMaxProbes:    3,
        HalfOpenSuccesses:    2,
        IsSuccessful: func(err error) bool {
            if err == nil {
                return true
            }
            var httpErr *PaymentHTTPError
            if errors.As(err, &httpErr) {
                // 429 Too Many Requests should not open the circuit
                // 503 Service Unavailable should open the circuit
                return httpErr.StatusCode == http.StatusTooManyRequests
            }
            return false
        },
        OnStateChange: func(name string, from, to circuitbreaker.State) {
            slog.Warn("payment service circuit breaker changed",
                "from", from.String(),
                "to", to.String(),
            )
        },
    }, reg)

    resilient := resilience.NewResilientClient(breaker,
        resilience.RetryConfig{
            MaxAttempts:  3,
            InitialDelay: 100 * time.Millisecond,
            MaxDelay:     2 * time.Second,
            Multiplier:   2.0,
            Jitter:       true,
            RetryableError: func(err error) bool {
                var httpErr *PaymentHTTPError
                if errors.As(err, &httpErr) {
                    // Only retry on server errors and rate limiting
                    return httpErr.StatusCode >= 500 || httpErr.StatusCode == 429
                }
                // Retry network errors
                return !errors.Is(err, context.Canceled)
            },
        },
        resilience.TimeoutConfig{
            Timeout: 5 * time.Second,
        },
    )

    return &PaymentClient{
        httpClient: httpClient,
        addr:       addr,
        resilient:  resilient,
    }
}

func (c *PaymentClient) ProcessPayment(ctx context.Context, req *PaymentRequest) (*PaymentResponse, error) {
    var resp *PaymentResponse

    err := c.resilient.Execute(ctx, func(ctx context.Context) error {
        r, err := c.doRequest(ctx, req)
        if err != nil {
            return err
        }
        resp = r
        return nil
    })

    if err != nil {
        if errors.Is(err, circuitbreaker.ErrCircuitOpen) {
            // Return a degraded response rather than failing
            return &PaymentResponse{
                Status:  "deferred",
                Message: "payment system temporarily unavailable, will retry",
            }, nil
        }
        return nil, err
    }

    return resp, nil
}
```

## Multi-Level Circuit Breakers

For complex service graphs, apply circuit breakers at multiple levels:

```go
// ServiceMesh represents a set of downstream services with individual circuit breakers
type ServiceMesh struct {
    services map[string]*ResilientClient
    // Global circuit breaker that opens when multiple services fail
    global   *CircuitBreaker
}

func (m *ServiceMesh) Call(ctx context.Context, service string, fn func(ctx context.Context) error) error {
    svc, ok := m.services[service]
    if !ok {
        return fmt.Errorf("unknown service: %s", service)
    }

    // Check global circuit breaker first
    if m.global.State() == StateOpen {
        return fmt.Errorf("global circuit breaker open: all downstream services degraded")
    }

    return svc.Execute(ctx, func(ctx context.Context) error {
        err := fn(ctx)
        // Update global circuit breaker based on per-service outcomes
        m.updateGlobal(service, err)
        return err
    })
}

func (m *ServiceMesh) updateGlobal(service string, err error) {
    openCount := 0
    for _, svc := range m.services {
        if svc.breaker.State() == StateOpen {
            openCount++
        }
    }
    // If more than half of services are open, open the global breaker
    threshold := len(m.services) / 2
    if openCount > threshold {
        m.global.Execute(func() error {
            return errors.New("majority of services degraded")
        })
    }
}
```

## HTTP Middleware with Circuit Breaker

```go
// CircuitBreakerMiddleware returns an HTTP middleware that applies a circuit breaker to upstream calls
func CircuitBreakerMiddleware(breaker *CircuitBreaker, fallbackHandler http.Handler) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            err := breaker.Execute(func() error {
                // Capture the response to detect server errors
                rec := httptest.NewRecorder()
                next.ServeHTTP(rec, r)

                // Copy response
                for k, v := range rec.Header() {
                    w.Header()[k] = v
                }
                w.WriteHeader(rec.Code)
                w.Write(rec.Body.Bytes())

                // Report server errors to circuit breaker
                if rec.Code >= 500 {
                    return fmt.Errorf("upstream returned %d", rec.Code)
                }
                return nil
            })

            if errors.Is(err, ErrCircuitOpen) {
                if fallbackHandler != nil {
                    fallbackHandler.ServeHTTP(w, r)
                } else {
                    http.Error(w, "service unavailable", http.StatusServiceUnavailable)
                }
            }
        })
    }
}
```

## Prometheus Monitoring Dashboard

```promql
# Circuit breaker state (1=open, 0=closed/half-open)
circuit_breaker_state{state="open"}

# Request failure rate per breaker
rate(circuit_breaker_requests_total{result="failure"}[5m])
  /
rate(circuit_breaker_requests_total[5m])

# How often breakers open
rate(circuit_breaker_state{state="open"}[1h])

# Time breakers spend open
histogram_quantile(0.95, circuit_breaker_open_duration_seconds_bucket)

# Rejected requests (circuit open)
rate(circuit_breaker_requests_total{result="rejected"}[5m])
```

### Alerting Rules

```yaml
# circuit-breaker-alerts.yaml
groups:
  - name: circuit_breakers
    rules:
      - alert: CircuitBreakerOpen
        expr: circuit_breaker_state{state="open"} == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker {{ $labels.name }} is open"
          description: "Downstream service is experiencing failures"

      - alert: CircuitBreakerHighRejectionRate
        expr: |
          rate(circuit_breaker_requests_total{result="rejected"}[5m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Circuit breaker {{ $labels.name }} rejecting high volume"
          description: "{{ $value }} requests/sec being rejected by circuit breaker"

      - alert: CircuitBreakerFlapping
        expr: |
          changes(circuit_breaker_state{state="open"}[30m]) > 5
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker {{ $labels.name }} is flapping"
```

## Testing Circuit Breaker Behavior

```go
package circuitbreaker_test

import (
    "errors"
    "testing"
    "time"
)

var errService = errors.New("service error")

func TestCircuitBreakerOpens(t *testing.T) {
    cb := New(Config{
        Name:                 "test",
        FailureThreshold:     3,
        FailureWindow:        time.Minute,
        MinimumRequestVolume: 5,
        OpenTimeout:          100 * time.Millisecond,
        HalfOpenMaxProbes:    2,
        HalfOpenSuccesses:    2,
    }, nil)

    // Build up request volume
    for i := 0; i < 3; i++ {
        cb.Execute(func() error { return nil }) // successes
    }

    // Trigger failures
    for i := 0; i < 3; i++ {
        cb.Execute(func() error { return errService })
    }

    // Circuit should now be open (5 requests total, 3 failures = 60%)
    err := cb.Execute(func() error { return nil })
    if !errors.Is(err, ErrCircuitOpen) {
        t.Errorf("expected ErrCircuitOpen, got %v", err)
    }
}

func TestCircuitBreakerHalfOpenTransition(t *testing.T) {
    cb := New(Config{
        Name:                 "test",
        FailureThreshold:     3,
        FailureWindow:        time.Minute,
        MinimumRequestVolume: 5,
        OpenTimeout:          50 * time.Millisecond,
        HalfOpenMaxProbes:    2,
        HalfOpenSuccesses:    2,
    }, nil)

    // Open the circuit
    for i := 0; i < 5; i++ {
        cb.Execute(func() error { return errService })
    }

    if cb.State() != StateOpen {
        t.Fatalf("expected open state")
    }

    // Wait for timeout
    time.Sleep(100 * time.Millisecond)

    // First probe should succeed
    err := cb.Execute(func() error { return nil })
    if err != nil {
        t.Errorf("probe should succeed, got: %v", err)
    }

    if cb.State() != StateHalfOpen && cb.State() != StateClosed {
        t.Errorf("expected half-open or closed, got %s", cb.State())
    }
}

func TestCircuitBreakerContextCancellationNotCounted(t *testing.T) {
    cb := New(Config{
        Name:                 "test",
        FailureThreshold:     3,
        FailureWindow:        time.Minute,
        MinimumRequestVolume: 5,
        OpenTimeout:          time.Second,
        IsSuccessful: func(err error) bool {
            return err == nil || errors.Is(err, context.Canceled)
        },
    }, nil)

    // Context cancellations should not count as failures
    for i := 0; i < 10; i++ {
        cb.Execute(func() error { return context.Canceled })
    }

    if cb.State() != StateClosed {
        t.Errorf("circuit should remain closed for context cancellations")
    }
}
```

## Summary

Circuit breakers are a critical component of resilient distributed systems. The key patterns:

- Use `sony/gobreaker` for production use cases where the library's built-in concurrency safety and sliding window logic meets requirements
- Implement a custom circuit breaker when you need precise control over state transitions, probe logic, or metrics integration
- Always customize `IsSuccessful` to distinguish between client errors (4xx) and server errors (5xx) — treating all errors equally will cause premature circuit opens
- Compose circuit breakers with retries and timeouts: retry handles transient failures, timeout bounds individual call latency, and the circuit breaker prevents retry storms against degraded services
- Apply circuit breakers at the individual client level, not globally — a payment service failure should not block your user profile service
- Monitor state transitions and rejection rates with Prometheus alerts to distinguish between expected circuit protection and unexpected degradation
