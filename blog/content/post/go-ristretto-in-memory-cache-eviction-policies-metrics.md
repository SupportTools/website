---
title: "Go: Building High-Performance In-Memory Caches with Ristretto: Eviction Policies and Metrics"
date: 2031-07-05T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Cache", "Ristretto", "Performance", "Redis"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to building production-grade in-memory caches in Go using Ristretto, covering admission policies, TinyLFU eviction, concurrent access patterns, metrics collection, and cache warming strategies."
more_link: "yes"
url: "/go-ristretto-in-memory-cache-eviction-policies-metrics/"
---

In-memory caching is one of the highest-leverage performance optimizations available to Go services. The choice of caching library matters: a naive `sync.Map` has excellent concurrency but no eviction, `bigcache` optimizes for byte slice values but lacks cost-aware eviction, and `groupcache` requires a cluster. Ristretto, developed by the Dgraph team, provides admission control, TinyLFU eviction, and detailed metrics while achieving near-optimal hit rates. This post covers Ristretto configuration, integration patterns, and operational best practices.

<!--more-->

# Go: Building High-Performance In-Memory Caches with Ristretto: Eviction Policies and Metrics

## Why Cache Eviction Policy Matters

Cache hit rate is the single most important cache metric. A cache with a 90% hit rate reduces backend load by 10x; a cache with a 50% hit rate only reduces it by 2x.

The eviction policy determines which items are removed when the cache is full. Common policies:

| Policy | Description | Optimal For |
|--------|-------------|-------------|
| FIFO | Remove oldest item | Rarely optimal |
| LRU | Remove least recently used | Workloads with temporal locality |
| LFU | Remove least frequently used | Workloads with stable access patterns |
| W-TinyLFU | Window TinyLFU (Ristretto's policy) | Most real-world workloads |

W-TinyLFU maintains frequency sketches (probabilistic counters) for all observed keys and uses them to decide whether a new item is worth evicting an existing item. Items with high access frequency survive; items accessed only once are admitted to a small "probationary" window and then evicted if not accessed again. This matches most production access patterns: a small number of "hot" items are accessed frequently, while most items are accessed rarely.

## Ristretto Core Concepts

Ristretto uses cost-based capacity rather than count-based:

```go
// Traditional LRU cache: "hold N items"
cache := lru.New(1000)

// Ristretto: "hold items up to total cost C"
cache, _ := ristretto.NewCache(&ristretto.Config{
    MaxCost:     1 << 30,  // 1 GB total cost
    NumCounters: 1e7,      // track frequency of 10M keys
    BufferItems: 64,       // keys per Get buffer
})
// Each item's cost = its size in bytes
```

This allows the cache to hold millions of small items or thousands of large items within the same memory budget, without manual tuning of item counts.

## Basic Setup

```go
// cache/cache.go
package cache

import (
	"fmt"
	"time"

	"github.com/dgraph-io/ristretto"
)

// Config holds tunable parameters for the cache.
type Config struct {
	// MaxCost is the maximum total cost (bytes) of items in the cache.
	MaxCost int64
	// NumCounters is the number of frequency counters to maintain.
	// Rule of thumb: 10x the expected number of unique items.
	NumCounters int64
	// BufferItems is the number of keys in a single Get buffer.
	// 64 is recommended by Ristretto's authors.
	BufferItems int64
	// DefaultTTL is the TTL for items set without an explicit TTL.
	// 0 means items don't expire.
	DefaultTTL time.Duration
}

// DefaultConfig returns a configuration suitable for a service with
// moderate memory pressure and mixed item sizes.
func DefaultConfig() Config {
	return Config{
		MaxCost:     512 * 1024 * 1024, // 512 MB
		NumCounters: 5_000_000,         // 5M frequency counters
		BufferItems: 64,
		DefaultTTL:  5 * time.Minute,
	}
}

// Cache wraps ristretto.Cache with typed methods and metrics.
type Cache[K comparable, V any] struct {
	inner      *ristretto.Cache
	defaultTTL time.Duration
	costFn     func(V) int64
	metrics    *CacheMetrics
}

// NewCache creates a new typed cache.
// costFn computes the cost (in bytes) of a single value.
// If costFn is nil, a cost of 1 is used for every item.
func NewCache[K comparable, V any](cfg Config, costFn func(V) int64) (*Cache[K, V], error) {
	if costFn == nil {
		costFn = func(V) int64 { return 1 }
	}

	inner, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: cfg.NumCounters,
		MaxCost:     cfg.MaxCost,
		BufferItems: cfg.BufferItems,
		// Metrics must be enabled for Prometheus export
		Metrics: true,
		// OnEvict is called when an item is evicted
		OnEvict: func(item *ristretto.Item) {
			// Optionally: trigger a back-fill or log the eviction
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creating ristretto cache: %w", err)
	}

	return &Cache[K, V]{
		inner:      inner,
		defaultTTL: cfg.DefaultTTL,
		costFn:     costFn,
		metrics:    newCacheMetrics(),
	}, nil
}

// Get retrieves a value from the cache.
// Returns (value, true) if found, (zero, false) otherwise.
func (c *Cache[K, V]) Get(key K) (V, bool) {
	val, found := c.inner.Get(key)
	if !found {
		c.metrics.misses.Inc()
		var zero V
		return zero, false
	}
	c.metrics.hits.Inc()
	return val.(V), true
}

// Set stores a value in the cache using the configured TTL.
// Returns true if the item was admitted to the cache.
// Note: Set is non-blocking and admission happens asynchronously.
func (c *Cache[K, V]) Set(key K, value V) bool {
	cost := c.costFn(value)
	var admitted bool
	if c.defaultTTL > 0 {
		admitted = c.inner.SetWithTTL(key, value, cost, c.defaultTTL)
	} else {
		admitted = c.inner.Set(key, value, cost)
	}
	if admitted {
		c.metrics.sets.Inc()
	} else {
		c.metrics.rejections.Inc()
	}
	return admitted
}

// SetWithTTL stores a value with an explicit TTL.
func (c *Cache[K, V]) SetWithTTL(key K, value V, ttl time.Duration) bool {
	cost := c.costFn(value)
	admitted := c.inner.SetWithTTL(key, value, cost, ttl)
	if admitted {
		c.metrics.sets.Inc()
	}
	return admitted
}

// Delete removes a value from the cache.
func (c *Cache[K, V]) Delete(key K) {
	c.inner.Del(key)
}

// Clear removes all items from the cache.
func (c *Cache[K, V]) Clear() {
	c.inner.Clear()
}

// Wait blocks until all pending Set operations have been processed.
// Important for testing: Set is asynchronous, so Wait ensures items are
// visible before assertions.
func (c *Cache[K, V]) Wait() {
	c.inner.Wait()
}

// Stats returns current cache statistics from Ristretto's internal metrics.
func (c *Cache[K, V]) Stats() *ristretto.Metrics {
	return c.inner.Metrics
}

// Close releases resources held by the cache.
func (c *Cache[K, V]) Close() {
	c.inner.Close()
}
```

## Cost Functions

The cost function is critical for correct cache sizing. Poor cost functions lead to the cache holding fewer or more items than expected.

```go
// cache/costs.go
package cache

import (
	"reflect"
	"unsafe"
)

// StringCost estimates the memory cost of a string.
// Accounts for string header (16 bytes) + content.
func StringCost(s string) int64 {
	return int64(len(s)) + 16
}

// ByteSliceCost estimates the cost of a byte slice.
func ByteSliceCost(b []byte) int64 {
	return int64(cap(b)) + 24 // 24 bytes for slice header
}

// StructCost uses reflection to estimate the size of a struct.
// For performance-critical code, prefer manually specifying costs.
func StructCost(v interface{}) int64 {
	return int64(reflect.TypeOf(v).Size()) + 64 // 64 bytes overhead estimate
}

// JSONResponseCost estimates the cost of an HTTP JSON response
// by summing the serialized body length plus metadata overhead.
type CachedResponse struct {
	Body       []byte
	StatusCode int
	Headers    map[string]string
	CachedAt   time.Time
}

func ResponseCost(r CachedResponse) int64 {
	var headerSize int64
	for k, v := range r.Headers {
		headerSize += int64(len(k) + len(v) + 2)
	}
	return ByteSliceCost(r.Body) + headerSize + 64
}
```

## GetOrSet: Cache-Aside Pattern

The cache-aside pattern is the most common cache usage: check cache, on miss fetch from source, store in cache. The challenge in concurrent systems is the "thundering herd" problem: many goroutines miss simultaneously and all fetch from the backend.

Ristretto does not include a built-in `GetOrSet` with singleflight. Add one using `golang.org/x/sync/singleflight`:

```go
// cache/loader.go
package cache

import (
	"context"
	"fmt"

	"golang.org/x/sync/singleflight"
)

// LoadFunc is a function that fetches a value for a key from the backing store.
type LoadFunc[K comparable, V any] func(ctx context.Context, key K) (V, error)

// LoadingCache wraps Cache with a singleflight loader to prevent thundering herd.
type LoadingCache[K comparable, V any] struct {
	cache  *Cache[K, V]
	loader LoadFunc[K, V]
	group  singleflight.Group
}

// NewLoadingCache wraps an existing Cache with a singleflight loader.
func NewLoadingCache[K comparable, V any](
	cache *Cache[K, V],
	loader LoadFunc[K, V],
) *LoadingCache[K, V] {
	return &LoadingCache[K, V]{
		cache:  cache,
		loader: loader,
	}
}

// Get retrieves a value from the cache or loads it from the backing store.
// Multiple concurrent calls for the same key will result in only one call
// to the loader (singleflight deduplication).
func (c *LoadingCache[K, V]) Get(ctx context.Context, key K) (V, error) {
	// Fast path: cache hit
	if val, ok := c.cache.Get(key); ok {
		return val, nil
	}

	// Slow path: load from backing store, deduplicated by singleflight
	keyStr := fmt.Sprintf("%v", key)
	result, err, _ := c.group.Do(keyStr, func() (interface{}, error) {
		// Double-check the cache now that we have the group lock
		// (another goroutine may have populated it while we were waiting)
		if val, ok := c.cache.Get(key); ok {
			return val, nil
		}

		val, err := c.loader(ctx, key)
		if err != nil {
			return nil, err
		}

		c.cache.Set(key, val)
		// Wait ensures the item is visible to subsequent Get calls
		c.cache.Wait()

		return val, nil
	})

	if err != nil {
		var zero V
		return zero, err
	}

	return result.(V), nil
}

// Invalidate removes an item from the cache and prevents singleflight
// from returning a stale value for in-flight requests.
func (c *LoadingCache[K, V]) Invalidate(key K) {
	c.cache.Delete(key)
}

// Refresh forces a reload of a key regardless of cache state.
func (c *LoadingCache[K, V]) Refresh(ctx context.Context, key K) (V, error) {
	c.cache.Delete(key)
	return c.Get(ctx, key)
}
```

## Real-World Example: API Response Cache

```go
// service/user_service.go
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/myorg/myapp/cache"
	"github.com/myorg/myapp/database"
)

type User struct {
	ID        string
	Email     string
	Name      string
	Roles     []string
	CreatedAt time.Time
}

type UserService struct {
	db    *database.DB
	cache *cache.LoadingCache[string, *User]
}

func NewUserService(db *database.DB) *UserService {
	// Estimate user struct cost: ~200 bytes average
	userCostFn := func(u *User) int64 {
		if u == nil {
			return 0
		}
		cost := int64(200) // base struct overhead
		cost += int64(len(u.Email) + len(u.Name))
		for _, r := range u.Roles {
			cost += int64(len(r))
		}
		return cost
	}

	cfg := cache.Config{
		MaxCost:     100 * 1024 * 1024, // 100 MB for user cache
		NumCounters: 1_000_000,         // expect up to 100K unique users
		BufferItems: 64,
		DefaultTTL:  15 * time.Minute,
	}

	userCache, _ := cache.NewCache[string, *User](cfg, userCostFn)

	svc := &UserService{db: db}
	svc.cache = cache.NewLoadingCache(userCache, svc.loadUserFromDB)
	return svc
}

func (s *UserService) GetUser(ctx context.Context, userID string) (*User, error) {
	return s.cache.Get(ctx, userID)
}

func (s *UserService) UpdateUser(ctx context.Context, user *User) error {
	if err := s.db.UpdateUser(ctx, user); err != nil {
		return err
	}
	// Invalidate cache on write
	s.cache.Invalidate(user.ID)
	return nil
}

func (s *UserService) loadUserFromDB(ctx context.Context, userID string) (*User, error) {
	user, err := s.db.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("loading user %s from database: %w", userID, err)
	}
	return user, nil
}
```

## Multi-Level Cache: L1 (in-process) + L2 (Redis)

For services where in-process cache misses are too expensive:

```go
// cache/multilevel.go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// MultiLevelCache implements a two-tier cache:
//   L1: Ristretto (in-process, low latency)
//   L2: Redis (shared across instances, larger capacity)
type MultiLevelCache[K comparable, V any] struct {
	l1     *Cache[K, V]
	l2     *redis.Client
	ttlL1  time.Duration
	ttlL2  time.Duration
	prefix string
	encode func(V) ([]byte, error)
	decode func([]byte) (V, error)
}

func NewMultiLevelCache[K comparable, V any](
	l1 *Cache[K, V],
	l2 *redis.Client,
	prefix string,
	ttlL1, ttlL2 time.Duration,
	encode func(V) ([]byte, error),
	decode func([]byte) (V, error),
) *MultiLevelCache[K, V] {
	return &MultiLevelCache[K, V]{
		l1: l1, l2: l2,
		prefix: prefix,
		ttlL1: ttlL1, ttlL2: ttlL2,
		encode: encode, decode: decode,
	}
}

func (c *MultiLevelCache[K, V]) Get(ctx context.Context, key K) (V, bool, error) {
	// L1 lookup (in-process, ~100ns)
	if val, ok := c.l1.Get(key); ok {
		return val, true, nil
	}

	// L2 lookup (Redis, ~1ms)
	redisKey := fmt.Sprintf("%s:%v", c.prefix, key)
	data, err := c.l2.Get(ctx, redisKey).Bytes()
	if err == redis.Nil {
		var zero V
		return zero, false, nil
	}
	if err != nil {
		var zero V
		return zero, false, fmt.Errorf("redis get: %w", err)
	}

	val, err := c.decode(data)
	if err != nil {
		var zero V
		return zero, false, fmt.Errorf("decoding cached value: %w", err)
	}

	// Backfill L1 from L2 hit
	c.l1.SetWithTTL(key, val, c.ttlL1)

	return val, true, nil
}

func (c *MultiLevelCache[K, V]) Set(ctx context.Context, key K, val V) error {
	// Write to both levels
	c.l1.SetWithTTL(key, val, c.ttlL1)

	data, err := c.encode(val)
	if err != nil {
		return fmt.Errorf("encoding value: %w", err)
	}

	redisKey := fmt.Sprintf("%s:%v", c.prefix, key)
	return c.l2.Set(ctx, redisKey, data, c.ttlL2).Err()
}

func (c *MultiLevelCache[K, V]) Delete(ctx context.Context, key K) error {
	c.l1.Delete(key)
	redisKey := fmt.Sprintf("%s:%v", c.prefix, key)
	return c.l2.Del(ctx, redisKey).Err()
}
```

## Cache Warming

Cold starts are painful. Warm the cache from a persistent snapshot on startup:

```go
// cache/warmer.go
package cache

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"go.uber.org/zap"
)

// WarmupRecord is a serializable cache entry for snapshot persistence.
type WarmupRecord[K comparable, V any] struct {
	Key       K         `json:"key"`
	Value     V         `json:"value"`
	ExpiresAt time.Time `json:"expires_at"`
}

// SaveSnapshot writes cache contents to a gzip-compressed JSON file.
// This must be called by the application which has access to the underlying data.
func SaveSnapshot[K comparable, V any](
	records []WarmupRecord[K, V],
	path string,
) error {
	f, err := os.CreateTemp("", "cache-snapshot-*.json.gz")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)

	for _, rec := range records {
		if err := enc.Encode(rec); err != nil {
			return fmt.Errorf("encoding record: %w", err)
		}
	}

	if err := gz.Close(); err != nil {
		return fmt.Errorf("closing gzip writer: %w", err)
	}

	return os.Rename(f.Name(), path)
}

// LoadSnapshot warms the cache from a previously saved snapshot file.
func LoadSnapshot[K comparable, V any](
	c *Cache[K, V],
	path string,
	logger *zap.Logger,
) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil // No snapshot to load
		}
		return 0, fmt.Errorf("opening snapshot: %w", err)
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, fmt.Errorf("reading gzip: %w", err)
	}
	defer gz.Close()

	scanner := bufio.NewScanner(gz)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024) // 10MB max line

	loaded := 0
	now := time.Now()

	for scanner.Scan() {
		var rec WarmupRecord[K, V]
		if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
			logger.Warn("skipping malformed snapshot record", zap.Error(err))
			continue
		}

		// Skip expired items
		if !rec.ExpiresAt.IsZero() && rec.ExpiresAt.Before(now) {
			continue
		}

		ttl := time.Duration(0)
		if !rec.ExpiresAt.IsZero() {
			ttl = time.Until(rec.ExpiresAt)
		}

		if ttl > 0 {
			c.SetWithTTL(rec.Key, rec.Value, ttl)
		} else {
			c.Set(rec.Key, rec.Value)
		}
		loaded++
	}

	c.Wait()

	logger.Info("cache warmed from snapshot",
		zap.String("path", path),
		zap.Int("items_loaded", loaded),
	)

	return loaded, scanner.Err()
}
```

## Prometheus Metrics Integration

```go
// cache/metrics.go
package cache

import (
	"sync/atomic"

	"github.com/dgraph-io/ristretto"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// CacheMetrics tracks application-level cache statistics.
type CacheMetrics struct {
	hits       atomic.Int64
	misses     atomic.Int64
	sets       atomic.Int64
	rejections atomic.Int64
}

func newCacheMetrics() *CacheMetrics {
	return &CacheMetrics{}
}

// CacheCollector implements prometheus.Collector for a named cache.
type CacheCollector struct {
	name    string
	appMetrics *CacheMetrics
	inner   *ristretto.Cache

	hitRatio    *prometheus.Desc
	missRatio   *prometheus.Desc
	costUsed    *prometheus.Desc
	costMax     *prometheus.Desc
	setsDropped *prometheus.Desc
	keysAdded   *prometheus.Desc
	keysEvicted *prometheus.Desc
}

func NewCacheCollector(name string, appMetrics *CacheMetrics, inner *ristretto.Cache) *CacheCollector {
	labels := prometheus.Labels{"cache": name}
	makeDesc := func(name, help string) *prometheus.Desc {
		return prometheus.NewDesc(
			"cache_"+name,
			help,
			nil, labels,
		)
	}

	return &CacheCollector{
		name:       name,
		appMetrics: appMetrics,
		inner:      inner,
		hitRatio:    makeDesc("hit_ratio", "Cache hit ratio (0-1)"),
		missRatio:   makeDesc("miss_ratio", "Cache miss ratio (0-1)"),
		costUsed:    makeDesc("cost_used_bytes", "Total cost of items in cache"),
		costMax:     makeDesc("cost_max_bytes", "Maximum configured cache cost"),
		setsDropped: makeDesc("sets_dropped_total", "Total sets rejected by admission policy"),
		keysAdded:   makeDesc("keys_added_total", "Total keys added to cache"),
		keysEvicted: makeDesc("keys_evicted_total", "Total keys evicted from cache"),
	}
}

func (c *CacheCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.hitRatio
	ch <- c.missRatio
	ch <- c.costUsed
	ch <- c.costMax
	ch <- c.setsDropped
	ch <- c.keysAdded
	ch <- c.keysEvicted
}

func (c *CacheCollector) Collect(ch chan<- prometheus.Metric) {
	m := c.inner.Metrics

	hits := float64(m.Hits())
	misses := float64(m.Misses())
	total := hits + misses

	hitRatio := 0.0
	missRatio := 0.0
	if total > 0 {
		hitRatio = hits / total
		missRatio = misses / total
	}

	ch <- prometheus.MustNewConstMetric(c.hitRatio, prometheus.GaugeValue, hitRatio)
	ch <- prometheus.MustNewConstMetric(c.missRatio, prometheus.GaugeValue, missRatio)
	ch <- prometheus.MustNewConstMetric(c.costUsed, prometheus.GaugeValue, float64(m.CostAdded()-m.CostEvicted()))
	ch <- prometheus.MustNewConstMetric(c.setsDropped, prometheus.CounterValue, float64(m.SetsDropped()))
	ch <- prometheus.MustNewConstMetric(c.keysAdded, prometheus.CounterValue, float64(m.KeysAdded()))
	ch <- prometheus.MustNewConstMetric(c.keysEvicted, prometheus.CounterValue, float64(m.KeysEvicted()))
}

// RegisterCacheMetrics registers a cache's Prometheus collector.
func RegisterCacheMetrics[K comparable, V any](name string, c *Cache[K, V]) {
	collector := NewCacheCollector(name, c.metrics, c.inner)
	prometheus.MustRegister(collector)
}
```

## Testing Cache Behavior

```go
// cache/cache_test.go
package cache_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/myorg/myapp/cache"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCache_BasicGetSet(t *testing.T) {
	c, err := cache.NewCache[string, string](
		cache.Config{MaxCost: 1024, NumCounters: 1000, BufferItems: 64},
		cache.StringCost,
	)
	require.NoError(t, err)
	defer c.Close()

	c.Set("key1", "value1")
	c.Wait() // Ensure async Set is processed

	val, ok := c.Get("key1")
	assert.True(t, ok)
	assert.Equal(t, "value1", val)

	_, ok = c.Get("nonexistent")
	assert.False(t, ok)
}

func TestCache_TTLExpiration(t *testing.T) {
	c, err := cache.NewCache[string, string](
		cache.Config{
			MaxCost:     1024,
			NumCounters: 1000,
			BufferItems: 64,
			DefaultTTL:  50 * time.Millisecond,
		},
		cache.StringCost,
	)
	require.NoError(t, err)
	defer c.Close()

	c.Set("key1", "value1")
	c.Wait()

	// Should exist immediately
	_, ok := c.Get("key1")
	assert.True(t, ok)

	// Should expire after TTL
	time.Sleep(100 * time.Millisecond)
	_, ok = c.Get("key1")
	assert.False(t, ok)
}

func TestLoadingCache_SingleflightDeduplication(t *testing.T) {
	var loadCount atomic.Int64
	var loadDelay = 50 * time.Millisecond

	inner, _ := cache.NewCache[string, string](
		cache.Config{MaxCost: 1024, NumCounters: 1000, BufferItems: 64, DefaultTTL: time.Minute},
		cache.StringCost,
	)

	lc := cache.NewLoadingCache(inner, func(ctx context.Context, key string) (string, error) {
		loadCount.Add(1)
		time.Sleep(loadDelay) // Simulate slow load
		return "value-for-" + key, nil
	})

	// Launch 10 concurrent Gets for the same key
	var wg sync.WaitGroup
	results := make([]string, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			val, err := lc.Get(context.Background(), "shared-key")
			require.NoError(t, err)
			results[idx] = val
		}(i)
	}
	wg.Wait()

	// All results should be the same value
	for _, r := range results {
		assert.Equal(t, "value-for-shared-key", r)
	}

	// Loader should have been called only once (singleflight)
	assert.Equal(t, int64(1), loadCount.Load())
}

func TestLoadingCache_LoaderErrorPropagation(t *testing.T) {
	inner, _ := cache.NewCache[string, string](
		cache.Config{MaxCost: 1024, NumCounters: 1000, BufferItems: 64},
		cache.StringCost,
	)

	expectedErr := errors.New("database unavailable")
	lc := cache.NewLoadingCache(inner, func(ctx context.Context, key string) (string, error) {
		return "", expectedErr
	})

	_, err := lc.Get(context.Background(), "any-key")
	assert.ErrorIs(t, err, expectedErr)
}
```

## Operational Tuning Guidelines

### NumCounters Sizing

Ristretto's frequency sketches are 4-bit counters stored in a Count-Min Sketch. The optimal `NumCounters` value:

```
NumCounters = max_unique_keys_in_working_set * 10

# If your cache holds ~100K unique items at any time:
NumCounters = 1_000_000

# Memory used by NumCounters:
# Each counter = 4 bits = 0.5 bytes
# NumCounters counters = NumCounters / 2 bytes
# 1_000_000 counters = ~512 KB
```

### MaxCost Sizing

Set `MaxCost` based on available memory and expected item sizes:

```
# Rule of thumb for a service using 2 GB memory budget:
# L1 cache: 200 MB (in-process Ristretto)
# Application heap + overhead: 1.8 GB

# Measure average item cost from production metrics:
avg_item_cost = cache_cost_used_bytes / cache_keys_added_total

# Then:
MaxCost = target_item_count * avg_item_cost
```

### Admission Policy Behavior

Ristretto uses a probabilistic admission policy (TinyLFU) that may reject items. Monitor `cache_sets_dropped_total` — if this is high, either:
1. Your `MaxCost` is too small for your working set
2. Your items are being replaced by higher-frequency items (expected behavior)
3. Your cost function overestimates item sizes

## Conclusion

Ristretto's cost-based, admission-controlled design delivers near-optimal cache performance for most real-world access patterns without manual tuning of item counts or replacement ratios. The typed generic wrapper shown here eliminates type assertion overhead in the hot path while preserving Ristretto's performance characteristics. For services where in-process memory is insufficient, the multi-level cache pattern with Redis as L2 provides a coherent two-tier solution without requiring a full cache coherency protocol. The most important operational principle remains cache observability: hit ratio, cost utilization, and eviction rate tell you whether your cache configuration matches your workload's actual access patterns.
