---
title: "Go Observability Patterns: Metrics, Traces, and Logs in Production"
date: 2027-10-19T00:00:00-05:00
draft: false
tags: ["Go", "Observability", "OpenTelemetry", "Prometheus", "Logging"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go observability covering structured logging with slog, Prometheus metrics with exemplars, OpenTelemetry tracing, correlation IDs, pprof profiling, and the performance cost of instrumentation."
more_link: "yes"
url: "/go-observability-production-patterns-guide/"
---

Observability is not a feature added after a system is built — it is a design constraint that shapes the code from the first function signature. This guide covers every pillar of observability for Go services: structured logs that can be queried, metrics with exemplars that link to traces, and distributed traces that reveal latency across service boundaries.

<!--more-->

# Go Observability Patterns: Metrics, Traces, and Logs in Production

## Section 1: Structured Logging with slog

Go 1.21 introduced `log/slog` as the standard structured logger, replacing the ecosystem of `zap`, `zerolog`, and `logrus` for new services. Production services need a logger configured at startup that is available throughout the request lifecycle via context.

### Logger Setup and Context Propagation

```go
// observability/logger.go
package observability

import (
	"context"
	"log/slog"
	"os"
)

type contextKey int

const loggerKey contextKey = iota

// NewLogger creates a JSON-format logger for production.
func NewLogger(level slog.Level) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level:     level,
		AddSource: true,
	})
	return slog.New(h)
}

// WithLogger stores a logger in the context.
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, logger)
}

// FromContext retrieves the logger from context, falling back to the default.
func FromContext(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}
```

### Correlation ID Middleware

```go
// middleware/correlation.go
package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"myapp/observability"
)

const correlationIDHeader = "X-Correlation-ID"

// CorrelationID injects a correlation ID into every request context.
// If the upstream sends X-Correlation-ID, it is preserved.
func CorrelationID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(correlationIDHeader)
		if id == "" {
			id = uuid.New().String()
		}

		w.Header().Set(correlationIDHeader, id)

		// Attach ID to the logger stored in context.
		logger := observability.FromContext(r.Context()).With(
			"correlation_id", id,
		)
		ctx := observability.WithLogger(r.Context(), logger)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

### Log Fields Convention

Standardizing field names across services makes logs queryable in any aggregation system:

```go
// Canonical log fields — use these everywhere.
const (
	FieldService    = "service"
	FieldVersion    = "version"
	FieldEnv        = "env"
	FieldTraceID    = "trace_id"
	FieldSpanID     = "span_id"
	FieldUserID     = "user_id"
	FieldRequestID  = "request_id"
	FieldStatusCode = "http.status_code"
	FieldMethod     = "http.method"
	FieldPath       = "http.path"
	FieldLatencyMS  = "latency_ms"
	FieldError      = "error"
)

// Example structured log in a handler:
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	log := observability.FromContext(r.Context())
	start := time.Now()

	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		log.Error("invalid user ID", FieldError, err.Error())
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	user, err := h.svc.GetUser(r.Context(), id)
	if err != nil {
		log.Error("get user failed",
			FieldError, err.Error(),
			"user_id", id,
		)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	log.Info("get user",
		FieldUserID, user.ID,
		FieldLatencyMS, time.Since(start).Milliseconds(),
	)
	json.NewEncoder(w).Encode(user)
}
```

### Dynamic Log Level via HTTP Endpoint

```go
// observability/loglevel.go
package observability

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// LevelVar allows runtime level changes.
var Level = new(slog.LevelVar)

// LevelHandler exposes GET/PUT /log-level for runtime adjustment.
func LevelHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			json.NewEncoder(w).Encode(map[string]string{
				"level": Level.Level().String(),
			})
		case http.MethodPut:
			var req struct {
				Level string `json:"level"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			var l slog.Level
			if err := l.UnmarshalText([]byte(req.Level)); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			Level.Set(l)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
```

---

## Section 2: Prometheus Metrics with Exemplars

Exemplars link a metric observation to a specific trace, enabling a workflow like: "this histogram bucket spiked — show me a trace from that bucket."

### Metric Definitions

```go
// observability/metrics.go
package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// HTTPRequestDuration tracks request latency with exemplar support.
	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "myapp",
			Subsystem: "http",
			Name:      "request_duration_seconds",
			Help:      "HTTP request duration in seconds.",
			Buckets:   []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		},
		[]string{"method", "path", "status_code"},
	)

	// HTTPRequestsTotal counts requests.
	HTTPRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "myapp",
			Subsystem: "http",
			Name:      "requests_total",
			Help:      "Total HTTP requests.",
		},
		[]string{"method", "path", "status_code"},
	)

	// DBQueryDuration tracks database latency.
	DBQueryDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "myapp",
			Subsystem: "db",
			Name:      "query_duration_seconds",
			Help:      "Database query duration in seconds.",
			Buckets:   []float64{.0005, .001, .005, .01, .025, .05, .1, .25, .5},
		},
		[]string{"operation", "status"},
	)

	// BusinessEventsTotal tracks domain events.
	BusinessEventsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "myapp",
			Name:      "business_events_total",
			Help:      "Total business events processed.",
		},
		[]string{"event_type", "outcome"},
	)
)
```

### Metrics Middleware with Exemplars

```go
// middleware/metrics.go
package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/trace"
	"myapp/observability"
)

// Metrics wraps handlers with Prometheus instrumentation and trace exemplars.
func Metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()
		statusStr := strconv.Itoa(rw.statusCode)
		path := sanitizePath(r.URL.Path)

		// Build exemplar labels from the active trace.
		exemplarLabels := buildExemplarLabels(r)

		// Use native Prometheus exemplar API.
		if h, ok := observability.HTTPRequestDuration.
			WithLabelValues(r.Method, path, statusStr).(prometheus.ExemplarObserver); ok {
			h.ObserveWithExemplar(duration, exemplarLabels)
		} else {
			observability.HTTPRequestDuration.
				WithLabelValues(r.Method, path, statusStr).Observe(duration)
		}

		observability.HTTPRequestsTotal.
			WithLabelValues(r.Method, path, statusStr).Inc()
	})
}

// buildExemplarLabels extracts the trace and span IDs for the exemplar.
func buildExemplarLabels(r *http.Request) prometheus.Labels {
	span := trace.SpanFromContext(r.Context())
	if !span.SpanContext().IsValid() {
		return nil
	}
	return prometheus.Labels{
		"traceID": span.SpanContext().TraceID().String(),
		"spanID":  span.SpanContext().SpanID().String(),
	}
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// sanitizePath replaces path parameters with placeholders to avoid label cardinality explosion.
func sanitizePath(path string) string {
	// In practice, use the router's pattern (e.g., chi.RouteContext).
	return path
}
```

---

## Section 3: OpenTelemetry Trace Instrumentation

### SDK Initialization

```go
// observability/tracing.go
package observability

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

// TracingConfig holds all tracing configuration.
type TracingConfig struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string // e.g., "otel-collector:4317"
	SampleRate     float64
}

// InitTracing sets up the OpenTelemetry SDK and returns a shutdown function.
func InitTracing(ctx context.Context, cfg TracingConfig) (func(context.Context) error, error) {
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("create resource: %w", err)
	}

	conn, err := grpc.NewClient(cfg.OTLPEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("grpc dial: %w", err)
	}

	exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("create exporter: %w", err)
	}

	sampler := sdktrace.ParentBased(
		sdktrace.TraceIDRatioBased(cfg.SampleRate),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter,
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithBatchTimeout(5*time.Second),
		),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp.Shutdown, nil
}
```

### Trace Context in HTTP Middleware

```go
// middleware/tracing.go
package middleware

import (
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"myapp/observability"
)

var tracer = otel.Tracer("myapp/http")

// Tracing wraps handlers with OpenTelemetry span creation.
// It also injects trace IDs into the context logger.
func Tracing(serviceName string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		otelHandler := otelhttp.NewHandler(next, "",
			otelhttp.WithTracerProvider(otel.GetTracerProvider()),
			otelhttp.WithPropagators(otel.GetTextMapPropagator()),
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				return r.Method + " " + r.URL.Path
			}),
		)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			otelHandler.ServeHTTP(w, r)
		})
	}
}

// AddSpanAttributes enriches the current span with request-level attributes.
func AddSpanAttributes(r *http.Request, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(r.Context())
	span.SetAttributes(attrs...)
}
```

### Span Attributes for Service-Level Events

```go
// service/user_service.go
package service

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"myapp/store"
)

var tracer = otel.Tracer("myapp/service/user")

type UserService struct {
	store *store.Store
}

func (s *UserService) GetUser(ctx context.Context, id int64) (*User, error) {
	ctx, span := tracer.Start(ctx, "UserService.GetUser",
		trace.WithAttributes(
			attribute.Int64("user.id", id),
		),
	)
	defer span.End()

	user, err := s.store.GetUser(ctx, id)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, fmt.Sprintf("get user %d: %v", id, err))
		return nil, err
	}

	span.SetAttributes(
		attribute.String("user.email", user.Email),
		attribute.String("user.role", user.Role),
	)
	return user, nil
}
```

### Injecting Trace IDs into Log Lines

The three pillars are only useful together when a trace ID links them:

```go
// middleware/three_pillars.go
package middleware

import (
	"net/http"

	"go.opentelemetry.io/otel/trace"
	"myapp/observability"
)

// ThreePillars injects trace context into the request logger so every
// log line from this request carries trace_id and span_id fields.
func ThreePillars(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		span := trace.SpanFromContext(r.Context())
		sc := span.SpanContext()

		if sc.IsValid() {
			logger := observability.FromContext(r.Context()).With(
				"trace_id", sc.TraceID().String(),
				"span_id", sc.SpanID().String(),
			)
			r = r.WithContext(observability.WithLogger(r.Context(), logger))
		}

		next.ServeHTTP(w, r)
	})
}
```

---

## Section 4: Profiling with pprof in Production

`net/http/pprof` is safe to expose internally. Gating it behind an internal listener avoids accidental exposure:

```go
// server/debug.go
package server

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/* handlers
	"time"
)

// StartDebugServer starts a pprof server on the loopback interface only.
// It listens on localhost:6060 so it is never exposed externally.
func StartDebugServer(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.Handle("/debug/pprof/", http.DefaultServeMux)

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Second, // pprof profiles can take 30s
		IdleTimeout:  120 * time.Second,
	}

	ln, err := net.Listen("tcp", "127.0.0.1:6060")
	if err != nil {
		return err
	}

	go func() {
		slog.Info("debug server listening", "addr", ln.Addr())
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			slog.Error("debug server error", "err", err)
		}
	}()

	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()

	return nil
}
```

Collect profiles from a running pod:

```bash
# CPU profile — 30-second sample
kubectl port-forward pod/myapp-7f9d4b6c8-xk2pl 6060:6060
go tool pprof -http=:8088 http://localhost:6060/debug/pprof/profile?seconds=30

# Heap profile
go tool pprof -http=:8088 http://localhost:6060/debug/pprof/heap

# Goroutine trace — identify blocking goroutines
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 | head -80

# Mutex contention profile
curl -s http://localhost:6060/debug/pprof/mutex
```

### Continuous Profiling with Pyroscope

```go
// observability/profiling.go
package observability

import (
	"fmt"
	"runtime"

	"github.com/grafana/pyroscope-go"
)

// StartContinuousProfiling connects to Pyroscope for always-on profiling.
func StartContinuousProfiling(serverURL, appName, env string) (*pyroscope.Profiler, error) {
	runtime.SetMutexProfileFraction(5)
	runtime.SetBlockProfileRate(5)

	p, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: fmt.Sprintf("%s.%s", appName, env),
		ServerAddress:   serverURL,
		Logger:          pyroscope.StandardLogger,
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileInuseSpace,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileGoroutines,
			pyroscope.ProfileMutexCount,
			pyroscope.ProfileMutexDuration,
			pyroscope.ProfileBlockCount,
			pyroscope.ProfileBlockDuration,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("start pyroscope: %w", err)
	}
	return p, nil
}
```

---

## Section 5: Runtime Metrics Collection

Go's runtime exposes metrics via `runtime/metrics` (Go 1.16+). Scraping them with a custom collector provides insight into GC pressure, goroutine counts, and memory breakdown:

```go
// observability/runtime_metrics.go
package observability

import (
	"runtime/metrics"

	"github.com/prometheus/client_golang/prometheus"
)

// RuntimeCollector exports Go runtime metrics to Prometheus.
type RuntimeCollector struct {
	descs   []*prometheus.Desc
	samples []metrics.Sample
}

var runtimeMetricDefs = []struct {
	name  string
	help  string
	rname string
}{
	{
		"go_goroutines_total",
		"Number of goroutines that currently exist.",
		"/sched/goroutines:goroutines",
	},
	{
		"go_gc_pause_total_seconds",
		"Cumulative duration of GC stop-the-world pauses.",
		"/gc/pause/total:seconds",
	},
	{
		"go_memory_heap_alloc_bytes",
		"Bytes of allocated heap objects.",
		"/memory/classes/heap/objects:bytes",
	},
	{
		"go_memory_heap_idle_bytes",
		"Bytes in idle (but not released) spans.",
		"/memory/classes/heap/unused:bytes",
	},
}

// NewRuntimeCollector creates a collector for runtime metrics.
func NewRuntimeCollector() *RuntimeCollector {
	c := &RuntimeCollector{}
	for _, def := range runtimeMetricDefs {
		c.descs = append(c.descs, prometheus.NewDesc(def.name, def.help, nil, nil))
		c.samples = append(c.samples, metrics.Sample{Name: def.rname})
	}
	return c
}

func (c *RuntimeCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range c.descs {
		ch <- d
	}
}

func (c *RuntimeCollector) Collect(ch chan<- prometheus.Metric) {
	metrics.Read(c.samples)
	for i, s := range c.samples {
		var val float64
		switch v := s.Value; v.Kind() {
		case metrics.KindUint64:
			val = float64(v.Uint64())
		case metrics.KindFloat64:
			val = v.Float64()
		default:
			continue
		}
		ch <- prometheus.MustNewConstMetric(c.descs[i], prometheus.GaugeValue, val)
	}
}
```

Register with Prometheus:

```go
prometheus.MustRegister(observability.NewRuntimeCollector())
```

---

## Section 6: The Observer Effect — Performance Cost of Instrumentation

Every observability instrument has a cost. Measure and budget:

### Benchmark Results for Common Patterns

```go
// observability/bench_test.go
package observability_test

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel"
)

var (
	testCounter = prometheus.NewCounter(prometheus.CounterOpts{Name: "bench_test_total"})
	testHist    = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "bench_test_duration_seconds",
		Buckets: prometheus.DefBuckets,
	})
	testTracer = otel.Tracer("bench")
)

func BenchmarkCounterInc(b *testing.B) {
	for i := 0; i < b.N; i++ {
		testCounter.Inc()
	}
}
// BenchmarkCounterInc-8   ~60 ns/op

func BenchmarkHistogramObserve(b *testing.B) {
	for i := 0; i < b.N; i++ {
		testHist.Observe(0.001)
	}
}
// BenchmarkHistogramObserve-8   ~200 ns/op

func BenchmarkSpanStartEnd(b *testing.B) {
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, span := testTracer.Start(ctx, "bench")
		span.End()
	}
}
// BenchmarkSpanStartEnd-8   ~500 ns/op with OTLP exporter

func BenchmarkSlogInfoJSON(b *testing.B) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		logger.Info("benchmark", "key", "value", "n", i)
	}
}
// BenchmarkSlogInfoJSON-8   ~300 ns/op
```

### Sampling Strategy

Not every request needs a trace. Use head-based sampling for low-traffic services and tail-based sampling for high-traffic:

```go
// observability/sampler.go
package observability

import (
	"go.opentelemetry.io/otel/sdk/trace"
)

// AdaptiveSampler returns a sampler that:
// - Always samples errors (status error spans).
// - Samples a fraction of successful requests.
func AdaptiveSampler(fraction float64) trace.Sampler {
	return trace.ParentBased(
		trace.TraceIDRatioBased(fraction),
	)
}

// HighValueSampler always samples requests that match certain criteria.
// Add this as a custom sampler wrapping the ratio sampler.
type HighValueSampler struct {
	base trace.Sampler
}

func (s HighValueSampler) ShouldSample(p trace.SamplingParameters) trace.SamplingResult {
	// Always trace slow operations (indicated by a baggage item).
	for _, attr := range p.Attributes {
		if attr.Key == "force_trace" {
			return trace.SamplingResult{Decision: trace.RecordAndSample}
		}
	}
	return s.base.ShouldSample(p)
}

func (s HighValueSampler) Description() string { return "HighValueSampler" }
```

---

## Section 7: Alerting Rules from Metrics

Metrics are only useful if alerts fire before users report problems. Standard alerting rules for a Go HTTP service:

```yaml
# prometheus/alerts/go-service.yaml
groups:
  - name: go-service
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(myapp_http_requests_total{status_code=~"5.."}[5m]))
          /
          sum(rate(myapp_http_requests_total[5m])) > 0.01
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Error rate above 1% for 2 minutes"
          runbook: "https://wiki.example.com/runbooks/high-error-rate"

      - alert: HighLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum(rate(myapp_http_request_duration_seconds_bucket[5m])) by (le, path)
          ) > 1.0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P99 latency above 1s on {{ $labels.path }}"

      - alert: GoroutineLeak
        expr: go_goroutines_total > 10000
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Goroutine count {{ $value }} suggests leak"

      - alert: HighGCPressure
        expr: |
          rate(go_gc_pause_total_seconds[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GC consuming >10% of time"

      - alert: DBPoolExhausted
        expr: |
          db_pool_total_conns / db_pool_max_conns > 0.9
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool near exhaustion"
```

---

## Section 8: Complete Middleware Stack

Assembling all middleware in the correct order:

```go
// server/server.go
package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"myapp/middleware"
	"myapp/observability"
)

func NewRouter(svc *service.Services) http.Handler {
	r := chi.NewRouter()

	// Order matters: tracing must precede logging so trace IDs are available.
	r.Use(chimiddleware.RealIP)
	r.Use(middleware.CorrelationID)
	r.Use(middleware.Tracing("myapp"))      // starts OTEL span
	r.Use(middleware.ThreePillars)          // injects trace IDs into logger
	r.Use(middleware.Metrics)              // records Prometheus metrics with exemplars
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Compress(5))

	r.Get("/health/live",  healthLive)
	r.Get("/health/ready", healthReady(svc))
	r.Get("/log-level",    observability.LevelHandler().ServeHTTP)
	r.Put("/log-level",    observability.LevelHandler().ServeHTTP)

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(middleware.Auth)
		r.Mount("/users", userRouter(svc.Users))
	})

	return r
}
```

This stack ensures every request produces a correlated log line, a metric observation with exemplar, and an OTEL span — with a single correlation ID linking all three for any given request.
