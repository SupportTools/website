---
title: "Go Observability: Structured Logging with slog, zap, and Contextual Tracing"
date: 2031-01-04T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Observability", "Logging", "slog", "zap", "OpenTelemetry", "Tracing", "ELK", "Loki"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to structured logging in Go using slog and zap, with trace ID injection, log level management, sampling for high-volume services, and sink configuration for ELK and Grafana Loki."
more_link: "yes"
url: "/go-observability-structured-logging-slog-zap-contextual-tracing/"
---

Logging is the first tool engineers reach for during an incident, and the quality of logs determines how quickly they find the root cause. Unstructured logs — lines of text with no consistent schema — are fine for a single developer debugging locally. At production scale they become a bottleneck: grep-based queries over gigabytes of text, no correlation between log entries and traces, and no way to filter by user ID or request ID without regex gymnastics. This guide covers structured logging in Go using both the standard library's `slog` package (Go 1.21+) and the battle-tested `zap` library, with trace ID injection, log level management, sampling, and sink configuration for ELK and Grafana Loki.

<!--more-->

# Go Observability: Structured Logging with slog, zap, and Contextual Tracing

## Section 1: Why Structured Logging

Structured logging records each event as a machine-readable key-value document rather than a freeform string. The difference becomes clear at query time:

```
# Unstructured — what you get with fmt.Fprintf(os.Stderr, ...)
2024-03-15 14:23:01 ERROR user 1234 payment failed: connection refused to db-01:5432 after 3 retries

# Structured JSON — what slog and zap produce
{"timestamp":"2024-03-15T14:23:01.234Z","level":"error","msg":"payment failed",
"user_id":"1234","error":"connection refused","host":"db-01","port":5432,
"retries":3,"request_id":"7f4a2b1c3e5d6f8a","trace_id":"01928374657483920",
"service":"payment-service","version":"2.4.1","environment":"production"}
```

With structured logs, queries become filter operations: `level=error AND user_id=1234 AND service=payment-service`. ELK, Loki, and Datadog handle these natively.

## Section 2: slog — The Standard Library Solution

Go 1.21 added `log/slog` to the standard library. It provides structured logging with a clean API and pluggable handler backends.

### 2.1 Basic slog Usage

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
)

func main() {
	// JSON handler for production
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		// Add source code location to every log entry
		AddSource: true,
		// Replace default attribute keys
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Rename "time" to "timestamp" for ELK compatibility
			if a.Key == slog.TimeKey {
				a.Key = "timestamp"
			}
			// Rename "msg" to "message"
			if a.Key == slog.MessageKey {
				a.Key = "message"
			}
			return a
		},
	})

	logger := slog.New(handler)
	slog.SetDefault(logger)

	// Basic structured logging
	slog.Info("server starting",
		"port", 8080,
		"environment", "production",
	)

	// Logging with typed attributes (more efficient than string+interface{})
	slog.Info("request processed",
		slog.String("method", "POST"),
		slog.String("path", "/api/v1/payments"),
		slog.Int("status", 200),
		slog.Duration("duration", 45*1000*1000), // 45ms
		slog.String("request_id", "7f4a2b1c"),
	)

	// Error with stack context
	err := errors.New("connection timeout")
	slog.Error("database query failed",
		slog.String("query", "SELECT * FROM users WHERE id = $1"),
		slog.String("database", "postgres-primary"),
		slog.Any("error", err),
	)
}
```

### 2.2 Context-Aware slog Logger

The most important pattern for microservices: extracting contextual fields (trace ID, user ID, request ID) from the context and attaching them to every log entry.

```go
// observability/slogctx/slogctx.go
package slogctx

import (
	"context"
	"log/slog"
)

type contextKey struct{ name string }

var (
	traceIDKey    = contextKey{"trace_id"}
	spanIDKey     = contextKey{"span_id"}
	requestIDKey  = contextKey{"request_id"}
	userIDKey     = contextKey{"user_id"}
	tenantIDKey   = contextKey{"tenant_id"}
)

// WithTraceID returns a context with the trace ID stored.
func WithTraceID(ctx context.Context, traceID string) context.Context {
	return context.WithValue(ctx, traceIDKey, traceID)
}

// WithRequestID returns a context with the request ID stored.
func WithRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestIDKey, requestID)
}

// WithUserID returns a context with the user ID stored.
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey, userID)
}

// WithTenantID returns a context with the tenant ID stored.
func WithTenantID(ctx context.Context, tenantID string) context.Context {
	return context.WithValue(ctx, tenantIDKey, tenantID)
}

// ExtractAttrs extracts all observability attributes from context as slog.Attr.
func ExtractAttrs(ctx context.Context) []slog.Attr {
	var attrs []slog.Attr

	if v, ok := ctx.Value(traceIDKey).(string); ok && v != "" {
		attrs = append(attrs, slog.String("trace_id", v))
	}
	if v, ok := ctx.Value(spanIDKey).(string); ok && v != "" {
		attrs = append(attrs, slog.String("span_id", v))
	}
	if v, ok := ctx.Value(requestIDKey).(string); ok && v != "" {
		attrs = append(attrs, slog.String("request_id", v))
	}
	if v, ok := ctx.Value(userIDKey).(string); ok && v != "" {
		attrs = append(attrs, slog.String("user_id", v))
	}
	if v, ok := ctx.Value(tenantIDKey).(string); ok && v != "" {
		attrs = append(attrs, slog.String("tenant_id", v))
	}

	return attrs
}

// ContextHandler wraps a slog.Handler to automatically inject context values.
type ContextHandler struct {
	slog.Handler
}

// Handle injects context attributes before delegating to the underlying handler.
func (h ContextHandler) Handle(ctx context.Context, r slog.Record) error {
	attrs := ExtractAttrs(ctx)
	if len(attrs) > 0 {
		r.AddAttrs(attrs...)
	}
	return h.Handler.Handle(ctx, r)
}

// NewContextHandler wraps a handler with automatic context attribute injection.
func NewContextHandler(h slog.Handler) *ContextHandler {
	return &ContextHandler{Handler: h}
}
```

```go
// Using the context-aware handler:
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/support-tools/example/observability/slogctx"
)

func main() {
	baseHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})

	// Wrap with context handler for automatic trace ID injection
	logger := slog.New(slogctx.NewContextHandler(baseHandler))
	slog.SetDefault(logger)

	// In an HTTP handler or gRPC interceptor, enrich the context:
	ctx := context.Background()
	ctx = slogctx.WithRequestID(ctx, "7f4a2b1c3e5d6f8a")
	ctx = slogctx.WithTraceID(ctx, "01928374657483920192837465748392")
	ctx = slogctx.WithUserID(ctx, "user-12345")

	// Every log call with this context automatically includes request_id, trace_id, user_id
	slog.InfoContext(ctx, "processing payment",
		slog.String("payment_id", "pay-789"),
		slog.Float64("amount", 99.99),
		slog.String("currency", "USD"),
	)
	// Output: {"timestamp":"...","level":"INFO","message":"processing payment",
	//           "payment_id":"pay-789","amount":99.99,"currency":"USD",
	//           "request_id":"7f4a2b1c3e5d6f8a","trace_id":"01928374657483920192837465748392",
	//           "user_id":"user-12345"}
}
```

### 2.3 slog with Groups (Namespaced Attributes)

Groups organize related attributes under a common key:

```go
// Log HTTP request details in a nested structure
slog.InfoContext(ctx, "request completed",
	slog.Group("http",
		slog.String("method", "POST"),
		slog.String("path", "/api/v1/orders"),
		slog.Int("status", 201),
		slog.Int64("bytes", 1234),
	),
	slog.Group("timing",
		slog.Duration("total", 45*time.Millisecond),
		slog.Duration("db", 12*time.Millisecond),
		slog.Duration("upstream", 28*time.Millisecond),
	),
)
// Produces: {"http":{"method":"POST","path":"/api/v1/orders","status":201,"bytes":1234},
//             "timing":{"total":"45ms","db":"12ms","upstream":"28ms"}}
```

### 2.4 Logger with Pre-attached Fields

For services with many sub-components, pre-attach component-level fields:

```go
// Create a sub-logger for the database component
dbLogger := slog.With(
	slog.String("component", "database"),
	slog.String("database", "postgres-primary"),
	slog.String("pool", "read-write"),
)

dbLogger.InfoContext(ctx, "query executed",
	slog.String("query_id", "q-001"),
	slog.Duration("duration", 5*time.Millisecond),
	slog.Int("rows", 42),
)
// All entries from dbLogger automatically include component, database, pool fields
```

## Section 3: zap — High-Performance Production Logging

`go.uber.org/zap` is the production choice for high-throughput services. It is 10-50x faster than standard library logging because it avoids reflection and allocates minimally on the hot path.

### 3.1 zap Logger Construction

```go
// observability/logger/logger.go
package logger

import (
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Config holds logger configuration.
type Config struct {
	Level       string
	Environment string
	ServiceName string
	Version     string
	Development bool
}

// New creates a production-configured zap logger.
func New(cfg Config) (*zap.Logger, error) {
	level, err := zapcore.ParseLevel(cfg.Level)
	if err != nil {
		level = zapcore.InfoLevel
	}

	// Encoder config for JSON output
	encoderCfg := zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey, // omit function name to reduce noise
		MessageKey:     "message",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.StringDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}

	// Write to stdout for container environments
	core := zapcore.NewCore(
		zapcore.NewJSONEncoder(encoderCfg),
		zapcore.AddSync(os.Stdout),
		zap.NewAtomicLevelAt(level),
	)

	// Add static service-level fields that appear on every log entry
	logger := zap.New(core,
		zap.AddCaller(),
		zap.AddCallerSkip(0),
	).With(
		zap.String("service", cfg.ServiceName),
		zap.String("version", cfg.Version),
		zap.String("environment", cfg.Environment),
	)

	if cfg.Development {
		logger = logger.WithOptions(zap.Development())
	}

	return logger, nil
}

// NewNop creates a no-op logger for testing.
func NewNop() *zap.Logger {
	return zap.NewNop()
}
```

### 3.2 Dynamic Log Level Management

Production services need to change log levels at runtime without restarting. `zap.AtomicLevel` enables this with an HTTP endpoint.

```go
// observability/loglevel/loglevel.go
package loglevel

import (
	"encoding/json"
	"net/http"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Handler returns an HTTP handler for dynamic log level management.
// Mount at /admin/loglevel or /debug/loglevel.
func Handler(atom zap.AtomicLevel) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// Return current level
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"level": atom.Level().String(),
			})

		case http.MethodPut:
			// Update the level
			var req struct {
				Level string `json:"level"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}

			var level zapcore.Level
			if err := level.UnmarshalText([]byte(req.Level)); err != nil {
				http.Error(w, "invalid level: "+err.Error(), http.StatusBadRequest)
				return
			}

			atom.SetLevel(level)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"level": level.String(),
				"status": "updated",
			})

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
```

```bash
# Change log level at runtime (no restart required)
curl -X PUT http://service:9000/admin/loglevel \
  -H "Content-Type: application/json" \
  -d '{"level":"debug"}'

# Query current level
curl http://service:9000/admin/loglevel
# {"level":"info"}
```

### 3.3 zap with Context (Trace ID Injection)

```go
// observability/zapctx/zapctx.go
package zapctx

import (
	"context"

	"go.uber.org/zap"
)

type loggerKey struct{}

// WithLogger stores a logger in the context.
func WithLogger(ctx context.Context, logger *zap.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, logger)
}

// FromContext retrieves the logger from context.
// Falls back to the global logger if none is stored.
func FromContext(ctx context.Context) *zap.Logger {
	if logger, ok := ctx.Value(loggerKey{}).(*zap.Logger); ok {
		return logger
	}
	return zap.L() // global logger fallback
}

// EnrichLogger extracts observability fields from ctx and returns an enriched logger.
// Compatible with OpenTelemetry trace context.
func EnrichLogger(ctx context.Context, logger *zap.Logger) *zap.Logger {
	// Extract trace context from OpenTelemetry span if available
	// This requires go.opentelemetry.io/otel/trace
	// span := trace.SpanFromContext(ctx)
	// if span.SpanContext().IsValid() {
	//     logger = logger.With(
	//         zap.String("trace_id", span.SpanContext().TraceID().String()),
	//         zap.String("span_id", span.SpanContext().SpanID().String()),
	//     )
	// }

	// Extract custom context values (set by middleware)
	if v, ok := ctx.Value(requestIDContextKey{}).(string); ok && v != "" {
		logger = logger.With(zap.String("request_id", v))
	}
	if v, ok := ctx.Value(userIDContextKey{}).(string); ok && v != "" {
		logger = logger.With(zap.String("user_id", v))
	}

	return logger
}

type requestIDContextKey struct{}
type userIDContextKey struct{}
```

### 3.4 Sampling for High-Volume Services

Log sampling prevents high-throughput services from drowning log backends. zap's built-in sampler drops repeated log entries while ensuring a minimum sample rate.

```go
// observability/sampling/sampling.go
package sampling

import (
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// NewSampledLogger wraps a core with sampling.
// For each unique (level, message) combination:
//   - The first 'initial' entries per 'tick' are always logged.
//   - Beyond that, 1 in every 'thereafter' entries is logged.
func NewSampledLogger(base *zap.Logger, tick time.Duration, initial, thereafter int) *zap.Logger {
	return base.WithOptions(
		zap.WrapCore(func(core zapcore.Core) zapcore.Core {
			return zapcore.NewSamplerWithOptions(
				core,
				tick,
				initial,    // first N entries per tick
				thereafter, // then 1 in N
			)
		}),
	)
}

// Example: for a service logging 10,000 "cache miss" entries per second:
// - tick=1s, initial=100, thereafter=100
// - First 100 entries per second are logged as normal
// - After that, 1 in every 100 is logged (100 additional)
// - Total: ~200 log entries per second instead of 10,000
//
// Usage:
// sampledLogger := sampling.NewSampledLogger(logger, time.Second, 100, 100)
// Use sampledLogger for high-frequency events (cache hits/misses, health checks)
// Use logger (unsampled) for errors and warnings
```

### 3.5 Multi-Output zap: Console + File + Metrics

```go
// observability/multiwriter/multiwriter.go
package multiwriter

import (
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// NewMultiOutputLogger creates a logger that writes to both stdout (JSON)
// and a file sink (for legacy log collectors).
func NewMultiOutputLogger(level zapcore.Level, logFilePath string) (*zap.Logger, error) {
	encoderCfg := zap.NewProductionEncoderConfig()
	encoderCfg.TimeKey = "timestamp"
	encoderCfg.EncodeTime = zapcore.ISO8601TimeEncoder

	// JSON for stdout (container log driver)
	stdoutCore := zapcore.NewCore(
		zapcore.NewJSONEncoder(encoderCfg),
		zapcore.AddSync(os.Stdout),
		level,
	)

	// Optionally write to file for Filebeat/Fluentbit collection
	var fileCore zapcore.Core
	if logFilePath != "" {
		logFile, err := os.OpenFile(logFilePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return nil, err
		}
		fileCore = zapcore.NewCore(
			zapcore.NewJSONEncoder(encoderCfg),
			zapcore.AddSync(logFile),
			level,
		)
	}

	var core zapcore.Core
	if fileCore != nil {
		core = zapcore.NewTee(stdoutCore, fileCore)
	} else {
		core = stdoutCore
	}

	return zap.New(core, zap.AddCaller(), zap.AddStacktrace(zapcore.ErrorLevel)), nil
}
```

## Section 4: OpenTelemetry Trace ID Injection

The most valuable observability improvement is correlating log entries with distributed traces. When a log entry contains the trace ID, you can jump directly from log to trace in your observability platform.

```go
// observability/otelzap/otelzap.go
package otelzap

import (
	"context"

	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// TraceFields extracts the OpenTelemetry trace context from ctx
// and returns zap fields for trace_id and span_id.
func TraceFields(ctx context.Context) []zap.Field {
	span := trace.SpanFromContext(ctx)
	if !span.SpanContext().IsValid() {
		return nil
	}

	sc := span.SpanContext()
	fields := []zap.Field{
		zap.String("trace_id", sc.TraceID().String()),
		zap.String("span_id", sc.SpanID().String()),
	}

	// Add trace flags (sampled, etc.)
	if sc.TraceFlags().IsSampled() {
		fields = append(fields, zap.Bool("trace_sampled", true))
	}

	return fields
}

// ContextLogger returns a logger enriched with trace context fields.
// Call this at the beginning of any traced function.
func ContextLogger(ctx context.Context, base *zap.Logger) *zap.Logger {
	fields := TraceFields(ctx)
	if len(fields) == 0 {
		return base
	}
	return base.With(fields...)
}

// ZapHook creates a zap hook that automatically injects trace context
// for log entries using InfoContext/WarnContext/ErrorContext methods.
// This avoids having to call ContextLogger at every call site.
type contextHook struct{}

func (h contextHook) OnWrite(entry zapcore.Entry, fields []zapcore.Field) error {
	// zap hooks don't have access to context; use ContextLogger pattern instead
	return nil
}
```

### 4.1 slog + OpenTelemetry Bridge

```go
// observability/slogotel/bridge.go
package slogotel

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// OtelHandler is a slog.Handler that automatically injects
// OpenTelemetry trace context into log records.
type OtelHandler struct {
	slog.Handler
}

func (h OtelHandler) Handle(ctx context.Context, r slog.Record) error {
	span := trace.SpanFromContext(ctx)
	if span.SpanContext().IsValid() {
		sc := span.SpanContext()
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.Handler.Handle(ctx, r)
}

// NewOtelHandler creates a slog handler with automatic OTel injection.
func NewOtelHandler(h slog.Handler) *OtelHandler {
	return &OtelHandler{Handler: h}
}
```

## Section 5: Log Level Management Across Services

### 5.1 Consistent Level Strategy

| Level | Use For |
|---|---|
| `DEBUG` | Developer diagnostics: query text, variable values, internal state. Never enable in production by default. |
| `INFO` | Normal operational events: service start/stop, request completion, background job results. |
| `WARN` | Unexpected but handled conditions: retries, degraded mode, approaching limits. |
| `ERROR` | Errors that affect a single request but not the whole service. Should always have an `error` field. |
| `FATAL` / `DPANIC` | Errors that prevent the service from operating. Call `os.Exit` after logging. Use sparingly. |

### 5.2 Per-Component Level Control

```go
// observability/componentlog/componentlog.go
package componentlog

import (
	"sync"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Registry manages per-component log levels.
type Registry struct {
	mu     sync.RWMutex
	base   *zap.Logger
	levels map[string]*zap.AtomicLevel
}

// NewRegistry creates a new component logger registry.
func NewRegistry(base *zap.Logger) *Registry {
	return &Registry{
		base:   base,
		levels: make(map[string]*zap.AtomicLevel),
	}
}

// For returns a logger for the named component.
// Components can have their log level set independently.
func (r *Registry) For(component string) *zap.Logger {
	r.mu.Lock()
	defer r.mu.Unlock()

	level, exists := r.levels[component]
	if !exists {
		atom := zap.NewAtomicLevel()
		r.levels[component] = &atom
		level = &atom
	}

	return r.base.With(zap.String("component", component)).
		WithOptions(zap.WrapCore(func(core zapcore.Core) zapcore.Core {
			return zapcore.NewCore(
				zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig()),
				zapcore.AddSync(nil), // inherit from base
				level,
			)
		}))
}

// SetLevel updates the log level for a specific component.
func (r *Registry) SetLevel(component string, level zapcore.Level) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if atom, exists := r.levels[component]; exists {
		atom.SetLevel(level)
	}
}
```

## Section 6: ELK Stack Sink Configuration

### 6.1 Filebeat Configuration for Go JSON Logs

```yaml
# filebeat.yaml — collect Go service logs from container stdout
filebeat.inputs:
- type: container
  paths:
  - /var/log/containers/payment-service-*.log
  processors:
  # Parse the JSON log line
  - decode_json_fields:
      fields: ["message"]
      target: ""
      overwrite_keys: true
      add_error_key: true
  # Add pod metadata from Kubernetes
  - add_kubernetes_metadata:
      in_cluster: true
      host: ${NODE_NAME}
      namespace: ${NAMESPACE}

output.elasticsearch:
  hosts: ["elasticsearch:9200"]
  index: "go-services-%{+yyyy.MM.dd}"
  pipeline: "go-services-enrichment"

# Index template
setup.template:
  name: "go-services"
  pattern: "go-services-*"
  settings:
    index.number_of_shards: 3
    index.number_of_replicas: 1
```

### 6.2 Elasticsearch Ingest Pipeline

```json
PUT _ingest/pipeline/go-services-enrichment
{
  "description": "Enrich Go service logs",
  "processors": [
    {
      "date": {
        "field": "timestamp",
        "formats": ["ISO8601"],
        "target_field": "@timestamp"
      }
    },
    {
      "remove": {
        "field": "timestamp"
      }
    },
    {
      "set": {
        "field": "event.kind",
        "value": "event"
      }
    },
    {
      "set": {
        "field": "event.category",
        "value": "{{#if error}}['host','process']{{/if}}",
        "if": "ctx.error != null"
      }
    },
    {
      "script": {
        "lang": "painless",
        "source": """
          if (ctx.level == 'error' || ctx.level == 'fatal') {
            ctx.event.outcome = 'failure';
          } else {
            ctx.event.outcome = 'success';
          }
        """
      }
    }
  ]
}
```

## Section 7: Grafana Loki Sink

Loki is the preferred log aggregation backend in Kubernetes environments running Prometheus+Grafana stacks. It indexes only log labels, not the full log body, making it highly cost-efficient.

### 7.1 Fluent Bit Loki Output

```yaml
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info
        Daemon        off
        Parsers_File  parsers.conf

    [INPUT]
        Name              tail
        Path              /var/log/containers/*.log
        Parser            docker
        Tag               kube.*
        Refresh_Interval  5
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On

    [FILTER]
        Name                kubernetes
        Match               kube.*
        Kube_URL            https://kubernetes.default.svc:443
        Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
        Merge_Log           On
        Merge_Log_Key       log_processed
        Keep_Log            Off
        K8S-Logging.Parser  On

    [FILTER]
        # Parse the inner JSON log from Go services
        Name   parser
        Match  kube.*
        Key_Name log_processed
        Parser json_log
        Reserve_Data On

    [OUTPUT]
        Name             loki
        Match            kube.*
        Host             loki.monitoring.svc.cluster.local
        Port             3100
        Labels           job=go-services, namespace=$kubernetes['namespace_name'], pod=$kubernetes['pod_name'], service=$service, level=$level
        Label_Keys       $trace_id,$request_id
        Batch_Wait       1s
        Batch_Size       1048576
        Line_Format      json
        Remove_Keys      kubernetes,stream

  parsers.conf: |
    [PARSER]
        Name        docker
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L
        Time_Keep   On

    [PARSER]
        Name        json_log
        Format      json
        Time_Key    timestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%LZ
```

### 7.2 Querying Logs in Grafana

With trace IDs in logs and Loki labels, you can:
- Click on a trace in Tempo to see correlated logs
- Query all errors for a user: `{service="payment-service"} | json | level="error" | user_id="user-12345"`
- Correlate a slow request with database logs: `{namespace="production"} | json | trace_id="0192..."`

## Section 8: Log Aggregation Patterns for High-Volume Services

### 8.1 Async Logging with buffered writer

```go
// observability/asynclog/asynclog.go
package asynclog

import (
	"bufio"
	"io"
	"os"
)

// BufferedWriter wraps os.Stdout with buffering to reduce I/O syscalls.
// Critical for services logging >10,000 lines/second.
type BufferedWriter struct {
	w *bufio.Writer
}

// NewBufferedStdout creates a buffered stdout writer.
// Flush interval is handled by periodic flushes in the background.
func NewBufferedStdout(bufferSize int) *BufferedWriter {
	return &BufferedWriter{
		w: bufio.NewWriterSize(os.Stdout, bufferSize),
	}
}

func (b *BufferedWriter) Write(p []byte) (int, error) {
	return b.w.Write(p)
}

func (b *BufferedWriter) Sync() error {
	return b.w.Flush()
}

// WrapWithBuffer wraps any io.Writer with buffering.
func WrapWithBuffer(w io.Writer, size int) *bufio.Writer {
	return bufio.NewWriterSize(w, size)
}
```

### 8.2 Log Rotation for File Sinks

```go
// Using lumberjack for log file rotation
import "gopkg.in/natefinish/lumberjack.v2"

rotatingWriter := &lumberjack.Logger{
    Filename:   "/var/log/myservice/service.log",
    MaxSize:    100,   // MB per file
    MaxBackups: 7,     // Keep 7 old files
    MaxAge:     14,    // Keep files for 14 days
    Compress:   true,  // Gzip old files
}

// Use as a zap sink
core := zapcore.NewCore(
    zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig()),
    zapcore.AddSync(rotatingWriter),
    zap.InfoLevel,
)
```

## Section 9: Complete Production Logger Setup

```go
// cmd/server/main.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/support-tools/example/observability/logger"
	"github.com/support-tools/example/observability/loglevel"
	"github.com/support-tools/example/observability/sampling"
	"github.com/support-tools/example/observability/slogctx"
)

func main() {
	// --- zap setup ---
	atom := zap.NewAtomicLevelAt(zapcore.InfoLevel)

	zapLogger, err := logger.New(logger.Config{
		Level:       "info",
		Environment: os.Getenv("ENVIRONMENT"),
		ServiceName: "payment-service",
		Version:     os.Getenv("VERSION"),
	})
	if err != nil {
		panic("failed to create logger: " + err.Error())
	}
	defer zapLogger.Sync()

	// Replace the global logger
	zap.ReplaceGlobals(zapLogger)

	// High-frequency events use sampled logger
	sampledLogger := sampling.NewSampledLogger(zapLogger, time.Second, 100, 100)
	_ = sampledLogger

	// --- slog setup (for Go 1.21+ compatibility) ---
	slogHandler := slogctx.NewContextHandler(
		slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
			Level: slog.LevelInfo,
			ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
				if a.Key == slog.TimeKey {
					a.Key = "timestamp"
				}
				return a
			},
		}),
	)
	slogLogger := slog.New(slogHandler)
	slog.SetDefault(slogLogger)

	// --- Admin endpoint for dynamic level changes ---
	adminMux := http.NewServeMux()
	adminMux.Handle("/admin/loglevel", loglevel.Handler(atom))
	go func() {
		http.ListenAndServe(":9000", adminMux)
	}()

	// --- Application startup log ---
	ctx := context.Background()
	ctx = slogctx.WithRequestID(ctx, "startup")

	slog.InfoContext(ctx, "service starting",
		slog.String("service", "payment-service"),
		slog.String("version", os.Getenv("VERSION")),
		slog.String("environment", os.Getenv("ENVIRONMENT")),
	)

	zapLogger.Info("zap logger initialized",
		zap.String("level", atom.String()),
	)

	// Start your HTTP/gRPC server here...
	select {}
}
```

## Section 10: Choosing Between slog and zap

| Criteria | slog (stdlib) | zap |
|---|---|---|
| Allocation overhead | Low-moderate | Minimal (zero-alloc on hot path) |
| Throughput | ~500K lines/sec | ~5M lines/sec |
| API stability | Stable (stdlib) | Stable (1.x) |
| Handler ecosystem | Growing | Extensive (Elasticsearch, Loki, etc.) |
| Context integration | Native (InfoContext) | Requires wrapper |
| Sampling | External package needed | Built-in sampler |
| Dynamic level change | External mechanism needed | AtomicLevel built-in |
| Structured typing | Attr types | Field types |

**Choose slog** when: you want zero external dependencies, you're writing a library (use slog so users can plug in their preferred backend), or your throughput is under 500K log entries/second.

**Choose zap** when: you need maximum throughput (>500K/sec), you need the built-in sampler for high-frequency events, or you're already using the Uber Go ecosystem.

Both choices are correct for production Go services. The most important thing is consistency within a service and proper context propagation regardless of which library you use.

## Summary

Production Go observability requires four things working together:

1. **Structured JSON output** with consistent field names across all services.
2. **Context propagation** — trace IDs, request IDs, and user IDs automatically attached to every log entry.
3. **Sampling** for high-frequency events to prevent log backend saturation without losing signal.
4. **Dynamic level control** so operators can enable debug logging during incidents without restarting services.

With `slog` or `zap`, these capabilities are available with fewer than 200 lines of setup code. The payoff is that every log entry in Loki or Elasticsearch links directly to a distributed trace in Tempo or Jaeger, cutting mean time to diagnosis from hours to minutes.
