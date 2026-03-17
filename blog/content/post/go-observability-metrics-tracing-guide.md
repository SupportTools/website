---
title: "Go Observability Stack: Unified Metrics, Tracing, and Logging"
date: 2028-03-16T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Observability", "Prometheus", "Tracing", "Grafana", "OTLP"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building a unified observability stack in Go using OpenTelemetry SDK, covering MeterProvider, TracerProvider, LoggerProvider, OTLP exporters, span-metric correlation via exemplars, and Grafana stack integration."
more_link: "yes"
url: "/go-observability-metrics-tracing-guide/"
---

Observability in production Go services requires more than adding a Prometheus endpoint or sprinkling `log.Printf` statements. A mature observability stack produces correlated signals—metrics, traces, and logs that reference each other—so that when an alert fires, the on-call engineer can navigate directly from a dashboard spike to the responsible trace and from that trace to the relevant log lines.

OpenTelemetry provides the standard SDK and wire protocol for all three signal types in a single, vendor-neutral package. This guide covers the full unified setup from SDK initialization through Collector pipeline design and Grafana stack integration.

<!--more-->

## OpenTelemetry Architecture Overview

```
Application (Go SDK)
  ├── MeterProvider   → OTLPMetricExporter  → Collector → Prometheus/Mimir
  ├── TracerProvider  → OTLPTraceExporter   → Collector → Tempo/Jaeger
  └── LoggerProvider  → OTLPLogExporter     → Collector → Loki
                                                    ↓
                                             Grafana (unified view)
```

The OpenTelemetry Collector decouples applications from backends. Applications export to the Collector using OTLP (gRPC or HTTP/JSON). The Collector applies processors—batching, sampling, enrichment—then fans out to multiple backends.

## Go Module Setup

```bash
go get go.opentelemetry.io/otel@v1.24.0
go get go.opentelemetry.io/otel/sdk@v1.24.0
go get go.opentelemetry.io/otel/sdk/metric@v1.24.0
go get go.opentelemetry.io/otel/sdk/log@v0.5.0
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.24.0
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@v1.24.0
go get go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc@v0.5.0
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.49.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.49.0
go get go.opentelemetry.io/contrib/instrumentation/runtime@v0.49.0
```

## Unified SDK Initialization

```go
// internal/telemetry/provider.go
package telemetry

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds all telemetry configuration.
type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	CollectorAddr  string // e.g., "otel-collector:4317"
}

// Providers holds all initialized providers for shutdown coordination.
type Providers struct {
	TracerProvider *sdktrace.TracerProvider
	MeterProvider  *sdkmetric.MeterProvider
	LoggerProvider *sdklog.LoggerProvider
}

// Setup initializes all OpenTelemetry providers and registers globals.
// Call Shutdown on the returned Providers during application teardown.
func Setup(ctx context.Context, cfg Config) (*Providers, error) {
	res, err := buildResource(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("build resource: %w", err)
	}

	conn, err := grpc.DialContext(ctx, cfg.CollectorAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
		grpc.WithTimeout(5*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("connect to collector: %w", err)
	}

	tp, err := newTracerProvider(ctx, conn, res)
	if err != nil {
		return nil, fmt.Errorf("tracer provider: %w", err)
	}

	mp, err := newMeterProvider(ctx, conn, res)
	if err != nil {
		return nil, fmt.Errorf("meter provider: %w", err)
	}

	lp, err := newLoggerProvider(ctx, conn, res)
	if err != nil {
		return nil, fmt.Errorf("logger provider: %w", err)
	}

	// Register as global providers
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	global.SetLoggerProvider(lp)

	// Propagate W3C TraceContext and Baggage across service boundaries
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return &Providers{
		TracerProvider: tp,
		MeterProvider:  mp,
		LoggerProvider: lp,
	}, nil
}

// Shutdown flushes all pending telemetry data and releases resources.
func (p *Providers) Shutdown(ctx context.Context) error {
	var errs []error
	if err := p.TracerProvider.Shutdown(ctx); err != nil {
		errs = append(errs, fmt.Errorf("tracer provider shutdown: %w", err))
	}
	if err := p.MeterProvider.Shutdown(ctx); err != nil {
		errs = append(errs, fmt.Errorf("meter provider shutdown: %w", err))
	}
	if err := p.LoggerProvider.Shutdown(ctx); err != nil {
		errs = append(errs, fmt.Errorf("logger provider shutdown: %w", err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("shutdown errors: %v", errs)
	}
	return nil
}

func buildResource(ctx context.Context, cfg Config) (*resource.Resource, error) {
	return resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithProcess(),
		resource.WithOS(),
		resource.WithContainer(),
		resource.WithHost(),
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			attribute.String("deployment.environment", cfg.Environment),
		),
	)
}

func newTracerProvider(ctx context.Context, conn *grpc.ClientConn, res *resource.Resource) (*sdktrace.TracerProvider, error) {
	exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter,
			sdktrace.WithBatchTimeout(5*time.Second),
			sdktrace.WithMaxExportBatchSize(512),
		),
		sdktrace.WithSampler(sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(0.1), // 10% sample rate for new traces
		)),
		sdktrace.WithResource(res),
	)
	return tp, nil
}

func newMeterProvider(ctx context.Context, conn *grpc.ClientConn, res *resource.Resource) (*sdkmetric.MeterProvider, error) {
	exporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, err
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(
			sdkmetric.NewPeriodicReader(exporter,
				sdkmetric.WithInterval(15*time.Second),
			),
		),
		sdkmetric.WithResource(res),
	)
	return mp, nil
}

func newLoggerProvider(ctx context.Context, conn *grpc.ClientConn, res *resource.Resource) (*sdklog.LoggerProvider, error) {
	exporter, err := otlploggrpc.New(ctx, otlploggrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, err
	}

	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(
			sdklog.NewBatchProcessor(exporter,
				sdklog.WithExportMaxBatchSize(512),
				sdklog.WithExportInterval(5*time.Second),
			),
		),
		sdklog.WithResource(res),
	)
	return lp, nil
}
```

## Application Bootstrap

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

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	otelruntime "go.opentelemetry.io/contrib/instrumentation/runtime"

	"github.com/support-tools/myservice/internal/telemetry"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	providers, err := telemetry.Setup(ctx, telemetry.Config{
		ServiceName:    "order-service",
		ServiceVersion: "v2.3.1",
		Environment:    os.Getenv("ENVIRONMENT"),
		CollectorAddr:  getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317"),
	})
	if err != nil {
		log.Fatalf("telemetry setup: %v", err)
	}

	// Emit Go runtime metrics (goroutines, GC pauses, memory allocations)
	if err := otelruntime.Start(otelruntime.WithMinimumReadMemStatsInterval(10 * time.Second)); err != nil {
		log.Fatalf("runtime instrumentation: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/orders", handleOrders)

	// Wrap with OTel HTTP middleware — auto-creates spans for every request
	handler := otelhttp.NewHandler(mux, "order-service",
		otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
			return r.Method + " " + r.URL.Path
		}),
	)

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		log.Printf("listening on :8080")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown error: %v", err)
	}
	if err := providers.Shutdown(shutdownCtx); err != nil {
		log.Printf("telemetry shutdown error: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

## Custom Metrics with Exemplars

Exemplars link specific metric data points to trace IDs, enabling navigation from a histogram bucket directly to a representative trace.

```go
// internal/metrics/http.go
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

var meter = otel.Meter("order-service")

var (
	requestDuration metric.Float64Histogram
	requestTotal    metric.Int64Counter
)

func init() {
	var err error
	requestDuration, err = meter.Float64Histogram(
		"http.server.request.duration",
		metric.WithDescription("HTTP request duration in seconds"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(
			0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
		),
	)
	if err != nil {
		panic(err)
	}

	requestTotal, err = meter.Int64Counter(
		"http.server.request.total",
		metric.WithDescription("Total HTTP requests processed"),
	)
	if err != nil {
		panic(err)
	}
}

// RecordRequest records HTTP metrics. Exemplar attachment happens automatically
// when a span is active in the context—the SDK reads the trace/span IDs.
func RecordRequest(ctx context.Context, method, route string, statusCode int, duration time.Duration) {
	attrs := []attribute.KeyValue{
		attribute.String("http.method", method),
		attribute.String("http.route", route),
		attribute.Int("http.status_code", statusCode),
	}

	requestDuration.Record(ctx, duration.Seconds(), metric.WithAttributes(attrs...))
	requestTotal.Add(ctx, 1, metric.WithAttributes(attrs...))
}
```

## Structured Tracing with Business Context

```go
// internal/service/orders.go
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

var tracer = otel.Tracer("order-service/service")

type OrderService struct {
	db        Database
	inventory InventoryClient
}

func (s *OrderService) PlaceOrder(ctx context.Context, req OrderRequest) (*Order, error) {
	ctx, span := tracer.Start(ctx, "OrderService.PlaceOrder",
		trace.WithAttributes(
			attribute.String("order.customer_id", req.CustomerID),
			attribute.String("order.product_id", req.ProductID),
			attribute.Int("order.quantity", req.Quantity),
		),
		trace.WithSpanKind(trace.SpanKindInternal),
	)
	defer span.End()

	// Check inventory — child span auto-inherits trace context
	available, err := s.checkInventory(ctx, req.ProductID, req.Quantity)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "inventory check failed")
		return nil, fmt.Errorf("check inventory: %w", err)
	}

	if !available {
		span.SetAttributes(attribute.Bool("order.inventory_available", false))
		span.SetStatus(codes.Error, "insufficient inventory")
		return nil, ErrInsufficientInventory
	}

	order, err := s.db.CreateOrder(ctx, req)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "database write failed")
		return nil, fmt.Errorf("create order: %w", err)
	}

	span.SetAttributes(
		attribute.String("order.id", order.ID),
		attribute.Bool("order.inventory_available", true),
	)
	span.SetStatus(codes.Ok, "")
	return order, nil
}

func (s *OrderService) checkInventory(ctx context.Context, productID string, qty int) (bool, error) {
	ctx, span := tracer.Start(ctx, "OrderService.checkInventory",
		trace.WithAttributes(
			attribute.String("inventory.product_id", productID),
			attribute.Int("inventory.quantity_requested", qty),
		),
	)
	defer span.End()

	result, err := s.inventory.Check(ctx, productID, qty)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return false, err
	}

	span.SetAttributes(attribute.Bool("inventory.available", result))
	return result, nil
}
```

## gRPC Auto-Instrumentation

```go
// internal/client/inventory.go
package client

import (
	"google.golang.org/grpc"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func NewInventoryClient(addr string) (*grpc.ClientConn, error) {
	return grpc.Dial(addr,
		// Injects trace context into outgoing gRPC metadata
		grpc.WithUnaryInterceptor(otelgrpc.UnaryClientInterceptor()),
		grpc.WithStreamInterceptor(otelgrpc.StreamClientInterceptor()),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
}

// gRPC server instrumentation
func NewServer() *grpc.Server {
	return grpc.NewServer(
		// Extracts trace context from incoming metadata
		grpc.UnaryInterceptor(otelgrpc.UnaryServerInterceptor()),
		grpc.StreamInterceptor(otelgrpc.StreamServerInterceptor()),
	)
}
```

## Go Runtime Metrics

The `otelruntime` package collects memory allocator stats, GC pause durations, goroutine counts, and scheduler latency:

```go
import otelruntime "go.opentelemetry.io/contrib/instrumentation/runtime"

// Start runtime instrumentation after MeterProvider is registered globally
if err := otelruntime.Start(
	otelruntime.WithMinimumReadMemStatsInterval(10 * time.Second),
); err != nil {
	log.Fatalf("runtime metrics: %v", err)
}
```

Key metrics emitted:

```
process.runtime.go.goroutines          # active goroutines
process.runtime.go.mem.heap_alloc_bytes # live heap bytes
process.runtime.go.gc.pause_ns         # GC pause histogram
process.runtime.go.mem.lookups         # pointer lookups per second
process.runtime.go.mem.live_objects    # live heap objects count
```

## OpenTelemetry Collector Configuration

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
  # Prevent OOM by dropping data when memory exceeds threshold
  memory_limiter:
    check_interval: 1s
    limit_mib: 1500
    spike_limit_mib: 512

  # Batch for efficiency — reduces export frequency
  batch:
    timeout: 10s
    send_batch_size: 1024
    send_batch_max_size: 2048

  # Add k8s metadata to all signals
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    filter:
      node_from_env_var: K8S_NODE_NAME
    extract:
      metadata:
        - k8s.namespace.name
        - k8s.deployment.name
        - k8s.statefulset.name
        - k8s.pod.name
        - k8s.pod.uid
        - k8s.node.name
        - k8s.container.name
      labels:
        - tag_name: app.label.version
          key: app.kubernetes.io/version
          from: pod
      annotations:
        - tag_name: app.annotation.team
          key: support.tools/team
          from: pod
    pod_association:
      - sources:
          - from: resource_attribute
            name: k8s.pod.ip

  # Tail-based sampling — sample 100% of error traces, 10% of success
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 1000
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: slow-traces
        type: latency
        latency: {threshold_ms: 1000}
      - name: probabilistic-baseline
        type: probabilistic
        probabilistic: {sampling_percentage: 10}

  # Resource detection for cloud metadata
  resourcedetection:
    detectors: [env, gcp, aws, azure, k8s]
    timeout: 5s

  # Filter out noisy health check spans
  filter/drop-healthchecks:
    traces:
      span:
        - 'attributes["http.target"] == "/healthz"'
        - 'attributes["http.target"] == "/readyz"'
        - 'attributes["http.target"] == "/metrics"'

exporters:
  # Traces → Grafana Tempo
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true

  # Metrics → Grafana Mimir (Prometheus-compatible)
  prometheusremotewrite:
    endpoint: http://mimir.monitoring.svc.cluster.local:9009/api/v1/push
    resource_to_telemetry_conversion:
      enabled: true
    add_metric_suffixes: true

  # Logs → Grafana Loki
  loki:
    endpoint: http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push
    default_labels_enabled:
      exporter: false
      job: true
      instance: false
      level: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, filter/drop-healthchecks, tail_sampling, batch]
      exporters: [otlp/tempo]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [prometheusremotewrite]

    logs:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [loki]

  telemetry:
    logs:
      level: warn
    metrics:
      address: 0.0.0.0:8888
```

## Grafana Stack Integration

### Grafana Data Source Configuration

```yaml
# grafana-datasources.yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://mimir.monitoring.svc.cluster.local:9009/prometheus
    uid: prometheus
    jsonData:
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo
          urlDisplayLabel: "View in Tempo"

  - name: Tempo
    type: tempo
    url: http://tempo.monitoring.svc.cluster.local:3100
    uid: tempo
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceID: true
        filterBySpanID: false
        customQuery: false
      tracesToMetrics:
        datasourceUid: prometheus
        queries:
          - name: Request rate
            query: >
              rate(http_server_request_total{$$__tags}[5m])
      serviceMap:
        datasourceUid: prometheus
      nodeGraph:
        enabled: true

  - name: Loki
    type: loki
    url: http://loki.monitoring.svc.cluster.local:3100
    uid: loki
    jsonData:
      derivedFields:
        - matcherRegex: '"trace_id":"(\w+)"'
          name: TraceID
          url: "${__value.raw}"
          datasourceUid: tempo
```

### Sample Dashboard Query: P99 Latency with Exemplars

```promql
# P99 HTTP request latency with exemplar support
histogram_quantile(0.99,
  sum by (le, http_route) (
    rate(http_server_request_duration_seconds_bucket{
      service_name="order-service"
    }[5m])
  )
)
```

Enable exemplar display in Grafana panel settings:
- Graph type: Time series
- Overrides > Add override > Standard options > Show exemplars > On

When an exemplar appears on the chart, clicking it navigates to the corresponding trace in Tempo.

## Structured Logging Integration with Zap

Bridge zap's structured logging to the OTel Logs SDK:

```go
// internal/logging/otel_bridge.go
package logging

import (
	"context"

	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/log/global"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// OtelCore implements zapcore.Core, forwarding zap log entries to the OTel Logs SDK.
type OtelCore struct {
	logger log.Logger
	level  zapcore.Level
	fields []zap.Field
}

func NewOtelCore(name string, level zapcore.Level) *OtelCore {
	return &OtelCore{
		logger: global.Logger(name),
		level:  level,
	}
}

func (c *OtelCore) Enabled(level zapcore.Level) bool {
	return level >= c.level
}

func (c *OtelCore) With(fields []zap.Field) zapcore.Core {
	return &OtelCore{
		logger: c.logger,
		level:  c.level,
		fields: append(c.fields, fields...),
	}
}

func (c *OtelCore) Check(entry zapcore.Entry, ce *zapcore.CheckedEntry) *zapcore.CheckedEntry {
	if c.Enabled(entry.Level) {
		return ce.AddCore(entry, c)
	}
	return ce
}

func (c *OtelCore) Write(entry zapcore.Entry, fields []zapcore.Field) error {
	record := log.Record{}
	record.SetTimestamp(entry.Time)
	record.SetSeverityText(entry.Level.String())
	record.SetBody(log.StringValue(entry.Message))

	ctx := context.Background()
	c.logger.Emit(ctx, record)
	return nil
}

func (c *OtelCore) Sync() error { return nil }

// NewLogger creates a zap logger that outputs to both stdout and OTel.
func NewLogger(serviceName string) (*zap.Logger, error) {
	zapConfig := zap.NewProductionConfig()
	zapLogger, err := zapConfig.Build()
	if err != nil {
		return nil, err
	}

	otelCore := NewOtelCore(serviceName, zapcore.InfoLevel)
	combined := zap.New(zapcore.NewTee(zapLogger.Core(), otelCore))
	return combined, nil
}
```

## Sampling Strategies

```go
// Adaptive sampling: 100% for errors/slow, configurable baseline
func newSampler(baseSampleRate float64) sdktrace.Sampler {
	return sdktrace.ParentBased(
		// Root span sampling decision
		sdktrace.TraceIDRatioBased(baseSampleRate),
		// Always follow parent's decision for child spans
		sdktrace.WithRemoteSampledRoot(sdktrace.AlwaysSample()),
		sdktrace.WithRemoteNotSampledRoot(sdktrace.NeverSample()),
		sdktrace.WithLocalSampledRoot(sdktrace.AlwaysSample()),
		sdktrace.WithLocalNotSampledRoot(sdktrace.NeverSample()),
	)
}

// For development environments — always sample
func devSampler() sdktrace.Sampler {
	return sdktrace.AlwaysSample()
}
```

## Kubernetes Deployment for the Collector

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  mode: DaemonSet  # One collector per node for log/metric collection
  config: |
    # ... configuration from above ...
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 1Gi
  env:
    - name: K8S_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
```

## Production Checklist

```
SDK Configuration
[ ] MeterProvider, TracerProvider, LoggerProvider all initialized before first request
[ ] Shutdown hook registered to flush pending data on SIGTERM
[ ] Resource attributes include service.name, service.version, deployment.environment
[ ] W3C TraceContext propagator configured for cross-service trace correlation
[ ] Sampler uses ParentBased to respect upstream sampling decisions

Collector Pipeline
[ ] memory_limiter processor at the front of every pipeline
[ ] batch processor configured for throughput (not latency)
[ ] tail_sampling captures 100% of errors and slow traces
[ ] k8sattributes enriches all signals with pod/namespace/deployment labels
[ ] Health check spans filtered before export

Grafana Integration
[ ] Exemplar trace ID destinations configured on Prometheus datasource
[ ] Tempo tracesToLogsV2 links traces to Loki log lines
[ ] Service map visualization enabled in Tempo datasource

Alerting
[ ] Alert on collector queue_size > 80% (signals dropped data)
[ ] Alert on exporter send_failed_spans > 0 for 5 minutes
[ ] Alert on service P99 latency > SLO threshold
```

A unified OpenTelemetry setup transforms debugging from log grepping into navigating correlated signal flows—alerting on a metric, jumping to an exemplar trace, then viewing the structured log lines attached to the failing span. The investment in proper SDK initialization and Collector pipeline design pays continuous dividends in mean time to diagnosis.
