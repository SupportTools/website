---
title: "Go Rate Limiting Patterns: Token Bucket, Sliding Window, and Distributed Rate Limiters"
date: 2030-07-17T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Rate Limiting", "Redis", "gRPC", "HTTP", "Distributed Systems"]
categories:
- Go
- Backend
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise rate limiting in Go covering golang.org/x/time/rate token bucket, sliding window algorithms, Redis-backed distributed rate limiters, per-user quotas, admission control, and gRPC/HTTP middleware integration."
more_link: "yes"
url: "/go-rate-limiting-patterns-token-bucket-sliding-window-distributed/"
---

Rate limiting is a critical component of production services that prevents resource exhaustion, protects downstream dependencies, and enforces service level agreements. In Go, the standard library's `golang.org/x/time/rate` package provides a well-tested token bucket implementation for single-process rate limiting, while distributed environments require coordination through shared state stores like Redis. This guide covers the implementation patterns from basic token buckets through sophisticated per-user distributed limiters with HTTP and gRPC middleware integration.

<!--more-->

## Token Bucket Algorithm

The token bucket algorithm models rate limits as a bucket that fills at a steady rate. Each request consumes one or more tokens, and requests are blocked or rejected when the bucket is empty. It naturally handles burst traffic up to the bucket capacity while enforcing a long-term average rate.

### Using golang.org/x/time/rate

```go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/time/rate"
)

// TokenBucketLimiter wraps the standard rate.Limiter with additional context
type TokenBucketLimiter struct {
    limiter *rate.Limiter
    name    string
}

// NewTokenBucketLimiter creates a limiter allowing rps requests per second
// with burst capacity up to burst requests
func NewTokenBucketLimiter(rps float64, burst int, name string) *TokenBucketLimiter {
    return &TokenBucketLimiter{
        limiter: rate.NewLimiter(rate.Limit(rps), burst),
        name:    name,
    }
}

// Allow returns true if the request should be allowed (non-blocking)
func (l *TokenBucketLimiter) Allow() bool {
    return l.limiter.Allow()
}

// AllowN allows n events at the current time
func (l *TokenBucketLimiter) AllowN(n int) bool {
    return l.limiter.AllowN(time.Now(), n)
}

// Wait blocks until the limiter allows the request or context is cancelled
func (l *TokenBucketLimiter) Wait(ctx context.Context) error {
    return l.limiter.Wait(ctx)
}

// WaitN blocks until n tokens are available
func (l *TokenBucketLimiter) WaitN(ctx context.Context, n int) error {
    return l.limiter.WaitN(ctx, n)
}

// Reserve returns a Reservation that can be used to delay execution
func (l *TokenBucketLimiter) Reserve() *rate.Reservation {
    return l.limiter.Reserve()
}

// Status returns current limiter state for monitoring
type Status struct {
    Name      string
    Burst     int
    Limit     rate.Limit
    Tokens    float64
    UpdatedAt time.Time
}

func (l *TokenBucketLimiter) Status() Status {
    return Status{
        Name:      l.name,
        Burst:     l.limiter.Burst(),
        Limit:     l.limiter.Limit(),
        UpdatedAt: time.Now(),
    }
}
```

### Per-User In-Process Token Buckets

```go
package ratelimit

import (
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// UserLimiterConfig defines per-tier rate limit parameters
type UserLimiterConfig struct {
    RPS   float64
    Burst int
}

var DefaultTierConfigs = map[string]UserLimiterConfig{
    "free":       {RPS: 10, Burst: 20},
    "pro":        {RPS: 100, Burst: 200},
    "enterprise": {RPS: 1000, Burst: 2000},
}

type userEntry struct {
    limiter    *rate.Limiter
    lastSeen   time.Time
    tier       string
}

// UserRateLimiter manages per-user token bucket limiters with LRU eviction
type UserRateLimiter struct {
    mu       sync.Mutex
    users    map[string]*userEntry
    configs  map[string]UserLimiterConfig
    ttl      time.Duration
    maxUsers int
}

func NewUserRateLimiter(configs map[string]UserLimiterConfig, ttl time.Duration, maxUsers int) *UserRateLimiter {
    ul := &UserRateLimiter{
        users:    make(map[string]*userEntry),
        configs:  configs,
        ttl:      ttl,
        maxUsers: maxUsers,
    }
    go ul.cleanupLoop()
    return ul
}

// GetLimiter returns the rate limiter for the given user and tier
func (ul *UserRateLimiter) GetLimiter(userID, tier string) *rate.Limiter {
    ul.mu.Lock()
    defer ul.mu.Unlock()

    if entry, ok := ul.users[userID]; ok {
        entry.lastSeen = time.Now()
        // If tier changed, recreate the limiter
        if entry.tier != tier {
            cfg := ul.configForTier(tier)
            entry.limiter = rate.NewLimiter(rate.Limit(cfg.RPS), cfg.Burst)
            entry.tier = tier
        }
        return entry.limiter
    }

    cfg := ul.configForTier(tier)
    entry := &userEntry{
        limiter:  rate.NewLimiter(rate.Limit(cfg.RPS), cfg.Burst),
        lastSeen: time.Now(),
        tier:     tier,
    }
    ul.users[userID] = entry
    return entry.limiter
}

func (ul *UserRateLimiter) configForTier(tier string) UserLimiterConfig {
    if cfg, ok := ul.configs[tier]; ok {
        return cfg
    }
    return ul.configs["free"]
}

func (ul *UserRateLimiter) cleanupLoop() {
    ticker := time.NewTicker(ul.ttl / 2)
    defer ticker.Stop()
    for range ticker.C {
        ul.mu.Lock()
        cutoff := time.Now().Add(-ul.ttl)
        for userID, entry := range ul.users {
            if entry.lastSeen.Before(cutoff) {
                delete(ul.users, userID)
            }
        }
        ul.mu.Unlock()
    }
}

// ActiveUsers returns the current number of tracked users (for monitoring)
func (ul *UserRateLimiter) ActiveUsers() int {
    ul.mu.Lock()
    defer ul.mu.Unlock()
    return len(ul.users)
}
```

## Sliding Window Rate Limiter

The sliding window algorithm provides a more accurate rate limit by tracking request timestamps within a rolling time window. It avoids the "boundary burst" problem of fixed windows.

### In-Memory Sliding Window

```go
package ratelimit

import (
    "sync"
    "time"
)

// SlidingWindowLimiter implements a sliding window rate limiter
type SlidingWindowLimiter struct {
    mu         sync.Mutex
    requests   []time.Time
    windowSize time.Duration
    maxRequests int
}

func NewSlidingWindowLimiter(windowSize time.Duration, maxRequests int) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        requests:    make([]time.Time, 0, maxRequests),
        windowSize:  windowSize,
        maxRequests: maxRequests,
    }
}

// Allow returns true if the request is within the rate limit
func (sw *SlidingWindowLimiter) Allow() bool {
    now := time.Now()
    cutoff := now.Add(-sw.windowSize)

    sw.mu.Lock()
    defer sw.mu.Unlock()

    // Remove timestamps outside the window
    i := 0
    for i < len(sw.requests) && sw.requests[i].Before(cutoff) {
        i++
    }
    sw.requests = sw.requests[i:]

    if len(sw.requests) >= sw.maxRequests {
        return false
    }

    sw.requests = append(sw.requests, now)
    return true
}

// Count returns the number of requests in the current window
func (sw *SlidingWindowLimiter) Count() int {
    now := time.Now()
    cutoff := now.Add(-sw.windowSize)

    sw.mu.Lock()
    defer sw.mu.Unlock()

    count := 0
    for _, t := range sw.requests {
        if !t.Before(cutoff) {
            count++
        }
    }
    return count
}

// RetryAfter returns the duration to wait before the next request will be allowed
func (sw *SlidingWindowLimiter) RetryAfter() time.Duration {
    now := time.Now()
    cutoff := now.Add(-sw.windowSize)

    sw.mu.Lock()
    defer sw.mu.Unlock()

    if len(sw.requests) < sw.maxRequests {
        return 0
    }

    // Find the oldest request within the window
    oldest := now
    for _, t := range sw.requests {
        if !t.Before(cutoff) && t.Before(oldest) {
            oldest = t
        }
    }

    // Wait until that request ages out of the window
    return oldest.Add(sw.windowSize).Sub(now)
}
```

## Redis-Backed Distributed Rate Limiter

For multi-instance deployments, rate limit state must be shared. Redis provides atomic operations that enable consistent rate limiting across all service instances.

### Sliding Window with Redis ZSET

```go
package ratelimit

import (
    "context"
    "fmt"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisRateLimiter implements a distributed sliding window limiter using Redis sorted sets
type RedisRateLimiter struct {
    client      *redis.Client
    windowSize  time.Duration
    maxRequests int64
    keyPrefix   string
}

func NewRedisRateLimiter(
    client *redis.Client,
    windowSize time.Duration,
    maxRequests int64,
    keyPrefix string,
) *RedisRateLimiter {
    return &RedisRateLimiter{
        client:      client,
        windowSize:  windowSize,
        maxRequests: maxRequests,
        keyPrefix:   keyPrefix,
    }
}

// Allow checks and records a request for the given key
func (r *RedisRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    now := time.Now()
    windowStart := now.Add(-r.windowSize)
    redisKey := fmt.Sprintf("%s:%s", r.keyPrefix, key)

    // Lua script for atomic check-and-increment
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local max_requests = tonumber(ARGV[3])
        local member = ARGV[4]
        local expire_seconds = tonumber(ARGV[5])

        -- Remove old entries outside the window
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current entries
        local count = redis.call('ZCARD', key)

        if count >= max_requests then
            return {0, count, redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]}
        end

        -- Add new entry with current timestamp as score
        redis.call('ZADD', key, now, member)
        redis.call('EXPIRE', key, expire_seconds)

        return {1, count + 1, 0}
    `)

    member := fmt.Sprintf("%d-%s", now.UnixNano(), key)
    expireSeconds := int64(r.windowSize.Seconds()) + 1

    result, err := script.Run(ctx, r.client,
        []string{redisKey},
        now.UnixMilli(),
        windowStart.UnixMilli(),
        r.maxRequests,
        member,
        expireSeconds,
    ).Int64Slice()

    if err != nil {
        return false, fmt.Errorf("rate limit redis error for key %s: %w", key, err)
    }

    return result[0] == 1, nil
}

// AllowWithInfo returns detailed rate limit information
type RateLimitInfo struct {
    Allowed    bool
    Count      int64
    Limit      int64
    Remaining  int64
    RetryAfter time.Duration
    ResetAt    time.Time
}

func (r *RedisRateLimiter) AllowWithInfo(ctx context.Context, key string) (*RateLimitInfo, error) {
    now := time.Now()
    windowStart := now.Add(-r.windowSize)
    redisKey := fmt.Sprintf("%s:%s", r.keyPrefix, key)

    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local max_requests = tonumber(ARGV[3])
        local member = ARGV[4]
        local expire_seconds = tonumber(ARGV[5])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
        local count = redis.call('ZCARD', key)
        local oldest_score = 0

        if count >= max_requests then
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            if #oldest >= 2 then
                oldest_score = tonumber(oldest[2])
            end
            return {0, count, oldest_score}
        end

        redis.call('ZADD', key, now, member)
        redis.call('EXPIRE', key, expire_seconds)
        return {1, count + 1, 0}
    `)

    member := fmt.Sprintf("%d", now.UnixNano())
    expireSeconds := int64(r.windowSize.Seconds()) + 1

    result, err := script.Run(ctx, r.client,
        []string{redisKey},
        now.UnixMilli(),
        windowStart.UnixMilli(),
        r.maxRequests,
        member,
        expireSeconds,
    ).Int64Slice()

    if err != nil {
        return nil, fmt.Errorf("redis rate limit error: %w", err)
    }

    info := &RateLimitInfo{
        Allowed:   result[0] == 1,
        Count:     result[1],
        Limit:     r.maxRequests,
        Remaining: r.maxRequests - result[1],
        ResetAt:   now.Add(r.windowSize),
    }

    if !info.Allowed && result[2] > 0 {
        oldestMs := result[2]
        oldestTime := time.UnixMilli(oldestMs)
        info.RetryAfter = oldestTime.Add(r.windowSize).Sub(now)
        info.ResetAt = oldestTime.Add(r.windowSize)
    }

    if info.Remaining < 0 {
        info.Remaining = 0
    }

    return info, nil
}
```

### Token Bucket in Redis (Fixed Window Counter with Refill)

```go
package ratelimit

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisTokenBucket implements a token bucket using Redis
type RedisTokenBucket struct {
    client     *redis.Client
    capacity   int64
    refillRate float64  // tokens per second
    keyPrefix  string
}

func NewRedisTokenBucket(
    client *redis.Client,
    capacity int64,
    refillRate float64,
    keyPrefix string,
) *RedisTokenBucket {
    return &RedisTokenBucket{
        client:     client,
        capacity:   capacity,
        refillRate: refillRate,
        keyPrefix:  keyPrefix,
    }
}

// Allow checks if n tokens are available and consumes them atomically
func (b *RedisTokenBucket) Allow(ctx context.Context, key string, tokens int64) (bool, error) {
    now := time.Now().UnixMilli()
    redisKey := fmt.Sprintf("%s:%s", b.keyPrefix, key)

    script := redis.NewScript(`
        local key = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local requested = tonumber(ARGV[4])

        -- Get current state: {tokens, last_refill_time}
        local state = redis.call('HMGET', key, 'tokens', 'last_refill')
        local tokens = tonumber(state[1]) or capacity
        local last_refill = tonumber(state[2]) or now

        -- Calculate tokens to add based on elapsed time
        local elapsed_seconds = (now - last_refill) / 1000.0
        local new_tokens = math.min(capacity, tokens + elapsed_seconds * refill_rate)

        if new_tokens < requested then
            -- Update state with refilled tokens but don't consume
            redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
            redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) + 60)
            return {0, math.floor(new_tokens), math.ceil((requested - new_tokens) / refill_rate * 1000)}
        end

        -- Consume tokens
        new_tokens = new_tokens - requested
        redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
        redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) + 60)
        return {1, math.floor(new_tokens), 0}
    `)

    result, err := script.Run(ctx, b.client,
        []string{redisKey},
        b.capacity,
        b.refillRate,
        now,
        tokens,
    ).Int64Slice()

    if err != nil {
        return false, fmt.Errorf("token bucket redis error: %w", err)
    }

    return result[0] == 1, nil
}
```

## HTTP Middleware Integration

### Standard net/http Middleware

```go
package middleware

import (
    "context"
    "fmt"
    "log/slog"
    "net/http"
    "strconv"
    "time"

    "github.com/example/ratelimit"
)

// KeyExtractor defines how to extract the rate limit key from a request
type KeyExtractor func(r *http.Request) string

// ByIP extracts the client IP address
func ByIP(r *http.Request) string {
    ip := r.Header.Get("X-Real-IP")
    if ip == "" {
        ip = r.Header.Get("X-Forwarded-For")
    }
    if ip == "" {
        ip = r.RemoteAddr
    }
    return ip
}

// ByUserID extracts the authenticated user ID
func ByUserID(r *http.Request) string {
    if userID := r.Context().Value(contextKeyUserID); userID != nil {
        return fmt.Sprintf("user:%s", userID)
    }
    return ByIP(r)
}

// ByAPIKey extracts the API key from the Authorization header
func ByAPIKey(r *http.Request) string {
    if key := r.Header.Get("X-API-Key"); key != "" {
        return fmt.Sprintf("apikey:%s", key)
    }
    return ByIP(r)
}

type contextKey string
const contextKeyUserID contextKey = "user_id"

// RateLimitMiddleware wraps an HTTP handler with rate limiting
type RateLimitMiddleware struct {
    limiter      *ratelimit.RedisRateLimiter
    keyExtractor KeyExtractor
    logger       *slog.Logger
}

func NewRateLimitMiddleware(
    limiter *ratelimit.RedisRateLimiter,
    keyExtractor KeyExtractor,
    logger *slog.Logger,
) *RateLimitMiddleware {
    return &RateLimitMiddleware{
        limiter:      limiter,
        keyExtractor: keyExtractor,
        logger:       logger,
    }
}

func (m *RateLimitMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := m.keyExtractor(r)

        info, err := m.limiter.AllowWithInfo(r.Context(), key)
        if err != nil {
            m.logger.Error("rate limiter error",
                "key", key,
                "error", err,
                "path", r.URL.Path,
            )
            // Fail open on limiter errors to avoid blocking all traffic
            next.ServeHTTP(w, r)
            return
        }

        // Set standard rate limit response headers
        w.Header().Set("X-RateLimit-Limit", strconv.FormatInt(info.Limit, 10))
        w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(info.Remaining, 10))
        w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(info.ResetAt.Unix(), 10))

        if !info.Allowed {
            retryAfterSecs := int64(info.RetryAfter.Seconds()) + 1
            w.Header().Set("Retry-After", strconv.FormatInt(retryAfterSecs, 10))
            w.Header().Set("X-RateLimit-RetryAfter", strconv.FormatInt(retryAfterSecs, 10))

            m.logger.Warn("rate limit exceeded",
                "key", key,
                "count", info.Count,
                "limit", info.Limit,
                "path", r.URL.Path,
                "method", r.Method,
            )

            http.Error(w, `{"error":"rate limit exceeded","code":"RATE_LIMIT_EXCEEDED"}`,
                http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// TieredRateLimitMiddleware applies different limits based on user tier
type TieredRateLimitMiddleware struct {
    limiters     map[string]*ratelimit.RedisRateLimiter
    defaultTier  string
    tierResolver func(r *http.Request) string
    keyExtractor KeyExtractor
    logger       *slog.Logger
}

func NewTieredMiddleware(
    limiters map[string]*ratelimit.RedisRateLimiter,
    defaultTier string,
    tierResolver func(r *http.Request) string,
    keyExtractor KeyExtractor,
    logger *slog.Logger,
) *TieredRateLimitMiddleware {
    return &TieredRateLimitMiddleware{
        limiters:     limiters,
        defaultTier:  defaultTier,
        tierResolver: tierResolver,
        keyExtractor: keyExtractor,
        logger:       logger,
    }
}

func (m *TieredRateLimitMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tier := m.tierResolver(r)
        if tier == "" {
            tier = m.defaultTier
        }

        limiter, ok := m.limiters[tier]
        if !ok {
            limiter = m.limiters[m.defaultTier]
        }

        key := fmt.Sprintf("%s:%s", tier, m.keyExtractor(r))
        info, err := limiter.AllowWithInfo(r.Context(), key)
        if err != nil {
            m.logger.Error("tiered rate limiter error", "tier", tier, "error", err)
            next.ServeHTTP(w, r)
            return
        }

        w.Header().Set("X-RateLimit-Tier", tier)
        w.Header().Set("X-RateLimit-Limit", strconv.FormatInt(info.Limit, 10))
        w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(info.Remaining, 10))
        w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(info.ResetAt.Unix(), 10))

        if !info.Allowed {
            retryAfter := int64(info.RetryAfter.Seconds()) + 1
            w.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
            http.Error(w,
                fmt.Sprintf(`{"error":"rate limit exceeded","tier":"%s","code":"RATE_LIMIT_EXCEEDED"}`, tier),
                http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

### Wire Up the Middleware

```go
package main

import (
    "log/slog"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/example/ratelimit"
    "github.com/example/middleware"
)

func main() {
    redisClient := redis.NewClient(&redis.Options{
        Addr:     "redis-cluster.prod.svc.cluster.local:6379",
        Password: "",
        DB:       0,
        PoolSize: 100,
    })

    // Tiered limiters
    limiters := map[string]*ratelimit.RedisRateLimiter{
        "free": ratelimit.NewRedisRateLimiter(
            redisClient, time.Minute, 60, "rl:free",
        ),
        "pro": ratelimit.NewRedisRateLimiter(
            redisClient, time.Minute, 600, "rl:pro",
        ),
        "enterprise": ratelimit.NewRedisRateLimiter(
            redisClient, time.Minute, 6000, "rl:enterprise",
        ),
    }

    logger := slog.Default()

    tierResolver := func(r *http.Request) string {
        // Extract tier from JWT claims stored in context
        if claims := r.Context().Value("jwt_claims"); claims != nil {
            if m, ok := claims.(map[string]interface{}); ok {
                if tier, ok := m["tier"].(string); ok {
                    return tier
                }
            }
        }
        return "free"
    }

    rateLimitMiddleware := middleware.NewTieredMiddleware(
        limiters,
        "free",
        tierResolver,
        middleware.ByAPIKey,
        logger,
    )

    mux := http.NewServeMux()
    mux.HandleFunc("/api/v1/search", handleSearch)
    mux.HandleFunc("/api/v1/data", handleData)

    handler := rateLimitMiddleware.Handler(mux)

    if err := http.ListenAndServe(":8080", handler); err != nil {
        logger.Error("server error", "error", err)
    }
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte(`{"results":[]}`))
}

func handleData(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte(`{"data":[]}`))
}
```

## gRPC Interceptor Integration

### Unary Server Interceptor

```go
package grpcmiddleware

import (
    "context"
    "fmt"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"

    "github.com/example/ratelimit"
)

// RateLimitInterceptor provides gRPC unary server-side rate limiting
type RateLimitInterceptor struct {
    limiter      *ratelimit.RedisRateLimiter
    keyExtractor func(ctx context.Context, method string) string
}

func NewRateLimitInterceptor(
    limiter *ratelimit.RedisRateLimiter,
    keyExtractor func(ctx context.Context, method string) string,
) *RateLimitInterceptor {
    return &RateLimitInterceptor{
        limiter:      limiter,
        keyExtractor: keyExtractor,
    }
}

// UnaryServerInterceptor returns a gRPC unary interceptor
func (i *RateLimitInterceptor) UnaryServerInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        key := i.keyExtractor(ctx, info.FullMethod)

        rlInfo, err := i.limiter.AllowWithInfo(ctx, key)
        if err != nil {
            // Fail open: log and continue on limiter errors
            return handler(ctx, req)
        }

        // Set rate limit metadata in response
        header := metadata.Pairs(
            "x-ratelimit-limit", fmt.Sprintf("%d", rlInfo.Limit),
            "x-ratelimit-remaining", fmt.Sprintf("%d", rlInfo.Remaining),
            "x-ratelimit-reset", fmt.Sprintf("%d", rlInfo.ResetAt.Unix()),
        )
        grpc.SetHeader(ctx, header)

        if !rlInfo.Allowed {
            retryAfter := fmt.Sprintf("%.0f", rlInfo.RetryAfter.Seconds()+1)
            grpc.SetHeader(ctx, metadata.Pairs("retry-after", retryAfter))

            return nil, status.Errorf(
                codes.ResourceExhausted,
                "rate limit exceeded: retry after %s seconds",
                retryAfter,
            )
        }

        return handler(ctx, req)
    }
}

// StreamServerInterceptor returns a gRPC streaming interceptor
func (i *RateLimitInterceptor) StreamServerInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        key := i.keyExtractor(ss.Context(), info.FullMethod)

        rlInfo, err := i.limiter.AllowWithInfo(ss.Context(), key)
        if err != nil {
            return handler(srv, ss)
        }

        if !rlInfo.Allowed {
            return status.Errorf(
                codes.ResourceExhausted,
                "rate limit exceeded for method %s",
                info.FullMethod,
            )
        }

        return handler(srv, ss)
    }
}

// ExtractKeyFromMetadata extracts user ID from gRPC metadata
func ExtractKeyFromMetadata(ctx context.Context, method string) string {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return fmt.Sprintf("unknown:%s", method)
    }

    if userIDs := md.Get("x-user-id"); len(userIDs) > 0 {
        return fmt.Sprintf("user:%s:%s", userIDs[0], method)
    }

    if apiKeys := md.Get("x-api-key"); len(apiKeys) > 0 {
        return fmt.Sprintf("apikey:%s", apiKeys[0])
    }

    // Fall back to method-level limiting
    return fmt.Sprintf("method:%s", method)
}
```

### Registering gRPC Interceptors

```go
package main

import (
    "net"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/keepalive"
    "github.com/redis/go-redis/v9"
    "github.com/example/ratelimit"
    grpcmiddleware "github.com/example/grpcmiddleware"
    pb "github.com/example/proto"
)

func main() {
    redisClient := redis.NewClient(&redis.Options{
        Addr:     "redis-cluster.prod.svc.cluster.local:6379",
        PoolSize: 50,
    })

    limiter := ratelimit.NewRedisRateLimiter(
        redisClient,
        time.Minute,
        1000,
        "grpc:rl",
    )

    rlInterceptor := grpcmiddleware.NewRateLimitInterceptor(
        limiter,
        grpcmiddleware.ExtractKeyFromMetadata,
    )

    srv := grpc.NewServer(
        grpc.UnaryInterceptor(rlInterceptor.UnaryServerInterceptor()),
        grpc.StreamInterceptor(rlInterceptor.StreamServerInterceptor()),
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle: 5 * time.Minute,
            Timeout:           20 * time.Second,
        }),
    )

    pb.RegisterMyServiceServer(srv, &myServiceImpl{})

    lis, _ := net.Listen("tcp", ":50051")
    srv.Serve(lis)
}

type myServiceImpl struct {
    pb.UnimplementedMyServiceServer
}
```

## Admission Control Pattern

For resource-intensive operations, combine rate limiting with concurrency limiting using a semaphore:

```go
package admission

import (
    "context"
    "fmt"
    "time"
)

// Admission combines rate limiting with concurrency limiting
type Admission struct {
    semaphore chan struct{}
    timeout   time.Duration
}

func NewAdmission(maxConcurrent int, timeout time.Duration) *Admission {
    sem := make(chan struct{}, maxConcurrent)
    for i := 0; i < maxConcurrent; i++ {
        sem <- struct{}{}
    }
    return &Admission{
        semaphore: sem,
        timeout:   timeout,
    }
}

// Acquire attempts to acquire admission for processing
func (a *Admission) Acquire(ctx context.Context) (func(), error) {
    timeoutCtx, cancel := context.WithTimeout(ctx, a.timeout)
    defer cancel()

    select {
    case <-a.semaphore:
        release := func() {
            a.semaphore <- struct{}{}
        }
        return release, nil
    case <-timeoutCtx.Done():
        return nil, fmt.Errorf("admission timeout: too many concurrent requests")
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

// Available returns the number of available admission slots
func (a *Admission) Available() int {
    return len(a.semaphore)
}

// CombinedLimiter composes rate limiting and admission control
type CombinedLimiter struct {
    rateLimiter *RedisRateLimiter
    admission   *Admission
}

func NewCombinedLimiter(rl *RedisRateLimiter, maxConcurrent int, timeout time.Duration) *CombinedLimiter {
    return &CombinedLimiter{
        rateLimiter: rl,
        admission:   NewAdmission(maxConcurrent, timeout),
    }
}

func (c *CombinedLimiter) Acquire(ctx context.Context, key string) (func(), error) {
    info, err := c.rateLimiter.AllowWithInfo(ctx, key)
    if err != nil {
        return nil, fmt.Errorf("rate limit check failed: %w", err)
    }
    if !info.Allowed {
        return nil, fmt.Errorf("rate limit exceeded, retry after %v", info.RetryAfter)
    }

    release, err := c.admission.Acquire(ctx)
    if err != nil {
        return nil, fmt.Errorf("admission control rejected: %w", err)
    }

    return release, nil
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
    "github.com/example/ratelimit"
)

func setupTestRedis(t *testing.T) (*redis.Client, func()) {
    t.Helper()
    mr, err := miniredis.Run()
    if err != nil {
        t.Fatalf("starting miniredis: %v", err)
    }
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    return client, func() {
        client.Close()
        mr.Close()
    }
}

func TestRedisRateLimiterAllow(t *testing.T) {
    client, cleanup := setupTestRedis(t)
    defer cleanup()

    limiter := ratelimit.NewRedisRateLimiter(client, time.Minute, 5, "test")
    ctx := context.Background()

    // First 5 requests should be allowed
    for i := 0; i < 5; i++ {
        allowed, err := limiter.Allow(ctx, "user-1")
        if err != nil {
            t.Fatalf("unexpected error on request %d: %v", i+1, err)
        }
        if !allowed {
            t.Errorf("request %d should be allowed, got rejected", i+1)
        }
    }

    // 6th request should be rejected
    allowed, err := limiter.Allow(ctx, "user-1")
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if allowed {
        t.Error("6th request should be rejected")
    }
}

func TestRedisRateLimiterWindowExpiry(t *testing.T) {
    client, cleanup := setupTestRedis(t)
    defer cleanup()

    // Very short window for testing
    limiter := ratelimit.NewRedisRateLimiter(client, 100*time.Millisecond, 3, "test-expiry")
    ctx := context.Background()

    // Use up the limit
    for i := 0; i < 3; i++ {
        limiter.Allow(ctx, "user-2")
    }

    // Should be rejected now
    allowed, _ := limiter.Allow(ctx, "user-2")
    if allowed {
        t.Error("should be rate limited")
    }

    // Wait for window to expire
    time.Sleep(150 * time.Millisecond)

    // Should be allowed again
    allowed, err := limiter.Allow(ctx, "user-2")
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if !allowed {
        t.Error("should be allowed after window expiry")
    }
}

func TestSlidingWindowLimiter(t *testing.T) {
    sw := ratelimit.NewSlidingWindowLimiter(100*time.Millisecond, 3)

    // Allow 3 requests
    for i := 0; i < 3; i++ {
        if !sw.Allow() {
            t.Errorf("request %d should be allowed", i+1)
        }
    }

    // 4th should be rejected
    if sw.Allow() {
        t.Error("4th request should be rejected")
    }

    // Wait for window
    time.Sleep(120 * time.Millisecond)

    // Should be allowed again
    if !sw.Allow() {
        t.Error("should be allowed after window expiry")
    }
}
```

## Summary

Production rate limiting in Go requires selecting the right algorithm for each use case. The token bucket from `golang.org/x/time/rate` handles bursty in-process scenarios effectively. Redis-backed sliding window limiters provide consistent enforcement across all service instances in a distributed deployment. The per-user limiter pattern with tier-based configurations enables fine-grained quota enforcement at the individual customer level. HTTP and gRPC middleware wrappers surface rate limit state through standard headers, allowing clients to implement backoff and retry logic. The admission control pattern adds concurrency limits on top of rate limits for protecting compute-intensive endpoints from being overwhelmed during traffic bursts.
