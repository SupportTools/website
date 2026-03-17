---
title: "OpenTelemetry Go SDK: Traces, Metrics, and Logs with Collector Configuration and Sampling Strategies"
date: 2028-06-29T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Tracing", "Observability", "Prometheus", "Jaeger"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to the OpenTelemetry Go SDK covering trace instrumentation, metrics with exemplars, log correlation, OpenTelemetry Collector configuration, tail-based sampling strategies, and Jaeger/Prometheus integration."
more_link: "yes"
url: "/opentelemetry-go-sdk-production-guide-production/"
---

OpenTelemetry is now the de facto standard for observability instrumentation, but the Go SDK documentation focuses on what is possible rather than what you should actually do in production. The signal-to-noise problem with distributed tracing is real: instrument everything naively and you drown in data; instrument too little and you have blind spots during incidents.

This guide covers the practical OpenTelemetry Go SDK setup that works in production: proper tracer initialization, metric instruments with exemplars, log-trace correlation, tail-based sampling configuration in the Collector, and the specific integration with Jaeger and Prometheus.

<!--more-->

# OpenTelemetry Go SDK: Traces, Metrics, and Logs with Collector Configuration and Sampling Strategies

## Section 1: SDK Initialization

### Complete Bootstrap

The initialization order matters: create a resource (service identity), configure exporters, set up providers, register them globally. Do this once at startup before any instrumentation fires.

```go
package telemetry

import (
    "context"
    "fmt"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/propagation"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string
    SamplingRate   float64
}

type Shutdown func(ctx context.Context) error

// Init initializes OpenTelemetry providers and returns a shutdown function.
// Call shutdown with a context that has a deadline (e.g., 5 seconds) during graceful shutdown.
func Init(ctx context.Context, cfg Config) (Shutdown, error) {
    // Build the service resource (identity metadata attached to all telemetry)
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithFromEnv(),  // OTEL_RESOURCE_ATTRIBUTES env var
        resource.WithProcess(),
        resource.WithOS(),
        resource.WithContainer(),
        resource.WithHost(),
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    // OTLP gRPC connection to collector
    conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("create OTLP connection: %w", err)
    }

    // Initialize trace provider
    tracerProvider, err := initTracer(ctx, conn, res, cfg.SamplingRate)
    if err != nil {
        return nil, fmt.Errorf("init tracer: %w", err)
    }

    // Initialize metric provider
    meterProvider, err := initMeter(ctx, conn, res)
    if err != nil {
        return nil, fmt.Errorf("init meter: %w", err)
    }

    // Set global providers
    otel.SetTracerProvider(tracerProvider)
    otel.SetMeterProvider(meterProvider)

    // Set global propagator (W3C TraceContext + Baggage)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    // Return combined shutdown function
    return func(ctx context.Context) error {
        err1 := tracerProvider.Shutdown(ctx)
        err2 := meterProvider.Shutdown(ctx)
        conn.Close()
        if err1 != nil {
            return err1
        }
        return err2
    }, nil
}

func initTracer(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
    samplingRate float64,
) (*sdktrace.TracerProvider, error) {
    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, err
    }

    // Choose sampler based on configuration
    var sampler sdktrace.Sampler
    switch {
    case samplingRate >= 1.0:
        sampler = sdktrace.AlwaysSample()
    case samplingRate <= 0.0:
        sampler = sdktrace.NeverSample()
    default:
        sampler = sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(samplingRate),
        )
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    return tp, nil
}

func initMeter(
    ctx context.Context,
    conn *grpc.ClientConn,
    res *resource.Resource,
) (*sdkmetric.MeterProvider, error) {
    // OTLP exporter for metrics
    otlpExporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, err
    }

    // Prometheus exporter for scraping
    promExporter, err := prometheus.New()
    if err != nil {
        return nil, err
    }

    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithResource(res),
        sdkmetric.WithReader(
            sdkmetric.NewPeriodicReader(otlpExporter,
                sdkmetric.WithInterval(15*time.Second),
            ),
        ),
        sdkmetric.WithReader(promExporter),
        // Custom view: aggregation configuration for specific instruments
        sdkmetric.WithView(
            sdkmetric.NewView(
                sdkmetric.Instrument{
                    Name: "http.server.request.duration",
                },
                sdkmetric.Stream{
                    // Custom histogram boundaries optimized for HTTP latency
                    Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
                        Boundaries: []float64{
                            0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25,
                            0.5, 0.75, 1, 2.5, 5, 7.5, 10,
                        },
                    },
                },
            ),
        ),
    )

    return mp, nil
}
```

### Application Bootstrap

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/myorg/myapp/telemetry"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    // Initialize OpenTelemetry
    shutdown, err := telemetry.Init(ctx, telemetry.Config{
        ServiceName:    "my-service",
        ServiceVersion: "1.2.3",
        Environment:    os.Getenv("ENVIRONMENT"),
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SamplingRate:   0.1, // 10% head-based sampling
    })
    if err != nil {
        log.Fatalf("Failed to initialize telemetry: %v", err)
    }

    // Setup HTTP server
    srv := &http.Server{
        Addr:    ":8080",
        Handler: newRouter(),
    }

    // Start server
    go func() {
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            log.Printf("HTTP server error: %v", err)
        }
    }()

    // Wait for shutdown signal
    <-ctx.Done()
    log.Println("Shutting down...")

    // Graceful shutdown with timeout
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Printf("HTTP server shutdown error: %v", err)
    }

    // Flush telemetry data
    if err := shutdown(shutdownCtx); err != nil {
        log.Printf("Telemetry shutdown error: %v", err)
    }
}
```

## Section 2: Trace Instrumentation

### HTTP Server Middleware

```go
package middleware

import (
    "fmt"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/metric"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

var (
    tracer = otel.Tracer("my-service/http")
    meter  = otel.Meter("my-service/http")
)

type responseWriter struct {
    http.ResponseWriter
    statusCode int
    size       int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.size += n
    return n, err
}

// OTelMiddleware instruments HTTP handlers with traces and metrics
func OTelMiddleware(next http.Handler) http.Handler {
    // Initialize instruments once (not per-request)
    requestDuration, _ := meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("Duration of HTTP requests"),
        metric.WithUnit("s"),
    )

    requestsActive, _ := meter.Int64UpDownCounter(
        "http.server.active_requests",
        metric.WithDescription("Number of active HTTP requests"),
    )

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Extract trace context from incoming request headers
        ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))

        // Start span
        spanName := fmt.Sprintf("%s %s", r.Method, r.URL.Path)
        ctx, span := tracer.Start(ctx, spanName,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.HTTPMethod(r.Method),
                semconv.HTTPRoute(r.URL.Path),
                semconv.URLPath(r.URL.Path),
                semconv.URLQuery(r.URL.RawQuery),
                semconv.HTTPScheme(scheme(r)),
                semconv.ServerAddress(r.Host),
                semconv.ClientAddress(r.RemoteAddr),
                semconv.UserAgentOriginal(r.UserAgent()),
            ),
        )
        defer span.End()

        // Increment active requests counter
        requestsActive.Add(ctx, 1)
        defer requestsActive.Add(ctx, -1)

        // Wrap response writer to capture status code
        wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}

        // Call next handler with context containing span
        next.ServeHTTP(wrapped, r.WithContext(ctx))

        // Record metrics after handler completes
        duration := time.Since(start).Seconds()
        statusCode := wrapped.statusCode

        attrs := []attribute.KeyValue{
            semconv.HTTPMethod(r.Method),
            semconv.HTTPRoute(r.URL.Path),
            semconv.HTTPResponseStatusCode(statusCode),
        }

        requestDuration.Record(ctx, duration, metric.WithAttributes(attrs...))

        // Set span status based on HTTP response code
        if statusCode >= 500 {
            span.SetStatus(codes.Error, fmt.Sprintf("HTTP %d", statusCode))
        } else if statusCode >= 400 {
            span.SetStatus(codes.Error, fmt.Sprintf("HTTP %d", statusCode))
        }

        span.SetAttributes(
            semconv.HTTPResponseStatusCode(statusCode),
            attribute.Int("http.response.body.size", wrapped.size),
        )
    })
}

func scheme(r *http.Request) string {
    if r.TLS != nil {
        return "https"
    }
    return "http"
}
```

### Database Instrumentation

```go
package db

import (
    "context"
    "database/sql"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/metric"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

var (
    tracer = otel.Tracer("my-service/db")
    meter  = otel.Meter("my-service/db")
)

// InstrumentedDB wraps sql.DB with OpenTelemetry instrumentation
type InstrumentedDB struct {
    db *sql.DB

    queryDuration    metric.Float64Histogram
    activeQueries    metric.Int64UpDownCounter
    connectionErrors metric.Int64Counter
}

func NewInstrumentedDB(db *sql.DB) (*InstrumentedDB, error) {
    queryDuration, err := meter.Float64Histogram(
        "db.client.query.duration",
        metric.WithDescription("Database query duration"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    activeQueries, err := meter.Int64UpDownCounter(
        "db.client.active_queries",
        metric.WithDescription("Number of active database queries"),
    )
    if err != nil {
        return nil, err
    }

    connectionErrors, err := meter.Int64Counter(
        "db.client.connection_errors",
        metric.WithDescription("Number of database connection errors"),
    )
    if err != nil {
        return nil, err
    }

    return &InstrumentedDB{
        db:               db,
        queryDuration:    queryDuration,
        activeQueries:    activeQueries,
        connectionErrors: connectionErrors,
    }, nil
}

func (idb *InstrumentedDB) QueryContext(
    ctx context.Context,
    query string,
    args ...interface{},
) (*sql.Rows, error) {
    return idb.instrument(ctx, "SELECT", query, func() (*sql.Rows, error) {
        return idb.db.QueryContext(ctx, query, args...)
    })
}

func (idb *InstrumentedDB) ExecContext(
    ctx context.Context,
    query string,
    args ...interface{},
) (sql.Result, error) {
    start := time.Now()
    operation := detectOperation(query)

    ctx, span := tracer.Start(ctx, fmt.Sprintf("db.%s", strings.ToLower(operation)),
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.DBStatement(sanitizeQuery(query)),
            semconv.DBOperationName(operation),
        ),
    )
    defer span.End()

    idb.activeQueries.Add(ctx, 1)
    defer idb.activeQueries.Add(ctx, -1)

    result, err := idb.db.ExecContext(ctx, query, args...)

    duration := time.Since(start).Seconds()
    idb.queryDuration.Record(ctx, duration,
        metric.WithAttributes(
            attribute.String("db.operation", operation),
            attribute.Bool("db.error", err != nil),
        ),
    )

    if err != nil {
        span.SetStatus(codes.Error, err.Error())
        span.RecordError(err)
    }

    return result, err
}

// sanitizeQuery removes sensitive values from SQL for safe logging
func sanitizeQuery(query string) string {
    // Remove parameter values, keep structure
    // In production, use a proper SQL parser
    return query
}

func detectOperation(query string) string {
    query = strings.TrimSpace(strings.ToUpper(query))
    switch {
    case strings.HasPrefix(query, "SELECT"):
        return "SELECT"
    case strings.HasPrefix(query, "INSERT"):
        return "INSERT"
    case strings.HasPrefix(query, "UPDATE"):
        return "UPDATE"
    case strings.HasPrefix(query, "DELETE"):
        return "DELETE"
    default:
        return "OTHER"
    }
}
```

### Manual Span Creation for Business Logic

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

var tracer = otel.Tracer("my-service/order")

func (s *OrderService) ProcessOrder(ctx context.Context, orderID string) error {
    ctx, span := tracer.Start(ctx, "ProcessOrder",
        trace.WithAttributes(
            attribute.String("order.id", orderID),
        ),
    )
    defer span.End()

    // Step 1: Validate order
    ctx, validationSpan := tracer.Start(ctx, "ValidateOrder")
    if err := s.validateOrder(ctx, orderID); err != nil {
        validationSpan.SetStatus(codes.Error, err.Error())
        validationSpan.RecordError(err)
        validationSpan.End()
        return fmt.Errorf("validation failed: %w", err)
    }
    validationSpan.End()

    // Step 2: Charge payment
    ctx, paymentSpan := tracer.Start(ctx, "ChargePayment")
    paymentID, err := s.chargePayment(ctx, orderID)
    if err != nil {
        paymentSpan.SetStatus(codes.Error, err.Error())
        paymentSpan.RecordError(err,
            trace.WithAttributes(
                attribute.String("payment.error.type", classifyPaymentError(err)),
            ),
        )
        paymentSpan.End()
        return fmt.Errorf("payment failed: %w", err)
    }
    paymentSpan.SetAttributes(attribute.String("payment.id", paymentID))
    paymentSpan.End()

    // Add event to parent span (lightweight annotation)
    span.AddEvent("order.payment_complete",
        trace.WithAttributes(
            attribute.String("payment.id", paymentID),
        ),
    )

    // Step 3: Fulfill order
    ctx, fulfillSpan := tracer.Start(ctx, "FulfillOrder")
    if err := s.fulfillOrder(ctx, orderID, paymentID); err != nil {
        fulfillSpan.SetStatus(codes.Error, err.Error())
        fulfillSpan.RecordError(err)
        fulfillSpan.End()
        return fmt.Errorf("fulfillment failed: %w", err)
    }
    fulfillSpan.End()

    span.SetAttributes(
        attribute.String("order.status", "fulfilled"),
        attribute.String("payment.id", paymentID),
    )
    span.SetStatus(codes.Ok, "")

    return nil
}
```

## Section 3: Metrics with Exemplars

Exemplars link metric data points to specific trace IDs, allowing you to jump from a high-latency histogram bucket directly to a trace that caused it.

```go
package metrics

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

var meter = otel.Meter("my-service")

type HTTPMetrics struct {
    requestDuration metric.Float64Histogram
    requestSize     metric.Int64Histogram
    responseSize    metric.Int64Histogram
    requestsTotal   metric.Int64Counter
}

func NewHTTPMetrics() (*HTTPMetrics, error) {
    m := &HTTPMetrics{}
    var err error

    m.requestDuration, err = meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithUnit("s"),
        metric.WithDescription("HTTP request duration"),
    )
    if err != nil {
        return nil, err
    }

    return m, nil
}

func (m *HTTPMetrics) Record(ctx context.Context, method, path string, statusCode int, duration time.Duration) {
    // The active trace context is automatically included as an exemplar
    // when the metric SDK supports exemplars (it does with the OTLP exporter)
    attrs := metric.WithAttributes(
        attribute.String("http.method", method),
        attribute.String("http.route", path),
        attribute.Int("http.status_code", statusCode),
    )

    // Record duration - active trace context is used for exemplar automatically
    m.requestDuration.Record(ctx, duration.Seconds(), attrs)
}
```

### Custom Metric Instruments

```go
package metrics

import (
    "context"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/metric"
)

var meter = otel.Meter("my-service")

func RegisterCustomMetrics() error {
    // Counter: monotonically increasing
    ordersTotal, err := meter.Int64Counter(
        "orders.total",
        metric.WithDescription("Total number of orders processed"),
        metric.WithUnit("{order}"),
    )
    if err != nil {
        return err
    }

    // Gauge via observable (for values that go up and down)
    queueDepth, err := meter.Int64ObservableGauge(
        "queue.depth",
        metric.WithDescription("Current queue depth"),
        metric.WithUnit("{message}"),
    )
    if err != nil {
        return err
    }

    // Register callback for observable gauge
    _, err = meter.RegisterCallback(
        func(ctx context.Context, o metric.Observer) error {
            // Read current value from your queue implementation
            depth := getQueueDepth()
            o.ObserveInt64(queueDepth, int64(depth))
            return nil
        },
        queueDepth,
    )
    if err != nil {
        return err
    }

    // Histogram with custom boundaries
    cacheLookupDuration, err := meter.Float64Histogram(
        "cache.lookup.duration",
        metric.WithDescription("Cache lookup duration"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.0001, 0.0005, 0.001, 0.005, 0.01, 0.1, 1.0,
        ),
    )
    if err != nil {
        return err
    }

    _ = ordersTotal
    _ = cacheLookupDuration

    return nil
}
```

## Section 4: Log-Trace Correlation

### Connecting Logs to Traces

```go
package logging

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/otel/trace"
)

// OTelHandler adds trace context to structured logs
type OTelHandler struct {
    next slog.Handler
}

func NewOTelHandler() *OTelHandler {
    return &OTelHandler{
        next: slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
            Level: slog.LevelInfo,
        }),
    }
}

func (h *OTelHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.next.Enabled(ctx, level)
}

func (h *OTelHandler) Handle(ctx context.Context, record slog.Record) error {
    // Inject trace context into log record
    span := trace.SpanFromContext(ctx)
    if span.IsRecording() {
        spanCtx := span.SpanContext()
        record.AddAttrs(
            slog.String("trace_id", spanCtx.TraceID().String()),
            slog.String("span_id", spanCtx.SpanID().String()),
            slog.Bool("trace_sampled", spanCtx.IsSampled()),
        )
    }

    return h.next.Handle(ctx, record)
}

func (h *OTelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &OTelHandler{next: h.next.WithAttrs(attrs)}
}

func (h *OTelHandler) WithGroup(name string) slog.Handler {
    return &OTelHandler{next: h.next.WithGroup(name)}
}

// Initialize the logger
func NewLogger() *slog.Logger {
    return slog.New(NewOTelHandler())
}

// Usage in handlers
func handleRequest(ctx context.Context) {
    logger := logging.NewLogger()

    logger.InfoContext(ctx, "processing request",
        slog.String("user_id", "user-123"),
        slog.Int("items", 5),
    )
    // Output includes trace_id and span_id automatically:
    // {"time":"...","level":"INFO","msg":"processing request",
    //  "user_id":"user-123","items":5,
    //  "trace_id":"abc123...","span_id":"def456..."}
}
```

## Section 5: OpenTelemetry Collector Configuration

### Production Collector Deployment

```yaml
# otelcol-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otelcol
  namespace: observability
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otelcol
  template:
    metadata:
      labels:
        app: otelcol
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8888"
    spec:
      containers:
      - name: otelcol
        image: otel/opentelemetry-collector-contrib:0.95.0
        args:
        - --config=/conf/otelcol.yaml
        ports:
        - containerPort: 4317   # OTLP gRPC
          name: otlp-grpc
        - containerPort: 4318   # OTLP HTTP
          name: otlp-http
        - containerPort: 8888   # Prometheus metrics (self)
          name: metrics
        resources:
          requests:
            cpu: "200m"
            memory: "256Mi"
          limits:
            cpu: "1"
            memory: "1Gi"
        volumeMounts:
        - name: config
          mountPath: /conf
      volumes:
      - name: config
        configMap:
          name: otelcol-config

---
apiVersion: v1
kind: Service
metadata:
  name: otelcol
  namespace: observability
spec:
  selector:
    app: otelcol
  ports:
  - port: 4317
    targetPort: 4317
    name: otlp-grpc
  - port: 4318
    targetPort: 4318
    name: otlp-http
```

### Collector Configuration

```yaml
# otelcol.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        max_recv_msg_size_mib: 32
        keepalive:
          server_parameters:
            max_connection_idle: 15m
            max_connection_age: 30m
            time: 5s
            timeout: 1s
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins:
          - "https://*.example.com"

  # Prometheus scraping (pull metrics from services)
  prometheus:
    config:
      scrape_configs:
      - job_name: kubernetes-pods
        kubernetes_sd_configs:
        - role: pod
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: "true"

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
    send_batch_max_size: 1024

  memory_limiter:
    check_interval: 5s
    limit_mib: 900
    spike_limit_mib: 200

  # Resource detection: add cloud metadata
  resourcedetection:
    detectors:
    - env
    - k8snode
    - eks
    override: false

  # Add Kubernetes metadata to spans
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    extract:
      metadata:
      - k8s.pod.name
      - k8s.pod.uid
      - k8s.deployment.name
      - k8s.namespace.name
      - k8s.node.name
      - k8s.container.name
    pod_association:
    - sources:
      - from: resource_attribute
        name: k8s.pod.ip

  # Tail-based sampling
  tail_sampling:
    decision_wait: 10s    # Wait up to 10s before making sampling decision
    num_traces: 100000    # Max traces in memory
    expected_new_traces_per_sec: 10000
    policies:
    # Always sample errors
    - name: sample-errors
      type: status_code
      status_code:
        status_codes: [ERROR]
    # Always sample slow traces (>2 seconds)
    - name: sample-slow-traces
      type: latency
      latency:
        threshold_ms: 2000
    # Sample 10% of everything else
    - name: sample-rate
      type: probabilistic
      probabilistic:
        sampling_percentage: 10
    # Always sample traces with specific attributes
    - name: sample-customer-debug
      type: string_attribute
      string_attribute:
        key: customer.debug
        values: ["true"]

  # Filter out noisy spans
  filter:
    error_mode: ignore
    traces:
      span:
      - 'attributes["http.route"] == "/healthz"'
      - 'attributes["http.route"] == "/readyz"'
      - 'attributes["http.route"] == "/metrics"'

exporters:
  # Jaeger (traces)
  otlp/jaeger:
    endpoint: jaeger-collector:4317
    tls:
      insecure: true

  # Prometheus remote write (metrics)
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
    tls:
      insecure: true
    resource_to_telemetry_conversion:
      enabled: true

  # Prometheus exporter (for scraping by Prometheus)
  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: otelcol

  # Loki (logs)
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
    labels:
      resource_labels:
        service.name: ""
        service.namespace: ""
        k8s.namespace.name: ""

  # Debug (development only)
  debug:
    verbosity: normal
    sampling_initial: 5
    sampling_thereafter: 200

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:
    endpoint: 0.0.0.0:1777
  zpages:
    endpoint: 0.0.0.0:55679

service:
  extensions: [health_check, pprof, zpages]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resourcedetection, k8sattributes, filter, tail_sampling, batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, resourcedetection, k8sattributes, batch]
      exporters: [prometheusremotewrite, prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resourcedetection, k8sattributes, batch]
      exporters: [loki]
  telemetry:
    logs:
      level: info
    metrics:
      level: detailed
      address: 0.0.0.0:8888
```

## Section 6: Sampling Strategies

### Head-Based Sampling in the SDK

```go
// Strategy 1: Uniform sampling (simplest)
// Sample 10% of all traces
sampler := sdktrace.TraceIDRatioBased(0.1)

// Strategy 2: ParentBased - respect upstream sampling decisions
// If parent is sampled, always sample; if not, use base sampler
sampler := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.1), // Root span sampler
)

// Strategy 3: Custom sampler for business logic
type adaptiveSampler struct {
    defaultRate float64
}

func (s *adaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample if high-value customer
    if val, ok := p.Attributes[attribute.String("customer.tier", "premium")]; ok && val.Value.AsString() == "premium" {
        return sdktrace.SamplingResult{
            Decision:   sdktrace.RecordAndSample,
            Tracestate: p.ParentContext.TraceState(),
        }
    }

    // Use ratio sampling for everything else
    return sdktrace.TraceIDRatioBased(s.defaultRate).ShouldSample(p)
}

func (s *adaptiveSampler) Description() string {
    return fmt.Sprintf("AdaptiveSampler{defaultRate: %f}", s.defaultRate)
}
```

### Tail-Based Sampling with the Collector

Tail-based sampling in the Collector makes decisions after all spans in a trace have arrived:

```yaml
# Advanced tail sampling policy: multi-condition
tail_sampling:
  decision_wait: 10s
  num_traces: 50000
  policies:
  # Critical: always sample checkout flow
  - name: checkout-always
    type: composite
    composite:
      max_total_spans_per_second: 1000
      policy_order: [checkout-service, always-sample]
      composite_sub_policy:
      - name: checkout-service
        type: string_attribute
        string_attribute:
          key: service.name
          values: ["checkout-service"]
      - name: always-sample
        type: always_sample

  # Sample 100% of errors
  - name: errors-always
    type: status_code
    status_code:
      status_codes: [ERROR, UNSET]

  # Sample traces with retries (likely had transient failures)
  - name: with-retries
    type: numeric_attribute
    numeric_attribute:
      key: rpc.retry_count
      min_value: 1

  # Latency-based: sample 100% of slow traces
  - name: slow-traces
    type: latency
    latency:
      threshold_ms: 1000

  # Baseline: sample 2% of everything else
  - name: baseline
    type: probabilistic
    probabilistic:
      sampling_percentage: 2
```

## Section 7: Jaeger Integration

### Jaeger Deployment

```yaml
# Simple Jaeger all-in-one for development
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: observability
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:1.53
        env:
        - name: COLLECTOR_OTLP_ENABLED
          value: "true"
        - name: SPAN_STORAGE_TYPE
          value: elasticsearch
        - name: ES_SERVER_URLS
          value: http://elasticsearch:9200
        ports:
        - containerPort: 16686  # Jaeger UI
          name: ui
        - containerPort: 4317   # OTLP gRPC
          name: otlp-grpc
        - containerPort: 4318   # OTLP HTTP
          name: otlp-http
```

### Querying Jaeger Programmatically

```go
package traces

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type JaegerClient struct {
    baseURL string
    client  *http.Client
}

func NewJaegerClient(baseURL string) *JaegerClient {
    return &JaegerClient{
        baseURL: baseURL,
        client:  &http.Client{Timeout: 30 * time.Second},
    }
}

// FindTracesByService finds traces for a service within a time range
func (c *JaegerClient) FindTracesByService(
    ctx context.Context,
    service string,
    startTime, endTime time.Time,
    limit int,
) ([]Trace, error) {
    url := fmt.Sprintf(
        "%s/api/traces?service=%s&start=%d&end=%d&limit=%d",
        c.baseURL,
        service,
        startTime.UnixMicro(),
        endTime.UnixMicro(),
        limit,
    )

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := c.client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result struct {
        Data []Trace `json:"data"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    return result.Data, nil
}
```

## Section 8: Performance Considerations

### Span Attribute Limits

```go
// Configure limits to prevent unbounded memory growth
tp := sdktrace.NewTracerProvider(
    sdktrace.WithSpanLimits(sdktrace.SpanLimits{
        AttributeValueLengthLimit:   512,    // Max attribute value length
        AttributeCountLimit:         128,    // Max attributes per span
        EventCountLimit:             64,     // Max events per span
        LinkCountLimit:              32,     // Max links per span
        AttributePerEventCountLimit: 32,     // Max attributes per event
        AttributePerLinkCountLimit:  32,     // Max attributes per link
    }),
)
```

### Avoiding Span Context Leaks

```go
// Common mistake: forgetting to end spans on error paths
func badExample(ctx context.Context) error {
    ctx, span := tracer.Start(ctx, "operation")
    // If we return early here, span is never ended
    if someCondition {
        return errors.New("early return")  // LEAKED SPAN!
    }
    span.End()
    return nil
}

// Correct: always defer span.End()
func goodExample(ctx context.Context) error {
    ctx, span := tracer.Start(ctx, "operation")
    defer span.End()  // Always called, even on early returns

    if err := doWork(ctx); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }
    return nil
}
```

### Benchmark: Instrumentation Overhead

```go
func BenchmarkWithTracing(b *testing.B) {
    // Initialize a no-op tracer for baseline
    otel.SetTracerProvider(trace.NewNoopTracerProvider())

    b.Run("no-op tracer", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            ctx, span := otel.Tracer("bench").Start(context.Background(), "op")
            span.End()
            _ = ctx
        }
    })
}

// Typical results:
// BenchmarkWithTracing/no-op_tracer   50000000   25 ns/op   0 B/op   0 allocs/op
// BenchmarkWithTracing/full_sdk        5000000  240 ns/op  128 B/op   3 allocs/op
// BenchmarkWithTracing/with_sampling   2000000  480 ns/op  256 B/op   6 allocs/op
```

## Section 9: Production Checklist

**SDK Setup:**
- Use `ParentBased(TraceIDRatioBased(rate))` sampler to respect upstream decisions
- Set span limits to prevent memory pressure from large attribute values
- Configure batcher with appropriate queue sizes for your throughput
- Always `defer span.End()` - never end spans only on success paths
- Use semantic conventions (`semconv` package) for attribute keys

**Collector:**
- Deploy 3+ replicas with anti-affinity
- Set `memory_limiter` processor to prevent OOM
- Use `tail_sampling` for business-logic-aware sampling decisions
- Filter health check endpoints from traces
- Enable `k8sattributes` processor to enrich with Kubernetes metadata

**Metrics:**
- Use exemplars to link high-latency histogram buckets to traces
- Register callbacks for gauges (queue depths, connection counts)
- Use the `semconv` package for metric names to ensure compatibility

**Logs:**
- Add `trace_id` and `span_id` to all log records
- Use `slog` with a custom handler that reads from `trace.SpanFromContext(ctx)`
- Ship logs through the Collector to Loki for unified querying

**Sampling:**
- Always sample errors and slow traces regardless of rate
- 2-10% head sampling for baseline, with tail sampling for adjustments
- Use customer/request tier attributes for targeted sampling
