---
title: "Go Memory Profiling: Heap Analysis and Allocation Optimization at Scale"
date: 2030-12-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Performance", "Memory", "Profiling", "pprof", "GC Tuning"]
categories:
- Go
- Performance
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go heap profiling with pprof, inuse_space vs alloc_space analysis, escape analysis, sync.Pool patterns, slice and map pre-allocation strategies, and reducing garbage collector pressure in high-throughput services."
more_link: "yes"
url: "/go-memory-profiling-heap-analysis-allocation-optimization/"
---

Memory issues are among the most insidious performance problems in Go services. Unlike languages with manual memory management, Go abstracts away allocation details — until your service starts paging, your GC pause times spike, or your pod gets OOM-killed. Effective Go memory profiling requires understanding not just where memory is allocated, but which allocations survive beyond the current function scope, how the garbage collector interacts with your allocation patterns, and which optimization techniques deliver the highest return on engineering effort.

This guide provides a systematic methodology for heap profiling and allocation optimization using production techniques: pprof integration and interpretation, the critical difference between `inuse_space` and `alloc_space`, compiler escape analysis, `sync.Pool` for hot-path object reuse, pre-allocation strategies for slices and maps, and measurable techniques for reducing GC pressure in services handling tens of thousands of requests per second.

<!--more-->

# Go Memory Profiling: Heap Analysis and Allocation Optimization at Scale

## Understanding Go Memory and the Garbage Collector

Before profiling, understand what you are measuring. Go's garbage collector is a concurrent, tri-color mark-and-sweep collector. It runs concurrently with your program but still causes "stop-the-world" (STW) pauses for certain phases — primarily the initial scan and write barrier setup.

Key GC metrics to understand:

- **Heap allocation rate**: How many bytes are allocated per second. High rates increase GC frequency.
- **Live heap size**: How many bytes are in-use at any given GC cycle. This determines GC trigger threshold.
- **GC pause duration**: Time your goroutines are stopped. Target under 1ms for latency-sensitive services.
- **GC CPU overhead**: Fraction of CPU time spent in GC work. Should stay under 5-10% for healthy services.

The runtime's `GOGC` environment variable controls the GC target ratio. The default value of 100 means GC runs when the live heap doubles from its size after the previous collection. Setting `GOGC=200` defers GC longer but allows the heap to grow larger before collection.

## Enabling pprof in Production Services

### HTTP pprof Endpoint

The simplest integration uses the `net/http/pprof` package, which registers profiling handlers on the default HTTP mux:

```go
package main

import (
    "net/http"
    _ "net/http/pprof"  // Side-effect import registers handlers
    "log"
)

func main() {
    // Expose pprof on a separate port — never expose on the public-facing port
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // ... your application code
}
```

This is fine for development but exposes sensitive information in production. For production, use a dedicated metrics port that is only accessible within the cluster:

```go
package profiling

import (
    "net/http"
    "net/http/pprof"
    "runtime"
)

// NewProfilingServer creates an HTTP server with pprof endpoints
// that should only be exposed on the cluster-internal network.
func NewProfilingServer(addr string) *http.Server {
    mux := http.NewServeMux()

    // Register pprof handlers explicitly (safer than importing for side effects)
    mux.HandleFunc("/debug/pprof/", pprof.Index)
    mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

    // Heap profile endpoint
    mux.HandleFunc("/debug/pprof/heap", pprof.Handler("heap").ServeHTTP)
    mux.HandleFunc("/debug/pprof/allocs", pprof.Handler("allocs").ServeHTTP)

    // Add a runtime stats endpoint
    mux.HandleFunc("/debug/runtime", func(w http.ResponseWriter, r *http.Request) {
        var stats runtime.MemStats
        runtime.ReadMemStats(&stats)
        w.Header().Set("Content-Type", "text/plain")
        // Write key metrics — avoid encoding/json for this hot path
        http.Error(w, formatMemStats(&stats), http.StatusOK)
    })

    return &http.Server{
        Addr:    addr,
        Handler: mux,
    }
}
```

### Programmatic Profile Collection

For services that need profiles collected on-demand or on a schedule:

```go
package profiling

import (
    "os"
    "runtime"
    "runtime/pprof"
    "time"
    "fmt"
)

// CollectHeapProfile writes a heap profile to disk.
// Call this before and after a suspected memory event to capture the delta.
func CollectHeapProfile(path string) error {
    // Force GC before capturing so inuse_space reflects truly live objects
    runtime.GC()

    f, err := os.Create(path)
    if err != nil {
        return fmt.Errorf("creating profile file: %w", err)
    }
    defer f.Close()

    // The 0 argument means "use default sampling rate"
    return pprof.WriteHeapProfile(f)
}

// ScheduledProfileCollector collects heap profiles on an interval.
// Useful for identifying slow memory growth (leaks) over time.
type ScheduledProfileCollector struct {
    interval  time.Duration
    outputDir string
    done      chan struct{}
}

func NewScheduledProfileCollector(interval time.Duration, outputDir string) *ScheduledProfileCollector {
    return &ScheduledProfileCollector{
        interval:  interval,
        outputDir: outputDir,
        done:      make(chan struct{}),
    }
}

func (c *ScheduledProfileCollector) Start() {
    go func() {
        ticker := time.NewTicker(c.interval)
        defer ticker.Stop()
        sequence := 0
        for {
            select {
            case <-ticker.C:
                path := fmt.Sprintf("%s/heap-%04d-%s.pprof",
                    c.outputDir, sequence,
                    time.Now().Format("20060102-150405"))
                if err := CollectHeapProfile(path); err != nil {
                    // Log error but continue collecting
                    fmt.Printf("profile collection error: %v\n", err)
                }
                sequence++
            case <-c.done:
                return
            }
        }
    }()
}

func (c *ScheduledProfileCollector) Stop() {
    close(c.done)
}
```

### Setting Allocation Sample Rate

By default, the heap profiler samples one allocation per 512KB allocated. For finer-grained analysis, lower the sample rate:

```go
// Sample every allocation — expensive but catches everything
// Use only in development or very short profiling windows
runtime.MemProfileRate = 1

// Sample every 64KB — good balance for production profiling
runtime.MemProfileRate = 64 * 1024

// Disable heap profiling (default is 512KB)
runtime.MemProfileRate = 0
```

Set this early in `main()` before any significant allocations occur.

## Capturing and Analyzing Profiles

### Capturing a Heap Profile

```bash
# Capture the current heap state
go tool pprof http://localhost:6060/debug/pprof/heap

# Capture with 30-second CPU profile window at the same time
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Download the raw profile for offline analysis
curl -s http://localhost:6060/debug/pprof/heap > heap.pprof
curl -s http://localhost:6060/debug/pprof/allocs > allocs.pprof
```

### inuse_space vs alloc_space: The Critical Distinction

This is the most important concept in Go heap profiling. The heap profile contains four views:

| View | What it shows |
|------|---------------|
| `inuse_space` | Memory currently allocated and not yet GC'd (live memory) |
| `inuse_objects` | Count of objects currently alive |
| `alloc_space` | Total memory ever allocated (including freed memory) |
| `alloc_objects` | Total count of objects ever allocated |

**Use `inuse_space` to find memory leaks**: If a code path shows high `inuse_space`, it holds memory for longer than expected. This is where you look for growing caches, leaked goroutines holding references, or unbounded slice growth.

**Use `alloc_space` to find GC pressure**: High `alloc_space` with low `inuse_space` means the code is allocating and freeing memory rapidly. The objects are not leaking, but the allocation rate is high, which increases GC frequency.

```bash
# Analyze inuse_space — look for memory leaks
go tool pprof -inuse_space heap.pprof

# Analyze alloc_space — look for GC pressure
go tool pprof -alloc_space heap.pprof

# Interactive pprof session
(pprof) top20              # Top 20 allocation sites by size
(pprof) list processRequest  # Show line-by-line allocations in a function
(pprof) web                # Generate SVG graph (requires graphviz)
(pprof) png > heap.png     # Export to PNG
```

### Reading pprof Output

Example `top10` output from `alloc_space`:

```
Showing top 10 nodes out of 45
      flat  flat%   sum%        cum   cum%
   512.3MB 28.15% 28.15%    512.3MB 28.15%  encoding/json.Marshal
   234.1MB 12.87% 41.02%    234.1MB 12.87%  strings.(*Builder).WriteString
   198.7MB 10.92% 51.94%   1209.8MB 66.52%  myservice.processRequest
   145.2MB  7.98% 59.92%    145.2MB  7.98%  bytes.(*Buffer).WriteByte
    98.4MB  5.41% 65.33%    432.6MB 23.78%  myservice.parsePayload
```

The `flat` column shows allocations that occurred directly in this function. The `cum` (cumulative) column includes allocations in all functions called from this function. A high `cum%` with low `flat%` means the function is not itself allocating much but calls something that does.

## Escape Analysis: Why Allocations Happen

The Go compiler performs escape analysis to determine whether a variable can be allocated on the stack (cheap, no GC involvement) or must be allocated on the heap (more expensive, GC must track it).

Variables escape to the heap when:
- Their address is taken and stored beyond the function scope
- They are passed to an interface (interface boxing causes escapes)
- They are too large to fit in the stack frame
- They are returned from the function by pointer

### Running Escape Analysis

```bash
# Show escape analysis decisions for a file
go build -gcflags='-m -m' ./... 2>&1 | head -50

# Focus on a specific package
go build -gcflags='-m' ./internal/handler/ 2>&1

# More verbose output
go build -gcflags='-m=2' ./... 2>&1
```

Sample output:

```
./handler.go:47:6: can inline processRequest
./handler.go:52:15: &Request literal escapes to heap
./handler.go:63:13: []byte literal does not escape
./handler.go:71:16: parseJSON(b) escapes to heap
./handler.go:84:9: *Response escapes to heap
```

### Reducing Escapes with Concrete Types

Using interfaces forces the contained value to escape to the heap because the interface value holds a pointer plus a type descriptor:

```go
// Bad: interface{} forces allocation for any non-pointer type
func logValue(key string, value interface{}) {
    // 'value' for int, bool, etc. causes allocation
}

// Better: use concrete types where possible
func logInt(key string, value int) {
    // No allocation
}

// For logging libraries, use structured fields
type Field struct {
    Key   string
    Type  FieldType
    Int   int64
    Str   string
    Bytes []byte
}

func logField(f Field) {
    // Field is a value type — no allocation if passed by value
}
```

### Stack-Friendly Data Structures

```go
// Bad: small struct that escapes because its address is taken
func badExample() *Config {
    c := Config{Timeout: 30, MaxRetries: 3}
    return &c  // Forces escape to heap
}

// Better: return by value when the struct is small
func goodExample() Config {
    return Config{Timeout: 30, MaxRetries: 3}
}

// For larger structs passed frequently, use a pointer parameter
// so the caller controls allocation:
func processConfig(cfg *Config) error {
    // cfg is passed in — no escape from this function
    return nil
}

// Caller:
cfg := Config{Timeout: 30}  // Stack-allocated
processConfig(&cfg)          // Passes address, cfg stays on caller's stack
```

## sync.Pool: Object Reuse for Hot Paths

`sync.Pool` is a concurrent-safe free list that the GC can drain at any time. It is ideal for amortizing the cost of frequently allocated, identically-sized objects — particularly in request-handling hot paths.

### Buffer Pool for HTTP Handlers

```go
package pool

import (
    "bytes"
    "sync"
)

// BufferPool manages a pool of *bytes.Buffer for reuse.
var BufferPool = &sync.Pool{
    New: func() interface{} {
        // Pre-size for typical request bodies
        return bytes.NewBuffer(make([]byte, 0, 4096))
    },
}

// GetBuffer retrieves a buffer from the pool, resetting it for reuse.
func GetBuffer() *bytes.Buffer {
    buf := BufferPool.Get().(*bytes.Buffer)
    buf.Reset()
    return buf
}

// PutBuffer returns a buffer to the pool.
// Do NOT put back a buffer that was returned to a caller — only pool
// buffers you control.
func PutBuffer(buf *bytes.Buffer) {
    // Cap extremely large buffers to avoid holding large memory blocks
    if buf.Cap() > 1<<20 { // 1MB cap
        return
    }
    BufferPool.Put(buf)
}
```

Usage in an HTTP handler:

```go
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    buf := pool.GetBuffer()
    defer pool.PutBuffer(buf)

    // Use buf for JSON encoding instead of allocating a new buffer per request
    enc := json.NewEncoder(buf)
    if err := enc.Encode(h.buildResponse(r)); err != nil {
        http.Error(w, "encoding error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    w.Write(buf.Bytes())
}
```

### Request Object Pool

For services with high request volume, pool the request struct itself:

```go
package handler

import (
    "sync"
)

type ParsedRequest struct {
    UserID    int64
    Action    string
    Payload   map[string]interface{}
    Tags      []string
}

// reset clears the struct fields for reuse.
// Critical: must clear all fields to avoid data leakage between requests.
func (r *ParsedRequest) reset() {
    r.UserID = 0
    r.Action = ""
    // Reuse the map but clear its contents
    for k := range r.Payload {
        delete(r.Payload, k)
    }
    if r.Payload == nil {
        r.Payload = make(map[string]interface{}, 8)
    }
    r.Tags = r.Tags[:0]  // Reset length but keep capacity
}

var requestPool = &sync.Pool{
    New: func() interface{} {
        return &ParsedRequest{
            Payload: make(map[string]interface{}, 8),
            Tags:    make([]string, 0, 4),
        }
    },
}

func getRequest() *ParsedRequest {
    req := requestPool.Get().(*ParsedRequest)
    req.reset()
    return req
}

func putRequest(req *ParsedRequest) {
    requestPool.Put(req)
}
```

### sync.Pool Pitfalls

```go
// WRONG: Storing a pointer from the pool and using it after Put
func wrong() {
    obj := pool.Get().(*MyStruct)
    pool.Put(obj)
    obj.Field = "value"  // Use-after-put: obj may have been reused
}

// WRONG: Storing the pool object in a long-lived data structure
type Server struct {
    cached *MyStruct  // If this came from pool.Get(), it should not be cached
}

// CORRECT: Get, use immediately, put back
func correct(pool *sync.Pool) {
    obj := pool.Get().(*MyStruct)
    defer pool.Put(obj)
    // Use obj only within this scope
    process(obj)
}

// WRONG: Putting nil into the pool
pool.Put(nil)  // Panics

// WRONG: Relying on pool for persistent storage
// sync.Pool can be drained at any GC cycle
```

## Slice and Map Pre-allocation

Slice and map growth reallocates backing arrays. Pre-allocating avoids these intermediate allocations.

### Slice Pre-allocation

```go
// Bad: O(log n) reallocations as the slice grows
func collectBad(items []Item) []string {
    var result []string
    for _, item := range items {
        result = append(result, item.Name)
    }
    return result
}

// Better: pre-allocate with known capacity
func collectGood(items []Item) []string {
    result := make([]string, 0, len(items))
    for _, item := range items {
        result = append(result, item.Name)
    }
    return result
}

// Best when transforming 1:1: use indexed assignment
func collectBest(items []Item) []string {
    result := make([]string, len(items))
    for i, item := range items {
        result[i] = item.Name
    }
    return result
}

// When building slices from uncertain sources, use a reasonable initial cap
func collectFromChannel(ch <-chan Item) []string {
    // Can't know final size, but pre-size for typical cases
    result := make([]string, 0, 64)
    for item := range ch {
        result = append(result, item.Name)
    }
    return result
}
```

### Map Pre-allocation

```go
// Bad: map grows through multiple rehashes
func buildMapBad(pairs []KVPair) map[string]int {
    m := make(map[string]int)  // Empty map
    for _, p := range pairs {
        m[p.Key] = p.Value
    }
    return m
}

// Better: hint at expected size
func buildMapGood(pairs []KVPair) map[string]int {
    m := make(map[string]int, len(pairs))
    for _, p := range pairs {
        m[p.Key] = p.Value
    }
    return m
}

// When keys are known at compile time, consider a struct instead
// Struct field access is O(1) and allocation-free:
type Counts struct {
    Requests  int
    Errors    int
    Timeouts  int
}

// vs map[string]int which allocates per-element metadata
```

### Growing Slices with Append and Reslicing

Avoid repeated append in a loop when the capacity can be calculated:

```go
// Pattern: filter-in-place using a single backing array
func filterInPlace(items []Item, predicate func(Item) bool) []Item {
    // Reuse the same slice backing array
    result := items[:0]
    for _, item := range items {
        if predicate(item) {
            result = append(result, item)
        }
    }
    return result
}
// Note: the original items slice must not be used after this call
// as the backing array is now shared with result.

// Pattern: copy-on-filter when original must be preserved
func filterCopy(items []Item, predicate func(Item) bool) []Item {
    result := make([]Item, 0, len(items))
    for _, item := range items {
        if predicate(item) {
            result = append(result, item)
        }
    }
    return result
}
```

## Reducing GC Pressure: Systematic Techniques

### Avoid Allocations in Hot Paths

Benchmark allocations with `testing.AllocsPerRun`:

```go
package handler_test

import (
    "testing"
    "net/http/httptest"
)

func BenchmarkHandlerAllocations(b *testing.B) {
    h := NewHandler()
    req := httptest.NewRequest("GET", "/api/data", nil)

    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        w := httptest.NewRecorder()
        h.ServeHTTP(w, req)
    }
}

// Check allocation count per operation
func TestHandlerZeroAllocs(t *testing.T) {
    h := NewHandler()
    req := httptest.NewRequest("GET", "/api/data", nil)

    allocs := testing.AllocsPerRun(100, func() {
        w := httptest.NewRecorder()
        h.ServeHTTP(w, req)
    })

    if allocs > 5 {
        t.Errorf("expected <= 5 allocs per request, got %v", allocs)
    }
}
```

### String Conversion Optimization

String-to-byte-slice conversion causes allocation. In hot paths, avoid it:

```go
// Bad: allocates a new byte slice each call
func hashKeyBad(key string) uint64 {
    return xxhash.Sum64([]byte(key))
}

// Better: use unsafe.SliceData to avoid allocation
// Only safe when the function does not retain the byte slice
import "unsafe"

func hashKeyGood(key string) uint64 {
    // This avoids allocation by treating the string backing array as []byte
    // SAFE only because xxhash.Sum64 does not store the slice
    b := unsafe.Slice(unsafe.StringData(key), len(key))
    return xxhash.Sum64(b)
}

// Idiomatic safe approach for common standard library functions
// strings.Builder avoids repeated allocation for concatenation
func buildKeyBuilder(parts []string, sep string) string {
    var b strings.Builder
    b.Grow(estimateKeyLen(parts, sep))  // Pre-allocate
    for i, p := range parts {
        if i > 0 {
            b.WriteString(sep)
        }
        b.WriteString(p)
    }
    return b.String()
}
```

### JSON Encoding Optimization

`encoding/json` is allocation-heavy. For high-throughput paths, use `json.RawMessage` to avoid re-encoding, or switch to a zero-allocation encoder:

```go
// Using easyjson for zero-allocation marshaling
// go get github.com/mailru/easyjson
// easyjson -all ./models/response.go

//go:generate easyjson -all response.go
type Response struct {
    UserID  int64  `json:"user_id"`
    Name    string `json:"name"`
    Status  string `json:"status"`
}

// Using sonic (bytedance) for faster encoding
import "github.com/bytedance/sonic"

func encodeResponse(w io.Writer, resp *Response) error {
    return sonic.NewEncoder(w).Encode(resp)
}

// Reuse encoder with pooled buffers
var encoderPool = sync.Pool{
    New: func() interface{} {
        return sonic.NewEncoder(nil)
    },
}
```

### GOGC and GOMEMLIMIT Tuning

Go 1.19 introduced `GOMEMLIMIT`, which is usually more appropriate than tuning `GOGC` for containerized services:

```bash
# Set a soft memory limit — GC runs more aggressively when approaching this limit
# This prevents OOM kills at the cost of more GC CPU usage
GOMEMLIMIT=450MiB ./myservice

# For a container with 512Mi memory limit:
# Set GOMEMLIMIT to ~87% of limit to leave headroom
GOMEMLIMIT=448MiB
```

Programmatic configuration in Kubernetes using the Downward API:

```go
package main

import (
    "os"
    "runtime/debug"
    "strconv"
)

func configureGC() {
    // Read memory limit from environment (set by Kubernetes via Downward API)
    if limitStr := os.Getenv("GOMEMLIMIT"); limitStr != "" {
        // runtime/debug.SetMemoryLimit accepts bytes
        // Parse the value if set programmatically
        if limit, err := strconv.ParseInt(limitStr, 10, 64); err == nil {
            debug.SetMemoryLimit(limit)
        }
    }

    // Optionally tune GOGC for latency-sensitive services
    // Higher value = less frequent GC = lower CPU overhead but larger heap
    if gogcStr := os.Getenv("GOGC"); gogcStr != "" {
        if val, err := strconv.Atoi(gogcStr); err == nil {
            debug.SetGCPercent(val)
        }
    }
}
```

Kubernetes Pod manifest with memory limit and GOMEMLIMIT:

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"
env:
  - name: GOMEMLIMIT
    valueFrom:
      resourceFieldRef:
        resource: limits.memory
        # This gives the value in bytes
  - name: GOGC
    value: "150"
```

## Identifying Memory Leaks

### Goroutine Leak Detection

Goroutines that block indefinitely hold references to their stack variables. A goroutine leak is a memory leak:

```go
package leakcheck_test

import (
    "testing"
    "time"
    "go.uber.org/goleak"
)

func TestNoGoroutineLeak(t *testing.T) {
    defer goleak.VerifyNone(t)

    // Run your code under test
    svc := NewService()
    svc.Start()

    // Simulate some work
    time.Sleep(100 * time.Millisecond)

    svc.Stop()
    // goleak will fail the test if any goroutines started during
    // the test are still running after svc.Stop()
}
```

### Detecting Cache Growth

Unbounded caches are the most common production memory leak. Use a bounded cache with eviction:

```go
package cache

import (
    "sync"
    "container/list"
)

// LRUCache is a thread-safe LRU cache with a bounded capacity.
type LRUCache struct {
    mu       sync.Mutex
    capacity int
    items    map[string]*list.Element
    order    *list.List
}

type entry struct {
    key   string
    value interface{}
}

func NewLRUCache(capacity int) *LRUCache {
    return &LRUCache{
        capacity: capacity,
        items:    make(map[string]*list.Element, capacity),
        order:    list.New(),
    }
}

func (c *LRUCache) Get(key string) (interface{}, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if elem, ok := c.items[key]; ok {
        c.order.MoveToFront(elem)
        return elem.Value.(*entry).value, true
    }
    return nil, false
}

func (c *LRUCache) Set(key string, value interface{}) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if elem, ok := c.items[key]; ok {
        c.order.MoveToFront(elem)
        elem.Value.(*entry).value = value
        return
    }

    if c.order.Len() >= c.capacity {
        // Evict oldest entry
        oldest := c.order.Back()
        if oldest != nil {
            c.order.Remove(oldest)
            delete(c.items, oldest.Value.(*entry).key)
        }
    }

    e := &entry{key: key, value: value}
    elem := c.order.PushFront(e)
    c.items[key] = elem
}
```

## Continuous Memory Monitoring

### Runtime Memory Metrics Export

```go
package metrics

import (
    "runtime"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    heapInuse = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_memstats_heap_inuse_bytes",
        Help: "Number of heap bytes that are in use.",
    })
    heapAlloc = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_memstats_heap_alloc_bytes",
        Help: "Number of heap bytes allocated and still in use.",
    })
    gcPauseTotalNs = promauto.NewCounter(prometheus.CounterOpts{
        Name: "go_gc_duration_seconds_total",
        Help: "Total time spent in GC pauses.",
    })
    numGC = promauto.NewCounter(prometheus.CounterOpts{
        Name: "go_gc_cycles_total",
        Help: "Total number of completed GC cycles.",
    })
)

func RecordMemStats() {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    heapInuse.Set(float64(m.HeapInuse))
    heapAlloc.Set(float64(m.HeapAlloc))
    gcPauseTotalNs.Add(float64(m.PauseTotalNs) / 1e9)
    numGC.Add(float64(m.NumGC))
}
```

## Putting It All Together: Optimization Workflow

The systematic approach to Go memory optimization:

1. **Establish a baseline**: Record current heap size, GC frequency, GC pause times, and allocation rate from production metrics.

2. **Capture profiles**: Collect `alloc_space` profiles during peak load to find high-allocation paths. Collect `inuse_space` profiles after extended operation to find leaks.

3. **Run escape analysis**: On the top allocation sites identified by the profiler, run `go build -gcflags='-m'` to understand which allocations are necessary vs. avoidable.

4. **Apply targeted optimizations**:
   - Pool objects for hot-path request types
   - Pre-allocate slices and maps where sizes are known
   - Replace interface{} with concrete types in frequently-called functions
   - Use `strings.Builder` instead of `+` concatenation in loops

5. **Benchmark the changes**: Use `b.ReportAllocs()` to measure the before/after allocation count per operation.

6. **Validate in staging**: Deploy changes and compare GC metrics against the baseline. Look for reduced `go_gc_cycles_total`, lower `go_memstats_heap_inuse_bytes`, and improved p99 latency.

7. **Set GOMEMLIMIT**: Once you understand the steady-state heap size, set `GOMEMLIMIT` to a value that prevents OOM kills while keeping GC overhead manageable.

Memory optimization in Go is iterative. A 50% reduction in allocation rate does not always translate to a 50% improvement in throughput, but it reliably reduces GC pause frequency and duration — which directly improves tail latency and makes your service more predictable under load.
