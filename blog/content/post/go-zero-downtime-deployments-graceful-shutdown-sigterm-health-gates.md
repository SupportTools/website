---
title: "Go Zero-Downtime Deployments: Graceful HTTP Server Shutdown, Connection Draining, and Health Gates"
date: 2031-11-19T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Zero-Downtime", "Graceful Shutdown", "Kubernetes", "Health Checks", "SIGTERM", "Deployment"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete enterprise guide to zero-downtime deployments in Go: implementing graceful HTTP server shutdown with proper SIGTERM handling, connection draining, in-flight request completion, health gate patterns, and Kubernetes readiness/liveness probe coordination."
more_link: "yes"
url: "/go-zero-downtime-deployments-graceful-shutdown-sigterm-health-gates/"
---

Kubernetes rolling deployments are designed to be zero-downtime, but they only work that way if your application correctly implements graceful shutdown. A surprising number of Go services have bugs in their shutdown path that cause request drops, broken connections, or incomplete transactions during deployment — problems that only manifest in production at scale when pod termination overlaps with active traffic.

This guide covers every layer of Go zero-downtime deployment: SIGTERM handling, HTTP server graceful shutdown, connection draining, health gate patterns that prevent traffic from being sent to a pod that is not ready, and the timing relationship between Kubernetes lifecycle hooks and your application's shutdown sequence.

<!--more-->

# Go Zero-Downtime Deployments: Graceful Shutdown in Production

## The Kubernetes Pod Termination Sequence

Understanding what Kubernetes does when it terminates a pod is essential before writing any shutdown code. The sequence is:

```
1. kubectl delete pod / rolling update triggers pod termination
2. Pod phase changes to Terminating
3. SIMULTANEOUSLY:
   a. preStop hook executes (if configured)
   b. Pod removed from Endpoints (service load balancer stops sending new traffic)
4. After preStop hook completes (or immediately if none):
   SIGTERM is sent to PID 1 in every container
5. Application handles SIGTERM gracefully
6. If application does not exit within terminationGracePeriodSeconds:
   SIGKILL is sent (hard kill, no cleanup)
```

The critical insight: **steps 3a and 3b happen simultaneously, not sequentially**. The pod is removed from the service endpoints at the same time the preStop hook runs. However, there is a race condition: the load balancer (kube-proxy or cloud LB) may not immediately stop routing traffic. Depending on your setup, traffic can continue arriving for 1-10 seconds after the Endpoints update.

This is why a simple `signal.Notify` + `server.Shutdown()` pattern is insufficient — you need to delay the shutdown long enough for in-flight traffic to complete AND for the load balancer propagation to stop sending new requests.

## The Complete Shutdown Architecture

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "sync/atomic"
    "syscall"
    "time"
)

// Server wraps http.Server with graceful shutdown support
type Server struct {
    httpServer          *http.Server
    metricsServer       *http.Server
    logger              *slog.Logger

    // Health gate: controls /healthz and /readyz responses
    ready               atomic.Bool
    shutdownInProgress  atomic.Bool

    // Track active connections for draining
    activeConns         sync.WaitGroup
    activeConnCount     atomic.Int64

    // Configuration
    cfg ServerConfig
}

type ServerConfig struct {
    ListenAddr              string
    MetricsAddr             string
    ReadTimeout             time.Duration
    WriteTimeout            time.Duration
    IdleTimeout             time.Duration
    ShutdownTimeout         time.Duration
    // Time to wait after marking not-ready before starting shutdown
    // Allows load balancer propagation to complete
    ReadinessGracePeriod    time.Duration
}

func DefaultConfig() ServerConfig {
    return ServerConfig{
        ListenAddr:           ":8080",
        MetricsAddr:          ":9090",
        ReadTimeout:          15 * time.Second,
        WriteTimeout:         30 * time.Second,
        IdleTimeout:          60 * time.Second,
        ShutdownTimeout:      30 * time.Second,
        ReadinessGracePeriod: 10 * time.Second,
    }
}
```

## Health Gate Pattern

The health gate controls when traffic is sent to your pod. The key insight is that readiness and liveness serve different purposes:

- **Liveness** (`/healthz`): Is the process alive? Returns 200 unless the process is in a truly broken state. Kubernetes restarts the pod on failure.
- **Readiness** (`/readyz`): Should traffic be sent here? Returns 503 when the pod is not ready to handle requests (starting up or shutting down). Kubernetes removes the pod from Endpoints on failure.

```go
func (s *Server) setupHandlers() http.Handler {
    mux := http.NewServeMux()

    // Liveness: only fails if process is critically broken
    mux.HandleFunc("/healthz", s.livenessHandler)

    // Readiness: controls traffic routing
    mux.HandleFunc("/readyz", s.readinessHandler)

    // Application routes
    mux.HandleFunc("/api/v1/", s.apiHandler)

    return mux
}

func (s *Server) livenessHandler(w http.ResponseWriter, r *http.Request) {
    // Liveness should almost never fail
    // Only fail if the process is deadlocked or in an unrecoverable state
    w.WriteHeader(http.StatusOK)
    fmt.Fprint(w, "ok")
}

func (s *Server) readinessHandler(w http.ResponseWriter, r *http.Request) {
    if s.shutdownInProgress.Load() {
        // Shutdown started: stop receiving traffic immediately
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprint(w, "shutting down")
        return
    }

    if !s.ready.Load() {
        // Not yet ready (startup sequence incomplete)
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprint(w, "not ready")
        return
    }

    // Perform dependency checks
    if err := s.checkDependencies(r.Context()); err != nil {
        s.logger.Warn("readiness check failed", "error", err)
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprintf(w, "dependency check failed: %v", err)
        return
    }

    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, "ready; active_connections=%d", s.activeConnCount.Load())
}

func (s *Server) checkDependencies(ctx context.Context) error {
    // Check database connectivity
    checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    if err := s.db.PingContext(checkCtx); err != nil {
        return fmt.Errorf("database: %w", err)
    }

    return nil
}
```

## Connection Tracking

Track in-flight connections so shutdown can wait for them to complete:

```go
// ConnStateTracker tracks HTTP connection states for graceful shutdown
type ConnStateTracker struct {
    activeConns     sync.Map  // net.Conn -> state
    activeCount     atomic.Int64
    logger          *slog.Logger
}

func (t *ConnStateTracker) ConnState(conn net.Conn, state http.ConnState) {
    switch state {
    case http.StateNew:
        t.activeConns.Store(conn.RemoteAddr().String(), state)
        t.activeCount.Add(1)
    case http.StateHijacked, http.StateClosed:
        if _, loaded := t.activeConns.LoadAndDelete(conn.RemoteAddr().String()); loaded {
            t.activeCount.Add(-1)
        }
    case http.StateActive:
        t.activeConns.Store(conn.RemoteAddr().String(), state)
    case http.StateIdle:
        t.activeConns.Store(conn.RemoteAddr().String(), state)
    }
}

func (t *ConnStateTracker) ActiveCount() int64 {
    return t.activeCount.Load()
}

func (t *ConnStateTracker) WaitForDrain(ctx context.Context) error {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        if t.activeCount.Load() == 0 {
            return nil
        }

        select {
        case <-ctx.Done():
            remaining := t.activeCount.Load()
            return fmt.Errorf("timed out with %d connections still active", remaining)
        case <-ticker.C:
            t.logger.Debug("waiting for connections to drain",
                "active_connections", t.activeCount.Load())
        }
    }
}
```

## The Shutdown Sequence Implementation

```go
func (s *Server) Run(ctx context.Context) error {
    // Set up connection state tracking
    tracker := &ConnStateTracker{logger: s.logger}
    s.httpServer.ConnState = tracker.ConnState

    // Start servers
    errCh := make(chan error, 2)

    go func() {
        s.logger.Info("HTTP server starting", "addr", s.cfg.ListenAddr)
        if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            errCh <- fmt.Errorf("http server: %w", err)
        }
    }()

    go func() {
        s.logger.Info("Metrics server starting", "addr", s.cfg.MetricsAddr)
        if err := s.metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            errCh <- fmt.Errorf("metrics server: %w", err)
        }
    }()

    // Startup sequence: wait for dependencies before marking ready
    if err := s.startup(ctx); err != nil {
        return fmt.Errorf("startup failed: %w", err)
    }
    s.ready.Store(true)
    s.logger.Info("Server is ready")

    // Wait for shutdown signal or fatal error
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    defer signal.Stop(sigCh)

    select {
    case sig := <-sigCh:
        s.logger.Info("Received signal, starting graceful shutdown", "signal", sig)
    case err := <-errCh:
        s.logger.Error("Server error, starting shutdown", "error", err)
        return err
    case <-ctx.Done():
        s.logger.Info("Context cancelled, starting shutdown")
    }

    return s.shutdown(ctx, tracker)
}

func (s *Server) shutdown(ctx context.Context, tracker *ConnStateTracker) error {
    // Phase 1: Mark as shutting down
    // readinessHandler will immediately return 503
    s.shutdownInProgress.Store(true)
    s.logger.Info("Phase 1: Marked not-ready, waiting for LB propagation",
        "grace_period", s.cfg.ReadinessGracePeriod)

    // Wait for load balancer to stop sending traffic
    // This is the most important delay — without it, traffic arrives after shutdown starts
    select {
    case <-time.After(s.cfg.ReadinessGracePeriod):
    case <-ctx.Done():
        s.logger.Warn("Context cancelled during readiness grace period")
    }

    // Phase 2: Stop accepting new connections
    // http.Server.Shutdown() closes the listener and waits for active requests
    s.logger.Info("Phase 2: Stopping new connection acceptance")

    shutdownCtx, cancel := context.WithTimeout(ctx, s.cfg.ShutdownTimeout)
    defer cancel()

    // Shutdown HTTP server (stops accepting new requests, waits for active ones)
    if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            s.logger.Error("HTTP server shutdown timed out",
                "active_connections", tracker.ActiveCount())
        } else {
            s.logger.Error("HTTP server shutdown error", "error", err)
        }
    }

    // Phase 3: Wait for connection drain
    s.logger.Info("Phase 3: Waiting for connections to drain",
        "active_connections", tracker.ActiveCount())

    if err := tracker.WaitForDrain(shutdownCtx); err != nil {
        s.logger.Error("Connection drain incomplete", "error", err)
    }

    // Phase 4: Cleanup
    s.logger.Info("Phase 4: Running cleanup tasks")
    if err := s.cleanup(shutdownCtx); err != nil {
        s.logger.Error("Cleanup failed", "error", err)
    }

    // Shutdown metrics server last
    metricsCtx, metricsCancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer metricsCancel()
    s.metricsServer.Shutdown(metricsCtx)

    s.logger.Info("Graceful shutdown complete")
    return nil
}

func (s *Server) startup(ctx context.Context) error {
    // Wait for database
    s.logger.Info("Waiting for database connection")
    retryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    for {
        if err := s.db.PingContext(retryCtx); err == nil {
            break
        }
        select {
        case <-retryCtx.Done():
            return fmt.Errorf("database not available after 30s")
        case <-time.After(500 * time.Millisecond):
        }
    }

    // Run database migrations
    if err := s.runMigrations(ctx); err != nil {
        return fmt.Errorf("migrations: %w", err)
    }

    // Warm up caches
    if err := s.warmupCache(ctx); err != nil {
        s.logger.Warn("Cache warmup failed (non-fatal)", "error", err)
    }

    return nil
}

func (s *Server) cleanup(ctx context.Context) error {
    var errs []error

    // Close database connections
    if err := s.db.Close(); err != nil {
        errs = append(errs, fmt.Errorf("db close: %w", err))
    }

    // Flush message queue
    if err := s.msgQueue.FlushAndClose(ctx); err != nil {
        errs = append(errs, fmt.Errorf("message queue flush: %w", err))
    }

    // Flush telemetry
    if err := s.telemetry.ForceFlush(ctx); err != nil {
        errs = append(errs, fmt.Errorf("telemetry flush: %w", err))
    }

    return errors.Join(errs...)
}
```

## Kubernetes Deployment Configuration

Match the Kubernetes configuration to your shutdown implementation:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
  namespace: production
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0      # Never reduce available capacity
      maxSurge: 1            # Allow one extra pod during rollout
  template:
    spec:
      # Must be >= ReadinessGracePeriod + ShutdownTimeout + cleanup time
      terminationGracePeriodSeconds: 60

      containers:
      - name: app
        image: my-service:latest
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics

        # Liveness: restart if truly broken
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3

        # Readiness: control traffic routing
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 1  # Fast failure detection
          successThreshold: 1

        # preStop: add delay before SIGTERM
        # This gives time for the readiness probe to fail and
        # for kube-proxy to remove the pod from endpoints
        lifecycle:
          preStop:
            exec:
              # Minimum sleep: time for readiness probe to detect failure
              # and for kube-proxy to propagate the endpoint removal
              # = failureThreshold * periodSeconds + propagation time
              # = 1 * 5s + 5s buffer = 10s
              command: ["/bin/sleep", "10"]

        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi

        env:
        - name: SHUTDOWN_GRACE_PERIOD
          value: "10s"
        - name: SHUTDOWN_TIMEOUT
          value: "30s"
```

### Why preStop + ReadinessGracePeriod

The timing works like this:

```
t=0:  Kubernetes sends SIGTERM AND starts preStop hook
      preStop: sleep 10s
t=0:  Readiness probe returns 503 (shutdownInProgress=true)
t=5:  Kubernetes probe detects failure (periodSeconds=5)
t=8:  kube-proxy updates iptables/IPVS rules
t=10: preStop completes, SIGTERM delivered to app
t=10: App's ReadinessGracePeriod starts (already marked not-ready)
t=20: App starts http.Server.Shutdown()
t=50: terminationGracePeriodSeconds expires, SIGKILL if not done
```

Without the sleep in preStop, SIGTERM arrives at t=0 before kube-proxy has removed the pod from rotation, causing ~5-10 seconds of request failures.

## In-Flight Request Middleware

Track individual requests for guaranteed completion:

```go
// InFlightMiddleware tracks active requests and blocks shutdown until they complete
type InFlightMiddleware struct {
    wg     sync.WaitGroup
    active atomic.Int64
    logger *slog.Logger
}

func (m *InFlightMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        m.wg.Add(1)
        m.active.Add(1)
        defer func() {
            m.active.Add(-1)
            m.wg.Done()
        }()
        next.ServeHTTP(w, r)
    })
}

func (m *InFlightMiddleware) WaitForDrain(ctx context.Context) error {
    done := make(chan struct{})
    go func() {
        m.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("timed out waiting for %d in-flight requests", m.active.Load())
    }
}

// Request timeout middleware: prevents long-running requests from blocking shutdown
func RequestTimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            r = r.WithContext(ctx)
            next.ServeHTTP(w, r)
        })
    }
}
```

## Streaming and WebSocket Shutdown

Long-lived connections (SSE, WebSocket) require special handling:

```go
// ShutdownNotifier sends shutdown signal to long-lived connections
type ShutdownNotifier struct {
    mu       sync.RWMutex
    channels map[string]chan struct{}
    done     chan struct{}
}

func NewShutdownNotifier() *ShutdownNotifier {
    return &ShutdownNotifier{
        channels: make(map[string]chan struct{}),
        done:     make(chan struct{}),
    }
}

func (n *ShutdownNotifier) Register(id string) chan struct{} {
    ch := make(chan struct{})
    n.mu.Lock()
    n.channels[id] = ch
    n.mu.Unlock()
    return ch
}

func (n *ShutdownNotifier) Unregister(id string) {
    n.mu.Lock()
    delete(n.channels, id)
    n.mu.Unlock()
}

func (n *ShutdownNotifier) Shutdown() {
    close(n.done)
    n.mu.RLock()
    for _, ch := range n.channels {
        close(ch)
    }
    n.mu.RUnlock()
}

// SSE handler with shutdown awareness
func (s *Server) sseHandler(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "SSE not supported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    id := generateID()
    shutdownCh := s.shutdownNotifier.Register(id)
    defer s.shutdownNotifier.Unregister(id)

    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-r.Context().Done():
            // Client disconnected
            return

        case <-shutdownCh:
            // Server shutting down: send a close event to client
            fmt.Fprintf(w, "event: shutdown\ndata: {\"message\":\"server shutting down\"}\n\n")
            flusher.Flush()
            return

        case event := <-s.eventStream:
            fmt.Fprintf(w, "data: %s\n\n", event)
            flusher.Flush()

        case <-ticker.C:
            // Heartbeat to keep connection alive through proxies
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()
        }
    }
}
```

## Testing Graceful Shutdown

### Integration Test

```go
func TestGracefulShutdown(t *testing.T) {
    srv := NewServer(DefaultConfig())

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Start server in background
    errCh := make(chan error, 1)
    go func() {
        errCh <- srv.Run(ctx)
    }()

    // Wait for readiness
    require.Eventually(t, func() bool {
        resp, err := http.Get("http://localhost:8080/readyz")
        return err == nil && resp.StatusCode == http.StatusOK
    }, 10*time.Second, 100*time.Millisecond)

    // Start a long-running request
    longReqDone := make(chan struct{})
    go func() {
        defer close(longReqDone)
        resp, err := http.Get("http://localhost:8080/api/v1/slow")
        if err != nil {
            t.Logf("long request error: %v", err)
            return
        }
        resp.Body.Close()
        assert.Equal(t, http.StatusOK, resp.StatusCode, "long request should complete successfully")
    }()

    // Give long request time to start
    time.Sleep(100 * time.Millisecond)

    // Send SIGTERM
    process, _ := os.FindProcess(os.Getpid())
    process.Signal(syscall.SIGTERM)

    // Verify readiness immediately returns 503
    require.Eventually(t, func() bool {
        resp, err := http.Get("http://localhost:8080/readyz")
        return err == nil && resp.StatusCode == http.StatusServiceUnavailable
    }, 2*time.Second, 50*time.Millisecond, "readiness should fail immediately on shutdown signal")

    // Wait for graceful shutdown to complete
    select {
    case err := <-errCh:
        assert.NoError(t, err)
    case <-time.After(45*time.Second):
        t.Fatal("server did not shut down within timeout")
    }

    // Long request should have completed successfully
    select {
    case <-longReqDone:
        // Good
    case <-time.After(1*time.Second):
        t.Fatal("long request did not complete during graceful shutdown")
    }
}
```

### Load Test During Deployment

```bash
#!/bin/bash
# Test zero-downtime during rolling deployment
# Requires: hey (https://github.com/rakyll/hey)

# Start continuous load test
hey -z 120s -c 10 -q 100 \
  -m GET \
  http://my-service.production.svc.cluster.local/api/v1/health &
HEY_PID=$!

# Wait for load to stabilize
sleep 10

# Trigger rolling deployment
kubectl rollout restart deployment/my-service -n production

# Wait for rollout to complete
kubectl rollout status deployment/my-service -n production --timeout=120s

# Stop load test
kill $HEY_PID
wait $HEY_PID 2>/dev/null

# Check for errors in results
# hey outputs error count; should be 0
```

## Summary

Zero-downtime deployments in Go require orchestrating four distinct concerns: health gates that let Kubernetes route traffic correctly, SIGTERM handling that initiates an orderly shutdown, a readiness grace period that accounts for load balancer propagation latency, and connection draining that ensures every in-flight request reaches completion. Missing any one of these creates a deployment that appears to succeed but drops requests under load.

The timing relationship between `preStop`, the readiness probe failure period, and your `ReadinessGracePeriod` is the most counterintuitive part — the sleep in preStop is not a hack, it is a necessary accommodation for the asynchronous nature of Kubernetes endpoint propagation. With `terminationGracePeriodSeconds` sized to encompass all phases, and `maxUnavailable: 0` ensuring capacity is never reduced during rollout, you have a complete zero-downtime deployment system that handles the full lifecycle correctly.
