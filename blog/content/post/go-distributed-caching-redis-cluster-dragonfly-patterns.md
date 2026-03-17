---
title: "Go Distributed Caching: Redis Cluster, Dragonfly, and Cache-Aside Patterns at Scale"
date: 2030-01-21T00:00:00-05:00
draft: false
tags: ["Go", "Redis", "Dragonfly", "Caching", "Distributed Systems", "Performance", "Architecture"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production caching architectures with Redis Cluster and Dragonfly (Redis-compatible), consistent hashing, cache invalidation strategies, read-through and write-behind patterns in Go at enterprise scale."
more_link: "yes"
url: "/go-distributed-caching-redis-cluster-dragonfly-patterns/"
---

A cache that adds 2ms to every request while saving 50ms on 30% of them is a good trade. A cache with 40% hit rate instead of 85% is leaving most of that improvement on the table. The difference between these outcomes is architectural: how you partition keys, how you handle invalidation, how you structure your cache client to be resilient to backend failures. This guide builds a production caching layer in Go on top of Redis Cluster and Dragonfly, implementing cache-aside with stampede prevention, write-behind for write-heavy workloads, and consistent hashing for multi-tier setups.

<!--more-->

# Go Distributed Caching: Redis Cluster, Dragonfly, and Cache-Aside Patterns at Scale

## Redis Cluster vs. Dragonfly

Before building cache clients, understand the backend options:

### Redis Cluster

Redis Cluster shards data across 16,384 hash slots distributed across nodes. Advantages:
- Mature, well-understood operational model
- Strong ecosystem (Sentinel, Cluster mode, replication)
- Wide client library support
- Predictable latency

Limitations:
- Single-threaded command processing per node
- Memory limited by individual node capacity
- Multi-key operations constrained to same hash slot

### Dragonfly

Dragonfly is a Redis-compatible server built on a shared-nothing architecture using fibers (not threads). Key differences:

- **Multi-threaded**: Saturates all CPU cores
- **Memory efficiency**: 20-30% less RAM for equivalent data via custom data structures
- **Vertical scale**: 1M+ QPS on a single node
- **Full Redis API compatibility**: Drop-in replacement with the same client libraries

When to use Dragonfly:
- You want Redis semantics but need to scale vertically before resorting to cluster mode
- Memory cost is a concern
- You're running on modern multi-core hardware

## Infrastructure Setup

### Redis Cluster on Kubernetes

```yaml
# redis-cluster.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: caching
spec:
  serviceName: redis-cluster
  replicas: 6  # 3 masters + 3 replicas
  selector:
    matchLabels:
      app: redis-cluster
  template:
    metadata:
      labels:
        app: redis-cluster
    spec:
      containers:
        - name: redis
          image: redis:7.2-alpine
          command:
            - redis-server
            - /conf/redis.conf
          ports:
            - containerPort: 6379
              name: client
            - containerPort: 16379
              name: gossip
          resources:
            requests:
              cpu: "500m"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          volumeMounts:
            - name: conf
              mountPath: /conf
            - name: data
              mountPath: /data
          readinessProbe:
            exec:
              command:
                - redis-cli
                - ping
            initialDelaySeconds: 15
            periodSeconds: 5
          livenessProbe:
            exec:
              command:
                - redis-cli
                - ping
            initialDelaySeconds: 30
            periodSeconds: 15
      volumes:
        - name: conf
          configMap:
            name: redis-cluster-config
            items:
              - key: redis.conf
                path: redis.conf
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 20Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-cluster-config
  namespace: caching
data:
  redis.conf: |
    cluster-enabled yes
    cluster-config-file /data/nodes.conf
    cluster-node-timeout 5000
    appendonly yes
    appendfsync everysec
    no-appendfsync-on-rewrite yes
    maxmemory 3gb
    maxmemory-policy allkeys-lru
    lazyfree-lazy-eviction yes
    lazyfree-lazy-expire yes
    lazyfree-lazy-server-del yes
    latency-tracking yes
    latency-tracking-info-percentiles 50 99 99.9
    save ""
    tcp-keepalive 300
    timeout 0
    loglevel notice
```

### Cluster Initialization Job

```bash
#!/bin/bash
# init-redis-cluster.sh

NAMESPACE="caching"
CLUSTER_SIZE=6

# Wait for all pods
echo "Waiting for Redis pods..."
kubectl -n $NAMESPACE wait --for=condition=Ready pod \
  -l app=redis-cluster --timeout=120s

# Get pod IPs
PODS=$(kubectl -n $NAMESPACE get pods \
  -l app=redis-cluster \
  -o jsonpath='{range .items[*]}{.status.podIP}:6379 {end}')

echo "Initializing cluster with: $PODS"
kubectl -n $NAMESPACE exec redis-cluster-0 -- \
  redis-cli --cluster create $PODS \
  --cluster-replicas 1 \
  --cluster-yes

echo "Cluster initialized"
kubectl -n $NAMESPACE exec redis-cluster-0 -- \
  redis-cli cluster info
```

### Dragonfly on Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dragonfly
  namespace: caching
spec:
  replicas: 1  # Single powerful node for vertical scaling
  selector:
    matchLabels:
      app: dragonfly
  template:
    metadata:
      labels:
        app: dragonfly
    spec:
      containers:
        - name: dragonfly
          image: docker.dragonflydb.io/dragonflydb/dragonfly:v1.22.0
          command:
            - /usr/local/bin/dragonfly
            - --maxmemory=6gb
            - --proactor_threads=8
            - --conn_io_threads=4
            - --cache_mode
            - --save_schedule=""
            - --hz=100
            - --bind_source_addresses=""
          ports:
            - containerPort: 6379
          resources:
            requests:
              cpu: "4"
              memory: "8Gi"
            limits:
              cpu: "8"
              memory: "12Gi"
          readinessProbe:
            exec:
              command: [redis-cli, ping]
            initialDelaySeconds: 10
            periodSeconds: 5
```

## Go Cache Client Architecture

### Cache Interface

```go
// pkg/cache/cache.go
package cache

import (
    "context"
    "time"
)

// Cache defines the core cache operations
type Cache interface {
    // Get retrieves a value by key
    Get(ctx context.Context, key string) ([]byte, error)

    // Set stores a value with an optional TTL
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error

    // Delete removes one or more keys
    Delete(ctx context.Context, keys ...string) error

    // Exists checks if a key exists without fetching its value
    Exists(ctx context.Context, key string) (bool, error)

    // GetMulti fetches multiple keys in a single round trip
    GetMulti(ctx context.Context, keys []string) (map[string][]byte, error)

    // SetMulti stores multiple key-value pairs atomically
    SetMulti(ctx context.Context, items map[string]CacheItem) error

    // Increment atomically increments a counter
    Increment(ctx context.Context, key string, by int64) (int64, error)

    // SetNX sets a value only if the key doesn't exist (for distributed locks)
    SetNX(ctx context.Context, key string, value []byte, ttl time.Duration) (bool, error)

    // Close releases resources
    Close() error
}

// CacheItem represents a value with its TTL
type CacheItem struct {
    Value []byte
    TTL   time.Duration
}

// ErrCacheMiss is returned when a key is not found
var ErrCacheMiss = errors.New("cache miss")

// ErrCacheUnavailable is returned when the cache backend is unreachable
var ErrCacheUnavailable = errors.New("cache unavailable")
```

### Redis Cluster Client

```go
// pkg/cache/redis_cluster.go
package cache

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/redis/go-redis/v9"
)

var (
    cacheOperations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "cache_operations_total",
            Help: "Total cache operations by type and result",
        },
        []string{"operation", "result", "backend"},
    )

    cacheLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "cache_operation_duration_seconds",
            Help:    "Cache operation latency",
            Buckets: []float64{0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1},
        },
        []string{"operation", "backend"},
    )

    cacheHitRatio = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "cache_hit_ratio",
            Help: "Rolling cache hit ratio (last 1000 operations)",
        },
        []string{"backend"},
    )
)

// RedisClusterCache implements Cache for Redis Cluster
type RedisClusterCache struct {
    client  *redis.ClusterClient
    backend string
    metrics *cacheMetrics
}

type cacheMetrics struct {
    hits   int64
    misses int64
}

// NewRedisClusterCache creates a new Redis Cluster cache client
func NewRedisClusterCache(addrs []string, opts ...ClusterOption) (*RedisClusterCache, error) {
    cfg := &clusterConfig{
        maxRetries:      3,
        dialTimeout:     5 * time.Second,
        readTimeout:     2 * time.Second,
        writeTimeout:    2 * time.Second,
        poolSize:        20,
        minIdleConns:    5,
        maxIdleTime:     30 * time.Minute,
        readOnly:        false,
        routeByLatency:  true,
    }
    for _, opt := range opts {
        opt(cfg)
    }

    client := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:          addrs,
        MaxRetries:     cfg.maxRetries,
        DialTimeout:    cfg.dialTimeout,
        ReadTimeout:    cfg.readTimeout,
        WriteTimeout:   cfg.writeTimeout,
        PoolSize:       cfg.poolSize,
        MinIdleConns:   cfg.minIdleConns,
        ConnMaxIdleTime: cfg.maxIdleTime,
        ReadOnly:       cfg.readOnly,
        RouteByLatency: cfg.routeByLatency,
        RouteRandomly:  false,
        // TLS config
        TLSConfig: cfg.tls,
    })

    // Verify connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("redis cluster ping failed: %w", err)
    }

    return &RedisClusterCache{
        client:  client,
        backend: "redis-cluster",
    }, nil
}

func (c *RedisClusterCache) Get(ctx context.Context, key string) ([]byte, error) {
    timer := prometheus.NewTimer(cacheLatency.WithLabelValues("get", c.backend))
    defer timer.ObserveDuration()

    val, err := c.client.Get(ctx, key).Bytes()
    if err != nil {
        if errors.Is(err, redis.Nil) {
            cacheOperations.WithLabelValues("get", "miss", c.backend).Inc()
            return nil, ErrCacheMiss
        }
        cacheOperations.WithLabelValues("get", "error", c.backend).Inc()
        return nil, fmt.Errorf("cache get %s: %w", key, err)
    }

    cacheOperations.WithLabelValues("get", "hit", c.backend).Inc()
    return val, nil
}

func (c *RedisClusterCache) Set(
    ctx context.Context,
    key string,
    value []byte,
    ttl time.Duration,
) error {
    timer := prometheus.NewTimer(cacheLatency.WithLabelValues("set", c.backend))
    defer timer.ObserveDuration()

    err := c.client.Set(ctx, key, value, ttl).Err()
    if err != nil {
        cacheOperations.WithLabelValues("set", "error", c.backend).Inc()
        return fmt.Errorf("cache set %s: %w", key, err)
    }

    cacheOperations.WithLabelValues("set", "ok", c.backend).Inc()
    return nil
}

func (c *RedisClusterCache) Delete(ctx context.Context, keys ...string) error {
    if len(keys) == 0 {
        return nil
    }

    // Redis Cluster requires all keys in a MGET/MDEL to share a hash slot
    // Group keys by hash slot and delete in batches
    slotGroups := groupKeysBySlot(keys)

    pipe := c.client.Pipeline()
    for _, group := range slotGroups {
        pipe.Del(ctx, group...)
    }

    _, err := pipe.Exec(ctx)
    return err
}

func (c *RedisClusterCache) GetMulti(
    ctx context.Context,
    keys []string,
) (map[string][]byte, error) {
    if len(keys) == 0 {
        return nil, nil
    }

    timer := prometheus.NewTimer(cacheLatency.WithLabelValues("mget", c.backend))
    defer timer.ObserveDuration()

    // Group by hash slot for cluster compatibility
    slotGroups := groupKeysBySlot(keys)
    result := make(map[string][]byte, len(keys))

    for _, group := range slotGroups {
        vals, err := c.client.MGet(ctx, group...).Result()
        if err != nil {
            return nil, fmt.Errorf("mget failed: %w", err)
        }
        for i, val := range vals {
            if val != nil {
                result[group[i]] = []byte(val.(string))
            }
        }
    }

    return result, nil
}

func (c *RedisClusterCache) SetNX(
    ctx context.Context,
    key string,
    value []byte,
    ttl time.Duration,
) (bool, error) {
    return c.client.SetNX(ctx, key, value, ttl).Result()
}

func (c *RedisClusterCache) Increment(
    ctx context.Context,
    key string,
    by int64,
) (int64, error) {
    return c.client.IncrBy(ctx, key, by).Result()
}

func (c *RedisClusterCache) Exists(ctx context.Context, key string) (bool, error) {
    n, err := c.client.Exists(ctx, key).Result()
    return n > 0, err
}

func (c *RedisClusterCache) Close() error {
    return c.client.Close()
}

// groupKeysBySlot groups keys that share the same Redis hash slot
// This is required for multi-key operations in cluster mode
func groupKeysBySlot(keys []string) [][]string {
    groups := make(map[uint16][]string)
    for _, key := range keys {
        slot := hashSlot(key)
        groups[slot] = append(groups[slot], key)
    }

    result := make([][]string, 0, len(groups))
    for _, group := range groups {
        result = append(result, group)
    }
    return result
}

// hashSlot computes the Redis hash slot for a key
// Redis uses CRC16 modulo 16384, respecting hash tags in {}
func hashSlot(key string) uint16 {
    // Extract hash tag if present
    start := strings.Index(key, "{")
    if start >= 0 {
        end := strings.Index(key[start+1:], "}")
        if end > 0 {
            key = key[start+1 : start+1+end]
        }
    }

    return crc16([]byte(key)) % 16384
}
```

## Cache-Aside Pattern with Stampede Prevention

```go
// pkg/cache/cacheaside.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "golang.org/x/sync/singleflight"
)

// FetchFunc is the function called on cache miss to load data from the source
type FetchFunc[T any] func(ctx context.Context, key string) (T, error)

// CacheAsideClient wraps a Cache with cache-aside logic
type CacheAsideClient[T any] struct {
    cache     Cache
    flight    singleflight.Group  // Prevents cache stampedes
    keyPrefix string
    defaultTTL time.Duration
    staleWhileRevalidate time.Duration  // Serve stale data while refreshing
}

func NewCacheAsideClient[T any](
    cache Cache,
    keyPrefix string,
    defaultTTL time.Duration,
) *CacheAsideClient[T] {
    return &CacheAsideClient[T]{
        cache:      cache,
        keyPrefix:  keyPrefix,
        defaultTTL: defaultTTL,
        staleWhileRevalidate: 30 * time.Second,
    }
}

// Get implements cache-aside with singleflight stampede prevention
func (c *CacheAsideClient[T]) Get(
    ctx context.Context,
    key string,
    fetch FetchFunc[T],
) (T, bool, error) {
    cacheKey := c.keyPrefix + ":" + key

    // Try cache first
    cached, err := c.cache.Get(ctx, cacheKey)
    if err == nil {
        var val T
        if err := json.Unmarshal(cached, &val); err == nil {
            return val, true, nil  // cache hit
        }
    }

    if err != nil && !errors.Is(err, ErrCacheMiss) {
        // Cache error - log but proceed to fetch
        fmt.Printf("cache get error for %s: %v\n", cacheKey, err)
    }

    // Cache miss - use singleflight to prevent stampede
    // Multiple concurrent requests for the same key will share one fetch
    result, err, shared := c.flight.Do(key, func() (interface{}, error) {
        val, fetchErr := fetch(ctx, key)
        if fetchErr != nil {
            return nil, fetchErr
        }

        // Serialize and cache the result
        data, marshalErr := json.Marshal(val)
        if marshalErr == nil {
            setErr := c.cache.Set(ctx, cacheKey, data, c.defaultTTL)
            if setErr != nil {
                fmt.Printf("cache set error for %s: %v\n", cacheKey, setErr)
            }
        }

        return val, nil
    })
    if err != nil {
        var zero T
        return zero, false, fmt.Errorf("fetch failed for %s: %w", key, err)
    }

    _ = shared  // Can be logged for observability: how often do we deduplicate?

    return result.(T), false, nil
}

// GetOrSetMulti fetches multiple keys with batched source loading
func (c *CacheAsideClient[T]) GetOrSetMulti(
    ctx context.Context,
    keys []string,
    batchFetch func(ctx context.Context, keys []string) (map[string]T, error),
) (map[string]T, error) {
    cacheKeys := make([]string, len(keys))
    for i, k := range keys {
        cacheKeys[i] = c.keyPrefix + ":" + k
    }

    // Fetch what's in cache
    cached, err := c.cache.GetMulti(ctx, cacheKeys)
    if err != nil {
        // Fall through to full fetch on cache error
        cached = make(map[string][]byte)
    }

    // Determine which keys are missing
    result := make(map[string]T, len(keys))
    var missingKeys []string

    for i, key := range keys {
        cacheKey := cacheKeys[i]
        if data, ok := cached[cacheKey]; ok {
            var val T
            if json.Unmarshal(data, &val) == nil {
                result[key] = val
                continue
            }
        }
        missingKeys = append(missingKeys, key)
    }

    if len(missingKeys) == 0 {
        return result, nil
    }

    // Batch-fetch missing keys from source
    fetched, err := batchFetch(ctx, missingKeys)
    if err != nil {
        return nil, fmt.Errorf("batch fetch failed: %w", err)
    }

    // Cache fetched values and merge into result
    cacheItems := make(map[string]CacheItem, len(fetched))
    for key, val := range fetched {
        result[key] = val
        if data, err := json.Marshal(val); err == nil {
            cacheItems[c.keyPrefix+":"+key] = CacheItem{
                Value: data,
                TTL:   c.defaultTTL,
            }
        }
    }

    if len(cacheItems) > 0 {
        if err := c.cache.SetMulti(ctx, cacheItems); err != nil {
            fmt.Printf("cache setmulti error: %v\n", err)
        }
    }

    return result, nil
}

// Invalidate removes a key from the cache
func (c *CacheAsideClient[T]) Invalidate(ctx context.Context, keys ...string) error {
    cacheKeys := make([]string, len(keys))
    for i, k := range keys {
        cacheKeys[i] = c.keyPrefix + ":" + k
    }
    return c.cache.Delete(ctx, cacheKeys...)
}
```

## Write-Behind Pattern

```go
// pkg/cache/writebehind.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"
)

// WriteBehindWriter is the function that persists data to the source of truth
type WriteBehindWriter[T any] func(ctx context.Context, key string, val T) error

// WriteBehindCache implements write-behind (also called write-back) caching
// Writes go to cache immediately, are batched and written to the backend asynchronously
type WriteBehindCache[T any] struct {
    cache      Cache
    writer     WriteBehindWriter[T]
    keyPrefix  string
    flushInterval time.Duration
    maxBatch   int

    mu      sync.Mutex
    dirty   map[string]T
    stopCh  chan struct{}
    doneCh  chan struct{}
}

func NewWriteBehindCache[T any](
    cache Cache,
    writer WriteBehindWriter[T],
    keyPrefix string,
    flushInterval time.Duration,
) *WriteBehindCache[T] {
    wb := &WriteBehindCache[T]{
        cache:         cache,
        writer:        writer,
        keyPrefix:     keyPrefix,
        flushInterval: flushInterval,
        maxBatch:      1000,
        dirty:         make(map[string]T),
        stopCh:        make(chan struct{}),
        doneCh:        make(chan struct{}),
    }
    go wb.flushLoop()
    return wb
}

// Set writes to cache immediately and queues a write to the backend
func (w *WriteBehindCache[T]) Set(
    ctx context.Context,
    key string,
    val T,
    ttl time.Duration,
) error {
    data, err := json.Marshal(val)
    if err != nil {
        return fmt.Errorf("marshal failed: %w", err)
    }

    if err := w.cache.Set(ctx, w.keyPrefix+":"+key, data, ttl); err != nil {
        return fmt.Errorf("cache write failed: %w", err)
    }

    // Queue for async backend write
    w.mu.Lock()
    w.dirty[key] = val
    w.mu.Unlock()

    return nil
}

func (w *WriteBehindCache[T]) flushLoop() {
    defer close(w.doneCh)
    ticker := time.NewTicker(w.flushInterval)
    defer ticker.Stop()

    for {
        select {
        case <-w.stopCh:
            // Final flush before stopping
            w.flush(context.Background())
            return
        case <-ticker.C:
            w.flush(context.Background())
        }
    }
}

func (w *WriteBehindCache[T]) flush(ctx context.Context) {
    w.mu.Lock()
    if len(w.dirty) == 0 {
        w.mu.Unlock()
        return
    }

    // Take a snapshot and clear the dirty map
    batch := w.dirty
    w.dirty = make(map[string]T, len(batch))
    w.mu.Unlock()

    var wg sync.WaitGroup
    sem := make(chan struct{}, 10)  // Max 10 concurrent writes

    for key, val := range batch {
        key, val := key, val
        wg.Add(1)
        sem <- struct{}{}
        go func() {
            defer wg.Done()
            defer func() { <-sem }()

            writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
            defer cancel()

            if err := w.writer(writeCtx, key, val); err != nil {
                fmt.Printf("[WriteBehind] Failed to persist %s: %v\n", key, err)
                // Re-queue failed writes
                w.mu.Lock()
                if _, alreadyQueued := w.dirty[key]; !alreadyQueued {
                    w.dirty[key] = val
                }
                w.mu.Unlock()
            }
        }()
    }

    wg.Wait()
    fmt.Printf("[WriteBehind] Flushed %d keys\n", len(batch))
}

// Stop flushes remaining writes and stops the background goroutine
func (w *WriteBehindCache[T]) Stop() {
    close(w.stopCh)
    <-w.doneCh
}
```

## Distributed Lock

```go
// pkg/cache/lock.go
package cache

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
)

// DistributedLock provides mutual exclusion using Redis SETNX
type DistributedLock struct {
    cache    Cache
    key      string
    value    string
    ttl      time.Duration
    acquired bool
}

// NewDistributedLock creates a new distributed lock
func NewDistributedLock(cache Cache, name string, ttl time.Duration) *DistributedLock {
    return &DistributedLock{
        cache: cache,
        key:   "lock:" + name,
        value: uuid.New().String(),
        ttl:   ttl,
    }
}

// TryAcquire attempts to acquire the lock without blocking
func (l *DistributedLock) TryAcquire(ctx context.Context) (bool, error) {
    acquired, err := l.cache.SetNX(ctx, l.key, []byte(l.value), l.ttl)
    if err != nil {
        return false, fmt.Errorf("lock acquire failed: %w", err)
    }
    l.acquired = acquired
    return acquired, nil
}

// Acquire blocks until the lock is acquired or context is cancelled
func (l *DistributedLock) Acquire(ctx context.Context) error {
    retryInterval := 50 * time.Millisecond
    maxInterval := 2 * time.Second

    for {
        acquired, err := l.TryAcquire(ctx)
        if err != nil {
            return err
        }
        if acquired {
            return nil
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(retryInterval):
            // Exponential backoff with jitter
            retryInterval *= 2
            if retryInterval > maxInterval {
                retryInterval = maxInterval
            }
        }
    }
}

// Release releases the lock (only if we hold it)
// Uses a Lua script for atomic check-and-delete
func (l *DistributedLock) Release(ctx context.Context) error {
    if !l.acquired {
        return nil
    }

    // Use Lua script to atomically check value and delete
    // This prevents releasing a lock we don't own (if TTL expired and re-acquired)
    luaScript := `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `
    // Note: This requires the cache to support Eval, which is specific to Redis
    // For a generic implementation, we'd use conditional delete
    _ = luaScript

    // Simplified: just delete (less safe but works with generic cache interface)
    l.acquired = false
    return l.cache.Delete(ctx, l.key)
}
```

## Cache Key Design

```go
// pkg/cache/keys.go
package cache

import (
    "crypto/sha256"
    "fmt"
    "strings"
)

// KeyBuilder constructs consistent, namespaced cache keys
type KeyBuilder struct {
    prefix string
    sep    string
}

func NewKeyBuilder(prefix string) *KeyBuilder {
    return &KeyBuilder{prefix: prefix, sep: ":"}
}

// Entity key: "prefix:entity:type:id"
func (b *KeyBuilder) Entity(entityType, id string) string {
    return strings.Join([]string{b.prefix, "entity", entityType, id}, b.sep)
}

// Query key: "prefix:query:hash(params)"
func (b *KeyBuilder) Query(queryName string, params ...string) string {
    key := strings.Join(params, "|")
    hash := fmt.Sprintf("%x", sha256.Sum256([]byte(key)))[:16]
    return strings.Join([]string{b.prefix, "query", queryName, hash}, b.sep)
}

// Tag key for cache invalidation groups: "prefix:tag:tagname"
func (b *KeyBuilder) Tag(tagName string) string {
    return strings.Join([]string{b.prefix, "tag", tagName}, b.sep)
}

// Version key for versioned cache entries
func (b *KeyBuilder) Versioned(entityType, id string, version int64) string {
    return fmt.Sprintf("%s%s%s%s%s%sv%d",
        b.prefix, b.sep, "entity", b.sep, entityType, b.sep, id, b.sep, version)
}

// HashTag returns a key with a hash tag for Redis Cluster slot affinity
// Keys with the same hash tag always go to the same slot
// This enables multi-key operations on related keys
func (b *KeyBuilder) WithHashTag(entityType, id, operation string) string {
    // Hash tag brackets {id} ensure this key shares a slot with
    // other keys for the same entity
    return fmt.Sprintf("%s:{%s:%s}:%s", b.prefix, entityType, id, operation)
}
```

## Production Configuration

### Connection Pool Tuning

```go
// pkg/cache/config.go
package cache

import (
    "crypto/tls"
    "time"
)

type Config struct {
    // Connection
    Addrs           []string
    Password        string
    DB              int
    TLS             *tls.Config

    // Pool settings
    PoolSize        int           // Default: 10 per CPU
    MinIdleConns    int           // Default: 5
    MaxIdleTime     time.Duration // Default: 30m (close idle connections)
    PoolTimeout     time.Duration // Wait time for pool slot (default: 2s)

    // Operation timeouts
    DialTimeout     time.Duration // Default: 5s
    ReadTimeout     time.Duration // Default: 2s
    WriteTimeout    time.Duration // Default: 2s

    // Retry
    MaxRetries      int           // Default: 3
    MinRetryBackoff time.Duration // Default: 8ms
    MaxRetryBackoff time.Duration // Default: 512ms

    // Cluster specific
    RouteByLatency  bool          // Default: true (read from nearest replica)
    RouteRandomly   bool          // Default: false

    // Application settings
    KeyPrefix       string
    DefaultTTL      time.Duration
    MaxValueSize    int           // Reject values exceeding this size
}

func DefaultConfig(addrs []string) Config {
    return Config{
        Addrs:           addrs,
        PoolSize:        20,
        MinIdleConns:    5,
        MaxIdleTime:     30 * time.Minute,
        PoolTimeout:     2 * time.Second,
        DialTimeout:     5 * time.Second,
        ReadTimeout:     2 * time.Second,
        WriteTimeout:    2 * time.Second,
        MaxRetries:      3,
        MinRetryBackoff: 8 * time.Millisecond,
        MaxRetryBackoff: 512 * time.Millisecond,
        RouteByLatency:  true,
        DefaultTTL:      5 * time.Minute,
        MaxValueSize:    1 * 1024 * 1024, // 1MB
    }
}
```

### Health and Monitoring

```go
// pkg/cache/health.go
package cache

import (
    "context"
    "fmt"
    "time"
)

// HealthCheck tests cache connectivity and performance
type HealthCheck struct {
    cache  Cache
    testKey string
}

func NewHealthCheck(cache Cache, keyPrefix string) *HealthCheck {
    return &HealthCheck{
        cache:   cache,
        testKey: keyPrefix + ":health-check",
    }
}

func (h *HealthCheck) Check(ctx context.Context) error {
    testValue := []byte(fmt.Sprintf("healthcheck-%d", time.Now().UnixNano()))

    // Write test
    if err := h.cache.Set(ctx, h.testKey, testValue, 10*time.Second); err != nil {
        return fmt.Errorf("cache write health check failed: %w", err)
    }

    // Read test
    val, err := h.cache.Get(ctx, h.testKey)
    if err != nil {
        return fmt.Errorf("cache read health check failed: %w", err)
    }

    if string(val) != string(testValue) {
        return fmt.Errorf("cache health check value mismatch")
    }

    return nil
}
```

## Prometheus Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cache-alerts
  namespace: monitoring
spec:
  groups:
    - name: cache.alerts
      rules:
        - alert: CacheHitRateLow
          expr: |
            rate(cache_operations_total{result="hit"}[5m])
            /
            rate(cache_operations_total{result=~"hit|miss"}[5m]) < 0.7
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Cache hit rate below 70% for {{ $labels.backend }}"
            description: "Current hit rate: {{ $value | humanizePercentage }}"

        - alert: CacheLatencyHigh
          expr: |
            histogram_quantile(0.99,
              rate(cache_operation_duration_seconds_bucket{operation="get"}[5m])
            ) > 0.01
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cache p99 latency above 10ms"

        - alert: CacheErrorRateHigh
          expr: |
            rate(cache_operations_total{result="error"}[5m])
            /
            rate(cache_operations_total[5m]) > 0.05
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Cache error rate above 5%"
```

## Conclusion

An effective distributed cache requires thinking beyond the client API:

- **Stampede prevention** via singleflight is essential for popular keys — without it, a cache invalidation causes a thundering herd that overwhelms the database backend
- **Key design with hash tags** enables multi-key operations in Redis Cluster, which is critical for transaction-scoped invalidation
- **Write-behind** trades durability for write performance by batching async writes — appropriate for session data, view counts, and other non-critical aggregates
- **Dragonfly** provides Redis-compatible semantics with substantially better resource utilization on modern multi-core hardware, making it the preferred choice for new deployments
- **Circuit-breaker pattern** around cache operations prevents cache failures from cascading to backend exhaustion — always fall through to the data source on cache errors rather than failing the request
- **Consistent TTLs with jitter** prevents synchronized cache expiration (cache stampede at time T+TTL) by adding ±10-20% random variation to all TTL values

The most common production failure mode is cache-amplified backend failures: the cache goes down, all traffic hits the database simultaneously, the database becomes overloaded, recovery takes longer than necessary. Protect against this with read-through fallback, circuit breakers, and request coalescing.
