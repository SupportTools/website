---
title: "Go Microservice Chassis: Health Checks, Graceful Shutdown, Structured Logging, Metrics, and Tracing in a Single Library"
date: 2032-03-08T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "Observability", "OpenTelemetry", "Prometheus", "Health Checks", "Graceful Shutdown"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a production-grade Go microservice chassis that provides health checks, graceful shutdown, structured logging with slog, Prometheus metrics, and OpenTelemetry tracing in a single composable library."
more_link: "yes"
url: "/go-microservice-chassis-health-checks-graceful-shutdown-logging-metrics-tracing/"
---

Every Go microservice needs the same cross-cutting concerns: structured logging, Prometheus metrics, distributed tracing, health endpoints for Kubernetes, and graceful shutdown that drains in-flight requests. Building these correctly from scratch takes days. Getting them wrong causes subtle production bugs: leaked goroutines, incomplete traces, metrics that don't decrement, logs without correlation IDs. This post builds a complete, production-tested microservice chassis as a composable library that handles all of these correctly.

<!--more-->

# Go Microservice Chassis: Health Checks, Graceful Shutdown, Structured Logging, Metrics, and Tracing in a Single Library

## Design Goals

A good chassis library must:
1. Start correctly before accepting traffic (readiness)
2. Report its own health accurately (liveness)
3. Drain all in-flight requests before shutdown
4. Propagate trace context through every operation
5. Emit structured logs with correlation IDs
6. Expose standard metrics without configuration
7. Not interfere with the application's own logic
8. Be testable without a running Kubernetes cluster

## Package Structure

```
chassis/
├── chassis.go          # Main Server struct and lifecycle
├── health/
│   ├── checker.go      # Health check interface and registry
│   ├── kubernetes.go   # Kubernetes probe handlers
│   └── checks.go       # Built-in checks (database, upstream HTTP)
├── logging/
│   ├── logger.go       # slog setup with JSON output
│   └── middleware.go   # HTTP request logging middleware
├── metrics/
│   ├── registry.go     # Prometheus registry
│   └── middleware.go   # HTTP metrics middleware
├── tracing/
│   ├── provider.go     # OTLP trace provider setup
│   └── middleware.go   # HTTP trace context propagation
├── shutdown/
│   └── handler.go      # OS signal handling + drain logic
└── example/
    └── main.go         # Full working example
```

## Core: The Server Struct

```go
// chassis/chassis.go
package chassis

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/trace"

    "myorg/chassis/health"
    "myorg/chassis/logging"
    "myorg/chassis/metrics"
    "myorg/chassis/shutdown"
    "myorg/chassis/tracing"
)

// Config holds all chassis configuration
type Config struct {
    ServiceName    string
    ServiceVersion string

    // HTTP
    HTTPAddr    string
    MetricsAddr string

    // Timeouts
    ReadTimeout    time.Duration
    WriteTimeout   time.Duration
    IdleTimeout    time.Duration
    ShutdownTimeout time.Duration

    // Logging
    LogLevel  slog.Level
    LogFormat string   // "json" or "text"

    // Tracing
    OTLPEndpoint string    // e.g., "localhost:4317"
    TraceSampleRate float64 // 0.0 to 1.0

    // Health
    ReadinessChecks []health.Check
    LivenessChecks  []health.Check
}

func DefaultConfig(name, version string) Config {
    return Config{
        ServiceName:     name,
        ServiceVersion:  version,
        HTTPAddr:        ":8080",
        MetricsAddr:     ":9090",
        ReadTimeout:     30 * time.Second,
        WriteTimeout:    30 * time.Second,
        IdleTimeout:     120 * time.Second,
        ShutdownTimeout: 30 * time.Second,
        LogLevel:        slog.LevelInfo,
        LogFormat:       "json",
        TraceSampleRate: 0.1,
    }
}

// Server is the central chassis object
type Server struct {
    cfg         Config
    logger      *slog.Logger
    registry    *prometheus.Registry
    tracer      trace.Tracer
    healthReg   *health.Registry
    mux         *http.ServeMux
    httpServer  *http.Server
    metricsServer *http.Server
    shutdown    *shutdown.Handler
}

// New creates a new chassis Server with all subsystems initialized
func New(cfg Config) (*Server, error) {
    s := &Server{
        cfg:      cfg,
        mux:      http.NewServeMux(),
        shutdown: shutdown.New(cfg.ShutdownTimeout),
    }

    // Initialize logging
    s.logger = logging.New(cfg.LogLevel, cfg.LogFormat, map[string]string{
        "service": cfg.ServiceName,
        "version": cfg.ServiceVersion,
    })

    // Initialize metrics
    reg, err := metrics.NewRegistry(cfg.ServiceName, cfg.ServiceVersion)
    if err != nil {
        return nil, fmt.Errorf("metrics registry: %w", err)
    }
    s.registry = reg

    // Initialize tracing
    tracerProvider, err := tracing.NewProvider(context.Background(), tracing.Config{
        ServiceName:    cfg.ServiceName,
        ServiceVersion: cfg.ServiceVersion,
        OTLPEndpoint:   cfg.OTLPEndpoint,
        SampleRate:     cfg.TraceSampleRate,
    })
    if err != nil {
        s.logger.Warn("tracing initialization failed, running without traces",
            "error", err,
        )
    } else {
        otel.SetTracerProvider(tracerProvider)
        s.shutdown.Register("tracer", func(ctx context.Context) error {
            return tracerProvider.Shutdown(ctx)
        })
    }
    s.tracer = otel.Tracer(cfg.ServiceName)

    // Initialize health registry
    s.healthReg = health.NewRegistry()
    for _, check := range cfg.ReadinessChecks {
        s.healthReg.RegisterReadiness(check)
    }
    for _, check := range cfg.LivenessChecks {
        s.healthReg.RegisterLiveness(check)
    }

    // Register built-in HTTP handlers
    s.registerInternalHandlers()

    return s, nil
}

func (s *Server) registerInternalHandlers() {
    // Health endpoints for Kubernetes
    s.mux.Handle("/healthz/live",
        health.LivenessHandler(s.healthReg, s.logger))
    s.mux.Handle("/healthz/ready",
        health.ReadinessHandler(s.healthReg, s.logger))
    s.mux.Handle("/healthz/startup",
        health.StartupHandler(s.healthReg, s.logger))

    // Catch-all for not-found
    s.mux.Handle("/", http.NotFoundHandler())
}

// Handle registers a handler with the full middleware stack applied
func (s *Server) Handle(pattern string, handler http.Handler) {
    wrapped := s.wrapMiddleware(handler, pattern)
    s.mux.Handle(pattern, wrapped)
}

// HandleFunc registers a handler function with the full middleware stack
func (s *Server) HandleFunc(pattern string, f http.HandlerFunc) {
    s.Handle(pattern, f)
}

func (s *Server) wrapMiddleware(h http.Handler, route string) http.Handler {
    // Apply from innermost to outermost:
    // 1. Tracing (outermost - starts span first)
    // 2. Logging (logs request with trace ID)
    // 3. Metrics (records duration)
    // 4. Recovery (catches panics)
    // 5. Handler

    h = metrics.Middleware(h, s.registry, route)
    h = logging.Middleware(h, s.logger)
    h = tracing.Middleware(h, s.tracer, s.cfg.ServiceName, route)
    h = recoverMiddleware(h, s.logger)
    return h
}

// Logger returns the chassis logger for use in application code
func (s *Server) Logger() *slog.Logger { return s.logger }

// Registry returns the Prometheus registry for custom metrics
func (s *Server) Registry() *prometheus.Registry { return s.registry }

// Tracer returns the OpenTelemetry tracer
func (s *Server) Tracer() trace.Tracer { return s.tracer }

// Run starts all servers and blocks until a shutdown signal is received
func (s *Server) Run(ctx context.Context) error {
    // Build the application HTTP server with middleware stack
    s.httpServer = &http.Server{
        Addr:         s.cfg.HTTPAddr,
        Handler:      s.mux,
        ReadTimeout:  s.cfg.ReadTimeout,
        WriteTimeout: s.cfg.WriteTimeout,
        IdleTimeout:  s.cfg.IdleTimeout,
        ErrorLog:     slog.NewLogLogger(s.logger.Handler(), slog.LevelError),
    }

    // Build the metrics-only server (separate port)
    metricsMux := http.NewServeMux()
    metricsMux.Handle("/metrics", metrics.Handler(s.registry))
    s.metricsServer = &http.Server{
        Addr:    s.cfg.MetricsAddr,
        Handler: metricsMux,
    }

    // Register HTTP servers for graceful shutdown
    s.shutdown.Register("http", func(ctx context.Context) error {
        return s.httpServer.Shutdown(ctx)
    })
    s.shutdown.Register("metrics", func(ctx context.Context) error {
        return s.metricsServer.Shutdown(ctx)
    })

    // Start servers
    httpLn, err := net.Listen("tcp", s.cfg.HTTPAddr)
    if err != nil {
        return fmt.Errorf("listen %s: %w", s.cfg.HTTPAddr, err)
    }
    metricsLn, err := net.Listen("tcp", s.cfg.MetricsAddr)
    if err != nil {
        return fmt.Errorf("listen %s: %w", s.cfg.MetricsAddr, err)
    }

    errCh := make(chan error, 2)

    go func() {
        s.logger.Info("HTTP server starting", "addr", s.cfg.HTTPAddr)
        if err := s.httpServer.Serve(httpLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
            errCh <- fmt.Errorf("HTTP server: %w", err)
        }
    }()

    go func() {
        s.logger.Info("Metrics server starting", "addr", s.cfg.MetricsAddr)
        if err := s.metricsServer.Serve(metricsLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
            errCh <- fmt.Errorf("metrics server: %w", err)
        }
    }()

    // Wait for shutdown signal or error
    select {
    case err := <-errCh:
        return err
    case <-s.shutdown.Done():
        s.logger.Info("shutdown signal received, draining")
        return s.shutdown.Wait()
    case <-ctx.Done():
        s.logger.Info("context cancelled, draining")
        return s.shutdown.Trigger(ctx)
    }
}
```

## Health Checks

```go
// chassis/health/checker.go
package health

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "sync"
    "time"
)

// Check is a named health check function
type Check interface {
    Name() string
    Check(ctx context.Context) error
}

// CheckFunc adapts a function to the Check interface
type CheckFunc struct {
    name string
    fn   func(ctx context.Context) error
}

func NewCheck(name string, fn func(ctx context.Context) error) Check {
    return &CheckFunc{name: name, fn: fn}
}

func (c *CheckFunc) Name() string                        { return c.name }
func (c *CheckFunc) Check(ctx context.Context) error     { return c.fn(ctx) }

// Registry manages health checks and their results
type Registry struct {
    mu         sync.RWMutex
    readiness  []Check
    liveness   []Check
    startup    []Check
    started    bool
}

func NewRegistry() *Registry {
    return &Registry{}
}

func (r *Registry) RegisterReadiness(c Check) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.readiness = append(r.readiness, c)
}

func (r *Registry) RegisterLiveness(c Check) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.liveness = append(r.liveness, c)
}

func (r *Registry) RegisterStartup(c Check) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.startup = append(r.startup, c)
}

func (r *Registry) MarkStarted() {
    r.mu.Lock()
    r.started = true
    r.mu.Unlock()
}

type healthResponse struct {
    Status string            `json:"status"`
    Checks map[string]string `json:"checks,omitempty"`
}

func runChecks(ctx context.Context, checks []Check) (bool, map[string]string) {
    results := make(map[string]string, len(checks))
    healthy := true

    // Run checks with a timeout
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    type result struct {
        name string
        err  error
    }

    resultCh := make(chan result, len(checks))
    for _, check := range checks {
        go func(c Check) {
            resultCh <- result{name: c.Name(), err: c.Check(ctx)}
        }(check)
    }

    for range checks {
        r := <-resultCh
        if r.err != nil {
            results[r.name] = r.err.Error()
            healthy = false
        } else {
            results[r.name] = "ok"
        }
    }

    return healthy, results
}

func handler(reg *Registry, checks func() []Check, logger *slog.Logger) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        healthy, results := runChecks(r.Context(), checks())

        resp := healthResponse{
            Checks: results,
        }
        status := http.StatusOK
        if healthy {
            resp.Status = "healthy"
        } else {
            resp.Status = "unhealthy"
            status = http.StatusServiceUnavailable
            logger.Warn("health check failed", "checks", results)
        }

        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(status)
        json.NewEncoder(w).Encode(resp)
    })
}

func LivenessHandler(reg *Registry, logger *slog.Logger) http.Handler {
    return handler(reg, func() []Check {
        reg.mu.RLock()
        defer reg.mu.RUnlock()
        return reg.liveness
    }, logger)
}

func ReadinessHandler(reg *Registry, logger *slog.Logger) http.Handler {
    return handler(reg, func() []Check {
        reg.mu.RLock()
        defer reg.mu.RUnlock()
        return reg.readiness
    }, logger)
}

func StartupHandler(reg *Registry, logger *slog.Logger) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        reg.mu.RLock()
        started := reg.started
        startup := reg.startup
        reg.mu.RUnlock()

        if !started {
            // Still in startup phase
            healthy, results := runChecks(r.Context(), startup)
            if healthy {
                reg.MarkStarted()
                w.WriteHeader(http.StatusOK)
            } else {
                w.WriteHeader(http.StatusServiceUnavailable)
                json.NewEncoder(w).Encode(healthResponse{
                    Status: "starting",
                    Checks: results,
                })
            }
            return
        }

        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(healthResponse{Status: "started"})
    })
}
```

### Built-in Health Checks

```go
// chassis/health/checks.go
package health

import (
    "context"
    "database/sql"
    "fmt"
    "net/http"
    "time"
)

// DatabaseCheck checks a SQL database connection
func DatabaseCheck(name string, db *sql.DB) Check {
    return NewCheck(name, func(ctx context.Context) error {
        ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
        defer cancel()
        return db.PingContext(ctx)
    })
}

// HTTPCheck checks that an upstream HTTP endpoint returns 2xx
func HTTPCheck(name, url string, client *http.Client) Check {
    if client == nil {
        client = &http.Client{Timeout: 5 * time.Second}
    }
    return NewCheck(name, func(ctx context.Context) error {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        if err != nil {
            return err
        }
        resp, err := client.Do(req)
        if err != nil {
            return err
        }
        defer resp.Body.Close()
        if resp.StatusCode >= 400 {
            return fmt.Errorf("upstream returned %d", resp.StatusCode)
        }
        return nil
    })
}

// MemoryCheck fails if heap allocation exceeds the threshold in bytes
func MemoryCheck(name string, maxHeapBytes uint64) Check {
    return NewCheck(name, func(ctx context.Context) error {
        var ms runtime.MemStats
        runtime.ReadMemStats(&ms)
        if ms.HeapAlloc > maxHeapBytes {
            return fmt.Errorf("heap %d bytes exceeds threshold %d bytes",
                ms.HeapAlloc, maxHeapBytes)
        }
        return nil
    })
}

// GoroutineCheck fails if goroutine count exceeds the threshold
func GoroutineCheck(name string, max int) Check {
    return NewCheck(name, func(ctx context.Context) error {
        count := runtime.NumGoroutine()
        if count > max {
            return fmt.Errorf("goroutine count %d exceeds threshold %d", count, max)
        }
        return nil
    })
}
```

## Graceful Shutdown Handler

```go
// chassis/shutdown/handler.go
package shutdown

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

type shutdownFn struct {
    name string
    fn   func(ctx context.Context) error
}

// Handler orchestrates graceful shutdown of multiple components
type Handler struct {
    timeout   time.Duration
    fns       []shutdownFn
    mu        sync.Mutex
    doneCh    chan struct{}
    sigCh     chan os.Signal
    once      sync.Once
}

func New(timeout time.Duration) *Handler {
    h := &Handler{
        timeout: timeout,
        doneCh:  make(chan struct{}),
        sigCh:   make(chan os.Signal, 2),
    }

    signal.Notify(h.sigCh, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        sig := <-h.sigCh
        slog.Default().Info("received shutdown signal", "signal", sig)
        h.once.Do(func() { close(h.doneCh) })
    }()

    return h
}

// Register adds a shutdown function that will be called during graceful shutdown
// Functions are called in reverse registration order (LIFO)
func (h *Handler) Register(name string, fn func(ctx context.Context) error) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.fns = append(h.fns, shutdownFn{name: name, fn: fn})
}

// Done returns a channel that is closed when a shutdown signal is received
func (h *Handler) Done() <-chan struct{} { return h.doneCh }

// Trigger initiates shutdown manually (e.g., from context cancellation)
func (h *Handler) Trigger(ctx context.Context) error {
    h.once.Do(func() { close(h.doneCh) })
    return h.Wait()
}

// Wait runs all shutdown functions in LIFO order with the configured timeout
func (h *Handler) Wait() error {
    ctx, cancel := context.WithTimeout(context.Background(), h.timeout)
    defer cancel()

    h.mu.Lock()
    fns := make([]shutdownFn, len(h.fns))
    copy(fns, h.fns)
    h.mu.Unlock()

    var errs []error
    // Shutdown in LIFO order (reverse registration order)
    for i := len(fns) - 1; i >= 0; i-- {
        fn := fns[i]
        slog.Default().Info("shutting down component", "component", fn.name)
        if err := fn.fn(ctx); err != nil {
            slog.Default().Error("shutdown error",
                "component", fn.name,
                "error", err,
            )
            errs = append(errs, fmt.Errorf("%s: %w", fn.name, err))
        } else {
            slog.Default().Info("component shut down cleanly", "component", fn.name)
        }
    }

    if len(errs) > 0 {
        return fmt.Errorf("shutdown errors: %v", errs)
    }
    return nil
}
```

## Structured Logging with slog

```go
// chassis/logging/logger.go
package logging

import (
    "context"
    "log/slog"
    "os"
)

type contextKey struct{}

// New creates a configured slog.Logger
func New(level slog.Level, format string, attrs map[string]string) *slog.Logger {
    var handler slog.Handler
    opts := &slog.HandlerOptions{
        Level:     level,
        AddSource: level == slog.LevelDebug,
    }

    if format == "json" {
        handler = slog.NewJSONHandler(os.Stdout, opts)
    } else {
        handler = slog.NewTextHandler(os.Stdout, opts)
    }

    // Add static service attributes to every log line
    args := make([]any, 0, len(attrs)*2)
    for k, v := range attrs {
        args = append(args, k, v)
    }
    logger := slog.New(handler).With(args...)
    slog.SetDefault(logger)
    return logger
}

// FromContext retrieves the logger from context, falling back to the default
func FromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(contextKey{}).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}

// WithLogger stores a logger in the context
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, contextKey{}, logger)
}

// chassis/logging/middleware.go
func Middleware(next http.Handler, logger *slog.Logger) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Extract trace context for log correlation
        spanCtx := trace.SpanFromContext(r.Context()).SpanContext()
        reqLogger := logger
        if spanCtx.IsValid() {
            reqLogger = logger.With(
                "trace_id", spanCtx.TraceID().String(),
                "span_id", spanCtx.SpanID().String(),
            )
        }

        // Add request-specific fields
        reqLogger = reqLogger.With(
            "method", r.Method,
            "path", r.URL.Path,
            "remote_addr", r.RemoteAddr,
            "user_agent", r.UserAgent(),
        )

        // Store logger in context for handler use
        ctx := WithLogger(r.Context(), reqLogger)
        r = r.WithContext(ctx)

        // Wrap response writer to capture status code
        rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
        next.ServeHTTP(rw, r)

        // Log after response
        reqLogger.Info("http request",
            "status", rw.status,
            "duration_ms", time.Since(start).Milliseconds(),
            "bytes", rw.bytes,
        )
    })
}

type responseWriter struct {
    http.ResponseWriter
    status int
    bytes  int
}

func (rw *responseWriter) WriteHeader(status int) {
    rw.status = status
    rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytes += n
    return n, err
}
```

## Prometheus Metrics Middleware

```go
// chassis/metrics/middleware.go
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

type Metrics struct {
    requestTotal    *prometheus.CounterVec
    requestDuration *prometheus.HistogramVec
    requestInFlight *prometheus.GaugeVec
    requestSize     *prometheus.HistogramVec
    responseSize    *prometheus.HistogramVec
}

func NewRegistry(serviceName, version string) (*prometheus.Registry, error) {
    reg := prometheus.NewRegistry()

    // Register standard Go runtime metrics
    reg.MustRegister(
        prometheus.NewGoCollector(),
        prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}),
    )

    return reg, nil
}

func Handler(reg *prometheus.Registry) http.Handler {
    return promhttp.HandlerFor(reg, promhttp.HandlerOpts{
        EnableOpenMetrics: true,
        Registry:          reg,
    })
}

type metricsMiddleware struct {
    m     *Metrics
    route string
}

func Middleware(next http.Handler, reg *prometheus.Registry, route string) http.Handler {
    m := newMetrics(reg)
    return &metricsMiddleware{m: m, route: route}
}

func newMetrics(reg *prometheus.Registry) *Metrics {
    m := &Metrics{
        requestTotal: prometheus.NewCounterVec(
            prometheus.CounterOpts{
                Name: "http_requests_total",
                Help: "Total number of HTTP requests",
            },
            []string{"method", "route", "status_code"},
        ),
        requestDuration: prometheus.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "http_request_duration_seconds",
                Help:    "HTTP request latency distribution",
                Buckets: prometheus.DefBuckets,
            },
            []string{"method", "route"},
        ),
        requestInFlight: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "http_requests_in_flight",
                Help: "Number of HTTP requests currently being served",
            },
            []string{"method", "route"},
        ),
    }

    // Ignore duplicate registration (idempotent middleware initialization)
    for _, c := range []prometheus.Collector{
        m.requestTotal,
        m.requestDuration,
        m.requestInFlight,
    } {
        if err := reg.Register(c); err != nil {
            var are *prometheus.AlreadyRegisteredError
            if !errors.As(err, &are) {
                panic(err)
            }
        }
    }

    return m
}

func (mw *metricsMiddleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}

    mw.m.requestInFlight.WithLabelValues(r.Method, mw.route).Inc()
    defer mw.m.requestInFlight.WithLabelValues(r.Method, mw.route).Dec()

    // Serve the request
    mw.next.ServeHTTP(rw, r)

    duration := time.Since(start).Seconds()
    status := strconv.Itoa(rw.status)

    mw.m.requestTotal.WithLabelValues(r.Method, mw.route, status).Inc()
    mw.m.requestDuration.WithLabelValues(r.Method, mw.route).Observe(duration)
}
```

## OpenTelemetry Tracing

```go
// chassis/tracing/provider.go
package tracing

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string
    SampleRate     float64
}

func NewProvider(ctx context.Context, cfg Config) (*sdktrace.TracerProvider, error) {
    // Build resource attributes
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithFromEnv(),
        resource.WithProcess(),
        resource.WithOS(),
        resource.WithHost(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // Set up OTLP exporter if endpoint is configured
    var exporter sdktrace.SpanExporter
    if cfg.OTLPEndpoint != "" {
        conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
            grpc.WithTransportCredentials(insecure.NewCredentials()),
            grpc.WithBlock(),
            grpc.WithTimeout(5*time.Second),
        )
        if err != nil {
            return nil, fmt.Errorf("OTLP gRPC connection: %w", err)
        }
        exporter, err = otlptracegrpc.New(ctx,
            otlptracegrpc.WithGRPCConn(conn),
        )
        if err != nil {
            return nil, fmt.Errorf("OTLP trace exporter: %w", err)
        }
    }

    // Configure sampling
    var sampler sdktrace.Sampler
    switch {
    case cfg.SampleRate >= 1.0:
        sampler = sdktrace.AlwaysSample()
    case cfg.SampleRate <= 0.0:
        sampler = sdktrace.NeverSample()
    default:
        sampler = sdktrace.TraceIDRatioBased(cfg.SampleRate)
    }

    opts := []sdktrace.TracerProviderOption{
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    }
    if exporter != nil {
        opts = append(opts,
            sdktrace.WithBatcher(exporter,
                sdktrace.WithMaxExportBatchSize(512),
                sdktrace.WithBatchTimeout(5*time.Second),
            ),
        )
    }

    tp := sdktrace.NewTracerProvider(opts...)

    // Set global propagator for W3C TraceContext + Baggage
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

// chassis/tracing/middleware.go
func Middleware(next http.Handler, tracer trace.Tracer, serviceName, route string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract parent trace context from incoming headers
        ctx := otel.GetTextMapPropagator().Extract(
            r.Context(),
            propagation.HeaderCarrier(r.Header),
        )

        // Start a new span for this request
        spanName := fmt.Sprintf("%s %s", r.Method, route)
        ctx, span := tracer.Start(ctx, spanName,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.HTTPMethod(r.Method),
                semconv.HTTPURL(r.URL.String()),
                semconv.HTTPTarget(r.URL.Path),
                semconv.HTTPScheme(r.URL.Scheme),
                semconv.NetHostName(r.Host),
            ),
        )
        defer span.End()

        // Inject trace context into response headers for client-side correlation
        otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(w.Header()))

        rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
        next.ServeHTTP(rw, r.WithContext(ctx))

        span.SetAttributes(semconv.HTTPStatusCode(rw.status))
        if rw.status >= 500 {
            span.SetStatus(codes.Error, http.StatusText(rw.status))
        }
    })
}
```

## Complete Example: Payment Service

```go
// example/main.go
package main

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"

    "myorg/chassis"
    "myorg/chassis/health"
    "myorg/chassis/logging"
)

type PaymentRequest struct {
    OrderID  string  `json:"order_id"`
    Amount   float64 `json:"amount"`
    Currency string  `json:"currency"`
}

type PaymentResponse struct {
    TransactionID string `json:"transaction_id"`
    Status        string `json:"status"`
}

func main() {
    cfg := chassis.DefaultConfig("payment-service", "v2.4.1")
    cfg.OTLPEndpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    cfg.TraceSampleRate = 0.1

    // Add readiness check for database
    cfg.ReadinessChecks = []health.Check{
        health.DatabaseCheck("postgres", db),
        health.HTTPCheck("payment-gateway", "https://gateway.example.com/health", nil),
    }

    srv, err := chassis.New(cfg)
    if err != nil {
        slog.Default().Error("failed to initialize chassis", "error", err)
        os.Exit(1)
    }

    // Register application routes
    srv.HandleFunc("POST /v1/payments", handlePayment(srv))
    srv.HandleFunc("GET /v1/payments/{id}", handleGetPayment(srv))

    if err := srv.Run(context.Background()); err != nil {
        slog.Default().Error("server error", "error", err)
        os.Exit(1)
    }
}

func handlePayment(srv *chassis.Server) http.HandlerFunc {
    tracer := otel.Tracer("payment-service")

    return func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        logger := logging.FromContext(ctx)

        // Start child span for business logic
        ctx, span := tracer.Start(ctx, "process-payment")
        defer span.End()

        var req PaymentRequest
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            logger.Warn("invalid request body", "error", err)
            http.Error(w, "invalid request", http.StatusBadRequest)
            span.SetStatus(codes.Error, "invalid request body")
            return
        }

        span.SetAttributes(
            attribute.String("order.id", req.OrderID),
            attribute.Float64("payment.amount", req.Amount),
            attribute.String("payment.currency", req.Currency),
        )

        logger.Info("processing payment",
            "order_id", req.OrderID,
            "amount", req.Amount,
            "currency", req.Currency,
        )

        // Business logic here...
        txID := fmt.Sprintf("tx-%d", time.Now().UnixNano())

        resp := PaymentResponse{
            TransactionID: txID,
            Status:        "completed",
        }

        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusCreated)
        json.NewEncoder(w).Encode(resp)
    }
}
```

## Kubernetes Deployment with All Probes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    spec:
      terminationGracePeriodSeconds: 60    # Must be > ShutdownTimeout
      containers:
      - name: payment-service
        image: <your-registry>/payment-service:v2.4.1
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics
        env:
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "otel-collector.observability:4317"
        - name: LOG_LEVEL
          value: "info"

        # Startup probe: allows longer initialization before liveness kicks in
        startupProbe:
          httpGet:
            path: /healthz/startup
            port: 8080
          failureThreshold: 30
          periodSeconds: 5    # 30 * 5s = 150s max startup time

        # Liveness: restarts the pod if this fails
        livenessProbe:
          httpGet:
            path: /healthz/live
            port: 8080
          initialDelaySeconds: 0
          periodSeconds: 10
          failureThreshold: 3
          timeoutSeconds: 5

        # Readiness: removes pod from load balancer rotation if this fails
        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 0
          periodSeconds: 5
          failureThreshold: 3
          timeoutSeconds: 5

        resources:
          requests:
            cpu: "500m"
            memory: 256Mi
          limits:
            cpu: "2"
            memory: 512Mi

        lifecycle:
          preStop:
            exec:
              # Give the load balancer time to stop routing before SIGTERM
              command: ["/bin/sh", "-c", "sleep 5"]
---
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: payments
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9090"
    prometheus.io/path: "/metrics"
spec:
  selector:
    app: payment-service
  ports:
  - name: http
    port: 80
    targetPort: 8080
  - name: metrics
    port: 9090
    targetPort: 9090
```

## Testing the Chassis

```go
// chassis_test.go
package chassis_test

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "myorg/chassis"
    "myorg/chassis/health"
)

func TestHealthEndpoints(t *testing.T) {
    cfg := chassis.DefaultConfig("test-service", "v1.0.0")
    cfg.HTTPAddr = "127.0.0.1:0"    // Random port
    cfg.MetricsAddr = "127.0.0.1:0"
    cfg.ReadinessChecks = []health.Check{
        health.NewCheck("always-healthy", func(ctx context.Context) error {
            return nil
        }),
    }

    srv, err := chassis.New(cfg)
    if err != nil {
        t.Fatal(err)
    }

    // Test readiness endpoint directly via httptest
    req := httptest.NewRequest(http.MethodGet, "/healthz/ready", nil)
    rw := httptest.NewRecorder()

    // Get the internal mux (add a test accessor method)
    srv.InternalHandler().ServeHTTP(rw, req)

    if rw.Code != http.StatusOK {
        t.Errorf("expected 200, got %d", rw.Code)
    }

    var resp map[string]interface{}
    json.NewDecoder(rw.Body).Decode(&resp)
    if resp["status"] != "healthy" {
        t.Errorf("expected healthy, got %v", resp["status"])
    }
}

func TestGracefulShutdown(t *testing.T) {
    cfg := chassis.DefaultConfig("test-service", "v1.0.0")
    cfg.HTTPAddr = "127.0.0.1:0"
    cfg.MetricsAddr = "127.0.0.1:0"
    cfg.ShutdownTimeout = 5 * time.Second

    srv, err := chassis.New(cfg)
    if err != nil {
        t.Fatal(err)
    }

    // Register a slow handler
    complete := make(chan struct{})
    srv.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
        <-complete
        w.WriteHeader(http.StatusOK)
    })

    ctx, cancel := context.WithCancel(context.Background())
    errCh := make(chan error, 1)
    go func() {
        errCh <- srv.Run(ctx)
    }()

    // Wait for server to start
    time.Sleep(100 * time.Millisecond)

    // Start a slow request
    go func() {
        http.Get("http://" + srv.Addr() + "/slow")
    }()
    time.Sleep(50 * time.Millisecond)

    // Trigger shutdown
    cancel()

    // Unblock the slow handler
    close(complete)

    // Verify shutdown completes within timeout
    select {
    case err := <-errCh:
        if err != nil && err != context.Canceled {
            t.Errorf("unexpected shutdown error: %v", err)
        }
    case <-time.After(6 * time.Second):
        t.Error("shutdown timed out")
    }
}
```

## Summary

This chassis provides a complete foundation for enterprise Go microservices. Key design decisions:

- Health checks run in parallel with a 5-second timeout, preventing slow checks from blocking the entire readiness response
- Shutdown is LIFO, ensuring that the HTTP server (registered first) is shut down last, giving application logic (registered later) time to complete its cleanup before the network layer drains
- Trace context is extracted at the outermost middleware layer and propagated through context, so any code that receives the request's context can start child spans without configuration
- Structured logging enriches every log line with the trace ID automatically, enabling log-trace correlation without any application code changes
- Metrics middleware uses pre-labeled counters and histograms; the `in_flight` gauge decrements on exit, preventing counter leaks from panics (the `defer` handles this correctly)
- The separate metrics port prevents metrics scraping from competing with application traffic for the same connection pool
