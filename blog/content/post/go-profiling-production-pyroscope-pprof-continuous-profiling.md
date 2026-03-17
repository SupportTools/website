---
title: "Go Profiling in Production: Continuous Profiling with Pyroscope and pprof"
date: 2031-01-31T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Profiling", "Pyroscope", "pprof", "Performance", "Observability"]
categories:
- Go
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go production profiling: enabling pprof endpoints safely, deploying Pyroscope for continuous profiling, interpreting CPU and heap flame graphs, profiling-guided optimization, and measuring sampling overhead."
more_link: "yes"
url: "/go-profiling-production-pyroscope-pprof-continuous-profiling/"
---

Performance regression in production is one of the costliest problems an engineering team faces — expensive to investigate, expensive to reproduce, and expensive to fix after the fact. Go's built-in `net/http/pprof` package combined with Pyroscope's continuous profiling platform gives you always-on, low-overhead visibility into exactly where your application spends its CPU time and allocates memory. This guide covers everything from safe pprof endpoint exposure to deriving optimization decisions from flame graphs.

<!--more-->

# Go Profiling in Production: Continuous Profiling with Pyroscope and pprof

## Section 1: Understanding Go's Profiling Infrastructure

Go ships with a robust profiling runtime that can generate several profile types on demand:

| Profile Type | What It Measures | Overhead |
|---|---|---|
| `cpu` | CPU time per function (sampling) | ~5% during capture |
| `heap` | Live heap allocations | <1% always-on |
| `goroutine` | Current goroutine stacks | Low |
| `allocs` | All past allocations | <2% always-on |
| `block` | Goroutine blocking events | High (disabled by default) |
| `mutex` | Mutex contention | High (disabled by default) |
| `threadcreate` | OS thread creation | Minimal |
| `trace` | Execution trace | Very high |

The sampling-based nature of the CPU profiler is critical to understand: it fires every 10ms by default and records the current goroutine stack. This means short functions that complete between samples will appear to have zero CPU time, but functions with significant cumulative runtime are accurately represented.

## Section 2: Enabling pprof Endpoints Safely

### Never Expose pprof to the Public Internet

The `net/http/pprof` import registers handlers on `http.DefaultServeMux`, which is a common source of accidental exposure. The correct pattern is to use a separate internal server:

```go
// internal/server/server.go
package server

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    _ "net/http/pprof"   // Side-effect import registers /debug/pprof/ handlers
    "time"
)

// StartDebugServer starts a pprof HTTP server on an internal-only address.
// It should never be exposed to external traffic.
// Bind to localhost or a private VPC IP only.
func StartDebugServer(ctx context.Context, addr string) error {
    // Use a new ServeMux — do not use http.DefaultServeMux in production
    // because any other code could register handlers on it.
    mux := http.NewServeMux()

    // Register pprof handlers explicitly
    mux.HandleFunc("/debug/pprof/", http.DefaultServeMux.ServeHTTP)
    mux.HandleFunc("/debug/pprof/cmdline", http.DefaultServeMux.ServeHTTP)
    mux.HandleFunc("/debug/pprof/profile", http.DefaultServeMux.ServeHTTP)
    mux.HandleFunc("/debug/pprof/symbol", http.DefaultServeMux.ServeHTTP)
    mux.HandleFunc("/debug/pprof/trace", http.DefaultServeMux.ServeHTTP)

    // Add a health endpoint on the debug port too
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        fmt.Fprintln(w, "ok")
    })

    srv := &http.Server{
        Addr:         addr,
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 120 * time.Second, // CPU profiles can take 30s
        IdleTimeout:  60 * time.Second,
    }

    // Listen on a specific interface, not 0.0.0.0
    ln, err := net.Listen("tcp", addr)
    if err != nil {
        return fmt.Errorf("debug server listen: %w", err)
    }

    slog.Info("debug server starting", "addr", addr)

    go func() {
        <-ctx.Done()
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        srv.Shutdown(shutdownCtx)
    }()

    if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
        return fmt.Errorf("debug server: %w", err)
    }
    return nil
}
```

```go
// main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "yourcompany.com/myservice/internal/server"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    // Debug server binds to pod IP (internal to cluster) only
    // Never bind to 0.0.0.0 for pprof
    debugAddr := "127.0.0.1:6060"
    if envAddr := os.Getenv("DEBUG_ADDR"); envAddr != "" {
        debugAddr = envAddr
    }

    go func() {
        if err := server.StartDebugServer(ctx, debugAddr); err != nil {
            slog.Error("debug server error", "err", err)
        }
    }()

    // Start your main application server
    runApplication(ctx)
}
```

### Kubernetes Configuration for pprof Access

```yaml
# deployment.yaml excerpt
spec:
  template:
    spec:
      containers:
        - name: myservice
          ports:
            - name: http
              containerPort: 8080
            - name: pprof
              containerPort: 6060  # Internal-only, not exposed via Service
          env:
            - name: DEBUG_ADDR
              value: "$(MY_POD_IP):6060"   # Bind to pod IP from Downward API
          envFrom:
            - fieldRef:
                fieldPath: status.podIP
              # Use initContainer or valueFrom/fieldRef to get pod IP
---
# A separate internal Service for pprof — no external LoadBalancer
apiVersion: v1
kind: Service
metadata:
  name: myservice-pprof
  namespace: production
  labels:
    app: myservice
    visibility: internal
spec:
  selector:
    app: myservice
  ports:
    - name: pprof
      port: 6060
      targetPort: 6060
  clusterIP: None   # Headless service — access individual pods
  type: ClusterIP
```

### Accessing pprof via kubectl port-forward

```bash
# Forward pprof port from a specific pod
kubectl port-forward -n production pod/myservice-xyz123 6060:6060 &

# Capture 30s CPU profile
go tool pprof -http=:8081 http://localhost:6060/debug/pprof/profile?seconds=30

# Capture heap profile
go tool pprof -http=:8081 http://localhost:6060/debug/pprof/heap

# Download allocs profile for allocation analysis
curl -s http://localhost:6060/debug/pprof/allocs?seconds=30 > allocs.prof
go tool pprof -http=:8081 allocs.prof

# List goroutines (useful for leak detection)
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 | head -100
```

## Section 3: Pyroscope Continuous Profiling

Pyroscope captures profiles continuously in the background with extremely low overhead (~0.1-2% CPU), enabling you to query performance data for any time window — not just when you're actively investigating.

### Deploying Pyroscope Server

```yaml
# pyroscope-deployment.yaml
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
          image: grafana/pyroscope:1.9.0
          args:
            - "-config.file=/etc/pyroscope/config.yaml"
          ports:
            - containerPort: 4040
              name: http
          volumeMounts:
            - name: config
              mountPath: /etc/pyroscope
            - name: data
              mountPath: /data/pyroscope
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
      volumes:
        - name: config
          configMap:
            name: pyroscope-config
        - name: data
          persistentVolumeClaim:
            claimName: pyroscope-data
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pyroscope-config
  namespace: monitoring
data:
  config.yaml: |
    server:
      http_listen_port: 4040

    storage:
      backend: filesystem
      filesystem:
        dir: /data/pyroscope

    limits:
      # Retention period for profiles
      retention_period: 168h   # 7 days

    compactor:
      enabled: true

    # For production, use S3 or GCS backend:
    # storage:
    #   backend: s3
    #   s3:
    #     bucket_name: my-pyroscope-bucket
    #     region: us-east-1
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
      name: http
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pyroscope-data
  namespace: monitoring
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 50Gi
```

### Go Application Integration

```go
// internal/profiling/pyroscope.go
package profiling

import (
    "log/slog"
    "os"
    "runtime"

    "github.com/grafana/pyroscope-go"
)

type Config struct {
    ServerAddress   string
    AppName         string
    Environment     string
    Version         string
    EnabledProfiles []pyroscope.ProfileType
}

func DefaultConfig() Config {
    return Config{
        ServerAddress: "http://pyroscope.monitoring.svc:4040",
        AppName:       "myservice",
        Environment:   os.Getenv("ENVIRONMENT"),
        Version:       os.Getenv("APP_VERSION"),
        EnabledProfiles: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
            pyroscope.ProfileGoroutines,
        },
    }
}

func Start(cfg Config) (*pyroscope.Profiler, error) {
    // Enable mutex and block profiling for deeper insights
    // Note: these have non-trivial overhead — enable judiciously
    if os.Getenv("ENABLE_MUTEX_PROFILING") == "true" {
        runtime.SetMutexProfileFraction(5)
        cfg.EnabledProfiles = append(cfg.EnabledProfiles,
            pyroscope.ProfileMutexCount,
            pyroscope.ProfileMutexDuration,
        )
    }

    if os.Getenv("ENABLE_BLOCK_PROFILING") == "true" {
        runtime.SetBlockProfileRate(1)
        cfg.EnabledProfiles = append(cfg.EnabledProfiles,
            pyroscope.ProfileBlockCount,
            pyroscope.ProfileBlockDuration,
        )
    }

    hostname, _ := os.Hostname()
    podName := os.Getenv("MY_POD_NAME")
    if podName == "" {
        podName = hostname
    }

    profiler, err := pyroscope.Start(pyroscope.Config{
        ApplicationName: cfg.AppName,
        ServerAddress:   cfg.ServerAddress,
        Logger:          pyroscope.StandardLogger,

        // Tags allow filtering in the Pyroscope UI
        Tags: map[string]string{
            "environment": cfg.Environment,
            "version":     cfg.Version,
            "pod":         podName,
            "node":        os.Getenv("MY_NODE_NAME"),
        },

        ProfileTypes: cfg.EnabledProfiles,

        // Upload interval — lower = more granular, higher = less overhead
        UploadRate: 15 * time.Second,
    })
    if err != nil {
        return nil, fmt.Errorf("pyroscope start: %w", err)
    }

    slog.Info("pyroscope profiling started",
        "server", cfg.ServerAddress,
        "app", cfg.AppName,
        "profiles", len(cfg.EnabledProfiles))

    return profiler, nil
}
```

```go
// main.go
package main

import (
    "context"
    "log/slog"
    "os"

    "yourcompany.com/myservice/internal/profiling"
)

func main() {
    ctx := setupContext()

    // Start continuous profiling early in application lifecycle
    if os.Getenv("PYROSCOPE_ENABLED") != "false" {
        cfg := profiling.DefaultConfig()
        profiler, err := profiling.Start(cfg)
        if err != nil {
            slog.Warn("profiling unavailable", "err", err)
        } else {
            defer profiler.Stop()
        }
    }

    // ... rest of application startup
    runApplication(ctx)
}
```

### Tagged Profiles for Request-Level Granularity

Use Pyroscope's tagging API to annotate profiles with business context:

```go
// middleware/profiling.go
package middleware

import (
    "net/http"

    "github.com/grafana/pyroscope-go"
)

// ProfilingMiddleware adds per-request tags to Pyroscope profiles.
// This allows you to filter flame graphs by endpoint, user tier, etc.
func ProfilingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Tag the current goroutine with request metadata
        pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
            "endpoint", r.URL.Path,
            "method", r.Method,
            "service_version", os.Getenv("APP_VERSION"),
        ), func(ctx context.Context) {
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    })
}
```

```go
// For gRPC servers
func UnaryProfilingInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        var resp interface{}
        var err error

        pyroscope.TagWrapper(ctx, pyroscope.Labels(
            "grpc_method", info.FullMethod,
        ), func(taggedCtx context.Context) {
            resp, err = handler(taggedCtx, req)
        })

        return resp, err
    }
}
```

## Section 4: Reading and Interpreting Flame Graphs

### CPU Flame Graph Anatomy

A CPU flame graph represents the sampled call stacks:
- **X-axis width** proportional to CPU time consumed (not time order)
- **Y-axis** represents call depth; callee above caller
- **Color** typically random (for visual distinction) unless encoding another dimension

When reading a flame graph:
- **Wide plateaus at the top** are your optimization targets — these are the leaf functions consuming the most CPU
- **Tall narrow towers** indicate deep call chains; look at the plateau at the top of the tower
- **Wide frames at the bottom** are common ancestors; optimize what's above them

### Generating and Comparing Flame Graphs

```bash
# Capture baseline CPU profile (30 seconds)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# In the pprof interactive shell:
(pprof) top20              # Show top 20 functions by CPU
(pprof) web                # Open flame graph in browser (requires graphviz)
(pprof) list functionName  # Show annotated source for a function
(pprof) peek functionName  # Show callers and callees

# Generate SVG flame graph
go tool pprof -svg -output=cpu.svg \
  http://localhost:6060/debug/pprof/profile?seconds=30

# Compare two profiles (before and after optimization)
go tool pprof -base=before.prof after.prof
(pprof) top20              # Shows the difference — negative = improvement
```

### Heap Profile Interpretation

```bash
# Capture heap profile
go tool pprof http://localhost:6060/debug/pprof/heap

(pprof) top20 -cum         # Sort by cumulative allocation
(pprof) list parseJSON     # Show allocations within parseJSON function

# Four heap profile views:
# inuse_objects: currently live objects (count)
# inuse_space:   currently live objects (bytes) — default view
# alloc_objects: all allocations since start (count)
# alloc_space:   all allocations since start (bytes)

# Switch views
(pprof) sample_index=alloc_space
(pprof) top20

# Find allocation hot spots
(pprof) tree               # Show full allocation tree
```

### Goroutine Profile for Leak Detection

```go
// goroutine-check.go — a utility to periodically check for goroutine leaks
package main

import (
    "fmt"
    "net/http"
    "runtime"
    "time"
)

func startGoroutineMonitor() {
    baseline := runtime.NumGoroutine()
    ticker := time.NewTicker(30 * time.Second)

    go func() {
        for range ticker.C {
            current := runtime.NumGoroutine()
            delta := current - baseline

            if delta > 100 {
                // Capture goroutine dump for analysis
                resp, _ := http.Get("http://localhost:6060/debug/pprof/goroutine?debug=2")
                // Log or save the dump
                slog.Warn("goroutine count spike detected",
                    "baseline", baseline,
                    "current", current,
                    "delta", delta)
            }

            fmt.Printf("goroutines: current=%d, delta=%+d\n", current, delta)
        }
    }()
}
```

## Section 5: Profiling-Guided Optimization Workflow

### Step 1: Establish a Performance Baseline

```go
// benchmark_test.go
package processor

import (
    "testing"
)

func BenchmarkProcessBatch(b *testing.B) {
    items := generateTestItems(1000)

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        ProcessBatch(items)
    }
}

// Run with CPU and memory profiling
// go test -bench=BenchmarkProcessBatch -benchmem \
//   -cpuprofile=cpu.before.prof \
//   -memprofile=mem.before.prof \
//   -count=5
```

### Step 2: Identify the Hot Path

```bash
# Analyze the benchmark profile
go tool pprof -http=:8081 cpu.before.prof

# Look for the widest frames in the flame graph
# Example output from top20:
#
# Showing nodes accounting for 8.40s, 91.30% of 9.20s total
# Dropped 45 nodes (cum <= 46ms)
# Showing top 20 nodes out of 87
#      flat  flat%   sum%        cum   cum%
#     3.20s 34.78% 34.78%      3.20s 34.78%  encoding/json.(*decodeState).object
#     1.80s 19.57% 54.35%      1.80s 19.57%  runtime.mallocgc
#     1.10s 11.96% 66.30%      3.90s 42.39%  encoding/json.(*decodeState).unmarshal
#     0.90s  9.78% 76.09%      0.90s  9.78%  strings.Builder.WriteString
```

### Step 3: Apply Targeted Optimizations

Example: Replacing `encoding/json` with a zero-allocation alternative:

```go
// Before: standard library JSON (causes many allocations)
package processor

import (
    "encoding/json"
)

type Item struct {
    ID    int    `json:"id"`
    Name  string `json:"name"`
    Value float64 `json:"value"`
}

func ProcessBatch(data []byte) ([]Item, error) {
    var items []Item
    if err := json.Unmarshal(data, &items); err != nil {
        return nil, fmt.Errorf("unmarshal: %w", err)
    }
    return items, nil
}
```

```go
// After: sonic (byte-slice based, zero-copy where possible)
package processor

import (
    "github.com/bytedance/sonic"
)

func ProcessBatch(data []byte) ([]Item, error) {
    var items []Item
    if err := sonic.Unmarshal(data, &items); err != nil {
        return nil, fmt.Errorf("unmarshal: %w", err)
    }
    return items, nil
}
```

```go
// Before: string concatenation in a hot loop
func buildQuery(filters []string) string {
    result := ""
    for _, f := range filters {
        result += f + " AND "
    }
    return strings.TrimSuffix(result, " AND ")
}

// After: strings.Builder with pre-allocated capacity
func buildQuery(filters []string) string {
    if len(filters) == 0 {
        return ""
    }

    // Estimate capacity
    totalLen := 0
    for _, f := range filters {
        totalLen += len(f)
    }
    totalLen += len(" AND ") * (len(filters) - 1)

    var sb strings.Builder
    sb.Grow(totalLen)

    for i, f := range filters {
        if i > 0 {
            sb.WriteString(" AND ")
        }
        sb.WriteString(f)
    }
    return sb.String()
}
```

```go
// Before: creating a new map on every request
func getMetrics(tags []Tag) map[string]string {
    m := make(map[string]string)
    for _, t := range tags {
        m[t.Key] = t.Value
    }
    return m
}

// After: sync.Pool to reuse maps
var tagMapPool = sync.Pool{
    New: func() interface{} {
        return make(map[string]string, 8)
    },
}

func getMetrics(tags []Tag) map[string]string {
    m := tagMapPool.Get().(map[string]string)
    // Clear map without allocating a new one
    for k := range m {
        delete(m, k)
    }
    for _, t := range tags {
        m[t.Key] = t.Value
    }
    return m
}

// Caller must return the map when done
func releaseMetrics(m map[string]string) {
    tagMapPool.Put(m)
}
```

### Step 4: Measure the Improvement

```bash
# Run benchmark again with profiling
go test -bench=BenchmarkProcessBatch -benchmem \
  -cpuprofile=cpu.after.prof \
  -memprofile=mem.after.prof \
  -count=5

# Compare results with benchstat
go install golang.org/x/perf/cmd/benchstat@latest

benchstat cpu.before.txt cpu.after.txt

# Example output:
# name              old time/op    new time/op    delta
# ProcessBatch-8    4.21ms ± 3%    1.87ms ± 2%   -55.58%
#
# name              old alloc/op   new alloc/op   delta
# ProcessBatch-8    2.14MB ± 1%    0.31MB ± 2%   -85.51%
#
# name              old allocs/op  new allocs/op  delta
# ProcessBatch-8    18.2k ± 0%     2.1k ± 0%     -88.46%

# Compare flame graphs visually
go tool pprof -base=cpu.before.prof cpu.after.prof
```

## Section 6: Production Sampling Overhead

### Measuring pprof Impact

```go
// overhead_test.go — measure the impact of profiling
package main

import (
    "net/http"
    _ "net/http/pprof"
    "runtime"
    "testing"
    "time"
)

func BenchmarkWithoutProfiling(b *testing.B) {
    for i := 0; i < b.N; i++ {
        doWork()
    }
}

func BenchmarkWithCPUProfiling(b *testing.B) {
    // CPU profiling is active during this benchmark
    // Start a CPU profile capture in parallel
    go func() {
        http.Get("http://localhost:6060/debug/pprof/profile?seconds=10")
    }()

    time.Sleep(100 * time.Millisecond) // Let profile start

    for i := 0; i < b.N; i++ {
        doWork()
    }
}
```

### Pyroscope Overhead Characterization

Typical measured overhead on production Go services:

```
CPU Profiling (pyroscope default):
  Sampling rate: 100 samples/second
  CPU overhead:  0.5-1.5% on a 4-core pod
  Memory:        ~2MB resident

Heap Profiling:
  Overhead:      ~1% allocation cost (runtime.MemProfile)
  Memory:        ~1MB resident

Goroutine Profiling:
  Per-upload:    <1ms STW pause
  Upload rate:   every 15s
  Overhead:      Negligible

Block Profiling (disabled by default):
  Overhead:      10-25% — only enable temporarily
  Use case:      Investigating channel/mutex contention

Mutex Profiling (disabled by default):
  Overhead:      5-15% — only enable temporarily
  Use case:      Investigating lock contention
```

### Adaptive Profiling Based on CPU Utilization

```go
// adaptive_profiling.go — reduce profiling overhead under high CPU
package profiling

import (
    "runtime"
    "sync/atomic"
    "time"

    "github.com/grafana/pyroscope-go"
)

type AdaptiveProfiler struct {
    profiler    *pyroscope.Profiler
    highCPU     atomic.Bool
    cpuThreshold float64  // e.g., 0.85 = 85%
}

func (ap *AdaptiveProfiler) Start() {
    go ap.monitor()
}

func (ap *AdaptiveProfiler) monitor() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    var prevStat runtime.MemStats
    runtime.ReadMemStats(&prevStat)

    for range ticker.C {
        var stat runtime.MemStats
        runtime.ReadMemStats(&stat)

        // Simple CPU heuristic using GC CPU fraction
        // In production, use actual CPU metrics from cgroups
        gcCPU := float64(stat.GCCPUFraction)

        if gcCPU > 0.10 { // GC consuming >10% — system under pressure
            if !ap.highCPU.Load() {
                ap.highCPU.Store(true)
                // Reduce sampling rate
                runtime.SetCPUProfileRate(50) // Default is 100
                slog.Warn("high CPU detected, reducing profiling rate")
            }
        } else {
            if ap.highCPU.Load() {
                ap.highCPU.Store(false)
                runtime.SetCPUProfileRate(100) // Restore default
                slog.Info("CPU normalized, restoring profiling rate")
            }
        }
    }
}
```

## Section 7: Advanced pprof Techniques

### Custom Profile Types

```go
// custom_profiler.go — track business-level profiles
package profiling

import (
    "runtime/pprof"
    "strings"
)

// slowQueryProfile tracks slow database queries with their call stacks.
var slowQueryProfile = pprof.NewProfile("slow_queries")

func TrackSlowQuery(query string, duration time.Duration) {
    if duration > 100*time.Millisecond {
        // Record the current call stack tagged with query info
        slowQueryProfile.Add(strings.NewReader(query), 1)
    }
}

func init() {
    // Register handler to expose via pprof endpoint
    // Access at /debug/pprof/slow_queries
}
```

### Execution Tracing for Latency Spikes

For investigating latency outliers (not just average behavior):

```go
// trace_capture.go
package profiling

import (
    "bytes"
    "net/http"
    "os"
    "runtime/trace"
    "time"
)

// CaptureTrace records a 5-second execution trace and writes it to a file.
// The trace file can be analyzed with: go tool trace trace.out
func CaptureTrace(duration time.Duration) error {
    var buf bytes.Buffer
    if err := trace.Start(&buf); err != nil {
        return fmt.Errorf("trace start: %w", err)
    }

    time.Sleep(duration)
    trace.Stop()

    filename := fmt.Sprintf("/tmp/trace-%d.out", time.Now().Unix())
    if err := os.WriteFile(filename, buf.Bytes(), 0600); err != nil {
        return fmt.Errorf("write trace: %w", err)
    }

    slog.Info("trace captured", "file", filename, "size", len(buf.Bytes()))
    return nil
}

// HTTP handler to trigger trace capture on demand
func TraceHandler(w http.ResponseWriter, r *http.Request) {
    seconds := 5
    if s := r.URL.Query().Get("seconds"); s != "" {
        fmt.Sscan(s, &seconds)
    }

    duration := time.Duration(seconds) * time.Second
    if err := CaptureTrace(duration); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    fmt.Fprintf(w, "trace captured for %v\n", duration)
}
```

### Differential Flame Graph Script

```bash
#!/bin/bash
# differential-flame.sh — compare two time windows in Pyroscope

set -euo pipefail

PYROSCOPE_URL="${PYROSCOPE_URL:-http://pyroscope.monitoring.svc:4040}"
APP_NAME="${1:-myservice}"
BEFORE_FROM="${2:-2031-01-30T09:00:00Z}"
BEFORE_UNTIL="${3:-2031-01-30T09:30:00Z}"
AFTER_FROM="${4:-2031-01-30T10:00:00Z}"
AFTER_UNTIL="${5:-2031-01-30T10:30:00Z}"

echo "Fetching 'before' profile from Pyroscope..."
curl -s "${PYROSCOPE_URL}/pyroscope/render?from=${BEFORE_FROM}&until=${BEFORE_UNTIL}&query=${APP_NAME}.cpu&format=pprof" \
  -o before.pprof

echo "Fetching 'after' profile from Pyroscope..."
curl -s "${PYROSCOPE_URL}/pyroscope/render?from=${AFTER_FROM}&until=${AFTER_UNTIL}&query=${APP_NAME}.cpu&format=pprof" \
  -o after.pprof

echo "Generating differential profile..."
go tool pprof -http=:8081 -base=before.pprof after.pprof
```

## Section 8: Integration with Grafana

Pyroscope integrates natively with Grafana 10+ via the Grafana Pyroscope data source:

```yaml
# grafana-pyroscope-datasource.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  pyroscope.yaml: |
    apiVersion: 1
    datasources:
      - name: Pyroscope
        type: grafana-pyroscope-datasource
        url: http://pyroscope.monitoring.svc:4040
        access: proxy
        isDefault: false
        jsonData:
          minStep: "15s"
```

### Grafana Dashboard Panels for Profiling

```json
{
  "panels": [
    {
      "type": "flamegraph",
      "title": "CPU Flame Graph - Production",
      "datasource": "Pyroscope",
      "targets": [
        {
          "profileTypeId": "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
          "labelSelector": "{application=\"myservice\",environment=\"production\"}"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Heap Usage Over Time",
      "datasource": "Pyroscope",
      "targets": [
        {
          "profileTypeId": "memory:inuse_space:bytes:space:bytes",
          "labelSelector": "{application=\"myservice\"}",
          "groupBy": ["pod"]
        }
      ]
    }
  ]
}
```

## Section 9: Profiling Checklist for Production

Use this checklist when investigating a performance issue:

```bash
# 1. Check current resource consumption
kubectl top pods -n production --sort-by=cpu | head -20

# 2. Get goroutine count — a proxy for goroutine leaks
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -5

# 3. Check GC pressure
curl -s http://localhost:6060/debug/pprof/heap > heap.prof
go tool pprof -http=:8081 heap.prof
# Look for: GC overhead, large retained objects

# 4. Capture CPU profile during the incident
curl -s "http://localhost:6060/debug/pprof/profile?seconds=30" > cpu.prof
go tool pprof -http=:8082 cpu.prof

# 5. Check for mutex contention (requires runtime.SetMutexProfileFraction > 0)
curl -s http://localhost:6060/debug/pprof/mutex > mutex.prof
go tool pprof -http=:8083 mutex.prof

# 6. Check for blocking operations
curl -s http://localhost:6060/debug/pprof/block > block.prof
go tool pprof -http=:8084 block.prof

# 7. Correlate with Pyroscope historical data
open "http://pyroscope.monitoring.svc:4040"
# Filter by: application=myservice, time range = incident window
```

## Section 10: Common Profiling Anti-Patterns

### Anti-Pattern: Profiling with a Microbenchmark Instead of Production Traffic

Microbenchmarks test isolated functions with synthetic inputs. Pyroscope's continuous profiling reveals the actual hot paths under real traffic patterns, which often differ significantly from what you'd predict.

### Anti-Pattern: Ignoring Allocation Profiles

CPU profiles show where time is spent, but allocation profiles reveal GC pressure. A function that allocates heavily will indirectly slow other functions by triggering GC cycles. Always check both.

### Anti-Pattern: Over-Optimizing Based on a Single Profile

CPU profiles are statistical. A single 30-second sample may not be representative. Collect multiple samples across different traffic patterns and use Pyroscope's longer time windows (4h, 24h) to see the consistent hot paths.

### Anti-Pattern: Disabling pprof in Production

Many teams disable pprof "for security" and then have no data during a production incident. The correct approach is to bind to an internal-only address with network policies restricting access to the monitoring namespace.

```yaml
# NetworkPolicy: only allow pyroscope and monitoring tools to reach pprof
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-pprof-from-monitoring
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: myservice
  ingress:
    - ports:
        - port: 6060
      from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: pyroscope
```

The combination of always-on Pyroscope collection and on-demand pprof capture gives production Go services a complete performance observability solution with minimal runtime impact.
