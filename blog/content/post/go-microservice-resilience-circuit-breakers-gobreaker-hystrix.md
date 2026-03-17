---
title: "Go Microservice Resilience: Circuit Breakers with gobreaker and Hystrix-Go"
date: 2031-05-26T00:00:00-05:00
draft: false
tags: ["Go", "Circuit Breaker", "Resilience", "gobreaker", "Hystrix", "Bulkhead", "Prometheus", "Microservices"]
categories:
- Go
- Microservices
- Resilience
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to microservice resilience patterns in Go using gobreaker and hystrix-go, covering circuit breaker state machines, failure threshold tuning, bulkhead isolation with goroutine pools, fallback implementations, and Prometheus metrics export."
more_link: "yes"
url: "/go-microservice-resilience-circuit-breakers-gobreaker-hystrix/"
---

Distributed systems fail. The question is not whether a downstream service will become unavailable but when. Circuit breakers prevent cascading failures by detecting repeated failures and failing fast before the downstream service is overwhelmed with requests it cannot serve. This guide builds a production resilience library in Go that combines circuit breakers, bulkheads, and fallbacks into a coherent failure isolation strategy.

<!--more-->

# Go Microservice Resilience: Circuit Breakers with gobreaker and Hystrix-Go

## Section 1: Resilience Patterns Overview

### The Failure Cascade Problem

```
Without circuit breakers:

Service A → Service B (SLOW, 20s timeout) → Service C (DOWN)

Result:
- Service A: 50 goroutines blocked waiting for B
- Service B: 50 connections open waiting for C
- Service A runs out of goroutines
- Service A becomes slow → affects all callers of A
- Cascading failure up the call chain
- Recovery: requires C to recover + all timeouts to expire

With circuit breakers:

Service A → [CB: OPEN] → Service B (immediate error, no wait)

Result:
- Service A: 0 goroutines blocked
- Immediate failure response (fast-fail)
- Circuit reopens when C recovers
- Clean isolation of failure
```

### Pattern Selection Guide

| Pattern | Problem Solved | Use When |
|---------|----------------|----------|
| Circuit Breaker | Cascading failures | Any downstream service call |
| Bulkhead | Resource exhaustion | Services with variable load |
| Retry | Transient failures | Idempotent operations |
| Timeout | Slow/hanging calls | All external calls |
| Fallback | Degraded experience | Non-critical data |
| Rate Limit | Overwhelming downstream | All external calls |

## Section 2: gobreaker State Machine

### Circuit Breaker States

```
                 ┌──────────────────────────────────┐
                 │                                   │
                 ▼                          failure  │
              CLOSED ──── consecutive ──────────────►
              (normal)     failures                  │
                 │        (e.g. 5)                   │
                 │                                   │
                 │ success                        OPEN
                 │  ◄──────── half-open ──────────── │
                 │             success               │
                 │                                   │
                 │             HALF_OPEN ◄───────────┘
                 │             (try one)   after timeout
                 │
                 ▼
              Back to CLOSED
```

### gobreaker Implementation

```go
// resilience/breaker.go
package resilience

import (
    "context"
    "fmt"
    "time"

    "github.com/sony/gobreaker"
    "go.uber.org/zap"
)

// BreakerConfig configures a circuit breaker.
type BreakerConfig struct {
    // Name identifies the circuit breaker (used in metrics)
    Name string

    // MaxRequests is the max number of requests allowed in half-open state
    MaxRequests uint32

    // Interval is the rolling window for counting failures
    Interval time.Duration

    // Timeout is how long the breaker stays open before trying half-open
    Timeout time.Duration

    // ReadyToTrip determines if the breaker should trip based on counts
    ReadyToTrip func(counts gobreaker.Counts) bool

    // OnStateChange is called when the breaker changes state
    OnStateChange func(name string, from, to gobreaker.State)
}

// DefaultBreakerConfig returns a sensible default configuration.
func DefaultBreakerConfig(name string) BreakerConfig {
    return BreakerConfig{
        Name:        name,
        MaxRequests: 1,
        Interval:    60 * time.Second,
        Timeout:     30 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 3 && failureRatio >= 0.6
        },
    }
}

// NewBreaker creates a gobreaker circuit breaker with the given config.
func NewBreaker(cfg BreakerConfig, logger *zap.Logger, metrics *BreakerMetrics) *gobreaker.CircuitBreaker {
    settings := gobreaker.Settings{
        Name:        cfg.Name,
        MaxRequests: cfg.MaxRequests,
        Interval:    cfg.Interval,
        Timeout:     cfg.Timeout,
        ReadyToTrip: cfg.ReadyToTrip,
        OnStateChange: func(name string, from, to gobreaker.State) {
            logger.Info("circuit breaker state change",
                zap.String("name", name),
                zap.String("from", from.String()),
                zap.String("to", to.String()),
            )

            if metrics != nil {
                metrics.StateChange(name, from, to)
            }

            if cfg.OnStateChange != nil {
                cfg.OnStateChange(name, from, to)
            }
        },
    }

    return gobreaker.NewCircuitBreaker(settings)
}

// CircuitBreakerPool manages multiple circuit breakers.
type CircuitBreakerPool struct {
    breakers map[string]*gobreaker.CircuitBreaker
    logger   *zap.Logger
    metrics  *BreakerMetrics
}

// NewCircuitBreakerPool creates a pool of circuit breakers.
func NewCircuitBreakerPool(logger *zap.Logger, metrics *BreakerMetrics) *CircuitBreakerPool {
    return &CircuitBreakerPool{
        breakers: make(map[string]*gobreaker.CircuitBreaker),
        logger:   logger,
        metrics:  metrics,
    }
}

// Register adds a named circuit breaker to the pool.
func (p *CircuitBreakerPool) Register(cfg BreakerConfig) {
    p.breakers[cfg.Name] = NewBreaker(cfg, p.logger, p.metrics)
}

// Execute runs fn within the named circuit breaker.
func (p *CircuitBreakerPool) Execute(name string, fn func() (interface{}, error)) (interface{}, error) {
    cb, ok := p.breakers[name]
    if !ok {
        // If no circuit breaker registered, execute directly (fail open)
        p.logger.Warn("no circuit breaker registered, executing directly",
            zap.String("name", name))
        return fn()
    }

    return cb.Execute(fn)
}

// ExecuteContext runs fn within the named circuit breaker, respecting context cancellation.
func (p *CircuitBreakerPool) ExecuteContext(
    ctx context.Context,
    name string,
    fn func(context.Context) (interface{}, error),
) (interface{}, error) {
    cb, ok := p.breakers[name]
    if !ok {
        return fn(ctx)
    }

    return cb.Execute(func() (interface{}, error) {
        // Check context before attempting the call
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
        }

        return fn(ctx)
    })
}

// State returns the current state of a named circuit breaker.
func (p *CircuitBreakerPool) State(name string) (gobreaker.State, error) {
    cb, ok := p.breakers[name]
    if !ok {
        return gobreaker.StateClosed, fmt.Errorf("breaker %q not found", name)
    }
    return cb.State(), nil
}
```

## Section 3: Production Circuit Breaker Configuration

### Fine-Tuned Configurations per Service

```go
// resilience/configs.go
package resilience

import (
    "time"

    "github.com/sony/gobreaker"
)

// ServiceBreakerConfigs returns production-tuned configs for different service types.
func ServiceBreakerConfigs() map[string]BreakerConfig {
    return map[string]BreakerConfig{
        // Database: strict - fail fast on 3 consecutive failures
        "database": {
            Name:        "database",
            MaxRequests: 5,
            Interval:    30 * time.Second,
            Timeout:     10 * time.Second,
            ReadyToTrip: func(counts gobreaker.Counts) bool {
                // Trip on 3 consecutive failures
                return counts.ConsecutiveFailures >= 3
            },
        },

        // Payment service: conservative - don't trip on transient errors
        "payment-service": {
            Name:        "payment-service",
            MaxRequests: 1,
            Interval:    60 * time.Second,
            Timeout:     60 * time.Second,  // Stay open longer for payment recovery
            ReadyToTrip: func(counts gobreaker.Counts) bool {
                // Trip only if 80%+ failure rate with at least 10 requests
                if counts.Requests < 10 {
                    return false
                }
                failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
                return failureRatio >= 0.8
            },
        },

        // Cache: lenient - cache misses are expected, only trip on connection errors
        "redis-cache": {
            Name:        "redis-cache",
            MaxRequests: 3,
            Interval:    10 * time.Second,
            Timeout:     5 * time.Second,  // Short timeout, cache issues resolve quickly
            ReadyToTrip: func(counts gobreaker.Counts) bool {
                return counts.ConsecutiveFailures >= 5
            },
        },

        // External API: rate-limited with longer timeout
        "external-api": {
            Name:        "external-api",
            MaxRequests: 1,
            Interval:    30 * time.Second,
            Timeout:     30 * time.Second,
            ReadyToTrip: func(counts gobreaker.Counts) bool {
                if counts.Requests < 5 {
                    return false
                }
                failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
                return failureRatio >= 0.5
            },
        },
    }
}
```

## Section 4: Hystrix-Go for Command Isolation

### hystrix-go Concepts

```
hystrix-go Command model:

Execute(commandName, run, fallback)
  │
  ├── run() → normal execution path
  │     └── success → return result
  │     └── failure → call fallback() if provided
  │
  └── fallback() → degraded execution path
        └── execute cached/default/alternative response

Configuration per command:
  Timeout            - max execution time
  MaxConcurrentReqs  - bulkhead size (goroutine pool)
  ErrorPercentThreshold  - when to open circuit
  RequestVolumeThreshold - min requests before circuit can open
  SleepWindow        - open → half-open recovery window
```

### hystrix-go Implementation

```go
// resilience/hystrix.go
package resilience

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/afex/hystrix-go/hystrix"
    "go.uber.org/zap"
)

// HystrixCommand wraps hystrix-go with context support.
type HystrixCommand struct {
    Name   string
    logger *zap.Logger
}

// HystrixCommandConfig configures a Hystrix command.
type HystrixCommandConfig struct {
    // Timeout is the time each request can take
    Timeout int  // milliseconds

    // MaxConcurrentRequests is the maximum number of concurrent requests
    // This is the bulkhead size
    MaxConcurrentRequests int

    // RequestVolumeThreshold is the minimum number of requests before
    // the circuit can be opened
    RequestVolumeThreshold int

    // SleepWindow is the time after the circuit opens before a health
    // check request is allowed through
    SleepWindow int  // milliseconds

    // ErrorPercentThreshold is the percentage of requests that must fail
    // before the circuit is opened
    ErrorPercentThreshold int
}

// DefaultHystrixConfig returns sensible defaults.
func DefaultHystrixConfig() HystrixCommandConfig {
    return HystrixCommandConfig{
        Timeout:                2000,  // 2 seconds
        MaxConcurrentRequests:  100,
        RequestVolumeThreshold: 20,
        SleepWindow:            5000,  // 5 seconds
        ErrorPercentThreshold:  50,
    }
}

// ConfigureHystrix configures a named Hystrix command.
func ConfigureHystrix(name string, cfg HystrixCommandConfig) {
    hystrix.ConfigureCommand(name, hystrix.CommandConfig{
        Timeout:               cfg.Timeout,
        MaxConcurrentRequests: cfg.MaxConcurrentRequests,
        RequestVolumeThreshold: cfg.RequestVolumeThreshold,
        SleepWindow:           cfg.SleepWindow,
        ErrorPercentThreshold: cfg.ErrorPercentThreshold,
    })
}

// Do executes a command with fallback.
func Do(
    ctx context.Context,
    name string,
    run func(context.Context) error,
    fallback func(context.Context, error) error,
) error {
    // hystrix-go doesn't natively support context, so we bridge it
    done := make(chan struct{})
    var runErr error

    hystrixErr := hystrix.Do(name,
        func() error {
            defer close(done)

            // Run in context-aware manner
            runCh := make(chan error, 1)
            go func() {
                runCh <- run(ctx)
            }()

            select {
            case err := <-runCh:
                runErr = err
                return err
            case <-ctx.Done():
                return ctx.Err()
            }
        },
        func(err error) error {
            if fallback != nil {
                return fallback(ctx, err)
            }
            return err
        },
    )

    return hystrixErr
}

// DoC executes a command and returns a result.
func DoC[T any](
    ctx context.Context,
    name string,
    run func(context.Context) (T, error),
    fallback func(context.Context, error) (T, error),
) (T, error) {
    var result T
    var mu sync.Mutex

    err := hystrix.Do(name,
        func() error {
            val, err := run(ctx)
            if err != nil {
                return err
            }
            mu.Lock()
            result = val
            mu.Unlock()
            return nil
        },
        func(hystrixErr error) error {
            if fallback == nil {
                return hystrixErr
            }
            val, err := fallback(ctx, hystrixErr)
            if err != nil {
                return err
            }
            mu.Lock()
            result = val
            mu.Unlock()
            return nil
        },
    )

    return result, err
}
```

### Hystrix Configuration for Different Service Profiles

```go
// resilience/hystrix_configs.go
package resilience

// InitHystrixCommands configures all Hystrix commands at startup.
func InitHystrixCommands() {
    // Database commands: low concurrency, strict timeout
    ConfigureHystrix("db-read", HystrixCommandConfig{
        Timeout:                500,   // 500ms
        MaxConcurrentRequests:  200,   // database pool size
        RequestVolumeThreshold: 10,
        SleepWindow:            3000,
        ErrorPercentThreshold:  30,    // trip faster for DB
    })

    ConfigureHystrix("db-write", HystrixCommandConfig{
        Timeout:                1000,  // 1s for writes
        MaxConcurrentRequests:  50,    // smaller pool for writes
        RequestVolumeThreshold: 10,
        SleepWindow:            5000,
        ErrorPercentThreshold:  50,
    })

    // Cache: very fast, wide pool
    ConfigureHystrix("cache-get", HystrixCommandConfig{
        Timeout:                100,   // 100ms - cache must be fast
        MaxConcurrentRequests:  500,
        RequestVolumeThreshold: 20,
        SleepWindow:            2000,
        ErrorPercentThreshold:  20,
    })

    // External payment API: strict concurrency (avoid overwhelming provider)
    ConfigureHystrix("payment-charge", HystrixCommandConfig{
        Timeout:                10000, // 10s for payment processing
        MaxConcurrentRequests:  20,    // Don't overwhelm payment provider
        RequestVolumeThreshold: 5,
        SleepWindow:            30000, // 30s recovery window for payments
        ErrorPercentThreshold:  40,
    })

    // Internal user service: moderate
    ConfigureHystrix("user-service-get", HystrixCommandConfig{
        Timeout:                300,
        MaxConcurrentRequests:  100,
        RequestVolumeThreshold: 20,
        SleepWindow:            5000,
        ErrorPercentThreshold:  50,
    })
}
```

## Section 5: Bulkhead Pattern with Goroutine Pools

```go
// resilience/bulkhead.go
package resilience

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "time"

    "go.uber.org/zap"
)

// BulkheadPool is a goroutine pool that limits concurrent executions.
type BulkheadPool struct {
    name        string
    sem         chan struct{}
    logger      *zap.Logger
    metrics     *BulkheadMetrics
    waitTimeout time.Duration

    // Counters
    active  int64
    waiting int64
    total   int64
    dropped int64
}

// BulkheadConfig configures a bulkhead pool.
type BulkheadConfig struct {
    Name        string
    MaxActive   int           // Maximum concurrent executions
    MaxWaiting  int           // Maximum requests waiting in queue
    WaitTimeout time.Duration // How long to wait for a slot
}

// NewBulkheadPool creates a new bulkhead pool.
func NewBulkheadPool(cfg BulkheadConfig, logger *zap.Logger, metrics *BulkheadMetrics) *BulkheadPool {
    return &BulkheadPool{
        name:        cfg.Name,
        sem:         make(chan struct{}, cfg.MaxActive),
        logger:      logger,
        metrics:     metrics,
        waitTimeout: cfg.WaitTimeout,
    }
}

// Execute runs fn within the bulkhead, respecting concurrency limits.
func (p *BulkheadPool) Execute(ctx context.Context, fn func(context.Context) error) error {
    atomic.AddInt64(&p.waiting, 1)

    // Try to acquire a slot
    waitCtx, cancel := context.WithTimeout(ctx, p.waitTimeout)
    defer cancel()

    select {
    case p.sem <- struct{}{}:
        // Got a slot
        atomic.AddInt64(&p.waiting, -1)
        atomic.AddInt64(&p.active, 1)
        atomic.AddInt64(&p.total, 1)

        if p.metrics != nil {
            p.metrics.Active(p.name, int(atomic.LoadInt64(&p.active)))
        }

        defer func() {
            <-p.sem
            atomic.AddInt64(&p.active, -1)

            if p.metrics != nil {
                p.metrics.Active(p.name, int(atomic.LoadInt64(&p.active)))
            }
        }()

        return fn(ctx)

    case <-waitCtx.Done():
        atomic.AddInt64(&p.waiting, -1)
        atomic.AddInt64(&p.dropped, 1)

        if p.metrics != nil {
            p.metrics.Dropped(p.name)
        }

        if ctx.Err() != nil {
            return ctx.Err()
        }
        return fmt.Errorf("bulkhead %q: all %d slots busy, request dropped after waiting %s",
            p.name, cap(p.sem), p.waitTimeout)
    }
}

// Stats returns current bulkhead statistics.
func (p *BulkheadPool) Stats() BulkheadStats {
    return BulkheadStats{
        Name:      p.name,
        MaxActive: cap(p.sem),
        Active:    int(atomic.LoadInt64(&p.active)),
        Waiting:   int(atomic.LoadInt64(&p.waiting)),
        Total:     int(atomic.LoadInt64(&p.total)),
        Dropped:   int(atomic.LoadInt64(&p.dropped)),
    }
}

// BulkheadStats represents current bulkhead state.
type BulkheadStats struct {
    Name      string
    MaxActive int
    Active    int
    Waiting   int
    Total     int
    Dropped   int
}

// BulkheadManager manages multiple bulkhead pools.
type BulkheadManager struct {
    mu     sync.RWMutex
    pools  map[string]*BulkheadPool
    logger *zap.Logger
}

// NewBulkheadManager creates a bulkhead manager.
func NewBulkheadManager(logger *zap.Logger) *BulkheadManager {
    return &BulkheadManager{
        pools:  make(map[string]*BulkheadPool),
        logger: logger,
    }
}

// Register adds a named bulkhead pool.
func (m *BulkheadManager) Register(cfg BulkheadConfig, metrics *BulkheadMetrics) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.pools[cfg.Name] = NewBulkheadPool(cfg, m.logger, metrics)
}

// Execute runs fn within the named bulkhead.
func (m *BulkheadManager) Execute(
    ctx context.Context,
    name string,
    fn func(context.Context) error,
) error {
    m.mu.RLock()
    pool, ok := m.pools[name]
    m.mu.RUnlock()

    if !ok {
        m.logger.Warn("no bulkhead registered, executing directly",
            zap.String("name", name))
        return fn(ctx)
    }

    return pool.Execute(ctx, fn)
}
```

## Section 6: Fallback Implementations

```go
// resilience/fallback.go
package resilience

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Cache is a simple in-memory TTL cache for fallback values.
type Cache[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]cacheItem[V]
}

type cacheItem[V any] struct {
    value   V
    expires time.Time
}

// NewCache creates a new fallback cache.
func NewCache[K comparable, V any]() *Cache[K, V] {
    return &Cache[K, V]{
        items: make(map[K]cacheItem[V]),
    }
}

// Set stores a value with TTL.
func (c *Cache[K, V]) Set(key K, value V, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = cacheItem[V]{
        value:   value,
        expires: time.Now().Add(ttl),
    }
}

// Get retrieves a value if not expired.
func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    item, ok := c.items[key]
    if !ok {
        var zero V
        return zero, false
    }

    if time.Now().After(item.expires) {
        var zero V
        return zero, false
    }

    return item.value, true
}

// WithCacheFallback wraps a function with cache-based fallback.
// On success: stores result in cache
// On failure: returns cached value if available
func WithCacheFallback[K comparable, V any](
    cache *Cache[K, V],
    ttl time.Duration,
    key K,
    primary func(ctx context.Context) (V, error),
) func(ctx context.Context) (V, error) {
    return func(ctx context.Context) (V, error) {
        // Try primary
        result, err := primary(ctx)
        if err == nil {
            // Update cache on success
            cache.Set(key, result, ttl)
            return result, nil
        }

        // On failure, try cache
        if cached, ok := cache.Get(key); ok {
            return cached, nil
        }

        // No fallback available
        var zero V
        return zero, fmt.Errorf("primary failed and no cache available: %w", err)
    }
}

// UserServiceClient demonstrates circuit breaker + fallback pattern.
type UserServiceClient struct {
    breaker  *CircuitBreakerPool
    bulkhead *BulkheadManager
    cache    *Cache[string, *User]
    httpClient HTTPClient
}

// User represents a user model for demonstration.
type User struct {
    ID          string
    Email       string
    DisplayName string
    Roles       []string
}

// HTTPClient is an interface for HTTP client operations.
type HTTPClient interface {
    Get(ctx context.Context, url string) (*User, error)
}

// GetUser retrieves a user with circuit breaker, bulkhead, and cache fallback.
func (c *UserServiceClient) GetUser(ctx context.Context, userID string) (*User, error) {
    var result *User

    // Bulkhead: limit concurrent user service calls
    err := c.bulkhead.Execute(ctx, "user-service", func(ctx context.Context) error {
        // Circuit breaker: fail fast if user service is unhealthy
        val, cbErr := c.breaker.ExecuteContext(ctx, "user-service",
            func(ctx context.Context) (interface{}, error) {
                return c.httpClient.Get(ctx, "/users/"+userID)
            },
        )

        if cbErr != nil {
            // Circuit breaker open or call failed
            // Try cache fallback
            if cached, ok := c.cache.Get(userID); ok {
                result = cached
                return nil  // Success via fallback
            }
            return cbErr  // No fallback available
        }

        user, ok := val.(*User)
        if !ok {
            return fmt.Errorf("unexpected type from user service")
        }

        // Update cache on success
        c.cache.Set(userID, user, 5*time.Minute)
        result = user
        return nil
    })

    if err != nil {
        return nil, err
    }

    return result, nil
}
```

## Section 7: Prometheus Metrics Export

```go
// resilience/metrics.go
package resilience

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/sony/gobreaker"
)

// BreakerMetrics holds Prometheus metrics for circuit breakers.
type BreakerMetrics struct {
    stateGauge      *prometheus.GaugeVec
    requestsTotal   *prometheus.CounterVec
    failuresTotal   *prometheus.CounterVec
    successesTotal  *prometheus.CounterVec
    openDuration    *prometheus.HistogramVec
    stateChanges    *prometheus.CounterVec
}

// NewBreakerMetrics creates Prometheus metrics for circuit breakers.
func NewBreakerMetrics(namespace string) *BreakerMetrics {
    return &BreakerMetrics{
        stateGauge: promauto.NewGaugeVec(
            prometheus.GaugeOpts{
                Namespace: namespace,
                Name:      "circuit_breaker_state",
                Help:      "Current state of circuit breaker (0=closed, 1=half-open, 2=open)",
            },
            []string{"breaker"},
        ),
        requestsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "circuit_breaker_requests_total",
                Help:      "Total requests through circuit breaker",
            },
            []string{"breaker", "result"},
        ),
        failuresTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "circuit_breaker_failures_total",
                Help:      "Total failures recorded by circuit breaker",
            },
            []string{"breaker"},
        ),
        successesTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "circuit_breaker_successes_total",
                Help:      "Total successes recorded by circuit breaker",
            },
            []string{"breaker"},
        ),
        stateChanges: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "circuit_breaker_state_changes_total",
                Help:      "Total number of state changes",
            },
            []string{"breaker", "from", "to"},
        ),
    }
}

// StateChange records a circuit breaker state transition.
func (m *BreakerMetrics) StateChange(name string, from, to gobreaker.State) {
    m.stateChanges.WithLabelValues(name, from.String(), to.String()).Inc()

    var stateValue float64
    switch to {
    case gobreaker.StateClosed:
        stateValue = 0
    case gobreaker.StateHalfOpen:
        stateValue = 1
    case gobreaker.StateOpen:
        stateValue = 2
    }
    m.stateGauge.WithLabelValues(name).Set(stateValue)
}

// Success records a successful execution.
func (m *BreakerMetrics) Success(name string) {
    m.requestsTotal.WithLabelValues(name, "success").Inc()
    m.successesTotal.WithLabelValues(name).Inc()
}

// Failure records a failed execution.
func (m *BreakerMetrics) Failure(name string) {
    m.requestsTotal.WithLabelValues(name, "failure").Inc()
    m.failuresTotal.WithLabelValues(name).Inc()
}

// Rejected records a rejected execution (circuit open).
func (m *BreakerMetrics) Rejected(name string) {
    m.requestsTotal.WithLabelValues(name, "rejected").Inc()
}

// BulkheadMetrics holds Prometheus metrics for bulkheads.
type BulkheadMetrics struct {
    activeGauge    *prometheus.GaugeVec
    droppedTotal   *prometheus.CounterVec
    executionsTotal *prometheus.CounterVec
    waitDuration   *prometheus.HistogramVec
}

// NewBulkheadMetrics creates Prometheus metrics for bulkheads.
func NewBulkheadMetrics(namespace string) *BulkheadMetrics {
    return &BulkheadMetrics{
        activeGauge: promauto.NewGaugeVec(
            prometheus.GaugeOpts{
                Namespace: namespace,
                Name:      "bulkhead_active_requests",
                Help:      "Current number of active requests in bulkhead",
            },
            []string{"bulkhead"},
        ),
        droppedTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "bulkhead_dropped_requests_total",
                Help:      "Total requests dropped by bulkhead (pool full)",
            },
            []string{"bulkhead"},
        ),
        executionsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "bulkhead_executions_total",
                Help:      "Total executions through bulkhead",
            },
            []string{"bulkhead", "result"},
        ),
        waitDuration: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: namespace,
                Name:      "bulkhead_wait_duration_seconds",
                Help:      "Time spent waiting for a bulkhead slot",
                Buckets:   []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
            },
            []string{"bulkhead"},
        ),
    }
}

// Active records the current active request count.
func (m *BulkheadMetrics) Active(name string, count int) {
    m.activeGauge.WithLabelValues(name).Set(float64(count))
}

// Dropped records a dropped request.
func (m *BulkheadMetrics) Dropped(name string) {
    m.droppedTotal.WithLabelValues(name).Inc()
    m.executionsTotal.WithLabelValues(name, "dropped").Inc()
}
```

## Section 8: Hystrix Prometheus Integration

```go
// resilience/hystrix_metrics.go
package resilience

import (
    "github.com/afex/hystrix-go/hystrix"
    "github.com/afex/hystrix-go/hystrix/metric_collector"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// HystrixPrometheusCollector exports Hystrix metrics to Prometheus.
type HystrixPrometheusCollector struct {
    namespace string
    metrics   map[string]*hystrixCommandMetrics
}

type hystrixCommandMetrics struct {
    attempts   prometheus.Counter
    errors     prometheus.Counter
    successes  prometheus.Counter
    rejections prometheus.Counter
    timeouts   prometheus.Counter
    shortCircuits prometheus.Counter
    state      prometheus.Gauge
}

// RegisterHystrixPrometheusCollector registers Hystrix metrics with Prometheus.
func RegisterHystrixPrometheusCollector(namespace string) {
    collector := &HystrixPrometheusCollector{
        namespace: namespace,
        metrics:   make(map[string]*hystrixCommandMetrics),
    }

    metricCollector.Registry.Register(func(name string) metricCollector.MetricCollector {
        m := &hystrixPrometheusMetricCollector{
            parent:      collector,
            commandName: name,
        }
        collector.initMetrics(name)
        return m
    })
}

func (c *HystrixPrometheusCollector) initMetrics(name string) {
    c.metrics[name] = &hystrixCommandMetrics{
        attempts: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_attempts_total",
            Help:        "Total Hystrix command attempts",
            ConstLabels: prometheus.Labels{"command": name},
        }),
        errors: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_errors_total",
            Help:        "Total Hystrix command errors",
            ConstLabels: prometheus.Labels{"command": name},
        }),
        successes: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_successes_total",
            Help:        "Total Hystrix command successes",
            ConstLabels: prometheus.Labels{"command": name},
        }),
        rejections: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_rejections_total",
            Help:        "Total Hystrix command rejections (circuit open)",
            ConstLabels: prometheus.Labels{"command": name},
        }),
        timeouts: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_timeouts_total",
            Help:        "Total Hystrix command timeouts",
            ConstLabels: prometheus.Labels{"command": name},
        }),
        shortCircuits: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_short_circuits_total",
            Help:        "Total Hystrix short circuits",
            ConstLabels: prometheus.Labels{"command": name},
        }),
        state: promauto.NewGauge(prometheus.GaugeOpts{
            Namespace:   c.namespace,
            Name:        "hystrix_circuit_open",
            Help:        "Whether the Hystrix circuit is open (1=open, 0=closed)",
            ConstLabels: prometheus.Labels{"command": name},
        }),
    }
}

type hystrixPrometheusMetricCollector struct {
    parent      *HystrixPrometheusCollector
    commandName string
}

func (h *hystrixPrometheusMetricCollector) IncrementAttempts() {
    if m, ok := h.parent.metrics[h.commandName]; ok {
        m.attempts.Inc()
    }
}

func (h *hystrixPrometheusMetricCollector) IncrementErrors(duration float64) {
    if m, ok := h.parent.metrics[h.commandName]; ok {
        m.errors.Inc()
    }
}

func (h *hystrixPrometheusMetricCollector) IncrementSuccesses() {
    if m, ok := h.parent.metrics[h.commandName]; ok {
        m.successes.Inc()
    }
}

func (h *hystrixPrometheusMetricCollector) IncrementRejects() {
    if m, ok := h.parent.metrics[h.commandName]; ok {
        m.rejections.Inc()
    }
}

func (h *hystrixPrometheusMetricCollector) IncrementShortCircuits() {
    if m, ok := h.parent.metrics[h.commandName]; ok {
        m.shortCircuits.Inc()
    }
}

func (h *hystrixPrometheusMetricCollector) IncrementTimeouts() {
    if m, ok := h.parent.metrics[h.commandName]; ok {
        m.timeouts.Inc()
    }
}

func (h *hystrixPrometheusMetricCollector) IncrementFallbackSuccesses() {}
func (h *hystrixPrometheusMetricCollector) IncrementFallbackFailures()  {}
func (h *hystrixPrometheusMetricCollector) UpdateTotalDuration(timeSinceStart float64) {}
func (h *hystrixPrometheusMetricCollector) UpdateRunDuration(runDuration float64) {}
func (h *hystrixPrometheusMetricCollector) Reset() {}
```

## Section 9: Complete Integration Example

```go
// cmd/service/main.go - Service with full resilience stack
package main

import (
    "context"
    "net/http"
    "time"

    "go.uber.org/zap"

    "github.com/yourorg/service/resilience"
)

type APIClient struct {
    pool     *resilience.CircuitBreakerPool
    bulkhead *resilience.BulkheadManager
    cache    *resilience.Cache[string, interface{}]
    logger   *zap.Logger
}

func NewAPIClient(logger *zap.Logger) *APIClient {
    breakerMetrics := resilience.NewBreakerMetrics("myservice")
    bulkheadMetrics := resilience.NewBulkheadMetrics("myservice")

    pool := resilience.NewCircuitBreakerPool(logger, breakerMetrics)
    bulkhead := resilience.NewBulkheadManager(logger)

    // Register circuit breakers
    for name, cfg := range resilience.ServiceBreakerConfigs() {
        pool.Register(cfg)
        _ = name
    }

    // Register bulkheads
    bulkhead.Register(resilience.BulkheadConfig{
        Name:        "user-service",
        MaxActive:   50,
        MaxWaiting:  100,
        WaitTimeout: 500 * time.Millisecond,
    }, bulkheadMetrics)

    bulkhead.Register(resilience.BulkheadConfig{
        Name:        "payment-service",
        MaxActive:   10,
        MaxWaiting:  20,
        WaitTimeout: 2 * time.Second,
    }, bulkheadMetrics)

    return &APIClient{
        pool:     pool,
        bulkhead: bulkhead,
        cache:    resilience.NewCache[string, interface{}](),
        logger:   logger,
    }
}

func (c *APIClient) GetUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
    var profile *UserProfile

    err := c.bulkhead.Execute(ctx, "user-service", func(ctx context.Context) error {
        val, err := c.pool.ExecuteContext(ctx, "user-service-get",
            func(ctx context.Context) (interface{}, error) {
                // Make actual HTTP call
                return fetchUserProfile(ctx, userID)
            },
        )

        if err != nil {
            // Fallback to cached value
            if cached, ok := c.cache.Get("user:" + userID); ok {
                if p, ok := cached.(*UserProfile); ok {
                    c.logger.Warn("using cached user profile due to service error",
                        zap.String("user_id", userID),
                        zap.Error(err),
                    )
                    profile = p
                    return nil
                }
            }
            return err
        }

        p, ok := val.(*UserProfile)
        if !ok {
            return nil
        }

        // Cache successful response
        c.cache.Set("user:"+userID, p, 5*time.Minute)
        profile = p
        return nil
    })

    if err != nil {
        return nil, err
    }

    return profile, nil
}

type UserProfile struct {
    ID    string
    Email string
}

func fetchUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
    // HTTP call implementation
    req, err := http.NewRequestWithContext(ctx, "GET",
        "http://user-service/profiles/"+userID, nil)
    if err != nil {
        return nil, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("user service returned %d", resp.StatusCode)
    }

    // decode response...
    return &UserProfile{ID: userID}, nil
}
```

## Section 10: Prometheus Alerting for Circuit Breakers

```yaml
# circuit-breaker-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: circuit-breaker-alerts
  namespace: monitoring
spec:
  groups:
    - name: circuit.breaker
      rules:
        - alert: CircuitBreakerOpen
          expr: myservice_circuit_breaker_state == 2
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Circuit breaker {{ $labels.breaker }} is OPEN"
            description: "The circuit breaker for {{ $labels.breaker }} has been open for 1 minute. All calls are being rejected."

        - alert: CircuitBreakerHighErrorRate
          expr: >
            rate(myservice_circuit_breaker_failures_total[5m]) /
            rate(myservice_circuit_breaker_requests_total[5m]) > 0.5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Circuit breaker {{ $labels.breaker }} high error rate"
            description: "Circuit breaker {{ $labels.breaker }} failure rate exceeds 50%. Circuit may open soon."

        - alert: BulkheadSaturation
          expr: myservice_bulkhead_active_requests / on(bulkhead) myservice_bulkhead_max_requests > 0.9
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Bulkhead {{ $labels.bulkhead }} near saturation"
            description: "Bulkhead {{ $labels.bulkhead }} is at {{ $value | humanizePercentage }} capacity. Request drops likely."

        - alert: BulkheadDropping
          expr: rate(myservice_bulkhead_dropped_requests_total[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Bulkhead {{ $labels.bulkhead }} is dropping requests"
            description: "Requests are being dropped due to bulkhead saturation. Scale the downstream service or increase pool size."
```

The combination of circuit breakers, bulkheads, and fallbacks creates a resilience layer that protects services from cascading failures while maintaining degraded service availability. The key operational principle is that each pattern addresses a specific failure mode: circuit breakers prevent overloading failing services, bulkheads prevent resource exhaustion, and fallbacks ensure some functionality remains even when dependencies are unavailable.
