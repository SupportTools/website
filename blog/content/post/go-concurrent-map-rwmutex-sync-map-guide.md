---
title: "Concurrent Data Structures in Go: RWMutex, sync.Map, and Lock-Free Patterns"
date: 2028-11-25T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Data Structures", "Performance", "Synchronization"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to concurrent map implementations in Go: map+RWMutex, sync.Map, sharded maps for high-contention workloads, atomic operations, lock-free ring buffers, and race detection with go test -race."
more_link: "yes"
url: "/go-concurrent-map-rwmutex-sync-map-guide/"
---

Concurrent access to shared data is one of the most common sources of bugs in Go services. The built-in `map` type is not safe for concurrent use - reading and writing from multiple goroutines simultaneously is a data race that produces undefined behavior. Go provides several tools to solve this: `sync.RWMutex` for general-purpose locking, `sync.Map` for specific use cases, and `sync/atomic` for lock-free operations on scalar values.

This guide covers each approach with benchmarks, explains when to use which, and shows a sharded map implementation that handles high-contention workloads where a single mutex becomes a bottleneck.

<!--more-->

# Concurrent Data Structures in Go: From RWMutex to Lock-Free

## Why map Is Not Concurrent-Safe

Go's built-in map is implemented as a hash table with internal state that can become inconsistent if modified during a concurrent read. The Go runtime detects some concurrent map access and panics:

```
fatal error: concurrent map read and map write
```

But not all races are detected at runtime - some result in silent data corruption or memory corruption. The race detector (`go test -race`) catches all of them:

```bash
go test -race ./...
# DATA RACE
# Write at 0x... by goroutine 7:
#   main.updateMap()
# Previous read at 0x... by goroutine 6:
#   main.readMap()
```

Never share a map between goroutines without synchronization.

## map + sync.RWMutex

The most common concurrent map pattern wraps a map with an `RWMutex`. Multiple readers can hold the read lock simultaneously; writers require exclusive access.

```go
package cache

import (
    "sync"
)

// Cache is a thread-safe key-value store.
type Cache[K comparable, V any] struct {
    mu   sync.RWMutex
    data map[K]V
}

func NewCache[K comparable, V any]() *Cache[K, V] {
    return &Cache[K, V]{
        data: make(map[K]V),
    }
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.data[key]
    return v, ok
}

func (c *Cache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.data[key] = value
}

func (c *Cache[K, V]) Delete(key K) {
    c.mu.Lock()
    defer c.mu.Unlock()
    delete(c.data, key)
}

func (c *Cache[K, V]) Len() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return len(c.data)
}

// GetOrSet atomically gets or sets a value.
// Returns the value and whether it was newly set.
func (c *Cache[K, V]) GetOrSet(key K, fn func() V) (V, bool) {
    // Try read lock first (optimistic path)
    c.mu.RLock()
    if v, ok := c.data[key]; ok {
        c.mu.RUnlock()
        return v, false
    }
    c.mu.RUnlock()

    // Upgrade to write lock
    c.mu.Lock()
    defer c.mu.Unlock()
    // Check again - another goroutine may have inserted between the two locks
    if v, ok := c.data[key]; ok {
        return v, false
    }
    v := fn()
    c.data[key] = v
    return v, true
}

// Range iterates over all entries.
// The fn callback must not call any Cache methods (deadlock).
func (c *Cache[K, V]) Range(fn func(K, V) bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    for k, v := range c.data {
        if !fn(k, v) {
            return
        }
    }
}
```

### When to Use map+RWMutex

- **Read-heavy workloads**: RWMutex allows concurrent reads, providing significant speedup over Mutex
- **General use**: Works for any key and value types
- **Operations beyond get/set**: Iteration, length queries, conditional updates

Performance characteristics with 80% reads, 20% writes:

```
BenchmarkRWMutexGet-8    10000000    ~150 ns/op
BenchmarkRWMutexSet-8     2000000    ~250 ns/op
```

## sync.Map

`sync.Map` is optimized for two specific use cases that the Go documentation defines:

1. When the key-value set is written once but read many times (append-only pattern)
2. When multiple goroutines read, write, and overwrite disjoint sets of keys

Under these conditions, `sync.Map` can outperform a `map+RWMutex` because it avoids locking for the common read path by maintaining a read-only "dirty" map that is promoted atomically.

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var m sync.Map

    // Store
    m.Store("key1", "value1")
    m.Store("key2", 42)

    // Load
    if v, ok := m.Load("key1"); ok {
        fmt.Println(v.(string)) // Type assertion required
    }

    // LoadOrStore - returns existing value or stores new one
    actual, loaded := m.LoadOrStore("key1", "new-value")
    fmt.Printf("loaded: %v, actual: %v\n", loaded, actual)
    // loaded: true, actual: value1 (existing value returned)

    // LoadAndDelete
    if v, ok := m.LoadAndDelete("key2"); ok {
        fmt.Println("deleted:", v)
    }

    // Delete
    m.Delete("key1")

    // Range - iterate all entries
    m.Range(func(key, value any) bool {
        fmt.Printf("%v: %v\n", key, value)
        return true // return false to stop iteration
    })
}
```

### sync.Map Limitation: No Type Safety

`sync.Map` uses `any` for both keys and values, requiring type assertions. For production code, wrap it:

```go
// TypedSyncMap provides type-safe access to sync.Map
type TypedSyncMap[K comparable, V any] struct {
    m sync.Map
}

func (t *TypedSyncMap[K, V]) Store(key K, value V) {
    t.m.Store(key, value)
}

func (t *TypedSyncMap[K, V]) Load(key K) (V, bool) {
    v, ok := t.m.Load(key)
    if !ok {
        var zero V
        return zero, false
    }
    return v.(V), true
}

func (t *TypedSyncMap[K, V]) LoadOrStore(key K, value V) (V, bool) {
    actual, loaded := t.m.LoadOrStore(key, value)
    return actual.(V), loaded
}

func (t *TypedSyncMap[K, V]) Delete(key K) {
    t.m.Delete(key)
}

func (t *TypedSyncMap[K, V]) Range(fn func(K, V) bool) {
    t.m.Range(func(k, v any) bool {
        return fn(k.(K), v.(V))
    })
}
```

### When sync.Map Underperforms

`sync.Map` is **slower** than `map+RWMutex` for write-heavy or mixed workloads. The internal dirty map mechanism adds overhead when entries are frequently updated.

```
Workload: 50% read, 50% write (high write rate)
BenchmarkSyncMap-8        3000000    ~400 ns/op  <- slower
BenchmarkRWMutexMap-8     5000000    ~300 ns/op  <- faster
```

## Sharded Map for High-Contention Workloads

When a single mutex becomes a bottleneck (visible as high mutex wait time in pprof), shard the map across N independent maps with N independent mutexes. Contention is reduced by a factor of N.

```go
package shardedmap

import (
    "hash/fnv"
    "sync"
)

const defaultShards = 256

// ShardedMap distributes keys across N independent maps to reduce lock contention.
type ShardedMap[V any] struct {
    shards []*shard[V]
    count  int
}

type shard[V any] struct {
    mu   sync.RWMutex
    data map[string]V
}

func New[V any](numShards int) *ShardedMap[V] {
    if numShards <= 0 {
        numShards = defaultShards
    }
    // Round up to next power of 2 for efficient modulo via bitmasking
    n := 1
    for n < numShards {
        n <<= 1
    }
    sm := &ShardedMap[V]{
        shards: make([]*shard[V], n),
        count:  n,
    }
    for i := range sm.shards {
        sm.shards[i] = &shard[V]{
            data: make(map[string]V),
        }
    }
    return sm
}

func (sm *ShardedMap[V]) shardFor(key string) *shard[V] {
    h := fnv.New32a()
    h.Write([]byte(key))
    // Fast modulo for power-of-2 shard count
    return sm.shards[h.Sum32()&uint32(sm.count-1)]
}

func (sm *ShardedMap[V]) Get(key string) (V, bool) {
    s := sm.shardFor(key)
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.data[key]
    return v, ok
}

func (sm *ShardedMap[V]) Set(key string, value V) {
    s := sm.shardFor(key)
    s.mu.Lock()
    defer s.mu.Unlock()
    s.data[key] = value
}

func (sm *ShardedMap[V]) Delete(key string) {
    s := sm.shardFor(key)
    s.mu.Lock()
    defer s.mu.Unlock()
    delete(s.data, key)
}

func (sm *ShardedMap[V]) Len() int {
    total := 0
    for _, s := range sm.shards {
        s.mu.RLock()
        total += len(s.data)
        s.mu.RUnlock()
    }
    return total
}

// Range iterates all entries. Not atomic across shards.
func (sm *ShardedMap[V]) Range(fn func(string, V) bool) {
    for _, s := range sm.shards {
        s.mu.RLock()
        for k, v := range s.data {
            s.mu.RUnlock()
            if !fn(k, v) {
                return
            }
            s.mu.RLock()
        }
        s.mu.RUnlock()
    }
}
```

### Benchmarking Sharded vs Single-Mutex

```go
// bench_test.go
package shardedmap_test

import (
    "fmt"
    "strconv"
    "sync"
    "testing"

    "your-module/shardedmap"
)

const numKeys = 10000

func BenchmarkShardedMap_Get(b *testing.B) {
    sm := shardedmap.New[string](256)
    for i := 0; i < numKeys; i++ {
        sm.Set(strconv.Itoa(i), fmt.Sprintf("value-%d", i))
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            sm.Get(strconv.Itoa(i % numKeys))
            i++
        }
    })
}

func BenchmarkRWMutexMap_Get(b *testing.B) {
    var mu sync.RWMutex
    m := make(map[string]string, numKeys)
    for i := 0; i < numKeys; i++ {
        m[strconv.Itoa(i)] = fmt.Sprintf("value-%d", i)
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            mu.RLock()
            _ = m[strconv.Itoa(i%numKeys)]
            mu.RUnlock()
            i++
        }
    })
}
```

Results with 8 CPUs, 95% reads:

```
BenchmarkShardedMap_Get-8      50000000    ~30 ns/op
BenchmarkRWMutexMap_Get-8      10000000   ~150 ns/op
```

5x speedup for read-heavy workloads with 256 shards.

## Atomic Operations with sync/atomic

For counters, flags, and simple state that can be read/written atomically, `sync/atomic` provides lock-free operations with sequential consistency guarantees.

```go
package metrics

import (
    "sync/atomic"
    "time"
)

// Counter is a lock-free, thread-safe counter.
type Counter struct {
    value atomic.Int64
}

func (c *Counter) Inc() {
    c.value.Add(1)
}

func (c *Counter) Add(n int64) {
    c.value.Add(n)
}

func (c *Counter) Load() int64 {
    return c.value.Load()
}

func (c *Counter) Reset() int64 {
    return c.value.Swap(0)
}

// RateCounter tracks events per second.
type RateCounter struct {
    count    atomic.Int64
    lastReset atomic.Int64 // Unix nanoseconds
}

func NewRateCounter() *RateCounter {
    rc := &RateCounter{}
    rc.lastReset.Store(time.Now().UnixNano())
    return rc
}

func (r *RateCounter) Inc() {
    r.count.Add(1)
}

func (r *RateCounter) Rate() float64 {
    now := time.Now().UnixNano()
    last := r.lastReset.Load()
    elapsed := float64(now-last) / float64(time.Second)
    if elapsed <= 0 {
        return 0
    }
    count := r.count.Swap(0)
    r.lastReset.Store(now)
    return float64(count) / elapsed
}

// Flag is a lock-free boolean flag.
type Flag struct {
    val atomic.Uint32
}

func (f *Flag) Set() {
    f.val.Store(1)
}

func (f *Flag) Clear() {
    f.val.Store(0)
}

func (f *Flag) IsSet() bool {
    return f.val.Load() == 1
}

// CompareAndSwap sets the flag only if it is currently clear.
// Returns true if the flag was set successfully.
func (f *Flag) TrySet() bool {
    return f.val.CompareAndSwap(0, 1)
}
```

### Compare-and-Swap Patterns

CAS enables lock-free state machines:

```go
package statemachine

import (
    "fmt"
    "sync/atomic"
)

const (
    StateIdle    = 0
    StateRunning = 1
    StateStopped = 2
)

type Worker struct {
    state atomic.Uint32
}

// Start transitions from Idle to Running.
// Returns error if already running or stopped.
func (w *Worker) Start() error {
    if !w.state.CompareAndSwap(StateIdle, StateRunning) {
        current := w.state.Load()
        switch current {
        case StateRunning:
            return fmt.Errorf("worker already running")
        case StateStopped:
            return fmt.Errorf("worker already stopped")
        }
    }
    go w.run()
    return nil
}

func (w *Worker) Stop() error {
    if !w.state.CompareAndSwap(StateRunning, StateStopped) {
        return fmt.Errorf("worker not in running state (current: %d)", w.state.Load())
    }
    return nil
}

func (w *Worker) run() {
    for w.state.Load() == StateRunning {
        // do work
    }
}
```

## Lock-Free Ring Buffer

A single-producer, single-consumer ring buffer is the classic lock-free data structure. It uses atomic head/tail pointers to avoid any mutex.

```go
package ringbuf

import (
    "runtime"
    "sync/atomic"
)

// RingBuffer is a lock-free SPSC (single-producer, single-consumer) ring buffer.
// Only safe for exactly one goroutine writing and one goroutine reading.
type RingBuffer[T any] struct {
    buf  []T
    head atomic.Uint64  // Next write position
    tail atomic.Uint64  // Next read position
    mask uint64         // len(buf) - 1, for fast modulo
}

func NewRingBuffer[T any](size uint64) *RingBuffer[T] {
    // Size must be power of 2
    if size == 0 || (size&(size-1)) != 0 {
        panic("RingBuffer size must be a power of 2")
    }
    return &RingBuffer[T]{
        buf:  make([]T, size),
        mask: size - 1,
    }
}

// Push adds an item to the buffer. Returns false if full.
func (r *RingBuffer[T]) Push(item T) bool {
    head := r.head.Load()
    tail := r.tail.Load()

    if head-tail >= uint64(len(r.buf)) {
        return false // Full
    }

    r.buf[head&r.mask] = item
    // Memory barrier: ensure the write to buf is visible before updating head
    r.head.Add(1)
    return true
}

// Pop removes and returns an item. Returns zero value and false if empty.
func (r *RingBuffer[T]) Pop() (T, bool) {
    tail := r.tail.Load()
    head := r.head.Load()

    if tail >= head {
        var zero T
        return zero, false // Empty
    }

    item := r.buf[tail&r.mask]
    // Memory barrier: ensure read from buf is complete before updating tail
    r.tail.Add(1)
    return item, true
}

// Len returns the current number of items.
func (r *RingBuffer[T]) Len() int {
    head := r.head.Load()
    tail := r.tail.Load()
    return int(head - tail)
}

func (r *RingBuffer[T]) Cap() int {
    return len(r.buf)
}
```

For multi-producer, multi-consumer scenarios, the MPMC ring buffer requires CAS operations:

```go
// MPMCRingBuffer is safe for multiple producers and consumers.
type MPMCRingBuffer[T any] struct {
    slots []slot[T]
    mask  uint64
    head  atomic.Uint64
    tail  atomic.Uint64
}

type slot[T any] struct {
    seq   atomic.Uint64
    value T
}

func NewMPMCRingBuffer[T any](size uint64) *MPMCRingBuffer[T] {
    if size == 0 || (size&(size-1)) != 0 {
        panic("size must be power of 2")
    }
    rb := &MPMCRingBuffer[T]{
        slots: make([]slot[T], size),
        mask:  size - 1,
    }
    for i := range rb.slots {
        rb.slots[i].seq.Store(uint64(i))
    }
    return rb
}

func (rb *MPMCRingBuffer[T]) Push(item T) bool {
    var pos uint64
    for {
        pos = rb.head.Load()
        s := &rb.slots[pos&rb.mask]
        seq := s.seq.Load()
        diff := int64(seq) - int64(pos)
        if diff == 0 {
            // Slot available - try to claim it
            if rb.head.CompareAndSwap(pos, pos+1) {
                s.value = item
                s.seq.Store(pos + 1)
                return true
            }
        } else if diff < 0 {
            return false // Full
        } else {
            runtime.Gosched() // Yield and retry
        }
    }
}

func (rb *MPMCRingBuffer[T]) Pop() (T, bool) {
    var pos uint64
    for {
        pos = rb.tail.Load()
        s := &rb.slots[pos&rb.mask]
        seq := s.seq.Load()
        diff := int64(seq) - int64(pos+1)
        if diff == 0 {
            if rb.tail.CompareAndSwap(pos, pos+1) {
                item := s.value
                s.seq.Store(pos + rb.mask + 1)
                return item, true
            }
        } else if diff < 0 {
            var zero T
            return zero, false // Empty
        } else {
            runtime.Gosched()
        }
    }
}
```

## Detecting Data Races

### go test -race

The race detector instruments memory accesses and detects unsynchronized reads and writes:

```bash
# Run all tests with race detection
go test -race ./...

# Run specific benchmark with race detection
go test -race -bench=BenchmarkShardedMap -run='^$' ./...

# Build and run binary with race detection
go build -race -o server ./cmd/server
./server
```

### Common Race Patterns to Detect

```go
// Race 1: Closing over loop variable
func launchWorkers() {
    for i := 0; i < 10; i++ {
        i := i // CORRECT: shadow variable with new binding
        go func() {
            fmt.Println(i)
        }()
    }
}

// Race 2: Slice append from multiple goroutines
func collectResults() []int {
    results := make([]int, 0, 100)
    var mu sync.Mutex // CORRECT: protect slice
    var wg sync.WaitGroup

    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            mu.Lock()
            results = append(results, n)
            mu.Unlock()
        }(i)
    }
    wg.Wait()
    return results
}

// Race 3: Reading/writing struct without synchronization
type Config struct {
    Timeout time.Duration
}

type Server struct {
    cfg atomic.Pointer[Config] // CORRECT: atomic pointer for config
}

func (s *Server) SetConfig(cfg *Config) {
    s.cfg.Store(cfg)
}

func (s *Server) GetTimeout() time.Duration {
    return s.cfg.Load().Timeout
}
```

## Choosing the Right Approach

| Scenario | Recommended Approach |
|----------|---------------------|
| General read/write map | `map + sync.RWMutex` |
| Mostly written once, then read | `sync.Map` |
| Concurrent key-disjoint writes | `sync.Map` |
| High-contention map (>4 CPUs fighting) | Sharded map (256 shards) |
| Simple counter/flag | `sync/atomic` |
| Single-producer, single-consumer queue | SPSC ring buffer |
| Multi-producer/consumer queue | MPMC ring buffer or `chan` |
| Complex state transitions | CAS with `atomic.CompareAndSwap` |

When in doubt, start with `map + sync.RWMutex`. Profile first, optimize second. The race detector finds actual bugs; the benchmarks tell you where to optimize after bugs are fixed.
