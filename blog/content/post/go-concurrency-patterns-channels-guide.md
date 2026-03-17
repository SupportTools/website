---
title: "Go Concurrency Patterns: Channels, Context, and Production-Safe Design"
date: 2028-02-25T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Channels", "Context", "Goroutines", "Production"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Go concurrency: channel directionality, fan-out/fan-in pipelines, errgroup, context propagation, goroutine leak detection with goleak, semaphore patterns, and bounded worker pools."
more_link: "yes"
url: "/go-concurrency-patterns-channels-guide/"
---

Go's concurrency model—goroutines, channels, and the `sync` package—is powerful but requires disciplined patterns to avoid goroutine leaks, race conditions, and deadlocks in production systems. This guide covers the full spectrum of production-safe concurrency design: channel directionality contracts, pipeline construction, fan-out/fan-in multiplexing, the `errgroup` package for parallel work with error propagation, proper context cancellation, goroutine leak detection, semaphore-based rate limiting, and bounded worker pools. Each pattern includes complete, runnable code and notes on where it fails if applied incorrectly.

<!--more-->

## Channel Fundamentals and Directionality

Go channels carry type information and directionality. Directionality constrains how a channel can be used within a function, creating compile-time contracts that prevent misuse.

```go
// Bidirectional channel (declared in caller)
ch := make(chan int, 10)

// Send-only channel (passed to producers)
func produce(ch chan<- int) {
    ch <- 42
    // ch <- ... is legal
    // <-ch is compile error: invalid operation
    // close(ch) is legal (senders own close)
}

// Receive-only channel (passed to consumers)
func consume(ch <-chan int) {
    v := <-ch
    fmt.Println(v)
    // ch <- 42 is compile error
    // close(ch) is compile error (receivers cannot close)
}
```

The rule: **only the goroutine that creates a channel should close it**. Never close a channel from the receiver side. Use directionality to enforce this at compile time.

### Nil Channel Behavior

A nil channel blocks forever on both send and receive. This is useful in select statements to disable a case:

```go
func mergeWithControl(a, b <-chan int, stopB bool) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        chB := b
        if stopB {
            chB = nil // Disable the b case in select
        }
        for {
            select {
            case v, ok := <-a:
                if !ok {
                    a = nil
                }
                if a == nil && chB == nil {
                    return
                }
                out <- v
            case v, ok := <-chB:
                if !ok {
                    chB = nil
                }
                if a == nil && chB == nil {
                    return
                }
                out <- v
            }
        }
    }()
    return out
}
```

## Pipeline Stages

Pipelines connect processing stages through channels. Each stage receives from an input channel and sends to an output channel, enabling concurrent, streaming data processing.

```go
package pipeline

import (
    "context"
    "strconv"
)

// Stage 1: Generate integers
func generate(ctx context.Context, nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            select {
            case <-ctx.Done():
                return
            case out <- n:
            }
        }
    }()
    return out
}

// Stage 2: Square values
func square(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            select {
            case <-ctx.Done():
                return
            case out <- n * n:
            }
        }
    }()
    return out
}

// Stage 3: Format to string
func format(ctx context.Context, in <-chan int) <-chan string {
    out := make(chan string)
    go func() {
        defer close(out)
        for n := range in {
            select {
            case <-ctx.Done():
                return
            case out <- strconv.Itoa(n):
            }
        }
    }()
    return out
}

// Compose the pipeline
func RunPipeline(ctx context.Context, nums ...int) <-chan string {
    return format(ctx, square(ctx, generate(ctx, nums...)))
}
```

Context propagation through every stage ensures that cancellation at any point in the pipeline drains correctly without goroutine leaks.

## Fan-Out and Fan-In

Fan-out distributes work from one channel to multiple goroutines. Fan-in multiplexes multiple channels into one.

```go
package fanout

import (
    "context"
    "sync"
)

// fanOut distributes input to n workers, each producing an output channel
func fanOut(ctx context.Context, input <-chan int, n int, worker func(context.Context, int) int) []<-chan int {
    outputs := make([]<-chan int, n)
    for i := 0; i < n; i++ {
        ch := make(chan int)
        outputs[i] = ch
        go func(out chan<- int) {
            defer close(out)
            for v := range input {
                select {
                case <-ctx.Done():
                    return
                case out <- worker(ctx, v):
                }
            }
        }(ch)
    }
    return outputs
}

// fanIn merges multiple input channels into a single output channel
func fanIn(ctx context.Context, inputs ...<-chan int) <-chan int {
    out := make(chan int)
    var wg sync.WaitGroup
    wg.Add(len(inputs))

    for _, ch := range inputs {
        ch := ch // capture loop variable
        go func() {
            defer wg.Done()
            for v := range ch {
                select {
                case <-ctx.Done():
                    return
                case out <- v:
                }
            }
        }()
    }

    go func() {
        wg.Wait()
        close(out)
    }()
    return out
}

// ProcessConcurrently fans out to n workers and collects results
func ProcessConcurrently(ctx context.Context, input <-chan int, n int) <-chan int {
    worker := func(ctx context.Context, v int) int {
        return v * v // Replace with actual expensive computation
    }
    outputs := fanOut(ctx, input, n, worker)
    return fanIn(ctx, outputs...)
}
```

The critical detail: the fan-in goroutine waits on `wg.Wait()` in its own goroutine, then closes `out`. Without this, the `close(out)` would happen in the goroutine that called `fanIn`, before all forwarder goroutines have finished.

## Done Channel Pattern

The done channel pattern signals all goroutines in a tree to stop. This predates `context.Context` but is still useful for custom cancellation scenarios.

```go
package done

import "sync"

type WorkGroup struct {
    done chan struct{}
    once sync.Once
    wg   sync.WaitGroup
}

func NewWorkGroup() *WorkGroup {
    return &WorkGroup{done: make(chan struct{})}
}

func (wg *WorkGroup) Done() <-chan struct{} {
    return wg.done
}

func (wg *WorkGroup) Cancel() {
    wg.once.Do(func() {
        close(wg.done)
    })
}

func (wg *WorkGroup) Go(f func(<-chan struct{})) {
    wg.wg.Add(1)
    go func() {
        defer wg.wg.Done()
        f(wg.done)
    }()
}

func (wg *WorkGroup) Wait() {
    wg.wg.Wait()
}

// Usage
func ExampleWorkGroup() {
    g := NewWorkGroup()

    g.Go(func(done <-chan struct{}) {
        for {
            select {
            case <-done:
                return
            default:
                // do work
            }
        }
    })

    g.Cancel()
    g.Wait()
}
```

In modern Go code, `context.Context` has replaced most uses of done channels, but the pattern is valuable for understanding the mechanics.

## errgroup for Parallel Work with Error Propagation

`golang.org/x/sync/errgroup` solves the common problem of running multiple goroutines, collecting the first error, and canceling the rest.

```go
package parallel

import (
    "context"
    "fmt"
    "net/http"

    "golang.org/x/sync/errgroup"
)

type URLResult struct {
    URL        string
    StatusCode int
}

// FetchURLs fetches multiple URLs concurrently, returning on first error
func FetchURLs(ctx context.Context, urls []string) ([]URLResult, error) {
    g, ctx := errgroup.WithContext(ctx)
    results := make([]URLResult, len(urls))

    for i, url := range urls {
        i, url := i, url // capture loop variables
        g.Go(func() error {
            req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
            if err != nil {
                return fmt.Errorf("creating request for %s: %w", url, err)
            }
            resp, err := http.DefaultClient.Do(req)
            if err != nil {
                return fmt.Errorf("fetching %s: %w", url, err)
            }
            defer resp.Body.Close()
            results[i] = URLResult{URL: url, StatusCode: resp.StatusCode}
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}

// FetchURLsWithLimit limits concurrency using errgroup with semaphore
func FetchURLsWithLimit(ctx context.Context, urls []string, limit int) ([]URLResult, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(limit) // Available in errgroup v0.8.0+

    results := make([]URLResult, len(urls))
    for i, url := range urls {
        i, url := i, url
        g.Go(func() error {
            req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
            if err != nil {
                return err
            }
            resp, err := http.DefaultClient.Do(req)
            if err != nil {
                return err
            }
            defer resp.Body.Close()
            results[i] = URLResult{URL: url, StatusCode: resp.StatusCode}
            return nil
        })
    }
    return results, g.Wait()
}
```

The `errgroup.WithContext` pattern automatically cancels the derived context when the first error occurs. All goroutines that check `ctx.Done()` will receive the cancellation signal.

## Context Propagation and Cancellation

Context must flow through every function that does I/O or blocking work. Never store context in a struct field for general use—pass it as the first parameter.

```go
package ctxpropagation

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"
)

type Repository struct {
    db *sql.DB
}

// Correct: context flows through every layer
func (r *Repository) GetUser(ctx context.Context, id int64) (*User, error) {
    // Deadline propagates to DB query
    row := r.db.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE id = $1", id)

    var u User
    if err := row.Scan(&u.ID, &u.Name, &u.Email); err != nil {
        return nil, fmt.Errorf("scanning user %d: %w", id, err)
    }
    return &u, nil
}

// Context with timeout for external calls
func FetchWithTimeout(ctx context.Context, fetch func(context.Context) error) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel() // Always defer cancel to release resources

    return fetch(ctx)
}

// Context values: only for request-scoped metadata, not business logic
type contextKey string

const (
    requestIDKey contextKey = "request_id"
    traceIDKey   contextKey = "trace_id"
)

func WithRequestID(ctx context.Context, requestID string) context.Context {
    return context.WithValue(ctx, requestIDKey, requestID)
}

func RequestIDFromContext(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(requestIDKey).(string)
    return id, ok
}

// Middleware example: inject request ID and add to logger
func RequestMiddleware(next func(ctx context.Context) error) func(ctx context.Context) error {
    return func(ctx context.Context) error {
        reqID := generateRequestID()
        ctx = WithRequestID(ctx, reqID)
        slog.InfoContext(ctx, "request started", "request_id", reqID)
        err := next(ctx)
        if err != nil {
            slog.ErrorContext(ctx, "request failed", "request_id", reqID, "error", err)
        }
        return err
    }
}

func generateRequestID() string {
    return fmt.Sprintf("%d", time.Now().UnixNano())
}

type User struct {
    ID    int64
    Name  string
    Email string
}
```

### Checking Context in Long Loops

```go
func processLargeDataset(ctx context.Context, items []Item) error {
    for i, item := range items {
        // Check context every iteration for correctness, or every N iterations for performance
        if i%100 == 0 {
            select {
            case <-ctx.Done():
                return fmt.Errorf("processing cancelled after %d items: %w", i, ctx.Err())
            default:
            }
        }
        if err := processItem(ctx, item); err != nil {
            return fmt.Errorf("item %d: %w", i, err)
        }
    }
    return nil
}

type Item struct{ ID int }

func processItem(ctx context.Context, item Item) error { return nil }
```

## Goroutine Leak Detection with goleak

Goroutine leaks are silent: the program continues running but memory and CPU usage grow over time. `go.uber.org/goleak` detects leaks in tests.

```go
package leaktest_test

import (
    "context"
    "testing"
    "time"

    "go.uber.org/goleak"
)

// Example of a leaking function
func leakingFetch(url string) <-chan string {
    ch := make(chan string)
    go func() {
        time.Sleep(10 * time.Second) // Simulates slow operation
        ch <- "result"               // Blocks if caller doesn't read
    }()
    return ch
}

// Test catches the leak
func TestLeakingFetch(t *testing.T) {
    defer goleak.VerifyNone(t,
        goleak.IgnoreCurrentGoroutines(), // Baseline from test setup
    )

    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    ch := leakingFetch("http://example.com")
    select {
    case <-ctx.Done():
        // Test exits here, goroutine in leakingFetch is left running
        t.Log("timeout, returning without reading channel")
    case result := <-ch:
        t.Log(result)
    }
    // goleak.VerifyNone will fail because the goroutine in leakingFetch is still running
}

// Fixed version: pass context to allow cancellation
func safeFetch(ctx context.Context, url string) <-chan string {
    ch := make(chan string, 1) // Buffered: goroutine can always send
    go func() {
        select {
        case <-ctx.Done():
            return // Goroutine exits when context is cancelled
        case <-time.After(10 * time.Second):
            ch <- "result"
        }
    }()
    return ch
}

func TestSafeFetch(t *testing.T) {
    defer goleak.VerifyNone(t)

    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    ch := safeFetch(ctx, "http://example.com")
    select {
    case <-ctx.Done():
        t.Log("timeout, goroutine will clean up via context")
    case result := <-ch:
        t.Log(result)
    }
    // Allow goroutine to exit
    time.Sleep(10 * time.Millisecond)
}
```

### Common Leak Patterns

```go
// LEAK: goroutine blocked on unbuffered channel send when receiver exits
func leakPattern1() {
    ch := make(chan int)
    go func() {
        ch <- 1 // Blocks forever if nobody reads
    }()
    // Function returns, nobody reads ch
}

// FIX: use buffered channel or ensure receiver reads
func fixedPattern1() {
    ch := make(chan int, 1) // Buffered: goroutine completes immediately
    go func() {
        ch <- 1
    }()
}

// LEAK: goroutine blocked on channel receive when sender exits
func leakPattern2() <-chan int {
    ch := make(chan int)
    go func() {
        v := <-ch // Blocks forever if nobody sends
        _ = v
    }()
    return ch // Caller may never send
}

// FIX: pass done/context channel
func fixedPattern2(ctx context.Context) <-chan int {
    ch := make(chan int)
    go func() {
        select {
        case <-ctx.Done():
            return
        case v := <-ch:
            _ = v
        }
    }()
    return ch
}
```

## Semaphore Pattern for Rate Limiting

A semaphore limits concurrent access to a resource. In Go, a buffered channel serves as a counting semaphore.

```go
package semaphore

import (
    "context"
    "fmt"
)

type Semaphore struct {
    ch chan struct{}
}

func New(n int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire blocks until a slot is available or context is cancelled
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("semaphore acquire cancelled: %w", ctx.Err())
    }
}

// Release frees a slot
func (s *Semaphore) Release() {
    <-s.ch
}

// TryAcquire returns immediately without blocking
func (s *Semaphore) TryAcquire() bool {
    select {
    case s.ch <- struct{}{}:
        return true
    default:
        return false
    }
}

// Usage: limit concurrent database connections
type DBPool struct {
    sem *Semaphore
}

func NewDBPool(maxConcurrency int) *DBPool {
    return &DBPool{sem: New(maxConcurrency)}
}

func (p *DBPool) Query(ctx context.Context, query string) ([]byte, error) {
    if err := p.sem.Acquire(ctx); err != nil {
        return nil, fmt.Errorf("waiting for db slot: %w", err)
    }
    defer p.sem.Release()

    // Execute query with bounded concurrency
    _ = query
    return nil, nil
}
```

For production use, `golang.org/x/sync/semaphore` provides a weighted semaphore with `Acquire(ctx, n)` support, useful when different operations consume different amounts of a shared resource.

```go
import "golang.org/x/sync/semaphore"

var sem = semaphore.NewWeighted(100) // 100 units total

func heavyOperation(ctx context.Context) error {
    // This operation consumes 10 units
    if err := sem.Acquire(ctx, 10); err != nil {
        return err
    }
    defer sem.Release(10)
    return nil
}

func lightOperation(ctx context.Context) error {
    // This operation consumes 1 unit
    if err := sem.Acquire(ctx, 1); err != nil {
        return err
    }
    defer sem.Release(1)
    return nil
}
```

## Bounded Worker Pool

A worker pool limits the number of concurrent goroutines processing a job queue. This is the most common pattern for CPU-bound or I/O-bound batch processing.

```go
package workerpool

import (
    "context"
    "fmt"
    "sync"
)

type Job[T any, R any] struct {
    ID      int
    Payload T
}

type Result[T any, R any] struct {
    Job    Job[T, R]
    Output R
    Err    error
}

type WorkerPool[T any, R any] struct {
    workers   int
    processor func(context.Context, T) (R, error)
}

func New[T any, R any](workers int, fn func(context.Context, T) (R, error)) *WorkerPool[T, R] {
    return &WorkerPool[T, R]{
        workers:   workers,
        processor: fn,
    }
}

func (p *WorkerPool[T, R]) Process(
    ctx context.Context,
    jobs []Job[T, R],
) ([]Result[T, R], error) {
    jobCh := make(chan Job[T, R], len(jobs))
    resultCh := make(chan Result[T, R], len(jobs))

    // Start workers
    var wg sync.WaitGroup
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobCh {
                output, err := p.processor(ctx, job.Payload)
                select {
                case resultCh <- Result[T, R]{Job: job, Output: output, Err: err}:
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    // Send jobs
    for _, job := range jobs {
        select {
        case jobCh <- job:
        case <-ctx.Done():
            close(jobCh)
            wg.Wait()
            close(resultCh)
            return nil, fmt.Errorf("job submission cancelled: %w", ctx.Err())
        }
    }
    close(jobCh)

    // Wait for workers, then close results
    go func() {
        wg.Wait()
        close(resultCh)
    }()

    // Collect results
    var results []Result[T, R]
    for r := range resultCh {
        results = append(results, r)
    }
    return results, nil
}
```

### Streaming Worker Pool (unbounded input)

For streaming input where all jobs are not known in advance:

```go
package streampool

import (
    "context"
    "sync"
)

type StreamPool struct {
    workers int
    wg      sync.WaitGroup
    jobCh   chan func(context.Context)
}

func New(ctx context.Context, workers int) *StreamPool {
    p := &StreamPool{
        workers: workers,
        jobCh:   make(chan func(context.Context), workers*2),
    }
    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for fn := range p.jobCh {
                if ctx.Err() != nil {
                    return
                }
                fn(ctx)
            }
        }()
    }
    return p
}

func (p *StreamPool) Submit(fn func(context.Context)) {
    p.jobCh <- fn
}

func (p *StreamPool) Close() {
    close(p.jobCh)
    p.wg.Wait()
}
```

## Race Condition Detection

Always run tests with the race detector in CI:

```bash
go test -race ./...
go test -race -count=3 ./internal/... # Run 3 times to increase detection probability
```

The race detector adds ~5-10x overhead but catches data races that are otherwise intermittent in production.

```go
// Example of a data race
type Counter struct {
    value int // No mutex: race condition
}

func (c *Counter) Increment() {
    c.value++ // Not atomic: read-modify-write is three operations
}

// Fixed: use atomic operations for simple counters
import "sync/atomic"

type AtomicCounter struct {
    value atomic.Int64
}

func (c *AtomicCounter) Increment() {
    c.value.Add(1)
}

func (c *AtomicCounter) Load() int64 {
    return c.value.Load()
}

// Fixed: use mutex for complex state
import "sync"

type SafeCache struct {
    mu    sync.RWMutex
    items map[string]string
}

func (c *SafeCache) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = value
}

func (c *SafeCache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.items[key]
    return v, ok
}
```

## Production Patterns Summary

The following table summarizes pattern selection criteria:

| Scenario | Pattern | Key Consideration |
|---|---|---|
| CPU-bound parallel work | Bounded worker pool | Set `workers = runtime.NumCPU()` |
| I/O-bound parallel work | errgroup with limit | Set limit based on connection pool size |
| Stream processing | Pipeline with context | Every stage must respect `ctx.Done()` |
| Rate limiting | Weighted semaphore | Match weight to resource cost |
| Event broadcasting | Fan-out | Ensure all receivers drain or use buffering |
| Result aggregation | Fan-in | Use WaitGroup to close output channel |
| Cancellation hierarchy | context.WithCancel | Always `defer cancel()` |
| Deadline propagation | context.WithTimeout | Derive from parent context |

Every goroutine launched in production code must have a documented exit condition. If a goroutine can run forever, it must be tied to a context, a done channel, or a lifecycle signal. Untethered goroutines are the primary source of memory leaks in long-running Go services.
