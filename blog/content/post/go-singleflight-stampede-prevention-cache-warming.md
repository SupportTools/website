---
title: "Go Singleflight and Stampede Prevention: Cache Warming Under High Concurrency"
date: 2029-01-20T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Caching", "Performance", "Singleflight", "Stampede"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to preventing cache stampedes in Go using singleflight, advanced cache warming strategies, and production-grade concurrency patterns for high-throughput services."
more_link: "yes"
url: "/go-singleflight-stampede-prevention-cache-warming/"
---

The cache stampede—also called thundering herd or dogpile effect—is one of the most reliably destructive failure modes in high-traffic backend services. It occurs when a cached value expires and many concurrent goroutines attempt to recompute it simultaneously, sending a spike of expensive backend requests that overwhelms the upstream system before any of them can repopulate the cache.

Go's `golang.org/x/sync/singleflight` package provides an elegant primitive for collapsing concurrent calls into a single in-flight operation. This post examines singleflight internals, correct usage patterns, and the full production toolkit for cache warming under high concurrency—including probabilistic early expiration, background refresh, and circuit-breaker integration.

<!--more-->

## The Problem: Cache Stampede Mechanics

Consider a service that caches expensive database queries. At peak load, 10,000 requests per second hit a particular endpoint. The cached value has a 60-second TTL. When it expires, all 10,000 requests/second that arrive in the first few milliseconds will find an empty cache and simultaneously issue the expensive query.

```go
// naive_cache.go — this implementation has a stampede vulnerability
package cache

import (
	"context"
	"sync"
	"time"
)

type Entry struct {
	Value     interface{}
	ExpiresAt time.Time
}

type NaiveCache struct {
	mu    sync.RWMutex
	store map[string]*Entry
}

func (c *NaiveCache) Get(ctx context.Context, key string, fetch func(ctx context.Context) (interface{}, error)) (interface{}, error) {
	c.mu.RLock()
	entry, ok := c.store[key]
	c.mu.RUnlock()

	if ok && time.Now().Before(entry.ExpiresAt) {
		return entry.Value, nil
	}

	// HERE: every goroutine that reached this point will call fetch()
	// Under 10,000 req/s this can issue thousands of upstream calls in milliseconds
	value, err := fetch(ctx)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.store[key] = &Entry{Value: value, ExpiresAt: time.Now().Add(60 * time.Second)}
	c.mu.Unlock()

	return value, nil
}
```

Under load, the stampede can trigger database connection pool exhaustion, rate limiting on external APIs, or cascading latency spikes that cause the entire service to degrade.

## Singleflight Internals

The `singleflight.Group` maintains a map of in-flight calls keyed by a string. When multiple goroutines call `Do()` with the same key, only the first one actually executes the function. All others block until it completes, then receive the same result. The in-flight record is removed atomically when the first call completes.

```go
// singleflight source simplified for illustration
// actual source: golang.org/x/sync/singleflight

type call struct {
	wg  sync.WaitGroup
	val interface{}
	err error
	// dups tracks the number of callers waiting for this result
	dups int
}

type Group struct {
	mu sync.Mutex
	m  map[string]*call
}

func (g *Group) Do(key string, fn func() (interface{}, error)) (interface{}, error, bool) {
	g.mu.Lock()
	if g.m == nil {
		g.m = make(map[string]*call)
	}
	if c, ok := g.m[key]; ok {
		c.dups++
		g.mu.Unlock()
		// This goroutine waits for the first caller to finish
		c.wg.Wait()
		return c.val, c.err, true // true = this was a duplicate
	}
	c := new(call)
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	// Only this goroutine executes fn
	c.val, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()

	return c.val, c.err, false
}
```

The key properties:
- The function is executed exactly once per concurrent group of callers.
- All waiters receive the same `val` and `err` values.
- If the function returns an error, all waiters receive that same error.
- The third return value (`shared bool`) indicates whether the result was shared.

## Production Cache with Singleflight

```go
// pkg/cache/singleflight_cache.go
package cache

import (
	"context"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// CacheEntry holds a value with its expiration metadata.
type CacheEntry[V any] struct {
	Value     V
	ExpiresAt time.Time
	FetchedAt time.Time
}

// IsExpired returns true if the entry has passed its TTL.
func (e *CacheEntry[V]) IsExpired() bool {
	return time.Now().After(e.ExpiresAt)
}

// StalenessRatio returns a value from 0.0 (fresh) to 1.0+ (expired).
func (e *CacheEntry[V]) StalenessRatio() float64 {
	total := e.ExpiresAt.Sub(e.FetchedAt)
	elapsed := time.Since(e.FetchedAt)
	if total <= 0 {
		return 1.0
	}
	return float64(elapsed) / float64(total)
}

// FetchFunc is the function type for retrieving a fresh value.
type FetchFunc[V any] func(ctx context.Context, key string) (V, error)

// SingleflightCache is a generic cache with stampede prevention.
type SingleflightCache[V any] struct {
	mu    sync.RWMutex
	store map[string]*CacheEntry[V]
	group singleflight.Group
	ttl   time.Duration
}

// NewSingleflightCache creates a cache with the specified TTL.
func NewSingleflightCache[V any](ttl time.Duration) *SingleflightCache[V] {
	return &SingleflightCache[V]{
		store: make(map[string]*CacheEntry[V]),
		ttl:   ttl,
	}
}

// Get retrieves the value for the given key, calling fetch if necessary.
// Under concurrent access, only one fetch call is in flight per key at a time.
func (c *SingleflightCache[V]) Get(ctx context.Context, key string, fetch FetchFunc[V]) (V, error) {
	// Fast path: serve from cache under read lock
	c.mu.RLock()
	entry, ok := c.store[key]
	c.mu.RUnlock()

	if ok && !entry.IsExpired() {
		return entry.Value, nil
	}

	// Slow path: use singleflight to collapse concurrent fetches
	result, err, _ := c.group.Do(key, func() (interface{}, error) {
		// Re-check under the group — another goroutine may have populated it
		// between our read lock and the singleflight call.
		c.mu.RLock()
		if e, ok := c.store[key]; ok && !e.IsExpired() {
			c.mu.RUnlock()
			return e.Value, nil
		}
		c.mu.RUnlock()

		val, err := fetch(ctx, key)
		if err != nil {
			return *new(V), err
		}

		now := time.Now()
		c.mu.Lock()
		c.store[key] = &CacheEntry[V]{
			Value:     val,
			ExpiresAt: now.Add(c.ttl),
			FetchedAt: now,
		}
		c.mu.Unlock()

		return val, nil
	})

	if err != nil {
		var zero V
		return zero, err
	}

	return result.(V), nil
}

// Delete removes a key from the cache immediately.
func (c *SingleflightCache[V]) Delete(key string) {
	c.mu.Lock()
	delete(c.store, key)
	c.mu.Unlock()
}

// Stats returns basic cache statistics.
func (c *SingleflightCache[V]) Stats() (size int) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.store)
}

// Purge removes all expired entries.
func (c *SingleflightCache[V]) Purge() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := 0
	for k, e := range c.store {
		if e.IsExpired() {
			delete(c.store, k)
			removed++
		}
	}
	return removed
}

// String returns a formatted key for composite cache keys.
func CacheKey(parts ...interface{}) string {
	return fmt.Sprintf("%v", parts)
}
```

## Probabilistic Early Expiration

Singleflight prevents stampedes at expiration time, but it does not eliminate the latency spike that all waiting goroutines experience while the fetch is in flight. Probabilistic early expiration (XFetch algorithm) addresses this by proactively refreshing the cache before expiration:

```go
// pkg/cache/xfetch_cache.go
package cache

import (
	"context"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// XFetchCache implements the XFetch probabilistic early expiration algorithm.
// Reference: https://cseweb.ucsd.edu/~avt/pubs/fetch.pdf
type XFetchCache[V any] struct {
	mu    sync.RWMutex
	store map[string]*xfetchEntry[V]
	group singleflight.Group
	ttl   time.Duration
	// beta controls how aggressively early expiration triggers.
	// beta=1 is the theoretical optimum; higher values trigger earlier.
	beta float64
}

type xfetchEntry[V any] struct {
	Value     V
	ExpiresAt time.Time
	// delta is the time it took to compute the last value.
	// Used to estimate future computation cost.
	delta time.Duration
}

// shouldRecompute implements the XFetch early expiration decision.
// Returns true if the cache should proactively recompute before TTL expiry.
func (e *xfetchEntry[V]) shouldRecompute(beta float64) bool {
	ttl := time.Until(e.ExpiresAt)
	if ttl <= 0 {
		return true
	}
	// XFetch formula: -delta * beta * log(rand) > TTL remaining
	// As TTL approaches 0, the probability approaches 1.
	// As delta (computation time) increases, early expiration triggers sooner.
	rnd := rand.Float64()
	if rnd <= 0 {
		rnd = 1e-10
	}
	threshold := -float64(e.delta) * beta * math.Log(rnd)
	return threshold > float64(ttl)
}

func NewXFetchCache[V any](ttl time.Duration, beta float64) *XFetchCache[V] {
	if beta <= 0 {
		beta = 1.0
	}
	return &XFetchCache[V]{
		store: make(map[string]*xfetchEntry[V]),
		ttl:   ttl,
		beta:  beta,
	}
}

func (c *XFetchCache[V]) Get(ctx context.Context, key string, fetch FetchFunc[V]) (V, error) {
	c.mu.RLock()
	entry, ok := c.store[key]
	c.mu.RUnlock()

	// Determine if recomputation is needed
	needsFetch := !ok || entry.shouldRecompute(c.beta)

	if !needsFetch {
		return entry.Value, nil
	}

	result, err, _ := c.group.Do(key, func() (interface{}, error) {
		// Check again inside the singleflight group
		c.mu.RLock()
		if e, ok := c.store[key]; ok && !e.shouldRecompute(c.beta) {
			c.mu.RUnlock()
			return e.Value, nil
		}
		c.mu.RUnlock()

		start := time.Now()
		val, err := fetch(ctx, key)
		if err != nil {
			// On error, serve stale if available rather than propagating
			c.mu.RLock()
			if e, ok := c.store[key]; ok {
				c.mu.RUnlock()
				return e.Value, nil
			}
			c.mu.RUnlock()
			return *new(V), err
		}
		delta := time.Since(start)

		now := time.Now()
		c.mu.Lock()
		c.store[key] = &xfetchEntry[V]{
			Value:     val,
			ExpiresAt: now.Add(c.ttl),
			delta:     delta,
		}
		c.mu.Unlock()

		return val, nil
	})

	if err != nil {
		var zero V
		return zero, err
	}
	return result.(V), nil
}
```

## Background Refresh Pattern

For latency-sensitive paths, neither waiting for singleflight nor accepting early refresh latency may be acceptable. The background refresh pattern serves stale data immediately while refreshing in the background:

```go
// pkg/cache/background_refresh.go
package cache

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"
)

// BackgroundRefreshCache serves stale data while refreshing in the background.
// It guarantees that the fetch function is called at most once concurrently
// per key, regardless of how many goroutines request the same key.
type BackgroundRefreshCache[V any] struct {
	mu           sync.RWMutex
	store        map[string]*bgEntry[V]
	group        singleflight.Group
	ttl          time.Duration
	staleAllowed time.Duration // how long past TTL stale data is acceptable
	inflight     atomic.Int64  // number of background refreshes in progress
}

type bgEntry[V any] struct {
	Value      V
	ExpiresAt  time.Time
	Refreshing atomic.Bool
}

func NewBackgroundRefreshCache[V any](ttl, staleAllowed time.Duration) *BackgroundRefreshCache[V] {
	return &BackgroundRefreshCache[V]{
		store:        make(map[string]*bgEntry[V]),
		ttl:          ttl,
		staleAllowed: staleAllowed,
	}
}

func (c *BackgroundRefreshCache[V]) Get(ctx context.Context, key string, fetch FetchFunc[V]) (V, error) {
	c.mu.RLock()
	entry, ok := c.store[key]
	c.mu.RUnlock()

	now := time.Now()

	if !ok {
		// No entry at all — must fetch synchronously
		return c.fetchAndStore(ctx, key, fetch)
	}

	if now.Before(entry.ExpiresAt) {
		// Entry is fresh — serve immediately
		return entry.Value, nil
	}

	staleDeadline := entry.ExpiresAt.Add(c.staleAllowed)
	if now.After(staleDeadline) {
		// Entry is too stale — must fetch synchronously
		return c.fetchAndStore(ctx, key, fetch)
	}

	// Entry is stale but within acceptable staleness window.
	// Trigger background refresh and serve stale immediately.
	if !entry.Refreshing.Swap(true) {
		c.inflight.Add(1)
		go func() {
			defer c.inflight.Add(-1)
			defer entry.Refreshing.Store(false)
			// Use a background context so the refresh isn't cancelled
			// when the request context is done.
			bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, _ = c.fetchAndStore(bgCtx, key, fetch)
		}()
	}

	return entry.Value, nil
}

func (c *BackgroundRefreshCache[V]) fetchAndStore(ctx context.Context, key string, fetch FetchFunc[V]) (V, error) {
	result, err, _ := c.group.Do(key, func() (interface{}, error) {
		val, err := fetch(ctx, key)
		if err != nil {
			return *new(V), err
		}
		entry := &bgEntry[V]{
			Value:     val,
			ExpiresAt: time.Now().Add(c.ttl),
		}
		c.mu.Lock()
		c.store[key] = entry
		c.mu.Unlock()
		return val, nil
	})

	if err != nil {
		var zero V
		return zero, err
	}
	return result.(V), nil
}

// InflightRefreshes returns the count of background refresh goroutines.
func (c *BackgroundRefreshCache[V]) InflightRefreshes() int64 {
	return c.inflight.Load()
}
```

## Integration with Circuit Breaker

When the upstream fetch function is itself calling an external service, combining singleflight with a circuit breaker prevents the single in-flight goroutine from hanging indefinitely when the upstream is degraded:

```go
// pkg/cache/resilient_cache.go
package cache

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"
)

// CircuitState represents the circuit breaker state.
type CircuitState int32

const (
	CircuitClosed   CircuitState = 0 // normal operation
	CircuitOpen     CircuitState = 1 // failing — reject requests immediately
	CircuitHalfOpen CircuitState = 2 // testing — allow one request through
)

// CircuitBreaker implements a basic three-state circuit breaker.
type CircuitBreaker struct {
	state        atomic.Int32
	failures     atomic.Int32
	successes    atomic.Int32
	lastFailure  atomic.Int64 // UnixNano
	maxFailures  int32
	resetTimeout time.Duration
	halfOpenMax  int32
}

func NewCircuitBreaker(maxFailures int32, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		maxFailures:  maxFailures,
		resetTimeout: resetTimeout,
		halfOpenMax:  1,
	}
}

var ErrCircuitOpen = errors.New("circuit breaker is open")

func (cb *CircuitBreaker) Call(fn func() error) error {
	state := CircuitState(cb.state.Load())

	switch state {
	case CircuitOpen:
		lastFail := time.Unix(0, cb.lastFailure.Load())
		if time.Since(lastFail) > cb.resetTimeout {
			cb.state.CompareAndSwap(int32(CircuitOpen), int32(CircuitHalfOpen))
		} else {
			return ErrCircuitOpen
		}
	case CircuitHalfOpen:
		if cb.successes.Load() >= cb.halfOpenMax {
			return ErrCircuitOpen
		}
	}

	err := fn()
	if err != nil {
		cb.lastFailure.Store(time.Now().UnixNano())
		failures := cb.failures.Add(1)
		cb.successes.Store(0)
		if failures >= cb.maxFailures {
			cb.state.Store(int32(CircuitOpen))
		}
		return err
	}

	cb.failures.Store(0)
	cb.successes.Add(1)
	if CircuitState(cb.state.Load()) == CircuitHalfOpen {
		cb.state.Store(int32(CircuitClosed))
	}
	return nil
}

// ResilientCache combines singleflight, background refresh, and circuit breaking.
type ResilientCache[V any] struct {
	mu      sync.RWMutex
	store   map[string]*CacheEntry[V]
	group   singleflight.Group
	ttl     time.Duration
	breaker *CircuitBreaker
}

func NewResilientCache[V any](ttl time.Duration, breaker *CircuitBreaker) *ResilientCache[V] {
	return &ResilientCache[V]{
		store:   make(map[string]*CacheEntry[V]),
		ttl:     ttl,
		breaker: breaker,
	}
}

func (c *ResilientCache[V]) Get(ctx context.Context, key string, fetch FetchFunc[V]) (V, error) {
	c.mu.RLock()
	entry, ok := c.store[key]
	c.mu.RUnlock()

	if ok && !entry.IsExpired() {
		return entry.Value, nil
	}

	result, err, _ := c.group.Do(key, func() (interface{}, error) {
		c.mu.RLock()
		if e, ok := c.store[key]; ok && !e.IsExpired() {
			c.mu.RUnlock()
			return e.Value, nil
		}
		c.mu.RUnlock()

		var val V
		fetchErr := c.breaker.Call(func() error {
			var err error
			val, err = fetch(ctx, key)
			return err
		})

		if fetchErr != nil {
			// Serve stale on circuit breaker open
			if errors.Is(fetchErr, ErrCircuitOpen) {
				c.mu.RLock()
				if e, ok := c.store[key]; ok {
					stale := e.Value
					c.mu.RUnlock()
					return stale, nil
				}
				c.mu.RUnlock()
			}
			return *new(V), fmt.Errorf("fetch failed: %w", fetchErr)
		}

		now := time.Now()
		c.mu.Lock()
		c.store[key] = &CacheEntry[V]{
			Value:     val,
			ExpiresAt: now.Add(c.ttl),
			FetchedAt: now,
		}
		c.mu.Unlock()

		return val, nil
	})

	if err != nil {
		var zero V
		return zero, err
	}
	return result.(V), nil
}
```

## Testing Stampede Prevention

Proper testing requires concurrent goroutines and a mechanism to count actual fetch calls:

```go
// pkg/cache/singleflight_cache_test.go
package cache_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/example/myservice/pkg/cache"
)

func TestSingleflightCollapsesConcurrentFetches(t *testing.T) {
	c := cache.NewSingleflightCache[string](5 * time.Second)

	var fetchCount atomic.Int64
	fetchFn := func(ctx context.Context, key string) (string, error) {
		fetchCount.Add(1)
		// Simulate a slow upstream call
		time.Sleep(50 * time.Millisecond)
		return "value-for-" + key, nil
	}

	const goroutines = 100
	var wg sync.WaitGroup
	results := make([]string, goroutines)
	errs := make([]error, goroutines)

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			results[idx], errs[idx] = c.Get(context.Background(), "test-key", fetchFn)
		}(i)
	}
	wg.Wait()

	// Verify all goroutines got the correct value
	for i, err := range errs {
		if err != nil {
			t.Errorf("goroutine %d got error: %v", i, err)
		}
		if results[i] != "value-for-test-key" {
			t.Errorf("goroutine %d got wrong value: %s", i, results[i])
		}
	}

	// The critical assertion: fetch should have been called exactly once
	if count := fetchCount.Load(); count != 1 {
		t.Errorf("expected 1 fetch call, got %d — stampede prevention failed", count)
	}
}

func TestBackgroundRefreshServesStaleWhileRefreshing(t *testing.T) {
	c := cache.NewBackgroundRefreshCache[string](
		100*time.Millisecond, // TTL
		500*time.Millisecond, // stale window
	)

	var fetchCount atomic.Int64
	fetchFn := func(ctx context.Context, key string) (string, error) {
		n := fetchCount.Add(1)
		time.Sleep(20 * time.Millisecond)
		return fmt.Sprintf("value-%d", n), nil
	}

	ctx := context.Background()

	// Initial fetch — synchronous
	v1, err := c.Get(ctx, "key", fetchFn)
	if err != nil || fetchCount.Load() != 1 {
		t.Fatalf("initial fetch failed: v=%s err=%v fetchCount=%d", v1, err, fetchCount.Load())
	}

	// Wait for TTL to expire
	time.Sleep(150 * time.Millisecond)

	// This should return stale v1 immediately and trigger background refresh
	v2, err := c.Get(ctx, "key", fetchFn)
	if err != nil {
		t.Fatalf("stale-serve failed: %v", err)
	}
	if v2 != v1 {
		t.Errorf("expected stale value %s, got %s", v1, v2)
	}

	// Wait for background refresh to complete
	time.Sleep(50 * time.Millisecond)

	// Now should have fresh value
	v3, err := c.Get(ctx, "key", fetchFn)
	if err != nil || v3 == v1 {
		t.Errorf("expected refreshed value, got %s (same as stale %s)", v3, v1)
	}
}
```

## Observability: Metrics for Cache Behavior

```go
// pkg/cache/instrumented_cache.go
package cache

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	cacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "myservice",
		Subsystem: "cache",
		Name:      "hits_total",
		Help:      "Total number of cache hits.",
	}, []string{"cache_name", "key_prefix"})

	cacheMisses = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "myservice",
		Subsystem: "cache",
		Name:      "misses_total",
		Help:      "Total number of cache misses (triggered a fetch).",
	}, []string{"cache_name", "key_prefix"})

	cacheStampedes = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "myservice",
		Subsystem: "cache",
		Name:      "stampedes_prevented_total",
		Help:      "Total number of duplicate requests collapsed by singleflight.",
	}, []string{"cache_name"})

	fetchDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "myservice",
		Subsystem: "cache",
		Name:      "fetch_duration_seconds",
		Help:      "Duration of upstream fetch calls.",
		Buckets:   prometheus.ExponentialBuckets(0.001, 2, 12),
	}, []string{"cache_name", "status"})

	cacheSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "myservice",
		Subsystem: "cache",
		Name:      "entries",
		Help:      "Current number of entries in the cache.",
	}, []string{"cache_name"})
)

// InstrumentedFetch wraps a FetchFunc with Prometheus metrics.
func InstrumentedFetch[V any](cacheName string, fetch FetchFunc[V]) FetchFunc[V] {
	return func(ctx context.Context, key string) (V, error) {
		start := time.Now()
		val, err := fetch(ctx, key)
		status := "success"
		if err != nil {
			status = "error"
		}
		fetchDuration.WithLabelValues(cacheName, status).Observe(time.Since(start).Seconds())
		return val, err
	}
}
```

## Prometheus Alerting Rules for Cache Health

```yaml
groups:
- name: cache.rules
  rules:
  - alert: CacheHighMissRate
    expr: |
      rate(myservice_cache_misses_total[5m])
      / (rate(myservice_cache_hits_total[5m]) + rate(myservice_cache_misses_total[5m]))
      > 0.5
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Cache miss rate exceeds 50% for {{ $labels.cache_name }}"
      description: "Miss rate is {{ $value | humanizePercentage }}. Consider increasing TTL or cache capacity."

  - alert: CacheFetchErrorRate
    expr: |
      rate(myservice_cache_fetch_duration_seconds_count{status="error"}[5m])
      / rate(myservice_cache_fetch_duration_seconds_count[5m])
      > 0.01
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Cache fetch error rate exceeds 1% for {{ $labels.cache_name }}"

  - alert: CacheFetchSlowdown
    expr: |
      histogram_quantile(0.99, rate(myservice_cache_fetch_duration_seconds_bucket[5m])) > 5
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Cache fetch p99 latency exceeds 5s for {{ $labels.cache_name }}"
```

## Choosing the Right Pattern

| Scenario | Recommended Pattern | Rationale |
|---|---|---|
| Standard API cache, moderate load | `SingleflightCache` | Simple, correct, low overhead |
| High-frequency expiration, small TTL | `XFetchCache` (beta=1) | Prevents synchronous refresh spikes |
| Latency-critical, stale acceptable | `BackgroundRefreshCache` | Serves stale immediately |
| Upstream is external/unreliable | `ResilientCache` + circuit breaker | Prevents cascade failures |
| Read-heavy, rarely-changing data | All of the above + `sync.Map` | Pre-warm on startup, near-zero lock contention |

The singleflight pattern is not a silver bullet. It does not help when cache expiration is staggered (different keys expire at different times) or when the fetch function itself is slow enough that users notice the wait. Background refresh is the right answer for user-facing latency budgets under 100ms.

## Summary

Cache stampedes are a predictable failure mode that singleflight directly addresses. The patterns in this post escalate in complexity:

1. `SingleflightCache` — correct foundation, minimal complexity
2. `XFetchCache` — probabilistic early refresh for predictable TTL expiry
3. `BackgroundRefreshCache` — serve stale data while refreshing for zero user-visible latency
4. `ResilientCache` — circuit breaker integration for unreliable upstream calls

All production caches should emit Prometheus metrics for hit rate, miss rate, fetch duration, and error rate. The alerting rules above form a complete observability foundation for detecting stampede events and degraded upstream performance before they cascade into user-visible incidents.
