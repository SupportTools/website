---
title: "OpenTelemetry Go SDK: Production Tracing, Metrics, and OTLP Export"
date: 2027-09-25T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Go", "Tracing", "Observability", "OTLP", "Jaeger", "Prometheus"]
categories: ["Observability", "Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to the OpenTelemetry Go SDK covering TracerProvider configuration, context propagation, OTLP gRPC export, head-based and tail-based sampling, custom attributes, metrics bridge, and Kubernetes sidecar deployment patterns."
more_link: "yes"
url: "/opentelemetry-go-sdk-production-guide/"
---

The OpenTelemetry Go SDK provides a vendor-neutral instrumentation layer for distributed tracing, metrics, and structured logging. Production adoption requires careful consideration of TracerProvider initialization, sampling strategy, OTLP exporter configuration, W3C trace context propagation, and resource attribution. This guide covers complete production patterns from SDK bootstrap through Kubernetes deployment, with emphasis on performance characteristics and error handling that affect service reliability.

<!--more-->

## SDK Architecture Overview

The OpenTelemetry Go SDK consists of three layers:

1. **API layer** (`go.opentelemetry.io/otel`) — interfaces and NOOP implementations; applications import only this
2. **SDK layer** (`go.opentelemetry.io/otel/sdk`) — concrete implementations of TracerProvider, MeterProvider
3. **Exporters** — OTLP gRPC/HTTP, Jaeger, Zipkin, Prometheus, stdout

This separation means library authors instrument against the API, and applications configure the SDK at initialization time. When no SDK is configured, all operations are NOOP with negligible overhead.

## Dependencies and Module Setup

```go
// go.mod
module github.com/example/service

go 1.22

require (
    go.opentelemetry.io/otel                    v1.26.0
    go.opentelemetry.io/otel/sdk                v1.26.0
    go.opentelemetry.io/otel/sdk/metric         v1.26.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.26.0
    go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.26.0
    go.opentelemetry.io/otel/propagators/b3     v1.26.0
    go.opentelemetry.io/otel/bridge/opencensus  v1.26.0
    go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.52.0
    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.52.0
    google.golang.org/grpc                      v1.64.0
)
```

```bash
go get go.opentelemetry.io/otel@v1.26.0
go get go.opentelemetry.io/otel/sdk@v1.26.0
go get go.opentelemetry.io/otel/sdk/metric@v1.26.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.26.0
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@v1.26.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.52.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.52.0
```

## TracerProvider Initialization

### Production Bootstrap Function

```go
// internal/telemetry/telemetry.go
package telemetry

import (
    "context"
    "errors"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/propagation"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.25.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/credentials/insecure"
)

// Config holds OpenTelemetry SDK configuration.
type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    Namespace      string
    OTLPEndpoint   string        // e.g., "otel-collector.monitoring.svc.cluster.local:4317"
    OTLPInsecure   bool          // use insecure transport (in-cluster sidecar)
    SampleRate     float64       // 0.0 to 1.0; 1.0 = always sample
    TLSCertFile    string        // path to CA cert for TLS verification
    Timeout        time.Duration // connection timeout
}

// Provider holds the initialized SDK providers and shutdown functions.
type Provider struct {
    TracerProvider *sdktrace.TracerProvider
    MeterProvider  *sdkmetric.MeterProvider
    shutdown       []func(context.Context) error
}

// Shutdown flushes pending spans and metrics and closes exporter connections.
// Must be called on application shutdown; defer in main().
func (p *Provider) Shutdown(ctx context.Context) error {
    var errs []error
    for _, fn := range p.shutdown {
        if err := fn(ctx); err != nil {
            errs = append(errs, err)
        }
    }
    return errors.Join(errs...)
}

// Setup initializes the OpenTelemetry SDK and returns a Provider.
// Returns a NOOP provider if OTLPEndpoint is empty (useful for tests and local dev).
func Setup(ctx context.Context, cfg Config) (*Provider, error) {
    if cfg.OTLPEndpoint == "" {
        // Return NOOP providers when no endpoint is configured
        return &Provider{}, nil
    }

    // Build resource attributes describing this service instance
    res, err := buildResource(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("telemetry: build resource: %w", err)
    }

    // Establish gRPC connection to OTLP collector
    conn, err := buildGRPCConn(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("telemetry: dial OTLP endpoint %s: %w", cfg.OTLPEndpoint, err)
    }

    p := &Provider{}

    // Initialize trace exporter and provider
    traceExporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
    )
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("telemetry: create trace exporter: %w", err)
    }

    sampleRate := cfg.SampleRate
    if sampleRate <= 0 {
        sampleRate = 0.1 // Default: 10% sampling
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(traceExporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(
            sdktrace.ParentBased(
                sdktrace.TraceIDRatioBased(sampleRate),
            ),
        ),
    )
    p.TracerProvider = tp
    p.shutdown = append(p.shutdown, tp.Shutdown)

    // Initialize metric exporter and provider
    metricExporter, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithGRPCConn(conn),
    )
    if err != nil {
        _ = tp.Shutdown(ctx)
        conn.Close()
        return nil, fmt.Errorf("telemetry: create metric exporter: %w", err)
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(metricExporter,
                sdkmetric.WithInterval(15*time.Second),
                sdkmetric.WithTimeout(10*time.Second),
            ),
        ),
        sdkmetric.WithResource(res),
    )
    p.MeterProvider = mp
    p.shutdown = append(p.shutdown, mp.Shutdown)
    p.shutdown = append(p.shutdown, func(ctx context.Context) error {
        return conn.Close()
    })

    // Register as global providers
    otel.SetTracerProvider(tp)
    otel.SetMeterProvider(mp)

    // Configure W3C trace context + baggage propagation
    otel.SetTextMapPropagator(
        propagation.NewCompositeTextMapPropagator(
            propagation.TraceContext{},
            propagation.Baggage{},
        ),
    )

    return p, nil
}

func buildResource(ctx context.Context, cfg Config) (*resource.Resource, error) {
    return resource.New(ctx,
        resource.WithFromEnv(),      // OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME
        resource.WithProcess(),      // process.pid, process.executable.name
        resource.WithOS(),           // os.type, os.description
        resource.WithContainer(),    // container.id (from /proc/self/cgroup)
        resource.WithHost(),         // host.name, host.id
        resource.WithTelemetrySDK(), // telemetry.sdk.name, .language, .version
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
            attribute.String("service.namespace", cfg.Namespace),
        ),
    )
}

func buildGRPCConn(ctx context.Context, cfg Config) (*grpc.ClientConn, error) {
    dialCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
    defer cancel()

    var creds credentials.TransportCredentials
    if cfg.OTLPInsecure {
        creds = insecure.NewCredentials()
    } else {
        var err error
        creds, err = credentials.NewClientTLSFromFile(cfg.TLSCertFile, "")
        if err != nil {
            return nil, fmt.Errorf("load TLS certs from %s: %w", cfg.TLSCertFile, err)
        }
    }

    return grpc.DialContext(dialCtx, cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(creds),
        grpc.WithBlock(),
    )
}
```

### Main Function Integration

```go
// main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/service/internal/telemetry"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    // Initialize OpenTelemetry SDK
    tel, err := telemetry.Setup(ctx, telemetry.Config{
        ServiceName:    "payments-api",
        ServiceVersion: os.Getenv("APP_VERSION"),
        Environment:    os.Getenv("APP_ENV"),
        Namespace:      os.Getenv("APP_NAMESPACE"),
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        OTLPInsecure:   os.Getenv("OTEL_EXPORTER_OTLP_INSECURE") == "true",
        SampleRate:     0.1,  // 10% for production; 1.0 for development
        Timeout:        5 * time.Second,
    })
    if err != nil {
        slog.Error("failed to initialize OpenTelemetry", "error", err)
        os.Exit(1)
    }
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        if err := tel.Shutdown(shutdownCtx); err != nil {
            slog.Error("OpenTelemetry shutdown error", "error", err)
        }
    }()

    slog.Info("OpenTelemetry initialized",
        "service", "payments-api",
        "endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
    )

    // Start application server
    srv := buildServer()
    go func() {
        slog.Info("starting HTTP server", "addr", ":8080")
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            slog.Error("server error", "error", err)
        }
    }()

    <-ctx.Done()
    slog.Info("shutting down")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := srv.Shutdown(shutdownCtx); err != nil {
        slog.Error("HTTP server shutdown error", "error", err)
    }
}
```

## HTTP Handler Instrumentation

### otelhttp Middleware

```go
// internal/server/server.go
package server

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("payments-api/server")

// NewRouter creates an HTTP mux with OpenTelemetry instrumentation.
func NewRouter() http.Handler {
    mux := http.NewServeMux()

    // Routes with per-route span names
    mux.Handle("/api/v1/payments", otelhttp.WithRouteTag("/api/v1/payments",
        http.HandlerFunc(handleCreatePayment)))
    mux.Handle("/api/v1/payments/{id}", otelhttp.WithRouteTag("/api/v1/payments/{id}",
        http.HandlerFunc(handleGetPayment)))
    mux.Handle("/health", http.HandlerFunc(handleHealth))

    // Wrap the entire mux with OTel middleware
    // otelhttp adds:
    //   - http.server.request.duration histogram
    //   - http.server.active_requests gauge
    //   - Automatic span creation per request
    //   - W3C trace context extraction from headers
    return otelhttp.NewHandler(mux, "payments-api",
        otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
            // Use the route pattern (set by otelhttp.WithRouteTag) as span name
            route := otelhttp.RouteFromContext(r.Context())
            if route != "" {
                return route
            }
            return operation
        }),
        otelhttp.WithSpanOptions(
            trace.WithSpanKind(trace.SpanKindServer),
        ),
        // Filter out health check and metrics endpoints from tracing
        otelhttp.WithFilter(func(r *http.Request) bool {
            return r.URL.Path != "/health" && r.URL.Path != "/metrics"
        }),
    )
}

func handleCreatePayment(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Create a child span for the business logic
    ctx, span := tracer.Start(ctx, "CreatePayment",
        trace.WithSpanKind(trace.SpanKindInternal),
        trace.WithAttributes(
            attribute.String("payment.currency", r.Header.Get("X-Currency")),
        ),
    )
    defer span.End()

    // Validate request
    ctx, validateSpan := tracer.Start(ctx, "ValidatePaymentRequest")
    amount, currency, err := parsePaymentRequest(r)
    if err != nil {
        validateSpan.RecordError(err)
        validateSpan.SetStatus(codes.Error, err.Error())
        validateSpan.End()
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }
    validateSpan.SetAttributes(
        attribute.Float64("payment.amount", amount),
        attribute.String("payment.currency", currency),
    )
    validateSpan.End()

    // Process payment (calls downstream service)
    result, err := processPayment(ctx, amount, currency)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment processing failed")
        http.Error(w, "payment failed", http.StatusInternalServerError)
        return
    }

    span.SetAttributes(
        attribute.String("payment.id", result.ID),
        attribute.String("payment.status", result.Status),
    )
    span.SetStatus(codes.Ok, "")

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    // ... write response
}
```

## gRPC Instrumentation

### otelgrpc Interceptors

```go
// internal/grpc/client.go
package grpcclient

import (
    "context"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// NewClient creates a gRPC client with OTel instrumentation.
func NewClient(target string) (*grpc.ClientConn, error) {
    return grpc.NewClient(target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithStatsHandler(
            otelgrpc.NewClientHandler(
                otelgrpc.WithMessageEvents(
                    otelgrpc.ReceivedEvents,
                    otelgrpc.SentEvents,
                ),
            ),
        ),
    )
}

// internal/grpc/server.go
package grpcserver

import (
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "google.golang.org/grpc"
)

// NewServer creates a gRPC server with OTel instrumentation.
func NewServer(opts ...grpc.ServerOption) *grpc.Server {
    opts = append(opts,
        grpc.StatsHandler(
            otelgrpc.NewServerHandler(
                otelgrpc.WithMessageEvents(
                    otelgrpc.ReceivedEvents,
                    otelgrpc.SentEvents,
                ),
            ),
        ),
    )
    return grpc.NewServer(opts...)
}
```

## Database Instrumentation

### PostgreSQL with otelsql

```go
// internal/db/db.go
package db

import (
    "database/sql"
    "fmt"

    "github.com/XSAM/otelsql"
    semconv "go.opentelemetry.io/otel/semconv/v1.25.0"
    _ "github.com/lib/pq"
)

// Open creates a traced PostgreSQL database connection pool.
func Open(dsn string) (*sql.DB, error) {
    // Register a traced driver
    db, err := otelsql.Open("postgres", dsn,
        otelsql.WithAttributes(
            semconv.DBSystemPostgreSQL,
        ),
        otelsql.WithDBName("payments"),
        otelsql.WithSpanNameFormatter(func(ctx context.Context, method otelsql.Method, query string) string {
            // Use SQL operation prefix as span name (avoid full query for cardinality)
            if len(query) > 60 {
                return fmt.Sprintf("db.%s: %s...", method, query[:60])
            }
            return fmt.Sprintf("db.%s: %s", method, query)
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("open db: %w", err)
    }

    // Report connection pool metrics to OTel metrics
    if err := otelsql.RegisterDBStatsMetrics(db,
        otelsql.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.DBName("payments"),
        ),
    ); err != nil {
        return nil, fmt.Errorf("register db stats metrics: %w", err)
    }

    return db, nil
}
```

## Sampling Configuration

### Head-Based Sampling Strategies

```go
// internal/telemetry/sampling.go
package telemetry

import (
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

// PrioritySampler implements parent-based sampling with a per-operation override.
// High-priority operations (payment processing, auth failures) are always sampled.
// Everything else uses the configured base rate.
type PrioritySampler struct {
    base          sdktrace.Sampler
    alwaysSample  []string // operation names always sampled at 100%
}

func NewPrioritySampler(baseRate float64, alwaysOps ...string) sdktrace.Sampler {
    return &PrioritySampler{
        base: sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(baseRate),
        ),
        alwaysSample: alwaysOps,
    }
}

func (s *PrioritySampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample high-priority operations
    for _, op := range s.alwaysSample {
        if p.Name == op {
            return sdktrace.SamplingResult{
                Decision:   sdktrace.RecordAndSample,
                Tracestate: p.ParentContext.TraceState(),
            }
        }
    }

    // Always sample error spans regardless of base rate
    for _, attr := range p.Attributes {
        if attr.Key == attribute.Key("error") && attr.Value.AsBool() {
            return sdktrace.SamplingResult{
                Decision:   sdktrace.RecordAndSample,
                Tracestate: p.ParentContext.TraceState(),
            }
        }
    }

    // Fall back to base sampler
    return s.base.ShouldSample(p)
}

func (s *PrioritySampler) Description() string {
    return fmt.Sprintf("PrioritySampler{base=%s,priority=%v}",
        s.base.Description(), s.alwaysSample)
}
```

Use the priority sampler in TracerProvider configuration:

```go
tp := sdktrace.NewTracerProvider(
    sdktrace.WithBatcher(traceExporter),
    sdktrace.WithResource(res),
    sdktrace.WithSampler(
        NewPrioritySampler(0.05, // 5% base rate
            "CreatePayment",
            "AuthenticateUser",
            "ProcessRefund",
        ),
    ),
)
```

## Custom Metrics

### Application Metrics with OTel Meter API

```go
// internal/metrics/metrics.go
package metrics

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

var meter = otel.Meter("payments-api/metrics")

// PaymentMetrics holds all instrumented measurements for the payments service.
type PaymentMetrics struct {
    requestDuration  metric.Float64Histogram
    paymentAmount    metric.Float64Histogram
    activePayments   metric.Int64UpDownCounter
    paymentErrors    metric.Int64Counter
    externalCalls    metric.Int64Counter
}

// NewPaymentMetrics initializes all metrics instruments.
func NewPaymentMetrics() (*PaymentMetrics, error) {
    m := &PaymentMetrics{}
    var err error

    m.requestDuration, err = meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("Duration of HTTP server requests in seconds"),
        metric.WithUnit("s"),
        // Explicit bucket boundaries matching Prometheus histograms
        metric.WithExplicitBucketBoundaries(
            0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("create request_duration histogram: %w", err)
    }

    m.paymentAmount, err = meter.Float64Histogram(
        "payments.amount",
        metric.WithDescription("Payment transaction amounts in USD"),
        metric.WithUnit("{USD}"),
        metric.WithExplicitBucketBoundaries(
            1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000,
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("create payment_amount histogram: %w", err)
    }

    m.activePayments, err = meter.Int64UpDownCounter(
        "payments.active",
        metric.WithDescription("Number of payments currently being processed"),
    )
    if err != nil {
        return nil, fmt.Errorf("create active_payments counter: %w", err)
    }

    m.paymentErrors, err = meter.Int64Counter(
        "payments.errors.total",
        metric.WithDescription("Total number of payment processing errors"),
    )
    if err != nil {
        return nil, fmt.Errorf("create payment_errors counter: %w", err)
    }

    m.externalCalls, err = meter.Int64Counter(
        "payments.external_calls.total",
        metric.WithDescription("Total calls to external payment processors"),
    )
    if err != nil {
        return nil, fmt.Errorf("create external_calls counter: %w", err)
    }

    return m, nil
}

// RecordPayment records metrics for a completed payment transaction.
func (m *PaymentMetrics) RecordPayment(ctx context.Context,
    duration time.Duration,
    amount float64,
    currency, status, processor string,
    err error,
) {
    attrs := []attribute.KeyValue{
        attribute.String("payment.currency", currency),
        attribute.String("payment.status", status),
        attribute.String("payment.processor", processor),
    }

    m.requestDuration.Record(ctx, duration.Seconds(), metric.WithAttributes(attrs...))
    m.paymentAmount.Record(ctx, amount, metric.WithAttributes(attrs...))

    if err != nil {
        errAttrs := append(attrs, attribute.String("error.type", errorType(err)))
        m.paymentErrors.Add(ctx, 1, metric.WithAttributes(errAttrs...))
    }
}

func (m *PaymentMetrics) IncrementActive(ctx context.Context) {
    m.activePayments.Add(ctx, 1)
}

func (m *PaymentMetrics) DecrementActive(ctx context.Context) {
    m.activePayments.Add(ctx, -1)
}
```

## Context Propagation Across Services

### HTTP Client with Trace Propagation

```go
// internal/httpclient/client.go
package httpclient

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("payments-api/httpclient")

// Client is an instrumented HTTP client that propagates trace context.
type Client struct {
    inner *http.Client
}

// NewClient creates an HTTP client with OTel transport instrumentation.
func NewClient(timeout time.Duration) *Client {
    return &Client{
        inner: &http.Client{
            Timeout:   timeout,
            Transport: otelhttp.NewTransport(http.DefaultTransport,
                otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
                    return fmt.Sprintf("HTTP %s %s", r.Method, r.URL.Host)
                }),
            ),
        },
    }
}

// Get performs an instrumented HTTP GET request.
// The trace context from ctx is injected into the outgoing request headers
// via the W3C Trace Context propagator configured in otel.SetTextMapPropagator.
func (c *Client) Get(ctx context.Context, url string) (*http.Response, error) {
    ctx, span := tracer.Start(ctx, "http.client.GET",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("http.url", url),
            attribute.String("http.method", "GET"),
        ),
    )
    defer span.End()

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    // otelhttp.NewTransport automatically injects traceparent and tracestate headers
    resp, err := c.inner.Do(req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))
    if resp.StatusCode >= 400 {
        span.SetStatus(codes.Error, http.StatusText(resp.StatusCode))
    }

    return resp, nil
}
```

## Kubernetes Deployment with OTel Collector Sidecar

### Pod Spec with Collector Sidecar

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: payments-api
          image: registry.example.com/payments-api:v2.1.0
          env:
            - name: APP_VERSION
              value: "2.1.0"
            - name: APP_ENV
              value: "production"
            - name: APP_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            # Point to sidecar collector on localhost
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "localhost:4317"
            - name: OTEL_EXPORTER_OTLP_INSECURE
              value: "true"
            # SDK-level resource attributes via environment
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "k8s.pod.name=$(POD_NAME),k8s.node.name=$(NODE_NAME)"
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi

        # OTel Collector sidecar — receives from app, exports to central collector
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.100.0
          args:
            - --config=/etc/otelcol/config.yaml
          volumeMounts:
            - name: otel-config
              mountPath: /etc/otelcol
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          ports:
            - containerPort: 4317  # OTLP gRPC receiver
              name: otlp-grpc
            - containerPort: 8888  # Prometheus metrics for the collector itself
              name: metrics

      volumes:
        - name: otel-config
          configMap:
            name: otel-collector-sidecar-config
```

### OTel Collector Sidecar Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-sidecar-config
  namespace: production
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
      # Batch spans for efficient export
      batch:
        timeout: 1s
        send_batch_size: 1024
        send_batch_max_size: 2048

      # Add Kubernetes metadata to all signals
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.deployment.name
            - k8s.statefulset.name
            - k8s.daemonset.name
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.node.name
          labels:
            - tag_name: app.version
              key: app.kubernetes.io/version
              from: pod
          annotations:
            - tag_name: custom.team
              key: team
              from: namespace

      # Memory limiter prevents OOM
      memory_limiter:
        check_interval: 1s
        limit_mib: 200
        spike_limit_mib: 50

      # Drop spans from health check endpoints
      filter/health:
        error_mode: ignore
        traces:
          span:
            - 'attributes["http.route"] == "/health"'
            - 'attributes["http.target"] == "/metrics"'

    exporters:
      # Forward to central OTel collector
      otlp:
        endpoint: "otel-collector.monitoring.svc.cluster.local:4317"
        tls:
          ca_file: /etc/otelcol/ca.crt
        headers:
          X-Scope-OrgID: "production"

      # Expose Prometheus metrics from the collector
      prometheus:
        endpoint: "0.0.0.0:8888"
        namespace: otelcol

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, filter/health, batch]
          exporters: [otlp]

        metrics:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlp, prometheus]
```

## Trace Context in Structured Logging

### Correlating Logs with Traces

```go
// internal/logging/logging.go
package logging

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/otel/trace"
)

// NewTraceLogger returns a slog.Logger that automatically injects
// trace_id and span_id fields from the context into every log record.
// This enables log-trace correlation in Loki/Grafana.
func NewTraceLogger() *slog.Logger {
    return slog.New(&traceHandler{
        inner: slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
            Level: slog.LevelInfo,
        }),
    })
}

type traceHandler struct {
    inner slog.Handler
}

func (h *traceHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.inner.Enabled(ctx, level)
}

func (h *traceHandler) Handle(ctx context.Context, r slog.Record) error {
    if spanCtx := trace.SpanFromContext(ctx).SpanContext(); spanCtx.IsValid() {
        r.AddAttrs(
            slog.String("trace_id", spanCtx.TraceID().String()),
            slog.String("span_id", spanCtx.SpanID().String()),
            slog.Bool("trace_sampled", spanCtx.IsSampled()),
        )
    }
    return h.inner.Handle(ctx, r)
}

func (h *traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &traceHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *traceHandler) WithGroup(name string) slog.Handler {
    return &traceHandler{inner: h.inner.WithGroup(name)}
}
```

Example log output with trace correlation:

```json
{
  "time": "2027-09-25T10:15:30.123Z",
  "level": "INFO",
  "msg": "payment processed",
  "payment_id": "pay_abc123",
  "amount": 150.00,
  "currency": "USD",
  "duration_ms": 45,
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "trace_sampled": true
}
```

## Graceful Shutdown

The shutdown sequence must flush all pending spans and metrics before process exit:

```go
func gracefulShutdown(tel *telemetry.Provider, httpServer *http.Server) {
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Step 1: Stop accepting new requests
    if err := httpServer.Shutdown(shutdownCtx); err != nil {
        slog.Error("HTTP server shutdown", "error", err)
    }

    // Step 2: Flush OTel signals (spans, metrics)
    // This blocks until all pending export operations complete or timeout
    if err := tel.Shutdown(shutdownCtx); err != nil {
        slog.Error("OTel shutdown", "error", err)
    }

    slog.Info("shutdown complete")
}
```

## Performance Characteristics

### Overhead Benchmarks

The OTel Go SDK overhead is minimal when properly configured:

| Configuration | CPU overhead | Memory overhead |
|---|---|---|
| NOOP provider (no SDK) | ~0 ns/op | 0 |
| SDK with 10% sampling | ~200-400 ns/span | ~1-2 KB/span |
| SDK with 100% sampling | ~400-800 ns/span | ~2-4 KB/span |
| Histogram recording | ~100 ns/record | negligible |
| Counter increment | ~50 ns/op | negligible |

### Batching Configuration Tuning

For high-throughput services (>10,000 requests/second):

```go
sdktrace.WithBatcher(traceExporter,
    // Larger batch timeout reduces OTLP calls at the cost of higher latency
    sdktrace.WithBatchTimeout(10*time.Second),
    // Larger batch size reduces per-export overhead
    sdktrace.WithMaxExportBatchSize(2048),
    // Larger queue handles traffic spikes without dropping spans
    sdktrace.WithMaxQueueSize(8192),
    // Multiple goroutines export in parallel
    // Default is 1; increase for high-throughput exporters
    // sdktrace.WithNumExporters(4), // not in standard API; use OTLP batching
),
```

## ServiceMonitor for OTel Collector Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otel-collector-sidecar
  namespace: production
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: payments-api
  namespaceSelector:
    matchNames:
      - production
  endpoints:
    - port: metrics
      path: /metrics
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```
