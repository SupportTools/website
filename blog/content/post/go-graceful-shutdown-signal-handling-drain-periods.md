---
title: "Go Graceful Shutdown: Signal Handling, Drain Periods, and Cleanup"
date: 2029-10-23T00:00:00-05:00
draft: false
tags: ["Go", "Kubernetes", "Graceful Shutdown", "Signal Handling", "Production", "Reliability"]
categories: ["Go", "Kubernetes", "Production Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing graceful shutdown in Go services: os.Signal handling, http.Server.Shutdown, graceful gRPC shutdown, drain period calculation, and alignment with Kubernetes terminationGracePeriodSeconds."
more_link: "yes"
url: "/go-graceful-shutdown-signal-handling-drain-periods/"
---

When Kubernetes sends SIGTERM to your pod, you have a window to finish in-flight requests, close database connections, flush buffers, and clean up resources before the process is forcibly killed with SIGKILL. If your service does not handle SIGTERM, Kubernetes kills it immediately, dropping in-flight requests. Getting graceful shutdown right is one of the most impactful reliability improvements you can make to a Go service running in Kubernetes.

<!--more-->

# Go Graceful Shutdown: Signal Handling, Drain Periods, and Cleanup

## Section 1: The Kubernetes Shutdown Sequence

Understanding what Kubernetes does when it terminates a pod prevents the most common shutdown mistakes.

```
kubectl delete pod frontend-xxx
         │
         ▼
1. Pod status → Terminating
   - Pod removed from Service endpoints
   - iptables/IPVS rules updated (async — takes 1-5 seconds)

2. SIGTERM sent to PID 1 in each container

3. terminationGracePeriodSeconds countdown begins (default: 30s)

4. After countdown OR after process exits:
   SIGKILL sent to any remaining processes
```

The critical detail is the race between step 1 and step 2. New connections may still arrive at your pod for 1-5 seconds after SIGTERM because kube-proxy is updating routing rules asynchronously. If your process stops listening immediately on SIGTERM, those connections get connection-refused errors.

The solution is a **pre-stop drain delay**: wait N seconds after receiving SIGTERM before stopping the listener, to allow the routing rules to propagate.

## Section 2: Signal Handling in Go

### Basic Signal Setup

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
    // Create a buffered channel. Buffer size 1 ensures we don't miss
    // the signal if it arrives before we call signal.Notify.
    stop := make(chan os.Signal, 1)

    // Notify on SIGTERM (Kubernetes) and SIGINT (Ctrl+C for local dev)
    signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

    // Start your server (non-blocking)
    server := startServer()

    // Block until we receive a shutdown signal
    sig := <-stop
    log.Printf("received signal: %v, beginning shutdown", sig)

    // Graceful shutdown with timeout
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Printf("server shutdown error: %v", err)
    }
    log.Println("server stopped")
}
```

### Context-Based Shutdown Signal (Go 1.16+)

Go 1.16 introduced `signal.NotifyContext`, which ties a context's cancellation to OS signals:

```go
func main() {
    // This context is cancelled when SIGTERM or SIGINT is received.
    // It also handles deregistering the signal handler on cleanup.
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()

    server := startServer()

    // Block until signal
    <-ctx.Done()
    log.Printf("shutdown signal received: %v", context.Cause(ctx))

    // Create a fresh context for the shutdown process (the signal context is already cancelled)
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Fatalf("server shutdown failed: %v", err)
    }
}
```

## Section 3: HTTP Server Graceful Shutdown

### http.Server.Shutdown Behavior

`http.Server.Shutdown` does the following:
1. Closes the listener (new connections are rejected).
2. Waits for all active connections to become idle (request complete, response sent).
3. Closes idle connections.
4. Returns when all connections are closed or the context times out.

```go
package server

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

type Server struct {
    http          *http.Server
    drainDuration time.Duration
}

func New(addr string, handler http.Handler, drainDuration time.Duration) *Server {
    return &Server{
        http: &http.Server{
            Addr:              addr,
            Handler:           handler,
            ReadTimeout:       15 * time.Second,
            WriteTimeout:      15 * time.Second,
            IdleTimeout:       60 * time.Second,
            ReadHeaderTimeout: 5 * time.Second,
        },
        drainDuration: drainDuration,
    }
}

func (s *Server) Run() error {
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()

    // Start server in background goroutine
    serverErr := make(chan error, 1)
    go func() {
        log.Printf("HTTP server listening on %s", s.http.Addr)
        if err := s.http.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            serverErr <- err
        }
    }()

    // Wait for signal or server error
    select {
    case err := <-serverErr:
        return err
    case <-ctx.Done():
        log.Printf("shutdown signal received, waiting %v for connections to drain", s.drainDuration)
    }

    // Pre-stop drain: keep accepting connections while routing rules update
    // This is the window between SIGTERM and actual shutdown
    time.Sleep(s.drainDuration)

    // Stop accepting new connections and wait for active requests to complete
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()

    log.Println("stopping HTTP server")
    if err := s.http.Shutdown(shutdownCtx); err != nil {
        log.Printf("HTTP shutdown error: %v", err)
        return err
    }
    log.Println("HTTP server stopped gracefully")
    return nil
}
```

### Using preStop Hooks as an Alternative Drain

Instead of a sleep in the application, Kubernetes supports a `preStop` lifecycle hook that runs before SIGTERM is sent. This keeps the drain logic in Kubernetes configuration rather than application code.

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]
```

With this configuration, the pod lifecycle is:
1. Pod removed from endpoints
2. `preStop` hook runs (5-second sleep)
3. SIGTERM sent to the process
4. terminationGracePeriodSeconds countdown (started at step 2)

This means your application does not need the drain sleep — by the time SIGTERM arrives, routing rules have had 5 seconds to propagate. This approach separates infrastructure concerns from application code.

## Section 4: Multi-Component Shutdown Coordination

Real services have multiple components to shut down in the right order.

### Component Shutdown Order

```
Good order for HTTP service with database:
1. Stop accepting new HTTP requests (close listener)
2. Wait for in-flight HTTP requests to complete
3. Close database connection pool
4. Flush telemetry/logs
5. Exit

Wrong order:
1. Close database connections  ← breaks in-flight requests that need DB
2. Stop HTTP server
```

### Implementing Ordered Shutdown

```go
package main

import (
    "context"
    "database/sql"
    "log"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

type Application struct {
    httpServer *http.Server
    db         *sql.DB
    wg         sync.WaitGroup
}

func (a *Application) Start() {
    go func() {
        a.wg.Add(1)
        defer a.wg.Done()
        if err := a.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Printf("HTTP server error: %v", err)
        }
    }()
}

func (a *Application) Shutdown(ctx context.Context) error {
    // Phase 1: Stop accepting new requests (5-second timeout for graceful HTTP drain)
    httpCtx, httpCancel := context.WithTimeout(ctx, 25*time.Second)
    defer httpCancel()

    log.Println("phase 1: stopping HTTP server")
    if err := a.httpServer.Shutdown(httpCtx); err != nil {
        log.Printf("HTTP server shutdown error: %v", err)
        // Don't return — continue with cleanup
    }

    // Phase 2: Wait for all goroutines to finish
    // Use a channel to allow timeout on WaitGroup
    done := make(chan struct{})
    go func() {
        a.wg.Wait()
        close(done)
    }()
    select {
    case <-done:
        log.Println("all goroutines stopped")
    case <-ctx.Done():
        log.Println("timeout waiting for goroutines")
    }

    // Phase 3: Close database connections
    log.Println("phase 3: closing database connections")
    if err := a.db.Close(); err != nil {
        log.Printf("database close error: %v", err)
    }

    return nil
}

func main() {
    app := buildApplication()
    app.Start()

    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()
    <-ctx.Done()

    log.Println("beginning graceful shutdown")
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := app.Shutdown(shutdownCtx); err != nil {
        log.Printf("shutdown error: %v", err)
        os.Exit(1)
    }
    log.Println("shutdown complete")
}
```

## Section 5: Graceful gRPC Shutdown

gRPC shutdown has different semantics from HTTP because gRPC uses long-lived connections with streaming RPCs.

### grpc.Server GracefulStop

```go
package grpcserver

import (
    "context"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"
)

func RunGRPCServer(handler interface{}) error {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        return err
    }

    srv := grpc.NewServer(
        grpc.MaxRecvMsgSize(16*1024*1024),  // 16MB
        grpc.MaxSendMsgSize(16*1024*1024),
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Second,
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 5 * time.Second,
            Time:                  5 * time.Second,
            Timeout:               1 * time.Second,
        }),
    )

    // Register health check service (required for Kubernetes probes)
    healthServer := health.NewServer()
    grpc_health_v1.RegisterHealthServer(srv, healthServer)
    healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

    reflection.Register(srv)
    // Register your service here: pb.RegisterMyServiceServer(srv, handler)

    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()

    go func() {
        log.Printf("gRPC server listening on :50051")
        if err := srv.Serve(lis); err != nil {
            log.Printf("gRPC serve error: %v", err)
        }
    }()

    <-ctx.Done()
    log.Println("gRPC shutdown signal received")

    // Mark health check as NOT_SERVING so load balancers stop routing new requests
    healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

    // Drain delay for routing propagation (same as HTTP)
    time.Sleep(5 * time.Second)

    // GracefulStop: stops accepting new RPCs and waits for in-flight RPCs to complete
    // This blocks until all streaming RPCs finish or until Force() is called
    stopped := make(chan struct{})
    go func() {
        srv.GracefulStop()
        close(stopped)
    }()

    select {
    case <-stopped:
        log.Println("gRPC server stopped gracefully")
    case <-time.After(20 * time.Second):
        log.Println("gRPC graceful stop timeout, forcing stop")
        srv.Stop()  // Force-closes all connections
    }

    return nil
}
```

### MaxConnectionAge and Connection Draining

For gRPC services in Kubernetes, set `MaxConnectionAge` to force periodic connection recycling. Without this, a long-lived gRPC connection from a load balancer may pin all traffic to a single pod indefinitely.

```go
grpc.KeepaliveParams(keepalive.ServerParameters{
    // Connections older than 30 minutes are gracefully terminated
    // allowing load balancers to redistribute
    MaxConnectionAge: 30 * time.Minute,
    // Give clients 5 seconds to finish their RPCs on a closing connection
    MaxConnectionAgeGrace: 5 * time.Second,
})
```

## Section 6: Drain Period Calculation

How long should you drain? The answer depends on your routing infrastructure:

### For kube-proxy (iptables/IPVS)

kube-proxy watches endpoint changes and updates iptables rules. The delay between endpoint removal and rule update is:
- iptables mode: 100ms-1s per node (scales with node count)
- IPVS mode: ~50ms per node (more scalable)

For a 100-node cluster: plan for up to 5 seconds drain time.

### For Ingress Controllers (NGINX, Traefik)

Ingress controllers have their own endpoint cache. Many reload their configuration within 1-2 seconds of endpoint changes. Add an extra buffer.

### For Service Meshes (Istio, Linkerd)

Istio's Envoy proxies receive endpoint updates via xDS. The latency between endpoint removal and Envoy update is typically 50-500ms but can be higher under load.

### Recommended Drain Periods

```go
const (
    // Minimum: for small clusters or fast mesh environments
    DrainPeriodMinimum = 5 * time.Second

    // Standard: for medium clusters (50-200 nodes) with kube-proxy
    DrainPeriodStandard = 10 * time.Second

    // Conservative: for large clusters or environments with slow routing propagation
    DrainPeriodConservative = 15 * time.Second
)

// In practice, use an environment variable to allow tuning per environment
func getDrainPeriod() time.Duration {
    if s := os.Getenv("DRAIN_PERIOD_SECONDS"); s != "" {
        secs, err := strconv.Atoi(s)
        if err == nil && secs > 0 {
            return time.Duration(secs) * time.Second
        }
    }
    return DrainPeriodStandard
}
```

## Section 7: Kubernetes terminationGracePeriodSeconds Alignment

Your application's shutdown sequence must complete within `terminationGracePeriodSeconds`. Kubernetes defaults to 30 seconds, but this is often insufficient for services with long-running requests.

### Calculating the Required terminationGracePeriodSeconds

```
terminationGracePeriodSeconds >=
    preStop hook duration (if any) +
    drain delay +
    maximum expected request duration +
    shutdown cleanup time +
    safety margin (5-10 seconds)

Example:
- preStop sleep: 5s
- drain delay: 0s (handled by preStop)
- max request duration: 10s
- DB connection close + flush: 2s
- safety margin: 8s
= terminationGracePeriodSeconds: 25s → round up to 30s
```

### Configuring terminationGracePeriodSeconds

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60  # For a service with up to 30s requests
      containers:
        - name: api
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
          # The app has 60 - 5 (preStop) = 55 seconds after SIGTERM
          # to complete shutdown
```

### Mismatched Timeouts Are a Common Bug

```
Common mistake:
  terminationGracePeriodSeconds: 30  ← Kubernetes will SIGKILL after 30s
  app.Shutdown timeout: 45s          ← App plans for 45s but gets killed at 30s
```

```go
// Correct: application shutdown timeout < terminationGracePeriodSeconds
// Assuming terminationGracePeriodSeconds=60 and preStop=5s:
// Available for app shutdown: 60 - 5 = 55s
// Set app timeout to 50s (5s safety margin)
shutdownCtx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
```

## Section 8: Shutdown with Background Workers

Services often have background goroutines (queue consumers, cache refreshers, cron-like jobs) that must also be cleanly stopped.

```go
package main

import (
    "context"
    "log"
    "time"
)

type Worker struct {
    cancel context.CancelFunc
    done   chan struct{}
}

func StartWorker(ctx context.Context, interval time.Duration, fn func(ctx context.Context)) *Worker {
    workerCtx, cancel := context.WithCancel(ctx)
    done := make(chan struct{})

    go func() {
        defer close(done)
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                fn(workerCtx)
            case <-workerCtx.Done():
                log.Println("worker stopping")
                return
            }
        }
    }()

    return &Worker{cancel: cancel, done: done}
}

func (w *Worker) Stop(ctx context.Context) error {
    w.cancel()
    select {
    case <-w.done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// In your shutdown sequence:
func (a *Application) Shutdown(ctx context.Context) error {
    // Stop background workers first (they may use DB)
    for _, worker := range a.workers {
        if err := worker.Stop(ctx); err != nil {
            log.Printf("worker stop error: %v", err)
        }
    }

    // Then stop HTTP (which uses DB)
    a.httpServer.Shutdown(ctx)

    // Then close DB
    a.db.Close()

    return nil
}
```

## Section 9: Testing Graceful Shutdown

```go
package server_test

import (
    "context"
    "net/http"
    "sync"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestGracefulShutdown_InFlightRequestCompletes(t *testing.T) {
    // Server with a slow handler (simulates a long request)
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        time.Sleep(500 * time.Millisecond)  // Simulate work
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("done"))
    })

    srv := &http.Server{
        Addr:    "127.0.0.1:0",
        Handler: handler,
    }

    ln, err := net.Listen("tcp", "127.0.0.1:0")
    require.NoError(t, err)
    addr := ln.Addr().String()

    // Start the server
    go srv.Serve(ln)

    // Start a slow request
    var wg sync.WaitGroup
    var requestErr error
    wg.Add(1)
    go func() {
        defer wg.Done()
        resp, err := http.Get("http://" + addr + "/")
        if err != nil {
            requestErr = err
            return
        }
        defer resp.Body.Close()
        assert.Equal(t, http.StatusOK, resp.StatusCode)
    }()

    // Give the request time to start
    time.Sleep(100 * time.Millisecond)

    // Initiate graceful shutdown
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    err = srv.Shutdown(ctx)
    require.NoError(t, err, "graceful shutdown should succeed")

    // Verify the in-flight request completed
    wg.Wait()
    assert.NoError(t, requestErr, "in-flight request should have completed successfully")
}

func TestGracefulShutdown_NewRequestsRejectedAfterShutdown(t *testing.T) {
    srv := &http.Server{
        Addr:    "127.0.0.1:0",
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.WriteHeader(http.StatusOK)
        }),
    }

    ln, err := net.Listen("tcp", "127.0.0.1:0")
    require.NoError(t, err)
    addr := ln.Addr().String()
    go srv.Serve(ln)

    // Shutdown the server
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    require.NoError(t, srv.Shutdown(ctx))

    // New requests should fail (connection refused or EOF)
    _, err = http.Get("http://" + addr + "/")
    assert.Error(t, err, "requests after shutdown should fail")
}
```

## Section 10: Production Checklist

```bash
# Verify terminationGracePeriodSeconds is set appropriately
kubectl get deployment myapp -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}'

# Verify preStop hook is configured
kubectl get deployment myapp -o jsonpath='{.spec.template.spec.containers[0].lifecycle.preStop}'

# Test shutdown in a lower environment
kubectl delete pod myapp-xxx --wait=false
# Observe logs: should see "shutdown signal received", "draining connections", "stopped"
# Should NOT see "connection refused" errors on requests made during shutdown

# Check for zombie connections after shutdown
# (connections that never got cleaned up)
ss -s
lsof -p $(pgrep myapp) | wc -l

# Validate with a load test during rolling update
hey -n 10000 -c 50 http://myapp.production.svc/api/v1/health
# Error rate should be 0% during the rolling update
```

Graceful shutdown is not a single feature — it is a layered contract between your application, the HTTP/gRPC server, the connection pool, background workers, and Kubernetes. Getting each layer right and validating the complete sequence under real load is what separates services that degrade gracefully from services that drop requests every time a deployment rolls out.
