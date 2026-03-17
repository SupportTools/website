---
title: "Go Rate Limiting: Token Bucket, Leaky Bucket, and Sliding Window"
date: 2029-05-16T00:00:00-05:00
draft: false
tags: ["Go", "Rate Limiting", "Redis", "gRPC", "API", "Golang", "Performance"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production rate limiting in Go: golang.org/x/time/rate token bucket mechanics, custom sliding window implementation, distributed rate limiting with Redis for multi-instance deployments, and gRPC unary/streaming interceptors for service-level rate control."
more_link: "yes"
url: "/go-rate-limiting-token-bucket-leaky-bucket-sliding-window-guide/"
---

Rate limiting protects services from overload, enforces fair usage policies, and provides the defense-in-depth layer between misbehaving clients and your database. Most tutorials cover the happy path; production systems need graceful degradation, distributed coordination across instances, and accurate limit enforcement under concurrent load. This post covers all three major algorithms with Go implementations that hold up at production scale — from stdlib token bucket through custom sliding window to Redis-backed distributed limiting with gRPC interceptors.

<!--more-->

# Go Rate Limiting: Token Bucket, Leaky Bucket, and Sliding Window

## Section 1: Algorithm Comparison

Before implementation, understand what each algorithm actually guarantees:

| Algorithm | Burst Behavior | Memory | Distributed | Use Case |
|-----------|---------------|--------|-------------|---------|
| Token Bucket | Allows burst up to bucket size | O(1) | With Redis | API rate limits |
| Leaky Bucket | Smooths bursts (fixed output rate) | O(1) | With queue | Payment processing |
| Fixed Window | Allows 2x burst at boundaries | O(1) | Trivial | Simple quotas |
| Sliding Window Log | Precise, no boundary spikes | O(n) | With Redis sorted set | Per-user limits |
| Sliding Window Counter | Approximate, bounded memory | O(1) | With Redis | High-traffic APIs |

### The Boundary Problem with Fixed Windows

```
Fixed window (100 req/min):
  23:59:01 - 23:59:59: 100 requests (window fills)
  00:00:01 - 00:00:59: 100 requests (new window)

Result: 200 requests in 2 seconds at midnight — 2x your intended limit
```

This is why sliding window is preferable for strict rate limits.

## Section 2: Token Bucket with golang.org/x/time/rate

Go's official rate limiting package implements the token bucket algorithm. It's well-tested, goroutine-safe, and integrates cleanly with context cancellation.

```bash
go get golang.org/x/time/rate
```

### Basic Usage

```go
package main

import (
    "context"
    "fmt"
    "time"

    "golang.org/x/time/rate"
)

func main() {
    // Create a limiter: 10 requests/second, burst of 30
    // rate.Limit(10) = 10 tokens per second
    // burst 30 = maximum token accumulation
    limiter := rate.NewLimiter(rate.Limit(10), 30)

    // Every(d) creates a rate.Limit from a duration
    // rate.Every(100*time.Millisecond) = 10/s
    limiter2 := rate.NewLimiter(rate.Every(100*time.Millisecond), 30)
    _ = limiter2

    ctx := context.Background()

    for i := 0; i < 50; i++ {
        start := time.Now()
        // Wait blocks until the limiter permits one event
        if err := limiter.Wait(ctx); err != nil {
            fmt.Printf("Request %d: cancelled: %v\n", i, err)
            return
        }
        fmt.Printf("Request %d: allowed after %v\n", i, time.Since(start))
    }
}
```

### Allow, Reserve, and Wait

```go
// Three ways to use a limiter:

// 1. Allow: non-blocking check, returns bool
func tryRequest(limiter *rate.Limiter) {
    if limiter.Allow() {
        // Process immediately
        processRequest()
    } else {
        // Reject immediately (return 429)
        rejectRequest()
    }
}

// 2. Reserve: get a reservation, can cancel if not needed
func reserveRequest(ctx context.Context, limiter *rate.Limiter) error {
    r := limiter.Reserve()
    if !r.OK() {
        return fmt.Errorf("rate limit exceeded — would wait indefinitely")
    }

    delay := r.Delay()
    if delay > 5*time.Second {
        // Too long to wait, cancel the reservation
        r.Cancel()
        return fmt.Errorf("rate limit would require %v wait, rejecting", delay)
    }

    // Wait the required time
    timer := time.NewTimer(delay)
    defer timer.Stop()

    select {
    case <-timer.C:
        return nil
    case <-ctx.Done():
        r.Cancel()
        return ctx.Err()
    }
}

// 3. Wait: blocks until token available or context cancelled
func waitForToken(ctx context.Context, limiter *rate.Limiter) error {
    // This respects context cancellation and deadlines
    return limiter.Wait(ctx)
}
```

### Per-User Rate Limiting

```go
package ratelimit

import (
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type UserLimiter struct {
    limiters map[string]*userEntry
    mu       sync.Mutex
    rate     rate.Limit
    burst    int
    ttl      time.Duration
}

type userEntry struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

func NewUserLimiter(r rate.Limit, burst int, ttl time.Duration) *UserLimiter {
    ul := &UserLimiter{
        limiters: make(map[string]*userEntry),
        rate:     r,
        burst:    burst,
        ttl:      ttl,
    }
    go ul.cleanup()
    return ul
}

func (ul *UserLimiter) GetLimiter(userID string) *rate.Limiter {
    ul.mu.Lock()
    defer ul.mu.Unlock()

    entry, exists := ul.limiters[userID]
    if !exists {
        entry = &userEntry{
            limiter: rate.NewLimiter(ul.rate, ul.burst),
        }
        ul.limiters[userID] = entry
    }

    entry.lastSeen = time.Now()
    return entry.limiter
}

// cleanup removes stale limiters to prevent memory leak
func (ul *UserLimiter) cleanup() {
    ticker := time.NewTicker(ul.ttl / 2)
    defer ticker.Stop()

    for range ticker.C {
        ul.mu.Lock()
        cutoff := time.Now().Add(-ul.ttl)
        for userID, entry := range ul.limiters {
            if entry.lastSeen.Before(cutoff) {
                delete(ul.limiters, userID)
            }
        }
        ul.mu.Unlock()
    }
}

// HTTP middleware using per-user limiting
func (ul *UserLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        userID := extractUserID(r)
        limiter := ul.GetLimiter(userID)

        if !limiter.Allow() {
            w.Header().Set("X-RateLimit-Limit", "100")
            w.Header().Set("X-RateLimit-Remaining", "0")
            w.Header().Set("Retry-After", fmt.Sprintf("%.0f",
                limiter.Reserve().Delay().Seconds()))
            http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            return
        }

        // Add rate limit headers
        tokens := limiter.Tokens()
        w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", int(tokens)))

        next.ServeHTTP(w, r)
    })
}
```

### Multi-Tier Rate Limiting

```go
// Apply multiple rate limits simultaneously
type MultiLimiter struct {
    limiters []*rate.Limiter
}

func NewMultiLimiter(limiters ...*rate.Limiter) *MultiLimiter {
    return &MultiLimiter{limiters: limiters}
}

func (m *MultiLimiter) Allow() bool {
    for _, l := range m.limiters {
        if !l.Allow() {
            return false
        }
    }
    return true
}

func (m *MultiLimiter) Wait(ctx context.Context) error {
    for _, l := range m.limiters {
        if err := l.Wait(ctx); err != nil {
            return err
        }
    }
    return nil
}

// Usage: 1000 req/min AND 100 req/second
limiter := NewMultiLimiter(
    rate.NewLimiter(rate.Every(60*time.Second), 1000), // 1000/min
    rate.NewLimiter(rate.Limit(100), 100),             // 100/s burst 100
)
```

## Section 3: Leaky Bucket Implementation

The leaky bucket processes requests at a fixed rate, smoothing out bursts. Useful for preventing spiky traffic from overwhelming downstream services.

```go
package ratelimit

import (
    "context"
    "sync"
    "time"
)

// LeakyBucket implements a rate limiter that processes requests
// at a constant rate, queuing excess requests up to capacity.
type LeakyBucket struct {
    rate     time.Duration // Time between each request
    capacity int           // Maximum queue size
    queue    chan struct{}  // Request queue
    done     chan struct{}
    once     sync.Once
}

func NewLeakyBucket(rps int, capacity int) *LeakyBucket {
    lb := &LeakyBucket{
        rate:     time.Duration(float64(time.Second) / float64(rps)),
        capacity: capacity,
        queue:    make(chan struct{}, capacity),
        done:     make(chan struct{}),
    }
    lb.once.Do(lb.start)
    return lb
}

func (lb *LeakyBucket) start() {
    ticker := time.NewTicker(lb.rate)
    go func() {
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                // Drain one request from queue at the fixed rate
                select {
                case <-lb.queue:
                    // Request processed
                default:
                    // Queue empty, nothing to process
                }
            case <-lb.done:
                return
            }
        }
    }()
}

// TryAdd attempts to add a request to the queue.
// Returns false if the queue is full (leaky bucket is full).
func (lb *LeakyBucket) TryAdd() bool {
    select {
    case lb.queue <- struct{}{}:
        return true
    default:
        return false
    }
}

// Add adds a request to the queue, blocking until space is available
// or the context is cancelled.
func (lb *LeakyBucket) Add(ctx context.Context) error {
    select {
    case lb.queue <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Stop shuts down the leaky bucket
func (lb *LeakyBucket) Stop() {
    close(lb.done)
}
```

## Section 4: Sliding Window Implementation

### In-Memory Sliding Window Log

```go
package ratelimit

import (
    "container/ring"
    "sync"
    "time"
)

// SlidingWindowLog implements exact sliding window rate limiting.
// Stores the timestamp of each request within the window.
// Memory: O(requests_per_window)
type SlidingWindowLog struct {
    windowSize time.Duration
    limit      int
    mu         sync.Mutex
    timestamps []time.Time
}

func NewSlidingWindowLog(windowSize time.Duration, limit int) *SlidingWindowLog {
    return &SlidingWindowLog{
        windowSize: windowSize,
        limit:      limit,
        timestamps: make([]time.Time, 0, limit+1),
    }
}

func (s *SlidingWindowLog) Allow() bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-s.windowSize)

    // Remove timestamps outside the window
    i := 0
    for i < len(s.timestamps) && s.timestamps[i].Before(windowStart) {
        i++
    }
    s.timestamps = s.timestamps[i:]

    // Check if we're under the limit
    if len(s.timestamps) >= s.limit {
        return false
    }

    s.timestamps = append(s.timestamps, now)
    return true
}

func (s *SlidingWindowLog) Remaining() int {
    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-s.windowSize)

    count := 0
    for _, ts := range s.timestamps {
        if ts.After(windowStart) {
            count++
        }
    }

    remaining := s.limit - count
    if remaining < 0 {
        return 0
    }
    return remaining
}

// RetryAfter returns when the next request will be allowed
func (s *SlidingWindowLog) RetryAfter() time.Duration {
    s.mu.Lock()
    defer s.mu.Unlock()

    if len(s.timestamps) < s.limit {
        return 0
    }

    now := time.Now()
    windowStart := now.Add(-s.windowSize)

    // Find oldest timestamp in window
    for _, ts := range s.timestamps {
        if ts.After(windowStart) {
            return ts.Add(s.windowSize).Sub(now)
        }
    }
    return 0
}
```

### Sliding Window Counter (Memory-Efficient Approximation)

```go
// SlidingWindowCounter uses two fixed windows (current and previous)
// to approximate sliding window behavior with O(1) memory.
// Approximation: previous_requests * (1 - elapsed/windowSize) + current_requests
type SlidingWindowCounter struct {
    windowSize  time.Duration
    limit       int
    mu          sync.Mutex
    current     windowData
    previous    windowData
}

type windowData struct {
    count     int
    startTime time.Time
}

func NewSlidingWindowCounter(windowSize time.Duration, limit int) *SlidingWindowCounter {
    now := time.Now()
    return &SlidingWindowCounter{
        windowSize: windowSize,
        limit:      limit,
        current: windowData{
            startTime: now.Truncate(windowSize),
        },
        previous: windowData{
            startTime: now.Truncate(windowSize).Add(-windowSize),
        },
    }
}

func (s *SlidingWindowCounter) Allow() bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now()
    currentWindowStart := now.Truncate(s.windowSize)

    // Roll windows if needed
    if currentWindowStart.After(s.current.startTime) {
        if currentWindowStart.Equal(s.current.startTime.Add(s.windowSize)) {
            // One window has passed
            s.previous = s.current
        } else {
            // Multiple windows have passed — reset
            s.previous = windowData{startTime: currentWindowStart.Add(-s.windowSize)}
        }
        s.current = windowData{startTime: currentWindowStart}
    }

    // Calculate weighted count
    elapsed := now.Sub(s.current.startTime)
    weight := float64(s.windowSize-elapsed) / float64(s.windowSize)
    estimate := float64(s.previous.count)*weight + float64(s.current.count)

    if estimate >= float64(s.limit) {
        return false
    }

    s.current.count++
    return true
}
```

## Section 5: Distributed Rate Limiting with Redis

In-process limiters don't work when your service runs on multiple instances. Redis provides a shared counter with atomic operations for distributed rate limiting.

### Redis Sliding Window with Lua Script

```go
package ratelimit

import (
    "context"
    "crypto/sha256"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisRateLimiter implements distributed sliding window rate limiting
// using Redis sorted sets.
type RedisRateLimiter struct {
    client     *redis.Client
    windowSize time.Duration
    limit      int
    keyPrefix  string
    script     *redis.Script
}

// Lua script for atomic sliding window check-and-increment
var slidingWindowScript = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local unique_id = ARGV[4]

-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count current entries in window
local current = redis.call('ZCARD', key)

if current >= limit then
    -- Get time until oldest entry expires
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry_after = 0
    if #oldest > 0 then
        retry_after = math.ceil((tonumber(oldest[2]) + window - now) / 1000000)
    end
    return {0, current, retry_after}
end

-- Add new entry
redis.call('ZADD', key, now, unique_id)
redis.call('PEXPIRE', key, math.ceil(window / 1000000))

return {1, current + 1, 0}
`)

func NewRedisRateLimiter(client *redis.Client, windowSize time.Duration, limit int, keyPrefix string) *RedisRateLimiter {
    return &RedisRateLimiter{
        client:     client,
        windowSize: windowSize,
        limit:      limit,
        keyPrefix:  keyPrefix,
    }
}

type RateLimitResult struct {
    Allowed    bool
    Remaining  int
    RetryAfter time.Duration
    Total      int
}

func (r *RedisRateLimiter) Check(ctx context.Context, identifier string) (*RateLimitResult, error) {
    key := fmt.Sprintf("%s:%s", r.keyPrefix, identifier)
    now := time.Now().UnixNano()
    windowNs := r.windowSize.Nanoseconds()

    // Unique ID for this request (prevents duplicates in sorted set)
    uniqueID := fmt.Sprintf("%d-%x", now, sha256.Sum256([]byte(fmt.Sprintf("%d", now))))[:16]

    result, err := slidingWindowScript.Run(ctx, r.client,
        []string{key},
        now,
        windowNs,
        r.limit,
        uniqueID,
    ).Int64Slice()

    if err != nil {
        // On Redis error, fail open (allow request) to avoid cascading failures
        return &RateLimitResult{Allowed: true}, fmt.Errorf("redis error: %w", err)
    }

    allowed := result[0] == 1
    current := int(result[1])
    retryAfterMs := result[2]

    return &RateLimitResult{
        Allowed:    allowed,
        Remaining:  r.limit - current,
        RetryAfter: time.Duration(retryAfterMs) * time.Millisecond,
        Total:      r.limit,
    }, nil
}
```

### Redis Token Bucket

```go
// Lua script for atomic token bucket
var tokenBucketScript = redis.NewScript(`
local key = KEYS[1]
local rate = tonumber(ARGV[1])        -- tokens per second (as float)
local burst = tonumber(ARGV[2])       -- max bucket size
local now = tonumber(ARGV[3])         -- current time in microseconds
local requested = tonumber(ARGV[4])   -- tokens requested

local last_tokens = tonumber(redis.call('HGET', key, 'tokens'))
local last_refill = tonumber(redis.call('HGET', key, 'last_refill'))

if last_tokens == nil then
    last_tokens = burst
    last_refill = now
end

-- Calculate tokens to add since last refill
local elapsed = math.max(0, now - last_refill)
local new_tokens = math.min(burst, last_tokens + (rate * elapsed / 1000000))

if new_tokens >= requested then
    -- Grant the request
    redis.call('HSET', key, 'tokens', new_tokens - requested, 'last_refill', now)
    redis.call('EXPIRE', key, math.ceil(burst / rate) + 1)
    return {1, math.floor(new_tokens - requested)}
else
    -- Deny: not enough tokens
    redis.call('HSET', key, 'tokens', new_tokens, 'last_refill', now)
    redis.call('EXPIRE', key, math.ceil(burst / rate) + 1)
    -- Return time to wait in milliseconds
    local wait_ms = math.ceil((requested - new_tokens) / rate * 1000)
    return {0, math.floor(new_tokens), wait_ms}
end
`)

type RedisTokenBucket struct {
    client    *redis.Client
    rate      float64 // tokens per second
    burst     int
    keyPrefix string
}

func (r *RedisTokenBucket) Allow(ctx context.Context, key string) (bool, time.Duration, error) {
    fullKey := fmt.Sprintf("%s:%s", r.keyPrefix, key)
    now := time.Now().UnixMicro()

    result, err := tokenBucketScript.Run(ctx, r.client,
        []string{fullKey},
        r.rate,
        r.burst,
        now,
        1, // request 1 token
    ).Int64Slice()

    if err != nil {
        return true, 0, err // Fail open
    }

    allowed := result[0] == 1
    var retryAfter time.Duration
    if !allowed && len(result) >= 3 {
        retryAfter = time.Duration(result[2]) * time.Millisecond
    }

    return allowed, retryAfter, nil
}
```

### HTTP Middleware with Redis Rate Limiting

```go
func RedisRateLimitMiddleware(limiter *RedisRateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Choose identifier: user ID, API key, or IP
            identifier := getIdentifier(r)

            result, err := limiter.Check(r.Context(), identifier)
            if err != nil {
                // Log error but don't fail the request
                log.Printf("Rate limiter error: %v", err)
                next.ServeHTTP(w, r)
                return
            }

            // Set standard rate limit headers
            w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Total))
            w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(max(0, result.Remaining)))
            w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(
                time.Now().Add(limiter.windowSize).Unix(), 10))

            if !result.Allowed {
                w.Header().Set("Retry-After", strconv.Itoa(
                    int(result.RetryAfter.Seconds()+0.5)))
                w.Header().Set("X-RateLimit-Remaining", "0")
                http.Error(w, `{"error":"rate_limit_exceeded","message":"Too many requests"}`,
                    http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

func getIdentifier(r *http.Request) string {
    // Priority: API key > user ID > IP
    if key := r.Header.Get("X-API-Key"); key != "" {
        return "key:" + key
    }
    if userID := r.Header.Get("X-User-ID"); userID != "" {
        return "user:" + userID
    }
    // Fall back to IP (strip port)
    ip, _, _ := net.SplitHostPort(r.RemoteAddr)
    if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
        // Use first IP in X-Forwarded-For (closest to client)
        ip = strings.Split(forwarded, ",")[0]
        ip = strings.TrimSpace(ip)
    }
    return "ip:" + ip
}
```

## Section 6: gRPC Rate Limiting Interceptors

### Unary Interceptor

```go
package grpcratelimit

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

type GRPCRateLimiter interface {
    Allow(ctx context.Context, identifier string) (bool, error)
}

// UnaryServerInterceptor returns a gRPC unary interceptor that
// applies rate limiting based on the caller's identity.
func UnaryServerInterceptor(limiter GRPCRateLimiter) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        identifier := extractGRPCIdentifier(ctx, info.FullMethod)

        allowed, err := limiter.Allow(ctx, identifier)
        if err != nil {
            // Log but don't fail on limiter errors
            log.Printf("Rate limiter error for %s: %v", identifier, err)
        } else if !allowed {
            return nil, status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded for %s — please retry later",
                info.FullMethod)
        }

        return handler(ctx, req)
    }
}

// StreamServerInterceptor applies rate limiting to streaming RPCs
func StreamServerInterceptor(limiter GRPCRateLimiter) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        ctx := ss.Context()
        identifier := extractGRPCIdentifier(ctx, info.FullMethod)

        // Rate limit the stream establishment (not each message)
        allowed, err := limiter.Allow(ctx, identifier)
        if err != nil {
            log.Printf("Rate limiter error: %v", err)
        } else if !allowed {
            return status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded — stream rejected")
        }

        return handler(srv, ss)
    }
}

// Per-message stream interceptor wraps the stream to rate limit each message
type rateLimitedStream struct {
    grpc.ServerStream
    limiter    GRPCRateLimiter
    identifier string
}

func (s *rateLimitedStream) RecvMsg(m interface{}) error {
    allowed, err := s.limiter.Allow(s.Context(), s.identifier)
    if err != nil {
        log.Printf("Rate limiter error: %v", err)
    } else if !allowed {
        return status.Errorf(codes.ResourceExhausted,
            "message rate limit exceeded")
    }
    return s.ServerStream.RecvMsg(m)
}

func extractGRPCIdentifier(ctx context.Context, method string) string {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return "anonymous:" + method
    }

    // Check for API key in metadata
    if keys := md.Get("x-api-key"); len(keys) > 0 {
        return "key:" + keys[0]
    }

    // Check for user ID from JWT (after auth interceptor)
    if userIDs := md.Get("x-user-id"); len(userIDs) > 0 {
        return "user:" + userIDs[0] + ":" + method
    }

    return "anonymous:" + method
}

// Register with gRPC server
func NewRateLimitedServer(limiter GRPCRateLimiter) *grpc.Server {
    return grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            UnaryServerInterceptor(limiter),
        ),
        grpc.ChainStreamInterceptor(
            StreamServerInterceptor(limiter),
        ),
    )
}
```

### Per-Method Rate Limiting

```go
// Different limits per gRPC method
type MethodRateLimiter struct {
    limiters map[string]*RedisRateLimiter
    default_ *RedisRateLimiter
}

func NewMethodRateLimiter(client *redis.Client) *MethodRateLimiter {
    return &MethodRateLimiter{
        limiters: map[string]*RedisRateLimiter{
            "/api.UserService/GetUser": NewRedisRateLimiter(
                client, time.Second, 1000, "rl:getuser"),
            "/api.UserService/CreateUser": NewRedisRateLimiter(
                client, time.Minute, 10, "rl:createuser"),
            "/api.SearchService/Search": NewRedisRateLimiter(
                client, time.Second, 50, "rl:search"),
        },
        default_: NewRedisRateLimiter(
            client, time.Second, 100, "rl:default"),
    }
}

func (m *MethodRateLimiter) Allow(ctx context.Context, identifierWithMethod string) (bool, error) {
    // Parse "user:abc123:/api.UserService/GetUser" format
    parts := strings.SplitN(identifierWithMethod, ":", 3)
    method := ""
    identifier := identifierWithMethod
    if len(parts) == 3 {
        method = parts[2]
        identifier = parts[0] + ":" + parts[1]
    }

    limiter, ok := m.limiters[method]
    if !ok {
        limiter = m.default_
    }

    result, err := limiter.Check(ctx, identifier)
    if err != nil {
        return true, err
    }
    return result.Allowed, nil
}
```

## Section 7: Circuit Breaker Integration

Rate limiting and circuit breaking complement each other. Rate limiting protects against expected load; circuit breaking handles unexpected failures.

```go
package ratelimit

import (
    "context"
    "sync/atomic"
    "time"
)

type CircuitState int32

const (
    StateClosed CircuitState = iota   // Normal operation
    StateHalfOpen                      // Testing recovery
    StateOpen                          // Failing fast
)

type CircuitBreaker struct {
    state         atomic.Int32
    failures      atomic.Int64
    successes     atomic.Int64
    lastFailure   atomic.Int64
    threshold     int64
    timeout       time.Duration
    halfOpenLimit int64
}

func NewCircuitBreaker(threshold int64, timeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        threshold:     threshold,
        timeout:       timeout,
        halfOpenLimit: 5,
    }
}

func (cb *CircuitBreaker) Allow() bool {
    state := CircuitState(cb.state.Load())

    switch state {
    case StateClosed:
        return true

    case StateOpen:
        // Check if timeout has passed
        lastFailure := time.Unix(0, cb.lastFailure.Load())
        if time.Since(lastFailure) > cb.timeout {
            // Transition to half-open
            if cb.state.CompareAndSwap(int64(StateOpen), int64(StateHalfOpen)) {
                cb.successes.Store(0)
            }
            return true
        }
        return false

    case StateHalfOpen:
        return cb.successes.Load() < cb.halfOpenLimit
    }

    return true
}

func (cb *CircuitBreaker) RecordSuccess() {
    state := CircuitState(cb.state.Load())
    if state == StateHalfOpen {
        successes := cb.successes.Add(1)
        if successes >= cb.halfOpenLimit {
            // Close the circuit
            cb.state.Store(int64(StateClosed))
            cb.failures.Store(0)
        }
    }
}

func (cb *CircuitBreaker) RecordFailure() {
    cb.lastFailure.Store(time.Now().UnixNano())
    failures := cb.failures.Add(1)
    if failures >= cb.threshold {
        cb.state.Store(int64(StateOpen))
    }
}

// RateLimitedCircuitBreaker combines both patterns
type RateLimitedCircuitBreaker struct {
    limiter *rate.Limiter
    circuit *CircuitBreaker
}

func (r *RateLimitedCircuitBreaker) Allow(ctx context.Context) error {
    if !r.circuit.Allow() {
        return fmt.Errorf("circuit breaker open")
    }
    if !r.limiter.Allow() {
        return fmt.Errorf("rate limit exceeded")
    }
    return nil
}
```

## Section 8: Benchmarks

```go
package ratelimit_test

import (
    "testing"
    "time"

    "golang.org/x/time/rate"
)

func BenchmarkTokenBucket(b *testing.B) {
    limiter := rate.NewLimiter(rate.Limit(1e9), 1e9) // Effectively unlimited
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            limiter.Allow()
        }
    })
}
// Result: ~50ns per operation, ~20M ops/sec

func BenchmarkSlidingWindowLog(b *testing.B) {
    limiter := NewSlidingWindowLog(time.Minute, 1e9)
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            limiter.Allow()
        }
    })
}
// Result: ~200ns per operation (mutex contention), ~5M ops/sec

func BenchmarkSlidingWindowCounter(b *testing.B) {
    limiter := NewSlidingWindowCounter(time.Minute, 1e9)
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            limiter.Allow()
        }
    })
}
// Result: ~100ns per operation, ~10M ops/sec
```

The choice between these algorithms depends on your accuracy requirements, scale, and deployment topology. For single-instance services, `golang.org/x/time/rate` with per-user limiters handles most use cases with minimal overhead. For multi-instance services, the Redis sliding window provides accurate distributed limiting at the cost of a Redis round-trip (~1ms). The gRPC interceptors layer seamlessly over any of these backends, giving you rate limiting at the RPC level without polluting service handler code.
