---
title: "Distributed Tracing Sampling Strategies in Go: Head-Based, Tail-Based, and Adaptive Sampling for High-Traffic Services"
date: 2028-06-17T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Tracing", "OpenTelemetry", "Jaeger", "Tempo", "Sampling", "Observability"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to distributed tracing sampling strategies in Go: head-based vs tail-based sampling implementation, adaptive rate limiting, Jaeger and Tempo sampling configuration, and preventing trace data explosion in high-traffic microservices."
more_link: "yes"
url: "/go-distributed-tracing-sampling-strategies-guide/"
---

At 10,000 requests per second, storing every trace produces 864 million trace records per day. Most of those traces are identical successful responses — storing them provides zero debugging value while consuming enormous storage and processing resources. Effective sampling keeps traces representative without drowning your observability backend.

The challenge is that naive random sampling discards exactly the traces you most need: errors, high-latency outliers, and anomalous behavior patterns. A 1% random sample might never capture a rare 5-second database timeout that affects 0.1% of users. Smart sampling strategies solve this: keep all errors, sample successes proportionally, and adapt rates based on observed traffic patterns.

This guide covers the complete sampling design space for Go services using OpenTelemetry, with production configurations for Jaeger and Grafana Tempo.

<!--more-->

## Sampling Fundamentals

### Head-Based vs Tail-Based Sampling

**Head-based sampling**: The sampling decision is made at the start of a trace (when the first span is created). All downstream services receive the sampling decision in the trace context and follow it. Simple to implement, low overhead, but cannot make decisions based on the full trace outcome.

**Tail-based sampling**: The sampling decision is made after the complete trace is assembled, allowing decisions based on overall trace characteristics (error presence, total latency, specific service involvement). Requires a collector component to buffer and evaluate complete traces. Higher infrastructure complexity but much better trace quality.

```
Head-based sampling:
Request → [decide: sample/drop] → propagate decision downstream
         ↑
         Made immediately, based only on trace headers and random chance

Tail-based sampling:
Request → collect all spans → assemble trace → [decide: keep/drop]
                                                ↑
                                                Made after trace complete,
                                                based on full trace data
```

### Sampling Decision Propagation

In distributed tracing, the sampling decision propagates through the `traceparent` header (W3C Trace Context standard):

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             |  |                                |                | |
             v  trace-id (128-bit)              span-id          | sampled flag
          version                                                 (01=sampled, 00=not sampled)
```

When a downstream service receives a sampled trace (`-01`), it MUST create child spans and export them. When it receives a non-sampled trace (`-00`), it SHOULD NOT export spans (though it may continue propagating the trace context).

## OpenTelemetry Sampling in Go

### Setting Up the Tracer with Sampling

```go
package tracing

import (
    "context"
    "fmt"
    "os"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func NewTracerProvider(ctx context.Context, serviceName, serviceVersion string) (*sdktrace.TracerProvider, error) {
    // OTLP exporter to Jaeger/Tempo/OpenTelemetry Collector
    conn, err := grpc.DialContext(ctx,
        os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"), // e.g., "otel-collector.monitoring.svc.cluster.local:4317"
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to connect to OTLP endpoint: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("failed to create OTLP exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion(serviceVersion),
            semconv.DeploymentEnvironment(os.Getenv("ENVIRONMENT")),
        ),
        resource.WithFromEnv(),
        resource.WithHost(),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create resource: %w", err)
    }

    // Choose sampler based on environment
    sampler := chooseSampler()

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithBatchTimeout(5*time.Second),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    otel.SetTracerProvider(tp)
    return tp, nil
}

func chooseSampler() sdktrace.Sampler {
    env := os.Getenv("ENVIRONMENT")
    switch env {
    case "development":
        // Sample everything in development
        return sdktrace.AlwaysSample()
    case "staging":
        // Sample 10% in staging
        return sdktrace.TraceIDRatioBased(0.10)
    case "production":
        // Use custom composite sampler
        return NewProductionSampler(0.01) // 1% base rate
    default:
        return sdktrace.AlwaysSample()
    }
}
```

### TraceID Ratio Sampler (Head-Based)

The built-in ratio sampler uses the trace ID to make deterministic decisions:

```go
// 1% sampling
sampler := sdktrace.TraceIDRatioBased(0.01)

// Always sample + ratio for remote parents
// This ensures we follow parent's decision but also apply local ratio
parentBased := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.01), // Root span sampler
    sdktrace.WithRemoteSampledParent(sdktrace.AlwaysSample()),   // If parent sampled, we sample
    sdktrace.WithRemoteNotSampledParent(sdktrace.NeverSample()),  // If parent not sampled, we don't
    sdktrace.WithLocalSampledParent(sdktrace.AlwaysSample()),
    sdktrace.WithLocalNotSampledParent(sdktrace.NeverSample()),
)
```

### Custom Composite Sampler (Head-Based)

The built-in sampler treats all traces equally. A composite sampler can apply different rates by error status, endpoint, or latency:

```go
package tracing

import (
    "strings"

    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/trace"
)

// ProductionSampler implements composite sampling:
// - Always sample traces containing errors
// - Always sample traces to /health and /metrics (for debugging)
// - Rate-limit sample traces for specific high-volume endpoints
// - Apply base sampling rate to all other traces
type ProductionSampler struct {
    baseRate           float64
    highVolumeRate     float64
    alwaysSamplePaths  map[string]bool
    highVolumePaths    map[string]bool
    ratioSampler       sdktrace.Sampler
    highVolumeRatioSampler sdktrace.Sampler
}

func NewProductionSampler(baseRate float64) *ProductionSampler {
    return &ProductionSampler{
        baseRate:       baseRate,
        highVolumeRate: baseRate / 10, // Even lower rate for noisy endpoints
        alwaysSamplePaths: map[string]bool{
            // Always sample these for debugging
            "/api/checkout":      true,
            "/api/payment":       true,
        },
        highVolumePaths: map[string]bool{
            // These generate massive trace volume — use even lower rate
            "/api/search":   true,
            "/api/list":     true,
            "/healthz":      false, // Skip entirely
            "/metrics":      false,
        },
        ratioSampler:           sdktrace.TraceIDRatioBased(baseRate),
        highVolumeRatioSampler: sdktrace.TraceIDRatioBased(baseRate / 10),
    }
}

func (s *ProductionSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Extract HTTP route from attributes
    var httpRoute, httpStatusCode string
    for _, attr := range p.Attributes {
        switch attr.Key {
        case "http.route", "http.target":
            httpRoute = attr.Value.AsString()
        case "http.status_code":
            httpStatusCode = attr.Value.AsString()
        }
    }

    // Never sample health checks
    if strings.HasPrefix(httpRoute, "/healthz") || strings.HasPrefix(httpRoute, "/readyz") {
        return sdktrace.SamplingResult{Decision: sdktrace.Drop}
    }

    // If parent is sampled, follow parent decision
    if p.ParentContext.IsValid() {
        if trace.SpanFromContext(p.ParentContext).SpanContext().IsSampled() {
            return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
        }
        return sdktrace.SamplingResult{Decision: sdktrace.Drop}
    }

    // Always sample error traces
    if strings.HasPrefix(httpStatusCode, "5") || httpStatusCode == "429" {
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }

    // Always sample critical business paths
    if s.alwaysSamplePaths[httpRoute] {
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }

    // Apply reduced sampling rate for high-volume paths
    if _, isHighVolume := s.highVolumePaths[httpRoute]; isHighVolume {
        return s.highVolumeRatioSampler.ShouldSample(p)
    }

    // Base rate for everything else
    return s.ratioSampler.ShouldSample(p)
}

func (s *ProductionSampler) Description() string {
    return fmt.Sprintf("ProductionSampler{baseRate=%g}", s.baseRate)
}
```

### Rate-Limiting Sampler

For very high-traffic services, a fixed-rate sampler prevents trace volume from scaling with traffic:

```go
package tracing

import (
    "sync"
    "time"

    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// RateLimitingSampler limits the number of traces sampled per second
// regardless of incoming traffic rate
type RateLimitingSampler struct {
    mu           sync.Mutex
    maxPerSecond int
    count        int
    resetAt      time.Time
}

func NewRateLimitingSampler(maxPerSecond int) *RateLimitingSampler {
    return &RateLimitingSampler{
        maxPerSecond: maxPerSecond,
        resetAt:      time.Now().Add(time.Second),
    }
}

func (s *RateLimitingSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // If parent is sampled, follow parent
    if p.ParentContext.IsValid() {
        // (same parent-following logic as above)
    }

    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now()
    if now.After(s.resetAt) {
        s.count = 0
        s.resetAt = now.Add(time.Second)
    }

    if s.count < s.maxPerSecond {
        s.count++
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }

    return sdktrace.SamplingResult{Decision: sdktrace.Drop}
}

func (s *RateLimitingSampler) Description() string {
    return fmt.Sprintf("RateLimitingSampler{maxPerSecond=%d}", s.maxPerSecond)
}
```

## Tail-Based Sampling with OpenTelemetry Collector

### Why Tail-Based Sampling Is Superior

Head-based sampling cannot distinguish between "succeeded fast" and "succeeded but the user had to retry 3 times." Tail-based sampling can see the complete picture:

- Keep all traces with any span in error state
- Keep all traces where total latency exceeds P99 threshold
- Keep all traces containing specific service interactions
- Drop traces that are clean, fast, and uninteresting

### OpenTelemetry Collector Configuration for Tail-Based Sampling

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
  # Tail sampling processor - buffers traces and applies policies
  tail_sampling:
    # Wait for all spans in a trace before deciding
    decision_wait: 10s
    # Number of trace decisions to hold in memory
    num_traces: 100000
    # How often to evaluate the decision cache
    expected_new_traces_per_sec: 1000

    policies:
      # Policy 1: Always keep traces with errors
      - name: error-traces
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Policy 2: Keep traces with high latency (>2 seconds total)
      - name: slow-traces
        type: latency
        latency:
          threshold_ms: 2000

      # Policy 3: Always keep traces for payment service
      - name: payment-service-traces
        type: string_attribute
        string_attribute:
          key: service.name
          values: ["payment-api", "billing-service"]

      # Policy 4: Sample 1% of all other traces
      - name: baseline-sampling
        type: probabilistic
        probabilistic:
          sampling_percentage: 1

      # Policy 5: Rate-limit total trace volume (prevents storage explosion)
      - name: rate-limiting
        type: rate_limiting
        rate_limiting:
          spans_per_second: 5000

  # Batch before sending to backend
  batch:
    timeout: 10s
    send_batch_size: 1000

  # Add deployment environment attribute
  resource:
    attributes:
    - key: deployment.environment
      value: production
      action: upsert

exporters:
  # Send to Grafana Tempo
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true

  # Send to Jaeger for analysis
  jaeger:
    endpoint: jaeger-collector.monitoring.svc.cluster.local:14250
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, resource, batch]
      exporters: [otlp/tempo]
```

### Kubernetes Deployment for OTel Collector

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  replicas: 3  # Multiple replicas for HA, but tail-sampling requires sticky routing
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      containers:
      - name: collector
        image: otel/opentelemetry-collector-contrib:0.95.0
        args: ["--config=/conf/otel-collector-config.yaml"]
        ports:
        - name: otlp-grpc
          containerPort: 4317
        - name: otlp-http
          containerPort: 4318
        - name: metrics
          containerPort: 8888
        volumeMounts:
        - name: config
          mountPath: /conf
        resources:
          requests:
            cpu: "500m"
            memory: "1Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
      volumes:
      - name: config
        configMap:
          name: otel-collector-config
---
# IMPORTANT: Tail-based sampling requires traces from the same trace ID
# to be routed to the same collector instance.
# Use a LoadBalancer extension in the collector, or sticky hashing in the service.
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  # Session affinity by ClientIP for sticky routing
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 600
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

### Consistent Hashing for Multi-Collector Tail Sampling

When running multiple collector replicas, all spans for a given trace must reach the same collector. Use the `loadbalancing` exporter to route by trace ID:

```yaml
# Frontend collector: routes by trace ID to backend collectors
exporters:
  loadbalancing:
    protocol:
      otlp:
        timeout: 1s
    resolver:
      k8s:
        service: otel-collector-backend.monitoring
        ports:
        - 4317
    # Consistent hashing on trace ID
    routing_key: traceID

service:
  pipelines:
    traces/frontend:
      receivers: [otlp]
      processors: [batch]
      exporters: [loadbalancing]
```

## Jaeger Sampling Configuration

### Remote Sampling Strategy

Jaeger supports a sampling strategy server that can be updated without redeploying services:

```yaml
# jaeger-sampling-strategies.json
{
  "default_strategy": {
    "type": "probabilistic",
    "param": 0.001
  },
  "service_strategies": [
    {
      "service": "payment-api",
      "type": "probabilistic",
      "param": 0.1,
      "operation_strategies": [
        {
          "operation": "POST /api/payment",
          "type": "probabilistic",
          "param": 1.0
        },
        {
          "operation": "GET /api/payment/{id}",
          "type": "probabilistic",
          "param": 0.05
        }
      ]
    },
    {
      "service": "search-api",
      "type": "ratelimiting",
      "param": 100
    },
    {
      "service": "background-worker",
      "type": "probabilistic",
      "param": 0.001
    }
  ]
}
```

```go
package tracing

import (
    "time"

    "go.opentelemetry.io/otel"
    jaegerexporter "go.opentelemetry.io/otel/exporters/jaeger"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// UseJaegerRemoteSampling configures the SDK to fetch sampling strategy from Jaeger
func UseJaegerRemoteSampling(serviceName string) sdktrace.Sampler {
    // The remote sampling strategy server URL
    samplerEndpoint := "http://jaeger-agent.monitoring.svc.cluster.local:5778/sampling"

    // Use ParentBased so we follow decisions from upstream services
    // and only apply our rate for root spans
    return sdktrace.ParentBased(
        // This would typically be replaced with a Jaeger remote sampler
        // when using the jaeger-client-go SDK or equivalent
        sdktrace.TraceIDRatioBased(0.01), // Fallback
    )
}
```

### Grafana Tempo Sampling Configuration

```yaml
# tempo-config.yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

# Tempo does not do sampling itself — it stores what it receives
# Configure sampling in the OTel Collector before traces reach Tempo

storage:
  trace:
    backend: s3
    s3:
      bucket: tempo-traces
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1

# Block retention - how long traces are kept
compactor:
  compaction:
    block_retention: 336h  # 14 days
```

## Adaptive Sampling

### Implementing Feedback-Based Rate Adaptation

```go
package tracing

import (
    "math"
    "sync"
    "sync/atomic"
    "time"

    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.uber.org/zap"
)

// AdaptiveSampler dynamically adjusts sampling rate based on trace volume
// to maintain a target throughput to the backend
type AdaptiveSampler struct {
    mu               sync.RWMutex
    logger           *zap.Logger

    // Target: samples per second
    targetSamplesPS  float64
    // Current observed traces per second
    incomingPS       float64
    // Current sampling rate (0.0 - 1.0)
    currentRate      float64

    // Counters
    sampledCount    atomic.Int64
    incomingCount   atomic.Int64
    lastAdjustAt    time.Time

    // Minimum and maximum rates
    minRate float64
    maxRate float64
}

func NewAdaptiveSampler(targetSamplesPS, minRate, maxRate float64, logger *zap.Logger) *AdaptiveSampler {
    s := &AdaptiveSampler{
        logger:          logger,
        targetSamplesPS: targetSamplesPS,
        currentRate:     maxRate, // Start at max rate
        minRate:         minRate,
        maxRate:         maxRate,
        lastAdjustAt:    time.Now(),
    }

    // Periodically adjust sampling rate
    go s.adjustRatePeriodically()

    return s
}

func (s *AdaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    s.incomingCount.Add(1)

    s.mu.RLock()
    rate := s.currentRate
    s.mu.RUnlock()

    // TraceID-based deterministic sampling using the current rate
    // Convert trace ID first 8 bytes to uint64 for ratio comparison
    traceID := p.TraceID
    upper := uint64(traceID[0])<<56 | uint64(traceID[1])<<48 |
        uint64(traceID[2])<<40 | uint64(traceID[3])<<32 |
        uint64(traceID[4])<<24 | uint64(traceID[5])<<16 |
        uint64(traceID[6])<<8 | uint64(traceID[7])

    threshold := uint64(rate * float64(math.MaxUint64))
    if upper <= threshold {
        s.sampledCount.Add(1)
        return sdktrace.SamplingResult{
            Decision:   sdktrace.RecordAndSample,
            Attributes: []attribute.KeyValue{
                attribute.Float64("sampling.rate", rate),
            },
        }
    }

    return sdktrace.SamplingResult{Decision: sdktrace.Drop}
}

func (s *AdaptiveSampler) adjustRatePeriodically() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        s.adjustRate()
    }
}

func (s *AdaptiveSampler) adjustRate() {
    now := time.Now()
    elapsed := now.Sub(s.lastAdjustAt).Seconds()

    incoming := float64(s.incomingCount.Swap(0)) / elapsed
    sampled := float64(s.sampledCount.Swap(0)) / elapsed
    s.lastAdjustAt = now

    s.mu.Lock()
    defer s.mu.Unlock()

    if incoming == 0 {
        return
    }

    // Calculate required rate to hit target
    // currentRate * incoming = sampledRate
    // desiredRate = targetSamplesPS / incoming
    desiredRate := s.targetSamplesPS / incoming

    // Clamp to [minRate, maxRate]
    desiredRate = math.Max(s.minRate, math.Min(s.maxRate, desiredRate))

    // Smooth adjustment (exponential moving average)
    alpha := 0.3 // Smoothing factor
    s.currentRate = alpha*desiredRate + (1-alpha)*s.currentRate

    s.logger.Info("adaptive sampler adjustment",
        zap.Float64("incoming_traces_ps", incoming),
        zap.Float64("sampled_traces_ps", sampled),
        zap.Float64("new_rate", s.currentRate),
        zap.Float64("target_ps", s.targetSamplesPS),
    )
}

func (s *AdaptiveSampler) Description() string {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return fmt.Sprintf("AdaptiveSampler{rate=%g,target=%gps}", s.currentRate, s.targetSamplesPS)
}
```

## Preventing Trace Data Explosion

### Storage Volume Calculations

```
Variables:
- RPS: requests per second
- APM: average spans per trace
- ABS: average bytes per span (with attributes: ~1KB, minimal: 300 bytes)
- SR: sampling rate
- Retention: days

Daily storage = RPS * APM * ABS * SR * 86400

Example calculation:
- 10,000 RPS
- 15 spans per trace average
- 800 bytes per span
- 1% sampling rate
- 14 day retention

Daily raw = 10,000 * 15 * 800 * 0.01 = 1,200,000 bytes/sec = ~103 GB/day
14-day total = 103 * 14 = 1.44 TB (before compression)

With Tempo's ~60% compression: ~580 GB for 14 days
```

### Span Attribute Filtering

Large attribute values are a major cause of storage bloat:

```go
package tracing

import (
    "go.opentelemetry.io/otel/attribute"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// AttributeFilteringSpanProcessor truncates large attribute values
// before they are exported
type AttributeFilteringSpanProcessor struct {
    maxAttributeLength int
    blockedKeys        map[string]bool
}

func NewAttributeFilteringSpanProcessor(maxLen int, blockedKeys []string) *AttributeFilteringSpanProcessor {
    blocked := make(map[string]bool, len(blockedKeys))
    for _, k := range blockedKeys {
        blocked[k] = true
    }
    return &AttributeFilteringSpanProcessor{
        maxAttributeLength: maxLen,
        blockedKeys:        blocked,
    }
}

func (p *AttributeFilteringSpanProcessor) OnStart(parent context.Context, span sdktrace.ReadWriteSpan) {}

func (p *AttributeFilteringSpanProcessor) OnEnd(span sdktrace.ReadOnlySpan) {}

func (p *AttributeFilteringSpanProcessor) Shutdown(ctx context.Context) error { return nil }

func (p *AttributeFilteringSpanProcessor) ForceFlush(ctx context.Context) error { return nil }

// Use this when adding attributes to avoid storing large values
func (p *AttributeFilteringSpanProcessor) FilteredAttribute(key, value string) attribute.KeyValue {
    if p.blockedKeys[key] {
        return attribute.String(key, "[REDACTED]")
    }
    if len(value) > p.maxAttributeLength {
        return attribute.String(key, value[:p.maxAttributeLength]+"...[truncated]")
    }
    return attribute.String(key, value)
}
```

### OTel Collector Attribute Filtering

```yaml
# OTel Collector processor to filter sensitive/large attributes
processors:
  attributes:
    actions:
    # Remove potentially sensitive attributes
    - key: db.statement
      action: update
      value: "[FILTERED]"
    - key: http.request.body
      action: delete
    - key: http.response.body
      action: delete
    # Truncate long URL parameters
    - key: http.target
      action: update
      # Note: complex transformations require transform processor

  transform:
    trace_statements:
    - context: span
      statements:
      # Truncate query strings in URLs
      - replace_pattern(attributes["http.url"], "\\?.*$", "?[query-truncated]")
      # Remove sensitive headers
      - delete_key(attributes, "http.request.header.authorization")
      - delete_key(attributes, "http.request.header.cookie")
```

## Trace Sampling Observability

### Monitoring Sampling Effectiveness

```yaml
# Prometheus alerts for sampling health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tracing-sampling-alerts
  namespace: monitoring
spec:
  groups:
  - name: tracing.sampling
    rules:
    - alert: TraceBackendIngestHigh
      expr: |
        rate(tempo_distributor_spans_received_total[5m]) > 50000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Tempo receiving high span volume"
        description: "Span ingestion rate is {{ $value }}/s. Consider reducing sampling rate."

    - alert: TraceSamplingDropRateHigh
      expr: |
        rate(otelcol_processor_tail_sampling_count_traces_sampled_total[5m]) /
        rate(otelcol_processor_tail_sampling_count_traces_sampled_total[5m] +
             otelcol_processor_tail_sampling_count_traces_not_sampled_total[5m]) < 0.005
      for: 10m
      labels:
        severity: info
      annotations:
        summary: "Tail sampling keeping less than 0.5% of traces"
        description: "May miss rare error patterns. Consider increasing error-trace policy."

    - record: tracing:sampling_rate:ratio
      expr: |
        rate(otelcol_processor_tail_sampling_count_traces_sampled_total[5m]) /
        (rate(otelcol_processor_tail_sampling_count_traces_sampled_total[5m]) +
         rate(otelcol_processor_tail_sampling_count_traces_not_sampled_total[5m]))
```

### Verifying Error Traces Are Always Captured

```go
// Integration test: verify that error traces are always sampled
func TestErrorTracesAlwaysSampled(t *testing.T) {
    // Create a test tracer with production sampler
    sampler := NewProductionSampler(0.0001) // 0.01% base rate

    // Test 1000 simulated error traces
    sampledCount := 0
    for i := 0; i < 1000; i++ {
        // Simulate an error span
        params := sdktrace.SamplingParameters{
            Attributes: []attribute.KeyValue{
                attribute.String("http.status_code", "500"),
                attribute.String("http.route", "/api/search"),
            },
        }
        result := sampler.ShouldSample(params)
        if result.Decision == sdktrace.RecordAndSample {
            sampledCount++
        }
    }

    // All error traces should be sampled
    if sampledCount != 1000 {
        t.Errorf("Expected 1000 sampled error traces, got %d", sampledCount)
    }
}
```

## Summary

Effective distributed tracing sampling for Go services requires:

1. **Use `ParentBased` for all root samplers**: Ensures downstream services follow upstream sampling decisions, keeping traces coherent.

2. **Always sample errors**: Never allow a 500-status trace to be dropped by a rate sampler. Implement error detection in head-based samplers or use tail-sampling policies.

3. **Rate-limit by target volume, not by percentage**: Percentage-based sampling produces unbounded volume at scale. Use `RateLimitingSampler` or adaptive sampling to cap trace storage costs.

4. **Tail-based sampling for quality**: Deploy the OTel Collector with tail-sampling processor for production environments where trace quality matters more than simplicity.

5. **Monitor sampling rates**: Alert when error-trace sampling drops below 100% or when overall volume exceeds storage budgets.

6. **Filter attributes at the collector**: Remove SQL query content, authorization headers, and large request/response bodies before storage to reduce volume and meet compliance requirements.

The right sampling strategy depends on traffic volume, storage budget, and observability requirements. For services below 1,000 RPS, simple 5-10% head-based sampling is sufficient. Above that threshold, tail-based sampling with error-aware policies provides dramatically better trace quality at the same storage cost.
