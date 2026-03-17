---
title: "Go Memory Management: Escape Analysis, GC Pressure Reduction, and Arena Allocators"
date: 2028-07-11T00:00:00-05:00
draft: false
tags: ["Go", "Memory Management", "GC", "Performance", "Profiling"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive guide to Go memory management covering escape analysis, GC tuning with GOGC and GOMEMLIMIT, sync.Pool patterns, object reuse strategies, and the experimental arena allocator for high-throughput applications."
more_link: "yes"
url: "/go-memory-management-gc-optimization-guide/"
---

Go's garbage collector is one of its most misunderstood components. Teams see GC pauses, reach for `GOGC=off`, and wonder why their service allocates 4GB of heap for what feels like modest workload. Understanding Go's memory model — how the allocator decides between stack and heap, how the tri-color mark-and-sweep GC works, and how to tune it for your workload characteristics — is the difference between a service that struggles at 10k RPS and one that handles 100k RPS on the same hardware.

This guide covers the full memory management story: escape analysis and its implications for allocation patterns, GC tuning with `GOGC` and `GOMEMLIMIT`, `sync.Pool` for object reuse, custom allocators with `sync.Pool` pools, and the experimental arena allocator introduced in Go 1.20 for bulk allocation scenarios.

<!--more-->

# Go Memory Management: Escape Analysis, GC Pressure, and Arena Allocators

## Section 1: How Go's Allocator Works

### Stack vs Heap: The Escape Decision

Every Go variable is allocated either on the goroutine's stack or on the heap. Stack allocations are free — the stack pointer advances and then retreats. Heap allocations require the GC to track and eventually collect them. The compiler's escape analysis determines which is which.

```go
// escape_test.go
package main

// This variable stays on the stack — doesn't escape
func stackVar() int {
    x := 42  // x lives on the stack
    return x  // copied to caller's stack frame
}

// This variable escapes to the heap
func heapVar() *int {
    x := 42  // x escapes to heap because we return a pointer
    return &x
}

// This interface causes the int to escape
func interfaceEscape(i interface{}) {
    // The value inside the interface is heap-allocated
    _ = i
}

// This slice escapes if it grows beyond its initial capacity
func maybeEscape(n int) []int {
    if n <= 1024 {
        s := make([]int, n)  // May be stack-allocated
        return s
    }
    // Large allocations always go to the heap
    s := make([]int, n)
    return s
}
```

Run escape analysis to see what escapes:

```bash
go build -gcflags="-m -m" ./... 2>&1 | grep "escapes\|does not escape"

# Example output:
# ./main.go:8:2: x does not escape
# ./main.go:14:2: x escapes to heap
# ./main.go:20:17: parameter i leaks to heap
```

### Common Escape Patterns

```go
// Pattern 1: Pointer to local variable returned
func create() *Thing {
    t := Thing{}  // escapes
    return &t
}

// Fix: Use a value type if caller can hold it
func createValue() Thing {
    t := Thing{}  // stays on stack
    return t       // copied, not escaped
}

// Pattern 2: Interface boxing
type Stringer interface { String() string }

type Point struct{ X, Y float64 }
func (p Point) String() string { return fmt.Sprintf("(%g, %g)", p.X, p.Y) }

func printPoint(p Stringer) {  // p escapes here
    fmt.Println(p.String())
}

func main() {
    pt := Point{1.0, 2.0}
    printPoint(pt)  // pt copies to heap when boxing into Stringer
}

// Fix: Use concrete type when possible
func printPointConcrete(p Point) {
    fmt.Printf("(%g, %g)\n", p.X, p.Y)  // No allocation
}

// Pattern 3: Closures capturing variables
func counter() func() int {
    count := 0  // count escapes because it's captured by the closure
    return func() int {
        count++
        return count
    }
}

// Pattern 4: Slice/map literals assigned to interfaces
func appendToInterface() {
    var m interface{} = map[string]int{}  // map escapes
    _ = m
}

// Pattern 5: Large values in small functions
// The compiler may not inline large value copies
```

### Memory Allocator Size Classes

Go's allocator divides objects into size classes for efficient allocation:

```
Tiny allocations (0-16 bytes): Combined into 16-byte blocks
Small allocations (16-32768 bytes): Allocated from per-P mcache
Large allocations (>32KB): Allocated directly from the OS
```

Understanding this explains why padding structs to align with size class boundaries can reduce allocations:

```go
// Suboptimal: 24 bytes, goes in 32-byte size class, wastes 8 bytes
type BadStruct struct {
    A int64   // 8 bytes
    B bool    // 1 byte
    C int32   // 4 bytes
    // 3 bytes padding
}

// Optimized: 16 bytes, fits exactly in 16-byte size class
type GoodStruct struct {
    A int64  // 8 bytes
    C int32  // 4 bytes
    B bool   // 1 byte
    // 3 bytes padding
    // total: 16 bytes
}

// Check with unsafe.Sizeof
println(unsafe.Sizeof(BadStruct{}))   // 16 (Go reorders fields)
println(unsafe.Sizeof(GoodStruct{}))  // 16
```

Actually Go reorders struct fields automatically in many cases. Use `go vet -fieldalignment` to check:

```bash
go install golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest
fieldalignment ./...
```

## Section 2: GC Tuning

### Understanding GOGC

`GOGC` controls when the GC runs relative to current heap size. Default is 100, meaning "run GC when heap doubles from the previous GC trigger":

```
GOGC=100 (default): GC when heap grows by 100% (doubles)
GOGC=50:            GC when heap grows by 50% (1.5x)
GOGC=200:           GC when heap grows by 200% (triples)
GOGC=off:           Never run GC (use carefully, only with GOMEMLIMIT)
```

Higher `GOGC` = less frequent GC = more heap used = lower GC CPU overhead.
Lower `GOGC` = more frequent GC = less heap = higher GC CPU overhead.

```bash
# Set for the process
GOGC=200 ./my-service

# Set programmatically
import "runtime/debug"

func init() {
    debug.SetGCPercent(200)
}
```

### GOMEMLIMIT (Go 1.19+)

`GOMEMLIMIT` provides an absolute memory cap. The GC becomes more aggressive as the heap approaches the limit:

```bash
# Limit to 3GB
GOMEMLIMIT=3GiB ./my-service

# With aggressive GOGC (less frequent GC, but bounded by limit)
GOGC=200 GOMEMLIMIT=3GiB ./my-service
```

Programmatic control:

```go
import "runtime/debug"

func configureMemory() {
    // Use GOMEMLIMIT from environment, or set default
    if os.Getenv("GOMEMLIMIT") == "" {
        // Set to 75% of available RAM as a safety measure
        if totalRAM := getAvailableRAM(); totalRAM > 0 {
            limit := int64(float64(totalRAM) * 0.75)
            debug.SetMemoryLimit(limit)
        }
    }

    // Use soft memory limit in the ballpark of your container limit
    // For a 4GB container:
    debug.SetMemoryLimit(3 * 1024 * 1024 * 1024) // 3GB
}

func getAvailableRAM() uint64 {
    data, err := os.ReadFile("/sys/fs/cgroup/memory.max")
    if err != nil {
        return 0
    }
    s := strings.TrimSpace(string(data))
    if s == "max" {
        return 0
    }
    v, _ := strconv.ParseUint(s, 10, 64)
    return v
}
```

### Profiling Allocation Patterns

```bash
# Capture heap profile
curl http://localhost:6060/debug/pprof/heap > heap.pb.gz
go tool pprof -alloc_objects heap.pb.gz
go tool pprof -alloc_space heap.pb.gz

# Continuous profiling with pprof
import _ "net/http/pprof"

go func() {
    log.Println(http.ListenAndServe("localhost:6060", nil))
}()

# Capture and analyze
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/heap

# Track allocations in tests
go test -memprofile=mem.prof -benchmem ./...
go tool pprof -alloc_objects mem.prof
```

### GC Metrics and Monitoring

```go
// pkg/metrics/gc.go
package metrics

import (
    "runtime"
    "runtime/metrics"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    gcPauseDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "go_gc_pause_duration_seconds",
        Help:    "GC pause duration distribution",
        Buckets: []float64{.0001, .0005, .001, .005, .01, .025, .05, .1, .25},
    })
    heapInUse = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_heap_inuse_bytes",
        Help: "Heap memory in use",
    })
    heapObjects = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_heap_objects",
        Help: "Number of allocated objects",
    })
    gcCPUFraction = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_gc_cpu_fraction",
        Help: "Fraction of CPU time used by GC",
    })
    allocRate = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_alloc_rate_bytes_per_second",
        Help: "Bytes allocated per second",
    })
)

func StartGCMonitoring(interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        var lastAllocBytes uint64
        var lastTime time.Time

        // Use the new runtime/metrics API (Go 1.16+)
        descs := []metrics.Sample{
            {Name: "/gc/pauses:seconds"},
            {Name: "/memory/classes/heap/inuse:bytes"},
            {Name: "/memory/classes/heap/objects:objects"},
            {Name: "/gc/cpu/fraction:float64"},
            {Name: "/memory/allocs:bytes"},
        }

        for range ticker.C {
            metrics.Read(descs)

            for _, sample := range descs {
                switch sample.Name {
                case "/gc/pauses:seconds":
                    if h, ok := sample.Value.Float64Histogram(); ok {
                        // Export histogram buckets
                        for i, count := range h.Counts {
                            if count > 0 {
                                gcPauseDuration.Observe(h.Buckets[i])
                            }
                        }
                    }

                case "/memory/classes/heap/inuse:bytes":
                    heapInUse.Set(float64(sample.Value.Uint64()))

                case "/gc/cpu/fraction:float64":
                    gcCPUFraction.Set(sample.Value.Float64())

                case "/memory/allocs:bytes":
                    current := sample.Value.Uint64()
                    now := time.Now()
                    if lastAllocBytes > 0 {
                        duration := now.Sub(lastTime).Seconds()
                        rate := float64(current-lastAllocBytes) / duration
                        allocRate.Set(rate)
                    }
                    lastAllocBytes = current
                    lastTime = now
                }
            }
        }
    }()
}
```

## Section 3: sync.Pool for Object Reuse

### Basic Pool Usage

```go
// pkg/pool/pool.go
package pool

import (
    "bytes"
    "sync"
)

// BufferPool reuses byte buffers
var BufferPool = sync.Pool{
    New: func() interface{} {
        return bytes.NewBuffer(make([]byte, 0, 4096))
    },
}

func GetBuffer() *bytes.Buffer {
    return BufferPool.Get().(*bytes.Buffer)
}

func PutBuffer(buf *bytes.Buffer) {
    buf.Reset()
    // Don't return oversized buffers — they'd waste memory in the pool
    if buf.Cap() <= 64*1024 {
        BufferPool.Put(buf)
    }
}

// Example: JSON encoder reuse
type JSONEncoder struct {
    buf bytes.Buffer
    enc *json.Encoder
}

var encoderPool = sync.Pool{
    New: func() interface{} {
        enc := &JSONEncoder{}
        enc.enc = json.NewEncoder(&enc.buf)
        return enc
    },
}

func EncodeJSON(v interface{}) ([]byte, error) {
    enc := encoderPool.Get().(*JSONEncoder)
    defer func() {
        enc.buf.Reset()
        encoderPool.Put(enc)
    }()

    if err := enc.enc.Encode(v); err != nil {
        return nil, err
    }

    result := make([]byte, enc.buf.Len())
    copy(result, enc.buf.Bytes())
    return result, nil
}
```

### Typed Pool for Zero-Copy HTTP Responses

```go
// pkg/pool/http_pool.go
package pool

import (
    "net/http"
    "sync"
)

// ResponseWriter wraps http.ResponseWriter with a pooled buffer
type ResponseWriter struct {
    http.ResponseWriter
    buf        []byte
    statusCode int
    written    bool
}

var rwPool = sync.Pool{
    New: func() interface{} {
        return &ResponseWriter{
            buf: make([]byte, 0, 4096),
        }
    },
}

func GetResponseWriter(w http.ResponseWriter) *ResponseWriter {
    rw := rwPool.Get().(*ResponseWriter)
    rw.ResponseWriter = w
    rw.statusCode = http.StatusOK
    rw.written = false
    return rw
}

func PutResponseWriter(rw *ResponseWriter) {
    rw.ResponseWriter = nil
    rw.buf = rw.buf[:0]
    if cap(rw.buf) <= 64*1024 {
        rwPool.Put(rw)
    }
}

func (rw *ResponseWriter) Write(b []byte) (int, error) {
    rw.buf = append(rw.buf, b...)
    return len(b), nil
}

func (rw *ResponseWriter) WriteHeader(code int) {
    rw.statusCode = code
}

func (rw *ResponseWriter) Flush() {
    if !rw.written {
        rw.ResponseWriter.WriteHeader(rw.statusCode)
        rw.written = true
    }
    rw.ResponseWriter.Write(rw.buf)
}
```

### Pool-Based Request Handler

```go
// High-throughput HTTP handler with minimized allocations
type Request struct {
    Path   string
    Method string
    Body   []byte
    Params map[string]string
}

var requestPool = sync.Pool{
    New: func() interface{} {
        return &Request{
            Params: make(map[string]string, 4),
        }
    },
}

func parseRequest(r *http.Request) *Request {
    req := requestPool.Get().(*Request)
    req.Path = r.URL.Path
    req.Method = r.Method

    // Clear params map (reuse its memory)
    for k := range req.Params {
        delete(req.Params, k)
    }

    // Parse query params
    for k, v := range r.URL.Query() {
        if len(v) > 0 {
            req.Params[k] = v[0]
        }
    }

    return req
}

func putRequest(req *Request) {
    req.Body = req.Body[:0]
    requestPool.Put(req)
}
```

## Section 4: Reducing Allocations in Hot Paths

### String Concatenation

```go
// Bad: Each + allocates a new string
func buildQueryBad(filters []string) string {
    s := "SELECT * FROM users WHERE "
    for i, f := range filters {
        if i > 0 {
            s += " AND "
        }
        s += f  // Allocates a new string each time
    }
    return s
}

// Good: Use strings.Builder
func buildQueryGood(filters []string) string {
    var sb strings.Builder
    sb.WriteString("SELECT * FROM users WHERE ")
    for i, f := range filters {
        if i > 0 {
            sb.WriteString(" AND ")
        }
        sb.WriteString(f)
    }
    return sb.String()  // One allocation at the end
}

// Better: Pre-size the builder
func buildQueryBetter(filters []string) string {
    var sb strings.Builder
    const prefix = "SELECT * FROM users WHERE "
    // Estimate total size
    size := len(prefix)
    for _, f := range filters {
        size += len(f) + 5  // " AND "
    }
    sb.Grow(size)

    sb.WriteString(prefix)
    for i, f := range filters {
        if i > 0 {
            sb.WriteString(" AND ")
        }
        sb.WriteString(f)
    }
    return sb.String()
}
```

### Avoiding Map Allocations for Small Sets

```go
// For small fixed-size maps, a slice of pairs is faster and cheaper
type kvPair struct{ key, value string }

// Instead of: map[string]string
// Use: []kvPair with linear search when N is small
type SmallMap []kvPair

func (m SmallMap) Get(key string) (string, bool) {
    for _, p := range m {
        if p.key == key {
            return p.value, true
        }
    }
    return "", false
}

func (m *SmallMap) Set(key, value string) {
    for i, p := range *m {
        if p.key == key {
            (*m)[i].value = value
            return
        }
    }
    *m = append(*m, kvPair{key, value})
}
```

### Integer Keys for Maps

```go
// String keys: require hashing and comparison
var stringMap = make(map[string]int)

// Integer keys: much cheaper
var intMap = make(map[int]int)
var uint64Map = make(map[uint64]int)

// Convert string keys to integers using interning
type StringInterner struct {
    mu      sync.RWMutex
    strings map[string]uint32
    counter uint32
}

func (s *StringInterner) Intern(str string) uint32 {
    s.mu.RLock()
    id, ok := s.strings[str]
    s.mu.RUnlock()
    if ok {
        return id
    }

    s.mu.Lock()
    defer s.mu.Unlock()
    if id, ok := s.strings[str]; ok {
        return id
    }
    id = atomic.AddUint32(&s.counter, 1)
    s.strings[str] = id
    return id
}
```

## Section 5: Zero-Copy Techniques

### Bytes-to-String Conversion Without Allocation

```go
// DANGEROUS: Only safe if you never mutate the byte slice
// and the string does not outlive the byte slice
import "unsafe"

func bytesToString(b []byte) string {
    return unsafe.String(unsafe.SliceData(b), len(b))
}

// Safe alternative: use strings.Builder
func buildFromBytes(parts [][]byte) string {
    var sb strings.Builder
    for _, p := range parts {
        sb.Write(p)
    }
    return sb.String()
}
```

### Reading Without Allocation Using bufio

```go
// Instead of io.ReadAll which allocates
func processLargeFile(f *os.File) error {
    scanner := bufio.NewScanner(f)
    scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

    for scanner.Scan() {
        line := scanner.Bytes()  // Zero-copy reference into internal buffer
        processLine(line)
        // DO NOT keep a reference to line after next Scan()
    }
    return scanner.Err()
}

// Reuse scanner buffer across calls
var scannerBufPool = sync.Pool{
    New: func() interface{} { return make([]byte, 64*1024) },
}

func processFilePooled(f *os.File) error {
    buf := scannerBufPool.Get().([]byte)
    defer scannerBufPool.Put(buf)

    scanner := bufio.NewScanner(f)
    scanner.Buffer(buf, 10*1024*1024)
    // ...
    return scanner.Err()
}
```

## Section 6: The Arena Allocator (Go 1.20+ Experimental)

The `arena` package (experimental) provides bulk allocation where all objects allocated from the arena can be freed at once, without waiting for the GC:

```go
//go:build goexperiment.arenas

package main

import (
    "arena"
    "fmt"
)

type Request struct {
    ID     int64
    Body   []byte
    Params map[string]string
}

// Process a batch of requests using arena allocation
// All memory is freed at once when the arena is freed
func processRequestBatch(rawRequests [][]byte) error {
    mem := arena.NewArena()
    defer mem.Free()  // Frees all arena-allocated memory at once

    requests := arena.MakeSlice[*Request](mem, len(rawRequests), len(rawRequests))

    for i, raw := range rawRequests {
        req := arena.New[Request](mem)
        req.ID = int64(i)
        req.Body = raw
        req.Params = arena.MakeMap[string, string](mem)
        // Parse params...
        requests[i] = req
    }

    for _, req := range requests {
        if err := processRequest(req); err != nil {
            return err
        }
    }

    // When defer runs, all Request objects are freed at once
    // No GC pressure from this batch at all
    return nil
}
```

Build with arena support:

```bash
GOEXPERIMENT=arenas go build ./...
```

The arena pattern is most effective for:
- Request processing where all data can be freed after the response
- Batch processing with known lifetimes
- Parsing large inputs that are consumed and discarded

## Section 7: Profiling and Benchmarking

### Benchmark with Allocation Tracking

```go
// bench_test.go
package main

import (
    "testing"
)

func BenchmarkBadConcat(b *testing.B) {
    filters := []string{"age > 18", "active = true", "country = 'US'"}
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _ = buildQueryBad(filters)
    }
}

func BenchmarkGoodConcat(b *testing.B) {
    filters := []string{"age > 18", "active = true", "country = 'US'"}
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _ = buildQueryGood(filters)
    }
}

// Expected output:
// BenchmarkBadConcat   - 3 allocs/op
// BenchmarkGoodConcat  - 1 alloc/op
```

### Using benchstat for Comparison

```bash
# Run benchmarks before and after optimization
go test -bench=. -count=10 -benchmem ./... > before.txt

# After changes
go test -bench=. -count=10 -benchmem ./... > after.txt

# Compare
benchstat before.txt after.txt

# Output:
# name           old time/op    new time/op    delta
# BenchmarkFoo   2.34µs ± 2%    1.12µs ± 1%   -52.14%  (p=0.000 n=10+10)
#
# name           old alloc/op   new alloc/op   delta
# BenchmarkFoo   1.00kB ± 0%    256B ± 0%      -75.00%  (p=0.000 n=10+10)
#
# name           old allocs/op  new allocs/op  delta
# BenchmarkFoo   12.0 ± 0%      3.00 ± 0%      -75.00%  (p=0.000 n=10+10)
```

### Continuous Allocation Monitoring

```go
// pkg/memwatch/memwatch.go
package memwatch

import (
    "log/slog"
    "runtime"
    "time"
)

type Stats struct {
    Alloc        uint64
    TotalAlloc   uint64
    Sys          uint64
    NumGC        uint32
    GCPauseTotal time.Duration
    HeapObjects  uint64
}

func Collect() Stats {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)
    return Stats{
        Alloc:        ms.Alloc,
        TotalAlloc:   ms.TotalAlloc,
        Sys:          ms.Sys,
        NumGC:        ms.NumGC,
        GCPauseTotal: time.Duration(ms.PauseTotalNs),
        HeapObjects:  ms.HeapObjects,
    }
}

// Monitor logs memory stats periodically and alerts on anomalies
func Monitor(ctx context.Context, interval time.Duration, threshold uint64) {
    var prev Stats
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            curr := Collect()

            if prev.NumGC > 0 {
                allocDelta := curr.TotalAlloc - prev.TotalAlloc
                allocRate := float64(allocDelta) / interval.Seconds()

                slog.Info("memory stats",
                    "heap_alloc_mb", curr.Alloc/1024/1024,
                    "heap_objects", curr.HeapObjects,
                    "gc_count", curr.NumGC-prev.NumGC,
                    "alloc_rate_mb_s", allocRate/1024/1024,
                )

                if curr.Alloc > threshold {
                    slog.Warn("heap usage exceeds threshold",
                        "current_mb", curr.Alloc/1024/1024,
                        "threshold_mb", threshold/1024/1024,
                    )
                }
            }

            prev = curr
        }
    }
}
```

## Section 8: Practical Optimization Checklist

```go
// Allocation audit tool for HTTP handlers
func allocationAuditMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var before, after runtime.MemStats
        runtime.ReadMemStats(&before)

        next.ServeHTTP(w, r)

        runtime.ReadMemStats(&after)

        allocs := after.Mallocs - before.Mallocs
        allocBytes := after.TotalAlloc - before.TotalAlloc

        if allocs > 100 {
            slog.Warn("high allocation count",
                "path", r.URL.Path,
                "allocs", allocs,
                "bytes", allocBytes,
            )
        }
    })
}
```

### Common Optimization Patterns Summary

```go
// 1. Pre-allocate slices
results := make([]Result, 0, expectedSize)  // vs var results []Result

// 2. Reuse slices across calls
func process(buf *[]byte, input []byte) {
    *buf = (*buf)[:0]  // Reset without reallocating
    *buf = append(*buf, processInput(input)...)
}

// 3. Use value receivers for small structs
func (p Point) Distance() float64 { ... }  // Not *Point

// 4. Avoid fmt.Sprintf for simple concatenations
// Bad:
id := fmt.Sprintf("user-%d", userID)
// Good:
id := "user-" + strconv.Itoa(userID)

// 5. Avoid fmt.Errorf in hot paths
// Bad:
return fmt.Errorf("processing user %d: %w", id, err)
// Good (if errors are infrequent):
return &ProcessingError{UserID: id, Cause: err}

// 6. Use encoding/json alternatives for high throughput
// Consider: github.com/bytedance/sonic or github.com/json-iterator/go

// 7. Prefer byte slice operations over string operations
// strings.Contains requires string conversion
// bytes.Contains works directly on []byte

// 8. Close over values, not variables
for _, v := range items {
    v := v  // Capture loop variable
    go func() { process(v) }()
}
```

## Section 9: GC Tuning for Different Workloads

### Latency-Sensitive Services (APIs, Real-Time)

```bash
# Reduce heap target so GC runs more frequently but with smaller pauses
GOGC=50 GOMEMLIMIT=2GiB ./api-server

# Enable GC tracing during tuning
GODEBUG=gccheckmark=1,gcpacertrace=1 ./api-server 2>&1 | head -100
```

### Throughput-Optimized Services (Batch Processing)

```bash
# Less frequent GC, allow larger heap
GOGC=500 GOMEMLIMIT=8GiB ./batch-processor

# Force a GC between batches if memory should be reclaimed
runtime.GC()
debug.FreeOSMemory()  # Returns memory to OS
```

### Steady-State Services (Databases, Message Queues)

```bash
# Use GOMEMLIMIT to prevent OOM without setting GOGC
GOMEMLIMIT=4GiB ./database-proxy

# Adaptive GC: let GOMEMLIMIT handle it
# Default GOGC=100 with GOMEMLIMIT is often optimal
```

## Section 10: Diagnosing Memory Leaks

```bash
# Check for goroutine leaks (held references prevent GC)
curl http://localhost:6060/debug/pprof/goroutine?debug=2 | head -100

# Compare heap profiles over time
curl http://localhost:6060/debug/pprof/heap > heap1.pb.gz
sleep 60
curl http://localhost:6060/debug/pprof/heap > heap2.pb.gz

# Diff the two profiles
go tool pprof -base=heap1.pb.gz heap2.pb.gz
```

```go
// Detect goroutine leaks in tests
func TestNoGoroutineLeak(t *testing.T) {
    before := runtime.NumGoroutine()

    // Run test
    runSomeOperation()

    // Allow goroutines to settle
    time.Sleep(100 * time.Millisecond)
    runtime.GC()

    after := runtime.NumGoroutine()
    if after > before+1 {
        t.Errorf("goroutine leak: started with %d, now have %d", before, after)
        buf := make([]byte, 65536)
        buf = buf[:runtime.Stack(buf, true)]
        t.Logf("Goroutines:\n%s", buf)
    }
}
```

## Conclusion

Effective Go memory management is a layered discipline. The foundation is understanding escape analysis well enough to write code that keeps hot-path objects on the stack. The next layer is `sync.Pool` for the objects that must escape but are frequently created and discarded. On top of that is `GOGC` and `GOMEMLIMIT` tuning to match the GC behavior to your service's latency and throughput requirements.

The experimental arena allocator represents the next evolution for workloads with bulk-allocate, bulk-free patterns — but it requires careful use to avoid holding arena references past their intended lifetime. For most production Go services, understanding escape analysis, applying `sync.Pool` to high-frequency allocations, and setting `GOMEMLIMIT` to match container limits will deliver 30-60% reduction in GC overhead with minimal code complexity.
