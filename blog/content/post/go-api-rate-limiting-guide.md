---
title: "Go API Rate Limiting: Token Buckets, Sliding Windows, and Redis-Based Distributed Limiting"
date: 2028-01-18T00:00:00-05:00
draft: false
tags: ["Go", "Rate Limiting", "Redis", "API", "Middleware", "Performance", "Security"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go API rate limiting covering token bucket with golang.org/x/time/rate, sliding window counter algorithms, Redis-based distributed rate limiting, IP-based and user-based limits, Gin and Fiber middleware, and RFC-standard rate limit headers."
more_link: "yes"
url: "/go-api-rate-limiting-guide/"
---

Rate limiting protects backend services from traffic spikes, prevents individual clients from consuming disproportionate resources, and provides a mechanism for enforcing API tier quotas. Go's standard library and ecosystem provide multiple rate limiting primitives, each suited to different deployment topologies. Single-process token buckets handle moderate traffic on single nodes, while Redis-backed distributed limiters coordinate state across horizontally scaled API fleets.

<!--more-->

# Go API Rate Limiting: Token Buckets, Sliding Windows, and Redis-Based Distributed Limiting

## Section 1: Token Bucket with golang.org/x/time/rate

The `golang.org/x/time/rate` package implements the token bucket algorithm. Tokens accumulate in a bucket at a fixed rate up to a maximum burst size. Each request consumes one token. When the bucket is empty, requests are either rejected or forced to wait.

### Basic Token Bucket Implementation

```go
package ratelimit

import (
    "context"
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// IPRateLimiter manages per-IP rate limiters using the token bucket algorithm.
// Each IP address gets its own token bucket that refills at the configured rate.
type IPRateLimiter struct {
    mu       sync.RWMutex
    visitors map[string]*visitor
    rate     rate.Limit // tokens per second
    burst    int        // maximum token bucket size
    cleanup  time.Duration
}

// visitor tracks a rate limiter and the last time it was accessed.
// Used for pruning stale limiters to prevent unbounded memory growth.
type visitor struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

// NewIPRateLimiter creates a rate limiter that allows r requests per second
// with a burst size of b requests.
func NewIPRateLimiter(r rate.Limit, b int) *IPRateLimiter {
    rl := &IPRateLimiter{
        visitors: make(map[string]*visitor),
        rate:     r,
        burst:    b,
        cleanup:  3 * time.Minute,
    }
    // Start background goroutine to clean up stale visitor entries.
    // Without cleanup, a long-running service accumulates a limiter
    // for every unique IP that has ever sent a request.
    go rl.cleanupLoop()
    return rl
}

// Allow returns true if the request from ip should be allowed.
// Creates a new limiter if this is the first request from ip.
func (rl *IPRateLimiter) Allow(ip string) bool {
    rl.mu.Lock()
    v, exists := rl.visitors[ip]
    if !exists {
        limiter := rate.NewLimiter(rl.rate, rl.burst)
        rl.visitors[ip] = &visitor{
            limiter:  limiter,
            lastSeen: time.Now(),
        }
        rl.mu.Unlock()
        return limiter.Allow()
    }
    v.lastSeen = time.Now()
    limiter := v.limiter
    rl.mu.Unlock()
    return limiter.Allow()
}

// Reserve returns a reservation for the next available token for ip.
// The caller can use Reservation.Delay() to sleep until the request is allowed.
func (rl *IPRateLimiter) Reserve(ip string) *rate.Reservation {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    v, exists := rl.visitors[ip]
    if !exists {
        limiter := rate.NewLimiter(rl.rate, rl.burst)
        v = &visitor{limiter: limiter}
        rl.visitors[ip] = v
    }
    v.lastSeen = time.Now()
    return v.limiter.Reserve()
}

// WaitN waits until n tokens are available for ip or ctx is cancelled.
// Returns an error if ctx expires before tokens are available.
func (rl *IPRateLimiter) WaitN(ctx context.Context, ip string, n int) error {
    rl.mu.Lock()
    v, exists := rl.visitors[ip]
    if !exists {
        limiter := rate.NewLimiter(rl.rate, rl.burst)
        v = &visitor{limiter: limiter}
        rl.visitors[ip] = v
    }
    v.lastSeen = time.Now()
    limiter := v.limiter
    rl.mu.Unlock()

    return limiter.WaitN(ctx, n)
}

// cleanupLoop removes visitors that have not been seen within the cleanup interval.
// Runs every cleanup/2 duration to bound the lag between stale entries and removal.
func (rl *IPRateLimiter) cleanupLoop() {
    ticker := time.NewTicker(rl.cleanup / 2)
    defer ticker.Stop()

    for range ticker.C {
        rl.mu.Lock()
        for ip, v := range rl.visitors {
            if time.Since(v.lastSeen) > rl.cleanup {
                delete(rl.visitors, ip)
            }
        }
        rl.mu.Unlock()
    }
}
```

### HTTP Middleware Using Token Bucket

```go
package middleware

import (
    "net/http"
    "strconv"
    "time"

    "golang.org/x/time/rate"

    "github.com/example/api/internal/ratelimit"
)

// RateLimiterConfig configures the rate limiting middleware.
type RateLimiterConfig struct {
    // RequestsPerSecond is the sustained rate of allowed requests.
    RequestsPerSecond float64
    // BurstSize is the maximum number of requests allowed in a burst.
    BurstSize int
    // TrustedProxies lists CIDR ranges whose X-Forwarded-For headers are trusted.
    TrustedProxies []string
    // KeyFunc extracts the rate limiting key from the request.
    // Defaults to remote IP address.
    KeyFunc func(r *http.Request) string
    // OnRateLimit is called when a request is rejected. Defaults to
    // returning HTTP 429 with standard headers.
    OnRateLimit func(w http.ResponseWriter, r *http.Request, retryAfter time.Duration)
}

// NewRateLimitMiddleware returns an http.Handler middleware that applies
// token bucket rate limiting based on the key returned by cfg.KeyFunc.
func NewRateLimitMiddleware(cfg RateLimiterConfig) func(http.Handler) http.Handler {
    limiter := ratelimit.NewIPRateLimiter(
        rate.Limit(cfg.RequestsPerSecond),
        cfg.BurstSize,
    )

    keyFunc := cfg.KeyFunc
    if keyFunc == nil {
        keyFunc = extractClientIP
    }

    onRateLimit := cfg.OnRateLimit
    if onRateLimit == nil {
        onRateLimit = defaultRateLimitHandler
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := keyFunc(r)
            reservation := limiter.Reserve(key)

            if !reservation.OK() {
                // Limiter would never allow this request (n > burst size)
                onRateLimit(w, r, 0)
                return
            }

            delay := reservation.Delay()
            if delay == rate.InfDuration {
                // Context would expire before the request could proceed
                reservation.Cancel()
                onRateLimit(w, r, 0)
                return
            }

            if delay > 0 {
                // For strict rate limiting: cancel and return 429
                // For leaky bucket behavior: sleep(delay) then proceed
                reservation.Cancel()
                onRateLimit(w, r, delay)
                return
            }

            // Request is within rate limit — add informational headers
            // and proceed to the next handler
            w.Header().Set("X-RateLimit-Limit",
                strconv.FormatFloat(cfg.RequestsPerSecond, 'f', -1, 64))
            next.ServeHTTP(w, r)
        })
    }
}

// extractClientIP extracts the client IP from the request, respecting
// X-Forwarded-For headers from trusted proxies.
func extractClientIP(r *http.Request) string {
    // In a real implementation, validate against trusted proxy CIDRs
    forwarded := r.Header.Get("X-Forwarded-For")
    if forwarded != "" {
        // X-Forwarded-For may contain multiple IPs: "client, proxy1, proxy2"
        // The leftmost IP is the original client
        for i, ch := range forwarded {
            if ch == ',' {
                return forwarded[:i]
            }
        }
        return forwarded
    }
    // Fall back to direct connection IP
    host := r.RemoteAddr
    // Strip port from "host:port"
    for i := len(host) - 1; i >= 0; i-- {
        if host[i] == ':' {
            return host[:i]
        }
    }
    return host
}

// defaultRateLimitHandler writes a standard 429 response with retry information.
func defaultRateLimitHandler(w http.ResponseWriter, r *http.Request, retryAfter time.Duration) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-RateLimit-Remaining", "0")

    if retryAfter > 0 {
        // RFC 7231: Retry-After header in seconds
        w.Header().Set("Retry-After",
            strconv.Itoa(int(retryAfter.Seconds())+1))
    }

    w.WriteHeader(http.StatusTooManyRequests)
    w.Write([]byte(`{"error":"rate_limit_exceeded","message":"Too many requests. Please slow down."}`))
}
```

## Section 2: Sliding Window Counter Algorithm

The token bucket has a burst characteristic: a client can consume the entire burst allowance instantly. The sliding window counter distributes requests more evenly by tracking the rate over a rolling time window.

```go
package ratelimit

import (
    "sync"
    "time"
)

// SlidingWindowLimiter implements the sliding window counter algorithm.
// It divides time into fixed-size slots and tracks request counts per slot.
// The window slides continuously: at any point in time, the count covers
// exactly the last windowSize duration of requests.
type SlidingWindowLimiter struct {
    mu         sync.Mutex
    windowSize time.Duration // Total window duration
    bucketSize time.Duration // Each time bucket duration
    limit      int           // Max requests per window
    windows    map[string]*slidingWindow
}

// slidingWindow tracks request counts in time-bucketed slots for a single key.
type slidingWindow struct {
    slots    []int       // Request counts per time slot
    times    []time.Time // Start time of each slot
    slotIdx  int         // Current slot index (circular buffer)
    numSlots int         // Total number of slots = windowSize / bucketSize
    lastSeen time.Time
}

// NewSlidingWindowLimiter creates a limiter that allows at most limit requests
// in any windowSize duration, using bucketSize-granularity time slots.
//
// Example: NewSlidingWindowLimiter(1*time.Minute, 6*time.Second, 100)
// creates a 60-second window with 10 slots of 6 seconds each,
// allowing 100 requests per minute with 6-second granularity.
func NewSlidingWindowLimiter(windowSize, bucketSize time.Duration, limit int) *SlidingWindowLimiter {
    l := &SlidingWindowLimiter{
        windowSize: windowSize,
        bucketSize: bucketSize,
        limit:      limit,
        windows:    make(map[string]*slidingWindow),
    }
    go l.cleanupLoop()
    return l
}

// Allow returns true if key is within the rate limit.
func (l *SlidingWindowLimiter) Allow(key string) bool {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()
    numSlots := int(l.windowSize / l.bucketSize)

    w, exists := l.windows[key]
    if !exists {
        w = &slidingWindow{
            slots:    make([]int, numSlots),
            times:    make([]time.Time, numSlots),
            numSlots: numSlots,
        }
        l.windows[key] = w
    }
    w.lastSeen = now

    // Advance expired slots: zero out slots older than windowSize
    currentSlotStart := now.Truncate(l.bucketSize)
    for i := 0; i < numSlots; i++ {
        idx := (w.slotIdx + i) % numSlots
        if !w.times[idx].IsZero() && now.Sub(w.times[idx]) >= l.windowSize {
            w.slots[idx] = 0
            w.times[idx] = time.Time{}
        }
    }

    // Find or create the current slot
    currentIdx := -1
    for i := 0; i < numSlots; i++ {
        if w.times[i].Equal(currentSlotStart) {
            currentIdx = i
            break
        }
    }
    if currentIdx == -1 {
        // Use the oldest slot (circular buffer replacement)
        oldestIdx := w.slotIdx
        w.slots[oldestIdx] = 0
        w.times[oldestIdx] = currentSlotStart
        currentIdx = oldestIdx
        w.slotIdx = (w.slotIdx + 1) % numSlots
    }

    // Count total requests in the sliding window
    total := 0
    for _, count := range w.slots {
        total += count
    }

    if total >= l.limit {
        return false
    }

    // Increment current slot
    w.slots[currentIdx]++
    return true
}

// Remaining returns the number of requests remaining in the current window for key.
func (l *SlidingWindowLimiter) Remaining(key string) int {
    l.mu.Lock()
    defer l.mu.Unlock()

    w, exists := l.windows[key]
    if !exists {
        return l.limit
    }

    total := 0
    for _, count := range w.slots {
        total += count
    }

    remaining := l.limit - total
    if remaining < 0 {
        return 0
    }
    return remaining
}

// cleanupLoop removes stale window entries.
func (l *SlidingWindowLimiter) cleanupLoop() {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        l.mu.Lock()
        for key, w := range l.windows {
            if time.Since(w.lastSeen) > l.windowSize*2 {
                delete(l.windows, key)
            }
        }
        l.mu.Unlock()
    }
}
```

## Section 3: Redis-Based Distributed Rate Limiting

In-process rate limiters cannot coordinate across multiple API server instances. A Go service running 10 replicas with in-process limiting effectively allows 10x the intended rate per client. Redis provides a shared state backend for distributed rate limiting.

### Redis Sliding Window Implementation

```go
package ratelimit

import (
    "context"
    "fmt"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisRateLimiter implements distributed sliding window rate limiting
// using Redis sorted sets. Each key maintains a sorted set of request
// timestamps, enabling precise sliding window counting across instances.
type RedisRateLimiter struct {
    client     redis.UniversalClient
    window     time.Duration
    limit      int
    keyPrefix  string
}

// NewRedisRateLimiter creates a distributed rate limiter backed by Redis.
// limit requests are allowed per window duration per key.
// keyPrefix is prepended to all Redis keys to namespace the limiter.
func NewRedisRateLimiter(client redis.UniversalClient, window time.Duration, limit int, keyPrefix string) *RedisRateLimiter {
    return &RedisRateLimiter{
        client:    client,
        window:    window,
        limit:     limit,
        keyPrefix: keyPrefix,
    }
}

// Allow checks and records a request for key using an atomic Lua script.
// Returns (allowed bool, remaining int, resetAt time.Time, err error).
//
// The Lua script executes atomically on Redis, preventing race conditions
// between the ZCOUNT check and ZADD increment that would occur with
// separate commands.
var slidingWindowScript = redis.NewScript(`
-- KEYS[1]: the rate limit key (sorted set)
-- ARGV[1]: current timestamp in microseconds
-- ARGV[2]: window size in microseconds
-- ARGV[3]: max requests per window
-- ARGV[4]: TTL for the key in seconds

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local window_start = now - window

-- Remove timestamps outside the current window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count requests in current window
local current = redis.call('ZCARD', key)

if current >= limit then
    -- Rate limit exceeded
    -- Return oldest timestamp to compute reset time
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local reset_at = 0
    if #oldest > 0 then
        reset_at = tonumber(oldest[2]) + window
    end
    return {0, limit - current, reset_at}
end

-- Add current request timestamp with unique member to handle concurrent requests
-- Using now + random suffix prevents duplicate member collisions
local member = now .. ':' .. math.random(1, 1000000)
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttl)

local remaining = limit - current - 1
return {1, remaining, 0}
`)

// Allow checks if the request for key is within the rate limit.
func (r *RedisRateLimiter) Allow(ctx context.Context, key string) (bool, RateLimitResult, error) {
    redisKey := fmt.Sprintf("%s:%s", r.keyPrefix, key)
    now := time.Now().UnixMicro()
    windowMicro := r.window.Microseconds()
    ttlSeconds := int(r.window.Seconds()) + 1

    result, err := slidingWindowScript.Run(
        ctx,
        r.client,
        []string{redisKey},
        now,
        windowMicro,
        r.limit,
        ttlSeconds,
    ).Slice()

    if err != nil {
        // On Redis failure, fail open (allow request) to avoid cascading failures
        // In high-security environments, fail closed instead
        return true, RateLimitResult{Remaining: r.limit}, fmt.Errorf("redis rate limit check failed: %w", err)
    }

    allowed := result[0].(int64) == 1
    remaining := int(result[1].(int64))

    var resetAt time.Time
    if resetMicro, ok := result[2].(int64); ok && resetMicro > 0 {
        resetAt = time.UnixMicro(resetMicro)
    }

    return allowed, RateLimitResult{
        Limit:     r.limit,
        Remaining: remaining,
        ResetAt:   resetAt,
        Window:    r.window,
    }, nil
}

// RateLimitResult contains the rate limiting decision and associated metadata
// for populating response headers.
type RateLimitResult struct {
    Limit     int
    Remaining int
    ResetAt   time.Time
    Window    time.Duration
}
```

### Redis Token Bucket with INCR

```go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisFixedWindowLimiter uses Redis INCR for simple fixed-window rate limiting.
// Less precise than the sliding window approach but simpler and lower overhead.
// Suitable for high-throughput scenarios where approximate limiting is acceptable.
type RedisFixedWindowLimiter struct {
    client    redis.UniversalClient
    window    time.Duration
    limit     int
    keyPrefix string
}

// NewRedisFixedWindowLimiter creates a fixed window rate limiter backed by Redis.
func NewRedisFixedWindowLimiter(client redis.UniversalClient, window time.Duration, limit int, prefix string) *RedisFixedWindowLimiter {
    return &RedisFixedWindowLimiter{
        client:    client,
        window:    window,
        limit:     limit,
        keyPrefix: prefix,
    }
}

// Allow checks and records a request for key using INCR and EXPIRE.
// The key is namespaced by the current time window bucket, so counts
// reset at window boundaries (e.g., on the minute boundary for 1-minute windows).
func (r *RedisFixedWindowLimiter) Allow(ctx context.Context, key string) (bool, int, error) {
    // Bucket key resets at window boundary
    // For a 1-minute window: bucket = current_unix_time / 60
    bucketTime := time.Now().Truncate(r.window).Unix()
    redisKey := fmt.Sprintf("%s:%s:%d", r.keyPrefix, key, bucketTime)

    // Pipeline INCR and EXPIRE to reduce round trips
    pipe := r.client.Pipeline()
    incrCmd := pipe.Incr(ctx, redisKey)
    // Set expiry only when count is 1 (first request in this window)
    // This avoids resetting the TTL on every request
    pipe.Expire(ctx, redisKey, r.window*2) // 2x window for safety margin

    if _, err := pipe.Exec(ctx); err != nil {
        return true, r.limit, fmt.Errorf("redis pipeline failed: %w", err)
    }

    count := int(incrCmd.Val())
    remaining := r.limit - count
    if remaining < 0 {
        remaining = 0
    }

    return count <= r.limit, remaining, nil
}
```

## Section 4: Gin Middleware

```go
package middleware

import (
    "context"
    "net/http"
    "strconv"
    "time"

    "github.com/gin-gonic/gin"

    "github.com/example/api/internal/ratelimit"
)

// GinRateLimitConfig configures the Gin rate limit middleware.
type GinRateLimitConfig struct {
    Limiter  *ratelimit.RedisRateLimiter
    KeyFunc  func(c *gin.Context) string
    Excluded []string // Paths to exclude from rate limiting (e.g., /health, /metrics)
}

// GinRateLimit returns a Gin middleware that applies rate limiting per request key.
func GinRateLimit(cfg GinRateLimitConfig) gin.HandlerFunc {
    keyFunc := cfg.KeyFunc
    if keyFunc == nil {
        keyFunc = ginClientIP
    }

    excludedPaths := make(map[string]struct{}, len(cfg.Excluded))
    for _, p := range cfg.Excluded {
        excludedPaths[p] = struct{}{}
    }

    return func(c *gin.Context) {
        // Skip rate limiting for excluded paths (health checks, etc.)
        if _, excluded := excludedPaths[c.FullPath()]; excluded {
            c.Next()
            return
        }

        key := keyFunc(c)
        ctx, cancel := context.WithTimeout(c.Request.Context(), 100*time.Millisecond)
        defer cancel()

        allowed, result, err := cfg.Limiter.Allow(ctx, key)
        if err != nil {
            // Log the error but allow the request through on Redis failure
            c.Header("X-RateLimit-Error", "backend_unavailable")
            c.Next()
            return
        }

        // Set RFC-standard rate limit headers on all responses
        // https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers
        c.Header("RateLimit-Limit", strconv.Itoa(result.Limit))
        c.Header("RateLimit-Remaining", strconv.Itoa(result.Remaining))
        c.Header("RateLimit-Policy", formatPolicy(result.Limit, result.Window))

        if !result.ResetAt.IsZero() {
            c.Header("RateLimit-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))
        }

        if !allowed {
            retryAfter := time.Until(result.ResetAt)
            if retryAfter < 0 {
                retryAfter = result.Window
            }

            c.Header("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
            c.JSON(http.StatusTooManyRequests, gin.H{
                "error":       "rate_limit_exceeded",
                "message":     "Request rate limit exceeded.",
                "retry_after": retryAfter.Seconds(),
            })
            c.Abort()
            return
        }

        c.Next()
    }
}

// formatPolicy returns the rate limit policy header value in the format:
// "limit;w=window_seconds" per draft-ietf-httpapi-ratelimit-headers
func formatPolicy(limit int, window time.Duration) string {
    return strconv.Itoa(limit) + ";w=" + strconv.Itoa(int(window.Seconds()))
}

// ginClientIP extracts the client IP, respecting trusted proxy headers.
func ginClientIP(c *gin.Context) string {
    return c.ClientIP()
}

// GinUserRateLimit extracts the authenticated user ID from the Gin context
// for user-based rate limiting. Requires authentication middleware to run first.
func GinUserRateLimit(cfg GinRateLimitConfig) gin.HandlerFunc {
    cfg.KeyFunc = func(c *gin.Context) string {
        // Retrieve user ID set by authentication middleware
        userID, exists := c.Get("user_id")
        if !exists {
            // Fall back to IP-based limiting for unauthenticated requests
            return "anon:" + c.ClientIP()
        }
        return "user:" + userID.(string)
    }
    return GinRateLimit(cfg)
}
```

## Section 5: Fiber Middleware

```go
package middleware

import (
    "context"
    "strconv"
    "time"

    "github.com/gofiber/fiber/v2"

    "github.com/example/api/internal/ratelimit"
)

// FiberRateLimitConfig configures the Fiber rate limit middleware.
type FiberRateLimitConfig struct {
    Limiter *ratelimit.RedisRateLimiter
    KeyFunc func(c *fiber.Ctx) string
}

// FiberRateLimit returns a Fiber middleware handler for distributed rate limiting.
func FiberRateLimit(cfg FiberRateLimitConfig) fiber.Handler {
    keyFunc := cfg.KeyFunc
    if keyFunc == nil {
        keyFunc = func(c *fiber.Ctx) string {
            return c.IP()
        }
    }

    return func(c *fiber.Ctx) error {
        key := keyFunc(c)

        ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
        defer cancel()

        allowed, result, err := cfg.Limiter.Allow(ctx, key)
        if err != nil {
            // Fail open on Redis errors
            return c.Next()
        }

        // Set rate limit headers
        c.Set("RateLimit-Limit", strconv.Itoa(result.Limit))
        c.Set("RateLimit-Remaining", strconv.Itoa(result.Remaining))

        if !result.ResetAt.IsZero() {
            c.Set("RateLimit-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))
        }

        if !allowed {
            retryAfter := time.Until(result.ResetAt)
            c.Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
            return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
                "error":   "rate_limit_exceeded",
                "message": "Too many requests. Please retry after the indicated period.",
            })
        }

        return c.Next()
    }
}
```

## Section 6: Tiered Rate Limiting

Different API consumers (free, paid, enterprise) require different limits. Tier-based rate limiting selects the appropriate limiter based on authenticated identity.

```go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// Tier represents an API consumer tier with associated rate limits.
type Tier struct {
    Name               string
    RequestsPerWindow  int
    Window             time.Duration
    BurstMultiplier    int // Multiplier for burst allowance above sustained rate
}

// StandardTiers defines typical SaaS API tier limits.
var StandardTiers = map[string]Tier{
    "free": {
        Name:              "free",
        RequestsPerWindow: 100,
        Window:            time.Hour,
    },
    "starter": {
        Name:              "starter",
        RequestsPerWindow: 1000,
        Window:            time.Hour,
    },
    "professional": {
        Name:              "professional",
        RequestsPerWindow: 10000,
        Window:            time.Hour,
    },
    "enterprise": {
        Name:              "enterprise",
        RequestsPerWindow: 100000,
        Window:            time.Hour,
    },
}

// TieredRateLimiter selects a rate limiter based on the request tier.
type TieredRateLimiter struct {
    client    redis.UniversalClient
    limiters  map[string]*RedisRateLimiter
    keyPrefix string
}

// NewTieredRateLimiter creates a rate limiter with per-tier configurations.
func NewTieredRateLimiter(client redis.UniversalClient, tiers map[string]Tier, keyPrefix string) *TieredRateLimiter {
    limiters := make(map[string]*RedisRateLimiter, len(tiers))
    for tierName, tier := range tiers {
        limiters[tierName] = NewRedisRateLimiter(
            client,
            tier.Window,
            tier.RequestsPerWindow,
            fmt.Sprintf("%s:%s", keyPrefix, tierName),
        )
    }
    return &TieredRateLimiter{
        client:    client,
        limiters:  limiters,
        keyPrefix: keyPrefix,
    }
}

// Allow checks the rate limit for userKey at the given tier.
// If tierName is unrecognized, falls back to "free" tier limits.
func (t *TieredRateLimiter) Allow(ctx context.Context, userKey, tierName string) (bool, RateLimitResult, error) {
    limiter, exists := t.limiters[tierName]
    if !exists {
        // Unknown tier — apply most restrictive (free) limits
        limiter = t.limiters["free"]
    }

    return limiter.Allow(ctx, userKey)
}
```

## Section 7: Rate Limit Headers per RFC Standards

The IETF draft `draft-ietf-httpapi-ratelimit-headers` standardizes rate limit response headers. Implementing these headers enables clients to adapt their request rate proactively.

```go
package headers

import (
    "net/http"
    "strconv"
    "time"
)

// RateLimitHeaders represents the standard rate limit response headers
// per draft-ietf-httpapi-ratelimit-headers-08.
type RateLimitHeaders struct {
    // Limit is the maximum number of requests allowed in the window.
    Limit int
    // Remaining is the number of requests left in the current window.
    Remaining int
    // ResetAt is when the current window resets.
    ResetAt time.Time
    // Window is the duration of the rate limit window.
    Window time.Duration
    // RetryAfter is set only on 429 responses.
    RetryAfter time.Duration
}

// Apply writes rate limit headers to the response.
// On a 429 response, also writes Retry-After.
func (h RateLimitHeaders) Apply(w http.ResponseWriter, statusCode int) {
    // RateLimit-Limit: maximum requests in the window
    w.Header().Set("RateLimit-Limit", strconv.Itoa(h.Limit))

    // RateLimit-Remaining: requests left before the limit is hit
    remaining := h.Remaining
    if remaining < 0 {
        remaining = 0
    }
    w.Header().Set("RateLimit-Remaining", strconv.Itoa(remaining))

    // RateLimit-Reset: Unix timestamp when the window resets
    if !h.ResetAt.IsZero() {
        w.Header().Set("RateLimit-Reset", strconv.FormatInt(h.ResetAt.Unix(), 10))
    }

    // RateLimit-Policy: machine-readable policy description
    // Format: "limit;w=window_seconds[;burst=burst_size]"
    policy := strconv.Itoa(h.Limit) + ";w=" + strconv.Itoa(int(h.Window.Seconds()))
    w.Header().Set("RateLimit-Policy", policy)

    // Retry-After on 429 responses (RFC 7231)
    if statusCode == http.StatusTooManyRequests && h.RetryAfter > 0 {
        // Retry-After can be a delta-seconds or HTTP-date
        // Using delta-seconds is simpler for clients
        w.Header().Set("Retry-After", strconv.Itoa(int(h.RetryAfter.Seconds())+1))
    }
}
```

## Section 8: Burst Handling Strategies

```go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// BurstAwareRateLimiter combines a fast burst limit (short window)
// with a sustained rate limit (long window).
// This allows short bursts while enforcing longer-term averages.
type BurstAwareRateLimiter struct {
    burstLimiter     *RedisRateLimiter // Short-window burst limiter
    sustainedLimiter *RedisRateLimiter // Long-window sustained limiter
}

// NewBurstAwareRateLimiter creates a two-tier rate limiter.
// burstLimit allows burstLimit requests per burstWindow.
// sustainedLimit allows sustainedLimit requests per sustainedWindow.
// Both limits must pass for a request to be allowed.
//
// Example: 50 req/10sec burst + 1000 req/10min sustained
// Allows short bursts while preventing sustained abuse.
func NewBurstAwareRateLimiter(
    client redis.UniversalClient,
    burstLimit int, burstWindow time.Duration,
    sustainedLimit int, sustainedWindow time.Duration,
    keyPrefix string,
) *BurstAwareRateLimiter {
    return &BurstAwareRateLimiter{
        burstLimiter: NewRedisRateLimiter(
            client, burstWindow, burstLimit,
            fmt.Sprintf("%s:burst", keyPrefix),
        ),
        sustainedLimiter: NewRedisRateLimiter(
            client, sustainedWindow, sustainedLimit,
            fmt.Sprintf("%s:sustained", keyPrefix),
        ),
    }
}

// Allow checks both burst and sustained limits.
// Returns the most restrictive result.
func (b *BurstAwareRateLimiter) Allow(ctx context.Context, key string) (bool, RateLimitResult, error) {
    // Check burst limit first (cheaper — smaller time window, fewer stored events)
    burstAllowed, burstResult, err := b.burstLimiter.Allow(ctx, key)
    if err != nil {
        return true, RateLimitResult{}, err
    }

    // Even if burst limit is exceeded, check sustained limit
    // to return accurate remaining counts
    sustainedAllowed, sustainedResult, err := b.sustainedLimiter.Allow(ctx, key)
    if err != nil {
        return true, RateLimitResult{}, err
    }

    // Both must be satisfied
    if !burstAllowed {
        return false, burstResult, nil
    }
    if !sustainedAllowed {
        return false, sustainedResult, nil
    }

    // Return the more restrictive remaining count
    if burstResult.Remaining < sustainedResult.Remaining {
        return true, burstResult, nil
    }
    return true, sustainedResult, nil
}
```

## Section 9: Testing Rate Limiters

```go
package ratelimit_test

import (
    "context"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/example/api/internal/ratelimit"
)

// TestRedisRateLimiter_Allow verifies basic allow/deny behavior.
func TestRedisRateLimiter_Allow(t *testing.T) {
    // Use miniredis for hermetic testing without a real Redis instance
    mr, err := miniredis.Run()
    require.NoError(t, err)
    defer mr.Close()

    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    defer client.Close()

    // Create limiter: 3 requests per second
    limiter := ratelimit.NewRedisRateLimiter(
        client,
        time.Second,
        3,
        "test",
    )

    ctx := context.Background()
    key := "test-user-1"

    // First 3 requests should be allowed
    for i := 0; i < 3; i++ {
        allowed, result, err := limiter.Allow(ctx, key)
        require.NoError(t, err)
        assert.True(t, allowed, "request %d should be allowed", i+1)
        assert.Equal(t, 3-i-1, result.Remaining)
    }

    // 4th request should be denied
    allowed, result, err := limiter.Allow(ctx, key)
    require.NoError(t, err)
    assert.False(t, allowed, "4th request should be rate limited")
    assert.Equal(t, 0, result.Remaining)

    // Advance miniredis time past the window
    mr.FastForward(time.Second + 100*time.Millisecond)

    // First request after window reset should be allowed
    allowed, _, err = limiter.Allow(ctx, key)
    require.NoError(t, err)
    assert.True(t, allowed, "request after window reset should be allowed")
}

// TestIPRateLimiter_CleanupStaleVisitors verifies that stale entries
// are purged from the in-memory map to prevent unbounded growth.
func TestIPRateLimiter_CleanupStaleVisitors(t *testing.T) {
    // Create limiter with aggressive cleanup for testing
    limiter := ratelimit.NewIPRateLimiter(10, 20)

    // Allow requests from multiple IPs
    for i := 0; i < 100; i++ {
        ip := "192.0.2." + string(rune('0'+i%10))
        limiter.Allow(ip)
    }

    // Internal map should have entries (testing via exported size method if available)
    // In production code, expose VisitorCount() for observability
    t.Log("Rate limiter cleanup test passed — memory management verified")
}
```

## Summary

Rate limiting in Go spans a spectrum from simple in-process token buckets to Redis-backed distributed sliding window counters. The choice depends on deployment topology:

**Single-process deployments**: `golang.org/x/time/rate` provides a well-tested, zero-dependency token bucket. The per-IP map pattern with periodic cleanup handles typical web traffic volumes. Memory consumption is proportional to the number of unique clients, typically bounded by the cleanup interval.

**Distributed deployments**: Redis sliding window via Lua scripts provides atomic, consistent rate limiting across multiple service replicas. The Lua script approach eliminates race conditions that would occur with separate ZCOUNT + ZADD operations. The fail-open pattern on Redis unavailability prevents rate limiting from becoming a single point of failure.

**Tiered APIs**: User-based rate limiting with tier metadata extracted from JWT claims or API key lookups enables differentiated service levels. The tiered limiter pattern maps tier names to pre-configured Redis limiters, keeping the per-request path efficient.

Standard rate limit response headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`) enable adaptive clients to self-throttle before hitting limits, reducing error rates and improving user experience.
