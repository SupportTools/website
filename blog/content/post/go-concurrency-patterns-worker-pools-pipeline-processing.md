---
title: "Go Concurrency Patterns: Worker Pools, Fan-Out/Fan-In, and Pipeline Processing"
date: 2030-06-21T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Concurrency", "Goroutines", "Channels", "Performance"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go concurrency: buffered channel pools, semaphore patterns, errgroup coordination, rate-limited worker pools, pipeline stages, and backpressure handling for high-throughput systems."
more_link: "yes"
url: "/go-concurrency-patterns-worker-pools-pipeline-processing/"
---

Go's concurrency model — goroutines, channels, and the `sync` package — enables highly concurrent systems with predictable resource consumption. However, idiomatic concurrent Go requires deliberate design to avoid goroutine leaks, unbounded memory growth, missed errors, and subtle race conditions. This guide covers production-proven concurrency patterns: bounded worker pools, fan-out/fan-in pipelines, error group coordination, semaphore-based rate limiting, and backpressure mechanisms for high-throughput data processing systems.

<!--more-->

## Foundation: Goroutine Lifecycle Management

The most common mistake in concurrent Go is starting goroutines without a defined termination path. Every goroutine must have an explicit way to stop.

### The Done Channel Pattern

```go
// Goroutine with clean shutdown via done channel
func processEvents(ctx context.Context, events <-chan Event) {
    for {
        select {
        case event, ok := <-events:
            if !ok {
                return // Channel closed, exit
            }
            handleEvent(event)

        case <-ctx.Done():
            return // Context cancelled, exit
        }
    }
}
```

### Goroutine Tracking

```go
// WaitGroup ensures all goroutines complete before shutdown
func startWorkers(ctx context.Context, n int, work <-chan Task) {
    var wg sync.WaitGroup

    for i := 0; i < n; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case task, ok := <-work:
                    if !ok {
                        return
                    }
                    task.Execute(ctx)
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    // Wait for all workers to finish before returning
    wg.Wait()
}
```

## Worker Pool Pattern

A worker pool limits concurrent operations to a fixed number of goroutines. This prevents resource exhaustion when processing large queues of work.

### Basic Worker Pool

```go
package workerpool

import (
    "context"
    "sync"
)

// Task represents a unit of work
type Task func(ctx context.Context) error

// Pool executes tasks with bounded concurrency.
type Pool struct {
    workers int
    queue   chan Task
    wg      sync.WaitGroup
    cancel  context.CancelFunc
    ctx     context.Context
}

// New creates a worker pool with n concurrent workers.
func New(ctx context.Context, workers int, queueSize int) *Pool {
    poolCtx, cancel := context.WithCancel(ctx)
    p := &Pool{
        workers: workers,
        queue:   make(chan Task, queueSize),
        cancel:  cancel,
        ctx:     poolCtx,
    }
    p.start()
    return p
}

func (p *Pool) start() {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for {
                select {
                case task, ok := <-p.queue:
                    if !ok {
                        return
                    }
                    task(p.ctx)
                case <-p.ctx.Done():
                    return
                }
            }
        }()
    }
}

// Submit adds a task to the queue. Blocks if the queue is full.
func (p *Pool) Submit(task Task) {
    select {
    case p.queue <- task:
    case <-p.ctx.Done():
    }
}

// TrySubmit adds a task without blocking. Returns false if the queue is full.
func (p *Pool) TrySubmit(task Task) bool {
    select {
    case p.queue <- task:
        return true
    default:
        return false
    }
}

// Stop closes the queue and waits for all tasks to complete.
func (p *Pool) Stop() {
    close(p.queue)
    p.wg.Wait()
    p.cancel()
}
```

### Worker Pool with Error Collection

```go
package workerpool

import (
    "context"
    "sync"
    "sync/atomic"
)

// ResultTask returns an error for collection
type ResultTask[T any] func(ctx context.Context) (T, error)

// ResultPool collects both results and errors from workers.
type ResultPool[T any] struct {
    workers   int
    tasks     chan ResultTask[T]
    results   chan Result[T]
    wg        sync.WaitGroup
    errCount  atomic.Int64
}

type Result[T any] struct {
    Value T
    Err   error
}

func NewResultPool[T any](workers, queueSize int) *ResultPool[T] {
    p := &ResultPool[T]{
        workers: workers,
        tasks:   make(chan ResultTask[T], queueSize),
        results: make(chan Result[T], queueSize),
    }

    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for task := range p.tasks {
                value, err := task(context.Background())
                if err != nil {
                    p.errCount.Add(1)
                }
                p.results <- Result[T]{Value: value, Err: err}
            }
        }()
    }

    // Close results channel when all workers finish
    go func() {
        p.wg.Wait()
        close(p.results)
    }()

    return p
}

func (p *ResultPool[T]) Submit(task ResultTask[T]) {
    p.tasks <- task
}

func (p *ResultPool[T]) Close() {
    close(p.tasks)
}

func (p *ResultPool[T]) Results() <-chan Result[T] {
    return p.results
}

func (p *ResultPool[T]) ErrorCount() int64 {
    return p.errCount.Load()
}
```

## Semaphore Pattern

A semaphore limits concurrent access to a resource without blocking the caller unnecessarily.

```go
package semaphore

import "context"

// Semaphore limits concurrent operations using a buffered channel.
type Semaphore struct {
    ch chan struct{}
}

// New creates a semaphore with the given capacity.
func New(capacity int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, capacity)}
}

// Acquire acquires one token, blocking until available or context cancelled.
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryAcquire attempts non-blocking acquisition.
func (s *Semaphore) TryAcquire() bool {
    select {
    case s.ch <- struct{}{}:
        return true
    default:
        return false
    }
}

// Release returns one token to the pool.
func (s *Semaphore) Release() {
    <-s.ch
}

// Available returns the number of available tokens.
func (s *Semaphore) Available() int {
    return cap(s.ch) - len(s.ch)
}
```

### Semaphore Usage with Defer

```go
func processURLs(ctx context.Context, urls []string, concurrency int) []Result {
    sem := semaphore.New(concurrency)
    results := make([]Result, len(urls))
    var wg sync.WaitGroup

    for i, url := range urls {
        if err := sem.Acquire(ctx); err != nil {
            break // Context cancelled
        }

        wg.Add(1)
        go func(idx int, u string) {
            defer sem.Release()
            defer wg.Done()

            resp, err := http.Get(u)
            if err != nil {
                results[idx] = Result{URL: u, Err: err}
                return
            }
            defer resp.Body.Close()
            results[idx] = Result{URL: u, StatusCode: resp.StatusCode}
        }(i, url)
    }

    wg.Wait()
    return results
}
```

## errgroup for Concurrent Operations with Error Propagation

`golang.org/x/sync/errgroup` handles the common pattern of launching concurrent goroutines and collecting errors:

```go
package processor

import (
    "context"
    "fmt"

    "golang.org/x/sync/errgroup"
)

// ProcessConcurrently runs up to maxConcurrent tasks simultaneously.
// Returns the first error encountered; subsequent goroutines are cancelled.
func ProcessConcurrently(ctx context.Context, items []Item, maxConcurrent int) error {
    g, ctx := errgroup.WithContext(ctx)

    // Limit concurrency with semaphore
    sem := semaphore.New(maxConcurrent)

    for _, item := range items {
        item := item // Capture loop variable

        if err := sem.Acquire(ctx); err != nil {
            break
        }

        g.Go(func() error {
            defer sem.Release()

            if err := processItem(ctx, item); err != nil {
                return fmt.Errorf("processing item %s: %w", item.ID, err)
            }
            return nil
        })
    }

    // Wait for all goroutines; returns first non-nil error
    return g.Wait()
}
```

### Parallel Data Fetching

```go
// FetchParallel fetches multiple resources simultaneously,
// returning all results or the first error.
func FetchParallel(ctx context.Context, ids []string) ([]Product, error) {
    products := make([]Product, len(ids))

    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(10) // Limit to 10 concurrent goroutines (Go 1.20+)

    for i, id := range ids {
        i, id := i, id
        g.Go(func() error {
            p, err := fetchProduct(ctx, id)
            if err != nil {
                return fmt.Errorf("fetching product %s: %w", id, err)
            }
            products[i] = p
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return products, nil
}
```

## Fan-Out / Fan-In Patterns

Fan-out distributes work across multiple goroutines. Fan-in merges their output into a single channel.

### Fan-Out

```go
// fanOut distributes items from the input channel to n output channels
// using round-robin assignment.
func fanOut[T any](ctx context.Context, input <-chan T, n int) []<-chan T {
    outputs := make([]chan T, n)
    for i := range outputs {
        outputs[i] = make(chan T, cap(input))
    }

    go func() {
        defer func() {
            for _, ch := range outputs {
                close(ch)
            }
        }()

        i := 0
        for {
            select {
            case item, ok := <-input:
                if !ok {
                    return
                }
                outputs[i%n] <- item
                i++
            case <-ctx.Done():
                return
            }
        }
    }()

    result := make([]<-chan T, n)
    for i, ch := range outputs {
        result[i] = ch
    }
    return result
}
```

### Fan-In

```go
// fanIn merges multiple input channels into a single output channel.
func fanIn[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    output := make(chan T, len(inputs))
    var wg sync.WaitGroup

    merge := func(input <-chan T) {
        defer wg.Done()
        for {
            select {
            case item, ok := <-input:
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
    }

    wg.Add(len(inputs))
    for _, input := range inputs {
        go merge(input)
    }

    go func() {
        wg.Wait()
        close(output)
    }()

    return output
}
```

### Complete Fan-Out/Fan-In Pipeline

```go
package main

import (
    "context"
    "fmt"
    "sync"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Source: generate 1000 items
    source := generate(ctx, 1000)

    // Fan-out to 4 workers
    workerInputs := fanOut(ctx, source, 4)

    // Process in each worker
    workerOutputs := make([]<-chan ProcessedItem, 4)
    for i, input := range workerInputs {
        workerOutputs[i] = processWorker(ctx, i, input)
    }

    // Fan-in results
    results := fanIn(ctx, workerOutputs...)

    // Consume results
    var count int
    for result := range results {
        count++
        _ = result
    }
    fmt.Printf("Processed %d items\n", count)
}

func generate(ctx context.Context, n int) <-chan Item {
    ch := make(chan Item, 100)
    go func() {
        defer close(ch)
        for i := 0; i < n; i++ {
            select {
            case ch <- Item{ID: fmt.Sprintf("item-%d", i)}:
            case <-ctx.Done():
                return
            }
        }
    }()
    return ch
}

func processWorker(ctx context.Context, id int, input <-chan Item) <-chan ProcessedItem {
    output := make(chan ProcessedItem, 100)
    go func() {
        defer close(output)
        for {
            select {
            case item, ok := <-input:
                if !ok {
                    return
                }
                processed := ProcessedItem{
                    ID:       item.ID,
                    WorkerID: id,
                    Result:   fmt.Sprintf("processed by worker %d", id),
                }
                select {
                case output <- processed:
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

## Pipeline Stages

A pipeline chains stages where each stage reads from the previous and writes to the next:

```go
package pipeline

import "context"

// Stage represents a single pipeline stage function.
// It reads from input and writes transformed results to output.
type Stage[In, Out any] func(ctx context.Context, input <-chan In) <-chan Out

// Chain connects multiple stages, returning the final output channel.
// Each stage runs in its own goroutine.

// Example three-stage pipeline: fetch → transform → store
func BuildDocumentPipeline(ctx context.Context, docIDs <-chan string) <-chan StoreResult {
    // Stage 1: Fetch documents
    fetched := fetchDocuments(ctx, docIDs)

    // Stage 2: Transform (OCR, parse, index)
    transformed := transformDocuments(ctx, fetched)

    // Stage 3: Store results
    stored := storeDocuments(ctx, transformed)

    return stored
}

func fetchDocuments(ctx context.Context, ids <-chan string) <-chan FetchedDocument {
    output := make(chan FetchedDocument, 32)

    go func() {
        defer close(output)
        for {
            select {
            case id, ok := <-ids:
                if !ok {
                    return
                }
                doc, err := fetchDocument(ctx, id)
                result := FetchedDocument{ID: id, Doc: doc, Err: err}
                select {
                case output <- result:
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

func transformDocuments(ctx context.Context, input <-chan FetchedDocument) <-chan TransformedDocument {
    output := make(chan TransformedDocument, 32)

    // Use multiple goroutines for CPU-intensive transformation
    const workers = 4
    var wg sync.WaitGroup

    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case doc, ok := <-input:
                    if !ok {
                        return
                    }
                    if doc.Err != nil {
                        output <- TransformedDocument{ID: doc.ID, Err: doc.Err}
                        continue
                    }
                    transformed, err := transformDocument(ctx, doc.Doc)
                    select {
                    case output <- TransformedDocument{
                        ID:  doc.ID,
                        Doc: transformed,
                        Err: err,
                    }:
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

## Rate-Limited Worker Pool

Production services often need to respect upstream API rate limits:

```go
package ratelimited

import (
    "context"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// RateLimitedPool processes tasks subject to a rate limit.
type RateLimitedPool struct {
    workers int
    queue   chan Task
    limiter *rate.Limiter
    wg      sync.WaitGroup
}

type Task struct {
    ID      string
    Execute func(ctx context.Context) error
    OnError func(id string, err error)
}

func New(workers int, queueSize int, rateLimit rate.Limit, burst int) *RateLimitedPool {
    p := &RateLimitedPool{
        workers: workers,
        queue:   make(chan Task, queueSize),
        limiter: rate.NewLimiter(rateLimit, burst),
    }

    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go p.worker()
    }

    return p
}

func (p *RateLimitedPool) worker() {
    defer p.wg.Done()
    for task := range p.queue {
        // Wait for rate limit token
        ctx := context.Background()
        if err := p.limiter.Wait(ctx); err != nil {
            if task.OnError != nil {
                task.OnError(task.ID, err)
            }
            continue
        }

        if err := task.Execute(ctx); err != nil {
            if task.OnError != nil {
                task.OnError(task.ID, err)
            }
        }
    }
}

func (p *RateLimitedPool) Submit(task Task) {
    p.queue <- task
}

func (p *RateLimitedPool) Close() {
    close(p.queue)
    p.wg.Wait()
}
```

## Backpressure

Without backpressure, fast producers overwhelm slow consumers and cause unbounded memory growth.

### Backpressure via Bounded Channels

```go
// ProcessWithBackpressure demonstrates natural backpressure through bounded channels.
// When the consumer is slow, the producer blocks on channel send.
func ProcessWithBackpressure(ctx context.Context) error {
    // Small buffer: producer will block when consumer is behind
    workQueue := make(chan WorkItem, 100)

    // Producer goroutine
    producerErr := make(chan error, 1)
    go func() {
        defer close(workQueue)
        for i := 0; i < 10000; i++ {
            item := WorkItem{ID: i}
            select {
            case workQueue <- item:
                // Blocks here when queue is full — natural backpressure
            case <-ctx.Done():
                producerErr <- ctx.Err()
                return
            }
        }
        producerErr <- nil
    }()

    // Consumer processes at its own pace
    for {
        select {
        case item, ok := <-workQueue:
            if !ok {
                return <-producerErr
            }
            if err := processItem(ctx, item); err != nil {
                return err
            }
        case <-ctx.Done():
            return ctx.Err()
        }
    }
}
```

### Backpressure with Drop Policy

```go
// DroppingProducer drops items when the consumer cannot keep up,
// emitting a metric for dropped work.
type DroppingProducer struct {
    queue    chan WorkItem
    dropped  atomic.Int64
    capacity int
}

func NewDroppingProducer(capacity int) *DroppingProducer {
    return &DroppingProducer{
        queue:    make(chan WorkItem, capacity),
        capacity: capacity,
    }
}

func (p *DroppingProducer) Produce(item WorkItem) bool {
    select {
    case p.queue <- item:
        return true
    default:
        p.dropped.Add(1)
        return false
    }
}

func (p *DroppingProducer) Dropped() int64 {
    return p.dropped.Load()
}

func (p *DroppingProducer) Queue() <-chan WorkItem {
    return p.queue
}
```

## Context Propagation Through Pipelines

Every stage must respect context cancellation:

```go
// ContextAwarePipeline demonstrates proper context propagation
func ContextAwarePipeline(ctx context.Context, input <-chan Item) <-chan Result {
    output := make(chan Result, 64)

    go func() {
        defer close(output)

        for {
            select {
            case item, ok := <-input:
                if !ok {
                    return // Input exhausted
                }

                // Pass context to each operation
                result, err := processWithTimeout(ctx, item)

                // Non-blocking send with context awareness
                select {
                case output <- Result{Item: item, Value: result, Err: err}:
                case <-ctx.Done():
                    return // Stop when context cancelled
                }

            case <-ctx.Done():
                return
            }
        }
    }()

    return output
}

func processWithTimeout(ctx context.Context, item Item) (string, error) {
    // Create per-item timeout
    itemCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resultCh := make(chan string, 1)
    errCh := make(chan error, 1)

    go func() {
        result, err := expensiveOperation(item)
        if err != nil {
            errCh <- err
        } else {
            resultCh <- result
        }
    }()

    select {
    case result := <-resultCh:
        return result, nil
    case err := <-errCh:
        return "", err
    case <-itemCtx.Done():
        return "", fmt.Errorf("processing item %s: %w", item.ID, itemCtx.Err())
    }
}
```

## Batch Processing Pattern

Accumulate items for more efficient batch processing:

```go
package batch

import (
    "context"
    "time"
)

// Batcher accumulates items and flushes when either the batch size
// or the flush interval is reached, whichever comes first.
type Batcher[T any] struct {
    input    <-chan T
    maxSize  int
    interval time.Duration
    flush    func(ctx context.Context, batch []T) error
}

func NewBatcher[T any](
    input <-chan T,
    maxSize int,
    interval time.Duration,
    flush func(ctx context.Context, batch []T) error,
) *Batcher[T] {
    return &Batcher[T]{
        input:    input,
        maxSize:  maxSize,
        interval: interval,
        flush:    flush,
    }
}

func (b *Batcher[T]) Run(ctx context.Context) error {
    batch := make([]T, 0, b.maxSize)
    timer := time.NewTimer(b.interval)
    defer timer.Stop()

    flushBatch := func() error {
        if len(batch) == 0 {
            return nil
        }
        err := b.flush(ctx, batch)
        batch = batch[:0] // Reset without reallocation
        timer.Reset(b.interval)
        return err
    }

    for {
        select {
        case item, ok := <-b.input:
            if !ok {
                // Input closed: flush remaining items
                return flushBatch()
            }

            batch = append(batch, item)

            if len(batch) >= b.maxSize {
                if err := flushBatch(); err != nil {
                    return err
                }
            }

        case <-timer.C:
            if err := flushBatch(); err != nil {
                return err
            }

        case <-ctx.Done():
            // Flush on shutdown for at-least-once delivery
            _ = flushBatch()
            return ctx.Err()
        }
    }
}
```

## Detecting Goroutine Leaks in Tests

```go
package main_test

import (
    "runtime"
    "testing"
    "time"
)

func goroutineCount() int {
    return runtime.NumGoroutine()
}

func TestNoGoroutineLeak(t *testing.T) {
    initial := goroutineCount()

    // Run the code under test
    ctx, cancel := context.WithCancel(context.Background())
    pool := workerpool.New(ctx, 10, 100)

    for i := 0; i < 100; i++ {
        pool.Submit(func(ctx context.Context) error {
            time.Sleep(time.Millisecond)
            return nil
        })
    }

    pool.Stop()
    cancel()

    // Give goroutines a moment to exit
    time.Sleep(10 * time.Millisecond)

    final := goroutineCount()
    if final > initial+1 { // +1 for test goroutine
        t.Errorf("goroutine leak: started with %d, ended with %d", initial, final)
    }
}
```

## Production Monitoring

```go
// Expose worker pool metrics via Prometheus
var (
    workerQueueDepth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
        Name: "worker_pool_queue_depth",
        Help: "Current number of tasks waiting in the worker pool queue",
    }, []string{"pool_name"})

    workerTasksProcessed = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "worker_pool_tasks_total",
        Help: "Total tasks processed by the worker pool",
    }, []string{"pool_name", "result"})

    workerTaskDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "worker_pool_task_duration_seconds",
        Help:    "Duration of task execution in the worker pool",
        Buckets: prometheus.DefBuckets,
    }, []string{"pool_name"})
)

// InstrumentedPool wraps a pool with Prometheus metrics
type InstrumentedPool struct {
    *Pool
    name string
}

func (p *InstrumentedPool) Submit(task Task) {
    p.Pool.Submit(func(ctx context.Context) error {
        workerQueueDepth.WithLabelValues(p.name).Dec()
        start := time.Now()

        err := task(ctx)

        duration := time.Since(start)
        workerTaskDuration.WithLabelValues(p.name).Observe(duration.Seconds())

        result := "success"
        if err != nil {
            result = "error"
        }
        workerTasksProcessed.WithLabelValues(p.name, result).Inc()

        return err
    })
    workerQueueDepth.WithLabelValues(p.name).Inc()
}
```

## Summary

Production Go concurrency requires disciplined application of a small set of well-understood patterns:

- **Bounded worker pools** prevent goroutine and memory explosion under load
- **Semaphores** provide flexible concurrency limits without dedicated goroutines
- **errgroup** coordinates concurrent operations and propagates the first error
- **Fan-out/fan-in** parallelizes independent work across multiple goroutines and merges results
- **Pipelines** chain stages of transformations with clean separation of concerns
- **Backpressure** via bounded channels prevents producers from overwhelming consumers
- **Batchers** amortize I/O overhead by accumulating items before flushing
- Context propagation through every goroutine and channel select ensures clean shutdown

The most important rule: every goroutine must have a defined exit path. Using `context.Context` consistently and always `close()`-ing channels when the producer is done ensures that goroutines terminate predictably and resources are released.
