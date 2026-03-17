---
title: "Go Caching Strategies: In-Memory, Redis, and Multi-Layer Cache Patterns"
date: 2030-08-16T00:00:00-05:00
draft: false
tags: ["Go", "Caching", "Redis", "Performance", "Architecture", "Ristretto", "Distributed Systems"]
categories:
- Go
- Performance
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Production caching in Go: ristretto and groupcache for in-process caching, Redis client patterns with go-redis, cache-aside vs write-through vs write-behind, cache stampede prevention, TTL strategies, and cache invalidation at scale."
more_link: "yes"
url: "/go-caching-strategies-in-memory-redis-multi-layer-patterns/"
---

Caching is one of the highest-leverage performance optimizations in a distributed system, but poorly designed caches introduce consistency problems, stampede failures under load, and memory pressure that degrades overall system health. A principled approach to Go caching starts with choosing the right cache tier — in-process, distributed, or layered — and implementing the correct consistency semantics for each access pattern.

<!--more-->

## In-Process Caching with Ristretto

Ristretto is a high-performance concurrent cache developed by Dgraph. It uses a TinyLFU admission policy and a sliding window counter for frequency estimation, providing near-optimal hit rates while enforcing strict memory limits.

### Basic Ristretto Setup

```go
// pkg/cache/local.go
package cache

import (
    "fmt"
    "time"

    "github.com/dgraph-io/ristretto"
)

type LocalCache[K comparable, V any] struct {
    store *ristretto.Cache
}

func NewLocalCache[K comparable, V any](maxCost int64) (*LocalCache[K, V], error) {
    store, err := ristretto.NewCache(&ristretto.Config{
        NumCounters: maxCost * 10, // Track 10x as many items as max capacity
        MaxCost:     maxCost,      // Maximum memory in bytes
        BufferItems: 64,           // Number of keys per Get buffer
        Metrics:     true,
    })
    if err != nil {
        return nil, fmt.Errorf("creating ristretto cache: %w", err)
    }
    return &LocalCache[K, V]{store: store}, nil
}

func (c *LocalCache[K, V]) Set(key K, value V, cost int64, ttl time.Duration) bool {
    return c.store.SetWithTTL(key, value, cost, ttl)
}

func (c *LocalCache[K, V]) Get(key K) (V, bool) {
    val, found := c.store.Get(key)
    if !found {
        var zero V
        return zero, false
    }
    v, ok := val.(V)
    if !ok {
        var zero V
        return zero, false
    }
    return v, true
}

func (c *LocalCache[K, V]) Delete(key K) {
    c.store.Del(key)
}

func (c *LocalCache[K, V]) Wait() {
    c.store.Wait()
}

func (c *LocalCache[K, V]) Metrics() *ristretto.Metrics {
    return c.store.Metrics
}
```

### Using the Local Cache

```go
// internal/catalog/service.go
package catalog

import (
    "context"
    "fmt"
    "time"

    "github.com/example/shop/pkg/cache"
)

type Product struct {
    ID          string
    Name        string
    Description string
    PriceCents  int64
}

type Service struct {
    repo         ProductRepository
    productCache *cache.LocalCache[string, *Product]
}

func NewService(repo ProductRepository) (*Service, error) {
    // Allow up to 100MB for cached products
    c, err := cache.NewLocalCache[string, *Product](100 * 1024 * 1024)
    if err != nil {
        return nil, fmt.Errorf("creating product cache: %w", err)
    }
    return &Service{repo: repo, productCache: c}, nil
}

func (s *Service) GetProduct(ctx context.Context, productID string) (*Product, error) {
    if p, found := s.productCache.Get(productID); found {
        return p, nil
    }

    p, err := s.repo.FindByID(ctx, productID)
    if err != nil {
        return nil, err
    }
    if p == nil {
        return nil, nil
    }

    // Cost is the approximate memory size of the product struct in bytes
    s.productCache.Set(productID, p, estimateProductSize(p), 5*time.Minute)

    return p, nil
}

func estimateProductSize(p *Product) int64 {
    return int64(len(p.ID) + len(p.Name) + len(p.Description) + 32)
}
```

---

## Groupcache for Distributed In-Process Caching

Groupcache (originally built by Google for dl.google.com) provides a distributed in-process cache where cache keys are consistently hashed across a pool of application instances. This prevents thundering herd on cold starts and eliminates the need for a separate Redis cluster for workloads that fit the read-heavy, owner-fills pattern.

```go
// pkg/groupcache/product_cache.go
package groupcache

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"

    "github.com/mailgun/groupcache/v2"
)

type ProductLoader interface {
    LoadByID(ctx context.Context, id string) ([]byte, error)
}

type ProductGroupCache struct {
    group  *groupcache.Group
    loader ProductLoader
    logger *slog.Logger
}

func NewProductGroupCache(pool *groupcache.HTTPPool, loader ProductLoader, logger *slog.Logger) *ProductGroupCache {
    pgc := &ProductGroupCache{loader: loader, logger: logger}

    pgc.group = groupcache.NewGroup("products", 64<<20, // 64MB
        groupcache.GetterFunc(func(ctx context.Context, key string, dest groupcache.Sink) error {
            data, err := loader.LoadByID(ctx, key)
            if err != nil {
                return fmt.Errorf("loading product %s: %w", key, err)
            }
            return dest.SetBytes(data, time.Now().Add(10*time.Minute))
        }),
    )

    return pgc
}

func (pgc *ProductGroupCache) Get(ctx context.Context, productID string) ([]byte, error) {
    var sink groupcache.ByteView
    if err := pgc.group.Get(ctx, productID, groupcache.ByteViewSink(&sink)); err != nil {
        return nil, fmt.Errorf("groupcache get %s: %w", productID, err)
    }
    return sink.ByteSlice(), nil
}
```

---

## Redis Caching with go-redis

### Redis Client Configuration

```go
// pkg/redis/client.go
package redis

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type Config struct {
    Addrs        []string
    Password     string
    DB           int
    PoolSize     int
    MinIdleConns int
    ReadTimeout  time.Duration
    WriteTimeout time.Duration
    DialTimeout  time.Duration
}

func NewClusterClient(cfg Config) *redis.ClusterClient {
    return redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:        cfg.Addrs,
        Password:     cfg.Password,
        PoolSize:     cfg.PoolSize,
        MinIdleConns: cfg.MinIdleConns,
        ReadTimeout:  cfg.ReadTimeout,
        WriteTimeout: cfg.WriteTimeout,
        DialTimeout:  cfg.DialTimeout,
        // Route read commands to any node, including replicas
        RouteRandomly: false,
        RouteByLatency: true,
    })
}

func NewSentinelClient(cfg Config, masterName string) *redis.Client {
    return redis.NewFailoverClient(&redis.FailoverOptions{
        MasterName:    masterName,
        SentinelAddrs: cfg.Addrs,
        Password:      cfg.Password,
        DB:            cfg.DB,
        PoolSize:      cfg.PoolSize,
        MinIdleConns:  cfg.MinIdleConns,
        ReadTimeout:   cfg.ReadTimeout,
        WriteTimeout:  cfg.WriteTimeout,
    })
}
```

### Generic Redis Cache Wrapper

```go
// pkg/rediscache/cache.go
package rediscache

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type Cmd interface {
    Get(ctx context.Context, key string) *redis.StringCmd
    Set(ctx context.Context, key string, value interface{}, expiration time.Duration) *redis.StatusCmd
    Del(ctx context.Context, keys ...string) *redis.IntCmd
    SetNX(ctx context.Context, key string, value interface{}, expiration time.Duration) *redis.BoolCmd
}

type Cache[V any] struct {
    client    Cmd
    keyPrefix string
    ttl       time.Duration
}

func New[V any](client Cmd, keyPrefix string, ttl time.Duration) *Cache[V] {
    return &Cache[V]{
        client:    client,
        keyPrefix: keyPrefix,
        ttl:       ttl,
    }
}

func (c *Cache[V]) key(id string) string {
    return fmt.Sprintf("%s:%s", c.keyPrefix, id)
}

func (c *Cache[V]) Get(ctx context.Context, id string) (*V, error) {
    data, err := c.client.Get(ctx, c.key(id)).Bytes()
    if errors.Is(err, redis.Nil) {
        return nil, nil
    }
    if err != nil {
        return nil, fmt.Errorf("redis get %s: %w", id, err)
    }

    var v V
    if err := json.Unmarshal(data, &v); err != nil {
        return nil, fmt.Errorf("unmarshaling cached value for %s: %w", id, err)
    }
    return &v, nil
}

func (c *Cache[V]) Set(ctx context.Context, id string, value *V) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshaling value for %s: %w", id, err)
    }

    if err := c.client.Set(ctx, c.key(id), data, c.ttl).Err(); err != nil {
        return fmt.Errorf("redis set %s: %w", id, err)
    }
    return nil
}

func (c *Cache[V]) Delete(ctx context.Context, id string) error {
    if err := c.client.Del(ctx, c.key(id)).Err(); err != nil {
        return fmt.Errorf("redis del %s: %w", id, err)
    }
    return nil
}
```

---

## Cache Consistency Patterns

### Cache-Aside (Lazy Loading)

The caller checks the cache before querying the database. On a miss, the caller fetches from the database and populates the cache.

```go
// internal/user/service.go — cache-aside pattern
func (s *Service) GetUser(ctx context.Context, userID string) (*User, error) {
    // 1. Check local in-process cache first (L1)
    if u, found := s.localCache.Get(userID); found {
        return u, nil
    }

    // 2. Check Redis (L2)
    u, err := s.redisCache.Get(ctx, userID)
    if err != nil {
        s.logger.Warn("redis cache error, falling through to database", "error", err)
    }
    if u != nil {
        // Backfill L1 from L2
        s.localCache.Set(userID, u, estimateUserSize(u), 1*time.Minute)
        return u, nil
    }

    // 3. Load from database (origin)
    u, err = s.repo.FindByID(ctx, userID)
    if err != nil {
        return nil, err
    }
    if u == nil {
        // Cache negative result to prevent hammering the database
        // for non-existent users (negative caching)
        s.redisCache.SetNegative(ctx, userID, 30*time.Second)
        return nil, nil
    }

    // 4. Populate both cache tiers
    _ = s.redisCache.Set(ctx, userID, u)
    s.localCache.Set(userID, u, estimateUserSize(u), 1*time.Minute)

    return u, nil
}
```

### Write-Through

On every write to the database, the cache is updated synchronously. This ensures the cache is always fresh but adds write latency.

```go
// internal/user/service.go — write-through pattern
func (s *Service) UpdateUser(ctx context.Context, user *User) error {
    if err := s.repo.Update(ctx, user); err != nil {
        return fmt.Errorf("updating user: %w", err)
    }

    // Update cache synchronously — write-through
    if err := s.redisCache.Set(ctx, user.ID, user); err != nil {
        // Log but do not fail the operation — cache is a best-effort optimization
        s.logger.Warn("failed to update cache after user update",
            "user_id", user.ID, "error", err)
    }
    s.localCache.Delete(user.ID)

    return nil
}
```

### Write-Behind (Async Write)

Write-behind updates the cache immediately and writes to the database asynchronously. This reduces write latency at the cost of potential data loss on cache failure.

```go
// internal/session/service.go — write-behind for session counters
func (s *Service) RecordPageView(ctx context.Context, sessionID string) error {
    // Write to Redis immediately (low latency)
    key := fmt.Sprintf("session:views:%s", sessionID)
    if err := s.redis.Incr(ctx, key).Err(); err != nil {
        return fmt.Errorf("incrementing page view counter: %w", err)
    }
    // Set expiry to match session TTL
    s.redis.Expire(ctx, key, 30*time.Minute)

    // Enqueue async flush to persistent storage
    s.flushQueue <- sessionID
    return nil
}

func (s *Service) flushWorker(ctx context.Context) {
    seen := make(map[string]bool)
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case sessionID := <-s.flushQueue:
            seen[sessionID] = true
        case <-ticker.C:
            for sessionID := range seen {
                s.persistSessionViews(ctx, sessionID)
            }
            seen = make(map[string]bool)
        case <-ctx.Done():
            return
        }
    }
}
```

---

## Cache Stampede Prevention

A cache stampede (thundering herd) occurs when many concurrent requests hit a cache miss at the same time and all proceed to load from the database simultaneously.

### Single-Flight Pattern

```go
// pkg/singleflight/loader.go
package cache

import (
    "context"
    "fmt"

    "golang.org/x/sync/singleflight"
)

type LoadFunc[V any] func(ctx context.Context, key string) (*V, error)

type SingleFlightCache[V any] struct {
    group *singleflight.Group
    inner interface {
        Get(ctx context.Context, key string) (*V, error)
        Set(ctx context.Context, key string, value *V) error
    }
    loader LoadFunc[V]
}

func (c *SingleFlightCache[V]) Get(ctx context.Context, key string) (*V, error) {
    // Check cache first without single-flight
    if v, err := c.inner.Get(ctx, key); err == nil && v != nil {
        return v, nil
    }

    // Deduplicate concurrent loads for the same key
    v, err, _ := c.group.Do(key, func() (interface{}, error) {
        // Check cache again inside the group — another goroutine may have
        // populated it while we were waiting for our turn
        if v, err := c.inner.Get(ctx, key); err == nil && v != nil {
            return v, nil
        }

        val, err := c.loader(ctx, key)
        if err != nil {
            return nil, err
        }
        if val != nil {
            _ = c.inner.Set(ctx, key, val)
        }
        return val, nil
    })

    if err != nil {
        return nil, err
    }
    if v == nil {
        return nil, nil
    }

    result, ok := v.(*V)
    if !ok {
        return nil, fmt.Errorf("unexpected type from single-flight group")
    }
    return result, nil
}
```

### Probabilistic Early Expiration (XFetch)

XFetch prevents stampedes by probabilistically refreshing the cache before the TTL expires, rather than waiting for all concurrent requests to discover an expired entry:

```go
// pkg/cache/xfetch.go
package cache

import (
    "context"
    "math"
    "math/rand"
    "time"
)

type XFetchCache[V any] struct {
    store   RedisCache[V]
    loader  func(ctx context.Context, key string) (*V, time.Duration, error)
    beta    float64 // Typically 1.0; higher values = more aggressive pre-fetching
}

// Get returns the cached value, using XFetch to probabilistically
// pre-fetch before expiry to prevent stampedes.
func (c *XFetchCache[V]) Get(ctx context.Context, key string) (*V, error) {
    val, remainingTTL, fetchDuration, err := c.store.GetWithMeta(ctx, key)
    if err != nil {
        return c.refresh(ctx, key)
    }

    if val == nil {
        return c.refresh(ctx, key)
    }

    // XFetch: decide whether to pre-fetch based on remaining TTL and last fetch time
    // The probability increases as TTL shrinks
    if remainingTTL.Seconds() <= 0 {
        return c.refresh(ctx, key)
    }

    // Rnd is in range (-inf, 0]; more negative means more likely to refresh
    rnd := rand.Float64()
    earlyExpiry := -fetchDuration.Seconds() * c.beta * math.Log(rnd)

    if earlyExpiry >= remainingTTL.Seconds() {
        // Refresh asynchronously — return stale value immediately
        go func() {
            ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            defer cancel()
            _, _ = c.refresh(ctx2, key)
        }()
    }

    return val, nil
}

func (c *XFetchCache[V]) refresh(ctx context.Context, key string) (*V, error) {
    start := time.Now()
    val, ttl, err := c.loader(ctx, key)
    if err != nil {
        return nil, err
    }
    fetchDuration := time.Since(start)

    if val != nil {
        _ = c.store.SetWithMeta(ctx, key, val, ttl, fetchDuration)
    }

    return val, nil
}
```

---

## TTL Strategies

### Jittered TTL

Fixed TTLs cause synchronized expiry across all cached items. Jitter spreads expiry over a window, preventing mass simultaneous reloads:

```go
// pkg/cache/ttl.go
package cache

import (
    "math/rand"
    "time"
)

// JitteredTTL returns a TTL uniformly distributed between base and base + jitter.
func JitteredTTL(base, jitter time.Duration) time.Duration {
    return base + time.Duration(rand.Int63n(int64(jitter)))
}

// ExponentialBackoffTTL returns an exponentially increasing TTL for failed loads,
// capped at maxTTL. Use this for negative caching to avoid hammering a broken dependency.
func ExponentialBackoffTTL(attempt int, base, maxTTL time.Duration) time.Duration {
    ttl := base * time.Duration(1<<uint(attempt))
    if ttl > maxTTL {
        return maxTTL
    }
    return ttl
}
```

### Cache Key Versioning

Cache-busting through key versioning allows instant invalidation across all instances without requiring a distributed delete:

```go
// pkg/cache/versioned.go
package cache

import (
    "context"
    "fmt"

    "github.com/redis/go-redis/v9"
)

type VersionedCache[V any] struct {
    client    *redis.Client
    namespace string
}

func (c *VersionedCache[V]) CurrentVersion(ctx context.Context) (string, error) {
    ver, err := c.client.Get(ctx, fmt.Sprintf("%s:version", c.namespace)).Result()
    if err != nil {
        return "1", nil // Default version
    }
    return ver, nil
}

func (c *VersionedCache[V]) keyWithVersion(ctx context.Context, id string) (string, error) {
    ver, err := c.CurrentVersion(ctx)
    if err != nil {
        return "", err
    }
    return fmt.Sprintf("%s:v%s:%s", c.namespace, ver, id), nil
}

// BumpVersion invalidates all keys in the namespace by incrementing the version.
// Old keys remain in Redis but will never be read; Redis TTL eventually clears them.
func (c *VersionedCache[V]) BumpVersion(ctx context.Context) error {
    return c.client.Incr(ctx, fmt.Sprintf("%s:version", c.namespace)).Err()
}
```

---

## Cache Invalidation at Scale

### Tag-Based Invalidation with Redis Sets

```go
// pkg/cache/tags.go
package cache

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type TaggedCache struct {
    client *redis.Client
    ttl    time.Duration
}

// SetWithTags stores a value and associates it with one or more tags.
func (c *TaggedCache) SetWithTags(ctx context.Context, key string, value []byte, tags []string) error {
    pipe := c.client.TxPipeline()

    // Set the value
    pipe.Set(ctx, key, value, c.ttl)

    // Add key to each tag's set
    for _, tag := range tags {
        tagKey := fmt.Sprintf("tag:%s", tag)
        pipe.SAdd(ctx, tagKey, key)
        pipe.Expire(ctx, tagKey, c.ttl*2) // Tag TTL > item TTL
    }

    _, err := pipe.Exec(ctx)
    return err
}

// InvalidateByTag deletes all keys associated with a tag.
func (c *TaggedCache) InvalidateByTag(ctx context.Context, tag string) error {
    tagKey := fmt.Sprintf("tag:%s", tag)

    keys, err := c.client.SMembers(ctx, tagKey).Result()
    if err != nil {
        return fmt.Errorf("fetching tagged keys for %s: %w", tag, err)
    }
    if len(keys) == 0 {
        return nil
    }

    pipe := c.client.TxPipeline()
    // Delete all tagged keys
    for _, key := range keys {
        pipe.Del(ctx, key)
    }
    // Delete the tag set
    pipe.Del(ctx, tagKey)

    _, err = pipe.Exec(ctx)
    return err
}
```

---

## Multi-Layer Cache: Putting It Together

```go
// pkg/cache/multilayer.go
package cache

import (
    "context"
    "time"

    "github.com/dgraph-io/ristretto"
    "github.com/redis/go-redis/v9"
    "golang.org/x/sync/singleflight"
)

type MultiLayerCache[V any] struct {
    l1         *ristretto.Cache
    l2         *redis.Client
    l2Key      func(key string) string
    loader     func(ctx context.Context, key string) (*V, error)
    group      singleflight.Group
    l1TTL      time.Duration
    l2TTL      time.Duration
}

func (c *MultiLayerCache[V]) Get(ctx context.Context, key string) (*V, error) {
    // L1: local in-process
    if raw, found := c.l1.Get(key); found {
        if v, ok := raw.(*V); ok {
            return v, nil
        }
    }

    // Single-flight all downstream fetches
    val, err, _ := c.group.Do(key, func() (interface{}, error) {
        // L2: Redis
        raw, err := c.l2.Get(ctx, c.l2Key(key)).Bytes()
        if err == nil {
            var v V
            if err := unmarshal(raw, &v); err == nil {
                c.l1.SetWithTTL(key, &v, 1, c.l1TTL)
                return &v, nil
            }
        }

        // Origin load
        v, err := c.loader(ctx, key)
        if err != nil {
            return nil, err
        }
        if v != nil {
            data, _ := marshal(v)
            c.l2.Set(ctx, c.l2Key(key), data, c.l2TTL)
            c.l1.SetWithTTL(key, v, 1, c.l1TTL)
        }
        return v, nil
    })

    if err != nil {
        return nil, err
    }
    if val == nil {
        return nil, nil
    }
    return val.(*V), nil
}
```

---

## Monitoring Cache Health

### Prometheus Metrics for Cache Tiers

```go
// pkg/cache/metrics.go
package cache

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    cacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "cache_hits_total",
        Help: "Total number of cache hits by tier and namespace",
    }, []string{"tier", "namespace"})

    cacheMisses = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "cache_misses_total",
        Help: "Total number of cache misses by tier and namespace",
    }, []string{"tier", "namespace"})

    cacheEvictions = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "cache_evictions_total",
        Help: "Total number of evictions by tier and namespace",
    }, []string{"tier", "namespace"})

    cacheLoadDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "cache_load_duration_seconds",
        Help:    "Time taken to load values on cache miss",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 12),
    }, []string{"namespace"})
)

func RecordHit(tier, namespace string) {
    cacheHits.WithLabelValues(tier, namespace).Inc()
}

func RecordMiss(tier, namespace string) {
    cacheMisses.WithLabelValues(tier, namespace).Inc()
}
```

---

## Conclusion

Effective Go caching requires deliberate choices at each level: whether in-process ristretto satisfies latency needs, whether Redis provides the distributed coordination required for multi-instance deployments, and whether the consistency semantics of cache-aside, write-through, or write-behind match the correctness requirements of the data being cached. Single-flight and XFetch patterns address the stampede problem that turns cache misses under load into database avalanches. Tag-based and version-bumped invalidation strategies handle the hardest problem in computer science — knowing when cached data is no longer correct — at the scale a real production system demands.
