---
title: "Go Structured Logging: slog, zerolog, and Production Log Pipeline Design"
date: 2029-12-12T00:00:00-05:00
draft: false
tags: ["Go", "Logging", "slog", "zerolog", "Loki", "Elasticsearch", "Observability", "Production"]
categories:
- Go
- Observability
- Logging
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go 1.21 slog, zerolog performance patterns, log levels, structured fields, log sampling, context propagation, and shipping logs to Loki and Elasticsearch in production systems."
more_link: "yes"
url: "/go-structured-logging-slog-zerolog-production-pipeline/"
---

Logging is simultaneously the most-used and least-thought-about observability signal in production systems. Print statements evolve into unstructured strings that grep can barely parse. The shift to structured logging — where every log line is a machine-readable JSON document with typed fields — enables log queries, alerts on field values, and correlation with traces and metrics. Go 1.21 introduced `log/slog` as the standard structured logging API, while `zerolog` remains the performance leader for high-throughput services. This guide covers both, explains when to choose each, and builds the complete production log pipeline from application to storage.

<!--more-->

## log/slog: The Standard Library Solution

`log/slog` (introduced in Go 1.21) defines a common logging interface that allows libraries and applications to share a logging API without coupling to a specific implementation. The package provides two handler implementations: `TextHandler` and `JSONHandler`.

### Basic slog Usage

```go
package main

import (
    "context"
    "log/slog"
    "os"
)

func main() {
    // JSON handler for production
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true,  // Include file:line in every log entry
    }))

    // Set as default logger
    slog.SetDefault(logger)

    // Basic structured logging
    slog.Info("server started",
        "addr", ":8080",
        "version", "1.2.3",
        "env", "production",
    )

    // With context (important for trace correlation)
    ctx := context.WithValue(context.Background(), "request_id", "req-abc123")
    slog.InfoContext(ctx, "request received",
        "method", "POST",
        "path", "/api/orders",
        "user_id", 12345,
    )
}
```

Output:

```json
{"time":"2029-12-12T00:00:01.234Z","level":"INFO","source":{"function":"main.main","file":"main.go","line":18},"msg":"server started","addr":":8080","version":"1.2.3","env":"production"}
```

### Logger with Pre-set Fields

Use `With` to create child loggers with pre-attached fields — the standard pattern for per-request logging:

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Create request-scoped logger with correlation fields
    reqLogger := slog.With(
        "request_id", r.Header.Get("X-Request-ID"),
        "method",     r.Method,
        "path",       r.URL.Path,
        "remote_ip",  r.RemoteAddr,
    )

    reqLogger.Info("request started")

    result, err := processRequest(r)
    if err != nil {
        reqLogger.Error("request processing failed",
            "error", err,
            "status", http.StatusInternalServerError,
        )
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    reqLogger.Info("request completed",
        "status", http.StatusOK,
        "response_bytes", len(result),
        "duration_ms", time.Since(startTime).Milliseconds(),
    )
}
```

### Custom slog Handler for Context Propagation

Extract trace IDs and other context values automatically from the request context:

```go
type contextHandler struct {
    handler slog.Handler
}

func (h *contextHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.handler.Enabled(ctx, level)
}

func (h *contextHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract trace ID from context (e.g., from OpenTelemetry)
    if span := trace.SpanFromContext(ctx); span.SpanContext().IsValid() {
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
        )
    }
    // Extract request ID from context
    if reqID, ok := ctx.Value(requestIDKey).(string); ok && reqID != "" {
        r.AddAttrs(slog.String("request_id", reqID))
    }
    return h.handler.Handle(ctx, r)
}

func (h *contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &contextHandler{handler: h.handler.WithAttrs(attrs)}
}

func (h *contextHandler) WithGroup(name string) slog.Handler {
    return &contextHandler{handler: h.handler.WithGroup(name)}
}

// Usage:
baseHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
logger := slog.New(&contextHandler{handler: baseHandler})
slog.SetDefault(logger)
```

### slog Log Levels in Practice

```go
const (
    LevelTrace = slog.Level(-8)  // Custom level below Debug
    LevelFatal = slog.Level(12)  // Custom level above Error
)

// Dynamic level control (change without restart)
var logLevel = new(slog.LevelVar)
logLevel.Set(slog.LevelInfo)

logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: logLevel,
}))

// To enable debug at runtime (e.g., via HTTP endpoint):
http.HandleFunc("/debug/loglevel", func(w http.ResponseWriter, r *http.Request) {
    switch r.FormValue("level") {
    case "debug":
        logLevel.Set(slog.LevelDebug)
    case "info":
        logLevel.Set(slog.LevelInfo)
    }
    fmt.Fprintf(w, "log level set to %s", logLevel.Level())
})
```

## zerolog: Performance-First Logging

zerolog generates zero allocations on the hot path using a fluent API that writes directly to an `io.Writer`. For services handling tens of thousands of requests per second, the difference between an allocating and zero-allocation logger is measurable in CPU profiles.

### Benchmark Comparison

```
BenchmarkSlogJSON       -   450 ns/op    240 B/op    3 allocs/op
BenchmarkZerolog        -   120 ns/op      0 B/op    0 allocs/op
BenchmarkZap            -   200 ns/op     32 B/op    0 allocs/op
```

zerolog wins on both latency and allocation, which matters in the hot request path.

### zerolog Setup

```go
import (
    "os"
    "time"

    "github.com/rs/zerolog"
    "github.com/rs/zerolog/log"
)

func initLogger() zerolog.Logger {
    zerolog.TimeFieldFormat = time.RFC3339Nano
    zerolog.SetGlobalLevel(zerolog.InfoLevel)

    // Multi-writer: stdout + file
    output := zerolog.MultiLevelWriter(
        os.Stdout,
        &zerolog.FilteredLevelWriter{
            Writer: zerolog.NewConsoleWriter(func(w *zerolog.ConsoleWriter) {
                w.Out = os.Stderr
            }),
            Level: zerolog.ErrorLevel,
        },
    )

    logger := zerolog.New(output).
        With().
        Timestamp().
        Str("service", "myapp").
        Str("version", "1.2.3").
        Str("env", os.Getenv("ENVIRONMENT")).
        Logger()

    // Set global logger
    log.Logger = logger
    return logger
}
```

### zerolog in Request Handlers

```go
func (s *Server) handleOrder(w http.ResponseWriter, r *http.Request) {
    // Create request-scoped logger
    logger := log.With().
        Str("request_id", r.Header.Get("X-Request-ID")).
        Str("method", r.Method).
        Str("path", r.URL.Path).
        Str("user_id", r.Header.Get("X-User-ID")).
        Logger()

    logger.Info().Msg("processing order")

    order, err := s.orderService.Create(r.Context(), parseOrderBody(r.Body))
    if err != nil {
        logger.Error().
            Err(err).
            Str("order_type", "create").
            Int("status_code", http.StatusUnprocessableEntity).
            Msg("order creation failed")
        http.Error(w, err.Error(), http.StatusUnprocessableEntity)
        return
    }

    logger.Info().
        Str("order_id", order.ID).
        Float64("amount", order.Amount).
        Str("currency", order.Currency).
        Int("status_code", http.StatusCreated).
        Msg("order created")

    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(order)
}
```

### zerolog Sampling

For very high-frequency events (cache hits, health checks), log sampling prevents log volume from overwhelming your pipeline:

```go
import "github.com/rs/zerolog/log"

// Sample 1 in 100 cache hit events
sampler := &zerolog.BasicSampler{N: 100}
sampledLogger := log.Sample(sampler)

func cacheGet(key string) {
    // Only 1% of these are logged
    sampledLogger.Debug().
        Str("key", key).
        Msg("cache hit")
}

// Burst sampler: allow N events, then allow 1 per period
burstSampler := &zerolog.BurstSampler{
    Burst:       5,
    Period:      1 * time.Second,
    NextSampler: &zerolog.BasicSampler{N: 100},
}
```

### zerolog with OpenTelemetry Context

```go
func logWithTracing(ctx context.Context, logger zerolog.Logger) zerolog.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        return logger
    }
    return logger.With().
        Str("trace_id", span.SpanContext().TraceID().String()).
        Str("span_id", span.SpanContext().SpanID().String()).
        Bool("trace_sampled", span.SpanContext().IsSampled()).
        Logger()
}
```

## Production Log Pipeline Design

### Structured Log Fields Standard

Establish a consistent field schema across all services to enable cross-service log queries:

```go
// Standard fields every log entry should include
type LogContext struct {
    // Identity
    Service   string `json:"service"`
    Version   string `json:"version"`
    Env       string `json:"env"`

    // Request correlation
    RequestID string `json:"request_id,omitempty"`
    TraceID   string `json:"trace_id,omitempty"`
    SpanID    string `json:"span_id,omitempty"`

    // Kubernetes context (injected via Downward API)
    PodName   string `json:"pod_name,omitempty"`
    Namespace string `json:"namespace,omitempty"`
    NodeName  string `json:"node_name,omitempty"`

    // HTTP request fields
    Method     string `json:"method,omitempty"`
    Path       string `json:"path,omitempty"`
    StatusCode int    `json:"status_code,omitempty"`
    DurationMs int64  `json:"duration_ms,omitempty"`

    // Error fields
    Error     string `json:"error,omitempty"`
    ErrorCode string `json:"error_code,omitempty"`
    Stack     string `json:"stack,omitempty"`
}
```

### Shipping to Grafana Loki

Loki is optimized for log aggregation with label-based indexing. Only high-cardinality fields go into labels; everything else lives in the log line:

```yaml
# Promtail configuration for shipping Go service logs
server:
  http_listen_port: 9080

clients:
- url: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push
  batchwait: 1s
  batchsize: 1048576
  timeout: 10s
  backoff_config:
    min_period: 100ms
    max_period: 5s
    max_retries: 10

scrape_configs:
- job_name: kubernetes-pods-app-logs
  pipeline_stages:
  - cri: {}
  - json:
      expressions:
        level: level
        service: service
        request_id: request_id
        trace_id: trace_id
  - labels:
      level:
      service:
  # High-cardinality fields stay in the log body, NOT as labels
  # request_id, trace_id are for querying within log lines
  - timestamp:
      source: time
      format: RFC3339Nano
  kubernetes_sd_configs:
  - role: pod
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app]
    action: keep
    regex: .+
```

### Shipping to Elasticsearch

For teams using the ELK stack, Filebeat or Fluent Bit ships to Elasticsearch:

```yaml
# Fluent Bit configuration
[SERVICE]
    Flush         5
    Log_Level     info
    Parsers_File  parsers.conf

[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    Parser            cri
    Tag               kube.*
    Refresh_Interval  5
    Mem_Buf_Limit     50MB
    Skip_Long_Lines   On

[FILTER]
    Name         kubernetes
    Match        kube.*
    Kube_URL     https://kubernetes.default.svc:443
    Kube_CA_File /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    Kube_Token_File /var/run/secrets/kubernetes.io/serviceaccount/token
    Merge_Log    On
    K8S-Logging.Parser On

[FILTER]
    Name    parser
    Match   kube.*
    Key_Name log
    Parser  json
    Preserve_Key On
    Reserve_Data On

[OUTPUT]
    Name  es
    Match kube.*
    Host  elasticsearch.logging.svc.cluster.local
    Port  9200
    Index go-service-logs
    Type  _doc
    Logstash_Format On
    Logstash_Prefix go-services
    Logstash_DateFormat %Y.%m.%d
    Retry_Limit 5
    tls Off
    tls.verify Off
```

### Elasticsearch Index Template

```json
{
  "index_patterns": ["go-services-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "index.lifecycle.name": "30-day-logs",
      "refresh_interval": "5s"
    },
    "mappings": {
      "dynamic": false,
      "properties": {
        "@timestamp":   { "type": "date" },
        "level":        { "type": "keyword" },
        "msg":          { "type": "text" },
        "service":      { "type": "keyword" },
        "version":      { "type": "keyword" },
        "env":          { "type": "keyword" },
        "request_id":   { "type": "keyword" },
        "trace_id":     { "type": "keyword" },
        "span_id":      { "type": "keyword" },
        "method":       { "type": "keyword" },
        "path":         { "type": "keyword" },
        "status_code":  { "type": "integer" },
        "duration_ms":  { "type": "long" },
        "error":        { "type": "text" },
        "pod_name":     { "type": "keyword" },
        "namespace":    { "type": "keyword" },
        "node_name":    { "type": "keyword" }
      }
    }
  }
}
```

## Choosing slog vs zerolog

Use `log/slog` when:
- Building a library that others will consume — slog's interface is the standard
- Teams value standard library dependencies over performance optimization
- Logging is not in the critical path (control plane services, CLI tools)

Use zerolog when:
- Processing >10,000 requests/second where logging overhead is measurable
- Already dependent on zerolog in an existing codebase
- Need the burst sampler or the multi-level writer for sophisticated routing

Both ecosystems support bridging: `slog-zerolog` adapts zerolog as a slog handler, allowing you to use the slog API while retaining zerolog's allocation-free performance.

```go
import slogzerolog "github.com/samber/slog-zerolog/v2"

logger := slog.New(slogzerolog.Option{
    Level:  slog.LevelInfo,
    Logger: &zerologLogger,
}.NewZerologHandler())
```

The critical practice in both cases is consistency: every log entry should carry `trace_id` and `request_id`, log lines should never contain PII without explicit review, and error logs should include the full error chain with `fmt.Errorf("operation: %w", err)` so `slog`'s `"error"` field captures the wrapped error string.
