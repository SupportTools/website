---
title: "Go HTTP Middleware Patterns: Telemetry, Auth, Rate Limiting, and Request Validation"
date: 2030-02-17T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Middleware", "OpenTelemetry", "JWT", "Rate Limiting", "Security", "API"]
categories: ["Go", "Backend Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building composable Go HTTP middleware chains covering OpenTelemetry instrumentation, JWT authentication, per-IP sliding window rate limiting, request body validation, and production-grade error handling."
more_link: "yes"
url: "/go-http-middleware-patterns/"
---

Go's standard library HTTP server uses the `http.Handler` interface, a single method that transforms a request into a response. This simple interface enables a powerful composition pattern: middleware functions that wrap handlers to add cross-cutting concerns. Building a production API in Go without a well-designed middleware chain leads to duplicated telemetry code, inconsistent authentication enforcement, and debugging nightmares. This guide covers the five middleware categories that every production Go HTTP service needs and how to compose them correctly.

<!--more-->

## The Handler and Middleware Interface

The core abstraction:

```go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}

// HandlerFunc is a function that implements Handler
type HandlerFunc func(ResponseWriter, *Request)

// Middleware wraps one handler with another
type Middleware func(http.Handler) http.Handler
```

A middleware function takes a handler and returns a new handler that calls the original while adding behavior before, after, or around it. Composing middleware into a chain is the pattern that keeps route handler code focused on business logic.

### Foundational Chain Builder

```go
// pkg/middleware/chain.go
package middleware

import "net/http"

// Chain composes middleware into a single middleware.
// Applied in order: first middleware is outermost.
//
//   Chain(A, B, C)(handler)
//   is equivalent to:
//   A(B(C(handler)))
//
// So request processing order is: A → B → C → handler
// and response processing order is: handler → C → B → A
func Chain(middlewares ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}

// Apply applies a chain of middleware to a handler.
func Apply(handler http.Handler, middlewares ...func(http.Handler) http.Handler) http.Handler {
    return Chain(middlewares...)(handler)
}
```

### Response Writer Wrapper

Most middleware needs to capture the response status code and bytes written. The standard `http.ResponseWriter` does not expose this:

```go
// pkg/middleware/response_writer.go
package middleware

import (
    "bufio"
    "fmt"
    "net"
    "net/http"
)

// ResponseWriter wraps http.ResponseWriter to capture status and size.
type ResponseWriter struct {
    http.ResponseWriter
    status      int
    bytesWritten int64
    written      bool
}

func NewResponseWriter(w http.ResponseWriter) *ResponseWriter {
    return &ResponseWriter{ResponseWriter: w, status: http.StatusOK}
}

func (rw *ResponseWriter) WriteHeader(code int) {
    if rw.written {
        return
    }
    rw.status = code
    rw.written = true
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *ResponseWriter) Write(b []byte) (int, error) {
    if !rw.written {
        rw.written = true
    }
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += int64(n)
    return n, err
}

func (rw *ResponseWriter) Status() int {
    return rw.status
}

func (rw *ResponseWriter) BytesWritten() int64 {
    return rw.bytesWritten
}

// Hijack implements http.Hijacker for WebSocket support.
func (rw *ResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
    h, ok := rw.ResponseWriter.(http.Hijacker)
    if !ok {
        return nil, nil, fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker")
    }
    return h.Hijack()
}

// Flush implements http.Flusher for SSE support.
func (rw *ResponseWriter) Flush() {
    if f, ok := rw.ResponseWriter.(http.Flusher); ok {
        f.Flush()
    }
}
```

## OpenTelemetry Instrumentation Middleware

### Complete Tracing and Metrics Middleware

```go
// pkg/middleware/telemetry.go
package middleware

import (
    "fmt"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

// TelemetryConfig configures the telemetry middleware.
type TelemetryConfig struct {
    // ServiceName is used as the tracer name and metric prefix.
    ServiceName string
    // SkipPaths contains URL paths to exclude from tracing and metrics.
    SkipPaths map[string]bool
    // SpanNameFormatter customizes span names. Default: "METHOD /path".
    SpanNameFormatter func(r *http.Request) string
}

type telemetryMiddleware struct {
    cfg     TelemetryConfig
    tracer  trace.Tracer
    meter   metric.Meter
    counter metric.Int64Counter
    hist    metric.Float64Histogram
    active  metric.Int64UpDownCounter
}

// NewTelemetry creates an OpenTelemetry instrumentation middleware.
func NewTelemetry(cfg TelemetryConfig) (func(http.Handler) http.Handler, error) {
    tracer := otel.GetTracerProvider().Tracer(cfg.ServiceName)
    meter  := otel.GetMeterProvider().Meter(cfg.ServiceName)

    counter, err := meter.Int64Counter(
        "http.server.request.count",
        metric.WithDescription("Total number of HTTP requests"),
    )
    if err != nil {
        return nil, fmt.Errorf("creating request counter: %w", err)
    }

    hist, err := meter.Float64Histogram(
        "http.server.request.duration",
        metric.WithDescription("HTTP request duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating duration histogram: %w", err)
    }

    active, err := meter.Int64UpDownCounter(
        "http.server.active_requests",
        metric.WithDescription("Number of in-flight HTTP requests"),
    )
    if err != nil {
        return nil, fmt.Errorf("creating active requests counter: %w", err)
    }

    m := &telemetryMiddleware{
        cfg:     cfg,
        tracer:  tracer,
        meter:   meter,
        counter: counter,
        hist:    hist,
        active:  active,
    }

    return m.Handler, nil
}

func (m *telemetryMiddleware) Handler(next http.Handler) http.Handler {
    propagator := otel.GetTextMapPropagator()

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if m.cfg.SkipPaths[r.URL.Path] {
            next.ServeHTTP(w, r)
            return
        }

        // Extract trace context from incoming headers (W3C TraceContext)
        ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

        // Determine span name
        spanName := fmt.Sprintf("%s %s", r.Method, r.URL.Path)
        if m.cfg.SpanNameFormatter != nil {
            spanName = m.cfg.SpanNameFormatter(r)
        }

        // Start span
        ctx, span := m.tracer.Start(ctx, spanName,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.HTTPRequestMethodKey.String(r.Method),
                semconv.URLPath(r.URL.Path),
                semconv.URLQuery(r.URL.RawQuery),
                semconv.HTTPScheme(scheme(r)),
                semconv.NetworkPeerAddress(clientIP(r)),
                semconv.UserAgentOriginal(r.UserAgent()),
            ),
        )
        defer span.End()

        // Inject trace ID into response header for client correlation
        span.SpanContext().TraceID()
        w.Header().Set("X-Trace-ID", span.SpanContext().TraceID().String())

        // Track active requests
        attrs := attribute.NewSet(
            semconv.HTTPRequestMethodKey.String(r.Method),
        )
        m.active.Add(ctx, 1, metric.WithAttributeSet(attrs))
        defer m.active.Add(ctx, -1, metric.WithAttributeSet(attrs))

        // Wrap response writer to capture status
        rw := NewResponseWriter(w)
        start := time.Now()

        // Call the next handler with the enriched context
        next.ServeHTTP(rw, r.WithContext(ctx))

        duration := time.Since(start).Seconds()
        status  := rw.Status()

        // Finalize span attributes
        span.SetAttributes(
            semconv.HTTPResponseStatusCode(status),
            attribute.Int64("http.response.body.size", rw.BytesWritten()),
        )

        if status >= 500 {
            span.SetStatus(codes.Error, http.StatusText(status))
        } else if status >= 400 {
            span.SetStatus(codes.Error, http.StatusText(status))
        } else {
            span.SetStatus(codes.Ok, "")
        }

        // Record metrics
        metricAttrs := metric.WithAttributes(
            semconv.HTTPRequestMethodKey.String(r.Method),
            semconv.HTTPResponseStatusCode(status),
            attribute.String("http.route", routePattern(r)),
        )
        m.counter.Add(ctx, 1, metricAttrs)
        m.hist.Record(ctx, duration, metricAttrs)
    })
}

func scheme(r *http.Request) string {
    if r.TLS != nil {
        return "https"
    }
    return "http"
}

func clientIP(r *http.Request) string {
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        // Take the leftmost IP (original client)
        if i := len(xff); i > 0 {
            for j := 0; j < i; j++ {
                if xff[j] == ',' {
                    return xff[:j]
                }
            }
        }
        return xff
    }
    if xri := r.Header.Get("X-Real-IP"); xri != "" {
        return xri
    }
    // Strip port from RemoteAddr
    host := r.RemoteAddr
    for i := len(host) - 1; i >= 0; i-- {
        if host[i] == ':' {
            return host[:i]
        }
    }
    return host
}

func routePattern(r *http.Request) string {
    // If using Go 1.22+ ServeMux with pattern registration,
    // the pattern is stored in the request context.
    if pattern := r.Pattern; pattern != "" {
        return pattern
    }
    return r.URL.Path
}
```

## JWT Authentication Middleware

```go
// pkg/middleware/auth.go
package middleware

import (
    "context"
    "crypto/rsa"
    "encoding/json"
    "errors"
    "fmt"
    "net/http"
    "strings"
    "sync"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

// Claims extends the standard JWT claims with application-specific fields.
type Claims struct {
    jwt.RegisteredClaims
    UserID   string   `json:"uid"`
    Roles    []string `json:"roles"`
    TenantID string   `json:"tid"`
}

type contextKey string

const claimsContextKey contextKey = "jwt_claims"

// ClaimsFromContext extracts JWT claims from the request context.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
    claims, ok := ctx.Value(claimsContextKey).(*Claims)
    return claims, ok
}

// JWTConfig configures the JWT middleware.
type JWTConfig struct {
    // JWKSURL is the endpoint to fetch public keys from (e.g., Auth0, Cognito)
    JWKSURL string
    // Audience is the expected audience claim value
    Audience string
    // Issuer is the expected issuer claim value
    Issuer string
    // SkipPaths contains paths to exclude from authentication
    SkipPaths map[string]bool
    // KeyRefreshInterval controls how often the JWKS is refreshed
    KeyRefreshInterval time.Duration
}

type jwksCache struct {
    mu      sync.RWMutex
    keys    map[string]*rsa.PublicKey
    fetched time.Time
    cfg     JWTConfig
}

func newJWKSCache(cfg JWTConfig) *jwksCache {
    return &jwksCache{cfg: cfg, keys: make(map[string]*rsa.PublicKey)}
}

func (c *jwksCache) getKey(kid string) (*rsa.PublicKey, error) {
    c.mu.RLock()
    key, ok := c.keys[kid]
    stale := time.Since(c.fetched) > c.cfg.KeyRefreshInterval
    c.mu.RUnlock()

    if ok && !stale {
        return key, nil
    }

    // Refresh the JWKS
    if err := c.refresh(); err != nil {
        if ok {
            return key, nil // return stale key on refresh failure
        }
        return nil, fmt.Errorf("refreshing JWKS: %w", err)
    }

    c.mu.RLock()
    key, ok = c.keys[kid]
    c.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("key %q not found in JWKS", kid)
    }
    return key, nil
}

func (c *jwksCache) refresh() error {
    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Get(c.cfg.JWKSURL)
    if err != nil {
        return fmt.Errorf("fetching JWKS: %w", err)
    }
    defer resp.Body.Close()

    var jwks struct {
        Keys []struct {
            Kid string `json:"kid"`
            Kty string `json:"kty"`
            N   string `json:"n"`
            E   string `json:"e"`
        } `json:"keys"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
        return fmt.Errorf("decoding JWKS: %w", err)
    }

    newKeys := make(map[string]*rsa.PublicKey)
    for _, k := range jwks.Keys {
        if k.Kty != "RSA" {
            continue
        }
        pub, err := jwt.ParseRSAPublicKeyFromPEM([]byte(
            "-----BEGIN PUBLIC KEY-----\n" + k.N + "\n-----END PUBLIC KEY-----",
        ))
        if err != nil {
            // Skip keys that fail to parse rather than failing all auth
            continue
        }
        newKeys[k.Kid] = pub
    }

    c.mu.Lock()
    c.keys    = newKeys
    c.fetched = time.Now()
    c.mu.Unlock()

    return nil
}

// NewJWT creates a JWT authentication middleware.
func NewJWT(cfg JWTConfig) func(http.Handler) http.Handler {
    if cfg.KeyRefreshInterval == 0 {
        cfg.KeyRefreshInterval = 15 * time.Minute
    }
    cache := newJWKSCache(cfg)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if cfg.SkipPaths[r.URL.Path] {
                next.ServeHTTP(w, r)
                return
            }

            // Extract Bearer token
            authHeader := r.Header.Get("Authorization")
            if !strings.HasPrefix(authHeader, "Bearer ") {
                http.Error(w, `{"error":"missing_token"}`,
                    http.StatusUnauthorized)
                return
            }
            tokenString := strings.TrimPrefix(authHeader, "Bearer ")

            // Parse and validate the token
            var claims Claims
            _, err := jwt.ParseWithClaims(tokenString, &claims,
                func(token *jwt.Token) (interface{}, error) {
                    if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
                        return nil, fmt.Errorf("unexpected signing method: %v",
                            token.Header["alg"])
                    }
                    kid, _ := token.Header["kid"].(string)
                    return cache.getKey(kid)
                },
                jwt.WithAudience(cfg.Audience),
                jwt.WithIssuer(cfg.Issuer),
                jwt.WithExpirationRequired(),
                jwt.WithIssuedAt(),
            )
            if err != nil {
                var validationErr *jwt.ValidationError
                if errors.As(err, &validationErr) {
                    if validationErr.Is(jwt.ErrTokenExpired) {
                        http.Error(w, `{"error":"token_expired"}`,
                            http.StatusUnauthorized)
                        return
                    }
                }
                http.Error(w, `{"error":"invalid_token"}`,
                    http.StatusUnauthorized)
                return
            }

            // Store claims in context for downstream handlers
            ctx := context.WithValue(r.Context(), claimsContextKey, &claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// RequireRole is a middleware factory that requires the user to have
// at least one of the specified roles.
func RequireRole(roles ...string) func(http.Handler) http.Handler {
    roleSet := make(map[string]bool, len(roles))
    for _, r := range roles {
        roleSet[r] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims, ok := ClaimsFromContext(r.Context())
            if !ok {
                http.Error(w, `{"error":"unauthorized"}`,
                    http.StatusForbidden)
                return
            }
            for _, role := range claims.Roles {
                if roleSet[role] {
                    next.ServeHTTP(w, r)
                    return
                }
            }
            http.Error(w, `{"error":"insufficient_permissions"}`,
                http.StatusForbidden)
        })
    }
}
```

## Sliding Window Rate Limiter

```go
// pkg/middleware/ratelimit.go
package middleware

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "strconv"
    "sync"
    "time"
)

// RateLimitConfig configures the rate limiting middleware.
type RateLimitConfig struct {
    // RequestsPerWindow is the maximum number of requests allowed per window.
    RequestsPerWindow int
    // Window is the duration of the sliding window.
    Window time.Duration
    // KeyFunc extracts the rate limit key from the request.
    // Defaults to client IP.
    KeyFunc func(r *http.Request) string
    // OnLimitReached is called when a client is rate limited.
    // Defaults to returning 429 with a JSON error body.
    OnLimitReached func(w http.ResponseWriter, r *http.Request, retryAfter time.Duration)
    // MaxClients is the maximum number of clients to track.
    // Older clients are evicted when this limit is reached.
    MaxClients int
}

// slidingWindowEntry tracks request timestamps for a client.
type slidingWindowEntry struct {
    mu         sync.Mutex
    timestamps []int64 // Unix nanoseconds
    lastAccess time.Time
}

func (e *slidingWindowEntry) count(window time.Duration, now time.Time) int {
    cutoff := now.Add(-window).UnixNano()
    // Remove expired timestamps (compact the slice)
    j := 0
    for _, ts := range e.timestamps {
        if ts >= cutoff {
            e.timestamps[j] = ts
            j++
        }
    }
    e.timestamps = e.timestamps[:j]
    return len(e.timestamps)
}

func (e *slidingWindowEntry) record(now time.Time) {
    e.timestamps = append(e.timestamps, now.UnixNano())
    e.lastAccess = now
}

func (e *slidingWindowEntry) oldestAllowed(window time.Duration, limit int, now time.Time) time.Duration {
    if len(e.timestamps) < limit {
        return 0
    }
    // The oldest timestamp that must expire before another request is allowed
    oldest := e.timestamps[len(e.timestamps)-limit]
    expiry := time.Unix(0, oldest).Add(window)
    return time.Until(expiry)
}

type rateLimiter struct {
    cfg     RateLimitConfig
    mu      sync.RWMutex
    clients map[string]*slidingWindowEntry
}

// NewRateLimit creates a per-key sliding window rate limiter.
func NewRateLimit(cfg RateLimitConfig) func(http.Handler) http.Handler {
    if cfg.MaxClients == 0 {
        cfg.MaxClients = 100_000
    }
    if cfg.KeyFunc == nil {
        cfg.KeyFunc = clientIP
    }
    if cfg.OnLimitReached == nil {
        cfg.OnLimitReached = defaultRateLimitResponse
    }

    rl := &rateLimiter{
        cfg:     cfg,
        clients: make(map[string]*slidingWindowEntry),
    }

    // Background goroutine to evict stale entries
    go rl.evict(context.Background())

    return rl.Handler
}

func (rl *rateLimiter) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := rl.cfg.KeyFunc(r)
        now := time.Now()

        entry := rl.getOrCreate(key)
        entry.mu.Lock()

        count := entry.count(rl.cfg.Window, now)
        if count >= rl.cfg.RequestsPerWindow {
            retryAfter := entry.oldestAllowed(
                rl.cfg.Window, rl.cfg.RequestsPerWindow, now)
            entry.mu.Unlock()

            // Set standard rate limit headers
            w.Header().Set("X-RateLimit-Limit",
                strconv.Itoa(rl.cfg.RequestsPerWindow))
            w.Header().Set("X-RateLimit-Remaining", "0")
            w.Header().Set("X-RateLimit-Reset",
                strconv.FormatInt(now.Add(retryAfter).Unix(), 10))
            w.Header().Set("Retry-After",
                strconv.Itoa(int(retryAfter.Seconds())+1))

            rl.cfg.OnLimitReached(w, r, retryAfter)
            return
        }

        entry.record(now)
        remaining := rl.cfg.RequestsPerWindow - count - 1
        entry.mu.Unlock()

        w.Header().Set("X-RateLimit-Limit",
            strconv.Itoa(rl.cfg.RequestsPerWindow))
        w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
        w.Header().Set("X-RateLimit-Reset",
            strconv.FormatInt(now.Add(rl.cfg.Window).Unix(), 10))

        next.ServeHTTP(w, r)
    })
}

func (rl *rateLimiter) getOrCreate(key string) *slidingWindowEntry {
    rl.mu.RLock()
    entry, ok := rl.clients[key]
    rl.mu.RUnlock()
    if ok {
        return entry
    }

    rl.mu.Lock()
    defer rl.mu.Unlock()
    // Double-check after acquiring write lock
    if entry, ok = rl.clients[key]; ok {
        return entry
    }
    // Evict one old entry if at capacity
    if len(rl.clients) >= rl.cfg.MaxClients {
        rl.evictOldest()
    }
    entry = &slidingWindowEntry{lastAccess: time.Now()}
    rl.clients[key] = entry
    return entry
}

func (rl *rateLimiter) evictOldest() {
    var oldestKey string
    var oldestTime time.Time
    for k, e := range rl.clients {
        if oldestKey == "" || e.lastAccess.Before(oldestTime) {
            oldestKey = k
            oldestTime = e.lastAccess
        }
    }
    if oldestKey != "" {
        delete(rl.clients, oldestKey)
    }
}

func (rl *rateLimiter) evict(ctx context.Context) {
    ticker := time.NewTicker(rl.cfg.Window)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case now := <-ticker.C:
            cutoff := now.Add(-rl.cfg.Window * 2)
            rl.mu.Lock()
            for k, e := range rl.clients {
                e.mu.Lock()
                if e.lastAccess.Before(cutoff) {
                    delete(rl.clients, k)
                }
                e.mu.Unlock()
            }
            rl.mu.Unlock()
        }
    }
}

func defaultRateLimitResponse(w http.ResponseWriter, _ *http.Request, retryAfter time.Duration) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusTooManyRequests)
    _ = json.NewEncoder(w).Encode(map[string]interface{}{
        "error":       "rate_limit_exceeded",
        "retry_after": int(retryAfter.Seconds()) + 1,
    })
}
```

## Request Body Validation Middleware

```go
// pkg/middleware/validation.go
package middleware

import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"

    "github.com/go-playground/validator/v10"
)

var validate = validator.New(validator.WithRequiredStructEnabled())

type validationContextKey string

const parsedBodyKey validationContextKey = "parsed_body"

// ParsedBodyFromContext retrieves the parsed and validated request body.
func ParsedBodyFromContext[T any](ctx context.Context) (T, bool) {
    v, ok := ctx.Value(parsedBodyKey).(T)
    return v, ok
}

// ValidateJSONBody creates a middleware that parses the JSON request body
// into a value of type T, validates it using struct tags, and stores
// it in the request context.
//
// Usage:
//
//   type CreateUserRequest struct {
//       Email    string `json:"email" validate:"required,email"`
//       Name     string `json:"name"  validate:"required,min=1,max=100"`
//       Age      int    `json:"age"   validate:"gte=18,lte=120"`
//   }
//
//   mux.Handle("POST /users",
//       middleware.Apply(
//           createUserHandler,
//           middleware.ValidateJSONBody[CreateUserRequest](middleware.ValidationConfig{
//               MaxBodySize: 1 << 16, // 64 KB
//           }),
//       ),
//   )
func ValidateJSONBody[T any](cfg ValidationConfig) func(http.Handler) http.Handler {
    if cfg.MaxBodySize == 0 {
        cfg.MaxBodySize = 1 << 20 // 1 MB default
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Enforce content-type
            ct := r.Header.Get("Content-Type")
            if ct != "application/json" && ct != "application/json; charset=utf-8" {
                writeValidationError(w, http.StatusUnsupportedMediaType,
                    "Content-Type must be application/json")
                return
            }

            // Limit body size
            r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxBodySize)

            body, err := io.ReadAll(r.Body)
            if err != nil {
                var maxBytesErr *http.MaxBytesError
                if errors.As(err, &maxBytesErr) {
                    writeValidationError(w, http.StatusRequestEntityTooLarge,
                        fmt.Sprintf("request body exceeds %d byte limit",
                            cfg.MaxBodySize))
                    return
                }
                writeValidationError(w, http.StatusBadRequest,
                    "failed to read request body")
                return
            }

            // Parse JSON
            var parsed T
            dec := json.NewDecoder(bytes.NewReader(body))
            dec.DisallowUnknownFields()
            if err := dec.Decode(&parsed); err != nil {
                var syntaxErr *json.SyntaxError
                var unmarshalErr *json.UnmarshalTypeError
                switch {
                case errors.As(err, &syntaxErr):
                    writeValidationError(w, http.StatusBadRequest,
                        fmt.Sprintf("JSON syntax error at position %d", syntaxErr.Offset))
                case errors.As(err, &unmarshalErr):
                    writeValidationError(w, http.StatusBadRequest,
                        fmt.Sprintf("field %q must be %s", unmarshalErr.Field, unmarshalErr.Type))
                case err == io.EOF:
                    writeValidationError(w, http.StatusBadRequest, "request body is empty")
                default:
                    writeValidationError(w, http.StatusBadRequest, err.Error())
                }
                return
            }

            // Validate struct using go-playground/validator
            if err := validate.Struct(parsed); err != nil {
                var validationErrs validator.ValidationErrors
                if errors.As(err, &validationErrs) {
                    fieldErrors := make(map[string]string, len(validationErrs))
                    for _, fe := range validationErrs {
                        fieldErrors[fe.Field()] = validationMessage(fe)
                    }
                    writeFieldErrors(w, fieldErrors)
                    return
                }
                writeValidationError(w, http.StatusBadRequest, err.Error())
                return
            }

            // Store in context and restore body for downstream handlers
            r.Body = io.NopCloser(bytes.NewReader(body))
            ctx := context.WithValue(r.Context(), parsedBodyKey, parsed)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// ValidationConfig configures the body validation middleware.
type ValidationConfig struct {
    MaxBodySize int64
}

type validationErrorResponse struct {
    Error  string            `json:"error"`
    Fields map[string]string `json:"fields,omitempty"`
}

func writeValidationError(w http.ResponseWriter, status int, msg string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(validationErrorResponse{Error: msg})
}

func writeFieldErrors(w http.ResponseWriter, fields map[string]string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusUnprocessableEntity)
    _ = json.NewEncoder(w).Encode(validationErrorResponse{
        Error:  "validation_failed",
        Fields: fields,
    })
}

func validationMessage(fe validator.FieldError) string {
    switch fe.Tag() {
    case "required":
        return "field is required"
    case "email":
        return "must be a valid email address"
    case "min":
        return fmt.Sprintf("must be at least %s characters", fe.Param())
    case "max":
        return fmt.Sprintf("must be at most %s characters", fe.Param())
    case "gte":
        return fmt.Sprintf("must be greater than or equal to %s", fe.Param())
    case "lte":
        return fmt.Sprintf("must be less than or equal to %s", fe.Param())
    case "oneof":
        return fmt.Sprintf("must be one of: %s", fe.Param())
    case "url":
        return "must be a valid URL"
    case "uuid":
        return "must be a valid UUID"
    default:
        return fmt.Sprintf("failed %s validation", fe.Tag())
    }
}
```

## Composing the Full Middleware Stack

```go
// cmd/api/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/api/pkg/handlers"
    "github.com/example/api/pkg/middleware"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(logger)

    // Initialize OpenTelemetry
    ctx := context.Background()
    tp, err := initTracer(ctx)
    if err != nil {
        slog.Error("Failed to initialize tracer", "error", err)
        os.Exit(1)
    }
    defer tp.Shutdown(ctx)
    otel.SetTracerProvider(tp)

    // Build middleware instances
    telemetry, err := middleware.NewTelemetry(middleware.TelemetryConfig{
        ServiceName: "api-server",
        SkipPaths: map[string]bool{
            "/healthz": true,
            "/readyz":  true,
            "/metrics": true,
        },
    })
    if err != nil {
        slog.Error("Failed to create telemetry middleware", "error", err)
        os.Exit(1)
    }

    auth := middleware.NewJWT(middleware.JWTConfig{
        JWKSURL:            "https://auth.example.com/.well-known/jwks.json",
        Audience:           "api.example.com",
        Issuer:             "https://auth.example.com/",
        KeyRefreshInterval: 15 * time.Minute,
        SkipPaths: map[string]bool{
            "/v1/auth/login":   true,
            "/v1/auth/refresh": true,
            "/healthz":         true,
        },
    })

    rateLimit := middleware.NewRateLimit(middleware.RateLimitConfig{
        RequestsPerWindow: 1000,
        Window:            time.Minute,
        MaxClients:        500_000,
    })

    // Build the router with middleware applied per-route
    mux := http.NewServeMux()

    // Public routes — rate limited only
    mux.Handle("POST /v1/auth/login",
        middleware.Apply(
            handlers.NewLoginHandler(),
            middleware.NewRateLimit(middleware.RateLimitConfig{
                RequestsPerWindow: 10,
                Window:            time.Minute,
            }),
            middleware.ValidateJSONBody[handlers.LoginRequest](
                middleware.ValidationConfig{MaxBodySize: 4096},
            ),
        ),
    )

    // Protected API routes — full middleware stack
    userHandler := middleware.Apply(
        handlers.NewUserHandler(),
        auth,
        middleware.RequireRole("user", "admin"),
        rateLimit,
        middleware.ValidateJSONBody[handlers.CreateUserRequest](
            middleware.ValidationConfig{MaxBodySize: 65536},
        ),
    )
    mux.Handle("POST /v1/users", userHandler)

    adminHandler := middleware.Apply(
        handlers.NewAdminHandler(),
        auth,
        middleware.RequireRole("admin"),
        middleware.NewRateLimit(middleware.RateLimitConfig{
            RequestsPerWindow: 5000,
            Window:            time.Minute,
        }),
    )
    mux.Handle("/v1/admin/", adminHandler)

    // Apply global middleware (telemetry, recovery, request ID)
    globalChain := middleware.Chain(
        telemetry,
        middleware.RequestID(),
        middleware.Recover(logger),
    )

    server := &http.Server{
        Addr:              ":8080",
        Handler:           globalChain(mux),
        ReadTimeout:       15 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,
        MaxHeaderBytes:    1 << 20,
    }

    // Graceful shutdown
    done := make(chan struct{})
    go func() {
        sigChan := make(chan os.Signal, 1)
        signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
        <-sigChan

        slog.Info("Shutting down server...")
        shutdownCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
        defer cancel()
        if err := server.Shutdown(shutdownCtx); err != nil {
            slog.Error("Server shutdown error", "error", err)
        }
        close(done)
    }()

    slog.Info("Starting server", "addr", server.Addr)
    if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        slog.Error("Server error", "error", err)
        os.Exit(1)
    }

    <-done
    slog.Info("Server stopped")
}

func initTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    res, _ := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName("api-server"),
            semconv.ServiceVersion(os.Getenv("APP_VERSION")),
        ),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.1), // 10% sampling for high-volume routes
        )),
    )
    return tp, nil
}
```

## Key Takeaways

A well-designed middleware chain in Go follows a strict ordering: observability first, then identity (authentication), then access control (authorization), then rate limiting, and finally payload validation. This ordering ensures that every request is instrumented regardless of whether it passes later gates, that rate limiting happens after identity is established (enabling per-user rate limits), and that expensive validation only occurs for authenticated requests.

The `ResponseWriter` wrapper pattern is foundational. Without it, middleware cannot observe the status code written by downstream handlers, making accurate observability impossible.

Per-IP sliding window rate limiting is more accurate than fixed window counting and avoids the boundary-exploitation problem. The eviction loop is essential to prevent unbounded memory growth in long-running services.

The `ValidateJSONBody[T]` generic middleware demonstrates Go's type-safe approach to request parsing: the handler receives a strongly-typed value from the context rather than parsing raw bytes itself, eliminating an entire class of parsing bugs from handler code.
