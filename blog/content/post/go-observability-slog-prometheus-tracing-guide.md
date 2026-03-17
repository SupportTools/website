---
title: "Go Observability Patterns: Structured Logging with slog, Prometheus Metrics, and Distributed Tracing"
date: 2028-07-09T00:00:00-05:00
draft: false
tags: ["Go", "slog", "Prometheus", "OpenTelemetry", "Observability", "Logging"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing production observability in Go using the standard library slog package, Prometheus custom metrics, and OpenTelemetry distributed tracing with trace-log correlation."
more_link: "yes"
url: "/go-observability-slog-prometheus-tracing-guide/"
---

Go 1.21 introduced `log/slog` — a structured logging package in the standard library that ends the debate between zerolog, zap, and logrus for most applications. Combined with the Prometheus client library and OpenTelemetry's Go SDK, modern Go applications can achieve full observability with minimal dependencies and predictable performance.

This guide builds a complete observability stack from scratch: structured logging with dynamic log levels and trace correlation, custom Prometheus metrics with exemplars, distributed tracing with OpenTelemetry, and the infrastructure that ties everything together into a coherent picture of system behavior.

<!--more-->

# Go Observability Patterns: slog, Prometheus, and OpenTelemetry

## Section 1: Structured Logging with slog

### The slog Architecture

`slog` separates two concerns:

1. **Logger**: The frontend API that your code calls. It accepts log records and forwards them to a Handler.
2. **Handler**: The backend that formats and writes log records. You can use the built-in `TextHandler` and `JSONHandler`, or implement your own.

```go
// pkg/logging/logging.go
package logging

import (
    "context"
    "io"
    "log/slog"
    "os"
    "runtime"
    "sync/atomic"
    "time"
)

// LevelVar allows dynamic log level changes at runtime
var defaultLevel = new(slog.LevelVar)

// New creates a configured logger for production use
func New(w io.Writer, opts ...Option) *slog.Logger {
    cfg := defaultConfig()
    for _, opt := range opts {
        opt(cfg)
    }

    handlerOpts := &slog.HandlerOptions{
        Level:     cfg.level,
        AddSource: cfg.addSource,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Rename "msg" to "message" for Elasticsearch/Loki compatibility
            if a.Key == slog.MessageKey {
                a.Key = "message"
            }
            // Format time as RFC3339 instead of default
            if a.Key == slog.TimeKey {
                if t, ok := a.Value.Any().(time.Time); ok {
                    a.Value = slog.StringValue(t.UTC().Format(time.RFC3339Nano))
                }
            }
            // Add source location
            if a.Key == slog.SourceKey {
                if src, ok := a.Value.Any().(*slog.Source); ok {
                    a.Value = slog.StringValue(fmt.Sprintf("%s:%d", src.File, src.Line))
                }
            }
            return a
        },
    }

    var handler slog.Handler
    if cfg.json {
        handler = slog.NewJSONHandler(w, handlerOpts)
    } else {
        handler = slog.NewTextHandler(w, handlerOpts)
    }

    // Wrap with our custom handler for trace correlation
    handler = &correlatingHandler{inner: handler}

    return slog.New(handler)
}

// SetLevel changes the log level at runtime
func SetLevel(level slog.Level) {
    defaultLevel.Set(level)
}

// ParseAndSetLevel parses a level string and sets it
func ParseAndSetLevel(levelStr string) error {
    var level slog.Level
    if err := level.UnmarshalText([]byte(levelStr)); err != nil {
        return fmt.Errorf("invalid log level %q: %w", levelStr, err)
    }
    SetLevel(level)
    return nil
}

type config struct {
    level     slog.Leveler
    json      bool
    addSource bool
}

func defaultConfig() *config {
    defaultLevel.Set(slog.LevelInfo)
    return &config{
        level:     defaultLevel,
        json:      true,
        addSource: false,
    }
}

type Option func(*config)

func WithLevel(l slog.Level) Option {
    return func(c *config) { defaultLevel.Set(l) }
}

func WithJSON(json bool) Option {
    return func(c *config) { c.json = json }
}

func WithSource(source bool) Option {
    return func(c *config) { c.addSource = source }
}
```

### Trace Correlation Handler

The key to unified observability is correlating log entries with the distributed trace that generated them:

```go
// pkg/logging/correlating_handler.go
package logging

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

const (
    traceIDKey  = "trace_id"
    spanIDKey   = "span_id"
    traceFlags  = "trace_flags"
    serviceName = "service_name"
)

// correlatingHandler extracts trace context and adds it to every log record
type correlatingHandler struct {
    inner slog.Handler
}

func (h *correlatingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.inner.Enabled(ctx, level)
}

func (h *correlatingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract OpenTelemetry span context
    if span := trace.SpanFromContext(ctx); span.SpanContext().IsValid() {
        sc := span.SpanContext()
        r.AddAttrs(
            slog.String(traceIDKey, sc.TraceID().String()),
            slog.String(spanIDKey, sc.SpanID().String()),
            slog.Int(traceFlags+"_sampled", int(sc.TraceFlags())),
        )
    }

    // Extract request ID from context
    if reqID := RequestIDFromContext(ctx); reqID != "" {
        r.AddAttrs(slog.String("request_id", reqID))
    }

    // Extract user ID from context
    if userID := UserIDFromContext(ctx); userID != "" {
        r.AddAttrs(slog.String("user_id", userID))
    }

    return h.inner.Handle(ctx, r)
}

func (h *correlatingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &correlatingHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *correlatingHandler) WithGroup(name string) slog.Handler {
    return &correlatingHandler{inner: h.inner.WithGroup(name)}
}

// Context key types
type contextKeyType struct{ name string }

var (
    requestIDKey = &contextKeyType{"request_id"}
    userIDKey    = &contextKeyType{"user_id"}
)

func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

func RequestIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey).(string); ok {
        return id
    }
    return ""
}

func WithUserID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, userIDKey, id)
}

func UserIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(userIDKey).(string); ok {
        return id
    }
    return ""
}
```

### Dynamic Log Level via HTTP Endpoint

```go
// pkg/logging/admin.go
package logging

import (
    "encoding/json"
    "log/slog"
    "net/http"
)

// LevelHandler returns an HTTP handler that allows runtime log level changes
func LevelHandler() http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.Method {
        case http.MethodGet:
            w.Header().Set("Content-Type", "application/json")
            json.NewEncoder(w).Encode(map[string]string{
                "level": defaultLevel.Level().String(),
            })

        case http.MethodPut:
            var req struct {
                Level string `json:"level"`
            }
            if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                http.Error(w, "invalid JSON", http.StatusBadRequest)
                return
            }
            if err := ParseAndSetLevel(req.Level); err != nil {
                http.Error(w, err.Error(), http.StatusBadRequest)
                return
            }
            slog.Info("log level changed", "new_level", req.Level)
            w.WriteHeader(http.StatusOK)

        default:
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        }
    })
}
```

### Using the Logger in Application Code

```go
// Example HTTP handler with structured logging
package handler

import (
    "log/slog"
    "net/http"
    "time"
)

type OrderHandler struct {
    logger  *slog.Logger
    service OrderService
}

func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := h.logger.With(
        "endpoint", "create_order",
        "method", r.Method,
    )

    start := time.Now()

    var req CreateOrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        log.WarnContext(ctx, "invalid request body",
            "error", err,
            "content_type", r.Header.Get("Content-Type"),
        )
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    log = log.With("order_items", len(req.Items), "customer_id", req.CustomerID)
    log.InfoContext(ctx, "processing order")

    order, err := h.service.Create(ctx, req)
    if err != nil {
        log.ErrorContext(ctx, "order creation failed",
            "error", err,
            "duration_ms", time.Since(start).Milliseconds(),
        )
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    log.InfoContext(ctx, "order created",
        "order_id", order.ID,
        "total_amount", order.Total,
        "duration_ms", time.Since(start).Milliseconds(),
    )

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(order)
}
```

## Section 2: Prometheus Metrics

### Custom Metrics Package

```go
// pkg/metrics/metrics.go
package metrics

import (
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

// HTTPMetrics provides standard HTTP server metrics
type HTTPMetrics struct {
    requestDuration *prometheus.HistogramVec
    requestsTotal   *prometheus.CounterVec
    requestsInFlight prometheus.Gauge
    responseSize    *prometheus.HistogramVec
}

func NewHTTPMetrics(subsystem string) *HTTPMetrics {
    return &HTTPMetrics{
        requestDuration: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: "app",
                Subsystem: subsystem,
                Name:      "http_request_duration_seconds",
                Help:      "HTTP request latency distribution",
                Buckets:   []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
                // Enable native histograms (Prometheus 2.40+)
                NativeHistogramBucketFactor: 1.1,
            },
            []string{"method", "path", "status"},
        ),
        requestsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: "app",
                Subsystem: subsystem,
                Name:      "http_requests_total",
                Help:      "Total number of HTTP requests",
            },
            []string{"method", "path", "status"},
        ),
        requestsInFlight: promauto.NewGauge(prometheus.GaugeOpts{
            Namespace: "app",
            Subsystem: subsystem,
            Name:      "http_requests_in_flight",
            Help:      "Current number of in-flight HTTP requests",
        }),
        responseSize: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: "app",
                Subsystem: subsystem,
                Name:      "http_response_size_bytes",
                Help:      "HTTP response size distribution",
                Buckets:   prometheus.ExponentialBuckets(100, 10, 6),
            },
            []string{"method", "path"},
        ),
    }
}

// Middleware wraps an HTTP handler with metrics collection
func (m *HTTPMetrics) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        m.requestsInFlight.Inc()
        defer m.requestsInFlight.Dec()

        path := normalizePath(r.URL.Path)
        start := time.Now()

        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        status := fmt.Sprintf("%d", rw.statusCode)

        m.requestDuration.WithLabelValues(r.Method, path, status).Observe(duration)
        m.requestsTotal.WithLabelValues(r.Method, path, status).Inc()
        m.responseSize.WithLabelValues(r.Method, path).Observe(float64(rw.bytesWritten))
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode   int
    bytesWritten int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += n
    return n, err
}

// normalizePath prevents high-cardinality by replacing path parameters
func normalizePath(path string) string {
    // Replace UUIDs with {id}
    re := regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
    path = re.ReplaceAllString(path, "{uuid}")

    // Replace numeric IDs
    re2 := regexp.MustCompile(`/\d+(/|$)`)
    path = re2.ReplaceAllString(path, "/{id}$1")

    return path
}
```

### Business Metrics

```go
// pkg/metrics/business.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// OrderMetrics tracks business-level order metrics
type OrderMetrics struct {
    ordersCreated   *prometheus.CounterVec
    orderValue      *prometheus.HistogramVec
    orderProcessing *prometheus.HistogramVec
    orderErrors     *prometheus.CounterVec
    queueDepth      prometheus.Gauge
}

var Order = &OrderMetrics{
    ordersCreated: promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "orders_created_total",
            Help: "Total orders created",
        },
        []string{"status", "payment_method", "region"},
    ),
    orderValue: promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "order_value_dollars",
            Help:    "Distribution of order values",
            Buckets: []float64{5, 10, 25, 50, 100, 250, 500, 1000, 5000},
        },
        []string{"region"},
    ),
    orderProcessing: promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "order_processing_duration_seconds",
            Help:    "Time to process an order",
            Buckets: prometheus.DefBuckets,
        },
        []string{"payment_method"},
    ),
    orderErrors: promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "order_errors_total",
            Help: "Total order processing errors",
        },
        []string{"error_type", "payment_method"},
    ),
    queueDepth: promauto.NewGauge(prometheus.GaugeOpts{
        Name: "order_queue_depth",
        Help: "Current number of orders waiting to be processed",
    }),
}

func (m *OrderMetrics) RecordCreated(region, paymentMethod string, valueUSD float64) {
    m.ordersCreated.WithLabelValues("created", paymentMethod, region).Inc()
    m.orderValue.WithLabelValues(region).Observe(valueUSD)
}

func (m *OrderMetrics) RecordProcessed(paymentMethod string, duration time.Duration) {
    m.ordersCreated.WithLabelValues("processed", paymentMethod, "unknown").Inc()
    m.orderProcessing.WithLabelValues(paymentMethod).Observe(duration.Seconds())
}

func (m *OrderMetrics) RecordError(errorType, paymentMethod string) {
    m.orderErrors.WithLabelValues(errorType, paymentMethod).Inc()
}

func (m *OrderMetrics) SetQueueDepth(depth int) {
    m.queueDepth.Set(float64(depth))
}
```

### Exemplars for Trace-Metric Linking

Exemplars link Prometheus metrics to distributed traces, enabling jumping from a slow histogram bucket directly to the offending trace:

```go
// pkg/metrics/exemplar.go
package metrics

import (
    "context"

    "github.com/prometheus/client_golang/prometheus"
    "go.opentelemetry.io/otel/trace"
)

// ExemplarObserver wraps a histogram to add trace exemplars
type ExemplarObserver struct {
    hist *prometheus.HistogramVec
}

func NewExemplarObserver(hist *prometheus.HistogramVec) *ExemplarObserver {
    return &ExemplarObserver{hist: hist}
}

func (e *ExemplarObserver) ObserveWithContext(ctx context.Context, labels prometheus.Labels, value float64) {
    span := trace.SpanFromContext(ctx)

    observer := e.hist.With(labels)
    if span.SpanContext().IsValid() && span.SpanContext().IsSampled() {
        // Add trace exemplar
        if obs, ok := observer.(prometheus.ExemplarObserver); ok {
            obs.ObserveWithExemplar(value, prometheus.Labels{
                "traceID": span.SpanContext().TraceID().String(),
            })
            return
        }
    }
    observer.Observe(value)
}
```

## Section 3: OpenTelemetry Distributed Tracing

### Tracer Provider Setup

```go
// pkg/tracing/tracing.go
package tracing

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string  // "otel-collector:4317"
    SamplingRate   float64 // 0.0 to 1.0
}

// Setup initializes the OpenTelemetry tracer provider
// Returns a shutdown function that must be called on application exit
func Setup(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    // Create OTLP gRPC exporter
    conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to OTLP endpoint: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    // Define the service resource
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceNameKey.String(cfg.ServiceName),
            semconv.ServiceVersionKey.String(cfg.ServiceVersion),
            attribute.String("environment", cfg.Environment),
            semconv.DeploymentEnvironmentKey.String(cfg.Environment),
        ),
        resource.WithFromEnv(),   // OTEL_RESOURCE_ATTRIBUTES
        resource.WithProcess(),   // Process info
        resource.WithOS(),        // OS info
        resource.WithHost(),      // Hostname
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // Configure sampling
    var sampler sdktrace.Sampler
    if cfg.SamplingRate >= 1.0 {
        sampler = sdktrace.AlwaysSample()
    } else if cfg.SamplingRate <= 0.0 {
        sampler = sdktrace.NeverSample()
    } else {
        sampler = sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(cfg.SamplingRate),
        )
    }

    // Create the tracer provider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithMaxQueueSize(8192),
            sdktrace.WithBatchTimeout(5*time.Second),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    // Set as global provider
    otel.SetTracerProvider(tp)

    // Configure W3C TraceContext and Baggage propagation
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return func(ctx context.Context) error {
        if err := tp.Shutdown(ctx); err != nil {
            return fmt.Errorf("shutting down tracer provider: %w", err)
        }
        return conn.Close()
    }, nil
}
```

### HTTP Instrumentation Middleware

```go
// pkg/tracing/middleware.go
package tracing

import (
    "fmt"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

const tracerName = "myapp/http"

// Middleware adds OpenTelemetry tracing to HTTP handlers
func Middleware(serviceName string) func(http.Handler) http.Handler {
    tracer := otel.Tracer(tracerName)
    propagator := otel.GetTextMapPropagator()

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract trace context from incoming request
            ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

            // Start span
            spanName := fmt.Sprintf("%s %s", r.Method, normalizePath(r.URL.Path))
            ctx, span := tracer.Start(ctx, spanName,
                trace.WithSpanKind(trace.SpanKindServer),
                trace.WithAttributes(
                    semconv.HTTPMethodKey.String(r.Method),
                    semconv.HTTPURLKey.String(r.URL.String()),
                    semconv.HTTPSchemeKey.String(r.URL.Scheme),
                    semconv.HTTPTargetKey.String(r.URL.RequestURI()),
                    semconv.HTTPUserAgentKey.String(r.UserAgent()),
                    semconv.NetHostNameKey.String(r.Host),
                ),
            )
            defer span.End()

            // Inject trace ID into response headers (for client-side logging)
            if sc := span.SpanContext(); sc.IsValid() {
                w.Header().Set("X-Trace-ID", sc.TraceID().String())
            }

            rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
            next.ServeHTTP(rw, r.WithContext(ctx))

            // Record response attributes
            span.SetAttributes(
                semconv.HTTPStatusCodeKey.Int(rw.statusCode),
            )

            if rw.statusCode >= 500 {
                span.SetStatus(codes.Error, http.StatusText(rw.statusCode))
            } else if rw.statusCode >= 400 {
                span.SetStatus(codes.Error, http.StatusText(rw.statusCode))
            }
        })
    }
}
```

### Database Query Tracing

```go
// pkg/tracing/db.go
package tracing

import (
    "context"
    "database/sql/driver"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

// TracedDB wraps database operations with OpenTelemetry spans
type TracedDB struct {
    db     interface {
        QueryRowContext(ctx context.Context, query string, args ...interface{}) interface{ Scan(...interface{}) error }
        ExecContext(ctx context.Context, query string, args ...interface{}) (driver.Result, error)
    }
    tracer  trace.Tracer
    dbName  string
    dbSystem string
}

func NewTracedDB(db interface{}, dbName, dbSystem string) *TracedDB {
    return &TracedDB{
        tracer:   otel.Tracer("myapp/database"),
        dbName:   dbName,
        dbSystem: dbSystem,
    }
}

func (t *TracedDB) spanAttrs(operation, table, query string) []attribute.KeyValue {
    attrs := []attribute.KeyValue{
        semconv.DBSystemKey.String(t.dbSystem),
        semconv.DBNameKey.String(t.dbName),
        semconv.DBOperationKey.String(operation),
        attribute.String("db.table", table),
    }
    if query != "" {
        // Only include sanitized queries (remove values)
        attrs = append(attrs, semconv.DBStatementKey.String(sanitizeQuery(query)))
    }
    return attrs
}

func (t *TracedDB) startSpan(ctx context.Context, operation, table string) (context.Context, trace.Span) {
    return t.tracer.Start(ctx,
        fmt.Sprintf("%s %s", operation, table),
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(t.spanAttrs(operation, table, "")...),
    )
}

// sanitizeQuery removes values from SQL queries to prevent PII in traces
func sanitizeQuery(q string) string {
    // Simple implementation: truncate at 500 chars
    if len(q) > 500 {
        return q[:500] + "..."
    }
    return q
}
```

### HTTP Client Tracing

```go
// pkg/tracing/client.go
package tracing

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewHTTPClient creates an HTTP client with automatic trace propagation
func NewHTTPClient() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(
            http.DefaultTransport,
            otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
                return fmt.Sprintf("HTTP %s %s", r.Method, r.URL.Host)
            }),
        ),
        Timeout: 30 * time.Second,
    }
}
```

## Section 4: Putting It All Together

### Application Initialization

```go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "myapp/pkg/logging"
    "myapp/pkg/metrics"
    "myapp/pkg/tracing"

    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func main() {
    ctx, cancel := signal.NotifyContext(
        context.Background(),
        os.Interrupt, syscall.SIGTERM,
    )
    defer cancel()

    // Initialize structured logging
    logger := logging.New(os.Stdout,
        logging.WithJSON(true),
        logging.WithSource(true),
    )
    slog.SetDefault(logger)

    // Initialize tracing
    shutdown, err := tracing.Setup(ctx, tracing.Config{
        ServiceName:    "my-service",
        ServiceVersion: version,
        Environment:    os.Getenv("ENVIRONMENT"),
        OTLPEndpoint:   getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317"),
        SamplingRate:   0.1, // 10% sampling
    })
    if err != nil {
        logger.Error("failed to setup tracing", "error", err)
        os.Exit(1)
    }

    // Initialize metrics
    httpMetrics := metrics.NewHTTPMetrics("server")

    // Build the HTTP router
    mux := http.NewServeMux()
    mux.Handle("/api/", buildAPIRoutes(logger))
    mux.Handle("/metrics", promhttp.Handler())
    mux.Handle("/debug/loglevel", logging.LevelHandler())
    mux.HandleFunc("/health/live", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    mux.HandleFunc("/health/ready", buildReadinessCheck(logger))

    // Wrap with observability middleware
    handler := tracing.Middleware("my-service")(
        httpMetrics.Middleware(
            requestIDMiddleware(
                mux,
            ),
        ),
    )

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Start server
    go func() {
        logger.Info("starting HTTP server", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("HTTP server error", "error", err)
            cancel()
        }
    }()

    <-ctx.Done()
    logger.Info("shutting down")

    // Graceful shutdown
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    if err := srv.Shutdown(shutdownCtx); err != nil {
        logger.Error("HTTP server shutdown error", "error", err)
    }

    if err := shutdown(shutdownCtx); err != nil {
        logger.Error("tracing shutdown error", "error", err)
    }
}

func requestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        reqID := r.Header.Get("X-Request-ID")
        if reqID == "" {
            reqID = generateRequestID()
        }
        ctx := logging.WithRequestID(r.Context(), reqID)
        w.Header().Set("X-Request-ID", reqID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func generateRequestID() string {
    b := make([]byte, 8)
    rand.Read(b)
    return hex.EncodeToString(b)
}
```

## Section 5: Service Instrumentation Pattern

Consistent instrumentation across service methods using middleware patterns:

```go
// pkg/service/instrumented.go
package service

import (
    "context"
    "log/slog"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

// InstrumentedOrderService wraps OrderService with observability
type InstrumentedOrderService struct {
    inner  OrderService
    tracer trace.Tracer
    logger *slog.Logger
}

func NewInstrumentedOrderService(svc OrderService, logger *slog.Logger) *InstrumentedOrderService {
    return &InstrumentedOrderService{
        inner:  svc,
        tracer: otel.Tracer("myapp/orders"),
        logger: logger.With("component", "order_service"),
    }
}

func (s *InstrumentedOrderService) Create(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    ctx, span := s.tracer.Start(ctx, "OrderService.Create",
        trace.WithAttributes(
            attribute.Int("order.items_count", len(req.Items)),
            attribute.String("order.customer_id", req.CustomerID),
            attribute.String("order.payment_method", req.PaymentMethod),
        ),
    )
    defer span.End()

    start := time.Now()
    s.logger.InfoContext(ctx, "creating order",
        "customer_id", req.CustomerID,
        "items", len(req.Items),
    )

    order, err := s.inner.Create(ctx, req)
    duration := time.Since(start)

    metrics.Order.RecordProcessed(req.PaymentMethod, duration)

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        metrics.Order.RecordError(classifyError(err), req.PaymentMethod)
        s.logger.ErrorContext(ctx, "order creation failed",
            "error", err,
            "duration_ms", duration.Milliseconds(),
        )
        return nil, err
    }

    span.SetAttributes(
        attribute.String("order.id", order.ID),
        attribute.Float64("order.total_usd", order.Total),
    )
    metrics.Order.RecordCreated("us-east", req.PaymentMethod, order.Total)
    s.logger.InfoContext(ctx, "order created",
        "order_id", order.ID,
        "total", order.Total,
        "duration_ms", duration.Milliseconds(),
    )

    return order, nil
}

func classifyError(err error) string {
    switch {
    case errors.Is(err, ErrPaymentDeclined):
        return "payment_declined"
    case errors.Is(err, ErrInsufficientInventory):
        return "insufficient_inventory"
    case errors.Is(err, context.DeadlineExceeded):
        return "timeout"
    default:
        return "internal"
    }
}
```

## Section 6: Loki Integration for Log Aggregation

```yaml
# kubernetes/loki-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: promtail-config
  namespace: monitoring
data:
  promtail.yaml: |
    server:
      http_listen_port: 9080
    clients:
      - url: http://loki:3100/loki/api/v1/push
    scrape_configs:
    - job_name: kubernetes-pods
      kubernetes_sd_configs:
      - role: pod
      pipeline_stages:
      - cri: {}
      - json:
          expressions:
            level: level
            message: message
            trace_id: trace_id
            span_id: span_id
            request_id: request_id
      - labels:
          level:
          trace_id:
          request_id:
      - output:
          source: message
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
```

## Section 7: Testing Observability Code

```go
// pkg/logging/logging_test.go
package logging_test

import (
    "bytes"
    "context"
    "encoding/json"
    "log/slog"
    "testing"

    "myapp/pkg/logging"
    "go.opentelemetry.io/otel/trace"
)

func TestCorrelatingHandler(t *testing.T) {
    var buf bytes.Buffer
    logger := logging.New(&buf, logging.WithJSON(true))

    // Create a context with request ID
    ctx := logging.WithRequestID(context.Background(), "test-request-123")
    ctx = logging.WithUserID(ctx, "user-456")

    logger.InfoContext(ctx, "test message", "key", "value")

    // Parse the log output
    var entry map[string]interface{}
    if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
        t.Fatalf("parsing log entry: %v", err)
    }

    // Verify request ID was added
    if got := entry["request_id"]; got != "test-request-123" {
        t.Errorf("request_id: got %v, want test-request-123", got)
    }

    // Verify user ID was added
    if got := entry["user_id"]; got != "user-456" {
        t.Errorf("user_id: got %v, want user-456", got)
    }

    // Verify message field name
    if _, ok := entry["message"]; !ok {
        t.Error("expected 'message' field, not 'msg'")
    }
}

func TestDynamicLogLevel(t *testing.T) {
    var buf bytes.Buffer
    logger := logging.New(&buf,
        logging.WithLevel(slog.LevelWarn),
        logging.WithJSON(true),
    )

    // This should not be logged
    logger.Info("info message")
    if buf.Len() > 0 {
        t.Error("info message should not be logged at WARN level")
    }

    // Change level at runtime
    logging.SetLevel(slog.LevelInfo)

    // This should now be logged
    logger.Info("info message 2")
    if buf.Len() == 0 {
        t.Error("info message should be logged after level change")
    }
}
```

## Section 8: OpenTelemetry Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
    send_batch_max_size: 2048

  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

  resource:
    attributes:
    - key: deployment.environment
      from_attribute: environment
      action: insert
    - key: service.namespace
      value: production
      action: insert

  tail_sampling:
    decision_wait: 10s
    num_traces: 100
    expected_new_traces_per_sec: 10
    policies:
    - name: errors-policy
      type: status_code
      status_code: {status_codes: [ERROR]}
    - name: slow-traces-policy
      type: latency
      latency: {threshold_ms: 500}
    - name: probabilistic-policy
      type: probabilistic
      probabilistic: {sampling_percentage: 10}

exporters:
  jaeger:
    endpoint: jaeger-collector:14250
    tls:
      insecure: true

  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: otel

  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [jaeger]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [prometheus]
```

## Conclusion

The observability stack described here — `slog` with trace correlation, Prometheus with exemplars, and OpenTelemetry with tail sampling — gives you the ability to answer "why is this request slow?" without requiring log rotation through multiple systems. The trace ID flowing from the HTTP response header through the access logs into the distributed trace makes cross-system debugging a single click in Grafana rather than a multi-hour investigation.

The investment in the `InstrumentedService` wrapper pattern pays dividends when performance problems emerge: every service method has duration histograms, error counters, and span attributes that tell the complete story. The `slog.LevelVar` pattern for dynamic log levels allows operators to temporarily increase verbosity in production without redeployment.
