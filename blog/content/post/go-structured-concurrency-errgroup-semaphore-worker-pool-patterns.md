---
title: "Go Structured Concurrency: errgroup, semaphore, and WorkerPool Patterns"
date: 2031-05-06T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "errgroup", "semaphore", "Worker Pool", "Goroutines", "Production"]
categories: ["Go", "Concurrency"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Go structured concurrency with golang.org/x/sync: errgroup for parallel error collection, semaphore for concurrency limiting, worker pool patterns with bounded goroutines, pipeline cancellation, and graceful shutdown."
more_link: "yes"
url: "/go-structured-concurrency-errgroup-semaphore-worker-pool-patterns/"
---

Unstructured goroutine spawning is one of the most common sources of production bugs in Go services: goroutine leaks, missed errors, and races during shutdown. The `golang.org/x/sync` package provides the building blocks for structured concurrency - patterns where goroutine lifetimes are always bounded, errors are always propagated, and shutdown is always clean. This guide covers production patterns used in high-throughput Go services.

<!--more-->

# Go Structured Concurrency: errgroup, semaphore, and WorkerPool Patterns

## Section 1: The Problem with Unstructured Goroutines

Consider this common anti-pattern:

```go
// WRONG: Unstructured goroutine spawning
func processItems(items []Item) []Result {
    results := make([]Result, len(items))
    for i, item := range items {
        go func(idx int, it Item) {  // Leak potential
            results[idx] = process(it)  // Race condition: no synchronization
        }(i, item)
    }
    // BUG: Returns before goroutines complete
    // BUG: No error propagation
    // BUG: No cancellation support
    return results
}
```

Problems:
1. Returns before goroutines finish - results are partially written
2. No error handling - `process()` errors are silently dropped
3. No cancellation - if context is cancelled, goroutines keep running
4. No bound on goroutine count - with 10,000 items, spawns 10,000 goroutines

The structured approach fixes all four:

```go
// CORRECT: Structured with errgroup + semaphore
func processItems(ctx context.Context, items []Item) ([]Result, error) {
    results := make([]Result, len(items))
    sem := semaphore.NewWeighted(int64(runtime.GOMAXPROCS(0)))

    g, ctx := errgroup.WithContext(ctx)
    for i, item := range items {
        i, item := i, item  // Loop variable capture
        g.Go(func() error {
            if err := sem.Acquire(ctx, 1); err != nil {
                return err  // ctx cancelled
            }
            defer sem.Release(1)

            result, err := process(ctx, item)
            if err != nil {
                return fmt.Errorf("item %d: %w", i, err)
            }
            results[i] = result
            return nil
        })
    }

    return results, g.Wait()
}
```

## Section 2: Installation

```bash
go get golang.org/x/sync@latest

# Includes:
# golang.org/x/sync/errgroup    - group of goroutines with error propagation
# golang.org/x/sync/semaphore   - weighted semaphore
# golang.org/x/sync/singleflight - deduplicate concurrent requests
# golang.org/x/sync/syncmap     - sync.Map with typed API (pre-generics)
```

## Section 3: errgroup - Parallel Operations with Error Collection

`errgroup` is the foundation of structured concurrency in Go. It groups goroutines, waits for all to complete, and returns the first error.

### Basic Usage

```go
package main

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/errgroup"
)

// FetchUserData fetches user, orders, and preferences in parallel.
// Returns error if any fetch fails. All three must succeed.
func FetchUserData(ctx context.Context, userID string) (*UserData, error) {
	g, ctx := errgroup.WithContext(ctx)

	var (
		user   *User
		orders []*Order
		prefs  *Preferences
	)

	g.Go(func() error {
		var err error
		user, err = fetchUser(ctx, userID)
		return err
	})

	g.Go(func() error {
		var err error
		orders, err = fetchOrders(ctx, userID)
		return err
	})

	g.Go(func() error {
		var err error
		prefs, err = fetchPreferences(ctx, userID)
		return err
	})

	// Wait for all goroutines to complete
	// If any returns an error, the context is cancelled (all others see cancellation)
	if err := g.Wait(); err != nil {
		return nil, fmt.Errorf("fetching user data for %s: %w", userID, err)
	}

	return &UserData{User: user, Orders: orders, Preferences: prefs}, nil
}
```

### Collecting All Errors (not just the first)

The standard `errgroup` returns only the first error. For batch operations where you want all errors:

```go
// MultiError collects all errors from a set of operations.
type MultiError struct {
	mu     sync.Mutex
	errors []error
}

func (m *MultiError) Add(err error) {
	if err == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.errors = append(m.errors, err)
}

func (m *MultiError) Error() string {
	if len(m.errors) == 0 {
		return ""
	}
	msgs := make([]string, len(m.errors))
	for i, err := range m.errors {
		msgs[i] = err.Error()
	}
	return fmt.Sprintf("%d errors: %s", len(m.errors), strings.Join(msgs, "; "))
}

func (m *MultiError) Err() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.errors) == 0 {
		return nil
	}
	return m
}

// ProcessAllItems processes all items and collects all errors.
func ProcessAllItems(ctx context.Context, items []Item) error {
	var merr MultiError
	var wg sync.WaitGroup

	for _, item := range items {
		item := item
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := processItem(ctx, item); err != nil {
				merr.Add(fmt.Errorf("item %s: %w", item.ID, err))
			}
		}()
	}

	wg.Wait()
	return merr.Err()
}
```

### errgroup with Limit (Go 1.21+)

```go
// SetLimit limits the number of active goroutines
func ProcessWithLimit(ctx context.Context, items []Item, concurrency int) error {
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(concurrency)  // Max concurrent goroutines

	for _, item := range items {
		item := item
		g.Go(func() error {
			return processItem(ctx, item)
		})
	}

	return g.Wait()
}
```

### errgroup for Pipeline Stages

```go
// Pipeline with errgroup connects producer -> transform -> consumer
func Pipeline(ctx context.Context, input []string) error {
	g, ctx := errgroup.WithContext(ctx)

	// Stage 1: Producer
	rawCh := make(chan string, 100)
	g.Go(func() error {
		defer close(rawCh)
		for _, item := range input {
			select {
			case rawCh <- item:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	})

	// Stage 2: Transform
	transformedCh := make(chan TransformedItem, 100)
	g.Go(func() error {
		defer close(transformedCh)
		for raw := range rawCh {
			transformed, err := transform(ctx, raw)
			if err != nil {
				return fmt.Errorf("transform %q: %w", raw, err)
			}
			select {
			case transformedCh <- transformed:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	})

	// Stage 3: Consumer
	g.Go(func() error {
		for item := range transformedCh {
			if err := consume(ctx, item); err != nil {
				return fmt.Errorf("consume: %w", err)
			}
		}
		return nil
	})

	return g.Wait()
}
```

## Section 4: Semaphore for Concurrency Limiting

The `semaphore.Weighted` allows both binary (mutex-like) and counting (n concurrent) semaphores:

```go
package concurrency

import (
	"context"
	"fmt"
	"runtime"
	"sync"

	"golang.org/x/sync/semaphore"
)

// BoundedParallelMap applies f to each element of items with at most concurrency goroutines active.
func BoundedParallelMap[T, R any](
	ctx context.Context,
	items []T,
	concurrency int,
	f func(context.Context, T) (R, error),
) ([]R, error) {
	if concurrency <= 0 {
		concurrency = runtime.GOMAXPROCS(0)
	}

	results := make([]R, len(items))
	sem := semaphore.NewWeighted(int64(concurrency))

	var (
		mu   sync.Mutex
		errs []error
		wg   sync.WaitGroup
	)

	for i, item := range items {
		i, item := i, item

		// Acquire semaphore slot (blocks if concurrency reached)
		if err := sem.Acquire(ctx, 1); err != nil {
			// Context cancelled - wait for in-flight goroutines
			wg.Wait()
			return nil, fmt.Errorf("acquiring semaphore: %w", err)
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			defer sem.Release(1)

			result, err := f(ctx, item)
			if err != nil {
				mu.Lock()
				errs = append(errs, fmt.Errorf("item[%d]: %w", i, err))
				mu.Unlock()
				return
			}
			results[i] = result
		}()
	}

	wg.Wait()

	if len(errs) > 0 {
		return nil, fmt.Errorf("%d errors: %v", len(errs), errs)
	}

	return results, nil
}

// Example: Fetch 1000 URLs with max 20 concurrent HTTP requests
func FetchURLs(ctx context.Context, urls []string) ([][]byte, error) {
	return BoundedParallelMap(ctx, urls, 20, func(ctx context.Context, url string) ([]byte, error) {
		return httpGet(ctx, url)
	})
}
```

### Weighted Semaphore for Resource-Aware Concurrency

```go
// WeightedProcessor processes items where each item has a different resource weight.
// For example: small items take 1 unit, large items take 4 units.
type WeightedProcessor struct {
	sem    *semaphore.Weighted
	maxCap int64
}

type Item struct {
	ID     string
	Data   []byte
	Weight int64  // Resource weight (e.g., megabytes of data)
}

func NewWeightedProcessor(maxCapacityMB int64) *WeightedProcessor {
	return &WeightedProcessor{
		sem:    semaphore.NewWeighted(maxCapacityMB),
		maxCap: maxCapacityMB,
	}
}

func (wp *WeightedProcessor) Process(ctx context.Context, items []Item) error {
	g, ctx := errgroup.WithContext(ctx)

	for _, item := range items {
		item := item
		weight := item.Weight
		if weight <= 0 {
			weight = 1
		}
		if weight > wp.maxCap {
			// Item exceeds total capacity - process alone
			weight = wp.maxCap
		}

		g.Go(func() error {
			// Acquire weight units (blocks until enough capacity available)
			if err := wp.sem.Acquire(ctx, weight); err != nil {
				return fmt.Errorf("acquire(%d): %w", weight, err)
			}
			defer wp.sem.Release(weight)

			return processItem(ctx, item)
		})
	}

	return g.Wait()
}
```

## Section 5: Worker Pool with Bounded Goroutines

A reusable worker pool that accepts jobs via a channel:

```go
// pool/pool.go
package pool

import (
	"context"
	"fmt"
	"runtime"
	"sync"
)

// Job represents a unit of work.
type Job[I, O any] struct {
	Input  I
	Index  int
}

// Result wraps the output of a job.
type Result[O any] struct {
	Output O
	Index  int
	Err    error
}

// WorkerPool processes jobs with a bounded number of worker goroutines.
type WorkerPool[I, O any] struct {
	workers   int
	processor func(context.Context, I) (O, error)
}

// NewWorkerPool creates a WorkerPool with a bounded number of workers.
func NewWorkerPool[I, O any](
	workers int,
	processor func(context.Context, I) (O, error),
) *WorkerPool[I, O] {
	if workers <= 0 {
		workers = runtime.GOMAXPROCS(0)
	}
	return &WorkerPool[I, O]{
		workers:   workers,
		processor: processor,
	}
}

// Process processes all inputs and returns results preserving order.
// All inputs are processed; errors are collected per-item.
func (wp *WorkerPool[I, O]) Process(ctx context.Context, inputs []I) ([]Result[O], error) {
	if len(inputs) == 0 {
		return nil, nil
	}

	jobCh := make(chan Job[I, O], len(inputs))
	resultCh := make(chan Result[O], len(inputs))

	// Start workers
	var wg sync.WaitGroup
	for w := 0; w < wp.workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobCh {
				select {
				case <-ctx.Done():
					resultCh <- Result[O]{Index: job.Index, Err: ctx.Err()}
				default:
					output, err := wp.processor(ctx, job.Input)
					resultCh <- Result[O]{
						Output: output,
						Index:  job.Index,
						Err:    err,
					}
				}
			}
		}()
	}

	// Send all jobs
	for i, input := range inputs {
		jobCh <- Job[I, O]{Input: input, Index: i}
	}
	close(jobCh)

	// Close result channel when all workers done
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	// Collect results in order
	results := make([]Result[O], len(inputs))
	for r := range resultCh {
		results[r.Index] = r
	}

	return results, nil
}

// ProcessOrdered processes inputs in order, maintaining concurrency.
// Unlike Process, it stops on first error.
func (wp *WorkerPool[I, O]) ProcessOrdered(ctx context.Context, inputs []I) ([]O, error) {
	results, err := wp.Process(ctx, inputs)
	if err != nil {
		return nil, err
	}

	outputs := make([]O, len(inputs))
	var firstErr error
	for _, r := range results {
		if r.Err != nil && firstErr == nil {
			firstErr = fmt.Errorf("item[%d]: %w", r.Index, r.Err)
		}
		if r.Err == nil {
			outputs[r.Index] = r.Output
		}
	}

	return outputs, firstErr
}
```

Using the worker pool:

```go
// Example: Process payment records in parallel with a pool of 10 workers
func ProcessPaymentBatch(ctx context.Context, payments []PaymentRecord) error {
	pool := pool.NewWorkerPool(10, func(ctx context.Context, p PaymentRecord) (ProcessedPayment, error) {
		return processPayment(ctx, p)
	})

	results, err := pool.Process(ctx, payments)
	if err != nil {
		return fmt.Errorf("pool error: %w", err)
	}

	// Collect all failures for reporting
	var failures []error
	for _, r := range results {
		if r.Err != nil {
			failures = append(failures, fmt.Errorf("payment %s: %w", payments[r.Index].ID, r.Err))
		}
	}

	if len(failures) > 0 {
		return fmt.Errorf("%d payments failed: %v", len(failures), failures)
	}

	return nil
}
```

## Section 6: Dynamic Worker Pool (Streaming Jobs)

For processing an unbounded stream of jobs:

```go
// pool/streaming_pool.go
package pool

import (
	"context"
	"sync"
	"sync/atomic"
)

// StreamingPool is a worker pool that accepts jobs via a channel.
type StreamingPool[I, O any] struct {
	jobCh     chan I
	resultCh  chan Result[O]
	workers   int
	processor func(context.Context, I) (O, error)
	wg        sync.WaitGroup
	started   atomic.Bool
}

// NewStreamingPool creates a streaming worker pool.
func NewStreamingPool[I, O any](
	workers int,
	bufferSize int,
	processor func(context.Context, I) (O, error),
) *StreamingPool[I, O] {
	return &StreamingPool[I, O]{
		jobCh:     make(chan I, bufferSize),
		resultCh:  make(chan Result[O], bufferSize),
		workers:   workers,
		processor: processor,
	}
}

// Start starts the worker pool with the given context.
func (sp *StreamingPool[I, O]) Start(ctx context.Context) {
	if !sp.started.CompareAndSwap(false, true) {
		return
	}

	for w := 0; w < sp.workers; w++ {
		sp.wg.Add(1)
		go func() {
			defer sp.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-sp.jobCh:
					if !ok {
						return
					}
					output, err := sp.processor(ctx, job)
					sp.resultCh <- Result[O]{Output: output, Err: err}
				}
			}
		}()
	}

	// Close result channel when all workers finish
	go func() {
		sp.wg.Wait()
		close(sp.resultCh)
	}()
}

// Submit sends a job to the pool. Blocks if the buffer is full.
func (sp *StreamingPool[I, O]) Submit(ctx context.Context, job I) error {
	select {
	case sp.jobCh <- job:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Results returns the channel for reading results.
func (sp *StreamingPool[I, O]) Results() <-chan Result[O] {
	return sp.resultCh
}

// Close signals that no more jobs will be submitted.
func (sp *StreamingPool[I, O]) Close() {
	close(sp.jobCh)
}
```

Example usage with a Kafka consumer:

```go
// Process Kafka messages with a bounded worker pool
func ProcessKafkaMessages(ctx context.Context, consumer sarama.ConsumerGroup) error {
	pool := pool.NewStreamingPool(20, 100, func(ctx context.Context, msg *sarama.ConsumerMessage) (interface{}, error) {
		return nil, processKafkaMessage(ctx, msg)
	})
	pool.Start(ctx)

	// Collect results in a separate goroutine
	var resultErr error
	var resultWg sync.WaitGroup
	resultWg.Add(1)
	go func() {
		defer resultWg.Done()
		for r := range pool.Results() {
			if r.Err != nil {
				resultErr = r.Err
			}
		}
	}()

	// Main loop: consume messages and submit to pool
	handler := &messageHandler{pool: pool}
	if err := consumer.Consume(ctx, []string{"payments.events"}, handler); err != nil {
		return err
	}

	pool.Close()
	resultWg.Wait()
	return resultErr
}
```

## Section 7: singleflight - Deduplicating Concurrent Requests

`singleflight` collapses concurrent identical requests into one, crucial for cache stampede prevention:

```go
package cache

import (
	"context"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// PaymentCache is a cache with singleflight for cache miss deduplication.
type PaymentCache struct {
	mu      sync.RWMutex
	data    map[string]*CachedPayment
	group   singleflight.Group
	backend PaymentRepository
}

// Get retrieves a payment, using singleflight to deduplicate concurrent fetches.
func (c *PaymentCache) Get(ctx context.Context, id string) (*Payment, error) {
	// Fast path: in-memory cache hit
	c.mu.RLock()
	if cached, ok := c.data[id]; ok && !cached.IsExpired() {
		c.mu.RUnlock()
		return cached.Payment, nil
	}
	c.mu.RUnlock()

	// Cache miss: use singleflight to deduplicate concurrent DB fetches
	// Multiple goroutines waiting for the same key will all wait for the single fetch
	v, err, shared := c.group.Do(id, func() (interface{}, error) {
		// Only one goroutine executes this; others share the result
		payment, err := c.backend.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}

		// Store in cache
		c.mu.Lock()
		c.data[id] = &CachedPayment{
			Payment:   payment,
			ExpiresAt: time.Now().Add(5 * time.Minute),
		}
		c.mu.Unlock()

		return payment, nil
	})

	if err != nil {
		return nil, fmt.Errorf("fetching payment %s: %w", id, err)
	}

	_ = shared // true if this result was shared with other goroutines
	return v.(*Payment), nil
}
```

## Section 8: Graceful Shutdown with WaitGroup

Production services need to drain in-flight requests on shutdown:

```go
// server/graceful.go
package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// GracefulServer wraps an HTTP server with clean shutdown semantics.
type GracefulServer struct {
	server     *http.Server
	logger     *slog.Logger
	shutdownCh chan struct{}

	// Track in-flight requests
	activeRequests atomic.Int64
	requestsDone   chan struct{}
}

// Handler middleware to track active requests
func (gs *GracefulServer) trackRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gs.activeRequests.Add(1)
		defer gs.activeRequests.Add(-1)

		// Reject new requests during shutdown
		select {
		case <-gs.shutdownCh:
			http.Error(w, "server shutting down", http.StatusServiceUnavailable)
			return
		default:
		}

		next.ServeHTTP(w, r)
	})
}

// Start starts the server and blocks until shutdown.
func (gs *GracefulServer) Start(addr string) error {
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	serverErr := make(chan error, 1)
	go func() {
		gs.logger.Info("server starting", "addr", addr)
		if err := gs.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()

	// Wait for shutdown signal or server error
	select {
	case err := <-serverErr:
		return fmt.Errorf("server error: %w", err)

	case sig := <-quit:
		gs.logger.Info("shutdown signal received", "signal", sig)
		return gs.Shutdown(30 * time.Second)
	}
}

// Shutdown performs a graceful shutdown with a deadline.
func (gs *GracefulServer) Shutdown(timeout time.Duration) error {
	gs.logger.Info("initiating graceful shutdown")

	// Signal that no new requests should be accepted
	close(gs.shutdownCh)

	// Create shutdown context with deadline
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Stop accepting new connections
	if err := gs.server.Shutdown(ctx); err != nil {
		return fmt.Errorf("HTTP server shutdown: %w", err)
	}

	// Wait for active requests to complete
	deadline := time.Now().Add(timeout)
	for gs.activeRequests.Load() > 0 {
		if time.Now().After(deadline) {
			gs.logger.Warn("shutdown timeout: forcing close", "active_requests", gs.activeRequests.Load())
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	gs.logger.Info("shutdown complete", "active_requests", gs.activeRequests.Load())
	return nil
}
```

## Section 9: Concurrent Map Pattern (sync.Map vs Sharded Map)

```go
// concurrency/sharded_map.go
package concurrency

import (
	"hash/fnv"
	"sync"
)

const defaultShards = 32

// ShardedMap is a concurrent map sharded to reduce lock contention.
// Better than sync.Map for high write workloads.
type ShardedMap[K comparable, V any] struct {
	shards []shard[K, V]
	nShards int
}

type shard[K comparable, V any] struct {
	mu   sync.RWMutex
	data map[K]V
}

// NewShardedMap creates a new ShardedMap with the given number of shards.
func NewShardedMap[K comparable, V any](shardCount int) *ShardedMap[K, V] {
	if shardCount <= 0 {
		shardCount = defaultShards
	}
	sm := &ShardedMap[K, V]{
		shards:  make([]shard[K, V], shardCount),
		nShards: shardCount,
	}
	for i := range sm.shards {
		sm.shards[i].data = make(map[K]V)
	}
	return sm
}

func (sm *ShardedMap[K, V]) shardFor(key any) *shard[K, V] {
	h := fnv.New32a()
	fmt.Fprintf(h, "%v", key)
	return &sm.shards[int(h.Sum32())%sm.nShards]
}

// Set stores a value in the map.
func (sm *ShardedMap[K, V]) Set(key K, value V) {
	s := sm.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = value
}

// Get retrieves a value from the map.
func (sm *ShardedMap[K, V]) Get(key K) (V, bool) {
	s := sm.shardFor(key)
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.data[key]
	return v, ok
}

// Delete removes a key from the map.
func (sm *ShardedMap[K, V]) Delete(key K) {
	s := sm.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
}

// GetOrSet atomically gets an existing value or sets a new one.
func (sm *ShardedMap[K, V]) GetOrSet(key K, defaultFn func() V) (V, bool) {
	s := sm.shardFor(key)

	// Fast path: read lock
	s.mu.RLock()
	v, ok := s.data[key]
	s.mu.RUnlock()
	if ok {
		return v, true
	}

	// Slow path: write lock
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check again (double-checked locking)
	if v, ok := s.data[key]; ok {
		return v, true
	}

	v = defaultFn()
	s.data[key] = v
	return v, false
}
```

## Section 10: Rate-Limited Goroutine Launcher

Control goroutine launch rate to prevent thundering herd:

```go
// concurrency/ratelimited.go
package concurrency

import (
	"context"
	"time"

	"golang.org/x/time/rate"
)

// RateLimitedForEach applies f to each item with a rate limit on goroutine launches.
func RateLimitedForEach[T any](
	ctx context.Context,
	items []T,
	ratePerSecond float64,
	burst int,
	f func(context.Context, T) error,
) error {
	limiter := rate.NewLimiter(rate.Limit(ratePerSecond), burst)
	g, ctx := errgroup.WithContext(ctx)

	for _, item := range items {
		// Wait for rate limiter before launching
		if err := limiter.Wait(ctx); err != nil {
			break
		}

		item := item
		g.Go(func() error {
			return f(ctx, item)
		})
	}

	return g.Wait()
}

// TickerWorker processes items at a fixed interval.
type TickerWorker struct {
	interval  time.Duration
	processor func(context.Context) error
}

func NewTickerWorker(interval time.Duration, processor func(context.Context) error) *TickerWorker {
	return &TickerWorker{
		interval:  interval,
		processor: processor,
	}
}

func (tw *TickerWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(tw.interval)
	defer ticker.Stop()

	// Run once immediately
	if err := tw.processor(ctx); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := tw.processor(ctx); err != nil {
				return err
			}
		}
	}
}
```

## Section 11: Testing Concurrent Code

```go
// concurrency/pool_test.go
package pool_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/myorg/payment-service/internal/concurrency/pool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkerPool_ProcessesAllItems(t *testing.T) {
	t.Parallel()

	const itemCount = 1000
	const workers = 10

	var processed atomic.Int64

	p := pool.NewWorkerPool(workers, func(ctx context.Context, n int) (int, error) {
		time.Sleep(time.Millisecond)  // Simulate work
		processed.Add(1)
		return n * 2, nil
	})

	inputs := make([]int, itemCount)
	for i := range inputs {
		inputs[i] = i
	}

	results, err := p.ProcessOrdered(context.Background(), inputs)
	require.NoError(t, err)
	assert.Len(t, results, itemCount)
	assert.Equal(t, int64(itemCount), processed.Load())

	// Verify results are correct and in order
	for i, r := range results {
		assert.Equal(t, i*2, r, "result[%d] should be %d but got %d", i, i*2, r)
	}
}

func TestWorkerPool_RespectsCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())

	var processed atomic.Int64
	p := pool.NewWorkerPool(5, func(ctx context.Context, n int) (int, error) {
		// Cancel context after 10 items processed
		if processed.Load() == 10 {
			cancel()
		}
		processed.Add(1)

		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(10 * time.Millisecond):
			return n, nil
		}
	})

	inputs := make([]int, 1000)
	_, err := p.ProcessOrdered(ctx, inputs)

	// Should return context error
	assert.ErrorIs(t, err, context.Canceled)
	// Should not process all 1000 items
	assert.Less(t, processed.Load(), int64(1000))
}

func TestBoundedParallelMap_ConcurrencyLimit(t *testing.T) {
	t.Parallel()

	const concurrency = 5
	var maxConcurrent atomic.Int64
	var currentConcurrent atomic.Int64

	_, err := BoundedParallelMap(
		context.Background(),
		make([]int, 100),
		concurrency,
		func(ctx context.Context, n int) (int, error) {
			c := currentConcurrent.Add(1)
			defer currentConcurrent.Add(-1)

			// Track maximum concurrent executions
			for {
				max := maxConcurrent.Load()
				if c <= max || maxConcurrent.CompareAndSwap(max, c) {
					break
				}
			}

			time.Sleep(5 * time.Millisecond)
			return n, nil
		},
	)

	require.NoError(t, err)
	assert.LessOrEqual(t, maxConcurrent.Load(), int64(concurrency),
		"max concurrent %d exceeded limit %d", maxConcurrent.Load(), concurrency)
}

// Race detector test - run with: go test -race ./...
func TestWorkerPool_NoRaceConditions(t *testing.T) {
	results := make([]int, 0, 1000)
	var mu sync.Mutex

	p := pool.NewWorkerPool(20, func(ctx context.Context, n int) (int, error) {
		return n * n, nil
	})

	inputs := make([]int, 1000)
	for i := range inputs {
		inputs[i] = i
	}

	processedResults, err := p.Process(context.Background(), inputs)
	require.NoError(t, err)

	for _, r := range processedResults {
		if r.Err == nil {
			mu.Lock()
			results = append(results, r.Output)
			mu.Unlock()
		}
	}

	assert.Len(t, results, 1000)
}
```

## Section 12: Production Patterns - Service Startup

Orchestrate multiple service components with clean startup and shutdown:

```go
// cmd/service/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"
)

// runService starts all components and shuts them down cleanly on signal.
func runService(ctx context.Context) error {
	g, ctx := errgroup.WithContext(ctx)

	// HTTP server component
	g.Go(func() error {
		server := newHTTPServer()
		if err := server.Start(":8080"); err != nil {
			return fmt.Errorf("HTTP server: %w", err)
		}
		return nil
	})

	// gRPC server component
	g.Go(func() error {
		server := newGRPCServer()
		if err := server.Start(":50051"); err != nil {
			return fmt.Errorf("gRPC server: %w", err)
		}
		return nil
	})

	// Background worker: process payment queue
	g.Go(func() error {
		worker := newPaymentWorker()
		if err := worker.Run(ctx); err != nil && err != context.Canceled {
			return fmt.Errorf("payment worker: %w", err)
		}
		return nil
	})

	// Background worker: send notifications
	g.Go(func() error {
		worker := newNotificationWorker()
		if err := worker.Run(ctx); err != nil && err != context.Canceled {
			return fmt.Errorf("notification worker: %w", err)
		}
		return nil
	})

	// Metrics collector
	g.Go(func() error {
		return metricsServer.Start(ctx, ":9090")
	})

	return g.Wait()
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Root context with signal handling
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Set shutdown deadline
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = shutdownCtx

	if err := runService(ctx); err != nil {
		logger.Error("service error", "error", err)
		os.Exit(1)
	}

	logger.Info("service stopped cleanly")
}
```

## Summary

Production Go concurrency requires:

1. **`errgroup.WithContext`** as the foundation - it handles context propagation, error collection, and goroutine grouping
2. **`g.SetLimit(n)`** (Go 1.21+) or `semaphore.NewWeighted(n)` for bounded parallelism
3. **Worker pools** with channel-based job distribution for long-running processing
4. **`singleflight`** to prevent cache stampedes and deduplicate expensive operations
5. **Sharded maps** instead of `sync.Map` for high-write concurrent access patterns
6. **`signal.NotifyContext`** for clean signal handling in `main()`
7. **Race detector** (`go test -race`) as a mandatory CI step

The single most impactful practice: always use `errgroup.WithContext` when spawning goroutines that should share a lifecycle. This alone eliminates the majority of goroutine leaks and missed error propagation bugs found in production Go services.
