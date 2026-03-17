---
title: "Go API Gateway Patterns: Rate Limiting, JWT Validation, Request Transformation, and Circuit Breaking"
date: 2032-01-28T00:00:00-05:00
draft: false
tags: ["Go", "API Gateway", "Rate Limiting", "JWT", "Circuit Breaker", "Middleware", "Microservices"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Production patterns for building an API gateway in Go. Covers token bucket and sliding window rate limiting, JWT validation with JWKS rotation, request/response transformation middleware, upstream health checking, and circuit breaking with the Sony gobreaker library."
more_link: "yes"
url: "/go-api-gateway-patterns-rate-limiting-jwt-circuit-breaking/"
---

An API gateway consolidates cross-cutting concerns — authentication, rate limiting, observability, request routing — into a single ingress layer. Building one in Go gives you full control over the hot path and eliminates dependency on a proprietary gateway product. This guide implements production-quality middleware for each concern, assembling them into a composable gateway architecture.

<!--more-->

# Go API Gateway Patterns: Production Implementation

## Gateway Architecture

```
Client
  |
  | HTTPS
  v
Gateway (Go)
  ├── TLS Termination
  ├── Rate Limiting (per-IP, per-key, per-path)
  ├── JWT Authentication
  ├── Request Transformation (headers, body)
  ├── Routing
  ├── Circuit Breaking
  ├── Upstream Health Check
  ├── Response Transformation
  ├── Observability (metrics, tracing, logging)
  └── Error Handling
  |
  | HTTP/2 or HTTP/1.1
  v
Upstream Services
```

## Foundation: Middleware Chain

```go
package gateway

import (
    "net/http"
    "net/http/httputil"
    "time"
)

// Middleware is a function that wraps an http.Handler
type Middleware func(http.Handler) http.Handler

// Chain applies middlewares in order: first middleware is outermost
func Chain(middlewares ...Middleware) Middleware {
    return func(next http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            next = middlewares[i](next)
        }
        return next
    }
}

// Gateway is the top-level gateway server
type Gateway struct {
    config     Config
    router     *Router
    middleware Middleware
    server     *http.Server
    metrics    *Metrics
}

func New(cfg Config) (*Gateway, error) {
    g := &Gateway{
        config:  cfg,
        router:  NewRouter(cfg.Routes),
        metrics: NewMetrics(),
    }

    rateLimiter, err := NewRateLimiter(cfg.RateLimit)
    if err != nil {
        return nil, err
    }

    jwtValidator, err := NewJWTValidator(cfg.JWT)
    if err != nil {
        return nil, err
    }

    g.middleware = Chain(
        RecoveryMiddleware(),
        RequestIDMiddleware(),
        TracingMiddleware(cfg.Tracing),
        MetricsMiddleware(g.metrics),
        LoggingMiddleware(cfg.LogLevel),
        CORSMiddleware(cfg.CORS),
        rateLimiter.Middleware(),
        jwtValidator.Middleware(),
        RequestTransformMiddleware(cfg.Transform),
    )

    handler := g.middleware(g.router)

    g.server = &http.Server{
        Addr:              cfg.ListenAddr,
        Handler:           handler,
        ReadTimeout:       15 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,
        WriteTimeout:      60 * time.Second,
        IdleTimeout:       120 * time.Second,
        MaxHeaderBytes:    1 << 20, // 1MB
    }

    return g, nil
}
```

## Rate Limiting

### Token Bucket (Per-Key)

```go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type KeyFunc func(r *http.Request) string

type Config struct {
    // Per-IP rate limiting
    IPRate  float64 // requests per second
    IPBurst int

    // Per-API-key rate limiting
    KeyRate  float64
    KeyBurst int

    // Global rate limit
    GlobalRate  float64
    GlobalBurst int

    // Store backend (in-memory or Redis)
    StoreType string
    RedisAddr string

    // Headers
    KeyHeader  string // default: X-API-Key
    LimitHeader bool   // inject X-RateLimit-* headers
}

type Limiter struct {
    config  Config
    global  *rate.Limiter
    ipStore *LimiterStore
    keyStore *LimiterStore
    keyFunc KeyFunc
}

type LimiterStore struct {
    mu       sync.RWMutex
    limiters map[string]*entry
    rate     float64
    burst    int
}

type entry struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

func NewLimiterStore(r float64, burst int) *LimiterStore {
    s := &LimiterStore{
        limiters: make(map[string]*entry),
        rate:     r,
        burst:    burst,
    }
    go s.cleanup()
    return s
}

func (s *LimiterStore) Get(key string) *rate.Limiter {
    s.mu.RLock()
    e, ok := s.limiters[key]
    s.mu.RUnlock()
    if ok {
        e.lastSeen = time.Now()
        return e.limiter
    }

    s.mu.Lock()
    defer s.mu.Unlock()
    // Double-check after write lock
    if e, ok = s.limiters[key]; ok {
        return e.limiter
    }
    lim := rate.NewLimiter(rate.Limit(s.rate), s.burst)
    s.limiters[key] = &entry{limiter: lim, lastSeen: time.Now()}
    return lim
}

func (s *LimiterStore) cleanup() {
    ticker := time.NewTicker(5 * time.Minute)
    for range ticker.C {
        s.mu.Lock()
        cutoff := time.Now().Add(-10 * time.Minute)
        for key, e := range s.limiters {
            if e.lastSeen.Before(cutoff) {
                delete(s.limiters, key)
            }
        }
        s.mu.Unlock()
    }
}

func NewRateLimiter(cfg Config) (*Limiter, error) {
    l := &Limiter{
        config:   cfg,
        global:   rate.NewLimiter(rate.Limit(cfg.GlobalRate), cfg.GlobalBurst),
        ipStore:  NewLimiterStore(cfg.IPRate, cfg.IPBurst),
        keyStore: NewLimiterStore(cfg.KeyRate, cfg.KeyBurst),
    }

    keyHeader := cfg.KeyHeader
    if keyHeader == "" {
        keyHeader = "X-API-Key"
    }
    l.keyFunc = func(r *http.Request) string {
        return r.Header.Get(keyHeader)
    }

    return l, nil
}

func (l *Limiter) Middleware() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx := r.Context()

            // Global rate limit
            if !l.global.Allow() {
                l.rateLimitResponse(w, r, "global", l.global)
                return
            }

            // Per-IP rate limit
            ip := extractIP(r)
            ipLimiter := l.ipStore.Get(ip)
            if !ipLimiter.Allow() {
                l.rateLimitResponse(w, r, "ip:"+ip, ipLimiter)
                return
            }

            // Per-key rate limit (only if key is provided)
            if key := l.keyFunc(r); key != "" {
                keyLimiter := l.keyStore.Get(key)
                if !keyLimiter.Allow() {
                    l.rateLimitResponse(w, r, "key:"+key[:8]+"...", keyLimiter)
                    return
                }
                if l.config.LimitHeader {
                    injectRateLimitHeaders(w, keyLimiter)
                }
            }

            next.ServeHTTP(w, r)
        })
    }
}

func (l *Limiter) rateLimitResponse(
    w http.ResponseWriter, r *http.Request,
    scope string, lim *rate.Limiter,
) {
    // Retry-After: how many seconds until next token
    retryAfter := int(lim.Reserve().Delay().Seconds()) + 1
    w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
    w.Header().Set("X-RateLimit-Scope", scope)
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusTooManyRequests)
    fmt.Fprintf(w, `{"error":"rate_limit_exceeded","retry_after":%d}`, retryAfter)
}
```

### Sliding Window Rate Limiter (Redis-backed)

```go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type SlidingWindowLimiter struct {
    client   *redis.Client
    keyPrefix string
    window    time.Duration
    maxReqs   int64
}

// Uses sorted set with timestamp as score
// Atomically removes old entries and checks count
var slidingWindowScript = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local request_id = ARGV[4]

-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

-- Count current entries
local count = redis.call('ZCARD', key)

if count >= max_requests then
    -- Return the oldest entry's score for Retry-After calculation
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if #oldest > 0 then
        return {0, tonumber(oldest[2]) + window - now}
    end
    return {0, window}
end

-- Add this request
redis.call('ZADD', key, now, request_id)
redis.call('PEXPIRE', key, window)

return {1, max_requests - count - 1}
`)

func (l *SlidingWindowLimiter) Allow(
    ctx context.Context, key string,
) (allowed bool, remaining int64, retryAfter time.Duration, err error) {
    now := time.Now().UnixMilli()
    windowMs := l.window.Milliseconds()
    requestID := fmt.Sprintf("%d-%d", now, randomInt64())

    result, err := slidingWindowScript.Run(
        ctx, l.client,
        []string{l.keyPrefix + key},
        now, windowMs, l.maxReqs, requestID,
    ).Int64Slice()
    if err != nil {
        // Fail open: allow request if Redis is unavailable
        return true, -1, 0, err
    }

    allowed = result[0] == 1
    remaining = result[1]
    if !allowed {
        retryAfter = time.Duration(result[1]) * time.Millisecond
    }
    return
}
```

## JWT Authentication with JWKS Rotation

```go
package auth

import (
    "context"
    "crypto/rsa"
    "encoding/json"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "github.com/lestrrat-go/jwx/v2/jwk"
)

type JWTConfig struct {
    JWKSURL         string
    Audience        []string
    Issuer          string
    RequiredClaims  []string
    RefreshInterval time.Duration
    SkipPaths       []string
}

type Claims struct {
    jwt.RegisteredClaims
    Scope  string         `json:"scope"`
    Roles  []string       `json:"roles"`
    TenantID string       `json:"tid"`
    Email  string         `json:"email"`
    Custom map[string]any `json:"ext,omitempty"`
}

type JWTValidator struct {
    config   JWTConfig
    keySet   jwk.Set
    mu       sync.RWMutex
    skipPaths map[string]struct{}
}

func NewJWTValidator(cfg JWTConfig) (*JWTValidator, error) {
    v := &JWTValidator{
        config:    cfg,
        skipPaths: make(map[string]struct{}),
    }

    for _, p := range cfg.SkipPaths {
        v.skipPaths[p] = struct{}{}
    }

    if err := v.fetchKeys(context.Background()); err != nil {
        return nil, fmt.Errorf("initial JWKS fetch: %w", err)
    }

    // Background JWKS refresh
    interval := cfg.RefreshInterval
    if interval == 0 {
        interval = 5 * time.Minute
    }
    go v.refreshKeys(context.Background(), interval)

    return v, nil
}

func (v *JWTValidator) fetchKeys(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    set, err := jwk.Fetch(ctx, v.config.JWKSURL)
    if err != nil {
        return err
    }

    v.mu.Lock()
    v.keySet = set
    v.mu.Unlock()
    return nil
}

func (v *JWTValidator) refreshKeys(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            if err := v.fetchKeys(ctx); err != nil {
                // Log but don't stop; continue using cached keys
                slog.Error("JWKS refresh failed", "error", err)
            }
        case <-ctx.Done():
            return
        }
    }
}

func (v *JWTValidator) keyFunc(token *jwt.Token) (interface{}, error) {
    kid, ok := token.Header["kid"].(string)
    if !ok {
        return nil, fmt.Errorf("missing kid header")
    }

    v.mu.RLock()
    defer v.mu.RUnlock()

    key, found := v.keySet.LookupKeyID(kid)
    if !found {
        return nil, fmt.Errorf("unknown key ID: %s", kid)
    }

    var rawKey interface{}
    if err := key.Raw(&rawKey); err != nil {
        return nil, fmt.Errorf("materialize key: %w", err)
    }
    return rawKey, nil
}

func (v *JWTValidator) ValidateToken(tokenStr string) (*Claims, error) {
    claims := &Claims{}
    token, err := jwt.ParseWithClaims(
        tokenStr, claims,
        v.keyFunc,
        jwt.WithAudience(v.config.Audience...),
        jwt.WithIssuer(v.config.Issuer),
        jwt.WithExpirationRequired(),
        jwt.WithIssuedAt(),
    )
    if err != nil {
        return nil, fmt.Errorf("parse token: %w", err)
    }
    if !token.Valid {
        return nil, fmt.Errorf("invalid token")
    }

    // Check required claims
    for _, claim := range v.config.RequiredClaims {
        if !hasClaim(claims, claim) {
            return nil, fmt.Errorf("missing required claim: %s", claim)
        }
    }

    return claims, nil
}

func (v *JWTValidator) Middleware() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Skip configured paths
            if _, skip := v.skipPaths[r.URL.Path]; skip {
                next.ServeHTTP(w, r)
                return
            }

            // Extract token from Authorization header
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                unauthorizedResponse(w, "missing authorization header")
                return
            }

            const bearerPrefix = "Bearer "
            if len(authHeader) < len(bearerPrefix) ||
                authHeader[:len(bearerPrefix)] != bearerPrefix {
                unauthorizedResponse(w, "invalid authorization scheme")
                return
            }

            tokenStr := authHeader[len(bearerPrefix):]
            claims, err := v.ValidateToken(tokenStr)
            if err != nil {
                unauthorizedResponse(w, err.Error())
                return
            }

            // Inject claims into context
            ctx := context.WithValue(r.Context(), claimsKey{}, claims)
            // Also forward relevant claims as headers to upstream
            r = r.WithContext(ctx)
            r.Header.Set("X-User-ID", claims.Subject)
            r.Header.Set("X-Tenant-ID", claims.TenantID)
            r.Header.Set("X-User-Email", claims.Email)
            r.Header.Set("X-User-Roles", strings.Join(claims.Roles, ","))
            // Remove the Authorization header to prevent forwarding raw JWT
            r.Header.Del("Authorization")

            next.ServeHTTP(w, r)
        })
    }
}

// RBAC check helper
func RequireRole(role string) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims, ok := r.Context().Value(claimsKey{}).(*Claims)
            if !ok {
                unauthorizedResponse(w, "no claims in context")
                return
            }
            for _, r := range claims.Roles {
                if r == role {
                    next.ServeHTTP(w, r)
                    return
                }
            }
            http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
        })
    }
}
```

## Request Transformation

```go
package transform

import (
    "bytes"
    "encoding/json"
    "io"
    "net/http"
    "text/template"
)

type TransformConfig struct {
    // Add/remove/rename request headers
    AddRequestHeaders    map[string]string
    RemoveRequestHeaders []string
    // Add/remove/rename response headers
    AddResponseHeaders    map[string]string
    RemoveResponseHeaders []string
    // Path rewriting
    PathRewrite map[string]string  // regex -> replacement
}

type RequestTransformer struct {
    config    TransformConfig
    pathRules []pathRule
}

type pathRule struct {
    pattern *regexp.Regexp
    replace string
}

func NewRequestTransformer(cfg TransformConfig) *RequestTransformer {
    rt := &RequestTransformer{config: cfg}
    for pattern, replace := range cfg.PathRewrite {
        rt.pathRules = append(rt.pathRules, pathRule{
            pattern: regexp.MustCompile(pattern),
            replace: replace,
        })
    }
    return rt
}

func (t *RequestTransformer) Middleware() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Clone request to avoid mutating the original
            r = r.Clone(r.Context())

            // Add request headers
            for k, v := range t.config.AddRequestHeaders {
                // Support template variables from context
                expanded := t.expandTemplate(r, v)
                r.Header.Set(k, expanded)
            }

            // Remove request headers
            for _, h := range t.config.RemoveRequestHeaders {
                r.Header.Del(h)
            }

            // Rewrite path
            for _, rule := range t.pathRules {
                newPath := rule.pattern.ReplaceAllString(r.URL.Path, rule.replace)
                if newPath != r.URL.Path {
                    r.URL.Path = newPath
                    break
                }
            }

            // Wrap response writer to intercept response headers
            rw := &responseWriter{
                ResponseWriter: w,
                addHeaders:     t.config.AddResponseHeaders,
                removeHeaders:  t.config.RemoveResponseHeaders,
            }

            next.ServeHTTP(rw, r)
        })
    }
}

func (t *RequestTransformer) expandTemplate(r *http.Request, tmplStr string) string {
    tmpl, err := template.New("").Parse(tmplStr)
    if err != nil {
        return tmplStr
    }
    claims, _ := r.Context().Value(claimsKey{}).(*Claims)
    data := map[string]interface{}{
        "Method":  r.Method,
        "Path":    r.URL.Path,
        "IP":      extractIP(r),
        "Subject": "",
        "TenantID": "",
    }
    if claims != nil {
        data["Subject"] = claims.Subject
        data["TenantID"] = claims.TenantID
    }
    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, data); err != nil {
        return tmplStr
    }
    return buf.String()
}

// Buffered response writer for response transformation
type responseWriter struct {
    http.ResponseWriter
    addHeaders    map[string]string
    removeHeaders []string
    headerWritten bool
}

func (rw *responseWriter) WriteHeader(status int) {
    if !rw.headerWritten {
        for k, v := range rw.addHeaders {
            rw.ResponseWriter.Header().Set(k, v)
        }
        for _, h := range rw.removeHeaders {
            rw.ResponseWriter.Header().Del(h)
        }
        // Never expose upstream implementation details
        rw.ResponseWriter.Header().Del("X-Powered-By")
        rw.ResponseWriter.Header().Del("Server")
        rw.headerWritten = true
    }
    rw.ResponseWriter.WriteHeader(status)
}
```

## Circuit Breaking

```go
package circuit

import (
    "errors"
    "net/http"
    "time"

    "github.com/sony/gobreaker/v2"
)

type CircuitBreakerConfig struct {
    Name            string
    MaxRequests     uint32        // max requests in half-open
    Interval        time.Duration // clear counts interval
    Timeout         time.Duration // open -> half-open timeout
    ReadyToTrip     func(counts gobreaker.Counts) bool
}

type ProxyCircuitBreaker struct {
    cb *gobreaker.CircuitBreaker[*http.Response]
}

func NewCircuitBreaker(cfg CircuitBreakerConfig) *ProxyCircuitBreaker {
    readyToTrip := cfg.ReadyToTrip
    if readyToTrip == nil {
        readyToTrip = func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 20 && failureRatio >= 0.6
        }
    }

    settings := gobreaker.Settings{
        Name:        cfg.Name,
        MaxRequests: cfg.MaxRequests,
        Interval:    cfg.Interval,
        Timeout:     cfg.Timeout,
        ReadyToTrip: readyToTrip,
        OnStateChange: func(name string, from, to gobreaker.State) {
            slog.Warn("circuit breaker state change",
                "name", name,
                "from", from.String(),
                "to", to.String(),
            )
            circuitBreakerStateGauge.WithLabelValues(name).Set(float64(to))
        },
        IsSuccessful: func(err error) bool {
            if err == nil {
                return true
            }
            // Consider 5xx server errors as failures, not 4xx client errors
            var httpErr *HTTPError
            if errors.As(err, &httpErr) {
                return httpErr.StatusCode < 500
            }
            return false
        },
    }

    return &ProxyCircuitBreaker{
        cb: gobreaker.NewCircuitBreaker[*http.Response](settings),
    }
}

func (cb *ProxyCircuitBreaker) Execute(
    req func() (*http.Response, error),
) (*http.Response, error) {
    resp, err := cb.cb.Execute(func() (*http.Response, error) {
        resp, err := req()
        if err != nil {
            return nil, err
        }
        // Treat 5xx as circuit-breaker failures
        if resp.StatusCode >= 500 {
            return resp, &HTTPError{StatusCode: resp.StatusCode}
        }
        return resp, nil
    })
    return resp, err
}

func (cb *ProxyCircuitBreaker) State() gobreaker.State {
    return cb.cb.State()
}

// Integrated reverse proxy with circuit breaking
type CircuitBreakerProxy struct {
    upstream *url.URL
    cb       *ProxyCircuitBreaker
    proxy    *httputil.ReverseProxy
    timeout  time.Duration
}

func NewCircuitBreakerProxy(upstream string, cfg CircuitBreakerConfig) (*CircuitBreakerProxy, error) {
    u, err := url.Parse(upstream)
    if err != nil {
        return nil, err
    }

    proxy := httputil.NewSingleHostReverseProxy(u)
    proxy.Transport = &http.Transport{
        MaxIdleConns:          100,
        MaxIdleConnsPerHost:   20,
        IdleConnTimeout:       90 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        ResponseHeaderTimeout: 30 * time.Second,
    }

    cfg.Name = upstream
    return &CircuitBreakerProxy{
        upstream: u,
        cb:       NewCircuitBreaker(cfg),
        proxy:    proxy,
        timeout:  30 * time.Second,
    }, nil
}

func (p *CircuitBreakerProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Check circuit state before attempting request
    if p.cb.State() == gobreaker.StateOpen {
        w.Header().Set("Retry-After", "5")
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprintln(w, `{"error":"service_unavailable","reason":"circuit_open"}`)
        return
    }

    // Capture the response for circuit breaker evaluation
    rr := &responseRecorder{ResponseWriter: w, status: 200}
    var proxyErr error

    _, proxyErr = p.cb.Execute(func() (*http.Response, error) {
        ctx, cancel := context.WithTimeout(r.Context(), p.timeout)
        defer cancel()
        p.proxy.ServeHTTP(rr, r.WithContext(ctx))
        if rr.status >= 500 {
            return nil, &HTTPError{StatusCode: rr.status}
        }
        return nil, nil
    })

    if proxyErr != nil {
        var httpErr *HTTPError
        if errors.As(proxyErr, &httpErr) {
            return // Already written by proxy
        }
        // Circuit error or timeout
        if !rr.written {
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusBadGateway)
            fmt.Fprintf(w, `{"error":"bad_gateway","detail":"%s"}`,
                proxyErr.Error())
        }
    }
}
```

## Upstream Health Checking

```go
package health

import (
    "context"
    "net/http"
    "sync/atomic"
    "time"
)

type HealthCheck struct {
    url      string
    interval time.Duration
    timeout  time.Duration
    healthy  atomic.Bool
    client   *http.Client
    onStateChange func(url string, healthy bool)
}

func NewHealthCheck(url string, interval, timeout time.Duration) *HealthCheck {
    h := &HealthCheck{
        url:      url,
        interval: interval,
        timeout:  timeout,
        client: &http.Client{
            Timeout: timeout,
            Transport: &http.Transport{
                DisableKeepAlives: true, // Don't reuse health check connections
            },
        },
    }
    h.healthy.Store(true) // Optimistic initial state
    return h
}

func (h *HealthCheck) Start(ctx context.Context) {
    go h.run(ctx)
}

func (h *HealthCheck) run(ctx context.Context) {
    // Initial check
    h.check(ctx)

    ticker := time.NewTicker(h.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            h.check(ctx)
        case <-ctx.Done():
            return
        }
    }
}

func (h *HealthCheck) check(ctx context.Context) {
    ctx, cancel := context.WithTimeout(ctx, h.timeout)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.url, nil)
    req.Header.Set("User-Agent", "gateway-healthcheck/1.0")

    resp, err := h.client.Do(req)
    if err != nil {
        if h.healthy.CompareAndSwap(true, false) {
            slog.Warn("upstream health check failed", "url", h.url, "error", err)
            if h.onStateChange != nil {
                h.onStateChange(h.url, false)
            }
        }
        return
    }
    defer resp.Body.Close()

    healthy := resp.StatusCode >= 200 && resp.StatusCode < 300
    if h.healthy.CompareAndSwap(!healthy, healthy) {
        slog.Info("upstream health state changed",
            "url", h.url,
            "healthy", healthy,
            "status", resp.StatusCode,
        )
        if h.onStateChange != nil {
            h.onStateChange(h.url, healthy)
        }
    }
}

func (h *HealthCheck) IsHealthy() bool {
    return h.healthy.Load()
}

// LoadBalancer with health-aware routing
type LoadBalancer struct {
    upstreams []*Upstream
    strategy  LBStrategy
    mu        sync.RWMutex
    current   int64 // for round-robin
}

type Upstream struct {
    url     string
    weight  int
    health  *HealthCheck
    cb      *ProxyCircuitBreaker
}

func (lb *LoadBalancer) Next() (*Upstream, error) {
    lb.mu.RLock()
    defer lb.mu.RUnlock()

    healthy := make([]*Upstream, 0, len(lb.upstreams))
    for _, u := range lb.upstreams {
        if u.health.IsHealthy() && u.cb.State() != gobreaker.StateOpen {
            healthy = append(healthy, u)
        }
    }

    if len(healthy) == 0 {
        return nil, errors.New("no healthy upstreams available")
    }

    // Weighted round-robin
    n := atomic.AddInt64(&lb.current, 1)
    return healthy[int(n)%len(healthy)], nil
}
```

## Observability Integration

```go
package middleware

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

func MetricsMiddleware(metrics *Metrics) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            rr := &responseRecorder{ResponseWriter: w, status: 200}

            next.ServeHTTP(rr, r)

            dur := time.Since(start).Seconds()
            route := extractRoute(r)

            metrics.requestTotal.WithLabelValues(
                r.Method, route, strconv.Itoa(rr.status),
            ).Inc()
            metrics.requestDuration.WithLabelValues(
                r.Method, route,
            ).Observe(dur)
            metrics.responseSize.WithLabelValues(route).Observe(float64(rr.bytesWritten))
        })
    }
}

func TracingMiddleware(cfg TracingConfig) Middleware {
    tracer := otel.Tracer("api-gateway")
    propagator := otel.GetTextMapPropagator()

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract trace context from incoming request
            ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

            route := extractRoute(r)
            ctx, span := tracer.Start(ctx, "gateway."+r.Method+" "+route,
                otel.ContextWithBaggage(ctx),
            )
            defer span.End()

            // Inject trace context into request for upstream propagation
            propagator.Inject(ctx, propagation.HeaderCarrier(r.Header))

            rr := &responseRecorder{ResponseWriter: w, status: 200}
            next.ServeHTTP(rr, r.WithContext(ctx))

            span.SetAttributes(
                attribute.Int("http.status_code", rr.status),
                attribute.String("http.method", r.Method),
                attribute.String("http.route", route),
            )
        })
    }
}
```

## Complete Gateway Configuration

```yaml
# gateway.yaml
listen_addr: ":8443"
tls:
  cert_file: /etc/tls/tls.crt
  key_file: /etc/tls/tls.key
  min_version: "1.3"

jwt:
  jwks_url: "https://auth.example.com/.well-known/jwks.json"
  audience:
    - "api.example.com"
  issuer: "https://auth.example.com/"
  required_claims:
    - "sub"
    - "tid"
  refresh_interval: "5m"
  skip_paths:
    - "/healthz"
    - "/metrics"
    - "/v1/auth/token"

rate_limit:
  global_rate: 10000
  global_burst: 2000
  ip_rate: 100
  ip_burst: 50
  key_rate: 500
  key_burst: 100
  key_header: "X-API-Key"
  limit_header: true

transform:
  add_request_headers:
    "X-Gateway-Version": "v2"
    "X-Request-ID": "{{.RequestID}}"
    "X-Forwarded-For": "{{.IP}}"
  remove_response_headers:
    - "X-Powered-By"
    - "Server"
  path_rewrite:
    "^/v1/(.*)": "/api/v1/$1"
    "^/v2/(.*)": "/api/v2/$1"

routes:
  - path_prefix: "/v1/users"
    upstream: "http://user-service:8080"
    circuit_breaker:
      max_requests: 5
      interval: "10s"
      timeout: "30s"
    health_check:
      url: "http://user-service:8080/healthz"
      interval: "10s"
      timeout: "3s"
    timeout: "15s"
    auth_required: true
    required_roles: []

  - path_prefix: "/v1/orders"
    upstream: "http://order-service:8080"
    circuit_breaker:
      max_requests: 10
      interval: "10s"
      timeout: "60s"
    auth_required: true
    required_roles: ["orders:read"]
    timeout: "30s"

  - path_prefix: "/v1/reports"
    upstream: "http://reporting-service:8080"
    auth_required: true
    required_roles: ["reports:read"]
    timeout: "120s"  # Reports can be slow

observability:
  metrics_port: 9090
  tracing:
    endpoint: "http://jaeger-collector:4317"
    sample_rate: 0.1
  log_level: "info"
```

## Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-gateway
  template:
    spec:
      containers:
      - name: gateway
        image: myregistry/api-gateway:v2.0.1
        args: ["--config=/etc/gateway/gateway.yaml"]
        ports:
        - containerPort: 8443
          name: https
        - containerPort: 9090
          name: metrics
        resources:
          requests:
            cpu: 500m
            memory: 256Mi
          limits:
            cpu: 2000m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8443
            scheme: HTTPS
          initialDelaySeconds: 5
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8443
            scheme: HTTPS
          initialDelaySeconds: 2
        volumeMounts:
        - name: config
          mountPath: /etc/gateway
        - name: tls
          mountPath: /etc/tls
      volumes:
      - name: config
        configMap:
          name: gateway-config
      - name: tls
        secret:
          secretName: gateway-tls
```

The patterns in this guide compose into a production-quality API gateway that handles hundreds of thousands of requests per second while maintaining sub-millisecond overhead per request. The key is keeping each middleware focused: rate limiting does only rate limiting, JWT validation does only JWT validation, and the chain applies them in the correct order.
