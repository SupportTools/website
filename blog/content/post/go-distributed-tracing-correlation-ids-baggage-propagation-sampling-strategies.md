---
title: "Go: Distributed Tracing with Correlation IDs, Baggage Propagation, and Trace Sampling Strategies"
date: 2031-07-25T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Tracing", "OpenTelemetry", "Observability", "Jaeger", "Sampling"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing distributed tracing in Go with OpenTelemetry covering correlation ID propagation, baggage for cross-service context, trace sampling strategies including tail-based sampling, and integration with Jaeger and Grafana Tempo."
more_link: "yes"
url: "/go-distributed-tracing-correlation-ids-baggage-propagation-sampling-strategies/"
---

Distributed tracing is the observability practice that connects individual operations across multiple services into a single view of a request's journey through your system. Without it, debugging a slow API call that touches six downstream services means correlating logs across six different log streams with no guaranteed common identifier. With proper tracing, you get a waterfall view of every span, with latency, errors, and context propagated automatically. This guide implements a complete, production-ready distributed tracing setup in Go using OpenTelemetry.

<!--more-->

# Go: Distributed Tracing with Correlation IDs, Baggage Propagation, and Trace Sampling Strategies

## Core Concepts

Before implementation, ensure these concepts are solid:

**Trace**: The complete journey of a single request through the system. Identified by a globally unique `trace_id`.

**Span**: A named, timed unit of work within a trace. A span has a start time, duration, parent span ID, and a set of attributes. The first span in a trace has no parent and is the root span.

**Context propagation**: The mechanism by which trace context (trace_id, parent span_id) is transmitted from one service to another via HTTP headers, gRPC metadata, or message queue headers.

**Baggage**: Key-value pairs attached to the trace context that propagate with the trace. Unlike span attributes, baggage is visible to all downstream services in the trace — use it for data that downstream services need to act on (e.g., `user.id`, `feature.flag`).

**Correlation ID**: A simpler concept — a single ID that connects related log entries. Often the `trace_id` serves this purpose, but in practice, many systems have pre-existing correlation ID schemes (e.g., `X-Request-ID`) that need to be bridged with OpenTelemetry trace IDs.

## OpenTelemetry Architecture in Go

```
┌──────────────────────────────────────────────────────────┐
│  Your Go Service                                          │
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Application Code                                  │  │
│  │  - Start/End spans                                 │  │
│  │  - Set attributes                                  │  │
│  │  - Set baggage                                     │  │
│  └──────────────────┬────────────────────────────────┘  │
│                     │ otel.Tracer                        │
│  ┌──────────────────▼────────────────────────────────┐  │
│  │  SDK (TracerProvider)                              │  │
│  │  - Span processor (batch/simple)                  │  │
│  │  - Sampler (head-based / always / ratio)          │  │
│  │  - Resource (service name, version, host)         │  │
│  └──────────────────┬────────────────────────────────┘  │
│                     │ SpanExporter                       │
│  ┌──────────────────▼────────────────────────────────┐  │
│  │  Exporter                                          │  │
│  │  - OTLP gRPC/HTTP → OpenTelemetry Collector       │  │
│  │  - Jaeger Thrift (legacy)                         │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         │
         ▼ OTLP
┌────────────────────┐
│ OTel Collector     │──▶ Jaeger
│ (pipeline)         │──▶ Grafana Tempo
│                    │──▶ Cloud Trace
└────────────────────┘
```

## Dependencies and Module Setup

```bash
go mod init github.com/yourorg/tracing-example

go get go.opentelemetry.io/otel@v1.32.0
go get go.opentelemetry.io/otel/sdk@v1.32.0
go get go.opentelemetry.io/otel/trace@v1.32.0
go get go.opentelemetry.io/otel/baggage@v1.32.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.32.0
go get go.opentelemetry.io/otel/propagation@v1.32.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.57.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.57.0
go get google.golang.org/grpc@v1.68.0
```

## TracerProvider Initialization

```go
// internal/tracing/provider.go
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
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds tracing configuration.
type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string // e.g., "otel-collector:4317"
	SampleRate     float64 // 0.0-1.0, or -1 for always
	Insecure       bool
}

// ShutdownFunc should be called to flush and close the TracerProvider.
type ShutdownFunc func(context.Context) error

// InitTracing sets up the global TracerProvider and propagators.
// Returns a shutdown function that must be called on service shutdown.
func InitTracing(ctx context.Context, cfg Config, log *zap.Logger) (ShutdownFunc, error) {
	// Build the resource describing this service
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
		resource.WithFromEnv(),   // OTEL_RESOURCE_ATTRIBUTES env var
		resource.WithProcess(),   // PID, command name
		resource.WithHost(),      // hostname
		resource.WithContainer(), // container ID if running in Docker/Kubernetes
	)
	if err != nil {
		return nil, fmt.Errorf("build resource: %w", err)
	}

	// Create the OTLP gRPC exporter
	dialOpts := []grpc.DialOption{
		grpc.WithBlock(),
	}
	if cfg.Insecure {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}

	exporterCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	exporter, err := otlptracegrpc.New(exporterCtx,
		otlptracegrpc.WithEndpoint(cfg.OTLPEndpoint),
		otlptracegrpc.WithDialOption(dialOpts...),
	)
	if err != nil {
		return nil, fmt.Errorf("create OTLP exporter: %w", err)
	}

	// Configure sampler based on SampleRate
	var sampler sdktrace.Sampler
	switch {
	case cfg.SampleRate < 0:
		sampler = sdktrace.AlwaysSample()
	case cfg.SampleRate == 0:
		sampler = sdktrace.NeverSample()
	default:
		// Parent-based: respect parent's sampling decision if present,
		// otherwise use the configured ratio
		sampler = sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(cfg.SampleRate),
		)
	}

	// Build the TracerProvider
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithBatcher(exporter,
			sdktrace.WithBatchTimeout(5*time.Second),
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithMaxQueueSize(2048),
		),
		sdktrace.WithResource(res),
	)

	// Set global TracerProvider and propagators
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		// W3C TraceContext (standard)
		propagation.TraceContext{},
		// W3C Baggage (standard baggage propagation)
		propagation.Baggage{},
		// B3 (Zipkin-style, for legacy services)
		// b3.New(b3.WithInjectEncoding(b3.B3MultipleHeader)),
	))

	log.Info("distributed tracing initialized",
		zap.String("service", cfg.ServiceName),
		zap.String("endpoint", cfg.OTLPEndpoint),
		zap.Float64("sample_rate", cfg.SampleRate),
	)

	return tp.Shutdown, nil
}
```

## Correlation ID Middleware

Many systems have pre-existing `X-Request-ID` or `X-Correlation-ID` headers. Bridge these with OpenTelemetry trace IDs:

```go
// internal/middleware/correlation.go
package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

const (
	// CorrelationIDHeader is the HTTP header name for correlation IDs.
	CorrelationIDHeader = "X-Correlation-ID"
	// RequestIDHeader is an alternative header used by some API gateways.
	RequestIDHeader = "X-Request-ID"
	// TraceIDHeader is the W3C traceparent header (set automatically by otelhttp).
	TraceIDHeader = "Traceparent"

	// BaggageCorrelationID is the baggage key for the correlation ID.
	BaggageCorrelationID = "correlation.id"
)

// CorrelationIDKey is the context key for the correlation ID.
type correlationIDKey struct{}

// CorrelationID extracts the correlation ID from a context set by the middleware.
func CorrelationID(ctx context.Context) string {
	if v, ok := ctx.Value(correlationIDKey{}).(string); ok {
		return v
	}
	return ""
}

// CorrelationMiddleware ensures every request has a correlation ID and
// injects it into the OpenTelemetry baggage and span attributes.
func CorrelationMiddleware(log *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			// 1. Extract or generate correlation ID
			correlationID := r.Header.Get(CorrelationIDHeader)
			if correlationID == "" {
				correlationID = r.Header.Get(RequestIDHeader)
			}
			if correlationID == "" {
				correlationID = uuid.New().String()
			}

			// 2. Store in context for downstream use
			ctx = context.WithValue(ctx, correlationIDKey{}, correlationID)

			// 3. Add to OpenTelemetry baggage (propagates to downstream services)
			correlationMember, err := baggage.NewMember(BaggageCorrelationID, correlationID)
			if err == nil {
				bag, err := baggage.New(correlationMember)
				if err == nil {
					ctx = baggage.ContextWithBaggage(ctx, bag)
				}
			}

			// 4. Add as span attribute on the current span
			span := trace.SpanFromContext(ctx)
			if span.IsRecording() {
				span.SetAttributes(
					attribute.String("correlation.id", correlationID),
					attribute.String("http.request_id", correlationID),
				)
			}

			// 5. Return the correlation ID in response headers
			w.Header().Set(CorrelationIDHeader, correlationID)

			// 6. Also expose the trace ID in response headers for debugging
			traceID := span.SpanContext().TraceID()
			if traceID.IsValid() {
				w.Header().Set("X-Trace-ID", traceID.String())
			}

			// Log with correlation ID for bridging to log aggregation
			log.Debug("request started",
				zap.String("correlation_id", correlationID),
				zap.String("trace_id", traceID.String()),
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
			)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
```

## Baggage Propagation

Baggage propagates key-value pairs to all downstream services in the trace. Use it carefully — baggage adds overhead to every request:

```go
// internal/tracing/baggage.go
package tracing

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/baggage"
)

// Common baggage keys
const (
	BaggageUserID        = "user.id"
	BaggageTenantID      = "tenant.id"
	BaggageEnvironment   = "environment"
	BaggageFeatureFlags  = "feature.flags"
	BaggageCorrelationID = "correlation.id"
)

// BaggageWriter provides a fluent API for adding baggage to a context.
type BaggageWriter struct {
	ctx     context.Context
	members []baggage.Member
	err     error
}

// WithBaggage creates a new BaggageWriter for the given context.
func WithBaggage(ctx context.Context) *BaggageWriter {
	return &BaggageWriter{ctx: ctx}
}

// Set adds a key-value pair to the baggage.
func (b *BaggageWriter) Set(key, value string) *BaggageWriter {
	if b.err != nil {
		return b
	}
	member, err := baggage.NewMember(key, value)
	if err != nil {
		b.err = fmt.Errorf("baggage member %q=%q: %w", key, value, err)
		return b
	}
	b.members = append(b.members, member)
	return b
}

// Build returns the context with the baggage applied.
// Returns an error if any baggage members were invalid.
func (b *BaggageWriter) Build() (context.Context, error) {
	if b.err != nil {
		return b.ctx, b.err
	}

	// Merge with existing baggage
	existing := baggage.FromContext(b.ctx)
	for _, member := range b.members {
		var err error
		existing, err = existing.SetMember(member)
		if err != nil {
			return b.ctx, fmt.Errorf("set baggage: %w", err)
		}
	}

	return baggage.ContextWithBaggage(b.ctx, existing), nil
}

// GetBaggage retrieves a baggage value from the context.
func GetBaggage(ctx context.Context, key string) string {
	return baggage.FromContext(ctx).Member(key).Value()
}

// Example: Enrich a context with user and tenant information
func EnrichContext(ctx context.Context, userID, tenantID string) (context.Context, error) {
	return WithBaggage(ctx).
		Set(BaggageUserID, userID).
		Set(BaggageTenantID, tenantID).
		Build()
}
```

### Using Baggage in Service Handlers

```go
// Reading baggage in a downstream service
func (s *OrderService) CreateOrder(ctx context.Context, req *pb.CreateOrderRequest) (*pb.CreateOrderResponse, error) {
	tracer := otel.Tracer("order-service")
	ctx, span := tracer.Start(ctx, "CreateOrder",
		trace.WithSpanKind(trace.SpanKindServer),
	)
	defer span.End()

	// Read baggage set by upstream services
	userID := tracing.GetBaggage(ctx, tracing.BaggageUserID)
	tenantID := tracing.GetBaggage(ctx, tracing.BaggageTenantID)
	correlationID := tracing.GetBaggage(ctx, tracing.BaggageCorrelationID)

	// Add as span attributes for searchability
	span.SetAttributes(
		attribute.String("user.id", userID),
		attribute.String("tenant.id", tenantID),
		attribute.String("correlation.id", correlationID),
		attribute.String("order.type", req.OrderType),
	)

	// Use in business logic
	s.log.Info("creating order",
		zap.String("user_id", userID),
		zap.String("tenant_id", tenantID),
		zap.String("correlation_id", correlationID),
	)

	// ... business logic
	return &pb.CreateOrderResponse{}, nil
}
```

## Instrumentation Patterns

### HTTP Server Instrumentation

```go
// cmd/api/main.go
package main

import (
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.uber.org/zap"

	"github.com/yourorg/tracing-example/internal/middleware"
	"github.com/yourorg/tracing-example/internal/tracing"
)

func setupServer(log *zap.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/orders", handleListOrders)
	mux.HandleFunc("POST /api/v1/orders", handleCreateOrder)

	// Layer middleware from inside out:
	// 1. otelhttp wraps everything and creates the root span
	// 2. CorrelationMiddleware runs inside the span context
	handler := otelhttp.NewHandler(
		middleware.CorrelationMiddleware(log)(mux),
		"api-server",
		otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
			return fmt.Sprintf("%s %s", r.Method, r.URL.Path)
		}),
		otelhttp.WithFilter(func(r *http.Request) bool {
			// Don't trace health check endpoints
			return r.URL.Path != "/health" && r.URL.Path != "/ready"
		}),
	)

	return handler
}
```

### HTTP Client Instrumentation

Ensure outbound HTTP calls propagate trace context:

```go
// internal/client/http.go
package client

import (
	"context"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// NewTracedHTTPClient returns an HTTP client that automatically propagates
// trace context to all outbound requests.
func NewTracedHTTPClient(serviceName string) *http.Client {
	return &http.Client{
		Transport: otelhttp.NewTransport(
			http.DefaultTransport,
			otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
				return fmt.Sprintf("HTTP %s %s", r.Method, r.URL.Host)
			}),
		),
		Timeout: 30 * time.Second,
	}
}

// Example of a manual span around an HTTP call with error handling
func (c *InventoryClient) GetStock(ctx context.Context, productID string) (int, error) {
	tracer := otel.Tracer("inventory-client")
	ctx, span := tracer.Start(ctx, "InventoryClient.GetStock",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("product.id", productID),
			attribute.String("peer.service", "inventory-service"),
		),
	)
	defer span.End()

	resp, err := c.httpClient.Get(ctx,
		fmt.Sprintf("%s/v1/inventory/%s", c.baseURL, productID))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return 0, fmt.Errorf("get stock: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		err := fmt.Errorf("inventory service returned %d", resp.StatusCode)
		span.SetStatus(codes.Error, err.Error())
		span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))
		return 0, err
	}

	span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))
	// ... parse response
	return 100, nil
}
```

### Database Instrumentation

```go
// internal/database/traced.go
package database

import (
	"context"
	"database/sql"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// TracedDB wraps sql.DB with OpenTelemetry instrumentation.
type TracedDB struct {
	db      *sql.DB
	system  string  // "postgresql", "mysql", etc.
	dbName  string
}

// QueryContext executes a traced SQL query.
func (t *TracedDB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	tracer := otel.Tracer("database")
	ctx, span := tracer.Start(ctx, "db.query",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", t.system),
			attribute.String("db.name", t.dbName),
			attribute.String("db.statement", sanitizeQuery(query)),
		),
	)
	defer span.End()

	start := time.Now()
	rows, err := t.db.QueryContext(ctx, query, args...)
	elapsed := time.Since(start)

	span.SetAttributes(attribute.Int64("db.duration_ms", elapsed.Milliseconds()))

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	return rows, nil
}

// sanitizeQuery removes potentially sensitive literal values from SQL
// before including it in span attributes.
func sanitizeQuery(query string) string {
	// In production, use a proper SQL parser/normalizer
	// This is a simplified placeholder
	if len(query) > 200 {
		return query[:200] + "..."
	}
	return query
}
```

## Sampling Strategies

Sampling is critical at scale — tracing every request in a high-volume service produces enormous data volumes. The right strategy balances observability with cost.

### Head-Based Sampling

The sampling decision is made at the beginning of the trace (at the entry point):

```go
// Always sample errors and slow requests, sample others at 1%
type errorAndSlowSampler struct {
	base sdktrace.Sampler
}

func (s errorAndSlowSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	// For child spans, defer to the parent's decision
	if p.ParentContext.IsValid() {
		if p.ParentContext.IsSampled() {
			return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
		}
		return sdktrace.SamplingResult{Decision: sdktrace.Drop}
	}

	// For root spans, always sample if marked as error or slow
	for _, attr := range p.Attributes {
		if attr.Key == "sampling.priority" && attr.Value.AsInt64() > 0 {
			return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
		}
	}

	// Fall back to base sampler for everything else
	return s.base.ShouldSample(p)
}

func (s errorAndSlowSampler) Description() string {
	return "ErrorAndSlowSampler"
}

// Use in TracerProvider setup:
sampler := errorAndSlowSampler{
	base: sdktrace.TraceIDRatioBased(0.01), // 1% of normal traffic
}
```

### Tail-Based Sampling via OpenTelemetry Collector

The OTel Collector can make sampling decisions after the full trace is received, allowing sampling based on the outcome (e.g., always keep error traces):

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
  # Tail-based sampling using the tailsampling processor
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 1000
    policies:
      # Always keep error traces
      - name: errors-policy
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Always keep slow traces (>2 seconds)
      - name: slow-traces-policy
        type: latency
        latency:
          threshold_ms: 2000

      # Keep traces with high-priority baggage
      - name: priority-traces
        type: string_attribute
        string_attribute:
          key: sampling.priority
          values: ["high"]

      # Sample 5% of everything else
      - name: random-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 5

  # Batch before exporting
  batch:
    timeout: 5s
    send_batch_size: 1024

  # Add resource attributes from k8s
  k8sattributes:
    auth_type: serviceAccount
    extract:
      metadata:
        - k8s.namespace.name
        - k8s.pod.name
        - k8s.node.name
        - k8s.deployment.name

exporters:
  jaeger:
    endpoint: jaeger-collector:14250
    tls:
      insecure: true

  otlp:
    endpoint: tempo:4317
    tls:
      insecure: true

  prometheus:
    endpoint: "0.0.0.0:8889"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, k8sattributes, batch]
      exporters: [jaeger, otlp]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
```

### Adaptive Sampling

For services with variable traffic, implement adaptive sampling that increases the sample rate during low-traffic periods:

```go
// internal/tracing/adaptive_sampler.go
package tracing

import (
	"math"
	"sync/atomic"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// AdaptiveSampler adjusts sampling rate based on current request rate.
// During low traffic, sample more to maintain statistical significance.
// During high traffic, reduce sampling to control costs.
type AdaptiveSampler struct {
	minRate     float64 // Minimum sampling rate (e.g., 0.01 = 1%)
	maxRate     float64 // Maximum sampling rate (e.g., 1.0 = 100%)
	targetRPS   float64 // Target traced requests per second
	currentRPS  atomic.Value
	baseSampler sdktrace.Sampler
}

// NewAdaptiveSampler creates a sampler that targets a fixed number of samples/sec.
func NewAdaptiveSampler(targetTracesPerSec float64, minRate, maxRate float64) *AdaptiveSampler {
	s := &AdaptiveSampler{
		minRate:   minRate,
		maxRate:   maxRate,
		targetRPS: targetTracesPerSec,
	}
	s.currentRPS.Store(0.0)

	// Background goroutine to measure and update sampling rate
	go s.measureRPS()
	return s
}

func (s *AdaptiveSampler) computeRate() float64 {
	rps := s.currentRPS.Load().(float64)
	if rps <= 0 {
		return s.maxRate // During startup or idle, sample everything
	}

	rate := s.targetRPS / rps
	return math.Max(s.minRate, math.Min(s.maxRate, rate))
}

func (s *AdaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	rate := s.computeRate()
	sampler := sdktrace.ParentBased(sdktrace.TraceIDRatioBased(rate))
	return sampler.ShouldSample(p)
}

func (s *AdaptiveSampler) Description() string {
	return fmt.Sprintf("AdaptiveSampler{rate=%.4f}", s.computeRate())
}

var _ sdktrace.Sampler = (*AdaptiveSampler)(nil)
```

## Connecting Logs to Traces

The highest-value tracing feature is connecting log lines to the trace that generated them:

```go
// internal/logging/traced_logger.go
package logging

import (
	"context"

	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// TracedLogger wraps zap.Logger to automatically inject trace and span IDs.
type TracedLogger struct {
	base *zap.Logger
}

// NewTracedLogger creates a logger that injects OpenTelemetry context.
func NewTracedLogger(base *zap.Logger) *TracedLogger {
	return &TracedLogger{base: base}
}

// With returns a new TracedLogger with additional fields.
func (l *TracedLogger) With(fields ...zap.Field) *TracedLogger {
	return &TracedLogger{base: l.base.With(fields...)}
}

// For returns a logger enriched with the trace context from ctx.
func (l *TracedLogger) For(ctx context.Context) *zap.Logger {
	span := trace.SpanFromContext(ctx)
	if !span.SpanContext().IsValid() {
		return l.base
	}

	sc := span.SpanContext()
	fields := []zap.Field{
		zap.String("trace_id", sc.TraceID().String()),
		zap.String("span_id", sc.SpanID().String()),
		zap.Bool("trace_sampled", sc.IsSampled()),
	}

	// Add correlation ID from baggage if present
	// (set by CorrelationMiddleware)
	if corrID := GetBaggageFromSpan(span, "correlation.id"); corrID != "" {
		fields = append(fields, zap.String("correlation_id", corrID))
	}

	return l.base.With(fields...)
}

// Info logs at info level with trace context.
func (l *TracedLogger) Info(ctx context.Context, msg string, fields ...zap.Field) {
	l.For(ctx).Info(msg, fields...)
}

// Error logs at error level and also records the error on the span.
func (l *TracedLogger) Error(ctx context.Context, msg string, fields ...zap.Field) {
	l.For(ctx).Error(msg, fields...)

	// Emit the log as a span event too (visible in Jaeger)
	span := trace.SpanFromContext(ctx)
	if span.IsRecording() {
		span.AddEvent("error", trace.WithAttributes(
			attribute.String("log.message", msg),
			attribute.String("log.level", "error"),
		))
	}
}
```

## Kubernetes Deployment for OTel Collector

```yaml
# otel-collector-deployment.yaml
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
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8889"
    spec:
      containers:
        - name: collector
          image: otel/opentelemetry-collector-contrib:0.114.0
          args:
            - --config=/conf/otel-collector-config.yaml
          ports:
            - containerPort: 4317  # OTLP gRPC
            - containerPort: 4318  # OTLP HTTP
            - containerPort: 8889  # Prometheus metrics
            - containerPort: 13133 # Health check
          readinessProbe:
            httpGet:
              path: /
              port: 13133
          resources:
            requests:
              cpu: 200m
              memory: 400Mi
            limits:
              cpu: "1"
              memory: 2Gi
          volumeMounts:
            - name: config
              mountPath: /conf
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

## Complete Application Setup

```go
// cmd/api/main.go
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/yourorg/tracing-example/internal/tracing"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	ctx, cancel := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Initialize distributed tracing
	shutdownTracing, err := tracing.InitTracing(ctx, tracing.Config{
		ServiceName:    "payment-api",
		ServiceVersion: "v2.1.0",
		Environment:    os.Getenv("ENVIRONMENT"),
		OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		SampleRate:     0.1, // 10% base sampling rate
		Insecure:       os.Getenv("OTEL_INSECURE") == "true",
	}, log)
	if err != nil {
		log.Fatal("failed to initialize tracing", zap.Error(err))
	}

	// Ensure spans are flushed on shutdown
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			log.Error("failed to shutdown tracer", zap.Error(err))
		}
	}()

	srv := &http.Server{
		Addr:    ":8080",
		Handler: setupServer(log),
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("server error", zap.Error(err))
		}
	}()

	<-ctx.Done()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	srv.Shutdown(shutdownCtx)
}
```

## Summary

Production distributed tracing in Go requires getting several things right simultaneously:

- **TracerProvider setup** with proper resource attributes ensures traces are correctly attributed to the service, version, and environment
- **Correlation ID bridging** connects pre-existing request ID schemes with OpenTelemetry trace IDs, making log-to-trace correlation work across heterogeneous systems
- **Baggage propagation** carries cross-cutting concerns (user ID, tenant ID) through the entire trace without requiring each service to extract them from HTTP headers independently
- **Sampling strategy** must be tuned to your traffic volume — head-based sampling is simple and low-overhead; tail-based sampling via the OTel Collector provides better coverage of error cases at higher cost
- **Connecting logs to traces** via injecting trace_id and span_id into structured log entries is what makes tracing actionable — a span ID in a log line lets you jump directly from a Loki log query to the Jaeger trace

The key insight is that tracing is only valuable if it's consistent across all services. Even one service in the chain that doesn't propagate context breaks the trace. Treat context propagation as a foundational requirement and instrument it early in your service framework rather than retroactively adding it per handler.
