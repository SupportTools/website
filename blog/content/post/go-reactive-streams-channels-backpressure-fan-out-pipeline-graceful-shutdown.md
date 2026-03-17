---
title: "Go Reactive Streams with Channels: Backpressure, Fan-Out/Fan-In, Pipeline Stages, and Graceful Shutdown"
date: 2031-11-06T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Concurrency", "Channels", "Reactive Streams", "Pipelines", "Backpressure"]
categories: ["Go", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to building reactive stream pipelines in Go using channels with proper backpressure, fan-out/fan-in topologies, multi-stage processing, and clean shutdown semantics."
more_link: "yes"
url: "/go-reactive-streams-channels-backpressure-fan-out-fan-in-pipeline-graceful-shutdown/"
---

Go's channel-based concurrency model maps naturally onto reactive stream concepts: sources emit values, stages transform or filter them, sinks consume them, and the bounded channel buffer provides the mechanism for backpressure. This post builds a complete reactive stream toolkit in idiomatic Go, covering backpressure propagation, fan-out/fan-in topologies, multi-stage pipeline assembly, error propagation, and the canonical graceful shutdown pattern.

<!--more-->

# Go Reactive Streams with Channels: Backpressure, Fan-Out/Fan-In, Pipeline Stages, and Graceful Shutdown

## Why Channel Pipelines Over External Frameworks

Go's standard library provides everything needed for reactive streams:

- **Goroutines** as lightweight processing units
- **Channels** as typed, bounded queues
- **select** for multiplexing
- **context.Context** for cancellation propagation
- **sync.WaitGroup** and **sync.ErrGroup** for coordinated shutdown

External reactive frameworks (RxGo, ReactiveX) add abstraction but also add complexity that hides the runtime behavior. When something goes wrong under production load, you want to reason directly about goroutines and channels, not library internals.

## Section 1: Foundational Types

### 1.1 Stream and Stage Definitions

```go
// stream/types.go
package stream

import "context"

// Item is a typed value flowing through the pipeline.
// Using generics keeps the pipeline type-safe without interface{} casts.
type Item[T any] struct {
    Value T
    Err   error
}

// Stage is a function that transforms an input channel into an output channel.
// The output channel is created and owned by the stage.
type Stage[In, Out any] func(ctx context.Context, in <-chan Item[In]) <-chan Item[Out]

// Source creates a channel from a push function.
type Source[T any] func(ctx context.Context) <-chan Item[T]

// Sink consumes all items from a channel and blocks until done or ctx cancels.
type Sink[T any] func(ctx context.Context, in <-chan Item[T]) error
```

### 1.2 Bounded Channel Buffer Sizing

Choosing buffer sizes correctly is the foundation of backpressure. Too small and you serialize producer and consumer. Too large and you mask slow consumers while allowing unbounded memory growth.

```go
// stream/buffer.go
package stream

import (
    "runtime"
    "time"
)

// BufferPolicy controls how a stage's output channel is sized.
type BufferPolicy struct {
    // Fixed sets an absolute buffer size.
    Fixed int

    // PerWorker multiplies the buffer by the number of goroutines in a stage.
    PerWorker int

    // MaxLatency is the target maximum latency budget for one item.
    // Combined with a measured throughput, this determines the minimum
    // buffer needed to prevent blocking.
    MaxLatency time.Duration

    // MeasuredThroughputPerSecond is used with MaxLatency to compute buffer size.
    MeasuredThroughputPerSecond float64
}

// Size returns the concrete buffer size for this policy.
func (p BufferPolicy) Size(workers int) int {
    if p.Fixed > 0 {
        return p.Fixed
    }
    if p.PerWorker > 0 {
        return p.PerWorker * workers
    }
    if p.MaxLatency > 0 && p.MeasuredThroughputPerSecond > 0 {
        latencySeconds := p.MaxLatency.Seconds()
        computed := int(p.MeasuredThroughputPerSecond * latencySeconds)
        if computed < 1 {
            return 1
        }
        return computed
    }
    // Default: GOMAXPROCS * 4
    return runtime.GOMAXPROCS(0) * 4
}

// DefaultPolicy is a sensible default for general-purpose pipeline stages.
var DefaultPolicy = BufferPolicy{PerWorker: 4}
```

## Section 2: Core Pipeline Primitives

### 2.1 Generator (Source)

```go
// stream/source.go
package stream

import (
    "context"
)

// FromSlice creates a source channel from a slice.
// The channel is closed after all elements are sent or ctx is cancelled.
func FromSlice[T any](items []T, bufSize int) Source[T] {
    return func(ctx context.Context) <-chan Item[T] {
        out := make(chan Item[T], bufSize)
        go func() {
            defer close(out)
            for _, v := range items {
                select {
                case <-ctx.Done():
                    return
                case out <- Item[T]{Value: v}:
                }
            }
        }()
        return out
    }
}

// FromFunc repeatedly calls fn to produce items until fn returns (zero, false)
// or an error occurs.
func FromFunc[T any](fn func() (T, bool, error), bufSize int) Source[T] {
    return func(ctx context.Context) <-chan Item[T] {
        out := make(chan Item[T], bufSize)
        go func() {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    return
                default:
                }

                val, ok, err := fn()
                item := Item[T]{Value: val, Err: err}

                if !ok && err == nil {
                    return // Clean EOF
                }

                select {
                case <-ctx.Done():
                    return
                case out <- item:
                    if err != nil {
                        return // Terminate on error
                    }
                }
            }
        }()
        return out
    }
}

// Merge combines multiple sources into one channel.
// Order is non-deterministic; the first source to produce wins each slot.
func Merge[T any](ctx context.Context, sources ...<-chan Item[T]) <-chan Item[T] {
    out := make(chan Item[T], len(sources)*4)

    done := make(chan struct{})
    go func() {
        defer close(done)
        wg := new(syncWaitGroup)
        for _, src := range sources {
            src := src
            wg.Add(1)
            go func() {
                defer wg.Done()
                for item := range src {
                    select {
                    case <-ctx.Done():
                        return
                    case out <- item:
                    }
                }
            }()
        }
        wg.Wait()
    }()

    go func() {
        <-done
        close(out)
    }()

    return out
}
```

### 2.2 Transform Stage (Map)

```go
// stream/transform.go
package stream

import (
    "context"
    "runtime"
    "sync"
)

// Map applies fn to every item in the input channel, producing a new channel.
// workers controls parallelism; order is preserved when workers == 1.
func Map[In, Out any](
    fn func(context.Context, In) (Out, error),
    workers int,
    policy BufferPolicy,
) Stage[In, Out] {
    return func(ctx context.Context, in <-chan Item[In]) <-chan Item[Out] {
        if workers <= 0 {
            workers = runtime.GOMAXPROCS(0)
        }

        out := make(chan Item[Out], policy.Size(workers))

        var wg sync.WaitGroup
        wg.Add(workers)

        for range workers {
            go func() {
                defer wg.Done()
                for item := range in {
                    select {
                    case <-ctx.Done():
                        return
                    default:
                    }

                    if item.Err != nil {
                        // Propagate errors downstream unchanged
                        select {
                        case <-ctx.Done():
                            return
                        case out <- Item[Out]{Err: item.Err}:
                        }
                        continue
                    }

                    result, err := fn(ctx, item.Value)
                    select {
                    case <-ctx.Done():
                        return
                    case out <- Item[Out]{Value: result, Err: err}:
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
}

// Filter passes only items for which predicate returns true.
func Filter[T any](predicate func(T) bool) Stage[T, T] {
    return func(ctx context.Context, in <-chan Item[T]) <-chan Item[T] {
        out := make(chan Item[T], cap(in))
        go func() {
            defer close(out)
            for item := range in {
                if item.Err != nil || predicate(item.Value) {
                    select {
                    case <-ctx.Done():
                        return
                    case out <- item:
                    }
                }
            }
        }()
        return out
    }
}

// Batch collects n items into a slice before emitting.
// Partial batches are emitted when the input channel closes.
func Batch[T any](n int) Stage[T, []T] {
    return func(ctx context.Context, in <-chan Item[T]) <-chan Item[[]T] {
        out := make(chan Item[[]T], 4)
        go func() {
            defer close(out)
            buf := make([]T, 0, n)

            flush := func() {
                if len(buf) == 0 {
                    return
                }
                batch := make([]T, len(buf))
                copy(batch, buf)
                select {
                case <-ctx.Done():
                case out <- Item[[]T]{Value: batch}:
                }
                buf = buf[:0]
            }

            for item := range in {
                select {
                case <-ctx.Done():
                    return
                default:
                }

                if item.Err != nil {
                    flush()
                    out <- Item[[]T]{Err: item.Err}
                    continue
                }

                buf = append(buf, item.Value)
                if len(buf) >= n {
                    flush()
                }
            }
            flush() // Emit partial batch on close
        }()
        return out
    }
}
```

## Section 3: Backpressure Implementation

### 3.1 Bounded Backpressure with Drop and Block Modes

```go
// stream/backpressure.go
package stream

import (
    "context"
    "sync/atomic"
    "time"
)

// BackpressureMode controls behavior when the output buffer is full.
type BackpressureMode int

const (
    // Block causes the producer to wait until a slot is available.
    // Provides true backpressure at the cost of producer stalls.
    Block BackpressureMode = iota

    // DropOldest removes the oldest item in the buffer to make room.
    DropOldest

    // DropNewest discards the incoming item when the buffer is full.
    DropNewest
)

// BackpressureStage wraps a channel with configurable overflow behavior
// and exposes drop counters for observability.
type BackpressureStage[T any] struct {
    Mode     BackpressureMode
    BufSize  int
    Dropped  atomic.Int64
    Admitted atomic.Int64
}

func (b *BackpressureStage[T]) Wrap(ctx context.Context, in <-chan Item[T]) <-chan Item[T] {
    out := make(chan Item[T], b.BufSize)
    go func() {
        defer close(out)
        for item := range in {
            select {
            case <-ctx.Done():
                return
            default:
            }

            switch b.Mode {
            case Block:
                select {
                case <-ctx.Done():
                    return
                case out <- item:
                    b.Admitted.Add(1)
                }

            case DropNewest:
                select {
                case out <- item:
                    b.Admitted.Add(1)
                default:
                    b.Dropped.Add(1)
                }

            case DropOldest:
                for {
                    select {
                    case out <- item:
                        b.Admitted.Add(1)
                        goto next
                    default:
                        // Drain one item to make room
                        select {
                        case <-out:
                            b.Dropped.Add(1)
                        default:
                        }
                    }
                }
            next:
            }
        }
    }()
    return out
}

// RateLimiter throttles emission to at most rate items per second.
type RateLimiter[T any] struct {
    Rate float64 // items per second
}

func (r *RateLimiter[T]) Wrap(ctx context.Context, in <-chan Item[T]) <-chan Item[T] {
    out := make(chan Item[T], 1)
    interval := time.Duration(float64(time.Second) / r.Rate)

    go func() {
        defer close(out)
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        for item := range in {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                select {
                case <-ctx.Done():
                    return
                case out <- item:
                }
            }
        }
    }()
    return out
}
```

## Section 4: Fan-Out and Fan-In

### 4.1 Work-Stealing Fan-Out

```go
// stream/fanout.go
package stream

import (
    "context"
    "hash/fnv"
    "sync"
)

// FanOut distributes items from one channel across n workers using
// work-stealing semantics: all workers read from the same channel.
// This maximizes throughput when item processing time varies.
func FanOut[In, Out any](
    n int,
    fn func(context.Context, In) (Out, error),
    policy BufferPolicy,
) Stage[In, Out] {
    return Map(fn, n, policy)
}

// PartitionedFanOut routes items to specific workers based on a key function.
// Items with the same key always go to the same worker, preserving ordering
// per key (useful for stateful per-entity processing).
func PartitionedFanOut[In, Out any](
    n int,
    keyFn func(In) string,
    fn func(context.Context, In) (Out, error),
    policy BufferPolicy,
) Stage[In, Out] {
    return func(ctx context.Context, in <-chan Item[In]) <-chan Item[Out] {
        // Create n input channels, one per worker
        workerInputs := make([]chan Item[In], n)
        for i := range n {
            workerInputs[i] = make(chan Item[In], policy.Size(1))
        }

        // Dispatch goroutine
        go func() {
            defer func() {
                for _, ch := range workerInputs {
                    close(ch)
                }
            }()

            hasher := fnv.New32a()
            for item := range in {
                select {
                case <-ctx.Done():
                    return
                default:
                }

                if item.Err != nil {
                    // Broadcast errors to all workers? Or route to worker 0?
                    // Policy decision: send to worker 0 to maintain error ordering.
                    select {
                    case <-ctx.Done():
                        return
                    case workerInputs[0] <- item:
                    }
                    continue
                }

                key := keyFn(item.Value)
                hasher.Reset()
                hasher.Write([]byte(key))
                workerIdx := int(hasher.Sum32()) % n

                select {
                case <-ctx.Done():
                    return
                case workerInputs[workerIdx] <- item:
                }
            }
        }()

        // Start workers
        workerOutputs := make([]<-chan Item[Out], n)
        for i := range n {
            idx := i
            stageFn := Map(fn, 1, BufferPolicy{Fixed: 1})
            workerOutputs[idx] = stageFn(ctx, workerInputs[idx])
        }

        // Fan-in results
        return FanIn(ctx, policy, workerOutputs...)
    }
}

// FanIn merges multiple input channels into one output channel.
// Items are emitted as they arrive; order between channels is non-deterministic.
func FanIn[T any](ctx context.Context, policy BufferPolicy, inputs ...<-chan Item[T]) <-chan Item[T] {
    out := make(chan Item[T], policy.Size(len(inputs)))
    var wg sync.WaitGroup

    for _, in := range inputs {
        in := in
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range in {
                select {
                case <-ctx.Done():
                    return
                case out <- item:
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

// Broadcast sends each item to all n copies of the output channel.
// All receivers must accept the item before the next is sent (synchronous fanout).
func Broadcast[T any](n int) func(context.Context, <-chan Item[T]) []<-chan Item[T] {
    return func(ctx context.Context, in <-chan Item[T]) []<-chan Item[T] {
        outputs := make([]chan Item[T], n)
        for i := range n {
            outputs[i] = make(chan Item[T], 4)
        }

        go func() {
            defer func() {
                for _, ch := range outputs {
                    close(ch)
                }
            }()

            for item := range in {
                for _, out := range outputs {
                    select {
                    case <-ctx.Done():
                        return
                    case out <- item:
                    }
                }
            }
        }()

        result := make([]<-chan Item[T], n)
        for i, ch := range outputs {
            result[i] = ch
        }
        return result
    }
}
```

## Section 5: Pipeline Assembly

### 5.1 Type-Safe Pipeline Builder

```go
// stream/pipeline.go
package stream

import (
    "context"
    "fmt"
)

// Pipeline is an assembled sequence of stages.
type Pipeline[In, Out any] struct {
    stages []any // []Stage[?, ?] — erased due to Go type system
    run    func(ctx context.Context, in <-chan Item[In]) <-chan Item[Out]
}

// Pipe appends a stage to the pipeline. The types must chain correctly.
// In Go 1.21+, this can be done as a top-level generic function.
func Pipe[A, B, C any](
    p Pipeline[A, B],
    next Stage[B, C],
) Pipeline[A, C] {
    return Pipeline[A, C]{
        run: func(ctx context.Context, in <-chan Item[A]) <-chan Item[C] {
            mid := p.run(ctx, in)
            return next(ctx, mid)
        },
    }
}

// NewPipeline creates a pipeline from a single stage.
func NewPipeline[In, Out any](stage Stage[In, Out]) Pipeline[In, Out] {
    return Pipeline[In, Out]{
        run: stage,
    }
}

// Run executes the pipeline against a source and drains to a sink.
func (p Pipeline[In, Out]) Run(
    ctx context.Context,
    src Source[In],
    sink Sink[Out],
) error {
    in := src(ctx)
    out := p.run(ctx, in)
    return sink(ctx, out)
}

// CollectSink gathers all items into a slice and returns them.
func CollectSink[T any](ctx context.Context, in <-chan Item[T]) ([]T, error) {
    var results []T
    for item := range in {
        if item.Err != nil {
            return results, fmt.Errorf("pipeline error: %w", item.Err)
        }
        results = append(results, item.Value)
    }
    return results, ctx.Err()
}
```

### 5.2 Practical Example: Log Processing Pipeline

```go
// examples/logprocessor/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"

    "github.com/exampleorg/stream"
)

type RawLogLine struct {
    Raw       string
    Source    string
    Timestamp time.Time
}

type ParsedLogEntry struct {
    Level     string
    Message   string
    Fields    map[string]any
    Source    string
    Timestamp time.Time
}

type EnrichedLogEntry struct {
    ParsedLogEntry
    ServiceName string
    Environment string
    TraceID     string
}

func main() {
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    // Define pipeline stages
    parseStage := stream.Map(
        func(ctx context.Context, raw RawLogLine) (ParsedLogEntry, error) {
            return parseJSONLog(raw)
        },
        4,                              // 4 parallel parsers
        stream.BufferPolicy{Fixed: 64}, // 64-item buffer
    )

    filterStage := stream.Filter(func(e ParsedLogEntry) bool {
        // Drop DEBUG logs in production
        return e.Level != "DEBUG"
    })

    enrichStage := stream.Map(
        func(ctx context.Context, e ParsedLogEntry) (EnrichedLogEntry, error) {
            return enrichEntry(ctx, e)
        },
        2,
        stream.DefaultPolicy,
    )

    batchStage := stream.Batch[EnrichedLogEntry](100)

    // Assemble pipeline
    p := stream.Pipe(
        stream.Pipe(
            stream.Pipe(
                stream.NewPipeline(parseStage),
                filterStage,
            ),
            enrichStage,
        ),
        batchStage,
    )

    // Source: read from stdin
    source := stream.FromFunc(func() (RawLogLine, bool, error) {
        var line string
        _, err := fmt.Fscanln(os.Stdin, &line)
        if err != nil {
            return RawLogLine{}, false, nil // EOF
        }
        return RawLogLine{
            Raw:       line,
            Source:    "stdin",
            Timestamp: time.Now(),
        }, true, nil
    }, 32)

    // Sink: write batches to output
    sink := func(ctx context.Context, in <-chan stream.Item[[]EnrichedLogEntry]) error {
        for batch := range in {
            if batch.Err != nil {
                log.Printf("ERROR: batch processing failed: %v", batch.Err)
                continue
            }
            for _, entry := range batch.Value {
                data, _ := json.Marshal(entry)
                fmt.Println(string(data))
            }
        }
        return ctx.Err()
    }

    if err := p.Run(ctx, source, sink); err != nil {
        log.Fatalf("pipeline failed: %v", err)
    }
}

func parseJSONLog(raw RawLogLine) (ParsedLogEntry, error) {
    var fields map[string]any
    if err := json.Unmarshal([]byte(raw.Raw), &fields); err != nil {
        return ParsedLogEntry{}, fmt.Errorf("parsing log line: %w", err)
    }

    level, _ := fields["level"].(string)
    msg, _ := fields["msg"].(string)
    delete(fields, "level")
    delete(fields, "msg")

    return ParsedLogEntry{
        Level:     strings.ToUpper(level),
        Message:   msg,
        Fields:    fields,
        Source:    raw.Source,
        Timestamp: raw.Timestamp,
    }, nil
}

func enrichEntry(ctx context.Context, e ParsedLogEntry) (EnrichedLogEntry, error) {
    return EnrichedLogEntry{
        ParsedLogEntry: e,
        ServiceName:    os.Getenv("SERVICE_NAME"),
        Environment:    os.Getenv("ENVIRONMENT"),
        TraceID:        extractTraceID(e.Fields),
    }, nil
}

func extractTraceID(fields map[string]any) string {
    if tid, ok := fields["trace_id"].(string); ok {
        return tid
    }
    return ""
}
```

## Section 6: Graceful Shutdown

### 6.1 Shutdown Coordinator

Graceful shutdown in a channel pipeline requires draining in-flight items before terminating. Cancelling the context stops new items from entering but in-flight items in buffered channels must be drained.

```go
// stream/shutdown.go
package stream

import (
    "context"
    "sync"
    "time"
)

// ShutdownCoordinator manages a clean pipeline shutdown sequence.
// It distinguishes between:
//   - Stop: stop accepting new items (cancel source)
//   - Drain: wait for in-flight items to complete
//   - Kill: force-terminate regardless of pending items
type ShutdownCoordinator struct {
    stopFn    context.CancelFunc
    drainDone chan struct{}
    mu        sync.Mutex
    stopped   bool
}

// NewShutdownCoordinator creates a context pair for clean shutdown.
// The returned cancelSource cancels only the source (stops ingestion).
// The returned cancelAll cancels everything (forces shutdown).
func NewShutdownCoordinator(parent context.Context) (
    sourceCtx context.Context,
    allCtx context.Context,
    coord *ShutdownCoordinator,
) {
    sourceCtx, sourceCancel := context.WithCancel(parent)
    allCtx, allCancel := context.WithCancel(parent)

    coord = &ShutdownCoordinator{
        stopFn:    sourceCancel,
        drainDone: make(chan struct{}),
    }

    // When source context is cancelled, start a drain timeout then kill all.
    go func() {
        <-sourceCtx.Done()
        select {
        case <-coord.drainDone:
            // Clean drain completed
        case <-time.After(30 * time.Second):
            // Drain timeout — force kill
            allCancel()
            return
        }
        allCancel()
    }()

    _ = allCancel // captured in closure

    return sourceCtx, allCtx, coord
}

// Stop signals the source to stop producing new items.
// In-flight items will continue to be processed.
func (c *ShutdownCoordinator) Stop() {
    c.mu.Lock()
    defer c.mu.Unlock()
    if !c.stopped {
        c.stopped = true
        c.stopFn()
    }
}

// SignalDrainComplete notifies the coordinator that all in-flight items
// have been processed. This is called by the sink when the input channel closes.
func (c *ShutdownCoordinator) SignalDrainComplete() {
    select {
    case <-c.drainDone:
        // Already closed
    default:
        close(c.drainDone)
    }
}

// WaitForDrain blocks until drain completes or timeout.
func (c *ShutdownCoordinator) WaitForDrain(timeout time.Duration) bool {
    select {
    case <-c.drainDone:
        return true
    case <-time.After(timeout):
        return false
    }
}
```

### 6.2 Integration: Server with Graceful Shutdown

```go
// server/processor.go
package server

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/exampleorg/stream"
)

type EventProcessor struct {
    logger *slog.Logger
    queue  <-chan RawEvent
}

func (p *EventProcessor) Run() error {
    parent := context.Background()

    // sourceCtx is cancelled on SIGTERM — stops source ingestion
    // allCtx is cancelled after drain timeout — forces everything to stop
    sourceCtx, allCtx, coord := stream.NewShutdownCoordinator(parent)

    // Listen for OS signals
    sigs := make(chan os.Signal, 1)
    signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
    go func() {
        sig := <-sigs
        p.logger.Info("Received signal, initiating graceful shutdown", "signal", sig)
        coord.Stop()
    }()

    // Build source from internal queue
    source := func(ctx context.Context) <-chan stream.Item[RawEvent] {
        out := make(chan stream.Item[RawEvent], 128)
        go func() {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    p.logger.Info("Source stopped, no more events accepted")
                    return
                case event, ok := <-p.queue:
                    if !ok {
                        return
                    }
                    select {
                    case <-ctx.Done():
                        return
                    case out <- stream.Item[RawEvent]{Value: event}:
                    }
                }
            }
        }()
        return out
    }

    // The pipeline uses allCtx so stages are killed if drain times out
    pipeline := buildEventPipeline()

    sink := func(ctx context.Context, in <-chan stream.Item[ProcessedEvent]) error {
        defer coord.SignalDrainComplete()
        for item := range in {
            if item.Err != nil {
                p.logger.Error("Processing error", "err", item.Err)
                continue
            }
            if err := p.publishEvent(ctx, item.Value); err != nil {
                return err
            }
        }
        return nil
    }

    // Source uses sourceCtx (stops on SIGTERM)
    // Pipeline uses allCtx (killed after drain timeout)
    srcCh := source(sourceCtx)
    outCh := pipeline(allCtx, srcCh)
    return sink(allCtx, outCh)
}
```

## Section 7: Observability

### 7.1 Pipeline Metrics with Prometheus

```go
// stream/metrics.go
package stream

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

type StageMetrics struct {
    itemsIn     prometheus.Counter
    itemsOut    prometheus.Counter
    errors      prometheus.Counter
    processingDuration prometheus.Histogram
}

func NewStageMetrics(stageName string) *StageMetrics {
    labels := prometheus.Labels{"stage": stageName}
    return &StageMetrics{
        itemsIn: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   "pipeline",
            Name:        "items_in_total",
            Help:        "Total items received by stage",
            ConstLabels: labels,
        }),
        itemsOut: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   "pipeline",
            Name:        "items_out_total",
            Help:        "Total items emitted by stage",
            ConstLabels: labels,
        }),
        errors: promauto.NewCounter(prometheus.CounterOpts{
            Namespace:   "pipeline",
            Name:        "errors_total",
            Help:        "Total errors encountered by stage",
            ConstLabels: labels,
        }),
        processingDuration: promauto.NewHistogram(prometheus.HistogramOpts{
            Namespace:   "pipeline",
            Name:        "processing_duration_seconds",
            Help:        "Item processing latency distribution",
            ConstLabels: labels,
            Buckets:     prometheus.ExponentialBuckets(0.0001, 2, 16),
        }),
    }
}

// InstrumentedMap wraps Map with Prometheus metrics.
func InstrumentedMap[In, Out any](
    name string,
    fn func(context.Context, In) (Out, error),
    workers int,
    policy BufferPolicy,
) Stage[In, Out] {
    m := NewStageMetrics(name)
    return func(ctx context.Context, in <-chan Item[In]) <-chan Item[Out] {
        instrumented := func(ctx context.Context, item In) (Out, error) {
            m.itemsIn.Inc()
            start := time.Now()
            result, err := fn(ctx, item)
            m.processingDuration.Observe(time.Since(start).Seconds())
            if err != nil {
                m.errors.Inc()
            } else {
                m.itemsOut.Inc()
            }
            return result, err
        }
        return Map(instrumented, workers, policy)(ctx, in)
    }
}
```

## Summary

Building reactive streams in Go with channels provides production-grade stream processing without framework dependencies. The key design principles are:

1. **Buffer sizes are not free parameters.** Size buffers based on measured throughput and latency budgets using the BufferPolicy abstraction.
2. **Backpressure is a first-class concern.** Choose Block, DropOldest, or DropNewest intentionally and expose drop counters to observability.
3. **Fan-out with work-stealing** (shared channel, N goroutines) maximizes throughput. **Partitioned fan-out** (hash routing) preserves per-key ordering for stateful operations.
4. **Error propagation** should flow downstream as Item.Err rather than triggering immediate pipeline termination, giving sinks the opportunity to handle partial failures gracefully.
5. **Graceful shutdown** requires a two-phase approach: stop the source first, drain in-flight items within a deadline, then force-cancel the full context tree.
6. **Instrument every stage** with counters and histograms before any pipeline goes to production. Channel saturation is invisible without metrics.
