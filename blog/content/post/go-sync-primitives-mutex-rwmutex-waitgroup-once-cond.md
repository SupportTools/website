---
title: "Go Sync Primitives: Mutex, RWMutex, WaitGroup, Once, and Cond"
date: 2029-04-20T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Sync", "Mutex", "Performance", "Golang"]
categories: ["Go", "Concurrency"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go's sync package: Mutex contention analysis, RWMutex read optimization, sync.Once patterns for initialization, sync.Cond broadcast coordination, and atomic operations for lock-free programming in production Go services."
more_link: "yes"
url: "/go-sync-primitives-mutex-rwmutex-waitgroup-once-cond/"
---

Go's `sync` package is deceptively simple — it provides seven types and a handful of atomic operations that together cover nearly every concurrency coordination need in production code. Yet incorrect use of these primitives causes some of the most difficult bugs to diagnose: data races, deadlocks, starvation, and spurious wakeups. This guide covers every primitive in depth with real-world patterns, performance analysis, and common pitfalls drawn from production Go services.

<!--more-->

# Go Sync Primitives: Mutex, RWMutex, WaitGroup, Once, and Cond

## Section 1: sync.Mutex

`sync.Mutex` is Go's basic mutual exclusion lock. It has two methods: `Lock()` and `Unlock()`. Only one goroutine holds the lock at a time; all others block on `Lock()` until the lock is released.

### Basic Usage

```go
package main

import (
    "fmt"
    "sync"
)

type SafeCounter struct {
    mu    sync.Mutex
    count int
}

func (c *SafeCounter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

func (c *SafeCounter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}

func main() {
    var wg sync.WaitGroup
    counter := &SafeCounter{}

    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Increment()
        }()
    }

    wg.Wait()
    fmt.Println("Final count:", counter.Value()) // Always 1000
}
```

### Internal Mutex States

The Go runtime mutex has three states:

```
Unlocked (0)  ──Lock()──> Locked
Locked        ──Unlock()─> Unlocked
              ──contention─> Starving (after 1ms of waiting)
```

In **normal mode**, goroutines waiting for the lock compete in FIFO order but newly arriving goroutines can steal the lock from waiting goroutines for better throughput (they are already running on a CPU). In **starvation mode** (triggered when a goroutine waits more than 1ms), the lock is handed directly to the oldest waiter — trading throughput for fairness.

### Mutex Contention Analysis

High contention manifests as CPU spinning and goroutine blocking. Detect it with pprof:

```go
package main

import (
    "net/http"
    _ "net/http/pprof"
    "sync"
    "time"
)

var (
    mu      sync.Mutex
    sharedMap = make(map[string]int)
)

// Simulate high-contention pattern
func highContention() {
    for i := 0; i < 10000; i++ {
        mu.Lock()
        sharedMap["key"]++
        mu.Unlock()
    }
}

func main() {
    go http.ListenAndServe("localhost:6060", nil)

    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            highContention()
        }()
    }
    wg.Wait()
}

// Profile with:
// go tool pprof http://localhost:6060/debug/pprof/mutex
```

### Reducing Contention: Lock Striping

When a single mutex protects a large data structure, replace it with a striped array of mutexes:

```go
package main

import (
    "sync"
    "hash/fnv"
)

const numShards = 32

type ShardedMap struct {
    shards [numShards]struct {
        sync.RWMutex
        data map[string]interface{}
    }
}

func NewShardedMap() *ShardedMap {
    sm := &ShardedMap{}
    for i := range sm.shards {
        sm.shards[i].data = make(map[string]interface{})
    }
    return sm
}

func (sm *ShardedMap) shard(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % numShards
}

func (sm *ShardedMap) Set(key string, value interface{}) {
    idx := sm.shard(key)
    sm.shards[idx].Lock()
    defer sm.shards[idx].Unlock()
    sm.shards[idx].data[key] = value
}

func (sm *ShardedMap) Get(key string) (interface{}, bool) {
    idx := sm.shard(key)
    sm.shards[idx].RLock()
    defer sm.shards[idx].RUnlock()
    v, ok := sm.shards[idx].data[key]
    return v, ok
}
```

### Critical: Never Copy a Mutex After First Use

```go
// BAD: copies the mutex
type Config struct {
    mu   sync.Mutex
    data map[string]string
}

func processConfig(cfg Config) {  // Copy passes mu by value — RACE CONDITION
    cfg.mu.Lock()
    defer cfg.mu.Unlock()
    // ...
}

// GOOD: pass pointer
func processConfig(cfg *Config) {
    cfg.mu.Lock()
    defer cfg.mu.Unlock()
    // ...
}
```

The `go vet` tool detects mutex copies with the `copylocks` checker. Run `go vet ./...` in CI to catch this.

### TryLock (Go 1.18+)

```go
// Non-blocking attempt — returns false if lock is held
if mu.TryLock() {
    defer mu.Unlock()
    // Critical section
} else {
    // Fallback: use cached value, skip work, etc.
}
```

Use TryLock sparingly — it can mask lock contention issues and complicate reasoning about invariants.

## Section 2: sync.RWMutex

`RWMutex` separates read and write access. Multiple readers can hold the lock simultaneously; a writer gets exclusive access. This is highly effective when reads vastly outnumber writes.

### When RWMutex Wins

```go
package main

import (
    "sync"
    "testing"
)

type Store struct {
    mu   sync.Mutex
    data map[string]string
}

type RWStore struct {
    mu   sync.RWMutex
    data map[string]string
}

// BenchmarkMutex — all goroutines contend on single mutex for reads
func BenchmarkMutex(b *testing.B) {
    s := &Store{data: make(map[string]string)}
    s.data["key"] = "value"

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            s.mu.Lock()
            _ = s.data["key"]
            s.mu.Unlock()
        }
    })
}

// BenchmarkRWMutex — readers proceed in parallel
func BenchmarkRWMutex(b *testing.B) {
    s := &RWStore{data: make(map[string]string)}
    s.data["key"] = "value"

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            s.mu.RLock()
            _ = s.data["key"]
            s.mu.RUnlock()
        }
    })
}
```

Typical results on an 8-core machine:
```
BenchmarkMutex-8     20000000    75 ns/op
BenchmarkRWMutex-8   100000000   12 ns/op  # 6x faster for read-heavy workloads
```

### The Writer Starvation Problem

RWMutex prevents writer starvation: once a writer calls `Lock()`, new readers must wait until the writer completes, even though existing readers continue. This is correct behavior, but be aware that writes introduce latency spikes in read latency.

```go
// Pattern: batched writes to minimize write lock duration
type CacheStore struct {
    mu      sync.RWMutex
    data    map[string]string
    pending map[string]string  // Accumulate updates without holding write lock
    pendMu  sync.Mutex
}

func (c *CacheStore) Set(key, value string) {
    c.pendMu.Lock()
    c.pending[key] = value
    c.pendMu.Unlock()
}

func (c *CacheStore) Flush() {
    c.pendMu.Lock()
    batch := c.pending
    c.pending = make(map[string]string)
    c.pendMu.Unlock()

    if len(batch) == 0 {
        return
    }

    c.mu.Lock()
    defer c.mu.Unlock()
    for k, v := range batch {
        c.data[k] = v
    }
}

func (c *CacheStore) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.data[key]
    return v, ok
}
```

### RLock/RUnlock Symmetry

Every `RLock` must be paired with `RUnlock`. Use `defer` to ensure this:

```go
func (s *RWStore) Get(key string) (string, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()  // Always matched, even on panic
    v, ok := s.data[key]
    return v, ok
}

// Never do this — can leave the read lock held on early return
func badGet(key string) (string, bool) {
    s.mu.RLock()
    v, ok := s.data[key]
    if !ok {
        return "", false  // RUnlock never called!
    }
    s.mu.RUnlock()
    return v, true
}
```

## Section 3: sync.WaitGroup

`WaitGroup` allows a goroutine to wait for a collection of goroutines to finish. The counter starts at zero; `Add(n)` increments it, `Done()` decrements it (equivalent to `Add(-1)`), and `Wait()` blocks until the counter reaches zero.

### Basic Pattern

```go
func processItems(items []string) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)
        go func(item string) {
            defer wg.Done()
            process(item)
        }(item)
    }

    wg.Wait()
    fmt.Println("All items processed")
}
```

### Critical: Add Before Goroutine Launch

`Add` must be called before the goroutine is started, never from inside the goroutine:

```go
// BAD: race between Add and Wait
var wg sync.WaitGroup
for _, item := range items {
    go func(item string) {
        wg.Add(1)      // Race: Wait() might return before this executes
        defer wg.Done()
        process(item)
    }(item)
}
wg.Wait()

// GOOD: Add before goroutine start
for _, item := range items {
    wg.Add(1)
    go func(item string) {
        defer wg.Done()
        process(item)
    }(item)
}
wg.Wait()
```

### WaitGroup with Error Collection

```go
package main

import (
    "fmt"
    "sync"
)

type Result struct {
    value string
    err   error
}

func processParallel(items []string) ([]Result, error) {
    var (
        wg      sync.WaitGroup
        mu      sync.Mutex
        results []Result
        firstErr error
    )

    for _, item := range items {
        wg.Add(1)
        go func(item string) {
            defer wg.Done()

            result, err := processItem(item)

            mu.Lock()
            defer mu.Unlock()
            results = append(results, Result{value: result, err: err})
            if err != nil && firstErr == nil {
                firstErr = err
            }
        }(item)
    }

    wg.Wait()
    return results, firstErr
}

func processItem(item string) (string, error) {
    // Simulate work
    return "processed:" + item, nil
}
```

### Bounded Concurrency with WaitGroup and Semaphore

```go
func processWithLimit(items []string, maxConcurrency int) {
    var wg sync.WaitGroup
    sem := make(chan struct{}, maxConcurrency)

    for _, item := range items {
        wg.Add(1)
        go func(item string) {
            defer wg.Done()
            sem <- struct{}{}         // Acquire semaphore
            defer func() { <-sem }() // Release semaphore
            process(item)
        }(item)
    }

    wg.Wait()
}
```

### WaitGroup Reuse

A WaitGroup can be reused after Wait returns, but never while the counter is non-zero:

```go
var wg sync.WaitGroup

// First wave
for i := 0; i < 5; i++ {
    wg.Add(1)
    go func(i int) { defer wg.Done(); work(i) }(i)
}
wg.Wait()

// Safe to reuse
for i := 0; i < 5; i++ {
    wg.Add(1)
    go func(i int) { defer wg.Done(); work(i) }(i)
}
wg.Wait()
```

## Section 4: sync.Once

`sync.Once` ensures that a function is executed exactly once, regardless of how many goroutines call it concurrently. It is the correct tool for lazy initialization of expensive resources.

### Singleton Pattern

```go
package main

import (
    "database/sql"
    "fmt"
    "sync"
    _ "github.com/lib/pq"
)

type DB struct {
    conn *sql.DB
}

var (
    dbInstance *DB
    dbOnce     sync.Once
)

func GetDB() *DB {
    dbOnce.Do(func() {
        conn, err := sql.Open("postgres", "postgres://localhost/mydb?sslmode=disable")
        if err != nil {
            panic(fmt.Sprintf("failed to open database: %v", err))
        }
        conn.SetMaxOpenConns(25)
        conn.SetMaxIdleConns(5)
        dbInstance = &DB{conn: conn}
    })
    return dbInstance
}
```

### Once with Error Handling

The standard `sync.Once` does not return errors. For initialization that can fail, use a wrapper:

```go
package main

import (
    "fmt"
    "sync"
)

type OnceWithError struct {
    once sync.Once
    err  error
}

func (o *OnceWithError) Do(f func() error) error {
    o.once.Do(func() {
        o.err = f()
    })
    return o.err
}

// Usage
type Service struct {
    initOnce OnceWithError
    client   *ExpensiveClient
}

func (s *Service) init() error {
    return s.initOnce.Do(func() error {
        client, err := NewExpensiveClient()
        if err != nil {
            return fmt.Errorf("client init: %w", err)
        }
        s.client = client
        return nil
    })
}

func (s *Service) DoWork() error {
    if err := s.init(); err != nil {
        return fmt.Errorf("service not initialized: %w", err)
    }
    return s.client.Execute()
}
```

### Once vs init()

```go
// init() runs at package load time, even if the package is imported but never used
func init() {
    expensiveGlobalInit() // Always runs
}

// sync.Once defers initialization until first use
var once sync.Once
func GetExpensive() *Expensive {
    once.Do(func() {
        // Only runs when GetExpensive() is first called
        expensiveGlobalInit()
    })
    return instance
}
```

Use `sync.Once` when:
- Initialization is expensive and may never be needed
- Initialization order depends on runtime conditions
- The initialized value should be garbage-collected if unused

### Resettable Once (for testing)

```go
// For testing scenarios where you need to reset once state
type ResettableOnce struct {
    mu   sync.Mutex
    done bool
}

func (o *ResettableOnce) Do(f func()) {
    o.mu.Lock()
    defer o.mu.Unlock()
    if !o.done {
        f()
        o.done = true
    }
}

func (o *ResettableOnce) Reset() {
    o.mu.Lock()
    defer o.mu.Unlock()
    o.done = false
}
```

## Section 5: sync.Cond

`sync.Cond` is a condition variable — it allows goroutines to wait for a specific condition to become true while releasing the associated mutex. It is the correct tool when a channel would require sending a value to wake up waiters.

### Core API

```go
type sync.Cond struct {
    L Locker  // The associated mutex/rwmutex
}

func (c *Cond) Wait()      // Releases L, suspends goroutine, reacquires L on wake
func (c *Cond) Signal()    // Wakes one waiting goroutine
func (c *Cond) Broadcast() // Wakes all waiting goroutines
```

### Producer-Consumer with Cond

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

type BoundedBuffer[T any] struct {
    mu       sync.Mutex
    notEmpty *sync.Cond
    notFull  *sync.Cond
    buf      []T
    maxSize  int
}

func NewBoundedBuffer[T any](size int) *BoundedBuffer[T] {
    bb := &BoundedBuffer[T]{maxSize: size}
    bb.notEmpty = sync.NewCond(&bb.mu)
    bb.notFull = sync.NewCond(&bb.mu)
    return bb
}

func (bb *BoundedBuffer[T]) Put(v T) {
    bb.mu.Lock()
    defer bb.mu.Unlock()

    // Wait until there is space
    for len(bb.buf) == bb.maxSize {
        bb.notFull.Wait() // Releases mu, blocks, reacquires mu on wake
    }

    bb.buf = append(bb.buf, v)
    bb.notEmpty.Signal() // Wake one consumer
}

func (bb *BoundedBuffer[T]) Get() T {
    bb.mu.Lock()
    defer bb.mu.Unlock()

    // Wait until there is data
    for len(bb.buf) == 0 {
        bb.notEmpty.Wait()
    }

    v := bb.buf[0]
    bb.buf = bb.buf[1:]
    bb.notFull.Signal() // Wake one producer
    return v
}

func main() {
    buf := NewBoundedBuffer[int](5)

    // Producer
    go func() {
        for i := 0; i < 20; i++ {
            buf.Put(i)
            fmt.Printf("Produced: %d\n", i)
            time.Sleep(50 * time.Millisecond)
        }
    }()

    // Consumer
    go func() {
        for i := 0; i < 20; i++ {
            v := buf.Get()
            fmt.Printf("Consumed: %d\n", v)
            time.Sleep(100 * time.Millisecond)
        }
    }()

    time.Sleep(5 * time.Second)
}
```

### Critical: Always Wait in a Loop

`Wait` can return spuriously (the OS can wake a goroutine without a corresponding Signal). Always check the condition in a loop:

```go
// WRONG: may proceed when condition is not yet true
cond.Wait()
if !ready {
    // Too late to check — another goroutine may have taken the work
}

// CORRECT: loop until condition is genuinely true
for !ready {
    cond.Wait()
}
// Now ready is guaranteed true (we hold the lock)
```

### Broadcast Pattern: Worker Pool Shutdown

```go
package main

import (
    "fmt"
    "sync"
)

type WorkerPool struct {
    mu      sync.Mutex
    cond    *sync.Cond
    tasks   []func()
    quit    bool
    workers sync.WaitGroup
}

func NewWorkerPool(n int) *WorkerPool {
    p := &WorkerPool{}
    p.cond = sync.NewCond(&p.mu)

    for i := 0; i < n; i++ {
        p.workers.Add(1)
        go p.worker()
    }
    return p
}

func (p *WorkerPool) worker() {
    defer p.workers.Done()
    for {
        p.mu.Lock()
        for len(p.tasks) == 0 && !p.quit {
            p.cond.Wait() // Release lock, wait for signal
        }
        if p.quit && len(p.tasks) == 0 {
            p.mu.Unlock()
            return
        }
        task := p.tasks[0]
        p.tasks = p.tasks[1:]
        p.mu.Unlock()

        task()
    }
}

func (p *WorkerPool) Submit(task func()) {
    p.mu.Lock()
    p.tasks = append(p.tasks, task)
    p.mu.Unlock()
    p.cond.Signal() // Wake one worker
}

func (p *WorkerPool) Shutdown() {
    p.mu.Lock()
    p.quit = true
    p.mu.Unlock()
    p.cond.Broadcast() // Wake ALL workers to process quit
    p.workers.Wait()
}

func main() {
    pool := NewWorkerPool(4)

    for i := 0; i < 20; i++ {
        i := i
        pool.Submit(func() {
            fmt.Printf("Processing task %d\n", i)
        })
    }

    pool.Shutdown()
    fmt.Println("All workers done")
}
```

### Cond vs Channel: When to Use Each

| Scenario | Use Cond | Use Channel |
|---|---|---|
| Wake one of N waiters | Signal() | len=1 channel or select |
| Wake all waiters | Broadcast() | close() channel |
| Wait for state change | Yes (condition variable) | No (need value exchange) |
| Timeout on wait | No (use context + goroutine) | Yes (select with time.After) |
| Pass value with signal | No | Yes |

## Section 6: sync/atomic

The `sync/atomic` package provides lock-free operations on primitive types. Atomic operations are implemented using CPU instructions (LOCK CMPXCHG on x86) and are faster than mutex-based synchronization for simple numeric counters and flags.

### Atomic Operations Overview

```go
package main

import (
    "fmt"
    "sync/atomic"
)

func main() {
    // int64 counter
    var counter int64
    atomic.AddInt64(&counter, 1)
    atomic.AddInt64(&counter, -1)
    val := atomic.LoadInt64(&counter)
    fmt.Println("Counter:", val)

    // Compare-and-swap (CAS) — the foundation of lock-free algorithms
    var state int32
    old, new := int32(0), int32(1)
    swapped := atomic.CompareAndSwapInt32(&state, old, new)
    fmt.Println("CAS swapped:", swapped) // true

    // Atomic pointer swap (Go 1.19+ typed atomics)
    var ptr atomic.Pointer[string]
    s := "hello"
    ptr.Store(&s)
    loaded := ptr.Load()
    fmt.Println("Pointer value:", *loaded)
}
```

### Typed Atomics (Go 1.19+)

```go
package main

import (
    "fmt"
    "sync/atomic"
)

type Config struct {
    MaxConnections int
    Timeout        int
}

// Hot-swap configuration without stopping the world
var currentConfig atomic.Pointer[Config]

func init() {
    cfg := &Config{MaxConnections: 100, Timeout: 30}
    currentConfig.Store(cfg)
}

func GetConfig() *Config {
    return currentConfig.Load() // Lock-free, always consistent
}

func UpdateConfig(cfg *Config) {
    currentConfig.Store(cfg) // Atomic store — goroutines see old or new, never partial
}

func main() {
    cfg := GetConfig()
    fmt.Printf("Max connections: %d\n", cfg.MaxConnections)

    // Hot update — running goroutines reading config see a consistent snapshot
    UpdateConfig(&Config{MaxConnections: 200, Timeout: 60})

    cfg = GetConfig()
    fmt.Printf("Updated max connections: %d\n", cfg.MaxConnections)
}
```

### Lock-Free Counter

```go
package main

import (
    "fmt"
    "sync"
    "sync/atomic"
)

type AtomicCounter struct {
    value int64
}

func (c *AtomicCounter) Inc() {
    atomic.AddInt64(&c.value, 1)
}

func (c *AtomicCounter) Dec() {
    atomic.AddInt64(&c.value, -1)
}

func (c *AtomicCounter) Load() int64 {
    return atomic.LoadInt64(&c.value)
}

// Benchmark: atomic vs mutex counter
func benchmarkAtomic() {
    var wg sync.WaitGroup
    counter := &AtomicCounter{}

    start := time.Now()
    for i := 0; i < 8; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < 1_000_000; j++ {
                counter.Inc()
            }
        }()
    }
    wg.Wait()
    elapsed := time.Since(start)
    fmt.Printf("Atomic counter (8 goroutines, 8M ops): %v\n", elapsed)
    // Typical: ~200ms

    // Compare with mutex counter
    var mu sync.Mutex
    var mutexCount int64
    start = time.Now()
    for i := 0; i < 8; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < 1_000_000; j++ {
                mu.Lock()
                mutexCount++
                mu.Unlock()
            }
        }()
    }
    wg.Wait()
    fmt.Printf("Mutex counter (8 goroutines, 8M ops): %v\n", time.Since(start))
    // Typical: ~800ms — 4x slower
}
```

### SpinLock Pattern Using CAS

```go
type SpinLock struct {
    state int32
}

func (sl *SpinLock) Lock() {
    for !atomic.CompareAndSwapInt32(&sl.state, 0, 1) {
        // Yield CPU to avoid burning cycles
        runtime.Gosched()
    }
}

func (sl *SpinLock) Unlock() {
    atomic.StoreInt32(&sl.state, 0)
}
```

Use SpinLock only for extremely short critical sections (< 1 microsecond). For anything longer, `sync.Mutex` is more efficient because it puts the goroutine to sleep rather than burning CPU.

## Section 7: sync.Map

`sync.Map` is a concurrent map optimized for specific access patterns: keys written once and read many times, or independent goroutines working on non-overlapping key sets.

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var m sync.Map

    // Store — safe for concurrent use
    m.Store("key1", "value1")
    m.Store("key2", 42)

    // Load — returns (value, ok)
    if v, ok := m.Load("key1"); ok {
        fmt.Println("key1:", v.(string))
    }

    // LoadOrStore — atomic check-then-set
    actual, loaded := m.LoadOrStore("key3", "new-value")
    fmt.Printf("LoadOrStore: value=%v, was loaded=%v\n", actual, loaded)

    // Range — iterate (no guaranteed order)
    m.Range(func(key, value interface{}) bool {
        fmt.Printf("%v -> %v\n", key, value)
        return true // Return false to stop iteration
    })

    // Delete
    m.Delete("key1")

    // LoadAndDelete — atomic load-then-delete
    v, loaded := m.LoadAndDelete("key2")
    fmt.Printf("LoadAndDelete: value=%v, was present=%v\n", v, loaded)
}
```

### When to Use sync.Map vs map+RWMutex

| Pattern | sync.Map | map+RWMutex |
|---|---|---|
| Write once, read many | Excellent | Good |
| Balanced read/write | Worse (internal indirection) | Better |
| Many goroutines, disjoint keys | Excellent | Good |
| Keys known at startup | Neither (use slice) | Neither |
| Iteration under concurrent write | Safe | Requires holding write lock |

## Section 8: sync.Pool

`sync.Pool` is an object pool for temporary objects, reducing garbage collection pressure for frequently allocated and discarded objects.

```go
package main

import (
    "bytes"
    "fmt"
    "sync"
)

var bufPool = sync.Pool{
    New: func() interface{} {
        return &bytes.Buffer{}
    },
}

func processRequest(data string) string {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()

    buf.WriteString("processed: ")
    buf.WriteString(data)
    return buf.String()
}

func main() {
    for i := 0; i < 5; i++ {
        fmt.Println(processRequest(fmt.Sprintf("request-%d", i)))
    }
}
```

**Important limitations:**
- Pooled objects may be garbage-collected at any time (during GC)
- Objects may be moved between goroutines (do not hold goroutine-local state)
- Pool does not size-limit — it only reduces allocation pressure, not memory usage bounds

## Section 9: Deadlock Detection and Prevention

### Common Deadlock Patterns

```go
// Deadlock pattern 1: Lock ordering inversion
var mu1, mu2 sync.Mutex

// Goroutine A                  Goroutine B
// mu1.Lock()                   mu2.Lock()
// mu2.Lock()  <-- waits        mu1.Lock()  <-- waits -> DEADLOCK

// Prevention: always acquire locks in the same order
func correctOrder() {
    mu1.Lock()
    defer mu1.Unlock()
    mu2.Lock()
    defer mu2.Unlock()
    // Both goroutines follow: mu1 -> mu2
}

// Deadlock pattern 2: Lock recursion
func recursive(mu *sync.Mutex) {
    mu.Lock()
    defer mu.Unlock()
    recursive(mu) // DEADLOCK: tries to Lock() an already-locked mutex
}

// Solution: extract logic, pass data not locks
func recursiveSafe(data []int) {
    // No mutex inside recursive function
    // Caller holds lock for entire operation
}
```

### Detecting Deadlocks

```bash
# Go runtime detects deadlocks where ALL goroutines are blocked
# It prints "all goroutines are asleep - deadlock!" and exits

# For partial deadlocks (some goroutines deadlocked, others still running),
# use goroutine profiles:
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 | grep -A 10 "semacquire"

# goleak: detect goroutine leaks in tests
go get go.uber.org/goleak
```

```go
package mypackage_test

import (
    "testing"
    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m) // Fails if goroutines are leaked after test
}
```

## Section 10: Production Patterns and Anti-Patterns

### Pattern: Mutex with Timeout

```go
// Go mutexes don't support timeout natively.
// Use a channel to implement a tryLock with timeout.
func lockWithTimeout(mu *sync.Mutex, timeout time.Duration) bool {
    ch := make(chan struct{}, 1)
    go func() {
        mu.Lock()
        ch <- struct{}{}
    }()
    select {
    case <-ch:
        return true
    case <-time.After(timeout):
        return false
    }
}
// WARNING: The goroutine trying to lock will eventually acquire it and
// block until the owner calls Unlock. Use with care.
```

### Pattern: Read-Copy-Update (RCU) Style

```go
type RCUStore[T any] struct {
    ptr atomic.Pointer[T]
}

func (s *RCUStore[T]) Load() *T {
    return s.ptr.Load()
}

func (s *RCUStore[T]) Update(fn func(*T) *T) {
    for {
        old := s.ptr.Load()
        newVal := fn(old) // Create new value based on old (no mutation)
        if s.ptr.CompareAndSwap(old, newVal) {
            return // Successfully updated
        }
        // Another goroutine updated concurrently — retry
    }
}
```

### Anti-Pattern: Holding Locks During I/O

```go
// BAD: Holds mutex while making HTTP request
func badFetch(mu *sync.Mutex, cache map[string]string, url string) string {
    mu.Lock()
    defer mu.Unlock()

    if v, ok := cache[url]; ok {
        return v
    }

    // This can take seconds! All other goroutines block.
    resp, err := http.Get(url)
    // ...
    return result
}

// GOOD: Double-checked locking pattern
func goodFetch(mu *sync.RWMutex, cache map[string]string, url string) string {
    mu.RLock()
    if v, ok := cache[url]; ok {
        mu.RUnlock()
        return v
    }
    mu.RUnlock()

    // Fetch without holding any lock
    result := fetchFromNetwork(url)

    mu.Lock()
    if _, ok := cache[url]; !ok { // Check again after acquiring write lock
        cache[url] = result
    }
    mu.Unlock()

    return result
}
```

### Anti-Pattern: Leaked Goroutines Due to Forgotten Signals

```go
// BAD: If producer exits without signaling, consumer waits forever
func leakedConsumer(cond *sync.Cond) {
    cond.L.Lock()
    defer cond.L.Unlock()
    for !done {
        cond.Wait() // Blocked forever if Signal/Broadcast never called
    }
}

// GOOD: Use context for cancellation
func safeConsumer(ctx context.Context, cond *sync.Cond, done *bool) {
    // Use a separate goroutine to handle context cancellation
    go func() {
        <-ctx.Done()
        cond.Broadcast() // Wake all waiters when context is cancelled
    }()

    cond.L.Lock()
    defer cond.L.Unlock()
    for !*done {
        if ctx.Err() != nil {
            return
        }
        cond.Wait()
    }
}
```

## Conclusion

Go's `sync` package provides a minimal but complete set of concurrency primitives. The key to using them correctly is understanding the invariants each one maintains:

- `Mutex`: one holder at a time, no read/write distinction
- `RWMutex`: many concurrent readers OR one writer, not both
- `WaitGroup`: "wait for N goroutines to finish" — counter must be positive before Wait
- `Once`: "execute exactly once" — the function runs once, its side effects are visible to all callers
- `Cond`: "wait for a condition" — always check condition in a loop, always hold the lock when reading the condition
- `atomic`: "update a single word atomically" — no locks, but only for primitive types

Master these six primitives and you can implement nearly any concurrent data structure correctly and efficiently.
