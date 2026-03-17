---
title: "Go Microservices Patterns: Service Registry, Health Checks, Graceful Degradation, and Bulkhead Pattern"
date: 2028-08-31T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "Service Registry", "Health Checks", "Bulkhead", "Resilience"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building resilient Go microservices: service registry with Consul, Kubernetes-native health checks, circuit breakers, the bulkhead pattern for isolation, graceful degradation, and retry strategies."
more_link: "yes"
url: "/go-microservices-patterns-registry-bulkhead-guide/"
---

Microservices distribute failures across process and network boundaries. A single poorly behaved dependency can exhaust your connection pools, starve your goroutine scheduler, and cascade into a complete service outage. The patterns in this guide — service registry, health checks, circuit breakers, bulkheads, and graceful degradation — are the defensive architecture that prevents cascading failures.

This guide implements these patterns in idiomatic Go with real code that handles the edge cases: partial health, dependency unavailability, thundering herds after circuit breaker reset, and concurrent request isolation.

<!--more-->

# [Go Microservices Patterns: Service Registry, Health Checks, Graceful Degradation, and Bulkhead](#go-microservices-patterns)

## Section 1: Service Registry Pattern

A service registry enables services to discover each other dynamically. In Kubernetes, the DNS-based service discovery is the built-in registry. For non-Kubernetes environments or services that need more dynamic discovery, Consul provides a rich API.

### Kubernetes-Native Service Discovery

```go
package discovery

import (
	"context"
	"fmt"
	"net"
	"time"
)

// KubernetesDiscovery uses Kubernetes DNS for service discovery
// Format: <service>.<namespace>.svc.cluster.local
type KubernetesDiscovery struct {
	resolver *net.Resolver
}

func NewKubernetesDiscovery() *KubernetesDiscovery {
	return &KubernetesDiscovery{
		resolver: &net.Resolver{PreferGo: true},
	}
}

func (d *KubernetesDiscovery) LookupService(
	ctx context.Context,
	name, namespace string,
) ([]string, error) {
	// Kubernetes DNS resolves: <service>.<namespace>.svc.cluster.local
	hostname := fmt.Sprintf("%s.%s.svc.cluster.local", name, namespace)

	addrs, err := d.resolver.LookupHost(ctx, hostname)
	if err != nil {
		return nil, fmt.Errorf("looking up %q: %w", hostname, err)
	}

	return addrs, nil
}

// LookupSRV finds service endpoints with port information
func (d *KubernetesDiscovery) LookupSRV(
	ctx context.Context,
	service, proto, name, namespace string,
) ([]*net.SRV, error) {
	hostname := fmt.Sprintf("%s.%s.svc.cluster.local", name, namespace)
	_, addrs, err := d.resolver.LookupSRV(ctx, service, proto, hostname)
	if err != nil {
		return nil, fmt.Errorf("SRV lookup for %q: %w", hostname, err)
	}
	return addrs, nil
}
```

### Consul-Based Service Registry

```bash
go get github.com/hashicorp/consul/api@latest
```

```go
package registry

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	consul "github.com/hashicorp/consul/api"
)

type ConsulRegistry struct {
	client  *consul.Client
	logger  *slog.Logger
	localIP string
}

type ServiceRegistration struct {
	ID      string
	Name    string
	Tags    []string
	Port    int
	Check   *ServiceCheck
}

type ServiceCheck struct {
	HTTP     string
	Interval string
	Timeout  string
}

func NewConsulRegistry(addr string, logger *slog.Logger) (*ConsulRegistry, error) {
	config := consul.DefaultConfig()
	config.Address = addr

	client, err := consul.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("creating consul client: %w", err)
	}

	return &ConsulRegistry{
		client: client,
		logger: logger,
	}, nil
}

func (r *ConsulRegistry) Register(ctx context.Context, svc ServiceRegistration) error {
	registration := &consul.AgentServiceRegistration{
		ID:      svc.ID,
		Name:    svc.Name,
		Tags:    svc.Tags,
		Port:    svc.Port,
		Address: r.localIP,
	}

	if svc.Check != nil {
		registration.Check = &consul.AgentServiceCheck{
			HTTP:                           svc.Check.HTTP,
			Interval:                       svc.Check.Interval,
			Timeout:                        svc.Check.Timeout,
			DeregisterCriticalServiceAfter: "30m",
		}
	}

	if err := r.client.Agent().ServiceRegister(registration); err != nil {
		return fmt.Errorf("registering service %q: %w", svc.Name, err)
	}

	r.logger.Info("Service registered", "id", svc.ID, "name", svc.Name)

	// Deregister on shutdown
	go func() {
		<-ctx.Done()
		if err := r.client.Agent().ServiceDeregister(svc.ID); err != nil {
			r.logger.Warn("Failed to deregister service", "id", svc.ID, "error", err)
		} else {
			r.logger.Info("Service deregistered", "id", svc.ID)
		}
	}()

	return nil
}

type ServiceInstance struct {
	ID      string
	Address string
	Port    int
	Tags    []string
	Healthy bool
}

func (r *ConsulRegistry) Discover(ctx context.Context, name string) ([]ServiceInstance, error) {
	services, _, err := r.client.Health().Service(name, "", true, &consul.QueryOptions{
		RequireConsistent: false,
		AllowStale:        true,
	})
	if err != nil {
		return nil, fmt.Errorf("discovering service %q: %w", name, err)
	}

	instances := make([]ServiceInstance, 0, len(services))
	for _, s := range services {
		instances = append(instances, ServiceInstance{
			ID:      s.Service.ID,
			Address: s.Service.Address,
			Port:    s.Service.Port,
			Tags:    s.Service.Tags,
			Healthy: true, // Health().Service with passingOnly=true only returns healthy
		})
	}

	return instances, nil
}

// Watch returns a channel that emits when service instances change
func (r *ConsulRegistry) Watch(ctx context.Context, name string) (<-chan []ServiceInstance, error) {
	ch := make(chan []ServiceInstance, 1)

	go func() {
		defer close(ch)
		var lastIndex uint64

		for {
			services, meta, err := r.client.Health().Service(name, "", true, &consul.QueryOptions{
				WaitIndex: lastIndex,
				WaitTime:  30 * time.Second,
			})
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				r.logger.Warn("Consul watch error", "service", name, "error", err)
				time.Sleep(5 * time.Second)
				continue
			}

			if meta.LastIndex == lastIndex {
				continue // No changes
			}
			lastIndex = meta.LastIndex

			instances := make([]ServiceInstance, 0, len(services))
			for _, s := range services {
				instances = append(instances, ServiceInstance{
					ID:      s.Service.ID,
					Address: s.Service.Address,
					Port:    s.Service.Port,
				})
			}

			select {
			case ch <- instances:
			case <-ctx.Done():
				return
			}
		}
	}()

	return ch, nil
}
```

## Section 2: Health Check Patterns

### Kubernetes Health Endpoints

A Go service should expose three health endpoints:

```go
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type Status string

const (
	StatusUp      Status = "UP"
	StatusDown    Status = "DOWN"
	StatusDegraded Status = "DEGRADED"
)

type CheckResult struct {
	Status  Status         `json:"status"`
	Details map[string]any `json:"details,omitempty"`
	Error   string         `json:"error,omitempty"`
}

type CheckFunc func(ctx context.Context) CheckResult

type HealthChecker struct {
	mu       sync.RWMutex
	ready    bool
	live     bool
	checks   map[string]CheckFunc
	startup  bool
}

func NewHealthChecker() *HealthChecker {
	return &HealthChecker{
		checks:  make(map[string]CheckFunc),
		live:    true,   // Assume live until proven otherwise
		startup: false,  // Not ready until explicitly marked
	}
}

func (h *HealthChecker) Register(name string, check CheckFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.checks[name] = check
}

func (h *HealthChecker) MarkReady()   { h.mu.Lock(); h.ready = true; h.mu.Unlock() }
func (h *HealthChecker) MarkNotReady() { h.mu.Lock(); h.ready = false; h.mu.Unlock() }
func (h *HealthChecker) MarkStarted() { h.mu.Lock(); h.startup = true; h.mu.Unlock() }

// LivenessHandler: if this returns 503, Kubernetes restarts the pod
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	live := h.live
	h.mu.RUnlock()

	if !live {
		http.Error(w, `{"status":"DOWN"}`, http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "UP"})
}

// ReadinessHandler: if this returns 503, pod is removed from Service endpoints
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	ready := h.ready
	h.mu.RUnlock()

	if !ready {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "NOT_READY"})
		return
	}

	// Run all registered checks
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	results := h.runChecks(ctx)
	overallStatus := StatusUp

	for _, result := range results {
		if result.Status == StatusDown {
			overallStatus = StatusDown
			break
		}
		if result.Status == StatusDegraded {
			overallStatus = StatusDegraded
		}
	}

	statusCode := http.StatusOK
	if overallStatus == StatusDown {
		statusCode = http.StatusServiceUnavailable
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(map[string]any{
		"status": overallStatus,
		"checks": results,
	})
}

// StartupHandler: if this returns 503, Kubernetes won't start liveness checks yet
func (h *HealthChecker) StartupHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	started := h.startup
	h.mu.RUnlock()

	if !started {
		http.Error(w, `{"status":"STARTING"}`, http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "STARTED"})
}

func (h *HealthChecker) runChecks(ctx context.Context) map[string]CheckResult {
	h.mu.RLock()
	checks := make(map[string]CheckFunc, len(h.checks))
	for k, v := range h.checks {
		checks[k] = v
	}
	h.mu.RUnlock()

	results := make(map[string]CheckResult, len(checks))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for name, check := range checks {
		wg.Add(1)
		go func(n string, c CheckFunc) {
			defer wg.Done()
			result := c(ctx)
			mu.Lock()
			results[n] = result
			mu.Unlock()
		}(name, check)
	}
	wg.Wait()

	return results
}
```

### Dependency Health Checks

```go
package health

import (
	"context"
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"
)

// DatabaseCheck verifies the database connection
func DatabaseCheck(db *sql.DB) CheckFunc {
	return func(ctx context.Context) CheckResult {
		start := time.Now()
		if err := db.PingContext(ctx); err != nil {
			return CheckResult{
				Status: StatusDown,
				Error:  err.Error(),
			}
		}

		stats := db.Stats()
		return CheckResult{
			Status: StatusUp,
			Details: map[string]any{
				"latency_ms":        time.Since(start).Milliseconds(),
				"open_connections":  stats.OpenConnections,
				"in_use":            stats.InUse,
				"idle":              stats.Idle,
				"wait_count":        stats.WaitCount,
				"wait_duration_ms":  stats.WaitDuration.Milliseconds(),
			},
		}
	}
}

// RedisCheck verifies the Redis connection
func RedisCheck(client redis.UniversalClient) CheckFunc {
	return func(ctx context.Context) CheckResult {
		start := time.Now()
		if err := client.Ping(ctx).Err(); err != nil {
			return CheckResult{
				Status: StatusDown,
				Error:  err.Error(),
			}
		}

		return CheckResult{
			Status: StatusUp,
			Details: map[string]any{
				"latency_ms": time.Since(start).Milliseconds(),
			},
		}
	}
}

// ExternalServiceCheck verifies an HTTP service is reachable
func ExternalServiceCheck(name, url string, timeout time.Duration) CheckFunc {
	httpClient := &http.Client{Timeout: timeout}
	return func(ctx context.Context) CheckResult {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return CheckResult{Status: StatusDown, Error: err.Error()}
		}

		start := time.Now()
		resp, err := httpClient.Do(req)
		if err != nil {
			return CheckResult{
				Status: StatusDown,
				Error:  fmt.Sprintf("%s unreachable: %v", name, err),
			}
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 500 {
			return CheckResult{
				Status: StatusDegraded,
				Error:  fmt.Sprintf("%s returned %d", name, resp.StatusCode),
			}
		}

		return CheckResult{
			Status: StatusUp,
			Details: map[string]any{
				"latency_ms":  time.Since(start).Milliseconds(),
				"status_code": resp.StatusCode,
			},
		}
	}
}
```

## Section 3: Circuit Breaker Pattern

A circuit breaker prevents a failing dependency from overwhelming your service with retry storms.

### States

```
CLOSED (normal) → failures exceed threshold → OPEN (fail fast)
    ↑                                              ↓
    └── success after probe ← half-open probe ←───┘
```

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type CircuitBreakerState int

const (
	StateClosed   CircuitBreakerState = iota
	StateHalfOpen
	StateOpen
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

type CircuitBreakerConfig struct {
	// Number of failures before opening
	FailureThreshold int
	// Number of successes in half-open before closing
	SuccessThreshold int
	// How long to wait in open state before trying half-open
	OpenTimeout time.Duration
	// Size of the rolling window for failure counting
	WindowSize int
}

type CircuitBreaker struct {
	config   CircuitBreakerConfig
	mu       sync.Mutex
	state    CircuitBreakerState
	failures int
	successes int
	lastFailure time.Time
	openedAt    time.Time

	// Metrics
	totalRequests  int64
	totalFailures  int64
	openTransitions int64
}

func NewCircuitBreaker(config CircuitBreakerConfig) *CircuitBreaker {
	if config.FailureThreshold == 0 {
		config.FailureThreshold = 5
	}
	if config.SuccessThreshold == 0 {
		config.SuccessThreshold = 2
	}
	if config.OpenTimeout == 0 {
		config.OpenTimeout = 30 * time.Second
	}

	return &CircuitBreaker{config: config}
}

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
	cb.mu.Lock()

	switch cb.state {
	case StateOpen:
		// Check if timeout has elapsed — try half-open
		if time.Since(cb.openedAt) >= cb.config.OpenTimeout {
			cb.state = StateHalfOpen
			cb.successes = 0
			cb.mu.Unlock()
			// Fall through to execute
		} else {
			cb.mu.Unlock()
			return fmt.Errorf("%w: retry after %v",
				ErrCircuitOpen,
				cb.config.OpenTimeout-time.Since(cb.openedAt),
			)
		}

	case StateHalfOpen:
		cb.mu.Unlock()
		// Allow one probe request through

	case StateClosed:
		cb.mu.Unlock()
	}

	// Execute the function
	err := fn(ctx)

	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.totalRequests++

	if err != nil {
		cb.totalFailures++
		cb.failures++
		cb.lastFailure = time.Now()

		switch cb.state {
		case StateHalfOpen:
			// Failed in half-open — go back to open
			cb.state = StateOpen
			cb.openedAt = time.Now()
			cb.openTransitions++

		case StateClosed:
			if cb.failures >= cb.config.FailureThreshold {
				cb.state = StateOpen
				cb.openedAt = time.Now()
				cb.openTransitions++
			}
		}

		return err
	}

	// Success
	cb.failures = 0

	switch cb.state {
	case StateHalfOpen:
		cb.successes++
		if cb.successes >= cb.config.SuccessThreshold {
			cb.state = StateClosed
		}
	}

	return nil
}

func (cb *CircuitBreaker) State() CircuitBreakerState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}

func (cb *CircuitBreaker) IsOpen() bool {
	return cb.State() == StateOpen
}
```

### Using Circuit Breaker in a Client

```go
package client

type PaymentClient struct {
	httpClient *http.Client
	breaker    *resilience.CircuitBreaker
	baseURL    string
}

func NewPaymentClient(baseURL string) *PaymentClient {
	return &PaymentClient{
		httpClient: &http.Client{Timeout: 10 * time.Second},
		baseURL:    baseURL,
		breaker: resilience.NewCircuitBreaker(resilience.CircuitBreakerConfig{
			FailureThreshold: 5,
			SuccessThreshold: 2,
			OpenTimeout:      30 * time.Second,
		}),
	}
}

func (c *PaymentClient) GetPayment(ctx context.Context, id string) (*Payment, error) {
	var payment *Payment

	err := c.breaker.Execute(ctx, func(ctx context.Context) error {
		url := fmt.Sprintf("%s/payments/%s", c.baseURL, id)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("HTTP request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusServiceUnavailable ||
			resp.StatusCode == http.StatusGatewayTimeout {
			// Count server errors as circuit breaker failures
			return fmt.Errorf("server error: %d", resp.StatusCode)
		}

		return json.NewDecoder(resp.Body).Decode(&payment)
	})

	if errors.Is(err, resilience.ErrCircuitOpen) {
		// Gracefully degrade — return cached or fallback value
		return c.getFallbackPayment(ctx, id)
	}

	return payment, err
}

func (c *PaymentClient) getFallbackPayment(ctx context.Context, id string) (*Payment, error) {
	// Return cached value or a "degraded" response
	return &Payment{
		ID:     id,
		Status: "UNKNOWN",
		Error:  "payment service temporarily unavailable",
	}, nil
}
```

## Section 4: Bulkhead Pattern

The bulkhead pattern isolates failures by partitioning resources into separate pools. If one service consumer exhausts its pool, others are unaffected.

### Semaphore-Based Bulkhead

```go
package resilience

import (
	"context"
	"fmt"
	"time"
)

var ErrBulkheadFull = errors.New("bulkhead at capacity")

// Bulkhead limits concurrent access to a resource
type Bulkhead struct {
	sem      chan struct{}
	name     string
	timeout  time.Duration

	// Metrics
	rejected  int64
	current   int64
	mu        sync.Mutex
}

func NewBulkhead(name string, maxConcurrent int, queueTimeout time.Duration) *Bulkhead {
	return &Bulkhead{
		sem:     make(chan struct{}, maxConcurrent),
		name:    name,
		timeout: queueTimeout,
	}
}

func (b *Bulkhead) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
	// Try to acquire a slot
	acquireCtx, cancel := context.WithTimeout(ctx, b.timeout)
	defer cancel()

	select {
	case b.sem <- struct{}{}:
		// Got a slot
	case <-acquireCtx.Done():
		b.mu.Lock()
		b.rejected++
		b.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrBulkheadFull, b.name)
	case <-ctx.Done():
		return ctx.Err()
	}

	b.mu.Lock()
	b.current++
	b.mu.Unlock()

	defer func() {
		<-b.sem // Release slot
		b.mu.Lock()
		b.current--
		b.mu.Unlock()
	}()

	return fn(ctx)
}

func (b *Bulkhead) Available() int {
	return cap(b.sem) - len(b.sem)
}

func (b *Bulkhead) Utilization() float64 {
	return float64(len(b.sem)) / float64(cap(b.sem))
}
```

### Goroutine Pool Bulkhead

```go
package resilience

import (
	"context"
	"sync"
)

type Task func(ctx context.Context)

// WorkerPool is a bounded goroutine pool implementing the bulkhead pattern
type WorkerPool struct {
	name    string
	tasks   chan Task
	wg      sync.WaitGroup
	once    sync.Once
	done    chan struct{}
	workers int

	// Metrics
	processed int64
	dropped   int64
	mu        sync.Mutex
}

func NewWorkerPool(name string, workers, queueSize int) *WorkerPool {
	pool := &WorkerPool{
		name:    name,
		tasks:   make(chan Task, queueSize),
		done:    make(chan struct{}),
		workers: workers,
	}
	pool.start()
	return pool
}

func (p *WorkerPool) start() {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for {
				select {
				case task, ok := <-p.tasks:
					if !ok {
						return
					}
					task(context.Background())
					p.mu.Lock()
					p.processed++
					p.mu.Unlock()
				case <-p.done:
					return
				}
			}
		}()
	}
}

// Submit adds a task to the pool. Returns ErrBulkheadFull if queue is full.
func (p *WorkerPool) Submit(task Task) error {
	select {
	case p.tasks <- task:
		return nil
	default:
		p.mu.Lock()
		p.dropped++
		p.mu.Unlock()
		return fmt.Errorf("%w: worker pool %q", ErrBulkheadFull, p.name)
	}
}

// SubmitWait submits with a timeout for queueing
func (p *WorkerPool) SubmitWait(ctx context.Context, task Task) error {
	select {
	case p.tasks <- task:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *WorkerPool) Drain() {
	p.once.Do(func() {
		close(p.done)
		p.wg.Wait()
	})
}
```

### Per-Dependency Bulkheads

```go
package service

// OrderService uses separate bulkheads for each dependency
// Failure in payment service doesn't affect inventory service calls
type OrderService struct {
	paymentBulkhead   *resilience.Bulkhead
	inventoryBulkhead *resilience.Bulkhead
	notifyBulkhead    *resilience.Bulkhead

	paymentClient   PaymentClient
	inventoryClient InventoryClient
	notifyClient    NotifyClient
}

func NewOrderService(payment PaymentClient, inventory InventoryClient, notify NotifyClient) *OrderService {
	return &OrderService{
		// Payment: critical path — 20 concurrent max, 100ms wait
		paymentBulkhead: resilience.NewBulkhead("payment", 20, 100*time.Millisecond),

		// Inventory: critical path — 30 concurrent max, 200ms wait
		inventoryBulkhead: resilience.NewBulkhead("inventory", 30, 200*time.Millisecond),

		// Notifications: non-critical — 10 concurrent, 10ms wait (fire-and-forget)
		notifyBulkhead: resilience.NewBulkhead("notify", 10, 10*time.Millisecond),

		paymentClient:   payment,
		inventoryClient: inventory,
		notifyClient:    notify,
	}
}

func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
	// Reserve inventory (critical — order can't proceed without this)
	var reservation *Reservation
	if err := s.inventoryBulkhead.Execute(ctx, func(ctx context.Context) error {
		var err error
		reservation, err = s.inventoryClient.Reserve(ctx, req.Items)
		return err
	}); err != nil {
		if errors.Is(err, resilience.ErrBulkheadFull) {
			return nil, fmt.Errorf("too many concurrent requests, please retry")
		}
		return nil, fmt.Errorf("inventory reservation failed: %w", err)
	}

	// Process payment (critical — order can't proceed without this)
	var payment *Payment
	if err := s.paymentBulkhead.Execute(ctx, func(ctx context.Context) error {
		var err error
		payment, err = s.paymentClient.Charge(ctx, req.PaymentMethod, req.Amount)
		return err
	}); err != nil {
		// Release inventory reservation on payment failure
		s.inventoryClient.Release(ctx, reservation.ID)

		if errors.Is(err, resilience.ErrBulkheadFull) {
			return nil, fmt.Errorf("payment service busy, please retry")
		}
		return nil, fmt.Errorf("payment failed: %w", err)
	}

	// Create the order
	order := &Order{
		ID:            generateID(),
		ReservationID: reservation.ID,
		PaymentID:     payment.ID,
		Status:        OrderStatusConfirmed,
	}

	// Send notification (non-critical — failure doesn't affect order creation)
	go func() {
		notifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := s.notifyBulkhead.Execute(notifyCtx, func(ctx context.Context) error {
			return s.notifyClient.SendOrderConfirmation(ctx, order)
		}); err != nil {
			slog.Warn("Failed to send order notification",
				"order_id", order.ID, "error", err)
			// Non-critical: don't fail the order
		}
	}()

	return order, nil
}
```

## Section 5: Retry with Exponential Backoff

```go
package resilience

import (
	"context"
	"math"
	"math/rand"
	"time"
)

type RetryConfig struct {
	MaxAttempts     int
	InitialInterval time.Duration
	MaxInterval     time.Duration
	Multiplier      float64
	Jitter          float64    // 0.0–1.0: random jitter to prevent thundering herd
	RetryOn         func(err error) bool  // nil means retry on all errors
}

func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxAttempts:     3,
		InitialInterval: 100 * time.Millisecond,
		MaxInterval:     30 * time.Second,
		Multiplier:      2.0,
		Jitter:          0.2,
		RetryOn:         nil, // Retry on all errors
	}
}

type RetryableError struct {
	Err     error
	Retries int
}

func (e *RetryableError) Error() string {
	return fmt.Sprintf("failed after %d retries: %v", e.Retries, e.Err)
}

func (e *RetryableError) Unwrap() error { return e.Err }

func Retry(ctx context.Context, config RetryConfig, fn func(ctx context.Context) error) error {
	var lastErr error

	for attempt := 0; attempt < config.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		lastErr = fn(ctx)
		if lastErr == nil {
			return nil
		}

		// Check if we should retry this error
		if config.RetryOn != nil && !config.RetryOn(lastErr) {
			return lastErr  // Non-retryable error
		}

		// Don't sleep after last attempt
		if attempt == config.MaxAttempts-1 {
			break
		}

		// Calculate next interval with exponential backoff + jitter
		interval := float64(config.InitialInterval) * math.Pow(config.Multiplier, float64(attempt))
		if interval > float64(config.MaxInterval) {
			interval = float64(config.MaxInterval)
		}

		// Add jitter: interval * (1 ± jitter)
		jitterRange := interval * config.Jitter
		interval += (rand.Float64()*2 - 1) * jitterRange

		slog.DebugContext(ctx, "Retrying after error",
			"attempt", attempt+1,
			"max_attempts", config.MaxAttempts,
			"wait_ms", time.Duration(interval).Milliseconds(),
			"error", lastErr,
		)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(interval)):
		}
	}

	return &RetryableError{Err: lastErr, Retries: config.MaxAttempts}
}
```

## Section 6: Graceful Degradation

```go
package service

// ProductService implements graceful degradation:
// - Primary: fetch from database (authoritative)
// - Fallback 1: return from cache (possibly stale)
// - Fallback 2: return a "degraded" response with limited data
type ProductService struct {
	db      *store.Store
	cache   *cache.TwoLevelCache[*Product]
	breaker *resilience.CircuitBreaker
}

type ProductResult struct {
	Product   *Product
	FromCache bool   // True if returned from cache (may be stale)
	Degraded  bool   // True if this is a fallback/degraded response
	Warning   string // Set when degraded or stale
}

func (s *ProductService) GetProduct(ctx context.Context, id string) (*ProductResult, error) {
	// Attempt 1: Database via circuit breaker
	var product *Product
	err := s.breaker.Execute(ctx, func(ctx context.Context) error {
		var err error
		product, err = s.db.GetProduct(ctx, id)
		return err
	})

	if err == nil {
		// Success: update cache and return
		s.cache.Invalidate(ctx, id)
		_ = s.cache.l2.Set(ctx, id, product)
		return &ProductResult{Product: product}, nil
	}

	// Database failed — check circuit breaker state
	if !errors.Is(err, resilience.ErrCircuitOpen) {
		slog.WarnContext(ctx, "Database error for product", "id", id, "error", err)
	}

	// Attempt 2: Return from cache (stale data acceptable)
	if cached, ok := s.cache.l1.Get(id); ok {
		return &ProductResult{
			Product:   cached,
			FromCache: true,
			Warning:   "data may be stale",
		}, nil
	}

	if cached, cacheErr := s.cache.l2.Get(ctx, id); cacheErr == nil {
		return &ProductResult{
			Product:   cached,
			FromCache: true,
			Warning:   "data may be stale (database unavailable)",
		}, nil
	}

	// Attempt 3: Return degraded response (product skeleton)
	if isCircuitOpen := s.breaker.IsOpen(); isCircuitOpen {
		return &ProductResult{
			Product: &Product{
				ID:      id,
				Name:    "Product Temporarily Unavailable",
				Status:  ProductStatusUnavailable,
			},
			Degraded: true,
			Warning:  "product service temporarily unavailable",
		}, nil
	}

	return nil, fmt.Errorf("product %q not found", id)
}
```

## Section 7: Timeout and Context Propagation

```go
package middleware

import (
	"context"
	"net/http"
	"time"
)

// TimeoutMiddleware applies per-route timeouts
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()

			done := make(chan struct{})
			var panicVal any

			go func() {
				defer func() {
					panicVal = recover()
					close(done)
				}()
				next.ServeHTTP(w, r.WithContext(ctx))
			}()

			select {
			case <-done:
				if panicVal != nil {
					panic(panicVal)
				}
			case <-ctx.Done():
				w.WriteHeader(http.StatusGatewayTimeout)
				json.NewEncoder(w).Encode(map[string]string{
					"error": "request timeout",
					"code":  "TIMEOUT",
				})
			}
		})
	}
}
```

### Downstream Timeout Budget

```go
// Allocate timeout budget across downstream calls
func (s *OrderService) CreateOrderWithBudget(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		// No deadline set — apply a default
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		deadline, _ = ctx.Deadline()
	}

	remaining := time.Until(deadline)
	if remaining < 500*time.Millisecond {
		return nil, fmt.Errorf("insufficient time budget: %v", remaining)
	}

	// Allocate: inventory=30%, payment=50%, buffer=20%
	inventoryTimeout := time.Duration(float64(remaining) * 0.30)
	paymentTimeout := time.Duration(float64(remaining) * 0.50)

	// Inventory reservation
	inventoryCtx, cancelInv := context.WithTimeout(ctx, inventoryTimeout)
	defer cancelInv()
	reservation, err := s.inventoryClient.Reserve(inventoryCtx, req.Items)
	if err != nil {
		return nil, fmt.Errorf("inventory failed (budget: %v): %w", inventoryTimeout, err)
	}

	// Payment
	paymentCtx, cancelPay := context.WithTimeout(ctx, paymentTimeout)
	defer cancelPay()
	payment, err := s.paymentClient.Charge(paymentCtx, req.PaymentMethod, req.Amount)
	if err != nil {
		s.inventoryClient.Release(ctx, reservation.ID)
		return nil, fmt.Errorf("payment failed (budget: %v): %w", paymentTimeout, err)
	}

	return &Order{
		ID:            generateID(),
		ReservationID: reservation.ID,
		PaymentID:     payment.ID,
	}, nil
}
```

## Section 8: Observability for Resilience Patterns

```go
package resilience

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	circuitBreakerState = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "circuit_breaker_state",
		Help: "Circuit breaker state (0=closed, 1=half-open, 2=open)",
	}, []string{"name"})

	circuitBreakerRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "circuit_breaker_requests_total",
		Help: "Total requests through circuit breaker",
	}, []string{"name", "result"})

	bulkheadUtilization = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bulkhead_utilization",
		Help: "Bulkhead utilization ratio (0-1)",
	}, []string{"name"})

	bulkheadRejections = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bulkhead_rejected_total",
		Help: "Requests rejected by bulkhead",
	}, []string{"name"})

	retryAttempts = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "retry_attempts",
		Help:    "Number of retry attempts before success or giving up",
		Buckets: []float64{1, 2, 3, 5, 10},
	}, []string{"operation"})
)

// InstrumentedCircuitBreaker wraps CircuitBreaker with metrics
type InstrumentedCircuitBreaker struct {
	*CircuitBreaker
	name string
}

func NewInstrumentedCircuitBreaker(name string, config CircuitBreakerConfig) *InstrumentedCircuitBreaker {
	cb := &InstrumentedCircuitBreaker{
		CircuitBreaker: NewCircuitBreaker(config),
		name:           name,
	}
	// Periodic metrics export
	go cb.exportMetrics()
	return cb
}

func (cb *InstrumentedCircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
	err := cb.CircuitBreaker.Execute(ctx, fn)

	result := "success"
	if err != nil {
		if errors.Is(err, ErrCircuitOpen) {
			result = "rejected"
		} else {
			result = "failure"
		}
	}

	circuitBreakerRequests.WithLabelValues(cb.name, result).Inc()
	return err
}

func (cb *InstrumentedCircuitBreaker) exportMetrics() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		state := float64(cb.State())
		circuitBreakerState.WithLabelValues(cb.name).Set(state)
	}
}
```

## Section 9: Complete Resilient Service Example

```go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/myorg/order-service/internal/health"
	"github.com/myorg/order-service/internal/resilience"
	"github.com/myorg/order-service/internal/service"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	// Health checker
	checker := health.NewHealthChecker()

	// Dependencies
	db := initDatabase()
	rdb := initRedis()
	paymentClient := client.NewPaymentClient(os.Getenv("PAYMENT_SERVICE_URL"))
	inventoryClient := client.NewInventoryClient(os.Getenv("INVENTORY_SERVICE_URL"))

	// Register health checks
	checker.Register("database", health.DatabaseCheck(db.DB()))
	checker.Register("redis", health.RedisCheck(rdb))
	checker.Register("payment-service", health.ExternalServiceCheck(
		"payment-service",
		os.Getenv("PAYMENT_SERVICE_URL")+"/healthz",
		3*time.Second,
	))

	// Build the order service with resilience patterns
	orderSvc := service.NewOrderService(paymentClient, inventoryClient)

	// HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz/startup", checker.StartupHandler)
	mux.HandleFunc("/healthz/live", checker.LivenessHandler)
	mux.HandleFunc("/healthz/ready", checker.ReadinessHandler)
	mux.Handle("/orders", handler.NewOrderHandler(orderSvc))

	server := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Mark startup complete after initialization
	checker.MarkStarted()
	checker.MarkReady()

	// Start server
	go func() {
		slog.Info("Starting HTTP server", "addr", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server error", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	slog.Info("Shutting down...")
	checker.MarkNotReady()  // Stop accepting new traffic

	// Allow load balancer to notice we're not ready
	time.Sleep(10 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("Graceful shutdown failed", "error", err)
	}

	slog.Info("Shutdown complete")
}
```

## Section 10: Summary and Patterns Reference

### Resilience Pattern Selection

| Problem | Pattern | Go Implementation |
|---------|---------|-------------------|
| Cascading failure | Circuit Breaker | `breaker.Execute(ctx, fn)` |
| Resource exhaustion | Bulkhead | `bulkhead.Execute(ctx, fn)` |
| Transient errors | Retry + Backoff | `resilience.Retry(ctx, config, fn)` |
| Slow dependencies | Timeout | `context.WithTimeout` |
| Partial failure | Graceful Degradation | Multi-tier fallback |
| Service location | Service Registry | Consul or Kubernetes DNS |
| Health visibility | Structured Health Checks | `/healthz/live`, `/healthz/ready` |

### Key Production Rules

1. **Every external call must have a timeout** — no exception. Use context deadlines.
2. **Bulkhead each external dependency separately** — payment failure should not block inventory calls
3. **Circuit breakers prevent retry storms** — when a service is down, stop trying immediately
4. **Mark readiness separately from liveness** — a pod under load should become not-ready (removed from Service), not killed (liveness failure)
5. **Graceful degradation > hard failure** — return stale cache, default values, or partial results rather than errors when possible
6. **Instrument everything** — circuit breaker state, bulkhead utilization, and retry rates are leading indicators of system stress
7. **Test failure paths** — use chaos engineering (Chaos Mesh, Litmus) to verify your resilience patterns actually work under production conditions
