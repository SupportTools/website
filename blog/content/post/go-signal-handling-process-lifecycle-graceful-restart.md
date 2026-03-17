---
title: "Go Signal Handling and Process Lifecycle: SIGTERM, SIGHUP, and Graceful Restarts"
date: 2029-02-22T00:00:00-05:00
draft: false
tags: ["Go", "Signals", "Process Management", "Kubernetes", "Graceful Shutdown"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Unix signal handling in Go — implementing graceful HTTP server shutdowns, SIGHUP-triggered configuration reloads, and zero-downtime process restarts for Kubernetes-deployed services."
more_link: "yes"
url: "/go-signal-handling-process-lifecycle-graceful-restart/"
---

When Kubernetes terminates a Pod, it sends SIGTERM to PID 1 in each container and then, after the `terminationGracePeriodSeconds`, sends SIGKILL. Any in-flight requests that are not completed before SIGKILL arrives will fail with connection errors from the client's perspective. For services with SLOs requiring high availability, these failed requests are indistinguishable from genuine errors.

Proper signal handling in Go prevents these failures. It also enables runtime configuration reloads (SIGHUP), log rotation (SIGUSR1), and orderly connection draining that allows long-running requests to complete before the process exits. This guide provides complete, production-tested patterns for all of these scenarios.

<!--more-->

## Signal Basics in Go

The `os/signal` package provides the interface for signal handling. Unlike C, Go cannot directly install signal handlers that run in arbitrary contexts — instead, signal notifications are delivered to channels. This is the idiomatic Go approach: signals are just another message source in a `select` loop.

```go
package main

import (
    "context"
    "fmt"
    "os"
    "os/signal"
    "syscall"
)

func main() {
    // Create a buffered channel for signals.
    // The buffer size of 1 ensures that the signal is not lost if the
    // goroutine is not immediately ready to receive.
    sigCh := make(chan os.Signal, 1)

    // Register for specific signals. Unregistered signals retain default behavior.
    signal.Notify(sigCh,
        syscall.SIGTERM, // Kubernetes graceful termination
        syscall.SIGINT,  // Ctrl+C from terminal
        syscall.SIGHUP,  // Hangup / config reload
        syscall.SIGUSR1, // User-defined signal 1 (e.g., log rotation)
        syscall.SIGUSR2, // User-defined signal 2
    )
    defer signal.Stop(sigCh) // Deregister when main exits.

    fmt.Printf("PID %d: waiting for signals\n", os.Getpid())

    for sig := range sigCh {
        switch sig {
        case syscall.SIGTERM, syscall.SIGINT:
            fmt.Printf("received %s, initiating graceful shutdown\n", sig)
            return
        case syscall.SIGHUP:
            fmt.Println("received SIGHUP, reloading configuration")
            // Trigger config reload — see full pattern below.
        case syscall.SIGUSR1:
            fmt.Println("received SIGUSR1, rotating logs")
        }
    }
}
```

## Graceful HTTP Server Shutdown

The canonical production pattern for graceful shutdown in Go combines `http.Server.Shutdown` with signal handling. `Shutdown` stops accepting new connections, waits for active requests to complete, and then returns. In-flight requests complete normally; no new requests are accepted.

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
    "syscall"
    "time"
)

// Server encapsulates an HTTP server with graceful shutdown support.
type Server struct {
    httpServer *http.Server
    logger     *slog.Logger
}

func NewServer(addr string, handler http.Handler, logger *slog.Logger) *Server {
    return &Server{
        httpServer: &http.Server{
            Addr:    addr,
            Handler: handler,
            // Always set timeouts to prevent resource exhaustion.
            ReadTimeout:       15 * time.Second,
            ReadHeaderTimeout: 5 * time.Second,
            WriteTimeout:      30 * time.Second,
            IdleTimeout:       120 * time.Second,
        },
        logger: logger,
    }
}

// Run starts the server and blocks until a shutdown signal is received.
// It returns nil on graceful shutdown and an error if the server fails to start.
func (s *Server) Run(ctx context.Context) error {
    // Create a listener separately so we can log the actual bound address
    // (useful when using port 0 for tests).
    ln, err := net.Listen("tcp", s.httpServer.Addr)
    if err != nil {
        return fmt.Errorf("creating listener: %w", err)
    }
    s.logger.Info("server listening", "addr", ln.Addr().String())

    // Channel for server startup errors.
    serveErr := make(chan error, 1)

    go func() {
        if err := s.httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
            serveErr <- fmt.Errorf("server error: %w", err)
        }
    }()

    // Wait for a signal or a server error.
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    defer signal.Stop(sigCh)

    select {
    case err := <-serveErr:
        return err
    case sig := <-sigCh:
        s.logger.Info("shutdown signal received", "signal", sig.String())
    case <-ctx.Done():
        s.logger.Info("context cancelled, initiating shutdown")
    }

    // Graceful shutdown: allow up to 30 seconds for in-flight requests.
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    s.logger.Info("draining connections", "timeout", "30s")
    if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
        return fmt.Errorf("graceful shutdown failed: %w", err)
    }

    s.logger.Info("server stopped cleanly")
    return nil
}
```

## Multi-Component Shutdown Coordination

Production services have multiple components — database connections, message queue consumers, background workers — that must all shut down in a coordinated order. Database connections must close after HTTP handlers finish (otherwise handlers return 500s). Message queue consumers must stop consuming before the database disconnects.

```go
package lifecycle

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

// ShutdownManager coordinates ordered shutdown of multiple components.
type ShutdownManager struct {
    mu         sync.Mutex
    components []shutdownComponent
    timeout    time.Duration
    logger     *slog.Logger
}

type shutdownComponent struct {
    name     string
    priority int // Lower priority values shut down first.
    fn       func(ctx context.Context) error
}

// Register adds a component to the shutdown sequence.
// Components with the same priority shut down concurrently.
// Components with lower priority values shut down before higher values.
func (m *ShutdownManager) Register(name string, priority int, fn func(ctx context.Context) error) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.components = append(m.components, shutdownComponent{
        name:     name,
        priority: priority,
        fn:       fn,
    })
}

// WaitForShutdown blocks until a termination signal is received,
// then executes all registered shutdown functions in priority order.
func (m *ShutdownManager) WaitForShutdown(ctx context.Context) error {
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    defer signal.Stop(sigCh)

    select {
    case sig := <-sigCh:
        m.logger.Info("shutdown signal received", "signal", sig.String())
    case <-ctx.Done():
        m.logger.Info("context cancelled")
    }

    return m.executeShutdown()
}

func (m *ShutdownManager) executeShutdown() error {
    shutdownCtx, cancel := context.WithTimeout(context.Background(), m.timeout)
    defer cancel()

    // Group components by priority.
    byPriority := make(map[int][]shutdownComponent)
    maxPriority := 0
    for _, c := range m.components {
        byPriority[c.priority] = append(byPriority[c.priority], c)
        if c.priority > maxPriority {
            maxPriority = c.priority
        }
    }

    var shutdownErrs []error

    // Shut down in priority order (lowest first).
    for priority := 0; priority <= maxPriority; priority++ {
        components, ok := byPriority[priority]
        if !ok {
            continue
        }

        var wg sync.WaitGroup
        errCh := make(chan error, len(components))

        for _, comp := range components {
            wg.Add(1)
            go func(c shutdownComponent) {
                defer wg.Done()
                m.logger.Info("shutting down component",
                    "component", c.name, "priority", c.priority)
                if err := c.fn(shutdownCtx); err != nil {
                    errCh <- fmt.Errorf("component %s: %w", c.name, err)
                } else {
                    m.logger.Info("component stopped", "component", c.name)
                }
            }(comp)
        }

        wg.Wait()
        close(errCh)
        for err := range errCh {
            shutdownErrs = append(shutdownErrs, err)
        }
    }

    if len(shutdownErrs) > 0 {
        return fmt.Errorf("shutdown errors: %v", shutdownErrs)
    }
    return nil
}

// Usage example showing registration order.
func ExampleShutdownManager() {
    mgr := &ShutdownManager{
        timeout: 30 * time.Second,
        logger:  slog.Default(),
    }

    httpServer := &http.Server{} // placeholder

    // Priority 0: Stop accepting new work first.
    mgr.Register("http-server", 0, func(ctx context.Context) error {
        return httpServer.Shutdown(ctx)
    })

    // Priority 1: Stop background workers that may write to the database.
    mgr.Register("message-consumer", 1, func(ctx context.Context) error {
        // consumer.Stop(ctx)
        return nil
    })
    mgr.Register("background-scheduler", 1, func(ctx context.Context) error {
        // scheduler.Stop()
        return nil
    })

    // Priority 2: Close database and cache connections last.
    mgr.Register("postgres-pool", 2, func(ctx context.Context) error {
        // db.Close()
        return nil
    })
    mgr.Register("redis-client", 2, func(ctx context.Context) error {
        // redis.Close()
        return nil
    })
}
```

## SIGHUP: Configuration Reload Without Restart

SIGHUP is traditionally used to reload configuration files without restarting the process. This pattern is valuable for Kubernetes workloads that receive configuration via ConfigMap mounts — the kubelet updates the mounted file, and the application detects SIGHUP to apply the new configuration.

```go
package config

import (
    "encoding/json"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "sync/atomic"
    "syscall"
    "unsafe"
)

// Config holds the application configuration.
type Config struct {
    LogLevel      string            `json:"logLevel"`
    MaxConns      int               `json:"maxConns"`
    FeatureFlags  map[string]bool   `json:"featureFlags"`
    Endpoints     map[string]string `json:"endpoints"`
}

// ConfigManager provides atomic config access and SIGHUP-triggered reload.
type ConfigManager struct {
    path    string
    current atomic.Pointer[Config]
    logger  *slog.Logger
    onChange []func(*Config)
}

func NewConfigManager(path string, logger *slog.Logger) (*ConfigManager, error) {
    cm := &ConfigManager{
        path:   path,
        logger: logger,
    }

    if err := cm.load(); err != nil {
        return nil, fmt.Errorf("loading initial config: %w", err)
    }

    return cm, nil
}

func (cm *ConfigManager) Get() *Config {
    return cm.current.Load()
}

// OnChange registers a callback invoked after each successful reload.
func (cm *ConfigManager) OnChange(fn func(*Config)) {
    cm.onChange = append(cm.onChange, fn)
}

func (cm *ConfigManager) load() error {
    data, err := os.ReadFile(cm.path)
    if err != nil {
        return fmt.Errorf("reading config file %s: %w", cm.path, err)
    }

    var cfg Config
    if err := json.Unmarshal(data, &cfg); err != nil {
        return fmt.Errorf("parsing config: %w", err)
    }

    // Validate before swapping.
    if err := cm.validate(&cfg); err != nil {
        return fmt.Errorf("invalid config: %w", err)
    }

    cm.current.Store(&cfg)
    cm.logger.Info("configuration loaded", "path", cm.path)
    return nil
}

func (cm *ConfigManager) validate(cfg *Config) error {
    if cfg.MaxConns <= 0 || cfg.MaxConns > 10000 {
        return fmt.Errorf("maxConns must be between 1 and 10000, got %d", cfg.MaxConns)
    }
    return nil
}

// WatchSignals starts a goroutine that reloads config on SIGHUP.
// Returns a stop function to deregister the signal handler.
func (cm *ConfigManager) WatchSignals() func() {
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGHUP)

    stopCh := make(chan struct{})

    go func() {
        for {
            select {
            case <-sigCh:
                cm.logger.Info("SIGHUP received, reloading config")
                old := cm.Get()
                if err := cm.load(); err != nil {
                    cm.logger.Error("config reload failed, keeping current config",
                        "error", err)
                    continue
                }
                new := cm.Get()
                for _, fn := range cm.onChange {
                    fn(new)
                }
                _ = old // Can diff old vs new for structured logging.
            case <-stopCh:
                signal.Stop(sigCh)
                return
            }
        }
    }()

    return func() { close(stopCh) }
}
```

## SIGUSR1: Log Level Rotation

Dynamically changing log verbosity at runtime — without a restart — is invaluable for diagnosing production incidents. The pattern uses SIGUSR1 to cycle through log levels.

```go
package logging

import (
    "log/slog"
    "os"
    "os/signal"
    "syscall"
)

// DynamicLevelHandler wraps a slog.Handler with a swappable log level.
type DynamicLevelHandler struct {
    handler slog.Handler
    level   *slog.LevelVar
}

func NewDynamicLevelHandler(w *os.File) (*DynamicLevelHandler, *slog.LevelVar) {
    level := &slog.LevelVar{}
    level.Set(slog.LevelInfo)

    handler := slog.NewJSONHandler(w, &slog.HandlerOptions{
        Level: level,
        AddSource: true,
    })

    return &DynamicLevelHandler{handler: handler, level: level}, level
}

// StartLogLevelCycler listens for SIGUSR1 and cycles: INFO -> DEBUG -> WARN -> INFO.
func StartLogLevelCycler(level *slog.LevelVar, logger *slog.Logger) func() {
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGUSR1)
    stopCh := make(chan struct{})

    go func() {
        for {
            select {
            case <-sigCh:
                next := cycleLevel(level.Level())
                level.Set(next)
                logger.Info("log level changed", "new_level", next.String())
            case <-stopCh:
                signal.Stop(sigCh)
                return
            }
        }
    }()

    return func() { close(stopCh) }
}

func cycleLevel(current slog.Level) slog.Level {
    switch current {
    case slog.LevelInfo:
        return slog.LevelDebug
    case slog.LevelDebug:
        return slog.LevelWarn
    default:
        return slog.LevelInfo
    }
}
```

## Kubernetes-Specific Signal Patterns

In Kubernetes, several additional considerations affect signal handling.

### PreStop Hook

Kubernetes sends SIGTERM immediately when a Pod is terminated. The `preStop` lifecycle hook runs before SIGTERM and can be used to delay termination — giving time for the load balancer to drain the endpoint.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
      - name: api-server
        image: registry.example.com/api-server:v3.14.2
        lifecycle:
          preStop:
            exec:
              # Sleep gives kube-proxy and the load balancer time to remove
              # this endpoint from rotation before the process receives SIGTERM.
              command: ["/bin/sh", "-c", "sleep 5"]
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
```

### Readiness Gate Integration

The graceful shutdown sequence should also update the readiness endpoint so that the load balancer stops routing new traffic before the process begins draining.

```go
package health

import (
    "context"
    "net/http"
    "sync/atomic"
)

// HealthHandler provides /healthz and /readyz endpoints.
type HealthHandler struct {
    ready atomic.Bool
}

func NewHealthHandler() *HealthHandler {
    h := &HealthHandler{}
    h.ready.Store(true)
    return h
}

// SetNotReady marks the service as not ready (e.g., during shutdown).
// The load balancer will stop routing new requests within one probe interval.
func (h *HealthHandler) SetNotReady() {
    h.ready.Store(false)
}

func (h *HealthHandler) LivezHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
}

func (h *HealthHandler) ReadyzHandler(w http.ResponseWriter, r *http.Request) {
    if h.ready.Load() {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
        return
    }
    w.WriteHeader(http.StatusServiceUnavailable)
    w.Write([]byte("shutting down"))
}

// GracefulShutdown coordinates health probe updates with connection draining.
func GracefulShutdown(
    ctx context.Context,
    server *http.Server,
    health *HealthHandler,
    drainTime time.Duration,
) error {
    // Step 1: Mark not ready so load balancer stops routing new requests.
    health.SetNotReady()
    slog.Info("marked service not ready")

    // Step 2: Wait for the load balancer to drain existing connections.
    // This should match the Kubernetes probe period * failure threshold.
    select {
    case <-time.After(drainTime):
    case <-ctx.Done():
    }

    // Step 3: Gracefully shut down the HTTP server.
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    return server.Shutdown(shutdownCtx)
}
```

## Testing Signal Handling

```go
package main_test

import (
    "net/http"
    "os"
    "syscall"
    "testing"
    "time"
)

func TestGracefulShutdown(t *testing.T) {
    // Start the server in a goroutine.
    errCh := make(chan error, 1)
    go func() {
        errCh <- runServer()
    }()

    // Wait for the server to start.
    time.Sleep(100 * time.Millisecond)

    // Verify the server is handling requests.
    resp, err := http.Get("http://localhost:18080/healthz")
    if err != nil || resp.StatusCode != http.StatusOK {
        t.Fatalf("server not responding before shutdown: %v", err)
    }

    // Send SIGTERM to the current process.
    p, _ := os.FindProcess(os.Getpid())
    p.Signal(syscall.SIGTERM)

    // Verify the server shuts down cleanly within the timeout.
    select {
    case err := <-errCh:
        if err != nil {
            t.Fatalf("server shutdown with error: %v", err)
        }
    case <-time.After(35 * time.Second):
        t.Fatal("server did not shut down within 35 seconds")
    }
}
```

Correct signal handling is not an optimization — it is a correctness requirement for any service deployed to Kubernetes. The patterns here ensure that process termination completes all in-flight work, releases external resources cleanly, and cooperates with the kubelet's graceful termination protocol. Combined with readiness probe integration and the preStop hook, these patterns eliminate the dropped-request class of failures that otherwise occur on every rolling update.
