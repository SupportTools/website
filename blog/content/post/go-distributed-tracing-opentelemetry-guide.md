---
title: "Distributed Tracing in Go with OpenTelemetry: Spans, Baggage, and Sampling"
date: 2028-02-22T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Distributed Tracing", "Observability", "gRPC", "Kubernetes"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to OpenTelemetry Go SDK: tracer provider setup, span lifecycle, W3C TraceContext propagation across HTTP and gRPC, baggage, tail-based sampling with the OTel Collector, and Jaeger/Tempo integration."
more_link: "yes"
url: "/go-distributed-tracing-opentelemetry-guide/"
---

Distributed tracing gives production teams the one artifact that metrics and logs alone cannot provide: a causal chain across service boundaries. When a p99 latency spike appears in a dashboard, tracing reveals which downstream call introduced the delay, which database query held the lock, and which retry storm amplified the effect. OpenTelemetry has consolidated the tracing instrumentation landscape; every major backend—Jaeger, Tempo, Zipkin, Datadog, Honeycomb—accepts OTLP, so instrumentation written today works against any future backend without code changes.

This guide covers the complete Go OpenTelemetry SDK from initialization through production deployment, including span lifecycle management, context propagation across HTTP and gRPC transports, W3C TraceContext and Baggage APIs, and tail-based sampling with the OpenTelemetry Collector.

<!--more-->

# Distributed Tracing in Go with OpenTelemetry: Spans, Baggage, and Sampling

## Prerequisites and Module Setup

The OpenTelemetry Go SDK follows a provider/API separation: application code imports the stable API packages, while the SDK (and its exporters) are wired at startup. This allows library authors to add instrumentation without forcing end-users onto a specific exporter.

```bash
# Core SDK and OTLP gRPC exporter
go get go.opentelemetry.io/otel@v1.24.0
go get go.opentelemetry.io/otel/sdk@v1.24.0
go get go.opentelemetry.io/otel/sdk/trace@v1.24.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.24.0

# Propagation (W3C TraceContext + Baggage)
go get go.opentelemetry.io/otel/propagators/b3@v1.24.0

# HTTP and gRPC instrumentation bridges
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.49.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.49.0

# Resource detection (reads k8s downward API, process, OS)
go get go.opentelemetry.io/contrib/detectors/aws/eks@v1.24.0
go get go.opentelemetry.io/otel/sdk/resource@v1.24.0
```

## Tracer Provider Initialization

The `TracerProvider` is the root factory. It holds the exporter pipeline, sampler, and resource attributes. Initializing it once at process startup and shutting it down gracefully on SIGTERM ensures all in-flight spans are flushed before the process exits.

```go
// tracing/provider.go
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
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds all tunable parameters for the tracer provider.
type Config struct {
	ServiceName    string        // maps to resource attribute service.name
	ServiceVersion string        // maps to service.version
	Environment    string        // deployment.environment (production/staging/dev)
	OTLPEndpoint   string        // host:port of the OTel Collector gRPC receiver
	SamplingRatio  float64       // 0.0–1.0 for TraceIDRatio sampler; 1.0 = always sample
	BatchTimeout   time.Duration // maximum time before a batch is exported
	ExportTimeout  time.Duration // per-export RPC deadline
}

// DefaultConfig returns conservative production defaults.
func DefaultConfig(svc, version, env string) Config {
	return Config{
		ServiceName:    svc,
		ServiceVersion: version,
		Environment:    env,
		OTLPEndpoint:   "otel-collector:4317",
		SamplingRatio:  0.1, // 10% head-based sample; complement with tail sampling in collector
		BatchTimeout:   5 * time.Second,
		ExportTimeout:  10 * time.Second,
	}
}

// InitProvider creates, registers, and returns a *TracerProvider with a
// shutdown function.  Call shutdown() in a defer or on SIGTERM to flush
// pending spans.
func InitProvider(ctx context.Context, cfg Config) (shutdown func(context.Context) error, err error) {
	// 1. Build the OTLP/gRPC exporter.
	//    In production, replace insecure with TLS credentials.
	conn, err := grpc.NewClient(
		cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create gRPC connection to collector: %w", err)
	}

	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithGRPCConn(conn),
		otlptracegrpc.WithTimeout(cfg.ExportTimeout),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create OTLP trace exporter: %w", err)
	}

	// 2. Build the resource: semantic conventions for service identity.
	//    The SDK merges this with auto-detected attributes (hostname, OS, runtime).
	res, err := resource.New(ctx,
		resource.WithFromEnv(),        // reads OTEL_RESOURCE_ATTRIBUTES env var
		resource.WithProcess(),        // pid, executable name, runtime version
		resource.WithOS(),             // os.type, os.description
		resource.WithContainer(),      // container.id from /proc/1/cgroup
		resource.WithHost(),           // host.name
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to build resource: %w", err)
	}

	// 3. Compose the sampler.
	//    ParentBased ensures that if the upstream decided to sample, this
	//    service samples too — preserving complete traces.
	sampler := sdktrace.ParentBased(
		sdktrace.TraceIDRatioBased(cfg.SamplingRatio),
		// If remote parent was sampled, always sample locally.
		sdktrace.WithRemoteSampledParentSampler(sdktrace.AlwaysSample()),
		// If remote parent was NOT sampled, respect that decision.
		sdktrace.WithRemoteUnsampled(sdktrace.NeverSample()),
	)

	// 4. Build the TracerProvider with a batch span processor.
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter,
			sdktrace.WithBatchTimeout(cfg.BatchTimeout),
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithMaxQueueSize(2048),
		),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)

	// 5. Register globally so otel.Tracer("name") works anywhere in the process.
	otel.SetTracerProvider(tp)

	// 6. Set the global propagator: W3C TraceContext for traceparent/tracestate
	//    headers, and W3C Baggage for cross-service key-value propagation.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	shutdown = func(ctx context.Context) error {
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("failed to shutdown tracer provider: %w", err)
		}
		conn.Close()
		return nil
	}

	return shutdown, nil
}
```

### Wiring Into main()

```go
// main.go
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/myservice/tracing"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := tracing.DefaultConfig(
		os.Getenv("SERVICE_NAME"),
		os.Getenv("SERVICE_VERSION"),
		os.Getenv("DEPLOY_ENV"),
	)
	if ratio := os.Getenv("OTEL_SAMPLING_RATIO"); ratio != "" {
		// Allow overriding sampling ratio per environment.
		// Production may run at 0.01 (1%); staging at 1.0 (100%).
		if _, err := fmt.Sscanf(ratio, "%f", &cfg.SamplingRatio); err != nil {
			log.Printf("invalid OTEL_SAMPLING_RATIO %q, using default %f", ratio, cfg.SamplingRatio)
		}
	}

	shutdown, err := tracing.InitProvider(ctx, cfg)
	if err != nil {
		log.Fatalf("failed to initialize tracing: %v", err)
	}

	// Flush spans on shutdown with a generous deadline.
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := shutdown(flushCtx); err != nil {
			log.Printf("error shutting down tracer provider: %v", err)
		}
	}()

	// ... start HTTP/gRPC servers
	runServer(ctx)
}
```

## Span Lifecycle: Start, Attributes, Events, and End

A span represents a unit of work. The critical rule: every span started must be ended, even on error paths. Leaked spans are never exported and waste memory in the SDK's internal queue.

```go
// service/order.go
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

// tracer is package-level; the name should be the import path of the package
// that creates spans.  This becomes the instrumentation.name attribute.
var tracer = otel.Tracer("github.com/example/myservice/service")

// OrderRequest and OrderResult represent the service contract.
type OrderRequest struct {
	CustomerID string
	Items      []OrderItem
	Region     string
}

type OrderItem struct {
	SKU      string
	Quantity int
	Price    float64
}

type OrderResult struct {
	OrderID       string
	TotalAmount   float64
	EstimatedShip time.Time
}

// ProcessOrder demonstrates the full span lifecycle.
func ProcessOrder(ctx context.Context, req OrderRequest) (OrderResult, error) {
	// Start a span.  The span name follows the convention "service/operation".
	// The returned context carries the active span; always thread it through.
	ctx, span := tracer.Start(ctx, "service.ProcessOrder",
		// SpanKind describes the relationship with the caller/callee.
		trace.WithSpanKind(trace.SpanKindServer),
		// Attributes set at creation time are more efficient than SetAttributes
		// because they avoid a second map allocation.
		trace.WithAttributes(
			attribute.String("order.customer_id", req.CustomerID),
			attribute.String("order.region", req.Region),
			attribute.Int("order.item_count", len(req.Items)),
		),
	)
	// defer span.End() must come immediately after Start — before any early returns.
	defer span.End()

	// Add attributes discovered during processing (not available at Start time).
	totalAmount := calculateTotal(req.Items)
	span.SetAttributes(
		attribute.Float64("order.total_amount", totalAmount),
		attribute.String("order.currency", "USD"),
	)

	// Events are timestamped log entries attached to the span.
	// Use them for significant state transitions within the operation.
	span.AddEvent("validation_started")

	if err := validateOrder(ctx, req); err != nil {
		// Record the error on the span: sets span status to Error and
		// stores the error message as span.status.message.
		span.RecordError(err,
			trace.WithAttributes(
				attribute.String("validation.error_type", errorType(err)),
			),
		)
		span.SetStatus(codes.Error, err.Error())
		return OrderResult{}, fmt.Errorf("order validation failed: %w", err)
	}

	span.AddEvent("validation_completed", trace.WithAttributes(
		attribute.Bool("validation.passed", true),
	))

	// Propagate the instrumented context to child operations.
	orderID, err := persistOrder(ctx, req, totalAmount)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "failed to persist order")
		return OrderResult{}, fmt.Errorf("persist order: %w", err)
	}

	span.SetAttributes(attribute.String("order.id", orderID))
	span.AddEvent("order_persisted", trace.WithAttributes(
		attribute.String("order.id", orderID),
	))

	// On success, set status to OK explicitly.
	span.SetStatus(codes.Ok, "")

	result := OrderResult{
		OrderID:       orderID,
		TotalAmount:   totalAmount,
		EstimatedShip: time.Now().Add(48 * time.Hour),
	}
	return result, nil
}

// persistOrder creates a child span for the database write operation.
func persistOrder(ctx context.Context, req OrderRequest, total float64) (string, error) {
	// Child spans inherit the trace ID and parent span ID from ctx.
	ctx, span := tracer.Start(ctx, "db.InsertOrder",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "postgresql"),
			attribute.String("db.name", "orders"),
			attribute.String("db.operation", "INSERT"),
			attribute.String("db.sql.table", "orders"),
		),
	)
	defer span.End()

	// Simulate DB operation timing.
	start := time.Now()
	orderID, err := db.InsertOrder(ctx, req, total) // your DB layer
	span.SetAttributes(attribute.Float64("db.duration_ms", float64(time.Since(start).Milliseconds())))

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return "", err
	}

	span.SetStatus(codes.Ok, "")
	return orderID, nil
}
```

### Link Spans for Fan-Out and Async Patterns

When a span causally relates to another trace (e.g., a message consumer processing a message that was produced in a different trace), use span links rather than a parent-child relationship:

```go
// consumer/processor.go
package consumer

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("github.com/example/myservice/consumer")

// Message carries the serialized span context from the producer.
type Message struct {
	Body              []byte
	TraceCarrier      map[string]string // extracted from message headers
}

// ProcessMessage creates a new root span but links it to the producer span.
func ProcessMessage(ctx context.Context, msg Message) error {
	// Extract the remote span context from the message carrier.
	producerCtx := otel.GetTextMapPropagator().Extract(
		context.Background(), // new root context; do NOT use the consumer's ctx
		propagation.MapCarrier(msg.TraceCarrier),
	)
	producerSpanCtx := trace.SpanContextFromContext(producerCtx)

	// Start a new trace rooted here, but linked to the producer trace.
	// This preserves causality without coupling the two traces into one.
	ctx, span := tracer.Start(ctx, "consumer.ProcessMessage",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithLinks(trace.Link{
			SpanContext: producerSpanCtx,
			Attributes: []attribute.KeyValue{
				attribute.String("messaging.link.type", "producer"),
			},
		}),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", "orders.created"),
			attribute.String("messaging.operation", "receive"),
		),
	)
	defer span.End()

	return handleMessage(ctx, msg.Body)
}
```

## HTTP Instrumentation with otelhttp

The `otelhttp` middleware handles the W3C TraceContext header extraction from incoming requests and creates server spans automatically:

```go
// server/http.go
package server

import (
	"encoding/json"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("github.com/example/myservice/server")

// NewHTTPServer returns a mux wrapped with OTel middleware.
func NewHTTPServer() http.Handler {
	mux := http.NewServeMux()

	// Register routes with their span name explicitly set.
	// The route pattern becomes the span name, keeping cardinality bounded.
	mux.Handle("/api/v1/orders",
		otelhttp.NewHandler(http.HandlerFunc(handleCreateOrder), "POST /api/v1/orders",
			otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
				// Use the route pattern, not the full URL, to avoid high-cardinality spans.
				return op // already the constant above
			}),
		),
	)
	mux.Handle("/api/v1/orders/",
		otelhttp.NewHandler(http.HandlerFunc(handleGetOrder), "GET /api/v1/orders/:id"),
	)

	// Wrap the entire mux for request-level attributes (method, status code, etc.)
	return otelhttp.NewHandler(mux, "http.server",
		otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
	)
}

// handleCreateOrder shows how to enrich the automatically created server span.
func handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	// Retrieve the current span created by otelhttp middleware.
	span := trace.SpanFromContext(r.Context())

	var req OrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		span.RecordError(err)
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Add business-level attributes to the server span.
	span.SetAttributes(
		attribute.String("order.customer_id", req.CustomerID),
		attribute.String("order.region", req.Region),
		attribute.Int("order.item_count", len(req.Items)),
	)

	result, err := service.ProcessOrder(r.Context(), req)
	if err != nil {
		span.RecordError(err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// OutboundHTTPClient returns an http.Client that injects traceparent into outbound requests.
func OutboundHTTPClient() *http.Client {
	return &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport,
			otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
				// For client spans, use method + host + path-template (not full URL).
				return r.Method + " " + r.URL.Host + r.URL.Path
			}),
		),
	}
}
```

## gRPC Instrumentation with otelgrpc

```go
// server/grpc.go
package server

import (
	"google.golang.org/grpc"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

// NewGRPCServer returns a gRPC server with tracing interceptors.
func NewGRPCServer() *grpc.Server {
	return grpc.NewServer(
		// Stats handlers replace interceptors in newer versions of otelgrpc.
		// They instrument streaming RPCs correctly, unlike unary-only interceptors.
		grpc.StatsHandler(otelgrpc.NewServerHandler(
			otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
		)),
	)
}

// NewGRPCClientConn returns a gRPC client connection that propagates trace context.
func NewGRPCClientConn(target string) (*grpc.ClientConn, error) {
	return grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler(
			otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
		)),
	)
}
```

## W3C Baggage: Cross-Service Key-Value Propagation

Baggage carries arbitrary key-value pairs alongside the trace context. Unlike span attributes (which are local to one service), baggage values are propagated to every downstream service in the request chain. Use baggage for data that all services need to include in their spans (tenant ID, feature flag experiment ID, A/B test cohort).

```go
// middleware/baggage.go
package middleware

import (
	"context"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/trace"
)

// TenantBaggageMiddleware extracts the tenant ID from the JWT/header,
// injects it into baggage, and sets it as a span attribute.
// All downstream services will read it from baggage.
func TenantBaggageMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenantID := extractTenantID(r) // reads X-Tenant-ID or decodes JWT
		if tenantID == "" {
			next.ServeHTTP(w, r)
			return
		}

		// Create a baggage member.
		// Key names follow W3C spec: lowercase alphanumeric + limited symbols.
		member, err := baggage.NewMember("tenant.id", tenantID)
		if err != nil {
			// Baggage is best-effort; don't fail the request.
			next.ServeHTTP(w, r)
			return
		}

		bag, err := baggage.New(member)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}

		// Store baggage in the context; the global propagator will serialize
		// it into the "baggage" HTTP header on outbound requests.
		ctx := baggage.ContextWithBaggage(r.Context(), bag)

		// Also set the tenant ID as a span attribute on the current span
		// so it appears in the trace backend without requiring a baggage lookup.
		span := trace.SpanFromContext(ctx)
		span.SetAttributes(attribute.String("tenant.id", tenantID))

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ReadTenantFromBaggage reads tenant.id baggage in a downstream service.
// The otelhttp middleware already extracted the baggage header into the context.
func ReadTenantFromBaggage(ctx context.Context) string {
	bag := baggage.FromContext(ctx)
	member := bag.Member("tenant.id")
	return member.Value()
}
```

### Adding Experiment Context via Baggage

```go
// A/B test experiment propagation across the service mesh.
func InjectExperimentBaggage(ctx context.Context, experimentID, cohort string) context.Context {
	bag := baggage.FromContext(ctx)

	expMember, _ := baggage.NewMember("experiment.id", experimentID)
	cohortMember, _ := baggage.NewMember("experiment.cohort", cohort)

	newBag, _ := bag.SetMember(expMember)
	newBag, _ = newBag.SetMember(cohortMember)

	// Apply as span attributes to the local span as well.
	trace.SpanFromContext(ctx).SetAttributes(
		attribute.String("experiment.id", experimentID),
		attribute.String("experiment.cohort", cohort),
	)

	return baggage.ContextWithBaggage(ctx, newBag)
}
```

## Manual Context Propagation

When crossing transport boundaries that are not automatically instrumented (message queues, task queues, custom protocols), manually inject and extract the trace context:

```go
// messaging/producer.go
package messaging

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("github.com/example/myservice/messaging")

// KafkaMessage is the wire format including the trace carrier.
type KafkaMessage struct {
	Key     string
	Value   []byte
	Headers map[string]string // W3C traceparent + baggage headers go here
}

// ProduceOrder creates a producer span and injects the trace context
// into the Kafka message headers.
func ProduceOrder(ctx context.Context, orderID string, payload []byte) (KafkaMessage, error) {
	ctx, span := tracer.Start(ctx, "messaging.ProduceOrder",
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", "orders.created"),
			attribute.String("messaging.destination_kind", "topic"),
			attribute.String("messaging.message_id", orderID),
			attribute.String("messaging.operation", "publish"),
		),
	)
	defer span.End()

	// Inject propagates "traceparent", "tracestate", and "baggage" headers
	// into the carrier map using the globally registered propagator.
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)

	msg := KafkaMessage{
		Key:     orderID,
		Value:   payload,
		Headers: map[string]string(carrier),
	}

	span.SetStatus(codes.Ok, "")
	return msg, nil
}

// messaging/consumer.go

// ConsumeOrder extracts the trace context from message headers and
// creates a new consumer span linked to the producer span.
func ConsumeOrder(ctx context.Context, msg KafkaMessage) error {
	// Extract creates a context containing the remote SpanContext.
	// This does NOT make the remote span the active span; it stores
	// the span context for use by the next Start() call as the parent.
	remoteCtx := otel.GetTextMapPropagator().Extract(
		ctx,
		propagation.MapCarrier(msg.Headers),
	)

	ctx, span := tracer.Start(remoteCtx, "messaging.ConsumeOrder",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", "orders.created"),
			attribute.String("messaging.operation", "receive"),
			attribute.String("messaging.message_id", msg.Key),
		),
	)
	defer span.End()

	if err := processPayload(ctx, msg.Value); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	span.SetStatus(codes.Ok, "")
	return nil
}
```

## Tail-Based Sampling with the OTel Collector

Head-based sampling (decided at trace root) is simple but discards interesting traces: a 1% sample will miss 99% of errors if they're rare. Tail-based sampling defers the decision until the entire trace has been received, enabling policies like "always keep traces with errors" or "always keep traces over 2 seconds latency".

### OTel Collector Configuration

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
  # The tail_sampling processor buffers spans until the trace is "complete"
  # (all spans received) then applies policy-based decisions.
  tail_sampling:
    # How long to wait for all spans of a trace to arrive.
    # Set this to at least 2x the max expected trace duration.
    decision_wait: 30s
    # Number of trace ID to decision mappings to maintain in memory.
    num_traces: 100000
    # expected_new_traces_per_sec is used for internal buffer sizing.
    expected_new_traces_per_sec: 1000
    policies:
      # Policy 1: Always sample traces that contain errors.
      - name: sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Policy 2: Always sample traces where any span exceeds 2 seconds.
      - name: sample-slow-traces
        type: latency
        latency:
          threshold_ms: 2000

      # Policy 3: Always sample traces from the payment service.
      # Use this for critical paths where 100% visibility is required.
      - name: sample-payment-service
        type: string_attribute
        string_attribute:
          key: service.name
          values: [payment-service, fraud-detection]

      # Policy 4: Rate-limit healthy fast traces to 5%.
      # This is a composite: healthy AND fast AND passes rate limiter.
      - name: sample-healthy-traces
        type: composite
        composite:
          max_total_spans_per_second: 10000
          policy_order: [healthy, not-slow, rate-limited]
          composite_sub_policy:
            - name: healthy
              type: status_code
              status_code:
                status_codes: [OK, UNSET]
            - name: not-slow
              type: latency
              latency:
                threshold_ms: 2000
                upper_threshold_ms: 99999999 # no upper limit trick: invert
            - name: rate-limited
              type: probabilistic
              probabilistic:
                sampling_percentage: 5

  # Batch spans before exporting to reduce RPC overhead.
  batch:
    send_batch_size: 1024
    timeout: 5s
    send_batch_max_size: 2048

  # Add metadata attributes for routing and filtering in the backend.
  resource:
    attributes:
      - key: collector.processed_by
        value: otel-collector-prod
        action: insert

  # Memory limiter prevents OOM during traffic spikes.
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

exporters:
  # Jaeger (via OTLP)
  otlp/jaeger:
    endpoint: jaeger-collector:4317
    tls:
      insecure: true

  # Grafana Tempo
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

  # Debug exporter for troubleshooting (disabled in production)
  debug:
    verbosity: basic
    sampling_initial: 5
    sampling_thereafter: 100

  # Prometheus exporter for collector self-metrics
  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: otelcol

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, resource, batch]
      exporters: [otlp/tempo]

  # Extension for health checks and pprof
  extensions: [health_check, pprof]

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:
    endpoint: 0.0.0.0:1777
```

### Kubernetes Deployment for the OTel Collector

```yaml
# otel-collector-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
  labels:
    app.kubernetes.io/name: otel-collector
    app.kubernetes.io/component: tracing
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: otel-collector
  template:
    metadata:
      labels:
        app.kubernetes.io/name: otel-collector
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8889"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.96.0
          args:
            - --config=/conf/otel-collector-config.yaml
          ports:
            - name: otlp-grpc
              containerPort: 4317
              protocol: TCP
            - name: otlp-http
              containerPort: 4318
              protocol: TCP
            - name: metrics
              containerPort: 8889
              protocol: TCP
            - name: health
              containerPort: 13133
              protocol: TCP
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /
              port: health
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /
              port: health
            initialDelaySeconds: 5
            periodSeconds: 10
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
  namespace: observability
spec:
  selector:
    app.kubernetes.io/name: otel-collector
  ports:
    - name: otlp-grpc
      port: 4317
      targetPort: otlp-grpc
    - name: otlp-http
      port: 4318
      targetPort: otlp-http
    - name: metrics
      port: 8889
      targetPort: metrics
---
# HorizontalPodAutoscaler: scale on memory (tail_sampling buffers grow with load)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otel-collector
  namespace: observability
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otel-collector
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
```

## Prometheus Exemplars: Bridging Metrics and Traces

Exemplars attach a sample trace ID to a histogram bucket, creating a direct link from a slow p99 bucket in Grafana to the specific trace that caused it.

```go
// metrics/exemplar.go
package metrics

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/trace"
)

var (
	// Use NativeHistogram for high-resolution buckets without pre-defining ranges.
	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:                            "http_request_duration_seconds",
			Help:                            "HTTP request latency with exemplars for trace linking.",
			NativeHistogramBucketFactor:     1.1,
			NativeHistogramMaxBucketNumber:  100,
			NativeHistogramMinResetDuration: 1 * time.Hour,
		},
		[]string{"method", "path", "status_code"},
	)
)

func init() {
	prometheus.MustRegister(httpRequestDuration)
}

// ObserveWithExemplar records a histogram observation and attaches the
// current span's trace ID as an exemplar.  Grafana Tempo will use this
// to provide the "jump to trace" link in panels.
func ObserveWithExemplar(ctx context.Context, duration float64, labels prometheus.Labels) {
	spanCtx := trace.SpanContextFromContext(ctx)
	if !spanCtx.IsValid() {
		// No active span; record without exemplar.
		httpRequestDuration.With(labels).Observe(duration)
		return
	}

	// prometheus.ExemplarObserver is implemented by histograms.
	observer, ok := httpRequestDuration.With(labels).(prometheus.ExemplarObserver)
	if !ok {
		httpRequestDuration.With(labels).Observe(duration)
		return
	}

	observer.ObserveWithExemplar(duration, prometheus.Labels{
		// The exemplar label key "traceID" is recognized by Grafana datasources
		// configured with exemplarTraceIdDestinations pointing to Tempo.
		"traceID": spanCtx.TraceID().String(),
		// Include the span ID for precise lookup within the trace.
		"spanID": spanCtx.SpanID().String(),
	})
}

// InstrumentedHandler wraps an http.Handler to record duration with exemplars.
func InstrumentedHandler(path string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()
		ObserveWithExemplar(r.Context(), duration, prometheus.Labels{
			"method":      r.Method,
			"path":        path,
			"status_code": strconv.Itoa(rw.statusCode),
		})
	})
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}
```

## Debugging and Testing Traces

### In-Process Span Exporter for Tests

```go
// tracing/testutil/exporter.go
package testutil

import (
	"context"
	"sync"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// SetupTestTracer installs an in-memory span exporter and returns
// a function to retrieve all recorded spans.  Call in TestMain or
// each test function that needs span verification.
func SetupTestTracer(t *testing.T) func() []tracetest.SpanStub {
	t.Helper()

	exporter := tracetest.NewInMemoryExporter()
	tp := trace.NewTracerProvider(
		trace.WithSyncer(exporter), // synchronous: spans are available immediately
		trace.WithSampler(trace.AlwaysSample()),
	)
	otel.SetTracerProvider(tp)

	t.Cleanup(func() {
		tp.Shutdown(context.Background())
		otel.SetTracerProvider(otel.NewNoopTracerProvider())
	})

	return func() []tracetest.SpanStub {
		return exporter.GetSpans()
	}
}

// Example test using SetupTestTracer:

func TestProcessOrderCreatesSpan(t *testing.T) {
	getSpans := testutil.SetupTestTracer(t)

	req := service.OrderRequest{
		CustomerID: "cust-001",
		Items:      []service.OrderItem{{SKU: "SKU-A", Quantity: 2, Price: 19.99}},
		Region:     "us-east-1",
	}

	ctx := context.Background()
	_, err := service.ProcessOrder(ctx, req)
	require.NoError(t, err)

	spans := getSpans()
	require.Len(t, spans, 2) // ProcessOrder + persistOrder

	rootSpan := spans[len(spans)-1] // root span is last in depth-first order
	assert.Equal(t, "service.ProcessOrder", rootSpan.Name)
	assert.Equal(t, trace.SpanKindServer, rootSpan.SpanKind)

	// Verify required attributes are set.
	attrs := spanAttrsMap(rootSpan)
	assert.Equal(t, "cust-001", attrs["order.customer_id"])
	assert.Equal(t, "us-east-1", attrs["order.region"])
	assert.Equal(t, int64(1), attrs["order.item_count"])
}
```

## Kubernetes Deployment: Environment Variables and ConfigMap

```yaml
# k8s/deployment-tracing.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: order-service
          image: myregistry/order-service:v2.1.0
          env:
            # Service identity for resource attributes
            - name: SERVICE_NAME
              value: "order-service"
            - name: SERVICE_VERSION
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['app.kubernetes.io/version']
            - name: DEPLOY_ENV
              value: "production"
            # OTel SDK environment variables (take precedence over code defaults)
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector.observability:4317"
            - name: OTEL_EXPORTER_OTLP_PROTOCOL
              value: "grpc"
            - name: OTEL_SERVICE_NAME
              value: "order-service"
            # 1% head-based sampling in production; tail sampling in collector handles the rest
            - name: OTEL_SAMPLING_RATIO
              value: "0.01"
            # Propagation: W3C traceparent + baggage (default, but explicit is safer)
            - name: OTEL_PROPAGATORS
              value: "tracecontext,baggage"
            # Resource attributes from the pod metadata (injected by downward API)
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(NAMESPACE),k8s.node.name=$(NODE_NAME)"
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
```

## Connecting to Grafana Tempo

```yaml
# grafana-datasource-tempo.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  tempo.yaml: |
    apiVersion: 1
    datasources:
      - name: Tempo
        type: tempo
        url: http://tempo.observability:3100
        access: proxy
        isDefault: false
        jsonData:
          # Enables the "Search" tab in the Explore view.
          search:
            hide: false
          # Links traces back to Prometheus metrics using span attributes.
          serviceMap:
            datasourceUid: prometheus
          # Enables span log correlation using logs.spanID attribute.
          lokiSearch:
            datasourceUid: loki
          # Maps the exemplar traceID label to the Tempo datasource
          # so Grafana renders "Jump to trace" buttons in histogram panels.
          tracesToLogsV2:
            datasourceUid: loki
            spanStartTimeShift: "-1m"
            spanEndTimeShift: "1m"
            filterByTraceID: true
            filterBySpanID: true
            customQuery: true
            query: "{job=\"$${__span.tags.service.name}\"} |= \"$${__span.traceId}\""
          nodeGraph:
            enabled: true
          spanBar:
            type: Tag
            tag: http.status_code
```

## Production Troubleshooting

### Diagnosing Missing Spans

```bash
#!/bin/bash
# diagnose-tracing.sh — verify trace pipeline health

# Check OTel Collector is receiving spans
kubectl -n observability logs deploy/otel-collector --since=5m | \
  grep -E "tail_sampling|dropped|refused"

# Inspect collector self-metrics
kubectl -n observability port-forward svc/otel-collector 8889:8889 &
curl -s http://localhost:8889/metrics | grep -E \
  "otelcol_receiver_accepted_spans|otelcol_exporter_sent_spans|otelcol_processor_tail_sampling"

# Check service is sending spans (look for OTLP export errors)
kubectl -n production logs deploy/order-service --since=5m | \
  grep -iE "otlp|trace|span|exporter"

# Verify traceparent header is present on a live request
kubectl -n production exec -it deploy/order-service -- \
  curl -sv -H "traceparent: 00-$(openssl rand -hex 16)-$(openssl rand -hex 8)-01" \
  http://localhost:8080/api/v1/orders 2>&1 | grep -i "traceparent"

# Check memory limiter trigger events (indicates load on collector)
kubectl -n observability logs deploy/otel-collector --since=1h | \
  grep "memory_limiter"
```

### Verifying Baggage Propagation

```go
// Integration test: verify baggage survives the HTTP round-trip.
func TestBaggagePropagation(t *testing.T) {
	getSpans := testutil.SetupTestTracer(t)

	// Create a context with baggage.
	member, _ := baggage.NewMember("tenant.id", "tenant-xyz")
	bag, _ := baggage.New(member)
	ctx := baggage.ContextWithBaggage(context.Background(), bag)

	// Make an HTTP call; the client should inject the baggage header.
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/echo-baggage", nil)
	client := server.OutboundHTTPClient()
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	// The server echoes back the received baggage header value.
	body, _ := io.ReadAll(resp.Body)
	assert.Contains(t, string(body), "tenant.id=tenant-xyz")
}
```

## Summary

| Concern | Solution |
|---|---|
| SDK initialization | `InitProvider` with `ParentBased(TraceIDRatio)` sampler |
| Span lifecycle | `Start`/`defer End`; `RecordError`+`SetStatus` on error paths |
| HTTP propagation | `otelhttp.NewHandler` (server) + `otelhttp.NewTransport` (client) |
| gRPC propagation | `otelgrpc.NewServerHandler` + `otelgrpc.NewClientHandler` |
| Async propagation | `Inject` into carrier; `Extract` in consumer before `Start` |
| Cross-service data | `baggage.NewMember` + `ContextWithBaggage`; read with `baggage.FromContext` |
| Span links | `trace.WithLinks` for fan-out and async causal relationships |
| Tail-based sampling | OTel Collector `tail_sampling` processor with error/latency/service policies |
| Metric-trace link | `ObserveWithExemplar` + Grafana `exemplarTraceIdDestinations` |
| Testing | `tracetest.NewInMemoryExporter` with synchronous span processor |
| Kubernetes config | `OTEL_RESOURCE_ATTRIBUTES` via downward API; `OTEL_EXPORTER_OTLP_ENDPOINT` |
