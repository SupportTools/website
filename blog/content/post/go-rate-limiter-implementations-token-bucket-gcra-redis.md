---
title: "Go Rate Limiter Implementations: Token Bucket, Leaky Bucket, Sliding Window Log, GCRA, and Distributed Redis"
date: 2032-02-27T00:00:00-05:00
draft: false
tags: ["Go", "Rate Limiting", "Redis", "API", "Performance", "Distributed Systems"]
categories:
- Go
- API Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive Go implementation guide for five rate limiting algorithms: token bucket, leaky bucket, sliding window log, Generic Cell Rate Algorithm (GCRA), and distributed rate limiting with Redis."
more_link: "yes"
url: "/go-rate-limiter-implementations-token-bucket-gcra-redis/"
---

Rate limiting is a deceptively simple concept that hides significant implementation complexity. The choice of algorithm matters: token bucket allows bursting, leaky bucket enforces smooth output, sliding window log gives perfect accuracy at high memory cost, and GCRA provides the mathematical elegance of cell-rate algorithms without the memory overhead of maintaining per-request logs. In distributed systems, all of these algorithms need Redis-backed coordination or they become per-instance limits rather than global ones. This guide implements all five from scratch in Go with production-ready middleware.

<!--more-->

# Go Rate Limiter Implementations

## Foundational Interfaces

All implementations share a common interface, enabling transparent swapping between algorithms and single vs. distributed backends.

```go
// limiter/limiter.go
package limiter

import (
	"context"
	"time"
)

// Result holds the outcome of a rate limit check.
type Result struct {
	// Allowed indicates whether the request should proceed.
	Allowed bool
	// Limit is the configured rate limit.
	Limit int
	// Remaining is the number of requests left in the current window.
	Remaining int
	// ResetAt is when the limit resets.
	ResetAt time.Time
	// RetryAfter indicates when the client should retry (only set when Allowed=false).
	RetryAfter time.Duration
}

// Limiter is the interface all rate limiter implementations must satisfy.
type Limiter interface {
	// Allow checks if a request for the given key should be allowed.
	Allow(ctx context.Context, key string) (Result, error)
	// AllowN checks if n requests for the given key should be allowed.
	AllowN(ctx context.Context, key string, n int) (Result, error)
}

// Config holds common limiter configuration.
type Config struct {
	// Rate is the number of allowed requests per window.
	Rate int
	// Window is the time window for the rate.
	Window time.Duration
	// Burst allows exceeding Rate by this amount using accumulated tokens.
	Burst int
}
```

## Section 1: Token Bucket

The token bucket is the most common algorithm in production systems. Tokens accumulate at a fixed rate up to a maximum (the burst capacity). Each request consumes one token; requests are rejected when the bucket is empty.

```go
// limiter/tokenbucket.go
package limiter

import (
	"context"
	"sync"
	"time"
)

// TokenBucket implements a local in-memory token bucket rate limiter.
// It is safe for concurrent use.
type TokenBucket struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	rate     float64       // tokens per second
	capacity float64       // maximum burst size
	cleanup  *time.Ticker
}

type bucket struct {
	tokens    float64
	lastRefill time.Time
}

// NewTokenBucket creates a new token bucket limiter.
// rate: requests per second allowed.
// burst: maximum burst size (must be >= rate).
func NewTokenBucket(rate float64, burst float64) *TokenBucket {
	tb := &TokenBucket{
		buckets:  make(map[string]*bucket),
		rate:     rate,
		capacity: burst,
		cleanup:  time.NewTicker(5 * time.Minute),
	}
	go tb.runCleanup()
	return tb
}

func (tb *TokenBucket) Allow(ctx context.Context, key string) (Result, error) {
	return tb.AllowN(ctx, key, 1)
}

func (tb *TokenBucket) AllowN(ctx context.Context, key string, n int) (Result, error) {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	now := time.Now()
	b, ok := tb.buckets[key]
	if !ok {
		b = &bucket{tokens: tb.capacity, lastRefill: now}
		tb.buckets[key] = b
	}

	// Refill tokens based on elapsed time
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens = min(tb.capacity, b.tokens+elapsed*tb.rate)
	b.lastRefill = now

	result := Result{
		Limit: int(tb.capacity),
	}

	if b.tokens >= float64(n) {
		b.tokens -= float64(n)
		result.Allowed = true
		result.Remaining = int(b.tokens)
		// Reset time: when the bucket would be full again
		deficit := tb.capacity - b.tokens
		result.ResetAt = now.Add(time.Duration(deficit/tb.rate*float64(time.Second)))
	} else {
		result.Allowed = false
		result.Remaining = 0
		// Time until n tokens are available
		needed := float64(n) - b.tokens
		result.RetryAfter = time.Duration(needed / tb.rate * float64(time.Second))
		result.ResetAt = now.Add(result.RetryAfter)
	}

	return result, nil
}

func (tb *TokenBucket) runCleanup() {
	for range tb.cleanup.C {
		tb.mu.Lock()
		threshold := time.Now().Add(-10 * time.Minute)
		for key, b := range tb.buckets {
			if b.lastRefill.Before(threshold) {
				delete(tb.buckets, key)
			}
		}
		tb.mu.Unlock()
	}
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
```

## Section 2: Leaky Bucket

The leaky bucket enforces a constant output rate regardless of input burst patterns. It is preferred when the downstream system cannot handle bursts and you need strict throughput shaping.

```go
// limiter/leakybucket.go
package limiter

import (
	"context"
	"sync"
	"time"
)

// LeakyBucket rate limiter. Requests enter the "bucket" and leak out at
// a constant rate. If the bucket is full, requests are rejected.
type LeakyBucket struct {
	mu       sync.Mutex
	buckets  map[string]*leakyState
	rate     time.Duration // time between each request being processed
	capacity int           // maximum queue depth
}

type leakyState struct {
	queue    int
	lastLeak time.Time
}

func NewLeakyBucket(rate float64, capacity int) *LeakyBucket {
	return &LeakyBucket{
		buckets:  make(map[string]*leakyState),
		rate:     time.Duration(float64(time.Second) / rate),
		capacity: capacity,
	}
}

func (lb *LeakyBucket) Allow(ctx context.Context, key string) (Result, error) {
	return lb.AllowN(ctx, key, 1)
}

func (lb *LeakyBucket) AllowN(ctx context.Context, key string, n int) (Result, error) {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	now := time.Now()
	state, ok := lb.buckets[key]
	if !ok {
		state = &leakyState{queue: 0, lastLeak: now}
		lb.buckets[key] = state
	}

	// Leak: drain as many requests as time allows
	elapsed := now.Sub(state.lastLeak)
	leaked := int(elapsed / lb.rate)
	if leaked > 0 {
		state.queue -= leaked
		if state.queue < 0 {
			state.queue = 0
		}
		state.lastLeak = state.lastLeak.Add(time.Duration(leaked) * lb.rate)
	}

	result := Result{
		Limit: lb.capacity,
	}

	if state.queue+n <= lb.capacity {
		state.queue += n
		result.Allowed = true
		result.Remaining = lb.capacity - state.queue
		// When the queue will be empty
		result.ResetAt = state.lastLeak.Add(time.Duration(state.queue) * lb.rate)
	} else {
		result.Allowed = false
		result.Remaining = lb.capacity - state.queue
		// How long until there's space for n more
		spaceNeeded := state.queue + n - lb.capacity
		result.RetryAfter = time.Duration(spaceNeeded) * lb.rate
		result.ResetAt = now.Add(result.RetryAfter)
	}

	return result, nil
}
```

## Section 3: Sliding Window Log

The sliding window log is the most accurate algorithm. It records a timestamp for every request and counts how many fall within the sliding window. It is expensive in memory (O(rate) per key) but provides exact counts without the boundary artifacts of fixed windows.

```go
// limiter/slidingwindowlog.go
package limiter

import (
	"context"
	"sync"
	"time"
)

// SlidingWindowLog tracks exact request timestamps.
// Memory: O(rate * keys). Use only when exact accuracy is required.
type SlidingWindowLog struct {
	mu      sync.Mutex
	logs    map[string][]time.Time
	limit   int
	window  time.Duration
}

func NewSlidingWindowLog(limit int, window time.Duration) *SlidingWindowLog {
	return &SlidingWindowLog{
		logs:   make(map[string][]time.Time),
		limit:  limit,
		window: window,
	}
}

func (swl *SlidingWindowLog) Allow(ctx context.Context, key string) (Result, error) {
	return swl.AllowN(ctx, key, 1)
}

func (swl *SlidingWindowLog) AllowN(ctx context.Context, key string, n int) (Result, error) {
	swl.mu.Lock()
	defer swl.mu.Unlock()

	now := time.Now()
	windowStart := now.Add(-swl.window)

	log := swl.logs[key]

	// Evict timestamps outside the window
	valid := log[:0]
	for _, t := range log {
		if t.After(windowStart) {
			valid = append(valid, t)
		}
	}

	result := Result{
		Limit: swl.limit,
	}

	if len(valid)+n <= swl.limit {
		// Add n timestamps for this request
		for i := 0; i < n; i++ {
			valid = append(valid, now)
		}
		swl.logs[key] = valid
		result.Allowed = true
		result.Remaining = swl.limit - len(valid)
		if len(valid) > 0 {
			result.ResetAt = valid[0].Add(swl.window)
		} else {
			result.ResetAt = now.Add(swl.window)
		}
	} else {
		swl.logs[key] = valid
		result.Allowed = false
		result.Remaining = swl.limit - len(valid)
		// When the oldest entry expires, freeing space for this request
		needed := len(valid) + n - swl.limit
		if needed <= len(valid) {
			result.ResetAt = valid[needed-1].Add(swl.window)
			result.RetryAfter = time.Until(result.ResetAt)
		}
	}

	return result, nil
}
```

## Section 4: GCRA (Generic Cell Rate Algorithm)

GCRA is the most elegant algorithm for rate limiting. It reduces to a single comparison using a "virtual scheduling time" (TAT - Theoretical Arrival Time). It has O(1) memory per key and provides smooth rate enforcement identical to a leaky bucket but with a cleaner implementation.

```go
// limiter/gcra.go
package limiter

import (
	"context"
	"sync"
	"time"
)

// GCRA implements the Generic Cell Rate Algorithm.
// It provides the same behavior as a leaky bucket but with a simpler
// implementation and O(1) memory per key.
//
// rate: requests per second
// burst: number of requests that can exceed the rate (burst capacity - 1)
type GCRA struct {
	mu      sync.Mutex
	tats    map[string]time.Time // Theoretical Arrival Times
	emissionInterval time.Duration
	delay   time.Duration // burst tolerance
}

// NewGCRA creates a GCRA limiter.
// rate: requests per second
// burst: additional requests allowed above rate (set to 0 for strict rate limiting)
func NewGCRA(rate float64, burst int) *GCRA {
	// Emission interval: time between each "cell" being allowed
	ei := time.Duration(float64(time.Second) / rate)
	// Delay tolerance: allows `burst` additional requests
	delay := time.Duration(burst) * ei

	return &GCRA{
		tats:             make(map[string]time.Time),
		emissionInterval: ei,
		delay:            delay,
	}
}

func (g *GCRA) Allow(ctx context.Context, key string) (Result, error) {
	return g.AllowN(ctx, key, 1)
}

func (g *GCRA) AllowN(ctx context.Context, key string, n int) (Result, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()

	// TAT for the current key (defaults to now for new keys)
	tat, ok := g.tats[key]
	if !ok || tat.Before(now) {
		tat = now
	}

	// Time increment for n requests
	increment := time.Duration(n) * g.emissionInterval

	// New TAT after accepting n requests
	newTAT := tat.Add(increment)

	// Allowed window: newTAT must be within now + delay
	allowAt := newTAT.Add(-g.delay)

	result := Result{
		Limit: int(float64(time.Second) / float64(g.emissionInterval)),
	}

	if !allowAt.After(now) {
		// Request is allowed
		g.tats[key] = newTAT
		result.Allowed = true
		// Remaining tokens: how many more requests fit in the burst window
		remaining := int((now.Add(g.delay).Sub(newTAT)) / g.emissionInterval)
		if remaining < 0 {
			remaining = 0
		}
		result.Remaining = remaining
		result.ResetAt = newTAT
	} else {
		// Request is denied
		result.Allowed = false
		result.Remaining = 0
		result.RetryAfter = allowAt.Sub(now)
		result.ResetAt = allowAt
	}

	return result, nil
}
```

## Section 5: Distributed Rate Limiting with Redis

In-memory limiters are per-instance. To enforce limits globally across all application replicas, use Redis with Lua scripts for atomic operations.

### Redis Token Bucket

```go
// limiter/redis_tokenbucket.go
package limiter

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisTokenBucket implements a distributed token bucket backed by Redis.
// Uses a Lua script for atomic operations.
type RedisTokenBucket struct {
	client   redis.UniversalClient
	rate     float64
	capacity float64
	prefix   string
	script   *redis.Script
}

const tokenBucketLua = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])       -- tokens per second
local capacity = tonumber(ARGV[2])   -- max tokens
local now = tonumber(ARGV[3])        -- current time (milliseconds)
local requested = tonumber(ARGV[4])  -- tokens requested

-- Load current state
local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1]) or capacity
local last_refill = tonumber(data[2]) or now

-- Refill: add tokens for elapsed time
local elapsed = (now - last_refill) / 1000.0  -- convert to seconds
local new_tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
local remaining = 0
local retry_after = 0

if new_tokens >= requested then
    new_tokens = new_tokens - requested
    allowed = 1
    remaining = math.floor(new_tokens)
else
    -- Not enough tokens
    local needed = requested - new_tokens
    retry_after = math.ceil(needed / rate * 1000)  -- milliseconds
    remaining = 0
end

-- Store updated state (expire after capacity is refilled plus buffer)
local ttl = math.ceil(capacity / rate) + 60
redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
redis.call('EXPIRE', key, ttl)

return {allowed, remaining, retry_after}
`

func NewRedisTokenBucket(client redis.UniversalClient, rate, capacity float64, prefix string) *RedisTokenBucket {
	return &RedisTokenBucket{
		client:   client,
		rate:     rate,
		capacity: capacity,
		prefix:   prefix,
		script:   redis.NewScript(tokenBucketLua),
	}
}

func (r *RedisTokenBucket) key(k string) string {
	return fmt.Sprintf("%s:tb:%s", r.prefix, k)
}

func (r *RedisTokenBucket) Allow(ctx context.Context, key string) (Result, error) {
	return r.AllowN(ctx, key, 1)
}

func (r *RedisTokenBucket) AllowN(ctx context.Context, key string, n int) (Result, error) {
	now := time.Now().UnixMilli()

	vals, err := r.script.Run(ctx, r.client,
		[]string{r.key(key)},
		r.rate,
		r.capacity,
		now,
		n,
	).Int64Slice()
	if err != nil {
		return Result{}, fmt.Errorf("redis token bucket: %w", err)
	}

	allowed := vals[0] == 1
	remaining := int(vals[1])
	retryAfterMs := vals[2]

	result := Result{
		Allowed:   allowed,
		Limit:     int(r.capacity),
		Remaining: remaining,
	}

	if !allowed {
		result.RetryAfter = time.Duration(retryAfterMs) * time.Millisecond
		result.ResetAt = time.Now().Add(result.RetryAfter)
	} else {
		deficit := r.capacity - float64(remaining)
		result.ResetAt = time.Now().Add(time.Duration(deficit/r.rate*float64(time.Second)))
	}

	return result, nil
}
```

### Redis GCRA (Most Production-Recommended)

```go
// limiter/redis_gcra.go
package limiter

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisGCRA implements distributed GCRA using Redis.
// This is the recommended algorithm for API rate limiting in production.
type RedisGCRA struct {
	client           redis.UniversalClient
	emissionInterval time.Duration
	delay            time.Duration
	prefix           string
	script           *redis.Script
}

const gcraLua = `
local key = KEYS[1]
local emission_interval = tonumber(ARGV[1])  -- nanoseconds
local delay_tolerance = tonumber(ARGV[2])    -- nanoseconds
local now = tonumber(ARGV[3])                -- nanoseconds
local n = tonumber(ARGV[4])                  -- number of tokens

local tat_str = redis.call('GET', key)
local tat

if tat_str then
    tat = tonumber(tat_str)
    if tat < now then
        tat = now
    end
else
    tat = now
end

-- Increment for n tokens
local increment = emission_interval * n

-- New TAT after accepting n tokens
local new_tat = tat + increment

-- When the request is allowed (must be within burst window)
local allow_at = new_tat - delay_tolerance

local allowed = 0
local remaining = 0
local retry_after = 0
local reset_after = 0

if allow_at <= now then
    -- Allowed
    allowed = 1
    local remaining_delay = delay_tolerance - (new_tat - now)
    remaining = math.max(0, math.floor(remaining_delay / emission_interval))
    reset_after = new_tat - now
    -- Store new TAT with appropriate TTL
    local ttl_ms = math.ceil((new_tat - now + delay_tolerance) / 1000000)
    redis.call('SET', key, new_tat, 'PX', math.max(1, ttl_ms))
else
    -- Denied
    allowed = 0
    remaining = 0
    retry_after = allow_at - now
    reset_after = allow_at - now
end

return {allowed, remaining, retry_after, reset_after}
`

func NewRedisGCRA(client redis.UniversalClient, rate float64, burst int, prefix string) *RedisGCRA {
	ei := time.Duration(float64(time.Second) / rate)
	return &RedisGCRA{
		client:           client,
		emissionInterval: ei,
		delay:            time.Duration(burst) * ei,
		prefix:           prefix,
		script:           redis.NewScript(gcraLua),
	}
}

func (g *RedisGCRA) key(k string) string {
	return fmt.Sprintf("%s:gcra:%s", g.prefix, k)
}

func (g *RedisGCRA) Allow(ctx context.Context, key string) (Result, error) {
	return g.AllowN(ctx, key, 1)
}

func (g *RedisGCRA) AllowN(ctx context.Context, key string, n int) (Result, error) {
	now := time.Now().UnixNano()

	vals, err := g.script.Run(ctx, g.client,
		[]string{g.key(key)},
		g.emissionInterval.Nanoseconds(),
		g.delay.Nanoseconds(),
		now,
		n,
	).Int64Slice()
	if err != nil {
		// On Redis error, fail open (allow request) to avoid cascading failures
		return Result{Allowed: true, Remaining: -1}, fmt.Errorf("redis gcra: %w", err)
	}

	allowed := vals[0] == 1
	remaining := int(vals[1])
	retryAfterNs := vals[2]
	resetAfterNs := vals[3]

	return Result{
		Allowed:    allowed,
		Limit:      int(float64(time.Second) / float64(g.emissionInterval)),
		Remaining:  remaining,
		RetryAfter: time.Duration(retryAfterNs),
		ResetAt:    time.Now().Add(time.Duration(resetAfterNs)),
	}, nil
}
```

### Sliding Window Counter (Redis-Backed)

This is an approximation of sliding window that uses two fixed windows and a weighted sum - much more efficient than the full log.

```go
// limiter/redis_slidingwindow.go
package limiter

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisSlidingWindow implements an approximate sliding window using two
// Redis counters (current and previous window) with a weighted sum.
// Accuracy is ±(1 - windowPosition) * rate which is acceptable for most use cases.
type RedisSlidingWindow struct {
	client redis.UniversalClient
	limit  int
	window time.Duration
	prefix string
}

func NewRedisSlidingWindow(client redis.UniversalClient, limit int, window time.Duration, prefix string) *RedisSlidingWindow {
	return &RedisSlidingWindow{
		client: client,
		limit:  limit,
		window: window,
		prefix: prefix,
	}
}

func (r *RedisSlidingWindow) Allow(ctx context.Context, key string) (Result, error) {
	return r.AllowN(ctx, key, 1)
}

func (r *RedisSlidingWindow) AllowN(ctx context.Context, key string, n int) (Result, error) {
	now := time.Now()

	// Current and previous window keys
	windowSize := int64(r.window.Seconds())
	currentWindow := now.Unix() / windowSize
	previousWindow := currentWindow - 1

	currentKey := fmt.Sprintf("%s:sw:%s:%d", r.prefix, key, currentWindow)
	previousKey := fmt.Sprintf("%s:sw:%s:%d", r.prefix, key, previousWindow)

	pipe := r.client.Pipeline()
	currentCmd := pipe.Get(ctx, currentKey)
	previousCmd := pipe.Get(ctx, previousKey)
	_, err := pipe.Exec(ctx)
	if err != nil && err != redis.Nil {
		return Result{}, fmt.Errorf("redis sliding window: %w", err)
	}

	currentCount, _ := currentCmd.Int()
	previousCount, _ := previousCmd.Int()

	// Weight of previous window based on how far into current window we are
	positionInWindow := float64(now.Unix()%windowSize) / float64(windowSize)
	weightedPrevious := float64(previousCount) * (1.0 - positionInWindow)

	// Estimated total requests in the sliding window
	total := float64(currentCount) + weightedPrevious

	result := Result{
		Limit: r.limit,
	}

	if int(math.Ceil(total))+n <= r.limit {
		// Allow: increment current window counter
		pipe2 := r.client.Pipeline()
		pipe2.IncrBy(ctx, currentKey, int64(n))
		pipe2.Expire(ctx, currentKey, r.window*2)
		if _, err := pipe2.Exec(ctx); err != nil {
			return Result{}, fmt.Errorf("redis sliding window increment: %w", err)
		}

		result.Allowed = true
		result.Remaining = r.limit - int(math.Ceil(total)) - n
		// Reset at end of current window
		result.ResetAt = time.Unix((currentWindow+1)*windowSize, 0)
	} else {
		result.Allowed = false
		result.Remaining = r.limit - int(math.Ceil(total))
		if result.Remaining < 0 {
			result.Remaining = 0
		}
		result.ResetAt = time.Unix((currentWindow+1)*windowSize, 0)
		result.RetryAfter = time.Until(result.ResetAt)
	}

	return result, nil
}
```

## Section 6: HTTP Middleware

### Standard net/http Middleware

```go
// middleware/ratelimit.go
package middleware

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/example/api/limiter"
)

// KeyFunc extracts a rate limit key from a request.
type KeyFunc func(r *http.Request) string

// ByIP limits by client IP address.
func ByIP(r *http.Request) string {
	// Handle X-Forwarded-For from trusted proxies
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return "ip:" + xff[:indexOf(xff, ',')+1]
	}
	return "ip:" + r.RemoteAddr
}

// ByAPIKey limits by API key header.
func ByAPIKey(r *http.Request) string {
	key := r.Header.Get("X-API-Key")
	if key == "" {
		return ByIP(r)
	}
	return "apikey:" + key
}

// ByUser limits by authenticated user ID (from context).
func ByUser(r *http.Request) string {
	userID := r.Context().Value("user_id")
	if userID == nil {
		return ByIP(r)
	}
	return fmt.Sprintf("user:%v", userID)
}

// ByEndpoint combines user and endpoint for per-endpoint limits.
func ByEndpoint(r *http.Request) string {
	userID := r.Context().Value("user_id")
	return fmt.Sprintf("endpoint:%v:%s:%s", userID, r.Method, r.URL.Path)
}

type errorResponse struct {
	Error     string `json:"error"`
	Code      string `json:"code"`
	RetryAfter string `json:"retry_after,omitempty"`
}

// RateLimit returns middleware that enforces rate limits using the provided limiter.
func RateLimit(l limiter.Limiter, keyFn KeyFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFn(r)

			result, err := l.Allow(r.Context(), key)
			if err != nil {
				// Log error but fail open - don't reject requests due to limiter errors
				// In production, you'd log this error
				next.ServeHTTP(w, r)
				return
			}

			// Always set rate limit headers
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(result.Remaining))
			w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))

			if !result.Allowed {
				w.Header().Set("Retry-After", strconv.Itoa(int(result.RetryAfter.Seconds())))
				w.Header().Set("X-RateLimit-RetryAfter", strconv.Itoa(int(result.RetryAfter.Milliseconds())))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				json.NewEncoder(w).Encode(errorResponse{
					Error:      "rate limit exceeded",
					Code:       "RATE_LIMIT_EXCEEDED",
					RetryAfter: result.RetryAfter.String(),
				})
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func indexOf(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return len(s) - 1
}
```

### Layered Rate Limiting

Production APIs often need multiple layers of rate limiting simultaneously:

```go
// middleware/layered_ratelimit.go
package middleware

import (
	"net/http"

	"github.com/example/api/limiter"
)

// MultiLimit applies multiple rate limiters. The most restrictive applies.
type MultiLimit struct {
	layers []layer
}

type layer struct {
	limiter limiter.Limiter
	keyFn   KeyFunc
}

func NewMultiLimit() *MultiLimit {
	return &MultiLimit{}
}

func (m *MultiLimit) Add(l limiter.Limiter, keyFn KeyFunc) *MultiLimit {
	m.layers = append(m.layers, layer{limiter: l, keyFn: keyFn})
	return m
}

func (m *MultiLimit) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, l := range m.layers {
			key := l.keyFn(r)
			result, err := l.limiter.Allow(r.Context(), key)
			if err != nil {
				continue // fail open on error
			}
			if !result.Allowed {
				w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Limit))
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("Retry-After", strconv.Itoa(int(result.RetryAfter.Seconds())))
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
```

### Wiring It Together

```go
// main.go
package main

import (
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/example/api/limiter"
	"github.com/example/api/middleware"
)

func main() {
	rdb := redis.NewUniversalClient(&redis.UniversalOptions{
		Addrs: []string{
			"redis-0.redis.svc.cluster.local:6379",
			"redis-1.redis.svc.cluster.local:6379",
			"redis-2.redis.svc.cluster.local:6379",
		},
		Password: os.Getenv("REDIS_PASSWORD"),
	})

	// Global IP-based limit: 1000 req/min (GCRA, burst=50)
	globalLimiter := limiter.NewRedisGCRA(
		rdb,
		1000.0/60.0, // ~16.7 req/sec
		50,
		"ratelimit",
	)

	// Per-API-key limit: 100 req/sec (token bucket, burst=200)
	apiKeyLimiter := limiter.NewRedisTokenBucket(
		rdb,
		100,
		200,
		"ratelimit",
	)

	// Per-endpoint limit for expensive operations: 10 req/min
	searchLimiter := limiter.NewRedisSlidingWindow(
		rdb,
		10,
		time.Minute,
		"ratelimit",
	)

	mux := http.NewServeMux()

	// Apply layered limits to all routes
	globalMiddleware := middleware.NewMultiLimit().
		Add(globalLimiter, middleware.ByIP).
		Add(apiKeyLimiter, middleware.ByAPIKey)

	mux.Handle("/api/", globalMiddleware.Handler(apiHandler()))

	// Apply extra limit to expensive search endpoint
	mux.Handle("/api/v1/search", middleware.NewMultiLimit().
		Add(globalLimiter, middleware.ByIP).
		Add(apiKeyLimiter, middleware.ByAPIKey).
		Add(searchLimiter, middleware.ByUser).
		Handler(searchHandler()))

	http.ListenAndServe(":8080", mux)
}
```

## Section 7: Algorithm Comparison

| Algorithm | Burst Handling | Memory | Accuracy | Distribution | Use Case |
|-----------|---------------|--------|----------|--------------|----------|
| Token Bucket | Excellent | O(keys) | Good | Yes (Redis) | API gateways, user quotas |
| Leaky Bucket | None | O(keys) | Exact | Limited | Traffic shaping, queue smoothing |
| Sliding Window Log | N/A | O(keys * rate) | Perfect | Expensive | Compliance, audit trails |
| GCRA | Configurable | O(keys) | Excellent | Yes (Redis) | **Recommended default** |
| Sliding Window Counter | N/A | O(keys) | ~1-2% error | Yes (Redis) | High-scale approximate limits |

## Section 8: Testing Rate Limiters

```go
// limiter/gcra_test.go
package limiter_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/example/api/limiter"
)

func TestGCRARateLimit(t *testing.T) {
	// 5 req/sec, burst=2
	l := limiter.NewGCRA(5.0, 2)
	ctx := context.Background()

	// First 3 requests should be allowed (rate=5, burst=2, so 3 total)
	for i := 0; i < 3; i++ {
		result, err := l.Allow(ctx, "test-key")
		require.NoError(t, err)
		assert.True(t, result.Allowed, "request %d should be allowed", i+1)
	}

	// 4th request should be denied
	result, err := l.Allow(ctx, "test-key")
	require.NoError(t, err)
	assert.False(t, result.Allowed)
	assert.Greater(t, result.RetryAfter, time.Duration(0))

	// After waiting for the emission interval, one more request allowed
	time.Sleep(200 * time.Millisecond) // 1/5 sec
	result, err = l.Allow(ctx, "test-key")
	require.NoError(t, err)
	assert.True(t, result.Allowed)
}

func TestTokenBucketBurst(t *testing.T) {
	// 10 req/sec, burst=5
	l := limiter.NewTokenBucket(10.0, 5.0)
	ctx := context.Background()

	// Should allow burst of 5 immediately
	for i := 0; i < 5; i++ {
		result, _ := l.Allow(ctx, "burst-key")
		assert.True(t, result.Allowed, "burst request %d should be allowed", i+1)
	}

	// 6th should be denied
	result, _ := l.Allow(ctx, "burst-key")
	assert.False(t, result.Allowed)

	// Wait for one token to accumulate (100ms for 10 req/sec)
	time.Sleep(110 * time.Millisecond)
	result, _ = l.Allow(ctx, "burst-key")
	assert.True(t, result.Allowed)
}

func BenchmarkGCRA(b *testing.B) {
	l := limiter.NewGCRA(1000.0, 100)
	ctx := context.Background()

	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			l.Allow(ctx, fmt.Sprintf("key-%d", i%100))
			i++
		}
	})
}
```

## Conclusion

GCRA with Redis backing is the recommended default for production API rate limiting. It provides O(1) memory per key, exact rate enforcement without burst artifacts, atomic Redis operations via Lua scripts, and natural header support with Retry-After values. For simpler deployments or when Redis latency is unacceptable, the local token bucket implementation handles single-instance rate limiting with minimal overhead. The multi-layer middleware pattern combines global IP limits, per-key limits, and per-endpoint limits without complex conditional logic, keeping rate limit policy declarative and maintainable.
