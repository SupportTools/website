---
title: "Go Singleflight and Coalesce: Preventing Cache Stampedes in High-Traffic APIs"
date: 2031-03-28T00:00:00-05:00
draft: false
tags: ["Go", "Performance", "Caching", "Singleflight", "Redis", "Concurrency", "API"]
categories:
- Go
- Performance
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to preventing cache stampedes in Go services using golang.org/x/sync/singleflight, including DoChan for async coalescing, Forget for cache invalidation, distributed singleflight with Redis, and benchmarking stampede prevention strategies."
more_link: "yes"
url: "/go-singleflight-coalesce-cache-stampede-prevention/"
---

The cache stampede — also called thundering herd — is a classic distributed systems failure mode: a popular cached item expires, hundreds of concurrent requests miss the cache simultaneously, all invoke the expensive backend query in parallel, and the database collapses under load just as the cache is empty and traffic is at its highest. In Go services, `golang.org/x/sync/singleflight` provides an in-process solution that coalesces concurrent identical requests into a single backend call.

This guide covers the complete toolkit: singleflight mechanics and the subtleties of result sharing, `DoChan` for non-blocking coalescing, `Forget` for cache invalidation during errors, combining singleflight with in-process caches, distributed singleflight coordination using Redis for multi-instance deployments, and benchmarks that quantify the protection provided.

<!--more-->

# Go Singleflight and Coalesce: Preventing Cache Stampedes in High-Traffic APIs

## Section 1: The Cache Stampede Problem

### Why Cache Stampedes Happen

A well-cached API function looks like this under normal load:

```
Request 1 → Cache HIT → return cached value
Request 2 → Cache HIT → return cached value
Request N → Cache HIT → return cached value
```

When the cache key expires, what actually happens without protection:

```
Request 1 → Cache MISS → start DB query (takes 500ms)
Request 2 → Cache MISS → start DB query (takes 500ms) -- 50ms later
Request 3 → Cache MISS → start DB query (takes 500ms) -- 100ms later
...
Request 200 → Cache MISS → start DB query (TIMEOUT - DB saturated)
```

All 200 requests arrived within a 500ms window, all missed the expired cache, all invoked the database, and the database received 200x its normal load on this query.

### Anatomy of a Real Stampede

```go
// Naive caching implementation — stampede-vulnerable
func getUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
    cacheKey := "user:profile:" + userID

    // Check cache
    if cached, ok := localCache.Get(cacheKey); ok {
        return cached.(*UserProfile), nil
    }

    // Cache miss: fetch from database
    // PROBLEM: 200 goroutines can reach this point simultaneously
    profile, err := db.QueryUserProfile(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Store in cache
    localCache.Set(cacheKey, profile, 5*time.Minute)
    return profile, nil
}
```

## Section 2: singleflight Fundamentals

### How singleflight Works

The `singleflight.Group` maintains a map from key to in-flight call. When `Do` is called:
1. If no call is in-flight for this key: start a new call, add it to the map
2. If a call is already in-flight for this key: wait for it to complete, return the same result

The critical property: **all waiters receive the same value from the single underlying call**. This means the result must be treated as immutable — if callers modify the returned struct, they need a copy.

```go
package singleflight_test

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "golang.org/x/sync/singleflight"
)

func TestSingleflightCoalescing(t *testing.T) {
    var group singleflight.Group
    var callCount atomic.Int64

    // Simulate expensive operation
    expensiveOp := func() (interface{}, error) {
        callCount.Add(1)
        time.Sleep(100 * time.Millisecond) // simulate work
        return "result", nil
    }

    var wg sync.WaitGroup
    const concurrent = 100

    for i := 0; i < concurrent; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            val, err, shared := group.Do("same-key", expensiveOp)
            if err != nil {
                t.Errorf("unexpected error: %v", err)
            }
            _ = val
            _ = shared
        }()
    }

    wg.Wait()

    // Despite 100 concurrent calls, the expensive operation ran only once
    if calls := callCount.Load(); calls != 1 {
        t.Errorf("expected 1 call to expensive op, got %d", calls)
    }
    fmt.Printf("100 concurrent requests coalesced into %d actual call\n", callCount.Load())
}
```

### Basic Integration Pattern

```go
// pkg/cache/user_cache.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
    "golang.org/x/sync/singleflight"
)

type UserCache struct {
    redis     *redis.Client
    db        UserRepository
    sfGroup   singleflight.Group
    localCache *sync.Map // in-process hot cache
}

func NewUserCache(redis *redis.Client, db UserRepository) *UserCache {
    return &UserCache{
        redis:      redis,
        db:         db,
        localCache: &sync.Map{},
    }
}

type cacheEntry struct {
    profile   *UserProfile
    expiresAt time.Time
}

func (c *UserCache) GetUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
    cacheKey := fmt.Sprintf("user:profile:%s", userID)

    // Layer 1: In-process cache (zero latency)
    if entry, ok := c.localCache.Load(cacheKey); ok {
        e := entry.(cacheEntry)
        if time.Now().Before(e.expiresAt) {
            return e.profile, nil
        }
        c.localCache.Delete(cacheKey)
    }

    // Layer 2: Singleflight — coalesce concurrent misses
    // The key here is "user:profile:<id>" — all concurrent requests for the
    // same user will wait for a single database fetch
    result, err, _ := c.sfGroup.Do(cacheKey, func() (interface{}, error) {
        // Layer 3: Redis distributed cache
        data, err := c.redis.Get(ctx, cacheKey).Bytes()
        if err == nil {
            var profile UserProfile
            if json.Unmarshal(data, &profile) == nil {
                return &profile, nil
            }
        }

        // Layer 4: Database (the expensive operation)
        profile, err := c.db.GetUserProfile(ctx, userID)
        if err != nil {
            return nil, fmt.Errorf("fetching user profile: %w", err)
        }

        // Populate Redis cache
        data, _ = json.Marshal(profile)
        c.redis.Set(ctx, cacheKey, data, 5*time.Minute)

        return profile, nil
    })

    if err != nil {
        return nil, err
    }

    profile := result.(*UserProfile)

    // IMPORTANT: singleflight shares the same pointer among all waiters.
    // Store in local cache (separate copy is not needed here since we only read,
    // but if callers might modify, make a defensive copy)
    c.localCache.Store(cacheKey, cacheEntry{
        profile:   profile,
        expiresAt: time.Now().Add(30 * time.Second), // shorter TTL than Redis
    })

    return profile, nil
}
```

### The Shared Result Gotcha

```go
// DANGER: all callers share the same pointer
result, err, shared := group.Do(key, func() (interface{}, error) {
    return &UserProfile{Name: "Alice"}, nil
})

profile := result.(*UserProfile)
// If caller 1 modifies profile:
profile.Name = "Bob"
// ALL other callers who received the shared result now see "Bob"!

// SAFE: return a deep copy from the singleflight function
result, err, _ := group.Do(key, func() (interface{}, error) {
    original, err := fetchFromDB(ctx, key)
    if err != nil {
        return nil, err
    }
    // Return a copy that callers can safely modify
    copy := *original
    return &copy, nil
})
```

## Section 3: DoChan for Non-Blocking Async Coalescing

### Using DoChan

`DoChan` returns a channel instead of blocking. This allows the caller to participate in other work while waiting, or to implement timeouts:

```go
// pkg/api/async_handler.go
package api

import (
    "context"
    "net/http"
    "time"

    "golang.org/x/sync/singleflight"
)

type ReportHandler struct {
    sfGroup singleflight.Group
    db      ReportRepository
}

// GenerateReport handles expensive report generation with coalescing.
// Multiple simultaneous requests for the same report share one generation.
func (h *ReportHandler) GenerateReport(w http.ResponseWriter, r *http.Request) {
    reportID := r.URL.Query().Get("id")
    if reportID == "" {
        http.Error(w, "missing report ID", http.StatusBadRequest)
        return
    }

    // DoChan returns immediately; the result arrives on the channel
    ch := h.sfGroup.DoChan(reportID, func() (interface{}, error) {
        return h.db.GenerateReport(r.Context(), reportID)
    })

    // Wait for result with request context timeout
    select {
    case result := <-ch:
        if result.Err != nil {
            http.Error(w, result.Err.Error(), http.StatusInternalServerError)
            return
        }
        report := result.Val.(*Report)
        // Write shared is true if this goroutine was not the original caller
        // but received a coalesced result
        if result.Shared {
            w.Header().Set("X-Coalesced", "true")
        }
        writeJSONResponse(w, report)

    case <-r.Context().Done():
        // Client disconnected or request timeout exceeded
        // The underlying singleflight call continues for other waiters
        http.Error(w, "request cancelled", http.StatusRequestTimeout)
        return
    }
}
```

### Fan-Out Pattern with DoChan

```go
// Fetch multiple items concurrently, coalescing duplicate keys
func (c *Cache) GetBatch(ctx context.Context, keys []string) (map[string]interface{}, error) {
    type result struct {
        key string
        val interface{}
        err error
    }

    // Deduplicate keys
    seen := make(map[string]bool)
    unique := make([]string, 0, len(keys))
    for _, k := range keys {
        if !seen[k] {
            seen[k] = true
            unique = append(unique, k)
        }
    }

    // Launch concurrent fetches with singleflight coalescing
    channels := make(map[string]<-chan singleflight.Result, len(unique))
    for _, key := range unique {
        key := key
        channels[key] = c.sfGroup.DoChan(key, func() (interface{}, error) {
            return c.fetchSingle(ctx, key)
        })
    }

    // Collect results
    results := make(map[string]interface{}, len(keys))
    var firstErr error

    for key, ch := range channels {
        select {
        case r := <-ch:
            if r.Err != nil && firstErr == nil {
                firstErr = r.Err
            } else if r.Err == nil {
                results[key] = r.Val
            }
        case <-ctx.Done():
            return results, ctx.Err()
        }
    }

    return results, firstErr
}
```

## Section 4: Forget for Cache Invalidation

### When to Use Forget

`Forget` tells the singleflight group to forget about an in-flight call. Future calls with the same key will start a new underlying call, even if one is currently in progress.

This is important for error recovery: if the in-flight call fails, you may want to allow the next request to retry immediately rather than serving the error to all queued waiters.

```go
// pkg/cache/resilient_cache.go
package cache

import (
    "context"
    "errors"
    "time"

    "golang.org/x/sync/singleflight"
)

type ResilientCache struct {
    sfGroup   singleflight.Group
    inner     CacheBackend
    db        DataRepository
}

func (c *ResilientCache) Get(ctx context.Context, key string) (interface{}, error) {
    val, err, _ := c.sfGroup.Do(key, func() (interface{}, error) {
        // Try cache first
        if val, ok := c.inner.Get(key); ok {
            return val, nil
        }

        // Fetch from DB
        result, err := c.db.Fetch(ctx, key)
        if err != nil {
            // CRITICAL: Forget the key so the next request tries again
            // Without Forget, all queued requests would receive this error
            // AND future requests within the singleflight window would also
            // get the error without retrying
            c.sfGroup.Forget(key)
            return nil, err
        }

        c.inner.Set(key, result, 5*time.Minute)
        return result, nil
    })

    return val, err
}
```

### Forget with Exponential Backoff

```go
// Retry with backoff, using Forget to allow re-attempts
func (c *ResilientCache) GetWithRetry(ctx context.Context, key string) (interface{}, error) {
    maxAttempts := 3
    backoff := 100 * time.Millisecond

    for attempt := 0; attempt < maxAttempts; attempt++ {
        val, err, _ := c.sfGroup.Do(key, func() (interface{}, error) {
            return c.db.Fetch(ctx, key)
        })

        if err == nil {
            return val, nil
        }

        // Check if error is retryable
        if !isRetryableError(err) {
            return nil, err
        }

        // Forget key to allow next attempt to proceed
        c.sfGroup.Forget(key)

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(backoff):
            backoff *= 2
        }
    }

    return nil, errors.New("max retry attempts exceeded")
}

func isRetryableError(err error) bool {
    // Classify errors as retryable or not
    var dbErr *DatabaseError
    if errors.As(err, &dbErr) {
        return dbErr.Temporary
    }
    return true // default: retry
}
```

## Section 5: Combining with In-Process Cache

### Multi-Layer Cache Architecture

```go
// pkg/cache/multilayer.go
package cache

import (
    "context"
    "sync"
    "time"

    "golang.org/x/sync/singleflight"
)

// hotCacheEntry is an in-process cache entry with TTL
type hotCacheEntry struct {
    value     interface{}
    expiresAt time.Time
}

// MultiLayerCache provides:
// L1: In-process sync.Map (nanosecond reads)
// L2: singleflight deduplication (prevents stampedes)
// L3: Redis distributed cache (millisecond reads)
// L4: Primary data source (expensive)
type MultiLayerCache struct {
    l1          sync.Map             // in-process hot cache
    sfGroup     singleflight.Group   // stampede prevention
    l3          RedisCache            // distributed cache
    source      DataSource            // primary data source
    l1TTL       time.Duration
    l3TTL       time.Duration
    l1MaxSize   int
    l1Size      int
    l1SizeMu    sync.Mutex
}

func NewMultiLayerCache(redis RedisCache, source DataSource) *MultiLayerCache {
    c := &MultiLayerCache{
        l3:        redis,
        source:    source,
        l1TTL:     30 * time.Second,
        l3TTL:     5 * time.Minute,
        l1MaxSize: 10000,
    }

    // Start background eviction for L1
    go c.evictExpiredL1()

    return c
}

func (c *MultiLayerCache) Get(ctx context.Context, key string) (interface{}, error) {
    // L1: Check in-process cache (no lock needed for read)
    if entry, ok := c.l1.Load(key); ok {
        e := entry.(hotCacheEntry)
        if time.Now().Before(e.expiresAt) {
            return e.value, nil  // ~100ns
        }
        c.l1.Delete(key)
    }

    // L2+L3+L4: Coalesce through singleflight
    result, err, _ := c.sfGroup.Do(key, func() (interface{}, error) {
        // L3: Redis check
        val, err := c.l3.Get(ctx, key)
        if err == nil {
            // Populate L1 from L3
            c.storeL1(key, val)
            return val, nil  // ~1ms
        }

        // L4: Primary source fetch
        val, err = c.source.Fetch(ctx, key)
        if err != nil {
            c.sfGroup.Forget(key)  // allow retry on error
            return nil, err
        }

        // Populate L3 and L1
        c.l3.Set(ctx, key, val, c.l3TTL)
        c.storeL1(key, val)

        return val, nil
    })

    return result, err
}

func (c *MultiLayerCache) storeL1(key string, val interface{}) {
    c.l1SizeMu.Lock()
    defer c.l1SizeMu.Unlock()

    if c.l1Size >= c.l1MaxSize {
        return // L1 is full, skip — Redis is still populated
    }

    c.l1.Store(key, hotCacheEntry{
        value:     val,
        expiresAt: time.Now().Add(c.l1TTL),
    })
    c.l1Size++
}

// Invalidate removes a key from all cache layers
func (c *MultiLayerCache) Invalidate(ctx context.Context, key string) error {
    // Forget in-flight singleflight to prevent stale data
    c.sfGroup.Forget(key)

    // Remove from L1
    c.l1.Delete(key)

    // Remove from L3
    return c.l3.Delete(ctx, key)
}

func (c *MultiLayerCache) evictExpiredL1() {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        now := time.Now()
        c.l1.Range(func(key, value interface{}) bool {
            entry := value.(hotCacheEntry)
            if now.After(entry.expiresAt) {
                c.l1.Delete(key)
                c.l1SizeMu.Lock()
                c.l1Size--
                c.l1SizeMu.Unlock()
            }
            return true
        })
    }
}
```

## Section 6: Distributed Singleflight with Redis

### The Multi-Instance Problem

`singleflight.Group` is in-process — it doesn't coordinate across multiple service instances. In a deployment with 10 pods, a cache stampede can still result in 10 database queries (one per pod).

The solution is distributed singleflight using Redis distributed locking:

```go
// pkg/cache/distributed_singleflight.go
package cache

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
    "golang.org/x/sync/singleflight"
)

const (
    lockTTL      = 30 * time.Second
    lockPrefix   = "sflock:"
    resultPrefix = "sfresult:"
)

// DistributedSingleflight coalesces requests across multiple service instances
// using Redis for coordination. One instance wins the lock, fetches the data,
// and stores it in Redis. All other instances wait and read the result.
type DistributedSingleflight struct {
    redis      *redis.Client
    localSF    singleflight.Group
    fetchTimeout time.Duration
}

type distributedResult struct {
    Value interface{}
    Err   string // serialized error (empty if no error)
}

func NewDistributedSingleflight(redis *redis.Client) *DistributedSingleflight {
    return &DistributedSingleflight{
        redis:        redis,
        fetchTimeout: 25 * time.Second, // Must be < lockTTL
    }
}

// Do executes the function with distributed deduplication.
// Only one instance across the cluster will execute fn; others wait.
func (d *DistributedSingleflight) Do(
    ctx context.Context,
    key string,
    fn func() (interface{}, error),
) (interface{}, error) {
    // First: local singleflight (deduplicate within this instance)
    val, err, _ := d.localSF.Do(key, func() (interface{}, error) {
        return d.doDistributed(ctx, key, fn)
    })
    return val, err
}

func (d *DistributedSingleflight) doDistributed(
    ctx context.Context,
    key string,
    fn func() (interface{}, error),
) (interface{}, error) {
    lockKey := lockPrefix + key
    resultKey := resultPrefix + key

    // Try to acquire the distributed lock (using SET NX with TTL)
    acquired, err := d.redis.SetNX(ctx, lockKey, "1", lockTTL).Result()
    if err != nil {
        // Redis error: fall back to direct execution
        return fn()
    }

    if acquired {
        // This instance won the lock — do the actual work
        defer d.redis.Del(ctx, lockKey)

        result, fetchErr := fn()
        if fetchErr != nil {
            // Store the error so waiters know the fetch failed
            serialized, _ := json.Marshal(distributedResult{
                Err: fetchErr.Error(),
            })
            d.redis.Set(ctx, resultKey, serialized, 5*time.Second)
            d.redis.Del(ctx, lockKey) // release lock early on error
            return nil, fetchErr
        }

        // Serialize and store the result for other instances
        resultData, _ := json.Marshal(result)
        serialized, _ := json.Marshal(distributedResult{Value: json.RawMessage(resultData)})
        d.redis.Set(ctx, resultKey, serialized, 60*time.Second) // short TTL — just for coalescing
        d.redis.Del(ctx, lockKey) // release lock so waiters can proceed
        return result, nil
    }

    // Another instance is fetching — wait for the result
    return d.waitForResult(ctx, key, resultKey, lockKey)
}

func (d *DistributedSingleflight) waitForResult(
    ctx context.Context,
    key, resultKey, lockKey string,
) (interface{}, error) {
    deadline := time.Now().Add(d.fetchTimeout)

    for time.Now().Before(deadline) {
        // Check if result is available
        data, err := d.redis.Get(ctx, resultKey).Bytes()
        if err == nil {
            var res distributedResult
            if json.Unmarshal(data, &res) == nil {
                if res.Err != "" {
                    return nil, errors.New(res.Err)
                }
                // Parse the actual result value
                // Note: type assertion here depends on your application's types
                return res.Value, nil
            }
        }

        // Check if lock still exists (holder may have crashed)
        lockExists, _ := d.redis.Exists(ctx, lockKey).Result()
        if lockExists == 0 {
            // Lock released without result — try to become the new lock holder
            return d.doDistributed(ctx, key, func() (interface{}, error) {
                // Placeholder: in practice, pass the actual fn through
                return nil, fmt.Errorf("lock holder crashed")
            })
        }

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(50 * time.Millisecond): // poll interval
        }
    }

    return nil, fmt.Errorf("timeout waiting for distributed singleflight result for key: %s", key)
}
```

### Redis-Backed Singleflight with Pub/Sub

A more efficient implementation uses Redis Pub/Sub to notify waiters when the result is ready, avoiding polling:

```go
// pkg/cache/pubsub_singleflight.go
package cache

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/v9"
)

type PubSubSingleflight struct {
    redis   *redis.Client
    localSF singleflight.Group
}

func (p *PubSubSingleflight) Do(
    ctx context.Context,
    key string,
    fn func() (interface{}, error),
) (interface{}, error) {
    // Local deduplication first
    val, err, _ := p.localSF.Do(key, func() (interface{}, error) {
        return p.doWithPubSub(ctx, key, fn)
    })
    return val, err
}

func (p *PubSubSingleflight) doWithPubSub(
    ctx context.Context,
    key string,
    fn func() (interface{}, error),
) (interface{}, error) {
    lockKey := "dsf:lock:" + key
    notifyChannel := "dsf:result:" + key

    // Subscribe BEFORE acquiring lock to avoid race condition
    pubsub := p.redis.Subscribe(ctx, notifyChannel)
    defer pubsub.Close()

    // Try to acquire lock
    acquired, _ := p.redis.SetNX(ctx, lockKey, "1", 30*time.Second).Result()

    if acquired {
        defer p.redis.Del(ctx, lockKey)

        result, err := fn()

        // Publish result notification
        notification := "ok"
        if err != nil {
            notification = "error:" + err.Error()
        }
        p.redis.Publish(ctx, notifyChannel, notification)

        return result, err
    }

    // Wait for pub/sub notification (efficient — no polling)
    msgCh := pubsub.Channel()
    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    case msg := <-msgCh:
        if msg.Payload == "ok" {
            // Fetch the result from the regular cache
            data, err := p.redis.Get(ctx, "cache:"+key).Bytes()
            if err != nil {
                return nil, err
            }
            var result interface{}
            json.Unmarshal(data, &result)
            return result, nil
        }
        return nil, fmt.Errorf("remote fetch failed: %s", msg.Payload)
    case <-time.After(30 * time.Second):
        return nil, fmt.Errorf("timeout waiting for distributed result")
    }
}
```

## Section 7: Benchmarking Cache Stampede Prevention

### Benchmark Setup

```go
// pkg/cache/singleflight_bench_test.go
package cache_test

import (
    "context"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "golang.org/x/sync/singleflight"
)

// Simulate expensive DB query
func slowFetch(ctx context.Context, key string) (interface{}, error) {
    time.Sleep(50 * time.Millisecond) // 50ms database latency
    return "value-for-" + key, nil
}

// BenchmarkWithoutSingleflight demonstrates stampede behavior
func BenchmarkWithoutSingleflight(b *testing.B) {
    var callCount atomic.Int64
    cache := sync.Map{}

    b.SetParallelism(100)
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            key := "hot-key"  // simulating a popular cache key

            if val, ok := cache.Load(key); ok {
                _ = val
                continue
            }

            callCount.Add(1)
            val, _ := slowFetch(context.Background(), key)
            cache.Store(key, val)
        }
    })

    b.ReportMetric(float64(callCount.Load()), "db_calls")
}

// BenchmarkWithSingleflight demonstrates coalescing
func BenchmarkWithSingleflight(b *testing.B) {
    var callCount atomic.Int64
    var sfGroup singleflight.Group
    cache := sync.Map{}

    b.SetParallelism(100)
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            key := "hot-key"

            if val, ok := cache.Load(key); ok {
                _ = val
                continue
            }

            val, _, _ := sfGroup.Do(key, func() (interface{}, error) {
                callCount.Add(1)
                result, err := slowFetch(context.Background(), key)
                if err == nil {
                    cache.Store(key, result)
                }
                return result, err
            })
            _ = val
        }
    })

    b.ReportMetric(float64(callCount.Load()), "db_calls")
}

// BenchmarkMultipleKeys tests with realistic key distribution
func BenchmarkMultipleKeys(b *testing.B) {
    var sfGroup singleflight.Group
    var totalFetches atomic.Int64

    keys := make([]string, 1000)
    for i := range keys {
        keys[i] = fmt.Sprintf("user:%d", i)
    }

    b.SetParallelism(50)
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            // Zipf distribution: 20% of keys get 80% of traffic
            var key string
            if rand.Float64() < 0.8 {
                key = keys[rand.Intn(200)]  // hot 20%
            } else {
                key = keys[200+rand.Intn(800)]  // cold 80%
            }

            sfGroup.Do(key, func() (interface{}, error) {
                totalFetches.Add(1)
                return slowFetch(context.Background(), key)
            })
        }
    })

    b.ReportMetric(float64(totalFetches.Load()), "total_db_fetches")
}
```

```bash
# Run benchmarks with race detector
go test -race -bench=BenchmarkWithoutSingleflight ./pkg/cache/
go test -race -bench=BenchmarkWithSingleflight ./pkg/cache/
go test -race -bench=BenchmarkMultipleKeys ./pkg/cache/

# Example results:
# BenchmarkWithoutSingleflight-16    54321    22ms/op    5432 db_calls
# BenchmarkWithSingleflight-16       54321    22ms/op      12 db_calls
# (same throughput, 450x fewer DB calls)
```

## Section 8: Production Metrics and Observability

### Instrumented singleflight Group

```go
// pkg/cache/instrumented_sf.go
package cache

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "golang.org/x/sync/singleflight"
)

var (
    sfCoalescedRequests = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "singleflight_coalesced_requests_total",
            Help: "Total requests that were coalesced (served from another's in-flight call)",
        },
        []string{"key_prefix"},
    )

    sfOriginalRequests = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "singleflight_original_requests_total",
            Help: "Total requests that initiated an actual backend call",
        },
        []string{"key_prefix"},
    )

    sfDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "singleflight_duration_seconds",
            Help:    "Duration of singleflight-coalesced operations",
            Buckets: prometheus.DefBuckets,
        },
        []string{"key_prefix", "result"},
    )
)

type InstrumentedGroup struct {
    group     singleflight.Group
    keyPrefix string
}

func NewInstrumentedGroup(keyPrefix string) *InstrumentedGroup {
    return &InstrumentedGroup{keyPrefix: keyPrefix}
}

func (g *InstrumentedGroup) Do(key string, fn func() (interface{}, error)) (interface{}, error, bool) {
    start := time.Now()

    val, err, shared := g.group.Do(key, fn)

    duration := time.Since(start).Seconds()
    result := "success"
    if err != nil {
        result = "error"
    }

    g.sfDuration.WithLabelValues(g.keyPrefix, result).Observe(duration)

    if shared {
        g.sfCoalescedRequests.WithLabelValues(g.keyPrefix).Inc()
    } else {
        g.sfOriginalRequests.WithLabelValues(g.keyPrefix).Inc()
    }

    return val, err, shared
}
```

### Alerting on Cache Stampedes

```yaml
# prometheus-cache-alerts.yaml
groups:
  - name: cache.stampede
    rules:
      - alert: CacheStampedeRisk
        expr: |
          rate(cache_miss_total[1m]) / rate(cache_request_total[1m]) > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Cache miss rate >50% — stampede risk"
          description: |
            Cache {{ $labels.cache_name }} miss rate: {{ $value | humanizePercentage }}.
            Singleflight should be protecting backends, but check DB load.

      - alert: DatabaseQPSSpike
        expr: |
          rate(db_queries_total[1m])
          /
          rate(db_queries_total[1m] offset 5m) > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database QPS 5x spike — potential cache stampede"
          description: |
            DB queries spiked from {{ $value }}x baseline.
            Check cache TTLs and singleflight instrumentation.
```

## Conclusion

`singleflight` is a single-file solution to one of the most damaging failure modes in high-traffic Go services. The integration pattern is straightforward: wrap your cache-miss → database fetch path in `group.Do()` with the cache key, and concurrent requests for the same key share a single backend call.

The key operational considerations are: always call `Forget` on error to allow retries rather than propagating errors to all queued waiters; be careful with shared pointer results to avoid accidental data mutation across callers; and for multi-instance deployments, layer Redis-based distributed locking or pub/sub coordination to reduce cross-pod stampedes. The `DoChan` pattern enables context-aware cancellation without abandoning the underlying in-flight request — critical for handling individual request timeouts without blocking protection for other callers.
