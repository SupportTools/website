---
title: "Go Structured Concurrency: errgroup, Worker Pools, Fan-Out/Fan-In, and Pipeline Patterns"
date: 2028-06-02T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "errgroup", "Worker Pool", "Pipeline", "Context", "Goroutines"]
categories: ["Go", "Backend Engineering", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go structured concurrency patterns covering errgroup, semaphore-based bounded parallelism, worker pools, fan-out/fan-in, pipeline composition, and context cancellation propagation in production systems."
more_link: "yes"
url: "/go-structured-concurrency-patterns-guide/"
---

Go's goroutines make concurrency syntactically cheap, but concurrent programs that handle cancellation, error propagation, and bounded parallelism correctly require disciplined patterns. Unbounded goroutine spawning causes memory exhaustion; incomplete cancellation propagation causes goroutine leaks; missing error collection causes silent failures. This guide covers the production-ready patterns that eliminate these failure modes.

<!--more-->

## The Core Problem: Goroutine Lifecycle Management

Every goroutine must have a clear owner responsible for:
1. Starting it at the right time
2. Providing it with a cancellation signal
3. Waiting for it to complete
4. Collecting any errors it produces

Failing to address all four causes goroutine leaks, incomplete cleanup, and lost errors. The patterns in this guide provide structured solutions.

## errgroup: The Foundation

`golang.org/x/sync/errgroup` is the standard library for structured concurrent operations. It combines goroutine management, error collection, and context cancellation.

```bash
go get golang.org/x/sync@latest
```

### Basic errgroup Usage

```go
package main

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/sync/errgroup"
)

func fetchUserData(ctx context.Context, userID string) (*UserData, error) {
    g, ctx := errgroup.WithContext(ctx)

    var profile *Profile
    var orders []*Order
    var preferences *Preferences

    // Launch concurrent fetches
    g.Go(func() error {
        var err error
        profile, err = fetchProfile(ctx, userID)
        return err
    })

    g.Go(func() error {
        var err error
        orders, err = fetchOrders(ctx, userID)
        return err
    })

    g.Go(func() error {
        var err error
        preferences, err = fetchPreferences(ctx, userID)
        return err
    })

    // Wait for all goroutines
    // If any returns an error, the context is cancelled
    // causing the others to return early via ctx.Err()
    if err := g.Wait(); err != nil {
        return nil, fmt.Errorf("fetch user data: %w", err)
    }

    return &UserData{
        Profile:     profile,
        Orders:      orders,
        Preferences: preferences,
    }, nil
}
```

### errgroup with Bounded Concurrency

The `SetLimit` method (added in Go 1.20) bounds the number of active goroutines:

```go
func processImages(ctx context.Context, imageURLs []string) error {
    g, ctx := errgroup.WithContext(ctx)
    // Limit concurrent image processing to avoid OOM
    g.SetLimit(10)

    for _, url := range imageURLs {
        url := url // capture for goroutine (unnecessary in Go 1.22+)
        g.Go(func() error {
            return processImage(ctx, url)
        })
    }

    return g.Wait()
}
```

### Collecting Results with errgroup

```go
// Thread-safe result collection pattern
func fetchAll[T any](ctx context.Context, ids []string, fetch func(context.Context, string) (T, error)) ([]T, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(20)

    results := make([]T, len(ids))

    for i, id := range ids {
        i, id := i, id
        g.Go(func() error {
            result, err := fetch(ctx, id)
            if err != nil {
                return fmt.Errorf("fetch %s: %w", id, err)
            }
            results[i] = result // safe because each goroutine writes to a unique index
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

## Semaphore Patterns

When you need more control than errgroup's `SetLimit`, use `golang.org/x/sync/semaphore` directly.

### Weighted Semaphore

```go
package ratelimit

import (
    "context"
    "fmt"

    "golang.org/x/sync/semaphore"
)

// ResourcePool limits concurrent access to a resource with a weight system
// Heavy operations acquire more weight than light ones
type ResourcePool struct {
    sem *semaphore.Weighted
}

func NewResourcePool(maxConcurrentUnits int64) *ResourcePool {
    return &ResourcePool{
        sem: semaphore.NewWeighted(maxConcurrentUnits),
    }
}

// AcquireForSmallTask acquires 1 unit (lightweight operation)
func (p *ResourcePool) AcquireForSmallTask(ctx context.Context) error {
    return p.sem.Acquire(ctx, 1)
}

// AcquireForLargeTask acquires 4 units (CPU/memory intensive operation)
func (p *ResourcePool) AcquireForLargeTask(ctx context.Context) error {
    return p.sem.Acquire(ctx, 4)
}

func (p *ResourcePool) Release(weight int64) {
    p.sem.Release(weight)
}

// Example: database connection pool with query weight
type QueryExecutor struct {
    pool *ResourcePool
    db   *sql.DB
}

func (e *QueryExecutor) ExecuteSimple(ctx context.Context, query string) (*sql.Rows, error) {
    if err := e.pool.AcquireForSmallTask(ctx); err != nil {
        return nil, fmt.Errorf("acquire slot: %w", err)
    }
    defer e.pool.Release(1)

    return e.db.QueryContext(ctx, query)
}

func (e *QueryExecutor) ExecuteAnalytical(ctx context.Context, query string) (*sql.Rows, error) {
    // Analytical queries consume more resources
    if err := e.pool.AcquireForLargeTask(ctx); err != nil {
        return nil, fmt.Errorf("acquire slot: %w", err)
    }
    defer e.pool.Release(4)

    return e.db.QueryContext(ctx, query)
}
```

## Worker Pool Pattern

A worker pool bounds goroutine count, provides controlled shutdown, and handles backpressure:

```go
package workerpool

import (
    "context"
    "log/slog"
    "sync"
    "sync/atomic"
)

// Job represents a unit of work
type Job[I, O any] struct {
    Input  I
    Result chan<- Result[O]
}

type Result[O any] struct {
    Output O
    Err    error
}

// WorkerPool manages a fixed set of worker goroutines
type WorkerPool[I, O any] struct {
    jobs    chan Job[I, O]
    wg      sync.WaitGroup
    process func(context.Context, I) (O, error)

    // Metrics
    activeWorkers atomic.Int64
    processed     atomic.Int64
    errors        atomic.Int64
}

func New[I, O any](
    workerCount int,
    queueDepth int,
    process func(context.Context, I) (O, error),
) *WorkerPool[I, O] {
    p := &WorkerPool[I, O]{
        jobs:    make(chan Job[I, O], queueDepth),
        process: process,
    }

    return p
}

func (p *WorkerPool[I, O]) Start(ctx context.Context) {
    numWorkers := cap(p.jobs) // Use queue depth to determine worker count
    if numWorkers > 100 {
        numWorkers = 100 // Safety cap
    }

    for i := 0; i < numWorkers; i++ {
        p.wg.Add(1)
        go p.worker(ctx)
    }
}

func (p *WorkerPool[I, O]) worker(ctx context.Context) {
    defer p.wg.Done()

    for {
        select {
        case job, ok := <-p.jobs:
            if !ok {
                return // Channel closed, shut down
            }
            p.activeWorkers.Add(1)
            output, err := p.process(ctx, job.Input)
            p.activeWorkers.Add(-1)
            p.processed.Add(1)
            if err != nil {
                p.errors.Add(1)
            }

            if job.Result != nil {
                select {
                case job.Result <- Result[O]{Output: output, Err: err}:
                default:
                    slog.Warn("result channel full, dropping result")
                }
            }

        case <-ctx.Done():
            return
        }
    }
}

// Submit adds a job to the queue. Blocks if the queue is full.
func (p *WorkerPool[I, O]) Submit(ctx context.Context, input I) (O, error) {
    resultCh := make(chan Result[O], 1)

    select {
    case p.jobs <- Job[I, O]{Input: input, Result: resultCh}:
    case <-ctx.Done():
        var zero O
        return zero, ctx.Err()
    }

    select {
    case result := <-resultCh:
        return result.Output, result.Err
    case <-ctx.Done():
        var zero O
        return zero, ctx.Err()
    }
}

// SubmitAsync adds a job without waiting for the result
func (p *WorkerPool[I, O]) SubmitAsync(ctx context.Context, input I) error {
    select {
    case p.jobs <- Job[I, O]{Input: input}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Shutdown stops accepting new jobs and waits for in-flight jobs to complete
func (p *WorkerPool[I, O]) Shutdown() {
    close(p.jobs)
    p.wg.Wait()
}

// Stats returns current pool statistics
func (p *WorkerPool[I, O]) Stats() (active, processed, errors int64) {
    return p.activeWorkers.Load(), p.processed.Load(), p.errors.Load()
}
```

### Worker Pool Usage

```go
// Image resizing example
func ResizeImages(ctx context.Context, paths []string) ([]ResizedImage, error) {
    pool := workerpool.New[string, ResizedImage](
        16,     // 16 workers
        256,    // queue depth
        func(ctx context.Context, path string) (ResizedImage, error) {
            return resizeImage(ctx, path, 800, 600)
        },
    )
    pool.Start(ctx)
    defer pool.Shutdown()

    results := make([]ResizedImage, 0, len(paths))
    var mu sync.Mutex
    var errs []error

    var wg sync.WaitGroup
    for _, path := range paths {
        wg.Add(1)
        go func(p string) {
            defer wg.Done()
            img, err := pool.Submit(ctx, p)
            mu.Lock()
            defer mu.Unlock()
            if err != nil {
                errs = append(errs, err)
            } else {
                results = append(results, img)
            }
        }(path)
    }
    wg.Wait()

    if len(errs) > 0 {
        return results, errors.Join(errs...)
    }
    return results, nil
}
```

## Fan-Out / Fan-In Pattern

Fan-out distributes work across multiple goroutines; fan-in collects results from multiple goroutines into a single channel.

```go
package fanout

import (
    "context"
    "sync"
)

// FanOut distributes items from input to multiple worker goroutines
// and returns a channel of results
func FanOut[I, O any](
    ctx context.Context,
    input <-chan I,
    numWorkers int,
    process func(context.Context, I) (O, error),
) <-chan Result[O] {
    // Create worker output channels
    workerOutputs := make([]<-chan Result[O], numWorkers)
    for i := 0; i < numWorkers; i++ {
        workerOutputs[i] = startWorker(ctx, input, process)
    }

    // Fan-in: merge worker outputs into a single channel
    return FanIn(ctx, workerOutputs...)
}

func startWorker[I, O any](
    ctx context.Context,
    input <-chan I,
    process func(context.Context, I) (O, error),
) <-chan Result[O] {
    output := make(chan Result[O], 64)
    go func() {
        defer close(output)
        for {
            select {
            case item, ok := <-input:
                if !ok {
                    return
                }
                out, err := process(ctx, item)
                select {
                case output <- Result[O]{Output: out, Err: err}:
                case <-ctx.Done():
                    return
                }
            case <-ctx.Done():
                return
            }
        }
    }()
    return output
}

// FanIn merges multiple input channels into a single output channel
func FanIn[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    output := make(chan T, len(inputs)*32)
    var wg sync.WaitGroup

    for _, input := range inputs {
        wg.Add(1)
        go func(ch <-chan T) {
            defer wg.Done()
            for {
                select {
                case item, ok := <-ch:
                    if !ok {
                        return
                    }
                    select {
                    case output <- item:
                    case <-ctx.Done():
                        return
                    }
                case <-ctx.Done():
                    return
                }
            }
        }(input)
    }

    go func() {
        wg.Wait()
        close(output)
    }()

    return output
}
```

### Fan-Out Usage

```go
func ProcessLogFiles(ctx context.Context, filePaths []string) error {
    // Create input channel
    input := make(chan string, len(filePaths))
    for _, path := range filePaths {
        input <- path
    }
    close(input)

    // Fan out to 8 workers
    results := FanOut(ctx, input, 8, func(ctx context.Context, path string) (LogSummary, error) {
        return parseLogFile(ctx, path)
    })

    // Collect results
    var summaries []LogSummary
    var errs []error
    for result := range results {
        if result.Err != nil {
            errs = append(errs, result.Err)
        } else {
            summaries = append(summaries, result.Output)
        }
    }

    if len(errs) > 0 {
        return fmt.Errorf("%d files failed: %w", len(errs), errors.Join(errs...))
    }

    return saveSummaries(ctx, summaries)
}
```

## Pipeline Pattern

Pipelines chain processing stages where each stage reads from the previous stage's output channel:

```go
package pipeline

import "context"

// Stage is a function that transforms an input channel to an output channel
type Stage[I, O any] func(ctx context.Context, input <-chan I) <-chan O

// Pipeline chains multiple stages together
type Pipeline[I, O any] struct {
    stages []interface{} // type-erased stages
}

// Simple two-stage pipeline example (Go generics make multi-stage pipelines verbose)
func BuildETLPipeline(ctx context.Context, source <-chan RawRecord) <-chan ProcessedRecord {
    // Stage 1: Validate
    validated := validate(ctx, source)

    // Stage 2: Transform
    transformed := transform(ctx, validated)

    // Stage 3: Enrich
    enriched := enrich(ctx, transformed)

    return enriched
}

func validate(ctx context.Context, input <-chan RawRecord) <-chan RawRecord {
    output := make(chan RawRecord, 256)
    go func() {
        defer close(output)
        for record := range orDone(ctx, input) {
            if err := record.Validate(); err != nil {
                // Log and skip invalid records
                slog.Warn("invalid record", "id", record.ID, "err", err)
                continue
            }
            select {
            case output <- record:
            case <-ctx.Done():
                return
            }
        }
    }()
    return output
}

func transform(ctx context.Context, input <-chan RawRecord) <-chan TransformedRecord {
    output := make(chan TransformedRecord, 256)
    go func() {
        defer close(output)
        for record := range orDone(ctx, input) {
            transformed, err := record.Transform()
            if err != nil {
                slog.Error("transform failed", "id", record.ID, "err", err)
                continue
            }
            select {
            case output <- transformed:
            case <-ctx.Done():
                return
            }
        }
    }()
    return output
}

func enrich(ctx context.Context, input <-chan TransformedRecord) <-chan ProcessedRecord {
    // Enrich with lookup data — batch for efficiency
    output := make(chan ProcessedRecord, 256)
    go func() {
        defer close(output)

        batch := make([]TransformedRecord, 0, 50)
        ticker := time.NewTicker(100 * time.Millisecond)
        defer ticker.Stop()

        flush := func() {
            if len(batch) == 0 {
                return
            }
            enriched, err := batchEnrich(ctx, batch)
            if err != nil {
                slog.Error("batch enrich failed", "err", err)
                batch = batch[:0]
                return
            }
            for _, r := range enriched {
                select {
                case output <- r:
                case <-ctx.Done():
                    return
                }
            }
            batch = batch[:0]
        }

        for {
            select {
            case record, ok := <-input:
                if !ok {
                    flush()
                    return
                }
                batch = append(batch, record)
                if len(batch) >= 50 {
                    flush()
                }
            case <-ticker.C:
                flush() // Flush partial batches on timer
            case <-ctx.Done():
                return
            }
        }
    }()
    return output
}

// orDone wraps a channel to stop reading on context cancellation
// This is a fundamental building block for pipeline stages
func orDone[T any](ctx context.Context, ch <-chan T) <-chan T {
    output := make(chan T)
    go func() {
        defer close(output)
        for {
            select {
            case v, ok := <-ch:
                if !ok {
                    return
                }
                select {
                case output <- v:
                case <-ctx.Done():
                    return
                }
            case <-ctx.Done():
                return
            }
        }
    }()
    return output
}
```

## Context Cancellation Propagation

Correct context propagation is the foundation of all these patterns:

```go
package context_patterns

import (
    "context"
    "log/slog"
    "time"
)

// CascadingCancellation demonstrates how cancellation propagates through a job graph
type JobGraph struct {
    rootCtx    context.Context
    rootCancel context.CancelFunc
}

func NewJobGraph(parentCtx context.Context, timeout time.Duration) *JobGraph {
    ctx, cancel := context.WithTimeout(parentCtx, timeout)
    return &JobGraph{rootCtx: ctx, rootCancel: cancel}
}

func (g *JobGraph) Run() error {
    defer g.rootCancel()

    g2, ctx := errgroup.WithContext(g.rootCtx)

    // Phase 1: parallel data collection
    var rawData []*RawData
    var mu sync.Mutex

    sources := []string{"db", "api", "cache"}
    for _, source := range sources {
        source := source
        g2.Go(func() error {
            data, err := collectFrom(ctx, source)
            if err != nil {
                return fmt.Errorf("collect from %s: %w", source, err)
            }
            mu.Lock()
            rawData = append(rawData, data)
            mu.Unlock()
            return nil
        })
    }

    if err := g2.Wait(); err != nil {
        return err
    }

    // Phase 2: sequential processing with derived context
    // Add a deadline specific to this phase
    processCtx, processCancel := context.WithTimeout(g.rootCtx, 30*time.Second)
    defer processCancel()

    return processAll(processCtx, rawData)
}

// Demonstrating context value propagation for request tracing
type traceKey struct{}

func WithTraceID(ctx context.Context, traceID string) context.Context {
    return context.WithValue(ctx, traceKey{}, traceID)
}

func TraceID(ctx context.Context) string {
    if id, ok := ctx.Value(traceKey{}).(string); ok {
        return id
    }
    return ""
}

// Worker that properly propagates trace context
func tracedWorker(ctx context.Context, job Job) error {
    traceID := TraceID(ctx)
    slog.Info("processing job",
        "trace_id", traceID,
        "job_id", job.ID,
    )

    // Create a child context with a per-job deadline
    jobCtx, cancel := context.WithTimeout(ctx, job.Timeout)
    defer cancel()

    return job.Execute(jobCtx)
}
```

## Timeout and Deadline Patterns

```go
// RetryWithExponentialBackoff retries fn with exponential backoff
// respecting context cancellation
func RetryWithExponentialBackoff(
    ctx context.Context,
    maxAttempts int,
    initialDelay time.Duration,
    fn func(ctx context.Context) error,
) error {
    delay := initialDelay
    var lastErr error

    for attempt := 0; attempt < maxAttempts; attempt++ {
        // Create per-attempt context with timeout
        attemptCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
        err := fn(attemptCtx)
        cancel()

        if err == nil {
            return nil
        }

        // Don't retry if context was cancelled
        if ctx.Err() != nil {
            return ctx.Err()
        }

        lastErr = err
        slog.Warn("attempt failed, retrying",
            "attempt", attempt+1,
            "max_attempts", maxAttempts,
            "delay", delay,
            "err", err,
        )

        select {
        case <-time.After(delay):
            delay *= 2
            if delay > 30*time.Second {
                delay = 30 * time.Second
            }
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    return fmt.Errorf("after %d attempts: %w", maxAttempts, lastErr)
}

// WithHeartbeat runs fn and sends periodic heartbeats on the returned channel
// Callers can use the heartbeat channel to detect stalled operations
func WithHeartbeat(ctx context.Context, interval time.Duration, fn func(ctx context.Context) error) (<-chan struct{}, <-chan error) {
    heartbeat := make(chan struct{}, 1)
    errCh := make(chan error, 1)

    go func() {
        defer close(errCh)
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        done := make(chan error, 1)
        go func() {
            done <- fn(ctx)
        }()

        for {
            select {
            case err := <-done:
                errCh <- err
                return
            case <-ticker.C:
                select {
                case heartbeat <- struct{}{}:
                default:
                }
            case <-ctx.Done():
                errCh <- ctx.Err()
                return
            }
        }
    }()

    return heartbeat, errCh
}
```

## Preventing Goroutine Leaks

Common leak patterns and their fixes:

```go
// LEAK: goroutine blocks on send forever if caller abandons the context
func leakyGoroutine(ctx context.Context) <-chan int {
    ch := make(chan int)
    go func() {
        result := compute()
        ch <- result // blocks if nobody reads from ch
    }()
    return ch
}

// FIX: use buffered channel or context cancellation
func safeGoroutine(ctx context.Context) <-chan int {
    ch := make(chan int, 1) // buffered — sender never blocks
    go func() {
        result := compute()
        select {
        case ch <- result:
        case <-ctx.Done():
            // Context cancelled, nobody will read from ch
        }
    }()
    return ch
}

// LEAK: infinite loop without cancellation check
func leakyLoop(ctx context.Context) {
    go func() {
        for {
            processNext() // never checks ctx.Done()
        }
    }()
}

// FIX: check context on each iteration
func safeLoop(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
            }
            processNext()
        }
    }()
}
```

## Measuring Goroutine Counts

```go
// Monitor goroutine count in production
import "runtime"

func monitorGoroutines(ctx context.Context, threshold int) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            count := runtime.NumGoroutine()
            goroutineCount.Set(float64(count))
            if count > threshold {
                slog.Warn("high goroutine count detected",
                    "count", count,
                    "threshold", threshold,
                )
            }
        case <-ctx.Done():
            return
        }
    }
}

// Test for goroutine leaks in unit tests
import "testing"
import "github.com/uber-go/goleak"

func TestConcurrentProcessor(t *testing.T) {
    defer goleak.VerifyNone(t) // Fails if any goroutines are left running

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    processor := NewProcessor()
    result, err := processor.Process(ctx, testInput)
    if err != nil {
        t.Fatal(err)
    }
    _ = result
}
```

## Production Configuration Example

```go
// Complete example: image processing service
package imageprocessor

import (
    "context"
    "fmt"
    "log/slog"
    "sync"
    "time"

    "golang.org/x/sync/errgroup"
    "golang.org/x/sync/semaphore"
)

type Service struct {
    // Limit concurrent image processing (CPU-bound)
    processingSem *semaphore.Weighted

    // Limit concurrent external API calls (network-bound)
    apiSem *semaphore.Weighted

    storage ImageStorage
    api     ExternalAPI
}

func NewService(storage ImageStorage, api ExternalAPI) *Service {
    cpuCount := runtime.NumCPU()
    return &Service{
        processingSem: semaphore.NewWeighted(int64(cpuCount * 2)),
        apiSem:        semaphore.NewWeighted(50), // 50 concurrent API calls
        storage:       storage,
        api:           api,
    }
}

// ProcessBatch processes a batch of images with full error collection
func (s *Service) ProcessBatch(ctx context.Context, imageIDs []string) (*BatchResult, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(100) // Max 100 goroutines in flight

    type outcome struct {
        id  string
        err error
    }
    outcomes := make([]outcome, len(imageIDs))

    for i, id := range imageIDs {
        i, id := i, id
        g.Go(func() error {
            err := s.processOne(ctx, id)
            outcomes[i] = outcome{id: id, err: err}
            if err != nil {
                slog.Error("failed to process image", "id", id, "err", err)
                // Don't return the error — we want to process all images
                // even if some fail. errgroup cancels context on first error.
                // Use a separate result collection pattern instead.
            }
            return nil // Always return nil to avoid cancelling other goroutines
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err // Only returns context errors
    }

    result := &BatchResult{}
    for _, o := range outcomes {
        if o.err != nil {
            result.Failed = append(result.Failed, FailedImage{ID: o.id, Err: o.err})
        } else {
            result.Succeeded = append(result.Succeeded, o.id)
        }
    }
    return result, nil
}

func (s *Service) processOne(ctx context.Context, id string) error {
    // Acquire processing semaphore (CPU-bound work)
    if err := s.processingSem.Acquire(ctx, 1); err != nil {
        return fmt.Errorf("acquire processing slot: %w", err)
    }
    defer s.processingSem.Release(1)

    // Download image
    data, err := s.storage.Download(ctx, id)
    if err != nil {
        return fmt.Errorf("download: %w", err)
    }

    // Process image (CPU-bound — held under processingSem)
    processed, err := processImageData(data)
    if err != nil {
        return fmt.Errorf("process: %w", err)
    }
    s.processingSem.Release(1)
    // Release processing semaphore before network I/O

    // Re-acquire for API call (network-bound — different semaphore)
    if err := s.apiSem.Acquire(ctx, 1); err != nil {
        return fmt.Errorf("acquire api slot: %w", err)
    }
    defer s.apiSem.Release(1)

    // Call external API
    metadata, err := s.api.GetMetadata(ctx, id)
    if err != nil {
        return fmt.Errorf("get metadata: %w", err)
    }

    // Store result
    return s.storage.Upload(ctx, id, processed, metadata)
}
```

## Summary

Structured concurrency in Go requires explicit handling of goroutine lifecycles, error propagation, and bounded resource usage. The key patterns:

- Use `errgroup.WithContext` as the foundation — it handles context cancellation, error propagation, and goroutine lifecycle in one package
- Use `errgroup.SetLimit` for bounded concurrency without the complexity of a full worker pool
- Implement worker pools when you need persistent workers, queue backpressure monitoring, or work-stealing behavior
- Fan-out/fan-in patterns work best when work units are independent and results can be collected in any order
- Pipeline patterns suit sequential processing stages where each stage's output feeds the next
- Use `orDone` to wrap channels so pipeline stages terminate correctly on context cancellation
- Always verify goroutine cleanup with goleak in tests — silent goroutine leaks accumulate and eventually exhaust memory
- Separate CPU-bound and network-bound semaphores when a single operation does both — holding a CPU semaphore during network I/O starves other CPU-bound work unnecessarily
