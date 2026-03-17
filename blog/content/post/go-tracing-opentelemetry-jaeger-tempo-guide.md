---
title: "Distributed Tracing in Go: OpenTelemetry SDK with Jaeger and Tempo"
date: 2028-10-31T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Tracing", "Jaeger", "Observability"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing distributed tracing in Go using the OpenTelemetry SDK, covering TracerProvider setup, OTLP exporters, span context propagation across HTTP and gRPC, sampling strategies, and both Jaeger and Grafana Tempo backends."
more_link: "yes"
url: "/go-tracing-opentelemetry-jaeger-tempo-guide/"
---

Distributed tracing is the cornerstone of understanding latency and failures in microservice architectures. When a request touches a dozen services and something goes wrong at the 400ms mark, you need more than logs and metrics — you need a complete picture of every operation, every database query, and every downstream call in that request's lifecycle. OpenTelemetry provides the vendor-neutral SDK to instrument your Go services once and ship traces to any backend.

This guide covers the complete implementation: initializing the TracerProvider with OTLP exporters, propagating context across HTTP and gRPC boundaries, attaching metadata via baggage, configuring sampling strategies appropriate for production traffic, and comparing Jaeger versus Grafana Tempo as your trace storage backend.

<!--more-->

# Distributed Tracing in Go: OpenTelemetry SDK with Jaeger and Tempo

## The Case for OpenTelemetry

Before OpenTelemetry, you were locked in: instrument for Jaeger, rewrite for Zipkin, rewrite again for Datadog. The OpenTelemetry project standardized the instrumentation layer so you write your code once against the OTel SDK and swap backends by changing exporter configuration.

In Go, the OpenTelemetry SDK consists of:

- **API packages** (`go.opentelemetry.io/otel`) — interfaces your application code calls
- **SDK packages** (`go.opentelemetry.io/otel/sdk`) — the TracerProvider implementation
- **Exporter packages** — wire protocol implementations (OTLP/gRPC, OTLP/HTTP, Jaeger thrift)
- **Instrumentation libraries** — pre-built integrations for `net/http`, gRPC, database drivers

The separation between API and SDK is deliberate: library authors import only the API (adding zero startup cost if no SDK is configured), while application owners pull in the SDK and configure exporters at the binary level.

## Project Setup and Dependencies

Start with a Go module and pull in the required packages:

```bash
mkdir tracing-demo && cd tracing-demo
go mod init github.com/example/tracing-demo

go get go.opentelemetry.io/otel@v1.28.0
go get go.opentelemetry.io/otel/sdk@v1.28.0
go get go.opentelemetry.io/otel/trace@v1.28.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.28.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.28.0
go get go.opentelemetry.io/otel/propagators/b3@v1.28.0
go get go.opentelemetry.io/otel/baggage@v1.3.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.56.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.56.0
go get google.golang.org/grpc@v1.65.0
go get github.com/jmoiron/sqlx@v1.4.0
go get github.com/lib/pq@v1.10.9
```

## TracerProvider Initialization

The TracerProvider is the central object you configure once at startup and inject throughout your application. It holds the exporter, sampler, and resource attributes.

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

// Config holds TracerProvider configuration.
type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string // host:port, e.g. "otel-collector:4317"
	SamplerType    string // "always_on", "always_off", "traceid_ratio", "parent_based_traceid_ratio"
	SampleRate     float64
}

// InitTracer configures the global TracerProvider and returns a shutdown function.
// Call shutdown() in main() via defer to flush pending spans before process exit.
func InitTracer(ctx context.Context, cfg Config) (shutdown func(context.Context) error, err error) {
	// Resource describes this service instance to the backend.
	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			attribute.String("deployment.environment", cfg.Environment),
			// Include the hostname for per-pod correlation in Kubernetes.
			semconv.HostNameKey.String(hostName()),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("creating resource: %w", err)
	}

	// OTLP/gRPC exporter — targets the OpenTelemetry Collector or a backend
	// that speaks OTLP directly (Tempo, Jaeger v1.35+).
	conn, err := grpc.NewClient(
		cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("creating gRPC connection to %s: %w", cfg.OTLPEndpoint, err)
	}

	exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("creating OTLP trace exporter: %w", err)
	}

	// Build the sampler based on configuration.
	sampler := buildSampler(cfg)

	// BatchSpanProcessor buffers spans and sends them in batches,
	// which is far more efficient than the SimpleSpanProcessor (synchronous).
	bsp := sdktrace.NewBatchSpanProcessor(
		exporter,
		sdktrace.WithMaxExportBatchSize(512),
		sdktrace.WithBatchTimeout(5*time.Second),
		sdktrace.WithMaxQueueSize(4096),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(bsp),
	)

	// Register as the global TracerProvider so instrumentation libraries
	// pick it up without needing explicit injection.
	otel.SetTracerProvider(tp)

	// Configure W3C TraceContext + Baggage propagation.
	// Add B3 multi-header if you need compatibility with older Zipkin clients.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	shutdown = func(ctx context.Context) error {
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutting down TracerProvider: %w", err)
		}
		return conn.Close()
	}
	return shutdown, nil
}

func buildSampler(cfg Config) sdktrace.Sampler {
	switch cfg.SamplerType {
	case "always_on":
		return sdktrace.AlwaysSample()
	case "always_off":
		return sdktrace.NeverSample()
	case "traceid_ratio":
		// Sample a fixed fraction of traces, ignoring parent sampling decision.
		// Use for services at the ingress boundary.
		return sdktrace.TraceIDRatioBased(cfg.SampleRate)
	case "parent_based_traceid_ratio":
		// Respect the parent's sampling decision; only apply ratio for new roots.
		// Use for all downstream services to avoid broken traces.
		return sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(cfg.SampleRate),
		)
	default:
		// Safe default: sample 10% of root spans, honor parent decisions.
		return sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(0.10),
		)
	}
}

func hostName() string {
	// In Kubernetes, os.Hostname() returns the pod name — useful for correlation.
	import "os"
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
```

Fix the import inside the function (Go doesn't allow that — let's write the proper version):

```go
// pkg/telemetry/tracer.go
package telemetry

import (
	"context"
	"fmt"
	"os"
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

type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string
	SamplerType    string
	SampleRate     float64
}

func InitTracer(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	hostname, _ := os.Hostname()

	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			attribute.String("deployment.environment", cfg.Environment),
			semconv.HostNameKey.String(hostname),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("creating resource: %w", err)
	}

	conn, err := grpc.NewClient(
		cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("grpc dial %s: %w", cfg.OTLPEndpoint, err)
	}

	exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("otlp exporter: %w", err)
	}

	bsp := sdktrace.NewBatchSpanProcessor(
		exporter,
		sdktrace.WithMaxExportBatchSize(512),
		sdktrace.WithBatchTimeout(5*time.Second),
		sdktrace.WithMaxQueueSize(4096),
	)

	sampler := buildSampler(cfg)
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(bsp),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return func(ctx context.Context) error {
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("TracerProvider shutdown: %w", err)
		}
		return conn.Close()
	}, nil
}

func buildSampler(cfg Config) sdktrace.Sampler {
	switch cfg.SamplerType {
	case "always_on":
		return sdktrace.AlwaysSample()
	case "always_off":
		return sdktrace.NeverSample()
	case "traceid_ratio":
		return sdktrace.TraceIDRatioBased(cfg.SampleRate)
	case "parent_based_traceid_ratio":
		return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SampleRate))
	default:
		return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.10))
	}
}
```

## Main Function: Wiring It All Together

```go
// main.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/tracing-demo/pkg/telemetry"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func main() {
	ctx := context.Background()

	shutdown, err := telemetry.InitTracer(ctx, telemetry.Config{
		ServiceName:    "order-service",
		ServiceVersion: "1.4.2",
		Environment:    getEnv("APP_ENV", "development"),
		OTLPEndpoint:   getEnv("OTLP_ENDPOINT", "localhost:4317"),
		SamplerType:    "parent_based_traceid_ratio",
		SampleRate:     0.10, // 10% of root spans
	})
	if err != nil {
		log.Fatalf("initializing tracer: %v", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			log.Printf("tracer shutdown error: %v", err)
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/orders", handleOrders)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// otelhttp.NewHandler wraps the entire mux, creating a root span for
	// every incoming HTTP request. It reads W3C TraceContext headers and
	// continues existing traces automatically.
	handler := otelhttp.NewHandler(mux, "order-service",
		otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
	)

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		log.Printf("listening on :8080")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	shutdownCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

## Manual Span Creation and Attributes

Not every operation has a pre-built instrumentation library. For custom business logic, create spans manually:

```go
// handlers/orders.go
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// tracer is the package-level tracer. The name should be the
// fully-qualified import path of this instrumentation package.
var tracer = otel.Tracer("github.com/example/tracing-demo/handlers")

type OrderHandler struct {
	db      *sql.DB
	catalog CatalogClient
}

func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
	// r.Context() already contains the span started by otelhttp — we extend it.
	ctx := r.Context()

	// Start a child span for the order validation phase.
	ctx, span := tracer.Start(ctx, "order.validate",
		trace.WithAttributes(
			attribute.String("order.currency", "USD"),
			attribute.String("customer.region", r.Header.Get("X-Customer-Region")),
		),
		trace.WithSpanKind(trace.SpanKindInternal),
	)
	defer span.End()

	var req CreateOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid request body")
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Add dynamic attributes discovered after span start.
	span.SetAttributes(
		attribute.Int("order.item_count", len(req.Items)),
		attribute.String("order.id", req.OrderID),
	)

	// Validate inventory in the catalog service — creates another child span.
	if err := h.validateInventory(ctx, req); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, fmt.Sprintf("inventory validation: %v", err))
		http.Error(w, "inventory unavailable", http.StatusConflict)
		return
	}

	span.AddEvent("validation.complete", trace.WithTimestamp(time.Now()))
	span.SetStatus(codes.Ok, "")

	// Persist the order — another child span (in the db package).
	order, err := h.saveOrder(ctx, req)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(order)
}

func (h *OrderHandler) validateInventory(ctx context.Context, req CreateOrderRequest) error {
	ctx, span := tracer.Start(ctx, "catalog.checkInventory",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.Int("catalog.items_checked", len(req.Items)),
		),
	)
	defer span.End()

	// The catalog client will propagate the trace context over HTTP.
	available, err := h.catalog.CheckAvailability(ctx, req.Items)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}
	if !available {
		span.SetStatus(codes.Error, "items out of stock")
		return fmt.Errorf("one or more items unavailable")
	}
	span.SetStatus(codes.Ok, "")
	return nil
}
```

## HTTP Client Instrumentation and Context Propagation

The key to distributed tracing is propagating the trace context across service boundaries. When your service calls another service, it must inject the trace headers into the outgoing request:

```go
// pkg/httpclient/client.go
package httpclient

import (
	"context"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// NewClient returns an HTTP client that automatically propagates
// W3C TraceContext and Baggage headers on every outgoing request.
func NewClient() *http.Client {
	return &http.Client{
		Transport: otelhttp.NewTransport(
			http.DefaultTransport,
			otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
				return fmt.Sprintf("%s %s", r.Method, r.URL.Path)
			}),
		),
		Timeout: 30 * time.Second,
	}
}

// Manual propagation when you cannot use otelhttp.Transport:
func injectTraceHeaders(ctx context.Context, req *http.Request) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
}
```

## gRPC Instrumentation

For gRPC services, use the `otelgrpc` interceptors:

```go
// pkg/grpcserver/server.go
package grpcserver

import (
	"context"
	"fmt"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
)

// NewServer creates a gRPC server with OTel instrumentation.
// The stats handler approach instruments all RPCs, including streaming.
func NewServer() *grpc.Server {
	srv := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler(
			otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
		)),
	)
	reflection.Register(srv)
	return srv
}

// NewClientConn creates a gRPC client connection with OTel instrumentation.
func NewClientConn(ctx context.Context, target string) (*grpc.ClientConn, error) {
	conn, err := grpc.NewClient(
		target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler(
			otelgrpc.WithMessageEvents(otelgrpc.ReceivedEvents, otelgrpc.SentEvents),
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("grpc dial %s: %w", target, err)
	}
	return conn, nil
}
```

## Baggage: Cross-Service Metadata

Baggage carries key-value pairs across the entire trace, available in every downstream service. Use it for tenant IDs, feature flags, or request classification:

```go
// pkg/middleware/baggage.go
package middleware

import (
	"net/http"

	"go.opentelemetry.io/otel/baggage"
)

// BaggageMiddleware extracts tenant and user context from request headers
// and injects them into the OTel Baggage, making them available in all
// downstream services without explicit forwarding.
func BaggageMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		tenantID := r.Header.Get("X-Tenant-ID")
		userID := r.Header.Get("X-User-ID")
		featureFlags := r.Header.Get("X-Feature-Flags")

		var members []baggage.Member

		if tenantID != "" {
			m, err := baggage.NewMember("tenant.id", tenantID)
			if err == nil {
				members = append(members, m)
			}
		}
		if userID != "" {
			m, err := baggage.NewMember("user.id", userID)
			if err == nil {
				members = append(members, m)
			}
		}
		if featureFlags != "" {
			m, err := baggage.NewMember("feature.flags", featureFlags)
			if err == nil {
				members = append(members, m)
			}
		}

		if len(members) > 0 {
			bag, err := baggage.New(members...)
			if err == nil {
				ctx = baggage.ContextWithBaggage(ctx, bag)
			}
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ReadBaggageFromContext retrieves baggage values in a downstream service.
func ReadBaggageFromContext(ctx context.Context) map[string]string {
	bag := baggage.FromContext(ctx)
	result := make(map[string]string)
	for _, member := range bag.Members() {
		result[member.Key()] = member.Value()
	}
	return result
}
```

## Instrumenting Database Queries with sqlx

Database calls are often the biggest source of latency. Trace them with custom span wrappers around sqlx:

```go
// pkg/db/traced.go
package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

var dbTracer = otel.Tracer("github.com/example/tracing-demo/db")

// TracedDB wraps sqlx.DB with automatic span creation for each query.
type TracedDB struct {
	db     *sqlx.DB
	dbName string
	dbHost string
}

func NewTracedDB(dsn, dbName, dbHost string) (*TracedDB, error) {
	db, err := sqlx.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening db: %w", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	return &TracedDB{db: db, dbName: dbName, dbHost: dbHost}, nil
}

func (t *TracedDB) dbAttrs(query string) []attribute.KeyValue {
	return []attribute.KeyValue{
		semconv.DBSystemPostgreSQL,
		semconv.DBName(t.dbName),
		semconv.ServerAddress(t.dbHost),
		semconv.DBQueryText(query),
	}
}

func (t *TracedDB) QueryxContext(ctx context.Context, query string, args ...interface{}) (*sqlx.Rows, error) {
	ctx, span := dbTracer.Start(ctx, dbSpanName(query),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(t.dbAttrs(query)...),
	)
	defer span.End()

	rows, err := t.db.QueryxContext(ctx, query, args...)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}
	span.SetStatus(codes.Ok, "")
	return rows, nil
}

func (t *TracedDB) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	ctx, span := dbTracer.Start(ctx, dbSpanName(query),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(t.dbAttrs(query)...),
	)
	defer span.End()

	result, err := t.db.ExecContext(ctx, query, args...)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	rowsAffected, _ := result.RowsAffected()
	span.SetAttributes(attribute.Int64("db.rows_affected", rowsAffected))
	span.SetStatus(codes.Ok, "")
	return result, nil
}

// dbSpanName extracts a short operation name from the SQL statement.
// In production, use a proper SQL parser to avoid PII in span names.
func dbSpanName(query string) string {
	if len(query) > 50 {
		return query[:50]
	}
	return query
}
```

## Sampling Strategy Decision Guide

Sampling is the most consequential configuration decision in a tracing deployment:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sampling Decision Tree                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Is this the ingress service (edge, API gateway)?               │
│    YES → TraceIDRatioBased(rate)                                 │
│      - Creates new traces, sets initial sampling bit            │
│      - rate = 1.0 for dev/staging                               │
│      - rate = 0.01-0.10 for high-volume production              │
│                                                                  │
│  Is this an internal/downstream service?                        │
│    YES → ParentBased(TraceIDRatioBased(rate))                   │
│      - Honors parent sampling decision (critical!)              │
│      - rate only applies if there's no parent (direct call)     │
│      - Prevents broken/partial traces                           │
│                                                                  │
│  Are you debugging or profiling a specific issue?               │
│    YES → AlwaysSample() temporarily                             │
│      - Set via environment variable, not code change            │
│      - Revert after investigation                               │
│                                                                  │
│  Is traffic extremely high (>100k req/s)?                       │
│    YES → Consider tail-based sampling in the OTel Collector     │
│      - Sample by error status, latency percentile               │
│      - Requires collector-side configuration                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## OTel Collector Configuration

Deploy the OpenTelemetry Collector as a DaemonSet to receive spans from all pods, apply tail-based sampling, and fan out to multiple backends:

```yaml
# otel-collector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
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
      # Batch processor reduces number of export calls.
      batch:
        timeout: 5s
        send_batch_size: 1024
        send_batch_max_size: 2048

      # Memory limiter prevents OOM on the collector itself.
      memory_limiter:
        check_interval: 1s
        limit_mib: 512
        spike_limit_mib: 128

      # Resource detection adds cloud metadata.
      resourcedetection:
        detectors: [env, k8snode, k8sattributes]

      # Tail-based sampling: keep all error traces and 10% of success traces.
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          - name: errors-policy
            type: status_code
            status_code: {status_codes: [ERROR]}
          - name: slow-traces-policy
            type: latency
            latency: {threshold_ms: 2000}
          - name: sampling-policy
            type: probabilistic
            probabilistic: {sampling_percentage: 10}

    exporters:
      # Grafana Tempo via OTLP
      otlp/tempo:
        endpoint: tempo.observability.svc.cluster.local:4317
        tls:
          insecure: true

      # Jaeger via OTLP (Jaeger v1.35+ supports OTLP natively)
      otlp/jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:4317
        tls:
          insecure: true

      # Debug exporter for troubleshooting — disable in production
      debug:
        verbosity: detailed

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resourcedetection, batch, tail_sampling]
          exporters: [otlp/tempo]
```

## Jaeger Backend Deployment

Jaeger is the most widely deployed open-source trace backend. For production, use the all-in-one deployment for testing and the distributed components for scale:

```yaml
# jaeger-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: observability
  labels:
    app: jaeger
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
          image: jaegertracing/all-in-one:1.60
          ports:
            - containerPort: 16686  # UI
            - containerPort: 4317   # OTLP/gRPC
            - containerPort: 4318   # OTLP/HTTP
            - containerPort: 9411   # Zipkin (optional)
          env:
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
            - name: SPAN_STORAGE_TYPE
              value: "badger"
            - name: BADGER_EPHEMERAL
              value: "false"
            - name: BADGER_DIRECTORY_VALUE
              value: /badger/data
            - name: BADGER_DIRECTORY_KEY
              value: /badger/key
          volumeMounts:
            - name: badger-storage
              mountPath: /badger
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 1Gi
      volumes:
        - name: badger-storage
          persistentVolumeClaim:
            claimName: jaeger-badger-pvc
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

## Grafana Tempo Backend Deployment

Tempo is Grafana's trace backend. It integrates natively with Grafana dashboards and correlates with Loki logs and Prometheus metrics via exemplars:

```yaml
# tempo-values.yaml (for the grafana/tempo Helm chart)
tempo:
  storage:
    trace:
      backend: local
      local:
        path: /var/tempo/traces
      wal:
        path: /var/tempo/wal

  server:
    http_listen_port: 3200

  distributor:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

  ingester:
    max_block_duration: 5m
    trace_idle_period: 10s
    max_block_bytes: 1_000_000

  compactor:
    compaction:
      block_retention: 336h  # 2 weeks

  querier:
    frontend_worker:
      frontend_address: tempo-query-frontend:9095

persistence:
  enabled: true
  size: 50Gi
  storageClass: "fast-ssd"
```

## Jaeger vs Tempo: When to Use Each

| Dimension | Jaeger | Grafana Tempo |
|-----------|--------|---------------|
| Query language | Jaeger UI with service graph | TraceQL (powerful structured queries) |
| Storage backends | Cassandra, Elasticsearch, Badger, in-memory | S3, GCS, Azure Blob, local disk |
| Grafana integration | Via Jaeger data source | Native, first-class |
| Metrics correlation | Limited | Exemplar linking to Prometheus |
| Log correlation | Manual | Native with Loki via trace IDs |
| Operational complexity | Moderate (distributed components) | Low (single binary) |
| Cost at scale | Higher (Elasticsearch licensing) | Lower (object storage) |

Choose Tempo when you are already invested in the Grafana stack (Loki + Prometheus + Grafana). Choose Jaeger when you need its mature UI with service dependency graphs or already have Elasticsearch or Cassandra infrastructure.

## Writing TraceQL Queries in Tempo

Tempo's TraceQL is far more expressive than Jaeger's query interface:

```
# Find all traces where order-service had an error
{ resource.service.name = "order-service" && status = error }

# Find slow database spans (>500ms) in the inventory service
{ resource.service.name = "inventory-service"
  && name = "db.query"
  && duration > 500ms }

# Find traces containing both order-service and payment-service
{ resource.service.name = "order-service" }
&& { resource.service.name = "payment-service" }

# Aggregate: p99 latency grouped by endpoint
{ resource.service.name = "api-gateway" }
| select(duration)
| quantile(0.99, duration) by(name)
```

## Kubernetes Deployment for Your Application

```yaml
# app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
      annotations:
        # Prometheus can scrape exemplars that link metrics to traces.
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      containers:
        - name: order-service
          image: registry.example.com/order-service:1.4.2
          env:
            - name: OTLP_ENDPOINT
              value: "otel-collector.observability.svc.cluster.local:4317"
            - name: APP_ENV
              value: "production"
            - name: OTEL_SERVICE_NAME
              value: "order-service"
            # OTEL_RESOURCE_ATTRIBUTES adds pod-level metadata.
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "k8s.namespace.name=$(POD_NAMESPACE),k8s.pod.name=$(POD_NAME)"
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

## Testing Your Instrumentation

Validate spans in unit tests without a real backend using the in-memory exporter:

```go
// handlers/orders_test.go
package handlers_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestCreateOrderSpans(t *testing.T) {
	// Set up an in-memory span exporter.
	exporter := tracetest.NewInMemoryExporter()
	tp := trace.NewTracerProvider(
		trace.WithSyncer(exporter), // Synchronous for tests
	)
	otel.SetTracerProvider(tp)
	defer tp.Shutdown(context.Background())

	// Exercise the handler.
	handler := &OrderHandler{db: testDB(t), catalog: &mockCatalog{}}
	req := httptest.NewRequest(http.MethodPost, "/orders", orderBody(t))
	req.Header.Set("X-Tenant-ID", "tenant-123")
	rec := httptest.NewRecorder()
	handler.CreateOrder(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Verify expected spans were created.
	spans := exporter.GetSpans()
	if len(spans) < 2 {
		t.Fatalf("expected at least 2 spans, got %d", len(spans))
	}

	spanNames := make(map[string]bool)
	for _, s := range spans {
		spanNames[s.Name()] = true
	}

	for _, expected := range []string{"order.validate", "catalog.checkInventory"} {
		if !spanNames[expected] {
			t.Errorf("missing expected span: %s", expected)
		}
	}
}
```

## Summary

OpenTelemetry gives Go services a stable, vendor-neutral tracing foundation. The key implementation decisions are:

1. **Initialize the TracerProvider once** in `main()` with your chosen sampler and exporter
2. **Register globally** so instrumentation libraries require no explicit injection
3. **Use `ParentBased` sampling** in downstream services to honor the root decision
4. **Propagate context explicitly** — pass `ctx` through every function call
5. **Use Baggage for cross-cutting concerns** (tenant ID, request classification) rather than adding the same attribute to every span
6. **Deploy the OTel Collector** as a DaemonSet for buffering, tail-based sampling, and backend flexibility
7. **Choose Tempo** when you need deep Grafana integration and low-cost object storage; **choose Jaeger** for mature service dependency graph visualization
