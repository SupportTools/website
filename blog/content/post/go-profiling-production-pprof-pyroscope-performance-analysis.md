---
title: "Go Profiling in Production: pprof, Continuous Profiling with Pyroscope, and Performance Analysis"
date: 2030-01-11T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Profiling", "pprof", "Pyroscope", "Performance", "Flame Graphs"]
categories: ["Go", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production profiling guide using pprof HTTP endpoints, Pyroscope for continuous profiling, flame graph analysis, and CPU/memory/goroutine profiling workflows for Go enterprise services."
more_link: "yes"
url: "/go-profiling-production-pprof-pyroscope-performance-analysis/"
---

Performance problems in Go production services rarely announce themselves with clear error messages. Instead, they manifest as gradual latency increases, memory usage that never comes back down, or CPU utilization that spikes under specific traffic patterns. Profiling is the only reliable way to identify the root cause — but traditional profiling has a reputation for being intrusive, requiring service restarts or specialized builds.

Go's built-in profiling infrastructure, exposed through the `net/http/pprof` package, enables safe profiling of production services without any performance impact during normal operation. Combined with continuous profiling via Pyroscope, teams can maintain a rolling history of performance data, making it possible to answer "when did this regression start?" rather than just "what is slow right now?"

<!--more-->

# Go Profiling in Production: pprof, Continuous Profiling with Pyroscope, and Performance Analysis

## Understanding Go's Profiling Infrastructure

Go includes a sophisticated profiling system built into the runtime. The `runtime/pprof` package can capture profiles programmatically, and `net/http/pprof` exposes them over HTTP. Understanding what each profile type captures helps you choose the right tool:

| Profile Type | What It Measures | When to Use |
|---|---|---|
| CPU | Function execution time | High CPU, slow requests |
| Heap | Live allocations, GC pressure | Memory growth, GC pauses |
| Goroutine | All goroutines and stack traces | Goroutine leak, deadlock |
| Mutex | Contended mutex wait time | Lock contention |
| Block | Blocking synchronization events | Channel/select delays |
| Allocs | All allocations (not just live) | Allocation-heavy code paths |
| ThreadCreate | OS thread creation | Cgo goroutine issues |

## Part 1: Setting Up pprof in Production

### Safe pprof HTTP Endpoint

Never expose pprof on your main HTTP port. Use a separate internal port:

```go
// pkg/profiling/profiling.go
package profiling

import (
    "context"
    "fmt"
    "net/http"
    _ "net/http/pprof"  // Side-effect import registers handlers
    "time"

    "go.uber.org/zap"
)

// Server is a dedicated profiling HTTP server
type Server struct {
    server *http.Server
    log    *zap.Logger
}

// NewServer creates a profiling server on the given port
func NewServer(port int, log *zap.Logger) *Server {
    mux := http.NewServeMux()

    // pprof handlers are registered by the side-effect import above
    // They are registered on http.DefaultServeMux, so we need to proxy them
    mux.Handle("/debug/pprof/", http.DefaultServeMux)
    mux.Handle("/debug/pprof/cmdline", http.DefaultServeMux)
    mux.Handle("/debug/pprof/profile", http.DefaultServeMux)
    mux.Handle("/debug/pprof/symbol", http.DefaultServeMux)
    mux.Handle("/debug/pprof/trace", http.DefaultServeMux)

    // Add a simple index for documentation
    mux.HandleFunc("/debug", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, `
<!DOCTYPE html>
<html>
<body>
<h2>Go Profiling Endpoints</h2>
<ul>
  <li><a href="/debug/pprof/">/debug/pprof/</a> - Profile index</li>
  <li><a href="/debug/pprof/profile?seconds=30">CPU Profile (30s)</a></li>
  <li><a href="/debug/pprof/heap">Heap Profile</a></li>
  <li><a href="/debug/pprof/goroutine?debug=2">Goroutine Stacks</a></li>
  <li><a href="/debug/pprof/mutex">Mutex Profile</a></li>
  <li><a href="/debug/pprof/block">Block Profile</a></li>
</ul>
</body>
</html>`)
    })

    return &Server{
        log: log,
        server: &http.Server{
            Addr:         fmt.Sprintf("127.0.0.1:%d", port),  // Localhost only
            Handler:      mux,
            ReadTimeout:  5 * time.Second,
            // Long write timeout for CPU profiles (which run for seconds)
            WriteTimeout: 300 * time.Second,
        },
    }
}

// Start begins serving profiling endpoints
func (s *Server) Start(ctx context.Context) error {
    s.log.Info("Profiling server starting",
        zap.String("addr", s.server.Addr),
    )
    go func() {
        if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            s.log.Error("Profiling server error", zap.Error(err))
        }
    }()
    return nil
}

// Stop gracefully shuts down the profiling server
func (s *Server) Stop(ctx context.Context) error {
    return s.server.Shutdown(ctx)
}
```

### Enabling Mutex and Block Profiling

```go
// main.go - Enable profiling at startup
package main

import (
    "runtime"
    "runtime/pprof"
)

func init() {
    // Enable mutex profiling - samples 1/N mutexes
    // 1 = profile all mutexes (use for debugging, expensive)
    // 100 = 1% sampling (reasonable for production)
    runtime.SetMutexProfileFraction(100)

    // Enable block profiling
    // 1 = track all blocking events (expensive)
    // 100 = sample 1% (production-appropriate)
    runtime.SetBlockProfileRate(100)
}
```

### Kubernetes Network Policy for pprof Access

```yaml
# netpol-pprof-access.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-pprof-access
  namespace: production
spec:
  podSelector:
    matchLabels:
      pprof-enabled: "true"
  policyTypes:
    - Ingress
  ingress:
    # Allow access from monitoring namespace only
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - podSelector:
            matchLabels:
              app: pyroscope
      ports:
        - port: 6060    # pprof port
          protocol: TCP
    # Allow access from bastion/jump hosts
    - from:
        - ipBlock:
            cidr: 10.0.100.0/24  # Bastion network
      ports:
        - port: 6060
          protocol: TCP
```

## Part 2: Collecting Profiles

### Command-Line Profile Collection

```bash
# Port-forward to a specific pod's pprof endpoint
kubectl port-forward pod/api-gateway-7f9b4d6b5-xk2mj 6060:6060 -n production &

# Collect CPU profile (30 seconds)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Collect heap profile
go tool pprof http://localhost:6060/debug/pprof/heap

# Collect goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Collect allocs profile (allocation site frequency)
go tool pprof http://localhost:6060/debug/pprof/allocs

# Collect mutex contention
go tool pprof http://localhost:6060/debug/pprof/mutex

# Collect block profile
go tool pprof http://localhost:6060/debug/pprof/block

# Collect execution trace (high-fidelity, brief window)
curl -o trace.out http://localhost:6060/debug/pprof/trace?seconds=5
go tool trace trace.out
```

### Profile Collection Script

```bash
#!/bin/bash
# collect-profiles.sh - Collect a full diagnostic snapshot from a pod

POD="${1:-}"
NAMESPACE="${2:-production}"
PROFILE_DIR="profiles/$(date +%Y%m%d-%H%M%S)"

if [[ -z "$POD" ]]; then
    echo "Usage: $0 <pod-name> [namespace]"
    exit 1
fi

mkdir -p "$PROFILE_DIR"
echo "Collecting profiles from $POD in $NAMESPACE to $PROFILE_DIR"

# Start port-forward in background
kubectl port-forward "pod/$POD" 6060:6060 -n "$NAMESPACE" &
PF_PID=$!
sleep 2  # Wait for port-forward to establish

collect_profile() {
    local name="$1"
    local url="$2"
    echo "Collecting $name..."
    curl -s -o "$PROFILE_DIR/$name.pprof" "$url" && \
        echo "  Saved: $PROFILE_DIR/$name.pprof"
}

# Collect all profile types
collect_profile "heap" "http://localhost:6060/debug/pprof/heap"
collect_profile "goroutine" "http://localhost:6060/debug/pprof/goroutine"
collect_profile "allocs" "http://localhost:6060/debug/pprof/allocs"
collect_profile "mutex" "http://localhost:6060/debug/pprof/mutex"
collect_profile "block" "http://localhost:6060/debug/pprof/block"

# CPU profile takes 30 seconds
echo "Collecting CPU profile (30 seconds)..."
curl -s -o "$PROFILE_DIR/cpu.pprof" \
    "http://localhost:6060/debug/pprof/profile?seconds=30"
echo "  Saved: $PROFILE_DIR/cpu.pprof"

# Trace (5 seconds)
echo "Collecting execution trace (5 seconds)..."
curl -s -o "$PROFILE_DIR/trace.out" \
    "http://localhost:6060/debug/pprof/trace?seconds=5"
echo "  Saved: $PROFILE_DIR/trace.out"

# Stop port-forward
kill $PF_PID

echo ""
echo "=== Profile collection complete ==="
echo "Analyze with:"
echo "  go tool pprof -http=:8080 $PROFILE_DIR/cpu.pprof"
echo "  go tool pprof -http=:8080 $PROFILE_DIR/heap.pprof"
echo "  go tool trace $PROFILE_DIR/trace.out"
```

## Part 3: Analyzing Profiles

### CPU Profile Analysis

```bash
# Interactive pprof analysis
go tool pprof profiles/cpu.pprof

# In the pprof shell:
(pprof) top10           # Top 10 functions by cumulative CPU
(pprof) top10 -cum      # Top 10 by cumulative (including callees)
(pprof) web             # Open flame graph in browser
(pprof) list myFunc     # Show annotated source for myFunc
(pprof) traces          # Show sample traces

# Start web UI for interactive flame graph
go tool pprof -http=:8080 profiles/cpu.pprof
# Navigate to: localhost:8080

# Compare two profiles (before/after optimization)
go tool pprof -base profiles/cpu-before.pprof profiles/cpu-after.pprof
# Shows what improved and what got worse

# Generate flamegraph SVG
go tool pprof -svg -output cpu-flame.svg profiles/cpu.pprof

# Text format output for quick analysis
go tool pprof -text profiles/cpu.pprof | head -30
```

### Reading Flame Graphs

The flame graph visualization places the most expensive functions at the bottom, with each bar's width proportional to the amount of CPU time spent in that function and its callees.

```
Flame graph legend:
- Width = relative CPU time consumption
- Position from bottom = call stack depth (bottom = closer to main)
- Color = file/package (default: random, but consistent per run)
- Flat time = time in this function alone (top of each flame)
- Cumulative time = time in this function + all callees (full bar width)

Example interpretation:
┌─────────────────────────────────────────────────────────────┐
│ json.Marshal (40% CPU - wide = expensive)                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ json.marshalValue (35%)                              │    │
│  │  ┌───────────────────────┐ ┌────────────────────┐   │    │
│  │  │ json.marshalStruct(25)│ │ json.marshalSlice  │   │    │
│  │  └───────────────────────┘ └────────────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Heap Profile Analysis

```bash
# Heap profile analysis
go tool pprof -alloc_space profiles/heap.pprof   # Total allocations
go tool pprof -inuse_space profiles/heap.pprof   # Currently live allocations

# In the pprof shell for heap:
(pprof) top10                    # Top allocators by live space
(pprof) top10 -alloc_space       # Top allocators by total allocations
(pprof) list encodeResponse      # Show allocation lines in function

# Find allocation hotspots
go tool pprof -http=:8080 -alloc_objects profiles/allocs.pprof
# Use the "alloc_objects" view to see allocation frequency (not bytes)
```

### Goroutine Profile Analysis

```bash
# Goroutine profile - identify leaks
go tool pprof -http=:8080 profiles/goroutine.pprof

# Get goroutine dump as text (debug=2 shows full stack)
curl http://localhost:6060/debug/pprof/goroutine?debug=2 | head -200

# Quick goroutine count
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | \
    grep "^goroutine " | wc -l

# Monitor goroutine count over time
while true; do
    COUNT=$(curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | \
        grep "^goroutine " | wc -l)
    echo "$(date +%H:%M:%S) Goroutines: $COUNT"
    sleep 5
done
```

## Part 4: Continuous Profiling with Pyroscope

Pyroscope collects profiles continuously from all service instances, stores them in a time-series database, and provides a UI for querying performance over time.

### Deploying Pyroscope

```bash
# Add Pyroscope Helm repository
helm repo add pyroscope-io https://pyroscope-io.github.io/helm-chart
helm repo update

# Deploy Pyroscope with persistent storage
helm install pyroscope pyroscope-io/pyroscope \
    --namespace monitoring \
    --set pyroscope.extraArgs.log-level=info \
    --set persistence.enabled=true \
    --set persistence.size=100Gi \
    --set persistence.storageClass=fast-nvme \
    --set pyroscope.config="
        scrape_configs:
          - job_name: go-services
            enabled_profiles:
              - process_cpu
              - memory
              - mutex
              - block
              - goroutines
            scrape_interval: 15s
            static_configs:
              - application: api-gateway
                targets:
                  - api-gateway.production.svc.cluster.local:6060
                labels:
                  env: production
    " \
    --wait
```

### Go Pyroscope SDK Integration

```go
// pkg/profiling/pyroscope.go
package profiling

import (
    "context"
    "fmt"

    "github.com/grafana/pyroscope-go"
    "go.uber.org/zap"
)

// PyroscopeConfig holds configuration for continuous profiling
type PyroscopeConfig struct {
    ServerAddress   string `env:"PYROSCOPE_SERVER_ADDRESS" default:"http://pyroscope.monitoring.svc.cluster.local:4040"`
    ApplicationName string `env:"SERVICE_NAME" required:"true"`
    Environment     string `env:"ENVIRONMENT" default:"production"`

    // Profile types to enable
    ProfileCPU       bool `env:"PYROSCOPE_CPU" default:"true"`
    ProfileMem       bool `env:"PYROSCOPE_MEM" default:"true"`
    ProfileMutex     bool `env:"PYROSCOPE_MUTEX" default:"true"`
    ProfileBlock     bool `env:"PYROSCOPE_BLOCK" default:"true"`
    ProfileGoroutine bool `env:"PYROSCOPE_GOROUTINE" default:"true"`
}

// StartPyroscope initializes the Pyroscope continuous profiling agent
func StartPyroscope(cfg *PyroscopeConfig, log *zap.Logger) (*pyroscope.Profiler, error) {
    // Determine which profiles to enable
    var profileTypes []pyroscope.ProfileType
    if cfg.ProfileCPU {
        profileTypes = append(profileTypes, pyroscope.ProfileCPU)
    }
    if cfg.ProfileMem {
        profileTypes = append(profileTypes,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
        )
    }
    if cfg.ProfileMutex {
        profileTypes = append(profileTypes, pyroscope.ProfileMutexCount, pyroscope.ProfileMutexDuration)
    }
    if cfg.ProfileBlock {
        profileTypes = append(profileTypes, pyroscope.ProfileBlockCount, pyroscope.ProfileBlockDuration)
    }
    if cfg.ProfileGoroutine {
        profileTypes = append(profileTypes, pyroscope.ProfileGoroutines)
    }

    appName := fmt.Sprintf("%s.%s", cfg.ApplicationName, cfg.Environment)

    profiler, err := pyroscope.Start(pyroscope.Config{
        ApplicationName: appName,
        ServerAddress:   cfg.ServerAddress,
        Logger:          pyroscope.StandardLogger,
        Tags: map[string]string{
            "env":     cfg.Environment,
            "service": cfg.ApplicationName,
        },
        ProfileTypes: profileTypes,

        // Profile upload interval
        UploadRate: 15, // seconds
    })

    if err != nil {
        return nil, fmt.Errorf("starting Pyroscope: %w", err)
    }

    log.Info("Pyroscope continuous profiling started",
        zap.String("server", cfg.ServerAddress),
        zap.String("app", appName),
        zap.Int("profile_types", len(profileTypes)),
    )

    return profiler, nil
}

// TagRequest adds request-specific tags to the profile for the duration of a request
// This allows filtering profiles by endpoint, user, or other request attributes
func TagRequest(ctx context.Context, tags map[string]string, fn func(context.Context)) {
    pyroscope.TagWrapper(ctx, pyroscope.Labels(flattenTags(tags)...), func(ctx context.Context) {
        fn(ctx)
    })
}

func flattenTags(tags map[string]string) []string {
    result := make([]string, 0, len(tags)*2)
    for k, v := range tags {
        result = append(result, k, v)
    }
    return result
}
```

### Per-Request Tagging for Endpoint-Level Profiles

```go
// pkg/httpserver/profiling_middleware.go
package httpserver

import (
    "net/http"

    "github.com/grafana/pyroscope-go"
)

// ProfilingMiddleware tags profiles with the current request endpoint
// This allows Pyroscope to show CPU usage broken down by API endpoint
func ProfilingMiddleware(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Tag the goroutine with endpoint info for Pyroscope
        pyroscope.TagWrapper(
            r.Context(),
            pyroscope.Labels(
                "http_method", r.Method,
                "http_path", r.URL.Path,
                "user_agent_type", classifyUserAgent(r.UserAgent()),
            ),
            func(ctx context.Context) {
                next.ServeHTTP(w, r.WithContext(ctx))
            },
        )
    }
}

func classifyUserAgent(ua string) string {
    switch {
    case len(ua) == 0:
        return "empty"
    case containsAny(ua, "curl", "wget", "python-requests", "Go-http-client"):
        return "automation"
    case containsAny(ua, "Mozilla", "Chrome", "Safari", "Firefox"):
        return "browser"
    default:
        return "other"
    }
}

func containsAny(s string, substrs ...string) bool {
    for _, sub := range substrs {
        if strings.Contains(s, sub) {
            return true
        }
    }
    return false
}
```

## Part 5: Real-World Performance Investigation Patterns

### Pattern 1: High Memory Usage Investigation

```bash
# Step 1: Capture heap profile at peak memory
kubectl port-forward pod/$POD 6060:6060 -n production &
go tool pprof http://localhost:6060/debug/pprof/heap

# Step 2: In pprof shell, identify top allocators
(pprof) top10 -inuse_space
# Shows what is currently consuming memory

# Step 3: Check for allocation frequency vs size trade-off
(pprof) top10 -alloc_space
# vs
(pprof) top10 -alloc_objects
# If alloc_objects >> alloc_space: many small allocations (likely escape to heap)
# If alloc_space >> alloc_objects: few large allocations

# Step 4: Find the specific lines allocating
(pprof) list processRequest
# Shows source code with allocation counts per line

# Step 5: Compare heap before and after a suspected leak period
go tool pprof -base heap-before.pprof heap-after.pprof
# Shows net allocations
```

### Pattern 2: CPU Spike Investigation

```go
// Add this to your service for on-demand CPU profiling during incidents
// Called via internal endpoint: POST /internal/profile/start?seconds=30

package handler

import (
    "net/http"
    "os"
    "runtime/pprof"
    "strconv"
    "time"
)

func CPUProfileHandler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "POST required", http.StatusMethodNotAllowed)
        return
    }

    seconds := 30
    if s := r.URL.Query().Get("seconds"); s != "" {
        if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 120 {
            seconds = n
        }
    }

    // Write profile to file with timestamp
    filename := fmt.Sprintf("/tmp/cpu-profile-%d.pprof", time.Now().Unix())
    f, err := os.Create(filename)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    defer f.Close()

    if err := pprof.StartCPUProfile(f); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    time.Sleep(time.Duration(seconds) * time.Second)
    pprof.StopCPUProfile()

    fmt.Fprintf(w, `{"filename": %q, "duration_seconds": %d}`, filename, seconds)
}
```

### Pattern 3: Goroutine Leak Detection

```go
// pkg/profiling/goroutine_leak_detector.go
package profiling

import (
    "context"
    "fmt"
    "runtime"
    "time"

    "go.uber.org/zap"
)

// GoroutineLeakDetector monitors goroutine count and alerts on growth
type GoroutineLeakDetector struct {
    log             *zap.Logger
    checkInterval   time.Duration
    leakThreshold   int
    baselineGoroutines int
}

// NewLeakDetector creates a goroutine leak detector
func NewLeakDetector(log *zap.Logger) *GoroutineLeakDetector {
    return &GoroutineLeakDetector{
        log:           log,
        checkInterval: 30 * time.Second,
        leakThreshold: 1000,  // Alert if goroutines grow by this much
    }
}

// Run starts the leak detection loop
func (d *GoroutineLeakDetector) Run(ctx context.Context) {
    // Allow service to stabilize before capturing baseline
    time.Sleep(60 * time.Second)
    d.baselineGoroutines = runtime.NumGoroutine()
    d.log.Info("Goroutine baseline captured",
        zap.Int("baseline", d.baselineGoroutines))

    ticker := time.NewTicker(d.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            current := runtime.NumGoroutine()
            growth := current - d.baselineGoroutines

            d.log.Debug("Goroutine count",
                zap.Int("current", current),
                zap.Int("baseline", d.baselineGoroutines),
                zap.Int("growth", growth),
            )

            if growth > d.leakThreshold {
                d.log.Error("Possible goroutine leak detected",
                    zap.Int("current", current),
                    zap.Int("baseline", d.baselineGoroutines),
                    zap.Int("growth", growth),
                )
                // Capture goroutine profile automatically
                d.captureGoroutineProfile()
            }
        }
    }
}

func (d *GoroutineLeakDetector) captureGoroutineProfile() {
    filename := fmt.Sprintf("/tmp/goroutine-leak-%d.pprof", time.Now().Unix())
    f, err := os.Create(filename)
    if err != nil {
        d.log.Error("Creating goroutine profile file", zap.Error(err))
        return
    }
    defer f.Close()

    if err := pprof.Lookup("goroutine").WriteTo(f, 0); err != nil {
        d.log.Error("Writing goroutine profile", zap.Error(err))
        return
    }

    d.log.Info("Goroutine profile captured", zap.String("file", filename))
}
```

### Pattern 4: Lock Contention Analysis

```go
// Finding mutex contention with pprof

// First, ensure mutex profiling is enabled:
// runtime.SetMutexProfileFraction(1)  // Profile every mutex operation

// Then collect the mutex profile:
// curl http://localhost:6060/debug/pprof/mutex > mutex.pprof

// Analyze:
// go tool pprof -http=:8080 mutex.pprof
// Look for functions holding mutexes for long periods

// Example: detecting contention in a hot path
type SafeCounter struct {
    mu    sync.Mutex
    count int
}

// Bad: global mutex on hot path
var globalCounter SafeCounter

func (c *SafeCounter) Increment() {
    c.mu.Lock()    // Contention shows up in mutex profile
    c.count++
    c.mu.Unlock()
}

// Good: use atomic for simple counters
var atomicCounter atomic.Int64

func IncrementAtomic() {
    atomicCounter.Add(1)  // No mutex - no contention
}

// For more complex scenarios, consider sync.Map or sharded locks
type ShardedCounter struct {
    shards [256]struct {
        mu    sync.Mutex
        count int
        _     [56]byte  // Padding to prevent false sharing
    }
}

func (sc *ShardedCounter) Increment(key string) {
    shard := &sc.shards[fnv32(key)%256]
    shard.mu.Lock()
    shard.count++
    shard.mu.Unlock()
}
```

## Part 6: Benchmarking with pprof Integration

```go
// benchmark_test.go - Benchmarks with profile capture
package mypackage_test

import (
    "os"
    "runtime/pprof"
    "testing"
)

func BenchmarkJSONMarshal(b *testing.B) {
    data := generateTestData(1000)

    // Capture CPU profile during benchmark
    cpuFile, _ := os.Create("benchmark-cpu.pprof")
    pprof.StartCPUProfile(cpuFile)
    defer func() {
        pprof.StopCPUProfile()
        cpuFile.Close()
    }()

    b.ResetTimer()
    for b.Loop() {
        json.Marshal(data)
    }

    b.StopTimer()

    // Capture heap after benchmark
    heapFile, _ := os.Create("benchmark-heap.pprof")
    pprof.WriteHeapProfile(heapFile)
    heapFile.Close()
}

// Run benchmarks with built-in profiling:
// go test -bench=BenchmarkJSONMarshal -cpuprofile=cpu.pprof -memprofile=mem.pprof -benchtime=10s
// go tool pprof cpu.pprof
```

## Part 7: Automated Performance Regression Detection

```go
// pkg/profiling/regression_detector.go
package profiling

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "go.uber.org/zap"
)

// PerformanceBaseline holds baseline performance metrics
type PerformanceBaseline struct {
    Version       string    `json:"version"`
    Timestamp     time.Time `json:"timestamp"`
    CPUPercent    float64   `json:"cpu_percent"`
    HeapInuse     uint64    `json:"heap_inuse_bytes"`
    NumGoroutines int       `json:"num_goroutines"`
    GCPauseP99    float64   `json:"gc_pause_p99_ms"`
    AllocsPerOp   float64   `json:"allocs_per_op"`
}

// RuntimeMetricsCollector collects runtime metrics for performance tracking
type RuntimeMetricsCollector struct {
    log      *zap.Logger
    interval time.Duration
}

// CollectMetrics returns current runtime metrics
func (c *RuntimeMetricsCollector) CollectMetrics() PerformanceBaseline {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)

    // Calculate GC pause P99
    var maxPause float64
    for _, pause := range ms.PauseNs {
        if p := float64(pause) / 1e6; p > maxPause {
            maxPause = p
        }
    }

    return PerformanceBaseline{
        Timestamp:     time.Now(),
        HeapInuse:     ms.HeapInuse,
        NumGoroutines: runtime.NumGoroutine(),
        GCPauseP99:    maxPause,
    }
}

// CompareToBaseline compares current metrics to a stored baseline
func (c *RuntimeMetricsCollector) CompareToBaseline(
    current, baseline PerformanceBaseline,
) map[string]float64 {
    regressions := make(map[string]float64)

    heapGrowth := float64(current.HeapInuse) / float64(baseline.HeapInuse)
    if heapGrowth > 1.2 {  // >20% growth
        regressions["heap_growth"] = heapGrowth
    }

    goroutineGrowth := float64(current.NumGoroutines) / float64(baseline.NumGoroutines)
    if goroutineGrowth > 1.5 {  // >50% growth
        regressions["goroutine_growth"] = goroutineGrowth
    }

    gcGrowth := current.GCPauseP99 / baseline.GCPauseP99
    if gcGrowth > 2.0 {  // >100% increase in GC pauses
        regressions["gc_pause_growth"] = gcGrowth
    }

    return regressions
}
```

## Part 8: Production Profiling Workflow

```bash
#!/bin/bash
# production-profile-workflow.sh - Complete production profiling workflow

SERVICE="${1:-api-gateway}"
NAMESPACE="${2:-production}"
DURATION="${3:-30}"

echo "=== Production Profile Collection: $SERVICE ==="
echo "Duration: ${DURATION}s | Namespace: $NAMESPACE"

# Find the busiest pod (by CPU usage)
BUSIEST_POD=$(kubectl top pods -n "$NAMESPACE" -l "app=$SERVICE" \
    --no-headers | sort -k2 -hr | head -1 | awk '{print $1}')
echo "Targeting busiest pod: $BUSIEST_POD"

# Collect profiles
echo "--- Collecting CPU profile ---"
kubectl exec "$BUSIEST_POD" -n "$NAMESPACE" -- \
    curl -s http://localhost:6060/debug/pprof/profile?seconds="$DURATION" \
    > "cpu-${SERVICE}-$(date +%Y%m%d-%H%M%S).pprof"

echo "--- Collecting heap profile ---"
kubectl exec "$BUSIEST_POD" -n "$NAMESPACE" -- \
    curl -s http://localhost:6060/debug/pprof/heap \
    > "heap-${SERVICE}-$(date +%Y%m%d-%H%M%S).pprof"

echo "--- Checking goroutine count ---"
GOROUTINE_COUNT=$(kubectl exec "$BUSIEST_POD" -n "$NAMESPACE" -- \
    curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | \
    grep "^goroutine " | wc -l)
echo "Goroutines: $GOROUTINE_COUNT"

if [ "$GOROUTINE_COUNT" -gt 1000 ]; then
    echo "WARNING: High goroutine count detected! Collecting goroutine profile..."
    kubectl exec "$BUSIEST_POD" -n "$NAMESPACE" -- \
        curl -s http://localhost:6060/debug/pprof/goroutine \
        > "goroutine-${SERVICE}-$(date +%Y%m%d-%H%M%S).pprof"
fi

echo ""
echo "=== Profile Analysis ==="
echo "Analyze CPU:       go tool pprof -http=:8080 cpu-${SERVICE}-*.pprof"
echo "Analyze Heap:      go tool pprof -http=:8080 -inuse_space heap-${SERVICE}-*.pprof"
echo "Analyze Goroutine: go tool pprof -http=:8080 goroutine-${SERVICE}-*.pprof"
```

## Key Takeaways

Go's profiling infrastructure is production-safe and provides unparalleled visibility into service performance. The key workflow insights:

**CPU profiling confirms hypotheses, it does not generate them**: start with metrics (high latency, elevated CPU) to identify what to profile, then use pprof to understand why. Random profiling of healthy services is rarely productive.

**Heap profiles in three modes**: `-inuse_space` shows what is consuming memory now, `-alloc_space` shows what has consumed the most memory historically, and `-alloc_objects` shows what allocates most frequently. Each answers a different question.

**Multi-window goroutine monitoring catches leaks early**: goroutine counts should be stable in steady state. Monotonically increasing goroutine counts indicate leaks that will eventually exhaust memory.

**Pyroscope's time-series profiles answer "when did this start?"**: the ability to go back and look at performance profiles from before an incident began is invaluable for root cause analysis. Point-in-time profiling only tells you the current state.

**Per-endpoint tagging in Pyroscope** transforms the profiling experience. Instead of a single merged profile of all traffic, you can filter to a specific endpoint and see exactly which code paths it exercises. This makes endpoint-specific performance work tractable.
