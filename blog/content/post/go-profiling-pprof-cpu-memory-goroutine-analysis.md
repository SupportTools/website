---
title: "Go Profiling with pprof: CPU, Memory, and Goroutine Analysis"
date: 2029-04-03T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "pprof", "Profiling", "Performance", "Memory", "Goroutines"]
categories: ["Go", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go profiling with pprof: HTTP endpoints, go tool pprof, heap profiling, CPU profiling, goroutine dumps, blocking profiles, and mutex contention analysis for production Go services."
more_link: "yes"
url: "/go-profiling-pprof-cpu-memory-goroutine-analysis/"
---

Performance regressions in production Go services often manifest subtly: p99 latency creeping up, memory growth that only surfaces under sustained load, goroutine counts that grow without bound. The `pprof` profiling tools built into the Go standard library are the authoritative way to diagnose these problems. Unlike system-level profilers, pprof understands Go's runtime: goroutine scheduling, garbage collection overhead, channel blocking, and heap allocations.

<!--more-->

# Go Profiling with pprof: CPU, Memory, and Goroutine Analysis

## Section 1: Enabling pprof HTTP Endpoints

The simplest way to expose pprof is via the `net/http/pprof` package's side-effect import:

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof"  // Side effect: registers pprof handlers
)

func main() {
    // Start pprof on a separate port from the main server
    // NEVER expose pprof on a public-facing port
    go func() {
        log.Println("pprof listening on :6060")
        log.Fatal(http.ListenAndServe("localhost:6060", nil))
    }()

    // Main server
    http.HandleFunc("/", myHandler)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

The `_ "net/http/pprof"` import registers these endpoints on `http.DefaultServeMux`:

```
/debug/pprof/              - Index page listing all profiles
/debug/pprof/cmdline       - Command line invocation
/debug/pprof/profile       - CPU profile (30s by default)
/debug/pprof/symbol        - Symbol lookup
/debug/pprof/trace         - Execution trace
/debug/pprof/goroutine     - Stack traces of all goroutines
/debug/pprof/heap          - Heap allocation profile
/debug/pprof/threadcreate  - Thread creation stack traces
/debug/pprof/block         - Block/contention profile
/debug/pprof/mutex         - Mutex contention profile
/debug/pprof/allocs        - Memory allocation profile
```

### Using a Custom ServeMux

If your application uses a custom HTTP mux rather than `http.DefaultServeMux`, register pprof handlers explicitly:

```go
package main

import (
    "log"
    "net/http"
    "net/http/pprof"
)

func setupPprofRoutes(mux *http.ServeMux) {
    mux.HandleFunc("/debug/pprof/", pprof.Index)
    mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
}

func main() {
    debugMux := http.NewServeMux()
    setupPprofRoutes(debugMux)

    // Debug server on internal address only
    go func() {
        log.Fatal(http.ListenAndServe("127.0.0.1:6060", debugMux))
    }()

    mainMux := http.NewServeMux()
    mainMux.HandleFunc("/", myHandler)
    log.Fatal(http.ListenAndServe(":8080", mainMux))
}
```

### Securing pprof in Production

```go
package main

import (
    "net/http"
    "net/http/pprof"
    "os"
)

func setupSecurePprof(mux *http.ServeMux) {
    // Authentication middleware
    authMiddleware := func(next http.HandlerFunc) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
            token := r.Header.Get("X-Pprof-Token")
            expected := os.Getenv("PPROF_AUTH_TOKEN")

            if expected == "" || token != expected {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }
            next(w, r)
        }
    }

    mux.HandleFunc("/debug/pprof/", authMiddleware(pprof.Index))
    mux.HandleFunc("/debug/pprof/cmdline", authMiddleware(pprof.Cmdline))
    mux.HandleFunc("/debug/pprof/profile", authMiddleware(pprof.Profile))
    mux.HandleFunc("/debug/pprof/symbol", authMiddleware(pprof.Symbol))
    mux.HandleFunc("/debug/pprof/trace", authMiddleware(pprof.Trace))
}
```

## Section 2: go tool pprof Interactive Analysis

### CPU Profiling

```bash
# Collect 30-second CPU profile
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Or save to file first
curl -o cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30
go tool pprof cpu.prof

# Interactive session commands:
(pprof) top              # Top functions by cumulative time
(pprof) top10 -cum       # Top 10 by cumulative (including callees)
(pprof) top20 -flat      # Top 20 by flat (own time only)
(pprof) list myFunc      # Annotated source for myFunc
(pprof) web              # Open flame graph in browser (requires graphviz)
(pprof) weblist myFunc   # Source annotated with hotspot highlighting
(pprof) disasm myFunc    # Assembly for myFunc
(pprof) traces myFunc    # Show call traces containing myFunc
(pprof) callgrind        # Export in callgrind format

# Focus on specific packages
(pprof) focus=mypackage top
(pprof) ignore=runtime top

# Generate flame graph SVG directly
go tool pprof -http=:8080 cpu.prof
# Opens browser with interactive flame graph
```

### Reading pprof top Output

```
Showing nodes accounting for 2340ms, 78.26% of 2991ms total
Dropped 87 nodes (cum <= 14.96ms)

      flat  flat%   sum%        cum   cum%
     620ms 20.73% 20.73%      620ms 20.73%  runtime.mallocgc
     480ms 16.05% 36.78%      960ms 32.10%  myapp/db.(*QueryExecutor).Execute
     310ms 10.36% 47.14%     1240ms 41.46%  encoding/json.Marshal
     ...
```

- **flat**: Time this function spent on CPU directly (not in callees)
- **flat%**: flat as a percentage of total
- **cum**: Cumulative time including all functions called by this one
- **cum%**: cum as a percentage of total

A function with high `cum` but low `flat` is a call dispatcher. A function with high `flat` is doing real work.

## Section 3: Heap Profiling

```bash
# Current heap profile (in-use allocations)
go tool pprof http://localhost:6060/debug/pprof/heap

# Or save and analyze offline
curl -o heap.prof http://localhost:6060/debug/pprof/heap
go tool pprof heap.prof

# Key pprof commands for heap:
(pprof) top             # Top allocators by inuse_space
(pprof) top -alloc_space    # Sort by total allocated (not just current)
(pprof) top -alloc_objects  # Sort by number of allocations

# View all allocations profile (cumulative since start)
curl -o allocs.prof http://localhost:6060/debug/pprof/allocs
go tool pprof allocs.prof

# View heap with inuse_objects (not space)
go tool pprof -inuse_objects heap.prof
```

### Common Heap Analysis Commands

```bash
# In pprof interactive session for heap:

# Show functions allocating the most memory currently in use
(pprof) top -inuse_space

# Show functions that allocated the most total memory
(pprof) top -alloc_space

# Show where time.Time objects are being created
(pprof) list time.Now

# Focus on your application code only
(pprof) focus=myapp top

# Tree view showing allocation callsite hierarchy
(pprof) tree

# Find all allocations from a specific line
(pprof) weblist mypackage.MyFunction
```

### Programmatic Heap Profiling

```go
package profiling

import (
    "os"
    "runtime"
    "runtime/pprof"
    "time"
)

// WriteHeapProfile captures a heap profile to a file.
// Call before and after a suspected memory leak to compare.
func WriteHeapProfile(filename string) error {
    // Force GC so we see live objects, not GC garbage
    runtime.GC()
    runtime.GC() // Second GC to finalize objects from first GC

    f, err := os.Create(filename)
    if err != nil {
        return err
    }
    defer f.Close()

    return pprof.WriteHeapProfile(f)
}

// MemoryStats returns current heap statistics.
func MemoryStats() runtime.MemStats {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)
    return ms
}

// LogMemoryStats logs key memory statistics.
func LogMemoryStats(label string) {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)

    log.Printf("[%s] Memory Stats:", label)
    log.Printf("  HeapAlloc: %d KB (currently allocated)", ms.HeapAlloc/1024)
    log.Printf("  HeapSys: %d KB (obtained from OS)", ms.HeapSys/1024)
    log.Printf("  HeapInuse: %d KB (in use by Go)", ms.HeapInuse/1024)
    log.Printf("  HeapIdle: %d KB (idle spans)", ms.HeapIdle/1024)
    log.Printf("  HeapReleased: %d KB (returned to OS)", ms.HeapReleased/1024)
    log.Printf("  HeapObjects: %d (live objects)", ms.HeapObjects)
    log.Printf("  StackInuse: %d KB", ms.StackInuse/1024)
    log.Printf("  NumGC: %d", ms.NumGC)
    log.Printf("  GCSys: %d KB (GC metadata)", ms.GCSys/1024)
    log.Printf("  PauseTotalNs: %d ms", ms.PauseTotalNs/1e6)
}
```

## Section 4: CPU Profiling in Production Code

### Manual CPU Profile Capture

```go
package profiling

import (
    "os"
    "runtime/pprof"
)

// CPUProfiler captures CPU profiles programmatically.
type CPUProfiler struct {
    file *os.File
}

// Start begins CPU profiling, writing to the given filename.
func (p *CPUProfiler) Start(filename string) error {
    f, err := os.Create(filename)
    if err != nil {
        return fmt.Errorf("creating CPU profile file: %w", err)
    }
    p.file = f

    if err := pprof.StartCPUProfile(f); err != nil {
        f.Close()
        return fmt.Errorf("starting CPU profile: %w", err)
    }
    return nil
}

// Stop ends CPU profiling and closes the file.
func (p *CPUProfiler) Stop() {
    pprof.StopCPUProfile()
    if p.file != nil {
        p.file.Close()
        p.file = nil
    }
}

// ProfileForDuration captures a CPU profile for a specific duration.
func ProfileForDuration(filename string, duration time.Duration) error {
    p := &CPUProfiler{}
    if err := p.Start(filename); err != nil {
        return err
    }
    time.Sleep(duration)
    p.Stop()
    return nil
}

// ProfileRequest wraps a handler and captures a CPU profile for the request.
func ProfileRequest(filename string, fn func()) error {
    p := &CPUProfiler{}
    if err := p.Start(filename); err != nil {
        return err
    }
    defer p.Stop()
    fn()
    return nil
}
```

### Benchmark-Based Profiling

```go
// my_package_test.go
package mypackage

import (
    "os"
    "runtime/pprof"
    "testing"
)

func BenchmarkProcessOrder(b *testing.B) {
    order := generateTestOrder()

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        processOrder(order)
    }
}

// Run with:
// go test -bench=BenchmarkProcessOrder -cpuprofile=cpu.prof -memprofile=mem.prof
// go tool pprof cpu.prof
// go tool pprof mem.prof

func TestProfilingIntegration(t *testing.T) {
    // Capture CPU profile during a specific operation
    cpuFile, _ := os.Create("/tmp/test-cpu.prof")
    defer cpuFile.Close()
    pprof.StartCPUProfile(cpuFile)
    defer pprof.StopCPUProfile()

    // Run the operation under profile
    for i := 0; i < 1000; i++ {
        expensiveOperation()
    }
}
```

## Section 5: Goroutine Analysis

Goroutine leaks are a common source of memory growth and eventual service failure. The goroutine profile shows all running goroutines with their stack traces.

### Collecting Goroutine Dumps

```bash
# Get goroutine dump (all goroutines)
curl http://localhost:6060/debug/pprof/goroutine?debug=2

# Summary: goroutine count by stack trace
curl http://localhost:6060/debug/pprof/goroutine?debug=1

# Machine-readable pprof format
go tool pprof http://localhost:6060/debug/pprof/goroutine
(pprof) top         # Most frequent goroutine stack traces
(pprof) traces      # Full stack traces grouped by root
(pprof) list myFunc # Which goroutines are in myFunc
```

### Reading Goroutine Dumps

```
goroutine 1234 [chan receive, 10 minutes]:
main.(*Worker).processQueue(0xc000123456)
    /app/worker.go:145 +0x8e
created by main.NewWorker
    /app/worker.go:89 +0x1a4

goroutine 1235 [chan receive, 10 minutes]:
main.(*Worker).processQueue(0xc000234567)
    /app/worker.go:145 +0x8e
created by main.NewWorker
    /app/worker.go:89 +0x1a4
```

The `chan receive, 10 minutes` indicates these goroutines have been waiting on a channel receive for 10 minutes. This strongly suggests a goroutine leak.

### Detecting Goroutine Leaks in Tests

```go
package mypackage_test

import (
    "testing"
    "time"

    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

func TestWorkerNoLeak(t *testing.T) {
    // goleak detects goroutine leaks in individual tests
    defer goleak.VerifyNone(t)

    worker := NewWorker()
    worker.Start()

    // Do work...
    time.Sleep(100 * time.Millisecond)

    // This must stop all goroutines the worker started
    worker.Stop()
}
```

### Programmatic Goroutine Monitoring

```go
package monitoring

import (
    "runtime"
    "time"
)

// GoroutineMonitor tracks goroutine count over time.
type GoroutineMonitor struct {
    baseline    int
    ticker      *time.Ticker
    done        chan struct{}
    alertFunc   func(count int)
    threshold   int
}

func NewGoroutineMonitor(checkInterval time.Duration, threshold int,
    alertFn func(int)) *GoroutineMonitor {
    return &GoroutineMonitor{
        baseline:  runtime.NumGoroutine(),
        ticker:    time.NewTicker(checkInterval),
        done:      make(chan struct{}),
        alertFunc: alertFn,
        threshold: threshold,
    }
}

func (m *GoroutineMonitor) Start() {
    go func() {
        for {
            select {
            case <-m.ticker.C:
                current := runtime.NumGoroutine()
                if current > m.baseline+m.threshold {
                    m.alertFunc(current)
                    // Capture goroutine dump for debugging
                    m.dumpGoroutines()
                }
            case <-m.done:
                return
            }
        }
    }()
}

func (m *GoroutineMonitor) dumpGoroutines() {
    buf := make([]byte, 1<<20) // 1MB buffer
    n := runtime.Stack(buf, true) // all=true for all goroutines

    filename := fmt.Sprintf("/tmp/goroutine-dump-%s.txt",
        time.Now().Format("20060102-150405"))

    os.WriteFile(filename, buf[:n], 0644)
    log.Printf("Goroutine dump written to %s", filename)
}

func (m *GoroutineMonitor) Stop() {
    m.ticker.Stop()
    close(m.done)
}
```

## Section 6: Blocking Profile

The blocking profile shows where goroutines spend time blocked on synchronization primitives (channels, mutexes, semaphores). It does NOT include time blocked on system calls or network I/O.

```go
// Enable blocking profile - must be done before the contention occurs
// rate = 1 means sample every blocking event (high overhead)
// rate = N means sample approximately 1/N events
runtime.SetBlockProfileRate(1)
```

```bash
# Collect blocking profile
go tool pprof http://localhost:6060/debug/pprof/block

# In pprof session:
(pprof) top          # Where are goroutines spending time blocked?
(pprof) list myFunc  # Show blocking in specific function
(pprof) web          # Flame graph of blocking time
```

### Example: Diagnosing Lock Contention

A blocking profile showing this pattern:

```
Showing nodes accounting for 4.5s, 89.67% of 5.02s total
     flat  flat%   sum%        cum   cum%
     4.2s 83.67% 83.67%       4.2s 83.67%  sync.(*Mutex).Lock
```

This indicates heavy mutex contention. The next step is to check the mutex profile to find which functions are holding the lock.

## Section 7: Mutex Contention Profile

```go
// Enable mutex profiling (default is disabled - rate=0)
// rate = 1 reports every mutex event
// rate = 5 reports every 5th event (lower overhead)
runtime.SetMutexProfileFraction(5)
```

```bash
# Collect mutex contention profile
go tool pprof http://localhost:6060/debug/pprof/mutex

(pprof) top          # Which mutexes are most contended?
(pprof) list myFunc  # Show mutex operations in specific function

# Common findings:
# - sync.(*Mutex).Unlock appearing at top = a mutex is being held too long
# - High contention on map access = need sync.Map or sharded mutexes
```

### Diagnosing and Fixing Mutex Contention

```go
// BEFORE: Global mutex on every map access
type Cache struct {
    mu    sync.Mutex
    items map[string]interface{}
}

func (c *Cache) Get(key string) (interface{}, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()
    v, ok := c.items[key]
    return v, ok
}

// AFTER: Sharded map to reduce contention
const shards = 64

type ShardedCache struct {
    shards [shards]struct {
        sync.RWMutex
        items map[string]interface{}
    }
}

func (c *ShardedCache) shard(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % shards
}

func (c *ShardedCache) Get(key string) (interface{}, bool) {
    s := &c.shards[c.shard(key)]
    s.RLock()
    defer s.RUnlock()
    v, ok := s.items[key]
    return v, ok
}

func (c *ShardedCache) Set(key string, value interface{}) {
    s := &c.shards[c.shard(key)]
    s.Lock()
    defer s.Unlock()
    if s.items == nil {
        s.items = make(map[string]interface{})
    }
    s.items[key] = value
}
```

## Section 8: Execution Traces

The execution trace provides a timeline of goroutine activity, garbage collection, and system calls. It is more detailed than pprof but has higher overhead:

```go
package main

import (
    "os"
    "runtime/trace"
)

func captureTrace(filename string, duration time.Duration) error {
    f, err := os.Create(filename)
    if err != nil {
        return err
    }
    defer f.Close()

    if err := trace.Start(f); err != nil {
        return err
    }
    defer trace.Stop()

    time.Sleep(duration)
    return nil
}
```

```bash
# Collect trace via HTTP (5 seconds)
curl -o trace.out http://localhost:6060/debug/pprof/trace?seconds=5

# Analyze trace in browser
go tool trace trace.out

# The trace viewer shows:
# - Goroutine timeline (which goroutines ran on which CPU)
# - GC events and their impact
# - Goroutine creation and destruction
# - System calls and network I/O
# - User-defined task and region annotations
```

### Custom Trace Annotations

```go
package order

import (
    "context"
    "runtime/trace"
)

func ProcessOrder(ctx context.Context, orderID string) error {
    // Create a task for this entire operation
    ctx, task := trace.NewTask(ctx, "ProcessOrder")
    defer task.End()

    // Create regions for sub-operations
    trace.WithRegion(ctx, "validate", func() {
        validateOrder(ctx, orderID)
    })

    trace.WithRegion(ctx, "charge-payment", func() {
        chargePayment(ctx, orderID)
    })

    trace.WithRegion(ctx, "update-inventory", func() {
        updateInventory(ctx, orderID)
    })

    // Add log entries to the trace
    trace.Logf(ctx, "order", "Processing order %s complete", orderID)

    return nil
}
```

## Section 9: Continuous Profiling with Pyroscope

For production, consider continuous profiling with Pyroscope (formerly Grafana Pyroscope):

```go
package main

import (
    "github.com/grafana/pyroscope-go"
)

func initPyroscope() {
    pyroscope.Start(pyroscope.Config{
        ApplicationName: "my-service",
        ServerAddress:   "http://pyroscope.monitoring.svc.cluster.local:4040",
        Logger:          pyroscope.StandardLogger,

        // Profile types to collect
        ProfileTypes: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
            pyroscope.ProfileGoroutines,
            pyroscope.ProfileMutexCount,
            pyroscope.ProfileMutexDuration,
            pyroscope.ProfileBlockCount,
            pyroscope.ProfileBlockDuration,
        },

        // Tags for multi-tenant filtering
        Tags: map[string]string{
            "service":     "my-service",
            "environment": os.Getenv("ENVIRONMENT"),
            "version":     os.Getenv("APP_VERSION"),
            "pod":         os.Getenv("POD_NAME"),
        },
    })
}
```

### Pyroscope Dynamic Tagging

```go
package handlers

import (
    "github.com/grafana/pyroscope-go"
)

func HandleRequest(w http.ResponseWriter, r *http.Request) {
    // Tag the profile with the route being handled
    // This allows filtering profiles by endpoint in Pyroscope UI
    ctx := pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
        "endpoint", r.URL.Path,
        "method", r.Method,
    ))
    r = r.WithContext(ctx)

    processRequest(w, r)
}
```

## Section 10: Memory Leak Investigation Workflow

A systematic workflow for diagnosing memory leaks:

```bash
# Step 1: Establish baseline
curl -o heap-baseline.prof http://localhost:6060/debug/pprof/heap

# Step 2: Apply load for several minutes
hey -n 100000 -c 50 http://localhost:8080/api/process

# Step 3: Capture heap after load
curl -o heap-after.prof http://localhost:6060/debug/pprof/heap

# Step 4: Compare profiles
go tool pprof -diff_base heap-baseline.prof heap-after.prof

# In diff pprof session:
(pprof) top -inuse_space
# Positive values = more memory in use than baseline
# These are the leak candidates

# Step 5: Find the allocation sites
(pprof) list suspiciousFunction
```

### Common Memory Leak Patterns

```go
// Pattern 1: Goroutine leak (most common)
// LEAKY: Goroutine blocked forever on channel nobody reads
func startWorker() {
    results := make(chan Result)
    go func() {
        results <- doWork() // Nobody reads from results if caller returns
    }()
    // caller returns without reading - goroutine leaks
}

// FIX: Use context for cancellation
func startWorkerFixed(ctx context.Context) (<-chan Result, error) {
    results := make(chan Result, 1) // Buffered to prevent goroutine leak
    go func() {
        select {
        case results <- doWork():
        case <-ctx.Done():
        }
        close(results)
    }()
    return results, nil
}

// Pattern 2: Timer leak
// LEAKY: time.After creates a timer that holds memory until it fires
func leakyPoller() {
    for {
        select {
        case <-time.After(1 * time.Second): // New timer every loop iteration
            poll()
        }
    }
}

// FIX: Reuse the ticker
func fixedPoller(ctx context.Context) {
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            poll()
        case <-ctx.Done():
            return
        }
    }
}

// Pattern 3: Slice capacity retention
// LEAKY: Holds reference to large backing array
func getLargeDataSubset(data []byte) []byte {
    return data[0:10] // Still references entire data backing array
}

// FIX: Copy to release the large backing array
func getLargeDataSubsetFixed(data []byte) []byte {
    result := make([]byte, 10)
    copy(result, data[0:10])
    return result
}

// Pattern 4: Map that never shrinks
// Go maps don't shrink after deletes - they only grow
type Cache struct {
    mu    sync.Mutex
    items map[string]*Item
}

// FIX: Periodically recreate the map to release memory
func (c *Cache) compact() {
    c.mu.Lock()
    defer c.mu.Unlock()
    newMap := make(map[string]*Item, len(c.items))
    for k, v := range c.items {
        newMap[k] = v
    }
    c.items = newMap
}
```

## Section 11: Flame Graph Interpretation Guide

When looking at a CPU flame graph in the pprof web UI:

```
Wide bars = Functions consuming significant CPU time
Tall stacks = Deep call hierarchies
Flat tops = Functions that are "leaf" nodes (doing actual work)
```

### Key Patterns

```
Pattern: Wide bar on runtime.mallocgc
Diagnosis: High allocation rate. GC is competing with user code for CPU.
Action: Profile with -alloc_space to find allocation hot spots.
        Reduce allocations by pooling or value types.

Pattern: Wide bar on runtime.selectgo / sync.(*Mutex).Lock
Diagnosis: Goroutines spending most time waiting.
Action: Check blocking and mutex profiles.
        Consider lock-free algorithms or reducing critical sections.

Pattern: Wide bar on syscall.Syscall
Diagnosis: System call intensive (network I/O, file I/O).
Action: Check if buffering would reduce syscall frequency.
        Consider batching operations.

Pattern: Wide bar on encoding/json.Marshal
Diagnosis: Serialization is a bottleneck.
Action: Use easyjson or sonic for 3-5x speedup.
        Consider binary formats (protobuf, msgpack).

Pattern: Multiple bars all named the same function
Diagnosis: Function is being called from many different callers.
Action: The call is legitimately popular; optimize the function itself.
```

## Section 12: pprof in CI/CD - Preventing Regressions

```go
// benchmark_test.go
package mypackage_test

import (
    "testing"
)

var result interface{}

func BenchmarkCriticalPath(b *testing.B) {
    input := prepareInput()

    b.ReportAllocs()
    b.ResetTimer()

    var r interface{}
    for i := 0; i < b.N; i++ {
        r = CriticalPathFunction(input)
    }
    result = r // Prevent optimization
}
```

```bash
# In CI: compare against baseline
# Save baseline on main branch
go test -bench=BenchmarkCriticalPath -count=10 ./... | \
  tee baseline.txt

# On PR: compare
go test -bench=BenchmarkCriticalPath -count=10 ./... | \
  tee pr.txt

benchstat baseline.txt pr.txt
# Output shows whether performance changed significantly:
# name              old time/op    new time/op    delta
# CriticalPath-8    1.23ms ± 2%    1.85ms ± 3%   +50.41%  (p=0.000 n=10+10)
```

## Summary

The pprof toolchain provides comprehensive visibility into Go program behavior at runtime. The practical workflow for production performance investigation is:

1. **Expose** pprof endpoints on an internal port with authentication
2. **Identify** whether the bottleneck is CPU, memory, goroutines, or lock contention using `perf stat` or process-level metrics
3. **Collect** the appropriate profile type (CPU profile for hot code, heap profile for memory growth, goroutine profile for leaks, blocking/mutex profiles for contention)
4. **Analyze** with `go tool pprof -http=:8080` for the visual flame graph interface
5. **Compare** before/after profiles with `-diff_base` to validate fixes

For production environments, integrate continuous profiling via Pyroscope to maintain always-available profiles for each service version, enabling retrospective investigation of production incidents.
