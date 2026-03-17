---
title: "Go Microservices Patterns: Circuit Breakers, Retries, and Service Discovery"
date: 2028-04-03T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "Circuit Breaker", "Resilience", "Service Discovery", "Consul", "Kubernetes"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Go microservices resilience patterns covering circuit breakers with sony/gobreaker, retry with exponential backoff and jitter, timeout propagation via context, bulkhead semaphore isolation, service discovery with Consul and Kubernetes DNS, health check semantics, and graceful shutdown."
more_link: "yes"
url: "/go-microservices-patterns-guide/"
---

Microservices resilience patterns address a single fundamental problem: networked calls fail. Servers crash, networks partition, downstream services become slow, and partial failures create worse outcomes than complete failures. The patterns covered in this guide — circuit breakers, retries with jitter, bulkheads, and graceful timeouts — are not theoretical constructs. They are the difference between a degraded service that continues operating and a cascading failure that takes down a system.

<!--more-->

## Circuit Breaker with sony/gobreaker

The circuit breaker pattern prevents an application from repeatedly calling an operation that is likely to fail. After a threshold of failures, the circuit "opens" and subsequent calls fail immediately without attempting the network call, giving the downstream service time to recover.

```
Closed (normal)  ──► too many failures ──► Open (failing fast)
      ▲                                           │
      │                                     timeout elapsed
      │                                           │
      └──────── probe succeeds ◄── Half-Open (single probe attempt)
                                    │
                              probe fails ──► Open
```

### Implementation

```go
package resilience

import (
    "context"
    "fmt"
    "time"

    "github.com/sony/gobreaker/v2"
)

// CircuitBreakerConfig holds the configuration for a circuit breaker.
type CircuitBreakerConfig struct {
    Name          string
    MaxRequests   uint32        // Requests in half-open state
    Interval      time.Duration // Window for counting failures
    Timeout       time.Duration // Time to wait in open state before probing
    FailureRatio  float64       // Failure ratio threshold (0.0-1.0)
    MinRequests   uint32        // Minimum requests before evaluating failure ratio
}

// DefaultCircuitBreakerConfig returns sensible production defaults.
func DefaultCircuitBreakerConfig(name string) CircuitBreakerConfig {
    return CircuitBreakerConfig{
        Name:         name,
        MaxRequests:  3,
        Interval:     60 * time.Second,
        Timeout:      30 * time.Second,
        FailureRatio: 0.6,   // Open circuit when 60% of requests fail
        MinRequests:  10,    // Need at least 10 requests before evaluating
    }
}

// NewCircuitBreaker creates a configured gobreaker circuit breaker.
func NewCircuitBreaker[T any](cfg CircuitBreakerConfig) *gobreaker.CircuitBreaker[T] {
    settings := gobreaker.Settings{
        Name:        cfg.Name,
        MaxRequests: cfg.MaxRequests,
        Interval:    cfg.Interval,
        Timeout:     cfg.Timeout,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            if counts.Requests < uint32(cfg.MinRequests) {
                return false
            }
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return failureRatio >= cfg.FailureRatio
        },
        OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
            // Log state transitions for observability
            fmt.Printf("circuit breaker %s: %s -> %s\n", name, from, to)
            // Emit metric here in production
        },
        IsSuccessful: func(err error) bool {
            if err == nil {
                return true
            }
            // Certain errors should not count as circuit breaker failures
            // e.g., client errors (4xx) are not the downstream's fault
            switch {
            case isClientError(err):
                return true  // Don't count 4xx errors against the circuit
            default:
                return false
            }
        },
    }

    return gobreaker.NewCircuitBreaker[T](settings)
}

// CircuitBreakerMiddleware wraps an HTTP client with circuit breaker protection.
type CircuitBreakerMiddleware struct {
    breaker *gobreaker.CircuitBreaker[*http.Response]
    next    http.RoundTripper
}

func (m *CircuitBreakerMiddleware) RoundTrip(req *http.Request) (*http.Response, error) {
    result, err := m.breaker.Execute(func() (*http.Response, error) {
        resp, err := m.next.RoundTrip(req)
        if err != nil {
            return nil, err
        }
        // Treat server errors as circuit breaker failures
        if resp.StatusCode >= 500 {
            return resp, fmt.Errorf("server error: %d", resp.StatusCode)
        }
        return resp, nil
    })

    if err != nil {
        if err == gobreaker.ErrOpenState {
            return nil, fmt.Errorf("circuit open for %s: refusing call, service appears unavailable",
                req.URL.Host)
        }
        return nil, err
    }

    return result, nil
}
```

### Circuit Breaker State Monitoring

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/sony/gobreaker/v2"
)

var (
    circuitBreakerState = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "circuit_breaker_state",
        Help: "Current state of circuit breakers (0=closed, 1=half-open, 2=open)",
    }, []string{"name"})

    circuitBreakerRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "circuit_breaker_requests_total",
        Help: "Total requests through circuit breakers",
    }, []string{"name", "result"})
)

func RecordStateChange(name string, from, to gobreaker.State) {
    stateValue := map[gobreaker.State]float64{
        gobreaker.StateClosed:   0,
        gobreaker.StateHalfOpen: 1,
        gobreaker.StateOpen:     2,
    }
    if v, ok := stateValue[to]; ok {
        circuitBreakerState.WithLabelValues(name).Set(v)
    }
}
```

## Retry with Exponential Backoff and Jitter

Retries amplify load on an already-struggling service if not carefully implemented. Exponential backoff with full jitter prevents retry storms:

```go
package resilience

import (
    "context"
    "fmt"
    "math"
    "math/rand"
    "time"
)

// RetryConfig configures the retry behavior.
type RetryConfig struct {
    MaxAttempts int
    InitialWait time.Duration
    MaxWait     time.Duration
    Multiplier  float64
    // Jitter fraction (0.0-1.0): 0 = no jitter, 1.0 = full jitter
    JitterFactor float64
}

var DefaultRetryConfig = RetryConfig{
    MaxAttempts:  4,
    InitialWait:  100 * time.Millisecond,
    MaxWait:      30 * time.Second,
    Multiplier:   2.0,
    JitterFactor: 0.5,  // Half jitter
}

// IsRetryable determines if an error should be retried.
type IsRetryable func(err error) bool

// DefaultIsRetryable retries on transient errors but not client errors.
func DefaultIsRetryable(err error) bool {
    if err == nil {
        return false
    }
    if isClientError(err) {
        return false  // Don't retry 400, 401, 403, 404, etc.
    }
    return true  // Retry 500, 502, 503, 504, connection errors, timeouts
}

// Retry executes fn with retry and backoff.
// Returns the last error if all attempts fail.
func Retry(ctx context.Context, cfg RetryConfig, isRetryable IsRetryable,
    fn func(ctx context.Context) error) error {

    var lastErr error

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        select {
        case <-ctx.Done():
            return fmt.Errorf("retry canceled after %d attempts: %w", attempt, ctx.Err())
        default:
        }

        lastErr = fn(ctx)
        if lastErr == nil {
            return nil
        }

        if !isRetryable(lastErr) {
            return fmt.Errorf("non-retryable error on attempt %d: %w", attempt+1, lastErr)
        }

        if attempt == cfg.MaxAttempts-1 {
            break  // Last attempt — don't wait
        }

        wait := calculateBackoff(attempt, cfg)

        select {
        case <-ctx.Done():
            return fmt.Errorf("retry canceled during backoff after %d attempts: %w",
                attempt+1, ctx.Err())
        case <-time.After(wait):
        }
    }

    return fmt.Errorf("all %d retry attempts failed, last error: %w",
        cfg.MaxAttempts, lastErr)
}

// calculateBackoff computes the wait duration for the given attempt number.
// Uses exponential backoff with jitter to prevent retry storms.
func calculateBackoff(attempt int, cfg RetryConfig) time.Duration {
    // Exponential backoff: initialWait * multiplier^attempt
    base := float64(cfg.InitialWait) * math.Pow(cfg.Multiplier, float64(attempt))

    // Cap at max wait
    if base > float64(cfg.MaxWait) {
        base = float64(cfg.MaxWait)
    }

    // Add jitter: random value between (1-jitterFactor)*base and base
    // Full jitter (JitterFactor=1.0): sleep = random between 0 and base
    // No jitter (JitterFactor=0.0): sleep = base (deterministic)
    jitter := cfg.JitterFactor * base
    wait := base - jitter + (rand.Float64() * 2 * jitter)

    return time.Duration(wait)
}

// RetryWithResult is a generic version that returns a value.
func RetryWithResult[T any](ctx context.Context, cfg RetryConfig, isRetryable IsRetryable,
    fn func(ctx context.Context) (T, error)) (T, error) {

    var lastErr error
    var zero T

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        select {
        case <-ctx.Done():
            return zero, fmt.Errorf("retry canceled: %w", ctx.Err())
        default:
        }

        result, err := fn(ctx)
        if err == nil {
            return result, nil
        }
        lastErr = err

        if !isRetryable(err) {
            return zero, fmt.Errorf("non-retryable: %w", err)
        }

        if attempt == cfg.MaxAttempts-1 {
            break
        }

        time.Sleep(calculateBackoff(attempt, cfg))
    }

    return zero, fmt.Errorf("all attempts failed: %w", lastErr)
}
```

## Timeout Propagation via Context

Context deadlines must be propagated through the entire call chain. A timeout that exists only at the outermost layer allows downstream calls to run indefinitely:

```go
package client

import (
    "context"
    "fmt"
    "net/http"
    "time"
)

// ServiceClient wraps an HTTP client with resilience patterns.
type ServiceClient struct {
    baseURL   string
    http      *http.Client
    breaker   *CircuitBreaker
    logger    *slog.Logger
}

type TimeoutConfig struct {
    // Per-call timeout: maximum time for a single attempt
    CallTimeout time.Duration
    // Total timeout: maximum time for all attempts (including retries)
    TotalTimeout time.Duration
}

// Call executes an HTTP request with timeout, retry, and circuit breaker.
func (c *ServiceClient) Call(ctx context.Context, req *http.Request, tcfg TimeoutConfig) (*http.Response, error) {
    // 1. Apply total timeout (all retries must complete within this)
    if tcfg.TotalTimeout > 0 {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, tcfg.TotalTimeout)
        defer cancel()
    }

    return RetryWithResult(ctx, DefaultRetryConfig, DefaultIsRetryable,
        func(ctx context.Context) (*http.Response, error) {
            // 2. Apply per-call timeout (individual attempt budget)
            callCtx := ctx
            if tcfg.CallTimeout > 0 {
                var cancel context.CancelFunc
                callCtx, cancel = context.WithTimeout(ctx, tcfg.CallTimeout)
                defer cancel()
            }

            // 3. Execute through circuit breaker
            resp, err := c.breaker.Execute(func() (*http.Response, error) {
                req = req.WithContext(callCtx)
                return c.http.Do(req)
            })

            return resp, err
        },
    )
}

// Propagate deadline information to downstream services via headers.
// This allows downstream services to fail fast if the upstream deadline is near.
func PropagateDeadline(ctx context.Context, req *http.Request) {
    if deadline, ok := ctx.Deadline(); ok {
        remaining := time.Until(deadline)
        if remaining > 0 {
            // Standard header for deadline propagation
            req.Header.Set("X-Timeout-Ms", fmt.Sprintf("%d", remaining.Milliseconds()))
        }
    }
}

// ObserveDeadline reads the deadline from an incoming request and applies it.
func ObserveDeadline(ctx context.Context, r *http.Request) (context.Context, context.CancelFunc) {
    timeoutMsStr := r.Header.Get("X-Timeout-Ms")
    if timeoutMsStr == "" {
        return ctx, func() {}
    }

    var timeoutMs int64
    if _, err := fmt.Sscanf(timeoutMsStr, "%d", &timeoutMs); err != nil {
        return ctx, func() {}
    }

    // Apply a safety margin: don't use the full upstream timeout
    effectiveTimeout := time.Duration(timeoutMs)*time.Millisecond - 50*time.Millisecond
    if effectiveTimeout <= 0 {
        // Upstream deadline already exceeded — fail immediately
        ctx, cancel := context.WithCancel(ctx)
        cancel()
        return ctx, func() {}
    }

    return context.WithTimeout(ctx, effectiveTimeout)
}
```

## Bulkhead Pattern with Semaphore

The bulkhead pattern limits the number of concurrent calls to a dependency, preventing a slow downstream from exhausting all goroutines:

```go
package resilience

import (
    "context"
    "fmt"
    "time"
)

// Bulkhead limits concurrent access to a resource using a semaphore.
type Bulkhead struct {
    sem     chan struct{}
    name    string
    timeout time.Duration
}

// NewBulkhead creates a bulkhead with the given concurrency limit.
func NewBulkhead(name string, maxConcurrent int, acquireTimeout time.Duration) *Bulkhead {
    return &Bulkhead{
        sem:     make(chan struct{}, maxConcurrent),
        name:    name,
        timeout: acquireTimeout,
    }
}

// Execute runs fn within the bulkhead's concurrency limit.
func (b *Bulkhead) Execute(ctx context.Context, fn func() error) error {
    // Attempt to acquire a slot
    acquireCtx, cancel := context.WithTimeout(ctx, b.timeout)
    defer cancel()

    select {
    case b.sem <- struct{}{}:
        // Slot acquired
    case <-acquireCtx.Done():
        if acquireCtx.Err() == context.DeadlineExceeded {
            return fmt.Errorf("bulkhead %s: acquire timeout after %s (all %d slots busy)",
                b.name, b.timeout, cap(b.sem))
        }
        return fmt.Errorf("bulkhead %s: context canceled while waiting for slot: %w",
            b.name, ctx.Err())
    }

    defer func() { <-b.sem }()  // Release slot when done

    return fn()
}

// Available returns the number of available slots.
func (b *Bulkhead) Available() int {
    return cap(b.sem) - len(b.sem)
}

// InUse returns the number of slots currently in use.
func (b *Bulkhead) InUse() int {
    return len(b.sem)
}

// Example: Different bulkheads for different dependencies
type PaymentServiceClient struct {
    http           *http.Client
    paymentBH      *Bulkhead  // Max 20 concurrent payment calls
    fraudCheckBH   *Bulkhead  // Max 10 concurrent fraud checks
    notificationBH *Bulkhead  // Max 50 concurrent notifications
}

func NewPaymentServiceClient(httpClient *http.Client) *PaymentServiceClient {
    return &PaymentServiceClient{
        http:           httpClient,
        paymentBH:      NewBulkhead("payment-processor", 20, 2*time.Second),
        fraudCheckBH:   NewBulkhead("fraud-check", 10, 5*time.Second),
        notificationBH: NewBulkhead("notification", 50, 1*time.Second),
    }
}
```

## Service Discovery

### Kubernetes DNS-Based Discovery

In Kubernetes, service discovery uses DNS:

```go
package discovery

import (
    "fmt"
    "net/http"
)

// KubernetesServiceURL builds a service URL using Kubernetes DNS conventions.
func KubernetesServiceURL(service, namespace, port string) string {
    // FQDN: <service>.<namespace>.svc.cluster.local
    return fmt.Sprintf("http://%s.%s.svc.cluster.local:%s", service, namespace, port)
}

// Headless service URL for StatefulSet pods
func KubernetesStatefulPodURL(podName, service, namespace, port string) string {
    // Individual pod DNS: <pod>.<service>.<namespace>.svc.cluster.local
    return fmt.Sprintf("http://%s.%s.%s.svc.cluster.local:%s",
        podName, service, namespace, port)
}

// ServiceClient that uses Kubernetes DNS with a client-side load balancer
type KubernetesServiceClient struct {
    baseURL string
    client  *http.Client
}

func NewKubernetesServiceClient(service, namespace, port string) *KubernetesServiceClient {
    return &KubernetesServiceClient{
        baseURL: KubernetesServiceURL(service, namespace, port),
        client: &http.Client{
            Timeout: 30 * time.Second,
            Transport: &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 10,
                IdleConnTimeout:     90 * time.Second,
                // Important: disable HTTP/2 if load balancing with multiple pods
                // HTTP/2 multiplexes all requests on one connection, defeating per-request LB
                ForceAttemptHTTP2: false,
            },
        },
    }
}
```

### Consul-Based Service Discovery

```go
package discovery

import (
    "context"
    "fmt"
    "math/rand"
    "time"

    consulapi "github.com/hashicorp/consul/api"
)

// ConsulResolver resolves service endpoints from Consul.
type ConsulResolver struct {
    client  *consulapi.Client
    cache   map[string][]*consulapi.AgentService
    cacheTTL time.Duration
    cacheTime map[string]time.Time
    mu      sync.RWMutex
}

func NewConsulResolver(addr string, cacheTTL time.Duration) (*ConsulResolver, error) {
    cfg := consulapi.DefaultConfig()
    cfg.Address = addr

    client, err := consulapi.NewClient(cfg)
    if err != nil {
        return nil, fmt.Errorf("create consul client: %w", err)
    }

    return &ConsulResolver{
        client:    client,
        cache:     make(map[string][]*consulapi.AgentService),
        cacheTTL:  cacheTTL,
        cacheTime: make(map[string]time.Time),
    }, nil
}

// Resolve returns a random healthy instance of the named service.
func (r *ConsulResolver) Resolve(ctx context.Context, serviceName string) (string, error) {
    instances, err := r.getInstances(ctx, serviceName)
    if err != nil {
        return "", err
    }

    if len(instances) == 0 {
        return "", fmt.Errorf("no healthy instances for service %s", serviceName)
    }

    // Random selection (client-side load balancing)
    instance := instances[rand.Intn(len(instances))]
    return fmt.Sprintf("%s:%d", instance.Address, instance.Port), nil
}

func (r *ConsulResolver) getInstances(ctx context.Context, serviceName string) ([]*consulapi.AgentService, error) {
    r.mu.RLock()
    if instances, ok := r.cache[serviceName]; ok {
        if time.Since(r.cacheTime[serviceName]) < r.cacheTTL {
            r.mu.RUnlock()
            return instances, nil
        }
    }
    r.mu.RUnlock()

    // Cache miss or expired: query Consul
    health := r.client.Health()
    entries, _, err := health.Service(serviceName, "", true, &consulapi.QueryOptions{
        Context: ctx,
    })
    if err != nil {
        return nil, fmt.Errorf("consul query for %s: %w", serviceName, err)
    }

    instances := make([]*consulapi.AgentService, len(entries))
    for i, entry := range entries {
        instances[i] = entry.Service
    }

    r.mu.Lock()
    r.cache[serviceName] = instances
    r.cacheTime[serviceName] = time.Now()
    r.mu.Unlock()

    return instances, nil
}
```

## Health Check Endpoints

Health checks have two distinct semantics in Kubernetes:

- **Liveness**: Is the process stuck? If this fails, the pod is restarted.
- **Readiness**: Is the pod ready to serve traffic? If this fails, the pod is removed from Service endpoints.

```go
package health

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "sync"
    "time"
)

// Check is a named health check function.
type Check struct {
    Name    string
    Check   func(ctx context.Context) error
    Timeout time.Duration
}

// Handler provides HTTP health check endpoints.
type Handler struct {
    readinessChecks []Check
    livenessChecks  []Check
    startupChecks   []Check
    mu              sync.RWMutex
    ready           bool
}

func NewHandler() *Handler {
    return &Handler{ready: false}
}

// AddReadinessCheck registers a check for the /readyz endpoint.
// Failing readiness removes the pod from load balancer rotation.
// Use for: database connectivity, dependency availability.
func (h *Handler) AddReadinessCheck(check Check) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.readinessChecks = append(h.readinessChecks, check)
}

// AddLivenessCheck registers a check for the /livez endpoint.
// Failing liveness triggers a pod restart.
// Use ONLY for: deadlock detection, stuck goroutines.
// WARNING: Do NOT add external dependency checks to liveness.
// A failing database should NOT restart the pod; it should stop routing traffic (readiness).
func (h *Handler) AddLivenessCheck(check Check) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.livenessChecks = append(h.livenessChecks, check)
}

type healthResponse struct {
    Status string                 `json:"status"`
    Checks map[string]checkResult `json:"checks,omitempty"`
}

type checkResult struct {
    Status  string `json:"status"`
    Message string `json:"message,omitempty"`
    Latency string `json:"latency,omitempty"`
}

func (h *Handler) ServeReadyz(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    h.mu.RLock()
    checks := h.readinessChecks
    h.mu.RUnlock()

    response, allPassed := runChecks(ctx, checks)

    statusCode := http.StatusOK
    if !allPassed {
        statusCode = http.StatusServiceUnavailable
        response.Status = "not ready"
    } else {
        response.Status = "ready"
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(statusCode)
    _ = json.NewEncoder(w).Encode(response)
}

func (h *Handler) ServeLivez(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    h.mu.RLock()
    checks := h.livenessChecks
    h.mu.RUnlock()

    response, allPassed := runChecks(ctx, checks)

    statusCode := http.StatusOK
    if !allPassed {
        statusCode = http.StatusServiceUnavailable
        response.Status = "unhealthy"
    } else {
        response.Status = "healthy"
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(statusCode)
    _ = json.NewEncoder(w).Encode(response)
}

func runChecks(ctx context.Context, checks []Check) (healthResponse, bool) {
    allPassed := true
    results := make(map[string]checkResult)

    for _, check := range checks {
        start := time.Now()

        checkCtx := ctx
        if check.Timeout > 0 {
            var cancel context.CancelFunc
            checkCtx, cancel = context.WithTimeout(ctx, check.Timeout)
            defer cancel()
        }

        err := check.Check(checkCtx)
        elapsed := time.Since(start)

        if err != nil {
            allPassed = false
            results[check.Name] = checkResult{
                Status:  "fail",
                Message: err.Error(),
                Latency: elapsed.String(),
            }
        } else {
            results[check.Name] = checkResult{
                Status:  "pass",
                Latency: elapsed.String(),
            }
        }
    }

    return healthResponse{Checks: results}, allPassed
}

// Example registrations in main.go:
func setupHealthChecks(handler *health.Handler, db *sql.DB, redisClient *redis.Client) {
    // Readiness: service is ready when database is reachable
    handler.AddReadinessCheck(health.Check{
        Name:    "database",
        Timeout: 2 * time.Second,
        Check: func(ctx context.Context) error {
            return db.PingContext(ctx)
        },
    })

    handler.AddReadinessCheck(health.Check{
        Name:    "redis",
        Timeout: 1 * time.Second,
        Check: func(ctx context.Context) error {
            return redisClient.Ping(ctx).Err()
        },
    })

    // Liveness: only check if the goroutine scheduler is responsive
    // (no external dependency checks in liveness)
    handler.AddLivenessCheck(health.Check{
        Name:    "goroutine-scheduler",
        Timeout: 100 * time.Millisecond,
        Check: func(ctx context.Context) error {
            done := make(chan struct{}, 1)
            go func() { done <- struct{}{} }()
            select {
            case <-done:
                return nil
            case <-ctx.Done():
                return fmt.Errorf("goroutine scheduler unresponsive")
            }
        },
    })
}
```

## Graceful Shutdown Sequence

The shutdown sequence must drain in-flight requests, close dependencies in reverse order, and respect the Kubernetes termination grace period:

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

type GracefulServer struct {
    http     *http.Server
    logger   *slog.Logger
    cleanups []func(ctx context.Context) error
}

// AddCleanup registers a function to call during shutdown.
// Functions are called in LIFO order (last registered, first called).
func (s *GracefulServer) AddCleanup(fn func(ctx context.Context) error) {
    s.cleanups = append(s.cleanups, fn)
}

func (s *GracefulServer) Run() error {
    // Start server in background
    serverErr := make(chan error, 1)
    go func() {
        s.logger.Info("starting HTTP server", "addr", s.http.Addr)
        if err := s.http.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            serverErr <- err
        }
        close(serverErr)
    }()

    // Wait for shutdown signal or server error
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    select {
    case err := <-serverErr:
        return fmt.Errorf("server error: %w", err)
    case sig := <-quit:
        s.logger.Info("shutdown signal received", "signal", sig)
    }

    return s.shutdown()
}

func (s *GracefulServer) shutdown() error {
    // Total shutdown budget: must complete before Kubernetes force-kills
    // Set terminationGracePeriodSeconds in the Pod spec to match or exceed this
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Step 1: Stop accepting new requests
    // Kubernetes should have already removed the pod from Service endpoints
    // (the preStop hook or readiness failure handles this)
    s.logger.Info("stopping HTTP server")
    if err := s.http.Shutdown(shutdownCtx); err != nil {
        s.logger.Error("HTTP server shutdown error", "error", err)
    }

    // Step 2: Execute cleanup functions in reverse order
    for i := len(s.cleanups) - 1; i >= 0; i-- {
        cleanup := s.cleanups[i]
        if err := cleanup(shutdownCtx); err != nil {
            s.logger.Error("cleanup error", "index", i, "error", err)
        }
    }

    s.logger.Info("shutdown complete")
    return nil
}
```

### Kubernetes preStop Hook for Graceful Endpoint Removal

```yaml
spec:
  terminationGracePeriodSeconds: 60
  containers:
    - name: api-service
      lifecycle:
        preStop:
          exec:
            # Sleep gives Kubernetes time to propagate endpoint removal
            # to all load balancers before the process starts shutting down.
            # Without this, in-flight requests arriving after SIGTERM
            # will see connection refused.
            command: ["/bin/sh", "-c", "sleep 15"]
```

## Assembling the Full Resilience Stack

```go
package main

import (
    "context"
    "net/http"
    "time"
)

func newResilientHTTPClient(serviceName string) *http.Client {
    // Circuit breaker
    cb := NewCircuitBreaker[*http.Response](CircuitBreakerConfig{
        Name:         serviceName,
        MaxRequests:  3,
        Interval:     60 * time.Second,
        Timeout:      30 * time.Second,
        FailureRatio: 0.5,
        MinRequests:  5,
    })

    // Bulkhead
    bulkhead := NewBulkhead(serviceName+"-bulkhead", 20, 2*time.Second)

    // Transport chain: circuit breaker wraps bulkhead wraps actual transport
    transport := &CircuitBreakerTransport{
        breaker: cb,
        next: &BulkheadTransport{
            bulkhead: bulkhead,
            next:     http.DefaultTransport,
        },
    }

    return &http.Client{
        Transport: transport,
        Timeout:   0,  // Managed by context, not client-level timeout
    }
}
```

## Summary

Resilience patterns are not optional in microservices architectures. Circuit breakers prevent cascade failures by failing fast when a dependency is unhealthy. Retry with exponential backoff and jitter handles transient failures without amplifying load. Bulkheads prevent one slow dependency from consuming all available goroutines. Context-based timeout propagation ensures that every call in a chain respects the overall request deadline.

Service discovery with Kubernetes DNS is operationally simpler than Consul for purely Kubernetes-native deployments. Consul becomes valuable when services span Kubernetes and non-Kubernetes infrastructure or require richer health check semantics.

The health check endpoint design is where many teams make mistakes. Liveness checks must only detect process-level failures (deadlocks, goroutine leaks). Including database checks in liveness causes unnecessary restarts during database maintenance windows, compounding the original outage.
