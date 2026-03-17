---
title: "Go HTTP Middleware Patterns: Authentication, Rate Limiting, and Observability Chains"
date: 2028-04-15T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Middleware", "Authentication", "Rate Limiting"]
categories: ["Go", "Backend Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into building composable, production-grade HTTP middleware chains in Go covering authentication, JWT validation, rate limiting, distributed tracing, and structured logging."
more_link: "yes"
url: "/go-http-middleware-patterns-guide/"
---

Middleware is the glue that makes HTTP services maintainable at scale. In Go, the standard `net/http` package provides the `http.Handler` interface — a single method, `ServeHTTP(ResponseWriter, *Request)` — which composes cleanly into chains of behavior without framework lock-in. This post builds a complete production middleware stack from scratch, covering authentication, rate limiting, observability, and the patterns that keep chains testable and debuggable.

<!--more-->

# Go HTTP Middleware Patterns

## The Middleware Signature

A middleware is a function that wraps an `http.Handler` and returns a new `http.Handler`:

```go
type Middleware func(http.Handler) http.Handler
```

This shape enables clean composition:

```go
handler := Chain(
    Logger(logger),
    RequestID(),
    Authenticate(authService),
    RateLimiter(limiter),
    CORS(corsPolicy),
)(mux)
```

## Building the Chain

```go
package middleware

import "net/http"

// Chain applies middlewares in left-to-right order.
// The first middleware is the outermost wrapper (runs first on request,
// last on response).
func Chain(middlewares ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}
```

## Request ID Middleware

Every request must be traceable. Inject a correlation ID early in the chain.

```go
package middleware

import (
    "context"
    "net/http"

    "github.com/google/uuid"
)

type contextKey string

const RequestIDKey contextKey = "requestID"

// RequestID injects a unique request ID into context and response headers.
// If the upstream proxy already set X-Request-ID, reuse it.
func RequestID() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            id := r.Header.Get("X-Request-ID")
            if id == "" {
                id = uuid.New().String()
            }
            ctx := context.WithValue(r.Context(), RequestIDKey, id)
            w.Header().Set("X-Request-ID", id)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// GetRequestID extracts the request ID from context.
func GetRequestID(ctx context.Context) string {
    if id, ok := ctx.Value(RequestIDKey).(string); ok {
        return id
    }
    return ""
}
```

## Structured Request Logger

Use a `ResponseWriter` wrapper to capture the status code and bytes written:

```go
package middleware

import (
    "log/slog"
    "net/http"
    "time"
)

type responseWriter struct {
    http.ResponseWriter
    statusCode   int
    bytesWritten int
    written      bool
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
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += n
    rw.written = true
    return n, err
}

// Logger emits a structured log line per request.
func Logger(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            rw := newResponseWriter(w)
            next.ServeHTTP(rw, r)
            duration := time.Since(start)

            logger.InfoContext(r.Context(), "http request",
                slog.String("method", r.Method),
                slog.String("path", r.URL.Path),
                slog.String("query", r.URL.RawQuery),
                slog.Int("status", rw.statusCode),
                slog.Int("bytes", rw.bytesWritten),
                slog.Duration("duration", duration),
                slog.String("remote_addr", r.RemoteAddr),
                slog.String("user_agent", r.UserAgent()),
                slog.String("request_id", GetRequestID(r.Context())),
            )
        })
    }
}
```

## Panic Recovery

Never let a handler panic crash the entire process:

```go
package middleware

import (
    "log/slog"
    "net/http"
    "runtime/debug"
)

// Recovery catches panics, logs the stack trace, and returns 500.
func Recovery(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if rvr := recover(); rvr != nil {
                    stack := debug.Stack()
                    logger.ErrorContext(r.Context(), "panic recovered",
                        slog.Any("panic", rvr),
                        slog.String("stack", string(stack)),
                        slog.String("request_id", GetRequestID(r.Context())),
                    )
                    http.Error(w, "Internal Server Error", http.StatusInternalServerError)
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
```

## JWT Authentication Middleware

### Token Claims Structure

```go
package auth

import (
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type Claims struct {
    UserID   string   `json:"sub"`
    Email    string   `json:"email"`
    Roles    []string `json:"roles"`
    TenantID string   `json:"tenant_id"`
    jwt.RegisteredClaims
}

func (c *Claims) HasRole(role string) bool {
    for _, r := range c.Roles {
        if r == role {
            return true
        }
    }
    return false
}
```

### JWT Validation Middleware

```go
package middleware

import (
    "context"
    "errors"
    "net/http"
    "strings"

    "github.com/golang-jwt/jwt/v5"
    "yourorg/auth"
)

type contextKey string

const ClaimsKey contextKey = "claims"

type JWTConfig struct {
    // PublicKey for RS256, or SecretKey for HS256
    SecretKey []byte
    Issuer    string
    Audience  []string
    // SkipPaths are paths that bypass authentication
    SkipPaths []string
}

func Authenticate(cfg JWTConfig) func(http.Handler) http.Handler {
    skipSet := make(map[string]struct{}, len(cfg.SkipPaths))
    for _, p := range cfg.SkipPaths {
        skipSet[p] = struct{}{}
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if _, skip := skipSet[r.URL.Path]; skip {
                next.ServeHTTP(w, r)
                return
            }

            tokenStr, err := extractBearerToken(r)
            if err != nil {
                writeUnauthorized(w, err.Error())
                return
            }

            claims := &auth.Claims{}
            token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
                if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
                    return nil, errors.New("unexpected signing method")
                }
                return cfg.SecretKey, nil
            },
                jwt.WithIssuer(cfg.Issuer),
                jwt.WithAudience(cfg.Audience...),
                jwt.WithExpirationRequired(),
            )
            if err != nil || !token.Valid {
                writeUnauthorized(w, "invalid token")
                return
            }

            ctx := context.WithValue(r.Context(), ClaimsKey, claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func extractBearerToken(r *http.Request) (string, error) {
    authHeader := r.Header.Get("Authorization")
    if authHeader == "" {
        return "", errors.New("missing Authorization header")
    }
    parts := strings.SplitN(authHeader, " ", 2)
    if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
        return "", errors.New("Authorization header must be Bearer token")
    }
    return parts[1], nil
}

func writeUnauthorized(w http.ResponseWriter, msg string) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("WWW-Authenticate", `Bearer realm="api"`)
    w.WriteHeader(http.StatusUnauthorized)
    w.Write([]byte(`{"error":"unauthorized","message":"` + msg + `"}`))
}

// GetClaims retrieves validated claims from context.
func GetClaims(ctx context.Context) *auth.Claims {
    c, _ := ctx.Value(ClaimsKey).(*auth.Claims)
    return c
}
```

### Role-Based Authorization

```go
// RequireRole enforces that the authenticated user has a specific role.
func RequireRole(roles ...string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims := GetClaims(r.Context())
            if claims == nil {
                http.Error(w, "Forbidden", http.StatusForbidden)
                return
            }
            for _, role := range roles {
                if claims.HasRole(role) {
                    next.ServeHTTP(w, r)
                    return
                }
            }
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusForbidden)
            w.Write([]byte(`{"error":"forbidden","required_roles":` +
                marshalStringSlice(roles) + `}`))
        })
    }
}
```

## Rate Limiting Middleware

### Token Bucket Per-Client Rate Limiter

Using `golang.org/x/time/rate` for local in-process limiting:

```go
package middleware

import (
    "context"
    "net"
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type clientLimiter struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

type RateLimiterConfig struct {
    // RequestsPerSecond is the sustained rate per client
    RequestsPerSecond float64
    // Burst allows short spikes above the sustained rate
    Burst int
    // CleanupInterval removes idle client state
    CleanupInterval time.Duration
    // IdleTimeout removes clients not seen for this duration
    IdleTimeout time.Duration
    // KeyFunc extracts the rate limit key from the request
    // Defaults to client IP if nil
    KeyFunc func(r *http.Request) string
}

type ipRateLimiter struct {
    cfg     RateLimiterConfig
    clients map[string]*clientLimiter
    mu      sync.Mutex
    stop    chan struct{}
}

func NewRateLimiter(cfg RateLimiterConfig) *ipRateLimiter {
    if cfg.CleanupInterval == 0 {
        cfg.CleanupInterval = 5 * time.Minute
    }
    if cfg.IdleTimeout == 0 {
        cfg.IdleTimeout = 15 * time.Minute
    }
    if cfg.KeyFunc == nil {
        cfg.KeyFunc = clientIP
    }
    rl := &ipRateLimiter{
        cfg:     cfg,
        clients: make(map[string]*clientLimiter),
        stop:    make(chan struct{}),
    }
    go rl.cleanup()
    return rl
}

func (rl *ipRateLimiter) Stop() {
    close(rl.stop)
}

func (rl *ipRateLimiter) getLimiter(key string) *rate.Limiter {
    rl.mu.Lock()
    defer rl.mu.Unlock()
    cl, ok := rl.clients[key]
    if !ok {
        cl = &clientLimiter{
            limiter: rate.NewLimiter(
                rate.Limit(rl.cfg.RequestsPerSecond),
                rl.cfg.Burst,
            ),
        }
        rl.clients[key] = cl
    }
    cl.lastSeen = time.Now()
    return cl.limiter
}

func (rl *ipRateLimiter) cleanup() {
    ticker := time.NewTicker(rl.cfg.CleanupInterval)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            rl.mu.Lock()
            for key, cl := range rl.clients {
                if time.Since(cl.lastSeen) > rl.cfg.IdleTimeout {
                    delete(rl.clients, key)
                }
            }
            rl.mu.Unlock()
        case <-rl.stop:
            return
        }
    }
}

// RateLimit returns a middleware that enforces per-client rate limiting.
func RateLimit(rl *ipRateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := rl.cfg.KeyFunc(r)
            limiter := rl.getLimiter(key)
            if !limiter.Allow() {
                w.Header().Set("Retry-After", "1")
                w.Header().Set("X-RateLimit-Limit",
                    formatFloat(rl.cfg.RequestsPerSecond))
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
                return
            }
            w.Header().Set("X-RateLimit-Limit",
                formatFloat(rl.cfg.RequestsPerSecond))
            next.ServeHTTP(w, r)
        })
    }
}

func clientIP(r *http.Request) string {
    // Trust X-Forwarded-For only behind a trusted proxy
    xff := r.Header.Get("X-Forwarded-For")
    if xff != "" {
        // Take the leftmost IP (original client)
        parts := strings.SplitN(xff, ",", 2)
        if ip := strings.TrimSpace(parts[0]); ip != "" {
            return ip
        }
    }
    ip, _, _ := net.SplitHostPort(r.RemoteAddr)
    return ip
}
```

### Redis-Backed Distributed Rate Limiter

For multi-instance deployments, use Redis sliding window:

```go
package middleware

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisRateLimiter struct {
    rdb    *redis.Client
    limit  int
    window time.Duration
}

func NewRedisRateLimiter(rdb *redis.Client, limit int, window time.Duration) *RedisRateLimiter {
    return &RedisRateLimiter{rdb: rdb, limit: limit, window: window}
}

// slidingWindowScript implements the sliding window algorithm.
// Returns 1 if the request is allowed, 0 if rate limited.
var slidingWindowScript = redis.NewScript(`
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local expire_at = now - window * 1000

-- Remove old entries
redis.call("ZREMRANGEBYSCORE", key, 0, expire_at)

-- Count current entries
local count = redis.call("ZCARD", key)

if count < limit then
    redis.call("ZADD", key, now, now)
    redis.call("PEXPIRE", key, window * 1000)
    return {1, limit - count - 1}
else
    return {0, 0}
end
`)

func (rl *RedisRateLimiter) Allow(ctx context.Context, key string) (bool, int, error) {
    now := time.Now().UnixMilli()
    result, err := slidingWindowScript.Run(
        ctx, rl.rdb,
        []string{fmt.Sprintf("ratelimit:%s", key)},
        int64(rl.window.Seconds()),
        rl.limit,
        now,
    ).Int64Slice()
    if err != nil {
        return true, 0, err // fail open on Redis errors
    }
    return result[0] == 1, int(result[1]), nil
}

func RedisRateLimit(rl *RedisRateLimiter, keyFunc func(*http.Request) string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := keyFunc(r)
            allowed, remaining, err := rl.Allow(r.Context(), key)
            if err != nil {
                // Log the error but don't block requests on Redis failure
                // (fail open policy — adjust based on your security posture)
                next.ServeHTTP(w, r)
                return
            }
            w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))
            if !allowed {
                w.Header().Set("Retry-After", fmt.Sprintf("%d", int(rl.window.Seconds())))
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

## OpenTelemetry Tracing Middleware

```go
package middleware

import (
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "go.opentelemetry.io/otel/trace"
)

// Tracing instruments each request with an OpenTelemetry span.
func Tracing(serviceName string) func(http.Handler) http.Handler {
    tracer := otel.Tracer(serviceName)
    propagator := otel.GetTextMapPropagator()

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract trace context from incoming headers (e.g., from upstream proxy)
            ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

            spanName := r.Method + " " + r.URL.Path
            ctx, span := tracer.Start(ctx, spanName,
                trace.WithSpanKind(trace.SpanKindServer),
                trace.WithAttributes(
                    semconv.HTTPMethod(r.Method),
                    semconv.HTTPURL(r.URL.String()),
                    semconv.HTTPClientIP(clientIP(r)),
                    semconv.UserAgentOriginal(r.UserAgent()),
                    attribute.String("request_id", GetRequestID(ctx)),
                ),
            )
            defer span.End()

            rw := newResponseWriter(w)
            next.ServeHTTP(rw, r.WithContext(ctx))

            span.SetAttributes(semconv.HTTPStatusCode(rw.statusCode))
            if rw.statusCode >= 500 {
                span.SetStatus(codes.Error, http.StatusText(rw.statusCode))
            } else {
                span.SetStatus(codes.Ok, "")
            }
        })
    }
}
```

## Prometheus Metrics Middleware

```go
package middleware

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "http_requests_total",
        Help: "Total number of HTTP requests by method, path, and status.",
    }, []string{"method", "path", "status"})

    httpRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "HTTP request duration in seconds.",
        Buckets: prometheus.DefBuckets,
    }, []string{"method", "path"})

    httpRequestSize = promauto.NewSummaryVec(prometheus.SummaryOpts{
        Name:       "http_request_size_bytes",
        Help:       "HTTP request size in bytes.",
        Objectives: map[float64]float64{0.5: 0.05, 0.9: 0.01, 0.99: 0.001},
    }, []string{"method", "path"})

    httpResponseSize = promauto.NewSummaryVec(prometheus.SummaryOpts{
        Name:       "http_response_size_bytes",
        Help:       "HTTP response size in bytes.",
        Objectives: map[float64]float64{0.5: 0.05, 0.9: 0.01, 0.99: 0.001},
    }, []string{"method", "path"})
)

// Metrics records Prometheus metrics for each request.
// Use a route pattern (e.g., "/users/{id}") rather than the raw path
// to avoid high-cardinality label explosions.
func Metrics(pathNormalizer func(r *http.Request) string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            path := pathNormalizer(r)

            rw := newResponseWriter(w)
            next.ServeHTTP(rw, r)

            duration := time.Since(start).Seconds()
            status := strconv.Itoa(rw.statusCode)

            httpRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
            httpRequestDuration.WithLabelValues(r.Method, path).Observe(duration)
            httpRequestSize.WithLabelValues(r.Method, path).Observe(float64(r.ContentLength))
            httpResponseSize.WithLabelValues(r.Method, path).Observe(float64(rw.bytesWritten))
        })
    }
}
```

## CORS Middleware

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

func CORS(cfg CORSConfig) func(http.Handler) http.Handler {
    allowedOriginsSet := make(map[string]struct{})
    for _, o := range cfg.AllowedOrigins {
        allowedOriginsSet[o] = struct{}{}
    }
    hasWildcard := func() bool {
        _, ok := allowedOriginsSet["*"]
        return ok
    }()

    methods := strings.Join(cfg.AllowedMethods, ", ")
    headers := strings.Join(cfg.AllowedHeaders, ", ")
    exposed := strings.Join(cfg.ExposedHeaders, ", ")

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")
            if origin == "" {
                next.ServeHTTP(w, r)
                return
            }

            _, originAllowed := allowedOriginsSet[origin]
            if !hasWildcard && !originAllowed {
                w.WriteHeader(http.StatusForbidden)
                return
            }

            if hasWildcard {
                w.Header().Set("Access-Control-Allow-Origin", "*")
            } else {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Add("Vary", "Origin")
            }

            if cfg.AllowCredentials {
                w.Header().Set("Access-Control-Allow-Credentials", "true")
            }

            if exposed != "" {
                w.Header().Set("Access-Control-Expose-Headers", exposed)
            }

            // Handle preflight
            if r.Method == http.MethodOptions {
                w.Header().Set("Access-Control-Allow-Methods", methods)
                w.Header().Set("Access-Control-Allow-Headers", headers)
                if cfg.MaxAge > 0 {
                    w.Header().Set("Access-Control-Max-Age",
                        strconv.Itoa(cfg.MaxAge))
                }
                w.WriteHeader(http.StatusNoContent)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Timeout Middleware

```go
package middleware

import (
    "context"
    "net/http"
    "time"
)

// Timeout cancels the request context after the given duration.
// Handlers must respect context cancellation for this to be effective.
func Timeout(duration time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), duration)
            defer cancel()

            done := make(chan struct{})
            rw := newResponseWriter(w)

            go func() {
                next.ServeHTTP(rw, r.WithContext(ctx))
                close(done)
            }()

            select {
            case <-done:
                // Normal completion
            case <-ctx.Done():
                if !rw.written {
                    http.Error(w, "Request Timeout", http.StatusGatewayTimeout)
                }
            }
        })
    }
}
```

## Idempotency Key Middleware

For payment or write operations that must not be duplicated:

```go
package middleware

import (
    "context"
    "encoding/json"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
)

type IdempotencyConfig struct {
    Redis   *redis.Client
    TTL     time.Duration
    Methods []string // Methods to enforce idempotency on, e.g. ["POST", "PUT"]
}

func Idempotency(cfg IdempotencyConfig) func(http.Handler) http.Handler {
    methodSet := make(map[string]struct{})
    for _, m := range cfg.Methods {
        methodSet[m] = struct{}{}
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if _, ok := methodSet[r.Method]; !ok {
                next.ServeHTTP(w, r)
                return
            }

            key := r.Header.Get("Idempotency-Key")
            if key == "" {
                next.ServeHTTP(w, r)
                return
            }

            cacheKey := "idempotency:" + key

            // Check for cached response
            val, err := cfg.Redis.Get(r.Context(), cacheKey).Bytes()
            if err == nil {
                // Return cached response
                var cached cachedResponse
                if json.Unmarshal(val, &cached) == nil {
                    w.Header().Set("X-Idempotent-Replayed", "true")
                    w.WriteHeader(cached.StatusCode)
                    w.Write(cached.Body)
                    return
                }
            }

            // Execute handler and capture response
            rw := newCapturingResponseWriter(w)
            next.ServeHTTP(rw, r)

            // Cache the response
            cached := cachedResponse{
                StatusCode: rw.statusCode,
                Body:       rw.body,
            }
            data, _ := json.Marshal(cached)
            cfg.Redis.Set(r.Context(), cacheKey, data, cfg.TTL)
        })
    }
}

type cachedResponse struct {
    StatusCode int    `json:"status_code"`
    Body       []byte `json:"body"`
}
```

## Assembling the Production Stack

```go
package main

import (
    "log/slog"
    "net/http"
    "os"
    "time"

    "yourorg/middleware"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    rateLimiter := middleware.NewRateLimiter(middleware.RateLimiterConfig{
        RequestsPerSecond: 100,
        Burst:             20,
        CleanupInterval:   5 * time.Minute,
        IdleTimeout:       15 * time.Minute,
    })
    defer rateLimiter.Stop()

    jwtConfig := middleware.JWTConfig{
        SecretKey: []byte(os.Getenv("JWT_SECRET")),
        Issuer:    "https://auth.example.com",
        Audience:  []string{"api.example.com"},
        SkipPaths: []string{"/healthz", "/metrics", "/auth/login"},
    }

    corsConfig := middleware.CORSConfig{
        AllowedOrigins:   []string{"https://app.example.com"},
        AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Request-ID"},
        ExposedHeaders:   []string{"X-Request-ID", "X-RateLimit-Limit"},
        AllowCredentials: true,
        MaxAge:           86400,
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"status":"ok"}`))
    })
    mux.HandleFunc("/api/users", usersHandler)
    mux.HandleFunc("/api/orders", ordersHandler)

    // Build the middleware chain (order matters)
    chain := middleware.Chain(
        middleware.Recovery(logger),         // Outermost: catch all panics
        middleware.RequestID(),              // Assign correlation ID early
        middleware.Tracing("api-service"),   // Instrument with traces
        middleware.Logger(logger),           // Log with request context
        middleware.Metrics(routeNormalizer), // Record Prometheus metrics
        middleware.Timeout(30*time.Second),  // Enforce request timeout
        middleware.CORS(corsConfig),         // CORS headers
        middleware.RateLimit(rateLimiter),   // Rate limit by client IP
        middleware.Authenticate(jwtConfig),  // JWT validation
    )

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      chain(mux),
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 35 * time.Second, // Must be > Timeout middleware duration
        IdleTimeout:  60 * time.Second,
    }

    logger.Info("starting server", slog.String("addr", srv.Addr))
    if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        logger.Error("server failed", slog.Any("error", err))
        os.Exit(1)
    }
}

func routeNormalizer(r *http.Request) string {
    // Replace dynamic segments to prevent label cardinality explosion
    // In production, integrate with your router's route matching
    path := r.URL.Path
    // Example: /api/users/123 → /api/users/{id}
    return path
}
```

## Testing Middleware

### Unit Testing Individual Middleware

```go
package middleware_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestRequestID_GeneratesID(t *testing.T) {
    handler := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := GetRequestID(r.Context())
        assert.NotEmpty(t, id)
        w.WriteHeader(http.StatusOK)
    }))

    req := httptest.NewRequest(http.MethodGet, "/", nil)
    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    assert.Equal(t, http.StatusOK, rr.Code)
    assert.NotEmpty(t, rr.Header().Get("X-Request-ID"))
}

func TestRequestID_ReusesUpstreamID(t *testing.T) {
    upstreamID := "upstream-correlation-id"
    handler := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := GetRequestID(r.Context())
        assert.Equal(t, upstreamID, id)
        w.WriteHeader(http.StatusOK)
    }))

    req := httptest.NewRequest(http.MethodGet, "/", nil)
    req.Header.Set("X-Request-ID", upstreamID)
    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    assert.Equal(t, upstreamID, rr.Header().Get("X-Request-ID"))
}

func TestAuthenticate_MissingToken(t *testing.T) {
    cfg := JWTConfig{
        SecretKey: []byte("test-secret"),
        Issuer:    "test-issuer",
        Audience:  []string{"test-audience"},
    }
    handler := Authenticate(cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    }))

    req := httptest.NewRequest(http.MethodGet, "/api/resource", nil)
    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    assert.Equal(t, http.StatusUnauthorized, rr.Code)
}

func TestRateLimit_AllowsUnderLimit(t *testing.T) {
    rl := NewRateLimiter(RateLimiterConfig{
        RequestsPerSecond: 10,
        Burst:             5,
    })
    defer rl.Stop()

    handler := RateLimit(rl)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    }))

    for i := 0; i < 5; i++ {
        req := httptest.NewRequest(http.MethodGet, "/", nil)
        req.RemoteAddr = "1.2.3.4:1234"
        rr := httptest.NewRecorder()
        handler.ServeHTTP(rr, req)
        require.Equal(t, http.StatusOK, rr.Code, "request %d should be allowed", i)
    }
}

func TestRecovery_CatchesPanic(t *testing.T) {
    logger := slog.New(slog.NewTextHandler(io.Discard, nil))
    handler := Recovery(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        panic("something went wrong")
    }))

    req := httptest.NewRequest(http.MethodGet, "/", nil)
    rr := httptest.NewRecorder()

    assert.NotPanics(t, func() {
        handler.ServeHTTP(rr, req)
    })
    assert.Equal(t, http.StatusInternalServerError, rr.Code)
}
```

### Integration Testing the Full Chain

```go
func TestMiddlewareChain_FullRequest(t *testing.T) {
    logger := slog.New(slog.NewTextHandler(io.Discard, nil))
    rl := NewRateLimiter(RateLimiterConfig{RequestsPerSecond: 100, Burst: 10})
    defer rl.Stop()

    mux := http.NewServeMux()
    mux.HandleFunc("/api/data", func(w http.ResponseWriter, r *http.Request) {
        claims := GetClaims(r.Context())
        require.NotNil(t, claims)
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"user": claims.Email})
    })

    jwtSecret := []byte("test-secret-32-bytes-long-enough")
    chain := Chain(
        Recovery(logger),
        RequestID(),
        Logger(logger),
        RateLimit(rl),
        Authenticate(JWTConfig{
            SecretKey: jwtSecret,
            Issuer:    "test",
            Audience:  []string{"test"},
        }),
    )

    srv := httptest.NewServer(chain(mux))
    defer srv.Close()

    token := generateTestJWT(t, jwtSecret)
    resp, err := http.DefaultClient.Do(func() *http.Request {
        req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/data", nil)
        req.Header.Set("Authorization", "Bearer "+token)
        return req
    }())
    require.NoError(t, err)
    assert.Equal(t, http.StatusOK, resp.StatusCode)
    assert.NotEmpty(t, resp.Header.Get("X-Request-ID"))
}
```

## Common Pitfalls

**Do not reuse a `responseWriter` across goroutines.** The wrapping `responseWriter` is not thread-safe. Each request gets its own instance through the middleware call.

**Avoid writing the status code twice.** Once `WriteHeader` is called, the status cannot be changed. The `written` guard in the `responseWriter` wrapper prevents double-writes.

**Order the chain correctly.** Recovery must be outermost. Metrics and logging should run before authentication so that 401/403 responses are also measured. Rate limiting should run before authentication to protect the token validation computation.

**Normalize path labels in Prometheus.** Using raw request paths as labels causes unbounded cardinality. Use your router's route pattern as the label value.

**Fail open on non-critical middleware errors.** A Redis failure in the rate limiter or idempotency middleware should not take down your service. Log the error, increment an error counter, and let the request through.

## Summary

A well-designed middleware chain in Go is small, composable, and testable in isolation. The patterns here — `Chain`, per-component middleware functions, captured `ResponseWriter` — are all you need to build a production-ready HTTP stack that handles authentication, rate limiting, observability, and resilience without coupling any of these concerns to your business logic.
