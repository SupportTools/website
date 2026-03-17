---
title: "Go Observability SDK: Building Custom Instrumentation Libraries for Internal Services"
date: 2030-11-12T00:00:00-05:00
draft: false
tags: ["Go", "OpenTelemetry", "Observability", "Tracing", "Metrics", "gRPC", "HTTP", "Platform Engineering"]
categories:
- Go
- Observability
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise observability library design in Go: wrapping OTel SDK for consistent instrumentation, automatic span creation for HTTP and gRPC, custom resource detectors, metric conventions, trace context propagation, and building opinionated instrumentation for platform teams."
more_link: "yes"
url: "/go-observability-sdk-custom-instrumentation-otel-enterprise-guide/"
---

Platform teams at scale consistently face the same challenge: dozens of microservice teams each wiring up OpenTelemetry differently, producing inconsistent span names, missing resource attributes, and reinventing context propagation middleware. The solution is a thin internal observability SDK that wraps the OTel Go SDK with opinionated defaults, enforced naming conventions, and pre-wired middleware — so application teams call two functions to get complete traces, metrics, and logs flowing to the platform's collector infrastructure.

<!--more-->

## Why Build an Internal Observability SDK

The OpenTelemetry Go SDK is powerful but deliberately low-level. A service team that reads the OTel documentation will produce a working instrumentation, but it will differ from every other team's implementation in attribute names, sampler configuration, exporter setup, and resource detection. An internal SDK solves this by encoding platform conventions once:

- Consistent resource attributes: `service.name`, `service.version`, `deployment.environment`, and custom attributes like `team.name` and `cost.center`.
- Enforced span naming conventions: `<http-method> <route-template>` for HTTP, `<package>.<Service>/<Method>` for gRPC.
- Pre-configured W3C TraceContext and Baggage propagation.
- A standard metric naming convention: `<service>.<domain>.<metric_name>`.
- Automatic correlation between spans and structured log fields.

The result is that `go get internal.company.com/obs` and a three-line initialization block gives a service team everything they need.

## Repository and Module Structure

```
obs/
├── go.mod
├── go.sum
├── provider.go           # TracerProvider, MeterProvider initialization
├── resource.go           # Resource detector aggregation
├── propagation.go        # Propagator setup (W3C TC + Baggage)
├── http/
│   ├── middleware.go     # net/http server middleware
│   ├── transport.go      # http.RoundTripper for outbound requests
│   └── attrs.go          # Shared HTTP attribute helpers
├── grpc/
│   ├── server.go         # gRPC server interceptors
│   ├── client.go         # gRPC client interceptors
│   └── attrs.go
├── log/
│   ├── logger.go         # slog integration with trace correlation
│   └── otellog.go        # OTel log bridge
├── metrics/
│   ├── conventions.go    # Metric naming helpers
│   └── histograms.go     # Pre-built histogram instruments
├── detector/
│   ├── kubernetes.go     # Kubernetes resource detector
│   └── build.go          # Build-time version injector
└── example/
    └── main.go
```

## Core Provider Initialization

The `provider.go` file is the entry point that application teams call. It initializes both a `TracerProvider` and a `MeterProvider`, configures the OTLP exporter to the platform's collector endpoint, and registers shutdown hooks.

```go
// provider.go
package obs

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds the configuration for the observability SDK.
type Config struct {
	// ServiceName is required. It becomes the service.name resource attribute.
	ServiceName string
	// ServiceVersion defaults to the BUILD_VERSION environment variable.
	ServiceVersion string
	// Environment defaults to the DEPLOYMENT_ENV environment variable (prod/stg/dev).
	Environment string
	// CollectorEndpoint is the OTLP gRPC endpoint. Defaults to localhost:4317.
	CollectorEndpoint string
	// SamplerRatio controls the head-based sampling ratio (0.0–1.0). Defaults to 1.0.
	SamplerRatio float64
	// TeamName is added to every span as the custom 'team.name' attribute.
	TeamName string
	// AdditionalResource allows callers to add extra resource attributes.
	AdditionalResource *resource.Resource
}

func (c *Config) applyDefaults() {
	if c.ServiceVersion == "" {
		c.ServiceVersion = envOrDefault("BUILD_VERSION", "unknown")
	}
	if c.Environment == "" {
		c.Environment = envOrDefault("DEPLOYMENT_ENV", "development")
	}
	if c.CollectorEndpoint == "" {
		c.CollectorEndpoint = envOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")
	}
	if c.SamplerRatio == 0 {
		c.SamplerRatio = 1.0
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// SDK is the initialized observability SDK. Call Shutdown on process exit.
type SDK struct {
	TracerProvider *sdktrace.TracerProvider
	MeterProvider  *sdkmetric.MeterProvider
	shutdown       []func(context.Context) error
}

// Shutdown flushes all telemetry and releases resources. Call this in main()
// via defer or a signal handler.
func (s *SDK) Shutdown(ctx context.Context) error {
	var errs []error
	for _, fn := range s.shutdown {
		if err := fn(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("obs shutdown errors: %v", errs)
	}
	return nil
}

// Init initializes the observability SDK and registers it as the global
// TracerProvider and MeterProvider. Returns a *SDK whose Shutdown method
// must be called on process exit.
func Init(ctx context.Context, cfg Config) (*SDK, error) {
	cfg.applyDefaults()

	if cfg.ServiceName == "" {
		return nil, fmt.Errorf("obs.Init: ServiceName is required")
	}

	// Build the resource describing this service instance.
	res, err := buildResource(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("obs.Init: resource build: %w", err)
	}

	// Establish a shared gRPC connection to the collector.
	conn, err := grpc.NewClient(
		cfg.CollectorEndpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("obs.Init: grpc dial %s: %w", cfg.CollectorEndpoint, err)
	}

	sdk := &SDK{}

	// ------------------------------------------------------------------
	// Trace provider
	// ------------------------------------------------------------------
	traceExporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("obs.Init: trace exporter: %w", err)
	}

	sampler := sdktrace.ParentBased(
		sdktrace.TraceIDRatioBased(cfg.SamplerRatio),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter,
			sdktrace.WithBatchTimeout(5*time.Second),
			sdktrace.WithMaxExportBatchSize(512),
		),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)
	sdk.TracerProvider = tp
	sdk.shutdown = append(sdk.shutdown, tp.Shutdown)

	// ------------------------------------------------------------------
	// Metric provider
	// ------------------------------------------------------------------
	metricExporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("obs.Init: metric exporter: %w", err)
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(
			sdkmetric.NewPeriodicReader(metricExporter,
				sdkmetric.WithInterval(30*time.Second),
			),
		),
		sdkmetric.WithResource(res),
	)
	sdk.MeterProvider = mp
	sdk.shutdown = append(sdk.shutdown, mp.Shutdown)

	// Register as globals so libraries using otel.GetTracerProvider() work.
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	setupPropagator()

	return sdk, nil
}
```

## Resource Detection

The resource describes the environment where the service is running. The platform SDK aggregates multiple detectors to produce a rich resource automatically:

```go
// resource.go
package obs

import (
	"context"

	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/contrib/detectors/aws/eks"
	k8sdetector "go.opentelemetry.io/contrib/detectors/aws/eks"
)

func buildResource(ctx context.Context, cfg Config) (*resource.Resource, error) {
	// Base resource with service identity
	base, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
	)
	if err != nil {
		return nil, err
	}

	// Platform resource detectors
	detectors := []resource.Option{
		resource.WithFromEnv(),       // OTEL_RESOURCE_ATTRIBUTES env var
		resource.WithHost(),          // hostname
		resource.WithProcess(),       // PID, executable name
		resource.WithTelemetrySDK(),  // otel SDK name/version/language
	}

	detected, err := resource.New(ctx, detectors...)
	if err != nil {
		// Resource detection failures are non-fatal; log and continue.
		detected = resource.Empty()
	}

	// Kubernetes-specific attributes injected via the Downward API
	k8sRes, _ := buildK8sResource(ctx)

	// Team/cost-center attributes from config
	teamRes, _ := resource.New(ctx,
		resource.WithAttributes(
			attribute.String("team.name", cfg.TeamName),
		),
	)

	// Merge all resources; later resources take precedence for duplicate keys.
	merged, err := resource.Merge(
		resource.Default(),
		base,
	)
	if err != nil {
		return nil, err
	}
	for _, r := range []*resource.Resource{detected, k8sRes, teamRes, cfg.AdditionalResource} {
		if r == nil {
			continue
		}
		merged, err = resource.Merge(merged, r)
		if err != nil {
			return nil, err
		}
	}

	return merged, nil
}
```

```go
// detector/kubernetes.go
package detector

import (
	"context"
	"os"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// K8sResource builds a resource from Kubernetes Downward API environment variables.
// Configure the Pod spec to inject these:
//   env:
//     - name: K8S_NAMESPACE
//       valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
//     - name: K8S_POD_NAME
//       valueFrom: { fieldRef: { fieldPath: metadata.name } }
//     - name: K8S_NODE_NAME
//       valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
func K8sResource(ctx context.Context) (*resource.Resource, error) {
	attrs := []attribute.KeyValue{}

	if ns := os.Getenv("K8S_NAMESPACE"); ns != "" {
		attrs = append(attrs, semconv.K8SNamespaceName(ns))
	}
	if pod := os.Getenv("K8S_POD_NAME"); pod != "" {
		attrs = append(attrs, semconv.K8SPodName(pod))
	}
	if node := os.Getenv("K8S_NODE_NAME"); node != "" {
		attrs = append(attrs, semconv.K8SNodeName(node))
	}
	if container := os.Getenv("K8S_CONTAINER_NAME"); container != "" {
		attrs = append(attrs, semconv.K8SContainerName(container))
	}

	if len(attrs) == 0 {
		return resource.Empty(), nil
	}

	return resource.NewWithAttributes(semconv.SchemaURL, attrs...), nil
}
```

Kubernetes Pod spec for Downward API injection:

```yaml
spec:
  containers:
    - name: api-server
      env:
        - name: K8S_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: K8S_POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: K8S_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: K8S_CONTAINER_NAME
          value: "api-server"
        - name: DEPLOYMENT_ENV
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: environment
        - name: BUILD_VERSION
          value: "1.14.3"
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "otel-collector.monitoring.svc.cluster.local:4317"
```

## HTTP Server Middleware

The HTTP middleware wraps `net/http` handlers and creates a span for every inbound request. It follows OTel HTTP semantic conventions strictly:

```go
// http/middleware.go
package obshttp

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

const tracerName = "internal.company.com/obs/http"

// Middleware returns an http.Handler that wraps h with automatic span creation,
// trace context extraction, and request/response metric recording.
//
// The route parameter should be the parameterized route template, e.g.
// "/users/{id}" not "/users/42". Pass an empty string to use the raw URL path
// (not recommended for high-cardinality paths).
func Middleware(route string, h http.Handler) http.Handler {
	tracer := otel.GetTracerProvider().Tracer(tracerName)
	propagator := otel.GetTextMapPropagator()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract trace context from incoming headers (W3C TraceContext, Baggage).
		ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

		spanName := spanName(r.Method, route)

		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(serverAttrs(r, route)...),
		)
		defer span.End()

		// Wrap the ResponseWriter to capture status code.
		rw := newResponseWriter(w)
		start := time.Now()

		// Inject the updated context into the request.
		h.ServeHTTP(rw, r.WithContext(ctx))

		duration := time.Since(start)

		// Record response attributes.
		span.SetAttributes(
			semconv.HTTPResponseStatusCode(rw.statusCode),
			attribute.Int64("http.response.body.size", rw.written),
		)

		// Set span status based on HTTP status code.
		if rw.statusCode >= 500 {
			span.SetStatus(codes.Error, http.StatusText(rw.statusCode))
		} else if rw.statusCode >= 400 {
			// 4xx is not a span error by OTel conventions — it is a valid response.
			span.SetStatus(codes.Unset, "")
		}

		// Record duration metric.
		recordHTTPServerMetrics(ctx, r.Method, route, rw.statusCode, duration)
	})
}

func spanName(method, route string) string {
	if route == "" {
		return method
	}
	return fmt.Sprintf("%s %s", method, route)
}

func serverAttrs(r *http.Request, route string) []attribute.KeyValue {
	attrs := []attribute.KeyValue{
		semconv.HTTPRequestMethodKey.String(r.Method),
		semconv.URLScheme(scheme(r)),
		semconv.NetworkProtocolVersion(r.Proto),
		attribute.String("server.address", r.Host),
	}
	if route != "" {
		attrs = append(attrs, semconv.HTTPRouteKey.String(route))
	}
	if ua := r.UserAgent(); ua != "" {
		attrs = append(attrs, semconv.UserAgentOriginal(ua))
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		attrs = append(attrs, attribute.String("client.address", strings.Split(fwd, ",")[0]))
	}
	return attrs
}

func scheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}
	return "http"
}

// responseWriter wraps http.ResponseWriter to capture status code and bytes written.
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	written    int64
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
	return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(statusCode int) {
	rw.statusCode = statusCode
	rw.ResponseWriter.WriteHeader(statusCode)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.written += int64(n)
	return n, err
}
```

### Outbound HTTP Transport

```go
// http/transport.go
package obshttp

import (
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

const clientTracerName = "internal.company.com/obs/http/client"

// Transport wraps an http.RoundTripper to inject trace context into outbound
// requests and record client span metrics.
type Transport struct {
	wrapped    http.RoundTripper
	tracer     trace.Tracer
	propagator propagation.TextMapPropagator
}

// NewTransport returns an instrumented http.RoundTripper.
func NewTransport(base http.RoundTripper) *Transport {
	if base == nil {
		base = http.DefaultTransport
	}
	return &Transport{
		wrapped:    base,
		tracer:     otel.GetTracerProvider().Tracer(clientTracerName),
		propagator: otel.GetTextMapPropagator(),
	}
}

func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	spanName := fmt.Sprintf("%s %s", req.Method, req.URL.Host)

	ctx, span := t.tracer.Start(req.Context(), spanName,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.HTTPRequestMethodKey.String(req.Method),
			semconv.ServerAddress(req.URL.Host),
			semconv.URLFull(req.URL.String()),
		),
	)
	defer span.End()

	// Inject trace context into outbound headers.
	reqCopy := req.Clone(ctx)
	t.propagator.Inject(ctx, propagation.HeaderCarrier(reqCopy.Header))

	start := time.Now()
	resp, err := t.wrapped.RoundTrip(reqCopy)
	duration := time.Since(start)

	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		span.RecordError(err)
		return nil, err
	}

	span.SetAttributes(
		semconv.HTTPResponseStatusCode(resp.StatusCode),
	)
	if resp.StatusCode >= 500 {
		span.SetStatus(codes.Error, http.StatusText(resp.StatusCode))
	}

	recordHTTPClientMetrics(ctx, req.Method, req.URL.Host, resp.StatusCode, duration)
	return resp, nil
}

// NewClient returns an *http.Client with the instrumented transport.
func NewClient() *http.Client {
	return &http.Client{
		Transport: NewTransport(nil),
		Timeout:   30 * time.Second,
	}
}
```

## gRPC Interceptors

```go
// grpc/server.go
package obsgrpc

import (
	"context"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const grpcTracerName = "internal.company.com/obs/grpc"

// metadataCarrier adapts gRPC metadata to OTel's TextMapCarrier interface.
type metadataCarrier struct{ md metadata.MD }

func (mc metadataCarrier) Get(key string) string {
	vals := mc.md.Get(strings.ToLower(key))
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

func (mc metadataCarrier) Set(key, val string) {
	mc.md.Set(strings.ToLower(key), val)
}

func (mc metadataCarrier) Keys() []string {
	keys := make([]string, 0, len(mc.md))
	for k := range mc.md {
		keys = append(keys, k)
	}
	return keys
}

// UnaryServerInterceptor returns a gRPC unary server interceptor that creates
// a span for each RPC call with the full method name as the span name.
func UnaryServerInterceptor() grpc.UnaryServerInterceptor {
	tracer := otel.GetTracerProvider().Tracer(grpcTracerName)
	propagator := otel.GetTextMapPropagator()

	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			md = metadata.MD{}
		}

		// Extract trace context from incoming gRPC metadata.
		ctx = propagator.Extract(ctx, metadataCarrier{md: md})

		spanName := grpcSpanName(info.FullMethod)

		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(grpcServerAttrs(info.FullMethod)...),
		)
		defer span.End()

		resp, err := handler(ctx, req)

		if err != nil {
			s, _ := status.FromError(err)
			span.SetAttributes(
				attribute.String("rpc.grpc.status_code", s.Code().String()),
			)
			if s.Code() != grpccodes.OK {
				span.SetStatus(codes.Error, s.Message())
				span.RecordError(err)
			}
		} else {
			span.SetAttributes(
				attribute.String("rpc.grpc.status_code", grpccodes.OK.String()),
			)
		}

		return resp, err
	}
}

// StreamServerInterceptor returns a gRPC streaming server interceptor.
func StreamServerInterceptor() grpc.StreamServerInterceptor {
	tracer := otel.GetTracerProvider().Tracer(grpcTracerName)
	propagator := otel.GetTextMapPropagator()

	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		ctx := ss.Context()
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			md = metadata.MD{}
		}
		ctx = propagator.Extract(ctx, metadataCarrier{md: md})

		spanName := grpcSpanName(info.FullMethod)
		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(grpcServerAttrs(info.FullMethod)...),
		)
		defer span.End()

		err := handler(srv, &wrappedStream{ServerStream: ss, ctx: ctx})
		if err != nil {
			s, _ := status.FromError(err)
			span.SetStatus(codes.Error, s.Message())
			span.RecordError(err)
		}
		return err
	}
}

func grpcSpanName(fullMethod string) string {
	// fullMethod is "/package.Service/Method" — strip the leading slash.
	return strings.TrimPrefix(fullMethod, "/")
}

func grpcServerAttrs(fullMethod string) []attribute.KeyValue {
	parts := strings.SplitN(strings.TrimPrefix(fullMethod, "/"), "/", 2)
	attrs := []attribute.KeyValue{
		semconv.RPCSystemKey.String("grpc"),
	}
	if len(parts) == 2 {
		svcParts := strings.SplitN(parts[0], ".", 2)
		if len(svcParts) == 2 {
			attrs = append(attrs,
				semconv.RPCServiceKey.String(svcParts[1]),
				attribute.String("rpc.grpc.package", svcParts[0]),
			)
		} else {
			attrs = append(attrs, semconv.RPCServiceKey.String(parts[0]))
		}
		attrs = append(attrs, semconv.RPCMethodKey.String(parts[1]))
	}
	return attrs
}

type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (ws *wrappedStream) Context() context.Context {
	return ws.ctx
}
```

## Structured Logging with Trace Correlation

The log package bridges `log/slog` to OTel trace context, injecting `trace_id` and `span_id` into every log record:

```go
// log/logger.go
package obslog

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel/trace"
)

// New returns an *slog.Logger that automatically adds trace_id and span_id
// to every log record when a valid span is present in the context.
func New(level slog.Level) *slog.Logger {
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
	})
	return slog.New(&traceHandler{Handler: handler})
}

type traceHandler struct {
	slog.Handler
}

func (h *traceHandler) Handle(ctx context.Context, record slog.Record) error {
	if span := trace.SpanFromContext(ctx); span.SpanContext().IsValid() {
		sc := span.SpanContext()
		record.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
			slog.Bool("trace_sampled", sc.IsSampled()),
		)
	}
	return h.Handler.Handle(ctx, record)
}

func (h *traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &traceHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *traceHandler) WithGroup(name string) slog.Handler {
	return &traceHandler{Handler: h.Handler.WithGroup(name)}
}
```

## Metric Conventions and Histogram Buckets

Pre-defined histograms enforce consistent bucket boundaries across services:

```go
// metrics/histograms.go
package obsmetrics

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const meterName = "internal.company.com/obs/metrics"

// StandardHTTPDurationBuckets are the recommended latency histogram bucket
// boundaries for HTTP server and client spans, in seconds.
var StandardHTTPDurationBuckets = []float64{
	0.005, 0.01, 0.025, 0.05, 0.075,
	0.1, 0.25, 0.5, 0.75, 1.0,
	2.5, 5.0, 7.5, 10.0,
}

// StandardDBDurationBuckets for database query latency.
var StandardDBDurationBuckets = []float64{
	0.001, 0.005, 0.01, 0.025, 0.05,
	0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
}

// NewHTTPServerDurationHistogram creates a histogram for HTTP server request duration.
// Name follows the OTel HTTP semantic convention: http.server.request.duration.
func NewHTTPServerDurationHistogram() (metric.Float64Histogram, error) {
	meter := otel.GetMeterProvider().Meter(meterName)
	return meter.Float64Histogram(
		"http.server.request.duration",
		metric.WithDescription("Duration of HTTP server requests in seconds"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(StandardHTTPDurationBuckets...),
	)
}

// NewHTTPClientDurationHistogram creates a histogram for outbound HTTP client latency.
func NewHTTPClientDurationHistogram() (metric.Float64Histogram, error) {
	meter := otel.GetMeterProvider().Meter(meterName)
	return meter.Float64Histogram(
		"http.client.request.duration",
		metric.WithDescription("Duration of outbound HTTP client requests in seconds"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(StandardHTTPDurationBuckets...),
	)
}

// NewGRPCServerDurationHistogram follows the OTel RPC semantic convention.
func NewGRPCServerDurationHistogram() (metric.Float64Histogram, error) {
	meter := otel.GetMeterProvider().Meter(meterName)
	return meter.Float64Histogram(
		"rpc.server.duration",
		metric.WithDescription("Duration of gRPC server calls in milliseconds"),
		metric.WithUnit("ms"),
		metric.WithExplicitBucketBoundaries(0.5, 1, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000),
	)
}
```

## Propagation Setup

```go
// propagation.go
package obs

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// setupPropagator registers the W3C TraceContext and W3C Baggage propagators
// as the global composite propagator.
func setupPropagator() {
	otel.SetTextMapPropagator(
		propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		),
	)
}
```

## Application Integration Example

With the SDK in place, application teams use a minimal initialization block:

```go
// example/main.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"internal.company.com/obs"
	obshttp "internal.company.com/obs/http"
	obslog "internal.company.com/obs/log"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// --- Three lines to get full observability ---
	sdk, err := obs.Init(ctx, obs.Config{
		ServiceName: "order-service",
		TeamName:    "payments",
	})
	if err != nil {
		log.Fatalf("obs.Init: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			log.Printf("obs shutdown: %v", err)
		}
	}()
	// --- End of observability setup ---

	logger := obslog.New(obslog.LevelInfo)
	tracer := obs.Tracer("order-service")

	mux := http.NewServeMux()

	// Wrap each handler with the route template.
	mux.Handle("GET /orders/{id}", obshttp.Middleware("GET /orders/{id}",
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			// Child span for the database lookup.
			ctx, dbSpan := tracer.Start(ctx, "db.orders.findByID",
				trace.WithAttributes(
					attribute.String("db.system", "postgresql"),
					attribute.String("db.name", "orders"),
					attribute.String("db.operation", "SELECT"),
				),
			)
			defer dbSpan.End()

			logger.InfoContext(ctx, "fetching order",
				"order_id", r.PathValue("id"),
			)

			// ... actual handler logic ...
			w.WriteHeader(http.StatusOK)
		}),
	))

	srv := &http.Server{Addr: ":8080", Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	srv.Shutdown(context.Background())
}
```

## Testing the SDK

Unit tests for instrumentation verify that spans are created with the correct attributes:

```go
// http/middleware_test.go
package obshttp_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	obshttp "internal.company.com/obs/http"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMiddlewareCreatesSpan(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := trace.NewTracerProvider(trace.WithSyncer(exporter))

	// Use in-memory exporter for test assertions
	handler := obshttp.MiddlewareWithProvider("/users/{id}",
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
		tp,
	)

	req := httptest.NewRequest(http.MethodGet, "/users/42", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	spans := exporter.GetSpans()
	require.Len(t, spans, 1)

	span := spans[0]
	assert.Equal(t, "GET /users/{id}", span.Name())
	assert.Equal(t, "GET", attrValue(span, "http.request.method"))
	assert.Equal(t, "/users/{id}", attrValue(span, "http.route"))
	assert.Equal(t, int64(200), attrInt(span, "http.response.status_code"))
}

func attrValue(span tracetest.SpanStub, key string) string {
	for _, a := range span.Attributes {
		if string(a.Key) == key {
			return a.Value.AsString()
		}
	}
	return ""
}

func attrInt(span tracetest.SpanStub, key string) int64 {
	for _, a := range span.Attributes {
		if string(a.Key) == key {
			return a.Value.AsInt64()
		}
	}
	return -1
}
```

## Deployment: OTel Collector Configuration

The platform OTel Collector receives telemetry from all services and routes it to the appropriate backends:

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
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 1000
    spike_limit_mib: 200
  # Add environment-level attributes not set by services
  resource:
    attributes:
      - key: platform.region
        value: "us-east-1"
        action: insert
  # Redact sensitive values from span attributes
  attributes:
    actions:
      - key: "http.request.header.authorization"
        action: delete
      - key: "http.request.header.cookie"
        action: delete

exporters:
  otlp/tempo:
    endpoint: "tempo.monitoring.svc.cluster.local:4317"
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
  loki:
    endpoint: "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource, attributes, batch]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [loki]
```

## Summary

An internal observability SDK built on the OTel Go SDK delivers three outcomes: application teams spend minutes rather than days on instrumentation, all services produce consistent telemetry that works with shared dashboards and alerts, and the platform team can evolve sampling strategies and exporter configurations centrally without touching application code. The key design decisions are opinionated defaults with escape hatches for advanced use cases, strict adherence to OTel semantic conventions for attribute naming, and comprehensive testing with the in-memory exporter so instrumentation correctness is verified in CI.
