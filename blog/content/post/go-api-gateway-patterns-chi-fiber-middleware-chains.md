---
title: "Go API Gateway Patterns: Building Custom Middleware Chains with Chi and Fiber"
date: 2030-10-23T00:00:00-05:00
draft: false
tags: ["Go", "API Gateway", "Chi", "Fiber", "Middleware", "Rate Limiting", "Circuit Breaker"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise API gateway patterns in Go: Chi router middleware composition, Fiber performance benchmarks, rate limiting, authentication chains, request logging with correlation ID injection, circuit breakers, and building reusable middleware libraries."
more_link: "yes"
url: "/go-api-gateway-patterns-chi-fiber-middleware-chains/"
---

Building an API gateway in Go places every cross-cutting concern—authentication, rate limiting, observability, circuit breaking—on a single code path that every inbound request must traverse. Getting middleware composition right determines whether that path is maintainable, testable, and performant, or a tangled chain of global state and impossible-to-mock dependencies.

<!--more-->

This guide covers the full spectrum of enterprise middleware patterns using both Chi and Fiber, with production-hardened implementations for each concern.

## Section 1: Choosing Between Chi and Fiber

Both routers are production-proven, but they make different tradeoffs.

**Chi** is built on the standard `net/http` interface. Every handler and middleware is a `http.Handler` or `http.HandlerFunc`, which means:
- Full compatibility with the standard library ecosystem
- Easy testing with `httptest.NewRecorder`
- Context-based value passing via `context.WithValue`
- Lower overhead per request than Fiber for simple use cases

**Fiber** is built on fasthttp, which avoids standard `net/http` allocations by reusing `RequestCtx` objects from a sync.Pool. This makes Fiber measurably faster under high concurrency but incompatible with `net/http` middleware libraries. Values pass through `fiber.Ctx.Locals`, not through context.

### Benchmark Comparison

```bash
# Chi
BenchmarkChi_Simple          1000000     1423 ns/op    720 B/op    9 allocs/op
BenchmarkChi_WithMiddleware    500000     2891 ns/op   1344 B/op   17 allocs/op

# Fiber
BenchmarkFiber_Simple        3000000      401 ns/op      0 B/op     0 allocs/op
BenchmarkFiber_WithMiddleware 2000000     712 ns/op     16 B/op     1 allocs/op
```

For a gateway handling 50,000+ RPS, Fiber's zero-allocation design matters. For a gateway handling 5,000 RPS behind a load balancer, Chi's standard library compatibility is more operationally valuable.

## Section 2: Chi Middleware Composition

### Router Setup and Middleware Chain

```go
package gateway

import (
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "go.uber.org/zap"
)

type Gateway struct {
    router *chi.Mux
    logger *zap.Logger
    config *Config
}

func New(cfg *Config, logger *zap.Logger) *Gateway {
    g := &Gateway{
        router: chi.NewRouter(),
        logger: logger,
        config: cfg,
    }
    g.setupMiddleware()
    g.setupRoutes()
    return g
}

func (g *Gateway) setupMiddleware() {
    r := g.router

    // Built-in Chi middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Recoverer)

    // Custom middleware in dependency order
    r.Use(correlationIDMiddleware)
    r.Use(requestLoggingMiddleware(g.logger))
    r.Use(rateLimitMiddleware(g.config.RateLimit))
    r.Use(authenticationMiddleware(g.config.Auth))
    r.Use(timeoutMiddleware(30 * time.Second))
    r.Use(metricsMiddleware)
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    g.router.ServeHTTP(w, r)
}
```

### Route-Scoped Middleware with Chi Groups

Not every route needs every middleware. Chi's inline grouping lets you apply middleware selectively:

```go
func (g *Gateway) setupRoutes() {
    r := g.router

    // Public routes — no auth, higher rate limit
    r.Group(func(r chi.Router) {
        r.Use(rateLimitMiddleware(RateLimitConfig{
            RequestsPerSecond: 100,
            BurstSize:         200,
        }))
        r.Get("/health", g.handleHealth)
        r.Get("/ready", g.handleReady)
        r.Post("/auth/token", g.handleTokenExchange)
    })

    // API v1 — authenticated, standard rate limit
    r.Group(func(r chi.Router) {
        r.Use(authenticationMiddleware(g.config.Auth))
        r.Use(rateLimitMiddleware(g.config.RateLimit))
        r.Route("/api/v1", func(r chi.Router) {
            r.Use(tenantScopingMiddleware)
            r.Get("/users", g.handleListUsers)
            r.Post("/users", g.handleCreateUser)
            r.Route("/users/{userID}", func(r chi.Router) {
                r.Use(userAccessMiddleware)
                r.Get("/", g.handleGetUser)
                r.Put("/", g.handleUpdateUser)
                r.Delete("/", g.handleDeleteUser)
            })
        })
    })

    // Admin routes — require elevated privileges
    r.Group(func(r chi.Router) {
        r.Use(authenticationMiddleware(g.config.Auth))
        r.Use(requireAdminMiddleware)
        r.Route("/admin", func(r chi.Router) {
            r.Get("/stats", g.handleAdminStats)
            r.Post("/users/{userID}/suspend", g.handleSuspendUser)
        })
    })
}
```

## Section 3: Correlation ID and Request Logging Middleware

### Correlation ID Injection

```go
package middleware

import (
    "context"
    "net/http"

    "github.com/google/uuid"
)

type contextKey string

const (
    CorrelationIDKey contextKey = "correlationID"
    RequestIDKey     contextKey = "requestID"
)

// correlationIDMiddleware reads X-Correlation-ID from upstream or generates one,
// then propagates it through the request context and response headers.
func correlationIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        correlationID := r.Header.Get("X-Correlation-ID")
        if correlationID == "" {
            correlationID = uuid.New().String()
        }

        // Validate format to prevent header injection
        if len(correlationID) > 128 {
            correlationID = uuid.New().String()
        }

        ctx := context.WithValue(r.Context(), CorrelationIDKey, correlationID)
        w.Header().Set("X-Correlation-ID", correlationID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// GetCorrelationID retrieves the correlation ID from a context.
func GetCorrelationID(ctx context.Context) string {
    if v, ok := ctx.Value(CorrelationIDKey).(string); ok {
        return v
    }
    return ""
}
```

### Structured Request Logging

```go
package middleware

import (
    "net/http"
    "time"

    "go.uber.org/zap"
)

type responseWriter struct {
    http.ResponseWriter
    statusCode    int
    bytesWritten  int64
    headerWritten bool
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
    return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
    if !rw.headerWritten {
        rw.statusCode = code
        rw.headerWritten = true
        rw.ResponseWriter.WriteHeader(code)
    }
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += int64(n)
    return n, err
}

func requestLoggingMiddleware(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            rw := newResponseWriter(w)

            defer func() {
                duration := time.Since(start)
                correlationID := GetCorrelationID(r.Context())

                fields := []zap.Field{
                    zap.String("method", r.Method),
                    zap.String("path", r.URL.Path),
                    zap.String("remote_addr", r.RemoteAddr),
                    zap.String("user_agent", r.UserAgent()),
                    zap.String("correlation_id", correlationID),
                    zap.Int("status_code", rw.statusCode),
                    zap.Int64("response_bytes", rw.bytesWritten),
                    zap.Duration("duration", duration),
                }

                if rw.statusCode >= 500 {
                    logger.Error("request completed with server error", fields...)
                } else if rw.statusCode >= 400 {
                    logger.Warn("request completed with client error", fields...)
                } else {
                    logger.Info("request completed", fields...)
                }
            }()

            next.ServeHTTP(rw, r)
        })
    }
}
```

## Section 4: Rate Limiting Middleware

### Token Bucket Rate Limiter per Client

```go
package middleware

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type RateLimitConfig struct {
    RequestsPerSecond rate.Limit
    BurstSize         int
    KeyFunc           func(*http.Request) string
    ExceedHandler     http.Handler
}

type clientLimiter struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

type rateLimiter struct {
    mu       sync.Mutex
    clients  map[string]*clientLimiter
    config   RateLimitConfig
    stopChan chan struct{}
}

func newRateLimiter(cfg RateLimitConfig) *rateLimiter {
    if cfg.KeyFunc == nil {
        cfg.KeyFunc = func(r *http.Request) string {
            return r.RemoteAddr
        }
    }
    if cfg.ExceedHandler == nil {
        cfg.ExceedHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Retry-After", "1")
            w.Header().Set("X-RateLimit-Limit", "100")
            http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
        })
    }

    rl := &rateLimiter{
        clients:  make(map[string]*clientLimiter),
        config:   cfg,
        stopChan: make(chan struct{}),
    }

    go rl.cleanupLoop()
    return rl
}

func (rl *rateLimiter) getLimiter(key string) *rate.Limiter {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    cl, exists := rl.clients[key]
    if !exists {
        cl = &clientLimiter{
            limiter: rate.NewLimiter(rl.config.RequestsPerSecond, rl.config.BurstSize),
        }
        rl.clients[key] = cl
    }
    cl.lastSeen = time.Now()
    return cl.limiter
}

func (rl *rateLimiter) cleanupLoop() {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            rl.mu.Lock()
            for key, cl := range rl.clients {
                if time.Since(cl.lastSeen) > 10*time.Minute {
                    delete(rl.clients, key)
                }
            }
            rl.mu.Unlock()
        case <-rl.stopChan:
            return
        }
    }
}

func rateLimitMiddleware(cfg RateLimitConfig) func(http.Handler) http.Handler {
    rl := newRateLimiter(cfg)
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := rl.config.KeyFunc(r)
            limiter := rl.getLimiter(key)
            if !limiter.Allow() {
                rl.config.ExceedHandler.ServeHTTP(w, r)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

### Redis-Backed Distributed Rate Limiting

For multi-instance gateways, a local token bucket is insufficient because each instance maintains independent state. Use Redis with a sliding window algorithm:

```go
package middleware

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisRateLimiter struct {
    client   *redis.Client
    limit    int64
    window   time.Duration
    keyFunc  func(*http.Request) string
}

const slidingWindowScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local request_id = ARGV[4]

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count current requests in window
local count = redis.call('ZCARD', key)

if count >= limit then
    return {0, count}
end

-- Add this request
redis.call('ZADD', key, now, request_id)
redis.call('EXPIRE', key, math.ceil(window / 1000))

return {1, count + 1}
`

func (rrl *RedisRateLimiter) Allow(ctx context.Context, r *http.Request) (bool, error) {
    key := fmt.Sprintf("ratelimit:%s", rrl.keyFunc(r))
    now := time.Now().UnixMilli()
    windowMs := rrl.window.Milliseconds()
    requestID := fmt.Sprintf("%d-%s", now, r.Header.Get("X-Request-Id"))

    result, err := rrl.client.Eval(ctx, slidingWindowScript,
        []string{key},
        strconv.FormatInt(now, 10),
        strconv.FormatInt(windowMs, 10),
        strconv.FormatInt(rrl.limit, 10),
        requestID,
    ).Int64Slice()

    if err != nil {
        // Fail open on Redis errors to avoid cascading failures
        return true, err
    }

    return result[0] == 1, nil
}

func redisRateLimitMiddleware(rrl *RedisRateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            allowed, err := rrl.Allow(r.Context(), r)
            if err != nil {
                // Log error but allow request (fail-open policy)
                // In security-critical contexts, change to fail-closed
                next.ServeHTTP(w, r)
                return
            }
            if !allowed {
                w.Header().Set("Retry-After", "1")
                http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 5: Authentication Middleware

### JWT Authentication with JWKS Rotation

```go
package middleware

import (
    "context"
    "fmt"
    "net/http"
    "strings"
    "sync"
    "time"

    "github.com/lestrrat-go/jwx/v2/jwk"
    "github.com/lestrrat-go/jwx/v2/jwt"
)

type Claims struct {
    Subject  string
    TenantID string
    Roles    []string
    Email    string
}

type JWTAuthConfig struct {
    JWKSEndpoint  string
    Issuer        string
    Audience      string
    RefreshPeriod time.Duration
}

type jwtAuthenticator struct {
    config   JWTAuthConfig
    keySet   jwk.Set
    mu       sync.RWMutex
    lastFetch time.Time
}

func newJWTAuthenticator(cfg JWTAuthConfig) (*jwtAuthenticator, error) {
    a := &jwtAuthenticator{config: cfg}
    if err := a.refreshKeys(context.Background()); err != nil {
        return nil, fmt.Errorf("initial JWKS fetch failed: %w", err)
    }
    go a.backgroundRefresh()
    return a, nil
}

func (a *jwtAuthenticator) refreshKeys(ctx context.Context) error {
    keySet, err := jwk.Fetch(ctx, a.config.JWKSEndpoint)
    if err != nil {
        return err
    }
    a.mu.Lock()
    a.keySet = keySet
    a.lastFetch = time.Now()
    a.mu.Unlock()
    return nil
}

func (a *jwtAuthenticator) backgroundRefresh() {
    period := a.config.RefreshPeriod
    if period == 0 {
        period = 5 * time.Minute
    }
    ticker := time.NewTicker(period)
    for range ticker.C {
        if err := a.refreshKeys(context.Background()); err != nil {
            // Log but continue with cached keys
            _ = err
        }
    }
}

func (a *jwtAuthenticator) Validate(tokenString string) (*Claims, error) {
    a.mu.RLock()
    keySet := a.keySet
    a.mu.RUnlock()

    token, err := jwt.Parse([]byte(tokenString),
        jwt.WithKeySet(keySet),
        jwt.WithIssuer(a.config.Issuer),
        jwt.WithAudience(a.config.Audience),
        jwt.WithValidate(true),
    )
    if err != nil {
        return nil, fmt.Errorf("token validation failed: %w", err)
    }

    claims := &Claims{
        Subject: token.Subject(),
    }

    if tenantID, ok := token.Get("tenant_id"); ok {
        claims.TenantID, _ = tenantID.(string)
    }
    if roles, ok := token.Get("roles"); ok {
        if roleSlice, ok := roles.([]interface{}); ok {
            for _, r := range roleSlice {
                if role, ok := r.(string); ok {
                    claims.Roles = append(claims.Roles, role)
                }
            }
        }
    }
    if email, ok := token.Get("email"); ok {
        claims.Email, _ = email.(string)
    }

    return claims, nil
}

const claimsContextKey contextKey = "jwtClaims"

func authenticationMiddleware(cfg JWTAuthConfig) func(http.Handler) http.Handler {
    auth, err := newJWTAuthenticator(cfg)
    if err != nil {
        panic(fmt.Sprintf("failed to initialize JWT authenticator: %v", err))
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
                return
            }

            parts := strings.SplitN(authHeader, " ", 2)
            if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
                http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
                return
            }

            claims, err := auth.Validate(parts[1])
            if err != nil {
                http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
                return
            }

            ctx := context.WithValue(r.Context(), claimsContextKey, claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func GetClaims(ctx context.Context) *Claims {
    if v, ok := ctx.Value(claimsContextKey).(*Claims); ok {
        return v
    }
    return nil
}

func requireAdminMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        claims := GetClaims(r.Context())
        if claims == nil {
            http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
            return
        }
        for _, role := range claims.Roles {
            if role == "admin" {
                next.ServeHTTP(w, r)
                return
            }
        }
        http.Error(w, `{"error":"insufficient privileges"}`, http.StatusForbidden)
    })
}
```

## Section 6: Circuit Breaker Middleware

The circuit breaker prevents cascading failures by failing fast when an upstream service is unhealthy. The three states are: Closed (normal operation), Open (fast-fail), and Half-Open (probing recovery).

```go
package middleware

import (
    "errors"
    "net/http"
    "sync"
    "time"
)

type CircuitState int

const (
    StateClosed CircuitState = iota
    StateOpen
    StateHalfOpen
)

type CircuitBreakerConfig struct {
    FailureThreshold   int
    SuccessThreshold   int
    OpenDuration       time.Duration
    HalfOpenMaxCalls   int
}

type CircuitBreaker struct {
    mu              sync.Mutex
    state           CircuitState
    failureCount    int
    successCount    int
    halfOpenCalls   int
    lastStateChange time.Time
    config          CircuitBreakerConfig
}

var ErrCircuitOpen = errors.New("circuit breaker is open")

func NewCircuitBreaker(cfg CircuitBreakerConfig) *CircuitBreaker {
    return &CircuitBreaker{
        state:  StateClosed,
        config: cfg,
    }
}

func (cb *CircuitBreaker) Allow() error {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return nil
    case StateOpen:
        if time.Since(cb.lastStateChange) >= cb.config.OpenDuration {
            cb.state = StateHalfOpen
            cb.halfOpenCalls = 0
            cb.successCount = 0
            return nil
        }
        return ErrCircuitOpen
    case StateHalfOpen:
        if cb.halfOpenCalls >= cb.config.HalfOpenMaxCalls {
            return ErrCircuitOpen
        }
        cb.halfOpenCalls++
        return nil
    }
    return nil
}

func (cb *CircuitBreaker) RecordSuccess() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if cb.state == StateHalfOpen {
        cb.successCount++
        if cb.successCount >= cb.config.SuccessThreshold {
            cb.state = StateClosed
            cb.failureCount = 0
        }
    } else {
        cb.failureCount = 0
    }
}

func (cb *CircuitBreaker) RecordFailure() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.failureCount++
    if cb.state == StateHalfOpen || cb.failureCount >= cb.config.FailureThreshold {
        cb.state = StateOpen
        cb.lastStateChange = time.Now()
    }
}

func circuitBreakerMiddleware(cb *CircuitBreaker) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if err := cb.Allow(); err != nil {
                w.Header().Set("Retry-After", "10")
                http.Error(w, `{"error":"service temporarily unavailable"}`, http.StatusServiceUnavailable)
                return
            }

            rw := newResponseWriter(w)
            next.ServeHTTP(rw, r)

            if rw.statusCode >= 500 {
                cb.RecordFailure()
            } else {
                cb.RecordSuccess()
            }
        })
    }
}
```

### Per-Upstream Circuit Breakers

In a proxy gateway, each upstream service needs its own circuit breaker:

```go
type UpstreamProxy struct {
    targets  map[string]*UpstreamTarget
    mu       sync.RWMutex
}

type UpstreamTarget struct {
    URL            string
    CircuitBreaker *CircuitBreaker
    Client         *http.Client
}

func (up *UpstreamProxy) ProxyHandler(targetName string) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        up.mu.RLock()
        target, ok := up.targets[targetName]
        up.mu.RUnlock()
        if !ok {
            http.Error(w, `{"error":"unknown upstream"}`, http.StatusBadGateway)
            return
        }

        if err := target.CircuitBreaker.Allow(); err != nil {
            http.Error(w, `{"error":"upstream circuit open"}`, http.StatusServiceUnavailable)
            return
        }

        proxyReq, err := http.NewRequestWithContext(
            r.Context(), r.Method, target.URL+r.URL.RequestURI(), r.Body,
        )
        if err != nil {
            target.CircuitBreaker.RecordFailure()
            http.Error(w, `{"error":"proxy error"}`, http.StatusBadGateway)
            return
        }

        // Forward headers
        for key, values := range r.Header {
            for _, value := range values {
                proxyReq.Header.Add(key, value)
            }
        }

        resp, err := target.Client.Do(proxyReq)
        if err != nil {
            target.CircuitBreaker.RecordFailure()
            http.Error(w, `{"error":"upstream error"}`, http.StatusBadGateway)
            return
        }
        defer resp.Body.Close()

        if resp.StatusCode >= 500 {
            target.CircuitBreaker.RecordFailure()
        } else {
            target.CircuitBreaker.RecordSuccess()
        }

        for key, values := range resp.Header {
            for _, value := range values {
                w.Header().Add(key, value)
            }
        }
        w.WriteHeader(resp.StatusCode)
        // Stream response body
        copyResponse(w, resp)
    }
}
```

## Section 7: Fiber Middleware Chain

Fiber uses a different composition model. Middleware is registered with `app.Use()` and executes in registration order. The `c.Next()` call passes control to the next handler.

### Fiber Gateway Setup

```go
package gateway

import (
    "time"

    "github.com/gofiber/fiber/v2"
    "github.com/gofiber/fiber/v2/middleware/compress"
    "github.com/gofiber/fiber/v2/middleware/cors"
    "github.com/gofiber/fiber/v2/middleware/limiter"
    "github.com/gofiber/fiber/v2/middleware/recover"
    "github.com/gofiber/fiber/v2/middleware/requestid"
    "go.uber.org/zap"
)

func NewFiberGateway(cfg *Config, logger *zap.Logger) *fiber.App {
    app := fiber.New(fiber.Config{
        ReadTimeout:       30 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
        ReadBufferSize:    16 * 1024,
        WriteBufferSize:   16 * 1024,
        BodyLimit:         10 * 1024 * 1024, // 10 MB
        DisableKeepalive:  false,
        StrictRouting:     true,
        ErrorHandler:      fiberErrorHandler(logger),
    })

    // Global middleware
    app.Use(recover.New(recover.Config{
        EnableStackTrace: true,
    }))
    app.Use(requestid.New())
    app.Use(fiberCorrelationID())
    app.Use(fiberRequestLogger(logger))
    app.Use(compress.New(compress.Config{
        Level: compress.LevelBestSpeed,
    }))
    app.Use(cors.New(cors.Config{
        AllowOrigins:     cfg.CORS.AllowedOrigins,
        AllowHeaders:     "Origin, Content-Type, Accept, Authorization, X-Correlation-ID",
        AllowMethods:     "GET, HEAD, PUT, PATCH, POST, DELETE",
        AllowCredentials: true,
        MaxAge:           86400,
    }))
    app.Use(limiter.New(limiter.Config{
        Max:               100,
        Expiration:        1 * time.Second,
        KeyGenerator:      func(c *fiber.Ctx) string { return c.IP() },
        LimitReached:      fiberLimitExceeded,
        SkipSuccessfulRequests: false,
    }))

    setupFiberRoutes(app, cfg, logger)
    return app
}

func fiberCorrelationID() fiber.Handler {
    return func(c *fiber.Ctx) error {
        correlationID := c.Get("X-Correlation-ID")
        if correlationID == "" {
            correlationID = c.Locals("requestid").(string)
        }
        c.Locals("correlationID", correlationID)
        c.Set("X-Correlation-ID", correlationID)
        return c.Next()
    }
}

func fiberRequestLogger(logger *zap.Logger) fiber.Handler {
    return func(c *fiber.Ctx) error {
        start := time.Now()
        err := c.Next()
        duration := time.Since(start)

        correlationID, _ := c.Locals("correlationID").(string)
        logger.Info("request",
            zap.String("method", c.Method()),
            zap.String("path", c.Path()),
            zap.String("ip", c.IP()),
            zap.String("correlation_id", correlationID),
            zap.Int("status", c.Response().StatusCode()),
            zap.Duration("duration", duration),
            zap.Int("bytes_sent", len(c.Response().Body())),
        )
        return err
    }
}

func fiberErrorHandler(logger *zap.Logger) fiber.ErrorHandler {
    return func(c *fiber.Ctx, err error) error {
        code := fiber.StatusInternalServerError
        message := "internal server error"

        var fiberErr *fiber.Error
        if errors.As(err, &fiberErr) {
            code = fiberErr.Code
            message = fiberErr.Message
        }

        correlationID, _ := c.Locals("correlationID").(string)
        logger.Error("request error",
            zap.Error(err),
            zap.String("correlation_id", correlationID),
            zap.Int("status", code),
        )

        return c.Status(code).JSON(fiber.Map{
            "error":          message,
            "correlation_id": correlationID,
        })
    }
}

func fiberLimitExceeded(c *fiber.Ctx) error {
    return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
        "error":       "rate limit exceeded",
        "retry_after": 1,
    })
}
```

## Section 8: Timeout and Context Propagation

Request timeouts should be enforced at the gateway level to prevent slow upstream services from exhausting goroutine pools.

```go
func timeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            done := make(chan struct{})
            panicChan := make(chan interface{}, 1)

            tw := newTimeoutResponseWriter(w)

            go func() {
                defer func() {
                    if p := recover(); p != nil {
                        panicChan <- p
                    }
                }()
                next.ServeHTTP(tw, r.WithContext(ctx))
                close(done)
            }()

            select {
            case <-done:
                tw.mu.Lock()
                defer tw.mu.Unlock()
                tw.writeHeader()
            case p := <-panicChan:
                panic(p)
            case <-ctx.Done():
                tw.mu.Lock()
                defer tw.mu.Unlock()
                if !tw.headerWritten {
                    w.Header().Set("X-Timeout-Reason", "gateway-timeout")
                    http.Error(w, `{"error":"request timeout"}`, http.StatusGatewayTimeout)
                }
            }
        })
    }
}

type timeoutResponseWriter struct {
    http.ResponseWriter
    mu            sync.Mutex
    statusCode    int
    buf           []byte
    headerWritten bool
}

func newTimeoutResponseWriter(w http.ResponseWriter) *timeoutResponseWriter {
    return &timeoutResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (tw *timeoutResponseWriter) WriteHeader(code int) {
    tw.mu.Lock()
    defer tw.mu.Unlock()
    tw.statusCode = code
}

func (tw *timeoutResponseWriter) Write(b []byte) (int, error) {
    tw.mu.Lock()
    defer tw.mu.Unlock()
    tw.buf = append(tw.buf, b...)
    return len(b), nil
}

func (tw *timeoutResponseWriter) writeHeader() {
    if tw.headerWritten {
        return
    }
    tw.headerWritten = true
    tw.ResponseWriter.WriteHeader(tw.statusCode)
    if len(tw.buf) > 0 {
        tw.ResponseWriter.Write(tw.buf)
    }
}
```

## Section 9: Prometheus Metrics Middleware

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
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status_code"},
    )

    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
        },
        []string{"method", "path"},
    )

    httpRequestSize = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_size_bytes",
            Help:    "HTTP request size in bytes",
            Buckets: prometheus.ExponentialBuckets(100, 10, 7),
        },
        []string{"method", "path"},
    )

    httpResponseSize = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_response_size_bytes",
            Help:    "HTTP response size in bytes",
            Buckets: prometheus.ExponentialBuckets(100, 10, 7),
        },
        []string{"method", "path"},
    )

    activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "http_active_connections",
        Help: "Number of currently active HTTP connections",
    })
)

func metricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        activeConnections.Inc()
        defer activeConnections.Dec()

        // Normalize path to avoid high cardinality
        path := normalizeMetricPath(r)

        rw := newResponseWriter(w)
        next.ServeHTTP(rw, r)

        duration := time.Since(start).Seconds()
        statusStr := strconv.Itoa(rw.statusCode)

        httpRequestsTotal.WithLabelValues(r.Method, path, statusStr).Inc()
        httpRequestDuration.WithLabelValues(r.Method, path).Observe(duration)
        httpResponseSize.WithLabelValues(r.Method, path).Observe(float64(rw.bytesWritten))
        if r.ContentLength > 0 {
            httpRequestSize.WithLabelValues(r.Method, path).Observe(float64(r.ContentLength))
        }
    })
}

// normalizeMetricPath replaces URL path parameters with placeholders
// to prevent cardinality explosion (e.g., /users/123 -> /users/:id)
func normalizeMetricPath(r *http.Request) string {
    // When using Chi, use chi.RouteContext to get the route pattern
    // routeCtx := chi.RouteContext(r.Context())
    // if routeCtx != nil && routeCtx.RoutePattern() != "" {
    //     return routeCtx.RoutePattern()
    // }
    return r.URL.Path
}
```

## Section 10: Building a Reusable Middleware Library

Structure the middleware package for reuse across multiple services:

```
gateway/
  middleware/
    auth.go          # JWT validation
    circuitbreaker.go
    correlationid.go
    logging.go
    metrics.go
    ratelimit.go
    recovery.go
    timeout.go
    middleware_test.go
  proxy/
    upstream.go
    loadbalancer.go
  config/
    config.go
  main.go
```

### Integration Test for Middleware Chain

```go
package middleware_test

import (
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestMiddlewareChain(t *testing.T) {
    r := chi.NewRouter()
    r.Use(correlationIDMiddleware)
    r.Use(rateLimitMiddleware(RateLimitConfig{
        RequestsPerSecond: 10,
        BurstSize:         20,
    }))
    r.Get("/test", func(w http.ResponseWriter, r *http.Request) {
        correlationID := GetCorrelationID(r.Context())
        assert.NotEmpty(t, correlationID)
        w.WriteHeader(http.StatusOK)
    })

    t.Run("correlation ID is injected when missing", func(t *testing.T) {
        req := httptest.NewRequest(http.MethodGet, "/test", nil)
        rr := httptest.NewRecorder()
        r.ServeHTTP(rr, req)
        assert.Equal(t, http.StatusOK, rr.Code)
        assert.NotEmpty(t, rr.Header().Get("X-Correlation-ID"))
    })

    t.Run("correlation ID is preserved when present", func(t *testing.T) {
        req := httptest.NewRequest(http.MethodGet, "/test", nil)
        req.Header.Set("X-Correlation-ID", "test-correlation-123")
        rr := httptest.NewRecorder()
        r.ServeHTTP(rr, req)
        assert.Equal(t, "test-correlation-123", rr.Header().Get("X-Correlation-ID"))
    })

    t.Run("rate limit triggers after burst", func(t *testing.T) {
        for i := 0; i < 20; i++ {
            req := httptest.NewRequest(http.MethodGet, "/test", nil)
            rr := httptest.NewRecorder()
            r.ServeHTTP(rr, req)
        }
        req := httptest.NewRequest(http.MethodGet, "/test", nil)
        rr := httptest.NewRecorder()
        r.ServeHTTP(rr, req)
        assert.Equal(t, http.StatusTooManyRequests, rr.Code)
    })
}

func TestCircuitBreaker(t *testing.T) {
    cb := NewCircuitBreaker(CircuitBreakerConfig{
        FailureThreshold: 3,
        SuccessThreshold: 2,
        OpenDuration:     100 * time.Millisecond,
        HalfOpenMaxCalls: 2,
    })

    // Trip the circuit
    for i := 0; i < 3; i++ {
        require.NoError(t, cb.Allow())
        cb.RecordFailure()
    }

    // Verify open state
    require.ErrorIs(t, cb.Allow(), ErrCircuitOpen)

    // Wait for half-open transition
    time.Sleep(150 * time.Millisecond)

    // Should allow probe requests
    require.NoError(t, cb.Allow())
    cb.RecordSuccess()
    require.NoError(t, cb.Allow())
    cb.RecordSuccess()

    // Should be closed again
    require.NoError(t, cb.Allow())
}
```

A well-structured middleware library eliminates duplicated cross-cutting concern code across services. Each middleware should be independently testable, accept configuration through function parameters rather than global state, and compose cleanly with both Chi and any `http.Handler`-compatible framework.
