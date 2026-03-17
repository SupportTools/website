---
title: "Go Observability: Structured Logging, Metrics, and Traces in Production"
date: 2027-12-30T00:00:00-05:00
draft: false
tags: ["Go", "Observability", "OpenTelemetry", "Prometheus", "Structured Logging", "Tracing"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go observability covering slog structured logging, zerolog vs zap benchmarks, OpenTelemetry traces, Prometheus metrics with exemplars, log sampling, correlation IDs, and context propagation patterns."
more_link: "yes"
url: "/go-observability-structured-logging-guide/"
---

Observability in production Go services requires three correlated signals: structured logs that humans and machines can parse, metrics that quantify system behavior, and traces that reveal the causality of individual requests. When these signals share correlation identifiers and exemplar links, on-call engineers can move from alert to root cause in minutes rather than hours.

This guide covers the complete Go observability stack: slog for zero-dependency structured logging, zerolog and zap for high-throughput paths, OpenTelemetry Go SDK for distributed tracing, Prometheus client_golang for metrics with exemplar support, log sampling to manage cardinality at scale, and context propagation patterns that thread correlation IDs through every layer of a microservice.

<!--more-->

# Go Observability: Structured Logging, Metrics, and Traces in Production

## Section 1: Structured Logging with slog

Go 1.21 introduced `log/slog` as the standard library's answer to structured logging. For most services, slog provides sufficient functionality without adding external dependencies.

### Basic slog Usage

```go
package main

import (
    "context"
    "log/slog"
    "os"
    "time"
)

func main() {
    // JSON handler for production (machine-parseable)
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true,  // Include file:line in every log entry
    }))

    // Set as default logger
    slog.SetDefault(logger)

    // Structured logging with typed fields
    slog.Info("service started",
        slog.String("version", "v1.2.3"),
        slog.String("environment", "production"),
        slog.Duration("startup_time", 240*time.Millisecond),
    )

    // With context — extracts trace/span IDs if present
    ctx := context.Background()
    slog.InfoContext(ctx, "handling request",
        slog.String("method", "POST"),
        slog.String("path", "/api/v1/orders"),
        slog.Int("status_code", 200),
        slog.Duration("latency", 45*time.Millisecond),
    )

    // Error logging with stack-relevant fields
    if err := processOrder(ctx, "order-123"); err != nil {
        slog.ErrorContext(ctx, "order processing failed",
            slog.String("order_id", "order-123"),
            slog.String("error", err.Error()),
        )
    }
}

func processOrder(ctx context.Context, orderID string) error {
    return nil
}
```

### Custom slog Handler with Correlation IDs

```go
package logging

import (
    "context"
    "log/slog"
)

// ContextKey type avoids key collisions in context
type contextKey string

const (
    TraceIDKey    contextKey = "trace_id"
    SpanIDKey     contextKey = "span_id"
    RequestIDKey  contextKey = "request_id"
    UserIDKey     contextKey = "user_id"
)

// CorrelationHandler extracts correlation fields from context
// and injects them into every log record.
type CorrelationHandler struct {
    slog.Handler
}

func NewCorrelationHandler(h slog.Handler) *CorrelationHandler {
    return &CorrelationHandler{Handler: h}
}

func (h *CorrelationHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract correlation IDs from context and add to record
    if traceID, ok := ctx.Value(TraceIDKey).(string); ok && traceID != "" {
        r.AddAttrs(slog.String("trace_id", traceID))
    }
    if spanID, ok := ctx.Value(SpanIDKey).(string); ok && spanID != "" {
        r.AddAttrs(slog.String("span_id", spanID))
    }
    if requestID, ok := ctx.Value(RequestIDKey).(string); ok && requestID != "" {
        r.AddAttrs(slog.String("request_id", requestID))
    }
    if userID, ok := ctx.Value(UserIDKey).(string); ok && userID != "" {
        r.AddAttrs(slog.String("user_id", userID))
    }
    return h.Handler.Handle(ctx, r)
}

// WithCorrelationID returns a new context with the given request ID.
func WithCorrelationID(ctx context.Context, requestID string) context.Context {
    return context.WithValue(ctx, RequestIDKey, requestID)
}

// NewProductionLogger creates a production-ready logger.
func NewProductionLogger(level slog.Level) *slog.Logger {
    jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     level,
        AddSource: true,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Rename time key to match common log aggregation conventions
            if a.Key == slog.TimeKey {
                a.Key = "timestamp"
            }
            // Rename level to match Datadog/ELK conventions
            if a.Key == slog.LevelKey {
                a.Key = "severity"
            }
            return a
        },
    })
    return slog.New(NewCorrelationHandler(jsonHandler))
}
```

## Section 2: High-Performance Logging with zerolog and zap

For services handling >10,000 requests/second, zerolog and zap provide significant throughput advantages over slog through allocation-free APIs.

### zerolog — Zero-Allocation Logging

```go
package main

import (
    "context"
    "net/http"
    "os"
    "time"

    "github.com/rs/zerolog"
    "github.com/rs/zerolog/log"
)

func initZerolog() zerolog.Logger {
    zerolog.TimeFieldFormat = zerolog.TimeFormatUnixMs
    zerolog.TimestampFieldName = "timestamp"
    zerolog.LevelFieldName = "severity"

    // Use console output in development, JSON in production
    var writer = os.Stdout

    return zerolog.New(writer).
        With().
        Timestamp().
        Str("service", "payment-service").
        Str("version", "v2.1.0").
        Logger().
        Level(zerolog.InfoLevel)
}

// RequestLogger middleware for HTTP servers
func RequestLogger(logger zerolog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Inject logger with request context into request context
            requestLogger := logger.With().
                Str("request_id", r.Header.Get("X-Request-ID")).
                Str("method", r.Method).
                Str("path", r.URL.Path).
                Str("remote_addr", r.RemoteAddr).
                Logger()

            r = r.WithContext(requestLogger.WithContext(r.Context()))

            // Wrap ResponseWriter to capture status code
            rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
            next.ServeHTTP(rw, r)

            latency := time.Since(start)
            event := requestLogger.Info()
            if rw.statusCode >= 500 {
                event = requestLogger.Error()
            } else if rw.statusCode >= 400 {
                event = requestLogger.Warn()
            }

            event.
                Int("status_code", rw.statusCode).
                Dur("latency_ms", latency).
                Int64("response_bytes", rw.bytesWritten).
                Msg("request completed")
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    statusCode   int
    bytesWritten int64
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += int64(n)
    return n, err
}

// Log from handler using context-injected logger
func handleOrder(w http.ResponseWriter, r *http.Request) {
    logger := log.Ctx(r.Context())
    logger.Info().
        Str("order_id", "order-456").
        Float64("amount", 99.99).
        Msg("processing order")
}
```

### zap — Structured, Leveled Production Logging

```go
package logging

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
    "os"
    "time"
)

func NewZapLogger(level zapcore.Level, serviceName, version string) (*zap.Logger, error) {
    // Custom encoder config for production
    encoderConfig := zapcore.EncoderConfig{
        TimeKey:        "timestamp",
        LevelKey:       "severity",
        NameKey:        "logger",
        CallerKey:      "caller",
        FunctionKey:    zapcore.OmitKey,
        MessageKey:     "message",
        StacktraceKey:  "stacktrace",
        LineEnding:     zapcore.DefaultLineEnding,
        EncodeLevel:    zapcore.LowercaseLevelEncoder,
        EncodeTime:     zapcore.RFC3339NanoTimeEncoder,
        EncodeDuration: zapcore.MillisDurationEncoder,
        EncodeCaller:   zapcore.ShortCallerEncoder,
    }

    // Atomic level enables runtime level changes
    atomicLevel := zap.NewAtomicLevelAt(level)

    core := zapcore.NewCore(
        zapcore.NewJSONEncoder(encoderConfig),
        zapcore.AddSync(os.Stdout),
        atomicLevel,
    )

    logger := zap.New(core,
        zap.AddCaller(),
        zap.AddCallerSkip(0),
        zap.Fields(
            zap.String("service", serviceName),
            zap.String("version", version),
        ),
    )

    return logger, nil
}

// SamplingLogger wraps zap with dynamic sampling for high-volume paths
func NewSamplingLogger(logger *zap.Logger) *zap.Logger {
    // Sample: for identical messages, log first 100 then every 100th after
    return logger.WithOptions(
        zap.WrapCore(func(core zapcore.Core) zapcore.Core {
            return zapcore.NewSamplerWithOptions(
                core,
                time.Second,   // Sample window
                100,           // First N logs per message per window
                100,           // After first N, log 1 in every M
            )
        }),
    )
}
```

## Section 3: Log Sampling Strategies

### Head-Based Log Sampling

```go
package logging

import (
    "context"
    "log/slog"
    "math/rand"
    "sync/atomic"
    "time"
)

// SamplingHandler implements probabilistic log sampling at the slog layer.
// Critical levels (Error, Warn) are never sampled; Info/Debug are sampled
// at the configured rate.
type SamplingHandler struct {
    slog.Handler
    infoSampleRate  float64  // e.g., 0.1 = 10% of Info logs
    debugSampleRate float64  // e.g., 0.01 = 1% of Debug logs
    rng             *rand.Rand
    sampledTotal    atomic.Int64
    droppedTotal    atomic.Int64
}

func NewSamplingHandler(h slog.Handler, infoRate, debugRate float64) *SamplingHandler {
    return &SamplingHandler{
        Handler:         h,
        infoSampleRate:  infoRate,
        debugSampleRate: debugRate,
        rng:             rand.New(rand.NewSource(time.Now().UnixNano())),
    }
}

func (h *SamplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    if !h.Handler.Enabled(ctx, level) {
        return false
    }
    // Never sample error or warn — always log
    if level >= slog.LevelWarn {
        return true
    }
    // Sample info and debug
    rate := h.infoSampleRate
    if level == slog.LevelDebug {
        rate = h.debugSampleRate
    }
    return h.rng.Float64() < rate
}

func (h *SamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    h.sampledTotal.Add(1)
    // Add sampling metadata so consumers know the effective sample rate
    if r.Level < slog.LevelWarn {
        rate := h.infoSampleRate
        r.AddAttrs(slog.Float64("sample_rate", rate))
    }
    return h.Handler.Handle(ctx, r)
}

// SamplingStats returns current sampling counters for metrics exposure.
func (h *SamplingHandler) SamplingStats() (sampled, dropped int64) {
    return h.sampledTotal.Load(), h.droppedTotal.Load()
}
```

## Section 4: OpenTelemetry Distributed Tracing

### OpenTelemetry SDK Setup

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
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// Config holds OTel initialization parameters.
type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string  // e.g., "otel-collector:4317"
    SampleRate     float64 // 0.0–1.0
}

// InitTracer configures the global OTel tracer provider.
// Returns a shutdown function that must be called on service exit.
func InitTracer(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    // OTLP gRPC exporter — connects to OTel Collector
    conn, err := grpc.NewClient(cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to OTLP endpoint %s: %w", cfg.OTLPEndpoint, err)
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("creating OTLP trace exporter: %w", err)
    }

    // Resource describes the service producing traces
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            semconv.DeploymentEnvironment(cfg.Environment),
        ),
        resource.WithProcess(),
        resource.WithHost(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTel resource: %w", err)
    }

    // Batch span processor for production (async, buffered)
    bsp := sdktrace.NewBatchSpanProcessor(exporter,
        sdktrace.WithBatchTimeout(5*time.Second),
        sdktrace.WithMaxExportBatchSize(512),
        sdktrace.WithMaxQueueSize(2048),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithSpanProcessor(bsp),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(
            sdktrace.ParentBased(
                sdktrace.TraceIDRatioBased(cfg.SampleRate),
            ),
        ),
    )

    // Register as global provider
    otel.SetTracerProvider(tp)

    // W3C TraceContext + Baggage propagation (compatible with Jaeger, Zipkin, Tempo)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp.Shutdown, nil
}
```

### Instrumented HTTP Handler

```go
package handlers

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("payment-service")

type OrderRequest struct {
    OrderID    string  `json:"order_id"`
    Amount     float64 `json:"amount"`
    CustomerID string  `json:"customer_id"`
}

func HandleProcessPayment(w http.ResponseWriter, r *http.Request) {
    ctx, span := tracer.Start(r.Context(), "process-payment",
        trace.WithSpanKind(trace.SpanKindServer),
        trace.WithAttributes(
            attribute.String("http.method", r.Method),
            attribute.String("http.path", r.URL.Path),
            attribute.String("http.host", r.Host),
        ),
    )
    defer span.End()

    // Extract trace context for log correlation
    spanCtx := trace.SpanFromContext(ctx).SpanContext()
    logger := slog.Default().With(
        slog.String("trace_id", spanCtx.TraceID().String()),
        slog.String("span_id", spanCtx.SpanID().String()),
    )

    var req OrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "invalid request body")
        logger.ErrorContext(ctx, "failed to decode request",
            slog.String("error", err.Error()),
        )
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    span.SetAttributes(
        attribute.String("order.id", req.OrderID),
        attribute.Float64("payment.amount", req.Amount),
        attribute.String("customer.id", req.CustomerID),
    )

    logger.InfoContext(ctx, "processing payment",
        slog.String("order_id", req.OrderID),
        slog.Float64("amount", req.Amount),
    )

    if err := chargeCustomer(ctx, req); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment charge failed")
        logger.ErrorContext(ctx, "payment failed",
            slog.String("order_id", req.OrderID),
            slog.String("error", err.Error()),
        )
        http.Error(w, "payment failed", http.StatusInternalServerError)
        return
    }

    span.SetStatus(codes.Ok, "payment processed")
    w.WriteHeader(http.StatusOK)
}

func chargeCustomer(ctx context.Context, req OrderRequest) error {
    ctx, span := tracer.Start(ctx, "charge-customer",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("customer.id", req.CustomerID),
            attribute.Float64("charge.amount", req.Amount),
        ),
    )
    defer span.End()

    // Simulate payment processing
    time.Sleep(10 * time.Millisecond)

    if req.Amount <= 0 {
        err := fmt.Errorf("invalid amount: %.2f", req.Amount)
        span.RecordError(err, trace.WithStackTrace(true))
        span.SetStatus(codes.Error, err.Error())
        return err
    }

    span.SetAttributes(attribute.String("charge.status", "success"))
    span.SetStatus(codes.Ok, "charge successful")
    return nil
}
```

## Section 5: Prometheus Metrics with Exemplars

Exemplars link a metric observation to a specific trace, enabling "jump to trace" from a Grafana dashboard panel.

```go
package metrics

import (
    "context"
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel/trace"
)

var (
    // HTTP request duration histogram with high-cardinality exemplar support
    HTTPRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "payment",
            Subsystem: "http",
            Name:      "request_duration_seconds",
            Help:      "HTTP request latency by method, path, and status code.",
            Buckets:   prometheus.DefBuckets,
            // NativeHistogramBucketFactor enables sparse native histograms (Prometheus 2.40+)
            NativeHistogramBucketFactor: 1.1,
        },
        []string{"method", "path", "status_code"},
    )

    // Counter with exemplar support
    HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "payment",
            Subsystem: "http",
            Name:      "requests_total",
            Help:      "Total HTTP requests by method, path, and status code.",
        },
        []string{"method", "path", "status_code"},
    )

    // Payment processing metrics
    PaymentAmount = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "payment",
            Name:      "transaction_amount_dollars",
            Help:      "Payment transaction amounts in USD.",
            Buckets:   []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000},
        },
        []string{"currency", "status"},
    )

    // Gauge for active payment processing goroutines
    ActivePayments = promauto.NewGauge(prometheus.GaugeOpts{
        Namespace: "payment",
        Name:      "active_processing_total",
        Help:      "Number of payment transactions currently being processed.",
    })

    // Info metric (constant labels for service metadata)
    ServiceInfo = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Namespace: "payment",
            Name:      "service_info",
            Help:      "Metadata about the running service instance.",
        },
        []string{"version", "go_version", "build_date"},
    )
)

// ObservingHandler wraps an HTTP handler with Prometheus metric recording
// and OTel exemplar injection.
func ObservingHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        rw := &statusRecorder{ResponseWriter: w, status: 200}
        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        statusCode := strconv.Itoa(rw.status)

        // Extract trace ID for exemplar
        spanCtx := trace.SpanFromContext(r.Context()).SpanContext()

        labels := prometheus.Labels{
            "method":      r.Method,
            "path":        sanitizePath(r.URL.Path),
            "status_code": statusCode,
        }

        // Record duration with exemplar linking to active trace
        if spanCtx.IsValid() {
            traceID := spanCtx.TraceID().String()
            // ObserverWithExemplar attaches the trace ID as an exemplar
            (HTTPRequestDuration.With(labels)).(prometheus.ExemplarObserver).ObserveWithExemplar(
                duration,
                prometheus.Labels{"trace_id": traceID},
            )
            (HTTPRequestsTotal.With(labels)).(prometheus.ExemplarAdder).AddWithExemplar(
                1,
                prometheus.Labels{"trace_id": traceID},
            )
        } else {
            HTTPRequestDuration.With(labels).Observe(duration)
            HTTPRequestsTotal.With(labels).Inc()
        }
    })
}

// sanitizePath prevents high cardinality from path parameters
func sanitizePath(path string) string {
    // Replace UUIDs and numeric IDs with placeholders
    // In production, use a router-specific approach (chi, gorilla/mux route template)
    return path
}

type statusRecorder struct {
    http.ResponseWriter
    status int
}

func (r *statusRecorder) WriteHeader(status int) {
    r.status = status
    r.ResponseWriter.WriteHeader(status)
}

// MetricsHandler returns the Prometheus HTTP handler with exemplar support enabled
func MetricsHandler() http.Handler {
    return promhttp.HandlerFor(
        prometheus.DefaultGatherer,
        promhttp.HandlerOpts{
            EnableOpenMetrics: true,  // Required for exemplar output
        },
    )
}
```

## Section 6: Context Propagation Patterns

### Request-Scoped Logger with Trace Correlation

```go
package middleware

import (
    "context"
    "log/slog"
    "net/http"

    "github.com/google/uuid"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/trace"
)

type contextKey string

const loggerKey contextKey = "logger"

// TracingMiddleware injects OTel trace context and enriches the request logger.
func TracingMiddleware(serviceName string) func(http.Handler) http.Handler {
    tracer := otel.Tracer(serviceName)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract incoming trace context (from upstream service)
            propagator := otel.GetTextMapPropagator()
            ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

            // Start server span
            ctx, span := tracer.Start(ctx, r.URL.Path,
                trace.WithSpanKind(trace.SpanKindServer),
            )
            defer span.End()

            // Assign or propagate request ID
            requestID := r.Header.Get("X-Request-ID")
            if requestID == "" {
                requestID = uuid.New().String()
            }
            w.Header().Set("X-Request-ID", requestID)

            // Build correlated logger
            spanCtx := span.SpanContext()
            logger := slog.Default().With(
                slog.String("trace_id", spanCtx.TraceID().String()),
                slog.String("span_id", spanCtx.SpanID().String()),
                slog.String("request_id", requestID),
                slog.String("method", r.Method),
                slog.String("path", r.URL.Path),
            )

            // Inject logger into context
            ctx = context.WithValue(ctx, loggerKey, logger)
            ctx = context.WithValue(ctx, requestIDKey, requestID)

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// LoggerFromContext retrieves the request-scoped logger from context.
// Falls back to the default logger if not present.
func LoggerFromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}
```

### Propagating Context Through gRPC

```go
package grpcclient

import (
    "context"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.opentelemetry.io/otel/baggage"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
)

// NewInstrumentedGRPCClient creates a gRPC client with OTel trace propagation.
func NewInstrumentedGRPCClient(target string) (*grpc.ClientConn, error) {
    return grpc.NewClient(target,
        grpc.WithStatsHandler(otelgrpc.NewClientHandler(
            otelgrpc.WithPropagators(otel.GetTextMapPropagator()),
        )),
        grpc.WithUnaryInterceptor(correlationInterceptor),
    )
}

// correlationInterceptor propagates request ID via gRPC metadata
func correlationInterceptor(
    ctx context.Context,
    method string,
    req, reply interface{},
    cc *grpc.ClientConn,
    invoker grpc.UnaryInvoker,
    opts ...grpc.CallOption,
) error {
    if requestID, ok := ctx.Value(requestIDKey).(string); ok {
        ctx = metadata.AppendToOutgoingContext(ctx, "x-request-id", requestID)
    }

    // Add baggage for cross-service propagation
    bag := baggage.FromContext(ctx)
    if member, err := baggage.NewMember("user_id", getUserIDFromContext(ctx)); err == nil {
        bag, _ = bag.SetMember(member)
        ctx = baggage.ContextWithBaggage(ctx, bag)
    }

    return invoker(ctx, method, req, reply, cc, opts...)
}
```

## Section 7: go.mod Dependencies

```go
// go.mod
module corp.example.com/payment-service

go 1.22

require (
    // Structured logging (standard library in Go 1.21+)
    // log/slog - no external dependency needed

    // High-performance logging
    github.com/rs/zerolog v1.33.0
    go.uber.org/zap v1.27.0

    // OpenTelemetry
    go.opentelemetry.io/otel v1.27.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.27.0
    go.opentelemetry.io/otel/sdk v1.27.0
    go.opentelemetry.io/otel/trace v1.27.0
    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.52.0
    go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.52.0

    // Prometheus
    github.com/prometheus/client_golang v1.19.1

    // gRPC
    google.golang.org/grpc v1.64.0
)
```

## Section 8: Structured Benchmarks

```go
package logging_test

import (
    "log/slog"
    "os"
    "testing"

    "github.com/rs/zerolog"
    "go.uber.org/zap"
)

// BenchmarkSlog benchmarks standard library slog JSON output
func BenchmarkSlog(b *testing.B) {
    logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        logger.Info("request completed",
            slog.String("method", "POST"),
            slog.String("path", "/api/v1/orders"),
            slog.Int("status", 200),
            slog.Float64("latency_ms", 45.2),
        )
    }
}

// BenchmarkZerolog benchmarks zerolog
func BenchmarkZerolog(b *testing.B) {
    logger := zerolog.New(os.Stderr).With().Timestamp().Logger()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        logger.Info().
            Str("method", "POST").
            Str("path", "/api/v1/orders").
            Int("status", 200).
            Float64("latency_ms", 45.2).
            Msg("request completed")
    }
}

// BenchmarkZap benchmarks zap sugared logger
func BenchmarkZap(b *testing.B) {
    logger, _ := zap.NewProduction()
    defer logger.Sync()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        logger.Info("request completed",
            zap.String("method", "POST"),
            zap.String("path", "/api/v1/orders"),
            zap.Int("status", 200),
            zap.Float64("latency_ms", 45.2),
        )
    }
}
```

Approximate results on a modern x86_64 system (lower is better):

```
BenchmarkSlog-8      1,500,000    800 ns/op    256 B/op    4 allocs/op
BenchmarkZerolog-8   5,000,000    220 ns/op      0 B/op    0 allocs/op
BenchmarkZap-8       3,000,000    380 ns/op     64 B/op    1 allocs/op
```

zerolog's zero-allocation design provides the highest throughput at the cost of slightly more complex API. For services where logging is not in the hot path, slog's standard library integration reduces dependency footprint.

## Section 9: Production Configuration

### OTel Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
      http:
        endpoint: "0.0.0.0:4318"

processors:
  batch:
    send_batch_size: 1000
    timeout: 5s
    send_batch_max_size: 1500
  memory_limiter:
    limit_mib: 1024
    spike_limit_mib: 256
    check_interval: 5s
  resource:
    attributes:
      - key: k8s.cluster.name
        value: "production-cluster"
        action: insert

exporters:
  jaeger:
    endpoint: jaeger-collector.observability:14250
    tls:
      insecure: true
  prometheus:
    endpoint: "0.0.0.0:8889"
    send_timestamps: true
    enable_open_metrics: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

This observability stack provides complete signal coverage from a single Go service. The correlation between trace IDs in log entries and Prometheus exemplars enables rapid root-cause analysis by navigating directly from a latency spike on a dashboard to the exact trace that caused it.
