---
title: "Go Observability Stack: Prometheus Metrics, OpenTelemetry Traces, slog/zap Logs, Correlation IDs, and Exemplars"
date: 2031-12-12T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Observability", "Prometheus", "OpenTelemetry", "Distributed Tracing", "Logging", "slog", "zap", "Metrics"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production observability guide for Go services covering Prometheus metrics with custom collectors, OpenTelemetry distributed tracing with automatic context propagation, structured logging with slog and zap, correlation ID middleware, and exemplar linking between metrics and traces."
more_link: "yes"
url: "/go-observability-stack-prometheus-otel-slog-zap-correlation-exemplars-guide/"
---

The three pillars of observability — metrics, traces, and logs — are individually useful but become transformative when they are correlated. A spike on a Prometheus histogram leads you to the offending trace IDs via exemplars, which leads you to the structured logs with the same trace ID, which tells you exactly what the application was doing when latency spiked. This guide implements the complete correlated observability stack in Go: Prometheus metrics with exemplars, OpenTelemetry tracing with automatic context propagation, and structured logging with correlation IDs that link all three signals.

<!--more-->

# Go Observability Stack: Production Guide

## Dependency Setup

```go
// go.mod
module github.com/example/myservice

go 1.23

require (
    github.com/prometheus/client_golang v1.20.0
    go.opentelemetry.io/otel v1.29.0
    go.opentelemetry.io/otel/sdk v1.29.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.29.0
    go.opentelemetry.io/otel/propagation v1.29.0
    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.56.0
    go.uber.org/zap v1.27.0
    go.uber.org/zap/exp/zapslog v0.3.0
)
```

## Metrics: Prometheus with Custom Collectors

### Defining Application Metrics

```go
// internal/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// All application metrics in one place for discoverability

var (
    // HTTPRequestDuration tracks latency per endpoint with exemplar support
    HTTPRequestDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "myservice",
            Subsystem: "http",
            Name:      "request_duration_seconds",
            Help:      "HTTP request latency in seconds.",
            Buckets:   prometheus.ExponentialBuckets(0.0005, 2, 15),
            // NativeHistogramBucketFactor enables native histograms (Prometheus 2.40+)
            NativeHistogramBucketFactor:     1.1,
            NativeHistogramMaxBucketNumber:  100,
            NativeHistogramMinResetDuration: 1 * time.Hour,
        },
        []string{"method", "path", "status_code"},
    )

    // HTTPRequestsTotal tracks RPS by status code
    HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "myservice",
            Subsystem: "http",
            Name:      "requests_total",
            Help:      "Total HTTP requests processed.",
        },
        []string{"method", "path", "status_code"},
    )

    // DBQueryDuration tracks database query performance
    DBQueryDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "myservice",
            Subsystem: "db",
            Name:      "query_duration_seconds",
            Help:      "Database query execution time in seconds.",
            Buckets:   prometheus.ExponentialBuckets(0.0001, 2, 16),
        },
        []string{"operation", "table", "status"},
    )

    // ActiveConnections is a gauge for connection pool monitoring
    ActiveConnections = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Namespace: "myservice",
            Subsystem: "db",
            Name:      "active_connections",
            Help:      "Number of active database connections.",
        },
        []string{"pool"},
    )

    // BusinessMetricOrdersProcessed is a domain-specific counter
    BusinessMetricOrdersProcessed = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "myservice",
            Subsystem: "orders",
            Name:      "processed_total",
            Help:      "Total orders processed by status.",
        },
        []string{"status", "payment_method"},
    )

    // CacheHitRate tracks cache effectiveness
    CacheOperations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "myservice",
            Subsystem: "cache",
            Name:      "operations_total",
            Help:      "Cache operations by result.",
        },
        []string{"operation", "result"}, // result: hit, miss, error
    )
)

func init() {
    prometheus.MustRegister(HTTPRequestDuration)
}
```

### HTTP Middleware with Metrics and Exemplars

Exemplars link a specific histogram observation to a trace ID, enabling "jump from metric to trace":

```go
// internal/middleware/observability.go
package middleware

import (
    "fmt"
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    dto "github.com/prometheus/client_model/go"
    "go.opentelemetry.io/otel/trace"

    "github.com/example/myservice/internal/metrics"
)

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
    http.ResponseWriter
    statusCode    int
    bytesWritten  int
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
    return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
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

// MetricsMiddleware records HTTP metrics with trace exemplars
func MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rw := newResponseWriter(w)

        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        statusCode := strconv.Itoa(rw.statusCode)

        // Normalize path to avoid high cardinality
        // In production, use a router-aware path template
        path := r.URL.Path

        // Record with exemplar if there's an active trace
        span := trace.SpanFromContext(r.Context())
        if span.SpanContext().IsValid() {
            traceID := span.SpanContext().TraceID().String()
            spanID := span.SpanContext().SpanID().String()

            // ObserveWithExemplar attaches trace ID to this specific observation
            (metrics.HTTPRequestDuration.With(prometheus.Labels{
                "method":      r.Method,
                "path":        path,
                "status_code": statusCode,
            }).(prometheus.ExemplarObserver)).ObserveWithExemplar(
                duration,
                prometheus.Labels{
                    "traceID": traceID,
                    "spanID":  spanID,
                },
            )
        } else {
            metrics.HTTPRequestDuration.With(prometheus.Labels{
                "method":      r.Method,
                "path":        path,
                "status_code": statusCode,
            }).Observe(duration)
        }

        metrics.HTTPRequestsTotal.With(prometheus.Labels{
            "method":      r.Method,
            "path":        path,
            "status_code": statusCode,
        }).Inc()
    })
}
```

## Tracing: OpenTelemetry with OTLP Export

### Tracer Initialization

```go
// internal/tracing/provider.go
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
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    CollectorAddr  string  // e.g., "otel-collector.monitoring.svc.cluster.local:4317"
    SampleRate     float64 // 0.0 to 1.0
}

func InitProvider(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    // Create gRPC connection to OTLP collector
    conn, err := grpc.NewClient(
        cfg.CollectorAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("create gRPC connection: %w", err)
    }

    // Create OTLP trace exporter
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
        otlptracegrpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("create trace exporter: %w", err)
    }

    // Resource describes this service instance
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithProcess(),
        resource.WithHost(),
        resource.WithFromEnv(), // Reads OTEL_RESOURCE_ATTRIBUTES from env
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
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

    // Use ParentBased so we respect upstream sampling decisions
    sampler = sdktrace.ParentBased(sampler)

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    // Set global tracer provider and propagator
    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},  // W3C TraceContext
        propagation.Baggage{},       // W3C Baggage
    ))

    // Return shutdown function
    return tp.Shutdown, nil
}
```

### Tracing Middleware for HTTP Services

```go
// internal/middleware/tracing.go
package middleware

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

// TracingMiddleware wraps HTTP handlers with OpenTelemetry tracing
func TracingMiddleware(serviceName string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return otelhttp.NewHandler(next, serviceName,
            otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
                // Use HTTP method + path template as span name
                // e.g., "GET /api/v1/orders/{id}"
                return r.Method + " " + r.URL.Path
            }),
            otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
        )
    }
}

// AddCustomSpanAttributes adds business context to the current span
func AddOrderAttributes(ctx context.Context, orderID, customerID string) {
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(
        attribute.String("order.id", orderID),
        attribute.String("customer.id", customerID),
        attribute.String("order.service", "payment"),
    )
}

// SpanFromContext returns the span in the context, or a no-op span
func RecordError(ctx context.Context, err error) {
    if err == nil {
        return
    }
    span := trace.SpanFromContext(ctx)
    span.RecordError(err)
}
```

### Database Tracing Wrapper

```go
// internal/store/traced_db.go
package store

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"

    "github.com/example/myservice/internal/metrics"
)

type TracedDB struct {
    db     *sql.DB
    tracer trace.Tracer
}

func NewTracedDB(db *sql.DB) *TracedDB {
    return &TracedDB{
        db:     db,
        tracer: otel.Tracer("myservice/db"),
    }
}

func (t *TracedDB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
    ctx, span := t.tracer.Start(ctx, "db.query",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.statement", sanitizeQuery(query)),
        ),
    )
    defer span.End()

    start := time.Now()
    rows, err := t.db.QueryContext(ctx, query, args...)
    duration := time.Since(start)

    status := "success"
    if err != nil {
        status = "error"
        span.SetStatus(codes.Error, err.Error())
        span.RecordError(err)
    }

    // Record metric with exemplar
    traceID := span.SpanContext().TraceID().String()
    (metrics.DBQueryDuration.With(prometheus.Labels{
        "operation": "query",
        "table":     extractTable(query),
        "status":    status,
    }).(prometheus.ExemplarObserver)).ObserveWithExemplar(
        duration.Seconds(),
        prometheus.Labels{"traceID": traceID},
    )

    return rows, err
}

// sanitizeQuery removes parameter values to prevent PII in traces
func sanitizeQuery(q string) string {
    // In production, use a SQL parser; this is a simplified version
    if len(q) > 200 {
        return q[:200] + "..."
    }
    return q
}

func extractTable(q string) string {
    // Very simplified table extraction; use sqlparser in production
    return "unknown"
}
```

## Logging: Structured Logging with slog and zap

### slog with Trace Context Integration

Go 1.21's `log/slog` is the standard for new services:

```go
// internal/logging/logger.go
package logging

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/otel/trace"
)

// TraceHandler wraps a slog.Handler to automatically add trace/span IDs
type TraceHandler struct {
    inner slog.Handler
}

func NewTraceHandler(inner slog.Handler) *TraceHandler {
    return &TraceHandler{inner: inner}
}

func (h *TraceHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.inner.Enabled(ctx, level)
}

func (h *TraceHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract trace context if present
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
            slog.Bool("trace_sampled", span.SpanContext().IsSampled()),
        )
    }

    // Add correlation ID from context if present
    if cid, ok := ctx.Value(correlationIDKey{}).(string); ok && cid != "" {
        r.AddAttrs(slog.String("correlation_id", cid))
    }

    return h.inner.Handle(ctx, r)
}

func (h *TraceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &TraceHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *TraceHandler) WithGroup(name string) slog.Handler {
    return &TraceHandler{inner: h.inner.WithGroup(name)}
}

type correlationIDKey struct{}

// WithCorrelationID adds a correlation ID to the context
func WithCorrelationID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, correlationIDKey{}, id)
}

// CorrelationIDFromContext extracts the correlation ID from context
func CorrelationIDFromContext(ctx context.Context) string {
    id, _ := ctx.Value(correlationIDKey{}).(string)
    return id
}

// NewLogger creates a production slog logger with trace and JSON output
func NewLogger(level slog.Level, service, version string) *slog.Logger {
    jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: level,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Rename time key to @timestamp for ELK compatibility
            if a.Key == slog.TimeKey {
                a.Key = "@timestamp"
            }
            // Rename msg to message for Loki compatibility
            if a.Key == slog.MessageKey {
                a.Key = "message"
            }
            return a
        },
    })

    traceHandler := NewTraceHandler(jsonHandler)

    return slog.New(traceHandler).With(
        "service", service,
        "version", version,
    )
}
```

### zap Integration with OpenTelemetry

For services that already use zap:

```go
// internal/logging/zap_otel.go
package logging

import (
    "context"

    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
    "go.uber.org/zap/exp/zapslog"
)

// NewZapLogger creates a production zap logger with OpenTelemetry integration
func NewZapLogger(service, version string) (*zap.Logger, error) {
    cfg := zap.NewProductionConfig()
    cfg.OutputPaths = []string{"stdout"}
    cfg.ErrorOutputPaths = []string{"stderr"}

    logger, err := cfg.Build(
        zap.Fields(
            zap.String("service", service),
            zap.String("version", version),
        ),
    )
    if err != nil {
        return nil, err
    }

    return logger, nil
}

// ZapFromContext returns a zap.Logger with trace context fields
func ZapFromContext(ctx context.Context, base *zap.Logger) *zap.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        return base
    }

    return base.With(
        zap.String("trace_id", span.SpanContext().TraceID().String()),
        zap.String("span_id", span.SpanContext().SpanID().String()),
        zap.Bool("trace_sampled", span.SpanContext().IsSampled()),
    )
}

// ZapSlogBridge creates a slog.Logger backed by zap (for libraries using slog)
func ZapSlogBridge(zapLogger *zap.Logger) *slog.Logger {
    return slog.New(zapslog.NewHandler(zapLogger.Core(), nil))
}
```

## Correlation ID Middleware

```go
// internal/middleware/correlation.go
package middleware

import (
    "net/http"

    "github.com/google/uuid"
    "go.opentelemetry.io/otel/baggage"
    "go.opentelemetry.io/otel/trace"

    "github.com/example/myservice/internal/logging"
)

const (
    correlationIDHeader = "X-Correlation-ID"
    requestIDHeader     = "X-Request-ID"
)

// CorrelationIDMiddleware extracts or generates a correlation ID
// and adds it to the context, response headers, and OTEL baggage
func CorrelationIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract or generate correlation ID
        correlationID := r.Header.Get(correlationIDHeader)
        if correlationID == "" {
            // Fall back to trace ID from existing span (set by TracingMiddleware)
            span := trace.SpanFromContext(ctx)
            if span.SpanContext().IsValid() {
                correlationID = span.SpanContext().TraceID().String()
            } else {
                correlationID = uuid.NewString()
            }
        }

        // Generate request-scoped ID (different from correlation ID)
        requestID := r.Header.Get(requestIDHeader)
        if requestID == "" {
            requestID = uuid.NewString()
        }

        // Add to context for logging
        ctx = logging.WithCorrelationID(ctx, correlationID)

        // Add to OTEL baggage (propagated to downstream services)
        bag, _ := baggage.Parse(fmt.Sprintf(
            "correlation_id=%s,request_id=%s",
            correlationID, requestID,
        ))
        ctx = baggage.ContextWithBaggage(ctx, bag)

        // Echo back in response headers
        w.Header().Set(correlationIDHeader, correlationID)
        w.Header().Set(requestIDHeader, requestID)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// PropagateCorrelationToOutbound adds correlation headers to outgoing HTTP requests
func PropagateCorrelationToOutbound(ctx context.Context, req *http.Request) {
    correlationID := logging.CorrelationIDFromContext(ctx)
    if correlationID != "" {
        req.Header.Set(correlationIDHeader, correlationID)
    }

    // otelhttp.Transport handles W3C trace context propagation automatically
}
```

## Wiring Everything Together

```go
// cmd/api/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/prometheus/client_golang/prometheus/promhttp"

    "github.com/example/myservice/internal/logging"
    "github.com/example/myservice/internal/middleware"
    "github.com/example/myservice/internal/tracing"
)

func main() {
    // Initialize logger
    log := logging.NewLogger(slog.LevelInfo, "myservice", "v1.0.0")
    slog.SetDefault(log)

    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    // Initialize OpenTelemetry
    shutdownTracing, err := tracing.InitProvider(ctx, tracing.Config{
        ServiceName:    "myservice",
        ServiceVersion: "v1.0.0",
        Environment:    os.Getenv("ENVIRONMENT"),
        CollectorAddr:  os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:     0.1, // Sample 10% in production
    })
    if err != nil {
        log.Error("init tracing", "err", err)
        os.Exit(1)
    }
    defer shutdownTracing(context.Background())

    // Build router with middleware stack
    r := chi.NewRouter()

    // Order matters: tracing first (creates span), then correlation, then metrics
    r.Use(middleware.TracingMiddleware("myservice").Middleware)
    r.Use(middleware.CorrelationIDMiddleware)
    r.Use(middleware.MetricsMiddleware)
    r.Use(middleware.RecoveryMiddleware(log))

    // Application routes
    r.Get("/api/v1/orders/{id}", handleGetOrder(log))
    r.Post("/api/v1/orders", handleCreateOrder(log))

    // Observability endpoints (on separate port in production)
    r.Get("/health/ready", handleHealthReady)
    r.Get("/health/live", handleHealthLive)

    // Prometheus metrics — enable exemplars via OpenMetrics content type
    r.Handle("/metrics", promhttp.HandlerFor(
        prometheus.DefaultGatherer,
        promhttp.HandlerOpts{
            EnableOpenMetrics: true, // Required for exemplar support
        },
    ))

    server := &http.Server{
        Addr:         ":8080",
        Handler:      r,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    go func() {
        log.Info("starting HTTP server", "addr", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Error("HTTP server failed", "err", err)
        }
    }()

    <-ctx.Done()
    log.Info("shutting down gracefully")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Error("graceful shutdown failed", "err", err)
    }
}

func handleGetOrder(log *slog.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        orderID := chi.URLParam(r, "id")

        // Child span for business logic
        ctx, span := otel.Tracer("myservice").Start(ctx, "GetOrder")
        defer span.End()

        // Add business context to span
        span.SetAttributes(attribute.String("order.id", orderID))

        // Logger with trace context is automatically enriched
        log.InfoContext(ctx, "handling get order request", "order_id", orderID)

        // ... business logic ...

        log.InfoContext(ctx, "order retrieved successfully", "order_id", orderID)
    }
}
```

## Grafana Dashboard Linking

```json
{
  "panels": [
    {
      "title": "Request Latency P99 (with Exemplars)",
      "type": "timeseries",
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum(rate(myservice_http_request_duration_seconds_bucket[5m])) by (le, path))",
          "legendFormat": "{{path}}"
        }
      ],
      "options": {
        "exemplars": {
          "enabled": true,
          "color": "rgba(255, 0, 255, 1)",
          "labelFields": ["traceID"]
        }
      },
      "links": [
        {
          "title": "View in Tempo",
          "url": "/explore?datasource=Tempo&left={\"queries\":[{\"queryType\":\"traceql\",\"query\":\"{trace.id=\\\"${__data.fields.traceID}\\\"}\"  }]}",
          "targetBlank": true
        }
      ]
    }
  ]
}
```

## Alerting with Trace Sampling Awareness

```yaml
# PrometheusRule: rate-based alerts that link to traces
groups:
  - name: myservice-slos
    rules:
      - alert: HighErrorRate
        expr: >
          (
            rate(myservice_http_requests_total{status_code=~"5.."}[5m])
            / rate(myservice_http_requests_total[5m])
          ) > 0.01
        for: 5m
        labels:
          severity: critical
          service: myservice
        annotations:
          summary: "High error rate: {{ $value | humanizePercentage }}"
          description: >
            Error rate above 1% for 5 minutes.
            Check traces at Tempo with filter: { service.name="myservice" && status=error }
            Logs: {service="myservice", level="error"}

      - alert: HighLatencyP99
        expr: >
          histogram_quantile(0.99,
            sum(rate(myservice_http_request_duration_seconds_bucket{path!="/health/ready"}[5m]))
          by (le, path)) > 1.0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "P99 latency above 1s for {{ $labels.path }}"
```

## Production Checklist

```bash
# Verify exemplars are being returned by Prometheus
curl -s -H "Accept: application/openmetrics-text" \
  http://myservice.production.svc.cluster.local/metrics | \
  grep -A5 "# TYPE myservice_http_request_duration"

# Expected exemplar in output:
# myservice_http_request_duration_seconds_bucket{...} 42 # {traceID="abc123..."} 0.234 1733011200.000

# Verify trace context propagation
curl -s http://myservice.production.svc.cluster.local/api/v1/orders/1 \
  -H "traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" \
  -v 2>&1 | grep -E "traceparent|X-Correlation"

# Check OTLP export is working
kubectl -n production exec deploy/myservice -- \
  wget -qO- http://otel-collector.monitoring.svc.cluster.local:8888/metrics | \
  grep otelcol_exporter_sent_spans
```

## Summary

The complete Go observability stack connects three signal types through shared identifiers. Prometheus exemplars embed trace IDs directly in histogram observations, enabling one-click navigation from a latency spike on a dashboard to the specific traces that caused it. OpenTelemetry's W3C TraceContext propagation ensures trace IDs are consistent across service boundaries, and baggage propagation carries correlation IDs to downstream services. Structured logging with the `TraceHandler` automatically enriches every log entry with `trace_id` and `span_id`, making log queries by trace ID instant. The critical implementation detail is middleware order: tracing middleware must run first to create the span, then correlation ID middleware can extract the trace ID from the span context, and then metrics middleware can attach the trace ID as an exemplar to the histogram observation.
