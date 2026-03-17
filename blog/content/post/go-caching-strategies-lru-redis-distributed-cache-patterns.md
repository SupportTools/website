---
title: "Go Caching Strategies: In-Process LRU, Redis, and Distributed Cache Patterns"
date: 2031-01-17T00:00:00-05:00
draft: false
tags: ["Go", "Caching", "Redis", "Performance", "Distributed Systems", "LRU", "singleflight"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go caching strategies covering groupcache, ristretto, and bigcache for in-process caching, Redis patterns with go-redis, cache-aside vs write-through vs write-behind, stampede prevention with singleflight, and TTL/eviction strategies."
more_link: "yes"
url: "/go-caching-strategies-lru-redis-distributed-cache-patterns/"
---

Caching is the highest-leverage performance optimization in most systems, but implementing it correctly requires understanding the tradeoffs between cache location, consistency guarantees, write strategies, and failure modes. In Go microservices, the right caching architecture spans in-process L1 caches for hot data, Redis for shared distributed state, and multi-level hybrid strategies for high-throughput APIs. This guide covers the major Go caching libraries, Redis client patterns, cache coherence strategies, and production-proven techniques for eliminating the thundering herd problem.

<!--more-->

# Go Caching Strategies: In-Process LRU, Redis, and Distributed Cache Patterns

## Section 1: In-Process Caching Libraries

### When to Use In-Process Cache

In-process caching has zero network latency but is local to a single pod:

- Use for: immutable or slowly-changing configuration, expensive computations, decoded tokens
- Avoid for: data that must be consistent across multiple pods, user-specific data with low reuse

### ristretto - High-Performance Concurrent Cache

Ristretto from DGraph is one of the most performant in-process caches, using TinyLFU admission policy and a lock-free design:

```go
package main

import (
	"fmt"
	"time"

	"github.com/dgraph-io/ristretto"
)

func setupRistretto() (*ristretto.Cache, error) {
	cache, err := ristretto.NewCache(&ristretto.Config{
		// NumCounters: 10x the maximum number of items you expect to store
		NumCounters: 1e7,         // 10 million counters for ~1 million items
		MaxCost:     1 << 30,     // 1 GB maximum cache size
		BufferItems: 64,          // number of keys per Get buffer

		// Cost function: return memory size of value
		// If nil, all items have cost 1 (MaxCost is item count)
		Cost: func(value interface{}) int64 {
			switch v := value.(type) {
			case string:
				return int64(len(v))
			case []byte:
				return int64(len(v))
			default:
				return 1
			}
		},

		// Metrics enables Prometheus-compatible stats
		Metrics: true,
	})
	return cache, err
}

func ristrettoExample(cache *ristretto.Cache) {
	// Set with TTL
	key := "user:profile:12345"
	value := map[string]interface{}{
		"name":  "Alice",
		"email": "alice@example.com",
	}
	ttl := 5 * time.Minute

	// Returns true if item was set (may be false if cost exceeds MaxCost)
	set := cache.SetWithTTL(key, value, 1, ttl)
	if !set {
		fmt.Println("item not set (cost exceeded)")
	}

	// Wait for value to be visible (ristretto is eventually consistent due to async processing)
	cache.Wait()

	// Get
	val, found := cache.Get(key)
	if found {
		fmt.Printf("found: %v\n", val)
	}

	// Delete
	cache.Del(key)

	// Stats
	metrics := cache.Metrics
	fmt.Printf("hit ratio: %.2f%%\n", metrics.Ratio()*100)
	fmt.Printf("keys added: %d\n", metrics.KeysAdded())
	fmt.Printf("keys evicted: %d\n", metrics.KeysEvicted())
}
```

### bigcache - Allocation-Free In-Memory Store

bigcache stores values in a pre-allocated byte slice, eliminating GC pressure from the cache itself:

```go
import (
	"context"
	"encoding/json"
	"time"

	"github.com/allegro/bigcache/v3"
)

type UserProfile struct {
	ID    string
	Name  string
	Email string
}

type UserCache struct {
	cache *bigcache.BigCache
}

func NewUserCache(maxSizeMB int, ttl time.Duration) (*UserCache, error) {
	config := bigcache.Config{
		Shards:             1024,        // Number of cache shards (must be power of 2)
		LifeWindow:         ttl,         // Time after which entry can be evicted
		CleanWindow:        5 * time.Minute, // Interval for removing stale entries
		MaxEntriesInWindow: 1000 * 10 * 60, // Expected entries in LifeWindow
		MaxEntrySize:       500,         // Max entry size in bytes
		HardMaxCacheSize:   maxSizeMB,   // Hard maximum size in MB (0 = unlimited)
		Verbose:            false,
		OnRemove:           nil,         // Callback on eviction
		OnRemoveWithReason: func(key string, entry []byte, reason bigcache.RemoveReason) {
			if reason == bigcache.Expired {
				// Handle expiry (e.g., refresh from source)
			}
		},
	}

	bc, err := bigcache.New(context.Background(), config)
	if err != nil {
		return nil, err
	}
	return &UserCache{cache: bc}, nil
}

func (uc *UserCache) Get(userID string) (*UserProfile, error) {
	data, err := uc.cache.Get(userID)
	if err != nil {
		if err == bigcache.ErrEntryNotFound {
			return nil, nil // Cache miss
		}
		return nil, err
	}

	var profile UserProfile
	if err := json.Unmarshal(data, &profile); err != nil {
		return nil, err
	}
	return &profile, nil
}

func (uc *UserCache) Set(profile *UserProfile) error {
	data, err := json.Marshal(profile)
	if err != nil {
		return err
	}
	return uc.cache.Set(profile.ID, data)
}
```

### sync.Map as Simple Cache

For read-heavy caches with infrequent writes:

```go
import "sync"

// SimpleCache uses sync.Map for a basic in-memory key-value store.
type SimpleCache[K comparable, V any] struct {
	m sync.Map
}

func (c *SimpleCache[K, V]) Get(key K) (V, bool) {
	val, ok := c.m.Load(key)
	if !ok {
		var zero V
		return zero, false
	}
	return val.(V), true
}

func (c *SimpleCache[K, V]) Set(key K, val V) {
	c.m.Store(key, val)
}

func (c *SimpleCache[K, V]) Delete(key K) {
	c.m.Delete(key)
}

// GetOrCompute returns cached value or computes and caches it.
func (c *SimpleCache[K, V]) GetOrCompute(key K, fn func() (V, error)) (V, error) {
	if val, ok := c.Get(key); ok {
		return val, nil
	}
	val, err := fn()
	if err != nil {
		return val, err
	}
	c.Set(key, val)
	return val, nil
}
```

## Section 2: Redis Cache Patterns with go-redis

### Client Setup and Connection Pooling

```go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// NewRedisClient creates a production-ready Redis client.
func NewRedisClient(addr, password string, db int) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,

		// Connection pool settings
		PoolSize:     50,             // Maximum connections per goroutine pool
		MinIdleConns: 10,             // Minimum idle connections
		MaxIdleConns: 20,             // Maximum idle connections
		PoolTimeout:  5 * time.Second,// Wait timeout for pool connection

		// Timeouts
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,

		// Retry
		MaxRetries:      3,
		MinRetryBackoff: 8 * time.Millisecond,
		MaxRetryBackoff: 512 * time.Millisecond,
	})
}

// NewRedisClusterClient creates a Redis Cluster client.
func NewRedisClusterClient(addrs []string) *redis.ClusterClient {
	return redis.NewClusterClient(&redis.ClusterOptions{
		Addrs:        addrs,
		PoolSize:     20,
		MinIdleConns: 5,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		// Route reads to replicas
		RouteRandomly: false,
		RouteByLatency: true,  // Route read commands to nearest replica
	})
}
```

### Cache-Aside Pattern (Lazy Loading)

The most common pattern: check cache first, load from source on miss, populate cache:

```go
type UserService struct {
	db    UserRepository
	cache *redis.Client
	ttl   time.Duration
}

func (s *UserService) GetUser(ctx context.Context, userID string) (*User, error) {
	cacheKey := fmt.Sprintf("user:%s", userID)

	// 1. Try cache
	data, err := s.cache.Get(ctx, cacheKey).Bytes()
	if err == nil {
		// Cache hit
		var user User
		if err := json.Unmarshal(data, &user); err != nil {
			return nil, fmt.Errorf("unmarshal cached user: %w", err)
		}
		return &user, nil
	}
	if err != redis.Nil {
		// Cache error (not a miss) - log but continue to fetch from DB
		// Don't fail the request because of cache issues
		logf("cache get error for key %s: %v", cacheKey, err)
	}

	// 2. Cache miss: load from database
	user, err := s.db.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get user from db: %w", err)
	}
	if user == nil {
		// Negative caching: cache the miss to prevent repeated DB lookups
		s.cache.Set(ctx, cacheKey, "null", 30*time.Second)
		return nil, nil
	}

	// 3. Populate cache
	encoded, err := json.Marshal(user)
	if err != nil {
		return nil, fmt.Errorf("marshal user: %w", err)
	}
	if err := s.cache.Set(ctx, cacheKey, encoded, s.ttl).Err(); err != nil {
		logf("cache set error for key %s: %v", cacheKey, err)
		// Continue: cache write failure should not fail the request
	}

	return user, nil
}

// InvalidateUser removes a user from the cache.
// Called after a user update in the database.
func (s *UserService) InvalidateUser(ctx context.Context, userID string) error {
	return s.cache.Del(ctx, fmt.Sprintf("user:%s", userID)).Err()
}
```

### Write-Through Pattern

Write-through updates the cache synchronously with the database:

```go
func (s *UserService) UpdateUser(ctx context.Context, user *User) error {
	// 1. Write to database
	if err := s.db.UpdateUser(ctx, user); err != nil {
		return fmt.Errorf("update user in db: %w", err)
	}

	// 2. Write to cache (write-through)
	encoded, err := json.Marshal(user)
	if err != nil {
		// Log error but don't fail - DB is the source of truth
		logf("marshal user for cache: %v", err)
		// Invalidate stale cache entry instead
		s.cache.Del(ctx, fmt.Sprintf("user:%s", user.ID))
		return nil
	}

	if err := s.cache.Set(ctx, fmt.Sprintf("user:%s", user.ID), encoded, s.ttl).Err(); err != nil {
		logf("cache set error: %v", err)
		// Invalidate rather than leaving stale
		s.cache.Del(ctx, fmt.Sprintf("user:%s", user.ID))
	}

	return nil
}
```

### Write-Behind Pattern (Async Write)

Write-behind writes to cache immediately and queues database writes:

```go
type WriteBehindCache struct {
	cache     *redis.Client
	writeQueue chan WriteOp
}

type WriteOp struct {
	Key   string
	Value interface{}
}

func NewWriteBehindCache(cache *redis.Client, queueSize int) *WriteBehindCache {
	wbc := &WriteBehindCache{
		cache:      cache,
		writeQueue: make(chan WriteOp, queueSize),
	}
	return wbc
}

// StartWorker starts background DB write worker.
func (wbc *WriteBehindCache) StartWorker(ctx context.Context, db UserRepository) {
	go func() {
		batch := make([]WriteOp, 0, 50)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()

		for {
			select {
			case op := <-wbc.writeQueue:
				batch = append(batch, op)
				if len(batch) >= 50 {
					wbc.flushBatch(ctx, db, batch)
					batch = batch[:0]
				}
			case <-ticker.C:
				if len(batch) > 0 {
					wbc.flushBatch(ctx, db, batch)
					batch = batch[:0]
				}
			case <-ctx.Done():
				// Flush remaining
				if len(batch) > 0 {
					wbc.flushBatch(context.Background(), db, batch)
				}
				return
			}
		}
	}()
}

func (wbc *WriteBehindCache) flushBatch(ctx context.Context, db UserRepository, ops []WriteOp) {
	for _, op := range ops {
		if err := db.UpdateUserFromCache(ctx, op.Key, op.Value); err != nil {
			logf("write-behind flush failed for key %s: %v", op.Key, err)
			// In production: retry, dead-letter queue, or alert
		}
	}
}
```

## Section 3: Cache Stampede Prevention with singleflight

The cache stampede (thundering herd) problem occurs when many concurrent requests miss the cache simultaneously, all attempt to load from the backing store, and overwhelm it.

```go
import "golang.org/x/sync/singleflight"

type CachingService struct {
	cache    *redis.Client
	db       UserRepository
	group    singleflight.Group
	ttl      time.Duration
}

// GetUser fetches a user, preventing cache stampede with singleflight.
func (s *CachingService) GetUser(ctx context.Context, userID string) (*User, error) {
	cacheKey := fmt.Sprintf("user:%s", userID)

	// Fast path: check cache without singleflight
	if data, err := s.cache.Get(ctx, cacheKey).Bytes(); err == nil {
		var user User
		if err := json.Unmarshal(data, &user); err == nil {
			return &user, nil
		}
	}

	// Slow path: deduplicate concurrent loads with singleflight
	// All concurrent calls for the same userID will wait for ONE DB call
	result, err, shared := s.group.Do(cacheKey, func() (interface{}, error) {
		// Check cache again inside singleflight (another goroutine may have populated it)
		if data, err := s.cache.Get(ctx, cacheKey).Bytes(); err == nil {
			var user User
			if err := json.Unmarshal(data, &user); err == nil {
				return &user, nil
			}
		}

		// Load from database
		user, err := s.db.GetUser(ctx, userID)
		if err != nil {
			return nil, err
		}

		// Populate cache
		if user != nil {
			if encoded, err := json.Marshal(user); err == nil {
				s.cache.Set(ctx, cacheKey, encoded, s.ttl)
			}
		}

		return user, nil
	})

	if err != nil {
		return nil, err
	}

	if shared {
		// This result was shared with other goroutines (stampede prevented)
	}

	if result == nil {
		return nil, nil
	}
	return result.(*User), nil
}
```

### singleflight.Group Limitations

The standard `singleflight.Group` has one important limitation: if the function panics or the context is cancelled, all waiting callers receive the same error. This can cause issues with timeout propagation.

A context-aware singleflight:

```go
// ContextGroup is a singleflight.Group that respects context cancellation.
type ContextGroup struct {
	group singleflight.Group
}

// Do executes fn once for the given key, deduplicating concurrent calls.
// If the context is cancelled before fn completes, Do returns immediately
// with ctx.Err(), but fn continues executing (to populate cache for others).
func (g *ContextGroup) Do(ctx context.Context, key string, fn func() (interface{}, error)) (interface{}, error) {
	type result struct {
		val interface{}
		err error
	}

	resultCh := make(chan result, 1)

	go func() {
		val, err, _ := g.group.Do(key, fn)
		resultCh <- result{val: val, err: err}
	}()

	select {
	case r := <-resultCh:
		return r.val, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
		// Note: fn continues executing in background to populate cache
	}
}
```

## Section 4: TTL and Eviction Strategies

### TTL Jitter

Without jitter, many cache entries created at the same time (e.g., after a cache flush) all expire simultaneously, causing a mass cache miss. Adding random jitter distributes the expirations:

```go
import (
	"math/rand"
	"time"
)

// JitteredTTL adds +/- jitterPercent% randomness to a base TTL.
func JitteredTTL(base time.Duration, jitterPercent float64) time.Duration {
	jitterRange := float64(base) * jitterPercent / 100.0
	jitter := (rand.Float64()*2 - 1) * jitterRange // -jitter to +jitter
	return base + time.Duration(jitter)
}

// Usage:
ttl := JitteredTTL(5*time.Minute, 10) // 5 minutes +/- 30 seconds
cache.Set(ctx, key, value, ttl)
```

### Probabilistic Early Expiration (PER)

PER (also known as XFetch) proactively refreshes cache entries before they expire, preventing the single-request miss that triggers a stampede:

```go
import (
	"math"
	"math/rand"
	"time"
)

// PERCache wraps Redis with probabilistic early expiration.
type PERCache struct {
	client *redis.Client
	beta   float64 // Controls how aggressively to refresh early (default: 1.0)
}

type CachedValue struct {
	Data      []byte        `json:"data"`
	ExpiresAt time.Time     `json:"expires_at"`
	Delta     time.Duration `json:"delta"` // Time it took to compute the value
}

// ShouldRefresh returns true if the item should be proactively refreshed.
// Based on: refresh if rand() * beta * delta > ttl_remaining
func (c *PERCache) ShouldRefresh(v *CachedValue) bool {
	ttlRemaining := time.Until(v.ExpiresAt)
	if ttlRemaining <= 0 {
		return true // Already expired
	}

	// XFetch formula: -delta * beta * ln(rand())
	return float64(v.Delta) * c.beta * (-math.Log(rand.Float64())) >= float64(ttlRemaining)
}

func (c *PERCache) Get(ctx context.Context, key string) (*CachedValue, bool) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		return nil, false
	}
	var cv CachedValue
	if err := json.Unmarshal(data, &cv); err != nil {
		return nil, false
	}
	return &cv, true
}

// GetWithEarlyRefresh fetches from cache but triggers early refresh via callback.
func (c *PERCache) GetWithEarlyRefresh(
	ctx context.Context,
	key string,
	ttl time.Duration,
	compute func() ([]byte, error),
) ([]byte, error) {
	if cv, found := c.Get(ctx, key); found {
		if !c.ShouldRefresh(cv) {
			return cv.Data, nil // Cache hit, no early refresh needed
		}
		// Early refresh: compute new value in background
		go func() {
			start := time.Now()
			data, err := compute()
			if err != nil {
				return
			}
			delta := time.Since(start)
			newCV := &CachedValue{
				Data:      data,
				ExpiresAt: time.Now().Add(ttl),
				Delta:     delta,
			}
			encoded, _ := json.Marshal(newCV)
			c.client.Set(ctx, key, encoded, ttl+time.Minute)
		}()
		return cv.Data, nil // Return stale value while refreshing
	}

	// Cache miss: compute synchronously
	start := time.Now()
	data, err := compute()
	if err != nil {
		return nil, err
	}
	delta := time.Since(start)

	cv := &CachedValue{
		Data:      data,
		ExpiresAt: time.Now().Add(ttl),
		Delta:     delta,
	}
	encoded, _ := json.Marshal(cv)
	c.client.Set(ctx, key, encoded, ttl+time.Minute)
	return data, nil
}
```

## Section 5: Multi-Level Cache Architecture

A multi-level cache (L1 in-process + L2 Redis) provides the best of both worlds:

```go
// MultiLevelCache implements a two-level cache: in-process (L1) + Redis (L2).
type MultiLevelCache struct {
	l1  *ristretto.Cache  // Fast, local, limited size
	l2  *redis.Client     // Distributed, shared, larger
	l1TTL time.Duration   // Short TTL for L1
	l2TTL time.Duration   // Longer TTL for L2
	sf  singleflight.Group
}

func (c *MultiLevelCache) Get(ctx context.Context, key string) ([]byte, bool) {
	// Check L1
	if val, found := c.l1.Get(key); found {
		return val.([]byte), true
	}

	// Check L2
	data, err := c.l2.Get(ctx, key).Bytes()
	if err == nil {
		// Populate L1 from L2
		c.l1.SetWithTTL(key, data, int64(len(data)), c.l1TTL)
		c.l1.Wait()
		return data, true
	}

	return nil, false
}

func (c *MultiLevelCache) Set(ctx context.Context, key string, value []byte) {
	// Write to both levels
	c.l1.SetWithTTL(key, value, int64(len(value)), c.l1TTL)
	c.l2.Set(ctx, key, value, c.l2TTL)
}

func (c *MultiLevelCache) GetOrLoad(
	ctx context.Context,
	key string,
	loader func(ctx context.Context) ([]byte, error),
) ([]byte, error) {
	if data, found := c.Get(ctx, key); found {
		return data, nil
	}

	// Use singleflight for L2 miss to prevent stampede
	result, err, _ := c.sf.Do(key, func() (interface{}, error) {
		// Double-check after acquiring singleflight
		if data, found := c.Get(ctx, key); found {
			return data, nil
		}
		data, err := loader(ctx)
		if err != nil {
			return nil, err
		}
		c.Set(ctx, key, data)
		return data, nil
	})

	if err != nil {
		return nil, err
	}
	return result.([]byte), nil
}

// Invalidate removes the key from all cache levels.
func (c *MultiLevelCache) Invalidate(ctx context.Context, key string) {
	c.l1.Del(key)
	c.l2.Del(ctx, key)
}
```

## Section 6: Cache Key Design

Good cache key design prevents collisions and enables efficient invalidation:

```go
// KeyBuilder provides a structured way to build cache keys.
type KeyBuilder struct {
	prefix  string
	version string
}

func NewKeyBuilder(prefix, version string) *KeyBuilder {
	return &KeyBuilder{prefix: prefix, version: version}
}

// Build constructs a cache key from structured components.
func (kb *KeyBuilder) Build(parts ...string) string {
	components := append([]string{kb.prefix, kb.version}, parts...)
	return strings.Join(components, ":")
}

// UserKey builds a user cache key.
func (kb *KeyBuilder) UserKey(userID string) string {
	return kb.Build("user", userID)
}

// UserListKey builds a key for a user's related list.
func (kb *KeyBuilder) UserListKey(userID, listType string) string {
	return kb.Build("user", userID, listType)
}

// Pattern returns a glob pattern for invalidating all keys for a user.
func (kb *KeyBuilder) UserPattern(userID string) string {
	return fmt.Sprintf("%s:%s:user:%s:*", kb.prefix, kb.version, userID)
}

// InvalidateUser removes all cache entries for a user.
func InvalidateUser(ctx context.Context, client *redis.Client, kb *KeyBuilder, userID string) error {
	pattern := kb.UserPattern(userID)
	var cursor uint64
	for {
		keys, nextCursor, err := client.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			if err := client.Del(ctx, keys...).Err(); err != nil {
				return err
			}
		}
		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}
	return nil
}
```

## Section 7: Cache Warming

For applications that cannot tolerate cold start latency, implement cache warming:

```go
// CacheWarmer pre-populates the cache before the service takes traffic.
type CacheWarmer struct {
	cache   *redis.Client
	db      UserRepository
	batchSize int
	workers   int
}

func (w *CacheWarmer) WarmUserCache(ctx context.Context) error {
	// Get most active users from DB
	activeUsers, err := w.db.GetMostActiveUsers(ctx, 10000)
	if err != nil {
		return fmt.Errorf("get active users: %w", err)
	}

	// Process in parallel batches
	userIDs := make(chan string, len(activeUsers))
	for _, u := range activeUsers {
		userIDs <- u.ID
	}
	close(userIDs)

	var wg sync.WaitGroup
	errors := make(chan error, w.workers)

	for i := 0; i < w.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for userID := range userIDs {
				if ctx.Err() != nil {
					return
				}

				user, err := w.db.GetUser(ctx, userID)
				if err != nil {
					errors <- fmt.Errorf("get user %s: %w", userID, err)
					continue
				}
				if user == nil {
					continue
				}

				encoded, err := json.Marshal(user)
				if err != nil {
					continue
				}

				key := fmt.Sprintf("user:%s", userID)
				if err := w.cache.Set(ctx, key, encoded, 5*time.Minute).Err(); err != nil {
					errors <- fmt.Errorf("cache set %s: %w", key, err)
				}
			}
		}()
	}

	wg.Wait()
	close(errors)

	var errs []error
	for err := range errors {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return fmt.Errorf("%d errors during cache warming (first: %w)", len(errs), errs[0])
	}
	return nil
}
```

## Section 8: Cache Metrics and Monitoring

```go
// CacheMetrics tracks cache performance.
type CacheMetrics struct {
	hits         prometheus.Counter
	misses       prometheus.Counter
	errors       prometheus.Counter
	latency      prometheus.Histogram
	size         prometheus.Gauge
}

func NewCacheMetrics(reg prometheus.Registerer, cacheName string) *CacheMetrics {
	labels := prometheus.Labels{"cache": cacheName}

	m := &CacheMetrics{
		hits: promauto.With(reg).NewCounter(prometheus.CounterOpts{
			Name:        "cache_hits_total",
			Help:        "Total cache hits",
			ConstLabels: labels,
		}),
		misses: promauto.With(reg).NewCounter(prometheus.CounterOpts{
			Name:        "cache_misses_total",
			Help:        "Total cache misses",
			ConstLabels: labels,
		}),
		errors: promauto.With(reg).NewCounter(prometheus.CounterOpts{
			Name:        "cache_errors_total",
			Help:        "Total cache errors",
			ConstLabels: labels,
		}),
		latency: promauto.With(reg).NewHistogram(prometheus.HistogramOpts{
			Name:        "cache_operation_duration_seconds",
			Help:        "Cache operation latency",
			ConstLabels: labels,
			Buckets:     []float64{.0001, .0005, .001, .005, .01, .05, .1},
		}),
	}
	return m
}

// HitRate computes the cache hit rate for alerting.
// Alert when hit_rate < 0.80 for a sustained period.
```

```promql
# Cache hit rate
rate(cache_hits_total[5m]) /
(rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))

# Cache error rate
rate(cache_errors_total[5m])

# Alert: low hit rate
(rate(cache_hits_total[10m]) / (rate(cache_hits_total[10m]) + rate(cache_misses_total[10m]))) < 0.80
```

## Section 9: Redis Lua Scripts for Atomic Operations

Complex cache operations that require atomicity use Lua scripts:

```go
// Atomic check-and-set with TTL refresh
var refreshIfExpiredScript = redis.NewScript(`
local key = KEYS[1]
local new_value = ARGV[1]
local ttl = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])

local remaining = redis.call('TTL', key)
if remaining < threshold then
    redis.call('SET', key, new_value, 'EX', ttl)
    return 1  -- refreshed
end
return 0  -- not refreshed (still fresh)
`)

func AtomicRefreshIfExpired(ctx context.Context, client *redis.Client, key, newValue string, ttl, threshold time.Duration) (bool, error) {
	result, err := refreshIfExpiredScript.Run(ctx, client, []string{key},
		newValue,
		int64(ttl.Seconds()),
		int64(threshold.Seconds()),
	).Int()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

// Rate limiting with Lua
var rateLimitScript = redis.NewScript(`
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local current = redis.call('GET', key)
if current == false then
    redis.call('SET', key, 1, 'EX', window)
    return {1, limit}
elseif tonumber(current) < limit then
    return {redis.call('INCR', key), limit}
else
    return {tonumber(current), limit}
end
`)

func CheckRateLimit(ctx context.Context, client *redis.Client, key string, limit int, window time.Duration) (current int, allowed bool, err error) {
	result, err := rateLimitScript.Run(ctx, client, []string{key},
		limit,
		int64(window.Seconds()),
	).Int64Slice()
	if err != nil {
		return 0, true, err // fail open on Redis errors
	}
	current = int(result[0])
	return current, current <= int(result[1]), nil
}
```

Caching strategy selection depends on your consistency requirements, failure tolerance, and read/write ratio. In-process caches with singleflight are the right starting point for most Go microservices. Redis becomes necessary when cache state must be shared across multiple pods or when the in-process cache would consume too much heap. The multi-level pattern combining both provides the best throughput while maintaining acceptable consistency guarantees.
