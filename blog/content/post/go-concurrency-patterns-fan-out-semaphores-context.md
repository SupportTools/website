---
title: "Go Concurrency Patterns: Fan-Out/Fan-In, Semaphores, and Context Cancellation"
date: 2030-03-01T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Goroutines", "Context", "Channels", "Performance"]
categories: ["Go", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go concurrency patterns: bounded goroutine pools, semaphore implementation, fan-out/fan-in pipelines, context propagation for graceful shutdown, and goroutine leak detection with goleak."
more_link: "yes"
url: "/go-concurrency-patterns-fan-out-semaphores-context/"
---

Go's concurrency model is elegant but the gap between "it works on my machine with 10 items" and "it works in production with 10,000 concurrent requests" is filled with goroutine leaks, unbounded fan-out causing OOM kills, context cancellations that are ignored, and race conditions that only appear under load. These are not theoretical concerns — they are the failure modes that cause production incidents.

This guide covers the concurrency patterns that production Go services actually need: properly bounded goroutine pools, semaphores that compose cleanly with context, fan-out/fan-in pipelines that propagate cancellation correctly, and detecting goroutine leaks before they reach production.

<!--more-->

## The Core Problem: Unbounded Concurrency

The naive approach to parallelism in Go:

```go
// WRONG: unbounded goroutine creation
func processItems(items []Item) []Result {
    results := make(chan Result, len(items))
    for _, item := range items {
        item := item
        go func() {
            results <- process(item)
        }()
    }
    // Collect results...
}
```

This works for 100 items. With 100,000 items, it creates 100,000 goroutines simultaneously. Each goroutine starts with an 8KB stack. That's 800MB before any work is done. If `process` makes network calls or holds connections, each goroutine may allocate further resources. The result is memory exhaustion, connection pool depletion, or overwhelming downstream services.

Every production concurrency pattern starts with: how do we bound the maximum concurrency?

## Semaphore Implementation

A semaphore is the most fundamental concurrency primitive for bounding parallelism. Go's standard library doesn't include one, but building it with a buffered channel is idiomatic and correct:

```go
// pkg/semaphore/semaphore.go
package semaphore

import (
    "context"
    "fmt"
)

// Semaphore is a counting semaphore for limiting concurrent operations.
// It integrates with context for cancellation support.
type Semaphore struct {
    ch chan struct{}
}

// New creates a semaphore with the given capacity.
// Panics if n <= 0.
func New(n int) *Semaphore {
    if n <= 0 {
        panic(fmt.Sprintf("semaphore: invalid capacity %d", n))
    }
    return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire acquires the semaphore, blocking until a slot is available
// or the context is cancelled. Returns an error if the context is cancelled.
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryAcquire attempts to acquire the semaphore without blocking.
// Returns true if successful.
func (s *Semaphore) TryAcquire() bool {
    select {
    case s.ch <- struct{}{}:
        return true
    default:
        return false
    }
}

// Release releases the semaphore.
// Panics if called more times than Acquire succeeded.
func (s *Semaphore) Release() {
    select {
    case <-s.ch:
    default:
        panic("semaphore: Release called without Acquire")
    }
}

// Available returns the number of available slots.
func (s *Semaphore) Available() int {
    return cap(s.ch) - len(s.ch)
}

// Cap returns the total capacity of the semaphore.
func (s *Semaphore) Cap() int {
    return cap(s.ch)
}
```

Usage:

```go
func processItemsConcurrently(ctx context.Context, items []Item, maxConcurrency int) ([]Result, error) {
    sem := semaphore.New(maxConcurrency)
    results := make([]Result, len(items))
    errs := make([]error, len(items))

    var wg sync.WaitGroup
    for i, item := range items {
        i, item := i, item

        if err := sem.Acquire(ctx); err != nil {
            // Context cancelled; wait for in-flight goroutines to finish
            wg.Wait()
            return nil, fmt.Errorf("processing cancelled after %d items: %w", i, err)
        }

        wg.Add(1)
        go func() {
            defer wg.Done()
            defer sem.Release()

            result, err := process(ctx, item)
            results[i] = result
            errs[i] = err
        }()
    }

    wg.Wait()

    // Collect first error
    for _, err := range errs {
        if err != nil {
            return results, err
        }
    }
    return results, nil
}
```

### golang.org/x/sync/semaphore for Weighted Semaphores

For operations with variable resource cost (e.g., processing images of different sizes), use the weighted semaphore:

```go
import "golang.org/x/sync/semaphore"

func processImages(ctx context.Context, images []Image) error {
    // 4GB memory budget: each image acquires cost proportional to its size
    const memoryBudget = 4 * 1024 * 1024 * 1024  // 4GB in bytes
    sem := semaphore.NewWeighted(memoryBudget)

    var g errgroup.Group
    for _, img := range images {
        img := img
        cost := int64(img.Width * img.Height * img.Channels * 4) // bytes to process

        if err := sem.Acquire(ctx, cost); err != nil {
            return fmt.Errorf("acquire semaphore: %w", err)
        }

        g.Go(func() error {
            defer sem.Release(cost)
            return processImage(ctx, img)
        })
    }

    return g.Wait()
}
```

## Worker Pool Pattern

A worker pool pre-allocates goroutines and feeds them work through a channel. This avoids the overhead of goroutine creation and more precisely bounds concurrency:

```go
// pkg/workerpool/pool.go
package workerpool

import (
    "context"
    "sync"
)

// Task is a unit of work to be executed.
type Task[T any] struct {
    Input  T
    Result chan<- Result[T]
}

// Result holds the output of a task execution.
type Result[T any] struct {
    Input  T
    Output interface{}
    Err    error
}

// Pool is a bounded goroutine pool.
type Pool[T any] struct {
    tasks  chan Task[T]
    done   chan struct{}
    wg     sync.WaitGroup
    worker func(context.Context, T) (interface{}, error)
}

// New creates a pool with n workers running fn.
func New[T any](n int, fn func(context.Context, T) (interface{}, error)) *Pool[T] {
    p := &Pool[T]{
        tasks:  make(chan Task[T], n*2), // Buffer 2x workers for smooth throughput
        done:   make(chan struct{}),
        worker: fn,
    }

    p.wg.Add(n)
    for i := 0; i < n; i++ {
        go p.run(context.Background())
    }

    return p
}

// NewWithContext creates a pool where workers share a context.
func NewWithContext[T any](ctx context.Context, n int, fn func(context.Context, T) (interface{}, error)) *Pool[T] {
    p := &Pool[T]{
        tasks:  make(chan Task[T], n*2),
        done:   make(chan struct{}),
        worker: fn,
    }

    p.wg.Add(n)
    for i := 0; i < n; i++ {
        go p.runWithContext(ctx)
    }

    return p
}

func (p *Pool[T]) run(ctx context.Context) {
    defer p.wg.Done()
    for task := range p.tasks {
        output, err := p.worker(ctx, task.Input)
        if task.Result != nil {
            task.Result <- Result[T]{
                Input:  task.Input,
                Output: output,
                Err:    err,
            }
        }
    }
}

func (p *Pool[T]) runWithContext(ctx context.Context) {
    defer p.wg.Done()
    for {
        select {
        case <-ctx.Done():
            return
        case task, ok := <-p.tasks:
            if !ok {
                return
            }
            output, err := p.worker(ctx, task.Input)
            if task.Result != nil {
                task.Result <- Result[T]{
                    Input:  task.Input,
                    Output: output,
                    Err:    err,
                }
            }
        }
    }
}

// Submit sends work to the pool. Blocks if all workers are busy.
// Returns error if context is cancelled while waiting.
func (p *Pool[T]) Submit(ctx context.Context, input T, results chan<- Result[T]) error {
    select {
    case p.tasks <- Task[T]{Input: input, Result: results}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Close shuts down the pool and waits for all workers to finish.
func (p *Pool[T]) Close() {
    close(p.tasks)
    p.wg.Wait()
}
```

## Fan-Out/Fan-In with Pipeline Pattern

Fan-out/fan-in is the pattern for pipeline-style processing where one stage fans out to multiple workers and the results are fanned back in:

```go
// pkg/pipeline/pipeline.go
package pipeline

import (
    "context"
    "sync"
)

// Generator creates a channel that yields items from a slice.
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

// GeneratorFunc creates a channel from a generator function.
// The fn function should close the channel when done.
func GeneratorFunc[T any](ctx context.Context, fn func(ctx context.Context, out chan<- T)) <-chan T {
    out := make(chan T, 32)
    go func() {
        defer close(out)
        fn(ctx, out)
    }()
    return out
}

// Map applies fn to each item in the input channel.
func Map[T, R any](ctx context.Context, in <-chan T, fn func(context.Context, T) (R, error)) <-chan Result[R] {
    out := make(chan Result[R], 32)
    go func() {
        defer close(out)
        for item := range in {
            result, err := fn(ctx, item)
            select {
            case out <- Result[R]{Value: result, Err: err}:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Result holds a value and error.
type Result[T any] struct {
    Value T
    Err   error
}

// FanOut distributes items from in to n concurrent workers, each running fn.
// Returns a slice of output channels, one per worker.
func FanOut[T, R any](ctx context.Context, in <-chan T, n int, fn func(context.Context, T) (R, error)) []<-chan Result[R] {
    outputs := make([]<-chan Result[R], n)
    for i := 0; i < n; i++ {
        outputs[i] = Map(ctx, in, fn)
    }
    return outputs
}

// Merge combines multiple channels into a single channel.
// This is the "fan-in" step.
func Merge[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    out := make(chan T, 32)
    var wg sync.WaitGroup

    forward := func(ch <-chan T) {
        defer wg.Done()
        for item := range ch {
            select {
            case out <- item:
            case <-ctx.Done():
                return
            }
        }
    }

    wg.Add(len(inputs))
    for _, input := range inputs {
        go forward(input)
    }

    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}

// Batch collects items into batches of the given size.
func Batch[T any](ctx context.Context, in <-chan T, size int) <-chan []T {
    out := make(chan []T, 4)
    go func() {
        defer close(out)
        batch := make([]T, 0, size)
        for item := range in {
            batch = append(batch, item)
            if len(batch) >= size {
                select {
                case out <- batch:
                    batch = make([]T, 0, size)
                case <-ctx.Done():
                    return
                }
            }
        }
        if len(batch) > 0 {
            select {
            case out <- batch:
            case <-ctx.Done():
            }
        }
    }()
    return out
}
```

### Complete Fan-Out Pipeline Example

```go
func ProcessURLs(ctx context.Context, urls []string) ([]PageSummary, error) {
    const workers = 20

    // Stage 1: Generate URLs
    urlChan := pipeline.Generator(ctx, urls)

    // Stage 2: Fan out HTTP fetches across 20 workers
    // Each worker runs independently on the same input channel
    // The channel multiplexes: each URL goes to exactly one worker
    fetchResults := make([]<-chan pipeline.Result[*http.Response], workers)
    for i := 0; i < workers; i++ {
        fetchResults[i] = pipeline.Map(ctx, urlChan, func(ctx context.Context, url string) (*http.Response, error) {
            return http.Get(url)
        })
    }

    // Stage 3: Fan in all fetch results
    merged := pipeline.Merge(ctx, fetchResults...)

    // Stage 4: Parse results (single goroutine - CPU bound but sequential)
    summaries := make([]PageSummary, 0, len(urls))
    var firstErr error
    for result := range merged {
        if result.Err != nil {
            if firstErr == nil {
                firstErr = result.Err
            }
            continue
        }
        // Parse response...
        result.Value.Body.Close()
        summaries = append(summaries, PageSummary{})
    }

    return summaries, firstErr
}
```

## errgroup for Structured Concurrency

`golang.org/x/sync/errgroup` is the canonical way to manage a group of goroutines where any failure should cancel the group:

```go
import "golang.org/x/sync/errgroup"

func FetchAllParallel(ctx context.Context, keys []string) (map[string][]byte, error) {
    g, ctx := errgroup.WithContext(ctx)
    results := make([][]byte, len(keys))

    // Limit concurrency using a semaphore
    sem := semaphore.New(10)

    for i, key := range keys {
        i, key := i, key

        if err := sem.Acquire(ctx); err != nil {
            break // Context cancelled
        }

        g.Go(func() error {
            defer sem.Release()

            data, err := fetchFromS3(ctx, key)
            if err != nil {
                return fmt.Errorf("fetch %s: %w", key, err)
            }
            results[i] = data
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }

    // Build result map
    m := make(map[string][]byte, len(keys))
    for i, key := range keys {
        if results[i] != nil {
            m[key] = results[i]
        }
    }
    return m, nil
}
```

## Context Propagation for Graceful Shutdown

Context cancellation is only effective if every blocking operation in the goroutine respects it. Common mistakes:

```go
// WRONG: context not passed to HTTP call
func fetchData(ctx context.Context, url string) ([]byte, error) {
    resp, err := http.Get(url)  // Ignores context - will not cancel
    // ...
}

// CORRECT: create request with context
func fetchData(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }
    resp, err := http.DefaultClient.Do(req)
    // ...
}

// WRONG: database query without context
func getUser(db *sql.DB, id int) (*User, error) {
    row := db.QueryRow("SELECT * FROM users WHERE id = $1", id)
    // ...
}

// CORRECT: pass context to database operations
func getUser(ctx context.Context, db *sql.DB, id int) (*User, error) {
    row := db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)
    // ...
}
```

### Graceful Shutdown with Multiple Components

```go
// cmd/server/main.go
func main() {
    // Root context cancelled on SIGTERM or SIGINT
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    // Create a WaitGroup to track all running components
    var wg sync.WaitGroup

    // Start HTTP server
    httpServer := &http.Server{Addr: ":8080", Handler: handler}
    wg.Add(1)
    go func() {
        defer wg.Done()
        if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
            log.Printf("HTTP server error: %v", err)
        }
    }()

    // Start worker pool
    workerCtx, workerCancel := context.WithCancel(ctx)
    defer workerCancel()
    wg.Add(1)
    go func() {
        defer wg.Done()
        runWorkers(workerCtx)
    }()

    // Start background job processor
    jobCtx, jobCancel := context.WithCancel(ctx)
    defer jobCancel()
    wg.Add(1)
    go func() {
        defer wg.Done()
        processJobs(jobCtx)
    }()

    // Wait for shutdown signal
    <-ctx.Done()
    log.Println("Shutdown signal received")

    // Graceful shutdown sequence:
    // 1. Stop accepting new requests
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    if err := httpServer.Shutdown(shutdownCtx); err != nil {
        log.Printf("HTTP server shutdown error: %v", err)
    }

    // 2. Cancel worker contexts (they'll finish current work and exit)
    workerCancel()
    jobCancel()

    // 3. Wait for all goroutines to finish
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        log.Println("Clean shutdown complete")
    case <-time.After(30 * time.Second):
        log.Println("Shutdown timed out, forcing exit")
    }
}
```

## Rate Limiting with Time/Rate

The `golang.org/x/time/rate` package provides a token bucket rate limiter that integrates with context:

```go
import "golang.org/x/time/rate"

// RateLimitedClient wraps an HTTP client with per-host rate limiting.
type RateLimitedClient struct {
    client   *http.Client
    limiters sync.Map  // map[string]*rate.Limiter
    rate     rate.Limit
    burst    int
}

func NewRateLimitedClient(reqPerSec float64, burst int) *RateLimitedClient {
    return &RateLimitedClient{
        client: &http.Client{Timeout: 30 * time.Second},
        rate:   rate.Limit(reqPerSec),
        burst:  burst,
    }
}

func (c *RateLimitedClient) limiterFor(host string) *rate.Limiter {
    v, _ := c.limiters.LoadOrStore(host, rate.NewLimiter(c.rate, c.burst))
    return v.(*rate.Limiter)
}

func (c *RateLimitedClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    limiter := c.limiterFor(req.URL.Host)

    if err := limiter.Wait(ctx); err != nil {
        return nil, fmt.Errorf("rate limit wait: %w", err)
    }

    return c.client.Do(req.WithContext(ctx))
}
```

## Goroutine Leak Detection with goleak

goleak detects goroutines that are still running after a test completes — the most reliable way to find goroutine leaks in development:

```bash
go get go.uber.org/goleak@v1.3.0
```

```go
// integration_test.go
package mypackage_test

import (
    "testing"
    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// Or per-test:
func TestSpecificThing(t *testing.T) {
    defer goleak.VerifyNone(t)

    // ... test code
    // goleak will fail the test if any goroutines started during the test
    // are still running at the end
}
```

Common goroutine leak patterns to fix:

```go
// LEAK: goroutine blocked on channel receive forever
func startWorker() {
    ch := make(chan int)
    go func() {
        v := <-ch  // If nobody sends on ch, this goroutine leaks
        use(v)
    }()
    // ch never sent to
}

// FIX: use context for cancellation
func startWorker(ctx context.Context) {
    ch := make(chan int)
    go func() {
        select {
        case v := <-ch:
            use(v)
        case <-ctx.Done():
            return  // Goroutine exits when context is cancelled
        }
    }()
}

// LEAK: goroutine blocked on time.Ticker forever
func startPoller() {
    ticker := time.NewTicker(time.Second)
    go func() {
        for range ticker.C {  // Runs forever
            poll()
        }
    }()
    // ticker.Stop() never called
}

// FIX: stop ticker on context cancellation
func startPoller(ctx context.Context) {
    ticker := time.NewTicker(time.Second)
    go func() {
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                poll()
            case <-ctx.Done():
                return
            }
        }
    }()
}

// LEAK: http.Response.Body not closed
func fetchData(ctx context.Context, url string) ([]byte, error) {
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    // If we return here without closing body, goroutine in transport leaks
    defer resp.Body.Close()  // MUST close body
    return io.ReadAll(resp.Body)
}
```

## Channel Direction for API Clarity

Always specify channel direction in function signatures:

```go
// UNCLEAR: caller doesn't know if they should send or receive
func processItems(ch chan Item) {}

// CLEAR: function only receives from channel
func processItems(ch <-chan Item) {}

// CLEAR: function only sends to channel
func generateItems(ch chan<- Item) {}

// Pattern: producer returns receive-only channel
func produce(ctx context.Context) <-chan Item {
    out := make(chan Item, 32)
    go func() {
        defer close(out)
        // generate items...
    }()
    return out  // Caller gets <-chan, cannot accidentally send
}

// Pattern: consumer accepts receive-only channel
func consume(ctx context.Context, in <-chan Item) error {
    for item := range in {
        if err := process(ctx, item); err != nil {
            return err
        }
    }
    return nil
}
```

## Avoiding Common Race Conditions

```go
// RACE: capturing loop variable
for _, item := range items {
    go func() {
        process(item)  // item is shared; race condition
    }()
}

// FIX 1: shadow the variable
for _, item := range items {
    item := item  // Creates new variable in each iteration
    go func() {
        process(item)
    }()
}

// FIX 2: pass as argument (clearer)
for _, item := range items {
    go func(item Item) {
        process(item)
    }(item)
}

// FIX 3: Go 1.22+ loop variable semantics (no longer shared)
// In Go 1.22+, loop variables are per-iteration by default
// But be explicit for clarity and compatibility

// RACE: shared slice written from multiple goroutines
results := []Result{}
for _, item := range items {
    item := item
    go func() {
        r := process(item)
        results = append(results, r)  // RACE: concurrent slice append
    }()
}

// FIX: use pre-allocated slice with index
results := make([]Result, len(items))
for i, item := range items {
    i, item := i, item
    go func() {
        results[i] = process(item)  // Safe: different indices
    }()
}
```

## Benchmarking Concurrency Patterns

```go
func BenchmarkSemaphoreVsPool(b *testing.B) {
    work := func(ctx context.Context, n int) (int, error) {
        time.Sleep(time.Microsecond) // Simulate work
        return n * 2, nil
    }

    b.Run("semaphore/10workers", func(b *testing.B) {
        sem := semaphore.New(10)
        ctx := context.Background()

        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if err := sem.Acquire(ctx); err != nil {
                    b.Fatal(err)
                }
                work(ctx, i)
                sem.Release()
                i++
            }
        })
    })

    b.Run("errgroup/10workers", func(b *testing.B) {
        ctx := context.Background()
        items := make([]int, b.N)
        for i := range items {
            items[i] = i
        }

        b.ResetTimer()
        g, ctx := errgroup.WithContext(ctx)
        sem := semaphore.New(10)

        for _, item := range items {
            item := item
            sem.Acquire(ctx)
            g.Go(func() error {
                defer sem.Release()
                _, err := work(ctx, item)
                return err
            })
        }
        g.Wait()
    })
}
```

## Key Takeaways

Production Go concurrency patterns require discipline in several areas:

1. **Always bound concurrency**: Unbounded goroutine creation is a production time bomb. Use semaphores, worker pools, or errgroup with semaphores to set explicit limits.
2. **Context must propagate everywhere**: Every blocking operation (HTTP, database, file I/O, channel operations with timeouts) must accept and respect context. Audit your code with `staticcheck`'s `SA1012` rule.
3. **Fan-in always needs merge**: When fanning out to multiple goroutines, the fan-in step must merge all output channels. A goroutine blocked trying to send to a full channel is a leak.
4. **goleak in TestMain catches leaks before production**: Run `goleak.VerifyTestMain` in every package with goroutines. Leaked goroutines in tests mean leaked goroutines in production.
5. **Channel direction in signatures documents intent**: `<-chan T` (receive-only) and `chan<- T` (send-only) make goroutine ownership clear at compile time.
6. **Loop variable capture changed in Go 1.22**: In Go 1.22+, loop variables are per-iteration. For pre-1.22 codebases, always shadow loop variables before starting goroutines.
7. **errgroup.WithContext cancels the group on first error**: This is usually what you want for parallel tasks where any failure makes the rest unnecessary. For cases where you want all results regardless of errors, use a different pattern.
