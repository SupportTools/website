---
title: "Go Caching Strategies: In-Memory LRU, Redis Cluster, Cache-Aside Pattern, and Cache Invalidation"
date: 2028-08-29T00:00:00-05:00
draft: false
tags: ["Go", "Caching", "Redis", "LRU", "Cache-Aside", "Performance"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to caching in Go: implementing LRU caches, integrating Redis Cluster, the cache-aside pattern with stampede prevention, cache invalidation strategies, and production monitoring."
more_link: "yes"
url: "/go-caching-lru-redis-cache-aside-guide/"
---

Caching is one of the highest-leverage optimizations in distributed systems. A well-implemented cache can reduce database load by 90%, cut API latency from milliseconds to microseconds, and dramatically improve throughput. A poorly implemented cache causes subtle bugs: stale data serving incorrect results, cache stampedes bringing down the database, and memory leaks that OOM-kill production services.

This guide covers Go caching from fundamentals to production: in-memory LRU caches, Redis Cluster integration, the cache-aside pattern with proper stampede prevention, cache invalidation strategies, and operational monitoring.

<!--more-->

# [Go Caching Strategies: LRU, Redis, and Cache-Aside Pattern](#go-caching-strategies)

## Section 1: In-Memory LRU Cache

### Why LRU?

An LRU (Least Recently Used) cache evicts the entry that was accessed least recently when capacity is reached. This is optimal for workloads with temporal locality — recently accessed data is likely to be accessed again.

### Using golang-lru

```bash
go get github.com/hashicorp/golang-lru/v2@latest
```

```go
package cache

import (
	"fmt"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
)

// CacheEntry wraps a value with an expiry
type CacheEntry[V any] struct {
	Value     V
	ExpiresAt time.Time
}

func (e CacheEntry[V]) IsExpired() bool {
	return !e.ExpiresAt.IsZero() && time.Now().After(e.ExpiresAt)
}

// TTLCache is an LRU cache with per-entry TTL support
type TTLCache[K comparable, V any] struct {
	lru  *lru.Cache[K, CacheEntry[V]]
	mu   sync.Mutex
	defaultTTL time.Duration
}

func NewTTLCache[K comparable, V any](size int, defaultTTL time.Duration) (*TTLCache[K, V], error) {
	l, err := lru.New[K, CacheEntry[V]](size)
	if err != nil {
		return nil, err
	}
	return &TTLCache[K, V]{
		lru:        l,
		defaultTTL: defaultTTL,
	}, nil
}

func (c *TTLCache[K, V]) Set(key K, value V) {
	c.SetWithTTL(key, value, c.defaultTTL)
}

func (c *TTLCache[K, V]) SetWithTTL(key K, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := CacheEntry[V]{
		Value:     value,
		ExpiresAt: time.Now().Add(ttl),
	}
	c.lru.Add(key, entry)
}

func (c *TTLCache[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.lru.Get(key)
	if !ok {
		var zero V
		return zero, false
	}

	if entry.IsExpired() {
		c.lru.Remove(key)
		var zero V
		return zero, false
	}

	return entry.Value, true
}

func (c *TTLCache[K, V]) Delete(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lru.Remove(key)
}

func (c *TTLCache[K, V]) Len() int {
	return c.lru.Len()
}

// Purge removes all expired entries (call periodically)
func (c *TTLCache[K, V]) Purge() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	var expired []K
	for _, key := range c.lru.Keys() {
		if entry, ok := c.lru.Peek(key); ok && entry.IsExpired() {
			expired = append(expired, key)
		}
	}
	for _, key := range expired {
		c.lru.Remove(key)
	}
	return len(expired)
}
```

### LRU Cache with Metrics

```go
package cache

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

type InstrumentedCache[K comparable, V any] struct {
	cache *TTLCache[K, V]
	name  string

	hits        prometheus.Counter
	misses      prometheus.Counter
	evictions   prometheus.Counter
	size        prometheus.Gauge
}

func NewInstrumentedCache[K comparable, V any](
	name string,
	size int,
	defaultTTL time.Duration,
) (*InstrumentedCache[K, V], error) {
	c, err := NewTTLCache[K, V](size, defaultTTL)
	if err != nil {
		return nil, err
	}

	labels := prometheus.Labels{"cache": name}

	return &InstrumentedCache[K, V]{
		cache: c,
		name:  name,
		hits: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_hits_total",
			Help: "Total number of cache hits",
		}, []string{"cache"}).With(labels),
		misses: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_misses_total",
			Help: "Total number of cache misses",
		}, []string{"cache"}).With(labels),
		size: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cache_size",
			Help: "Current number of items in cache",
		}, []string{"cache"}).With(labels),
	}, nil
}

func (c *InstrumentedCache[K, V]) Get(key K) (V, bool) {
	value, ok := c.cache.Get(key)
	if ok {
		c.hits.Inc()
	} else {
		c.misses.Inc()
	}
	return value, ok
}

func (c *InstrumentedCache[K, V]) Set(key K, value V) {
	c.cache.Set(key, value)
	c.size.Set(float64(c.cache.Len()))
}

// HitRate calculates the cache hit rate
func HitRate(hits, misses float64) float64 {
	total := hits + misses
	if total == 0 {
		return 0
	}
	return hits / total
}
```

## Section 2: Redis Client Setup

### Installation and Connection Pool

```bash
go get github.com/redis/go-redis/v9@latest
```

```go
package rediscache

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type Config struct {
	// Single node
	Addr     string
	Password string
	DB       int

	// Cluster mode
	ClusterAddrs []string

	// Connection pool
	PoolSize     int
	MinIdleConns int
	MaxIdleConns int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	PoolTimeout  time.Duration
}

func NewClient(cfg Config) (redis.UniversalClient, error) {
	var client redis.UniversalClient

	if len(cfg.ClusterAddrs) > 0 {
		client = redis.NewClusterClient(&redis.ClusterOptions{
			Addrs:        cfg.ClusterAddrs,
			Password:     cfg.Password,
			PoolSize:     cfg.PoolSize,
			MinIdleConns: cfg.MinIdleConns,
			DialTimeout:  cfg.DialTimeout,
			ReadTimeout:  cfg.ReadTimeout,
			WriteTimeout: cfg.WriteTimeout,
			PoolTimeout:  cfg.PoolTimeout,
			// Read from replicas for GET operations
			RouteRandomly: false,
			ReadOnly:      false,
		})
	} else {
		client = redis.NewClient(&redis.Options{
			Addr:         cfg.Addr,
			Password:     cfg.Password,
			DB:           cfg.DB,
			PoolSize:     cfg.PoolSize,
			MinIdleConns: cfg.MinIdleConns,
			MaxIdleConns: cfg.MaxIdleConns,
			DialTimeout:  cfg.DialTimeout,
			ReadTimeout:  cfg.ReadTimeout,
			WriteTimeout: cfg.WriteTimeout,
			PoolTimeout:  cfg.PoolTimeout,
		})
	}

	// Verify connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("connecting to Redis: %w", err)
	}

	return client, nil
}
```

### Type-Safe Redis Cache Layer

```go
package rediscache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrCacheMiss = errors.New("cache miss")

type Cache[V any] struct {
	client redis.UniversalClient
	prefix string
	ttl    time.Duration
}

func New[V any](client redis.UniversalClient, prefix string, ttl time.Duration) *Cache[V] {
	return &Cache[V]{
		client: client,
		prefix: prefix,
		ttl:    ttl,
	}
}

func (c *Cache[V]) key(k string) string {
	return fmt.Sprintf("%s:%s", c.prefix, k)
}

func (c *Cache[V]) Get(ctx context.Context, key string) (V, error) {
	data, err := c.client.Get(ctx, c.key(key)).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			var zero V
			return zero, ErrCacheMiss
		}
		var zero V
		return zero, fmt.Errorf("redis get %q: %w", key, err)
	}

	var value V
	if err := json.Unmarshal(data, &value); err != nil {
		var zero V
		return zero, fmt.Errorf("unmarshaling cache value for %q: %w", key, err)
	}

	return value, nil
}

func (c *Cache[V]) Set(ctx context.Context, key string, value V) error {
	return c.SetWithTTL(ctx, key, value, c.ttl)
}

func (c *Cache[V]) SetWithTTL(ctx context.Context, key string, value V, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshaling cache value for %q: %w", key, err)
	}

	if err := c.client.Set(ctx, c.key(key), data, ttl).Err(); err != nil {
		return fmt.Errorf("redis set %q: %w", key, err)
	}

	return nil
}

func (c *Cache[V]) Delete(ctx context.Context, keys ...string) error {
	fullKeys := make([]string, len(keys))
	for i, k := range keys {
		fullKeys[i] = c.key(k)
	}

	if err := c.client.Del(ctx, fullKeys...).Err(); err != nil {
		return fmt.Errorf("redis del: %w", err)
	}
	return nil
}

func (c *Cache[V]) MGet(ctx context.Context, keys []string) (map[string]V, error) {
	fullKeys := make([]string, len(keys))
	for i, k := range keys {
		fullKeys[i] = c.key(k)
	}

	results, err := c.client.MGet(ctx, fullKeys...).Result()
	if err != nil {
		return nil, fmt.Errorf("redis mget: %w", err)
	}

	out := make(map[string]V, len(keys))
	for i, result := range results {
		if result == nil {
			continue
		}
		var value V
		if err := json.Unmarshal([]byte(result.(string)), &value); err != nil {
			continue // Skip unmarshal errors
		}
		out[keys[i]] = value
	}

	return out, nil
}

// MSet sets multiple keys atomically using MSET
func (c *Cache[V]) MSet(ctx context.Context, items map[string]V, ttl time.Duration) error {
	if len(items) == 0 {
		return nil
	}

	pipe := c.client.Pipeline()
	for key, value := range items {
		data, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("marshaling %q: %w", key, err)
		}
		pipe.Set(ctx, c.key(key), data, ttl)
	}

	_, err := pipe.Exec(ctx)
	return err
}
```

## Section 3: Cache-Aside Pattern

The cache-aside pattern is the most common caching pattern:
1. Check cache first
2. On hit: return cached value
3. On miss: fetch from source, store in cache, return value

The key challenge is preventing the **thundering herd** (cache stampede): when many goroutines simultaneously discover a cache miss and all issue backend requests.

### Basic Cache-Aside Without Stampede Prevention

```go
func (s *ProductService) GetProduct(ctx context.Context, id string) (*Product, error) {
	// Check cache
	if cached, err := s.cache.Get(ctx, id); err == nil {
		return cached, nil
	}

	// Cache miss: fetch from database
	product, err := s.db.GetProduct(ctx, id)
	if err != nil {
		return nil, err
	}

	// Store in cache (best effort)
	_ = s.cache.Set(ctx, id, product)

	return product, nil
}
// PROBLEM: Under high load, many goroutines will simultaneously miss
// the cache and all hit the database for the same key.
```

### Cache-Aside with Singleflight (Stampede Prevention)

```go
package service

import (
	"context"
	"fmt"

	"golang.org/x/sync/singleflight"

	"github.com/myorg/api/internal/domain"
)

type ProductService struct {
	cache *rediscache.Cache[*domain.Product]
	db    *store.Store
	group singleflight.Group  // Deduplicates in-flight requests
}

func (s *ProductService) GetProduct(ctx context.Context, id string) (*domain.Product, error) {
	// Check L1 cache (in-memory)
	if product, ok := s.l1Cache.Get(id); ok {
		return product, nil
	}

	// Check L2 cache (Redis) and deduplicate concurrent misses
	key := fmt.Sprintf("product:%s", id)
	result, err, _ := s.group.Do(key, func() (any, error) {
		// Only one goroutine per key executes this block
		// Others wait and get the same result

		// Check Redis cache
		product, err := s.cache.Get(ctx, id)
		if err == nil {
			return product, nil
		}
		if !errors.Is(err, rediscache.ErrCacheMiss) {
			return nil, fmt.Errorf("cache get: %w", err)
		}

		// Cache miss: fetch from database
		product, err = s.db.GetProduct(ctx, id)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				// Cache negative results too (prevents DB hammering for non-existent keys)
				s.cache.SetWithTTL(ctx, "404:"+id, nil, 30*time.Second)
			}
			return nil, err
		}

		// Store in Redis cache
		if err := s.cache.Set(ctx, id, product); err != nil {
			slog.WarnContext(ctx, "Failed to cache product", "id", id, "error", err)
			// Don't fail the request on cache write error
		}

		// Store in L1 cache
		s.l1Cache.Set(id, product)

		return product, nil
	})

	if err != nil {
		return nil, err
	}

	return result.(*domain.Product), nil
}
```

### Multi-Level Cache (L1 Memory + L2 Redis)

```go
package cache

import (
	"context"
	"errors"
	"time"
)

// TwoLevelCache implements L1 (in-process) + L2 (Redis) caching
type TwoLevelCache[V any] struct {
	l1     *TTLCache[string, V]
	l2     *rediscache.Cache[V]
	l1TTL  time.Duration
	l2TTL  time.Duration
	group  singleflight.Group
}

func NewTwoLevelCache[V any](
	l1Size int, l1TTL time.Duration,
	rdb redis.UniversalClient, prefix string, l2TTL time.Duration,
) (*TwoLevelCache[V], error) {
	l1, err := NewTTLCache[string, V](l1Size, l1TTL)
	if err != nil {
		return nil, err
	}

	return &TwoLevelCache[V]{
		l1:    l1,
		l2:    rediscache.New[V](rdb, prefix, l2TTL),
		l1TTL: l1TTL,
		l2TTL: l2TTL,
	}, nil
}

func (c *TwoLevelCache[V]) GetOrLoad(
	ctx context.Context,
	key string,
	loader func(ctx context.Context) (V, error),
) (V, error) {
	// L1 check (no network, fastest)
	if value, ok := c.l1.Get(key); ok {
		return value, nil
	}

	// L2 + load: deduplicated with singleflight
	result, err, _ := c.group.Do(key, func() (any, error) {
		// Re-check L1 (another goroutine may have populated it)
		if value, ok := c.l1.Get(key); ok {
			return value, nil
		}

		// L2 check (Redis)
		value, err := c.l2.Get(ctx, key)
		if err == nil {
			c.l1.Set(key, value)
			return value, nil
		}
		if !errors.Is(err, rediscache.ErrCacheMiss) {
			// Redis error: fall through to loader (fail open)
			slog.WarnContext(ctx, "L2 cache error, falling through",
				"key", key, "error", err)
		}

		// Load from source
		value, err = loader(ctx)
		if err != nil {
			return nil, err
		}

		// Write to both caches
		c.l1.Set(key, value)
		if setErr := c.l2.Set(ctx, key, value); setErr != nil {
			slog.WarnContext(ctx, "Failed to set L2 cache", "key", key, "error", setErr)
		}

		return value, nil
	})

	if err != nil {
		var zero V
		return zero, err
	}

	return result.(V), nil
}

func (c *TwoLevelCache[V]) Invalidate(ctx context.Context, key string) error {
	c.l1.Delete(key)
	return c.l2.Delete(ctx, key)
}
```

## Section 4: Cache Invalidation Strategies

Cache invalidation is famously hard. Here are the main strategies and when to use each.

### Strategy 1: TTL-Based Expiry

Simplest approach — entries expire automatically. Stale data exists for up to TTL duration.

```go
// Set TTL based on data update frequency
const (
	productCacheTTL = 1 * time.Hour      // Products change rarely
	userCacheTTL    = 15 * time.Minute    // User profiles change occasionally
	priceCacheTTL   = 30 * time.Second   // Prices change frequently
	stockCacheTTL   = 5 * time.Second    // Stock levels change very frequently
)
```

### Strategy 2: Write-Through (Invalidate on Write)

When writing data, immediately invalidate (or update) the cache:

```go
func (s *ProductService) UpdateProduct(
	ctx context.Context,
	id string,
	update *domain.ProductUpdate,
) (*domain.Product, error) {
	// Update in database
	product, err := s.db.UpdateProduct(ctx, id, update)
	if err != nil {
		return nil, err
	}

	// Immediately invalidate cache (or update it)
	if err := s.cache.Delete(ctx, id); err != nil {
		slog.WarnContext(ctx, "Failed to invalidate cache after update",
			"id", id, "error", err)
		// Don't fail the request — cache will expire naturally
	}

	// Or update the cache instead of deleting:
	if err := s.cache.Set(ctx, id, product); err != nil {
		slog.WarnContext(ctx, "Failed to update cache after update", "id", id, "error", err)
	}

	return product, nil
}
```

### Strategy 3: Tag-Based Invalidation with Redis

When a single write should invalidate multiple related cache entries:

```go
package cache

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// TaggedCache supports tag-based cache invalidation
// When a tag is invalidated, all entries with that tag are deleted
type TaggedCache struct {
	client redis.UniversalClient
	prefix string
}

func NewTaggedCache(client redis.UniversalClient, prefix string) *TaggedCache {
	return &TaggedCache{client: client, prefix: prefix}
}

func (tc *TaggedCache) keyName(key string) string {
	return fmt.Sprintf("%s:data:%s", tc.prefix, key)
}

func (tc *TaggedCache) tagName(tag string) string {
	return fmt.Sprintf("%s:tag:%s", tc.prefix, tag)
}

// Set stores a value and associates it with tags
func (tc *TaggedCache) Set(
	ctx context.Context,
	key string,
	value []byte,
	ttl time.Duration,
	tags ...string,
) error {
	pipe := tc.client.Pipeline()

	// Store the value
	pipe.Set(ctx, tc.keyName(key), value, ttl)

	// Add key to each tag's set
	for _, tag := range tags {
		pipe.SAdd(ctx, tc.tagName(tag), tc.keyName(key))
		pipe.Expire(ctx, tc.tagName(tag), ttl+5*time.Minute) // Tag outlives entries
	}

	_, err := pipe.Exec(ctx)
	return err
}

// InvalidateTag deletes all entries associated with a tag
func (tc *TaggedCache) InvalidateTag(ctx context.Context, tag string) error {
	tagKey := tc.tagName(tag)

	// Get all keys with this tag
	keys, err := tc.client.SMembers(ctx, tagKey).Result()
	if err != nil {
		return fmt.Errorf("getting tag members: %w", err)
	}

	if len(keys) == 0 {
		return nil
	}

	// Delete all tagged entries and the tag itself
	toDelete := append(keys, tagKey)
	return tc.client.Del(ctx, toDelete...).Err()
}
```

```go
// Usage: tag product entries by category
productJSON, _ := json.Marshal(product)
tc.Set(ctx, "product:123", productJSON, 1*time.Hour,
	"category:electronics",
	"brand:acme",
	"product:123",
)

// When the electronics category changes, invalidate all electronics products
tc.InvalidateTag(ctx, "category:electronics")
```

### Strategy 4: Event-Driven Invalidation with Redis Pub/Sub

```go
package cache

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

type InvalidationEvent struct {
	Type string   `json:"type"`
	Keys []string `json:"keys"`
	Tags []string `json:"tags"`
}

const invalidationChannel = "cache:invalidation"

type InvalidationListener struct {
	client redis.UniversalClient
	l1Cache *TTLCache[string, any]
}

func (il *InvalidationListener) Listen(ctx context.Context) {
	pubsub := il.client.Subscribe(ctx, invalidationChannel)
	defer pubsub.Close()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-pubsub.Channel():
			if !ok {
				return
			}
			il.handleMessage(msg.Payload)
		}
	}
}

func (il *InvalidationListener) handleMessage(payload string) {
	var event InvalidationEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		slog.Warn("Invalid invalidation event", "payload", payload)
		return
	}

	for _, key := range event.Keys {
		il.l1Cache.Delete(key)
	}
	slog.Debug("Cache invalidation applied", "keys", len(event.Keys))
}

func PublishInvalidation(ctx context.Context, client redis.UniversalClient, keys ...string) error {
	event := InvalidationEvent{
		Type: "invalidate",
		Keys: keys,
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return client.Publish(ctx, invalidationChannel, data).Err()
}
```

## Section 5: Redis Pipeline and Batch Operations

### Batch Loading with Pipelines

```go
func (s *ProductService) GetProducts(ctx context.Context, ids []string) ([]*domain.Product, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Try to get all from Redis in one round-trip
	cachedProducts, err := s.cache.MGet(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "Batch cache get failed", "error", err)
		cachedProducts = make(map[string]*domain.Product)
	}

	// Find missing keys
	var missingIDs []string
	for _, id := range ids {
		if _, ok := cachedProducts[id]; !ok {
			missingIDs = append(missingIDs, id)
		}
	}

	if len(missingIDs) > 0 {
		// Fetch missing from database in batch
		dbProducts, err := s.db.GetProductsByIDs(ctx, missingIDs)
		if err != nil {
			return nil, fmt.Errorf("fetching products from DB: %w", err)
		}

		// Cache fetched products
		toCache := make(map[string]*domain.Product, len(dbProducts))
		for _, p := range dbProducts {
			cachedProducts[p.ID] = p
			toCache[p.ID] = p
		}

		if err := s.cache.MSet(ctx, toCache, 1*time.Hour); err != nil {
			slog.WarnContext(ctx, "Failed to cache products batch", "error", err)
		}
	}

	// Return in original order
	result := make([]*domain.Product, 0, len(ids))
	for _, id := range ids {
		if p, ok := cachedProducts[id]; ok {
			result = append(result, p)
		}
	}

	return result, nil
}
```

### Rate-Limited Cache Warming

```go
package cache

import (
	"context"
	"time"

	"golang.org/x/time/rate"
)

type CacheWarmer[K comparable, V any] struct {
	cache   *TwoLevelCache[V]
	loader  func(ctx context.Context, key K) (V, error)
	limiter *rate.Limiter
}

func NewCacheWarmer[K comparable, V any](
	cache *TwoLevelCache[V],
	loader func(ctx context.Context, key K) (V, error),
	rps float64,
) *CacheWarmer[K, V] {
	return &CacheWarmer[K, V]{
		cache:   cache,
		loader:  loader,
		limiter: rate.NewLimiter(rate.Limit(rps), int(rps)),
	}
}

func (w *CacheWarmer[K, V]) Warm(ctx context.Context, keys []K) error {
	for _, key := range keys {
		if err := w.limiter.Wait(ctx); err != nil {
			return err
		}

		keyStr := fmt.Sprintf("%v", key)
		value, err := w.loader(ctx, key)
		if err != nil {
			slog.WarnContext(ctx, "Cache warm failed for key", "key", key, "error", err)
			continue
		}

		if err := w.cache.l2.Set(ctx, keyStr, value); err != nil {
			slog.WarnContext(ctx, "Failed to set warm value", "key", key, "error", err)
		}
	}
	return nil
}
```

## Section 6: Probabilistic Early Expiration (PER)

TTL-based expiry causes a spike of cache misses when many keys expire simultaneously. Probabilistic Early Expiration refreshes a cache entry before it expires, proportional to how close it is to expiry.

```go
package cache

import (
	"math"
	"math/rand"
	"time"
)

// ProbabilisticEarlyRefresh implements XFetch (PER) algorithm.
// Returns true if the cache entry should be refreshed early.
// beta: higher beta = more aggressive early refresh (1.0 is standard)
// delta: seconds it took to compute the value (cost of cache miss)
// expiresAt: when the cached value expires
func ShouldRefreshEarly(expiresAt time.Time, delta time.Duration, beta float64) bool {
	// XFetch formula: -delta * beta * log(rand())
	// This generates a "virtual expiry time" earlier than the real expiry
	now := time.Now()
	ttlRemaining := expiresAt.Sub(now).Seconds()
	if ttlRemaining <= 0 {
		return true // Already expired
	}

	// Random early refresh probability increases as expiry approaches
	virtualExpiry := now.Add(
		time.Duration(-delta.Seconds()*beta*math.Log(rand.Float64())*float64(time.Second)),
	)

	return virtualExpiry.After(expiresAt)
}

// Usage in cache-aside:
func (s *ProductService) GetProductPER(ctx context.Context, id string) (*domain.Product, error) {
	type CachedProduct struct {
		Product   *domain.Product
		ExpiresAt time.Time
		Delta     time.Duration  // Time it took to load from DB
	}

	cached, err := s.rawCache.Get(ctx, id)
	if err == nil {
		// Check if we should refresh early (PER algorithm)
		if !ShouldRefreshEarly(cached.ExpiresAt, cached.Delta, 1.0) {
			return cached.Product, nil
		}
		// Fall through to refresh in background while returning stale value
		go s.refreshInBackground(context.Background(), id)
		return cached.Product, nil  // Return stale, fresh will be ready soon
	}

	// Full cache miss — load synchronously
	start := time.Now()
	product, err := s.db.GetProduct(ctx, id)
	if err != nil {
		return nil, err
	}
	delta := time.Since(start)

	// Store with delta for PER calculation
	s.rawCache.Set(ctx, id, CachedProduct{
		Product:   product,
		ExpiresAt: time.Now().Add(1 * time.Hour),
		Delta:     delta,
	})

	return product, nil
}
```

## Section 7: Cache-Aside for Distributed Rate Limiting

Redis is ideal for distributed rate limiting:

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// SlidingWindowRateLimiter uses a sorted set to implement a sliding window
type SlidingWindowRateLimiter struct {
	client redis.UniversalClient
	limit  int
	window time.Duration
}

func NewSlidingWindowLimiter(client redis.UniversalClient, limit int, window time.Duration) *SlidingWindowRateLimiter {
	return &SlidingWindowRateLimiter{
		client: client,
		limit:  limit,
		window: window,
	}
}

func (l *SlidingWindowRateLimiter) Allow(ctx context.Context, key string) (bool, int, error) {
	now := time.Now()
	windowStart := now.Add(-l.window)

	pipe := l.client.Pipeline()

	// Remove old entries outside the window
	pipe.ZRemRangeByScore(ctx, key,
		"-inf",
		fmt.Sprintf("%d", windowStart.UnixNano()),
	)

	// Add current request
	pipe.ZAdd(ctx, key, redis.Z{
		Score:  float64(now.UnixNano()),
		Member: fmt.Sprintf("%d", now.UnixNano()),
	})

	// Count requests in window
	countCmd := pipe.ZCard(ctx, key)

	// Set expiry (cleanup)
	pipe.Expire(ctx, key, l.window+time.Second)

	if _, err := pipe.Exec(ctx); err != nil {
		return false, 0, fmt.Errorf("rate limit check: %w", err)
	}

	count := int(countCmd.Val())
	remaining := l.limit - count
	if remaining < 0 {
		remaining = 0
	}

	return count <= l.limit, remaining, nil
}
```

## Section 8: Cache Monitoring and Alerting

### Prometheus Metrics for Redis

```go
package monitoring

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"
)

type RedisMonitor struct {
	client    redis.UniversalClient
	connected prometheus.Gauge
	poolHits  prometheus.Counter
	poolMiss  prometheus.Counter
	cmdDur    *prometheus.HistogramVec
}

func NewRedisMonitor(client redis.UniversalClient, name string) *RedisMonitor {
	labels := prometheus.Labels{"redis": name}

	return &RedisMonitor{
		client: client,
		connected: promauto.NewGauge(prometheus.GaugeOpts{
			Name:        "redis_connected",
			Help:        "Whether Redis connection is healthy",
			ConstLabels: labels,
		}),
		cmdDur: promauto.NewHistogramVec(prometheus.HistogramOpts{
			Name:        "redis_command_duration_seconds",
			Help:        "Redis command duration",
			ConstLabels: labels,
			Buckets:     []float64{.0001, .0005, .001, .005, .01, .05, .1, .5, 1},
		}, []string{"cmd"}),
	}
}

func (m *RedisMonitor) Collect(ctx context.Context) {
	if err := m.client.Ping(ctx).Err(); err != nil {
		m.connected.Set(0)
	} else {
		m.connected.Set(1)
	}

	// Pool stats (for redis.Client, not cluster)
	if c, ok := m.client.(*redis.Client); ok {
		stats := c.PoolStats()
		promauto.NewGauge(prometheus.GaugeOpts{
			Name: "redis_pool_hits_total",
		}).Set(float64(stats.Hits))
	}
}
```

### Prometheus Alert Rules for Cache

```yaml
groups:
- name: cache-alerts
  rules:
  - alert: LowCacheHitRate
    expr: |
      rate(cache_hits_total[5m])
      / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))
      < 0.8
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Cache hit rate below 80% for {{ $labels.cache }}"
      description: "Current rate: {{ $value | humanizePercentage }}"

  - alert: RedisDown
    expr: redis_connected == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Redis connection lost: {{ $labels.redis }}"

  - alert: HighCacheErrorRate
    expr: |
      rate(cache_errors_total[5m]) > 0.01
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High cache error rate: {{ $labels.cache }}"

  - alert: RedisMemoryHigh
    expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Redis memory usage > 85%"
```

## Section 9: Testing Cache Behavior

```go
package cache_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestRedis(t *testing.T) redis.UniversalClient {
	t.Helper()
	mr := miniredis.RunT(t)
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

func TestTTLCacheExpiry(t *testing.T) {
	cache, err := NewTTLCache[string, string](100, 100*time.Millisecond)
	require.NoError(t, err)

	cache.Set("key1", "value1")

	// Should be present immediately
	val, ok := cache.Get("key1")
	assert.True(t, ok)
	assert.Equal(t, "value1", val)

	// Should expire after TTL
	time.Sleep(150 * time.Millisecond)
	_, ok = cache.Get("key1")
	assert.False(t, ok, "entry should have expired")
}

func TestCacheAside_NegativeCaching(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	cache := New[*Product](client, "test", 5*time.Minute)

	ctx := context.Background()
	callCount := 0

	load := func(ctx context.Context) (*Product, error) {
		callCount++
		return nil, ErrNotFound
	}

	// First call: cache miss, calls loader
	var twoLevel TwoLevelCache[*Product]
	twoLevel.GetOrLoad(ctx, "nonexistent", load)
	assert.Equal(t, 1, callCount)

	// Second call in quick succession: should use singleflight dedup
	// (not test negative caching here specifically — that's implementation detail)
	twoLevel.GetOrLoad(ctx, "nonexistent", load)
	assert.LessOrEqual(t, callCount, 2) // At most 2 calls
}

func TestRedisCache_MGet(t *testing.T) {
	client := setupTestRedis(t)
	cache := New[string](client, "test", time.Minute)
	ctx := context.Background()

	// Set multiple values
	require.NoError(t, cache.Set(ctx, "a", "alpha"))
	require.NoError(t, cache.Set(ctx, "b", "bravo"))
	require.NoError(t, cache.Set(ctx, "c", "charlie"))

	// Get multiple — includes one that doesn't exist
	results, err := cache.MGet(ctx, []string{"a", "b", "c", "d"})
	require.NoError(t, err)

	assert.Equal(t, "alpha", results["a"])
	assert.Equal(t, "bravo", results["b"])
	assert.Equal(t, "charlie", results["c"])
	assert.NotContains(t, results, "d")  // Missing key not in result
}
```

## Section 10: Production Deployment Checklist

### Redis Configuration for Production

```bash
# /etc/redis/redis.conf key settings

# Memory management
maxmemory 4gb
maxmemory-policy allkeys-lru       # Evict LRU keys when memory full

# Persistence (disable for pure cache)
save ""                             # Disable RDB snapshots
appendonly no                       # Disable AOF

# Connection settings
tcp-backlog 511
timeout 300
tcp-keepalive 60
maxclients 10000

# Performance
hz 20                               # More frequent background tasks
aof-use-rdb-preamble yes
lazyfree-lazy-eviction yes          # Async eviction (prevents latency spikes)
lazyfree-lazy-expire yes
lazyfree-lazy-server-del yes

# Security
requirepass "your-strong-password"
rename-command FLUSHALL ""          # Disable dangerous commands
rename-command FLUSHDB ""
rename-command DEBUG ""
rename-command CONFIG ""
```

### Cache Capacity Planning

```bash
# Estimate cache size needed
# Cache hit rate formula: 1 - (DB_CAPACITY / TOTAL_REQUESTS)
# For 90% hit rate with 1M daily requests:
# Need to cache 900K/day = ~10 requests/sec are cached

# Memory estimation
# Average object size: 1KB
# Target: 100K objects in L1, 1M objects in Redis
# L1: 100K * 1KB = ~100MB (in-process)
# L2: 1M * 1KB = ~1GB Redis (add 50% overhead for Redis metadata)

# Monitor eviction rate
redis-cli info stats | grep evicted_keys
# If eviction rate is high, increase maxmemory or reduce TTLs
```

### Summary of Caching Patterns

| Pattern | Use Case | Consistency |
|---------|----------|-------------|
| TTL Expiry | Eventual consistency acceptable | Eventual (TTL) |
| Write-Through | Strong consistency needed | Near-real-time |
| Write-Behind | Write-heavy workloads | Eventual |
| Read-Through | Transparent caching | Eventual (TTL) |
| Cache-Aside + Singleflight | High read traffic, stampede prevention | Eventual |
| Tag-Based Invalidation | Hierarchical data relationships | Event-driven |
| Pub/Sub Invalidation | Multi-instance L1 synchronization | Event-driven |

The cache-aside pattern with singleflight is the most commonly correct choice: it prevents stampedes, allows fail-open behavior when the cache is unavailable, and gives you full control over loading logic. Two-level caching (L1 in-memory + L2 Redis) eliminates network overhead for hot keys while providing shared state across instances.
