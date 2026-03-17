---
title: "Kubernetes Resilience Patterns: Retry, Timeout, and Fallback in Microservices"
date: 2029-10-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resilience", "Microservices", "Retry", "Circuit Breaker", "Service Mesh", "Go"]
categories: ["Kubernetes", "Architecture", "Reliability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to resilience patterns in Kubernetes microservices: retry with exponential backoff and jitter, deadline propagation, fallback responses, bulkhead isolation, and when to use service mesh versus application-level resilience."
more_link: "yes"
url: "/kubernetes-resilience-patterns-retry-timeout-fallback-microservices/"
---

Distributed systems fail in partial and unpredictable ways. A service that handles failures gracefully maintains availability when its dependencies misbehave. The resilience patterns — retry, timeout, circuit breaker, fallback, and bulkhead — are the building blocks for achieving this. But each pattern has failure modes of its own, and combining them incorrectly creates cascading failures worse than the original problem. This guide covers each pattern correctly, including the common mistakes.

<!--more-->

# Kubernetes Resilience Patterns: Retry, Timeout, and Fallback in Microservices

## Section 1: Why Partial Failures Are Harder Than Total Failures

A service that is completely down is easy to handle: every call fails immediately, and you fall back to default behavior or return an error to the user. A service that is partially degraded — responding slowly, failing 30% of requests, or returning corrupt data — is harder. Your timeouts must be long enough to allow legitimate slow responses but short enough to fail fast on hung calls. Retry logic must distinguish transient failures (worth retrying) from permanent failures (retrying wastes time).

### The Three Failure Modes of Dependencies

1. **Crash**: Connection refused or DNS lookup failure. Detected immediately.
2. **Hang**: Connection established but server never responds. Detected only by timeout.
3. **Slow**: Server responds, but after a delay that exceeds your SLA. Detected by timeout.

All three require different handling, and timeout configuration is the common thread.

## Section 2: Retry with Exponential Backoff and Jitter

### Why Naive Retry Is Dangerous

```
Client A: request fails → wait 1s → retry
Client B: request fails → wait 1s → retry
Client C: request fails → wait 1s → retry
...
Client N: request fails → wait 1s → retry

Result: All N clients retry simultaneously, creating a "retry storm"
        that overwhelms the recovering server
```

### Exponential Backoff with Full Jitter

The standard solution is exponential backoff with jitter. The delay grows exponentially with each attempt, and a random component spreads retries across time.

```go
package retry

import (
    "context"
    "errors"
    "math"
    "math/rand"
    "time"
)

type Config struct {
    MaxAttempts     int
    InitialDelay    time.Duration
    MaxDelay        time.Duration
    Multiplier      float64
    Jitter          float64   // 0.0 to 1.0; 1.0 = full jitter
    RetryableErrors []error   // Errors that should be retried
    RetryableCodes  []int     // HTTP status codes that should be retried
}

func DefaultConfig() Config {
    return Config{
        MaxAttempts:  5,
        InitialDelay: 100 * time.Millisecond,
        MaxDelay:     30 * time.Second,
        Multiplier:   2.0,
        Jitter:       1.0,  // Full jitter
    }
}

// Do executes fn with retry according to cfg.
// Returns the last error if all attempts fail.
func Do(ctx context.Context, cfg Config, fn func(ctx context.Context) error) error {
    var lastErr error
    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        if err := ctx.Err(); err != nil {
            return err  // Context cancelled/timed out
        }

        lastErr = fn(ctx)
        if lastErr == nil {
            return nil  // Success
        }

        // Check if this error is retryable
        if !isRetryable(lastErr, cfg.RetryableErrors) {
            return lastErr  // Non-retryable, stop immediately
        }

        if attempt == cfg.MaxAttempts-1 {
            break  // Last attempt, don't sleep
        }

        // Calculate delay with exponential backoff and jitter
        delay := calculateDelay(attempt, cfg)
        timer := time.NewTimer(delay)
        select {
        case <-timer.C:
        case <-ctx.Done():
            timer.Stop()
            return ctx.Err()
        }
    }
    return fmt.Errorf("all %d attempts failed, last error: %w", cfg.MaxAttempts, lastErr)
}

func calculateDelay(attempt int, cfg Config) time.Duration {
    // base = InitialDelay * Multiplier^attempt
    base := float64(cfg.InitialDelay) * math.Pow(cfg.Multiplier, float64(attempt))

    // Cap at MaxDelay before applying jitter
    if base > float64(cfg.MaxDelay) {
        base = float64(cfg.MaxDelay)
    }

    // Apply jitter: random value in [0, base * Jitter]
    // Full jitter (Jitter=1.0): uniform random in [0, base]
    // No jitter (Jitter=0.0): deterministic base
    jittered := base * (1 - cfg.Jitter) + base*cfg.Jitter*rand.Float64()

    return time.Duration(jittered)
}

func isRetryable(err error, retryableErrors []error) bool {
    // Always retry on certain error types
    if errors.Is(err, ErrServiceUnavailable) ||
        errors.Is(err, ErrRateLimited) {
        return true
    }

    // Check caller-provided retryable errors
    for _, retryable := range retryableErrors {
        if errors.Is(err, retryable) {
            return true
        }
    }

    return false
}
```

### Retry for HTTP Calls

```go
func callWithRetry(ctx context.Context, client *http.Client, url string) ([]byte, error) {
    cfg := retry.Config{
        MaxAttempts:  4,
        InitialDelay: 200 * time.Millisecond,
        MaxDelay:     5 * time.Second,
        Multiplier:   2.0,
        Jitter:       1.0,
    }

    var body []byte
    err := retry.Do(ctx, cfg, func(ctx context.Context) error {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        if err != nil {
            return err  // Non-retryable (bad URL)
        }

        resp, err := client.Do(req)
        if err != nil {
            // Network error: retryable
            return fmt.Errorf("%w: %v", ErrServiceUnavailable, err)
        }
        defer resp.Body.Close()

        switch {
        case resp.StatusCode == 429:
            // Rate limited: retryable, respect Retry-After header
            if ra := resp.Header.Get("Retry-After"); ra != "" {
                secs, _ := strconv.Atoi(ra)
                time.Sleep(time.Duration(secs) * time.Second)
            }
            return ErrRateLimited
        case resp.StatusCode >= 500:
            // Server error: retryable
            return fmt.Errorf("%w: status %d", ErrServiceUnavailable, resp.StatusCode)
        case resp.StatusCode == 404:
            // Not found: NOT retryable
            return fmt.Errorf("resource not found (404): not retrying")
        case resp.StatusCode >= 400:
            // Client error: NOT retryable (our request is wrong)
            b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
            return fmt.Errorf("client error %d: %s", resp.StatusCode, b)
        }

        body, err = io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
        return err
    })

    return body, err
}
```

### What NOT to Retry

```go
// These errors should NOT be retried:
// - 400 Bad Request (our request is malformed — retrying won't help)
// - 401 Unauthorized (authentication failure — credentials need to be refreshed)
// - 403 Forbidden (authorization failure — permissions need to change)
// - 404 Not Found (resource doesn't exist — won't change)
// - 409 Conflict (optimistic locking failure — need to re-read and merge)
// - Context cancelled (caller gave up — don't retry)
// - context.DeadlineExceeded (overall deadline exceeded)

var nonRetryableStatus = map[int]bool{
    http.StatusBadRequest:           true,
    http.StatusUnauthorized:         true,
    http.StatusForbidden:            true,
    http.StatusNotFound:             true,
    http.StatusConflict:             true,
    http.StatusUnprocessableEntity:  true,
}
```

## Section 3: Deadline Propagation

In a microservices architecture, a user request may traverse many services. Each hop adds latency. If each service sets its own independent timeout without accounting for how much time the overall request has left, a chain of services can each timeout independently, causing cascading failures and making root-cause analysis difficult.

### Context Deadline Propagation

```go
// Handler at the edge of the system: sets the overall budget
func (h *APIHandler) HandleCheckout(w http.ResponseWriter, r *http.Request) {
    // Total budget for this entire request: 5 seconds
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    // This context is passed to ALL downstream calls
    // Each downstream service will fail when this deadline expires
    result, err := h.checkoutService.Process(ctx, parseCheckoutRequest(r))
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            http.Error(w, "request timeout", http.StatusGatewayTimeout)
            return
        }
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    respondJSON(w, http.StatusOK, result)
}

// Internal service: does NOT create a new timeout, uses parent context
func (s *CheckoutService) Process(ctx context.Context, req *CheckoutRequest) (*CheckoutResult, error) {
    // Check remaining budget before expensive operations
    deadline, ok := ctx.Deadline()
    if ok {
        remaining := time.Until(deadline)
        if remaining < 100*time.Millisecond {
            return nil, fmt.Errorf("insufficient time budget: %v: %w", remaining, context.DeadlineExceeded)
        }
    }

    // Propagate context to all sub-calls
    inventory, err := s.inventoryClient.Reserve(ctx, req.Items)
    if err != nil {
        return nil, fmt.Errorf("inventory reservation failed: %w", err)
    }

    payment, err := s.paymentClient.Charge(ctx, req.PaymentInfo)
    if err != nil {
        // Compensate: release inventory reservation
        _, _ = s.inventoryClient.Release(context.Background(), inventory.ReservationID)
        return nil, fmt.Errorf("payment failed: %w", err)
    }

    return &CheckoutResult{OrderID: generateOrderID(), ...}, nil
}
```

### Budget Headers for Cross-Service Propagation

When calling services over HTTP, propagate the remaining deadline as a header:

```go
// Middleware to propagate deadline as a header
func DeadlineMiddleware(next http.RoundTripper) http.RoundTripper {
    return RoundTripFunc(func(req *http.Request) (*http.Response, error) {
        if deadline, ok := req.Context().Deadline(); ok {
            remaining := time.Until(deadline)
            if remaining > 0 {
                req.Header.Set("X-Request-Deadline", deadline.UTC().Format(time.RFC3339Nano))
                req.Header.Set("X-Request-Timeout-Ms", strconv.FormatInt(remaining.Milliseconds(), 10))
            }
        }
        return next.RoundTrip(req)
    })
}

// Server middleware to accept deadline propagation
func AcceptDeadlineMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if deadlineStr := r.Header.Get("X-Request-Deadline"); deadlineStr != "" {
            deadline, err := time.Parse(time.RFC3339Nano, deadlineStr)
            if err == nil && time.Until(deadline) > 0 {
                ctx, cancel := context.WithDeadline(r.Context(), deadline)
                defer cancel()
                r = r.WithContext(ctx)
            }
        }
        next.ServeHTTP(w, r)
    })
}
```

## Section 4: Circuit Breaker

A circuit breaker prevents repeated calls to a failing service. After N consecutive failures, it "opens" and fails all subsequent calls immediately without making network calls. After a timeout period, it allows one probe request to test if the service recovered.

```go
package circuitbreaker

import (
    "errors"
    "sync"
    "time"
)

type State int

const (
    StateClosed   State = iota // Normal operation
    StateOpen                  // Failing; reject all calls
    StateHalfOpen              // Testing recovery; allow one call
)

var (
    ErrCircuitOpen = errors.New("circuit breaker open")
)

type CircuitBreaker struct {
    mu              sync.Mutex
    state           State
    failureCount    int
    successCount    int
    lastFailureTime time.Time

    maxFailures      int
    resetTimeout     time.Duration
    halfOpenMaxCalls int
}

func New(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        maxFailures:      maxFailures,
        resetTimeout:     resetTimeout,
        halfOpenMaxCalls: 1,
    }
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()
    state := cb.currentState()

    if state == StateOpen {
        cb.mu.Unlock()
        return ErrCircuitOpen
    }
    cb.mu.Unlock()

    err := fn()

    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.onFailure()
    } else {
        cb.onSuccess()
    }

    return err
}

func (cb *CircuitBreaker) currentState() State {
    if cb.state == StateOpen {
        // Check if reset timeout has elapsed
        if time.Since(cb.lastFailureTime) > cb.resetTimeout {
            cb.state = StateHalfOpen
            cb.failureCount = 0
            cb.successCount = 0
        }
    }
    return cb.state
}

func (cb *CircuitBreaker) onFailure() {
    cb.failureCount++
    cb.lastFailureTime = time.Now()
    cb.successCount = 0

    if cb.failureCount >= cb.maxFailures {
        cb.state = StateOpen
    }
}

func (cb *CircuitBreaker) onSuccess() {
    cb.successCount++
    cb.failureCount = 0
    if cb.state == StateHalfOpen {
        cb.state = StateClosed  // Service recovered
    }
}

func (cb *CircuitBreaker) State() State {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    return cb.currentState()
}
```

### Circuit Breaker with Prometheus Metrics

```go
type InstrumentedCircuitBreaker struct {
    cb           *CircuitBreaker
    name         string
    stateGauge   prometheus.Gauge
    callsTotal   *prometheus.CounterVec
}

func NewInstrumented(name string, maxFailures int, resetTimeout time.Duration) *InstrumentedCircuitBreaker {
    icb := &InstrumentedCircuitBreaker{
        cb:   New(maxFailures, resetTimeout),
        name: name,
        stateGauge: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: "circuit_breaker_state",
            Help: "State of the circuit breaker (0=closed, 1=open, 2=half-open)",
            ConstLabels: prometheus.Labels{"name": name},
        }),
        callsTotal: prometheus.NewCounterVec(
            prometheus.CounterOpts{
                Name: "circuit_breaker_calls_total",
                Help: "Total calls through the circuit breaker",
                ConstLabels: prometheus.Labels{"name": name},
            },
            []string{"result"},  // "success", "failure", "rejected"
        ),
    }
    prometheus.MustRegister(icb.stateGauge, icb.callsTotal)
    return icb
}

func (icb *InstrumentedCircuitBreaker) Execute(fn func() error) error {
    err := icb.cb.Execute(fn)
    switch {
    case err == nil:
        icb.callsTotal.WithLabelValues("success").Inc()
    case errors.Is(err, ErrCircuitOpen):
        icb.callsTotal.WithLabelValues("rejected").Inc()
    default:
        icb.callsTotal.WithLabelValues("failure").Inc()
    }
    icb.stateGauge.Set(float64(icb.cb.State()))
    return err
}
```

## Section 5: Fallback Responses

A fallback provides a degraded-but-functional response when the primary call fails. The quality of fallback depends on what your service does.

### Static Fallback

```go
func (s *ProductService) GetRecommendations(ctx context.Context, userID string) ([]Product, error) {
    products, err := s.recommendationEngine.GetPersonalized(ctx, userID)
    if err != nil {
        // Primary failed: return static top-sellers as fallback
        log.Printf("recommendation engine unavailable, using static fallback: %v", err)
        return s.getStaticTopSellers(), nil  // Never returns error
    }
    return products, nil
}

func (s *ProductService) getStaticTopSellers() []Product {
    // Pre-loaded at startup, always available
    return s.staticTopSellers
}
```

### Cache Fallback (Stale-While-Revalidate)

```go
type CacheAwareClient struct {
    upstream http.Client
    cache    *cache.TTLCache
    mu       sync.RWMutex
}

func (c *CacheAwareClient) Get(ctx context.Context, url string) ([]byte, error) {
    // Try upstream first
    body, err := c.fetchFromUpstream(ctx, url)
    if err == nil {
        c.cache.Set(url, body, 5*time.Minute)  // Refresh cache on success
        return body, nil
    }

    // Upstream failed: try stale cache
    if cached, ok := c.cache.GetStale(url); ok {
        log.Printf("upstream unavailable, serving stale cache for %s: %v", url, err)
        return cached, nil  // Return stale data rather than error
    }

    // No cache available: return the error
    return nil, fmt.Errorf("upstream failed and no cache available: %w", err)
}
```

### Partial Fallback

```go
type OrderSummary struct {
    Order          *Order
    CustomerName   string  // From user service (may be empty on fallback)
    ProductDetails []Product  // From product service (may be empty on fallback)
    ShippingStatus string  // From shipping service (may be empty on fallback)
}

func (s *OrderService) GetSummary(ctx context.Context, orderID string) (*OrderSummary, error) {
    order, err := s.orderRepo.Get(ctx, orderID)
    if err != nil {
        return nil, err  // Core data: non-negotiable, no fallback
    }

    summary := &OrderSummary{Order: order}

    // Enrich with non-critical data using goroutines + fallbacks
    var wg sync.WaitGroup
    var mu sync.Mutex

    wg.Add(3)
    go func() {
        defer wg.Done()
        customer, err := s.userClient.GetName(ctx, order.CustomerID)
        mu.Lock()
        defer mu.Unlock()
        if err != nil {
            summary.CustomerName = "Unknown Customer"  // Fallback
        } else {
            summary.CustomerName = customer.Name
        }
    }()

    go func() {
        defer wg.Done()
        products, err := s.productClient.GetBatch(ctx, order.ProductIDs)
        mu.Lock()
        defer mu.Unlock()
        if err != nil {
            // Use IDs as names — degraded but functional
            for _, id := range order.ProductIDs {
                summary.ProductDetails = append(summary.ProductDetails, Product{ID: id, Name: id})
            }
        } else {
            summary.ProductDetails = products
        }
    }()

    go func() {
        defer wg.Done()
        status, err := s.shippingClient.GetStatus(ctx, order.ShipmentID)
        mu.Lock()
        defer mu.Unlock()
        if err != nil {
            summary.ShippingStatus = "Status unavailable"  // Fallback
        } else {
            summary.ShippingStatus = status
        }
    }()

    wg.Wait()
    return summary, nil
}
```

## Section 6: Bulkhead Isolation

The bulkhead pattern limits the resources (goroutines, connections, queue depth) allocated to each upstream dependency, preventing one slow dependency from consuming all available goroutines.

### Semaphore-Based Bulkhead

```go
package bulkhead

import (
    "context"
    "errors"
)

var ErrBulkheadFull = errors.New("bulkhead capacity exceeded")

type Bulkhead struct {
    sem chan struct{}
}

func New(maxConcurrency int) *Bulkhead {
    return &Bulkhead{
        sem: make(chan struct{}, maxConcurrency),
    }
}

func (b *Bulkhead) Execute(ctx context.Context, fn func() error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return fn()
    case <-ctx.Done():
        return ctx.Err()
    default:
        return ErrBulkheadFull  // Don't wait — fail fast
    }
}

func (b *Bulkhead) ExecuteWithWait(ctx context.Context, fn func() error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return fn()
    case <-ctx.Done():
        return ctx.Err()
    // No default — wait for a slot to become available (or context to cancel)
    }
}
```

### Multiple Bulkheads for Different Dependencies

```go
type ServiceClients struct {
    // Each dependency gets its own goroutine pool
    inventoryBulkhead *bulkhead.Bulkhead
    paymentBulkhead   *bulkhead.Bulkhead
    shippingBulkhead  *bulkhead.Bulkhead
}

func NewServiceClients() *ServiceClients {
    return &ServiceClients{
        // Inventory is fast; allow many concurrent calls
        inventoryBulkhead: bulkhead.New(50),
        // Payment is slow and critical; limit concurrency to avoid overloading
        paymentBulkhead: bulkhead.New(20),
        // Shipping is best-effort; strict limit
        shippingBulkhead: bulkhead.New(10),
    }
}
```

## Section 7: Service Mesh vs. Application-Level Resilience

Service meshes (Istio, Linkerd) can implement retry, timeout, and circuit breaking at the proxy layer, without application code changes. This raises the question: should you implement resilience in the application or the mesh?

### Service Mesh Resilience (Istio)

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: product-service
spec:
  hosts:
    - product-service
  http:
    - timeout: 3s
      retries:
        attempts: 3
        perTryTimeout: 1s
        retryOn: "connect-failure,refused-stream,unavailable,cancelled,5xx"
      route:
        - destination:
            host: product-service
            port:
              number: 8080
```

### When to Use Service Mesh Resilience

- Cross-cutting concerns: applies consistently to all services without code changes.
- Language-agnostic: works for services in any language.
- Operational control: operations team can tune retry/timeout without application deployments.
- Observability: mesh provides per-call telemetry automatically.

### When Application-Level Resilience Is Still Required

- **Context propagation**: The mesh cannot propagate a context deadline from one call to another. Your application must thread the context through.
- **Business logic fallbacks**: A mesh cannot return a cached or default response — only your application knows what a meaningful fallback looks like.
- **Retry idempotency**: The mesh retries blindly. Your application must ensure retried operations are safe (idempotent) or explicitly disable mesh retries for non-idempotent operations.
- **Bulkhead isolation**: Goroutine-level resource isolation cannot be implemented at the proxy layer.

### The Correct Layering

```
Application Layer:
  - Deadline propagation (context threading)
  - Fallback responses (business logic)
  - Bulkhead isolation (goroutine limits)
  - Retry for non-idempotent operations (application controls)

Service Mesh Layer:
  - Retry for idempotent operations (GET, PUT, DELETE)
  - Connection-level timeouts
  - mTLS
  - Load balancing and circuit breaking
  - Observability (traces, metrics per route)
```

The key rule: **do not configure retry in both layers for the same operation**. If both the application and the mesh retry a failing call, you get exponential retry amplification:

```
Application retries: 3 attempts
Mesh retries: 3 attempts per call
Total upstream calls per user request: 3 × 3 = 9 attempts
```

Disable mesh-level retries for operations that your application already retries, or disable application retries and rely entirely on the mesh.

## Section 8: Alerting on Resilience Pattern Metrics

```yaml
# PrometheusRule for resilience pattern health
groups:
  - name: resilience.patterns
    rules:
      - alert: CircuitBreakerOpen
        expr: circuit_breaker_state{} == 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker {{ $labels.name }} is open"
          description: "The circuit breaker has been open for 2+ minutes, indicating sustained dependency failure"

      - alert: HighRetryRate
        expr: |
          rate(http_client_retries_total[5m])
          / rate(http_client_requests_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High retry rate for {{ $labels.upstream }}"

      - alert: BulkheadSaturation
        expr: bulkhead_rejected_total > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Bulkhead {{ $labels.name }} is rejecting requests"
          description: "The bulkhead capacity of {{ $labels.max_concurrency }} is insufficient for current load"

      - alert: FallbackActivated
        expr: rate(fallback_activations_total[5m]) > 0
        for: 5m
        labels:
          severity: info
        annotations:
          summary: "Fallback responses are being served for {{ $labels.service }}"
```

## Section 9: Testing Resilience Patterns

```go
func TestRetryExhaustion(t *testing.T) {
    callCount := 0
    cfg := retry.Config{
        MaxAttempts:  3,
        InitialDelay: 1 * time.Millisecond,  // Fast for tests
        MaxDelay:     5 * time.Millisecond,
        Multiplier:   2.0,
        Jitter:       0,  // No jitter in tests (deterministic)
    }

    err := retry.Do(context.Background(), cfg, func(ctx context.Context) error {
        callCount++
        return ErrServiceUnavailable
    })

    require.Error(t, err)
    assert.Equal(t, 3, callCount, "should have attempted exactly 3 times")
    assert.Contains(t, err.Error(), "all 3 attempts failed")
}

func TestCircuitBreaker_OpenAfterFailures(t *testing.T) {
    cb := circuitbreaker.New(3, 1*time.Second)

    // First 3 failures should open the circuit
    for i := 0; i < 3; i++ {
        err := cb.Execute(func() error { return errors.New("service down") })
        require.Error(t, err)
    }

    // Now the circuit should be open
    err := cb.Execute(func() error { return nil })  // fn won't be called
    assert.ErrorIs(t, err, circuitbreaker.ErrCircuitOpen)

    // After reset timeout, it should allow one probe
    time.Sleep(1100 * time.Millisecond)
    err = cb.Execute(func() error { return nil })  // Success
    assert.NoError(t, err)
    assert.Equal(t, circuitbreaker.StateClosed, cb.State())
}
```

## Section 10: Production Configuration Template

```go
// resilience.go — complete resilience configuration for a microservice
package resilience

import (
    "context"
    "time"
)

type ServiceConfig struct {
    // Per-dependency retry configuration
    Retry map[string]retry.Config

    // Per-dependency circuit breaker
    CircuitBreaker map[string]CBConfig

    // Per-dependency bulkhead
    Bulkhead map[string]BHConfig

    // Per-call timeout (added to outbound requests)
    CallTimeout map[string]time.Duration
}

func ProductionConfig() ServiceConfig {
    return ServiceConfig{
        Retry: map[string]retry.Config{
            "inventory-service": {
                MaxAttempts:  3,
                InitialDelay: 100 * time.Millisecond,
                MaxDelay:     2 * time.Second,
                Multiplier:   2.0,
                Jitter:       1.0,
            },
            "user-service": {
                MaxAttempts:  2,
                InitialDelay: 50 * time.Millisecond,
                MaxDelay:     500 * time.Millisecond,
                Multiplier:   2.0,
                Jitter:       1.0,
            },
            // Payment is NOT retried (idempotency handled by mesh)
        },

        CircuitBreaker: map[string]CBConfig{
            "inventory-service": {MaxFailures: 5, ResetTimeout: 30 * time.Second},
            "payment-service":   {MaxFailures: 3, ResetTimeout: 60 * time.Second},
            "user-service":      {MaxFailures: 10, ResetTimeout: 15 * time.Second},
        },

        Bulkhead: map[string]BHConfig{
            "inventory-service": {MaxConcurrency: 50},
            "payment-service":   {MaxConcurrency: 20},
            "user-service":      {MaxConcurrency: 100},
        },

        CallTimeout: map[string]time.Duration{
            "inventory-service": 500 * time.Millisecond,
            "payment-service":   3 * time.Second,
            "user-service":      200 * time.Millisecond,
        },
    }
}
```

Resilience patterns are not a substitute for fixing broken dependencies — they are a mechanism for limiting blast radius while the broken dependency is being repaired. The goal is always to make failures visible through metrics and alerts, degrade gracefully rather than cascade, and recover automatically when the dependency comes back.
