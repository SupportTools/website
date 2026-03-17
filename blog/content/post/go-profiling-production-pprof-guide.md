---
title: "Go Profiling in Production: pprof, trace, and Continuous Profiling with Pyroscope"
date: 2028-04-23T00:00:00-05:00
draft: false
tags: ["Go", "pprof", "Profiling", "Performance", "Pyroscope", "Continuous Profiling"]
categories: ["Go", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to profiling Go services using pprof CPU and memory profiles, execution traces, on-demand profiling via HTTP endpoints, and continuous profiling with Pyroscope for always-on performance visibility."
more_link: "yes"
url: "/go-profiling-production-pprof-guide/"
---

Performance problems in production Go services are rarely where you expect them. Intuition about hot paths is wrong more often than not — profiling is the only reliable way to find where CPU time actually goes, which allocations cause GC pressure, and which goroutines are stuck waiting for locks. This guide covers every Go profiling tool from basic `pprof` usage to continuous profiling infrastructure that catches regressions before they become incidents.

<!--more-->

# Go Profiling in Production

## The Profiling Toolkit

Go ships with a complete profiling toolkit in the standard library:

| Tool | What it measures |
|------|-----------------|
| `pprof` CPU profile | Where CPU time is spent |
| `pprof` heap profile | Live heap allocations |
| `pprof` allocs profile | All allocations (including freed) |
| `pprof` goroutine profile | Goroutine stacks |
| `pprof` mutex profile | Mutex contention |
| `pprof` block profile | Channel and mutex blocking |
| `runtime/trace` | Goroutine scheduling, GC, syscalls over time |

## Enabling the pprof HTTP Endpoint

```go
package main

import (
    "net/http"
    _ "net/http/pprof"  // Side-effect import registers handlers
    "log"
)

func main() {
    // In production, bind this to a separate port that is NOT internet-facing
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // ... application setup
}
```

The import registers these routes on `http.DefaultServeMux`:

- `/debug/pprof/` — index
- `/debug/pprof/profile?seconds=30` — 30-second CPU profile
- `/debug/pprof/heap` — heap profile
- `/debug/pprof/allocs` — allocations profile
- `/debug/pprof/goroutine` — goroutine stacks
- `/debug/pprof/mutex` — mutex contention
- `/debug/pprof/block` — blocking operations
- `/debug/pprof/trace?seconds=5` — execution trace

**Security note**: Never expose port 6060 to the internet. Use a private port, Kubernetes port-forwarding, or an authenticated reverse proxy.

## Securing the pprof Endpoint

```go
package main

import (
    "net/http"
    "net/http/pprof"
    "os"
)

func registerPprof(mux *http.ServeMux) {
    // Only register if PPROF_ENABLED is set
    if os.Getenv("PPROF_ENABLED") != "true" {
        return
    }

    mux.HandleFunc("/debug/pprof/", pprof.Index)
    mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
}
```

For Kubernetes deployments, use port-forwarding to access the debug port:

```bash
kubectl port-forward -n production pod/api-server-7d9f8 6060:6060
```

## Collecting and Analyzing CPU Profiles

### One-Line Collection

```bash
# Collect a 30-second CPU profile
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Or save to a file for later analysis
curl -o cpu.prof "http://localhost:6060/debug/pprof/profile?seconds=30"
go tool pprof cpu.prof
```

### Analyzing in the pprof CLI

```
(pprof) top10
Showing nodes accounting for 14.22s, 94.28% of 15.08s total
      flat  flat%   sum%        cum   cum%
     3.45s 22.88% 22.88%      3.45s 22.88%  runtime.mapaccess2_faststr
     2.21s 14.66% 37.54%      2.21s 14.66%  encoding/json.(*encodeState).marshal
     1.89s 12.53% 50.07%      1.89s 12.53%  sync.(*RWMutex).RLock
     ...

(pprof) list marshal      # Show annotated source for json.marshal
(pprof) web               # Open flame graph in browser (requires Graphviz)
(pprof) svg > cpu.svg     # Export to SVG
(pprof) png > cpu.png     # Export to PNG

# Focus on a specific function subtree
(pprof) focus=handleRequest
(pprof) top5
```

### Flame Graphs

The flame graph view is the most intuitive way to see the call tree:

```bash
# Start an interactive web server with flame graphs
go tool pprof -http=localhost:8081 cpu.prof

# Navigate to:
# http://localhost:8081/ui/flamegraph
# http://localhost:8081/ui/source (annotated source)
```

## Heap Profiling

### Collecting a Heap Profile

```bash
# Heap profile shows current live allocations
curl -o heap.prof "http://localhost:6060/debug/pprof/heap"
go tool pprof heap.prof

(pprof) top10 -cum    # Sort by cumulative allocation
(pprof) list NewBuffer
(pprof) alloc_space   # Show allocation space (not just live objects)
(pprof) inuse_space   # Show currently in-use space (default)
```

### Finding Memory Leaks with Two Profiles

```bash
# Take profile 1 (baseline)
curl -o heap1.prof "http://localhost:6060/debug/pprof/heap"

# Wait for the leak to grow (1 hour)
sleep 3600

# Take profile 2 (after leak)
curl -o heap2.prof "http://localhost:6060/debug/pprof/heap"

# Diff: show what grew between the two profiles
go tool pprof -diff_base=heap1.prof heap2.prof

(pprof) top10
# Functions with positive values are allocating more; negative are releasing
```

### Allocation Profiling (All Allocations)

The `allocs` profile counts all allocations, including ones that were already GC'd. Useful for finding allocation hot paths even if there is no memory leak.

```bash
curl -o allocs.prof "http://localhost:6060/debug/pprof/allocs"
go tool pprof allocs.prof

(pprof) top10 -flat
```

## Goroutine Profile

```bash
# Dump all goroutine stacks
curl -o goroutines.prof "http://localhost:6060/debug/pprof/goroutine"
go tool pprof goroutines.prof

(pprof) top10
# Shows how many goroutines are waiting at each call stack

# Get full debug dump (text format with counts)
curl "http://localhost:6060/debug/pprof/goroutine?debug=2" | head -100
```

Goroutine leaks show up as a growing count that does not decrease:

```bash
# Watch goroutine count over time
watch -n10 'curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -1'
# goroutine profile: total 1234
# goroutine profile: total 1356  ← growing = leak
```

## Mutex and Block Profiling

These profiles are off by default because they add overhead.

```go
package main

import (
    "net/http"
    _ "net/http/pprof"
    "runtime"
)

func init() {
    // Enable mutex profiling (samples every 5th contention event)
    runtime.SetMutexProfileFraction(5)

    // Enable block profiling (samples every blocking event > 1ns)
    runtime.SetBlockProfileRate(1)
    // Or for lower overhead:
    runtime.SetBlockProfileRate(1000)  // 1 in 1000 events
}
```

```bash
# Collect mutex contention profile
curl -o mutex.prof "http://localhost:6060/debug/pprof/mutex"
go tool pprof mutex.prof

(pprof) top10
# Shows which mutexes are most contended
```

## Execution Traces

`runtime/trace` captures a timeline of goroutine execution, GC pauses, and syscalls. Unlike pprof samples, it captures exact timing.

### Collecting a Trace

```bash
# Collect 5 seconds of trace
curl -o trace.out "http://localhost:6060/debug/pprof/trace?seconds=5"

# Open the trace viewer
go tool trace trace.out
# Opens a browser at localhost:PORT
```

### What to Look for in Traces

The trace viewer shows several views:

- **Goroutine analysis**: Time spent running, runnable (waiting for CPU), and blocked.
- **GC timeline**: Duration and frequency of GC pauses. STW (stop-the-world) pauses appear as red bars.
- **Heap graph**: Heap size growth over the trace period.
- **Network and syscall blocking**: Goroutines blocked on I/O.

```bash
# Programmatic trace collection
import "runtime/trace"

func main() {
    f, _ := os.Create("trace.out")
    trace.Start(f)
    defer trace.Stop()
    // ... run the workload
}

go tool trace trace.out
```

### Custom Trace Regions

```go
import (
    "context"
    "runtime/trace"
)

func processOrder(ctx context.Context, orderID string) error {
    ctx, task := trace.NewTask(ctx, "processOrder")
    defer task.End()

    trace.WithRegion(ctx, "validateOrder", func() {
        validateOrder(ctx, orderID)
    })

    trace.WithRegion(ctx, "chargePayment", func() {
        chargePayment(ctx, orderID)
    })

    trace.Log(ctx, "orderID", orderID)
    return nil
}
```

Custom regions appear in the trace viewer as annotated spans, making it easy to see where time is spent in your specific code.

## Programmatic Profiling

### Starting a Profile at a Specific Event

```go
package profiler

import (
    "fmt"
    "os"
    "runtime"
    "runtime/pprof"
    "time"
)

// CPUProfiler captures a CPU profile for the given duration.
func CPUProfiler(duration time.Duration) error {
    f, err := os.CreateTemp("", "cpu-profile-*.prof")
    if err != nil {
        return fmt.Errorf("creating profile file: %w", err)
    }
    defer f.Close()

    if err := pprof.StartCPUProfile(f); err != nil {
        return fmt.Errorf("starting CPU profile: %w", err)
    }
    time.Sleep(duration)
    pprof.StopCPUProfile()

    fmt.Printf("CPU profile written to: %s\n", f.Name())
    return nil
}

// HeapSnapshot captures current heap state.
func HeapSnapshot() error {
    f, err := os.CreateTemp("", "heap-*.prof")
    if err != nil {
        return fmt.Errorf("creating heap file: %w", err)
    }
    defer f.Close()

    runtime.GC() // Force GC before snapshot for accurate data
    if err := pprof.WriteHeapProfile(f); err != nil {
        return fmt.Errorf("writing heap profile: %w", err)
    }

    fmt.Printf("Heap profile written to: %s\n", f.Name())
    return nil
}
```

### Triggered Profiling (on High CPU/Memory)

```go
package main

import (
    "runtime"
    "time"
)

// TriggerCPUProfileOnHighUsage starts a CPU profile when CPU usage exceeds threshold.
func StartProfileTrigger(cpuThreshold float64, memThreshold uint64) {
    go func() {
        ticker := time.NewTicker(5 * time.Second)
        defer ticker.Stop()

        for range ticker.C {
            var stats runtime.MemStats
            runtime.ReadMemStats(&stats)

            // Memory threshold check
            if stats.HeapAlloc > memThreshold {
                log.Printf("High memory detected: %d MB, capturing heap profile",
                    stats.HeapAlloc/1024/1024)
                HeapSnapshot()
            }

            // Goroutine count threshold (potential leak)
            if n := runtime.NumGoroutine(); n > 1000 {
                log.Printf("High goroutine count: %d, capturing goroutine profile", n)
                captureGoroutineProfile()
            }
        }
    }()
}
```

## Benchmark Profiling

For optimization work, profile specific code paths with benchmarks:

```go
package cache_test

import (
    "testing"
    _ "net/http/pprof"  // Not needed in tests, use -cpuprofile flag instead
)

func BenchmarkLRUCache_Get(b *testing.B) {
    cache := NewLRUCache(1024)
    // Populate the cache
    for i := 0; i < 1024; i++ {
        cache.Set(fmt.Sprintf("key-%d", i), i)
    }

    b.ResetTimer()
    b.ReportAllocs()  // Report allocations per operation

    for i := 0; i < b.N; i++ {
        cache.Get(fmt.Sprintf("key-%d", i%1024))
    }
}
```

Run with profiling:

```bash
# CPU profile
go test -bench=BenchmarkLRUCache_Get \
  -benchmem \
  -cpuprofile=cpu.prof \
  ./...

# Heap profile
go test -bench=BenchmarkLRUCache_Get \
  -benchmem \
  -memprofile=mem.prof \
  ./...

# Both
go test -bench=BenchmarkLRUCache_Get \
  -benchmem \
  -cpuprofile=cpu.prof \
  -memprofile=mem.prof \
  ./...

go tool pprof -http=localhost:8081 cpu.prof
```

## Continuous Profiling with Pyroscope

Continuous profiling captures profiles automatically every 10–60 seconds and stores them in a time-series database. This lets you correlate performance changes with deployments, traffic spikes, and incidents — even when you did not know to start a profile.

### Pyroscope Go SDK

```bash
go get github.com/grafana/pyroscope-go
```

```go
package main

import (
    "os"

    pyroscope "github.com/grafana/pyroscope-go"
)

func initPyroscope() {
    serviceName := os.Getenv("SERVICE_NAME")
    if serviceName == "" {
        serviceName = "api-server"
    }

    environment := os.Getenv("ENVIRONMENT")
    if environment == "" {
        environment = "production"
    }

    _, _ = pyroscope.Start(pyroscope.Config{
        ApplicationName: serviceName,
        ServerAddress:   os.Getenv("PYROSCOPE_URL"), // e.g. http://pyroscope:4040
        Logger:          pyroscope.StandardLogger,

        // Tags for filtering in the Pyroscope UI
        Tags: map[string]string{
            "environment": environment,
            "region":      os.Getenv("AWS_REGION"),
            "version":     os.Getenv("APP_VERSION"),
        },

        // Profile types to enable
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

        // How often to capture profiles
        UploadRate: 15 * time.Second,
    })
}

func main() {
    initPyroscope()
    // ... application
}
```

### Pyroscope Kubernetes Deployment

```yaml
# pyroscope-values.yaml for Helm
pyroscope:
  replicaCount: 1
  persistence:
    enabled: true
    size: 50Gi
    storageClass: gp3

  config:
    storage:
      backend: s3
      s3:
        bucket: my-company-pyroscope
        region: us-east-1
        endpoint: ""

ingress:
  enabled: true
  hosts:
    - host: pyroscope.internal.example.com
      paths: ["/"]

---
# Application deployment snippet
spec:
  containers:
    - name: api-server
      env:
        - name: PYROSCOPE_URL
          value: http://pyroscope.monitoring.svc.cluster.local:4040
        - name: SERVICE_NAME
          value: api-server
        - name: APP_VERSION
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['version']
```

### Pyroscope Annotations for Context

```go
// Tag a specific operation for filtering in Pyroscope UI
func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
    // Add dynamic tags to the current profile interval
    pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
        "endpoint", r.URL.Path,
        "method", r.Method,
        "user_id", getUserID(r),
    ), func(ctx context.Context) {
        h.processRequest(w, r.WithContext(ctx))
    })
}
```

## Common Performance Patterns Revealed by Profiling

### JSON Marshaling Overhead

```
pprof top output:
  encoding/json.(*encodeState).marshal  15% CPU
  reflect.Value.Field                   8% CPU
```

Fix: Use `json.RawMessage` for pass-through data, or switch to `github.com/bytedance/sonic` or `github.com/goccy/go-json`.

### Map Access Under Lock

```
pprof top output:
  sync.(*RWMutex).Lock                  12% CPU
  runtime.mapaccess2                    10% CPU
```

Fix: Use `sync.Map` for read-heavy workloads, or partition the map by shard to reduce lock contention.

### Fmt.Sprintf in Hot Paths

```
pprof allocs output:
  fmt.Sprintf                          200MB/s allocations
```

Fix: Use `strconv.Itoa`, `strconv.AppendInt`, or a `strings.Builder` — all avoid allocations that `fmt.Sprintf` triggers for simple formatting.

### String Concatenation in Loops

```go
// Bad: O(n²) allocations
var result string
for _, s := range items {
    result += s + ","
}

// Good: single allocation
var b strings.Builder
b.Grow(estimatedSize)
for _, s := range items {
    b.WriteString(s)
    b.WriteByte(',')
}
result := b.String()
```

### Goroutine Leak Patterns

```
pprof goroutine output:
  goroutine 1234 [chan receive, 2400 minutes]:
  http.(*persistConn).writeLoop()
```

`2400 minutes` means a goroutine has been blocked for 40 hours — a classic goroutine leak from an HTTP client that never drains the response body:

```go
// Bad: never reads/closes response body → connection stays open
resp, _ := http.Get(url)

// Good
resp, err := http.Get(url)
if err != nil {
    return err
}
defer resp.Body.Close()
io.Copy(io.Discard, resp.Body) // Drain body to reuse connection
```

## Comparing Profiles Before and After Optimization

```bash
# Profile before optimization
curl -o before.prof "http://localhost:6060/debug/pprof/profile?seconds=30"

# Apply optimization
# ...

# Profile after
curl -o after.prof "http://localhost:6060/debug/pprof/profile?seconds=30"

# Compare
go tool pprof -diff_base=before.prof after.prof

(pprof) top10
# Functions with negative values improved; positive values regressed
```

## pprof in Production CI

Add benchmark regression detection to CI:

```bash
#!/usr/bin/env bash
# benchmark-regression.sh
set -euo pipefail

THRESHOLD=0.10  # 10% regression threshold

# Run benchmarks and compare to main branch
git stash
go test -bench=. -benchmem -count=5 ./... > baseline.txt
git stash pop

go test -bench=. -benchmem -count=5 ./... > current.txt

# Compare using benchstat
go run golang.org/x/perf/cmd/benchstat baseline.txt current.txt

# Fail if any benchmark regressed > threshold
go run golang.org/x/perf/cmd/benchstat -delta-test=ttest -alpha=0.05 \
  baseline.txt current.txt 2>&1 | \
  awk '/\+[0-9]+\.[0-9]+%/ { if ($NF + 0 > 10) { print "REGRESSION: " $0; exit 1 } }'
```

## Quick Reference

```bash
# Live CPU profile (30 seconds)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Live heap snapshot
go tool pprof http://localhost:6060/debug/pprof/heap

# Live allocations (includes freed)
go tool pprof http://localhost:6060/debug/pprof/allocs

# Goroutine dump
curl http://localhost:6060/debug/pprof/goroutine?debug=2

# Execution trace (5 seconds)
curl -o trace.out http://localhost:6060/debug/pprof/trace?seconds=5
go tool trace trace.out

# Flame graph from profile file
go tool pprof -http=localhost:8081 cpu.prof
```

## Summary

Go's profiling tools are among the best available in any language:

1. **Add the pprof HTTP endpoint** to every service, secured behind a non-public port.
2. **Collect CPU profiles** during high-load periods to find hot paths.
3. **Use diff profiles** (`-diff_base`) to verify that optimizations reduced the target allocation.
4. **Run execution traces** when diagnosing latency spikes or GC pause issues.
5. **Enable mutex and block profiling** only when you suspect contention — they add overhead.
6. **Deploy Pyroscope** for always-on profiling — it eliminates the "we forgot to profile before the incident" problem.

The cost of having continuous profiling in production is negligible (< 1% CPU overhead for Pyroscope). The cost of not having it is spending hours adding `pprof` endpoints and reproducing conditions on a production incident.
