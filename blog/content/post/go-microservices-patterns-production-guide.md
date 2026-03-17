---
title: "Go Microservices Production Patterns: Circuit Breakers, Retries, and Timeouts"
date: 2028-01-04T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "Circuit Breaker", "Resilience", "Service Discovery", "Patterns"]
categories: ["Go", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go microservice resilience patterns covering circuit breakers with gobreaker, retry with exponential backoff, timeout propagation via context, bulkhead with semaphores, health check endpoints, graceful shutdown, and load balancing strategies."
more_link: "yes"
url: "/go-microservices-patterns-production-guide/"
---

Distributed systems fail in partial and non-obvious ways. A slow downstream service can exhaust connection pools, causing cascading failures across unrelated services. Missing context deadlines allow goroutines to accumulate, exhausting memory. These failure modes are not hypothetical — they occur in every production microservice environment.

This guide covers the resilience patterns that production Go microservices require: circuit breakers that detect and isolate failing dependencies, retry strategies with jitter that prevent thundering herd, context-based timeout propagation that enforces end-to-end latency budgets, bulkhead patterns that isolate resource pools, health check endpoints that integrate with Kubernetes probes, graceful shutdown for zero-downtime deployments, and client-side load balancing with Consul and etcd.

<!--more-->

# Go Microservices Production Patterns: Circuit Breakers, Retries, and Timeouts

## Section 1: Circuit Breaker Pattern

The circuit breaker prevents cascading failures by stopping calls to a failing downstream service after a threshold of failures, allowing the service time to recover.

### States: Closed → Open → Half-Open

```
Closed (normal):    All requests pass through. Failure counter increments on errors.
Open (tripped):     All requests fail fast. No calls to downstream. Timer running.
Half-Open (probe):  Limited requests pass through. If they succeed, close circuit.
                    If they fail, re-open circuit.
```

### Implementation with sony/gobreaker

```go
package circuit

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "time"

    "github.com/sony/gobreaker/v2"
)

// Config holds circuit breaker configuration.
type Config struct {
    Name                 string
    MaxRequests          uint32        // Half-open: max requests to allow through
    Interval             time.Duration // Closed: window for counting failures
    Timeout              time.Duration // Open: duration before transitioning to half-open
    ReadyToTrip          func(counts gobreaker.Counts) bool
    OnStateChange        func(name string, from, to gobreaker.State)
}

// NewCircuitBreaker creates a production-configured circuit breaker.
func NewCircuitBreaker[T any](cfg Config) *gobreaker.CircuitBreaker[T] {
    settings := gobreaker.Settings{
        Name:        cfg.Name,
        MaxRequests: cfg.MaxRequests,
        Interval:    cfg.Interval,
        Timeout:     cfg.Timeout,
        ReadyToTrip: cfg.ReadyToTrip,
        OnStateChange: func(name string, from, to gobreaker.State) {
            slog.Warn("circuit breaker state change",
                slog.String("breaker", name),
                slog.String("from", from.String()),
                slog.String("to", to.String()),
            )
            if cfg.OnStateChange != nil {
                cfg.OnStateChange(name, from, to)
            }
        },
        IsSuccessful: func(err error) bool {
            // Don't count context cancellation as circuit failure
            if errors.Is(err, context.Canceled) {
                return true
            }
            // Don't count 4xx client errors as circuit failures
            var httpErr *HTTPError
            if errors.As(err, &httpErr) && httpErr.StatusCode < 500 {
                return true
            }
            return err == nil
        },
    }
    return gobreaker.NewCircuitBreaker[T](settings)
}

// HTTPError represents an HTTP error response.
type HTTPError struct {
    StatusCode int
    Message    string
}

func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Message)
}

// ProductionCircuitBreaker returns a circuit breaker with production defaults.
// Trips after 5 consecutive failures or 50% failure rate in a 60s window.
func ProductionCircuitBreaker(serviceName string) *gobreaker.CircuitBreaker[[]byte] {
    return NewCircuitBreaker[[]byte](Config{
        Name:        serviceName,
        MaxRequests: 3,          // Half-open: allow 3 test requests
        Interval:    60 * time.Second,
        Timeout:     30 * time.Second,  // Open for 30s before probing
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.ConsecutiveFailures > 5 ||
                (counts.Requests >= 10 && failureRatio >= 0.5)
        },
    })
}
```

### Circuit Breaker with HTTP Client

```go
package client

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "time"

    "github.com/sony/gobreaker/v2"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
)

// ResilientHTTPClient combines circuit breaker, retry, and timeout.
type ResilientHTTPClient struct {
    httpClient     *http.Client
    circuitBreaker *gobreaker.CircuitBreaker[[]byte]
    retrier        *Retrier
    serviceName    string
}

// NewResilientHTTPClient creates a client with all resilience patterns applied.
func NewResilientHTTPClient(serviceName string) *ResilientHTTPClient {
    return &ResilientHTTPClient{
        httpClient: &http.Client{
            Timeout: 30 * time.Second,
            Transport: &http.Transport{
                MaxIdleConns:          100,
                MaxIdleConnsPerHost:   10,
                IdleConnTimeout:       90 * time.Second,
                TLSHandshakeTimeout:   10 * time.Second,
                ExpectContinueTimeout: 1 * time.Second,
                DisableKeepAlives:     false,
            },
        },
        circuitBreaker: ProductionCircuitBreaker(serviceName),
        retrier:        NewRetrier(DefaultRetryConfig()),
        serviceName:    serviceName,
    }
}

// Get executes an HTTP GET with circuit breaker, retry, and tracing.
func (c *ResilientHTTPClient) Get(ctx context.Context, url string) ([]byte, error) {
    tracer := otel.Tracer("resilient-http-client")
    ctx, span := tracer.Start(ctx, fmt.Sprintf("GET %s", c.serviceName),
        trace.WithAttributes(
            attribute.String("http.url", url),
            attribute.String("service.name", c.serviceName),
        ),
    )
    defer span.End()

    result, err := c.circuitBreaker.Execute(func() ([]byte, error) {
        return c.retrier.Do(ctx, func(ctx context.Context) ([]byte, error) {
            return c.doRequest(ctx, http.MethodGet, url, nil)
        })
    })

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())

        // Check if circuit is open
        if errors.Is(err, gobreaker.ErrOpenState) {
            return nil, fmt.Errorf("circuit open for %s: %w", c.serviceName, err)
        }
    }
    return result, err
}

func (c *ResilientHTTPClient) doRequest(ctx context.Context, method, url string, body io.Reader) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, method, url, body)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    // Propagate trace context to downstream service
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    body_bytes, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))  // 10 MB limit
    if err != nil {
        return nil, fmt.Errorf("reading response body: %w", err)
    }

    if resp.StatusCode >= 500 {
        return nil, &HTTPError{
            StatusCode: resp.StatusCode,
            Message:    string(body_bytes),
        }
    }

    return body_bytes, nil
}
```

## Section 2: Retry with Exponential Backoff and Jitter

### Retry Configuration and Implementation

```go
package client

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "math"
    "math/rand"
    "net/http"
    "time"
)

// RetryConfig configures retry behavior.
type RetryConfig struct {
    MaxAttempts  int
    InitialDelay time.Duration
    MaxDelay     time.Duration
    Multiplier   float64
    Jitter       float64       // 0.0–1.0: fraction of delay to add as random jitter
    RetryOn      func(error) bool
}

// DefaultRetryConfig returns production-safe retry defaults.
func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxAttempts:  3,
        InitialDelay: 100 * time.Millisecond,
        MaxDelay:     10 * time.Second,
        Multiplier:   2.0,
        Jitter:       0.2,  // ±20% jitter prevents thundering herd
        RetryOn:      defaultRetryPredicate,
    }
}

// defaultRetryPredicate determines which errors are retryable.
func defaultRetryPredicate(err error) bool {
    if err == nil {
        return false
    }
    // Never retry context cancellation or deadline exceeded
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        return false
    }
    // Retry on network errors (connection reset, timeout, DNS)
    var netErr interface{ Timeout() bool }
    if errors.As(err, &netErr) && netErr.Timeout() {
        return true
    }
    // Retry on 429 (rate limit) and 5xx server errors
    var httpErr *HTTPError
    if errors.As(err, &httpErr) {
        return httpErr.StatusCode == http.StatusTooManyRequests ||
            httpErr.StatusCode >= 500
    }
    return true
}

// Retrier executes operations with configurable retry behavior.
type Retrier struct {
    config RetryConfig
    rng    *rand.Rand
}

// NewRetrier creates a new Retrier with the given configuration.
func NewRetrier(cfg RetryConfig) *Retrier {
    return &Retrier{
        config: cfg,
        rng:    rand.New(rand.NewSource(time.Now().UnixNano())),
    }
}

// Do executes fn with retry logic, respecting context cancellation.
func (r *Retrier) Do(ctx context.Context, fn func(context.Context) ([]byte, error)) ([]byte, error) {
    var lastErr error

    for attempt := 0; attempt < r.config.MaxAttempts; attempt++ {
        // Check context before each attempt
        if ctx.Err() != nil {
            return nil, ctx.Err()
        }

        result, err := fn(ctx)
        if err == nil {
            if attempt > 0 {
                slog.InfoContext(ctx, "retry succeeded",
                    slog.Int("attempt", attempt+1),
                )
            }
            return result, nil
        }

        lastErr = err

        // Check if this error is retryable
        if !r.config.RetryOn(err) {
            return nil, fmt.Errorf("non-retryable error: %w", err)
        }

        // Don't sleep after last attempt
        if attempt == r.config.MaxAttempts-1 {
            break
        }

        delay := r.calculateDelay(attempt)
        slog.WarnContext(ctx, "retrying after error",
            slog.Int("attempt", attempt+1),
            slog.Int("max_attempts", r.config.MaxAttempts),
            slog.Duration("retry_delay", delay),
            slog.String("error", err.Error()),
        )

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(delay):
            // Continue to next attempt
        }
    }

    return nil, fmt.Errorf("all %d attempts failed, last error: %w", r.config.MaxAttempts, lastErr)
}

// calculateDelay computes the backoff delay with full jitter.
func (r *Retrier) calculateDelay(attempt int) time.Duration {
    // Exponential backoff: initialDelay * multiplier^attempt
    delay := float64(r.config.InitialDelay) * math.Pow(r.config.Multiplier, float64(attempt))

    // Cap at max delay
    if delay > float64(r.config.MaxDelay) {
        delay = float64(r.config.MaxDelay)
    }

    // Add full jitter: random(0, delay * jitter)
    // Full jitter (AWS recommendation) provides better spread than ±jitter
    jitterRange := delay * r.config.Jitter
    jitter := r.rng.Float64() * jitterRange

    return time.Duration(delay + jitter)
}
```

### Retry with Respect for Retry-After Header

```go
// retryWithRetryAfter honors HTTP 429 Retry-After headers
func retryAfterDelay(resp *http.Response, defaultDelay time.Duration) time.Duration {
    if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
        return defaultDelay
    }

    retryAfter := resp.Header.Get("Retry-After")
    if retryAfter == "" {
        return defaultDelay
    }

    // Try parsing as seconds integer
    if seconds, err := strconv.Atoi(retryAfter); err == nil {
        return time.Duration(seconds) * time.Second
    }

    // Try parsing as HTTP date
    if t, err := http.ParseTime(retryAfter); err == nil {
        delay := time.Until(t)
        if delay > 0 {
            return delay
        }
    }

    return defaultDelay
}
```

## Section 3: Timeout Propagation via Context

### Context Deadline Budget Pattern

Each service in a call chain should receive a fraction of the overall request budget, not a fixed timeout. This prevents cascading timeouts where the entire budget is consumed by the first service.

```go
package timeout

import (
    "context"
    "fmt"
    "time"
)

// BudgetConfig defines timeout fractions for service call layers.
type BudgetConfig struct {
    // Total budget fraction for external calls (leaves remainder for local processing)
    ExternalCallFraction float64
    // Minimum budget before refusing to make a call
    MinBudget time.Duration
    // Maximum budget cap (prevent absurdly long calls)
    MaxBudget time.Duration
}

// DefaultBudgetConfig returns safe defaults for a microservice.
var DefaultBudgetConfig = BudgetConfig{
    ExternalCallFraction: 0.7,        // 70% of remaining budget for external calls
    MinBudget:            50 * time.Millisecond,
    MaxBudget:            10 * time.Second,
}

// WithDownstreamBudget creates a child context with a budget derived from
// the parent's deadline, using the configured fraction.
//
// If parent has no deadline, uses the MaxBudget.
// If remaining budget < MinBudget, returns an error immediately.
func WithDownstreamBudget(ctx context.Context, cfg BudgetConfig) (context.Context, context.CancelFunc, error) {
    deadline, hasDeadline := ctx.Deadline()

    var budget time.Duration
    if hasDeadline {
        remaining := time.Until(deadline)
        budget = time.Duration(float64(remaining) * cfg.ExternalCallFraction)
    } else {
        budget = cfg.MaxBudget
    }

    // Apply bounds
    if budget < cfg.MinBudget {
        return nil, func() {}, fmt.Errorf("insufficient budget for downstream call: %v < %v",
            budget, cfg.MinBudget)
    }
    if budget > cfg.MaxBudget {
        budget = cfg.MaxBudget
    }

    ctx, cancel := context.WithTimeout(ctx, budget)
    return ctx, cancel, nil
}

// Example usage in a service handler:
func HandleOrder(ctx context.Context, orderID string) (*Order, error) {
    // This handler has received a context with some remaining deadline.
    // We allocate 70% of remaining time to the inventory check.
    invCtx, cancel, err := WithDownstreamBudget(ctx, DefaultBudgetConfig)
    if err != nil {
        return nil, fmt.Errorf("no budget for inventory check: %w", err)
    }
    defer cancel()

    inventory, err := inventoryClient.Check(invCtx, orderID)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            // Record the deadline exceeded for monitoring
            return nil, fmt.Errorf("inventory check timed out (budget exceeded): %w", err)
        }
        return nil, fmt.Errorf("inventory check failed: %w", err)
    }

    // Remaining context budget (30%) goes to payment processing
    payCtx, payCancel, err := WithDownstreamBudget(ctx, DefaultBudgetConfig)
    if err != nil {
        return nil, fmt.Errorf("no budget for payment: %w", err)
    }
    defer payCancel()

    payment, err := paymentClient.Process(payCtx, orderID, inventory.Price)
    if err != nil {
        return nil, fmt.Errorf("payment failed: %w", err)
    }

    return &Order{ID: orderID, Payment: payment}, nil
}
```

### Deadline Propagation via gRPC Metadata

```go
package grpcserver

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// DeadlineEnforcementInterceptor enforces minimum deadline for all gRPC calls.
// Rejects calls with less than minDeadline remaining, preventing futile work.
func DeadlineEnforcementInterceptor(minDeadline time.Duration) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        deadline, ok := ctx.Deadline()
        if ok && time.Until(deadline) < minDeadline {
            return nil, status.Errorf(
                codes.DeadlineExceeded,
                "insufficient deadline remaining: %v < %v minimum",
                time.Until(deadline), minDeadline,
            )
        }
        return handler(ctx, req)
    }
}
```

## Section 4: Bulkhead Pattern with Semaphores

The bulkhead pattern limits the number of concurrent calls to a resource, preventing a slow dependency from consuming all available goroutines.

```go
package bulkhead

import (
    "context"
    "fmt"
    "time"
)

// Semaphore implements a counting semaphore for bulkhead isolation.
type Semaphore struct {
    tokens  chan struct{}
    name    string
    metrics *BulkheadMetrics
}

// BulkheadMetrics tracks bulkhead rejection and utilization.
type BulkheadMetrics struct {
    rejected   prometheus.Counter
    waitTime   prometheus.Histogram
    concurrent prometheus.Gauge
}

// NewSemaphore creates a semaphore limiting concurrent executions to maxConcurrent.
func NewSemaphore(name string, maxConcurrent int) *Semaphore {
    return &Semaphore{
        tokens: make(chan struct{}, maxConcurrent),
        name:   name,
        metrics: &BulkheadMetrics{
            rejected: promauto.NewCounter(prometheus.CounterOpts{
                Name: "bulkhead_rejected_total",
                ConstLabels: prometheus.Labels{"bulkhead": name},
            }),
            waitTime: promauto.NewHistogram(prometheus.HistogramOpts{
                Name:    "bulkhead_wait_seconds",
                Buckets: prometheus.DefBuckets,
                ConstLabels: prometheus.Labels{"bulkhead": name},
            }),
            concurrent: promauto.NewGauge(prometheus.GaugeOpts{
                Name: "bulkhead_concurrent_total",
                ConstLabels: prometheus.Labels{"bulkhead": name},
            }),
        },
    }
}

// Execute runs fn within the bulkhead, respecting context deadline.
// Returns ErrBulkheadFull if capacity is exceeded.
func (s *Semaphore) Execute(ctx context.Context, fn func(context.Context) error) error {
    start := time.Now()

    // Try to acquire a token with context deadline
    select {
    case s.tokens <- struct{}{}:
        // Token acquired
        s.metrics.concurrent.Inc()
        s.metrics.waitTime.Observe(time.Since(start).Seconds())
        defer func() {
            <-s.tokens
            s.metrics.concurrent.Dec()
        }()
        return fn(ctx)

    case <-ctx.Done():
        s.metrics.rejected.Inc()
        return ctx.Err()

    default:
        // Non-blocking check: if full, reject immediately
        s.metrics.rejected.Inc()
        return fmt.Errorf("bulkhead %s at capacity: %w", s.name, ErrBulkheadFull)
    }
}

var ErrBulkheadFull = fmt.Errorf("bulkhead full")

// BulkheadPool manages separate semaphores for different resource types.
// Isolates slow external APIs from fast internal calls.
type BulkheadPool struct {
    database    *Semaphore
    externalAPI *Semaphore
    cache       *Semaphore
}

// NewBulkheadPool creates isolated bulkheads for different resource types.
func NewBulkheadPool() *BulkheadPool {
    return &BulkheadPool{
        database:    NewSemaphore("database", 20),    // Max 20 concurrent DB queries
        externalAPI: NewSemaphore("external-api", 5), // Max 5 concurrent external API calls
        cache:       NewSemaphore("cache", 50),       // Max 50 concurrent cache operations
    }
}
```

## Section 5: Health Check Endpoints

```go
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "sync"
    "time"
)

// HealthChecker provides liveness and readiness endpoints for Kubernetes probes.
type HealthChecker struct {
    checks    map[string]Check
    mu        sync.RWMutex
    startTime time.Time
}

// Check is a function that returns nil on success or an error if the check fails.
type Check func(ctx context.Context) error

// CheckResult holds the result of a single health check.
type CheckResult struct {
    Status    string        `json:"status"`
    Duration  string        `json:"duration_ms"`
    Error     string        `json:"error,omitempty"`
}

// HealthResponse is the JSON response body.
type HealthResponse struct {
    Status   string                  `json:"status"`
    Uptime   string                  `json:"uptime"`
    Checks   map[string]CheckResult  `json:"checks,omitempty"`
    Version  string                  `json:"version"`
}

// NewHealthChecker creates a health checker.
func NewHealthChecker(version string) *HealthChecker {
    return &HealthChecker{
        checks:    make(map[string]Check),
        startTime: time.Now(),
    }
}

// AddCheck registers a named health check.
func (h *HealthChecker) AddCheck(name string, check Check) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.checks[name] = check
}

// LivenessHandler returns 200 OK as long as the process is running.
// Kubernetes restarts the pod if this returns non-200.
// NEVER check downstream dependencies here — only local process health.
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    resp := HealthResponse{
        Status:  "ok",
        Uptime:  time.Since(h.startTime).String(),
        Version: h.version,
    }
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(resp)
}

// ReadinessHandler checks downstream dependencies.
// Kubernetes removes the pod from Service endpoints if this returns non-200.
// Check all required dependencies: database, cache, critical external APIs.
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    h.mu.RLock()
    checks := make(map[string]Check, len(h.checks))
    for k, v := range h.checks {
        checks[k] = v
    }
    h.mu.RUnlock()

    results := make(map[string]CheckResult, len(checks))
    allHealthy := true

    var wg sync.WaitGroup
    var mu sync.Mutex

    for name, check := range checks {
        wg.Add(1)
        go func(n string, c Check) {
            defer wg.Done()
            start := time.Now()
            err := c(ctx)
            result := CheckResult{
                Status:   "ok",
                Duration: fmt.Sprintf("%.2f", float64(time.Since(start).Microseconds())/1000.0),
            }
            if err != nil {
                result.Status = "fail"
                result.Error = err.Error()
                mu.Lock()
                allHealthy = false
                mu.Unlock()
            }
            mu.Lock()
            results[n] = result
            mu.Unlock()
        }(name, check)
    }
    wg.Wait()

    status := "ok"
    httpStatus := http.StatusOK
    if !allHealthy {
        status = "degraded"
        httpStatus = http.StatusServiceUnavailable
    }

    resp := HealthResponse{
        Status:  status,
        Uptime:  time.Since(h.startTime).String(),
        Checks:  results,
        Version: h.version,
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(resp)
}
```

## Section 6: Graceful Shutdown

```go
package server

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

// GracefulServer wraps http.Server with graceful shutdown support.
type GracefulServer struct {
    server          *http.Server
    shutdownTimeout time.Duration
    onShutdown      []func(ctx context.Context) error
}

// NewGracefulServer creates a server configured for zero-downtime shutdown.
func NewGracefulServer(addr string, handler http.Handler) *GracefulServer {
    return &GracefulServer{
        server: &http.Server{
            Addr:              addr,
            Handler:           handler,
            ReadHeaderTimeout: 5 * time.Second,
            ReadTimeout:       30 * time.Second,
            WriteTimeout:      60 * time.Second,
            IdleTimeout:       120 * time.Second,
        },
        shutdownTimeout: 30 * time.Second,
    }
}

// OnShutdown registers a function to call during graceful shutdown.
// Use this to close database connections, flush metrics, etc.
func (s *GracefulServer) OnShutdown(fn func(ctx context.Context) error) {
    s.onShutdown = append(s.onShutdown, fn)
    s.server.RegisterOnShutdown(func() {
        // RegisterOnShutdown runs immediately when shutdown begins
        slog.Info("server shutdown initiated")
    })
}

// Run starts the server and blocks until a shutdown signal is received.
// Returns any error from server startup (not from graceful shutdown).
func (s *GracefulServer) Run() error {
    // Start HTTP server in background goroutine
    serverErr := make(chan error, 1)
    go func() {
        slog.Info("server starting", slog.String("addr", s.server.Addr))
        if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            serverErr <- err
        }
    }()

    // Wait for shutdown signal or server error
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGQUIT)

    select {
    case err := <-serverErr:
        return fmt.Errorf("server error: %w", err)
    case sig := <-sigChan:
        slog.Info("shutdown signal received", slog.String("signal", sig.String()))
    }

    return s.shutdown()
}

// shutdown performs graceful shutdown with the configured timeout.
func (s *GracefulServer) shutdown() error {
    ctx, cancel := context.WithTimeout(context.Background(), s.shutdownTimeout)
    defer cancel()

    slog.Info("starting graceful shutdown",
        slog.Duration("timeout", s.shutdownTimeout),
    )

    // Kubernetes sends SIGTERM 30s before SIGKILL.
    // Add a brief delay to allow load balancers to stop sending traffic
    // before closing the listener. Without this, some requests arrive
    // after the server stops accepting.
    time.Sleep(5 * time.Second)

    // Stop accepting new connections
    if err := s.server.Shutdown(ctx); err != nil {
        return fmt.Errorf("server shutdown failed: %w", err)
    }

    // Run registered shutdown hooks
    for _, fn := range s.onShutdown {
        if err := fn(ctx); err != nil {
            slog.Error("shutdown hook failed", slog.String("error", err.Error()))
        }
    }

    slog.Info("graceful shutdown complete")
    return nil
}
```

## Section 7: Service Discovery with Consul

```go
package discovery

import (
    "context"
    "fmt"
    "log/slog"
    "sync"
    "time"

    consulapi "github.com/hashicorp/consul/api"
)

// ServiceResolver provides service endpoint discovery via Consul.
type ServiceResolver struct {
    client     *consulapi.Client
    cache      map[string][]*consulapi.ServiceEntry
    cacheMu    sync.RWMutex
    cacheTTL   time.Duration
    cacheExpiry map[string]time.Time
}

// NewServiceResolver creates a Consul-backed service resolver.
func NewServiceResolver(consulAddr string) (*ServiceResolver, error) {
    config := consulapi.DefaultConfig()
    config.Address = consulAddr

    client, err := consulapi.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("creating Consul client: %w", err)
    }

    sr := &ServiceResolver{
        client:      client,
        cache:       make(map[string][]*consulapi.ServiceEntry),
        cacheTTL:    10 * time.Second,
        cacheExpiry: make(map[string]time.Time),
    }

    return sr, nil
}

// Resolve returns healthy endpoints for the given service name.
func (sr *ServiceResolver) Resolve(ctx context.Context, serviceName string) ([]*consulapi.ServiceEntry, error) {
    // Check cache
    sr.cacheMu.RLock()
    entries, cached := sr.cache[serviceName]
    expiry, hasExpiry := sr.cacheExpiry[serviceName]
    sr.cacheMu.RUnlock()

    if cached && hasExpiry && time.Now().Before(expiry) {
        return entries, nil
    }

    // Fetch from Consul
    healthEntries, _, err := sr.client.Health().Service(serviceName, "", true, &consulapi.QueryOptions{
        UseCache:          true,
        MaxAge:            sr.cacheTTL,
        RequireConsistent: false,
        Context:           ctx,
    })
    if err != nil {
        // Return stale cache on failure
        if cached {
            slog.WarnContext(ctx, "consul lookup failed, using stale cache",
                slog.String("service", serviceName),
                slog.String("error", err.Error()),
            )
            return entries, nil
        }
        return nil, fmt.Errorf("resolving service %s: %w", serviceName, err)
    }

    if len(healthEntries) == 0 {
        return nil, fmt.Errorf("no healthy instances for service: %s", serviceName)
    }

    // Update cache
    sr.cacheMu.Lock()
    sr.cache[serviceName] = healthEntries
    sr.cacheExpiry[serviceName] = time.Now().Add(sr.cacheTTL)
    sr.cacheMu.Unlock()

    return healthEntries, nil
}
```

## Section 8: Client-Side Load Balancing

```go
package loadbalancing

import (
    "context"
    "math/rand"
    "sync"
    "sync/atomic"
)

// RoundRobinBalancer distributes requests evenly across available endpoints.
type RoundRobinBalancer struct {
    endpoints []string
    counter   atomic.Uint64
}

// NewRoundRobinBalancer creates a round-robin load balancer.
func NewRoundRobinBalancer(endpoints []string) *RoundRobinBalancer {
    return &RoundRobinBalancer{endpoints: endpoints}
}

// Next returns the next endpoint in round-robin order.
func (b *RoundRobinBalancer) Next() string {
    if len(b.endpoints) == 0 {
        return ""
    }
    idx := b.counter.Add(1) % uint64(len(b.endpoints))
    return b.endpoints[idx]
}

// WeightedBalancer distributes requests according to endpoint weights.
// Useful for gradual traffic migration or capacity-proportional routing.
type WeightedBalancer struct {
    endpoints []weightedEndpoint
    total     int
    mu        sync.RWMutex
    rng       *rand.Rand
}

type weightedEndpoint struct {
    address string
    weight  int
}

// NewWeightedBalancer creates a weighted load balancer.
func NewWeightedBalancer(endpoints map[string]int) *WeightedBalancer {
    b := &WeightedBalancer{
        rng: rand.New(rand.NewSource(time.Now().UnixNano())),
    }
    for addr, weight := range endpoints {
        b.endpoints = append(b.endpoints, weightedEndpoint{address: addr, weight: weight})
        b.total += weight
    }
    return b
}

// Next selects an endpoint proportional to its weight.
func (b *WeightedBalancer) Next() string {
    b.mu.RLock()
    defer b.mu.RUnlock()
    if b.total == 0 {
        return ""
    }
    r := b.rng.Intn(b.total)
    for _, ep := range b.endpoints {
        r -= ep.weight
        if r < 0 {
            return ep.address
        }
    }
    return b.endpoints[len(b.endpoints)-1].address
}

// UpdateEndpoints atomically replaces the endpoint list.
// Safe to call concurrently with Next().
func (b *WeightedBalancer) UpdateEndpoints(endpoints map[string]int) {
    newEndpoints := make([]weightedEndpoint, 0, len(endpoints))
    newTotal := 0
    for addr, weight := range endpoints {
        newEndpoints = append(newEndpoints, weightedEndpoint{address: addr, weight: weight})
        newTotal += weight
    }
    b.mu.Lock()
    b.endpoints = newEndpoints
    b.total = newTotal
    b.mu.Unlock()
}
```

## Section 9: Putting It Together — Production Service Template

```go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "time"

    "corp.example.com/payment-service/internal/circuit"
    "corp.example.com/payment-service/internal/health"
    "corp.example.com/payment-service/internal/server"
    "corp.example.com/payment-service/internal/telemetry"
)

func main() {
    // Initialize structured logging
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(logger)

    // Initialize OpenTelemetry
    ctx := context.Background()
    shutdown, err := telemetry.InitTracer(ctx, telemetry.Config{
        ServiceName:    "payment-service",
        ServiceVersion: os.Getenv("VERSION"),
        Environment:    os.Getenv("ENVIRONMENT"),
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:     0.1,
    })
    if err != nil {
        slog.Error("failed to initialize tracer", slog.String("error", err.Error()))
        os.Exit(1)
    }
    defer shutdown(ctx)

    // Initialize database
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        slog.Error("failed to connect to database", slog.String("error", err.Error()))
        os.Exit(1)
    }
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    // Initialize health checker
    hc := health.NewHealthChecker(os.Getenv("VERSION"))
    hc.AddCheck("database", func(ctx context.Context) error {
        return db.PingContext(ctx)
    })
    hc.AddCheck("inventory-service", func(ctx context.Context) error {
        ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
        defer cancel()
        resp, err := http.Get("http://inventory-service.production.svc.cluster.local/health/ready")
        if err != nil {
            return err
        }
        resp.Body.Close()
        if resp.StatusCode != http.StatusOK {
            return fmt.Errorf("inventory service unhealthy: %d", resp.StatusCode)
        }
        return nil
    })

    // Build HTTP handler
    mux := http.NewServeMux()
    mux.HandleFunc("GET /health/live", hc.LivenessHandler)
    mux.HandleFunc("GET /health/ready", hc.ReadinessHandler)
    mux.HandleFunc("POST /api/v1/payments", handlePayment)
    mux.Handle("GET /metrics", metrics.MetricsHandler())

    // Wrap with middleware
    handler := middleware.Chain(
        mux,
        middleware.TracingMiddleware("payment-service"),
        metrics.ObservingHandler,
        middleware.RequestLogger(slog.Default()),
    )

    // Start server with graceful shutdown
    srv := server.NewGracefulServer(
        fmt.Sprintf(":%s", getEnvOrDefault("PORT", "8080")),
        handler,
    )
    srv.OnShutdown(func(ctx context.Context) error {
        slog.Info("closing database connections")
        return db.Close()
    })

    if err := srv.Run(); err != nil {
        slog.Error("server error", slog.String("error", err.Error()))
        os.Exit(1)
    }
}

func getEnvOrDefault(key, defaultValue string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultValue
}
```

## Section 10: go.mod — Full Dependency Set

```go
// go.mod
module corp.example.com/payment-service

go 1.22

require (
    // Circuit breaker
    github.com/sony/gobreaker/v2 v2.0.0

    // Observability
    go.opentelemetry.io/otel v1.27.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.27.0
    go.opentelemetry.io/otel/sdk v1.27.0
    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.52.0
    github.com/prometheus/client_golang v1.19.1

    // Logging
    go.uber.org/zap v1.27.0

    // Service discovery
    github.com/hashicorp/consul/api v1.28.2

    // Utilities
    github.com/google/uuid v1.6.0
)
```

This guide provides the production resilience patterns that Go microservices require at scale. The combination of circuit breakers, jitter-based retries, context deadline propagation, bulkhead isolation, and graceful shutdown ensures that partial failures in one service do not cascade into system-wide outages.
