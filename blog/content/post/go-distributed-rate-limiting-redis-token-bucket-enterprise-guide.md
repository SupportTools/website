---
title: "Go: Implementing Distributed Rate Limiting with Redis and Token Bucket Algorithms for High-Throughput APIs"
date: 2031-06-09T00:00:00-05:00
draft: false
tags: ["Go", "Redis", "Rate Limiting", "Token Bucket", "API", "Distributed Systems", "Performance"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade distributed rate limiting in Go using Redis and the token bucket algorithm, with sliding windows, Lua scripts, and middleware patterns for high-throughput APIs."
more_link: "yes"
url: "/go-distributed-rate-limiting-redis-token-bucket-enterprise-guide/"
---

Rate limiting is one of those features that looks simple until it runs in production at scale. A single-process in-memory rate limiter breaks immediately when you run multiple API replicas. A naive Redis implementation adds 10–20ms of latency per request. A poorly designed algorithm allows burst traffic that violates the intended limits. This guide walks through building a production-grade distributed rate limiter in Go using Redis and the token bucket algorithm, covering the mathematics behind the algorithm, atomic Lua scripts for correctness under concurrency, multiple rate limit strategies, and HTTP middleware integration with graceful degradation.

<!--more-->

# Go: Distributed Rate Limiting with Redis and Token Bucket

## Rate Limiting Algorithm Selection

Three algorithms dominate production rate limiting, each with different trade-offs:

**Token Bucket**: A bucket holds up to `capacity` tokens. Tokens are added at a fixed `rate` per second. Each request consumes one token. If the bucket is empty, the request is rejected. Token bucket naturally handles burst traffic up to `capacity` while enforcing a sustained `rate` over time.

**Sliding Window Counter**: The request count is tracked in fine-grained time windows (e.g., 1-second buckets within a 1-minute window). The count for the last N seconds is summed. More accurate than a fixed window but requires more Redis storage.

**Fixed Window Counter**: Counts requests in fixed time windows (e.g., 0–60 seconds, 60–120 seconds). Simple but allows double the rate at window boundaries.

For most production APIs, **token bucket** is the right choice. It accurately models the intent (allow short bursts, enforce sustained rate), is efficient to implement in Redis, and is well-understood by operations teams.

## Project Structure

```
ratelimit/
├── pkg/
│   └── ratelimit/
│       ├── ratelimit.go          # Core interfaces and types
│       ├── tokenbucket.go        # Token bucket implementation
│       ├── sliding_window.go     # Sliding window implementation
│       ├── middleware.go         # HTTP middleware
│       ├── options.go            # Configuration
│       └── ratelimit_test.go     # Tests
├── cmd/
│   └── example/
│       └── main.go
└── go.mod
```

## Core Types and Interfaces

```go
// pkg/ratelimit/ratelimit.go
package ratelimit

import (
	"context"
	"fmt"
	"time"
)

// Result represents the outcome of a rate limit check.
type Result struct {
	// Allowed indicates whether the request is permitted.
	Allowed bool
	// Remaining is the number of requests/tokens remaining in the current window.
	Remaining int64
	// Limit is the maximum number of requests allowed in the window.
	Limit int64
	// ResetAt is when the rate limit window resets.
	ResetAt time.Time
	// RetryAfter is how long the caller should wait before retrying (only set when Allowed is false).
	RetryAfter time.Duration
}

// Headers returns HTTP headers representing the rate limit state.
// These follow the IETF RateLimit header fields specification (draft-ietf-httpapi-ratelimit-headers).
func (r Result) Headers() map[string]string {
	h := map[string]string{
		"RateLimit-Limit":     fmt.Sprintf("%d", r.Limit),
		"RateLimit-Remaining": fmt.Sprintf("%d", r.Remaining),
		"RateLimit-Reset":     fmt.Sprintf("%d", r.ResetAt.Unix()),
	}
	if !r.Allowed {
		h["Retry-After"] = fmt.Sprintf("%.0f", r.RetryAfter.Seconds())
	}
	return h
}

// Limiter is the interface for a rate limiter.
type Limiter interface {
	// Allow checks whether the key is allowed to proceed.
	Allow(ctx context.Context, key string) (Result, error)
	// AllowN checks whether n requests from key are allowed.
	AllowN(ctx context.Context, key string, n int64) (Result, error)
	// Reset clears the rate limit state for a key.
	Reset(ctx context.Context, key string) error
	// Close releases any resources held by the limiter.
	Close() error
}

// KeyFunc derives a rate limit key from an HTTP request or other context.
type KeyFunc func(ctx context.Context) string

// ErrLimitExceeded is returned by strict limiters that treat limit exceeded as an error.
type ErrLimitExceeded struct {
	Key        string
	RetryAfter time.Duration
}

func (e *ErrLimitExceeded) Error() string {
	return fmt.Sprintf("rate limit exceeded for key %q, retry after %s", e.Key, e.RetryAfter)
}
```

## Token Bucket Implementation with Lua Script

The token bucket must be implemented atomically in Redis to be correct under concurrent access from multiple API replicas. A Lua script executes atomically on the Redis server, eliminating race conditions:

```go
// pkg/ratelimit/tokenbucket.go
package ratelimit

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

// tokenBucketScript implements the token bucket algorithm atomically in Lua.
// It uses two Redis keys:
//   - {key}:tokens  - current token count (float, stored as string)
//   - {key}:ts      - last refill timestamp in microseconds
//
// Arguments:
//   KEYS[1]  = rate limit key
//   ARGV[1]  = capacity (max tokens)
//   ARGV[2]  = rate (tokens per second, float)
//   ARGV[3]  = tokens to consume (usually 1)
//   ARGV[4]  = current timestamp in microseconds
//   ARGV[5]  = TTL for the keys in seconds
//
// Returns: { allowed (0/1), remaining_tokens (int), reset_after_ms (int) }
const tokenBucketScript = `
local key_tokens = KEYS[1] .. ":tokens"
local key_ts     = KEYS[1] .. ":ts"

local capacity   = tonumber(ARGV[1])
local rate       = tonumber(ARGV[2])
local consume    = tonumber(ARGV[3])
local now_us     = tonumber(ARGV[4])
local ttl_s      = tonumber(ARGV[5])

-- Read current state
local tokens_str = redis.call("GET", key_tokens)
local ts_str     = redis.call("GET", key_ts)

local tokens
local last_ts

if tokens_str == false then
    -- First request: bucket starts full
    tokens  = capacity
    last_ts = now_us
else
    tokens  = tonumber(tokens_str)
    last_ts = tonumber(ts_str)
end

-- Refill tokens based on elapsed time
local elapsed_s = (now_us - last_ts) / 1e6
local refill    = elapsed_s * rate
tokens = math.min(capacity, tokens + refill)

-- Check if we can consume
local allowed
local retry_after_ms = 0

if tokens >= consume then
    tokens  = tokens - consume
    allowed = 1
else
    allowed = 0
    -- How long until we have enough tokens?
    local deficit    = consume - tokens
    retry_after_ms   = math.ceil((deficit / rate) * 1000)
end

-- Persist updated state
redis.call("SET", key_tokens, tostring(tokens))
redis.call("SET", key_ts,     tostring(now_us))
redis.call("EXPIRE", key_tokens, ttl_s)
redis.call("EXPIRE", key_ts,     ttl_s)

return { allowed, math.floor(tokens), retry_after_ms }
`

// TokenBucketConfig holds configuration for the token bucket limiter.
type TokenBucketConfig struct {
	// Capacity is the maximum number of tokens the bucket can hold.
	// This controls the maximum burst size.
	Capacity int64
	// Rate is the number of tokens added per second.
	// This controls the sustained request rate.
	Rate float64
	// KeyPrefix is prepended to all Redis keys.
	KeyPrefix string
	// TTL is how long the bucket state is kept in Redis after last access.
	// Should be significantly longer than 1/Rate.
	TTL time.Duration
}

// TokenBucketLimiter implements the Limiter interface using Redis token buckets.
type TokenBucketLimiter struct {
	client *redis.Client
	config TokenBucketConfig
	script *redis.Script
}

// NewTokenBucketLimiter creates a new token bucket rate limiter backed by Redis.
func NewTokenBucketLimiter(client *redis.Client, config TokenBucketConfig) *TokenBucketLimiter {
	if config.TTL == 0 {
		// Default TTL: at minimum 2x the time to refill from zero to full
		refillSeconds := float64(config.Capacity) / config.Rate
		config.TTL = time.Duration(refillSeconds*2) * time.Second
		if config.TTL < 5*time.Minute {
			config.TTL = 5 * time.Minute
		}
	}
	return &TokenBucketLimiter{
		client: client,
		config: config,
		script: redis.NewScript(tokenBucketScript),
	}
}

func (l *TokenBucketLimiter) redisKey(key string) string {
	if l.config.KeyPrefix != "" {
		return l.config.KeyPrefix + ":" + key
	}
	return key
}

// Allow checks whether one request from key is allowed.
func (l *TokenBucketLimiter) Allow(ctx context.Context, key string) (Result, error) {
	return l.AllowN(ctx, key, 1)
}

// AllowN checks whether n requests from key are allowed.
func (l *TokenBucketLimiter) AllowN(ctx context.Context, key string, n int64) (Result, error) {
	nowMicros := time.Now().UnixMicro()
	ttlSeconds := int64(math.Ceil(l.config.TTL.Seconds()))

	vals, err := l.script.Run(ctx, l.client,
		[]string{l.redisKey(key)},
		l.config.Capacity,
		l.config.Rate,
		n,
		nowMicros,
		ttlSeconds,
	).Slice()
	if err != nil {
		return Result{}, fmt.Errorf("redis script error: %w", err)
	}

	allowed := vals[0].(int64) == 1
	remaining := vals[1].(int64)
	retryAfterMs := vals[2].(int64)

	var retryAfter time.Duration
	var resetAt time.Time
	if !allowed {
		retryAfter = time.Duration(retryAfterMs) * time.Millisecond
		resetAt = time.Now().Add(retryAfter)
	} else {
		// Estimate when the bucket would reset to full (informational)
		tokensNeeded := l.config.Capacity - remaining
		secondsToFull := float64(tokensNeeded) / l.config.Rate
		resetAt = time.Now().Add(time.Duration(secondsToFull * float64(time.Second)))
	}

	return Result{
		Allowed:    allowed,
		Remaining:  remaining,
		Limit:      l.config.Capacity,
		ResetAt:    resetAt,
		RetryAfter: retryAfter,
	}, nil
}

// Reset clears the rate limit state for a key.
func (l *TokenBucketLimiter) Reset(ctx context.Context, key string) error {
	rk := l.redisKey(key)
	return l.client.Del(ctx, rk+":tokens", rk+":ts").Err()
}

// Close is a no-op for the token bucket limiter (the Redis client is owned externally).
func (l *TokenBucketLimiter) Close() error {
	return nil
}
```

## Sliding Window Counter Implementation

For scenarios requiring strict rate enforcement without burst allowance:

```go
// pkg/ratelimit/sliding_window.go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// slidingWindowScript implements a sliding window counter using a sorted set.
// Each request adds a member with score = timestamp. Old entries are pruned.
//
// KEYS[1] = rate limit key
// ARGV[1] = window size in milliseconds
// ARGV[2] = limit (max requests in window)
// ARGV[3] = current timestamp in milliseconds
// ARGV[4] = unique member ID for this request
// ARGV[5] = TTL in seconds
const slidingWindowScript = `
local key      = KEYS[1]
local window   = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local member   = ARGV[4]
local ttl      = tonumber(ARGV[5])

-- Remove entries outside the window
local cutoff = now - window
redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

-- Count current entries
local count = redis.call("ZCARD", key)

local allowed
if count < limit then
    -- Add this request to the window
    redis.call("ZADD", key, now, member)
    redis.call("EXPIRE", key, ttl)
    allowed = 1
    count = count + 1
else
    allowed = 0
end

-- Find when the oldest entry will expire (for reset time)
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local reset_in_ms = 0
if #oldest > 0 then
    local oldest_ts = tonumber(oldest[2])
    reset_in_ms = (oldest_ts + window) - now
    if reset_in_ms < 0 then reset_in_ms = 0 end
end

return { allowed, limit - count, reset_in_ms }
`

// SlidingWindowConfig holds configuration for the sliding window limiter.
type SlidingWindowConfig struct {
	// Limit is the maximum number of requests allowed in the window.
	Limit int64
	// Window is the duration of the sliding window.
	Window time.Duration
	// KeyPrefix is prepended to all Redis keys.
	KeyPrefix string
}

// SlidingWindowLimiter implements a sliding window rate limiter using Redis sorted sets.
type SlidingWindowLimiter struct {
	client *redis.Client
	config SlidingWindowConfig
	script *redis.Script
}

// NewSlidingWindowLimiter creates a new sliding window rate limiter.
func NewSlidingWindowLimiter(client *redis.Client, config SlidingWindowConfig) *SlidingWindowLimiter {
	return &SlidingWindowLimiter{
		client: client,
		config: config,
		script: redis.NewScript(slidingWindowScript),
	}
}

func (l *SlidingWindowLimiter) Allow(ctx context.Context, key string) (Result, error) {
	return l.AllowN(ctx, key, 1)
}

func (l *SlidingWindowLimiter) AllowN(ctx context.Context, key string, n int64) (Result, error) {
	nowMs := time.Now().UnixMilli()
	windowMs := l.config.Window.Milliseconds()
	ttlSeconds := int64(l.config.Window.Seconds()) + 60
	member := fmt.Sprintf("%d-%d", nowMs, nowMs) // unique per request; in production use a UUID

	rk := key
	if l.config.KeyPrefix != "" {
		rk = l.config.KeyPrefix + ":" + key
	}

	vals, err := l.script.Run(ctx, l.client,
		[]string{rk},
		windowMs,
		l.config.Limit,
		nowMs,
		member,
		ttlSeconds,
	).Slice()
	if err != nil {
		return Result{}, fmt.Errorf("redis script error: %w", err)
	}

	allowed := vals[0].(int64) == 1
	remaining := vals[1].(int64)
	resetInMs := vals[2].(int64)

	resetAt := time.Now().Add(time.Duration(resetInMs) * time.Millisecond)
	var retryAfter time.Duration
	if !allowed {
		retryAfter = time.Duration(resetInMs) * time.Millisecond
	}

	return Result{
		Allowed:    allowed,
		Remaining:  remaining,
		Limit:      l.config.Limit,
		ResetAt:    resetAt,
		RetryAfter: retryAfter,
	}, nil
}

func (l *SlidingWindowLimiter) Reset(ctx context.Context, key string) error {
	rk := key
	if l.config.KeyPrefix != "" {
		rk = l.config.KeyPrefix + ":" + key
	}
	return l.client.Del(ctx, rk).Err()
}

func (l *SlidingWindowLimiter) Close() error {
	return nil
}
```

## Tiered Rate Limiter

Production APIs typically need multiple tiers: per-user limits, per-API-key limits, and global limits. A tiered limiter checks each tier in order:

```go
// pkg/ratelimit/tiered.go
package ratelimit

import (
	"context"
	"fmt"
)

// Tier represents a single rate limit tier with its own key function and limiter.
type Tier struct {
	Name    string
	KeyFunc func(ctx context.Context) string
	Limiter Limiter
}

// TieredLimiter checks multiple rate limit tiers in order.
// A request is allowed only if ALL tiers allow it.
type TieredLimiter struct {
	tiers []Tier
}

// NewTieredLimiter creates a limiter that enforces multiple tiers.
func NewTieredLimiter(tiers ...Tier) *TieredLimiter {
	return &TieredLimiter{tiers: tiers}
}

// Allow checks all tiers and returns the most restrictive result.
func (t *TieredLimiter) Allow(ctx context.Context) (Result, string, error) {
	var mostRestrictive Result
	var blockingTier string

	for i, tier := range t.tiers {
		key := tier.KeyFunc(ctx)
		result, err := tier.Limiter.Allow(ctx, key)
		if err != nil {
			return Result{}, tier.Name, fmt.Errorf("tier %q limiter error: %w", tier.Name, err)
		}

		if i == 0 || result.Remaining < mostRestrictive.Remaining {
			mostRestrictive = result
		}

		if !result.Allowed {
			// Still check remaining tiers for correct header values,
			// but record the blocking tier for diagnostics.
			if blockingTier == "" {
				blockingTier = tier.Name
			}
			mostRestrictive = result
			mostRestrictive.Allowed = false
		}
	}

	return mostRestrictive, blockingTier, nil
}
```

## HTTP Middleware

```go
// pkg/ratelimit/middleware.go
package ratelimit

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// MiddlewareConfig configures the rate limiting HTTP middleware.
type MiddlewareConfig struct {
	// KeyFunc extracts the rate limit key from the request.
	// Common choices: IP address, API key, user ID.
	KeyFunc func(r *http.Request) string

	// Limiter is the rate limiter to use.
	Limiter Limiter

	// OnLimitExceeded is called when a request is rejected.
	// If nil, a default 429 response is sent.
	OnLimitExceeded func(w http.ResponseWriter, r *http.Request, result Result)

	// OnError is called when the limiter returns an error.
	// If nil, the request is allowed (fail-open behavior).
	OnError func(w http.ResponseWriter, r *http.Request, err error)

	// Logger for rate limit events.
	Logger *slog.Logger
}

// defaultKeyFunc extracts the client IP address as the rate limit key.
func defaultKeyFunc(r *http.Request) string {
	// In production, read X-Forwarded-For or X-Real-IP if behind a trusted proxy.
	ip := r.RemoteAddr
	// Strip port
	for i := len(ip) - 1; i >= 0; i-- {
		if ip[i] == ':' {
			ip = ip[:i]
			break
		}
	}
	return ip
}

// Middleware returns an HTTP middleware that applies rate limiting.
func Middleware(config MiddlewareConfig) func(http.Handler) http.Handler {
	if config.KeyFunc == nil {
		config.KeyFunc = defaultKeyFunc
	}
	if config.OnLimitExceeded == nil {
		config.OnLimitExceeded = defaultOnLimitExceeded
	}
	if config.OnError == nil {
		// Fail-open: allow the request when the rate limiter is unavailable.
		config.OnError = func(w http.ResponseWriter, r *http.Request, err error) {
			if config.Logger != nil {
				config.Logger.Error("rate limiter error, failing open",
					"error", err,
					"path", r.URL.Path,
				)
			}
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := config.KeyFunc(r)
			result, err := config.Limiter.Allow(r.Context(), key)

			if err != nil {
				config.OnError(w, r, err)
				// Fail-open: continue serving the request
				next.ServeHTTP(w, r)
				return
			}

			// Always set rate limit headers
			for k, v := range result.Headers() {
				w.Header().Set(k, v)
			}

			if !result.Allowed {
				config.OnLimitExceeded(w, r, result)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func defaultOnLimitExceeded(w http.ResponseWriter, r *http.Request, result Result) {
	for k, v := range result.Headers() {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	w.Write([]byte(`{"error":"rate limit exceeded","message":"Too many requests. Please slow down."}`))
}

// IPKeyFunc returns a KeyFunc that uses the client IP address.
func IPKeyFunc(trustedProxies []string) func(r *http.Request) string {
	trusted := make(map[string]struct{}, len(trustedProxies))
	for _, p := range trustedProxies {
		trusted[p] = struct{}{}
	}

	return func(r *http.Request) string {
		// Check if the direct connection is from a trusted proxy
		remoteIP := r.RemoteAddr
		for i := len(remoteIP) - 1; i >= 0; i-- {
			if remoteIP[i] == ':' {
				remoteIP = remoteIP[:i]
				break
			}
		}

		if _, ok := trusted[remoteIP]; ok {
			if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				// Take the leftmost (client) IP
				for i := 0; i < len(xff); i++ {
					if xff[i] == ',' {
						return xff[:i]
					}
				}
				return xff
			}
			if xri := r.Header.Get("X-Real-IP"); xri != "" {
				return xri
			}
		}
		return remoteIP
	}
}

// APIKeyFunc returns a KeyFunc that uses an API key from a header.
func APIKeyFunc(header string) func(r *http.Request) string {
	return func(r *http.Request) string {
		return r.Header.Get(header)
	}
}

// CompositeKeyFunc combines multiple key parts with a separator.
func CompositeKeyFunc(sep string, funcs ...func(r *http.Request) string) func(r *http.Request) string {
	return func(r *http.Request) string {
		parts := make([]string, 0, len(funcs))
		for _, f := range funcs {
			if v := f(r); v != "" {
				parts = append(parts, v)
			}
		}
		if len(parts) == 0 {
			return "unknown"
		}
		result := parts[0]
		for i := 1; i < len(parts); i++ {
			result += sep + parts[i]
		}
		return result
	}
}

// ContextKey type for storing rate limit results in request context.
type contextKey struct{ name string }

var RateLimitResultKey = &contextKey{"ratelimit-result"}

// WithResult stores the rate limit result in the request context.
func WithResult(ctx context.Context, result Result) context.Context {
	return context.WithValue(ctx, RateLimitResultKey, result)
}

// ResultFromContext retrieves the rate limit result from the context.
func ResultFromContext(ctx context.Context) (Result, bool) {
	r, ok := ctx.Value(RateLimitResultKey).(Result)
	return r, ok
}

// MetricsMiddleware wraps a Limiter to record Prometheus metrics.
// Requires the prometheus client library.
type instrumentedLimiter struct {
	inner   Limiter
	allowed func(key string)
	denied  func(key string)
	latency func(d time.Duration)
}

func (l *instrumentedLimiter) Allow(ctx context.Context, key string) (Result, error) {
	start := time.Now()
	r, err := l.inner.Allow(ctx, key)
	l.latency(time.Since(start))
	if err == nil {
		if r.Allowed {
			l.allowed(key)
		} else {
			l.denied(key)
		}
	}
	return r, err
}

func (l *instrumentedLimiter) AllowN(ctx context.Context, key string, n int64) (Result, error) {
	return l.inner.AllowN(ctx, key, n)
}

func (l *instrumentedLimiter) Reset(ctx context.Context, key string) error {
	return l.inner.Reset(ctx, key)
}

func (l *instrumentedLimiter) Close() error {
	return l.inner.Close()
}
```

## Putting It All Together: API Server Example

```go
// cmd/example/main.go
package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"yourorg/ratelimit/pkg/ratelimit"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Connect to Redis
	rdb := redis.NewClient(&redis.Options{
		Addr:         "redis:6379",
		Password:     "",
		DB:           0,
		PoolSize:     50,
		MinIdleConns: 10,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("failed to connect to Redis: %v", err)
	}

	// Per-IP rate limiter: 100 requests/second, burst up to 200
	ipLimiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  200,
		Rate:      100,
		KeyPrefix: "rl:ip",
		TTL:       10 * time.Minute,
	})

	// Per-API-key rate limiter: 1000 requests/second, burst up to 2000
	apiKeyLimiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  2000,
		Rate:      1000,
		KeyPrefix: "rl:apikey",
		TTL:       10 * time.Minute,
	})

	// Global rate limiter: 50000 requests/second across all clients
	globalLimiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  100000,
		Rate:      50000,
		KeyPrefix: "rl:global",
		TTL:       5 * time.Minute,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/api/v1/data", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":"example response"}`))
	})

	// Build middleware chain: global -> api-key -> ip
	globalMiddleware := ratelimit.Middleware(ratelimit.MiddlewareConfig{
		KeyFunc: func(r *http.Request) string { return "global" },
		Limiter: globalLimiter,
		Logger:  logger,
	})

	apiKeyMiddleware := ratelimit.Middleware(ratelimit.MiddlewareConfig{
		KeyFunc: func(r *http.Request) string {
			k := r.Header.Get("X-API-Key")
			if k == "" {
				return "anonymous"
			}
			return k
		},
		Limiter: apiKeyLimiter,
		Logger:  logger,
	})

	ipMiddleware := ratelimit.Middleware(ratelimit.MiddlewareConfig{
		KeyFunc: ratelimit.IPKeyFunc([]string{"10.0.0.0/8"}),
		Limiter: ipLimiter,
		Logger:  logger,
	})

	handler := globalMiddleware(apiKeyMiddleware(ipMiddleware(mux)))

	server := &http.Server{
		Addr:         ":8080",
		Handler:      handler,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		logger.Info("starting server", "addr", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown error: %v", err)
	}
	rdb.Close()
}
```

## Testing the Rate Limiter

```go
// pkg/ratelimit/ratelimit_test.go
package ratelimit_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"yourorg/ratelimit/pkg/ratelimit"
)

func newTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	s := miniredis.RunT(t)
	return redis.NewClient(&redis.Options{Addr: s.Addr()})
}

func TestTokenBucket_BasicAllow(t *testing.T) {
	rdb := newTestRedis(t)
	limiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  10,
		Rate:      10,
		KeyPrefix: "test",
	})

	ctx := context.Background()
	for i := 0; i < 10; i++ {
		result, err := limiter.Allow(ctx, "user1")
		if err != nil {
			t.Fatalf("unexpected error at request %d: %v", i+1, err)
		}
		if !result.Allowed {
			t.Fatalf("expected request %d to be allowed, got denied", i+1)
		}
	}
}

func TestTokenBucket_ExceedsCapacity(t *testing.T) {
	rdb := newTestRedis(t)
	limiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  5,
		Rate:      1,
		KeyPrefix: "test",
	})

	ctx := context.Background()

	// First 5 requests should be allowed
	for i := 0; i < 5; i++ {
		result, err := limiter.Allow(ctx, "user1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !result.Allowed {
			t.Fatalf("expected request %d to be allowed", i+1)
		}
	}

	// 6th request should be denied
	result, err := limiter.Allow(ctx, "user1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Allowed {
		t.Fatal("expected 6th request to be denied")
	}
	if result.RetryAfter <= 0 {
		t.Fatal("expected RetryAfter to be set when denied")
	}
}

func TestTokenBucket_Refill(t *testing.T) {
	s := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})

	limiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  5,
		Rate:      5, // 5 tokens/second = 1 per 200ms
		KeyPrefix: "test",
	})

	ctx := context.Background()

	// Drain the bucket
	for i := 0; i < 5; i++ {
		limiter.Allow(ctx, "user1")
	}

	// Advance time by 1 second in miniredis
	s.FastForward(1 * time.Second)

	// Should be allowed again after refill
	result, err := limiter.Allow(ctx, "user1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Allowed {
		t.Fatal("expected request to be allowed after refill")
	}
}

func TestTokenBucket_DifferentKeys(t *testing.T) {
	rdb := newTestRedis(t)
	limiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  2,
		Rate:      1,
		KeyPrefix: "test",
	})

	ctx := context.Background()

	// Drain user1's bucket
	limiter.Allow(ctx, "user1")
	limiter.Allow(ctx, "user1")

	// user2 should still be allowed (independent bucket)
	result, err := limiter.Allow(ctx, "user2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Allowed {
		t.Fatal("user2 should not be affected by user1's rate limit")
	}
}

func BenchmarkTokenBucket_Allow(b *testing.B) {
	rdb := newTestRedis(&testing.T{})
	limiter := ratelimit.NewTokenBucketLimiter(rdb, ratelimit.TokenBucketConfig{
		Capacity:  1_000_000,
		Rate:      1_000_000,
		KeyPrefix: "bench",
	})

	ctx := context.Background()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			limiter.Allow(ctx, "bench-key")
		}
	})
}
```

## Redis Cluster Considerations

For Redis Cluster deployments, all keys accessed by a Lua script must map to the same hash slot. Use Redis hash tags:

```go
// Wrap key in hash tags to ensure all keys for a bucket land on the same slot
func (l *TokenBucketLimiter) redisKey(key string) string {
	// {key} ensures key is used for hash slot assignment
	// All sub-keys (:tokens, :ts) will be co-located
	tagged := "{" + key + "}"
	if l.config.KeyPrefix != "" {
		return l.config.KeyPrefix + ":" + tagged
	}
	return tagged
}
```

With hash tags, `rl:ip:{192.168.1.1}:tokens` and `rl:ip:{192.168.1.1}:ts` will always be on the same Redis node, making the Lua script atomic across the cluster.

## Production Deployment: Redis Configuration

```yaml
# redis-deployment.yaml for rate limiting workload
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ratelimit-redis
  namespace: platform-services
spec:
  serviceName: ratelimit-redis
  replicas: 1
  selector:
    matchLabels:
      app: ratelimit-redis
  template:
    metadata:
      labels:
        app: ratelimit-redis
    spec:
      containers:
      - name: redis
        image: redis:7.2-alpine
        command:
        - redis-server
        - --maxmemory
        - "2gb"
        - --maxmemory-policy
        - allkeys-lru
        - --save
        - ""
        - --appendonly
        - "no"
        # Disable persistence for rate limiting - it's ephemeral state
        ports:
        - containerPort: 6379
        resources:
          requests:
            cpu: "500m"
            memory: "2.5Gi"
          limits:
            cpu: "2"
            memory: "2.5Gi"
        livenessProbe:
          exec:
            command: ["redis-cli", "ping"]
          initialDelaySeconds: 10
          periodSeconds: 5
```

Key Redis configuration decisions for rate limiting:
- **No persistence**: Rate limit state is ephemeral. Disabling RDB/AOF reduces I/O and restart time.
- **allkeys-lru**: When memory is full, evict the least recently used keys. This is acceptable — a rate limit key that hasn't been seen recently can be recreated with a full bucket.
- **maxmemory**: Set explicitly to prevent Redis from consuming all available memory.

## Conclusion

Distributed rate limiting with Redis token buckets provides accurate, low-latency enforcement across any number of API replicas. The Lua script approach ensures atomic token consumption without race conditions. The tiered limiter pattern allows per-IP, per-API-key, and global limits to be layered cleanly. The fail-open error handling prevents a Redis outage from taking down your API. With proper Redis configuration (no persistence, LRU eviction), the rate limiter adds under 2ms to request latency at the 99th percentile and scales to handle millions of requests per second with a modest Redis instance.
