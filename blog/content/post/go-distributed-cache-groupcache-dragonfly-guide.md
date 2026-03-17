---
title: "Distributed Caching in Go: GroupCache, Dragonfly, and Cache-Aside Patterns"
date: 2028-10-07T00:00:00-05:00
draft: false
tags: ["Go", "Caching", "Distributed Systems", "Redis", "Performance"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go caching patterns covering GroupCache for in-process distributed caching, Dragonfly as a Redis replacement, cache-aside/write-through/write-behind patterns, cache stampede prevention, and monitoring cache hit rates."
more_link: "yes"
url: "/go-distributed-cache-groupcache-dragonfly-guide/"
---

Caching is the single most impactful optimization available to most services, but naive implementations introduce subtle correctness bugs: cache stampedes, stale data during deployments, memory pressure under load, and coordination failures in distributed systems. This guide covers three complementary caching tools—GroupCache for peer-distributed in-process caching, Dragonfly as a high-performance Redis replacement, and production Go patterns for cache-aside, write-through, and write-behind strategies.

<!--more-->

# Distributed Caching in Go: GroupCache, Dragonfly, and Cache-Aside Patterns

## Choosing the Right Cache Architecture

Before selecting a caching library, understand the trade-offs:

| Approach | Latency | Memory | Complexity | Consistency |
|---|---|---|---|---|
| In-process (sync.Map, ristretto) | ~100ns | Shared with app | None | Per-process |
| GroupCache | ~1ms (peer hit) | Distributed | Medium | Group-consistent |
| Redis/Dragonfly | ~1-5ms | Separate process | Low-Medium | Configurable |
| Read-through + write-behind | ~1ms | Separate | High | Eventual |

**GroupCache** is ideal for read-heavy workloads where the same data is requested by multiple service replicas simultaneously. Its single-flight deduplication prevents stampedes at the library level.

**Dragonfly** (Redis-compatible) is ideal when you need shared state across services, pub/sub, sorted sets, or atomic operations. It uses 25x less memory than Redis for the same dataset and supports multi-threaded IO.

## GroupCache: Peer-Distributed In-Process Caching

GroupCache is a distributed caching library from Google (originally used for dl.google.com). It organizes cache peers using consistent hashing and deduplicates concurrent requests for the same key with a single-flight pattern.

### Dependencies

```bash
go get github.com/mailgun/groupcache/v2@v2.5.0
go get github.com/prometheus/client_golang@v1.17.0
go get github.com/hashicorp/memberlist@v0.5.0
```

### GroupCache Setup with Dynamic Peer Discovery

```go
// pkg/cache/groupcache.go
package cache

import (
	"bytes"
	"context"
	"encoding/gob"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/mailgun/groupcache/v2"
	"go.uber.org/zap"
)

// GroupCacheConfig holds configuration for the GroupCache setup.
type GroupCacheConfig struct {
	// Self is the address of this peer (http://hostname:port)
	Self string
	// Peers lists all peer addresses including Self
	Peers []string
	// CacheBytes is the maximum bytes for the hot cache per group
	CacheBytes int64
	// GroupName identifies this cache group
	GroupName string
}

// ProductCache wraps GroupCache for product data.
type ProductCache struct {
	group  *groupcache.Group
	pool   *groupcache.HTTPPool
	log    *zap.Logger
	mu     sync.RWMutex
	peers  []string
}

// Product is the data type being cached.
type Product struct {
	ID          string
	Name        string
	Price       float64
	Description string
	UpdatedAt   time.Time
}

// NewProductCache creates a GroupCache-backed product cache.
func NewProductCache(cfg GroupCacheConfig, fetcher func(ctx context.Context, id string) (*Product, error), log *zap.Logger) *ProductCache {
	pc := &ProductCache{log: log, peers: cfg.Peers}

	// Create the HTTP pool for peer communication
	pool := groupcache.NewHTTPPoolOpts(cfg.Self, &groupcache.HTTPPoolOptions{
		BasePath: "/_groupcache/",
	})

	// Set initial peers
	pool.Set(cfg.Peers...)
	pc.pool = pool

	// Create the cache group
	pc.group = groupcache.NewGroup(cfg.GroupName, cfg.CacheBytes, groupcache.GetterFunc(
		func(ctx context.Context, key string, dest groupcache.Sink) error {
			log.Debug("cache miss, fetching from source", zap.String("key", key))

			product, err := fetcher(ctx, key)
			if err != nil {
				return fmt.Errorf("fetch product %q: %w", key, err)
			}

			// Serialize using gob
			var buf bytes.Buffer
			if err := gob.NewEncoder(&buf).Encode(product); err != nil {
				return fmt.Errorf("encode product: %w", err)
			}

			// SetBytes with TTL (requires groupcache/v2 with expiry support)
			return dest.SetBytes(buf.Bytes(), time.Now().Add(5*time.Minute))
		},
	))

	return pc
}

// Get retrieves a product by ID from cache or the backing store.
// GroupCache handles: consistent hash routing, single-flight dedup, and eviction.
func (pc *ProductCache) Get(ctx context.Context, id string) (*Product, error) {
	var data []byte
	if err := pc.group.Get(ctx, id, groupcache.AllocatingByteSliceSink(&data)); err != nil {
		return nil, fmt.Errorf("groupcache get %q: %w", id, err)
	}

	var product Product
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&product); err != nil {
		return nil, fmt.Errorf("decode product: %w", err)
	}

	return &product, nil
}

// UpdatePeers updates the peer list dynamically (e.g., from Kubernetes endpoints).
func (pc *ProductCache) UpdatePeers(peers []string) {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	pc.peers = peers
	pc.pool.Set(peers...)
	pc.log.Info("updated cache peers", zap.Strings("peers", peers))
}

// ServeHTTP handles peer-to-peer cache requests.
func (pc *ProductCache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pc.pool.ServeHTTP(w, r)
}

// Stats returns cache statistics for the group.
func (pc *ProductCache) Stats() groupcache.Stats {
	return pc.group.Stats
}
```

### Kubernetes Endpoint Discovery for GroupCache Peers

```go
// pkg/cache/peer_discovery.go
package cache

import (
	"context"
	"fmt"
	"net"
	"os"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
	"go.uber.org/zap"
)

// PeerDiscovery watches Kubernetes Endpoints and updates the GroupCache peer list.
type PeerDiscovery struct {
	namespace   string
	serviceName string
	port        int
	cache       *ProductCache
	log         *zap.Logger
}

// StartPeerDiscovery watches Kubernetes Endpoints for the given service
// and keeps the GroupCache peer list synchronized.
func StartPeerDiscovery(ctx context.Context, namespace, service string, port int, c *ProductCache, log *zap.Logger) error {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("in-cluster config: %w", err)
	}

	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("kubernetes client: %w", err)
	}

	factory := informers.NewSharedInformerFactoryWithOptions(
		client, 0,
		informers.WithNamespace(namespace),
	)

	endpointsInformer := factory.Core().V1().Endpoints().Informer()
	endpointsInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			ep := obj.(*corev1.Endpoints)
			if ep.Name == service {
				c.UpdatePeers(extractPeerURLs(ep, port))
			}
		},
		UpdateFunc: func(_, newObj interface{}) {
			ep := newObj.(*corev1.Endpoints)
			if ep.Name == service {
				c.UpdatePeers(extractPeerURLs(ep, port))
			}
		},
	})

	factory.Start(ctx.Done())
	factory.WaitForCacheSync(ctx.Done())

	return nil
}

func extractPeerURLs(ep *corev1.Endpoints, port int) []string {
	hostname, _ := os.Hostname()
	selfIP := getPodIP()

	var peers []string
	for _, subset := range ep.Subsets {
		for _, addr := range subset.Addresses {
			if addr.IP != "" && addr.IP != selfIP {
				peers = append(peers, fmt.Sprintf("http://%s:%d", addr.IP, port))
			}
		}
	}
	// Always include self
	peers = append(peers, fmt.Sprintf("http://%s:%d", hostname, port))
	return peers
}

func getPodIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
			return ipNet.IP.String()
		}
	}
	return ""
}
```

### Instrumenting GroupCache with Prometheus

```go
// pkg/cache/metrics.go
package cache

import (
	"time"

	"github.com/mailgun/groupcache/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	cacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "app",
		Subsystem: "cache",
		Name:      "hits_total",
		Help:      "Number of cache hits.",
	}, []string{"cache", "type"})

	cacheMisses = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "app",
		Subsystem: "cache",
		Name:      "misses_total",
		Help:      "Number of cache misses.",
	}, []string{"cache", "type"})

	cacheLoadDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "app",
		Subsystem: "cache",
		Name:      "load_duration_seconds",
		Help:      "Time to load a cache miss from source.",
		Buckets:   prometheus.DefBuckets,
	}, []string{"cache"})
)

// CollectGroupCacheMetrics periodically exports GroupCache stats to Prometheus.
func CollectGroupCacheMetrics(group *groupcache.Group, name string, interval time.Duration) {
	go func() {
		var prevHits, prevMisses int64
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for range ticker.C {
			stats := group.Stats

			hits := stats.CacheHits.Get() - prevHits
			misses := stats.Loads.Get() - prevMisses
			prevHits = stats.CacheHits.Get()
			prevMisses = stats.Loads.Get()

			cacheHits.WithLabelValues(name, "hot").Add(float64(hits))
			cacheMisses.WithLabelValues(name, "hot").Add(float64(misses))
		}
	}()
}
```

## Dragonfly: Redis-Compatible High-Performance Cache

Dragonfly is a modern, multi-threaded, drop-in replacement for Redis and Memcached. Key advantages over Redis:

- 25x better memory efficiency via dashtable data structure
- Multi-threaded IO (vs Redis single-threaded)
- Native support for Redis Cluster protocol without cluster overhead
- Snapshot and replication compatible with Redis clients

### Dragonfly on Kubernetes

```yaml
# dragonfly-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: dragonfly
  namespace: cache
  labels:
    app.kubernetes.io/name: dragonfly
spec:
  serviceName: dragonfly-headless
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: dragonfly
  template:
    metadata:
      labels:
        app.kubernetes.io/name: dragonfly
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9999"
    spec:
      containers:
        - name: dragonfly
          image: docker.dragonflydb.io/dragonflydb/dragonfly:v1.12.1
          args:
            - --port=6379
            - --admin_port=9999
            - --maxmemory=4gb
            - --cache_mode=true     # Evict LRU when maxmemory is reached
            - --hz=100              # Higher timer frequency for better eviction accuracy
            - --save=""             # Disable RDB snapshots for pure cache mode
            - --bind=0.0.0.0
          ports:
            - containerPort: 6379
              name: redis
            - containerPort: 9999
              name: admin
          resources:
            requests:
              cpu: "1"
              memory: "5Gi"
            limits:
              cpu: "4"
              memory: "6Gi"
          livenessProbe:
            exec:
              command: ["redis-cli", "-p", "6379", "ping"]
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["redis-cli", "-p", "6379", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 5
          securityContext:
            runAsNonRoot: true
            runAsUser: 999
            capabilities:
              add: ["NET_ADMIN", "SYS_NICE"]  # Required for optimal scheduling
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 20Gi
---
apiVersion: v1
kind: Service
metadata:
  name: dragonfly
  namespace: cache
spec:
  selector:
    app.kubernetes.io/name: dragonfly
  ports:
    - name: redis
      port: 6379
      targetPort: redis
  type: ClusterIP
```

### Go Client for Dragonfly/Redis

Use `go-redis/v9` which is compatible with both Redis and Dragonfly:

```bash
go get github.com/redis/go-redis/v9@v9.3.0
```

```go
// pkg/cache/dragonfly.go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// DragonflyClient wraps redis.Client with structured error handling and metrics.
type DragonflyClient struct {
	client *redis.Client
	log    *zap.Logger
}

// NewDragonflyClient creates a connection to Dragonfly (or Redis).
func NewDragonflyClient(addr string, log *zap.Logger) (*DragonflyClient, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:            addr,
		DB:              0,
		MaxRetries:      3,
		MinRetryBackoff: 8 * time.Millisecond,
		MaxRetryBackoff: 512 * time.Millisecond,
		DialTimeout:     5 * time.Second,
		ReadTimeout:     3 * time.Second,
		WriteTimeout:    3 * time.Second,
		PoolSize:        50,
		MinIdleConns:    10,
		ConnMaxIdleTime: 30 * time.Minute,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("ping dragonfly: %w", err)
	}

	log.Info("connected to Dragonfly", zap.String("addr", addr))
	return &DragonflyClient{client: rdb, log: log}, nil
}

// SetJSON serializes value to JSON and stores it with a TTL.
func (d *DragonflyClient) SetJSON(ctx context.Context, key string, value interface{}, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal %q: %w", key, err)
	}

	if err := d.client.Set(ctx, key, data, ttl).Err(); err != nil {
		return fmt.Errorf("set %q: %w", key, err)
	}

	cacheMisses.WithLabelValues("dragonfly", "write").Inc()
	return nil
}

// GetJSON retrieves and deserializes a JSON value.
// Returns (false, nil) on cache miss, (true, nil) on hit.
func (d *DragonflyClient) GetJSON(ctx context.Context, key string, dest interface{}) (bool, error) {
	data, err := d.client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		cacheMisses.WithLabelValues("dragonfly", "read").Inc()
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get %q: %w", key, err)
	}

	if err := json.Unmarshal(data, dest); err != nil {
		return false, fmt.Errorf("unmarshal %q: %w", key, err)
	}

	cacheHits.WithLabelValues("dragonfly", "read").Inc()
	return true, nil
}

// Delete removes a key from the cache.
func (d *DragonflyClient) Delete(ctx context.Context, keys ...string) error {
	if err := d.client.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	return nil
}

// Pipeline executes multiple commands in a single round-trip.
func (d *DragonflyClient) Pipeline(ctx context.Context, fn func(redis.Pipeliner) error) error {
	_, err := d.client.Pipelined(ctx, fn)
	return err
}

// Close closes the Redis connection pool.
func (d *DragonflyClient) Close() error {
	return d.client.Close()
}
```

## Cache-Aside Pattern

The most common caching pattern: read from cache first, load from source on miss, then populate cache:

```go
// pkg/cache/patterns.go
package cache

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// CacheAsideStore implements the cache-aside (lazy loading) pattern.
type CacheAsideStore[K comparable, V any] struct {
	cache     *DragonflyClient
	source    func(ctx context.Context, key K) (V, error)
	keyPrefix string
	ttl       time.Duration
	log       *zap.Logger
}

// NewCacheAsideStore creates a cache-aside store.
func NewCacheAsideStore[K comparable, V any](
	cache *DragonflyClient,
	source func(ctx context.Context, key K) (V, error),
	keyPrefix string,
	ttl time.Duration,
	log *zap.Logger,
) *CacheAsideStore[K, V] {
	return &CacheAsideStore[K, V]{
		cache:     cache,
		source:    source,
		keyPrefix: keyPrefix,
		ttl:       ttl,
		log:       log,
	}
}

func (s *CacheAsideStore[K, V]) cacheKey(key K) string {
	return fmt.Sprintf("%s:%v", s.keyPrefix, key)
}

// Get implements cache-aside: check cache, load on miss, populate cache.
func (s *CacheAsideStore[K, V]) Get(ctx context.Context, key K) (V, error) {
	var value V

	hit, err := s.cache.GetJSON(ctx, s.cacheKey(key), &value)
	if err != nil {
		s.log.Warn("cache read error, falling through to source", zap.Error(err))
	}
	if hit {
		return value, nil
	}

	// Cache miss: load from source
	start := time.Now()
	value, err = s.source(ctx, key)
	cacheLoadDuration.WithLabelValues(s.keyPrefix).Observe(time.Since(start).Seconds())
	if err != nil {
		return value, fmt.Errorf("source load: %w", err)
	}

	// Populate cache (best-effort; do not fail the request on cache write error)
	if err := s.cache.SetJSON(ctx, s.cacheKey(key), value, s.ttl); err != nil {
		s.log.Warn("cache write error", zap.Error(err))
	}

	return value, nil
}

// Invalidate removes the cached value for a key.
func (s *CacheAsideStore[K, V]) Invalidate(ctx context.Context, key K) error {
	return s.cache.Delete(ctx, s.cacheKey(key))
}
```

## Write-Through Pattern

Write-through writes to both the cache and the backing store synchronously, guaranteeing cache freshness:

```go
// WriteThroughStore writes to source and cache simultaneously.
type WriteThroughStore[K comparable, V any] struct {
	cache     *DragonflyClient
	source    func(ctx context.Context, key K, value V) error
	keyPrefix string
	ttl       time.Duration
}

// Write stores the value in both the source and the cache.
// The cache is only updated if the source write succeeds.
func (s *WriteThroughStore[K, V]) Write(ctx context.Context, key K, value V) error {
	// Write to source first (authoritative)
	if err := s.source(ctx, key, value); err != nil {
		return fmt.Errorf("source write: %w", err)
	}

	// Update cache after successful source write
	if err := s.cache.SetJSON(ctx, fmt.Sprintf("%s:%v", s.keyPrefix, key), value, s.ttl); err != nil {
		// Log but don't fail: the source is authoritative
		// The cache will be refreshed on next miss
		return nil
	}

	return nil
}
```

## Write-Behind (Write-Back) Pattern

Write-behind acknowledges writes to the caller immediately, batching the actual source writes asynchronously:

```go
// pkg/cache/write_behind.go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// pendingWrite holds a key-value pair waiting to be flushed.
type pendingWrite struct {
	key   string
	value []byte
	addedAt time.Time
}

// WriteBehindCache batches writes and flushes to source asynchronously.
type WriteBehindCache struct {
	cache       *DragonflyClient
	persist     func(ctx context.Context, key string, value []byte) error
	keyPrefix   string
	ttl         time.Duration
	mu          sync.Mutex
	pending     map[string]pendingWrite
	flushTicker *time.Ticker
	log         *zap.Logger
}

// NewWriteBehindCache creates a write-behind cache.
func NewWriteBehindCache(
	cache *DragonflyClient,
	persist func(ctx context.Context, key string, value []byte) error,
	keyPrefix string,
	ttl time.Duration,
	flushInterval time.Duration,
	log *zap.Logger,
) *WriteBehindCache {
	wb := &WriteBehindCache{
		cache:       cache,
		persist:     persist,
		keyPrefix:   keyPrefix,
		ttl:         ttl,
		pending:     make(map[string]pendingWrite),
		flushTicker: time.NewTicker(flushInterval),
		log:         log,
	}

	go wb.flushLoop(context.Background())
	return wb
}

// Write stores the value in cache immediately and queues it for source persistence.
func (w *WriteBehindCache) Write(ctx context.Context, key string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	cacheKey := fmt.Sprintf("%s:%s", w.keyPrefix, key)

	// Write to cache immediately
	if err := w.cache.SetJSON(ctx, cacheKey, value, w.ttl); err != nil {
		return fmt.Errorf("cache write: %w", err)
	}

	// Queue for background persistence
	w.mu.Lock()
	w.pending[key] = pendingWrite{key: key, value: data, addedAt: time.Now()}
	w.mu.Unlock()

	return nil
}

func (w *WriteBehindCache) flushLoop(ctx context.Context) {
	for range w.flushTicker.C {
		if err := w.flush(ctx); err != nil {
			w.log.Error("write-behind flush error", zap.Error(err))
		}
	}
}

func (w *WriteBehindCache) flush(ctx context.Context) error {
	w.mu.Lock()
	if len(w.pending) == 0 {
		w.mu.Unlock()
		return nil
	}
	// Take a snapshot and clear the map
	batch := w.pending
	w.pending = make(map[string]pendingWrite, len(batch))
	w.mu.Unlock()

	var errs []error
	for _, pw := range batch {
		if err := w.persist(ctx, pw.key, pw.value); err != nil {
			errs = append(errs, err)
			// Re-queue failed writes
			w.mu.Lock()
			w.pending[pw.key] = pw
			w.mu.Unlock()
		}
	}

	w.log.Debug("flushed write-behind batch",
		zap.Int("flushed", len(batch)-len(errs)),
		zap.Int("errors", len(errs)),
	)

	return nil
}
```

## Cache Stampede Prevention

A cache stampede (or thundering herd) occurs when a popular cache entry expires and many concurrent requests simultaneously attempt to reload it from the (slow) source. Three mitigation strategies:

### Strategy 1: Single-Flight (Singleflight)

```go
// pkg/cache/singleflight.go
package cache

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/singleflight"
	"go.uber.org/zap"
)

// SingleFlightStore wraps a cache-aside store with singleflight deduplication.
type SingleFlightStore[K comparable, V any] struct {
	inner *CacheAsideStore[K, V]
	group singleflight.Group
	log   *zap.Logger
}

// Get retrieves a value, deduplicating concurrent requests for the same key.
func (s *SingleFlightStore[K, V]) Get(ctx context.Context, key K) (V, error) {
	keyStr := fmt.Sprintf("%v", key)

	val, err, shared := s.group.Do(keyStr, func() (interface{}, error) {
		return s.inner.Get(ctx, key)
	})

	if shared {
		s.log.Debug("singleflight: shared result", zap.String("key", keyStr))
	}

	if err != nil {
		var zero V
		return zero, err
	}

	return val.(V), nil
}
```

### Strategy 2: Stale-While-Revalidate with Background Refresh

```go
// pkg/cache/stale_revalidate.go
package cache

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

type cacheEntry[V any] struct {
	value     V
	expiresAt time.Time
	staleUntil time.Time // Serve stale until this time while refreshing
}

// StaleWhileRevalidateCache serves stale data while refreshing in the background.
type StaleWhileRevalidateCache[K comparable, V any] struct {
	mu       sync.RWMutex
	entries  map[K]*cacheEntry[V]
	source   func(ctx context.Context, key K) (V, error)
	ttl      time.Duration
	staleTTL time.Duration // How long to serve stale data
	refresh  sync.Map      // Tracks in-progress background refreshes
	log      *zap.Logger
}

// NewStaleWhileRevalidateCache creates a stale-while-revalidate cache.
func NewStaleWhileRevalidateCache[K comparable, V any](
	source func(ctx context.Context, key K) (V, error),
	ttl time.Duration,
	staleTTL time.Duration,
	log *zap.Logger,
) *StaleWhileRevalidateCache[K, V] {
	return &StaleWhileRevalidateCache[K, V]{
		entries:  make(map[K]*cacheEntry[V]),
		source:   source,
		ttl:      ttl,
		staleTTL: staleTTL,
		log:      log,
	}
}

// Get returns the cached value.
// - If fresh: returns immediately.
// - If stale (expired but within staleTTL): returns stale data and triggers background refresh.
// - If too stale (past staleTTL): blocks on fresh load.
func (s *StaleWhileRevalidateCache[K, V]) Get(ctx context.Context, key K) (V, error) {
	s.mu.RLock()
	entry := s.entries[key]
	s.mu.RUnlock()

	now := time.Now()

	if entry != nil && now.Before(entry.expiresAt) {
		// Fresh: return immediately
		cacheHits.WithLabelValues(fmt.Sprintf("%T", key), "fresh").Inc()
		return entry.value, nil
	}

	if entry != nil && now.Before(entry.staleUntil) {
		// Stale but acceptable: return stale data and refresh in background
		cacheHits.WithLabelValues(fmt.Sprintf("%T", key), "stale").Inc()
		s.triggerBackgroundRefresh(key)
		return entry.value, nil
	}

	// Fully expired: synchronous load
	return s.loadAndStore(ctx, key)
}

func (s *StaleWhileRevalidateCache[K, V]) triggerBackgroundRefresh(key K) {
	// Ensure only one goroutine refreshes per key
	if _, loaded := s.refresh.LoadOrStore(key, true); loaded {
		return
	}

	go func() {
		defer s.refresh.Delete(key)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := s.loadAndStore(ctx, key); err != nil {
			s.log.Error("background refresh failed", zap.Error(err))
		}
	}()
}

func (s *StaleWhileRevalidateCache[K, V]) loadAndStore(ctx context.Context, key K) (V, error) {
	value, err := s.source(ctx, key)
	if err != nil {
		var zero V
		return zero, err
	}

	now := time.Now()
	s.mu.Lock()
	s.entries[key] = &cacheEntry[V]{
		value:      value,
		expiresAt:  now.Add(s.ttl),
		staleUntil: now.Add(s.ttl + s.staleTTL),
	}
	s.mu.Unlock()

	return value, nil
}
```

### Strategy 3: Probabilistic Early Expiration

```go
// pkg/cache/probabilistic_expire.go
package cache

import (
	"math"
	"math/rand"
	"time"
)

// ShouldRefreshEarly uses probabilistic early expiration (XFetch algorithm).
// Returns true if the cache entry should be refreshed before it expires.
// delta: observed fetch time in seconds
// beta: controls aggressiveness (1.0 = standard, >1.0 = more aggressive)
func ShouldRefreshEarly(expireAt time.Time, fetchDuration time.Duration, beta float64) bool {
	ttlRemaining := time.Until(expireAt).Seconds()
	if ttlRemaining <= 0 {
		return true
	}

	// XFetch: refresh with probability proportional to how close to expiry
	// and how long the fetch takes
	rnd := rand.Float64()
	threshold := -fetchDuration.Seconds() * beta * math.Log(rnd)
	return threshold >= ttlRemaining
}
```

## TTL Strategy Selection

```go
// pkg/cache/ttl.go
package cache

import (
	"math/rand"
	"time"
)

// JitteredTTL adds ±20% random jitter to prevent cache expiration synchronization.
// Without jitter, all cached entries created during a traffic spike expire simultaneously,
// causing a synchronized stampede.
func JitteredTTL(base time.Duration) time.Duration {
	jitter := time.Duration(float64(base) * 0.2 * (2*rand.Float64() - 1))
	return base + jitter
}

// TTLByImportance returns different TTLs based on data change frequency.
func TTLByImportance(kind string) time.Duration {
	switch kind {
	case "user_profile":
		return JitteredTTL(15 * time.Minute)
	case "product_catalog":
		return JitteredTTL(1 * time.Hour)
	case "static_config":
		return JitteredTTL(24 * time.Hour)
	case "session":
		return JitteredTTL(30 * time.Minute)
	default:
		return JitteredTTL(5 * time.Minute)
	}
}
```

## Monitoring Cache Hit Rates

```promql
# Cache hit rate (target: >90% for read-heavy services)
sum(rate(app_cache_hits_total[5m])) by (cache)
/
(sum(rate(app_cache_hits_total[5m])) by (cache) + sum(rate(app_cache_misses_total[5m])) by (cache))

# Cache fill latency (how long it takes to load a miss)
histogram_quantile(0.95, rate(app_cache_load_duration_seconds_bucket[5m]))

# Dragonfly/Redis memory usage
redis_memory_used_bytes / redis_memory_max_bytes * 100

# Eviction rate (high evictions indicate cache is too small)
rate(redis_evicted_keys_total[5m])

# Connection pool saturation
redis_connected_clients / redis_maxclients * 100
```

```yaml
# cache-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cache-alerts
  namespace: monitoring
spec:
  groups:
    - name: cache.rules
      rules:
        - alert: LowCacheHitRate
          expr: |
            sum(rate(app_cache_hits_total[10m])) by (cache)
            /
            (sum(rate(app_cache_hits_total[10m])) by (cache) + sum(rate(app_cache_misses_total[10m])) by (cache))
            < 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cache hit rate below 80% for {{ $labels.cache }}"
            description: "Current hit rate: {{ $value | humanizePercentage }}"

        - alert: HighCacheEvictionRate
          expr: rate(redis_evicted_keys_total[5m]) > 100
          for: 3m
          labels:
            severity: warning
          annotations:
            summary: "High cache eviction rate"
            description: "Evicting {{ $value }} keys/sec - consider increasing cache size"
```

## Summary

GroupCache is the right choice for services where multiple replicas frequently request the same data from a shared source (database, external API). Its consistent hashing ensures only one peer loads any given key at a time, and the single-flight mechanism within each peer prevents redundant database queries for the same key from the same instance.

Dragonfly provides a high-performance, memory-efficient shared cache for cross-service data sharing, using the same Redis clients and protocols you already have. Its multi-threaded architecture and superior memory efficiency make it a production upgrade path from Redis.

The cache-aside pattern with singleflight or stale-while-revalidate prevents stampedes. Jittered TTLs prevent synchronized expiration. Write-through or write-behind patterns keep the cache fresh without requiring explicit invalidation logic.
