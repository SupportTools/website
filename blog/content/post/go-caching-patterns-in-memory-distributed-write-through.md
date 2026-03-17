---
title: "Go Caching Patterns: In-Memory, Distributed, and Write-Through"
date: 2029-05-30T00:00:00-05:00
draft: false
tags: ["Go", "Caching", "Redis", "Performance", "Distributed Systems", "Golang", "Ristretto"]
categories: ["Go", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Go caching patterns covering groupcache, bigcache, ristretto, Redis as L2 cache, cache invalidation strategies, LRU/LFU/ARC eviction, and cache stampede prevention for production services."
more_link: "yes"
url: "/go-caching-patterns-in-memory-distributed-write-through/"
---

Caching is where most Go services find their greatest performance leverage. A well-implemented cache layer can reduce database load by 90% and cut p99 latency from hundreds of milliseconds to single digits. But cache implementation is subtle: every strategy comes with consistency tradeoffs, failure modes, and operational complexity. This guide covers the full spectrum from in-process in-memory caches through distributed multi-tier architectures, with production-ready Go code throughout.

<!--more-->

# Go Caching Patterns: In-Memory, Distributed, and Write-Through

## Choosing the Right Cache Library

Go's ecosystem has several mature in-process cache libraries, each optimized for different workloads.

| Library | Eviction | Concurrency | Size bound | Best for |
|---|---|---|---|---|
| `sync.Map` + custom | LRU manual | Lock-free reads | Entry count | Simple, low-volume |
| `groupcache` | LRU | Singleflight + distributed | Byte-based | Read-heavy, singleflight |
| `bigcache` | FIFO segments | Lock per segment | Byte-based | High-throughput, large entries |
| `ristretto` | TinyLFU | Striped counters | Byte-based | Mixed read/write, admission filter |
| `patrickmn/go-cache` | Manual TTL | RWMutex | Entry count | Small caches with TTL |

## Building a Production LRU Cache

Before reaching for a library, understand the fundamentals by implementing a simple thread-safe LRU:

```go
package cache

import (
	"container/list"
	"sync"
	"time"
)

type entry[K comparable, V any] struct {
	key       K
	value     V
	expiresAt time.Time
}

// LRU is a generic, thread-safe LRU cache with optional TTL.
type LRU[K comparable, V any] struct {
	mu       sync.Mutex
	capacity int
	list     *list.List
	items    map[K]*list.Element
}

func NewLRU[K comparable, V any](capacity int) *LRU[K, V] {
	return &LRU[K, V]{
		capacity: capacity,
		list:     list.New(),
		items:    make(map[K]*list.Element, capacity),
	}
}

func (c *LRU[K, V]) Set(key K, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	exp := time.Time{}
	if ttl > 0 {
		exp = time.Now().Add(ttl)
	}

	if elem, ok := c.items[key]; ok {
		c.list.MoveToFront(elem)
		elem.Value.(*entry[K, V]).value = value
		elem.Value.(*entry[K, V]).expiresAt = exp
		return
	}

	if c.list.Len() >= c.capacity {
		c.evict()
	}

	e := &entry[K, V]{key: key, value: value, expiresAt: exp}
	elem := c.list.PushFront(e)
	c.items[key] = elem
}

func (c *LRU[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		var zero V
		return zero, false
	}

	e := elem.Value.(*entry[K, V])
	if !e.expiresAt.IsZero() && time.Now().After(e.expiresAt) {
		c.removeElement(elem)
		var zero V
		return zero, false
	}

	c.list.MoveToFront(elem)
	return e.value, true
}

func (c *LRU[K, V]) Delete(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		c.removeElement(elem)
	}
}

func (c *LRU[K, V]) evict() {
	back := c.list.Back()
	if back != nil {
		c.removeElement(back)
	}
}

func (c *LRU[K, V]) removeElement(elem *list.Element) {
	c.list.Remove(elem)
	e := elem.Value.(*entry[K, V])
	delete(c.items, e.key)
}

func (c *LRU[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.list.Len()
}
```

## Ristretto: Production-Grade In-Process Cache

Ristretto from Dgraph implements TinyLFU admission policy, which provides near-optimal hit ratios in production workloads. Its key properties:

- Admission filter using a Count-Min Sketch frequency counter — items that have never been seen before are not cached
- Lock-free admission via a ring buffer with goroutine consumers
- Cost-based eviction — you assign a "cost" to each item and set a max total cost
- Background drop policy — writes are non-blocking, items may be silently dropped under load

```go
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/dgraph-io/ristretto"
)

type UserProfile struct {
	ID       int64
	Name     string
	Email    string
	Settings map[string]string
}

type UserCache struct {
	cache *ristretto.Cache[string, *UserProfile]
}

func NewUserCache() (*UserCache, error) {
	cache, err := ristretto.NewCache(&ristretto.Config[string, *UserProfile]{
		// NumCounters: 10x the max number of items you expect
		NumCounters: 1_000_000,
		// MaxCost: total memory budget in bytes
		MaxCost: 100 << 20, // 100 MB
		// BufferItems: size of the ring buffer for incoming writes
		BufferItems: 64,
		// Metrics: enable for observability
		Metrics: true,
		// Cost function: estimate item size in bytes
		Cost: func(value *UserProfile) int64 {
			// Rough size estimate
			cost := int64(64) // base struct
			cost += int64(len(value.Name) + len(value.Email))
			for k, v := range value.Settings {
				cost += int64(len(k) + len(v))
			}
			return cost
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creating ristretto cache: %w", err)
	}
	return &UserCache{cache: cache}, nil
}

func (c *UserCache) Set(profile *UserProfile, ttl time.Duration) bool {
	key := fmt.Sprintf("user:%d", profile.ID)
	return c.cache.SetWithTTL(key, profile, 0, ttl)
}

func (c *UserCache) Get(userID int64) (*UserProfile, bool) {
	key := fmt.Sprintf("user:%d", userID)
	return c.cache.Get(key)
}

func (c *UserCache) Delete(userID int64) {
	key := fmt.Sprintf("user:%d", userID)
	c.cache.Del(key)
}

func (c *UserCache) Metrics() *ristretto.Metrics {
	return c.cache.Metrics
}

// Usage with metrics logging
func monitorCacheHealth(ctx context.Context, cache *UserCache) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m := cache.Metrics()
			fmt.Printf("cache: hits=%d misses=%d ratio=%.3f cost_added=%d cost_evicted=%d\n",
				m.Hits(), m.Misses(), m.Ratio(), m.CostAdded(), m.CostEvicted())
		}
	}
}
```

## BigCache: High-Throughput with Minimal GC Pressure

BigCache avoids GC overhead by storing cache entries in pre-allocated byte slices, eliminating per-entry heap allocations. It uses a segmented lock approach (256 segments by default) to reduce contention.

```go
package cache

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/allegro/bigcache/v3"
)

type BigCacheWrapper[V any] struct {
	cache *bigcache.BigCache
}

func NewBigCache[V any](maxSizeMB int, defaultTTL time.Duration) (*BigCacheWrapper[V], error) {
	config := bigcache.Config{
		// Shards: must be a power of two
		Shards: 1024,
		// LifeWindow: TTL for entries
		LifeWindow: defaultTTL,
		// CleanWindow: how often expired entries are removed
		CleanWindow: 5 * time.Minute,
		// MaxEntriesInWindow: approximate expected throughput for initial allocation
		MaxEntriesInWindow: 1000 * 10 * 60,
		// MaxEntrySize: max size per entry in bytes (for initial buffer sizing)
		MaxEntrySize: 500,
		// HardMaxCacheSize: max total size in MB, 0 = unlimited
		HardMaxCacheSize: maxSizeMB,
		// OnRemove: optional callback on eviction
		OnRemove: func(key string, entry []byte) {
			// Can be used for cache-aside invalidation
		},
		// StatsEnabled: expose hit/miss counters
		StatsEnabled: true,
	}

	bc, err := bigcache.New(config)
	if err != nil {
		return nil, fmt.Errorf("creating bigcache: %w", err)
	}
	return &BigCacheWrapper[V]{cache: bc}, nil
}

func (c *BigCacheWrapper[V]) Set(key string, value V) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshaling value for key %q: %w", key, err)
	}
	return c.cache.Set(key, data)
}

func (c *BigCacheWrapper[V]) Get(key string) (V, error) {
	var zero V
	data, err := c.cache.Get(key)
	if err != nil {
		if errors.Is(err, bigcache.ErrEntryNotFound) {
			return zero, ErrCacheMiss
		}
		return zero, fmt.Errorf("getting key %q: %w", key, err)
	}
	var value V
	if err := json.Unmarshal(data, &value); err != nil {
		return zero, fmt.Errorf("unmarshaling value for key %q: %w", key, err)
	}
	return value, nil
}

func (c *BigCacheWrapper[V]) Delete(key string) error {
	return c.cache.Delete(key)
}

var ErrCacheMiss = errors.New("cache miss")

func (c *BigCacheWrapper[V]) Stats() bigcache.Stats {
	return c.cache.Stats()
}
```

## Groupcache: Distributed Singleflight Cache

Groupcache eliminates the thundering herd problem at scale by ensuring that for any given key, exactly one node in the cluster fetches from the origin, while all other nodes wait for that result. It uses consistent hashing to route requests.

```go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/mailgun/groupcache/v2"
)

type ProductCache struct {
	group *groupcache.Group
}

type Product struct {
	ID          string
	Name        string
	Price       float64
	Description string
}

func NewProductCache(
	selfAddr string,
	peers []string,
	maxCacheBytes int64,
	fetcher func(ctx context.Context, id string) (*Product, error),
) *ProductCache {

	// Register HTTP handler for inter-node communication
	http.Handle("/_groupcache/", groupcache.NewHTTPPoolOpts(
		selfAddr,
		&groupcache.HTTPPoolOptions{},
	))

	// Configure peers
	pool := groupcache.NewHTTPPoolOpts(selfAddr, &groupcache.HTTPPoolOptions{})
	pool.Set(peers...)

	group := groupcache.NewGroup("products", maxCacheBytes,
		groupcache.GetterFunc(func(ctx context.Context, key string, dest groupcache.Sink) error {
			product, err := fetcher(ctx, key)
			if err != nil {
				return fmt.Errorf("fetching product %q: %w", key, err)
			}
			data, err := json.Marshal(product)
			if err != nil {
				return fmt.Errorf("marshaling product %q: %w", key, err)
			}
			return dest.SetBytes(data, time.Now().Add(5*time.Minute))
		}),
	)

	return &ProductCache{group: group}
}

func (c *ProductCache) Get(ctx context.Context, productID string) (*Product, error) {
	var data []byte
	if err := c.group.Get(ctx, productID, groupcache.AllocatingByteSliceSink(&data)); err != nil {
		return nil, fmt.Errorf("getting product %q from groupcache: %w", productID, err)
	}
	var product Product
	if err := json.Unmarshal(data, &product); err != nil {
		return nil, fmt.Errorf("unmarshaling product %q: %w", productID, err)
	}
	return &product, nil
}

// Stats returns groupcache statistics for observability
func (c *ProductCache) Stats() groupcache.Stats {
	return c.group.Stats
}
```

## Redis as L2 Cache: Two-Tier Architecture

The most common production pattern uses an in-process L1 cache (ristretto or bigcache) backed by Redis as L2. L1 handles hot keys with nanosecond latency; L2 handles cold reads with microsecond latency and provides cross-process consistency.

```go
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/dgraph-io/ristretto"
	"github.com/redis/go-redis/v9"
)

type TwoTierCache[V any] struct {
	l1  *ristretto.Cache[string, V]
	l2  *redis.Client
	l1TTL time.Duration
	l2TTL time.Duration
}

func NewTwoTierCache[V any](
	redisAddr string,
	l1MaxCostBytes int64,
	l1TTL, l2TTL time.Duration,
) (*TwoTierCache[V], error) {

	l1, err := ristretto.NewCache(&ristretto.Config[string, V]{
		NumCounters: 10_000_000,
		MaxCost:     l1MaxCostBytes,
		BufferItems: 64,
		Metrics:     true,
	})
	if err != nil {
		return nil, fmt.Errorf("creating L1 cache: %w", err)
	}

	l2 := redis.NewClient(&redis.Options{
		Addr:         redisAddr,
		Password:     "",
		DB:           0,
		PoolSize:     20,
		MinIdleConns: 5,
		DialTimeout:  time.Second,
		ReadTimeout:  500 * time.Millisecond,
		WriteTimeout: 500 * time.Millisecond,
	})

	return &TwoTierCache[V]{
		l1:    l1,
		l2:    l2,
		l1TTL: l1TTL,
		l2TTL: l2TTL,
	}, nil
}

// Get checks L1 first, then L2, populating L1 on an L2 hit.
func (c *TwoTierCache[V]) Get(ctx context.Context, key string) (V, error) {
	// L1 check — sub-microsecond
	if value, ok := c.l1.Get(key); ok {
		return value, nil
	}

	// L2 check — sub-millisecond
	data, err := c.l2.Get(ctx, key).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			var zero V
			return zero, ErrCacheMiss
		}
		var zero V
		return zero, fmt.Errorf("L2 get for key %q: %w", key, err)
	}

	var value V
	if err := json.Unmarshal(data, &value); err != nil {
		var zero V
		return zero, fmt.Errorf("unmarshaling L2 value for key %q: %w", key, err)
	}

	// Populate L1 with the L2 hit
	c.l1.SetWithTTL(key, value, 0, c.l1TTL)

	return value, nil
}

// Set writes to both L1 and L2.
func (c *TwoTierCache[V]) Set(ctx context.Context, key string, value V) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshaling value for key %q: %w", key, err)
	}

	// Write to Redis first (source of truth for L2)
	if err := c.l2.Set(ctx, key, data, c.l2TTL).Err(); err != nil {
		return fmt.Errorf("L2 set for key %q: %w", key, err)
	}

	// Write to L1 (best-effort, non-blocking)
	c.l1.SetWithTTL(key, value, 0, c.l1TTL)

	return nil
}

// Delete removes from both tiers.
func (c *TwoTierCache[V]) Delete(ctx context.Context, key string) error {
	c.l1.Del(key)
	if err := c.l2.Del(ctx, key).Err(); err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("L2 delete for key %q: %w", key, err)
	}
	return nil
}

// GetOrSet implements the cache-aside pattern with single-flight protection.
func (c *TwoTierCache[V]) GetOrSet(
	ctx context.Context,
	key string,
	fetch func(ctx context.Context) (V, error),
) (V, error) {
	if value, err := c.Get(ctx, key); err == nil {
		return value, nil
	} else if !errors.Is(err, ErrCacheMiss) {
		var zero V
		return zero, err
	}

	// Cache miss: fetch from origin
	value, err := fetch(ctx)
	if err != nil {
		var zero V
		return zero, fmt.Errorf("fetching origin for key %q: %w", key, err)
	}

	// Store in both tiers (non-blocking L1 write is fine here)
	if setErr := c.Set(ctx, key, value); setErr != nil {
		// Log but don't fail the request
		fmt.Printf("warning: failed to populate cache for key %q: %v\n", key, setErr)
	}

	return value, nil
}
```

## Cache Invalidation Strategies

Cache invalidation is, famously, one of the two hard problems in computer science. The right strategy depends on your consistency requirements.

### TTL-Based Expiry (Eventual Consistency)

The simplest approach. Stale reads are possible within the TTL window:

```go
package cache

import (
	"context"
	"time"
)

// StaleTolerantCache accepts stale reads up to staleTTL duration.
type StaleTolerantCache[V any] struct {
	inner *TwoTierCache[V]
}

func (c *StaleTolerantCache[V]) GetStaleOrFetch(
	ctx context.Context,
	key string,
	maxStale time.Duration,
	fetch func(ctx context.Context) (V, error),
) (V, bool, error) {
	// Try L1/L2 with normal TTL
	if value, err := c.inner.Get(ctx, key); err == nil {
		return value, false, nil // fresh hit
	}

	// If we're willing to accept stale data, try an extended TTL key
	staleKey := key + ":stale"
	if value, err := c.inner.Get(ctx, staleKey); err == nil {
		// Trigger async refresh — don't wait for it
		go func() {
			refreshCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			newValue, fetchErr := fetch(refreshCtx)
			if fetchErr == nil {
				_ = c.inner.Set(refreshCtx, key, newValue)
				_ = c.inner.Set(refreshCtx, staleKey, newValue)
			}
		}()
		return value, true, nil // stale hit
	}

	// Full miss — synchronous fetch
	value, err := fetch(ctx)
	if err != nil {
		var zero V
		return zero, false, err
	}
	_ = c.inner.Set(ctx, key, value)
	_ = c.inner.Set(ctx, staleKey, value)
	return value, false, nil
}
```

### Write-Through Cache

Write-through ensures the cache and backing store are always synchronized:

```go
package cache

import (
	"context"
	"fmt"
)

type WriteThrough[K comparable, V any] struct {
	cache    *TwoTierCache[V]
	store    Store[K, V]
	keyFunc  func(K) string
}

// Store is an abstraction over your persistence layer.
type Store[K comparable, V any] interface {
	Get(ctx context.Context, key K) (V, error)
	Set(ctx context.Context, key K, value V) error
	Delete(ctx context.Context, key K) error
}

// Set writes to both the backing store and the cache atomically (store first).
func (wt *WriteThrough[K, V]) Set(ctx context.Context, key K, value V) error {
	// Write to backing store first
	if err := wt.store.Set(ctx, key, value); err != nil {
		return fmt.Errorf("write-through store set for key: %w", err)
	}
	// Then update cache — if this fails, the cache entry will be stale until TTL expiry
	cacheKey := wt.keyFunc(key)
	if err := wt.cache.Set(ctx, cacheKey, value); err != nil {
		// Log and continue — don't fail the write for a cache error
		fmt.Printf("warning: write-through cache set failed for key %q: %v\n", cacheKey, err)
	}
	return nil
}

// Delete removes from cache and backing store.
func (wt *WriteThrough[K, V]) Delete(ctx context.Context, key K) error {
	cacheKey := wt.keyFunc(key)
	// Invalidate cache before store delete to prevent stale reads
	_ = wt.cache.Delete(ctx, cacheKey)
	if err := wt.store.Delete(ctx, key); err != nil {
		return fmt.Errorf("write-through store delete for key: %w", err)
	}
	return nil
}

// Get returns from cache, falling back to store.
func (wt *WriteThrough[K, V]) Get(ctx context.Context, key K) (V, error) {
	cacheKey := wt.keyFunc(key)
	return wt.cache.GetOrSet(ctx, cacheKey, func(ctx context.Context) (V, error) {
		return wt.store.Get(ctx, key)
	})
}
```

### Event-Driven Invalidation via Redis Pub/Sub

For multi-instance deployments where L1 caches are per-process, use Redis pub/sub to broadcast invalidations:

```go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/dgraph-io/ristretto"
	"github.com/redis/go-redis/v9"
)

const invalidationChannel = "cache:invalidations"

type InvalidationMessage struct {
	Keys      []string  `json:"keys"`
	Timestamp time.Time `json:"ts"`
}

type InvalidatingCache[V any] struct {
	l1      *ristretto.Cache[string, V]
	redisClient *redis.Client
}

// PublishInvalidation broadcasts key invalidations to all instances.
func (c *InvalidatingCache[V]) PublishInvalidation(ctx context.Context, keys ...string) error {
	msg := InvalidationMessage{
		Keys:      keys,
		Timestamp: time.Now(),
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshaling invalidation message: %w", err)
	}
	return c.redisClient.Publish(ctx, invalidationChannel, data).Err()
}

// StartInvalidationListener subscribes to Redis invalidation events.
func (c *InvalidatingCache[V]) StartInvalidationListener(ctx context.Context) {
	sub := c.redisClient.Subscribe(ctx, invalidationChannel)
	defer sub.Close()

	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			var inv InvalidationMessage
			if err := json.Unmarshal([]byte(msg.Payload), &inv); err != nil {
				log.Printf("error: unmarshaling invalidation message: %v", err)
				continue
			}
			for _, key := range inv.Keys {
				c.l1.Del(key)
			}
		}
	}
}
```

## Cache Stampede Prevention

The cache stampede (thundering herd) problem occurs when a popular cache entry expires and hundreds of concurrent requests simultaneously try to rebuild it. Solutions:

### Single-Flight (Per-Process)

```go
package cache

import (
	"context"
	"fmt"
	"sync"
)

// SingleFlightCache wraps a cache with singleflight to prevent stampedes.
type SingleFlightCache[V any] struct {
	mu      sync.Mutex
	in_flight map[string]*call[V]
	inner   *TwoTierCache[V]
}

type call[V any] struct {
	wg  sync.WaitGroup
	val V
	err error
}

func (c *SingleFlightCache[V]) GetOrSet(
	ctx context.Context,
	key string,
	fetch func(ctx context.Context) (V, error),
) (V, error) {
	// Fast path: check cache without the flight lock
	if val, err := c.inner.Get(ctx, key); err == nil {
		return val, nil
	}

	// Slow path: deduplicate concurrent fetches
	c.mu.Lock()
	if cl, ok := c.in_flight[key]; ok {
		c.mu.Unlock()
		cl.wg.Wait()
		return cl.val, cl.err
	}

	cl := &call[V]{}
	cl.wg.Add(1)
	if c.in_flight == nil {
		c.in_flight = make(map[string]*call[V])
	}
	c.in_flight[key] = cl
	c.mu.Unlock()

	cl.val, cl.err = func() (V, error) {
		val, err := fetch(ctx)
		if err != nil {
			return val, fmt.Errorf("fetching origin for key %q: %w", key, err)
		}
		_ = c.inner.Set(ctx, key, val)
		return val, nil
	}()

	cl.wg.Done()

	c.mu.Lock()
	delete(c.in_flight, key)
	c.mu.Unlock()

	return cl.val, cl.err
}
```

### Probabilistic Early Expiration (PER)

PER prevents stampedes by stochastically recomputing values before they expire, proportional to how expensive the recomputation is:

```go
package cache

import (
	"context"
	"math"
	"math/rand"
	"time"
)

// PEREntry wraps a cache value with metadata for early recomputation.
type PEREntry[V any] struct {
	Value    V
	Delta    float64   // recomputation time in seconds
	ExpiresAt time.Time
}

// ShouldRecompute implements the XFetch algorithm for probabilistic early expiration.
func ShouldRecompute(delta float64, expiresAt time.Time, beta float64) bool {
	ttl := time.Until(expiresAt).Seconds()
	if ttl <= 0 {
		return true
	}
	// XFetch: recompute with probability proportional to delta/ttl
	return -delta*beta*math.Log(rand.Float64()) >= ttl
}

type PERCache[V any] struct {
	inner     *TwoTierCache[PEREntry[V]]
	beta      float64 // typically 1.0
}

func (c *PERCache[V]) GetOrSet(
	ctx context.Context,
	key string,
	ttl time.Duration,
	fetch func(ctx context.Context) (V, error),
) (V, error) {
	if entry, err := c.inner.Get(ctx, key); err == nil {
		if !ShouldRecompute(entry.Delta, entry.ExpiresAt, c.beta) {
			return entry.Value, nil
		}
		// Probabilistic recompute path — fall through to refresh
	}

	start := time.Now()
	value, err := fetch(ctx)
	if err != nil {
		var zero V
		return zero, err
	}
	delta := time.Since(start).Seconds()
	expiresAt := time.Now().Add(ttl)

	entry := PEREntry[V]{
		Value:     value,
		Delta:     delta,
		ExpiresAt: expiresAt,
	}
	_ = c.inner.Set(ctx, key, entry)
	return value, nil
}
```

## Redis Pipeline and Batch Operations

For read-heavy workloads, batching Redis operations dramatically reduces round-trip overhead:

```go
package cache

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// BatchGet retrieves multiple keys in a single Redis pipeline round-trip.
func BatchGet[V any](ctx context.Context, client *redis.Client, keys []string) (map[string]V, []string, error) {
	if len(keys) == 0 {
		return nil, nil, nil
	}

	pipe := client.Pipeline()
	cmds := make([]*redis.StringCmd, len(keys))
	for i, key := range keys {
		cmds[i] = pipe.Get(ctx, key)
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, nil, fmt.Errorf("pipeline exec: %w", err)
	}

	results := make(map[string]V, len(keys))
	var misses []string

	for i, cmd := range cmds {
		data, err := cmd.Bytes()
		if err != nil {
			if err == redis.Nil {
				misses = append(misses, keys[i])
				continue
			}
			return nil, nil, fmt.Errorf("reading result for key %q: %w", keys[i], err)
		}
		var value V
		if err := json.Unmarshal(data, &value); err != nil {
			return nil, nil, fmt.Errorf("unmarshaling value for key %q: %w", keys[i], err)
		}
		results[keys[i]] = value
	}

	return results, misses, nil
}

// BatchSet writes multiple key-value pairs in a single pipeline.
func BatchSet[V any](
	ctx context.Context,
	client *redis.Client,
	items map[string]V,
	ttl time.Duration,
) error {
	if len(items) == 0 {
		return nil
	}

	pipe := client.Pipeline()
	for key, value := range items {
		data, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("marshaling value for key %q: %w", key, err)
		}
		pipe.Set(ctx, key, data, ttl)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	return nil
}
```

## ARC and LFU Eviction Policies

While LRU is the most common eviction policy, ARC (Adaptive Replacement Cache) adapts between LRU and LFU behavior based on access patterns:

```go
package cache

import (
	"container/list"
	"sync"
)

// ARC implements the Adaptive Replacement Cache algorithm.
// It maintains four internal lists: T1 (recently seen once), T2 (seen more than once),
// B1 (ghost entries for T1), B2 (ghost entries for T2).
type ARC[K comparable, V any] struct {
	mu       sync.Mutex
	capacity int
	p        int // target size for T1

	t1, t2, b1, b2 *list.List
	cache map[K]*list.Element
	ghost map[K]*list.Element
}

type arcEntry[K comparable, V any] struct {
	key   K
	value V
	inT2  bool
}

func NewARC[K comparable, V any](capacity int) *ARC[K, V] {
	return &ARC[K, V]{
		capacity: capacity,
		t1:       list.New(),
		t2:       list.New(),
		b1:       list.New(),
		b2:       list.New(),
		cache:    make(map[K]*list.Element),
		ghost:    make(map[K]*list.Element),
	}
}

func (a *ARC[K, V]) Get(key K) (V, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if elem, ok := a.cache[key]; ok {
		e := elem.Value.(*arcEntry[K, V])
		if !e.inT2 {
			// Move from T1 to T2 (now seen more than once)
			a.t1.Remove(elem)
			e.inT2 = true
			newElem := a.t2.PushFront(e)
			a.cache[key] = newElem
		} else {
			a.t2.MoveToFront(elem)
		}
		return e.value, true
	}
	var zero V
	return zero, false
}

func (a *ARC[K, V]) Set(key K, value V) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if elem, ok := a.cache[key]; ok {
		e := elem.Value.(*arcEntry[K, V])
		e.value = value
		if e.inT2 {
			a.t2.MoveToFront(elem)
		} else {
			a.t1.MoveToFront(elem)
		}
		return
	}

	// Check ghost lists to adapt p
	if _, inB1 := a.ghost[key]; inB1 {
		// Recent miss in T1 ghost — increase T1 target
		delta := 1
		if a.b2.Len() > a.b1.Len() {
			delta = a.b2.Len() / a.b1.Len()
		}
		a.p = min(a.p+delta, a.capacity)
		a.replace(key)
		delete(a.ghost, key)
	} else if _, inB2 := a.ghost[key]; inB2 {
		// Recent miss in T2 ghost — decrease T1 target
		delta := 1
		if a.b1.Len() > a.b2.Len() {
			delta = a.b1.Len() / a.b2.Len()
		}
		a.p = max(a.p-delta, 0)
		a.replace(key)
		delete(a.ghost, key)
	} else if a.t1.Len()+a.t2.Len() >= a.capacity {
		a.replace(key)
	}

	e := &arcEntry[K, V]{key: key, value: value, inT2: false}
	elem := a.t1.PushFront(e)
	a.cache[key] = elem
}

func (a *ARC[K, V]) replace(key K) {
	if a.t1.Len() > 0 && (a.t1.Len() > a.p || (a.t1.Len() == a.p && a.ghostContains(a.b2, key))) {
		// Evict from T1
		back := a.t1.Back()
		if back != nil {
			e := back.Value.(*arcEntry[K, V])
			a.t1.Remove(back)
			delete(a.cache, e.key)
			// Add to B1 ghost
			ghostElem := a.b1.PushFront(&arcEntry[K, V]{key: e.key})
			a.ghost[e.key] = ghostElem
		}
	} else if a.t2.Len() > 0 {
		// Evict from T2
		back := a.t2.Back()
		if back != nil {
			e := back.Value.(*arcEntry[K, V])
			a.t2.Remove(back)
			delete(a.cache, e.key)
			// Add to B2 ghost
			ghostElem := a.b2.PushFront(&arcEntry[K, V]{key: e.key})
			a.ghost[e.key] = ghostElem
		}
	}
}

func (a *ARC[K, V]) ghostContains(l *list.List, key K) bool {
	for e := l.Front(); e != nil; e = e.Next() {
		if e.Value.(*arcEntry[K, V]).key == key {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
```

## Observability and Cache Metrics

Production caches require comprehensive metrics:

```go
package cache

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

type CacheMetrics struct {
	hits     *prometheus.CounterVec
	misses   *prometheus.CounterVec
	sets     *prometheus.CounterVec
	evictions *prometheus.CounterVec
	latency  *prometheus.HistogramVec
	size     *prometheus.GaugeVec
}

func NewCacheMetrics(namespace, subsystem string) *CacheMetrics {
	labels := []string{"cache", "tier"}
	return &CacheMetrics{
		hits: promauto.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "hits_total",
			Help:      "Total number of cache hits.",
		}, labels),
		misses: promauto.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "misses_total",
			Help:      "Total number of cache misses.",
		}, labels),
		sets: promauto.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "sets_total",
			Help:      "Total number of cache set operations.",
		}, labels),
		evictions: promauto.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "evictions_total",
			Help:      "Total number of cache evictions.",
		}, labels),
		latency: promauto.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "operation_duration_seconds",
			Help:      "Cache operation latency distribution.",
			Buckets:   prometheus.ExponentialBuckets(0.000001, 10, 8), // 1µs to 1s
		}, append(labels, "op")),
		size: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "size_bytes",
			Help:      "Current cache size in bytes.",
		}, []string{"cache"}),
	}
}
```

## Recommended Cache Sizing Guidelines

For production deployments, use these rules of thumb:

| Metric | Target |
|---|---|
| L1 hit ratio | > 80% for hot data |
| L2 hit ratio | > 95% for warm data |
| L1 TTL | 5-60 seconds |
| L2 TTL | 5-60 minutes |
| Ristretto NumCounters | 10x expected item count |
| Ristretto MaxCost | 30-50% of available memory |
| BigCache shards | 256-1024 |
| Redis connection pool | 2x expected concurrent operations |

The critical invariant is that cache miss rate under peak load must not cause your origin (database) to exceed its capacity. Test this explicitly with load testing before production deployment.

## Summary

Go's caching ecosystem covers every point in the latency-consistency-cost tradeoff space. Ristretto provides the best hit ratios for in-process caches through its TinyLFU admission policy. BigCache minimizes GC pressure for high-throughput workloads with large byte payloads. Groupcache eliminates thundering herds in distributed read-heavy services. Redis as L2 provides cross-process coherence. The two-tier pattern combining an in-process L1 with Redis L2 is the right default for most production Go services — it delivers sub-microsecond hot reads while providing a consistent backing store for inter-instance coordination. Layer in single-flight, probabilistic early expiration, and pub/sub invalidation as your consistency requirements dictate.
