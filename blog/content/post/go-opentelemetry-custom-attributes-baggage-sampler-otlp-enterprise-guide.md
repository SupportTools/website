---
title: "Go Telemetry with OpenTelemetry: Custom Attributes, Baggage Propagation, Sampler Configuration, and OTLP Exporter Tuning"
date: 2032-02-04T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "OTLP", "Distributed Tracing", "Observability", "Prometheus", "Baggage", "Sampling"]
categories: ["Go", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Go telemetry with OpenTelemetry SDK: setting custom span attributes, propagating baggage across service boundaries, configuring head-based and tail-based samplers, and tuning the OTLP gRPC/HTTP exporters for high-throughput environments."
more_link: "yes"
url: "/go-opentelemetry-custom-attributes-baggage-sampler-otlp-enterprise-guide/"
---

OpenTelemetry has become the de facto standard for instrumentation in modern Go services, but the difference between a basic integration and a production-grade one is significant. Default configurations are designed for correctness, not performance. This guide covers the advanced features that matter at scale: custom semantic attributes, baggage propagation across gRPC and HTTP boundaries, parent-based and probabilistic sampling configurations, and the full range of OTLP exporter knobs that determine whether your telemetry pipeline survives production load.

<!--more-->

# Go Telemetry with OpenTelemetry: Enterprise Configuration Guide

## SDK Version and Module Setup

This guide targets the OpenTelemetry Go SDK v1.28+. The SDK follows semantic versioning for the stable APIs and uses the `go.opentelemetry.io` module path.

```go
// go.mod
module github.com/example/my-service

go 1.22

require (
    go.opentelemetry.io/otel v1.28.0
    go.opentelemetry.io/otel/sdk v1.28.0
    go.opentelemetry.io/otel/trace v1.28.0
    go.opentelemetry.io/otel/metric v1.28.0
    go.opentelemetry.io/otel/sdk/metric v1.28.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.28.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.28.0
    go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.28.0
    go.opentelemetry.io/otel/propagators/b3 v1.28.0
    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.55.0
    go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.55.0
    go.opentelemetry.io/otel/semconv/v1.26.0 v1.26.0
    google.golang.org/grpc v1.65.0
)
```

## Initializing the SDK with Full Resource Attribution

The `Resource` is the most important configuration element — it identifies the service to all downstream consumers (Jaeger, Tempo, Datadog, etc.).

```go
package telemetry

import (
    "context"
    "fmt"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName        string
    ServiceVersion     string
    ServiceNamespace   string
    DeploymentEnv      string
    OTLPEndpoint       string
    SamplingRatio      float64
    MaxExportBatchSize int
    ExportTimeout      time.Duration
    MetricInterval     time.Duration
}

type SDK struct {
    TracerProvider *sdktrace.TracerProvider
    MeterProvider  *sdkmetric.MeterProvider
    shutdown       []func(context.Context) error
}

func NewSDK(ctx context.Context, cfg Config) (*SDK, error) {
    res, err := buildResource(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("build resource: %w", err)
    }

    conn, err := grpc.NewClient(cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("grpc dial otlp: %w", err)
    }

    tp, err := buildTracerProvider(ctx, conn, res, cfg)
    if err != nil {
        return nil, fmt.Errorf("build tracer provider: %w", err)
    }

    mp, err := buildMeterProvider(ctx, conn, res, cfg)
    if err != nil {
        return nil, fmt.Errorf("build meter provider: %w", err)
    }

    // Register global providers
    otel.SetTracerProvider(tp)
    otel.SetMeterProvider(mp)
    otel.SetTextMapPropagator(buildPropagator())

    sdk := &SDK{
        TracerProvider: tp,
        MeterProvider:  mp,
        shutdown: []func(context.Context) error{
            tp.Shutdown,
            mp.Shutdown,
            func(_ context.Context) error {
                return conn.Close()
            },
        },
    }
    return sdk, nil
}

func (s *SDK) Shutdown(ctx context.Context) error {
    var errs []error
    for _, fn := range s.shutdown {
        if err := fn(ctx); err != nil {
            errs = append(errs, err)
        }
    }
    if len(errs) > 0 {
        return fmt.Errorf("sdk shutdown errors: %v", errs)
    }
    return nil
}

func buildResource(ctx context.Context, cfg Config) (*resource.Resource, error) {
    hostname, _ := os.Hostname()
    return resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.ServiceNamespace(cfg.ServiceNamespace),
            semconv.DeploymentEnvironment(cfg.DeploymentEnv),
            semconv.HostName(hostname),
            attribute.String("k8s.pod.name", os.Getenv("POD_NAME")),
            attribute.String("k8s.namespace.name", os.Getenv("POD_NAMESPACE")),
            attribute.String("k8s.node.name", os.Getenv("NODE_NAME")),
        ),
        resource.WithProcess(),
        resource.WithOS(),
        resource.WithContainer(),
    )
}

func buildPropagator() propagation.TextMapPropagator {
    return propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},  // W3C TraceContext (primary)
        propagation.Baggage{},       // W3C Baggage
        // b3.New(),                 // Uncomment if proxies require B3
    )
}
```

## Sampler Configuration

### Understanding Sampling Strategies

Sampling is the single most impactful performance lever in distributed tracing. Four strategies are available in the Go SDK:

| Sampler | Use Case |
|---|---|
| `AlwaysSample` | Development/debugging only |
| `NeverSample` | Disable tracing completely |
| `TraceIDRatioBased` | Probabilistic, ignores parent decision |
| `ParentBased` | Follows parent's sampling decision; configurable root behavior |

### Parent-Based Sampling (Recommended for Production)

```go
func buildSampler(ratio float64) sdktrace.Sampler {
    // ParentBased ensures that if an upstream service sampled the trace,
    // we continue sampling it. If not sampled, we respect that too.
    // The root sampler kicks in only when there is no parent span.
    return sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(ratio),
        // When parent span was sampled (remote), always sample
        sdktrace.WithRemoteSampled(sdktrace.AlwaysSample()),
        // When parent span was not sampled (remote), never sample
        sdktrace.WithRemoteNotSampled(sdktrace.NeverSample()),
        // When parent span was sampled (local), always sample
        sdktrace.WithLocalSampled(sdktrace.AlwaysSample()),
        // When parent span was not sampled (local), never sample
        sdktrace.WithLocalNotSampled(sdktrace.NeverSample()),
    )
}
```

### Custom Rule-Based Sampler

For environments where you want to always sample error traces regardless of ratio:

```go
// PrioritySampler always samples error spans and high-priority operations,
// and applies ratio-based sampling to everything else.
type PrioritySampler struct {
    base sdktrace.Sampler
}

func NewPrioritySampler(ratio float64) sdktrace.Sampler {
    return &PrioritySampler{
        base: sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio)),
    }
}

func (s *PrioritySampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample spans with error attribute
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{
                Decision:   sdktrace.RecordAndSample,
                Attributes: p.Attributes,
                Tracestate: p.ParentContext.TraceState(),
            }
        }
    }

    // Always sample payment and auth operations
    if p.Name == "payment.process" || p.Name == "auth.validate" {
        return sdktrace.SamplingResult{
            Decision:   sdktrace.RecordAndSample,
            Attributes: p.Attributes,
            Tracestate: p.ParentContext.TraceState(),
        }
    }

    return s.base.ShouldSample(p)
}

func (s *PrioritySampler) Description() string {
    return fmt.Sprintf("PrioritySampler{base=%s}", s.base.Description())
}
```

## OTLP Exporter Tuning

### gRPC Exporter with Full Configuration

```go
func buildTracerProvider(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
    cfg Config,
) (*sdktrace.TracerProvider, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
        otlptracegrpc.WithTimeout(cfg.ExportTimeout),
        otlptracegrpc.WithRetry(otlptracegrpc.RetryConfig{
            Enabled:         true,
            InitialInterval: 300 * time.Millisecond,
            MaxInterval:     5 * time.Second,
            MaxElapsedTime:  30 * time.Second,
        }),
        otlptracegrpc.WithHeaders(map[string]string{
            "x-service-name": cfg.ServiceName,
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("create otlp trace exporter: %w", err)
    }

    maxBatch := cfg.MaxExportBatchSize
    if maxBatch == 0 {
        maxBatch = 512
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            // Maximum batch size before forcing an export
            sdktrace.WithMaxExportBatchSize(maxBatch),
            // How long to wait before flushing a partial batch
            sdktrace.WithScheduleDelay(200*time.Millisecond),
            // How long the exporter has to complete one export
            sdktrace.WithExportTimeout(cfg.ExportTimeout),
            // Maximum queue size — spans beyond this are dropped
            sdktrace.WithMaxQueueSize(maxBatch*10),
        ),
        sdktrace.WithSampler(NewPrioritySampler(cfg.SamplingRatio)),
        sdktrace.WithResource(res),
        // Limit span attribute count to prevent memory bloat
        sdktrace.WithSpanLimits(sdktrace.SpanLimits{
            AttributeValueLengthLimit:   512,
            AttributeCountLimit:         64,
            EventCountLimit:             64,
            LinkCountLimit:              16,
            AttributePerEventCountLimit: 16,
            AttributePerLinkCountLimit:  16,
        }),
    )
    return tp, nil
}
```

### HTTP Exporter (When gRPC is Blocked)

Some enterprise environments block gRPC traffic. Use the HTTP exporter instead:

```go
import "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"

func buildHTTPExporter(ctx context.Context, endpoint string) (sdktrace.SpanExporter, error) {
    return otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(endpoint),
        otlptracehttp.WithInsecure(),
        otlptracehttp.WithURLPath("/v1/traces"),
        otlptracehttp.WithCompression(otlptracehttp.GzipCompression),
        otlptracehttp.WithTimeout(10*time.Second),
        otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
            Enabled:         true,
            InitialInterval: 500 * time.Millisecond,
            MaxInterval:     10 * time.Second,
            MaxElapsedTime:  1 * time.Minute,
        }),
        otlptracehttp.WithHeaders(map[string]string{
            "Authorization": "Bearer <otlp-bearer-token>",
        }),
    )
}
```

## Custom Span Attributes: Semantic Conventions

### Defining Domain-Specific Attributes

Always extend the OpenTelemetry semantic conventions rather than inventing your own attribute names. Use the `semconv` package for standard attributes and define your own for domain-specific ones.

```go
package attrs

import "go.opentelemetry.io/otel/attribute"

// Domain-specific attribute keys following semconv naming conventions
const (
    // Business domain
    OrderIDKey      = attribute.Key("order.id")
    CustomerIDKey   = attribute.Key("customer.id")
    TenantIDKey     = attribute.Key("tenant.id")
    PaymentMethodKey = attribute.Key("payment.method")
    CartItemCountKey = attribute.Key("cart.item.count")

    // Infrastructure
    CacheHitKey      = attribute.Key("cache.hit")
    DBQueryTypeKey   = attribute.Key("db.query.type")
    QueueNameKey     = attribute.Key("messaging.queue.name")
    RetryCountKey    = attribute.Key("retry.count")
    CircuitStateKey  = attribute.Key("circuit_breaker.state")
)

// Constructor helpers for common attribute patterns
func OrderID(id string) attribute.KeyValue        { return OrderIDKey.String(id) }
func CustomerID(id string) attribute.KeyValue     { return CustomerIDKey.String(id) }
func TenantID(id string) attribute.KeyValue       { return TenantIDKey.String(id) }
func CacheHit(hit bool) attribute.KeyValue        { return CacheHitKey.Bool(hit) }
func RetryCount(n int) attribute.KeyValue         { return RetryCountKey.Int(n) }
func CircuitState(s string) attribute.KeyValue    { return CircuitStateKey.String(s) }
```

### Applying Attributes to Spans

```go
package handlers

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/codes"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "go.opentelemetry.io/otel/trace"

    "github.com/example/my-service/internal/attrs"
)

var tracer = otel.Tracer("github.com/example/my-service/handlers")

func ProcessOrder(ctx context.Context, orderID, customerID, tenantID string) error {
    ctx, span := tracer.Start(ctx, "order.process",
        trace.WithAttributes(
            attrs.OrderID(orderID),
            attrs.CustomerID(customerID),
            attrs.TenantID(tenantID),
            semconv.CodeFunction("ProcessOrder"),
        ),
        trace.WithSpanKind(trace.SpanKindServer),
    )
    defer span.End()

    // Add attributes discovered mid-span
    span.SetAttributes(
        attrs.CartItemCountKey.Int(5),
        attrs.PaymentMethodKey.String("credit_card"),
    )

    // Record events (structured log entries attached to the span)
    span.AddEvent("payment.initiated", trace.WithAttributes(
        attribute.String("payment.provider", "stripe"),
        attribute.Float64("payment.amount", 149.99),
    ))

    if err := chargeCustomer(ctx, customerID); err != nil {
        span.RecordError(err,
            trace.WithAttributes(
                attribute.String("error.type", "payment_failure"),
                attribute.Bool("error.retryable", true),
            ),
        )
        span.SetStatus(codes.Error, "payment charge failed")
        return err
    }

    span.SetStatus(codes.Ok, "")
    return nil
}
```

## Baggage Propagation

Baggage is W3C-standardized ambient context that flows across all service boundaries without being attached to a specific span. It's ideal for carrying request-scoped metadata that multiple services need.

### Setting and Reading Baggage

```go
package middleware

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel/baggage"
    "go.opentelemetry.io/otel/propagation"
)

// BaggageMiddleware extracts tenant, correlation ID, and user role
// from request headers and injects them into context baggage.
func BaggageMiddleware(prop propagation.TextMapPropagator) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract existing baggage from incoming headers (W3C baggage header)
            ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

            // Add service-specific baggage entries
            tenantID := r.Header.Get("X-Tenant-ID")
            correlationID := r.Header.Get("X-Correlation-ID")

            ctx = injectBaggage(ctx, map[string]string{
                "tenant.id":      tenantID,
                "correlation.id": correlationID,
                "service.region": "us-east-1",
            })

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func injectBaggage(ctx context.Context, kv map[string]string) context.Context {
    b := baggage.FromContext(ctx)
    for k, v := range kv {
        if v == "" {
            continue
        }
        m, err := baggage.NewMember(k, v)
        if err != nil {
            continue // skip invalid baggage members silently
        }
        b, _ = b.SetMember(m)
    }
    return baggage.ContextWithBaggage(ctx, b)
}

// ReadBaggage extracts all baggage members from the context.
func ReadBaggage(ctx context.Context) map[string]string {
    b := baggage.FromContext(ctx)
    result := make(map[string]string, b.Len())
    for _, m := range b.Members() {
        result[m.Key()] = m.Value()
    }
    return result
}
```

### Propagating Baggage Through gRPC

When making outbound gRPC calls, baggage must be explicitly injected:

```go
package grpcutil

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
    "google.golang.org/grpc/metadata"
)

// OutboundPropagator injects trace context and baggage into outgoing gRPC metadata.
type OutboundPropagator struct {
    prop propagation.TextMapPropagator
}

func NewOutboundPropagator() *OutboundPropagator {
    return &OutboundPropagator{prop: otel.GetTextMapPropagator()}
}

// InjectToGRPC returns a context with trace/baggage headers injected into gRPC metadata.
func (p *OutboundPropagator) InjectToGRPC(ctx context.Context) context.Context {
    md, ok := metadata.FromOutgoingContext(ctx)
    if !ok {
        md = metadata.New(nil)
    }
    // MetadataCarrier adapts gRPC metadata to the TextMapCarrier interface
    carrier := MetadataCarrier(md)
    p.prop.Inject(ctx, carrier)
    return metadata.NewOutgoingContext(ctx, md)
}

// MetadataCarrier implements propagation.TextMapCarrier for gRPC metadata.
type MetadataCarrier metadata.MD

func (mc MetadataCarrier) Get(key string) string {
    vals := metadata.MD(mc).Get(key)
    if len(vals) == 0 {
        return ""
    }
    return vals[0]
}

func (mc MetadataCarrier) Set(key, value string) {
    metadata.MD(mc).Set(key, value)
}

func (mc MetadataCarrier) Keys() []string {
    keys := make([]string, 0, len(mc))
    for k := range mc {
        keys = append(keys, k)
    }
    return keys
}
```

### Automatically Correlating Baggage with Spans

A common pattern is to copy baggage entries into span attributes, so they appear in your trace backend's attribute search:

```go
// BaggageToSpan copies baggage from context into the active span.
// Call this at the beginning of any span that should surface baggage for search.
func BaggageToSpan(ctx context.Context, span trace.Span, keys ...string) {
    b := baggage.FromContext(ctx)
    for _, key := range keys {
        m := b.Member(key)
        if m.Key() != "" {
            span.SetAttributes(attribute.String(key, m.Value()))
        }
    }
}

// Usage in a handler:
func (h *OrderHandler) Handle(ctx context.Context, req *OrderRequest) error {
    ctx, span := tracer.Start(ctx, "order.handle")
    defer span.End()

    // Surface these baggage values in the span for search/filtering
    BaggageToSpan(ctx, span, "tenant.id", "correlation.id")

    // ... rest of handler
}
```

## Metrics Integration

### Setting Up the Metric Provider with OTLP

```go
func buildMeterProvider(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
    cfg Config,
) (*sdkmetric.MeterProvider, error) {
    exporter, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithGRPCConn(conn),
        otlpmetricgrpc.WithTimeout(cfg.ExportTimeout),
    )
    if err != nil {
        return nil, fmt.Errorf("create metric exporter: %w", err)
    }

    interval := cfg.MetricInterval
    if interval == 0 {
        interval = 30 * time.Second
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(exporter,
                sdkmetric.WithInterval(interval),
                sdkmetric.WithTimeout(cfg.ExportTimeout),
            ),
        ),
        sdkmetric.WithResource(res),
        sdkmetric.WithView(
            // Customize histogram bucket boundaries for latency metrics
            sdkmetric.NewView(
                sdkmetric.Instrument{
                    Name: "http.server.request.duration",
                    Kind: sdkmetric.InstrumentKindHistogram,
                },
                sdkmetric.Stream{
                    Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
                        Boundaries: []float64{
                            0.001, 0.005, 0.01, 0.025, 0.05,
                            0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
                        },
                    },
                },
            ),
        ),
    )
    return mp, nil
}
```

### Recording Custom Metrics

```go
package metrics

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

type OrderMetrics struct {
    ordersProcessed   metric.Int64Counter
    orderLatency      metric.Float64Histogram
    activeOrders      metric.Int64UpDownCounter
    paymentAmount     metric.Float64Histogram
}

func NewOrderMetrics() (*OrderMetrics, error) {
    meter := otel.Meter("github.com/example/my-service/orders")

    processed, err := meter.Int64Counter("orders.processed",
        metric.WithDescription("Total orders processed"),
        metric.WithUnit("{order}"),
    )
    if err != nil {
        return nil, err
    }

    latency, err := meter.Float64Histogram("orders.duration",
        metric.WithDescription("Order processing latency"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    active, err := meter.Int64UpDownCounter("orders.active",
        metric.WithDescription("Currently active orders"),
        metric.WithUnit("{order}"),
    )
    if err != nil {
        return nil, err
    }

    amount, err := meter.Float64Histogram("orders.payment.amount",
        metric.WithDescription("Payment amounts processed"),
        metric.WithUnit("USD"),
    )
    if err != nil {
        return nil, err
    }

    return &OrderMetrics{
        ordersProcessed: processed,
        orderLatency:    latency,
        activeOrders:    active,
        paymentAmount:   amount,
    }, nil
}

func (m *OrderMetrics) RecordOrder(ctx context.Context, tenantID, status string, durationSec, amount float64) {
    attrs := []attribute.KeyValue{
        attribute.String("tenant.id", tenantID),
        attribute.String("order.status", status),
    }
    m.ordersProcessed.Add(ctx, 1, metric.WithAttributes(attrs...))
    m.orderLatency.Record(ctx, durationSec, metric.WithAttributes(attrs...))
    m.paymentAmount.Record(ctx, amount, metric.WithAttributes(attrs...))
}
```

## HTTP Middleware with Full Telemetry

```go
package httptelemetry

import (
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// NewHandler wraps an http.Handler with full OTel instrumentation:
// - Trace span per request with semantic attributes
// - HTTP request/response metrics
// - Baggage extraction and propagation
func NewHandler(handler http.Handler, serviceName string) http.Handler {
    return otelhttp.NewHandler(handler, serviceName,
        otelhttp.WithTracerProvider(otel.GetTracerProvider()),
        otelhttp.WithMeterProvider(otel.GetMeterProvider()),
        otelhttp.WithPropagators(otel.GetTextMapPropagator()),
        otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
            // Use route pattern, not URL, to avoid high-cardinality span names
            route := chi.RouteContext(r.Context()).RoutePattern()
            if route == "" {
                route = r.URL.Path
            }
            return r.Method + " " + route
        }),
        otelhttp.WithFilter(func(r *http.Request) bool {
            // Don't trace health checks or metrics endpoints
            return r.URL.Path != "/healthz" &&
                r.URL.Path != "/readyz" &&
                r.URL.Path != "/metrics"
        }),
    )
}
```

## Production Checklist

### Environment Variables for Dynamic Configuration

The OpenTelemetry SDK respects the following environment variables, enabling configuration without code changes:

```bash
# Service identification
OTEL_SERVICE_NAME=order-service
OTEL_SERVICE_VERSION=2.1.0

# Exporter endpoint
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc

# Sampling ratio (0.0 to 1.0)
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1

# Batch processor settings
OTEL_BSP_MAX_EXPORT_BATCH_SIZE=512
OTEL_BSP_SCHEDULE_DELAY=200
OTEL_BSP_MAX_QUEUE_SIZE=2048
OTEL_BSP_EXPORT_TIMEOUT=10000

# Resource attributes (key=value pairs)
OTEL_RESOURCE_ATTRIBUTES=k8s.namespace.name=production,k8s.cluster.name=prod-us-east-1
```

### Kubernetes ConfigMap for OTel Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-config
  namespace: production
data:
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://opentelemetry-collector.observability:4317"
  OTEL_EXPORTER_OTLP_PROTOCOL: "grpc"
  OTEL_TRACES_SAMPLER: "parentbased_traceidratio"
  OTEL_TRACES_SAMPLER_ARG: "0.05"
  OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "512"
  OTEL_BSP_SCHEDULE_DELAY: "200"
  OTEL_BSP_MAX_QUEUE_SIZE: "4096"
  OTEL_METRICS_EXPORTER: "otlp"
  OTEL_METRIC_EXPORT_INTERVAL: "30000"
```

## Collector Configuration (OTel Collector)

The collector is the recommended deployment pattern — it decouples services from backend-specific protocols.

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        max_recv_msg_size_mib: 16
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins:
            - "https://*.example.com"

processors:
  batch:
    timeout: 200ms
    send_batch_size: 512
    send_batch_max_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  resource:
    attributes:
      - key: deployment.environment
        from_attribute: deployment.environment
        action: insert

exporters:
  otlp/jaeger:
    endpoint: jaeger-collector:4317
    tls:
      insecure: false
      cert_file: /certs/tls.crt
      key_file: /certs/tls.key
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: otel
    const_labels:
      cluster: prod-us-east-1

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

## Troubleshooting

### Spans Not Appearing in Backend

1. Check the exporter endpoint connectivity:

```go
// Add a connection test at startup
func testCollectorConnection(endpoint string) error {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    conn, err := grpc.DialContext(ctx, endpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return fmt.Errorf("cannot reach collector at %s: %w", endpoint, err)
    }
    conn.Close()
    return nil
}
```

2. Enable SDK diagnostic logging:

```go
import "go.opentelemetry.io/otel/internal/global"

// Enable internal OTel SDK logging
global.SetLogger(logr.New(logr.Discard())) // replace with your logger
```

3. Use the stdout exporter to verify spans are being generated:

```go
import "go.opentelemetry.io/otel/exporters/stdout/stdouttrace"

stdoutExporter, _ := stdouttrace.New(stdouttrace.WithPrettyPrint())
```

### High Memory Usage

If the Descheduler's queue fills up (check `otel_bsp_dropped_spans_total` if the collector exposes it), increase `MaxQueueSize` or reduce export batch timeout. Dropped spans indicate backpressure from a slow collector.

## Summary

Production OpenTelemetry in Go requires careful attention to:

- Resource attribution at initialization — set `k8s.*` attributes from downward API environment variables.
- Sampler selection — `ParentBased(TraceIDRatioBased(0.05))` is the correct production default.
- OTLP exporter tuning — batch size 512, schedule delay 200ms, queue size 10x batch.
- Baggage propagation — use the W3C Baggage header, copy to span attributes for search.
- Custom semantic attributes — extend `semconv`, define domain keys as typed constants.
- Collector as intermediary — never export directly to a backend from application code.
