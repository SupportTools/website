---
title: "Go Distributed Tracing Instrumentation: OpenTelemetry SDK, Context Propagation, and Trace Sampling Strategies"
date: 2031-10-10T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "OpenTelemetry", "Distributed Tracing", "Observability", "Jaeger", "OTLP"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to instrumenting Go services with OpenTelemetry: SDK initialization, span creation, context propagation across HTTP and gRPC, custom attributes, sampling strategies, and exporting traces to Jaeger and Tempo."
more_link: "yes"
url: "/go-distributed-tracing-opentelemetry-context-propagation/"
---

Distributed tracing is the only observability signal that shows the causal chain across service boundaries. Metrics tell you something is wrong; logs tell you what happened on one service; traces tell you why a request took 3 seconds and which of eight microservices contributed to that latency. OpenTelemetry provides a vendor-neutral SDK for Go that instruments HTTP clients, gRPC, database calls, and custom operations, with pluggable exporters for Jaeger, Grafana Tempo, Honeycomb, and any OTLP-compatible backend. This guide covers every layer from tracer provider initialization to production sampling strategies.

<!--more-->

# Go Distributed Tracing with OpenTelemetry

## Section 1: OpenTelemetry Concepts

OpenTelemetry defines a data model with four core concepts:

**Trace**: A collection of spans representing a single request's journey through the system. Identified by a `TraceID` (16 bytes).

**Span**: A single operation within a trace. Has a `SpanID` (8 bytes), start time, end time, status, and arbitrary key-value attributes. Spans form a tree via parent-child relationships.

**Context**: Go's `context.Context` carries the current span. Every function that creates child spans must accept and thread a context.

**Propagator**: Serializes trace context into HTTP headers or gRPC metadata for cross-process propagation. The W3C Trace Context format (`traceparent`, `tracestate`) is the standard.

### Dependency Setup

```bash
go get go.opentelemetry.io/otel@v1.30.0
go get go.opentelemetry.io/otel/trace@v1.30.0
go get go.opentelemetry.io/otel/sdk@v1.30.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.30.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.30.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.55.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.55.0
go get go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql@v0.55.0
```

## Section 2: Tracer Provider Initialization

The `TracerProvider` is the factory for tracers. Initialize it once at startup and register it globally.

```go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Config holds telemetry configuration.
type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string // e.g., "otel-collector.monitoring.svc.cluster.local:4318"
    SampleRate     float64
}

// Init configures and registers the global TracerProvider.
// Returns a shutdown function that must be called on service exit.
func Init(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    // Build the resource describing this service
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
            attribute.String("service.instance.id", hostname()),
        ),
        resource.WithOS(),
        resource.WithProcess(),
        resource.WithContainer(),
    )
    if err != nil {
        return nil, fmt.Errorf("build resource: %w", err)
    }

    // OTLP HTTP exporter
    exporter, err := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(cfg.OTLPEndpoint),
        otlptracehttp.WithInsecure(),
        otlptracehttp.WithTimeout(10*time.Second),
        otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
            Enabled:         true,
            InitialInterval: 1 * time.Second,
            MaxInterval:     10 * time.Second,
            MaxElapsedTime:  30 * time.Second,
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("create exporter: %w", err)
    }

    // Sampling strategy
    sampler := buildSampler(cfg.SampleRate)

    // Batch span processor with tuned parameters
    bsp := sdktrace.NewBatchSpanProcessor(exporter,
        sdktrace.WithBatchTimeout(2*time.Second),
        sdktrace.WithExportTimeout(10*time.Second),
        sdktrace.WithMaxExportBatchSize(512),
        sdktrace.WithMaxQueueSize(4096),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithSampler(sampler),
        sdktrace.WithSpanProcessor(bsp),
        sdktrace.WithResource(res),
    )

    // Register as global provider
    otel.SetTracerProvider(tp)

    // Register W3C Trace Context + Baggage propagators
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return func(ctx context.Context) error {
        ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
        return tp.Shutdown(ctx)
    }, nil
}

func buildSampler(rate float64) sdktrace.Sampler {
    if rate >= 1.0 {
        return sdktrace.AlwaysSample()
    }
    if rate <= 0.0 {
        return sdktrace.NeverSample()
    }
    // Parent-based: if parent is sampled, sample. Otherwise, use ratio.
    return sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(rate),
    )
}

func hostname() string {
    h, _ := os.Hostname()
    return h
}
```

## Section 3: Creating and Annotating Spans

### Basic Span Creation

```go
package service

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

// tracer is package-scoped; name it with the package import path
var tracer = otel.Tracer("github.com/example/payment-service/service")

type PaymentService struct {
    db     DB
    mailer Mailer
}

func (s *PaymentService) ProcessPayment(ctx context.Context, req *PaymentRequest) (*PaymentResult, error) {
    // Start a span; the span is attached to the returned context
    ctx, span := tracer.Start(ctx, "ProcessPayment",
        trace.WithAttributes(
            attribute.String("payment.id", req.ID),
            attribute.String("payment.currency", req.Currency),
            attribute.Float64("payment.amount", req.Amount),
            attribute.String("payment.customer_id", req.CustomerID),
        ),
        trace.WithSpanKind(trace.SpanKindInternal),
    )
    defer span.End()

    // Add events for significant milestones
    span.AddEvent("validation_started")

    if err := s.validateRequest(ctx, req); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "validation failed")
        return nil, fmt.Errorf("validate: %w", err)
    }
    span.AddEvent("validation_complete")

    result, err := s.chargeCard(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "charge failed")
        return nil, fmt.Errorf("charge: %w", err)
    }

    // Update span attributes after computation
    span.SetAttributes(
        attribute.String("payment.transaction_id", result.TransactionID),
        attribute.String("payment.status", "completed"),
    )
    span.SetStatus(codes.Ok, "")

    return result, nil
}

func (s *PaymentService) chargeCard(ctx context.Context, req *PaymentRequest) (*PaymentResult, error) {
    ctx, span := tracer.Start(ctx, "chargeCard",
        trace.WithAttributes(
            attribute.String("card.last_four", req.CardLastFour),
            attribute.String("payment.processor", "stripe"),
        ),
    )
    defer span.End()

    // Child span for database operation
    if err := s.db.RecordPendingCharge(ctx, req.ID); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    // Simulate external API call (see Section 4 for HTTP instrumentation)
    result, err := s.callStripeAPI(ctx, req)
    if err != nil {
        span.RecordError(err,
            trace.WithAttributes(
                attribute.String("stripe.error_code", extractStripeCode(err)),
            ),
        )
        span.SetStatus(codes.Error, "stripe API error")
        return nil, err
    }

    span.SetAttributes(attribute.String("stripe.charge_id", result.StripeID))
    return result, nil
}
```

### Span Links for Async Operations

Span links connect spans that have a causal relationship but are not in a parent-child hierarchy. Use them for message queue consumers.

```go
func (w *Worker) ProcessKafkaMessage(ctx context.Context, msg *kafka.Message) error {
    // Extract the trace context from the message header
    carrier := kafkaHeaderCarrier(msg.Headers)
    producerCtx := otel.GetTextMapPropagator().Extract(ctx, carrier)
    producerSpanCtx := trace.SpanContextFromContext(producerCtx)

    // Create a new root span for consumer processing, linked to the producer span
    ctx, span := tracer.Start(ctx, "ProcessKafkaMessage",
        trace.WithSpanKind(trace.SpanKindConsumer),
        trace.WithLinks(trace.Link{
            SpanContext: producerSpanCtx,
            Attributes: []attribute.KeyValue{
                attribute.String("messaging.link_type", "producer"),
            },
        }),
        trace.WithAttributes(
            attribute.String("messaging.system", "kafka"),
            attribute.String("messaging.destination", msg.Topic),
            attribute.Int("messaging.kafka.partition", int(msg.Partition)),
            attribute.Int64("messaging.kafka.offset", msg.Offset),
        ),
    )
    defer span.End()

    return w.handle(ctx, msg.Value)
}
```

## Section 4: HTTP Instrumentation

### HTTP Server with otelhttp

```go
package main

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/v1/payments", handlePayments)
    mux.HandleFunc("/v1/health", handleHealth)

    // Wrap the entire mux — every request gets a span
    handler := otelhttp.NewHandler(mux, "payment-service",
        otelhttp.WithMessageEvents(
            otelhttp.ReadEvents,
            otelhttp.WriteEvents,
        ),
        otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
            // Use the route pattern, not the full URL, to avoid high cardinality
            return fmt.Sprintf("%s %s", r.Method, r.URL.Path)
        }),
    )

    http.ListenAndServe(":8080", handler)
}
```

### HTTP Client Instrumentation

```go
package client

import (
    "context"
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewHTTPClient returns an HTTP client that propagates trace context.
func NewHTTPClient() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport,
            otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
                return fmt.Sprintf("HTTP %s %s", r.Method, r.URL.Host+r.URL.Path)
            }),
        ),
        Timeout: 30 * time.Second,
    }
}

// Usage: the trace context in ctx is automatically injected as HTTP headers
func callDownstreamService(ctx context.Context, client *http.Client) error {
    req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
        "http://inventory-service.production.svc.cluster.local/v1/items/SKU-12345", nil)
    resp, err := client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    return nil
}
```

## Section 5: gRPC Instrumentation

```go
package grpcclient

import (
    "google.golang.org/grpc"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

// DialWithTracing creates a gRPC connection with OTel interceptors.
func DialWithTracing(target string) (*grpc.ClientConn, error) {
    return grpc.NewClient(target,
        grpc.WithStatsHandler(otelgrpc.NewClientHandler(
            otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
        )),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
}

// Server setup
func NewGRPCServer() *grpc.Server {
    return grpc.NewServer(
        grpc.StatsHandler(otelgrpc.NewServerHandler(
            otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
        )),
    )
}
```

## Section 6: Database Instrumentation

```go
package database

import (
    "database/sql"

    "go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    _ "github.com/lib/pq"
)

// OpenDB opens a PostgreSQL connection with automatic span creation
// for every query.
func OpenDB(dsn string) (*sql.DB, error) {
    db, err := otelsql.Open("postgres", dsn,
        otelsql.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.ServerAddress("postgres.production.svc.cluster.local"),
            semconv.ServerPort(5432),
            semconv.DBName("payments"),
        ),
        otelsql.WithSpanOptions(otelsql.SpanOptions{
            // Include the full SQL statement in the span
            // WARNING: disable in production if queries contain PII
            DisableErrSkip:  true,
            OmitRows:        false,
            RecordError: func(err error) bool {
                return !errors.Is(err, sql.ErrNoRows)
            },
        }),
    )
    if err != nil {
        return nil, err
    }

    // Register DB stats metrics
    if err := otelsql.RegisterDBStatsMetrics(db,
        otelsql.WithAttributes(semconv.DBSystemPostgreSQL),
    ); err != nil {
        return nil, err
    }

    return db, nil
}
```

## Section 7: Context Propagation Patterns

### Propagating Across Service Boundaries

```go
package propagation

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// InjectHTTP injects trace context into outgoing HTTP request headers.
func InjectHTTP(ctx context.Context, req *http.Request) {
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// ExtractHTTP extracts trace context from incoming HTTP request headers.
func ExtractHTTP(ctx context.Context, req *http.Request) context.Context {
    return otel.GetTextMapPropagator().Extract(ctx, propagation.HeaderCarrier(req.Header))
}

// Custom carrier for Kafka message headers
type KafkaHeaderCarrier []kafka.Header

func (c KafkaHeaderCarrier) Get(key string) string {
    for _, h := range c {
        if strings.EqualFold(h.Key, key) {
            return string(h.Value)
        }
    }
    return ""
}

func (c *KafkaHeaderCarrier) Set(key, val string) {
    *c = append(*c, kafka.Header{Key: key, Value: []byte(val)})
}

func (c KafkaHeaderCarrier) Keys() []string {
    keys := make([]string, len(c))
    for i, h := range c {
        keys[i] = h.Key
    }
    return keys
}

// InjectKafka injects trace context into Kafka message headers.
func InjectKafka(ctx context.Context, headers *[]kafka.Header) {
    carrier := KafkaHeaderCarrier(*headers)
    otel.GetTextMapPropagator().Inject(ctx, &carrier)
    *headers = []kafka.Header(carrier)
}
```

### Baggage for Cross-Service Attributes

Baggage allows you to propagate key-value pairs across service boundaries. Use sparingly (adds overhead to every request).

```go
package baggage

import (
    "context"

    "go.opentelemetry.io/otel/baggage"
)

// AttachTenantID adds tenant ID to baggage for downstream propagation.
func AttachTenantID(ctx context.Context, tenantID string) (context.Context, error) {
    m, err := baggage.NewMember("tenant.id", tenantID)
    if err != nil {
        return ctx, err
    }
    b, err := baggage.New(m)
    if err != nil {
        return ctx, err
    }
    return baggage.ContextWithBaggage(ctx, b), nil
}

// ExtractTenantID reads the tenant ID from baggage.
func ExtractTenantID(ctx context.Context) string {
    b := baggage.FromContext(ctx)
    return b.Member("tenant.id").Value()
}

// Usage in middleware
func TenantBaggageMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tenantID := r.Header.Get("X-Tenant-ID")
        if tenantID != "" {
            ctx, err := AttachTenantID(r.Context(), tenantID)
            if err == nil {
                r = r.WithContext(ctx)
                // Also set as span attribute
                span := trace.SpanFromContext(ctx)
                span.SetAttributes(attribute.String("tenant.id", tenantID))
            }
        }
        next.ServeHTTP(w, r)
    })
}
```

## Section 8: Sampling Strategies

### Head-Based Sampling

Head-based sampling decisions are made at the root span before any child spans are created. The `TraceIDRatioBased` sampler uses the trace ID hash to deterministically include or exclude a trace.

```go
// Sample 10% of all traces, but always sample traces with errors
type errorAwareSampler struct {
    base sdktrace.Sampler
}

func (s errorAwareSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample if parent was sampled
    if p.ParentContext.IsSampled() {
        return sdktrace.SamplingResult{
            Decision:   sdktrace.RecordAndSample,
            Tracestate: p.ParentContext.TraceState(),
        }
    }
    // Fall back to base sampler
    return s.base.ShouldSample(p)
}

func (s errorAwareSampler) Description() string {
    return fmt.Sprintf("ErrorAwareSampler(%s)", s.base.Description())
}
```

### Tail-Based Sampling via OpenTelemetry Collector

For tail-based sampling (decide after seeing all spans), configure the OTel Collector's `tailsampling` processor:

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
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    expected_new_traces_per_sec: 1000
    policies:
      # Always sample errors
      - name: errors-policy
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Always sample slow traces (> 1 second)
      - name: latency-policy
        type: latency
        latency:
          threshold_ms: 1000

      # Sample traces containing specific attributes
      - name: payment-policy
        type: string_attribute
        string_attribute:
          key: payment.amount
          values: [".*"]  # All payment traces
          enabled_regex_matching: true

      # Probabilistic fallback: 5% of remaining
      - name: probabilistic-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 5

  batch:
    timeout: 5s
    send_batch_size: 1024

exporters:
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [otlp/tempo]
```

## Section 9: Custom Span Exporters and Testing

### Testing with In-Memory Exporter

```go
package service_test

import (
    "context"
    "testing"

    "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/sdk/trace/tracetest"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestPaymentServiceTracing(t *testing.T) {
    // Set up in-memory span recorder
    spanRecorder := tracetest.NewSpanRecorder()
    tp := trace.NewTracerProvider(
        trace.WithSpanProcessor(spanRecorder),
    )

    // Initialize service with test tracer provider
    svc := NewPaymentService(tp)

    ctx := context.Background()
    req := &PaymentRequest{
        ID:         "pay-test-001",
        Amount:     99.99,
        Currency:   "USD",
        CustomerID: "cust-12345",
    }

    _, err := svc.ProcessPayment(ctx, req)
    require.NoError(t, err)

    // Inspect recorded spans
    spans := spanRecorder.Ended()
    require.Len(t, spans, 3) // ProcessPayment + chargeCard + RecordPendingCharge

    // Verify root span
    rootSpan := spans[2] // last span ended = outermost
    assert.Equal(t, "ProcessPayment", rootSpan.Name())
    assert.Equal(t, codes.Ok, rootSpan.Status().Code)

    attrs := attrsToMap(rootSpan.Attributes())
    assert.Equal(t, "pay-test-001", attrs["payment.id"])
    assert.Equal(t, "USD", attrs["payment.currency"])

    // Verify span hierarchy
    assert.Equal(t, rootSpan.SpanContext().SpanID(), spans[1].Parent().SpanID())
}

func attrsToMap(attrs []attribute.KeyValue) map[string]string {
    m := make(map[string]string, len(attrs))
    for _, a := range attrs {
        m[string(a.Key)] = a.Value.AsString()
    }
    return m
}
```

## Section 10: Kubernetes Deployment for OTel Collector

```yaml
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
          image: otel/opentelemetry-collector-contrib:0.110.0
          args: ["--config=/conf/otel-collector-config.yaml"]
          ports:
            - name: otlp-grpc
              containerPort: 4317
            - name: otlp-http
              containerPort: 4318
            - name: metrics
              containerPort: 8888
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          volumeMounts:
            - name: config
              mountPath: /conf
          livenessProbe:
            httpGet:
              path: /
              port: 13133
            initialDelaySeconds: 5
          readinessProbe:
            httpGet:
              path: /
              port: 13133
            initialDelaySeconds: 5
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  selector:
    app: otel-collector
  ports:
    - name: otlp-grpc
      port: 4317
      targetPort: 4317
    - name: otlp-http
      port: 4318
      targetPort: 4318
```

## Section 11: Performance Overhead Measurement

Tracing adds latency. Measure it to choose the right sampling rate:

```go
func BenchmarkSpanCreation(b *testing.B) {
    // Baseline: no tracing
    b.Run("no-op tracer", func(b *testing.B) {
        tp := trace.NewTracerProvider()
        tr := tp.Tracer("bench")
        ctx := context.Background()
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            _, span := tr.Start(ctx, "op")
            span.End()
        }
    })

    // Full tracing with in-memory recorder
    b.Run("recording tracer", func(b *testing.B) {
        rec := tracetest.NewSpanRecorder()
        tp := trace.NewTracerProvider(trace.WithSpanProcessor(rec))
        tr := tp.Tracer("bench")
        ctx := context.Background()
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            _, span := tr.Start(ctx, "op",
                trace.WithAttributes(
                    attribute.String("key1", "value1"),
                    attribute.Int64("key2", 42),
                ),
            )
            span.End()
        }
    })
}
```

Typical results: no-op tracer ~50 ns/op, recording tracer ~500 ns/op. At 1% sampling, the amortized overhead on a 1 ms operation is negligible.

## Section 12: Alerting on Trace Data

Grafana Tempo with Prometheus metrics extracted from traces:

```yaml
# Tempo configuration for span metrics (generates RED metrics from traces)
metricsGenerator:
  enabled: true
  processors:
    - service-graphs
    - span-metrics
  storage:
    path: /tmp/tempo/generator
    remote_write:
      - url: http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write
        send_exemplars: true
```

PrometheusRule for trace-derived alerts:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tracing-derived-alerts
  namespace: monitoring
spec:
  groups:
    - name: span-metrics
      rules:
        - alert: HighSpanErrorRate
          expr: |
            sum by (service_name, span_name) (
              rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m])
            ) /
            sum by (service_name, span_name) (
              rate(traces_spanmetrics_calls_total[5m])
            ) > 0.01
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High error rate on {{ $labels.service_name }}/{{ $labels.span_name }}"

        - alert: HighP95Latency
          expr: |
            histogram_quantile(0.95,
              sum by (le, service_name, span_name) (
                rate(traces_spanmetrics_duration_milliseconds_bucket[5m])
              )
            ) > 500
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "P95 latency > 500ms for {{ $labels.service_name }}"
```

## Summary

OpenTelemetry provides a complete, vendor-neutral tracing solution for Go services. The SDK's `TracerProvider` initializes once and distributes tracers throughout the application. `context.Context` threading ensures trace context propagates across function boundaries without global state. Auto-instrumentation libraries for HTTP, gRPC, and SQL eliminate the most repetitive instrumentation work. Tail-based sampling in the OTel Collector ensures high-value traces (errors, slow requests) are always captured while controlling backend storage costs. The result is a tracing system that makes the full request flow across dozens of microservices visible in a single waterfall view.
