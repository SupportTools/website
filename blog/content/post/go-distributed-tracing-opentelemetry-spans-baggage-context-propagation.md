---
title: "Go Distributed Tracing: OpenTelemetry Spans, Baggage, and Context Propagation"
date: 2031-02-06T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "OpenTelemetry", "Distributed Tracing", "Jaeger", "Tempo", "Observability", "gRPC"]
categories:
- Go
- Observability
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Go distributed tracing with OpenTelemetry: SDK initialization, span creation, W3C trace context propagation, baggage for cross-service metadata, parent-based and ratio-based sampling, and Jaeger/Tempo backend configuration."
more_link: "yes"
url: "/go-distributed-tracing-opentelemetry-spans-baggage-context-propagation/"
---

Distributed tracing turns a request's journey through a microservice architecture from an opaque mystery into a navigable timeline. OpenTelemetry (OTel) provides the standard SDK for Go that generates traces compatible with Jaeger, Grafana Tempo, Zipkin, and every major observability vendor. This guide covers the complete OTel Go implementation — from SDK bootstrap through advanced baggage patterns and production sampling configuration.

<!--more-->

# Go Distributed Tracing: OpenTelemetry Spans, Baggage, and Context Propagation

## Section 1: OpenTelemetry Concepts

A distributed trace is a directed acyclic graph of spans, where each span represents a unit of work:

```
TraceID: 4bf92f3577b34da6a3ce929d0e0e4736
│
├── Span: api-gateway/handle-request      [0ms - 245ms]
│   TraceID: 4bf92f3577b34da6a3ce929d0e0e4736
│   SpanID: 00f067aa0ba902b7
│   ParentSpanID: (none — root span)
│
│   ├── Span: user-service/get-user       [5ms - 45ms]
│   │   SpanID: 1a2b3c4d5e6f7890
│   │   ParentSpanID: 00f067aa0ba902b7
│   │
│   └── Span: order-service/get-orders    [50ms - 200ms]
│       SpanID: aabbccdd11223344
│       ParentSpanID: 00f067aa0ba902b7
│
│       └── Span: database/query          [60ms - 190ms]
│           SpanID: 99887766554433221
│           ParentSpanID: aabbccdd11223344
```

### Key OTel Components

- **TracerProvider** — the factory for Tracer instances; configured once at startup
- **Tracer** — creates spans; scoped to a package or component
- **Span** — a single unit of work with timing, attributes, events, and status
- **Context** — Go's `context.Context` carries the active span for propagation
- **Propagator** — serializes/deserializes trace context across process boundaries (HTTP headers, gRPC metadata)
- **Exporter** — sends completed spans to a backend (Jaeger, Tempo, OTLP collector)
- **Sampler** — decides whether a trace should be recorded

## Section 2: OTel SDK Initialization

### Dependencies

```bash
go get go.opentelemetry.io/otel@v1.32.0
go get go.opentelemetry.io/otel/trace@v1.32.0
go get go.opentelemetry.io/otel/sdk@v1.32.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace@v1.32.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.32.0
go get go.opentelemetry.io/otel/propagators/b3@v1.32.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.57.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.57.0
```

### Complete SDK Bootstrap

```go
// internal/telemetry/tracing.go
package telemetry

import (
    "context"
    "fmt"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// Config holds tracing configuration.
type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string  // e.g., "otel-collector.monitoring.svc:4317"
    Sampler        sdktrace.Sampler
}

// DefaultConfig returns a Config with sensible production defaults.
func DefaultConfig() Config {
    sampler := sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(0.1), // 10% root trace sampling
    )

    // In development, sample everything
    if os.Getenv("ENVIRONMENT") == "development" {
        sampler = sdktrace.AlwaysSample()
    }

    return Config{
        ServiceName:    getEnvOrDefault("SERVICE_NAME", "unknown-service"),
        ServiceVersion: getEnvOrDefault("SERVICE_VERSION", "0.0.0"),
        Environment:    getEnvOrDefault("ENVIRONMENT", "production"),
        OTLPEndpoint:   getEnvOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT",
            "otel-collector.monitoring.svc:4317"),
        Sampler: sampler,
    }
}

// InitTracer bootstraps the OpenTelemetry SDK and returns a shutdown function.
// Call shutdown() in a defer in main() to flush pending spans before exit.
func InitTracer(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    // Build the resource (identifies this service in trace backends)
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
            attribute.String("pod.name", getEnvOrDefault("MY_POD_NAME", "unknown")),
            attribute.String("node.name", getEnvOrDefault("MY_NODE_NAME", "unknown")),
            attribute.String("namespace", getEnvOrDefault("MY_NAMESPACE", "unknown")),
        ),
        resource.WithProcess(),
        resource.WithHost(),
        resource.WithFromEnv(), // Read OTEL_RESOURCE_ATTRIBUTES env var
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    // Build the OTLP gRPC exporter
    conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        // Non-fatal: start without tracing if collector is unavailable
        slog.Warn("OTLP collector unavailable, tracing disabled",
            "endpoint", cfg.OTLPEndpoint, "err", err)
        return func(context.Context) error { return nil }, nil
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("create OTLP exporter: %w", err)
    }

    // Build the TracerProvider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithSampler(cfg.Sampler),
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithResource(res),
    )

    // Register as global provider
    otel.SetTracerProvider(tp)

    // Configure context propagation — support W3C Trace Context and W3C Baggage
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},  // W3C traceparent/tracestate headers
        propagation.Baggage{},       // W3C baggage header
    ))

    slog.Info("distributed tracing initialized",
        "service", cfg.ServiceName,
        "endpoint", cfg.OTLPEndpoint,
        "sampler", fmt.Sprintf("%T", cfg.Sampler))

    return tp.Shutdown, nil
}

func getEnvOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

```go
// main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "yourcompany.com/myservice/internal/telemetry"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    // Initialize tracing early — before any handlers are set up
    shutdownTracing, err := telemetry.InitTracer(ctx, telemetry.DefaultConfig())
    if err != nil {
        slog.Error("failed to initialize tracing", "err", err)
        os.Exit(1)
    }
    defer func() {
        // Give 5 seconds for pending spans to flush
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := shutdownTracing(ctx); err != nil {
            slog.Error("error shutting down tracer", "err", err)
        }
    }()

    runApplication(ctx)
}
```

## Section 3: Creating and Managing Spans

### Package-Level Tracer

```go
// Define a package-level tracer — named after the package for clear attribution
package userservice

import "go.opentelemetry.io/otel"

// tracer is the package-level tracer.
// It is initialized once and reused for all spans in this package.
var tracer = otel.Tracer("yourcompany.com/myservice/internal/userservice")
```

### Basic Span Creation

```go
func (s *Service) GetUser(ctx context.Context, userID string) (*User, error) {
    // Start a span — this also creates a child context containing the span
    ctx, span := tracer.Start(ctx, "GetUser",
        trace.WithAttributes(
            attribute.String("user.id", userID),
        ),
    )
    defer span.End()  // Always end the span, even on error paths

    user, err := s.repo.FindByID(ctx, userID)
    if err != nil {
        // Record the error on the span
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, fmt.Errorf("GetUser(%q): %w", userID, err)
    }

    // Add result attributes
    span.SetAttributes(
        attribute.String("user.email", user.Email),
        attribute.String("user.tier", string(user.Tier)),
    )
    span.SetStatus(codes.Ok, "")

    return user, nil
}
```

### Span Attributes Best Practices

```go
// Semantic conventions from OTel semconv package
import semconv "go.opentelemetry.io/otel/semconv/v1.26.0"

func (r *DBRepository) QueryUsers(ctx context.Context, filter UserFilter) ([]*User, error) {
    ctx, span := tracer.Start(ctx, "db.query",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            // Use semconv for well-known attributes
            semconv.DBSystemPostgreSQL,
            semconv.DBName("users_db"),
            semconv.DBOperationName("SELECT"),
            semconv.DBQueryText("SELECT id, email FROM users WHERE ..."),

            // Custom business attributes
            attribute.Int("filter.limit", filter.Limit),
            attribute.Bool("filter.include_inactive", filter.IncludeInactive),
        ),
    )
    defer span.End()

    rows, err := r.db.QueryContext(ctx, buildQuery(filter))
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "database query failed")
        return nil, fmt.Errorf("QueryUsers: %w", err)
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        // ... scan rows
    }

    // Record result metadata
    span.SetAttributes(attribute.Int("result.count", len(users)))

    return users, rows.Err()
}
```

### Span Events

Span events are timestamped log entries attached to a span — useful for marking significant moments within a long operation:

```go
func (s *OrderService) ProcessOrder(ctx context.Context, order *Order) error {
    ctx, span := tracer.Start(ctx, "ProcessOrder",
        trace.WithAttributes(
            attribute.String("order.id", order.ID),
            attribute.Float64("order.total_usd", order.TotalUSD),
        ),
    )
    defer span.End()

    // Record events at key processing stages
    span.AddEvent("payment.initiated",
        trace.WithAttributes(
            attribute.String("payment.method", order.PaymentMethod),
            attribute.Float64("payment.amount", order.TotalUSD),
        ),
    )

    if err := s.payment.Charge(ctx, order); err != nil {
        span.AddEvent("payment.failed",
            trace.WithAttributes(
                attribute.String("payment.error", err.Error()),
            ),
        )
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment failed")
        return fmt.Errorf("ProcessOrder: charge: %w", err)
    }

    span.AddEvent("payment.completed")
    span.AddEvent("inventory.reserving")

    if err := s.inventory.Reserve(ctx, order.Items); err != nil {
        span.AddEvent("inventory.reservation_failed",
            trace.WithAttributes(
                attribute.String("inventory.error", err.Error()),
            ),
        )
        // Attempt refund
        s.payment.Refund(ctx, order)
        return fmt.Errorf("ProcessOrder: inventory: %w", err)
    }

    span.AddEvent("order.completed")
    span.SetStatus(codes.Ok, "")
    return nil
}
```

## Section 4: W3C Trace Context Propagation

The W3C Trace Context specification defines the `traceparent` and `tracestate` HTTP headers for propagating trace context across service boundaries.

### HTTP Client with Propagation

```go
// httpclient/client.go
package httpclient

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// NewTracingClient returns an HTTP client that automatically propagates
// trace context via traceparent/tracestate headers.
func NewTracingClient() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(
            http.DefaultTransport,
            otelhttp.WithTracerProvider(otel.GetTracerProvider()),
            otelhttp.WithPropagators(otel.GetTextMapPropagator()),
        ),
        Timeout: 30 * time.Second,
    }
}

// Manual propagation if not using otelhttp
func injectTraceContext(ctx context.Context, req *http.Request) {
    otel.GetTextMapPropagator().Inject(ctx,
        propagation.HeaderCarrier(req.Header))
    // This adds:
    // traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
    // tracestate: (optional)
}
```

### HTTP Server Middleware

```go
// middleware/tracing.go
package middleware

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
)

// Tracing wraps an HTTP handler with OTel tracing.
// It extracts trace context from incoming requests and creates a server span.
func Tracing(serviceName string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return otelhttp.NewHandler(next, serviceName,
            otelhttp.WithTracerProvider(otel.GetTracerProvider()),
            otelhttp.WithPropagators(otel.GetTextMapPropagator()),
            // Customize span naming
            otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
                return fmt.Sprintf("%s %s", r.Method, r.URL.Path)
            }),
            // Add request attributes
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
// server/grpc.go
package server

import (
    "google.golang.org/grpc"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func NewGRPCServer() *grpc.Server {
    return grpc.NewServer(
        // Tracing interceptors for unary and stream RPCs
        grpc.StatsHandler(otelgrpc.NewServerHandler(
            otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
            otelgrpc.WithPropagators(otel.GetTextMapPropagator()),
        )),
    )
}

func NewGRPCClientConn(target string) (*grpc.ClientConn, error) {
    return grpc.Dial(target,
        grpc.WithStatsHandler(otelgrpc.NewClientHandler(
            otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
            otelgrpc.WithPropagators(otel.GetTextMapPropagator()),
        )),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
}
```

### Message Queue Propagation (Kafka)

```go
// kafka/producer.go
package kafka

import (
    "context"

    "github.com/IBM/sarama"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// KafkaHeaderCarrier adapts sarama.RecordHeader for OTel propagation.
type KafkaHeaderCarrier sarama.RecordHeader

type MessageCarrier struct {
    msg *sarama.ProducerMessage
}

func (c MessageCarrier) Get(key string) string {
    for _, h := range c.msg.Headers {
        if string(h.Key) == key {
            return string(h.Value)
        }
    }
    return ""
}

func (c MessageCarrier) Set(key, value string) {
    c.msg.Headers = append(c.msg.Headers, sarama.RecordHeader{
        Key:   []byte(key),
        Value: []byte(value),
    })
}

func (c MessageCarrier) Keys() []string {
    keys := make([]string, len(c.msg.Headers))
    for i, h := range c.msg.Headers {
        keys[i] = string(h.Key)
    }
    return keys
}

// InjectTraceContext injects trace context into Kafka message headers.
func InjectTraceContext(ctx context.Context, msg *sarama.ProducerMessage) {
    otel.GetTextMapPropagator().Inject(ctx, MessageCarrier{msg: msg})
}

// ExtractTraceContext extracts trace context from Kafka message headers.
func ExtractTraceContext(ctx context.Context, msg *sarama.ConsumerMessage) context.Context {
    headers := make(map[string]string)
    for _, h := range msg.Headers {
        headers[string(h.Key)] = string(h.Value)
    }

    return otel.GetTextMapPropagator().Extract(ctx,
        propagation.MapCarrier(headers))
}
```

## Section 5: Baggage for Cross-Service Metadata

W3C Baggage allows passing arbitrary key-value pairs alongside trace context. Use it for correlation IDs, user tiers, feature flags, or any metadata that downstream services need without making a separate lookup:

```go
// baggage/middleware.go
package baggagemw

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel/baggage"
)

// CommonBaggageKeys defines well-known baggage keys in the system.
const (
    BaggageKeyUserID      = "user.id"
    BaggageKeyUserTier    = "user.tier"
    BaggageKeyTenantID    = "tenant.id"
    BaggageKeyRequestID   = "request.id"
    BaggageKeyFeatureFlag = "feature.flags"
)

// AddBaggage adds key-value pairs to the context baggage.
// These propagate to all downstream services via the baggage header.
func AddBaggage(ctx context.Context, kvs map[string]string) (context.Context, error) {
    members := make([]baggage.Member, 0, len(kvs))
    for k, v := range kvs {
        m, err := baggage.NewMember(k, v)
        if err != nil {
            return ctx, fmt.Errorf("create baggage member %q=%q: %w", k, v, err)
        }
        members = append(members, m)
    }

    bag, err := baggage.New(members...)
    if err != nil {
        return ctx, fmt.Errorf("create baggage: %w", err)
    }

    return baggage.ContextWithBaggage(ctx, bag), nil
}

// GetBaggage retrieves a baggage value from the context.
func GetBaggage(ctx context.Context, key string) string {
    return baggage.FromContext(ctx).Member(key).Value()
}

// HTTP middleware to extract baggage from authenticated user session
func UserContextMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        user := getUserFromSession(r)
        if user == nil {
            next.ServeHTTP(w, r)
            return
        }

        ctx, err := AddBaggage(r.Context(), map[string]string{
            BaggageKeyUserID:   user.ID,
            BaggageKeyUserTier: string(user.Tier),
            BaggageKeyTenantID: user.TenantID,
        })
        if err != nil {
            slog.WarnContext(r.Context(), "failed to add user baggage", "err", err)
            next.ServeHTTP(w, r)
            return
        }

        // Also add baggage values as span attributes for the current span
        span := trace.SpanFromContext(ctx)
        span.SetAttributes(
            attribute.String("enduser.id", user.ID),
            attribute.String("enduser.role", string(user.Tier)),
        )

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Using Baggage in Downstream Services

```go
// In any downstream service that receives the request:
func (s *BillingService) CalculateCost(ctx context.Context, items []Item) (float64, error) {
    ctx, span := tracer.Start(ctx, "CalculateCost")
    defer span.End()

    // Read baggage values set by the upstream service
    userTier := GetBaggage(ctx, BaggageKeyUserTier)
    tenantID := GetBaggage(ctx, BaggageKeyTenantID)

    // Add to span for query-ability
    span.SetAttributes(
        attribute.String("billing.user_tier", userTier),
        attribute.String("billing.tenant_id", tenantID),
    )

    // Apply tier-specific pricing
    var discount float64
    switch userTier {
    case "enterprise":
        discount = 0.30
    case "pro":
        discount = 0.15
    }

    total := calculateBaseTotal(items) * (1 - discount)
    span.SetAttributes(attribute.Float64("billing.total", total))

    return total, nil
}
```

## Section 6: Sampling Strategies

### Parent-Based Sampling (Recommended for Production)

Parent-based sampling respects sampling decisions made by upstream services:

```go
import sdktrace "go.opentelemetry.io/otel/sdk/trace"

// ParentBased: if parent is sampled, we sample too.
// If no parent (root trace), use TraceIDRatioBased at 10%.
sampler := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.10),
    // Also configure behavior for parent decisions:
    sdktrace.WithRemoteParentSampled(sdktrace.AlwaysSample()),
    sdktrace.WithRemoteParentNotSampled(sdktrace.NeverSample()),
    sdktrace.WithLocalParentSampled(sdktrace.AlwaysSample()),
    sdktrace.WithLocalParentNotSampled(sdktrace.NeverSample()),
)
```

### Adaptive Sampling Based on Request Attributes

For more sophisticated sampling, implement a custom sampler:

```go
// sampling/adaptive.go
package sampling

import (
    "go.opentelemetry.io/otel/attribute"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/trace"
)

// AdaptiveSampler samples differently based on request attributes.
// - Errors: always sampled
// - Slow requests: always sampled
// - Health checks: never sampled
// - Normal requests: sampled at the configured rate
type AdaptiveSampler struct {
    baseRate    float64
    errorRate   float64
    healthPaths map[string]bool
}

func NewAdaptiveSampler(baseRate float64) *AdaptiveSampler {
    return &AdaptiveSampler{
        baseRate:  baseRate,
        errorRate: 1.0, // Always sample errors
        healthPaths: map[string]bool{
            "/healthz":  true,
            "/readyz":   true,
            "/livez":    true,
            "/metrics":  true,
            "/debug":    true,
        },
    }
}

func (s *AdaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Check if this is a health check — never sample
    for _, attr := range p.Attributes {
        if attr.Key == "http.target" {
            path := attr.Value.AsString()
            if s.healthPaths[path] {
                return sdktrace.SamplingResult{
                    Decision: sdktrace.Drop,
                }
            }
        }
    }

    // Respect parent sampling decision
    if p.ParentContext.IsValid() {
        if tracestate := trace.SpanContextFromContext(p.ParentContext); tracestate.IsSampled() {
            return sdktrace.SamplingResult{
                Decision:   sdktrace.RecordAndSample,
                Tracestate: tracestate.TraceState(),
            }
        }
    }

    // Check for error indication in attributes (added by caller)
    for _, attr := range p.Attributes {
        if attr.Key == "sampling.force" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{
                Decision: sdktrace.RecordAndSample,
            }
        }
    }

    // Apply base rate sampling using trace ID for consistency
    threshold := uint64(s.baseRate * (1 << 62))
    traceIDBytes := p.TraceID
    // Use first 8 bytes of trace ID as a deterministic random value
    traceIDValue := uint64(traceIDBytes[0])<<56 |
        uint64(traceIDBytes[1])<<48 |
        uint64(traceIDBytes[2])<<40 |
        uint64(traceIDBytes[3])<<32 |
        uint64(traceIDBytes[4])<<24 |
        uint64(traceIDBytes[5])<<16 |
        uint64(traceIDBytes[6])<<8 |
        uint64(traceIDBytes[7])

    // Mask to 62 bits to avoid sign issues
    traceIDValue &= (1 << 62) - 1

    if traceIDValue < threshold {
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }
    return sdktrace.SamplingResult{Decision: sdktrace.Drop}
}

func (s *AdaptiveSampler) Description() string {
    return fmt.Sprintf("AdaptiveSampler(baseRate=%.2f)", s.baseRate)
}
```

### Forcing a Trace to be Sampled

```go
// Force sampling for a specific high-value operation
func (s *PaymentService) ProcessHighValuePayment(ctx context.Context, amount float64) error {
    if amount > 10000 {
        // Force this trace to be sampled regardless of rate
        ctx, span := tracer.Start(ctx, "ProcessHighValuePayment",
            trace.WithAttributes(
                attribute.Float64("payment.amount_usd", amount),
                attribute.Bool("sampling.force", true), // Custom attribute for adaptive sampler
            ),
        )
        defer span.End()
    }
    // ... implementation
}
```

## Section 7: Jaeger Backend Configuration

### Jaeger via OTLP

```yaml
# jaeger-deployment.yaml
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
              value: elasticsearch
            - name: ES_SERVER_URLS
              value: http://elasticsearch.monitoring.svc:9200
            - name: ES_NUM_SHARDS
              value: "3"
            - name: ES_NUM_REPLICAS
              value: "1"
          ports:
            - containerPort: 16686  # Jaeger UI
              name: ui
            - containerPort: 4317   # OTLP gRPC
              name: otlp-grpc
            - containerPort: 4318   # OTLP HTTP
              name: otlp-http
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 2Gi
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

## Section 8: Grafana Tempo Backend Configuration

Tempo is the preferred backend for teams already using the Grafana stack:

```yaml
# tempo-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-config
  namespace: monitoring
data:
  tempo.yaml: |
    server:
      http_listen_port: 3200

    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: "0.0.0.0:4317"
            http:
              endpoint: "0.0.0.0:4318"
        jaeger:
          protocols:
            thrift_compact:
              endpoint: "0.0.0.0:6831"
            grpc:
              endpoint: "0.0.0.0:14250"

    storage:
      trace:
        backend: s3
        s3:
          bucket: my-tempo-traces
          region: us-east-1
          endpoint: s3.amazonaws.com
        wal:
          path: /var/tempo/wal

    compactor:
      compaction:
        block_retention: 168h  # 7 days

    query_frontend:
      search:
        duration_slo: 5s
        throughput_bytes_slo: 1.073741824e+09

    ingester:
      max_block_bytes: 1_000_000
      max_block_duration: 5m

    querier:
      frontend_worker:
        frontend_address: tempo-query-frontend.monitoring.svc:9095
```

### Linking Traces to Logs in Grafana

```go
// Add trace ID to all log entries for log-to-trace correlation
package logging

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

// TraceIDHandler is a slog.Handler that adds trace ID to all log records.
type TraceIDHandler struct {
    slog.Handler
}

func (h TraceIDHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.IsRecording() {
        sc := span.SpanContext()
        r.AddAttrs(
            slog.String("trace_id", sc.TraceID().String()),
            slog.String("span_id", sc.SpanID().String()),
            slog.Bool("trace_sampled", sc.IsSampled()),
        )
    }
    return h.Handler.Handle(ctx, r)
}

// Setup creates a structured logger with trace ID injection
func SetupLogger(level slog.Level) *slog.Logger {
    handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: level,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Rename "time" to "timestamp" for Loki parsing
            if a.Key == slog.TimeKey {
                a.Key = "timestamp"
            }
            return a
        },
    })

    return slog.New(TraceIDHandler{Handler: handler})
}
```

### Grafana Data Source for Trace-to-Log Correlation

```yaml
# grafana-datasources.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: Tempo
        type: tempo
        url: http://tempo.monitoring.svc:3200
        uid: tempo
        jsonData:
          tracesToLogsV2:
            datasourceUid: loki
            spanStartTimeShift: "-1m"
            spanEndTimeShift: "1m"
            filterByTraceID: true
            filterBySpanID: true
            customQuery: true
            query: >-
              {namespace="${__span.tags.namespace}",
               pod="${__span.tags.pod.name}"}
              |= "${__trace.traceId}"
          serviceMap:
            datasourceUid: prometheus
          nodeGraph:
            enabled: true
          search:
            hide: false
          lokiSearch:
            datasourceUid: loki

      - name: Loki
        type: loki
        url: http://loki.monitoring.svc:3100
        uid: loki
        jsonData:
          derivedFields:
            - datasourceUid: tempo
              matcherRegex: '"trace_id":"(\w+)"'
              name: TraceID
              url: "$${__value.raw}"
              urlDisplayLabel: "View Trace in Tempo"
```

## Section 9: OTel Collector for Production

The OTel Collector decouples your services from trace backends, provides buffering, batching, and allows backend changes without redeployment:

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
      # Add k8s metadata to all spans
      k8sattributes:
        passthrough: false
        auth_type: "serviceAccount"
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.pod.name
            - k8s.node.name
            - k8s.deployment.name
          labels:
            - tag_name: app
              key: app
              from: pod
          annotations:
            - tag_name: version
              key: app.kubernetes.io/version
              from: pod

      # Filter out health check spans to reduce volume
      filter/health_checks:
        spans:
          exclude:
            match_type: strict
            attributes:
              - key: http.target
                value: /healthz
              - key: http.target
                value: /readyz

      # Tail-based sampling — keep 100% of error traces, 5% of others
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          - name: errors-policy
            type: status_code
            status_code: {status_codes: [ERROR]}
          - name: slow-traces-policy
            type: latency
            latency: {threshold_ms: 1000}
          - name: base-rate-policy
            type: probabilistic
            probabilistic: {sampling_percentage: 5}

      batch:
        timeout: 5s
        send_batch_size: 1024
        send_batch_max_size: 2048

      memory_limiter:
        check_interval: 1s
        limit_mib: 512
        spike_limit_mib: 128

    exporters:
      otlp/tempo:
        endpoint: tempo.monitoring.svc:4317
        tls:
          insecure: true

      otlp/jaeger:
        endpoint: jaeger.monitoring.svc:4317
        tls:
          insecure: true

      # Debug exporter for local development
      debug:
        verbosity: detailed

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, filter/health_checks, tail_sampling, batch]
          exporters: [otlp/tempo, otlp/jaeger]
```

## Section 10: Instrumenting Common Libraries

### Database (pgx for PostgreSQL)

```go
// database/pgx.go
package database

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// TracingQueryTracer implements pgx.QueryTracer for OTel tracing.
type TracingQueryTracer struct {
    tracer trace.Tracer
}

func NewTracingQueryTracer() *TracingQueryTracer {
    return &TracingQueryTracer{
        tracer: otel.Tracer("github.com/jackc/pgx/v5"),
    }
}

func (t *TracingQueryTracer) TraceQueryStart(
    ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData,
) context.Context {
    ctx, span := t.tracer.Start(ctx, "db.query",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.DBQueryText(sanitizeQuery(data.SQL)),
            attribute.Int("db.args_count", len(data.Args)),
        ),
    )
    return ctx
}

func (t *TracingQueryTracer) TraceQueryEnd(
    ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData,
) {
    span := trace.SpanFromContext(ctx)
    defer span.End()

    if data.Err != nil {
        span.RecordError(data.Err)
        span.SetStatus(codes.Error, "query failed")
        return
    }

    span.SetAttributes(
        attribute.Int64("db.rows_affected", data.CommandTag.RowsAffected()),
    )
    span.SetStatus(codes.Ok, "")
}

func sanitizeQuery(sql string) string {
    // Remove actual parameter values for security
    if len(sql) > 500 {
        return sql[:500] + "..."
    }
    return sql
}
```

### Redis (go-redis)

```go
// cache/redis.go
package cache

import (
    "github.com/redis/go-redis/extra/redisotel/v9"
    "github.com/redis/go-redis/v9"
    "go.opentelemetry.io/otel"
)

func NewTracingRedisClient(addr string) *redis.Client {
    client := redis.NewClient(&redis.Options{
        Addr:         addr,
        PoolSize:     20,
        MinIdleConns: 5,
    })

    // Add OTel tracing hook
    if err := redisotel.InstrumentTracing(client,
        redisotel.WithTracerProvider(otel.GetTracerProvider()),
    ); err != nil {
        slog.Error("failed to instrument Redis tracing", "err", err)
    }

    return client
}
```

OpenTelemetry's comprehensive instrumentation ecosystem means that once you've set up the SDK, most of your third-party libraries can be instrumented with a single import. The investment in W3C propagation and baggage pays dividends when debugging production issues — you can correlate a single end-user request across every service, database query, and cache operation in the system.
