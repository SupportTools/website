---
title: "Go Performance Profiling: pprof, Trace, and Memory Optimization in Production"
date: 2028-02-17T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Performance", "Profiling", "pprof", "Memory", "Optimization"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go performance profiling using pprof and execution tracer for CPU, heap, goroutine, and mutex profiling in production. Covers GOGC/GOMEMLIMIT tuning, escape analysis, sync.Pool, and flamegraph analysis."
more_link: "yes"
url: "/golang-performance-profiling-guide/"
---

Performance problems in Go services often manifest in production long after they are invisible in testing. A service that performs acceptably at 100 requests per second may exhibit latency spikes, GC pauses, or excessive memory consumption at 1000 RPS. Identifying and resolving these issues requires systematic profiling using Go's built-in tooling: the `pprof` endpoint for CPU and heap profiles, the execution tracer for goroutine scheduling visibility, and escape analysis to understand allocation patterns.

This guide covers the complete profiling workflow from enabling endpoints safely in production, through capturing and interpreting profiles, to implementing the optimizations they reveal—including GOGC/GOMEMLIMIT tuning, sync.Pool for allocation reduction, and escape analysis techniques.

<!--more-->

# Go Performance Profiling: pprof, Trace, and Memory Optimization in Production

## Enabling pprof in Production

### Secure pprof Endpoint

The standard `net/http/pprof` import exposes profiling endpoints on the default HTTP mux. In production services, expose these on a separate port accessible only within the cluster:

```go
// main.go
// Exposes pprof on a dedicated port, separate from the application
// server. The debug port is bound to localhost and exposed only
// within the cluster via a separate ClusterIP service.
package main

import (
    "fmt"
    "log"
    "net"
    "net/http"
    _ "net/http/pprof"    // Side-effect import: registers handlers on DefaultServeMux
    "os"
    "time"
)

func main() {
    // Application server: exposed publicly
    appMux := http.NewServeMux()
    appMux.HandleFunc("/", handleRequest)
    appMux.HandleFunc("/health", handleHealth)

    // Debug server: exposed only within the cluster
    // Bound to all interfaces on a separate port; protected by
    // NetworkPolicy limiting access to monitoring namespace.
    debugMux := http.NewServeMux()
    debugMux.Handle("/debug/pprof/", http.DefaultServeMux)  // pprof handlers
    debugMux.Handle("/debug/vars", http.DefaultServeMux)    // expvar

    appPort := envOrDefault("PORT", "8080")
    debugPort := envOrDefault("DEBUG_PORT", "6060")

    go func() {
        log.Printf("Debug server listening on :%s", debugPort)
        if err := http.ListenAndServe(":"+debugPort, debugMux); err != nil {
            log.Fatalf("debug server failed: %v", err)
        }
    }()

    log.Printf("Application server listening on :%s", appPort)
    if err := http.ListenAndServe(":"+appPort, appMux); err != nil {
        log.Fatalf("application server failed: %v", err)
    }
}

func envOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

### Available pprof Endpoints

```bash
# pprof provides these endpoints on the debug mux:

# CPU profile: captures stack samples for 30 seconds
# High-value first step; shows where CPU time is spent
curl "http://pod-ip:6060/debug/pprof/profile?seconds=30" -o cpu.prof

# Heap profile: current live objects on the heap
# Shows allocation sources; useful for memory leak investigation
curl "http://pod-ip:6060/debug/pprof/heap" -o heap.prof

# Goroutine profile: all goroutines with their stack traces
# Essential for goroutine leak detection
curl "http://pod-ip:6060/debug/pprof/goroutine?debug=2" -o goroutine.txt

# Mutex profile: where goroutines block waiting for mutexes
# Requires runtime.SetMutexProfileFraction(1) to enable sampling
curl "http://pod-ip:6060/debug/pprof/mutex" -o mutex.prof

# Block profile: where goroutines block on channel operations
# Requires runtime.SetBlockProfileRate(1) to enable
curl "http://pod-ip:6060/debug/pprof/block" -o block.prof

# Allocation profile: all allocations since program start (not just live)
# Shows hottest allocation sites; differs from heap (which shows live only)
curl "http://pod-ip:6060/debug/pprof/allocs" -o allocs.prof

# Execution trace: low-overhead trace for scheduler/GC analysis
# Captures 5 seconds of execution trace
curl "http://pod-ip:6060/debug/pprof/trace?seconds=5" -o trace.out

# Thread create profile
curl "http://pod-ip:6060/debug/pprof/threadcreate" -o threads.prof
```

### Enabling Mutex and Block Profiling at Startup

```go
// profiling_setup.go
// Configure profiling rates at application startup.
// These affect performance: set rates appropriately for production.
package main

import (
    "runtime"
)

func configureProfiling() {
    // Mutex profiling: fraction 1 = sample every mutex contention event.
    // In high-throughput services, use fraction 10 or 100 to reduce overhead.
    // 0 = disabled (default).
    runtime.SetMutexProfileFraction(1)

    // Block profiling: rate in nanoseconds.
    // SetBlockProfileRate(1) = sample every blocking event (high overhead).
    // SetBlockProfileRate(1000) = sample block events > 1 microsecond.
    // 0 = disabled (default).
    runtime.SetBlockProfileRate(1000)  // Sample events blocking > 1µs

    // GOMAXPROCS: defaults to number of CPUs; rarely needs tuning.
    // Override only for CPU-throttled containers (cgroups v2 aware since Go 1.19).
    // go.uber.org/automaxprocs adjusts this based on cgroup CPU quota.
}
```

## Capturing Profiles Programmatically

### Programmatic CPU Profiling

```go
// profiler/cpu.go
// Utility for capturing CPU profiles programmatically.
// Useful for profiling specific code paths rather than whole-service profiles.
package profiler

import (
    "fmt"
    "os"
    "runtime/pprof"
    "time"
)

// CPUProfile captures a CPU profile for the given duration.
// Returns the profile file path.
func CPUProfile(duration time.Duration, outputPath string) (string, error) {
    if outputPath == "" {
        outputPath = fmt.Sprintf("/tmp/cpu-%d.prof", time.Now().Unix())
    }

    f, err := os.Create(outputPath)
    if err != nil {
        return "", fmt.Errorf("create profile file: %w", err)
    }
    defer f.Close()

    // Start CPU profiling; pprof samples goroutine stacks at 100Hz
    if err := pprof.StartCPUProfile(f); err != nil {
        return "", fmt.Errorf("start cpu profile: %w", err)
    }

    // Run for the specified duration
    time.Sleep(duration)

    // Stop and flush profile to the file
    pprof.StopCPUProfile()

    return outputPath, nil
}

// HeapProfile captures the current heap state.
// Captures allocations in use at the time of the call.
func HeapProfile(outputPath string) (string, error) {
    if outputPath == "" {
        outputPath = fmt.Sprintf("/tmp/heap-%d.prof", time.Now().Unix())
    }

    f, err := os.Create(outputPath)
    if err != nil {
        return "", fmt.Errorf("create heap file: %w", err)
    }
    defer f.Close()

    // Force garbage collection before heap profile to get accurate live data
    // This ensures the profile reflects actual live allocations, not GC-eligible objects
    runtime.GC()

    // Write heap profile to file
    if err := pprof.WriteHeapProfile(f); err != nil {
        return "", fmt.Errorf("write heap profile: %w", err)
    }

    return outputPath, nil
}

// GoroutineProfile dumps all goroutine stacks.
// Essential for detecting goroutine leaks.
func GoroutineProfile(outputPath string) (string, error) {
    if outputPath == "" {
        outputPath = fmt.Sprintf("/tmp/goroutine-%d.txt", time.Now().Unix())
    }

    f, err := os.Create(outputPath)
    if err != nil {
        return "", fmt.Errorf("create goroutine file: %w", err)
    }
    defer f.Close()

    // debug=2 provides full goroutine stacks with labels
    p := pprof.Lookup("goroutine")
    if err := p.WriteTo(f, 2); err != nil {
        return "", fmt.Errorf("write goroutine profile: %w", err)
    }

    return outputPath, nil
}
```

## Analyzing CPU Profiles

### Interactive pprof Analysis

```bash
# Open an interactive pprof session
go tool pprof cpu.prof

# Common interactive commands:
# top15       - Show top 15 CPU-consuming functions
# top15 -cum  - Sort by cumulative time (includes callees)
# list <func> - Show annotated source for a function
# web         - Open flamegraph in browser (requires graphviz)
# peek <func> - Show callers and callees of a function

# Example session:
(pprof) top15
Showing nodes accounting for 4.23s, 89.24% of 4.74s total
Dropped 68 nodes (cum <= 0.02s)
Showing top 15 nodes out of 89
      flat  flat%   sum%        cum   cum%
     1.23s 25.95% 25.95%      1.23s 25.95%  runtime.mallocgc
     0.89s 18.78% 44.73%      0.89s 18.78%  encoding/json.Marshal
     0.56s 11.81% 56.54%      0.56s 11.81%  strings.(*Builder).WriteString
     0.43s  9.07% 65.61%      1.62s 34.18%  myapp.processRequest
     0.31s  6.54% 72.15%      0.31s  6.54%  sync.(*Mutex).Lock
     ...

# flat%: CPU time spent IN this function
# cum%: CPU time spent IN this function AND all functions it calls
# 25.95% in mallocgc indicates excessive heap allocation

# Generate flamegraph SVG
go tool pprof -svg cpu.prof > cpu-flamegraph.svg

# Generate flamegraph for web viewing (opens browser)
go tool pprof -http=:8080 cpu.prof
```

### CPU Profile Interpretation

```bash
# Common patterns and what they indicate:

# Pattern 1: High mallocgc
# Symptom: mallocgc appears in top functions
# Cause: excessive heap allocation
# Action: heap profile to find allocation sites, then reduce/pool allocations

# Pattern 2: High GC functions (runtime.gcBgMarkWorker, runtime.sweepone)
# Symptom: >10% CPU in GC
# Cause: too much heap allocation pressure
# Action: increase GOGC, add GOMEMLIMIT, reduce allocations

# Pattern 3: Lock contention (sync.Mutex.Lock, sync.RWMutex.RLock)
# Symptom: significant time in mutex functions
# Cause: high contention on shared data
# Action: mutex profile, then reduce lock scope or use lock-free structures

# Pattern 4: JSON encoding (encoding/json.Marshal)
# Symptom: json functions dominate
# Cause: reflection-based JSON serialization
# Action: switch to code-generated serializers (easyjson, sonic, jsoniter)

# Drill into a specific function
(pprof) list processRequest
Total: 4.74s
ROUTINE ======================== myapp.processRequest in /app/handler.go
    430ms      1.62s (flat, cum) 34.18% of Total
         .          .     45: func processRequest(w http.ResponseWriter, r *http.Request) {
      10ms       10ms     46:     data, err := io.ReadAll(r.Body)
         .          .     47:     if err != nil {
         .          .     48:         http.Error(w, err.Error(), 500)
         .          .     49:         return
         .          .     50:     }
      20ms      150ms     51:     var req RequestPayload
     390ms      390ms     52:     if err := json.Unmarshal(data, &req); err != nil {  // HOT: 390ms flat
         .          .     53:         http.Error(w, err.Error(), 400)
         .          .     54:         return
         .          .     55:     }
      10ms      990ms     56:     result := processLogic(&req)                        // HOT: 990ms cum
```

## Heap Profile Analysis

### Finding Memory Leaks

```bash
# Capture two heap profiles 60 seconds apart
curl "http://pod-ip:6060/debug/pprof/heap" -o heap1.prof
sleep 60
curl "http://pod-ip:6060/debug/pprof/heap" -o heap2.prof

# Compare profiles to find growing allocations
# inuse_space: memory in use (live objects)
# alloc_space: all allocations since start (includes freed)
go tool pprof -base heap1.prof heap2.prof

(pprof) top20 -cum
# Functions with increasing inuse_space between samples
# indicate memory leaks or growing caches

# Visualize heap growth
(pprof) web inuse_space

# Check specific allocation sites
(pprof) list cacheGet
```

### Heap Profile Types

```bash
# Go heap profiles have four sample types:

# inuse_space: bytes of live (in-use) objects currently on heap
# This is the default for heap profiles
go tool pprof -inuse_space heap.prof

# inuse_objects: count of live objects (not bytes)
# Useful when many small objects dominate
go tool pprof -inuse_objects heap.prof

# alloc_space: total bytes allocated since program start
# Use this to find hot allocation sites, even for short-lived objects
go tool pprof -alloc_space heap.prof

# alloc_objects: count of all allocations since start
go tool pprof -alloc_objects heap.prof

# For leak detection, focus on inuse_space comparison
# For CPU/GC pressure, focus on alloc_space
```

## Execution Tracer

The execution tracer provides nanosecond-resolution visibility into goroutine scheduling, GC phases, and system calls:

```bash
# Capture a 5-second execution trace
curl "http://pod-ip:6060/debug/pprof/trace?seconds=5" -o trace.out

# Open the trace viewer in a browser
# This starts a local HTTP server and opens Chrome's trace viewer
go tool trace trace.out

# The trace viewer shows:
# - Goroutine states (running, runnable, waiting)
# - GC events (mark phase, sweep phase)
# - Heap size over time
# - System calls
# - Network events
```

### Programmatic Tracing

```go
// tracing.go
// Capture execution trace for specific code paths.
// Useful for understanding goroutine scheduling in tight loops.
package main

import (
    "os"
    "runtime/trace"
    "time"
)

func captureTrace(duration time.Duration) error {
    f, err := os.Create("trace.out")
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

// Task and Region annotations help identify specific operations in traces.
// Regions mark spans within a goroutine; tasks span multiple goroutines.
func processWithTracing(ctx context.Context, items []WorkItem) error {
    // Create a task that spans the entire processing operation
    ctx, task := trace.NewTask(ctx, "processItems")
    defer task.End()

    for _, item := range items {
        // Create a region within the task for each item
        trace.WithRegion(ctx, "processItem", func() {
            processItem(ctx, item)
        })
    }

    return nil
}
```

### Reading Trace Output

```bash
# Key metrics to examine in trace output:

# 1. GC Pause Duration
# Look for STW (stop-the-world) phases in the GC lane
# Target: < 1ms per GC pause in production
# High pauses indicate large heap or allocation pressure

# 2. Goroutine Scheduling Latency
# Time between runnable and running state
# High latency indicates GOMAXPROCS undersizing or CPU saturation

# 3. Heap Growth Rate
# Heap shown in the trace timeline
# Steady growth indicates a leak; sawtooth pattern is normal GC

# Command-line trace analysis (no browser required)
go tool trace -pprof=net trace.out | go tool pprof -

# Network blocking profile from trace
go tool trace -pprof=sync trace.out | go tool pprof -

# Syscall blocking profile from trace
go tool trace -pprof=syscall trace.out | go tool pprof -
```

## Escape Analysis

Escape analysis determines whether variables are allocated on the stack (cheap) or heap (GC pressure). Understanding it reveals optimization opportunities.

### Viewing Escape Decisions

```bash
# Build with escape analysis output
# -gcflags="-m" shows escape decisions
# -gcflags="-m -m" shows more detail
# -gcflags="-m=2" is equivalent to -m -m

go build -gcflags="-m" ./...

# Example output:
# ./handler.go:45:15: request escapes to heap
# ./handler.go:67:12: &buf does not escape
# ./handler.go:89:23: func literal escapes to heap
# ./handler.go:102:9: result does not escape

# Key patterns to look for:
# "escapes to heap" - allocated on heap, contributes to GC
# "does not escape" - stack allocated, zero GC cost
# "moved to heap"   - initially planned for stack but too large
```

### Common Escape Causes and Fixes

```go
// escape_examples.go
// Demonstrates common escape patterns and how to avoid them.
package main

import (
    "fmt"
    "sync"
)

// --- Pattern 1: Interface boxing causes heap allocation ---

// BAD: Passing int as interface{} causes it to escape to heap
// Each call allocates ~16 bytes for the interface header
func logValueBad(val interface{}) {
    _ = fmt.Sprintf("%v", val)
}

// GOOD: Use concrete types in hot paths
// Or use fmt.Sprintf directly which has some fast paths for basic types
func logValueGood(val int) {
    _ = fmt.Sprintf("%d", val)
}

// --- Pattern 2: Returning pointer to local variable ---

// BAD: &RequestContext{} escapes because it's returned
// The compiler must heap-allocate to ensure it outlives the function
func newContextBad() *RequestContext {
    ctx := RequestContext{ID: "test"}  // ctx escapes to heap
    return &ctx
}

// GOOD: Accept a pointer parameter and fill it in
// The caller controls allocation (can be stack-allocated)
func newContextGood(ctx *RequestContext) {
    ctx.ID = "test"
}

// --- Pattern 3: Closures capturing variables ---

// BAD: The closure captures i, causing i to escape to heap
// because the closure's lifetime may exceed the loop iteration
func processBad(items []int) []func() int {
    results := make([]func() int, len(items))
    for i, v := range items {
        i, v := i, v   // Shadowing avoids the loop variable capture issue
        results[i] = func() int { return v }  // v escapes to heap
    }
    return results
}

// GOOD: For simple cases, avoid closures in hot paths
// Use a struct method or pass the value explicitly
type processor struct{ v int }
func (p processor) compute() int { return p.v * 2 }

// --- Pattern 4: Growing slices beyond compile-time size ---

// BAD: append may cause reallocation, and large slices escape
func buildSliceBad(n int) []byte {
    var buf []byte               // Escapes if it grows large
    for i := 0; i < n; i++ {
        buf = append(buf, byte(i))
    }
    return buf
}

// GOOD: Pre-allocate with known capacity to reduce reallocations
func buildSliceGood(n int) []byte {
    buf := make([]byte, 0, n)    // Allocate exactly what is needed
    for i := 0; i < n; i++ {
        buf = append(buf, byte(i))
    }
    return buf
}

// --- Pattern 5: sync.Map vs map with sync.RWMutex ---
// sync.Map stores values as interface{}, causing allocations
// Use map+RWMutex for typed caches to avoid boxing

type TypedCache struct {
    mu    sync.RWMutex
    items map[string]string    // No interface boxing
}

func (c *TypedCache) Get(key string) (string, bool) {
    c.mu.RLock()
    v, ok := c.items[key]
    c.mu.RUnlock()
    return v, ok
}

func (c *TypedCache) Set(key, value string) {
    c.mu.Lock()
    c.items[key] = value
    c.mu.Unlock()
}
```

## sync.Pool for Allocation Reduction

`sync.Pool` caches temporary objects for reuse across goroutines, dramatically reducing allocation pressure in hot paths:

```go
// pool_usage.go
// Demonstrates sync.Pool patterns for reducing allocations.
// sync.Pool is appropriate for frequently allocated/freed objects.
// Objects in the pool may be evicted by the GC at any time.
package main

import (
    "bytes"
    "encoding/json"
    "net/http"
    "sync"
)

// --- Pattern 1: Buffer pool for JSON encoding ---

// bufferPool reuses byte buffers to avoid allocation in every request.
// Without pooling, each JSON marshal would allocate a new buffer.
var bufferPool = sync.Pool{
    New: func() interface{} {
        // Create a new buffer with a reasonable initial capacity.
        // This allocation runs only when the pool is empty.
        return bytes.NewBuffer(make([]byte, 0, 4096))
    },
}

func marshalWithPool(v interface{}) ([]byte, error) {
    // Borrow a buffer from the pool
    buf := bufferPool.Get().(*bytes.Buffer)
    defer func() {
        // Reset the buffer (clears content, keeps allocated memory)
        // Return to pool for the next user
        buf.Reset()
        bufferPool.Put(buf)
    }()

    enc := json.NewEncoder(buf)
    if err := enc.Encode(v); err != nil {
        return nil, err
    }

    // Return a copy of the buffer contents.
    // The original buffer goes back to the pool.
    result := make([]byte, buf.Len())
    copy(result, buf.Bytes())
    return result, nil
}

// --- Pattern 2: Request context pool ---

// RequestContext holds per-request state.
// Pooling eliminates repeated allocation/GC for high-throughput handlers.
type RequestContext struct {
    UserID    string
    RequestID string
    Headers   map[string]string
    Tags      []string
    errors    []error
}

func (rc *RequestContext) Reset() {
    rc.UserID = ""
    rc.RequestID = ""
    // Clear map without deallocating (keep capacity)
    for k := range rc.Headers {
        delete(rc.Headers, k)
    }
    // Truncate slices without deallocating
    rc.Tags = rc.Tags[:0]
    rc.errors = rc.errors[:0]
}

var requestContextPool = sync.Pool{
    New: func() interface{} {
        return &RequestContext{
            Headers: make(map[string]string, 16),
            Tags:    make([]string, 0, 8),
            errors:  make([]error, 0, 4),
        }
    },
}

func handleRequestPooled(w http.ResponseWriter, r *http.Request) {
    // Get context from pool
    ctx := requestContextPool.Get().(*RequestContext)
    defer func() {
        ctx.Reset()
        requestContextPool.Put(ctx)
    }()

    // Fill context from request
    ctx.UserID = r.Header.Get("X-User-ID")
    ctx.RequestID = r.Header.Get("X-Request-ID")

    // Process using ctx (stack allocated via pool, zero GC cost)
    processRequest(w, r, ctx)
}

// --- Pattern 3: Decoder pool for JSON parsing ---

// jsonDecoderPool avoids allocating a new json.Decoder per request.
// Note: bytes.Reader is also pooled to avoid the io.Reader boxing.
type decoderWrapper struct {
    dec *json.Decoder
    buf *bytes.Reader
}

var decoderPool = sync.Pool{
    New: func() interface{} {
        buf := bytes.NewReader(nil)
        return &decoderWrapper{
            dec: json.NewDecoder(buf),
            buf: buf,
        }
    },
}

func decodeJSONWithPool(data []byte, v interface{}) error {
    dw := decoderPool.Get().(*decoderWrapper)
    defer decoderPool.Put(dw)

    dw.buf.Reset(data)          // Reset reader to new data
    dw.dec = json.NewDecoder(dw.buf)  // Reset decoder
    return dw.dec.Decode(v)
}
```

## GOGC and GOMEMLIMIT Tuning

### Understanding GOGC

```go
// gc_tuning.go
// Demonstrates GC tuning strategies.
// GOGC controls the heap growth trigger.
package main

import (
    "runtime"
    "runtime/debug"
)

func init() {
    // GOGC=100 (default): trigger GC when heap doubles
    // GOGC=200: trigger GC when heap triples (less frequent GC, more memory)
    // GOGC=50: trigger GC when heap grows 50% (more frequent GC, less memory)
    //
    // For memory-rich environments: increase GOGC to reduce GC frequency
    // For memory-constrained environments: keep default or decrease

    // Set via environment: GOGC=200
    // Or programmatically:
    debug.SetGCPercent(200)

    // GOMEMLIMIT (Go 1.19+): hard limit on total Go memory
    // Prevents OOM kills by triggering GC before reaching the limit
    // More effective than GOGC alone for containerized deployments
    //
    // Set via environment: GOMEMLIMIT=512MiB
    // Or programmatically:
    debug.SetMemoryLimit(512 * 1024 * 1024)  // 512MB hard limit
}

// GC tuning recommendations:

// For CPU-bound services with abundant memory:
// GOGC=300, GOMEMLIMIT=container_limit * 0.9
// Less GC, more CPU for actual work

// For memory-constrained services:
// GOGC=off (disables periodic GC), GOMEMLIMIT=container_limit * 0.8
// GC only triggers when approaching GOMEMLIMIT

// For latency-sensitive services:
// GOGC=100 (default), GOMEMLIMIT=container_limit * 0.9
// Frequent small GC pauses are better than infrequent large ones

// Monitoring GC health
func gcStats() runtime.MemStats {
    var stats runtime.MemStats
    runtime.ReadMemStats(&stats)
    return stats
}

// Key metrics from MemStats:
// NumGC:       total GC cycles
// PauseNs:     circular buffer of last 256 GC pause durations
// PauseTotalNs: total time spent in GC pauses
// HeapAlloc:   current live heap bytes
// HeapSys:     heap bytes obtained from OS
// HeapIdle:    bytes in idle spans
// HeapInuse:   bytes in in-use spans
// NumGoroutine: current goroutine count (from runtime.NumGoroutine())
// NextGC:      target heap size for next GC trigger
```

### Prometheus Metrics for GC Monitoring

```go
// gc_metrics.go
// Exposes GC metrics via Prometheus for production monitoring.
package metrics

import (
    "runtime"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    gcPauseHistogram = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "go_gc_pause_seconds",
        Help:    "GC pause duration in seconds",
        Buckets: prometheus.ExponentialBuckets(0.0001, 2, 15), // 0.1ms to 3.2s
    })

    gcCycleCounter = promauto.NewCounter(prometheus.CounterOpts{
        Name: "go_gc_cycles_total",
        Help: "Total number of GC cycles",
    })

    heapAllocGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_memory_heap_alloc_bytes",
        Help: "Current heap allocation in bytes",
    })

    goroutineGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines",
        Help: "Current number of goroutines",
    })
)

// StartGCMetricsCollector samples GC stats every 10 seconds.
// More frequent sampling is possible but adds overhead.
func StartGCMetricsCollector() {
    var lastNumGC uint32

    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()

        for range ticker.C {
            var stats runtime.MemStats
            runtime.ReadMemStats(&stats)

            // Record new GC pauses since last sample
            newGCs := stats.NumGC - lastNumGC
            if newGCs > 0 {
                // The most recent pause durations are in PauseNs
                for i := uint32(0); i < newGCs && i < 256; i++ {
                    pauseIdx := (stats.NumGC - i - 1) % 256
                    pauseDuration := float64(stats.PauseNs[pauseIdx]) / 1e9
                    gcPauseHistogram.Observe(pauseDuration)
                }
                gcCycleCounter.Add(float64(newGCs))
            }
            lastNumGC = stats.NumGC

            heapAllocGauge.Set(float64(stats.HeapAlloc))
            goroutineGauge.Set(float64(runtime.NumGoroutine()))
        }
    }()
}
```

## String Interning for Memory Reduction

Repeated identical strings in memory waste heap space. String interning ensures each unique string value is stored once:

```go
// string_intern.go
// String interning reduces heap usage when the same string values
// appear repeatedly (e.g., HTTP header names, metric labels).
package intern

import (
    "sync"
)

// Interner maintains a map of interned strings.
// Thread-safe via RWMutex.
type Interner struct {
    mu    sync.RWMutex
    table map[string]string
}

// NewInterner creates an Interner with an initial capacity hint.
func NewInterner(initialCapacity int) *Interner {
    return &Interner{
        table: make(map[string]string, initialCapacity),
    }
}

// Intern returns a canonical string for the given value.
// If the value has been seen before, the same string instance is returned.
// For new values, the string is stored and returned.
func (in *Interner) Intern(s string) string {
    // Fast path: check read lock first
    in.mu.RLock()
    canonical, exists := in.table[s]
    in.mu.RUnlock()

    if exists {
        return canonical
    }

    // Slow path: acquire write lock and store
    in.mu.Lock()
    defer in.mu.Unlock()

    // Double-check after acquiring write lock
    if canonical, exists = in.table[s]; exists {
        return canonical
    }

    in.table[s] = s
    return s
}

// Size returns the number of interned strings.
func (in *Interner) Size() int {
    in.mu.RLock()
    defer in.mu.RUnlock()
    return len(in.table)
}

// Usage example: interning HTTP header names
// Without interning: each request creates new string instances for known headers
// With interning: thousands of requests share the same string objects

var headerInterner = NewInterner(64)

func normalizeHeaderName(name string) string {
    return headerInterner.Intern(name)
}
```

## Benchmarking to Validate Optimizations

```go
// handler_bench_test.go
// Benchmarks to validate that profiling-driven optimizations
// produce measurable improvements.
package main

import (
    "bytes"
    "net/http"
    "net/http/httptest"
    "testing"
)

// BenchmarkHandlerOriginal measures the original implementation
func BenchmarkHandlerOriginal(b *testing.B) {
    payload := []byte(`{"user_id": "u123", "action": "purchase", "amount": 99.99}`)

    b.ResetTimer()
    b.ReportAllocs()   // Report allocation count and bytes per operation

    for i := 0; i < b.N; i++ {
        req := httptest.NewRequest(http.MethodPost, "/api/event",
            bytes.NewReader(payload))
        req.Header.Set("Content-Type", "application/json")
        w := httptest.NewRecorder()
        handleRequestOriginal(w, req)
    }
}

// BenchmarkHandlerOptimized measures the optimized implementation
// Expected: significant reduction in allocs/op after applying:
// - sync.Pool for request context
// - Pre-allocated JSON decoder
// - Reduced interface boxing
func BenchmarkHandlerOptimized(b *testing.B) {
    payload := []byte(`{"user_id": "u123", "action": "purchase", "amount": 99.99}`)

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        req := httptest.NewRequest(http.MethodPost, "/api/event",
            bytes.NewReader(payload))
        req.Header.Set("Content-Type", "application/json")
        w := httptest.NewRecorder()
        handleRequestOptimized(w, req)
    }
}

// Run benchmarks and compare:
// go test -bench=BenchmarkHandler -benchmem -count=5 ./...
//
// Expected output comparison:
// BenchmarkHandlerOriginal   50000   28456 ns/op   4892 B/op   67 allocs/op
// BenchmarkHandlerOptimized  200000   7123 ns/op    892 B/op   12 allocs/op
//
// Use benchstat to statistically compare:
// go test -bench=. -benchmem -count=10 ./... > old.txt
// (after optimization)
// go test -bench=. -benchmem -count=10 ./... > new.txt
// benchstat old.txt new.txt
```

## Production Profiling Workflow

```bash
#!/bin/bash
# profile-production.sh
# Complete workflow for capturing and analyzing production profiles.
# Run against a single pod instance to minimize impact.

POD_NAME="${1}"
NAMESPACE="${2:-production}"
DEBUG_PORT="6060"

echo "=== Profiling ${NAMESPACE}/${POD_NAME} ==="

# Forward debug port to local machine
kubectl port-forward \
  "pod/${POD_NAME}" \
  "${DEBUG_PORT}:${DEBUG_PORT}" \
  -n "${NAMESPACE}" &
PF_PID=$!

# Give port-forward time to establish
sleep 2

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PROFILE_DIR="profiles/${POD_NAME}-${TIMESTAMP}"
mkdir -p "${PROFILE_DIR}"

echo "Capturing 30s CPU profile..."
curl -s "http://localhost:${DEBUG_PORT}/debug/pprof/profile?seconds=30" \
  -o "${PROFILE_DIR}/cpu.prof"

echo "Capturing heap profile..."
curl -s "http://localhost:${DEBUG_PORT}/debug/pprof/heap" \
  -o "${PROFILE_DIR}/heap.prof"

echo "Capturing goroutine profile..."
curl -s "http://localhost:${DEBUG_PORT}/debug/pprof/goroutine?debug=2" \
  -o "${PROFILE_DIR}/goroutines.txt"

echo "Capturing 5s execution trace..."
curl -s "http://localhost:${DEBUG_PORT}/debug/pprof/trace?seconds=5" \
  -o "${PROFILE_DIR}/trace.out"

echo "Capturing mutex profile..."
curl -s "http://localhost:${DEBUG_PORT}/debug/pprof/mutex" \
  -o "${PROFILE_DIR}/mutex.prof"

# Cleanup port-forward
kill "${PF_PID}" 2>/dev/null

echo ""
echo "=== Profile Summary ==="
echo "CPU profile:       ${PROFILE_DIR}/cpu.prof"
echo "  Analysis: go tool pprof -http=:8080 ${PROFILE_DIR}/cpu.prof"
echo ""
echo "Heap profile:      ${PROFILE_DIR}/heap.prof"
echo "  Analysis: go tool pprof -http=:8081 ${PROFILE_DIR}/heap.prof"
echo ""
echo "Goroutines:        ${PROFILE_DIR}/goroutines.txt"
echo "  Analysis: grep -c 'goroutine ' ${PROFILE_DIR}/goroutines.txt"
echo ""
echo "Trace:             ${PROFILE_DIR}/trace.out"
echo "  Analysis: go tool trace ${PROFILE_DIR}/trace.out"

# Quick goroutine count
goroutine_count=$(grep -c "^goroutine " "${PROFILE_DIR}/goroutines.txt" 2>/dev/null || echo 0)
echo ""
echo "Goroutine count: ${goroutine_count}"
if [ "${goroutine_count}" -gt 10000 ]; then
    echo "WARNING: High goroutine count may indicate a goroutine leak"
fi
```

## Summary

Effective Go performance profiling in production follows a systematic process: enable pprof on a dedicated debug port protected by NetworkPolicy, capture CPU and heap profiles under real load, analyze them in the interactive pprof tool or flamegraph viewer, identify the top CPU consumers and highest allocation sites, then apply targeted optimizations.

The most impactful optimizations revealed by profiling are typically: reducing heap allocations through sync.Pool and pre-allocation (reduces GC pressure), avoiding interface boxing in hot paths (reduces mallocgc time), replacing reflection-based JSON with code-generated serializers (eliminates the dominant JSON cost), and tuning GOGC/GOMEMLIMIT to match the service's memory-latency tradeoff. The execution tracer provides the scheduler-level visibility needed to diagnose goroutine scheduling latency and GC pause impact that CPU profiles alone do not reveal.
