---
title: "Go Structured Concurrency: Errgroup, Semaphores, and Worker Pool Patterns"
date: 2028-12-31T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Goroutines", "Worker Pools", "errgroup"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into structured concurrency patterns in Go using errgroup, semaphores, bounded worker pools, and pipeline architectures for enterprise production systems."
more_link: "yes"
url: "/go-structured-concurrency-errgroup-semaphore-worker-pool/"
---

Go's concurrency model is powerful but unforgiving. Goroutines that escape their intended scope, error propagation that gets dropped, and resource exhaustion from unbounded parallelism are among the most common categories of production incidents in Go services. Structured concurrency addresses these problems by making the lifetime and error semantics of concurrent operations explicit and composable.

This guide covers the foundational patterns used in production Go services: `errgroup` for concurrent error aggregation, semaphores for resource limiting, worker pools for bounded parallelism, and pipelines for stream processing with backpressure.

<!--more-->

## The Problem with Raw Goroutines

Spawning goroutines with `go func()` without a coordinating mechanism creates several hazards:

- **Goroutine leaks**: goroutines blocked on channels or I/O that never complete
- **Error loss**: errors returned from goroutines that no caller ever reads
- **Race conditions**: shared state accessed without synchronization
- **Resource exhaustion**: unbounded goroutine spawning under load

The following antipattern appears in many codebases and fails silently in production:

```go
// DO NOT USE: errors are dropped, goroutines may leak
func processItems(items []string) {
    for _, item := range items {
        go func(s string) {
            if err := process(s); err != nil {
                log.Printf("error: %v", err) // silently logged, not propagated
            }
        }(item)
    }
    // No way to wait for all goroutines to finish
    // No way to collect errors
}
```

## errgroup: Structured Concurrent Error Handling

The `golang.org/x/sync/errgroup` package provides a clean abstraction for running a group of goroutines where errors are propagated to the caller and all goroutines complete before returning.

### Basic errgroup Pattern

```go
package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/sync/errgroup"
)

// CheckEndpoints verifies that all provided URLs respond with HTTP 200.
// It returns the first error encountered, and cancels remaining checks.
func CheckEndpoints(ctx context.Context, urls []string) error {
	g, ctx := errgroup.WithContext(ctx)

	for _, url := range urls {
		url := url // capture loop variable (pre-Go 1.22)
		g.Go(func() error {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				return fmt.Errorf("building request for %s: %w", url, err)
			}
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				return fmt.Errorf("GET %s: %w", url, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("GET %s: unexpected status %d", url, resp.StatusCode)
			}
			return nil
		})
	}

	return g.Wait()
}
```

The context returned by `errgroup.WithContext` is cancelled when any goroutine returns a non-nil error. This causes in-flight goroutines that respect context cancellation to terminate early, preventing wasted work.

### Collecting All Errors

The standard `errgroup` returns only the first error. For use cases where all errors are needed (e.g., validation pipelines), collect them explicitly:

```go
package concurrent

import (
	"context"
	"errors"
	"sync"

	"golang.org/x/sync/errgroup"
)

// MultiError holds multiple errors from concurrent operations.
type MultiError struct {
	mu   sync.Mutex
	errs []error
}

func (m *MultiError) Add(err error) {
	if err == nil {
		return
	}
	m.mu.Lock()
	m.errs = append(m.errs, err)
	m.mu.Unlock()
}

func (m *MultiError) Err() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.errs) == 0 {
		return nil
	}
	return errors.Join(m.errs...)
}

// ValidateAll runs validator for each item and collects all validation errors.
func ValidateAll[T any](ctx context.Context, items []T, validator func(context.Context, T) error) error {
	var merr MultiError
	g, ctx := errgroup.WithContext(ctx)

	for _, item := range items {
		item := item
		g.Go(func() error {
			if err := validator(ctx, item); err != nil {
				merr.Add(err)
			}
			return nil // return nil so errgroup does not cancel
		})
	}

	_ = g.Wait() // always nil since we return nil from goroutines
	return merr.Err()
}
```

## Semaphores: Bounding Concurrency

A semaphore limits the number of goroutines that can execute a critical section simultaneously. The `golang.org/x/sync/semaphore` package provides a weighted semaphore backed by the Go runtime scheduler.

### Rate-Limited API Calls

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/semaphore"
)

const maxConcurrentAPICalls = 20

// FetchRecords fetches records from an external API with bounded concurrency.
func FetchRecords(ctx context.Context, ids []int64) ([]Record, error) {
	sem := semaphore.NewWeighted(maxConcurrentAPICalls)
	results := make([]Record, len(ids))
	g, ctx := errgroup.WithContext(ctx)

	for i, id := range ids {
		i, id := i, id
		g.Go(func() error {
			// Acquire semaphore slot
			if err := sem.Acquire(ctx, 1); err != nil {
				return fmt.Errorf("semaphore acquire for id %d: %w", id, err)
			}
			defer sem.Release(1)

			record, err := fetchFromAPI(ctx, id)
			if err != nil {
				return fmt.Errorf("fetch id %d: %w", id, err)
			}
			results[i] = record
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}

type Record struct {
	ID   int64
	Data string
}

func fetchFromAPI(ctx context.Context, id int64) (Record, error) {
	// Simulate API call
	select {
	case <-ctx.Done():
		return Record{}, ctx.Err()
	case <-time.After(50 * time.Millisecond):
		return Record{ID: id, Data: fmt.Sprintf("data-%d", id)}, nil
	}
}
```

### Weighted Semaphores for Resource-Aware Scheduling

The weighted semaphore allows different operations to acquire different amounts of the resource budget, enabling more granular control:

```go
package jobs

import (
	"context"
	"fmt"

	"golang.org/x/sync/semaphore"
)

// ResourceBudget models total memory units available for concurrent jobs.
const totalMemoryUnits = 100

type JobSize int64

const (
	SmallJob  JobSize = 5
	MediumJob JobSize = 20
	LargeJob  JobSize = 50
)

type Job struct {
	ID   string
	Size JobSize
	Fn   func(context.Context) error
}

// RunJobs executes jobs respecting their memory footprint.
func RunJobs(ctx context.Context, jobs []Job) error {
	sem := semaphore.NewWeighted(totalMemoryUnits)

	g, ctx := errgroup.WithContext(ctx)

	for _, job := range jobs {
		job := job
		g.Go(func() error {
			if err := sem.Acquire(ctx, int64(job.Size)); err != nil {
				return fmt.Errorf("acquire for job %s: %w", job.ID, err)
			}
			defer sem.Release(int64(job.Size))
			return job.Fn(ctx)
		})
	}

	return g.Wait()
}
```

## Worker Pool Pattern

A worker pool pre-creates a fixed number of goroutines that process work from a shared channel. This pattern is ideal for sustained workloads where the cost of goroutine creation adds up, or where downstream systems impose strict concurrency limits.

### Generic Worker Pool

```go
package workerpool

import (
	"context"
	"fmt"
	"runtime"
	"sync"
)

// Pool is a bounded pool of workers processing jobs of type T, producing results of type R.
type Pool[T, R any] struct {
	workers int
	jobCh   chan T
	resultCh chan Result[R]
	wg      sync.WaitGroup
	process func(context.Context, T) (R, error)
}

// Result wraps a worker output along with its error.
type Result[R any] struct {
	Value R
	Err   error
}

// NewPool creates a pool with the given number of workers.
// If workers <= 0, it defaults to runtime.NumCPU().
func NewPool[T, R any](workers int, process func(context.Context, T) (R, error)) *Pool[T, R] {
	if workers <= 0 {
		workers = runtime.NumCPU()
	}
	return &Pool[T, R]{
		workers:  workers,
		jobCh:    make(chan T, workers*2),
		resultCh: make(chan Result[R], workers*2),
		process:  process,
	}
}

// Start launches the worker goroutines.
func (p *Pool[T, R]) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for {
				select {
				case job, ok := <-p.jobCh:
					if !ok {
						return
					}
					value, err := p.process(ctx, job)
					select {
					case p.resultCh <- Result[R]{Value: value, Err: err}:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}
}

// Submit sends a job to the pool. Blocks if the job channel is full.
func (p *Pool[T, R]) Submit(ctx context.Context, job T) error {
	select {
	case p.jobCh <- job:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("submit: %w", ctx.Err())
	}
}

// Results returns the result channel for consumers to read from.
func (p *Pool[T, R]) Results() <-chan Result[R] {
	return p.resultCh
}

// Close signals workers to stop after draining the job channel and
// closes the result channel once all workers have exited.
func (p *Pool[T, R]) Close() {
	close(p.jobCh)
	go func() {
		p.wg.Wait()
		close(p.resultCh)
	}()
}
```

### Worker Pool Usage: Image Resizing

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/example/workerpool"
)

type ResizeJob struct {
	SourcePath string
	DestPath   string
	Width      int
	Height     int
}

type ResizeResult struct {
	SourcePath   string
	DestPath     string
	BytesWritten int64
	Duration     time.Duration
}

func resizeImage(ctx context.Context, job ResizeJob) (ResizeResult, error) {
	start := time.Now()
	// Actual image resizing logic would go here
	// Using imaging, vips, or similar library
	_ = ctx
	bytesWritten := int64(job.Width * job.Height * 3) // placeholder
	return ResizeResult{
		SourcePath:   job.SourcePath,
		DestPath:     job.DestPath,
		BytesWritten: bytesWritten,
		Duration:     time.Since(start),
	}, nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx := context.Background()

	pool := workerpool.NewPool[ResizeJob, ResizeResult](8, resizeImage)
	pool.Start(ctx)

	// Collect results concurrently
	var totalBytes int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		for result := range pool.Results() {
			if result.Err != nil {
				logger.Error("resize failed", "error", result.Err)
				continue
			}
			totalBytes += result.Value.BytesWritten
			logger.Info("resize complete",
				"source", result.Value.SourcePath,
				"duration_ms", result.Value.Duration.Milliseconds(),
			)
		}
	}()

	// Submit jobs
	images := []string{"img001.jpg", "img002.jpg", "img003.jpg", "img004.jpg"}
	for _, img := range images {
		job := ResizeJob{
			SourcePath: filepath.Join("/data/originals", img),
			DestPath:   filepath.Join("/data/thumbnails", img),
			Width:      256,
			Height:     256,
		}
		if err := pool.Submit(ctx, job); err != nil {
			logger.Error("submit failed", "image", img, "error", err)
		}
	}

	pool.Close()
	<-done

	fmt.Printf("processed %d images, total bytes: %d\n", len(images), totalBytes)
}
```

## Pipeline Pattern with Backpressure

Pipelines chain multiple processing stages, each reading from an input channel and writing to an output channel. Backpressure propagates naturally when downstream stages are slow: the upstream channel fills, causing producers to block rather than accumulate unbounded buffers in memory.

```go
package pipeline

import (
	"context"
	"fmt"
)

// Stage is a function that reads from an input channel and writes to an output channel.
type Stage[In, Out any] func(ctx context.Context, in <-chan In) <-chan Out

// Map applies a transformation to each element.
func Map[In, Out any](transform func(In) (Out, error)) Stage[In, Out] {
	return func(ctx context.Context, in <-chan In) <-chan Out {
		out := make(chan Out, cap(in))
		go func() {
			defer close(out)
			for {
				select {
				case v, ok := <-in:
					if !ok {
						return
					}
					result, err := transform(v)
					if err != nil {
						// In production, send to error channel or use errgroup
						continue
					}
					select {
					case out <- result:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}
}

// Filter passes only elements matching the predicate.
func Filter[T any](predicate func(T) bool) Stage[T, T] {
	return func(ctx context.Context, in <-chan T) <-chan T {
		out := make(chan T, cap(in))
		go func() {
			defer close(out)
			for {
				select {
				case v, ok := <-in:
					if !ok {
						return
					}
					if predicate(v) {
						select {
						case out <- v:
						case <-ctx.Done():
							return
						}
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}
}

// Batch groups items into slices of the given size.
func Batch[T any](size int) Stage[T, []T] {
	return func(ctx context.Context, in <-chan T) <-chan []T {
		out := make(chan []T, 1)
		go func() {
			defer close(out)
			batch := make([]T, 0, size)
			flush := func() {
				if len(batch) > 0 {
					cp := make([]T, len(batch))
					copy(cp, batch)
					select {
					case out <- cp:
					case <-ctx.Done():
					}
					batch = batch[:0]
				}
			}
			for {
				select {
				case v, ok := <-in:
					if !ok {
						flush()
						return
					}
					batch = append(batch, v)
					if len(batch) >= size {
						flush()
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}
}

// Generator creates a channel from a slice.
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

// Example: Parse → Validate → Transform → Batch → Insert pipeline
type RawEvent struct {
	ID   string
	Data string
}

type ParsedEvent struct {
	ID    string
	Value float64
}

type EnrichedEvent struct {
	ID     string
	Value  float64
	Region string
}

func RunEventPipeline(ctx context.Context, rawEvents []RawEvent) error {
	source := Generator(ctx, rawEvents)

	// Stage 1: parse raw events
	parsed := Map[RawEvent, ParsedEvent](func(e RawEvent) (ParsedEvent, error) {
		var val float64
		if _, err := fmt.Sscanf(e.Data, "%f", &val); err != nil {
			return ParsedEvent{}, fmt.Errorf("parse %s: %w", e.ID, err)
		}
		return ParsedEvent{ID: e.ID, Value: val}, nil
	})(ctx, source)

	// Stage 2: filter out zero values
	filtered := Filter[ParsedEvent](func(e ParsedEvent) bool {
		return e.Value > 0
	})(ctx, parsed)

	// Stage 3: enrich with region
	enriched := Map[ParsedEvent, EnrichedEvent](func(e ParsedEvent) (EnrichedEvent, error) {
		return EnrichedEvent{ID: e.ID, Value: e.Value, Region: "us-east-1"}, nil
	})(ctx, filtered)

	// Stage 4: batch for bulk insert
	batched := Batch[EnrichedEvent](100)(ctx, enriched)

	// Stage 5: consume batches
	for batch := range batched {
		if err := bulkInsert(ctx, batch); err != nil {
			return fmt.Errorf("bulk insert: %w", err)
		}
	}
	return ctx.Err()
}

func bulkInsert(ctx context.Context, events []EnrichedEvent) error {
	_ = ctx
	_ = events
	// Database insert logic here
	return nil
}
```

## Context Propagation and Cancellation

Every concurrent operation must accept and respect a `context.Context`. The context provides both cancellation signaling and deadline enforcement:

```go
package jobs

import (
	"context"
	"fmt"
	"time"
)

// ProcessWithTimeout wraps a long-running operation with a deadline.
func ProcessWithTimeout(parentCtx context.Context, id string, fn func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(parentCtx, 30*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- fn(ctx)
	}()

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return fmt.Errorf("job %s: %w", id, ctx.Err())
	}
}

// FanOut distributes work to N workers and collects all results.
func FanOut[T, R any](
	ctx context.Context,
	inputs []T,
	maxWorkers int,
	process func(context.Context, T) (R, error),
) ([]R, error) {
	type indexedResult struct {
		index int
		value R
		err   error
	}

	resultCh := make(chan indexedResult, len(inputs))
	sem := make(chan struct{}, maxWorkers)

	var wg sync.WaitGroup
	for i, input := range inputs {
		i, input := i, input
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Acquire worker slot
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				resultCh <- indexedResult{index: i, err: ctx.Err()}
				return
			}

			value, err := process(ctx, input)
			resultCh <- indexedResult{index: i, value: value, err: err}
		}()
	}

	// Close result channel after all goroutines complete
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	results := make([]R, len(inputs))
	for r := range resultCh {
		if r.err != nil {
			// Drain remaining results
			for range resultCh {
			}
			return nil, fmt.Errorf("item %d: %w", r.index, r.err)
		}
		results[r.index] = r.value
	}
	return results, nil
}
```

## Goroutine Leak Detection

In testing environments, use `goleak` to detect goroutine leaks:

```go
package main_test

import (
	"testing"

	"go.uber.org/goleak"
)

func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m,
		// Ignore goroutines from known external libraries
		goleak.IgnoreTopFunction("net/http.(*persistConn).writeLoop"),
		goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"),
	)
}

func TestConcurrentProcessor(t *testing.T) {
	defer goleak.VerifyNone(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool := workerpool.NewPool[string, int](4, func(ctx context.Context, s string) (int, error) {
		return len(s), nil
	})
	pool.Start(ctx)

	for _, item := range []string{"alpha", "beta", "gamma"} {
		_ = pool.Submit(ctx, item)
	}
	pool.Close()

	for range pool.Results() {
	}
}
```

## sync.Map for Concurrent Read-Heavy Workloads

For maps that are written once and read many times (e.g., configuration caches), `sync.Map` provides better performance than a `sync.RWMutex`-protected regular map:

```go
package cache

import (
	"fmt"
	"sync"
)

// RouteCache stores precomputed routes with concurrent read access.
type RouteCache struct {
	m sync.Map
}

func (c *RouteCache) Store(key, route string) {
	c.m.Store(key, route)
}

func (c *RouteCache) Load(key string) (string, bool) {
	v, ok := c.m.Load(key)
	if !ok {
		return "", false
	}
	return v.(string), true
}

// LoadOrCompute returns an existing value or computes and stores a new one.
// Uses sync.Map.LoadOrStore to avoid duplicate computation under concurrent load.
func (c *RouteCache) LoadOrCompute(key string, compute func(string) (string, error)) (string, error) {
	if v, ok := c.m.Load(key); ok {
		return v.(string), nil
	}

	result, err := compute(key)
	if err != nil {
		return "", fmt.Errorf("compute for key %s: %w", key, err)
	}

	actual, _ := c.m.LoadOrStore(key, result)
	return actual.(string), nil
}
```

## Benchmarking Concurrency Patterns

```go
package concurrency_test

import (
	"context"
	"testing"
)

func BenchmarkWorkerPool(b *testing.B) {
	ctx := context.Background()

	pool := workerpool.NewPool[int, int](8, func(ctx context.Context, n int) (int, error) {
		return n * n, nil
	})
	pool.Start(ctx)
	defer pool.Close()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			_ = pool.Submit(ctx, i)
			i++
		}
	})
	// Drain results
	for range pool.Results() {
		b.N--
		if b.N <= 0 {
			break
		}
	}
}

func BenchmarkSemaphore(b *testing.B) {
	ctx := context.Background()
	sem := semaphore.NewWeighted(16)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_ = sem.Acquire(ctx, 1)
			sem.Release(1)
		}
	})
}
```

## Production Checklist

When deploying concurrent Go services to production:

- **Always pass context**: Every blocking operation should accept and check `context.Context`
- **Use errgroup for concurrent operations**: Never spawn goroutines without tracking their completion and errors
- **Bound concurrency**: Use semaphores or worker pools; never spawn goroutines proportional to input size without a limit
- **Test for leaks**: Add `goleak` to CI with `TestMain` to catch goroutine leaks before production
- **Profile under load**: Use `pprof` goroutine profiles to confirm goroutine counts are stable under sustained traffic
- **Set channel buffer sizes thoughtfully**: Unbuffered channels provide synchronization guarantees; buffered channels decouple producers from consumers but can hide backpressure signals
- **Handle context cancellation in select statements**: Include `case <-ctx.Done()` in all select statements that might block indefinitely

## Summary

Structured concurrency in Go is achievable through a combination of `errgroup`, semaphores, worker pools, and pipeline patterns. These primitives compose cleanly and provide the foundation for building high-throughput services that handle failures gracefully, respect resource constraints, and remain understandable to engineers maintaining the code under pressure.

The key insight is that every goroutine should have a clear owner, a defined lifetime tied to a context, and a mechanism for propagating errors back to that owner. When these three properties hold, concurrent code becomes as predictable and debuggable as sequential code.
