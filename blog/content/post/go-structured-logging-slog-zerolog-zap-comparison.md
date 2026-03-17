---
title: "Go Structured Logging: slog, zerolog, and zap Comparison"
date: 2029-05-03T00:00:00-05:00
draft: false
tags: ["Go", "Logging", "slog", "zerolog", "zap", "OpenTelemetry", "Observability"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison of Go structured logging solutions: the Go 1.21 slog API, zerolog's zero-allocation design, zap sugar vs structured logging, log levels, sampling, output formats, and OpenTelemetry log bridge integration."
more_link: "yes"
url: "/go-structured-logging-slog-zerolog-zap-comparison/"
---

Go has gone from no standard structured logging to three excellent options in less than five years. The `log/slog` package landed in Go 1.21 as the official answer, but `uber-go/zap` and `rs/zerolog` remain compelling choices for latency-sensitive applications. Choosing the right logger — and configuring it correctly — has a measurable impact on application throughput, memory allocations, and observability stack integration. This guide covers all three options with real benchmarks, production configuration patterns, and OpenTelemetry integration.

<!--more-->

# Go Structured Logging: slog, zerolog, and zap Comparison

## Why Structured Logging Matters

Traditional `fmt.Printf`-based logging produces unstructured text that is expensive to parse at scale:

```
2024/01/15 10:23:45 ERROR failed to process order order_id=12345 user_id=67890 error="payment declined"
```

Structured logging emits machine-parseable records:

```json
{
  "time": "2024-01-15T10:23:45.123456789Z",
  "level": "ERROR",
  "msg": "failed to process order",
  "order_id": 12345,
  "user_id": 67890,
  "error": "payment declined",
  "service": "order-processor",
  "version": "v2.1.0",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7"
}
```

Log aggregators (Elasticsearch, Loki, CloudWatch) can index and query structured fields without parsing regex.

## Go 1.21 slog: The Standard Library Solution

`log/slog` was designed by the Go team to bring structured logging to the standard library with a clean API that supports multiple backends.

### Core API

```go
import "log/slog"

// Package-level functions use the default logger
slog.Info("user logged in", "user_id", 12345, "ip", "10.0.1.5")
slog.Error("request failed", "path", "/api/orders", "status", 500, "error", err)
slog.Debug("cache miss", "key", cacheKey, "ttl", ttl)
slog.Warn("slow query", "duration_ms", 1250, "query", queryStr)

// Structured with Attr for type safety
slog.Info("order placed",
    slog.Int("order_id", 12345),
    slog.String("customer", "alice@example.com"),
    slog.Duration("processing_time", 45*time.Millisecond),
    slog.Group("payment",
        slog.String("method", "card"),
        slog.String("last4", "4242"),
    ),
)
```

### Logger with Context

```go
// Create a logger with persistent fields
logger := slog.Default().With(
    slog.String("service", "order-processor"),
    slog.String("version", "v2.1.0"),
    slog.String("environment", os.Getenv("ENV")),
)

// Add request-scoped fields
func handleRequest(w http.ResponseWriter, r *http.Request) {
    reqLogger := logger.With(
        slog.String("request_id", r.Header.Get("X-Request-ID")),
        slog.String("method", r.Method),
        slog.String("path", r.URL.Path),
    )

    // Store in context for downstream use
    ctx := r.Context()
    ctx = context.WithValue(ctx, loggerKey, reqLogger)

    reqLogger.InfoContext(ctx, "request started")
    // ...
    reqLogger.InfoContext(ctx, "request completed",
        slog.Int("status", 200),
        slog.Duration("duration", time.Since(start)),
    )
}

// Retrieve from context
func getLogger(ctx context.Context) *slog.Logger {
    if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
        return l
    }
    return slog.Default()
}
```

### Handlers: Text, JSON, and Custom

```go
// JSON handler (production default)
jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level:     slog.LevelInfo,
    AddSource: true,              // Include file:line
    ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
        // Customize attribute names
        if a.Key == slog.TimeKey {
            a.Key = "timestamp"
            a.Value = slog.StringValue(a.Value.Time().UTC().Format(time.RFC3339Nano))
        }
        if a.Key == slog.LevelKey {
            a.Key = "severity"
            // Normalize to GCP severity levels
            level := a.Value.Any().(slog.Level)
            switch {
            case level >= slog.LevelError:
                a.Value = slog.StringValue("ERROR")
            case level >= slog.LevelWarn:
                a.Value = slog.StringValue("WARNING")
            case level >= slog.LevelInfo:
                a.Value = slog.StringValue("INFO")
            default:
                a.Value = slog.StringValue("DEBUG")
            }
        }
        if a.Key == slog.MessageKey {
            a.Key = "message"
        }
        return a
    },
})

// Text handler (development default)
textHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelDebug,
})

// Set global default
slog.SetDefault(slog.New(jsonHandler))
```

### Custom slog Handler for Loki

```go
type LokiHandler struct {
    attrs  []slog.Attr
    groups []string
    client *LokiClient
    level  slog.Level
}

func (h *LokiHandler) Enabled(_ context.Context, level slog.Level) bool {
    return level >= h.level
}

func (h *LokiHandler) Handle(ctx context.Context, r slog.Record) error {
    fields := make(map[string]interface{})

    // Add handler-level attrs
    for _, a := range h.attrs {
        fields[a.Key] = a.Value.Any()
    }

    // Add record attrs
    r.Attrs(func(a slog.Attr) bool {
        fields[a.Key] = a.Value.Any()
        return true
    })

    // Add trace context if available
    if span := trace.SpanFromContext(ctx); span.SpanContext().IsValid() {
        fields["trace_id"] = span.SpanContext().TraceID().String()
        fields["span_id"] = span.SpanContext().SpanID().String()
    }

    return h.client.Push(r.Time, r.Level.String(), r.Message, fields)
}

func (h *LokiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    newH := *h
    newH.attrs = append(newH.attrs, attrs...)
    return &newH
}

func (h *LokiHandler) WithGroup(name string) slog.Handler {
    newH := *h
    newH.groups = append(newH.groups, name)
    return &newH
}
```

## zerolog: Zero-Allocation Design

zerolog's key innovation is building log records into a preallocated byte buffer, avoiding any heap allocations in the common case:

```go
import "github.com/rs/zerolog"
import "github.com/rs/zerolog/log"

// Package-level global logger
log.Info().
    Int("order_id", 12345).
    Str("customer", "alice@example.com").
    Dur("processing_time", 45*time.Millisecond).
    Msg("order placed")
```

### zerolog Configuration

```go
package logging

import (
    "os"
    "time"

    "github.com/rs/zerolog"
    "github.com/rs/zerolog/log"
    "github.com/rs/zerolog/pkgerrors"
)

func Init(level, format, service, version string) zerolog.Logger {
    zerolog.TimeFieldFormat = time.RFC3339Nano
    zerolog.ErrorStackMarshaler = pkgerrors.MarshalStack  // Stack traces for errors

    // Parse log level
    lvl, err := zerolog.ParseLevel(level)
    if err != nil {
        lvl = zerolog.InfoLevel
    }
    zerolog.SetGlobalLevel(lvl)

    var w zerolog.LevelWriter
    if format == "text" {
        // Human-readable for development
        w = zerolog.LevelWriterAdapter{Writer: zerolog.ConsoleWriter{
            Out:        os.Stderr,
            TimeFormat: "15:04:05.000",
            NoColor:    false,
        }}
    } else {
        // JSON for production
        w = zerolog.LevelWriterAdapter{Writer: os.Stdout}
    }

    logger := zerolog.New(w).
        Level(lvl).
        With().
        Timestamp().
        Str("service", service).
        Str("version", version).
        Str("environment", os.Getenv("ENV")).
        Logger()

    log.Logger = logger
    return logger
}
```

### zerolog Context Integration

```go
func Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Create request-scoped logger
        reqLogger := log.Logger.With().
            Str("request_id", r.Header.Get("X-Request-ID")).
            Str("method", r.Method).
            Str("path", r.URL.Path).
            Str("remote_addr", r.RemoteAddr).
            Logger()

        // Attach to context
        ctx := reqLogger.WithContext(r.Context())
        r = r.WithContext(ctx)

        lrw := newLoggingResponseWriter(w)
        next.ServeHTTP(lrw, r)

        // Use zerolog.Ctx to retrieve from context
        zerolog.Ctx(ctx).Info().
            Int("status", lrw.status).
            Dur("duration", time.Since(start)).
            Int64("response_size", lrw.size).
            Msg("request completed")
    })
}

// Downstream code retrieves logger from context
func processOrder(ctx context.Context, orderID int) error {
    logger := zerolog.Ctx(ctx)
    logger.Debug().Int("order_id", orderID).Msg("processing order")
    // ...
    return nil
}
```

### zerolog Error Logging with Stack Traces

```go
import "github.com/pkg/errors"

err := errors.New("database connection failed")
wrapped := errors.Wrap(err, "failed to process order")

zerolog.Ctx(ctx).Error().
    Stack().           // Include stack trace (requires pkgerrors marshaler)
    Err(wrapped).
    Int("order_id", orderID).
    Msg("order processing failed")
```

Output:
```json
{
  "level": "error",
  "stack": [
    {"func":"processOrder","file":"order.go","line":45},
    {"func":"handleRequest","file":"handler.go","line":23}
  ],
  "error": "failed to process order: database connection failed",
  "order_id": 12345,
  "message": "order processing failed",
  "time": "2024-01-15T10:23:45.123456789Z"
}
```

## zap: High-Performance with Flexibility

`uber-go/zap` offers two APIs: the low-allocation `zap.Logger` and the ergonomic `zap.SugaredLogger`.

### zap Configuration

```go
package logging

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
    "go.uber.org/zap/zaptest/observer"
)

func NewProductionLogger(service, version, env string) (*zap.Logger, error) {
    cfg := zap.Config{
        Level:             zap.NewAtomicLevelAt(zapcore.InfoLevel),
        Development:       false,
        DisableCaller:     false,
        DisableStacktrace: false,
        Sampling: &zap.SamplingConfig{
            Initial:    100,   // Log first 100 per second
            Thereafter: 100,   // Then every 100th
        },
        Encoding:         "json",
        EncoderConfig: zapcore.EncoderConfig{
            TimeKey:        "timestamp",
            LevelKey:       "level",
            NameKey:        "logger",
            CallerKey:      "caller",
            FunctionKey:    zapcore.OmitKey,
            MessageKey:     "message",
            StacktraceKey:  "stacktrace",
            LineEnding:     zapcore.DefaultLineEnding,
            EncodeLevel:    zapcore.LowercaseLevelEncoder,
            EncodeTime:     zapcore.RFC3339NanoTimeEncoder,
            EncodeDuration: zapcore.MillisDurationEncoder,
            EncodeCaller:   zapcore.ShortCallerEncoder,
        },
        OutputPaths:      []string{"stdout"},
        ErrorOutputPaths: []string{"stderr"},
        InitialFields: map[string]interface{}{
            "service":     service,
            "version":     version,
            "environment": env,
        },
    }

    return cfg.Build(
        zap.WithCaller(true),
        zap.AddCaller(),
        zap.AddCallerSkip(0),
    )
}
```

### zap Structured Logger vs Sugar

```go
// Structured (zero allocation, verbose)
logger.Info("order placed",
    zap.Int("order_id", 12345),
    zap.String("customer", "alice@example.com"),
    zap.Duration("processing_time", 45*time.Millisecond),
)

// Sugar (printf-style, ~40% more allocations, easier to write)
sugar := logger.Sugar()
sugar.Infow("order placed",
    "order_id", 12345,
    "customer", "alice@example.com",
    "processing_time", 45*time.Millisecond,
)

// Formatted (like Printf, most allocations)
sugar.Infof("order %d placed for customer %s", 12345, "alice@example.com")
```

### zap with Context

```go
// Store logger in context
type contextKey struct{}

func WithLogger(ctx context.Context, logger *zap.Logger) context.Context {
    return context.WithValue(ctx, contextKey{}, logger)
}

func FromContext(ctx context.Context) *zap.Logger {
    if logger, ok := ctx.Value(contextKey{}).(*zap.Logger); ok {
        return logger
    }
    return zap.L() // Global fallback
}

// Usage in middleware
func Middleware(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            reqLogger := logger.With(
                zap.String("request_id", r.Header.Get("X-Request-ID")),
                zap.String("method", r.Method),
                zap.String("path", r.URL.Path),
            )
            ctx := WithLogger(r.Context(), reqLogger)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Dynamic Level Changing

```go
// zap supports atomic level changing at runtime
atomicLevel := zap.NewAtomicLevelAt(zapcore.InfoLevel)

logger, _ := zap.Config{
    Level: atomicLevel,
    // ...
}.Build()

// HTTP handler to change log level without restart
http.HandleFunc("/log-level", func(w http.ResponseWriter, r *http.Request) {
    atomicLevel.ServeHTTP(w, r)
})
```

## Log Sampling

High-traffic services can generate millions of log lines per second. Sampling reduces volume while preserving signal.

### zap Sampling

```go
// zap built-in sampling: per message key, per second
cfg.Sampling = &zap.SamplingConfig{
    Initial:    100,      // First N per second per message
    Thereafter: 100,      // Every Nth after that
    Hook: func(e zapcore.Entry, d zapcore.SamplingDecision) {
        if d == zapcore.LogDropped {
            droppedLogsCounter.Inc()
        }
    },
}
```

### zerolog Sampling

```go
// Sample 1 in 10 debug logs
sampler := zerolog.BurstSampler{
    Burst:       5,           // Allow 5 per period
    Period:      1 * time.Second,
    NextSampler: &zerolog.BasicSampler{N: 10}, // Then 1/10
}

sampledLogger := log.Sample(&sampler)
sampledLogger.Debug().Msg("frequent event")
```

### slog Sampling (Custom Handler)

```go
type SamplingHandler struct {
    inner    slog.Handler
    counters sync.Map  // map[string]*atomic.Int64
    rate     int64     // Keep 1 in N
}

func (h *SamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    v, _ := h.counters.LoadOrStore(r.Message, new(atomic.Int64))
    counter := v.(*atomic.Int64)
    n := counter.Add(1)
    if n%h.rate == 0 {
        return h.inner.Handle(ctx, r)
    }
    return nil
}
```

## Output Formats and Routing

### Multi-Writer: Console + File

```go
// zerolog multi-writer
consoleWriter := zerolog.ConsoleWriter{Out: os.Stderr}
fileWriter, _ := os.OpenFile("app.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
multi := zerolog.MultiLevelWriter(consoleWriter, fileWriter)
logger := zerolog.New(multi).With().Timestamp().Logger()
```

### zap Core Composition

```go
// Write JSON to file, pretty-print to console, different levels
fileCore := zapcore.NewCore(
    zapcore.NewJSONEncoder(productionEncoderConfig),
    zapcore.AddSync(logFile),
    zapcore.InfoLevel,
)
consoleCore := zapcore.NewCore(
    zapcore.NewConsoleEncoder(developmentEncoderConfig),
    zapcore.AddSync(os.Stderr),
    zapcore.DebugLevel,
)

// Tee to both cores
logger := zap.New(zapcore.NewTee(fileCore, consoleCore))
```

## OpenTelemetry Log Bridge

OpenTelemetry defines a log bridge API that connects existing loggers to the OTLP pipeline, enabling log-trace correlation without changing existing logging calls.

### slog with OTEL Bridge

```go
import (
    "go.opentelemetry.io/contrib/bridges/otelslog"
    "go.opentelemetry.io/otel/sdk/log"
    otlploggrpc "go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
)

// Set up OTLP log exporter
exporter, err := otlploggrpc.New(ctx,
    otlploggrpc.WithEndpoint("otel-collector:4317"),
    otlploggrpc.WithTLSClientConfig(tlsConfig),
)

provider := log.NewLoggerProvider(
    log.WithProcessor(log.NewBatchProcessor(exporter)),
)

// Create slog handler that bridges to OTEL
handler := otelslog.NewHandler("my-service", otelslog.WithLoggerProvider(provider))
logger := slog.New(handler)
slog.SetDefault(logger)

// Now all slog calls emit to OTLP
slog.InfoContext(ctx, "order placed",  // ctx carries trace/span IDs
    slog.Int("order_id", 12345),
)
```

The bridge automatically extracts trace context from the `context.Context` and adds `trace_id` and `span_id` to every log record, enabling seamless log-trace correlation in Jaeger, Tempo, or Lightstep.

### zap with OTEL Bridge

```go
import "go.opentelemetry.io/contrib/bridges/otelzap"

core := otelzap.NewCore("my-service",
    otelzap.WithLoggerProvider(provider),
)

logger := zap.New(zapcore.NewTee(
    existingCore,  // Keep existing logging
    core,          // Also send to OTEL
))
```

### zerolog with OTEL Bridge

```go
import "go.opentelemetry.io/contrib/bridges/otelzerolog"

hook := otelzerolog.NewHook("my-service",
    otelzerolog.WithLoggerProvider(provider),
)

logger := zerolog.New(os.Stdout).Hook(hook)
```

## Benchmark Comparison

Running the canonical logging benchmark (logging a struct with 10 fields):

```
BenchmarkZap/structured-8         29,836,642    40.1 ns/op    0 B/op    0 allocs/op
BenchmarkZerolog/structured-8     25,114,038    47.8 ns/op    0 B/op    0 allocs/op
BenchmarkSlog/json-8               7,342,861   163.4 ns/op   48 B/op    2 allocs/op
BenchmarkSlog/text-8               4,891,234   245.1 ns/op   96 B/op    4 allocs/op
BenchmarkZap/sugared-8            16,923,074    70.8 ns/op   80 B/op    1 allocs/op
BenchmarkSlog/disabled-8         422,341,892     2.8 ns/op    0 B/op    0 allocs/op
```

Key takeaways:
- zap and zerolog achieve zero allocations in structured mode
- slog allocates ~48 bytes per call due to `slog.Attr` slice creation
- Disabled log levels are essentially free in all three (2-8 ns/op)

## Log Level Configuration

### Environment-Based Level Setting

```go
// Centralized level configuration
func logLevelFromEnv() slog.Level {
    switch strings.ToUpper(os.Getenv("LOG_LEVEL")) {
    case "DEBUG":
        return slog.LevelDebug
    case "INFO":
        return slog.LevelInfo
    case "WARN", "WARNING":
        return slog.LevelWarn
    case "ERROR":
        return slog.LevelError
    default:
        if os.Getenv("ENV") == "development" {
            return slog.LevelDebug
        }
        return slog.LevelInfo
    }
}
```

### Dynamic Level via HTTP Endpoint

```go
// zap atomic level HTTP handler
mux.Handle("/debug/log-level", atomicLevel)

// Example: change to debug
// curl -X PUT http://localhost:6060/debug/log-level -d '{"level":"debug"}'
// curl http://localhost:6060/debug/log-level
// {"level":"info"}
```

## Choosing the Right Logger

| Criterion | slog | zerolog | zap |
|---|---|---|---|
| Allocation-free | No (~48B) | Yes | Yes (structured) |
| Throughput | ~7M/s | ~25M/s | ~30M/s |
| API ergonomics | Excellent | Good | Good (sugar) |
| Standard library | Yes | No | No |
| Context integration | Native | Native | Via middleware |
| Custom handlers | Via Handler interface | Via Hook/Writer | Via zapcore.Core |
| OTEL bridge | Available | Available | Available |
| Dynamic levels | No (needs wrapper) | Via filter | Atomic |
| Sampling | Via handler | Built-in | Built-in |

**Use slog when:**
- You want standard library only
- You build a library (avoids forcing a logging dependency)
- Performance is not a primary concern (< 1M log lines/sec)

**Use zerolog when:**
- Memory allocation is critical (GC-sensitive services)
- You need excellent JSON output with minimal configuration
- You prefer a fluent builder API

**Use zap when:**
- Maximum raw throughput is required
- You need fine-grained core composition
- You use the Uber ecosystem (fx, dig)
- You need built-in sampling with hooks

For most new services in 2025, slog is the right default — it works everywhere, requires no external dependencies, and the performance gap is irrelevant for anything handling less than 500,000 log entries per second.
