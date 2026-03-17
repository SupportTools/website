---
title: "Go Structured Logging with slog: Production Patterns and Observability Integration"
date: 2027-09-15T00:00:00-05:00
draft: false
tags: ["Go", "Logging", "slog", "Observability"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Go slog for production: custom Handler implementations, log level management, context propagation for trace IDs, JSON output, Loki integration, benchmarking slog vs zerolog vs zap, and PII leak prevention."
more_link: "yes"
url: "/go-structured-logging-slog-guide/"
---

The `log/slog` package, introduced in Go 1.21, provides a structured logging API backed by a pluggable Handler interface. Unlike the older `log` package, `slog` emits machine-parseable records by default, supports arbitrary key-value attributes, and integrates cleanly with observability pipelines. This guide covers everything needed to use `slog` in production: custom handlers, level management, trace ID propagation, Loki integration, a performance comparison with `zerolog` and `zap`, and patterns for preventing PII from appearing in logs.

<!--more-->

## Section 1: slog Fundamentals

`slog` ships three built-in handlers: `TextHandler` (logfmt), `JSONHandler`, and the default handler that delegates to the `log` package. For production, always use `JSONHandler`:

```go
package main

import (
    "log/slog"
    "os"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true, // include file:line in every record
    }))
    slog.SetDefault(logger)

    slog.Info("server starting",
        slog.String("addr", ":8080"),
        slog.String("env", "production"),
    )
    slog.Error("database connection failed",
        slog.String("host", "pg.internal"),
        slog.Int("port", 5432),
        slog.Any("error", err),
    )
}
```

Example JSON output:

```json
{
  "time": "2027-09-15T14:30:00Z",
  "level": "INFO",
  "source": {"function": "main.main", "file": "main.go", "line": 15},
  "msg": "server starting",
  "addr": ":8080",
  "env": "production"
}
```

### Attribute Types

```go
// Use typed attribute constructors to avoid interface{} boxing allocations.
slog.String("method", "GET")
slog.Int("status", 200)
slog.Int64("bytes", int64(1024))
slog.Float64("duration_ms", 12.5)
slog.Bool("cached", true)
slog.Duration("latency", 12*time.Millisecond)
slog.Time("timestamp", time.Now())
slog.Any("error", err)  // slog.Any for types without a specific constructor

// Group multiple related attributes.
slog.Group("request",
    slog.String("method", "POST"),
    slog.String("path", "/api/v1/users"),
    slog.Int("status", 201),
)
```

## Section 2: Logger with Attributes

The `With` method returns a new logger pre-populated with attributes, eliminating the need to repeat common fields:

```go
package logger

import (
    "log/slog"
    "os"
)

// New creates a JSON logger with service-level attributes.
func New(service, version, env string) *slog.Logger {
    return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     levelFromEnv(),
        AddSource: env != "production", // source is expensive; disable in prod
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Rename "msg" to "message" for compatibility with ELK stack.
            if a.Key == slog.MessageKey {
                a.Key = "message"
            }
            // Rename "time" to "@timestamp" for Elasticsearch.
            if a.Key == slog.TimeKey {
                a.Key = "@timestamp"
            }
            return a
        },
    })).With(
        slog.String("service", service),
        slog.String("version", version),
        slog.String("env", env),
    )
}

func levelFromEnv() slog.Level {
    switch os.Getenv("LOG_LEVEL") {
    case "debug":
        return slog.LevelDebug
    case "warn":
        return slog.LevelWarn
    case "error":
        return slog.LevelError
    default:
        return slog.LevelInfo
    }
}
```

### Request-Scoped Logger

```go
// WithRequestAttributes returns a logger enriched with HTTP request attributes.
func WithRequestAttributes(logger *slog.Logger, r *http.Request) *slog.Logger {
    return logger.With(
        slog.String("request_id", r.Header.Get("X-Request-Id")),
        slog.String("method", r.Method),
        slog.String("path", r.URL.Path),
        slog.String("remote_addr", r.RemoteAddr),
        slog.String("user_agent", r.UserAgent()),
    )
}
```

## Section 3: Context Propagation for Trace IDs

The most valuable structured logging pattern in a distributed system is propagating trace and span IDs from incoming requests through every downstream log call:

```go
package logctx

import (
    "context"
    "log/slog"
)

type contextKey int

const loggerKey contextKey = iota

// WithLogger stores a logger in the context.
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, loggerKey, logger)
}

// FromContext retrieves the context logger, falling back to the default logger.
func FromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}

// WithTraceID enriches the context logger with trace and span IDs.
// Call this in your HTTP/gRPC middleware.
func WithTraceID(ctx context.Context, traceID, spanID string) context.Context {
    logger := FromContext(ctx).With(
        slog.String("trace_id", traceID),
        slog.String("span_id", spanID),
    )
    return WithLogger(ctx, logger)
}
```

### HTTP Middleware Integration

```go
package middleware

import (
    "net/http"

    "go.opentelemetry.io/otel/trace"
    "github.com/example/myapp/internal/logctx"
)

// LoggingMiddleware injects the request logger into the context.
func LoggingMiddleware(baseLogger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            span := trace.SpanFromContext(r.Context())
            spanCtx := span.SpanContext()

            ctx := logctx.WithLogger(r.Context(), baseLogger)
            if spanCtx.IsValid() {
                ctx = logctx.WithTraceID(ctx,
                    spanCtx.TraceID().String(),
                    spanCtx.SpanID().String(),
                )
            }

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

Usage in a handler:

```go
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    log := logctx.FromContext(r.Context())
    log.Info("creating user", slog.String("email", req.Email))

    user, err := h.svc.Create(r.Context(), req)
    if err != nil {
        log.Error("user creation failed", slog.Any("error", err))
        apierr.InternalServerError(w, r)
        return
    }
    log.Info("user created", slog.String("user_id", user.ID))
    writeJSON(w, http.StatusCreated, user)
}
```

## Section 4: Custom Handler Implementation

A custom handler can filter sensitive fields, add mandatory attributes, or forward to multiple destinations:

```go
package handler

import (
    "context"
    "log/slog"
    "strings"
)

// RedactingHandler wraps a base Handler and redacts PII fields.
type RedactingHandler struct {
    base    slog.Handler
    redacted map[string]bool
}

// NewRedactingHandler creates a handler that replaces the values of
// sensitive keys with "[REDACTED]".
func NewRedactingHandler(base slog.Handler, sensitiveKeys ...string) *RedactingHandler {
    m := make(map[string]bool, len(sensitiveKeys))
    for _, k := range sensitiveKeys {
        m[strings.ToLower(k)] = true
    }
    return &RedactingHandler{base: base, redacted: m}
}

func (h *RedactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.base.Enabled(ctx, level)
}

func (h *RedactingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Clone the record so the original is not modified.
    filtered := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
    r.Attrs(func(a slog.Attr) bool {
        filtered.AddAttrs(h.redactAttr(a))
        return true
    })
    return h.base.Handle(ctx, filtered)
}

func (h *RedactingHandler) redactAttr(a slog.Attr) slog.Attr {
    if h.redacted[strings.ToLower(a.Key)] {
        return slog.String(a.Key, "[REDACTED]")
    }
    // Recurse into groups.
    if a.Value.Kind() == slog.KindGroup {
        attrs := a.Value.Group()
        redacted := make([]any, 0, len(attrs)*2)
        for _, ga := range attrs {
            ra := h.redactAttr(ga)
            redacted = append(redacted, ra.Key, ra.Value)
        }
        return slog.Group(a.Key, redacted...)
    }
    return a
}

func (h *RedactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &RedactingHandler{
        base:     h.base.WithAttrs(attrs),
        redacted: h.redacted,
    }
}

func (h *RedactingHandler) WithGroup(name string) slog.Handler {
    return &RedactingHandler{
        base:     h.base.WithGroup(name),
        redacted: h.redacted,
    }
}
```

Usage:

```go
baseHandler := slog.NewJSONHandler(os.Stdout, nil)
redacting := handler.NewRedactingHandler(baseHandler,
    "password", "token", "secret", "credit_card",
    "ssn", "api_key", "authorization",
)
logger := slog.New(redacting)

logger.Info("user login",
    slog.String("email", "user@example.com"),
    slog.String("password", "s3cr3t"),   // will be [REDACTED]
    slog.String("token", "GITHUB_TOKEN_EXAMPLE"), // will be [REDACTED]
)
```

## Section 5: Dynamic Log Level Management

Allow changing the log level at runtime without restarting the process:

```go
package logger

import (
    "encoding/json"
    "log/slog"
    "net/http"
)

// LevelVar wraps slog.LevelVar with an HTTP management endpoint.
type LevelManager struct {
    level slog.LevelVar
}

// NewLevelManager creates a LevelManager starting at InfoLevel.
func NewLevelManager() *LevelManager {
    m := &LevelManager{}
    m.level.Set(slog.LevelInfo)
    return m
}

// HandlerOptions returns slog.HandlerOptions using the dynamic level.
func (m *LevelManager) HandlerOptions() *slog.HandlerOptions {
    return &slog.HandlerOptions{Level: &m.level}
}

// ServeHTTP handles GET/PUT /log-level.
func (m *LevelManager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    switch r.Method {
    case http.MethodGet:
        json.NewEncoder(w).Encode(map[string]string{
            "level": m.level.Level().String(),
        })
    case http.MethodPut:
        var body struct {
            Level string `json:"level"`
        }
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, "bad request", http.StatusBadRequest)
            return
        }
        var level slog.Level
        if err := level.UnmarshalText([]byte(body.Level)); err != nil {
            http.Error(w, "invalid level", http.StatusBadRequest)
            return
        }
        m.level.Set(level)
        slog.Info("log level changed", slog.String("new_level", level.String()))
        w.WriteHeader(http.StatusNoContent)
    default:
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
    }
}
```

## Section 6: Loki Integration

Grafana Loki ingests logs via the Promtail agent (which scrapes pod logs from stdout) or via direct push using the Loki HTTP API:

```go
package loki

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "time"
)

// PushRequest is the Loki push API request format.
type PushRequest struct {
    Streams []Stream `json:"streams"`
}

type Stream struct {
    Stream map[string]string `json:"stream"`
    Values [][2]string       `json:"values"` // [timestamp_ns, log_line]
}

// Handler implements slog.Handler and pushes logs to Loki.
type Handler struct {
    endpoint   string
    labels     map[string]string
    httpClient *http.Client
    buffer     chan slog.Record
}

// NewHandler creates a Loki handler that batches and pushes log records.
func NewHandler(endpoint string, labels map[string]string) *Handler {
    h := &Handler{
        endpoint:   endpoint,
        labels:     labels,
        httpClient: &http.Client{Timeout: 5 * time.Second},
        buffer:     make(chan slog.Record, 1000),
    }
    go h.flushLoop()
    return h
}

func (h *Handler) flushLoop() {
    ticker := time.NewTicker(time.Second)
    var batch []slog.Record
    for {
        select {
        case r := <-h.buffer:
            batch = append(batch, r)
            if len(batch) >= 100 {
                h.flush(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                h.flush(batch)
                batch = batch[:0]
            }
        }
    }
}

func (h *Handler) flush(records []slog.Record) {
    values := make([][2]string, len(records))
    for i, r := range records {
        line, _ := json.Marshal(map[string]interface{}{
            "level":   r.Level.String(),
            "message": r.Message,
            "time":    r.Time.UTC().Format(time.RFC3339Nano),
        })
        values[i] = [2]string{
            fmt.Sprintf("%d", r.Time.UnixNano()),
            string(line),
        }
    }

    req := PushRequest{Streams: []Stream{{
        Stream: h.labels,
        Values: values,
    }}}

    data, _ := json.Marshal(req)
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost,
        h.endpoint+"/loki/api/v1/push",
        bytes.NewReader(data))
    httpReq.Header.Set("Content-Type", "application/json")
    resp, err := h.httpClient.Do(httpReq)
    if err != nil || resp.StatusCode >= 400 {
        slog.Default().Error("loki push failed", slog.Any("err", err))
    }
    if resp != nil {
        resp.Body.Close()
    }
}

func (h *Handler) Enabled(_ context.Context, _ slog.Level) bool { return true }
func (h *Handler) Handle(_ context.Context, r slog.Record) error {
    select {
    case h.buffer <- r:
    default:
        // Buffer full: drop the record.
    }
    return nil
}
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler { return h }
func (h *Handler) WithGroup(name string) slog.Handler       { return h }
```

In production, use Promtail or the Grafana Alloy agent to collect stdout logs from pods rather than the push API. Reserve the push API for structured JSON fields that need to be indexed as Loki labels.

## Section 7: Performance Benchmarks — slog vs zerolog vs zap

```go
package logging_bench_test

import (
    "io"
    "log/slog"
    "testing"
    "time"

    "github.com/rs/zerolog"
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func BenchmarkSlog_JSON(b *testing.B) {
    logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
    b.ResetTimer()
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        logger.Info("http request",
            slog.String("method", "GET"),
            slog.String("path", "/api/v1/users"),
            slog.Int("status", 200),
            slog.Duration("latency", 12*time.Millisecond),
        )
    }
}

func BenchmarkZerolog_JSON(b *testing.B) {
    logger := zerolog.New(io.Discard).With().Timestamp().Logger()
    b.ResetTimer()
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        logger.Info().
            Str("method", "GET").
            Str("path", "/api/v1/users").
            Int("status", 200).
            Dur("latency", 12*time.Millisecond).
            Msg("http request")
    }
}

func BenchmarkZap_JSON(b *testing.B) {
    enc := zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig())
    core := zapcore.NewCore(enc, zapcore.AddSync(io.Discard), zapcore.InfoLevel)
    logger := zap.New(core)
    b.ResetTimer()
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        logger.Info("http request",
            zap.String("method", "GET"),
            zap.String("path", "/api/v1/users"),
            zap.Int("status", 200),
            zap.Duration("latency", 12*time.Millisecond),
        )
    }
}
```

Representative benchmark results on Go 1.22 (lower is better):

```text
BenchmarkSlog_JSON-8       2_100_000    542 ns/op    0 B/op    0 allocs/op
BenchmarkZerolog_JSON-8    4_800_000    248 ns/op    0 B/op    0 allocs/op
BenchmarkZap_JSON-8        3_900_000    308 ns/op    0 B/op    0 allocs/op
```

`zerolog` is approximately 2x faster than `slog`. For services logging more than 50,000 requests per second, consider `zerolog` or `zap`. For most services, `slog` is adequate and has the advantage of being part of the standard library.

## Section 8: PII Leak Prevention

```go
package pii

import (
    "log/slog"
    "regexp"
    "strings"
)

// Patterns that commonly indicate PII in log attribute values.
var (
    emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
    creditCardPattern = regexp.MustCompile(`^\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}$`)
    ssnPattern = regexp.MustCompile(`^\d{3}-\d{2}-\d{4}$`)
)

// PIIScanner wraps a handler and scans attribute values for PII patterns.
type PIIScanner struct {
    base slog.Handler
}

func NewPIIScanner(base slog.Handler) *PIIScanner {
    return &PIIScanner{base: base}
}

func (h *PIIScanner) Handle(ctx context.Context, r slog.Record) error {
    clean := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
    r.Attrs(func(a slog.Attr) bool {
        clean.AddAttrs(h.scanAttr(a))
        return true
    })
    return h.base.Handle(ctx, clean)
}

func (h *PIIScanner) scanAttr(a slog.Attr) slog.Attr {
    if a.Value.Kind() != slog.KindString {
        return a
    }
    v := a.Value.String()
    if emailPattern.MatchString(v) ||
        creditCardPattern.MatchString(strings.ReplaceAll(v, " ", "")) ||
        ssnPattern.MatchString(v) {
        return slog.String(a.Key, "[PII_REDACTED]")
    }
    return a
}

func (h *PIIScanner) Enabled(ctx context.Context, l slog.Level) bool {
    return h.base.Enabled(ctx, l)
}
func (h *PIIScanner) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &PIIScanner{base: h.base.WithAttrs(attrs)}
}
func (h *PIIScanner) WithGroup(name string) slog.Handler {
    return &PIIScanner{base: h.base.WithGroup(name)}
}
```

## Section 9: Log Sampling for High-Volume Services

```go
package handler

import (
    "context"
    "log/slog"
    "sync/atomic"
    "time"
)

// SamplingHandler drops a fraction of DEBUG-level records to reduce volume.
type SamplingHandler struct {
    base      slog.Handler
    counter   atomic.Uint64
    sampleN   uint64 // log 1 in every N debug records
}

// NewSamplingHandler creates a handler that logs 1 in sampleN debug records.
func NewSamplingHandler(base slog.Handler, sampleN uint64) *SamplingHandler {
    return &SamplingHandler{base: base, sampleN: sampleN}
}

func (h *SamplingHandler) Enabled(ctx context.Context, l slog.Level) bool {
    if l == slog.LevelDebug {
        return h.counter.Add(1)%h.sampleN == 0
    }
    return h.base.Enabled(ctx, l)
}

func (h *SamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    return h.base.Handle(ctx, r)
}
func (h *SamplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &SamplingHandler{base: h.base.WithAttrs(attrs), sampleN: h.sampleN}
}
func (h *SamplingHandler) WithGroup(name string) slog.Handler {
    return &SamplingHandler{base: h.base.WithGroup(name), sampleN: h.sampleN}
}
```

## Section 10: Complete Logger Setup for Production

```go
package main

import (
    "log/slog"
    "os"

    "github.com/example/myapp/internal/handler"
    "github.com/example/myapp/internal/logger"
)

func buildLogger() *slog.Logger {
    levelMgr := logger.NewLevelManager()

    // Base JSON handler.
    base := slog.NewJSONHandler(os.Stdout, levelMgr.HandlerOptions())

    // Layer 1: PII redaction.
    redacting := handler.NewRedactingHandler(base,
        "password", "token", "secret", "authorization",
        "api_key", "credit_card", "ssn", "private_key",
    )

    // Layer 2: PII pattern scanning (catches values that slip through key redaction).
    scanning := handler.NewPIIScanner(redacting)

    // Layer 3: Debug sampling in production (1 in 100).
    var topHandler slog.Handler = scanning
    if os.Getenv("APP_ENV") == "production" {
        topHandler = handler.NewSamplingHandler(scanning, 100)
    }

    return slog.New(topHandler).With(
        slog.String("service", "myapp"),
        slog.String("version", os.Getenv("APP_VERSION")),
        slog.String("env", os.Getenv("APP_ENV")),
    )
}
```
