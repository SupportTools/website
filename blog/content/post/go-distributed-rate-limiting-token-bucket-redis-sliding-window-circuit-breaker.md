---
title: "Go Distributed Rate Limiting: Token Bucket Across Replicas, Redis Sliding Window, and Circuit Breaker Integration"
date: 2031-11-09T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Rate Limiting", "Redis", "Distributed Systems", "Circuit Breaker", "Token Bucket"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing distributed rate limiting in Go, including synchronized token bucket across replicas, Redis-backed sliding window counters, and circuit breaker integration for resilient API protection."
more_link: "yes"
url: "/go-distributed-rate-limiting-token-bucket-redis-sliding-window-circuit-breaker/"
---

Rate limiting in a distributed Go service presents a deceptively complex problem. Local token buckets fail when multiple replicas service the same client. Database-backed counters introduce latency on every request. Redis Lua scripts provide atomic operations but require careful handling of Redis failures. This post builds a complete distributed rate limiting stack from first principles, including a Redis-backed sliding window counter, a fallback to local rate limiting when Redis is unavailable, and circuit breaker integration.

<!--more-->

# Go Distributed Rate Limiting: Token Bucket Across Replicas, Redis Sliding Window, and Circuit Breaker Integration

## The Distributed Rate Limiting Problem

When a service runs as multiple replicas behind a load balancer, each replica maintains its own in-memory rate limiter state. A client can exceed the intended global rate limit by distributing requests across replicas. For example, with 10 replicas each allowing 100 req/s, a client can send 1000 req/s without triggering any local limiter.

The approaches to solve this, ranked by complexity and accuracy:

1. **Sticky sessions**: Route a client to the same replica consistently. Simple but defeats horizontal scaling.
2. **Centralized counter (Redis)**: All replicas share state. Accurate but adds latency and a dependency.
3. **Approximate distributed counting**: Gossip or sliding-window approximation with some over-admission tolerance.
4. **Token bucket with Redis**: Precise, but requires atomic Redis operations.

Production systems typically use approach 2 with a circuit breaker to fall back to approach 1 when Redis is unavailable.

## Section 1: Local Rate Limiter Foundation

### 1.1 Token Bucket Implementation

```go
// ratelimit/tokenbucket.go
package ratelimit

import (
    "sync"
    "time"
)

// TokenBucket implements a classic token bucket rate limiter.
// Thread-safe. Suitable for single-process use.
type TokenBucket struct {
    mu           sync.Mutex
    capacity     float64   // Maximum tokens
    tokens       float64   // Current token count
    refillRate   float64   // Tokens added per second
    lastRefillAt time.Time
    clock        Clock
}

// Clock is an interface for time operations, allowing test injection.
type Clock interface {
    Now() time.Time
    Sleep(d time.Duration)
}

type realClock struct{}

func (realClock) Now() time.Time          { return time.Now() }
func (realClock) Sleep(d time.Duration)   { time.Sleep(d) }

// NewTokenBucket creates a token bucket with the given capacity and refill rate.
// capacity: maximum burst size (tokens)
// ratePerSecond: sustained throughput
func NewTokenBucket(capacity, ratePerSecond float64) *TokenBucket {
    return &TokenBucket{
        capacity:     capacity,
        tokens:       capacity, // Start full
        refillRate:   ratePerSecond,
        lastRefillAt: time.Now(),
        clock:        realClock{},
    }
}

// Allow checks if n tokens are available and consumes them if so.
// Returns true if the request is allowed, false if rate limited.
func (tb *TokenBucket) Allow(n float64) bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    tb.refill()

    if tb.tokens < n {
        return false
    }

    tb.tokens -= n
    return true
}

// Reserve returns the duration to wait before n tokens will be available.
// Returns 0 if tokens are available immediately.
func (tb *TokenBucket) Reserve(n float64) time.Duration {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    tb.refill()

    if tb.tokens >= n {
        tb.tokens -= n
        return 0
    }

    deficit := n - tb.tokens
    waitSeconds := deficit / tb.refillRate
    return time.Duration(waitSeconds * float64(time.Second))
}

func (tb *TokenBucket) refill() {
    now := tb.clock.Now()
    elapsed := now.Sub(tb.lastRefillAt).Seconds()
    tb.tokens = min(tb.capacity, tb.tokens+(elapsed*tb.refillRate))
    tb.lastRefillAt = now
}

// Available returns the current number of available tokens.
func (tb *TokenBucket) Available() float64 {
    tb.mu.Lock()
    defer tb.mu.Unlock()
    tb.refill()
    return tb.tokens
}

func min(a, b float64) float64 {
    if a < b {
        return a
    }
    return b
}
```

### 1.2 Leaky Bucket (Rate Smoothing)

```go
// ratelimit/leakybucket.go
package ratelimit

import (
    "context"
    "time"
)

// LeakyBucket smooths request rates by queuing and draining at a fixed rate.
// Unlike TokenBucket, it does not allow bursting; all requests are delayed
// to maintain the target rate.
type LeakyBucket struct {
    rate     float64       // Allowed requests per second
    interval time.Duration // 1/rate
    last     time.Time
    mu       sync.Mutex
}

func NewLeakyBucket(ratePerSecond float64) *LeakyBucket {
    return &LeakyBucket{
        rate:     ratePerSecond,
        interval: time.Duration(float64(time.Second) / ratePerSecond),
        last:     time.Now().Add(-time.Duration(float64(time.Second) / ratePerSecond)),
    }
}

// Take blocks until the rate limit allows the request to proceed.
// ctx cancellation causes an immediate return.
func (lb *LeakyBucket) Take(ctx context.Context) error {
    lb.mu.Lock()

    now := time.Now()
    next := lb.last.Add(lb.interval)
    wait := next.Sub(now)

    if wait <= 0 {
        lb.last = now
        lb.mu.Unlock()
        return nil
    }

    lb.last = next
    lb.mu.Unlock()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(wait):
        return nil
    }
}
```

## Section 2: Redis-Backed Distributed Rate Limiter

### 2.1 Sliding Window Counter with Lua

The sliding window counter is more accurate than the fixed window counter (which resets abruptly) while being more efficient than tracking every individual request.

```go
// ratelimit/redis_sliding_window.go
package ratelimit

import (
    "context"
    "crypto/sha256"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// slidingWindowLua atomically:
// 1. Removes entries older than the window
// 2. Adds the current timestamp
// 3. Returns the current count
// 4. Sets TTL on the key
//
// KEYS[1] = rate limit key (e.g., "ratelimit:user:12345")
// ARGV[1] = current timestamp in microseconds
// ARGV[2] = window size in microseconds
// ARGV[3] = limit (max requests per window)
// ARGV[4] = TTL in seconds (should be > window_seconds)
const slidingWindowLua = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count current entries
local count = redis.call('ZCARD', key)

if count < limit then
    -- Add current request
    redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
    redis.call('EXPIRE', key, ttl)
    return {1, count + 1, limit}  -- allowed, new_count, limit
else
    return {0, count, limit}       -- denied, current_count, limit
end
`

// SlidingWindowResult contains the outcome of a rate limit check.
type SlidingWindowResult struct {
    Allowed      bool
    CurrentCount int64
    Limit        int64
    RetryAfter   time.Duration
}

// RedisSlidingWindow is a distributed sliding window rate limiter backed by Redis.
type RedisSlidingWindow struct {
    client     redis.UniversalClient
    scriptSHA  string
    windowSize time.Duration
    limit      int64
}

// NewRedisSlidingWindow creates a new sliding window rate limiter.
// windowSize: the time window (e.g., time.Minute for 100 req/min)
// limit: maximum requests allowed per window
func NewRedisSlidingWindow(
    client redis.UniversalClient,
    windowSize time.Duration,
    limit int64,
) (*RedisSlidingWindow, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Pre-load the Lua script and cache its SHA
    sha, err := client.ScriptLoad(ctx, slidingWindowLua).Result()
    if err != nil {
        return nil, fmt.Errorf("loading sliding window Lua script: %w", err)
    }

    return &RedisSlidingWindow{
        client:     client,
        scriptSHA:  sha,
        windowSize: windowSize,
        limit:      limit,
    }, nil
}

// Allow checks whether the request identified by key is within the rate limit.
func (r *RedisSlidingWindow) Allow(ctx context.Context, key string) (*SlidingWindowResult, error) {
    now := time.Now().UnixMicro()
    windowMicros := r.windowSize.Microseconds()
    ttlSeconds := int64(r.windowSize.Seconds()) + 1

    // Execute the pre-loaded Lua script
    result, err := r.client.EvalSha(ctx, r.scriptSHA,
        []string{key},
        now,
        windowMicros,
        r.limit,
        ttlSeconds,
    ).Int64Slice()

    if err != nil {
        // Script might have been evicted; try reloading
        if err.Error() == "NOSCRIPT No matching script" {
            sha, loadErr := r.client.ScriptLoad(ctx, slidingWindowLua).Result()
            if loadErr != nil {
                return nil, fmt.Errorf("reloading script: %w", loadErr)
            }
            r.scriptSHA = sha
            return r.Allow(ctx, key)
        }
        return nil, fmt.Errorf("executing rate limit script: %w", err)
    }

    if len(result) != 3 {
        return nil, fmt.Errorf("unexpected script result length: %d", len(result))
    }

    allowed := result[0] == 1
    currentCount := result[1]
    limit := result[2]

    res := &SlidingWindowResult{
        Allowed:      allowed,
        CurrentCount: currentCount,
        Limit:        limit,
    }

    if !allowed {
        // Estimate retry-after: time until oldest entry expires
        res.RetryAfter = r.estimateRetryAfter(ctx, key, now)
    }

    return res, nil
}

func (r *RedisSlidingWindow) estimateRetryAfter(ctx context.Context, key string, nowMicros int64) time.Duration {
    // Get the oldest entry in the window
    entries, err := r.client.ZRangeWithScores(ctx, key, 0, 0).Result()
    if err != nil || len(entries) == 0 {
        return r.windowSize
    }

    oldestMicros := int64(entries[0].Score)
    expiresInMicros := oldestMicros + r.windowSize.Microseconds() - nowMicros
    if expiresInMicros <= 0 {
        return time.Millisecond // Retry immediately
    }
    return time.Duration(expiresInMicros) * time.Microsecond
}
```

### 2.2 Token Bucket in Redis

For use cases that need burst tolerance at the distributed level:

```go
// ratelimit/redis_token_bucket.go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// tokenBucketLua implements a token bucket in Redis.
// Tokens are stored as a float with the last refill timestamp.
//
// KEYS[1] = bucket key
// ARGV[1] = current timestamp (seconds, float)
// ARGV[2] = refill rate (tokens per second)
// ARGV[3] = capacity (max tokens)
// ARGV[4] = requested tokens
// ARGV[5] = TTL (seconds)
const tokenBucketLua = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local last_tokens, last_time

local data = redis.call('HMGET', key, 'tokens', 'last_time')
last_tokens = tonumber(data[1]) or capacity
last_time = tonumber(data[2]) or now

-- Refill tokens based on elapsed time
local elapsed = now - last_time
local new_tokens = math.min(capacity, last_tokens + (elapsed * rate))

if new_tokens >= requested then
    new_tokens = new_tokens - requested
    redis.call('HMSET', key, 'tokens', new_tokens, 'last_time', now)
    redis.call('EXPIRE', key, ttl)
    return {1, new_tokens}  -- allowed, remaining_tokens
else
    redis.call('HMSET', key, 'tokens', new_tokens, 'last_time', now)
    redis.call('EXPIRE', key, ttl)
    local wait = (requested - new_tokens) / rate
    return {0, new_tokens, wait}  -- denied, current_tokens, wait_seconds
end
`

type RedisTokenBucket struct {
    client    redis.UniversalClient
    scriptSHA string
    rate      float64
    capacity  float64
    ttl       time.Duration
}

func NewRedisTokenBucket(
    client redis.UniversalClient,
    capacity float64,
    ratePerSecond float64,
) (*RedisTokenBucket, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    sha, err := client.ScriptLoad(ctx, tokenBucketLua).Result()
    if err != nil {
        return nil, fmt.Errorf("loading token bucket Lua script: %w", err)
    }

    return &RedisTokenBucket{
        client:    client,
        scriptSHA: sha,
        rate:      ratePerSecond,
        capacity:  capacity,
        ttl:       time.Duration(capacity/ratePerSecond*2) * time.Second,
    }, nil
}

type TokenBucketResult struct {
    Allowed        bool
    RemainingTokens float64
    WaitDuration   time.Duration
}

func (r *RedisTokenBucket) Allow(ctx context.Context, key string, tokens float64) (*TokenBucketResult, error) {
    now := float64(time.Now().UnixNano()) / 1e9

    result, err := r.client.EvalSha(ctx, r.scriptSHA,
        []string{key},
        now,
        r.rate,
        r.capacity,
        tokens,
        int64(r.ttl.Seconds()),
    ).Slice()

    if err != nil {
        return nil, fmt.Errorf("executing token bucket script: %w", err)
    }

    allowed := toInt64(result[0]) == 1
    remaining := toFloat64(result[1])

    res := &TokenBucketResult{
        Allowed:        allowed,
        RemainingTokens: remaining,
    }

    if !allowed && len(result) >= 3 {
        waitSeconds := toFloat64(result[2])
        res.WaitDuration = time.Duration(waitSeconds * float64(time.Second))
    }

    return res, nil
}

func toInt64(v interface{}) int64 {
    switch val := v.(type) {
    case int64:
        return val
    case float64:
        return int64(val)
    }
    return 0
}

func toFloat64(v interface{}) float64 {
    switch val := v.(type) {
    case float64:
        return val
    case int64:
        return float64(val)
    }
    return 0
}
```

## Section 3: Circuit Breaker Integration

### 3.1 Circuit Breaker for Redis Failures

When Redis is unavailable, falling back to local rate limiting prevents the rate limiter from becoming a single point of failure.

```go
// ratelimit/circuit_breaker.go
package ratelimit

import (
    "context"
    "errors"
    "sync"
    "time"
)

// State represents the circuit breaker state.
type State int

const (
    StateClosed   State = iota // Normal operation
    StateOpen                  // Failing; requests rejected or use fallback
    StateHalfOpen              // Testing if backend has recovered
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "closed"
    case StateOpen:
        return "open"
    case StateHalfOpen:
        return "half-open"
    default:
        return "unknown"
    }
}

// CircuitBreaker wraps a function call with circuit breaking logic.
type CircuitBreaker struct {
    mu sync.RWMutex

    state            State
    failureCount     int
    successCount     int
    lastStateChange  time.Time

    // Configuration
    maxFailures      int
    resetTimeout     time.Duration
    halfOpenRequests int // How many requests to allow in half-open state
}

// ErrCircuitOpen is returned when the circuit is open.
var ErrCircuitOpen = errors.New("circuit breaker is open")

func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        state:            StateClosed,
        maxFailures:      maxFailures,
        resetTimeout:     resetTimeout,
        halfOpenRequests: 3,
        lastStateChange:  time.Now(),
    }
}

// Execute runs fn if the circuit is closed or half-open.
// Falls back to fallbackFn if the circuit is open.
func (cb *CircuitBreaker) Execute(
    ctx context.Context,
    fn func(context.Context) error,
    fallbackFn func(context.Context) error,
) error {
    cb.mu.Lock()
    state := cb.getState()
    cb.mu.Unlock()

    switch state {
    case StateOpen:
        if fallbackFn != nil {
            return fallbackFn(ctx)
        }
        return ErrCircuitOpen

    case StateHalfOpen:
        cb.mu.Lock()
        cb.successCount = 0
        cb.mu.Unlock()

        err := fn(ctx)
        cb.mu.Lock()
        if err != nil {
            cb.transitionTo(StateOpen)
        } else {
            cb.successCount++
            if cb.successCount >= cb.halfOpenRequests {
                cb.transitionTo(StateClosed)
            }
        }
        cb.mu.Unlock()

        if err != nil && fallbackFn != nil {
            return fallbackFn(ctx)
        }
        return err

    default: // StateClosed
        err := fn(ctx)
        if err != nil {
            cb.mu.Lock()
            cb.failureCount++
            if cb.failureCount >= cb.maxFailures {
                cb.transitionTo(StateOpen)
            }
            cb.mu.Unlock()
        } else {
            cb.mu.Lock()
            cb.failureCount = 0
            cb.mu.Unlock()
        }
        return err
    }
}

func (cb *CircuitBreaker) getState() State {
    if cb.state == StateOpen {
        if time.Since(cb.lastStateChange) >= cb.resetTimeout {
            cb.transitionTo(StateHalfOpen)
        }
    }
    return cb.state
}

func (cb *CircuitBreaker) transitionTo(state State) {
    cb.state = state
    cb.lastStateChange = time.Now()
    cb.failureCount = 0
    cb.successCount = 0
}

// CurrentState returns the current circuit breaker state.
func (cb *CircuitBreaker) CurrentState() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.getState()
}
```

### 3.2 Resilient Rate Limiter: Redis with Local Fallback

```go
// ratelimit/resilient.go
package ratelimit

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// ResilientRateLimiter uses Redis for distributed rate limiting with
// automatic fallback to a per-instance local limiter when Redis is unavailable.
type ResilientRateLimiter struct {
    distributed  *RedisSlidingWindow
    localLimiter *TokenBucket
    breaker      *CircuitBreaker

    // Per-key local limiters for fallback
    localLimiters sync.Map // map[string]*TokenBucket

    // Configuration
    localCapacity float64
    localRate     float64

    // Metrics
    redisRequests   prometheus.Counter
    redisErrors     prometheus.Counter
    fallbackRequests prometheus.Counter
    deniedRequests  prometheus.Counter
}

func NewResilientRateLimiter(
    distributed *RedisSlidingWindow,
    localCapacity float64,
    localRate float64,
) *ResilientRateLimiter {
    return &ResilientRateLimiter{
        distributed:  distributed,
        localCapacity: localCapacity,
        localRate:    localRate,
        breaker: NewCircuitBreaker(
            5,              // Open after 5 consecutive failures
            30*time.Second, // Try again after 30s
        ),
        redisRequests: promauto.NewCounter(prometheus.CounterOpts{
            Name: "ratelimiter_redis_requests_total",
            Help: "Total requests made to Redis for rate limiting",
        }),
        redisErrors: promauto.NewCounter(prometheus.CounterOpts{
            Name: "ratelimiter_redis_errors_total",
            Help: "Total Redis errors in rate limiting",
        }),
        fallbackRequests: promauto.NewCounter(prometheus.CounterOpts{
            Name: "ratelimiter_fallback_requests_total",
            Help: "Total requests handled by local fallback limiter",
        }),
        deniedRequests: promauto.NewCounter(prometheus.CounterOpts{
            Name: "ratelimiter_denied_requests_total",
            Help: "Total requests denied by rate limiter",
        }),
    }
}

// Allow checks the rate limit for the given key.
// Returns true if the request is allowed, false if rate limited.
func (r *ResilientRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    var allowed bool

    err := r.breaker.Execute(
        ctx,
        // Primary: Redis sliding window
        func(ctx context.Context) error {
            r.redisRequests.Inc()
            result, err := r.distributed.Allow(ctx, key)
            if err != nil {
                r.redisErrors.Inc()
                return err
            }
            allowed = result.Allowed
            return nil
        },
        // Fallback: Local token bucket per key
        func(ctx context.Context) error {
            r.fallbackRequests.Inc()
            limiter := r.getOrCreateLocalLimiter(key)
            allowed = limiter.Allow(1)
            return nil
        },
    )

    if err == ErrCircuitOpen {
        r.fallbackRequests.Inc()
        limiter := r.getOrCreateLocalLimiter(key)
        allowed = limiter.Allow(1)
        err = nil
    }

    if !allowed {
        r.deniedRequests.Inc()
    }

    return allowed, err
}

func (r *ResilientRateLimiter) getOrCreateLocalLimiter(key string) *TokenBucket {
    if v, ok := r.localLimiters.Load(key); ok {
        return v.(*TokenBucket)
    }

    limiter := NewTokenBucket(r.localCapacity, r.localRate)
    actual, _ := r.localLimiters.LoadOrStore(key, limiter)
    return actual.(*TokenBucket)
}
```

## Section 4: HTTP Middleware Integration

### 4.1 Rate Limiting Middleware

```go
// middleware/ratelimit.go
package middleware

import (
    "encoding/json"
    "fmt"
    "net/http"
    "strconv"
    "time"

    "github.com/exampleorg/ratelimit"
)

type KeyExtractor func(r *http.Request) string

// ExtractAPIKey extracts the rate limit key from the Authorization header.
func ExtractAPIKey(r *http.Request) string {
    apiKey := r.Header.Get("X-API-Key")
    if apiKey != "" {
        return "apikey:" + apiKey
    }
    // Fall back to IP-based limiting
    return "ip:" + realClientIP(r)
}

// ExtractUserID extracts rate limit key from a JWT claim (simplified).
func ExtractUserID(r *http.Request) string {
    // In practice, extract from validated JWT claims stored in context
    if userID, ok := r.Context().Value("user_id").(string); ok {
        return "user:" + userID
    }
    return "anonymous:" + realClientIP(r)
}

type RateLimitMiddleware struct {
    limiter      *ratelimit.ResilientRateLimiter
    keyExtractor KeyExtractor
}

func NewRateLimitMiddleware(
    limiter *ratelimit.ResilientRateLimiter,
    extractor KeyExtractor,
) *RateLimitMiddleware {
    return &RateLimitMiddleware{
        limiter:      limiter,
        keyExtractor: extractor,
    }
}

func (m *RateLimitMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := m.keyExtractor(r)

        allowed, err := m.limiter.Allow(r.Context(), key)
        if err != nil {
            // Log internal error but allow the request through
            // (fail open) to avoid blocking legitimate traffic
            http.Error(w, "Internal rate limit error", http.StatusInternalServerError)
            return
        }

        if !allowed {
            w.Header().Set("Retry-After", "60")
            w.Header().Set("X-RateLimit-Limit", "100")
            w.Header().Set("X-RateLimit-Remaining", "0")
            w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(
                time.Now().Add(time.Minute).Unix(), 10,
            ))
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusTooManyRequests)

            json.NewEncoder(w).Encode(map[string]string{
                "error":   "too_many_requests",
                "message": "Rate limit exceeded. Please retry after 60 seconds.",
            })
            return
        }

        next.ServeHTTP(w, r)
    })
}

func realClientIP(r *http.Request) string {
    // Check standard proxy headers
    if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
        return ip
    }
    if ip := r.Header.Get("X-Real-IP"); ip != "" {
        return ip
    }
    return r.RemoteAddr
}
```

### 4.2 Per-Route Rate Limits

```go
// middleware/per_route_ratelimit.go
package middleware

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/exampleorg/ratelimit"
    "github.com/redis/go-redis/v9"
)

// RouteLimitConfig defines rate limits for a specific route.
type RouteLimitConfig struct {
    WindowSize time.Duration
    Limit      int64
    KeyScope   string // "global", "user", "ip"
}

// RouteRateLimiter manages different rate limit policies per route.
type RouteRateLimiter struct {
    redisClient redis.UniversalClient
    limiters    map[string]*ratelimit.ResilientRateLimiter
    configs     map[string]RouteLimitConfig
}

func NewRouteRateLimiter(
    redisClient redis.UniversalClient,
    configs map[string]RouteLimitConfig,
) (*RouteRateLimiter, error) {
    rrl := &RouteRateLimiter{
        redisClient: redisClient,
        limiters:    make(map[string]*ratelimit.ResilientRateLimiter),
        configs:     configs,
    }

    for route, cfg := range configs {
        sw, err := ratelimit.NewRedisSlidingWindow(redisClient, cfg.WindowSize, cfg.Limit)
        if err != nil {
            return nil, fmt.Errorf("creating limiter for route %s: %w", route, err)
        }

        // Local fallback allows ~10% of the global limit per instance
        localCapacity := float64(cfg.Limit) * 0.1
        localRate := localCapacity / cfg.WindowSize.Seconds()

        rrl.limiters[route] = ratelimit.NewResilientRateLimiter(sw, localCapacity, localRate)
    }

    return rrl, nil
}

func (rrl *RouteRateLimiter) Middleware(pattern string) func(http.Handler) http.Handler {
    cfg, hasCfg := rrl.configs[pattern]
    limiter, hasLimiter := rrl.limiters[pattern]

    if !hasCfg || !hasLimiter {
        return func(next http.Handler) http.Handler { return next }
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := rrl.buildKey(r, pattern, cfg.KeyScope)

            allowed, err := limiter.Allow(r.Context(), key)
            if err != nil || !allowed {
                if !allowed {
                    w.WriteHeader(http.StatusTooManyRequests)
                } else {
                    w.WriteHeader(http.StatusInternalServerError)
                }
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

func (rrl *RouteRateLimiter) buildKey(r *http.Request, route, scope string) string {
    switch scope {
    case "user":
        userID, _ := r.Context().Value("user_id").(string)
        if userID != "" {
            return fmt.Sprintf("route:%s:user:%s", route, userID)
        }
        fallthrough
    case "ip":
        return fmt.Sprintf("route:%s:ip:%s", route, realClientIP(r))
    default: // global
        return fmt.Sprintf("route:%s:global", route)
    }
}
```

## Section 5: Advanced Patterns

### 5.1 Hierarchical Rate Limiting

Many APIs need multiple rate limits simultaneously: per-second burst limit and per-minute sustained limit.

```go
// ratelimit/hierarchical.go
package ratelimit

import (
    "context"
    "fmt"
)

// HierarchicalLimiter applies multiple rate limit layers.
// All layers must allow the request for it to proceed.
// Useful for implementing: 10 req/s burst AND 100 req/min sustained.
type HierarchicalLimiter struct {
    layers []NamedLimiter
}

type NamedLimiter struct {
    Name    string
    Limiter interface {
        Allow(ctx context.Context, key string) (bool, error)
    }
}

func NewHierarchicalLimiter(layers ...NamedLimiter) *HierarchicalLimiter {
    return &HierarchicalLimiter{layers: layers}
}

type HierarchicalResult struct {
    Allowed        bool
    DeniedByLayer  string
}

func (h *HierarchicalLimiter) Allow(ctx context.Context, key string) (*HierarchicalResult, error) {
    for _, layer := range h.layers {
        // Use layer-specific key prefix to keep limits independent
        layerKey := fmt.Sprintf("%s:%s", layer.Name, key)

        allowed, err := layer.Limiter.Allow(ctx, layerKey)
        if err != nil {
            return nil, fmt.Errorf("layer %s: %w", layer.Name, err)
        }

        if !allowed {
            return &HierarchicalResult{
                Allowed:       false,
                DeniedByLayer: layer.Name,
            }, nil
        }
    }

    return &HierarchicalResult{Allowed: true}, nil
}
```

### 5.2 Adaptive Rate Limiting

```go
// ratelimit/adaptive.go
package ratelimit

import (
    "context"
    "math"
    "sync"
    "time"
)

// AdaptiveRateLimiter adjusts its limit based on downstream latency.
// When latency increases, the rate limit decreases to protect the downstream service.
// This implements the additive increase / multiplicative decrease (AIMD) algorithm.
type AdaptiveRateLimiter struct {
    mu sync.Mutex

    currentLimit float64
    minLimit     float64
    maxLimit     float64

    // AIMD parameters
    addStep  float64
    multStep float64

    // Latency tracking
    targetLatency   time.Duration
    latencyEWMA     float64 // Exponential weighted moving average
    ewmaDecay       float64

    base *TokenBucket
}

func NewAdaptiveRateLimiter(
    initialLimit, minLimit, maxLimit float64,
    targetLatency time.Duration,
) *AdaptiveRateLimiter {
    return &AdaptiveRateLimiter{
        currentLimit:  initialLimit,
        minLimit:      minLimit,
        maxLimit:      maxLimit,
        addStep:       initialLimit * 0.05,  // Increase by 5% each success
        multStep:      0.7,                  // Decrease to 70% on overload
        targetLatency: targetLatency,
        ewmaDecay:     0.9,
        base:          NewTokenBucket(initialLimit*2, initialLimit),
    }
}

// Allow checks the adaptive rate limit.
func (a *AdaptiveRateLimiter) Allow(ctx context.Context, key string) bool {
    a.mu.Lock()
    defer a.mu.Unlock()
    return a.base.Allow(1)
}

// RecordLatency updates the adaptive limiter with a new observed latency.
// This should be called for every completed request.
func (a *AdaptiveRateLimiter) RecordLatency(latency time.Duration) {
    a.mu.Lock()
    defer a.mu.Unlock()

    // Update EWMA
    a.latencyEWMA = a.ewmaDecay*a.latencyEWMA + (1-a.ewmaDecay)*float64(latency)

    targetNanos := float64(a.targetLatency)

    if a.latencyEWMA > targetNanos*1.5 {
        // Latency significantly above target: back off
        a.currentLimit = math.Max(a.minLimit, a.currentLimit*a.multStep)
    } else if a.latencyEWMA < targetNanos*0.8 {
        // Latency well below target: increase rate
        a.currentLimit = math.Min(a.maxLimit, a.currentLimit+a.addStep)
    }

    // Update the underlying token bucket
    a.base = NewTokenBucket(a.currentLimit*2, a.currentLimit)
}

// CurrentLimit returns the current effective rate limit.
func (a *AdaptiveRateLimiter) CurrentLimit() float64 {
    a.mu.Lock()
    defer a.mu.Unlock()
    return a.currentLimit
}
```

## Section 6: Testing

### 6.1 Rate Limiter Test Harness

```go
// ratelimit/testing_test.go
package ratelimit_test

import (
    "context"
    "sync"
    "testing"
    "time"
)

func TestTokenBucketAllows(t *testing.T) {
    tb := NewTokenBucket(10, 5) // 10 capacity, 5/s refill

    // Should allow up to capacity
    for i := 0; i < 10; i++ {
        if !tb.Allow(1) {
            t.Fatalf("Expected Allow to return true at iteration %d", i)
        }
    }

    // 11th request should be denied
    if tb.Allow(1) {
        t.Fatal("Expected Allow to return false after capacity exhausted")
    }
}

func TestTokenBucketRefills(t *testing.T) {
    tb := NewTokenBucket(10, 100) // Refill at 100/s
    // Drain all tokens
    for i := 0; i < 10; i++ {
        tb.Allow(1)
    }

    // After 50ms, should have ~5 new tokens
    time.Sleep(55 * time.Millisecond)

    allowed := 0
    for i := 0; i < 10; i++ {
        if tb.Allow(1) {
            allowed++
        }
    }

    if allowed < 4 || allowed > 7 {
        t.Errorf("Expected 4-7 tokens after refill, got %d", allowed)
    }
}

func TestHierarchicalLimiterConcurrency(t *testing.T) {
    ctx := context.Background()
    // Use fake local limiters for testing
    fast := &fakeLimiter{limit: 100, window: time.Second}
    slow := &fakeLimiter{limit: 500, window: time.Minute}

    h := NewHierarchicalLimiter(
        NamedLimiter{Name: "per_second", Limiter: fast},
        NamedLimiter{Name: "per_minute", Limiter: slow},
    )

    var (
        allowed int64
        denied  int64
        wg      sync.WaitGroup
    )

    // Send 200 concurrent requests
    for i := 0; i < 200; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            result, err := h.Allow(ctx, "test-user")
            if err != nil {
                t.Errorf("unexpected error: %v", err)
                return
            }
            if result.Allowed {
                atomic.AddInt64(&allowed, 1)
            } else {
                atomic.AddInt64(&denied, 1)
            }
        }()
    }
    wg.Wait()

    if allowed > 100 {
        t.Errorf("Allowed %d requests, expected at most 100 (per-second limit)", allowed)
    }
    t.Logf("Allowed: %d, Denied: %d", allowed, denied)
}
```

## Summary

Distributed rate limiting in Go requires a layered approach:

1. **Local token buckets** are the performance baseline. Use them as the fallback when distributed coordination is unavailable.

2. **Redis sliding window** with Lua scripts provides accurate distributed counting with O(log n) complexity per request. Pre-load scripts with `EVALSHA` to avoid redundant transfers.

3. **Redis token bucket** via Lua supports burst tolerance at the distributed level. Store `tokens` and `last_time` in Redis HASH fields for atomic updates.

4. **Circuit breakers** are mandatory for production. A Redis outage must not block all requests. The fail-open pattern (allow requests through) is safer than fail-closed for most APIs; choose based on business risk.

5. **Hierarchical limiters** handle multi-tier rate policies cleanly. Implement the check as an ordered list of `Allow()` calls; the first denial short-circuits the chain.

6. **Adaptive limiting** based on downstream latency EWMA implements AIMD and provides automatic protection against overload without manual tuning.

The most important operational practice is instrumentation: counter every Redis call, every fallback invocation, and every denied request. Unlabeled denial counts are operationally useless; tag by key type (user, IP, API key) to identify abuse patterns versus algorithmic over-restriction.
