---
title: "Go Memory Safety with the Race Detector: -race Flag, sync.Mutex vs sync.RWMutex, Atomic Operations, and Data Race Patterns"
date: 2032-01-08T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Concurrency", "Race Detector", "sync", "Atomic", "Memory Safety", "Performance"]
categories:
- Go
- Software Engineering
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Go memory safety: using the race detector in CI pipelines, choosing between Mutex and RWMutex, leveraging sync/atomic for lock-free patterns, and identifying common data race anti-patterns."
more_link: "yes"
url: "/go-memory-safety-race-detector-mutex-atomic-data-race-patterns/"
---

Data races are among the most dangerous bugs in concurrent software: they are non-deterministic, often reproduce only under load, can cause silent data corruption, and may not manifest as crashes for weeks or months. Go provides an excellent built-in race detector, a well-designed `sync` package, and `sync/atomic` for lock-free patterns. This guide covers all three in depth—how the race detector works, when to choose each synchronization primitive, how to build correct lock-free data structures, and the canonical data race anti-patterns that appear repeatedly in production Go codebases.

<!--more-->

# Go Memory Safety: Race Detector, Mutexes, and Atomic Operations

## Understanding the Go Memory Model

The Go memory model (formally specified at go.dev/ref/mem) defines when one goroutine is guaranteed to observe writes made by another. The key rule: **a read of a variable `v` is allowed to observe the value written by a write `w` only if `w` happens-before `r` and no other write to `v` happens between `w` and `r`.**

"Happens-before" is established by:
- Goroutine creation (`go` statement)
- Channel send/receive (unbuffered: send happens-before receive)
- sync.Mutex/RWMutex lock/unlock
- sync.Once.Do
- sync/atomic operations (with appropriate memory ordering)
- sync.WaitGroup.Done/Wait
- context cancellation

Any communication between goroutines that does NOT use one of these mechanisms is a data race.

## Part 1: The Race Detector

### How It Works

Go's race detector is based on the ThreadSanitizer (TSan) v2 algorithm, implemented as a compiler-instrumented shadow memory approach:

1. The compiler inserts memory access instrumentation at every memory read and write.
2. The runtime maintains a shadow memory structure tracking "access history" (goroutine ID, vector clock, read/write) for every 8 bytes of heap/stack memory.
3. On each access, the runtime checks whether the access conflicts with recent accesses by other goroutines without an intervening synchronization event.
4. When a race is detected, the runtime prints a detailed report and optionally terminates the program.

**Overhead**: 5-10x slower, 5-10x more memory. Never deploy `-race` binaries in production.

### Enabling the Race Detector

```bash
# Run tests with race detection (most important use)
go test -race ./...

# Run a specific binary with race detection
go run -race main.go

# Build a race-instrumented binary (for testing environments only)
go build -race -o ./bin/server-race ./cmd/server

# Set environment variable to control race behavior
GORACE="log_path=/var/log/race.log halt_on_error=0 history_size=4" \
    ./bin/server-race
```

### GORACE Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `log_path` | `stderr` | Path prefix for race reports |
| `halt_on_error` | `1` | Terminate after first race |
| `atexit_sleep_ms` | `1000` | Sleep before exit (flush logs) |
| `strip_path_prefix` | `""` | Remove path prefix from stack traces |
| `history_size` | `1` | Per-goroutine access history (0-7, 1=64K events) |

### CI Pipeline Integration

```yaml
# .github/workflows/race-test.yaml
name: Race Detector Tests

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  race-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Run tests with race detector
        run: |
          go test -race -count=1 -timeout=300s ./...
        env:
          GORACE: "halt_on_error=1 log_path=race-log"

      - name: Upload race logs on failure
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: race-logs
          path: race-log.*
```

### Reading Race Reports

A typical race report:

```
==================
WARNING: DATA RACE
Write at 0x00c000122070 by goroutine 8:
  main.(*Counter).Inc()
      /home/user/app/counter.go:15 +0x44
  main.worker()
      /home/user/app/main.go:32 +0x5c

Previous read at 0x00c000122070 by goroutine 7:
  main.(*Counter).Value()
      /home/user/app/counter.go:20 +0x38
  main.reporter()
      /home/user/app/main.go:45 +0x74

Goroutine 8 (running) created at:
  main.main()
      /home/user/app/main.go:22 +0x9c

Goroutine 7 (running) created at:
  main.main()
      /home/user/app/main.go:18 +0x7c
==================
```

Parsing the report:
1. The **conflicting accesses** (write and previous read) identify the exact source lines
2. The **goroutine creation stacks** identify where each goroutine was launched
3. The address `0x00c000122070` identifies which memory was raced upon

## Part 2: sync.Mutex

### Basic Mutex Pattern

```go
package counter

import "sync"

// SafeCounter is goroutine-safe using sync.Mutex.
type SafeCounter struct {
    mu    sync.Mutex
    value int64
}

// Inc increments the counter.
func (c *SafeCounter) Inc() {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

// Add increments by delta.
func (c *SafeCounter) Add(delta int64) {
    c.mu.Lock()
    c.value += delta
    c.mu.Unlock()
}

// Value returns the current count.
func (c *SafeCounter) Value() int64 {
    c.mu.Lock()
    v := c.value
    c.mu.Unlock()
    return v
}

// Reset resets the counter and returns the previous value.
func (c *SafeCounter) Reset() int64 {
    c.mu.Lock()
    v := c.value
    c.value = 0
    c.mu.Unlock()
    return v
}
```

### Mutex Embedding vs Field

A common design question: should the mutex be embedded or a named field?

```go
// Named field (recommended): explicit, harder to accidentally expose
type CacheStore struct {
    mu    sync.Mutex      // unexported, not part of API
    items map[string]any
}

// Embedded (problematic): mutex methods become part of the struct's method set
// Anyone can call Lock()/Unlock() from outside, breaking encapsulation
type BadCache struct {
    sync.Mutex            // DO NOT do this for exported types
    Items map[string]any
}

// If you embed, at least make it unexported struct in package scope
```

### Defer for Lock Release

Always defer `Unlock()` to prevent lock leaks on early returns and panics:

```go
func (c *CacheStore) Get(key string) (any, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()
    v, ok := c.items[key]
    return v, ok
}

func (c *CacheStore) Set(key string, value any) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if c.items == nil {
        c.items = make(map[string]any)
    }
    c.items[key] = value
}
```

### Lock Ordering to Prevent Deadlocks

When acquiring multiple locks, always acquire them in a consistent order:

```go
// DEADLOCK-PRONE: goroutine A locks mu1 then mu2,
// goroutine B locks mu2 then mu1 simultaneously
func transfer(src, dst *Account, amount int64) {
    src.mu.Lock()   // goroutine A: locks src
    dst.mu.Lock()   // goroutine A: tries dst — DEADLOCK if goroutine B has dst
    src.balance -= amount
    dst.balance += amount
    dst.mu.Unlock()
    src.mu.Unlock()
}

// CORRECT: always lock lower ID first
func transferSafe(src, dst *Account, amount int64) {
    first, second := src, dst
    if src.id > dst.id {
        first, second = dst, src
    }
    first.mu.Lock()
    defer first.mu.Unlock()
    second.mu.Lock()
    defer second.mu.Unlock()

    src.balance -= amount
    dst.balance += amount
}
```

### TryLock for Non-Blocking Acquisition

Go 1.18+ added `TryLock()`:

```go
func (c *CacheStore) TryGet(key string) (any, bool, bool) {
    if !c.mu.TryLock() {
        return nil, false, false // lock contended, returned immediately
    }
    defer c.mu.Unlock()
    v, ok := c.items[key]
    return v, ok, true
}
```

## Part 3: sync.RWMutex

### When to Use RWMutex

`sync.RWMutex` allows multiple concurrent readers OR one exclusive writer—but never both simultaneously. Use it when:
- Reads vastly outnumber writes (read-heavy caches, configuration stores)
- Read operations are significantly longer than writes
- Lock contention is measurable

Do **not** use RWMutex when:
- Write frequency is comparable to read frequency (writer starvation may occur)
- The critical section is very short (overhead of RWMutex exceeds Mutex)
- You need a simple counter (use atomic instead)

```go
package config

import "sync"

// ConfigStore is a read-heavy, write-rare configuration map.
type ConfigStore struct {
    mu     sync.RWMutex
    values map[string]string
}

// Get acquires a read lock — allows concurrent readers.
func (s *ConfigStore) Get(key string) (string, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.values[key]
    return v, ok
}

// GetAll returns a snapshot of all config values.
// Acquiring RLock allows concurrent reads while writes are blocked.
func (s *ConfigStore) GetAll() map[string]string {
    s.mu.RLock()
    defer s.mu.RUnlock()
    // Return a copy to prevent mutation after unlock
    copy := make(map[string]string, len(s.values))
    for k, v := range s.values {
        copy[k] = v
    }
    return copy
}

// Set acquires an exclusive write lock.
func (s *ConfigStore) Set(key, value string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.values == nil {
        s.values = make(map[string]string)
    }
    s.values[key] = value
}

// BatchUpdate atomically replaces all config values.
func (s *ConfigStore) BatchUpdate(newValues map[string]string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.values = newValues
}
```

### RWMutex Performance Benchmark

```go
package config_test

import (
    "sync"
    "testing"
)

func BenchmarkMutexRead(b *testing.B) {
    var mu sync.Mutex
    value := 42
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.Lock()
            _ = value
            mu.Unlock()
        }
    })
}

func BenchmarkRWMutexRead(b *testing.B) {
    var mu sync.RWMutex
    value := 42
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.RLock()
            _ = value
            mu.RUnlock()
        }
    })
}
```

Benchmark results with `GOMAXPROCS=8`:
```
BenchmarkMutexRead-8     32901716    36.5 ns/op
BenchmarkRWMutexRead-8   87134902    13.7 ns/op
```

RWMutex is ~2.7x faster for pure read workloads at 8 goroutines.

### Writer Starvation Warning

In Go's `sync.RWMutex` implementation, a pending writer blocks new readers. This prevents writer starvation when the read rate is high. However, if writes are infrequent but readers are numerous, a long read may still delay a writer:

```go
// Pattern to avoid writer starvation: use timeouts or
// context-aware locking with TryLock in write-sensitive code

func (s *ConfigStore) SetWithTimeout(key, value string, timeout time.Duration) error {
    deadline := time.Now().Add(timeout)
    for {
        if s.mu.TryLock() {
            defer s.mu.Unlock()
            s.values[key] = value
            return nil
        }
        if time.Now().After(deadline) {
            return fmt.Errorf("timed out waiting for write lock")
        }
        runtime.Gosched()
    }
}
```

## Part 4: sync/atomic Operations

### When Atomic Is Appropriate

Use `sync/atomic` instead of mutex when:
- You need to atomically read/write a single integer or pointer
- The operation is a simple load/store/add/compare-and-swap
- Lock overhead is measurable and significant
- Implementing lock-free data structures

Do NOT use atomic for:
- Multiple related fields that must change together (use mutex)
- Complex invariants that span multiple memory locations
- Non-trivial data structures

### Basic Atomic Operations

```go
package metrics

import (
    "sync/atomic"
)

// AtomicCounter is a thread-safe counter using atomic operations.
// Significantly faster than Mutex-based counter for high-contention increments.
type AtomicCounter struct {
    value atomic.Int64
}

func (c *AtomicCounter) Inc() {
    c.value.Add(1)
}

func (c *AtomicCounter) Add(delta int64) {
    c.value.Add(delta)
}

func (c *AtomicCounter) Load() int64 {
    return c.value.Load()
}

func (c *AtomicCounter) Store(v int64) {
    c.value.Store(v)
}

func (c *AtomicCounter) Swap(new int64) (old int64) {
    return c.value.Swap(new)
}

// AtomicFlag is a boolean flag for safe one-time state transitions.
type AtomicFlag struct {
    v atomic.Uint32
}

// Set returns true if the flag was successfully set (was previously false).
func (f *AtomicFlag) Set() bool {
    return f.v.CompareAndSwap(0, 1)
}

// IsSet returns whether the flag is currently set.
func (f *AtomicFlag) IsSet() bool {
    return f.v.Load() == 1
}

// Clear clears the flag.
func (f *AtomicFlag) Clear() {
    f.v.Store(0)
}
```

### atomic.Value for Pointer Swapping

`atomic.Value` provides atomic load/store for any type via an interface, enabling lock-free pointer swapping for immutable data structures:

```go
package config

import (
    "sync/atomic"
)

// AtomicConfig holds an atomically-swappable configuration snapshot.
// Reads are lock-free; writes atomically replace the entire config.
type AtomicConfig struct {
    v atomic.Value // stores *ConfigSnapshot
}

type ConfigSnapshot struct {
    Values   map[string]string
    Version  int64
    LoadedAt int64
}

// Load returns the current configuration snapshot.
// Safe for concurrent reads without any lock.
func (c *AtomicConfig) Load() *ConfigSnapshot {
    v := c.v.Load()
    if v == nil {
        return nil
    }
    return v.(*ConfigSnapshot)
}

// Store atomically replaces the configuration.
// The new snapshot must not be modified after calling Store.
func (c *AtomicConfig) Store(snapshot *ConfigSnapshot) {
    c.v.Store(snapshot)
}

// Usage pattern:
//
// globalConfig := &AtomicConfig{}
// globalConfig.Store(&ConfigSnapshot{Values: loadFromFile(), Version: 1})
//
// // Concurrent readers (no lock):
// cfg := globalConfig.Load()
// val := cfg.Values["db_host"]
//
// // Updater (creates new snapshot, then atomically swaps):
// newCfg := &ConfigSnapshot{
//     Values:  loadFromFile(),
//     Version: old.Version + 1,
// }
// globalConfig.Store(newCfg)
```

### Compare-And-Swap Patterns

CAS is the foundation of lock-free algorithms:

```go
package lockfree

import (
    "sync/atomic"
    "unsafe"
)

// Node is a singly-linked list node for a lock-free stack.
type Node[T any] struct {
    value T
    next  *Node[T]
}

// LockFreeStack is a thread-safe stack implemented without locks.
// Uses CAS to handle concurrent pushes and pops.
// NOTE: This implementation uses the Treiber stack algorithm.
type LockFreeStack[T any] struct {
    top atomic.Pointer[Node[T]]
}

// Push adds a value to the top of the stack.
func (s *LockFreeStack[T]) Push(val T) {
    node := &Node[T]{value: val}
    for {
        old := s.top.Load()
        node.next = old
        if s.top.CompareAndSwap(old, node) {
            return
        }
        // CAS failed: another goroutine modified top; retry
    }
}

// Pop removes and returns the top value, or false if empty.
func (s *LockFreeStack[T]) Pop() (T, bool) {
    for {
        old := s.top.Load()
        if old == nil {
            var zero T
            return zero, false
        }
        next := old.next
        if s.top.CompareAndSwap(old, next) {
            return old.value, true
        }
        // CAS failed: retry
    }
}

// NOTE: This simple Treiber stack has the ABA problem.
// For production lock-free code with pointer recycling,
// use tagged pointers or hazard pointers.
```

### The ABA Problem and Stamped References

```go
// AtomicStampedRef combines a pointer with a monotonic stamp
// to prevent ABA false-positive CAS success.
type AtomicStampedRef[T any] struct {
    // Pack pointer + stamp into a single 64-bit value
    // (only valid on 64-bit platforms where pointers are ≤48 bits)
    // For portable code, use a struct + mutex for the stamp.
    v atomic.Uint64
}

// For most production use cases, use sync.Map or a mutex-protected
// map instead of implementing lock-free data structures from scratch.
// The complexity and ABA risk rarely justify the performance gain.
```

### sync/atomic Benchmark vs Mutex

```go
func BenchmarkAtomicIncrement(b *testing.B) {
    var v atomic.Int64
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            v.Add(1)
        }
    })
}

func BenchmarkMutexIncrement(b *testing.B) {
    var mu sync.Mutex
    var v int64
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.Lock()
            v++
            mu.Unlock()
        }
    })
}
```

```
BenchmarkAtomicIncrement-8   194831062    6.1 ns/op
BenchmarkMutexIncrement-8     37894210   31.7 ns/op
```

Atomic is ~5x faster for single-value increments under high concurrency.

## Part 5: Common Data Race Patterns

### Race Pattern 1: Unsynchronized Map Access

The most common data race in Go: concurrent map reads and writes.

```go
// RACE: concurrent map read and write
type BadCache struct {
    items map[string]int
}

func (c *BadCache) Get(k string) int { return c.items[k] }    // race
func (c *BadCache) Set(k string, v int) { c.items[k] = v }   // race

// FIX: Option A — sync.Mutex
type SafeCache struct {
    mu    sync.Mutex
    items map[string]int
}

func (c *SafeCache) Get(k string) int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.items[k]
}

// FIX: Option B — sync.Map (for read-mostly, infrequent writes)
type SyncMapCache struct {
    m sync.Map
}

func (c *SyncMapCache) Get(k string) (int, bool) {
    v, ok := c.m.Load(k)
    if !ok {
        return 0, false
    }
    return v.(int), true
}

func (c *SyncMapCache) Set(k string, v int) {
    c.m.Store(k, v)
}
```

### Race Pattern 2: Goroutine Closure Capture

Classic loop variable capture race:

```go
// RACE: all goroutines share the same `i` variable
func bad() {
    for i := 0; i < 10; i++ {
        go func() {
            fmt.Println(i)  // i is shared; race with loop increment
        }()
    }
}

// FIX A: copy the variable into the goroutine
func fixA() {
    for i := 0; i < 10; i++ {
        i := i  // Shadow: each goroutine gets its own copy
        go func() {
            fmt.Println(i)
        }()
    }
}

// FIX B: pass as argument (idiomatic)
func fixB() {
    for i := 0; i < 10; i++ {
        go func(n int) {
            fmt.Println(n)
        }(i)
    }
}

// In Go 1.22+, loop variables are per-iteration (no capture race)
// but explicit is still clearest
```

### Race Pattern 3: Unsynchronized Slice Append

```go
// RACE: concurrent appends to shared slice
func fetchAll(ids []int) []Result {
    var results []Result
    var wg sync.WaitGroup
    for _, id := range ids {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            r := fetch(id)
            results = append(results, r)  // DATA RACE: unsafe concurrent append
        }(id)
    }
    wg.Wait()
    return results
}

// FIX A: pre-allocate and use index
func fetchAllSafe(ids []int) []Result {
    results := make([]Result, len(ids))
    var wg sync.WaitGroup
    for i, id := range ids {
        wg.Add(1)
        go func(i, id int) {
            defer wg.Done()
            results[i] = fetch(id)  // Safe: different index per goroutine
        }(i, id)
    }
    wg.Wait()
    return results
}

// FIX B: channel aggregation
func fetchAllChannel(ids []int) []Result {
    ch := make(chan Result, len(ids))
    var wg sync.WaitGroup
    for _, id := range ids {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            ch <- fetch(id)
        }(id)
    }
    wg.Wait()
    close(ch)
    var results []Result
    for r := range ch {
        results = append(results, r)
    }
    return results
}
```

### Race Pattern 4: Once-Initialized Struct

```go
// RACE: lazy initialization without synchronization
type Service struct {
    client *http.Client
}

func (s *Service) getClient() *http.Client {
    if s.client == nil {          // read: race
        s.client = &http.Client{} // write: race
    }
    return s.client
}

// FIX: sync.Once
type SafeService struct {
    once   sync.Once
    client *http.Client
}

func (s *SafeService) getClient() *http.Client {
    s.once.Do(func() {
        s.client = &http.Client{
            Timeout: 30 * time.Second,
        }
    })
    return s.client
}

// FIX: init in constructor (simplest)
func NewService() *Service {
    return &Service{
        client: &http.Client{Timeout: 30 * time.Second},
    }
}
```

### Race Pattern 5: Interface Nil Check

```go
// SUBTLE RACE: checking interface for nil races with assignment
var handler http.Handler  // interface

// goroutine A:
if handler != nil {
    handler.ServeHTTP(w, r)  // RACE: handler may be set by goroutine B
}

// goroutine B:
handler = newHandler()  // RACE: write races with read in goroutine A

// FIX: atomic.Value for pointer-sized interface values
var handlerAtomic atomic.Value

// goroutine B:
handlerAtomic.Store(newHandler())

// goroutine A:
if h := handlerAtomic.Load(); h != nil {
    h.(http.Handler).ServeHTTP(w, r)
}
```

### Race Pattern 6: Goroutine Leak with Shared State

```go
// RACE: goroutine outlives its context, writes to shared state after it's freed
func processWithTimeout(data []byte) (Result, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    var result Result
    done := make(chan struct{})

    go func() {
        result = expensiveProcess(data)  // RACE: writes to result
        close(done)
    }()

    select {
    case <-done:
        return result, nil
    case <-ctx.Done():
        // goroutine still running, still writing to result!
        return Result{}, ctx.Err()
    }
}

// FIX: communicate through channels, not shared variables
func processWithTimeoutSafe(data []byte) (Result, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resultCh := make(chan Result, 1)
    errCh := make(chan error, 1)

    go func() {
        r, err := expensiveProcessCtx(ctx, data)
        if err != nil {
            errCh <- err
            return
        }
        resultCh <- r
    }()

    select {
    case r := <-resultCh:
        return r, nil
    case err := <-errCh:
        return Result{}, err
    case <-ctx.Done():
        return Result{}, ctx.Err()
    }
}
```

### Race Pattern 7: Published Object Read Before Full Initialization

```go
// RACE: config published before all fields are set
var globalConfig *AppConfig

func initConfig() {
    cfg := &AppConfig{}
    cfg.DBHost = "db.example.com"
    globalConfig = cfg  // PUBLISHED HERE

    // other goroutines may see partial initialization:
    cfg.DBPort = 5432           // race: read by other goroutines
    cfg.MaxConns = 100          // race
}

// FIX: initialize fully before publishing
func initConfigSafe() {
    cfg := &AppConfig{
        DBHost:   "db.example.com",
        DBPort:   5432,
        MaxConns: 100,
    }
    // Atomic store (if using atomic.Value) or channel signal after complete init
    globalConfigAtomic.Store(cfg)
}

// Or use sync.Once for guaranteed single initialization
var (
    configOnce sync.Once
    globalCfg  *AppConfig
)

func getConfig() *AppConfig {
    configOnce.Do(func() {
        globalCfg = &AppConfig{
            DBHost:   "db.example.com",
            DBPort:   5432,
            MaxConns: 100,
        }
    })
    return globalCfg
}
```

## Part 6: Choosing the Right Synchronization Primitive

### Decision Framework

```
Need to protect shared state?
├── Single integer/bool/pointer?
│   └── Use sync/atomic (atomic.Int64, atomic.Bool, atomic.Pointer)
│
├── Multiple related fields (must change together)?
│   ├── Reads dominate writes (>90% reads)?
│   │   └── Use sync.RWMutex
│   └── Mixed read/write or unsure?
│       └── Use sync.Mutex
│
├── Key-value map with concurrent access?
│   ├── Many writes?
│   │   └── Use sync.Mutex + map
│   └── Write-once, read-many (e.g., registry)?
│       └── Use sync.Map
│
├── One-time initialization?
│   └── Use sync.Once
│
├── Communicating between goroutines?
│   └── Use channels (prefer over shared memory)
│
└── Large struct, read-mostly, atomic swap?
    └── Use atomic.Value (copy-on-write pattern)
```

### Benchmark Suite for Decision Making

```go
package sync_test

import (
    "sync"
    "sync/atomic"
    "testing"
)

// Run with: go test -bench=. -benchmem -cpu=1,4,8

var (
    globalMu     sync.Mutex
    globalRWMu   sync.RWMutex
    globalAtomic atomic.Int64
    globalSyncMap sync.Map
    globalVal    int64
)

// Scenario: high-read, occasional write (80% read, 20% write)
// At 4 goroutines with 80/20 read-write mix:
// Mutex:    ~45ns/op
// RWMutex:  ~18ns/op
// Atomic:   ~8ns/op (only works for single value)
```

## Summary

Go's memory safety tooling provides a complete stack for building correct concurrent programs:

1. **The race detector** (`-race`) catches data races at runtime with precise diagnostics. Run it in CI on every PR—the performance cost is acceptable in test environments.

2. **`sync.Mutex`** protects shared state with exclusive access. Use `defer Unlock()` always, avoid embedding in exported types, and establish consistent lock ordering to prevent deadlocks.

3. **`sync.RWMutex`** improves throughput for read-heavy workloads by allowing concurrent readers. Profile before switching from `Mutex`—the additional complexity is only justified when reads genuinely dominate.

4. **`sync/atomic`** provides the fastest synchronization for single-value operations. The `atomic.Int64`, `atomic.Bool`, `atomic.Pointer`, and `atomic.Value` types cover the majority of lock-free use cases without implementing custom CAS loops.

5. **Common race patterns**—map access, loop captures, slice appends, lazy initialization—recur across codebases. Knowing them by name enables faster code review and triage.

The correct approach is almost always: write correct code first using mutexes, profile under realistic load, then selectively optimize with atomics where benchmarks justify it.
