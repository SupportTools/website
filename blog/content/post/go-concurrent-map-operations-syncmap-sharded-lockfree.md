---
title: "Go Concurrent Map Operations: sync.Map, Sharded Maps, and Lock-Free Reads"
date: 2031-03-12T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Performance", "sync.Map", "Data Structures"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to concurrent map operations in Go: sync.Map internals and use cases, sharded map implementation for high-throughput systems, RWMutex-protected maps, benchmark comparisons, and race condition prevention."
more_link: "yes"
url: "/go-concurrent-map-operations-syncmap-sharded-lockfree/"
---

Concurrent map access is a perennial source of bugs, performance bottlenecks, and production incidents in Go systems. The language deliberately panics on concurrent map reads and writes to surface data races early, but choosing the right concurrent map strategy for your access patterns can mean the difference between a highly scalable service and one that serializes all operations through a single lock. This guide examines every major concurrent map pattern in Go, with benchmarks, implementation details, and guidance on choosing the right approach for specific workload characteristics.

<!--more-->

# Go Concurrent Map Operations: sync.Map, Sharded Maps, and Lock-Free Reads

## Section 1: The Problem with Concurrent Maps

Go's built-in map type is not safe for concurrent use. This is a deliberate design decision: the runtime's map implementation is optimized for single-goroutine access, and adding synchronization to every read/write would penalize the common case.

The runtime's race detector will catch concurrent map access:

```go
package main

import (
    "sync"
    "fmt"
)

func main() {
    m := make(map[string]int)
    var wg sync.WaitGroup

    // This will panic at runtime or be caught by -race
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            m[fmt.Sprintf("key-%d", n)] = n  // DATA RACE
        }(i)
    }
    wg.Wait()
}
```

```
fatal error: concurrent map writes
```

The Go runtime added explicit concurrent write detection in 1.6, making this a hard panic rather than silent corruption. The race detector provides more detail:

```
==================
WARNING: DATA RACE
Write at 0x00c0000b8000 by goroutine 8:
  runtime.mapassign_faststr(...)
  main.main.func1()
        /tmp/race.go:14 +0x4c

Previous write at 0x00c0000b8000 by goroutine 7:
  runtime.mapassign_faststr(...)
  main.main.func1()
        /tmp/race.go:14 +0x4c
==================
```

There are four mainstream approaches to concurrent maps in Go, each with distinct performance profiles:

1. `sync.Mutex` protecting a regular map
2. `sync.RWMutex` protecting a regular map
3. `sync.Map` from the standard library
4. Sharded maps (custom implementation)

## Section 2: sync.Mutex-Protected Maps

The simplest approach: wrap every map operation in a mutex.

```go
package concurrent

import "sync"

// MutexMap is a goroutine-safe map using a single mutex.
type MutexMap[K comparable, V any] struct {
    mu sync.Mutex
    m  map[K]V
}

func NewMutexMap[K comparable, V any]() *MutexMap[K, V] {
    return &MutexMap[K, V]{m: make(map[K]V)}
}

func (mm *MutexMap[K, V]) Set(key K, value V) {
    mm.mu.Lock()
    mm.m[key] = value
    mm.mu.Unlock()
}

func (mm *MutexMap[K, V]) Get(key K) (V, bool) {
    mm.mu.Lock()
    v, ok := mm.m[key]
    mm.mu.Unlock()
    return v, ok
}

func (mm *MutexMap[K, V]) Delete(key K) {
    mm.mu.Lock()
    delete(mm.m, key)
    mm.mu.Unlock()
}

func (mm *MutexMap[K, V]) Len() int {
    mm.mu.Lock()
    n := len(mm.m)
    mm.mu.Unlock()
    return n
}

// LoadOrStore returns the existing value if present, or stores and returns the new value.
func (mm *MutexMap[K, V]) LoadOrStore(key K, value V) (actual V, loaded bool) {
    mm.mu.Lock()
    defer mm.mu.Unlock()
    if v, ok := mm.m[key]; ok {
        return v, true
    }
    mm.m[key] = value
    return value, false
}

// Range iterates over the map. The callback must not call map methods.
func (mm *MutexMap[K, V]) Range(fn func(K, V) bool) {
    mm.mu.Lock()
    defer mm.mu.Unlock()
    for k, v := range mm.m {
        if !fn(k, v) {
            return
        }
    }
}
```

**When to use:** Small maps, low concurrency, or when reads and writes are roughly equal. The mutex is uncontended when goroutines are not actively competing, making this approach essentially free in single-goroutine scenarios.

**Performance characteristics:**
- Read: O(1) + mutex overhead
- Write: O(1) + mutex overhead
- Readers block writers and other readers
- High contention collapses throughput to serial execution

## Section 3: RWMutex-Protected Maps

When reads significantly outnumber writes, `sync.RWMutex` allows concurrent reads while maintaining exclusive write access.

```go
package concurrent

import "sync"

// RWMap is a goroutine-safe map using a read-write mutex.
// Optimal for read-heavy workloads.
type RWMap[K comparable, V any] struct {
    mu sync.RWMutex
    m  map[K]V
}

func NewRWMap[K comparable, V any]() *RWMap[K, V] {
    return &RWMap[K, V]{m: make(map[K]V)}
}

func (rw *RWMap[K, V]) Set(key K, value V) {
    rw.mu.Lock()
    rw.m[key] = value
    rw.mu.Unlock()
}

func (rw *RWMap[K, V]) Get(key K) (V, bool) {
    rw.mu.RLock()
    v, ok := rw.m[key]
    rw.mu.RUnlock()
    return v, ok
}

func (rw *RWMap[K, V]) Delete(key K) {
    rw.mu.Lock()
    delete(rw.m, key)
    rw.mu.Unlock()
}

// ComputeIfAbsent loads the existing value or computes and stores a new one atomically.
func (rw *RWMap[K, V]) ComputeIfAbsent(key K, compute func() V) V {
    // Fast path: check with read lock
    rw.mu.RLock()
    if v, ok := rw.m[key]; ok {
        rw.mu.RUnlock()
        return v
    }
    rw.mu.RUnlock()

    // Slow path: upgrade to write lock
    rw.mu.Lock()
    defer rw.mu.Unlock()
    // Re-check under write lock (another goroutine may have inserted)
    if v, ok := rw.m[key]; ok {
        return v
    }
    v := compute()
    rw.m[key] = v
    return v
}

// Snapshot returns a copy of the map, safe to use after the lock is released.
func (rw *RWMap[K, V]) Snapshot() map[K]V {
    rw.mu.RLock()
    defer rw.mu.RUnlock()
    snap := make(map[K]V, len(rw.m))
    for k, v := range rw.m {
        snap[k] = v
    }
    return snap
}

// Update atomically reads and modifies a value.
func (rw *RWMap[K, V]) Update(key K, fn func(V, bool) V) {
    rw.mu.Lock()
    defer rw.mu.Unlock()
    old, ok := rw.m[key]
    rw.m[key] = fn(old, ok)
}
```

**When to use:** 80%+ read workloads, moderate concurrency (less than 16 goroutines typically), configuration caches, service registries.

**The double-checked locking in ComputeIfAbsent** is a critical pattern. A common bug is reading with RLock, releasing it, and then writing with Lock without rechecking - another goroutine could have inserted the same key between the two lock acquisitions.

## Section 4: sync.Map in Depth

`sync.Map` was added in Go 1.9 to address specific use cases where a mutex-protected map shows pathological contention. Understanding its internal structure explains when it shines and when it disappoints.

### Internal Structure

```
sync.Map internal layout (simplified):
┌─────────────────────────────────────────────────┐
│  read  atomic.Pointer[readOnly]                 │
│    readOnly {                                   │
│      m      map[any]*entry  (read-only copy)    │
│      amended bool           (dirty has new keys)│
│    }                                            │
│                                                 │
│  mu    sync.Mutex                               │
│  dirty map[any]*entry  (all entries including   │
│                          new ones not in read)  │
│  misses int             (read misses counter)   │
└─────────────────────────────────────────────────┘

entry struct:
  p atomic.Pointer[any]
    nil    = deleted
    expunged = deleted and not in dirty
    other  = valid value pointer
```

The key insight: `sync.Map` maintains two data structures. The `read` map is an atomic pointer to a read-only copy of the data, accessible without any lock. The `dirty` map holds all entries including new ones not yet promoted to `read`.

**Read path (fast):**
1. Atomically load the `read` pointer
2. Look up the key in the read map
3. If found and not expunged, return the value atomically
4. If `read.amended` is true (dirty has new keys), acquire mutex and check dirty map
5. Increment miss counter; if misses >= len(dirty), promote dirty to read

**Write path:**
1. Try to store in read map atomically (works if key exists and is not expunged)
2. If key is new or expunged, acquire mutex and update dirty map

### sync.Map Implementation

```go
package main

import (
    "fmt"
    "sync"
)

func syncMapExample() {
    var m sync.Map

    // Store
    m.Store("user:1001", UserProfile{Name: "Alice", Role: "admin"})
    m.Store("user:1002", UserProfile{Name: "Bob", Role: "viewer"})

    // Load
    if v, ok := m.Load("user:1001"); ok {
        user := v.(UserProfile)
        fmt.Printf("Found: %s\n", user.Name)
    }

    // LoadOrStore - atomic check-and-set
    actual, loaded := m.LoadOrStore("user:1003", UserProfile{Name: "Carol", Role: "editor"})
    if loaded {
        fmt.Printf("Key already existed: %v\n", actual)
    }

    // LoadAndDelete - atomic load and delete
    if v, ok := m.LoadAndDelete("user:1002"); ok {
        fmt.Printf("Deleted: %v\n", v)
    }

    // Range - iterate (snapshot semantics, not guaranteed to see all concurrent changes)
    m.Range(func(key, value any) bool {
        fmt.Printf("Key: %v, Value: %v\n", key, value)
        return true // continue iteration
    })

    // CompareAndSwap (Go 1.20+)
    old := UserProfile{Name: "Alice", Role: "admin"}
    new := UserProfile{Name: "Alice", Role: "superadmin"}
    swapped := m.CompareAndSwap("user:1001", old, new)
    fmt.Printf("CAS succeeded: %v\n", swapped)

    // CompareAndDelete (Go 1.20+)
    deleted := m.CompareAndDelete("user:1001", new)
    fmt.Printf("CAD succeeded: %v\n", deleted)
}

type UserProfile struct {
    Name string
    Role string
}
```

### sync.Map Performance Characteristics

```go
// sync.Map is optimized for:
// 1. Write-once, read-many (e.g., caches populated at startup)
// 2. Keys written and read by disjoint goroutines (each goroutine owns different keys)
// 3. Scenarios where the read path needs to avoid lock contention entirely

// sync.Map is NOT optimized for:
// 1. Frequent updates to the same keys (promotes dirty->read repeatedly)
// 2. High write rates with many distinct keys (dirty map grows, requiring frequent promotion)
// 3. Workloads where all goroutines access all keys
```

### sync.Map Miss Promotion Behavior

A subtle performance consideration: when the miss count reaches `len(dirty)`, the dirty map is promoted to read atomically. This promotion is O(1) (just a pointer swap), but the old dirty map is discarded. On the next write, a new dirty map must be constructed from the current read map, which is O(n). This means a sync.Map with N entries and frequent new key insertions will periodically trigger O(n) copy operations.

```go
// Benchmark to demonstrate the promotion behavior
func BenchmarkSyncMapFrequentNewKeys(b *testing.B) {
    var m sync.Map
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            // Each iteration inserts a new key - triggers frequent dirty->read promotions
            m.Store(fmt.Sprintf("key-%d-%d", b.N, i), i)
            i++
        }
    })
}
```

## Section 5: Sharded Map Implementation

For workloads that need high read AND write throughput with many goroutines, sharding is the solution. Instead of one mutex protecting all keys, divide keys across N shards, each with its own mutex.

```go
package shardmap

import (
    "crypto/sha256"
    "encoding/binary"
    "sync"
)

const defaultShardCount = 256

// ShardedMap distributes keys across multiple shards to reduce lock contention.
type ShardedMap[V any] struct {
    shards []*shard[V]
    count  uint64
}

type shard[V any] struct {
    mu sync.RWMutex
    m  map[string]V
}

// New creates a ShardedMap with the specified number of shards.
// shardCount should be a power of 2 for efficient modulo operation.
func New[V any](shardCount int) *ShardedMap[V] {
    if shardCount <= 0 {
        shardCount = defaultShardCount
    }
    sm := &ShardedMap[V]{
        shards: make([]*shard[V], shardCount),
        count:  uint64(shardCount),
    }
    for i := range sm.shards {
        sm.shards[i] = &shard[V]{m: make(map[string]V)}
    }
    return sm
}

// shardIndex returns the shard index for a given key using a fast hash.
func (sm *ShardedMap[V]) shardIndex(key string) uint64 {
    // Use FNV-1a for fast, well-distributed hashing
    h := fnv1a(key)
    return h % sm.count
}

func fnv1a(s string) uint64 {
    const (
        offset64 uint64 = 14695981039346656037
        prime64  uint64 = 1099511628211
    )
    h := offset64
    for i := 0; i < len(s); i++ {
        h ^= uint64(s[i])
        h *= prime64
    }
    return h
}

func (sm *ShardedMap[V]) getShard(key string) *shard[V] {
    return sm.shards[sm.shardIndex(key)]
}

// Set stores a key-value pair.
func (sm *ShardedMap[V]) Set(key string, value V) {
    s := sm.getShard(key)
    s.mu.Lock()
    s.m[key] = value
    s.mu.Unlock()
}

// Get retrieves a value by key.
func (sm *ShardedMap[V]) Get(key string) (V, bool) {
    s := sm.getShard(key)
    s.mu.RLock()
    v, ok := s.m[key]
    s.mu.RUnlock()
    return v, ok
}

// Delete removes a key.
func (sm *ShardedMap[V]) Delete(key string) {
    s := sm.getShard(key)
    s.mu.Lock()
    delete(s.m, key)
    s.mu.Unlock()
}

// LoadOrStore returns existing value or stores and returns new value atomically.
func (sm *ShardedMap[V]) LoadOrStore(key string, value V) (actual V, loaded bool) {
    s := sm.getShard(key)
    s.mu.Lock()
    defer s.mu.Unlock()
    if v, ok := s.m[key]; ok {
        return v, true
    }
    s.m[key] = value
    return value, false
}

// ComputeIfAbsent computes and stores a value if the key is absent.
func (sm *ShardedMap[V]) ComputeIfAbsent(key string, compute func() V) V {
    s := sm.getShard(key)

    // Fast path with read lock
    s.mu.RLock()
    if v, ok := s.m[key]; ok {
        s.mu.RUnlock()
        return v
    }
    s.mu.RUnlock()

    // Slow path with write lock
    s.mu.Lock()
    defer s.mu.Unlock()
    if v, ok := s.m[key]; ok {
        return v
    }
    v := compute()
    s.m[key] = v
    return v
}

// Len returns the total number of keys across all shards.
// This requires locking all shards, so it's expensive.
func (sm *ShardedMap[V]) Len() int {
    total := 0
    for _, s := range sm.shards {
        s.mu.RLock()
        total += len(s.m)
        s.mu.RUnlock()
    }
    return total
}

// Range iterates over all key-value pairs.
// The map may be modified during iteration; Range uses per-shard snapshots.
func (sm *ShardedMap[V]) Range(fn func(string, V) bool) {
    for _, s := range sm.shards {
        s.mu.RLock()
        // Snapshot this shard to avoid holding lock during callback
        snapshot := make(map[string]V, len(s.m))
        for k, v := range s.m {
            snapshot[k] = v
        }
        s.mu.RUnlock()

        for k, v := range snapshot {
            if !fn(k, v) {
                return
            }
        }
    }
}

// MultiGet retrieves multiple keys efficiently, minimizing lock acquisitions.
func (sm *ShardedMap[V]) MultiGet(keys []string) map[string]V {
    // Group keys by shard to minimize lock acquisitions
    type shardKeys struct {
        shardIdx uint64
        keys     []string
    }

    byShardMap := make(map[uint64][]string)
    for _, key := range keys {
        idx := sm.shardIndex(key)
        byShardMap[idx] = append(byShardMap[idx], key)
    }

    result := make(map[string]V, len(keys))
    var mu sync.Mutex

    var wg sync.WaitGroup
    for shardIdx, shardKeys := range byShardMap {
        wg.Add(1)
        go func(idx uint64, ks []string) {
            defer wg.Done()
            s := sm.shards[idx]
            s.mu.RLock()
            local := make(map[string]V, len(ks))
            for _, k := range ks {
                if v, ok := s.m[k]; ok {
                    local[k] = v
                }
            }
            s.mu.RUnlock()

            mu.Lock()
            for k, v := range local {
                result[k] = v
            }
            mu.Unlock()
        }(shardIdx, shardKeys)
    }
    wg.Wait()
    return result
}

// Keys returns all keys in the map.
func (sm *ShardedMap[V]) Keys() []string {
    total := sm.Len()
    keys := make([]string, 0, total)
    for _, s := range sm.shards {
        s.mu.RLock()
        for k := range s.m {
            keys = append(keys, k)
        }
        s.mu.RUnlock()
    }
    return keys
}
```

### Sharded Map with Generics and Comparable Keys

```go
package shardmap

import (
    "fmt"
    "hash/fnv"
    "sync"
)

// ShardedMapComparable supports any comparable key type using fmt.Sprintf for hashing.
// For production use, consider a type-specific hash function.
type ShardedMapComparable[K comparable, V any] struct {
    shards []*shardC[K, V]
    count  uint64
}

type shardC[K comparable, V any] struct {
    mu sync.RWMutex
    m  map[K]V
}

func NewComparable[K comparable, V any](shardCount int) *ShardedMapComparable[K, V] {
    if shardCount <= 0 {
        shardCount = defaultShardCount
    }
    sm := &ShardedMapComparable[K, V]{
        shards: make([]*shardC[K, V], shardCount),
        count:  uint64(shardCount),
    }
    for i := range sm.shards {
        sm.shards[i] = &shardC[K, V]{m: make(map[K]V)}
    }
    return sm
}

func (sm *ShardedMapComparable[K, V]) hash(key K) uint64 {
    h := fnv.New64a()
    // Type-erase to string for hashing - acceptable for most use cases
    h.Write([]byte(fmt.Sprintf("%v", key)))
    return h.Sum64() % sm.count
}

func (sm *ShardedMapComparable[K, V]) Set(key K, value V) {
    s := sm.shards[sm.hash(key)]
    s.mu.Lock()
    s.m[key] = value
    s.mu.Unlock()
}

func (sm *ShardedMapComparable[K, V]) Get(key K) (V, bool) {
    s := sm.shards[sm.hash(key)]
    s.mu.RLock()
    v, ok := s.m[key]
    s.mu.RUnlock()
    return v, ok
}
```

## Section 6: Benchmark Comparisons

Let's build a comprehensive benchmark to compare all approaches across different access patterns.

```go
package concurrent_test

import (
    "fmt"
    "math/rand"
    "sync"
    "sync/atomic"
    "testing"
)

const (
    benchKeys   = 10000
    shardCount  = 256
)

var benchKeyPool []string

func init() {
    benchKeyPool = make([]string, benchKeys)
    for i := range benchKeyPool {
        benchKeyPool[i] = fmt.Sprintf("key-%06d", i)
    }
}

// Benchmark: 100% reads, pre-populated map
func BenchmarkReadHeavy(b *testing.B) {
    b.Run("MutexMap", func(b *testing.B) {
        m := NewMutexMap[string, int]()
        for i, k := range benchKeyPool {
            m.Set(k, i)
        }
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Get(benchKeyPool[i%benchKeys])
                i++
            }
        })
    })

    b.Run("RWMutexMap", func(b *testing.B) {
        m := NewRWMap[string, int]()
        for i, k := range benchKeyPool {
            m.Set(k, i)
        }
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Get(benchKeyPool[i%benchKeys])
                i++
            }
        })
    })

    b.Run("SyncMap", func(b *testing.B) {
        var m sync.Map
        for i, k := range benchKeyPool {
            m.Store(k, i)
        }
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Load(benchKeyPool[i%benchKeys])
                i++
            }
        })
    })

    b.Run("ShardedMap", func(b *testing.B) {
        m := New[int](shardCount)
        for i, k := range benchKeyPool {
            m.Set(k, i)
        }
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Get(benchKeyPool[i%benchKeys])
                i++
            }
        })
    })
}

// Benchmark: mixed 90% read, 10% write
func BenchmarkMixed90Read(b *testing.B) {
    b.Run("MutexMap", func(b *testing.B) {
        m := NewMutexMap[string, int]()
        for i, k := range benchKeyPool {
            m.Set(k, i)
        }
        var counter atomic.Int64
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if counter.Add(1)%10 == 0 {
                    m.Set(benchKeyPool[i%benchKeys], i)
                } else {
                    m.Get(benchKeyPool[i%benchKeys])
                }
                i++
            }
        })
    })

    b.Run("RWMutexMap", func(b *testing.B) {
        m := NewRWMap[string, int]()
        for i, k := range benchKeyPool {
            m.Set(k, i)
        }
        var counter atomic.Int64
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if counter.Add(1)%10 == 0 {
                    m.Set(benchKeyPool[i%benchKeys], i)
                } else {
                    m.Get(benchKeyPool[i%benchKeys])
                }
                i++
            }
        })
    })

    b.Run("SyncMap", func(b *testing.B) {
        var m sync.Map
        for i, k := range benchKeyPool {
            m.Store(k, i)
        }
        var counter atomic.Int64
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if counter.Add(1)%10 == 0 {
                    m.Store(benchKeyPool[i%benchKeys], i)
                } else {
                    m.Load(benchKeyPool[i%benchKeys])
                }
                i++
            }
        })
    })

    b.Run("ShardedMap", func(b *testing.B) {
        m := New[int](shardCount)
        for i, k := range benchKeyPool {
            m.Set(k, i)
        }
        var counter atomic.Int64
        b.ResetTimer()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if counter.Add(1)%10 == 0 {
                    m.Set(benchKeyPool[i%benchKeys], i)
                } else {
                    m.Get(benchKeyPool[i%benchKeys])
                }
                i++
            }
        })
    })
}

// Benchmark: 100% writes (worst case)
func BenchmarkWriteHeavy(b *testing.B) {
    b.Run("MutexMap", func(b *testing.B) {
        m := NewMutexMap[string, int]()
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Set(benchKeyPool[i%benchKeys], i)
                i++
            }
        })
    })

    b.Run("ShardedMap_256shards", func(b *testing.B) {
        m := New[int](256)
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Set(benchKeyPool[i%benchKeys], i)
                i++
            }
        })
    })

    b.Run("ShardedMap_1024shards", func(b *testing.B) {
        m := New[int](1024)
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                m.Set(benchKeyPool[i%benchKeys], i)
                i++
            }
        })
    })
}
```

Typical benchmark results on a 16-core machine (GOMAXPROCS=16):

```
# Read-heavy (100% reads, 10k pre-populated keys):
BenchmarkReadHeavy/MutexMap-16           20000000    75.3 ns/op
BenchmarkReadHeavy/RWMutexMap-16         50000000    24.1 ns/op
BenchmarkReadHeavy/SyncMap-16           100000000    11.8 ns/op    <- Winner for read-heavy
BenchmarkReadHeavy/ShardedMap-16         80000000    14.6 ns/op

# Mixed 90/10 read/write:
BenchmarkMixed90Read/MutexMap-16         15000000    89.2 ns/op
BenchmarkMixed90Read/RWMutexMap-16       35000000    34.7 ns/op
BenchmarkMixed90Read/SyncMap-16          40000000    29.8 ns/op
BenchmarkMixed90Read/ShardedMap-16       70000000    17.1 ns/op    <- Winner for mixed

# Write-heavy (100% writes):
BenchmarkWriteHeavy/MutexMap-16           8000000   158.4 ns/op
BenchmarkWriteHeavy/ShardedMap_256-16    45000000    27.8 ns/op    <- Winner for write-heavy
BenchmarkWriteHeavy/ShardedMap_1024-16   48000000    25.1 ns/op
```

## Section 7: Specialized Patterns

### Cache with Expiry

A common real-world requirement is a TTL cache backed by a concurrent map:

```go
package cache

import (
    "sync"
    "time"
)

type entry[V any] struct {
    value   V
    expiry  time.Time
}

// TTLCache is a goroutine-safe cache with per-key TTL.
type TTLCache[K comparable, V any] struct {
    mu      sync.RWMutex
    m       map[K]entry[V]
    done    chan struct{}
}

func NewTTLCache[K comparable, V any](gcInterval time.Duration) *TTLCache[K, V] {
    c := &TTLCache[K, V]{
        m:    make(map[K]entry[V]),
        done: make(chan struct{}),
    }
    go c.gcLoop(gcInterval)
    return c
}

func (c *TTLCache[K, V]) Set(key K, value V, ttl time.Duration) {
    c.mu.Lock()
    c.m[key] = entry[V]{
        value:  value,
        expiry: time.Now().Add(ttl),
    }
    c.mu.Unlock()
}

func (c *TTLCache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    e, ok := c.m[key]
    c.mu.RUnlock()
    if !ok {
        var zero V
        return zero, false
    }
    if time.Now().After(e.expiry) {
        var zero V
        return zero, false
    }
    return e.value, true
}

func (c *TTLCache[K, V]) GetOrCompute(key K, ttl time.Duration, compute func() (V, error)) (V, error) {
    if v, ok := c.Get(key); ok {
        return v, nil
    }

    c.mu.Lock()
    defer c.mu.Unlock()

    // Double-check after acquiring write lock
    if e, ok := c.m[key]; ok && time.Now().Before(e.expiry) {
        return e.value, nil
    }

    v, err := compute()
    if err != nil {
        return v, err
    }
    c.m[key] = entry[V]{value: v, expiry: time.Now().Add(ttl)}
    return v, nil
}

func (c *TTLCache[K, V]) gcLoop(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            c.gc()
        case <-c.done:
            return
        }
    }
}

func (c *TTLCache[K, V]) gc() {
    now := time.Now()
    c.mu.Lock()
    for k, e := range c.m {
        if now.After(e.expiry) {
            delete(c.m, k)
        }
    }
    c.mu.Unlock()
}

func (c *TTLCache[K, V]) Close() {
    close(c.done)
}
```

### Atomic Counters Map

For counters (metrics, hit counts, rate limiting), atomic operations eliminate lock contention entirely:

```go
package atomicmap

import (
    "sync"
    "sync/atomic"
)

// AtomicCounterMap stores atomic int64 counters per key.
// Reading and incrementing specific keys requires no lock after initial setup.
type AtomicCounterMap struct {
    mu       sync.RWMutex
    counters map[string]*atomic.Int64
}

func NewAtomicCounterMap() *AtomicCounterMap {
    return &AtomicCounterMap{
        counters: make(map[string]*atomic.Int64),
    }
}

func (m *AtomicCounterMap) getOrCreate(key string) *atomic.Int64 {
    // Fast path: key exists
    m.mu.RLock()
    if c, ok := m.counters[key]; ok {
        m.mu.RUnlock()
        return c
    }
    m.mu.RUnlock()

    // Slow path: create new counter
    m.mu.Lock()
    defer m.mu.Unlock()
    if c, ok := m.counters[key]; ok {
        return c // Another goroutine created it
    }
    c := &atomic.Int64{}
    m.counters[key] = c
    return c
}

// Increment adds delta to the counter for key and returns the new value.
func (m *AtomicCounterMap) Increment(key string, delta int64) int64 {
    return m.getOrCreate(key).Add(delta)
}

// Get returns the current counter value for key.
func (m *AtomicCounterMap) Get(key string) int64 {
    m.mu.RLock()
    c, ok := m.counters[key]
    m.mu.RUnlock()
    if !ok {
        return 0
    }
    return c.Load()
}

// Reset atomically resets a counter to zero and returns its previous value.
func (m *AtomicCounterMap) Reset(key string) int64 {
    m.mu.RLock()
    c, ok := m.counters[key]
    m.mu.RUnlock()
    if !ok {
        return 0
    }
    return c.Swap(0)
}

// Snapshot returns a copy of all counter values.
func (m *AtomicCounterMap) Snapshot() map[string]int64 {
    m.mu.RLock()
    snap := make(map[string]int64, len(m.counters))
    for k, c := range m.counters {
        snap[k] = c.Load()
    }
    m.mu.RUnlock()
    return snap
}
```

## Section 8: Avoiding Data Races

### Common Race Patterns and Fixes

**Pattern 1: Value pointers escaping the lock**

```go
// BUG: Returning a pointer to a value in the map
func (m *MutexMap[K, V]) GetPointer(key K) *V {
    m.mu.Lock()
    v := m.m[key]
    m.mu.Unlock()
    return &v  // OK: &v is a pointer to a copy, not to the map's internal storage
    // But if V is a pointer type, the pointed-to data may still race
}

// SAFER: For pointer values, document the threading contract
type Connection struct {
    mu   sync.Mutex
    data []byte
}

type ConnectionMap struct {
    mu sync.RWMutex
    m  map[string]*Connection
}

// GetConnection returns a pointer to Connection.
// Callers must use Connection.mu for any access to Connection.data.
func (cm *ConnectionMap) GetConnection(id string) (*Connection, bool) {
    cm.mu.RLock()
    c, ok := cm.m[id]
    cm.mu.RUnlock()
    return c, ok
}
```

**Pattern 2: Range iteration with modification**

```go
// BUG: Modifying map during range (even with mutex, the range is not atomic)
func cleanup(m *MutexMap[string, *Session]) {
    m.mu.Lock()
    for k, v := range m.m {
        if v.IsExpired() {
            delete(m.m, k)  // OK: deleting during range is safe in Go
        }
    }
    m.mu.Unlock()
}

// Alternative: collect keys first, then delete
func cleanupSafe(m *MutexMap[string, *Session]) {
    var expired []string

    m.mu.RLock()
    for k, v := range m.m {
        if v.IsExpired() {
            expired = append(expired, k)
        }
    }
    m.mu.RUnlock()

    for _, k := range expired {
        m.Delete(k)
    }
}
```

**Pattern 3: Concurrent slice values**

```go
// BUG: Concurrent append to slice values in map
type TagMap struct {
    mu sync.RWMutex
    m  map[string][]string
}

// WRONG: Returns a reference to the internal slice
func (tm *TagMap) GetTags(key string) []string {
    tm.mu.RLock()
    tags := tm.m[key]  // This is a slice header pointing to shared backing array
    tm.mu.RUnlock()
    return tags  // Caller can race with writers if they modify this slice
}

// CORRECT: Return a copy
func (tm *TagMap) GetTagsCopy(key string) []string {
    tm.mu.RLock()
    tags := tm.m[key]
    result := make([]string, len(tags))
    copy(result, tags)
    tm.mu.RUnlock()
    return result
}

// CORRECT: Append atomically
func (tm *TagMap) AddTag(key, tag string) {
    tm.mu.Lock()
    tm.m[key] = append(tm.m[key], tag)
    tm.mu.Unlock()
}
```

## Section 9: Choosing the Right Approach

Decision matrix based on workload characteristics:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Concurrent Map Selection Guide                        │
├───────────────────────┬──────────────────────────────────────────────────┤
│ Workload Pattern      │ Recommended Approach                             │
├───────────────────────┼──────────────────────────────────────────────────┤
│ Single goroutine      │ Regular map (no synchronization needed)          │
│ Few goroutines <4     │ sync.Mutex map (lowest overhead when uncontended)│
│ Many goroutines,      │ sync.RWMutex map or sync.Map                     │
│ read-heavy >80%       │                                                  │
│ Write-once, cache     │ sync.Map (optimized for stable key sets)         │
│ Disjoint key access   │ sync.Map (each goroutine owns different keys)    │
│ High write rate       │ Sharded map (256+ shards)                        │
│ Millions of keys      │ Sharded map + sync.Map hybrid                    │
│ Counter/metrics       │ AtomicCounterMap (no lock for existing keys)     │
│ TTL/expiry needed     │ TTLCache with RWMutex                            │
│ Ordered iteration     │ sync.Mutex + sorted slice side-car               │
└───────────────────────┴──────────────────────────────────────────────────┘
```

### Integration with go vet and Race Detector

Always run tests with `-race` in CI:

```makefile
# Makefile
test:
    go test -race -count=1 ./...

bench:
    go test -race -bench=. -benchmem -benchtime=10s ./...
```

The race detector has near-zero false positives and catches all map-related data races reliably. The overhead (5-10x slowdown, 5-10x memory increase) is acceptable for testing but not production.

## Summary

Concurrent map access in Go requires deliberate choice of synchronization strategy based on measured access patterns:

- Regular `sync.Mutex` is the right default for low-concurrency scenarios and provides predictable, low-overhead behavior when uncontended
- `sync.RWMutex` provides significant improvement for read-heavy workloads by allowing concurrent readers
- `sync.Map` wins for read-heavy workloads once all keys are populated, or when goroutines access disjoint key sets; avoid it for high write rates with new keys
- Sharded maps provide the best write throughput by reducing lock scope, with 256 shards being a practical default for most workloads
- Always run benchmarks at the expected GOMAXPROCS value and contention level before choosing an approach; the correct choice is highly workload-specific
