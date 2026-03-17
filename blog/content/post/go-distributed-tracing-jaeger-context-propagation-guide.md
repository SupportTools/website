---
title: "Go Distributed Tracing: Jaeger Integration, Context Propagation, and Sampling Strategies"
date: 2029-12-02T00:00:00-05:00
draft: false
tags: ["Go", "Jaeger", "Distributed Tracing", "OpenTelemetry", "Context Propagation", "B3", "W3C", "Sampling"]
categories:
- Go
- Observability
- Tracing
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Jaeger setup, OpenTracing to OpenTelemetry migration, context propagation, B3 and W3C headers, and adaptive sampling strategies for Go microservices."
more_link: "yes"
url: "/go-distributed-tracing-jaeger-context-propagation-guide/"
---

Distributed tracing is the only observability tool that shows you the complete path of a request through multiple services. Without it, diagnosing a slow API call means individually checking logs across five services hoping to find the correlation. With Jaeger and OpenTelemetry, you see the entire request as a single trace: every service, every database query, every external HTTP call, with exact durations.

<!--more-->

## Section 1: Distributed Tracing Fundamentals

A trace represents the complete lifecycle of a single request across all services. It consists of spans — units of work with a start time, duration, and attributes. Spans are related in a parent-child hierarchy, forming a tree that visualizes the call sequence.

```
Trace: order-checkout (TraceID: 4bf92f3577b34da6)
│
├── api-gateway: POST /checkout (SpanID: 00f067aa0ba902b7)     0ms - 312ms
│   │
│   ├── user-service: validateSession (SpanID: b9c7c989f97918e1)  2ms - 45ms
│   │   └── redis: GET session:usr:123 (SpanID: 3d7e8b4c1a2f5e9d) 2ms - 5ms
│   │
│   ├── inventory-service: checkStock (SpanID: a2fb4a1d1a96d312)  47ms - 89ms
│   │   └── postgres: SELECT ... (SpanID: f4c0d4a2b8f1e3c5)      50ms - 85ms
│   │
│   └── payment-service: chargeCard (SpanID: e457b5a22e02e2de)    91ms - 307ms
│       ├── stripe-api: POST /charges (SpanID: 3e4ab13c42e22d8c) 93ms - 290ms
│       └── postgres: INSERT transactions (SpanID: 1a2b3c4d5e6f)  293ms - 305ms
```

The trace reveals immediately that `stripe-api` accounts for 197ms of the 312ms total — the optimization target is obvious without digging through logs.

### Key Trace Concepts

**TraceID**: A 128-bit identifier unique to the entire trace, shared across all services.

**SpanID**: A 64-bit identifier unique within the trace, assigned per span.

**Span Context**: The tuple (TraceID, SpanID, TraceFlags, TraceState) that must be propagated between services to maintain trace continuity.

**Baggage**: Key-value pairs that travel with the trace context and can be read by any service in the call chain.

## Section 2: Deploying Jaeger

### Kubernetes Deployment (Jaeger All-in-One for Development)

```yaml
# jaeger-dev.yaml — for development/staging, not production
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
          image: jaegertracing/all-in-one:1.58
          ports:
            - containerPort: 16686  # UI
            - containerPort: 4317   # OTLP gRPC
            - containerPort: 4318   # OTLP HTTP
            - containerPort: 6831   # Jaeger Thrift (legacy)
              protocol: UDP
          env:
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
            - name: SPAN_STORAGE_TYPE
              value: "memory"
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
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

### Production Jaeger with Elasticsearch Backend

```yaml
# jaeger-collector-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger-collector
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: jaeger-collector
  template:
    metadata:
      labels:
        app: jaeger-collector
    spec:
      containers:
        - name: jaeger-collector
          image: jaegertracing/jaeger-collector:1.58
          args:
            - --collector.otlp.enabled=true
            - --span-storage.type=elasticsearch
            - --es.server-urls=http://elasticsearch:9200
            - --es.index-prefix=jaeger
            - --es.num-shards=3
            - --es.num-replicas=1
          ports:
            - containerPort: 4317
              name: otlp-grpc
            - containerPort: 4318
              name: otlp-http
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2
              memory: 2Gi
```

## Section 3: Go OTel SDK with Jaeger Export

### Complete Bootstrap

```go
// internal/tracing/jaeger.go
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
    JaegerEndpoint string
    SamplerConfig  SamplerConfig
}

type SamplerConfig struct {
    Type       string  // "ratio", "always", "never", "parentbased"
    Ratio      float64 // used when Type == "ratio"
}

func Bootstrap(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithFromEnv(),
        resource.WithProcess(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // Connect to Jaeger OTLP endpoint
    conn, err := grpc.NewClient(cfg.JaegerEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to jaeger at %s: %w", cfg.JaegerEndpoint, err)
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating otlp exporter: %w", err)
    }

    sampler := buildSampler(cfg.SamplerConfig)

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithSampler(sampler),
        sdktrace.WithResource(res),
    )

    // Set global tracer provider
    otel.SetTracerProvider(tp)

    // Set global propagator (W3C TraceContext is the default; add B3 for legacy systems)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},  // W3C traceparent/tracestate headers
        propagation.Baggage{},       // W3C baggage header
    ))

    shutdown := func(ctx context.Context) error {
        if err := tp.Shutdown(ctx); err != nil {
            return err
        }
        return conn.Close()
    }

    return shutdown, nil
}

func buildSampler(cfg SamplerConfig) sdktrace.Sampler {
    switch cfg.Type {
    case "always":
        return sdktrace.AlwaysSample()
    case "never":
        return sdktrace.NeverSample()
    case "ratio":
        return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.Ratio))
    default: // "parentbased" is the default
        return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))
    }
}
```

### Creating and Using Spans

```go
// internal/service/order.go
package service

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("order-service",
    trace.WithInstrumentationVersion("v2.4.1"),
    trace.WithSchemaURL("https://opentelemetry.io/schemas/1.26.0"),
)

type OrderService struct {
    db          OrderRepository
    paymentSvc  PaymentClient
    inventorySvc InventoryClient
}

func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    ctx, span := tracer.Start(ctx, "OrderService.CreateOrder",
        trace.WithAttributes(
            attribute.String("order.customer_id", req.CustomerID),
            attribute.String("order.product_id", req.ProductID),
            attribute.Int64("order.quantity", int64(req.Quantity)),
        ),
        trace.WithSpanKind(trace.SpanKindInternal),
    )
    defer span.End()

    // Validate inventory
    ctx, validateSpan := tracer.Start(ctx, "checkInventory")
    available, err := s.inventorySvc.CheckStock(ctx, req.ProductID, req.Quantity)
    validateSpan.End()
    if err != nil {
        span.RecordError(err, trace.WithAttributes(
            attribute.String("inventory.error_type", "check_failed"),
        ))
        span.SetStatus(codes.Error, "inventory check failed")
        return nil, fmt.Errorf("checking inventory: %w", err)
    }
    if !available {
        span.SetAttributes(attribute.Bool("order.stock_available", false))
        span.SetStatus(codes.Error, "insufficient stock")
        return nil, ErrInsufficientStock
    }
    span.SetAttributes(attribute.Bool("order.stock_available", true))

    // Process payment
    ctx, paymentSpan := tracer.Start(ctx, "processPayment",
        trace.WithAttributes(
            attribute.String("payment.currency", req.Currency),
            attribute.Float64("payment.amount", req.Amount),
        ),
    )
    txnID, err := s.paymentSvc.Charge(ctx, req.CustomerID, req.Amount, req.Currency)
    if err != nil {
        paymentSpan.RecordError(err)
        paymentSpan.SetStatus(codes.Error, "payment failed")
        paymentSpan.End()
        return nil, fmt.Errorf("processing payment: %w", err)
    }
    paymentSpan.SetAttributes(attribute.String("payment.transaction_id", txnID))
    paymentSpan.End()

    // Persist order
    ctx, dbSpan := tracer.Start(ctx, "db.insertOrder",
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.operation", "INSERT"),
            attribute.String("db.table", "orders"),
        ),
        trace.WithSpanKind(trace.SpanKindClient),
    )
    order, err := s.db.CreateOrder(ctx, req, txnID)
    dbSpan.End()
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "db insert failed")
        return nil, fmt.Errorf("persisting order: %w", err)
    }

    span.SetAttributes(attribute.String("order.id", order.ID))
    span.SetStatus(codes.Ok, "")
    return order, nil
}
```

## Section 4: Context Propagation

Context propagation carries the trace context across service boundaries. The propagator injects span context into outbound request headers and extracts it from inbound headers.

### HTTP Context Propagation

```go
// Outbound: inject trace context into HTTP request headers
func instrumentHTTPClient(base http.RoundTripper) http.RoundTripper {
    return otelhttp.NewTransport(base)
}

// The otelhttp.NewTransport automatically:
// 1. Reads the span from the current context
// 2. Injects traceparent/tracestate headers
// 3. Creates a client span for the outbound call
// 4. Records HTTP status code and URL

// Usage
client := &http.Client{
    Transport: instrumentHTTPClient(http.DefaultTransport),
}

// Inbound: extract trace context from HTTP request headers
handler := otelhttp.NewHandler(mux, "http.server")
// otelhttp.NewHandler automatically:
// 1. Extracts traceparent/tracestate from incoming headers
// 2. Creates a new server span as child of the propagated parent
// 3. Sets the span in the request context
```

### Manual Propagation for Non-HTTP Protocols

For Kafka, AMQP, and other messaging systems, propagate context via message headers:

```go
// internal/messaging/producer.go
package messaging

import (
    "context"

    "github.com/segmentio/kafka-go"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

type kafkaHeaderCarrier []kafka.Header

func (c *kafkaHeaderCarrier) Get(key string) string {
    for _, h := range *c {
        if h.Key == key {
            return string(h.Value)
        }
    }
    return ""
}

func (c *kafkaHeaderCarrier) Set(key string, value string) {
    *c = append(*c, kafka.Header{Key: key, Value: []byte(value)})
}

func (c *kafkaHeaderCarrier) Keys() []string {
    keys := make([]string, len(*c))
    for i, h := range *c {
        keys[i] = h.Key
    }
    return keys
}

// ProducerMiddleware injects trace context into Kafka message headers
func InjectTraceContext(ctx context.Context, msg *kafka.Message) {
    carrier := kafkaHeaderCarrier(msg.Headers)
    otel.GetTextMapPropagator().Inject(ctx, &carrier)
    msg.Headers = []kafka.Header(carrier)
}

// Consumer: extract trace context from Kafka message headers
func ExtractTraceContext(ctx context.Context, msg kafka.Message) context.Context {
    carrier := kafkaHeaderCarrier(msg.Headers)
    return otel.GetTextMapPropagator().Extract(ctx, &carrier)
}
```

## Section 5: B3 and W3C Headers

Different systems use different trace propagation formats. Understanding them prevents trace fragmentation when your Go service calls a service that uses a different format.

### W3C TraceContext (Recommended)

The W3C standard, supported by all modern OTel implementations:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                 │
             │  │── TraceID (128-bit hex)        │── SpanID        │── Flags (01=sampled)
             │── Version (00)

tracestate: vendor1=abc,vendor2=def
```

### B3 Headers (Zipkin/Legacy)

Older systems (Zipkin, older Jaeger deployments) use B3 propagation:

```
# Multi-header B3
X-B3-TraceId: 4bf92f3577b34da6a3ce929d0e0e4736
X-B3-SpanId: 00f067aa0ba902b7
X-B3-Sampled: 1
X-B3-ParentSpanId: a2fb4a1d1a96d312  (optional)

# Single-header B3
b3: 4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1-a2fb4a1d1a96d312
```

### Multi-Format Propagation

```go
import (
    "go.opentelemetry.io/contrib/propagators/b3"
    "go.opentelemetry.io/otel/propagation"
)

// Support both W3C and B3 for transition periods
otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
    propagation.TraceContext{},  // W3C (preferred, checked first)
    propagation.Baggage{},
    b3.New(b3.WithInjectEncoding(b3.B3MultipleHeader)),  // Legacy B3
))
```

## Section 6: Sampling Strategies

### Head-Based Sampling (Decision at Trace Start)

```go
// Deterministic sampling: same TraceID always gets same decision
// Useful when services must agree on sampling without coordination
sampler := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.05),  // 5% sample rate
    // If parent was sampled, always sample child spans
    sdktrace.WithRemoteSampledParentSampler(sdktrace.AlwaysSample()),
    sdktrace.WithRemoteNotSampledParentSampler(sdktrace.NeverSample()),
)
```

### Error-Priority Sampling

A common pattern: always sample errors, rate-limit successful requests:

```go
// internal/tracing/sampler.go
type ErrorPrioritySampler struct {
    base sdktrace.Sampler
}

func (s ErrorPrioritySampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Check if any attribute indicates an error
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{
                Decision:   sdktrace.RecordAndSample,
                Tracestate: p.ParentContext.TraceState(),
            }
        }
    }
    return s.base.ShouldSample(p)
}

func (s ErrorPrioritySampler) Description() string {
    return fmt.Sprintf("ErrorPriority{%s}", s.base.Description())
}

func NewErrorPrioritySampler(baseRate float64) sdktrace.Sampler {
    return ErrorPrioritySampler{
        base: sdktrace.ParentBased(sdktrace.TraceIDRatioBased(baseRate)),
    }
}
```

### OTel Collector Tail Sampling (Post-Decision)

```yaml
# otel-collector-config.yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 5000
    policies:
      # Always keep errors
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Always keep slow requests (>1s)
      - name: slow-requests
        type: latency
        latency:
          threshold_ms: 1000

      # Keep all health check traces excluded
      - name: no-health-checks
        type: string_attribute
        string_attribute:
          key: http.route
          values: ["/health", "/ready", "/metrics"]
          invert_match: true

      # Keep 2% of everything else
      - name: probabilistic
        type: and
        and:
          and_sub_policy:
            - name: not-health
              type: string_attribute
              string_attribute:
                key: http.route
                values: ["/health", "/ready", "/metrics"]
                invert_match: true
            - name: base-rate
              type: probabilistic
              probabilistic:
                sampling_percentage: 2
```

## Section 7: Jaeger Query API for Automation

```bash
# List services
curl "http://jaeger:16686/api/services"

# Get traces for a service in the last hour
curl "http://jaeger:16686/api/traces?service=order-service&limit=20&lookback=1h"

# Find traces with high latency (>2000ms)
curl "http://jaeger:16686/api/traces?service=order-service&minDuration=2000ms&limit=20"

# Find traces containing a specific operation
curl "http://jaeger:16686/api/traces?service=order-service&operation=OrderService.CreateOrder"

# Get a specific trace by ID
curl "http://jaeger:16686/api/traces/4bf92f3577b34da6a3ce929d0e0e4736"
```

### Automated Trace Analysis in Go

```go
// scripts/analyze-traces/main.go
func analyzeSlowTraces(ctx context.Context, jaegerURL, service string) error {
    url := fmt.Sprintf("%s/api/traces?service=%s&minDuration=1000ms&limit=100&lookback=1h",
        jaegerURL, service)

    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    var result struct {
        Data []struct {
            TraceID string `json:"traceID"`
            Spans   []struct {
                OperationName string            `json:"operationName"`
                Duration      int64             `json:"duration"` // microseconds
                Tags          []struct {
                    Key   string `json:"key"`
                    Value any    `json:"value"`
                } `json:"tags"`
            } `json:"spans"`
        } `json:"data"`
    }

    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return err
    }

    // Find the bottleneck operation across all slow traces
    opDurations := make(map[string][]float64)
    for _, trace := range result.Data {
        for _, span := range trace.Spans {
            opDurations[span.OperationName] = append(
                opDurations[span.OperationName],
                float64(span.Duration)/1000, // ms
            )
        }
    }

    // Print top 10 slowest operations
    fmt.Println("Top slowest operations in traces > 1s:")
    // ... sort and print
    return nil
}
```

## Section 8: OpenTracing to OpenTelemetry Migration

Many existing Go services use the deprecated OpenTracing API. Migration to OTel can be done incrementally using the bridge:

```go
import (
    "github.com/opentracing/opentracing-go"
    otbridge "go.opentelemetry.io/otel/bridge/opentracing"
)

// Phase 1: Install the OTel-to-OpenTracing bridge
// Existing OpenTracing code continues to work; spans are forwarded to OTel
otelTracer := otel.GetTracerProvider().Tracer("migration-bridge")
bridge, wrappedProvider := otbridge.NewTracerPair(otelTracer)

// Set the global OpenTracing tracer to the bridge
opentracing.SetGlobalTracer(bridge)

// Set the OTel provider (wrappedProvider handles the bridging)
otel.SetTracerProvider(wrappedProvider)

// Phase 2: Incrementally replace opentracing calls with otel calls
// Old OpenTracing code still works while new code uses OTel directly
// All spans appear in the same trace in Jaeger

// Phase 3: Remove opentracing dependency once all code is migrated
```

Jaeger and OpenTelemetry together provide a complete distributed tracing solution that scales from a single-service debug tool to a fleet-wide performance analysis platform. The investment in proper context propagation pays dividends every time you need to diagnose a latency issue across service boundaries.
