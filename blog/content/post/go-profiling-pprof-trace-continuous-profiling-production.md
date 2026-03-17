---
title: "Profiling Go Applications with pprof, Trace, and Continuous Profiling in Production"
date: 2031-09-07T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "pprof", "Performance", "Profiling", "Observability", "Production"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to profiling Go applications using pprof, the execution tracer, and continuous profiling platforms like Pyroscope and Parca in production environments."
more_link: "yes"
url: "/go-profiling-pprof-trace-continuous-profiling-production/"
---

Go has some of the best built-in profiling tooling in any mainstream programming language. The `pprof` profiler, execution tracer, and memory analysis tools ship with the standard library, and the ecosystem has matured to support always-on continuous profiling in production. Despite this, most Go teams only profile when something is already broken, leaving substantial performance gains and reliability improvements on the table.

This guide covers the full spectrum of Go profiling: from the basics of CPU and memory profiles with `pprof`, to interpreting execution traces for concurrency problems, to deploying continuous profiling infrastructure with Pyroscope so you always have production profile data when you need it.

<!--more-->

# Profiling Go Applications in Production

## The Profiling Toolbox

Go's profiling ecosystem consists of four main tools:

| Tool | What It Measures | When to Use |
|------|-----------------|-------------|
| CPU profiler | Where CPU time is spent | High CPU usage, slow request handling |
| Memory profiler | Heap allocation patterns | Memory growth, GC pressure |
| Block profiler | Goroutine blocking on sync primitives | Contention, lock hotspots |
| Mutex profiler | Mutex contention | Lock contention analysis |
| Goroutine profiler | All goroutine stack traces | Goroutine leaks, deadlock investigation |
| Execution tracer | Full event trace over time | Scheduler analysis, GC pauses, concurrency |

Each answers different questions. Mature Go teams run CPU and memory profiling continuously and reach for the tracer when scheduler or GC issues are suspected.

## Setting Up pprof in Your Application

### HTTP Endpoint Exposure

The simplest way to expose pprof is via the `net/http/pprof` package:

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof" // Side-effect import registers handlers
    "time"
)

func main() {
    // Application server on port 8080
    go func() {
        mux := http.NewServeMux()
        // ... your application routes
        log.Fatal(http.ListenAndServe(":8080", mux))
    }()

    // pprof on a separate, internal-only port
    log.Fatal(http.ListenAndServe("localhost:6060", nil))
}
```

In production, never expose pprof on a public-facing port. The profiles reveal your application structure and can be used to fingerprint vulnerabilities. Use a separate port bound to localhost or the pod's internal IP, accessible only via `kubectl port-forward`.

### Structured pprof Exposure for Kubernetes

```go
package profiling

import (
    "context"
    "log/slog"
    "net/http"
    _ "net/http/pprof"
    "os"
    "time"
)

// Server runs a dedicated pprof HTTP server.
type Server struct {
    server *http.Server
    logger *slog.Logger
}

func NewServer(addr string, logger *slog.Logger) *Server {
    mux := http.NewServeMux()

    // pprof handlers are registered by the side-effect import above
    // but we re-register them explicitly for clarity and to add middleware
    mux.HandleFunc("/debug/pprof/", pprofHandler)
    mux.HandleFunc("/debug/pprof/cmdline", pprofHandler)
    mux.HandleFunc("/debug/pprof/profile", pprofHandler)
    mux.HandleFunc("/debug/pprof/symbol", pprofHandler)
    mux.HandleFunc("/debug/pprof/trace", pprofHandler)

    // Custom handler to add request timing and security headers
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Only allow from within the cluster
        if r.Header.Get("X-Forwarded-For") != "" {
            http.Error(w, "forbidden", http.StatusForbidden)
            return
        }
        w.Header().Set("Cache-Control", "no-store")
        mux.ServeHTTP(w, r)
    })

    return &Server{
        server: &http.Server{
            Addr:         addr,
            Handler:      handler,
            ReadTimeout:  120 * time.Second, // Long timeout for profile collection
            WriteTimeout: 120 * time.Second,
        },
        logger: logger,
    }
}

func (s *Server) Start() error {
    s.logger.Info("pprof server starting", "addr", s.server.Addr)
    return s.server.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
    return s.server.Shutdown(ctx)
}
```

### Manual Profile Collection in Code

For one-shot profiles triggered by application logic (e.g., after a spike detection):

```go
package profiling

import (
    "bytes"
    "context"
    "fmt"
    "os"
    "runtime"
    "runtime/pprof"
    "runtime/trace"
    "time"
)

// CollectCPUProfile collects a CPU profile for the given duration.
func CollectCPUProfile(ctx context.Context, duration time.Duration) ([]byte, error) {
    var buf bytes.Buffer
    if err := pprof.StartCPUProfile(&buf); err != nil {
        return nil, fmt.Errorf("start CPU profile: %w", err)
    }

    select {
    case <-time.After(duration):
    case <-ctx.Done():
    }

    pprof.StopCPUProfile()
    return buf.Bytes(), nil
}

// CollectHeapProfile collects a snapshot of heap allocations.
func CollectHeapProfile() ([]byte, error) {
    // Force a GC before heap profile for accurate live object counts
    runtime.GC()

    var buf bytes.Buffer
    if err := pprof.Lookup("heap").WriteTo(&buf, 0); err != nil {
        return nil, fmt.Errorf("write heap profile: %w", err)
    }
    return buf.Bytes(), nil
}

// CollectGoroutineProfile dumps all goroutine stack traces.
func CollectGoroutineProfile() ([]byte, error) {
    var buf bytes.Buffer
    if err := pprof.Lookup("goroutine").WriteTo(&buf, 1); err != nil {
        return nil, fmt.Errorf("write goroutine profile: %w", err)
    }
    return buf.Bytes(), nil
}

// CollectTrace collects an execution trace for the given duration.
func CollectTrace(ctx context.Context, duration time.Duration) ([]byte, error) {
    var buf bytes.Buffer
    if err := trace.Start(&buf); err != nil {
        return nil, fmt.Errorf("start trace: %w", err)
    }

    select {
    case <-time.After(duration):
    case <-ctx.Done():
    }

    trace.Stop()
    return buf.Bytes(), nil
}

// SaveProfile saves a profile to a timestamped file.
func SaveProfile(name string, data []byte) (string, error) {
    filename := fmt.Sprintf("/tmp/%s-%d.pb.gz", name, time.Now().Unix())
    if err := os.WriteFile(filename, data, 0600); err != nil {
        return "", fmt.Errorf("write profile file: %w", err)
    }
    return filename, nil
}
```

## Collecting and Analyzing CPU Profiles

### Collecting via HTTP

```bash
# Collect a 30-second CPU profile
kubectl port-forward pod/myapp-6df4c8 6060:6060 &

curl -o cpu.pb.gz "http://localhost:6060/debug/pprof/profile?seconds=30"

# Analyze interactively
go tool pprof cpu.pb.gz
```

### Key pprof Commands

```
# Inside the pprof interactive shell:

# Show top functions by flat (self) CPU time
(pprof) top20

# Show top functions by cumulative time (includes callees)
(pprof) top20 -cum

# Show call graph for a specific function
(pprof) focus encoding/json

# List source-level detail for a function
(pprof) list parseJSON

# Generate a flame graph (requires graphviz)
(pprof) web

# Generate an SVG
(pprof) svg -output cpu.svg

# Show only functions above a threshold
(pprof) top -flat -cum 10ms
```

### Reading Flame Graphs

A flame graph represents CPU time hierarchically. The x-axis is time (wider = more time), the y-axis is call depth. Look for:

- Wide boxes near the top of the flame: functions consuming the most CPU
- Wide boxes in the middle that spawn narrow boxes above: functions with distributed callees (spread-out cost)
- Unexpected library functions wide in the graph: serialization, reflection, crypto

### Example: Finding a JSON Encoding Bottleneck

```go
// Profiling revealed: 40% of CPU in encoding/json.Marshal
// Root cause: marshaling a 500-field struct on every request

// Before: marshal the full struct
func handleRequest(w http.ResponseWriter, r *http.Request) {
    data := buildFullResponse() // 500 fields
    json.NewEncoder(w).Encode(data)
}

// After: pre-compute the JSON, cache it
var responseCache atomic.Value

func updateCache() {
    data := buildFullResponse()
    b, _ := json.Marshal(data)
    responseCache.Store(b)
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Write(responseCache.Load().([]byte))
}
```

## Memory Profiling

### Collecting and Analyzing Heap Profiles

```bash
# Collect heap profile
curl -o heap.pb.gz "http://localhost:6060/debug/pprof/heap"

# Analyze heap allocations
go tool pprof heap.pb.gz

# Inside pprof:
# Show allocation sites by inuse_space (live bytes)
(pprof) -inuse_space top20

# Show allocation sites by alloc_space (total allocated, including GC'd)
(pprof) -alloc_space top20

# Show allocation counts
(pprof) -alloc_objects top20
```

### Comparing Heap Profiles Over Time

```bash
# Take baseline profile
curl -o heap_before.pb.gz "http://localhost:6060/debug/pprof/heap"

# ... application runs for 10 minutes ...

# Take second profile
curl -o heap_after.pb.gz "http://localhost:6060/debug/pprof/heap"

# Compare (shows differential)
go tool pprof -base heap_before.pb.gz heap_after.pb.gz
```

This diff shows what grew. Functions appearing in the diff are leaking or allocating objects that are not being GC'd.

### Controlling Allocation Sampling Rate

The heap profiler samples allocations. The default rate (512KB) means small allocations may not appear. For detailed allocation analysis:

```go
func init() {
    // Sample every 64KB allocation (more overhead but finer granularity)
    runtime.MemProfileRate = 64 * 1024
}
```

### Common Memory Issues

**Buffer reuse pattern to reduce allocations:**

```go
// Before: allocates on every call
func processItem(data []byte) ([]byte, error) {
    var buf bytes.Buffer
    // ... write to buf
    return buf.Bytes(), nil
}

// After: use sync.Pool for buffer reuse
var bufPool = sync.Pool{
    New: func() interface{} {
        return new(bytes.Buffer)
    },
}

func processItem(data []byte) ([]byte, error) {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset()
    defer bufPool.Put(buf)
    // ... write to buf
    result := make([]byte, buf.Len())
    copy(result, buf.Bytes())
    return result, nil
}
```

## Block and Mutex Profiling

### Enabling Block and Mutex Profilers

These profilers are off by default because they add overhead:

```go
import "runtime"

func init() {
    // Report every blocking event (rate=1 is maximum, use in development only)
    // For production, use a higher rate like 1000 (nanoseconds)
    runtime.SetBlockProfileRate(1000)

    // Report 1 in 5 mutex contention events
    runtime.SetMutexProfileFraction(5)
}
```

### Analyzing Block Profiles

```bash
curl -o block.pb.gz "http://localhost:6060/debug/pprof/block"
go tool pprof block.pb.gz

# Shows goroutines blocking on channel ops, sync.Mutex, sync.WaitGroup, etc.
(pprof) top20 -cum
```

Look for:
- `sync.(*Mutex).Lock` - lock contention
- `runtime.selectgo` - goroutines blocked on select
- `sync.(*WaitGroup).Wait` - goroutines waiting for completion
- `time.Sleep` - intentional sleeps (usually fine)

### Example: Reducing Lock Contention

```go
// Before: single global mutex protecting a map
type Cache struct {
    mu    sync.Mutex
    items map[string]Item
}

func (c *Cache) Get(key string) (Item, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()
    item, ok := c.items[key]
    return item, ok
}

// After: sharded cache with 256 shards reduces contention ~256x
const numShards = 256

type ShardedCache struct {
    shards [numShards]struct {
        sync.RWMutex
        items map[string]Item
    }
}

func (c *ShardedCache) shard(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % numShards
}

func (c *ShardedCache) Get(key string) (Item, bool) {
    s := c.shard(key)
    c.shards[s].RLock()
    defer c.shards[s].RUnlock()
    item, ok := c.shards[s].items[key]
    return item, ok
}
```

## The Execution Tracer

The execution tracer is distinct from pprof. Instead of sampling, it records all runtime events: goroutine creation, blocking, unblocking, GC phases, system calls, scheduler events. The output is a trace file you analyze with `go tool trace`.

### Collecting an Execution Trace

```bash
# Collect a 5-second trace
curl -o trace.out "http://localhost:6060/debug/pprof/trace?seconds=5"

# Open the trace viewer (opens a browser)
go tool trace trace.out
```

### What to Look For in the Tracer

The trace viewer shows several views:

**Goroutine Analysis View:**
- Look for goroutines spending most of their time in "Waiting for GC" - indicates GC pressure
- Large numbers of goroutines in "Syscall" may indicate blocking I/O
- Goroutines that never progress may be deadlocked or starved

**Scheduler Latency View:**
- Shows how long goroutines wait to be scheduled after becoming runnable
- High scheduler latency (>1ms) suggests too few OS threads (GOMAXPROCS too low) or runqueue saturation

**GC View:**
- Shows GC mark and sweep phases as colored bands
- GC pauses that are very long relative to total time indicate heap allocation pressure
- STW (stop-the-world) events show as red vertical lines

### Programmatic Trace Analysis

```go
package analysis

import (
    "os"
    "golang.org/x/tools/internal/trace" // internal package; use cmd/trace for production
)

// For production trace analysis, parse the trace programmatically using
// the golang.org/x/exp/trace package (experimental but stable enough for tooling)

// Example: detect goroutine leaks from a trace
// This requires the trace to be parsed; see cmd/trace source for patterns
```

### Reducing GC Pressure from Traces

If the trace shows frequent GC cycles:

```go
// Set GOGC to reduce GC frequency at the cost of higher peak memory
// GOGC=200 means GC triggers when heap doubles (default is 100)
// For batch workloads with large heap and tolerant latency:
os.Setenv("GOGC", "200")
debug.SetGCPercent(200)

// For latency-sensitive services, use GOGC=off + manual GC on low-traffic periods
// or tune with GOMEMLIMIT (Go 1.19+)
import "runtime/debug"

// Set a hard limit on Go heap size (Go 1.19+)
// GC will run more aggressively when approaching this limit
debug.SetMemoryLimit(512 * 1024 * 1024) // 512MB
```

## Continuous Profiling in Production

One-shot profiling only helps when you already know there is a problem. Continuous profiling keeps a rolling window of profiles, letting you compare CPU and memory behavior before and after a deploy or during an incident.

### Pyroscope for Continuous Profiling

[Pyroscope](https://pyroscope.io) is an open-source continuous profiling platform. Deploy it alongside your application and use the Pyroscope Go SDK to push profiles continuously.

**Deploy Pyroscope in Kubernetes:**

```yaml
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
          image: grafana/pyroscope:1.5.0
          args:
            - "server"
          env:
            - name: PYROSCOPE_STORAGE_BACKEND
              value: "s3"
            - name: PYROSCOPE_STORAGE_S3_BUCKET
              value: "my-pyroscope-bucket"
            - name: PYROSCOPE_STORAGE_S3_REGION
              value: "us-east-1"
          ports:
            - name: http
              containerPort: 4040
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 4Gi
          volumeMounts:
            - name: data
              mountPath: /var/lib/pyroscope
      volumes:
        - name: data
          emptyDir: {}
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
```

**Integrate Pyroscope SDK in Go:**

```go
package main

import (
    "context"
    "log"
    "os"

    "github.com/grafana/pyroscope-go"
)

func initPyroscope() (*pyroscope.Profiler, error) {
    appName := os.Getenv("APP_NAME")
    if appName == "" {
        appName = "myservice"
    }

    namespace := os.Getenv("POD_NAMESPACE")
    podName := os.Getenv("POD_NAME")
    version := os.Getenv("APP_VERSION")

    profiler, err := pyroscope.Start(pyroscope.Config{
        ApplicationName: appName,

        // Push profiles to Pyroscope every 15 seconds
        ServerAddress: "http://pyroscope.monitoring.svc.cluster.local:4040",

        // Tags become filterable dimensions in the UI
        Tags: map[string]string{
            "namespace": namespace,
            "pod":       podName,
            "version":   version,
        },

        // Enable all profile types
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

        // Upload every 15 seconds
        UploadRate: 15,
    })
    if err != nil {
        return nil, err
    }
    return profiler, nil
}

func main() {
    profiler, err := initPyroscope()
    if err != nil {
        log.Printf("warning: pyroscope init failed: %v", err)
        // Non-fatal: application continues without continuous profiling
    } else {
        defer profiler.Stop()
    }

    // ... rest of application
}
```

### Parca: Cloud-Native Continuous Profiling

[Parca](https://parca.dev) is a CNCF-sandbox project for continuous profiling:

```yaml
# parca-config.yaml
object_storage:
  bucket:
    type: "S3"
    config:
      bucket: "parca-profiles"
      region: "us-east-1"
      endpoint: ""

# Scrape targets (pull-based, like Prometheus)
scrape_configs:
  - job_name: "payment-service"
    scrape_interval: "15s"
    static_configs:
      - targets: ["payment-service.payments.svc.cluster.local:6060"]
    profiling_config:
      pprof_config:
        memory:
          enabled: true
          path: "/debug/pprof/heap"
        block:
          enabled: true
          path: "/debug/pprof/block"
        goroutine:
          enabled: true
          path: "/debug/pprof/goroutine"
        mutex:
          enabled: true
          path: "/debug/pprof/mutex"
        process_cpu:
          enabled: true
          path: "/debug/pprof/profile"
          delta: true
```

### eBPF-Based Profiling with Parca Agent

For profiling without application-level changes (cross-language support):

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: parca-agent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: parca-agent
  template:
    metadata:
      labels:
        app: parca-agent
    spec:
      hostPID: true
      hostNetwork: true
      containers:
        - name: parca-agent
          image: ghcr.io/parca-dev/parca-agent:v0.31.0
          args:
            - "--remote-store-address=parca.monitoring.svc.cluster.local:7070"
            - "--remote-store-insecure"
            - "--kubernetes"
          securityContext:
            privileged: true
          volumeMounts:
            - name: sys
              mountPath: /sys
              readOnly: true
            - name: debugfs
              mountPath: /sys/kernel/debug
      volumes:
        - name: sys
          hostPath:
            path: /sys
        - name: debugfs
          hostPath:
            path: /sys/kernel/debug
```

## Benchmarking and Profiling Benchmarks

For micro-level optimization, combine Go's benchmark framework with pprof:

```go
// file: encoding_test.go
package encoding

import (
    "testing"
)

func BenchmarkJSONMarshal(b *testing.B) {
    data := generateTestData()
    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        _, err := json.Marshal(data)
        if err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkJSONMarshalParallel(b *testing.B) {
    data := generateTestData()
    b.ResetTimer()
    b.ReportAllocs()

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _, err := json.Marshal(data)
            if err != nil {
                b.Fatal(err)
            }
        }
    })
}
```

```bash
# Run benchmark and generate CPU profile
go test -bench=BenchmarkJSONMarshal -cpuprofile=bench_cpu.pb.gz -memprofile=bench_mem.pb.gz -benchtime=5s ./...

# Analyze
go tool pprof bench_cpu.pb.gz
go tool pprof bench_mem.pb.gz

# Compare two implementations
go test -bench=. -benchmem ./... | tee current.txt
# ... make changes ...
go test -bench=. -benchmem ./... | tee new.txt
benchstat current.txt new.txt
```

## Production Best Practices

### Safe pprof Exposure Checklist

```yaml
# Kubernetes NetworkPolicy to restrict pprof port
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-pprof-internal-only
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-service
  ingress:
    - ports:
        - port: 6060
      from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - podSelector:
            matchLabels:
              app: ops-toolbox
```

### Automating Profile Collection During Incidents

```bash
#!/bin/bash
# collect-profiles.sh — run during an incident to capture all profiling data

NAMESPACE="${1:-default}"
DEPLOYMENT="${2:?deployment name required}"
DURATION="${3:-30}"

PODS=$(kubectl get pods -n "$NAMESPACE" -l "app=$DEPLOYMENT" -o jsonpath='{.items[*].metadata.name}')

for POD in $PODS; do
    echo "Collecting profiles from $POD..."
    kubectl port-forward "pod/$POD" -n "$NAMESPACE" 6060:6060 &
    PF_PID=$!
    sleep 2

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    PREFIX="${POD}_${TIMESTAMP}"

    # CPU profile
    curl -s -o "${PREFIX}_cpu.pb.gz" \
        "http://localhost:6060/debug/pprof/profile?seconds=${DURATION}"

    # Heap
    curl -s -o "${PREFIX}_heap.pb.gz" \
        "http://localhost:6060/debug/pprof/heap"

    # Goroutines
    curl -s -o "${PREFIX}_goroutines.pb.gz" \
        "http://localhost:6060/debug/pprof/goroutine"

    # Block
    curl -s -o "${PREFIX}_block.pb.gz" \
        "http://localhost:6060/debug/pprof/block"

    # Trace
    curl -s -o "${PREFIX}_trace.out" \
        "http://localhost:6060/debug/pprof/trace?seconds=5"

    kill $PF_PID
    wait $PF_PID 2>/dev/null
    echo "Profiles collected for $POD"
done

echo "All profiles collected. Analyze with:"
echo "  go tool pprof <filename>.pb.gz"
echo "  go tool trace <filename>_trace.out"
```

### Tagging Profiles with Request Context

For associating performance problems with specific requests:

```go
// Use pprof labels to tag goroutines with request metadata
func handleRequest(w http.ResponseWriter, r *http.Request) {
    labels := pprof.Labels(
        "user_id", r.Header.Get("X-User-ID"),
        "endpoint", r.URL.Path,
        "version", "v2",
    )

    pprof.Do(r.Context(), labels, func(ctx context.Context) {
        // All profiling data collected in this goroutine (and children)
        // will be tagged with the labels above
        processRequest(ctx, w, r)
    })
}
```

## Summary

Effective Go performance engineering requires a layered approach:

1. **Development**: Run benchmarks with `-cpuprofile` and `-memprofile` for hot-path optimization
2. **Staging**: Collect pprof profiles under realistic load; use the tracer to understand GC and scheduling behavior
3. **Production**: Deploy continuous profiling (Pyroscope or Parca) so you have always-on baseline data and can compare profiles across deployments
4. **Incidents**: Use the profile collection script to gather CPU, heap, goroutine, block, and trace data simultaneously for complete picture

The most valuable insight from production profiling is rarely what you expect. Allocations from log formatting, JSON marshaling, and string concatenation frequently dominate CPU time in real applications. Continuous profiling makes these visible before they become outages.
