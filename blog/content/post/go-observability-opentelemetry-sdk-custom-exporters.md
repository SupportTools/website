---
title: "Go Observability Instrumentation: OpenTelemetry SDK, Custom Exporters, and Sampling Strategies"
date: 2030-02-02T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Observability", "Tracing", "Metrics", "OTLP", "Prometheus"]
categories: ["Go", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Instrument Go services with the OTel SDK: custom span processors, head-based vs tail-based sampling, OTLP exporters, baggage propagation, exemplars in Prometheus metrics, and production observability patterns."
more_link: "yes"
url: "/go-observability-opentelemetry-sdk-custom-exporters/"
---

OpenTelemetry has become the de facto standard for distributed observability — a single SDK that handles traces, metrics, and logs, with vendor-neutral exporters for Jaeger, Tempo, Prometheus, Loki, and commercial backends. For Go services, the OTel SDK provides a coherent instrumentation model that avoids the previous fragmentation between Zipkin, Jaeger, and Prometheus client libraries.

This guide covers instrumenting Go services from scratch with the OTel SDK: trace context propagation, custom span processors for PII scrubbing and business logic, OTLP exporters, head-based and tail-based sampling decisions, baggage propagation for request correlation, and exemplars that link Prometheus metrics to traces.

<!--more-->

## OpenTelemetry Concepts

Before diving into code, the key OTel concepts:

- **Tracer**: Creates spans for a specific instrumentation scope (library, package)
- **Span**: A unit of work with start/end time, attributes, events, and links
- **Trace**: A collection of spans forming a distributed transaction tree
- **Context**: Carries the active span and baggage across function boundaries
- **Propagator**: Encodes/decodes context into/from wire formats (W3C TraceContext, B3)
- **Exporter**: Sends spans/metrics to a backend (OTLP, Jaeger, Prometheus)
- **Sampler**: Decides whether a trace should be recorded
- **Processor**: Pipeline step between span creation and export

## Setting Up the OTel SDK

### Dependencies

```bash
go get go.opentelemetry.io/otel@v1.25.0
go get go.opentelemetry.io/otel/sdk@v1.25.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.25.0
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@v1.25.0
go get go.opentelemetry.io/otel/propagators/b3@v1.25.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.50.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.50.0
go get github.com/prometheus/client_golang@v1.19.0
```

### pkg/telemetry/setup.go

```go
// pkg/telemetry/setup.go
package telemetry

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds OTel configuration.
type Config struct {
	ServiceName      string
	ServiceVersion   string
	Environment      string
	OTLPEndpoint     string   // e.g., "otel-collector:4317"
	SamplingRate     float64  // 0.0 to 1.0 for head-based sampling
	ResourceAttributes []attribute.KeyValue
}

// Provider holds the initialized OTel providers.
type Provider struct {
	TracerProvider *sdktrace.TracerProvider
	MeterProvider  *sdkmetric.MeterProvider
	logger         *zap.Logger
}

// Setup initializes the OTel SDK with trace and metric exporters.
// Returns a Provider and a shutdown function.
func Setup(ctx context.Context, cfg Config, logger *zap.Logger) (*Provider, func(context.Context) error, error) {
	// Build service resource
	res, err := buildResource(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("building resource: %w", err)
	}

	// Connect to OTLP collector
	conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
		grpc.WithTimeout(5*time.Second),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("connecting to OTLP endpoint %s: %w", cfg.OTLPEndpoint, err)
	}

	// Initialize trace exporter
	traceExporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, nil, fmt.Errorf("creating trace exporter: %w", err)
	}

	// Initialize metric exporter
	metricExporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, nil, fmt.Errorf("creating metric exporter: %w", err)
	}

	// Build sampler
	sampler := buildSampler(cfg.SamplingRate)

	// Build tracer provider with processors
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter,
			sdktrace.WithBatchTimeout(5*time.Second),
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithMaxQueueSize(2048),
		),
		sdktrace.WithSampler(sampler),
		sdktrace.WithResource(res),
		// Add PII scrubbing processor
		sdktrace.WithSpanProcessor(NewPIIScrubber()),
		// Add business metrics processor
		sdktrace.WithSpanProcessor(NewBusinessMetricsProcessor()),
	)

	// Build meter provider
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithExporter(
			sdkmetric.NewPeriodicReader(metricExporter,
				sdkmetric.WithInterval(30*time.Second),
			),
		),
		sdkmetric.WithResource(res),
	)

	// Set global providers
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)

	// Set composite propagator (W3C TraceContext + W3C Baggage + B3)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
		// b3.New(b3.WithInjectEncoding(b3.B3MultipleHeader)), // Uncomment for B3 legacy systems
	))

	provider := &Provider{
		TracerProvider: tp,
		MeterProvider:  mp,
		logger:         logger,
	}

	shutdown := func(ctx context.Context) error {
		conn.Close()
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutting down tracer provider: %w", err)
		}
		if err := mp.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutting down meter provider: %w", err)
		}
		return nil
	}

	logger.Info("OTel SDK initialized",
		zap.String("service", cfg.ServiceName),
		zap.String("endpoint", cfg.OTLPEndpoint),
		zap.Float64("sampling_rate", cfg.SamplingRate),
	)

	return provider, shutdown, nil
}

func buildResource(cfg Config) (*resource.Resource, error) {
	attrs := []attribute.KeyValue{
		semconv.ServiceName(cfg.ServiceName),
		semconv.ServiceVersion(cfg.ServiceVersion),
		attribute.String("deployment.environment", cfg.Environment),
	}
	attrs = append(attrs, cfg.ResourceAttributes...)

	return resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, attrs...),
	)
}

func buildSampler(rate float64) sdktrace.Sampler {
	if rate >= 1.0 {
		return sdktrace.AlwaysSample()
	}
	if rate <= 0.0 {
		return sdktrace.NeverSample()
	}
	// Consistent probability sampling (respects parent's sampling decision)
	return sdktrace.ParentBased(
		sdktrace.TraceIDRatioBased(rate),
	)
}
```

## Custom Span Processors

Span processors hook into the span lifecycle for custom logic:

### PII Scrubber Processor

```go
// pkg/telemetry/pii_scrubber.go
package telemetry

import (
	"context"
	"regexp"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// PII patterns to detect and redact
var piiPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\b[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b`),  // Credit card
	regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`),                                      // SSN
	regexp.MustCompile(`\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b`),               // Email (case-insensitive)
	regexp.MustCompile(`\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b`),   // Phone
}

// sensitiveKeys are attribute keys whose values should always be redacted
var sensitiveKeys = map[string]bool{
	"user.password":        true,
	"http.request.header.authorization": true,
	"db.statement":         true, // May contain sensitive data
	"user.email":           true,
	"payment.card.number":  true,
	"user.ssn":             true,
}

// PIIScrubber implements sdktrace.SpanProcessor to remove PII from spans.
type PIIScrubber struct{}

// NewPIIScrubber creates a new PII scrubbing span processor.
func NewPIIScrubber() *PIIScrubber {
	return &PIIScrubber{}
}

// OnStart is called when a span starts. No scrubbing needed at start.
func (p *PIIScrubber) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {}

// OnEnd is called when a span ends. Scrub PII from attributes.
func (p *PIIScrubber) OnEnd(s sdktrace.ReadOnlySpan) {
	// Note: ReadOnlySpan cannot be modified after OnEnd is called.
	// To modify, use a ReadWriteSpanProcessor (use Wrap approach below).
}

// PIIScrubberReadWrite wraps a span processor and scrubs PII.
// This version works with ReadWriteSpan in OnStart.
type PIIScrubberReadWrite struct{}

func (p *PIIScrubberReadWrite) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {
	attrs := s.Attributes()
	var scrubbed []attribute.KeyValue

	for _, kv := range attrs {
		key := string(kv.Key)

		// Check sensitive keys list
		if sensitiveKeys[strings.ToLower(key)] {
			scrubbed = append(scrubbed, attribute.String(key, "[REDACTED]"))
			continue
		}

		// Check string values for PII patterns
		if kv.Value.Type() == attribute.STRING {
			val := kv.Value.AsString()
			redacted := redactPII(val)
			if redacted != val {
				scrubbed = append(scrubbed, attribute.String(key, redacted))
				continue
			}
		}

		scrubbed = append(scrubbed, kv)
	}

	// Re-set all attributes with scrubbed values
	s.SetAttributes(scrubbed...)
}

func (p *PIIScrubberReadWrite) OnEnd(s sdktrace.ReadOnlySpan) {}

func (p *PIIScrubberReadWrite) Shutdown(ctx context.Context) error { return nil }

func (p *PIIScrubberReadWrite) ForceFlush(ctx context.Context) error { return nil }

func redactPII(s string) string {
	for _, pattern := range piiPatterns {
		s = pattern.ReplaceAllString(s, "[REDACTED]")
	}
	return s
}
```

### Business Metrics Processor

```go
// pkg/telemetry/business_metrics.go
package telemetry

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// BusinessMetricsProcessor extracts business metrics from spans.
type BusinessMetricsProcessor struct {
	requestDuration metric.Float64Histogram
	requestTotal    metric.Int64Counter
	errorTotal      metric.Int64Counter
}

// NewBusinessMetricsProcessor creates a processor that records span metrics.
func NewBusinessMetricsProcessor() *BusinessMetricsProcessor {
	meter := otel.Meter("business-metrics")

	requestDuration, _ := meter.Float64Histogram(
		"span.duration.seconds",
		metric.WithDescription("Span execution duration in seconds."),
		metric.WithUnit("s"),
	)
	requestTotal, _ := meter.Int64Counter(
		"span.requests.total",
		metric.WithDescription("Total span requests."),
	)
	errorTotal, _ := meter.Int64Counter(
		"span.errors.total",
		metric.WithDescription("Total span errors."),
	)

	return &BusinessMetricsProcessor{
		requestDuration: requestDuration,
		requestTotal:    requestTotal,
		errorTotal:      errorTotal,
	}
}

func (p *BusinessMetricsProcessor) OnStart(_ context.Context, _ sdktrace.ReadWriteSpan) {}

func (p *BusinessMetricsProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	ctx := context.Background()

	attrs := []attribute.KeyValue{
		attribute.String("span.name", s.Name()),
		attribute.String("service.name", s.InstrumentationScope().Name),
		attribute.Bool("span.kind.server", s.SpanKind() == sdktrace.SpanKindServer),
	}

	duration := s.EndTime().Sub(s.StartTime()).Seconds()
	p.requestDuration.Record(ctx, duration, metric.WithAttributes(attrs...))
	p.requestTotal.Add(ctx, 1, metric.WithAttributes(attrs...))

	if s.Status().Code == codes.Error {
		p.errorTotal.Add(ctx, 1, metric.WithAttributes(attrs...))
	}
}

func (p *BusinessMetricsProcessor) Shutdown(_ context.Context) error   { return nil }
func (p *BusinessMetricsProcessor) ForceFlush(_ context.Context) error { return nil }
```

## Instrumenting HTTP Handlers

```go
// pkg/server/server.go
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const instrumentationName = "github.com/yourorg/api-service/server"

// Server is an instrumented HTTP server.
type Server struct {
	tracer  trace.Tracer
	meter   metric.Meter
	mux     *http.ServeMux

	// Metrics
	requestDuration metric.Float64Histogram
	requestTotal    metric.Int64Counter
	activeRequests  metric.Int64UpDownCounter
}

// NewServer creates an instrumented HTTP server.
func NewServer() (*Server, error) {
	tracer := otel.Tracer(instrumentationName)
	meter := otel.Meter(instrumentationName)

	requestDuration, err := meter.Float64Histogram(
		"http.server.request.duration",
		metric.WithDescription("HTTP server request duration."),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(
			.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10,
		),
	)
	if err != nil {
		return nil, fmt.Errorf("creating request duration histogram: %w", err)
	}

	requestTotal, err := meter.Int64Counter(
		"http.server.request.total",
		metric.WithDescription("Total HTTP server requests."),
	)
	if err != nil {
		return nil, fmt.Errorf("creating request total counter: %w", err)
	}

	activeRequests, err := meter.Int64UpDownCounter(
		"http.server.active_requests",
		metric.WithDescription("Number of active HTTP requests."),
	)
	if err != nil {
		return nil, fmt.Errorf("creating active requests gauge: %w", err)
	}

	s := &Server{
		tracer:          tracer,
		meter:           meter,
		mux:             http.NewServeMux(),
		requestDuration: requestDuration,
		requestTotal:    requestTotal,
		activeRequests:  activeRequests,
	}

	s.registerRoutes()
	return s, nil
}

func (s *Server) registerRoutes() {
	// Wrap entire mux with otelhttp for automatic span creation
	// This handles trace propagation from incoming request headers
	s.mux.Handle("/api/orders",
		otelhttp.NewHandler(http.HandlerFunc(s.handleOrders), "orders",
			otelhttp.WithTracerProvider(otel.GetTracerProvider()),
			otelhttp.WithMeterProvider(otel.GetMeterProvider()),
			otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
				return fmt.Sprintf("%s %s", r.Method, r.URL.Path)
			}),
		),
	)

	s.mux.Handle("/api/orders/", otelhttp.NewHandler(
		http.HandlerFunc(s.handleOrderByID), "order_by_id",
	))
}

// handleOrders demonstrates span creation and attribute enrichment.
func (s *Server) handleOrders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Get active span from context (created by otelhttp middleware)
	span := trace.SpanFromContext(ctx)

	// Add business-level attributes
	span.SetAttributes(
		attribute.String("user.id", r.Header.Get("X-User-ID")),
		attribute.String("request.id", r.Header.Get("X-Request-ID")),
		attribute.String("tenant.id", r.Header.Get("X-Tenant-ID")),
	)

	s.activeRequests.Add(ctx, 1)
	defer s.activeRequests.Add(ctx, -1)

	start := time.Now()
	defer func() {
		duration := time.Since(start).Seconds()
		attrs := metric.WithAttributes(
			attribute.String("http.method", r.Method),
			attribute.String("http.route", "/api/orders"),
			attribute.String("http.status_code", "200"),
		)
		s.requestDuration.Record(ctx, duration, attrs)
		s.requestTotal.Add(ctx, 1, attrs)
	}()

	// Create child span for database operation
	orders, err := s.fetchOrdersFromDB(ctx, r.Header.Get("X-Tenant-ID"))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	span.SetAttributes(attribute.Int("orders.count", len(orders)))
	span.AddEvent("orders.fetched", trace.WithAttributes(
		attribute.Int("count", len(orders)),
	))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(orders)
}

func (s *Server) fetchOrdersFromDB(ctx context.Context, tenantID string) ([]map[string]interface{}, error) {
	// Create a child span for the DB operation
	ctx, span := s.tracer.Start(ctx, "db.query.orders",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "postgresql"),
			attribute.String("db.operation", "SELECT"),
			attribute.String("db.name", "orders"),
			attribute.String("db.sql.table", "orders"),
			// Note: do NOT include actual query with potential PII
			// The PIIScrubber handles this, but prevention is better
		),
	)
	defer span.End()

	// Simulate DB operation
	time.Sleep(5 * time.Millisecond)

	span.SetAttributes(
		attribute.Int("db.rows_affected", 42),
		attribute.Float64("db.query.duration_ms", 4.7),
	)

	return []map[string]interface{}{
		{"id": "order-1", "tenant_id": tenantID, "amount": 99.99},
	}, nil
}
```

## Tail-Based Sampling with OpenTelemetry Collector

Head-based sampling decides at trace start whether to sample. Tail-based sampling waits for the full trace and samples based on complete information (errors, latency, specific attributes):

### OpenTelemetry Collector Config (Tail Sampling)

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
  # Memory limiter prevents OOM
  memory_limiter:
    check_interval: 1s
    limit_mib: 2048
    spike_limit_mib: 512

  # Batch for efficiency
  batch:
    send_batch_size: 1000
    timeout: 10s

  # Tail-based sampling processor
  tail_sampling:
    # Wait 30s for all spans before sampling decision
    decision_wait: 30s
    num_traces: 100000      # Max traces in memory
    expected_new_traces_per_sec: 1000

    policies:
      # Always sample errors
      - name: sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR, UNSET]

      # Always sample slow traces (> 2s)
      - name: sample-slow-traces
        type: latency
        latency:
          threshold_ms: 2000

      # Always sample traces with specific user attributes
      - name: sample-debug-users
        type: string_attribute
        string_attribute:
          key: user.debug_sampling
          values: ["true"]

      # Sample 5% of healthy fast traces
      - name: sample-healthy-traces
        type: probabilistic
        probabilistic:
          sampling_percentage: 5

      # Always sample payment transactions
      - name: sample-payments
        type: string_attribute
        string_attribute:
          key: transaction.type
          values: ["payment", "refund", "chargeback"]

exporters:
  # Export to Grafana Tempo
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

  # Export to Jaeger (for teams still on Jaeger)
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true

  # Prometheus metrics from spans
  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: otelcol
    send_timestamps: true
    metric_expiration: 3m

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp/tempo, jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

## Baggage Propagation

Baggage carries key-value pairs across service boundaries for request-scoped data that isn't specific to tracing:

```go
// pkg/telemetry/baggage.go
package telemetry

import (
	"context"
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
)

const (
	BaggageKeyTenantID    = "tenant.id"
	BaggageKeyUserID      = "user.id"
	BaggageKeyRequestID   = "request.id"
	BaggageKeyFeatureFlags = "feature.flags"
)

// InjectBaggage adds baggage to an outgoing HTTP request.
func InjectBaggage(ctx context.Context, req *http.Request) {
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.Baggage{},
		propagation.TraceContext{},
	)
	propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// ExtractBaggage extracts baggage from an incoming HTTP request.
func ExtractBaggage(r *http.Request) context.Context {
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.Baggage{},
		propagation.TraceContext{},
	)
	return propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
}

// SetRequestContext adds standard request metadata to context baggage.
func SetRequestContext(ctx context.Context, tenantID, userID, requestID string) (context.Context, error) {
	var members []baggage.Member

	if tenantID != "" {
		m, err := baggage.NewMember(BaggageKeyTenantID, tenantID)
		if err != nil {
			return ctx, fmt.Errorf("creating tenant baggage member: %w", err)
		}
		members = append(members, m)
	}

	if userID != "" {
		m, err := baggage.NewMember(BaggageKeyUserID, userID)
		if err != nil {
			return ctx, fmt.Errorf("creating user baggage member: %w", err)
		}
		members = append(members, m)
	}

	if requestID != "" {
		m, err := baggage.NewMember(BaggageKeyRequestID, requestID)
		if err != nil {
			return ctx, fmt.Errorf("creating request ID baggage member: %w", err)
		}
		members = append(members, m)
	}

	b, err := baggage.New(members...)
	if err != nil {
		return ctx, fmt.Errorf("creating baggage: %w", err)
	}

	return baggage.ContextWithBaggage(ctx, b), nil
}

// GetBaggageValue retrieves a baggage value from context.
func GetBaggageValue(ctx context.Context, key string) string {
	b := baggage.FromContext(ctx)
	member := b.Member(key)
	return member.Value()
}

// BaggageMiddleware is an HTTP middleware that extracts baggage and adds it to span attributes.
func BaggageMiddleware(next http.Handler) http.Handler {
	tracer := otel.Tracer(instrumentationName)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := ExtractBaggage(r)

		// Add baggage values as span attributes for search/filtering
		span := trace.SpanFromContext(ctx)
		b := baggage.FromContext(ctx)

		for _, member := range b.Members() {
			span.SetAttributes(attribute.String(member.Key(), member.Value()))
		}

		// Also extract and propagate standard headers
		tenantID := r.Header.Get("X-Tenant-ID")
		userID := r.Header.Get("X-User-ID")
		requestID := r.Header.Get("X-Request-ID")

		ctx, err := SetRequestContext(ctx, tenantID, userID, requestID)
		if err == nil {
			r = r.WithContext(ctx)
		}

		next.ServeHTTP(w, r)
	})
}
```

## Exemplars: Linking Metrics to Traces

Exemplars attach a trace ID to a specific Prometheus metric observation, enabling "jump from metric spike to trace" in Grafana:

```go
// pkg/telemetry/exemplars.go
package telemetry

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel/trace"
)

// ExemplarHistogram wraps prometheus.ObserverVec to automatically add trace exemplars.
type ExemplarHistogram struct {
	hist *prometheus.HistogramVec
}

// NewExemplarHistogram creates a histogram that includes trace exemplars.
func NewExemplarHistogram(opts prometheus.HistogramOpts, labelNames []string) *ExemplarHistogram {
	return &ExemplarHistogram{
		hist: promauto.NewHistogramVec(opts, labelNames),
	}
}

// Observe records a value with the current trace context as exemplar.
func (h *ExemplarHistogram) Observe(ctx context.Context, value float64, labels prometheus.Labels) {
	observer, err := h.hist.GetMetricWith(labels)
	if err != nil {
		return
	}

	// Get current span's trace context
	spanCtx := trace.SpanFromContext(ctx).SpanContext()
	if !spanCtx.IsValid() {
		observer.Observe(value)
		return
	}

	// Attach trace ID and span ID as exemplar labels
	exemplarLabels := prometheus.Labels{
		"trace_id": spanCtx.TraceID().String(),
		"span_id":  spanCtx.SpanID().String(),
	}

	// Use ObserverWithExemplar (prometheus client v1.19+)
	if obsEx, ok := observer.(prometheus.ExemplarObserver); ok {
		obsEx.ObserveWithExemplar(value, exemplarLabels)
	} else {
		observer.Observe(value)
	}
}

// Instrumented HTTP middleware with exemplars
func InstrumentedHTTPMiddleware(
	requestDuration *ExemplarHistogram,
	requestTotal *prometheus.CounterVec,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(wrapped, r)

			duration := time.Since(start).Seconds()
			labels := prometheus.Labels{
				"method": r.Method,
				"path":   r.URL.Path,
				"status": strconv.Itoa(wrapped.statusCode),
			}

			// Observe with trace context for exemplars
			requestDuration.Observe(r.Context(), duration, labels)
			requestTotal.With(labels).Inc()
		})
	}
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(statusCode int) {
	rw.statusCode = statusCode
	rw.ResponseWriter.WriteHeader(statusCode)
}
```

### Prometheus Configuration for Exemplars

```yaml
# prometheus.yaml
global:
  scrape_interval: 15s

# Enable exemplar storage (Prometheus 2.25+)
storage:
  exemplars:
    max_exemplars: 100000

scrape_configs:
  - job_name: 'api-service'
    scrape_interval: 15s
    static_configs:
      - targets: ['api-service:9090']
    # Enable exemplar scraping (native histograms)
    params:
      exemplars: ["true"]
```

## Full Observability Setup in main.go

```go
// cmd/server/main.go
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/yourorg/api-service/pkg/server"
	"github.com/yourorg/api-service/pkg/telemetry"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// Initialize OTel
	cfg := telemetry.Config{
		ServiceName:    "api-service",
		ServiceVersion: "1.2.3",
		Environment:    os.Getenv("ENVIRONMENT"),
		OTLPEndpoint:   os.Getenv("OTLP_ENDPOINT"), // e.g., "otel-collector:4317"
		SamplingRate:   0.1,                          // 10% head-based sampling
	}

	provider, shutdown, err := telemetry.Setup(ctx, cfg, logger)
	if err != nil {
		logger.Fatal("setting up telemetry", zap.Error(err))
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			logger.Error("telemetry shutdown error", zap.Error(err))
		}
	}()
	_ = provider

	// Create instrumented server
	srv, err := server.NewServer()
	if err != nil {
		logger.Fatal("creating server", zap.Error(err))
	}

	httpSrv := &http.Server{
		Addr:         ":8080",
		Handler:      srv.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		logger.Info("server starting", zap.String("addr", httpSrv.Addr))
		if err := httpSrv.ListenAndServe(); err != http.ErrServerClosed {
			logger.Fatal("server error", zap.Error(err))
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}
}
```

## Testing Observability

```go
// pkg/telemetry/setup_test.go
package telemetry_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestPIIScrubber(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSyncer(exporter),
		sdktrace.WithSpanProcessor(telemetry.NewPIIScrubberReadWrite()),
	)

	tracer := tp.Tracer("test")
	ctx := context.Background()

	// Create span with PII data
	ctx, span := tracer.Start(ctx, "test-operation")
	span.SetAttributes(
		attribute.String("user.email", "user@example.com"),  // PII
		attribute.String("request.path", "/api/orders"),     // Safe
		attribute.String("card.number", "4532015112830366"), // PII
		attribute.String("safe.field", "safe-value"),        // Safe
	)
	span.End()

	tp.ForceFlush(ctx)

	spans := exporter.GetSpans()
	require.Len(t, spans, 1)

	attrs := make(map[string]string)
	for _, kv := range spans[0].Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}

	// PII should be redacted
	assert.Equal(t, "[REDACTED]", attrs["user.email"])
	assert.Equal(t, "[REDACTED]", attrs["card.number"])

	// Safe fields should be unchanged
	assert.Equal(t, "/api/orders", attrs["request.path"])
	assert.Equal(t, "safe-value", attrs["safe.field"])
}

func TestSamplingRate(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSyncer(exporter),
		sdktrace.WithSampler(sdktrace.TraceIDRatioBased(0.5)),
	)

	tracer := tp.Tracer("test")
	ctx := context.Background()

	// Create 1000 traces
	for i := 0; i < 1000; i++ {
		_, span := tracer.Start(ctx, "test")
		span.End()
	}

	tp.ForceFlush(ctx)

	count := len(exporter.GetSpans())
	// Should be approximately 50% (±20% for statistical variation)
	assert.Greater(t, count, 300)
	assert.Less(t, count, 700)
}
```

## Key Takeaways

Production Go observability with OpenTelemetry requires attention to both correctness and performance:

1. **Use ParentBased sampler for head sampling**: Wrapping `TraceIDRatioBased` with `ParentBased` ensures that if an upstream service decided to sample a request, your service follows that decision. Without this, you get broken traces.

2. **Tail-based sampling in the collector, not the SDK**: The SDK cannot make tail-based decisions because it doesn't see the complete trace. Use the OpenTelemetry Collector's `tail_sampling` processor to sample on full trace attributes (errors, latency, specific fields).

3. **Custom span processors enable PII compliance**: Scrubbing PII from spans at the processor layer ensures sensitive data never leaves the service, even if a developer accidentally sets it as an attribute.

4. **Baggage propagation for multi-service correlation**: Baggage is not tracing — it's a side-channel for contextual data (tenant ID, feature flags) that downstream services need without coupling to your span model.

5. **Exemplars bridge metrics to traces in Grafana**: When a Prometheus histogram spike appears, exemplars let you jump directly to the trace that caused it. This eliminates the "what was happening when latency spiked?" investigation step.

6. **OTLP is the lingua franca**: Export to OTLP (gRPC) and let the OpenTelemetry Collector fan out to Jaeger, Tempo, Prometheus, and commercial backends. Never export directly from services to vendor backends.

7. **Test spans with tracetest.InMemoryExporter**: The in-memory exporter makes span output testable. Write unit tests that verify span attributes are correct, PII is scrubbed, and sampling behaves as expected.
