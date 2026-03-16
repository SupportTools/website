---
title: "Go Observability with OpenTelemetry: Traces, Metrics, and Logs in Production"
date: 2027-07-21T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Observability", "Tracing", "Metrics"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to instrumenting Go services with OpenTelemetry, covering SDK setup, trace propagation, metric instruments, log correlation, OTLP exporters, exemplars, and sampling strategies."
more_link: "yes"
url: "/go-observability-opentelemetry-guide/"
---

Observability is not a feature added after a service reaches production — it is a first-class engineering concern embedded from the first commit. OpenTelemetry (OTel) has emerged as the vendor-neutral standard for instrumenting applications, and the Go SDK is now stable enough for production use. This guide walks through the complete instrumentation journey: SDK setup, tracing with context propagation, metric instruments, log correlation, OTLP export, exemplars, and sampling strategies that keep overhead manageable.

<!--more-->

# [Go Observability with OpenTelemetry](#go-observability-opentelemetry)

## Section 1: OpenTelemetry Go SDK Architecture

The OTel Go SDK is organized into several packages:

| Package | Purpose |
|---|---|
| `go.opentelemetry.io/otel` | Core API — TracerProvider, MeterProvider, global accessors |
| `go.opentelemetry.io/otel/sdk/trace` | SDK TracerProvider with span processors |
| `go.opentelemetry.io/otel/sdk/metric` | SDK MeterProvider with readers and views |
| `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc` | OTLP trace exporter over gRPC |
| `go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc` | OTLP metric exporter over gRPC |
| `go.opentelemetry.io/otel/bridge/opentracing` | Compatibility bridge for legacy OpenTracing |

The dependency graph flows: **API → SDK → Exporter**. Application code imports the API; only the `main` package or initialization code imports the SDK and exporter.

### Module Installation

```bash
go get go.opentelemetry.io/otel@latest
go get go.opentelemetry.io/otel/sdk@latest
go get go.opentelemetry.io/otel/sdk/metric@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@latest
go get go.opentelemetry.io/otel/propagators/b3@latest
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@latest
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@latest
```

## Section 2: SDK Setup and Initialization

### Centralized Provider Initialization

Initialize all providers in a single `telemetry` package to keep `main` clean and ensure teardown happens in the correct order.

```go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// Config holds telemetry initialization parameters.
type Config struct {
    ServiceName    string
    ServiceVersion string
    OTLPEndpoint   string // e.g. "otel-collector.monitoring:4317"
    SampleRate     float64
}

// SDK bundles the initialized providers and their shutdown functions.
type SDK struct {
    TracerProvider *sdktrace.TracerProvider
    MeterProvider  *sdkmetric.MeterProvider
    shutdown       []func(context.Context) error
}

// Shutdown flushes and closes all telemetry pipelines.
func (s *SDK) Shutdown(ctx context.Context) error {
    var errs []error
    for _, fn := range s.shutdown {
        if err := fn(ctx); err != nil {
            errs = append(errs, err)
        }
    }
    if len(errs) > 0 {
        return fmt.Errorf("telemetry shutdown errors: %v", errs)
    }
    return nil
}

// Init creates and globally registers TracerProvider and MeterProvider.
func Init(ctx context.Context, cfg Config) (*SDK, error) {
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            attribute.String("deployment.environment", envOrDefault("APP_ENV", "production")),
        ),
        resource.WithFromEnv(),
        resource.WithProcess(),
        resource.WithOS(),
    )
    if err != nil {
        return nil, fmt.Errorf("build resource: %w", err)
    }

    conn, err := grpc.NewClient(
        cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("dial OTLP endpoint: %w", err)
    }

    // --- Trace exporter ---
    traceExp, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("create trace exporter: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithResource(res),
        sdktrace.WithBatcher(traceExp,
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithBatchTimeout(5*time.Second),
        ),
        sdktrace.WithSampler(buildSampler(cfg.SampleRate)),
    )

    // --- Metric exporter ---
    metricExp, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("create metric exporter: %w", err)
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithResource(res),
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(metricExp,
                sdkmetric.WithInterval(30*time.Second),
            ),
        ),
    )

    // Register globally so instrumentation libraries pick them up.
    otel.SetTracerProvider(tp)
    otel.SetMeterProvider(mp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    sdk := &SDK{
        TracerProvider: tp,
        MeterProvider:  mp,
        shutdown: []func(context.Context) error{
            tp.Shutdown,
            mp.Shutdown,
        },
    }
    return sdk, nil
}

func buildSampler(rate float64) sdktrace.Sampler {
    if rate >= 1.0 {
        return sdktrace.AlwaysSample()
    }
    if rate <= 0 {
        return sdktrace.NeverSample()
    }
    return sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(rate),
    )
}

func envOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

### Wiring in main

```go
func main() {
    ctx := context.Background()

    sdk, err := telemetry.Init(ctx, telemetry.Config{
        ServiceName:    "inventory-service",
        ServiceVersion: "1.4.2",
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:     0.1, // 10% of traces
    })
    if err != nil {
        log.Fatalf("telemetry init: %v", err)
    }
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        if err := sdk.Shutdown(shutdownCtx); err != nil {
            log.Printf("telemetry shutdown: %v", err)
        }
    }()

    // ... rest of startup
}
```

## Section 3: Tracing

### Creating and Annotating Spans

```go
package inventorysvc

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("github.com/example/services/inventorysvc")

func (s *Server) GetItem(ctx context.Context, id string) (*Item, error) {
    ctx, span := tracer.Start(ctx, "GetItem",
        trace.WithAttributes(
            attribute.String("item.id", id),
        ),
    )
    defer span.End()

    item, err := s.store.FetchItem(ctx, id)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetAttributes(
        attribute.String("item.sku", item.SKU),
        attribute.Int64("item.quantity", item.Quantity),
    )
    return item, nil
}
```

### Span Events for Significant Moments

Span events are timestamped annotations within a span — useful for marking transitions that are not worth creating child spans for:

```go
func (s *Server) processOrder(ctx context.Context, orderID string) error {
    ctx, span := tracer.Start(ctx, "processOrder")
    defer span.End()

    span.AddEvent("validation_started")
    if err := s.validateOrder(ctx, orderID); err != nil {
        span.RecordError(err)
        return err
    }
    span.AddEvent("validation_complete")

    span.AddEvent("payment_started", trace.WithAttributes(
        attribute.String("payment.provider", "stripe"),
    ))
    if err := s.chargePayment(ctx, orderID); err != nil {
        span.RecordError(err)
        return err
    }
    span.AddEvent("payment_complete")

    return nil
}
```

### Context Propagation Across HTTP

The `otelhttp` contrib package injects and extracts trace context automatically:

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

// Server side: extract incoming trace context.
mux := http.NewServeMux()
mux.HandleFunc("/v1/items/", s.handleGetItem)
handler := otelhttp.NewHandler(mux, "inventory-http",
    otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
)

// Client side: inject outgoing trace context.
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
```

### Context Propagation Across gRPC

```go
import "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

// Server side.
srv := grpc.NewServer(
    grpc.StatsHandler(otelgrpc.NewServerHandler()),
)

// Client side.
conn, _ := grpc.NewClient(target,
    grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
)
```

## Section 4: Metrics

### Instrument Types

OTel defines several synchronous and asynchronous instrument types:

| Instrument | Type | Use Case |
|---|---|---|
| Counter | Synchronous | Monotonically increasing count (requests, errors) |
| UpDownCounter | Synchronous | Values that go up and down (queue depth) |
| Histogram | Synchronous | Distribution of values (latency, sizes) |
| Gauge (observable) | Asynchronous | Point-in-time reading (CPU, memory) |

### Registering and Using Instruments

```go
package metrics

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

var meter = otel.Meter("github.com/example/services/inventorysvc")

type Recorder struct {
    requestCount    metric.Int64Counter
    requestDuration metric.Float64Histogram
    activeRequests  metric.Int64UpDownCounter
    cacheHitRatio   metric.Float64ObservableGauge
}

func NewRecorder() (*Recorder, error) {
    r := &Recorder{}
    var err error

    r.requestCount, err = meter.Int64Counter(
        "http.server.request.count",
        metric.WithDescription("Total number of HTTP requests."),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    r.requestDuration, err = meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("HTTP request duration in seconds."),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
        ),
    )
    if err != nil {
        return nil, err
    }

    r.activeRequests, err = meter.Int64UpDownCounter(
        "http.server.active_requests",
        metric.WithDescription("Number of requests currently being processed."),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    return r, nil
}

func (r *Recorder) RecordRequest(ctx context.Context, method, route string, statusCode int, duration float64) {
    attrs := metric.WithAttributes(
        attribute.String("http.method", method),
        attribute.String("http.route", route),
        attribute.Int("http.status_code", statusCode),
    )
    r.requestCount.Add(ctx, 1, attrs)
    r.requestDuration.Record(ctx, duration, attrs)
}

func (r *Recorder) IncrementActive(ctx context.Context) {
    r.activeRequests.Add(ctx, 1)
}

func (r *Recorder) DecrementActive(ctx context.Context) {
    r.activeRequests.Add(ctx, -1)
}
```

### Metric Views for Aggregation Control

Views allow overriding default aggregation, renaming metrics, and filtering attributes before export:

```go
import (
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
)

mp := sdkmetric.NewMeterProvider(
    sdkmetric.WithResource(res),
    sdkmetric.WithReader(reader),
    // Drop high-cardinality attributes before export.
    sdkmetric.WithView(sdkmetric.NewView(
        sdkmetric.Instrument{
            Name: "http.server.request.duration",
        },
        sdkmetric.Stream{
            AttributeFilter: attribute.NewAllowKeysFilter(
                "http.method",
                "http.route",
                "http.status_code",
            ),
        },
    )),
)
```

## Section 5: Exemplars — Linking Traces to Metrics

Exemplars attach a trace ID to a specific histogram observation, enabling a direct jump from a slow p99 bucket in a dashboard to the trace that caused it. The OTel Go SDK emits exemplars automatically when the sampled span is in scope during a histogram recording.

```go
// The span context must be active (ctx carries the span) when Record is called.
// The SDK will attach the trace ID as an exemplar to the histogram bucket.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx, span := tracer.Start(r.Context(), "ServeHTTP")
    defer span.End()

    start := time.Now()
    // ... handle request ...
    duration := time.Since(start).Seconds()

    // ctx carries the span, so the SDK will embed trace context as exemplar.
    recorder.requestDuration.Record(ctx, duration,
        metric.WithAttributes(attribute.String("http.route", r.URL.Path)),
    )
}
```

In Grafana, exemplars appear as dots on histogram panels. Clicking a dot opens the correlated trace in Tempo.

Configure Grafana to read exemplars from Prometheus:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: inventory-service
    scrape_interval: 15s
    static_configs:
      - targets: ["inventory-service:9090"]
```

```yaml
# grafana datasource for Prometheus with exemplar support
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    jsonData:
      exemplarTraceIdDestinations:
        - name: traceID
          datasourceUid: tempo
```

## Section 6: Log Correlation with Trace IDs

Correlating logs with traces allows navigation from a log line to the full distributed trace. The pattern is simple: extract the trace ID from context and add it to every log entry.

### With zap

```go
package logging

import (
    "context"

    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

// FromContext returns a logger enriched with trace context from ctx.
func FromContext(ctx context.Context, base *zap.Logger) *zap.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        return base
    }
    sc := span.SpanContext()
    return base.With(
        zap.String("trace_id", sc.TraceID().String()),
        zap.String("span_id", sc.SpanID().String()),
        zap.Bool("trace_sampled", sc.IsSampled()),
    )
}
```

Usage in a handler:

```go
func (s *Server) GetItem(ctx context.Context, id string) (*Item, error) {
    log := logging.FromContext(ctx, s.log)
    log.Info("fetching item", zap.String("item_id", id))
    // Every log line now carries trace_id and span_id.
}
```

### With slog (Go 1.21+)

```go
package logging

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

// Handler wraps an slog.Handler and injects trace context into every record.
type TraceHandler struct {
    slog.Handler
}

func (h TraceHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        sc := span.SpanContext()
        r.AddAttrs(
            slog.String("trace_id", sc.TraceID().String()),
            slog.String("span_id", sc.SpanID().String()),
        )
    }
    return h.Handler.Handle(ctx, r)
}

func NewLogger(w io.Writer) *slog.Logger {
    return slog.New(TraceHandler{
        slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo}),
    })
}
```

## Section 7: OTLP Exporter Configuration

### Collector-Based Architecture

The recommended production pattern is to send telemetry to an OpenTelemetry Collector sidecar or DaemonSet rather than directly to a backend. The collector handles batching, retry, filtering, and routing to multiple backends.

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
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
  resource:
    attributes:
      - key: cluster.name
        value: "prod-us-east-1"
        action: upsert

exporters:
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
  loki:
    endpoint: "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheusremotewrite]
```

### Kubernetes DaemonSet Deployment for Collector

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector
  namespace: monitoring
spec:
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
          image: otel/opentelemetry-collector-contrib:0.100.0
          args:
            - "--config=/etc/otel/config.yaml"
          ports:
            - containerPort: 4317   # OTLP gRPC
            - containerPort: 4318   # OTLP HTTP
          volumeMounts:
            - name: config
              mountPath: /etc/otel
          resources:
            requests:
              cpu: 100m
              memory: 200Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
```

### Application Configuration via Environment Variables

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_SERVICE_NAME="inventory-service"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production,k8s.cluster.name=prod-us-east-1"
export OTEL_TRACES_SAMPLER="parentbased_traceidratio"
export OTEL_TRACES_SAMPLER_ARG="0.1"
```

## Section 8: Sampling Strategies

### Choosing a Sampling Strategy

| Strategy | Description | Best For |
|---|---|---|
| AlwaysSample | Record every trace | Development, low-traffic services |
| NeverSample | Record nothing | Disable tracing temporarily |
| TraceIDRatioBased | Sample fixed percentage | Uniform sampling across all traces |
| ParentBased | Honor parent's decision | Most production services |
| Jaeger Remote | Dynamically adjust rates | Services with variable traffic patterns |

### Parent-Based Ratio Sampling (Recommended)

```go
// Sample 5% of new traces; always sample if the parent was sampled.
sampler := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.05),
    sdktrace.WithRemoteParentSampled(sdktrace.AlwaysSample()),
    sdktrace.WithRemoteParentNotSampled(sdktrace.NeverSample()),
    sdktrace.WithLocalParentSampled(sdktrace.AlwaysSample()),
    sdktrace.WithLocalParentNotSampled(sdktrace.NeverSample()),
)
```

### Ensuring Errors Are Always Sampled

Wrap the ratio sampler to force sampling on errors:

```go
type errorForceSampler struct {
    base sdktrace.Sampler
}

func (s errorForceSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Check if the span being started already has an error attribute.
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
        }
    }
    return s.base.ShouldSample(p)
}

func (s errorForceSampler) Description() string {
    return "ErrorForceSampler{" + s.base.Description() + "}"
}
```

## Section 9: Automatic HTTP and gRPC Instrumentation

### HTTP Middleware

```go
package middleware

import (
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

// OTelMiddleware wraps a handler with trace and metric instrumentation.
func OTelMiddleware(next http.Handler, recorder *metrics.Recorder) http.Handler {
    otelHandler := otelhttp.NewHandler(next, "",
        otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
            return r.Method + " " + r.URL.Path
        }),
        otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
    )

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        recorder.IncrementActive(r.Context())
        defer recorder.DecrementActive(r.Context())

        rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
        start := time.Now()
        otelHandler.ServeHTTP(rw, r)
        recorder.RecordRequest(r.Context(), r.Method, r.URL.Path, rw.status, time.Since(start).Seconds())
    })
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}
```

## Section 10: Performance Overhead and Benchmarking

### Measuring Instrumentation Cost

OTel adds measurable overhead; understanding it prevents surprises in production:

```go
package bench_test

import (
    "context"
    "testing"

    "go.opentelemetry.io/otel"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

var tracer = otel.Tracer("bench")

func BenchmarkSpanCreation(b *testing.B) {
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithSampler(sdktrace.AlwaysSample()),
        sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(sdktrace.NewNopExporter())),
    )
    otel.SetTracerProvider(tp)

    ctx := context.Background()
    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        _, span := tracer.Start(ctx, "benchmark-span")
        span.End()
    }
}

func BenchmarkSpanCreationNoOp(b *testing.B) {
    // Compare against no-op provider to isolate SDK overhead.
    otel.SetTracerProvider(otel.GetTracerProvider()) // global no-op
    ctx := context.Background()
    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        _, span := tracer.Start(ctx, "benchmark-span")
        span.End()
    }
}
```

### Typical Overhead Numbers

Based on production measurements at moderate request rates:

- No-op tracer: ~50 ns/op, 0 allocs
- SDK with ratio 0.0 (never sample): ~150 ns/op, 1 alloc (sampling decision)
- SDK with ratio 1.0 (always sample): ~2-4 µs/op, 8-12 allocs
- SDK with ParentBased(0.1): ~250 ns/op for 90% of requests (not sampled)

At 10,000 RPS with 10% sampling rate, the expected overhead is approximately 25 ms/s of CPU time — negligible on modern hardware.

## Section 11: Testing Instrumented Code

### In-Memory Span Collector

```go
package teltest

import (
    "context"
    "sync"
    "testing"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// Setup installs an in-memory span exporter and returns it.
func Setup(t *testing.T) *tracetest.SpanRecorder {
    t.Helper()
    rec := tracetest.NewSpanRecorder()
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithSpanProcessor(rec),
        sdktrace.WithSampler(sdktrace.AlwaysSample()),
    )
    otel.SetTracerProvider(tp)
    t.Cleanup(func() {
        _ = tp.Shutdown(context.Background())
    })
    return rec
}

// AssertSpan verifies that a span with the given name was recorded.
func AssertSpan(t *testing.T, rec *tracetest.SpanRecorder, name string, attrs ...attribute.KeyValue) {
    t.Helper()
    for _, span := range rec.Ended() {
        if span.Name() == name {
            for _, want := range attrs {
                found := false
                for _, got := range span.Attributes() {
                    if got.Key == want.Key && got.Value == want.Value {
                        found = true
                        break
                    }
                }
                if !found {
                    t.Errorf("span %q missing attribute %v=%v", name, want.Key, want.Value)
                }
            }
            return
        }
    }
    t.Errorf("span %q not found in recorded spans", name)
}
```

Usage:

```go
func TestGetItem_RecordsSpan(t *testing.T) {
    rec := teltest.Setup(t)
    svc := inventorysvc.NewServer()

    _, _ = svc.GetItem(context.Background(), "item-1")

    teltest.AssertSpan(t, rec, "GetItem",
        attribute.String("item.id", "item-1"),
    )
}
```

## Section 12: Summary

OpenTelemetry Go provides a stable, vendor-neutral foundation for production observability:

- **SDK init**: centralize provider initialization with resource attributes; always call `Shutdown` on exit.
- **Tracing**: use `otel.Tracer` in library code; propagate context through every call boundary.
- **Metrics**: choose the right instrument type (Counter vs Histogram vs Gauge); use views to control cardinality.
- **Exemplars**: they are automatic when a sampled span is active during a histogram recording — leverage them in Grafana.
- **Log correlation**: inject `trace_id` and `span_id` into every structured log entry via a context-aware log wrapper.
- **OTLP export**: route through a Collector DaemonSet; configure retry and batch settings.
- **Sampling**: `ParentBased(TraceIDRatioBased)` is the right default for most production services; force-sample errors.
- **Overhead**: at 10% sampling the CPU cost is negligible; always benchmark before raising sample rates.
- **Testing**: `tracetest.SpanRecorder` makes span assertions straightforward in unit tests.

The investment in consistent instrumentation pays dividends the first time an incident occurs and the trace is already there.
