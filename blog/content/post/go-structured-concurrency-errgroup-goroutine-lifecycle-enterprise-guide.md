---
title: "Go Structured Concurrency with errgroup: Goroutine Lifecycle, Leak Detection, and Panic Recovery"
date: 2031-11-16T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Concurrency", "errgroup", "Goroutines", "Context", "Structured Concurrency"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive enterprise guide to Go structured concurrency using errgroup: managing goroutine lifecycles with context cancellation, detecting and preventing goroutine leaks, implementing robust panic recovery, and building production-ready concurrent systems."
more_link: "yes"
url: "/go-structured-concurrency-errgroup-goroutine-lifecycle-enterprise-guide/"
---

Goroutine leaks are one of the most insidious bugs in Go services. Unlike memory leaks that show up in heap profiles, leaked goroutines accumulate silently until the service runs out of stack space or locks up waiting on channels that will never receive. The root cause is almost always the same: goroutines launched without a structured ownership model — someone fires off a `go func()` and forgets to track whether it ever completes.

The `golang.org/x/sync/errgroup` package, combined with careful context propagation and panic recovery, gives you the building blocks for structured concurrency in Go. This guide covers the full pattern: lifecycle management, cancellation propagation, leak detection, panic recovery, and the pitfalls that trip up even experienced Go engineers.

<!--more-->

# Go Structured Concurrency with errgroup

## The Problem with Unstructured Goroutines

Consider this common pattern in Go services:

```go
// Anti-pattern: fire and forget
func ProcessBatch(items []Item) {
    for _, item := range items {
        go processItem(item)  // No ownership, no cancellation, no error collection
    }
    // Returns immediately. No way to know when processing is done.
    // No way to cancel in-flight work. No way to collect errors.
}
```

This code has three critical problems:

1. **No lifecycle control**: The caller cannot wait for completion or cancel in-flight work.
2. **Error loss**: Errors from `processItem` are silently dropped.
3. **Goroutine leak potential**: If the service shuts down, these goroutines may continue running indefinitely.

The fix is not just using `errgroup` mechanically — it is adopting a mental model where every goroutine has an explicit owner that is responsible for waiting on its completion and propagating cancellation.

## Understanding errgroup

The `errgroup` package provides a `Group` type that combines:
- A `sync.WaitGroup` for waiting on goroutines
- Error collection and propagation
- Optional context cancellation when the first error occurs

```go
import "golang.org/x/sync/errgroup"
```

### Basic Usage

```go
func ProcessBatch(ctx context.Context, items []Item) error {
    g, ctx := errgroup.WithContext(ctx)

    for _, item := range items {
        item := item // capture loop variable
        g.Go(func() error {
            return processItem(ctx, item)
        })
    }

    // Blocks until all goroutines complete
    // Returns the first non-nil error, if any
    return g.Wait()
}
```

Key behaviors:
- `g.Go(f)` launches `f` in a new goroutine
- When `f` returns a non-nil error, the derived `ctx` is cancelled
- `g.Wait()` blocks until all goroutines complete and returns the first error
- All goroutines run to completion even if one errors — cancellation is cooperative

### The Context Cancellation Model

`errgroup.WithContext` returns a derived context that is cancelled when:
1. The first goroutine returns a non-nil error, OR
2. The parent context is cancelled

This is the cooperative cancellation model. Your goroutines must check `ctx.Done()` or pass the context to downstream calls for cancellation to propagate:

```go
func processItem(ctx context.Context, item Item) error {
    // Pass ctx to all downstream calls
    result, err := fetchData(ctx, item.ID)
    if err != nil {
        return fmt.Errorf("fetchData %s: %w", item.ID, err)
    }

    // Check context between expensive operations
    select {
    case <-ctx.Done():
        return ctx.Err()
    default:
    }

    return storeResult(ctx, result)
}
```

## Goroutine Lifecycle Patterns

### Pattern 1: Fan-Out with Bounded Concurrency

Unlimited parallelism is dangerous under load. Always bound concurrent goroutines:

```go
func ProcessBatchBounded(ctx context.Context, items []Item, maxConcurrent int) error {
    g, ctx := errgroup.WithContext(ctx)
    sem := make(chan struct{}, maxConcurrent)

    for _, item := range items {
        item := item

        // Acquire semaphore (blocks if at capacity)
        select {
        case sem <- struct{}{}:
        case <-ctx.Done():
            break
        }

        g.Go(func() error {
            defer func() { <-sem }() // Release semaphore when done

            return processItem(ctx, item)
        })
    }

    return g.Wait()
}
```

For Go 1.22+, errgroup provides `SetLimit` directly:

```go
func ProcessBatchBounded(ctx context.Context, items []Item, maxConcurrent int) error {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(maxConcurrent)

    for _, item := range items {
        item := item
        g.Go(func() error {
            return processItem(ctx, item)
        })
    }

    return g.Wait()
}
```

### Pattern 2: Pipeline with Multiple Stages

```go
type Pipeline[T, U any] struct {
    maxWorkers int
}

func RunPipeline[T, U any](
    ctx context.Context,
    input <-chan T,
    process func(ctx context.Context, item T) (U, error),
    output chan<- U,
    maxWorkers int,
) error {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(maxWorkers)

    for {
        select {
        case item, ok := <-input:
            if !ok {
                // Input channel closed, wait for in-flight work
                return g.Wait()
            }

            item := item
            g.Go(func() error {
                result, err := process(ctx, item)
                if err != nil {
                    return err
                }

                select {
                case output <- result:
                case <-ctx.Done():
                    return ctx.Err()
                }
                return nil
            })

        case <-ctx.Done():
            // Wait for in-flight workers to finish
            _ = g.Wait()
            return ctx.Err()
        }
    }
}
```

### Pattern 3: Fan-Out Fan-In with Result Aggregation

```go
type FanOutResult[T any] struct {
    Index int
    Value T
    Err   error
}

func FanOut[T any](
    ctx context.Context,
    tasks []func(ctx context.Context) (T, error),
) ([]T, error) {
    results := make([]T, len(tasks))
    g, ctx := errgroup.WithContext(ctx)

    for i, task := range tasks {
        i, task := i, task
        g.Go(func() error {
            val, err := task(ctx)
            if err != nil {
                return fmt.Errorf("task %d: %w", i, err)
            }
            results[i] = val
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

### Pattern 4: Long-Running Service Workers

For services that run goroutines indefinitely until shutdown:

```go
type WorkerPool struct {
    workers []Worker
    g       *errgroup.Group
    ctx     context.Context
    cancel  context.CancelFunc
}

func NewWorkerPool(parent context.Context, workers []Worker) *WorkerPool {
    ctx, cancel := context.WithCancel(parent)
    g, ctx := errgroup.WithContext(ctx)

    return &WorkerPool{
        workers: workers,
        g:       g,
        ctx:     ctx,
        cancel:  cancel,
    }
}

func (p *WorkerPool) Start() {
    for _, w := range p.workers {
        w := w
        p.g.Go(func() error {
            // Workers run until context is cancelled
            // Return nil on clean shutdown, error on unexpected termination
            return w.Run(p.ctx)
        })
    }
}

func (p *WorkerPool) Shutdown(timeout time.Duration) error {
    // Signal all workers to stop
    p.cancel()

    // Wait with timeout
    done := make(chan error, 1)
    go func() {
        done <- p.g.Wait()
    }()

    select {
    case err := <-done:
        return err
    case <-time.After(timeout):
        return fmt.Errorf("worker pool shutdown timed out after %s", timeout)
    }
}
```

## Context Cancellation Deep Dive

### Understanding Context Propagation

Context cancellation is only useful if it is threaded through all blocking operations. The most common mistake is creating a new context inside a goroutine instead of passing the parent:

```go
// Wrong: ctx is not propagated
g.Go(func() error {
    // This ignores parent cancellation entirely
    return http.Get("https://api.example.com/data")
})

// Correct: ctx is propagated to all I/O operations
g.Go(func() error {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.example.com/data", nil)
    if err != nil {
        return err
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    return processResponse(ctx, resp)
})
```

### Context Value Propagation Through goroutines

When a goroutine needs request-scoped values (trace IDs, user IDs), they must come from context, not captured variables that may be mutated:

```go
type contextKey string

const (
    traceIDKey contextKey = "trace_id"
    userIDKey  contextKey = "user_id"
)

func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    // Values are in context - safe to pass to goroutines
    ctx = context.WithValue(ctx, traceIDKey, generateTraceID())
    ctx = context.WithValue(ctx, userIDKey, extractUserID(r))

    g, ctx := errgroup.WithContext(ctx)

    g.Go(func() error {
        // Both goroutines have access to traceID and userID via context
        return fetchUserData(ctx)
    })

    g.Go(func() error {
        return fetchUserPreferences(ctx)
    })

    if err := g.Wait(); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
}
```

### Deadline and Timeout Propagation

```go
func ProcessWithTimeout(ctx context.Context, items []Item) error {
    // Set an overall deadline for the entire batch
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(10)

    for _, item := range items {
        item := item
        g.Go(func() error {
            // Each item also gets its own per-item deadline
            itemCtx, itemCancel := context.WithTimeout(ctx, 5*time.Second)
            defer itemCancel()

            return processItem(itemCtx, item)
        })
    }

    return g.Wait()
}
```

## Goroutine Leak Detection

### Runtime-Based Leak Detection

Use the `goleak` package in tests:

```go
import "go.uber.org/goleak"

func TestProcessBatch(t *testing.T) {
    defer goleak.VerifyNone(t)

    ctx := context.Background()
    items := []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}

    err := ProcessBatch(ctx, items)
    if err != nil {
        t.Fatal(err)
    }
    // goleak checks that no goroutines were leaked by this test
}
```

For tests that involve background goroutines from the framework:

```go
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m,
        // Ignore known background goroutines
        goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"),
        goleak.IgnoreTopFunction("net/http.(*persistConn).readLoop"),
    )
}
```

### Goroutine Stack Inspection

For production diagnosis, dump goroutine stacks and analyze:

```go
import (
    "runtime"
    "runtime/debug"
)

func DumpGoroutines() string {
    buf := make([]byte, 1<<20) // 1MB buffer
    n := runtime.Stack(buf, true)
    return string(buf[:n])
}

// HTTP handler for diagnostics
func goroutineDumpHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/plain")
    fmt.Fprint(w, DumpGoroutines())
}
```

Parse goroutine counts by function:

```go
func GoroutinesByFunction() map[string]int {
    buf := make([]byte, 1<<20)
    n := runtime.Stack(buf, true)
    stacks := strings.Split(string(buf[:n]), "\n\n")

    counts := make(map[string]int)
    for _, stack := range stacks {
        lines := strings.Split(stack, "\n")
        if len(lines) < 2 {
            continue
        }
        // Second line is the top of the stack
        fn := strings.Fields(lines[1])[0]
        counts[fn]++
    }
    return counts
}
```

### Prometheus Metrics for Goroutine Monitoring

```go
import (
    "runtime"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    goroutineCount = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines_active",
        Help: "Current number of goroutines",
    })

    goroutinesByPool = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "go_goroutines_by_pool",
        Help: "Goroutines broken down by worker pool name",
    }, []string{"pool"})
)

// Track goroutines per named pool
type TrackedGroup struct {
    *errgroup.Group
    name    string
    counter prometheus.Gauge
    mu      sync.Mutex
    active  int64
}

func NewTrackedGroup(ctx context.Context, name string) (*TrackedGroup, context.Context) {
    g, ctx := errgroup.WithContext(ctx)
    tg := &TrackedGroup{
        Group:   g,
        name:    name,
        counter: goroutinesByPool.WithLabelValues(name),
    }
    return tg, ctx
}

func (tg *TrackedGroup) Go(f func() error) {
    atomic.AddInt64(&tg.active, 1)
    tg.counter.Inc()

    tg.Group.Go(func() error {
        defer func() {
            atomic.AddInt64(&tg.active, -1)
            tg.counter.Dec()
        }()
        return f()
    })
}

func (tg *TrackedGroup) ActiveCount() int64 {
    return atomic.LoadInt64(&tg.active)
}
```

## Panic Recovery

### The Problem with Unrecovered Panics

A panic in a goroutine terminates the entire process unless recovered. `errgroup` does NOT recover panics — it is your responsibility:

```go
// This will crash the entire service if processItem panics
g.Go(func() error {
    return processItem(ctx, item)
})
```

### Safe Wrapper with Panic Recovery

```go
// SafeGo wraps a function to recover panics and convert them to errors
func SafeGo(g *errgroup.Group, f func() error) {
    g.Go(func() (retErr error) {
        defer func() {
            if r := recover(); r != nil {
                // Capture stack trace at the point of panic
                stack := debug.Stack()
                retErr = fmt.Errorf("panic recovered: %v\n%s", r, stack)
            }
        }()
        return f()
    })
}
```

### Production-Grade Panic Handler

```go
type PanicError struct {
    Value interface{}
    Stack []byte
}

func (e *PanicError) Error() string {
    return fmt.Sprintf("panic: %v\n\nStack trace:\n%s", e.Value, e.Stack)
}

// RecoverFunc returns a deferred function that captures panics
func RecoverFunc(errPtr *error) func() {
    return func() {
        if r := recover(); r != nil {
            *errPtr = &PanicError{
                Value: r,
                Stack: debug.Stack(),
            }
        }
    }
}

// SafeGroup is an errgroup.Group with automatic panic recovery and optional logging
type SafeGroup struct {
    g      *errgroup.Group
    ctx    context.Context
    logger *slog.Logger
}

func NewSafeGroup(ctx context.Context, logger *slog.Logger) (*SafeGroup, context.Context) {
    g, ctx := errgroup.WithContext(ctx)
    return &SafeGroup{g: g, ctx: ctx, logger: logger}, ctx
}

func (sg *SafeGroup) Go(name string, f func() error) {
    sg.g.Go(func() (retErr error) {
        defer func() {
            if r := recover(); r != nil {
                stack := debug.Stack()
                panicErr := &PanicError{Value: r, Stack: stack}

                sg.logger.Error("goroutine panic recovered",
                    "goroutine", name,
                    "panic", fmt.Sprintf("%v", r),
                    "stack", string(stack),
                )

                retErr = panicErr
            }
        }()

        if err := f(); err != nil {
            sg.logger.Debug("goroutine returned error",
                "goroutine", name,
                "error", err,
            )
            return err
        }
        return nil
    })
}

func (sg *SafeGroup) Wait() error {
    return sg.g.Wait()
}

func (sg *SafeGroup) SetLimit(n int) {
    sg.g.SetLimit(n)
}
```

Usage:

```go
func ProcessWithSafeGroup(ctx context.Context, items []Item) error {
    sg, ctx := NewSafeGroup(ctx, slog.Default())
    sg.SetLimit(20)

    for _, item := range items {
        item := item
        sg.Go(fmt.Sprintf("process-item-%s", item.ID), func() error {
            return processItem(ctx, item)
        })
    }

    return sg.Wait()
}
```

## Advanced Patterns

### TryGo with Backpressure

When the goroutine limit is reached, `TryGo` returns false instead of blocking:

```go
func ProcessWithBackpressure(ctx context.Context, items []Item) error {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(10)

    var skipped int64

    for _, item := range items {
        item := item

        if !g.TryGo(func() error {
            return processItem(ctx, item)
        }) {
            // Cannot start goroutine now (at limit)
            // Either queue for retry or record skip
            atomic.AddInt64(&skipped, 1)
        }

        // Check cancellation
        select {
        case <-ctx.Done():
            break
        default:
        }
    }

    if err := g.Wait(); err != nil {
        return err
    }

    if skipped > 0 {
        return fmt.Errorf("skipped %d items due to backpressure", skipped)
    }
    return nil
}
```

### Combining Multiple errgroups for Layered Concurrency

```go
func RunService(ctx context.Context) error {
    // Outer group: manages top-level service components
    outer, outerCtx := errgroup.WithContext(ctx)

    // Component 1: HTTP server
    outer.Go(func() error {
        return runHTTPServer(outerCtx)
    })

    // Component 2: Background worker pool
    outer.Go(func() error {
        // Inner group: manages individual workers
        inner, innerCtx := errgroup.WithContext(outerCtx)
        inner.SetLimit(5)

        for i := 0; i < 5; i++ {
            workerID := i
            inner.Go(func() error {
                return runWorker(innerCtx, workerID)
            })
        }

        return inner.Wait()
    })

    // Component 3: Metrics collection
    outer.Go(func() error {
        return runMetricsCollector(outerCtx)
    })

    return outer.Wait()
}
```

### Context Injection for Trace Propagation

In distributed tracing, you need trace context to flow through goroutines:

```go
import "go.opentelemetry.io/otel/trace"

func SpanGroup(ctx context.Context, spanName string) (*errgroup.Group, context.Context) {
    tracer := otel.Tracer("myservice")
    ctx, span := tracer.Start(ctx, spanName)

    g, ctx := errgroup.WithContext(ctx)

    // Wrap Wait to end the span
    // Since we can't extend errgroup.Group, use a wrapper
    return g, ctx
}

// TraceGroup adds span tracking around errgroup
type TraceGroup struct {
    *errgroup.Group
    span   trace.Span
    ctx    context.Context
}

func NewTraceGroup(ctx context.Context, operationName string) (*TraceGroup, context.Context) {
    tracer := otel.Tracer("myservice")
    spanCtx, span := tracer.Start(ctx, operationName)

    g, gCtx := errgroup.WithContext(spanCtx)

    return &TraceGroup{Group: g, span: span, ctx: gCtx}, gCtx
}

func (tg *TraceGroup) Wait() error {
    err := tg.Group.Wait()
    if err != nil {
        tg.span.RecordError(err)
        tg.span.SetStatus(codes.Error, err.Error())
    }
    tg.span.End()
    return err
}
```

## Testing Concurrent Code

### Table-Driven Tests with Race Detection

Always run concurrent tests with `-race`:

```go
func TestProcessBatch_Concurrent(t *testing.T) {
    tests := []struct {
        name       string
        items      []Item
        maxWorkers int
        wantErr    bool
        setup      func() // Setup mock behavior
    }{
        {
            name:       "success all items",
            items:      makeItems(100),
            maxWorkers: 10,
            wantErr:    false,
        },
        {
            name:       "first error cancels remaining",
            items:      makeItems(50),
            maxWorkers: 5,
            wantErr:    true,
            setup: func() {
                // Inject error in mock for item 10
            },
        },
        {
            name:       "context cancellation mid-batch",
            items:      makeItems(1000),
            maxWorkers: 20,
            wantErr:    true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            defer goleak.VerifyNone(t)

            if tt.setup != nil {
                tt.setup()
            }

            ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            defer cancel()

            err := ProcessBatchBounded(ctx, tt.items, tt.maxWorkers)

            if (err != nil) != tt.wantErr {
                t.Errorf("ProcessBatchBounded() error = %v, wantErr %v", err, tt.wantErr)
            }
        })
    }
}
```

### Deterministic Concurrency Testing with Sync Primitives

```go
// Use barriers to force specific interleavings
func TestCancellationPropagation(t *testing.T) {
    defer goleak.VerifyNone(t)

    var (
        started = make(chan struct{})
        blocked = make(chan struct{})
    )

    ctx, cancel := context.WithCancel(context.Background())
    g, ctx := errgroup.WithContext(ctx)

    g.Go(func() error {
        close(started) // Signal: goroutine has started
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-blocked:
            return nil
        }
    })

    // Wait for goroutine to start, then cancel
    <-started
    cancel()

    err := g.Wait()
    if !errors.Is(err, context.Canceled) {
        t.Errorf("expected context.Canceled, got %v", err)
    }
}
```

## Production Checklist

Before shipping any code that uses goroutines:

1. Every `go func()` should be owned by an `errgroup.Group` or equivalent
2. All goroutines must accept and respect a `context.Context`
3. Panic recovery must be in place for all long-running goroutines
4. Goroutine counts must be exported as Prometheus metrics
5. Tests must use `goleak.VerifyNone(t)` to catch leaks
6. Tests must run with `go test -race`
7. Bounded concurrency must be enforced via `g.SetLimit()` or a semaphore
8. Every `errgroup.Group` must have a corresponding `g.Wait()` that is not ignored

## Summary

Structured concurrency in Go is not about avoiding goroutines — it is about making goroutine ownership and lifetime explicit. The `errgroup` package provides the scaffolding, but the discipline of passing contexts, recovering panics, and bounding concurrency is yours to apply. The patterns in this guide form a complete system: `SafeGroup` for production workloads, `goleak` for test validation, Prometheus metrics for production observability, and `SetLimit` for backpressure. Applied consistently, these patterns eliminate the entire class of goroutine lifecycle bugs that cause production incidents in Go services.
