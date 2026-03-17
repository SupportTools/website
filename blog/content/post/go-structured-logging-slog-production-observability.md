---
title: "Go Structured Logging with slog: Production Patterns and Observability Integration"
date: 2030-06-15T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Logging", "slog", "Observability", "OpenTelemetry"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise slog patterns: handler implementation, log levels, attribute grouping, context propagation, OpenTelemetry correlation, log sampling strategies, and testing structured logs."
more_link: "yes"
url: "/go-structured-logging-slog-production-observability/"
---

The `log/slog` package, introduced in Go 1.21, provides structured logging as a first-class standard library feature. For production Go services, slog eliminates the fragmentation between logging libraries (logrus, zap, zerolog) and establishes a consistent interface that integrates natively with OpenTelemetry trace correlation, context propagation, and custom handler backends. This guide covers production-grade slog patterns including custom handler implementation, sampling strategies, structured attribute design, and integration with distributed tracing.

<!--more-->

## Why slog Matters for Enterprise Go Services

Before slog, teams chose between several incompatible structured logging libraries. Migrating between them required rewriting all log call sites. Library authors had to pick one logger or support multiple via adapters.

`log/slog` establishes a standard interface:

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
        Level: slog.LevelInfo,
    }))

    // Set as the default logger
    slog.SetDefault(logger)

    // Log with structured attributes
    slog.Info("server started",
        slog.String("addr", ":8080"),
        slog.String("environment", "production"),
        slog.Int("pid", os.Getpid()),
    )
}
```

Output:

```json
{"time":"2030-06-15T10:00:00.000Z","level":"INFO","msg":"server started","addr":":8080","environment":"production","pid":12345}
```

## Handler Architecture

### Built-in Handlers

slog ships with two handlers:

```go
// Text handler for development (human-readable)
textHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelDebug,
    AddSource: true,  // Include file:line in each record
})

// JSON handler for production (machine-parseable)
jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
    AddSource: false,
    ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
        // Rename the time field to "@timestamp" for Elasticsearch compatibility
        if a.Key == slog.TimeKey && len(groups) == 0 {
            a.Key = "@timestamp"
        }
        // Rename "msg" to "message" for Datadog compatibility
        if a.Key == slog.MessageKey {
            a.Key = "message"
        }
        return a
    },
})
```

### Custom Handler Implementation

The `slog.Handler` interface enables building custom backends. The interface has four methods:

```go
type Handler interface {
    Enabled(ctx context.Context, level Level) bool
    Handle(ctx context.Context, r Record) error
    WithAttrs(attrs []Attr) Handler
    WithGroup(name string) Handler
}
```

A production handler that routes to multiple backends:

```go
package logging

import (
    "context"
    "io"
    "log/slog"
    "sync"
)

// MultiHandler routes log records to multiple handlers simultaneously.
// All handlers receive the same record. Errors from individual handlers
// are recorded but do not block other handlers.
type MultiHandler struct {
    handlers []slog.Handler
    mu       sync.Mutex
    errors   []error
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
    for _, handler := range h.handlers {
        if !handler.Enabled(ctx, r.Level) {
            continue
        }
        if err := handler.Handle(ctx, r.Clone()); err != nil {
            h.mu.Lock()
            h.errors = append(h.errors, err)
            h.mu.Unlock()
        }
    }
    return nil
}

func (h *MultiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    handlers := make([]slog.Handler, len(h.handlers))
    for i, handler := range h.handlers {
        handlers[i] = handler.WithAttrs(attrs)
    }
    return NewMultiHandler(handlers...)
}

func (h *MultiHandler) WithGroup(name string) slog.Handler {
    handlers := make([]slog.Handler, len(h.handlers))
    for i, handler := range h.handlers {
        handlers[i] = handler.WithGroup(name)
    }
    return NewMultiHandler(handlers...)
}
```

### Level-Filtering Handler

Route different log levels to different outputs:

```go
// LevelRouter sends error/warning to stderr and info/debug to stdout
type LevelRouter struct {
    lowHandler  slog.Handler // info and debug
    highHandler slog.Handler // warn and error
    threshold   slog.Level
}

func NewLevelRouter(lowWriter, highWriter io.Writer, threshold slog.Level, opts *slog.HandlerOptions) *LevelRouter {
    return &LevelRouter{
        lowHandler:  slog.NewJSONHandler(lowWriter, opts),
        highHandler: slog.NewJSONHandler(highWriter, opts),
        threshold:   threshold,
    }
}

func (r *LevelRouter) Enabled(ctx context.Context, level slog.Level) bool {
    return r.lowHandler.Enabled(ctx, level) || r.highHandler.Enabled(ctx, level)
}

func (r *LevelRouter) Handle(ctx context.Context, record slog.Record) error {
    if record.Level >= r.threshold {
        return r.highHandler.Handle(ctx, record)
    }
    return r.lowHandler.Handle(ctx, record)
}

func (r *LevelRouter) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &LevelRouter{
        lowHandler:  r.lowHandler.WithAttrs(attrs),
        highHandler: r.highHandler.WithAttrs(attrs),
        threshold:   r.threshold,
    }
}

func (r *LevelRouter) WithGroup(name string) slog.Handler {
    return &LevelRouter{
        lowHandler:  r.lowHandler.WithGroup(name),
        highHandler: r.highHandler.WithGroup(name),
        threshold:   r.threshold,
    }
}
```

## Context Propagation

### Storing Loggers in Context

For request-scoped logging, store the logger (or attributes) in the context:

```go
package logging

import (
    "context"
    "log/slog"
)

type contextKey struct{}

// FromContext retrieves the logger from context.
// Returns the default logger if no logger is stored in context.
func FromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(contextKey{}).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}

// WithLogger stores a logger in the context.
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, contextKey{}, logger)
}

// WithAttrs adds attributes to the logger stored in context.
// If no logger is stored, adds to the default logger.
func WithAttrs(ctx context.Context, attrs ...slog.Attr) context.Context {
    logger := FromContext(ctx).With(attrsToArgs(attrs)...)
    return WithLogger(ctx, logger)
}

func attrsToArgs(attrs []slog.Attr) []any {
    args := make([]any, 0, len(attrs)*2)
    for _, a := range attrs {
        args = append(args, a)
    }
    return args
}
```

### HTTP Middleware for Request Logging

```go
package middleware

import (
    "log/slog"
    "net/http"
    "time"

    "github.com/google/uuid"
    "yourorg/logging"
)

// RequestLogger creates a per-request logger with request metadata
// and stores it in the context for downstream handlers.
func RequestLogger(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }

        // Add request-scoped attributes to the logger
        ctx := logging.WithAttrs(r.Context(),
            slog.String("request_id", requestID),
            slog.String("method", r.Method),
            slog.String("path", r.URL.Path),
            slog.String("remote_addr", r.RemoteAddr),
            slog.String("user_agent", r.UserAgent()),
        )

        // Add request ID to response header for correlation
        w.Header().Set("X-Request-ID", requestID)

        // Wrap response writer to capture status code
        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

        start := time.Now()
        next.ServeHTTP(rw, r.WithContext(ctx))
        duration := time.Since(start)

        // Log the completed request
        logger := logging.FromContext(ctx)
        logger.Info("request completed",
            slog.Int("status", rw.statusCode),
            slog.Duration("duration", duration),
            slog.Int64("bytes_written", rw.bytesWritten),
        )
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode   int
    bytesWritten int64
}

func (rw *responseWriter) WriteHeader(statusCode int) {
    rw.statusCode = statusCode
    rw.ResponseWriter.WriteHeader(statusCode)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += int64(n)
    return n, err
}
```

Using the context logger in handlers:

```go
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    log := logging.FromContext(r.Context())

    userID := r.PathValue("id")
    log.Debug("fetching user", slog.String("user_id", userID))

    user, err := h.store.GetUser(r.Context(), userID)
    if err != nil {
        log.Error("failed to fetch user",
            slog.String("user_id", userID),
            slog.Any("error", err),
        )
        http.Error(w, "internal server error", http.StatusInternalServerError)
        return
    }

    log.Info("user fetched successfully", slog.String("user_id", userID))
    // ... write response
}
```

## OpenTelemetry Trace Correlation

Correlating logs with distributed traces enables navigating from a log entry to the full trace in Jaeger or Tempo.

### OTel slog Handler

```go
package logging

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

// OTelHandler wraps an existing handler and injects trace/span IDs
// from the context into every log record.
type OTelHandler struct {
    inner slog.Handler
}

func NewOTelHandler(inner slog.Handler) *OTelHandler {
    return &OTelHandler{inner: inner}
}

func (h *OTelHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.inner.Enabled(ctx, level)
}

func (h *OTelHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract trace context from OpenTelemetry span
    span := trace.SpanFromContext(ctx)
    if span.IsRecording() {
        spanCtx := span.SpanContext()
        if spanCtx.HasTraceID() {
            r.AddAttrs(
                slog.String("trace_id", spanCtx.TraceID().String()),
                slog.String("span_id", spanCtx.SpanID().String()),
                slog.Bool("trace_sampled", spanCtx.IsSampled()),
            )
        }
    }

    return h.inner.Handle(ctx, r)
}

func (h *OTelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &OTelHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *OTelHandler) WithGroup(name string) slog.Handler {
    return &OTelHandler{inner: h.inner.WithGroup(name)}
}
```

### Wiring OTel Handler at Startup

```go
package main

import (
    "log/slog"
    "os"

    "yourorg/logging"
)

func setupLogger() *slog.Logger {
    jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            if a.Key == slog.TimeKey {
                a.Key = "timestamp"
            }
            if a.Key == slog.LevelKey {
                a.Key = "severity"
            }
            if a.Key == slog.MessageKey {
                a.Key = "message"
            }
            return a
        },
    })

    // Wrap with OpenTelemetry trace correlation
    otelHandler := logging.NewOTelHandler(jsonHandler)

    return slog.New(otelHandler).With(
        slog.String("service", "api-service"),
        slog.String("version", "1.2.3"),
        slog.String("environment", "production"),
    )
}
```

## Attribute Grouping

### Using WithGroup

Groups add a namespace to subsequent attributes, producing nested JSON:

```go
// Service-level logger with component grouping
dbLogger := logger.WithGroup("database").With(
    slog.String("host", "db.example.com"),
    slog.String("database", "users"),
    slog.Int("pool_size", 20),
)

dbLogger.Info("query executed",
    slog.String("query", "SELECT * FROM users WHERE id = ?"),
    slog.Duration("duration", 2*time.Millisecond),
    slog.Int("rows_returned", 1),
)
```

Output:

```json
{
  "level": "INFO",
  "msg": "query executed",
  "database": {
    "host": "db.example.com",
    "database": "users",
    "pool_size": 20
  },
  "query": "SELECT * FROM users WHERE id = ?",
  "duration": 2000000,
  "rows_returned": 1
}
```

### Structured Error Logging

```go
// LogError logs an error with structured context
func LogError(ctx context.Context, logger *slog.Logger, msg string, err error, attrs ...slog.Attr) {
    args := make([]any, 0, len(attrs)+1)

    // Include error details
    args = append(args, slog.Group("error",
        slog.String("message", err.Error()),
        slog.String("type", fmt.Sprintf("%T", err)),
    ))

    for _, a := range attrs {
        args = append(args, a)
    }

    logger.ErrorContext(ctx, msg, args...)
}

// Usage
LogError(ctx, logger, "payment processing failed",
    fmt.Errorf("insufficient funds: balance=%v required=%v", balance, required),
    slog.String("user_id", userID),
    slog.Float64("balance", balance),
    slog.Float64("required", required),
    slog.String("payment_id", paymentID),
)
```

## Log Sampling

High-throughput services cannot log every request without incurring significant I/O overhead. Sampling reduces log volume while preserving representative coverage.

### Rate-Based Sampler Handler

```go
package logging

import (
    "context"
    "log/slog"
    "sync/atomic"
    "time"
)

// SamplingHandler logs every Nth record for levels below the threshold.
// Records at or above the threshold (e.g., Warn, Error) are always logged.
type SamplingHandler struct {
    inner     slog.Handler
    threshold slog.Level // Always log at this level and above
    rate      uint64     // Log 1 in rate records below threshold
    counter   atomic.Uint64
}

func NewSamplingHandler(inner slog.Handler, threshold slog.Level, rate uint64) *SamplingHandler {
    return &SamplingHandler{
        inner:     inner,
        threshold: threshold,
        rate:      rate,
    }
}

func (h *SamplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.inner.Enabled(ctx, level)
}

func (h *SamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Always log high-severity records
    if r.Level >= h.threshold {
        return h.inner.Handle(ctx, r)
    }

    // Sample low-severity records
    n := h.counter.Add(1)
    if n%h.rate != 0 {
        return nil
    }

    // Add sampling metadata
    r = r.Clone()
    r.AddAttrs(slog.Uint64("sample_rate", h.rate))
    return h.inner.Handle(ctx, r)
}

func (h *SamplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &SamplingHandler{
        inner:     h.inner.WithAttrs(attrs),
        threshold: h.threshold,
        rate:      h.rate,
    }
}

func (h *SamplingHandler) WithGroup(name string) slog.Handler {
    return &SamplingHandler{
        inner:     h.inner.WithGroup(name),
        threshold: h.threshold,
        rate:      h.rate,
    }
}
```

### Token Bucket Sampler

For bursty traffic, a token bucket sampler allows burst logging while rate-limiting sustained log volume:

```go
package logging

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

// BurstSamplingHandler allows up to BurstSize logs per second,
// then samples at Rate for the remainder of the interval.
type BurstSamplingHandler struct {
    inner     slog.Handler
    threshold slog.Level
    mu        sync.Mutex
    tokens    float64
    maxTokens float64
    refillRate float64 // tokens per nanosecond
    lastRefill time.Time
}

func NewBurstSamplingHandler(inner slog.Handler, threshold slog.Level, burstSize float64, ratePerSecond float64) *BurstSamplingHandler {
    return &BurstSamplingHandler{
        inner:      inner,
        threshold:  threshold,
        tokens:     burstSize,
        maxTokens:  burstSize,
        refillRate: ratePerSecond / 1e9,
        lastRefill: time.Now(),
    }
}

func (h *BurstSamplingHandler) allow() bool {
    h.mu.Lock()
    defer h.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(h.lastRefill).Nanoseconds()
    h.lastRefill = now

    h.tokens += float64(elapsed) * h.refillRate
    if h.tokens > h.maxTokens {
        h.tokens = h.maxTokens
    }

    if h.tokens >= 1.0 {
        h.tokens -= 1.0
        return true
    }
    return false
}

func (h *BurstSamplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.inner.Enabled(ctx, level)
}

func (h *BurstSamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    if r.Level >= h.threshold || h.allow() {
        return h.inner.Handle(ctx, r)
    }
    return nil
}

func (h *BurstSamplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &BurstSamplingHandler{
        inner:      h.inner.WithAttrs(attrs),
        threshold:  h.threshold,
        tokens:     h.maxTokens,
        maxTokens:  h.maxTokens,
        refillRate: h.refillRate,
        lastRefill: time.Now(),
    }
}

func (h *BurstSamplingHandler) WithGroup(name string) slog.Handler {
    return &BurstSamplingHandler{
        inner:      h.inner.WithGroup(name),
        threshold:  h.threshold,
        tokens:     h.maxTokens,
        maxTokens:  h.maxTokens,
        refillRate: h.refillRate,
        lastRefill: time.Now(),
    }
}
```

## Dynamic Log Level Control

Production services often need runtime log level adjustment without restart:

```go
package logging

import (
    "encoding/json"
    "log/slog"
    "net/http"
    "sync/atomic"
)

// AtomicLevel provides a thread-safe, dynamically adjustable log level.
type AtomicLevel struct {
    level atomic.Int32
}

func NewAtomicLevel(initial slog.Level) *AtomicLevel {
    l := &AtomicLevel{}
    l.level.Store(int32(initial))
    return l
}

func (l *AtomicLevel) Level() slog.Level {
    return slog.Level(l.level.Load())
}

func (l *AtomicLevel) Set(level slog.Level) {
    l.level.Store(int32(level))
}

// ServeHTTP exposes the log level as an HTTP endpoint.
// GET /log-level returns current level.
// PUT /log-level with body {"level": "DEBUG"} sets the level.
func (l *AtomicLevel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    switch r.Method {
    case http.MethodGet:
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{
            "level": l.Level().String(),
        })

    case http.MethodPut:
        var body struct {
            Level string `json:"level"`
        }
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, "invalid JSON body", http.StatusBadRequest)
            return
        }

        var level slog.Level
        if err := level.UnmarshalText([]byte(body.Level)); err != nil {
            http.Error(w, "invalid level: "+err.Error(), http.StatusBadRequest)
            return
        }

        l.Set(level)
        slog.Info("log level changed", slog.String("new_level", level.String()))

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{
            "level": level.String(),
        })

    default:
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
    }
}
```

Register the endpoint at application startup:

```go
atomicLevel := logging.NewAtomicLevel(slog.LevelInfo)

handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: atomicLevel,
})
slog.SetDefault(slog.New(handler))

// Expose level control endpoint
mux.Handle("/debug/log-level", atomicLevel)
```

## Testing Structured Logs

### In-Memory Test Handler

```go
package logging_test

import (
    "context"
    "log/slog"
    "sync"
    "testing"
)

// MemoryHandler captures log records for test assertions.
type MemoryHandler struct {
    mu      sync.Mutex
    records []slog.Record
    attrs   []slog.Attr
    groups  []string
}

func NewMemoryHandler() *MemoryHandler {
    return &MemoryHandler{}
}

func (h *MemoryHandler) Enabled(_ context.Context, _ slog.Level) bool {
    return true
}

func (h *MemoryHandler) Handle(_ context.Context, r slog.Record) error {
    h.mu.Lock()
    defer h.mu.Unlock()
    // Add pre-set attrs to the record clone
    clone := r.Clone()
    clone.AddAttrs(h.attrs...)
    h.records = append(h.records, clone)
    return nil
}

func (h *MemoryHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    h.mu.Lock()
    defer h.mu.Unlock()
    newAttrs := make([]slog.Attr, len(h.attrs)+len(attrs))
    copy(newAttrs, h.attrs)
    copy(newAttrs[len(h.attrs):], attrs)
    return &MemoryHandler{attrs: newAttrs}
}

func (h *MemoryHandler) WithGroup(name string) slog.Handler {
    return &MemoryHandler{
        attrs:  h.attrs,
        groups: append(h.groups, name),
    }
}

func (h *MemoryHandler) Records() []slog.Record {
    h.mu.Lock()
    defer h.mu.Unlock()
    result := make([]slog.Record, len(h.records))
    copy(result, h.records)
    return result
}

func (h *MemoryHandler) FindRecord(msg string) (slog.Record, bool) {
    h.mu.Lock()
    defer h.mu.Unlock()
    for _, r := range h.records {
        if r.Message == msg {
            return r, true
        }
    }
    return slog.Record{}, false
}

func (h *MemoryHandler) Reset() {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.records = h.records[:0]
}
```

### Writing Log Tests

```go
package service_test

import (
    "context"
    "log/slog"
    "testing"

    "yourorg/logging"
    "yourorg/service"
)

func TestUserCreation_LogsAuditEvent(t *testing.T) {
    handler := logging.NewMemoryHandler()
    logger := slog.New(handler)

    ctx := logging.WithLogger(context.Background(), logger)

    svc := service.NewUserService(
        service.WithLogger(logger),
        service.WithStore(newMockStore()),
    )

    if err := svc.CreateUser(ctx, "alice@example.com"); err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    // Assert audit log was emitted
    record, found := handler.FindRecord("user created")
    if !found {
        t.Fatal("expected 'user created' log record, not found")
    }

    // Verify log level
    if record.Level != slog.LevelInfo {
        t.Errorf("expected INFO level, got %v", record.Level)
    }

    // Verify required attributes
    attrs := make(map[string]slog.Value)
    record.Attrs(func(a slog.Attr) bool {
        attrs[a.Key] = a.Value
        return true
    })

    if email := attrs["email"].String(); email != "alice@example.com" {
        t.Errorf("expected email=alice@example.com, got %s", email)
    }

    if _, ok := attrs["user_id"]; !ok {
        t.Error("expected user_id attribute in audit log")
    }
}

func TestPaymentFailure_LogsErrorWithContext(t *testing.T) {
    handler := logging.NewMemoryHandler()
    logger := slog.New(handler)

    ctx := logging.WithLogger(context.Background(), logger)

    svc := service.NewPaymentService(service.WithLogger(logger))
    _ = svc.ProcessPayment(ctx, "user-123", -1.0) // Invalid amount

    record, found := handler.FindRecord("payment processing failed")
    if !found {
        t.Fatal("expected error log for invalid payment")
    }

    if record.Level != slog.LevelError {
        t.Errorf("expected ERROR level for payment failure, got %v", record.Level)
    }
}
```

## gRPC Interceptor Integration

```go
package interceptor

import (
    "context"
    "log/slog"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    "yourorg/logging"
)

// UnaryServerInterceptor creates per-request loggers with gRPC metadata.
func UnaryServerInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        start := time.Now()

        requestLogger := logger.With(
            slog.String("grpc_method", info.FullMethod),
            slog.String("grpc_type", "unary"),
        )

        ctx = logging.WithLogger(ctx, requestLogger)
        requestLogger.Debug("gRPC request started")

        resp, err := handler(ctx, req)

        code := codes.OK
        if err != nil {
            code = status.Code(err)
        }

        duration := time.Since(start)
        logLevel := slog.LevelInfo
        if code != codes.OK && code != codes.NotFound && code != codes.AlreadyExists {
            logLevel = slog.LevelError
        }

        requestLogger.Log(ctx, logLevel, "gRPC request completed",
            slog.String("grpc_code", code.String()),
            slog.Duration("duration", duration),
            slog.Any("error", err),
        )

        return resp, err
    }
}
```

## Production Initialization Pattern

```go
package main

import (
    "log/slog"
    "os"

    "yourorg/logging"
)

func initLogger(cfg Config) *slog.Logger {
    opts := &slog.HandlerOptions{
        Level: mustParseLevel(cfg.LogLevel),
        AddSource: cfg.Environment == "development",
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Normalize field names for log aggregation platform
            switch a.Key {
            case slog.TimeKey:
                a.Key = "timestamp"
            case slog.LevelKey:
                a.Key = "severity"
            case slog.MessageKey:
                a.Key = "message"
            case slog.SourceKey:
                a.Key = "source"
            }
            return a
        },
    }

    var baseHandler slog.Handler
    if cfg.Environment == "development" {
        baseHandler = slog.NewTextHandler(os.Stdout, opts)
    } else {
        baseHandler = slog.NewJSONHandler(os.Stdout, opts)
    }

    // Add OTel trace correlation
    otelHandler := logging.NewOTelHandler(baseHandler)

    // Add sampling for info/debug in high-throughput environments
    var finalHandler slog.Handler = otelHandler
    if cfg.LogSamplingEnabled {
        finalHandler = logging.NewSamplingHandler(
            otelHandler,
            slog.LevelWarn, // Always log warn+
            cfg.LogSampleRate,
        )
    }

    return slog.New(finalHandler).With(
        slog.String("service", cfg.ServiceName),
        slog.String("version", cfg.Version),
        slog.String("environment", cfg.Environment),
        slog.String("region", cfg.Region),
    )
}

func mustParseLevel(s string) slog.Level {
    var level slog.Level
    if err := level.UnmarshalText([]byte(s)); err != nil {
        return slog.LevelInfo
    }
    return level
}
```

## Summary

Production slog adoption provides standardized structured logging that integrates naturally with the Go ecosystem. The key patterns covered:

- Custom handlers implement the four-method `slog.Handler` interface and enable pluggable backends
- Context propagation via `WithLogger`/`FromContext` provides request-scoped logging without passing loggers explicitly
- OTel trace correlation injects `trace_id` and `span_id` automatically for every log record within a traced span
- Sampling handlers reduce log volume for high-throughput services while preserving full coverage for errors
- Dynamic level control enables production debug sessions without service restarts
- In-memory test handlers make log output assertable in unit tests

These patterns, combined with consistent attribute naming conventions and centralized log aggregation, produce an observability foundation that scales from single services to hundreds of microservices.
