---
title: "Go Concurrency Patterns: Fan-Out, Fan-In, Pipeline, and Semaphore"
date: 2029-06-25T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Goroutines", "Channels", "errgroup", "Pipeline", "Worker Pool"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go concurrency patterns covering worker pool implementation, errgroup usage, bounded concurrency with semaphores, pipeline stages with context cancellation, and backpressure handling."
more_link: "yes"
url: "/go-concurrency-fanout-fanin-pipeline-semaphore/"
---

Go's concurrency model — goroutines and channels — is deceptively simple to misuse. The patterns that appear in tutorials work for toy examples but fail in production under load: goroutine leaks when channels are never closed, lost errors when goroutines panic, unbounded memory growth when producers outpace consumers. This guide covers the production-ready versions of the fundamental patterns: fan-out worker pools, fan-in aggregation, composable pipelines, semaphore-bounded concurrency, and backpressure mechanisms.

<!--more-->

# Go Concurrency Patterns: Fan-Out, Fan-In, Pipeline, and Semaphore

## Section 1: Foundation — Channel Axioms

Before the patterns, internalize these Go channel behaviors that determine correctness:

```go
// Sending to a closed channel: PANIC
// Receiving from a closed channel: returns zero value + false immediately
// Sending to nil channel: blocks forever
// Receiving from nil channel: blocks forever
// Closing a nil channel: PANIC
// Closing an already-closed channel: PANIC

// Rule: The SENDER closes the channel (not the receiver)
// Rule: Close channels only when no more sends will happen
// Rule: Use range over channel for clean close handling

// Correct pattern for pipeline stages:
func generator(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)  // Always close when done sending
        for _, n := range nums {
            out <- n
        }
    }()
    return out
}
```

---

## Section 2: Fan-Out — Worker Pool

Fan-out distributes work from one source to multiple workers. The classic implementation uses a fixed number of goroutines reading from a shared work channel.

### Basic Worker Pool

```go
package worker

import (
    "context"
    "fmt"
    "sync"
)

// Job represents a unit of work.
type Job[T, R any] struct {
    Input  T
    Result R
    Err    error
}

// Pool is a fixed-size worker pool.
type Pool[T, R any] struct {
    workers   int
    workFn    func(ctx context.Context, input T) (R, error)
    jobChan   chan Job[T, R]
    resultChan chan Job[T, R]
    wg        sync.WaitGroup
}

// NewPool creates a worker pool with the given number of workers.
func NewPool[T, R any](workers int, fn func(ctx context.Context, input T) (R, error)) *Pool[T, R] {
    return &Pool[T, R]{
        workers:    workers,
        workFn:     fn,
        jobChan:    make(chan Job[T, R], workers*2),
        resultChan: make(chan Job[T, R], workers*2),
    }
}

// Start launches workers and returns a channel to send jobs to and receive results from.
func (p *Pool[T, R]) Start(ctx context.Context) (send chan<- Job[T, R], recv <-chan Job[T, R]) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.worker(ctx)
    }

    // Close resultChan when all workers finish
    go func() {
        p.wg.Wait()
        close(p.resultChan)
    }()

    return p.jobChan, p.resultChan
}

func (p *Pool[T, R]) worker(ctx context.Context) {
    defer p.wg.Done()
    for job := range p.jobChan {
        // Check for cancellation before processing
        select {
        case <-ctx.Done():
            job.Err = ctx.Err()
            p.resultChan <- job
            continue
        default:
        }

        result, err := p.workFn(ctx, job.Input)
        job.Result = result
        job.Err = err
        p.resultChan <- job
    }
}

// Close signals no more work will be submitted.
func (p *Pool[T, R]) Close() {
    close(p.jobChan)
}

// ProcessBatch is a convenience function for batch processing.
func ProcessBatch[T, R any](
    ctx context.Context,
    inputs []T,
    workers int,
    fn func(ctx context.Context, input T) (R, error),
) ([]R, []error) {
    pool := NewPool(workers, fn)
    send, recv := pool.Start(ctx)

    // Send all inputs in a goroutine to avoid deadlock
    go func() {
        defer pool.Close()
        for _, input := range inputs {
            select {
            case send <- Job[T, R]{Input: input}:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Collect results
    results := make([]R, len(inputs))
    errs := make([]error, len(inputs))
    // Note: order is not preserved in this implementation
    i := 0
    for job := range recv {
        results[i] = job.Result
        errs[i] = job.Err
        i++
    }

    return results, errs
}
```

### Order-Preserving Worker Pool

```go
package worker

import (
    "context"
    "sync"
)

// OrderedPool processes items concurrently but delivers results in input order.
type OrderedPool[T, R any] struct {
    workers int
    fn      func(ctx context.Context, input T) (R, error)
}

type indexedInput[T any] struct {
    idx   int
    value T
}

type indexedResult[R any] struct {
    idx   int
    value R
    err   error
}

func NewOrderedPool[T, R any](workers int, fn func(ctx context.Context, input T) (R, error)) *OrderedPool[T, R] {
    return &OrderedPool[T, R]{workers: workers, fn: fn}
}

func (p *OrderedPool[T, R]) Process(ctx context.Context, inputs []T) ([]R, error) {
    work := make(chan indexedInput[T], p.workers)
    results := make(chan indexedResult[R], p.workers)

    // Launch workers
    var wg sync.WaitGroup
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range work {
                r, err := p.fn(ctx, item.value)
                results <- indexedResult[R]{idx: item.idx, value: r, err: err}
            }
        }()
    }

    // Close results channel when all workers finish
    go func() {
        wg.Wait()
        close(results)
    }()

    // Feed work
    go func() {
        defer close(work)
        for i, input := range inputs {
            select {
            case work <- indexedInput[T]{idx: i, value: input}:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Collect results in order
    out := make([]R, len(inputs))
    for r := range results {
        if r.err != nil {
            return nil, fmt.Errorf("item %d: %w", r.idx, r.err)
        }
        out[r.idx] = r.value
    }

    return out, ctx.Err()
}
```

---

## Section 3: errgroup — Concurrent Error Handling

`errgroup` from `golang.org/x/sync/errgroup` provides goroutine lifecycle management with error propagation and context cancellation.

### errgroup Patterns

```go
package concurrent

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/sync/errgroup"
)

// FetchMultiple fetches multiple URLs concurrently and returns all results.
// Fails fast: if any fetch fails, cancels remaining fetches.
func FetchMultiple(ctx context.Context, urls []string) ([][]byte, error) {
    g, ctx := errgroup.WithContext(ctx)
    results := make([][]byte, len(urls))

    for i, url := range urls {
        i, url := i, url  // Capture loop variables (not needed in Go 1.22+)
        g.Go(func() error {
            data, err := fetchURL(ctx, url)
            if err != nil {
                return fmt.Errorf("fetch %s: %w", url, err)
            }
            results[i] = data
            return nil
        })
    }

    // Wait returns the first non-nil error from any goroutine
    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}

// FetchMultipleWithLimit fetches URLs with bounded concurrency.
func FetchMultipleWithLimit(ctx context.Context, urls []string, limit int) ([][]byte, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(limit)  // Limit concurrent goroutines (Go 1.20+)

    results := make([][]byte, len(urls))
    for i, url := range urls {
        i, url := i, url
        g.Go(func() error {
            data, err := fetchURL(ctx, url)
            if err != nil {
                return fmt.Errorf("fetch %s: %w", url, err)
            }
            results[i] = data
            return nil
        })
    }

    return results, g.Wait()
}

// ParallelTasks runs independent tasks concurrently with timeout.
func ParallelTasks(ctx context.Context, timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    g, ctx := errgroup.WithContext(ctx)

    // Task 1: Database initialization
    g.Go(func() error {
        if err := initDatabase(ctx); err != nil {
            return fmt.Errorf("init database: %w", err)
        }
        return nil
    })

    // Task 2: Cache warming
    g.Go(func() error {
        if err := warmCache(ctx); err != nil {
            return fmt.Errorf("warm cache: %w", err)
        }
        return nil
    })

    // Task 3: External service health check
    g.Go(func() error {
        if err := checkExternalServices(ctx); err != nil {
            return fmt.Errorf("external services: %w", err)
        }
        return nil
    })

    return g.Wait()
}
```

### Collecting Multiple Errors

Standard `errgroup` returns the first error. For scenarios where you want all errors:

```go
package concurrent

import (
    "context"
    "fmt"
    "strings"
    "sync"
)

// MultiError collects multiple errors.
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
    msgs := make([]string, len(m.errs))
    for i, e := range m.errs {
        msgs[i] = e.Error()
    }
    return fmt.Errorf("%d error(s): %s", len(m.errs), strings.Join(msgs, "; "))
}

// RunAll runs all tasks and collects ALL errors (unlike errgroup which stops at first).
func RunAll(ctx context.Context, tasks []func(context.Context) error) error {
    var wg sync.WaitGroup
    var merr MultiError

    for _, task := range tasks {
        task := task
        wg.Add(1)
        go func() {
            defer wg.Done()
            merr.Add(task(ctx))
        }()
    }

    wg.Wait()
    return merr.Err()
}
```

---

## Section 4: Semaphore — Bounded Concurrency

A semaphore limits the number of concurrent operations. In Go, implement it with a buffered channel.

### Channel-Based Semaphore

```go
package semaphore

import (
    "context"
)

// Semaphore limits concurrent access using a buffered channel.
type Semaphore struct {
    ch chan struct{}
}

// New creates a semaphore with the given capacity.
func New(n int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire blocks until a slot is available or ctx is cancelled.
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryAcquire attempts to acquire without blocking.
func (s *Semaphore) TryAcquire() bool {
    select {
    case s.ch <- struct{}{}:
        return true
    default:
        return false
    }
}

// Release releases a slot.
func (s *Semaphore) Release() {
    <-s.ch
}

// Available returns the number of available slots.
func (s *Semaphore) Available() int {
    return cap(s.ch) - len(s.ch)
}
```

### Using golang.org/x/sync/semaphore

```go
package concurrent

import (
    "context"
    "fmt"
    "io"
    "os"

    "golang.org/x/sync/semaphore"
)

// ProcessFilesWithLimit processes files concurrently with bounded I/O.
func ProcessFilesWithLimit(ctx context.Context, files []string, maxConcurrent int64) error {
    sem := semaphore.NewWeighted(maxConcurrent)
    var wg sync.WaitGroup
    var merr MultiError

    for _, file := range files {
        file := file

        // Acquire before launching goroutine
        if err := sem.Acquire(ctx, 1); err != nil {
            return fmt.Errorf("context cancelled: %w", err)
        }

        wg.Add(1)
        go func() {
            defer wg.Done()
            defer sem.Release(1)

            if err := processFile(ctx, file); err != nil {
                merr.Add(fmt.Errorf("process %s: %w", file, err))
            }
        }()
    }

    wg.Wait()
    return merr.Err()
}

// Weighted semaphore: allocate more weight to expensive operations
func processWithWeightedSemaphore(ctx context.Context, items []WorkItem) error {
    // Total weight budget
    const totalWeight = 100
    sem := semaphore.NewWeighted(totalWeight)

    var wg sync.WaitGroup

    for _, item := range items {
        item := item
        weight := int64(item.ExpectedCPUWeight) // Each item declares its weight

        if err := sem.Acquire(ctx, weight); err != nil {
            return err
        }

        wg.Add(1)
        go func() {
            defer wg.Done()
            defer sem.Release(weight)
            item.Process(ctx)
        }()
    }

    wg.Wait()
    return nil
}
```

---

## Section 5: Pipeline with Context Cancellation

A pipeline chains operations where each stage reads from an upstream channel and writes to a downstream channel. Context cancellation must propagate through every stage.

```go
package pipeline

import (
    "context"
    "fmt"
)

// Stage is a function that reads from in and writes to out.
// It must respect context cancellation.
// It must close out when done.
type StageFn[T, U any] func(ctx context.Context, in <-chan T) <-chan U

// Chain links multiple stages together.
func Chain[T any](ctx context.Context, in <-chan T, stages ...interface{}) <-chan interface{} {
    // Note: fully type-safe chaining is hard with Go generics due to method constraints
    // This is a simplified version; see typed pipeline in section below
    panic("use typed pipeline functions")
}

// ReadAll collects all values from a channel into a slice.
// Returns an error if the context is cancelled.
func ReadAll[T any](ctx context.Context, in <-chan T) ([]T, error) {
    var result []T
    for {
        select {
        case v, ok := <-in:
            if !ok {
                return result, nil
            }
            result = append(result, v)
        case <-ctx.Done():
            return result, ctx.Err()
        }
    }
}

// Generate creates a channel that emits all values from the slice.
func Generate[T any](ctx context.Context, values []T) <-chan T {
    out := make(chan T, len(values))
    go func() {
        defer close(out)
        for _, v := range values {
            select {
            case out <- v:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Map applies fn to each element from in and sends results to a new channel.
func Map[T, U any](ctx context.Context, in <-chan T, fn func(T) (U, error)) (<-chan U, <-chan error) {
    out := make(chan U)
    errc := make(chan error, 1)

    go func() {
        defer close(out)
        defer close(errc)
        for v := range in {
            u, err := fn(v)
            if err != nil {
                errc <- err
                return
            }
            select {
            case out <- u:
            case <-ctx.Done():
                errc <- ctx.Err()
                return
            }
        }
    }()

    return out, errc
}

// Filter passes elements that satisfy pred.
func Filter[T any](ctx context.Context, in <-chan T, pred func(T) bool) <-chan T {
    out := make(chan T)
    go func() {
        defer close(out)
        for v := range in {
            if pred(v) {
                select {
                case out <- v:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()
    return out
}

// Batch groups items into fixed-size batches.
func Batch[T any](ctx context.Context, in <-chan T, size int) <-chan []T {
    out := make(chan []T)
    go func() {
        defer close(out)
        batch := make([]T, 0, size)
        for v := range in {
            batch = append(batch, v)
            if len(batch) == size {
                select {
                case out <- batch:
                case <-ctx.Done():
                    return
                }
                batch = make([]T, 0, size)
            }
        }
        // Send remaining items
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

### Complete Pipeline Example

```go
package main

import (
    "context"
    "fmt"
    "strings"
    "time"
)

type Record struct {
    ID      int
    Content string
}

type ProcessedRecord struct {
    ID       int
    Words    []string
    WordCount int
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Stage 1: Generate records
    records := []Record{
        {1, "hello world foo"},
        {2, "bar baz qux"},
        {3, "go concurrency patterns"},
    }
    recordChan := Generate(ctx, records)

    // Stage 2: Filter empty content
    filtered := Filter(ctx, recordChan, func(r Record) bool {
        return strings.TrimSpace(r.Content) != ""
    })

    // Stage 3: Process (parse words)
    processed, errc := Map(ctx, filtered, func(r Record) (ProcessedRecord, error) {
        words := strings.Fields(r.Content)
        return ProcessedRecord{
            ID:        r.ID,
            Words:     words,
            WordCount: len(words),
        }, nil
    })

    // Stage 4: Batch for bulk operations
    batches := Batch(ctx, processed, 10)

    // Consume
    errReceived := false
    for {
        select {
        case batch, ok := <-batches:
            if !ok {
                if !errReceived {
                    fmt.Println("Pipeline complete")
                }
                return
            }
            for _, item := range batch {
                fmt.Printf("ID=%d words=%d\n", item.ID, item.WordCount)
            }
        case err := <-errc:
            if err != nil {
                fmt.Printf("Pipeline error: %v\n", err)
                errReceived = true
                cancel()
            }
        }
    }
}
```

---

## Section 6: Fan-In — Merging Multiple Channels

Fan-in merges multiple input channels into one output channel.

```go
package fanin

import (
    "context"
    "sync"
)

// Merge combines multiple input channels into a single output channel.
// The output channel is closed when all inputs are closed.
func Merge[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    var wg sync.WaitGroup
    merged := make(chan T, len(inputs))

    output := func(c <-chan T) {
        defer wg.Done()
        for v := range c {
            select {
            case merged <- v:
            case <-ctx.Done():
                return
            }
        }
    }

    wg.Add(len(inputs))
    for _, in := range inputs {
        go output(in)
    }

    // Close merged when all inputs are done
    go func() {
        wg.Wait()
        close(merged)
    }()

    return merged
}

// FirstResult returns the first result from multiple concurrent operations.
// Cancels remaining operations once one succeeds.
func FirstResult[T any](ctx context.Context, fns []func(context.Context) (T, error)) (T, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    resultCh := make(chan T, 1)
    errCh := make(chan error, len(fns))

    for _, fn := range fns {
        fn := fn
        go func() {
            result, err := fn(ctx)
            if err != nil {
                errCh <- err
                return
            }
            select {
            case resultCh <- result:
                cancel()  // Cancel others
            default:
                // Another result already received
            }
        }()
    }

    select {
    case result := <-resultCh:
        return result, nil
    case err := <-errCh:
        var zero T
        return zero, err
    case <-ctx.Done():
        var zero T
        return zero, ctx.Err()
    }
}
```

---

## Section 7: Backpressure

Backpressure prevents a fast producer from overwhelming a slow consumer. This is critical for any system that processes streams of data.

```go
package backpressure

import (
    "context"
    "time"
)

// ThrottledProducer wraps a channel with backpressure.
// If the consumer can't keep up, the producer slows down rather than accumulating.
type ThrottledProducer[T any] struct {
    out      chan T
    maxQueue int
}

func NewThrottledProducer[T any](maxQueue int) *ThrottledProducer[T] {
    return &ThrottledProducer[T]{
        out:      make(chan T, maxQueue),
        maxQueue: maxQueue,
    }
}

// Send sends a value, blocking if the queue is full.
// Returns false if context is cancelled.
func (p *ThrottledProducer[T]) Send(ctx context.Context, v T) bool {
    select {
    case p.out <- v:
        return true
    case <-ctx.Done():
        return false
    }
}

// TrySend attempts to send without blocking.
// Returns false if queue is full (drop the item or handle upstream).
func (p *ThrottledProducer[T]) TrySend(v T) bool {
    select {
    case p.out <- v:
        return true
    default:
        return false
    }
}

// Chan returns the read-only output channel.
func (p *ThrottledProducer[T]) Chan() <-chan T {
    return p.out
}

// Close signals no more items.
func (p *ThrottledProducer[T]) Close() {
    close(p.out)
}

// BufferedQueue with overflow handling strategies
type OverflowStrategy int

const (
    OverflowDrop    OverflowStrategy = iota // Drop newest item
    OverflowDropOld                          // Drop oldest item (ring buffer behavior)
    OverflowBlock                            // Block producer (traditional backpressure)
)

type Queue[T any] struct {
    ch       chan T
    strategy OverflowStrategy
}

func NewQueue[T any](size int, strategy OverflowStrategy) *Queue[T] {
    return &Queue[T]{
        ch:       make(chan T, size),
        strategy: strategy,
    }
}

func (q *Queue[T]) Enqueue(ctx context.Context, item T) bool {
    switch q.strategy {
    case OverflowDrop:
        select {
        case q.ch <- item:
            return true
        default:
            return false // Drop
        }
    case OverflowDropOld:
        for {
            select {
            case q.ch <- item:
                return true
            default:
                // Drain one old item
                select {
                case <-q.ch:
                default:
                }
            }
        }
    case OverflowBlock:
        select {
        case q.ch <- item:
            return true
        case <-ctx.Done():
            return false
        }
    }
    return false
}
```

---

## Section 8: Rate-Limited Worker Pool

Combining a worker pool with a rate limiter for API calls:

```go
package ratelimited

import (
    "context"
    "fmt"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// RateLimitedPool is a worker pool with rate limiting.
type RateLimitedPool[T, R any] struct {
    workers int
    limiter *rate.Limiter
    fn      func(ctx context.Context, input T) (R, error)
}

func NewRateLimitedPool[T, R any](
    workers int,
    rps float64,
    burst int,
    fn func(ctx context.Context, input T) (R, error),
) *RateLimitedPool[T, R] {
    return &RateLimitedPool[T, R]{
        workers: workers,
        limiter: rate.NewLimiter(rate.Limit(rps), burst),
        fn:      fn,
    }
}

func (p *RateLimitedPool[T, R]) Process(ctx context.Context, inputs []T) ([]R, []error) {
    type indexedResult struct {
        idx int
        val R
        err error
    }

    work := make(chan struct {
        idx   int
        value T
    }, p.workers)

    results := make(chan indexedResult, p.workers)

    var wg sync.WaitGroup
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range work {
                // Wait for rate limiter token
                if err := p.limiter.Wait(ctx); err != nil {
                    results <- indexedResult{idx: item.idx, err: err}
                    continue
                }

                val, err := p.fn(ctx, item.value)
                results <- indexedResult{idx: item.idx, val: val, err: err}
            }
        }()
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    go func() {
        defer close(work)
        for i, input := range inputs {
            select {
            case work <- struct {
                idx   int
                value T
            }{i, input}:
            case <-ctx.Done():
                return
            }
        }
    }()

    out := make([]R, len(inputs))
    errs := make([]error, len(inputs))
    for r := range results {
        out[r.idx] = r.val
        errs[r.idx] = r.err
    }

    return out, errs
}
```

---

## Section 9: Goroutine Leak Detection

```go
package testing

import (
    "runtime"
    "testing"
    "time"
)

// GoroutineLeakChecker detects goroutine leaks in tests.
type GoroutineLeakChecker struct {
    before int
}

// Before records the goroutine count before a test.
func (c *GoroutineLeakChecker) Before() {
    // Allow goroutines from previous tests to finish
    runtime.Gosched()
    time.Sleep(10 * time.Millisecond)
    c.before = runtime.NumGoroutine()
}

// After checks that no goroutines were leaked.
func (c *GoroutineLeakChecker) After(t *testing.T) {
    t.Helper()

    // Give goroutines time to finish
    deadline := time.Now().Add(5 * time.Second)
    for {
        current := runtime.NumGoroutine()
        if current <= c.before {
            return
        }
        if time.Now().After(deadline) {
            t.Errorf("goroutine leak: before=%d after=%d (leaked %d)",
                c.before, current, current-c.before)
            // Print goroutine stacks for debugging
            buf := make([]byte, 64<<10)
            n := runtime.Stack(buf, true)
            t.Logf("goroutine dump:\n%s", buf[:n])
            return
        }
        runtime.Gosched()
        time.Sleep(10 * time.Millisecond)
    }
}

// Usage:
func TestMyWorkerPool(t *testing.T) {
    var checker GoroutineLeakChecker
    checker.Before()
    defer checker.After(t)

    // ... test code ...
}
```

The fundamental discipline in Go concurrency is resource ownership: every goroutine must have a clear owner responsible for its lifecycle, every channel must have a clear owner responsible for closing it, and context cancellation must be propagated to every blocking operation. These constraints, once internalized, make the patterns in this guide natural and the bugs they prevent obvious.
