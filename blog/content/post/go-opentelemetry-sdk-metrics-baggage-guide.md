---
title: "Go Telemetry: OpenTelemetry SDK, Metric Instruments, Baggage Propagation, and Exemplar Linking"
date: 2028-09-08T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Metrics", "Baggage", "Tracing", "Observability"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Instrument Go services with the OpenTelemetry SDK: trace context propagation, metric instruments (counter, histogram, gauge, updowncounter), baggage for cross-service correlation, exemplar linking between metrics and traces, and OTLP export to Grafana."
more_link: "yes"
url: "/go-opentelemetry-sdk-metrics-baggage-guide/"
---

OpenTelemetry (OTel) is the CNCF standard for generating, collecting, and exporting telemetry data — traces, metrics, and logs. Unlike vendor-specific SDKs, OTel lets you instrument once and export to any backend: Jaeger, Tempo, Prometheus, Grafana Cloud, Datadog, or Honeycomb. This guide covers the Go OTel SDK in depth: provider initialization, all four metric instrument types, trace/span creation, baggage propagation across service boundaries, exemplar linking that connects a metric spike to the exact trace that caused it, and a complete HTTP middleware that instruments every request automatically.

<!--more-->

# Go Telemetry: OpenTelemetry SDK, Metric Instruments, Baggage Propagation, and Exemplar Linking

## Section 1: SDK Dependencies and Provider Initialization

```bash
go get go.opentelemetry.io/otel@latest
go get go.opentelemetry.io/otel/sdk@latest
go get go.opentelemetry.io/otel/sdk/metric@latest
go get go.opentelemetry.io/otel/sdk/trace@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@latest
go get go.opentelemetry.io/otel/exporters/prometheus@latest
go get go.opentelemetry.io/otel/propagators/b3@latest
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@latest
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@latest
```

```go
// telemetry/telemetry.go — centralized OTel initialization
package telemetry

import (
    "context"
    "fmt"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/propagation"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
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
    OTLPEndpoint   string  // e.g., "otel-collector:4317"
    SampleRate     float64 // 0.0 to 1.0; -1 for always-on
}

type Telemetry struct {
    TracerProvider *sdktrace.TracerProvider
    MeterProvider  *sdkmetric.MeterProvider
    Shutdown       func(context.Context) error
}

// Init initializes the global OTel trace and metric providers.
// Call Shutdown() before the process exits.
func Init(ctx context.Context, cfg Config) (*Telemetry, error) {
    // Build resource describing this service
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
            attribute.String("host.name", mustHostname()),
        ),
        resource.WithContainer(),
        resource.WithOS(),
        resource.WithProcess(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // OTLP gRPC connection to collector
    conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to OTLP endpoint %s: %w", cfg.OTLPEndpoint, err)
    }

    // Trace exporter
    traceExporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("creating trace exporter: %w", err)
    }

    // Sampler: configurable sampling rate
    var sampler sdktrace.Sampler
    switch {
    case cfg.SampleRate < 0:
        sampler = sdktrace.AlwaysSample()
    case cfg.SampleRate == 0:
        sampler = sdktrace.NeverSample()
    default:
        sampler = sdktrace.TraceIDRatioBased(cfg.SampleRate)
    }
    // Always sample errors regardless of SampleRate
    sampler = sdktrace.ParentBased(sampler)

    // Trace provider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(traceExporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithSampler(sampler),
        sdktrace.WithResource(res),
    )

    // Metrics — dual export: OTLP (for Tempo exemplars) + Prometheus (for Grafana)
    otlpMetricExporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("creating OTLP metric exporter: %w", err)
    }

    promExporter, err := prometheus.New()
    if err != nil {
        return nil, fmt.Errorf("creating Prometheus exporter: %w", err)
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithResource(res),
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(otlpMetricExporter,
                sdkmetric.WithInterval(15*time.Second)),
        ),
        sdkmetric.WithReader(promExporter),
        // Configure histogram bucket boundaries for latency metrics
        sdkmetric.WithView(
            sdkmetric.NewView(
                sdkmetric.Instrument{Name: "http.server.request.duration"},
                sdkmetric.Stream{
                    Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
                        Boundaries: []float64{
                            0.001, 0.005, 0.01, 0.025, 0.05, 0.1,
                            0.25, 0.5, 1, 2.5, 5, 10,
                        },
                    },
                },
            ),
        ),
    )

    // Set globals so instrumentation libraries find the providers
    otel.SetTracerProvider(tp)
    otel.SetMeterProvider(mp)

    // W3C TraceContext + Baggage propagation (industry standard)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    shutdown := func(ctx context.Context) error {
        var errs []error
        if err := tp.Shutdown(ctx); err != nil {
            errs = append(errs, err)
        }
        if err := mp.Shutdown(ctx); err != nil {
            errs = append(errs, err)
        }
        if err := conn.Close(); err != nil {
            errs = append(errs, err)
        }
        if len(errs) > 0 {
            return fmt.Errorf("shutdown errors: %v", errs)
        }
        return nil
    }

    return &Telemetry{
        TracerProvider: tp,
        MeterProvider:  mp,
        Shutdown:       shutdown,
    }, nil
}

func mustHostname() string {
    h, _ := os.Hostname()
    return h
}
```

## Section 2: All Four Metric Instrument Types

```go
// telemetry/instruments.go
package telemetry

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

const instrumentationScope = "github.com/myorg/api"

// APIMetrics holds all metric instruments for the API server.
type APIMetrics struct {
    // Counter: monotonically increasing — requests, errors, bytes
    requestsTotal metric.Int64Counter
    errorsTotal   metric.Int64Counter
    bytesReceived metric.Int64Counter

    // Histogram: distribution of values — latency, payload size
    requestDuration metric.Float64Histogram
    payloadSize     metric.Int64Histogram

    // Gauge: current value at a point in time — connections, cache size
    activeConnections metric.Int64UpDownCounter  // can go up AND down
    cacheSize         metric.Int64ObservableGauge // polled, not recorded

    // UpDownCounter: like counter but can decrease — queue depth
    queueDepth        metric.Int64UpDownCounter
    dbConnectionPool  metric.Int64UpDownCounter
}

func NewAPIMetrics(cacheStatsFn func() int64) (*APIMetrics, error) {
    meter := otel.GetMeterProvider().Meter(
        instrumentationScope,
        metric.WithInstrumentationVersion("1.0.0"),
    )

    m := &APIMetrics{}
    var err error

    // Counter: total HTTP requests
    m.requestsTotal, err = meter.Int64Counter(
        "http.server.request.count",
        metric.WithDescription("Total number of HTTP requests received"),
        metric.WithUnit("{request}"),
    )
    if err != nil { return nil, err }

    // Counter: total HTTP errors
    m.errorsTotal, err = meter.Int64Counter(
        "http.server.error.count",
        metric.WithDescription("Total number of HTTP errors (4xx and 5xx)"),
        metric.WithUnit("{error}"),
    )
    if err != nil { return nil, err }

    // Counter: bytes received
    m.bytesReceived, err = meter.Int64Counter(
        "http.server.request.body.size",
        metric.WithDescription("Total bytes received in request bodies"),
        metric.WithUnit("By"),
    )
    if err != nil { return nil, err }

    // Histogram: request duration
    m.requestDuration, err = meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("HTTP request duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
        ),
    )
    if err != nil { return nil, err }

    // Histogram: payload sizes
    m.payloadSize, err = meter.Int64Histogram(
        "http.server.response.body.size",
        metric.WithDescription("HTTP response payload sizes"),
        metric.WithUnit("By"),
        metric.WithExplicitBucketBoundaries(
            100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000,
        ),
    )
    if err != nil { return nil, err }

    // UpDownCounter: active WebSocket/long-poll connections
    m.activeConnections, err = meter.Int64UpDownCounter(
        "http.server.active_connections",
        metric.WithDescription("Number of currently active HTTP connections"),
        metric.WithUnit("{connection}"),
    )
    if err != nil { return nil, err }

    // UpDownCounter: job queue depth
    m.queueDepth, err = meter.Int64UpDownCounter(
        "worker.queue.depth",
        metric.WithDescription("Current number of items in the worker queue"),
        metric.WithUnit("{item}"),
    )
    if err != nil { return nil, err }

    // Observable gauge: polled every collection interval — no recording needed
    m.cacheSize, err = meter.Int64ObservableGauge(
        "cache.size",
        metric.WithDescription("Current number of items in the in-memory cache"),
        metric.WithUnit("{item}"),
    )
    if err != nil { return nil, err }

    // Register callback to poll cache size
    _, err = meter.RegisterCallback(
        func(_ context.Context, o metric.Observer) error {
            o.ObserveInt64(m.cacheSize, cacheStatsFn())
            return nil
        },
        m.cacheSize,
    )
    if err != nil { return nil, err }

    return m, nil
}

// RecordRequest records all metrics for a single HTTP request.
func (m *APIMetrics) RecordRequest(ctx context.Context, method, route string, status int, durationSec float64, bodyBytes, responseBytes int64) {
    attrs := []attribute.KeyValue{
        attribute.String("http.request.method", method),
        attribute.String("http.route", route),
        attribute.Int("http.response.status_code", status),
    }

    m.requestsTotal.Add(ctx, 1, metric.WithAttributes(attrs...))
    m.requestDuration.Record(ctx, durationSec, metric.WithAttributes(attrs...))
    m.bytesReceived.Add(ctx, bodyBytes, metric.WithAttributes(attrs...))
    m.payloadSize.Record(ctx, responseBytes, metric.WithAttributes(attrs...))

    if status >= 400 {
        errAttrs := append(attrs,
            attribute.String("error.type", statusToErrorType(status)))
        m.errorsTotal.Add(ctx, 1, metric.WithAttributes(errAttrs...))
    }
}

func statusToErrorType(status int) string {
    switch {
    case status >= 500:
        return "server_error"
    case status == 429:
        return "rate_limited"
    case status == 404:
        return "not_found"
    case status == 401 || status == 403:
        return "auth_error"
    default:
        return "client_error"
    }
}
```

## Section 3: Baggage Propagation

Baggage is key-value pairs that flow with the trace context across service boundaries. Use it for correlation IDs, tenant IDs, and feature flags:

```go
// telemetry/baggage.go
package telemetry

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel/baggage"
)

const (
    BaggageKeyTenantID   = "tenant.id"
    BaggageKeyUserID     = "user.id"
    BaggageKeyFeatureSet = "feature.set"
    BaggageKeyRequestID  = "request.id"
    BaggageKeyRegion     = "region"
)

// SetBaggage adds key-value pairs to the context's baggage.
// These are propagated to all downstream services via W3C Baggage header.
func SetBaggage(ctx context.Context, pairs map[string]string) (context.Context, error) {
    b := baggage.FromContext(ctx)

    for k, v := range pairs {
        member, err := baggage.NewMember(k, v)
        if err != nil {
            return ctx, err
        }
        b, err = b.SetMember(member)
        if err != nil {
            return ctx, err
        }
    }

    return baggage.ContextWithBaggage(ctx, b), nil
}

// GetBaggage retrieves a baggage value from the context.
func GetBaggage(ctx context.Context, key string) string {
    return baggage.FromContext(ctx).Member(key).Value()
}

// InjectBaggageHTTP injects baggage from an authenticated request into the context.
// Call this in your authentication middleware before the handler.
func InjectBaggageHTTP(r *http.Request, tenantID, userID, requestID string) *http.Request {
    ctx := r.Context()

    ctx, _ = SetBaggage(ctx, map[string]string{
        BaggageKeyTenantID:  tenantID,
        BaggageKeyUserID:    userID,
        BaggageKeyRequestID: requestID,
    })

    // Also add to the current span as attributes for direct querying
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(
        attribute.String("tenant.id", tenantID),
        attribute.String("user.id", userID),
        attribute.String("request.id", requestID),
    )

    return r.WithContext(ctx)
}

// BaggageToAttributes extracts all baggage members and adds them as span attributes.
// Call this at service boundaries to propagate correlation context into spans.
func BaggageToAttributes(ctx context.Context) []attribute.KeyValue {
    b := baggage.FromContext(ctx)
    var attrs []attribute.KeyValue

    for _, member := range b.Members() {
        attrs = append(attrs, attribute.String("baggage."+member.Key(), member.Value()))
    }

    return attrs
}
```

```go
// middleware/otel.go — HTTP middleware with full OTel instrumentation
package middleware

import (
    "fmt"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/trace"

    "github.com/myorg/api/telemetry"
)

type responseWriter struct {
    http.ResponseWriter
    statusCode    int
    bytesWritten  int64
    headerWritten bool
}

func (rw *responseWriter) WriteHeader(code int) {
    if !rw.headerWritten {
        rw.statusCode = code
        rw.headerWritten = true
        rw.ResponseWriter.WriteHeader(code)
    }
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    if !rw.headerWritten {
        rw.statusCode = http.StatusOK
        rw.headerWritten = true
    }
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += int64(n)
    return n, err
}

// OTelMiddleware instruments every HTTP request with a span and records metrics.
func OTelMiddleware(metrics *telemetry.APIMetrics) func(http.Handler) http.Handler {
    tracer := otel.Tracer("http-server")
    propagator := otel.GetTextMapPropagator()

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Extract trace context from incoming headers (W3C traceparent + baggage)
            ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

            // Start span — inherit parent trace ID if present
            spanName := fmt.Sprintf("%s %s", r.Method, sanitizeRoute(r))
            ctx, span := tracer.Start(ctx, spanName,
                trace.WithSpanKind(trace.SpanKindServer),
                trace.WithAttributes(
                    attribute.String("http.request.method", r.Method),
                    attribute.String("url.path", r.URL.Path),
                    attribute.String("url.scheme", schemeFromRequest(r)),
                    attribute.String("server.address", r.Host),
                    attribute.String("client.address", realIP(r)),
                    attribute.String("http.user_agent", r.UserAgent()),
                    attribute.String("http.request_id", r.Header.Get("X-Request-ID")),
                ),
            )
            defer span.End()

            // Add baggage attributes to span for searchability
            span.SetAttributes(telemetry.BaggageToAttributes(ctx)...)

            // Serve with wrapped writer
            rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
            next.ServeHTTP(rw, r.WithContext(ctx))

            duration := time.Since(start).Seconds()

            // Record span outcome
            span.SetAttributes(
                attribute.Int("http.response.status_code", rw.statusCode),
                attribute.Int64("http.response.body.size", rw.bytesWritten),
                attribute.Float64("http.server.request.duration", duration),
            )

            if rw.statusCode >= 400 {
                span.SetStatus(codes.Error,
                    fmt.Sprintf("HTTP %d", rw.statusCode))
            } else {
                span.SetStatus(codes.Ok, "")
            }

            // Record metrics
            bodyBytes := r.ContentLength
            if bodyBytes < 0 {
                bodyBytes = 0
            }
            metrics.RecordRequest(ctx,
                r.Method,
                sanitizeRoute(r),
                rw.statusCode,
                duration,
                bodyBytes,
                rw.bytesWritten)
        })
    }
}

func sanitizeRoute(r *http.Request) string {
    // Return the route pattern if using chi/mux, not the raw path
    // This prevents high cardinality from path parameters
    if pattern := r.Pattern; pattern != "" {
        return pattern
    }
    return r.URL.Path
}
```

## Section 4: Exemplar Linking — Connecting Metrics to Traces

Exemplars embed trace IDs into metric samples, allowing you to jump from a histogram spike in Grafana directly to the slow trace in Tempo:

```go
// telemetry/exemplar.go
package telemetry

import (
    "context"
    "time"

    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

// RecordWithExemplar records a histogram value and attaches the current trace/span ID
// as an exemplar. This enables Grafana's "Exemplar" feature to link slow requests
// to the exact trace in Tempo.
func RecordWithExemplar(ctx context.Context, histogram metric.Float64Histogram, value float64, attrs ...metric.MeasurementOption) {
    spanCtx := trace.SpanContextFromContext(ctx)

    if spanCtx.IsValid() {
        // Attach trace context to metric recording as exemplar
        attrs = append(attrs, metric.WithAttributeSet(
            attribute.NewSet(
                attribute.String("trace_id", spanCtx.TraceID().String()),
                attribute.String("span_id", spanCtx.SpanID().String()),
            ),
        ))
    }

    histogram.Record(ctx, value, attrs...)
}
```

**Grafana query to jump from metric to trace:**

```promql
# PromQL: find p99 request duration for the /api/v1/orders endpoint
histogram_quantile(0.99,
  rate(http_server_request_duration_seconds_bucket{
    http_route="/api/v1/orders"
  }[5m])
)

# In Grafana: enable "Exemplars" on the query panel.
# Each dot on the graph represents a real request with a trace_id.
# Click the dot to open the trace in Tempo/Jaeger.
```

## Section 5: Custom Span Events and Structured Logging

```go
// service/order_service.go
package service

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("order-service")

type OrderService struct {
    db        Database
    inventory InventoryClient
    payment   PaymentClient
}

func (s *OrderService) PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*Order, error) {
    ctx, span := tracer.Start(ctx, "PlaceOrder",
        trace.WithAttributes(
            attribute.String("order.customer_id", req.CustomerID),
            attribute.String("order.product_id", req.ProductID),
            attribute.Int("order.quantity", req.Quantity),
            attribute.Float64("order.amount", req.Amount),
        ),
    )
    defer span.End()

    // Add span event for key milestones (searchable in Jaeger/Tempo)
    span.AddEvent("inventory.check.started", trace.WithAttributes(
        attribute.String("product_id", req.ProductID),
        attribute.Int("quantity", req.Quantity),
    ))

    available, err := s.inventory.Check(ctx, req.ProductID, req.Quantity)
    if err != nil {
        span.RecordError(err, trace.WithAttributes(
            attribute.String("component", "inventory"),
        ))
        span.SetStatus(codes.Error, "inventory check failed")
        return nil, fmt.Errorf("inventory check: %w", err)
    }

    if !available {
        span.AddEvent("inventory.insufficient", trace.WithAttributes(
            attribute.String("product_id", req.ProductID),
        ))
        span.SetStatus(codes.Error, "insufficient inventory")
        return nil, ErrInsufficientInventory
    }

    span.AddEvent("payment.processing.started", trace.WithAttributes(
        attribute.Float64("amount", req.Amount),
        attribute.String("currency", "USD"),
    ))

    paymentID, err := s.payment.Charge(ctx, req.CustomerID, req.Amount)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment failed")
        return nil, fmt.Errorf("payment: %w", err)
    }

    span.SetAttributes(attribute.String("payment.id", paymentID))
    span.AddEvent("payment.completed")

    // Create order in database — child span for DB operation
    order, err := s.createOrderWithSpan(ctx, req, paymentID)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "order creation failed")
        return nil, err
    }

    span.SetAttributes(
        attribute.String("order.id", order.ID),
        attribute.String("order.status", "created"),
    )
    span.SetStatus(codes.Ok, "")

    return order, nil
}

func (s *OrderService) createOrderWithSpan(ctx context.Context, req *PlaceOrderRequest, paymentID string) (*Order, error) {
    ctx, span := tracer.Start(ctx, "CreateOrderInDB",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.operation", "INSERT"),
            attribute.String("db.sql.table", "orders"),
        ),
    )
    defer span.End()

    start := time.Now()
    order, err := s.db.CreateOrder(ctx, req, paymentID)
    span.SetAttributes(attribute.Float64("db.duration_ms", float64(time.Since(start).Milliseconds())))

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetStatus(codes.Ok, "")
    return order, nil
}
```

## Section 6: gRPC Instrumentation

```go
// grpc/server.go
package grpc

import (
    "google.golang.org/grpc"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func NewServer() *grpc.Server {
    return grpc.NewServer(
        // Unary interceptor for gRPC calls
        grpc.UnaryInterceptor(otelgrpc.UnaryServerInterceptor()),
        // Streaming interceptor
        grpc.StreamInterceptor(otelgrpc.StreamServerInterceptor()),
    )
}

func NewClientConn(target string) (*grpc.ClientConn, error) {
    return grpc.Dial(target,
        grpc.WithUnaryInterceptor(otelgrpc.UnaryClientInterceptor()),
        grpc.WithStreamInterceptor(otelgrpc.StreamClientInterceptor()),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
}
```

## Section 7: OTel Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

  prometheus:
    config:
      scrape_configs:
        - job_name: "api-server"
          scrape_interval: 15s
          static_configs:
            - targets: ["api-server:9090"]

processors:
  # Add k8s attributes to all telemetry
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    filter:
      node_from_env_var: KUBE_NODE_NAME
    extract:
      metadata:
        - k8s.pod.name
        - k8s.pod.uid
        - k8s.namespace.name
        - k8s.node.name
        - k8s.deployment.name
      labels:
        - tag_name: app
          key: app
          from: pod

  # Batch before exporting
  batch:
    timeout: 5s
    send_batch_size: 1024
    send_batch_max_size: 2048

  # Probabilistic sampling — sample 10% of traces in high-volume services
  probabilistic_sampler:
    sampling_percentage: 10

  # Always sample error spans
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors-policy
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow-traces-policy
        type: latency
        latency:
          threshold_ms: 1000
      - name: probabilistic-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 10

  memory_limiter:
    check_interval: 1s
    limit_mib: 1024
    spike_limit_mib: 256

exporters:
  # Traces to Grafana Tempo
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true

  # Metrics to Grafana Mimir
  prometheusremotewrite:
    endpoint: http://mimir.monitoring.svc.cluster.local:9009/api/v1/push
    add_metric_suffixes: false

  # Logs to Grafana Loki
  loki:
    endpoint: http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push

  # Debug — print to stdout
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [k8sattributes, memory_limiter, tail_sampling, batch]
      exporters: [otlp/tempo]

    metrics:
      receivers: [otlp, prometheus]
      processors: [k8sattributes, memory_limiter, batch]
      exporters: [prometheusremotewrite]

    logs:
      receivers: [otlp]
      processors: [k8sattributes, batch]
      exporters: [loki]
```

## Section 8: Complete main.go Integration

```go
// main.go
package main

import (
    "context"
    "errors"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/myorg/api/middleware"
    "github.com/myorg/api/router"
    "github.com/myorg/api/telemetry"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Initialize OpenTelemetry
    tel, err := telemetry.Init(ctx, telemetry.Config{
        ServiceName:    "api-server",
        ServiceVersion: version,
        Environment:    os.Getenv("ENV"),
        OTLPEndpoint:   getEnvOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector:4317"),
        SampleRate:     0.1, // 10% sampling
    })
    if err != nil {
        logger.Error("Failed to initialize telemetry", "error", err)
        os.Exit(1)
    }
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := tel.Shutdown(shutdownCtx); err != nil {
            logger.Error("Telemetry shutdown error", "error", err)
        }
    }()

    // Initialize metrics
    metrics, err := telemetry.NewAPIMetrics(cache.Size)
    if err != nil {
        logger.Error("Failed to initialize metrics", "error", err)
        os.Exit(1)
    }

    // HTTP server
    mux := http.NewServeMux()
    mux.Handle("/", middleware.OTelMiddleware(metrics)(router.New()))
    mux.Handle("/metrics", promhttp.Handler()) // Prometheus scrape endpoint

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
        BaseContext:  func(_ net.Listener) context.Context { return ctx },
    }

    go func() {
        logger.Info("Starting server", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            logger.Error("Server error", "error", err)
        }
    }()

    <-ctx.Done()
    logger.Info("Shutting down server...")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := srv.Shutdown(shutdownCtx); err != nil {
        logger.Error("Server shutdown error", "error", err)
    }
}

func getEnvOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

The OpenTelemetry Go SDK provides a unified, vendor-neutral observability layer. With traces for distributed request flows, metrics for system health KPIs, baggage for cross-service correlation, and exemplars linking metric anomalies to specific traces, you get complete observability with a single instrumentation investment.
