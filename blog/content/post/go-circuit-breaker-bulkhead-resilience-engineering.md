---
title: "Go Circuit Breaker and Bulkhead Patterns: Resilience Engineering"
date: 2029-05-22T00:00:00-05:00
draft: false
tags: ["Go", "Circuit Breaker", "Resilience", "Bulkhead", "golang", "Microservices", "Distributed Systems"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to resilience engineering in Go covering sony/gobreaker, uber-go/ratelimit, bulkhead patterns with semaphores, hystrix-go, service mesh integration, and chaos testing strategies."
more_link: "yes"
url: "/go-circuit-breaker-bulkhead-resilience-engineering/"
---

Distributed systems fail. Networks partition, dependencies become slow, and cascading failures can take down an entire platform when individual services degrade. Circuit breakers and bulkheads are two of the most important resilience patterns for preventing cascading failures — and Go's concurrency primitives make them particularly clean to implement. This guide covers the full spectrum from `sony/gobreaker` and `hystrix-go` to manual semaphore-based bulkheads, integration with service meshes, and testing your resilience patterns against chaos.

<!--more-->

# Go Circuit Breaker and Bulkhead Patterns: Resilience Engineering

## The Problem: Cascading Failures

Without resilience patterns, a single slow dependency causes cascading failure:

```
Without circuit breakers:
UserService ──► PaymentService (500ms timeout, 99% error rate)
     │
     └── All goroutines blocked waiting for PaymentService
         └── UserService becomes unresponsive
             └── APIGateway requests queue up
                 └── APIGateway OOM killed
                     └── Total outage
```

```
With circuit breakers:
UserService ──► Circuit Breaker ──► PaymentService (failing)
     │              │
     │         OPEN (fast fail)
     │              │
     └── Returns cached/fallback response immediately
         └── UserService stays responsive
             └── Other services unaffected
```

## Section 1: Sony/Gobreaker — Production-Ready Circuit Breaker

`sony/gobreaker` is the most widely used circuit breaker library in Go due to its simplicity and correctness.

### Installation

```bash
go get github.com/sony/gobreaker
```

### Circuit Breaker States

```
        ┌─────────────────────────────────────────────────┐
        │                                                 │
    CLOSED ──(failures exceed threshold)──► OPEN          │
       ▲                                    │             │
       │                                    │ (after      │
       │                             timeout│  reset      │
       │                               elapses)           │
       │                                    ▼             │
       └──────(success)──────────── HALF-OPEN             │
                                      │                   │
                                      └──(failure)──► OPEN│
                                                          │
        ─────────────────────────────────────────────────┘
```

### Basic Usage

```go
package resilience

import (
    "errors"
    "fmt"
    "time"

    "github.com/sony/gobreaker"
)

// NewPaymentCircuitBreaker creates a circuit breaker for payment service calls
func NewPaymentCircuitBreaker() *gobreaker.CircuitBreaker {
    return gobreaker.NewCircuitBreaker(gobreaker.Settings{
        Name: "payment-service",

        // Move to OPEN after 5 consecutive failures
        // OR if failure rate exceeds 60% over 10 requests
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.ConsecutiveFailures > 5 ||
                (counts.Requests >= 10 && failureRatio >= 0.6)
        },

        // How long to stay OPEN before allowing a test request
        Timeout: 30 * time.Second,

        // How many successful requests in HALF-OPEN before closing
        MaxRequests: 3,

        // Called on state transitions — use for metrics/alerting
        OnStateChange: func(name string, from, to gobreaker.State) {
            log.Printf("Circuit breaker %s: %s → %s", name, from, to)
            // Emit Prometheus counter
            circuitBreakerStateChanges.WithLabelValues(name, from.String(), to.String()).Inc()
        },

        // IsSuccessful allows customizing what counts as a success
        // By default, nil error = success
        IsSuccessful: func(err error) bool {
            if err == nil {
                return true
            }
            // Don't count 4xx errors as circuit-breaker failures
            // (those are caller errors, not service failures)
            var httpErr *HTTPError
            if errors.As(err, &httpErr) {
                return httpErr.StatusCode < 500
            }
            return false
        },
    })
}

// PaymentClient wraps payment service calls with circuit breaker
type PaymentClient struct {
    cb   *gobreaker.CircuitBreaker
    http *http.Client
    url  string
}

func NewPaymentClient(url string) *PaymentClient {
    return &PaymentClient{
        cb:   NewPaymentCircuitBreaker(),
        http: &http.Client{Timeout: 5 * time.Second},
        url:  url,
    }
}

func (c *PaymentClient) ProcessPayment(ctx context.Context, req PaymentRequest) (*PaymentResponse, error) {
    result, err := c.cb.Execute(func() (interface{}, error) {
        return c.doProcessPayment(ctx, req)
    })

    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            // Circuit is open — return fast failure
            return nil, fmt.Errorf("payment service unavailable (circuit open): %w", ErrServiceUnavailable)
        }
        if errors.Is(err, gobreaker.ErrTooManyRequests) {
            // Half-open state, too many concurrent test requests
            return nil, fmt.Errorf("payment service circuit half-open, request rejected: %w", ErrServiceUnavailable)
        }
        return nil, fmt.Errorf("payment service error: %w", err)
    }

    return result.(*PaymentResponse), nil
}

func (c *PaymentClient) doProcessPayment(ctx context.Context, req PaymentRequest) (*PaymentResponse, error) {
    body, err := json.Marshal(req)
    if err != nil {
        return nil, fmt.Errorf("marshaling request: %w", err)
    }

    httpReq, err := http.NewRequestWithContext(ctx, "POST", c.url+"/payments", bytes.NewReader(body))
    if err != nil {
        return nil, err
    }
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.http.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("http request: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 500 {
        return nil, &HTTPError{StatusCode: resp.StatusCode}
    }

    var result PaymentResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    return &result, nil
}
```

### Circuit Breaker with Fallback Pattern

```go
type PaymentService struct {
    primary   *PaymentClient
    fallback  *FallbackPaymentClient
    cache     *PaymentCache
}

func (s *PaymentService) ProcessPayment(ctx context.Context, req PaymentRequest) (*PaymentResponse, error) {
    // Try primary service
    result, err := s.primary.ProcessPayment(ctx, req)
    if err == nil {
        // Cache successful result
        s.cache.Set(req.ID, result, 5*time.Minute)
        return result, nil
    }

    if errors.Is(err, ErrServiceUnavailable) {
        // Circuit is open — try fallback
        log.Warn("Payment service circuit open, trying fallback", "request_id", req.ID)

        // Try to use cached result for idempotent requests
        if cached, ok := s.cache.Get(req.ID); ok {
            return cached, nil
        }

        // Use degraded fallback service
        return s.fallback.ProcessPayment(ctx, req)
    }

    return nil, err
}
```

## Section 2: Hystrix-Go — Full Hystrix Feature Set

`hystrix-go` provides a more complete implementation based on Netflix's Hystrix, including concurrent request limits per command.

### Installation

```bash
go get github.com/afex/hystrix-go/hystrix
```

### Configuration

```go
package resilience

import (
    "github.com/afex/hystrix-go/hystrix"
)

func ConfigureHystrix() {
    // Configure per-command settings
    hystrix.ConfigureCommand("payment-service", hystrix.CommandConfig{
        Timeout:               5000, // ms
        MaxConcurrentRequests: 100,
        ErrorPercentThreshold: 50,   // Open circuit when 50% of requests fail

        // Minimum number of requests before evaluating error %
        RequestVolumeThreshold: 20,

        // How long to wait before allowing test request when OPEN
        SleepWindow: 5000, // ms
    })

    hystrix.ConfigureCommand("user-service", hystrix.CommandConfig{
        Timeout:               2000,
        MaxConcurrentRequests: 200,
        ErrorPercentThreshold: 25, // More sensitive — user service must be reliable
        RequestVolumeThreshold: 10,
        SleepWindow: 10000,
    })

    hystrix.ConfigureCommand("inventory-service", hystrix.CommandConfig{
        Timeout:               3000,
        MaxConcurrentRequests: 50,
        ErrorPercentThreshold: 60, // More tolerant — inventory can be eventually consistent
        RequestVolumeThreshold: 30,
        SleepWindow: 15000,
    })
}
```

### Hystrix Command Execution

```go
func (c *InventoryClient) GetStock(ctx context.Context, productID string) (*StockLevel, error) {
    var result *StockLevel

    // Run executes command with circuit breaker + fallback
    err := hystrix.Do("inventory-service", func() error {
        resp, err := c.fetchStock(ctx, productID)
        if err != nil {
            return err
        }
        result = resp
        return nil
    }, func(err error) error {
        // Fallback function — called when circuit is open or command fails
        log.Warn("Inventory service failed, using cached stock",
            "product_id", productID,
            "error", err,
        )

        // Return cached/default value
        cached, ok := c.cache.GetStock(productID)
        if ok {
            result = cached
            return nil
        }

        // Signal that stock level is unknown but don't fail hard
        result = &StockLevel{
            ProductID: productID,
            Level:     -1, // Unknown
            Source:    "fallback",
        }
        return nil
    })

    if err != nil {
        return nil, err
    }
    return result, nil
}

// GoC — asynchronous execution with channels
func (c *OrderService) FetchOrderDataAsync(ctx context.Context, orderID string) (*OrderData, error) {
    outputChan, errorChan := hystrix.GoC(ctx, "order-service", func(ctx context.Context) (interface{}, error) {
        return c.fetchOrderData(ctx, orderID)
    }, func(ctx context.Context, err error) (interface{}, error) {
        return c.fetchCachedOrder(ctx, orderID)
    })

    select {
    case result := <-outputChan:
        return result.(*OrderData), nil
    case err := <-errorChan:
        return nil, err
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}
```

### Hystrix Dashboard and Metrics

```go
package main

import (
    "net/http"

    "github.com/afex/hystrix-go/hystrix/metric_collector"
    "github.com/afex/hystrix-go/hystrix"
    "github.com/afex/hystrix-go/plugins"
)

func setupHystrixMonitoring() {
    // Export metrics to Prometheus
    collector := plugins.InitializePrometheusCollector(plugins.PrometheusCollectorConfig{
        Namespace: "myapp",
    })
    metricCollector.Registry.Register(collector.NewPrometheusCollector)

    // Or stream to hystrix-dashboard
    hystrixStreamHandler := hystrix.NewStreamHandler()
    hystrixStreamHandler.Start()
    http.Handle("/hystrix.stream", hystrixStreamHandler)
}
```

## Section 3: Bulkhead Pattern with Semaphores

The bulkhead pattern limits concurrent requests to a dependency to prevent resource exhaustion. Like a ship's bulkhead compartments that prevent a single breach from sinking the whole vessel, bulkheads in software prevent one slow dependency from consuming all threads/goroutines.

### Semaphore-Based Bulkhead

```go
package bulkhead

import (
    "context"
    "errors"
    "fmt"
    "sync"
    "sync/atomic"
    "time"
)

var ErrBulkheadFull = errors.New("bulkhead capacity exceeded")

// Bulkhead limits concurrent access to a resource
type Bulkhead struct {
    name      string
    sem       chan struct{}
    active    atomic.Int64
    rejected  atomic.Int64
    totalWait atomic.Int64
    mu        sync.Mutex
}

// NewBulkhead creates a bulkhead with the given concurrency limit
func NewBulkhead(name string, maxConcurrent int) *Bulkhead {
    return &Bulkhead{
        name: name,
        sem:  make(chan struct{}, maxConcurrent),
    }
}

// Execute runs fn if capacity is available, otherwise returns ErrBulkheadFull
func (b *Bulkhead) Execute(ctx context.Context, fn func() error) error {
    return b.ExecuteWithTimeout(ctx, 0, fn)
}

// ExecuteWithTimeout waits up to waitTimeout for capacity
func (b *Bulkhead) ExecuteWithTimeout(ctx context.Context, waitTimeout time.Duration, fn func() error) error {
    start := time.Now()

    var waitCtx context.Context
    var cancel context.CancelFunc

    if waitTimeout > 0 {
        waitCtx, cancel = context.WithTimeout(ctx, waitTimeout)
        defer cancel()
    } else {
        waitCtx = ctx
    }

    // Try to acquire semaphore
    select {
    case b.sem <- struct{}{}:
        // Acquired capacity
    case <-waitCtx.Done():
        b.rejected.Add(1)
        if waitCtx.Err() == context.DeadlineExceeded {
            return fmt.Errorf("%w: %s", ErrBulkheadFull, b.name)
        }
        return waitCtx.Err()
    }

    b.active.Add(1)
    b.totalWait.Add(time.Since(start).Milliseconds())
    defer func() {
        <-b.sem
        b.active.Add(-1)
    }()

    return fn()
}

// Stats returns current bulkhead statistics
type BulkheadStats struct {
    Name     string
    Active   int64
    Capacity int
    Rejected int64
    AvgWaitMs float64
}

func (b *Bulkhead) Stats() BulkheadStats {
    rejected := b.rejected.Load()
    active := b.active.Load()
    return BulkheadStats{
        Name:     b.name,
        Active:   active,
        Capacity: cap(b.sem),
        Rejected: rejected,
    }
}
```

### Multiple Bulkheads for Dependency Isolation

```go
type OrderService struct {
    paymentBulkhead   *Bulkhead
    inventoryBulkhead *Bulkhead
    notifyBulkhead    *Bulkhead

    paymentCB   *gobreaker.CircuitBreaker
    inventoryCB *gobreaker.CircuitBreaker
}

func NewOrderService() *OrderService {
    return &OrderService{
        // Payment is critical — allow high concurrency, fail fast
        paymentBulkhead: NewBulkhead("payment", 50),
        // Inventory can be slower — smaller bulkhead
        inventoryBulkhead: NewBulkhead("inventory", 20),
        // Notifications are async — very limited bulkhead
        notifyBulkhead: NewBulkhead("notifications", 10),

        paymentCB:   NewPaymentCircuitBreaker(),
        inventoryCB: NewInventoryCircuitBreaker(),
    }
}

func (s *OrderService) CreateOrder(ctx context.Context, order *Order) error {
    // Run payment and inventory checks in parallel, each in their own bulkhead
    g, gctx := errgroup.WithContext(ctx)

    var paymentResult *PaymentResult
    var stockResult *StockResult

    g.Go(func() error {
        return s.paymentBulkhead.ExecuteWithTimeout(gctx, 2*time.Second, func() error {
            result, err := s.paymentCB.Execute(func() (interface{}, error) {
                return s.processPayment(gctx, order)
            })
            if err != nil {
                return err
            }
            paymentResult = result.(*PaymentResult)
            return nil
        })
    })

    g.Go(func() error {
        return s.inventoryBulkhead.ExecuteWithTimeout(gctx, 1*time.Second, func() error {
            result, err := s.inventoryCB.Execute(func() (interface{}, error) {
                return s.checkStock(gctx, order)
            })
            if err != nil {
                return err
            }
            stockResult = result.(*StockResult)
            return nil
        })
    })

    if err := g.Wait(); err != nil {
        return fmt.Errorf("order creation failed: %w", err)
    }

    // Save order
    if err := s.saveOrder(ctx, order, paymentResult, stockResult); err != nil {
        return err
    }

    // Fire-and-forget notification in its own bulkhead
    go func() {
        notifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()

        err := s.notifyBulkhead.Execute(notifyCtx, func() error {
            return s.sendOrderConfirmation(notifyCtx, order)
        })
        if err != nil {
            log.Warn("Failed to send order confirmation",
                "order_id", order.ID,
                "error", err,
            )
        }
    }()

    return nil
}
```

### Worker Pool Bulkhead

For workloads that need queuing rather than immediate rejection:

```go
package bulkhead

import (
    "context"
    "sync"
)

// WorkerPool is a bulkhead that queues work up to maxQueue depth
type WorkerPool struct {
    name     string
    workers  int
    queue    chan func()
    wg       sync.WaitGroup
}

func NewWorkerPool(name string, workers, maxQueue int) *WorkerPool {
    wp := &WorkerPool{
        name:    name,
        workers: workers,
        queue:   make(chan func(), maxQueue),
    }
    wp.start()
    return wp
}

func (wp *WorkerPool) start() {
    for i := 0; i < wp.workers; i++ {
        wp.wg.Add(1)
        go func() {
            defer wp.wg.Done()
            for fn := range wp.queue {
                fn()
            }
        }()
    }
}

// Submit adds work to the pool, blocks if queue is full
func (wp *WorkerPool) Submit(ctx context.Context, fn func()) error {
    select {
    case wp.queue <- fn:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    default:
        return fmt.Errorf("%w: worker pool %s queue full", ErrBulkheadFull, wp.name)
    }
}

func (wp *WorkerPool) Shutdown() {
    close(wp.queue)
    wp.wg.Wait()
}
```

## Section 4: Uber-Go/Ratelimit — Token Bucket Rate Limiting

```bash
go get go.uber.org/ratelimit
```

```go
package resilience

import (
    "context"
    "time"

    "go.uber.org/ratelimit"
)

// RateLimitedClient wraps an HTTP client with rate limiting
type RateLimitedClient struct {
    rl     ratelimit.Limiter
    client *http.Client
}

func NewRateLimitedClient(rps int) *RateLimitedClient {
    return &RateLimitedClient{
        // Smooth rate limiter — allows burst naturally
        rl: ratelimit.New(rps, ratelimit.WithoutSlack),
        client: &http.Client{Timeout: 5 * time.Second},
    }
}

func (c *RateLimitedClient) Do(req *http.Request) (*http.Response, error) {
    // Block until rate allows this request
    c.rl.Take()
    return c.client.Do(req)
}

// Context-aware rate limiting
type ContextualRateLimiter struct {
    rl ratelimit.Limiter
}

func (r *ContextualRateLimiter) Wait(ctx context.Context) error {
    done := make(chan struct{})
    go func() {
        r.rl.Take()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

### Combining Circuit Breaker + Bulkhead + Rate Limiter

```go
// ResilienceChain applies multiple resilience patterns in order
type ResilienceChain struct {
    rateLimiter  *ContextualRateLimiter
    bulkhead     *Bulkhead
    circuitBreaker *gobreaker.CircuitBreaker
}

func (c *ResilienceChain) Execute(ctx context.Context, fn func() (interface{}, error)) (interface{}, error) {
    // 1. Check rate limit first (least expensive check)
    if err := c.rateLimiter.Wait(ctx); err != nil {
        return nil, fmt.Errorf("rate limit: %w", err)
    }

    // 2. Check bulkhead capacity
    var result interface{}
    err := c.bulkhead.ExecuteWithTimeout(ctx, 100*time.Millisecond, func() error {
        // 3. Check circuit breaker
        var cbErr error
        result, cbErr = c.circuitBreaker.Execute(func() (interface{}, error) {
            return fn()
        })
        return cbErr
    })

    return result, err
}
```

## Section 5: Integration with Service Mesh

When using Istio or Linkerd, resilience patterns can be applied at the mesh layer, complementing application-level patterns.

### Istio Circuit Breaking

```yaml
# DestinationRule configures circuit breaking at the mesh level
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-service-cb
  namespace: production
spec:
  host: payment-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        maxRequestsPerConnection: 10
    outlierDetection:
      # Circuit breaking thresholds
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 50
```

### Application vs Mesh Layer

The two layers serve different purposes:

```go
// Application circuit breaker: fine-grained control with fallbacks
func (s *Service) callPayment(ctx context.Context, req PaymentRequest) (*PaymentResponse, error) {
    result, err := s.paymentCB.Execute(func() (interface{}, error) {
        return s.paymentClient.Process(ctx, req)
    })
    if errors.Is(err, gobreaker.ErrOpenState) {
        // Application-level fallback: return from cache
        return s.getLastPaymentStatus(ctx, req.OrderID)
    }
    if err != nil {
        return nil, err
    }
    return result.(*PaymentResponse), nil
}

// Mesh circuit breaker: coarse-grained protection at network level
// Handled by Istio DestinationRule — no code needed
// Protects against connection storms even when application CB is open
```

### Tracing Resilience Events

```go
package resilience

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

// TracedCircuitBreaker wraps gobreaker with OpenTelemetry tracing
type TracedCircuitBreaker struct {
    cb     *gobreaker.CircuitBreaker
    tracer trace.Tracer
}

func (t *TracedCircuitBreaker) Execute(ctx context.Context, name string, fn func() (interface{}, error)) (interface{}, error) {
    ctx, span := t.tracer.Start(ctx, "circuit_breaker.execute",
        trace.WithAttributes(
            attribute.String("cb.name", t.cb.Name()),
            attribute.String("cb.state", t.cb.State().String()),
        ),
    )
    defer span.End()

    result, err := t.cb.Execute(func() (interface{}, error) {
        return fn()
    })

    if err != nil {
        span.SetAttributes(attribute.String("cb.result", "error"))
        if errors.Is(err, gobreaker.ErrOpenState) {
            span.SetAttributes(attribute.Bool("cb.open", true))
        }
    } else {
        span.SetAttributes(attribute.String("cb.result", "success"))
    }

    return result, err
}
```

## Section 6: Prometheus Metrics for Resilience Patterns

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    CircuitBreakerState = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "circuit_breaker_state",
        Help: "Current circuit breaker state (0=closed, 1=half-open, 2=open)",
    }, []string{"name"})

    CircuitBreakerRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "circuit_breaker_requests_total",
        Help: "Total circuit breaker requests by result",
    }, []string{"name", "result"})

    BulkheadActive = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "bulkhead_active_requests",
        Help: "Current active requests in bulkhead",
    }, []string{"name"})

    BulkheadRejected = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "bulkhead_rejected_requests_total",
        Help: "Total requests rejected by bulkhead",
    }, []string{"name"})

    RateLimiterWaitDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "rate_limiter_wait_duration_seconds",
        Help:    "Time spent waiting for rate limiter token",
        Buckets: prometheus.DefBuckets,
    }, []string{"limiter"})
)

// InstrumentedCircuitBreaker wraps gobreaker with Prometheus metrics
type InstrumentedCircuitBreaker struct {
    cb *gobreaker.CircuitBreaker
}

func NewInstrumentedCircuitBreaker(settings gobreaker.Settings) *InstrumentedCircuitBreaker {
    original := settings.OnStateChange

    settings.OnStateChange = func(name string, from, to gobreaker.State) {
        stateValue := map[gobreaker.State]float64{
            gobreaker.StateClosed:   0,
            gobreaker.StateHalfOpen: 1,
            gobreaker.StateOpen:     2,
        }
        CircuitBreakerState.WithLabelValues(name).Set(stateValue[to])

        if original != nil {
            original(name, from, to)
        }
    }

    return &InstrumentedCircuitBreaker{
        cb: gobreaker.NewCircuitBreaker(settings),
    }
}

func (icb *InstrumentedCircuitBreaker) Execute(fn func() (interface{}, error)) (interface{}, error) {
    result, err := icb.cb.Execute(fn)
    name := icb.cb.Name()

    if err != nil {
        switch {
        case errors.Is(err, gobreaker.ErrOpenState):
            CircuitBreakerRequests.WithLabelValues(name, "open").Inc()
        case errors.Is(err, gobreaker.ErrTooManyRequests):
            CircuitBreakerRequests.WithLabelValues(name, "half_open_rejected").Inc()
        default:
            CircuitBreakerRequests.WithLabelValues(name, "failure").Inc()
        }
    } else {
        CircuitBreakerRequests.WithLabelValues(name, "success").Inc()
    }

    return result, err
}
```

## Section 7: Testing Chaos Scenarios

### Unit Testing Circuit Breaker Logic

```go
package resilience_test

import (
    "errors"
    "testing"
    "time"

    "github.com/sony/gobreaker"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestCircuitBreakerOpensOnConsecutiveFailures(t *testing.T) {
    cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
        Name: "test",
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures >= 3
        },
        Timeout: 1 * time.Second,
    })

    failFn := func() (interface{}, error) {
        return nil, errors.New("service error")
    }

    // 3 failures should open the circuit
    for i := 0; i < 3; i++ {
        _, err := cb.Execute(failFn)
        require.Error(t, err)
    }

    // Next call should fail with ErrOpenState
    _, err := cb.Execute(failFn)
    assert.ErrorIs(t, err, gobreaker.ErrOpenState)

    // Wait for timeout, circuit should go half-open
    time.Sleep(1100 * time.Millisecond)

    // Half-open: one test request allowed
    successFn := func() (interface{}, error) {
        return "ok", nil
    }
    result, err := cb.Execute(successFn)
    require.NoError(t, err)
    assert.Equal(t, "ok", result)

    // After success in half-open, circuit should close
    assert.Equal(t, gobreaker.StateClosed, cb.State())
}

func TestBulkheadRejectsWhenFull(t *testing.T) {
    bh := NewBulkhead("test", 2) // Only 2 concurrent allowed

    var wg sync.WaitGroup
    results := make(chan error, 10)

    // Launch 5 concurrent requests
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            err := bh.Execute(context.Background(), func() error {
                time.Sleep(100 * time.Millisecond)
                return nil
            })
            results <- err
        }()
    }

    wg.Wait()
    close(results)

    var successes, rejections int
    for err := range results {
        if err == nil {
            successes++
        } else if errors.Is(err, ErrBulkheadFull) {
            rejections++
        }
    }

    // 2 should succeed, 3 should be rejected
    assert.Equal(t, 2, successes)
    assert.Equal(t, 3, rejections)
}
```

### Integration Testing with Chaos

```go
package chaos_test

import (
    "net/http"
    "net/http/httptest"
    "sync/atomic"
    "testing"
    "time"
)

// ChaosServer simulates unreliable dependencies
type ChaosServer struct {
    requestCount  atomic.Int64
    failureRate   float64
    latency       time.Duration
    server        *httptest.Server
}

func NewChaosServer(failureRate float64, latency time.Duration) *ChaosServer {
    cs := &ChaosServer{
        failureRate: failureRate,
        latency:     latency,
    }
    cs.server = httptest.NewServer(http.HandlerFunc(cs.handle))
    return cs
}

func (cs *ChaosServer) handle(w http.ResponseWriter, r *http.Request) {
    count := cs.requestCount.Add(1)

    // Add artificial latency
    time.Sleep(cs.latency)

    // Fail based on rate
    if float64(count%100)/100.0 < cs.failureRate {
        w.WriteHeader(http.StatusInternalServerError)
        w.Write([]byte(`{"error":"internal server error"}`))
        return
    }

    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))
}

func (cs *ChaosServer) URL() string {
    return cs.server.URL
}

func (cs *ChaosServer) Close() {
    cs.server.Close()
}

func TestClientWithChaos(t *testing.T) {
    // 70% failure rate, 100ms latency
    chaos := NewChaosServer(0.70, 100*time.Millisecond)
    defer chaos.Close()

    client := NewPaymentClient(chaos.URL())

    // Run 50 requests
    var successes, cbRejections, errors int
    for i := 0; i < 50; i++ {
        _, err := client.ProcessPayment(context.Background(), PaymentRequest{
            ID:     fmt.Sprintf("order-%d", i),
            Amount: 100,
        })

        switch {
        case err == nil:
            successes++
        case errors.Is(err, ErrServiceUnavailable):
            cbRejections++
        default:
            errors++
        }
    }

    t.Logf("Results: successes=%d cbRejections=%d errors=%d", successes, cbRejections, errors)

    // Circuit should have opened, so we should have CB rejections
    assert.Greater(t, cbRejections, 0, "Expected some circuit breaker rejections")
    // Overall error rate should be lower than chaos server failure rate
    // because circuit breaker fast-fails before request is made
    t.Logf("Overall failure rate: %.1f%%", float64(cbRejections+errors)/float64(50)*100)
}
```

## Section 8: Resilience Testing Automation

```go
// resilience_test.go — table-driven resilience test suite
func TestResiliencePatterns(t *testing.T) {
    scenarios := []struct {
        name            string
        failureRate     float64
        latency         time.Duration
        requests        int
        maxFailureRate  float64
        expectCBOpen    bool
    }{
        {
            name:           "healthy service",
            failureRate:    0.0,
            latency:        10 * time.Millisecond,
            requests:       100,
            maxFailureRate: 0.05,
            expectCBOpen:   false,
        },
        {
            name:           "degraded service",
            failureRate:    0.5,
            latency:        200 * time.Millisecond,
            requests:       100,
            maxFailureRate: 0.5,
            expectCBOpen:   true,
        },
        {
            name:           "complete outage",
            failureRate:    1.0,
            latency:        5 * time.Second,
            requests:       50,
            maxFailureRate: 1.0,
            expectCBOpen:   true,
        },
    }

    for _, tc := range scenarios {
        t.Run(tc.name, func(t *testing.T) {
            chaos := NewChaosServer(tc.failureRate, tc.latency)
            defer chaos.Close()

            client := NewPaymentClient(chaos.URL())
            start := time.Now()

            var failures int
            for i := 0; i < tc.requests; i++ {
                _, err := client.ProcessPayment(context.Background(), PaymentRequest{
                    ID: fmt.Sprintf("req-%d", i),
                })
                if err != nil {
                    failures++
                }
            }

            elapsed := time.Since(start)
            actualFailureRate := float64(failures) / float64(tc.requests)

            t.Logf("Elapsed: %v, Failure rate: %.1f%%", elapsed, actualFailureRate*100)

            // Even with circuit breaker open, total time should be bounded
            // because open CB fails fast without making network calls
            assert.Less(t, elapsed, time.Duration(tc.requests)*50*time.Millisecond,
                "Circuit breaker should prevent long waits")
        })
    }
}
```

## Conclusion

Resilience engineering in Go is about layering multiple patterns: rate limiters prevent overwhelming dependencies, bulkheads isolate failures to compartments, and circuit breakers provide the fast-fail mechanism that prevents cascading failures. Each layer serves a distinct purpose and they work best in combination.

Start with bulkheads — they're the simplest and prevent the most common form of failure (goroutine exhaustion). Add circuit breakers to dependencies that have historically been unreliable. Add rate limiters when your downstream has explicit rate limits or you need to protect shared resources. Finally, test your resilience patterns under chaos conditions to verify they actually protect you in production.

The goal is not to eliminate failures — it's to ensure that individual component failures don't cascade into system-wide outages.
