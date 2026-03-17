---
title: "Go Graceful Shutdown: Signal Handling, Connection Draining, and Health Check Coordination"
date: 2030-09-13T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Kubernetes", "Signal Handling", "gRPC", "Production", "Reliability"]
categories:
- Go
- Kubernetes
- Production Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production shutdown patterns in Go: os/signal handling, http.Server shutdown with context, gRPC graceful stop, database connection cleanup, Kubernetes preStop hook coordination, and testing shutdown behavior."
more_link: "yes"
url: "/go-graceful-shutdown-signal-handling-connection-draining-health-checks/"
---

Graceful shutdown is one of the most underengineered aspects of production Go services. When Kubernetes terminates a pod — whether for a rolling update, node drain, or resource pressure eviction — applications have a finite window to complete in-flight requests, drain active connections, and release resources cleanly. Getting this wrong causes dropped requests during deployments, connection pool exhaustion in downstream services, data corruption from abruptly terminated write operations, and cascading failures when health checks keep routing traffic to terminating pods. This guide covers the complete production shutdown pattern for Go services.

<!--more-->

## The Kubernetes Pod Termination Sequence

Understanding what Kubernetes does during pod termination is essential before implementing shutdown logic:

1. Pod transitions to `Terminating` state
2. Kubernetes sends `SIGTERM` to PID 1 in all containers simultaneously
3. Kubernetes removes the pod from all Service endpoints (this propagates asynchronously via kube-proxy and Envoy)
4. If `preStop` hook is defined, it executes before `SIGTERM` is sent
5. Application has `terminationGracePeriodSeconds` (default: 30s) to exit
6. After the grace period, Kubernetes sends `SIGKILL`

The critical issue: endpoint removal (#3) and SIGTERM delivery (#2) happen simultaneously but propagate at different speeds. kube-proxy updates iptables rules, Envoy proxies receive xDS updates, and DNS TTLs expire — all on different timescales. If the application stops accepting connections immediately upon receiving SIGTERM, some requests still in flight from clients that haven't yet received the updated routing rules will be dropped.

## Basic Signal Handling Structure

The foundation of any graceful shutdown implementation is correct signal handling using `os/signal` and `context`:

```go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Create a context that is cancelled when shutdown signals arrive
    ctx, cancel := signal.NotifyContext(
        context.Background(),
        syscall.SIGTERM,
        syscall.SIGINT,
        syscall.SIGHUP,
    )
    defer cancel()

    // Initialize application components
    app, err := NewApplication(logger)
    if err != nil {
        logger.Error("failed to initialize application", "error", err)
        os.Exit(1)
    }

    // Run the application
    if err := app.Run(ctx); err != nil {
        logger.Error("application error", "error", err)
        os.Exit(1)
    }

    logger.Info("application shut down cleanly")
}
```

`signal.NotifyContext` is preferred over the older `signal.Notify` channel-based approach because it integrates naturally with the context propagation model used throughout Go's standard library.

## HTTP Server Graceful Shutdown

The `http.Server.Shutdown` method is the standard mechanism for draining HTTP connections. It stops accepting new connections, waits for all in-flight requests to complete, and then returns.

```go
package server

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "time"
)

type HTTPServer struct {
    server   *http.Server
    logger   *slog.Logger
    readyCtx context.Context
    readyCxl context.CancelFunc
}

func NewHTTPServer(addr string, handler http.Handler, logger *slog.Logger) *HTTPServer {
    readyCtx, readyCxl := context.WithCancel(context.Background())

    srv := &HTTPServer{
        server: &http.Server{
            Addr:    addr,
            Handler: handler,
            // Timeouts prevent connection exhaustion during normal operation
            ReadHeaderTimeout: 10 * time.Second,
            ReadTimeout:       30 * time.Second,
            WriteTimeout:      60 * time.Second,
            IdleTimeout:       120 * time.Second,
        },
        logger:   logger,
        readyCtx: readyCtx,
        readyCxl: readyCxl,
    }

    return srv
}

// Run starts the HTTP server and blocks until the context is cancelled,
// then performs graceful shutdown.
func (s *HTTPServer) Run(ctx context.Context) error {
    // Start listening before signalling readiness
    ln, err := net.Listen("tcp", s.server.Addr)
    if err != nil {
        return fmt.Errorf("listen %s: %w", s.server.Addr, err)
    }

    // Mark server as ready once listening
    s.readyCxl()

    serveErr := make(chan error, 1)
    go func() {
        s.logger.Info("HTTP server starting", "addr", s.server.Addr)
        if err := s.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
            serveErr <- fmt.Errorf("http serve: %w", err)
        }
        close(serveErr)
    }()

    select {
    case err := <-serveErr:
        return err
    case <-ctx.Done():
        s.logger.Info("shutdown signal received, draining HTTP connections")
    }

    // Give in-flight requests up to 25 seconds to complete.
    // Use 25s (less than the default 30s termination grace period)
    // to ensure cleanup completes before SIGKILL.
    shutdownCtx, cancel := context.WithTimeout(
        context.Background(),
        25*time.Second,
    )
    defer cancel()

    if err := s.server.Shutdown(shutdownCtx); err != nil {
        s.logger.Error("HTTP server shutdown error", "error", err)
        return fmt.Errorf("http shutdown: %w", err)
    }

    s.logger.Info("HTTP server drained cleanly")
    return nil
}

// Ready returns a channel that is closed when the server is ready to accept connections.
func (s *HTTPServer) Ready() <-chan struct{} {
    return s.readyCtx.Done()
}
```

### Health Check Endpoints During Shutdown

Health check endpoints must behave correctly during shutdown to prevent Kubernetes from routing new traffic to a terminating pod. The readiness probe should return non-200 immediately when shutdown begins; the liveness probe should continue returning 200 until actual shutdown:

```go
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "sync/atomic"
)

type HealthHandler struct {
    ready  atomic.Bool
    live   atomic.Bool
    checks []Check
}

type Check interface {
    Name() string
    Check(ctx context.Context) error
}

type StatusResponse struct {
    Status string            `json:"status"`
    Checks map[string]string `json:"checks,omitempty"`
}

func NewHealthHandler(checks ...Check) *HealthHandler {
    h := &HealthHandler{checks: checks}
    h.ready.Store(true)
    h.live.Store(true)
    return h
}

// MarkNotReady signals that the service is shutting down and should not receive new traffic.
// Call this as the first action when SIGTERM is received.
func (h *HealthHandler) MarkNotReady() {
    h.ready.Store(false)
}

// MarkDead signals that the service should be restarted.
// Only call this for truly unrecoverable states.
func (h *HealthHandler) MarkDead() {
    h.live.Store(false)
}

func (h *HealthHandler) Readiness(w http.ResponseWriter, r *http.Request) {
    if !h.ready.Load() {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(StatusResponse{Status: "shutting_down"})
        return
    }

    ctx := r.Context()
    checkResults := make(map[string]string, len(h.checks))
    allOK := true

    for _, check := range h.checks {
        if err := check.Check(ctx); err != nil {
            checkResults[check.Name()] = err.Error()
            allOK = false
        } else {
            checkResults[check.Name()] = "ok"
        }
    }

    if !allOK {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(StatusResponse{Status: "degraded", Checks: checkResults})
        return
    }

    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(StatusResponse{Status: "ok", Checks: checkResults})
}

func (h *HealthHandler) Liveness(w http.ResponseWriter, r *http.Request) {
    if !h.live.Load() {
        w.WriteHeader(http.StatusInternalServerError)
        json.NewEncoder(w).Encode(StatusResponse{Status: "dead"})
        return
    }
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(StatusResponse{Status: "ok"})
}
```

## gRPC Graceful Shutdown

gRPC servers have their own shutdown mechanism that must be used instead of — or in addition to — HTTP server shutdown when the service exposes gRPC endpoints.

```go
package grpcserver

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"
)

type GRPCServer struct {
    server       *grpc.Server
    healthServer *health.Server
    logger       *slog.Logger
    addr         string
}

func NewGRPCServer(addr string, logger *slog.Logger, opts ...grpc.ServerOption) *GRPCServer {
    defaultOpts := []grpc.ServerOption{
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     5 * time.Minute,
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 30 * time.Second,
            Time:                  10 * time.Second,
            Timeout:               5 * time.Second,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             5 * time.Second,
            PermitWithoutStream: true,
        }),
    }

    srv := grpc.NewServer(append(defaultOpts, opts...)...)

    // Register gRPC health protocol
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(srv, healthSrv)
    reflection.Register(srv)

    return &GRPCServer{
        server:       srv,
        healthServer: healthSrv,
        logger:       logger,
        addr:         addr,
    }
}

// Server returns the underlying grpc.Server for registering service implementations.
func (s *GRPCServer) Server() *grpc.Server {
    return s.server
}

// SetServiceHealth updates the gRPC health status for a specific service.
func (s *GRPCServer) SetServiceHealth(service string, status grpc_health_v1.HealthCheckResponse_ServingStatus) {
    s.healthServer.SetServingStatus(service, status)
}

func (s *GRPCServer) Run(ctx context.Context) error {
    ln, err := net.Listen("tcp", s.addr)
    if err != nil {
        return fmt.Errorf("grpc listen %s: %w", s.addr, err)
    }

    // Mark all services as serving
    s.healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

    serveErr := make(chan error, 1)
    go func() {
        s.logger.Info("gRPC server starting", "addr", s.addr)
        if err := s.server.Serve(ln); err != nil {
            serveErr <- fmt.Errorf("grpc serve: %w", err)
        }
        close(serveErr)
    }()

    select {
    case err := <-serveErr:
        return err
    case <-ctx.Done():
        s.logger.Info("shutdown signal received, draining gRPC connections")
    }

    // Mark services as not serving to stop new traffic via gRPC health checks
    s.healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

    // GracefulStop waits for all RPCs to complete then stops the server.
    // Use a goroutine so we can enforce a timeout.
    stopped := make(chan struct{})
    go func() {
        s.server.GracefulStop()
        close(stopped)
    }()

    select {
    case <-stopped:
        s.logger.Info("gRPC server drained cleanly")
    case <-time.After(20 * time.Second):
        s.logger.Warn("gRPC drain timeout exceeded, forcing stop")
        s.server.Stop() // Force stop after timeout
    }

    return nil
}
```

## Database Connection Pool Cleanup

Database connections must be explicitly closed during shutdown to avoid connection leaks and potential data corruption from uncommitted transactions.

```go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"

    _ "github.com/jackc/pgx/v5/stdlib"
)

type DB struct {
    db     *sql.DB
    logger *slog.Logger
}

func NewDB(dsn string, logger *slog.Logger) (*DB, error) {
    db, err := sql.Open("pgx", dsn)
    if err != nil {
        return nil, fmt.Errorf("open database: %w", err)
    }

    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(10)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(2 * time.Minute)

    // Verify connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        return nil, fmt.Errorf("ping database: %w", err)
    }

    return &DB{db: db, logger: logger}, nil
}

// Close drains active queries and closes all connections.
// Should be called during application shutdown.
func (d *DB) Close(ctx context.Context) error {
    d.logger.Info("closing database connection pool")

    // db.Close() waits for all pending queries to complete
    // and then closes all connections.
    // The provided context limits how long we wait.
    done := make(chan error, 1)
    go func() {
        done <- d.db.Close()
    }()

    select {
    case err := <-done:
        if err != nil {
            return fmt.Errorf("close database pool: %w", err)
        }
        d.logger.Info("database connection pool closed cleanly")
        return nil
    case <-ctx.Done():
        d.logger.Warn("database close timed out", "error", ctx.Err())
        return ctx.Err()
    }
}
```

## Coordinating Multiple Shutdown Components with errgroup

Production applications have multiple components that must all shut down cleanly and in the correct order. The `errgroup` package provides structured coordination:

```go
package app

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "golang.org/x/sync/errgroup"
)

type Application struct {
    httpServer  *HTTPServer
    grpcServer  *GRPCServer
    db          *DB
    healthCheck *HealthHandler
    logger      *slog.Logger
    workers     []Worker
}

type Worker interface {
    Name() string
    Run(ctx context.Context) error
}

func (a *Application) Run(ctx context.Context) error {
    // Phase 1: Mark not ready immediately on shutdown signal.
    // This prevents new requests from being routed to this pod
    // while we wait for existing connections to drain.
    shutdownCtx, startShutdown := context.WithCancel(ctx)

    // Wrap the parent context so we can detect shutdown and react immediately
    go func() {
        <-ctx.Done()
        a.logger.Info("shutdown initiated, marking service not ready")
        a.healthCheck.MarkNotReady()

        // Wait for load balancer propagation before actually shutting down.
        // This is the "sleep" that compensates for async endpoint removal.
        // In Kubernetes with a preStop hook, this can be handled there instead.
        time.Sleep(5 * time.Second)

        startShutdown()
    }()

    g, gCtx := errgroup.WithContext(shutdownCtx)

    // Start HTTP server
    g.Go(func() error {
        if err := a.httpServer.Run(gCtx); err != nil {
            return fmt.Errorf("http server: %w", err)
        }
        return nil
    })

    // Start gRPC server
    g.Go(func() error {
        if err := a.grpcServer.Run(gCtx); err != nil {
            return fmt.Errorf("grpc server: %w", err)
        }
        return nil
    })

    // Start background workers
    for _, w := range a.workers {
        worker := w // capture range variable
        g.Go(func() error {
            a.logger.Info("starting worker", "name", worker.Name())
            if err := worker.Run(gCtx); err != nil {
                return fmt.Errorf("worker %s: %w", worker.Name(), err)
            }
            a.logger.Info("worker stopped cleanly", "name", worker.Name())
            return nil
        })
    }

    // Wait for all components to shut down
    if err := g.Wait(); err != nil {
        return err
    }

    // Phase 3: Close database connections after all servers have stopped.
    // This ensures no in-flight requests are still using the connection pool.
    dbCloseCtx, dbCancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer dbCancel()

    if err := a.db.Close(dbCloseCtx); err != nil {
        a.logger.Error("database close error", "error", err)
        return fmt.Errorf("database close: %w", err)
    }

    return nil
}
```

## Kubernetes preStop Hook Configuration

The preStop hook executes before SIGTERM is sent to the container's main process. Using a sleep in the preStop hook provides a reliable delay for load balancer endpoint propagation:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
    spec:
      # Must be greater than preStop sleep + application drain timeout
      terminationGracePeriodSeconds: 60
      containers:
        - name: payment-api
          image: payment-api:1.0.0
          lifecycle:
            preStop:
              exec:
                # Sleep for 5 seconds to allow load balancer rules to propagate
                # before SIGTERM is sent to the process.
                # This prevents new requests from arriving after shutdown starts.
                command: ["/bin/sh", "-c", "sleep 5"]
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 2
            successThreshold: 1
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 10
            failureThreshold: 3
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: grpc
```

The timing calculation for `terminationGracePeriodSeconds`:

```
terminationGracePeriodSeconds ≥ preStop_sleep + application_drain_timeout + buffer
= 5s (preStop sleep)
+ 25s (HTTP drain timeout)
+ 20s (gRPC drain timeout, runs in parallel with HTTP)
+ 10s (database close timeout)
+ 5s (buffer)
= 65s → round up to 75s
```

In practice, HTTP and gRPC shutdown run in parallel via errgroup, so the actual wall-clock drain time is max(25s, 20s) = 25s, making the total roughly 5s + 25s + 10s + 5s = 45s. Setting `terminationGracePeriodSeconds: 60` provides comfortable headroom.

## Context Propagation Through Request Handlers

Every request handler must respect context cancellation to ensure in-flight requests complete promptly and do not extend the shutdown window unnecessarily:

```go
package handlers

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"
    "time"
)

type PaymentHandler struct {
    db     *sql.DB
    logger *slog.Logger
}

func (h *PaymentHandler) CreatePayment(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Add per-request timeout as a child of the request context.
    // This ensures the request respects both the client timeout and shutdown.
    ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
    defer cancel()

    var req CreatePaymentRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    // Database operations use the request context — if the server shuts down
    // mid-request, the context is cancelled and the query is aborted.
    result, err := h.processPayment(ctx, &req)
    if err != nil {
        if errors.Is(err, context.Canceled) {
            // Request was cancelled because the server is shutting down.
            // Return 503 so the client can retry elsewhere.
            http.Error(w, "service unavailable", http.StatusServiceUnavailable)
            return
        }
        if errors.Is(err, context.DeadlineExceeded) {
            http.Error(w, "request timeout", http.StatusGatewayTimeout)
            return
        }
        h.logger.Error("payment processing error", "error", err, "request_id", requestID(ctx))
        http.Error(w, "internal server error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(result)
}

func (h *PaymentHandler) processPayment(ctx context.Context, req *CreatePaymentRequest) (*PaymentResult, error) {
    tx, err := h.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted,
    })
    if err != nil {
        return nil, fmt.Errorf("begin transaction: %w", err)
    }
    defer func() {
        // Rollback is a no-op if the transaction was committed
        if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
            h.logger.Error("transaction rollback error", "error", err)
        }
    }()

    // All database operations propagate the context for cancellation
    var paymentID int64
    err = tx.QueryRowContext(ctx,
        "INSERT INTO payments (amount, currency, status) VALUES ($1, $2, 'pending') RETURNING id",
        req.Amount, req.Currency,
    ).Scan(&paymentID)
    if err != nil {
        return nil, fmt.Errorf("insert payment: %w", err)
    }

    if err := tx.Commit(); err != nil {
        return nil, fmt.Errorf("commit payment: %w", err)
    }

    return &PaymentResult{ID: paymentID, Status: "pending"}, nil
}
```

## Testing Shutdown Behavior

Testing graceful shutdown is frequently omitted but critical for validating the implementation:

```go
package app_test

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "sync"
    "testing"
    "time"
)

func TestGracefulShutdown_CompletesInflightRequests(t *testing.T) {
    app := newTestApplication(t)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Start application in background
    errCh := make(chan error, 1)
    go func() {
        errCh <- app.Run(ctx)
    }()

    // Wait for server to be ready
    waitForReady(t, "http://localhost:18080/readyz", 5*time.Second)

    var wg sync.WaitGroup
    requestErrors := make(chan error, 10)

    // Launch 5 slow requests (each takes 3 seconds)
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            resp, err := http.Get(fmt.Sprintf("http://localhost:18080/slow?duration=3s&id=%d", n))
            if err != nil {
                requestErrors <- fmt.Errorf("request %d: %w", n, err)
                return
            }
            defer resp.Body.Close()
            io.ReadAll(resp.Body)
            if resp.StatusCode != http.StatusOK {
                requestErrors <- fmt.Errorf("request %d: unexpected status %d", n, resp.StatusCode)
            }
        }(i)
    }

    // Allow requests to start
    time.Sleep(500 * time.Millisecond)

    // Trigger shutdown
    shutdownStart := time.Now()
    cancel()

    // Wait for all requests to complete
    wg.Wait()
    shutdownDuration := time.Since(shutdownStart)

    // Verify no request errors
    close(requestErrors)
    for err := range requestErrors {
        t.Errorf("request error during shutdown: %v", err)
    }

    // Verify shutdown completed within grace period
    if shutdownDuration > 30*time.Second {
        t.Errorf("shutdown took too long: %v", shutdownDuration)
    }

    // Verify application exited cleanly
    select {
    case err := <-errCh:
        if err != nil {
            t.Errorf("application shutdown error: %v", err)
        }
    case <-time.After(35 * time.Second):
        t.Error("application did not exit after shutdown signal")
    }
}

func TestGracefulShutdown_ReadinessProbeFailsDuringShutdown(t *testing.T) {
    app := newTestApplication(t)
    ctx, cancel := context.WithCancel(context.Background())

    go app.Run(ctx)
    waitForReady(t, "http://localhost:18080/readyz", 5*time.Second)

    // Verify readiness probe is healthy before shutdown
    resp, err := http.Get("http://localhost:18080/readyz")
    if err != nil {
        t.Fatalf("readiness probe error: %v", err)
    }
    if resp.StatusCode != http.StatusOK {
        t.Errorf("expected 200, got %d before shutdown", resp.StatusCode)
    }

    // Trigger shutdown
    cancel()

    // Give the app time to process the cancellation
    time.Sleep(100 * time.Millisecond)

    // Readiness probe should now return non-200
    resp, err = http.Get("http://localhost:18080/readyz")
    if err != nil {
        // Connection refused is also acceptable — server is shutting down
        return
    }
    if resp.StatusCode == http.StatusOK {
        t.Error("readiness probe returned 200 during shutdown — should be 503")
    }
}

func waitForReady(t *testing.T, url string, timeout time.Duration) {
    t.Helper()
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        resp, err := http.Get(url)
        if err == nil && resp.StatusCode == http.StatusOK {
            return
        }
        time.Sleep(100 * time.Millisecond)
    }
    t.Fatalf("server did not become ready within %v", timeout)
}
```

## Background Worker Shutdown Patterns

Background workers (message consumers, cache refreshers, metrics aggregators) require careful shutdown coordination to avoid data loss:

```go
package workers

import (
    "context"
    "fmt"
    "log/slog"
    "time"
)

// KafkaConsumer demonstrates a message consumer that processes messages
// until context cancellation and commits offsets before exiting.
type KafkaConsumer struct {
    topic    string
    logger   *slog.Logger
    // consumer kafka.Consumer — omitted for brevity
}

func (k *KafkaConsumer) Name() string {
    return fmt.Sprintf("kafka-consumer(%s)", k.topic)
}

func (k *KafkaConsumer) Run(ctx context.Context) error {
    k.logger.Info("kafka consumer starting", "topic", k.topic)
    defer k.logger.Info("kafka consumer stopped", "topic", k.topic)

    for {
        // Check context before blocking on message fetch
        select {
        case <-ctx.Done():
            k.logger.Info("kafka consumer draining", "topic", k.topic)
            // Commit any pending offsets before exiting
            if err := k.commitPendingOffsets(context.Background()); err != nil {
                k.logger.Error("failed to commit offsets during shutdown", "error", err)
            }
            return nil
        default:
        }

        // Fetch with a short timeout so context cancellation is checked frequently
        fetchCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
        msg, err := k.fetchMessage(fetchCtx)
        cancel()

        if err != nil {
            if ctx.Err() != nil {
                // Context cancelled — clean shutdown
                return nil
            }
            if isTimeoutError(err) {
                // No message available — loop and check context again
                continue
            }
            return fmt.Errorf("kafka fetch: %w", err)
        }

        // Process with the parent context so processing respects shutdown
        if err := k.processMessage(ctx, msg); err != nil {
            if ctx.Err() != nil {
                // Shutdown interrupted processing — this message will be reprocessed
                // since the offset was not committed
                k.logger.Warn("message processing interrupted by shutdown",
                    "topic", k.topic, "offset", msg.Offset)
                return nil
            }
            k.logger.Error("message processing error", "error", err, "offset", msg.Offset)
            // Continue processing — dead letter queue handling would go here
        }
    }
}

func (k *KafkaConsumer) fetchMessage(ctx context.Context) (Message, error) {
    // Stub — actual implementation uses kafka client
    panic("not implemented")
}

func (k *KafkaConsumer) processMessage(ctx context.Context, msg Message) error {
    panic("not implemented")
}

func (k *KafkaConsumer) commitPendingOffsets(ctx context.Context) error {
    panic("not implemented")
}

func isTimeoutError(err error) bool {
    return false // stub
}

type Message struct {
    Offset int64
    Value  []byte
}
```

## Summary

Production-quality graceful shutdown in Go requires coordinating several distinct concerns:

1. Use `signal.NotifyContext` to translate OS signals into context cancellation
2. Mark readiness probes as failing immediately upon receiving SIGTERM to stop new traffic
3. Add a brief sleep (5 seconds via preStop hook or application-level) to allow load balancer propagation before accepting no new connections
4. Use `http.Server.Shutdown` with a context timeout for HTTP draining
5. Use `grpc.Server.GracefulStop` with a goroutine-based timeout for gRPC draining
6. Use `errgroup` to coordinate parallel component shutdown
7. Close database connections only after all HTTP/gRPC servers have stopped
8. Set `terminationGracePeriodSeconds` to accommodate the full shutdown sequence with headroom
9. Propagate request context throughout all database and downstream operations to ensure they respect shutdown cancellation
10. Write integration tests that verify in-flight requests complete during shutdown and that readiness probes behave correctly
