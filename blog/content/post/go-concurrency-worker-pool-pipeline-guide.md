---
title: "Go Concurrency Patterns: Worker Pools, Fan-Out/Fan-In, Pipeline Patterns, and Backpressure"
date: 2028-07-21T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Goroutines", "Channels", "Worker Pool", "Patterns"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Go concurrency covering worker pools with context cancellation, fan-out/fan-in patterns, pipeline composition, backpressure with bounded channels, semaphores, errgroups, and singleflight for production services."
more_link: "yes"
url: "/go-concurrency-worker-pool-pipeline-guide/"
---

Go's concurrency model — goroutines and channels — is elegant in small examples and notoriously difficult to get right at scale. The patterns in this guide emerge from production systems processing millions of events per second, where subtle goroutine leaks and missing backpressure mechanisms cause outages. Each pattern is paired with its failure mode and the fix that makes it production-safe.

<!--more-->

# Go Concurrency Patterns: Worker Pools, Fan-Out/Fan-In, Pipeline Patterns, and Backpressure

## Section 1: Goroutine Lifecycle Fundamentals

### The Goroutine Leak Problem

Before patterns: the most common production concurrency bug is goroutine leaks — goroutines that block forever on channels or never receive their context cancellation.

```go
package main

import (
	"context"
	"fmt"
	"runtime"
	"time"
)

// BAD: goroutine leak — blocks forever if nobody reads from ch
func leaky(done <-chan struct{}) {
	ch := make(chan int)
	go func() {
		select {
		case ch <- compute(): // Blocks if caller never reads
		// No done/ctx case — goroutine stuck forever
		}
	}()
	// Caller returns without reading ch
}

// GOOD: always provide a cancellation path
func nonLeaky(ctx context.Context) <-chan int {
	ch := make(chan int, 1) // Buffered — sender can always proceed
	go func() {
		result := compute()
		select {
		case ch <- result:
		case <-ctx.Done(): // Context cancelled — exit cleanly
		}
	}()
	return ch
}

// Monitor goroutine count in production
func monitorGoroutines() {
	ticker := time.NewTicker(30 * time.Second)
	for range ticker.C {
		n := runtime.NumGoroutine()
		fmt.Printf("goroutines: %d\n", n)
		// Alert if growing unboundedly
	}
}
```

### Context Propagation Rules

```go
// Rules for context in goroutines:
// 1. Always accept context as first argument to functions that may block
// 2. Always select on ctx.Done() in goroutines that block
// 3. Never store context in a struct (it's a function argument, not a field)
// 4. Derive child contexts for sub-operations; cancel them when done

func processItem(ctx context.Context, item Item) error {
	// Propagate context to all blocking operations
	if err := fetchData(ctx, item.ID); err != nil {
		return fmt.Errorf("fetchData: %w", err)
	}

	// For sub-operations with their own timeout
	dbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel() // Always cancel derived contexts

	if err := saveResult(dbCtx, item); err != nil {
		return fmt.Errorf("saveResult: %w", err)
	}

	return nil
}
```

---

## Section 2: Worker Pool Pattern

### Production Worker Pool

```go
// workerpool/pool.go
package workerpool

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
)

type Job[T any] struct {
	ID      string
	Payload T
}

type Result[T, R any] struct {
	Job    Job[T]
	Output R
	Err    error
}

type Pool[T, R any] struct {
	workers    int
	process    func(ctx context.Context, job Job[T]) (R, error)
	jobCh      chan Job[T]
	resultCh   chan Result[T, R]
	wg         sync.WaitGroup
	log        *slog.Logger

	// Metrics
	processed  atomic.Int64
	failed     atomic.Int64
}

func New[T, R any](
	workers int,
	bufferSize int,
	processor func(ctx context.Context, job Job[T]) (R, error),
	logger *slog.Logger,
) *Pool[T, R] {
	return &Pool[T, R]{
		workers:  workers,
		process:  processor,
		jobCh:    make(chan Job[T], bufferSize),
		resultCh: make(chan Result[T, R], bufferSize),
		log:      logger,
	}
}

// Start launches workers and returns when the pool is ready
func (p *Pool[T, R]) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go p.worker(ctx, i)
	}
}

func (p *Pool[T, R]) worker(ctx context.Context, id int) {
	defer p.wg.Done()
	p.log.Debug("Worker started", "id", id)

	for {
		select {
		case <-ctx.Done():
			p.log.Debug("Worker stopped: context cancelled", "id", id)
			return
		case job, ok := <-p.jobCh:
			if !ok {
				p.log.Debug("Worker stopped: job channel closed", "id", id)
				return
			}

			result, err := p.process(ctx, job)
			if err != nil {
				p.failed.Add(1)
				p.log.Error("Job failed",
					"worker", id,
					"job_id", job.ID,
					"error", err,
				)
			} else {
				p.processed.Add(1)
			}

			select {
			case p.resultCh <- Result[T, R]{Job: job, Output: result, Err: err}:
			case <-ctx.Done():
				return
			}
		}
	}
}

// Submit sends a job to the pool; blocks if the buffer is full (backpressure)
func (p *Pool[T, R]) Submit(ctx context.Context, job Job[T]) error {
	select {
	case p.jobCh <- job:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("submit cancelled: %w", ctx.Err())
	}
}

// Results returns the channel for consuming results
func (p *Pool[T, R]) Results() <-chan Result[T, R] {
	return p.resultCh
}

// Close signals workers to stop after draining the job channel
func (p *Pool[T, R]) Close() {
	close(p.jobCh)
	p.wg.Wait()
	close(p.resultCh)
}

// Stats returns current processing statistics
func (p *Pool[T, R]) Stats() (processed, failed int64) {
	return p.processed.Load(), p.failed.Load()
}
```

### Worker Pool Usage

```go
// main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"your-org/your-app/workerpool"
)

type ImageJob struct {
	URL      string
	TargetW  int
	TargetH  int
}

type ImageResult struct {
	URL  string
	Size int
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Create pool: 10 workers, buffer 100 jobs
	pool := workerpool.New[ImageJob, ImageResult](
		10, 100,
		func(ctx context.Context, job workerpool.Job[ImageJob]) (ImageResult, error) {
			// Simulate image processing
			time.Sleep(100 * time.Millisecond)
			return ImageResult{URL: job.Payload.URL, Size: 1024}, nil
		},
		logger,
	)

	pool.Start(ctx)

	// Collect results in a separate goroutine
	var results []workerpool.Result[ImageJob, ImageResult]
	done := make(chan struct{})
	go func() {
		defer close(done)
		for result := range pool.Results() {
			if result.Err != nil {
				logger.Error("Processing failed", "url", result.Job.Payload.URL, "error", result.Err)
				continue
			}
			results = append(results, result)
		}
	}()

	// Submit jobs
	urls := []string{"https://example.com/1.jpg", "https://example.com/2.jpg"}
	for i, url := range urls {
		if err := pool.Submit(ctx, workerpool.Job[ImageJob]{
			ID:      fmt.Sprintf("job-%d", i),
			Payload: ImageJob{URL: url, TargetW: 800, TargetH: 600},
		}); err != nil {
			logger.Error("Submit failed", "error", err)
			break
		}
	}

	// Close the pool and wait for all results
	pool.Close()
	<-done

	processed, failed := pool.Stats()
	fmt.Printf("Processed: %d, Failed: %d\n", processed, failed)
}
```

---

## Section 3: Fan-Out / Fan-In

### Fan-Out: Distribute to Multiple Workers

```go
// fanout.go
package patterns

import (
	"context"
	"sync"
)

// FanOut distributes input to n parallel processors
// Returns a slice of output channels, one per processor
func FanOut[T, R any](
	ctx context.Context,
	input <-chan T,
	n int,
	process func(ctx context.Context, t T) (R, error),
) []<-chan Result[R] {
	outputs := make([]<-chan Result[R], n)
	for i := 0; i < n; i++ {
		out := make(chan Result[R], 1)
		outputs[i] = out
		go func(ch chan<- Result[R]) {
			defer close(ch)
			for {
				select {
				case <-ctx.Done():
					return
				case item, ok := <-input:
					if !ok {
						return
					}
					r, err := process(ctx, item)
					select {
					case ch <- Result[R]{Value: r, Err: err}:
					case <-ctx.Done():
						return
					}
				}
			}
		}(out)
	}
	return outputs
}

// FanIn merges multiple input channels into a single output channel
func FanIn[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
	output := make(chan T, len(inputs))
	var wg sync.WaitGroup

	multiplex := func(ch <-chan T) {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-ch:
				if !ok {
					return
				}
				select {
				case output <- v:
				case <-ctx.Done():
					return
				}
			}
		}
	}

	wg.Add(len(inputs))
	for _, input := range inputs {
		go multiplex(input)
	}

	// Close output when all inputs are drained
	go func() {
		wg.Wait()
		close(output)
	}()

	return output
}

type Result[T any] struct {
	Value T
	Err   error
}

// Usage: fan out HTTP requests, fan in results
func fetchAll(ctx context.Context, urls []string) []Result[[]byte] {
	urlCh := make(chan string, len(urls))
	for _, u := range urls {
		urlCh <- u
	}
	close(urlCh)

	// Fan out to 5 concurrent fetchers
	outputs := FanOut(ctx, urlCh, 5, func(ctx context.Context, url string) ([]byte, error) {
		return fetch(ctx, url) // Your HTTP fetch function
	})

	// Fan in all results
	merged := FanIn(ctx, outputs...)

	var results []Result[[]byte]
	for r := range merged {
		results = append(results, r)
	}
	return results
}
```

---

## Section 4: Pipeline Pattern

### Composable Pipeline Stages

```go
// pipeline.go
package pipeline

import (
	"context"
	"fmt"
)

// Stage is a pipeline processing stage
type Stage[In, Out any] func(ctx context.Context, in <-chan In) <-chan Out

// StageErr is a pipeline stage that can produce errors
type StageWithErr[In, Out any] func(ctx context.Context, in <-chan In) (<-chan Out, <-chan error)

// Map applies a transformation to each element in the input channel
func Map[In, Out any](fn func(In) (Out, error)) Stage[In, Out] {
	return func(ctx context.Context, in <-chan In) <-chan Out {
		out := make(chan Out)
		go func() {
			defer close(out)
			for {
				select {
				case <-ctx.Done():
					return
				case item, ok := <-in:
					if !ok {
						return
					}
					result, err := fn(item)
					if err != nil {
						// Log or send to error channel — here we skip
						continue
					}
					select {
					case out <- result:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
		return out
	}
}

// Filter keeps only elements that match the predicate
func Filter[T any](pred func(T) bool) Stage[T, T] {
	return func(ctx context.Context, in <-chan T) <-chan T {
		out := make(chan T)
		go func() {
			defer close(out)
			for {
				select {
				case <-ctx.Done():
					return
				case item, ok := <-in:
					if !ok {
						return
					}
					if pred(item) {
						select {
						case out <- item:
						case <-ctx.Done():
							return
						}
					}
				}
			}
		}()
		return out
	}
}

// Batch collects items into fixed-size batches
func Batch[T any](size int) Stage[T, []T] {
	return func(ctx context.Context, in <-chan T) <-chan []T {
		out := make(chan []T)
		go func() {
			defer close(out)
			batch := make([]T, 0, size)
			for {
				select {
				case <-ctx.Done():
					if len(batch) > 0 {
						out <- batch
					}
					return
				case item, ok := <-in:
					if !ok {
						if len(batch) > 0 {
							select {
							case out <- batch:
							case <-ctx.Done():
							}
						}
						return
					}
					batch = append(batch, item)
					if len(batch) >= size {
						select {
						case out <- batch:
						case <-ctx.Done():
							return
						}
						batch = make([]T, 0, size)
					}
				}
			}
		}()
		return out
	}
}

// Pipe chains multiple stages together
func Pipe[A, B, C any](
	ctx context.Context,
	source <-chan A,
	stage1 Stage[A, B],
	stage2 Stage[B, C],
) <-chan C {
	return stage2(ctx, stage1(ctx, source))
}

// Generator creates a source channel from a slice
func Generator[T any](ctx context.Context, items []T) <-chan T {
	ch := make(chan T, len(items))
	go func() {
		defer close(ch)
		for _, item := range items {
			select {
			case ch <- item:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch
}

// Example: ETL pipeline
type Record struct {
	ID    string
	Data  string
	Score float64
}

func runETLPipeline(ctx context.Context, records []Record) {
	source := Generator(ctx, records)

	// Stage 1: Filter valid records
	filtered := Filter[Record](func(r Record) bool {
		return r.Score > 0.5
	})(ctx, source)

	// Stage 2: Transform data
	transformed := Map[Record, Record](func(r Record) (Record, error) {
		r.Data = fmt.Sprintf("processed:%s", r.Data)
		return r, nil
	})(ctx, filtered)

	// Stage 3: Batch for bulk insert
	batched := Batch[Record](100)(ctx, transformed)

	// Consume batches
	for batch := range batched {
		if err := bulkInsert(ctx, batch); err != nil {
			fmt.Printf("batch insert failed: %v\n", err)
		}
	}
}

func bulkInsert(ctx context.Context, records []Record) error { return nil }
func fetch(ctx context.Context, url string) ([]byte, error)  { return nil, nil }
```

---

## Section 5: Backpressure Mechanisms

### Bounded Channel Backpressure

```go
// backpressure.go
package backpressure

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var ErrBufferFull = errors.New("buffer full: applying backpressure")

// BoundedQueue provides a channel with configurable backpressure behavior
type BoundedQueue[T any] struct {
	ch      chan T
	maxSize int
}

func NewBoundedQueue[T any](size int) *BoundedQueue[T] {
	return &BoundedQueue[T]{
		ch:      make(chan T, size),
		maxSize: size,
	}
}

// TrySend attempts to send without blocking; returns ErrBufferFull if full
func (q *BoundedQueue[T]) TrySend(item T) error {
	select {
	case q.ch <- item:
		return nil
	default:
		return ErrBufferFull
	}
}

// SendWithTimeout sends within a deadline; caller decides what to do on timeout
func (q *BoundedQueue[T]) SendWithTimeout(ctx context.Context, item T, timeout time.Duration) error {
	timeoutCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	select {
	case q.ch <- item:
		return nil
	case <-timeoutCtx.Done():
		if errors.Is(timeoutCtx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("send timeout after %v: %w", timeout, ErrBufferFull)
		}
		return fmt.Errorf("send cancelled: %w", ctx.Err())
	}
}

// Receive returns the channel for consumers
func (q *BoundedQueue[T]) Receive() <-chan T {
	return q.ch
}

// Len returns current queue depth
func (q *BoundedQueue[T]) Len() int {
	return len(q.ch)
}

// Usage in a producer
type Event struct {
	ID   string
	Data []byte
}

type BackpressureProducer struct {
	queue   *BoundedQueue[Event]
	dropped int64
}

func (p *BackpressureProducer) Produce(ctx context.Context, event Event) {
	switch err := p.queue.TrySend(event); {
	case err == nil:
		// Sent successfully
	case errors.Is(err, ErrBufferFull):
		// Drop and count
		p.dropped++
		// In production: increment a Prometheus counter
		// When dropped exceeds threshold: shed load upstream (reject HTTP requests, pause Kafka consumer)
	}
}
```

### Token Bucket Rate Limiter

```go
// ratelimit.go
package ratelimit

import (
	"context"
	"sync"
	"time"
)

// TokenBucket implements a thread-safe token bucket rate limiter
type TokenBucket struct {
	mu         sync.Mutex
	tokens     float64
	maxTokens  float64
	refillRate float64  // tokens per second
	lastRefill time.Time
}

func NewTokenBucket(maxTokens, tokensPerSecond float64) *TokenBucket {
	return &TokenBucket{
		tokens:     maxTokens,
		maxTokens:  maxTokens,
		refillRate: tokensPerSecond,
		lastRefill: time.Now(),
	}
}

// Allow returns true if the request can proceed, false if rate limited
func (tb *TokenBucket) Allow() bool {
	return tb.AllowN(1)
}

func (tb *TokenBucket) AllowN(n float64) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	// Refill tokens based on elapsed time
	now := time.Now()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	tb.tokens = min(tb.maxTokens, tb.tokens+elapsed*tb.refillRate)
	tb.lastRefill = now

	if tb.tokens >= n {
		tb.tokens -= n
		return true
	}
	return false
}

// Wait blocks until a token is available or context is cancelled
func (tb *TokenBucket) Wait(ctx context.Context) error {
	for {
		if tb.Allow() {
			return nil
		}

		// Calculate wait time for next token
		tb.mu.Lock()
		waitTime := time.Duration((1 - tb.tokens) / tb.refillRate * float64(time.Second))
		tb.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(waitTime):
		}
	}
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
```

---

## Section 6: errgroup — Structured Goroutine Management

```go
// errgroup_patterns.go
package patterns

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/sync/errgroup"
)

// ParallelFetch fetches multiple URLs concurrently with a concurrency limit
func ParallelFetch(ctx context.Context, urls []string, concurrency int) ([][]byte, error) {
	// errgroup with context cancellation on first error
	g, ctx := errgroup.WithContext(ctx)

	// Semaphore to limit concurrency
	sem := make(chan struct{}, concurrency)

	results := make([][]byte, len(urls))

	for i, url := range urls {
		i, url := i, url // Capture loop variables

		g.Go(func() error {
			// Acquire semaphore slot
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return ctx.Err()
			}

			data, err := fetchURL(ctx, url)
			if err != nil {
				return fmt.Errorf("fetching %s: %w", url, err)
			}

			results[i] = data
			return nil
		})
	}

	// Wait for all goroutines; first error cancels ctx (cancels remaining fetches)
	if err := g.Wait(); err != nil {
		return nil, err
	}

	return results, nil
}

func fetchURL(ctx context.Context, url string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// Read body...
	return nil, nil
}

// ServiceStartup starts multiple services concurrently and waits for all
func ServiceStartup(ctx context.Context) error {
	g, ctx := errgroup.WithContext(ctx)

	// HTTP server
	g.Go(func() error {
		return startHTTPServer(ctx)
	})

	// Metrics server
	g.Go(func() error {
		return startMetricsServer(ctx)
	})

	// Background workers
	g.Go(func() error {
		return startWorkers(ctx)
	})

	// Health check server
	g.Go(func() error {
		return startHealthServer(ctx)
	})

	return g.Wait() // Returns first non-nil error
}

func startHTTPServer(ctx context.Context) error    { return nil }
func startMetricsServer(ctx context.Context) error { return nil }
func startWorkers(ctx context.Context) error       { return nil }
func startHealthServer(ctx context.Context) error  { return nil }
```

---

## Section 7: Semaphore Pattern

```go
// semaphore.go
package semaphore

import (
	"context"
	"fmt"
)

// Semaphore limits the number of concurrent operations
type Semaphore struct {
	ch chan struct{}
}

func New(n int) *Semaphore {
	return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire acquires a slot; blocks if all slots are taken
func (s *Semaphore) Acquire(ctx context.Context) error {
	select {
	case s.ch <- struct{}{}:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("semaphore acquire cancelled: %w", ctx.Err())
	}
}

// Release releases a slot
func (s *Semaphore) Release() {
	<-s.ch
}

// TryAcquire attempts to acquire without blocking
func (s *Semaphore) TryAcquire() bool {
	select {
	case s.ch <- struct{}{}:
		return true
	default:
		return false
	}
}

// Available returns the number of available slots
func (s *Semaphore) Available() int {
	return cap(s.ch) - len(s.ch)
}

// WithSemaphore executes fn with a semaphore slot held
func (s *Semaphore) WithSemaphore(ctx context.Context, fn func(ctx context.Context) error) error {
	if err := s.Acquire(ctx); err != nil {
		return err
	}
	defer s.Release()
	return fn(ctx)
}

// Usage: limit database connections
type DBPool struct {
	sem *Semaphore
	// db connection pool...
}

func NewDBPool(maxConcurrent int) *DBPool {
	return &DBPool{sem: New(maxConcurrent)}
}

func (p *DBPool) Query(ctx context.Context, query string) (interface{}, error) {
	return nil, p.sem.WithSemaphore(ctx, func(ctx context.Context) error {
		// Execute query — at most maxConcurrent queries run simultaneously
		return nil
	})
}
```

---

## Section 8: Singleflight — Deduplicating Concurrent Requests

```go
// singleflight_patterns.go
package patterns

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"golang.org/x/sync/singleflight"
)

// UserCache prevents stampede on cache miss
type UserCache struct {
	group  singleflight.Group
	cache  Cache // Any cache implementation
	source UserSource
}

type User struct {
	ID   string
	Name string
}

type Cache interface {
	Get(key string) (User, bool)
	Set(key string, value User, ttl time.Duration)
}

type UserSource interface {
	FetchUser(ctx context.Context, id string) (User, error)
}

// GetUser returns a user, deduplicating concurrent requests for the same ID
func (c *UserCache) GetUser(ctx context.Context, id string) (User, error) {
	// Fast path: check cache first (no locking needed for read)
	if user, ok := c.cache.Get(id); ok {
		return user, nil
	}

	// Slow path: deduplicate concurrent fetches for the same ID
	// If 100 goroutines request user "abc" simultaneously during a cache miss,
	// only ONE call to FetchUser will be made; all others wait for its result.
	v, err, shared := c.group.Do(id, func() (interface{}, error) {
		user, err := c.source.FetchUser(ctx, id)
		if err != nil {
			return nil, err
		}
		c.cache.Set(id, user, 5*time.Minute)
		return user, nil
	})

	if err != nil {
		return User{}, fmt.Errorf("fetching user %s: %w", id, err)
	}

	_ = shared // true if this call shared result with concurrent callers

	return v.(User), nil
}

// ConfigLoader uses singleflight for distributed config reloads
type ConfigLoader struct {
	group  singleflight.Group
	source ConfigSource
	cache  map[string]json.RawMessage
}

type ConfigSource interface {
	Load(ctx context.Context, key string) (json.RawMessage, error)
}

func (c *ConfigLoader) Load(ctx context.Context, key string) (json.RawMessage, error) {
	val, err, _ := c.group.Do(key, func() (interface{}, error) {
		return c.source.Load(ctx, key)
	})
	if err != nil {
		return nil, err
	}
	return val.(json.RawMessage), nil
}
```

---

## Section 9: Once and Lazy Initialization

```go
// lazy.go
package lazy

import (
	"context"
	"fmt"
	"sync"
)

// Once provides a generic lazy initialization pattern
type Once[T any] struct {
	once  sync.Once
	value T
	err   error
}

// Do runs the initialization function exactly once
func (o *Once[T]) Do(fn func() (T, error)) (T, error) {
	o.once.Do(func() {
		o.value, o.err = fn()
	})
	return o.value, o.err
}

// Value returns the lazily-initialized value (panics if not initialized)
func (o *Once[T]) Value() T {
	return o.value
}

// ContextOnce initializes once but respects context cancellation
// Unlike sync.Once, this can fail and retry if initialization fails
type ContextOnce[T any] struct {
	mu    sync.RWMutex
	done  bool
	value T
	err   error
}

func (o *ContextOnce[T]) Do(ctx context.Context, fn func(ctx context.Context) (T, error)) (T, error) {
	// Fast path: already initialized
	o.mu.RLock()
	if o.done {
		v, e := o.value, o.err
		o.mu.RUnlock()
		return v, e
	}
	o.mu.RUnlock()

	// Slow path: initialize
	o.mu.Lock()
	defer o.mu.Unlock()

	// Double-check after acquiring write lock
	if o.done {
		return o.value, o.err
	}

	o.value, o.err = fn(ctx)
	if o.err == nil {
		o.done = true // Only mark done on success — allows retry on failure
	}

	return o.value, o.err
}

// LazyDB lazily initializes a database connection
type LazyDB struct {
	once ContextOnce[*Database]
	dsn  string
}

func (l *LazyDB) DB(ctx context.Context) (*Database, error) {
	return l.once.Do(ctx, func(ctx context.Context) (*Database, error) {
		return connectDB(ctx, l.dsn)
	})
}

type Database struct{}

func connectDB(ctx context.Context, dsn string) (*Database, error) {
	return &Database{}, fmt.Errorf("not implemented")
}
```

---

## Section 10: Pub/Sub with Channels

```go
// pubsub.go
package pubsub

import (
	"context"
	"sync"
)

// Bus provides in-process pub/sub using channels
type Bus[T any] struct {
	mu          sync.RWMutex
	subscribers map[string][]chan T
}

func NewBus[T any]() *Bus[T] {
	return &Bus[T]{
		subscribers: make(map[string][]chan T),
	}
}

// Subscribe returns a channel that receives messages on topic
func (b *Bus[T]) Subscribe(ctx context.Context, topic string, bufferSize int) <-chan T {
	ch := make(chan T, bufferSize)

	b.mu.Lock()
	b.subscribers[topic] = append(b.subscribers[topic], ch)
	b.mu.Unlock()

	// Auto-unsubscribe when context is cancelled
	go func() {
		<-ctx.Done()
		b.unsubscribe(topic, ch)
	}()

	return ch
}

func (b *Bus[T]) unsubscribe(topic string, ch chan T) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subs := b.subscribers[topic]
	for i, sub := range subs {
		if sub == ch {
			b.subscribers[topic] = append(subs[:i], subs[i+1:]...)
			close(ch)
			return
		}
	}
}

// Publish sends a message to all subscribers of topic
func (b *Bus[T]) Publish(topic string, msg T) {
	b.mu.RLock()
	subs := make([]chan T, len(b.subscribers[topic]))
	copy(subs, b.subscribers[topic])
	b.mu.RUnlock()

	for _, ch := range subs {
		select {
		case ch <- msg:
		default:
			// Subscriber's buffer is full — drop message
			// In production: increment a dropped_messages counter
		}
	}
}

// PublishAsync sends concurrently to all subscribers
func (b *Bus[T]) PublishAsync(ctx context.Context, topic string, msg T) {
	b.mu.RLock()
	subs := make([]chan T, len(b.subscribers[topic]))
	copy(subs, b.subscribers[topic])
	b.mu.RUnlock()

	for _, ch := range subs {
		ch := ch
		go func() {
			select {
			case ch <- msg:
			case <-ctx.Done():
			}
		}()
	}
}
```

---

## Section 11: Testing Concurrent Code

```go
// workerpool/pool_test.go
package workerpool_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestPool_ProcessesAllJobs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var processed atomic.Int32

	pool := New[int, int](
		5, 100,
		func(ctx context.Context, job Job[int]) (int, error) {
			processed.Add(1)
			return job.Payload * 2, nil
		},
		slog.Default(),
	)

	pool.Start(ctx)

	// Collect results
	done := make(chan struct{})
	var results []Result[int, int]
	go func() {
		defer close(done)
		for r := range pool.Results() {
			results = append(results, r)
		}
	}()

	// Submit 50 jobs
	for i := 0; i < 50; i++ {
		if err := pool.Submit(ctx, Job[int]{ID: fmt.Sprintf("%d", i), Payload: i}); err != nil {
			t.Fatalf("submit failed: %v", err)
		}
	}

	pool.Close()
	<-done

	if int(processed.Load()) != 50 {
		t.Errorf("expected 50 processed, got %d", processed.Load())
	}
}

func TestPool_HandlesErrors(t *testing.T) {
	ctx := context.Background()
	testErr := errors.New("test error")

	pool := New[int, int](
		2, 10,
		func(ctx context.Context, job Job[int]) (int, error) {
			if job.Payload%2 == 0 {
				return 0, testErr
			}
			return job.Payload, nil
		},
		slog.Default(),
	)

	pool.Start(ctx)

	done := make(chan struct{})
	var failCount int
	go func() {
		defer close(done)
		for r := range pool.Results() {
			if r.Err != nil {
				failCount++
			}
		}
	}()

	for i := 0; i < 10; i++ {
		pool.Submit(ctx, Job[int]{ID: fmt.Sprintf("%d", i), Payload: i})
	}

	pool.Close()
	<-done

	if failCount != 5 {
		t.Errorf("expected 5 failures, got %d", failCount)
	}
}

// Test that no goroutines leak after pool closure
func TestPool_NoGoroutineLeak(t *testing.T) {
	before := runtime.NumGoroutine()

	ctx := context.Background()
	pool := New[int, int](5, 10,
		func(ctx context.Context, job Job[int]) (int, error) {
			return job.Payload, nil
		},
		slog.Default(),
	)
	pool.Start(ctx)

	for i := 0; i < 20; i++ {
		pool.Submit(ctx, Job[int]{ID: fmt.Sprintf("%d", i), Payload: i})
	}

	pool.Close()
	// Consume remaining results
	for range pool.Results() {}

	// Give goroutines time to finish
	time.Sleep(100 * time.Millisecond)

	after := runtime.NumGoroutine()
	if after > before+2 { // Allow a small delta
		t.Errorf("goroutine leak: before=%d after=%d", before, after)
	}
}
```

The most important production lesson in Go concurrency: never start a goroutine without knowing how it terminates. Every goroutine needs an exit condition — either a channel close, a context cancellation, or a sentinel value. The patterns in this guide are all designed with explicit termination: worker pools shut down by closing the job channel, pipelines terminate when their source closes, and all blocking operations select on `ctx.Done()`. That discipline is what separates production-ready concurrent code from code that leaks goroutines under load.
