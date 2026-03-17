---
title: "Go Tracing with OpenTelemetry: Distributed Context Propagation"
date: 2029-06-05T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Distributed Tracing", "Observability", "Jaeger", "Tempo", "OTLP"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to distributed tracing in Go using the OpenTelemetry SDK, covering trace and span creation, context propagation, sampling strategies, OTLP exporter configuration, Jaeger and Tempo integration, and the baggage API for cross-service metadata."
more_link: "yes"
url: "/go-tracing-opentelemetry-distributed-context-propagation/"
---

Distributed tracing is the observability primitive that lets you follow a single request as it flows through dozens of microservices. OpenTelemetry (OTel) has become the standard for instrumenting Go applications — it provides vendor-neutral APIs and SDKs that export to any compatible backend: Jaeger, Grafana Tempo, Honeycomb, Datadog, or the OpenTelemetry Collector. This guide covers the complete OTel Go implementation from SDK initialization through span creation, context propagation, sampling strategies, and Baggage API for cross-service metadata.

<!--more-->

# Go Tracing with OpenTelemetry: Distributed Context Propagation

## OpenTelemetry Architecture in Go

The OTel Go SDK consists of several layers:

```
Application Code
     |
OTel API (go.opentelemetry.io/otel)
     |
OTel SDK (go.opentelemetry.io/otel/sdk)
     |
Exporter (OTLP / Jaeger / Zipkin / stdout)
     |
Collector / Backend
```

The **API** package defines interfaces — your application code uses only the API, never the SDK directly. This allows changing exporters without modifying instrumentation code.

The **SDK** package provides the concrete implementation of the API. You configure it once at application startup.

**Exporters** send completed spans to a backend. The OTLP exporter is recommended for production as it works with any OTLP-compatible backend.

## Dependencies

```bash
# Core SDK
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/sdk
go get go.opentelemetry.io/otel/sdk/trace

# OTLP exporter (recommended for production)
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc

# HTTP transport alternative
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp

# Jaeger exporter (direct, without collector)
go get go.opentelemetry.io/otel/exporters/jaeger

# Propagation
go get go.opentelemetry.io/otel/propagation

# Instrumentation libraries
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
go get go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql
```

## SDK Initialization

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
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds the telemetry configuration.
type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string  // e.g., "localhost:4317" or "otel-collector:4317"
	SampleRate     float64 // 0.0 to 1.0
}

// InitTracer initializes the OpenTelemetry tracer provider.
// Returns a shutdown function that must be called before program exit.
func InitTracer(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	// Create the resource describing this service
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			attribute.String("environment", cfg.Environment),
			attribute.String("host.name", hostname()),
		),
		resource.WithOS(),
		resource.WithProcess(),
		resource.WithContainer(),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTel resource: %w", err)
	}

	// Create the OTLP gRPC exporter
	conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
		grpc.WithTimeout(5*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to OTel collector at %s: %w", cfg.OTLPEndpoint, err)
	}

	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithGRPCConn(conn),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTLP trace exporter: %w", err)
	}

	// Configure the sampler
	sampler := configureSampler(cfg.SampleRate)

	// Create the TracerProvider
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter,
			// Export spans every second (reduce latency)
			sdktrace.WithBatchTimeout(time.Second),
			// Maximum batch size
			sdktrace.WithMaxExportBatchSize(512),
			// Queue size for buffering spans before export
			sdktrace.WithMaxQueueSize(2048),
		),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)

	// Register as the global TracerProvider
	otel.SetTracerProvider(tp)

	// Set up context propagation (W3C TraceContext + Baggage)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},  // W3C traceparent / tracestate headers
		propagation.Baggage{},       // W3C baggage header
	))

	// Return the shutdown function
	return func(ctx context.Context) error {
		// Flush remaining spans before shutdown
		shutdownCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := tp.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutting down tracer provider: %w", err)
		}
		return conn.Close()
	}, nil
}

func configureSampler(rate float64) sdktrace.Sampler {
	switch {
	case rate <= 0:
		return sdktrace.NeverSample()
	case rate >= 1:
		return sdktrace.AlwaysSample()
	default:
		return sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(rate),
		)
	}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
```

### Application Startup Integration

```go
// cmd/server/main.go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"myapp/pkg/telemetry"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Initialize tracer
	shutdown, err := telemetry.InitTracer(ctx, telemetry.Config{
		ServiceName:    "payment-service",
		ServiceVersion: "2.3.1",
		Environment:    os.Getenv("APP_ENV"), // "production", "staging"
		OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		SampleRate:     0.1, // Sample 10% of requests
	})
	if err != nil {
		slog.Error("failed to initialize tracer", "error", err)
		os.Exit(1)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			slog.Error("failed to shutdown tracer", "error", err)
		}
	}()

	// Start application...
	runServer(ctx)
}
```

## Creating Spans

```go
// pkg/payment/processor.go
package payment

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

// Package-level tracer — create once per package
var tracer = otel.Tracer("payment-service/payment",
	trace.WithInstrumentationVersion("1.0.0"),
	trace.WithSchemaURL(semconv.SchemaURL),
)

type PaymentProcessor struct {
	db     Database
	stripe StripeClient
}

func (p *PaymentProcessor) ProcessPayment(ctx context.Context, req PaymentRequest) (*PaymentResult, error) {
	// Start a span — the span name should be verb+noun, reflecting the operation
	ctx, span := tracer.Start(ctx, "ProcessPayment",
		trace.WithAttributes(
			attribute.String("payment.currency", req.Currency),
			attribute.Float64("payment.amount", req.Amount),
			attribute.String("payment.method", req.Method),
			attribute.String("customer.id", req.CustomerID),
		),
		// Span kind: Server, Client, Producer, Consumer, Internal
		trace.WithSpanKind(trace.SpanKindInternal),
	)
	defer span.End()

	// Validate the request
	if err := p.validateRequest(ctx, req); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "validation failed")
		return nil, fmt.Errorf("validating payment request: %w", err)
	}

	// Check for duplicate payment
	isDuplicate, err := p.checkDuplicate(ctx, req.IdempotencyKey)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "duplicate check failed")
		return nil, fmt.Errorf("checking for duplicate: %w", err)
	}

	if isDuplicate {
		span.SetAttributes(attribute.Bool("payment.duplicate", true))
		span.SetStatus(codes.Ok, "duplicate payment rejected")
		return nil, ErrDuplicatePayment
	}

	// Charge via Stripe
	charge, err := p.chargeCard(ctx, req)
	if err != nil {
		span.RecordError(err,
			trace.WithAttributes(
				attribute.String("stripe.error_code", extractStripeErrorCode(err)),
			),
		)
		span.SetStatus(codes.Error, "charge failed")
		return nil, fmt.Errorf("charging card: %w", err)
	}

	// Record successful payment
	span.SetAttributes(
		attribute.String("payment.charge_id", charge.ID),
		attribute.Bool("payment.success", true),
	)
	span.SetStatus(codes.Ok, "payment processed")

	return &PaymentResult{
		ChargeID: charge.ID,
		Status:   "succeeded",
	}, nil
}

func (p *PaymentProcessor) chargeCard(ctx context.Context, req PaymentRequest) (*StripeCharge, error) {
	// Create a child span for the external Stripe API call
	ctx, span := tracer.Start(ctx, "stripe.CreateCharge",
		trace.WithAttributes(
			// Use semantic conventions for HTTP client calls
			semconv.HTTPRequestMethodKey.String("POST"),
			semconv.ServerAddress("api.stripe.com"),
			semconv.ServerPort(443),
			attribute.String("stripe.api_version", "2024-04-10"),
		),
		trace.WithSpanKind(trace.SpanKindClient),
	)
	defer span.End()

	charge, err := p.stripe.CreateCharge(ctx, req.Amount, req.Currency, req.Token)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	span.SetAttributes(
		semconv.HTTPResponseStatusCode(200),
		attribute.String("stripe.charge_id", charge.ID),
	)
	span.SetStatus(codes.Ok, "charge created")
	return charge, nil
}

// Add events to spans for important milestones within an operation
func (p *PaymentProcessor) validateRequest(ctx context.Context, req PaymentRequest) error {
	_, span := tracer.Start(ctx, "validateRequest")
	defer span.End()

	// Add structured events (like log statements, but attached to the trace)
	span.AddEvent("validating amount",
		trace.WithAttributes(
			attribute.Float64("amount", req.Amount),
			attribute.String("currency", req.Currency),
		),
	)

	if req.Amount <= 0 {
		span.AddEvent("validation failed", trace.WithAttributes(
			attribute.String("reason", "amount must be positive"),
		))
		return fmt.Errorf("amount must be positive")
	}

	if len(req.CustomerID) == 0 {
		return fmt.Errorf("customer ID is required")
	}

	span.AddEvent("validation passed")
	return nil
}
```

## HTTP Server Instrumentation

```go
// pkg/server/middleware.go
package server

import (
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
)

// InstrumentedMux wraps an http.ServeMux with OTel instrumentation.
func NewInstrumentedMux() *http.ServeMux {
	mux := http.NewServeMux()
	return mux
}

// Route registers a route with automatic span creation.
func Route(mux *http.ServeMux, pattern string, handler http.HandlerFunc) {
	mux.Handle(pattern,
		otelhttp.NewHandler(handler, pattern,
			otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
			otelhttp.WithSpanOptions(
				// Add custom attributes to all spans from this handler
				// These are added in addition to the standard HTTP attributes
			),
		),
	)
}

// InjectTraceHeaders middleware for outgoing HTTP calls.
// Use this when making HTTP requests to other services.
func InjectTraceHeaders(ctx context.Context, req *http.Request) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// ExtractTraceContext extracts trace context from an incoming HTTP request.
// otelhttp.NewHandler does this automatically — only needed for manual instrumentation.
func ExtractTraceContext(r *http.Request) context.Context {
	return otel.GetTextMapPropagator().Extract(r.Context(),
		propagation.HeaderCarrier(r.Header))
}

// Example instrumented HTTP server
func SetupServer() *http.Server {
	mux := http.NewServeMux()

	// Each route gets its own span with the route pattern as the span name
	mux.Handle("/api/payments",
		otelhttp.NewHandler(
			http.HandlerFunc(handlePayments),
			"POST /api/payments",
		),
	)

	mux.Handle("/api/customers/",
		otelhttp.NewHandler(
			http.HandlerFunc(handleCustomers),
			"GET /api/customers/{id}",
		),
	)

	// Health endpoints should not be traced
	mux.HandleFunc("/healthz", handleHealth)
	mux.HandleFunc("/readyz", handleReady)

	return &http.Server{
		Handler: mux,
		Addr:    ":8080",
	}
}
```

## HTTP Client Instrumentation

```go
// pkg/httpclient/client.go
package httpclient

import (
	"context"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewInstrumentedClient returns an http.Client with OTel instrumentation.
// All requests made with this client will:
// 1. Create a child span
// 2. Inject trace context headers (W3C traceparent) into the request
// 3. Record HTTP attributes (method, status, url)
func NewInstrumentedClient(opts ...otelhttp.Option) *http.Client {
	return &http.Client{
		Transport: otelhttp.NewTransport(
			http.DefaultTransport,
			opts...,
		),
		Timeout: 30 * time.Second,
	}
}

// Example usage
func callExternalService(ctx context.Context, url string) ([]byte, error) {
	client := NewInstrumentedClient(
		otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
			return fmt.Sprintf("%s %s", r.Method, r.URL.Host+r.URL.Path)
		}),
	)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}
```

## gRPC Instrumentation

```go
// pkg/grpc/client.go
package grpclient

import (
	"context"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func NewInstrumentedGRPCClient(target string) (*grpc.ClientConn, error) {
	return grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		// Unary interceptor for request/response calls
		grpc.WithUnaryInterceptor(otelgrpc.UnaryClientInterceptor()),
		// Stream interceptor for streaming calls
		grpc.WithStreamInterceptor(otelgrpc.StreamClientInterceptor()),
	)
}

// pkg/grpc/server.go
func NewInstrumentedGRPCServer() *grpc.Server {
	return grpc.NewServer(
		grpc.UnaryInterceptor(otelgrpc.UnaryServerInterceptor()),
		grpc.StreamInterceptor(otelgrpc.StreamServerInterceptor()),
	)
}
```

## Database Instrumentation

```go
// pkg/database/db.go
package database

import (
	"context"
	"database/sql"
	"fmt"

	"go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	_ "github.com/lib/pq"
)

func NewDB(dsn string) (*sql.DB, error) {
	// Register the instrumented driver
	driverName, err := otelsql.Register("postgres",
		otelsql.WithAttributes(
			semconv.DBSystemPostgreSQL,
		),
		otelsql.WithSpanOptions(
			otelsql.SpanOptions{
				// Include the SQL statement in the span (be careful with PII!)
				OmitConnQuery: false,
				RecordError:   true,
			},
		),
	)
	if err != nil {
		return nil, fmt.Errorf("registering instrumented postgres driver: %w", err)
	}

	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	// Record connection pool stats
	if err := otelsql.RecordStats(db, otelsql.WithAttributes(
		semconv.DBSystemPostgreSQL,
	)); err != nil {
		return nil, fmt.Errorf("recording db stats: %w", err)
	}

	return db, nil
}

// Always pass context to database calls for trace propagation
func (r *UserRepository) GetUser(ctx context.Context, userID int64) (*User, error) {
	// The span "db.query" is automatically created by otelsql
	// It includes: db.system, db.statement, db.operation attributes
	row := r.db.QueryRowContext(ctx,
		"SELECT id, name, email FROM users WHERE id = $1",
		userID,
	)
	var user User
	if err := row.Scan(&user.ID, &user.Name, &user.Email); err != nil {
		return nil, fmt.Errorf("scanning user %d: %w", userID, err)
	}
	return &user, nil
}
```

## Context Propagation

Context propagation is what connects spans across service boundaries into a single trace.

```go
// pkg/propagation/propagation.go
package propagation

import (
	"context"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// InjectHTTP injects trace context into HTTP request headers.
// Call this before making HTTP requests to other services.
func InjectHTTP(ctx context.Context, req *http.Request) {
	otel.GetTextMapPropagator().Inject(ctx,
		propagation.HeaderCarrier(req.Header))
	// Injects: traceparent, tracestate, baggage headers
}

// ExtractHTTP extracts trace context from an incoming HTTP request.
// otelhttp.NewHandler calls this automatically.
func ExtractHTTP(r *http.Request) context.Context {
	return otel.GetTextMapPropagator().Extract(r.Context(),
		propagation.HeaderCarrier(r.Header))
}

// InjectMap injects trace context into a generic string map.
// Use for message queue headers, gRPC metadata, etc.
func InjectMap(ctx context.Context, carrier map[string]string) {
	otel.GetTextMapPropagator().Inject(ctx,
		propagation.MapCarrier(carrier))
}

// ExtractMap extracts trace context from a generic string map.
func ExtractMap(ctx context.Context, carrier map[string]string) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx,
		propagation.MapCarrier(carrier))
}

// The W3C traceparent header format:
// traceparent: 00-{trace-id}-{parent-span-id}-{flags}
// Example: traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
// trace-id: 128-bit hex — ties all spans in a request to one trace
// parent-span-id: 64-bit hex — the span that made this call
// flags: 01 = sampled, 00 = not sampled
```

### Message Queue Propagation (Kafka)

```go
// pkg/messaging/kafka.go
package messaging

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("payment-service/messaging")

// ProduceMessage creates a span and injects trace context into Kafka headers.
func ProduceMessage(ctx context.Context, writer *kafka.Writer, topic string, payload interface{}) error {
	ctx, span := tracer.Start(ctx, fmt.Sprintf("publish %s", topic),
		trace.WithAttributes(
			semconv.MessagingSystemKafka,
			semconv.MessagingOperationPublish,
			semconv.MessagingDestinationName(topic),
		),
		trace.WithSpanKind(trace.SpanKindProducer),
	)
	defer span.End()

	data, err := json.Marshal(payload)
	if err != nil {
		span.RecordError(err)
		return err
	}

	// Inject trace context into Kafka message headers
	headers := make(map[string]string)
	otel.GetTextMapPropagator().Inject(ctx, propagation.MapCarrier(headers))

	msg := kafka.Message{
		Topic: topic,
		Value: data,
	}
	for k, v := range headers {
		msg.Headers = append(msg.Headers, kafka.Header{Key: k, Value: []byte(v)})
	}

	if err := writer.WriteMessages(ctx, msg); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "failed to produce message")
		return err
	}

	span.SetAttributes(
		attribute.Int("messaging.message.body.size", len(data)),
	)
	return nil
}

// ConsumeMessage extracts trace context from Kafka message headers.
func ConsumeMessage(ctx context.Context, msg kafka.Message) context.Context {
	// Extract headers into a map
	headers := make(map[string]string)
	for _, h := range msg.Headers {
		headers[h.Key] = string(h.Value)
	}

	// Extract trace context from headers — this links the consumer span to the producer
	return otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(headers))
}
```

## Sampling Strategies

```go
// pkg/telemetry/sampling.go
package telemetry

import (
	"go.opentelemetry.io/otel/sdk/trace"
)

// ProductionSampler creates a sampler appropriate for production:
// - Always sample error responses
// - Always sample slow requests (added via custom span processor)
// - Sample 1% of successful fast requests
func ProductionSampler() trace.Sampler {
	return trace.ParentBased(
		// Root spans: trace ID ratio sampling at 1%
		trace.TraceIDRatioBased(0.01),
		// Child spans: respect parent's sampling decision
		// This ensures entire traces are either fully sampled or not at all
	)
}

// AdaptiveSampler samples more aggressively at low request rates.
// Uses ParentBased to ensure consistency across a trace.
func AdaptiveSampler() trace.Sampler {
	return trace.ParentBased(
		&tailSampler{
			errorRate:   1.0,   // 100% of errors
			latencyRate: 1.0,   // 100% of slow requests
			normalRate:  0.01,  // 1% of normal requests
			slowThresholdMs: 500,
		},
	)
}

// Custom sampler that always samples errors and slow requests
type tailSampler struct {
	errorRate       float64
	latencyRate     float64
	normalRate      float64
	slowThresholdMs int64
}

func (s *tailSampler) ShouldSample(p trace.SamplingParameters) trace.SamplingResult {
	// Check if this is a root span (no parent)
	if p.ParentContext.IsRemote() || !p.ParentContext.IsValid() {
		// Defer: return a sampler that will check the attributes after the span ends
		// Note: True tail-based sampling requires a separate collector component
		// This is a head-based approximation
		return trace.SamplingResult{
			Decision:   trace.RecordAndSample,
			Tracestate: p.TraceState,
		}
	}

	// For child spans, respect parent's decision
	if p.ParentContext.IsSampled() {
		return trace.SamplingResult{
			Decision:   trace.RecordAndSample,
			Tracestate: p.TraceState,
		}
	}

	return trace.SamplingResult{
		Decision:   trace.Drop,
		Tracestate: p.TraceState,
	}
}

func (s *tailSampler) Description() string {
	return "TailSampler"
}
```

## The Baggage API

Baggage propagates key-value pairs alongside the trace context. It is carried in the W3C `baggage` header and is readable by all services in the call chain. Use it for metadata like user ID, tenant ID, or feature flags.

```go
// pkg/baggage/baggage.go
package baggage

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/trace"
)

// SetUserContext adds user context to baggage for downstream services.
func SetUserContext(ctx context.Context, userID, tenantID, region string) (context.Context, error) {
	// Create baggage members
	userMember, err := baggage.NewMember("user.id", userID)
	if err != nil {
		return ctx, fmt.Errorf("creating user.id baggage member: %w", err)
	}

	tenantMember, err := baggage.NewMember("tenant.id", tenantID)
	if err != nil {
		return ctx, fmt.Errorf("creating tenant.id baggage member: %w", err)
	}

	regionMember, err := baggage.NewMember("region", region)
	if err != nil {
		return ctx, fmt.Errorf("creating region baggage member: %w", err)
	}

	// Create the baggage set
	b, err := baggage.New(userMember, tenantMember, regionMember)
	if err != nil {
		return ctx, fmt.Errorf("creating baggage: %w", err)
	}

	return baggage.ContextWithBaggage(ctx, b), nil
}

// GetUserContext retrieves user context from baggage.
func GetUserContext(ctx context.Context) (userID, tenantID, region string) {
	b := baggage.FromContext(ctx)
	return b.Member("user.id").Value(),
		b.Member("tenant.id").Value(),
		b.Member("region").Value()
}

// PropagateToSpan copies baggage values into span attributes.
// This makes them searchable/filterable in trace backends.
func PropagateToSpan(ctx context.Context, span trace.Span) {
	b := baggage.FromContext(ctx)
	for _, member := range b.Members() {
		span.SetAttributes(
			attribute.String("baggage."+member.Key(), member.Value()),
		)
	}
}
```

### Using Baggage in Middleware

```go
// pkg/middleware/auth.go
package middleware

import (
	"net/http"

	"myapp/pkg/baggage"
)

// AuthMiddleware extracts user context and sets baggage.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract user from JWT or session
		userID := extractUserID(r)
		tenantID := extractTenantID(r)

		// Add to baggage — propagates to all downstream services automatically
		ctx, err := baggage.SetUserContext(r.Context(), userID, tenantID, "us-east-1")
		if err != nil {
			// Log but don't fail the request for baggage errors
			slog.Warn("failed to set baggage", "error", err)
			next.ServeHTTP(w, r)
			return
		}

		// Also set on the current span so it's visible in the trace
		span := trace.SpanFromContext(ctx)
		span.SetAttributes(
			attribute.String("user.id", userID),
			attribute.String("tenant.id", tenantID),
		)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

## Exporter Configuration for Production Backends

### Grafana Tempo

```yaml
# Kubernetes ConfigMap for OTel Collector configuration
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
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch:
        timeout: 1s
        send_batch_size: 1024
      memory_limiter:
        check_interval: 1s
        limit_mib: 1000
        spike_limit_mib: 200
      # Add service name and environment attributes
      resource:
        attributes:
          - key: deployment.environment
            value: production
            action: upsert

    exporters:
      otlp/tempo:
        endpoint: tempo.monitoring.svc.cluster.local:4317
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch, resource]
          exporters: [otlp/tempo]
```

### Jaeger Direct Export

```go
// pkg/telemetry/jaeger.go
package telemetry

import (
	"go.opentelemetry.io/otel/exporters/jaeger"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func NewJaegerExporter(endpoint string) (sdktrace.SpanExporter, error) {
	// Direct Jaeger export (without collector)
	return jaeger.New(
		jaeger.WithCollectorEndpoint(
			jaeger.WithEndpoint(endpoint),
			// e.g., http://jaeger:14268/api/traces
		),
	)
}

// Or via Jaeger agent (UDP)
func NewJaegerAgentExporter(host, port string) (sdktrace.SpanExporter, error) {
	return jaeger.New(
		jaeger.WithAgentEndpoint(
			jaeger.WithAgentHost(host),
			jaeger.WithAgentPort(port),
		),
	)
}
```

## Kubernetes OTel Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-go-service
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: app
          image: my-go-service:2.3.1
          env:
            # OTel auto-configuration via environment variables
            - name: OTEL_SERVICE_NAME
              value: "my-go-service"
            - name: OTEL_SERVICE_VERSION
              valueFrom:
                fieldRef:
                  fieldPath: metadata.labels['app.kubernetes.io/version']
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector.monitoring.svc.cluster.local:4317"
            - name: OTEL_EXPORTER_OTLP_PROTOCOL
              value: "grpc"
            - name: OTEL_TRACES_SAMPLER
              value: "parentbased_traceidratio"
            - name: OTEL_TRACES_SAMPLER_ARG
              value: "0.1"
            # Add pod information as resource attributes
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),k8s.node.name=$(NODE_NAME)"
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
```

## Summary

OpenTelemetry Go provides a complete, vendor-neutral distributed tracing implementation. The key practices for production: initialize the SDK once at startup with a `ParentBased` sampler that respects sampling decisions from parent services; use `otelhttp`, `otelgrpc`, and `otelsql` instrumentation libraries instead of hand-instrumented code for the common cases; always propagate context through every layer including message queues; use the Baggage API for cross-service metadata that needs to be visible throughout a trace; and deploy the OpenTelemetry Collector as a sidecar or daemonset to decouple your application from the tracing backend. The `OTLP` exporter provides backend portability — switching from Jaeger to Tempo to Honeycomb requires only collector configuration changes, not application code changes.
