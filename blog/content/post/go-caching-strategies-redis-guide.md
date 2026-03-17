---
title: "Go Caching Strategies: Redis, In-Memory Cache, and Cache-Aside Patterns"
date: 2027-09-14T00:00:00-05:00
draft: false
tags: ["Go", "Redis", "Caching", "Performance"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Go caching architecture: Redis with go-redis, connection pooling, pipeline and transaction patterns, distributed locks with Redlock, in-memory caching with ristretto, and cache invalidation strategies."
more_link: "yes"
url: "/go-caching-strategies-redis-guide/"
---

Caching is the most effective performance lever available to application developers, but it is also a rich source of production incidents: stale data served after a write, thundering herds when a hot key expires, cache poisoning from incorrect cache key design, and cascading failures when the cache layer goes down. This guide covers the full production caching stack for Go: Redis with `go-redis`, connection pooling, pipeline and transaction patterns, distributed locks, in-memory caching with `ristretto`, and safe cache invalidation patterns.

<!--more-->

## Section 1: Redis Client Setup with go-redis

```bash
go get github.com/redis/go-redis/v9@v9.5.3
go get github.com/dgraph-io/ristretto@v0.1.1
```

### Connection Pool Configuration

```go
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
    Addr         string
    Password     string
    DB           int
    PoolSize     int           // number of connections in pool
    MinIdleConns int           // minimum idle connections
    MaxIdleConns int
    ConnMaxIdleTime time.Duration
    ConnMaxLifetime time.Duration
    DialTimeout  time.Duration
    ReadTimeout  time.Duration
    WriteTimeout time.Duration
    TLSEnabled   bool
}

// DefaultRedisConfig returns production-ready defaults.
func DefaultRedisConfig(addr string) RedisConfig {
    return RedisConfig{
        Addr:            addr,
        DB:              0,
        PoolSize:        50,
        MinIdleConns:    10,
        MaxIdleConns:    25,
        ConnMaxIdleTime: 5 * time.Minute,
        ConnMaxLifetime: 30 * time.Minute,
        DialTimeout:     5 * time.Second,
        ReadTimeout:     3 * time.Second,
        WriteTimeout:    3 * time.Second,
    }
}

// NewClient creates a Redis client with the given configuration.
func NewClient(cfg RedisConfig) (*redis.Client, error) {
    opts := &redis.Options{
        Addr:            cfg.Addr,
        Password:        cfg.Password,
        DB:              cfg.DB,
        PoolSize:        cfg.PoolSize,
        MinIdleConns:    cfg.MinIdleConns,
        MaxIdleConns:    cfg.MaxIdleConns,
        ConnMaxIdleTime: cfg.ConnMaxIdleTime,
        ConnMaxLifetime: cfg.ConnMaxLifetime,
        DialTimeout:     cfg.DialTimeout,
        ReadTimeout:     cfg.ReadTimeout,
        WriteTimeout:    cfg.WriteTimeout,
    }
    if cfg.TLSEnabled {
        opts.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
    }

    client := redis.NewClient(opts)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("redis ping: %w", err)
    }
    return client, nil
}
```

## Section 2: Cache-Aside Pattern

The cache-aside (lazy loading) pattern is the most common caching strategy. The application is responsible for loading data into the cache on cache misses:

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

// Store provides cache operations backed by Redis.
type Store struct {
    client *redis.Client
    prefix string
    ttl    time.Duration
}

// NewStore creates a Store with a key namespace prefix.
func NewStore(client *redis.Client, prefix string, ttl time.Duration) *Store {
    return &Store{client: client, prefix: prefix, ttl: ttl}
}

func (s *Store) key(id string) string {
    return fmt.Sprintf("%s:%s", s.prefix, id)
}

// Get retrieves a cached value. Returns ErrCacheMiss on miss.
func (s *Store) Get(ctx context.Context, id string, dest interface{}) error {
    data, err := s.client.Get(ctx, s.key(id)).Bytes()
    if errors.Is(err, redis.Nil) {
        return ErrCacheMiss
    }
    if err != nil {
        return fmt.Errorf("redis get %s: %w", id, err)
    }
    return json.Unmarshal(data, dest)
}

// Set stores a value with the configured TTL.
func (s *Store) Set(ctx context.Context, id string, value interface{}) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshal %s: %w", id, err)
    }
    return s.client.Set(ctx, s.key(id), data, s.ttl).Err()
}

// Delete removes a cached value.
func (s *Store) Delete(ctx context.Context, id string) error {
    return s.client.Del(ctx, s.key(id)).Err()
}

// GetOrLoad implements cache-aside: returns cached value or calls loader
// to populate the cache. Uses a Lua script to prevent thundering herd.
func (s *Store) GetOrLoad(
    ctx context.Context,
    id string,
    dest interface{},
    loader func(ctx context.Context) (interface{}, error),
) error {
    if err := s.Get(ctx, id, dest); err == nil {
        return nil
    } else if !errors.Is(err, ErrCacheMiss) {
        return err // real Redis error
    }

    // Cache miss: use a lock to prevent thundering herd.
    lockKey := s.key(id) + ":lock"
    acquired, err := s.client.SetNX(ctx, lockKey, "1", 10*time.Second).Result()
    if err != nil {
        return fmt.Errorf("acquire lock: %w", err)
    }
    if !acquired {
        // Another goroutine is loading; wait and retry.
        time.Sleep(50 * time.Millisecond)
        return s.Get(ctx, id, dest)
    }
    defer s.client.Del(ctx, lockKey)

    // Load from source.
    value, err := loader(ctx)
    if err != nil {
        return fmt.Errorf("loader: %w", err)
    }

    // Populate cache.
    if err := s.Set(ctx, id, value); err != nil {
        return fmt.Errorf("cache set: %w", err)
    }

    // Unmarshal into dest.
    data, _ := json.Marshal(value)
    return json.Unmarshal(data, dest)
}

// ErrCacheMiss is returned when the requested key is not in the cache.
var ErrCacheMiss = errors.New("cache miss")
```

## Section 3: Write-Through Pattern

Write-through updates the cache and the database in the same operation, ensuring the cache is always warm:

```go
// UserRepository implements write-through caching for users.
type UserRepository struct {
    db    *sql.DB
    cache *Store
}

// Save persists a user to the database and updates the cache atomically.
func (r *UserRepository) Save(ctx context.Context, user *User) error {
    if err := r.db.QueryRowContext(ctx,
        "INSERT INTO users (id, name, email) VALUES ($1, $2, $3) "+
            "ON CONFLICT (id) DO UPDATE SET name=$2, email=$3 "+
            "RETURNING updated_at",
        user.ID, user.Name, user.Email,
    ).Scan(&user.UpdatedAt); err != nil {
        return fmt.Errorf("db upsert: %w", err)
    }
    // Update cache after successful database write.
    if err := r.cache.Set(ctx, user.ID, user); err != nil {
        // Log but don't fail — the database is the source of truth.
        slog.Warn("cache set failed after db write",
            slog.String("user_id", user.ID),
            slog.String("error", err.Error()),
        )
    }
    return nil
}

// Delete removes a user from the database and invalidates the cache.
func (r *UserRepository) Delete(ctx context.Context, id string) error {
    if _, err := r.db.ExecContext(ctx, "DELETE FROM users WHERE id=$1", id); err != nil {
        return fmt.Errorf("db delete: %w", err)
    }
    // Invalidate cache entry.
    _ = r.cache.Delete(ctx, id)
    return nil
}
```

## Section 4: Pipeline and Batch Operations

Redis pipelining dramatically reduces round-trip latency for bulk operations by sending multiple commands in a single network round-trip:

```go
// GetMultiple retrieves multiple keys in a single round-trip.
func (s *Store) GetMultiple(ctx context.Context, ids []string) (map[string][]byte, error) {
    if len(ids) == 0 {
        return nil, nil
    }

    pipe := s.client.Pipeline()
    cmds := make([]*redis.StringCmd, len(ids))
    for i, id := range ids {
        cmds[i] = pipe.Get(ctx, s.key(id))
    }

    _, err := pipe.Exec(ctx)
    if err != nil && !errors.Is(err, redis.Nil) {
        return nil, fmt.Errorf("pipeline exec: %w", err)
    }

    results := make(map[string][]byte, len(ids))
    for i, cmd := range cmds {
        data, err := cmd.Bytes()
        if errors.Is(err, redis.Nil) {
            continue // key not in cache
        }
        if err != nil {
            return nil, fmt.Errorf("get %s: %w", ids[i], err)
        }
        results[ids[i]] = data
    }
    return results, nil
}

// SetMultiple stores multiple key-value pairs in a single pipeline.
func (s *Store) SetMultiple(ctx context.Context, items map[string]interface{}) error {
    if len(items) == 0 {
        return nil
    }

    pipe := s.client.Pipeline()
    for id, value := range items {
        data, err := json.Marshal(value)
        if err != nil {
            return fmt.Errorf("marshal %s: %w", id, err)
        }
        pipe.Set(ctx, s.key(id), data, s.ttl)
    }

    _, err := pipe.Exec(ctx)
    return err
}
```

## Section 5: Redis Transactions with WATCH

Use WATCH for optimistic locking — abort and retry if a watched key changes:

```go
// IncrementCounter atomically increments a counter only if it has not been
// modified by another client since the WATCH command.
func (s *Store) IncrementCounter(ctx context.Context, counterKey string, max int64) (int64, error) {
    fullKey := s.key(counterKey)
    var newVal int64

    err := s.client.Watch(ctx, func(tx *redis.Tx) error {
        current, err := tx.Get(ctx, fullKey).Int64()
        if errors.Is(err, redis.Nil) {
            current = 0
        } else if err != nil {
            return err
        }

        if current >= max {
            return ErrLimitExceeded
        }

        _, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
            pipe.Set(ctx, fullKey, current+1, s.ttl)
            return nil
        })
        if err == nil {
            newVal = current + 1
        }
        return err
    }, fullKey)

    if err != nil {
        return 0, err
    }
    return newVal, nil
}

var ErrLimitExceeded = errors.New("counter limit exceeded")
```

## Section 6: Distributed Locks with Redlock

The Redlock algorithm acquires a lock on N independent Redis nodes; the lock is valid only if acquired on the majority:

```go
package lock

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// Lock represents an acquired distributed lock.
type Lock struct {
    key    string
    token  string
    client *redis.Client
}

var luaRelease = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`)

// Acquire attempts to acquire a distributed lock with the given TTL.
// Returns ErrLockNotAcquired if the lock is already held.
func Acquire(ctx context.Context, client *redis.Client, key string, ttl time.Duration) (*Lock, error) {
    token := randomToken()
    fullKey := "lock:" + key

    ok, err := client.SetNX(ctx, fullKey, token, ttl).Result()
    if err != nil {
        return nil, fmt.Errorf("redis setnx: %w", err)
    }
    if !ok {
        return nil, ErrLockNotAcquired
    }
    return &Lock{key: fullKey, token: token, client: client}, nil
}

// Release releases the lock if it is still held by this instance.
// Uses a Lua script to ensure atomicity.
func (l *Lock) Release(ctx context.Context) error {
    result, err := luaRelease.Run(ctx, l.client, []string{l.key}, l.token).Int()
    if err != nil {
        return fmt.Errorf("release lock: %w", err)
    }
    if result == 0 {
        return ErrLockExpired
    }
    return nil
}

// Extend refreshes the lock TTL if it is still held by this instance.
func (l *Lock) Extend(ctx context.Context, ttl time.Duration) error {
    luaExtend := redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
`)
    result, err := luaExtend.Run(ctx, l.client,
        []string{l.key},
        l.token,
        ttl.Milliseconds(),
    ).Int()
    if err != nil {
        return err
    }
    if result == 0 {
        return ErrLockExpired
    }
    return nil
}

func randomToken() string {
    b := make([]byte, 16)
    rand.Read(b)
    return hex.EncodeToString(b)
}

var (
    ErrLockNotAcquired = errors.New("lock not acquired")
    ErrLockExpired     = errors.New("lock expired or stolen")
)
```

### Using the Distributed Lock

```go
func processPayment(ctx context.Context, client *redis.Client, paymentID string) error {
    lock, err := lock.Acquire(ctx, client, "payment:"+paymentID, 30*time.Second)
    if errors.Is(err, lock.ErrLockNotAcquired) {
        return fmt.Errorf("payment %s is already being processed", paymentID)
    }
    if err != nil {
        return fmt.Errorf("acquire lock: %w", err)
    }
    defer lock.Release(ctx)

    // Process payment — only one instance runs this code at a time.
    return doProcessPayment(ctx, paymentID)
}
```

## Section 7: In-Memory Caching with ristretto

For frequently read, rarely updated data — such as feature flags or rate limit configurations — an in-process cache eliminates network round-trips entirely:

```go
package cache

import (
    "fmt"

    "github.com/dgraph-io/ristretto"
)

// MemoryCache provides a high-performance in-process cache backed by ristretto.
type MemoryCache struct {
    cache *ristretto.Cache
}

// NewMemoryCache creates a memory cache with the given maximum size in bytes.
func NewMemoryCache(maxSizeBytes int64) (*MemoryCache, error) {
    cache, err := ristretto.NewCache(&ristretto.Config{
        NumCounters: maxSizeBytes / 10, // 10x the max items estimate
        MaxCost:     maxSizeBytes,
        BufferItems: 64,
        Metrics:     true,
    })
    if err != nil {
        return nil, fmt.Errorf("ristretto new: %w", err)
    }
    return &MemoryCache{cache: cache}, nil
}

// Get retrieves a value. Returns (nil, false) on miss.
func (m *MemoryCache) Get(key string) (interface{}, bool) {
    return m.cache.Get(key)
}

// Set stores a value with a cost (approximate memory size in bytes).
func (m *MemoryCache) Set(key string, value interface{}, costBytes int64) bool {
    return m.cache.Set(key, value, costBytes)
}

// SetWithTTL stores a value with an explicit TTL.
func (m *MemoryCache) SetWithTTL(key string, value interface{}, costBytes int64, ttl time.Duration) bool {
    return m.cache.SetWithTTL(key, value, costBytes, ttl)
}

// Delete removes a key from the cache.
func (m *MemoryCache) Delete(key string) {
    m.cache.Del(key)
}

// Metrics returns cache hit/miss statistics.
func (m *MemoryCache) Metrics() *ristretto.Metrics {
    return m.cache.Metrics
}
```

### Two-Layer Cache

Combine in-memory and Redis caches with a fallback chain:

```go
// TwoLayerCache checks memory first, then Redis, then the loader.
type TwoLayerCache struct {
    l1 *MemoryCache
    l2 *Store
}

func (c *TwoLayerCache) Get(ctx context.Context, key string, dest interface{}) error {
    // L1: in-process memory
    if val, ok := c.l1.Get(key); ok {
        data, _ := json.Marshal(val)
        return json.Unmarshal(data, dest)
    }

    // L2: Redis
    if err := c.l2.Get(ctx, key, dest); err == nil {
        // Backfill L1.
        c.l1.SetWithTTL(key, dest, estimateCost(dest), 30*time.Second)
        return nil
    } else if !errors.Is(err, ErrCacheMiss) {
        return err
    }

    return ErrCacheMiss
}
```

## Section 8: Cache Key Design

Poor key design causes cache collisions, unbounded key growth, and debugging nightmares:

```go
// CacheKeyBuilder builds structured, namespace-aware cache keys.
type CacheKeyBuilder struct {
    namespace string
    version   int
}

func NewCacheKeyBuilder(namespace string, version int) *CacheKeyBuilder {
    return &CacheKeyBuilder{namespace: namespace, version: version}
}

// UserProfile builds a cache key for a user profile.
// Format: ns:v{version}:user:{id}:profile
func (b *CacheKeyBuilder) UserProfile(userID string) string {
    return fmt.Sprintf("%s:v%d:user:%s:profile", b.namespace, b.version, userID)
}

// UserOrders builds a cache key for a paginated user order list.
// Format: ns:v{version}:user:{id}:orders:page:{page}:size:{size}
func (b *CacheKeyBuilder) UserOrders(userID string, page, size int) string {
    return fmt.Sprintf("%s:v%d:user:%s:orders:page:%d:size:%d",
        b.namespace, b.version, userID, page, size)
}

// Invalidation pattern: delete all keys matching the user prefix.
func (s *Store) InvalidateUser(ctx context.Context, userID string) error {
    pattern := fmt.Sprintf("%s:v*:user:%s:*", s.prefix, userID)
    iter := s.client.Scan(ctx, 0, pattern, 100).Iterator()
    var keys []string
    for iter.Next(ctx) {
        keys = append(keys, iter.Val())
    }
    if err := iter.Err(); err != nil {
        return err
    }
    if len(keys) == 0 {
        return nil
    }
    return s.client.Del(ctx, keys...).Err()
}
```

## Section 9: Cache Invalidation Strategies

```go
// EventDrivenInvalidation listens to domain events and invalidates
// the relevant cache keys.
type EventDrivenInvalidation struct {
    cache   *Store
    eventCh <-chan DomainEvent
    logger  *slog.Logger
}

func (e *EventDrivenInvalidation) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case event := <-e.eventCh:
            if err := e.handle(ctx, event); err != nil {
                e.logger.Error("cache invalidation failed",
                    slog.String("event_type", event.Type),
                    slog.String("entity_id", event.EntityID),
                    slog.String("error", err.Error()),
                )
            }
        }
    }
}

func (e *EventDrivenInvalidation) handle(ctx context.Context, event DomainEvent) error {
    switch event.Type {
    case "user.updated", "user.deleted":
        return e.cache.InvalidateUser(ctx, event.EntityID)
    case "product.price_changed":
        keys := []string{
            e.cache.key("product:" + event.EntityID),
            e.cache.key("product:" + event.EntityID + ":price"),
        }
        return e.cache.client.Del(ctx, keys...).Err()
    }
    return nil
}
```

## Section 10: Monitoring Cache Performance

```go
var (
    cacheHits = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "cache_hits_total",
            Help: "Total cache hits by store and operation.",
        },
        []string{"store", "operation"},
    )
    cacheMisses = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "cache_misses_total",
            Help: "Total cache misses by store and operation.",
        },
        []string{"store", "operation"},
    )
    cacheLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "cache_operation_duration_seconds",
            Help:    "Cache operation duration.",
            Buckets: []float64{.0001, .0005, .001, .005, .01, .05, .1},
        },
        []string{"store", "operation"},
    )
)

// instrumentedStore wraps a Store with Prometheus metrics.
type instrumentedStore struct {
    inner *Store
    name  string
}

func (s *instrumentedStore) Get(ctx context.Context, id string, dest interface{}) error {
    start := time.Now()
    err := s.inner.Get(ctx, id, dest)
    cacheLatency.WithLabelValues(s.name, "get").Observe(time.Since(start).Seconds())
    if err == nil {
        cacheHits.WithLabelValues(s.name, "get").Inc()
    } else if errors.Is(err, ErrCacheMiss) {
        cacheMisses.WithLabelValues(s.name, "get").Inc()
    }
    return err
}
```
