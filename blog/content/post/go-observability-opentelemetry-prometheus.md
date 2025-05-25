---
title: "Complete Guide to Observability in Go: Logging, Metrics, and Tracing with OpenTelemetry and Prometheus"
date: 2026-07-02T09:00:00-05:00
draft: false
tags: ["go", "golang", "observability", "opentelemetry", "prometheus", "logging", "monitoring", "tracing"]
categories: ["Programming", "Go", "DevOps"]
---

Modern applications, especially those built using microservices architecture, can be challenging to debug and monitor. Observability—the ability to understand a system's internal state by examining its outputs—has become essential for maintaining reliable services. For Go applications, implementing comprehensive observability involves three pillars: logging, metrics, and distributed tracing.

This guide provides a practical approach to implementing observability in Go applications using industry-standard tools: structured logging with Zap, metrics with Prometheus, and distributed tracing with OpenTelemetry.

## Understanding Observability

Observability consists of three primary components:

1. **Logging**: Discrete events that provide context about what's happening in your application
2. **Metrics**: Numerical data captured at regular intervals to monitor system health and performance
3. **Tracing**: Tracking the flow of requests through distributed systems

Each component serves a distinct purpose, and together they offer a complete view of your application's behavior.

## Structured Logging with Zap

While Go's standard library includes a basic logging package, structured logging libraries like [Zap](https://github.com/uber-go/zap) provide superior performance and flexibility.

### Setting Up Zap Logger

First, install Zap:

```bash
go get -u go.uber.org/zap
```

Next, create a logger configuration:

```go
package logger

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

var log *zap.Logger

// Initialize sets up the global logger
func Initialize(environment string) {
    var config zap.Config

    if environment == "production" {
        config = zap.NewProductionConfig()
        config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    } else {
        config = zap.NewDevelopmentConfig()
        config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
    }

    var err error
    log, err = config.Build()
    if err != nil {
        panic(err)
    }
}

// Get returns the global logger
func Get() *zap.Logger {
    return log
}

// Sync flushes any buffered log entries
func Sync() error {
    return log.Sync()
}
```

### Using the Logger

Now you can use the logger throughout your application:

```go
package main

import (
    "yourpackage/logger"
    "go.uber.org/zap"
)

func main() {
    // Initialize the logger
    logger.Initialize("development")
    defer logger.Sync()
    
    log := logger.Get()
    
    // Structured logging with context
    log.Info("Server starting",
        zap.String("env", "development"),
        zap.Int("port", 8080),
        zap.String("version", "1.0.0"),
    )
    
    // Log with error context
    err := startServer()
    if err != nil {
        log.Error("Failed to start server",
            zap.Error(err),
            zap.String("server_type", "http"),
        )
    }
}
```

### Logging Best Practices

1. **Use Structured Logging**: Always include relevant fields for better search and analysis
2. **Appropriate Log Levels**: Use Debug for development information, Info for operational events, Warn for concerning situations, Error for failures, and Fatal for critical errors that require immediate attention
3. **Include Context**: Add request IDs, user IDs, and other relevant context to connect related log entries
4. **Avoid Sensitive Data**: Never log passwords, authentication tokens, or personal information
5. **Log Sparingly**: Excessive logging impacts performance and creates noise

## Metrics with Prometheus

Prometheus is a powerful monitoring system and time series database that integrates well with Go applications.

### Setting Up Prometheus

Install the Prometheus client:

```bash
go get github.com/prometheus/client_golang/prometheus
go get github.com/prometheus/client_golang/prometheus/promauto
go get github.com/prometheus/client_golang/prometheus/promhttp
```

Create a metrics package:

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // RequestCounter tracks HTTP requests
    RequestCounter = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )
    
    // RequestDuration tracks latency
    RequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path", "status"},
    )
    
    // ActiveRequests tracks concurrent requests
    ActiveRequests = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "http_requests_active",
            Help: "Number of active HTTP requests",
        },
    )
    
    // DatabaseOperations tracks database operation counts
    DatabaseOperations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "database_operations_total",
            Help: "Total number of database operations",
        },
        []string{"operation", "table", "status"},
    )
    
    // DatabaseDuration tracks database operation latency
    DatabaseDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "database_operation_duration_seconds",
            Help:    "Database operation duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"operation", "table"},
    )
)
```

### Exposing Metrics Endpoint

In your HTTP server setup, add the Prometheus metrics endpoint:

```go
package main

import (
    "net/http"
    "time"
    
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "yourpackage/logger"
    "yourpackage/metrics"
)

func main() {
    logger.Initialize("development")
    defer logger.Sync()
    log := logger.Get()
    
    // Expose metrics endpoint
    http.Handle("/metrics", promhttp.Handler())
    
    // Register your application routes
    http.HandleFunc("/api/users", instrumentHandler(handleUsers))
    
    log.Info("Starting server on :8080")
    if err := http.ListenAndServe(":8080", nil); err != nil {
        log.Error("Server failed", err)
    }
}

// instrumentHandler wraps HTTP handlers with metrics tracking
func instrumentHandler(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        metrics.ActiveRequests.Inc()
        
        // Custom response writer to capture status code
        sw := statusWriter{ResponseWriter: w, status: http.StatusOK}
        
        // Call the actual handler
        next(&sw, r)
        
        // Record metrics
        duration := time.Since(start).Seconds()
        metrics.RequestDuration.WithLabelValues(r.Method, r.URL.Path, sw.StatusString()).Observe(duration)
        metrics.RequestCounter.WithLabelValues(r.Method, r.URL.Path, sw.StatusString()).Inc()
        metrics.ActiveRequests.Dec()
    }
}

// statusWriter wraps http.ResponseWriter to capture status codes
type statusWriter struct {
    http.ResponseWriter
    status int
}

func (w *statusWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
    if w.status == 0 {
        w.status = http.StatusOK
    }
    return w.ResponseWriter.Write(b)
}

func (w *statusWriter) StatusString() string {
    return http.StatusText(w.status)
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
    // Handler implementation
}
```

### Instrumenting Database Operations

For database operations, wrap your repository methods with metrics:

```go
func (r *UserRepository) GetUser(id string) (*User, error) {
    start := time.Now()
    tableLabel := "users"
    operationLabel := "get"
    
    user, err := r.findByID(id)
    
    duration := time.Since(start).Seconds()
    metrics.DatabaseDuration.WithLabelValues(operationLabel, tableLabel).Observe(duration)
    
    status := "success"
    if err != nil {
        status = "error"
    }
    metrics.DatabaseOperations.WithLabelValues(operationLabel, tableLabel, status).Inc()
    
    return user, err
}
```

### Key Metrics to Collect

1. **Request Rates**: Total requests per endpoint/service
2. **Error Rates**: Failed requests by type and endpoint
3. **Latency**: Distribution of request durations
4. **Resource Utilization**: CPU, memory, disk, and network usage
5. **Business Metrics**: User signups, orders placed, or other application-specific metrics

## Distributed Tracing with OpenTelemetry

OpenTelemetry provides a vendor-neutral API for distributed tracing, allowing you to trace requests as they flow through your distributed system.

### Setting Up OpenTelemetry

Install the required packages:

```bash
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/sdk
go get go.opentelemetry.io/otel/trace
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

Create a tracing package:

```go
package tracing

import (
    "context"
    "log"
    "time"
    
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

var tracer = otel.Tracer("yourapp")

// Initialize sets up the OpenTelemetry tracer
func Initialize(serviceName, environment, version string, collectorEndpoint string) func() {
    // Create OTLP exporter
    ctx := context.Background()
    conn, err := grpc.DialContext(ctx, collectorEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        log.Fatalf("Failed to create gRPC connection to collector: %v", err)
    }
    
    traceExporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        log.Fatalf("Failed to create trace exporter: %v", err)
    }
    
    // Resource identifies your service in the trace visualization UI
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceNameKey.String(serviceName),
            semconv.ServiceVersionKey.String(version),
            semconv.DeploymentEnvironmentKey.String(environment),
        ),
    )
    if err != nil {
        log.Fatalf("Failed to create resource: %v", err)
    }
    
    // Create trace provider
    bsp := sdktrace.NewBatchSpanProcessor(traceExporter)
    tracerProvider := sdktrace.NewTracerProvider(
        sdktrace.WithSampler(sdktrace.AlwaysSample()),
        sdktrace.WithResource(res),
        sdktrace.WithSpanProcessor(bsp),
    )
    otel.SetTracerProvider(tracerProvider)
    
    // Set global propagator
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))
    
    return func() {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := tracerProvider.Shutdown(ctx); err != nil {
            log.Fatalf("Failed to shutdown TracerProvider: %v", err)
        }
    }
}

// Tracer returns the application tracer
func Tracer() otel.Tracer {
    return tracer
}
```

### Instrumenting HTTP Handlers

Use the OpenTelemetry HTTP middleware to automatically create spans for each request:

```go
package main

import (
    "net/http"
    
    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "yourpackage/logger"
    "yourpackage/metrics"
    "yourpackage/tracing"
)

func main() {
    logger.Initialize("development")
    defer logger.Sync()
    log := logger.Get()
    
    // Initialize tracing
    shutdown := tracing.Initialize(
        "user-service",
        "development",
        "1.0.0",
        "otel-collector:4317",
    )
    defer shutdown()
    
    // Expose metrics endpoint
    http.Handle("/metrics", promhttp.Handler())
    
    // Register your application routes with OpenTelemetry instrumentation
    userHandler := http.HandlerFunc(handleUsers)
    http.Handle("/api/users", otelhttp.NewHandler(
        instrumentHandler(userHandler),
        "users-endpoint",
        otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
    ))
    
    log.Info("Starting server on :8080")
    if err := http.ListenAndServe(":8080", nil); err != nil {
        log.Error("Server failed", log.Error(err))
    }
}
```

### Manual Span Creation

For more granular control, create spans manually:

```go
func processRequest(ctx context.Context, req *Request) (*Response, error) {
    ctx, span := tracing.Tracer().Start(ctx, "processRequest")
    defer span.End()
    
    // Add attributes to span
    span.SetAttributes(
        attribute.String("user.id", req.UserID),
        attribute.String("request.type", req.Type),
    )
    
    // Create a child span for database operation
    dbCtx, dbSpan := tracing.Tracer().Start(ctx, "database.operation")
    result, err := queryDatabase(dbCtx, req.Query)
    if err != nil {
        dbSpan.RecordError(err)
        dbSpan.SetStatus(codes.Error, err.Error())
    }
    dbSpan.End()
    
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    
    // Process the result
    response := processResult(result)
    return response, nil
}
```

### Propagating Context in gRPC Calls

For gRPC clients, use OpenTelemetry interceptors:

```go
import (
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "google.golang.org/grpc"
)

func newGrpcClient(target string) (*grpc.ClientConn, error) {
    conn, err := grpc.Dial(
        target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithUnaryInterceptor(otelgrpc.UnaryClientInterceptor()),
        grpc.WithStreamInterceptor(otelgrpc.StreamClientInterceptor()),
    )
    return conn, err
}
```

For gRPC servers:

```go
func newGrpcServer() *grpc.Server {
    return grpc.NewServer(
        grpc.UnaryInterceptor(otelgrpc.UnaryServerInterceptor()),
        grpc.StreamInterceptor(otelgrpc.StreamServerInterceptor()),
    )
}
```

## Integrating All Three Pillars

The most effective observability strategy integrates logging, metrics, and tracing. Here's how to tie them together:

### Connecting Logs to Traces

Add trace and span IDs to your logs:

```go
package logger

import (
    "context"
    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
)

// WithContext returns a logger with trace context information
func WithContext(ctx context.Context, baseLogger *zap.Logger) *zap.Logger {
    spanContext := trace.SpanContextFromContext(ctx)
    if !spanContext.IsValid() {
        return baseLogger
    }
    
    return baseLogger.With(
        zap.String("trace_id", spanContext.TraceID().String()),
        zap.String("span_id", spanContext.SpanID().String()),
    )
}
```

Usage:

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    logger := logger.WithContext(ctx, logger.Get())
    
    logger.Info("Processing request",
        zap.String("method", r.Method),
        zap.String("path", r.URL.Path),
    )
    
    // Process request...
}
```

### Adding Metric Labels to Traces

Enrich your traces with the same labels used in metrics:

```go
func processOrder(ctx context.Context, orderID string) error {
    ctx, span := tracing.Tracer().Start(ctx, "process_order")
    defer span.End()
    
    span.SetAttributes(
        attribute.String("order.id", orderID),
        attribute.String("service", "order-processor"),
    )
    
    // ... process the order
    
    return nil
}
```

### Middleware that Ties Everything Together

Create a middleware that handles logs, metrics, and traces:

```go
func observabilityMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        
        // Get trace information
        spanContext := trace.SpanContextFromContext(ctx)
        traceID := spanContext.TraceID().String()
        
        // Start timer for metrics
        start := time.Now()
        metrics.ActiveRequests.Inc()
        
        // Create a response writer wrapper to capture the status code
        sw := statusWriter{ResponseWriter: w, status: http.StatusOK}
        
        // Get logger with trace context
        log := logger.WithContext(ctx, logger.Get())
        
        // Log the incoming request
        log.Info("Request started",
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.String("remote_addr", r.RemoteAddr),
            zap.String("user_agent", r.UserAgent()),
        )
        
        // Call the actual handler
        next.ServeHTTP(&sw, r)
        
        // Calculate duration
        duration := time.Since(start).Seconds()
        
        // Record metrics
        statusStr := http.StatusText(sw.status)
        metrics.RequestDuration.WithLabelValues(r.Method, r.URL.Path, statusStr).Observe(duration)
        metrics.RequestCounter.WithLabelValues(r.Method, r.URL.Path, statusStr).Inc()
        metrics.ActiveRequests.Dec()
        
        // Log the completed request
        logLevel := zap.InfoLevel
        if sw.status >= 400 {
            logLevel = zap.ErrorLevel
        }
        
        log.Log(logLevel, "Request completed",
            zap.Int("status", sw.status),
            zap.String("status_text", statusStr),
            zap.Float64("duration_seconds", duration),
        )
    })
}
```

### HTTP Client with Observability

Create an HTTP client that propagates traces and records metrics:

```go
func newHTTPClient() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(
            http.DefaultTransport,
            otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
                return "HTTP " + r.Method + " " + r.URL.Path
            }),
        ),
        Timeout: 30 * time.Second,
    }
}

func callExternalService(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }
    
    start := time.Now()
    resp, err := newHTTPClient().Do(req)
    duration := time.Since(start).Seconds()
    
    // Record metrics
    status := "error"
    if err == nil {
        status = strconv.Itoa(resp.StatusCode)
    }
    metrics.ExternalServiceCalls.WithLabelValues("GET", url, status).Inc()
    metrics.ExternalServiceDuration.WithLabelValues("GET", url).Observe(duration)
    
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    
    return io.ReadAll(resp.Body)
}
```

## Setting Up an Observability Stack

To collect and visualize your observability data, set up:

1. **Collector**: [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) to receive, process, and export telemetry data
2. **Storage**: [Prometheus](https://prometheus.io/) for metrics, [Jaeger](https://www.jaegertracing.io/) for traces, and [Elasticsearch](https://www.elastic.co/elasticsearch/) for logs
3. **Visualization**: [Grafana](https://grafana.com/) for dashboards

### Sample Docker Compose Configuration

```yaml
version: '3'
services:
  # OpenTelemetry Collector
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317"  # OTLP gRPC
      - "4318:4318"  # OTLP HTTP
      - "8888:8888"  # Metrics
    depends_on:
      - jaeger
      - prometheus

  # Jaeger
  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"  # UI
      - "14250:14250"  # Model

  # Prometheus
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  # Grafana
  grafana:
    image: grafana/grafana:latest
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
      - elasticsearch

  # Elasticsearch
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:7.16.2
    environment:
      - discovery.type=single-node
    ports:
      - "9200:9200"

  # Kibana
  kibana:
    image: docker.elastic.co/kibana/kibana:7.16.2
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch
```

## Best Practices for Go Observability

### 1. Consistent Naming Conventions

Use consistent naming for services, endpoints, and metrics:

- Service names: lowercase with dashes (e.g., `user-service`)
- Metrics: snake_case with prefix (e.g., `http_requests_total`)
- Spans: lowercase with underscores for operations (e.g., `database_query`)

### 2. Use Correlation IDs

Ensure every request has a unique ID that flows through all services:

```go
func generateCorrelationID(r *http.Request) string {
    id := r.Header.Get("X-Correlation-ID")
    if id == "" {
        id = uuid.New().String()
    }
    return id
}

func correlationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        correlationID := generateCorrelationID(r)
        ctx := context.WithValue(r.Context(), "correlation_id", correlationID)
        
        w.Header().Set("X-Correlation-ID", correlationID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### 3. Monitor System Resources

Include system-level metrics like CPU, memory, and disk usage:

```go
var (
    // System metrics
    cpuUsage = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "system_cpu_usage",
        Help: "Current CPU usage percentage",
    })
    
    memoryUsage = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "system_memory_bytes",
        Help: "Current memory usage in bytes",
    })
)

func recordSystemMetrics() {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        
        for range ticker.C {
            var m runtime.MemStats
            runtime.ReadMemStats(&m)
            
            memoryUsage.Set(float64(m.Alloc))
            
            // For full CPU metrics, consider using a library like gopsutil
        }
    }()
}
```

### 4. Track Custom Business Metrics

Don't limit yourself to technical metrics; include business-level metrics:

```go
var (
    ordersProcessed = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "business_orders_processed_total",
            Help: "Total number of orders processed",
        },
        []string{"status", "payment_method"},
    )
    
    revenueGenerated = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "business_revenue_cents_total",
            Help: "Total revenue in cents",
        },
        []string{"product_category"},
    )
)

func processOrder(order *Order) error {
    // Process order...
    
    // Record business metrics
    ordersProcessed.WithLabelValues(order.Status, order.PaymentMethod).Inc()
    revenueGenerated.WithLabelValues(order.ProductCategory).Add(float64(order.AmountCents))
    
    return nil
}
```

### 5. Use Sampling Strategies for Production

For high-volume production systems, use sampling to reduce overhead:

```go
// Create sampler based on environment
var sampler sdktrace.Sampler
if environment == "production" {
    // Sample 10% of traces in production
    sampler = sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(0.1),
    )
} else {
    // Sample all traces in non-production
    sampler = sdktrace.AlwaysSample()
}

// Use the sampler in trace provider
tracerProvider := sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sampler),
    sdktrace.WithResource(res),
    sdktrace.WithSpanProcessor(bsp),
)
```

## Conclusion

Implementing comprehensive observability in Go applications requires careful integration of logging, metrics, and tracing. By using structured logging with Zap, metrics collection with Prometheus, and distributed tracing with OpenTelemetry, you can build a robust observability system that helps you understand your application's behavior, troubleshoot issues, and optimize performance.

Remember that observability is not a one-time setup but an ongoing process. Continuously refine what you measure and how you visualize it based on your application's evolving needs and the issues you encounter.

Start simple, focus on the most critical parts of your application, and gradually expand your observability coverage. The investment in good observability practices pays off many times over in reduced debugging time and improved system reliability.