---
title: "Go Concurrency Patterns: Worker Pools, Rate Limiting, and Backpressure"
date: 2027-07-23T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Goroutines", "Performance", "Production"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Go concurrency patterns including worker pools, semaphore-based limiting, token bucket rate limiting, pipeline fan-out/fan-in, errgroup, context cancellation, goroutine leak detection, sync.Pool, and backpressure with buffered channels."
more_link: "yes"
url: "/go-concurrency-patterns-production-guide/"
---

Go's concurrency primitives — goroutines and channels — are lightweight and composable, but they do not prevent the most common production failure modes: goroutine leaks, unbounded concurrency, missing backpressure, and improperly propagated cancellations. This guide systematically covers the patterns that keep concurrent Go services well-behaved under production load.

<!--more-->

# [Go Concurrency Patterns](#go-concurrency-patterns)

## Section 1: The Worker Pool Pattern

The worker pool is the most universally applicable concurrency pattern in Go. A fixed number of goroutines consume work from a shared channel, bounding the concurrent processing to a controllable number regardless of input volume.

### Basic Implementation

```go
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

type Result[T any] struct {
    Input  T
    Output any
    Err    error
}

// Pool manages a fixed number of worker goroutines.
type Pool[T any] struct {
    work    chan Task[T]
    wg      sync.WaitGroup
    handler func(context.Context, T) (any, error)
}

// New creates a pool with n workers. The pool is ready immediately.
func New[T any](ctx context.Context, n int, handler func(context.Context, T) (any, error)) *Pool[T] {
    p := &Pool[T]{
        work:    make(chan Task[T], n*2), // Buffer 2x workers to smooth bursts.
        handler: handler,
    }
    for i := 0; i < n; i++ {
        p.wg.Add(1)
        go p.worker(ctx)
    }
    return p
}

func (p *Pool[T]) worker(ctx context.Context) {
    defer p.wg.Done()
    for {
        select {
        case <-ctx.Done():
            return
        case task, ok := <-p.work:
            if !ok {
                return
            }
            out, err := p.handler(ctx, task.Input)
            if task.Result != nil {
                task.Result <- Result[T]{Input: task.Input, Output: out, Err: err}
            }
        }
    }
}

// Submit enqueues work. Blocks when the channel is full (natural backpressure).
func (p *Pool[T]) Submit(task Task[T]) {
    p.work <- task
}

// TrySubmit returns false immediately if the channel is full.
func (p *Pool[T]) TrySubmit(task Task[T]) bool {
    select {
    case p.work <- task:
        return true
    default:
        return false
    }
}

// Close signals workers to stop after draining the queue. Waits for completion.
func (p *Pool[T]) Close() {
    close(p.work)
    p.wg.Wait()
}
```

### Usage Example — Parallel Image Processing

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()

pool := workerpool.New(ctx, runtime.NumCPU(), func(ctx context.Context, path string) (any, error) {
    return processImage(ctx, path)
})

// Feed work from a different goroutine.
go func() {
    defer pool.Close()
    for _, path := range imagePaths {
        pool.Submit(workerpool.Task[string]{Input: path})
    }
}()
```

### Metrics-Aware Worker Pool

In production, instrument the pool to expose queue depth, worker utilization, and task durations:

```go
type InstrumentedPool[T any] struct {
    pool      *Pool[T]
    queueDepth prometheus.Gauge
    taskDuration prometheus.Histogram
    activeWorkers prometheus.Gauge
}

func (p *InstrumentedPool[T]) Submit(task Task[T]) {
    p.queueDepth.Inc()
    // Wrap result channel to record metrics on completion.
    p.pool.Submit(task)
}
```

## Section 2: Semaphore-Based Concurrency Limiting

When goroutines are spawned dynamically (e.g., for each HTTP request), a semaphore bounds total concurrency without pre-allocating a fixed worker pool.

### Semaphore with golang.org/x/sync

```go
import "golang.org/x/sync/semaphore"

// Limit concurrent outbound calls to external services.
const maxConcurrentCalls = 20

var sem = semaphore.NewWeighted(maxConcurrentCalls)

func callExternalService(ctx context.Context, req Request) (Response, error) {
    // Acquire one slot, respecting context cancellation.
    if err := sem.Acquire(ctx, 1); err != nil {
        return Response{}, fmt.Errorf("semaphore acquire: %w", err)
    }
    defer sem.Release(1)

    return externalClient.Do(ctx, req)
}
```

### Channel-Based Semaphore (no external dependency)

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

func (s Semaphore) TryAcquire() bool {
    select {
    case s <- struct{}{}:
        return true
    default:
        return false
    }
}
```

## Section 3: Rate Limiting with golang.org/x/time/rate

The token bucket is the standard rate-limiting algorithm for controlling outbound request rates to external APIs.

```bash
go get golang.org/x/time/rate
```

### Per-Service Rate Limiter

```go
import "golang.org/x/time/rate"

// RateLimitedClient wraps an HTTP client with token bucket rate limiting.
type RateLimitedClient struct {
    client  *http.Client
    limiter *rate.Limiter
}

func NewRateLimitedClient(rps float64, burst int) *RateLimitedClient {
    return &RateLimitedClient{
        client:  &http.Client{Timeout: 10 * time.Second},
        limiter: rate.NewLimiter(rate.Limit(rps), burst),
    }
}

func (c *RateLimitedClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    if err := c.limiter.Wait(ctx); err != nil {
        return nil, fmt.Errorf("rate limit wait: %w", err)
    }
    return c.client.Do(req.WithContext(ctx))
}
```

### Per-Client Rate Limiting Map

For APIs that enforce per-customer limits, maintain a rate limiter per client:

```go
import "sync"

type PerClientLimiter struct {
    mu       sync.Mutex
    limiters map[string]*rate.Limiter
    rps      rate.Limit
    burst    int
}

func NewPerClientLimiter(rps float64, burst int) *PerClientLimiter {
    return &PerClientLimiter{
        limiters: make(map[string]*rate.Limiter),
        rps:      rate.Limit(rps),
        burst:    burst,
    }
}

func (l *PerClientLimiter) Allow(clientID string) bool {
    l.mu.Lock()
    lim, ok := l.limiters[clientID]
    if !ok {
        lim = rate.NewLimiter(l.rps, l.burst)
        l.limiters[clientID] = lim
    }
    l.mu.Unlock()
    return lim.Allow()
}

func (l *PerClientLimiter) Wait(ctx context.Context, clientID string) error {
    l.mu.Lock()
    lim, ok := l.limiters[clientID]
    if !ok {
        lim = rate.NewLimiter(l.rps, l.burst)
        l.limiters[clientID] = lim
    }
    l.mu.Unlock()
    return lim.Wait(ctx)
}
```

## Section 4: Pipeline Patterns

Pipelines connect stages through channels. Each stage receives values from an upstream channel, transforms them, and emits to a downstream channel.

### Three-Stage Pipeline

```go
package pipeline

// Stage 1: produce file paths.
func generate(ctx context.Context, paths ...string) <-chan string {
    out := make(chan string, len(paths))
    go func() {
        defer close(out)
        for _, p := range paths {
            select {
            case out <- p:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Stage 2: read file contents.
func readFiles(ctx context.Context, paths <-chan string) <-chan []byte {
    out := make(chan []byte, 8)
    go func() {
        defer close(out)
        for path := range paths {
            data, err := os.ReadFile(path)
            if err != nil {
                continue // Or send to an error channel.
            }
            select {
            case out <- data:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Stage 3: process each file.
func processFiles(ctx context.Context, files <-chan []byte) <-chan Result {
    out := make(chan Result, 8)
    go func() {
        defer close(out)
        for data := range files {
            result := doProcess(data)
            select {
            case out <- result:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Wire the pipeline.
func Run(ctx context.Context, paths []string) []Result {
    pathCh  := generate(ctx, paths...)
    filesCh := readFiles(ctx, pathCh)
    resultCh := processFiles(ctx, filesCh)

    var results []Result
    for r := range resultCh {
        results = append(results, r)
    }
    return results
}
```

### Fan-Out Fan-In

Distribute work across N parallel workers, then merge their outputs:

```go
// fanOut distributes items from in across n parallel workers.
func fanOut[T, R any](ctx context.Context, in <-chan T, n int, fn func(context.Context, T) (R, error)) []<-chan result[R] {
    channels := make([]<-chan result[R], n)
    for i := range channels {
        channels[i] = worker(ctx, in, fn)
    }
    return channels
}

func worker[T, R any](ctx context.Context, in <-chan T, fn func(context.Context, T) (R, error)) <-chan result[R] {
    out := make(chan result[R], 8)
    go func() {
        defer close(out)
        for item := range in {
            r, err := fn(ctx, item)
            select {
            case out <- result[R]{Value: r, Err: err}:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// fanIn merges multiple channels into one.
func fanIn[T any](ctx context.Context, channels ...<-chan T) <-chan T {
    out := make(chan T, len(channels)*8)
    var wg sync.WaitGroup

    for _, ch := range channels {
        wg.Add(1)
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

type result[T any] struct {
    Value T
    Err   error
}
```

## Section 5: errgroup for Parallel Error Handling

`errgroup` runs goroutines concurrently, cancels remaining goroutines on first error, and returns the first non-nil error — eliminating the manual boilerplate of goroutine tracking and error collection.

```bash
go get golang.org/x/sync/errgroup
```

### Parallel API Calls with errgroup

```go
import "golang.org/x/sync/errgroup"

type DashboardData struct {
    User    *User
    Orders  []Order
    Balance decimal.Decimal
}

func fetchDashboard(ctx context.Context, userID string) (*DashboardData, error) {
    g, ctx := errgroup.WithContext(ctx)
    data := &DashboardData{}

    g.Go(func() error {
        var err error
        data.User, err = userService.GetUser(ctx, userID)
        return err
    })

    g.Go(func() error {
        var err error
        data.Orders, err = orderService.GetRecentOrders(ctx, userID, 10)
        return err
    })

    g.Go(func() error {
        var err error
        data.Balance, err = accountService.GetBalance(ctx, userID)
        return err
    })

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return data, nil
}
```

### errgroup with Concurrency Limit

```go
// WithContext returns a group limited to maxConcurrent goroutines.
func parallelFetch(ctx context.Context, ids []string, maxConcurrent int) ([]Item, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(maxConcurrent) // Added in golang.org/x/sync v0.1.0.

    results := make([]Item, len(ids))
    for i, id := range ids {
        i, id := i, id // Capture loop variables.
        g.Go(func() error {
            item, err := fetchItem(ctx, id)
            if err != nil {
                return fmt.Errorf("fetch item %s: %w", id, err)
            }
            results[i] = item
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

## Section 6: Context Cancellation Propagation

Context cancellation must propagate through every goroutine boundary. A common mistake is spawning a goroutine with a background context, severing the cancellation chain:

```go
// WRONG: spawned goroutine ignores parent cancellation.
func processRequest(ctx context.Context, req Request) {
    go func() {
        // context.Background() is detached from the request context.
        result, _ := slowOperation(context.Background(), req.Data)
        saveResult(result)
    }()
}

// CORRECT: pass ctx through.
func processRequest(ctx context.Context, req Request) {
    go func() {
        result, err := slowOperation(ctx, req.Data)
        if err != nil {
            if errors.Is(err, context.Canceled) {
                return // Caller cancelled — clean exit.
            }
            log.Printf("slow operation error: %v", err)
            return
        }
        saveResult(result)
    }()
}
```

### Graceful Shutdown with Context

```go
func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    srv := startServer(ctx)

    <-ctx.Done()
    stop() // Stop receiving signals; subsequent SIGINT will kill the process.

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Printf("server shutdown: %v", err)
    }
}
```

## Section 7: Goroutine Leak Detection with goleak

Goroutine leaks accumulate over time, consuming memory and preventing GC of associated resources. goleak catches leaks in tests.

```bash
go get go.uber.org/goleak
```

```go
package mypackage_test

import (
    "testing"
    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// goleak.VerifyTestMain runs all tests and checks that no goroutines
// were leaked by any test. Each test that leaves a goroutine running
// will appear as a failure with a stack trace.
```

### Per-Test Leak Detection

```go
func TestWorkerPool_NoLeak(t *testing.T) {
    defer goleak.VerifyNone(t)

    ctx, cancel := context.WithCancel(context.Background())
    pool := workerpool.New(ctx, 4, func(ctx context.Context, n int) (any, error) {
        return n * 2, nil
    })

    for i := 0; i < 100; i++ {
        pool.Submit(workerpool.Task[int]{Input: i})
    }

    // Cancel context and close pool — goroutines must stop.
    cancel()
    pool.Close()
    // goleak.VerifyNone will run after this test and confirm no leaks.
}
```

### Common Leak Patterns to Avoid

```go
// LEAK: goroutine blocks on channel send with no receiver.
func leaky(data []int) {
    ch := make(chan int) // Unbuffered, no receiver started yet.
    go func() {
        for _, v := range data {
            ch <- v // Blocks forever if receiver exits early.
        }
    }()
    // If caller returns without fully reading ch, goroutine leaks.
}

// FIX: use buffered channel or select with done signal.
func noLeak(ctx context.Context, data []int) <-chan int {
    ch := make(chan int, len(data))
    go func() {
        defer close(ch)
        for _, v := range data {
            select {
            case ch <- v:
            case <-ctx.Done():
                return // Caller cancelled — exit cleanly.
            }
        }
    }()
    return ch
}
```

## Section 8: sync.Pool for Object Reuse

`sync.Pool` reduces GC pressure by reusing temporary objects. It is ideal for buffers, encoder/decoder instances, and any allocation that is frequently created and discarded.

### Buffer Pool

```go
import (
    "bytes"
    "sync"
)

var bufPool = sync.Pool{
    New: func() any {
        return bytes.NewBuffer(make([]byte, 0, 4096))
    },
}

func buildResponse(items []Item) ([]byte, error) {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset()
    defer bufPool.Put(buf)

    enc := json.NewEncoder(buf)
    if err := enc.Encode(items); err != nil {
        return nil, err
    }

    // Copy before returning to pool — the pool may reclaim buf at any time.
    result := make([]byte, buf.Len())
    copy(result, buf.Bytes())
    return result, nil
}
```

### JSON Encoder Pool

```go
var encoderPool = sync.Pool{
    New: func() any {
        return &jsonEncoder{buf: new(bytes.Buffer)}
    },
}

type jsonEncoder struct {
    buf *bytes.Buffer
    enc *json.Encoder
}

func (e *jsonEncoder) Reset() {
    e.buf.Reset()
    e.enc = json.NewEncoder(e.buf)
}

func encodeJSON(v any) ([]byte, error) {
    enc := encoderPool.Get().(*jsonEncoder)
    enc.Reset()
    defer encoderPool.Put(enc)

    if err := enc.enc.Encode(v); err != nil {
        return nil, err
    }
    result := make([]byte, enc.buf.Len())
    copy(result, enc.buf.Bytes())
    return result, nil
}
```

### sync.Pool Pitfalls

- Pool contents can be discarded by the GC at any GC cycle — never store objects that hold exclusive resources (file descriptors, locks).
- Pooled objects must be reset before use — forgotten state from a previous use causes subtle bugs.
- Pool does not benefit allocations that occur in a tight loop without GC pressure; benchmark before adding a pool.

## Section 9: Backpressure with Buffered Channels

Backpressure prevents fast producers from overwhelming slow consumers. Buffered channels provide natural backpressure: a full channel blocks the producer.

### Explicit Backpressure

```go
type Processor struct {
    queue   chan Event
    workers int
}

func NewProcessor(queueDepth, workers int) *Processor {
    p := &Processor{
        queue:   make(chan Event, queueDepth),
        workers: workers,
    }
    return p
}

func (p *Processor) Start(ctx context.Context) {
    for i := 0; i < p.workers; i++ {
        go p.processLoop(ctx)
    }
}

func (p *Processor) processLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case event := <-p.queue:
            if err := handleEvent(ctx, event); err != nil {
                // Log error but continue — avoid killing the goroutine.
                log.Printf("handle event: %v", err)
            }
        }
    }
}

// Enqueue applies backpressure — blocks when queue is full.
func (p *Processor) Enqueue(ctx context.Context, event Event) error {
    select {
    case p.queue <- event:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryEnqueue returns ErrQueueFull instead of blocking.
var ErrQueueFull = errors.New("processing queue is full")

func (p *Processor) TryEnqueue(event Event) error {
    select {
    case p.queue <- event:
        return nil
    default:
        return ErrQueueFull
    }
}

// QueueLen reports current queue depth for monitoring.
func (p *Processor) QueueLen() int { return len(p.queue) }

// QueueCap reports the maximum queue capacity.
func (p *Processor) QueueCap() int { return cap(p.queue) }
```

### Adaptive Shedding

When backpressure blocks the entire call path (e.g., an HTTP handler), shedding recent requests is preferable to queuing them indefinitely:

```go
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    event := extractEvent(r)

    if err := h.processor.TryEnqueue(event); err != nil {
        // Queue full — shed this request with 503.
        metrics.IncrCounter("events.dropped_backpressure", 1)
        http.Error(w, "service temporarily overloaded", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusAccepted)
}
```

## Section 10: Patterns Combining Multiple Primitives

### Scatter-Gather with Timeout

Fetch data from multiple sources in parallel, collect results, and return what is available before the deadline:

```go
func scatterGather(ctx context.Context, sources []DataSource, timeout time.Duration) []Result {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    results := make(chan Result, len(sources))

    for _, src := range sources {
        src := src
        go func() {
            r, err := src.Fetch(ctx)
            results <- Result{Data: r, Source: src.Name(), Err: err}
        }()
    }

    collected := make([]Result, 0, len(sources))
    for range sources {
        select {
        case r := <-results:
            if r.Err == nil {
                collected = append(collected, r)
            }
        case <-ctx.Done():
            // Deadline exceeded — return whatever has arrived.
            return collected
        }
    }
    return collected
}
```

### Debounce

Collapse rapid successive events into a single call — useful for configuration reload signals:

```go
func Debounce(ctx context.Context, d time.Duration, fn func()) func() {
    var (
        mu    sync.Mutex
        timer *time.Timer
    )
    return func() {
        mu.Lock()
        defer mu.Unlock()
        if timer != nil {
            timer.Stop()
        }
        timer = time.AfterFunc(d, func() {
            select {
            case <-ctx.Done():
            default:
                fn()
            }
        })
    }
}
```

### Circuit Breaker using Channel State

```go
type CircuitBreaker struct {
    maxFailures  int
    resetTimeout time.Duration

    mu           sync.Mutex
    failures     int
    openUntil    time.Time
}

func (cb *CircuitBreaker) Allow() bool {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if !cb.openUntil.IsZero() {
        if time.Now().Before(cb.openUntil) {
            return false // Circuit is open.
        }
        // Half-open: allow one probe request.
        cb.openUntil = time.Time{}
        cb.failures = 0
    }
    return true
}

func (cb *CircuitBreaker) RecordSuccess() {
    cb.mu.Lock()
    cb.failures = 0
    cb.mu.Unlock()
}

func (cb *CircuitBreaker) RecordFailure() {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    cb.failures++
    if cb.failures >= cb.maxFailures {
        cb.openUntil = time.Now().Add(cb.resetTimeout)
    }
}
```

## Section 11: Benchmarking Concurrency Primitives

Understanding the cost of synchronization primitives guides design decisions:

```go
package bench_test

import (
    "sync"
    "sync/atomic"
    "testing"
)

var counter int64
var mu sync.Mutex
var muCounter int64

// Atomic increment — fastest for single values.
func BenchmarkAtomicIncrement(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            atomic.AddInt64(&counter, 1)
        }
    })
}

// Mutex-protected increment — ~3-5x slower than atomic.
func BenchmarkMutexIncrement(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.Lock()
            muCounter++
            mu.Unlock()
        }
    })
}

// Channel send/receive — ~10-20x slower than atomic.
func BenchmarkChannel(b *testing.B) {
    ch := make(chan struct{}, 1)
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            ch <- struct{}{}
            <-ch
        }
    })
}
```

Typical results on modern hardware (GOMAXPROCS=8):

| Operation | ns/op | Relative cost |
|---|---|---|
| Atomic Add | 5-15 | 1x |
| Mutex Lock/Unlock | 15-40 | 3x |
| Channel (buffered) | 60-120 | 10-20x |
| goroutine creation | 2000-5000 | 500x |

## Section 12: Production Checklist

A concurrency-safe Go service satisfies:

- **Goroutine lifecycle**: every goroutine has an owner responsible for its termination; context cancellation propagates through every goroutine boundary.
- **Channel discipline**: every goroutine that writes to a channel owns the close; readers handle `ok == false` from range loops.
- **Pool sizing**: worker pool size is bounded by available resources (CPU, DB connections, downstream RPS limits).
- **Rate limiting**: all outbound calls to third-party APIs use token bucket rate limiters.
- **Backpressure**: queue depth is bounded; callers receive `503` or `ErrQueueFull` when the system is saturated.
- **Leak testing**: `goleak.VerifyTestMain` is present in every package with concurrent code.
- **sync.Pool usage**: pooled objects are reset before use; they do not hold exclusive resources.
- **Shutdown**: all goroutines stop within the graceful shutdown window; `sync.WaitGroup.Wait()` is called before process exit.

## Section 13: Summary

Go's concurrency model is expressive and efficient, but production reliability requires deliberate application of established patterns:

- **Worker pools** bound concurrent processing to a fixed number of goroutines regardless of input volume.
- **Semaphores** limit concurrency for dynamically spawned goroutines without the overhead of a full pool.
- **Token buckets** (`golang.org/x/time/rate`) control outbound request rates with burst tolerance.
- **Pipelines and fan-out/fan-in** decompose complex processing into independently testable stages.
- **errgroup** eliminates goroutine tracking boilerplate for parallel operations that must all succeed.
- **Context propagation** is the connective tissue — every goroutine boundary must forward the context.
- **goleak** catches goroutine leaks in CI before they reach production.
- **sync.Pool** reduces GC pressure on hot paths that allocate and discard frequently.
- **Buffered channels** provide natural backpressure; shedding on `TryEnqueue` failure protects stability under overload.

These patterns are composable — a production service typically combines a worker pool, a semaphore on outbound calls, a rate limiter, and a buffered queue with explicit backpressure into a coherent system that degrades gracefully rather than collapsing under load.
