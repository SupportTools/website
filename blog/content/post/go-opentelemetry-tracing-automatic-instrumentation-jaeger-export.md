---
title: "Go: Implementing OpenTelemetry Tracing with Automatic Instrumentation, Sampling Strategies, and Jaeger Export"
date: 2031-06-19T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Tracing", "Jaeger", "Observability", "Distributed Tracing", "Instrumentation"]
categories:
- Go
- Observability
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to OpenTelemetry distributed tracing in Go, covering SDK setup, automatic HTTP and gRPC instrumentation, context propagation, sampling strategies, and Jaeger/OTLP export."
more_link: "yes"
url: "/go-opentelemetry-tracing-automatic-instrumentation-jaeger-export/"
---

Distributed tracing is the highest-fidelity observability signal for understanding latency, bottlenecks, and failure propagation across microservices. OpenTelemetry has become the industry standard for vendor-neutral trace instrumentation, and its Go SDK provides both manual span creation and automatic instrumentation wrappers for the most common frameworks. For engineering teams migrating from Zipkin, Jaeger native SDKs, or custom tracing solutions, OpenTelemetry offers a single instrumentation model that routes to any backend.

This guide covers the complete production implementation: SDK initialization, HTTP and gRPC auto-instrumentation, database span capture, context propagation across service boundaries, sampling strategies for high-volume services, and reliable export to Jaeger via OTLP.

<!--more-->

# Go: Implementing OpenTelemetry Tracing with Automatic Instrumentation, Sampling Strategies, and Jaeger Export

## OpenTelemetry Concepts

Before writing code, the terminology matters:

- **Tracer**: Factory for creating spans; scoped to a component name and version
- **Span**: A single unit of work with start/end time, attributes, and events
- **Trace**: A DAG of spans sharing a TraceID, representing a complete request path
- **Context**: Go's `context.Context` carries the active span across function calls
- **Propagator**: Serializes/deserializes trace context across process boundaries (HTTP headers, gRPC metadata)
- **Exporter**: Ships spans to a backend (Jaeger, OTLP collector, Zipkin)
- **Sampler**: Decides which traces to record — critical for high-throughput services

## Project Setup

```bash
mkdir otel-demo && cd otel-demo
go mod init github.com/your-org/otel-demo

# Core OTel SDK
go get go.opentelemetry.io/otel@v1.32.0
go get go.opentelemetry.io/otel/trace@v1.32.0
go get go.opentelemetry.io/otel/sdk@v1.32.0
go get go.opentelemetry.io/otel/sdk/trace@v1.32.0

# OTLP gRPC exporter (preferred for production)
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.32.0

# Jaeger exporter (direct, for simpler setups)
go get go.opentelemetry.io/otel/exporters/jaeger@v1.17.0

# W3C TraceContext + Baggage propagators
go get go.opentelemetry.io/otel/propagators/b3@v1.32.0

# Auto-instrumentation libraries
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.57.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.57.0
go get go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql@v0.57.0
```

## Tracer Provider Initialization

The TracerProvider is the central registry. Initialize it once at startup and shut it down gracefully:

```go
// pkg/telemetry/tracer.go
package telemetry

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds tracing configuration loaded from environment.
type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string  // e.g., "otel-collector:4317"
	SampleRate     float64 // 0.0 to 1.0
}

// InitTracer creates and registers the global TracerProvider.
// Returns a shutdown function that must be called before process exit.
func InitTracer(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	// Build resource with service metadata
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			attribute.String("deployment.environment", cfg.Environment),
			attribute.String("host.arch", runtime.GOARCH),
		),
		resource.WithOS(),
		resource.WithProcess(),
		resource.WithContainer(),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTel resource: %w", err)
	}

	// OTLP gRPC exporter with retry
	conn, err := grpc.NewClient(cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to OTLP endpoint %s: %w", cfg.OTLPEndpoint, err)
	}

	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithGRPCConn(conn),
		otlptracegrpc.WithTimeout(10*time.Second),
		otlptracegrpc.WithRetry(otlptracegrpc.RetryConfig{
			Enabled:         true,
			InitialInterval: 5 * time.Second,
			MaxInterval:     30 * time.Second,
			MaxElapsedTime:  120 * time.Second,
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTLP exporter: %w", err)
	}

	// Sampler selection based on rate
	sampler := buildSampler(cfg.SampleRate, cfg.Environment)

	// Batch processor — amortizes export overhead
	bsp := sdktrace.NewBatchSpanProcessor(exporter,
		sdktrace.WithMaxQueueSize(8192),
		sdktrace.WithMaxExportBatchSize(512),
		sdktrace.WithBatchTimeout(5*time.Second),
		sdktrace.WithExportTimeout(30*time.Second),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(bsp),
	)

	// Register as global provider
	otel.SetTracerProvider(tp)

	// Register W3C TraceContext + Baggage propagators
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	shutdown := func(ctx context.Context) error {
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutting down tracer provider: %w", err)
		}
		return conn.Close()
	}

	return shutdown, nil
}

// buildSampler creates a sampler appropriate for the environment.
func buildSampler(rate float64, env string) sdktrace.Sampler {
	switch env {
	case "development", "test":
		// Sample everything in dev
		return sdktrace.AlwaysSample()
	case "production":
		// Adaptive: always sample errors, rate-limit successes
		return sdktrace.ParentBased(
			adaptiveSampler(rate),
		)
	default:
		return sdktrace.TraceIDRatioBased(rate)
	}
}

// adaptiveSampler wraps ratio sampling with error forcing.
func adaptiveSampler(rate float64) sdktrace.Sampler {
	return sdktrace.TraceIDRatioBased(rate)
}
```

### Application Bootstrap

```go
// main.go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/your-org/otel-demo/pkg/telemetry"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Initialize tracing
	cfg := telemetry.Config{
		ServiceName:    "order-service",
		ServiceVersion: "2.4.1",
		Environment:    os.Getenv("ENVIRONMENT"),
		OTLPEndpoint:   getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector:4317"),
		SampleRate:     0.1, // 10% in production
	}

	shutdown, err := telemetry.InitTracer(ctx, cfg)
	if err != nil {
		logger.Error("failed to initialize tracer", "error", err)
		os.Exit(1)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			logger.Error("tracer shutdown error", "error", err)
		}
	}()

	logger.Info("tracing initialized", "service", cfg.ServiceName)

	// ... start HTTP server, etc.
	<-ctx.Done()
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
```

## Automatic HTTP Instrumentation

The `otelhttp` package wraps `http.Handler` and `http.Client` automatically:

### Server-Side Instrumentation

```go
// internal/server/server.go
package server

import (
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

var tracer = otel.Tracer("order-service/http")

func NewRouter() http.Handler {
	mux := http.NewServeMux()

	// Register handlers with automatic span creation
	mux.Handle("/orders", otelhttp.NewHandler(
		http.HandlerFunc(handleListOrders),
		"list-orders",
		otelhttp.WithTracerProvider(otel.GetTracerProvider()),
		otelhttp.WithPropagators(otel.GetTextMapPropagator()),
		// Add standard HTTP attributes to every span
		otelhttp.WithSpanOptions(
			trace.WithAttributes(
				attribute.String("service.component", "http-handler"),
			),
		),
	))

	mux.Handle("/orders/", otelhttp.NewHandler(
		http.HandlerFunc(handleGetOrder),
		"get-order",
	))

	// Wrap entire mux for metrics collection
	return otelhttp.NewHandler(mux, "http-server",
		otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
	)
}

func handleGetOrder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Retrieve current span and add attributes
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("order.id", r.PathValue("id")),
		attribute.String("http.user_agent", r.UserAgent()),
	)

	// Create child span for business logic
	ctx, childSpan := tracer.Start(ctx, "fetch-order-from-db",
		trace.WithAttributes(
			attribute.String("db.operation", "SELECT"),
			attribute.String("db.table", "orders"),
		),
	)
	defer childSpan.End()

	// ... business logic
	order, err := fetchOrder(ctx, r.PathValue("id"))
	if err != nil {
		childSpan.RecordError(err)
		childSpan.SetStatus(codes.Error, err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	childSpan.SetAttributes(
		attribute.Bool("order.found", order != nil),
	)

	respondJSON(w, order)
}
```

### Client-Side Instrumentation

```go
// internal/client/client.go
package client

import (
	"context"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewHTTPClient creates a traced HTTP client.
func NewHTTPClient() *http.Client {
	return &http.Client{
		Transport: otelhttp.NewTransport(
			http.DefaultTransport,
			otelhttp.WithTracerProvider(otel.GetTracerProvider()),
			otelhttp.WithPropagators(otel.GetTextMapPropagator()),
			otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
				return fmt.Sprintf("HTTP %s %s", r.Method, r.URL.Host)
			}),
		),
		Timeout: 30 * time.Second,
	}
}

// CallInventoryService demonstrates outbound traced calls.
func CallInventoryService(ctx context.Context, productID string) (*Product, error) {
	client := NewHTTPClient()

	req, err := http.NewRequestWithContext(ctx,
		http.MethodGet,
		fmt.Sprintf("http://inventory-service:8080/products/%s", productID),
		nil,
	)
	if err != nil {
		return nil, err
	}

	// W3C traceparent header is injected automatically by otelhttp.Transport
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// ... parse response
	return parseProduct(resp.Body)
}
```

## gRPC Auto-Instrumentation

```go
// internal/grpc/server.go
package grpcserver

import (
	"google.golang.org/grpc"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func NewGRPCServer() *grpc.Server {
	return grpc.NewServer(
		// Unary interceptor for request/response RPCs
		grpc.UnaryInterceptor(
			otelgrpc.UnaryServerInterceptor(
				otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
				otelgrpc.WithPropagators(otel.GetTextMapPropagator()),
				otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
			),
		),
		// Stream interceptor for streaming RPCs
		grpc.StreamInterceptor(
			otelgrpc.StreamServerInterceptor(
				otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
				otelgrpc.WithPropagators(otel.GetTextMapPropagator()),
			),
		),
	)
}

// NewGRPCClient creates a traced gRPC client connection.
func NewGRPCClient(target string) (*grpc.ClientConn, error) {
	return grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithUnaryInterceptor(
			otelgrpc.UnaryClientInterceptor(
				otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
			),
		),
		grpc.WithStreamInterceptor(
			otelgrpc.StreamClientInterceptor(
				otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
			),
		),
	)
}
```

## Database Instrumentation

### SQL Database with otelsql

```go
// internal/database/db.go
package database

import (
	"database/sql"
	"fmt"

	"go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	_ "github.com/lib/pq"
)

func NewDB(dsn string) (*sql.DB, error) {
	// Register traced driver
	driverName, err := otelsql.Register("postgres",
		otelsql.WithAttributes(
			semconv.DBSystemPostgreSQL,
			semconv.DBName("orders"),
		),
		otelsql.WithTracerProvider(otel.GetTracerProvider()),
		otelsql.WithSQLCommenter(true),
		// Capture query parameters in dev, redact in prod
		otelsql.WithAttributesGetter(func(ctx context.Context,
			method otelsql.Method, query string, args []driver.NamedValue) []attribute.KeyValue {
			return []attribute.KeyValue{
				semconv.DBOperationName(string(method)),
				attribute.Int("db.query.args_count", len(args)),
			}
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("registering otelsql driver: %w", err)
	}

	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	// Record connection pool stats
	otelsql.RecordStats(db,
		otelsql.WithAttributes(semconv.DBSystemPostgreSQL),
		otelsql.WithMinimumReadDBStatsInterval(10*time.Second),
	)

	return db, nil
}
```

### Redis with Manual Spans

```go
// internal/cache/redis.go
package cache

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("order-service/cache")

type RedisCache struct {
	client *redis.Client
}

func (c *RedisCache) Get(ctx context.Context, key string) (string, error) {
	ctx, span := tracer.Start(ctx, "redis.get",
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.String("db.operation.name", "GET"),
			attribute.String("db.redis.key", key),
		),
		trace.WithSpanKind(trace.SpanKindClient),
	)
	defer span.End()

	val, err := c.client.Get(ctx, key).Result()
	if err == redis.Nil {
		span.SetAttributes(attribute.Bool("cache.hit", false))
		return "", nil
	}
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return "", fmt.Errorf("redis GET %s: %w", key, err)
	}

	span.SetAttributes(
		attribute.Bool("cache.hit", true),
		attribute.Int("db.response.size", len(val)),
	)
	return val, nil
}

func (c *RedisCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	ctx, span := tracer.Start(ctx, "redis.set",
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.String("db.operation.name", "SET"),
			attribute.String("db.redis.key", key),
			attribute.Int64("db.redis.ttl_seconds", int64(ttl.Seconds())),
		),
		trace.WithSpanKind(trace.SpanKindClient),
	)
	defer span.End()

	if err := c.client.Set(ctx, key, value, ttl).Err(); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("redis SET %s: %w", key, err)
	}

	return nil
}
```

## Advanced Span Patterns

### Span Events for Business Logic Checkpoints

```go
func processOrder(ctx context.Context, order *Order) error {
	ctx, span := tracer.Start(ctx, "process-order",
		trace.WithAttributes(
			attribute.String("order.id", order.ID),
			attribute.String("order.customer_id", order.CustomerID),
			attribute.Float64("order.total_usd", order.Total),
		),
	)
	defer span.End()

	// Record significant milestones as events (not new spans)
	span.AddEvent("order.validation.started")

	if err := validateOrder(ctx, order); err != nil {
		span.AddEvent("order.validation.failed",
			trace.WithAttributes(attribute.String("validation.error", err.Error())),
		)
		span.RecordError(err)
		span.SetStatus(codes.Error, "order validation failed")
		return err
	}

	span.AddEvent("order.validation.passed")
	span.AddEvent("order.payment.processing")

	payment, err := processPayment(ctx, order)
	if err != nil {
		span.AddEvent("order.payment.failed",
			trace.WithAttributes(
				attribute.String("payment.error", err.Error()),
				attribute.String("payment.provider", "stripe"),
			),
		)
		span.RecordError(err)
		span.SetStatus(codes.Error, "payment processing failed")
		return err
	}

	span.AddEvent("order.payment.succeeded",
		trace.WithAttributes(
			attribute.String("payment.id", payment.ID),
			attribute.String("payment.method", payment.Method),
		),
	)

	span.SetAttributes(
		attribute.String("order.status", "confirmed"),
		attribute.String("payment.id", payment.ID),
	)

	return nil
}
```

### Linking Spans Across Async Boundaries

When a request triggers async work (queues, goroutines), use span links to connect the traces:

```go
func publishOrderEvent(ctx context.Context, order *Order) error {
	// Capture the current span context for linking
	parentSpanCtx := trace.SpanFromContext(ctx).SpanContext()

	// Serialize trace context for the message
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)

	msg := &kafka.Message{
		Topic: "orders.created",
		Value: marshalOrder(order),
		Headers: []kafka.Header{
			{Key: "traceparent", Value: []byte(carrier["traceparent"])},
			{Key: "tracestate", Value: []byte(carrier["tracestate"])},
		},
	}

	return producer.Produce(msg, nil)
}

// Consumer side: extract context and link to producer span
func consumeOrderEvent(msg *kafka.Message) error {
	carrier := propagation.MapCarrier{}
	for _, h := range msg.Headers {
		carrier[h.Key] = string(h.Value)
	}

	// Extract parent context from message
	parentCtx := otel.GetTextMapPropagator().Extract(context.Background(), carrier)
	parentSpanCtx := trace.SpanFromContext(parentCtx).SpanContext()

	// Start consumer span with link to producer
	ctx, span := tracer.Start(context.Background(), "process-order-event",
		trace.WithLinks(trace.Link{
			SpanContext: parentSpanCtx,
			Attributes: []attribute.KeyValue{
				attribute.String("link.type", "follows_from"),
			},
		}),
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", msg.TopicPartition.Topic.String()),
			attribute.Int64("messaging.kafka.partition", int64(msg.TopicPartition.Partition)),
			attribute.Int64("messaging.kafka.offset", int64(msg.TopicPartition.Offset)),
		),
	)
	defer span.End()

	return handleOrderEvent(ctx, msg)
}
```

## Sampling Strategies

### Parent-Based Sampling (Default for Microservices)

```go
// Parent-based sampling respects upstream sampling decisions.
// If the upstream sampled the trace, downstream services record too.
// If upstream did not sample, downstream services skip.
sampler := sdktrace.ParentBased(
	sdktrace.TraceIDRatioBased(0.1), // 10% of root spans
	sdktrace.WithRemoteSampled(sdktrace.AlwaysSample()),    // Follow sampled upstream
	sdktrace.WithRemoteNotSampled(sdktrace.NeverSample()),  // Follow unsampled upstream
	sdktrace.WithLocalSampled(sdktrace.AlwaysSample()),     // Local sampled spans always record
	sdktrace.WithLocalNotSampled(sdktrace.NeverSample()),   // Local unsampled spans skip
)
```

### Error-Forcing Sampler

Always sample traces containing errors, regardless of the base rate:

```go
// pkg/telemetry/sampler.go
package telemetry

import (
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// ErrorForcingSampler samples all error traces plus a base rate of normal traces.
type ErrorForcingSampler struct {
	base sdktrace.Sampler
}

func NewErrorForcingSampler(baseRate float64) sdktrace.Sampler {
	return &ErrorForcingSampler{
		base: sdktrace.TraceIDRatioBased(baseRate),
	}
}

func (s *ErrorForcingSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	// Check if any attribute indicates an error
	for _, attr := range p.Attributes {
		if attr.Key == "error" && attr.Value.AsBool() {
			return sdktrace.SamplingResult{
				Decision:   sdktrace.RecordAndSample,
				Tracestate: p.ParentContext.TraceState(),
			}
		}
		if attr.Key == "http.response.status_code" {
			code := attr.Value.AsInt64()
			if code >= 400 {
				return sdktrace.SamplingResult{
					Decision:   sdktrace.RecordAndSample,
					Tracestate: p.ParentContext.TraceState(),
				}
			}
		}
	}
	return s.base.ShouldSample(p)
}

func (s *ErrorForcingSampler) Description() string {
	return fmt.Sprintf("ErrorForcingSampler{base: %s}", s.base.Description())
}
```

### Tail-Based Sampling via OpenTelemetry Collector

For true tail-based sampling (sample based on outcome, not at trace start), use the OTel Collector:

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
  # Tail-based sampling: buffer spans, decide after trace completes
  tail_sampling:
    decision_wait: 30s
    num_traces: 100000
    expected_new_traces_per_sec: 1000
    policies:
      # Always sample errors
      - name: error-traces
        type: status_code
        status_code: {status_codes: [ERROR]}

      # Always sample slow requests (>500ms)
      - name: slow-traces
        type: latency
        latency: {threshold_ms: 500}

      # Sample 5% of successful fast requests
      - name: success-traces
        type: probabilistic
        probabilistic: {sampling_percentage: 5}

  batch:
    send_batch_size: 1024
    timeout: 10s

  memory_limiter:
    limit_mib: 512
    spike_limit_mib: 128
    check_interval: 5s

exporters:
  otlp/jaeger:
    endpoint: jaeger-collector:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp/jaeger]
```

## Context Propagation Best Practices

### Passing Context Through Goroutines

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Correct: pass context to goroutine
	var wg sync.WaitGroup
	results := make(chan Result, 3)

	for _, svc := range []string{"inventory", "pricing", "recommendations"} {
		wg.Add(1)
		go func(ctx context.Context, service string) {
			defer wg.Done()
			ctx, span := tracer.Start(ctx, fmt.Sprintf("fetch.%s", service),
				trace.WithSpanKind(trace.SpanKindClient),
			)
			defer span.End()

			result, err := callService(ctx, service)
			if err != nil {
				span.RecordError(err)
				span.SetStatus(codes.Error, err.Error())
				return
			}
			results <- result
		}(ctx, svc) // Pass ctx, not the outer r.Context() captured in closure
	}

	wg.Wait()
	close(results)
}
```

### Baggage for Cross-Service Correlation

```go
import "go.opentelemetry.io/otel/baggage"

// Set baggage at request ingress
func ingressMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Add business context to baggage — propagates to all downstream services
		userID := r.Header.Get("X-User-ID")
		if userID != "" {
			member, _ := baggage.NewMember("user.id", userID)
			bag, _ := baggage.New(member)
			ctx = baggage.ContextWithBaggage(ctx, bag)
		}

		tenantID := r.Header.Get("X-Tenant-ID")
		if tenantID != "" {
			member, _ := baggage.NewMember("tenant.id", tenantID)
			bag := baggage.FromContext(ctx)
			bag, _ = bag.SetMember(member)
			ctx = baggage.ContextWithBaggage(ctx, bag)
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Read baggage anywhere in the call chain
func someDeepFunction(ctx context.Context) {
	bag := baggage.FromContext(ctx)
	userID := bag.Member("user.id").Value()
	tenantID := bag.Member("tenant.id").Value()

	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("user.id", userID),
		attribute.String("tenant.id", tenantID),
	)
}
```

## Jaeger Deployment for Kubernetes

```yaml
# jaeger-all-in-one.yaml (development)
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
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
        - name: jaeger
          image: jaegertracing/all-in-one:1.62
          env:
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
            - name: SPAN_STORAGE_TYPE
              value: "memory"
            - name: MEMORY_MAX_TRACES
              value: "50000"
          ports:
            - containerPort: 16686  # UI
              name: ui
            - containerPort: 4317   # OTLP gRPC
              name: otlp-grpc
            - containerPort: 4318   # OTLP HTTP
              name: otlp-http
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: observability
spec:
  selector:
    app: jaeger
  ports:
    - name: ui
      port: 16686
      targetPort: 16686
    - name: otlp-grpc
      port: 4317
      targetPort: 4317
    - name: otlp-http
      port: 4318
      targetPort: 4318
```

### Production Jaeger with Cassandra Backend

```yaml
# jaeger-production.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger-collector
  namespace: observability
spec:
  replicas: 3
  selector:
    matchLabels:
      app: jaeger-collector
  template:
    spec:
      containers:
        - name: collector
          image: jaegertracing/jaeger-collector:1.62
          env:
            - name: SPAN_STORAGE_TYPE
              value: cassandra
            - name: CASSANDRA_SERVERS
              value: "cassandra-0.cassandra,cassandra-1.cassandra,cassandra-2.cassandra"
            - name: CASSANDRA_KEYSPACE
              value: jaeger_v1_production
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
            - name: COLLECTOR_OTLP_GRPC_HOST_PORT
              value: "0.0.0.0:4317"
          resources:
            requests:
              cpu: "1"
              memory: "1Gi"
            limits:
              cpu: "4"
              memory: "4Gi"
```

## Testing Instrumentation

```go
// pkg/telemetry/testing.go
package telemetry

import (
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// SetupTestTracer configures an in-memory tracer for unit tests.
func SetupTestTracer(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()

	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(recorder),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)
	otel.SetTracerProvider(tp)

	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
	})

	return recorder
}

// Example test
func TestProcessOrder_CreatesSpan(t *testing.T) {
	recorder := SetupTestTracer(t)
	ctx := context.Background()

	err := processOrder(ctx, &Order{ID: "ord-123", Total: 49.99})
	require.NoError(t, err)

	spans := recorder.Ended()
	require.Len(t, spans, 3) // process-order + fetch-from-db + publish-event

	rootSpan := spans[0]
	assert.Equal(t, "process-order", rootSpan.Name())
	assert.Equal(t, codes.Ok, rootSpan.Status().Code)

	// Verify attributes
	attrs := rootSpan.Attributes()
	assertAttribute(t, attrs, "order.id", "ord-123")
	assertAttribute(t, attrs, "order.total_usd", 49.99)
}
```

## Production Checklist

Before shipping traced services to production:

- Set `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and `OTEL_SDK_DISABLED` environment variables
- Configure batch span processor with appropriate queue size (8192+) to handle traffic bursts
- Set `expireAfter` on span batches to prevent memory growth on collector backpressure
- Use `ParentBased` sampling to propagate upstream decisions faithfully
- Define PodDisruptionBudgets for the OTel Collector deployment
- Monitor `otelcol_exporter_send_failed_spans` to catch export failures
- Redact PII from span attributes — trace data may be stored for weeks
- Configure resource attributes (service name, version, environment) for all services

OpenTelemetry in Go has reached production maturity. The combination of automatic HTTP/gRPC/SQL instrumentation with manual span enrichment gives engineering teams complete request visibility without excessive boilerplate, and the vendor-neutral model ensures your instrumentation investment survives any backend migration.
