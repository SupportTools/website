---
title: "OpenTelemetry Metrics in Go: Instrumentation, Collection, and Prometheus Export"
date: 2030-05-28T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Go", "Golang", "Prometheus", "Observability", "Metrics", "Monitoring"]
categories:
- Go
- Observability
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to OTel metrics SDK in Go: counter, gauge, histogram instruments, resource detection, exemplars, multi-exporter configuration, and correlation with traces and logs."
more_link: "yes"
url: "/opentelemetry-metrics-go-instrumentation-prometheus-export/"
---

OpenTelemetry (OTel) has emerged as the vendor-neutral standard for application observability, unifying metrics, traces, and logs under a single instrumentation API. For Go services, the OpenTelemetry Go SDK provides a consistent, low-overhead approach to metrics collection that integrates with both Prometheus (for scraping) and OTLP (for direct export to collectors). This guide covers the complete OTel metrics stack in Go from basic instrumentation through advanced patterns like exemplar propagation and multi-exporter configuration.

The focus is on production patterns: avoiding common SDK misconfigurations, correlating metrics with traces, and operating the OpenTelemetry Collector in high-throughput environments.

<!--more-->

## OTel Metrics Concepts

### Instruments

OTel defines three measurement types mapped to six instruments:

| Instrument | Measurement Type | Aggregation | Use Case |
|------------|-----------------|-------------|----------|
| Counter | Sum (monotonic) | Sum | Request count, bytes sent |
| UpDownCounter | Sum (non-monotonic) | Sum | Queue depth, active connections |
| Histogram | Distribution | Histogram | Request latency, payload size |
| ObservableCounter | Async Sum (monotonic) | Sum | CPU time, GC count |
| ObservableUpDownCounter | Async Sum (non-monotonic) | Sum | Memory usage, goroutine count |
| ObservableGauge | Async Gauge | LastValue | Temperature, current config value |

### SDK Architecture

```
Application Code
     │
     │  meter.Int64Counter(...)
     ▼
OTel API (stable, backward-compatible)
     │
     ▼
OTel SDK (MeterProvider, View configuration)
     │
     ├── Periodic Reader (every 30s)
     │       │
     │       ├── Prometheus Exporter (scrape endpoint)
     │       └── OTLP Exporter (push to collector)
     │
     └── Metric Storage (in-memory, per-instrument)
```

## Go SDK Setup

### Dependencies

```bash
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/metric
go get go.opentelemetry.io/otel/sdk/metric
go get go.opentelemetry.io/otel/exporters/prometheus
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc
go get go.opentelemetry.io/otel/bridge/prometheus  # Prometheus -> OTel bridge
```

### MeterProvider Initialization

```go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    prometheusexporter "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/sdk/metric"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string        // gRPC endpoint for OTLP collector
    PrometheusPort int           // Port for Prometheus scrape endpoint
    ExportInterval time.Duration // How often to collect and export metrics
}

// InitMetrics configures and returns a MeterProvider with Prometheus and OTLP exporters.
func InitMetrics(ctx context.Context, cfg Config) (*sdkmetric.MeterProvider, error) {
    // Build resource describing this service
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            attribute.String("environment", cfg.Environment),
        ),
        resource.WithOS(),
        resource.WithProcess(),
        resource.WithHost(),
        resource.WithContainer(),
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    // Prometheus exporter — no periodic reader needed, uses pull model
    promExporter, err := prometheusexporter.New(
        prometheusexporter.WithNamespace("app"),
        prometheusexporter.WithoutScopeInfo(),
        prometheusexporter.WithoutUnits(),
    )
    if err != nil {
        return nil, fmt.Errorf("create prometheus exporter: %w", err)
    }

    // OTLP gRPC exporter — push model to OpenTelemetry Collector
    conn, err := grpc.NewClient(
        cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("connect to OTLP endpoint: %w", err)
    }

    otlpExporter, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithGRPCConn(conn),
        otlpmetricgrpc.WithTimeout(5*time.Second),
        otlpmetricgrpc.WithRetry(otlpmetricgrpc.RetryConfig{
            Enabled:         true,
            InitialInterval: 1 * time.Second,
            MaxInterval:     30 * time.Second,
            MaxElapsedTime:  5 * time.Minute,
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("create OTLP exporter: %w", err)
    }

    // Define custom views for histogram buckets
    httpLatencyView := sdkmetric.NewView(
        sdkmetric.Instrument{
            Name: "http.server.request.duration",
        },
        sdkmetric.Stream{
            Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
                Boundaries: []float64{
                    0.001, 0.005, 0.01, 0.025, 0.05, 0.075,
                    0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 10.0,
                },
            },
        },
    )

    dbLatencyView := sdkmetric.NewView(
        sdkmetric.Instrument{
            Name: "db.client.operation.duration",
        },
        sdkmetric.Stream{
            Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
                Boundaries: []float64{
                    0.001, 0.002, 0.005, 0.01, 0.02, 0.05,
                    0.1, 0.2, 0.5, 1.0, 2.0, 5.0,
                },
            },
        },
    )

    // Build MeterProvider with both exporters
    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithResource(res),
        // Prometheus reader (no interval — pull-based)
        sdkmetric.WithReader(promExporter),
        // OTLP reader (push every ExportInterval)
        sdkmetric.WithReader(sdkmetric.NewPeriodicReader(
            otlpExporter,
            sdkmetric.WithInterval(cfg.ExportInterval),
            sdkmetric.WithTimeout(10*time.Second),
        )),
        // Custom views for histogram boundaries
        sdkmetric.WithView(httpLatencyView, dbLatencyView),
    )

    // Set global MeterProvider
    otel.SetMeterProvider(mp)

    return mp, nil
}
```

## Counter Instrumentation

### HTTP Request Counter

```go
package httpmetrics

import (
    "context"
    "net/http"
    "strconv"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

const instrumentationName = "github.com/company/app/internal/httpmetrics"

// ServerMetrics holds all HTTP server metric instruments.
type ServerMetrics struct {
    requestTotal    metric.Int64Counter
    requestDuration metric.Float64Histogram
    requestInFlight metric.Int64UpDownCounter
    requestBodySize metric.Int64Histogram
    responseBodySize metric.Int64Histogram
}

func NewServerMetrics() (*ServerMetrics, error) {
    meter := otel.GetMeterProvider().Meter(
        instrumentationName,
        metric.WithInstrumentationVersion("0.1.0"),
        metric.WithSchemaURL(semconv.SchemaURL),
    )

    requestTotal, err := meter.Int64Counter(
        "http.server.request.total",
        metric.WithDescription("Total number of HTTP requests received"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    requestDuration, err := meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("Duration of HTTP requests in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
        ),
    )
    if err != nil {
        return nil, err
    }

    requestInFlight, err := meter.Int64UpDownCounter(
        "http.server.active_requests",
        metric.WithDescription("Number of HTTP requests currently being processed"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    requestBodySize, err := meter.Int64Histogram(
        "http.server.request.body.size",
        metric.WithDescription("HTTP request body size in bytes"),
        metric.WithUnit("By"),
        metric.WithExplicitBucketBoundaries(
            100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000,
        ),
    )
    if err != nil {
        return nil, err
    }

    responseBodySize, err := meter.Int64Histogram(
        "http.server.response.body.size",
        metric.WithDescription("HTTP response body size in bytes"),
        metric.WithUnit("By"),
        metric.WithExplicitBucketBoundaries(
            100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000,
        ),
    )
    if err != nil {
        return nil, err
    }

    return &ServerMetrics{
        requestTotal:     requestTotal,
        requestDuration:  requestDuration,
        requestInFlight:  requestInFlight,
        requestBodySize:  requestBodySize,
        responseBodySize: responseBodySize,
    }, nil
}

// Middleware wraps an HTTP handler with OTel metrics instrumentation.
func (m *ServerMetrics) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        ctx := r.Context()

        attrs := []attribute.KeyValue{
            attribute.String("http.request.method", r.Method),
            attribute.String("http.route", r.Pattern), // Go 1.22+ pattern
            attribute.String("server.address", r.Host),
        }

        m.requestInFlight.Add(ctx, 1, metric.WithAttributes(attrs...))
        defer m.requestInFlight.Add(ctx, -1, metric.WithAttributes(attrs...))

        if r.ContentLength > 0 {
            m.requestBodySize.Record(ctx, r.ContentLength, metric.WithAttributes(attrs...))
        }

        rw := &responseWriter{ResponseWriter: w, statusCode: 200}
        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        statusAttrs := append(attrs,
            attribute.Int("http.response.status_code", rw.statusCode),
        )

        m.requestTotal.Add(ctx, 1, metric.WithAttributes(statusAttrs...))
        m.requestDuration.Record(ctx, duration, metric.WithAttributes(statusAttrs...))
        if rw.bytesWritten > 0 {
            m.responseBodySize.Record(ctx, rw.bytesWritten, metric.WithAttributes(statusAttrs...))
        }
    })
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
```

## Histogram Instrumentation

### Database Operation Metrics

```go
package dbmetrics

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

// DBMetrics instruments database operations following OTel semantic conventions.
type DBMetrics struct {
    operationDuration metric.Float64Histogram
    operationErrors   metric.Int64Counter
    poolSize          metric.Int64ObservableGauge
    poolWaitDuration  metric.Float64Histogram
    rowsAffected      metric.Int64Histogram
}

func NewDBMetrics(db *sql.DB, dbSystem, dbName string) (*DBMetrics, error) {
    meter := otel.Meter("github.com/company/app/internal/dbmetrics")

    attrs := []attribute.KeyValue{
        attribute.String("db.system", dbSystem),  // "postgresql", "mysql"
        attribute.String("db.name", dbName),
    }

    operationDuration, err := meter.Float64Histogram(
        "db.client.operation.duration",
        metric.WithDescription("Duration of database operations"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    operationErrors, err := meter.Int64Counter(
        "db.client.operation.errors",
        metric.WithDescription("Number of database operation errors"),
        metric.WithUnit("{error}"),
    )
    if err != nil {
        return nil, err
    }

    rowsAffected, err := meter.Int64Histogram(
        "db.client.rows_affected",
        metric.WithDescription("Number of rows affected by database operations"),
        metric.WithUnit("{row}"),
        metric.WithExplicitBucketBoundaries(0, 1, 5, 10, 50, 100, 500, 1000, 5000),
    )
    if err != nil {
        return nil, err
    }

    // Connection pool metrics use async gauges
    poolSize, err := meter.Int64ObservableGauge(
        "db.client.connection.pool.size",
        metric.WithDescription("Current number of connections in the pool"),
        metric.WithUnit("{connection}"),
    )
    if err != nil {
        return nil, err
    }

    // Register the pool size callback
    _, err = meter.RegisterCallback(
        func(ctx context.Context, observer metric.Observer) error {
            stats := db.Stats()
            poolAttrs := append(attrs,
                attribute.String("pool.state", "open"),
            )
            observer.ObserveInt64(poolSize, int64(stats.OpenConnections),
                metric.WithAttributes(poolAttrs...))

            idleAttrs := append(attrs,
                attribute.String("pool.state", "idle"),
            )
            observer.ObserveInt64(poolSize, int64(stats.Idle),
                metric.WithAttributes(idleAttrs...))
            return nil
        },
        poolSize,
    )
    if err != nil {
        return nil, err
    }

    return &DBMetrics{
        operationDuration: operationDuration,
        operationErrors:   operationErrors,
        rowsAffected:      rowsAffected,
    }, nil
}

// RecordOperation records duration and outcome for a database operation.
func (m *DBMetrics) RecordOperation(
    ctx context.Context,
    operation string,  // "SELECT", "INSERT", "UPDATE", "DELETE"
    table string,
    start time.Time,
    rowsAffected int64,
    err error,
) {
    duration := time.Since(start).Seconds()
    attrs := []attribute.KeyValue{
        attribute.String("db.operation.name", operation),
        attribute.String("db.sql.table", table),
    }

    if err != nil {
        attrs = append(attrs, attribute.Bool("error", true))
        m.operationErrors.Add(ctx, 1, metric.WithAttributes(attrs...))
    }

    m.operationDuration.Record(ctx, duration, metric.WithAttributes(attrs...))

    if rowsAffected >= 0 {
        m.rowsAffected.Record(ctx, rowsAffected, metric.WithAttributes(attrs...))
    }
}
```

## Observable Gauges for Runtime Metrics

```go
package runtimemetrics

import (
    "context"
    "runtime"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

// RegisterRuntimeMetrics registers Go runtime metrics as async observables.
func RegisterRuntimeMetrics() error {
    meter := otel.Meter("github.com/company/app/runtime")

    goroutineCount, err := meter.Int64ObservableGauge(
        "process.runtime.go.goroutines",
        metric.WithDescription("Number of goroutines currently running"),
        metric.WithUnit("{goroutine}"),
    )
    if err != nil {
        return err
    }

    gcPauseTotal, err := meter.Float64ObservableCounter(
        "process.runtime.go.gc.pause_total",
        metric.WithDescription("Total time spent in GC stop-the-world pauses"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return err
    }

    gcCount, err := meter.Int64ObservableCounter(
        "process.runtime.go.gc.count",
        metric.WithDescription("Number of completed GC cycles"),
        metric.WithUnit("{gc_cycle}"),
    )
    if err != nil {
        return err
    }

    heapAlloc, err := meter.Int64ObservableGauge(
        "process.runtime.go.mem.heap_alloc",
        metric.WithDescription("Bytes of allocated heap objects"),
        metric.WithUnit("By"),
    )
    if err != nil {
        return err
    }

    heapInuse, err := meter.Int64ObservableGauge(
        "process.runtime.go.mem.heap_inuse",
        metric.WithDescription("Bytes in in-use spans"),
        metric.WithUnit("By"),
    )
    if err != nil {
        return err
    }

    _, err = meter.RegisterCallback(
        func(ctx context.Context, observer metric.Observer) error {
            var ms runtime.MemStats
            runtime.ReadMemStats(&ms)

            observer.ObserveInt64(goroutineCount, int64(runtime.NumGoroutine()))
            observer.ObserveFloat64(gcPauseTotal, float64(ms.PauseTotalNs)/1e9)
            observer.ObserveInt64(gcCount, int64(ms.NumGC))
            observer.ObserveInt64(heapAlloc, int64(ms.HeapAlloc))
            observer.ObserveInt64(heapInuse, int64(ms.HeapInuse))

            return nil
        },
        goroutineCount, gcPauseTotal, gcCount, heapAlloc, heapInuse,
    )
    return err
}
```

## Exemplars: Linking Metrics to Traces

Exemplars attach trace context to histogram samples, enabling jump-from-metric-to-trace navigation in Grafana.

```go
package exemplar

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

// ExemplarMiddleware attaches trace context to metric exemplars.
// Exemplars allow navigation from a high-latency histogram bucket
// to the specific trace that caused the latency spike.
func ExemplarMiddleware(duration metric.Float64Histogram) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            ctx := r.Context()

            next.ServeHTTP(w, r)

            elapsed := time.Since(start).Seconds()

            // Extract current span context to attach as exemplar
            spanCtx := trace.SpanFromContext(ctx).SpanContext()

            attrs := []attribute.KeyValue{
                attribute.String("http.method", r.Method),
                attribute.String("http.route", r.Pattern),
            }

            if spanCtx.IsValid() {
                // The SDK automatically attaches TraceID and SpanID
                // to histogram samples when a valid span context is present.
                // No explicit action needed — the SDK reads trace context
                // from the context.Context automatically.
                duration.Record(ctx, elapsed, metric.WithAttributes(attrs...))
            } else {
                duration.Record(ctx, elapsed, metric.WithAttributes(attrs...))
            }
        })
    }
}
```

### Prometheus Scrape Configuration with Exemplar Support

```yaml
# prometheus-config.yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'app-backend'
    static_configs:
      - targets: ['app-backend.production.svc.cluster.local:9090']
    # Enable exemplar scraping (requires Prometheus 2.43+)
    scrape_classic_histograms: true

storage:
  tsdb:
    path: /prometheus
    retention:
      time: 30d
    # Enable exemplar storage
    exemplars:
      max-exemplars: 100000
```

## Multi-Exporter Configuration

### OpenTelemetry Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
      http:
        endpoint: "0.0.0.0:4318"
  prometheus:
    config:
      scrape_configs:
        - job_name: 'otel-collector'
          static_configs:
            - targets: ['localhost:8888']

processors:
  batch:
    timeout: 10s
    send_batch_size: 1000
    send_batch_max_size: 2000

  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 25

  resource:
    attributes:
      - key: deployment.environment
        from_attribute: environment
        action: insert
      - key: cloud.region
        value: us-east-1
        action: insert

  filter/drop_internal:
    metrics:
      exclude:
        match_type: regexp
        metric_names:
          - "otelcol_.*"

exporters:
  prometheusremotewrite:
    endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
    resource_to_telemetry_conversion:
      enabled: true
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 5m

  otlp/tempo:
    endpoint: "http://tempo.monitoring.svc.cluster.local:4317"
    tls:
      insecure: true

  logging:
    verbosity: normal

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheusremotewrite, logging]

    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [otlp/tempo]

  telemetry:
    logs:
      level: "info"
    metrics:
      address: ":8888"
```

### Kubernetes Deployment of OTel Collector

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
        prometheus.io/port: "8888"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.102.0
          args:
            - --config=/etc/otel/config.yaml
          ports:
            - containerPort: 4317
              name: otlp-grpc
            - containerPort: 4318
              name: otlp-http
            - containerPort: 8888
              name: metrics
          resources:
            requests:
              memory: 256Mi
              cpu: 100m
            limits:
              memory: 512Mi
              cpu: 500m
          volumeMounts:
            - name: config
              mountPath: /etc/otel
          readinessProbe:
            httpGet:
              path: /
              port: 13133
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /
              port: 13133
            initialDelaySeconds: 10
            periodSeconds: 30
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
```

## Correlating Metrics with Traces and Logs

### Trace-Metric Correlation Pattern

```go
package observability

import (
    "context"
    "log/slog"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

// OperationTracer combines trace span creation with metric recording.
// This ensures every traced operation also updates relevant metrics.
type OperationTracer struct {
    tracer   trace.Tracer
    duration metric.Float64Histogram
    errors   metric.Int64Counter
}

func NewOperationTracer(name string) (*OperationTracer, error) {
    meter := otel.Meter("github.com/company/app")

    duration, err := meter.Float64Histogram(
        name+".duration",
        metric.WithDescription("Operation duration in seconds"),
        metric.WithUnit("s"),
    )
    if err != nil {
        return nil, err
    }

    errors, err := meter.Int64Counter(
        name+".errors",
        metric.WithDescription("Number of operation errors"),
        metric.WithUnit("{error}"),
    )
    if err != nil {
        return nil, err
    }

    return &OperationTracer{
        tracer:   otel.Tracer("github.com/company/app"),
        duration: duration,
        errors:   errors,
    }, nil
}

// Trace executes fn within a span and records metrics.
// The span context is automatically linked to histogram exemplars.
func (t *OperationTracer) Trace(
    ctx context.Context,
    operationName string,
    attrs []attribute.KeyValue,
    fn func(ctx context.Context) error,
) error {
    ctx, span := t.tracer.Start(ctx, operationName,
        trace.WithAttributes(attrs...),
    )
    defer span.End()

    start := time.Now()
    err := fn(ctx)
    duration := time.Since(start).Seconds()

    otelAttrs := append(attrs,
        attribute.Bool("error", err != nil),
    )

    // ctx carries the active span — SDK attaches TraceID/SpanID as exemplar
    t.duration.Record(ctx, duration, metric.WithAttributes(otelAttrs...))

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        t.errors.Add(ctx, 1, metric.WithAttributes(otelAttrs...))

        slog.ErrorContext(ctx, "operation failed",
            "operation", operationName,
            "duration_s", duration,
            "error", err,
            // trace_id and span_id automatically injected by slog-otlp handler
        )
    } else {
        slog.InfoContext(ctx, "operation completed",
            "operation", operationName,
            "duration_s", duration,
        )
    }

    return err
}
```

## Grafana Dashboard Configuration

```json
{
  "panels": [
    {
      "title": "HTTP Request Rate",
      "type": "graph",
      "targets": [
        {
          "expr": "rate(app_http_server_request_total[5m])",
          "legendFormat": "{{http_route}} {{http_response_status_code}}"
        }
      ]
    },
    {
      "title": "HTTP Request Latency P99",
      "type": "graph",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, rate(app_http_server_request_duration_seconds_bucket[5m]))",
          "legendFormat": "p99 {{http_route}}"
        }
      ]
    },
    {
      "title": "Database Operation Duration (with Exemplars)",
      "type": "histogram",
      "options": {
        "fillOpacity": 80
      },
      "targets": [
        {
          "expr": "rate(app_db_client_operation_duration_seconds_bucket[5m])",
          "exemplar": true,
          "legendFormat": "{{db_operation_name}}"
        }
      ]
    }
  ]
}
```

## Summary

OpenTelemetry's Go SDK provides a production-ready metrics foundation that supports both the Prometheus scrape model and OTLP push model simultaneously. The combination of synchronous instruments (counters, histograms) for request-time recording and asynchronous observables for runtime state yields comprehensive coverage without significant overhead.

Exemplars bridge the gap between metrics and traces, enabling the jump from a high-latency histogram bucket directly to the offending trace—a capability that reduces mean time to diagnosis from hours to minutes in production incident investigations. The multi-exporter pattern ensures metrics reach both short-term Prometheus retention and long-term OTLP-compatible storage without requiring instrumentation changes.
