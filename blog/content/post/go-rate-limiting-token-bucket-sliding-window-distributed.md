---
title: "Go Rate Limiting: Token Bucket, Sliding Window, and Distributed Rate Limiting"
date: 2030-12-05T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Rate Limiting", "Redis", "Distributed Systems", "HTTP Middleware", "Circuit Breaker"]
categories:
- Go
- Architecture
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go rate limiting implementations: golang.org/x/time/rate token bucket, sliding window algorithms, Redis-based distributed rate limiting with go-redis, per-client HTTP middleware, and circuit breaker integration for production services."
more_link: "yes"
url: "/go-rate-limiting-token-bucket-sliding-window-distributed/"
---

Rate limiting is a fundamental resilience pattern for any service that serves external clients or calls downstream dependencies. Without it, a single abusive client can saturate your service, a dependency outage can cascade into an infinite retry storm, and traffic spikes become outages. Go provides the standard `golang.org/x/time/rate` token bucket implementation for single-process rate limiting, but production systems running multiple replicas require distributed rate limiting where limits are shared across all instances.

This guide provides complete, production-grade implementations of the token bucket algorithm with `golang.org/x/time/rate`, a sliding window counter algorithm, Redis-based distributed rate limiting using atomic Lua scripts, per-client HTTP middleware that extracts client identity from request context, and integration with circuit breakers for downstream call protection.

<!--more-->

# Go Rate Limiting: Token Bucket, Sliding Window, and Distributed Rate Limiting

## Concepts and Algorithm Selection

Before choosing an implementation, understand what each algorithm guarantees:

**Token Bucket**: Allows bursting up to the bucket capacity, then limits to a steady-state rate. A bucket with capacity 100 and refill rate 10/second allows a burst of 100 requests instantly, then 10 requests per second. Good for APIs where clients legitimately need to burst.

**Sliding Window Counter**: Counts requests in a rolling time window. If the window is 60 seconds and the limit is 100, at any moment the last 60 seconds must contain fewer than 100 requests. More precise than a fixed window (which can allow 2x the rate at window boundaries) but more computationally expensive.

**Fixed Window Counter**: Counts requests in discrete time buckets (e.g., 00:00-01:00, 01:00-02:00). Simple and fast but allows up to 2x the intended rate at window boundaries.

**Sliding Window Log**: Stores the timestamp of every request and counts those within the window. Most precise but O(n) memory where n is the request count per window.

The right choice depends on your requirements:
- API gateway with bursty clients: token bucket
- Per-user billing limits: sliding window counter
- Simple protection against abuse: fixed window counter

## Token Bucket with golang.org/x/time/rate

The `golang.org/x/time/rate` package implements a token bucket limiter. It is goroutine-safe and suitable for single-process rate limiting.

### Basic Limiter Usage

```go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "golang.org/x/time/rate"
)

// Limiter wraps rate.Limiter with additional metadata.
type Limiter struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

// NewLimiter creates a rate limiter that allows 'r' events per second
// with a burst size of 'b'.
func NewLimiter(r rate.Limit, b int) *Limiter {
    return &Limiter{
        limiter:  rate.NewLimiter(r, b),
        lastSeen: time.Now(),
    }
}

// Allow checks if a request is allowed without blocking.
// Returns false immediately if the rate limit is exceeded.
func (l *Limiter) Allow() bool {
    l.lastSeen = time.Now()
    return l.limiter.Allow()
}

// Wait blocks until the request can proceed or the context is cancelled.
func (l *Limiter) Wait(ctx context.Context) error {
    l.lastSeen = time.Now()
    return l.limiter.Wait(ctx)
}

// Reserve returns a Reservation that allows the caller to schedule
// the request after the appropriate delay.
func (l *Limiter) Reserve() *rate.Reservation {
    l.lastSeen = time.Now()
    return l.limiter.Reserve()
}
```

### Per-Client Rate Limiter Registry

A central registry maintains per-client limiters with LRU eviction to prevent memory growth:

```go
package ratelimit

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// Registry maintains a per-client rate limiter map with TTL-based eviction.
type Registry struct {
    mu       sync.Mutex
    limiters map[string]*Limiter
    rate     rate.Limit
    burst    int
    ttl      time.Duration
}

// NewRegistry creates a Registry with the given per-client rate and burst.
// The TTL controls how long an idle client's limiter is kept in memory.
func NewRegistry(r rate.Limit, burst int, ttl time.Duration) *Registry {
    reg := &Registry{
        limiters: make(map[string]*Limiter),
        rate:     r,
        burst:    burst,
        ttl:      ttl,
    }
    // Start background cleanup goroutine
    go reg.cleanupLoop()
    return reg
}

// Get returns (or creates) the rate limiter for a given client key.
func (r *Registry) Get(key string) *Limiter {
    r.mu.Lock()
    defer r.mu.Unlock()

    if l, exists := r.limiters[key]; exists {
        l.lastSeen = time.Now()
        return l
    }

    l := NewLimiter(r.rate, r.burst)
    r.limiters[key] = l
    return l
}

func (r *Registry) cleanupLoop() {
    ticker := time.NewTicker(r.ttl / 2)
    defer ticker.Stop()
    for range ticker.C {
        r.cleanup()
    }
}

func (r *Registry) cleanup() {
    r.mu.Lock()
    defer r.mu.Unlock()
    threshold := time.Now().Add(-r.ttl)
    for key, l := range r.limiters {
        if l.lastSeen.Before(threshold) {
            delete(r.limiters, key)
        }
    }
}
```

### HTTP Middleware Using the Registry

```go
package middleware

import (
    "net/http"
    "strings"
    "time"

    "golang.org/x/time/rate"
    "myservice/internal/ratelimit"
)

// ClientKeyFunc extracts a rate limit key from the request.
// Returns an empty string if the client should not be rate limited.
type ClientKeyFunc func(r *http.Request) string

// IPClientKey extracts the client IP address.
func IPClientKey(r *http.Request) string {
    // Check X-Forwarded-For first (behind load balancer)
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        // Take the first IP in the chain (leftmost = original client)
        parts := strings.Split(xff, ",")
        ip := strings.TrimSpace(parts[0])
        if ip != "" {
            return "ip:" + ip
        }
    }
    // Fall back to RemoteAddr
    addr := r.RemoteAddr
    if colon := strings.LastIndex(addr, ":"); colon >= 0 {
        addr = addr[:colon]
    }
    return "ip:" + addr
}

// TokenClientKey extracts the API token for rate limiting authenticated clients.
func TokenClientKey(r *http.Request) string {
    auth := r.Header.Get("Authorization")
    if strings.HasPrefix(auth, "Bearer ") {
        token := strings.TrimPrefix(auth, "Bearer ")
        // Use first 16 chars as key to avoid logging full tokens
        if len(token) > 16 {
            return "token:" + token[:16]
        }
        return "token:" + token
    }
    return ""
}

// RateLimitMiddleware creates an HTTP middleware that rate limits by client key.
func RateLimitMiddleware(
    keyFn ClientKeyFunc,
    requestsPerSecond float64,
    burstSize int,
    ttl time.Duration,
) func(http.Handler) http.Handler {
    registry := ratelimit.NewRegistry(
        rate.Limit(requestsPerSecond),
        burstSize,
        ttl,
    )

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := keyFn(r)
            if key == "" {
                // No key — allow without rate limiting
                next.ServeHTTP(w, r)
                return
            }

            limiter := registry.Get(key)
            if !limiter.Allow() {
                // Return 429 with Retry-After header
                reservation := limiter.Reserve()
                delay := reservation.Delay()
                reservation.Cancel()

                w.Header().Set("Retry-After", fmt.Sprintf("%.0f", delay.Seconds()))
                w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%v", requestsPerSecond))
                w.Header().Set("X-RateLimit-Remaining", "0")
                http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Sliding Window Algorithm

The sliding window counter provides a more precise rate limit than fixed window by avoiding the boundary burst problem.

### In-Process Sliding Window

```go
package ratelimit

import (
    "sync"
    "time"
)

// SlidingWindow implements a thread-safe sliding window rate limiter.
// It maintains a ring buffer of request timestamps.
type SlidingWindow struct {
    mu        sync.Mutex
    limit     int
    window    time.Duration
    requests  []time.Time
    head      int  // Ring buffer head index
    count     int  // Current count of requests in window
}

// NewSlidingWindow creates a sliding window limiter.
// limit: maximum requests allowed in the window duration.
func NewSlidingWindow(limit int, window time.Duration) *SlidingWindow {
    return &SlidingWindow{
        limit:    limit,
        window:   window,
        requests: make([]time.Time, limit),
    }
}

// Allow checks if a new request is allowed.
// It removes expired requests from the window before checking.
func (sw *SlidingWindow) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-sw.window)

    // Remove requests that have fallen outside the window
    // Scan from the tail (oldest entries)
    for sw.count > 0 {
        // Calculate tail index
        tail := (sw.head - sw.count + len(sw.requests)) % len(sw.requests)
        if sw.requests[tail].After(cutoff) {
            break  // All remaining entries are within the window
        }
        sw.count--
    }

    if sw.count >= sw.limit {
        return false
    }

    // Add the new request
    sw.requests[sw.head] = now
    sw.head = (sw.head + 1) % len(sw.requests)
    sw.count++
    return true
}

// Remaining returns the number of requests remaining in the current window.
func (sw *SlidingWindow) Remaining() int {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-sw.window)

    // Count active requests
    active := 0
    for i := 0; i < sw.count; i++ {
        idx := (sw.head - sw.count + i + len(sw.requests)) % len(sw.requests)
        if sw.requests[idx].After(cutoff) {
            active++
        }
    }
    remaining := sw.limit - active
    if remaining < 0 {
        return 0
    }
    return remaining
}

// Reset clears the window state.
func (sw *SlidingWindow) Reset() {
    sw.mu.Lock()
    defer sw.mu.Unlock()
    sw.head = 0
    sw.count = 0
}
```

## Redis-Based Distributed Rate Limiting

For stateless services running multiple replicas, rate limiting state must be shared. Redis provides the atomic operations needed for correct distributed rate limiting.

### Token Bucket with Redis

Implement a token bucket algorithm in Redis using a Lua script for atomicity:

```go
package distributed

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

const tokenBucketScript = `
-- Token Bucket algorithm implemented in Lua for atomic execution
-- KEYS[1]: rate limit key (e.g., "ratelimit:ip:1.2.3.4")
-- ARGV[1]: bucket capacity (max tokens)
-- ARGV[2]: refill rate (tokens per second)
-- ARGV[3]: requested tokens (usually 1)
-- ARGV[4]: current timestamp (Unix nanoseconds as string)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Get current bucket state
local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- Initialize bucket if it doesn't exist
if tokens == nil then
    tokens = capacity
    last_refill = now
end

-- Calculate tokens to add since last refill
local elapsed = (now - last_refill) / 1e9  -- Convert nanoseconds to seconds
local new_tokens = elapsed * rate
tokens = math.min(capacity, tokens + new_tokens)
last_refill = now

-- Check if we have enough tokens
local allowed = 0
local remaining = 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
end
remaining = math.floor(tokens)

-- Update bucket state with TTL
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
-- Set TTL to capacity/rate seconds + buffer (time to refill the bucket)
local ttl = math.ceil(capacity / rate) + 10
redis.call('EXPIRE', key, ttl)

return {allowed, remaining}
`

// TokenBucketLimiter is a distributed token bucket rate limiter backed by Redis.
type TokenBucketLimiter struct {
    client   *redis.Client
    script   *redis.Script
    capacity int
    rate     float64  // tokens per second
    keyPrefix string
}

// NewTokenBucketLimiter creates a distributed token bucket limiter.
func NewTokenBucketLimiter(client *redis.Client, capacity int, rate float64, keyPrefix string) *TokenBucketLimiter {
    return &TokenBucketLimiter{
        client:    client,
        script:    redis.NewScript(tokenBucketScript),
        capacity:  capacity,
        rate:      rate,
        keyPrefix: keyPrefix,
    }
}

// Allow checks if a request from the given key is allowed.
// Returns (allowed bool, remaining int, err error).
func (l *TokenBucketLimiter) Allow(ctx context.Context, key string) (bool, int, error) {
    redisKey := fmt.Sprintf("%s:%s", l.keyPrefix, key)
    now := time.Now().UnixNano()

    result, err := l.script.Run(ctx, l.client, []string{redisKey},
        l.capacity,
        l.rate,
        1,    // request 1 token
        now,
    ).Int64Slice()
    if err != nil {
        // On Redis failure, fail open (allow) to avoid cascading failures
        // Log the error for alerting
        return true, l.capacity, fmt.Errorf("redis error: %w", err)
    }

    allowed := result[0] == 1
    remaining := int(result[1])
    return allowed, remaining, nil
}
```

### Sliding Window with Redis

The Redis ZSET (sorted set) provides an efficient sliding window implementation using request timestamps as scores:

```go
const slidingWindowScript = `
-- Sliding Window algorithm using sorted sets
-- KEYS[1]: rate limit key
-- ARGV[1]: window size in milliseconds
-- ARGV[2]: limit (max requests per window)
-- ARGV[3]: current timestamp in milliseconds
-- ARGV[4]: TTL for the key (in seconds)

local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Remove entries older than the window
local window_start = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count current entries in window
local count = redis.call('ZCARD', key)

if count < limit then
    -- Add this request with timestamp as score
    -- Use a unique member to avoid collisions at the same millisecond
    local member = now_ms .. '-' .. redis.call('INCR', key .. ':seq')
    redis.call('ZADD', key, now_ms, member)
    redis.call('EXPIRE', key, ttl)
    return {1, limit - count - 1}  -- allowed, remaining
else
    redis.call('EXPIRE', key, ttl)
    return {0, 0}  -- denied, remaining
end
`

// SlidingWindowLimiter implements distributed sliding window rate limiting.
type SlidingWindowLimiter struct {
    client    *redis.Client
    script    *redis.Script
    limit     int
    window    time.Duration
    keyPrefix string
}

func NewSlidingWindowLimiter(
    client *redis.Client,
    limit int,
    window time.Duration,
    keyPrefix string,
) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        client:    client,
        script:    redis.NewScript(slidingWindowScript),
        limit:     limit,
        window:    window,
        keyPrefix: keyPrefix,
    }
}

func (l *SlidingWindowLimiter) Allow(ctx context.Context, key string) (bool, int, error) {
    redisKey := fmt.Sprintf("%s:%s", l.keyPrefix, key)
    nowMs := time.Now().UnixMilli()
    windowMs := l.window.Milliseconds()
    ttlSeconds := int(l.window.Seconds()) + 10

    result, err := l.script.Run(ctx, l.client, []string{redisKey},
        windowMs,
        l.limit,
        nowMs,
        ttlSeconds,
    ).Int64Slice()
    if err != nil {
        // Fail open on Redis errors
        return true, l.limit, fmt.Errorf("redis error: %w", err)
    }

    allowed := result[0] == 1
    remaining := int(result[1])
    return allowed, remaining, nil
}
```

### Redis Connection Pool Configuration

```go
package config

import (
    "context"
    "time"
    "github.com/redis/go-redis/v9"
)

func NewRedisClient(addr, password string, db int) *redis.Client {
    client := redis.NewClient(&redis.Options{
        Addr:     addr,
        Password: password,
        DB:       db,

        // Connection pool tuning for rate limiting workloads
        // Rate limiting scripts are fast (<1ms), so use more connections
        PoolSize:     50,
        MinIdleConns: 10,
        MaxIdleConns: 20,

        // Timeouts — critical for fail-open behavior
        DialTimeout:  200 * time.Millisecond,
        ReadTimeout:  100 * time.Millisecond,
        WriteTimeout: 100 * time.Millisecond,
        PoolTimeout:  150 * time.Millisecond,

        // Connection health
        ConnMaxIdleTime: 5 * time.Minute,
        ConnMaxLifetime: 30 * time.Minute,
    })

    // Verify connectivity at startup
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := client.Ping(ctx).Err(); err != nil {
        panic(fmt.Sprintf("redis connection failed: %v", err))
    }

    return client
}

// NewRedisClusterClient for Redis Cluster deployments.
func NewRedisClusterClient(addrs []string, password string) *redis.ClusterClient {
    client := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:    addrs,
        Password: password,

        PoolSize:     20,
        MinIdleConns: 5,

        DialTimeout:  200 * time.Millisecond,
        ReadTimeout:  100 * time.Millisecond,
        WriteTimeout: 100 * time.Millisecond,
    })
    return client
}
```

## Multi-Tier Rate Limiting Middleware

Production APIs typically need multiple tiers:
- Global rate limit (protect the service)
- Per-authenticated-user limit (fair usage)
- Per-IP limit (unauthenticated protection)

```go
package middleware

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "strings"
    "time"
)

// RateLimitConfig defines rate limit tiers.
type RateLimitConfig struct {
    // Global limit applied to all requests
    GlobalRPS   float64
    GlobalBurst int

    // Per-IP limit for unauthenticated requests
    IPRPSAnon   float64
    IPBurstAnon int

    // Per-user limit for authenticated requests
    UserRPS   float64
    UserBurst int

    // Window for sliding window counters
    Window time.Duration
}

// Limiter interface allows swapping in-process and distributed limiters.
type Limiter interface {
    Allow(ctx context.Context, key string) (allowed bool, remaining int, err error)
}

// MultiTierMiddleware implements layered rate limiting.
type MultiTierMiddleware struct {
    global     Limiter
    perIP      Limiter
    perUser    Limiter
    getUserID  func(*http.Request) string
    getClientIP func(*http.Request) string
}

func NewMultiTierMiddleware(
    global, perIP, perUser Limiter,
    getUserID func(*http.Request) string,
    getClientIP func(*http.Request) string,
) *MultiTierMiddleware {
    return &MultiTierMiddleware{
        global:     global,
        perIP:      perIP,
        perUser:    perUser,
        getUserID:  getUserID,
        getClientIP: getClientIP,
    }
}

func (m *MultiTierMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Check global rate limit first
        allowed, remaining, err := m.global.Allow(ctx, "global")
        if err != nil {
            // Log error — fail open
        } else if !allowed {
            writeLimitExceeded(w, "global limit exceeded", remaining, 0)
            return
        }

        // Check per-identity limit
        userID := m.getUserID(r)
        if userID != "" {
            // Authenticated user — check per-user limit
            allowed, remaining, err = m.perUser.Allow(ctx, "user:"+userID)
            if err != nil {
                // Log error — fail open
            } else if !allowed {
                writeLimitExceeded(w, "user rate limit exceeded", remaining, 60)
                return
            }
            // Add user info to response headers
            w.Header().Set("X-RateLimit-User-Remaining", strconv.Itoa(remaining))
        } else {
            // Unauthenticated — check per-IP limit
            clientIP := m.getClientIP(r)
            allowed, remaining, err = m.perIP.Allow(ctx, "ip:"+clientIP)
            if err != nil {
                // Log error — fail open
            } else if !allowed {
                writeLimitExceeded(w, "IP rate limit exceeded", remaining, 30)
                return
            }
            w.Header().Set("X-RateLimit-IP-Remaining", strconv.Itoa(remaining))
        }

        next.ServeHTTP(w, r)
    })
}

func writeLimitExceeded(w http.ResponseWriter, msg string, remaining, retryAfter int) {
    w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
    if retryAfter > 0 {
        w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
    }
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusTooManyRequests)
    fmt.Fprintf(w, `{"error":"rate_limit_exceeded","message":%q}`, msg)
}
```

## Circuit Breaker Integration

Rate limiting protects your service from overload. Circuit breakers protect your service from overloading downstream dependencies. They work together: rate limiters throttle incoming traffic, circuit breakers stop outgoing traffic to degraded services.

### Circuit Breaker with gobreaker

```go
package circuitbreaker

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/sony/gobreaker/v2"
)

// DownstreamClient wraps an HTTP client with rate limiting and circuit breaking.
type DownstreamClient struct {
    breaker *gobreaker.CircuitBreaker[[]byte]
    limiter Limiter  // Rate limiter for outgoing calls
}

func NewDownstreamClient(name string, limiter Limiter) *DownstreamClient {
    cb := gobreaker.NewCircuitBreaker[[]byte](gobreaker.Settings{
        Name: name,

        // Open circuit after 5 consecutive failures
        MaxRequests:  3,

        // Wait 60 seconds before attempting to close
        Timeout: 60 * time.Second,

        // Use a 30-second rolling window for error counting
        Interval: 30 * time.Second,

        // Open when >50% of requests in the last 30 seconds fail
        // with a minimum of 5 requests
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 5 && failureRatio >= 0.5
        },

        OnStateChange: func(name string, from, to gobreaker.State) {
            fmt.Printf("Circuit breaker %s: %s -> %s\n", name, from, to)
            // Emit metrics for the state change
        },
    })

    return &DownstreamClient{
        breaker: cb,
        limiter: limiter,
    }
}

var ErrRateLimited = errors.New("rate limited")
var ErrCircuitOpen = errors.New("circuit breaker open")

func (c *DownstreamClient) Call(ctx context.Context, key string, fn func() ([]byte, error)) ([]byte, error) {
    // Check rate limit before making the call
    allowed, _, err := c.limiter.Allow(ctx, key)
    if err != nil {
        // Log error but proceed
    } else if !allowed {
        return nil, ErrRateLimited
    }

    // Execute through the circuit breaker
    result, err := c.breaker.Execute(fn)
    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            return nil, ErrCircuitOpen
        }
        return nil, err
    }

    return result, nil
}
```

### Adaptive Rate Limiting

Adjust rate limits based on downstream health:

```go
package adaptive

import (
    "sync"
    "sync/atomic"
    "time"

    "golang.org/x/time/rate"
)

// AdaptiveLimiter dynamically adjusts its rate based on error signals.
// When errors are detected, it reduces the rate. When healthy, it gradually increases.
type AdaptiveLimiter struct {
    mu          sync.RWMutex
    limiter     *rate.Limiter
    minRate     rate.Limit
    maxRate     rate.Limit
    currentRate rate.Limit
    errorCount  int64
    successCount int64
    lastAdjust  time.Time
    adjustInterval time.Duration
}

func NewAdaptiveLimiter(minRate, maxRate rate.Limit, burst int) *AdaptiveLimiter {
    initial := (minRate + maxRate) / 2
    return &AdaptiveLimiter{
        limiter:        rate.NewLimiter(initial, burst),
        minRate:        minRate,
        maxRate:        maxRate,
        currentRate:    initial,
        adjustInterval: 10 * time.Second,
    }
}

// RecordSuccess records a successful downstream call.
func (al *AdaptiveLimiter) RecordSuccess() {
    atomic.AddInt64(&al.successCount, 1)
    al.maybeAdjust()
}

// RecordError records a failed downstream call.
func (al *AdaptiveLimiter) RecordError() {
    atomic.AddInt64(&al.errorCount, 1)
    al.maybeAdjust()
}

func (al *AdaptiveLimiter) maybeAdjust() {
    al.mu.Lock()
    defer al.mu.Unlock()

    now := time.Now()
    if now.Sub(al.lastAdjust) < al.adjustInterval {
        return
    }

    errors := atomic.SwapInt64(&al.errorCount, 0)
    successes := atomic.SwapInt64(&al.successCount, 0)
    total := errors + successes
    al.lastAdjust = now

    if total == 0 {
        return
    }

    errorRate := float64(errors) / float64(total)
    var newRate rate.Limit

    if errorRate > 0.1 {
        // High error rate — reduce by 20%
        newRate = al.currentRate * 0.8
        if newRate < al.minRate {
            newRate = al.minRate
        }
    } else if errorRate < 0.01 {
        // Low error rate — increase by 10%
        newRate = al.currentRate * 1.1
        if newRate > al.maxRate {
            newRate = al.maxRate
        }
    } else {
        return  // Acceptable error rate — no adjustment
    }

    al.currentRate = newRate
    al.limiter.SetLimit(newRate)
}

func (al *AdaptiveLimiter) Allow() bool {
    return al.limiter.Allow()
}
```

## Production Deployment Patterns

### Rate Limit Headers

Always communicate rate limit status in response headers following the draft RFC 6585 and de-facto standards:

```go
func setRateLimitHeaders(w http.ResponseWriter, limit, remaining, reset int) {
    w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
    w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
    w.Header().Set("X-RateLimit-Reset", strconv.Itoa(reset))  // Unix timestamp
    // Draft standard headers
    w.Header().Set("RateLimit-Limit", fmt.Sprintf("%d;w=60", limit))
    w.Header().Set("RateLimit-Remaining", strconv.Itoa(remaining))
    w.Header().Set("RateLimit-Reset", strconv.Itoa(reset))
}
```

### Redis Cluster Hash Tags

When using Redis Cluster, ensure rate limit keys for the same client hash to the same slot using hash tags:

```go
func clusterKey(prefix, clientID string) string {
    // Curly braces force the hash to use only the content inside
    // This ensures "ratelimit:{user-123}:requests" and
    // "ratelimit:{user-123}:seq" go to the same slot
    return fmt.Sprintf("ratelimit:{%s}:%s", clientID, prefix)
}
```

### Monitoring Rate Limiting

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    rateLimitAllowed = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "rate_limit_requests_total",
        Help: "Total requests processed by rate limiter.",
    }, []string{"tier", "decision"}) // decision: "allowed" or "denied"

    rateLimitRedisErrors = promauto.NewCounter(prometheus.CounterOpts{
        Name: "rate_limit_redis_errors_total",
        Help: "Total Redis errors in rate limiter (fail-open events).",
    })

    rateLimitLatency = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "rate_limit_check_duration_seconds",
        Help:    "Latency of rate limit checks.",
        Buckets: []float64{0.0001, 0.0005, 0.001, 0.005, 0.01},
    })
)

func RecordDecision(tier, decision string) {
    rateLimitAllowed.WithLabelValues(tier, decision).Inc()
}

func RecordRedisError() {
    rateLimitRedisErrors.Inc()
}
```

## Testing Rate Limiters

```go
package ratelimit_test

import (
    "context"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
    "myservice/internal/distributed"
)

func TestTokenBucketAllow(t *testing.T) {
    // Use miniredis for unit tests — no real Redis needed
    mr, err := miniredis.Run()
    if err != nil {
        t.Fatal(err)
    }
    defer mr.Close()

    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    limiter := distributed.NewTokenBucketLimiter(client, 10, 2.0, "test")

    ctx := context.Background()

    // Burst of 10 should be allowed
    for i := 0; i < 10; i++ {
        allowed, _, err := limiter.Allow(ctx, "testclient")
        if err != nil {
            t.Fatalf("unexpected error: %v", err)
        }
        if !allowed {
            t.Fatalf("request %d should be allowed in burst", i+1)
        }
    }

    // 11th request should be denied (bucket empty)
    allowed, _, err := limiter.Allow(ctx, "testclient")
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if allowed {
        t.Fatal("11th request should be denied")
    }

    // After 1 second, 2 tokens should have been added
    mr.FastForward(time.Second)
    for i := 0; i < 2; i++ {
        allowed, _, err := limiter.Allow(ctx, "testclient")
        if err != nil {
            t.Fatalf("unexpected error: %v", err)
        }
        if !allowed {
            t.Fatalf("request after refill %d should be allowed", i+1)
        }
    }
}

func BenchmarkSlidingWindowAllow(b *testing.B) {
    mr, _ := miniredis.Run()
    defer mr.Close()

    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    limiter := distributed.NewSlidingWindowLimiter(client, 1000, time.Minute, "bench")
    ctx := context.Background()

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            limiter.Allow(ctx, "benchclient")
        }
    })
}
```

## Summary

A production-grade Go rate limiting system requires multiple layers: the standard `golang.org/x/time/rate` token bucket for in-process limiting and backpressure within a single goroutine group, sliding window counters for precise per-client API limits, and Redis-backed distributed limiters for shared state across service replicas. Implement fail-open behavior on Redis errors to prevent the rate limiter from becoming a single point of failure, use Lua scripts for atomicity without WATCH/MULTI/EXEC overhead, and combine rate limiting with circuit breakers for complete resilience against both incoming overload and downstream degradation.
