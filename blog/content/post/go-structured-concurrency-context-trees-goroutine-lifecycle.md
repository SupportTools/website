---
title: "Go Structured Concurrency: Context Trees and Goroutine Lifecycle Management"
date: 2030-10-19T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Goroutines", "Context", "errgroup", "Graceful Shutdown", "Production"]
categories:
- Go
- Systems Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced goroutine management in Go: errgroup vs sync.WaitGroup patterns, context cancellation trees, goroutine leak detection with goleak, shutdown ordering with graceful termination, and building robust concurrent services."
more_link: "yes"
url: "/go-structured-concurrency-context-trees-goroutine-lifecycle/"
---

Go's goroutines are cheap to create but require disciplined management to avoid leaks, orphaned work, and unpredictable shutdown behavior. Production services that launch goroutines without explicit lifecycle management accumulate goroutines over time, making them impossible to shut down gracefully, difficult to test, and prone to resource exhaustion under load. Structured concurrency patterns provide the discipline needed to reason about goroutine lifecycles across complex codebases.

<!--more-->

## The Goroutine Leak Problem

A goroutine leak occurs when a goroutine is started but never exits, either because it blocks indefinitely on a channel or network operation, or because it was designed to run until a signal it never receives.

```go
// PROBLEMATIC: goroutine leaked on client disconnect
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // This goroutine will run forever if the result channel is never read
    resultCh := make(chan Result)
    go func() {
        result, err := expensiveComputation()
        if err == nil {
            resultCh <- result  // BLOCKS if the HTTP handler already returned
        }
    }()

    select {
    case result := <-resultCh:
        json.NewEncoder(w).Encode(result)
    case <-time.After(5 * time.Second):
        http.Error(w, "timeout", 504)
        // goroutine is now leaked - no one will read from resultCh
    }
}

// CORRECT: goroutine exits when context is cancelled
func handleRequestFixed(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    resultCh := make(chan Result, 1)  // Buffered to prevent goroutine block
    go func() {
        result, err := expensiveComputationCtx(ctx)
        if err == nil {
            select {
            case resultCh <- result:
            case <-ctx.Done():  // Exits when context is cancelled
            }
        }
    }()

    select {
    case result := <-resultCh:
        json.NewEncoder(w).Encode(result)
    case <-ctx.Done():
        http.Error(w, "timeout", 504)
        // goroutine will exit via ctx.Done() branch above
    }
}
```

## errgroup: The Foundation of Structured Go Concurrency

`golang.org/x/sync/errgroup` provides a clean API for running a group of goroutines with shared context and error propagation:

```go
// pkg/concurrent/errgroup_patterns.go
package concurrent

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/sync/errgroup"
)

// ParallelFetch fetches multiple URLs concurrently and collects all results.
// If any fetch fails, the context is cancelled and all remaining fetches abort.
func ParallelFetch(ctx context.Context, urls []string) ([]string, error) {
    g, ctx := errgroup.WithContext(ctx)
    results := make([]string, len(urls))

    for i, url := range urls {
        i, url := i, url  // Capture loop variables
        g.Go(func() error {
            body, err := fetchURL(ctx, url)
            if err != nil {
                return fmt.Errorf("fetching %s: %w", url, err)
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

// BoundedParallelWork processes items concurrently with a worker limit.
func BoundedParallelWork[T, R any](
    ctx context.Context,
    items []T,
    maxConcurrent int,
    process func(context.Context, T) (R, error),
) ([]R, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(maxConcurrent)  // Bounded concurrency (errgroup v0.4.0+)

    results := make([]R, len(items))

    for i, item := range items {
        i, item := i, item
        g.Go(func() error {
            result, err := process(ctx, item)
            if err != nil {
                return fmt.Errorf("item %d: %w", i, err)
            }
            results[i] = result
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}

// FanOut distributes work across N workers using a shared input channel.
func FanOut[T any](
    ctx context.Context,
    input <-chan T,
    workers int,
    process func(context.Context, T) error,
) error {
    g, ctx := errgroup.WithContext(ctx)

    for range workers {
        g.Go(func() error {
            for {
                select {
                case item, ok := <-input:
                    if !ok {
                        return nil  // Channel closed, worker done
                    }
                    if err := process(ctx, item); err != nil {
                        return err
                    }
                case <-ctx.Done():
                    return ctx.Err()
                }
            }
        })
    }

    return g.Wait()
}
```

## Context Cancellation Trees

Context trees provide hierarchical cancellation — cancelling a parent context cancels all child contexts derived from it. This maps naturally to service request lifecycles.

```go
// pkg/concurrent/context_tree.go
package concurrent

import (
    "context"
    "log/slog"
    "time"
)

// ServiceContext represents the lifecycle of a long-running service component.
type ServiceContext struct {
    // root is the top-level context that cancels everything when the service shuts down.
    root    context.Context
    rootCancel context.CancelFunc

    logger *slog.Logger
}

// NewServiceContext creates the root context for a service.
func NewServiceContext(logger *slog.Logger) *ServiceContext {
    ctx, cancel := context.WithCancel(context.Background())
    return &ServiceContext{
        root:       ctx,
        rootCancel: cancel,
        logger:     logger,
    }
}

// Shutdown cancels the root context, propagating cancellation to all children.
func (sc *ServiceContext) Shutdown() {
    sc.logger.Info("initiating service shutdown")
    sc.rootCancel()
}

// RequestContext creates a child context for handling a single request.
// It inherits the service root context's cancellation.
func (sc *ServiceContext) RequestContext(timeout time.Duration) (context.Context, context.CancelFunc) {
    return context.WithTimeout(sc.root, timeout)
}

// ComponentContext creates a child context for a long-running component.
func (sc *ServiceContext) ComponentContext(name string) (context.Context, context.CancelFunc) {
    ctx, cancel := context.WithCancel(sc.root)
    // Annotate the context with component name for debugging
    ctx = context.WithValue(ctx, contextKeyComponent{}, name)
    return ctx, cancel
}

// Done returns the root context's done channel.
func (sc *ServiceContext) Done() <-chan struct{} {
    return sc.root.Done()
}

type contextKeyComponent struct{}

// ComponentFromContext retrieves the component name from a context.
func ComponentFromContext(ctx context.Context) string {
    if name, ok := ctx.Value(contextKeyComponent{}).(string); ok {
        return name
    }
    return "unknown"
}

// ContextTree demonstrates a three-level context hierarchy.
//
// ServiceContext (root) - cancelled on SIGTERM
//     ├── ComponentContext (http-server) - cancelled when HTTP server stops
//     │       └── RequestContext (per-request) - cancelled after timeout
//     ├── ComponentContext (grpc-server) - cancelled when gRPC server stops
//     │       └── RequestContext (per-request)
//     └── ComponentContext (background-jobs) - cancelled when jobs stop
//             └── JobContext (per-job) - cancelled after job timeout
```

## Graceful Shutdown Ordering

Services must shut down components in the correct order: stop accepting new requests, drain in-flight requests, then stop background components.

```go
// internal/server/lifecycle.go
package server

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "golang.org/x/sync/errgroup"
)

// ShutdownManager orchestrates graceful shutdown with ordering guarantees.
type ShutdownManager struct {
    logger *slog.Logger

    // stopAccepting signals load balancers to stop sending traffic.
    // Called first during shutdown.
    stopAccepting []func()

    // drainInFlight waits for active requests to complete.
    // Called after stopAccepting.
    drainInFlight []func(ctx context.Context) error

    // stopBackground shuts down background workers.
    // Called after drainInFlight.
    stopBackground []func(ctx context.Context) error

    // stopDependencies shuts down database connections, message brokers, etc.
    // Called last.
    stopDependencies []func(ctx context.Context) error
}

// Run starts the service and blocks until a termination signal is received.
func (sm *ShutdownManager) Run(
    ctx context.Context,
    startFuncs ...func(ctx context.Context) error,
) error {
    g, ctx := errgroup.WithContext(ctx)

    // Start all service components
    for _, start := range startFuncs {
        start := start
        g.Go(func() error {
            return start(ctx)
        })
    }

    // Wait for termination signal or component failure
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    defer signal.Stop(sigCh)

    select {
    case sig := <-sigCh:
        sm.logger.Info("received termination signal", "signal", sig)
    case <-ctx.Done():
        sm.logger.Info("context cancelled, initiating shutdown")
    }

    return sm.shutdown(g)
}

// shutdown executes the ordered shutdown sequence.
func (sm *ShutdownManager) shutdown(g *errgroup.Group) error {
    sm.logger.Info("starting graceful shutdown sequence")

    // Phase 1: Stop accepting new requests (instant, no timeout)
    sm.logger.Info("phase 1: stopping new request acceptance")
    for _, fn := range sm.stopAccepting {
        fn()
    }

    // Phase 2: Drain in-flight requests (30-second deadline)
    sm.logger.Info("phase 2: draining in-flight requests")
    drainCtx, drainCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer drainCancel()

    var drainWg sync.WaitGroup
    drainErrors := make(chan error, len(sm.drainInFlight))
    for _, fn := range sm.drainInFlight {
        fn := fn
        drainWg.Add(1)
        go func() {
            defer drainWg.Done()
            if err := fn(drainCtx); err != nil {
                drainErrors <- err
            }
        }()
    }
    drainWg.Wait()
    close(drainErrors)

    for err := range drainErrors {
        sm.logger.Warn("error during request drain", "error", err)
    }

    // Phase 3: Stop background workers (20-second deadline)
    sm.logger.Info("phase 3: stopping background workers")
    bgCtx, bgCancel := context.WithTimeout(context.Background(), 20*time.Second)
    defer bgCancel()

    bgGroup, bgCtx := errgroup.WithContext(bgCtx)
    for _, fn := range sm.stopBackground {
        fn := fn
        bgGroup.Go(func() error {
            return fn(bgCtx)
        })
    }
    if err := bgGroup.Wait(); err != nil {
        sm.logger.Warn("errors during background shutdown", "error", err)
    }

    // Phase 4: Close dependencies (10-second deadline)
    sm.logger.Info("phase 4: closing dependencies")
    depCtx, depCancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer depCancel()

    depGroup, depCtx := errgroup.WithContext(depCtx)
    for _, fn := range sm.stopDependencies {
        fn := fn
        depGroup.Go(func() error {
            return fn(depCtx)
        })
    }
    if err := depGroup.Wait(); err != nil {
        sm.logger.Warn("errors during dependency shutdown", "error", err)
    }

    sm.logger.Info("graceful shutdown complete")

    // Return any errors from the running components
    return g.Wait()
}

// RegisterHTTPServer registers an HTTP server for managed lifecycle.
func (sm *ShutdownManager) RegisterHTTPServer(server *http.Server, readinessToggle func(bool)) {
    // Stop accepting: remove from load balancer rotation immediately
    sm.stopAccepting = append(sm.stopAccepting, func() {
        if readinessToggle != nil {
            readinessToggle(false)  // Mark not-ready in health checks
        }
    })

    // Drain: wait for existing requests to finish
    sm.drainInFlight = append(sm.drainInFlight, func(ctx context.Context) error {
        sm.logger.Info("HTTP server: draining connections")
        return server.Shutdown(ctx)
    })
}
```

## Goroutine Leak Detection with goleak

```go
// test/goroutine_leak_test.go
package server_test

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "go.uber.org/goleak"
    "your.org/internal/server"
)

// TestNoGoroutineLeak verifies that the server cleans up all goroutines on shutdown.
func TestNoGoroutineLeak(t *testing.T) {
    // goleak.VerifyNone reports any goroutines leaked after the test
    defer goleak.VerifyNone(t,
        // Ignore known background goroutines from libraries
        goleak.IgnoreTopFunction("net/http.(*Server).Serve"),
        goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"),
    )

    // Create server with background worker
    srv := server.New(server.Config{
        Port:          0,  // Random port
        WorkerCount:   5,
        JobQueueDepth: 100,
    })

    // Start the server
    ctx, cancel := context.WithCancel(context.Background())
    errCh := make(chan error, 1)
    go func() {
        errCh <- srv.Run(ctx)
    }()

    // Allow server to start
    time.Sleep(100 * time.Millisecond)

    // Send some requests to start goroutines
    for i := 0; i < 10; i++ {
        resp, err := http.Get("http://" + srv.Addr() + "/work")
        if err == nil {
            resp.Body.Close()
        }
    }

    // Trigger shutdown
    cancel()

    // Wait for clean shutdown
    select {
    case err := <-errCh:
        if err != nil && err != context.Canceled {
            t.Fatalf("server returned unexpected error: %v", err)
        }
    case <-time.After(15 * time.Second):
        t.Fatal("server did not shut down within 15 seconds")
    }

    // goleak.VerifyNone deferred above will check for leaked goroutines
}

// TestGoroutineLeakInHandler catches leaks specific to individual handlers.
func TestGoroutineLeakInHandler(t *testing.T) {
    defer goleak.VerifyNone(t)

    handler := server.NewWorkHandler(server.HandlerConfig{
        Timeout:     5 * time.Second,
        MaxInFlight: 10,
    })

    for i := 0; i < 20; i++ {
        req := httptest.NewRequest("POST", "/work", nil)
        w := httptest.NewRecorder()
        handler.ServeHTTP(w, req)
    }

    // All handler goroutines should have exited by now
}
```

## Semaphore-Based Concurrency Limiting

```go
// pkg/concurrent/semaphore.go
package concurrent

import (
    "context"
    "fmt"
)

// Semaphore controls concurrent access to a resource pool.
type Semaphore struct {
    ch chan struct{}
}

// NewSemaphore creates a semaphore with the given capacity.
func NewSemaphore(n int) *Semaphore {
    return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire acquires one token, blocking until available or context cancelled.
func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case s.ch <- struct{}{}:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("semaphore acquire: %w", ctx.Err())
    }
}

// Release releases one token back to the semaphore.
func (s *Semaphore) Release() {
    <-s.ch
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

// Available returns the number of tokens currently available.
func (s *Semaphore) Available() int {
    return cap(s.ch) - len(s.ch)
}

// WithSemaphore runs fn with a semaphore token acquired.
func (s *Semaphore) WithSemaphore(ctx context.Context, fn func() error) error {
    if err := s.Acquire(ctx); err != nil {
        return err
    }
    defer s.Release()
    return fn()
}
```

## Worker Pool Implementation

```go
// pkg/concurrent/workerpool.go
package concurrent

import (
    "context"
    "fmt"
    "log/slog"
    "sync"
    "sync/atomic"
)

// Job represents a unit of work submitted to the pool.
type Job[T, R any] struct {
    ID     string
    Input  T
    result chan jobResult[R]
}

type jobResult[R any] struct {
    value R
    err   error
}

// WorkerPool manages a pool of goroutines processing typed jobs.
type WorkerPool[T, R any] struct {
    workers    int
    queue      chan Job[T, R]
    process    func(context.Context, T) (R, error)
    logger     *slog.Logger
    wg         sync.WaitGroup
    submitted  atomic.Int64
    completed  atomic.Int64
    failed     atomic.Int64
    closed     atomic.Bool
}

// NewWorkerPool creates a worker pool with the given configuration.
func NewWorkerPool[T, R any](
    workers int,
    queueDepth int,
    process func(context.Context, T) (R, error),
    logger *slog.Logger,
) *WorkerPool[T, R] {
    return &WorkerPool[T, R]{
        workers: workers,
        queue:   make(chan Job[T, R], queueDepth),
        process: process,
        logger:  logger,
    }
}

// Start launches the worker goroutines.
// Returns when the context is cancelled.
func (p *WorkerPool[T, R]) Start(ctx context.Context) {
    for i := range p.workers {
        p.wg.Add(1)
        go p.runWorker(ctx, i)
    }
    p.wg.Wait()
    p.logger.Info("worker pool stopped",
        "submitted", p.submitted.Load(),
        "completed", p.completed.Load(),
        "failed", p.failed.Load())
}

// Submit sends a job to the pool. Blocks if the queue is full.
// Returns an error if the pool is closed.
func (p *WorkerPool[T, R]) Submit(ctx context.Context, id string, input T) (R, error) {
    if p.closed.Load() {
        var zero R
        return zero, fmt.Errorf("worker pool is closed")
    }

    job := Job[T, R]{
        ID:     id,
        Input:  input,
        result: make(chan jobResult[R], 1),
    }

    p.submitted.Add(1)

    select {
    case p.queue <- job:
    case <-ctx.Done():
        var zero R
        return zero, fmt.Errorf("submitting job %s: %w", id, ctx.Err())
    }

    select {
    case result := <-job.result:
        if result.err != nil {
            p.failed.Add(1)
            return result.value, result.err
        }
        p.completed.Add(1)
        return result.value, nil
    case <-ctx.Done():
        var zero R
        return zero, fmt.Errorf("waiting for job %s result: %w", id, ctx.Err())
    }
}

// Close drains the queue and stops accepting new work.
func (p *WorkerPool[T, R]) Close() {
    p.closed.Store(true)
    close(p.queue)
}

// Stats returns pool statistics.
func (p *WorkerPool[T, R]) Stats() map[string]int64 {
    return map[string]int64{
        "submitted": p.submitted.Load(),
        "completed": p.completed.Load(),
        "failed":    p.failed.Load(),
        "pending":   int64(len(p.queue)),
    }
}

func (p *WorkerPool[T, R]) runWorker(ctx context.Context, id int) {
    defer p.wg.Done()

    p.logger.Debug("worker started", "worker_id", id)

    for {
        select {
        case job, ok := <-p.queue:
            if !ok {
                p.logger.Debug("worker stopping: queue closed", "worker_id", id)
                return
            }

            result, err := p.process(ctx, job.Input)
            job.result <- jobResult[R]{value: result, err: err}

        case <-ctx.Done():
            p.logger.Debug("worker stopping: context cancelled", "worker_id", id)
            // Drain remaining jobs with cancellation error
            for {
                select {
                case job, ok := <-p.queue:
                    if !ok {
                        return
                    }
                    var zero R
                    job.result <- jobResult[R]{
                        value: zero,
                        err:   fmt.Errorf("worker pool shutting down: %w", ctx.Err()),
                    }
                default:
                    return
                }
            }
        }
    }
}
```

## Complete Server Lifecycle Example

```go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "time"

    "golang.org/x/sync/errgroup"
    "your.org/pkg/concurrent"
    "your.org/internal/handlers"
    "your.org/internal/workers"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    if err := run(logger); err != nil {
        logger.Error("server exited with error", "error", err)
        os.Exit(1)
    }
}

func run(logger *slog.Logger) error {
    // Root context for the entire service
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Create components
    pool := concurrent.NewWorkerPool[workers.Job, workers.Result](
        10,     // workers
        1000,   // queue depth
        workers.Process,
        logger,
    )

    httpMux := http.NewServeMux()
    httpMux.Handle("/work", handlers.NewWorkHandler(pool))
    httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    httpServer := &http.Server{
        Addr:         ":8080",
        Handler:      httpMux,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Lifecycle manager
    sm := &ShutdownManager{logger: logger}
    sm.RegisterHTTPServer(httpServer, nil)

    // Run all components concurrently
    g, ctx := errgroup.WithContext(ctx)

    // HTTP server
    g.Go(func() error {
        logger.Info("HTTP server starting", "addr", httpServer.Addr)
        if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            return fmt.Errorf("HTTP server: %w", err)
        }
        return nil
    })

    // Worker pool
    g.Go(func() error {
        pool.Start(ctx)
        return nil
    })

    // Metrics collection goroutine
    g.Go(func() error {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                stats := pool.Stats()
                logger.Info("pool stats",
                    "submitted", stats["submitted"],
                    "completed", stats["completed"],
                    "failed", stats["failed"],
                    "pending", stats["pending"],
                )
            case <-ctx.Done():
                return nil
            }
        }
    })

    return sm.Run(ctx)
}
```

Structured concurrency in Go is not a library feature — it is a discipline. The patterns described here are effective because they enforce invariants: every goroutine has an explicit owner, every goroutine can be cancelled via context, and shutdown ordering is explicit and tested. Services built with these patterns can be debugged with goroutine dumps, tested with goleak, and operated with confidence during on-call rotations.
