---
title: "Rate Limiting in Go: Token Bucket, Sliding Window, and Distributed Limiting"
date: 2028-10-29T00:00:00-05:00
draft: false
tags: ["Go", "Rate Limiting", "Performance", "API", "Redis"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to rate limiting algorithms in Go including token bucket with x/time/rate, sliding window with Redis sorted sets, distributed Lua scripts, per-user limiting, HTTP middleware, and load testing rate limiters."
more_link: "yes"
url: "/go-rate-limiting-token-bucket-sliding-window-guide/"
---

Rate limiting protects services from overload and abuse. Without it, a single misbehaving client can saturate your API, degrade service for legitimate users, or trigger cascading failures downstream. Go provides a solid foundation with `golang.org/x/time/rate`, but production systems require distributed limiting across multiple pods and more sophisticated algorithms for accuracy. This guide implements every major algorithm from first principles and integrates them as HTTP middleware.

<!--more-->

# Rate Limiting in Go: Complete Implementation Guide

## Algorithm Overview

| Algorithm | Accuracy | Burst Handling | Distributed | Complexity |
|---|---|---|---|---|
| Token Bucket | High | Yes — burst on fill | Hard | Low |
| Leaky Bucket | Exact | No — drops burst | Hard | Low |
| Fixed Window | Low (boundary burst) | No | Easy (INCR+EXPIRE) | Very Low |
| Sliding Window Log | Exact | Yes | Medium | High memory |
| Sliding Window Counter | Near-exact | Yes | Medium | Low |

## Token Bucket with golang.org/x/time/rate

The standard library's `rate.Limiter` implements a token bucket. Tokens accumulate at `r` tokens per second up to `b` burst capacity.

```go
package ratelimit

import (
	"context"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// PerUserLimiter manages per-user rate limiters using a token bucket.
type PerUserLimiter struct {
	limiters map[string]*userLimiter
	mu       sync.RWMutex
	rate     rate.Limit   // tokens per second
	burst    int          // maximum burst size
	ttl      time.Duration
}

type userLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func NewPerUserLimiter(r rate.Limit, burst int, ttl time.Duration) *PerUserLimiter {
	l := &PerUserLimiter{
		limiters: make(map[string]*userLimiter),
		rate:     r,
		burst:    burst,
		ttl:      ttl,
	}
	// Clean up expired limiters periodically
	go l.cleanupLoop()
	return l
}

func (l *PerUserLimiter) GetLimiter(userID string) *rate.Limiter {
	l.mu.RLock()
	ul, ok := l.limiters[userID]
	l.mu.RUnlock()

	if ok {
		ul.lastSeen = time.Now()
		return ul.limiter
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	// Double-check after acquiring write lock
	if ul, ok = l.limiters[userID]; ok {
		ul.lastSeen = time.Now()
		return ul.limiter
	}
	newLimiter := rate.NewLimiter(l.rate, l.burst)
	l.limiters[userID] = &userLimiter{
		limiter:  newLimiter,
		lastSeen: time.Now(),
	}
	return newLimiter
}

func (l *PerUserLimiter) cleanupLoop() {
	ticker := time.NewTicker(l.ttl / 2)
	defer ticker.Stop()
	for range ticker.C {
		l.mu.Lock()
		for id, ul := range l.limiters {
			if time.Since(ul.lastSeen) > l.ttl {
				delete(l.limiters, id)
			}
		}
		l.mu.Unlock()
	}
}

// HTTPMiddleware creates a per-user rate-limiting middleware.
// userIDFromRequest extracts the user identifier (e.g., from JWT or IP).
func (l *PerUserLimiter) HTTPMiddleware(
	userIDFromRequest func(*http.Request) string,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userID := userIDFromRequest(r)
			limiter := l.GetLimiter(userID)

			if !limiter.Allow() {
				// Calculate when next token is available
				reservation := limiter.Reserve()
				delay := reservation.Delay()
				reservation.Cancel() // Don't actually consume a token

				w.Header().Set("X-RateLimit-Limit", formatLimit(l.rate))
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", formatReset(delay))
				w.Header().Set("Retry-After", formatSeconds(delay))
				http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
				return
			}

			// Add rate limit headers for successful requests
			tokens := limiter.Tokens()
			w.Header().Set("X-RateLimit-Limit", formatLimit(l.rate))
			w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%.0f", tokens))
			w.Header().Set("X-RateLimit-Reset", formatReset(0))

			next.ServeHTTP(w, r)
		})
	}
}

func formatLimit(r rate.Limit) string {
	return fmt.Sprintf("%.0f", float64(r))
}

func formatReset(delay time.Duration) string {
	return fmt.Sprintf("%d", time.Now().Add(delay).Unix())
}

func formatSeconds(d time.Duration) string {
	return fmt.Sprintf("%.0f", d.Seconds())
}
```

Usage:

```go
func main() {
	// 10 requests per second, burst of 20
	limiter := ratelimit.NewPerUserLimiter(10, 20, 10*time.Minute)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/data", dataHandler)

	// Apply rate limiting middleware
	handler := limiter.HTTPMiddleware(extractUserID)(mux)

	http.ListenAndServe(":8080", handler)
}

func extractUserID(r *http.Request) string {
	// Use X-Forwarded-For or JWT subject
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.Split(ip, ",")[0]
	}
	return r.RemoteAddr
}
```

## Sliding Window Counter Algorithm

The sliding window counter divides time into fixed windows but uses a weighted average to approximate a continuous sliding window. It avoids the burst problem of fixed windows at near zero memory cost.

```go
package ratelimit

import (
	"sync"
	"time"
)

// SlidingWindowCounter implements the sliding window counter algorithm.
// It uses two adjacent fixed windows and interpolates based on the current
// position within the current window.
type SlidingWindowCounter struct {
	mu          sync.Mutex
	windowSize  time.Duration
	limit       int

	currentCount   int
	previousCount  int
	currentWindow  time.Time
}

func NewSlidingWindowCounter(windowSize time.Duration, limit int) *SlidingWindowCounter {
	return &SlidingWindowCounter{
		windowSize:   windowSize,
		limit:        limit,
		currentWindow: time.Now().Truncate(windowSize),
	}
}

func (s *SlidingWindowCounter) Allow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	currentWindow := now.Truncate(s.windowSize)

	// Advance windows if necessary
	if currentWindow.After(s.currentWindow) {
		if currentWindow.Equal(s.currentWindow.Add(s.windowSize)) {
			// Advanced by exactly one window
			s.previousCount = s.currentCount
		} else {
			// Advanced by more than one window — previous data is too old
			s.previousCount = 0
		}
		s.currentCount = 0
		s.currentWindow = currentWindow
	}

	// Calculate weighted estimate:
	// previousWeight = fraction of previous window that overlaps current slide
	elapsed := now.Sub(s.currentWindow)
	previousWeight := 1.0 - (float64(elapsed) / float64(s.windowSize))

	estimatedCount := int(float64(s.previousCount)*previousWeight) + s.currentCount

	if estimatedCount >= s.limit {
		return false
	}

	s.currentCount++
	return true
}

// Remaining returns the estimated number of remaining requests.
func (s *SlidingWindowCounter) Remaining() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(s.currentWindow)
	previousWeight := 1.0 - (float64(elapsed) / float64(s.windowSize))
	estimated := int(float64(s.previousCount)*previousWeight) + s.currentCount

	remaining := s.limit - estimated
	if remaining < 0 {
		return 0
	}
	return remaining
}
```

## Redis Fixed Window with INCR+EXPIRE

The simplest distributed rate limiter uses Redis INCR to count requests per window and EXPIRE to reset the counter.

```go
package ratelimit

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisFixedWindow implements a fixed window rate limiter backed by Redis.
type RedisFixedWindow struct {
	client     *redis.Client
	limit      int
	window     time.Duration
	keyPrefix  string
}

func NewRedisFixedWindow(client *redis.Client, limit int, window time.Duration, keyPrefix string) *RedisFixedWindow {
	return &RedisFixedWindow{
		client:    client,
		limit:     limit,
		window:    window,
		keyPrefix: keyPrefix,
	}
}

// Allow returns true if the request is within the rate limit.
func (r *RedisFixedWindow) Allow(ctx context.Context, identifier string) (bool, RateLimitInfo, error) {
	key := r.buildKey(identifier)

	pipe := r.client.Pipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, r.window)
	_, err := pipe.Exec(ctx)
	if err != nil {
		// On Redis failure, fail open (allow the request)
		return true, RateLimitInfo{}, fmt.Errorf("redis: %w", err)
	}

	count := int(incr.Val())
	remaining := r.limit - count
	if remaining < 0 {
		remaining = 0
	}

	info := RateLimitInfo{
		Limit:     r.limit,
		Remaining: remaining,
		Reset:     time.Now().Truncate(r.window).Add(r.window),
	}

	return count <= r.limit, info, nil
}

func (r *RedisFixedWindow) buildKey(identifier string) string {
	// Key includes the current window start time
	window := time.Now().Truncate(r.window).Unix()
	return fmt.Sprintf("%s:%s:%d", r.keyPrefix, identifier, window)
}

type RateLimitInfo struct {
	Limit     int
	Remaining int
	Reset     time.Time
}
```

## Redis Sliding Window with Sorted Sets

The sorted set approach stores timestamps as scores. It removes expired entries and counts remaining entries to determine if the request is allowed. This gives exact sliding window behavior.

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisSlidingWindow implements an exact sliding window using a Redis sorted set.
// Each entry stores the request timestamp as both score and member value.
type RedisSlidingWindow struct {
	client    *redis.Client
	limit     int
	window    time.Duration
	keyPrefix string
}

func NewRedisSlidingWindow(client *redis.Client, limit int, window time.Duration, keyPrefix string) *RedisSlidingWindow {
	return &RedisSlidingWindow{
		client:    client,
		limit:     limit,
		window:    window,
		keyPrefix: keyPrefix,
	}
}

// Allow performs an atomic check-and-increment using a Lua script.
// The Lua script ensures the ZREMRANGEBYSCORE, ZCARD, and ZADD operations
// are atomic with respect to concurrent requests.
var slidingWindowScript = redis.NewScript(`
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local unique_id = ARGV[4]

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

-- Count current entries
local count = redis.call('ZCARD', key)

if count >= limit then
  -- Rate limit exceeded
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_at = 0
  if #oldest > 0 then
    reset_at = tonumber(oldest[2]) + window
  end
  return {0, count, reset_at}
end

-- Add current request
redis.call('ZADD', key, now, unique_id)
redis.call('PEXPIRE', key, window)

return {1, count + 1, 0}
`)

func (r *RedisSlidingWindow) Allow(ctx context.Context, identifier string) (bool, RateLimitInfo, error) {
	key := fmt.Sprintf("%s:%s", r.keyPrefix, identifier)
	now := time.Now()
	windowMs := r.window.Milliseconds()
	nowMs := now.UnixMilli()
	uniqueID := fmt.Sprintf("%d-%d", nowMs, pseudoRand())

	result, err := slidingWindowScript.Run(ctx, r.client,
		[]string{key},
		windowMs,
		r.limit,
		nowMs,
		uniqueID,
	).Int64Slice()

	if err != nil {
		return true, RateLimitInfo{}, fmt.Errorf("redis sliding window: %w", err)
	}

	allowed := result[0] == 1
	count := int(result[1])
	resetMs := result[2]

	remaining := r.limit - count
	if remaining < 0 {
		remaining = 0
	}

	var resetTime time.Time
	if resetMs > 0 {
		resetTime = time.UnixMilli(resetMs)
	} else {
		resetTime = now.Add(r.window)
	}

	info := RateLimitInfo{
		Limit:     r.limit,
		Remaining: remaining,
		Reset:     resetTime,
	}

	return allowed, info, nil
}

var randMu sync.Mutex
var randState uint64

func pseudoRand() uint64 {
	randMu.Lock()
	randState++
	v := randState
	randMu.Unlock()
	return v
}
```

## Distributed Rate Limiting with Redis Lua Script

For high-throughput APIs, the above sorted set approach can become slow with millions of entries. A counter-based Lua script is faster while still being atomic.

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisTokenBucketScript implements a token bucket entirely in Redis Lua.
// This is atomic and handles distributed deployments correctly.
var tokenBucketScript = redis.NewScript(`
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per millisecond
local now = tonumber(ARGV[3])          -- current time in milliseconds
local requested = tonumber(ARGV[4])    -- tokens requested (usually 1)

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  last_refill = now
end

-- Refill tokens based on elapsed time
local elapsed = now - last_refill
local new_tokens = math.min(capacity, tokens + (elapsed * refill_rate))

if new_tokens < requested then
  -- Not enough tokens
  -- Calculate when enough tokens will be available
  local wait_ms = math.ceil((requested - new_tokens) / refill_rate)
  redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
  redis.call('PEXPIRE', key, math.ceil(capacity / refill_rate) * 1000)
  return {0, math.floor(new_tokens), wait_ms}
end

-- Consume tokens
new_tokens = new_tokens - requested
redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_rate) * 1000)

return {1, math.floor(new_tokens), 0}
`)

type RedisTokenBucket struct {
	client      *redis.Client
	capacity    float64
	refillRate  float64 // tokens per millisecond
	keyPrefix   string
}

// NewRedisTokenBucket creates a distributed token bucket.
// capacity: maximum tokens
// refillRate: tokens per second (converted to per millisecond internally)
func NewRedisTokenBucket(client *redis.Client, capacity float64, refillRate float64, keyPrefix string) *RedisTokenBucket {
	return &RedisTokenBucket{
		client:     client,
		capacity:   capacity,
		refillRate: refillRate / 1000.0, // convert to tokens/ms
		keyPrefix:  keyPrefix,
	}
}

func (r *RedisTokenBucket) Allow(ctx context.Context, identifier string) (bool, RateLimitInfo, error) {
	return r.AllowN(ctx, identifier, 1)
}

func (r *RedisTokenBucket) AllowN(ctx context.Context, identifier string, n int) (bool, RateLimitInfo, error) {
	key := fmt.Sprintf("%s:%s", r.keyPrefix, identifier)
	nowMs := time.Now().UnixMilli()

	result, err := tokenBucketScript.Run(ctx, r.client,
		[]string{key},
		r.capacity,
		r.refillRate,
		nowMs,
		n,
	).Int64Slice()

	if err != nil {
		return true, RateLimitInfo{}, fmt.Errorf("redis token bucket: %w", err)
	}

	allowed := result[0] == 1
	remaining := int(result[1])
	waitMs := result[2]

	resetTime := time.Now()
	if waitMs > 0 {
		resetTime = time.Now().Add(time.Duration(waitMs) * time.Millisecond)
	}

	info := RateLimitInfo{
		Limit:     int(r.capacity),
		Remaining: remaining,
		Reset:     resetTime,
	}

	return allowed, info, nil
}
```

## HTTP Middleware with Response Headers

RFC 6585 and the IETF draft for `RateLimit` headers define standard response headers:

```go
package middleware

import (
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// RateLimiter is the interface implemented by all limiter types.
type RateLimiter interface {
	Allow(ctx context.Context, identifier string) (bool, RateLimitInfo, error)
}

// RateLimitMiddleware creates a composable HTTP rate-limiting middleware.
func RateLimitMiddleware(
	limiter RateLimiter,
	identifierFn func(*http.Request) string,
	options ...MiddlewareOption,
) func(http.Handler) http.Handler {
	opts := &middlewareOptions{
		onLimitReached: defaultOnLimitReached,
		onError:        defaultOnError,
	}
	for _, o := range options {
		o(opts)
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := identifierFn(r)
			allowed, info, err := limiter.Allow(r.Context(), id)

			if err != nil {
				opts.onError(w, r, err)
				// Fail open by default — continue to the handler
				next.ServeHTTP(w, r)
				return
			}

			// Set standard rate limit headers
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(info.Limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(info.Remaining))
			w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(info.Reset.Unix(), 10))
			// Draft RFC headers
			w.Header().Set("RateLimit-Limit", fmt.Sprintf("%d", info.Limit))
			w.Header().Set("RateLimit-Remaining", fmt.Sprintf("%d", info.Remaining))
			w.Header().Set("RateLimit-Reset", fmt.Sprintf("%d", time.Until(info.Reset).Seconds()))

			if !allowed {
				opts.onLimitReached(w, r, info)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func defaultOnLimitReached(w http.ResponseWriter, r *http.Request, info RateLimitInfo) {
	retryAfter := time.Until(info.Reset)
	if retryAfter < 0 {
		retryAfter = 1 * time.Second
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", fmt.Sprintf("%.0f", retryAfter.Seconds()))
	w.WriteHeader(http.StatusTooManyRequests)
	fmt.Fprintf(w, `{"error":"rate_limit_exceeded","retry_after":%d}`,
		int(retryAfter.Seconds()))
}

func defaultOnError(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("rate limiter error: %v", err)
}

type middlewareOptions struct {
	onLimitReached func(http.ResponseWriter, *http.Request, RateLimitInfo)
	onError        func(http.ResponseWriter, *http.Request, error)
}

type MiddlewareOption func(*middlewareOptions)

func WithOnLimitReached(fn func(http.ResponseWriter, *http.Request, RateLimitInfo)) MiddlewareOption {
	return func(o *middlewareOptions) { o.onLimitReached = fn }
}
```

## Tiered Rate Limiting

Different user tiers get different limits:

```go
package middleware

// TieredLimiter applies different limits based on user tier.
type TieredLimiter struct {
	tiers map[string]RateLimiter
	def   RateLimiter
	getTier func(r *http.Request) string
}

func NewTieredLimiter(
	tiers map[string]RateLimiter,
	defaultLimiter RateLimiter,
	getTier func(*http.Request) string,
) *TieredLimiter {
	return &TieredLimiter{
		tiers:   tiers,
		def:     defaultLimiter,
		getTier: getTier,
	}
}

func (t *TieredLimiter) Allow(ctx context.Context, identifier string) (bool, RateLimitInfo, error) {
	// This requires the request to be accessible — use context values
	tier := ctx.Value(tierContextKey{}).(string)
	l, ok := t.tiers[tier]
	if !ok {
		l = t.def
	}
	return l.Allow(ctx, identifier)
}

// Example tier configuration
func setupTieredLimiter(redisClient *redis.Client) *TieredLimiter {
	return NewTieredLimiter(
		map[string]RateLimiter{
			"free":       NewRedisTokenBucket(redisClient, 100, 10, "rl:free"),     // 10 req/s
			"pro":        NewRedisTokenBucket(redisClient, 1000, 100, "rl:pro"),    // 100 req/s
			"enterprise": NewRedisTokenBucket(redisClient, 10000, 1000, "rl:ent"),  // 1000 req/s
		},
		NewRedisTokenBucket(redisClient, 10, 1, "rl:anon"), // anonymous: 1 req/s
		func(r *http.Request) string {
			// Extract tier from JWT claims stored in context
			claims, ok := r.Context().Value(jwtClaimsKey{}).(*Claims)
			if !ok {
				return "anonymous"
			}
			return claims.Tier
		},
	)
}
```

## Testing Rate Limiters Under Load

```go
package ratelimit_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSlidingWindowCounterConcurrent(t *testing.T) {
	const (
		limit      = 100
		window     = time.Second
		goroutines = 50
		requests   = 10 // each goroutine sends 10 requests
	)

	sw := NewSlidingWindowCounter(window, limit)

	var allowed, denied atomic.Int64
	var wg sync.WaitGroup

	start := make(chan struct{})
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			<-start // Wait for all goroutines to be ready
			for j := 0; j < requests; j++ {
				if sw.Allow() {
					allowed.Add(1)
				} else {
					denied.Add(1)
				}
			}
		}()
	}

	close(start) // Release all goroutines simultaneously
	wg.Wait()

	total := allowed.Load() + denied.Load()
	t.Logf("total=%d allowed=%d denied=%d", total, allowed.Load(), denied.Load())

	// Should have allowed approximately `limit` requests
	if allowed.Load() > int64(limit)+5 { // +5 for timing tolerance
		t.Errorf("allowed %d requests, expected <= %d", allowed.Load(), limit+5)
	}
}

func TestRedisTokenBucketRefill(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping Redis test in short mode")
	}

	client := redis.NewClient(&redis.Options{Addr: "localhost:6379", DB: 15})
	defer client.FlushDB(context.Background())

	limiter := NewRedisTokenBucket(client, 5, 5, "test")
	ctx := context.Background()

	// Exhaust the bucket
	for i := 0; i < 5; i++ {
		allowed, _, err := limiter.Allow(ctx, "user1")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Fatalf("expected request %d to be allowed", i+1)
		}
	}

	// 6th request should be denied
	allowed, _, err := limiter.Allow(ctx, "user1")
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Error("expected 6th request to be denied")
	}

	// Wait for token refill (5 tokens/second = 200ms per token)
	time.Sleep(250 * time.Millisecond)

	// Should have refilled at least 1 token
	allowed, _, err = limiter.Allow(ctx, "user1")
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Error("expected request after refill to be allowed")
	}
}

// BenchmarkLocalTokenBucket measures in-process limiter overhead
func BenchmarkLocalTokenBucket(b *testing.B) {
	limiter := NewPerUserLimiter(1000, 1000, 10*time.Minute)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			l := limiter.GetLimiter("user1")
			l.Allow()
		}
	})
}
```

## Prometheus Metrics for Rate Limiting

```go
package ratelimit

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	requestsAllowed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ratelimit_requests_allowed_total",
		Help: "Total rate-limited requests allowed.",
	}, []string{"tier", "endpoint"})

	requestsDenied = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ratelimit_requests_denied_total",
		Help: "Total rate-limited requests denied.",
	}, []string{"tier", "endpoint"})

	rateLimitLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "ratelimit_check_duration_seconds",
		Help:    "Time spent checking rate limit.",
		Buckets: []float64{0.0001, 0.001, 0.005, 0.01, 0.05},
	}, []string{"backend"})
)

// InstrumentedLimiter wraps a RateLimiter with Prometheus metrics.
type InstrumentedLimiter struct {
	inner   RateLimiter
	backend string
}

func NewInstrumentedLimiter(inner RateLimiter, backend string) *InstrumentedLimiter {
	return &InstrumentedLimiter{inner: inner, backend: backend}
}

func (l *InstrumentedLimiter) Allow(ctx context.Context, id string) (bool, RateLimitInfo, error) {
	start := time.Now()
	allowed, info, err := l.inner.Allow(ctx, id)
	rateLimitLatency.WithLabelValues(l.backend).Observe(time.Since(start).Seconds())
	return allowed, info, err
}
```

## Summary

Rate limiting in Go requires matching the algorithm to the deployment model:

- Use `golang.org/x/time/rate` for single-process, low-latency limiting with a clean API. The token bucket naturally handles burst.
- Use Redis sorted sets with a Lua script for exact sliding window limiting across multiple pods. The atomic Lua execution is critical for correctness.
- Use Redis INCR+EXPIRE for high-throughput fixed window limiting where boundary bursts are acceptable.
- Implement the Lua token bucket in Redis for distributed token bucket semantics with minimal storage.
- Always set standard `X-RateLimit-*` response headers and `Retry-After` so clients can back off correctly.
- Fail open when the rate limiting backend (Redis) is unavailable — denying all requests on limiter failure is worse than temporarily allowing them.
- Test with concurrent load to verify no races in custom implementations, and benchmark the Redis round-trip to ensure it does not dominate request latency.
