---
title: "Go Profiling Deep Dive: Mutex Contention, Block Profiling, and Goroutine Dumps"
date: 2030-08-09T00:00:00-05:00
draft: false
tags: ["Go", "Profiling", "Performance", "pprof", "Goroutines", "Concurrency", "Pyroscope"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Go profiling guide: mutex and block profiler setup, goroutine dump analysis, execution tracer (go tool trace), HTTP profiling endpoint, continuous profiling with Pyroscope/Parca, and systematic performance investigation workflow."
more_link: "yes"
url: "/go-profiling-deep-dive-mutex-contention-block-profiling-goroutine-dumps/"
---

CPU and heap profiles reveal what code runs and what allocates, but they miss an entire class of performance problems: time spent waiting. Mutex contention, channel stalls, syscall blocking, and goroutine scheduling delays are invisible to CPU profilers because the goroutine is not running—it is parked. The Go runtime's mutex profiler, block profiler, and execution tracer expose exactly these waiting patterns.

<!--more-->

## Overview

This guide covers the four specialized Go profiling tools that complement the CPU and heap profiles: the mutex profiler for lock contention analysis, the block profiler for any blocking operation, the goroutine dump for deadlock and leak detection, and the execution tracer for microsecond-resolution scheduling analysis. It also covers integrating continuous profiling with Pyroscope for production visibility.

## Profiling Infrastructure Setup

### Enabling the HTTP Profiling Endpoint

The standard Go pprof endpoint exposes all profilers:

```go
// main.go or server setup
import (
    "net/http"
    _ "net/http/pprof"  // Side-effect import registers handlers
    "runtime"
    "time"
)

func initProfiling() {
    // Mutex profiling: fraction=1 means profile every mutex event
    // In production, use a higher fraction (5-10) to reduce overhead
    runtime.SetMutexProfileFraction(5)

    // Block profiling: fraction=1 means profile every blocking event
    // Default is 0 (disabled); set to 1 for investigation, higher for production
    runtime.SetBlockProfileRate(1)

    // Start profiling server on a separate port from the main server
    go func() {
        srv := &http.Server{
            Addr:         "127.0.0.1:6060",  // Not 0.0.0.0 - never expose to internet
            ReadTimeout:  10 * time.Second,
            WriteTimeout: 30 * time.Second,   // Longer for profile collection
        }
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            panic(err)
        }
    }()
}
```

### Available Profile Endpoints

| Endpoint | Description | Collection Method |
|----------|-------------|------------------|
| `/debug/pprof/` | Index of all profiles | Browser |
| `/debug/pprof/profile?seconds=30` | 30-second CPU profile | Download |
| `/debug/pprof/heap` | Heap (in-use allocations) | Download |
| `/debug/pprof/allocs` | Allocation profile | Download |
| `/debug/pprof/goroutine` | All goroutine stacks | Download |
| `/debug/pprof/mutex` | Mutex contention | Download |
| `/debug/pprof/block` | Blocking operations | Download |
| `/debug/pprof/trace?seconds=5` | Execution trace | Download |
| `/debug/pprof/threadcreate` | OS thread creation | Download |

## Mutex Profiler

### When to Use

Use the mutex profiler when:
- CPU profile shows goroutines waiting on `sync.Mutex.Lock` or `sync.RWMutex.RLock`
- Request latency is high but CPU utilization is low (goroutines contending on locks)
- Benchmark shows performance degrades non-linearly with concurrency

### Collecting and Analyzing Mutex Profiles

```bash
# Enable mutex profiling and collect a sample
# (fraction=5 means profile 1 in 5 mutex wait events)
curl -sK "http://localhost:6060/debug/pprof/mutex?debug=1" > mutex.txt

# For binary analysis:
curl -sK "http://localhost:6060/debug/pprof/mutex" > mutex.prof
go tool pprof mutex.prof

# In pprof interactive mode:
(pprof) top10
(pprof) list serveHTTP       # Annotated source
(pprof) web                  # Open flame graph in browser
```

### Reading Mutex Profile Output

```
(pprof) top10
Showing nodes accounting for 2.88s, 93.83% of 3.07s total
      flat  flat%   sum%        cum   cum%
     1.12s 36.48% 36.48%      1.12s 36.48%  sync.(*Mutex).Unlock
     0.84s 27.36% 63.84%      1.96s 63.84%  main.(*Cache).Get
     0.52s 16.94% 80.78%      0.52s 16.94%  sync.(*RWMutex).RUnlock
     0.40s 13.03% 93.81%      1.20s 39.09%  main.(*Cache).Set
```

In mutex profiles, `flat` represents time goroutines spent waiting to acquire the lock. High `flat` on a specific lock indicates contention.

### Resolving Mutex Contention

**Before (global mutex on cache):**

```go
type Cache struct {
    mu    sync.RWMutex
    items map[string]*CacheItem
}

func (c *Cache) Get(key string) (*CacheItem, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    item, ok := c.items[key]
    return item, ok
}

func (c *Cache) Set(key string, item *CacheItem) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = item
}
```

**After (sharded cache to reduce contention):**

```go
const shards = 256

type ShardedCache struct {
    shards [shards]struct {
        sync.RWMutex
        items map[string]*CacheItem
    }
}

func (c *ShardedCache) shard(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % shards
}

func (c *ShardedCache) Get(key string) (*CacheItem, bool) {
    s := c.shard(key)
    c.shards[s].RLock()
    defer c.shards[s].RUnlock()
    item, ok := c.shards[s].items[key]
    return item, ok
}

func (c *ShardedCache) Set(key string, item *CacheItem) {
    s := c.shard(key)
    c.shards[s].Lock()
    defer c.shards[s].Unlock()
    if c.shards[s].items == nil {
        c.shards[s].items = make(map[string]*CacheItem)
    }
    c.shards[s].items[key] = item
}
```

### sync.Map for Read-Heavy Workloads

For caches with high read-to-write ratios (>10:1), `sync.Map` reduces contention:

```go
type TypedCache[V any] struct {
    m sync.Map
}

func (c *TypedCache[V]) Load(key string) (V, bool) {
    v, ok := c.m.Load(key)
    if !ok {
        var zero V
        return zero, false
    }
    return v.(V), true
}

func (c *TypedCache[V]) Store(key string, value V) {
    c.m.Store(key, value)
}
```

## Block Profiler

### When to Use

The block profiler records events where a goroutine blocked waiting for:
- Channel send/receive operations
- `select` statements with no ready case
- `sync.WaitGroup.Wait()`
- `time.Sleep()` and timer channels
- Syscall completion (I/O, network)
- `sync.Mutex.Lock()` (when the lock was contested)

The block profiler is more comprehensive than the mutex profiler and captures the complete picture of goroutine wait time.

### Collecting Block Profiles

```bash
# Collect block profile (runtime.SetBlockProfileRate must be > 0)
curl -sK "http://localhost:6060/debug/pprof/block" > block.prof
go tool pprof block.prof

(pprof) top10
(pprof) list processMessages
```

### Interpreting Block Profile Data

```
(pprof) top10
Showing nodes accounting for 9.22s, 98.72% of 9.34s total
      flat  flat%   sum%        cum   cum%
     4.12s 44.10% 44.10%      4.12s 44.10%  runtime.chanrecv
     2.31s 24.73% 68.83%      6.43s 68.83%  main.processMessages
     1.87s 20.02% 88.85%      1.87s 20.02%  net/http.(*connReader).Read
     0.92s  9.85% 98.70%      0.92s  9.85%  database/sql.(*DB).QueryContext
```

High `chanrecv` time often indicates a pipeline stage that is slow to produce data, causing downstream consumers to wait.

### Diagnosing Channel Bottlenecks

```go
// Before: unbuffered channel causing sender to block
func pipeline(input <-chan Request) <-chan Result {
    out := make(chan Result)  // Unbuffered: sender blocks until receiver is ready
    go func() {
        defer close(out)
        for req := range input {
            result := process(req)  // Slow processing
            out <- result           // Sender blocks here if consumer is slow
        }
    }()
    return out
}

// After: buffered channel absorbs burst
func pipeline(input <-chan Request) <-chan Result {
    out := make(chan Result, 100)  // Buffer: sender blocks only when buffer full
    go func() {
        defer close(out)
        for req := range input {
            out <- process(req)
        }
    }()
    return out
}

// Better: worker pool for CPU-bound processing
func pipelinePool(input <-chan Request, workers int) <-chan Result {
    out := make(chan Result, workers*10)

    var wg sync.WaitGroup
    wg.Add(workers)
    for i := 0; i < workers; i++ {
        go func() {
            defer wg.Done()
            for req := range input {
                out <- process(req)
            }
        }()
    }

    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}
```

## Goroutine Dumps

### Capturing Goroutine Stacks

Goroutine dumps reveal the current state of every goroutine: where it is blocked, what it is waiting on, and how long it has been waiting.

```bash
# Text format (human-readable)
curl -sK "http://localhost:6060/debug/pprof/goroutine?debug=1" > goroutines.txt

# More verbose (includes full argument values)
curl -sK "http://localhost:6060/debug/pprof/goroutine?debug=2" > goroutines-verbose.txt

# Binary for pprof analysis
curl -sK "http://localhost:6060/debug/pprof/goroutine" > goroutines.prof
go tool pprof goroutines.prof
(pprof) top
(pprof) tree
```

### Reading Goroutine Dump Output

```
goroutine 1 [running]:
main.main()
	/app/main.go:45 +0x234

goroutine 18 [chan receive, 3 minutes]:
main.processOrders(0xc0004f2000)
	/app/processor.go:78 +0x114
created by main.startWorkers in goroutine 1
	/app/main.go:32 +0x78

goroutine 19 [chan receive, 3 minutes]:
main.processOrders(0xc0004f3000)
	/app/processor.go:78 +0x114
created by main.startWorkers in goroutine 1
	/app/main.go:32 +0x78

goroutine 412 [syscall, 45 minutes]:
os/signal.signal_recv()
	/usr/local/go/src/runtime/sigqueue.go:149 +0x28

goroutine 4187 [select]:
database/sql.(*DB).connectionOpener(0xc000124000, {0x1234, 0xc000a00050})
	/usr/local/go/src/database/sql/sql.go:1193 +0x64
```

Key fields in goroutine states:
- `running` - currently executing
- `chan receive` - blocked waiting for channel data
- `chan send` - blocked waiting for channel to accept data
- `select` - blocked in a select with no ready case
- `syscall` - blocked in a system call (I/O, network)
- `sleep` - in `time.Sleep`
- `IO wait` - waiting for network I/O
- `semacquire` - waiting for a semaphore (mutex, WaitGroup, etc.)
- The number after the state (e.g., `3 minutes`) is how long the goroutine has been in that state

### Goroutine Leak Detection

A goroutine leak occurs when goroutines are created but never exit. The goroutine count grows monotonically over time.

```go
// Expose goroutine count as a Prometheus metric
import (
    "runtime"
    "github.com/prometheus/client_golang/prometheus"
)

var goroutineGauge = prometheus.NewGauge(prometheus.GaugeOpts{
    Name: "go_goroutines",
    Help: "Number of goroutines currently running.",
})

func init() {
    prometheus.MustRegister(goroutineGauge)
}

func recordGoroutines() {
    goroutineGauge.Set(float64(runtime.NumGoroutine()))
}
```

```bash
# Alert rule in Prometheus
# alert when goroutine count doubles in 30 minutes
- alert: GoroutineLeak
  expr: rate(go_goroutines[30m]) > 0.1
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Goroutine count growing: possible leak"
```

### Using goleak in Tests

The `goleak` package detects goroutine leaks in test code:

```go
import (
    "testing"
    "go.uber.org/goleak"
)

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

func TestProcessOrder(t *testing.T) {
    defer goleak.VerifyNone(t)

    // Test code that starts goroutines
    processor := NewOrderProcessor()
    processor.Start()
    // ... test logic ...
    processor.Stop()  // Must clean up all goroutines
}
```

Common goroutine leak patterns:

```go
// Leak: goroutine blocked forever on channel with no sender
func leakyFunc(data []int) {
    ch := make(chan int)
    go func() {
        for v := range data {
            ch <- v  // If nobody reads ch, this goroutine leaks
        }
    }()
    // Function returns without draining ch or closing it
}

// Fix: use context cancellation
func safeFunc(ctx context.Context, data []int) {
    ch := make(chan int, len(data))
    go func() {
        defer close(ch)
        for _, v := range data {
            select {
            case ch <- v:
            case <-ctx.Done():
                return  // Exit when context is cancelled
            }
        }
    }()
    // Process from ch, or cancel ctx to clean up
}
```

## Execution Tracer (go tool trace)

### When to Use

The execution tracer provides nanosecond-resolution visibility into:
- Goroutine scheduling delays
- GC stop-the-world pauses
- Preemption points
- Syscall duration
- Heap allocation patterns over time
- Blocking time per goroutine

### Collecting and Viewing Traces

```bash
# Collect a 5-second trace
curl -sK "http://localhost:6060/debug/pprof/trace?seconds=5" > trace.out

# Open in browser-based viewer
go tool trace trace.out
# Opens: http://localhost:XXXXX/
```

The trace viewer provides several analysis views:

1. **Goroutine Analysis** - timeline of goroutine states
2. **Scheduler Latency** - delays between when a goroutine becomes runnable and when it starts running
3. **Synchronization Blocking** - time blocked on mutexes and channels
4. **Syscall Blocking** - time blocked on system calls
5. **Scheduler Wait** - time waiting for a P (processor) to become available

### Programmatic Trace Collection

```go
import (
    "os"
    "runtime/trace"
    "time"
)

func traceFor(duration time.Duration) error {
    f, err := os.CreateTemp("", "trace-*.out")
    if err != nil {
        return err
    }
    defer f.Close()

    if err := trace.Start(f); err != nil {
        return err
    }
    time.Sleep(duration)
    trace.Stop()

    fmt.Printf("Trace written to %s\n", f.Name())
    return nil
}
```

### User Regions and Tasks in Traces

Annotate trace output with business-logic events for better correlation:

```go
import "runtime/trace"

func processOrder(ctx context.Context, orderID string) error {
    // Create a task to group related events
    ctx, task := trace.NewTask(ctx, "processOrder")
    defer task.End()

    trace.Log(ctx, "orderID", orderID)

    // Create regions for sub-operations
    trace.WithRegion(ctx, "validateOrder", func() {
        validate(orderID)
    })

    trace.WithRegion(ctx, "chargePayment", func() {
        charge(ctx, orderID)
    })

    trace.WithRegion(ctx, "fulfillOrder", func() {
        fulfill(ctx, orderID)
    })

    return nil
}
```

With these annotations, the trace viewer shows `processOrder` tasks as colored regions with sub-regions, making it easy to identify which step is slowest.

## Continuous Profiling in Production

### Pyroscope Integration

```go
// cmd/main.go
import "github.com/grafana/pyroscope-go"

func initContinuousProfiling() {
    pyroscope.Start(pyroscope.Config{
        ApplicationName: "order-service",
        ServerAddress:   "http://pyroscope.monitoring.svc.cluster.local:4040",

        // Profile ALL categories for comprehensive coverage
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

        // Dynamic labels for per-request profiling
        Tags: map[string]string{
            "env":     os.Getenv("ENVIRONMENT"),
            "version": os.Getenv("APP_VERSION"),
            "region":  os.Getenv("AWS_REGION"),
        },

        Logger: pyroscope.StandardLogger,
    })
}
```

### Per-Request Profiling with Dynamic Labels

Pyroscope supports labeling profiles with request-level context for query-time filtering:

```go
func handleHTTP(w http.ResponseWriter, r *http.Request) {
    // Attach labels to the profile data generated by this request's goroutine
    pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
        "endpoint", r.URL.Path,
        "method", r.Method,
        "customer_tier", r.Header.Get("X-Customer-Tier"),
    ), func(ctx context.Context) {
        processRequest(ctx, w, r)
    })
}
```

### Parca (CNCF Continuous Profiling)

```yaml
# parca deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: parca
  namespace: monitoring
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: parca
        image: ghcr.io/parca-dev/parca:v0.20.0
        args:
        - /parca
        - --config-path=/parca.yaml
        - --storage-path=/data
        - --storage-active-memory=4294967296  # 4 GB in-memory
        volumeMounts:
        - name: config
          mountPath: /parca.yaml
          subPath: parca.yaml
        - name: data
          mountPath: /data
        resources:
          requests:
            cpu: 500m
            memory: 4Gi
          limits:
            cpu: 2000m
            memory: 6Gi
```

```yaml
# parca.yaml config
object_storage:
  bucket:
    type: FILESYSTEM
    config:
      directory: "/data"

scrape_configs:
- job_name: "order-service"
  scrape_interval: "15s"
  targets:
  - targets:
    - "order-service.production.svc.cluster.local:6060"
    labels:
      service: "order-service"
      env: "production"
  profiling_config:
    pprof_config:
      cpu:
        enabled: true
      memory:
        enabled: true
      mutex:
        enabled: true
      block:
        enabled: true
      goroutine:
        enabled: true
```

## Systematic Performance Investigation Workflow

### Structured Investigation Process

```
1. Identify the symptom:
   - High p99/p999 latency?  → Block profiler, tracer
   - High CPU usage?         → CPU profiler
   - Growing memory?         → Heap profiler, goroutine dump
   - Low CPU, slow requests? → Mutex profiler, block profiler
   - Goroutine count growing?→ Goroutine dump

2. Baseline:
   go test -bench=BenchmarkCriticalPath -benchmem -count=3 -cpuprofile=cpu.prof ./...

3. Profile the bottleneck:
   # For live service:
   go tool pprof http://service:6060/debug/pprof/profile?seconds=30

4. Analyze:
   (pprof) top20 -cum
   (pprof) list suspicious_function
   (pprof) weblist suspicious_function  # annotated source in browser

5. Hypothesize and fix

6. Verify improvement:
   go test -bench=BenchmarkCriticalPath -benchmem -count=3 -cpuprofile=cpu_after.prof ./...
   go tool pprof -diff_base cpu.prof cpu_after.prof

7. Deploy and monitor continuous profiles for regression
```

### Benchmark Comparison Script

```bash
#!/bin/bash
# compare-profiles.sh

BENCH="BenchmarkProcessOrder"
PKG="./internal/..."

echo "=== Before optimization ==="
go test -bench="$BENCH" -benchmem -count=5 "$PKG" -cpuprofile=cpu_before.prof \
  -memprofile=mem_before.prof -mutexprofile=mutex_before.prof > before.txt
cat before.txt

echo ""
echo "=== After optimization ==="
go test -bench="$BENCH" -benchmem -count=5 "$PKG" -cpuprofile=cpu_after.prof \
  -memprofile=mem_after.prof -mutexprofile=mutex_after.prof > after.txt
cat after.txt

echo ""
echo "=== CPU Profile Diff ==="
go tool pprof -diff_base cpu_before.prof cpu_after.prof -top

echo ""
echo "=== Allocation Diff ==="
go tool pprof -alloc_objects -diff_base mem_before.prof mem_after.prof -top
```

### Common Performance Patterns by Profile Type

| Symptom in Profile | Root Cause | Fix |
|-------------------|------------|-----|
| High `sync.Mutex.Lock` in mutex profile | Lock contention | Shard the data structure |
| High `chanrecv` in block profile | Slow producer or empty channel | Buffer channel or add workers |
| Many goroutines in `syscall` state | Blocking I/O in hot path | Use non-blocking I/O, worker pools |
| `runtime.mallocgc` in CPU profile | Too many allocations | Pool, pre-allocate, reduce escapes |
| `runtime.gcBgMarkWorker` in CPU profile | GC pressure | Reduce allocations, tune GOGC |
| Goroutine count grows in goroutine dump | Goroutine leak | Context cancellation, defer close |
| Many goroutines in `semacquire` | WaitGroup not Done or sync.Cond broadcast | Check for missing Done calls |

## Summary

Complete Go performance investigation requires all profiler types working together. CPU profiles reveal where compute time is spent. Heap and allocation profiles reveal memory pressure. The mutex profiler identifies lock contention hot spots. The block profiler provides a comprehensive view of all waiting time. Goroutine dumps expose leaks and deadlocks. The execution tracer provides microsecond-resolution scheduling analysis for the most difficult latency problems. Continuous profiling with Pyroscope or Parca makes this data available in production without the overhead and coordination of ad-hoc profile collection.
