---
title: "Go Performance Profiling Workflow: pprof HTTP Endpoint, go tool pprof, inuse_space vs alloc_space, Mutex Profiling"
date: 2031-11-26T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Performance", "Profiling", "pprof", "Observability", "Memory Management"]
categories:
- Go
- Performance Engineering
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete Go profiling workflow for production services: exposing pprof endpoints safely, interpreting CPU and memory profiles, distinguishing inuse_space from alloc_space, and surfacing mutex contention hotspots."
more_link: "yes"
url: "/go-performance-profiling-pprof-workflow-enterprise-guide/"
---

Go ships a world-class profiler in the standard library. The gap between knowing pprof exists and systematically using it to find production bottlenecks is large, and most teams only reach for it during incidents. This guide closes that gap: you will come away with a repeatable profiling workflow, an understanding of every major profile type, and the ability to interpret flame graphs and text output with confidence.

<!--more-->

# Go Performance Profiling Workflow: pprof From First Principles

## Why pprof Over External Profilers

Go's profiler operates at the goroutine level, understands the runtime scheduler, and can correlate allocations with call sites. It costs less than 5% CPU overhead at the default sampling rate. External profilers (perf, eBPF) see machine instructions and miss the goroutine-level context that matters most for Go services.

## Section 1: Exposing the pprof HTTP Endpoint

### Minimal Integration

```go
package main

import (
    "net/http"
    _ "net/http/pprof"  // Side-effect import registers handlers
)

func main() {
    // Your existing mux
    mux := http.NewServeMux()
    mux.HandleFunc("/", appHandler)

    // pprof on a separate port - NEVER expose on the public port
    go func() {
        http.ListenAndServe("127.0.0.1:6060", nil)
    }()

    http.ListenAndServe(":8080", mux)
}
```

The `_ "net/http/pprof"` import registers the following routes on `http.DefaultServeMux`:

| Path | Description |
|------|-------------|
| `/debug/pprof/` | Index page |
| `/debug/pprof/goroutine` | Current goroutine stacks |
| `/debug/pprof/heap` | Heap memory profile |
| `/debug/pprof/allocs` | Allocation profile |
| `/debug/pprof/mutex` | Mutex contention |
| `/debug/pprof/block` | Blocking on synchronization |
| `/debug/pprof/threadcreate` | OS thread creation |
| `/debug/pprof/cmdline` | Command line args |
| `/debug/pprof/profile?seconds=N` | CPU profile for N seconds |
| `/debug/pprof/trace?seconds=N` | Execution trace for N seconds |

### Production-Safe Endpoint with Authentication

Never expose raw pprof on a public port. Use mTLS or bearer token authentication:

```go
package observability

import (
    "crypto/subtle"
    "net/http"
    "net/http/pprof"
    "os"
    "time"
)

// NewPprofServer creates a pprof server with token authentication.
// Token is read from PPROF_TOKEN environment variable.
func NewPprofServer(listenAddr string) *http.Server {
    token := os.Getenv("PPROF_TOKEN")
    if token == "" {
        panic("PPROF_TOKEN environment variable is required for pprof server")
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/debug/pprof/", tokenAuth(token, pprof.Index))
    mux.HandleFunc("/debug/pprof/cmdline", tokenAuth(token, pprof.Cmdline))
    mux.HandleFunc("/debug/pprof/profile", tokenAuth(token, pprof.Profile))
    mux.HandleFunc("/debug/pprof/symbol", tokenAuth(token, pprof.Symbol))
    mux.HandleFunc("/debug/pprof/trace", tokenAuth(token, pprof.Trace))

    return &http.Server{
        Addr:         listenAddr,
        Handler:      mux,
        ReadTimeout:  35 * time.Second, // CPU profile default is 30s
        WriteTimeout: 35 * time.Second,
        IdleTimeout:  60 * time.Second,
    }
}

func tokenAuth(expectedToken string, next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        if len(token) > 7 && token[:7] == "Bearer " {
            token = token[7:]
        }
        if subtle.ConstantTimeCompare([]byte(token), []byte(expectedToken)) != 1 {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }
        next(w, r)
    }
}
```

### Programmatic Profile Collection

For automated profiling pipelines:

```go
package profiling

import (
    "bytes"
    "fmt"
    "io"
    "net/http"
    "os"
    "time"
)

// ProfileCollector collects profiles from a running service.
type ProfileCollector struct {
    BaseURL string
    Token   string
    Client  *http.Client
}

func NewProfileCollector(baseURL, token string) *ProfileCollector {
    return &ProfileCollector{
        BaseURL: baseURL,
        Token:   token,
        Client: &http.Client{
            Timeout: 120 * time.Second,
        },
    }
}

func (p *ProfileCollector) CollectCPU(duration time.Duration) ([]byte, error) {
    url := fmt.Sprintf("%s/debug/pprof/profile?seconds=%d", p.BaseURL, int(duration.Seconds()))
    return p.collect(url)
}

func (p *ProfileCollector) CollectHeap() ([]byte, error) {
    return p.collect(p.BaseURL + "/debug/pprof/heap")
}

func (p *ProfileCollector) CollectAllocs() ([]byte, error) {
    return p.collect(p.BaseURL + "/debug/pprof/allocs")
}

func (p *ProfileCollector) CollectGoroutines() ([]byte, error) {
    return p.collect(p.BaseURL + "/debug/pprof/goroutine?debug=2")
}

func (p *ProfileCollector) CollectMutex() ([]byte, error) {
    return p.collect(p.BaseURL + "/debug/pprof/mutex")
}

func (p *ProfileCollector) collect(url string) ([]byte, error) {
    req, err := http.NewRequest("GET", url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+p.Token)

    resp, err := p.Client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, body)
    }

    var buf bytes.Buffer
    if _, err := io.Copy(&buf, resp.Body); err != nil {
        return nil, fmt.Errorf("reading response: %w", err)
    }
    return buf.Bytes(), nil
}

func (p *ProfileCollector) SaveProfiles(outputDir string) error {
    if err := os.MkdirAll(outputDir, 0755); err != nil {
        return err
    }
    ts := time.Now().Format("20060102-150405")

    profiles := map[string]func() ([]byte, error){
        fmt.Sprintf("%s/cpu-%s.pprof", outputDir, ts):       func() ([]byte, error) { return p.CollectCPU(30 * time.Second) },
        fmt.Sprintf("%s/heap-%s.pprof", outputDir, ts):      p.CollectHeap,
        fmt.Sprintf("%s/allocs-%s.pprof", outputDir, ts):    p.CollectAllocs,
        fmt.Sprintf("%s/goroutine-%s.txt", outputDir, ts):   p.CollectGoroutines,
        fmt.Sprintf("%s/mutex-%s.pprof", outputDir, ts):     p.CollectMutex,
    }

    for path, fn := range profiles {
        data, err := fn()
        if err != nil {
            fmt.Printf("Warning: failed to collect %s: %v\n", path, err)
            continue
        }
        if err := os.WriteFile(path, data, 0644); err != nil {
            return fmt.Errorf("writing %s: %w", path, err)
        }
        fmt.Printf("Saved %s (%d bytes)\n", path, len(data))
    }
    return nil
}
```

## Section 2: CPU Profiling

### Collecting a CPU Profile

```bash
# 30-second CPU profile, saved locally
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# With authentication
go tool pprof -http=:8081 \
  -header 'Authorization: Bearer <your-pprof-token>' \
  'http://localhost:6060/debug/pprof/profile?seconds=30'

# Save to file, analyze later
curl -s -H 'Authorization: Bearer <your-pprof-token>' \
  'http://localhost:6060/debug/pprof/profile?seconds=30' \
  -o cpu.pprof

go tool pprof -http=:8081 cpu.pprof
```

### Interpreting CPU Profile: top Command

```
(pprof) top 20 -cum

Showing nodes accounting for 8.43s, 72.17% of 11.68s total
Dropped 234 nodes (cum <= 0.06s)
Showing top 20 nodes out of 87
      flat  flat%   sum%        cum   cum%
         0     0%     0%      8.32s 71.23%  net/http.(*Server).Serve
         0     0%     0%      8.32s 71.23%  net/http.(*Server).serveConnImpl
     0.01s  0.09%  0.09%      8.21s 70.29%  net/http.(*conn).serve
     0.02s  0.17%  0.26%      7.98s 68.32%  net/http.serverHandler.ServeHTTP
     0.31s  2.65%  2.91%      7.96s 68.15%  main.processRequest
     1.23s 10.53% 13.44%      5.43s 46.49%  main.parseJSON
     3.21s 27.48% 40.92%      3.21s 27.48%  encoding/json.(*decodeState).unmarshal
     0.87s  7.45% 48.37%      2.18s 18.67%  main.validateSchema
```

Key columns:
- **flat**: CPU time spent in this function itself (not callees)
- **flat%**: Percentage of total samples
- **cum**: Cumulative time including callees
- **cum%**: Cumulative percentage

High `flat` with low `cum` means the function itself is the bottleneck. High `cum` with low `flat` means it calls expensive functions.

### Flame Graph Analysis

The web UI (`-http=:8081`) provides a flame graph where:
- Width represents total CPU time (flat + callees)
- Color has no semantic meaning (just visual differentiation)
- Height represents call depth

Look for:
1. Wide boxes near the bottom of the flame: your hot code paths
2. Unexpected runtime functions: `runtime.mallocgc` (allocation-heavy), `runtime.gcBgMarkWorker` (GC overhead), `runtime.morestack` (goroutine stack growth)

### CPU Profile: list Command

Annotate source lines with sample counts:

```
(pprof) list parseJSON

Total: 11.68s
ROUTINE ======================== main.parseJSON in /app/handlers.go
     1.23s      5.43s (flat, cum) 46.49% of Total
         .          .     45: func parseJSON(data []byte, v interface{}) error {
     0.02s      0.02s     46:   d := json.NewDecoder(bytes.NewReader(data))
     0.87s      4.76s     47:   return d.Decode(v)
     0.34s      0.65s     48: }
```

Line 47 (the actual `Decode` call) accounts for 4.76 seconds cumulatively. This points to `json.Decoder` as the bottleneck—often replaceable with `json.Unmarshal` for single objects, or a code-generated JSON library like `github.com/bytedance/sonic` or `github.com/mailru/easyjson`.

## Section 3: Heap Profiling — inuse_space vs alloc_space

This is the most commonly misunderstood aspect of Go heap profiling. The heap profile contains four different sample types, and choosing the wrong one leads to incorrect conclusions.

### The Four Heap Sample Types

| Sample Type | What It Measures | Use When |
|-------------|-----------------|----------|
| `inuse_space` | Memory currently allocated and not yet freed | Diagnosing memory leaks, steady-state RSS |
| `inuse_objects` | Count of currently allocated objects | Finding large numbers of small leaks |
| `alloc_space` | Total memory allocated since program start (cumulative) | Finding allocation hotspots driving GC pressure |
| `alloc_objects` | Total objects allocated since program start | Finding allocation-heavy code paths |

### Switching Sample Types

```bash
# Default: inuse_space
go tool pprof heap.pprof

# Switch inside the interactive session
(pprof) sample_index inuse_space
(pprof) sample_index inuse_objects
(pprof) sample_index alloc_space
(pprof) sample_index alloc_objects

# Or specify at load time
go tool pprof -sample_index alloc_space heap.pprof
```

### When to Use inuse_space

Use `inuse_space` when:
- Memory usage keeps growing (leak diagnosis)
- RSS is much higher than expected
- You want to know what's keeping memory alive right now

```
(pprof) top -sample_index inuse_space

      flat  flat%   sum%        cum   cum%
  125.50MB 42.18% 42.18%   125.50MB 42.18%  bytes.makeSlice
   89.25MB 30.01% 72.19%    89.25MB 30.01%  main.(*Cache).Set
   41.00MB 13.79% 86.00%    41.00MB 13.79%  encoding/json.(*decodeState).object
```

`bytes.makeSlice` holding 125MB is suspicious—trace where those slices are being retained. If they appear under `main.(*Cache).Set`, your cache is retaining byte slices instead of copying them.

### When to Use alloc_space

Use `alloc_space` when:
- GC pressure is high (high `GOGC` doesn't help, GC runs too frequently)
- CPU flame graph shows significant `runtime.gcBgMarkWorker` time
- You want to reduce allocations to lower GC pause frequency

```
(pprof) top -sample_index alloc_space

      flat  flat%   sum%        cum   cum%
  1.23GB  55.12% 55.12%     1.23GB 55.12%  fmt.Sprintf
  0.45GB  20.15% 75.27%     0.45GB 20.15%  strings.Join
  0.23GB  10.30% 85.57%     0.23GB 10.30%  encoding/json.Marshal
```

1.23GB allocated by `fmt.Sprintf` (not retained, already freed) means you're calling `fmt.Sprintf` in a hot loop. Replace with `strings.Builder` or pre-allocated buffers.

### Heap Profile Snapshot Comparison

Comparing two heap profiles taken minutes apart is the most reliable way to identify leaks:

```bash
# Collect two profiles 5 minutes apart
curl -s http://localhost:6060/debug/pprof/heap -o heap1.pprof
sleep 300
curl -s http://localhost:6060/debug/pprof/heap -o heap2.pprof

# Compare: show allocations in heap2 not in heap1
go tool pprof -base heap1.pprof heap2.pprof

(pprof) top -sample_index inuse_space

# Positive values = grew between snapshots (leak candidates)
# Negative values = freed between snapshots
```

### Runtime Memory Stats Integration

Expose memory stats alongside pprof for quick triage:

```go
package metrics

import (
    "runtime"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    heapAllocGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_memory_heap_alloc_bytes",
        Help: "Current heap allocation in bytes",
    })
    heapIdleGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "go_memory_heap_idle_bytes",
        Help: "Idle heap spans in bytes",
    })
    gcPauseHist = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "go_gc_pause_ns",
        Help:    "GC stop-the-world pause duration",
        Buckets: []float64{1e4, 1e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8},
    })
    numGCCounter = promauto.NewCounter(prometheus.CounterOpts{
        Name: "go_gc_cycles_total",
        Help: "Total number of GC cycles",
    })
)

func RecordMemStats() {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)

    heapAllocGauge.Set(float64(ms.HeapAlloc))
    heapIdleGauge.Set(float64(ms.HeapIdle))

    // Track new GC pauses since last call
    // ms.PauseNs is a circular buffer of recent GC pause durations
    for i := uint32(0); i < ms.NumGC; i++ {
        idx := (ms.NumGC - 1 - i) % uint32(len(ms.PauseNs))
        if ms.PauseNs[idx] == 0 {
            break
        }
        gcPauseHist.Observe(float64(ms.PauseNs[idx]))
    }
}
```

## Section 4: Mutex Profiling

### Enabling Mutex Profiling

Mutex profiling is disabled by default because it adds overhead to every lock acquisition. Enable it at runtime:

```go
package main

import (
    "net/http"
    _ "net/http/pprof"
    "runtime"
)

func init() {
    // Enable mutex profiling at 1/10 sample rate
    // 1 = every contention event; N = 1-in-N events
    runtime.SetMutexProfileFraction(10)
}
```

Or enable it dynamically via an admin endpoint:

```go
func enableMutexProfileHandler(w http.ResponseWriter, r *http.Request) {
    fractionStr := r.URL.Query().Get("fraction")
    fraction := 10
    if fractionStr != "" {
        fmt.Sscanf(fractionStr, "%d", &fraction)
    }
    prev := runtime.SetMutexProfileFraction(fraction)
    fmt.Fprintf(w, "mutex profiling enabled at 1/%d (was 1/%d)\n", fraction, prev)
}
```

### Collecting and Analyzing

```bash
# Enable mutex profiling first (via your admin endpoint or init())
# Then collect
go tool pprof http://localhost:6060/debug/pprof/mutex

(pprof) top

      flat  flat%   sum%        cum   cum%
     890ms 56.42% 56.42%      890ms 56.42%  sync.(*RWMutex).Lock
     340ms 21.55% 77.97%      340ms 21.55%  sync.(*Mutex).Lock
     200ms 12.68% 90.65%      200ms 12.68%  sync.(*Map).Store
```

Wait — this output shows blocking time on lock acquisitions, not flat CPU time. A function appearing high here means goroutines spent significant time waiting for that lock.

```
(pprof) list (*Cache).Get

ROUTINE ======================== main.(*Cache).Get
     890ms      890ms (flat, cum) 56.42% of Total
         .          .    102: func (c *Cache) Get(key string) (interface{}, bool) {
     890ms      890ms    103:   c.mu.RLock()
         .          .    104:   defer c.mu.RUnlock()
         .          .    105:   v, ok := c.data[key]
         .          .    106:   return v, ok
         .          .    107: }
```

890ms spent waiting on `RLock` in the hot `Get` path indicates severe reader contention. Solutions:

1. **Sharded cache**: Use `N` separate caches with `key % N` routing
2. **sync.Map**: For predominantly-read, rarely-written caches
3. **Cache-aside pattern**: Store in a local goroutine-owned map, use channels for updates
4. **Atomics**: For single values, use `sync/atomic.Value`

### Block Profiling

Block profiling captures goroutines blocked on channel operations and sync primitives (but not mutex Lock — that's mutex profiling):

```go
// Enable block profiling
runtime.SetBlockProfileRate(1) // 1ns = capture all blocking events; use higher values in prod
```

```bash
go tool pprof http://localhost:6060/debug/pprof/block

(pprof) top

      flat  flat%   sum%        cum   cum%
    1.23s  70.11% 70.11%      1.23s 70.11%  runtime.chansend
    0.45s  25.63% 95.74%      0.45s 25.63%  runtime.selectgo
```

High `chansend` blocking indicates a channel consumer is too slow. Profile it with CPU profiling to find the bottleneck in the consumer goroutine.

## Section 5: Goroutine Profiling

### Finding Goroutine Leaks

```bash
# Get full goroutine dump
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutines.txt

# Count goroutines by state
grep -c "^goroutine" goroutines.txt

# Find goroutines stuck in same state
grep -A5 "goroutine [0-9]* \[" goroutines.txt | grep "\[" | sort | uniq -c | sort -rn
```

Typical goroutine leak patterns:

```
# Leak 1: Goroutine blocked forever on channel receive from abandoned producer
goroutine 1234 [chan receive, 1234 minutes]:
main.processEvents(0xc0001234, ...)
    /app/worker.go:89 +0x4a

# Leak 2: HTTP client goroutine blocked on slow backend
goroutine 5678 [IO wait, 45 minutes]:
net.(*netFD).Read(...)
    /usr/local/go/src/net/fd_unix.go:202

# Leak 3: goroutine waiting on select with no progress
goroutine 9012 [select, 234 minutes]:
main.(*Worker).Run(...)
    /app/worker.go:123
```

### Programmatic Goroutine Count Tracking

```go
package monitoring

import (
    "runtime"
    "time"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var goroutineGauge = promauto.NewGauge(prometheus.GaugeOpts{
    Name: "go_goroutines_active",
    Help: "Number of currently active goroutines",
})

func TrackGoroutines(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for range ticker.C {
        goroutineGauge.Set(float64(runtime.NumGoroutine()))
    }
}
```

Alert on sustained growth:

```promql
# Alert if goroutine count grows by more than 10% per 5 minutes
increase(go_goroutines_active[5m]) / go_goroutines_active offset 5m > 0.10
```

## Section 6: Execution Tracing

The execution trace captures a high-resolution timeline of scheduler events, GC phases, goroutine activity, and network I/O. Unlike pprof (statistical sampling), traces capture every event.

```bash
# Collect 5-second trace
curl -s http://localhost:6060/debug/pprof/trace?seconds=5 -o trace.out

# Analyze in browser
go tool trace trace.out
```

The trace viewer shows:
- **Goroutines**: Timeline of every goroutine, including blocked/runnable/running states
- **Heap**: GC cycles overlaid on heap growth
- **Threads**: OS thread assignments
- **GC**: STW phases highlighted in red

### Programmatic Tracing

```go
package tracing

import (
    "os"
    "runtime/trace"
    "time"
)

func CaptureTrace(duration time.Duration, outputPath string) error {
    f, err := os.Create(outputPath)
    if err != nil {
        return fmt.Errorf("creating trace file: %w", err)
    }
    defer f.Close()

    if err := trace.Start(f); err != nil {
        return fmt.Errorf("starting trace: %w", err)
    }
    defer trace.Stop()

    time.Sleep(duration)
    return nil
}
```

## Section 7: Benchmark-Driven Profiling

Profiling microbenchmarks produces cleaner profiles than profiling live services:

```go
package bench

import (
    "testing"
    "strings"
)

func BenchmarkStringConcat(b *testing.B) {
    parts := []string{"hello", "world", "foo", "bar", "baz"}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = strings.Join(parts, "-")
    }
}

func BenchmarkStringBuilder(b *testing.B) {
    parts := []string{"hello", "world", "foo", "bar", "baz"}
    b.ResetTimer()
    var sb strings.Builder
    for i := 0; i < b.N; i++ {
        sb.Reset()
        for j, p := range parts {
            if j > 0 {
                sb.WriteByte('-')
            }
            sb.WriteString(p)
        }
        _ = sb.String()
    }
}
```

```bash
# Profile a specific benchmark
go test -bench=BenchmarkStringConcat -benchmem \
  -cpuprofile cpu.pprof -memprofile mem.pprof \
  -run='^$' ./...

# Analyze
go tool pprof -http=:8081 cpu.pprof
go tool pprof -http=:8081 -sample_index alloc_space mem.pprof
```

## Section 8: Continuous Profiling Integration

### Sending Profiles to Pyroscope

```go
package main

import (
    "github.com/grafana/pyroscope-go"
)

func initPyroscope(serverAddr, appName string) {
    pyroscope.Start(pyroscope.Config{
        ApplicationName: appName,
        ServerAddress:   serverAddr,
        Logger:          pyroscope.StandardLogger,
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
        // Labels for multi-service deployments
        Tags: map[string]string{
            "hostname":    os.Getenv("HOSTNAME"),
            "environment": os.Getenv("APP_ENV"),
            "version":     version.String(),
        },
    })
}
```

### Kubernetes Annotations for Auto-Discovery

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
spec:
  template:
    metadata:
      annotations:
        profiles.grafana.com/cpu.scrape: "true"
        profiles.grafana.com/cpu.port: "6060"
        profiles.grafana.com/cpu.path: "/debug/pprof/profile"
        profiles.grafana.com/memory.scrape: "true"
        profiles.grafana.com/memory.port: "6060"
        profiles.grafana.com/memory.path: "/debug/pprof/heap"
        profiles.grafana.com/goroutine.scrape: "true"
        profiles.grafana.com/goroutine.port: "6060"
```

## Section 9: Optimization Workflows

### The Standard Investigation Loop

```
1. Observe symptom (high CPU, memory growth, slow p99)
      |
      v
2. Collect profiles (CPU, heap, mutex as appropriate)
      |
      v
3. Identify top contributors (top -cum for CPU; top inuse_space for memory)
      |
      v
4. Trace to source (list <function>)
      |
      v
5. Formulate hypothesis (allocation in loop, mutex contention, GC pressure)
      |
      v
6. Write benchmark for the specific operation
      |
      v
7. Implement and verify with benchmark -benchmem
      |
      v
8. Deploy and re-profile in production to confirm improvement
```

### Common Optimization Patterns

**Reduce allocations in hot path:**

```go
// Before: allocates a new byte slice on every call
func formatKey(namespace, name string) string {
    return fmt.Sprintf("%s/%s", namespace, name)
}

// After: zero allocation using a pre-sized builder pool
var builderPool = sync.Pool{
    New: func() interface{} {
        return &strings.Builder{}
    },
}

func formatKey(namespace, name string) string {
    b := builderPool.Get().(*strings.Builder)
    b.Reset()
    b.WriteString(namespace)
    b.WriteByte('/')
    b.WriteString(name)
    s := b.String()
    builderPool.Put(b)
    return s
}
```

**Reduce lock contention with sharding:**

```go
type ShardedCache struct {
    shards    [256]cacheShard
}

type cacheShard struct {
    mu   sync.RWMutex
    data map[string]interface{}
}

func (c *ShardedCache) shard(key string) *cacheShard {
    h := fnv.New32a()
    h.Write([]byte(key))
    return &c.shards[h.Sum32()%256]
}

func (c *ShardedCache) Get(key string) (interface{}, bool) {
    s := c.shard(key)
    s.mu.RLock()
    v, ok := s.data[key]
    s.mu.RUnlock()
    return v, ok
}
```

## Section 10: Profiling Cheat Sheet

```bash
# ---- CPU ----
# Interactive
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
# Web UI
go tool pprof -http=:8081 http://localhost:6060/debug/pprof/profile?seconds=30

# ---- Heap (inuse) ----
go tool pprof http://localhost:6060/debug/pprof/heap
# Web UI
go tool pprof -http=:8081 -sample_index inuse_space http://localhost:6060/debug/pprof/heap

# ---- Heap (allocs) ----
go tool pprof -sample_index alloc_space http://localhost:6060/debug/pprof/heap
# or use /allocs endpoint
go tool pprof http://localhost:6060/debug/pprof/allocs

# ---- Mutex ----
# First: runtime.SetMutexProfileFraction(10)
go tool pprof http://localhost:6060/debug/pprof/mutex

# ---- Goroutines ----
curl http://localhost:6060/debug/pprof/goroutine?debug=2 | less

# ---- Trace ----
curl -o trace.out http://localhost:6060/debug/pprof/trace?seconds=5
go tool trace trace.out

# ---- Compare two heap profiles ----
go tool pprof -base heap1.pprof heap2.pprof

# ---- Benchmark profiling ----
go test -bench=. -cpuprofile cpu.pprof -memprofile mem.pprof -run='^$' ./...
go tool pprof cpu.pprof
```

## Conclusion

The complete Go profiling workflow is:

1. **Expose pprof** on an internal port with token authentication.
2. **CPU profiles** reveal where time is spent; use `top -cum` to trace from entry points down to hotspots.
3. **Heap profiles**: use `inuse_space` for leak diagnosis, `alloc_space` for GC pressure reduction. Take two snapshots and diff them for leaks.
4. **Mutex profiling** requires explicit opt-in and reveals lock contention time — distinct from CPU time.
5. **Execution traces** provide the full scheduler timeline for diagnosing latency spikes and GC interactions.
6. **Continuous profiling** with Pyroscope or Grafana allows you to correlate performance regressions with deployments before users report them.

Profiling is most effective when integrated into your standard incident response and regression-detection workflows, not reserved for emergencies.
