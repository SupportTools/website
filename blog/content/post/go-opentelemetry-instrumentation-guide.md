---
title: "Go OpenTelemetry Instrumentation: Traces, Metrics, and Logs in One SDK"
date: 2028-04-28T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Tracing", "Metrics", "Observability", "OTEL"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to instrumenting Go applications with the OpenTelemetry SDK covering distributed tracing, custom metrics, log correlation, context propagation, and production deployment with the OTel Collector."
more_link: "yes"
url: "/go-opentelemetry-instrumentation-guide/"
---

OpenTelemetry provides a single, vendor-neutral SDK for all three observability signals: traces, metrics, and logs. This guide covers the practical Go implementation: setting up the SDK, instrumenting HTTP and gRPC services, creating custom spans and metrics, correlating logs with traces, propagating context across service boundaries, and configuring the OTel Collector for production export.

<!--more-->

# Go OpenTelemetry Instrumentation: Traces, Metrics, and Logs in One SDK

## OpenTelemetry Architecture

OpenTelemetry separates the API (semantic conventions and interfaces) from the SDK (implementation and exporters). Applications depend on the API; the SDK is injected at startup. This separation allows changing exporters without modifying instrumented code.

Signal flow:

```
Application Code
    ↓
OTel API (traces/metrics/logs)
    ↓
OTel SDK (processors, samplers)
    ↓
Exporter (OTLP/gRPC or OTLP/HTTP)
    ↓
OTel Collector
    ↓
Backends: Jaeger, Prometheus, Loki, Datadog, etc.
```

### Go Module Setup

```bash
go get go.opentelemetry.io/otel@latest
go get go.opentelemetry.io/otel/sdk@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@latest
go get go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc@latest
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@latest
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@latest
go get go.opentelemetry.io/otel/bridge/opencensus@latest
```

## SDK Initialization

### Complete Bootstrap Package

```go
// internal/telemetry/telemetry.go
package telemetry

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
    CollectorAddr  string // e.g., "otel-collector:4317"
    SampleRate     float64
}

type Shutdown func(ctx context.Context) error

// Init initializes the OpenTelemetry SDK for all three signals.
// Returns a shutdown function that must be called before the program exits.
func Init(ctx context.Context, cfg Config) (Shutdown, error) {
    // Build resource describing this service
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithFromEnv(),    // OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
        resource.WithProcess(),    // PID, executable name
        resource.WithOS(),         // OS type and description
        resource.WithHost(),       // Hostname
        resource.WithContainerID(), // Container ID if running in Docker/K8s
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // OTLP gRPC connection
    conn, err := grpc.NewClient(cfg.CollectorAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("creating gRPC connection to collector: %w", err)
    }

    // Initialize all three signals
    shutdownTrace, err := initTracer(ctx, conn, res, cfg.SampleRate)
    if err != nil {
        return nil, fmt.Errorf("initializing tracer: %w", err)
    }

    shutdownMetric, err := initMeter(ctx, conn, res)
    if err != nil {
        return nil, fmt.Errorf("initializing meter: %w", err)
    }

    shutdownLogger, err := initLogger(ctx, conn, res)
    if err != nil {
        return nil, fmt.Errorf("initializing logger: %w", err)
    }

    // Set global propagator for distributed tracing context
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{}, // W3C TraceContext
        propagation.Baggage{},      // W3C Baggage
    ))

    return func(ctx context.Context) error {
        ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
        defer cancel()
        _ = conn.Close()
        if err := shutdownTrace(ctx); err != nil {
            return fmt.Errorf("trace shutdown: %w", err)
        }
        if err := shutdownMetric(ctx); err != nil {
            return fmt.Errorf("metric shutdown: %w", err)
        }
        if err := shutdownLogger(ctx); err != nil {
            return fmt.Errorf("logger shutdown: %w", err)
        }
        return nil
    }, nil
}

func initTracer(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
    sampleRate float64,
) (Shutdown, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating trace exporter: %w", err)
    }

    sampler := sdktrace.TraceIDRatioBased(sampleRate)
    if sampleRate >= 1.0 {
        sampler = sdktrace.AlwaysSample()
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(
            sdktrace.ParentBased(sampler), // Respect parent's sampling decision
        ),
    )

    otel.SetTracerProvider(tp)

    return tp.Shutdown, nil
}

func initMeter(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
) (Shutdown, error) {
    exporter, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating metric exporter: %w", err)
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(exporter,
                sdkmetric.WithInterval(15*time.Second),
            ),
        ),
        sdkmetric.WithResource(res),
    )

    otel.SetMeterProvider(mp)

    return mp.Shutdown, nil
}

func initLogger(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
) (Shutdown, error) {
    exporter, err := otlploggrpc.New(ctx,
        otlploggrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating log exporter: %w", err)
    }

    lp := sdklog.NewLoggerProvider(
        sdklog.WithProcessor(
            sdklog.NewBatchProcessor(exporter),
        ),
        sdklog.WithResource(res),
    )

    global.SetLoggerProvider(lp)

    return lp.Shutdown, nil
}
```

### Using the Bootstrap in main.go

```go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "myapp/internal/telemetry"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    shutdown, err := telemetry.Init(ctx, telemetry.Config{
        ServiceName:    "order-service",
        ServiceVersion: "2.1.0",
        Environment:    os.Getenv("ENVIRONMENT"),
        CollectorAddr:  os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:     0.1, // Sample 10% of traces
    })
    if err != nil {
        slog.Error("Failed to initialize telemetry", "error", err)
        os.Exit(1)
    }
    defer func() {
        if err := shutdown(context.Background()); err != nil {
            slog.Error("Telemetry shutdown error", "error", err)
        }
    }()

    // Start application...
    if err := runServer(ctx); err != nil {
        slog.Error("Server error", "error", err)
        os.Exit(1)
    }
}
```

## Tracing HTTP Servers

### Using otelhttp Middleware

```go
package server

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("order-service/server")

func NewHTTPServer() *http.ServeMux {
    mux := http.NewServeMux()

    // Wrap entire mux with OTel middleware
    // Automatically creates spans for each request with HTTP semantic conventions
    handler := otelhttp.NewHandler(mux, "order-service",
        otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
        otelhttp.WithFilter(func(r *http.Request) bool {
            // Don't trace health check endpoints
            return r.URL.Path != "/healthz" && r.URL.Path != "/readyz"
        }),
    )

    mux.Handle("/orders", otelhttp.WithRouteTag("/orders", http.HandlerFunc(handleOrders)))
    mux.Handle("/orders/{id}", otelhttp.WithRouteTag("/orders/{id}", http.HandlerFunc(handleOrder)))

    _ = handler
    return mux
}

func handleOrders(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Get the span created by otelhttp middleware
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(
        attribute.String("user.id", r.Header.Get("X-User-ID")),
        attribute.String("tenant.id", r.Header.Get("X-Tenant-ID")),
    )

    orders, err := fetchOrders(ctx, r.Header.Get("X-Tenant-ID"))
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        return
    }

    span.SetAttributes(attribute.Int("orders.count", len(orders)))
    json.NewEncoder(w).Encode(orders)
}

func fetchOrders(ctx context.Context, tenantID string) ([]Order, error) {
    // Create a child span for the database operation
    ctx, span := tracer.Start(ctx, "database.query.orders",
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.name", "orders"),
            attribute.String("db.operation", "SELECT"),
            attribute.String("tenant.id", tenantID),
        ),
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    // Perform database query...
    orders, err := queryDatabase(ctx, tenantID)
    if err != nil {
        span.RecordError(err, trace.WithStackTrace(true))
        span.SetStatus(codes.Error, fmt.Sprintf("database query failed: %v", err))
        return nil, err
    }

    span.SetAttributes(attribute.Int("db.rows_returned", len(orders)))
    return orders, nil
}
```

### Tracing HTTP Clients

```go
package client

import (
    "context"
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewTracedHTTPClient returns an HTTP client that propagates trace context.
func NewTracedHTTPClient() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport,
            otelhttp.WithClientTrace(func(ctx context.Context) *httptrace.ClientTrace {
                return otelhttptrace.NewClientTrace(ctx)
            }),
        ),
        Timeout: 30 * time.Second,
    }
}

// All outgoing requests from this client will:
// 1. Create a child span
// 2. Inject W3C TraceContext headers (traceparent, tracestate)
// 3. Record HTTP attributes (method, url, status code)
```

## Tracing gRPC Services

```go
package grpcserver

import (
    "context"
    "fmt"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    pb "myapp/gen/orders/v1"
)

var tracer = otel.Tracer("order-service/grpc")

// NewGRPCServer creates a gRPC server with OTel interceptors.
func NewGRPCServer() *grpc.Server {
    return grpc.NewServer(
        grpc.StatsHandler(otelgrpc.NewServerHandler(
            otelgrpc.WithMessageEvents(
                otelgrpc.ReceivedEvents,
                otelgrpc.SentEvents,
            ),
        )),
    )
}

// NewGRPCClient creates a gRPC client with OTel interceptors.
func NewGRPCClient(addr string) (*grpc.ClientConn, error) {
    return grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
    )
}

// OrderServiceServer implements the gRPC service
type OrderServiceServer struct {
    pb.UnimplementedOrderServiceServer
    db OrderRepository
}

func (s *OrderServiceServer) GetOrder(
    ctx context.Context,
    req *pb.GetOrderRequest,
) (*pb.GetOrderResponse, error) {
    // Span is already created by the otelgrpc interceptor
    // Add business-level attributes
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(
        attribute.String("order.id", req.OrderId),
        attribute.String("rpc.service", "OrderService"),
    )

    order, err := s.db.GetByID(ctx, req.OrderId)
    if err != nil {
        span.RecordError(err)
        return nil, status.Errorf(codes.NotFound, "order %s not found", req.OrderId)
    }

    return &pb.GetOrderResponse{Order: orderToProto(order)}, nil
}
```

## Custom Metrics

```go
package metrics

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

type ServiceMetrics struct {
    requestDuration  metric.Float64Histogram
    requestCount     metric.Int64Counter
    activeRequests   metric.Int64UpDownCounter
    orderValue       metric.Float64Histogram
    queueDepth       metric.Int64ObservableGauge
    dbConnectionPool metric.Int64ObservableGauge
    getQueueDepth    func() int64
    getDBPoolSize    func() int64
}

func NewServiceMetrics(name string, getQueueDepth, getDBPoolSize func() int64) (*ServiceMetrics, error) {
    meter := otel.Meter(name,
        metric.WithInstrumentationVersion("1.0.0"),
    )

    requestDuration, err := meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("Duration of HTTP server requests"),
        metric.WithUnit("s"),
        // Custom histogram boundaries for SLA tracking
        metric.WithExplicitBucketBoundaries(
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating request duration histogram: %w", err)
    }

    requestCount, err := meter.Int64Counter(
        "http.server.requests.total",
        metric.WithDescription("Total number of HTTP server requests"),
    )
    if err != nil {
        return nil, fmt.Errorf("creating request counter: %w", err)
    }

    activeRequests, err := meter.Int64UpDownCounter(
        "http.server.active_requests",
        metric.WithDescription("Number of active HTTP requests"),
    )
    if err != nil {
        return nil, fmt.Errorf("creating active requests gauge: %w", err)
    }

    orderValue, err := meter.Float64Histogram(
        "business.order.value",
        metric.WithDescription("Value of processed orders in USD"),
        metric.WithUnit("{USD}"),
        metric.WithExplicitBucketBoundaries(
            1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000,
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating order value histogram: %w", err)
    }

    m := &ServiceMetrics{
        requestDuration: requestDuration,
        requestCount:    requestCount,
        activeRequests:  activeRequests,
        orderValue:      orderValue,
        getQueueDepth:   getQueueDepth,
        getDBPoolSize:   getDBPoolSize,
    }

    // Observable (async) gauges for external state
    _, err = meter.Int64ObservableGauge(
        "queue.depth",
        metric.WithDescription("Current depth of the processing queue"),
        metric.WithInt64Callback(func(_ context.Context, obs metric.Int64Observer) error {
            obs.Observe(m.getQueueDepth())
            return nil
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("creating queue depth gauge: %w", err)
    }

    _, err = meter.Int64ObservableGauge(
        "db.connection_pool.size",
        metric.WithDescription("Current database connection pool size"),
        metric.WithInt64Callback(func(_ context.Context, obs metric.Int64Observer) error {
            obs.Observe(m.getDBPoolSize(),
                metric.WithAttributes(attribute.String("pool.state", "active")),
            )
            return nil
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("creating db pool gauge: %w", err)
    }

    return m, nil
}

// RecordRequest records HTTP request metrics.
func (m *ServiceMetrics) RecordRequest(
    ctx context.Context,
    method, route string,
    statusCode int,
    duration time.Duration,
) {
    attrs := metric.WithAttributes(
        attribute.String("http.method", method),
        attribute.String("http.route", route),
        attribute.Int("http.response.status_code", statusCode),
    )

    m.requestDuration.Record(ctx, duration.Seconds(), attrs)
    m.requestCount.Add(ctx, 1, attrs)
}

func (m *ServiceMetrics) IncrementActiveRequests(ctx context.Context) {
    m.activeRequests.Add(ctx, 1)
}

func (m *ServiceMetrics) DecrementActiveRequests(ctx context.Context) {
    m.activeRequests.Add(ctx, -1)
}

func (m *ServiceMetrics) RecordOrderValue(ctx context.Context, value float64, currency string) {
    m.orderValue.Record(ctx, value,
        metric.WithAttributes(attribute.String("currency", currency)),
    )
}
```

## Structured Log Correlation with Traces

Go 1.21's `log/slog` integrates with OpenTelemetry to automatically inject trace IDs into log records:

```go
package logging

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/otel/trace"
)

// TraceHandler wraps slog.Handler to inject trace context into log records.
type TraceHandler struct {
    slog.Handler
}

func (h *TraceHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
            slog.Bool("trace_flags.sampled", span.SpanContext().IsSampled()),
        )
    }
    return h.Handler.Handle(ctx, r)
}

func (h *TraceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &TraceHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *TraceHandler) WithGroup(name string) slog.Handler {
    return &TraceHandler{Handler: h.Handler.WithGroup(name)}
}

// NewLogger creates a JSON logger that injects trace context.
func NewLogger(level slog.Level) *slog.Logger {
    jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     level,
        AddSource: true,
    })

    return slog.New(&TraceHandler{Handler: jsonHandler})
}

// Usage:
// logger.InfoContext(ctx, "Processing order",
//     slog.String("order_id", orderID),
//     slog.Float64("amount", amount))
//
// Output (when inside a sampled trace):
// {"time":"...","level":"INFO","source":...,"msg":"Processing order",
//  "order_id":"ord-123","amount":99.95,
//  "trace_id":"4bf92f3577b34da6a3ce929d0e0e4736",
//  "span_id":"00f067aa0ba902b7","trace_flags.sampled":true}
```

## Context Propagation Across Services

### HTTP Outgoing Requests

```go
package propagation

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// InjectHTTPHeaders injects trace context into outgoing HTTP request headers.
func InjectHTTPHeaders(ctx context.Context, req *http.Request) {
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// ExtractHTTPHeaders extracts trace context from incoming HTTP request headers.
func ExtractHTTPHeaders(ctx context.Context, req *http.Request) context.Context {
    return otel.GetTextMapPropagator().Extract(ctx, propagation.HeaderCarrier(req.Header))
}
```

### Kafka/NATS Message Propagation

```go
package messaging

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// MessageCarrier implements the TextMapCarrier interface for message headers.
type MessageCarrier map[string]string

func (c MessageCarrier) Get(key string) string     { return c[key] }
func (c MessageCarrier) Set(key, val string)       { c[key] = val }
func (c MessageCarrier) Keys() []string {
    keys := make([]string, 0, len(c))
    for k := range c {
        keys = append(keys, k)
    }
    return keys
}

// InjectToMessage injects trace context into message headers.
func InjectToMessage(ctx context.Context, headers map[string]string) {
    otel.GetTextMapPropagator().Inject(ctx, MessageCarrier(headers))
}

// ExtractFromMessage extracts trace context from message headers.
func ExtractFromMessage(ctx context.Context, headers map[string]string) context.Context {
    return otel.GetTextMapPropagator().Extract(ctx, MessageCarrier(headers))
}
```

## Span Events and Links

Span events mark significant moments within a span's lifetime without creating child spans:

```go
package tracing

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("order-service/processing")

func ProcessOrderWithEvents(ctx context.Context, orderID string) error {
    ctx, span := tracer.Start(ctx, "process-order",
        trace.WithAttributes(attribute.String("order.id", orderID)),
    )
    defer span.End()

    // Add events at key points in processing
    span.AddEvent("payment.initiated",
        trace.WithTimestamp(time.Now()),
        trace.WithAttributes(
            attribute.String("payment.provider", "stripe"),
            attribute.String("payment.method", "card"),
        ),
    )

    if err := chargePayment(ctx, orderID); err != nil {
        span.AddEvent("payment.failed",
            trace.WithAttributes(
                attribute.String("payment.error", err.Error()),
            ),
        )
        span.RecordError(err)
        return err
    }

    span.AddEvent("payment.completed")

    span.AddEvent("fulfillment.queued",
        trace.WithAttributes(
            attribute.String("warehouse.id", "WH-EAST-01"),
        ),
    )

    return nil
}

// Span Links connect causally related spans that aren't parent-child.
// Useful for async processing where a consumer handles messages from multiple producers.
func ProcessQueuedOrder(ctx context.Context, orderID string, producerSpanCtx trace.SpanContext) {
    ctx, span := tracer.Start(ctx, "process-queued-order",
        trace.WithAttributes(attribute.String("order.id", orderID)),
        // Link to the producer span that enqueued this message
        trace.WithLinks(
            trace.Link{
                SpanContext: producerSpanCtx,
                Attributes: []attribute.KeyValue{
                    attribute.String("link.type", "enqueued-by"),
                },
            },
        ),
    )
    defer span.End()

    // Process the order
}
```

## Baggage for Cross-Service Metadata

Baggage allows propagating key-value metadata across service boundaries (not just trace IDs):

```go
package baggage_example

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel/baggage"
)

// SetTenantBaggage adds tenant ID to baggage for propagation.
func SetTenantBaggage(ctx context.Context, tenantID string) (context.Context, error) {
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

// GetTenantFromBaggage retrieves tenant ID from baggage.
func GetTenantFromBaggage(ctx context.Context) string {
    b := baggage.FromContext(ctx)
    return b.Member("tenant.id").Value()
}

// Middleware that extracts and uses baggage
func TenantMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        tenantID := GetTenantFromBaggage(ctx)
        if tenantID != "" {
            ctx = context.WithValue(ctx, tenantContextKey{}, tenantID)
        }
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

## OTel Collector Configuration

### Collector Kubernetes Deployment

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
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"
      # Prometheus scraping for host metrics
      prometheus:
        config:
          scrape_configs:
            - job_name: 'otel-collector'
              scrape_interval: 15s
              static_configs:
                - targets: ['localhost:8888']

    processors:
      batch:
        timeout: 5s
        send_batch_size: 1000
        send_batch_max_size: 2000

      memory_limiter:
        check_interval: 1s
        limit_mib: 2048
        spike_limit_mib: 512

      # Add Kubernetes attributes to all signals
      k8sattributes:
        auth_type: "serviceAccount"
        passthrough: false
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.deployment.name
            - k8s.node.name
            - k8s.container.name
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip
          - sources:
              - from: connection

      # Filter out health check spans
      filter/healthchecks:
        traces:
          span:
            - 'attributes["http.target"] == "/healthz"'
            - 'attributes["http.target"] == "/readyz"'

      # Resource detection
      resourcedetection:
        detectors: [env, system, gcp, aws, azure]
        timeout: 5s

    exporters:
      # Traces to Jaeger
      otlp/jaeger:
        endpoint: "jaeger-collector:4317"
        tls:
          insecure: true

      # Metrics to Prometheus via remote write
      prometheusremotewrite:
        endpoint: "http://prometheus:9090/api/v1/write"
        resource_to_telemetry_conversion:
          enabled: true

      # Logs to Loki
      loki:
        endpoint: "http://loki:3100/loki/api/v1/push"
        labels:
          resource:
            - service.name
            - service.version
            - k8s.namespace.name
            - k8s.pod.name

      # Debug exporter for development
      debug:
        verbosity: detailed

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, filter/healthchecks, resourcedetection, batch]
          exporters: [otlp/jaeger]

        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [prometheusremotewrite]

        logs:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [loki]

      telemetry:
        logs:
          level: "warn"
        metrics:
          address: ":8888"
---
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
      serviceAccountName: otel-collector
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.105.0
          args:
            - "--config=/etc/otel/config.yaml"
          ports:
            - containerPort: 4317  # OTLP gRPC
            - containerPort: 4318  # OTLP HTTP
            - containerPort: 8888  # Collector metrics
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              cpu: 1
              memory: 2Gi
          volumeMounts:
            - name: config
              mountPath: /etc/otel
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
```

## Testing Instrumented Code

```go
package tracing_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func setupTestTracer(t *testing.T) (*tracetest.SpanRecorder, func()) {
    recorder := tracetest.NewSpanRecorder()
    tp := trace.NewTracerProvider(
        trace.WithSpanProcessor(recorder),
    )
    otel.SetTracerProvider(tp)

    return recorder, func() {
        _ = tp.Shutdown(context.Background())
    }
}

func TestOrderProcessingCreatesSpans(t *testing.T) {
    recorder, cleanup := setupTestTracer(t)
    defer cleanup()

    ctx := context.Background()

    // Run the function under test
    err := ProcessOrder(ctx, "order-123")
    require.NoError(t, err)

    // Verify spans were created
    spans := recorder.Ended()
    require.GreaterOrEqual(t, len(spans), 2)

    // Find the root span
    var rootSpan tracetest.SpanStub
    for _, s := range spans {
        if s.Name == "process-order" {
            rootSpan = s
            break
        }
    }

    assert.Equal(t, "process-order", rootSpan.Name)
    assert.Equal(t, "order-123", rootSpan.Attributes[0].Value.AsString())

    // Verify span events
    eventNames := make([]string, len(rootSpan.Events))
    for i, e := range rootSpan.Events {
        eventNames[i] = e.Name
    }
    assert.Contains(t, eventNames, "payment.completed")
}
```

## Summary

OpenTelemetry in Go provides unified observability with a clean separation between API and SDK. The key implementation decisions:

- Initialize the SDK once at startup with `resource.New()` to capture service identity
- Use `ParentBased` sampler to respect upstream sampling decisions in distributed traces
- Wrap HTTP mux and gRPC servers with OTel handlers before other middleware
- Use `Float64Histogram` for latency/duration metrics with explicit buckets aligned to SLAs
- Inject trace IDs into structured logs using a custom `slog.Handler`
- Deploy the OTel Collector with `k8sattributes` processor to enrich all signals with Kubernetes metadata
- Test instrumentation with `tracetest.SpanRecorder` to assert span structure without a real backend

The investment in proper instrumentation pays off during incidents when correlated traces, metrics, and logs collapse the time to root cause from hours to minutes.
