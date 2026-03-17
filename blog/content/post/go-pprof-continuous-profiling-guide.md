---
title: "Continuous Profiling in Go: Always-On pprof with Pyroscope, Flamegraphs, and Production Leak Detection"
date: 2028-06-14T00:00:00-05:00
draft: false
tags: ["Go", "pprof", "Pyroscope", "Profiling", "Performance", "Memory Leaks", "Observability"]
categories: ["Go", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade continuous profiling for Go services: always-on pprof integration with Pyroscope, flamegraph interpretation, heap profiling for memory leaks, goroutine leak detection, and mutex/block profiling analysis."
more_link: "yes"
url: "/go-pprof-continuous-profiling-guide/"
---

Go's built-in profiling infrastructure provides visibility that no other language runtime matches. The `pprof` package exposes CPU, memory, goroutine, mutex, and block profiles — but most teams only use it reactively, running a 30-second CPU profile when performance degrades. Continuous profiling changes this: by collecting profiles 24/7 and storing them in a time-series backend, engineers can answer questions like "which commit caused this 40% memory increase two weeks ago?" or "why did P99 latency spike during last Tuesday's deployment?"

This guide covers the complete continuous profiling stack: instrumenting Go services for always-on profiling, deploying Pyroscope for profile storage, interpreting flamegraphs, diagnosing memory leaks from heap profiles, detecting goroutine leaks, and using mutex/block profilers to find lock contention.

<!--more-->

## Go's pprof Architecture

### Profile Types

Go's runtime exposes seven profile types through `runtime/pprof`:

| Profile | What It Measures | Typical Use |
|---------|-----------------|-------------|
| cpu | Function call stacks during CPU execution | Hot paths, CPU-bound bottlenecks |
| heap | Memory allocations and live objects | Memory leaks, allocation pressure |
| goroutine | Stack traces of all goroutines | Goroutine leaks, deadlocks |
| allocs | All past allocations (since program start) | GC pressure, allocation-heavy paths |
| block | Goroutine blocking on synchronization | Channel contention, mutex waits |
| mutex | Contended mutex lock/unlock cycles | Lock contention analysis |
| threadcreate | OS thread creation events | Thread explosion debugging |

### HTTP Profiling Endpoint

The simplest way to expose profiles is importing `net/http/pprof`:

```go
package main

import (
    "net/http"
    _ "net/http/pprof" // Side-effect import registers /debug/pprof handlers
    "log"
)

func main() {
    // Profiles served at http://localhost:6060/debug/pprof/
    go func() {
        log.Fatal(http.ListenAndServe(":6060", nil))
    }()

    // Main application
    runApp()
}
```

Available endpoints:
- `/debug/pprof/` — index page
- `/debug/pprof/cpu` — 30-second CPU profile (streaming)
- `/debug/pprof/heap` — current heap state
- `/debug/pprof/goroutine` — all goroutine stacks
- `/debug/pprof/block` — goroutine blocking events
- `/debug/pprof/mutex` — mutex contention
- `/debug/pprof/allocs` — allocation profile
- `/debug/pprof/trace?seconds=5` — execution trace

### Security: Never Expose pprof Publicly

The pprof endpoint reveals function names, variable contents in goroutine stacks, and memory layout — a significant information disclosure risk. Protect it:

```go
package main

import (
    "net"
    "net/http"
    _ "net/http/pprof"
    "os"
    "log"
)

func startPprofServer() {
    // Bind to loopback only — not 0.0.0.0
    listener, err := net.Listen("tcp", "127.0.0.1:6060")
    if err != nil {
        log.Fatalf("Failed to start pprof server: %v", err)
    }

    pprofMux := http.NewServeMux()
    // Register only pprof on this mux to avoid exposing app endpoints
    pprofMux.Handle("/debug/pprof/", http.DefaultServeMux)

    go func() {
        if err := http.Serve(listener, pprofMux); err != nil {
            log.Printf("pprof server error: %v", err)
        }
    }()

    log.Printf("pprof server listening on 127.0.0.1:6060")
}
```

In Kubernetes, expose pprof via a separate containerPort not included in the Service, accessible only through `kubectl port-forward`:

```yaml
containers:
- name: myapp
  ports:
  - name: http
    containerPort: 8080
  - name: pprof
    containerPort: 6060
  # pprof port intentionally NOT in the Service spec
```

## Continuous Profiling with Pyroscope

### Architecture Overview

Pyroscope provides a time-series database for profiles. The Go SDK continuously samples the process and pushes profiles every 10 seconds (configurable). This creates a continuous profile timeline queryable by time range, service, and deployment version.

```
┌─────────────────┐    profiles/10s    ┌──────────────┐
│  Go Service     │ ─────────────────► │  Pyroscope   │
│  (SDK embedded) │                    │  Server      │
└─────────────────┘                    └──────┬───────┘
                                              │ query
                                       ┌──────▼───────┐
                                       │  Grafana     │
                                       │  Dashboard   │
                                       └──────────────┘
```

### Deploying Pyroscope on Kubernetes

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pyroscope
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pyroscope
  template:
    metadata:
      labels:
        app: pyroscope
    spec:
      containers:
      - name: pyroscope
        image: grafana/pyroscope:1.6.1
        ports:
        - containerPort: 4040
          name: http
        args:
        - server
        env:
        - name: PYROSCOPE_STORAGE_PATH
          value: /data
        volumeMounts:
        - name: data
          mountPath: /data
        resources:
          requests:
            cpu: "500m"
            memory: "2Gi"
          limits:
            cpu: "2"
            memory: "8Gi"
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: pyroscope-data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pyroscope-data
  namespace: monitoring
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: gp3
  resources:
    requests:
      storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: pyroscope
  namespace: monitoring
spec:
  selector:
    app: pyroscope
  ports:
  - port: 4040
    targetPort: 4040
    name: http
```

### Instrumenting Go Services

```go
package main

import (
    "context"
    "log"
    "os"
    "runtime"

    "github.com/grafana/pyroscope-go"
)

func initPyroscope() (*pyroscope.Profiler, error) {
    // Enable block and mutex profiling (disabled by default for performance)
    runtime.SetMutexProfileFraction(5)  // Sample 1/5 of mutex events
    runtime.SetBlockProfileRate(1000)    // Sample events blocking > 1ms

    hostname, _ := os.Hostname()

    return pyroscope.Start(pyroscope.Config{
        ApplicationName: "payment-api",
        ServerAddress:   "http://pyroscope.monitoring.svc.cluster.local:4040",

        // Tags for querying - include deployment metadata
        Tags: map[string]string{
            "host":        hostname,
            "environment": os.Getenv("ENVIRONMENT"),
            "version":     os.Getenv("APP_VERSION"),
            "region":      os.Getenv("AWS_REGION"),
        },

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

        // Upload interval - shorter = more granular, more overhead
        UploadRate: 15 * time.Second,

        // Sampling rate - 100Hz default, reduce for CPU-sensitive services
        SampleRate: 100,
    })
}

func main() {
    profiler, err := initPyroscope()
    if err != nil {
        log.Printf("Warning: failed to start Pyroscope profiler: %v", err)
        // Don't fatal — profiling failure should not crash the service
    } else {
        defer profiler.Stop()
    }

    runApp()
}
```

### Labeling Request Context for Tracing Correlation

Pyroscope supports dynamic labels that attach profiling data to specific request types:

```go
package handler

import (
    "net/http"

    "github.com/grafana/pyroscope-go"
)

func (h *APIHandler) HandlePayment(w http.ResponseWriter, r *http.Request) {
    // Tag this goroutine's CPU time with the endpoint name
    // This allows filtering flamegraphs by endpoint
    pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
        "endpoint", "/api/payment",
        "method", r.Method,
    ), func(ctx context.Context) {
        h.processPayment(ctx, w, r)
    })
}

func (h *APIHandler) HandleSearch(w http.ResponseWriter, r *http.Request) {
    pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
        "endpoint", "/api/search",
        "method", r.Method,
    ), func(ctx context.Context) {
        h.processSearch(ctx, w, r)
    })
}
```

## Flamegraph Interpretation

### Reading Flamegraphs

A flamegraph visualizes the call stack distribution during profiling:

- **X-axis**: Width represents time spent in that function (or allocation count/bytes for heap)
- **Y-axis**: Call stack depth — bottom is main(), top is the leaf function
- **Color**: Indicates package (consistent within a profile, varies by tool)
- **Width**: Proportional to the profile metric (CPU time, allocations, etc.)

Key patterns to identify:

**Wide base functions**: Functions near the bottom with wide bars indicate hot common paths. `runtime.goexit`, `http.(*conn).serve`, and `goroutine` wrappers are expected — look for wide application-level functions.

**Plateaus**: A wide horizontal bar at a fixed stack depth often indicates a blocking loop or inefficient algorithm. Common in JSON marshaling, regex compilation, and database query preparation.

**Tall narrow spikes**: Deep call stacks with narrow width indicate recursion or complex but infrequently called paths. Generally not a concern unless they appear frequently.

```
Example CPU flamegraph analysis:
                    ┌──────────────────────────────────────────────────────┐
              Leaf  │ regexp.(*Regexp).doExecute  (45% of CPU time!!)      │
                    ├──────────────────────────────────────────────────────┤
                    │ regexp.(*Regexp).FindStringIndex                      │
                    ├──────────────────────────────────────────────────────┤
                    │ validateInput (called in hot path)                    │
                    ├──────────────────────────────────────────────────────┤
                    │ http.(*ServeMux).ServeHTTP                            │
                    ├──────────────────────────────────────────────────────┤
             Root   │ main.main                                             │
                    └──────────────────────────────────────────────────────┘
Diagnosis: Regex is compiled per-request. Fix: compile once, use sync.Pool.
```

### Generating Flamegraphs Manually

```bash
# CPU profile (30 seconds)
curl -s "http://localhost:6060/debug/pprof/profile?seconds=30" -o cpu.prof

# Heap profile
curl -s "http://localhost:6060/debug/pprof/heap" -o heap.prof

# Goroutine dump
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" -o goroutines.txt

# Interactive flamegraph in browser
go tool pprof -http=:8081 cpu.prof
# Opens browser with flamegraph, top functions, call graph

# Text report (top 20 functions by flat time)
go tool pprof -top -nodecount=20 cpu.prof

# Differential analysis: what changed between two profiles?
go tool pprof -base=before.prof after.prof
```

### Capturing Profiles from Kubernetes Pods

```bash
# Port-forward to pprof port
kubectl port-forward pod/payment-api-7d4f9b6c8-xkj2p 6060:6060 -n production &

# Capture 60-second CPU profile
curl -s "http://localhost:6060/debug/pprof/profile?seconds=60" \
  -o /tmp/payment-api-cpu-$(date +%Y%m%d-%H%M%S).prof

# Analyze
go tool pprof -http=:8081 /tmp/payment-api-cpu-*.prof
```

## Heap Profiling for Memory Leaks

### Understanding Go Heap Profiles

Heap profiles contain four metrics:

- **inuse_space**: Bytes currently allocated and in use (the most important leak signal)
- **inuse_objects**: Object count currently allocated
- **alloc_space**: Total bytes allocated since program start (cumulative)
- **alloc_objects**: Total objects allocated since program start (cumulative)

A memory leak shows up as continuously growing `inuse_space` over time.

### Diagnosing Memory Growth

```go
package diagnostics

import (
    "fmt"
    "runtime"
    "time"
)

// MemStats tracks heap growth over time
type MemStats struct {
    Timestamp    time.Time
    HeapAlloc    uint64  // Bytes allocated and not yet freed
    HeapSys      uint64  // Bytes obtained from OS
    HeapObjects  uint64  // Number of allocated objects
    NumGC        uint32  // Number of completed GC cycles
    GCPauseNs    uint64  // Total GC pause time
}

func CaptureMemStats() MemStats {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)
    return MemStats{
        Timestamp:   time.Now(),
        HeapAlloc:   ms.HeapAlloc,
        HeapSys:     ms.HeapSys,
        HeapObjects: ms.HeapObjects,
        NumGC:       ms.NumGC,
        GCPauseNs:   ms.PauseTotalNs,
    }
}

// LogMemGrowth logs heap statistics periodically
func LogMemGrowth(interval time.Duration) {
    baseline := CaptureMemStats()
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for range ticker.C {
        current := CaptureMemStats()
        growthMB := float64(current.HeapAlloc-baseline.HeapAlloc) / 1024 / 1024
        fmt.Printf(
            "HeapAlloc: %.2f MB, HeapObjects: %d, GCs: %d, Growth since start: %.2f MB\n",
            float64(current.HeapAlloc)/1024/1024,
            current.HeapObjects,
            current.NumGC,
            growthMB,
        )
    }
}
```

### Common Memory Leak Patterns

**Pattern 1: Slice retention**

```go
// BUG: Keeps reference to backing array — the 100-element slice is never GC'd
func processChunk(data []byte) []byte {
    return data[:10]  // Returns sub-slice, holding reference to full backing array
}

// FIX: Copy the data you need
func processChunkFixed(data []byte) []byte {
    result := make([]byte, 10)
    copy(result, data[:10])
    return result
}
```

**Pattern 2: Map accumulation without expiry**

```go
// BUG: Cache grows without bound
type Cache struct {
    mu    sync.RWMutex
    items map[string]*Item
}

func (c *Cache) Set(key string, item *Item) {
    c.mu.Lock()
    c.items[key] = item  // Never evicted
    c.mu.Unlock()
}

// FIX: Use expiry with background cleanup or use github.com/patrickmn/go-cache
type CacheWithTTL struct {
    mu      sync.RWMutex
    items   map[string]*cacheEntry
    maxSize int
}

type cacheEntry struct {
    value   *Item
    expires time.Time
}

func (c *CacheWithTTL) cleanup() {
    c.mu.Lock()
    defer c.mu.Unlock()
    now := time.Now()
    for k, v := range c.items {
        if now.After(v.expires) {
            delete(c.items, k)
        }
    }
}
```

**Pattern 3: Goroutine leak from abandoned channels**

```go
// BUG: If ctx is cancelled, goroutine blocks forever on results <- result
func processAsync(ctx context.Context, input string) <-chan string {
    results := make(chan string) // unbuffered!
    go func() {
        result := expensiveOp(input)
        results <- result // Blocks if receiver is gone
    }()
    return results
}

// FIX: Use buffered channel or select with context
func processAsyncFixed(ctx context.Context, input string) <-chan string {
    results := make(chan string, 1) // Buffered — goroutine won't block
    go func() {
        result := expensiveOp(input)
        select {
        case results <- result:
        case <-ctx.Done():
            // Context cancelled, discard result
        }
    }()
    return results
}
```

### Heap Profile Diff Analysis

```bash
# Capture baseline heap profile
curl -s "http://localhost:6060/debug/pprof/heap" -o heap-before.prof

# Wait for suspected leak to accumulate (e.g., 10 minutes of traffic)
sleep 600

# Capture second profile
curl -s "http://localhost:6060/debug/pprof/heap" -o heap-after.prof

# Compare: what was allocated between the two profiles?
go tool pprof -base=heap-before.prof heap-after.prof
# Then in the pprof shell:
# (pprof) top20
# (pprof) web  # Opens flamegraph showing growth
# (pprof) list functionName  # Show source-level allocation sites
```

## Goroutine Leak Detection

### What Goroutine Leaks Look Like

Goroutine leaks manifest as:
- Continuously growing goroutine count (visible in `runtime.NumGoroutine()`)
- Memory growth proportional to goroutine count
- Eventually: "too many goroutines" causing GC pressure

```go
package diagnostics

import (
    "context"
    "fmt"
    "runtime"
    "time"

    "go.uber.org/zap"
)

// MonitorGoroutines alerts when goroutine count exceeds threshold
func MonitorGoroutines(ctx context.Context, logger *zap.Logger, alertThreshold int) {
    baseline := runtime.NumGoroutine()
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            current := runtime.NumGoroutine()
            growth := current - baseline

            logger.Info("goroutine count",
                zap.Int("current", current),
                zap.Int("baseline", baseline),
                zap.Int("growth", growth),
            )

            if current > alertThreshold {
                logger.Error("goroutine count exceeds threshold — possible leak",
                    zap.Int("count", current),
                    zap.Int("threshold", alertThreshold),
                )
                // Dump goroutine stacks for analysis
                buf := make([]byte, 1<<20) // 1MB buffer
                n := runtime.Stack(buf, true)
                logger.Error("goroutine dump", zap.String("stacks", string(buf[:n])))
            }
        }
    }
}
```

### Using goleak for Test-Time Detection

```go
package mypackage_test

import (
    "testing"

    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    // goleak checks for goroutine leaks after each test
    goleak.VerifyTestMain(m)
}

func TestHTTPClient(t *testing.T) {
    defer goleak.VerifyNone(t)

    // If this test leaks goroutines, goleak will fail the test
    client := NewHTTPClient()
    resp, err := client.Get("http://example.com")
    if err != nil {
        t.Fatal(err)
    }
    defer resp.Body.Close()
    // ... test assertions
}
```

### Interpreting Goroutine Profiles

```bash
# Get goroutine dump with full stacks
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" | head -200

# Count goroutines by state
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=1" | \
  grep "goroutine" | head -5

# Visualize goroutine flamegraph
curl -s "http://localhost:6060/debug/pprof/goroutine" -o goroutine.prof
go tool pprof -http=:8081 goroutine.prof
```

Sample output showing a leak:
```
goroutine profile: total 15234
4891 @ 0x43d74a 0x43d7c2 0x4dfe7e ...
#   0x4dfe7e  net/http.(*persistConn).readLoop+0x6e
#   0x4e005e  net/http.(*persistConn).writeLoop+0x5e

# 4891 goroutines blocked in readLoop = HTTP client connection leak
# Fix: set Transport.MaxIdleConns and call resp.Body.Close()
```

## Mutex and Block Profiling

### Enabling Runtime Profiling

Block and mutex profiling are disabled by default because they add overhead. Enable them programmatically:

```go
package main

import (
    "runtime"
    "os"
    "strconv"
)

func configureProfiling() {
    // Mutex profiling: sample every N mutex events
    // 1 = sample all (high overhead), 5 = sample 1/5 (lower overhead)
    mutexFraction := 5
    if v := os.Getenv("MUTEX_PROFILE_FRACTION"); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            mutexFraction = n
        }
    }
    runtime.SetMutexProfileFraction(mutexFraction)

    // Block profiling: sample goroutine blocks longer than N nanoseconds
    // 1 = sample all blocks (high overhead)
    // 10000 = sample blocks > 10 microseconds
    // 1000000 = sample blocks > 1 millisecond (production-safe)
    blockRate := 1000000
    if v := os.Getenv("BLOCK_PROFILE_RATE"); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            blockRate = n
        }
    }
    runtime.SetBlockProfileRate(blockRate)
}
```

### Analyzing Mutex Contention

```bash
# Capture mutex profile
curl -s "http://localhost:6060/debug/pprof/mutex" -o mutex.prof

# Show top mutex contention points
go tool pprof -top mutex.prof

# Interactive analysis
go tool pprof -http=:8081 mutex.prof
```

Example mutex profile analysis:

```go
// Finding: UserCache.mu held for 200ms in Get() due to sync.Mutex protecting
// both read and write operations

// Before (high contention):
type UserCache struct {
    mu    sync.Mutex
    items map[string]*User
}

func (c *UserCache) Get(key string) (*User, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()
    u, ok := c.items[key]
    return u, ok
}

// After (read-heavy optimized):
type UserCache struct {
    mu    sync.RWMutex
    items map[string]*User
}

func (c *UserCache) Get(key string) (*User, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    u, ok := c.items[key]
    return u, ok
}
```

### Block Profile Interpretation

The block profile shows goroutines blocked on channel operations, select statements, and sync primitives:

```bash
# Common block profile findings:
#
# 1. channel receive (goroutine waiting for work):
#    goroutine 45 [chan receive]:
#    main.worker(0xc000124000)
#        /app/worker.go:34
#
# 2. sync.WaitGroup.Wait:
#    goroutine 1 [semacquire]:
#    sync.runtime_Semacquire(0xc000012600)
#
# 3. net.(*netFD).accept:
#    goroutine 12 [IO wait]:
#    net.(*netFD).accept(0xc000138000)
#
# IO wait is expected. Semacquire > 1ms indicates a lock contention problem.
```

## Production Profiling Patterns

### Conditional Profiling Based on Load

```go
package profiling

import (
    "net/http"
    "net/http/pprof"
    "os"
    "time"

    "go.uber.org/zap"
)

// AdaptivePprofHandler enables/disables profiling endpoints based on CPU load
type AdaptivePprofHandler struct {
    logger          *zap.Logger
    cpuThreshold    float64 // Disable pprof if CPU > threshold
    lastProfileTime time.Time
    minInterval     time.Duration // Minimum time between profiles
}

func (h *AdaptivePprofHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if time.Since(h.lastProfileTime) < h.minInterval {
        http.Error(w, "profiling rate limited — too frequent requests", http.StatusTooManyRequests)
        return
    }

    h.lastProfileTime = time.Now()

    // Route to appropriate pprof handler
    switch r.URL.Path {
    case "/debug/pprof/profile":
        pprof.Profile(w, r)
    case "/debug/pprof/heap":
        pprof.Handler("heap").ServeHTTP(w, r)
    case "/debug/pprof/goroutine":
        pprof.Handler("goroutine").ServeHTTP(w, r)
    default:
        pprof.Index(w, r)
    }
}
```

### Automated Heap Snapshot on OOM Signal

```go
package diagnostics

import (
    "fmt"
    "os"
    "os/signal"
    "runtime/pprof"
    "syscall"
    "time"

    "go.uber.org/zap"
)

// DumpHeapOnSignal captures a heap profile when SIGUSR1 is received
func DumpHeapOnSignal(logger *zap.Logger, outputDir string) {
    ch := make(chan os.Signal, 1)
    signal.Notify(ch, syscall.SIGUSR1)

    go func() {
        for sig := range ch {
            logger.Info("received signal, capturing heap profile", zap.String("signal", sig.String()))

            filename := fmt.Sprintf("%s/heap-%d.prof", outputDir, time.Now().Unix())
            f, err := os.Create(filename)
            if err != nil {
                logger.Error("failed to create heap profile file", zap.Error(err))
                continue
            }

            if err := pprof.WriteHeapProfile(f); err != nil {
                logger.Error("failed to write heap profile", zap.Error(err))
            } else {
                logger.Info("heap profile written", zap.String("file", filename))
            }
            f.Close()
        }
    }()
}
```

```bash
# Trigger a heap dump from a running Pod
kubectl exec -n production payment-api-7d4f9b6c8-xkj2p -- \
  kill -USR1 1

# Retrieve the dump
kubectl cp production/payment-api-7d4f9b6c8-xkj2p:/tmp/heap-1719302400.prof \
  ./heap-dump.prof

# Analyze
go tool pprof -http=:8081 heap-dump.prof
```

### Correlating Profiles with Traces

Combine Pyroscope continuous profiling with OpenTelemetry traces for trace-level profiling:

```go
package tracing

import (
    "context"

    "github.com/grafana/pyroscope-go/godeltaprof/http/pprof"
    oteltrace "go.opentelemetry.io/otel/trace"
)

// ExtractTraceID extracts the current trace ID for profile correlation
func ExtractTraceID(ctx context.Context) string {
    span := oteltrace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        return ""
    }
    return span.SpanContext().TraceID().String()
}

// TagWithTraceID tags the current profiling span with trace ID
// Allows correlating slow traces with their profiling data in Pyroscope
func TagWithTraceID(ctx context.Context) context.Context {
    traceID := ExtractTraceID(ctx)
    if traceID == "" {
        return ctx
    }

    // The pyroscope package stores labels in context
    return pyroscope.AddContext(ctx, pyroscope.Labels("trace_id", traceID))
}
```

## Benchmarking Profile Overhead

### Measuring pprof Impact

```go
package profiling_test

import (
    "runtime"
    "testing"
    "time"
)

func BenchmarkWithProfiling(b *testing.B) {
    // Baseline: no profiling
    b.Run("no_profiling", func(b *testing.B) {
        runtime.SetMutexProfileFraction(0)
        runtime.SetBlockProfileRate(0)
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            doWork()
        }
    })

    // With CPU profiling (Pyroscope 100Hz sampling)
    b.Run("cpu_100hz", func(b *testing.B) {
        // 100Hz sampling adds < 1% CPU overhead for most applications
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            doWork()
        }
    })

    // With mutex profiling (fraction=5)
    b.Run("mutex_fraction_5", func(b *testing.B) {
        runtime.SetMutexProfileFraction(5)
        defer runtime.SetMutexProfileFraction(0)
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            doWork()
        }
    })
}
```

Typical overhead measurements for a production HTTP service:
- CPU profiling at 100Hz: <1% CPU overhead
- Heap profiling (inuse): <0.5% overhead
- Mutex profiling at fraction=5: 2-5% overhead in contention-heavy services
- Block profiling at rate=1ms: 1-3% overhead

## Prometheus Metrics Integration

Expose profiling-derived metrics through Prometheus for alerting:

```go
package metrics

import (
    "runtime"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    goroutineCount = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines_current",
        Help: "Current number of goroutines",
    })

    heapAllocBytes = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_heap_alloc_bytes",
        Help: "Current heap allocation in bytes",
    })

    gcPauseMs = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "go_gc_pause_milliseconds",
        Help:    "GC pause duration distribution",
        Buckets: []float64{0.1, 0.5, 1, 5, 10, 50, 100},
    })
)

func UpdateRuntimeMetrics() {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)

    goroutineCount.Set(float64(runtime.NumGoroutine()))
    heapAllocBytes.Set(float64(ms.HeapAlloc))

    // Convert nanoseconds to milliseconds for each GC pause
    for _, pause := range ms.PauseNs {
        if pause > 0 {
            gcPauseMs.Observe(float64(pause) / 1e6)
        }
    }
}
```

## Summary

Continuous profiling in Go provides production observability that complements traces and metrics. The key practices:

- Embed Pyroscope SDK for always-on CPU and memory profiling with <1% overhead
- Enable mutex and block profiling selectively with appropriate sampling rates
- Use differential heap profiles (`-base=before.prof after.prof`) to isolate memory growth between deployments
- Monitor goroutine count as an early warning signal for leaks
- Correlate profiles with distributed traces using span context labels
- Automate heap dumps on SIGUSR1 for OOM investigation
- Bind pprof to loopback interface only — never expose on the service port

The combination of always-on profiling data with deployment markers in Pyroscope allows pinpointing exactly which commit introduced a performance regression, often before users file bug reports.
