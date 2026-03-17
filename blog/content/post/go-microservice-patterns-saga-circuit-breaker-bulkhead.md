---
title: "Go Microservice Patterns: Saga, Circuit Breaker, and Bulkhead with go-micro and hystrix-go"
date: 2030-04-16T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "Saga Pattern", "Circuit Breaker", "Bulkhead", "Distributed Systems", "Resilience"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go microservice resilience patterns: saga choreography vs orchestration, circuit breaker with sony/gobreaker, bulkhead pattern with semaphores, retry with exponential backoff, and distributed transaction management."
more_link: "yes"
url: "/go-microservice-patterns-saga-circuit-breaker-bulkhead/"
---

Distributed systems fail in ways that monoliths do not. A network partition, a slow downstream service, or a cascading failure can take down your entire system unless the individual services are designed to tolerate partial failure. Go's concurrency primitives and the ecosystem of resilience libraries make it an excellent language for implementing production-grade microservice resilience patterns. This guide covers the four most important patterns with working Go implementations: saga for distributed transactions, circuit breaker for failure isolation, bulkhead for resource partitioning, and retry with exponential backoff for transient error handling.

<!--more-->

## Why These Patterns Matter

Consider a payment processing workflow that touches five services: Order, Inventory, Payment, Shipping, and Notification. In a monolith, this is a single database transaction. In microservices, you have five network calls, each of which can fail independently, time out, or return a partial success. Without resilience patterns:

- A slow Inventory service causes the Order service to queue up thousands of pending requests, exhausting its connection pool
- A Payment service crash leaves orders in a half-completed state with no compensation logic
- A downstream failure cascades upstream because no circuit breakers prevent retries

## The Saga Pattern

### Choreography vs Orchestration

Saga solves distributed transactions without distributed locks. The saga represents a sequence of local transactions, each of which publishes an event that triggers the next step. If a step fails, compensating transactions undo the previous steps.

**Choreography** means each service listens for events and decides what to do independently. There is no central coordinator.

**Orchestration** means a central saga orchestrator tells each service what to do in sequence.

```go
// package: saga

package saga

import (
    "context"
    "errors"
    "fmt"
    "log"
    "time"
)

// Step represents one local transaction in a saga
type Step struct {
    Name        string
    Action      func(ctx context.Context, data interface{}) error
    Compensate  func(ctx context.Context, data interface{}) error
}

// Orchestrator runs a saga as a sequence of steps with compensation
type Orchestrator struct {
    name     string
    steps    []Step
    executed []int  // indices of successfully executed steps
}

func NewOrchestrator(name string) *Orchestrator {
    return &Orchestrator{name: name}
}

func (o *Orchestrator) AddStep(step Step) {
    o.steps = append(o.steps, step)
}

// Execute runs the saga. On failure, compensates all previously executed steps.
func (o *Orchestrator) Execute(ctx context.Context, data interface{}) error {
    o.executed = nil

    for i, step := range o.steps {
        log.Printf("[saga:%s] executing step %d: %s", o.name, i, step.Name)

        if err := step.Action(ctx, data); err != nil {
            log.Printf("[saga:%s] step %s failed: %v - starting compensation",
                o.name, step.Name, err)
            o.compensate(ctx, data)
            return fmt.Errorf("saga %s failed at step %s: %w", o.name, step.Name, err)
        }
        o.executed = append(o.executed, i)
    }

    log.Printf("[saga:%s] all %d steps completed successfully", o.name, len(o.steps))
    return nil
}

// compensate runs compensation in reverse order
func (o *Orchestrator) compensate(ctx context.Context, data interface{}) {
    for i := len(o.executed) - 1; i >= 0; i-- {
        step := o.steps[o.executed[i]]
        log.Printf("[saga:%s] compensating step: %s", o.name, step.Name)

        // Use a fresh context for compensation - the original may be cancelled
        compCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        if err := step.Compensate(compCtx, data); err != nil {
            // Compensation failure requires manual intervention
            log.Printf("[saga:%s] COMPENSATION FAILED for step %s: %v - MANUAL INTERVENTION REQUIRED",
                o.name, step.Name, err)
            // In production: emit an alert, write to a dead-letter queue
        }
    }
}
```

### Order Processing Saga Example

```go
package main

import (
    "context"
    "fmt"
    "log"
    "math/rand"
    "time"
)

// OrderData carries state through the saga
type OrderData struct {
    OrderID     string
    CustomerID  string
    Items       []OrderItem
    TotalAmount float64

    // Filled in by steps:
    ReservationID string
    PaymentID     string
    ShipmentID    string
}

type OrderItem struct {
    SKU      string
    Quantity int
    Price    float64
}

// Simulated service clients
type InventoryService struct{}
type PaymentService struct{}
type ShippingService struct{}
type NotificationService struct{}

func (s *InventoryService) Reserve(ctx context.Context, items []OrderItem) (string, error) {
    time.Sleep(time.Duration(rand.Intn(50)) * time.Millisecond)
    if rand.Float32() < 0.05 { // 5% failure rate
        return "", fmt.Errorf("inventory service: insufficient stock for item %s", items[0].SKU)
    }
    return fmt.Sprintf("RES-%d", rand.Int63()), nil
}

func (s *InventoryService) Release(ctx context.Context, reservationID string) error {
    log.Printf("Releasing inventory reservation %s", reservationID)
    return nil
}

func (s *PaymentService) Charge(ctx context.Context, customerID string, amount float64) (string, error) {
    time.Sleep(time.Duration(rand.Intn(100)) * time.Millisecond)
    if rand.Float32() < 0.03 { // 3% failure rate
        return "", fmt.Errorf("payment declined for customer %s", customerID)
    }
    return fmt.Sprintf("PAY-%d", rand.Int63()), nil
}

func (s *PaymentService) Refund(ctx context.Context, paymentID string) error {
    log.Printf("Refunding payment %s", paymentID)
    return nil
}

func (s *ShippingService) CreateShipment(ctx context.Context, orderID string) (string, error) {
    return fmt.Sprintf("SHIP-%d", rand.Int63()), nil
}

func (s *ShippingService) CancelShipment(ctx context.Context, shipmentID string) error {
    log.Printf("Cancelling shipment %s", shipmentID)
    return nil
}

func buildOrderSaga(inv *InventoryService, pay *PaymentService, ship *ShippingService) *Orchestrator {
    orch := NewOrchestrator("create-order")

    // Step 1: Reserve inventory
    orch.AddStep(Step{
        Name: "reserve-inventory",
        Action: func(ctx context.Context, raw interface{}) error {
            data := raw.(*OrderData)
            id, err := inv.Reserve(ctx, data.Items)
            if err != nil {
                return err
            }
            data.ReservationID = id
            log.Printf("Inventory reserved: %s", id)
            return nil
        },
        Compensate: func(ctx context.Context, raw interface{}) error {
            data := raw.(*OrderData)
            if data.ReservationID == "" {
                return nil
            }
            return inv.Release(ctx, data.ReservationID)
        },
    })

    // Step 2: Charge payment
    orch.AddStep(Step{
        Name: "charge-payment",
        Action: func(ctx context.Context, raw interface{}) error {
            data := raw.(*OrderData)
            id, err := pay.Charge(ctx, data.CustomerID, data.TotalAmount)
            if err != nil {
                return err
            }
            data.PaymentID = id
            log.Printf("Payment charged: %s", id)
            return nil
        },
        Compensate: func(ctx context.Context, raw interface{}) error {
            data := raw.(*OrderData)
            if data.PaymentID == "" {
                return nil
            }
            return pay.Refund(ctx, data.PaymentID)
        },
    })

    // Step 3: Create shipment
    orch.AddStep(Step{
        Name: "create-shipment",
        Action: func(ctx context.Context, raw interface{}) error {
            data := raw.(*OrderData)
            id, err := ship.CreateShipment(ctx, data.OrderID)
            if err != nil {
                return err
            }
            data.ShipmentID = id
            log.Printf("Shipment created: %s", id)
            return nil
        },
        Compensate: func(ctx context.Context, raw interface{}) error {
            data := raw.(*OrderData)
            if data.ShipmentID == "" {
                return nil
            }
            return ship.CancelShipment(ctx, data.ShipmentID)
        },
    })

    return orch
}

func main() {
    rand.New(rand.NewSource(time.Now().UnixNano()))

    inv  := &InventoryService{}
    pay  := &PaymentService{}
    ship := &ShippingService{}

    saga := buildOrderSaga(inv, pay, ship)

    order := &OrderData{
        OrderID:    "ORD-12345",
        CustomerID: "CUST-42",
        Items: []OrderItem{
            {SKU: "WIDGET-A", Quantity: 2, Price: 29.99},
        },
        TotalAmount: 59.98,
    }

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := saga.Execute(ctx, order); err != nil {
        log.Printf("Order failed: %v", err)
    } else {
        log.Printf("Order completed: orderID=%s paymentID=%s shipmentID=%s",
            order.OrderID, order.PaymentID, order.ShipmentID)
    }
}
```

### Choreography-Based Saga with Event Bus

```go
// Choreography saga using an event bus
package choreography

import (
    "context"
    "encoding/json"
    "log"
    "sync"
)

type Event struct {
    Type    string
    Payload json.RawMessage
}

type EventBus struct {
    mu          sync.RWMutex
    subscribers map[string][]func(context.Context, Event)
}

func NewEventBus() *EventBus {
    return &EventBus{
        subscribers: make(map[string][]func(context.Context, Event)),
    }
}

func (b *EventBus) Subscribe(eventType string, handler func(context.Context, Event)) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.subscribers[eventType] = append(b.subscribers[eventType], handler)
}

func (b *EventBus) Publish(ctx context.Context, event Event) {
    b.mu.RLock()
    handlers := b.subscribers[event.Type]
    b.mu.RUnlock()

    for _, h := range handlers {
        go h(ctx, event)
    }
}

// Each service registers its own event handlers
func RegisterInventoryHandlers(bus *EventBus) {
    bus.Subscribe("OrderCreated", func(ctx context.Context, e Event) {
        log.Printf("InventoryService: handling OrderCreated event")
        // Reserve inventory...
        // On success: publish "InventoryReserved"
        // On failure: publish "InventoryReservationFailed"
        bus.Publish(ctx, Event{Type: "InventoryReserved", Payload: e.Payload})
    })

    bus.Subscribe("PaymentFailed", func(ctx context.Context, e Event) {
        log.Printf("InventoryService: compensating for PaymentFailed")
        // Release inventory reservation
    })
}

func RegisterPaymentHandlers(bus *EventBus) {
    bus.Subscribe("InventoryReserved", func(ctx context.Context, e Event) {
        log.Printf("PaymentService: handling InventoryReserved event")
        // Charge payment...
        bus.Publish(ctx, Event{Type: "PaymentProcessed", Payload: e.Payload})
    })
}
```

## Circuit Breaker with sony/gobreaker

The circuit breaker pattern prevents cascading failures by detecting when a downstream service is failing and short-circuiting requests to it rather than waiting for timeouts.

```go
// go.mod dependency: github.com/sony/gobreaker
package breaker

import (
    "context"
    "errors"
    "fmt"
    "log"
    "net/http"
    "time"

    "github.com/sony/gobreaker"
)

// Production circuit breaker settings for different service tiers
func NewTightBreaker(name string) *gobreaker.CircuitBreaker {
    settings := gobreaker.Settings{
        Name:    name,
        // Open after 5 consecutive failures
        MaxRequests: 1,
        Interval:    10 * time.Second,
        Timeout:     30 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRate := float64(counts.TotalFailures) /
                          float64(counts.Requests)
            return counts.Requests >= 5 && failureRate >= 0.6
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            log.Printf("Circuit breaker %s: %s -> %s",
                name, from.String(), to.String())
            // In production: emit a metric/alert here
        },
    }
    return gobreaker.NewCircuitBreaker(settings)
}

// NewRelaxedBreaker for less critical downstream services
func NewRelaxedBreaker(name string) *gobreaker.CircuitBreaker {
    settings := gobreaker.Settings{
        Name:        name,
        MaxRequests: 5,
        Interval:    60 * time.Second,
        Timeout:     120 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures >= 10
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            log.Printf("Circuit breaker %s: %s -> %s",
                name, from.String(), to.String())
        },
    }
    return gobreaker.NewCircuitBreaker(settings)
}

// HTTPClient wraps http.Client with a circuit breaker
type HTTPClient struct {
    client  *http.Client
    breaker *gobreaker.CircuitBreaker
    baseURL string
}

func NewHTTPClient(baseURL string, name string) *HTTPClient {
    return &HTTPClient{
        client: &http.Client{
            Timeout: 10 * time.Second,
        },
        breaker: NewTightBreaker(name),
        baseURL: baseURL,
    }
}

func (c *HTTPClient) Get(ctx context.Context, path string) (*http.Response, error) {
    resp, err := c.breaker.Execute(func() (interface{}, error) {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet,
            c.baseURL+path, nil)
        if err != nil {
            return nil, err
        }

        resp, err := c.client.Do(req)
        if err != nil {
            return nil, err
        }

        // Treat 5xx as circuit-breaker errors
        if resp.StatusCode >= 500 {
            resp.Body.Close()
            return nil, fmt.Errorf("server error: %d %s",
                resp.StatusCode, http.StatusText(resp.StatusCode))
        }

        return resp, nil
    })

    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            return nil, fmt.Errorf("circuit breaker open for %s: refusing request", c.baseURL)
        }
        return nil, err
    }

    return resp.(*http.Response), nil
}

// CircuitBreakerMetrics for Prometheus integration
type CircuitBreakerMetrics struct {
    breakers map[string]*gobreaker.CircuitBreaker
}

func (m *CircuitBreakerMetrics) States() map[string]string {
    result := make(map[string]string)
    for name, cb := range m.breakers {
        result[name] = cb.State().String()
    }
    return result
}
```

### Circuit Breaker with Fallback

```go
// Circuit breaker with fallback response
type CachedHTTPClient struct {
    client    *HTTPClient
    lastResp  string
    lastFetch time.Time
}

func (c *CachedHTTPClient) GetWithFallback(ctx context.Context, path string) (string, error) {
    resp, err := c.client.Get(ctx, path)
    if err != nil {
        // Check if we have a cached response to fall back to
        if !c.lastFetch.IsZero() && time.Since(c.lastFetch) < 5*time.Minute {
            log.Printf("Circuit breaker open, returning cached response from %v",
                c.lastFetch)
            return c.lastResp + " [CACHED]", nil
        }
        return "", fmt.Errorf("service unavailable and no cache: %w", err)
    }
    defer resp.Body.Close()

    // Update cache on success
    c.lastFetch = time.Now()
    // Read body into c.lastResp...
    return c.lastResp, nil
}
```

## Bulkhead Pattern with Semaphores

The bulkhead pattern isolates different types of requests into separate resource pools. If one category of requests starts consuming all goroutines (due to slow processing), the bulkhead prevents it from starving other categories.

```go
package bulkhead

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Semaphore is the core bulkhead primitive
type Semaphore struct {
    ch   chan struct{}
    name string
}

func NewSemaphore(name string, capacity int) *Semaphore {
    ch := make(chan struct{}, capacity)
    // Pre-fill
    for i := 0; i < capacity; i++ {
        ch <- struct{}{}
    }
    return &Semaphore{ch: ch, name: name}
}

// Acquire takes a slot, respecting context cancellation
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case <-s.ch:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("bulkhead %s: context cancelled while waiting for slot: %w",
            s.name, ctx.Err())
    }
}

// AcquireWithTimeout returns an error if no slot is available within timeout
func (s *Semaphore) AcquireWithTimeout(timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()
    return s.Acquire(ctx)
}

// TryAcquire returns immediately without blocking
func (s *Semaphore) TryAcquire() bool {
    select {
    case <-s.ch:
        return true
    default:
        return false
    }
}

// Release returns a slot to the pool
func (s *Semaphore) Release() {
    s.ch <- struct{}{}
}

// Available returns the number of free slots
func (s *Semaphore) Available() int {
    return len(s.ch)
}

// Bulkhead wraps a function with a semaphore
type Bulkhead struct {
    sem  *Semaphore
    name string
}

func NewBulkhead(name string, maxConcurrent int) *Bulkhead {
    return &Bulkhead{
        sem:  NewSemaphore(name, maxConcurrent),
        name: name,
    }
}

func (b *Bulkhead) Execute(ctx context.Context, fn func(context.Context) error) error {
    if err := b.sem.Acquire(ctx); err != nil {
        return fmt.Errorf("bulkhead %s rejected: %w", b.name, err)
    }
    defer b.sem.Release()
    return fn(ctx)
}

// BulkheadPool groups multiple bulkheads for different service categories
type BulkheadPool struct {
    mu       sync.RWMutex
    heads    map[string]*Bulkhead
    defaults int
}

func NewBulkheadPool(defaultCapacity int) *BulkheadPool {
    return &BulkheadPool{
        heads:    make(map[string]*Bulkhead),
        defaults: defaultCapacity,
    }
}

func (p *BulkheadPool) Get(category string) *Bulkhead {
    p.mu.RLock()
    b, ok := p.heads[category]
    p.mu.RUnlock()

    if ok {
        return b
    }

    p.mu.Lock()
    defer p.mu.Unlock()
    if b, ok = p.heads[category]; !ok {
        b = NewBulkhead(category, p.defaults)
        p.heads[category] = b
    }
    return b
}

func (p *BulkheadPool) Register(category string, capacity int) {
    p.mu.Lock()
    defer p.mu.Unlock()
    p.heads[category] = NewBulkhead(category, capacity)
}
```

### Production Bulkhead Usage

```go
// Separate bulkheads for critical vs non-critical paths
type OrderService struct {
    criticalBulkhead    *Bulkhead  // payment processing: max 50 concurrent
    readBulkhead        *Bulkhead  // order status reads: max 200 concurrent
    reportingBulkhead   *Bulkhead  // reports: max 10 concurrent
    paymentClient       *HTTPClient
    inventoryClient     *HTTPClient
}

func NewOrderService() *OrderService {
    return &OrderService{
        criticalBulkhead:  NewBulkhead("critical-payment", 50),
        readBulkhead:      NewBulkhead("order-reads", 200),
        reportingBulkhead: NewBulkhead("reports", 10),
        paymentClient:     NewHTTPClient("http://payment-service:8080", "payment"),
        inventoryClient:   NewHTTPClient("http://inventory-service:8080", "inventory"),
    }
}

func (s *OrderService) ProcessPayment(ctx context.Context, orderID string) error {
    return s.criticalBulkhead.Execute(ctx, func(ctx context.Context) error {
        // This runs with bulkhead protection
        // If 50 payments are already in flight, new ones get context error
        resp, err := s.paymentClient.Get(ctx, "/process/"+orderID)
        if err != nil {
            return err
        }
        defer resp.Body.Close()
        return nil
    })
}

func (s *OrderService) GetOrderStatus(ctx context.Context, orderID string) error {
    return s.readBulkhead.Execute(ctx, func(ctx context.Context) error {
        resp, err := s.inventoryClient.Get(ctx, "/status/"+orderID)
        if err != nil {
            return err
        }
        defer resp.Body.Close()
        return nil
    })
}
```

## Retry with Exponential Backoff

Transient failures (network blips, brief service restarts) should be retried. Permanent failures (authentication errors, validation errors) should not. Exponential backoff with jitter prevents retry storms.

```go
package retry

import (
    "context"
    "errors"
    "fmt"
    "log"
    "math"
    "math/rand"
    "time"
)

// RetryableError wraps an error to indicate it should be retried
type RetryableError struct {
    Cause error
}

func (e *RetryableError) Error() string { return e.Cause.Error() }
func (e *RetryableError) Unwrap() error { return e.Cause }

// IsRetryable determines whether an error should trigger a retry
func IsRetryable(err error) bool {
    var retryable *RetryableError
    return errors.As(err, &retryable)
}

// Config holds retry policy settings
type Config struct {
    MaxAttempts     int
    InitialInterval time.Duration
    MaxInterval     time.Duration
    Multiplier      float64
    JitterFactor    float64 // 0.0 = no jitter, 1.0 = full jitter
}

// DefaultConfig returns sensible defaults for most service calls
var DefaultConfig = Config{
    MaxAttempts:     5,
    InitialInterval: 100 * time.Millisecond,
    MaxInterval:     30 * time.Second,
    Multiplier:      2.0,
    JitterFactor:    0.3,
}

// AggressiveConfig for fast retry of brief transient errors
var AggressiveConfig = Config{
    MaxAttempts:     10,
    InitialInterval: 10 * time.Millisecond,
    MaxInterval:     5 * time.Second,
    Multiplier:      1.5,
    JitterFactor:    0.5,
}

// Do executes fn with retry according to config
func Do(ctx context.Context, cfg Config, fn func(ctx context.Context) error) error {
    var lastErr error

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        if attempt > 0 {
            interval := computeBackoff(cfg, attempt)
            log.Printf("retry: attempt %d/%d, waiting %v (last error: %v)",
                attempt+1, cfg.MaxAttempts, interval, lastErr)

            select {
            case <-time.After(interval):
            case <-ctx.Done():
                return fmt.Errorf("retry aborted by context on attempt %d: %w",
                    attempt+1, ctx.Err())
            }
        }

        err := fn(ctx)
        if err == nil {
            if attempt > 0 {
                log.Printf("retry: succeeded on attempt %d", attempt+1)
            }
            return nil
        }

        lastErr = err

        // Do not retry non-retryable errors
        if !IsRetryable(err) {
            return fmt.Errorf("non-retryable error on attempt %d: %w", attempt+1, err)
        }
    }

    return fmt.Errorf("all %d attempts failed, last error: %w", cfg.MaxAttempts, lastErr)
}

// computeBackoff calculates the delay for a given attempt number
func computeBackoff(cfg Config, attempt int) time.Duration {
    // Exponential backoff: initialInterval * multiplier^attempt
    base := float64(cfg.InitialInterval) * math.Pow(cfg.Multiplier, float64(attempt-1))

    // Cap at max interval
    if base > float64(cfg.MaxInterval) {
        base = float64(cfg.MaxInterval)
    }

    // Add jitter: random value in [-jitter*base, +jitter*base]
    jitter := base * cfg.JitterFactor * (rand.Float64()*2 - 1)
    interval := time.Duration(base + jitter)

    if interval < cfg.InitialInterval {
        interval = cfg.InitialInterval
    }

    return interval
}

// RetryHTTP wraps an HTTP request with retry logic
func RetryHTTP(ctx context.Context, fn func() error) error {
    return Do(ctx, DefaultConfig, func(ctx context.Context) error {
        err := fn()
        if err != nil {
            // Classify errors for retry decision
            return &RetryableError{Cause: err}
        }
        return nil
    })
}
```

## Combining All Patterns

```go
// ResilientServiceClient combines all patterns for a production service client
package client

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "time"

    "github.com/sony/gobreaker"
)

type ResilientClient struct {
    http     *http.Client
    breaker  *gobreaker.CircuitBreaker
    bulkhead *Bulkhead
    retry    Config
    baseURL  string
}

func NewResilientClient(baseURL, name string) *ResilientClient {
    breakerSettings := gobreaker.Settings{
        Name:        name,
        MaxRequests: 3,
        Interval:    30 * time.Second,
        Timeout:     60 * time.Second,
        ReadyToTrip: func(c gobreaker.Counts) bool {
            return c.ConsecutiveFailures >= 5
        },
    }

    return &ResilientClient{
        http:     &http.Client{Timeout: 10 * time.Second},
        breaker:  gobreaker.NewCircuitBreaker(breakerSettings),
        bulkhead: NewBulkhead(name, 100),
        retry:    DefaultConfig,
        baseURL:  baseURL,
    }
}

func (c *ResilientClient) Get(ctx context.Context, path string) ([]byte, error) {
    var result []byte

    // Layer 1: Bulkhead - limit concurrent requests
    err := c.bulkhead.Execute(ctx, func(ctx context.Context) error {

        // Layer 2: Retry with exponential backoff
        return Do(ctx, c.retry, func(ctx context.Context) error {

            // Layer 3: Circuit breaker - fail fast when service is down
            out, cbErr := c.breaker.Execute(func() (interface{}, error) {
                req, err := http.NewRequestWithContext(ctx,
                    http.MethodGet, c.baseURL+path, nil)
                if err != nil {
                    return nil, err // not retryable
                }

                resp, err := c.http.Do(req)
                if err != nil {
                    return nil, &RetryableError{Cause: err}
                }
                defer resp.Body.Close()

                if resp.StatusCode >= 500 {
                    return nil, &RetryableError{
                        Cause: fmt.Errorf("server error %d", resp.StatusCode),
                    }
                }

                if resp.StatusCode >= 400 {
                    // Client errors are not retryable
                    return nil, fmt.Errorf("client error %d: not retrying",
                        resp.StatusCode)
                }

                body, err := io.ReadAll(resp.Body)
                if err != nil {
                    return nil, &RetryableError{Cause: err}
                }

                return body, nil
            })

            if cbErr != nil {
                return cbErr
            }

            result = out.([]byte)
            return nil
        })
    })

    return result, err
}

// Health returns the health status of the client
func (c *ResilientClient) Health() map[string]interface{} {
    return map[string]interface{}{
        "circuit_breaker_state": c.breaker.State().String(),
        "bulkhead_available":    c.bulkhead.sem.Available(),
    }
}
```

## Timeout Budget Propagation

Distributed systems need timeout budgets — a time limit that flows through the entire call chain and gets consumed by each hop.

```go
package timeout

import (
    "context"
    "fmt"
    "time"
)

// BudgetKey is the context key for timeout budget tracking
type budgetKey struct{}

// WithBudget creates a context with a total timeout budget
func WithBudget(ctx context.Context, total time.Duration) context.Context {
    deadline := time.Now().Add(total)
    ctx, _ = context.WithDeadline(ctx, deadline)
    return context.WithValue(ctx, budgetKey{}, deadline)
}

// Remaining returns the remaining budget
func Remaining(ctx context.Context) (time.Duration, bool) {
    deadline, ok := ctx.Deadline()
    if !ok {
        return 0, false
    }
    remaining := time.Until(deadline)
    if remaining <= 0 {
        return 0, false
    }
    return remaining, true
}

// SpendBudget allocates a portion of the remaining budget for one hop
func SpendBudget(ctx context.Context, maxSpend time.Duration) (context.Context, context.CancelFunc, error) {
    remaining, ok := Remaining(ctx)
    if !ok {
        return nil, nil, fmt.Errorf("no timeout budget in context")
    }

    if remaining < 10*time.Millisecond {
        return nil, nil, fmt.Errorf("timeout budget exhausted: %v remaining", remaining)
    }

    // Spend at most maxSpend, but respect the remaining budget
    spend := remaining - 5*time.Millisecond // keep 5ms for cleanup
    if maxSpend > 0 && maxSpend < spend {
        spend = maxSpend
    }

    ctx2, cancel := context.WithTimeout(ctx, spend)
    return ctx2, cancel, nil
}

// Usage example
func callDownstream(ctx context.Context, service string) error {
    // Allocate at most 2s for this downstream call
    ctx2, cancel, err := SpendBudget(ctx, 2*time.Second)
    if err != nil {
        return fmt.Errorf("budget check before %s: %w", service, err)
    }
    defer cancel()

    remaining, _ := Remaining(ctx2)
    _ = remaining
    // ... make the actual call with ctx2
    return nil
}
```

## Testing Resilience Patterns

```go
package resilience_test

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "testing"
    "time"
)

func TestCircuitBreakerOpens(t *testing.T) {
    client := NewHTTPClient("http://localhost:9999", "test-cb")

    ctx := context.Background()
    var failCount int32

    // Fail 6 times to open the circuit
    for i := 0; i < 6; i++ {
        _, err := client.Get(ctx, "/fail")
        if err != nil {
            atomic.AddInt32(&failCount, 1)
        }
    }

    // Circuit should now be open - next call should fail fast
    start := time.Now()
    _, err := client.Get(ctx, "/test")
    elapsed := time.Since(start)

    if elapsed > 100*time.Millisecond {
        t.Errorf("circuit breaker did not fail fast: took %v", elapsed)
    }

    if err == nil {
        t.Error("expected error from open circuit breaker")
    }
}

func TestBulkheadRejectsConcurrentRequests(t *testing.T) {
    bh := NewBulkhead("test", 5)
    var (
        accepted int32
        rejected int32
        wg       sync.WaitGroup
    )

    // Launch 20 concurrent requests against capacity-5 bulkhead
    for i := 0; i < 20; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
            defer cancel()

            err := bh.Execute(ctx, func(ctx context.Context) error {
                time.Sleep(100 * time.Millisecond) // hold slot
                return nil
            })

            if err != nil {
                atomic.AddInt32(&rejected, 1)
            } else {
                atomic.AddInt32(&accepted, 1)
            }
        }()
    }

    wg.Wait()

    if accepted != 5 {
        t.Errorf("expected exactly 5 accepted, got %d", accepted)
    }
    if rejected != 15 {
        t.Errorf("expected 15 rejected, got %d", rejected)
    }
}

func TestSagaCompensation(t *testing.T) {
    var (
        step1Executed    bool
        step1Compensated bool
        step2Executed    bool
        step2Compensated bool
    )

    orch := NewOrchestrator("test-saga")

    orch.AddStep(Step{
        Name: "step1",
        Action: func(ctx context.Context, data interface{}) error {
            step1Executed = true
            return nil
        },
        Compensate: func(ctx context.Context, data interface{}) error {
            step1Compensated = true
            return nil
        },
    })

    orch.AddStep(Step{
        Name: "step2-fails",
        Action: func(ctx context.Context, data interface{}) error {
            step2Executed = true
            return errors.New("intentional failure")
        },
        Compensate: func(ctx context.Context, data interface{}) error {
            step2Compensated = true
            return nil
        },
    })

    err := orch.Execute(context.Background(), nil)
    if err == nil {
        t.Error("expected saga to fail")
    }

    if !step1Executed || !step2Executed {
        t.Error("expected both steps to be executed")
    }

    // step1 should be compensated, step2 was never completed
    if !step1Compensated {
        t.Error("step1 should have been compensated")
    }
    if step2Compensated {
        t.Error("step2 should NOT have been compensated (it failed)")
    }
}
```

## Key Takeaways

Resilience patterns are not optional in production microservice systems — they are table stakes. Go's concurrency model makes these patterns exceptionally clean to implement because channels, goroutines, and context cancellation map directly to the primitives the patterns require.

**Saga pattern**: Use orchestration (centralized coordinator) for straightforward linear workflows where compensation logic is well-defined. Use choreography (event-driven) for complex workflows where services need autonomy. Always implement idempotent compensating transactions.

**Circuit breaker**: The sony/gobreaker library is production-tested and correct. Tune `ReadyToTrip` based on failure rate (not just count) for high-traffic services to avoid false positives. Always log state transitions and emit metrics.

**Bulkhead pattern**: A semaphore-based bulkhead is four lines of Go. Deploy separate bulkheads for critical payment paths, high-volume read paths, and low-priority background work. The bulkhead capacity should be derived from your downstream service's measured max throughput, not a guess.

**Retry with backoff**: Full jitter (random backoff between 0 and the exponential maximum) provides better load distribution than decorrelated jitter for high-concurrency systems. Never retry 4xx errors except for 429 (rate limit) with `Retry-After` header respect.

**Compose the patterns**: The practical value comes from composing them — bulkhead prevents resource exhaustion, circuit breaker prevents timeout accumulation, retry handles transient errors, and saga handles distributed transaction correctness. Together they create a system that degrades gracefully rather than failing catastrophically.
