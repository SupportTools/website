---
title: "Go Graceful Degradation: Bulkheads, Fallbacks, and Partial Availability"
date: 2028-12-07T00:00:00-05:00
draft: false
tags: ["Go", "Resilience", "Architecture", "Microservices", "Production"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement resilience patterns in Go: bulkhead isolation with semaphores, fallback strategies with cached responses, feature flags for runtime degradation, partial response aggregation, and testing degraded-mode behavior."
more_link: "yes"
url: "/go-graceful-degradation-bulkhead-guide/"
---

A microservice that fails completely when one upstream dependency is slow is not resilient. Graceful degradation means the system continues to serve useful (if reduced) functionality when parts of it are unavailable. This requires intentional design: bulkheads that prevent one dependency's slowness from consuming all goroutines, fallbacks that return cached or default data instead of errors, feature flags that disable expensive operations at runtime, and partial response patterns that return whatever is available rather than waiting for everything.

This guide implements these patterns in production Go code with testable interfaces and real operational runbooks.

<!--more-->

# Go Graceful Degradation Patterns

## Section 1: The Bulkhead Pattern

The bulkhead pattern isolates resource pools per dependency. If the inventory service is slow and consumes all available connections, the payment service pool should be unaffected. In Go, implement bulkheads with buffered semaphore channels.

```go
// internal/bulkhead/semaphore.go
package bulkhead

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var ErrBulkheadFull = errors.New("bulkhead capacity exceeded")

// Semaphore is a counting semaphore for concurrency limiting.
type Semaphore struct {
	name    string
	ch      chan struct{}
	timeout time.Duration
}

// New creates a semaphore with the given capacity and acquire timeout.
func New(name string, capacity int, acquireTimeout time.Duration) *Semaphore {
	ch := make(chan struct{}, capacity)
	for i := 0; i < capacity; i++ {
		ch <- struct{}{}
	}
	return &Semaphore{name: name, ch: ch, timeout: acquireTimeout}
}

// Acquire reserves a slot. Returns ErrBulkheadFull if the semaphore is
// exhausted and the timeout expires.
func (s *Semaphore) Acquire(ctx context.Context) error {
	timer := time.NewTimer(s.timeout)
	defer timer.Stop()

	select {
	case <-s.ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return fmt.Errorf("%w: %s (capacity %d)", ErrBulkheadFull, s.name, cap(s.ch))
	}
}

// Release returns a slot to the pool.
func (s *Semaphore) Release() {
	s.ch <- struct{}{}
}

// Do executes fn under the semaphore, releasing the slot when fn returns.
func (s *Semaphore) Do(ctx context.Context, fn func() error) error {
	if err := s.Acquire(ctx); err != nil {
		return err
	}
	defer s.Release()
	return fn()
}

// Available returns the number of available slots.
func (s *Semaphore) Available() int {
	return len(s.ch)
}

// InFlight returns the number of slots currently in use.
func (s *Semaphore) InFlight() int {
	return cap(s.ch) - len(s.ch)
}
```

```go
// internal/bulkhead/bulkhead_test.go
package bulkhead_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/example/service/internal/bulkhead"
)

func TestBulkheadIsolation(t *testing.T) {
	sem := bulkhead.New("inventory", 5, 50*time.Millisecond)

	// Fill all 5 slots
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = sem.Do(context.Background(), func() error {
				time.Sleep(200 * time.Millisecond) // simulate slow upstream
				return nil
			})
		}()
	}

	// Give goroutines time to acquire
	time.Sleep(10 * time.Millisecond)

	// 6th request should fail fast (bulkhead full)
	start := time.Now()
	err := sem.Do(context.Background(), func() error {
		return nil
	})
	elapsed := time.Since(start)

	if err == nil {
		t.Error("expected ErrBulkheadFull, got nil")
	}
	if elapsed > 100*time.Millisecond {
		t.Errorf("bulkhead took %v to reject, expected < 100ms", elapsed)
	}

	wg.Wait()
}
```

## Section 2: Dependency-Specific Bulkheads in a Service

```go
// internal/clients/client_pool.go
package clients

import (
	"context"
	"time"

	"github.com/example/service/internal/bulkhead"
)

// DependencyClients holds HTTP clients with separate bulkheads per dependency.
type DependencyClients struct {
	InventoryBulkhead *bulkhead.Semaphore
	PaymentBulkhead   *bulkhead.Semaphore
	NotificationBulk  *bulkhead.Semaphore
	ReviewsBulkhead   *bulkhead.Semaphore
}

func NewDependencyClients() *DependencyClients {
	return &DependencyClients{
		// Critical path: tighter budget, faster timeout
		InventoryBulkhead: bulkhead.New("inventory", 20, 100*time.Millisecond),
		PaymentBulkhead:   bulkhead.New("payment", 10, 150*time.Millisecond),
		// Non-critical: more permissive
		NotificationBulk:  bulkhead.New("notification", 50, 500*time.Millisecond),
		ReviewsBulkhead:   bulkhead.New("reviews", 30, 200*time.Millisecond),
	}
}
```

```go
// internal/service/order_service.go
package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/example/service/internal/bulkhead"
	"github.com/example/service/internal/cache"
	"github.com/example/service/internal/clients"
)

type OrderService struct {
	deps  *clients.DependencyClients
	cache *cache.Cache
}

type OrderDetails struct {
	OrderID   string
	Inventory *InventoryStatus  // nil if inventory unavailable
	Reviews   *ProductReviews   // nil if reviews unavailable
	Payment   *PaymentInfo      // required; error if unavailable
}

type InventoryStatus struct {
	InStock  bool
	Quantity int
	Source   string // "live" or "cached"
}

func (s *OrderService) GetOrderDetails(ctx context.Context, orderID string) (*OrderDetails, error) {
	result := &OrderDetails{OrderID: orderID}

	// Payment is required — no fallback
	payment, err := s.getPaymentInfo(ctx, orderID)
	if err != nil {
		return nil, fmt.Errorf("payment lookup failed (non-degradable): %w", err)
	}
	result.Payment = payment

	// Inventory is desired but not required; use cached data if live fails
	inv, err := s.getInventoryWithFallback(ctx, orderID)
	if err != nil {
		slog.Warn("inventory degraded", "order_id", orderID, "err", err)
		// nil inventory in result — caller handles partial response
	} else {
		result.Inventory = inv
	}

	// Reviews are purely non-critical; always has a fallback
	result.Reviews = s.getReviewsWithDefault(ctx, orderID)

	return result, nil
}

func (s *OrderService) getPaymentInfo(ctx context.Context, orderID string) (*PaymentInfo, error) {
	var info *PaymentInfo
	err := s.deps.PaymentBulkhead.Do(ctx, func() error {
		var e error
		info, e = callPaymentService(ctx, orderID)
		return e
	})
	return info, err
}

func (s *OrderService) getInventoryWithFallback(ctx context.Context, orderID string) (*InventoryStatus, error) {
	var inv *InventoryStatus

	err := s.deps.InventoryBulkhead.Do(ctx, func() error {
		var e error
		inv, e = callInventoryService(ctx, orderID)
		return e
	})

	if err == nil {
		// Update cache on success
		s.cache.Set("inv:"+orderID, inv, 5*time.Minute)
		inv.Source = "live"
		return inv, nil
	}

	// Fall back to cached value
	if cached, ok := s.cache.Get("inv:" + orderID); ok {
		status := cached.(*InventoryStatus)
		status.Source = "cached"
		return status, nil
	}

	return nil, fmt.Errorf("inventory unavailable and no cache: %w", err)
}

func (s *OrderService) getReviewsWithDefault(ctx context.Context, orderID string) *ProductReviews {
	var reviews *ProductReviews

	err := s.deps.ReviewsBulkhead.Do(ctx, func() error {
		var e error
		reviews, e = callReviewsService(ctx, orderID)
		return e
	})
	if err != nil {
		slog.Debug("reviews unavailable, using default", "order_id", orderID)
		return &ProductReviews{Available: false, Message: "Reviews temporarily unavailable"}
	}
	return reviews
}
```

## Section 3: Cache-Based Fallback Store

```go
// internal/cache/cache.go
package cache

import (
	"sync"
	"time"
)

type entry struct {
	value     any
	expiresAt time.Time
}

// Cache is a simple in-memory TTL cache for fallback values.
// For production, back with Redis for persistence across restarts.
type Cache struct {
	mu      sync.RWMutex
	entries map[string]entry
}

func New() *Cache {
	c := &Cache{entries: make(map[string]entry)}
	go c.evict()
	return c
}

func (c *Cache) Set(key string, val any, ttl time.Duration) {
	c.mu.Lock()
	c.entries[key] = entry{value: val, expiresAt: time.Now().Add(ttl)}
	c.mu.Unlock()
}

func (c *Cache) Get(key string) (any, bool) {
	c.mu.RLock()
	e, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.value, true
}

func (c *Cache) evict() {
	ticker := time.NewTicker(1 * time.Minute)
	for range ticker.C {
		now := time.Now()
		c.mu.Lock()
		for k, e := range c.entries {
			if now.After(e.expiresAt) {
				delete(c.entries, k)
			}
		}
		c.mu.Unlock()
	}
}
```

## Section 4: Feature Flags for Runtime Degradation

Feature flags allow disabling expensive operations without a deployment. Implement a simple in-memory flag store that can be updated via an admin API or synced from a config system.

```go
// internal/flags/flags.go
package flags

import (
	"sync"
	"sync/atomic"
)

// Flag names
const (
	FlagInventoryLive   = "inventory.live_lookup"
	FlagReviewsEnabled  = "reviews.enabled"
	FlagPricingRealtime = "pricing.realtime"
	FlagRecommendations = "recommendations.enabled"
)

var global = &Store{}

// Store holds feature flags.
type Store struct {
	mu    sync.RWMutex
	flags map[string]*atomic.Bool
}

func init() {
	global = &Store{flags: make(map[string]*atomic.Bool)}
	// All features enabled by default
	for _, name := range []string{
		FlagInventoryLive,
		FlagReviewsEnabled,
		FlagPricingRealtime,
		FlagRecommendations,
	} {
		b := &atomic.Bool{}
		b.Store(true)
		global.flags[name] = b
	}
}

// IsEnabled returns whether a feature flag is enabled.
func IsEnabled(name string) bool {
	global.mu.RLock()
	b, ok := global.flags[name]
	global.mu.RUnlock()
	if !ok {
		return false // unknown flags are disabled
	}
	return b.Load()
}

// Set enables or disables a feature flag atomically.
func Set(name string, enabled bool) {
	global.mu.Lock()
	b, ok := global.flags[name]
	if !ok {
		b = &atomic.Bool{}
		global.flags[name] = b
	}
	global.mu.Unlock()
	b.Store(enabled)
}

// All returns a snapshot of all flags.
func All() map[string]bool {
	global.mu.RLock()
	defer global.mu.RUnlock()
	out := make(map[string]bool, len(global.flags))
	for k, v := range global.flags {
		out[k] = v.Load()
	}
	return out
}
```

Admin handler to toggle flags at runtime:

```go
// internal/handler/admin.go
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/example/service/internal/flags"
)

type AdminHandler struct{}

// GET /admin/flags
func (h *AdminHandler) GetFlags(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(flags.All())
}

// PUT /admin/flags/{name}  body: {"enabled": true}
func (h *AdminHandler) SetFlag(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	flags.Set(name, req.Enabled)
	w.WriteHeader(http.StatusNoContent)
}
```

Using flags in service methods:

```go
func (s *OrderService) getInventoryWithFallback(ctx context.Context, orderID string) (*InventoryStatus, error) {
	if !flags.IsEnabled(flags.FlagInventoryLive) {
		// Feature flag disabled; return cached or default immediately
		if cached, ok := s.cache.Get("inv:" + orderID); ok {
			status := cached.(*InventoryStatus)
			status.Source = "cached (flag disabled)"
			return status, nil
		}
		return &InventoryStatus{InStock: true, Quantity: -1, Source: "default"}, nil
	}
	// ... live lookup
}
```

## Section 5: Partial Response Aggregation

For API gateway or BFF (Backend for Frontend) patterns, collect responses from multiple services concurrently and return whatever completed:

```go
// internal/aggregator/aggregator.go
package aggregator

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// ComponentResult holds either a value or an error for one component.
type ComponentResult[T any] struct {
	Name     string
	Value    T
	Err      error
	Duration time.Duration
}

// Gather runs all fns concurrently with individual timeouts.
// Results are returned in any order; errors are included (not propagated).
func Gather[T any](
	ctx context.Context,
	components map[string]func(context.Context) (T, error),
	perComponentTimeout time.Duration,
) []ComponentResult[T] {
	results := make([]ComponentResult[T], 0, len(components))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for name, fn := range components {
		wg.Add(1)
		go func(name string, fn func(context.Context) (T, error)) {
			defer wg.Done()

			cctx, cancel := context.WithTimeout(ctx, perComponentTimeout)
			defer cancel()

			start := time.Now()
			val, err := fn(cctx)
			dur := time.Since(start)

			if err != nil {
				slog.Warn("component failed", "name", name, "err", err, "duration", dur)
			}

			mu.Lock()
			results = append(results, ComponentResult[T]{
				Name: name, Value: val, Err: err, Duration: dur,
			})
			mu.Unlock()
		}(name, fn)
	}

	wg.Wait()
	return results
}
```

```go
// Example: product page aggregator
type ProductPageData struct {
	Product      *Product       `json:"product"`
	Inventory    *InventoryInfo `json:"inventory,omitempty"`
	Reviews      *ReviewSummary `json:"reviews,omitempty"`
	Pricing      *PricingInfo   `json:"pricing"`
	Availability string         `json:"availability"` // "full" | "partial"
}

func (h *ProductHandler) GetProductPage(w http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")
	ctx := r.Context()

	type pageComponent any

	components := map[string]func(context.Context) (pageComponent, error){
		"product": func(ctx context.Context) (pageComponent, error) {
			return h.productSvc.Get(ctx, productID)
		},
		"inventory": func(ctx context.Context) (pageComponent, error) {
			return h.inventorySvc.Get(ctx, productID)
		},
		"reviews": func(ctx context.Context) (pageComponent, error) {
			return h.reviewsSvc.GetSummary(ctx, productID)
		},
		"pricing": func(ctx context.Context) (pageComponent, error) {
			return h.pricingSvc.Get(ctx, productID)
		},
	}

	results := aggregator.Gather(ctx, components, 300*time.Millisecond)

	page := &ProductPageData{Availability: "full"}
	failedComponents := 0

	for _, r := range results {
		if r.Err != nil {
			failedComponents++
			continue
		}
		switch r.Name {
		case "product":
			page.Product = r.Value.(*Product)
		case "inventory":
			page.Inventory = r.Value.(*InventoryInfo)
		case "reviews":
			page.Reviews = r.Value.(*ReviewSummary)
		case "pricing":
			page.Pricing = r.Value.(*PricingInfo)
		}
	}

	// Product and pricing are required; others are optional
	if page.Product == nil || page.Pricing == nil {
		http.Error(w, "required components unavailable", http.StatusServiceUnavailable)
		return
	}

	if failedComponents > 0 {
		page.Availability = "partial"
	}

	w.Header().Set("Content-Type", "application/json")
	if page.Availability == "partial" {
		w.Header().Set("X-Degraded", "true")
	}
	_ = json.NewEncoder(w).Encode(page)
}
```

## Section 6: Context Timeout Budgets

A request has a total budget. Propagate remaining budget to each downstream call rather than using fixed timeouts per call.

```go
// internal/budget/budget.go
package budget

import (
	"context"
	"time"
)

type budgetKey struct{}

// WithBudget attaches a deadline to the context based on a total budget.
func WithBudget(ctx context.Context, total time.Duration) (context.Context, context.CancelFunc) {
	deadline := time.Now().Add(total)
	ctx = context.WithValue(ctx, budgetKey{}, deadline)
	return context.WithDeadline(ctx, deadline)
}

// Remaining returns the time left in the current request budget.
func Remaining(ctx context.Context) time.Duration {
	deadline, ok := ctx.Value(budgetKey{}).(time.Time)
	if !ok {
		return 5 * time.Second // sensible default
	}
	remaining := time.Until(deadline)
	if remaining < 0 {
		return 0
	}
	return remaining
}

// ChildContext creates a child context that consumes at most fraction of the remaining budget.
func ChildContext(ctx context.Context, fraction float64) (context.Context, context.CancelFunc) {
	budget := Remaining(ctx)
	childBudget := time.Duration(float64(budget) * fraction)
	if childBudget < 1*time.Millisecond {
		childBudget = 1 * time.Millisecond
	}
	return context.WithTimeout(ctx, childBudget)
}
```

```go
// Usage in an HTTP handler
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Total request budget: 500ms
	ctx, cancel := budget.WithBudget(r.Context(), 500*time.Millisecond)
	defer cancel()

	// Inventory gets 40% of budget
	invCtx, invCancel := budget.ChildContext(ctx, 0.40)
	defer invCancel()
	inv, _ := h.inventory.Get(invCtx, r.PathValue("id"))

	// Reviews get 30% of remaining budget
	revCtx, revCancel := budget.ChildContext(ctx, 0.30)
	defer revCancel()
	rev, _ := h.reviews.Get(revCtx, r.PathValue("id"))

	respond(w, inv, rev)
}
```

## Section 7: Testing Degraded-Mode Behavior

Resilience patterns only matter if tested. Use interface injection to simulate upstream failures:

```go
// internal/service/order_service_test.go
package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/example/service/internal/bulkhead"
	"github.com/example/service/internal/cache"
	"github.com/example/service/internal/service"
)

type fakeInventory struct {
	latency time.Duration
	err     error
	result  *service.InventoryStatus
}

func (f *fakeInventory) Get(ctx context.Context, orderID string) (*service.InventoryStatus, error) {
	select {
	case <-time.After(f.latency):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return f.result, f.err
}

func TestInventoryFallbackOnTimeout(t *testing.T) {
	c := cache.New()
	// Pre-populate cache with stale data
	c.Set("inv:order-1", &service.InventoryStatus{
		InStock: true, Quantity: 5, Source: "stale",
	}, 10*time.Minute)

	svc := service.NewOrderService(
		&fakeInventory{latency: 500 * time.Millisecond}, // slow upstream
		c,
		bulkhead.New("test-inventory", 5, 50*time.Millisecond),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, err := svc.GetOrderDetails(ctx, "order-1")
	if err != nil {
		t.Fatalf("expected partial response, got error: %v", err)
	}
	if result.Inventory == nil {
		t.Fatal("expected cached inventory in fallback response")
	}
	if result.Inventory.Source != "cached" {
		t.Errorf("expected source=cached, got %q", result.Inventory.Source)
	}
}

func TestBulkheadProtectsPaymentFromSlowInventory(t *testing.T) {
	sem := bulkhead.New("inventory", 2, 50*time.Millisecond)

	// Saturate the inventory bulkhead
	for i := 0; i < 2; i++ {
		_ = sem.Acquire(context.Background())
	}

	// Next acquire should fail fast
	start := time.Now()
	err := sem.Acquire(context.Background())
	elapsed := time.Since(start)

	if !errors.Is(err, bulkhead.ErrBulkheadFull) {
		t.Errorf("expected ErrBulkheadFull, got %v", err)
	}
	if elapsed > 100*time.Millisecond {
		t.Errorf("bulkhead took %v, expected < 100ms", elapsed)
	}
}

func TestPartialResponseWhenReviewsUnavailable(t *testing.T) {
	c := cache.New()
	reviewsDown := errors.New("reviews service unavailable")
	svc := service.NewOrderService(
		&fakeInventory{result: &service.InventoryStatus{InStock: true, Quantity: 10}},
		c,
		bulkhead.New("inv", 5, 100*time.Millisecond),
	)
	svc.SetReviewsError(reviewsDown)

	result, err := svc.GetOrderDetails(context.Background(), "order-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Reviews should be default, not nil
	if result.Reviews == nil {
		t.Fatal("expected default reviews object")
	}
	if result.Reviews.Available {
		t.Error("expected reviews.Available=false in degraded mode")
	}
}
```

## Section 8: Health Check Granularity

Expose per-dependency health so load balancers and dashboards can distinguish between "fully healthy" and "degraded but serving":

```go
// internal/health/health.go
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type DependencyStatus struct {
	Name      string        `json:"name"`
	Healthy   bool          `json:"healthy"`
	Latency   time.Duration `json:"latency_ms"`
	LastCheck time.Time     `json:"last_check"`
	Error     string        `json:"error,omitempty"`
}

type OverallStatus struct {
	Status       string              `json:"status"` // "healthy" | "degraded" | "unhealthy"
	Dependencies []DependencyStatus  `json:"dependencies"`
}

type Checker struct {
	mu    sync.RWMutex
	deps  map[string]func(context.Context) error
	last  map[string]DependencyStatus
}

func NewChecker() *Checker {
	return &Checker{
		deps: make(map[string]func(context.Context) error),
		last: make(map[string]DependencyStatus),
	}
}

func (c *Checker) Register(name string, check func(context.Context) error) {
	c.mu.Lock()
	c.deps[name] = check
	c.mu.Unlock()
}

func (c *Checker) CheckAll(ctx context.Context) OverallStatus {
	c.mu.RLock()
	deps := make(map[string]func(context.Context) error, len(c.deps))
	for k, v := range c.deps {
		deps[k] = v
	}
	c.mu.RUnlock()

	var wg sync.WaitGroup
	results := make(chan DependencyStatus, len(deps))

	for name, fn := range deps {
		wg.Add(1)
		go func(name string, fn func(context.Context) error) {
			defer wg.Done()
			start := time.Now()
			cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			err := fn(cctx)
			s := DependencyStatus{
				Name:      name,
				Healthy:   err == nil,
				Latency:   time.Since(start),
				LastCheck: time.Now(),
			}
			if err != nil {
				s.Error = err.Error()
			}
			results <- s
		}(name, fn)
	}

	wg.Wait()
	close(results)

	statuses := make([]DependencyStatus, 0, len(deps))
	unhealthy, degraded := 0, 0
	for s := range results {
		statuses = append(statuses, s)
		if !s.Healthy {
			if isCritical(s.Name) {
				unhealthy++
			} else {
				degraded++
			}
		}
	}

	overall := "healthy"
	if unhealthy > 0 {
		overall = "unhealthy"
	} else if degraded > 0 {
		overall = "degraded"
	}

	return OverallStatus{Status: overall, Dependencies: statuses}
}

func isCritical(name string) bool {
	critical := map[string]bool{"database": true, "payment": true}
	return critical[name]
}

func (c *Checker) HTTPHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := c.CheckAll(r.Context())
		w.Header().Set("Content-Type", "application/json")
		code := http.StatusOK
		if status.Status == "unhealthy" {
			code = http.StatusServiceUnavailable
		}
		// Degraded returns 200 so load balancers keep sending traffic
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(status)
	}
}
```

These patterns compose into a resilient service that continues to deliver value under partial failure. The key discipline is designing every external call with an explicit answer to: "What should the system do if this call fails or is slow?" The answer is almost never "return an error to the user" — it is "use cached data", "return a default", "skip this component", or "queue for retry."
