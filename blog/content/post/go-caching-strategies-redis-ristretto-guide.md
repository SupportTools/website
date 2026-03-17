---
title: "Go Caching Strategies: Ristretto, Redis, and Production-Ready Cache Patterns"
date: 2028-06-04T00:00:00-05:00
draft: false
tags: ["Go", "Caching", "Redis", "Ristretto", "Performance", "Architecture"]
categories: ["Go", "Performance", "Backend Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go caching strategies covering in-process caching with Ristretto, distributed caching with Redis, cache-aside and write-through patterns, TTL management, and cache stampede prevention for production systems."
more_link: "yes"
url: "/go-caching-strategies-redis-ristretto/"
---

Caching is one of the highest-leverage optimizations available in backend engineering. A well-designed cache layer can reduce database load by 90%, cut p99 latency by orders of magnitude, and enable services to handle traffic spikes gracefully. This guide covers the full spectrum of caching strategies in Go: from in-process caching with Ristretto for sub-microsecond access, to distributed caching with Redis for cross-service consistency, with concrete implementations of cache-aside, write-through, TTL management, and stampede prevention.

<!--more-->

## Cache Hierarchy and Strategy Selection

Before writing any code, the cache strategy must match the access patterns and consistency requirements:

| Layer | Library | Latency | Scope | Use Case |
|-------|---------|---------|-------|----------|
| In-process (L1) | Ristretto | ~100ns | Single instance | Read-heavy, instance-local data |
| Distributed (L2) | Redis | ~500µs | Cluster-wide | Shared state, session data |
| CDN (L3) | CloudFront/Fastly | ~5ms | Geographic | Public content, API responses |

The decision tree:
- Is the data instance-specific (e.g., parsed config, compiled templates)? Use Ristretto.
- Does the data need to be shared across multiple service instances? Use Redis.
- Is the data public and cacheable at the CDN level? Add cache-control headers.
- Can the system tolerate eventual consistency? Expand TTLs aggressively.

## In-Process Caching with Ristretto

Ristretto, developed by Dgraph, is a high-performance in-process cache for Go. Unlike `sync.Map` or `map[string]interface{}` with a mutex, Ristretto handles memory-bounded eviction using TinyLFU admission policy and handles concurrent access without lock contention at scale.

### Installation and Basic Setup

```bash
go get github.com/dgraph-io/ristretto/v2
```

```go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/dgraph-io/ristretto/v2"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// UserCache demonstrates a type-safe in-process cache for user records.
type UserCache struct {
    cache   *ristretto.Cache[string, []byte]
    metrics *cacheMetrics
}

type cacheMetrics struct {
    hits   prometheus.Counter
    misses prometheus.Counter
    evicts prometheus.Counter
}

func NewUserCache() (*UserCache, error) {
    c, err := ristretto.NewCache[string, []byte](&ristretto.Config[string, []byte]{
        // NumCounters: 10x the number of items expected in cache
        // For 100,000 items, set NumCounters to 1,000,000
        NumCounters: 1_000_000,

        // MaxCost: maximum memory budget in bytes
        // Here: 100MB
        MaxCost: 100 * 1024 * 1024,

        // BufferItems: recommended value is 64
        // Higher = better throughput, slightly stale hit stats
        BufferItems: 64,

        // Metrics: enable for Prometheus integration
        Metrics: true,

        // OnEvict: callback when items are evicted
        OnEvict: func(item *ristretto.Item[[]byte]) {
            // Log evictions for capacity planning
        },
    })
    if err != nil {
        return nil, fmt.Errorf("creating ristretto cache: %w", err)
    }

    metrics := &cacheMetrics{
        hits: promauto.NewCounter(prometheus.CounterOpts{
            Name: "user_cache_hits_total",
            Help: "Total number of user cache hits",
        }),
        misses: promauto.NewCounter(prometheus.CounterOpts{
            Name: "user_cache_misses_total",
            Help: "Total number of user cache misses",
        }),
        evicts: promauto.NewCounter(prometheus.CounterOpts{
            Name: "user_cache_evictions_total",
            Help: "Total number of user cache evictions",
        }),
    }

    return &UserCache{
        cache:   c,
        metrics: metrics,
    }, nil
}

type User struct {
    ID    int64  `json:"id"`
    Email string `json:"email"`
    Role  string `json:"role"`
}

func (uc *UserCache) Get(userID int64) (*User, bool) {
    key := fmt.Sprintf("user:%d", userID)
    val, found := uc.cache.Get(key)
    if !found {
        uc.metrics.misses.Inc()
        return nil, false
    }

    var user User
    if err := json.Unmarshal(val, &user); err != nil {
        // Corrupted entry; treat as miss
        uc.cache.Del(key)
        uc.metrics.misses.Inc()
        return nil, false
    }

    uc.metrics.hits.Inc()
    return &user, true
}

func (uc *UserCache) Set(user *User, ttl time.Duration) bool {
    key := fmt.Sprintf("user:%d", user.ID)
    data, err := json.Marshal(user)
    if err != nil {
        return false
    }

    // Cost = size in bytes for memory-bounded eviction
    cost := int64(len(data))
    return uc.cache.SetWithTTL(key, data, cost, ttl)
}

func (uc *UserCache) Delete(userID int64) {
    key := fmt.Sprintf("user:%d", userID)
    uc.cache.Del(key)
}

func (uc *UserCache) HitRatio() float64 {
    m := uc.cache.Metrics
    if m == nil {
        return 0
    }
    total := m.Hits() + m.Misses()
    if total == 0 {
        return 0
    }
    return float64(m.Hits()) / float64(total)
}

func (uc *UserCache) Close() {
    uc.cache.Close()
}
```

### Ristretto Cost Model

The cost parameter controls how Ristretto allocates its memory budget. Set it to the actual byte size of the serialized value for accurate memory management:

```go
// Option 1: Size-based cost (recommended)
cost := int64(len(serializedData))
cache.SetWithTTL(key, data, cost, ttl)

// Option 2: Count-based cost (simpler but less precise)
// All items have cost=1, MaxCost = max number of items
cost := int64(1)

// Option 3: Variable cost based on object type
func estimateCost(v interface{}) int64 {
    switch val := v.(type) {
    case []byte:
        return int64(len(val))
    case string:
        return int64(len(val))
    default:
        // Fallback: use unsafe.Sizeof for structs
        return 100 // conservative estimate
    }
}
```

### Multi-Level Generic Cache

A generic wrapper that abstracts the cache layer:

```go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/dgraph-io/ristretto/v2"
)

// TypedCache is a generic in-process cache with type safety.
type TypedCache[K comparable, V any] struct {
    inner *ristretto.Cache[K, []byte]
    ttl   time.Duration
}

func NewTypedCache[K comparable, V any](maxItems int64, maxBytes int64, defaultTTL time.Duration) (*TypedCache[K, V], error) {
    c, err := ristretto.NewCache[K, []byte](&ristretto.Config[K, []byte]{
        NumCounters: maxItems * 10,
        MaxCost:     maxBytes,
        BufferItems: 64,
        Metrics:     true,
    })
    if err != nil {
        return nil, err
    }
    return &TypedCache[K, V]{inner: c, ttl: defaultTTL}, nil
}

func (c *TypedCache[K, V]) Get(key K) (V, bool) {
    var zero V
    data, found := c.inner.Get(key)
    if !found {
        return zero, false
    }
    var v V
    if err := json.Unmarshal(data, &v); err != nil {
        return zero, false
    }
    return v, true
}

func (c *TypedCache[K, V]) Set(key K, value V) bool {
    return c.SetWithTTL(key, value, c.ttl)
}

func (c *TypedCache[K, V]) SetWithTTL(key K, value V, ttl time.Duration) bool {
    data, err := json.Marshal(value)
    if err != nil {
        return false
    }
    return c.inner.SetWithTTL(key, data, int64(len(data)), ttl)
}

func (c *TypedCache[K, V]) Delete(key K) {
    c.inner.Del(key)
}

func (c *TypedCache[K, V]) Close() {
    c.inner.Close()
}
```

## Distributed Caching with Redis

Redis handles cache sharing across service instances and survives pod restarts (unlike in-process caches). The `go-redis` library is the standard choice for production Go services.

### Redis Client Setup

```bash
go get github.com/redis/go-redis/v9
```

```go
package cache

import (
    "context"
    "crypto/tls"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisConfig struct {
    Addrs       []string      // Cluster mode: multiple addresses
    Password    string
    DB          int
    MaxRetries  int
    PoolSize    int
    MinIdleConns int
    DialTimeout time.Duration
    ReadTimeout time.Duration
    WriteTimeout time.Duration
    TLSEnabled  bool
}

func NewRedisClusterClient(cfg RedisConfig) (*redis.ClusterClient, error) {
    tlsConfig := (*tls.Config)(nil)
    if cfg.TLSEnabled {
        tlsConfig = &tls.Config{
            MinVersion: tls.VersionTLS12,
        }
    }

    client := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:        cfg.Addrs,
        Password:     cfg.Password,
        MaxRetries:   cfg.MaxRetries,
        PoolSize:     cfg.PoolSize,
        MinIdleConns: cfg.MinIdleConns,
        DialTimeout:  cfg.DialTimeout,
        ReadTimeout:  cfg.ReadTimeout,
        WriteTimeout: cfg.WriteTimeout,
        TLSConfig:    tlsConfig,
        // Route readonly commands to replica nodes
        RouteByLatency: true,
    })

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("connecting to Redis cluster: %w", err)
    }

    return client, nil
}

// NewRedisSingleClient for standalone Redis instances (dev/testing)
func NewRedisSingleClient(addr, password string, db int) (*redis.Client, error) {
    client := redis.NewClient(&redis.Options{
        Addr:         addr,
        Password:     password,
        DB:           db,
        MaxRetries:   3,
        PoolSize:     20,
        MinIdleConns: 5,
        DialTimeout:  3 * time.Second,
        ReadTimeout:  2 * time.Second,
        WriteTimeout: 2 * time.Second,
    })

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("connecting to Redis: %w", err)
    }

    return client, nil
}
```

### Redis Cache Interface

```go
package cache

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

var ErrCacheMiss = errors.New("cache miss")

// RedisCache is a generic Redis-backed cache.
type RedisCache[V any] struct {
    client    redis.UniversalClient
    keyPrefix string
    defaultTTL time.Duration
}

func NewRedisCache[V any](client redis.UniversalClient, keyPrefix string, defaultTTL time.Duration) *RedisCache[V] {
    return &RedisCache[V]{
        client:     client,
        keyPrefix:  keyPrefix,
        defaultTTL: defaultTTL,
    }
}

func (c *RedisCache[V]) key(k string) string {
    return fmt.Sprintf("%s:%s", c.keyPrefix, k)
}

func (c *RedisCache[V]) Get(ctx context.Context, key string) (V, error) {
    var zero V
    data, err := c.client.Get(ctx, c.key(key)).Bytes()
    if errors.Is(err, redis.Nil) {
        return zero, ErrCacheMiss
    }
    if err != nil {
        return zero, fmt.Errorf("redis get %s: %w", key, err)
    }

    var v V
    if err := json.Unmarshal(data, &v); err != nil {
        return zero, fmt.Errorf("unmarshaling cached value: %w", err)
    }
    return v, nil
}

func (c *RedisCache[V]) Set(ctx context.Context, key string, value V) error {
    return c.SetWithTTL(ctx, key, value, c.defaultTTL)
}

func (c *RedisCache[V]) SetWithTTL(ctx context.Context, key string, value V, ttl time.Duration) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshaling value for cache: %w", err)
    }

    if err := c.client.Set(ctx, c.key(key), data, ttl).Err(); err != nil {
        return fmt.Errorf("redis set %s: %w", key, err)
    }
    return nil
}

func (c *RedisCache[V]) Delete(ctx context.Context, key string) error {
    if err := c.client.Del(ctx, c.key(key)).Err(); err != nil {
        return fmt.Errorf("redis del %s: %w", key, err)
    }
    return nil
}

func (c *RedisCache[V]) DeletePattern(ctx context.Context, pattern string) error {
    // Use SCAN instead of KEYS to avoid blocking Redis
    var cursor uint64
    var keysToDelete []string

    for {
        keys, nextCursor, err := c.client.Scan(ctx, cursor, c.key(pattern), 100).Result()
        if err != nil {
            return fmt.Errorf("redis scan: %w", err)
        }
        keysToDelete = append(keysToDelete, keys...)
        cursor = nextCursor
        if cursor == 0 {
            break
        }
    }

    if len(keysToDelete) == 0 {
        return nil
    }

    return c.client.Del(ctx, keysToDelete...).Err()
}

// MGet retrieves multiple keys in a single round trip.
func (c *RedisCache[V]) MGet(ctx context.Context, keys []string) (map[string]V, error) {
    prefixedKeys := make([]string, len(keys))
    for i, k := range keys {
        prefixedKeys[i] = c.key(k)
    }

    results, err := c.client.MGet(ctx, prefixedKeys...).Result()
    if err != nil {
        return nil, fmt.Errorf("redis mget: %w", err)
    }

    out := make(map[string]V, len(keys))
    for i, result := range results {
        if result == nil {
            continue
        }
        data, ok := result.(string)
        if !ok {
            continue
        }
        var v V
        if err := json.Unmarshal([]byte(data), &v); err != nil {
            continue
        }
        out[keys[i]] = v
    }
    return out, nil
}
```

## Cache-Aside Pattern

Cache-aside (lazy loading) is the most common caching pattern. The application code checks the cache first; on a miss, it fetches from the source and populates the cache.

```go
package service

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/yourorg/service/cache"
    "github.com/yourorg/service/db"
)

type UserService struct {
    db    *db.Queries
    cache *cache.RedisCache[db.User]
}

func NewUserService(database *db.Queries, redisClient redis.UniversalClient) *UserService {
    return &UserService{
        db:    database,
        cache: cache.NewRedisCache[db.User](redisClient, "users", 15*time.Minute),
    }
}

// GetUser implements the cache-aside pattern.
func (s *UserService) GetUser(ctx context.Context, userID int64) (*db.User, error) {
    cacheKey := fmt.Sprintf("%d", userID)

    // 1. Check cache
    user, err := s.cache.Get(ctx, cacheKey)
    if err == nil {
        return &user, nil
    }
    if !errors.Is(err, cache.ErrCacheMiss) {
        // Cache error: log and fall through to DB (fail open)
        // Don't return error; degraded caching should not fail requests
        // log.Warn("cache get error", "error", err)
        _ = err
    }

    // 2. Fetch from database
    dbUser, err := s.db.GetUser(ctx, userID)
    if err != nil {
        return nil, fmt.Errorf("fetching user %d: %w", userID, err)
    }

    // 3. Populate cache (best effort; don't fail if cache write fails)
    if setErr := s.cache.Set(ctx, cacheKey, dbUser); setErr != nil {
        // log.Warn("cache set error", "error", setErr)
        _ = setErr
    }

    return &dbUser, nil
}

// UpdateUser invalidates the cache after a write.
func (s *UserService) UpdateUser(ctx context.Context, userID int64, updates db.UpdateUserParams) error {
    if err := s.db.UpdateUser(ctx, updates); err != nil {
        return fmt.Errorf("updating user %d: %w", userID, err)
    }

    // Invalidate cache after successful write
    cacheKey := fmt.Sprintf("%d", userID)
    if err := s.cache.Delete(ctx, cacheKey); err != nil {
        // Log but don't fail; stale data will expire via TTL
        // log.Warn("cache invalidation failed", "userID", userID, "error", err)
    }

    return nil
}

// GetUsers demonstrates batch cache-aside with MGet.
func (s *UserService) GetUsers(ctx context.Context, userIDs []int64) ([]*db.User, error) {
    // Convert IDs to string keys
    keys := make([]string, len(userIDs))
    for i, id := range userIDs {
        keys[i] = fmt.Sprintf("%d", id)
    }

    // 1. Bulk fetch from cache
    cached, err := s.cache.MGet(ctx, keys)
    if err != nil {
        // Cache error: fall through to DB for all records
        cached = make(map[string]db.User)
    }

    // 2. Identify cache misses
    var missedIDs []int64
    for i, id := range userIDs {
        if _, found := cached[keys[i]]; !found {
            missedIDs = append(missedIDs, id)
        }
    }

    // 3. Fetch misses from database
    if len(missedIDs) > 0 {
        dbUsers, err := s.db.GetUsersByIDs(ctx, missedIDs)
        if err != nil {
            return nil, fmt.Errorf("batch fetching users: %w", err)
        }

        // Populate cache for misses using pipeline
        pipe := s.cache.Client().Pipeline()
        for _, u := range dbUsers {
            data, _ := json.Marshal(u)
            key := fmt.Sprintf("users:%d", u.ID)
            pipe.Set(ctx, key, data, 15*time.Minute)
            cached[fmt.Sprintf("%d", u.ID)] = u
        }
        pipe.Exec(ctx)
    }

    // 4. Assemble result in original order
    result := make([]*db.User, 0, len(userIDs))
    for i, id := range userIDs {
        if u, found := cached[keys[i]]; found {
            result = append(result, &u)
        }
    }

    return result, nil
}
```

## Write-Through Pattern

Write-through updates the cache synchronously on every write, ensuring the cache is always consistent with the database. This increases write latency slightly but eliminates the window between write and cache invalidation.

```go
package service

import (
    "context"
    "fmt"
    "time"
)

type ProductService struct {
    db    *db.Queries
    cache *cache.RedisCache[db.Product]
}

// CreateProduct uses write-through: DB and cache are updated atomically.
func (s *ProductService) CreateProduct(ctx context.Context, params db.CreateProductParams) (*db.Product, error) {
    // 1. Write to database
    product, err := s.db.CreateProduct(ctx, params)
    if err != nil {
        return nil, fmt.Errorf("creating product: %w", err)
    }

    // 2. Write to cache immediately (write-through)
    cacheKey := fmt.Sprintf("%d", product.ID)
    if err := s.cache.SetWithTTL(ctx, cacheKey, product, 1*time.Hour); err != nil {
        // Write-through failure is non-fatal; the cache will be populated on next read
        // But log it for visibility
        // log.Warn("write-through cache failure", "productID", product.ID, "error", err)
    }

    return &product, nil
}

// UpdateProduct uses write-through with cache refresh.
func (s *ProductService) UpdateProduct(ctx context.Context, productID int64, params db.UpdateProductParams) (*db.Product, error) {
    product, err := s.db.UpdateProduct(ctx, params)
    if err != nil {
        return nil, fmt.Errorf("updating product %d: %w", productID, err)
    }

    cacheKey := fmt.Sprintf("%d", productID)
    _ = s.cache.SetWithTTL(ctx, cacheKey, product, 1*time.Hour)

    return &product, nil
}
```

## Two-Level Cache (L1 + L2)

Combining Ristretto and Redis provides the best of both worlds: ultra-fast local access with shared state across instances:

```go
package cache

import (
    "context"
    "errors"
    "fmt"
    "time"
)

// TwoLevelCache combines an in-process L1 (Ristretto) with a distributed L2 (Redis).
type TwoLevelCache[V any] struct {
    l1  *TypedCache[string, V]
    l2  *RedisCache[V]
    l1TTL time.Duration
    l2TTL time.Duration
}

func NewTwoLevelCache[V any](
    l1 *TypedCache[string, V],
    l2 *RedisCache[V],
    l1TTL, l2TTL time.Duration,
) *TwoLevelCache[V] {
    return &TwoLevelCache[V]{
        l1:    l1,
        l2:    l2,
        l1TTL: l1TTL,
        l2TTL: l2TTL,
    }
}

func (c *TwoLevelCache[V]) Get(ctx context.Context, key string) (V, bool) {
    // 1. Check L1 (in-process)
    if v, found := c.l1.Get(key); found {
        return v, true
    }

    // 2. Check L2 (Redis)
    v, err := c.l2.Get(ctx, key)
    if err == nil {
        // Backfill L1 from L2
        c.l1.SetWithTTL(key, v, c.l1TTL)
        return v, true
    }

    var zero V
    return zero, false
}

func (c *TwoLevelCache[V]) Set(ctx context.Context, key string, value V) error {
    // Write to both levels
    c.l1.SetWithTTL(key, value, c.l1TTL)
    return c.l2.SetWithTTL(ctx, key, value, c.l2TTL)
}

func (c *TwoLevelCache[V]) Delete(ctx context.Context, key string) error {
    c.l1.Delete(key)
    return c.l2.Delete(ctx, key)
}
```

## TTL Management

TTL selection is critical for correctness vs. performance trade-offs:

```go
package cache

import (
    "math/rand"
    "time"
)

// TTLConfig defines TTL strategies for different data types.
type TTLConfig struct {
    // Base TTL for the data type
    Base time.Duration
    // Jitter: add up to this duration randomly to prevent expiry stampedes
    Jitter time.Duration
    // StaleWhileRevalidate: serve stale for this long while refreshing in background
    StaleWhileRevalidate time.Duration
}

// Standard TTL configurations
var (
    UserTTL = TTLConfig{
        Base:                 15 * time.Minute,
        Jitter:               2 * time.Minute,
        StaleWhileRevalidate: 5 * time.Minute,
    }
    ProductCatalogTTL = TTLConfig{
        Base:                 1 * time.Hour,
        Jitter:               5 * time.Minute,
        StaleWhileRevalidate: 10 * time.Minute,
    }
    SessionTTL = TTLConfig{
        Base:   24 * time.Hour,
        Jitter: 0, // Sessions should expire at precise times
    }
    RateLimitTTL = TTLConfig{
        Base:   1 * time.Minute,
        Jitter: 0, // Rate limits need precise windows
    }
)

// EffectiveTTL returns the base TTL plus random jitter.
func (t TTLConfig) EffectiveTTL() time.Duration {
    if t.Jitter == 0 {
        return t.Base
    }
    jitter := time.Duration(rand.Int63n(int64(t.Jitter)))
    return t.Base + jitter
}

// TotalTTL returns the full TTL including the stale-while-revalidate window.
func (t TTLConfig) TotalTTL() time.Duration {
    return t.Base + t.Jitter + t.StaleWhileRevalidate
}
```

### Sliding Window TTL with Redis

For session-like objects that should expire after inactivity:

```go
func (s *SessionStore) Touch(ctx context.Context, sessionID string) error {
    key := fmt.Sprintf("session:%s", sessionID)
    // Reset TTL on access (sliding window)
    return s.redis.Expire(ctx, key, 30*time.Minute).Err()
}

func (s *SessionStore) GetAndTouch(ctx context.Context, sessionID string) (*Session, error) {
    key := fmt.Sprintf("session:%s", sessionID)

    // Atomic GET + EXPIRE using a pipeline
    pipe := s.redis.Pipeline()
    getCmd := pipe.Get(ctx, key)
    pipe.Expire(ctx, key, 30*time.Minute)

    if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
        return nil, fmt.Errorf("session touch pipeline: %w", err)
    }

    data, err := getCmd.Bytes()
    if errors.Is(err, redis.Nil) {
        return nil, ErrCacheMiss
    }
    if err != nil {
        return nil, err
    }

    var session Session
    if err := json.Unmarshal(data, &session); err != nil {
        return nil, err
    }
    return &session, nil
}
```

## Cache Stampede Prevention

A cache stampede (also called a thundering herd) occurs when many concurrent requests all hit a cache miss simultaneously and all attempt to fetch from the database. This is most dangerous during:
- Service startup (cold cache)
- TTL expiry of highly contended keys
- Cache flush events

### Solution 1: Singleflight

`singleflight` ensures only one goroutine performs the backend fetch for a given key, even when hundreds of goroutines request it simultaneously:

```go
package service

import (
    "context"
    "fmt"

    "golang.org/x/sync/singleflight"
)

type CachingUserService struct {
    db    *db.Queries
    cache *cache.RedisCache[db.User]
    group singleflight.Group
}

func (s *CachingUserService) GetUser(ctx context.Context, userID int64) (*db.User, error) {
    cacheKey := fmt.Sprintf("%d", userID)

    // Check cache first
    user, err := s.cache.Get(ctx, cacheKey)
    if err == nil {
        return &user, nil
    }

    // On cache miss, use singleflight to deduplicate concurrent fetches
    sfKey := fmt.Sprintf("user:%d", userID)
    result, err, shared := s.group.Do(sfKey, func() (interface{}, error) {
        dbUser, err := s.db.GetUser(ctx, userID)
        if err != nil {
            return nil, err
        }
        _ = s.cache.Set(ctx, cacheKey, dbUser)
        return &dbUser, nil
    })

    if err != nil {
        return nil, err
    }

    if shared {
        // This result was shared from another goroutine's fetch
        // Useful for metrics
    }

    return result.(*db.User), nil
}
```

### Solution 2: Probabilistic Early Expiration (XFetch)

XFetch probabilistically refreshes cache entries before they expire, preventing cold-start stampedes. The closer to expiry, the higher the probability of triggering a refresh:

```go
package cache

import (
    "context"
    "math"
    "math/rand"
    "time"

    "github.com/redis/go-redis/v9"
)

// XFetchEntry stores a value with its recomputation time delta.
type XFetchEntry[V any] struct {
    Value   V
    Delta   time.Duration // Time it took to compute this value
    Expiry  time.Time
}

// XFetchGet implements the XFetch algorithm for probabilistic early revalidation.
// beta controls how aggressively to refresh (1.0 is standard; higher = more aggressive).
func XFetchGet[V any](
    ctx context.Context,
    cache *RedisCache[XFetchEntry[V]],
    key string,
    beta float64,
    fetch func(ctx context.Context) (V, error),
    ttl time.Duration,
) (V, error) {
    entry, err := cache.Get(ctx, key)
    if err == nil {
        // XFetch formula: refresh if -delta * beta * ln(rand) >= time_to_expiry
        now := time.Now()
        timeToExpiry := entry.Expiry.Sub(now).Seconds()
        if timeToExpiry > 0 {
            threshold := -float64(entry.Delta.Seconds()) * beta * math.Log(rand.Float64())
            if threshold < timeToExpiry {
                // Cache hit, no refresh needed
                return entry.Value, nil
            }
            // Probabilistic miss: refresh early
        }
    }

    // Fetch fresh value and record how long it took
    start := time.Now()
    value, err := fetch(ctx)
    if err != nil {
        var zero V
        return zero, err
    }
    delta := time.Since(start)

    newEntry := XFetchEntry[V]{
        Value:  value,
        Delta:  delta,
        Expiry: time.Now().Add(ttl),
    }
    _ = cache.SetWithTTL(ctx, key, newEntry, ttl)

    return value, nil
}
```

### Solution 3: Redis Locking

For slow backend fetches where singleflight is insufficient (distributed lock across multiple service instances):

```go
package cache

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

const lockTTL = 30 * time.Second
const lockRetryDelay = 50 * time.Millisecond
const maxLockRetries = 20

// GetOrFetch fetches a value using a distributed lock to prevent stampedes.
func (c *RedisCache[V]) GetOrFetch(
    ctx context.Context,
    key string,
    fetch func(ctx context.Context) (V, error),
    ttl time.Duration,
) (V, error) {
    // 1. Check cache
    if v, err := c.Get(ctx, key); err == nil {
        return v, nil
    }

    lockKey := fmt.Sprintf("%s:lock", c.key(key))
    lockValue := fmt.Sprintf("%d", time.Now().UnixNano())

    // 2. Acquire distributed lock (SET NX PX)
    for i := 0; i < maxLockRetries; i++ {
        acquired, err := c.client.SetNX(ctx, lockKey, lockValue, lockTTL).Result()
        if err != nil {
            var zero V
            return zero, fmt.Errorf("acquiring lock: %w", err)
        }

        if acquired {
            defer func() {
                // Release lock using Lua script to ensure we only delete our own lock
                script := `
                    if redis.call("get", KEYS[1]) == ARGV[1] then
                        return redis.call("del", KEYS[1])
                    else
                        return 0
                    end
                `
                c.client.Eval(ctx, script, []string{lockKey}, lockValue)
            }()

            // 3. Re-check cache (another goroutine may have populated it)
            if v, err := c.Get(ctx, key); err == nil {
                return v, nil
            }

            // 4. Fetch and populate
            v, err := fetch(ctx)
            if err != nil {
                var zero V
                return zero, err
            }
            _ = c.SetWithTTL(ctx, key, v, ttl)
            return v, nil
        }

        // Lock not acquired; wait and retry
        select {
        case <-ctx.Done():
            var zero V
            return zero, ctx.Err()
        case <-time.After(lockRetryDelay):
        }

        // Check if the value was populated while we were waiting
        if v, err := c.Get(ctx, key); err == nil {
            return v, nil
        }
    }

    // Failed to acquire lock; fetch directly to avoid complete failure
    return fetch(ctx)
}
```

## Redis Pub/Sub for Cache Invalidation

In multi-instance deployments, when one instance updates a record, other instances need to invalidate their L1 caches:

```go
package cache

import (
    "context"
    "encoding/json"
    "log/slog"

    "github.com/redis/go-redis/v9"
)

type InvalidationEvent struct {
    Type string `json:"type"` // "user", "product", etc.
    Key  string `json:"key"`
}

type CacheInvalidator struct {
    pubsub  *redis.PubSub
    l1Cache *ristretto.Cache[string, []byte]
    channel string
}

func NewCacheInvalidator(client redis.UniversalClient, channel string, l1 *ristretto.Cache[string, []byte]) *CacheInvalidator {
    pubsub := client.Subscribe(context.Background(), channel)
    inv := &CacheInvalidator{
        pubsub:  pubsub,
        l1Cache: l1,
        channel: channel,
    }
    return inv
}

func (ci *CacheInvalidator) Start(ctx context.Context) {
    go func() {
        ch := ci.pubsub.Channel()
        for {
            select {
            case <-ctx.Done():
                ci.pubsub.Close()
                return
            case msg, ok := <-ch:
                if !ok {
                    return
                }
                var event InvalidationEvent
                if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
                    slog.Warn("invalid cache invalidation event", "error", err)
                    continue
                }
                ci.l1Cache.Del(event.Key)
            }
        }
    }()
}

func (ci *CacheInvalidator) Publish(ctx context.Context, client redis.UniversalClient, event InvalidationEvent) error {
    data, err := json.Marshal(event)
    if err != nil {
        return err
    }
    return client.Publish(ctx, ci.channel, data).Err()
}
```

## Monitoring and Observability

### Prometheus Metrics for Redis

```go
package cache

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/redis/go-redis/v9"
)

type InstrumentedRedisCache[V any] struct {
    *RedisCache[V]
    hits      prometheus.Counter
    misses    prometheus.Counter
    errors    prometheus.Counter
    latency   prometheus.Histogram
}

func NewInstrumentedRedisCache[V any](
    client redis.UniversalClient,
    prefix string,
    ttl time.Duration,
    namespace string,
) *InstrumentedRedisCache[V] {
    return &InstrumentedRedisCache[V]{
        RedisCache: NewRedisCache[V](client, prefix, ttl),
        hits: promauto.NewCounter(prometheus.CounterOpts{
            Namespace: namespace,
            Name:      "cache_hits_total",
            Help:      "Total number of cache hits",
        }),
        misses: promauto.NewCounter(prometheus.CounterOpts{
            Namespace: namespace,
            Name:      "cache_misses_total",
            Help:      "Total number of cache misses",
        }),
        errors: promauto.NewCounter(prometheus.CounterOpts{
            Namespace: namespace,
            Name:      "cache_errors_total",
            Help:      "Total number of cache errors",
        }),
        latency: promauto.NewHistogram(prometheus.HistogramOpts{
            Namespace: namespace,
            Name:      "cache_operation_duration_seconds",
            Help:      "Cache operation latency distribution",
            Buckets:   []float64{0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1},
        }),
    }
}

func (c *InstrumentedRedisCache[V]) Get(ctx context.Context, key string) (V, error) {
    start := time.Now()
    v, err := c.RedisCache.Get(ctx, key)
    c.latency.Observe(time.Since(start).Seconds())

    if err == nil {
        c.hits.Inc()
    } else if errors.Is(err, ErrCacheMiss) {
        c.misses.Inc()
    } else {
        c.errors.Inc()
    }
    return v, err
}
```

### Redis INFO Metrics Scraping

```go
func collectRedisMetrics(ctx context.Context, client redis.UniversalClient) {
    info, err := client.Info(ctx, "stats", "memory", "clients").Result()
    if err != nil {
        return
    }

    // Parse and expose as Prometheus gauges:
    // used_memory, connected_clients, keyspace_hits, keyspace_misses
    // instantaneous_ops_per_sec, rejected_connections
}
```

## Production Checklist

Before deploying a caching layer in production:

- Implement circuit breakers: if Redis is unavailable, serve from DB without crashing
- Set memory limits on Redis instances and monitor eviction rates
- Use keyspace notifications or pub/sub for L1 invalidation in multi-instance deployments
- Configure connection pools appropriately: too few causes timeouts, too many overwhelms Redis
- Test stampede behavior under load: use `go test -race` and synthetic load tests
- Monitor hit ratio: below 90% indicates TTLs are too short or key space is too large
- Implement health checks that validate cache connectivity separately from DB connectivity
- Add jitter to all TTLs to distribute expiry across time
- Never cache error responses (a missing user is not the same as a cached empty result)
- Test cache invalidation paths: confirm stale data does not persist after updates

Effective caching requires understanding both the performance characteristics (hit ratio, latency distributions) and the correctness characteristics (staleness tolerance, invalidation completeness). With Ristretto for local speed and Redis for distributed consistency, Go services can handle production-scale traffic reliably.
