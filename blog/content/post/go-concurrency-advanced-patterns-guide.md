---
title: "Advanced Go Concurrency: Pipelines, Fan-out/Fan-in, and Backpressure"
date: 2028-01-11T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Channels", "Goroutines", "Pipelines", "Production"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to advanced Go concurrency patterns covering pipeline stages with channels, fan-out worker pools, fan-in result aggregation, backpressure with buffered channels, context cancellation propagation, errgroup patterns, semaphores, and race condition detection."
more_link: "yes"
url: "/go-concurrency-advanced-patterns-guide/"
---

Go's concurrency primitives—goroutines and channels—are simple to learn but require significant discipline to use correctly at production scale. The patterns that work for a 10-goroutine proof of concept frequently break under the load of a 10,000-goroutine production service: goroutine leaks accumulate, channel operations block unexpectedly, and error propagation across goroutine boundaries causes silent failures. This guide examines the production-grade patterns for building concurrent Go programs that handle backpressure, propagate errors correctly, and shut down gracefully under all conditions.

<!--more-->

# Advanced Go Concurrency: Pipelines, Fan-out/Fan-in, and Backpressure

## Section 1: Pipeline Pattern

A pipeline is a series of stages connected by channels, where each stage consumes values from an input channel, transforms them, and sends results to an output channel. Pipelines enable clean separation of concerns and natural concurrency between stages.

### Basic Pipeline Stage

```go
package pipeline

import "context"

// Stage is a function that reads from in and writes to a new channel.
// It returns the output channel, which the next stage consumes.
type Stage[T, U any] func(ctx context.Context, in <-chan T) <-chan U

// Transform creates a pipeline stage that applies fn to each input value.
func Transform[T, U any](fn func(T) (U, error)) Stage[T, U] {
    return func(ctx context.Context, in <-chan T) <-chan U {
        out := make(chan U)
        go func() {
            defer close(out)
            for v := range in {
                result, err := fn(v)
                if err != nil {
                    // In a real pipeline, errors go to an error channel.
                    // This simplified version drops errors.
                    continue
                }
                select {
                case out <- result:
                case <-ctx.Done():
                    return
                }
            }
        }()
        return out
    }
}

// Generator creates the first stage: a channel from a slice.
func Generator[T any](ctx context.Context, values ...T) <-chan T {
    out := make(chan T)
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
```

### Pipeline with Error Propagation

The naive approach drops errors. Production pipelines use a Result type to carry both value and error through the same channel, or use a parallel error channel.

```go
package pipeline

import (
    "context"
    "sync"
)

// Result wraps a value and an error for use in pipelines.
type Result[T any] struct {
    Value T
    Err   error
}

// StageWithErrors applies fn to each input, forwarding errors downstream.
func StageWithErrors[T, U any](
    ctx context.Context,
    in <-chan Result[T],
    fn func(T) (U, error),
) <-chan Result[U] {
    out := make(chan Result[U])
    go func() {
        defer close(out)
        for r := range in {
            var res Result[U]
            if r.Err != nil {
                // Forward the error downstream unchanged.
                res.Err = r.Err
            } else {
                res.Value, res.Err = fn(r.Value)
            }
            select {
            case out <- res:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Collect drains the channel and returns all results.
// It stops early if ctx is cancelled.
func Collect[T any](ctx context.Context, in <-chan Result[T]) ([]T, []error) {
    var values []T
    var errs []error
    for {
        select {
        case r, ok := <-in:
            if !ok {
                return values, errs
            }
            if r.Err != nil {
                errs = append(errs, r.Err)
            } else {
                values = append(values, r.Value)
            }
        case <-ctx.Done():
            return values, append(errs, ctx.Err())
        }
    }
}

// Example usage: fetch URLs, parse responses, validate results
func ProcessURLs(ctx context.Context, urls []string) ([]ParsedResponse, []error) {
    // Stage 1: Generate URL results
    urlChan := make(chan Result[string])
    go func() {
        defer close(urlChan)
        for _, u := range urls {
            select {
            case urlChan <- Result[string]{Value: u}:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Stage 2: Fetch (could run multiple workers)
    fetchedChan := StageWithErrors(ctx, urlChan, fetchURL)

    // Stage 3: Parse
    parsedChan := StageWithErrors(ctx, fetchedChan, parseResponse)

    // Stage 4: Validate
    validatedChan := StageWithErrors(ctx, parsedChan, validateResponse)

    return Collect(ctx, validatedChan)
}
```

## Section 2: Fan-out Worker Pools

Fan-out distributes work across multiple goroutines. The canonical implementation uses a fixed-size worker pool fed by a shared input channel.

### Basic Worker Pool

```go
package worker

import (
    "context"
    "sync"
)

// WorkerPool runs numWorkers goroutines, each reading from jobs and
// sending results to an output channel.
func WorkerPool[J, R any](
    ctx context.Context,
    numWorkers int,
    jobs <-chan J,
    process func(context.Context, J) (R, error),
) <-chan Result[R] {
    out := make(chan Result[R], numWorkers)

    var wg sync.WaitGroup
    for range numWorkers {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                var r Result[R]
                r.Value, r.Err = process(ctx, job)
                select {
                case out <- r:
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    // Close the output channel once all workers finish.
    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}

// Result is used throughout this package.
type Result[T any] struct {
    Value T
    Err   error
}
```

### Bounded Worker Pool with Backpressure

The above worker pool applies backpressure implicitly: if the output channel fills, workers block on `out <- r`, which prevents them from consuming more jobs. This is correct behavior—it slows down job consumption when downstream is slow.

However, the job submission side also needs backpressure control. If jobs are generated faster than they can be processed, the jobs channel or the submitter's goroutine will grow unboundedly.

```go
package worker

import (
    "context"
    "errors"
)

// ErrBackpressure is returned when the pool is at capacity and
// a non-blocking submission is attempted.
var ErrBackpressure = errors.New("worker pool at capacity")

// BoundedPool manages a pool with explicit backpressure.
type BoundedPool[J, R any] struct {
    jobs    chan J
    results chan Result[R]
    done    chan struct{}
}

// NewBoundedPool creates a worker pool with bounded input and output channels.
// queueDepth controls how many pending jobs can be buffered.
func NewBoundedPool[J, R any](
    ctx context.Context,
    numWorkers int,
    queueDepth int,
    process func(context.Context, J) (R, error),
) *BoundedPool[J, R] {
    p := &BoundedPool[J, R]{
        jobs:    make(chan J, queueDepth),
        results: make(chan Result[R], numWorkers*2),
        done:    make(chan struct{}),
    }

    go func() {
        defer close(p.results)
        var wg WaitGroup
        for range numWorkers {
            wg.Add(1)
            go func() {
                defer wg.Done()
                for job := range p.jobs {
                    v, err := process(ctx, job)
                    select {
                    case p.results <- Result[R]{Value: v, Err: err}:
                    case <-ctx.Done():
                        return
                    case <-p.done:
                        return
                    }
                }
            }()
        }
        wg.Wait()
    }()

    return p
}

// Submit enqueues a job. Blocks if the queue is full.
func (p *BoundedPool[J, R]) Submit(ctx context.Context, job J) error {
    select {
    case p.jobs <- job:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    case <-p.done:
        return errors.New("pool is closed")
    }
}

// TrySubmit attempts to enqueue without blocking.
// Returns ErrBackpressure if the queue is full.
func (p *BoundedPool[J, R]) TrySubmit(job J) error {
    select {
    case p.jobs <- job:
        return nil
    default:
        return ErrBackpressure
    }
}

// Results returns the channel for consuming processed results.
func (p *BoundedPool[J, R]) Results() <-chan Result[R] {
    return p.results
}

// Close signals workers to stop after draining the jobs channel.
func (p *BoundedPool[J, R]) Close() {
    close(p.jobs)
}

type WaitGroup = sync.WaitGroup
```

## Section 3: Fan-in Result Aggregation

Fan-in merges multiple channels into one. The classic implementation launches one goroutine per input channel and uses a WaitGroup to close the output when all goroutines complete.

```go
package fanin

import (
    "context"
    "sync"
)

// Merge fans multiple input channels into a single output channel.
// The output channel is closed when all input channels are closed.
func Merge[T any](ctx context.Context, inputs ...<-chan T) <-chan T {
    out := make(chan T)
    var wg sync.WaitGroup

    drain := func(ch <-chan T) {
        defer wg.Done()
        for v := range ch {
            select {
            case out <- v:
            case <-ctx.Done():
                return
            }
        }
    }

    wg.Add(len(inputs))
    for _, ch := range inputs {
        go drain(ch)
    }

    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}

// MergeOrdered fans in multiple channels but preserves order within
// each input (results from one worker don't interleave within a batch).
// This is useful when processing ordered batches in parallel.
func MergeOrdered[T any](ctx context.Context, inputs []<-chan T) <-chan T {
    out := make(chan T)

    go func() {
        defer close(out)
        // Round-robin through inputs in order
        for _, ch := range inputs {
            for v := range ch {
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
```

### Complete Fan-out/Fan-in Example: Parallel HTTP Requests

```go
package http_fanout

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"
)

// Request represents a single HTTP request to make.
type Request struct {
    URL    string
    Method string
}

// Response wraps an HTTP response with metadata.
type Response struct {
    URL        string
    StatusCode int
    Body       []byte
    Duration   time.Duration
    Err        error
}

// ParallelFetch sends numWorkers concurrent HTTP requests from urls,
// collecting all responses. Respects context cancellation.
func ParallelFetch(
    ctx context.Context,
    client *http.Client,
    urls []string,
    numWorkers int,
) []Response {
    // Step 1: Generate jobs
    jobs := make(chan Request, len(urls))
    for _, url := range urls {
        jobs <- Request{URL: url, Method: http.MethodGet}
    }
    close(jobs)

    // Step 2: Fan out to workers
    resultChans := make([]<-chan Response, numWorkers)
    for i := range numWorkers {
        resultChans[i] = fetchWorker(ctx, client, jobs)
    }

    // Step 3: Fan in results
    merged := mergeResponses(ctx, resultChans...)

    // Step 4: Collect
    var responses []Response
    for r := range merged {
        responses = append(responses, r)
    }
    return responses
}

func fetchWorker(
    ctx context.Context,
    client *http.Client,
    jobs <-chan Request,
) <-chan Response {
    out := make(chan Response)
    go func() {
        defer close(out)
        for job := range jobs {
            start := time.Now()
            resp, err := doRequest(ctx, client, job)
            resp.Duration = time.Since(start)
            resp.Err = err
            select {
            case out <- resp:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

func doRequest(ctx context.Context, client *http.Client, req Request) (Response, error) {
    httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, nil)
    if err != nil {
        return Response{URL: req.URL}, fmt.Errorf("create request: %w", err)
    }
    resp, err := client.Do(httpReq)
    if err != nil {
        return Response{URL: req.URL}, fmt.Errorf("do request: %w", err)
    }
    defer resp.Body.Close()

    var body []byte
    // Read up to 1MB
    buf := make([]byte, 1<<20)
    n, _ := resp.Body.Read(buf)
    body = buf[:n]

    return Response{
        URL:        req.URL,
        StatusCode: resp.StatusCode,
        Body:       body,
    }, nil
}

func mergeResponses(ctx context.Context, channels ...<-chan Response) <-chan Response {
    out := make(chan Response)
    var wg sync.WaitGroup
    wg.Add(len(channels))
    for _, ch := range channels {
        go func(c <-chan Response) {
            defer wg.Done()
            for r := range c {
                select {
                case out <- r:
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

## Section 4: Backpressure with Buffered Channels

Backpressure is the mechanism by which a slow consumer signals to a fast producer to slow down. In Go, the natural backpressure mechanism is the channel send blocking when the buffer is full.

### Backpressure Scenarios

```go
package backpressure

import (
    "context"
    "time"
)

// Throttle demonstrates rate-limited production with backpressure.
// It sends at most rate items per second, but blocks if consumer is slow.
func Throttle[T any](
    ctx context.Context,
    input <-chan T,
    rate int,
    burst int,
) <-chan T {
    out := make(chan T, burst)
    go func() {
        defer close(out)
        ticker := time.NewTicker(time.Second / time.Duration(rate))
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                select {
                case v, ok := <-input:
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
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Debounce groups rapid incoming events and emits the last one
// after a quiet period. Useful for configuration change events.
func Debounce[T any](
    ctx context.Context,
    input <-chan T,
    wait time.Duration,
) <-chan T {
    out := make(chan T, 1)
    go func() {
        defer close(out)
        var (
            last  T
            timer *time.Timer
        )

        flush := func() {
            select {
            case out <- last:
            default:
                // Drop if consumer hasn't caught up
            }
        }

        for {
            select {
            case v, ok := <-input:
                if !ok {
                    if timer != nil {
                        timer.Stop()
                    }
                    flush()
                    return
                }
                last = v
                if timer != nil {
                    timer.Reset(wait)
                } else {
                    timer = time.AfterFunc(wait, flush)
                }
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Batch accumulates items into slices of size n or until timeout elapses.
// This is useful for batching database writes or API calls.
func Batch[T any](
    ctx context.Context,
    input <-chan T,
    size int,
    timeout time.Duration,
) <-chan []T {
    out := make(chan []T)
    go func() {
        defer close(out)
        batch := make([]T, 0, size)
        timer := time.NewTimer(timeout)
        defer timer.Stop()

        send := func() {
            if len(batch) == 0 {
                return
            }
            select {
            case out <- batch:
                batch = make([]T, 0, size)
                timer.Reset(timeout)
            case <-ctx.Done():
            }
        }

        for {
            select {
            case v, ok := <-input:
                if !ok {
                    send()
                    return
                }
                batch = append(batch, v)
                if len(batch) >= size {
                    send()
                }
            case <-timer.C:
                send()
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}
```

## Section 5: Context Cancellation Propagation

Every goroutine that blocks on a channel operation must also listen for context cancellation. Failure to do so causes goroutine leaks: goroutines that block permanently because their channel partner exited.

### Goroutine Leak Patterns and Fixes

```go
package goroutine_leaks

import (
    "context"
    "time"
)

// WRONG: This goroutine leaks if the caller's context is cancelled.
// The goroutine blocks on the send forever if nobody reads from out.
func leakyProducer() <-chan int {
    out := make(chan int)
    go func() {
        for i := 0; ; i++ {
            out <- i  // Blocks forever if consumer exits
        }
    }()
    return out
}

// CORRECT: Context allows the goroutine to exit when done.
func safeProducer(ctx context.Context) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for i := 0; ; i++ {
            select {
            case out <- i:
            case <-ctx.Done():
                return  // Goroutine exits cleanly
            }
        }
    }()
    return out
}

// WRONG: This goroutine leaks if ctx is cancelled while waiting for work.
func leakyWorker(jobs <-chan string) {
    go func() {
        for job := range jobs {
            processJob(job)
        }
        // If jobs is never closed, goroutine waits forever
    }()
}

// CORRECT: Worker exits on context cancellation even if jobs channel is open.
func safeWorker(ctx context.Context, jobs <-chan string) {
    go func() {
        for {
            select {
            case job, ok := <-jobs:
                if !ok {
                    return  // Channel closed
                }
                processJob(job)
            case <-ctx.Done():
                return  // Context cancelled
            }
        }
    }()
}

func processJob(job string) {
    time.Sleep(10 * time.Millisecond)
}
```

### Context Propagation Through Pipeline Stages

```go
package context_propagation

import (
    "context"
    "fmt"
)

// PipelineWithContext demonstrates proper context propagation
// through a multi-stage pipeline.
func PipelineWithContext(ctx context.Context, items []int) ([]string, error) {
    // Derive a cancellable sub-context for the pipeline.
    // If any stage fails, cancel the entire pipeline.
    pipelineCtx, cancel := context.WithCancel(ctx)
    defer cancel()

    // Stage 1: Emit items
    stage1 := emit(pipelineCtx, items)

    // Stage 2: Double each value
    stage2 := double(pipelineCtx, stage1)

    // Stage 3: Format as string
    stage3 := format(pipelineCtx, stage2)

    // Collect results
    var results []string
    for {
        select {
        case s, ok := <-stage3:
            if !ok {
                return results, nil
            }
            results = append(results, s)
        case <-pipelineCtx.Done():
            return results, pipelineCtx.Err()
        }
    }
}

func emit(ctx context.Context, items []int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, v := range items {
            select {
            case out <- v:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

func double(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for v := range in {
            select {
            case out <- v * 2:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

func format(ctx context.Context, in <-chan int) <-chan string {
    out := make(chan string)
    go func() {
        defer close(out)
        for v := range in {
            select {
            case out <- fmt.Sprintf("value=%d", v):
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}
```

## Section 6: errgroup for Concurrent Error Handling

`golang.org/x/sync/errgroup` simplifies the pattern of running multiple goroutines and collecting the first error:

```go
package errgroup_patterns

import (
    "context"
    "fmt"

    "golang.org/x/sync/errgroup"
)

// FetchAll fetches multiple URLs concurrently, returning on the
// first error (and cancelling all other requests via context).
func FetchAll(ctx context.Context, urls []string) ([]string, error) {
    g, gctx := errgroup.WithContext(ctx)
    results := make([]string, len(urls))

    for i, url := range urls {
        i, url := i, url  // Capture loop variables
        g.Go(func() error {
            body, err := fetchURL(gctx, url)
            if err != nil {
                return fmt.Errorf("fetch %s: %w", url, err)
            }
            results[i] = body
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}

// ParallelProcess runs numWorkers goroutines over items.
// Returns all errors encountered (not just the first).
func ParallelProcess[T, R any](
    ctx context.Context,
    items []T,
    numWorkers int,
    process func(context.Context, T) (R, error),
) ([]R, []error) {
    g, gctx := errgroup.WithContext(ctx)
    g.SetLimit(numWorkers)

    results := make([]R, len(items))
    errs := make([]error, len(items))

    for i, item := range items {
        i, item := i, item
        g.Go(func() error {
            r, err := process(gctx, item)
            results[i] = r
            errs[i] = err
            return nil  // Never return error here; we collect them manually
        })
    }

    g.Wait()

    // Collect non-nil errors
    var collectedErrs []error
    for _, e := range errs {
        if e != nil {
            collectedErrs = append(collectedErrs, e)
        }
    }
    return results, collectedErrs
}

func fetchURL(ctx context.Context, url string) (string, error) {
    // Placeholder implementation
    return fmt.Sprintf("body of %s", url), nil
}
```

### errgroup with Streaming Results

```go
package errgroup_streaming

import (
    "context"
    "fmt"

    "golang.org/x/sync/errgroup"
)

// StreamProcess processes items with numWorkers and streams results
// as they complete, rather than waiting for all to finish.
func StreamProcess[T, R any](
    ctx context.Context,
    items []T,
    numWorkers int,
    process func(context.Context, T) (R, error),
) (<-chan R, <-chan error) {
    resultChan := make(chan R, numWorkers)
    errChan := make(chan error, 1)

    go func() {
        g, gctx := errgroup.WithContext(ctx)
        g.SetLimit(numWorkers)

        defer close(resultChan)
        defer close(errChan)

        for _, item := range items {
            item := item
            g.Go(func() error {
                r, err := process(gctx, item)
                if err != nil {
                    return fmt.Errorf("process item: %w", err)
                }
                select {
                case resultChan <- r:
                case <-gctx.Done():
                    return gctx.Err()
                }
                return nil
            })
        }

        if err := g.Wait(); err != nil {
            select {
            case errChan <- err:
            default:
            }
        }
    }()

    return resultChan, errChan
}
```

## Section 7: Semaphore Patterns

A semaphore limits the number of concurrent goroutines accessing a resource. In Go, a buffered channel of empty structs is the idiomatic semaphore.

```go
package semaphore

import (
    "context"
    "fmt"
)

// Semaphore controls access to a limited resource.
type Semaphore struct {
    ch chan struct{}
}

// New creates a Semaphore with n concurrent slots.
func New(n int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire waits for a slot to become available.
// Returns an error if ctx is cancelled before a slot is acquired.
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("semaphore acquire: %w", ctx.Err())
    }
}

// Release returns a slot to the semaphore.
func (s *Semaphore) Release() {
    <-s.ch
}

// WithSemaphore runs fn with the semaphore held.
func (s *Semaphore) WithSemaphore(ctx context.Context, fn func() error) error {
    if err := s.Acquire(ctx); err != nil {
        return err
    }
    defer s.Release()
    return fn()
}

// Example: Limit concurrent database connections
type DBPool struct {
    sem *Semaphore
    // db connection pool...
}

func NewDBPool(maxConcurrent int) *DBPool {
    return &DBPool{
        sem: New(maxConcurrent),
    }
}

func (p *DBPool) Query(ctx context.Context, query string) ([]string, error) {
    if err := p.sem.Acquire(ctx); err != nil {
        return nil, fmt.Errorf("acquire db semaphore: %w", err)
    }
    defer p.sem.Release()

    // Execute query with exclusive slot
    return executeQuery(ctx, query)
}

func executeQuery(ctx context.Context, query string) ([]string, error) {
    // Placeholder
    return []string{"result1", "result2"}, nil
}
```

### golang.org/x/sync/semaphore for Weighted Semaphores

For scenarios where different operations consume different amounts of capacity:

```go
package weighted_semaphore

import (
    "context"
    "fmt"

    "golang.org/x/sync/semaphore"
)

const maxCapacity = 10

// ResourcePool manages operations with variable resource consumption.
type ResourcePool struct {
    sem *semaphore.Weighted
}

func NewResourcePool() *ResourcePool {
    return &ResourcePool{
        sem: semaphore.NewWeighted(maxCapacity),
    }
}

// SmallOperation uses 1 unit of capacity.
func (p *ResourcePool) SmallOperation(ctx context.Context) error {
    if err := p.sem.Acquire(ctx, 1); err != nil {
        return fmt.Errorf("acquire semaphore (small): %w", err)
    }
    defer p.sem.Release(1)

    return runSmallOperation(ctx)
}

// LargeOperation uses 5 units of capacity (e.g., bulk database export).
func (p *ResourcePool) LargeOperation(ctx context.Context) error {
    if err := p.sem.Acquire(ctx, 5); err != nil {
        return fmt.Errorf("acquire semaphore (large): %w", err)
    }
    defer p.sem.Release(5)

    return runLargeOperation(ctx)
}

func runSmallOperation(ctx context.Context) error  { return nil }
func runLargeOperation(ctx context.Context) error  { return nil }
```

## Section 8: Race Condition Detection with -race

The Go race detector instruments memory accesses and reports data races at runtime. It should be used in CI pipelines and test suites.

### Running the Race Detector

```bash
# Run tests with race detector
go test -race ./...

# Build with race detector enabled (for staging/testing only)
go build -race -o myapp-race ./cmd/myapp

# Run benchmarks with race detector
go test -race -bench=. ./...

# Set race detector options via environment variable
GORACE="halt_on_error=1 log_path=/tmp/race" go test -race ./...
```

### Common Race Condition Patterns and Fixes

```go
package race_examples

import (
    "sync"
)

// WRONG: Concurrent map access without synchronization.
func raceOnMap() {
    m := make(map[string]int)
    go func() { m["key"] = 1 }()
    go func() { _ = m["key"] }()
    // Race detected: concurrent read and write
}

// CORRECT: Use sync.Map for concurrent access.
func safeMap() {
    var m sync.Map
    go func() { m.Store("key", 1) }()
    go func() { m.Load("key") }()
}

// WRONG: Capturing loop variable by reference.
func loopRace() {
    funcs := make([]func(), 5)
    for i := 0; i < 5; i++ {
        funcs[i] = func() {
            _ = i  // All functions capture the same i
        }
    }
}

// CORRECT: Capture by value.
func loopSafe() {
    funcs := make([]func(), 5)
    for i := 0; i < 5; i++ {
        i := i  // Shadow i to capture by value
        funcs[i] = func() {
            _ = i  // Each closure has its own i
        }
    }
}

// WRONG: Unsynchronized counter.
type UnsafeCounter struct {
    count int
}

func (c *UnsafeCounter) Increment() {
    c.count++  // Not atomic
}

// CORRECT: Use atomic operations or mutex.
type AtomicCounter struct {
    count int64
}

func (c *AtomicCounter) Increment() {
    // Use sync/atomic for simple counters
    _ = c.count // placeholder for atomic.AddInt64(&c.count, 1)
}

type MutexCounter struct {
    mu    sync.Mutex
    count int
}

func (c *MutexCounter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

func (c *MutexCounter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}
```

### Writing Race-Safe Tests

```go
package race_tests

import (
    "context"
    "sync"
    "testing"
    "time"
)

// TestConcurrentAccess verifies that the cache is safe under concurrent use.
// Run with: go test -race -count=100 ./...
func TestConcurrentAccess(t *testing.T) {
    cache := NewCache[string, int](100)

    var wg sync.WaitGroup
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    const goroutines = 50
    const ops = 1000

    for i := range goroutines {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            for j := range ops {
                key := fmt.Sprintf("key-%d-%d", id, j%10)
                cache.Set(key, j)
                if _, ok := cache.Get(key); !ok {
                    // May be evicted; that's OK
                }
                select {
                case <-ctx.Done():
                    return
                default:
                }
            }
        }(i)
    }

    wg.Wait()
}
```

## Section 9: Production Patterns

### Graceful Shutdown with Channel Coordination

```go
package shutdown

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

// Server demonstrates proper graceful shutdown coordination.
type Server struct {
    workers    []*Worker
    workerWg   sync.WaitGroup
    shutdownCh chan struct{}
}

type Worker struct {
    id   int
    jobs <-chan string
}

func (s *Server) Run(ctx context.Context) error {
    // Create a context that is cancelled on OS signals
    ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
    defer cancel()

    // Start workers
    jobs := make(chan string, 100)
    for i := range 5 {
        w := &Worker{id: i, jobs: jobs}
        s.workers = append(s.workers, w)
        s.workerWg.Add(1)
        go func() {
            defer s.workerWg.Done()
            w.run(ctx)
        }()
    }

    // Wait for shutdown signal
    <-ctx.Done()
    slog.Info("shutdown signal received, draining workers")

    // Stop accepting new jobs
    close(jobs)

    // Wait for workers to drain with a timeout
    done := make(chan struct{})
    go func() {
        s.workerWg.Wait()
        close(done)
    }()

    select {
    case <-done:
        slog.Info("all workers drained cleanly")
        return nil
    case <-time.After(30 * time.Second):
        slog.Warn("shutdown timeout: forcing exit")
        return context.DeadlineExceeded
    }
}

func (w *Worker) run(ctx context.Context) {
    for {
        select {
        case job, ok := <-w.jobs:
            if !ok {
                slog.Info("worker exiting", "id", w.id)
                return
            }
            processJobWithTimeout(ctx, job)
        case <-ctx.Done():
            slog.Info("worker context cancelled", "id", w.id)
            return
        }
    }
}

func processJobWithTimeout(ctx context.Context, job string) {
    // Use a derived context with per-job timeout
    jobCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()
    _ = jobCtx
    _ = job
    // perform actual work
}
```

### Channel Direction Constraints

Using directional channel types in function signatures makes data flow explicit and prevents accidental bidirectional use:

```go
package direction

// Produce only writes to the channel.
func Produce(out chan<- int, values []int) {
    for _, v := range values {
        out <- v
    }
    close(out)
}

// Consume only reads from the channel.
func Consume(in <-chan int) []int {
    var result []int
    for v := range in {
        result = append(result, v)
    }
    return result
}

// Pipe passes data through, reading from in and writing to out.
func Pipe(in <-chan int, out chan<- int) {
    for v := range in {
        out <- v
    }
    close(out)
}
```

## Conclusion

The patterns in this guide form the foundation of production-quality concurrent Go programs. Pipeline stages with proper context propagation and channel closure semantics ensure that goroutines never leak. Fan-out worker pools with bounded queues and backpressure prevent runaway memory growth under load spikes. errgroup centralizes error handling across concurrent operations without the complexity of manual error channel management.

The race detector is the most valuable tool in the concurrent Go developer's toolkit—running tests with `-race` as a default CI requirement catches data races that are deterministic under certain timing conditions but nearly invisible in normal operation. Combined with integration tests that exercise the concurrent paths under realistic load, these patterns produce services that handle concurrency failures gracefully rather than silently.
