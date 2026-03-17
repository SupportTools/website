---
title: "Go Rate Limiting: Token Bucket, Sliding Window, and Distributed Rate Limiting with Redis"
date: 2029-12-28T00:00:00-05:00
draft: false
tags: ["Go", "Rate Limiting", "Redis", "Token Bucket", "Sliding Window", "Distributed Systems", "API", "Performance"]
categories:
- Go
- Distributed Systems
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to golang.org/x/time/rate token bucket, sliding window algorithms, Redis-based distributed rate limiting, and per-user/per-tenant limits for enterprise Go services."
more_link: "yes"
url: "/go-rate-limiting-token-bucket-sliding-window-redis-distributed/"
---

Rate limiting protects services from overload, enforces fair usage policies, and prevents individual clients from monopolizing shared resources. Go's standard library and ecosystem provide everything needed to implement rate limiting from simple single-process token buckets through to distributed, per-tenant quotas backed by Redis. This guide covers the full spectrum.

<!--more-->

## Section 1: Token Bucket with golang.org/x/time/rate

The token bucket algorithm allows bursting up to a configured capacity while enforcing a sustained rate. The bucket fills at a fixed rate; each request consumes one token. When the bucket is empty, requests are either rejected or delayed until a token is available.

### Basic Usage

```bash
go get golang.org/x/time/rate@v0.9.0
```

```go
package main

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/time/rate"
)

func main() {
    // Allow 10 events per second with a burst of 30.
    limiter := rate.NewLimiter(rate.Limit(10), 30)

    for i := 0; i < 50; i++ {
        // Wait blocks until a token is available.
        if err := limiter.Wait(context.Background()); err != nil {
            fmt.Printf("request %d: error: %v\n", i, err)
            continue
        }
        fmt.Printf("request %d: allowed at %s\n", i, time.Now().Format("15:04:05.000"))
    }
}
```

### Non-Blocking Allow

```go
package middleware

import (
    "net/http"
    "golang.org/x/time/rate"
)

// RateLimitMiddleware enforces a global rate limit on all requests.
func RateLimitMiddleware(rps float64, burst int, next http.Handler) http.Handler {
    limiter := rate.NewLimiter(rate.Limit(rps), burst)
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !limiter.Allow() {
            http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            w.Header().Set("Retry-After", "1")
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

### Reserve for Delayed Processing

```go
package worker

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/time/rate"
)

type Job struct {
    ID   int
    Data string
}

// ProcessWithBackpressure processes jobs respecting the rate limit.
func ProcessWithBackpressure(ctx context.Context, jobs <-chan Job, rps float64) error {
    limiter := rate.NewLimiter(rate.Limit(rps), int(rps))

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case job, ok := <-jobs:
            if !ok {
                return nil
            }
            // Reserve returns immediately with a delay duration.
            r := limiter.Reserve()
            if !r.OK() {
                return fmt.Errorf("rate limit cannot be satisfied")
            }
            delay := r.Delay()
            if delay > 0 {
                select {
                case <-time.After(delay):
                case <-ctx.Done():
                    r.Cancel()
                    return ctx.Err()
                }
            }
            process(job)
        }
    }
}

func process(j Job) {
    fmt.Printf("Processing job %d\n", j.ID)
}
```

## Section 2: Per-Client Rate Limiting with a Limiter Map

Global rate limits protect servers from aggregate overload but allow single clients to consume all capacity. Per-client limiters enforce individual quotas.

```go
package ratelimit

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// ClientLimiter manages per-client rate limiters with TTL-based expiry.
type ClientLimiter struct {
    mu       sync.Mutex
    limiters map[string]*entry
    rate     rate.Limit
    burst    int
    ttl      time.Duration
}

type entry struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

// NewClientLimiter creates a manager that cleans up expired limiters every minute.
func NewClientLimiter(rps float64, burst int, ttl time.Duration) *ClientLimiter {
    cl := &ClientLimiter{
        limiters: make(map[string]*entry),
        rate:     rate.Limit(rps),
        burst:    burst,
        ttl:      ttl,
    }
    go cl.cleanupLoop()
    return cl
}

func (cl *ClientLimiter) getLimiter(key string) *rate.Limiter {
    cl.mu.Lock()
    defer cl.mu.Unlock()

    e, ok := cl.limiters[key]
    if !ok {
        e = &entry{limiter: rate.NewLimiter(cl.rate, cl.burst)}
        cl.limiters[key] = e
    }
    e.lastSeen = time.Now()
    return e.limiter
}

func (cl *ClientLimiter) cleanupLoop() {
    ticker := time.NewTicker(time.Minute)
    for range ticker.C {
        cl.mu.Lock()
        cutoff := time.Now().Add(-cl.ttl)
        for key, e := range cl.limiters {
            if e.lastSeen.Before(cutoff) {
                delete(cl.limiters, key)
            }
        }
        cl.mu.Unlock()
    }
}

// Middleware returns an HTTP middleware that rate limits by client IP.
func (cl *ClientLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Use X-Forwarded-For if behind a load balancer.
        clientIP := r.RemoteAddr
        if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
            clientIP = xff
        }

        limiter := cl.getLimiter(clientIP)
        if !limiter.Allow() {
            http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            w.Header().Set("Retry-After", "1")
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

## Section 3: Sliding Window Rate Limiting

The token bucket algorithm uses a fixed window that can allow double the rate at window boundaries. A sliding window tracks actual request timestamps within the current window, providing smoother enforcement.

### In-Process Sliding Window

```go
package slidingwindow

import (
    "sync"
    "time"
)

// SlidingWindow implements a sliding window rate limiter.
type SlidingWindow struct {
    mu         sync.Mutex
    timestamps []time.Time
    limit      int
    window     time.Duration
}

// NewSlidingWindow creates a sliding window allowing `limit` requests per `window`.
func NewSlidingWindow(limit int, window time.Duration) *SlidingWindow {
    return &SlidingWindow{
        timestamps: make([]time.Time, 0, limit),
        limit:      limit,
        window:     window,
    }
}

// Allow returns true if the request is within the rate limit.
func (sw *SlidingWindow) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-sw.window)

    // Evict timestamps outside the window.
    valid := sw.timestamps[:0]
    for _, t := range sw.timestamps {
        if t.After(cutoff) {
            valid = append(valid, t)
        }
    }
    sw.timestamps = valid

    if len(sw.timestamps) >= sw.limit {
        return false
    }

    sw.timestamps = append(sw.timestamps, now)
    return true
}

// RemainingTokens returns how many requests are allowed in the current window.
func (sw *SlidingWindow) RemainingTokens() int {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    cutoff := time.Now().Add(-sw.window)
    count := 0
    for _, t := range sw.timestamps {
        if t.After(cutoff) {
            count++
        }
    }
    return sw.limit - count
}
```

### Sliding Window Counter (Memory-Efficient)

For high-throughput systems, store per-second counters rather than individual timestamps:

```go
package slidingcounter

import (
    "sync"
    "time"
)

// WindowCounter uses fixed-size second-level buckets for efficient sliding windows.
type WindowCounter struct {
    mu      sync.Mutex
    buckets []int64
    times   []int64 // Unix second for each bucket
    limit   int
    window  int // window size in seconds
    cursor  int // current bucket index
}

// NewWindowCounter creates a counter with `windowSeconds` buckets.
func NewWindowCounter(limit, windowSeconds int) *WindowCounter {
    return &WindowCounter{
        buckets: make([]int64, windowSeconds),
        times:   make([]int64, windowSeconds),
        limit:   limit,
        window:  windowSeconds,
    }
}

// Allow returns true if the request falls within the limit.
func (wc *WindowCounter) Allow() bool {
    wc.mu.Lock()
    defer wc.mu.Unlock()

    now := time.Now().Unix()

    // Find the bucket for the current second.
    idx := int(now % int64(wc.window))

    // Reset stale bucket.
    if wc.times[idx] != now {
        wc.buckets[idx] = 0
        wc.times[idx] = now
    }

    // Sum all valid buckets within the window.
    var total int64
    for i := 0; i < wc.window; i++ {
        if now-wc.times[i] < int64(wc.window) {
            total += wc.buckets[i]
        }
    }

    if total >= int64(wc.limit) {
        return false
    }

    wc.buckets[idx]++
    return true
}
```

## Section 4: Redis-Based Distributed Rate Limiting

When multiple service instances share a rate limit, each instance must coordinate through a shared store. Redis provides atomic operations and sub-millisecond latency for distributed rate limiting.

```bash
go get github.com/redis/go-redis/v9@v9.7.0
```

### Token Bucket with Redis Lua Script

Lua scripts execute atomically in Redis, preventing race conditions:

```go
package redisratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// tokenBucketScript implements a token bucket in Redis.
// Keys: [1] = bucket key
// Args: [1] = capacity, [2] = rate (tokens/sec), [3] = now (unix ns), [4] = requested
var tokenBucketScript = redis.NewScript(`
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local rate       = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local requested  = tonumber(ARGV[4])

local bucket = redis.call("HMGET", key, "tokens", "last_refill")
local tokens     = tonumber(bucket[1]) or capacity
local last_refill = tonumber(bucket[2]) or now

-- Refill tokens based on elapsed time.
local elapsed = math.max(0, now - last_refill)
local refill  = elapsed * rate / 1e9  -- rate is tokens/ns
tokens = math.min(capacity, tokens + refill)

local allowed = 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
end

redis.call("HMSET", key, "tokens", tokens, "last_refill", now)
redis.call("PEXPIRE", key, math.ceil(capacity / rate * 1000) + 1000)

return {allowed, math.floor(tokens)}
`)

// RedisTokenBucket is a distributed token bucket rate limiter.
type RedisTokenBucket struct {
    client   *redis.Client
    capacity float64
    rate     float64 // tokens per second
}

// NewRedisTokenBucket creates a distributed token bucket.
func NewRedisTokenBucket(client *redis.Client, capacity, ratePerSec float64) *RedisTokenBucket {
    return &RedisTokenBucket{
        client:   client,
        capacity: capacity,
        rate:     ratePerSec,
    }
}

// Allow checks if a request for `key` should be allowed.
func (r *RedisTokenBucket) Allow(ctx context.Context, key string) (bool, int, error) {
    now := time.Now().UnixNano()
    results, err := tokenBucketScript.Run(ctx, r.client,
        []string{fmt.Sprintf("ratelimit:tb:%s", key)},
        r.capacity, r.rate, now, 1,
    ).Int64Slice()
    if err != nil {
        return false, 0, fmt.Errorf("redis rate limit: %w", err)
    }
    return results[0] == 1, int(results[1]), nil
}
```

### Sliding Window with Redis ZSET

Redis sorted sets provide an efficient timestamp log for sliding window limits:

```go
package redisratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisSlidingWindow implements a per-key sliding window using Redis ZSETs.
type RedisSlidingWindow struct {
    client *redis.Client
    limit  int
    window time.Duration
}

// NewRedisSlidingWindow creates a sliding window backed by Redis.
func NewRedisSlidingWindow(client *redis.Client, limit int, window time.Duration) *RedisSlidingWindow {
    return &RedisSlidingWindow{client: client, limit: limit, window: window}
}

// Allow returns true if the request for `key` is within the rate limit.
func (r *RedisSlidingWindow) Allow(ctx context.Context, key string) (bool, error) {
    now := time.Now()
    windowStart := now.Add(-r.window)

    redisKey := fmt.Sprintf("ratelimit:sw:%s", key)
    member := fmt.Sprintf("%d", now.UnixNano())

    pipe := r.client.Pipeline()

    // Remove timestamps outside the window.
    pipe.ZRemRangeByScore(ctx, redisKey, "0",
        fmt.Sprintf("%d", windowStart.UnixNano()))

    // Count remaining requests.
    countCmd := pipe.ZCard(ctx, redisKey)

    // Add current request.
    pipe.ZAdd(ctx, redisKey, redis.Z{Score: float64(now.UnixNano()), Member: member})

    // Set expiry to window duration.
    pipe.Expire(ctx, redisKey, r.window+time.Second)

    if _, err := pipe.Exec(ctx); err != nil {
        return false, fmt.Errorf("redis pipeline: %w", err)
    }

    count := countCmd.Val()
    return count < int64(r.limit), nil
}

// Status returns the current count and remaining quota for a key.
func (r *RedisSlidingWindow) Status(ctx context.Context, key string) (current, remaining int, err error) {
    now := time.Now()
    windowStart := now.Add(-r.window)
    redisKey := fmt.Sprintf("ratelimit:sw:%s", key)

    pipe := r.client.Pipeline()
    pipe.ZRemRangeByScore(ctx, redisKey,
        "0", fmt.Sprintf("%d", windowStart.UnixNano()))
    countCmd := pipe.ZCard(ctx, redisKey)

    if _, err = pipe.Exec(ctx); err != nil {
        return 0, 0, err
    }

    current = int(countCmd.Val())
    remaining = r.limit - current
    if remaining < 0 {
        remaining = 0
    }
    return current, remaining, nil
}
```

### Fixed Window Counter with Redis INCR

The simplest Redis rate limiter uses atomic INCR with key expiry. It has the double-at-boundary problem but is extremely fast:

```go
package redisratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisFixedWindow is the simplest Redis rate limiter — one INCR per request.
type RedisFixedWindow struct {
    client *redis.Client
    limit  int64
    window time.Duration
}

func NewRedisFixedWindow(client *redis.Client, limit int64, window time.Duration) *RedisFixedWindow {
    return &RedisFixedWindow{client: client, limit: limit, window: window}
}

func (r *RedisFixedWindow) Allow(ctx context.Context, key string) (bool, error) {
    // Bucket key includes the current window time bucket.
    bucket := time.Now().Truncate(r.window).Unix()
    redisKey := fmt.Sprintf("ratelimit:fw:%s:%d", key, bucket)

    count, err := r.client.Incr(ctx, redisKey).Result()
    if err != nil {
        return false, fmt.Errorf("incr: %w", err)
    }
    if count == 1 {
        // Set expiry on the first increment.
        r.client.Expire(ctx, redisKey, r.window*2)
    }
    return count <= r.limit, nil
}
```

## Section 5: Per-Tenant and Per-User Rate Limiting

Enterprise APIs require different limits for different tenants or subscription tiers.

```go
package tenantlimit

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
)

// TenantConfig defines rate limit parameters for a subscription tier.
type TenantConfig struct {
    RequestsPerSecond float64
    BurstCapacity     float64
    Window            time.Duration
}

// TierConfigs maps subscription tier to rate limit parameters.
var TierConfigs = map[string]TenantConfig{
    "free":       {RequestsPerSecond: 1, BurstCapacity: 5, Window: time.Second},
    "basic":      {RequestsPerSecond: 10, BurstCapacity: 50, Window: time.Second},
    "pro":        {RequestsPerSecond: 100, BurstCapacity: 500, Window: time.Second},
    "enterprise": {RequestsPerSecond: 1000, BurstCapacity: 5000, Window: time.Second},
}

// TenantRateLimiter enforces per-tenant limits using Redis token bucket.
type TenantRateLimiter struct {
    redis *redis.Client
}

func NewTenantRateLimiter(r *redis.Client) *TenantRateLimiter {
    return &TenantRateLimiter{redis: r}
}

// CheckLimit validates a request for a given tenant and tier.
func (t *TenantRateLimiter) CheckLimit(ctx context.Context, tenantID, tier string) (bool, error) {
    cfg, ok := TierConfigs[tier]
    if !ok {
        cfg = TierConfigs["free"]
    }
    limiter := NewRedisTokenBucket(t.redis, cfg.BurstCapacity, cfg.RequestsPerSecond)
    allowed, remaining, err := limiter.Allow(ctx, tenantID)
    if err != nil {
        // Fail open on Redis errors to avoid impacting availability.
        return true, fmt.Errorf("rate limit check failed (fail open): %w", err)
    }
    _ = remaining
    return allowed, nil
}

// Middleware extracts tenant information from JWT claims and applies limits.
func (t *TenantRateLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // In production, extract these from JWT claims or API key lookup.
        tenantID := r.Header.Get("X-Tenant-ID")
        tier := r.Header.Get("X-Subscription-Tier")
        if tenantID == "" {
            tenantID = r.RemoteAddr
            tier = "free"
        }
        if tier == "" {
            tier = "free"
        }

        allowed, err := t.CheckLimit(r.Context(), tenantID, tier)
        if err != nil {
            // Log but allow — Redis errors should not block legitimate traffic.
        }
        if !allowed {
            w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%v", TierConfigs[tier].RequestsPerSecond))
            w.Header().Set("X-RateLimit-Remaining", "0")
            w.Header().Set("Retry-After", "1")
            http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

## Section 6: HTTP Headers and Standards Compliance

Rate limiting responses should include standard headers so clients can implement backoff:

```go
package headers

import (
    "fmt"
    "net/http"
    "strconv"
    "time"
)

// SetRateLimitHeaders adds RFC 6585 and draft-ietf-httpapi-ratelimit-headers.
func SetRateLimitHeaders(w http.ResponseWriter, limit, remaining, reset int, policy string) {
    w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
    w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
    w.Header().Set("X-RateLimit-Reset", strconv.Itoa(reset)) // Unix timestamp
    if policy != "" {
        w.Header().Set("X-RateLimit-Policy", policy)
    }
    // RateLimit header (IETF draft standard).
    w.Header().Set("RateLimit",
        fmt.Sprintf("limit=%d, remaining=%d, reset=%d", limit, remaining, reset))
}

// SetRetryAfter sets the Retry-After header with the number of seconds to wait.
func SetRetryAfter(w http.ResponseWriter, retryAfter time.Duration) {
    w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
}
```

## Section 7: Testing Rate Limiters

```go
package ratelimit_test

import (
    "context"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
    "github.com/example/myapp/ratelimit"
)

func TestRedisSlidingWindow_Allow(t *testing.T) {
    // Use miniredis for unit tests — no real Redis needed.
    mr := miniredis.RunT(t)
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

    limiter := ratelimit.NewRedisSlidingWindow(client, 5, time.Second)
    ctx := context.Background()

    // First 5 requests should succeed.
    for i := 0; i < 5; i++ {
        allowed, err := limiter.Allow(ctx, "user-123")
        if err != nil {
            t.Fatalf("request %d: unexpected error: %v", i, err)
        }
        if !allowed {
            t.Fatalf("request %d: expected allowed, got denied", i)
        }
    }

    // 6th request should be denied.
    allowed, err := limiter.Allow(ctx, "user-123")
    if err != nil {
        t.Fatalf("request 6: unexpected error: %v", err)
    }
    if allowed {
        t.Fatal("request 6: expected denied, got allowed")
    }

    // After the window, requests should be allowed again.
    mr.FastForward(time.Second + time.Millisecond)
    allowed, err = limiter.Allow(ctx, "user-123")
    if err != nil {
        t.Fatalf("after window: unexpected error: %v", err)
    }
    if !allowed {
        t.Fatal("after window: expected allowed, got denied")
    }
}

func TestTokenBucket_BurstBehavior(t *testing.T) {
    mr := miniredis.RunT(t)
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

    // 2 tokens/sec, burst of 10.
    limiter := ratelimit.NewRedisTokenBucket(client, 10, 2)
    ctx := context.Background()

    // Should allow 10 burst requests immediately.
    for i := 0; i < 10; i++ {
        allowed, _, err := limiter.Allow(ctx, "burst-test")
        if err != nil {
            t.Fatalf("burst request %d error: %v", i, err)
        }
        if !allowed {
            t.Fatalf("burst request %d: expected allowed", i)
        }
    }

    // 11th should be denied (bucket empty).
    allowed, _, _ := limiter.Allow(ctx, "burst-test")
    if allowed {
        t.Fatal("expected 11th request to be denied")
    }
}
```

## Section 8: Observability for Rate Limiters

Track rate limiting decisions with Prometheus metrics to tune limits based on real traffic patterns:

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    RateLimitDecisions = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "rate_limit_decisions_total",
        Help: "Total rate limit decisions by key, tier, and outcome.",
    }, []string{"key_type", "tier", "outcome"})

    RateLimitRemaining = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "rate_limit_tokens_remaining",
        Help: "Remaining tokens/requests in the current window.",
    }, []string{"key_type", "tier"})

    RateLimitRedisLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "rate_limit_redis_duration_seconds",
        Help:    "Redis round-trip latency for rate limit operations.",
        Buckets: []float64{0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05},
    }, []string{"operation"})
)
```

Rate limiting is one of those components that appears simple until a distributed environment reveals its edge cases. Start with `golang.org/x/time/rate` for single-instance services, move to Redis sliding windows for distributed enforcement, and build per-tenant configuration into your API design from the start. The cost of retrofitting rate limiting into an existing high-traffic API is always higher than building it in from day one.
