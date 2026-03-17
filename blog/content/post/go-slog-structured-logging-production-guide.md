---
title: "Go slog: Structured Logging for Production Services"
date: 2028-11-23T00:00:00-05:00
draft: false
tags: ["Go", "Logging", "slog", "Observability", "Production"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Go's slog package for production services: custom handlers, context propagation, request middleware, log sampling, OpenTelemetry trace correlation, and migrating from logrus and zap."
more_link: "yes"
url: "/go-slog-structured-logging-production-guide/"
---

Go 1.21 introduced `log/slog`, the standard library's structured logging package. After years of fragmentation across logrus, zap, zerolog, and apex/log, Go finally has a first-class structured logging API. The slog package is fast, extensible via the Handler interface, and integrates naturally with context propagation - the key capability that most logging libraries bolt on awkwardly.

This guide covers everything needed to run slog in a production service: JSON output, log levels, context attributes, custom handlers, HTTP middleware, log sampling, OpenTelemetry correlation, and migrating from existing loggers.

<!--more-->

# Go slog: Structured Logging for Production Services

## slog Design Fundamentals

The slog package has three core concepts:

- **Logger**: The user-facing API (`slog.Info`, `logger.With`, etc.)
- **Handler**: The backend that formats and writes log records
- **LogValuer**: An interface for values that produce their own structured representation

The standard library provides two handlers: `TextHandler` (logfmt format) and `JSONHandler`. Production services almost always use `JSONHandler` so log aggregation systems (Loki, Elasticsearch, Splunk) can parse fields directly.

### Basic Usage

```go
package main

import (
    "log/slog"
    "os"
)

func main() {
    // Configure JSON handler for production
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
        // AddSource adds file:line to every log record
        AddSource: true,
    }))

    // Set as default logger
    slog.SetDefault(logger)

    // Structured logging with key-value pairs
    slog.Info("server started",
        slog.String("addr", ":8080"),
        slog.String("env", "production"),
        slog.Int("pid", os.Getpid()),
    )

    // With computed values
    slog.Info("request completed",
        slog.String("method", "GET"),
        slog.String("path", "/api/users"),
        slog.Int("status", 200),
        slog.Duration("latency", 42*time.Millisecond),
    )

    // Errors always include the error value
    slog.Error("database connection failed",
        slog.String("host", "db.internal"),
        slog.Any("error", err),
    )
}
```

JSON output:

```json
{"time":"2028-11-23T10:00:00Z","level":"INFO","source":{"function":"main.main","file":"main.go","line":15},"msg":"server started","addr":":8080","env":"production","pid":12345}
{"time":"2028-11-23T10:00:01Z","level":"INFO","source":{"function":"main.main","file":"main.go","line":22},"msg":"request completed","method":"GET","path":"/api/users","status":200,"latency":42000000}
```

## Log Level Management

### Dynamic Level Updates

```go
package logging

import (
    "log/slog"
    "net/http"
    "os"
)

// LevelVar allows runtime level changes without restarting
var LogLevel = new(slog.LevelVar) // default: INFO

func InitLogger() *slog.Logger {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: LogLevel,
    }))
    slog.SetDefault(logger)
    return logger
}

// SetLevelHandler allows changing log level via HTTP
// PUT /debug/log-level with body: "DEBUG" or "INFO" or "WARN" or "ERROR"
func SetLevelHandler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPut {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var level slog.Level
    if err := level.UnmarshalText([]byte(r.FormValue("level"))); err != nil {
        http.Error(w, "invalid level: "+err.Error(), http.StatusBadRequest)
        return
    }

    LogLevel.Set(level)
    slog.Info("log level updated", slog.String("level", level.String()))
    w.WriteHeader(http.StatusOK)
}
```

### Level-Conditional Expensive Operations

```go
// Don't compute expensive attributes if the level is disabled
func handleRequest(logger *slog.Logger, req *http.Request) {
    if logger.Enabled(req.Context(), slog.LevelDebug) {
        // Only compute debug data if DEBUG is enabled
        headers := make(map[string]string)
        for k, v := range req.Header {
            headers[k] = strings.Join(v, ",")
        }
        logger.Debug("request headers", slog.Any("headers", headers))
    }
}
```

## Adding Context Attributes

### Logger.With for Service-Level Fields

```go
package main

import (
    "log/slog"
    "os"
)

func main() {
    // Base logger with service-level fields
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With(
        slog.String("service", "payment-api"),
        slog.String("version", version),
        slog.String("environment", os.Getenv("ENVIRONMENT")),
        slog.String("datacenter", os.Getenv("DATACENTER")),
    )

    // Child logger with component-level fields
    dbLogger := logger.With(slog.String("component", "database"))
    dbLogger.Info("connected to database",
        slog.String("host", "db.payments.internal"),
        slog.Int("pool_size", 20),
    )

    // Request-scoped logger (created per request)
    requestLogger := logger.With(
        slog.String("trace_id", "abc123"),
        slog.String("request_id", "req-456"),
    )
    requestLogger.Info("processing payment",
        slog.String("payment_id", "pay-789"),
    )
}
```

### Storing Logger in Context

```go
package ctxlog

import (
    "context"
    "log/slog"
)

type contextKey struct{}

// FromContext retrieves the logger from context, falling back to default
func FromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(contextKey{}).(*slog.Logger); ok && logger != nil {
        return logger
    }
    return slog.Default()
}

// WithLogger stores a logger in the context
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, contextKey{}, logger)
}

// WithAttrs adds attributes to the context logger
func WithAttrs(ctx context.Context, attrs ...slog.Attr) context.Context {
    logger := FromContext(ctx).With(attrsToAny(attrs)...)
    return WithLogger(ctx, logger)
}

func attrsToAny(attrs []slog.Attr) []any {
    args := make([]any, 0, len(attrs)*2)
    for _, a := range attrs {
        args = append(args, a.Key, a.Value.Any())
    }
    return args
}

// Usage in a service function
func ProcessPayment(ctx context.Context, paymentID string) error {
    log := ctxlog.FromContext(ctx)
    log.Info("processing payment", slog.String("payment_id", paymentID))

    if err := chargeCard(ctx, paymentID); err != nil {
        log.Error("card charge failed",
            slog.String("payment_id", paymentID),
            slog.Any("error", err),
        )
        return err
    }

    log.Info("payment processed", slog.String("payment_id", paymentID))
    return nil
}
```

## HTTP Request Logging Middleware

### Comprehensive Request Logger

```go
package middleware

import (
    "context"
    "log/slog"
    "net/http"
    "time"

    "github.com/google/uuid"
    "your-module/ctxlog"
)

// RequestLogger creates a per-request logger with request context and
// logs the completed request with status code and latency.
func RequestLogger(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Generate or extract request ID
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }

        // Extract trace ID from header (set by load balancer or upstream service)
        traceID := r.Header.Get("X-Trace-ID")

        // Build request-scoped logger
        reqLogger := slog.Default().With(
            slog.String("request_id", requestID),
            slog.String("trace_id", traceID),
            slog.String("method", r.Method),
            slog.String("path", r.URL.Path),
            slog.String("remote_addr", r.RemoteAddr),
            slog.String("user_agent", r.UserAgent()),
        )

        // Store in context for downstream handlers
        ctx := ctxlog.WithLogger(r.Context(), reqLogger)
        r = r.WithContext(ctx)

        // Propagate request ID to response
        w.Header().Set("X-Request-ID", requestID)

        // Wrap ResponseWriter to capture status code
        rw := &responseWriter{ResponseWriter: w, status: 200}

        // Log request start at DEBUG level
        reqLogger.Debug("request started")

        next.ServeHTTP(rw, r)

        duration := time.Since(start)

        // Log at appropriate level based on status
        level := slog.LevelInfo
        if rw.status >= 500 {
            level = slog.LevelError
        } else if rw.status >= 400 {
            level = slog.LevelWarn
        }

        reqLogger.Log(ctx, level, "request completed",
            slog.Int("status", rw.status),
            slog.Duration("duration", duration),
            slog.Int64("bytes_written", int64(rw.bytesWritten)),
        )
    })
}

type responseWriter struct {
    http.ResponseWriter
    status       int
    bytesWritten int
}

func (rw *responseWriter) WriteHeader(status int) {
    rw.status = status
    rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += n
    return n, err
}
```

## Custom Handlers

### Handler for Correlation IDs and Sampling

```go
package handlers

import (
    "context"
    "log/slog"
    "sync/atomic"
)

// SamplingHandler wraps another handler and samples high-volume log records.
// It passes through all ERROR/WARN records and samples INFO/DEBUG at configurable rates.
type SamplingHandler struct {
    base         slog.Handler
    infoSample   uint64 // Log 1 in N INFO records (0 = all)
    debugSample  uint64 // Log 1 in N DEBUG records (0 = all)
    infoCounter  atomic.Uint64
    debugCounter atomic.Uint64
}

func NewSamplingHandler(base slog.Handler, infoSample, debugSample uint64) *SamplingHandler {
    return &SamplingHandler{
        base:        base,
        infoSample:  infoSample,
        debugSample: debugSample,
    }
}

func (h *SamplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.base.Enabled(ctx, level)
}

func (h *SamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    switch {
    case r.Level >= slog.LevelWarn:
        // Always log WARN and ERROR
        return h.base.Handle(ctx, r)
    case r.Level == slog.LevelInfo && h.infoSample > 0:
        n := h.infoCounter.Add(1)
        if n%h.infoSample != 0 {
            return nil // Drop this record
        }
        // Add sampling metadata to the record
        r.AddAttrs(slog.Uint64("sample_rate", h.infoSample))
        return h.base.Handle(ctx, r)
    case r.Level == slog.LevelDebug && h.debugSample > 0:
        n := h.debugCounter.Add(1)
        if n%h.debugSample != 0 {
            return nil
        }
        r.AddAttrs(slog.Uint64("sample_rate", h.debugSample))
        return h.base.Handle(ctx, r)
    default:
        return h.base.Handle(ctx, r)
    }
}

func (h *SamplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &SamplingHandler{
        base:        h.base.WithAttrs(attrs),
        infoSample:  h.infoSample,
        debugSample: h.debugSample,
    }
}

func (h *SamplingHandler) WithGroup(name string) slog.Handler {
    return &SamplingHandler{
        base:        h.base.WithGroup(name),
        infoSample:  h.infoSample,
        debugSample: h.debugSample,
    }
}

// Usage: log 1 in 100 INFO records, 1 in 1000 DEBUG records
// logger := slog.New(NewSamplingHandler(
//     slog.NewJSONHandler(os.Stdout, opts),
//     100,
//     1000,
// ))
```

### Multi-Writer Handler (stdout + file)

```go
package handlers

import (
    "context"
    "log/slog"
)

// MultiHandler writes log records to multiple handlers simultaneously.
// Useful for writing to both stdout (for container log collection) and a file.
type MultiHandler struct {
    handlers []slog.Handler
}

func NewMultiHandler(handlers ...slog.Handler) *MultiHandler {
    return &MultiHandler{handlers: handlers}
}

func (h *MultiHandler) Enabled(ctx context.Context, level slog.Level) bool {
    for _, handler := range h.handlers {
        if handler.Enabled(ctx, level) {
            return true
        }
    }
    return false
}

func (h *MultiHandler) Handle(ctx context.Context, r slog.Record) error {
    var lastErr error
    for _, handler := range h.handlers {
        if handler.Enabled(ctx, r.Level) {
            if err := handler.Handle(ctx, r); err != nil {
                lastErr = err
            }
        }
    }
    return lastErr
}

func (h *MultiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    handlers := make([]slog.Handler, len(h.handlers))
    for i, handler := range h.handlers {
        handlers[i] = handler.WithAttrs(attrs)
    }
    return &MultiHandler{handlers: handlers}
}

func (h *MultiHandler) WithGroup(name string) slog.Handler {
    handlers := make([]slog.Handler, len(h.handlers))
    for i, handler := range h.handlers {
        handlers[i] = handler.WithGroup(name)
    }
    return &MultiHandler{handlers: handlers}
}
```

## OpenTelemetry Trace Correlation

Correlating logs with traces is essential for debugging distributed systems. When a trace ID is in context, it should appear in every log record from that request.

```go
package otellog

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

// OtelHandler enriches log records with OpenTelemetry trace/span IDs.
type OtelHandler struct {
    base slog.Handler
}

func NewOtelHandler(base slog.Handler) *OtelHandler {
    return &OtelHandler{base: base}
}

func (h *OtelHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.base.Enabled(ctx, level)
}

func (h *OtelHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.IsRecording() {
        sc := span.SpanContext()
        r.AddAttrs(
            slog.String("trace_id", sc.TraceID().String()),
            slog.String("span_id", sc.SpanID().String()),
            slog.Bool("trace_sampled", sc.IsSampled()),
        )
    }
    return h.base.Handle(ctx, r)
}

func (h *OtelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &OtelHandler{base: h.base.WithAttrs(attrs)}
}

func (h *OtelHandler) WithGroup(name string) slog.Handler {
    return &OtelHandler{base: h.base.WithGroup(name)}
}

// Setup in main.go
func InitLogger() *slog.Logger {
    baseHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    })
    otelHandler := NewOtelHandler(baseHandler)
    logger := slog.New(otelHandler).With(
        slog.String("service", "payment-api"),
    )
    slog.SetDefault(logger)
    return logger
}
```

Log output with trace correlation:

```json
{
  "time": "2028-11-23T10:00:00Z",
  "level": "INFO",
  "msg": "processing payment",
  "service": "payment-api",
  "payment_id": "pay-789",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "trace_sampled": true
}
```

## LogValuer Interface

The `LogValuer` interface allows types to produce their own structured log representation:

```go
package domain

import "log/slog"

type User struct {
    ID       string
    Email    string
    Name     string
    Password string // NEVER log this
}

// LogValue implements slog.LogValuer
// Controls exactly what appears in logs for this type
func (u User) LogValue() slog.Value {
    return slog.GroupValue(
        slog.String("id", u.ID),
        slog.String("name", u.Name),
        // Email is PII - mask it
        slog.String("email", maskEmail(u.Email)),
        // Password is intentionally omitted
    )
}

func maskEmail(email string) string {
    at := strings.Index(email, "@")
    if at < 2 {
        return "***@***"
    }
    return email[:2] + "***" + email[at:]
}

// Payment type with sensitive field masking
type Payment struct {
    ID         string
    Amount     int64  // cents
    Currency   string
    CardNumber string // PCI data - mask in logs
}

func (p Payment) LogValue() slog.Value {
    masked := "****"
    if len(p.CardNumber) >= 4 {
        masked = "****" + p.CardNumber[len(p.CardNumber)-4:]
    }
    return slog.GroupValue(
        slog.String("id", p.ID),
        slog.Int64("amount_cents", p.Amount),
        slog.String("currency", p.Currency),
        slog.String("card_last4", masked),
    )
}

// Usage
func ProcessPayment(ctx context.Context, user User, payment Payment) {
    slog.InfoContext(ctx, "processing payment",
        slog.Any("user", user),       // Uses User.LogValue()
        slog.Any("payment", payment), // Uses Payment.LogValue()
    )
}
```

## Migrating from logrus

```go
// Before: logrus
import "github.com/sirupsen/logrus"

logrus.WithFields(logrus.Fields{
    "method": r.Method,
    "path":   r.URL.Path,
    "status": status,
}).Info("request completed")

logrus.WithError(err).WithField("user_id", userID).Error("failed to fetch user")
```

```go
// After: slog
import "log/slog"

slog.Info("request completed",
    slog.String("method", r.Method),
    slog.String("path", r.URL.Path),
    slog.Int("status", status),
)

slog.Error("failed to fetch user",
    slog.String("user_id", userID),
    slog.Any("error", err),
)
```

### logrus-to-slog Adapter for Gradual Migration

During migration, route logrus output through slog:

```go
package logadapter

import (
    "log/slog"

    "github.com/sirupsen/logrus"
)

// SlogAdapter routes logrus log entries to slog
type SlogAdapter struct {
    logger *slog.Logger
}

func NewSlogAdapter(logger *slog.Logger) *SlogAdapter {
    return &SlogAdapter{logger: logger}
}

func (a *SlogAdapter) Levels() []logrus.Level {
    return logrus.AllLevels
}

func (a *SlogAdapter) Fire(entry *logrus.Entry) error {
    attrs := make([]any, 0, len(entry.Data)*2)
    for k, v := range entry.Data {
        attrs = append(attrs, k, v)
    }

    level := logrusToSlogLevel(entry.Level)
    a.logger.Log(entry.Context, level, entry.Message, attrs...)
    return nil
}

func logrusToSlogLevel(l logrus.Level) slog.Level {
    switch l {
    case logrus.DebugLevel, logrus.TraceLevel:
        return slog.LevelDebug
    case logrus.InfoLevel:
        return slog.LevelInfo
    case logrus.WarnLevel:
        return slog.LevelWarn
    default:
        return slog.LevelError
    }
}

// In main.go during migration:
// logrus.AddHook(logadapter.NewSlogAdapter(slog.Default()))
```

## Migrating from zap

```go
// Before: zap
import "go.uber.org/zap"

logger, _ := zap.NewProduction()
logger.Info("request completed",
    zap.String("method", r.Method),
    zap.String("path", r.URL.Path),
    zap.Int("status", status),
)

// After: slog (nearly identical structure)
import "log/slog"

slog.Info("request completed",
    slog.String("method", r.Method),
    slog.String("path", r.URL.Path),
    slog.Int("status", status),
)
```

The main difference is `zap.String` becomes `slog.String`, `zap.Int` becomes `slog.Int`, and so forth. The structured API is intentionally similar.

## Production Logger Setup

```go
// logger/logger.go - complete production logger setup
package logger

import (
    "log/slog"
    "os"
    "time"

    "your-module/handlers"
    "your-module/otellog"
)

type Config struct {
    Level       slog.Level
    Service     string
    Version     string
    Environment string
    AddSource   bool
    InfoSample  uint64 // 0 = log all, N = log 1 in N
    DebugSample uint64
}

func New(cfg Config) *slog.Logger {
    var level slog.LevelVar
    level.Set(cfg.Level)

    // Base JSON handler
    baseHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     &level,
        AddSource: cfg.AddSource,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Rename time key for compatibility with common log parsers
            if a.Key == slog.TimeKey {
                return slog.Attr{
                    Key:   "@timestamp",
                    Value: slog.TimeValue(a.Value.Time().UTC()),
                }
            }
            // Rename message key
            if a.Key == slog.MessageKey {
                return slog.Attr{Key: "message", Value: a.Value}
            }
            return a
        },
    })

    // Wrap with OpenTelemetry trace correlation
    otelHandler := otellog.NewOtelHandler(baseHandler)

    // Wrap with sampling for high-volume services
    var finalHandler slog.Handler = otelHandler
    if cfg.InfoSample > 0 || cfg.DebugSample > 0 {
        finalHandler = handlers.NewSamplingHandler(otelHandler, cfg.InfoSample, cfg.DebugSample)
    }

    // Build logger with service-level fields
    logger := slog.New(finalHandler).With(
        slog.String("service", cfg.Service),
        slog.String("version", cfg.Version),
        slog.String("env", cfg.Environment),
        slog.String("host", hostname()),
    )

    slog.SetDefault(logger)
    return logger
}

func hostname() string {
    h, _ := os.Hostname()
    return h
}
```

## Testing Log Output

```go
// logger_test.go
package logger_test

import (
    "bytes"
    "encoding/json"
    "log/slog"
    "testing"
)

func TestPaymentLog(t *testing.T) {
    var buf bytes.Buffer
    logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{
        Level: slog.LevelDebug,
    }))

    logger.Info("payment processed",
        slog.String("payment_id", "pay-123"),
        slog.Int64("amount_cents", 4999),
    )

    var record map[string]any
    if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
        t.Fatalf("invalid JSON: %v", err)
    }

    if record["msg"] != "payment processed" {
        t.Errorf("expected msg 'payment processed', got %v", record["msg"])
    }
    if record["payment_id"] != "pay-123" {
        t.Errorf("expected payment_id 'pay-123', got %v", record["payment_id"])
    }
    if record["amount_cents"] != float64(4999) {
        t.Errorf("expected amount_cents 4999, got %v", record["amount_cents"])
    }

    // Verify no sensitive data leaked
    _, hasPassword := record["password"]
    if hasPassword {
        t.Error("password must not appear in logs")
    }
}
```

## Summary

The slog package provides everything needed for production-grade structured logging in Go without external dependencies:

1. Use `JSONHandler` in production for machine-parseable output
2. Store service-level fields with `logger.With()` at startup
3. Store request-scoped loggers in `context.Context` for propagation
4. Implement `LogValuer` on domain types to control what gets logged and mask PII
5. Wrap the base handler for cross-cutting concerns: sampling, trace correlation, multi-output
6. Use `slog.LevelVar` for dynamic level changes without restarts
7. Test log output by capturing JSON and asserting on parsed fields
8. Migrate from logrus by substituting `logrus.Fields` for `slog.Attr` values - the APIs are structurally similar
