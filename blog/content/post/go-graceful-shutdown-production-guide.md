---
title: "Go Graceful Shutdown Patterns for Production: SIGTERM, Connection Draining, and Kubernetes"
date: 2028-05-18T00:00:00-05:00
draft: false
tags: ["Go", "Kubernetes", "SIGTERM", "Graceful Shutdown", "Production", "HTTP Server", "Context"]
categories: ["Go", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go graceful shutdown: signal handling, draining HTTP and gRPC connections, propagating shutdown context, testing shutdown behavior, and Kubernetes SIGTERM lifecycle integration."
more_link: "yes"
url: "/go-graceful-shutdown-production-guide/"
---

Abrupt process termination during deployments causes request failures, data corruption, and connection errors visible to end users. Kubernetes sends SIGTERM before SIGKILL, providing a window for clean shutdown. But that window is only useful if the application handles it correctly. This guide covers the complete spectrum of Go graceful shutdown patterns: signal handling, HTTP server draining, gRPC shutdown, database connection cleanup, background worker termination, and the Kubernetes lifecycle hooks that interact with your shutdown sequence.

<!--more-->

## Why Graceful Shutdown Matters

During a rolling deployment, Kubernetes:

1. Sends SIGTERM to the container
2. Waits `terminationGracePeriodSeconds` (default: 30s)
3. Sends SIGKILL if the process hasn't exited

Between steps 1 and 3, existing requests must complete. New requests should not be routed to the pod (the readiness probe removes it from service endpoints), but in-flight requests must finish cleanly. Without proper shutdown handling:

- HTTP requests in progress return 502 or get RST
- gRPC streams are severed mid-message
- Database transactions are rolled back
- Message queue messages are requeued (or lost)
- File writes are incomplete

The cost is real: users see errors during every deployment. With proper shutdown, zero errors during rolling updates.

## Basic Signal Handling

```go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // Create root context that cancels on signal
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT,
        syscall.SIGTERM,
    )
    defer stop()

    // Start your server/services here
    server := NewServer()
    go server.Start()

    // Wait for signal
    <-ctx.Done()
    log.Println("Shutdown signal received")

    // Give components time to clean up
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Printf("Shutdown error: %v", err)
        os.Exit(1)
    }

    log.Println("Shutdown complete")
}
```

`signal.NotifyContext` is the modern approach (Go 1.16+). It integrates signals directly into the context tree, enabling context-aware shutdown propagation throughout the application.

## HTTP Server Graceful Shutdown

### Standard Library HTTP Server

```go
package server

import (
    "context"
    "errors"
    "fmt"
    "log"
    "net"
    "net/http"
    "time"
)

type Server struct {
    httpServer *http.Server
    listener   net.Listener
}

func New(addr string, handler http.Handler) (*Server, error) {
    ln, err := net.Listen("tcp", addr)
    if err != nil {
        return nil, fmt.Errorf("creating listener: %w", err)
    }

    srv := &http.Server{
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
        // Critical: register a shutdown hook on each connection
        ConnState: func(conn net.Conn, state http.ConnState) {
            // log.Printf("conn %s: %s", conn.RemoteAddr(), state)
        },
    }

    return &Server{
        httpServer: srv,
        listener:   ln,
    }, nil
}

func (s *Server) Start() error {
    if err := s.httpServer.Serve(s.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
        return fmt.Errorf("serving: %w", err)
    }
    return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
    // Shutdown stops new connections and waits for active requests
    // to complete. ctx controls the maximum wait time.
    log.Println("HTTP server: draining connections...")

    if err := s.httpServer.Shutdown(ctx); err != nil {
        return fmt.Errorf("http shutdown: %w", err)
    }

    log.Println("HTTP server: all connections drained")
    return nil
}
```

**Critical**: `http.Server.Shutdown()` stops accepting new connections, waits for active requests to complete, then closes idle connections. It does NOT interrupt active requests. If requests run indefinitely, shutdown will block until the context deadline.

### Ensuring Handlers Respect Shutdown Context

Handlers must check `Request.Context()` to honor shutdown:

```go
func longRunningHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Use the request context for all downstream operations
    result, err := fetchFromDatabase(ctx, r.URL.Query().Get("id"))
    if err != nil {
        if errors.Is(err, context.Canceled) {
            // Request context was canceled (client disconnect or shutdown)
            log.Printf("Handler canceled: %v", ctx.Err())
            return
        }
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    // Stream response in chunks, checking context
    for _, chunk := range result.Chunks() {
        select {
        case <-ctx.Done():
            log.Printf("Response streaming interrupted: %v", ctx.Err())
            return
        default:
        }

        if _, err := w.Write(chunk); err != nil {
            return
        }
        if f, ok := w.(http.Flusher); ok {
            f.Flush()
        }
    }
}
```

### Maximum Request Duration with Middleware

Add a maximum duration to all requests to ensure shutdown completes within the grace period:

```go
func maxDurationMiddleware(maxDuration time.Duration, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx, cancel := context.WithTimeout(r.Context(), maxDuration)
        defer cancel()
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Apply with margin below terminationGracePeriodSeconds
mux := http.NewServeMux()
handler := maxDurationMiddleware(25*time.Second, mux)
```

## gRPC Server Graceful Shutdown

```go
package grpcserver

import (
    "context"
    "fmt"
    "log"
    "net"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"
)

type Server struct {
    grpcServer     *grpc.Server
    healthServer   *health.Server
    listener       net.Listener
    serviceName    string
}

func New(addr string, serviceName string, opts ...grpc.ServerOption) (*Server, error) {
    ln, err := net.Listen("tcp", addr)
    if err != nil {
        return nil, fmt.Errorf("listen: %w", err)
    }

    defaultOpts := []grpc.ServerOption{
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Minute,
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 5 * time.Second,  // Allow RPCs to finish
            Time:                  5 * time.Minute,
            Timeout:               20 * time.Second,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             5 * time.Second,
            PermitWithoutStream: true,
        }),
    }
    opts = append(defaultOpts, opts...)

    srv := grpc.NewServer(opts...)
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(srv, healthSrv)
    reflection.Register(srv)

    return &Server{
        grpcServer:   srv,
        healthServer: healthSrv,
        listener:     ln,
        serviceName:  serviceName,
    }, nil
}

func (s *Server) RegisterService(sd *grpc.ServiceDesc, impl interface{}) {
    s.grpcServer.RegisterService(sd, impl)
    s.healthServer.SetServingStatus(s.serviceName, grpc_health_v1.HealthCheckResponse_SERVING)
}

func (s *Server) Start() error {
    if err := s.grpcServer.Serve(s.listener); err != nil {
        return fmt.Errorf("serve: %w", err)
    }
    return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
    // Signal unhealthy BEFORE stopping - lets load balancers drain connections
    s.healthServer.SetServingStatus(s.serviceName, grpc_health_v1.HealthCheckResponse_NOT_SERVING)
    log.Println("gRPC server: set NOT_SERVING, waiting for load balancer drain...")

    // Short sleep to let load balancers pick up health status change
    // This is critical for zero-downtime deployments
    time.Sleep(5 * time.Second)

    log.Println("gRPC server: graceful stop initiated...")

    // GracefulStop waits for all RPCs to complete
    // Run with context deadline
    stopped := make(chan struct{})
    go func() {
        s.grpcServer.GracefulStop()
        close(stopped)
    }()

    select {
    case <-ctx.Done():
        log.Println("gRPC server: grace period expired, forcing stop")
        s.grpcServer.Stop()
        return ctx.Err()
    case <-stopped:
        log.Println("gRPC server: all RPCs completed")
        return nil
    }
}
```

## Shutdown Context Propagation

The shutdown signal must propagate through the entire dependency chain:

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

type App struct {
    httpServer  *HTTPServer
    grpcServer  *GRPCServer
    workerPool  *WorkerPool
    db          *DatabasePool
    cache       *CacheClient
    logger      *Logger
}

func (a *App) Run(ctx context.Context) error {
    // Use errgroup for concurrent service management
    var wg sync.WaitGroup
    errCh := make(chan error, 4)

    wg.Add(1)
    go func() {
        defer wg.Done()
        if err := a.httpServer.Start(); err != nil {
            errCh <- fmt.Errorf("http server: %w", err)
        }
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        if err := a.grpcServer.Start(); err != nil {
            errCh <- fmt.Errorf("grpc server: %w", err)
        }
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        if err := a.workerPool.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
            errCh <- fmt.Errorf("worker pool: %w", err)
        }
    }()

    // Wait for shutdown signal or service failure
    select {
    case <-ctx.Done():
        log.Println("Shutdown signal received, starting graceful shutdown")
    case err := <-errCh:
        return fmt.Errorf("service failure: %w", err)
    }

    // Orchestrate shutdown in dependency order
    return a.shutdown()
}

func (a *App) shutdown() error {
    // Total budget: 25 seconds (leave 5s buffer before SIGKILL at 30s)
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()

    var errs []error

    // Phase 1: Stop accepting new traffic (5s budget)
    // Set readiness probe to failing first - handled by Kubernetes lifecycle
    // Then stop servers
    phase1Ctx, phase1Cancel := context.WithTimeout(shutdownCtx, 5*time.Second)
    defer phase1Cancel()

    log.Println("Phase 1: Stopping servers...")
    if err := a.httpServer.Shutdown(phase1Ctx); err != nil {
        errs = append(errs, fmt.Errorf("http shutdown: %w", err))
    }
    if err := a.grpcServer.Shutdown(phase1Ctx); err != nil {
        errs = append(errs, fmt.Errorf("grpc shutdown: %w", err))
    }

    // Phase 2: Drain in-flight work (15s budget)
    log.Println("Phase 2: Draining worker pool...")
    phase2Ctx, phase2Cancel := context.WithTimeout(shutdownCtx, 15*time.Second)
    defer phase2Cancel()

    if err := a.workerPool.Drain(phase2Ctx); err != nil {
        errs = append(errs, fmt.Errorf("worker drain: %w", err))
    }

    // Phase 3: Close infrastructure connections (5s budget)
    log.Println("Phase 3: Closing connections...")
    if err := a.cache.Close(); err != nil {
        errs = append(errs, fmt.Errorf("cache close: %w", err))
    }
    if err := a.db.Close(); err != nil {
        errs = append(errs, fmt.Errorf("db close: %w", err))
    }

    if len(errs) > 0 {
        return fmt.Errorf("shutdown errors: %v", errs)
    }

    log.Println("Shutdown complete")
    return nil
}
```

## Worker Pool Graceful Shutdown

Background workers must drain their in-flight work:

```go
package worker

import (
    "context"
    "log"
    "sync"
)

type WorkerPool struct {
    concurrency int
    jobs        chan Job
    wg          sync.WaitGroup
}

type Job interface {
    Execute(ctx context.Context) error
}

func NewWorkerPool(concurrency int, bufferSize int) *WorkerPool {
    return &WorkerPool{
        concurrency: concurrency,
        jobs:        make(chan Job, bufferSize),
    }
}

func (p *WorkerPool) Run(ctx context.Context) error {
    for i := 0; i < p.concurrency; i++ {
        p.wg.Add(1)
        go func(id int) {
            defer p.wg.Done()
            for {
                select {
                case job, ok := <-p.jobs:
                    if !ok {
                        log.Printf("Worker %d: channel closed, exiting", id)
                        return
                    }
                    if err := job.Execute(ctx); err != nil {
                        if ctx.Err() != nil {
                            log.Printf("Worker %d: job canceled during shutdown", id)
                            return
                        }
                        log.Printf("Worker %d: job error: %v", id, err)
                    }
                case <-ctx.Done():
                    // Drain remaining queued jobs with short deadline
                    drainCtx, cancel := context.WithTimeout(
                        context.Background(), 5*time.Second)
                    defer cancel()

                    for {
                        select {
                        case job, ok := <-p.jobs:
                            if !ok {
                                return
                            }
                            job.Execute(drainCtx)
                        case <-drainCtx.Done():
                            log.Printf("Worker %d: drain timeout, abandoning queue", id)
                            return
                        default:
                            return
                        }
                    }
                }
            }
        }(i)
    }

    // Block until context canceled
    <-ctx.Done()
    return nil
}

func (p *WorkerPool) Submit(job Job) bool {
    select {
    case p.jobs <- job:
        return true
    default:
        return false // Queue full
    }
}

func (p *WorkerPool) Drain(ctx context.Context) error {
    // Signal workers to stop taking new jobs
    close(p.jobs)

    // Wait for all workers to finish or context deadline
    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

## Kubernetes Integration

### Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myservice
  namespace: production
spec:
  template:
    spec:
      # Give pods sufficient time to drain
      terminationGracePeriodSeconds: 60
      containers:
      - name: myservice
        image: registry.example.com/myservice:v2.1.0

        lifecycle:
          preStop:
            # Sleep before SIGTERM to allow load balancer to drain
            # Kubernetes removes pod from endpoints ~2s before SIGTERM
            # This ensures no new requests arrive after shutdown starts
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]

        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
          successThreshold: 1

        livenessProbe:
          httpGet:
            path: /healthz/live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 3
```

### Health Check Endpoint Design

The readiness probe is the key mechanism for zero-downtime deployments. Mark the pod unready before shutdown completes:

```go
package health

import (
    "net/http"
    "sync/atomic"
)

type Handler struct {
    ready  atomic.Bool
    alive  atomic.Bool
    checks []Check
}

type Check func() error

func NewHandler(checks ...Check) *Handler {
    h := &Handler{checks: checks}
    h.ready.Store(true)
    h.alive.Store(true)
    return h
}

// SetNotReady marks the service as not ready for traffic.
// Call this early in the shutdown sequence.
func (h *Handler) SetNotReady() {
    h.ready.Store(false)
}

func (h *Handler) SetDead() {
    h.alive.Store(false)
}

func (h *Handler) ReadyHandler(w http.ResponseWriter, r *http.Request) {
    if !h.ready.Load() {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte(`{"status":"not_ready","reason":"shutting_down"}`))
        return
    }

    // Run dependency checks
    for _, check := range h.checks {
        if err := check(); err != nil {
            w.WriteHeader(http.StatusServiceUnavailable)
            w.Write([]byte(`{"status":"not_ready","reason":"` + err.Error() + `"}`))
            return
        }
    }

    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ready"}`))
}

func (h *Handler) LiveHandler(w http.ResponseWriter, r *http.Request) {
    if !h.alive.Load() {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"alive"}`))
}
```

Integrate health handler with shutdown:

```go
func main() {
    health := health.NewHandler(
        func() error { return db.Ping(context.Background()) },
        func() error { return cache.Ping(context.Background()) },
    )

    mux := http.NewServeMux()
    mux.HandleFunc("/healthz/ready", health.ReadyHandler)
    mux.HandleFunc("/healthz/live", health.LiveHandler)

    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    app := NewApp(mux)
    go app.Start()

    <-ctx.Done()

    // Immediately mark not ready - Kubernetes uses this to drain traffic
    health.SetNotReady()

    // Brief delay to ensure kube-proxy has updated iptables rules
    time.Sleep(2 * time.Second)

    // Now proceed with graceful shutdown
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()

    app.Shutdown(shutdownCtx)
}
```

## Kafka Consumer Shutdown

Kafka consumers require careful shutdown to avoid reprocessing:

```go
package consumer

import (
    "context"
    "log"

    "github.com/IBM/sarama"
)

type Consumer struct {
    client  sarama.ConsumerGroup
    handler ConsumerGroupHandler
    topics  []string
}

type ConsumerGroupHandler struct {
    ready   chan struct{}
    quit    chan struct{}
}

func (h *ConsumerGroupHandler) Setup(session sarama.ConsumerGroupSession) error {
    close(h.ready)
    return nil
}

func (h *ConsumerGroupHandler) Cleanup(session sarama.ConsumerGroupSession) error {
    return nil
}

func (h *ConsumerGroupHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                log.Println("Message channel closed")
                return nil
            }

            // Process message
            if err := processMessage(session.Context(), msg); err != nil {
                log.Printf("Processing error: %v", err)
                continue
            }

            // Only mark offset after successful processing
            session.MarkMessage(msg, "")

        case <-h.quit:
            log.Println("Consumer: quit signal received")
            return nil

        case <-session.Context().Done():
            log.Println("Consumer: session context done")
            return nil
        }
    }
}

func (c *Consumer) Run(ctx context.Context) error {
    for {
        if err := c.client.Consume(ctx, c.topics, &c.handler); err != nil {
            if ctx.Err() != nil {
                log.Println("Consumer: context canceled, stopping")
                return nil
            }
            return err
        }
        if ctx.Err() != nil {
            return nil
        }
        // Reset ready channel for reconnection
        c.handler.ready = make(chan struct{})
    }
}

func (c *Consumer) Shutdown(ctx context.Context) error {
    // Signal handler to stop processing new messages
    close(c.handler.quit)

    // Close consumer group - this commits offsets for marked messages
    done := make(chan error, 1)
    go func() {
        done <- c.client.Close()
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

## Testing Shutdown Behavior

Testing shutdown is critical and often skipped. A complete test validates the entire lifecycle:

```go
package main_test

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "syscall"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestGracefulShutdown_InFlightRequests(t *testing.T) {
    app, err := InitializeTestApp()
    require.NoError(t, err)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Start server
    go func() {
        app.Run(ctx)
    }()

    // Wait for server to be ready
    require.Eventually(t, func() bool {
        resp, err := http.Get("http://localhost:18080/healthz/ready")
        return err == nil && resp.StatusCode == 200
    }, 5*time.Second, 100*time.Millisecond)

    // Start a long-running request
    var requestCompleted bool
    var mu sync.Mutex

    go func() {
        resp, err := http.Get("http://localhost:18080/slow?duration=3s")
        mu.Lock()
        requestCompleted = (err == nil && resp.StatusCode == 200)
        mu.Unlock()
    }()

    // Wait for request to start
    time.Sleep(100 * time.Millisecond)

    // Trigger shutdown
    cancel()

    // Wait for shutdown to complete
    time.Sleep(10 * time.Second)

    // Verify in-flight request completed
    mu.Lock()
    assert.True(t, requestCompleted, "In-flight request should complete during shutdown")
    mu.Unlock()
}

func TestGracefulShutdown_ReadinessProbe(t *testing.T) {
    app, err := InitializeTestApp()
    require.NoError(t, err)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go func() { app.Run(ctx) }()

    require.Eventually(t, func() bool {
        resp, _ := http.Get("http://localhost:18080/healthz/ready")
        return resp != nil && resp.StatusCode == 200
    }, 5*time.Second, 100*time.Millisecond)

    // Trigger shutdown
    cancel()

    // Readiness should fail quickly (before shutdown completes)
    time.Sleep(200 * time.Millisecond)

    resp, err := http.Get("http://localhost:18080/healthz/ready")
    require.NoError(t, err)
    assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode,
        "Service should be not ready immediately after shutdown signal")
}

func TestGracefulShutdown_CompletesWithinDeadline(t *testing.T) {
    app, err := InitializeTestApp()
    require.NoError(t, err)

    ctx, cancel := context.WithCancel(context.Background())

    done := make(chan struct{})
    go func() {
        defer close(done)
        app.Run(ctx)
    }()

    time.Sleep(100 * time.Millisecond)

    start := time.Now()
    cancel()

    select {
    case <-done:
        elapsed := time.Since(start)
        assert.Less(t, elapsed, 30*time.Second,
            "Shutdown must complete within 30 seconds")
    case <-time.After(35 * time.Second):
        t.Fatal("Shutdown did not complete within 35 seconds")
    }
}
```

## Common Pitfalls

### Goroutine Leaks During Shutdown

```go
// BAD: goroutine not tied to shutdown context
go func() {
    for {
        doWork()
        time.Sleep(5 * time.Second)
    }
}()

// GOOD: goroutine respects context
go func() {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            doWork()
        case <-ctx.Done():
            return
        }
    }
}()
```

### Database Connections During Shutdown

```go
// BAD: using app context for database operations
// App context is canceled on shutdown, immediately killing DB queries
func (s *Service) GetUser(ctx context.Context, id int64) (*User, error) {
    return s.db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id).Scan(...)
}

// GOOD: use request context, not app context
// Request contexts are independent of shutdown signal
func handler(w http.ResponseWriter, r *http.Request) {
    // r.Context() is the right context - it represents this specific request
    user, err := svc.GetUser(r.Context(), id)
}
```

### Shutdown Context Not Propagated

```go
// BAD: creating new background context in shutdown path
func (s *Service) Shutdown() {
    ctx := context.Background() // Ignores shutdown deadline!
    s.db.ExecContext(ctx, "DELETE FROM sessions WHERE expires < NOW()")
}

// GOOD: accept shutdown context
func (s *Service) Shutdown(ctx context.Context) error {
    // ctx has the shutdown deadline, operations will be canceled if they exceed it
    _, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE expires < NOW()")
    return err
}
```

## Timing the Shutdown Sequence

The relationship between terminationGracePeriodSeconds and application behavior:

```
T+0s:   preStop hook runs (sleep 5)
T+5s:   SIGTERM delivered
T+5s:   Application: SetNotReady() called immediately
T+7s:   Application: 2s delay for kube-proxy iptables update
T+7s:   Application: Begin server.Shutdown()
T+22s:  Application: Active requests have 15s to complete
T+27s:  Application: Close DB/cache connections
T+30s:  Application: Should have exited by now
T+60s:  Kubernetes sends SIGKILL (terminationGracePeriodSeconds=60)
```

Setting `terminationGracePeriodSeconds` appropriately for your workload's maximum request duration is essential.

## Summary

Go's standard library provides everything needed for robust graceful shutdown. `signal.NotifyContext` cleanly integrates OS signals with context cancellation. `http.Server.Shutdown()` drains connections correctly. The critical discipline is propagating the shutdown context through every component, ensuring no goroutine runs unbounded, and validating shutdown behavior in tests. Kubernetes preStop hooks and health probe integration complete the picture, enabling zero-error rolling deployments in production.
