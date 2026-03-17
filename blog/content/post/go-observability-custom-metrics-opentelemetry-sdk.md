---
title: "Go Observability: Custom Metrics with OpenTelemetry SDK"
date: 2029-08-10T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Metrics", "Observability", "Prometheus", "OTLP"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to custom metrics in Go using the OpenTelemetry SDK: meter API, counter/histogram/gauge instruments, views and aggregations, exemplars for trace correlation, and OTLP export to Prometheus and collectors."
more_link: "yes"
url: "/go-observability-custom-metrics-opentelemetry-sdk/"
---

OpenTelemetry has become the de facto standard for cloud-native observability. While distributed tracing gets most of the attention, the metrics API is equally powerful — and unlike Prometheus client libraries, it is designed from the ground up for multi-backend portability. This post covers everything you need to instrument a Go service with production-grade custom metrics: instrument types, views, exemplars, exporters, and the patterns that keep your metrics cardinality under control.

<!--more-->

# Go Observability: Custom Metrics with OpenTelemetry SDK

## Section 1: OpenTelemetry Metrics Architecture

The OpenTelemetry metrics specification defines three layers:

```
Application Code
    └── Meter API (instrument creation)
        └── SDK (aggregation, views, readers)
            └── Exporter (Prometheus, OTLP, stdout)
```

Key concepts:

- **MeterProvider** — factory for Meters; holds SDK configuration
- **Meter** — factory for instruments; scoped to a library/component
- **Instrument** — counter, histogram, or gauge; records measurements
- **View** — transforms instrument data before export (rename, aggregate, filter)
- **Reader** — pulls aggregated data at a configured interval
- **Exporter** — serializes and sends data to a backend

### Go SDK Packages

```bash
# Core API and SDK
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/metric
go get go.opentelemetry.io/otel/sdk/metric

# Exporters
go get go.opentelemetry.io/otel/exporters/prometheus
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp

# Semantic conventions (standardized attribute names)
go get go.opentelemetry.io/otel/semconv/v1.21.0
```

## Section 2: MeterProvider Setup

### Prometheus Exporter (Scrape-Based)

```go
// pkg/telemetry/provider.go
package telemetry

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

// ProviderConfig holds MeterProvider configuration.
type ProviderConfig struct {
    ServiceName    string
    ServiceVersion string
    Namespace      string
    MetricsAddr    string
}

// InitPrometheusProvider sets up a MeterProvider that exposes metrics
// via a Prometheus /metrics HTTP endpoint.
func InitPrometheusProvider(ctx context.Context, cfg ProviderConfig) (func(), error) {
    // Create the Prometheus exporter
    promExporter, err := prometheus.New(
        prometheus.WithNamespace(cfg.Namespace),
    )
    if err != nil {
        return nil, fmt.Errorf("creating prometheus exporter: %w", err)
    }

    // Resource describes this service
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
        ),
        resource.WithHost(),
        resource.WithProcessPID(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // Create the MeterProvider
    mp := metric.NewMeterProvider(
        metric.WithResource(res),
        metric.WithReader(promExporter),
    )

    // Set as global provider
    otel.SetMeterProvider(mp)

    // Start the /metrics HTTP server
    mux := http.NewServeMux()
    mux.Handle("/metrics", promhttp.Handler())
    server := &http.Server{
        Addr:    cfg.MetricsAddr,
        Handler: mux,
    }
    go func() {
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            fmt.Printf("metrics server error: %v\n", err)
        }
    }()

    // Return a shutdown function
    shutdown := func() {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := mp.Shutdown(ctx); err != nil {
            fmt.Printf("MeterProvider shutdown error: %v\n", err)
        }
        if err := server.Shutdown(ctx); err != nil {
            fmt.Printf("metrics server shutdown error: %v\n", err)
        }
    }

    return shutdown, nil
}
```

### OTLP gRPC Exporter (Push-Based)

```go
// pkg/telemetry/otlp_provider.go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// InitOTLPProvider sets up a MeterProvider that pushes metrics to an
// OpenTelemetry Collector over gRPC every 30 seconds.
func InitOTLPProvider(ctx context.Context, cfg ProviderConfig, collectorAddr string) (func(), error) {
    conn, err := grpc.DialContext(ctx, collectorAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to otel collector: %w", err)
    }

    exporter, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating otlp metric exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
        ),
        resource.WithHost(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    mp := metric.NewMeterProvider(
        metric.WithResource(res),
        metric.WithReader(
            metric.NewPeriodicExportingMetricReader(exporter,
                metric.WithInterval(30*time.Second),
                metric.WithTimeout(10*time.Second),
            ),
        ),
    )

    otel.SetMeterProvider(mp)

    return func() {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        _ = mp.Shutdown(ctx)
        _ = conn.Close()
    }, nil
}
```

## Section 3: Instrument Types

### Counter — Monotonically Increasing Values

```go
// pkg/metrics/http_metrics.go
package metrics

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

const instrumentationScope = "github.com/example/api-gateway"

type HTTPMetrics struct {
    requestsTotal   metric.Int64Counter
    bytesReceived   metric.Int64Counter
    bytesSent       metric.Int64Counter
}

func NewHTTPMetrics() (*HTTPMetrics, error) {
    meter := otel.Meter(instrumentationScope)

    requestsTotal, err := meter.Int64Counter(
        "http.server.request.count",
        metric.WithDescription("Total number of HTTP requests received"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    bytesReceived, err := meter.Int64Counter(
        "http.server.request.body.size",
        metric.WithDescription("Total bytes received in request bodies"),
        metric.WithUnit("By"),
    )
    if err != nil {
        return nil, err
    }

    bytesSent, err := meter.Int64Counter(
        "http.server.response.body.size",
        metric.WithDescription("Total bytes sent in response bodies"),
        metric.WithUnit("By"),
    )
    if err != nil {
        return nil, err
    }

    return &HTTPMetrics{
        requestsTotal: requestsTotal,
        bytesReceived: bytesReceived,
        bytesSent:     bytesSent,
    }, nil
}

// RecordRequest records a completed HTTP request.
func (m *HTTPMetrics) RecordRequest(ctx context.Context, method, route string, status int, reqSize, respSize int64) {
    attrs := metric.WithAttributes(
        attribute.String("http.request.method", method),
        attribute.String("http.route", route),
        attribute.Int("http.response.status_code", status),
    )
    m.requestsTotal.Add(ctx, 1, attrs)
    m.bytesReceived.Add(ctx, reqSize, attrs)
    m.bytesSent.Add(ctx, respSize, attrs)
}
```

### Histogram — Distribution of Values

```go
// pkg/metrics/latency_metrics.go
package metrics

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

type LatencyMetrics struct {
    requestDuration metric.Float64Histogram
    dbQueryDuration metric.Float64Histogram
    cacheOpDuration metric.Float64Histogram
}

func NewLatencyMetrics() (*LatencyMetrics, error) {
    meter := otel.Meter(instrumentationScope)

    requestDuration, err := meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("Duration of HTTP requests"),
        metric.WithUnit("s"),
        // Explicit bucket boundaries (overridden by View if set)
        metric.WithExplicitBucketBoundaries(
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
        ),
    )
    if err != nil {
        return nil, err
    }

    dbQueryDuration, err := meter.Float64Histogram(
        "db.query.duration",
        metric.WithDescription("Duration of database queries"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0,
        ),
    )
    if err != nil {
        return nil, err
    }

    cacheOpDuration, err := meter.Float64Histogram(
        "cache.operation.duration",
        metric.WithDescription("Duration of cache operations"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05,
        ),
    )
    if err != nil {
        return nil, err
    }

    return &LatencyMetrics{
        requestDuration: requestDuration,
        dbQueryDuration: dbQueryDuration,
        cacheOpDuration: cacheOpDuration,
    }, nil
}

// RecordHTTPRequest records an HTTP request duration.
func (m *LatencyMetrics) RecordHTTPRequest(ctx context.Context, method, route string, status int, start time.Time) {
    duration := time.Since(start).Seconds()
    m.requestDuration.Record(ctx, duration,
        metric.WithAttributes(
            attribute.String("http.request.method", method),
            attribute.String("http.route", route),
            attribute.Int("http.response.status_code", status),
        ),
    )
}

// RecordDBQuery records a database query duration.
func (m *LatencyMetrics) RecordDBQuery(ctx context.Context, operation, table string, err error, start time.Time) {
    status := "ok"
    if err != nil {
        status = "error"
    }
    m.dbQueryDuration.Record(ctx, time.Since(start).Seconds(),
        metric.WithAttributes(
            attribute.String("db.operation", operation),
            attribute.String("db.sql.table", table),
            attribute.String("db.status", status),
        ),
    )
}
```

### Gauge — Current Value at Observation Time

```go
// pkg/metrics/system_metrics.go
package metrics

import (
    "context"
    "runtime"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

type SystemMetrics struct {
    goroutines         metric.Int64ObservableGauge
    heapAllocBytes     metric.Int64ObservableGauge
    connPoolActive     metric.Int64ObservableGauge
    connPoolIdle       metric.Int64ObservableGauge
    queueDepth         metric.Int64ObservableGauge
}

// PoolStats is provided by the caller (e.g., sql.DB.Stats())
type PoolStats struct {
    Active int64
    Idle   int64
}

// QueueDepthFn returns current queue depth (supplied by application)
type QueueDepthFn func() map[string]int64

func NewSystemMetrics(poolStats *PoolStats, queueDepth QueueDepthFn) (*SystemMetrics, error) {
    meter := otel.Meter(instrumentationScope)

    goroutines, err := meter.Int64ObservableGauge(
        "process.runtime.go.goroutines",
        metric.WithDescription("Current number of goroutines"),
        metric.WithUnit("{goroutine}"),
    )
    if err != nil {
        return nil, err
    }

    heapAlloc, err := meter.Int64ObservableGauge(
        "process.runtime.go.mem.heap_alloc",
        metric.WithDescription("Bytes of allocated heap objects"),
        metric.WithUnit("By"),
    )
    if err != nil {
        return nil, err
    }

    connActive, err := meter.Int64ObservableGauge(
        "db.client.connections.usage",
        metric.WithDescription("Number of active connections"),
        metric.WithUnit("{connection}"),
    )
    if err != nil {
        return nil, err
    }

    queueLen, err := meter.Int64ObservableGauge(
        "messaging.queue.depth",
        metric.WithDescription("Current depth of message queues"),
        metric.WithUnit("{message}"),
    )
    if err != nil {
        return nil, err
    }

    sm := &SystemMetrics{
        goroutines:     goroutines,
        heapAllocBytes: heapAlloc,
        connPoolActive: connActive,
        queueDepth:     queueLen,
    }

    // Register a single callback for all runtime metrics
    _, err = meter.RegisterCallback(
        func(_ context.Context, o metric.Observer) error {
            var memStats runtime.MemStats
            runtime.ReadMemStats(&memStats)

            o.ObserveInt64(sm.goroutines, int64(runtime.NumGoroutine()))
            o.ObserveInt64(sm.heapAllocBytes, int64(memStats.HeapAlloc))
            o.ObserveInt64(sm.connPoolActive, poolStats.Active,
                metric.WithAttributes(attribute.String("db.connection.state", "active")),
            )
            o.ObserveInt64(sm.connPoolActive, poolStats.Idle,
                metric.WithAttributes(attribute.String("db.connection.state", "idle")),
            )

            for name, depth := range queueDepth() {
                o.ObserveInt64(sm.queueDepth, depth,
                    metric.WithAttributes(attribute.String("queue.name", name)),
                )
            }
            return nil
        },
        goroutines, heapAlloc, connActive, queueLen,
    )
    if err != nil {
        return nil, err
    }

    return sm, nil
}
```

### UpDown Counter — Values That Can Increase or Decrease

```go
// UpDown counter for tracking in-flight requests
inFlightRequests, err := meter.Int64UpDownCounter(
    "http.server.active_requests",
    metric.WithDescription("Number of active HTTP requests"),
    metric.WithUnit("{request}"),
)

// Middleware usage
func (m *Middleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    attrs := metric.WithAttributes(
        attribute.String("http.request.method", r.Method),
        attribute.String("http.route", getRoute(r)),
    )
    m.inFlightRequests.Add(r.Context(), 1, attrs)
    defer m.inFlightRequests.Add(r.Context(), -1, attrs)

    m.next.ServeHTTP(w, r)
}
```

## Section 4: Views and Aggregations

Views let you change how instrument data is aggregated before export — renaming instruments, changing bucket boundaries, or dropping high-cardinality attributes.

```go
// pkg/telemetry/views.go
package telemetry

import (
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// BuildViews returns the Views used by the MeterProvider.
func BuildViews() []metric.View {
    return []metric.View{
        // 1. Override histogram buckets for HTTP duration
        metric.NewView(
            metric.Instrument{Name: "http.server.request.duration"},
            metric.Stream{
                Aggregation: metric.AggregationExplicitBucketHistogram{
                    Boundaries: []float64{
                        0.005, 0.01, 0.025, 0.05, 0.075,
                        0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
                    },
                    NoMinMax: false,
                },
            },
        ),

        // 2. Drop high-cardinality attribute from request counter
        // (user.id would create one series per user — avoid this)
        metric.NewView(
            metric.Instrument{Name: "http.server.request.count"},
            metric.Stream{
                AttributeFilter: func(kv attribute.KeyValue) bool {
                    // Only keep these attributes
                    switch kv.Key {
                    case "http.request.method",
                        "http.route",
                        "http.response.status_code":
                        return true
                    }
                    return false
                },
            },
        ),

        // 3. Rename an instrument for legacy dashboard compatibility
        metric.NewView(
            metric.Instrument{Name: "db.query.duration"},
            metric.Stream{Name: "database_query_duration_seconds"},
        ),

        // 4. Use Base2 exponential histogram for a percentile-accurate metric
        metric.NewView(
            metric.Instrument{Name: "cache.operation.duration"},
            metric.Stream{
                Aggregation: metric.AggregationBase2ExponentialHistogram{
                    MaxSize:  160,
                    MaxScale: 20,
                    NoMinMax: false,
                },
            },
        ),
    }
}

// Apply views to MeterProvider
mp := metric.NewMeterProvider(
    metric.WithResource(res),
    metric.WithReader(promExporter),
    metric.WithView(BuildViews()...),
)
```

## Section 5: Exemplars for Trace Correlation

Exemplars attach a trace ID and span ID to a histogram data point, letting you jump from a slow Prometheus histogram bucket directly to the trace that caused it.

### Enabling Exemplars

```go
// pkg/telemetry/exemplar_provider.go
package telemetry

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/bridge/opencensus"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/metric/exemplar"
    "go.opentelemetry.io/otel/sdk/trace"
)

func InitWithExemplars(ctx context.Context, cfg ProviderConfig) (func(), error) {
    // Set up tracing first — exemplars need an active span context
    tracerProvider := trace.NewTracerProvider(
        trace.WithResource(res),
        // ... trace exporter config
    )
    otel.SetTracerProvider(tracerProvider)

    promExporter, err := prometheus.New(
        prometheus.WithNamespace(cfg.Namespace),
        // Enable exemplar export (Prometheus native histograms or OpenMetrics)
        prometheus.WithoutScopeInfo(),
    )
    if err != nil {
        return nil, err
    }

    mp := metric.NewMeterProvider(
        metric.WithResource(res),
        metric.WithReader(promExporter),
        // Use AlwaysOnExemplarFilter to attach exemplars to every data point
        // (use SampledExemplarFilter in high-traffic environments)
        metric.WithExemplarFilter(exemplar.AlwaysOnFilter),
    )

    otel.SetMeterProvider(mp)
    return func() { _ = mp.Shutdown(ctx) }, nil
}
```

### Recording Metrics with Active Span Context

```go
// The key: exemplars are automatically attached when there is an active span
func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
    ctx, span := otel.Tracer("api-gateway").Start(r.Context(), "HandleRequest")
    defer span.End()

    start := time.Now()

    // Process request...
    resp, err := h.service.Process(ctx, r)

    // This histogram record will include the trace ID as an exemplar
    // because there is an active span in ctx
    h.metrics.requestDuration.Record(ctx, time.Since(start).Seconds(),
        metric.WithAttributes(
            attribute.String("http.route", r.URL.Path),
            attribute.Int("http.response.status_code", resp.StatusCode),
        ),
    )
}
```

### Querying Exemplars in Grafana

```
# In Grafana, use the Exemplar query option in Explore
# or enable exemplars on a panel to see trace IDs on histogram buckets

# Native histogram query with exemplars
histogram_quantile(0.99, sum by (le) (
  rate(http_server_request_duration_seconds_bucket{job="api-gateway"}[5m])
))
# Click the diamond icon on the graph to jump to the trace
```

## Section 6: Middleware and Interceptors

### HTTP Middleware

```go
// pkg/middleware/telemetry.go
package middleware

import (
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

type TelemetryMiddleware struct {
    next            http.Handler
    requestsTotal   metric.Int64Counter
    requestDuration metric.Float64Histogram
    activeRequests  metric.Int64UpDownCounter
    propagator      propagation.TextMapPropagator
}

func NewTelemetryMiddleware(next http.Handler) (*TelemetryMiddleware, error) {
    meter := otel.Meter("github.com/example/api-gateway/middleware")

    requestsTotal, err := meter.Int64Counter(
        "http.server.request.count",
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    requestDuration, err := meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    activeRequests, err := meter.Int64UpDownCounter(
        "http.server.active_requests",
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    return &TelemetryMiddleware{
        next:            next,
        requestsTotal:   requestsTotal,
        requestDuration: requestDuration,
        activeRequests:  activeRequests,
        propagator:      otel.GetTextMapPropagator(),
    }, nil
}

type responseWriter struct {
    http.ResponseWriter
    status      int
    bytesWritten int64
}

func (rw *responseWriter) WriteHeader(status int) {
    rw.status = status
    rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += int64(n)
    return n, err
}

func (m *TelemetryMiddleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := m.propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
    start := time.Now()

    rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}

    commonAttrs := []attribute.KeyValue{
        semconv.HTTPRequestMethodKey.String(r.Method),
        attribute.String("http.route", getRoute(r)),
    }

    m.activeRequests.Add(ctx, 1, metric.WithAttributes(commonAttrs...))
    defer func() {
        m.activeRequests.Add(ctx, -1, metric.WithAttributes(commonAttrs...))
    }()

    m.next.ServeHTTP(rw, r.WithContext(ctx))

    attrs := append(commonAttrs, semconv.HTTPResponseStatusCode(rw.status))
    m.requestsTotal.Add(ctx, 1, metric.WithAttributes(attrs...))
    m.requestDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attrs...))
}
```

### gRPC Interceptors

```go
// pkg/interceptors/metrics.go
package interceptors

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
    "google.golang.org/grpc"
    "google.golang.org/grpc/status"
)

type GRPCMetrics struct {
    requestsTotal   metric.Int64Counter
    requestDuration metric.Float64Histogram
}

func NewGRPCMetrics() (*GRPCMetrics, error) {
    meter := otel.Meter("github.com/example/grpc-server/interceptors")

    requestsTotal, err := meter.Int64Counter(
        "rpc.server.duration",
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    requestDuration, err := meter.Float64Histogram(
        "rpc.server.request.duration",
        metric.WithUnit("ms"),
        metric.WithExplicitBucketBoundaries(
            1, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000,
        ),
    )
    if err != nil {
        return nil, err
    }

    return &GRPCMetrics{requestsTotal: requestsTotal, requestDuration: requestDuration}, nil
}

// UnaryServerInterceptor returns a gRPC unary interceptor that records metrics.
func (m *GRPCMetrics) UnaryServerInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        start := time.Now()

        resp, err := handler(ctx, req)

        code := "OK"
        if err != nil {
            code = status.Code(err).String()
        }

        attrs := metric.WithAttributes(
            attribute.String("rpc.system", "grpc"),
            attribute.String("rpc.service", extractService(info.FullMethod)),
            attribute.String("rpc.method", extractMethod(info.FullMethod)),
            attribute.String("rpc.grpc.status_code", code),
        )
        m.requestsTotal.Add(ctx, 1, attrs)
        m.requestDuration.Record(ctx, float64(time.Since(start).Milliseconds()), attrs)

        return resp, err
    }
}
```

## Section 7: Cardinality Management

High cardinality is the most common way to accidentally destroy your metrics backend.

### Cardinality Anti-Patterns

```go
// BAD — user ID creates millions of series
m.requestsTotal.Add(ctx, 1,
    metric.WithAttributes(
        attribute.String("user.id", userID),  // HIGH CARDINALITY: never do this
        attribute.String("request.id", reqID), // HIGH CARDINALITY: never do this
    ),
)

// BAD — unbounded route creates many series with wildcard paths
attribute.String("http.route", r.URL.Path)  // /users/12345/posts/67890

// GOOD — use parameterized routes
attribute.String("http.route", "/users/{id}/posts/{postId}")

// GOOD — bucket user types instead of individual users
attribute.String("user.tier", getUserTier(userID)) // "free", "pro", "enterprise"
```

### View-Based Cardinality Reduction

```go
// Drop high-cardinality attributes via View
metric.NewView(
    metric.Instrument{
        Name:  "http.server.request.count",
        Scope: instrumentation.Scope{Name: "github.com/example/api-gateway"},
    },
    metric.Stream{
        AttributeFilter: attribute.NewAllowKeysFilter(
            "http.request.method",
            "http.route",
            "http.response.status_code",
            // Deliberately excluded: user.id, request.id, session.id
        ),
    },
),
```

## Section 8: Testing Metrics Code

```go
// pkg/metrics/metrics_test.go
package metrics_test

import (
    "context"
    "testing"
    "time"

    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/metric/metricdata"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestHTTPMetrics_RecordRequest(t *testing.T) {
    // Use a manual reader for testing (pulls on demand)
    reader := metric.NewManualReader()
    mp := metric.NewMeterProvider(metric.WithReader(reader))

    // Override global provider in tests
    otel.SetMeterProvider(mp)
    defer otel.SetMeterProvider(otel.GetMeterProvider()) // restore

    m, err := NewHTTPMetrics()
    require.NoError(t, err)

    ctx := context.Background()
    m.RecordRequest(ctx, "GET", "/api/v1/users", 200, 0, 1024)
    m.RecordRequest(ctx, "GET", "/api/v1/users", 200, 0, 512)
    m.RecordRequest(ctx, "POST", "/api/v1/users", 500, 256, 64)

    // Collect metrics
    var data metricdata.ResourceMetrics
    require.NoError(t, reader.Collect(ctx, &data))

    // Find the request counter
    counter := findCounter(t, data, "http.server.request.count")

    // Verify counts
    assert.Equal(t, int64(2), counterValue(counter, attribute.String("http.response.status_code", "200")))
    assert.Equal(t, int64(1), counterValue(counter, attribute.String("http.response.status_code", "500")))
}

func findCounter(t *testing.T, data metricdata.ResourceMetrics, name string) metricdata.Metrics {
    t.Helper()
    for _, sm := range data.ScopeMetrics {
        for _, m := range sm.Metrics {
            if m.Name == name {
                return m
            }
        }
    }
    t.Fatalf("metric %q not found", name)
    return metricdata.Metrics{}
}
```

## Section 9: OpenTelemetry Collector Configuration

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
    timeout: 10s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
  # Add resource attributes
  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: insert

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: otel
  prometheusremotewrite:
    endpoint: "https://prometheus.internal/api/v1/write"
    tls:
      insecure: false

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheus, prometheusremotewrite]
```

## Section 10: Production Checklist

- [ ] MeterProvider initialized before any instrument creation
- [ ] Shutdown function called on SIGTERM/SIGINT with timeout
- [ ] Resource attributes include service.name, service.version, deployment.environment
- [ ] All histogram instruments have explicit bucket boundaries appropriate for the SLI
- [ ] Views configured to drop or filter high-cardinality attributes
- [ ] Exemplars enabled and trace provider initialized before metric provider
- [ ] HTTP middleware records: request count, duration histogram, active requests gauge
- [ ] gRPC interceptors record: call count, duration, status code
- [ ] Observable gauges registered for: goroutines, heap alloc, connection pool stats
- [ ] Cardinality reviewed: no user IDs, request IDs, or session IDs in attributes
- [ ] Metrics tested with ManualReader in unit tests
- [ ] OTel Collector deployed with batch processor and memory limiter
- [ ] Grafana dashboards use histogram quantile queries with correct job/service labels

## Conclusion

The OpenTelemetry metrics SDK provides a clean separation between instrumentation (your application code) and configuration (bucket boundaries, attribute filters, exporters). This means you instrument once and tune the export layer without touching application code.

The key discipline is cardinality management: every attribute you add to a measurement creates a multiplicative expansion of series. A counter with three attributes, each having five possible values, creates up to 125 series. Add a user ID with 10,000 possible values and you have 500,000 series per counter. Use views to enforce cardinality limits and always model your cardinality before shipping to production.
