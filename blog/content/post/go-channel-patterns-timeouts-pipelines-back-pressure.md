---
title: "Go Channel Patterns: Timeouts, Pipelines, and Back-Pressure Implementation"
date: 2030-04-19T00:00:00-05:00
draft: false
tags: ["Go", "Channels", "Concurrency", "Pipelines", "Back-Pressure", "Goroutines", "Production"]
categories: ["Go", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go channel patterns: timeout-aware operations, multi-stage pipelines with cancellation, back-pressure via buffered channels, goroutine lifecycle management, and channel-based rate limiting."
more_link: "yes"
url: "/go-channel-patterns-timeouts-pipelines-back-pressure/"
---

Go channels are not just a synchronization mechanism — they are a design tool for expressing data flow, back-pressure, and cancellation in concurrent systems. Most Go programmers start with basic `make(chan T)` usage and never explore the full design space that channels enable. Production systems require more: pipelines where slow consumers signal back to fast producers, timeout-aware operations that do not leak goroutines, fan-out and fan-in for parallel processing, and back-pressure mechanisms that prevent memory exhaustion under load. This guide covers the complete production-grade channel pattern toolkit with working, benchmarked implementations.

<!--more-->

## Channel Fundamentals for Production Systems

Before diving into patterns, some production gotchas that are easy to miss:

```go
package main

import (
    "context"
    "fmt"
    "runtime"
    "time"
)

// Gotcha 1: Sending to a nil channel blocks forever
// Gotcha 2: Receiving from a nil channel blocks forever  
// Gotcha 3: Closing a nil channel panics
// Gotcha 4: Closing an already-closed channel panics
// Gotcha 5: Sending to a closed channel panics

// Safe close: only close when you are the sole writer
func safeSend[T any](ch chan<- T, v T) (sent bool) {
    defer func() {
        if r := recover(); r != nil {
            sent = false
        }
    }()
    ch <- v
    return true
}

// Check goroutine count - vital for detecting leaks
func goroutineCount() int {
    return runtime.NumGoroutine()
}

// Drain a channel completely before closing
func drainAndClose[T any](ch chan T) {
    for {
        select {
        case _, ok := <-ch:
            if !ok {
                return // channel already closed
            }
        default:
            close(ch)
            return
        }
    }
}
```

## Timeout-Aware Channel Operations

The `select` statement with `time.After` is the building block for all timeout-aware operations. But `time.After` creates a new timer that is not garbage collected until it fires. For high-frequency timeout operations, use `time.NewTimer` and reset it.

### Basic Timeout Patterns

```go
package patterns

import (
    "context"
    "errors"
    "fmt"
    "time"
)

var (
    ErrTimeout  = errors.New("operation timed out")
    ErrCanceled = errors.New("operation canceled")
    ErrClosed   = errors.New("channel closed")
)

// SendWithTimeout sends to a channel with a deadline
func SendWithTimeout[T any](ctx context.Context, ch chan<- T, v T, timeout time.Duration) error {
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case ch <- v:
        return nil
    case <-timer.C:
        return fmt.Errorf("%w: send after %v", ErrTimeout, timeout)
    case <-ctx.Done():
        return fmt.Errorf("%w: %v", ErrCanceled, ctx.Err())
    }
}

// RecvWithTimeout receives from a channel with a deadline
func RecvWithTimeout[T any](ctx context.Context, ch <-chan T, timeout time.Duration) (T, error) {
    var zero T
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case v, ok := <-ch:
        if !ok {
            return zero, ErrClosed
        }
        return v, nil
    case <-timer.C:
        return zero, fmt.Errorf("%w: recv after %v", ErrTimeout, timeout)
    case <-ctx.Done():
        return zero, fmt.Errorf("%w: %v", ErrCanceled, ctx.Err())
    }
}

// TrySend is a non-blocking send (returns false if channel is full)
func TrySend[T any](ch chan<- T, v T) bool {
    select {
    case ch <- v:
        return true
    default:
        return false
    }
}

// TryRecv is a non-blocking receive (returns zero value and false if empty)
func TryRecv[T any](ch <-chan T) (T, bool) {
    select {
    case v := <-ch:
        return v, true
    default:
        var zero T
        return zero, false
    }
}
```

### Rate Limiter with Token Bucket via Channels

```go
// TokenBucket implements a rate limiter using channels
type TokenBucket struct {
    tokens chan struct{}
    done   chan struct{}
}

func NewTokenBucket(rate int, burst int) *TokenBucket {
    tb := &TokenBucket{
        tokens: make(chan struct{}, burst),
        done:   make(chan struct{}),
    }

    // Pre-fill burst capacity
    for i := 0; i < burst; i++ {
        tb.tokens <- struct{}{}
    }

    // Refill goroutine
    go func() {
        ticker := time.NewTicker(time.Second / time.Duration(rate))
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                // Add a token (non-blocking - drop if full)
                select {
                case tb.tokens <- struct{}{}:
                default:
                    // Bucket is full, discard token
                }
            case <-tb.done:
                return
            }
        }
    }()

    return tb
}

// Wait blocks until a token is available
func (tb *TokenBucket) Wait(ctx context.Context) error {
    select {
    case <-tb.tokens:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryConsume returns true if a token was immediately available
func (tb *TokenBucket) TryConsume() bool {
    select {
    case <-tb.tokens:
        return true
    default:
        return false
    }
}

func (tb *TokenBucket) Close() {
    close(tb.done)
}
```

## Multi-Stage Pipeline with Cancellation

A pipeline processes data through stages, where each stage reads from an input channel, transforms the data, and writes to an output channel. Proper pipeline design ensures that cancellation propagates through all stages and goroutines are not leaked.

### Generic Pipeline Stage

```go
package pipeline

import (
    "context"
    "sync"
)

// Stage represents a single pipeline processing function
type Stage[In, Out any] struct {
    Name        string
    Workers     int
    ProcessFunc func(ctx context.Context, in In) (Out, error)
    ErrHandler  func(in In, err error) // called on error (can be nil)
}

// Run starts the stage: reads from in, transforms, writes to the returned channel
func (s *Stage[In, Out]) Run(ctx context.Context, in <-chan In) <-chan Out {
    out := make(chan Out, s.Workers) // buffer by number of workers
    workers := s.Workers
    if workers < 1 {
        workers = 1
    }

    var wg sync.WaitGroup
    wg.Add(workers)

    for i := 0; i < workers; i++ {
        go func() {
            defer wg.Done()

            for {
                select {
                case v, ok := <-in:
                    if !ok {
                        return // input closed
                    }

                    result, err := s.ProcessFunc(ctx, v)
                    if err != nil {
                        if s.ErrHandler != nil {
                            s.ErrHandler(v, err)
                        }
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
    }

    // Close output when all workers are done
    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}
```

### Complete Pipeline Example: Log Processing

```go
package main

import (
    "context"
    "fmt"
    "log"
    "regexp"
    "strings"
    "time"
)

type RawLog struct {
    Timestamp time.Time
    Raw       string
    Source    string
}

type ParsedLog struct {
    Timestamp time.Time
    Level     string
    Message   string
    Fields    map[string]string
    Source    string
}

type AlertEvent struct {
    ParsedLog
    AlertLevel string
    AlertRule  string
}

// Stage 1: Parse raw log lines
func parseStage(ctx context.Context, raw RawLog) (ParsedLog, error) {
    // Parse JSON logs: {"level":"error","msg":"connection refused","host":"db-01"}
    parsed := ParsedLog{
        Timestamp: raw.Timestamp,
        Source:    raw.Source,
        Fields:    make(map[string]string),
    }

    if strings.HasPrefix(raw.Raw, "{") {
        // Simple JSON field extraction (use encoding/json in production)
        if m := regexp.MustCompile(`"level":"([^"]+)"`).FindStringSubmatch(raw.Raw); m != nil {
            parsed.Level = m[1]
        }
        if m := regexp.MustCompile(`"msg":"([^"]+)"`).FindStringSubmatch(raw.Raw); m != nil {
            parsed.Message = m[1]
        }
    } else {
        // Plain text
        parts := strings.SplitN(raw.Raw, " ", 3)
        if len(parts) >= 2 {
            parsed.Level   = parts[0]
            parsed.Message = strings.Join(parts[1:], " ")
        }
    }

    return parsed, nil
}

// Stage 2: Enrich with metadata
func enrichStage(ctx context.Context, log ParsedLog) (ParsedLog, error) {
    // In production: look up host metadata, user info, etc.
    log.Fields["processed_at"] = time.Now().UTC().Format(time.RFC3339)
    log.Fields["pipeline"] = "main"
    return log, nil
}

// Stage 3: Alert on error patterns
func alertStage(ctx context.Context, entry ParsedLog) (AlertEvent, error) {
    alert := AlertEvent{ParsedLog: entry}

    switch strings.ToLower(entry.Level) {
    case "error", "fatal", "critical":
        alert.AlertLevel = "high"
        alert.AlertRule = "error-level-log"
    case "warn", "warning":
        if strings.Contains(strings.ToLower(entry.Message), "timeout") {
            alert.AlertLevel = "medium"
            alert.AlertRule = "timeout-warning"
        }
    }

    return alert, nil
}

func buildLogPipeline(ctx context.Context, source <-chan RawLog) <-chan AlertEvent {
    // Stage 1: Parse (4 workers)
    parseStg := &Stage[RawLog, ParsedLog]{
        Name:        "parse",
        Workers:     4,
        ProcessFunc: parseStage,
    }
    parsed := parseStg.Run(ctx, source)

    // Stage 2: Enrich (2 workers)
    enrichStg := &Stage[ParsedLog, ParsedLog]{
        Name:        "enrich",
        Workers:     2,
        ProcessFunc: enrichStage,
    }
    enriched := enrichStg.Run(ctx, parsed)

    // Stage 3: Alert detection (1 worker)
    alertStg := &Stage[ParsedLog, AlertEvent]{
        Name:        "alert",
        Workers:     1,
        ProcessFunc: alertStage,
    }
    return alertStg.Run(ctx, enriched)
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Source: generate test log lines
    source := make(chan RawLog, 100)
    go func() {
        defer close(source)
        messages := []string{
            `{"level":"info","msg":"server started","port":8080}`,
            `{"level":"error","msg":"connection refused","host":"db-01"}`,
            `{"level":"warn","msg":"request timeout","latency_ms":5000}`,
            `{"level":"info","msg":"request processed","status":200}`,
        }
        for i := 0; i < 100; i++ {
            select {
            case source <- RawLog{
                Timestamp: time.Now(),
                Raw:       messages[i%len(messages)],
                Source:    fmt.Sprintf("node-%02d", i%5),
            }:
            case <-ctx.Done():
                return
            }
        }
    }()

    alerts := buildLogPipeline(ctx, source)

    // Consume alerts
    count := 0
    for alert := range alerts {
        if alert.AlertLevel != "" {
            log.Printf("ALERT [%s] %s: %s",
                alert.AlertLevel, alert.AlertRule, alert.Message)
        }
        count++
    }
    log.Printf("Processed %d log entries", count)
}
```

## Fan-Out and Fan-In

Fan-out distributes work across multiple goroutines. Fan-in merges multiple channels into one.

```go
package fanout

import (
    "context"
    "sync"
)

// FanOut distributes items from src to n output channels (round-robin)
func FanOut[T any](ctx context.Context, src <-chan T, n int) []<-chan T {
    outs := make([]chan T, n)
    for i := range outs {
        outs[i] = make(chan T, 1)
    }

    go func() {
        defer func() {
            for _, ch := range outs {
                close(ch)
            }
        }()

        i := 0
        for {
            select {
            case v, ok := <-src:
                if !ok {
                    return
                }
                // Send to output i (with context cancellation)
                select {
                case outs[i%n] <- v:
                case <-ctx.Done():
                    return
                }
                i++
            case <-ctx.Done():
                return
            }
        }
    }()

    // Return as read-only
    result := make([]<-chan T, n)
    for i, ch := range outs {
        result[i] = ch
    }
    return result
}

// FanIn merges multiple input channels into a single output channel
func FanIn[T any](ctx context.Context, ins ...<-chan T) <-chan T {
    out := make(chan T, len(ins))
    var wg sync.WaitGroup

    for _, in := range ins {
        wg.Add(1)
        go func(ch <-chan T) {
            defer wg.Done()
            for {
                select {
                case v, ok := <-ch:
                    if !ok {
                        return
                    }
                    select {
                    case out <- v:
                    case <-ctx.Done():
                        return
                    }
                case <-ctx.Done():
                    return
                }
            }
        }(in)
    }

    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}

// WorkPool distributes work to a fixed pool of workers
type WorkPool[T, R any] struct {
    workers int
    fn      func(context.Context, T) (R, error)
}

func NewWorkPool[T, R any](workers int, fn func(context.Context, T) (R, error)) *WorkPool[T, R] {
    return &WorkPool[T, R]{workers: workers, fn: fn}
}

type Result[T, R any] struct {
    Input  T
    Output R
    Err    error
}

func (p *WorkPool[T, R]) Process(ctx context.Context, in <-chan T) <-chan Result[T, R] {
    out := make(chan Result[T, R], p.workers)
    var wg sync.WaitGroup
    wg.Add(p.workers)

    for i := 0; i < p.workers; i++ {
        go func() {
            defer wg.Done()
            for {
                select {
                case v, ok := <-in:
                    if !ok {
                        return
                    }
                    result, err := p.fn(ctx, v)
                    select {
                    case out <- Result[T, R]{Input: v, Output: result, Err: err}:
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
        close(out)
    }()

    return out
}
```

## Back-Pressure Implementation

Back-pressure is the mechanism by which a slow consumer signals to a fast producer to slow down. Without back-pressure, a fast producer fills unbounded queues until memory is exhausted. The correct Go implementation uses bounded buffered channels.

```go
package backpressure

import (
    "context"
    "fmt"
    "sync/atomic"
    "time"
)

// BoundedQueue implements back-pressure via a bounded buffered channel
// When full, producers either block, drop, or get an error
type BoundedQueue[T any] struct {
    ch       chan T
    dropped  atomic.Int64
    enqueued atomic.Int64
}

func NewBoundedQueue[T any](capacity int) *BoundedQueue[T] {
    return &BoundedQueue[T]{
        ch: make(chan T, capacity),
    }
}

// Enqueue blocks until space is available or context is cancelled
func (q *BoundedQueue[T]) Enqueue(ctx context.Context, item T) error {
    select {
    case q.ch <- item:
        q.enqueued.Add(1)
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryEnqueue returns immediately - drops item if queue is full
func (q *BoundedQueue[T]) TryEnqueue(item T) bool {
    select {
    case q.ch <- item:
        q.enqueued.Add(1)
        return true
    default:
        q.dropped.Add(1)
        return false
    }
}

// EnqueueWithTimeout blocks for at most timeout duration
func (q *BoundedQueue[T]) EnqueueWithTimeout(item T, timeout time.Duration) error {
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case q.ch <- item:
        q.enqueued.Add(1)
        return nil
    case <-timer.C:
        q.dropped.Add(1)
        return fmt.Errorf("queue full: dropped item after %v", timeout)
    }
}

// Dequeue blocks until an item is available or context is cancelled
func (q *BoundedQueue[T]) Dequeue(ctx context.Context) (T, error) {
    select {
    case item := <-q.ch:
        return item, nil
    case <-ctx.Done():
        var zero T
        return zero, ctx.Err()
    }
}

// Channel returns the underlying channel for use in select statements
func (q *BoundedQueue[T]) Channel() <-chan T { return q.ch }

// Stats returns queue health metrics
func (q *BoundedQueue[T]) Stats() map[string]int64 {
    return map[string]int64{
        "length":    int64(len(q.ch)),
        "capacity":  int64(cap(q.ch)),
        "enqueued":  q.enqueued.Load(),
        "dropped":   q.dropped.Load(),
    }
}

// Utilization returns queue fill ratio (0.0 - 1.0)
func (q *BoundedQueue[T]) Utilization() float64 {
    return float64(len(q.ch)) / float64(cap(q.ch))
}
```

### Adaptive Back-Pressure

```go
// AdaptiveProducer adjusts its rate based on consumer queue depth
type AdaptiveProducer[T any] struct {
    queue    *BoundedQueue[T]
    minDelay time.Duration
    maxDelay time.Duration
    current  time.Duration
}

func NewAdaptiveProducer[T any](q *BoundedQueue[T]) *AdaptiveProducer[T] {
    return &AdaptiveProducer[T]{
        queue:    q,
        minDelay: 1 * time.Millisecond,
        maxDelay: 100 * time.Millisecond,
        current:  1 * time.Millisecond,
    }
}

func (p *AdaptiveProducer[T]) Send(ctx context.Context, item T) error {
    // Adjust delay based on queue utilization
    utilization := p.queue.Utilization()

    switch {
    case utilization > 0.90:
        // Queue almost full: maximum slowdown
        p.current = p.maxDelay
    case utilization > 0.75:
        // Queue getting full: increase delay
        p.current = p.current * 2
        if p.current > p.maxDelay {
            p.current = p.maxDelay
        }
    case utilization < 0.25:
        // Queue mostly empty: speed up
        p.current = p.current / 2
        if p.current < p.minDelay {
            p.current = p.minDelay
        }
    }

    // Apply delay
    if p.current > p.minDelay {
        select {
        case <-time.After(p.current):
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    return p.queue.Enqueue(ctx, item)
}
```

## Goroutine Lifecycle Management

Production systems must track goroutine lifetimes to prevent leaks. A goroutine leak is a goroutine that is blocked indefinitely — typically on a channel receive with no sender, or a channel send to a full channel with no receiver.

```go
package lifecycle

import (
    "context"
    "fmt"
    "runtime"
    "sync"
    "sync/atomic"
    "time"
)

// GoroutineGroup tracks a group of related goroutines
type GoroutineGroup struct {
    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup
    count  atomic.Int64
    name   string
}

func NewGoroutineGroup(ctx context.Context, name string) *GoroutineGroup {
    ctx2, cancel := context.WithCancel(ctx)
    return &GoroutineGroup{
        ctx:    ctx2,
        cancel: cancel,
        name:   name,
    }
}

// Go starts a goroutine tracked by this group
func (g *GoroutineGroup) Go(fn func(ctx context.Context)) {
    g.wg.Add(1)
    g.count.Add(1)

    go func() {
        defer g.wg.Done()
        defer g.count.Add(-1)
        fn(g.ctx)
    }()
}

// Stop cancels the group's context and waits for all goroutines to finish
func (g *GoroutineGroup) Stop() {
    g.cancel()
    g.wg.Wait()
}

// StopWithTimeout cancels and waits, returning an error if goroutines don't finish
func (g *GoroutineGroup) StopWithTimeout(timeout time.Duration) error {
    g.cancel()

    done := make(chan struct{})
    go func() {
        g.wg.Wait()
        close(done)
    }()

    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case <-done:
        return nil
    case <-timer.C:
        return fmt.Errorf("goroutine group %q: %d goroutines still running after %v",
            g.name, g.count.Load(), timeout)
    }
}

// Count returns the current number of running goroutines in this group
func (g *GoroutineGroup) Count() int64 {
    return g.count.Load()
}

// LeakDetector monitors goroutine counts for leaks
type LeakDetector struct {
    baseline int
    mu       sync.Mutex
}

func NewLeakDetector() *LeakDetector {
    return &LeakDetector{baseline: runtime.NumGoroutine()}
}

func (d *LeakDetector) Check(tolerance int) error {
    d.mu.Lock()
    defer d.mu.Unlock()

    current := runtime.NumGoroutine()
    diff := current - d.baseline
    if diff > tolerance {
        // Dump goroutine stacks for diagnosis
        buf := make([]byte, 1<<20)
        n := runtime.Stack(buf, true)
        return fmt.Errorf("goroutine leak detected: +%d goroutines (tolerance %d)\n%s",
            diff, tolerance, buf[:n])
    }
    return nil
}

func (d *LeakDetector) Reset() {
    d.mu.Lock()
    defer d.mu.Unlock()
    d.baseline = runtime.NumGoroutine()
}
```

## Channel-Based Semaphore for Concurrency Control

```go
// Semaphore using a buffered channel
type Semaphore struct {
    ch chan struct{}
}

func NewSemaphore(n int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, n)}
}

func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (s *Semaphore) Release() {
    <-s.ch
}

func (s *Semaphore) TryAcquire() bool {
    select {
    case s.ch <- struct{}{}:
        return true
    default:
        return false
    }
}

// Run executes fn with semaphore protection
func (s *Semaphore) Run(ctx context.Context, fn func() error) error {
    if err := s.Acquire(ctx); err != nil {
        return err
    }
    defer s.Release()
    return fn()
}

// Limit number of concurrent HTTP requests to a specific host
type ConcurrentHTTPClient struct {
    sem *Semaphore
    // http.Client fields...
}

func NewConcurrentHTTPClient(maxConcurrent int) *ConcurrentHTTPClient {
    return &ConcurrentHTTPClient{
        sem: NewSemaphore(maxConcurrent),
    }
}
```

## Production Pattern: Work Queue with Dead-Letter Channel

```go
package workqueue

import (
    "context"
    "fmt"
    "log"
    "time"
)

type Job struct {
    ID      string
    Payload interface{}
    Attempt int
    Created time.Time
}

type WorkQueue struct {
    jobs       chan Job
    deadLetter chan Job
    maxRetries int
    workers    int
    processFunc func(context.Context, Job) error
}

func NewWorkQueue(capacity, workers, maxRetries int,
    fn func(context.Context, Job) error) *WorkQueue {

    return &WorkQueue{
        jobs:        make(chan Job, capacity),
        deadLetter:  make(chan Job, capacity/10), // 10% of main queue
        maxRetries:  maxRetries,
        workers:     workers,
        processFunc: fn,
    }
}

func (wq *WorkQueue) Submit(ctx context.Context, job Job) error {
    job.Created = time.Now()
    select {
    case wq.jobs <- job:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    default:
        return fmt.Errorf("work queue full: job %s dropped", job.ID)
    }
}

func (wq *WorkQueue) Run(ctx context.Context) {
    for i := 0; i < wq.workers; i++ {
        go wq.worker(ctx, i)
    }

    // Dead-letter monitor
    go func() {
        for {
            select {
            case job := <-wq.deadLetter:
                log.Printf("DEAD-LETTER: job %s failed after %d attempts",
                    job.ID, job.Attempt)
                // In production: write to database, send alert
            case <-ctx.Done():
                return
            }
        }
    }()
}

func (wq *WorkQueue) worker(ctx context.Context, id int) {
    for {
        select {
        case job, ok := <-wq.jobs:
            if !ok {
                return
            }

            // Process with timeout
            processCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
            err := wq.processFunc(processCtx, job)
            cancel()

            if err != nil {
                job.Attempt++
                if job.Attempt < wq.maxRetries {
                    // Requeue with exponential backoff
                    backoff := time.Duration(job.Attempt) * 500 * time.Millisecond
                    time.AfterFunc(backoff, func() {
                        select {
                        case wq.jobs <- job:
                        default:
                            // Queue full: send to dead-letter
                            select {
                            case wq.deadLetter <- job:
                            default:
                                log.Printf("LOST: job %s (dead-letter also full)", job.ID)
                            }
                        }
                    })
                } else {
                    // Max retries exceeded: dead-letter
                    select {
                    case wq.deadLetter <- job:
                    default:
                        log.Printf("LOST: job %s (dead-letter full)", job.ID)
                    }
                }
            }

        case <-ctx.Done():
            return
        }
    }
}
```

## Benchmarking Channel Patterns

```go
package patterns_test

import (
    "context"
    "testing"
)

func BenchmarkUnbufferedSend(b *testing.B) {
    ch := make(chan int)
    go func() {
        for range ch {}
    }()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        ch <- i
    }
    close(ch)
}

func BenchmarkBufferedSend(b *testing.B) {
    ch := make(chan int, 1024)
    go func() {
        for range ch {}
    }()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        ch <- i
    }
    close(ch)
}

func BenchmarkSelectTwo(b *testing.B) {
    ch1 := make(chan int, 1)
    ch2 := make(chan int, 1)

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        ch1 <- i
        select {
        case v := <-ch1:
            _ = v
        case v := <-ch2:
            _ = v
        }
    }
}

func BenchmarkBoundedQueueThroughput(b *testing.B) {
    q := NewBoundedQueue[int](1024)
    ctx := context.Background()

    // Consumer
    go func() {
        for {
            _, err := q.Dequeue(ctx)
            if err != nil {
                return
            }
        }
    }()

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        q.Enqueue(ctx, i)
    }
}
```

Run the benchmarks:

```bash
go test -bench=. -benchmem -benchtime=3s ./...

# Expected results (approximate, varies by hardware):
# BenchmarkUnbufferedSend-8    50000000    29 ns/op    0 B/op    0 allocs/op
# BenchmarkBufferedSend-8     200000000    8 ns/op     0 B/op    0 allocs/op
# BenchmarkSelectTwo-8        100000000    12 ns/op    0 B/op    0 allocs/op
```

## Key Takeaways

Go channels are zero-overhead synchronization primitives when used correctly, and significant sources of latency and goroutine leaks when used incorrectly. The patterns here represent production-proven designs:

**Timeout patterns**: Always use `time.NewTimer` + `defer timer.Stop()` rather than `time.After` in hot paths. The garbage collection delay on unfired `time.After` timers is measurable at high concurrency.

**Pipeline design**: Every stage should have a bounded output channel buffer sized to the number of workers in that stage. This provides natural back-pressure while minimizing blocking between stages.

**Back-pressure**: A `BoundedQueue` with `TryEnqueue` (drop policy) is correct for logs and metrics where losing data under load is acceptable. A blocking `Enqueue` with context cancellation is correct for work that must eventually be processed.

**Goroutine lifecycle**: Use `sync.WaitGroup` and context cancellation consistently. Every goroutine must have a clear termination condition. The `GoroutineGroup` abstraction makes this composable and testable.

**Fan-out vs worker pools**: Fan-out (fixed N outputs, round-robin) is correct when work must be processed in order per output channel. Worker pools (N workers, shared input channel) are correct when order does not matter and load-balancing is desired.

**Leak detection**: Add goroutine count assertions to your integration tests. A test that starts workers and verifies the goroutine count returns to baseline after `Stop()` catches 90% of leak bugs before production.
