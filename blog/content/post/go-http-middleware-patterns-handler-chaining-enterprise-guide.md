---
title: "Go HTTP Middleware Patterns: Handler Chaining, Context Values, Request ID Propagation, Panic Recovery, Timeouts"
date: 2031-11-29T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "HTTP", "Middleware", "Web Development", "Context", "Production Patterns"]
categories:
- Go
- Web Development
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete reference for Go HTTP middleware engineering: composable handler chains, type-safe context value patterns, request ID propagation across service boundaries, panic recovery with structured logging, and timeout/deadline management."
more_link: "yes"
url: "/go-http-middleware-patterns-handler-chaining-enterprise-guide/"
---

Go's `net/http` package deliberately provides a minimal foundation. The `http.Handler` interface—a single method accepting `ResponseWriter` and `*Request`—is enough to build arbitrarily complex middleware stacks. This simplicity is a feature: it forces explicit composition and makes the request pipeline legible. This guide covers the canonical patterns used in production Go services: handler chaining, context value discipline, cross-service request ID propagation, production-safe panic recovery, and timeout management.

<!--more-->

# Go HTTP Middleware Patterns: Production Engineering Guide

## The Handler Interface Foundation

```go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}

type HandlerFunc func(ResponseWriter, *Request)

func (f HandlerFunc) ServeHTTP(w ResponseWriter, r *Request) {
    f(w, r)
}
```

The key insight: any function with the signature `func(http.ResponseWriter, *http.Request)` can be converted to a `Handler`. Middleware wraps one `Handler` with another, forming a chain.

## Section 1: Handler Chaining Patterns

### The Middleware Type

Define middleware as a function from Handler to Handler:

```go
// Middleware is a function that wraps an HTTP handler.
type Middleware func(http.Handler) http.Handler
```

This definition enables clean function composition:

```go
// Chain applies middlewares in order (first middleware is outermost)
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
    // Apply in reverse order so first middleware is called first
    for i := len(middlewares) - 1; i >= 0; i-- {
        h = middlewares[i](h)
    }
    return h
}

// Usage
handler := Chain(
    http.HandlerFunc(myBusinessLogic),
    RequestID(),
    Logging(),
    Tracing(),
    RateLimit(100),
    Timeout(30*time.Second),
    PanicRecovery(),
)
```

### Router-Level Middleware with Standard Mux

```go
package server

import (
    "net/http"
)

type Server struct {
    mux    *http.ServeMux
    global []Middleware
}

func NewServer() *Server {
    return &Server{
        mux: http.NewServeMux(),
    }
}

func (s *Server) Use(m ...Middleware) {
    s.global = append(s.global, m...)
}

func (s *Server) Handle(pattern string, h http.Handler, extra ...Middleware) {
    // Apply route-specific middleware on top of global middleware
    all := append(s.global, extra...)
    s.mux.Handle(pattern, Chain(h, all...))
}

func (s *Server) HandleFunc(pattern string, fn http.HandlerFunc, extra ...Middleware) {
    s.Handle(pattern, fn, extra...)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    s.mux.ServeHTTP(w, r)
}
```

### Middleware with State (Constructor Pattern)

```go
// RateLimit returns a middleware that limits requests per second
func RateLimit(rps float64) Middleware {
    limiter := rate.NewLimiter(rate.Limit(rps), int(rps*2)) // burst = 2x RPS

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !limiter.Allow() {
                w.Header().Set("Retry-After", "1")
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 2: Context Values — Type Safety and Discipline

### The Context Key Anti-Pattern

Using primitive types as context keys causes silent collisions:

```go
// BAD: string keys collide across packages
ctx = context.WithValue(ctx, "userID", "u123")
ctx = context.WithValue(ctx, "requestID", "req456")

// These values can be overwritten by any package using the same string key
userID := ctx.Value("userID") // Could return wrong value
```

### The Correct Pattern: Unexported Key Types

```go
package ctxkeys

// Define an unexported type for each key. Using a struct type
// ensures zero risk of collision with other packages.
type contextKey struct{ name string }

var (
    RequestIDKey  = &contextKey{"requestID"}
    UserIDKey     = &contextKey{"userID"}
    TenantIDKey   = &contextKey{"tenantID"}
    TraceIDKey    = &contextKey{"traceID"}
    ClientIPKey   = &contextKey{"clientIP"}
    LoggerKey     = &contextKey{"logger"}
)
```

### Typed Accessors

Expose typed getters and setters rather than raw `context.WithValue`:

```go
package ctxkeys

import (
    "context"
    "github.com/google/uuid"
)

// RequestID helpers

func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, RequestIDKey, id)
}

func RequestIDFromContext(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(RequestIDKey).(string)
    return id, ok
}

func MustRequestID(ctx context.Context) string {
    id, ok := RequestIDFromContext(ctx)
    if !ok {
        return uuid.NewString() // Fallback: generate new ID
    }
    return id
}

// User helpers

type User struct {
    ID       string
    Email    string
    TenantID string
    Roles    []string
}

func WithUser(ctx context.Context, u *User) context.Context {
    return context.WithValue(ctx, UserIDKey, u)
}

func UserFromContext(ctx context.Context) (*User, bool) {
    u, ok := ctx.Value(UserIDKey).(*User)
    return u, ok
}
```

### Logger in Context

Passing a logger through context is one of the most useful patterns in large services—it enables per-request log fields without changing function signatures:

```go
package ctxkeys

import (
    "context"
    "log/slog"
    "os"
)

var defaultLogger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))

func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
    return context.WithValue(ctx, LoggerKey, l)
}

func LoggerFromContext(ctx context.Context) *slog.Logger {
    if l, ok := ctx.Value(LoggerKey).(*slog.Logger); ok {
        return l
    }
    return defaultLogger
}

// L is a shorthand for LoggerFromContext
func L(ctx context.Context) *slog.Logger {
    return LoggerFromContext(ctx)
}
```

## Section 3: Request ID Propagation

### Standards for Request ID Headers

| Header | Origin | Notes |
|--------|--------|-------|
| `X-Request-ID` | Custom (Nginx, AWS ALB) | Most common in practice |
| `X-Correlation-ID` | Custom | Common in enterprise/ESB environments |
| `traceparent` | W3C Trace Context | OTel standard, carries trace+span ID |
| `X-B3-TraceId` | Zipkin B3 | Legacy, still used in many services |

Production recommendation: accept `X-Request-ID` for incoming requests and inject it plus `traceparent` for downstream calls.

### Request ID Middleware

```go
package middleware

import (
    "context"
    "net/http"

    "github.com/google/uuid"
    "github.com/yourorg/service/internal/ctxkeys"
)

const (
    RequestIDHeader     = "X-Request-ID"
    CorrelationIDHeader = "X-Correlation-ID"
)

// RequestID extracts an existing request ID from incoming headers,
// or generates a new UUID if none is present. The ID is stored in
// the request context and echoed back in the response headers.
func RequestID() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Try to extract existing ID from common headers
            id := r.Header.Get(RequestIDHeader)
            if id == "" {
                id = r.Header.Get(CorrelationIDHeader)
            }
            if id == "" {
                id = uuid.NewString()
            }

            // Store in context
            ctx := ctxkeys.WithRequestID(r.Context(), id)

            // Enrich logger with request ID
            log := ctxkeys.LoggerFromContext(ctx).With(
                "request_id", id,
                "method", r.Method,
                "path", r.URL.Path,
            )
            ctx = ctxkeys.WithLogger(ctx, log)

            // Echo back in response
            w.Header().Set(RequestIDHeader, id)

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Propagating Request ID to Downstream HTTP Calls

```go
package httpclient

import (
    "context"
    "net/http"

    "github.com/yourorg/service/internal/ctxkeys"
)

// ContextTransport injects trace context headers into outgoing HTTP requests.
type ContextTransport struct {
    Base http.RoundTripper
}

func (t *ContextTransport) RoundTrip(r *http.Request) (*http.Response, error) {
    base := t.Base
    if base == nil {
        base = http.DefaultTransport
    }

    // Clone the request to avoid mutating the original
    outgoing := r.Clone(r.Context())

    // Propagate request ID
    if id, ok := ctxkeys.RequestIDFromContext(r.Context()); ok {
        outgoing.Header.Set("X-Request-ID", id)
    }

    // Propagate tenant ID for multi-tenant services
    if u, ok := ctxkeys.UserFromContext(r.Context()); ok {
        outgoing.Header.Set("X-Tenant-ID", u.TenantID)
    }

    return base.RoundTrip(outgoing)
}

// NewClient creates an HTTP client that automatically propagates context values.
func NewClient(timeout time.Duration) *http.Client {
    return &http.Client{
        Timeout: timeout,
        Transport: &ContextTransport{
            Base: &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 10,
                IdleConnTimeout:     90 * time.Second,
            },
        },
    }
}
```

### gRPC Request ID Propagation

For services using gRPC internally:

```go
package grpcmeta

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"

    "github.com/yourorg/service/internal/ctxkeys"
)

const RequestIDMetadataKey = "x-request-id"

// UnaryClientInterceptor propagates request ID to gRPC outgoing calls.
func UnaryClientInterceptor(
    ctx context.Context,
    method string,
    req, reply interface{},
    cc *grpc.ClientConn,
    invoker grpc.UnaryInvoker,
    opts ...grpc.CallOption,
) error {
    if id, ok := ctxkeys.RequestIDFromContext(ctx); ok {
        ctx = metadata.AppendToOutgoingContext(ctx, RequestIDMetadataKey, id)
    }
    return invoker(ctx, method, req, reply, cc, opts...)
}

// UnaryServerInterceptor extracts request ID from gRPC incoming metadata.
func UnaryServerInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    if md, ok := metadata.FromIncomingContext(ctx); ok {
        if ids := md.Get(RequestIDMetadataKey); len(ids) > 0 {
            ctx = ctxkeys.WithRequestID(ctx, ids[0])
        }
    }
    return handler(ctx, req)
}
```

## Section 4: Panic Recovery

### Why panic Recovery Is Critical

A panicking goroutine crashes the entire process by default. For HTTP servers, Go's `net/http` package already recovers panics in individual request goroutines—but only logs them to stderr. A production middleware needs to:

1. Recover the panic
2. Log the stack trace with the request ID and structured fields
3. Return a 500 response (not leak internal details)
4. Increment a panic counter for alerting
5. Optionally notify an error tracking system

### Production Panic Recovery Middleware

```go
package middleware

import (
    "fmt"
    "net/http"
    "runtime"
    "runtime/debug"
    "strings"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/yourorg/service/internal/ctxkeys"
)

var panicTotal = promauto.NewCounterVec(prometheus.CounterOpts{
    Name: "http_handler_panics_total",
    Help: "Total number of panics recovered in HTTP handlers",
}, []string{"path"})

// PanicRecovery recovers from panics in HTTP handlers, logs the stack trace,
// increments metrics, and returns a 500 response.
func PanicRecovery() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if rec := recover(); rec != nil {
                    log := ctxkeys.LoggerFromContext(r.Context())

                    // Collect stack trace
                    stack := debug.Stack()

                    // Normalize panic value to error string
                    var panicStr string
                    switch v := rec.(type) {
                    case error:
                        panicStr = v.Error()
                    case string:
                        panicStr = v
                    default:
                        panicStr = fmt.Sprintf("%v", v)
                    }

                    // Log with full context
                    log.Error("handler panic recovered",
                        "panic_value", panicStr,
                        "stack_trace", string(stack),
                        "method", r.Method,
                        "path", r.URL.Path,
                        "remote_addr", r.RemoteAddr,
                    )

                    // Increment panic counter
                    panicTotal.WithLabelValues(normalizePath(r.URL.Path)).Inc()

                    // Don't send panic details to the client
                    if !isResponseStarted(w) {
                        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
                    }
                }
            }()

            next.ServeHTTP(w, r)
        })
    }
}

// normalizePath removes variable path segments for metric cardinality control
func normalizePath(path string) string {
    // Replace numeric segments with {id}
    parts := strings.Split(path, "/")
    for i, p := range parts {
        if isNumeric(p) || isUUID(p) {
            parts[i] = "{id}"
        }
    }
    return strings.Join(parts, "/")
}

func isNumeric(s string) bool {
    for _, c := range s {
        if c < '0' || c > '9' {
            return false
        }
    }
    return len(s) > 0
}

func isUUID(s string) bool {
    // Simple UUID detection: 8-4-4-4-12 hex chars
    return len(s) == 36 && s[8] == '-' && s[13] == '-'
}
```

### ResponseWriter Wrapper for Status Detection

```go
// responseWriter wraps http.ResponseWriter to track whether the response
// has been started (headers sent) and capture the status code.
type responseWriter struct {
    http.ResponseWriter
    statusCode int
    written    bool
    size       int
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
    return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
    if !rw.written {
        rw.statusCode = code
        rw.written = true
        rw.ResponseWriter.WriteHeader(code)
    }
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    if !rw.written {
        rw.WriteHeader(http.StatusOK)
    }
    n, err := rw.ResponseWriter.Write(b)
    rw.size += n
    return n, err
}

// Unwrap returns the underlying ResponseWriter (required for http.Flusher, etc.)
func (rw *responseWriter) Unwrap() http.ResponseWriter {
    return rw.ResponseWriter
}

func isResponseStarted(w http.ResponseWriter) bool {
    if rw, ok := w.(*responseWriter); ok {
        return rw.written
    }
    return false
}
```

## Section 5: Structured Logging Middleware

```go
package middleware

import (
    "net/http"
    "time"

    "github.com/yourorg/service/internal/ctxkeys"
)

// Logging records structured request/response logs with timing.
// Must be placed after RequestID() to include the request ID in logs.
func Logging() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            log := ctxkeys.LoggerFromContext(r.Context())

            log.Info("request started",
                "method", r.Method,
                "path", r.URL.Path,
                "query", r.URL.RawQuery,
                "content_length", r.ContentLength,
                "user_agent", r.UserAgent(),
                "remote_addr", r.RemoteAddr,
            )

            wrapped := newResponseWriter(w)
            next.ServeHTTP(wrapped, r)

            duration := time.Since(start)
            log.Info("request completed",
                "status", wrapped.statusCode,
                "response_size", wrapped.size,
                "duration_ms", duration.Milliseconds(),
                "duration_ns", duration.Nanoseconds(),
            )

            // Record metrics
            httpRequestsTotal.WithLabelValues(
                r.Method,
                normalizePath(r.URL.Path),
                fmt.Sprintf("%d", wrapped.statusCode),
            ).Inc()

            httpRequestDuration.WithLabelValues(
                r.Method,
                normalizePath(r.URL.Path),
            ).Observe(duration.Seconds())
        })
    }
}
```

## Section 6: Timeout and Deadline Middleware

### The Two Timeout Problems

```
Problem 1: Request handler hangs (infinite wait on DB, downstream service)
  Solution: context.WithTimeout propagated to all operations

Problem 2: Slow client (writing response takes forever)
  Solution: http.TimeoutHandler wraps the entire handler including writes

Both are needed for full protection.
```

### Context Timeout Middleware

```go
package middleware

import (
    "context"
    "net/http"
    "time"
)

// Timeout adds a request-scoped context deadline to each request.
// Handlers should check ctx.Done() and propagate the context to
// all downstream calls (DB queries, HTTP calls, etc.).
func Timeout(d time.Duration) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), d)
            defer cancel()

            // Use http.TimeoutHandler for response write timeout
            // This properly aborts the response if the deadline is exceeded
            timedHandler := http.TimeoutHandler(
                http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                    next.ServeHTTP(w, r.WithContext(ctx))
                }),
                d,
                `{"error":"request timeout"}`,
            )
            timedHandler.ServeHTTP(w, r)
        })
    }
}
```

### Per-Route Timeout Configuration

Different routes need different timeouts:

```go
type RouteTimeoutConfig struct {
    Default  time.Duration
    ByPrefix map[string]time.Duration
}

func AdaptiveTimeout(cfg RouteTimeoutConfig) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            timeout := cfg.Default
            for prefix, d := range cfg.ByPrefix {
                if strings.HasPrefix(r.URL.Path, prefix) {
                    timeout = d
                    break
                }
            }

            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// Usage
handler := Chain(
    http.HandlerFunc(router.ServeHTTP),
    AdaptiveTimeout(RouteTimeoutConfig{
        Default: 10 * time.Second,
        ByPrefix: map[string]time.Duration{
            "/api/v1/export":  120 * time.Second,  // Long-running export
            "/api/v1/search":  30 * time.Second,   // Search may be slow
            "/health":         2 * time.Second,    // Health checks must be fast
        },
    }),
)
```

### Downstream Timeout Propagation

```go
// DatabaseQuery propagates the context deadline to the DB driver.
// This is the most important pattern: if the HTTP request times out,
// the DB query is cancelled too (preventing resource accumulation).
func (s *Service) GetUserByID(ctx context.Context, id string) (*User, error) {
    // context.WithTimeout adds a 5s deadline IF the parent context
    // doesn't already have a shorter deadline
    queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    var user User
    err := s.db.QueryRowContext(queryCtx,
        "SELECT id, email, tenant_id FROM users WHERE id = $1",
        id,
    ).Scan(&user.ID, &user.Email, &user.TenantID)

    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            return nil, fmt.Errorf("database timeout querying user %s: %w", id, err)
        }
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("querying user %s: %w", id, err)
    }
    return &user, nil
}
```

## Section 7: Authentication and Authorization Middleware

### JWT Authentication

```go
package middleware

import (
    "crypto/rsa"
    "fmt"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "github.com/yourorg/service/internal/ctxkeys"
)

type JWTConfig struct {
    PublicKey    *rsa.PublicKey
    Issuer       string
    Audience     string
    AllowedRoles []string
}

type Claims struct {
    jwt.RegisteredClaims
    UserID   string   `json:"sub"`
    TenantID string   `json:"tid"`
    Email    string   `json:"email"`
    Roles    []string `json:"roles"`
}

func JWTAuth(cfg JWTConfig) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
                jsonError(w, "missing or invalid Authorization header", http.StatusUnauthorized)
                return
            }

            tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

            claims := &Claims{}
            token, err := jwt.ParseWithClaims(tokenStr, claims,
                func(t *jwt.Token) (interface{}, error) {
                    if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
                        return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
                    }
                    return cfg.PublicKey, nil
                },
                jwt.WithIssuer(cfg.Issuer),
                jwt.WithAudience(cfg.Audience),
                jwt.WithExpirationRequired(),
            )

            if err != nil || !token.Valid {
                ctxkeys.LoggerFromContext(r.Context()).Warn("invalid JWT",
                    "error", err,
                    "path", r.URL.Path,
                )
                jsonError(w, "invalid or expired token", http.StatusUnauthorized)
                return
            }

            // Store user in context
            ctx := ctxkeys.WithUser(r.Context(), &ctxkeys.User{
                ID:       claims.UserID,
                Email:    claims.Email,
                TenantID: claims.TenantID,
                Roles:    claims.Roles,
            })

            // Enrich logger with user context
            log := ctxkeys.LoggerFromContext(ctx).With(
                "user_id", claims.UserID,
                "tenant_id", claims.TenantID,
            )
            ctx = ctxkeys.WithLogger(ctx, log)

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func jsonError(w http.ResponseWriter, msg string, code int) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(code)
    fmt.Fprintf(w, `{"error":%q}`, msg)
}
```

### Role-Based Authorization

```go
// RequireRole returns a middleware that enforces RBAC.
// Must be placed after JWTAuth() so the user is in context.
func RequireRole(roles ...string) Middleware {
    roleSet := make(map[string]bool, len(roles))
    for _, r := range roles {
        roleSet[r] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user, ok := ctxkeys.UserFromContext(r.Context())
            if !ok {
                // JWTAuth should have run first
                jsonError(w, "authentication required", http.StatusUnauthorized)
                return
            }

            for _, role := range user.Roles {
                if roleSet[role] {
                    next.ServeHTTP(w, r)
                    return
                }
            }

            ctxkeys.LoggerFromContext(r.Context()).Warn("authorization denied",
                "user_id", user.ID,
                "required_roles", roles,
                "user_roles", user.Roles,
            )
            jsonError(w, "insufficient permissions", http.StatusForbidden)
        })
    }
}

// Usage
mux.Handle("/api/v1/admin/", Chain(
    adminHandler,
    JWTAuth(jwtConfig),
    RequireRole("admin", "super-admin"),
))
```

## Section 8: Rate Limiting with IP and User-Level Control

```go
package middleware

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
    "github.com/yourorg/service/internal/ctxkeys"
)

type RateLimitConfig struct {
    // Per-IP limits for anonymous requests
    IPRate  rate.Limit
    IPBurst int

    // Per-user limits for authenticated requests (higher allowance)
    UserRate  rate.Limit
    UserBurst int

    // Cleanup interval for stale entries
    CleanupInterval time.Duration
}

type rateLimiter struct {
    cfg     RateLimitConfig
    limiters sync.Map // key: string -> *rateLimiterEntry
}

type rateLimiterEntry struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

func NewRateLimiter(cfg RateLimitConfig) Middleware {
    rl := &rateLimiter{cfg: cfg}

    // Background cleanup goroutine
    go func() {
        ticker := time.NewTicker(cfg.CleanupInterval)
        defer ticker.Stop()
        for range ticker.C {
            cutoff := time.Now().Add(-cfg.CleanupInterval)
            rl.limiters.Range(func(k, v interface{}) bool {
                entry := v.(*rateLimiterEntry)
                if entry.lastSeen.Before(cutoff) {
                    rl.limiters.Delete(k)
                }
                return true
            })
        }
    }()

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            var key string
            var limiter *rate.Limiter

            if user, ok := ctxkeys.UserFromContext(r.Context()); ok {
                key = "user:" + user.ID
                entry := rl.getOrCreate(key, rl.cfg.UserRate, rl.cfg.UserBurst)
                limiter = entry.limiter
                entry.lastSeen = time.Now()
            } else {
                key = "ip:" + realIP(r)
                entry := rl.getOrCreate(key, rl.cfg.IPRate, rl.cfg.IPBurst)
                limiter = entry.limiter
                entry.lastSeen = time.Now()
            }

            if !limiter.Allow() {
                w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%.0f", float64(rl.cfg.IPRate)))
                w.Header().Set("Retry-After", "1")
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

func (rl *rateLimiter) getOrCreate(key string, r rate.Limit, burst int) *rateLimiterEntry {
    if v, ok := rl.limiters.Load(key); ok {
        return v.(*rateLimiterEntry)
    }
    entry := &rateLimiterEntry{
        limiter:  rate.NewLimiter(r, burst),
        lastSeen: time.Now(),
    }
    actual, _ := rl.limiters.LoadOrStore(key, entry)
    return actual.(*rateLimiterEntry)
}

func realIP(r *http.Request) string {
    if ip := r.Header.Get("X-Real-IP"); ip != "" {
        return ip
    }
    if ips := r.Header.Get("X-Forwarded-For"); ips != "" {
        return strings.Split(ips, ",")[0]
    }
    host, _, _ := net.SplitHostPort(r.RemoteAddr)
    return host
}
```

## Section 9: CORS Middleware

```go
package middleware

import (
    "net/http"
    "strings"
)

type CORSConfig struct {
    AllowedOrigins   []string
    AllowedMethods   []string
    AllowedHeaders   []string
    ExposedHeaders   []string
    AllowCredentials bool
    MaxAge           int
}

func CORS(cfg CORSConfig) Middleware {
    originsMap := make(map[string]bool)
    for _, o := range cfg.AllowedOrigins {
        originsMap[o] = true
    }

    methods := strings.Join(cfg.AllowedMethods, ", ")
    headers := strings.Join(cfg.AllowedHeaders, ", ")
    exposed := strings.Join(cfg.ExposedHeaders, ", ")

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")

            if origin != "" && (originsMap["*"] || originsMap[origin]) {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Vary", "Origin")

                if cfg.AllowCredentials {
                    w.Header().Set("Access-Control-Allow-Credentials", "true")
                }
                if exposed != "" {
                    w.Header().Set("Access-Control-Expose-Headers", exposed)
                }
            }

            if r.Method == http.MethodOptions {
                // Preflight request
                w.Header().Set("Access-Control-Allow-Methods", methods)
                w.Header().Set("Access-Control-Allow-Headers", headers)
                if cfg.MaxAge > 0 {
                    w.Header().Set("Access-Control-Max-Age", fmt.Sprintf("%d", cfg.MaxAge))
                }
                w.WriteHeader(http.StatusNoContent)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 10: Composing a Full Middleware Stack

### Complete Server Setup

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

    "github.com/yourorg/service/internal/ctxkeys"
    "github.com/yourorg/service/internal/middleware"
    "github.com/yourorg/service/internal/handlers"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    jwtConfig := middleware.JWTConfig{
        PublicKey: loadPublicKey("/etc/jwt/public.pem"),
        Issuer:   "https://auth.example.com",
        Audience: "api.example.com",
    }

    corsConfig := middleware.CORSConfig{
        AllowedOrigins:   []string{"https://app.example.com", "https://admin.example.com"},
        AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
        AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Request-ID"},
        ExposedHeaders:   []string{"X-Request-ID"},
        AllowCredentials: true,
        MaxAge:           3600,
    }

    rl := middleware.NewRateLimiter(middleware.RateLimitConfig{
        IPRate:          100,   // 100 req/s per IP (anonymous)
        IPBurst:         200,
        UserRate:        1000,  // 1000 req/s per user (authenticated)
        UserBurst:       2000,
        CleanupInterval: 5 * time.Minute,
    })

    // Build the public API handler
    apiMux := http.NewServeMux()
    apiMux.Handle("/api/v1/users/", handlers.Users())
    apiMux.Handle("/api/v1/products/", handlers.Products())

    publicHandler := middleware.Chain(
        apiMux,
        // Order: outermost to innermost
        middleware.PanicRecovery(),
        middleware.RequestID(),
        middleware.Logging(),
        middleware.CORS(corsConfig),
        middleware.Timeout(30*time.Second),
        rl,
    )

    // Admin routes: require authentication
    adminMux := http.NewServeMux()
    adminMux.Handle("/api/v1/admin/users", handlers.AdminUsers())
    adminMux.Handle("/api/v1/admin/config", handlers.AdminConfig())

    adminHandler := middleware.Chain(
        adminMux,
        middleware.PanicRecovery(),
        middleware.RequestID(),
        middleware.Logging(),
        middleware.Timeout(10*time.Second),
        middleware.JWTAuth(jwtConfig),
        middleware.RequireRole("admin"),
    )

    // Root mux
    root := http.NewServeMux()
    root.Handle("/api/v1/admin/", adminHandler)
    root.Handle("/api/v1/", publicHandler)
    root.Handle("/health", http.HandlerFunc(healthHandler))
    root.Handle("/metrics", promhttp.Handler())

    // Add request logger to root handler
    rootWithLogger := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := ctxkeys.WithLogger(r.Context(), logger)
        root.ServeHTTP(w, r.WithContext(ctx))
    })

    server := &http.Server{
        Addr:         ":8080",
        Handler:      rootWithLogger,
        ReadTimeout:  35 * time.Second,
        WriteTimeout: 35 * time.Second,
        IdleTimeout:  120 * time.Second,
        ErrorLog:     slog.NewLogLogger(logger.Handler(), slog.LevelError),
    }

    // Graceful shutdown
    go func() {
        logger.Info("server starting", "addr", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("server error", "error", err)
            os.Exit(1)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := server.Shutdown(ctx); err != nil {
        logger.Error("server shutdown error", "error", err)
    }
    logger.Info("server stopped")
}
```

## Conclusion

The patterns in this guide form a complete, composable middleware system for production Go HTTP services:

1. **Handler chaining** via the `Middleware` type and `Chain` function provides a clean, functional composition model with explicit ordering.
2. **Type-safe context values** using unexported struct types eliminate collision risk and make context access self-documenting.
3. **Request ID propagation** through HTTP headers and gRPC metadata enables end-to-end trace correlation across service boundaries.
4. **Panic recovery** with structured logging, metrics, and clean error responses prevents a single panicking handler from taking down the service.
5. **Layered timeouts** combining `context.WithTimeout` (for downstream calls) with `http.TimeoutHandler` (for response writes) cover both stalled handlers and slow clients.

Each middleware function is independently testable, composable in any order, and carries zero allocation overhead when no work is needed (the `PanicRecovery` defer only activates on panic).
