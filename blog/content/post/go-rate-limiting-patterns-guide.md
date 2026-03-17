---
title: "Go Rate Limiting Patterns: Token Bucket, Sliding Window, and Distributed Redis Limiting"
date: 2028-05-20T00:00:00-05:00
draft: false
tags: ["Go", "Rate Limiting", "Redis", "Performance", "API", "Middleware", "golang.org/x/time/rate"]
categories: ["Go", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go rate limiting: token bucket with golang.org/x/time/rate, sliding window algorithm, Redis-based distributed limiting for multi-instance deployments, per-client limits, and HTTP middleware patterns."
more_link: "yes"
url: "/go-rate-limiting-patterns-guide/"
---

Rate limiting protects services from overload, prevents API abuse, and ensures fair resource allocation across clients. Go's standard library provides a solid token bucket implementation in `golang.org/x/time/rate`, but production systems require more: per-client limits, distributed coordination across multiple service instances, sliding window semantics, and telemetry. This guide covers the full spectrum from single-process rate limiting to distributed Redis-backed systems.

<!--more-->

## Rate Limiting Algorithms

Understanding the algorithms before implementing them:

### Token Bucket
A bucket holds tokens up to a maximum capacity. Tokens are added at a constant rate. Each request consumes one (or more) tokens. If the bucket is empty, the request is rate-limited. Allows short bursts up to bucket capacity, then enforces the average rate.

**Best for**: APIs that allow short bursts, most general-purpose rate limiting.

### Leaky Bucket
Requests enter a queue and are processed at a constant rate. Unlike token bucket, there is no burst capacity - output is smooth and constant. Overflow requests are dropped.

**Best for**: Smoothing bursty input for downstream systems that can't handle bursts.

### Sliding Window
Counts requests in a rolling time window. More accurate than fixed windows because it doesn't have the "two windows" edge case. A client limited to 100 req/min cannot send 200 requests by timing them at the minute boundary.

**Best for**: Per-client API limits where fairness matters.

### Fixed Window Counter
Counts requests in fixed time periods (e.g., count resets at :00 of each minute). Simple but vulnerable to boundary bursting.

**Best for**: Simple implementations where boundary abuse is acceptable.

## golang.org/x/time/rate: Token Bucket Implementation

The standard Go rate limiter for single-process scenarios:

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "golang.org/x/time/rate"
)

func main() {
    // 100 requests per second, burst of 20
    // rate.Limit is requests per second (float64)
    limiter := rate.NewLimiter(rate.Limit(100), 20)

    // Check if request is allowed (non-blocking)
    if !limiter.Allow() {
        fmt.Println("Rate limited")
        return
    }

    // Wait for a token (blocking with context)
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()

    if err := limiter.Wait(ctx); err != nil {
        fmt.Printf("Rate limit wait failed: %v\n", err)
        return
    }

    fmt.Println("Request allowed")
}
```

### Rate Limit Helpers

```go
// rate.Every converts duration-per-request to requests-per-second
limiter := rate.NewLimiter(rate.Every(10*time.Millisecond), 100)
// Equivalent to 100 req/s with burst of 100

// Consume multiple tokens for weighted operations
limiter := rate.NewLimiter(rate.Limit(1000), 500) // 1000 "units" per second

// Large file download costs 100 units
if !limiter.AllowN(time.Now(), 100) {
    http.Error(w, "rate limited", http.StatusTooManyRequests)
    return
}

// Reserve tokens for future use
reservation := limiter.Reserve()
if !reservation.OK() {
    // Would exceed burst
    http.Error(w, "rate limited", http.StatusTooManyRequests)
    return
}
time.Sleep(reservation.Delay()) // Wait until token is available
```

## Per-Client Rate Limiting

For API services, each client needs independent limits:

```go
package ratelimit

import (
    "net"
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type ClientLimiter struct {
    mu       sync.Mutex
    clients  map[string]*clientEntry
    rate     rate.Limit
    burst    int
    ttl      time.Duration
}

type clientEntry struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

func NewClientLimiter(r rate.Limit, burst int, ttl time.Duration) *ClientLimiter {
    cl := &ClientLimiter{
        clients: make(map[string]*clientEntry),
        rate:    r,
        burst:   burst,
        ttl:     ttl,
    }

    // Cleanup goroutine removes idle clients
    go cl.cleanupLoop()

    return cl
}

func (cl *ClientLimiter) getLimiter(key string) *rate.Limiter {
    cl.mu.Lock()
    defer cl.mu.Unlock()

    entry, exists := cl.clients[key]
    if !exists {
        entry = &clientEntry{
            limiter: rate.NewLimiter(cl.rate, cl.burst),
        }
        cl.clients[key] = entry
    }

    entry.lastSeen = time.Now()
    return entry.limiter
}

func (cl *ClientLimiter) Allow(key string) bool {
    return cl.getLimiter(key).Allow()
}

func (cl *ClientLimiter) Wait(ctx context.Context, key string) error {
    return cl.getLimiter(key).Wait(ctx)
}

func (cl *ClientLimiter) cleanupLoop() {
    ticker := time.NewTicker(cl.ttl / 2)
    defer ticker.Stop()

    for range ticker.C {
        cl.cleanup()
    }
}

func (cl *ClientLimiter) cleanup() {
    cl.mu.Lock()
    defer cl.mu.Unlock()

    cutoff := time.Now().Add(-cl.ttl)
    for key, entry := range cl.clients {
        if entry.lastSeen.Before(cutoff) {
            delete(cl.clients, key)
        }
    }
}

// HTTP middleware for per-IP rate limiting
func (cl *ClientLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract client IP, handling proxy headers
        ip := extractClientIP(r)

        if !cl.Allow(ip) {
            w.Header().Set("Retry-After", "1")
            w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%v", cl.rate))
            http.Error(w, `{"error":"rate_limited","message":"too many requests"}`,
                http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func extractClientIP(r *http.Request) string {
    // Trust X-Forwarded-For from trusted proxies
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        // First IP in chain is the original client
        if ip, _, err := net.SplitHostPort(xff); err == nil {
            return ip
        }
        return xff
    }
    if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
        return xrip
    }
    ip, _, _ := net.SplitHostPort(r.RemoteAddr)
    return ip
}
```

## API Key-Based Rate Limiting with Tiered Limits

Different clients get different rate limits based on their subscription tier:

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

type Tier struct {
    RequestsPerSecond rate.Limit
    Burst             int
}

var tiers = map[string]Tier{
    "free":       {RequestsPerSecond: 1, Burst: 10},
    "starter":    {RequestsPerSecond: 10, Burst: 50},
    "pro":        {RequestsPerSecond: 100, Burst: 200},
    "enterprise": {RequestsPerSecond: 1000, Burst: 2000},
}

type TieredLimiter struct {
    mu       sync.RWMutex
    limiters map[string]*apiKeyEntry
}

type apiKeyEntry struct {
    limiter  *rate.Limiter
    tier     string
    lastSeen time.Time
}

func NewTieredLimiter() *TieredLimiter {
    tl := &TieredLimiter{
        limiters: make(map[string]*apiKeyEntry),
    }
    go tl.cleanupLoop()
    return tl
}

func (tl *TieredLimiter) SetLimit(apiKey string, tier string) error {
    t, ok := tiers[tier]
    if !ok {
        return fmt.Errorf("unknown tier: %s", tier)
    }

    tl.mu.Lock()
    defer tl.mu.Unlock()

    if entry, exists := tl.limiters[apiKey]; exists {
        // Update existing limiter (e.g., plan upgrade)
        entry.limiter.SetLimit(t.RequestsPerSecond)
        entry.limiter.SetBurst(t.Burst)
        entry.tier = tier
        return nil
    }

    tl.limiters[apiKey] = &apiKeyEntry{
        limiter:  rate.NewLimiter(t.RequestsPerSecond, t.Burst),
        tier:     tier,
        lastSeen: time.Now(),
    }
    return nil
}

func (tl *TieredLimiter) Allow(apiKey string) (bool, string) {
    tl.mu.RLock()
    entry, exists := tl.limiters[apiKey]
    tl.mu.RUnlock()

    if !exists {
        return false, "unknown_key"
    }

    tl.mu.Lock()
    entry.lastSeen = time.Now()
    tl.mu.Unlock()

    if !entry.limiter.Allow() {
        return false, entry.tier
    }

    return true, entry.tier
}

func (tl *TieredLimiter) Middleware(lookupTier func(apiKey string) (string, error)) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            apiKey := r.Header.Get("X-API-Key")
            if apiKey == "" {
                http.Error(w, `{"error":"missing_api_key"}`, http.StatusUnauthorized)
                return
            }

            // Lazy initialization: set limit on first request
            if _, exists := tl.limiters[apiKey]; !exists {
                tier, err := lookupTier(apiKey)
                if err != nil {
                    http.Error(w, `{"error":"invalid_api_key"}`, http.StatusUnauthorized)
                    return
                }
                tl.SetLimit(apiKey, tier)
            }

            allowed, tier := tl.Allow(apiKey)

            // Add rate limit headers
            t := tiers[tier]
            w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%v", t.RequestsPerSecond))
            w.Header().Set("X-RateLimit-Tier", tier)

            if !allowed {
                w.Header().Set("Retry-After", "1")
                http.Error(w,
                    `{"error":"rate_limited","tier":"`+tier+`"}`,
                    http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Redis-Based Distributed Rate Limiting

Single-process limiters break in multi-instance deployments. Redis provides atomic distributed counting:

### Sliding Window with Redis ZADD

```go
package distributed

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type SlidingWindowLimiter struct {
    client    *redis.Client
    keyPrefix string
    window    time.Duration
    limit     int64
}

func NewSlidingWindowLimiter(
    client *redis.Client,
    keyPrefix string,
    window time.Duration,
    limit int64,
) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        client:    client,
        keyPrefix: keyPrefix,
        window:    window,
        limit:     limit,
    }
}

func (l *SlidingWindowLimiter) Allow(ctx context.Context, identifier string) (bool, int64, error) {
    key := fmt.Sprintf("%s:%s", l.keyPrefix, identifier)
    now := time.Now()
    windowStart := now.Add(-l.window)

    // Lua script for atomic sliding window check
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local member = ARGV[4]
        local ttl = tonumber(ARGV[5])

        -- Remove expired entries
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current requests in window
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Add current request
            redis.call('ZADD', key, now, member)
            redis.call('EXPIRE', key, ttl)
            return {1, count + 1}
        else
            return {0, count}
        end
    `)

    member := fmt.Sprintf("%d-%d", now.UnixNano(), time.Now().Unix())
    ttlSeconds := int(l.window.Seconds()) + 1

    result, err := script.Run(ctx, l.client, []string{key},
        float64(now.UnixNano())/1e9,
        float64(windowStart.UnixNano())/1e9,
        l.limit,
        member,
        ttlSeconds,
    ).Int64Slice()

    if err != nil {
        return false, 0, fmt.Errorf("redis script: %w", err)
    }

    allowed := result[0] == 1
    current := result[1]

    return allowed, current, nil
}

func (l *SlidingWindowLimiter) Remaining(ctx context.Context, identifier string) (int64, error) {
    key := fmt.Sprintf("%s:%s", l.keyPrefix, identifier)
    windowStart := time.Now().Add(-l.window)

    pipe := l.client.Pipeline()
    pipe.ZRemRangeByScore(ctx, key, "-inf",
        fmt.Sprintf("%f", float64(windowStart.UnixNano())/1e9))
    countCmd := pipe.ZCard(ctx, key)

    if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
        return 0, err
    }

    count := countCmd.Val()
    remaining := l.limit - count
    if remaining < 0 {
        remaining = 0
    }

    return remaining, nil
}
```

### Token Bucket with Redis (Lua Script)

```go
// Token bucket algorithm in Redis using Lua for atomicity
func (l *TokenBucketLimiter) Allow(ctx context.Context, identifier string) (bool, float64, error) {
    key := fmt.Sprintf("%s:%s", l.keyPrefix, identifier)

    script := redis.NewScript(`
        local key = KEYS[1]
        local rate = tonumber(ARGV[1])       -- tokens per second
        local burst = tonumber(ARGV[2])      -- max tokens
        local now = tonumber(ARGV[3])        -- current time (unix seconds, float)
        local requested = tonumber(ARGV[4])  -- tokens to consume

        local fill_time = burst / rate
        local ttl = math.ceil(fill_time * 2)

        local last_tokens = tonumber(redis.call('HGET', key, 'tokens'))
        local last_refreshed = tonumber(redis.call('HGET', key, 'refreshed'))

        if last_tokens == nil then
            last_tokens = burst
            last_refreshed = now
        end

        -- Calculate tokens added since last refresh
        local delta = math.max(0, now - last_refreshed)
        local filled_tokens = math.min(burst, last_tokens + (delta * rate))
        local allowed = filled_tokens >= requested
        local new_tokens = filled_tokens

        if allowed then
            new_tokens = filled_tokens - requested
        end

        redis.call('HSET', key, 'tokens', new_tokens, 'refreshed', now)
        redis.call('EXPIRE', key, ttl)

        return {allowed and 1 or 0, new_tokens}
    `)

    now := float64(time.Now().UnixNano()) / 1e9

    result, err := script.Run(ctx, l.client, []string{key},
        l.rate,     // tokens per second
        l.burst,    // max burst
        now,
        1,          // tokens to consume
    ).Int64Slice()

    if err != nil {
        return false, 0, fmt.Errorf("token bucket script: %w", err)
    }

    return result[0] == 1, float64(result[1]), nil
}
```

### Redis Rate Limiter with Circuit Breaker

In production, Redis can be unavailable. Fall back to local rate limiting:

```go
package distributed

import (
    "context"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type ResilientLimiter struct {
    redis          *SlidingWindowLimiter
    local          *ClientLimiter
    mu             sync.RWMutex
    redisAvailable bool
    lastCheck      time.Time
    checkInterval  time.Duration
}

func NewResilientLimiter(
    redis *SlidingWindowLimiter,
    localRate rate.Limit,
    localBurst int,
) *ResilientLimiter {
    return &ResilientLimiter{
        redis:          redis,
        local:          NewClientLimiter(localRate, localBurst, 10*time.Minute),
        redisAvailable: true,
        checkInterval:  5 * time.Second,
    }
}

func (rl *ResilientLimiter) Allow(ctx context.Context, identifier string) bool {
    rl.mu.RLock()
    available := rl.redisAvailable
    lastCheck := rl.lastCheck
    rl.mu.RUnlock()

    // Periodically retry Redis if it was unavailable
    if !available && time.Since(lastCheck) > rl.checkInterval {
        rl.mu.Lock()
        rl.redisAvailable = true // Optimistic reset
        rl.lastCheck = time.Now()
        rl.mu.Unlock()
        available = true
    }

    if available {
        allowed, _, err := rl.redis.Allow(ctx, identifier)
        if err != nil {
            // Redis failed - switch to local limiting
            rl.mu.Lock()
            rl.redisAvailable = false
            rl.lastCheck = time.Now()
            rl.mu.Unlock()

            return rl.local.Allow(identifier)
        }
        return allowed
    }

    return rl.local.Allow(identifier)
}
```

## HTTP Middleware Patterns

### Standard Library Middleware

```go
package middleware

import (
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type RateLimitMiddleware struct {
    limiter   RateLimiter
    keyFunc   func(*http.Request) string
    onLimited func(http.ResponseWriter, *http.Request, RateLimitInfo)
}

type RateLimitInfo struct {
    Limit     int64
    Remaining int64
    Reset     time.Time
}

type RateLimiter interface {
    Allow(ctx context.Context, key string) (allowed bool, remaining int64, err error)
}

func NewRateLimitMiddleware(
    limiter RateLimiter,
    keyFunc func(*http.Request) string,
) *RateLimitMiddleware {
    m := &RateLimitMiddleware{
        limiter: limiter,
        keyFunc: keyFunc,
    }
    m.onLimited = m.defaultOnLimited
    return m
}

func (m *RateLimitMiddleware) defaultOnLimited(w http.ResponseWriter, r *http.Request, info RateLimitInfo) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Retry-After", fmt.Sprintf("%.0f", time.Until(info.Reset).Seconds()))
    w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", info.Limit))
    w.Header().Set("X-RateLimit-Remaining", "0")
    w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%d", info.Reset.Unix()))
    w.WriteHeader(http.StatusTooManyRequests)
    json.NewEncoder(w).Encode(map[string]string{
        "error":   "rate_limit_exceeded",
        "message": "Too many requests. Please retry later.",
    })
}

func (m *RateLimitMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := m.keyFunc(r)

        allowed, remaining, err := m.limiter.Allow(r.Context(), key)
        if err != nil {
            // On error, allow request to proceed (fail open)
            // Log the error for alerting
            next.ServeHTTP(w, r)
            return
        }

        // Add rate limit headers to all responses
        w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))

        if !allowed {
            m.onLimited(w, r, RateLimitInfo{
                Remaining: 0,
                Reset:     time.Now().Add(time.Second),
            })
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

### Chi/Gorilla Mux Integration

```go
// Route-specific rate limiting with different limits per endpoint
router := chi.NewRouter()

// Strict limit on auth endpoints
authLimiter := NewClientLimiter(
    rate.Limit(5),    // 5 req/s
    10,               // burst
    5*time.Minute,
)
router.With(authLimiter.Middleware).Post("/auth/login", loginHandler)
router.With(authLimiter.Middleware).Post("/auth/register", registerHandler)

// Standard limit for API
apiLimiter := distributed.NewSlidingWindowLimiter(
    redisClient, "api", time.Minute, 1000,
)
apiMiddleware := NewRateLimitMiddleware(apiLimiter,
    func(r *http.Request) string {
        return r.Header.Get("X-API-Key")
    })
router.With(apiMiddleware.Handler).Route("/api/v1", func(r chi.Router) {
    r.Get("/users", listUsersHandler)
    r.Get("/orders", listOrdersHandler)
})

// No rate limit on health endpoints
router.Get("/healthz", healthHandler)
```

### gRPC Interceptor

```go
package interceptor

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

func RateLimitUnaryInterceptor(limiter RateLimiter) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Extract client identifier from gRPC metadata
        md, _ := metadata.FromIncomingContext(ctx)

        var key string
        if keys := md.Get("x-api-key"); len(keys) > 0 {
            key = keys[0]
        } else if peers := md.Get("x-forwarded-for"); len(peers) > 0 {
            key = peers[0]
        } else {
            key = "anonymous"
        }

        allowed, _, err := limiter.Allow(ctx, key)
        if err != nil || !allowed {
            return nil, status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded for %s", key)
        }

        return handler(ctx, req)
    }
}

func RateLimitStreamInterceptor(limiter RateLimiter) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        md, _ := metadata.FromIncomingContext(ss.Context())

        key := "anonymous"
        if keys := md.Get("x-api-key"); len(keys) > 0 {
            key = keys[0]
        }

        allowed, _, err := limiter.Allow(ss.Context(), key)
        if err != nil || !allowed {
            return status.Errorf(codes.ResourceExhausted, "rate limit exceeded")
        }

        return handler(srv, ss)
    }
}
```

## Rate Limit Headers and RFC 7231 Compliance

Modern APIs follow the IETF rate limit headers draft:

```go
func setRateLimitHeaders(w http.ResponseWriter, info RateLimitInfo) {
    // Standard headers (IETF draft-ietf-httpapi-ratelimit-headers)
    w.Header().Set("RateLimit-Limit", fmt.Sprintf("%d", info.Limit))
    w.Header().Set("RateLimit-Remaining", fmt.Sprintf("%d", info.Remaining))
    w.Header().Set("RateLimit-Reset", fmt.Sprintf("%d", info.Reset.Unix()))

    // Legacy headers (widely supported)
    w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", info.Limit))
    w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", info.Remaining))
    w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%d", info.Reset.Unix()))
}
```

## Testing Rate Limiters

```go
package ratelimit_test

import (
    "context"
    "sync"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestSlidingWindowLimiter_AllowsWithinLimit(t *testing.T) {
    mr := miniredis.RunT(t)
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

    limiter := NewSlidingWindowLimiter(client, "test", time.Minute, 10)

    // Should allow up to 10 requests
    for i := 0; i < 10; i++ {
        allowed, remaining, err := limiter.Allow(context.Background(), "client-1")
        require.NoError(t, err)
        assert.True(t, allowed, "Request %d should be allowed", i+1)
        assert.Equal(t, int64(10-(i+1)), remaining)
    }

    // 11th request should be denied
    allowed, _, err := limiter.Allow(context.Background(), "client-1")
    require.NoError(t, err)
    assert.False(t, allowed, "11th request should be rate limited")
}

func TestSlidingWindowLimiter_ResetsAfterWindow(t *testing.T) {
    mr := miniredis.RunT(t)
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

    window := 100 * time.Millisecond
    limiter := NewSlidingWindowLimiter(client, "test", window, 5)

    // Exhaust the limit
    for i := 0; i < 5; i++ {
        allowed, _, err := limiter.Allow(context.Background(), "client-1")
        require.NoError(t, err)
        assert.True(t, allowed)
    }

    // Should be limited
    allowed, _, err := limiter.Allow(context.Background(), "client-1")
    require.NoError(t, err)
    assert.False(t, allowed)

    // Wait for window to expire
    mr.FastForward(window + 10*time.Millisecond)

    // Should be allowed again
    allowed, _, err = limiter.Allow(context.Background(), "client-1")
    require.NoError(t, err)
    assert.True(t, allowed, "Request should be allowed after window reset")
}

func TestClientLimiter_ConcurrentAccess(t *testing.T) {
    limiter := NewClientLimiter(
        rate.Limit(100), // 100 req/s
        200,             // burst
        5*time.Minute,
    )

    var wg sync.WaitGroup
    allowed := int64(0)
    denied := int64(0)
    var mu sync.Mutex

    // Simulate 50 concurrent clients each sending 10 requests
    for client := 0; client < 50; client++ {
        wg.Add(1)
        go func(clientID int) {
            defer wg.Done()
            key := fmt.Sprintf("client-%d", clientID)
            for req := 0; req < 10; req++ {
                if limiter.Allow(key) {
                    mu.Lock()
                    allowed++
                    mu.Unlock()
                } else {
                    mu.Lock()
                    denied++
                    mu.Unlock()
                }
            }
        }(client)
    }

    wg.Wait()

    total := allowed + denied
    assert.Equal(t, int64(500), total, "Total requests should be 500")
    t.Logf("Allowed: %d, Denied: %d", allowed, denied)
}
```

## Observability

```go
// Instrument rate limiting with Prometheus
var (
    rateLimitAllowed = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "rate_limit_allowed_total",
            Help: "Total number of allowed requests",
        },
        []string{"endpoint", "tier"},
    )

    rateLimitDenied = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "rate_limit_denied_total",
            Help: "Total number of rate-limited requests",
        },
        []string{"endpoint", "tier"},
    )

    rateLimitCurrent = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "rate_limit_current_usage",
            Help: "Current rate limit usage ratio (0-1)",
        },
        []string{"client"},
    )
)

func (m *RateLimitMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := m.keyFunc(r)
        endpoint := r.URL.Path

        allowed, remaining, err := m.limiter.Allow(r.Context(), key)

        if err == nil {
            label := prometheus.Labels{"endpoint": endpoint, "tier": "default"}
            if allowed {
                rateLimitAllowed.With(label).Inc()
            } else {
                rateLimitDenied.With(label).Inc()
            }
        }

        if !allowed {
            m.onLimited(w, r, RateLimitInfo{})
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

## Summary

Go rate limiting spans from simple per-process token buckets to distributed Redis-backed sliding windows coordinating across dozens of service instances. `golang.org/x/time/rate` handles the majority of single-process cases with minimal overhead. Per-client limiters with TTL-based cleanup handle API key scenarios. Redis Lua scripts provide atomicity guarantees for distributed scenarios. The resilient limiter pattern ensures services degrade gracefully when Redis is unavailable. Proper HTTP headers, gRPC interceptors, and Prometheus instrumentation complete the production picture.
