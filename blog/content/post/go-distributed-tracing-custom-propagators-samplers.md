---
title: "Go Distributed Tracing: Implementing Custom Propagators and Samplers"
date: 2029-06-17T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Tracing", "OpenTelemetry", "Observability", "W3C TraceContext", "Sampling"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to distributed tracing in Go with OpenTelemetry: W3C TraceContext and B3 propagation formats, building custom propagators, parent-based and tail-based sampling, remote sampler configuration, and integrating with Jaeger and Tempo."
more_link: "yes"
url: "/go-distributed-tracing-custom-propagators-samplers/"
---

Distributed tracing connects spans across service boundaries to produce a complete picture of a request's journey through a distributed system. The propagation and sampling decisions are where most production tracing implementations break down: spans lost at service boundaries, sampling decisions that miss the most interesting traces, or sampling rates so high that they overwhelm the collector. This guide covers the OpenTelemetry Go SDK's propagation and sampling APIs, with custom implementations for production scenarios.

<!--more-->

# Go Distributed Tracing: Custom Propagators and Samplers

## OpenTelemetry Go Setup

```bash
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/sdk/trace
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc
go get go.opentelemetry.io/otel/propagation
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

### Provider Initialization

```go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func InitTracer(ctx context.Context, serviceName, serviceVersion, otlpEndpoint string) (func(), error) {
    // Create OTLP exporter
    conn, err := grpc.NewClient(
        otlpEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("grpc dial: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("create exporter: %w", err)
    }

    // Resource describes the entity producing telemetry
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion(serviceVersion),
        ),
        resource.WithFromEnv(),         // OTEL_RESOURCE_ATTRIBUTES
        resource.WithProcess(),
        resource.WithOS(),
        resource.WithContainer(),
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    // Sampler: we'll cover this in detail later
    sampler := sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(0.1), // Sample 10% of new root spans
    )

    // Create the tracer provider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    // Register globally
    otel.SetTracerProvider(tp)

    // Set up W3C TraceContext + B3 propagation
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{}, // W3C TraceContext (primary)
        propagation.Baggage{},     // W3C Baggage
    ))

    return func() {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        tp.Shutdown(ctx)
        conn.Close()
    }, nil
}
```

## W3C TraceContext Propagation

The W3C TraceContext standard defines the `traceparent` and `tracestate` HTTP headers:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^ ^^
             version  trace-id (128 bits, hex)   span-id (64 bits) flags

tracestate: congo=BleGNlZWRzIHRohbGljYXRpb24=,rojo=00f067aa0ba902b7
            vendor-specific state (forwarded unchanged)
```

### Flags

The `01` in the traceparent flags field means sampled. The values are:
- `00` = not sampled (tracing overhead is minimal; spans are not recorded)
- `01` = sampled (record and export this trace)

```go
// How propagation works in practice
func handler(w http.ResponseWriter, r *http.Request) {
    // Extract: reads traceparent from the incoming request
    ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))

    tracer := otel.Tracer("myservice")
    ctx, span := tracer.Start(ctx, "handler")
    defer span.End()

    // The span is a child of the incoming trace context
    // Its traceparent will reference the parent span from the upstream service

    // When making an outbound call:
    req, _ := http.NewRequestWithContext(ctx, "GET", "http://downstream/api", nil)
    // Inject: writes traceparent into the outbound request headers
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    resp, err := http.DefaultClient.Do(req)
    // ...
}
```

## B3 Propagation Format

The B3 format (from Zipkin) predates W3C TraceContext and is still widely used, especially in older microservice environments and Envoy/Istio by default.

```
B3 headers (multi-header format):
X-B3-TraceId:     4bf92f3577b34da6a3ce929d0e0e4736
X-B3-SpanId:      00f067aa0ba902b7
X-B3-ParentSpanId: b9c7c989f97918e1  (absent for root spans)
X-B3-Sampled:     1                   (1=sampled, 0=not sampled)

B3 headers (single-header format):
b3: 4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1-b9c7c989f97918e1
```

### Adding B3 Support

```bash
go get go.opentelemetry.io/contrib/propagators/b3
```

```go
import "go.opentelemetry.io/contrib/propagators/b3"

// Configure composite propagation: try W3C first, then B3
otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
    propagation.TraceContext{},       // W3C TraceContext (primary — modern services)
    propagation.Baggage{},
    b3.New(b3.WithInjectEncoding(b3.B3MultipleHeader)), // B3 multi-header
))

// The composite propagator tries each propagator's Extract in order
// and uses the first one that finds valid headers
// For Inject, it calls ALL propagators so both formats are written
```

## Building a Custom Propagator

Custom propagators are necessary when integrating with legacy systems that use proprietary trace header formats, or when you need to add custom context (e.g., tenant ID, request ID) to the trace context.

### Custom Header Propagator

```go
package propagation

import (
    "context"

    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/trace"
)

// LegacyTraceIDPropagator extracts trace IDs from a legacy X-Request-ID header
// and converts them to OpenTelemetry span context
type LegacyTraceIDPropagator struct{}

const legacyHeaderKey = "X-Request-ID"

// Fields returns the keys this propagator reads/writes
func (p LegacyTraceIDPropagator) Fields() []string {
    return []string{legacyHeaderKey}
}

// Inject writes the current span context into the carrier as a legacy X-Request-ID
func (p LegacyTraceIDPropagator) Inject(ctx context.Context, carrier propagation.TextMapCarrier) {
    sc := trace.SpanFromContext(ctx).SpanContext()
    if !sc.IsValid() {
        return
    }
    // Encode as legacy format: traceID.spanID
    carrier.Set(legacyHeaderKey, sc.TraceID().String()+"."+sc.SpanID().String())
}

// Extract reads the legacy X-Request-ID and creates a span context
func (p LegacyTraceIDPropagator) Extract(ctx context.Context, carrier propagation.TextMapCarrier) context.Context {
    value := carrier.Get(legacyHeaderKey)
    if value == "" {
        return ctx
    }

    // Parse legacy format: traceID.spanID
    parts := strings.SplitN(value, ".", 2)
    if len(parts) != 2 {
        return ctx
    }

    traceID, err := trace.TraceIDFromHex(parts[0])
    if err != nil {
        return ctx
    }
    spanID, err := trace.SpanIDFromHex(parts[1])
    if err != nil {
        return ctx
    }

    sc := trace.NewSpanContext(trace.SpanContextConfig{
        TraceID:    traceID,
        SpanID:     spanID,
        TraceFlags: trace.FlagsSampled, // Assume sampled if header is present
        Remote:     true,
    })

    if !sc.IsValid() {
        return ctx
    }
    return trace.ContextWithRemoteSpanContext(ctx, sc)
}

var _ propagation.TextMapPropagator = LegacyTraceIDPropagator{}
```

### Baggage-Based Tenant Propagator

```go
// TenantPropagator extracts/injects tenant information as both
// W3C Baggage and a custom header for backwards compatibility
type TenantPropagator struct{}

const (
    tenantHeader = "X-Tenant-ID"
    tenantBaggageKey = "tenant.id"
)

func (p TenantPropagator) Fields() []string {
    return []string{tenantHeader}
}

func (p TenantPropagator) Inject(ctx context.Context, carrier propagation.TextMapCarrier) {
    // Read tenant from context (set by application code)
    if tenantID := TenantFromContext(ctx); tenantID != "" {
        carrier.Set(tenantHeader, tenantID)
    }
}

func (p TenantPropagator) Extract(ctx context.Context, carrier propagation.TextMapCarrier) context.Context {
    tenantID := carrier.Get(tenantHeader)
    if tenantID == "" {
        // Also check W3C baggage
        bag := baggage.FromContext(ctx)
        if member := bag.Member(tenantBaggageKey); member.Key() != "" {
            tenantID = member.Value()
        }
    }
    if tenantID != "" {
        ctx = ContextWithTenant(ctx, tenantID)
    }
    return ctx
}
```

## Sampling Strategies

Sampling determines which traces are recorded and exported. The wrong sampling strategy either misses interesting traces or produces so much data that storage costs are prohibitive.

### Parent-Based Sampling (Default)

```go
// ParentBased: if the parent span was sampled, this span is sampled.
// If there is no parent (root span), use the root sampler.
sampler := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.05),  // Sample 5% of root spans
    // Optional: override parent-based behavior for specific cases
    sdktrace.WithRemoteParentSampled(sdktrace.AlwaysSample()),     // Always sample if remote parent was sampled
    sdktrace.WithRemoteParentNotSampled(sdktrace.NeverSample()),   // Never sample if remote parent was not sampled
    sdktrace.WithLocalParentSampled(sdktrace.AlwaysSample()),      // Always sample if local parent was sampled
    sdktrace.WithLocalParentNotSampled(sdktrace.NeverSample()),    // Never sample if local parent was not sampled
)
```

### Custom Rule-Based Sampler

```go
// RuleBasedSampler samples based on span attributes, operation names,
// or other contextual information
type RuleBasedSampler struct {
    rules []SamplingRule
    base  sdktrace.Sampler
}

type SamplingRule struct {
    // Match criteria
    SpanNamePrefix string
    AttributeKey   string
    AttributeValue string
    // Sampling decision
    Rate float64 // 0.0 to 1.0
}

func (s *RuleBasedSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    for _, rule := range s.rules {
        if rule.matches(p) {
            return s.applyRate(rule.Rate, p)
        }
    }
    // Fall through to base sampler
    return s.base.ShouldSample(p)
}

func (s *RuleBasedSampler) Description() string {
    return "RuleBasedSampler"
}

func (s *RuleBasedSampler) applyRate(rate float64, p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    if rate >= 1.0 {
        return sdktrace.SamplingResult{
            Decision:   sdktrace.RecordAndSample,
            Tracestate: p.ParentContext.TraceState(),
        }
    }
    if rate <= 0.0 {
        return sdktrace.SamplingResult{
            Decision:   sdktrace.Drop,
            Tracestate: p.ParentContext.TraceState(),
        }
    }

    // Use trace ID for consistent sampling decision within a trace
    traceID := p.TraceID
    // Convert first 8 bytes of trace ID to a uint64 for ratio calculation
    var x uint64
    for i := 0; i < 8; i++ {
        x = (x << 8) | uint64(traceID[i])
    }
    threshold := uint64(rate * (1 << 63) * 2)
    if x < threshold {
        return sdktrace.SamplingResult{
            Decision:   sdktrace.RecordAndSample,
            Tracestate: p.ParentContext.TraceState(),
        }
    }
    return sdktrace.SamplingResult{
        Decision:   sdktrace.Drop,
        Tracestate: p.ParentContext.TraceState(),
    }
}

// Usage: sample all /health endpoints at 1%, everything else at 10%
sampler := &RuleBasedSampler{
    rules: []SamplingRule{
        {SpanNamePrefix: "GET /health", Rate: 0.01},
        {SpanNamePrefix: "GET /readyz", Rate: 0.01},
        {SpanNamePrefix: "GET /metrics", Rate: 0.0}, // Never sample metrics endpoint
        {AttributeKey: "error", AttributeValue: "true", Rate: 1.0}, // Always sample errors
    },
    base: sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1)),
}
```

### Error-Aware Sampler

Sample all errors regardless of the base sampling rate. This is often the most valuable sampling strategy in production:

```go
// ErrorAwareSampler wraps another sampler and always samples spans that have errors
type ErrorAwareSampler struct {
    wrapped sdktrace.Sampler
}

func (s *ErrorAwareSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Check span attributes for errors (set before the sampling decision)
    // Note: most attributes are set AFTER sampling, so this is limited
    // See: tail-based sampling for a better solution

    // But we can check attributes passed at span creation
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{
                Decision:   sdktrace.RecordAndSample,
                Tracestate: p.ParentContext.TraceState(),
            }
        }
        if attr.Key == "http.status_code" {
            code := attr.Value.AsInt64()
            if code >= 500 {
                return sdktrace.SamplingResult{
                    Decision:   sdktrace.RecordAndSample,
                    Tracestate: p.ParentContext.TraceState(),
                }
            }
        }
    }
    return s.wrapped.ShouldSample(p)
}

func (s *ErrorAwareSampler) Description() string {
    return fmt.Sprintf("ErrorAware(%s)", s.wrapped.Description())
}
```

## Tail-Based Sampling

Head-based sampling (at span creation) is limited: you cannot know if a trace will be interesting until it completes. Tail-based sampling buffers spans in a collector, waits for the trace to complete, then decides whether to export it.

### Tail-Based Sampling with OpenTelemetry Collector

```yaml
# otelcol-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  # Tail-based sampling processor
  tail_sampling:
    decision_wait: 30s              # Wait for this long after the first span
    num_traces: 100000              # Max traces buffered in memory
    expected_new_traces_per_sec: 1000
    policies:
    # Always sample traces with errors
    - name: errors-policy
      type: status_code
      status_code:
        status_codes: [ERROR]

    # Always sample slow traces (> 1s)
    - name: slow-traces-policy
      type: latency
      latency:
        threshold_ms: 1000

    # Always sample traces with specific attributes
    - name: important-customer-policy
      type: string_attribute
      string_attribute:
        key: "tenant.tier"
        values: ["enterprise", "premium"]

    # Sample 1% of healthy fast traces
    - name: base-rate-policy
      type: probabilistic
      probabilistic:
        sampling_percentage: 1

    # Combine policies: evaluate in order, use first matching policy's decision
    # OR use and_sub_policy for AND logic
    - name: composite-policy
      type: composite
      composite:
        max_total_spans_per_second: 10000
        policy_order: [errors-policy, slow-traces-policy, important-customer-policy, base-rate-policy]
        composite_sub_policy:
        - name: errors-policy
          type: status_code
          status_code:
            status_codes: [ERROR]
        - name: base-rate-policy
          type: probabilistic
          probabilistic:
            sampling_percentage: 2

exporters:
  otlp:
    endpoint: tempo:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling]
      exporters: [otlp]
```

### Go SDK: Always Export for Tail Sampling

When using tail-based sampling at the collector level, configure the Go SDK to always sample and let the collector make the decision:

```go
// For tail-based sampling: SDK always records, collector filters
tp := sdktrace.NewTracerProvider(
    sdktrace.WithBatcher(exporter),
    sdktrace.WithResource(res),
    sdktrace.WithSampler(sdktrace.AlwaysSample()), // Always export to collector
)
// The tail_sampling processor in the collector applies the real sampling logic
```

## Remote Sampler Configuration

Remote samplers receive sampling configuration from a remote service, allowing you to change sampling rates without redeploying your application.

### Jaeger Remote Sampling

```go
import "go.opentelemetry.io/contrib/samplers/jaegerremote"

// Fetch sampling configuration from Jaeger's remote sampling API
sampler := jaegerremote.New(
    "my-service",
    jaegerremote.WithSamplingServerURL("http://jaeger-collector:5778/sampling"),
    jaegerremote.WithInitialSampler(sdktrace.TraceIDRatioBased(0.1)), // Fallback
    jaegerremote.WithSamplingRefreshInterval(60*time.Second),
)

tp := sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sdktrace.ParentBased(sampler)),
    // ...
)
```

The Jaeger remote sampling API returns a JSON configuration:

```json
{
  "strategyType": "PROBABILISTIC",
  "probabilisticSampling": {
    "samplingRate": 0.05
  }
}
```

Or per-operation:

```json
{
  "strategyType": "PER_OPERATION",
  "perOperationSampling": {
    "defaultSamplingProbability": 0.05,
    "defaultUpperBoundTracesPerSecond": 100,
    "perOperationStrategies": [
      {
        "operation": "GET /health",
        "probabilisticSampling": { "samplingRate": 0.001 }
      },
      {
        "operation": "POST /payments",
        "probabilisticSampling": { "samplingRate": 1.0 }
      }
    ]
  }
}
```

### Dynamic Sampler with Prometheus

```go
// DynamicSampler reads sampling rates from a Prometheus gauge
// that can be updated via the Prometheus HTTP API
type DynamicSampler struct {
    mu      sync.RWMutex
    current float64
    gauge   prometheus.Gauge
}

func NewDynamicSampler(initialRate float64) *DynamicSampler {
    gauge := prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "tracing_sampling_rate",
        Help: "Current trace sampling rate (0.0-1.0)",
    })
    gauge.Set(initialRate)
    prometheus.MustRegister(gauge)

    s := &DynamicSampler{current: initialRate, gauge: gauge}
    // Start a goroutine to read from a config source
    go s.watch()
    return s
}

func (s *DynamicSampler) SetRate(rate float64) {
    s.mu.Lock()
    s.current = rate
    s.mu.Unlock()
    s.gauge.Set(rate)
}

func (s *DynamicSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    s.mu.RLock()
    rate := s.current
    s.mu.RUnlock()

    return sdktrace.TraceIDRatioBased(rate).ShouldSample(p)
}

func (s *DynamicSampler) Description() string { return "DynamicSampler" }
```

## Span Enrichment and Baggage

### Adding Attributes to Spans

```go
func processOrder(ctx context.Context, orderID, customerID string) error {
    tracer := otel.Tracer("order-service")
    ctx, span := tracer.Start(ctx, "processOrder",
        trace.WithAttributes(
            attribute.String("order.id", orderID),
            attribute.String("customer.id", customerID),
        ),
        trace.WithSpanKind(trace.SpanKindInternal),
    )
    defer span.End()

    // Add attributes during execution
    span.SetAttributes(
        attribute.String("order.status", "processing"),
        attribute.Int("order.item_count", 5),
    )

    // Record an event (annotated timestamp on the span)
    span.AddEvent("payment_verified",
        trace.WithAttributes(
            attribute.Float64("amount", 99.99),
            attribute.String("method", "card"),
        ),
    )

    // Record errors
    if err := doWork(ctx); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }

    span.SetStatus(codes.Ok, "")
    return nil
}
```

### Propagating Baggage

Baggage travels with the trace context through all services:

```go
import "go.opentelemetry.io/otel/baggage"

// Set baggage in an upstream service
func setTenantBaggage(ctx context.Context, tenantID string) context.Context {
    member, _ := baggage.NewMember("tenant.id", tenantID)
    bag, _ := baggage.New(member)
    return baggage.ContextWithBaggage(ctx, bag)
}

// Read baggage in any downstream service
func getTenantID(ctx context.Context) string {
    bag := baggage.FromContext(ctx)
    return bag.Member("tenant.id").Value()
}

// Baggage is automatically propagated by the TextMapPropagator
// as the 'baggage' HTTP header (W3C Baggage format):
// baggage: tenant.id=enterprise-123,user.id=user-456
```

## HTTP Middleware Integration

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

// Wrap your HTTP mux with otelhttp for automatic tracing
handler := otelhttp.NewHandler(
    mux,
    "my-service",
    otelhttp.WithTracerProvider(tp),
    otelhttp.WithPropagators(otel.GetTextMapPropagator()),
    // Add the tenant ID from baggage as a span attribute
    otelhttp.WithSpanOptions(
        trace.WithAttributes(attribute.String("tenant.id", "")), // placeholder
    ),
    otelhttp.WithFilter(func(r *http.Request) bool {
        // Don't trace health check endpoints
        return r.URL.Path != "/health" && r.URL.Path != "/readyz"
    }),
)

// HTTP client instrumentation
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
```

## Testing Custom Propagators and Samplers

```go
func TestLegacyTraceIDPropagator(t *testing.T) {
    p := LegacyTraceIDPropagator{}

    t.Run("Extract valid header", func(t *testing.T) {
        traceID, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
        spanID, _ := trace.SpanIDFromHex("00f067aa0ba902b7")

        carrier := propagation.MapCarrier{
            "X-Request-ID": "4bf92f3577b34da6a3ce929d0e0e4736.00f067aa0ba902b7",
        }

        ctx := p.Extract(context.Background(), carrier)
        sc := trace.SpanFromContext(ctx).SpanContext()

        // SpanFromContext returns a noopSpan for non-started spans
        // Use RemoteSpanContextFromContext to get the extracted context
        sc = trace.SpanContextFromContext(ctx)

        if !sc.IsValid() {
            t.Fatal("expected valid span context")
        }
        if sc.TraceID() != traceID {
            t.Errorf("TraceID = %s, want %s", sc.TraceID(), traceID)
        }
        if sc.SpanID() != spanID {
            t.Errorf("SpanID = %s, want %s", sc.SpanID(), spanID)
        }
    })

    t.Run("Extract missing header returns unchanged context", func(t *testing.T) {
        ctx := p.Extract(context.Background(), propagation.MapCarrier{})
        sc := trace.SpanContextFromContext(ctx)
        if sc.IsValid() {
            t.Error("expected invalid span context for missing header")
        }
    })
}

func TestRuleBasedSampler(t *testing.T) {
    sampler := &RuleBasedSampler{
        rules: []SamplingRule{
            {SpanNamePrefix: "GET /health", Rate: 0.0},
        },
        base: sdktrace.AlwaysSample(),
    }

    healthCheck := sdktrace.SamplingParameters{
        Name: "GET /health",
        TraceID: [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
    }

    result := sampler.ShouldSample(healthCheck)
    if result.Decision != sdktrace.Drop {
        t.Errorf("health check should be dropped, got %v", result.Decision)
    }

    otherSpan := sdktrace.SamplingParameters{
        Name: "POST /api/orders",
        TraceID: [16]byte{1},
    }
    result = sampler.ShouldSample(otherSpan)
    if result.Decision != sdktrace.RecordAndSample {
        t.Errorf("regular span should be sampled, got %v", result.Decision)
    }
}
```

## Production Configuration Reference

```go
// production-tracing.go — complete production setup

func SetupTracing(cfg TracingConfig) (func(), error) {
    ctx := context.Background()

    exporter, err := newOTLPExporter(ctx, cfg.CollectorEndpoint)
    if err != nil {
        return nil, err
    }

    // Composite sampler: specific rules → parent-based ratio
    sampler := sdktrace.ParentBased(
        &RuleBasedSampler{
            rules: []SamplingRule{
                {SpanNamePrefix: "GET /health",   Rate: 0.0},
                {SpanNamePrefix: "GET /readyz",   Rate: 0.0},
                {SpanNamePrefix: "GET /livez",    Rate: 0.0},
                {SpanNamePrefix: "GET /metrics",  Rate: 0.0},
                // High-value operations always sampled
                {SpanNamePrefix: "POST /payments", Rate: 1.0},
                {SpanNamePrefix: "POST /orders",   Rate: 1.0},
            },
            base: sdktrace.TraceIDRatioBased(cfg.SamplingRate),
        },
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(newResource(cfg)),
        sdktrace.WithSampler(sampler),
    )

    // W3C TraceContext + B3 for legacy service compatibility + custom tenant propagation
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
        b3.New(b3.WithInjectEncoding(b3.B3MultipleHeader)),
        LegacyTraceIDPropagator{},
        TenantPropagator{},
    ))

    otel.SetTracerProvider(tp)

    return func() {
        ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
        defer cancel()
        tp.Shutdown(ctx)
    }, nil
}
```

## Summary

Effective distributed tracing in production requires three things working together:

1. **Propagation**: every service must extract incoming trace context and inject it into outbound calls. Use W3C TraceContext as the primary format, add B3 for legacy compatibility, and implement custom propagators for any proprietary headers.

2. **Sampling**: head-based sampling at the SDK level handles volume reduction cheaply. Use parent-based sampling to maintain consistent trace sampling decisions across service boundaries. Add error-aware sampling to capture all problematic traces. Use tail-based sampling at the collector level for more sophisticated decisions.

3. **Enrichment**: spans without attributes are nearly useless. Instrument with business-relevant attributes (tenant ID, order ID, customer tier) and use baggage to propagate context through service boundaries without tight coupling.

The custom propagator and sampler interfaces are small — implementing them requires only three methods each — which makes it practical to build production-specific behavior without modifying the core SDK.
