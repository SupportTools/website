---
title: "Go Error Wrapping and Stack Traces: Production Debugging"
date: 2029-04-13T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Error Handling", "Debugging", "Sentry", "Observability", "Production"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go error wrapping and stack traces for production debugging, covering fmt.Errorf %w, errors.Is/As, pkg/errors stack traces, zerolog/zap error fields, Sentry integration, and error aggregation patterns."
more_link: "yes"
url: "/go-error-wrapping-stack-traces-production-debugging-guide/"
---

Production debugging in Go often comes down to one question: why did this error happen, and where exactly in the call stack did it originate? Go's standard library error handling is intentionally minimal, which means teams need to build or adopt patterns that provide the context and stack information necessary for efficient incident response.

This guide covers the complete error handling toolkit for production Go services: standard library error wrapping, stack-capturing libraries, structured logging integration, Sentry error reporting, and patterns for aggregating errors into actionable metrics.

<!--more-->

# Go Error Wrapping and Stack Traces: Production Debugging

## Section 1: Standard Library Error Wrapping

### fmt.Errorf with %w

The `%w` verb in `fmt.Errorf` wraps an error so that `errors.Is` and `errors.As` can unwrap it:

```go
package main

import (
    "errors"
    "fmt"
)

var ErrNotFound = errors.New("not found")
var ErrPermission = errors.New("permission denied")

func findUser(id int) error {
    if id <= 0 {
        return fmt.Errorf("findUser: invalid id %d: %w", id, ErrNotFound)
    }
    return nil
}

func getProfile(userID int) error {
    err := findUser(userID)
    if err != nil {
        return fmt.Errorf("getProfile: %w", err)
    }
    return nil
}

func handleRequest(userID int) error {
    if err := getProfile(userID); err != nil {
        return fmt.Errorf("handleRequest: %w", err)
    }
    return nil
}

func main() {
    err := handleRequest(-1)
    if err != nil {
        fmt.Println("error:", err)
        // handleRequest: getProfile: findUser: invalid id -1: not found

        // Check for specific error type anywhere in the chain
        if errors.Is(err, ErrNotFound) {
            fmt.Println("the resource was not found")
        }
    }
}
```

### errors.Is — Sentinel Error Matching

`errors.Is` traverses the error chain looking for a specific error value:

```go
package errors_demo

import (
    "database/sql"
    "errors"
    "fmt"
)

var (
    ErrUserNotFound   = errors.New("user not found")
    ErrOrderNotFound  = errors.New("order not found")
    ErrPaymentFailed  = errors.New("payment failed")
)

func queryUser(id int64) (*User, error) {
    var user User
    err := db.QueryRow("SELECT id, email FROM users WHERE id = $1", id).
        Scan(&user.ID, &user.Email)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, fmt.Errorf("queryUser(%d): %w", id, ErrUserNotFound)
        }
        return nil, fmt.Errorf("queryUser(%d): database error: %w", id, err)
    }
    return &user, nil
}

func processOrder(orderID, userID int64) error {
    user, err := queryUser(userID)
    if err != nil {
        return fmt.Errorf("processOrder(%d): %w", orderID, err)
    }
    _ = user
    return nil
}

func handleOrderRequest(orderID, userID int64) {
    err := processOrder(orderID, userID)
    if err != nil {
        switch {
        case errors.Is(err, ErrUserNotFound):
            // Return 404 to client
            fmt.Println("404: user not found")
        case errors.Is(err, ErrPaymentFailed):
            // Return 402 to client
            fmt.Println("402: payment required")
        default:
            // Return 500 to client, log internally
            fmt.Println("500: internal error:", err)
        }
    }
}
```

### errors.As — Type-Based Error Matching

`errors.As` finds the first error in the chain that matches a target type:

```go
package errors_demo

import (
    "errors"
    "fmt"
    "net"
)

// Custom error type with additional context
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation error: field %q: %s", e.Field, e.Message)
}

type DatabaseError struct {
    Query   string
    Message string
    Code    int
}

func (e *DatabaseError) Error() string {
    return fmt.Sprintf("database error (code %d): %s [query: %s]", e.Code, e.Message, e.Query)
}

func (e *DatabaseError) IsRetryable() bool {
    // PostgreSQL connection errors and deadlocks are retryable
    return e.Code == 40001 || e.Code == 40P01
}

func createUser(email string) error {
    if email == "" {
        return fmt.Errorf("createUser: %w", &ValidationError{
            Field:   "email",
            Message: "must not be empty",
        })
    }

    err := insertUserRecord(email)
    if err != nil {
        return fmt.Errorf("createUser: %w", &DatabaseError{
            Query:   "INSERT INTO users",
            Message: err.Error(),
            Code:    23505, // unique violation
        })
    }
    return nil
}

func handleCreate(email string) {
    err := createUser(email)
    if err == nil {
        return
    }

    // Check for validation error
    var validErr *ValidationError
    if errors.As(err, &validErr) {
        fmt.Printf("Invalid input: field=%s message=%s\n",
            validErr.Field, validErr.Message)
        return
    }

    // Check for database error
    var dbErr *DatabaseError
    if errors.As(err, &dbErr) {
        if dbErr.IsRetryable() {
            fmt.Println("Retryable database error, will retry")
            return
        }
        fmt.Printf("Permanent database error: code=%d\n", dbErr.Code)
        return
    }

    // Check for network error
    var netErr *net.OpError
    if errors.As(err, &netErr) {
        fmt.Printf("Network error: op=%s addr=%s\n", netErr.Op, netErr.Addr)
        return
    }

    fmt.Println("Unknown error:", err)
}
```

### Joining Multiple Errors

Go 1.20 introduced `errors.Join` for combining multiple errors:

```go
package errors_demo

import (
    "errors"
    "fmt"
)

func validateUser(u User) error {
    var errs []error

    if u.Email == "" {
        errs = append(errs, fmt.Errorf("email: %w", ErrRequired))
    }
    if len(u.Password) < 8 {
        errs = append(errs, fmt.Errorf("password: must be at least 8 characters: %w", ErrValidation))
    }
    if u.Age < 0 || u.Age > 150 {
        errs = append(errs, fmt.Errorf("age: must be between 0 and 150"))
    }

    return errors.Join(errs...)
}

func handleValidation(u User) {
    err := validateUser(u)
    if err != nil {
        // errors.Is works with joined errors
        if errors.Is(err, ErrRequired) {
            fmt.Println("has required field errors")
        }
        // Print all errors
        fmt.Println(err)
        // email: required
        // password: must be at least 8 characters: validation error
    }
}
```

## Section 2: Stack Traces with pkg/errors

### The Problem with Standard Library Errors

Standard library errors lose the call stack — you only see the chain of wrapped messages, not where the error originated:

```go
// Standard library: you know the chain but not the line numbers
// "handleRequest: getProfile: queryUser: database error: connection refused"
// Where exactly did the connection refused happen? You'd need logs with line numbers.
```

### pkg/errors for Stack Capture

`github.com/pkg/errors` captures the stack trace at the point the error is created:

```go
package main

import (
    "fmt"

    "github.com/pkg/errors"
)

func connectDB(dsn string) error {
    // Simulating a connection failure
    return errors.New("connection refused")  // stack captured HERE
}

func initDatabase(config Config) error {
    if err := connectDB(config.DSN); err != nil {
        // Wrapping with additional context, stack NOT captured again
        return errors.Wrap(err, "initDatabase: failed to connect")
    }
    return nil
}

func startServer(config Config) error {
    if err := initDatabase(config); err != nil {
        return errors.Wrap(err, "startServer")
    }
    return nil
}

func main() {
    err := startServer(Config{DSN: "postgres://..."})
    if err != nil {
        // Print error with stack trace
        fmt.Printf("%+v\n", err)
        // startServer
        // github.com/example/app/main.startServer
        //     /app/main.go:25
        // initDatabase: failed to connect
        // github.com/example/app/main.initDatabase
        //     /app/main.go:18
        // connection refused
        // github.com/example/app/main.connectDB
        //     /app/main.go:12
        // main.main
        //     /app/main.go:30
    }
}
```

### Mixing pkg/errors with Standard Library

```go
package errors_demo

import (
    "database/sql"
    "fmt"

    pkgerrors "github.com/pkg/errors"
)

// Best practice: use pkg/errors at the origin point,
// use fmt.Errorf %w for adding context in callers

func queryUserRecord(id int64) (*User, error) {
    var user User
    err := db.QueryRow("SELECT id, email FROM users WHERE id = $1", id).
        Scan(&user.ID, &user.Email)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            // Use pkg/errors.New or pkg/errors.Wrap at the origin
            return nil, pkgerrors.Wrapf(ErrUserNotFound,
                "queryUserRecord: no user with id=%d", id)
        }
        return nil, pkgerrors.Wrapf(err,
            "queryUserRecord: database error for id=%d", id)
    }
    return &user, nil
}

func getUser(id int64) (*User, error) {
    user, err := queryUserRecord(id)
    if err != nil {
        // Use fmt.Errorf %w in callers — doesn't add another stack trace
        return nil, fmt.Errorf("getUser: %w", err)
    }
    return user, nil
}
```

### Extracting Stack Trace Programmatically

```go
package errors_demo

import (
    "fmt"
    "strings"

    pkgerrors "github.com/pkg/errors"
)

type StackTracer interface {
    StackTrace() pkgerrors.StackTrace
}

func GetStackTrace(err error) string {
    // Find the deepest error with a stack trace
    var st StackTracer

    cause := err
    for cause != nil {
        if tracer, ok := cause.(StackTracer); ok {
            st = tracer
        }
        // Unwrap to find deeper tracers
        unwrapped := pkgerrors.Unwrap(cause)
        if unwrapped == nil {
            break
        }
        cause = unwrapped
    }

    if st == nil {
        return ""
    }

    var sb strings.Builder
    for _, f := range st.StackTrace() {
        fmt.Fprintf(&sb, "%+v\n", f)
    }
    return sb.String()
}
```

## Section 3: Structured Logging with Error Context

### zerolog Error Integration

```go
package logging

import (
    "os"

    "github.com/rs/zerolog"
    "github.com/rs/zerolog/log"
    pkgerrors "github.com/pkg/errors"
)

func setupLogger() zerolog.Logger {
    zerolog.ErrorStackMarshaler = pkgerrors.MarshalStack

    return zerolog.New(os.Stdout).
        With().
        Timestamp().
        Caller().
        Logger()
}

func handleDatabaseError(err error) {
    log.Error().
        Stack().   // includes pkg/errors stack trace
        Err(err).  // includes error message
        Str("component", "database").
        Str("operation", "query_user").
        Msg("database operation failed")
}

// Output example:
// {
//   "level": "error",
//   "stack": [
//     {"func":"queryUserRecord","line":"42","source":"db/users.go"},
//     {"func":"getUser","line":"15","source":"service/users.go"},
//     {"func":"handleRequest","line":"33","source":"handlers/users.go"}
//   ],
//   "error": "queryUserRecord: no user with id=99: user not found",
//   "component": "database",
//   "operation": "query_user",
//   "time": "2029-04-13T10:00:00Z",
//   "message": "database operation failed"
// }
```

### zap Error Integration

```go
package logging

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
    pkgerrors "github.com/pkg/errors"
)

// Custom zap field for pkg/errors stack traces
func ErrorWithStack(err error) zap.Field {
    return zap.Field{
        Key:  "error",
        Type: zapcore.ReflectType,
        Interface: struct {
            Message string `json:"message"`
            Stack   string `json:"stack,omitempty"`
        }{
            Message: err.Error(),
            Stack:   GetStackTrace(err),
        },
    }
}

func setupZapLogger() (*zap.Logger, error) {
    cfg := zap.NewProductionConfig()
    cfg.OutputPaths = []string{"stdout"}
    cfg.ErrorOutputPaths = []string{"stderr"}
    cfg.EncoderConfig.TimeKey = "time"
    cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

    return cfg.Build()
}

func logError(logger *zap.Logger, err error, msg string, fields ...zap.Field) {
    allFields := append(fields, ErrorWithStack(err))
    logger.Error(msg, allFields...)
}

// Usage:
func processPayment(logger *zap.Logger, paymentID string, amount float64) error {
    if err := chargeCard(amount); err != nil {
        wrappedErr := pkgerrors.Wrapf(err, "processPayment: charge failed for %s", paymentID)
        logError(logger, wrappedErr, "payment processing failed",
            zap.String("payment_id", paymentID),
            zap.Float64("amount", amount),
        )
        return wrappedErr
    }
    return nil
}
```

### slog Error Integration (Go 1.21+)

```go
package logging

import (
    "context"
    "log/slog"
    "os"

    pkgerrors "github.com/pkg/errors"
)

type ErrorValue struct {
    err error
}

func (e ErrorValue) LogValue() slog.Value {
    if e.err == nil {
        return slog.AnyValue(nil)
    }

    attrs := []slog.Attr{
        slog.String("message", e.err.Error()),
    }

    if stack := GetStackTrace(e.err); stack != "" {
        attrs = append(attrs, slog.String("stack", stack))
    }

    return slog.GroupValue(attrs...)
}

func Err(err error) slog.Attr {
    return slog.Any("error", ErrorValue{err: err})
}

func setupSlogLogger() *slog.Logger {
    return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelDebug,
        AddSource: true,
    }))
}

func handleRequest(ctx context.Context, logger *slog.Logger, userID int64) error {
    user, err := getUser(userID)
    if err != nil {
        logger.ErrorContext(ctx, "failed to get user",
            Err(err),
            slog.Int64("user_id", userID),
            slog.String("request_id", getRequestID(ctx)),
        )
        return err
    }
    _ = user
    return nil
}
```

## Section 4: Sentry Integration

### Basic Sentry Setup

```go
package main

import (
    "fmt"
    "time"

    "github.com/getsentry/sentry-go"
    pkgerrors "github.com/pkg/errors"
)

func initSentry(dsn string, environment string) error {
    return sentry.Init(sentry.ClientOptions{
        Dsn:              dsn,
        Environment:      environment,
        Release:          version.GitCommit,
        TracesSampleRate: 0.1,  // 10% of transactions for performance
        BeforeSend: func(event *sentry.Event, hint *sentry.EventHint) *sentry.Event {
            // Filter out expected errors that shouldn't create noise
            if hint.OriginalException != nil {
                if errors.Is(hint.OriginalException, ErrNotFound) {
                    return nil  // Don't send 404 errors to Sentry
                }
            }
            return event
        },
    })
}

func captureError(err error, tags map[string]string, extras map[string]interface{}) {
    sentry.WithScope(func(scope *sentry.Scope) {
        for k, v := range tags {
            scope.SetTag(k, v)
        }
        for k, v := range extras {
            scope.SetExtra(k, v)
        }
        sentry.CaptureException(err)
    })
}
```

### Sentry Middleware for HTTP

```go
package middleware

import (
    "net/http"

    "github.com/getsentry/sentry-go"
    sentryhttp "github.com/getsentry/sentry-go/http"
)

func SentryMiddleware(repanic bool) func(http.Handler) http.Handler {
    handler := sentryhttp.New(sentryhttp.Options{
        Repanic:         repanic,
        WaitForDelivery: false,
        Timeout:         2 * time.Second,
    })
    return handler.Handle
}

// Manual error capture with context
func captureHTTPError(r *http.Request, err error) {
    hub := sentry.GetHubFromContext(r.Context())
    if hub == nil {
        hub = sentry.CurrentHub().Clone()
    }

    hub.WithScope(func(scope *sentry.Scope) {
        scope.SetRequest(r)
        scope.SetTag("path", r.URL.Path)
        scope.SetTag("method", r.Method)

        if userID := getUserIDFromContext(r.Context()); userID != "" {
            scope.SetUser(sentry.User{ID: userID})
        }

        hub.CaptureException(err)
    })
}
```

### Sentry gRPC Interceptor

```go
package interceptors

import (
    "context"

    "github.com/getsentry/sentry-go"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

func SentryUnaryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        hub := sentry.CurrentHub().Clone()
        ctx = sentry.SetHubOnContext(ctx, hub)

        defer func() {
            if r := recover(); r != nil {
                hub.RecoverWithContext(ctx, r)
                hub.Flush(2 * time.Second)
                panic(r)
            }
        }()

        resp, err := handler(ctx, req)
        if err != nil {
            // Only send unexpected errors to Sentry
            // Don't send known client errors (NotFound, InvalidArgument, etc.)
            code := status.Code(err)
            switch code {
            case codes.OK, codes.NotFound, codes.InvalidArgument,
                 codes.AlreadyExists, codes.PermissionDenied,
                 codes.Unauthenticated:
                // Expected errors — don't send to Sentry
            default:
                hub.WithScope(func(scope *sentry.Scope) {
                    scope.SetTag("grpc.method", info.FullMethod)
                    scope.SetTag("grpc.code", code.String())
                    hub.CaptureException(err)
                })
            }
        }

        return resp, err
    }
}
```

### Sentry Transactions for Performance

```go
package tracing

import (
    "context"
    "net/http"

    "github.com/getsentry/sentry-go"
)

func TraceHandler(name string, handler http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        hub := sentry.GetHubFromContext(r.Context())
        options := []sentry.SpanOption{
            sentry.WithOpName("http.server"),
            sentry.ContinueFromRequest(r),
            sentry.WithTransactionSource(sentry.SourceRoute),
        }

        transaction := sentry.StartTransaction(
            sentry.SetHubOnContext(r.Context(), hub),
            name,
            options...,
        )
        defer transaction.Finish()

        handler(w, r.WithContext(transaction.Context()))
    }
}

func TraceFunction(ctx context.Context, operation string, fn func(ctx context.Context) error) error {
    span := sentry.StartSpan(ctx, operation)
    defer span.Finish()

    err := fn(span.Context())
    if err != nil {
        span.Status = sentry.SpanStatusInternalError
    }
    return err
}
```

## Section 5: Error Aggregation and Metrics

### Prometheus Error Metrics

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    errorsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "app_errors_total",
            Help: "Total number of errors by type and operation",
        },
        []string{"error_type", "operation", "severity"},
    )

    errorDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "app_error_duration_seconds",
            Help:    "Time until error detection",
            Buckets: prometheus.DefBuckets,
        },
        []string{"error_type", "operation"},
    )
)

func RecordError(err error, operation string) {
    if err == nil {
        return
    }

    errorType := classifyError(err)
    severity := getSeverity(err)

    errorsTotal.WithLabelValues(errorType, operation, severity).Inc()
}

func classifyError(err error) string {
    switch {
    case errors.Is(err, ErrNotFound):
        return "not_found"
    case errors.Is(err, ErrPermission):
        return "permission_denied"
    case errors.Is(err, ErrValidation):
        return "validation"
    case errors.Is(err, ErrTimeout):
        return "timeout"
    case isNetworkError(err):
        return "network"
    case isDatabaseError(err):
        return "database"
    default:
        return "unknown"
    }
}

func getSeverity(err error) string {
    switch {
    case errors.Is(err, ErrNotFound):
        return "low"     // Expected, clients will retry with different input
    case errors.Is(err, ErrValidation):
        return "low"     // Client bug, not our bug
    case isNetworkError(err):
        return "medium"  // Infrastructure issue, likely transient
    case isDatabaseError(err):
        return "high"    // Potential data issue
    default:
        return "high"
    }
}
```

### Error Rate Alerting

```yaml
# prometheus-rules.yaml
groups:
- name: error-rates
  rules:
  - alert: HighErrorRate
    expr: |
      (
        sum(rate(app_errors_total{severity="high"}[5m])) by (operation)
        /
        sum(rate(http_requests_total[5m])) by (operation)
      ) > 0.01
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High error rate in {{ $labels.operation }}"
      description: "Error rate is {{ $value | humanizePercentage }} for {{ $labels.operation }}"

  - alert: DatabaseErrors
    expr: |
      sum(rate(app_errors_total{error_type="database"}[1m])) > 0.1
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Database errors detected"
      description: "{{ $value }} database errors/second over last 2 minutes"
```

### Error Deduplication and Aggregation

```go
package errors_demo

import (
    "crypto/sha256"
    "fmt"
    "sync"
    "time"
)

// ErrorAggregator groups similar errors to reduce noise
type ErrorAggregator struct {
    mu       sync.Mutex
    groups   map[string]*ErrorGroup
    maxAge   time.Duration
    maxCount int
}

type ErrorGroup struct {
    Key       string
    Sample    error
    Count     int
    FirstSeen time.Time
    LastSeen  time.Time
}

func NewErrorAggregator(maxAge time.Duration, maxCount int) *ErrorAggregator {
    ea := &ErrorAggregator{
        groups:   make(map[string]*ErrorGroup),
        maxAge:   maxAge,
        maxCount: maxCount,
    }
    go ea.cleanupLoop()
    return ea
}

func (ea *ErrorAggregator) errorKey(err error) string {
    // Group errors by their type and message (stripping variable parts)
    msg := err.Error()
    h := sha256.New()
    h.Write([]byte(msg))
    return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

func (ea *ErrorAggregator) Add(err error) (shouldReport bool, group *ErrorGroup) {
    key := ea.errorKey(err)

    ea.mu.Lock()
    defer ea.mu.Unlock()

    g, exists := ea.groups[key]
    if !exists {
        g = &ErrorGroup{
            Key:       key,
            Sample:    err,
            Count:     0,
            FirstSeen: time.Now(),
        }
        ea.groups[key] = g
    }

    g.Count++
    g.LastSeen = time.Now()

    // Report the first occurrence and every Nth occurrence
    shouldReport = !exists || g.Count%ea.maxCount == 0
    return shouldReport, g
}

func (ea *ErrorAggregator) cleanupLoop() {
    ticker := time.NewTicker(time.Minute)
    for range ticker.C {
        ea.mu.Lock()
        cutoff := time.Now().Add(-ea.maxAge)
        for key, group := range ea.groups {
            if group.LastSeen.Before(cutoff) {
                delete(ea.groups, key)
            }
        }
        ea.mu.Unlock()
    }
}
```

## Section 6: Production Error Handling Patterns

### Error Context Enrichment

```go
package errors_demo

import (
    "context"
    "fmt"

    pkgerrors "github.com/pkg/errors"
)

// WithContext adds context values to an error for logging
type ContextualError struct {
    err     error
    context map[string]interface{}
}

func (e *ContextualError) Error() string {
    return e.err.Error()
}

func (e *ContextualError) Unwrap() error {
    return e.err
}

func (e *ContextualError) Context() map[string]interface{} {
    return e.context
}

func WithContext(err error, kv ...interface{}) error {
    if err == nil {
        return nil
    }

    ctx := make(map[string]interface{})
    for i := 0; i+1 < len(kv); i += 2 {
        if key, ok := kv[i].(string); ok {
            ctx[key] = kv[i+1]
        }
    }

    return &ContextualError{err: err, context: ctx}
}

func processPaymentWithContext(ctx context.Context, payment Payment) error {
    if err := validatePayment(payment); err != nil {
        return WithContext(
            pkgerrors.Wrap(err, "processPayment: validation failed"),
            "payment_id", payment.ID,
            "amount", payment.Amount,
            "currency", payment.Currency,
            "user_id", payment.UserID,
        )
    }
    return nil
}
```

### Panic Recovery with Error Reporting

```go
package middleware

import (
    "fmt"
    "net/http"
    "runtime/debug"

    "github.com/getsentry/sentry-go"
    "log/slog"
)

func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if err := recover(); err != nil {
                    stack := debug.Stack()

                    // Log to structured logger
                    logger.Error("panic recovered",
                        "panic", fmt.Sprintf("%v", err),
                        "stack", string(stack),
                        "path", r.URL.Path,
                        "method", r.Method,
                    )

                    // Report to Sentry
                    hub := sentry.GetHubFromContext(r.Context())
                    if hub != nil {
                        hub.RecoverWithContext(r.Context(), err)
                        hub.Flush(2 * time.Second)
                    }

                    http.Error(w, "internal server error", http.StatusInternalServerError)
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
```

### Structured Error Response

```go
package api

import (
    "encoding/json"
    "errors"
    "net/http"
)

type ErrorResponse struct {
    Error     string            `json:"error"`
    Code      string            `json:"code"`
    RequestID string            `json:"request_id"`
    Details   map[string]string `json:"details,omitempty"`
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
    requestID := getRequestID(r.Context())

    var statusCode int
    var errResp ErrorResponse

    errResp.RequestID = requestID

    switch {
    case errors.Is(err, ErrNotFound):
        statusCode = http.StatusNotFound
        errResp.Code = "NOT_FOUND"
        errResp.Error = "the requested resource was not found"

    case errors.Is(err, ErrPermission):
        statusCode = http.StatusForbidden
        errResp.Code = "FORBIDDEN"
        errResp.Error = "you do not have permission to perform this action"

    case errors.Is(err, ErrValidation):
        statusCode = http.StatusBadRequest
        errResp.Code = "VALIDATION_ERROR"
        errResp.Error = "the request contains invalid data"
        var ve *ValidationError
        if errors.As(err, &ve) {
            errResp.Details = map[string]string{
                ve.Field: ve.Message,
            }
        }

    default:
        statusCode = http.StatusInternalServerError
        errResp.Code = "INTERNAL_ERROR"
        errResp.Error = "an internal error occurred"
        // Don't expose internal error details to clients
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(statusCode)
    json.NewEncoder(w).Encode(errResp)
}
```

### Complete Error Handling in a Handler

```go
package handlers

import (
    "net/http"

    "log/slog"
    pkgerrors "github.com/pkg/errors"
    "github.com/getsentry/sentry-go"
)

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    logger := middleware.LoggerFrom(ctx)

    userID, err := parseUserID(r)
    if err != nil {
        logger.Warn("invalid user ID in request",
            middleware.Err(err),
            slog.String("raw_id", r.PathValue("id")),
        )
        api.WriteError(w, r, fmt.Errorf("%w: %s", ErrValidation, err))
        return
    }

    user, err := h.service.GetUser(ctx, userID)
    if err != nil {
        // Classify the error before logging and reporting
        if errors.Is(err, ErrUserNotFound) {
            logger.Debug("user not found",
                slog.Int64("user_id", userID),
            )
            api.WriteError(w, r, err)
            return
        }

        // Unexpected error — log with full stack and report to Sentry
        logger.Error("unexpected error getting user",
            middleware.Err(err),
            slog.Int64("user_id", userID),
        )

        metrics.RecordError(err, "get_user")

        hub := sentry.GetHubFromContext(ctx)
        if hub != nil {
            hub.WithScope(func(scope *sentry.Scope) {
                scope.SetTag("handler", "GetUser")
                scope.SetExtra("user_id", userID)
                hub.CaptureException(err)
            })
        }

        api.WriteError(w, r, err)
        return
    }

    api.WriteJSON(w, http.StatusOK, user)
}
```

## Section 7: Testing Error Handling

### Testing Error Chains

```go
package errors_test

import (
    "errors"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestErrorWrapping(t *testing.T) {
    t.Run("errors.Is works through chain", func(t *testing.T) {
        err := fmt.Errorf("outer: %w",
            fmt.Errorf("middle: %w",
                fmt.Errorf("inner: %w", ErrNotFound),
            ),
        )

        assert.True(t, errors.Is(err, ErrNotFound))
        assert.Equal(t, "outer: middle: inner: not found", err.Error())
    })

    t.Run("errors.As extracts concrete type", func(t *testing.T) {
        wrapped := fmt.Errorf("handler error: %w",
            &ValidationError{Field: "email", Message: "invalid format"},
        )

        var ve *ValidationError
        require.True(t, errors.As(wrapped, &ve))
        assert.Equal(t, "email", ve.Field)
        assert.Equal(t, "invalid format", ve.Message)
    })

    t.Run("errors.Join combines multiple errors", func(t *testing.T) {
        err := errors.Join(
            fmt.Errorf("error 1: %w", ErrNotFound),
            fmt.Errorf("error 2: %w", ErrPermission),
        )

        assert.True(t, errors.Is(err, ErrNotFound))
        assert.True(t, errors.Is(err, ErrPermission))
    })
}

func TestClassifyError(t *testing.T) {
    cases := []struct {
        name     string
        err      error
        expected string
    }{
        {"not found", ErrNotFound, "not_found"},
        {"wrapped not found", fmt.Errorf("wrapper: %w", ErrNotFound), "not_found"},
        {"validation", &ValidationError{}, "validation"},
        {"unknown", errors.New("something broke"), "unknown"},
    }

    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            assert.Equal(t, tc.expected, classifyError(tc.err))
        })
    }
}
```

## Summary

Production Go error handling requires multiple layers working together:

- Use `fmt.Errorf %w` to add context at each layer while preserving the error chain
- Use `errors.Is` for sentinel error matching and `errors.As` for type-based matching
- Use `pkg/errors` at error origin points to capture stack traces; use `fmt.Errorf %w` in callers to add context without duplicate stacks
- Configure zerolog with `pkgerrors.MarshalStack` or zap with custom fields to include stack traces in structured logs
- Integrate Sentry at the HTTP and gRPC middleware layers to capture unexpected errors with full context
- Track error rates with Prometheus metrics using `error_type`, `operation`, and `severity` labels
- Never expose raw error messages to API clients — use classified, sanitized error responses
- Test error chains explicitly to verify that `errors.Is` and `errors.As` work correctly through wrapper layers
