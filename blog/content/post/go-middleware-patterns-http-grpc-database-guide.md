---
title: "Go Middleware Patterns: HTTP, gRPC, and Database"
date: 2029-04-10T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Middleware", "HTTP", "gRPC", "Database", "Context", "Circuit Breaker"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go middleware patterns covering HTTP middleware chaining, gRPC interceptor chains, database middleware for query logging and circuit breakers, context propagation, and timeout middleware."
more_link: "yes"
url: "/go-middleware-patterns-http-grpc-database-guide/"
---

Middleware is the backbone of production Go services. Whether you are adding authentication, logging, tracing, or circuit breaking, the middleware pattern lets you compose cross-cutting concerns cleanly without polluting business logic. Go's interfaces and first-class functions make middleware composition particularly elegant, but the patterns differ meaningfully between HTTP, gRPC, and database layers.

This guide covers each layer in depth with production-ready implementations, explains context propagation across middleware boundaries, and shows how to compose complex middleware chains without sacrificing testability.

<!--more-->

# Go Middleware Patterns: HTTP, gRPC, and Database

## Section 1: HTTP Middleware Fundamentals

### The net/http Handler Interface

Go's `http.Handler` interface has a single method:

```go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}
```

Middleware wraps a `Handler` to return a new `Handler`, intercepting the call before and/or after delegating to the inner handler:

```go
type Middleware func(http.Handler) http.Handler
```

A minimal logging middleware:

```go
package middleware

import (
    "log/slog"
    "net/http"
    "time"
)

func Logger(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Wrap ResponseWriter to capture status code
            lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}

            next.ServeHTTP(lrw, r)

            logger.Info("http request",
                "method", r.Method,
                "path", r.URL.Path,
                "status", lrw.statusCode,
                "duration_ms", time.Since(start).Milliseconds(),
                "remote_addr", r.RemoteAddr,
                "user_agent", r.UserAgent(),
            )
        })
    }
}

type loggingResponseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
    lrw.statusCode = code
    lrw.ResponseWriter.WriteHeader(code)
}
```

### Middleware Chain Builder

Rather than nesting calls manually, a chain builder composes middleware cleanly:

```go
package middleware

import "net/http"

// Chain composes multiple middlewares left-to-right.
// The first middleware in the slice wraps the outermost layer.
type Chain struct {
    middlewares []func(http.Handler) http.Handler
}

func NewChain(mws ...func(http.Handler) http.Handler) Chain {
    return Chain{middlewares: append([]func(http.Handler) http.Handler(nil), mws...)}
}

func (c Chain) Then(h http.Handler) http.Handler {
    for i := len(c.middlewares) - 1; i >= 0; i-- {
        h = c.middlewares[i](h)
    }
    return h
}

func (c Chain) ThenFunc(fn http.HandlerFunc) http.Handler {
    return c.Then(fn)
}

func (c Chain) Append(mws ...func(http.Handler) http.Handler) Chain {
    newMws := make([]func(http.Handler) http.Handler, len(c.middlewares)+len(mws))
    copy(newMws, c.middlewares)
    copy(newMws[len(c.middlewares):], mws)
    return Chain{middlewares: newMws}
}
```

Usage:

```go
package main

import (
    "net/http"
    "log/slog"
    "os"

    "github.com/example/app/middleware"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    base := middleware.NewChain(
        middleware.RequestID(),
        middleware.Logger(logger),
        middleware.Recover(logger),
        middleware.RealIP(),
    )

    authenticated := base.Append(
        middleware.JWTAuth(jwtSecret),
        middleware.RateLimit(100, time.Minute),
    )

    mux := http.NewServeMux()
    mux.Handle("/api/v1/orders", authenticated.ThenFunc(handleOrders))
    mux.Handle("/health", base.ThenFunc(handleHealth))
    mux.Handle("/metrics", http.HandlerFunc(handleMetrics))

    http.ListenAndServe(":8080", mux)
}
```

### Request ID Middleware

```go
package middleware

import (
    "context"
    "net/http"

    "github.com/google/uuid"
)

type contextKey string

const RequestIDKey contextKey = "request_id"

func RequestID() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            requestID := r.Header.Get("X-Request-ID")
            if requestID == "" {
                requestID = uuid.New().String()
            }

            ctx := context.WithValue(r.Context(), RequestIDKey, requestID)
            w.Header().Set("X-Request-ID", requestID)

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func GetRequestID(ctx context.Context) string {
    if id, ok := ctx.Value(RequestIDKey).(string); ok {
        return id
    }
    return ""
}
```

### Authentication Middleware

```go
package middleware

import (
    "context"
    "errors"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type Claims struct {
    UserID   string   `json:"uid"`
    Email    string   `json:"email"`
    Roles    []string `json:"roles"`
    jwt.RegisteredClaims
}

type contextKey string
const userClaimsKey contextKey = "user_claims"

func JWTAuth(signingKey []byte) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                http.Error(w, "authorization header required", http.StatusUnauthorized)
                return
            }

            parts := strings.SplitN(authHeader, " ", 2)
            if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
                http.Error(w, "invalid authorization header format", http.StatusUnauthorized)
                return
            }

            tokenStr := parts[1]
            claims := &Claims{}

            token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
                if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
                    return nil, errors.New("unexpected signing method")
                }
                return signingKey, nil
            })

            if err != nil || !token.Valid {
                http.Error(w, "invalid or expired token", http.StatusUnauthorized)
                return
            }

            if time.Now().After(claims.ExpiresAt.Time) {
                http.Error(w, "token expired", http.StatusUnauthorized)
                return
            }

            ctx := context.WithValue(r.Context(), userClaimsKey, claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func GetUserClaims(ctx context.Context) (*Claims, bool) {
    claims, ok := ctx.Value(userClaimsKey).(*Claims)
    return claims, ok
}

func RequireRole(role string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims, ok := GetUserClaims(r.Context())
            if !ok {
                http.Error(w, "unauthorized", http.StatusUnauthorized)
                return
            }
            for _, r := range claims.Roles {
                if r == role {
                    next.ServeHTTP(w, r)  // role found
                    return
                }
            }
            http.Error(w, "forbidden", http.StatusForbidden)
        })
    }
}
```

### Timeout Middleware

```go
package middleware

import (
    "context"
    "net/http"
    "time"
)

func Timeout(duration time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), duration)
            defer cancel()

            done := make(chan struct{})
            panicCh := make(chan interface{}, 1)

            tw := &timeoutResponseWriter{
                ResponseWriter: w,
                done:           done,
            }

            go func() {
                defer func() {
                    if p := recover(); p != nil {
                        panicCh <- p
                    }
                }()
                next.ServeHTTP(tw, r.WithContext(ctx))
                close(done)
            }()

            select {
            case <-done:
                // Handler completed normally
            case p := <-panicCh:
                panic(p)
            case <-ctx.Done():
                tw.mu.Lock()
                defer tw.mu.Unlock()
                if !tw.wroteHeader {
                    w.WriteHeader(http.StatusServiceUnavailable)
                    w.Write([]byte("request timeout"))
                }
            }
        })
    }
}

type timeoutResponseWriter struct {
    http.ResponseWriter
    mu          sync.Mutex
    done        chan struct{}
    wroteHeader bool
}

func (tw *timeoutResponseWriter) WriteHeader(code int) {
    tw.mu.Lock()
    defer tw.mu.Unlock()
    select {
    case <-tw.done:
        return // already timed out
    default:
        tw.wroteHeader = true
        tw.ResponseWriter.WriteHeader(code)
    }
}
```

### Rate Limiting Middleware

```go
package middleware

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type ipLimiter struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

type RateLimiter struct {
    mu       sync.RWMutex
    limiters map[string]*ipLimiter
    rate     rate.Limit
    burst    int
    cleanup  *time.Ticker
}

func NewRateLimiter(r rate.Limit, burst int) *RateLimiter {
    rl := &RateLimiter{
        limiters: make(map[string]*ipLimiter),
        rate:     r,
        burst:    burst,
        cleanup:  time.NewTicker(5 * time.Minute),
    }
    go rl.cleanupLoop()
    return rl
}

func (rl *RateLimiter) cleanupLoop() {
    for range rl.cleanup.C {
        rl.mu.Lock()
        for ip, l := range rl.limiters {
            if time.Since(l.lastSeen) > 10*time.Minute {
                delete(rl.limiters, ip)
            }
        }
        rl.mu.Unlock()
    }
}

func (rl *RateLimiter) getLimiter(ip string) *rate.Limiter {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    l, ok := rl.limiters[ip]
    if !ok {
        l = &ipLimiter{limiter: rate.NewLimiter(rl.rate, rl.burst)}
        rl.limiters[ip] = l
    }
    l.lastSeen = time.Now()
    return l.limiter
}

func (rl *RateLimiter) Middleware() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ip := r.RemoteAddr
            if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
                ip = strings.Split(forwarded, ",")[0]
            }

            limiter := rl.getLimiter(strings.TrimSpace(ip))
            if !limiter.Allow() {
                w.Header().Set("Retry-After", "60")
                http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 2: gRPC Interceptor Chains

gRPC uses interceptors rather than middleware, but the concept is identical. Interceptors wrap the handler invocation and can inspect or modify requests and responses.

### Unary Interceptors

A unary interceptor wraps single request-response RPCs:

```go
package interceptors

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
    "log/slog"
)

// LoggingInterceptor logs each RPC call with timing information
func LoggingInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        start := time.Now()

        resp, err := handler(ctx, req)

        code := codes.OK
        if err != nil {
            code = status.Code(err)
        }

        logger.Info("grpc call",
            "method", info.FullMethod,
            "code", code.String(),
            "duration_ms", time.Since(start).Milliseconds(),
        )

        return resp, err
    }
}

// RecoveryInterceptor catches panics and returns Internal error
func RecoveryInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp interface{}, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("panic in gRPC handler",
                    "method", info.FullMethod,
                    "panic", r,
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}

// AuthInterceptor validates JWT tokens from gRPC metadata
func AuthInterceptor(validator TokenValidator) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Skip auth for health checks
        if info.FullMethod == "/grpc.health.v1.Health/Check" {
            return handler(ctx, req)
        }

        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }

        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization token")
        }

        token := strings.TrimPrefix(tokens[0], "Bearer ")
        claims, err := validator.Validate(token)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
        }

        ctx = context.WithValue(ctx, claimsKey, claims)
        return handler(ctx, req)
    }
}
```

### Chaining Multiple gRPC Interceptors

gRPC's `grpc.ChainUnaryInterceptor` combines multiple interceptors:

```go
package main

import (
    "google.golang.org/grpc"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    grpc_prometheus "github.com/grpc-ecosystem/go-grpc-prometheus"
    "github.com/example/app/interceptors"
)

func newGRPCServer(logger *slog.Logger, validator interceptors.TokenValidator) *grpc.Server {
    return grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            interceptors.RecoveryInterceptor(logger),   // outermost: catches all panics
            interceptors.RequestIDInterceptor(),         // inject request ID
            interceptors.LoggingInterceptor(logger),    // log with request ID available
            otelgrpc.UnaryServerInterceptor(),          // OpenTelemetry tracing
            grpc_prometheus.UnaryServerInterceptor,     // Prometheus metrics
            interceptors.AuthInterceptor(validator),    // authenticate
            interceptors.RateLimitInterceptor(100),     // rate limit authenticated users
        ),
        grpc.ChainStreamInterceptor(
            interceptors.StreamRecoveryInterceptor(logger),
            interceptors.StreamLoggingInterceptor(logger),
            otelgrpc.StreamServerInterceptor(),
            grpc_prometheus.StreamServerInterceptor,
            interceptors.StreamAuthInterceptor(validator),
        ),
    )
}
```

### Stream Interceptors

Stream interceptors handle bidirectional and server/client streaming RPCs:

```go
package interceptors

import (
    "context"

    "google.golang.org/grpc"
    "log/slog"
    "time"
)

// wrappedStream wraps grpc.ServerStream to intercept individual messages
type wrappedStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
    return w.ctx
}

func StreamLoggingInterceptor(logger *slog.Logger) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()

        requestID := generateRequestID()
        ctx := context.WithValue(ss.Context(), requestIDKey, requestID)
        wrapped := &wrappedStream{ServerStream: ss, ctx: ctx}

        err := handler(srv, wrapped)

        logger.Info("grpc stream",
            "method", info.FullMethod,
            "request_id", requestID,
            "client_stream", info.IsClientStream,
            "server_stream", info.IsServerStream,
            "duration_ms", time.Since(start).Milliseconds(),
            "error", err,
        )

        return err
    }
}
```

### gRPC Client Interceptors

Client-side interceptors add headers and handle retries:

```go
package interceptors

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/codes"
)

// PropagateRequestIDClientInterceptor forwards request ID to downstream services
func PropagateRequestIDClientInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        if requestID, ok := ctx.Value(requestIDKey).(string); ok {
            ctx = metadata.AppendToOutgoingContext(ctx, "x-request-id", requestID)
        }
        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// RetryInterceptor retries on transient failures with exponential backoff
func RetryInterceptor(maxRetries int) grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        retryableCodes := map[codes.Code]bool{
            codes.Unavailable:     true,
            codes.ResourceExhausted: true,
        }

        var lastErr error
        for attempt := 0; attempt <= maxRetries; attempt++ {
            if attempt > 0 {
                backoff := time.Duration(attempt*attempt) * 100 * time.Millisecond
                select {
                case <-time.After(backoff):
                case <-ctx.Done():
                    return ctx.Err()
                }
            }

            lastErr = invoker(ctx, method, req, reply, cc, opts...)
            if lastErr == nil {
                return nil
            }

            if code := status.Code(lastErr); !retryableCodes[code] {
                return lastErr
            }
        }
        return lastErr
    }
}
```

## Section 3: Database Middleware

### Query Logging with sqlx

```go
package dbmiddleware

import (
    "context"
    "database/sql/driver"
    "fmt"
    "log/slog"
    "time"
)

// LoggingDriver wraps a database driver with query logging
type LoggingDriver struct {
    driver.Driver
    logger *slog.Logger
}

type LoggingConn struct {
    driver.Conn
    logger *slog.Logger
}

type LoggingStmt struct {
    driver.Stmt
    query  string
    logger *slog.Logger
}

func (s *LoggingStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
    start := time.Now()
    result, err := s.Stmt.(driver.StmtExecContext).ExecContext(ctx, args)
    s.logger.Debug("db exec",
        "query", s.query,
        "args_count", len(args),
        "duration_ms", time.Since(start).Milliseconds(),
        "error", err,
        "request_id", ctx.Value(requestIDKey),
    )
    return result, err
}

func (s *LoggingStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
    start := time.Now()
    rows, err := s.Stmt.(driver.StmtQueryContext).QueryContext(ctx, args)
    s.logger.Debug("db query",
        "query", s.query,
        "args_count", len(args),
        "duration_ms", time.Since(start).Milliseconds(),
        "error", err,
        "request_id", ctx.Value(requestIDKey),
    )
    return rows, err
}
```

### Using sqlhooks for Cleaner Query Middleware

```go
package dbmiddleware

import (
    "context"
    "database/sql"
    "log/slog"
    "time"

    "github.com/qustavo/sqlhooks/v2"
    _ "github.com/lib/pq"
)

type Hooks struct {
    logger *slog.Logger
}

type queryContextKey string
const queryStartKey queryContextKey = "query_start"

func (h *Hooks) Before(ctx context.Context, query string, args ...interface{}) (context.Context, error) {
    return context.WithValue(ctx, queryStartKey, time.Now()), nil
}

func (h *Hooks) After(ctx context.Context, query string, args ...interface{}) (context.Context, error) {
    start, _ := ctx.Value(queryStartKey).(time.Time)
    h.logger.Debug("sql query",
        "query", query,
        "duration_ms", time.Since(start).Milliseconds(),
        "request_id", GetRequestID(ctx),
    )
    return ctx, nil
}

func (h *Hooks) OnError(ctx context.Context, err error, query string, args ...interface{}) error {
    start, _ := ctx.Value(queryStartKey).(time.Time)
    h.logger.Error("sql error",
        "query", query,
        "duration_ms", time.Since(start).Milliseconds(),
        "error", err,
        "request_id", GetRequestID(ctx),
    )
    return err
}

func NewInstrumentedDB(dsn string, logger *slog.Logger) (*sql.DB, error) {
    // Register custom driver
    sql.Register("postgres-instrumented",
        sqlhooks.Wrap(
            &pq.Driver{},
            &Hooks{logger: logger},
        ),
    )
    return sql.Open("postgres-instrumented", dsn)
}
```

### Circuit Breaker Middleware

```go
package dbmiddleware

import (
    "context"
    "errors"
    "sync"
    "time"
)

type State int

const (
    StateClosed   State = iota // Normal operation
    StateHalfOpen              // Testing if the circuit can be closed
    StateOpen                  // Failing fast
)

type CircuitBreaker struct {
    mu              sync.RWMutex
    state           State
    failures        int
    successes       int
    lastFailureTime time.Time

    maxFailures      int
    resetTimeout     time.Duration
    halfOpenRequests int
}

var ErrCircuitOpen = errors.New("circuit breaker is open")

func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        maxFailures:      maxFailures,
        resetTimeout:     resetTimeout,
        halfOpenRequests: 3,
    }
}

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    if err := cb.allowRequest(); err != nil {
        return err
    }

    err := fn(ctx)
    cb.recordResult(err)
    return err
}

func (cb *CircuitBreaker) allowRequest() error {
    cb.mu.RLock()
    state := cb.state
    lastFailure := cb.lastFailureTime
    cb.mu.RUnlock()

    switch state {
    case StateClosed:
        return nil
    case StateOpen:
        if time.Since(lastFailure) > cb.resetTimeout {
            cb.mu.Lock()
            if cb.state == StateOpen {
                cb.state = StateHalfOpen
                cb.successes = 0
            }
            cb.mu.Unlock()
            return nil
        }
        return ErrCircuitOpen
    case StateHalfOpen:
        return nil
    }
    return nil
}

func (cb *CircuitBreaker) recordResult(err error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.failures++
        cb.lastFailureTime = time.Now()

        if cb.state == StateHalfOpen || cb.failures >= cb.maxFailures {
            cb.state = StateOpen
            cb.failures = 0
        }
    } else {
        switch cb.state {
        case StateHalfOpen:
            cb.successes++
            if cb.successes >= cb.halfOpenRequests {
                cb.state = StateClosed
                cb.failures = 0
                cb.successes = 0
            }
        case StateClosed:
            cb.failures = 0
        }
    }
}

// DB wraps sql.DB with circuit breaker and retry logic
type DB struct {
    db      *sql.DB
    cb      *CircuitBreaker
    retries int
}

func NewDB(db *sql.DB, maxFailures int, resetTimeout time.Duration) *DB {
    return &DB{
        db:      db,
        cb:      NewCircuitBreaker(maxFailures, resetTimeout),
        retries: 3,
    }
}

func (d *DB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
    var rows *sql.Rows
    err := d.cb.Execute(ctx, func(ctx context.Context) error {
        var execErr error
        rows, execErr = d.db.QueryContext(ctx, query, args...)
        return execErr
    })
    return rows, err
}

func (d *DB) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
    var result sql.Result
    err := d.cb.Execute(ctx, func(ctx context.Context) error {
        var execErr error
        result, execErr = d.db.ExecContext(ctx, query, args...)
        return execErr
    })
    return result, err
}
```

### Slow Query Detection

```go
package dbmiddleware

import (
    "context"
    "log/slog"
    "time"
)

type SlowQueryMiddleware struct {
    threshold time.Duration
    logger    *slog.Logger
    next      QueryExecutor
}

type QueryExecutor interface {
    QueryContext(ctx context.Context, query string, args ...interface{}) (RowScanner, error)
    ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
}

func NewSlowQueryMiddleware(threshold time.Duration, logger *slog.Logger, next QueryExecutor) *SlowQueryMiddleware {
    return &SlowQueryMiddleware{
        threshold: threshold,
        logger:    logger,
        next:      next,
    }
}

func (m *SlowQueryMiddleware) QueryContext(ctx context.Context, query string, args ...interface{}) (RowScanner, error) {
    start := time.Now()
    rows, err := m.next.QueryContext(ctx, query, args...)
    elapsed := time.Since(start)

    if elapsed > m.threshold {
        m.logger.Warn("slow query detected",
            "query", query,
            "duration_ms", elapsed.Milliseconds(),
            "threshold_ms", m.threshold.Milliseconds(),
            "request_id", GetRequestID(ctx),
        )
    }
    return rows, err
}
```

## Section 4: Context Propagation Across Middleware

Context propagation ensures that metadata flows from the HTTP edge to the database, through gRPC calls, and into logs.

### Context Value Types

```go
package ctxutil

import "context"

// Use unexported types to prevent key collisions
type contextKey int

const (
    keyRequestID contextKey = iota
    keyUserID
    keyTraceID
    keySpanID
    keyTenantID
)

type ContextValue struct {
    RequestID string
    UserID    string
    TraceID   string
    SpanID    string
    TenantID  string
}

func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, keyRequestID, id)
}

func RequestIDFrom(ctx context.Context) string {
    s, _ := ctx.Value(keyRequestID).(string)
    return s
}

func WithUserID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, keyUserID, id)
}

func UserIDFrom(ctx context.Context) string {
    s, _ := ctx.Value(keyUserID).(string)
    return s
}

// Extract builds a ContextValue from context for logging
func Extract(ctx context.Context) ContextValue {
    return ContextValue{
        RequestID: RequestIDFrom(ctx),
        UserID:    UserIDFrom(ctx),
        TraceID:   TraceIDFrom(ctx),
        SpanID:    SpanIDFrom(ctx),
        TenantID:  TenantIDFrom(ctx),
    }
}
```

### Propagating Context to Downstream gRPC Calls

```go
package interceptors

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    "github.com/example/app/ctxutil"
)

// ForwardContextInterceptor propagates context values as gRPC metadata
func ForwardContextInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        pairs := []string{}

        if id := ctxutil.RequestIDFrom(ctx); id != "" {
            pairs = append(pairs, "x-request-id", id)
        }
        if id := ctxutil.UserIDFrom(ctx); id != "" {
            pairs = append(pairs, "x-user-id", id)
        }
        if id := ctxutil.TenantIDFrom(ctx); id != "" {
            pairs = append(pairs, "x-tenant-id", id)
        }

        if len(pairs) > 0 {
            ctx = metadata.AppendToOutgoingContext(ctx, pairs...)
        }
        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// ExtractContextInterceptor extracts metadata from incoming gRPC calls
func ExtractContextInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if md, ok := metadata.FromIncomingContext(ctx); ok {
            if ids := md.Get("x-request-id"); len(ids) > 0 {
                ctx = ctxutil.WithRequestID(ctx, ids[0])
            }
            if ids := md.Get("x-user-id"); len(ids) > 0 {
                ctx = ctxutil.WithUserID(ctx, ids[0])
            }
            if ids := md.Get("x-tenant-id"); len(ids) > 0 {
                ctx = ctxutil.WithTenantID(ctx, ids[0])
            }
        }
        return handler(ctx, req)
    }
}
```

### Structured Logging with Context

```go
package middleware

import (
    "context"
    "log/slog"
    "net/http"

    "github.com/example/app/ctxutil"
)

// ContextLogger creates a slog.Logger enriched with context values
func ContextLogger(base *slog.Logger, ctx context.Context) *slog.Logger {
    cv := ctxutil.Extract(ctx)
    return base.With(
        "request_id", cv.RequestID,
        "user_id", cv.UserID,
        "trace_id", cv.TraceID,
        "tenant_id", cv.TenantID,
    )
}

// InjectLoggerMiddleware stores a context-enriched logger in the request context
func InjectLoggerMiddleware(base *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            logger := ContextLogger(base, r.Context())
            ctx := context.WithValue(r.Context(), loggerKey, logger)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func LoggerFrom(ctx context.Context) *slog.Logger {
    if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
        return l
    }
    return slog.Default()
}
```

## Section 5: Composing the Full Stack

### Complete HTTP Server with All Middleware

```go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/app/ctxutil"
    "github.com/example/app/dbmiddleware"
    "github.com/example/app/interceptors"
    "github.com/example/app/middleware"
    "golang.org/x/time/rate"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Database setup with middleware
    rawDB, err := dbmiddleware.NewInstrumentedDB(os.Getenv("DATABASE_URL"), logger)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }

    db := dbmiddleware.NewDB(
        rawDB,
        5,             // open circuit after 5 failures
        time.Minute,   // reset after 1 minute
    )

    db = dbmiddleware.NewSlowQueryMiddleware(
        200*time.Millisecond,
        logger,
        db,
    )

    // gRPC client
    grpcConn, err := grpc.Dial(
        os.Getenv("DOWNSTREAM_SERVICE"),
        grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
        grpc.WithChainUnaryInterceptor(
            interceptors.ForwardContextInterceptor(),
            interceptors.PropagateRequestIDClientInterceptor(),
            interceptors.RetryInterceptor(3),
            otelgrpc.UnaryClientInterceptor(),
        ),
    )
    if err != nil {
        logger.Error("failed to connect to downstream service", "error", err)
        os.Exit(1)
    }

    // HTTP middleware chain
    rl := middleware.NewRateLimiter(rate.Limit(100), 200)

    base := middleware.NewChain(
        middleware.RealIP(),
        middleware.RequestID(),
        middleware.InjectLoggerMiddleware(logger),
        middleware.Logger(logger),
        middleware.Recover(logger),
        middleware.Timeout(30*time.Second),
    )

    authenticated := base.Append(
        middleware.JWTAuth([]byte(os.Getenv("JWT_SECRET"))),
        rl.Middleware(),
    )

    // Routes
    mux := http.NewServeMux()
    mux.Handle("/health", base.ThenFunc(healthHandler))
    mux.Handle("/api/v1/orders", authenticated.ThenFunc(makeOrdersHandler(db, grpcConn)))
    mux.Handle("/api/v1/users", authenticated.Append(
        middleware.RequireRole("admin"),
    ).ThenFunc(makeUsersHandler(db)))

    // Server with graceful shutdown
    srv := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    go func() {
        logger.Info("starting HTTP server", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("HTTP server error", "error", err)
            os.Exit(1)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    logger.Info("shutting down server")
    if err := srv.Shutdown(ctx); err != nil {
        logger.Error("forced shutdown", "error", err)
    }
}
```

### Testing Middleware

```go
package middleware_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/example/app/middleware"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestRequestIDMiddleware(t *testing.T) {
    handler := middleware.RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := middleware.GetRequestID(r.Context())
        assert.NotEmpty(t, id, "request ID should be set in context")
        w.Header().Set("X-Got-ID", id)
        w.WriteHeader(http.StatusOK)
    }))

    t.Run("generates new request ID when header absent", func(t *testing.T) {
        req := httptest.NewRequest(http.MethodGet, "/", nil)
        rr := httptest.NewRecorder()
        handler.ServeHTTP(rr, req)

        assert.Equal(t, http.StatusOK, rr.Code)
        assert.NotEmpty(t, rr.Header().Get("X-Request-ID"))
    })

    t.Run("preserves incoming request ID", func(t *testing.T) {
        req := httptest.NewRequest(http.MethodGet, "/", nil)
        req.Header.Set("X-Request-ID", "test-id-123")
        rr := httptest.NewRecorder()
        handler.ServeHTTP(rr, req)

        assert.Equal(t, "test-id-123", rr.Header().Get("X-Request-ID"))
        assert.Equal(t, "test-id-123", rr.Header().Get("X-Got-ID"))
    })
}

func TestTimeoutMiddleware(t *testing.T) {
    slowHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        select {
        case <-r.Context().Done():
            return
        case <-time.After(5 * time.Second):
            w.WriteHeader(http.StatusOK)
        }
    })

    handler := middleware.Timeout(100 * time.Millisecond)(slowHandler)

    req := httptest.NewRequest(http.MethodGet, "/", nil)
    rr := httptest.NewRecorder()

    start := time.Now()
    handler.ServeHTTP(rr, req)
    elapsed := time.Since(start)

    assert.Equal(t, http.StatusServiceUnavailable, rr.Code)
    assert.Less(t, elapsed, 500*time.Millisecond, "should have timed out quickly")
}

func TestCircuitBreaker(t *testing.T) {
    cb := dbmiddleware.NewCircuitBreaker(3, time.Minute)

    alwaysFail := func(ctx context.Context) error {
        return errors.New("connection refused")
    }

    // Trip the circuit
    for i := 0; i < 3; i++ {
        _ = cb.Execute(context.Background(), alwaysFail)
    }

    // Circuit should be open now
    err := cb.Execute(context.Background(), alwaysFail)
    require.Error(t, err)
    assert.Equal(t, dbmiddleware.ErrCircuitOpen, err)
}
```

## Summary

Effective Go middleware requires consistent patterns across all transport layers. HTTP middleware chains via `func(http.Handler) http.Handler` closures, gRPC interceptors via `grpc.ChainUnaryInterceptor`, and database middleware through driver wrapping or hook interfaces all follow the same interceptor principle.

Critical production considerations:
- Always propagate context through every layer — request ID, trace ID, user ID
- Implement circuit breakers on external database and service calls
- Place recovery middleware at the outermost position to catch panics from all inner layers
- Timeout middleware must wrap the goroutine to truly enforce the deadline
- Test middleware in isolation with `httptest.NewRecorder` for HTTP and mock handlers for gRPC
- Keep middleware stateless where possible; manage any state thread-safely with sync primitives
