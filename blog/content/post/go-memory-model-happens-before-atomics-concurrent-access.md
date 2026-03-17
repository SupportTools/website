---
title: "Go Memory Model: Happens-Before, Atomics, and Safe Concurrent Access"
date: 2029-06-28T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Memory Model", "Atomics", "sync/atomic", "Race Conditions"]
categories: ["Go", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into the Go memory model specification, sync/atomic operations, race-free patterns, channel happens-before guarantees, and memory barriers for safe concurrent programs."
more_link: "yes"
url: "/go-memory-model-happens-before-atomics-concurrent-access/"
---

The Go memory model defines when reads of a variable in one goroutine can be guaranteed to observe values produced by writes in another goroutine. Getting this wrong produces programs that are correct under your development workload but silently corrupt data in production under concurrency pressure. This post dissects the formal specification, explains every happens-before guarantee the runtime provides, and shows how to write race-free code without sacrificing performance.

<!--more-->

# Go Memory Model: Happens-Before, Atomics, and Safe Concurrent Access

## Why the Memory Model Matters in Practice

Modern CPUs and compilers reorder memory operations for performance. A write you issued first in program order may not be visible to another CPU core before a subsequent write. The Go memory model is a contract between you, the compiler, and the hardware that specifies exactly which reorderings are permissible and which observations are guaranteed.

Ignoring this contract leads to:

- Stale reads of shared variables even after a "write has happened"
- Torn reads of 64-bit values on 32-bit architectures
- Initialization races where one goroutine reads a partially-constructed object
- Data races detected by the race detector that your tests never triggered

The memory model was formally revised in Go 1.19 to be more precise and to align with the updated specification that disallowed "out of thin air" values.

## Section 1: The Happens-Before Relation

Happens-before is a partial order over memory operations. If operation A happens-before operation B, then B is guaranteed to observe every effect of A and all operations that happened-before A.

### Within a Single Goroutine

All operations within a single goroutine are totally ordered. If statement S1 precedes S2 in program text, S1 happens-before S2.

```go
// Within one goroutine, this is safe - initialization always visible before use
x := 0
x = 42
fmt.Println(x) // guaranteed to print 42
```

### Goroutine Creation

The `go` statement that starts a new goroutine happens-before the goroutine body begins executing. However, the goroutine start does not happen-before the return of the `go` statement in the calling goroutine.

```go
var prepared bool

func setup() {
    prepared = true // write
}

func main() {
    setup()
    go func() {
        // The write to 'prepared' in setup() happens-before this goroutine starts
        // because: setup() hb main() sequence hb go statement hb goroutine body
        if prepared { // safe read
            fmt.Println("ready")
        }
    }()
}
```

### Goroutine Exit

The exit of a goroutine is NOT guaranteed to happen-before any event in any other goroutine unless synchronized explicitly. This is a common mistake:

```go
// WRONG - data race
var result int

go func() {
    result = expensiveComputation()
}()

time.Sleep(time.Second) // does NOT create happens-before
fmt.Println(result)     // data race! sleep is not synchronization
```

The correct pattern requires explicit synchronization:

```go
// CORRECT - channel synchronization
var result int
done := make(chan struct{})

go func() {
    result = expensiveComputation()
    close(done) // send on channel hb receive from channel
}()

<-done
fmt.Println(result) // safe: goroutine exit hb channel close hb channel receive
```

## Section 2: Channel Happens-Before Guarantees

Channels are the primary synchronization primitive in Go, and the memory model gives them precise guarantees.

### Unbuffered Channels

For an unbuffered channel, the send happens-before the corresponding receive completes.

```go
var data [1024]byte

ch := make(chan struct{}) // unbuffered

go func() {
    initData(&data)      // write
    ch <- struct{}{}     // send hb receive completion
}()

<-ch                     // receive completion hb everything after
processData(&data)       // safe: sees initialized data
```

This is symmetric: the receive from an unbuffered channel happens-before the send on that channel completes. Both ends synchronize.

### Buffered Channels

For a buffered channel with capacity C, the k-th receive from the channel happens-before the (k+C)-th send completes. This is the rule that makes buffered channels usable as counting semaphores:

```go
// Semaphore pattern: limit concurrency to 'limit' goroutines
func makeSemaphore(limit int) chan struct{} {
    return make(chan struct{}, limit)
}

func withSemaphore(sem chan struct{}, fn func()) {
    sem <- struct{}{}  // acquire: blocks if limit reached
    defer func() { <-sem }()
    fn()
}
```

The key insight: with a buffered channel of capacity C, the (k+C)-th send blocks until the k-th receive has occurred. This means the k-th receive happens-before the (k+C)-th send's completion, establishing a happens-before edge.

### Channel Closing

Closing a channel happens-before a receive that returns a zero value due to the channel being closed.

```go
type WorkItem struct{ ID int }

func producer(items []WorkItem, ch chan<- WorkItem) {
    for _, item := range items {
        ch <- item
    }
    close(ch) // close hb zero-value receives
}

func consumer(ch <-chan WorkItem) {
    for item := range ch {
        // range over channel receives until close
        process(item)
    }
    // here, all producer writes are visible
}
```

## Section 3: sync Package Synchronization

### sync.Mutex

The n-th call to `Unlock` on a mutex happens-before the (n+1)-th call to `Lock` returns.

```go
var mu sync.Mutex
var shared int

// Goroutine A
mu.Lock()
shared = 100 // write inside critical section
mu.Unlock()  // Unlock hb next Lock return

// Goroutine B (concurrent)
mu.Lock()    // Lock return hb everything after
val := shared // guaranteed to see 100 if B's lock follows A's unlock
mu.Unlock()
```

### sync.Once

The completion of the first call to `f` passed to `once.Do(f)` happens-before any `once.Do` call returns. This is the foundation of safe lazy initialization:

```go
type Config struct {
    DatabaseURL string
    MaxConns    int
}

var (
    configOnce sync.Once
    config     *Config
)

func GetConfig() *Config {
    configOnce.Do(func() {
        config = &Config{
            DatabaseURL: os.Getenv("DATABASE_URL"),
            MaxConns:    50,
        }
    })
    return config // safe: once.Do completion hb return
}
```

### sync.WaitGroup

`WaitGroup.Done` (which decrements the counter) happens-before `WaitGroup.Wait` returns when the counter reaches zero.

```go
func parallelProcess(items []Item) []Result {
    results := make([]Result, len(items))
    var wg sync.WaitGroup

    for i, item := range items {
        wg.Add(1)
        go func(idx int, it Item) {
            defer wg.Done()
            results[idx] = process(it) // write
        }(i, item)
    }

    wg.Wait() // all Done() calls hb this return
    return results // safe to read all results
}
```

### sync.RWMutex

`RWMutex` provides additional guarantees:
- `RUnlock` happens-before any `Lock` that is unblocked by it
- `Unlock` happens-before `RLock` or `Lock` that is unblocked by it

```go
var (
    rwmu  sync.RWMutex
    cache map[string]string
)

func readCache(key string) (string, bool) {
    rwmu.RLock()
    defer rwmu.RUnlock()
    v, ok := cache[key]
    return v, ok
}

func writeCache(key, val string) {
    rwmu.Lock()
    defer rwmu.Unlock()
    cache[key] = val
}
```

## Section 4: sync/atomic Operations

The `sync/atomic` package provides low-level atomic memory operations that establish happens-before relationships through sequentially consistent ordering.

### The Formal Guarantee (Go 1.19+)

Go 1.19 formalized that atomic operations synchronize with each other in a sequentially consistent manner. An atomic store to variable X synchronizes with any atomic load of X that observes the stored value.

```go
package main

import (
    "fmt"
    "sync/atomic"
)

var (
    flag  atomic.Bool
    value int
)

func writer() {
    value = 42               // write value
    flag.Store(true)         // atomic store synchronizes-with load that sees true
}

func reader() {
    for !flag.Load() {       // spin until flag is true
        // busy wait
    }
    // flag.Load() returned true, which means it synchronized with
    // the Store(true) in writer, which happened after value = 42
    fmt.Println(value)       // safe: prints 42
}
```

### atomic.Value for Pointer-Sized Objects

`atomic.Value` allows storing and loading arbitrary values atomically:

```go
type RouteTable struct {
    routes map[string]string
    version int
}

var currentRoutes atomic.Value

func updateRoutes(newTable *RouteTable) {
    currentRoutes.Store(newTable)
}

func lookupRoute(dest string) string {
    table := currentRoutes.Load().(*RouteTable)
    return table.routes[dest]
}
```

The constraint: the concrete type stored must not change between calls. Store and Load are each sequentially consistent.

### Atomic Integers for Counters and Flags

```go
package main

import (
    "fmt"
    "sync/atomic"
    "time"
)

type RateLimiter struct {
    count    atomic.Int64
    resetAt  atomic.Int64
    limit    int64
}

func NewRateLimiter(limit int64, window time.Duration) *RateLimiter {
    rl := &RateLimiter{limit: limit}
    rl.resetAt.Store(time.Now().Add(window).UnixNano())
    return rl
}

func (rl *RateLimiter) Allow() bool {
    now := time.Now().UnixNano()
    resetAt := rl.resetAt.Load()

    if now > resetAt {
        // Try to be the goroutine that resets the window
        if rl.resetAt.CompareAndSwap(resetAt, now+int64(time.Second)) {
            rl.count.Store(0)
        }
    }

    newCount := rl.count.Add(1)
    return newCount <= rl.limit
}
```

### Compare-and-Swap Patterns

CAS is the foundation of lock-free data structures. The pattern: load, compute new value, CAS — retry if CAS fails.

```go
// Lock-free stack using CAS
type node[T any] struct {
    val  T
    next atomic.Pointer[node[T]]
}

type LockFreeStack[T any] struct {
    head atomic.Pointer[node[T]]
}

func (s *LockFreeStack[T]) Push(val T) {
    n := &node[T]{val: val}
    for {
        old := s.head.Load()
        n.next.Store(old)
        if s.head.CompareAndSwap(old, n) {
            return
        }
        // CAS failed: another goroutine modified head, retry
    }
}

func (s *LockFreeStack[T]) Pop() (T, bool) {
    for {
        old := s.head.Load()
        if old == nil {
            var zero T
            return zero, false
        }
        next := old.next.Load()
        if s.head.CompareAndSwap(old, next) {
            return old.val, true
        }
    }
}
```

## Section 5: Memory Barriers and Hardware Reordering

Understanding why these primitives work requires a brief look at hardware memory models.

### CPU Reordering Categories

Modern CPUs perform four types of reordering (using Intel TSO and ARM/POWER distinctions):

| Reordering Type | Intel x86 | ARM/POWER |
|----------------|-----------|-----------|
| Load-Load      | No        | Yes       |
| Load-Store     | No        | Yes       |
| Store-Load     | Yes       | Yes       |
| Store-Store    | No        | Yes       |

On x86, only store-load reordering occurs, which is why racy code often appears to work on Intel machines but fails on ARM. This is why testing on ARM (including Apple Silicon) catches more races.

### How Atomic Operations Insert Barriers

```go
// On ARM, atomic.Store compiles to something equivalent to:
// STLR (Store-Release) instruction
// which prevents all earlier stores from being reordered after it

// atomic.Load compiles to:
// LDAR (Load-Acquire) instruction
// which prevents all later loads from being reordered before it

// Together, Store(Release) + Load(Acquire) = full sequential consistency
// for the synchronized pair
```

You should never manually insert memory barriers in Go. The sync/atomic package and sync primitives handle this correctly for all supported architectures. Manual barrier insertion (using `//go:nosplit` tricks or unsafe) bypasses the Go memory model entirely.

## Section 6: Race-Free Patterns

### The Immutable-After-Init Pattern

Data written before a goroutine is started is visible to that goroutine without additional synchronization:

```go
type Server struct {
    // These fields are written once before Start() is called
    // and never written again. They can be read from any goroutine
    // safely after Start() returns.
    addr    string
    handler http.Handler
    timeout time.Duration

    // These fields are accessed concurrently and need protection
    mu      sync.Mutex
    conns   map[net.Conn]struct{}
}

func NewServer(addr string, handler http.Handler) *Server {
    return &Server{
        addr:    addr,    // written at construction
        handler: handler, // written at construction
        timeout: 30 * time.Second,
        conns:   make(map[net.Conn]struct{}),
    }
}

func (s *Server) Start() error {
    // addr, handler, timeout are safe to read from the goroutine below
    // because the go statement happens-after NewServer() and the caller's
    // initialization of this Server.
    go s.acceptLoop()
    return nil
}

func (s *Server) acceptLoop() {
    // s.addr safe to read (immutable after init)
    ln, _ := net.Listen("tcp", s.addr)
    for {
        conn, _ := ln.Accept()
        s.mu.Lock()
        s.conns[conn] = struct{}{}
        s.mu.Unlock()
    }
}
```

### The Copy-on-Write Pattern

For read-heavy workloads where writes are infrequent, copy-on-write avoids lock contention:

```go
type COWMap[K comparable, V any] struct {
    mu      sync.Mutex
    current atomic.Pointer[map[K]V]
}

func NewCOWMap[K comparable, V any]() *COWMap[K, V] {
    m := &COWMap[K, V]{}
    empty := make(map[K]V)
    m.current.Store(&empty)
    return m
}

func (m *COWMap[K, V]) Get(key K) (V, bool) {
    // Lock-free read path
    current := *m.current.Load()
    v, ok := current[key]
    return v, ok
}

func (m *COWMap[K, V]) Set(key K, val V) {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Copy current map
    old := *m.current.Load()
    newMap := make(map[K]V, len(old)+1)
    for k, v := range old {
        newMap[k] = v
    }
    newMap[key] = val

    // Atomically publish new map
    m.current.Store(&newMap)
}
```

### The Done Channel Pattern

Using a closed channel to broadcast a signal to multiple goroutines:

```go
type Supervisor struct {
    done chan struct{}
    wg   sync.WaitGroup
}

func NewSupervisor() *Supervisor {
    return &Supervisor{done: make(chan struct{})}
}

func (s *Supervisor) StartWorker(name string, fn func(done <-chan struct{})) {
    s.wg.Add(1)
    go func() {
        defer s.wg.Done()
        fn(s.done)
    }()
}

func (s *Supervisor) Shutdown() {
    close(s.done) // broadcast to all workers
    s.wg.Wait()   // wait for all workers to finish
}

// Worker usage
func myWorker(done <-chan struct{}) {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-done:
            return
        case t := <-ticker.C:
            doWork(t)
        }
    }
}
```

## Section 7: Common Race Conditions and How to Detect Them

### Closure Variable Capture

```go
// WRONG: all goroutines capture the same 'i' variable
for i := 0; i < 10; i++ {
    go func() {
        fmt.Println(i) // data race on i
    }()
}

// CORRECT: pass as argument (copies the value)
for i := 0; i < 10; i++ {
    go func(i int) {
        fmt.Println(i)
    }(i)
}

// ALSO CORRECT: introduce a local variable (since Go 1.22, loop variables
// have per-iteration scope, but explicit copy is still clearest)
for i := 0; i < 10; i++ {
    i := i // new variable per iteration (pre-1.22 idiom)
    go func() {
        fmt.Println(i)
    }()
}
```

### Map Concurrent Access

```go
// WRONG: concurrent map read/write
var m = map[string]int{}

go func() { m["a"] = 1 }()
go func() { _ = m["a"] }() // fatal: concurrent map read and map write

// CORRECT: use sync.Map for concurrent access
var sm sync.Map

go func() { sm.Store("a", 1) }()
go func() {
    if v, ok := sm.Load("a"); ok {
        fmt.Println(v)
    }
}()

// ALSO CORRECT: use RWMutex
var (
    mu sync.RWMutex
    m2 = map[string]int{}
)

go func() {
    mu.Lock()
    m2["a"] = 1
    mu.Unlock()
}()
go func() {
    mu.RLock()
    _ = m2["a"]
    mu.RUnlock()
}()
```

### Running the Race Detector

```bash
# Run tests with race detection
go test -race ./...

# Run a binary with race detection
go run -race main.go

# Build a race-detecting binary for production canary
go build -race -o server-race ./cmd/server

# Enable race detector for specific test
go test -race -run TestConcurrentAccess ./pkg/cache/
```

The race detector has roughly 5-10x runtime overhead and 5-10x memory overhead. It is appropriate for CI and canary environments, not for all production traffic. However, running the race detector on a representative subset of production traffic is a powerful technique for catching races that tests miss.

### Identifying Races with go vet

```bash
# go vet catches some but not all races
go vet ./...

# staticcheck has additional concurrency checks
staticcheck ./...

# Check for sync.Mutex copied by value (common mistake)
# go vet catches this
```

## Section 8: The sync/atomic Types in Go 1.19+

Go 1.19 introduced typed atomic types in `sync/atomic` to replace the function-based API for common cases:

```go
import "sync/atomic"

// Typed atomic integers (avoids unsafe pointer casting)
var counter atomic.Int64
counter.Add(1)
counter.Store(0)
n := counter.Load()
swapped := counter.CompareAndSwap(0, 100)

// Atomic booleans
var initialized atomic.Bool
initialized.Store(true)
if initialized.Load() { ... }

// Atomic pointers (type-safe, no interface boxing)
type Config struct { MaxWorkers int }
var cfg atomic.Pointer[Config]

cfg.Store(&Config{MaxWorkers: 8})
c := cfg.Load() // *Config, not interface{}

// Atomic uint32 for bit flags
var flags atomic.Uint32
flags.Or(0x01)   // Go 1.23+ Or/And methods
flags.And(^uint32(0x01))
```

## Section 9: Practical Checklist for Concurrent Code

Before submitting any code that shares state between goroutines, verify:

1. **Every shared variable** is protected by a mutex, accessed only through channels, declared as a typed atomic, or provably written before any goroutine is started and never written again.

2. **No mutex copies**: `sync.Mutex`, `sync.RWMutex`, `sync.WaitGroup`, `sync.Cond` must never be copied after first use. Pass pointers.

3. **Channel directions**: Use `chan<- T` and `<-chan T` in function signatures to document and enforce direction.

4. **Close semantics**: Only the sender closes a channel. Multiple senders require a separate coordination mechanism.

5. **Context propagation**: Use `context.Context` for cancellation rather than manual done channels in library code.

6. **Race detector in CI**: Every CI pipeline should run `go test -race ./...`.

7. **Benchmark with GOMAXPROCS**: Set `GOMAXPROCS` to at least `runtime.NumCPU()` when benchmarking concurrent code. Single-threaded benchmarks hide races and contention.

```go
// Example: safe concurrent counter using all discussed techniques
type Counter struct {
    n atomic.Int64
}

func (c *Counter) Inc() {
    c.n.Add(1)
}

func (c *Counter) Dec() {
    c.n.Add(-1)
}

func (c *Counter) Value() int64 {
    return c.n.Load()
}

func (c *Counter) Reset() int64 {
    return c.n.Swap(0)
}
```

## Section 10: Advanced Pattern — singleflight for Deduplicating Concurrent Requests

The `golang.org/x/sync/singleflight` package is an excellent example of the Go memory model in action:

```go
import "golang.org/x/sync/singleflight"

type CachingClient struct {
    sf    singleflight.Group
    cache sync.Map
    db    Database
}

func (c *CachingClient) Get(ctx context.Context, key string) (string, error) {
    // Check cache first (lock-free read)
    if v, ok := c.cache.Load(key); ok {
        return v.(string), nil
    }

    // Deduplicate concurrent fetches for the same key
    // Only one goroutine calls the database; others wait and share the result
    val, err, _ := c.sf.Do(key, func() (interface{}, error) {
        v, err := c.db.Get(ctx, key)
        if err != nil {
            return nil, err
        }
        c.cache.Store(key, v)
        return v, nil
    })

    if err != nil {
        return "", err
    }
    return val.(string), nil
}
```

The `singleflight.Do` call ensures that the write to the cache happens-before all waiting goroutines receive the result, because the result is delivered through the group's internal synchronization.

## Conclusion

The Go memory model is not academic — it directly determines whether your concurrent programs are correct. The key takeaways:

- Happens-before relationships are established by channel operations, mutex lock/unlock sequences, sync.Once, WaitGroup, and atomic operations
- Spin-loops, sleep, and runtime.Gosched do NOT establish happens-before
- The race detector is your most powerful tool; use it in CI always
- Prefer channels and sync primitives over raw atomics for complex coordination
- Reserve sync/atomic for leaf-level operations: counters, flags, and lock-free pointer swaps
- Test on ARM (or use GOMAXPROCS > 1) because x86's strong TSO memory model hides races that appear on weaker architectures

The updated Go 1.19 memory model documentation at golang.org/ref/mem is the authoritative source. When in doubt about whether a pattern is safe, add it to a test with `-race` and run it with high goroutine counts and tight loops. If the race detector stays silent across thousands of iterations, you likely have the synchronization right.
