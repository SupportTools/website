---
title: "Go Distributed Rate Limiting: Redis Lua, Sliding Window, and Token Bucket at Scale"
date: 2029-02-02T00:00:00-05:00
draft: false
tags: ["Go", "Redis", "Rate Limiting", "Distributed Systems", "Performance"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to implementing distributed rate limiting in Go using Redis Lua scripts, covering sliding window counters, token bucket algorithms, and production deployment patterns for high-traffic APIs."
more_link: "yes"
url: "/go-distributed-rate-limiting-redis-lua-sliding-window-token-bucket/"
---

Rate limiting is among the most deceptively complex problems in distributed systems. A naive per-instance counter works only in single-server deployments. Once horizontally scaled, requests distribute across instances and per-instance limits become meaningless — ten instances with a 100 req/s limit each effectively allow 1000 req/s. Distributed rate limiting requires coordinated state, and Redis — with its atomic Lua script execution — provides the fastest and most operationally simple coordination mechanism available.

This guide implements three production-ready rate limiting algorithms in Go: fixed window, sliding window log, and token bucket — all using Redis atomic operations with Lua scripts to eliminate race conditions across distributed instances.

<!--more-->

## Why Lua Scripts for Distributed Rate Limiting

Redis executes Lua scripts atomically. No other command can run between the first and last line of a Lua script on a given Redis instance. This atomicity eliminates the race condition that makes distributed rate limiting hard:

```
Time T0: Instance A reads counter = 99
Time T0: Instance B reads counter = 99
Time T1: Instance A writes counter = 100 (limit reached, deny)
Time T1: Instance B writes counter = 100 (also thinks limit reached, deny)
Time T2: Both clients were denied but counter is now 100 — correct
```

vs.

```
Time T0: Instance A reads counter = 99
Time T0: Instance B reads counter = 99
Time T1: Instance A writes counter = 100
Time T1: Instance B writes counter = 100
# Counter is 100 but TWO requests went through — race condition exploited
```

The Lua-based approach executes READ-EVALUATE-WRITE atomically, making it impossible for two concurrent callers to both see 99 and both increment to 100.

## Redis Client Setup

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisConfig struct {
	Addr            string
	Password        string
	DB              int
	PoolSize        int
	MinIdleConns    int
	MaxRetries      int
	DialTimeout     time.Duration
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	PoolTimeout     time.Duration
}

func DefaultRedisConfig(addr string) RedisConfig {
	return RedisConfig{
		Addr:         addr,
		DB:           0,
		PoolSize:     50,
		MinIdleConns: 10,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
		PoolTimeout:  4 * time.Second,
	}
}

func NewRedisClient(cfg RedisConfig) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		PoolSize:     cfg.PoolSize,
		MinIdleConns: cfg.MinIdleConns,
		MaxRetries:   cfg.MaxRetries,
		DialTimeout:  cfg.DialTimeout,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		PoolTimeout:  cfg.PoolTimeout,
	})
}

// Result holds the outcome of a rate limit check
type Result struct {
	Allowed    bool
	Limit      int64
	Remaining  int64
	ResetAt    time.Time
	RetryAfter time.Duration
}

func (r Result) Headers() map[string]string {
	return map[string]string{
		"X-RateLimit-Limit":     fmt.Sprintf("%d", r.Limit),
		"X-RateLimit-Remaining": fmt.Sprintf("%d", r.Remaining),
		"X-RateLimit-Reset":     fmt.Sprintf("%d", r.ResetAt.Unix()),
		"Retry-After":           fmt.Sprintf("%.0f", r.RetryAfter.Seconds()),
	}
}
```

## Fixed Window Counter

The simplest algorithm. Efficient but susceptible to boundary spikes: a client can make `2*limit` requests in a window by splitting them across the boundary (last second of window N and first second of window N+1).

```go
package ratelimit

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// fixedWindowScript atomically increments a counter within a time window.
// KEYS[1] = rate limit key (e.g., "rl:fixed:user:12345:2029020214")
// ARGV[1] = window size in seconds
// ARGV[2] = request limit
// Returns: {allowed (0|1), current_count, ttl_ms}
var fixedWindowScript = redis.NewScript(`
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local current = redis.call("INCR", key)

if current == 1 then
  redis.call("EXPIRE", key, window)
end

local ttl = redis.call("PTTL", key)

if current > limit then
  return {0, current, ttl}
end

return {1, current, ttl}
`)

type FixedWindowLimiter struct {
	client     *redis.Client
	keyPrefix  string
	limit      int64
	windowSize time.Duration
}

func NewFixedWindowLimiter(client *redis.Client, keyPrefix string, limit int64, window time.Duration) *FixedWindowLimiter {
	return &FixedWindowLimiter{
		client:     client,
		keyPrefix:  keyPrefix,
		limit:      limit,
		windowSize: window,
	}
}

func (l *FixedWindowLimiter) Allow(ctx context.Context, identifier string) (Result, error) {
	windowID := time.Now().Truncate(l.windowSize).Unix()
	key := fmt.Sprintf("%s:%s:%d", l.keyPrefix, identifier, windowID)

	windowSeconds := int64(l.windowSize.Seconds())
	result, err := fixedWindowScript.Run(ctx, l.client,
		[]string{key},
		windowSeconds,
		l.limit,
	).Int64Slice()
	if err != nil {
		// Fail open on Redis errors — do not block legitimate traffic
		return Result{Allowed: true, Limit: l.limit, Remaining: l.limit}, err
	}

	allowed := result[0] == 1
	current := result[1]
	ttlMs := result[2]

	remaining := l.limit - current
	if remaining < 0 {
		remaining = 0
	}

	resetAt := time.Now().Add(time.Duration(ttlMs) * time.Millisecond)
	var retryAfter time.Duration
	if !allowed {
		retryAfter = time.Duration(ttlMs) * time.Millisecond
	}

	return Result{
		Allowed:    allowed,
		Limit:      l.limit,
		Remaining:  remaining,
		ResetAt:    resetAt,
		RetryAfter: retryAfter,
	}, nil
}
```

## Sliding Window Log Algorithm

The sliding window log maintains a sorted set of request timestamps. It provides exact rate limiting without boundary spike vulnerabilities.

```go
// slidingWindowLogScript uses a sorted set to track request timestamps.
// KEYS[1] = sorted set key for request log
// ARGV[1] = current timestamp in milliseconds
// ARGV[2] = window size in milliseconds
// ARGV[3] = request limit
// ARGV[4] = unique request ID (prevents duplicate entries)
// Returns: {allowed (0|1), current_count, oldest_entry_age_ms}
var slidingWindowLogScript = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local request_id = ARGV[4]
local window_start = now - window_ms

-- Remove entries outside the window
redis.call("ZREMRANGEBYSCORE", key, "-inf", window_start)

-- Count entries in the current window
local count = redis.call("ZCARD", key)

if count >= limit then
  -- Get the oldest entry to calculate retry-after
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local oldest_score = oldest[2] and tonumber(oldest[2]) or now
  local wait_ms = (oldest_score + window_ms) - now
  return {0, count, wait_ms}
end

-- Add current request with its timestamp as score
redis.call("ZADD", key, now, request_id)

-- Set TTL on the key to auto-expire
redis.call("PEXPIRE", key, window_ms * 2)

return {1, count + 1, 0}
`)

type SlidingWindowLogLimiter struct {
	client    *redis.Client
	keyPrefix string
	limit     int64
	window    time.Duration
}

func NewSlidingWindowLogLimiter(client *redis.Client, keyPrefix string, limit int64, window time.Duration) *SlidingWindowLogLimiter {
	return &SlidingWindowLogLimiter{
		client:    client,
		keyPrefix: keyPrefix,
		limit:     limit,
		window:    window,
	}
}

func (l *SlidingWindowLogLimiter) Allow(ctx context.Context, identifier string) (Result, error) {
	key := fmt.Sprintf("%s:%s", l.keyPrefix, identifier)
	nowMs := time.Now().UnixMilli()
	windowMs := l.window.Milliseconds()
	requestID := fmt.Sprintf("%d-%d", nowMs, nowMs%10000) // pseudo-unique

	result, err := slidingWindowLogScript.Run(ctx, l.client,
		[]string{key},
		nowMs,
		windowMs,
		l.limit,
		requestID,
	).Int64Slice()
	if err != nil {
		return Result{Allowed: true, Limit: l.limit, Remaining: l.limit}, err
	}

	allowed := result[0] == 1
	count := result[1]
	retryAfterMs := result[2]

	remaining := l.limit - count
	if remaining < 0 {
		remaining = 0
	}

	return Result{
		Allowed:    allowed,
		Limit:      l.limit,
		Remaining:  remaining,
		ResetAt:    time.Now().Add(l.window),
		RetryAfter: time.Duration(retryAfterMs) * time.Millisecond,
	}, nil
}
```

## Sliding Window Counter (Approximate, Memory-Efficient)

The sliding window counter approximates the sliding window log using two fixed window buckets. It uses O(1) memory per key (vs O(window_size * rate) for the log) while being less precise.

```go
// slidingWindowCounterScript approximates sliding window using two counters.
// The current window count + (previous window count * overlap fraction).
// KEYS[1] = current window key
// KEYS[2] = previous window key
// ARGV[1] = current window size in seconds
// ARGV[2] = limit
// ARGV[3] = current timestamp (seconds)
// ARGV[4] = current window start (seconds)
// Returns: {allowed (0|1), approximate_count, ttl_ms}
var slidingWindowCounterScript = redis.NewScript(`
local curr_key = KEYS[1]
local prev_key = KEYS[2]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local curr_window_start = tonumber(ARGV[4])

-- Calculate overlap: how far into current window are we (0.0 to 1.0)
local elapsed = now - curr_window_start
local prev_weight = (window - elapsed) / window

-- Get counts
local curr_count = tonumber(redis.call("GET", curr_key) or "0")
local prev_count = tonumber(redis.call("GET", prev_key) or "0")

-- Approximate count using weighted previous window
local approx_count = curr_count + math.floor(prev_count * prev_weight)

if approx_count >= limit then
  local pttl = redis.call("PTTL", curr_key)
  if pttl < 0 then pttl = window * 1000 end
  return {0, approx_count, pttl}
end

-- Increment current window counter
local new_count = redis.call("INCR", curr_key)
if new_count == 1 then
  redis.call("EXPIRE", curr_key, window * 2)
end

local ttl = redis.call("PTTL", curr_key)
return {1, approx_count + 1, ttl}
`)

type SlidingWindowCounterLimiter struct {
	client    *redis.Client
	keyPrefix string
	limit     int64
	window    time.Duration
}

func NewSlidingWindowCounterLimiter(client *redis.Client, keyPrefix string, limit int64, window time.Duration) *SlidingWindowCounterLimiter {
	return &SlidingWindowCounterLimiter{
		client:    client,
		keyPrefix: keyPrefix,
		limit:     limit,
		window:    window,
	}
}

func (l *SlidingWindowCounterLimiter) Allow(ctx context.Context, identifier string) (Result, error) {
	windowSec := int64(l.window.Seconds())
	nowSec := time.Now().Unix()
	currWindowStart := nowSec - (nowSec % windowSec)
	prevWindowStart := currWindowStart - windowSec

	currKey := fmt.Sprintf("%s:%s:%d", l.keyPrefix, identifier, currWindowStart)
	prevKey := fmt.Sprintf("%s:%s:%d", l.keyPrefix, identifier, prevWindowStart)

	result, err := slidingWindowCounterScript.Run(ctx, l.client,
		[]string{currKey, prevKey},
		windowSec,
		l.limit,
		nowSec,
		currWindowStart,
	).Int64Slice()
	if err != nil {
		return Result{Allowed: true, Limit: l.limit, Remaining: l.limit}, err
	}

	allowed := result[0] == 1
	count := result[1]
	ttlMs := result[2]

	remaining := l.limit - count
	if remaining < 0 {
		remaining = 0
	}

	return Result{
		Allowed:    allowed,
		Limit:      l.limit,
		Remaining:  remaining,
		ResetAt:    time.Now().Add(time.Duration(ttlMs) * time.Millisecond),
		RetryAfter: func() time.Duration {
			if allowed {
				return 0
			}
			return time.Duration(ttlMs) * time.Millisecond
		}(),
	}, nil
}
```

## Token Bucket Algorithm

Token bucket is the algorithm of choice for burst-tolerant rate limiting. A bucket holds up to `capacity` tokens; tokens refill at `refillRate` per second. Each request consumes one token. A burst of `capacity` requests is allowed immediately, then requests are throttled to `refillRate` per second.

```go
// tokenBucketScript implements token bucket in Lua.
// KEYS[1] = token bucket key
// ARGV[1] = capacity (max tokens)
// ARGV[2] = refill rate (tokens per second, float)
// ARGV[3] = current timestamp in milliseconds
// ARGV[4] = tokens to consume (default 1)
// Returns: {allowed (0|1), tokens_remaining_float_as_int, ms_until_next_token}
var tokenBucketScript = redis.NewScript(`
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local now_ms = tonumber(ARGV[3])
local consume = tonumber(ARGV[4])

-- Load current state: {tokens, last_refill_ms}
local bucket = redis.call("HMGET", key, "tokens", "last_ms")
local tokens = tonumber(bucket[1])
local last_ms = tonumber(bucket[2])

if tokens == nil or last_ms == nil then
  -- First access: full bucket
  tokens = capacity
  last_ms = now_ms
end

-- Calculate tokens to add based on elapsed time
local elapsed_sec = (now_ms - last_ms) / 1000.0
local new_tokens = elapsed_sec * refill_rate
tokens = math.min(capacity, tokens + new_tokens)
last_ms = now_ms

-- Attempt to consume
if tokens < consume then
  -- Not enough tokens: calculate wait time
  local deficit = consume - tokens
  local wait_ms = math.ceil((deficit / refill_rate) * 1000)

  -- Save updated state (even on reject, to update last_ms)
  redis.call("HMSET", key, "tokens", tokens, "last_ms", last_ms)
  redis.call("PEXPIRE", key, math.ceil(capacity / refill_rate * 1000) * 2)

  return {0, math.floor(tokens * 100), wait_ms}
end

-- Consume tokens
tokens = tokens - consume
redis.call("HMSET", key, "tokens", tokens, "last_ms", last_ms)
redis.call("PEXPIRE", key, math.ceil(capacity / refill_rate * 1000) * 2)

return {1, math.floor(tokens * 100), 0}
`)

type TokenBucketLimiter struct {
	client     *redis.Client
	keyPrefix  string
	capacity   int64
	refillRate float64 // tokens per second
}

func NewTokenBucketLimiter(client *redis.Client, keyPrefix string, capacity int64, refillRate float64) *TokenBucketLimiter {
	return &TokenBucketLimiter{
		client:     client,
		keyPrefix:  keyPrefix,
		capacity:   capacity,
		refillRate: refillRate,
	}
}

func (l *TokenBucketLimiter) Allow(ctx context.Context, identifier string) (Result, error) {
	return l.AllowN(ctx, identifier, 1)
}

func (l *TokenBucketLimiter) AllowN(ctx context.Context, identifier string, tokens int64) (Result, error) {
	key := fmt.Sprintf("%s:%s", l.keyPrefix, identifier)
	nowMs := time.Now().UnixMilli()

	result, err := tokenBucketScript.Run(ctx, l.client,
		[]string{key},
		l.capacity,
		l.refillRate,
		nowMs,
		tokens,
	).Int64Slice()
	if err != nil {
		return Result{Allowed: true, Limit: l.capacity, Remaining: l.capacity}, err
	}

	allowed := result[0] == 1
	// tokens_remaining stored as float*100 to avoid Redis float precision issues
	remaining := result[1] / 100
	retryAfterMs := result[2]

	return Result{
		Allowed:    allowed,
		Limit:      l.capacity,
		Remaining:  remaining,
		ResetAt:    time.Now().Add(time.Duration(float64(l.capacity)/l.refillRate) * time.Second),
		RetryAfter: time.Duration(retryAfterMs) * time.Millisecond,
	}, nil
}
```

## HTTP Middleware Integration

```go
package middleware

import (
	"net/http"
	"strconv"

	"github.com/company/platform/ratelimit"
)

type RateLimitMiddleware struct {
	limiter    Limiter
	keyFunc    func(*http.Request) string
	onExceeded func(http.ResponseWriter, *http.Request, ratelimit.Result)
}

type Limiter interface {
	Allow(ctx interface{}, identifier string) (ratelimit.Result, error)
}

func NewRateLimitMiddleware(limiter *ratelimit.TokenBucketLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract identifier: prefer X-API-Key, fall back to IP
			identifier := r.Header.Get("X-API-Key")
			if identifier == "" {
				identifier = extractClientIP(r)
			}

			result, err := limiter.Allow(r.Context(), identifier)
			if err != nil {
				// Log the error but fail open — Redis unavailability should not block all traffic
				// In high-security contexts, consider failing closed instead
				next.ServeHTTP(w, r)
				return
			}

			// Always set rate limit headers
			w.Header().Set("X-RateLimit-Limit", strconv.FormatInt(result.Limit, 10))
			w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(result.Remaining, 10))
			w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))

			if !result.Allowed {
				w.Header().Set("Retry-After", strconv.FormatFloat(result.RetryAfter.Seconds(), 'f', 0, 64))
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func extractClientIP(r *http.Request) string {
	// Check forwarded headers (set by trusted reverse proxies only)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP (original client) from comma-separated list
		for i, c := range xff {
			if c == ',' {
				return xff[:i]
			}
		}
		return xff
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return xrip
	}
	// Fall back to RemoteAddr (strip port)
	host := r.RemoteAddr
	for i := len(host) - 1; i >= 0; i-- {
		if host[i] == ':' {
			return host[:i]
		}
	}
	return host
}
```

## Multi-Tier Rate Limiting

Production APIs often need multiple limits simultaneously: per-second burst, per-minute sustained, and per-day quota.

```go
type MultiTierLimiter struct {
	tiers []tierConfig
}

type tierConfig struct {
	name    string
	limiter interface {
		Allow(ctx context.Context, id string) (Result, error)
	}
}

func NewMultiTierLimiter(client *redis.Client, prefix string, cfg APITierConfig) *MultiTierLimiter {
	return &MultiTierLimiter{
		tiers: []tierConfig{
			{
				name:    "per-second",
				limiter: NewTokenBucketLimiter(client, prefix+":burst", cfg.BurstCapacity, float64(cfg.PerSecond)),
			},
			{
				name:    "per-minute",
				limiter: NewSlidingWindowCounterLimiter(client, prefix+":minute", cfg.PerMinute, time.Minute),
			},
			{
				name:    "per-day",
				limiter: NewFixedWindowLimiter(client, prefix+":day", cfg.PerDay, 24*time.Hour),
			},
		},
	}
}

type APITierConfig struct {
	BurstCapacity int64
	PerSecond     int64
	PerMinute     int64
	PerDay        int64
}

func (m *MultiTierLimiter) Allow(ctx context.Context, identifier string) (Result, string, error) {
	var worstResult Result
	limitingTier := ""

	for _, tier := range m.tiers {
		result, err := tier.limiter.Allow(ctx, identifier)
		if err != nil {
			// Skip tier on error — fail open
			continue
		}
		if !result.Allowed {
			return result, tier.name, nil
		}
		if worstResult.Remaining == 0 || result.Remaining < worstResult.Remaining {
			worstResult = result
			limitingTier = tier.name
		}
	}

	if worstResult.Limit == 0 {
		// All tiers errored — fail open
		return Result{Allowed: true}, "", nil
	}

	return worstResult, limitingTier, nil
}
```

## Kubernetes Deployment with Redis

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rate-limiter-api
  namespace: platform
spec:
  replicas: 5
  selector:
    matchLabels:
      app: rate-limiter-api
  template:
    metadata:
      labels:
        app: rate-limiter-api
    spec:
      containers:
        - name: api
          image: registry.company.com/platform/rate-limiter-api:2.1.0
          env:
            - name: REDIS_ADDR
              value: "redis-cluster.platform.svc.cluster.local:6379"
            - name: REDIS_POOL_SIZE
              value: "50"
            - name: REDIS_MIN_IDLE
              value: "10"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
---
# Redis cluster for rate limiting state
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
  namespace: platform
data:
  redis.conf: |
    maxmemory 2gb
    maxmemory-policy allkeys-lru
    hz 100
    activerehashing yes
    lazyfree-lazy-eviction yes
    lazyfree-lazy-expire yes
    tcp-backlog 511
    latency-monitor-threshold 10
    latency-tracking yes
    # Disable persistence for rate limiting (ephemeral state is acceptable)
    save ""
    appendonly no
```

## Benchmarking

```bash
# Load test the rate limiter
hey -n 100000 -c 500 \
  -H "X-API-Key: test-key-benchmark" \
  http://rate-limiter-api.platform.svc.cluster.local:8080/v1/check

# Expected: ~429s for requests exceeding limit, <1ms p50 for allowed requests

# Redis Lua script execution latency
redis-cli --latency-history -i 5 -h redis-cluster.platform.svc.cluster.local

# Monitor script execution
redis-cli -h redis-cluster.platform.svc.cluster.local \
  MONITOR | grep -i "evalsha\|eval"

# Check key distribution across cluster slots
redis-cli -h redis-cluster.platform.svc.cluster.local \
  cluster keyslot "rl:bucket:user:12345"
```

The token bucket algorithm provides the best user experience for bursty traffic patterns while the sliding window counter offers the most predictable, memory-efficient protection. For most production APIs, deploying both in a multi-tier configuration — token bucket for burst tolerance and sliding window counter for sustained rate enforcement — provides comprehensive protection while keeping Redis memory usage bounded.
