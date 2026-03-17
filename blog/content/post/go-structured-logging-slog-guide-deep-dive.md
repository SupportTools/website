---
title: "Structured Logging in Go with slog: Production Patterns and Observability"
date: 2028-02-29T00:00:00-05:00
draft: false
tags: ["Go", "slog", "Logging", "Observability", "OpenTelemetry", "Structured Logging"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go's slog package: JSONHandler vs TextHandler, custom handlers with trace ID injection and PII redaction, dynamic level changes, log sampling, OpenTelemetry correlation, and testing log output."
more_link: "yes"
url: "/go-structured-logging-slog-guide-deep-dive/"
---

The `log/slog` package, introduced in Go 1.21, provides a structured logging foundation in the standard library. Unlike `log.Printf`, slog produces structured records with typed key-value attributes that integrate naturally with log aggregation systems, distributed tracing, and alerting pipelines. This guide covers slog's architecture in depth, the tradeoffs between handlers, production patterns for enriching logs with trace context and redacting sensitive data, dynamic level control without restarts, sampling for high-throughput services, and correlation with OpenTelemetry spans.

<!--more-->

## slog Package Architecture

The slog API has three core types:

- **`Logger`**: The user-facing API. Methods like `Info`, `Error`, `With`, `WithGroup` produce log records.
- **`Handler`**: An interface that receives records and writes them somewhere. `JSONHandler` and `TextHandler` are the built-in implementations.
- **`Record`**: An immutable log entry containing a time, level, message, and attributes.

The separation of `Logger` from `Handler` makes handler composition straightforward: wrap a handler to add behavior (trace IDs, sampling, redaction) without modifying the `Logger` interface.

```go
type Handler interface {
    Enabled(ctx context.Context, level Level) bool
    Handle(ctx context.Context, r Record) error
    WithAttrs(attrs []Attr) Handler
    WithGroup(name string) Handler
}
```

## JSONHandler vs TextHandler

`JSONHandler` writes one JSON object per line, suitable for log aggregation systems (Loki, Elasticsearch, Splunk):

```go
logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
    AddSource: true,
}))
logger.Info("server started",
    slog.String("addr", ":8080"),
    slog.Int("workers", 16),
)
// Output:
// {"time":"2028-02-29T12:00:00Z","level":"INFO","source":{"function":"main.main","file":"main.go","line":42},"msg":"server started","addr":":8080","workers":16}
```

`TextHandler` writes logfmt-style output, suitable for human-readable terminal output:

```go
logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelDebug,
}))
logger.Debug("database query",
    slog.String("sql", "SELECT * FROM users"),
    slog.Duration("elapsed", 2*time.Millisecond),
)
// Output:
// time=2028-02-29T12:00:00Z level=DEBUG msg="database query" sql="SELECT * FROM users" elapsed=2ms
```

For production services, `JSONHandler` is the correct default. `TextHandler` should be enabled only in development environments, typically via a build flag or environment variable.

```go
func newLogger() *slog.Logger {
    var handler slog.Handler
    opts := &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true,
    }

    if os.Getenv("LOG_FORMAT") == "text" {
        handler = slog.NewTextHandler(os.Stdout, opts)
    } else {
        handler = slog.NewJSONHandler(os.Stdout, opts)
    }

    return slog.New(handler)
}
```

## Custom Handler: Trace ID and Request ID Injection

The most common production requirement is automatically injecting trace and request IDs from context into every log record without requiring callers to pass them explicitly.

```go
package logging

import (
    "context"
    "log/slog"
)

type contextKey string

const (
    traceIDKey   contextKey = "trace_id"
    spanIDKey    contextKey = "span_id"
    requestIDKey contextKey = "request_id"
    userIDKey    contextKey = "user_id"
)

// ContextHandler wraps another handler and injects context values as log attributes
type ContextHandler struct {
    handler slog.Handler
}

func NewContextHandler(h slog.Handler) *ContextHandler {
    return &ContextHandler{handler: h}
}

func (h *ContextHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.handler.Enabled(ctx, level)
}

func (h *ContextHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract and inject context values as attributes
    if traceID, ok := ctx.Value(traceIDKey).(string); ok && traceID != "" {
        r.AddAttrs(slog.String("trace_id", traceID))
    }
    if spanID, ok := ctx.Value(spanIDKey).(string); ok && spanID != "" {
        r.AddAttrs(slog.String("span_id", spanID))
    }
    if requestID, ok := ctx.Value(requestIDKey).(string); ok && requestID != "" {
        r.AddAttrs(slog.String("request_id", requestID))
    }
    // User ID is optional and may be absent for unauthenticated requests
    if userID, ok := ctx.Value(userIDKey).(string); ok && userID != "" {
        r.AddAttrs(slog.String("user_id", userID))
    }
    return h.handler.Handle(ctx, r)
}

func (h *ContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &ContextHandler{handler: h.handler.WithAttrs(attrs)}
}

func (h *ContextHandler) WithGroup(name string) slog.Handler {
    return &ContextHandler{handler: h.handler.WithGroup(name)}
}

// Context injection functions
func WithTraceID(ctx context.Context, traceID string) context.Context {
    return context.WithValue(ctx, traceIDKey, traceID)
}

func WithSpanID(ctx context.Context, spanID string) context.Context {
    return context.WithValue(ctx, spanIDKey, spanID)
}

func WithRequestID(ctx context.Context, requestID string) context.Context {
    return context.WithValue(ctx, requestIDKey, requestID)
}

func WithUserID(ctx context.Context, userID string) context.Context {
    return context.WithValue(ctx, userIDKey, userID)
}
```

Usage in middleware:

```go
func LoggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx := r.Context()

            // Inject request-scoped IDs
            requestID := r.Header.Get("X-Request-ID")
            if requestID == "" {
                requestID = generateID()
            }
            ctx = WithRequestID(ctx, requestID)

            // Inject OpenTelemetry trace context (if present)
            span := trace.SpanFromContext(ctx)
            if span.SpanContext().IsValid() {
                ctx = WithTraceID(ctx, span.SpanContext().TraceID().String())
                ctx = WithSpanID(ctx, span.SpanContext().SpanID().String())
            }

            start := time.Now()
            wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}
            next.ServeHTTP(wrapped, r.WithContext(ctx))

            logger.InfoContext(ctx, "http request",
                slog.String("method", r.Method),
                slog.String("path", r.URL.Path),
                slog.Int("status", wrapped.statusCode),
                slog.Duration("duration", time.Since(start)),
                slog.String("remote_addr", r.RemoteAddr),
            )
        })
    }
}
```

## Custom Handler: PII Redaction

Sensitive data must never appear in logs. A redacting handler intercepts attributes before they reach the underlying handler and masks known PII fields.

```go
package logging

import (
    "context"
    "log/slog"
    "regexp"
    "strings"
)

// piiFields is the set of attribute keys that should be redacted
var piiFields = map[string]bool{
    "password":       true,
    "secret":         true,
    "token":          true,
    "api_key":        true,
    "apikey":         true,
    "authorization":  true,
    "credit_card":    true,
    "card_number":    true,
    "ssn":            true,
    "social_security": true,
    "email":          false, // Log email but only partial
}

// Patterns for automatic detection of sensitive values
var sensitivePatterns = []*regexp.Regexp{
    regexp.MustCompile(`\b[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}\b`), // Credit card
    regexp.MustCompile(`\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b`),                         // SSN
}

const redactedValue = "[REDACTED]"

type RedactingHandler struct {
    handler slog.Handler
}

func NewRedactingHandler(h slog.Handler) *RedactingHandler {
    return &RedactingHandler{handler: h}
}

func (h *RedactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.handler.Enabled(ctx, level)
}

func (h *RedactingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Create new record with redacted attributes
    newRecord := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
    r.Attrs(func(a slog.Attr) bool {
        newRecord.AddAttrs(redactAttr(a))
        return true
    })
    return h.handler.Handle(ctx, newRecord)
}

func (h *RedactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    redacted := make([]slog.Attr, len(attrs))
    for i, a := range attrs {
        redacted[i] = redactAttr(a)
    }
    return &RedactingHandler{handler: h.handler.WithAttrs(redacted)}
}

func (h *RedactingHandler) WithGroup(name string) slog.Handler {
    return &RedactingHandler{handler: h.handler.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
    key := strings.ToLower(a.Key)

    // Check if key is in PII field list
    if shouldRedact, ok := piiFields[key]; ok {
        if shouldRedact {
            return slog.String(a.Key, redactedValue)
        }
        // Partial redaction for email
        if key == "email" {
            return slog.String(a.Key, redactEmail(a.Value.String()))
        }
    }

    // Check value against sensitive patterns
    if a.Value.Kind() == slog.KindString {
        val := a.Value.String()
        for _, pattern := range sensitivePatterns {
            if pattern.MatchString(val) {
                return slog.String(a.Key, redactedValue)
            }
        }
    }

    // Recursively redact group attributes
    if a.Value.Kind() == slog.KindGroup {
        attrs := a.Value.Group()
        redacted := make([]any, 0, len(attrs)*2)
        for _, ga := range attrs {
            ra := redactAttr(ga)
            redacted = append(redacted, ra.Key, ra.Value.Any())
        }
        return slog.Group(a.Key, redacted...)
    }

    return a
}

func redactEmail(email string) string {
    parts := strings.Split(email, "@")
    if len(parts) != 2 {
        return redactedValue
    }
    local := parts[0]
    if len(local) > 3 {
        local = local[:3] + strings.Repeat("*", len(local)-3)
    }
    return local + "@" + parts[1]
}
```

## Dynamic Level Changes

Production services should support runtime log level changes without restarting. `slog.LevelVar` provides an atomic level that can be changed at any time.

```go
package main

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "os"
    "sync"
)

var (
    logLevel = new(slog.LevelVar) // default: Info
    logger   *slog.Logger
    initOnce sync.Once
)

func initLogger() {
    logLevel.Set(slog.LevelInfo)

    handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     logLevel,
        AddSource: true,
    })
    logger = slog.New(handler)
    slog.SetDefault(logger)
}

// LogLevelHandler handles GET/PUT /log-level for dynamic level control
func LogLevelHandler(w http.ResponseWriter, r *http.Request) {
    switch r.Method {
    case http.MethodGet:
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{
            "level": logLevel.Level().String(),
        })

    case http.MethodPut:
        var req struct {
            Level string `json:"level"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, "invalid request body", http.StatusBadRequest)
            return
        }

        var newLevel slog.Level
        if err := newLevel.UnmarshalText([]byte(req.Level)); err != nil {
            http.Error(w, "invalid level: use DEBUG, INFO, WARN, or ERROR",
                http.StatusBadRequest)
            return
        }

        oldLevel := logLevel.Level()
        logLevel.Set(newLevel)

        logger.InfoContext(r.Context(), "log level changed",
            slog.String("old_level", oldLevel.String()),
            slog.String("new_level", newLevel.String()),
        )

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{
            "level": newLevel.String(),
        })

    default:
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
    }
}

// Usage from kubectl exec or curl:
// curl -X PUT http://pod-ip:8080/log-level -d '{"level":"DEBUG"}'
// curl http://pod-ip:8080/log-level
```

## Log Sampling for High-Volume Services

Sampling prevents log volume from overwhelming log aggregation infrastructure while preserving visibility into error conditions.

```go
package logging

import (
    "context"
    "log/slog"
    "sync/atomic"
    "time"
)

// SamplingHandler samples INFO and DEBUG logs, always passes WARN/ERROR
type SamplingHandler struct {
    handler   slog.Handler
    counter   atomic.Uint64
    rate      uint64 // Log 1 in N info messages
    resetTick *time.Ticker
}

func NewSamplingHandler(h slog.Handler, rate uint64) *SamplingHandler {
    s := &SamplingHandler{
        handler:   h,
        rate:      rate,
        resetTick: time.NewTicker(1 * time.Minute),
    }
    go func() {
        for range s.resetTick.C {
            s.counter.Store(0) // Reset counter each minute to avoid permanent suppression
        }
    }()
    return s
}

func (h *SamplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.handler.Enabled(ctx, level)
}

func (h *SamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Always log WARN and above
    if r.Level >= slog.LevelWarn {
        return h.handler.Handle(ctx, r)
    }

    // Sample INFO and DEBUG
    n := h.counter.Add(1)
    if n%h.rate != 0 {
        return nil // Drop this record
    }

    // Add sampling metadata
    r.AddAttrs(
        slog.Uint64("sample_rate", h.rate),
        slog.Uint64("sample_counter", n),
    )
    return h.handler.Handle(ctx, r)
}

func (h *SamplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &SamplingHandler{
        handler:   h.handler.WithAttrs(attrs),
        rate:      h.rate,
        resetTick: h.resetTick,
    }
}

func (h *SamplingHandler) WithGroup(name string) slog.Handler {
    return &SamplingHandler{
        handler:   h.handler.WithGroup(name),
        rate:      h.rate,
        resetTick: h.resetTick,
    }
}
```

A more sophisticated approach uses per-message-type sampling with a token bucket:

```go
package logging

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

type messageSampler struct {
    mu          sync.Mutex
    lastSeen    time.Time
    count       uint64
    ratePerMin  uint64
}

// MessageSamplingHandler samples each unique message independently
type MessageSamplingHandler struct {
    handler  slog.Handler
    mu       sync.Mutex
    samplers map[string]*messageSampler
    rate     uint64
}

func NewMessageSamplingHandler(h slog.Handler, ratePerMin uint64) *MessageSamplingHandler {
    return &MessageSamplingHandler{
        handler:  h,
        samplers: make(map[string]*messageSampler),
        rate:     ratePerMin,
    }
}

func (h *MessageSamplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.handler.Enabled(ctx, level)
}

func (h *MessageSamplingHandler) Handle(ctx context.Context, r slog.Record) error {
    if r.Level >= slog.LevelWarn {
        return h.handler.Handle(ctx, r)
    }

    h.mu.Lock()
    s, ok := h.samplers[r.Message]
    if !ok {
        s = &messageSampler{ratePerMin: h.rate}
        h.samplers[r.Message] = s
    }
    h.mu.Unlock()

    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now()
    if now.Sub(s.lastSeen) > time.Minute {
        s.count = 0
        s.lastSeen = now
    }
    s.count++

    if s.count > s.ratePerMin {
        return nil // Suppress this message
    }

    return h.handler.Handle(ctx, r)
}

func (h *MessageSamplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &MessageSamplingHandler{
        handler:  h.handler.WithAttrs(attrs),
        samplers: h.samplers,
        rate:     h.rate,
    }
}

func (h *MessageSamplingHandler) WithGroup(name string) slog.Handler {
    return &MessageSamplingHandler{
        handler:  h.handler.WithGroup(name),
        samplers: h.samplers,
        rate:     h.rate,
    }
}
```

## slog with OpenTelemetry Correlation

When using OpenTelemetry tracing, slog records should automatically include the active trace and span IDs from the current span context.

```go
package logging

import (
    "context"
    "log/slog"

    "go.opentelemetry.io/otel/trace"
)

// OTelHandler injects OpenTelemetry trace context into every log record
type OTelHandler struct {
    handler slog.Handler
}

func NewOTelHandler(h slog.Handler) *OTelHandler {
    return &OTelHandler{handler: h}
}

func (h *OTelHandler) Enabled(ctx context.Context, level slog.Level) bool {
    return h.handler.Enabled(ctx, level)
}

func (h *OTelHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        spanCtx := span.SpanContext()
        r.AddAttrs(
            slog.String("trace_id", spanCtx.TraceID().String()),
            slog.String("span_id", spanCtx.SpanID().String()),
            slog.Bool("trace_sampled", spanCtx.IsSampled()),
        )

        // Also add log record to the span as an event (visible in trace UI)
        if r.Level >= slog.LevelError {
            span.AddEvent("log.error", trace.WithAttributes(
                // Use standard semantic conventions for log attributes
            ))
        }
    }
    return h.handler.Handle(ctx, r)
}

func (h *OTelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &OTelHandler{handler: h.handler.WithAttrs(attrs)}
}

func (h *OTelHandler) WithGroup(name string) slog.Handler {
    return &OTelHandler{handler: h.handler.WithGroup(name)}
}
```

## Composing Handlers for Production

Chain all handlers together in the correct order:

```go
package main

import (
    "log/slog"
    "os"
)

func NewProductionLogger(serviceName, version string) *slog.Logger {
    // Base handler: JSON output
    baseHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     logLevel, // *slog.LevelVar for dynamic control
        AddSource: false,    // Source adds cost; enable only when debugging
    })

    // Layer 1: Redact PII before it reaches the JSON handler
    redacting := NewRedactingHandler(baseHandler)

    // Layer 2: Inject OpenTelemetry trace context
    otel := NewOTelHandler(redacting)

    // Layer 3: Inject request context (request ID, user ID)
    contextual := NewContextHandler(otel)

    // Layer 4: Sample high-volume info messages (100 per minute per message type)
    sampled := NewMessageSamplingHandler(contextual, 100)

    // Add service-level attributes to every record
    logger := slog.New(sampled).With(
        slog.String("service", serviceName),
        slog.String("version", version),
        slog.String("environment", os.Getenv("ENVIRONMENT")),
    )

    return logger
}
```

Handler execution order flows from outermost to innermost:
```
Caller
  → SamplingHandler (may drop)
    → ContextHandler (injects request_id, user_id)
      → OTelHandler (injects trace_id, span_id)
        → RedactingHandler (masks PII)
          → JSONHandler (writes to stdout)
```

## Testing Log Output

Capturing and asserting log output in tests requires a test handler:

```go
package logging_test

import (
    "bytes"
    "context"
    "encoding/json"
    "log/slog"
    "testing"
    "time"
)

// TestHandler captures log records for test assertions
type TestHandler struct {
    records []slog.Record
    mu      sync.Mutex
    level   slog.Level
}

func NewTestHandler(level slog.Level) *TestHandler {
    return &TestHandler{level: level}
}

func (h *TestHandler) Enabled(_ context.Context, level slog.Level) bool {
    return level >= h.level
}

func (h *TestHandler) Handle(_ context.Context, r slog.Record) error {
    h.mu.Lock()
    defer h.mu.Unlock()
    // Clone the record to avoid aliasing issues with attribute slices
    clone := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
    r.Attrs(func(a slog.Attr) bool {
        clone.AddAttrs(a)
        return true
    })
    h.records = append(h.records, clone)
    return nil
}

func (h *TestHandler) WithAttrs(attrs []slog.Attr) slog.Handler { return h }
func (h *TestHandler) WithGroup(name string) slog.Handler       { return h }

func (h *TestHandler) Records() []slog.Record {
    h.mu.Lock()
    defer h.mu.Unlock()
    return append([]slog.Record{}, h.records...)
}

func (h *TestHandler) Reset() {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.records = h.records[:0]
}

// Test that authentication logs the user ID without logging the password
func TestAuthLogging(t *testing.T) {
    h := NewTestHandler(slog.LevelDebug)
    redacting := NewRedactingHandler(h)
    logger := slog.New(redacting)

    logger.Info("user authenticated",
        slog.String("user_id", "usr_123"),
        slog.String("password", "s3cr3t-password"),
        slog.String("email", "alice@example.com"),
    )

    records := h.Records()
    if len(records) != 1 {
        t.Fatalf("expected 1 record, got %d", len(records))
    }

    attrs := make(map[string]string)
    records[0].Attrs(func(a slog.Attr) bool {
        attrs[a.Key] = a.Value.String()
        return true
    })

    if attrs["user_id"] != "usr_123" {
        t.Errorf("expected user_id=usr_123, got %s", attrs["user_id"])
    }
    if attrs["password"] != "[REDACTED]" {
        t.Errorf("expected password to be redacted, got %s", attrs["password"])
    }
    if attrs["email"] == "alice@example.com" {
        t.Errorf("expected email to be partially redacted, got %s", attrs["email"])
    }
}

// Test using JSON output for assertion against specific fields
func TestJSONOutput(t *testing.T) {
    var buf bytes.Buffer
    logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{
        Level: slog.LevelInfo,
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Normalize time for test stability
            if a.Key == slog.TimeKey && len(groups) == 0 {
                return slog.Attr{Key: a.Key, Value: slog.StringValue("TEST_TIME")}
            }
            return a
        },
    }))

    logger.Info("test message", slog.Int("count", 42))

    var result map[string]any
    if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
        t.Fatalf("invalid JSON output: %v", err)
    }

    if result["msg"] != "test message" {
        t.Errorf("unexpected message: %v", result["msg"])
    }
    if result["count"] != float64(42) {
        t.Errorf("unexpected count: %v", result["count"])
    }
}
```

## Performance Considerations

slog has excellent performance characteristics, but attribute allocation can be expensive at high log rates:

```go
// SLOW: always allocates the args slice, even if log level is disabled
logger.Debug("request processed",
    slog.String("path", r.URL.Path),
    slog.Int("status", statusCode),
    slog.Duration("elapsed", elapsed),
)

// FAST: use LogAttrs to avoid interface{} boxing
logger.LogAttrs(ctx, slog.LevelDebug, "request processed",
    slog.String("path", r.URL.Path),
    slog.Int("status", statusCode),
    slog.Duration("elapsed", elapsed),
)

// FAST: check Enabled before computing expensive attributes
if logger.Enabled(ctx, slog.LevelDebug) {
    logger.LogAttrs(ctx, slog.LevelDebug, "query explain",
        slog.String("plan", computeExpensiveQueryPlan()),
    )
}
```

Benchmark results on Go 1.21+ show `LogAttrs` is approximately 40% faster than the variadic `Info`/`Debug` methods for the same attributes, primarily because it avoids the `any` interface conversion.

The structured logging patterns in this guide—PII redaction, trace correlation, dynamic levels, and message sampling—cover the full set of production requirements without depending on third-party logging frameworks, keeping the dependency graph clean and the upgrade path simple as new Go versions improve the slog API.
