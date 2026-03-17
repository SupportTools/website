---
title: "Go Reactive Streams: Backpressure and Flow Control Patterns"
date: 2029-08-16T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Backpressure", "Streams", "Channels", "Circuit Breaker"]
categories: ["Go", "Concurrency"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to reactive stream patterns in Go: channel-based backpressure, worker pools with bounded queues, load shedding strategies, circuit breaker integration, and the reactive streams specification adapted for Go."
more_link: "yes"
url: "/go-reactive-streams-backpressure-flow-control/"
---

Every production Go service eventually faces the same problem: a producer that generates work faster than consumers can process it. Without backpressure, this leads to unbounded memory growth, dropped requests, cascading failures, or all three. Reactive streams formalize the solution: producers must slow down or shed load when consumers signal they cannot keep up. This post covers the patterns that make Go services robust under load.

<!--more-->

# Go Reactive Streams: Backpressure and Flow Control Patterns

## Section 1: The Problem with Unbounded Queues

Before diving into solutions, understand why unbounded queues are dangerous:

```go
// DANGEROUS — unbounded queue causes OOM under sustained load
type BadQueue struct {
    ch chan Work
}

func NewBadQueue() *BadQueue {
    return &BadQueue{
        ch: make(chan Work, 10_000_000),  // "I'll just make it big enough"
    }
}

func (q *BadQueue) Submit(w Work) {
    q.ch <- w  // never blocks, but consumes unlimited memory
}

// If producers generate 100K items/sec and consumers process 90K/sec,
// the queue grows by 10K items/sec = 600K items/minute = OOM in ~17 minutes
```

The solution is not a bigger queue — it is a bounded queue with explicit backpressure behavior when the queue is full.

## Section 2: Reactive Streams Concepts in Go

The Reactive Streams specification (from the JVM world) defines four interfaces:

- **Publisher** — produces a sequence of items
- **Subscriber** — consumes items, requests more via demand signals
- **Subscription** — the contract between publisher and subscriber
- **Processor** — both publisher and subscriber (a pipeline stage)

Go's channel model maps naturally to these concepts, but requires explicit design:

```go
// Go adaptation of the Reactive Streams contract

// Publisher emits items to a channel; honors cancellation via context
type Publisher[T any] interface {
    Subscribe(ctx context.Context) <-chan T
}

// BoundedPublisher publishes items and signals backpressure
type BoundedPublisher[T any] struct {
    items   chan T
    done    chan struct{}
    demand  chan int64  // demand signals from subscriber
}

// Subscriber processes items; signals demand via Demand()
type Subscriber[T any] interface {
    OnNext(item T)
    OnError(err error)
    OnComplete()
    Demand() int64  // how many items the subscriber can currently accept
}
```

## Section 3: Channel-Based Backpressure

### Pattern 1: Bounded Channel with Drop

The simplest backpressure pattern: when the buffer is full, drop the item.

```go
// pkg/streams/drop_stream.go
package streams

import (
    "context"
    "sync/atomic"
)

// DroppableStream is a bounded producer that drops items when the buffer is full.
// Use for telemetry, metrics, and other fire-and-forget data where some loss is acceptable.
type DroppableStream[T any] struct {
    ch       chan T
    dropped  atomic.Int64
    enqueued atomic.Int64
}

func NewDroppableStream[T any](bufferSize int) *DroppableStream[T] {
    return &DroppableStream[T]{
        ch: make(chan T, bufferSize),
    }
}

// TrySubmit submits an item, returning false if the buffer is full (item is dropped).
func (s *DroppableStream[T]) TrySubmit(item T) bool {
    select {
    case s.ch <- item:
        s.enqueued.Add(1)
        return true
    default:
        s.dropped.Add(1)
        return false
    }
}

// Consume returns the read channel. The caller must read from it continuously.
func (s *DroppableStream[T]) Consume() <-chan T {
    return s.ch
}

// Stats returns drop and enqueue counts.
func (s *DroppableStream[T]) Stats() (enqueued, dropped int64) {
    return s.enqueued.Load(), s.dropped.Load()
}

// Usage
func runDropExample(ctx context.Context) {
    stream := NewDroppableStream[LogEntry](1000)

    // Consumer goroutine
    go func() {
        for {
            select {
            case entry := <-stream.Consume():
                processLogEntry(entry)
            case <-ctx.Done():
                return
            }
        }
    }()

    // Producer — will not block even under high load
    for i := 0; i < 1_000_000; i++ {
        if !stream.TrySubmit(LogEntry{Message: "event", Index: i}) {
            // item was dropped — update drop metric
            droppedMetric.Add(ctx, 1)
        }
    }
}
```

### Pattern 2: Blocking with Timeout (Backpressure Propagation)

When you cannot afford to drop items, block the producer until the consumer catches up, but with a timeout to prevent deadlock:

```go
// pkg/streams/backpressure_stream.go
package streams

import (
    "context"
    "errors"
    "fmt"
    "time"
)

var ErrBackpressureTimeout = errors.New("backpressure timeout: consumer too slow")

// BackpressureStream blocks producers when the buffer is full,
// propagating backpressure up the call stack.
type BackpressureStream[T any] struct {
    ch      chan T
    timeout time.Duration
}

func NewBackpressureStream[T any](bufferSize int, timeout time.Duration) *BackpressureStream[T] {
    return &BackpressureStream[T]{
        ch:      make(chan T, bufferSize),
        timeout: timeout,
    }
}

// Submit blocks until the item is accepted or timeout/cancellation occurs.
// Returns ErrBackpressureTimeout if the consumer is too slow.
// The caller should treat this as a signal to slow down or shed load.
func (s *BackpressureStream[T]) Submit(ctx context.Context, item T) error {
    if s.timeout == 0 {
        select {
        case s.ch <- item:
            return nil
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    timer := time.NewTimer(s.timeout)
    defer timer.Stop()

    select {
    case s.ch <- item:
        return nil
    case <-timer.C:
        return fmt.Errorf("%w: buffer full for %s", ErrBackpressureTimeout, s.timeout)
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Consume returns the read channel.
func (s *BackpressureStream[T]) Consume() <-chan T {
    return s.ch
}

// Usage: HTTP handler with backpressure to processing queue
func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
    job := Job{RequestID: r.Header.Get("X-Request-ID"), Body: r.Body}

    if err := h.jobStream.Submit(r.Context(), job); err != nil {
        if errors.Is(err, ErrBackpressureTimeout) {
            // Return 503 to HTTP client — they can retry
            http.Error(w, "service busy, retry later", http.StatusServiceUnavailable)
            return
        }
        http.Error(w, "context cancelled", http.StatusBadRequest)
        return
    }

    w.WriteHeader(http.StatusAccepted)
}
```

### Pattern 3: Token Bucket Rate Limiting

Rate limiting is a form of backpressure that enforces a maximum throughput:

```go
// pkg/streams/rate_limiter.go
package streams

import (
    "context"
    "time"
)

// TokenBucket implements a token bucket rate limiter.
// Tokens refill at a constant rate; each operation consumes a token.
type TokenBucket struct {
    tokens     chan struct{}
    refillRate time.Duration
    done       chan struct{}
}

func NewTokenBucket(capacity int, refillRate time.Duration) *TokenBucket {
    tb := &TokenBucket{
        tokens:     make(chan struct{}, capacity),
        refillRate: refillRate,
        done:       make(chan struct{}),
    }

    // Pre-fill the bucket
    for i := 0; i < capacity; i++ {
        tb.tokens <- struct{}{}
    }

    // Refill goroutine
    go tb.refill(capacity)
    return tb
}

func (tb *TokenBucket) refill(capacity int) {
    ticker := time.NewTicker(tb.refillRate)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            // Add a token if there is space
            select {
            case tb.tokens <- struct{}{}:
            default: // bucket full, discard
            }
        case <-tb.done:
            return
        }
    }
}

// Acquire blocks until a token is available or context is cancelled.
func (tb *TokenBucket) Acquire(ctx context.Context) error {
    select {
    case <-tb.tokens:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryAcquire acquires a token without blocking.
// Returns false if no tokens are available.
func (tb *TokenBucket) TryAcquire() bool {
    select {
    case <-tb.tokens:
        return true
    default:
        return false
    }
}

func (tb *TokenBucket) Stop() {
    close(tb.done)
}
```

## Section 4: Worker Pool with Bounded Queue

The canonical Go pattern for bounded concurrency with backpressure:

```go
// pkg/streams/worker_pool.go
package streams

import (
    "context"
    "sync"
    "time"
)

// WorkerPool processes items from a bounded queue using a fixed number of workers.
// It provides backpressure by blocking Submit when the queue is full.
type WorkerPool[T any] struct {
    workers int
    queue   chan T
    wg      sync.WaitGroup
    metrics *PoolMetrics
}

type PoolMetrics struct {
    queued    atomic.Int64
    processed atomic.Int64
    errors    atomic.Int64
    rejected  atomic.Int64
}

type WorkerConfig struct {
    Workers   int
    QueueSize int
    Timeout   time.Duration
}

// ProcessFunc processes a single item. Must honor context cancellation.
type ProcessFunc[T any] func(ctx context.Context, item T) error

func NewWorkerPool[T any](cfg WorkerConfig) *WorkerPool[T] {
    return &WorkerPool[T]{
        workers: cfg.Workers,
        queue:   make(chan T, cfg.QueueSize),
        metrics: &PoolMetrics{},
    }
}

// Start launches workers and begins processing.
func (p *WorkerPool[T]) Start(ctx context.Context, fn ProcessFunc[T]) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.worker(ctx, fn)
    }
}

func (p *WorkerPool[T]) worker(ctx context.Context, fn ProcessFunc[T]) {
    defer p.wg.Done()
    for {
        select {
        case item, ok := <-p.queue:
            if !ok {
                return // queue closed
            }
            p.metrics.queued.Add(-1)
            if err := fn(ctx, item); err != nil {
                p.metrics.errors.Add(1)
            } else {
                p.metrics.processed.Add(1)
            }
        case <-ctx.Done():
            return
        }
    }
}

// Submit enqueues an item, blocking if the queue is full.
// Use SubmitWithTimeout or TrySubmit for non-blocking variants.
func (p *WorkerPool[T]) Submit(ctx context.Context, item T) error {
    select {
    case p.queue <- item:
        p.metrics.queued.Add(1)
        return nil
    case <-ctx.Done():
        p.metrics.rejected.Add(1)
        return ctx.Err()
    }
}

// SubmitWithTimeout submits an item with a deadline for backpressure.
func (p *WorkerPool[T]) SubmitWithTimeout(ctx context.Context, item T, timeout time.Duration) error {
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case p.queue <- item:
        p.metrics.queued.Add(1)
        return nil
    case <-timer.C:
        p.metrics.rejected.Add(1)
        return ErrBackpressureTimeout
    case <-ctx.Done():
        p.metrics.rejected.Add(1)
        return ctx.Err()
    }
}

// TrySubmit submits without blocking, returning false if the queue is full.
func (p *WorkerPool[T]) TrySubmit(item T) bool {
    select {
    case p.queue <- item:
        p.metrics.queued.Add(1)
        return true
    default:
        p.metrics.rejected.Add(1)
        return false
    }
}

// Drain stops accepting new work and waits for all queued items to complete.
func (p *WorkerPool[T]) Drain() {
    close(p.queue)
    p.wg.Wait()
}

// QueueDepth returns the current number of items waiting to be processed.
func (p *WorkerPool[T]) QueueDepth() int {
    return len(p.queue)
}

// Utilization returns worker utilization: items processing / total workers.
func (p *WorkerPool[T]) Utilization() float64 {
    return float64(len(p.queue)) / float64(cap(p.queue))
}
```

### Adaptive Worker Pool

```go
// Adjust worker count based on queue depth
type AdaptiveWorkerPool[T any] struct {
    *WorkerPool[T]
    minWorkers    int
    maxWorkers    int
    currentWorkers atomic.Int64
    fn            ProcessFunc[T]
    ctx           context.Context
}

func (p *AdaptiveWorkerPool[T]) adjustWorkers() {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            utilization := p.Utilization()
            current := p.currentWorkers.Load()

            if utilization > 0.8 && current < int64(p.maxWorkers) {
                // Queue is 80% full — add workers
                newWorkers := min(int64(p.maxWorkers), current+2)
                for i := current; i < newWorkers; i++ {
                    p.wg.Add(1)
                    go p.worker(p.ctx, p.fn)
                    p.currentWorkers.Add(1)
                }
            }
            // Note: removing workers requires more complex signaling
            // (send to a quit channel that workers select on)

        case <-p.ctx.Done():
            return
        }
    }
}
```

## Section 5: Load Shedding Strategies

Load shedding intentionally drops work when the system is overloaded to protect stability.

### Priority-Based Load Shedding

```go
// pkg/streams/priority_shed.go
package streams

import (
    "context"
    "sync"
)

type Priority int

const (
    PriorityLow    Priority = 0
    PriorityMedium Priority = 1
    PriorityHigh   Priority = 2
)

type PrioritizedItem[T any] struct {
    Item     T
    Priority Priority
}

// PriorityQueue with load shedding: drops low-priority items under load.
type PriorityQueue[T any] struct {
    mu     sync.Mutex
    high   chan T
    medium chan T
    low    chan T
}

func NewPriorityQueue[T any](bufferSize int) *PriorityQueue[T] {
    return &PriorityQueue[T]{
        high:   make(chan T, bufferSize),
        medium: make(chan T, bufferSize),
        low:    make(chan T, bufferSize/4), // smallest buffer for low priority
    }
}

// Submit routes items to the correct priority queue.
// Low-priority items are dropped when their queue is full.
// High-priority items block with backpressure.
func (q *PriorityQueue[T]) Submit(ctx context.Context, item T, priority Priority) error {
    switch priority {
    case PriorityHigh:
        // Block until accepted (never drop high priority)
        select {
        case q.high <- item:
            return nil
        case <-ctx.Done():
            return ctx.Err()
        }
    case PriorityMedium:
        select {
        case q.medium <- item:
            return nil
        default:
            // Medium priority: drop rather than block
            return ErrBackpressureTimeout
        }
    default: // PriorityLow
        select {
        case q.low <- item:
            return nil
        default:
            // Low priority: always drop when full
            return ErrBackpressureTimeout
        }
    }
}

// Next returns the next item, respecting priority order.
func (q *PriorityQueue[T]) Next(ctx context.Context) (T, error) {
    var zero T
    // Try high priority first
    select {
    case item := <-q.high:
        return item, nil
    default:
    }

    // Then medium
    select {
    case item := <-q.medium:
        return item, nil
    default:
    }

    // Then low, or wait for any
    select {
    case item := <-q.high:
        return item, nil
    case item := <-q.medium:
        return item, nil
    case item := <-q.low:
        return item, nil
    case <-ctx.Done():
        return zero, ctx.Err()
    }
}
```

### Tail Latency-Based Load Shedding

```go
// pkg/streams/latency_shed.go
package streams

import (
    "context"
    "sync"
    "time"
)

// LatencyShedder drops requests when processing latency exceeds a threshold.
// This prevents latency from growing unboundedly under sustained overload.
type LatencyShedder struct {
    mu              sync.Mutex
    p99Latency      time.Duration
    threshold       time.Duration
    windowSize      int
    latencies       []time.Duration
    windowIndex     int
    shedding        bool
    recoveryCounter int
}

func NewLatencyShedder(threshold time.Duration, windowSize int) *LatencyShedder {
    return &LatencyShedder{
        threshold:  threshold,
        windowSize: windowSize,
        latencies:  make([]time.Duration, windowSize),
    }
}

// RecordLatency records a completed request's processing time.
func (ls *LatencyShedder) RecordLatency(d time.Duration) {
    ls.mu.Lock()
    defer ls.mu.Unlock()

    ls.latencies[ls.windowIndex%ls.windowSize] = d
    ls.windowIndex++

    ls.p99Latency = ls.calculateP99()

    // Enter shedding mode when p99 exceeds threshold
    if ls.p99Latency > ls.threshold {
        ls.shedding = true
        ls.recoveryCounter = 0
    } else if ls.shedding {
        ls.recoveryCounter++
        if ls.recoveryCounter > ls.windowSize/2 {
            ls.shedding = false
        }
    }
}

func (ls *LatencyShedder) calculateP99() time.Duration {
    // Copy and sort (simplified for illustration)
    sorted := make([]time.Duration, len(ls.latencies))
    copy(sorted, ls.latencies)
    // sort.Slice(sorted, ...) — omitted for brevity
    idx := int(float64(len(sorted)) * 0.99)
    if idx >= len(sorted) {
        idx = len(sorted) - 1
    }
    return sorted[idx]
}

// ShouldShed returns true if the current request should be shed.
func (ls *LatencyShedder) ShouldShed() bool {
    ls.mu.Lock()
    defer ls.mu.Unlock()
    return ls.shedding
}

// Middleware integration
func (ls *LatencyShedder) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if ls.ShouldShed() {
            w.Header().Set("Retry-After", "5")
            http.Error(w, "overloaded, retry in 5 seconds", http.StatusServiceUnavailable)
            return
        }

        start := time.Now()
        next.ServeHTTP(w, r)
        ls.RecordLatency(time.Since(start))
    })
}
```

## Section 6: Circuit Breaker Integration

A circuit breaker prevents cascading failures by stopping calls to a failing downstream service.

```go
// pkg/streams/circuit_breaker.go
package streams

import (
    "context"
    "errors"
    "sync"
    "time"
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

type State int

const (
    StateClosed   State = iota // Normal operation
    StateOpen                  // Failing — reject all calls
    StateHalfOpen              // Testing — allow one call through
)

// CircuitBreaker protects a downstream dependency.
// Integrates with BackpressureStream to stop filling the queue when downstream fails.
type CircuitBreaker struct {
    mu             sync.Mutex
    state          State
    failures       int
    successes      int
    threshold      int           // failures before opening
    recoveryWindow time.Duration // time before attempting half-open
    lastFailure    time.Time

    onOpen    func()
    onClose   func()
    onHalfOpen func()
}

type CBConfig struct {
    FailureThreshold int
    RecoveryWindow   time.Duration
    OnOpen           func()
    OnClose          func()
    OnHalfOpen       func()
}

func NewCircuitBreaker(cfg CBConfig) *CircuitBreaker {
    return &CircuitBreaker{
        state:          StateClosed,
        threshold:      cfg.FailureThreshold,
        recoveryWindow: cfg.RecoveryWindow,
        onOpen:         cfg.OnOpen,
        onClose:        cfg.OnClose,
        onHalfOpen:     cfg.OnHalfOpen,
    }
}

// Execute calls fn if the circuit is closed (or half-open for a probe call).
func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    if err := cb.allowRequest(); err != nil {
        return err
    }

    err := fn(ctx)
    cb.recordResult(err)
    return err
}

func (cb *CircuitBreaker) allowRequest() error {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return nil
    case StateOpen:
        if time.Since(cb.lastFailure) > cb.recoveryWindow {
            cb.state = StateHalfOpen
            if cb.onHalfOpen != nil {
                cb.onHalfOpen()
            }
            return nil // allow probe call
        }
        return ErrCircuitOpen
    case StateHalfOpen:
        return nil // allow the single probe call
    }
    return nil
}

func (cb *CircuitBreaker) recordResult(err error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.failures++
        cb.lastFailure = time.Now()

        switch cb.state {
        case StateClosed:
            if cb.failures >= cb.threshold {
                cb.state = StateOpen
                if cb.onOpen != nil {
                    cb.onOpen()
                }
            }
        case StateHalfOpen:
            cb.state = StateOpen // probe failed — stay open
        }
    } else {
        switch cb.state {
        case StateHalfOpen:
            cb.state = StateClosed
            cb.failures = 0
            if cb.onClose != nil {
                cb.onClose()
            }
        case StateClosed:
            cb.failures = 0 // reset on success
        }
    }
}

// State returns the current circuit state.
func (cb *CircuitBreaker) State() State {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    return cb.state
}
```

### Combining Worker Pool, Backpressure, and Circuit Breaker

```go
// pkg/pipeline/pipeline.go — Production-grade pipeline with all patterns
package pipeline

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/example/streams"
)

// Pipeline is a complete request processing pipeline with:
// - Bounded worker pool (backpressure at submission)
// - Circuit breaker (protects downstream)
// - Priority-based load shedding
// - Latency-based shedding
type Pipeline[In, Out any] struct {
    pool           *streams.WorkerPool[In]
    circuit        *streams.CircuitBreaker
    latencyShedder *streams.LatencyShedder
    results        chan Result[Out]
    processor      func(ctx context.Context, item In) (Out, error)
}

type Result[T any] struct {
    Value T
    Err   error
}

type Config struct {
    Workers        int
    QueueSize      int
    SubmitTimeout  time.Duration
    P99Threshold   time.Duration
    CBFailures     int
    CBRecovery     time.Duration
}

func New[In, Out any](
    cfg Config,
    processor func(ctx context.Context, item In) (Out, error),
) *Pipeline[In, Out] {
    p := &Pipeline[In, Out]{
        pool: streams.NewWorkerPool[In](streams.WorkerConfig{
            Workers:   cfg.Workers,
            QueueSize: cfg.QueueSize,
            Timeout:   cfg.SubmitTimeout,
        }),
        circuit: streams.NewCircuitBreaker(streams.CBConfig{
            FailureThreshold: cfg.CBFailures,
            RecoveryWindow:   cfg.CBRecovery,
        }),
        latencyShedder: streams.NewLatencyShedder(cfg.P99Threshold, 100),
        results:        make(chan Result[Out], cfg.QueueSize),
        processor:      processor,
    }
    return p
}

func (p *Pipeline[In, Out]) Start(ctx context.Context) {
    p.pool.Start(ctx, func(ctx context.Context, item In) error {
        // Latency-aware shedding — if we're already slow, don't add more
        if p.latencyShedder.ShouldShed() {
            p.results <- Result[Out]{Err: fmt.Errorf("shed under load")}
            return nil
        }

        start := time.Now()
        var result Out

        err := p.circuit.Execute(ctx, func(ctx context.Context) error {
            var processingErr error
            result, processingErr = p.processor(ctx, item)
            return processingErr
        })

        p.latencyShedder.RecordLatency(time.Since(start))

        p.results <- Result[Out]{Value: result, Err: err}
        return nil
    })
}

// Submit adds an item to the pipeline, applying backpressure if needed.
func (p *Pipeline[In, Out]) Submit(ctx context.Context, item In) error {
    // Check circuit breaker before even queueing
    if p.circuit.State() == streams.StateOpen {
        return ErrCircuitOpen
    }

    return p.pool.SubmitWithTimeout(ctx, item, 100*time.Millisecond)
}

// Results returns the output channel.
func (p *Pipeline[In, Out]) Results() <-chan Result[Out] {
    return p.results
}
```

## Section 7: Fan-Out and Fan-In Patterns

### Fan-Out — One Producer, Multiple Consumers

```go
// pkg/streams/fanout.go
package streams

import (
    "context"
    "sync"
)

// FanOut distributes items from one channel to N worker channels.
// Uses round-robin distribution to balance load.
type FanOut[T any] struct {
    outputs []chan T
    index   atomic.Int64
}

func NewFanOut[T any](numConsumers, bufferPerConsumer int) *FanOut[T] {
    outputs := make([]chan T, numConsumers)
    for i := range outputs {
        outputs[i] = make(chan T, bufferPerConsumer)
    }
    return &FanOut[T]{outputs: outputs}
}

func (f *FanOut[T]) Run(ctx context.Context, input <-chan T) {
    go func() {
        defer func() {
            for _, ch := range f.outputs {
                close(ch)
            }
        }()
        for {
            select {
            case item, ok := <-input:
                if !ok {
                    return
                }
                // Round-robin distribution
                idx := int(f.index.Add(1)) % len(f.outputs)
                select {
                case f.outputs[idx] <- item:
                case <-ctx.Done():
                    return
                }
            case <-ctx.Done():
                return
            }
        }
    }()
}

func (f *FanOut[T]) Output(i int) <-chan T {
    return f.outputs[i]
}
```

### Fan-In — Multiple Producers, One Consumer

```go
// pkg/streams/fanin.go
package streams

import (
    "context"
    "sync"
)

// FanIn merges multiple input channels into one output channel.
// Useful for aggregating results from parallel workers.
func FanIn[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    output := make(chan T, len(inputs)*10)
    var wg sync.WaitGroup

    for _, input := range inputs {
        in := input // capture for goroutine
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case item, ok := <-in:
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
        }()
    }

    go func() {
        wg.Wait()
        close(output)
    }()

    return output
}
```

## Section 8: Observable Streams with Metrics

```go
// pkg/streams/observable.go
package streams

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

// ObservablePool wraps WorkerPool with OTel metrics.
type ObservablePool[T any] struct {
    *WorkerPool[T]
    queueDepth    metric.Int64ObservableGauge
    processRate   metric.Float64Counter
    dropRate      metric.Float64Counter
    processingTime metric.Float64Histogram
    name          string
}

func NewObservablePool[T any](name string, cfg WorkerConfig) (*ObservablePool[T], error) {
    meter := otel.Meter("github.com/example/streams")

    queueDepth, err := meter.Int64ObservableGauge(
        "stream.queue.depth",
        metric.WithDescription("Current queue depth"),
        metric.WithUnit("{item}"),
    )
    if err != nil {
        return nil, err
    }

    processRate, err := meter.Float64Counter(
        "stream.items.processed",
        metric.WithDescription("Items processed"),
        metric.WithUnit("{item}"),
    )
    if err != nil {
        return nil, err
    }

    processingTime, err := meter.Float64Histogram(
        "stream.processing.duration",
        metric.WithDescription("Time to process a single item"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    pool := NewWorkerPool[T](cfg)
    op := &ObservablePool[T]{
        WorkerPool:     pool,
        queueDepth:     queueDepth,
        processRate:    processRate,
        processingTime: processingTime,
        name:           name,
    }

    // Register observable for queue depth
    _, err = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
        o.ObserveInt64(queueDepth, int64(pool.QueueDepth()),
            metric.WithAttributes(attribute.String("pool.name", name)))
        return nil
    }, queueDepth)
    if err != nil {
        return nil, err
    }

    return op, nil
}

// StartObserved starts the pool with instrumented processing.
func (p *ObservablePool[T]) StartObserved(ctx context.Context, fn ProcessFunc[T]) {
    p.WorkerPool.Start(ctx, func(ctx context.Context, item T) error {
        start := time.Now()
        err := fn(ctx, item)
        duration := time.Since(start).Seconds()

        status := "ok"
        if err != nil {
            status = "error"
        }

        attrs := metric.WithAttributes(
            attribute.String("pool.name", p.name),
            attribute.String("status", status),
        )

        p.processRate.Add(ctx, 1, attrs)
        p.processingTime.Record(ctx, duration, attrs)
        return err
    })
}
```

## Section 9: Testing Backpressure Behavior

```go
// pkg/streams/worker_pool_test.go
package streams_test

import (
    "context"
    "sync/atomic"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/example/streams"
)

func TestWorkerPool_Backpressure(t *testing.T) {
    // Pool with 2 workers and queue of 5 — total capacity 7 (workers + queue)
    pool := streams.NewWorkerPool[int](streams.WorkerConfig{
        Workers:   2,
        QueueSize: 5,
    })

    var processed atomic.Int64
    slow := make(chan struct{})

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    pool.Start(ctx, func(ctx context.Context, item int) error {
        <-slow // Block until we release
        processed.Add(1)
        return nil
    })

    // Fill the queue completely (2 workers + 5 queue = 7 total)
    for i := 0; i < 7; i++ {
        require.NoError(t, pool.Submit(ctx, i))
    }

    // Next submit should backpressure (queue full)
    submitCtx, submitCancel := context.WithTimeout(ctx, 50*time.Millisecond)
    defer submitCancel()

    err := pool.Submit(submitCtx, 99)
    assert.ErrorIs(t, err, context.DeadlineExceeded,
        "expected backpressure when queue is full")

    // Release workers — verify all 7 items are processed
    close(slow)
    time.Sleep(100 * time.Millisecond)
    assert.Equal(t, int64(7), processed.Load())
}

func TestDroppableStream_DropCount(t *testing.T) {
    stream := streams.NewDroppableStream[int](10)

    // Submit 100 items — only first 10 fit
    for i := 0; i < 100; i++ {
        stream.TrySubmit(i)
    }

    enqueued, dropped := stream.Stats()
    assert.Equal(t, int64(10), enqueued, "only 10 items should be enqueued")
    assert.Equal(t, int64(90), dropped, "90 items should be dropped")
}

func TestCircuitBreaker_OpenOnFailures(t *testing.T) {
    cb := streams.NewCircuitBreaker(streams.CBConfig{
        FailureThreshold: 3,
        RecoveryWindow:   100 * time.Millisecond,
    })

    failFn := func(ctx context.Context) error {
        return errors.New("downstream failure")
    }

    ctx := context.Background()

    // 3 failures should open the circuit
    for i := 0; i < 3; i++ {
        _ = cb.Execute(ctx, failFn)
    }

    assert.Equal(t, streams.StateOpen, cb.State())

    // Next call should return ErrCircuitOpen without calling fn
    err := cb.Execute(ctx, failFn)
    assert.ErrorIs(t, err, streams.ErrCircuitOpen)

    // After recovery window, circuit goes half-open
    time.Sleep(150 * time.Millisecond)
    err = cb.Execute(ctx, func(ctx context.Context) error { return nil })
    assert.NoError(t, err)
    assert.Equal(t, streams.StateClosed, cb.State())
}
```

## Section 10: Production Checklist

- [ ] All channels bounded — no unbounded `make(chan T)` in hot paths
- [ ] Submit operations use context-aware blocking, not bare channel sends
- [ ] Drop rate tracked as a Prometheus counter (never silently drop)
- [ ] Queue depth exposed as an observable gauge metric
- [ ] Worker pool utilization alerting when queue depth > 80% for >5 minutes
- [ ] Priority queues implemented for mixed critical/non-critical workloads
- [ ] Circuit breaker configured for all downstream service calls
- [ ] Latency-based shedding thresholds set from p99 baseline benchmarks
- [ ] Fan-out distribution verified as even across workers under load
- [ ] Fan-in merger tested for correct completion when any input closes
- [ ] Backpressure propagated to HTTP clients via 503 with Retry-After header
- [ ] All stream patterns covered by unit tests including backpressure scenarios
- [ ] Load tests run to verify system behavior at 2x expected peak load

## Conclusion

Backpressure is not a feature you add to a system — it is the discipline you build from the start. The channel gives Go an excellent primitive for backpressure: a bounded channel naturally blocks producers when consumers cannot keep up.

The patterns in this post form a toolkit: use `DroppableStream` for telemetry and metrics (some loss acceptable), `BackpressureStream` for work that must not be lost, `WorkerPool` for bounded concurrency, priority queues for mixed workloads, and circuit breakers to prevent cascade failures. Combine them with observable metrics and you have a system that degrades gracefully under load rather than catastrophically.

The most important principle: make the backpressure visible. Track drop rates, queue depths, circuit breaker state, and p99 latency. When a system is shedding load, operators need to know — not discover it from user reports.
