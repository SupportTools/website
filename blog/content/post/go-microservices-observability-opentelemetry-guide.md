---
title: "Go Microservices Observability: OpenTelemetry Traces, Metrics, and Logs Correlation"
date: 2029-11-26T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Observability", "Tracing", "Metrics", "Logging", "Tempo", "Loki", "Prometheus"]
categories:
- Go
- Observability
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete OpenTelemetry instrumentation guide for Go microservices covering traces, metrics, logs, correlation IDs, sampling strategies, and Tempo/Loki/Prometheus integration."
more_link: "yes"
url: "/go-microservices-observability-opentelemetry-guide/"
---

Observability in distributed systems is not logging, metrics, or tracing in isolation — it is the ability to correlate all three signals against a single request ID and reconstruct exactly what happened across service boundaries. OpenTelemetry provides the SDK, wire protocol, and collector infrastructure to achieve that correlation in Go services without vendor lock-in.

<!--more-->

## Section 1: The Three Pillars and Why Correlation Matters

A production incident that takes 45 minutes to diagnose often has two root causes: the technical fault itself, and the inability to connect the alert (a metric spike) to the specific requests that caused it (traces) to the error messages explaining why (logs). OpenTelemetry's model addresses this by injecting a `trace_id` into every span, metric exemplar, and log record generated from the same request context.

The result: you see a Prometheus alert for P99 latency, click the exemplar on the graph, jump directly to the Tempo trace for that specific slow request, see the span where latency accumulated, click the log link embedded in that span, and land on the exact log lines with full context.

### OpenTelemetry Signal Architecture

```
HTTP Request
    │
    ▼
┌─────────────────────────────────────────┐
│  Go Service                              │
│                                          │
│  Context → TraceID + SpanID + Baggage   │
│       │                                  │
│       ├── Span (Tempo/Jaeger)            │
│       ├── Metric Exemplar (Prometheus)   │
│       └── Log Record with trace_id       │
│                (Loki)                    │
└─────────────┬───────────────────────────┘
              │  OTLP gRPC/HTTP
              ▼
        OTel Collector
          ├── Tempo (traces)
          ├── Prometheus (metrics)
          └── Loki (logs)
```

## Section 2: Setting Up the OTel SDK in Go

### Dependencies

```bash
go get go.opentelemetry.io/otel@v1.28.0
go get go.opentelemetry.io/otel/sdk@v1.28.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.28.0
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@v1.28.0
go get go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc@v1.28.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.53.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.53.0
```

### Bootstrap Package

Create a reusable `otelsetup` package that initializes all three signal providers:

```go
// internal/otelsetup/otelsetup.go
package otelsetup

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/log/global"
    "go.opentelemetry.io/otel/propagation"
    sdklog "go.opentelemetry.io/otel/sdk/log"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "go.opentelemetry.io/otel/sdk/resource"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string // e.g., "otel-collector:4317"
    SampleRate     float64
}

type Shutdown func(context.Context) error

func Bootstrap(ctx context.Context, cfg Config) (Shutdown, error) {
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // Trace provider
    traceExp, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(cfg.OTLPEndpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating trace exporter: %w", err)
    }

    sampler := sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(cfg.SampleRate),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(traceExp,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithSampler(sampler),
        sdktrace.WithResource(res),
    )
    otel.SetTracerProvider(tp)

    // Propagator: W3C TraceContext + Baggage
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    // Metric provider
    metricExp, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithEndpoint(cfg.OTLPEndpoint),
        otlpmetricgrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating metric exporter: %w", err)
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(metricExp,
                sdkmetric.WithInterval(15*time.Second),
            ),
        ),
        sdkmetric.WithResource(res),
    )
    otel.SetMeterProvider(mp)

    // Log provider
    logExp, err := otlploggrpc.New(ctx,
        otlploggrpc.WithEndpoint(cfg.OTLPEndpoint),
        otlploggrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating log exporter: %w", err)
    }

    lp := sdklog.NewLoggerProvider(
        sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
        sdklog.WithResource(res),
    )
    global.SetLoggerProvider(lp)

    shutdown := func(ctx context.Context) error {
        if err := tp.Shutdown(ctx); err != nil {
            return err
        }
        if err := mp.Shutdown(ctx); err != nil {
            return err
        }
        return lp.Shutdown(ctx)
    }

    return shutdown, nil
}
```

### Main Function Wiring

```go
// main.go
func main() {
    ctx := context.Background()

    shutdown, err := otelsetup.Bootstrap(ctx, otelsetup.Config{
        ServiceName:    "payment-service",
        ServiceVersion: "2.4.1",
        Environment:    os.Getenv("ENVIRONMENT"),
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:     0.1, // 10% sampling for high-volume services
    })
    if err != nil {
        log.Fatalf("otel bootstrap: %v", err)
    }
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := shutdown(shutdownCtx); err != nil {
            log.Printf("otel shutdown error: %v", err)
        }
    }()

    // ... rest of server setup
}
```

## Section 3: HTTP Handler Instrumentation

### Automatic HTTP Instrumentation

```go
// internal/server/server.go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

func NewServer(addr string) *http.Server {
    mux := http.NewServeMux()
    mux.Handle("/api/v1/payments", handlePayment())
    mux.Handle("/api/v1/users/{id}", handleGetUser())

    // otelhttp wraps the entire mux, creating a root span per request
    handler := otelhttp.NewHandler(mux, "http-server",
        otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
        otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
            return fmt.Sprintf("%s %s", r.Method, r.Pattern)
        }),
    )

    return &http.Server{
        Addr:         addr,
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
    }
}
```

### Adding Custom Spans and Attributes

```go
func processPayment(ctx context.Context, req PaymentRequest) (*PaymentResult, error) {
    tracer := otel.Tracer("payment-service")

    ctx, span := tracer.Start(ctx, "processPayment",
        trace.WithAttributes(
            attribute.String("payment.currency", req.Currency),
            attribute.Int64("payment.amount_cents", req.AmountCents),
            attribute.String("payment.method", req.Method),
        ),
    )
    defer span.End()

    // Validate
    ctx, validateSpan := tracer.Start(ctx, "validatePayment")
    if err := validate(req); err != nil {
        validateSpan.RecordError(err)
        validateSpan.SetStatus(codes.Error, err.Error())
        validateSpan.End()
        return nil, err
    }
    validateSpan.End()

    // Charge
    ctx, chargeSpan := tracer.Start(ctx, "chargePaymentProvider",
        trace.WithAttributes(
            attribute.String("payment.provider", req.ProviderName),
        ),
    )
    result, err := chargeProvider(ctx, req)
    if err != nil {
        chargeSpan.RecordError(err)
        chargeSpan.SetStatus(codes.Error, "provider charge failed")
        chargeSpan.End()
        return nil, err
    }
    chargeSpan.SetAttributes(attribute.String("payment.transaction_id", result.TransactionID))
    chargeSpan.End()

    span.SetAttributes(attribute.String("payment.result", "success"))
    return result, nil
}
```

## Section 4: Metrics with Exemplars

Exemplars link a metric data point to the trace that produced it. When Prometheus scrapes your service, the exemplar carries the `trace_id` and `span_id` that caused the specific measurement.

```go
// internal/metrics/metrics.go
package metrics

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

type ServiceMetrics struct {
    requestDuration metric.Float64Histogram
    activeRequests  metric.Int64UpDownCounter
    errorCounter    metric.Int64Counter
}

func NewServiceMetrics(name string) (*ServiceMetrics, error) {
    meter := otel.Meter(name)

    requestDuration, err := meter.Float64Histogram(
        "http_request_duration_seconds",
        metric.WithDescription("HTTP request duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
        ),
    )
    if err != nil {
        return nil, err
    }

    activeRequests, err := meter.Int64UpDownCounter(
        "http_active_requests",
        metric.WithDescription("Number of active HTTP requests"),
    )
    if err != nil {
        return nil, err
    }

    errorCounter, err := meter.Int64Counter(
        "http_errors_total",
        metric.WithDescription("Total number of HTTP errors"),
    )
    if err != nil {
        return nil, err
    }

    return &ServiceMetrics{
        requestDuration: requestDuration,
        activeRequests:  activeRequests,
        errorCounter:    errorCounter,
    }, nil
}

func (m *ServiceMetrics) RecordRequest(ctx context.Context, duration float64, attrs ...metric.RecordOption) {
    // The OTel SDK automatically attaches the current span's trace_id
    // as an exemplar when recording histogram observations
    m.requestDuration.Record(ctx, duration, attrs...)
}
```

### Prometheus Scrape Configuration for Exemplars

```yaml
# prometheus.yml
scrape_configs:
  - job_name: payment-service
    scrape_interval: 15s
    static_configs:
      - targets: ["payment-service:9090"]
    # Enable exemplar storage
    exemplar_tracelabel_name: trace_id
```

```yaml
# Prometheus storage config
storage:
  tsdb:
    exemplars:
      max_exemplars: 100000
```

## Section 5: Structured Log Correlation

The OTel log SDK injects `trace_id`, `span_id`, and `trace_flags` into every log record emitted while a span is active.

### slog Bridge (Go 1.21+)

```go
// internal/logger/logger.go
package logger

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/contrib/bridges/otelslog"
    "go.opentelemetry.io/otel/trace"
)

func New(serviceName string) *slog.Logger {
    // OTel handler: sends log records to the OTLP log exporter
    otelHandler := otelslog.NewHandler(serviceName)

    // JSON handler: writes to stdout for local development
    jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelDebug,
    })

    // Tee to both handlers
    return slog.New(NewTeeHandler(otelHandler, jsonHandler))
}

// WithTraceContext adds trace_id and span_id to log attributes from context
func WithTraceContext(ctx context.Context, logger *slog.Logger) *slog.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.IsRecording() {
        return logger
    }
    sc := span.SpanContext()
    return logger.With(
        slog.String("trace_id", sc.TraceID().String()),
        slog.String("span_id", sc.SpanID().String()),
        slog.Bool("trace_sampled", sc.IsSampled()),
    )
}
```

Usage:

```go
func handlePayment(w http.ResponseWriter, r *http.Request) {
    log := logger.WithTraceContext(r.Context(), svcLogger)
    log.InfoContext(r.Context(), "processing payment request",
        slog.String("request_id", r.Header.Get("X-Request-ID")),
        slog.String("customer_id", req.CustomerID),
    )
}
```

The resulting log line in Loki contains `trace_id` and `span_id`, enabling direct links from log lines to Tempo traces in Grafana.

## Section 6: Sampling Strategies

Sampling is the most consequential observability configuration decision. Too aggressive, and you miss the slow tail-latency requests. Too permissive, and you overwhelm your Tempo storage.

### Composite Sampler

```go
// internal/otelsetup/sampler.go
package otelsetup

import (
    "go.opentelemetry.io/otel/sdk/trace"
)

// AlwaysSampleErrors samples all error traces at 100%
// and applies a ratio to successful traces
type AlwaysSampleErrors struct {
    base trace.Sampler
}

func (s AlwaysSampleErrors) ShouldSample(p trace.SamplingParameters) trace.SamplingResult {
    // Always sample if the span will record an error
    // This requires a tail sampler or a parent-based approach
    return s.base.ShouldSample(p)
}

func (s AlwaysSampleErrors) Description() string {
    return "AlwaysSampleErrors"
}

// NewProductionSampler creates a sampler appropriate for high-throughput services:
// - 100% of error spans (via head-based proxy using parent)
// - 100% of slow spans (requires tail sampler in collector)
// - baseRate% of everything else
func NewProductionSampler(baseRate float64) trace.Sampler {
    return trace.ParentBased(
        trace.TraceIDRatioBased(baseRate),
        // If parent was sampled, always sample child spans
        trace.WithRemoteSampledParentSampler(trace.AlwaysSample()),
        trace.WithRemoteNotSampledParentSampler(trace.NeverSample()),
        trace.WithLocalParentSampledSampler(trace.AlwaysSample()),
        trace.WithLocalParentNotSampledSampler(trace.NeverSample()),
    )
}
```

### OTel Collector Tail Sampling

The collector can apply tail sampling after seeing all spans of a trace:

```yaml
# otel-collector-config.yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    expected_new_traces_per_sec: 1000
    policies:
      - name: sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: sample-slow-traces
        type: latency
        latency:
          threshold_ms: 1000
      - name: sample-all-health-checks
        type: string_attribute
        string_attribute:
          key: http.target
          values: ["/healthz", "/readyz"]
          invert_match: true
      - name: probabilistic-base
        type: probabilistic
        probabilistic:
          sampling_percentage: 5
```

## Section 7: Grafana Integration (Tempo + Loki + Prometheus)

### Grafana Data Source Configuration

```yaml
# grafana/datasources/otel.yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: "-1m"
        spanEndTimeShift: "1m"
        filterByTraceID: true
        filterBySpanID: true
      tracesToMetrics:
        datasourceUid: prometheus
        queries:
          - name: "Request Rate"
            query: >
              sum(rate(http_request_duration_seconds_count{
                service_name="$${__span.tags.service.name}"}[5m]))

  - name: Loki
    type: loki
    url: http://loki:3100
    jsonData:
      derivedFields:
        - name: TraceID
          matcherRegex: '"trace_id":"(\w+)"'
          url: "$${__value.raw}"
          datasourceUid: tempo

  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    jsonData:
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo
```

This configuration enables the full correlation loop: a metric exemplar in Prometheus links to a Tempo trace, the trace links to Loki log lines, and Loki log lines link back to Tempo traces.

## Section 8: Context Propagation Across Service Boundaries

### Outbound HTTP Client

```go
// internal/httpclient/client.go
package httpclient

import (
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func New() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport,
            otelhttp.WithSpanOptions(
                trace.WithAttributes(
                    attribute.String("http.client.name", "payment-service"),
                ),
            ),
        ),
        Timeout: 30 * time.Second,
    }
}
```

### gRPC Client with OTel

```go
import "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

conn, err := grpc.NewClient(target,
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithStatsHandler(otelgrpc.NewClientHandler(
        otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
    )),
)
```

### Baggage for Cross-Service Metadata

```go
import "go.opentelemetry.io/otel/baggage"

// Inject customer tier into baggage for downstream routing decisions
func injectCustomerBaggage(ctx context.Context, customerID, tier string) context.Context {
    member, _ := baggage.NewMember("customer.tier", tier)
    customerMember, _ := baggage.NewMember("customer.id", customerID)
    bag, _ := baggage.New(member, customerMember)
    return baggage.ContextWithBaggage(ctx, bag)
}

// Read baggage in downstream service
func extractCustomerBaggage(ctx context.Context) (string, string) {
    bag := baggage.FromContext(ctx)
    tier := bag.Member("customer.tier").Value()
    id := bag.Member("customer.id").Value()
    return id, tier
}
```

A complete OpenTelemetry implementation in Go gives you the correlation chain needed to turn observability from a reactive tool into a proactive one. When every request carries a trace ID through logs, metrics, and spans, mean time to diagnosis drops from minutes to seconds.
