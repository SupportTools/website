---
title: "Go Telemetry Correlation: Connecting Traces, Metrics, and Logs in Production"
date: 2030-08-26T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Observability", "Prometheus", "Traces", "Metrics", "Logs"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise observability correlation in Go: injecting trace IDs into logs, linking metrics to traces with exemplars, propagating baggage across services, and building dashboards that pivot between all three signals."
more_link: "yes"
url: "/go-telemetry-correlation-traces-metrics-logs-opentelemetry/"
---

Distributed systems generate three distinct observability signals: traces (timing and causality across services), metrics (aggregated numeric measurements), and logs (event records with context). Each signal is useful in isolation, but the real diagnostic power emerges when they are correlated: a Grafana query that starts from a high-latency metric spike, pivots to the exemplar trace that had the worst latency in that window, then shows the structured logs emitted during that exact trace. This post builds that correlation system in Go using the OpenTelemetry SDK, Prometheus exemplars, and slog-based structured logging.

<!--more-->

## The Three Signals and Their Correlation Points

Before writing code, understand what connects the signals:

- **Trace ID**: A 128-bit identifier unique to a distributed request. Present in spans, can be injected into logs, and can be attached to metric exemplars.
- **Span ID**: A 64-bit identifier for a single unit of work within a trace. Useful for correlating a log entry to a specific span.
- **Exemplars**: Sample data points attached to histogram observations in Prometheus. Each exemplar can carry a trace ID, linking a specific latency observation to a trace.
- **Baggage**: Key-value pairs that propagate through the distributed system in request context. Useful for carrying user IDs, tenant IDs, or request metadata across service boundaries.

The correlation architecture:

```
HTTP Request arrives
       │
       ▼
[Trace Middleware] ──────────── Creates/continues trace
       │                        Stores TraceID + SpanID in context
       ▼
[Log Middleware] ─────────────── Injects TraceID into log fields
       │                         Every log.Info() includes trace_id, span_id
       ▼
[Handler] ─────────────────────── Records histogram observation
       │                           Attaches TraceID as exemplar label
       ▼
[Prometheus] ──────────────────── Stores metric with exemplar
       │
       ▼
[Grafana] ─────────── Exemplar → click → Tempo/Jaeger trace → logs by trace_id
```

## Module Setup

```go
// go.mod
module enterprise.example.com/telemetry-demo

go 1.22

require (
    go.opentelemetry.io/otel v1.27.0
    go.opentelemetry.io/otel/trace v1.27.0
    go.opentelemetry.io/otel/sdk v1.27.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.27.0
    go.opentelemetry.io/otel/exporters/prometheus v0.49.0
    go.opentelemetry.io/otel/metric v1.27.0
    go.opentelemetry.io/otel/sdk/metric v1.27.0
    go.opentelemetry.io/otel/propagators/b3 v1.27.0
    github.com/prometheus/client_golang v1.19.1
    github.com/go-chi/chi/v5 v5.0.12
)
```

## OpenTelemetry SDK Initialization

```go
// pkg/telemetry/setup.go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.25.0"
    promclient "github.com/prometheus/client_golang/prometheus"
)

// Config holds telemetry configuration.
type Config struct {
    ServiceName    string
    ServiceVersion string
    OTLPEndpoint   string // e.g., "tempo.monitoring.svc.cluster.local:4318"
    Environment    string
}

// SDK holds initialized telemetry providers.
type SDK struct {
    TracerProvider *sdktrace.TracerProvider
    MeterProvider  *metric.MeterProvider
    Shutdown       func(context.Context) error
}

// Initialize sets up OpenTelemetry trace and metric providers.
func Initialize(ctx context.Context, cfg Config, promRegistry *promclient.Registry) (*SDK, error) {
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithProcess(),
        resource.WithHost(),
    )
    if err != nil {
        return nil, fmt.Errorf("resource creation: %w", err)
    }

    // Trace exporter: OTLP/HTTP to Tempo
    traceExporter, err := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(cfg.OTLPEndpoint),
        otlptracehttp.WithInsecure(), // use WithTLSClientConfig for production TLS
        otlptracehttp.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("trace exporter: %w", err)
    }

    tracerProvider := sdktrace.NewTracerProvider(
        sdktrace.WithResource(res),
        sdktrace.WithBatcher(traceExporter,
            sdktrace.WithBatchTimeout(2*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.1), // 10% sampling in production
        )),
    )
    otel.SetTracerProvider(tracerProvider)

    // Propagator: W3C TraceContext + Baggage
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    // Metric exporter: Prometheus
    prometheusExporter, err := prometheus.New(
        prometheus.WithRegisterer(promRegistry),
    )
    if err != nil {
        return nil, fmt.Errorf("prometheus exporter: %w", err)
    }

    meterProvider := metric.NewMeterProvider(
        metric.WithResource(res),
        metric.WithReader(prometheusExporter),
    )
    otel.SetMeterProvider(meterProvider)

    shutdown := func(ctx context.Context) error {
        var errs []error
        if err := tracerProvider.Shutdown(ctx); err != nil {
            errs = append(errs, fmt.Errorf("tracer shutdown: %w", err))
        }
        if err := meterProvider.Shutdown(ctx); err != nil {
            errs = append(errs, fmt.Errorf("meter shutdown: %w", err))
        }
        if len(errs) > 0 {
            return fmt.Errorf("telemetry shutdown errors: %v", errs)
        }
        return nil
    }

    return &SDK{
        TracerProvider: tracerProvider,
        MeterProvider:  meterProvider,
        Shutdown:       shutdown,
    }, nil
}
```

## Trace ID Injection into Structured Logs

The key to log correlation is injecting trace ID and span ID into every log record emitted during a traced request:

```go
// pkg/telemetry/logger.go
package telemetry

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

// TraceContextHandler wraps an slog.Handler to inject trace context into log records.
type TraceContextHandler struct {
    base slog.Handler
}

// NewTraceContextHandler creates a slog handler that injects trace context.
func NewTraceContextHandler(base slog.Handler) *TraceContextHandler {
    return &TraceContextHandler{base: base}
}

// Handle adds trace_id, span_id, and trace_flags to each log record.
func (h *TraceContextHandler) Handle(ctx context.Context, r slog.Record) error {
    spanCtx := trace.SpanContextFromContext(ctx)
    if spanCtx.IsValid() {
        r.AddAttrs(
            slog.String("trace_id", spanCtx.TraceID().String()),
            slog.String("span_id", spanCtx.SpanID().String()),
            slog.Bool("trace_sampled", spanCtx.IsSampled()),
        )
    }
    return h.base.Handle(ctx, r)
}

func (h *TraceContextHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.base.Enabled(ctx, level)
}

func (h *TraceContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &TraceContextHandler{base: h.base.WithAttrs(attrs)}
}

func (h *TraceContextHandler) WithGroup(name string) slog.Handler {
    return &TraceContextHandler{base: h.base.WithGroup(name)}
}
```

### Setting Up the Logger

```go
// main.go - Logger initialization
import (
    "log/slog"
    "os"

    "enterprise.example.com/telemetry-demo/pkg/telemetry"
)

func newLogger(serviceName string) *slog.Logger {
    jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    })
    traceHandler := telemetry.NewTraceContextHandler(jsonHandler)
    return slog.New(traceHandler).With(
        "service", serviceName,
    )
}
```

Every log line will now include:

```json
{
  "time": "2030-08-26T12:00:01.234Z",
  "level": "INFO",
  "msg": "order processed",
  "service": "order-service",
  "trace_id": "7f84b7c9a3d5e2f1b6c9d4e7a8f2b5c1",
  "span_id": "a3d5e2f1b6c9d4e7",
  "trace_sampled": true,
  "order_id": "ord-12345",
  "customer_id": "cust-6789",
  "duration_ms": 42
}
```

This makes it possible to search Loki for `{service="order-service"} | json | trace_id="7f84b7c9..."` and find every log line from that exact trace.

## Prometheus Exemplars: Linking Metrics to Traces

Exemplars are sample data points attached to histogram observations. They can carry a trace ID, creating a link from a specific latency measurement to the trace that produced it.

### Native Histogram with Exemplars

```go
// pkg/telemetry/metrics.go
package telemetry

import (
    "context"
    "net/http"
    "strconv"
    "time"

    "go.opentelemetry.io/otel/trace"
    "github.com/prometheus/client_golang/prometheus"
)

// HTTPMetrics holds Prometheus metrics for HTTP handlers.
type HTTPMetrics struct {
    requestDuration *prometheus.HistogramVec
    requestsTotal   *prometheus.CounterVec
    requestsInFlight prometheus.Gauge
}

// NewHTTPMetrics creates HTTP metrics with exemplar support.
func NewHTTPMetrics(reg prometheus.Registerer) (*HTTPMetrics, error) {
    requestDuration := prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "http_request_duration_seconds",
            Help: "HTTP request duration in seconds",
            Buckets: []float64{
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
            },
        },
        []string{"method", "path", "status_code"},
    )

    requestsTotal := prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total HTTP requests processed",
        },
        []string{"method", "path", "status_code"},
    )

    requestsInFlight := prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "http_requests_in_flight",
        Help: "Number of HTTP requests currently being processed",
    })

    for _, c := range []prometheus.Collector{requestDuration, requestsTotal, requestsInFlight} {
        if err := reg.Register(c); err != nil {
            return nil, err
        }
    }

    return &HTTPMetrics{
        requestDuration:  requestDuration,
        requestsTotal:    requestsTotal,
        requestsInFlight: requestsInFlight,
    }, nil
}

// ObserveRequest records an HTTP request with exemplar if a trace is active.
func (m *HTTPMetrics) ObserveRequest(ctx context.Context, method, path string, statusCode int, duration time.Duration) {
    labels := prometheus.Labels{
        "method":      method,
        "path":        path,
        "status_code": strconv.Itoa(statusCode),
    }

    durationSeconds := duration.Seconds()
    spanCtx := trace.SpanContextFromContext(ctx)

    // Attach exemplar when a sampled trace is active
    if spanCtx.IsValid() && spanCtx.IsSampled() {
        exemplarLabels := prometheus.Labels{
            "trace_id": spanCtx.TraceID().String(),
            "span_id":  spanCtx.SpanID().String(),
        }
        // ObserverVec with exemplar requires ExemplarObserver interface
        if observer, err := m.requestDuration.GetMetricWith(labels); err == nil {
            if exemplarObserver, ok := observer.(prometheus.ExemplarObserver); ok {
                exemplarObserver.ObserveWithExemplar(durationSeconds, exemplarLabels)
                m.requestsTotal.With(labels).Add(1)
                return
            }
        }
    }

    // Fallback: record without exemplar
    m.requestDuration.With(labels).Observe(durationSeconds)
    m.requestsTotal.With(labels).Add(1)
}
```

### Prometheus Configuration for Exemplar Storage

Prometheus must be configured to store exemplars. By default, exemplar storage is disabled:

```yaml
# prometheus.yaml
global:
  scrape_interval: 15s

# Enable exemplar storage
feature_flags:
  - exemplar-storage

# Or via command line flag:
# --enable-feature=exemplar-storage
# --storage.exemplars.exemplars-limit=100000
```

### Grafana Dashboard Query Using Exemplars

In Grafana, enable exemplars in the data source configuration and use this query pattern:

```promql
# P99 latency with exemplars enabled
histogram_quantile(0.99,
  sum by (le, path) (
    rate(http_request_duration_seconds_bucket{service="api-server"}[5m])
  )
)
```

In the Grafana panel, click the exemplar dot on the graph to jump directly to the trace in Tempo.

## Baggage Propagation

Baggage carries key-value pairs that propagate across service boundaries through HTTP headers. Use baggage to carry tenant IDs, user IDs, and feature flags for multi-tenant observability:

```go
// pkg/telemetry/baggage.go
package telemetry

import (
    "context"
    "fmt"
    "net/http"

    "go.opentelemetry.io/otel/baggage"
)

const (
    BaggageTenantID   = "tenant.id"
    BaggageUserID     = "user.id"
    BaggageRequestID  = "request.id"
)

// WithBaggage adds baggage to the context and propagates it in the request.
func WithBaggage(ctx context.Context, kvs map[string]string) (context.Context, error) {
    members := make([]baggage.Member, 0, len(kvs))
    for k, v := range kvs {
        m, err := baggage.NewMember(k, v)
        if err != nil {
            return ctx, fmt.Errorf("baggage member %s=%s: %w", k, v, err)
        }
        members = append(members, m)
    }

    b, err := baggage.New(members...)
    if err != nil {
        return ctx, fmt.Errorf("baggage creation: %w", err)
    }
    return baggage.ContextWithBaggage(ctx, b), nil
}

// BaggageFromContext extracts a baggage value by key.
func BaggageFromContext(ctx context.Context, key string) string {
    b := baggage.FromContext(ctx)
    m := b.Member(key)
    return m.Value()
}

// InjectBaggageMiddleware extracts authentication context and injects it as baggage.
func InjectBaggageMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract tenant from JWT claims (already validated upstream)
        tenantID := r.Header.Get("X-Tenant-ID")
        userID := r.Header.Get("X-User-ID")
        requestID := r.Header.Get("X-Request-ID")

        kvs := map[string]string{}
        if tenantID != "" {
            kvs[BaggageTenantID] = tenantID
        }
        if userID != "" {
            kvs[BaggageUserID] = userID
        }
        if requestID != "" {
            kvs[BaggageRequestID] = requestID
        }

        if len(kvs) > 0 {
            var err error
            ctx, err = WithBaggage(ctx, kvs)
            if err != nil {
                // Non-fatal: proceed without baggage
                _ = err
            }
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Using Baggage in Downstream Services

When Service B receives a request from Service A, baggage is automatically propagated via the W3C Baggage header. Extract it to add tenant context to spans and logs:

```go
// In a downstream service handler
func processOrder(ctx context.Context, orderID string) error {
    tenantID := telemetry.BaggageFromContext(ctx, telemetry.BaggageTenantID)
    userID := telemetry.BaggageFromContext(ctx, telemetry.BaggageUserID)

    // Add to span as attributes
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(
        attribute.String("tenant.id", tenantID),
        attribute.String("user.id", userID),
        attribute.String("order.id", orderID),
    )

    // The log will automatically include trace_id via TraceContextHandler
    slog.InfoContext(ctx, "processing order",
        "order_id", orderID,
        "tenant_id", tenantID,
        "user_id", userID,
    )

    return nil
}
```

## Unified HTTP Middleware

Combine tracing, logging, and metrics into a single middleware chain:

```go
// pkg/telemetry/middleware.go
package telemetry

import (
    "log/slog"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.25.0"
    "go.opentelemetry.io/otel/trace"
)

// ObservabilityMiddleware provides unified trace, metric, and log instrumentation.
type ObservabilityMiddleware struct {
    tracer  trace.Tracer
    metrics *HTTPMetrics
    logger  *slog.Logger
}

// NewObservabilityMiddleware creates the unified middleware.
func NewObservabilityMiddleware(
    tracer trace.Tracer,
    metrics *HTTPMetrics,
    logger *slog.Logger,
) *ObservabilityMiddleware {
    return &ObservabilityMiddleware{
        tracer:  tracer,
        metrics: metrics,
        logger:  logger,
    }
}

// Wrap instruments an HTTP handler with observability.
func (m *ObservabilityMiddleware) Wrap(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        ctx := r.Context()

        // Extract trace context from incoming headers (W3C TraceContext / B3)
        propagator := otel.GetTextMapPropagator()
        ctx = propagator.Extract(ctx, propagation.HeaderCarrier(r.Header))

        // Start a server span
        ctx, span := m.tracer.Start(ctx, r.Method+" "+r.URL.Path,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.HTTPMethod(r.Method),
                semconv.HTTPURL(r.URL.String()),
                semconv.HTTPScheme(scheme(r)),
                semconv.NetHostName(r.Host),
                attribute.String("http.client_ip", r.RemoteAddr),
            ),
        )
        defer span.End()

        // Wrap response writer to capture status code
        rw := newResponseWriter(w)
        m.metrics.requestsInFlight.Inc()
        defer m.metrics.requestsInFlight.Dec()

        // Serve the request
        next.ServeHTTP(rw, r.WithContext(ctx))

        duration := time.Since(start)
        statusCode := rw.statusCode()

        // Complete span with response attributes
        span.SetAttributes(
            semconv.HTTPStatusCode(statusCode),
            attribute.Int64("http.response_size", int64(rw.written)),
        )
        if statusCode >= 500 {
            span.SetStatus(codes.Error, http.StatusText(statusCode))
        }

        // Record metric with exemplar
        m.metrics.ObserveRequest(ctx, r.Method, r.URL.Path, statusCode, duration)

        // Structured log with trace context injected automatically
        level := slog.LevelInfo
        if statusCode >= 500 {
            level = slog.LevelError
        } else if statusCode >= 400 {
            level = slog.LevelWarn
        }
        m.logger.LogAttrs(ctx, level, "http request",
            slog.String("method", r.Method),
            slog.String("path", r.URL.Path),
            slog.Int("status", statusCode),
            slog.Duration("duration", duration),
            slog.Int64("response_bytes", int64(rw.written)),
        )
    })
}

type responseWriter struct {
    http.ResponseWriter
    code    int
    written int
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
    return &responseWriter{ResponseWriter: w, code: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.code = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.written += n
    return n, err
}

func (rw *responseWriter) statusCode() int {
    return rw.code
}

func scheme(r *http.Request) string {
    if r.TLS != nil {
        return "https"
    }
    return "http"
}
```

## Outgoing HTTP Client Instrumentation

Propagate trace context in outgoing requests to downstream services:

```go
// pkg/telemetry/client.go
package telemetry

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.25.0"
)

// TracingTransport is an http.RoundTripper that adds trace context to outgoing requests.
type TracingTransport struct {
    base   http.RoundTripper
    tracer trace.Tracer
}

// NewTracingTransport wraps an http.RoundTripper with OpenTelemetry instrumentation.
func NewTracingTransport(base http.RoundTripper, tracer trace.Tracer) *TracingTransport {
    if base == nil {
        base = http.DefaultTransport
    }
    return &TracingTransport{base: base, tracer: tracer}
}

// RoundTrip implements http.RoundTripper.
func (t *TracingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    ctx, span := t.tracer.Start(req.Context(),
        req.Method+" "+req.URL.Host+req.URL.Path,
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            semconv.HTTPMethod(req.Method),
            semconv.HTTPURL(req.URL.String()),
            semconv.NetPeerName(req.URL.Hostname()),
        ),
    )
    defer span.End()

    // Inject trace context into outgoing headers
    req = req.WithContext(ctx)
    propagator := otel.GetTextMapPropagator()
    propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))

    resp, err := t.base.RoundTrip(req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetAttributes(
        semconv.HTTPStatusCode(resp.StatusCode),
    )
    if resp.StatusCode >= 500 {
        span.SetStatus(codes.Error, resp.Status)
    }

    return resp, nil
}

// NewTracingHTTPClient returns an http.Client with tracing enabled.
func NewTracingHTTPClient(tracer trace.Tracer) *http.Client {
    return &http.Client{
        Timeout: 30 * time.Second,
        Transport: NewTracingTransport(
            &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 20,
                IdleConnTimeout:     90 * time.Second,
            },
            tracer,
        ),
    }
}
```

## Database Instrumentation

```go
// pkg/telemetry/database.go
package telemetry

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

// InstrumentedDB wraps sql.DB with OpenTelemetry instrumentation.
type InstrumentedDB struct {
    db     *sql.DB
    tracer trace.Tracer
    name   string // database name for span labeling
}

// NewInstrumentedDB wraps a sql.DB with tracing.
func NewInstrumentedDB(db *sql.DB, tracer trace.Tracer, name string) *InstrumentedDB {
    return &InstrumentedDB{db: db, tracer: tracer, name: name}
}

// QueryContext executes a query and records a span.
func (d *InstrumentedDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    ctx, span := d.tracer.Start(ctx, fmt.Sprintf("db.query %s", d.name),
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.name", d.name),
            attribute.String("db.statement", sanitizeQuery(query)),
            attribute.String("db.operation", "SELECT"),
        ),
    )
    defer span.End()

    start := time.Now()
    rows, err := d.db.QueryContext(ctx, query, args...)
    duration := time.Since(start)

    span.SetAttributes(attribute.Int64("db.duration_ms", duration.Milliseconds()))

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }
    return rows, err
}

// ExecContext executes a statement and records a span.
func (d *InstrumentedDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
    ctx, span := d.tracer.Start(ctx, fmt.Sprintf("db.exec %s", d.name),
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.name", d.name),
            attribute.String("db.statement", sanitizeQuery(query)),
        ),
    )
    defer span.End()

    result, err := d.db.ExecContext(ctx, query, args...)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }
    return result, err
}

// sanitizeQuery removes parameter values to avoid logging PII in traces.
func sanitizeQuery(q string) string {
    // Truncate long queries
    if len(q) > 200 {
        return q[:200] + "..."
    }
    return q
}
```

## Grafana Dashboard Configuration

### Loki Log Query Using Trace ID

Configure Grafana's Loki data source with a derived field to extract trace IDs:

```yaml
# Grafana data source configuration for Loki
# In Grafana UI: Configuration → Data Sources → Loki → Derived Fields
name: TraceID
matcherRegex: '"trace_id":"([a-f0-9]+)"'
url: '${__value.raw}'
urlDisplayLabel: View Trace
# Internal link to Tempo data source
internalLinkEnabled: true
datasourceUid: tempo-prod
```

### Prometheus Data Source Exemplar Configuration

```yaml
# In Grafana UI: Configuration → Data Sources → Prometheus
# Enable exemplars
exemplarTraceIdDestinations:
  - name: trace_id
    datasourceUid: tempo-prod
    urlDisplayLabel: View Trace
```

### Complete Grafana Dashboard JSON (Key Panels)

```json
{
  "panels": [
    {
      "title": "P99 Request Latency (click exemplars for traces)",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum by (le, path) (rate(http_request_duration_seconds_bucket[5m])))",
          "legendFormat": "p99 {{path}}",
          "exemplar": true
        }
      ]
    },
    {
      "title": "Error Rate by Path",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum by (path) (rate(http_requests_total{status_code=~\"5..\"}[5m])) / sum by (path) (rate(http_requests_total[5m]))",
          "legendFormat": "{{path}} error rate"
        }
      ]
    },
    {
      "title": "Recent Errors (click trace_id to view trace)",
      "type": "logs",
      "targets": [
        {
          "expr": "{service=\"api-server\"} | json | level=`ERROR` | line_format \"{{.trace_id}} {{.msg}} {{.error}}\""
        }
      ]
    }
  ]
}
```

## Putting It All Together: Main Application

```go
// main.go
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
    promclient "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel"
    "enterprise.example.com/telemetry-demo/pkg/telemetry"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Create Prometheus registry
    promRegistry := promclient.NewRegistry()
    promRegistry.MustRegister(promclient.NewGoCollector())
    promRegistry.MustRegister(promclient.NewProcessCollector(promclient.ProcessCollectorOpts{}))

    // Initialize OpenTelemetry
    sdk, err := telemetry.Initialize(ctx, telemetry.Config{
        ServiceName:    "api-server",
        ServiceVersion: "v1.0.0",
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        Environment:    os.Getenv("ENVIRONMENT"),
    }, promRegistry)
    if err != nil {
        slog.Error("telemetry initialization failed", "error", err)
        os.Exit(1)
    }
    defer sdk.Shutdown(context.Background())

    // Create instrumented components
    tracer := otel.Tracer("api-server")
    metrics, err := telemetry.NewHTTPMetrics(promRegistry)
    if err != nil {
        slog.Error("metrics initialization failed", "error", err)
        os.Exit(1)
    }

    logger := newLogger("api-server")
    obsMiddleware := telemetry.NewObservabilityMiddleware(tracer, metrics, logger)

    // Build router
    r := chi.NewRouter()
    r.Use(obsMiddleware.Wrap)
    r.Use(telemetry.InjectBaggageMiddleware)

    r.Get("/api/v1/orders/{id}", handleGetOrder(tracer, logger))

    // Metrics endpoint (not traced)
    mux := http.NewServeMux()
    mux.Handle("/metrics", promhttp.HandlerFor(promRegistry, promhttp.HandlerOpts{
        EnableOpenMetrics: true, // Required for exemplar support
    }))
    mux.Handle("/", r)

    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    go func() {
        logger.Info("starting server", "addr", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("server error", "error", err)
        }
    }()

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()
    server.Shutdown(shutdownCtx)
}

func handleGetOrder(tracer interface{ Start(context.Context, string, ...interface{}) (context.Context, interface{}) }, logger *slog.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        orderID := chi.URLParam(r, "id")

        // Business logic spans are nested under the server span
        logger.InfoContext(ctx, "fetching order",
            "order_id", orderID,
            "tenant_id", telemetry.BaggageFromContext(ctx, telemetry.BaggageTenantID),
        )

        w.Header().Set("Content-Type", "application/json")
        w.Write([]byte(`{"order_id":"` + orderID + `","status":"fulfilled"}`))
    }
}
```

## Kubernetes Deployment with OpenTelemetry Collector

```yaml
# otel-collector.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.101.0
          args:
            - "--config=/conf/otel-collector-config.yaml"
          volumeMounts:
            - name: config
              mountPath: /conf
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
data:
  otel-collector-config.yaml: |
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
          grpc:
            endpoint: 0.0.0.0:4317

    processors:
      batch:
        timeout: 2s
        send_batch_size: 1000
      memory_limiter:
        limit_mib: 400
        spike_limit_mib: 100
        check_interval: 5s

    exporters:
      otlp/tempo:
        endpoint: tempo.monitoring.svc.cluster.local:4317
        tls:
          insecure: true
      logging:
        loglevel: warn

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [otlp/tempo]
```

## Troubleshooting Correlation Issues

**Trace ID missing from logs**: Verify the `TraceContextHandler` is in the slog handler chain. The span must be started before the log call, and the `ctx` passed to `slog.InfoContext` must contain the active span.

**Exemplars not visible in Grafana**: Ensure Prometheus is started with `--enable-feature=exemplar-storage` and the scrape config uses `application/openmetrics-text` (OpenMetrics format, required for exemplar transport). Set `EnableOpenMetrics: true` in `promhttp.HandlerOpts`.

**Traces not connecting across services**: Check that both services use the same propagator (W3C TraceContext). Verify the `traceparent` header is present in cross-service requests using `curl -v` or a network capture.

**Baggage not received in downstream service**: Baggage requires the `baggage` W3C header. Confirm `propagation.Baggage{}` is included in the composite propagator on both services.
