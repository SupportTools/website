---
title: "Go Distributed Tracing with OpenTelemetry: End-to-End Request Correlation"
date: 2030-07-30T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Distributed Tracing", "Observability", "Jaeger", "Tempo", "Monitoring"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise OpenTelemetry tracing in Go covering tracer provider setup, span creation and propagation, baggage, sampling strategies, multi-exporter configuration, correlating traces with logs and metrics, and Jaeger and Tempo deployment."
more_link: "yes"
url: "/go-distributed-tracing-opentelemetry-end-to-end-request-correlation/"
---

Distributed tracing provides the missing piece in microservice observability: understanding the causal chain of operations that contribute to a single user request as it traverses multiple services. While logs provide event detail and metrics provide aggregated signals, only traces capture the complete timeline of a request — which service called which other service, how long each operation took, and where errors originated. This post builds a production-grade OpenTelemetry implementation in Go with multi-backend export and deep integration with logging and metrics pipelines.

<!--more-->

## OpenTelemetry Architecture

OpenTelemetry (OTel) standardizes the collection of traces, metrics, and logs through a vendor-neutral API and SDK. In Go, the architecture consists of:

- **API**: Stable interfaces (`go.opentelemetry.io/otel`)
- **SDK**: Implementation with configurable exporters and samplers
- **Exporters**: Bridges to Jaeger, Zipkin, Tempo, Honeycomb, Datadog, OTLP collectors
- **Propagators**: W3C TraceContext, B3 for cross-process context

### Trace Data Model

```
Trace (TraceID: abc123)
├── Span: "POST /api/orders" [0ms → 250ms]
│   ├── Span: "validate_request" [5ms → 15ms]
│   ├── Span: "db.query orders" [20ms → 80ms]
│   │   └── Span: "db.connect" [20ms → 25ms]
│   ├── Span: "inventory.check" [85ms → 130ms]  ← gRPC call
│   └── Span: "payment.charge" [135ms → 240ms]  ← HTTP call
│       └── Span: "stripe.create_charge" [140ms → 235ms]
```

Each span has:
- `TraceID`: Identifies the entire distributed trace
- `SpanID`: Identifies this specific span
- `ParentSpanID`: Links to the parent span
- `Name`, `Kind`, `Status`
- `Attributes`: Key-value metadata
- `Events`: Time-stamped messages within the span
- `Links`: References to other spans (for async operations)

## Initializing the Tracer Provider

### Complete TracerProvider Setup

```go
// pkg/telemetry/tracer.go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string  // e.g., "otel-collector:4317"
    SamplingRate   float64 // 0.0 to 1.0
    UseGRPC        bool    // false = HTTP/protobuf
}

// InitTracerProvider initializes the global OTel TracerProvider.
// Returns a shutdown function to be deferred by the caller.
func InitTracerProvider(ctx context.Context, cfg Config, logger *zap.Logger) (func(context.Context) error, error) {
    // Build resource with service identity
    res, err := resource.New(ctx,
        resource.WithFromEnv(),
        resource.WithProcess(),
        resource.WithOS(),
        resource.WithHost(),
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    // Create exporter
    exporter, err := createExporter(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("create exporter: %w", err)
    }

    // Configure sampling strategy
    sampler := configureSampler(cfg.SamplingRate, cfg.Environment)

    // Build the TracerProvider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithSampler(sampler),
        sdktrace.WithResource(res),
    )

    // Register as the global TracerProvider
    otel.SetTracerProvider(tp)

    // Register W3C TraceContext and Baggage propagators
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    logger.Info("tracer provider initialized",
        zap.String("service", cfg.ServiceName),
        zap.Float64("sampling_rate", cfg.SamplingRate),
        zap.String("endpoint", cfg.OTLPEndpoint),
    )

    return tp.Shutdown, nil
}

func createExporter(ctx context.Context, cfg Config) (sdktrace.SpanExporter, error) {
    if cfg.UseGRPC {
        conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
            grpc.WithTransportCredentials(insecure.NewCredentials()),
            grpc.WithBlock(),
        )
        if err != nil {
            return nil, fmt.Errorf("dial OTLP gRPC: %w", err)
        }
        return otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    }

    return otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(cfg.OTLPEndpoint),
        otlptracehttp.WithInsecure(),
        otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
            Enabled:         true,
            InitialInterval: 1 * time.Second,
            MaxInterval:     10 * time.Second,
            MaxElapsedTime:  30 * time.Second,
        }),
    )
}

func configureSampler(rate float64, environment string) sdktrace.Sampler {
    // Always sample in development
    if environment == "development" {
        return sdktrace.AlwaysSample()
    }

    // Parent-based sampling: if parent is sampled, child is sampled
    // This ensures traces are complete when any span is sampled
    return sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(rate),
        sdktrace.WithRemoteParentSampled(sdktrace.AlwaysSample()),
        sdktrace.WithRemoteParentNotSampled(sdktrace.NeverSample()),
        sdktrace.WithLocalParentSampled(sdktrace.AlwaysSample()),
        sdktrace.WithLocalParentNotSampled(sdktrace.NeverSample()),
    )
}
```

### Application Bootstrap

```go
// main.go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"

    "github.com/example/myservice/pkg/telemetry"
    "go.uber.org/zap"
)

func main() {
    ctx, cancel := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer cancel()

    logger, _ := zap.NewProduction()
    defer logger.Sync()

    shutdownTracer, err := telemetry.InitTracerProvider(ctx, telemetry.Config{
        ServiceName:    "order-service",
        ServiceVersion: "2.3.1",
        Environment:    os.Getenv("ENVIRONMENT"),
        OTLPEndpoint:   os.Getenv("OTLP_ENDPOINT"),
        SamplingRate:   0.1,  // 10% of traces
        UseGRPC:        true,
    }, logger)
    if err != nil {
        log.Fatalf("init tracer: %v", err)
    }
    defer func() {
        if err := shutdownTracer(context.Background()); err != nil {
            logger.Error("shutdown tracer", zap.Error(err))
        }
    }()

    // ... start HTTP server, etc.
}
```

## Creating and Managing Spans

### Span Creation Patterns

```go
// internal/order/service.go
package order

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("order-service",
    trace.WithInstrumentationVersion("2.3.1"),
)

type OrderService struct {
    db        *Database
    inventory InventoryClient
    payments  PaymentClient
}

func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    ctx, span := tracer.Start(ctx, "CreateOrder",
        trace.WithSpanKind(trace.SpanKindInternal),
        trace.WithAttributes(
            attribute.String("order.customer_id", req.CustomerID),
            attribute.Int("order.item_count", len(req.Items)),
        ),
    )
    defer span.End()

    // Add structured events to the span
    span.AddEvent("validating request")

    if err := s.validateRequest(req); err != nil {
        span.RecordError(err, trace.WithAttributes(
            attribute.String("validation.error", err.Error()),
        ))
        span.SetStatus(codes.Error, "request validation failed")
        return nil, fmt.Errorf("invalid request: %w", err)
    }

    span.AddEvent("checking inventory",
        trace.WithAttributes(
            attribute.Int("inventory.items_to_check", len(req.Items)),
        ),
    )

    // Check inventory — propagates trace context to inventory service
    available, err := s.inventory.CheckAvailability(ctx, req.Items)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "inventory check failed")
        return nil, err
    }

    if !available {
        span.SetAttributes(attribute.Bool("order.inventory_available", false))
        span.SetStatus(codes.Error, "items unavailable")
        return nil, ErrItemsUnavailable
    }

    // Database insert
    order, err := s.persistOrder(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "persistence failed")
        return nil, err
    }

    span.SetAttributes(
        attribute.String("order.id", order.ID),
        attribute.Float64("order.total_amount", float64(order.TotalCents)/100),
        attribute.Bool("order.inventory_available", true),
    )
    span.SetStatus(codes.Ok, "")
    return order, nil
}

func (s *OrderService) persistOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    ctx, span := tracer.Start(ctx, "db.InsertOrder",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.name", "orders"),
            attribute.String("db.operation", "INSERT"),
            attribute.String("db.table", "orders"),
        ),
    )
    defer span.End()

    // Execute database operation
    order, err := s.db.InsertOrder(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetAttributes(attribute.String("db.order_id", order.ID))
    return order, nil
}
```

### Span Links for Async Operations

When a span relates to another span asynchronously (e.g., processing a queue message):

```go
func (s *OrderProcessor) ProcessOrderEvent(ctx context.Context, event OrderEvent) error {
    // The publish span context is carried in the message header
    publishSpanCtx := extractTraceContext(event.Headers)

    ctx, span := tracer.Start(ctx, "ProcessOrderEvent",
        trace.WithSpanKind(trace.SpanKindConsumer),
        // Link to the publishing span, not parent it
        // This represents a causal relationship without parent-child hierarchy
        trace.WithLinks(trace.Link{
            SpanContext: publishSpanCtx,
            Attributes: []attribute.KeyValue{
                attribute.String("link.type", "message.source"),
            },
        }),
    )
    defer span.End()

    span.SetAttributes(
        attribute.String("messaging.system", "kafka"),
        attribute.String("messaging.destination", "order-events"),
        attribute.String("messaging.message.id", event.ID),
        attribute.String("messaging.consumer_group", "order-processor"),
    )

    return s.processEvent(ctx, event)
}
```

## Context Propagation

### HTTP Client Instrumentation

Propagating trace context in outbound HTTP calls:

```go
// pkg/httpclient/client.go
package httpclient

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/propagation"
)

// NewTracedClient creates an HTTP client with OTel instrumentation.
func NewTracedClient(serviceName string) *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport,
            otelhttp.WithPropagators(otel.GetTextMapPropagator()),
            otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
                return r.Method + " " + r.URL.Path
            }),
            otelhttp.WithClientTrace(func(ctx context.Context) *httptrace.ClientTrace {
                return otelhttptrace.NewClientTrace(ctx)
            }),
        ),
    }
}

// Manually inject propagation headers when not using otelhttp
func InjectTraceHeaders(ctx context.Context, req *http.Request) {
    otel.GetTextMapPropagator().Inject(ctx,
        propagation.HeaderCarrier(req.Header),
    )
}
```

### HTTP Server Instrumentation

```go
// pkg/httpserver/middleware.go
package httpserver

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel/attribute"
)

// OTelMiddleware wraps handlers with tracing, adding common attributes.
func OTelMiddleware(serviceName string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return otelhttp.NewHandler(
            http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                // Add common attributes to the server span
                span := trace.SpanFromContext(r.Context())
                span.SetAttributes(
                    attribute.String("http.user_agent", r.UserAgent()),
                    attribute.String("http.request_id", r.Header.Get("X-Request-ID")),
                    attribute.String("user.id", r.Header.Get("X-User-ID")),
                )
                next.ServeHTTP(w, r)
            }),
            serviceName,
            otelhttp.WithPropagators(otel.GetTextMapPropagator()),
            otelhttp.WithMessageEvents(
                otelhttp.ReadEvents,
                otelhttp.WriteEvents,
            ),
        )
    }
}
```

### gRPC Instrumentation

```go
// pkg/grpc/interceptors.go
package grpc

import (
    "google.golang.org/grpc"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

// Server interceptors with OTel
func NewTracedServer(opts ...grpc.ServerOption) *grpc.Server {
    return grpc.NewServer(append(opts,
        grpc.StatsHandler(otelgrpc.NewServerHandler(
            otelgrpc.WithMessageEvents(
                otelgrpc.ReceivedEvents,
                otelgrpc.SentEvents,
            ),
        )),
    )...)
}

// Client dial options with OTel
func DialTracedService(ctx context.Context, target string, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
    return grpc.DialContext(ctx, target,
        append(opts,
            grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
        )...,
    )
}
```

## Baggage: Cross-Cutting Request Data

Baggage propagates key-value pairs across the entire distributed trace, making them available in every span without explicit passing:

```go
// pkg/telemetry/baggage.go
package telemetry

import (
    "context"

    "go.opentelemetry.io/otel/baggage"
)

const (
    BaggageTenantID   = "tenant.id"
    BaggageUserID     = "user.id"
    BaggageRequestID  = "request.id"
    BaggageRegion     = "cloud.region"
)

// InjectBaggage adds standard request context to OTel baggage.
// Call this at the entry point of each request.
func InjectBaggage(ctx context.Context, tenantID, userID, requestID, region string) (context.Context, error) {
    members := []baggage.Member{}

    add := func(key, value string) {
        if value == "" {
            return
        }
        m, err := baggage.NewMember(key, value)
        if err == nil {
            members = append(members, m)
        }
    }

    add(BaggageTenantID, tenantID)
    add(BaggageUserID, userID)
    add(BaggageRequestID, requestID)
    add(BaggageRegion, region)

    b, err := baggage.New(members...)
    if err != nil {
        return ctx, err
    }
    return baggage.ContextWithBaggage(ctx, b), nil
}

// ExtractBaggageValue retrieves a baggage value from context.
func ExtractBaggageValue(ctx context.Context, key string) string {
    return baggage.FromContext(ctx).Member(key).Value()
}

// AddBaggageToSpan copies all baggage members as span attributes.
// Useful for making baggage values queryable in trace backends.
func AddBaggageToSpan(ctx context.Context) {
    span := trace.SpanFromContext(ctx)
    b := baggage.FromContext(ctx)
    for _, m := range b.Members() {
        span.SetAttributes(attribute.String("baggage."+m.Key(), m.Value()))
    }
}
```

## Sampling Strategies

### Custom Sampler Implementation

```go
// pkg/telemetry/sampler.go
package telemetry

import (
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/trace"
)

// PriorityAwareSampler samples at different rates based on span attributes.
// High-priority operations (errors, slow operations) are always sampled.
type PriorityAwareSampler struct {
    defaultSampler sdktrace.Sampler
    errorSampler   sdktrace.Sampler
}

func NewPriorityAwareSampler(defaultRate float64) *PriorityAwareSampler {
    return &PriorityAwareSampler{
        defaultSampler: sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(defaultRate),
        ),
        errorSampler: sdktrace.AlwaysSample(),
    }
}

func (s *PriorityAwareSampler) ShouldSample(params sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Check if this is a health check endpoint — never sample
    for _, attr := range params.Attributes {
        if attr.Key == "http.target" {
            v := attr.Value.AsString()
            if v == "/healthz" || v == "/ready" || v == "/metrics" {
                return sdktrace.SamplingResult{Decision: sdktrace.Drop}
            }
        }
        // Always sample if there's an error status
        if attr.Key == "error" && attr.Value.AsBool() {
            return s.errorSampler.ShouldSample(params)
        }
    }

    return s.defaultSampler.ShouldSample(params)
}

func (s *PriorityAwareSampler) Description() string {
    return "PriorityAwareSampler"
}

// TailSampler (simplified): decisions made after the trace is complete
// In practice, use OpenTelemetry Collector's tail sampling processor
type TailSamplingConfig struct {
    AlwaysSampleIfError    bool
    AlwaysSampleIfLatency  time.Duration  // Sample if > this latency
    BaseRate               float64
}
```

## Correlating Traces with Logs

The most powerful observability pattern combines trace IDs in log entries, enabling navigation from logs to traces:

```go
// pkg/telemetry/logger.go
package telemetry

import (
    "context"

    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

// TraceFields extracts OTel trace context for structured log fields.
func TraceFields(ctx context.Context) []zap.Field {
    span := trace.SpanFromContext(ctx)
    if !span.IsRecording() {
        return nil
    }

    spanCtx := span.SpanContext()
    fields := []zap.Field{
        zap.String("trace_id", spanCtx.TraceID().String()),
        zap.String("span_id", spanCtx.SpanID().String()),
        zap.Bool("trace_sampled", spanCtx.IsSampled()),
    }

    return fields
}

// TracedLogger wraps a zap.Logger to automatically include trace context.
type TracedLogger struct {
    logger *zap.Logger
}

func NewTracedLogger(logger *zap.Logger) *TracedLogger {
    return &TracedLogger{logger: logger}
}

func (l *TracedLogger) Info(ctx context.Context, msg string, fields ...zap.Field) {
    l.logger.Info(msg, append(TraceFields(ctx), fields...)...)
}

func (l *TracedLogger) Error(ctx context.Context, msg string, fields ...zap.Field) {
    l.logger.Error(msg, append(TraceFields(ctx), fields...)...)
}

func (l *TracedLogger) Warn(ctx context.Context, msg string, fields ...zap.Field) {
    l.logger.Warn(msg, append(TraceFields(ctx), fields...)...)
}
```

### Loki Log Correlation

Grafana Loki supports trace-to-log correlation when trace IDs are included in logs:

```yaml
# Loki datasource configured with derived fields for trace correlation
# In Grafana data source settings:
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    url: http://loki:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"([a-f0-9]{32})"'
          name: TraceID
          url: '$${__value.raw}'
          urlDisplayLabel: View in Tempo
```

### Metrics Exemplars

OpenTelemetry supports exemplars — trace IDs embedded in metric samples — enabling metrics-to-trace navigation:

```go
// pkg/telemetry/metrics.go
package telemetry

import (
    "context"

    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

// RecordWithExemplar records a histogram observation with trace context as exemplar.
// When exported to Prometheus, this appears as an exemplar on the metric.
func RecordWithExemplar(ctx context.Context, histogram metric.Float64Histogram, value float64, attrs ...metric.MeasurementOption) {
    span := trace.SpanFromContext(ctx)
    spanCtx := span.SpanContext()

    opts := attrs
    if spanCtx.IsValid() {
        opts = append(opts,
            metric.WithAttributes(
                attribute.String("trace_id", spanCtx.TraceID().String()),
                attribute.String("span_id", spanCtx.SpanID().String()),
            ),
        )
    }

    histogram.Record(ctx, value, opts...)
}
```

## Multi-Exporter Configuration

For environments with multiple observability backends:

```go
// pkg/telemetry/multi_exporter.go
package telemetry

import (
    "context"

    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// MultiSpanExporter fans out spans to multiple exporters.
type MultiSpanExporter struct {
    exporters []sdktrace.SpanExporter
}

func NewMultiSpanExporter(exporters ...sdktrace.SpanExporter) *MultiSpanExporter {
    return &MultiSpanExporter{exporters: exporters}
}

func (m *MultiSpanExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
    var lastErr error
    for _, exporter := range m.exporters {
        if err := exporter.ExportSpans(ctx, spans); err != nil {
            lastErr = err
        }
    }
    return lastErr
}

func (m *MultiSpanExporter) Shutdown(ctx context.Context) error {
    var lastErr error
    for _, exporter := range m.exporters {
        if err := exporter.Shutdown(ctx); err != nil {
            lastErr = err
        }
    }
    return lastErr
}
```

## Jaeger Deployment for Development

```yaml
# jaeger-all-in-one.yaml (development only)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
        - name: jaeger
          image: jaegertracing/all-in-one:1.60
          env:
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
            - name: SPAN_STORAGE_TYPE
              value: memory
            - name: MEMORY_MAX_TRACES
              value: "100000"
          ports:
            - containerPort: 16686   # UI
              name: ui
            - containerPort: 4317    # OTLP gRPC
              name: otlp-grpc
            - containerPort: 4318    # OTLP HTTP
              name: otlp-http
            - containerPort: 14268   # Jaeger HTTP
              name: jaeger-http
          resources:
            requests:
              cpu: 100m
              memory: 512Mi
            limits:
              cpu: 500m
              memory: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: monitoring
spec:
  selector:
    app: jaeger
  ports:
    - name: ui
      port: 16686
    - name: otlp-grpc
      port: 4317
    - name: otlp-http
      port: 4318
```

## Grafana Tempo for Production

```yaml
# tempo-values.yaml for Helm deployment
tempo:
  global_overrides:
    max_traces_per_user: 10000000
  compactor:
    compaction:
      block_retention: 720h  # 30 days
  distributor:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
  ingester:
    max_block_duration: 5m
    trace_idle_period: 10s
  storage:
    trace:
      backend: s3
      s3:
        bucket: my-tempo-traces
        endpoint: s3.amazonaws.com
        region: us-east-1
        access_key: <aws-access-key-id>
        secret_key: <aws-secret-access-key>

serviceMonitor:
  enabled: true
  namespace: monitoring

metricsGenerator:
  enabled: true
  config:
    storage:
      path: /var/tempo/generator/wal
      remote_write:
        - url: http://prometheus:9090/api/v1/write
          send_exemplars: true
```

## OpenTelemetry Collector Configuration

The OTel Collector acts as a central aggregation and routing layer:

```yaml
# otel-collector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      # Remove health check spans from sampling
      filter/drop_healthchecks:
        error_mode: ignore
        traces:
          span:
            - 'attributes["http.target"] == "/healthz"'
            - 'attributes["http.target"] == "/ready"'
            - 'attributes["http.target"] == "/metrics"'

      # Tail-based sampling: keep errors and slow traces
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          - name: always-sample-errors
            type: status_code
            status_code:
              status_codes: [ERROR]
          - name: always-sample-slow
            type: latency
            latency:
              threshold_ms: 1000
          - name: rate-limiting
            type: rate_limiting
            rate_limiting:
              spans_per_second: 1000

      # Enrich with k8s metadata
      k8sattributes:
        extract:
          metadata:
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.namespace.name
            - k8s.node.name
            - k8s.deployment.name

      batch:
        send_batch_size: 1024
        timeout: 5s
        send_batch_max_size: 2048

      memory_limiter:
        check_interval: 1s
        limit_mib: 1500
        spike_limit_mib: 512

    exporters:
      otlp/tempo:
        endpoint: tempo:4317
        tls:
          insecure: true

      # Also export to Jaeger for comparison
      otlp/jaeger:
        endpoint: jaeger-collector:4317
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors:
            - memory_limiter
            - filter/drop_healthchecks
            - k8sattributes
            - tail_sampling
            - batch
          exporters: [otlp/tempo, otlp/jaeger]
```

## Verifying Instrumentation

```bash
# Port-forward Jaeger UI
kubectl port-forward -n monitoring svc/jaeger 16686:16686

# Generate a test trace
curl -H "X-Request-ID: test-$(date +%s)" \
     http://localhost:8080/api/orders \
     -d '{"customer_id": "cust-123", "items": [{"product_id": "prod-456", "quantity": 1}]}' \
     -H "Content-Type: application/json"

# Verify trace context propagation
curl -v http://localhost:8080/api/orders \
     2>&1 | grep -i "traceparent\|tracestate"

# Check OTel collector metrics
curl -s http://otel-collector:8888/metrics | \
    grep -E "otelcol_receiver|otelcol_exporter|otelcol_processor"
```

## Summary

OpenTelemetry provides a complete, vendor-neutral foundation for distributed tracing in Go services. The patterns covered — TracerProvider initialization with parent-based sampling, span creation with semantic conventions, context propagation over HTTP and gRPC, baggage for cross-cutting concerns, custom samplers for tail-based decisions, trace-log correlation with exemplars, and multi-backend export via the OTel Collector — compose into an observability system that scales from development to enterprise production. The critical investment is consistent instrumentation from the first HTTP handler to the last database query, ensuring every user request generates a complete causal trace regardless of which services participate.
