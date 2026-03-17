---
title: "Go Concurrency Patterns: Worker Pools, Pipeline Patterns, and Fan-Out/Fan-In"
date: 2029-12-06T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Worker Pools", "Pipelines", "Fan-Out", "Fan-In", "errgroup", "Channels"]
categories:
- Go
- Concurrency
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go concurrency patterns including worker pools, pipeline composition, fan-out/fan-in, context cancellation, errgroup, and backpressure for production systems."
more_link: "yes"
url: "/go-concurrency-worker-pools-pipeline-fan-out/"
---

Go's concurrency model, built on goroutines and channels, is powerful but demands discipline. The patterns in this guide are distilled from production systems processing millions of events per second. Each pattern addresses a specific problem: worker pools bound concurrency, pipelines compose stages cleanly, fan-out/fan-in parallelizes independent work, and backpressure prevents resource exhaustion. Understanding when and how to apply each pattern is the difference between a robust concurrent system and one that silently deadlocks or leaks goroutines under load.

<!--more-->

## Worker Pool Pattern

A worker pool bounds the number of concurrent goroutines processing items from a shared queue. Without bounding, submitting 100,000 tasks creates 100,000 goroutines — each consuming stack memory and CPU scheduling overhead.

### Basic Worker Pool

```go
package workerpool

import (
    "context"
    "sync"
)

type Job[T any] struct {
    ID      int
    Payload T
}

type Result[T, R any] struct {
    Job   Job[T]
    Value R
    Err   error
}

type WorkerPool[T, R any] struct {
    workers int
    jobs    chan Job[T]
    results chan Result[T, R]
    process func(ctx context.Context, job Job[T]) (R, error)
    wg      sync.WaitGroup
}

func New[T, R any](workers int, process func(ctx context.Context, job Job[T]) (R, error)) *WorkerPool[T, R] {
    return &WorkerPool[T, R]{
        workers: workers,
        jobs:    make(chan Job[T], workers*2),
        results: make(chan Result[T, R], workers*2),
        process: process,
    }
}

func (p *WorkerPool[T, R]) Start(ctx context.Context) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for {
                select {
                case job, ok := <-p.jobs:
                    if !ok {
                        return
                    }
                    val, err := p.process(ctx, job)
                    select {
                    case p.results <- Result[T, R]{Job: job, Value: val, Err: err}:
                    case <-ctx.Done():
                        return
                    }
                case <-ctx.Done():
                    return
                }
            }
        }()
    }
    // Close results when all workers exit
    go func() {
        p.wg.Wait()
        close(p.results)
    }()
}

func (p *WorkerPool[T, R]) Submit(ctx context.Context, job Job[T]) error {
    select {
    case p.jobs <- job:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (p *WorkerPool[T, R]) Close() {
    close(p.jobs)
}

func (p *WorkerPool[T, R]) Results() <-chan Result[T, R] {
    return p.results
}
```

Usage pattern:

```go
pool := workerpool.New[string, int](runtime.NumCPU(), func(ctx context.Context, job workerpool.Job[string]) (int, error) {
    return processItem(ctx, job.Payload)
})

ctx, cancel := context.WithCancel(context.Background())
defer cancel()

pool.Start(ctx)

// Submit work in a goroutine so we can read results concurrently
go func() {
    defer pool.Close()
    for i, item := range items {
        if err := pool.Submit(ctx, workerpool.Job[string]{ID: i, Payload: item}); err != nil {
            return // context cancelled
        }
    }
}()

var errs []error
for result := range pool.Results() {
    if result.Err != nil {
        errs = append(errs, result.Err)
        continue
    }
    // process result.Value
}
```

### Sizing the Pool

The optimal worker count depends on the bottleneck:

- **CPU-bound work**: `runtime.NumCPU()` — more goroutines cause context-switch overhead
- **I/O-bound work**: 10–100x `NumCPU()` — goroutines block on I/O, not CPU
- **Mixed work with external rate limits**: tune empirically using load tests and monitor queue depth

```go
// Monitor pool utilization
type instrumentedPool struct {
    *WorkerPool[string, int]
    queueDepth prometheus.Gauge
    processing prometheus.Gauge
}
```

## Pipeline Pattern

Pipelines compose independent processing stages into a chain where each stage reads from the previous stage's output channel. The key property: each stage is a pure function from `<-chan T` to `<-chan U`, making stages independently testable and composable.

```go
package pipeline

import "context"

// Stage is a function that reads from in and writes to the returned channel
type Stage[T, U any] func(ctx context.Context, in <-chan T) <-chan U

// Compose chains stages: out = s2(s1(in))
func Compose[T, U, V any](s1 Stage[T, U], s2 Stage[U, V]) Stage[T, V] {
    return func(ctx context.Context, in <-chan T) <-chan V {
        return s2(ctx, s1(ctx, in))
    }
}

// Generator creates the source stage from a slice
func Generator[T any](ctx context.Context, items []T) <-chan T {
    out := make(chan T, len(items))
    go func() {
        defer close(out)
        for _, item := range items {
            select {
            case out <- item:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Map applies f to every item in in
func Map[T, U any](f func(T) U) Stage[T, U] {
    return func(ctx context.Context, in <-chan T) <-chan U {
        out := make(chan U)
        go func() {
            defer close(out)
            for item := range in {
                select {
                case out <- f(item):
                case <-ctx.Done():
                    return
                }
            }
        }()
        return out
    }
}

// Filter passes only items for which pred returns true
func Filter[T any](pred func(T) bool) Stage[T, T] {
    return func(ctx context.Context, in <-chan T) <-chan T {
        out := make(chan T)
        go func() {
            defer close(out)
            for item := range in {
                if pred(item) {
                    select {
                    case out <- item:
                    case <-ctx.Done():
                        return
                    }
                }
            }
        }()
        return out
    }
}

// Batch collects items into slices of size n
func Batch[T any](n int) Stage[T, []T] {
    return func(ctx context.Context, in <-chan T) <-chan []T {
        out := make(chan []T)
        go func() {
            defer close(out)
            buf := make([]T, 0, n)
            flush := func() {
                if len(buf) == 0 {
                    return
                }
                batch := make([]T, len(buf))
                copy(batch, buf)
                buf = buf[:0]
                select {
                case out <- batch:
                case <-ctx.Done():
                }
            }
            for item := range in {
                buf = append(buf, item)
                if len(buf) == n {
                    flush()
                }
            }
            flush() // flush remaining items
        }()
        return out
    }
}
```

Composing a real pipeline:

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()

// Build pipeline: parse -> validate -> enrich -> batch -> insert
parseStage := Map[RawEvent, ParsedEvent](parseEvent)
validateStage := Filter[ParsedEvent](isValid)
enrichStage := Map[ParsedEvent, EnrichedEvent](enrichWithMetadata)
batchStage := Batch[EnrichedEvent](500)

source := Generator(ctx, rawEvents)
parsed := parseStage(ctx, source)
validated := validateStage(ctx, parsed)
enriched := enrichStage(ctx, validated)
batches := batchStage(ctx, enriched)

for batch := range batches {
    if err := db.BulkInsert(ctx, batch); err != nil {
        cancel() // signal upstream stages to stop
        log.Printf("bulk insert failed: %v", err)
        break
    }
}
```

## Fan-Out / Fan-In

Fan-out distributes work from one channel to multiple goroutines. Fan-in merges multiple channels back into one. Together they parallelize independent work within a pipeline.

### Fan-Out

```go
// FanOut distributes items from in to n workers, each running f
func FanOut[T, U any](ctx context.Context, in <-chan T, n int, f func(context.Context, T) (U, error)) []<-chan result[U] {
    channels := make([]<-chan result[U], n)
    for i := 0; i < n; i++ {
        ch := make(chan result[U])
        channels[i] = ch
        go func(out chan<- result[U]) {
            defer close(out)
            for item := range in {
                val, err := f(ctx, item)
                select {
                case out <- result[U]{val: val, err: err}:
                case <-ctx.Done():
                    return
                }
            }
        }(ch)
    }
    return channels
}

type result[T any] struct {
    val T
    err error
}
```

### Fan-In (Merge)

```go
// FanIn merges multiple input channels into a single output channel
func FanIn[T any](ctx context.Context, channels ...<-chan T) <-chan T {
    out := make(chan T)
    var wg sync.WaitGroup
    wg.Add(len(channels))

    for _, ch := range channels {
        go func(c <-chan T) {
            defer wg.Done()
            for item := range c {
                select {
                case out <- item:
                case <-ctx.Done():
                    return
                }
            }
        }(ch)
    }

    go func() {
        wg.Wait()
        close(out)
    }()
    return out
}
```

### Complete Fan-Out/Fan-In Example

```go
func processURLsConcurrently(ctx context.Context, urls []string, workers int) ([]PageData, error) {
    // Source
    source := Generator(ctx, urls)

    // Fan-out: distribute URLs to workers
    workerChannels := FanOut(ctx, source, workers, func(ctx context.Context, url string) (PageData, error) {
        return fetchAndParse(ctx, url)
    })

    // Fan-in: merge results
    merged := FanIn(ctx, workerChannels...)

    // Collect results
    var pages []PageData
    var errs []error
    for res := range merged {
        if res.err != nil {
            errs = append(errs, res.err)
            continue
        }
        pages = append(pages, res.val)
    }

    return pages, errors.Join(errs...)
}
```

## errgroup: Structured Concurrency

The `golang.org/x/sync/errgroup` package provides structured concurrency — a group of goroutines where any error cancels the group and the group waits for all goroutines to finish:

```go
import "golang.org/x/sync/errgroup"

func processWithErrgroup(ctx context.Context, items []Item) error {
    g, ctx := errgroup.WithContext(ctx)

    // Limit concurrent goroutines
    g.SetLimit(runtime.NumCPU() * 2)

    results := make([]Result, len(items))

    for i, item := range items {
        i, item := i, item // capture loop variables
        g.Go(func() error {
            res, err := process(ctx, item)
            if err != nil {
                return fmt.Errorf("processing item %d: %w", i, err)
            }
            results[i] = res
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return err
    }
    return nil
}
```

`errgroup.WithContext` returns a derived context that is cancelled when any goroutine returns a non-nil error. All goroutines check this context in their blocking operations, so the first failure triggers clean shutdown of the rest.

### errgroup with Streaming

For large datasets that don't fit in memory, combine errgroup with a channel:

```go
func streamProcess(ctx context.Context, records <-chan Record) error {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(50)

    for record := range records {
        record := record
        g.Go(func() error {
            return processRecord(ctx, record)
        })
    }
    return g.Wait()
}
```

## Backpressure

Backpressure prevents fast producers from overwhelming slow consumers. Without it, a bounded channel blocks the producer, but an unbounded goroutine-per-item model causes memory exhaustion.

### Channel Buffer as Backpressure

```go
// Buffered channel provides N items of buffer before blocking the producer
jobs := make(chan Job, 1000)

// Producer blocks when buffer is full — natural backpressure
go func() {
    for _, item := range hugeDataset {
        jobs <- item // blocks if buffer is full
    }
    close(jobs)
}()
```

### Semaphore-Based Backpressure

```go
type Semaphore chan struct{}

func NewSemaphore(n int) Semaphore {
    return make(chan struct{}, n)
}

func (s Semaphore) Acquire(ctx context.Context) error {
    select {
    case s <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (s Semaphore) Release() {
    <-s
}

// Usage: limit to 20 concurrent HTTP requests
sem := NewSemaphore(20)
for _, url := range urls {
    url := url
    if err := sem.Acquire(ctx); err != nil {
        break
    }
    go func() {
        defer sem.Release()
        fetchURL(ctx, url)
    }()
}
```

### Token Bucket for Rate Limiting

```go
import "golang.org/x/time/rate"

type RateLimitedPool struct {
    pool    *WorkerPool[string, int]
    limiter *rate.Limiter
}

func (p *RateLimitedPool) Submit(ctx context.Context, job Job[string]) error {
    // Wait for a token before submitting
    if err := p.limiter.Wait(ctx); err != nil {
        return err
    }
    return p.pool.Submit(ctx, job)
}
```

## Context Cancellation Patterns

Every blocking operation must respect context cancellation. Common mistakes:

### Never block on send without ctx

```go
// WRONG: deadlocks if consumer exits
out <- result

// CORRECT: respects cancellation
select {
case out <- result:
case <-ctx.Done():
    return ctx.Err()
}
```

### Drain channels before exiting

When a goroutine receives a cancellation, it must drain its input channel to unblock upstream senders:

```go
func worker(ctx context.Context, in <-chan Job) {
    for {
        select {
        case job, ok := <-in:
            if !ok {
                return
            }
            // process job
        case <-ctx.Done():
            // Drain remaining jobs to unblock producer
            for range in {
            }
            return
        }
    }
}
```

### Timeout per item vs. total timeout

```go
func processAllWithTimeout(ctx context.Context, items []Item) error {
    // Total operation timeout
    ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
    defer cancel()

    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(10)

    for _, item := range items {
        item := item
        g.Go(func() error {
            // Per-item timeout nested inside total timeout
            itemCtx, itemCancel := context.WithTimeout(ctx, 10*time.Second)
            defer itemCancel()
            return processItem(itemCtx, item)
        })
    }
    return g.Wait()
}
```

## Goroutine Leak Detection

Use `goleak` in tests to detect leaked goroutines:

```go
import "go.uber.org/goleak"

func TestWorkerPool(t *testing.T) {
    defer goleak.VerifyNone(t)

    ctx, cancel := context.WithCancel(context.Background())

    pool := workerpool.New[string, int](4, processFunc)
    pool.Start(ctx)

    // Submit and drain results
    go func() {
        pool.Submit(ctx, workerpool.Job[string]{ID: 1, Payload: "test"})
        pool.Close()
    }()

    for range pool.Results() {
    }

    cancel()
    // goleak will verify no goroutines leak after test
}
```

## Production Patterns Summary

| Pattern | Use When | Gotcha |
|---|---|---|
| Worker Pool | Bounded concurrency for uniform work | Size pool for actual bottleneck (CPU vs I/O) |
| Pipeline | Sequential multi-stage transforms | Each stage must drain input on ctx cancel |
| Fan-Out/Fan-In | Independent parallel sub-tasks | Shared state requires synchronization |
| errgroup | Structured error collection | SetLimit prevents goroutine explosion |
| Semaphore | Rate-limit external calls | Release must be deferred, not conditional |
| Backpressure | Prevent producer/consumer mismatch | Buffered channels hide, not solve, mismatches |

The most common production failures in concurrent Go are goroutine leaks (goroutines that never exit), channel deadlocks (all senders and receivers blocked), and data races (concurrent access to shared state). The patterns above prevent all three when applied consistently: always select on ctx.Done alongside channel operations, always close channels from the sending side, and avoid shared mutable state entirely by passing data through channels.
