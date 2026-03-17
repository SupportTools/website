---
title: "Caching Patterns in Go: Redis, In-Memory, and Cache-Aside Strategies"
date: 2028-03-24T00:00:00-05:00
draft: false
tags: ["Go", "Redis", "Caching", "Performance", "Distributed Systems", "Backend Engineering"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to caching patterns in Go covering cache-aside, read-through, and write-through strategies, Redis client with connection pooling, Redlock distributed locking, in-memory LRU with ristretto, singleflight cache stampede prevention, TTL management, and cache hit ratio monitoring."
more_link: "yes"
url: "/go-caching-patterns-redis-guide/"
---

Caching is one of the highest-leverage performance interventions available to backend engineers, but caching bugs—stampedes, inconsistent state, silent failures—are notoriously difficult to reproduce and diagnose. Production-grade caching requires deliberate patterns, not just adding a `redis.Get` call before a database query.

This guide covers the major caching patterns, Redis client configuration in Go, distributed locking with Redlock, in-memory caching with ristretto, cache stampede prevention with singleflight, invalidation strategies, and the monitoring required to make caching operationally safe.

<!--more-->

## Caching Pattern Overview

```
Pattern           | Read path         | Write path        | Best for
-----------------|-------------------|-------------------|---------------------------
Cache-Aside       | App reads cache,  | App writes DB,    | General purpose; app owns
                 | on miss reads DB  | then updates cache| consistency decisions
Read-Through      | Cache fetches DB  | App writes to     | Simplifies read code;
                 | on miss (loader)  | cache which syncs | cache is authoritative
Write-Through     | Cache serves reads| App writes cache, | Strong consistency needed;
                 |                   | cache writes DB   | read-after-write guarantees
Write-Behind      | Cache serves reads| App writes cache, | High write throughput;
                 |                   | async DB writes   | tolerates brief inconsistency
```

## Redis Client Setup with go-redis

```bash
go get github.com/redis/go-redis/v9@v9.5.1
go get github.com/dgraph-io/ristretto@v0.1.1
go get golang.org/x/sync@v0.6.0
```

### Connection Pool Configuration

```go
// internal/cache/redis.go
package cache

import (
	"context"
	"crypto/tls"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisConfig holds all Redis connection parameters.
type RedisConfig struct {
	Addresses    []string      // Single address or cluster addresses
	Password     string
	DB           int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	PoolSize     int           // Total connections in pool (default: 10 per CPU)
	MinIdleConns int           // Minimum idle connections to maintain
	MaxIdleTime  time.Duration // Evict idle connections after this duration
	TLSConfig    *tls.Config
}

func DefaultRedisConfig() RedisConfig {
	return RedisConfig{
		Addresses:    []string{"redis:6379"},
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     50,
		MinIdleConns: 10,
		MaxIdleTime:  5 * time.Minute,
	}
}

// NewRedisClient creates a properly configured Redis client.
// Use NewRedisClusterClient for Redis Cluster mode.
func NewRedisClient(cfg RedisConfig) (*redis.Client, error) {
	opts := &redis.Options{
		Addr:         cfg.Addresses[0],
		Password:     cfg.Password,
		DB:           cfg.DB,
		DialTimeout:  cfg.DialTimeout,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		PoolSize:     cfg.PoolSize,
		MinIdleConns: cfg.MinIdleConns,
		ConnMaxIdleTime: cfg.MaxIdleTime,
		TLSConfig:    cfg.TLSConfig,
		// Circuit breaker settings — prevent cascade from Redis outage
		MaxRetries:      3,
		MinRetryBackoff: 8 * time.Millisecond,
		MaxRetryBackoff: 512 * time.Millisecond,
	}

	client := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return client, nil
}

// NewRedisClusterClient creates a Redis Cluster client.
func NewRedisClusterClient(cfg RedisConfig) (*redis.ClusterClient, error) {
	client := redis.NewClusterClient(&redis.ClusterOptions{
		Addrs:           cfg.Addresses,
		Password:        cfg.Password,
		DialTimeout:     cfg.DialTimeout,
		ReadTimeout:     cfg.ReadTimeout,
		WriteTimeout:    cfg.WriteTimeout,
		PoolSize:        cfg.PoolSize,
		MinIdleConns:    cfg.MinIdleConns,
		ConnMaxIdleTime: cfg.MaxIdleTime,
		TLSConfig:       cfg.TLSConfig,
		MaxRetries:      3,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis cluster ping: %w", err)
	}
	return client, nil
}
```

## Cache-Aside Pattern

```go
// internal/cache/aside.go
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// CacheAside implements cache-aside (lazy loading) pattern.
type CacheAside[T any] struct {
	client    redis.UniversalClient
	keyPrefix string
	ttl       time.Duration
}

func NewCacheAside[T any](client redis.UniversalClient, keyPrefix string, ttl time.Duration) *CacheAside[T] {
	return &CacheAside[T]{
		client:    client,
		keyPrefix: keyPrefix,
		ttl:       ttl,
	}
}

func (c *CacheAside[T]) key(id string) string {
	return fmt.Sprintf("%s:%s", c.keyPrefix, id)
}

// Get retrieves an item from cache or calls the loader on a miss.
// The loader result is stored in cache before being returned.
func (c *CacheAside[T]) Get(ctx context.Context, id string, loader func(ctx context.Context) (T, error)) (T, error) {
	var zero T
	k := c.key(id)

	// Attempt cache read
	data, err := c.client.Get(ctx, k).Bytes()
	if err == nil {
		var value T
		if err := json.Unmarshal(data, &value); err != nil {
			// Cache corruption — delete and reload
			c.client.Del(ctx, k)
		} else {
			return value, nil
		}
	}
	if !errors.Is(err, redis.Nil) {
		// Redis error — proceed to loader but don't fail the request
		// Optionally: record metric for cache error rate
	}

	// Cache miss — load from origin
	value, err := loader(ctx)
	if err != nil {
		return zero, fmt.Errorf("load: %w", err)
	}

	// Populate cache asynchronously (don't slow down the response)
	go func() {
		setCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if encoded, err := json.Marshal(value); err == nil {
			c.client.Set(setCtx, k, encoded, c.ttl)
		}
	}()

	return value, nil
}

// Set writes a value directly to cache.
func (c *CacheAside[T]) Set(ctx context.Context, id string, value T) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return c.client.Set(ctx, c.key(id), encoded, c.ttl).Err()
}

// Invalidate removes an item from cache.
func (c *CacheAside[T]) Invalidate(ctx context.Context, id string) error {
	return c.client.Del(ctx, c.key(id)).Err()
}

// InvalidateMulti removes multiple items atomically using a pipeline.
func (c *CacheAside[T]) InvalidateMulti(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = c.key(id)
	}
	return c.client.Del(ctx, keys...).Err()
}
```

## Cache Stampede Prevention with singleflight

A cache stampede occurs when many concurrent requests miss the cache simultaneously and all execute the expensive origin load:

```go
// internal/cache/singleflight.go
package cache

import (
	"context"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// SingleflightCache wraps CacheAside with request coalescing.
// Multiple concurrent requests for the same key collapse into one loader call.
type SingleflightCache[T any] struct {
	aside  *CacheAside[T]
	group  singleflight.Group
	mu     sync.Mutex
}

func NewSingleflightCache[T any](client redis.UniversalClient, prefix string, ttl time.Duration) *SingleflightCache[T] {
	return &SingleflightCache[T]{
		aside: NewCacheAside[T](client, prefix, ttl),
	}
}

func (s *SingleflightCache[T]) Get(ctx context.Context, id string, loader func(ctx context.Context) (T, error)) (T, error) {
	type result struct {
		value T
		err   error
	}

	// Use Do to coalesce concurrent requests for the same key
	ch := s.group.DoChan(id, func() (any, error) {
		val, err := s.aside.Get(ctx, id, loader)
		return result{value: val, err: err}, nil
	})

	select {
	case res := <-ch:
		r := res.Val.(result)
		return r.value, r.err
	case <-ctx.Done():
		var zero T
		return zero, fmt.Errorf("context cancelled waiting for cache: %w", ctx.Err())
	}
}
```

## Distributed Lock with Redlock

For operations requiring distributed mutual exclusion—cache warming, leader election, rate limiting—Redlock provides probabilistic safety across multiple Redis instances:

```go
// internal/cache/redlock.go
package cache

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrLockNotAcquired = errors.New("lock not acquired")

// RedLock implements a simplified single-instance distributed lock.
// For production with multiple Redis instances, use github.com/bsm/redislock.
type RedLock struct {
	client redis.UniversalClient
}

func NewRedLock(client redis.UniversalClient) *RedLock {
	return &RedLock{client: client}
}

// Acquire attempts to acquire a lock with the given TTL.
// Returns the lock token (used for release) or ErrLockNotAcquired.
func (r *RedLock) Acquire(ctx context.Context, key string, ttl time.Duration) (string, error) {
	// Generate a unique token to prevent releasing another holder's lock
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)

	lockKey := fmt.Sprintf("lock:%s", key)

	// SET NX (set if not exists) with TTL — atomic operation
	ok, err := r.client.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return "", fmt.Errorf("acquire lock: %w", err)
	}
	if !ok {
		return "", ErrLockNotAcquired
	}
	return token, nil
}

// AcquireWithRetry retries lock acquisition with exponential backoff.
func (r *RedLock) AcquireWithRetry(ctx context.Context, key string, ttl time.Duration, maxWait time.Duration) (string, error) {
	deadline := time.Now().Add(maxWait)
	backoff := 50 * time.Millisecond
	for {
		token, err := r.Acquire(ctx, key, ttl)
		if err == nil {
			return token, nil
		}
		if !errors.Is(err, ErrLockNotAcquired) {
			return "", err
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("lock acquisition timed out after %s", maxWait)
		}
		select {
		case <-time.After(backoff):
			backoff = min(backoff*2, 1*time.Second)
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

// Release releases the lock only if the token matches (atomic Lua script).
func (r *RedLock) Release(ctx context.Context, key, token string) error {
	lockKey := fmt.Sprintf("lock:%s", key)

	// Lua script ensures check-and-delete is atomic
	script := redis.NewScript(`
		if redis.call("get", KEYS[1]) == ARGV[1] then
			return redis.call("del", KEYS[1])
		else
			return 0
		end
	`)

	result, err := script.Run(ctx, r.client, []string{lockKey}, token).Int()
	if err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("release lock: %w", err)
	}
	if result == 0 {
		return fmt.Errorf("lock already expired or acquired by another holder")
	}
	return nil
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
```

### Using Distributed Lock for Cache Warming

```go
func (s *CacheWarmer) warmWithLock(ctx context.Context, key string) error {
	lock := NewRedLock(s.redis)

	// Only one instance should warm the cache
	token, err := lock.AcquireWithRetry(ctx, "warm:"+key, 30*time.Second, 5*time.Second)
	if err != nil {
		if errors.Is(err, ErrLockNotAcquired) {
			// Another instance is warming — skip
			return nil
		}
		return err
	}
	defer lock.Release(context.Background(), "warm:"+key, token)

	// Check cache again after acquiring lock (another holder may have populated it)
	if exists, _ := s.redis.Exists(ctx, key).Result(); exists > 0 {
		return nil
	}

	return s.populate(ctx, key)
}
```

## In-Memory LRU Cache with ristretto

For hot data that can tolerate eventual consistency, in-memory caching avoids network round-trips entirely:

```go
// internal/cache/memory.go
package cache

import (
	"fmt"
	"time"

	"github.com/dgraph-io/ristretto"
)

// MemoryCache provides an in-process LRU cache with TinyLFU eviction policy.
// ristretto is more efficient than sync.Map for read-heavy workloads.
type MemoryCache[T any] struct {
	cache *ristretto.Cache
	ttl   time.Duration
}

func NewMemoryCache[T any](maxCost int64, ttl time.Duration) (*MemoryCache[T], error) {
	cache, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: maxCost * 10, // 10x the number of expected items
		MaxCost:     maxCost,
		BufferItems: 64,       // Number of keys per Get buffer
		Metrics:     true,     // Enable hit/miss metrics
		Cost: func(value any) int64 {
			return 1  // Each item costs 1 unit (override for variable-size items)
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create ristretto cache: %w", err)
	}
	return &MemoryCache[T]{cache: cache, ttl: ttl}, nil
}

func (m *MemoryCache[T]) Get(key string) (T, bool) {
	value, found := m.cache.Get(key)
	if !found {
		var zero T
		return zero, false
	}
	return value.(T), true
}

func (m *MemoryCache[T]) Set(key string, value T) bool {
	return m.cache.SetWithTTL(key, value, 1, m.ttl)
}

func (m *MemoryCache[T]) Delete(key string) {
	m.cache.Del(key)
}

// Metrics returns cache performance statistics.
func (m *MemoryCache[T]) Metrics() *ristretto.Metrics {
	return m.cache.Metrics
}
```

### Two-Tier Cache: Memory + Redis

```go
// internal/cache/tiered.go
package cache

import (
	"context"
	"time"
)

// TieredCache checks in-memory first (fast), then Redis (shared, slower).
type TieredCache[T any] struct {
	l1  *MemoryCache[T]
	l2  *SingleflightCache[T]
	l1TTL time.Duration
}

func NewTieredCache[T any](
	l1MaxItems int64, l1TTL time.Duration,
	redis redis.UniversalClient, l2Prefix string, l2TTL time.Duration,
) (*TieredCache[T], error) {
	l1, err := NewMemoryCache[T](l1MaxItems, l1TTL)
	if err != nil {
		return nil, err
	}
	return &TieredCache[T]{
		l1:    l1,
		l2:    NewSingleflightCache[T](redis, l2Prefix, l2TTL),
		l1TTL: l1TTL,
	}, nil
}

func (t *TieredCache[T]) Get(ctx context.Context, id string, loader func(ctx context.Context) (T, error)) (T, error) {
	// L1: in-memory check
	if value, ok := t.l1.Get(id); ok {
		return value, nil
	}

	// L2: Redis with singleflight
	value, err := t.l2.Get(ctx, id, loader)
	if err != nil {
		return value, err
	}

	// Populate L1 for subsequent requests
	t.l1.Set(id, value)
	return value, nil
}

func (t *TieredCache[T]) Invalidate(ctx context.Context, id string) error {
	t.l1.Delete(id)
	return t.l2.aside.Invalidate(ctx, id)
}
```

## Event-Driven Cache Invalidation

For write-through scenarios, publish invalidation events to Redis Pub/Sub:

```go
// internal/cache/invalidation.go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

type InvalidationMessage struct {
	Keys []string `json:"keys"`
}

// Publisher broadcasts cache invalidation events.
type Publisher struct {
	client  redis.UniversalClient
	channel string
}

func NewPublisher(client redis.UniversalClient, channel string) *Publisher {
	return &Publisher{client: client, channel: channel}
}

func (p *Publisher) Invalidate(ctx context.Context, keys ...string) error {
	msg, err := json.Marshal(InvalidationMessage{Keys: keys})
	if err != nil {
		return fmt.Errorf("marshal invalidation: %w", err)
	}
	return p.client.Publish(ctx, p.channel, msg).Err()
}

// Subscriber listens for invalidation events and clears local cache.
type Subscriber struct {
	client   redis.UniversalClient
	channel  string
	memCache interface{ Delete(key string) }
}

func NewSubscriber(client redis.UniversalClient, channel string, cache interface{ Delete(key string) }) *Subscriber {
	return &Subscriber{client: client, channel: channel, memCache: cache}
}

func (s *Subscriber) Listen(ctx context.Context) error {
	pubsub := s.client.Subscribe(ctx, s.channel)
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return fmt.Errorf("subscription channel closed")
			}
			var inv InvalidationMessage
			if err := json.Unmarshal([]byte(msg.Payload), &inv); err != nil {
				slog.Warn("invalid invalidation message", "error", err)
				continue
			}
			for _, key := range inv.Keys {
				s.memCache.Delete(key)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
```

## TTL Management Patterns

```go
// Jitter prevents thundering herd from synchronized TTL expiry
import "math/rand"

func jitterTTL(base time.Duration, jitterPercent float64) time.Duration {
	jitter := time.Duration(float64(base) * jitterPercent * rand.Float64())
	return base + jitter
}

// Usage: 1h TTL with 10% jitter → 1h to 1h6m
ttl := jitterTTL(time.Hour, 0.1)

// Sliding TTL: reset TTL on cache hit
func (c *CacheAside[T]) GetWithSlidingTTL(ctx context.Context, id string, loader func(ctx context.Context) (T, error)) (T, error) {
	k := c.key(id)
	pipe := c.client.Pipeline()
	getCmd := pipe.Get(ctx, k)
	pipe.Expire(ctx, k, c.ttl)  // Reset TTL on access
	pipe.Exec(ctx)

	if data, err := getCmd.Bytes(); err == nil {
		var value T
		if json.Unmarshal(data, &value) == nil {
			return value, nil
		}
	}
	// Cache miss path...
	return c.Get(ctx, id, loader)
}
```

## Cache Monitoring

```go
// internal/cache/metrics.go
package cache

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	cacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "cache_hits_total",
		Help: "Total cache hit count by cache name and tier",
	}, []string{"cache", "tier"})

	cacheMisses = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "cache_misses_total",
		Help: "Total cache miss count by cache name and tier",
	}, []string{"cache", "tier"})

	cacheLoadDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "cache_load_duration_seconds",
		Help:    "Duration of cache loader (origin read) calls",
		Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0},
	}, []string{"cache"})

	cacheErrorsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "cache_errors_total",
		Help: "Total cache operation errors",
	}, []string{"cache", "operation"})
)

// InstrumentedCacheAside wraps CacheAside with Prometheus metrics.
type InstrumentedCacheAside[T any] struct {
	inner *CacheAside[T]
	name  string
}

func (i *InstrumentedCacheAside[T]) Get(ctx context.Context, id string, loader func(ctx context.Context) (T, error)) (T, error) {
	instrumentedLoader := func(ctx context.Context) (T, error) {
		cacheMisses.WithLabelValues(i.name, "redis").Inc()
		start := time.Now()
		val, err := loader(ctx)
		cacheLoadDuration.WithLabelValues(i.name).Observe(time.Since(start).Seconds())
		if err != nil {
			cacheErrorsTotal.WithLabelValues(i.name, "load").Inc()
		}
		return val, err
	}

	val, err := i.inner.Get(ctx, id, instrumentedLoader)
	if err != nil {
		cacheErrorsTotal.WithLabelValues(i.name, "get").Inc()
		return val, err
	}
	// Hit is implied when loader was not called — tracked in loader instrumentation
	cacheHits.WithLabelValues(i.name, "redis").Inc()
	return val, nil
}
```

### Prometheus Queries for Cache Health

```promql
# Cache hit ratio (should be > 90% for effective caching)
sum by (cache) (rate(cache_hits_total[5m])) /
(sum by (cache) (rate(cache_hits_total[5m])) + sum by (cache) (rate(cache_misses_total[5m])))

# Redis connection pool saturation
redis_connected_clients / redis_maxclients > 0.8

# Cache load latency P99 (indicates origin health)
histogram_quantile(0.99, sum by (le, cache) (rate(cache_load_duration_seconds_bucket[5m])))

# Error rate by operation
sum by (cache, operation) (rate(cache_errors_total[5m]))
```

## Cache Warming Strategy

```go
// internal/cache/warmer.go
package cache

import (
	"context"
	"log/slog"
	"time"
)

// Warmer pre-populates cache on application startup and on schedule.
type Warmer[T any] struct {
	cache  *TieredCache[T]
	loader func(ctx context.Context) (map[string]T, error)
	lock   *RedLock
}

// WarmAll loads all items into cache.
// Uses distributed lock to prevent multiple instances from warming simultaneously.
func (w *Warmer[T]) WarmAll(ctx context.Context) error {
	token, err := w.lock.AcquireWithRetry(ctx, "cache-warmer", 5*time.Minute, 30*time.Second)
	if err != nil {
		slog.Info("another instance is warming cache, skipping")
		return nil
	}
	defer w.lock.Release(context.Background(), "cache-warmer", token)

	slog.Info("starting cache warm")
	start := time.Now()

	items, err := w.loader(ctx)
	if err != nil {
		return err
	}

	for id, item := range items {
		if err := w.cache.l2.aside.Set(ctx, id, item); err != nil {
			slog.Warn("cache warm set failed", "id", id, "error", err)
		}
	}

	slog.Info("cache warm complete", "items", len(items), "duration", time.Since(start))
	return nil
}
```

## Production Checklist

```
Redis Configuration
[ ] Connection pool sized to (num_goroutines * 0.1) — avoid over-provisioning
[ ] DialTimeout and ReadTimeout set (never block indefinitely on Redis failure)
[ ] MaxRetries with exponential backoff for transient failures
[ ] TLS enabled for Redis connections in production
[ ] Separate Redis instances or databases for cache vs session vs queue

Cache Design
[ ] Cache keys include version prefix for safe cache format changes
[ ] TTL jitter applied to prevent synchronized expiry thundering herd
[ ] singleflight applied for any high-traffic cache miss paths
[ ] Negative caching implemented for "not found" results (short TTL)
[ ] Cache bypass mechanism for debugging (header or feature flag)

Invalidation
[ ] Invalidation strategy documented per cached entity type
[ ] Event-driven invalidation for write-heavy entities
[ ] TTL-only invalidation for mostly-read, eventual-consistency-tolerant data
[ ] Cascading invalidation considered for denormalized cached aggregates

Monitoring
[ ] Hit ratio dashboards per cache and tier
[ ] Alert on hit ratio < 70% sustained for 10 minutes
[ ] Redis memory usage alert at 80% of maxmemory
[ ] Load duration P99 alert for origin degradation detection
[ ] Distributed lock acquisition failure rate monitored
```

Effective caching requires treating the cache as a first-class component with its own monitoring, deployment lifecycle, and failure modes. When Redis is unavailable, cache-aside code must fall back to origin reads without propagating the failure. When hit ratios drop, the on-call engineer needs the dashboards and runbooks to distinguish a warming cluster from a broken key generation pattern.
